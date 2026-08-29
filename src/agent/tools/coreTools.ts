import { z } from "zod";
import { DateTime } from "luxon";
import { RETRIEVAL_SOURCE_IDS } from "../../domains/choir/intelligence/retrievalSources.js";
import { clockService } from "../../shared/clockService.js";
import { sha256 } from "../../shared/utils/hash.js";
import { agentConfig } from "../../config/agentConfig.js";
import { AGENT_CONTEXT_LIMITS } from "../runtime/contextLimits.js";
import type {
  ChoirKnowledgeService,
  ConversationRepository,
  IdentityRepository,
  MemoryRepository,
  ObligationRepository,
  ScheduledAgentTaskManager,
  SpreadsheetDataService,
  SyncCoordinator,
  WeeklyInterpretationRepository,
  ChoirWorkflowService,
} from "../ports.js";
import type { AgentTool } from "../types.js";
import { getMondayOfWeek } from "../../domains/choir/intelligence/helpers.js";
import { isExplicitReminderActivation, parseReminderReplyAction } from "../../workflows/workflowDetection.js";
import { describeRecurringSchedule } from "../services/recurringSchedule.js";
import type { RotaReminderService } from "../../domains/choir/operations/rotaReminderService.js";
import type {
  SetlistOperationResult,
  SetlistOperationsService,
} from "../../domains/choir/operations/setlistOperationsService.js";

export interface CoreToolDependencies {
  identities: IdentityRepository;
  memory: MemoryRepository;
  obligations: ObligationRepository;
  knowledge: ChoirKnowledgeService;
  sync: SyncCoordinator;
  weeklyInterpretations: WeeklyInterpretationRepository;
  workflows: ChoirWorkflowService;
  conversations: ConversationRepository;
  scheduledTasks: ScheduledAgentTaskManager;
  spreadsheets: SpreadsheetDataService;
  rotaReminder?: RotaReminderService;
  setlistOperations?: SetlistOperationsService;
  onObligationSaved?: (obligation: import("../types.js").AgentObligation) => void;
  refreshMemberDirectory?: () => Promise<void>;
}

export function createCoreAgentTools(dependencies: CoreToolDependencies): AgentTool[] {
  return [
    ...createPlatformAgentTools(dependencies),
    ...createChoirAgentTools(dependencies),
  ];
}

/** Reusable tools that are not tied to the choir domain. */
export function createPlatformAgentTools(dependencies: CoreToolDependencies): AgentTool[] {
  return [
    currentTimeTool(),
    searchConversationHistoryTool(dependencies.conversations),
    readMemberMemoryTool(dependencies.memory),
    readContextMemoryTool(dependencies.memory),
    onboardCurrentSenderTool(dependencies.identities, dependencies.memory, dependencies.refreshMemberDirectory),
    resolveMembersTool(dependencies.identities),
    composeMemberMessageTool(dependencies.identities),
    updateOwnMemberProfileTool(dependencies.memory, dependencies.refreshMemberDirectory),
    rememberMemberFactTool(dependencies.memory),
    addMemberIdentifierTool(dependencies.identities, dependencies.refreshMemberDirectory),
    setCanonicalMemberNameTool(dependencies.identities, dependencies.refreshMemberDirectory),
    listObligationsTool(dependencies.obligations),
    upsertObligationTool(dependencies.obligations, dependencies.onObligationSaved),
    updateObligationTool(dependencies.obligations),
    createScheduledAgentTaskTool(dependencies.scheduledTasks),
    listScheduledAgentTasksTool(dependencies.scheduledTasks),
    manageScheduledAgentTaskTool(dependencies.scheduledTasks),
    inspectSpreadsheetTool(dependencies.spreadsheets),
    querySpreadsheetTool(dependencies.spreadsheets),
  ];
}

function inspectSpreadsheetTool(spreadsheets: SpreadsheetDataService): AgentTool {
  const schema = z.object({ sheetName: z.string().trim().min(1).max(150) })
    .describe('{"sheetName":"exact spreadsheet tab name supplied by the user or trusted context"}');
  return {
    name: "inspect_spreadsheet",
    description: "Inspect the columns and a bounded sample of a specifically named spreadsheet tab before building a deterministic query. Use only when the user explicitly identifies a sheet or a scheduled objective already contains one.",
    capability: "knowledge",
    schema,
    sideEffect: "read",
    requiresRole: "superuser",
    async execute(input) {
      const result = await spreadsheets.inspectSheet(input.sheetName);
      return {
        status: "success",
        summary: result.columns.length
          ? `Spreadsheet '${result.sheetName}' inspected.`
          : `Spreadsheet '${result.sheetName}' returned no usable rows or columns.`,
        data: {
          ...result,
          sampleRows: result.sampleRows.map(boundSpreadsheetRow),
        },
      };
    },
  };
}

function querySpreadsheetTool(spreadsheets: SpreadsheetDataService): AgentTool {
  const filterSchema = z.object({
    column: z.string().trim().min(1).max(150),
    operator: z.enum(["equals", "not_equals", "contains", "empty", "not_empty"]),
    value: z.string().max(500).optional(),
  }).superRefine((filter, context) => {
    if (!["empty", "not_empty"].includes(filter.operator) && filter.value === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `${filter.operator} requires a value.` });
    }
  });
  const schema = z.object({
    sheetName: z.string().trim().min(1).max(150),
    filters: z.array(filterSchema).max(8).default([]),
    selectColumns: z.array(z.string().trim().min(1).max(150)).min(1).max(12),
    limit: z.number().int().min(1).max(100).default(50),
  }).describe(JSON.stringify({
    sheetName: "exact inspected spreadsheet tab name",
    filters: [{ column: "exact inspected column", operator: "equals, not_equals, contains, empty, or not_empty", value: "required except for empty/not_empty" }],
    selectColumns: ["one or more exact inspected columns to return"],
    limit: "1-100, defaults to 50",
  }));
  return {
    name: "query_spreadsheet",
    description: "Query a specifically named spreadsheet tab with deterministic filters and a bounded projection. Inspect the sheet first; never invent column names. This returns current rows, not a final message.",
    capability: "knowledge",
    schema,
    sideEffect: "read",
    requiresRole: "superuser",
    async execute(input) {
      const result = await spreadsheets.querySheet(input);
      return {
        status: "success",
        summary: `${result.matchedRows} spreadsheet row(s) matched the deterministic query.`,
        data: { ...result, rows: result.rows.map(boundSpreadsheetRow) },
      };
    },
  };
}

function boundSpreadsheetRow(row: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value.slice(0, 1_000)]));
}

function createScheduledAgentTaskTool(tasks: ScheduledAgentTaskManager): AgentTool {
  const schema = z.object({
    objective: z.string().trim().min(1).max(2_000),
    rawSchedulePhrase: z.string().trim().min(1).max(300),
  }).describe(JSON.stringify({
    objective: "schedule-independent objective to perform on every run",
    rawSchedulePhrase: "the user's complete recurring date/time words, such as every month on the 28th at 6pm",
  }));
  return {
    name: "create_scheduled_agent_task",
    description: "Create a recurring agent task from an explicit remind command. Supply a reusable objective and the user's untouched recurring schedule phrase. The backend parses recurrence, saves the task, schedules it, and activates its first run immediately.",
    capability: "workflow",
    schema,
    sideEffect: "write",
    requiresRole: "superuser",
    async execute(input, context) {
      const message = context.event.message;
      const ownerMemberId = context.actor?.id;
      const chatId = context.event.chatId;
      if (!message || !ownerMemberId || !chatId) {
        return { status: "error", summary: "A resolved member and current group conversation are required.", error: "missing_task_owner" };
      }
      if (!isExplicitReminderActivation(message.text)) {
        return {
          status: "denied",
          summary: "A recurring agent task requires an explicit remind command.",
          error: "explicit_reminder_required",
          retryable: false,
        };
      }
      const saved = await tasks.create({ chatId, ownerMemberId, ...input });
      if (saved.error) {
        return {
          status: "success",
          summary: "The recurring task was not created because its definition was incomplete.",
          reply: { text: `Recurring reminder wasn't created.\n\nReason: ${saved.error}` },
        };
      }
      if (!saved.task) {
        return { status: "error", summary: "The recurring task could not be loaded after creation.", error: "task_not_loaded" };
      }
      if (!saved.created) {
        return {
          status: "success",
          summary: "An identical recurring task is already active.",
          reply: { text: "That recurring reminder is already active." },
        };
      }
      return {
        status: "success",
        summary: "The recurring task was created and is ready for its immediate first run.",
        data: { scheduledTaskId: saved.task.id, created: true },
        // An empty internal response stops this planning turn. EchoAgentService
        // immediately activates the actual objective and delivers that result.
        reply: { text: "", metadata: { scheduledAgentTask: { taskId: saved.task.id } } },
      };
    },
  };
}

function listScheduledAgentTasksTool(tasks: ScheduledAgentTaskManager): AgentTool {
  const schema = z.object({}).describe("{}");
  return {
    name: "list_scheduled_agent_tasks",
    description: "List the current member's active and paused recurring agent tasks in this conversation.",
    capability: "workflow",
    schema,
    sideEffect: "read",
    requiresRole: "superuser",
    async execute(_input, context) {
      if (!context.actor || !context.event.chatId) {
        return { status: "error", summary: "A resolved member and current conversation are required.", error: "missing_task_owner" };
      }
      const values = await tasks.listOwned(context.actor.id, context.event.chatId);
      return {
        status: "success",
        summary: values.length ? `${values.length} recurring task(s) loaded.` : "No recurring tasks are active or paused.",
        data: values.map((task) => ({
          id: task.id,
          objective: task.objective,
          schedule: describeRecurringSchedule(task.schedule),
          status: task.status,
          nextRunAt: task.nextRunAt,
        })),
      };
    },
  };
}

function manageScheduledAgentTaskTool(tasks: ScheduledAgentTaskManager): AgentTool {
  const schema = z.object({
    taskId: z.string().uuid(),
    action: z.enum(["pause", "resume", "cancel", "update"]),
    objective: z.string().trim().min(1).max(2_000).optional(),
    rawSchedulePhrase: z.string().trim().min(1).max(300).optional(),
  }).superRefine((input, context) => {
    if (input.action === "update" && !input.objective && !input.rawSchedulePhrase) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "An update requires an objective or recurring schedule phrase." });
    }
  }).describe(JSON.stringify({
    taskId: "task UUID returned by list_scheduled_agent_tasks",
    action: "pause, resume, cancel, or update",
    objective: "optional replacement objective for update",
    rawSchedulePhrase: "optional complete replacement recurring phrase for update",
  }));
  return {
    name: "manage_scheduled_agent_task",
    description: "Pause, resume, cancel or update one of the current member's recurring agent tasks. Backend ownership is authoritative.",
    capability: "workflow",
    schema,
    sideEffect: "write",
    requiresRole: "superuser",
    async execute(input, context) {
      if (!context.actor) return { status: "denied", summary: "A resolved task owner is required.", error: "permission_denied" };
      const result = await tasks.manage({
        id: input.taskId,
        ownerMemberId: context.actor.id,
        action: input.action,
        objective: input.objective,
        rawSchedulePhrase: input.rawSchedulePhrase,
      });
      if (result.error || !result.task) {
        return { status: "denied", summary: result.error ?? "The scheduled task could not be changed.", error: "scheduled_task_update_denied" };
      }
      return {
        status: "success",
        summary: `Scheduled task ${input.action} completed.`,
        data: {
          id: result.task.id,
          status: result.task.status,
          objective: result.task.objective,
          schedule: describeRecurringSchedule(result.task.schedule),
          nextRunAt: result.task.nextRunAt,
        },
      };
    },
  };
}

function onboardCurrentSenderTool(
  identities: IdentityRepository,
  memory: MemoryRepository,
  refreshDirectory?: () => Promise<void>,
): AgentTool {
  const schema = z.object({}).describe("{}");
  return {
    name: "onboard_current_sender",
    description: "Create the unknown current sender as an ordinary member when and only when the backend marks this as the configured choir group. Continue the original task after onboarding.",
    schema,
    sideEffect: "write",
    async execute(_input, context) {
      if (context.actor) {
        return {
          status: "denied",
          summary: "The current sender is already an identified member.",
          error: "sender_already_resolved",
        };
      }
      const message = context.event.message;
      if (!message || !context.event.chatId) {
        return { status: "error", summary: "Onboarding requires a current group message.", error: "missing_message" };
      }
      if (message.metadata.conversationKind !== "choir") {
        return { status: "denied", summary: "Automatic membership is restricted to the configured choir group.", error: "untrusted_conversation" };
      }
      const member = await identities.onboardSender({
        sender: message.sender,
        transport: message.transport,
        chatId: context.event.chatId,
      });
      await memory.updateMemberProfile({
        memberId: member.id,
        transport: message.transport,
        transportName: message.sender.displayName,
        preferredDisplayName: message.sender.displayName,
        aliases: [],
      });
      await refreshDirectory?.();
      return {
        status: "success",
        summary: "The current choir-group sender was onboarded and their profile context is now available.",
        data: { memberId: member.id, displayName: member.displayName, roles: member.roles },
        refreshContext: true,
      };
    },
  };
}

function updateOwnMemberProfileTool(
  memory: MemoryRepository,
  refreshDirectory?: () => Promise<void>,
): AgentTool {
  const schema = z.object({
    preferredDisplayName: z.string().trim().min(1).max(100).optional(),
    aliases: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  }).describe(JSON.stringify({
    preferredDisplayName: "optional preferred name, 1-100 characters",
    aliases: ["optional supported alias; maximum 10; defaults to an empty array"],
  }));
  return {
    name: "update_own_member_profile",
    description: "Learn the current member's preferred display name and aliases. Use when the observed transport name or explicit conversation evidence differs from profile memory.",
    schema,
    sideEffect: "write",
    requiresRole: "member",
    async execute(input, context) {
      const memberId = context.actor?.id;
      const message = context.event.message;
      if (!memberId || !message) {
        return { status: "error", summary: "A resolved current member is required.", error: "unknown_member" };
      }
      const profile = await memory.updateMemberProfile({
        memberId,
        transport: message.transport,
        transportName: message.sender.displayName,
        preferredDisplayName: input.preferredDisplayName,
        aliases: input.aliases,
      });
      await refreshDirectory?.();
      return { status: "success", summary: "Member profile memory updated.", data: profile, refreshContext: true };
    },
  };
}

function setCanonicalMemberNameTool(
  identities: IdentityRepository,
  refreshDirectory?: () => Promise<void>,
): AgentTool {
  const schema = z.object({
    memberId: z.string().uuid(),
    canonicalName: z.string().trim().min(1).max(150),
    confirmed: z.boolean().default(false),
  }).describe(JSON.stringify({
    memberId: "member UUID",
    canonicalName: "canonical schedule name, 1-150 characters",
    confirmed: false,
  }));
  return {
    name: "set_member_canonical_name",
    description: "Reconcile a member with a reliable canonical choir or schedule name. Use only with direct evidence; ambiguous changes require creator confirmation.",
    schema,
    sideEffect: "write",
    requiresRole: "creator",
    requiresConfirmation: true,
    async execute(input, context) {
      if (!context.actor) return { status: "denied", summary: "A creator identity is required.", error: "permission_denied" };
      await identities.setCanonicalName({
        actorMemberId: context.actor.id,
        memberId: input.memberId,
        canonicalName: input.canonicalName,
      });
      await refreshDirectory?.();
      return { status: "success", summary: "Canonical member name updated." };
    },
  };
}

/** Echo's current choir-specific tools, registered by the choir domain plugin. */
export function createChoirAgentTools(dependencies: CoreToolDependencies): AgentTool[] {
  return [
    createReminderTool(dependencies.workflows),
    continueReminderTool(dependencies.workflows),
    submitSetlistTool(dependencies.workflows),
    ...(dependencies.rotaReminder ? [
      prepareRotaReminderTool(dependencies.rotaReminder, "sunday"),
      prepareRotaReminderTool(dependencies.rotaReminder, "midweek"),
    ] : []),
    ...(dependencies.setlistOperations ? [
      planWeeklySetlistNudgesTool(dependencies.setlistOperations),
      prepareSetlistNudgeTool(dependencies.setlistOperations),
      prepareSetlistBroadcastTool(dependencies.setlistOperations),
    ] : []),
    retrieveKnowledgeTool(dependencies.knowledge),
    readWeekScheduleTool(dependencies.knowledge, dependencies.weeklyInterpretations),
    syncIfStaleTool(dependencies.sync),
  ];
}

function planWeeklySetlistNudgesTool(service: SetlistOperationsService): AgentTool {
  const schema = z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).describe('{"weekStart":"optional YYYY-MM-DD Monday; the scheduled event value is authoritative"}');
  return {
    name: "plan_weekly_setlist_nudges",
    description: "Validate the target service week and persist all applicable weekday setlist nudges in one operation. Use this directly for setlist_weekly_planning_due events.",
    capability: "choir_operations",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      const weekStart = eventWeekStart(context.event.payload.weekStart, input.weekStart);
      if (!weekStart) return missingSetlistEventField("planning", "weekStart");
      if (!context.event.chatId) return missingSetlistEventField("planning", "chatId");
      const prepared = await service.planWeeklyNudges({
        weekStart,
        chatId: context.event.chatId,
        signal: context.signal,
      });
      return setlistOperationToolResult(prepared, "setlist_planning_evidence_insufficient");
    },
  };
}

function prepareSetlistNudgeTool(service: SetlistOperationsService): AgentTool {
  const schema = z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).describe('{"weekStart":"optional YYYY-MM-DD Monday; the scheduled event value is authoritative"}');
  return {
    name: "prepare_setlist_nudge",
    description: "Prepare a complete source-validated, submission-aware and mention-ready setlist nudge in one operation. Use this directly for setlist_followup_due events.",
    capability: "choir_operations",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      const eventWeekStart = context.event.payload.weekStart;
      const weekStart = typeof eventWeekStart === "string" ? eventWeekStart : input.weekStart;
      if (!weekStart) {
        return {
          status: "error",
          summary: "The scheduled setlist nudge did not include a service week.",
          error: "missing_week_start",
          retryable: false,
        };
      }
      const transport = typeof context.event.payload.transport === "string"
        ? context.event.payload.transport
        : context.event.message?.transport ?? "unknown";
      const prepared = await service.prepareNudge({ weekStart, transport, signal: context.signal });
      return setlistOperationToolResult(prepared, "setlist_nudge_evidence_insufficient");
    },
  };
}

function prepareSetlistBroadcastTool(service: SetlistOperationsService): AgentTool {
  const schema = z.object({
    submissionId: z.string().uuid().optional(),
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).describe('{"submissionId":"optional submission UUID; the scheduled event value is authoritative","weekStart":"optional YYYY-MM-DD Monday; the scheduled event value is authoritative"}');
  return {
    name: "prepare_setlist_broadcast",
    description: "Validate the target service week and prepare its pending setlist broadcast in one operation. Use this directly for setlist_broadcast_due events.",
    capability: "choir_operations",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      const weekStart = eventWeekStart(context.event.payload.weekStart, input.weekStart);
      if (!weekStart) return missingSetlistEventField("broadcast", "weekStart");
      const eventSubmissionId = context.event.payload.submissionId;
      const submissionId = typeof eventSubmissionId === "string" ? eventSubmissionId : input.submissionId;
      if (!submissionId) return missingSetlistEventField("broadcast", "submissionId");
      const prepared = await service.prepareBroadcast({ weekStart, submissionId, signal: context.signal });
      return setlistOperationToolResult(prepared, "setlist_broadcast_evidence_insufficient");
    },
  };
}

function eventWeekStart(eventValue: unknown, inputValue: string | undefined): string | undefined {
  return typeof eventValue === "string" ? eventValue : inputValue;
}

function missingSetlistEventField(operation: string, field: string) {
  return {
    status: "error" as const,
    summary: `The scheduled setlist ${operation} did not include ${field}.`,
    error: `missing_${field.replace(/([A-Z])/g, "_$1").toLowerCase()}`,
    retryable: false,
  };
}

function setlistOperationToolResult(
  prepared: SetlistOperationResult,
  evidenceError: string,
) {
  if (prepared.status === "insufficient_evidence") {
    return {
      status: "error" as const,
      summary: prepared.summary,
      error: evidenceError,
      nonFatal: true,
      retryable: false,
      turnControl: "complete" as const,
    };
  }
  return {
    status: "success" as const,
    summary: prepared.summary,
    turnControl: "complete" as const,
    ...(prepared.reply ? { reply: prepared.reply } : {}),
    ...(prepared.planned !== undefined ? { data: { planned: prepared.planned } } : {}),
  };
}

function prepareRotaReminderTool(service: RotaReminderService, kind: "sunday" | "midweek"): AgentTool {
  const dayName = kind === "sunday" ? "Sunday" : "Wednesday";
  const schema = z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).describe('{"weekStart":"optional YYYY-MM-DD Monday; the scheduled event value is authoritative"}');
  return {
    name: kind === "sunday" ? "prepare_sunday_rota_reminder" : "prepare_midweek_rota_reminder",
    description: `Prepare the complete source-validated ${dayName} choir rota reminder in one operation. Use this directly for ${kind === "sunday" ? "weekly_rota_reminder_due" : "midweek_rota_reminder_due"}; it retrieves the target week, assesses applicability, saves or reuses the interpretation, resolves members and returns the readable mention-ready message.`,
    capability: "choir_operations",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      const eventWeekStart = context.event.payload.weekStart;
      const weekStart = typeof eventWeekStart === "string" ? eventWeekStart : input.weekStart;
      if (!weekStart) {
        return {
          status: "error",
          summary: `The scheduled ${dayName} reminder did not include a service week.`,
          error: "missing_week_start",
          retryable: false,
        };
      }
      const transport = typeof context.event.payload.transport === "string"
        ? context.event.payload.transport
        : context.event.message?.transport ?? "unknown";
      const prepared = await service.prepare({ weekStart, transport, kind, signal: context.signal });
      if (prepared.status === "insufficient_evidence") {
        return {
          status: "error",
          summary: prepared.summary,
          error: `${kind}_rota_evidence_insufficient`,
          nonFatal: true,
          retryable: false,
          turnControl: "complete",
        };
      }
      return {
        status: "success",
        summary: prepared.summary,
        turnControl: "complete",
        ...(prepared.reply ? { reply: prepared.reply } : {}),
      };
    },
  };
}

function upsertObligationTool(
  obligations: ObligationRepository,
  onSaved?: (obligation: import("../types.js").AgentObligation) => void,
): AgentTool {
  const schema = z.object({
    naturalKey: z.string().min(1).max(300),
    type: z.string().min(1).max(100),
    chatId: z.string().optional(),
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    assignedMemberIds: z.array(z.string().uuid()).max(30).default([]),
    dueAt: z.string().datetime().optional(),
    payload: z.record(z.unknown()).default({}),
  }).describe(JSON.stringify({
    naturalKey: "stable unique obligation key",
    type: "obligation event type",
    chatId: "optional chat ID; defaults to the current chat",
    weekStart: "optional YYYY-MM-DD",
    assignedMemberIds: ["optional member UUID; defaults to an empty array"],
    dueAt: "optional ISO datetime",
    payload: { field: "optional JSON payload; defaults to an empty object" },
  }));
  return {
    name: "upsert_obligation",
    description: "Persist an ongoing choir responsibility. Scheduler events may create obligations; chat users must be superusers.",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      const systemEvent = context.event.source === "scheduler" || context.event.source === "system";
      const privileged = context.actor?.roles.some((role) => role === "superuser" || role === "creator");
      if (!systemEvent && !privileged) {
        return { status: "denied", summary: "The sender cannot create operational obligations.", error: "permission_denied" };
      }
      const chatId = input.chatId ?? context.event.chatId;
      if (!chatId) return { status: "error", summary: "An obligation requires a chat ID.", error: "missing_chat_id" };
      const obligation = await obligations.upsert({
        naturalKey: input.naturalKey,
        type: input.type,
        chatId,
        weekStart: input.weekStart,
        assignedMemberIds: input.assignedMemberIds,
        status: "pending",
        dueAt: input.dueAt,
        payload: input.payload,
        lastEvaluatedAt: clockService.now().toISO()!,
      });
      onSaved?.(obligation);
      return { status: "success", summary: "Operational obligation saved.", data: obligation };
    },
  };
}

function currentTimeTool(): AgentTool {
  const schema = z.object({ timezone: z.string().default("Europe/London") })
    .describe('{"timezone":"Europe/London"}');
  return {
    name: "get_current_time",
    description: "Read Echo's centralized application clock. Use this for all current date and time decisions.",
    schema,
    sideEffect: "read",
    async execute(input) {
      const now = clockService.now(input.timezone);
      return {
        status: "success",
        summary: `Current time is ${now.toFormat("cccc, d LLLL yyyy 'at' h:mm a ZZZZ")}.`,
        data: { iso: now.toISO(), timezone: input.timezone, weekStart: now.startOf("week").toISODate() },
      };
    },
  };
}

function createReminderTool(workflows: ChoirWorkflowService): AgentTool {
  const schema = z.object({
    rawDatePhrase: z.string().min(1).max(200).nullable(),
    reminderMessage: z.string().min(1).max(2_000).nullable(),
  }).describe('{"rawDatePhrase":"exact verbatim date/time substring from the current user message, or null when absent","reminderMessage":"what to remind the user about, or null to use quoted text"}');
  return {
    name: "create_reminder",
    description: "Prepare an explicitly requested reminder for confirmation. Copy rawDatePhrase verbatim from the current message only; never infer it or take it from quoted text, history, memory or external data. The backend verifies its origin and resolves the timestamp.",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      if (!context.event.message) return { status: "error", summary: "No transport message is available.", error: "missing_message" };
      const reply = await workflows.createReminder({ message: context.event.message, ...input });
      return { status: "success", summary: "The reminder request was validated and prepared.", reply };
    },
  };
}

function continueReminderTool(workflows: ChoirWorkflowService): AgentTool {
  const schema = z.object({
    action: z.enum(["confirm", "decline", "edit", "request_cancel"]).optional(),
    rawDatePhrase: z.string().min(1).max(200).nullable().optional(),
    reminderMessage: z.string().min(1).max(2_000).nullable().optional(),
  }).describe('{"action":"confirm, decline, edit, or request_cancel; optional for an exact YES, NO, EDIT..., or cancel reminder reply because the backend derives it","rawDatePhrase":"for edit only: complete replacement raw date/time phrase, otherwise null","reminderMessage":"for edit only: replacement reminder content, otherwise null"}');
  return {
    name: "continue_reminder",
    description: "Continue a reminder by replying directly to its confirmation. Ownership, reply-chain resolution and state transitions are enforced by the backend.",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      if (!context.event.message) return { status: "error", summary: "No transport message is available.", error: "missing_message" };
      const action = input.action ?? parseReminderReplyAction(context.event.message.text);
      if (!action) {
        return {
          status: "error",
          summary: "The reminder reply must explicitly say YES, NO, EDIT, or cancel reminder.",
          error: "missing_reminder_action",
          retryable: false,
        };
      }
      const reply = await workflows.continueReminder({ message: context.event.message, ...input, action });
      return { status: "success", summary: "The quoted reminder workflow was resolved.", reply };
    },
  };
}

function submitSetlistTool(workflows: ChoirWorkflowService): AgentTool {
  const schema = z.object({
    scope: z.enum(["combined", "worship", "praise"]),
  }).describe('{"scope":"combined for a complete ordinary setlist, worship for worship-only, or praise for praise-only"}');
  return {
    name: "submit_setlist",
    description: "Save or correct a #submit_setlist submission. Classify its content as combined, worship-only or praise-only; backend leader validation and week selection remain authoritative.",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      if (!context.event.message) return { status: "error", summary: "No transport message is available.", error: "missing_message" };
      const reply = await workflows.submitSetlist({ message: context.event.message, scope: input.scope });
      return { status: "success", summary: "The explicit setlist submission was validated.", reply };
    },
  };
}

function retrieveKnowledgeTool(knowledge: ChoirKnowledgeService): AgentTool {
  const schema = z.object({
    query: z.string().min(1).max(1000),
    sourceIds: z.array(z.enum(RETRIEVAL_SOURCE_IDS)).min(1).max(4),
    semanticSearch: z.boolean().default(false),
  }).describe('{"query":"standalone information need","sourceIds":["one or more semantic source IDs"],"semanticSearch":false}');
  return {
    name: "retrieve_choir_knowledge",
    description: `Retrieve current choir evidence from one or more semantic sources. Available source IDs: ${RETRIEVAL_SOURCE_IDS.join(", ")}. Select every materially relevant source and use semanticSearch for ambiguous or unstructured needs. Returns evidence and provenance, not a final answer.`,
    schema,
    sideEffect: "read",
    async execute(input) {
      const result = await knowledge.retrieve(input.query, {
        sourceIds: input.sourceIds,
        semanticSearch: input.semanticSearch,
      });
      const evidenceQuality = assessEvidenceQuality(result.context, result.provenance);
      const { sourceHash: _sourceHash, ...plannerResult } = result;
      return {
        status: "success",
        summary: `Choir information retrieved; evidence is ${evidenceQuality.status}.`,
        data: { ...plannerResult, evidenceQuality },
      };
    },
  };
}

function readWeekScheduleTool(
  knowledge: ChoirKnowledgeService,
  interpretations: WeeklyInterpretationRepository,
): AgentTool {
  const schema = z.object({ weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
    .describe('{"weekStart":"optional YYYY-MM-DD Monday; omit for the current service week"}');
  return {
    name: "read_week_schedule",
    description: "Retrieve the complete schedule context for a specific service week and reuse a cached semantic interpretation only when its source hash still matches.",
    schema,
    sideEffect: "read",
    async execute(input) {
      const weekStart = input.weekStart ?? getMondayOfWeek();
      const parsedWeekStart = DateTime.fromISO(weekStart, { zone: "Europe/London" }).startOf("day");
      const weekEnd = parsedWeekStart.plus({ days: 6 }).toISODate()!;
      const result = await knowledge.retrieve(
        `Return scheduled choir activities, services, rehearsals, events and assignments from Monday ${weekStart} through Sunday ${weekEnd}, inclusive.`,
        { sourceIds: ["monthly_rota", "annual_events"], semanticSearch: false },
      );
      const sourceHash = result.sourceHash ?? sha256(result.context);
      const cached = await interpretations.get(weekStart, sourceHash);
      const evidenceQuality = assessEvidenceQuality(result.context, result.provenance, true);
      const scheduleContext = [
        `Target service window: Monday ${weekStart} through Sunday ${weekEnd}, inclusive.`,
        "Every retained dated assignment falls inside this target window. Source section labels such as 'Week of' are grouping metadata and do not move an ending-Sunday assignment into another service week.",
        result.context,
      ].join("\n\n").slice(0, AGENT_CONTEXT_LIMITS.weeklyEvidenceCharacters);
      return {
        status: "success",
        summary: cached
          ? "Weekly evidence and its matching cached interpretation were loaded."
          : `Weekly evidence was retrieved with ${result.provenance?.coverage ?? "unknown"} source coverage and requires semantic interpretation.`,
        data: {
          weekStart,
          weekEnd,
          targetWindow: { start: weekStart, end: weekEnd, inclusive: true },
          ...(cached ? {} : { scheduleContext }),
          retrievalProvenance: result.provenance,
          evidenceQuality,
          cachedInterpretation: cached?.interpretation ?? null,
        },
      };
    },
  };
}

function syncIfStaleTool(sync: SyncCoordinator): AgentTool {
  const schema = z.object({ reason: z.string().min(1).max(500), force: z.boolean().default(false) })
    .describe('{"reason":"why fresh data is needed","force":false}');
  return {
    name: "sync_if_stale",
    description: "Recovery tool available only after retrieval returns empty or materially sparse evidence. It checks the 24-hour synchronization window before refreshing Google Sheets. Set force=true only for an explicit privileged sync request.",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      if (input.force && !context.actor?.roles.some((role) => role === "superuser" || role === "creator")) {
        return { status: "denied", summary: "Only a privileged member can force synchronization.", error: "permission_denied" };
      }
      try {
        const result = await sync.syncIfStale(input);
        return {
          status: "success",
          summary: result.summary,
          data: { synced: result.synced, sourceChanged: result.sourceChanged, summary: result.summary },
        };
      } catch (error) {
        return {
          status: "error",
          summary: "Synchronization recovery did not complete. Continue with the existing evidence and do not retry synchronization in this turn.",
          error: error instanceof Error ? error.message : String(error),
          nonFatal: true,
        };
      }
    },
  };
}

function resolveMembersTool(identities: IdentityRepository): AgentTool {
  const schema = z.object({ names: z.array(z.string().min(1)).min(1).max(20) })
    .describe('{"names":["canonical or commonly used member name"]}');
  return {
    name: "resolve_members",
    description: "Map names or aliases to canonical choir members without exposing phone numbers.",
    schema,
    sideEffect: "read",
    async execute(input) {
      const resolved = (await identities.resolveByNames(input.names)).map(({ name, matches }) => ({
        name,
        matches: matches.map(({ id, canonicalName, displayName, roles }) => ({ id, canonicalName, displayName, roles })),
      }));
      return { status: "success", summary: "Member identities resolved.", data: resolved };
    },
  };
}

function composeMemberMessageTool(identities: IdentityRepository): AgentTool {
  const schema = z.object({
    text: z.string().min(1).max(4000),
    memberNames: z.array(z.string().min(1)).min(1).max(20),
  }).describe('{"text":"message using member display names","memberNames":["names to mention"]}');
  return {
    name: "compose_member_message",
    description: "Prepare a transport response with real mentions for canonical members. Use only after names are supported by current schedule or conversation evidence.",
    schema,
    sideEffect: "read",
    async execute(input, context) {
      const memberIds: string[] = [];
      const mentionLabels: string[] = [];
      let text = input.text;
      const allowUntargeted = context.event.payload.allowUntargetedMessage === true;
      const resolvedNames = await identities.resolveByNames(input.memberNames);
      for (const { name, matches } of resolvedNames) {
        if (matches.length !== 1) {
          if (allowUntargeted) continue;
          return { status: "error", summary: `Could not uniquely resolve '${name}'.`, error: "ambiguous_member" };
        }
        memberIds.push(matches[0].id);
        const label = matches[0].displayName || matches[0].canonicalName || name;
        mentionLabels.push(label);
        text = text.replace(new RegExp(escapeRegExp(name), "gi"), `@${label}`);
      }
      const transport = context.event.message?.transport ?? String(context.event.payload.transport ?? "unknown");
      const mentions = await identities.getMentionTargets(memberIds, transport);
      if (mentions.length !== memberIds.length) {
        if (allowUntargeted) {
          return { status: "success", summary: "Group message prepared without unavailable mentions.", reply: { text, mentions } };
        }
        return { status: "error", summary: `At least one member has no verified ${transport} identifier.`, error: "member_not_mentionable" };
      }
      text = ensureMentionLabels(text, mentionLabels);
      return { status: "success", summary: "Mention-ready message prepared.", reply: { text, mentions, mentionLabels } };
    },
  };
}

function ensureMentionLabels(text: string, labels: string[]): string {
  const missing = labels.filter((label) =>
    !new RegExp(`@${escapeRegExp(label)}(?=$|\\s|[.,!?;:])`, "i").test(text),
  );
  if (missing.length === 0) return text;
  return `${missing.map((label) => `@${label}`).join(" ")} ${text}`;
}

function rememberMemberFactTool(memory: MemoryRepository): AgentTool {
  const schema = z.object({
    memberId: z.string().uuid().optional(),
    category: z.enum(["preference", "availability", "communication", "choir"]),
    fact: z.string().min(1).max(500),
    importance: z.enum(["low", "normal", "high"]).default("normal"),
  }).describe(JSON.stringify({
    memberId: "optional member UUID; defaults to the current sender",
    category: "preference, availability, communication, or choir",
    fact: "directly supported non-sensitive fact, 1-500 characters",
    importance: "low, normal, or high; defaults to normal",
  }));
  return {
    name: "remember_member_fact",
    description: "Store or reinforce a bounded, non-sensitive member fact for conversational continuity. Never infer facts or store phone, address, medical, financial or authentication information.",
    schema,
    sideEffect: "write",
    requiresRole: "member",
    async execute(input, context) {
      const memberId = input.memberId ?? context.actor?.id;
      if (!memberId) return { status: "error", summary: "The member could not be identified.", error: "unknown_member" };
      if (memberId !== context.actor?.id && !context.actor?.roles.includes("creator")) {
        return { status: "denied", summary: "A member can only add memories about themselves.", error: "permission_denied" };
      }
      await memory.rememberMemberFact({
        memberId,
        category: input.category,
        fact: input.fact,
        sourceMessageId: context.event.message?.id,
        importance: input.importance,
        verified: memberId === context.actor?.id,
      });
      return { status: "success", summary: "Member memory updated." };
    },
  };
}

function addMemberIdentifierTool(
  identities: IdentityRepository,
  refreshDirectory?: () => Promise<void>,
): AgentTool {
  const schema = z.object({
    memberId: z.string().uuid(),
    kind: z.enum(["phone", "whatsapp_jid", "push_name", "alias"]),
    value: z.string().min(1).max(200),
    confirmed: z.boolean().default(false),
  }).describe(JSON.stringify({
    memberId: "member UUID",
    kind: "phone, whatsapp_jid, push_name, or alias",
    value: "identifier value, 1-200 characters",
    confirmed: false,
  }));
  return {
    name: "add_member_identifier",
    description: "Add or correct a member phone, WhatsApp JID or alias. This is audited private data and always requires creator confirmation.",
    schema,
    sideEffect: "write",
    requiresRole: "creator",
    requiresConfirmation: true,
    async execute(input) {
      await identities.addIdentifier({
        memberId: input.memberId,
        kind: input.kind,
        value: input.value,
        verified: true,
      });
      await refreshDirectory?.();
      return { status: "success", summary: "Member identifier saved." };
    },
  };
}

function listObligationsTool(obligations: ObligationRepository): AgentTool {
  const schema = z.object({ chatId: z.string().optional() }).describe('{"chatId":"optional group id"}');
  return {
    name: "list_active_obligations",
    description: "Read pending choir obligations and their current statuses.",
    schema,
    sideEffect: "read",
    async execute(input, context) {
      const active = await obligations.listActive(input.chatId ?? context.event.chatId);
      return { status: "success", summary: `${active.length} active obligation(s) loaded.`, data: active };
    },
  };
}

function searchConversationHistoryTool(conversations: ConversationRepository): AgentTool {
  const schema = z.object({
    query: z.string().trim().min(2).max(300),
    limit: z.number().int().min(1)
      .max(agentConfig.context.historySearch.maximumLimit)
      .default(agentConfig.context.historySearch.defaultLimit),
  }).describe('{"query":"terms describing the earlier conversation","limit":5}');
  return {
    name: "search_conversation_history",
    description: "Search durable messages from the current chat when the small recent-message window is insufficient. Returns a bounded extract; refine the query instead of requesting the entire transcript.",
    schema,
    sideEffect: "read",
    async execute(input, context) {
      const chatId = context.event.chatId;
      if (!chatId) return { status: "error", summary: "Conversation search requires a current chat.", error: "missing_chat" };
      const matches = await conversations.search(chatId, input.query, input.limit);
      const compact = matches.map((entry) => ({
        ...entry,
        content: entry.content.slice(0, AGENT_CONTEXT_LIMITS.historySearchMessageCharacters),
      }));
      return {
        status: "success",
        summary: `${compact.length} relevant conversation message(s) found.`,
        data: {
          query: input.query,
          matches: compact,
          truncated: matches.some(
            (entry) => entry.content.length > AGENT_CONTEXT_LIMITS.historySearchMessageCharacters,
          ),
        },
      };
    },
  };
}

function readMemberMemoryTool(memory: MemoryRepository): AgentTool {
  const schema = z.object({
    memberId: z.string().uuid().optional(),
    query: z.string().trim().min(2).max(200).optional(),
    limit: z.number().int().min(1)
      .max(agentConfig.context.memberMemory.maximumSearchLimit)
      .default(agentConfig.context.memberMemory.defaultSearchLimit),
  }).describe(JSON.stringify({
    memberId: "optional member UUID; defaults to the current sender",
    query: "optional relevant member-fact search, 2-200 characters",
    limit: 5,
  }));
  return {
    name: "read_member_memory",
    description: "Load a bounded set of relevant member facts only when conversational continuity requires them. Members may read their own memory; creators may inspect another member for administration.",
    schema,
    sideEffect: "read",
    async execute(input, context) {
      const memberId = input.memberId ?? context.actor?.id;
      if (!memberId) return { status: "error", summary: "No member identity is available.", error: "unknown_member" };
      if (memberId !== context.actor?.id && !context.actor?.roles.includes("creator")) {
        return { status: "denied", summary: "Member memory is private to that member.", error: "permission_denied" };
      }
      const facts = await memory.getMemberFacts(memberId, input.limit, input.query);
      return { status: "success", summary: `${facts.length} relevant member fact(s) loaded.`, data: { memberId, facts } };
    },
  };
}

function readContextMemoryTool(memory: MemoryRepository): AgentTool {
  const schema = z.object({
    scope: z.enum(["agent", "chat", "member", "week"]),
    label: z.string().trim().min(1).max(100),
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).describe(JSON.stringify({
    scope: "agent, chat, member, or week",
    label: "memory label listed in memoryDirectory",
    weekStart: "required YYYY-MM-DD when scope is week; otherwise omit",
  }));
  return {
    name: "read_context_memory",
    description: "Read one available agent, chat, current-member or week memory block by label. Use memoryDirectory first and never guess private scope identifiers.",
    schema,
    sideEffect: "read",
    async execute(input, context) {
      const scopeId = input.scope === "agent"
        ? "echo"
        : input.scope === "chat"
          ? context.event.chatId
          : input.scope === "member"
            ? context.actor?.id
            : input.weekStart;
      if (!scopeId) return { status: "error", summary: `No ${input.scope} scope is available.`, error: "missing_scope" };
      const block = await memory.getBlock({ scopeType: input.scope, scopeId, label: input.label });
      if (!block) return { status: "success", summary: "The requested memory block was not found.", data: null };
      return {
        status: "success",
        summary: `Memory block '${block.label}' loaded.`,
        data: {
          ...block,
          value: block.value.slice(0, AGENT_CONTEXT_LIMITS.memoryBlockCharacters),
          truncated: block.value.length > AGENT_CONTEXT_LIMITS.memoryBlockCharacters,
        },
      };
    },
  };
}

function updateObligationTool(obligations: ObligationRepository): AgentTool {
  const schema = z.object({
    obligationId: z.string().uuid(),
    status: z.enum(["pending", "waiting_for_data", "waiting_for_member", "satisfied", "not_applicable", "cancelled", "failed"]),
    reason: z.string().min(1).max(1000),
  }).describe(JSON.stringify({
    obligationId: "obligation UUID",
    status: "pending, waiting_for_data, waiting_for_member, satisfied, not_applicable, cancelled, or failed",
    reason: "evidence-based reason, 1-1000 characters",
  }));
  return {
    name: "update_obligation_status",
    description: "Update an existing obligation. Scheduler events may update their own obligations; chat users must be superusers.",
    schema,
    sideEffect: "write",
    async execute(input, context) {
      const systemEvent = context.event.source === "scheduler" || context.event.source === "system";
      const privileged = context.actor?.roles.some((role) => role === "superuser" || role === "creator");
      if (!systemEvent && !privileged) {
        return { status: "denied", summary: "The sender cannot change operational obligations.", error: "permission_denied" };
      }
      const updated = await obligations.updateStatus(input.obligationId, input.status, input.reason);
      return { status: "success", summary: `Obligation marked ${updated.status}.`, data: updated };
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface RetrievalProvenanceLike {
  coverage?: "complete" | "partial" | "none";
  missingSources?: string[];
  temporalCoverage?: "not_requested" | "matched" | "unmatched";
}

/** Produces a deterministic signal the planner can use before requesting sync recovery. */
function assessEvidenceQuality(
  context: string,
  provenance?: RetrievalProvenanceLike,
  requireTemporalMatch = false,
): {
  status: "sufficient" | "sparse" | "empty";
  reasons: string[];
  nonEmptyLines: number;
  blankRows: number;
} {
  const lines = context.split(/\r?\n/);
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0).length;
  const blankRows = lines.filter((line) => {
    const compact = line.replace(/[|,;:\[\]{}"']/g, "").replace(/\s/g, "");
    return line.trim().length > 0 && compact.length === 0;
  }).length;
  const reasons: string[] = [];

  if (!context.trim() || provenance?.coverage === "none") {
    reasons.push(!context.trim() ? "No evidence text was returned." : "No selected source returned evidence.");
    return { status: "empty", reasons, nonEmptyLines, blankRows };
  }
  if (requireTemporalMatch && provenance?.temporalCoverage !== "matched") {
    reasons.push("No dated evidence matched the requested service week.");
    return { status: "empty", reasons, nonEmptyLines, blankRows };
  }
  // Partial coverage is provenance, not proof that the returned evidence is
  // unusable. A missing optional source alone must not cause a recovery sync.
  if (context.trim().length < 80 || nonEmptyLines < 2) reasons.push("Very little usable evidence was returned.");
  if (blankRows > 0 && blankRows >= Math.max(1, Math.floor(nonEmptyLines / 2))) {
    reasons.push("A material portion of the returned rows is blank.");
  }
  return {
    status: reasons.length > 0 ? "sparse" : "sufficient",
    reasons,
    nonEmptyLines,
    blankRows,
  };
}
