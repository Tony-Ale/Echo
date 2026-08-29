import { DateTime } from "luxon";
import type { ChoirWorkflowService, IdentityRepository, ObligationRepository } from "../../../agent/ports.js";
import type { AgentObligation } from "../../../agent/types.js";
import type { OutgoingMessage } from "../../../framework/contracts/messages.js";
import { clockService } from "../../../shared/clockService.js";
import { isLastFridayWeek, randomReminderTime } from "../../../workflows/setlistCalendar.js";
import type { RotaReminderService } from "./rotaReminderService.js";

const TIMEZONE = "Europe/London";

export interface SetlistOperationResult {
  status: "ready" | "not_applicable" | "insufficient_evidence";
  summary: string;
  reply?: OutgoingMessage;
  planned?: number;
}

/** Owns the stable, source-validated operations behind scheduled setlist events. */
export class SetlistOperationsService {
  public constructor(
    private readonly weeklyContext: RotaReminderService,
    private readonly workflows: ChoirWorkflowService,
    private readonly identities: IdentityRepository,
    private readonly obligations: ObligationRepository,
    private readonly onObligationSaved?: (obligation: AgentObligation) => void,
  ) {}

  public async planWeeklyNudges(input: {
    weekStart: string;
    chatId: string;
    signal: AbortSignal;
  }): Promise<SetlistOperationResult> {
    const weekly = await this.weeklyContext.ensureWeeklyInterpretation(input);
    if (weekly.status !== "ready" || !weekly.interpretation) {
      return { status: weekly.status, summary: weekly.summary };
    }
    if (weekly.interpretation.interpretation.sundayActivityCancelled === true) {
      return { status: "not_applicable", summary: "The Sunday choir activity is cancelled or replaced." };
    }
    if (weekly.interpretation.interpretation.setlistRequired !== true) {
      return { status: "not_applicable", summary: "Current weekly evidence does not require a setlist." };
    }

    const monday = DateTime.fromISO(input.weekStart, { zone: TIMEZONE }).startOf("day");
    if (!monday.isValid || monday.weekday !== 1) {
      return { status: "insufficient_evidence", summary: "The setlist plan has an invalid service-week boundary." };
    }
    if (isLastFridayWeek(monday)) {
      return { status: "not_applicable", summary: "No setlist nudges are scheduled during a week containing the last Friday.", planned: 0 };
    }
    if (await this.workflows.isSetlistComplete(input.weekStart)) {
      return { status: "not_applicable", summary: "The setlist is already complete, so no nudges were scheduled.", planned: 0 };
    }

    let planned = 0;
    for (let offset = 0; offset <= 4; offset += 1) {
      const [hour, minute] = randomReminderTime().split(":").map(Number);
      const due = monday.plus({ days: offset }).set({ hour, minute, second: 0, millisecond: 0 });
      if (due <= clockService.now(TIMEZONE)) continue;
      const obligation = await this.obligations.upsert({
        naturalKey: `setlist-followup:${input.weekStart}:${offset}`,
        type: "setlist_followup_due",
        chatId: input.chatId,
        weekStart: input.weekStart,
        assignedMemberIds: [],
        status: "pending",
        dueAt: due.toISO()!,
        payload: { weekStart: input.weekStart },
        sourceHash: weekly.interpretation.sourceHash,
        lastEvaluatedAt: clockService.now(TIMEZONE).toISO()!,
      });
      this.onObligationSaved?.(obligation);
      planned += 1;
    }
    return { status: "ready", summary: `${planned} setlist follow-up obligations scheduled.`, planned };
  }

  public async prepareNudge(input: {
    weekStart: string;
    transport: string;
    signal: AbortSignal;
  }): Promise<SetlistOperationResult> {
    const weekly = await this.weeklyContext.ensureWeeklyInterpretation(input);
    if (weekly.status !== "ready" || !weekly.interpretation) {
      return { status: weekly.status, summary: weekly.summary };
    }
    if (weekly.interpretation.interpretation.sundayActivityCancelled === true) {
      return { status: "not_applicable", summary: "The Sunday choir activity is cancelled or replaced." };
    }
    if (weekly.interpretation.interpretation.setlistRequired !== true) {
      return {
        status: "not_applicable",
        summary: "Current weekly evidence does not require a worship and praise setlist.",
      };
    }

    const state = await this.workflows.getSetlistFollowup(input.weekStart);
    if (state.complete) {
      return { status: "not_applicable", summary: "The setlist is already complete." };
    }
    if (!state.reminderText) {
      return {
        status: "insufficient_evidence",
        summary: "A reliable leader-specific setlist reminder could not be prepared.",
      };
    }

    const leaderNames = unique(weekly.interpretation.interpretation.worshipPraiseLeaderNames);
    if (leaderNames.length === 0) {
      return {
        status: "insufficient_evidence",
        summary: "The assigned worship and praise leader could not be resolved from current weekly evidence.",
      };
    }

    const resolutions = await this.identities.resolveByNames(leaderNames);
    if (resolutions.some(({ matches }) => matches.length !== 1)) {
      return {
        status: "insufficient_evidence",
        summary: "The assigned worship and praise leader could not be matched uniquely.",
      };
    }

    const members = resolutions.map(({ matches }) => matches[0]);
    const mentions = await this.identities.getMentionTargets(members.map(({ id }) => id), input.transport);
    if (mentions.length !== members.length) {
      return {
        status: "insufficient_evidence",
        summary: `The assigned leader has no verified ${input.transport} mention identifier.`,
      };
    }

    let text = state.reminderText;
    for (const [index, resolution] of resolutions.entries()) {
      const displayName = members[index].displayName || members[index].canonicalName || resolution.name;
      text = text.replace(new RegExp(escapeRegExp(resolution.name), "gi"), `@${displayName}`);
    }
    return {
      status: "ready",
      summary: "The source-validated, leader-targeted setlist nudge is ready for delivery.",
      reply: {
        text,
        mentions,
        mentionLabels: members.map((member, index) =>
          member.displayName || member.canonicalName || resolutions[index].name),
      },
    };
  }

  public async prepareBroadcast(input: {
    weekStart: string;
    submissionId: string;
    signal: AbortSignal;
  }): Promise<SetlistOperationResult> {
    const weekly = await this.weeklyContext.ensureWeeklyInterpretation(input);
    if (weekly.status !== "ready") {
      return { status: weekly.status, summary: weekly.summary };
    }
    if (weekly.interpretation?.interpretation.sundayActivityCancelled === true) {
      return { status: "not_applicable", summary: "The Sunday choir activity is cancelled or replaced." };
    }
    if (weekly.interpretation?.interpretation.setlistRequired !== true) {
      return { status: "not_applicable", summary: "Current weekly evidence does not require a setlist." };
    }
    const submission = await this.workflows.getSetlistBroadcast(input.submissionId);
    if (!submission || submission.weekStart !== input.weekStart) {
      return { status: "insufficient_evidence", summary: "No pending setlist broadcast was found." };
    }
    return {
      status: "ready",
      summary: "The source-validated setlist broadcast is ready for delivery.",
      reply: { text: `Setlist reminder\n\n${submission.content}` },
    };
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
