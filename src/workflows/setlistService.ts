import { DateTime } from "luxon";
import type { IncomingMessage, OutgoingMessage } from "../framework/contracts/messages.js";
import { logData } from "../logger/execLogger.js";
import type { IdentityRepository, WeeklyInterpretationRepository } from "../agent/ports.js";
import { getCurrentWeekStart } from "./dateParser.js";
import { getServiceWeekForSetlistSubmission, getSetlistExpiryForServiceWeek, isLastFridayWeek, randomThursdayOrFridayDateTime } from "./setlistCalendar.js";
import type { SetlistKind, SetlistSubmissionRecord } from "./types.js";
import type { WorkflowRepository } from "./workflowRepository.js";
import { clockService } from "../shared/clockService.js";
export type SubmissionScope = "combined" | "worship" | "praise";

export type SetlistSubmissionResult = OutgoingMessage & {
  submittedSetlist?: SetlistSubmissionRecord;
};

export class SetlistService {
  public constructor(
    private readonly repository: WorkflowRepository,
    private readonly identities: IdentityRepository,
    private readonly weeklyInterpretations: WeeklyInterpretationRepository,
  ) {}

  public detectSubmissionKind(text: string): SetlistKind | null {
    return /#submit_setlist\b/i.test(text) ? "setlist" : null;
  }

  public async submit(message: IncomingMessage, scope: SubmissionScope): Promise<SetlistSubmissionResult> {
    const weekStart = await this.resolveSubmissionWeekStart("setlist", message);
    if (!weekStart) {
      logData({ senderId: message.sender.id }, "Setlist submission rejected because sender is not assigned leader");
      return { text: "I can only accept that submission from this week's assigned worship/praise leader or a creator." };
    }

    const inlineContent = stripSetlistWorkflowTags(message.text);
    const content = inlineContent || message.quotedMessage?.text || "";
    if (!content.trim()) {
      logData({ weekStart }, "Setlist submission rejected because content is missing");
      return { text: "Please include the setlist, or reply to the setlist message with the submission tag." };
    }

    const kind = scope === "combined" ? "setlist" : scope;
    const combined = await this.repository.getSubmittedSetlist("setlist", weekStart);
    if (combined && kind !== "setlist") {
      return {
        text: `A combined setlist already exists ${formatServiceWeekLabel(weekStart)}. Please send the complete corrected setlist with #submit_setlist.`,
      };
    }

    if (kind === "setlist") await this.repository.cancelPartialSetlists(weekStart);
    await this.repository.clearPendingSetlistBroadcasts(weekStart);
    const existing = await this.repository.getSubmittedSetlist(kind, weekStart);
    const saved = existing
      ? await this.replaceSubmittedSetlist(existing, message, content.trim())
      : await this.createSubmittedSetlist(message, kind, weekStart, content.trim());
    const submitted = await this.prepareBroadcastWhenComplete(saved);
    const complete = Boolean(submitted.broadcastScheduledFor);
    return {
      text: formatSubmissionReply(submitted, Boolean(existing), complete),
      submittedSetlist: submitted,
    };
  }

  private async createSubmittedSetlist(
    message: IncomingMessage,
    kind: SetlistKind,
    weekStart: string,
    content: string
  ): Promise<SetlistSubmissionRecord> {
    const expiresAt = getSetlistExpiryForServiceWeek(weekStart);
    const submitted = await this.repository.createSetlistSubmission({
      chatId: message.conversationId,
      submitterId: message.sender.id,
      submitterName: message.sender.displayName,
      kind,
      weekStart,
      content,
      status: "submitted",
      expiresAt,
    });
    logData({ submissionId: submitted.id, kind, weekStart, expiresAt }, "Setlist submission stored without explicit confirmation");
    return submitted;
  }

  private async replaceSubmittedSetlist(
    existing: SetlistSubmissionRecord,
    message: IncomingMessage,
    content: string
  ): Promise<SetlistSubmissionRecord> {
    const expiresAt = existing.expiresAt ?? getSetlistExpiryForServiceWeek(existing.weekStart);
    const updated = await this.repository.updateSetlistSubmission(existing.id, {
      submitterId: message.sender.id,
      submitterName: message.sender.displayName,
      content,
      expiresAt,
      broadcastScheduledFor: undefined,
      broadcastSentAt: null,
    });
    logData({ submissionId: updated.id, kind: updated.kind, weekStart: updated.weekStart }, "Setlist submission replaced without explicit confirmation");
    return updated;
  }

  private async prepareBroadcastWhenComplete(submission: SetlistSubmissionRecord): Promise<SetlistSubmissionRecord> {
    if (!await this.isSetlistComplete(submission.weekStart)) return submission;

    await this.repository.clearPendingSetlistBroadcasts(submission.weekStart);
    const broadcastDate = randomThursdayOrFridayDateTime(submission.weekStart);
    if (broadcastDate <= clockService.now(broadcastDate.zoneName ?? "Europe/London")) {
      logData(
        { submissionId: submission.id, weekStart: submission.weekStart, broadcastAt: broadcastDate.toISO() },
        "Setlist broadcast skipped because its weekly delivery window has passed",
      );
      return { ...submission, broadcastScheduledFor: undefined };
    }
    const broadcastAt = broadcastDate.toISO()!;
    const scheduled = await this.repository.updateSetlistSubmission(submission.id, {
      broadcastScheduledFor: broadcastAt,
      broadcastSentAt: null,
    });
    logData({ submissionId: scheduled.id, weekStart: scheduled.weekStart, broadcastAt }, "Complete weekly setlist broadcast prepared");
    return scheduled;
  }

  public async cleanupExpiredSetlists(): Promise<number> {
    const deleted = await this.repository.deleteExpiredSubmittedSetlists();
    logData({ deleted }, "Expired DB setlists cleaned up");
    return deleted;
  }

  public async buildCombinedMissingSubmissionReminder(weekStart = getCurrentWeekStart()): Promise<string | null> {
    const [worshipSubmitted, praiseSubmitted] = await Promise.all([
      this.repository.hasSubmittedSetlist("worship", weekStart),
      this.repository.hasSubmittedSetlist("praise", weekStart),
    ]);

    const missing: Array<Exclude<SetlistKind, "setlist">> = [];
    if (!worshipSubmitted) missing.push("worship");
    if (!praiseSubmitted) missing.push("praise");
    if (missing.length === 0) {
      logData({ weekStart }, "Combined setlist reminder skipped because all setlists are submitted");
      return null;
    }

    const leaders = await this.getAssignedLeaders("worship", weekStart);
    if (leaders.length === 0) {
      logData({ weekStart, missing }, "Combined setlist reminder skipped because leader could not be resolved");
      return null;
    }

    const leaderText = leaders.join(", ");
    const setlistText = missing.length === 2 ? "worship and praise setlists" : `${missing[0]} setlist`;
    const text = `${leaderText}, please upload the ${setlistText} ${formatServiceWeekLabel(weekStart)} with #submit_setlist.`;
    logData({ weekStart, leaders, missing, text }, "Combined setlist reminder generated");
    return text;
  }

  public async isSetlistComplete(weekStart = getCurrentWeekStart()): Promise<boolean> {
    const [worshipSubmitted, praiseSubmitted] = await Promise.all([
      this.repository.hasSubmittedSetlist("worship", weekStart),
      this.repository.hasSubmittedSetlist("praise", weekStart),
    ]);
    return worshipSubmitted && praiseSubmitted;
  }

  private async isAssignedLeader(kind: SetlistKind, message: IncomingMessage, weekStart: string): Promise<boolean> {
    const actor = await this.identities.resolveSender(message.sender);
    if (actor?.roles.includes("creator")) {
      logData({ kind, senderId: message.sender.id, senderName: message.sender.displayName, weekStart }, "Setlist leader validation bypassed for creator");
      return true;
    }
    if (!actor) return false;

    if (kind === "setlist") {
      const worship = await this.isAssignedLeader("worship", message, weekStart);
      const praise = await this.isAssignedLeader("praise", message, weekStart);
      return worship || praise;
    }

    const leaders = await this.getAssignedLeaders(kind, weekStart);
    const resolved = await Promise.all(leaders.map((leader) => this.identities.resolveByName(leader)));
    const leaderIds = resolved.flatMap((matches) => matches.length === 1 ? [matches[0].id] : []);
    const isLeader = leaderIds.includes(actor.id);
    logData({ kind, actorId: actor.id, weekStart, leaders, leaderIds, isLeader }, "Setlist leader validation completed");
    return isLeader;
  }

  private async resolveSubmissionWeekStart(kind: SetlistKind, message: IncomingMessage): Promise<string | null> {
    const currentWeekStart = getServiceWeekForSetlistSubmission();
    const actor = await this.identities.resolveSender(message.sender);
    if (actor?.roles.includes("creator")) return currentWeekStart;

    if (await this.isAssignedLeader(kind, message, currentWeekStart)) {
      return currentWeekStart;
    }

    const nextWeekStart = DateTime.fromISO(currentWeekStart, { zone: "Europe/London" }).plus({ weeks: 1 }).toISODate();
    if (!nextWeekStart || !isLastFridayWeek(DateTime.fromISO(nextWeekStart, { zone: "Europe/London" }))) {
      return null;
    }

    if (await this.isAssignedLeader(kind, message, nextWeekStart)) {
      logData({ kind, currentWeekStart, nextWeekStart, senderId: message.sender.id }, "Setlist submission accepted early for last-Friday week");
      return nextWeekStart;
    }

    return null;
  }

  private async getAssignedLeaders(kind: Exclude<SetlistKind, "setlist">, weekStart: string): Promise<string[]> {
    const weekly = await this.weeklyInterpretations.getLatest(weekStart);
    if (
      !weekly
      || weekly.interpretation.sundayActivityCancelled === true
      || weekly.interpretation.setlistRequired !== true
    ) {
      logData({ kind, weekStart, hasInterpretation: Boolean(weekly) }, "Assigned setlist leader could not be resolved from current weekly state");
      return [];
    }
    const leaders = [...new Set(
      weekly.interpretation.worshipPraiseLeaderNames.map((name) => name.trim()).filter(Boolean),
    )];
    logData({ kind, weekStart, leaders }, "Assigned setlist leaders resolved from structured weekly state");
    return leaders;
  }
}

function stripSetlistWorkflowTags(text: string): string {
  return text.replace(/#submit_setlist/gi, "").trim();
}

function formatServiceWeekLabel(weekStart: string): string {
  const monday = DateTime.fromISO(weekStart, { zone: "Europe/London" });
  const sunday = monday.plus({ days: 6 });
  if (!monday.isValid || !sunday.isValid) return "for the target service week";
  return `for Sunday ${sunday.toFormat("d LLLL yyyy")}`;
}

function formatSubmissionReply(
  submission: SetlistSubmissionRecord,
  updated: boolean,
  complete: boolean,
): string {
  const action = updated ? "updated" : "saved";
  const label = formatServiceWeekLabel(submission.weekStart);
  if (submission.kind === "setlist") {
    return `Done. The worship/praise setlist has been ${action} ${label}.`;
  }
  if (complete) {
    return `Done. The ${submission.kind} section has been ${action} ${label}. The weekly setlist is now complete.`;
  }
  const missing = submission.kind === "worship" ? "praise" : "worship";
  return `Done. The ${submission.kind} section has been ${action} ${label}. I will keep waiting for the ${missing} section.`;
}
