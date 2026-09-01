import assert from "node:assert/strict";
import { z } from "zod";
import { EchoAgentExecutor } from "../agent/runtime/agentExecutor.js";
import { AgentToolRegistry } from "../agent/runtime/toolRegistry.js";
import { EchoAgentService } from "../agent/services/echoAgentService.js";
import { createCoreAgentTools } from "../agent/tools/coreTools.js";
import type { AgentActivityEvent, AgentPlannerInput, AgentTurnContext, MemberIdentity } from "../agent/types.js";
import {
  FakeAgentTransport,
  InMemoryApprovalRepository,
  InMemoryAgentJournal,
  InMemoryConversationRepository,
  InMemoryIdentityRepository,
  InMemoryMemoryRepository,
  InMemoryObligationRepository,
  InMemorySchedulerPort,
  InMemoryWeeklyInterpretationRepository,
  ScriptedAgentPlanner,
  StaticContextAssembler,
  GroupChatSimulator,
} from "../agent/testing/fakes.js";
import { AgentApprovalCoordinator } from "../agent/services/approvalCoordinator.js";
import { clockService } from "../shared/clockService.js";
import type { IncomingMessage } from "../framework/contracts/messages.js";
import type { AgentActivitySink, ChoirKnowledgeService, ChoirWorkflowService, ScheduledDeliveryObserver, ScheduledMessagePolicy, SpreadsheetDataService } from "../agent/ports.js";
import type { ScheduledAgentTaskManager } from "../agent/ports.js";
import { ChoirDeliveryObserver } from "../domains/choir/operations/choirDeliveryObserver.js";
import { ChoirScheduleService } from "../domains/choir/operations/choirScheduleService.js";
import { AgentObligationScheduler } from "../agent/services/obligationScheduler.js";
import { DefaultAgentContextAssembler } from "../agent/runtime/contextAssembler.js";
import { RoutingAgentPlanner } from "../agent/runtime/modelRouter.js";
import { LangChainAgentPlanner, PlannerProtocolError } from "../agent/runtime/langChainPlanner.js";
import type { ConfiguredChatModel } from "../framework/models/types.js";
import { formatScheduledJobsForWhatsApp, MessageRouter } from "../app/messageRouter.js";
import type { ScheduledJobInfo } from "../integrations/scheduler/jobScheduler.js";
import {
  isSetlistLeadershipRole,
  ModelWeeklyScheduleAssessor,
  normalizeScheduleAssessment,
  RotaReminderService,
  type WeeklyScheduleAssessor,
} from "../domains/choir/operations/rotaReminderService.js";
import { SetlistOperationsService } from "../domains/choir/operations/setlistOperationsService.js";
import { agentConfig } from "../config/agentConfig.js";
import { isFutureScheduleDate } from "../app/scheduleVisibility.js";
import { SupabaseAgentJournal } from "../agent/persistence/operationsRepository.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { echoCapabilityRegistry } from "../deployments/echo/capabilities.js";

const CHAT_ID = "choir@g.us";
const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";

async function run(): Promise<void> {
  clockService.setMockTime("2026-08-11 10:00");
  try {
    await testCasualAndQuotedConversation();
    await testMentionTool();
    await testPermissionGate();
    await testDurableCreatorApproval();
    await testSchedulerSemanticSkip();
    await testCompoundSundayRotaReminder();
    testOversizedScheduleAmbiguitiesAreBounded();
    await testInterruptedExecutionRecovery();
    testSetlistLeaderRoleSelection();
    await testMidweekAssignmentIsIndependentOfSundayCancellation();
    await testCachedWeeklyInterpretationOmitsBulkyEvidence();
    await testScheduledDeliveryRequiresGatedTool();
    await testSchedulerTargetedDelivery();
    await testCompoundSetlistBroadcast();
    await testChoirScheduleActivationPersistsObligation();
    await testStartupBackfillsMissedSetlistPlanning();
    await testStartupDoesNotDuplicateExistingSetlistNudges();
    await testStartupSkipsLastFridayWeekSetlistPlanning();
    await testCreatorCanTriggerSundayReminderPrivately();
    await testMemberCannotTriggerSundayReminder();
    testScheduleOutputIsChronologicalAndReadable();
    testPastDurableStateIsNotASchedule();
    await testSundaySetlistPlanningTargetsUpcomingWeek();
    await testPartialOptionalCoverageDoesNotExposeSync();
    await testSkippedSyncDoesNotPermitRepeatedRetrieval();
    await testAtomicToolCompletesWithoutReplanning();
    await testNonTerminalToolPreservesAgenticLoop();
    await testConstrainedGenericSpreadsheetEvaluation();
    await testWeeklySchedulePreservesCompleteEvidence();
    await testRotaAssessmentPreservesCompleteEvidence();
    await testUnknownSpreadsheetColumnCanBeRepaired();
    await testAggregateQueryBroadensBeforeClaimingAbsence();
    await testValidatedNextToolAvoidsPlannerRoundTrip();
    await testDuplicateNextToolIsDiscarded();
    await testInvalidNextToolIsDiscarded();
    await testSetlistPlanningCreatesRecoverableObligations();
    await testObligationRecoveryRebuildsTimers();
    await testObligationRecoveryExpiresPastSetlistNudges();
    await testObligationRecoveryExpiresPastSetlistBroadcasts();
    await testDuplicateEventRecovery();
    await testMaximumSteps();
    await testInvalidToolInputCanBeReplanned();
    await testDeterministicToolFailureIsNotRetryable();
    await testFailureLimitIsNotReportedAsStepLimit();
    await testAgentActivityLifecycle();
    await testReadOnlyEvidenceUsesFastSynthesis();
    await testOperationalProtocolFailureUsesFastRecovery();
    await testCompactContextLoadsDeeperStateOnDemand();
    await testScheduledContextExcludesConversationHistory();
    await testCapabilityCatalogActivation();
    await testHiddenToolCapabilityRecovery();
    await testSyncRecoveryVisibility();
    await testFailedSyncDoesNotStopTurn();
    await testPlannerRepairsPrematureTerminalDecision();
    await testPlannerRepairsEmptyRequiredToolInput();
    await testPlannerRepairsMalformedStructuredOutput();
    await testRepeatedMalformedPlannerOutputUsesFastRecovery();
    await testPlannerUnwrapsNestedDecisionInput();
    await testPlannerUnwrapsFencedToolInput();
    await testPlannerDoesNotExposeProtocolFailures();
    await testPlannerCanRequestDiscoverableHiddenTool();
    await testPlannerOmitsMissingOptionalProfile();
    await testPlannerPreservesCompleteToolResults();
    await testPlannerAcceptsVerifiedDeferral();
    await testBoundedMemberMemory();
    await testPlannerOnboardsUnknownChoirMember();
    await testOnboardingRejectsUntrustedConversation();
    await testPlannerUpdatesPermanentMemberProfile();
    await testPlannerRemembersDurableMemberFact();
    console.log("Echo 3.0 agent self-tests passed.");
  } finally {
    clockService.clearMockTime();
  }
}

function testOversizedScheduleAmbiguitiesAreBounded(): void {
  const assessment = normalizeScheduleAssessment({
    sundayActivityCancelled: null,
    setlistRequired: null,
    summary: "The schedule needs clarification.",
    ambiguities: ["x".repeat(450), "  ", ...Array.from({ length: 9 }, (_, index) => `Issue ${index + 1}`)],
  });

  assert.equal(assessment.ambiguities.length, 8);
  assert.equal(assessment.ambiguities[0]?.length, 300);
  assert.equal(assessment.ambiguities.includes(""), false);
}

async function testInterruptedExecutionRecovery(): Promise<void> {
  const rows: RecoveryRows = {
    echo_agent_events: [
      { id: "old-event", status: "running", received_at: "2026-08-11T09:00:00.000+01:00" },
      { id: "recent-event", status: "running", received_at: "2026-08-11T09:59:00.000+01:00" },
      { id: "done-event", status: "completed", received_at: "2026-08-11T09:00:00.000+01:00" },
    ],
    echo_agent_turns: [
      { id: "old-turn", status: "running", started_at: "2026-08-11T09:00:00.000+01:00" },
      { id: "recent-turn", status: "running", started_at: "2026-08-11T09:59:00.000+01:00" },
    ],
    echo_tool_executions: [
      { id: "old-tool", status: "running", started_at: "2026-08-11T09:00:00.000+01:00" },
      { id: "recent-tool", status: "running", started_at: "2026-08-11T09:59:00.000+01:00" },
    ],
  };
  const journal = new SupabaseAgentJournal(createRecoveryClient(rows));
  const result = await journal.recoverInterruptedExecutions("2026-08-11T09:54:30.000+01:00");

  assert.deepEqual(result, { events: 1, turns: 1, tools: 1 });
  assert.equal(rows.echo_agent_events[0]?.status, "failed");
  assert.equal(rows.echo_agent_turns[0]?.status, "failed");
  assert.equal(rows.echo_tool_executions[0]?.status, "error");
  assert.equal(rows.echo_tool_executions[0]?.error, "interrupted_before_completion");
  assert.equal(rows.echo_agent_events[1]?.status, "running");
  assert.equal(rows.echo_agent_turns[1]?.status, "running");
  assert.equal(rows.echo_tool_executions[1]?.status, "running");
  assert.equal(rows.echo_agent_events[2]?.status, "completed");

  assert.deepEqual(
    await journal.recoverInterruptedExecutions("2026-08-11T09:54:30.000+01:00"),
    { events: 0, turns: 0, tools: 0 },
  );
}

type RecoveryRow = Record<string, unknown> & { id: string; status: string };
type RecoveryRows = Record<"echo_agent_events" | "echo_agent_turns" | "echo_tool_executions", RecoveryRow[]>;

function createRecoveryClient(rows: RecoveryRows): SupabaseClient {
  return {
    from(table: keyof RecoveryRows) {
      return {
        update(values: Record<string, unknown>) {
          const filters: Array<(row: RecoveryRow) => boolean> = [];
          const query = {
            eq(column: string, value: unknown) {
              filters.push((row) => row[column] === value);
              return query;
            },
            lte(column: string, value: string) {
              filters.push((row) => String(row[column]) <= value);
              return query;
            },
            async select() {
              const changed = rows[table].filter((row) => filters.every((filter) => filter(row)));
              for (const row of changed) Object.assign(row, values);
              return { data: changed.map(({ id }) => ({ id })), error: null };
            },
          };
          return query;
        },
      };
    },
  } as unknown as SupabaseClient;
}

function testSetlistLeaderRoleSelection(): void {
  assert.equal(isSetlistLeadershipRole("Workers prayer worship"), false);
  assert.equal(isSetlistLeadershipRole("Opening prayer and worship"), false);
  assert.equal(isSetlistLeadershipRole("Hymn, worship & praise"), true);
  assert.equal(isSetlistLeadershipRole("Praise & Worship"), true);
  assert.equal(isSetlistLeadershipRole("Worship"), true);
}

function testPastDurableStateIsNotASchedule(): void {
  assert.equal(isFutureScheduleDate("2026-08-11T09:59:59+01:00"), false);
  assert.equal(isFutureScheduleDate("2026-08-11T10:00:01+01:00"), true);
  assert.equal(isFutureScheduleDate("invalid"), false);
}

async function testCompoundSundayRotaReminder(): Promise<void> {
  const identities = identityDirectory();
  const weeklyInterpretations = new InMemoryWeeklyInterpretationRepository();
  let assessmentCalls = 0;
  const assessor: WeeklyScheduleAssessor = {
    async assess() {
      assessmentCalls += 1;
      return {
        sundayActivityCancelled: false,
        setlistRequired: true,
        summary: "The target week contains choir assignments.",
        ambiguities: [],
      };
    },
  };
  const structuredEvidence = {
    august: [{
      WEEK_START: "2026-08-17",
      CONTENT: [
        "Week of 17 August 2026",
        "",
        "Wednesday 19/08/2026",
        "- Bible study P&W: Member",
        "Sunday 23/08/2026",
        "- Workers prayer worship: Member",
        "- Hymn, worship & praise: Member (Hymn - Great Is Thy Faithfulness)",
        "- Special ministration (I will sing)",
        "- Offering, welcome & family song",
        "- Uniform (Ladies: white; Men: black)",
      ].join("\n"),
    }],
  };
  const knowledge: ChoirKnowledgeService = {
    async retrieve() {
      return {
        context: [
          `Structured evidence: ${JSON.stringify(structuredEvidence)}`,
          "Semantic evidence: None",
          "Sheet descriptions: {}",
        ].join("\n\n"),
        sourceHash: "compound-sunday-source",
        provenance: retrievalProvenance("complete"),
      };
    },
  };
  const service = new RotaReminderService(
    knowledge,
    weeklyInterpretations,
    identities,
    successfulSyncCoordinator(),
    assessor,
  );
  const first = await service.prepare({
    weekStart: "2026-08-17",
    transport: "whatsapp",
    kind: "sunday",
    signal: new AbortController().signal,
  });
  const second = await service.prepare({
    weekStart: "2026-08-17",
    transport: "whatsapp",
    kind: "midweek",
    signal: new AbortController().signal,
  });

  assert.equal(first.status, "ready");
  assert.match(first.reply?.text ?? "", /Bible study P&W: @Member/);
  assert.match(first.reply?.text ?? "", /Hymn, worship & praise: @Member \(Hymn - Great Is Thy Faithfulness\)/);
  assert.match(first.reply?.text ?? "", /Special ministration \(I will sing\)/);
  assert.match(first.reply?.text ?? "", /Offering, welcome & family song/);
  assert.match(first.reply?.text ?? "", /Uniform \(Ladies: white; Men: black\)/);
  assert.deepEqual(first.reply?.mentions, ["200@s.whatsapp.net"]);
  assert.equal(second.status, "ready");
  assert.match(second.reply?.text ?? "", /Choir Rota - Wednesday, 19 August 2026/);
  assert.match(second.reply?.text ?? "", /Bible study P&W: @Member/);
  assert.doesNotMatch(second.reply?.text ?? "", /Workers prayer worship/);
  assert.equal(assessmentCalls, 1, "a source-matched cached interpretation should skip the model assessment");
  assert.equal(weeklyInterpretations.values.length, 1);
  assert.deepEqual(weeklyInterpretations.values[0].interpretation.worshipPraiseLeaderNames, ["Member"]);
}

async function testMidweekAssignmentIsIndependentOfSundayCancellation(): Promise<void> {
  const service = new RotaReminderService(
    {
      async retrieve() {
        return {
          context: [
            `Structured evidence: ${JSON.stringify({
              august: [{
                WEEK_START: "2026-08-24",
                CONTENT: [
                  "Wednesday 26/08/2026",
                  "- Bible study P&W: Member",
                  "Church Vigil Friday 28/08/2026",
                  "- Youth Week",
                  "Sunday 30/08/2026",
                  "- Youth Sunday: Youth choir",
                ].join("\n"),
              }],
            })}`,
            "Semantic evidence: The regular choir is explicitly replaced for Youth Sunday only.",
          ].join("\n\n"),
          sourceHash: "scoped-midweek-cancellation",
          provenance: retrievalProvenance("complete"),
        };
      },
    },
    new InMemoryWeeklyInterpretationRepository(),
    identityDirectory(),
    successfulSyncCoordinator(),
    {
      async assess() {
        return {
          sundayActivityCancelled: true,
          setlistRequired: false,
          summary: "Only the regular Sunday activity is replaced.",
          ambiguities: [],
        };
      },
    },
  );

  const midweek = await service.prepare({
    weekStart: "2026-08-24",
    transport: "whatsapp",
    kind: "midweek",
    signal: new AbortController().signal,
  });
  const sunday = await service.prepare({
    weekStart: "2026-08-24",
    transport: "whatsapp",
    kind: "sunday",
    signal: new AbortController().signal,
  });

  assert.equal(midweek.status, "ready");
  assert.match(midweek.reply?.text ?? "", /Bible study P&W: @Member/);
  assert.doesNotMatch(midweek.reply?.text ?? "", /Youth Week/);
  assert.equal(sunday.status, "not_applicable");
}

async function testScheduledContextExcludesConversationHistory(): Promise<void> {
  const conversations = new InMemoryConversationRepository();
  await conversations.append({
    chatId: CHAT_ID,
    role: "user",
    content: "Unrelated recurring Attendance reminder instruction.",
    senderName: "Creator",
  });
  const assembler = new DefaultAgentContextAssembler(
    identityDirectory(),
    new InMemoryMemoryRepository(),
    conversations,
  );
  const context = await assembler.assemble({
    eventKey: "scheduled-context-isolation",
    source: "scheduler",
    type: "weekly_rota_reminder_due",
    chatId: CHAT_ID,
    actorMemberId: CREATOR_ID,
    payload: { weekStart: "2026-08-10" },
  });

  assert.deepEqual(context.recentConversation, []);
}

async function testPlannerRepairsMalformedStructuredOutput(): Promise<void> {
  let invocations = 0;
  const model = {
    withStructuredOutput() {
      return {
        async invoke() {
          invocations += 1;
          if (invocations === 1) {
            throw new SyntaxError("Unexpected non-whitespace character after JSON at position 20");
          }
          return {
            kind: "respond",
            message: "Recovered response.",
            reason: "The bounded structured-output repair succeeded.",
            plan: [],
            toolName: "",
            inputJson: "{}",
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");

  const decision = await planner.decide(plannerInput(), new AbortController().signal);

  assert.equal(invocations, 2);
  assert.equal(decision.kind, "respond");
  if (decision.kind === "respond") assert.equal(decision.message, "Recovered response.");
}

async function testRepeatedMalformedPlannerOutputUsesFastRecovery(): Promise<void> {
  let primaryInvocations = 0;
  let recoveryCalls = 0;
  const model = {
    withStructuredOutput() {
      return {
        async invoke() {
          primaryInvocations += 1;
          throw new SyntaxError("Unexpected token '`' in structured output");
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const primary = new LangChainAgentPlanner(model, "test-model", "Test system prompt");
  const fast = new ScriptedAgentPlanner(() => {
    recoveryCalls += 1;
    return { kind: "respond", message: "Recovered.", reason: "Fallback produced a valid decision." };
  });
  const router = new RoutingAgentPlanner(primary, fast);
  const input = plannerInput();
  input.event = { ...input.event, source: "scheduler", type: "setlist_weekly_planning_due", message: undefined };
  input.toolCatalog = [{
    name: "plan_weekly_setlist_nudges",
    description: "Plan the week's setlist follow-ups.",
    inputSchema: '{"weekStart":"YYYY-MM-DD"}',
    sideEffect: "write",
    capability: "choir_operations",
  }];

  const decision = await router.decide(input, new AbortController().signal);

  assert.equal(primaryInvocations, 2, "The primary planner should make only its initial and bounded repair calls.");
  assert.equal(recoveryCalls, 1);
  assert.equal(decision.kind, "respond");
}

async function testPlannerRepairsEmptyRequiredToolInput(): Promise<void> {
  let invocationCount = 0;
  let repairPrompt = "";
  const model = {
    withStructuredOutput() {
      return {
        async invoke(messages: Array<{ content: unknown }>) {
          invocationCount += 1;
          if (invocationCount === 1) {
            return {
              kind: "tool",
              message: "",
              toolName: "retrieve_choir_knowledge",
              inputJson: "{}",
              reason: "Retrieve current evidence.",
              plan: [],
            };
          }
          repairPrompt = String(messages.at(-1)?.content ?? "");
          return {
            kind: "tool",
            message: "",
            toolName: "retrieve_choir_knowledge",
            inputJson: JSON.stringify({ query: "Saturday rehearsal attendance" }),
            reason: "Retrieve current evidence.",
            plan: [],
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");
  const input = plannerInput();
  input.toolCatalog[0].acceptsEmptyInput = false;

  const decision = await planner.decide(input, new AbortController().signal);

  assert.equal(invocationCount, 2);
  assert.match(repairPrompt, /requires arguments/);
  assert.match(repairPrompt, /Saturday|query/);
  assert.equal(decision.kind, "tool");
  if (decision.kind === "tool") assert.deepEqual(decision.input, { query: "Saturday rehearsal attendance" });
}

async function testPlannerOmitsMissingOptionalProfile(): Promise<void> {
  let serializedInput = "";
  const model = {
    withStructuredOutput() {
      return {
        async invoke(messages: Array<{ content: unknown }>) {
          serializedInput = String(messages.at(-1)?.content ?? "");
          return {
            kind: "respond",
            message: "Hello.",
            reason: "The resolved member greeted Echo; no optional memory is needed.",
            plan: [],
            toolName: "",
            inputJson: "{}",
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");

  await planner.decide(plannerInput(), new AbortController().signal);
  const payload = JSON.parse(serializedInput) as { currentContext: Record<string, unknown> };
  assert.equal(Object.hasOwn(payload.currentContext, "memberProfile"), false);
  assert.equal((payload.currentContext.actor as { id?: string })?.id, MEMBER_ID);
}

async function testPlannerPreservesCompleteToolResults(): Promise<void> {
  let serializedInput = "";
  const marker = "TAIL_RECORD_MUST_REMAIN_VISIBLE";
  const model = {
    withStructuredOutput() {
      return {
        async invoke(messages: Array<{ content: unknown }>) {
          serializedInput = String(messages.at(-1)?.content ?? "");
          return {
            kind: "respond",
            message: "Complete evidence received.",
            reason: "The requested record is present in the tool result.",
            plan: [],
            toolName: "",
            inputJson: "{}",
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");
  const input = plannerInput();
  input.previousSteps.push({
    step: 0,
    decision: {
      kind: "tool",
      toolName: "retrieve_choir_knowledge",
      input: { query: "complete evidence" },
      reason: "Read the source.",
    },
    result: {
      status: "success",
      summary: "Complete source returned.",
      data: { evidence: `${"x".repeat(30_000)}${marker}` },
    },
  });

  await planner.decide(input, new AbortController().signal);

  const payload = JSON.parse(serializedInput) as {
    completedSteps: Array<{ result?: { data?: { evidence?: string } } }>;
  };
  assert.equal(payload.completedSteps[0]?.result?.data?.evidence?.endsWith(marker), true);
}

async function testPlannerUnwrapsNestedDecisionInput(): Promise<void> {
  let invocation = 0;
  const model = {
    withStructuredOutput() {
      return {
        async invoke() {
          invocation += 1;
          const decision = {
            kind: "tool",
            toolName: "compose_member_message",
            input: { text: "Hello Member", memberNames: ["Member"] },
          };
          return {
            kind: "tool",
            message: "",
            toolName: "compose_member_message",
            inputJson: JSON.stringify(invocation === 1 ? { decision } : decision),
            reason: "Compose the resolved reminder.",
            plan: ["Compose the message"],
            nextTool: null,
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");
  const input = plannerInput();
  input.toolCatalog = [{
    name: "compose_member_message",
    description: "Compose a member message.",
    inputSchema: '{"text":"message","memberNames":["name"]}',
    sideEffect: "message",
    capability: "identity",
  }];

  const decision = await planner.decide(input, new AbortController().signal);

  assert.equal(decision.kind, "tool");
  if (decision.kind === "tool") {
    assert.deepEqual(decision.input, { text: "Hello Member", memberNames: ["Member"] });
  }

  const directDecision = await planner.decide(input, new AbortController().signal);
  assert.equal(directDecision.kind, "tool");
  if (directDecision.kind === "tool") {
    assert.deepEqual(directDecision.input, { text: "Hello Member", memberNames: ["Member"] });
  }
}

async function testPlannerUnwrapsFencedToolInput(): Promise<void> {
  const model = {
    withStructuredOutput() {
      return {
        async invoke() {
          return {
            kind: "tool",
            message: "",
            toolName: "retrieve_choir_knowledge",
            inputJson: "```json\n{\"query\":\"weekly schedule\"}\n```",
            reason: "Current choir data is required.",
            plan: ["Retrieve the weekly schedule"],
            nextTool: null,
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");

  const decision = await planner.decide(plannerInput(), new AbortController().signal);

  assert.equal(decision.kind, "tool");
  if (decision.kind === "tool") {
    assert.deepEqual(decision.input, { query: "weekly schedule" });
  }
}

async function testPlannerCanRequestDiscoverableHiddenTool(): Promise<void> {
  let invocationCount = 0;
  const model = {
    withStructuredOutput() {
      return {
        async invoke() {
          invocationCount += 1;
          return {
            kind: "tool",
            message: "",
            reason: "Member memory is required.",
            plan: [],
            toolName: "read_member_memory",
            inputJson: "{}",
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");
  const input = plannerInput();
  input.availableCapabilities.push({
    id: "memory",
    description: "Read bounded memory.",
    active: false,
    toolNames: ["read_member_memory"],
  });

  const decision = await planner.decide(input, new AbortController().signal);
  assert.equal(invocationCount, 1);
  assert.equal(decision.kind, "tool");
  if (decision.kind === "tool") assert.equal(decision.toolName, "read_member_memory");
}

async function testPlannerDoesNotExposeProtocolFailures(): Promise<void> {
  let invocationCount = 0;
  const model = {
    withStructuredOutput() {
      return {
        async invoke() {
          invocationCount += 1;
          return {
            kind: "tool",
            message: "",
            reason: "Malformed test decision.",
            plan: [],
            toolName: "tool_that_does_not_exist",
            inputJson: "{}",
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");

  await assert.rejects(
    planner.decide(plannerInput(), new AbortController().signal),
    /planner_returned_unknown_tool/,
  );
  assert.equal(invocationCount, 2, "One repair attempt should occur before the internal failure is raised.");
}

async function testPlannerRepairsPrematureTerminalDecision(): Promise<void> {
  const responses = [
    {
      kind: "defer",
      message: "More information is required.",
      reason: "Current evidence is insufficient.",
      plan: ["retrieve_choir_knowledge"],
      toolName: "",
      inputJson: "{}",
    },
    {
      kind: "tool",
      message: "",
      reason: "The available knowledge tool can obtain the missing evidence.",
      plan: ["Use the retrieved evidence to answer the request."],
      toolName: "retrieve_choir_knowledge",
      inputJson: JSON.stringify({ query: "Saturday rehearsal attendance" }),
    },
  ];
  let invocationCount = 0;
  const model = {
    withStructuredOutput() {
      return {
        async invoke() {
          const response = responses[invocationCount];
          invocationCount += 1;
          if (!response) throw new Error("Unexpected planner invocation.");
          return response;
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");
  const decision = await planner.decide(plannerInput(), new AbortController().signal);

  assert.equal(invocationCount, 2);
  assert.equal(decision.kind, "tool");
  if (decision.kind === "tool") {
    assert.equal(decision.toolName, "retrieve_choir_knowledge");
    assert.deepEqual(decision.input, { query: "Saturday rehearsal attendance" });
  }
}

async function testPlannerAcceptsVerifiedDeferral(): Promise<void> {
  let invocationCount = 0;
  const model = {
    withStructuredOutput() {
      return {
        async invoke() {
          invocationCount += 1;
          return {
            kind: "defer",
            message: "The required source is currently unavailable.",
            reason: "A retrieval attempt returned no reliable evidence.",
            plan: [],
            toolName: "",
            inputJson: "{}",
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const planner = new LangChainAgentPlanner(model, "test-model", "Test system prompt");
  const input = plannerInput();
  input.previousSteps.push({
    step: 0,
    decision: {
      kind: "tool",
      toolName: "retrieve_choir_knowledge",
      input: { query: "Saturday rehearsal attendance" },
      reason: "Retrieve current evidence.",
    },
    result: { status: "success", summary: "No reliable evidence was found." },
  });
  const decision = await planner.decide(input, new AbortController().signal);

  assert.equal(invocationCount, 1);
  assert.equal(decision.kind, "defer");
  assert.deepEqual(decision.plan, []);
}

async function testPlannerRemembersDurableMemberFact(): Promise<void> {
  const identities = identityDirectory();
  const planner = new ScriptedAgentPlanner((input) => input.previousSteps.length === 0 ? ({
    kind: "tool",
    toolName: "remember_member_fact",
    input: {
      category: "preference",
      fact: "Prefers morning reminders",
      importance: "normal",
    },
    reason: "The member directly stated a durable communication preference.",
  }) : ({
    kind: "respond",
    message: "I will keep that in mind.",
    reason: "The durable preference was stored.",
  }));
  const runtime = createRuntime(planner, memberIdentity(), { identities, dynamicContext: true });
  const reply = await runtime.service.handleMessage({
    ...incomingMessage("remember-fact", "I prefer reminders in the morning"),
    metadata: { conversationKind: "choir" },
  });
  assert.equal(reply?.text, "I will keep that in mind.");
  assert.deepEqual(await runtime.memory.getMemberFacts(MEMBER_ID, 10), ["Prefers morning reminders"]);
}

async function testPlannerOnboardsUnknownChoirMember(): Promise<void> {
  const identities = new InMemoryIdentityRepository();
  const planner = new ScriptedAgentPlanner((input) => {
    if (!input.context.actor) {
      return {
        kind: "tool",
        toolName: "onboard_current_sender",
        input: {},
        reason: "The unknown sender is speaking in the configured choir group.",
      };
    }
    assert.equal(input.context.actor.displayName, "New Singer");
    assert.equal(input.context.memberProfile?.preferredDisplayName, "New Singer");
    return { kind: "respond", message: "Welcome, New Singer.", reason: "Onboarding completed and context reloaded." };
  });
  const runtime = createRuntime(planner, null, { identities, dynamicContext: true });
  const message: IncomingMessage = {
    ...incomingMessage("onboard-1", "Hello Echo"),
    sender: {
      id: "300@s.whatsapp.net",
      displayName: "New Singer",
      identifiers: { participantPhoneJid: "300@s.whatsapp.net" },
    },
    metadata: { conversationKind: "choir" },
  };

  const first = await runtime.service.handleMessage(message);
  assert.equal(first?.text, "Welcome, New Singer.");
  assert.equal(identities.members.length, 1);
  assert.equal(identities.members[0].canonicalName, null);
  assert.deepEqual(identities.members[0].roles, ["member"]);

  await runtime.service.handleMessage({ ...message, id: "onboard-2" });
  assert.equal(identities.members.length, 1, "A repeated sender must not create a duplicate member.");
}

async function testOnboardingRejectsUntrustedConversation(): Promise<void> {
  const identities = new InMemoryIdentityRepository();
  const planner = new ScriptedAgentPlanner((input) => input.previousSteps.length === 0 ? ({
    kind: "tool",
    toolName: "onboard_current_sender",
    input: {},
    reason: "Exercise the trusted-conversation policy.",
  }) : ({
    kind: "respond",
    message: "I cannot register this sender here.",
    reason: "The backend denied onboarding outside the choir group.",
  }));
  const runtime = createRuntime(planner, null, { identities, dynamicContext: true });
  const reply = await runtime.service.handleMessage({
    ...incomingMessage("onboard-untrusted", "Hello"),
    sender: { id: "400@s.whatsapp.net", displayName: "Visitor", identifiers: { participantPhoneJid: "400@s.whatsapp.net" } },
    metadata: { conversationKind: "private" },
  });
  assert.equal(reply?.text, "I cannot register this sender here.");
  assert.equal(identities.members.length, 0);
}

async function testPlannerUpdatesPermanentMemberProfile(): Promise<void> {
  const identities = identityDirectory();
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.context.memberProfile?.preferredDisplayName !== "Mike") {
      return {
        kind: "tool",
        toolName: "update_own_member_profile",
        input: { preferredDisplayName: "Mike", aliases: ["Member"] },
        reason: "The current transport name differs from profile memory.",
      };
    }
    return { kind: "respond", message: "Good to hear from you, Mike.", reason: "The updated profile is available." };
  });
  const runtime = createRuntime(planner, memberIdentity(), { identities, dynamicContext: true });
  await runtime.memory.updateMemberProfile({
    memberId: MEMBER_ID,
    transport: "whatsapp",
    transportName: "Member",
    preferredDisplayName: "Member",
    aliases: [],
  });
  const reply = await runtime.service.handleMessage({
    ...incomingMessage("profile-update", "How are you?"),
    sender: { id: "200@s.whatsapp.net", displayName: "Mike", identifiers: { participantPhoneJid: "200@s.whatsapp.net" } },
    metadata: { conversationKind: "choir" },
  });
  assert.equal(reply?.text, "Good to hear from you, Mike.");
  const [profile] = await runtime.memory.getBlocks({ memberId: MEMBER_ID });
  assert.match(profile.value, /"preferredDisplayName":"Mike"/);
  assert.match(profile.value, /"Member"/);
}

async function testCasualAndQuotedConversation(): Promise<void> {
  const actor = memberIdentity();
  const planner = new ScriptedAgentPlanner((input) => ({
    kind: "respond",
    message: input.event.message?.quotedMessage?.text
      ? `You replied to: ${input.event.message.quotedMessage.text}`
      : "Hello from persistent Echo.",
    reason: "A direct conversational response is sufficient.",
  }));
  const { service, conversations } = createRuntime(planner, actor);
  const group = new GroupChatSimulator(CHAT_ID, (message) => service.handleMessage(message));

  const reply = await group.send({
    senderId: "200@s.whatsapp.net",
    senderName: "Member",
    text: "What do you think?",
    quotedMessageId: "quoted-1",
    quotedText: "Rehearsal was lovely today",
  });

  assert.equal(reply?.text, "You replied to: Rehearsal was lovely today");
  assert.deepEqual((await conversations.getRecent(CHAT_ID, 10)).map((entry) => entry.role), ["user", "assistant"]);
}

async function testMentionTool(): Promise<void> {
  const identities = identityDirectory();
  const planner = new ScriptedAgentPlanner(() => ({
    kind: "tool",
    toolName: "compose_member_message",
    input: { text: "@Member rehearsal starts at 5pm.", memberNames: ["Member"] },
    reason: "The message must contain a verified WhatsApp mention.",
  }));
  const runtime = createRuntime(planner, memberIdentity(), { identities });
  const message = incomingMessage("mention-1", "Please tag me");
  const reply = await runtime.service.handleMessage(message);

  assert.equal(reply?.mentions?.[0], "200@s.whatsapp.net");
  assert.match(reply?.text ?? "", /@Member/);
  assert.doesNotMatch(reply?.text ?? "", /@@Member/);
}

async function testPermissionGate(): Promise<void> {
  const identities = identityDirectory();
  const journal = new InMemoryAgentJournal();
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) {
      return {
        kind: "tool",
        toolName: "activate_capability",
        input: { capability: "administration" },
        reason: "Expose the protected administrative tool for policy testing.",
      };
    }
    if (input.previousSteps.length === 1) {
      return {
        kind: "tool",
        toolName: "add_member_identifier",
        input: { memberId: MEMBER_ID, kind: "alias", value: "New alias", confirmed: true },
        reason: "Attempt a protected write.",
      };
    }
    return { kind: "respond", message: "That change is not authorized.", reason: "The policy gate denied it." };
  });
  const runtime = createRuntime(planner, memberIdentity(), { identities, journal });
  const reply = await runtime.service.handleMessage(incomingMessage("permission-1", "Add this alias"));

  assert.equal(reply?.text, "That change is not authorized.");
  assert.equal(journal.executions.at(-1)?.status, "denied");
  assert.equal((await identities.resolveByName("New alias")).length, 0);
}

async function testDurableCreatorApproval(): Promise<void> {
  const identities = identityDirectory();
  const creator = (await identities.resolveSender({
    id: "100@s.whatsapp.net",
    identifiers: { participantPhoneJid: "100@s.whatsapp.net" },
  }))!;
  const planner = new ScriptedAgentPlanner(() => ({
    kind: "tool",
    toolName: "add_member_identifier",
    input: { memberId: MEMBER_ID, kind: "alias", value: "Choir friend", confirmed: false },
    reason: "The creator requested a private identity update.",
  }));
  const runtime = createRuntime(planner, creator, { identities });
  const request: IncomingMessage = {
    ...incomingMessage("approval-request", "Add Choir friend as an alias"),
    sender: {
      id: "100@s.whatsapp.net",
      displayName: "Creator",
      identifiers: { participantPhoneJid: "100@s.whatsapp.net" },
    },
  };
  const proposed = await runtime.service.handleMessage(request);
  const approval = proposed?.metadata?.agentApproval as { approvalId: string } | undefined;
  assert.ok(approval?.approvalId);
  await runtime.service.registerApprovalMessage(approval!.approvalId, "echo-approval-message");

  const hijack = await runtime.service.handleMessage({
    ...incomingMessage("approval-hijack", "YES"),
    repliedToAgent: true,
    quotedMessage: { id: "echo-approval-message", authorId: "echo@s.whatsapp.net", text: proposed!.text },
  });
  assert.equal(hijack?.text, "Only the person who requested this change can confirm it.");
  assert.equal((await identities.resolveByName("Choir friend")).length, 0);

  const confirmation: IncomingMessage = {
    ...request,
    id: "approval-confirmation",
    text: "YES",
    repliedToAgent: true,
    quotedMessage: { id: "echo-approval-message", authorId: "echo@s.whatsapp.net", text: proposed!.text },
  };
  const confirmed = await runtime.service.handleMessage(confirmation);
  assert.equal(confirmed?.text, "Confirmed. The change has been applied.");
  assert.equal((await identities.resolveByName("Choir friend"))[0]?.id, MEMBER_ID);
  assert.deepEqual(
    (await runtime.conversations.getRecent(CHAT_ID, 10)).slice(-2).map((entry) => entry.role),
    ["user", "assistant"],
  );
}

async function testSchedulerSemanticSkip(): Promise<void> {
  const identities = identityDirectory();
  const weeklyInterpretations = new InMemoryWeeklyInterpretationRepository();
  const workflows = workflowStub();
  const rotaReminder = new RotaReminderService(
    {
      async retrieve() {
        return {
          context: `Structured evidence: ${JSON.stringify({
            august: [{
              WEEK_START: "2026-08-10",
              CONTENT: "Sunday 16/08/2026\n- Worship & praise: Member",
            }],
          })}\n\nSemantic evidence: Mother's Day service. The choir is not ministering.`,
          sourceHash: "semantic-skip-source",
          provenance: retrievalProvenance("complete"),
        };
      },
    },
    weeklyInterpretations,
    identities,
    successfulSyncCoordinator(),
    {
      async assess() {
        return {
          sundayActivityCancelled: true,
          setlistRequired: false,
          summary: "The choir is not participating in the target service.",
          ambiguities: [],
        };
      },
    },
  );
  const planner = new ScriptedAgentPlanner((input) => input.previousSteps.length === 0 ? ({
    kind: "tool",
    toolName: "prepare_setlist_nudge",
    input: {},
    reason: "Evaluate the scheduled nudge in one operation.",
  }) : ({ kind: "respond", message: "", reason: "The compound tool found the nudge inapplicable." }));
  const transport = new FakeAgentTransport();
  const delivery = new ChoirDeliveryObserver(workflows);
  const obligations = new InMemoryObligationRepository();
  const runtime = createRuntime(planner, null, {
    identities,
    transport,
    workflows,
    weeklyInterpretations,
    obligations,
    setlistOperations: new SetlistOperationsService(rotaReminder, workflows, identities, obligations),
    scheduledMessagePolicy: delivery,
  });

  const result = await runtime.service.handleScheduledWake({
    eventKey: "scheduler:test-special-week",
    type: "setlist_followup_due",
    chatId: CHAT_ID,
    payload: { weekStart: "2026-08-10" },
  });

  assert.equal(result.status, "completed");
  assert.equal(transport.sent.length, 0);
  assert.equal(result.steps[0]?.decision.kind === "tool" ? result.steps[0].decision.toolName : "", "prepare_setlist_nudge");
}

async function testCachedWeeklyInterpretationOmitsBulkyEvidence(): Promise<void> {
  const weeklyInterpretations = new InMemoryWeeklyInterpretationRepository();
  await weeklyInterpretations.save(applicableWeeklyInterpretation());
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "read_week_schedule",
      input: { weekStart: "2026-08-10" },
      reason: "Read the source-matched week.",
    };
    const data = input.previousSteps[0].result?.data as Record<string, unknown>;
    assert.equal("scheduleContext" in data, false);
    assert.ok(data.cachedInterpretation);
    return { kind: "respond", message: "Cached week loaded.", reason: "The interpretation matches current evidence." };
  });
  const runtime = createRuntime(planner, null, {
    weeklyInterpretations,
    knowledgeContext: "Current choir information",
  });
  const result = await runtime.service.handleScheduledWake({
    eventKey: "scheduler:cached-week-compact",
    type: "setlist_weekly_planning_due",
    chatId: CHAT_ID,
    payload: { weekStart: "2026-08-10", allowUntargetedMessage: true },
  });
  assert.equal(result.status, "completed");
}

async function testWeeklySchedulePreservesCompleteEvidence(): Promise<void> {
  const marker = "WEEKLY_EVIDENCE_TAIL";
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "read_week_schedule",
      input: { weekStart: "2026-08-10" },
      reason: "Load the complete weekly evidence.",
    };
    const data = input.previousSteps[0]?.result?.data as { scheduleContext?: string };
    assert.equal(data.scheduleContext?.endsWith(marker), true);
    return { kind: "respond", message: "Complete week loaded.", reason: "The tail record is present." };
  });
  const runtime = createRuntime(planner, null, {
    knowledgeContext: `${"x".repeat(10_000)}${marker}`,
  });

  const result = await runtime.service.handleScheduledWake({
    eventKey: "scheduler:complete-week-evidence",
    type: "setlist_weekly_planning_due",
    chatId: CHAT_ID,
    payload: { weekStart: "2026-08-10", allowUntargetedMessage: true },
  });

  assert.equal(result.status, "completed");
}

async function testRotaAssessmentPreservesCompleteEvidence(): Promise<void> {
  const marker = "ROTA_ASSESSMENT_TAIL";
  let serializedInput = "";
  const model = {
    withStructuredOutput() {
      return {
        async invoke(messages: Array<{ content: unknown }>) {
          serializedInput = String(messages.at(-1)?.content ?? "");
          return {
            sundayActivityCancelled: false,
            setlistRequired: true,
            summary: "The dated Sunday activity is present.",
            ambiguities: [],
          };
        },
      };
    },
    role: "planner",
    modelName: "test-model",
  } as unknown as ConfiguredChatModel;
  const assessor = new ModelWeeklyScheduleAssessor(model);

  await assessor.assess({
    weekStart: "2026-08-10",
    weekEnd: "2026-08-16",
    evidence: `${"x".repeat(13_000)}${marker}`,
    signal: new AbortController().signal,
  });

  const payload = JSON.parse(serializedInput) as { evidence?: string };
  assert.equal(payload.evidence?.endsWith(marker), true);
}

async function testSchedulerTargetedDelivery(): Promise<void> {
  const identities = identityDirectory();
  const weeklyInterpretations = new InMemoryWeeklyInterpretationRepository();
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "prepare_setlist_nudge",
      input: {},
      reason: "Prepare the scheduled setlist nudge in one validated operation.",
    };
    return { kind: "respond", message: "", reason: "The compound nudge tool completed." };
  });
  const transport = new FakeAgentTransport();
  const workflows = workflowStub();
  const obligations = new InMemoryObligationRepository();
  const rotaReminder = new RotaReminderService(
    {
      async retrieve() {
        return {
          context: `Structured evidence: ${JSON.stringify({
            august: [{
              WEEK_START: "2026-08-10",
              CONTENT: "Wednesday 12/08/2026\n- Bible study P&W: Member\nSunday 16/08/2026\n- Worship & praise: Member",
            }],
          })}\n\nSemantic evidence: None`,
          sourceHash: "compound-setlist-nudge-source",
          provenance: retrievalProvenance("complete"),
        };
      },
    },
    weeklyInterpretations,
    identities,
    successfulSyncCoordinator(),
    {
      async assess() {
        return {
          sundayActivityCancelled: false,
          setlistRequired: true,
          summary: "The choir and setlist are required this week.",
          ambiguities: [],
        };
      },
    },
  );
  const setlistOperations = new SetlistOperationsService(rotaReminder, workflows, identities, obligations);
  const delivery = new ChoirDeliveryObserver(workflows);
  const runtime = createRuntime(planner, null, {
    identities,
    transport,
    workflows,
    obligations,
    weeklyInterpretations,
    setlistOperations,
    scheduledMessagePolicy: delivery,
  });

  await runtime.service.handleScheduledWake({
    eventKey: "scheduler:test-targeted",
    type: "setlist_followup_due",
    chatId: CHAT_ID,
    payload: { weekStart: "2026-08-10" },
  });

  assert.equal(transport.sent.length, 1);
  assert.deepEqual(transport.sent[0].reply.mentions, ["200@s.whatsapp.net"]);
  assert.equal(runtime.journal.executions.filter((execution) => execution.toolName === "prepare_setlist_nudge").length, 1);
  assert.equal(runtime.journal.executions.some((execution) => execution.toolName === "read_week_schedule"), false);
  assert.equal(runtime.journal.executions.some((execution) => execution.toolName === "compose_member_message"), false);
}

async function testScheduledDeliveryRequiresGatedTool(): Promise<void> {
  const planner = new ScriptedAgentPlanner(() => ({
    kind: "respond",
    message: "This reply skipped the weekly evidence tools.",
    reason: "Deliberately exercise delivery policy.",
  }));
  const transport = new FakeAgentTransport();
  const workflows = workflowStub();
  const delivery = new ChoirDeliveryObserver(workflows);
  const runtime = createRuntime(planner, null, { transport, workflows, scheduledMessagePolicy: delivery });

  await runtime.service.handleScheduledWake({
    eventKey: "scheduler:ungated",
    type: "weekly_rota_reminder_due",
    chatId: CHAT_ID,
    payload: { weekStart: "2026-08-10", allowUntargetedMessage: true },
  });

  assert.equal(transport.sent.length, 0);
}

async function testCompoundSetlistBroadcast(): Promise<void> {
  const identities = identityDirectory();
  const weeklyInterpretations = new InMemoryWeeklyInterpretationRepository();
  const obligations = new InMemoryObligationRepository();
  let deliveredSubmissionId = "";
  const workflows: ChoirWorkflowService = {
    ...workflowStub(),
    async getSetlistBroadcast(submissionId) {
      return submissionId === "33333333-3333-4333-8333-333333333333"
        ? { id: submissionId, chatId: CHAT_ID, weekStart: "2026-08-10", content: "1. Great Is Thy Faithfulness" }
        : null;
    },
    async markSetlistBroadcastSent(submissionId) {
      deliveredSubmissionId = submissionId;
    },
  };
  const rotaReminder = new RotaReminderService(
    {
      async retrieve() {
        return {
          context: `Structured evidence: ${JSON.stringify({
            august: [{
              WEEK_START: "2026-08-10",
              CONTENT: "Sunday 16/08/2026\n- Worship & praise: Member",
            }],
          })}\n\nSemantic evidence: None`,
          sourceHash: "compound-broadcast-source",
          provenance: retrievalProvenance("complete"),
        };
      },
    },
    weeklyInterpretations,
    identities,
    successfulSyncCoordinator(),
    {
      async assess() {
        return {
          sundayActivityCancelled: false,
          setlistRequired: true,
          summary: "The choir is participating this week.",
          ambiguities: [],
        };
      },
    },
  );
  const planner = new ScriptedAgentPlanner((input) => input.previousSteps.length === 0 ? ({
    kind: "tool",
    toolName: "prepare_setlist_broadcast",
    input: {},
    reason: "Prepare the scheduled broadcast in one validated operation.",
  }) : ({ kind: "respond", message: "", reason: "The broadcast tool completed." }));
  const transport = new FakeAgentTransport();
  const delivery = new ChoirDeliveryObserver(workflows);
  const runtime = createRuntime(planner, null, {
    identities,
    transport,
    workflows,
    obligations,
    weeklyInterpretations,
    setlistOperations: new SetlistOperationsService(rotaReminder, workflows, identities, obligations),
    scheduledMessagePolicy: delivery,
    deliveryObserver: delivery,
  });

  await runtime.service.handleScheduledWake({
    eventKey: "scheduler:test-compound-broadcast",
    type: "setlist_broadcast_due",
    chatId: CHAT_ID,
    payload: {
      weekStart: "2026-08-10",
      submissionId: "33333333-3333-4333-8333-333333333333",
      allowUntargetedMessage: true,
    },
  });

  assert.equal(transport.sent.length, 1);
  assert.match(transport.sent[0].reply.text, /Great Is Thy Faithfulness/);
  assert.equal(deliveredSubmissionId, "33333333-3333-4333-8333-333333333333");
  assert.equal(runtime.journal.executions.filter((execution) => execution.toolName === "prepare_setlist_broadcast").length, 1);
  assert.equal(runtime.journal.executions.some((execution) => execution.toolName === "read_week_schedule"), false);
}

async function testChoirScheduleActivationPersistsObligation(): Promise<void> {
  const planner = new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "No message is applicable." }));
  const obligations = new InMemoryObligationRepository();
  const scheduler = new InMemorySchedulerPort();
  const workflows = workflowStub();
  const delivery = new ChoirDeliveryObserver(workflows);
  const runtime = createRuntime(planner, null, {
    obligations,
    workflows,
    scheduledMessagePolicy: delivery,
  });
  const obligationScheduler = new AgentObligationScheduler(obligations, runtime.service, scheduler);
  const scheduleService = new ChoirScheduleService(
    scheduler,
    obligations,
    obligationScheduler,
    runtime.service,
    workflows,
    runtime.memory,
    CHAT_ID,
  );

  await scheduleService.start();
  assert.equal(scheduler.weekly.size, 4);
  await scheduler.run("choir-sunday-rota-activation");

  const obligation = obligations.obligations.find((candidate) => candidate.type === "weekly_rota_reminder_due");
  assert.ok(obligation);
  assert.equal(obligation?.status, "not_applicable");
}

async function testCreatorCanTriggerSundayReminderPrivately(): Promise<void> {
  const transport = new FakeAgentTransport();
  const obligations = new InMemoryObligationRepository();
  const identities = identityDirectory();
  const weeklyInterpretations = new InMemoryWeeklyInterpretationRepository();
  const rotaReminder = new RotaReminderService(
    {
      async retrieve() {
        return {
          context: `Structured evidence: ${JSON.stringify({
            august: [{
              WEEK_START: "2026-08-10",
              CONTENT: "Wednesday 12/08/2026\n- Bible study P&W: Member\nSunday 16/08/2026\n- Worship & praise: Member",
            }],
          })}\n\nSemantic evidence: None`,
          sourceHash: "manual-sunday-source",
          provenance: retrievalProvenance("complete"),
        };
      },
    },
    weeklyInterpretations,
    identities,
    successfulSyncCoordinator(),
    {
      async assess() {
        return {
          sundayActivityCancelled: false,
          setlistRequired: true,
          summary: "The choir has assignments for the target week.",
          ambiguities: [],
        };
      },
    },
  );
  const runtime = createRuntime(
    new ScriptedAgentPlanner((input) => {
      assert.equal(input.event.type, "weekly_rota_reminder_due");
      assert.equal(input.event.payload.weekStart, "2026-08-10");
      assert.equal(input.event.payload.manuallyActivated, true);
      return {
        kind: "tool",
        toolName: "prepare_sunday_rota_reminder",
        input: {},
        reason: "Prepare the manually activated Sunday reminder.",
      };
    }),
    null,
    { transport, obligations, identities, weeklyInterpretations, rotaReminder },
  );
  const scheduleService = new ChoirScheduleService(
    new InMemorySchedulerPort(),
    obligations,
    new AgentObligationScheduler(obligations, runtime.service, new InMemorySchedulerPort()),
    runtime.service,
    workflowStub(),
    runtime.memory,
    CHAT_ID,
  );
  const router = new MessageRouter(runtime.service, successfulSyncCoordinator(), identities, scheduleService);

  const reply = await router.handle({
    ...incomingMessage("manual-sunday-command", "send sunday reminder"),
    conversationId: "100@s.whatsapp.net",
    sender: {
      id: "100@s.whatsapp.net",
      displayName: "Creator",
      identifiers: { whatsappJid: "100@s.whatsapp.net" },
    },
    mentions: [],
    mentionedAgent: false,
    metadata: { conversationKind: "private" },
  });

  assert.equal(reply?.text, "Sunday reminder sent to the choir group.");
  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].chatId, CHAT_ID);
  assert.match(transport.sent[0].reply.text, /Choir Rota - Sunday, 16 August 2026/);
  assert.match(transport.sent[0].reply.text, /Worship & praise: @Member/);
  assert.match(obligations.obligations[0].naturalKey, /^manual-weekly-rota:/);
}

async function testStartupBackfillsMissedSetlistPlanning(): Promise<void> {
  clockService.setMockTime("2026-08-17 10:00");
  try {
    const obligations = new InMemoryObligationRepository();
    const scheduler = new InMemorySchedulerPort();
    const runtime = createRuntime(
      new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "Planning is not executed in this assertion." })),
      null,
      { obligations },
    );
    const service = new ChoirScheduleService(
      scheduler,
      obligations,
      new AgentObligationScheduler(obligations, runtime.service, scheduler),
      runtime.service,
      workflowStub(),
      runtime.memory,
      CHAT_ID,
    );

    await service.start();
    await service.start();

    const planning = obligations.obligations.filter((obligation) =>
      obligation.type === "setlist_weekly_planning_due" && obligation.weekStart === "2026-08-17"
    );
    assert.equal(planning.length, 1);
    assert.equal(planning[0].payload.startupRecovery, true);
    assert.equal(scheduler.oneTime.has(`agent-obligation-${planning[0].id}`), true);
  } finally {
    clockService.setMockTime("2026-08-11 10:00");
  }
}

async function testStartupDoesNotDuplicateExistingSetlistNudges(): Promise<void> {
  clockService.setMockTime("2026-08-17 10:00");
  try {
    const obligations = new InMemoryObligationRepository();
    await obligations.upsert({
      naturalKey: "setlist-followup:2026-08-17:1",
      type: "setlist_followup_due",
      chatId: CHAT_ID,
      weekStart: "2026-08-17",
      assignedMemberIds: [],
      status: "pending",
      dueAt: "2026-08-18T12:00:00.000+01:00",
      payload: { weekStart: "2026-08-17" },
      lastEvaluatedAt: clockService.now().toISO()!,
    });
    const scheduler = new InMemorySchedulerPort();
    const runtime = createRuntime(
      new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "No planning is required." })),
      null,
      { obligations },
    );
    const service = new ChoirScheduleService(
      scheduler,
      obligations,
      new AgentObligationScheduler(obligations, runtime.service, scheduler),
      runtime.service,
      workflowStub(),
      runtime.memory,
      CHAT_ID,
    );

    await service.start();

    assert.equal(obligations.obligations.some((obligation) => obligation.type === "setlist_weekly_planning_due"), false);
    assert.equal(scheduler.oneTime.size, 1, "only the existing follow-up should be recovered");
  } finally {
    clockService.setMockTime("2026-08-11 10:00");
  }
}

async function testStartupSkipsLastFridayWeekSetlistPlanning(): Promise<void> {
  clockService.setMockTime("2026-08-24 10:00");
  try {
    const obligations = new InMemoryObligationRepository();
    const scheduler = new InMemorySchedulerPort();
    const runtime = createRuntime(
      new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "No planning is required." })),
      null,
      { obligations },
    );
    const service = new ChoirScheduleService(
      scheduler,
      obligations,
      new AgentObligationScheduler(obligations, runtime.service, scheduler),
      runtime.service,
      workflowStub(),
      runtime.memory,
      CHAT_ID,
    );

    await service.start();

    assert.equal(obligations.obligations.some((obligation) => obligation.type === "setlist_weekly_planning_due"), false);
  } finally {
    clockService.setMockTime("2026-08-11 10:00");
  }
}

async function testMemberCannotTriggerSundayReminder(): Promise<void> {
  const transport = new FakeAgentTransport();
  const identities = identityDirectory();
  const runtime = createRuntime(
    new ScriptedAgentPlanner(() => ({ kind: "respond", message: "Should not run.", reason: "Unexpected." })),
    null,
    { transport, identities },
  );
  let activations = 0;
  const router = new MessageRouter(runtime.service, successfulSyncCoordinator(), identities, {
    async triggerSundayReminder() {
      activations += 1;
      return { delivered: true, reason: "delivered" };
    },
  });

  const reply = await router.handle({
    ...incomingMessage("member-manual-sunday", "send sunday reminder"),
    conversationId: "200@s.whatsapp.net",
    mentions: [],
    mentionedAgent: false,
    metadata: { conversationKind: "private" },
  });

  assert.equal(reply?.text, "Only a creator can send the Sunday reminder manually.");
  assert.equal(activations, 0);
  assert.equal(transport.sent.length, 0);
}

async function testSundaySetlistPlanningTargetsUpcomingWeek(): Promise<void> {
  clockService.setMockTime("2026-08-16 19:00");
  try {
    const obligations = new InMemoryObligationRepository();
    const scheduler = new InMemorySchedulerPort();
    const workflows = workflowStub();
    const runtime = createRuntime(
      new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "No message is required." })),
      null,
      { obligations, workflows },
    );
    const service = new ChoirScheduleService(
      scheduler,
      obligations,
      new AgentObligationScheduler(obligations, runtime.service, scheduler),
      runtime.service,
      workflows,
      runtime.memory,
      CHAT_ID,
    );

    await service.start();
    await scheduler.run("choir-setlist-planning-activation");

    const obligation = obligations.obligations.find((candidate) => candidate.type === "setlist_weekly_planning_due");
    assert.equal(obligation?.weekStart, "2026-08-17");
  } finally {
    clockService.setMockTime("2026-08-11 10:00");
  }
}

async function testPartialOptionalCoverageDoesNotExposeSync(): Promise<void> {
  let syncWasExposed = false;
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "read_week_schedule",
      input: { weekStart: "2026-08-17" },
      reason: "Read current weekly evidence.",
    };
    syncWasExposed = input.toolCatalog.some((tool) => tool.name === "sync_if_stale");
    return { kind: "respond", message: "", reason: "The returned rota evidence is usable." };
  });
  const runtime = createRuntime(planner, null, {
    knowledgeResult: {
      context: "Sunday 23 August\nWorkers prayer worship: Leader Alpha\nWednesday Bible study: Leader Beta",
      sourceHash: "partial-but-usable",
      provenance: retrievalProvenance("partial", ["annual_events"]),
    },
  });

  await runtime.service.handleScheduledWake({
    eventKey: "scheduler:partial-optional-coverage",
    type: "setlist_weekly_planning_due",
    chatId: CHAT_ID,
    payload: { weekStart: "2026-08-17" },
  });

  assert.equal(syncWasExposed, false);
}

async function testSkippedSyncDoesNotPermitRepeatedRetrieval(): Promise<void> {
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "read_week_schedule",
      input: { weekStart: "2026-08-17" },
      reason: "Read current weekly evidence.",
    };
    if (input.previousSteps.length === 1) return {
      kind: "tool",
      toolName: "sync_if_stale",
      input: { reason: "Evidence is materially sparse.", force: false },
      reason: "Attempt one freshness recovery.",
    };
    if (input.previousSteps.length === 2) return {
      kind: "tool",
      toolName: "read_week_schedule",
      input: { weekStart: "2026-08-17" },
      reason: "Attempt to repeat the same read after a skipped sync.",
    };
    return { kind: "respond", message: "", reason: "Use the evidence already available." };
  });
  const runtime = createRuntime(planner, null, { knowledgeContext: "Sparse" });

  const result = await runtime.executor.execute({
    eventKey: "scheduler:skipped-sync-retry",
    source: "scheduler",
    type: "setlist_weekly_planning_due",
    chatId: CHAT_ID,
    payload: { weekStart: "2026-08-17" },
  });

  assert.equal(result.status, "completed");
  assert.equal(result.steps[2]?.result?.error, "repeated_tool_call");
}

async function testValidatedNextToolAvoidsPlannerRoundTrip(): Promise<void> {
  let plannerCalls = 0;
  const activityEvents: AgentActivityEvent[] = [];
  const planner = new ScriptedAgentPlanner((input) => {
    plannerCalls += 1;
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "get_current_time",
      input: { timezone: "Europe/London" },
      reason: "Read London time.",
      nextTool: {
        toolName: "get_current_time",
        input: { timezone: "UTC" },
        reason: "Read UTC using arguments already known from the request.",
      },
    };
    return { kind: "respond", message: "Times loaded.", reason: "Both reads completed." };
  });
  const runtime = createRuntime(planner, memberIdentity(), {
    activity: { publish(event) { activityEvents.push(event); } },
  });

  const result = await runtime.executor.execute({
    eventKey: "system:validated-next-tool",
    source: "system",
    type: "test",
    payload: {},
  });

  assert.equal(result.status, "completed");
  assert.equal(result.steps.filter((step) => step.decision.kind === "tool").length, 2);
  assert.equal(plannerCalls, 2);
  assert.ok(activityEvents.some((event) => event.title === "Continuing planned action"));
  assert.ok(activityEvents.some((event) => event.title === "Planned action ready"));
}

async function testAtomicToolCompletesWithoutReplanning(): Promise<void> {
  let plannerCalls = 0;
  const planner = new ScriptedAgentPlanner(() => {
    plannerCalls += 1;
    return {
      kind: "tool",
      toolName: "complete_test_operation",
      input: {},
      reason: "Run the complete background operation.",
    };
  });
  const runtime = createRuntime(planner, memberIdentity());
  runtime.tools.register({
    name: "complete_test_operation",
    description: "Complete one deterministic test operation.",
    capability: "conversation",
    schema: z.object({}),
    sideEffect: "write",
    async execute() {
      return {
        status: "success",
        summary: "The operation completed without a chat message.",
        turnControl: "complete",
      };
    },
  });

  const result = await runtime.executor.execute({
    eventKey: "system:complete-tool",
    source: "system",
    type: "test",
    payload: {},
  });

  assert.equal(result.status, "completed");
  assert.equal(result.reply, null);
  assert.equal(result.steps.length, 1);
  assert.equal(plannerCalls, 1, "A terminal tool result must not pay for a completion planning call.");
}

async function testNonTerminalToolPreservesAgenticLoop(): Promise<void> {
  let plannerCalls = 0;
  const planner = new ScriptedAgentPlanner((input) => {
    plannerCalls += 1;
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "get_current_time",
      input: { timezone: "Europe/London" },
      reason: "Current time is needed before answering.",
    };
    return { kind: "respond", message: "Time loaded.", reason: "The evidence is now sufficient." };
  });
  const runtime = createRuntime(planner, memberIdentity());

  const result = await runtime.executor.execute(transportEvent("agentic-loop-preserved", "What time is it?"));

  assert.equal(result.status, "completed");
  assert.equal(result.reply?.text, "Time loaded.");
  assert.equal(plannerCalls, 2, "Non-terminal evidence must return control to the planner.");
}

async function testDuplicateNextToolIsDiscarded(): Promise<void> {
  let plannerCalls = 0;
  const planner = new ScriptedAgentPlanner((input) => {
    plannerCalls += 1;
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "get_current_time",
      input: { timezone: "Europe/London" },
      reason: "Read the clock once.",
      nextTool: {
        toolName: "get_current_time",
        input: { timezone: "Europe/London" },
        reason: "Accidental duplicate continuation.",
      },
    };
    return { kind: "respond", message: "Done.", reason: "Use the existing clock result." };
  });
  const runtime = createRuntime(planner, memberIdentity());

  const result = await runtime.executor.execute(transportEvent("duplicate-next-tool", "What time is it?"));

  assert.equal(result.status, "completed");
  assert.equal(plannerCalls, 2);
  assert.equal(result.steps.some((step) => step.result?.error === "repeated_tool_call"), false);
}

async function testInvalidNextToolIsDiscarded(): Promise<void> {
  let plannerCalls = 0;
  const planner = new ScriptedAgentPlanner((input) => {
    plannerCalls += 1;
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "get_current_time",
      input: { timezone: "Europe/London" },
      reason: "Read the clock.",
      nextTool: {
        toolName: "compose_member_message",
        input: { text: "<use the previous result>", memberNames: [] },
        reason: "Incomplete continuation that depends on unseen output.",
      },
    };
    return { kind: "respond", message: "Done.", reason: "Use the completed tool result." };
  });
  const runtime = createRuntime(planner, memberIdentity());

  const result = await runtime.executor.execute(transportEvent("invalid-next-tool", "What time is it?"));

  assert.equal(result.status, "completed");
  assert.equal(plannerCalls, 2);
  assert.equal(result.steps.some((step) => step.decision.kind === "tool" && step.decision.toolName === "compose_member_message"), false);
}

async function testSetlistPlanningCreatesRecoverableObligations(): Promise<void> {
  const weekStart = "2026-08-17";
  const sourceHash = "1234567890abcdef";
  const weeklyInterpretations = new InMemoryWeeklyInterpretationRepository();
  await weeklyInterpretations.save(applicableWeeklyInterpretation(weekStart, sourceHash));
  const obligations = new InMemoryObligationRepository();
  const scheduler = new InMemorySchedulerPort();
  const workflows = workflowStub();
  const identities = identityDirectory();
  const rotaReminder = new RotaReminderService(
    {
      async retrieve() {
        return {
          context: `Structured evidence: ${JSON.stringify({
            august: [{
              WEEK_START: weekStart,
              CONTENT: "Sunday 23/08/2026\n- Worship & praise: Member",
            }],
          })}\n\nSemantic evidence: None`,
          sourceHash,
          provenance: retrievalProvenance("complete"),
        };
      },
    },
    weeklyInterpretations,
    identities,
    successfulSyncCoordinator(),
    { async assess() { throw new Error("The source-matched interpretation should be reused."); } },
  );
  const setlistOperations = new SetlistOperationsService(
    rotaReminder,
    workflows,
    identities,
    obligations,
    (obligation) => scheduler.scheduleOnce({
      id: `agent-obligation-${obligation.id}`,
      runAt: obligation.dueAt!,
      timezone: "Europe/London",
      category: "setlist_nudge",
      action: async () => {},
    }),
  );
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "plan_weekly_setlist_nudges",
      input: {},
      reason: "Plan the weekly setlist nudges in one validated operation.",
    };
    return { kind: "respond", message: "", reason: "Planning completed without a group message." };
  });
  const runtime = createRuntime(planner, null, {
    identities,
    obligations,
    workflows,
    weeklyInterpretations,
    setlistOperations,
  });

  await runtime.service.handleScheduledWake({
    eventKey: "scheduler:plan-setlists:2026-08-17",
    type: "setlist_weekly_planning_due",
    chatId: CHAT_ID,
    payload: { weekStart },
  });

  const followups = obligations.obligations.filter((item) => item.type === "setlist_followup_due");
  assert.equal(followups.length, 5);
  assert.equal(followups.every((item) => item.sourceHash === sourceHash), true);
  assert.equal(followups.every((item) => !("sourceHash" in item.payload)), true);
  assert.equal(scheduler.oneTime.size, 5);
  assert.equal(runtime.journal.executions.filter((execution) => execution.toolName === "plan_weekly_setlist_nudges").length, 1);
  assert.equal(runtime.journal.executions.some((execution) => execution.toolName === "read_week_schedule"), false);
}

async function testObligationRecoveryRebuildsTimers(): Promise<void> {
  const obligations = new InMemoryObligationRepository();
  const pending = await obligations.upsert({
    naturalKey: "recovery:test",
    type: "setlist_followup_due",
    chatId: CHAT_ID,
    weekStart: "2026-08-17",
    assignedMemberIds: [],
    status: "pending",
    dueAt: "2026-08-18T14:00:00.000+01:00",
    payload: { weekStart: "2026-08-17" },
  });
  const scheduler = new InMemorySchedulerPort();
  const runtime = createRuntime(
    new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "Recovery test." })),
    null,
    { obligations },
  );
  const recovery = new AgentObligationScheduler(obligations, runtime.service, scheduler);
  await recovery.recover();
  assert.ok(scheduler.oneTime.has(`agent-obligation-${pending.id}`));
}

async function testObligationRecoveryExpiresPastSetlistNudges(): Promise<void> {
  const obligations = new InMemoryObligationRepository();
  const expired = await obligations.upsert({
    naturalKey: "recovery:expired-setlist-nudge",
    type: "setlist_followup_due",
    chatId: CHAT_ID,
    weekStart: "2026-08-10",
    assignedMemberIds: [],
    status: "pending",
    dueAt: "2026-08-10T14:00:00.000+01:00",
    payload: { weekStart: "2026-08-10" },
  });
  const scheduler = new InMemorySchedulerPort();
  const runtime = createRuntime(
    new ScriptedAgentPlanner(() => ({ kind: "respond", message: "Should not run.", reason: "Expired." })),
    null,
    { obligations },
  );

  const recovery = new AgentObligationScheduler(obligations, runtime.service, scheduler);
  await recovery.recover();

  assert.equal(scheduler.oneTime.has(`agent-obligation-${expired.id}`), false);
  assert.equal(expired.status, "not_applicable");
  assert.equal(expired.payload.statusReason, "The setlist nudge date passed before startup recovery.");
}

async function testDuplicateEventRecovery(): Promise<void> {
  let plannerCalls = 0;
  const planner = new ScriptedAgentPlanner(() => {
    plannerCalls += 1;
    return { kind: "respond", message: "One response only.", reason: "No tool is needed." };
  });
  const runtime = createRuntime(planner, memberIdentity());
  const message = incomingMessage("duplicate-1", "Hello");

  const first = await runtime.service.handleMessage(message);
  const second = await runtime.service.handleMessage(message);

  assert.equal(first?.text, "One response only.");
  assert.equal(second, null, "A replayed transport event must not produce another delivery.");
  assert.equal(plannerCalls, 1);
}

async function testObligationRecoveryExpiresPastSetlistBroadcasts(): Promise<void> {
  const obligations = new InMemoryObligationRepository();
  const expired = await obligations.upsert({
    naturalKey: "setlist-broadcast:2026-08-10",
    type: "setlist_broadcast_due",
    chatId: CHAT_ID,
    weekStart: "2026-08-10",
    assignedMemberIds: [],
    status: "pending",
    dueAt: "2026-08-11T09:00:00.000+01:00",
    payload: { weekStart: "2026-08-10", submissionId: "submission-1" },
  });
  const scheduler = new InMemorySchedulerPort();
  const runtime = createRuntime(
    new ScriptedAgentPlanner(() => ({ kind: "respond", message: "Should not run.", reason: "Expired." })),
    null,
    { obligations },
  );

  const recovery = new AgentObligationScheduler(obligations, runtime.service, scheduler);
  await recovery.recover();

  assert.equal(scheduler.oneTime.has(`agent-obligation-${expired.id}`), false);
  assert.equal(expired.status, "not_applicable");
  assert.equal(expired.payload.statusReason, "The setlist broadcast time passed before startup recovery.");
}

async function testMaximumSteps(): Promise<void> {
  const planner = new ScriptedAgentPlanner(() => ({
    kind: "tool",
    toolName: "get_current_time",
    input: { timezone: "Europe/London" },
    reason: "Deliberately continue for the bounded-loop test.",
  }));
  const runtime = createRuntime(planner, memberIdentity(), { maxSteps: 2 });
  const result = await runtime.executor.execute({
    eventKey: "system:max-steps",
    source: "system",
    type: "test",
    payload: {},
  });

  assert.equal(result.status, "max_steps");
  assert.equal(result.steps.length, 2);
}

async function testDeterministicToolFailureIsNotRetryable(): Promise<void> {
  const tools = new AgentToolRegistry([{
    name: "broken_structured_tool",
    description: "Test deterministic provider schema failure.",
    capability: "conversation",
    schema: z.object({}),
    sideEffect: "read",
    async execute() {
      throw new Error("Zod field uses .optional() without .nullable() which is not supported by the API.");
    },
  }]);
  const event = transportEvent("deterministic-tool-error", "Test the tool");
  const context = contextFor(memberIdentity());
  const result = await tools.execute("broken_structured_tool", {}, {
    event,
    turnId: "66666666-6666-4666-8666-666666666666",
    step: 0,
    actor: context.actor,
    signal: new AbortController().signal,
  });
  const failedStep = {
    step: 0,
    decision: {
      kind: "tool" as const,
      toolName: "broken_structured_tool",
      input: {},
      reason: "Exercise deterministic failure handling.",
    },
    result,
  };

  assert.equal(result.retryable, false);
  assert.equal(tools.catalogFor(event, context, [failedStep]).some((tool) => tool.name === "broken_structured_tool"), false);
}

async function testInvalidToolInputCanBeReplanned(): Promise<void> {
  const tools = new AgentToolRegistry([{
    name: "bounded_read",
    description: "Test repairable model arguments.",
    capability: "conversation",
    schema: z.object({ limit: z.number().int().min(1).max(4) }),
    sideEffect: "read",
    async execute() { return { status: "success", summary: "Read completed." }; },
  }]);
  const event = transportEvent("repairable-tool-input", "Read everything");
  const context = contextFor(memberIdentity());
  const result = await tools.execute("bounded_read", { limit: 50 }, {
    event,
    turnId: "77777777-7777-4777-8777-777777777777",
    step: 0,
    actor: context.actor,
    signal: new AbortController().signal,
  });
  const failedStep = {
    step: 0,
    decision: {
      kind: "tool" as const,
      toolName: "bounded_read",
      input: { limit: 50 },
      reason: "Exercise repairable input validation.",
    },
    result,
  };

  assert.equal(result.retryable, true);
  assert.equal(result.nonFatal, true);
  assert.match(result.error ?? "", /less than or equal to 4/);
  assert.equal(tools.catalogFor(event, context, [failedStep]).some((tool) => tool.name === "bounded_read"), true);
}

async function testFailureLimitIsNotReportedAsStepLimit(): Promise<void> {
  const activityEvents: AgentActivityEvent[] = [];
  const planner = new ScriptedAgentPlanner(() => ({
    kind: "tool",
    toolName: "missing_tool",
    input: {},
    reason: "Deliberately request an unavailable tool.",
  }));
  const runtime = createRuntime(planner, memberIdentity(), {
    maxSteps: 10,
    activity: { publish(event) { activityEvents.push(event); } },
  });
  const result = await runtime.executor.execute(transportEvent("failure-limit-status", "Exercise failure safety"));

  assert.equal(result.status, "failed");
  assert.equal(result.error, "tool_not_available");
  assert.equal(result.steps.length, 2);
  assert.equal(activityEvents.at(-1)?.title, "Agent turn failed");
  assert.equal(activityEvents.some((event) => event.title === "Step limit reached"), false);
}

async function testAgentActivityLifecycle(): Promise<void> {
  const events: AgentActivityEvent[] = [];
  const activity: AgentActivitySink = { publish(event) { events.push(event); } };
  const planner = new ScriptedAgentPlanner((input) => input.previousSteps.length === 0 ? ({
    kind: "tool",
    toolName: "get_current_time",
    input: { timezone: "Europe/London" },
    reason: "Current time is required.",
    plan: ["Read the application clock", "Answer the member"],
  }) : ({
    kind: "respond",
    message: "The time is available.",
    reason: "The clock tool completed.",
    plan: [],
  }));
  const runtime = createRuntime(planner, memberIdentity(), { activity });

  await runtime.service.handleMessage(incomingMessage("activity-1", "What time is it?"));

  assert.ok(events.some((event) => event.phase === "context"));
  assert.ok(events.some((event) => event.phase === "planning" && event.plan?.length === 2));
  assert.ok(events.some((event) => event.phase === "tool" && event.status === "started" && event.tool?.name === "get_current_time"));
  assert.ok(events.some((event) => event.phase === "tool" && event.status === "completed"));
  assert.equal(events.at(-1)?.phase, "response");
}

async function testReadOnlyEvidenceUsesFastSynthesis(): Promise<void> {
  let primaryCalls = 0;
  let fastCalls = 0;
  const primary = new ScriptedAgentPlanner(() => {
    primaryCalls += 1;
    return { kind: "respond", message: "Primary", reason: "Primary path." };
  });
  const fast = new ScriptedAgentPlanner(() => {
    fastCalls += 1;
    return { kind: "respond", message: "Fast", reason: "Fast synthesis." };
  });
  const router = new RoutingAgentPlanner(primary, fast);
  const baseInput: AgentPlannerInput = {
    event: {
      eventKey: "routing:test",
      source: "transport",
      type: "message_received",
      chatId: CHAT_ID,
      message: incomingMessage("routing-message", "What is the schedule for the week?"),
      payload: {},
    },
    context: contextFor(memberIdentity()),
    maxSteps: 6,
    toolCatalog: [{
      name: "read_week_schedule",
      description: "Read schedule evidence.",
      inputSchema: "{}",
      sideEffect: "read",
      capability: "knowledge",
    }],
    availableCapabilities: [{
      id: "knowledge",
      description: "Read current choir data.",
      active: true,
      toolNames: ["read_week_schedule"],
    }],
    previousSteps: [],
  };

  await router.decide(baseInput, new AbortController().signal);
  assert.equal(fastCalls, 1, "Read-only planning should use the fast model without inspecting query keywords.");

  await router.decide({
    ...baseInput,
    previousSteps: [{
      step: 0,
      decision: { kind: "tool", toolName: "read_week_schedule", input: {}, reason: "Read evidence." },
      result: { status: "success", summary: "Evidence loaded." },
    }],
  }, new AbortController().signal);
  assert.equal(fastCalls, 2, "A non-mutating transport question should use fast synthesis after a successful read.");

  await router.decide({
    ...baseInput,
    previousSteps: [
      {
        step: 0,
        decision: { kind: "tool", toolName: "read_week_schedule", input: {}, reason: "Read evidence." },
        result: { status: "success", summary: "Evidence loaded." },
      },
      {
        step: 1,
        decision: { kind: "tool", toolName: "get_current_time", input: {}, reason: "Resolve the time boundary." },
        result: { status: "success", summary: "Time loaded." },
      },
    ],
  }, new AbortController().signal);
  assert.equal(fastCalls, 3, "A bounded two-read task should still use the fast model for synthesis.");

  await router.decide({
    ...baseInput,
    previousSteps: [
      {
        step: 0,
        decision: { kind: "tool", toolName: "read_week_schedule", input: {}, reason: "Read evidence." },
        result: { status: "success", summary: "Evidence loaded." },
      },
      {
        step: 1,
        decision: { kind: "tool", toolName: "get_current_time", input: {}, reason: "Resolve the time boundary." },
        result: { status: "success", summary: "Time loaded." },
      },
      {
        step: 2,
        decision: { kind: "tool", toolName: "read_week_schedule", input: { weekStart: "2026-08-10" }, reason: "Read another period." },
        result: { status: "success", summary: "Additional evidence loaded." },
      },
    ],
  }, new AbortController().signal);
  assert.equal(primaryCalls, 1, "Longer low-risk turns must not become an unbounded fast-model loop.");

  await router.decide({
    ...baseInput,
    event: {
      ...baseInput.event,
      message: incomingMessage("routing-reminder", "Remind me about rehearsal tomorrow"),
    },
    toolCatalog: [{
      name: "create_reminder",
      description: "Prepare a reminder.",
      inputSchema: "{}",
      sideEffect: "write",
      capability: "workflow",
    }],
    previousSteps: [{
      step: 0,
      decision: { kind: "tool", toolName: "read_week_schedule", input: {}, reason: "Read evidence." },
      result: { status: "success", summary: "Evidence loaded." },
    }],
  }, new AbortController().signal);
  assert.equal(primaryCalls, 2, "Mutating capabilities must use the primary model.");
}

async function testOperationalProtocolFailureUsesFastRecovery(): Promise<void> {
  let primaryCalls = 0;
  let recoveryCalls = 0;
  const primary = new ScriptedAgentPlanner(() => {
    primaryCalls += 1;
    throw new PlannerProtocolError("planner_returned_empty_required_tool_input");
  });
  const fast = new ScriptedAgentPlanner(() => {
    recoveryCalls += 1;
    return { kind: "respond", message: "Recovered.", reason: "A valid structured decision was produced." };
  });
  const router = new RoutingAgentPlanner(primary, fast);
  const input = plannerInput();
  input.event = { ...input.event, source: "scheduler", type: "weekly_rota_reminder_due", message: undefined };
  input.toolCatalog = [{
    name: "prepare_sunday_rota_reminder",
    description: "Prepare the weekly rota reminder.",
    inputSchema: '{"weekStart":"YYYY-MM-DD"}',
    sideEffect: "write",
    capability: "choir_operations",
  }];

  const decision = await router.decide(input, new AbortController().signal);

  assert.equal(primaryCalls, 1);
  assert.equal(recoveryCalls, 1);
  assert.equal(decision.kind, "respond");
}

async function testCompactContextLoadsDeeperStateOnDemand(): Promise<void> {
  const runtime = createRuntime(
    new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "Context test." })),
    memberIdentity(),
    { dynamicContext: true },
  );
  await runtime.memory.updateMemberProfile({
    memberId: MEMBER_ID,
    transport: "whatsapp",
    transportName: "Member",
    preferredDisplayName: "Member",
    aliases: [],
  });
  await runtime.memory.upsertBlock({
    scopeType: "chat",
    scopeId: CHAT_ID,
    label: "conversation_summary",
    description: "Compact durable chat summary.",
    value: "The choir previously discussed an August rehearsal.",
    characterLimit: 2_000,
    readOnly: false,
  });
  await runtime.memory.rememberMemberFact({
    memberId: MEMBER_ID,
    category: "preference",
    fact: "Prefers concise reminders",
    importance: "normal",
    verified: true,
  });
  for (let index = 0; index < 7; index += 1) {
    await runtime.conversations.append({
      chatId: CHAT_ID,
      role: "user",
      content: index === 1 ? "ExampleLeader discussed the August rehearsal" : `Conversation ${index}`,
      senderName: "Member",
    });
  }
  const event = transportEvent("context-on-demand", "What did ExampleLeader say?");
  const context = await runtime.contextAssembler.assemble(event);

  assert.equal(
    context.recentConversation.length,
    agentConfig.context.recentConversation.messageLimit,
  );
  assert.equal(context.memoryBlocks.length, 0);
  assert.equal(context.memberFacts.length, 0);
  assert.equal(context.activeObligations.length, 0);
  assert.equal(context.memberProfile, null);
  assert.ok(context.memoryDirectory.some((entry) => entry.label === "member_profile"));
  assert.ok(context.memoryDirectory.some((entry) => entry.label === "conversation_summary"));

  const executionContext = {
    event,
    turnId: "33333333-3333-4333-8333-333333333333",
    step: 0,
    actor: context.actor,
    signal: new AbortController().signal,
  };
  const history = await runtime.tools.execute("search_conversation_history", { query: "ExampleLeader August", limit: 5 }, executionContext);
  const facts = await runtime.tools.execute("read_member_memory", { query: "concise", limit: 5 }, executionContext);
  const acquired = await runtime.tools.execute("acquire_context", {
    requests: [
      { toolName: "search_conversation_history", input: { query: "ExampleLeader August", limit: 5 } },
      { toolName: "read_member_memory", input: { query: "concise", limit: 5 } },
    ],
  }, executionContext);
  assert.match(JSON.stringify(history.data), /August rehearsal/);
  assert.match(JSON.stringify(facts.data), /concise reminders/i);
  assert.equal(acquired.status, "success");
  assert.match(JSON.stringify(acquired.data), /August rehearsal/);
  assert.match(JSON.stringify(acquired.data), /concise reminders/i);
  const blockedWrite = await runtime.tools.execute("acquire_context", {
    requests: [{ toolName: "remember_member_fact", input: { fact: "Must not execute" } }],
  }, executionContext);
  assert.equal(blockedWrite.status, "error");
  assert.match(blockedWrite.error ?? "", /invalid enum value/i);
  assert.equal((await runtime.memory.getMemberFacts(MEMBER_ID, 10)).includes("Must not execute"), false);
}

async function testCapabilityCatalogActivation(): Promise<void> {
  const setlistOperations = {
    async planWeeklyNudges() { return { status: "ready", summary: "Planned.", planned: 0 }; },
    async prepareNudge() { return { status: "not_applicable", summary: "Not required." }; },
    async prepareBroadcast() { return { status: "not_applicable", summary: "Not required." }; },
  } as unknown as SetlistOperationsService;
  const runtime = createRuntime(
    new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "Capability test." })),
    memberIdentity(),
    { setlistOperations },
  );
  const advertisedToolFields: Record<string, string[]> = {
    inspect_agent_capabilities: [],
    onboard_current_sender: [],
    update_own_member_profile: ["aliases", "preferredDisplayName"],
    set_member_canonical_name: ["canonicalName", "confirmed", "memberId"],
    upsert_obligation: ["assignedMemberIds", "chatId", "dueAt", "naturalKey", "payload", "type", "weekStart"],
    plan_weekly_setlist_nudges: ["weekStart"],
    prepare_setlist_nudge: ["weekStart"],
    prepare_setlist_broadcast: ["submissionId", "weekStart"],
    get_current_time: ["timezone"],
    create_reminder: ["rawDatePhrase", "reminderMessage"],
    continue_reminder: ["action", "rawDatePhrase", "reminderMessage"],
    submit_setlist: ["scope"],
    create_scheduled_agent_task: ["objective", "rawSchedulePhrase"],
    list_scheduled_agent_tasks: [],
    manage_scheduled_agent_task: ["action", "objective", "rawSchedulePhrase", "taskId"],
    list_knowledge_sources: [],
    inspect_spreadsheet: ["sheetName"],
    query_spreadsheet: ["filters", "limit", "offset", "selectColumns", "sheetName"],
    retrieve_choir_knowledge: ["query", "semanticResultLimit", "semanticSearch", "sourceIds"],
    read_indexed_source: ["limit", "offset", "sourceId"],
    read_week_schedule: ["weekStart"],
    sync_if_stale: ["force", "reason"],
    resolve_members: ["names"],
    compose_member_message: ["memberNames", "text"],
    remember_member_fact: ["category", "fact", "importance", "memberId"],
    add_member_identifier: ["confirmed", "kind", "memberId", "value"],
    list_active_obligations: ["chatId"],
    search_conversation_history: ["limit", "query"],
    read_member_memory: ["limit", "memberId", "query"],
    read_context_memory: ["label", "scope", "weekStart"],
    update_obligation_status: ["obligationId", "reason", "status"],
    acquire_context: ["availableSources", "requests"],
    activate_capability: ["capability"],
  };
  const fullCatalog = runtime.tools.catalog();
  assert.equal(fullCatalog.length, Object.keys(advertisedToolFields).length);
  for (const tool of fullCatalog) {
    const advertisedInput = JSON.parse(tool.inputSchema) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(advertisedInput).sort(),
      advertisedToolFields[tool.name],
      `${tool.name} must advertise every top-level input field as valid JSON`,
    );
  }
  const event = transportEvent("capability-test", "Please perform a creator operation");
  const context = contextFor(memberIdentity());
  const initial = runtime.tools.catalogFor(event, context, []);
  assert.equal(initial.some((tool) => tool.name === "add_member_identifier"), false);
  assert.equal(initial.some((tool) => tool.name === "onboard_current_sender"), false);
  assert.equal(initial.some((tool) => tool.name === "activate_capability"), true);
  assert.equal(initial.some((tool) => tool.name === "acquire_context"), true);
  assert.match(
    initial.find((tool) => tool.name === "acquire_context")?.inputSchema ?? "",
    /Search durable messages from the current chat/,
  );
  assert.equal(initial.some((tool) => tool.name === "search_conversation_history"), false);
  assert.equal(
    runtime.tools.capabilitiesFor(event, context, []).some(
      (capability) => capability.toolNames.includes("search_conversation_history"),
    ),
    false,
    "internal context sources must only be advertised through acquire_context",
  );

  const casual = runtime.tools.catalogFor(transportEvent("capability-casual", "Hello Echo"), context, []);
  assert.equal(casual.some((tool) => tool.name === "retrieve_choir_knowledge"), true);
  const schedule = runtime.tools.catalogFor(transportEvent("capability-schedule", "What is this week's schedule?"), context, []);
  assert.equal(schedule.some((tool) => tool.name === "retrieve_choir_knowledge"), true);
  assert.equal(schedule.some((tool) => tool.name === "acquire_context"), true);
  const attendance = runtime.tools.catalogFor(
    transportEvent("capability-attendance", "Who will be attending Saturday rehearsals?"),
    context,
    [],
  );
  assert.equal(attendance.some((tool) => tool.name === "retrieve_choir_knowledge"), true);
  assert.equal(attendance.some((tool) => tool.name === "acquire_context"), true);
  const memoryRequest = runtime.tools.catalogFor(transportEvent("capability-memory", "What did I tell you last time?"), context, []);
  assert.equal(memoryRequest.some((tool) => tool.name === "acquire_context"), true);

  const incompleteReminder = runtime.tools.catalogFor(
    transportEvent("capability-incomplete-reminder", "Remind me about rehearsal"),
    context,
    [],
  );
  assert.equal(incompleteReminder.some((tool) => tool.name === "create_reminder"), true);
  for (const toolName of [
    "retrieve_choir_knowledge",
    "read_week_schedule",
    "sync_if_stale",
    "inspect_spreadsheet",
    "query_spreadsheet",
  ]) {
    assert.equal(
      incompleteReminder.some((tool) => tool.name === toolName),
      false,
      `${toolName} must not be available to fill missing reminder execution details`,
    );
  }

  const activated = runtime.tools.catalogFor(event, context, [{
    step: 0,
    decision: { kind: "tool", toolName: "activate_capability", input: { capability: "administration" }, reason: "Need admin tools." },
    result: { status: "success", summary: "Activated.", data: { activatedCapability: "administration" } },
  }]);
  assert.equal(activated.some((tool) => tool.name === "add_member_identifier"), true);

  const afterCataloguedEvidence = runtime.tools.catalogFor(
    transportEvent("catalogue-complete", "Who is unavailable?"),
    context,
    [{
    step: 0,
    decision: {
      kind: "tool",
      toolName: "retrieve_choir_knowledge",
      input: { query: "attendance", sourceIds: ["attendance"], semanticSearch: false },
      reason: "Read the catalogued attendance source.",
    },
    result: {
      status: "success",
      summary: "Attendance evidence retrieved.",
      data: { evidenceQuality: { status: "sparse" } },
    },
    }],
  );
  assert.equal(afterCataloguedEvidence.some((tool) => tool.name === "inspect_spreadsheet"), true);
  assert.equal(afterCataloguedEvidence.some((tool) => tool.name === "query_spreadsheet"), true);
  assert.equal(afterCataloguedEvidence.some((tool) => tool.name === "retrieve_choir_knowledge"), true);

  assert.equal(runtime.tools.activationForTool(event, context, [], "onboard_current_sender"), null);

  const redundantOnboarding = await runtime.tools.execute("onboard_current_sender", {}, {
    event,
    turnId: "44444444-4444-4444-8444-444444444444",
    step: 0,
    actor: context.actor,
    signal: new AbortController().signal,
  });
  assert.equal(redundantOnboarding.status, "denied");
  assert.equal(redundantOnboarding.error, "sender_already_resolved");

  const currentWeek = await runtime.tools.execute("read_week_schedule", {}, {
    event,
    turnId: "55555555-5555-4555-8555-555555555555",
    step: 0,
    actor: context.actor,
    signal: new AbortController().signal,
  });
  assert.equal((currentWeek.data as { weekStart: string }).weekStart, "2026-08-10");

  const staleEvidenceRuntime = createRuntime(
    new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "Not used." })),
    memberIdentity(),
    {
      knowledgeResult: {
        context: "Substantial schedule evidence for Sunday 16-August-26, outside the requested service week.",
        sourceHash: "stale-week-source",
        provenance: {
          ...retrievalProvenance("partial", ["annual_events"]),
          temporalCoverage: "unmatched",
        },
      },
    },
  );
  const staleRead = await staleEvidenceRuntime.tools.execute("read_week_schedule", { weekStart: "2026-08-17" }, {
    event,
    turnId: "56565656-5656-4656-8656-565656565656",
    step: 0,
    actor: context.actor,
    signal: new AbortController().signal,
  });
  assert.equal((staleRead.data as { evidenceQuality: { status: string } }).evidenceQuality.status, "empty");
  assert.equal(staleEvidenceRuntime.tools.catalogFor(event, context, [{
    step: 0,
    decision: {
      kind: "tool",
      toolName: "read_week_schedule",
      input: { weekStart: "2026-08-17" },
      reason: "Read the requested service week.",
    },
    result: staleRead,
  }]).some((tool) => tool.name === "sync_if_stale"), true);
}

async function testHiddenToolCapabilityRecovery(): Promise<void> {
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) {
      assert.equal(input.toolCatalog.some((tool) => tool.name === "remember_member_fact"), false);
      return {
        kind: "tool",
        toolName: "remember_member_fact",
        input: { category: "preference", fact: "Prefers short replies", importance: "normal" },
        reason: "A durable preference should be remembered.",
      };
    }
    if (input.previousSteps.length === 1) {
      const activation = input.previousSteps[0].decision;
      assert.equal(activation.kind, "tool");
      if (activation.kind === "tool") assert.equal(activation.toolName, "activate_capability");
      assert.equal(input.toolCatalog.some((tool) => tool.name === "remember_member_fact"), true);
      return {
        kind: "tool",
        toolName: "remember_member_fact",
        input: { category: "preference", fact: "Prefers short replies", importance: "normal" },
        reason: "Execute only after the schema is visible.",
      };
    }
    return { kind: "respond", message: "Noted.", reason: "The preference was stored." };
  });
  const runtime = createRuntime(planner, memberIdentity());
  const reply = await runtime.service.handleMessage(incomingMessage("hidden-tool-recovery", "Keep that in mind"));

  assert.equal(reply?.text, "Noted.");
  assert.deepEqual(await runtime.memory.getMemberFacts(MEMBER_ID, 5), ["Prefers short replies"]);
  assert.equal(runtime.journal.executions.filter((execution) => execution.toolName === "remember_member_fact").length, 1);
}

async function testSyncRecoveryVisibility(): Promise<void> {
  const runtime = createRuntime(
    new ScriptedAgentPlanner(() => ({ kind: "respond", message: "", reason: "Sync visibility test." })),
    memberIdentity(),
  );
  const event = transportEvent("sync-visibility", "What is this week's schedule?");
  const context = contextFor(memberIdentity());
  assert.equal(runtime.tools.catalogFor(event, context, []).some((tool) => tool.name === "sync_if_stale"), false);

  const sparseRead = {
    step: 0,
    decision: { kind: "tool" as const, toolName: "read_week_schedule", input: { weekStart: "2026-08-10" }, reason: "Read first." },
    result: {
      status: "success" as const,
      summary: "Sparse evidence.",
      data: { evidenceQuality: { status: "sparse", reasons: ["Blank rows"] } },
    },
  };
  assert.equal(runtime.tools.catalogFor(event, context, [sparseRead]).some((tool) => tool.name === "sync_if_stale"), true);

  const syncStep = {
    step: 1,
    decision: { kind: "tool" as const, toolName: "sync_if_stale", input: { reason: "Sparse evidence", force: false }, reason: "Recover once." },
    result: { status: "success" as const, summary: "Checked." },
  };
  assert.equal(runtime.tools.catalogFor(event, context, [sparseRead, syncStep]).some((tool) => tool.name === "sync_if_stale"), false);
}

async function testFailedSyncDoesNotStopTurn(): Promise<void> {
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) return {
      kind: "tool",
      toolName: "retrieve_choir_knowledge",
      input: { query: "Current weekly schedule", sourceIds: ["annual_events"], semanticSearch: false },
      reason: "Retrieve before considering synchronization.",
    };
    if (input.previousSteps.length === 1) return {
      kind: "tool",
      toolName: "sync_if_stale",
      input: { reason: "The retrieved evidence was sparse.", force: false },
      reason: "Attempt the single recovery synchronization.",
    };
    if (input.previousSteps.length === 2) return {
      kind: "tool",
      toolName: "retrieve_choir_knowledge",
      input: { query: "Current weekly schedule", sourceIds: ["annual_events"], semanticSearch: false },
      reason: "Perform the one permitted retrieval retry.",
    };
    return {
      kind: "respond",
      message: "I could not find reliable schedule data, but the rest of Echo is still available.",
      reason: "A failed recovery sync is non-fatal.",
    };
  });
  const runtime = createRuntime(planner, memberIdentity(), {
    knowledgeContext: "| |",
    syncFailure: true,
  });
  const result = await runtime.executor.execute(transportEvent("non-fatal-sync", "What is this week's schedule?"));

  assert.equal(result.status, "completed");
  assert.equal(result.steps[1].result?.status, "error");
  assert.equal(result.steps[1].result?.nonFatal, true);
  assert.equal(result.steps[2].result?.status, "error");
  assert.equal(result.steps[2].result?.error, "repeated_tool_call");
  assert.match(result.reply?.text ?? "", /rest of Echo is still available/i);
}

async function testBoundedMemberMemory(): Promise<void> {
  const memory = new InMemoryMemoryRepository();
  for (let index = 0; index < 25; index += 1) {
    await memory.rememberMemberFact({
      memberId: MEMBER_ID,
      category: "preference",
      fact: `Preference ${index}`,
      importance: index === 0 ? "high" : "normal",
      verified: true,
    });
  }
  const facts = await memory.getMemberFacts(MEMBER_ID, 30);
  assert.equal(facts.length, 20);
  assert.equal(facts[0], "Preference 0");
  assert.equal(facts.includes("Preference 5"), false);
}

async function testConstrainedGenericSpreadsheetEvaluation(): Promise<void> {
  const expectedTools = ["get_current_time", "inspect_spreadsheet", "query_spreadsheet"];
  const tailMarker = "ATTENDANCE_TAIL_RECORD";
  const completeAttendanceCell = `${"x".repeat(1_500)}${tailMarker}`;
  const planner = new ScriptedAgentPlanner((input) => {
    assert.deepEqual(input.toolCatalog.map((tool) => tool.name).sort(), [...expectedTools].sort());
    if (input.previousSteps.length === 0) {
      return { kind: "tool", toolName: "get_current_time", input: {}, reason: "Resolve yesterday." };
    }
    if (input.previousSteps.length === 1) {
      return {
        kind: "tool",
        toolName: "inspect_spreadsheet",
        input: { sheetName: "2026 attendance sheet" },
        reason: "Discover the named tab's structure.",
      };
    }
    if (input.previousSteps.length === 2) {
      const inspection = input.previousSteps[1]?.result?.data as Record<string, unknown>;
      assert.equal(inspection.sampleIsPartial, true);
      assert.deepEqual(inspection.columns, ["description", "attendance"]);
      const sampleRows = inspection.sampleRows as Array<{ attendance?: string }>;
      assert.equal(sampleRows[0]?.attendance?.endsWith(tailMarker), true);
      return {
        kind: "tool",
        toolName: "query_spreadsheet",
        input: {
          sheetName: "2026 attendance sheet",
          filters: [{ column: "attendance", operator: "contains", value: "10-August-26" }],
          selectColumns: ["description", "attendance"],
          limit: 1,
        },
        reason: "Query the discovered multiline attendance column.",
      };
    }
    const queryResult = input.previousSteps[2]?.result?.data as { rows?: Array<{ attendance?: string }> };
    assert.equal(queryResult.rows?.[0]?.attendance?.endsWith(tailMarker), true);
    return { kind: "respond", message: "Member A was unavailable.", reason: "The complete row answers the request." };
  });
  const runtime = createRuntime(planner, {
    id: CREATOR_ID,
    canonicalName: "Creator",
    displayName: "Creator",
    roles: ["member", "superuser", "creator"],
    status: "active",
  }, {
    maxSteps: 10,
    spreadsheets: {
      async inspectSheet(sheetName) {
        return {
          sheetName,
          columns: ["description", "attendance"],
          rowCount: 12,
          sampleRows: [{ description: "January", attendance: completeAttendanceCell }],
        };
      },
      async querySheet(input) {
        assert.equal(input.filters[0]?.value, "10-August-26");
        assert.equal(input.filters.length, 1, "Locate the multiline record before interpreting values within it.");
        return {
          sheetName: input.sheetName,
          rows: [{ description: "August", attendance: completeAttendanceCell }],
          matchedRows: 1,
          truncated: false,
        };
      },
    },
  });

  const reply = await runtime.service.handleMessage(
    incomingMessage("generic-sheet-evaluation", "From the 2026 attendance sheet, who was unavailable yesterday?"),
    { allowedToolNames: expectedTools, maxSteps: 10, includeRecentConversation: false },
  );
  assert.equal(reply?.text, "Member A was unavailable.");
  assert.deepEqual(runtime.journal.executions.map((execution) => execution.toolName), expectedTools);
}

async function testAggregateQueryBroadensBeforeClaimingAbsence(): Promise<void> {
  let queryCalls = 0;
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) {
      return { kind: "tool", toolName: "inspect_spreadsheet", input: { sheetName: "activity log" }, reason: "Discover columns." };
    }
    if (input.previousSteps.length === 1) {
      return {
        kind: "tool",
        toolName: "query_spreadsheet",
        input: {
          sheetName: "activity log",
          filters: [
            { column: "records", operator: "contains", value: "2026-08-30" },
            { column: "records", operator: "contains", value: "missing" },
          ],
          selectColumns: ["records"],
        },
        reason: "Attempt the requested lookup.",
      };
    }
    if (input.previousSteps.length === 2) {
      const queryDiagnostic = input.previousSteps[1]?.result?.data as Record<string, unknown>;
      assert.equal(queryDiagnostic.needsBroaderRecordCheck, true);
      return {
        kind: "tool",
        toolName: "query_spreadsheet",
        input: {
          sheetName: "activity log",
          filters: [{ column: "records", operator: "contains", value: "2026-08-30" }],
          selectColumns: ["records"],
        },
        reason: "Establish whether the dated record exists before interpreting its values.",
      };
    }
    return { kind: "respond", message: "There is no record for that date.", reason: "The broader lookup also returned no row." };
  });
  const runtime = createRuntime(planner, {
    id: CREATOR_ID,
    canonicalName: "Creator",
    displayName: "Creator",
    roles: ["member", "superuser", "creator"],
    status: "active",
  }, {
    maxSteps: 5,
    spreadsheets: {
      async inspectSheet(sheetName) {
        return { sheetName, columns: ["records"], rowCount: 1, sampleRows: [{ records: "2026-08-29 -> complete" }] };
      },
      async querySheet(input) {
        queryCalls += 1;
        return { sheetName: input.sheetName, rows: [], matchedRows: 0, truncated: false };
      },
    },
  });

  const reply = await runtime.service.handleMessage(
    incomingMessage("aggregate-query-broadening", "Which entries were missing on 2026-08-30?"),
    { allowedToolNames: ["inspect_spreadsheet", "query_spreadsheet"], maxSteps: 5, includeRecentConversation: false },
  );
  assert.equal(reply?.text, "There is no record for that date.");
  assert.equal(queryCalls, 2);
}

async function testUnknownSpreadsheetColumnCanBeRepaired(): Promise<void> {
  const planner = new ScriptedAgentPlanner((input) => {
    if (input.previousSteps.length === 0) {
      return {
        kind: "tool",
        toolName: "query_spreadsheet",
        input: {
          sheetName: "attendance",
          filters: [{ column: "Date", operator: "equals", value: "2026-08-11" }],
          selectColumns: ["Member Name"],
        },
        reason: "Attempt the requested query.",
      };
    }
    if (input.previousSteps.length === 1) {
      assert.equal(input.previousSteps[0]?.result?.nonFatal, true);
      return {
        kind: "tool",
        toolName: "inspect_spreadsheet",
        input: { sheetName: "attendance" },
        reason: "Discover the actual schema.",
      };
    }
    if (input.previousSteps.length === 2) {
      return {
        kind: "tool",
        toolName: "query_spreadsheet",
        input: {
          sheetName: "attendance",
          filters: [{ column: "attendance", operator: "contains", value: "11-August-26" }],
          selectColumns: ["description", "attendance"],
        },
        reason: "Retry with inspected columns.",
      };
    }
    return { kind: "respond", message: "Member A was unavailable.", reason: "The repaired query returned the record." };
  });
  const runtime = createRuntime(planner, {
    id: CREATOR_ID,
    canonicalName: "Creator",
    displayName: "Creator",
    roles: ["member", "superuser", "creator"],
    status: "active",
  }, {
    maxSteps: 5,
    spreadsheets: {
      async inspectSheet(sheetName) {
        return { sheetName, columns: ["description", "attendance"], rowCount: 1, sampleRows: [] };
      },
      async querySheet(input) {
        if (input.selectColumns.includes("Member Name")) {
          throw new Error("Column 'Member Name' was not found in sheet 'attendance'.");
        }
        return {
          sheetName: input.sheetName,
          rows: [{ description: "August", attendance: "11-August-26 -> Member A: NA" }],
          matchedRows: 1,
          offset: 0,
          truncated: false,
        };
      },
    },
  });

  const reply = await runtime.service.handleMessage(
    incomingMessage("spreadsheet-column-repair", "Who was unavailable yesterday?"),
    { allowedToolNames: ["inspect_spreadsheet", "query_spreadsheet"], maxSteps: 5, includeRecentConversation: false },
  );
  assert.equal(reply?.text, "Member A was unavailable.");
}

function createRuntime(
  planner: ScriptedAgentPlanner,
  actor: MemberIdentity | null,
  options: {
    identities?: InMemoryIdentityRepository;
    journal?: InMemoryAgentJournal;
    transport?: FakeAgentTransport;
    knowledgeContext?: string;
    knowledgeResult?: Awaited<ReturnType<ChoirKnowledgeService["retrieve"]>>;
    maxSteps?: number;
    obligations?: InMemoryObligationRepository;
    weeklyInterpretations?: InMemoryWeeklyInterpretationRepository;
    workflows?: ChoirWorkflowService;
    scheduledMessagePolicy?: ScheduledMessagePolicy;
    deliveryObserver?: ScheduledDeliveryObserver;
    onObligationSaved?: (obligation: import("../agent/types.js").AgentObligation) => void;
    dynamicContext?: boolean;
    activity?: AgentActivitySink;
    syncFailure?: boolean;
    scheduledTasks?: ScheduledAgentTaskManager;
    rotaReminder?: RotaReminderService;
    setlistOperations?: SetlistOperationsService;
    spreadsheets?: SpreadsheetDataService;
  } = {},
) {
  const identities = options.identities ?? identityDirectory();
  const memory = new InMemoryMemoryRepository();
  const obligations = options.obligations ?? new InMemoryObligationRepository();
  const conversations = new InMemoryConversationRepository();
  const journal = options.journal ?? new InMemoryAgentJournal();
  const approvals = new InMemoryApprovalRepository();
  const weeklyInterpretations = options.weeklyInterpretations ?? new InMemoryWeeklyInterpretationRepository();
  const workflows = options.workflows ?? workflowStub();
  const tools = new AgentToolRegistry(createCoreAgentTools({
    capabilities: echoCapabilityRegistry,
    identities,
    memory,
    obligations,
    weeklyInterpretations,
    knowledge: {
      async retrieve() {
        return options.knowledgeResult
          ?? { context: options.knowledgeContext ?? "Current choir information", sourceHash: "1234567890abcdef" };
      },
      async readIndexedSource(input) {
        return {
          sourceId: input.sourceId,
          sourceName: input.sourceId,
          documents: [],
          coverage: "none" as const,
        };
      },
    },
    sync: {
      async syncIfStale() {
        if (options.syncFailure) throw new Error("Simulated synchronization failure.");
        return { synced: false, sourceChanged: false, summary: "Data is fresh." };
      },
    },
    workflows,
    scheduledTasks: options.scheduledTasks ?? unavailableScheduledTaskManager(),
    spreadsheets: options.spreadsheets ?? {
      async listSheetNames() { return []; },
      async inspectSheet(sheetName) {
        return { sheetName, columns: [], rowCount: 0, sampleRows: [] };
      },
      async querySheet(input) {
        return { sheetName: input.sheetName, rows: [], matchedRows: 0, truncated: false };
      },
    },
    rotaReminder: options.rotaReminder,
    setlistOperations: options.setlistOperations,
    conversations,
    onObligationSaved: options.onObligationSaved,
    refreshMemberDirectory: async () => undefined,
  }));
  const context = contextFor(actor);
  const assembler = options.dynamicContext
    ? new DefaultAgentContextAssembler(identities, memory, conversations)
    : new StaticContextAssembler(context);
  const executor = new EchoAgentExecutor(
    planner,
    tools,
    assembler,
    journal,
    conversations,
    { maxSteps: options.maxSteps ?? 6 },
    approvals,
    options.activity,
  );
  const approvalCoordinator = new AgentApprovalCoordinator(approvals, identities, tools);
  const service = new EchoAgentService(
    executor,
    options.transport,
    approvalCoordinator,
    undefined,
    undefined,
    "whatsapp",
    obligations,
    options.deliveryObserver,
    options.scheduledMessagePolicy,
  );
  return {
    service,
    executor,
    contextAssembler: assembler,
    tools,
    conversations,
    journal,
    identities,
    memory,
    obligations,
    weeklyInterpretations,
  };
}

function unavailableScheduledTaskManager(): ScheduledAgentTaskManager {
  return {
    async create() {
      return { created: false, error: "Scheduled tasks are not configured in this test." };
    },
    async listOwned() {
      return [];
    },
    async manage() {
      return { error: "Scheduled tasks are not configured in this test." };
    },
  };
}

function successfulSyncCoordinator() {
  return {
    async syncIfStale() {
      return { synced: false, sourceChanged: false, summary: "Data is fresh." };
    },
  };
}

function workflowStub(): ChoirWorkflowService {
  return {
    async createReminder() { return { text: "Reminder prepared." }; },
    async continueReminder() { return { text: "Reminder updated." }; },
    async submitSetlist() { return { text: "Setlist saved." }; },
    async getSetlistFollowup() { return { complete: false, reminderText: "Member, please submit the setlist." }; },
    async isSetlistComplete() { return false; },
    async getPendingSetlistBroadcasts() { return []; },
    async getSetlistBroadcast() { return null; },
    async markSetlistBroadcastSent() {},
    async clearPendingSetlistBroadcast() {},
    async cleanupExpiredSetlists() { return 0; },
    setSetlistSubmittedHandler() {},
  };
}

function retrievalProvenance(
  coverage: "complete" | "partial" | "none",
  missingSources: string[] = [],
): NonNullable<Awaited<ReturnType<ChoirKnowledgeService["retrieve"]>>["provenance"]> {
  return {
    selectedSources: ["monthly_rota", "annual_events"],
    retrievedSources: ["monthly_rota"],
    missingSources,
    sheetNames: ["August"],
    semanticSearchUsed: false,
    fallbackUsed: false,
    coverage,
    absenceIsEvidence: false,
    temporalCoverage: "matched",
  };
}

function applicableWeeklyInterpretation(
  weekStart = "2026-08-10",
  sourceHash = "1234567890abcdef",
) {
  return {
    id: "weekly-interpretation",
    weekStart,
    sourceHash,
    scheduleContext: "The choir is ministering and the assigned leader must submit a setlist.",
    interpretation: {
      sundayActivityCancelled: false,
      setlistRequired: true,
      assignedMemberNames: ["Member"],
      worshipPraiseLeaderNames: ["Member"],
      applicableObligations: ["setlist_followup_due"],
      summary: "Normal choir week.",
      ambiguities: [],
    },
    evaluatedAt: "2026-08-11T10:00:00.000+01:00",
    expiresAt: "2026-08-24T00:00:00.000+01:00",
  };
}

function identityDirectory(): InMemoryIdentityRepository {
  const identities = new InMemoryIdentityRepository();
  identities.addMember({
    ...memberIdentity(),
    identifiers: [
      { kind: "phone", value: "200", verified: true },
      { kind: "whatsapp_jid", value: "200@s.whatsapp.net", verified: true },
      { kind: "alias", value: "Member", verified: true },
    ],
  });
  identities.addMember({
    id: CREATOR_ID,
    canonicalName: "Creator",
    displayName: "Creator",
    roles: ["member", "superuser", "creator"],
    status: "active",
    identifiers: [{ kind: "whatsapp_jid", value: "100@s.whatsapp.net", verified: true }],
  });
  return identities;
}

function memberIdentity(): MemberIdentity {
  return {
    id: MEMBER_ID,
    canonicalName: "Member",
    displayName: "Member",
    roles: ["member"],
    status: "active",
  };
}

function testScheduleOutputIsChronologicalAndReadable(): void {
  const jobs: ScheduledJobInfo[] = [
    {
      jobId: "choir-sunday-rota-activation",
      category: "rota_reminder",
      timezone: "Europe/London",
      runOnce: false,
      schedulerStrategy: "custom",
      cronExpression: "0 17 * * 0",
      nextRunAt: "2026-08-16T17:00:00+01:00",
    },
    {
      jobId: "agent-obligation-nudge-1",
      category: "setlist_nudge",
      timezone: "Europe/London",
      runOnce: true,
      schedulerStrategy: "custom",
      scheduledFor: "2026-08-12T11:30:00+01:00",
      nextRunAt: "2026-08-12T11:30:00+01:00",
    },
    {
      jobId: "choir-wednesday-rota-activation",
      category: "rota_reminder",
      timezone: "Europe/London",
      runOnce: false,
      schedulerStrategy: "custom",
      cronExpression: "0 9 * * 3",
      nextRunAt: "2026-08-12T09:00:00+01:00",
    },
  ];

  const output = formatScheduledJobsForWhatsApp(jobs);
  const wednesday = output.indexOf("1. Wednesday rota reminder");
  const nudge = output.indexOf("2. Setlist nudge");
  const sunday = output.indexOf("3. Sunday rota reminder");

  assert.ok(wednesday >= 0 && wednesday < nudge && nudge < sunday);
  assert.match(output, /Next: Wednesday, 12 August 2026 at 9:00 AM/);
  assert.match(output, /When: Wednesday, 12 August 2026 at 11:30 AM/);
  assert.match(output, /Repeats: Every Sunday at 5:00 PM/);
  assert.ok(output.includes("\n\n2. Setlist nudge"));
  assert.ok(!output.includes("2026-08-12T"));
}

function contextFor(actor: MemberIdentity | null): AgentTurnContext {
  return {
    now: clockService.now().toISO()!,
    timezone: "Europe/London",
    actor,
    memberProfile: null,
    memoryDirectory: [],
    memoryBlocks: [],
    memberFacts: [],
    activeObligations: [],
    recentConversation: [],
    contextBudget: { recentMessageLimit: 2, approximateCharacters: 0, approximateTokens: 0 },
  };
}

function plannerInput(): AgentPlannerInput {
  return {
    event: transportEvent("planner-protocol", "Who will attend Saturday rehearsal?"),
    context: contextFor(memberIdentity()),
    toolCatalog: [{
      name: "retrieve_choir_knowledge",
      description: "Retrieve current choir information.",
      inputSchema: JSON.stringify({ query: "string" }),
      sideEffect: "read",
      capability: "knowledge",
    }],
    availableCapabilities: [{
      id: "knowledge",
      description: "Choir knowledge",
      active: true,
      toolNames: ["retrieve_choir_knowledge"],
    }],
    previousSteps: [],
    maxSteps: 6,
  };
}

function incomingMessage(messageId: string, text: string): IncomingMessage {
  return {
    id: messageId,
    conversationId: CHAT_ID,
    transport: "whatsapp",
    sender: {
      id: "200@s.whatsapp.net",
      displayName: "Member",
      identifiers: { participantPhoneJid: "200@s.whatsapp.net" },
    },
    text,
    mentions: ["echo@s.whatsapp.net"],
    mentionedAgent: true,
    metadata: {},
  };
}

function transportEvent(eventKey: string, text: string) {
  return {
    eventKey,
    source: "transport" as const,
    type: "message_received",
    chatId: CHAT_ID,
    message: incomingMessage(eventKey, text),
    payload: {},
  };
}

void run();
