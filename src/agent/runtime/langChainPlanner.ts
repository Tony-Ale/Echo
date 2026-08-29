import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { AgentDecision, AgentPlanner, AgentPlannerInput } from "../types.js";
import type { ConfiguredChatModel } from "../../framework/models/types.js";
import { performance } from "node:perf_hooks";
import { AGENT_CONTEXT_LIMITS, estimateTokens } from "./contextLimits.js";
import type { AgentRuntimeTelemetry } from "./runtimeTelemetry.js";
import { agentConfig } from "../../config/agentConfig.js";

const plannerDecisionSchema = z.object({
  kind: z.enum(["respond", "defer", "tool"]).describe("respond and defer are terminal; tool continues execution"),
  message: z.string().max(AGENT_CONTEXT_LIMITS.plannerResponseMessageCharacters).nullable().optional().default(""),
  toolName: z.string().max(100).nullable().optional().default(""),
  inputJson: z.string().max(AGENT_CONTEXT_LIMITS.plannerToolInputCharacters).nullable().optional().default("{}").describe("A JSON-encoded object containing the selected tool's arguments."),
  reason: z.string().max(AGENT_CONTEXT_LIMITS.plannerReasonCharacters).nullable().optional().default(""),
  plan: z.array(z.string().min(1).max(AGENT_CONTEXT_LIMITS.plannerPlanItemCharacters))
    .max(agentConfig.planning.maximumPlanItems).nullable().optional().default([])
    .describe("Pending next steps for a tool decision only. Must be empty for respond or defer."),
  nextTool: z.object({
    toolName: z.string().min(1),
    inputJson: z.string().max(AGENT_CONTEXT_LIMITS.plannerToolInputCharacters).default("{}").describe("A JSON-encoded object containing the follow-up tool arguments."),
    reason: z.string().min(1).max(AGENT_CONTEXT_LIMITS.plannerReasonCharacters),
  }).nullable().optional().default(null).describe("At most one concrete follow-up whose arguments are already known. Use only after a tool decision."),
});

type PlannerResponse = z.infer<typeof plannerDecisionSchema>;

/** LangChain structured planner. Tool execution remains in the runtime. */
export class LangChainAgentPlanner implements AgentPlanner {
  public constructor(
    private readonly model: ConfiguredChatModel,
    public readonly modelName: string,
    private readonly systemPrompt: string | ((input: AgentPlannerInput) => string),
    private readonly telemetry?: AgentRuntimeTelemetry,
  ) {}

  public async decide(input: AgentPlannerInput, signal: AbortSignal): Promise<AgentDecision> {
    const startedAt = performance.now();
    const systemPrompt = typeof this.systemPrompt === "function" ? this.systemPrompt(input) : this.systemPrompt;
    const plannerInput = formatPlannerInput(input);
    const structured = this.model.withStructuredOutput(plannerDecisionSchema, { name: "echo_agent_decision" });
    const baseMessages = [new SystemMessage(systemPrompt), new HumanMessage(plannerInput)];
    let rawResponse: PlannerResponse;
    try {
      rawResponse = await structured.invoke(baseMessages, { signal });
    } catch (error) {
      if (!isStructuredOutputParseError(error) || signal.aborted) throw error;
      try {
        rawResponse = await structured.invoke(
          [
            ...baseMessages,
            new HumanMessage(
              "Your previous structured response could not be parsed. Return exactly one valid response matching the supplied schema, with no extra JSON or trailing text.",
            ),
          ],
          { signal },
        );
      } catch (repairError) {
        if (!isStructuredOutputParseError(repairError) || signal.aborted) throw repairError;
        throw new PlannerProtocolError("planner_returned_malformed_structured_output");
      }
    }
    let response = parsePlannerResponse(rawResponse);
    const issues = plannerProtocolIssues(response, input);
    if (issues.length > 0) {
      try {
        response = parsePlannerResponse(await structured.invoke(
          [...baseMessages, new HumanMessage(formatRepairRequest(response, issues, input))],
          { signal },
        ));
      } catch (repairError) {
        if (repairError instanceof PlannerProtocolError) throw repairError;
        if (!isStructuredOutputParseError(repairError) || signal.aborted) throw repairError;
        throw new PlannerProtocolError("planner_returned_malformed_structured_output");
      }
    }

    if (hasEmptyRequiredToolInput(response, input)) {
      throw new PlannerProtocolError("planner_returned_empty_required_tool_input");
    }

    // A malformed decision after the bounded repair attempt is an internal
    // planner protocol failure, not a real-world deferral. Throw it so the
    // executor can log the technical reason without exposing it to the user.
    if (response.kind !== "tool" && ((response.plan?.length ?? 0) > 0 || response.nextTool)) {
      throw new PlannerProtocolError("planner_returned_non_terminal_final_decision");
    }

    if (response.kind === "tool") {
      const toolInput = decodeToolInput(response.inputJson ?? "{}", response.toolName ?? undefined);
      const toolAvailable = input.toolCatalog.some((tool) => tool.name === response.toolName);
      const toolDiscoverable = input.availableCapabilities.some((capability) =>
        capability.toolNames.includes(response.toolName ?? ""),
      );
      if (!toolInput || (!toolAvailable && !toolDiscoverable)) {
        throw new PlannerProtocolError(
          !toolInput ? "planner_returned_invalid_tool_input" : "planner_returned_unknown_tool",
        );
      }
      const nextToolInput = response.nextTool
        ? decodeToolInput(response.nextTool.inputJson, response.nextTool.toolName)
        : null;
      const nextToolAvailable = !response.nextTool || input.toolCatalog.some((tool) => tool.name === response.nextTool?.toolName);
      if (response.nextTool && (!nextToolInput || !nextToolAvailable)) {
        throw new PlannerProtocolError(!nextToolInput
          ? "planner_returned_invalid_next_tool_input"
          : "planner_returned_unavailable_next_tool");
      }
      const decision: AgentDecision = {
        kind: "tool",
        toolName: response.toolName ?? "",
        input: toolInput,
        reason: response.reason || "The selected tool is required to continue.",
        plan: response.plan ?? [],
        nextTool: response.nextTool && nextToolInput ? {
          toolName: response.nextTool.toolName,
          input: nextToolInput,
          reason: response.nextTool.reason,
        } : undefined,
      };
      this.recordTelemetry(input.event.eventKey, startedAt, systemPrompt, plannerInput, response);
      return decision;
    }
    if (response.kind === "defer") {
      const decision: AgentDecision = {
        kind: "defer",
        message: response.message || "I do not have enough reliable information to do that yet.",
        reason: response.reason || "Required information is unavailable.",
        plan: [],
      };
      this.recordTelemetry(input.event.eventKey, startedAt, systemPrompt, plannerInput, response);
      return decision;
    }
    const decision: AgentDecision = {
      kind: "respond",
      message: response.message ?? "",
      reason: response.reason || "The response can be answered from current context.",
      plan: [],
    };
    this.recordTelemetry(input.event.eventKey, startedAt, systemPrompt, plannerInput, response);
    return decision;
  }

  private recordTelemetry(eventKey: string, startedAt: number, systemPrompt: string, plannerInput: string, response: PlannerResponse): void {
    const inputCharacters = systemPrompt.length + plannerInput.length;
    const outputCharacters = JSON.stringify(response).length;
    this.telemetry?.record({
      kind: "planner",
      name: this.modelName,
      eventKey,
      durationMs: Math.round(performance.now() - startedAt),
      inputCharacters,
      estimatedInputTokens: estimateTokens(inputCharacters),
      outputCharacters,
      estimatedOutputTokens: estimateTokens(outputCharacters),
      status: response.kind,
    });
  }
}

function isStructuredOutputParseError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:parse|parsing|json|unexpected non-whitespace character)/i.test(message);
}

function parsePlannerResponse(value: unknown): PlannerResponse {
  const parsed = plannerDecisionSchema.safeParse(value);
  if (!parsed.success) throw new PlannerProtocolError("planner_returned_invalid_structured_output");
  return parsed.data;
}

/** Identifies a schema/protocol failure after the planner's bounded repair. */
export class PlannerProtocolError extends Error {
  public constructor(code: string) {
    super(code);
    this.name = "PlannerProtocolError";
  }
}

function plannerProtocolIssues(response: PlannerResponse, input: AgentPlannerInput): string[] {
  const issues: string[] = [];
  const plan = response.plan ?? [];
  if (response.kind !== "tool" && plan.length > 0) {
    issues.push("A terminal respond/defer decision contains pending actions that would never execute.");
  }
  if (response.kind !== "tool" && response.nextTool) {
    issues.push("A terminal decision contains a follow-up tool that would never execute.");
  }
  if (response.kind === "defer" && input.previousSteps.length === 0) {
    issues.push("The turn was deferred before any tool attempt; verify that no available tool can make concrete progress.");
  }
  if (response.kind === "tool") {
    const available = input.toolCatalog.some((tool) => tool.name === response.toolName);
    const discoverable = input.availableCapabilities.some((capability) =>
      capability.toolNames.includes(response.toolName ?? ""),
    );
    if (!available && !discoverable) {
      issues.push("The selected tool is not in the active tool catalogue.");
    }
    if (!decodeToolInput(response.inputJson ?? "{}", response.toolName ?? undefined)) {
      issues.push("The selected tool input is not a valid JSON object.");
    }
    if (hasEmptyRequiredToolInput(response, input)) {
      issues.push("The selected tool requires arguments, but inputJson is empty.");
    }
    if (response.nextTool) {
      if (!input.toolCatalog.some((tool) => tool.name === response.nextTool?.toolName)) {
        issues.push("The follow-up tool is not in the active tool catalogue.");
      }
      if (!decodeToolInput(response.nextTool.inputJson, response.nextTool.toolName)) {
        issues.push("The follow-up tool input is not a valid JSON object.");
      }
    }
  }
  return issues;
}

function hasEmptyRequiredToolInput(response: PlannerResponse, input: AgentPlannerInput): boolean {
  if (response.kind !== "tool") return false;
  const selectedTool = input.toolCatalog.find((tool) => tool.name === response.toolName);
  const decodedInput = decodeToolInput(response.inputJson ?? "{}", response.toolName ?? undefined);
  return selectedTool?.acceptsEmptyInput === false
    && Boolean(decodedInput)
    && Object.keys(decodedInput ?? {}).length === 0;
}

function formatRepairRequest(response: PlannerResponse, issues: string[], input: AgentPlannerInput): string {
  const selectedTool = input.toolCatalog.find((tool) => tool.name === response.toolName);
  return JSON.stringify({
    task: "Repair the structured decision so it obeys the execution protocol.",
    protocol: [
      "respond and defer are terminal and therefore must have an empty plan",
      "defer is valid only when no currently available tool can make progress or a concrete blocker remains",
      "when an available tool can obtain missing information, select kind=tool now with valid inputJson",
      "nextTool is optional and valid only when its arguments are already known and it is safe to run after the current tool succeeds",
      "do not describe pending work in a terminal message",
    ],
    issues,
    selectedTool: selectedTool ? {
      name: selectedTool.name,
      description: selectedTool.description,
      inputSchema: selectedTool.inputSchema,
    } : undefined,
    previousDecision: response,
  }, null, 2);
}

function decodeToolInput(value: string, expectedToolName?: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(normalizeJsonText(value));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const decision = record.decision ?? record;
    if (
      expectedToolName
      && decision
      && typeof decision === "object"
      && !Array.isArray(decision)
    ) {
      const envelope = decision as Record<string, unknown>;
      const nestedInput = envelope.input;
      if (
        envelope.kind === "tool"
        && envelope.toolName === expectedToolName
        && nestedInput
        && typeof nestedInput === "object"
        && !Array.isArray(nestedInput)
      ) {
        return nestedInput as Record<string, unknown>;
      }
    }
    return record;
  } catch {
    return null;
  }
}

/**
 * Some OpenAI-compatible providers preserve Markdown fences inside structured
 * string fields. Only unwrap a single complete JSON fence; the parsed value is
 * still required to be an object and is validated by the tool registry later.
 */
function normalizeJsonText(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function formatPlannerInput(input: AgentPlannerInput): string {
  const message = input.event.message;
  const { memberProfile, ...baseContext } = input.context;
  const payload = {
      event: {
        source: input.event.source,
        type: input.event.type,
        payload: plannerSafeEventPayload(input.event.payload),
        message: message
          ? {
              text: message.text,
              sender: input.context.actor?.displayName ?? message.sender.displayName ?? "Unknown member",
              transportDisplayName: message.sender.displayName,
              conversationKind: message.metadata.conversationKind,
              quotedText: message.quotedMessage?.text,
              repliedToAgent: message.repliedToAgent,
              mentionedAgent: message.mentionedAgent,
            }
          : undefined,
      },
      currentContext: {
        ...baseContext,
        ...(memberProfile ? { memberProfile } : {}),
        memoryDirectory: input.context.memoryDirectory.slice(0, AGENT_CONTEXT_LIMITS.memoryDirectoryEntries).map((entry) => ({
          scopeType: entry.scopeType,
          label: entry.label,
          description: entry.description.slice(
            0,
            AGENT_CONTEXT_LIMITS.memoryDirectoryDescriptionCharacters,
          ),
        })),
        recentConversation: input.context.recentConversation.map((entry) => ({
          ...entry,
          content: entry.content.slice(0, AGENT_CONTEXT_LIMITS.recentConversationCharacters),
        })),
      },
      availableTools: input.toolCatalog,
      availableCapabilities: input.availableCapabilities,
      completedSteps: input.previousSteps.map(compactPlannerStep),
      limits: { maxSteps: input.maxSteps, remainingSteps: input.maxSteps - input.previousSteps.length },
    };
  const serialized = JSON.stringify(payload);
  return serialized.length <= AGENT_CONTEXT_LIMITS.plannerInputCharacters
    ? serialized
    : JSON.stringify({
        ...payload,
        currentContext: {
          ...payload.currentContext,
          recentConversation: payload.currentContext.recentConversation.slice(
            -agentConfig.context.recentConversation.messageLimit,
          ),
          memoryDirectory: payload.currentContext.memoryDirectory.slice(0, AGENT_CONTEXT_LIMITS.compactedMemoryDirectoryEntries),
        },
        completedSteps: payload.completedSteps.map((step) => ({
          ...step,
          result: step.result ? { ...step.result, data: compactToolData(step.result.data, AGENT_CONTEXT_LIMITS.compactedToolResultCharacters) } : undefined,
        })),
        contextPressure: {
          compacted: true,
          originalCharacters: serialized.length,
          approximateOriginalTokens: estimateTokens(serialized.length),
        },
      });
}

/** Opaque backend integrity values remain server-side when persisted obligations are recovered. */
function plannerSafeEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const { sourceHash: _sourceHash, evidenceRef: _evidenceRef, ...safe } = payload;
  return safe;
}

// Keep enough room for the system prompt, structured schema and later planning
// steps regardless of the configured provider's context window.
function compactPlannerStep(step: AgentPlannerInput["previousSteps"][number]) {
  if (!step.result) return step;
  return {
    ...step,
    result: {
      ...step.result,
      reply: undefined,
      data: compactToolData(step.result.data, AGENT_CONTEXT_LIMITS.compactedToolResultCharacters),
    },
  };
}

function compactToolData(value: unknown, characterLimit: number): unknown {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized.length <= characterLimit) return value;
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  return {
    truncated: true,
    originalCharacters: serialized.length,
    preview: serialized.slice(0, characterLimit),
    ...(record?.evidenceQuality ? { evidenceQuality: record.evidenceQuality } : {}),
    ...(record?.provenance ? { provenance: record.provenance } : {}),
    ...(record?.retrievalProvenance ? { retrievalProvenance: record.retrievalProvenance } : {}),
  };
}
