import { clockService } from "../../shared/clockService.js";
import type { SchedulerPort } from "../../framework/ports/index.js";
import type { ObligationRepository } from "../ports.js";
import type { AgentObligation } from "../types.js";
import type { EchoAgentService } from "./echoAgentService.js";
import { DateTime } from "luxon";

const TIMEZONE = "Europe/London";

/** Rebuilds pending one-time obligation wake-ups from Supabase after restart. */
export class AgentObligationScheduler {
  public constructor(
    private readonly obligations: ObligationRepository,
    private readonly agent: EchoAgentService,
    private readonly scheduler: SchedulerPort,
  ) {}

  public async recover(): Promise<void> {
    const active = await this.obligations.listActive();
    for (const obligation of active) {
      if (isExpiredSetlistNudge(obligation) || isExpiredSetlistBroadcast(obligation)) {
        await this.obligations.updateStatus(
          obligation.id,
          "not_applicable",
          obligation.type === "setlist_followup_due"
            ? "The setlist nudge date passed before startup recovery."
            : "The setlist broadcast time passed before startup recovery.",
        );
        continue;
      }
      this.schedule(obligation);
    }
  }

  public schedule(obligation: AgentObligation): void {
    if (!obligation.dueAt || !["pending", "waiting_for_data", "waiting_for_member"].includes(obligation.status)) return;
    const dueMillis = clockService.Date(obligation.dueAt).getTime();
    if (!Number.isFinite(dueMillis)) return;
    const jobId = `agent-obligation-${obligation.id}`;
    this.scheduler.cancel(jobId);
    this.scheduler.scheduleOnce({
      id: jobId,
      runAt: obligation.dueAt,
      timezone: "Europe/London",
      category: categoryForObligation(obligation.type),
      action: async () => {
        await this.agent.handleScheduledWake({
          eventKey: `obligation:${obligation.id}:${obligation.dueAt}`,
          type: obligation.type,
          chatId: obligation.chatId,
          payload: {
            ...obligation.payload,
            obligationId: obligation.id,
            weekStart: obligation.weekStart,
            scheduledFor: obligation.dueAt,
            overdue: dueMillis <= clockService.now(TIMEZONE).toMillis(),
          },
        });
      },
    });
  }
}

function isExpiredSetlistBroadcast(obligation: AgentObligation): boolean {
  if (obligation.type !== "setlist_broadcast_due" || !obligation.dueAt) return false;
  const due = DateTime.fromISO(obligation.dueAt, { setZone: true }).setZone(TIMEZONE);
  return due.isValid && due <= clockService.now(TIMEZONE);
}

function isExpiredSetlistNudge(obligation: AgentObligation): boolean {
  if (obligation.type !== "setlist_followup_due" || !obligation.dueAt) return false;
  const due = DateTime.fromISO(obligation.dueAt, { setZone: true }).setZone(TIMEZONE);
  if (!due.isValid) return false;
  return due.startOf("day") < clockService.now(TIMEZONE).startOf("day");
}

function categoryForObligation(type: string): string {
  if (type === "setlist_followup_due") return "setlist_nudge";
  if (type === "setlist_broadcast_due") return "setlist_broadcast";
  if (type.includes("rota_reminder")) return "rota_reminder";
  return "other";
}
