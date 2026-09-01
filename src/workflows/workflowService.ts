import type { IncomingMessage, OutgoingMessage } from "../framework/contracts/messages.js";
import { logData } from "../logger/execLogger.js";
import { formatReminderDate, normalizeReminderDateEditPhrase, parseReminderDatePhrase } from "./dateParser.js";
import type { TemporalPhraseService } from "./temporalPhraseService.js";
import type { ReminderScheduler } from "./reminderScheduler.js";
import type { SetlistService } from "./setlistService.js";
import type { ReminderRecord, SetlistSubmissionRecord } from "./types.js";
import type { WorkflowRepository } from "./workflowRepository.js";
import { isExplicitReminderActivation, isPhrasePresentInCurrentMessage } from "./workflowDetection.js";
import type { SubmissionScope } from "./setlistService.js";
import type { WorkflowCache, WorkflowMetadata } from "./workflowCache.js";
import { clockService } from "../shared/clockService.js";
import { DateTime } from "luxon";

export class WorkflowService {
  public constructor(
    private readonly repository: WorkflowRepository,
    private readonly temporalPhrases: TemporalPhraseService,
    private readonly scheduler: ReminderScheduler,
    private readonly setlists: SetlistService,
    private readonly cache: WorkflowCache
  ) {}

  private setlistSubmittedHandler?: (submission: SetlistSubmissionRecord) => Promise<void>;

  public setSetlistSubmittedHandler(handler: (submission: SetlistSubmissionRecord) => Promise<void>): void {
    this.setlistSubmittedHandler = handler;
  }

  public async createReminder(input: {
    message: IncomingMessage;
    rawDatePhrase: string | null;
    reminderMessage: string | null;
  }): Promise<OutgoingMessage> {
    const { message } = input;
    if (!isExplicitReminderActivation(message.text)) {
      return formatWorkflowRejection("Please use an explicit reminder command, for example `@Echo remind me tomorrow at 9am about rehearsal`.");
    }
    try {
      if (!input.rawDatePhrase?.trim()) {
        logData({ messageId: message.id }, "Reminder creation rejected because date phrase is missing");
        return { text: formatReminderNotSet("I could not find when to send the reminder.") };
      }

      if (!isPhrasePresentInCurrentMessage(message.text, input.rawDatePhrase)) {
        logData(
          { messageId: message.id, rawDatePhrase: input.rawDatePhrase },
          "Reminder creation rejected because date phrase was not supplied in the current message",
        );
        return { text: formatReminderNotSet("Please include when you want the reminder sent in your reminder command.") };
      }

      const parsedDate = await this.parseReminderDateWithFallback(input.rawDatePhrase);
      if (!parsedDate.ok || !parsedDate.value) {
        logData({ rawDatePhrase: input.rawDatePhrase, parsedDate }, "Reminder date parsing failed");
        return { text: formatReminderNotSet(parsedDate.reason ?? "I could not turn the date into a valid future reminder time.") };
      }

      const reminderMessage = (input.reminderMessage ?? message.quotedMessage?.text ?? "").trim();
      if (!reminderMessage) {
        return { text: formatReminderNotSet("I could not find what you want to be reminded about.") };
      }

      const duplicate = await this.repository.findDuplicateScheduledReminder({
        chatId: message.conversationId,
        creatorId: message.sender.id,
        message: reminderMessage,
        scheduledFor: parsedDate.value.iso,
      });
      if (duplicate) {
        logData({ reminderId: duplicate.id }, "Duplicate reminder workflow rejected");
        return { text: formatReminderNotSet("You already have that reminder pending or scheduled.") };
      }

      const reminder = await this.repository.createReminder({
        chatId: message.conversationId,
        creatorId: message.sender.id,
        creatorName: message.sender.displayName,
        message: reminderMessage,
        rawDatePhrase: input.rawDatePhrase,
        scheduledFor: parsedDate.value.iso,
        timezone: parsedDate.value.timezone,
        status: "pending_confirmation",
      });
      logData({ reminderId: reminder.id, scheduledFor: reminder.scheduledFor }, "Reminder created pending confirmation");

      return {
        text: formatConfirmation(reminder),
        metadata: { workflowConfirmation: reminderConfirmation(reminder) },
      };
    } catch (error) {
      logData({ error, messageId: message.id }, "Reminder creation failed unexpectedly");
      return { text: formatReminderNotSet("Something went wrong while preparing the reminder.") };
    }
  }

  public async continueReminder(input: {
    message: IncomingMessage;
    action: "confirm" | "decline" | "edit" | "request_cancel";
    rawDatePhrase?: string | null;
    reminderMessage?: string | null;
  }): Promise<OutgoingMessage> {
    const { message } = input;
    if (!message.quotedMessage?.id) {
      return formatWorkflowRejection("Please reply directly to the reminder confirmation message.");
    }
    if (!matchesReminderAction(message.text, input.action)) {
      return formatWorkflowRejection("The requested reminder action does not match your message.");
    }
    return await this.handleWorkflowReply(message, input) ?? formatWorkflowRejection("I could not find an active reminder for that reply.");
  }

  public async submitSetlist(input: {
    message: IncomingMessage;
    scope: SubmissionScope;
  }): Promise<OutgoingMessage> {
    if (!this.setlists.detectSubmissionKind(input.message.text)) {
      return formatWorkflowRejection("Include #submit_setlist in the message or in a reply to the setlist.");
    }
    const reply = await this.setlists.submit(input.message, input.scope);
    if (reply.submittedSetlist) await this.setlistSubmittedHandler?.(reply.submittedSetlist);
    return reply;
  }

  public async registerConfirmationMessage(input: {
    workflowType: "reminder";
    workflowId: string;
    ownerId: string;
    state: string;
    confirmationMessageId: string;
  }): Promise<void> {
    await this.repository.setReminderConfirmationMessageId(input.workflowId, input.confirmationMessageId);

    this.cache.set({
      workflowType: input.workflowType,
      workflowId: input.workflowId,
      ownerId: input.ownerId,
      workflowState: input.state,
      confirmationMessageId: input.confirmationMessageId,
    });
  }

  public async recoverSchedules(): Promise<void> {
    const reminders = await this.repository.getScheduledReminders();
    const future: ReminderRecord[] = [];
    for (const reminder of reminders) {
      const scheduledFor = DateTime.fromISO(reminder.scheduledFor, { setZone: true }).setZone(reminder.timezone);
      if (!scheduledFor.isValid || scheduledFor <= clockService.now(reminder.timezone)) {
        await this.repository.updateReminder(reminder.id, { status: "cancelled" });
        logData(
          { reminderId: reminder.id, scheduledFor: reminder.scheduledFor },
          "Past reminder retired during startup recovery",
        );
        continue;
      }
      future.push(reminder);
    }
    logData({ recovered: future.length, retired: reminders.length - future.length }, "Recovering scheduled reminders");
    this.scheduler.recover(future);
  }

  public getScheduledReminders(): Promise<ReminderRecord[]> {
    return this.repository.getScheduledReminders();
  }

  public async recoverWorkflowCache(): Promise<void> {
    const reminders = await this.repository.getActiveWorkflowReminders();

    for (const reminder of reminders) {
      if (!reminder.confirmationMessageId) continue;
      this.cache.set({
        workflowType: "reminder",
        workflowId: reminder.id,
        ownerId: reminder.creatorId,
        workflowState: reminder.status,
        confirmationMessageId: reminder.confirmationMessageId,
      });
    }

    logData({ reminders: reminders.length }, "Workflow cache recovered");
  }

  /** Clears process-local workflow pointers when a staging timeline is reset. */
  public resetRuntimeState(): void {
    this.cache.clear();
  }

  public async cleanupExpiredSetlists(): Promise<number> {
    return this.setlists.cleanupExpiredSetlists();
  }

  public async getPendingSetlistBroadcasts(): Promise<SetlistSubmissionRecord[]> {
    return this.repository.getPendingSetlistBroadcasts();
  }

  public async markSetlistBroadcastSent(id: string): Promise<void> {
    await this.repository.markSetlistBroadcastSent(id);
  }

  public async clearPendingSetlistBroadcast(id: string): Promise<void> {
    await this.repository.clearPendingSetlistBroadcast(id);
  }

  public async getSetlistBroadcast(submissionId: string): Promise<SetlistSubmissionRecord | null> {
    const submission = await this.repository.getSetlistSubmission(submissionId);
    if (!submission || submission.status !== "submitted" || submission.broadcastSentAt) return null;
    const weekly = await this.repository.getSubmittedSetlistsForWeek(submission.weekStart);
    const combined = weekly.find((item) => item.kind === "setlist");
    if (combined) return { ...submission, kind: "setlist", content: combined.content };

    const worship = weekly.find((item) => item.kind === "worship");
    const praise = weekly.find((item) => item.kind === "praise");
    if (!worship || !praise) return null;
    return {
      ...submission,
      kind: "setlist",
      content: formatCombinedSetlist(worship.content, praise.content),
    };
  }

  public async completeReminder(id: string): Promise<void> {
    await this.repository.updateReminder(id, { status: "completed" });
    logData({ reminderId: id }, "Reminder marked completed");
  }

  public async isSetlistComplete(weekStart?: string): Promise<boolean> {
    return this.setlists.isSetlistComplete(weekStart);
  }

  public async getSetlistFollowup(weekStart: string): Promise<{ complete: boolean; reminderText: string | null }> {
    const complete = await this.isSetlistComplete(weekStart);
    if (complete) return { complete: true, reminderText: null };
    return {
      complete: false,
      reminderText: await this.setlists.buildCombinedMissingSubmissionReminder(weekStart),
    };
  }

  private async handlePendingReminder(
    reminder: ReminderRecord,
    action: "confirm" | "decline" | "edit" | "request_cancel",
    edit: { rawDatePhrase?: string | null; reminderMessage?: string | null },
  ): Promise<OutgoingMessage | null> {
    // Once scheduled, the original confirmation remains a stable pointer for
    // cancellation. Other actions must not silently reopen a completed flow.
    if (reminder.status === "scheduled" && action !== "request_cancel") return null;

    if (reminder.status === "pending_cancel_confirmation") {
      if (action !== "confirm") return null;
      this.scheduler.cancel(reminder.id);
      await this.repository.updateReminder(reminder.id, { status: "cancelled" });
      this.cache.remove(reminder.confirmationMessageId);
      logData({ reminderId: reminder.id }, "Reminder cancellation confirmed");
      return { text: "Cancelled. I will not send that reminder." };
    }

    if (action === "decline") {
      await this.repository.updateReminder(reminder.id, { status: "cancelled" });
      this.cache.remove(reminder.confirmationMessageId);
      logData({ reminderId: reminder.id }, "Reminder workflow declined");
      return { text: "No problem. I have cancelled that pending reminder." };
    }

    if (action === "confirm") {
      const scheduled = await this.repository.updateReminder(reminder.id, { status: "scheduled" });
      this.scheduler.schedule(scheduled);
      this.cache.remove(reminder.confirmationMessageId);
      logData({ reminderId: reminder.id, scheduledFor: scheduled.scheduledFor }, "Reminder confirmation accepted");
      return { text: "Confirmed. I have scheduled the reminder." };
    }

    if (action === "edit") {
      const rawDatePhrase = normalizeOptionalEditValue(edit.rawDatePhrase);
      const reminderMessage = normalizeOptionalEditValue(edit.reminderMessage);
      if (!rawDatePhrase && !reminderMessage) {
        return { text: "What would you like to change? Reply again to this confirmation with EDIT and the new details." };
      }
      const updates: Partial<ReminderRecord> = { status: "pending_edit_confirmation" };
      if (reminderMessage) updates.message = reminderMessage;
      if (rawDatePhrase) {
        const normalizedDatePhrase = normalizeReminderDateEditPhrase(rawDatePhrase, reminder.scheduledFor, {
          timezone: reminder.timezone,
        });
        const parsedDate = await this.parseReminderDateWithFallback(normalizedDatePhrase);
        if (!parsedDate.ok || !parsedDate.value) {
          return { text: parsedDate.reason ?? "Please give me a valid future date for the reminder." };
        }
        updates.rawDatePhrase = rawDatePhrase;
        updates.scheduledFor = parsedDate.value.iso;
        updates.timezone = parsedDate.value.timezone;
      }

      const updated = await this.repository.updateReminder(reminder.id, updates);
      logData({ reminderId: reminder.id, updates }, "Reminder edited pending reconfirmation");
      return {
        text: formatConfirmation(updated),
        metadata: { workflowConfirmation: reminderConfirmation(updated) },
      };
    }

    if (action === "request_cancel") {
      const updated = await this.repository.updateReminder(reminder.id, { status: "pending_cancel_confirmation" });
      logData({ reminderId: reminder.id }, "Reminder cancellation requested");
      return {
        text: "You are about to cancel this reminder.\n\nReply YES to confirm.",
        metadata: { workflowConfirmation: reminderConfirmation(updated) },
      };
    }

    return null;
  }

  private async parseReminderDateWithFallback(rawDatePhrase: string | undefined): Promise<ReturnType<typeof parseReminderDatePhrase>> {
    const firstPass = parseReminderDatePhrase(rawDatePhrase);
    if (firstPass.ok) return firstPass;
    // Semantic normalization may clarify unfamiliar wording, but it must not
    // reinterpret deterministically unsafe or incomplete input as schedulable.
    if (!firstPass.failure || !["unrecognized", "ambiguous"].includes(firstPass.failure)) return firstPass;

    const phrase = rawDatePhrase?.trim();
    if (!phrase) return firstPass;

    const now = clockService.now("Europe/London");
    const fallback = await this.temporalPhrases.normalizeForParser({
      rawDatePhrase: phrase,
      currentUkDateTime: now.toFormat("cccc, dd/LL/yyyy HH:mm ZZZZ"),
    });
    logData({ rawDatePhrase: phrase, currentUkDateTime: now.toISO(), fallback }, "Reminder date fallback requested");

    if (fallback.needsClarification || !fallback.normalizedDatePhrase) {
      return {
        ok: false,
        reason: fallback.clarificationQuestion ?? firstPass.reason ?? "Please give me a clearer reminder date.",
      };
    }

    const secondPass = parseReminderDatePhrase(fallback.normalizedDatePhrase, { now });
    if (!secondPass.ok) {
      logData({ rawDatePhrase: phrase, normalizedDatePhrase: fallback.normalizedDatePhrase, secondPass }, "Reminder date fallback parsing failed");
      return {
        ok: false,
        reason: secondPass.reason ?? fallback.clarificationQuestion ?? firstPass.reason,
      };
    }

    logData({ rawDatePhrase: phrase, normalizedDatePhrase: fallback.normalizedDatePhrase, secondPass }, "Reminder date fallback parsing succeeded");
    return secondPass;
  }

  private async handleWorkflowReply(
    message: IncomingMessage,
    input: {
      action: "confirm" | "decline" | "edit" | "request_cancel";
      rawDatePhrase?: string | null;
      reminderMessage?: string | null;
    },
  ): Promise<OutgoingMessage | null> {
    const confirmationMessageId = message.quotedMessage?.id;
    if (!confirmationMessageId) return null;

    const metadata = await this.resolveWorkflowMetadata(confirmationMessageId);
    if (!metadata) return null;

    if (metadata.ownerId !== message.sender.id) {
      logData({ senderId: message.sender.id, ownerId: metadata.ownerId }, "Workflow reply rejected due to ownership mismatch");
      return { text: "Only the person who started this workflow can confirm or change it." };
    }

    const reminder = await this.repository.getReminder(metadata.workflowId);
    if (!reminder) return null;
    const reply = await this.handlePendingReminder(reminder, input.action, input);
    if (getWorkflowConfirmation(reply)) {
      this.cache.remove(confirmationMessageId);
    }
    return reply;
  }

  private async resolveWorkflowMetadata(confirmationMessageId: string): Promise<WorkflowMetadata | null> {
    const cached = this.cache.get(confirmationMessageId);
    if (cached) return cached;

    const reminder = await this.repository.getReminderByConfirmationMessageId(confirmationMessageId);
    if (reminder) {
      const metadata = {
        workflowType: "reminder" as const,
        workflowId: reminder.id,
        ownerId: reminder.creatorId,
        workflowState: reminder.status,
        confirmationMessageId,
      };
      this.cache.set(metadata);
      return this.cache.get(confirmationMessageId);
    }

    return null;
  }
}

function formatCombinedSetlist(worship: string, praise: string): string {
  return `${formatSetlistSection("Worship", worship)}\n\n${formatSetlistSection("Praise", praise)}`;
}

function formatSetlistSection(label: "Worship" | "Praise", content: string): string {
  const trimmed = content.trim();
  return new RegExp(`^${label}\\s+(?:only\\s+)?setlist\\b`, "i").test(trimmed)
    ? trimmed
    : `${label} Setlist\n\n${trimmed}`;
}

function formatConfirmation(reminder: ReminderRecord): string {
  const date = formatReminderDate(reminder.scheduledFor, reminder.timezone);
  return `Reminder Details\n\nDate: ${date.displayDate}\nTime: ${date.displayTime}\n\nMessage:\n"${reminder.message}"\n\nReply YES to confirm, "Cancel Reminder" to cancel or EDIT followed with edit instructions to modify.`;
}

function formatReminderNotSet(reason: string): string {
  return [
    "Reminder wasn't set.",
    "",
    `Reason: ${reason}`,
    "",
    "Please start again with what and when.",
    "Example: `@Echo remind me tomorrow at 9am about choir rehearsal`",
  ].join("\n");
}

function formatWorkflowRejection(reason: string): OutgoingMessage {
  return { text: reason };
}

function matchesReminderAction(
  text: string,
  action: "confirm" | "decline" | "edit" | "request_cancel",
): boolean {
  if (action === "confirm") return isYes(text);
  if (action === "decline") return isNo(text);
  if (action === "edit") return isEdit(text);
  return isExplicitCancelReminder(text);
}

function isExplicitCancelReminder(text: string): boolean {
  return /\bcancel\s+reminder\b/i.test(text);
}

function isYes(text: string): boolean {
  return ["yes", "y"].includes(text.trim().toLowerCase());
}

function isNo(text: string): boolean {
  return ["no", "n"].includes(text.trim().toLowerCase());
}

function isEdit(text: string): boolean {
  return /^edit\b/i.test(text.trim());
}

function reminderConfirmation(reminder: ReminderRecord): {
  workflowType: "reminder";
  workflowId: string;
  ownerId: string;
  state: string;
} {
  return {
    workflowType: "reminder",
    workflowId: reminder.id,
    ownerId: reminder.creatorId,
    state: reminder.status,
  };
}

function getWorkflowConfirmation(reply: OutgoingMessage | null): unknown {
  return reply?.metadata?.workflowConfirmation;
}

function normalizeOptionalEditValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || /^(?:null|none|unchanged|not provided)$/i.test(trimmed)) return null;
  return trimmed;
}
