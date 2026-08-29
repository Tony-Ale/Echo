import express from "express";
import path from "node:path";
import { z } from "zod";
import { createEchoApplication } from "../../app/createEchoApplication.js";
import {
  getScheduledJobs,
  areScheduledMessagesDisabled,
  disableScheduledMessages,
  enableScheduledMessages,
  pauseScheduledJobs,
  waitForScheduledJobsToSettle,
} from "../scheduler/jobScheduler.js";
import { clockService } from "../../shared/clockService.js";
import { LocalChatTransport } from "./localChatTransport.js";
import type { ReminderRecord } from "../../workflows/types.js";
import { AgentActivityStream } from "./agentActivityStream.js";
import { StagingTimelineRepository } from "./stagingTimelineRepository.js";

const messageSchema = z.object({
  actorId: z.string().uuid(),
  text: z.string().trim().min(1).max(4000),
  replyToMessageId: z.string().min(1).optional(),
});
const actorSchema = z.object({ displayName: z.string().trim().min(1).max(100) });
const setClockSchema = z.object({ dateTime: z.string().trim().min(1).max(50) });
const advanceClockSchema = z.object({
  days: z.number().int().min(0).max(366).optional(),
  hours: z.number().int().min(0).max(8_784).optional(),
  minutes: z.number().int().min(0).max(527_040).optional(),
}).refine((value) => (value.days ?? 0) + (value.hours ?? 0) + (value.minutes ?? 0) > 0, {
  message: "Provide a positive time amount.",
});

/** Starts the isolated browser-based staging group without loading Baileys. */
export async function startLocalChatServer(input: { port: number; conversationId: string }): Promise<void> {
  const activity = new AgentActivityStream();
  const timelineRepository = new StagingTimelineRepository();
  const application = await createEchoApplication({
    chatId: input.conversationId,
    transportId: "local-chat",
    activitySink: activity,
  });
  const transport = new LocalChatTransport(
    input.conversationId,
    application.identities,
    application.workflowService,
    application.agentService,
  );
  application.agentService.setTransport(transport);
  application.messageRouter.setScheduledMessageControls({
    disable: disableScheduledMessages,
    enable: () => {
      enableScheduledMessages();
      void application.scheduledTasks.recover();
      void application.choirScheduleService.start();
    },
    isDisabled: areScheduledMessagesDisabled,
  });
  application.reminderScheduler.setHandlers(
    async (reminder) => sendReminder(reminder, transport, application.identities),
    (id) => application.workflowService.completeReminder(id),
  );

  const recoverSchedules = async (): Promise<void> => {
    await application.workflowService.recoverSchedules();
    await application.workflowService.recoverWorkflowCache();
    await application.scheduledTasks.recover();
    await application.choirScheduleService.start();
  };

  const updateClock = async (change: () => void): Promise<void> => {
    pauseScheduledJobs();
    await waitForScheduledJobsToSettle();
    change();
    await waitForScheduledJobsToSettle();
  };

  const resetTimeline = async (change: () => void): Promise<void> => {
    disableScheduledMessages();
    await waitForScheduledJobsToSettle();
    try {
      await timelineRepository.reset(input.conversationId);
      transport.clearMessages();
      activity.clear();
      application.workflowService.resetRuntimeState();
      change();
    } finally {
      enableScheduledMessages();
      await recoverSchedules();
    }
  };

  await transport.refreshActors();
  await recoverSchedules();

  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(path.resolve(process.cwd(), "src/integrations/localChat/public")));

  app.get("/api/state", async (_request, response) => {
    const now = clockService.now("Europe/London");
    response.json({
      environment: "staging",
      conversationId: input.conversationId,
      now: now.toISO(),
      mockTime: clockService.isMockTimeEnabled(),
      schedulerDisabled: areScheduledMessagesDisabled(),
      actors: transport.listActors(),
      messages: transport.getMessages(),
      activity: activity.listThrough(now.toMillis()),
      schedules: getScheduledJobs(),
      obligations: await application.obligations.listActive(input.conversationId),
    });
  });

  // Scheduler actions continue asynchronously after a clock jump. The staging
  // UI polls this small snapshot while Operations is visible so transitions do
  // not remain frozen at the first post-jump response.
  app.get("/api/operations", async (_request, response) => {
    response.json({
      ...currentClockState(),
      schedulerDisabled: areScheduledMessagesDisabled(),
      schedules: getScheduledJobs(),
      obligations: await application.obligations.listActive(input.conversationId),
    });
  });

  app.post("/api/actors/refresh", async (_request, response) => {
    response.json({ actors: await transport.refreshActors() });
  });

  app.post("/api/actors", (request, response) => {
    const parsed = actorSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid participant." });
      return;
    }
    response.status(201).json({ actor: transport.addSimulatedActor(parsed.data.displayName) });
  });

  app.post("/api/clock/set", async (request, response) => {
    const parsed = setClockSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid date and time." });
      return;
    }
    try {
      const target = clockService.parseDateTime(parsed.data.dateTime, "Europe/London");
      if (target < clockService.now("Europe/London")) {
        await resetTimeline(() => clockService.setMockTime(parsed.data.dateTime, "Europe/London"));
        response.json({ ...currentClockState(), timelineReset: true });
        return;
      }
      await updateClock(() => clockService.setMockTime(parsed.data.dateTime, "Europe/London"));
      response.json(currentClockState());
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : "Invalid date and time." });
    }
  });

  app.post("/api/clock/advance", async (request, response) => {
    const parsed = advanceClockSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid time amount." });
      return;
    }
    try {
      await updateClock(() => clockService.advanceTime(parsed.data));
      response.json(currentClockState());
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : "Could not advance application time." });
    }
  });

  app.post("/api/clock/clear", async (_request, response) => {
    try {
      const movingBackward = clockService.systemNow("Europe/London") < clockService.now("Europe/London");
      if (movingBackward) {
        await resetTimeline(() => clockService.clearMockTime());
        response.json({ ...currentClockState(), timelineReset: true });
        return;
      }
      await updateClock(() => clockService.clearMockTime());
      response.json(currentClockState());
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : "Could not restore live time." });
    }
  });

  app.post("/api/messages", async (request, response) => {
    const parsed = messageSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid message." });
      return;
    }
    try {
      const incoming = transport.createIncoming(parsed.data);
      transport.recordIncoming(incoming, parsed.data.actorId);
      const reply = await application.messageRouter.handle(incoming);
      if (reply) await transport.send(input.conversationId, { ...reply, replyToMessageId: reply.replyToMessageId ?? incoming.id });
      response.json({ ok: true });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : "Message processing failed." });
    }
  });

  app.get("/api/events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const unsubscribe = transport.subscribe((message) => response.write(`data: ${JSON.stringify(message)}\n\n`));
    request.on("close", unsubscribe);
  });

  app.get("/api/activity-events", (request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    const unsubscribe = activity.subscribe((event) => response.write(`data: ${JSON.stringify(event)}\n\n`));
    request.on("close", unsubscribe);
  });

  app.get("/health", (_request, response) => response.json({ status: "ok", transport: "local-chat" }));
  app.use((_request, response) => response.sendFile(path.resolve(process.cwd(), "src/integrations/localChat/public/index.html")));

  app.listen(input.port, "127.0.0.1", () => {
    console.log(`Echo staging group running at http://127.0.0.1:${input.port}`);
  });
}

function currentClockState(): { now: string; mockTime: boolean } {
  return {
    now: clockService.now("Europe/London").toISO()!,
    mockTime: clockService.isMockTimeEnabled(),
  };
}

async function sendReminder(
  reminder: ReminderRecord,
  transport: LocalChatTransport,
  identities: Awaited<ReturnType<typeof createEchoApplication>>["identities"],
): Promise<void> {
  const identity = await identities.resolveSender({
    id: reminder.creatorId,
    identifiers: { whatsappJid: reminder.creatorId },
  });
  const name = identity?.displayName;
  await transport.send(reminder.chatId, {
    text: `${name ? `@${name} ` : ""}Reminder\n\n${reminder.message}`,
    mentions: identity ? [`member:${identity.id}`] : [],
  });
}
