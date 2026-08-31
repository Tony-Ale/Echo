import { z } from "zod";
import { agentConfig } from "../../config/agentConfig.js";
import { AGENT_CONTEXT_LIMITS } from "./contextLimits.js";
import {
  isExplicitReminderActivation,
  isExplicitWorkflowActivation,
} from "../../workflows/workflowDetection.js";
import type {
  AgentEvent,
  AgentExecutionContext,
  AgentStep,
  AgentTool,
  AgentToolCapability,
  AgentToolResult,
  AgentTurnContext,
  MemberRole,
} from "../types.js";

const CAPABILITY_DESCRIPTIONS: Readonly<Record<AgentToolCapability, string>> = {
  conversation: "Current time and bounded conversation continuity.",
  knowledge: "Read current external choir information and recover a sparse index.",
  memory: "Read or update bounded persistent member and chat memory.",
  workflow: "Explicit reminder and setlist workflows.",
  choir_operations: "Interpret and carry out choir rota and setlist obligations.",
  identity: "Resolve members and prepare mention-ready messages.",
  scheduler: "Inspect or update persistent operational obligations.",
  administration: "Creator-only identity and private-data administration.",
};

const SCHEDULER_ONLY_TOOLS = new Set([
  "prepare_sunday_rota_reminder",
  "prepare_midweek_rota_reminder",
  "prepare_setlist_nudge",
  "plan_weekly_setlist_nudges",
  "prepare_setlist_broadcast",
]);

const REMINDER_EXTERNAL_CONTEXT_TOOLS = new Set([
  "retrieve_choir_knowledge",
  "read_week_schedule",
  "sync_if_stale",
  "inspect_spreadsheet",
  "query_spreadsheet",
]);

/**
 * Central tool registry and policy boundary.
 *
 * The model may request a tool, but only this class can validate its arguments,
 * authorize the actor and decide whether confirmation is required.
 */
export class AgentToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  public constructor(tools: AgentTool[] = []) {
    for (const tool of tools) this.register(tool);
    this.register(this.contextAcquisitionTool());
    this.register(capabilityActivationTool());
  }

  public register<TSchema extends z.ZodType>(tool: AgentTool<TSchema>): void {
    if (this.tools.has(tool.name)) throw new Error(`Agent tool '${tool.name}' is already registered.`);
    this.tools.set(tool.name, tool as AgentTool);
  }

  public catalog(): Array<{
    name: string;
    description: string;
    inputSchema: string;
    acceptsEmptyInput: boolean;
    sideEffect: AgentTool["sideEffect"];
    capability: AgentToolCapability;
  }> {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.schema.description ?? "Use the JSON fields documented in the tool description.",
      acceptsEmptyInput: tool.schema.safeParse({}).success,
      sideEffect: tool.sideEffect,
      capability: capabilityFor(tool),
    }));
  }

  /** Builds a small, event-specific catalogue while keeping execution centralized. */
  public catalogFor(event: AgentEvent, context: AgentTurnContext, previousSteps: AgentStep[]) {
    const active = initialCapabilities(event, context);
    for (const step of previousSteps) {
      const data = step.result?.data;
      if (isRecord(data) && typeof data.activatedCapability === "string" && isCapability(data.activatedCapability)) {
        active.add(data.activatedCapability);
      }
    }
    const syncAvailable = shouldExposeSync(previousSteps);
    return this.catalog().filter((tool) =>
      active.has(tool.capability)
      && isAllowedForEvent(event, tool.name)
      && isToolDiscoverable(this.tools.get(tool.name)!, event, context, previousSteps)
      && !CONTEXT_SOURCE_TOOLS.has(tool.name)
      && (tool.name !== "sync_if_stale" || syncAvailable)
    );
  }

  public capabilitiesFor(event: AgentEvent, context: AgentTurnContext, previousSteps: AgentStep[]) {
    const active = new Set(this.catalogFor(event, context, previousSteps).map((tool) => tool.capability));
    return (Object.keys(CAPABILITY_DESCRIPTIONS) as AgentToolCapability[]).map((id) => ({
      id,
      description: CAPABILITY_DESCRIPTIONS[id],
      active: active.has(id),
      toolNames: this.catalog()
        .filter((tool) =>
          tool.capability === id
          && isAllowedForEvent(event, tool.name)
          && !CONTEXT_SOURCE_TOOLS.has(tool.name)
          && isToolDiscoverable(this.tools.get(tool.name)!, event, context, previousSteps)
        )
        .map((tool) => tool.name),
    }));
  }

  /** Returns the capability for a known tool only when policy allows this event to discover it. */
  public activationForTool(
    event: AgentEvent,
    context: AgentTurnContext,
    previousSteps: AgentStep[],
    toolName: string,
  ): AgentToolCapability | null {
    const tool = this.tools.get(toolName);
    if (!tool || !isAllowedForEvent(event, toolName) || !isToolDiscoverable(tool, event, context, previousSteps)) return null;
    return capabilityFor(tool);
  }

  public async execute(
    toolName: string,
    rawInput: Record<string, unknown>,
    context: AgentExecutionContext,
  ): Promise<AgentToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) return { status: "error", summary: `Unknown tool '${toolName}'.`, error: "unknown_tool", retryable: false };
    if (!isAllowedForEvent(context.event, toolName)) {
      return { status: "denied", summary: `${toolName} is outside this turn's allowed tool set.`, error: "tool_not_allowed", retryable: false };
    }

    const parsed = tool.schema.safeParse(rawInput);
    if (!parsed.success) {
      return {
        status: "error",
        summary: `Invalid input for ${toolName}.`,
        error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        retryable: false,
      };
    }

    if (tool.requiresRole && !hasRole(context.actor?.roles ?? [], tool.requiresRole)) {
      return {
        status: "denied",
        summary: `The sender is not authorized to use ${toolName}.`,
        error: "permission_denied",
        retryable: false,
      };
    }

    if (tool.requiresConfirmation && parsed.data.confirmed !== true) {
      return {
        status: "approval_required",
        summary: `Explicit confirmation is required before ${toolName} can run.`,
        data: { toolName, proposedInput: parsed.data },
      };
    }

    try {
      return await tool.execute(parsed.data, context);
    } catch (error) {
      return {
        status: "error",
        summary: `${toolName} failed.`,
        error: error instanceof Error ? error.message : String(error),
        retryable: isRetryableToolException(error),
      };
    }
  }

  /** Validates planner-proposed continuation input before bypassing another planning call. */
  public acceptsInput(toolName: string, rawInput: Record<string, unknown>, event?: AgentEvent): boolean {
    if (event && !isAllowedForEvent(event, toolName)) return false;
    return this.tools.get(toolName)?.schema.safeParse(rawInput).success === true;
  }

  /** Retains only bounded, non-mutating calls as a reusable procedure hint. */
  public buildReusableProcedure(steps: AgentStep[]): import("../types.js").AgentProcedureStep[] {
    return steps.flatMap((step) => {
      if (step.decision.kind !== "tool" || step.result?.status !== "success") return [];
      const tool = this.tools.get(step.decision.toolName);
      if (!tool || !["none", "read"].includes(tool.sideEffect)) return [];
      if (["activate_capability", "get_current_time"].includes(tool.name)) return [];
      const serialized = JSON.stringify(step.decision.input);
      if (serialized.length > AGENT_CONTEXT_LIMITS.reusableProcedureInputCharacters) return [];
      return [{ toolName: tool.name, input: step.decision.input }];
    }).slice(0, agentConfig.reusableProcedures.maximumSteps);
  }

  /**
   * Groups independent supporting reads into one bounded planner action. The
   * registry still validates each target tool and deliberately excludes domain
   * retrieval, synchronization and every side-effecting operation.
   */
  private contextAcquisitionTool(): AgentTool {
    const sources = [...this.tools.values()]
      .filter((tool) => CONTEXT_SOURCE_TOOLS.has(tool.name) && tool.sideEffect === "read")
      .map((tool) => ({
        toolName: tool.name,
        inputSchema: tool.schema.description ?? "{}",
      }));
    const sourceNameValues = sources.map((source) => source.toolName);
    const sourceNames = new Set(sourceNameValues);
    const sourceNameSchema = sourceNameValues.length > 0
      ? z.enum(sourceNameValues as [string, ...string[]])
      : z.never();
    const schema = z.object({
      requests: z.array(z.object({
        toolName: sourceNameSchema,
        input: z.record(z.unknown()).default({}),
      })).min(1).max(agentConfig.planning.maximumParallelContextRequests),
    }).describe(JSON.stringify({
      requests: [{
        toolName: "one toolName from availableSources",
        input: { field: "an object matching that source's inputSchema" },
      }],
      availableSources: sources,
    }));

    return {
      name: "acquire_context",
      description: `Load up to ${agentConfig.planning.maximumParallelContextRequests} independent supporting memory, conversation, obligation or identity sources in parallel. This does not retrieve choir schedules, attendance, rota data, events or setlists; use a choir knowledge tool for those.`,
      capability: "conversation",
      schema,
      sideEffect: "read",
      execute: async (input, context) => {
        const results = await Promise.all(input.requests.map(async (request: {
          toolName: string;
          input: Record<string, unknown>;
        }) => {
          const target = sourceNames.has(request.toolName) ? this.tools.get(request.toolName) : undefined;
          if (!target || target.sideEffect !== "read" || !isAllowedForEvent(context.event, request.toolName)) {
            return {
              toolName: request.toolName,
              status: "error" as const,
              summary: "This source is not available for context acquisition.",
              error: "invalid_context_source",
            };
          }
          const parsed = target.schema.safeParse(request.input);
          if (!parsed.success) {
            return {
              toolName: request.toolName,
              status: "error" as const,
              summary: "The context request was invalid.",
              error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
            };
          }
          if (target.requiresRole && !hasRole(context.actor?.roles ?? [], target.requiresRole)) {
            return {
              toolName: request.toolName,
              status: "denied" as const,
              summary: "The sender is not authorized to read this context.",
              error: "permission_denied",
            };
          }
          try {
            const result = await target.execute(parsed.data, context);
            return { toolName: request.toolName, ...result, reply: undefined };
          } catch (error) {
            return {
              toolName: request.toolName,
              status: "error" as const,
              summary: `${request.toolName} failed.`,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }));
        const successful = results.filter((result) => result.status === "success").length;
        return {
          status: successful > 0 ? "success" : "error",
          summary: `${successful} of ${results.length} requested context source(s) loaded.`,
          data: { results },
          error: successful > 0 ? undefined : "context_acquisition_failed",
        };
      },
    };
  }
}

const CONTEXT_SOURCE_TOOLS = new Set([
  "search_conversation_history",
  "read_member_memory",
  "read_context_memory",
  "list_active_obligations",
  "resolve_members",
]);

function capabilityActivationTool(): AgentTool {
  const values = Object.keys(CAPABILITY_DESCRIPTIONS) as [AgentToolCapability, ...AgentToolCapability[]];
  const schema = z.object({ capability: z.enum(values) })
    .describe('{"capability":"one capability listed in availableCapabilities"}');
  return {
    name: "activate_capability",
    description: "Activate one additional capability group when the current catalogue cannot complete the request.",
    capability: "conversation",
    schema,
    sideEffect: "none",
    async execute(input) {
      return {
        status: "success",
        summary: `${input.capability} capability activated for this turn.`,
        data: { activatedCapability: input.capability },
      };
    },
  };
}

function initialCapabilities(event: AgentEvent, context: AgentTurnContext): Set<AgentToolCapability> {
  if (event.source === "scheduler" || event.source === "system") {
    return new Set(["conversation", "knowledge", "memory", "identity", "scheduler", "choir_operations"]);
  }
  // Current choir information is Echo's central read-only responsibility. Keep
  // its small tool set visible so contextual follow-ups do not depend on words
  // in the latest message.
  const capabilities = new Set<AgentToolCapability>(["conversation", "knowledge"]);
  const text = event.message?.text ?? "";

  if (looksLikeExplicitWorkflow(text, event)) capabilities.add("workflow");
  if (looksLikeMemoryRequest(text)) capabilities.add("memory");
  if (!context.actor || context.memberProfile || looksLikeIdentityRequest(text)) capabilities.add("identity");
  if (
    context.actor?.roles.some((role) => role === "superuser" || role === "creator")
    && looksLikeAdministrationRequest(text)
  ) capabilities.add("administration");
  return capabilities;
}

function looksLikeExplicitWorkflow(text: string, event: AgentEvent): boolean {
  return isExplicitWorkflowActivation(text, event.message?.quotedMessage?.id);
}

function looksLikeMemoryRequest(text: string): boolean {
  return /\b(remember|forget|you know about me|i told you|last time|previously|i prefer|my preference|my favourite|my favorite)\b/i.test(text);
}

function looksLikeIdentityRequest(text: string): boolean {
  return /\b(call me|my name is|preferred name|nickname|alias|tag|mention|phone number|who is)\b/i.test(text);
}

function looksLikeAdministrationRequest(text: string): boolean {
  return /\b(add|remove|change|update|set|verify)\b.{0,40}\b(member|identifier|phone|number|canonical name|role|alias)\b/i.test(text);
}

function shouldExposeSync(steps: AgentStep[]): boolean {
  if (steps.some((step) => step.decision.kind === "tool" && step.decision.toolName === "sync_if_stale")) return false;
  return steps.some((step) => {
    if (step.decision.kind !== "tool" || !["retrieve_choir_knowledge", "read_week_schedule"].includes(step.decision.toolName)) {
      return false;
    }
    const data = step.result?.data;
    if (!isRecord(data) || !isRecord(data.evidenceQuality)) return false;
    return data.evidenceQuality.status === "empty" || data.evidenceQuality.status === "sparse";
  });
}

function capabilityFor(tool: AgentTool): AgentToolCapability {
  if (tool.capability) return tool.capability;
  if (["get_current_time", "search_conversation_history", "activate_capability"].includes(tool.name)) return "conversation";
  if (["retrieve_choir_knowledge", "read_week_schedule", "sync_if_stale", "inspect_spreadsheet", "query_spreadsheet"].includes(tool.name)) return "knowledge";
  if (["read_member_memory", "read_context_memory", "remember_member_fact"].includes(tool.name)) return "memory";
  if ([
    "create_reminder",
    "continue_reminder",
    "submit_setlist",
    "create_scheduled_agent_task",
    "list_scheduled_agent_tasks",
    "manage_scheduled_agent_task",
  ].includes(tool.name)) return "workflow";
  if (["add_member_identifier", "set_member_canonical_name"].includes(tool.name)) return "administration";
  if (["list_active_obligations", "upsert_obligation", "update_obligation_status"].includes(tool.name)) return "scheduler";
  if (["onboard_current_sender", "resolve_members", "compose_member_message", "update_own_member_profile"].includes(tool.name)) {
    return "identity";
  }
  return "choir_operations";
}

function isCapability(value: string): value is AgentToolCapability {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_DESCRIPTIONS, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAllowedForEvent(event: AgentEvent, toolName: string): boolean {
  const allowed = event.constraints?.allowedToolNames;
  return !allowed || allowed.includes(toolName);
}

function hasRole(actual: MemberRole[], required: MemberRole): boolean {
  if (required === "member") return actual.length > 0;
  if (required === "superuser") return actual.includes("superuser") || actual.includes("creator");
  return actual.includes("creator");
}

function isToolDiscoverable(
  tool: AgentTool,
  event: AgentEvent,
  context: AgentTurnContext,
  previousSteps: AgentStep[],
): boolean {
  if (previousSteps.some((step) =>
    step.decision.kind === "tool"
    && step.decision.toolName === tool.name
    && step.result?.status === "error"
    && step.result.retryable === false
  )) return false;
  if (event.source === "transport" && SCHEDULER_ONLY_TOOLS.has(tool.name)) return false;
  if (
    event.source === "transport"
    && event.message
    && isExplicitReminderActivation(event.message.text)
    && REMINDER_EXTERNAL_CONTEXT_TOOLS.has(tool.name)
  ) return false;
  if (
    event.type === "scheduled_agent_task_due"
    && tool.sideEffect === "write"
    && tool.name !== "sync_if_stale"
  ) return false;
  if (tool.name === "onboard_current_sender" && context.actor) return false;
  if (tool.name === "sync_if_stale" && !shouldExposeSync(previousSteps)) return false;
  if (
    ["inspect_spreadsheet", "query_spreadsheet"].includes(tool.name)
    && hasCataloguedRetrievalAttempt(previousSteps)
  ) return false;
  return true;
}

function hasCataloguedRetrievalAttempt(steps: AgentStep[]): boolean {
  return steps.some((step) => {
    if (step.decision.kind !== "tool" || step.decision.toolName !== "retrieve_choir_knowledge") return false;
    return step.result?.status === "success";
  });
}

/** Classifies thrown integration failures without coupling the agent to one provider. */
function isRetryableToolException(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  const status = Number(record.status ?? record.statusCode ?? record.code);

  if ([400, 401, 403, 404, 413, 422].includes(status)) return false;
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
  if (/zod field|structured.?output|invalid (?:tool )?schema|schema.*not supported|unsupported.*schema|permission_denied|unknown_tool/.test(message)) {
    return false;
  }
  return /abort|timeout|timed out|rate.?limit|quota|connection|network|socket|econn|fetch failed|temporar/.test(message);
}
