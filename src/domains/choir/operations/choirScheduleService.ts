import type { MemoryRepository, ObligationRepository, ChoirWorkflowService } from "../../../agent/ports.js";
import type { EchoAgentService } from "../../../agent/services/echoAgentService.js";
import type { AgentObligationScheduler } from "../../../agent/services/obligationScheduler.js";
import type { AgentObligation, AgentTurnResult } from "../../../agent/types.js";
import type { SchedulerPort } from "../../../framework/ports/index.js";
import { clockService } from "../../../shared/clockService.js";
import { isLastFridayWeek } from "../../../workflows/setlistCalendar.js";
import { DateTime } from "luxon";

const TIMEZONE = "Europe/London";

export interface ManualSundayReminderResult {
  delivered: boolean;
  reason: NonNullable<AgentTurnResult["delivery"]>["reason"];
}

/**
 * Owns choir calendar policy. Timers only activate durable agent obligations;
 * they never generate or send choir messages themselves.
 */
export class ChoirScheduleService {
  public constructor(
    private readonly scheduler: SchedulerPort,
    private readonly obligations: ObligationRepository,
    private readonly obligationScheduler: AgentObligationScheduler,
    private readonly agent: EchoAgentService,
    private readonly workflows: ChoirWorkflowService,
    private readonly memory: MemoryRepository,
    private readonly chatId: string,
  ) {}

  public async start(): Promise<void> {
    this.registerRecurringActivations();
    this.workflows.setSetlistSubmittedHandler((submission) => this.onSetlistSubmitted(submission));
    await this.restorePendingBroadcasts();
    await this.obligationScheduler.recover();
    await this.reconcileSetlistPlanningOnStartup();
  }

  public stop(): void {
    for (const id of recurringJobIds()) this.scheduler.cancel(id);
  }

  /**
   * Runs the normal Sunday rota pipeline immediately for a creator command.
   * Only activation is manual: evidence retrieval, validation, composition and
   * delivery remain owned by the same agent workflow as the scheduled job.
   */
  public async triggerSundayReminder(commandEventKey: string): Promise<ManualSundayReminderResult> {
    const weekStart = clockService.now(TIMEZONE).plus({ days: 1 }).startOf("week").toISODate()!;
    const result = await this.activate({
      naturalKey: `manual-weekly-rota:${commandEventKey}`,
      eventKey: `manual-sunday-reminder:${commandEventKey}`,
      type: "weekly_rota_reminder_due",
      weekStart,
      payload: { weekStart, allowUntargetedMessage: true, manuallyActivated: true },
    });
    return {
      delivered: result.delivery?.delivered ?? false,
      reason: result.delivery?.reason ?? "no_reply",
    };
  }

  private registerRecurringActivations(): void {
    this.scheduleWeekly("choir-sunday-rota-activation", 0, "17:00", "weekly_rota_reminder_due", true);
    this.scheduleWeekly("choir-wednesday-rota-activation", 3, "09:00", "midweek_rota_reminder_due", true);
    this.scheduleWeekly("choir-setlist-planning-activation", 0, "19:00", "setlist_weekly_planning_due", false);
    this.scheduler.scheduleWeekly({
      id: "choir-operational-memory-cleanup",
      dayOfWeek: 0,
      time: "18:00",
      timezone: TIMEZONE,
      category: "cleanup",
      action: async () => {
        await this.workflows.cleanupExpiredSetlists();
        await this.memory.pruneExpiredBlocks();
      },
    });
  }

  /**
   * Backfills a missed Sunday planning cycle after a deployment or outage.
   * Existing persisted follow-ups remain authoritative, and the normal planner
   * still decides applicability from current weekly evidence.
   */
  private async reconcileSetlistPlanningOnStartup(): Promise<void> {
    const now = clockService.now(TIMEZONE);
    const isSunday = now.weekday === 7;
    const planningTime = now.set({ hour: 19, minute: 0, second: 0, millisecond: 0 });

    // Sunday before 7 PM still has its normal activation ahead. Saturday has
    // no future Monday-Friday nudge slot to recover for the ending service week.
    if ((isSunday && now < planningTime) || now.weekday === 6) return;

    const targetWeek = (isSunday ? now.plus({ days: 1 }) : now).startOf("week");
    const weekStart = targetWeek.toISODate()!;
    if (isLastFridayWeek(targetWeek) || await this.workflows.isSetlistComplete(weekStart)) return;

    const active = await this.obligations.listActive(this.chatId);
    const alreadyCovered = active.some((obligation) =>
      obligation.weekStart === weekStart
      && (obligation.type === "setlist_weekly_planning_due" || obligation.type === "setlist_followup_due")
    );
    if (alreadyCovered) return;

    const dueAt = now.toISO()!;
    const obligation = await this.obligations.upsert({
      naturalKey: `setlist_weekly_planning_due:${weekStart}`,
      type: "setlist_weekly_planning_due",
      chatId: this.chatId,
      weekStart,
      assignedMemberIds: [],
      status: "pending",
      dueAt,
      payload: { weekStart, startupRecovery: true, allowUntargetedMessage: false },
      lastEvaluatedAt: dueAt,
    });
    this.obligationScheduler.schedule(obligation);
  }

  private scheduleWeekly(
    id: string,
    dayOfWeek: number,
    time: string,
    type: string,
    allowUntargetedMessage: boolean,
  ): void {
    this.scheduler.scheduleWeekly({
      id,
      dayOfWeek,
      time,
      timezone: TIMEZONE,
      category: type.includes("setlist") ? "setlist_nudge" : "rota_reminder",
      action: async () => {
        const now = clockService.now(TIMEZONE);
        const targetsUpcomingWeek = type === "weekly_rota_reminder_due" || type === "setlist_weekly_planning_due";
        const weekStart = (targetsUpcomingWeek ? now.plus({ days: 1 }) : now).startOf("week").toISODate()!;
        await this.activate({
          naturalKey: `${type}:${weekStart}`,
          type,
          weekStart,
          payload: { weekStart, allowUntargetedMessage },
        });
      },
    });
  }

  private async activate(input: {
    naturalKey: string;
    eventKey?: string;
    type: string;
    weekStart: string;
    payload: Record<string, unknown>;
  }): Promise<AgentTurnResult> {
    const dueAt = clockService.now(TIMEZONE).toISO()!;
    const obligation = await this.obligations.upsert({
      naturalKey: input.naturalKey,
      type: input.type,
      chatId: this.chatId,
      weekStart: input.weekStart,
      assignedMemberIds: [],
      status: "pending",
      dueAt,
      payload: input.payload,
      lastEvaluatedAt: dueAt,
    });
    return this.agent.handleScheduledWake({
      eventKey: input.eventKey ?? obligationEventKey(obligation),
      type: obligation.type,
      chatId: obligation.chatId,
      payload: { ...obligation.payload, obligationId: obligation.id, weekStart: obligation.weekStart },
    });
  }

  private async onSetlistSubmitted(submission: {
    id: string;
    chatId: string;
    weekStart: string;
    content: string;
    broadcastScheduledFor?: string;
  }): Promise<void> {
    if (await this.workflows.isSetlistComplete(submission.weekStart)) {
      await this.cancelSetlistFollowups(submission.weekStart);
    }
    if (!submission.broadcastScheduledFor) return;
    await this.cancelSetlistBroadcasts(submission.weekStart);
    const obligation = await this.obligations.upsert({
      naturalKey: `setlist-broadcast:${submission.weekStart}`,
      type: "setlist_broadcast_due",
      chatId: submission.chatId,
      weekStart: submission.weekStart,
      assignedMemberIds: [],
      status: "pending",
      dueAt: submission.broadcastScheduledFor,
      payload: {
        submissionId: submission.id,
        weekStart: submission.weekStart,
        allowUntargetedMessage: true,
      },
      lastEvaluatedAt: clockService.now(TIMEZONE).toISO()!,
    });
    this.obligationScheduler.schedule(obligation);
  }

  private async restorePendingBroadcasts(): Promise<void> {
    const submissions = await this.workflows.getPendingSetlistBroadcasts();
    const now = clockService.now(TIMEZONE);
    for (const submission of submissions) {
      const due = submission.broadcastScheduledFor
        ? DateTime.fromISO(submission.broadcastScheduledFor, { setZone: true }).setZone(TIMEZONE)
        : null;
      if (!due?.isValid || due <= now) {
        await this.workflows.clearPendingSetlistBroadcast(submission.id);
        continue;
      }
      await this.onSetlistSubmitted(submission);
    }
  }

  private async cancelSetlistFollowups(weekStart: string): Promise<void> {
    const active = await this.obligations.listActive(this.chatId);
    for (const obligation of active) {
      if (obligation.type !== "setlist_followup_due" || obligation.weekStart !== weekStart) continue;
      this.scheduler.cancel(`agent-obligation-${obligation.id}`);
      await this.obligations.updateStatus(obligation.id, "satisfied", "Setlist submitted before this follow-up.");
    }
  }

  private async cancelSetlistBroadcasts(weekStart: string): Promise<void> {
    const active = await this.obligations.listActive(this.chatId);
    for (const obligation of active) {
      if (obligation.type !== "setlist_broadcast_due" || obligation.weekStart !== weekStart) continue;
      this.scheduler.cancel(`agent-obligation-${obligation.id}`);
      await this.obligations.updateStatus(obligation.id, "satisfied", "A newer complete setlist replaced this broadcast.");
    }
  }
}

function obligationEventKey(obligation: AgentObligation): string {
  return `obligation:${obligation.id}:${obligation.dueAt ?? "now"}`;
}

function recurringJobIds(): string[] {
  return [
    "choir-sunday-rota-activation",
    "choir-wednesday-rota-activation",
    "choir-setlist-planning-activation",
    "choir-operational-memory-cleanup",
  ];
}
