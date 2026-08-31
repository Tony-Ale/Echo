import type { ChoirIntelligenceService } from "../../domains/choir/intelligence/choirIntelligenceService.js";
import type { SyncEngine } from "../../sync/syncEngine.js";
import type { WorkflowService } from "../../workflows/workflowService.js";
import { validateDeploymentProfile } from "../../framework/deployments/types.js";
import { PluginRegistry } from "../../framework/plugins/pluginRegistry.js";
import { PromptRegistry } from "../../framework/prompts/promptRegistry.js";
import { AGENT_CANON_PROMPT_PACK } from "../../prompts/canon/agentCanon.js";
import { TOOL_AGENT_PROMPT_PACK } from "../../prompts/runtime/toolAgent.js";
import { CHOIR_OPERATIONS_PROMPT_PACK } from "../../prompts/domains/choir/operations.js";
import { ECHO_BOOTSTRAP_MEMORY, ECHO_DEPLOYMENT_PROMPT_PACK } from "../../prompts/deployments/echo.js";
import { SupabaseIdentityRepository } from "../../agent/persistence/identityRepository.js";
import { SupabaseMemoryRepository } from "../../agent/persistence/memoryRepository.js";
import {
  SupabaseAgentJournal,
  SupabaseConversationRepository,
  SupabaseObligationRepository,
} from "../../agent/persistence/operationsRepository.js";
import { SupabaseWeeklyInterpretationRepository } from "../../agent/persistence/weeklyInterpretationRepository.js";
import { SupabaseApprovalRepository } from "../../agent/persistence/approvalRepository.js";
import { SupabaseScheduledAgentTaskRepository } from "../../agent/persistence/scheduledTaskRepository.js";
import { DefaultAgentContextAssembler } from "../../agent/runtime/contextAssembler.js";
import { LangChainAgentPlanner } from "../../agent/runtime/langChainPlanner.js";
import { RoutingAgentPlanner } from "../../agent/runtime/modelRouter.js";
import { AgentToolRegistry } from "../../agent/runtime/toolRegistry.js";
import { EchoAgentExecutor } from "../../agent/runtime/agentExecutor.js";
import {
  createChoirAgentTools,
  createPlatformAgentTools,
  type CoreToolDependencies,
} from "../../agent/tools/coreTools.js";
import { SupabaseSyncCoordinator } from "../../agent/services/syncCoordinator.js";
import { AgentBootstrapService } from "../../agent/services/agentBootstrap.js";
import { EchoAgentService } from "../../agent/services/echoAgentService.js";
import { AgentApprovalCoordinator } from "../../agent/services/approvalCoordinator.js";
import { AgentObligationScheduler } from "../../agent/services/obligationScheduler.js";
import { ScheduledAgentTaskService } from "../../agent/services/scheduledAgentTaskService.js";
import { env } from "../../config/env.js";
import { agentConfig } from "../../config/agentConfig.js";
import { createEchoDeploymentProfile } from "./profile.js";
import type { AgentTool } from "../../agent/types.js";
import { ApplicationSchedulerAdapter } from "../../integrations/scheduler/frameworkSchedulerAdapter.js";
import type {
  AgentActivitySink,
  MemoryRepository,
  ObligationRepository,
  SyncCoordinator,
  WeeklyInterpretationRepository,
  SpreadsheetDataService,
} from "../../agent/ports.js";
import { ChoirDeliveryObserver } from "../../domains/choir/operations/choirDeliveryObserver.js";
import type { ChatModelResolver } from "../../framework/models/types.js";
import { createDynamicPromptResolver } from "../../agent/runtime/dynamicPrompt.js";
import { LoggingAgentRuntimeTelemetry } from "../../agent/runtime/runtimeTelemetry.js";
import {
  ModelWeeklyScheduleAssessor,
  RotaReminderService,
} from "../../domains/choir/operations/rotaReminderService.js";
import { SetlistOperationsService } from "../../domains/choir/operations/setlistOperationsService.js";

export interface EchoAgentRuntime {
  agentService: EchoAgentService;
  obligationScheduler: AgentObligationScheduler;
  obligations: ObligationRepository;
  syncCoordinator: SyncCoordinator;
  identities: SupabaseIdentityRepository;
  scheduledTasks: ScheduledAgentTaskService;
  toolCatalog: ReturnType<AgentToolRegistry["catalog"]>;
}

/**
 * Builds Echo as one deployment of the reusable framework.
 * Concrete vendors live here; the executor, plugins and prompt library remain
 * independent of Supabase, Groq and WhatsApp.
 */
export async function createEchoAgentRuntime(input: {
  intelligence: ChoirIntelligenceService;
  workflowService: WorkflowService;
  syncEngine: SyncEngine;
  memory?: MemoryRepository;
  identities?: SupabaseIdentityRepository;
  weeklyInterpretations?: WeeklyInterpretationRepository;
  transportId?: string;
  activitySink?: AgentActivitySink;
  models: ChatModelResolver;
  spreadsheets: SpreadsheetDataService;
}): Promise<EchoAgentRuntime> {
  const transportId = input.transportId ?? "whatsapp";
  const transportPluginId = `transport.${transportId}`;
  const profile = createEchoDeploymentProfile({
    primary: input.models.get("planner").modelName,
    fast: input.models.get("fast").modelName,
    transportPluginId,
  });
  validateDeploymentProfile(profile);

  const identities = input.identities ?? new SupabaseIdentityRepository();
  const memory = input.memory ?? new SupabaseMemoryRepository(profile.id);
  const obligations = new SupabaseObligationRepository();
  const conversations = new SupabaseConversationRepository();
  const journal = new SupabaseAgentJournal();
  const weeklyInterpretations = input.weeklyInterpretations ?? new SupabaseWeeklyInterpretationRepository();
  const approvals = new SupabaseApprovalRepository();
  const scheduler = new ApplicationSchedulerAdapter();
  const scheduledTasks = new ScheduledAgentTaskService(
    new SupabaseScheduledAgentTaskRepository(),
    scheduler,
  );
  const primaryModel = input.models.get("planner");
  const fastModel = input.models.get("fast");

  await new AgentBootstrapService(memory, ECHO_BOOTSTRAP_MEMORY).initialize();
  const refreshMemberDirectory = async () => {
    identities.clearCache();
    const directory = await identities.getRuntimeDirectorySnapshot();
    const isProduction = env.ECHO_ENVIRONMENT === "production" || env.NODE_ENV === "production";
    if (isProduction) validateProductionIdentities(directory);
  };
  await refreshMemberDirectory();

  let obligationScheduler: AgentObligationScheduler | undefined;
  const syncCoordinator = new SupabaseSyncCoordinator(input.syncEngine);
  const rotaReminder = new RotaReminderService(
    input.intelligence,
    weeklyInterpretations,
    identities,
    syncCoordinator,
    new ModelWeeklyScheduleAssessor(fastModel),
  );
  const setlistOperations = new SetlistOperationsService(
    rotaReminder,
    input.workflowService,
    identities,
    obligations,
    (obligation) => obligationScheduler?.schedule(obligation),
  );
  const dependencies: CoreToolDependencies = {
    identities,
    memory,
    obligations,
    knowledge: input.intelligence,
    sync: syncCoordinator,
    weeklyInterpretations,
    workflows: input.workflowService,
    conversations,
    scheduledTasks,
    spreadsheets: input.spreadsheets,
    rotaReminder,
    setlistOperations,
    onObligationSaved: (obligation) => obligationScheduler?.schedule(obligation),
    refreshMemberDirectory,
  };

  const pluginRegistry = new PluginRegistry<AgentTool>();
  pluginRegistry.register({
    manifest: {
      id: "runtime.agent",
      version: "1.0.0",
      kind: "runtime",
      description: "Persistent memory, identity and obligation capabilities.",
    },
    tools: createPlatformAgentTools(dependencies),
    promptPacks: [AGENT_CANON_PROMPT_PACK, TOOL_AGENT_PROMPT_PACK],
  });
  pluginRegistry.register({
    manifest: {
      id: transportPluginId,
      version: "1.0.0",
      kind: "integration",
      description: `Active ${transportId} transport adapter.`,
      dependencies: ["runtime.agent"],
    },
  });
  pluginRegistry.register({
    manifest: {
      id: "domain.choir",
      version: "1.0.0",
      kind: "domain",
      description: "Choir schedules, reminders, setlists and retrieval tools.",
      dependencies: ["runtime.agent"],
    },
    tools: createChoirAgentTools(dependencies),
    promptPacks: [CHOIR_OPERATIONS_PROMPT_PACK],
  });
  pluginRegistry.register({
    manifest: {
      id: "deployment.echo",
      version: "1.0.0",
      kind: "deployment",
      description: "Echo's OHA identity and communication style.",
      dependencies: ["runtime.agent", "domain.choir"],
    },
    promptPacks: [ECHO_DEPLOYMENT_PROMPT_PACK],
  });

  const activated = await pluginRegistry.activate(profile.pluginIds);
  const prompts = new PromptRegistry();
  for (const pack of activated.promptPacks) prompts.register(pack);
  const plannerPrompt = createDynamicPromptResolver(prompts, profile.promptPackIds);
  const telemetry = new LoggingAgentRuntimeTelemetry();

  const planner = new RoutingAgentPlanner(
    new LangChainAgentPlanner(primaryModel, primaryModel.modelName, plannerPrompt, telemetry),
    new LangChainAgentPlanner(fastModel, fastModel.modelName, plannerPrompt, telemetry),
  );
  const tools = new AgentToolRegistry(activated.tools);
  const contextAssembler = new DefaultAgentContextAssembler(identities, memory, conversations);
  const executor = new EchoAgentExecutor(
    planner,
    tools,
    contextAssembler,
    journal,
    conversations,
    agentConfig.execution,
    approvals,
    input.activitySink,
    telemetry,
  );
  const approvalCoordinator = new AgentApprovalCoordinator(approvals, identities, tools);
  const choirDelivery = new ChoirDeliveryObserver(input.workflowService);
  const agentService = new EchoAgentService(
    executor,
    undefined,
    approvalCoordinator,
    conversations,
    identities,
    transportId,
    obligations,
    choirDelivery,
    choirDelivery,
    scheduledTasks,
  );
  obligationScheduler = new AgentObligationScheduler(obligations, agentService, scheduler);
  scheduledTasks.setRunner(async (activation) => {
    const result = await agentService.handleScheduledWake({
      eventKey: activation.executionKey,
      type: "scheduled_agent_task_due",
      chatId: activation.task.chatId,
      actorMemberId: activation.task.ownerMemberId,
      payload: {
        scheduledTaskId: activation.task.id,
        ownerMemberId: activation.task.ownerMemberId,
        objective: activation.task.objective,
        schedule: activation.task.schedule,
        previousProcedure: activation.task.procedure,
        scheduledFor: activation.scheduledFor,
        immediate: activation.immediate,
        allowUntargetedMessage: true,
      },
    });
    return { result, procedure: tools.buildReusableProcedure(result.steps) };
  });

  return {
    agentService,
    obligationScheduler,
    obligations,
    syncCoordinator,
    identities,
    scheduledTasks,
    toolCatalog: tools.catalog(),
  };
}

function validateProductionIdentities(directory: Array<{ roles: string[]; phone?: string; whatsappJid?: string }>): void {
  const hasVerifiedRole = (role: "creator" | "superuser") => directory.some(
    (member) => member.roles.includes(role) && Boolean(member.phone || member.whatsappJid),
  );
  if (!hasVerifiedRole("creator") || !hasVerifiedRole("superuser")) {
    throw new Error("Production requires database-backed creator and superuser identities with verified WhatsApp identifiers.");
  }
}
