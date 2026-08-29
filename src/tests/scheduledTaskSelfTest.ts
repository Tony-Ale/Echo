import assert from "node:assert/strict";
import { InMemoryScheduledAgentTaskRepository, InMemorySchedulerPort } from "../agent/testing/fakes.js";
import { describeRecurringSchedule, nextRecurringRun, parseRecurringSchedule } from "../agent/services/recurringSchedule.js";
import { ScheduledAgentTaskService } from "../agent/services/scheduledAgentTaskService.js";
import { clockService } from "../shared/clockService.js";
import { z } from "zod";
import { EchoAgentExecutor } from "../agent/runtime/agentExecutor.js";
import { AgentToolRegistry } from "../agent/runtime/toolRegistry.js";
import { DefaultAgentContextAssembler } from "../agent/runtime/contextAssembler.js";
import { EchoAgentService } from "../agent/services/echoAgentService.js";
import {
  FakeAgentTransport,
  InMemoryAgentJournal,
  InMemoryConversationRepository,
  InMemoryIdentityRepository,
  InMemoryMemoryRepository,
  ScriptedAgentPlanner,
} from "../agent/testing/fakes.js";
import type { AgentTool } from "../agent/types.js";
import type { IncomingMessage } from "../framework/contracts/messages.js";
import { SheetsRepository } from "../integrations/googleSheets/sheetsRepository.js";

const CHAT_ID = "choir@g.us";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";

async function run(): Promise<void> {
  clockService.setMockTime("2026-08-16 12:00");
  try {
    testRecurringScheduleParsing();
    await testDeterministicSpreadsheetQuery();
    await testRecurringTaskLifecycle();
    await testRecoveryAndOwnership();
    await testImmediateActivationUsesAgentTransport();
    console.log("Scheduled agent task self-tests passed.");
  } finally {
    clockService.clearMockTime();
  }
}

async function testDeterministicSpreadsheetQuery(): Promise<void> {
  const sheets = new SheetsRepository({
    spreadsheets: {
      async get() {
        return { data: { sheets: [{ properties: { title: "Contributions" } }] } };
      },
      values: {
        async get() {
          return {
            data: {
              values: [
                ["Name", "August payment"],
                ["Ada", "Paid"],
                ["Ben", ""],
                ["Chris", "Pending"],
              ],
            },
          };
        },
      },
    },
  } as never);
  const inspected = await sheets.inspectSheet("Contributions");
  assert.deepEqual(inspected.columns, ["Name", "August payment"]);
  assert.equal(inspected.rowCount, 3);
  const unpaid = await sheets.querySheet({
    sheetName: "Contributions",
    filters: [{ column: "August payment", operator: "not_equals", value: "Paid" }],
    selectColumns: ["Name"],
    limit: 10,
  });
  assert.deepEqual(unpaid.rows, [{ Name: "Ben" }, { Name: "Chris" }]);
  assert.equal(unpaid.truncated, false);
}

async function testImmediateActivationUsesAgentTransport(): Promise<void> {
  clockService.setMockTime("2026-08-16 12:00");
  const repository = new InMemoryScheduledAgentTaskRepository();
  const scheduler = new InMemorySchedulerPort();
  const tasks = new ScheduledAgentTaskService(repository, scheduler);
  const identities = new InMemoryIdentityRepository();
  identities.addMember({
    id: OWNER_ID,
    canonicalName: "Test Creator",
    displayName: "Creator",
    roles: ["member", "creator"],
    status: "active",
    identifiers: [{ kind: "phone", value: "15550001001", verified: true }],
  });
  const createTool: AgentTool = {
    name: "create_scheduled_agent_task",
    description: "Test creation boundary.",
    capability: "workflow",
    schema: z.object({ objective: z.string(), rawSchedulePhrase: z.string() }),
    sideEffect: "write",
    async execute(input, context) {
      const saved = await tasks.create({
        chatId: context.event.chatId!,
        ownerMemberId: context.actor!.id,
        objective: input.objective,
        rawSchedulePhrase: input.rawSchedulePhrase,
      });
      return {
        status: "success",
        summary: "Created.",
        data: { scheduledTaskId: saved.task!.id, created: true },
        reply: { text: "" },
      };
    },
  };
  const planner = new ScriptedAgentPlanner((input) => input.event.source === "transport"
    ? {
        kind: "tool",
        toolName: "create_scheduled_agent_task",
        input: { objective: "Send the current operations update.", rawSchedulePhrase: "every Monday at 10am" },
        reason: "Create the recurring task.",
      }
    : { kind: "respond", message: "Current operations update", reason: "Execute the saved objective." });
  const tools = new AgentToolRegistry([createTool]);
  const conversations = new InMemoryConversationRepository();
  const executor = new EchoAgentExecutor(
    planner,
    tools,
    new DefaultAgentContextAssembler(identities, new InMemoryMemoryRepository(), conversations),
    new InMemoryAgentJournal(),
    conversations,
  );
  const transport = new FakeAgentTransport();
  const service = new EchoAgentService(
    executor,
    transport,
    undefined,
    conversations,
    identities,
    "whatsapp",
    undefined,
    undefined,
    undefined,
    tasks,
  );
  tasks.setRunner(async (activation) => {
    const result = await service.handleScheduledWake({
      eventKey: activation.executionKey,
      type: "scheduled_agent_task_due",
      chatId: activation.task.chatId,
      actorMemberId: activation.task.ownerMemberId,
      payload: {
        objective: activation.task.objective,
        scheduledFor: activation.scheduledFor,
        immediate: activation.immediate,
        allowUntargetedMessage: true,
      },
    });
    return { result, procedure: tools.buildReusableProcedure(result.steps) };
  });

  const incoming: IncomingMessage = {
    id: "create-recurring-1",
    conversationId: CHAT_ID,
    transport: "whatsapp",
    sender: { id: "15550001001", displayName: "Creator", identifiers: { phone: "15550001001" } },
    text: "Echo remind the group every Monday at 10am with the current operations update",
    mentions: [],
    mentionedAgent: true,
    metadata: { conversationKind: "choir" },
  };
  const reply = await service.handleMessage(incoming);
  assert.equal(reply, null, "the first result is delivered by the scheduled activation and must not be returned twice");
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].reply.text, "Current operations update");
  assert.equal(repository.tasks.length, 1);
  const duplicateReply = await service.handleMessage(incoming);
  assert.equal(duplicateReply, null);
  assert.equal(transport.sent.length, 1, "a retried creation event must not deliver the immediate run twice");
}

function testRecurringScheduleParsing(): void {
  const monthly = parseRecurringSchedule("every month on the 28th at 6pm");
  assert.equal(monthly.ok, true);
  if (!monthly.ok) return;
  assert.deepEqual(monthly.schedule, {
    frequency: "monthly",
    dayOfMonth: 28,
    time: "18:00",
    timezone: "Europe/London",
  });
  assert.equal(describeRecurringSchedule(monthly.schedule), "day 28 of every month at 6:00 PM");
  assert.equal(
    nextRecurringRun(monthly.schedule, clockService.now("Europe/London")).toISO(),
    "2026-08-28T18:00:00.000+01:00",
  );

  const weekly = parseRecurringSchedule("every Friday at 09:30");
  assert.equal(weekly.ok, true);
  if (weekly.ok) assert.equal(weekly.schedule.frequency === "weekly" ? weekly.schedule.weekday : null, 5);
  assert.equal(parseRecurringSchedule("every month at 6pm").ok, false);
  assert.equal(parseRecurringSchedule("monthly on the 2nd").ok, false);
  assert.equal(parseRecurringSchedule("tomorrow at 6pm").ok, false);
}

async function testRecurringTaskLifecycle(): Promise<void> {
  const repository = new InMemoryScheduledAgentTaskRepository();
  const scheduler = new InMemorySchedulerPort();
  const service = new ScheduledAgentTaskService(repository, scheduler);
  let executions = 0;
  service.setRunner(async (activation) => {
    executions += 1;
    return {
      result: {
        eventKey: activation.executionKey,
        status: "completed",
        reply: { text: `Run ${executions}` },
        steps: [],
      },
      procedure: [{ toolName: "query_spreadsheet", input: { sheetName: "Contributions" } }],
    };
  });

  const created = await service.create({
    chatId: CHAT_ID,
    ownerMemberId: OWNER_ID,
    objective: "Check current contributions and tag members who have not paid.",
    rawSchedulePhrase: "every month on the 28th at 6pm",
  });
  assert.equal(created.created, true);
  assert.ok(created.task);
  assert.equal(scheduler.oneTime.size, 1);

  const first = await service.runNow(created.task!.id);
  assert.equal(first?.reply?.text, "Run 1");
  assert.equal(executions, 1);
  assert.equal((await service.runNow(created.task!.id)), null, "the deterministic initial execution key must suppress duplicates");
  assert.equal(repository.tasks[0].procedure[0]?.toolName, "query_spreadsheet");

  const duplicate = await service.create({
    chatId: CHAT_ID,
    ownerMemberId: OWNER_ID,
    objective: "Check current contributions and tag members who have not paid.",
    rawSchedulePhrase: "every month on the 28th at 6pm",
  });
  assert.equal(duplicate.created, false);
  assert.equal(repository.tasks.length, 1);

  clockService.setMockTime("2026-08-28 18:00");
  const dueJobId = [...scheduler.oneTime.keys()][0];
  await scheduler.run(dueJobId);
  assert.equal(executions, 2);
  assert.equal(repository.tasks[0].nextRunAt, "2026-09-28T18:00:00.000+01:00");
  assert.equal(scheduler.oneTime.size, 1, "the next occurrence must survive cleanup of the completed timer");
}

async function testRecoveryAndOwnership(): Promise<void> {
  clockService.setMockTime("2026-08-16 12:00");
  const repository = new InMemoryScheduledAgentTaskRepository();
  const originalScheduler = new InMemorySchedulerPort();
  const service = new ScheduledAgentTaskService(repository, originalScheduler);
  const created = await service.create({
    chatId: CHAT_ID,
    ownerMemberId: OWNER_ID,
    objective: "Send the weekly operations summary.",
    rawSchedulePhrase: "every Monday at 10am",
  });
  assert.ok(created.task);

  const denied = await service.manage({ id: created.task!.id, ownerMemberId: crypto.randomUUID(), action: "cancel" });
  assert.ok(denied.error);
  const paused = await service.manage({ id: created.task!.id, ownerMemberId: OWNER_ID, action: "pause" });
  assert.equal(paused.task?.status, "paused");
  assert.equal(originalScheduler.oneTime.size, 0);
  const resumed = await service.manage({ id: created.task!.id, ownerMemberId: OWNER_ID, action: "resume" });
  assert.equal(resumed.task?.status, "active");
  assert.equal(originalScheduler.oneTime.size, 1);

  const recoveredScheduler = new InMemorySchedulerPort();
  const recoveredService = new ScheduledAgentTaskService(repository, recoveredScheduler);
  repository.tasks[0].nextRunAt = "2026-08-10T10:00:00.000+01:00";
  await recoveredService.recover();
  assert.equal(recoveredScheduler.oneTime.size, 1);
  assert.equal(
    repository.tasks[0].nextRunAt,
    "2026-08-17T10:00:00.000+01:00",
    "Recovery must advance an overdue recurrence without executing the missed occurrence.",
  );

  const listed = await recoveredService.listOwned(OWNER_ID, CHAT_ID);
  assert.equal(listed.length, 1);
  const cancelled = await recoveredService.manage({ id: created.task!.id, ownerMemberId: OWNER_ID, action: "cancel" });
  assert.equal(cancelled.task?.status, "cancelled");
}

void run();
