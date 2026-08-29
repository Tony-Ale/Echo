import assert from "node:assert/strict";
import { DateTime } from "luxon";
import type { IncomingMessage, OutgoingMessage } from "../framework/contracts/messages.js";
import { normalizeWhatsAppMessage, removeBotMentions } from "../integrations/whatsapp/messageUtils.js";
import { parseReminderDatePhrase } from "../workflows/dateParser.js";
import { WorkflowService } from "../workflows/workflowService.js";
import { isExplicitWorkflowActivation, parseReminderReplyAction } from "../workflows/workflowDetection.js";
import { datePhraseFallbackSchema, type TemporalPhraseService } from "../workflows/temporalPhraseService.js";
import type { ReminderScheduler } from "../workflows/reminderScheduler.js";
import { ReminderScheduler as ConcreteReminderScheduler } from "../workflows/reminderScheduler.js";
import type { ScheduledTask, SchedulerPort, WeeklyScheduledTask } from "../framework/ports/index.js";
import type { SetlistService } from "../workflows/setlistService.js";
import type { ReminderRecord, SetlistKind } from "../workflows/types.js";
import type { WorkflowRepository } from "../workflows/workflowRepository.js";
import { WorkflowCache } from "../workflows/workflowCache.js";
import { cancelJob, getScheduledJobs, scheduleJob } from "../integrations/scheduler/jobScheduler.js";
import { clockService } from "../shared/clockService.js";

class FakeRepository {
  public reminders: ReminderRecord[] = [];

  public async createReminder(input: Omit<ReminderRecord, "id">): Promise<ReminderRecord> {
    const reminder = { ...input, id: `r-${this.reminders.length + 1}` };
    this.reminders.push(reminder);
    return reminder;
  }

  public async updateReminder(id: string, updates: Partial<ReminderRecord>): Promise<ReminderRecord> {
    const index = this.reminders.findIndex((reminder) => reminder.id === id);
    assert.notEqual(index, -1);
    this.reminders[index] = { ...this.reminders[index], ...updates };
    return this.reminders[index];
  }

  public async getLatestReminderWorkflow(chatId: string, creatorId: string): Promise<ReminderRecord | null> {
    return [...this.reminders].reverse().find((reminder) =>
      reminder.chatId === chatId &&
      reminder.creatorId === creatorId &&
      ["pending_confirmation", "pending_edit_confirmation", "pending_cancel_confirmation"].includes(reminder.status)
    ) ?? null;
  }

  public async getLatestActiveReminder(chatId: string, creatorId: string): Promise<ReminderRecord | null> {
    return [...this.reminders].reverse().find((reminder) =>
      reminder.chatId === chatId &&
      reminder.creatorId === creatorId &&
      ["pending_confirmation", "pending_edit_confirmation", "pending_cancel_confirmation", "scheduled"].includes(reminder.status)
    ) ?? null;
  }

  public async findDuplicateScheduledReminder(input: {
    chatId: string;
    creatorId: string;
    message: string;
    scheduledFor: string;
  }): Promise<ReminderRecord | null> {
    return this.reminders.find((reminder) =>
      reminder.chatId === input.chatId &&
      reminder.creatorId === input.creatorId &&
      reminder.message === input.message &&
      reminder.scheduledFor === input.scheduledFor &&
      ["pending_confirmation", "scheduled"].includes(reminder.status)
    ) ?? null;
  }

  public async getScheduledReminders(): Promise<ReminderRecord[]> {
    return this.reminders.filter((reminder) => reminder.status === "scheduled");
  }

  public async setReminderConfirmationMessageId(id: string, confirmationMessageId: string): Promise<ReminderRecord> {
    return this.updateReminder(id, { confirmationMessageId });
  }

  public async getReminder(id: string): Promise<ReminderRecord | null> {
    return this.reminders.find((reminder) => reminder.id === id) ?? null;
  }

  public async getReminderByConfirmationMessageId(confirmationMessageId: string): Promise<ReminderRecord | null> {
    return this.reminders.find((reminder) => reminder.confirmationMessageId === confirmationMessageId) ?? null;
  }

}

class FakeExtraction {
  public constructor(private readonly creationRawDatePhrase: string | null = "next Thursday") {}

  public async extractReminderCreation() {
    return {
      intent: "create_reminder" as const,
      rawDatePhrase: this.creationRawDatePhrase ?? undefined,
      reminderMessage: "Choir rehearsal starts by 5pm",
      needsClarification: false,
    };
  }

  public async extractReminderEdit() {
    return {
      intent: "edit_reminder" as const,
      updates: { rawDatePhrase: "next Friday at 7pm" },
      needsClarification: false,
    };
  }

  public async normalizeForParser() {
    return {
      normalizedDatePhrase: "tomorrow at 9am",
      needsClarification: false,
    };
  }
}

class FakeClarifyingExtraction extends FakeExtraction {
  public async extractReminderCreation() {
    return {
      intent: "create_reminder" as const,
      rawDatePhrase: undefined,
      reminderMessage: "",
      needsClarification: true,
      clarificationQuestion: "When should I remind you?",
    };
  }
}

class FakeScheduler {
  public scheduled: string[] = [];
  public cancelled: string[] = [];
  public recoveries = 0;
  public recovered: string[] = [];

  public schedule(reminder: ReminderRecord): void {
    this.scheduled.push(reminder.id);
  }

  public cancel(reminderId: string): void {
    this.cancelled.push(reminderId);
  }

  public recover(reminders: ReminderRecord[] = []): void {
    this.recoveries += 1;
    this.recovered.push(...reminders.map((reminder) => reminder.id));
  }
}

class FakeSetlists {
  public detectSubmissionKind(text: string): SetlistKind | null {
    if (text.includes("#submit_setlist")) return "setlist";
    return null;
  }

  public async submit(): Promise<string> {
    return { text: "Done. The worship/praise setlist has been saved." } as never;
  }
}

const baseMessage: IncomingMessage = {
  id: "m1",
  conversationId: "group@g.us",
  transport: "whatsapp",
  sender: {
    id: "111@s.whatsapp.net",
    displayName: "Test User",
    identifiers: { participantPhoneJid: "111@s.whatsapp.net" },
  },
  text: "@Echo remind me next Thursday about choir rehearsal",
  mentions: ["bot@s.whatsapp.net"],
  mentionedAgent: true,
  metadata: {},
};

async function run(): Promise<void> {
  testStructuredExtractionSchemasUseExplicitNulls();
  testReminderSchedulerUsesIsoFrameworkBoundary();
  // Keep relative reminder phrases and the preserved 22 August edit date stable.
  clockService.setMockTime("2026-08-19 10:00");
  const parsed = parseReminderDatePhrase("next Thursday", {
    now: DateTime.fromISO("2026-05-15T10:00:00", { zone: "Europe/London" }),
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value?.displayTime, "9:00 AM");

  const past = parseReminderDatePhrase("yesterday", {
    now: DateTime.fromISO("2026-05-15T10:00:00", { zone: "Europe/London" }),
  });
  assert.equal(past.ok, false);
  assert.equal(isExplicitWorkflowActivation("you remind me of my music teacher"), false);
  assert.equal(isExplicitWorkflowActivation("remind me tomorrow about rehearsal"), true);
  assert.equal(isExplicitWorkflowActivation("set a reminder for tomorrow"), true);
  assert.equal(isExplicitWorkflowActivation("Songs\n#submit_worship"), false);
  assert.equal(isExplicitWorkflowActivation("Songs\n#submit_praise"), false);
  assert.equal(isExplicitWorkflowActivation("Songs\n#submit_setlist"), true);
  assert.equal(parseReminderReplyAction("YES"), "confirm");
  assert.equal(parseReminderReplyAction("EDIT tomorrow at 7pm"), "edit");
  assert.equal(parseReminderReplyAction("cancel reminder"), "request_cancel");
  assert.equal(parseReminderReplyAction("yes, please"), null);
  assert.equal(isExplicitWorkflowActivation("Echo remind the group every Monday at 10am with an update"), true);
  assert.equal(isExplicitWorkflowActivation("We should remind the group that punctuality matters"), false);

  const normalized = normalizeWhatsAppMessage({
    key: { id: "msg", remoteJid: "group@g.us", participant: "111@s.whatsapp.net" },
    message: {
      extendedTextMessage: {
        text: "@123 remind me tomorrow",
        contextInfo: {
          mentionedJid: ["bot:1@s.whatsapp.net"],
          quotedMessage: { conversation: "Quoted reminder content" },
          participant: "222@s.whatsapp.net",
          stanzaId: "quoted-1",
        },
      },
    },
    pushName: "Test User",
  } as never, ["bot@s.whatsapp.net"]);
  assert.equal(normalized?.mentionedAgent, true);
  assert.equal(normalized?.quotedMessage?.text, "Quoted reminder content");
  assert.equal(
    removeBotMentions("@123 Echo, remind @456 tomorrow", ["123@s.whatsapp.net"]),
    "Echo, remind @456 tomorrow",
  );
  assert.equal(
    removeBotMentions("Please contact @1234", ["123@s.whatsapp.net"]),
    "Please contact @1234",
  );

  const repository = new FakeRepository();
  const scheduler = new FakeScheduler();
  const service = new WorkflowService(
    repository as unknown as WorkflowRepository,
    new FakeExtraction() as unknown as TemporalPhraseService,
    scheduler as unknown as ReminderScheduler,
    new FakeSetlists() as unknown as SetlistService,
    new WorkflowCache()
  );

  const created = await service.createReminder({
    message: baseMessage,
    rawDatePhrase: "next Thursday",
    reminderMessage: "Choir rehearsal starts by 5pm",
  });
  assert.match(created?.text ?? "", /Reply YES to confirm/);
  assert.equal(repository.reminders[0].status, "pending_confirmation");
  assert.ok(workflowConfirmation(created));
  await service.registerConfirmationMessage({
    ...workflowConfirmation(created)!,
    confirmationMessageId: "confirm-1",
  });

  const replyContext = { id: "confirm-1", authorId: "bot@s.whatsapp.net", text: created!.text };

  const otherUserYes = await service.continueReminder({
    action: "confirm",
    message: {
      ...baseMessage,
      sender: { id: "222@s.whatsapp.net", displayName: "Other", identifiers: {} },
      text: "YES",
      quotedMessage: replyContext,
    },
  });
  assert.match(otherUserYes?.text ?? "", /Only the person/);
  assert.equal(repository.reminders[0].status, "pending_confirmation");

  const edited = await service.continueReminder({
    action: "edit",
    rawDatePhrase: "next Friday at 7pm",
    message: { ...baseMessage, text: "EDIT time to 7pm", quotedMessage: replyContext },
  });
  assert.match(edited?.text ?? "", /Reply YES to confirm/);
  assert.equal(repository.reminders[0].status, "pending_edit_confirmation");
  await service.registerConfirmationMessage({
    ...workflowConfirmation(edited)!,
    confirmationMessageId: "confirm-2",
  });
  const editReplyContext = { id: "confirm-2", authorId: "bot@s.whatsapp.net", text: edited!.text };

  const confirmed = await service.continueReminder({
    action: "confirm",
    message: { ...baseMessage, text: "YES", quotedMessage: editReplyContext },
  });
  assert.equal(confirmed?.text, "Confirmed. I have scheduled the reminder.");
  assert.equal(repository.reminders[0].status, "scheduled");
  assert.deepEqual(scheduler.scheduled, ["r-1"]);

  repository.reminders[0].status = "pending_confirmation";
  repository.reminders[0].scheduledFor = DateTime.fromISO("2026-08-22T09:00:00", { zone: "Europe/London" }).toISO()!;
  repository.reminders[0].message = "Choir rehearsal starts by 5pm";
  repository.reminders[0].confirmationMessageId = "confirm-time-only";
  const timeOnlyEdit = await service.continueReminder({
    action: "edit",
    rawDatePhrase: "10:30am",
    reminderMessage: "null",
    message: {
      ...baseMessage,
      text: "EDIT time to 10:30am",
      quotedMessage: { ...replyContext, id: "confirm-time-only" },
    },
  });
  assert.match(timeOnlyEdit.text, /Date: 22\/08\/2026/);
  assert.match(timeOnlyEdit.text, /Time: 10:30 AM/);
  assert.match(timeOnlyEdit.text, /Choir rehearsal starts by 5pm/);
  assert.doesNotMatch(timeOnlyEdit.text, /"null"/);

  repository.reminders[0].status = "pending_confirmation";
  repository.reminders[0].confirmationMessageId = "confirm-3";
  const cancelPrompt = await service.continueReminder({
    action: "request_cancel",
    message: { ...baseMessage, text: "cancel reminder", quotedMessage: { ...replyContext, id: "confirm-3" } },
  });
  assert.match(cancelPrompt?.text ?? "", /Reply YES to confirm/);
  assert.equal(repository.reminders[0].status, "pending_cancel_confirmation");
  await service.registerConfirmationMessage({
    ...workflowConfirmation(cancelPrompt)!,
    confirmationMessageId: "confirm-4",
  });

  const cancelled = await service.continueReminder({
    action: "confirm",
    message: { ...baseMessage, text: "YES", quotedMessage: { ...replyContext, id: "confirm-4" } },
  });
  assert.equal(cancelled?.text, "Cancelled. I will not send that reminder.");
  assert.equal(repository.reminders[0].status, "cancelled");
  assert.deepEqual(scheduler.cancelled, ["r-1"]);

  const setlist = await service.submitSetlist({
    scope: "combined",
    message: { ...baseMessage, text: "Songs\n#submit_setlist" },
  });
  assert.match(setlist?.text ?? "", /saved/);
  assert.equal(workflowConfirmation(setlist), undefined);

  const fallbackRepository = new FakeRepository();
  const fallbackService = new WorkflowService(
    fallbackRepository as unknown as WorkflowRepository,
    new FakeExtraction("when the altos are ready") as unknown as TemporalPhraseService,
    new FakeScheduler() as unknown as ReminderScheduler,
    new FakeSetlists() as unknown as SetlistService,
    new WorkflowCache()
  );
  const fallbackCreated = await fallbackService.createReminder({
    message: { ...baseMessage, text: "@Echo remind me when the altos are ready about choir rehearsal" },
    rawDatePhrase: "when the altos are ready",
    reminderMessage: "Choir rehearsal starts by 5pm",
  });
  assert.match(fallbackCreated?.text ?? "", /Reply YES to confirm/);
  assert.equal(fallbackRepository.reminders[0].status, "pending_confirmation");

  const missingDateRepository = new FakeRepository();
  const missingDateService = new WorkflowService(
    missingDateRepository as unknown as WorkflowRepository,
    new FakeExtraction(null) as unknown as TemporalPhraseService,
    new FakeScheduler() as unknown as ReminderScheduler,
    new FakeSetlists() as unknown as SetlistService,
    new WorkflowCache()
  );
  const missingDate = await missingDateService.createReminder({
    message: { ...baseMessage, text: "@Echo remind me about choir rehearsal" },
    rawDatePhrase: null,
    reminderMessage: "choir rehearsal",
  });
  assert.match(missingDate?.text ?? "", /Reminder wasn't set/);
  assert.match(missingDate?.text ?? "", /when to send/);
  assert.equal(missingDateRepository.reminders.length, 0);

  const inventedDate = await missingDateService.createReminder({
    message: { ...baseMessage, text: "@Echo remind me about choir rehearsal" },
    rawDatePhrase: "next Saturday at 9am",
    reminderMessage: "choir rehearsal",
  });
  assert.match(inventedDate.text, /Reminder wasn't set/);
  assert.match(inventedDate.text, /include when/i);
  assert.equal(missingDateRepository.reminders.length, 0);

  const quotedDate = await missingDateService.createReminder({
    message: {
      ...baseMessage,
      text: "@Echo remind me about this",
      quotedMessage: { id: "quoted-date", text: "Choir rehearsal is tomorrow at 10am" },
    },
    rawDatePhrase: "tomorrow at 10am",
    reminderMessage: null,
  });
  assert.match(quotedDate.text, /Reminder wasn't set/);
  assert.match(quotedDate.text, /include when/i);
  assert.equal(missingDateRepository.reminders.length, 0);

  const quotedContentRepository = new FakeRepository();
  const quotedContentService = new WorkflowService(
    quotedContentRepository as unknown as WorkflowRepository,
    new FakeExtraction() as unknown as TemporalPhraseService,
    new FakeScheduler() as unknown as ReminderScheduler,
    new FakeSetlists() as unknown as SetlistService,
    new WorkflowCache(),
  );
  const quotedContent = await quotedContentService.createReminder({
    message: {
      ...baseMessage,
      text: "@Echo remind me tomorrow at 10am",
      quotedMessage: { id: "quoted-content", text: "Choir rehearsal starts by 5pm" },
    },
    rawDatePhrase: "tomorrow at 10am",
    reminderMessage: null,
  });
  assert.match(quotedContent.text, /Reply YES to confirm/);
  assert.equal(quotedContentRepository.reminders[0]?.message, "Choir rehearsal starts by 5pm");

  const clarifyingRepository = new FakeRepository();
  const clarifyingService = new WorkflowService(
    clarifyingRepository as unknown as WorkflowRepository,
    new FakeClarifyingExtraction() as unknown as TemporalPhraseService,
    new FakeScheduler() as unknown as ReminderScheduler,
    new FakeSetlists() as unknown as SetlistService,
    new WorkflowCache()
  );
  const clarifying = await clarifyingService.createReminder({
    message: { ...baseMessage, text: "@Echo remind me" },
    rawDatePhrase: null,
    reminderMessage: null,
  });
  assert.match(clarifying?.text ?? "", /Reminder wasn't set/);
  assert.match(clarifying?.text ?? "", /when to send/);
  assert.equal(clarifyingRepository.reminders.length, 0);

  clockService.setMockTime("2026-08-03 09:00");
  const recoveryRepository = new FakeRepository();
  const recoveryScheduler = new FakeScheduler();
  const recoveryService = new WorkflowService(
    recoveryRepository as unknown as WorkflowRepository,
    new FakeExtraction() as unknown as TemporalPhraseService,
    recoveryScheduler as unknown as ReminderScheduler,
    new FakeSetlists() as unknown as SetlistService,
    new WorkflowCache(),
  );
  const reminderBase = {
    chatId: baseMessage.conversationId,
    creatorId: baseMessage.sender.id,
    message: "Recovery test",
    rawDatePhrase: "test",
    timezone: "Europe/London",
    status: "scheduled" as const,
    createdAt: "2026-08-01T09:00:00.000+01:00",
    updatedAt: "2026-08-01T09:00:00.000+01:00",
  };
  const expiredReminder = await recoveryRepository.createReminder({
    ...reminderBase,
    scheduledFor: "2026-08-03T08:00:00.000+01:00",
  });
  const futureReminder = await recoveryRepository.createReminder({
    ...reminderBase,
    scheduledFor: "2026-08-03T10:00:00.000+01:00",
  });
  await recoveryService.recoverSchedules();
  assert.equal((await recoveryRepository.getReminder(expiredReminder.id))?.status, "cancelled");
  assert.deepEqual(recoveryScheduler.recovered, [futureReminder.id]);

  let oneTimeRuns = 0;
  scheduleJob({
    jobId: "self-test-one-time",
    runOnce: true,
    dateTime: "2026-08-03 10:00",
    schedulerStrategy: "custom",
    action: async () => {
      oneTimeRuns += 1;
    },
  });
  clockService.advanceTime({ hours: 1, minutes: 1 });
  await waitForTimers();
  assert.equal(oneTimeRuns, 1);

  let recurringRuns = 0;
  scheduleJob({
    jobId: "self-test-recurring",
    dayOfWeek: 1,
    time: "12:00",
    schedulerStrategy: "custom",
    action: async () => {
      recurringRuns += 1;
    },
  });
  clockService.advanceTime({ hours: 2 });
  await waitForTimers();
  assert.equal(recurringRuns, 1);
  assert.equal(getScheduledJobs().some((job) => job.jobId === "self-test-recurring"), true);
  cancelJob("self-test-recurring");

  let longWaitRuns = 0;
  scheduleJob({
    jobId: "self-test-long-wait",
    runOnce: true,
    dateTime: "2026-10-03 12:00",
    schedulerStrategy: "custom",
    action: async () => {
      longWaitRuns += 1;
    },
  });
  await waitForTimers();
  assert.equal(longWaitRuns, 0, "A delay longer than Node's timer limit must not execute immediately.");
  assert.equal(getScheduledJobs().some((job) => job.jobId === "self-test-long-wait"), true);
  cancelJob("self-test-long-wait");
  clockService.clearMockTime();
}

function testReminderSchedulerUsesIsoFrameworkBoundary(): void {
  clockService.setMockTime("2026-08-19 10:00");
  let captured: ScheduledTask | undefined;
  const port: SchedulerPort = {
    scheduleOnce: (task) => { captured = task; },
    scheduleWeekly: (_task: WeeklyScheduledTask) => undefined,
    cancel: () => undefined,
  };
  const scheduler = new ConcreteReminderScheduler(port);
  const scheduledFor = "2026-08-20T10:30:00.000+01:00";
  scheduler.schedule({
    id: "iso-boundary",
    chatId: "group@g.us",
    creatorId: "111@s.whatsapp.net",
    creatorName: "Test Creator",
    message: "Bring the register",
    rawDatePhrase: "20 August at 10:30am",
    scheduledFor,
    timezone: "Europe/London",
    status: "scheduled",
  });
  assert.equal(captured?.runAt, scheduledFor);
  clockService.clearMockTime();
}

function testStructuredExtractionSchemasUseExplicitNulls(): void {
  assert.equal(datePhraseFallbackSchema.safeParse({
    normalizedDatePhrase: null,
    needsClarification: true,
    clarificationQuestion: "Which day did you mean?",
  }).success, true);
}

async function waitForTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

type WorkflowConfirmation = {
  workflowType: "reminder";
  workflowId: string;
  ownerId: string;
  state: string;
};

function workflowConfirmation(reply: OutgoingMessage | null): WorkflowConfirmation | undefined {
  return reply?.metadata?.workflowConfirmation as WorkflowConfirmation | undefined;
}

run()
  .then(() => console.log("workflowSelfTest passed"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
