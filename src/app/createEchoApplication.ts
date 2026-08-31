import { createGoogleSheetsClient } from "../integrations/googleSheets/googleSheetsClient.js";
import { SheetsRepository } from "../integrations/googleSheets/sheetsRepository.js";
import { createVectorStore, getPineconeIndex } from "../integrations/pinecone/pineconeClient.js";
import { ChoirIntelligenceService } from "../domains/choir/intelligence/choirIntelligenceService.js";
import { initSync } from "../sync/createSyncEngine.js";
import { WorkflowRepository } from "../workflows/workflowRepository.js";
import { TemporalPhraseService } from "../workflows/temporalPhraseService.js";
import { ReminderScheduler } from "../workflows/reminderScheduler.js";
import { SetlistService } from "../workflows/setlistService.js";
import { WorkflowService } from "../workflows/workflowService.js";
import { WorkflowCache } from "../workflows/workflowCache.js";
import { createEchoAgentRuntime } from "../deployments/echo/createEchoAgentRuntime.js";
import { SupabaseMemoryRepository } from "../agent/persistence/memoryRepository.js";
import { SupabaseIdentityRepository } from "../agent/persistence/identityRepository.js";
import { SupabaseWeeklyInterpretationRepository } from "../agent/persistence/weeklyInterpretationRepository.js";
import { ChoirScheduleService } from "../domains/choir/operations/choirScheduleService.js";
import { ApplicationSchedulerAdapter } from "../integrations/scheduler/frameworkSchedulerAdapter.js";
import { MessageRouter } from "./messageRouter.js";
import type { AgentActivitySink } from "../agent/ports.js";
import { loadModelConfiguration } from "../integrations/models/modelConfiguration.js";
import { LangChainModelRegistry } from "../integrations/models/modelRegistry.js";
import { PersistentScheduleVisibility } from "./scheduleVisibility.js";

export interface EchoApplication {
  agentTools: Awaited<ReturnType<typeof createEchoAgentRuntime>>["toolCatalog"];
  agentService: Awaited<ReturnType<typeof createEchoAgentRuntime>>["agentService"];
  choirScheduleService: ChoirScheduleService;
  identities: Awaited<ReturnType<typeof createEchoAgentRuntime>>["identities"];
  messageRouter: MessageRouter;
  obligations: Awaited<ReturnType<typeof createEchoAgentRuntime>>["obligations"];
  reminderScheduler: ReminderScheduler;
  scheduledTasks: Awaited<ReturnType<typeof createEchoAgentRuntime>>["scheduledTasks"];
  workflowService: WorkflowService;
}

/**
 * Composes Echo's transport-independent application once.
 * WhatsApp and local staging attach different adapters to this same runtime.
 */
export async function createEchoApplication(input: {
  chatId: string;
  transportId: string;
  activitySink?: AgentActivitySink;
}): Promise<EchoApplication> {
  const models = new LangChainModelRegistry(loadModelConfiguration());
  const vectorStore = await createVectorStore(getPineconeIndex());
  const sheetsRepository = new SheetsRepository(createGoogleSheetsClient());
  const memoryRepository = new SupabaseMemoryRepository("echo");
  const identities = new SupabaseIdentityRepository();
  const weeklyInterpretations = new SupabaseWeeklyInterpretationRepository();
  const intelligence = new ChoirIntelligenceService(vectorStore, sheetsRepository);
  const workflowRepository = new WorkflowRepository();
  const scheduler = new ApplicationSchedulerAdapter();
  const reminderScheduler = new ReminderScheduler(scheduler);
  const temporalPhrases = new TemporalPhraseService(models.get("extraction"));
  const setlistService = new SetlistService(
    workflowRepository,
    identities,
    weeklyInterpretations,
  );
  const workflowService = new WorkflowService(
    workflowRepository,
    temporalPhrases,
    reminderScheduler,
    setlistService,
    new WorkflowCache(),
  );
  const runtime = await createEchoAgentRuntime({
    intelligence,
    workflowService,
    syncEngine: initSync(sheetsRepository),
    memory: memoryRepository,
    identities,
    weeklyInterpretations,
    transportId: input.transportId,
    activitySink: input.activitySink,
    models,
    spreadsheets: sheetsRepository,
  });
  const choirScheduleService = new ChoirScheduleService(
    scheduler,
    runtime.obligations,
    runtime.obligationScheduler,
    runtime.agentService,
    workflowService,
    memoryRepository,
    input.chatId,
  );
  const scheduleVisibility = new PersistentScheduleVisibility(
    workflowService,
    runtime.obligations,
    runtime.scheduledTasks,
  );

  return {
    agentTools: runtime.toolCatalog,
    agentService: runtime.agentService,
    choirScheduleService,
    identities: runtime.identities,
    messageRouter: new MessageRouter(
      runtime.agentService,
      runtime.syncCoordinator,
      identities,
      choirScheduleService,
      scheduleVisibility,
    ),
    obligations: runtime.obligations,
    reminderScheduler,
    scheduledTasks: runtime.scheduledTasks,
    workflowService,
  };
}
