import type {
  AgentEvent,
  AgentActivityEvent,
  AgentObligation,
  AgentTurnContext,
  AgentTurnResult,
  AgentProcedureStep,
  ConversationEntry,
  MemberIdentity,
  MemoryBlock,
  MemoryBlockDirectoryEntry,
  MemberProfile,
  ObligationStatus,
  RecurringSchedule,
  ScheduledAgentTask,
} from "./types.js";
import type { ExternalIdentity, IncomingMessage, OutgoingMessage, SentMessageReceipt } from "../framework/contracts/messages.js";
import type { MessageTransport } from "../framework/ports/index.js";

export interface IdentityRepository {
  resolveSender(sender: ExternalIdentity): Promise<MemberIdentity | null>;
  getById(memberId: string): Promise<MemberIdentity | null>;
  resolveByName(name: string): Promise<MemberIdentity[]>;
  resolveByNames(names: string[]): Promise<Array<{ name: string; matches: MemberIdentity[] }>>;
  getMentionTargets(memberIds: string[], transport: string, participantIds?: string[]): Promise<string[]>;
  addIdentifier(input: {
    memberId: string;
    kind: "phone" | "whatsapp_jid" | "push_name" | "alias";
    value: string;
    verified: boolean;
  }): Promise<void>;
  onboardSender(input: {
    sender: ExternalIdentity;
    transport: string;
    chatId: string;
  }): Promise<MemberIdentity>;
  setCanonicalName(input: { actorMemberId: string; memberId: string; canonicalName: string }): Promise<void>;
}

export type SpreadsheetFilterOperator = "equals" | "not_equals" | "contains" | "empty" | "not_empty";

export interface SpreadsheetDataService {
  listSheetNames?(): Promise<string[]>;
  inspectSheet(sheetName: string): Promise<{
    sheetName: string;
    columns: string[];
    rowCount: number;
    sampleRows: Record<string, string>[];
  }>;
  querySheet(input: {
    sheetName: string;
    filters: Array<{ column: string; operator: SpreadsheetFilterOperator; value?: string }>;
    selectColumns: string[];
    limit: number;
    offset?: number;
  }): Promise<{
    sheetName: string;
    rows: Record<string, string>[];
    matchedRows: number;
    offset?: number;
    nextOffset?: number;
    truncated: boolean;
  }>;
}

export interface MemoryRepository {
  getBlocks(input: { chatId?: string; memberId?: string; weekStart?: string }): Promise<MemoryBlock[]>;
  getBlock(input: { scopeType: MemoryBlock["scopeType"]; scopeId: string; label: string }): Promise<MemoryBlock | null>;
  listBlockDirectory(input: { chatId?: string; memberId?: string; weekStart?: string }): Promise<MemoryBlockDirectoryEntry[]>;
  upsertBlock(input: Omit<MemoryBlock, "id" | "version"> & { id?: string }): Promise<MemoryBlock>;
  getMemberFacts(memberId: string, limit: number, query?: string): Promise<string[]>;
  rememberMemberFact(input: {
    memberId: string;
    category: string;
    fact: string;
    sourceMessageId?: string;
    importance: "low" | "normal" | "high";
    verified: boolean;
  }): Promise<void>;
  updateMemberProfile(input: {
    memberId: string;
    transport: string;
    transportName?: string;
    preferredDisplayName?: string;
    aliases: string[];
  }): Promise<MemberProfile>;
  deleteBlock(input: { scopeType: MemoryBlock["scopeType"]; scopeId: string; label: string }): Promise<void>;
  pruneExpiredBlocks(): Promise<number>;
}

export interface ObligationRepository {
  listActive(chatId?: string): Promise<AgentObligation[]>;
  upsert(input: Omit<AgentObligation, "id">): Promise<AgentObligation>;
  updateStatus(id: string, status: ObligationStatus, reason?: string): Promise<AgentObligation>;
}

export interface ScheduledAgentTaskRepository {
  create(input: {
    naturalKey: string;
    chatId: string;
    ownerMemberId: string;
    objective: string;
    rawSchedulePhrase: string;
    schedule: RecurringSchedule;
    nextRunAt: string;
  }): Promise<{ task: ScheduledAgentTask; created: boolean }>;
  get(id: string): Promise<ScheduledAgentTask | null>;
  listActive(): Promise<ScheduledAgentTask[]>;
  listOwned(ownerMemberId: string, chatId: string): Promise<ScheduledAgentTask[]>;
  updateOwned(
    id: string,
    ownerMemberId: string,
    updates: Partial<Pick<ScheduledAgentTask, "naturalKey" | "objective" | "rawSchedulePhrase" | "schedule" | "status" | "nextRunAt">>,
  ): Promise<ScheduledAgentTask | null>;
  claimExecution(input: {
    id: string;
    executionKey: string;
    expectedRunAt?: string;
    nextRunAt: string;
  }): Promise<ScheduledAgentTask | null>;
  recordExecution(input: {
    id: string;
    executionKey: string;
    procedure?: AgentProcedureStep[];
    succeeded: boolean;
    error?: string;
  }): Promise<void>;
}

export interface ScheduledAgentTaskManager {
  create(input: {
    chatId: string;
    ownerMemberId: string;
    objective: string;
    rawSchedulePhrase: string;
  }): Promise<{ task?: ScheduledAgentTask; created: boolean; error?: string }>;
  listOwned(ownerMemberId: string, chatId: string): Promise<ScheduledAgentTask[]>;
  manage(input: {
    id: string;
    ownerMemberId: string;
    action: "pause" | "resume" | "cancel" | "update";
    objective?: string;
    rawSchedulePhrase?: string;
  }): Promise<{ task?: ScheduledAgentTask; error?: string }>;
}

export interface ConversationRepository {
  append(input: {
    externalMessageId?: string;
    chatId: string;
    memberId?: string;
    role: ConversationEntry["role"];
    content: string;
    quotedExternalMessageId?: string;
    senderName?: string;
  }): Promise<void>;
  getRecent(chatId: string, limit: number): Promise<ConversationEntry[]>;
  search(chatId: string, query: string, limit: number, excludeExternalMessageId?: string): Promise<ConversationEntry[]>;
}

export interface AgentJournal {
  beginEvent(event: AgentEvent, actorMemberId?: string): Promise<{ eventId: string; duplicateResult?: AgentTurnResult }>;
  beginTurn(eventId: string, model: string): Promise<string>;
  recordToolExecution(input: {
    turnId: string;
    step: number;
    toolName: string;
    idempotencyKey: string;
    arguments: Record<string, unknown>;
    status: "running" | "success" | "error" | "denied" | "approval_required";
    result?: unknown;
    error?: string;
  }): Promise<void>;
  completeTurn(turnId: string, result: AgentTurnResult): Promise<void>;
  failTurn(turnId: string, error: string): Promise<void>;
  failEvent(eventId: string, error: string): Promise<void>;
}

export interface AgentContextAssembler {
  assemble(event: AgentEvent): Promise<AgentTurnContext>;
}

/** Optional observer used by staging and monitoring adapters. */
export interface AgentActivitySink {
  publish(event: AgentActivityEvent): void | Promise<void>;
}

export interface ChoirKnowledgeService {
  retrieve(query: string, routing?: {
    sourceIds: string[];
    semanticSearch: boolean;
    semanticResultLimit?: number;
  }): Promise<{
    context: string;
    sourceHash?: string;
    provenance?: {
      selectedSources: string[];
      retrievedSources: string[];
      missingSources: string[];
      sheetNames: string[];
      indexedSourceNames?: string[];
      semanticSearchUsed: boolean;
      fallbackUsed: boolean;
      coverage: "complete" | "partial" | "none";
      absenceIsEvidence: false;
      retrievedAt?: string;
      temporalScope?: Array<{ phrase: string; date: string; endDate?: string }>;
      temporalCoverage?: "not_requested" | "matched" | "unmatched";
      compaction?: {
        structuredCharacters: number;
        semanticCharacters: number;
        omittedStructuredRows: number;
        structuredTruncated: boolean;
        semanticTruncated: boolean;
      };
    };
  }>;
  readIndexedSource?(input: {
    sourceId: string;
    offset: number;
    limit: number;
  }): Promise<{
    sourceId: string;
    sourceName: string;
    documents: Array<{ content: string; metadata: Record<string, unknown> }>;
    nextOffset?: number;
    coverage: "complete" | "partial" | "none";
  }>;
}

export interface SyncCoordinator {
  syncIfStale(input: { reason: string; force?: boolean }): Promise<{
    synced: boolean;
    sourceChanged: boolean;
    sourceHash?: string;
    summary: string;
  }>;
}

export interface WeeklyInterpretationRepository {
  get(weekStart: string, sourceHash: string): Promise<WeeklyInterpretation | null>;
  getLatest(weekStart: string): Promise<WeeklyInterpretation | null>;
  save(input: Omit<WeeklyInterpretation, "id">): Promise<WeeklyInterpretation>;
}

export interface WeeklyInterpretation {
  id: string;
  weekStart: string;
  sourceHash: string;
  scheduleContext: string;
  interpretation: {
    sundayActivityCancelled: boolean | null;
    setlistRequired: boolean | null;
    assignedMemberNames: string[];
    worshipPraiseLeaderNames: string[];
    applicableObligations: string[];
    summary: string;
    ambiguities: string[];
  };
  evaluatedAt: string;
  expiresAt: string;
}

export interface AgentMessageTransport extends MessageTransport {}

export interface ScheduledDeliveryObserver {
  onDelivered(event: AgentEvent, result: AgentTurnResult, receipt: SentMessageReceipt): Promise<void>;
}

export interface ScheduledMessagePolicy {
  canDeliver(event: AgentEvent, result: AgentTurnResult): boolean;
}

export interface AgentApproval {
  id: string;
  chatId: string;
  ownerMemberId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  status: "pending" | "approved" | "declined" | "executed" | "failed";
  confirmationMessageId?: string;
  expiresAt: string;
}

export interface ApprovalRepository {
  create(input: Omit<AgentApproval, "id" | "status">): Promise<AgentApproval>;
  attachConfirmationMessage(approvalId: string, messageId: string): Promise<void>;
  findPendingByConfirmationMessage(messageId: string): Promise<AgentApproval | null>;
  updateStatus(id: string, status: AgentApproval["status"], result?: unknown): Promise<void>;
}

export interface ChoirWorkflowService {
  createReminder(input: {
    message: IncomingMessage;
    rawDatePhrase: string | null;
    reminderMessage: string | null;
  }): Promise<OutgoingMessage>;
  continueReminder(input: {
    message: IncomingMessage;
    action: "confirm" | "decline" | "edit" | "request_cancel";
    rawDatePhrase?: string | null;
    reminderMessage?: string | null;
  }): Promise<OutgoingMessage>;
  submitSetlist(input: {
    message: IncomingMessage;
    scope: "combined" | "worship" | "praise";
  }): Promise<OutgoingMessage>;
  getSetlistFollowup(weekStart: string): Promise<{
    complete: boolean;
    reminderText: string | null;
  }>;
  isSetlistComplete(weekStart: string): Promise<boolean>;
  getPendingSetlistBroadcasts(): Promise<Array<{
    id: string;
    chatId: string;
    weekStart: string;
    content: string;
    broadcastScheduledFor?: string;
  }>>;
  getSetlistBroadcast(submissionId: string): Promise<{
    id: string;
    chatId: string;
    weekStart: string;
    content: string;
  } | null>;
  markSetlistBroadcastSent(submissionId: string): Promise<void>;
  clearPendingSetlistBroadcast(submissionId: string): Promise<void>;
  cleanupExpiredSetlists(): Promise<number>;
  setSetlistSubmittedHandler(handler: (submission: {
    id: string;
    chatId: string;
    weekStart: string;
    content: string;
    broadcastScheduledFor?: string;
  }) => Promise<void>): void;
}
