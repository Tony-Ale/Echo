import assert from "node:assert/strict";
import { LocalChatTransport, type LocalApprovalRegistry, type LocalWorkflowConfirmationRegistry } from "../integrations/localChat/localChatTransport.js";
import type { RuntimeIdentityRecord } from "../agent/persistence/identityRepository.js";
import { AgentActivityStream } from "../integrations/localChat/agentActivityStream.js";
import { sanitizeActivityInput } from "../agent/runtime/activitySanitizer.js";
import { clockService } from "../shared/clockService.js";
import { cancelJob, scheduleJob, waitForScheduledJobsToSettle } from "../integrations/scheduler/jobScheduler.js";
import {
  evaluateStagingRun,
  stagingEvaluationSchema,
  toTurnConstraints,
} from "../integrations/localChat/agentEvaluation.js";

const member: RuntimeIdentityRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  canonicalName: "Test Member",
  displayName: "Tester",
  phone: "15550001003",
  roles: ["member"],
};

async function run(): Promise<void> {
  const workflowCalls: unknown[] = [];
  const approvalCalls: unknown[] = [];
  const workflows: LocalWorkflowConfirmationRegistry = {
    async registerConfirmationMessage(input) { workflowCalls.push(input); },
  };
  const approvals: LocalApprovalRegistry = {
    async registerApprovalMessage(approvalId, messageId) { approvalCalls.push({ approvalId, messageId }); },
  };
  const transport = new LocalChatTransport(
    "staging-group",
    { async getRuntimeDirectorySnapshot() { return [member]; } },
    workflows,
    approvals,
  );

  const actors = await transport.refreshActors();
  assert.deepEqual(actors[0], {
    id: member.id,
    canonicalName: member.canonicalName,
    displayName: member.displayName,
    roles: ["member"],
    registered: true,
  });
  assert.equal(JSON.stringify(actors).includes(member.phone!), false, "Browser actor data must not expose phone numbers.");

  const first = transport.createIncoming({ actorId: member.id, text: "Hello Echo" });
  transport.recordIncoming(first, member.id);
  const receipt = await transport.send("staging-group", {
    text: "Hello",
    metadata: {
      workflowConfirmation: {
        workflowType: "reminder",
        workflowId: "workflow-1",
        ownerId: member.phone,
        state: "pending_confirmation",
      },
      agentApproval: { approvalId: "approval-1" },
    },
  });
  const reply = transport.createIncoming({ actorId: member.id, text: "YES", replyToMessageId: receipt.messageId });
  assert.equal(reply.repliedToAgent, true);
  assert.equal(reply.quotedMessage?.id, receipt.messageId);
  assert.equal(workflowCalls.length, 1);
  assert.deepEqual(approvalCalls, [{ approvalId: "approval-1", messageId: receipt.messageId }]);
  assert.equal(JSON.stringify(transport.getMessages()).includes(member.phone!), false, "Transcript must not expose phone numbers.");
  transport.clearMessages();
  assert.deepEqual(transport.getMessages(), []);

  const simulated = transport.addSimulatedActor("New Singer");
  assert.equal(simulated.registered, false);
  const unknownMessage = transport.createIncoming({ actorId: simulated.id, text: "Hello Echo" });
  assert.equal(unknownMessage.metadata.conversationKind, "choir");
  assert.equal(unknownMessage.metadata.actorMemberId, undefined);
  assert.equal(unknownMessage.sender.displayName, "New Singer");

  assert.throws(
    () => transport.createIncoming({ actorId: "22222222-2222-4222-8222-222222222222", text: "Hello" }),
    /Unknown staging member/,
  );

  const activity = new AgentActivityStream(2);
  const received: string[] = [];
  const unsubscribe = activity.subscribe((event) => received.push(event.id));
  for (const id of ["one", "two", "three"]) {
    activity.publish({
      id,
      eventKey: "event",
      turnId: "turn",
      occurredAt: "2026-08-11T10:00:00.000+01:00",
      phase: "tool",
      status: "completed",
      title: "Tool finished",
    });
  }
  unsubscribe();
  assert.deepEqual(activity.list().map((event) => event.id), ["two", "three"]);
  assert.deepEqual(received, ["one", "two", "three"]);
  assert.deepEqual(activity.listThrough(clockService.Date("2026-08-11T09:59:59.000+01:00").getTime()), []);
  assert.deepEqual(activity.listThrough(clockService.Date("2026-08-11T10:00:00.000+01:00").getTime()).map((event) => event.id), ["two", "three"]);
  activity.clear();
  assert.deepEqual(activity.list(), []);
  assert.deepEqual(sanitizeActivityInput({ phone: "15550001003", query: "Contact 15550001003" }), {
    phone: "[private]",
    query: "Contact [private identifier]",
  });
  await testTimeTravelExecutesDueSchedulerJob();
  testControlledAgentEvaluation();
  console.log("Staging transport self-tests passed.");
}

function testControlledAgentEvaluation(): void {
  const input = stagingEvaluationSchema.parse({
    allowedTools: ["inspect_spreadsheet", "query_spreadsheet"],
    maxSteps: 4,
    includeRecentConversation: false,
    expectedTools: ["inspect_spreadsheet", "query_spreadsheet"],
    expectedAnswerIncludes: ["Member A", "unavailable"],
  });
  assert.deepEqual(toTurnConstraints(input), {
    allowedToolNames: ["inspect_spreadsheet", "query_spreadsheet"],
    maxSteps: 4,
    includeRecentConversation: false,
  });

  const result = evaluateStagingRun({
    messageId: "message-1",
    eventKey: "event-1",
    evaluation: input,
    replyText: "Member A was unavailable.",
    activity: [{
      id: "tool-1",
      eventKey: "event-1",
      turnId: "turn-1",
      occurredAt: "2026-08-11T10:00:00.000+01:00",
      phase: "tool",
      status: "started",
      title: "Running inspect_spreadsheet",
      tool: { name: "inspect_spreadsheet" },
    }, {
      id: "tool-2",
      eventKey: "event-1",
      turnId: "turn-1",
      occurredAt: "2026-08-11T10:00:01.000+01:00",
      phase: "tool",
      status: "started",
      title: "Running query_spreadsheet",
      tool: { name: "query_spreadsheet" },
    }],
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.actualTools, ["inspect_spreadsheet", "query_spreadsheet"]);
}

async function testTimeTravelExecutesDueSchedulerJob(): Promise<void> {
  const jobId = "staging-time-travel-test";
  let executions = 0;
  clockService.setMockTime("2026-08-13 10:00");
  try {
    scheduleJob({
      jobId,
      dateTime: "2026-08-13 10:05",
      runOnce: true,
      schedulerStrategy: "custom",
      action: async () => { executions += 1; },
    });
    clockService.advanceTime({ minutes: 6 });
    await waitForScheduledJobsToSettle();
    assert.equal(executions, 1);
  } finally {
    cancelJob(jobId);
    clockService.clearMockTime();
  }
}

void run();
