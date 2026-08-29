import type { z } from "zod";
import type { IncomingMessage, OutgoingMessage } from "../framework/contracts/messages.js";

export type AgentEventSource = "transport" | "scheduler" | "system";

export interface AgentEvent {
  eventKey: string;
  source: AgentEventSource;
  type: string;
  chatId?: string;
  message?: IncomingMessage;
  payload: Record<string, unknown>;
  /** Backend-resolved actor for trusted system activations such as owned tasks. */
  actorMemberId?: string;
}

export type MemberRole = "member" | "superuser" | "creator";

export interface MemberIdentity {
  id: string;
  /** Schedule-facing name; absent until a newly observed member is reconciled. */
  canonicalName: string | null;
  displayName: string;
  roles: MemberRole[];
  status: "active" | "inactive";
}

export interface MemberProfile {
  preferredDisplayName: string;
  transportNames: Record<string, string>;
  knownAliases: string[];
}

export interface MemoryBlock {
  id: string;
  scopeType: "agent" | "chat" | "member" | "week";
  scopeId: string;
  label: string;
  description: string;
  value: string;
  characterLimit: number;
  readOnly: boolean;
  expiresAt?: string;
  version: number;
}

export type MemoryBlockDirectoryEntry = Omit<MemoryBlock, "value">;

export type ObligationStatus =
  | "pending"
  | "waiting_for_data"
  | "waiting_for_member"
  | "satisfied"
  | "not_applicable"
  | "cancelled"
  | "failed";

export interface AgentObligation {
  id: string;
  naturalKey: string;
  type: string;
  chatId: string;
  weekStart?: string;
  assignedMemberIds: string[];
  status: ObligationStatus;
  dueAt?: string;
  payload: Record<string, unknown>;
  sourceHash?: string;
  lastEvaluatedAt?: string;
}

export type ScheduledAgentTaskStatus = "active" | "paused" | "cancelled";

export type RecurringSchedule =
  | { frequency: "daily"; time: string; timezone: string }
  | { frequency: "weekly"; weekday: number; time: string; timezone: string }
  | { frequency: "monthly"; dayOfMonth: number; time: string; timezone: string };

/** A successful tool call retained as guidance, never as cached evidence. */
export interface AgentProcedureStep {
  toolName: string;
  input: Record<string, unknown>;
}

/** Durable definition for a recurring objective activated by the scheduler. */
export interface ScheduledAgentTask {
  id: string;
  naturalKey: string;
  chatId: string;
  ownerMemberId: string;
  objective: string;
  rawSchedulePhrase: string;
  schedule: RecurringSchedule;
  status: ScheduledAgentTaskStatus;
  nextRunAt: string;
  procedure: AgentProcedureStep[];
  lastExecutionKey?: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationEntry {
  role: "user" | "assistant" | "tool" | "system";
  senderName?: string;
  content: string;
  createdAt: string;
}

export interface AgentTurnContext {
  now: string;
  timezone: string;
  actor: MemberIdentity | null;
  memberProfile: MemberProfile | null;
  memoryDirectory: MemoryBlockDirectoryEntry[];
  /** Values loaded on demand during this turn; empty in the initial context. */
  memoryBlocks: MemoryBlock[];
  /** Facts loaded on demand during this turn; empty in the initial context. */
  memberFacts: string[];
  /** Obligations are loaded by tool unless the event itself supplies one. */
  activeObligations: AgentObligation[];
  recentConversation: ConversationEntry[];
  contextBudget: {
    recentMessageLimit: number;
    approximateCharacters: number;
    approximateTokens: number;
  };
}

export interface AgentToolResult {
  status: "success" | "error" | "denied" | "approval_required";
  summary: string;
  data?: unknown;
  error?: string;
  reply?: OutgoingMessage;
  /**
   * `complete` means the tool fully handled the selected operation, including
   * an intentional no-message outcome. The default is `continue`, preserving
   * the planner's ability to inspect evidence and select additional tools.
   */
  turnControl?: "continue" | "complete";
  /** False keeps the audit record but omits bulky or transient data from later planner steps. */
  retainInContext?: boolean;
  /** Identity-changing tools can explicitly request one fresh working context. */
  refreshContext?: boolean;
  /** Recovery failures may be reported to the planner without consuming the turn failure budget. */
  nonFatal?: boolean;
  /** False means retrying this tool without a code/configuration change cannot succeed. */
  retryable?: boolean;
}

export type AgentToolCapability =
  | "conversation"
  | "knowledge"
  | "memory"
  | "workflow"
  | "choir_operations"
  | "identity"
  | "scheduler"
  | "administration";

export interface AgentTool<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: TSchema;
  sideEffect: "none" | "read" | "write" | "message";
  capability?: AgentToolCapability;
  requiresRole?: MemberRole;
  requiresConfirmation?: boolean;
  execute(input: z.infer<TSchema>, context: AgentExecutionContext): Promise<AgentToolResult>;
}

export interface AgentExecutionContext {
  event: AgentEvent;
  turnId: string;
  step: number;
  actor: MemberIdentity | null;
  signal: AbortSignal;
}

interface AgentDecisionBase {
  reason: string;
  /** Short, revisable next steps for observability; execution remains one action at a time. */
  plan?: string[];
}

export type AgentDecision =
  | (AgentDecisionBase & { kind: "respond"; message: string })
  | (AgentDecisionBase & { kind: "defer"; message: string })
  | (AgentDecisionBase & {
      kind: "tool";
      toolName: string;
      input: Record<string, unknown>;
      /** One already-known follow-up that may run after this tool succeeds. */
      nextTool?: { toolName: string; input: Record<string, unknown>; reason: string };
    });

export interface AgentPlannerInput {
  event: AgentEvent;
  context: AgentTurnContext;
  toolCatalog: Array<{
    name: string;
    description: string;
    inputSchema: string;
    /** Derived from the executable schema; false means `{}` cannot be valid. */
    acceptsEmptyInput?: boolean;
    sideEffect: AgentTool["sideEffect"];
    capability: AgentToolCapability;
  }>;
  availableCapabilities: Array<{
    id: AgentToolCapability;
    description: string;
    active: boolean;
    /** Tool names support discovery without paying for every hidden schema. */
    toolNames: string[];
  }>;
  previousSteps: AgentStep[];
  maxSteps: number;
}

export interface AgentPlanner {
  readonly modelName: string;
  decide(input: AgentPlannerInput, signal: AbortSignal): Promise<AgentDecision>;
}

export interface AgentStep {
  step: number;
  decision: AgentDecision;
  result?: AgentToolResult;
}

export interface AgentTurnResult {
  eventKey: string;
  status: "completed" | "deferred" | "failed" | "max_steps";
  reply: OutgoingMessage | null;
  steps: AgentStep[];
  error?: string;
  /** True when the durable journal has already completed this exact event. */
  replayed?: boolean;
  /** Present for scheduler activations after delivery policy and transport handling. */
  delivery?: {
    delivered: boolean;
    reason: "delivered" | "no_reply" | "policy_blocked" | "no_transport" | "no_safe_target";
  };
}

export type AgentActivityPhase = "turn" | "context" | "planning" | "tool" | "response";
export type AgentActivityStatus = "started" | "completed" | "failed";

/**
 * A deliberately small, safe view of agent execution for operational UIs.
 * It exposes the planner's explicit plan and tool lifecycle, never prompts,
 * hidden reasoning, raw memories or private identity values.
 */
export interface AgentActivityEvent {
  id: string;
  eventKey: string;
  turnId: string;
  occurredAt: string;
  phase: AgentActivityPhase;
  status: AgentActivityStatus;
  title: string;
  detail?: string;
  step?: number;
  maxSteps?: number;
  plan?: string[];
  tool?: {
    name: string;
    input?: Record<string, unknown>;
    summary?: string;
  };
}
