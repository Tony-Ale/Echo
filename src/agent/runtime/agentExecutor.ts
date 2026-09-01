import { logger } from "../../config/logger.js";
import { randomUUID } from "node:crypto";
import { clockService } from "../../shared/clockService.js";
import { sha256 } from "../../shared/utils/hash.js";
import type { AgentActivitySink, AgentContextAssembler, AgentJournal, ApprovalRepository, ConversationRepository } from "../ports.js";
import type { AgentActivityEvent, AgentDecision, AgentEvent, AgentPlanner, AgentStep, AgentTurnResult } from "../types.js";
import { sanitizeActivityInput, sanitizeActivityText } from "./activitySanitizer.js";
import { AgentToolRegistry } from "./toolRegistry.js";
import { performance } from "node:perf_hooks";
import type { AgentRuntimeTelemetry } from "./runtimeTelemetry.js";
import { agentConfig } from "../../config/agentConfig.js";

export interface AgentExecutorOptions {
  maxSteps: number;
  maxFailures: number;
  turnTimeoutMs: number;
}

const DEFAULT_OPTIONS: AgentExecutorOptions = {
  ...agentConfig.execution,
};

/**
 * Persistent bounded executor inspired by NanoBrowser's planner/action loop.
 * Different members are serialized independently so one workflow cannot consume
 * or reorder another member's messages in a busy group.
 */
export class EchoAgentExecutor {
  private readonly locks = new Map<string, Promise<AgentTurnResult>>();
  private readonly options: AgentExecutorOptions;

  public constructor(
    private readonly planner: AgentPlanner,
    private readonly tools: AgentToolRegistry,
    private readonly contextAssembler: AgentContextAssembler,
    private readonly journal: AgentJournal,
    private readonly conversations: ConversationRepository,
    options: Partial<AgentExecutorOptions> = {},
    private readonly approvals?: ApprovalRepository,
    private readonly activity?: AgentActivitySink,
    private readonly telemetry?: AgentRuntimeTelemetry,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  public execute(event: AgentEvent): Promise<AgentTurnResult> {
    const startedAt = performance.now();
    const key = executionKey(event);
    const previous = this.locks.get(key) ?? Promise.resolve(emptyCompletedResult(event.eventKey));
    const current = previous.catch(() => emptyCompletedResult(event.eventKey)).then(() => this.executeTurn(event));
    this.locks.set(key, current);
    void current.finally(() => {
      if (this.locks.get(key) === current) this.locks.delete(key);
    });
    void current.then((result) => this.telemetry?.record({
      kind: "turn",
      name: event.type,
      eventKey: event.eventKey,
      durationMs: Math.round(performance.now() - startedAt),
      status: result.status,
    }), () => undefined);
    return current;
  }

  private async executeTurn(event: AgentEvent): Promise<AgentTurnResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.turnTimeoutMs);
    let eventId: string | undefined;
    let turnId: string | undefined;
    try {
      const initialContext = await this.contextAssembler.assemble(event);
      const begun = await this.journal.beginEvent(event, initialContext.actor?.id);
      eventId = begun.eventId;
      if (begun.duplicateResult) {
        // The stored result proves the event completed, but replaying its reply
        // would duplicate a WhatsApp or scheduled delivery.
        return { ...begun.duplicateResult, reply: null, replayed: true };
      }

      if (event.message && event.chatId) {
        await this.conversations.append({
          externalMessageId: event.message.id,
          chatId: event.chatId,
          memberId: initialContext.actor?.id,
          role: "user",
          content: event.message.text,
          quotedExternalMessageId: event.message.quotedMessage?.id,
          senderName: event.message.sender.displayName,
        });
      }

      turnId = await this.journal.beginTurn(eventId, this.planner.modelName);
      await this.publishActivity(event, turnId, {
        phase: "turn",
        status: "started",
        title: "Agent turn started",
        detail: `Using ${this.planner.modelName}`,
      });
      await this.publishActivity(event, turnId, {
        phase: "context",
        status: "completed",
        title: "Context loaded",
        detail: describeContext(initialContext),
      });
      const steps: AgentStep[] = [];
      const executedCalls = new Set<string>();
      const recoveredCapabilities = new Set<string>();
      let workingContext = initialContext;
      let failures = 0;
      let queuedDecision: Extract<AgentDecision, { kind: "tool" }> | undefined;
      const maxSteps = Math.min(
        this.options.maxSteps,
        Math.max(2, event.constraints?.maxSteps ?? this.options.maxSteps),
      );

      for (let step = 0; step < maxSteps; step += 1) {
        // The initial context is a stable working set. Deeper state enters the
        // turn through explicit tools instead of repeating DB reads per step.
        const context = workingContext;
        const toolCatalog = this.tools.catalogFor(event, context, steps);
        const continuingPlan = Boolean(queuedDecision);
        await this.publishActivity(event, turnId, {
          phase: "planning",
          status: "started",
          title: continuingPlan ? "Continuing planned action" : "Planning next action",
          detail: continuingPlan
            ? "Using the next tool already validated by the previous plan"
            : step === 0 ? "Reviewing the request and available tools" : "Reviewing the latest tool result",
          step: step + 1,
            maxSteps,
        });
        const decision = queuedDecision ?? await runWithChildSignal(
          controller.signal,
          (signal) => this.planner.decide({
            event,
            context,
            toolCatalog,
            availableCapabilities: this.tools.capabilitiesFor(event, context, steps),
            previousSteps: projectStepsForPlanner(steps),
            maxSteps,
          }, signal),
        );
        queuedDecision = undefined;

        await this.publishActivity(event, turnId, {
          phase: "planning",
          status: "completed",
          title: decision.kind === "tool"
            ? continuingPlan ? "Planned action ready" : "Plan ready"
            : "Response selected",
          detail: decision.kind === "tool"
            ? `${continuingPlan ? "Next validated action:" : "Next action:"} ${readableName(decision.toolName)}`
            : "No further tool is needed",
          step: step + 1,
          maxSteps,
          plan: decision.plan?.map(sanitizeActivityText),
          tool: decision.kind === "tool" ? { name: decision.toolName } : undefined,
        });

        if (decision.kind === "respond" || decision.kind === "defer") {
          const result: AgentTurnResult = {
            eventKey: event.eventKey,
            status: decision.kind === "defer" ? "deferred" : "completed",
            reply: decision.message ? { text: decision.message } : null,
            steps: [...steps, { step, decision }],
          };
          await this.recordFinalReply(event, result);
          await this.journal.completeTurn(turnId, result);
          await this.publishActivity(event, turnId, {
            phase: "response",
            status: "completed",
            title: decision.kind === "defer" ? "Turn deferred" : "Response ready",
            detail: decision.message ? "Reply prepared for the conversation" : "Completed without sending a message",
            step: step + 1,
            maxSteps,
          });
          return result;
        }

        if (!toolCatalog.some((tool) => tool.name === decision.toolName)) {
          const capability = this.tools.activationForTool(event, context, steps, decision.toolName);
          if (capability && !recoveredCapabilities.has(capability)) {
            recoveredCapabilities.add(capability);
            const activationDecision = {
              kind: "tool" as const,
              toolName: "activate_capability",
              input: { capability },
              reason: `The requested tool belongs to the hidden ${capability} capability. Replan after revealing its schema.`,
            };
            const activationResult = {
              status: "success" as const,
              summary: `${capability} capability activated for this turn. Replan before executing a tool.`,
              data: { activatedCapability: capability, requestedTool: decision.toolName },
            };
            await this.journal.recordToolExecution({
              turnId,
              step,
              toolName: activationDecision.toolName,
              idempotencyKey: sha256(`${event.eventKey}:auto-activate:${capability}`),
              arguments: activationDecision.input,
              status: "success",
              result: activationResult.data,
            });
            steps.push({ step, decision: activationDecision, result: activationResult });
            await this.publishActivity(event, turnId, {
              phase: "tool",
              status: "completed",
              title: `Activated ${readableName(capability)}`,
              detail: "A requested capability was revealed; the agent will replan before execution",
              step: step + 1,
              maxSteps,
              tool: { name: activationDecision.toolName, summary: activationResult.summary },
            });
            continue;
          }
          const unavailableResult = {
            status: "error" as const,
            summary: `${decision.toolName} is not available in the active capability set.`,
            error: "tool_not_available",
            retryable: false,
          };
          await this.journal.recordToolExecution({
            turnId,
            step,
            toolName: decision.toolName,
            idempotencyKey: sha256(`${event.eventKey}:unavailable:${decision.toolName}:${step}`),
            arguments: decision.input,
            status: "error",
            error: unavailableResult.error,
          });
          steps.push({ step, decision, result: unavailableResult });
          failures += 1;
          if (failures >= this.options.maxFailures) {
            return this.completeFailedTurn(event, turnId, steps, unavailableResult.error);
          }
          continue;
        }

        const callKey = sha256(`${event.eventKey}:${decision.toolName}:${stableJson(decision.input)}`);
        const recoveryRetry = executedCalls.has(callKey)
          && (isSinglePostSyncRetrievalRetry(decision, steps) || isRetryableCallAfterRecovery(decision, steps));
        const idempotencyKey = recoveryRetry ? sha256(`${callKey}:recovery:${step}`) : callKey;
        if (executedCalls.has(callKey) && !recoveryRetry) {
          const repeatedResult = {
            status: "error" as const,
            summary: `Repeated ${decision.toolName} call was stopped. Replan from the existing result.`,
            error: "repeated_tool_call",
            retainInContext: true,
            retryable: false,
          };
          await this.journal.recordToolExecution({
            turnId,
            step,
            toolName: decision.toolName,
            idempotencyKey: sha256(`${callKey}:repeat:${step}`),
            arguments: decision.input,
            status: "error",
            error: repeatedResult.error,
          });
          steps.push({ step, decision, result: repeatedResult });
          failures += 1;
          if (failures >= this.options.maxFailures) {
            return this.completeFailedTurn(event, turnId, steps, repeatedResult.error);
          }
          continue;
        }
        executedCalls.add(callKey);
        await this.journal.recordToolExecution({
          turnId,
          step,
          toolName: decision.toolName,
          idempotencyKey,
          arguments: decision.input,
          status: "running",
        });
        await this.publishActivity(event, turnId, {
          phase: "tool",
          status: "started",
          title: `Running ${readableName(decision.toolName)}`,
          detail: "Tool execution started",
          step: step + 1,
          maxSteps,
          tool: { name: decision.toolName, input: sanitizeActivityInput(decision.input) },
        });
        const toolStartedAt = performance.now();
        const toolResult = await runWithChildSignal(
          controller.signal,
          (signal) => this.tools.execute(decision.toolName, decision.input, {
            event,
            turnId: turnId!,
            step,
            actor: context.actor,
            signal,
          }),
        );
        this.telemetry?.record({
          kind: "tool",
          name: decision.toolName,
          eventKey: event.eventKey,
          durationMs: Math.round(performance.now() - toolStartedAt),
          status: toolResult.status,
        });

        if (toolResult.status === "approval_required" && this.approvals && initialContext.actor && event.chatId) {
          const proposed = toolResult.data as { toolName?: string; proposedInput?: Record<string, unknown> } | undefined;
          const approval = await this.approvals.create({
            chatId: event.chatId,
            ownerMemberId: initialContext.actor.id,
            toolName: proposed?.toolName ?? decision.toolName,
            arguments: proposed?.proposedInput ?? decision.input,
            expiresAt: clockServiceApprovalExpiry(),
          });
          toolResult.reply = {
            text: `This change affects private member data.\n\nReply YES to confirm or NO to decline.`,
            metadata: {
              agentApproval: { approvalId: approval.id, ownerMemberId: approval.ownerMemberId },
            },
          };
        }
        await this.journal.recordToolExecution({
          turnId,
          step,
          toolName: decision.toolName,
          idempotencyKey,
          arguments: decision.input,
          status: toolResult.status,
          result: toolResult.data ?? { summary: toolResult.summary },
          error: toolResult.error,
        });
        await this.publishActivity(event, turnId, {
          phase: "tool",
          status: toolResult.status === "error" || toolResult.status === "denied" ? "failed" : "completed",
          title: `${readableName(decision.toolName)} ${toolResult.status === "error" ? "failed" : "finished"}`,
          detail: sanitizeActivityText(toolResult.summary),
          step: step + 1,
          maxSteps,
          tool: { name: decision.toolName, summary: sanitizeActivityText(toolResult.summary) },
        });
        steps.push({ step, decision, result: toolResult });
        if (toolResult.refreshContext) workingContext = await this.contextAssembler.assemble(event);

        // A reply has always been terminal. Atomic background tools can now
        // express the same outcome without manufacturing an empty response or
        // paying for another planner call. Tools remain non-terminal by default.
        if (toolResult.reply || toolResult.turnControl === "complete") {
          const failed = (toolResult.status === "error" || toolResult.status === "denied") && !toolResult.nonFatal;
          const result: AgentTurnResult = {
            eventKey: event.eventKey,
            status: toolResult.status === "approval_required" ? "deferred" : failed ? "failed" : "completed",
            reply: toolResult.reply ?? null,
            steps,
            ...(failed ? { error: toolResult.error ?? toolResult.summary } : {}),
          };
          await this.recordFinalReply(event, result);
          await this.journal.completeTurn(turnId, result);
          await this.publishActivity(event, turnId, {
            phase: toolResult.reply ? "response" : "turn",
            status: failed ? "failed" : "completed",
            title: toolResult.reply ? "Tool response ready" : failed ? "Tool operation failed" : "Tool operation completed",
            detail: toolResult.reply
              ? "The tool prepared the conversation reply"
              : "The selected tool completed the operation without another planning step",
            step: step + 1,
          maxSteps,
          });
          return result;
        }

        if (toolResult.status === "success" && decision.nextTool) {
          const nextCallKey = sha256(`${event.eventKey}:${decision.nextTool.toolName}:${stableJson(decision.nextTool.input)}`);
          if (!executedCalls.has(nextCallKey) && this.tools.acceptsInput(decision.nextTool.toolName, decision.nextTool.input, event)) {
            queuedDecision = {
              kind: "tool",
              toolName: decision.nextTool.toolName,
              input: decision.nextTool.input,
              reason: decision.nextTool.reason,
              plan: [],
            };
          }
        }

        if ((toolResult.status === "error" || toolResult.status === "denied") && !toolResult.nonFatal) failures += 1;
        if (failures >= this.options.maxFailures) {
          return this.completeFailedTurn(event, turnId, steps, toolResult.error ?? toolResult.summary);
        }
      }

      const result: AgentTurnResult = {
        eventKey: event.eventKey,
        status: "max_steps",
        reply: event.source === "transport" ? { text: "I could not finish that request within this turn." } : null,
        steps,
        error: "maximum_agent_steps_reached",
      };
      await this.recordFinalReply(event, result);
      await this.journal.completeTurn(turnId, result);
      await this.publishActivity(event, turnId, {
        phase: "turn",
        status: "failed",
        title: "Step limit reached",
        detail: "The turn stopped at its configured safety limit",
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ error, eventKey: event.eventKey }, "Echo agent turn failed");
      if (turnId) await this.publishActivity(event, turnId, {
        phase: "turn",
        status: "failed",
        title: "Agent turn failed",
        detail: "The request could not be completed",
      });
      if (turnId) await this.journal.failTurn(turnId, message).catch(() => undefined);
      if (eventId) await this.journal.failEvent(eventId, message).catch(() => undefined);
      return {
        eventKey: event.eventKey,
        status: "failed",
        reply: event.source === "transport" ? { text: "I could not process that right now. Please try again shortly." } : null,
        steps: [],
        error: message,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async recordFinalReply(event: AgentEvent, result: AgentTurnResult): Promise<void> {
    if (!event.chatId || !result.reply?.text) return;
    await this.conversations.append({
      chatId: event.chatId,
      role: "assistant",
      content: result.reply.text,
    });
  }

  private async completeFailedTurn(
    event: AgentEvent,
    turnId: string,
    steps: AgentStep[],
    error: string,
  ): Promise<AgentTurnResult> {
    const result: AgentTurnResult = {
      eventKey: event.eventKey,
      status: "failed",
      reply: event.source === "transport" ? { text: "I could not complete that safely. Please try again shortly." } : null,
      steps,
      error,
    };
    await this.recordFinalReply(event, result);
    await this.journal.completeTurn(turnId, result);
    await this.publishActivity(event, turnId, {
      phase: "turn",
      status: "failed",
      title: "Agent turn failed",
      detail: "The turn stopped after reaching its failure safety limit",
    });
    return result;
  }

  private async publishActivity(
    event: AgentEvent,
    turnId: string,
    activity: Omit<AgentActivityEvent, "id" | "eventKey" | "turnId" | "occurredAt">,
  ): Promise<void> {
    if (!this.activity) return;
    try {
      await this.activity.publish({
        ...activity,
        id: randomUUID(),
        eventKey: event.eventKey,
        turnId,
        occurredAt: clockService.now("Europe/London").toISO()!,
      });
    } catch (error) {
      logger.warn({ error, eventKey: event.eventKey }, "Agent activity observer failed");
    }
  }
}

function describeContext(context: import("../types.js").AgentTurnContext): string {
  const parts = [
    `${context.recentConversation.length} recent messages`,
    `${context.memoryDirectory.length} available memory blocks`,
    `about ${context.contextBudget.approximateTokens} initial tokens`,
  ];
  return parts.join(" | ");
}

const RETAINED_RESULT_STEPS = 2;

/**
 * Keep the complete audit trail in `steps`, while exposing complete data from
 * the most recent results to the model. Older results remain in the audit trail
 * and their summaries still preserve the sequence of work.
 */
function projectStepsForPlanner(steps: AgentStep[]): AgentStep[] {
  const firstRetained = Math.max(0, steps.length - RETAINED_RESULT_STEPS);
  return steps.map((step, index) => {
    if (!step.result) return step;
    const retainData = step.result.retainInContext !== false && index >= firstRetained;
    return {
      ...step,
      result: {
        ...step.result,
        data: retainData ? step.result.data : undefined,
        reply: undefined,
      },
    };
  });
}

function readableName(value: string): string {
  return value.replace(/[-_]/g, " ");
}

function clockServiceApprovalExpiry(): string {
  return clockService.now("Europe/London").plus({ minutes: 15 }).toISO()!;
}

function executionKey(event: AgentEvent): string {
  if (event.message) return `${event.chatId ?? "unknown"}:${event.message.sender.id}`;
  return `${event.chatId ?? "system"}:${event.type}`;
}

function stableJson(value: Record<string, unknown>): string {
  return JSON.stringify(sortJsonValue(value));
}

function isSinglePostSyncRetrievalRetry(decision: Extract<import("../types.js").AgentDecision, { kind: "tool" }>, steps: AgentStep[]): boolean {
  if (!["retrieve_choir_knowledge", "read_week_schedule"].includes(decision.toolName)) return false;
  const matchingReads = steps.filter((step) =>
    step.decision.kind === "tool"
    && step.decision.toolName === decision.toolName
    && stableJson(step.decision.input) === stableJson(decision.input)
  );
  if (matchingReads.length !== 1) return false;
  const firstReadStep = matchingReads[0].step;
  return steps.some((step) =>
    step.step > firstReadStep
    && step.decision.kind === "tool"
    && step.decision.toolName === "sync_if_stale"
    && step.result?.status === "success"
    && isSuccessfulSourceRefresh(step.result.data)
  );
}

/** Allows one failed call to be retried after another tool repairs its prerequisite state. */
function isRetryableCallAfterRecovery(
  decision: Extract<import("../types.js").AgentDecision, { kind: "tool" }>,
  steps: AgentStep[],
): boolean {
  const matchingCalls = steps.filter((step) =>
    step.decision.kind === "tool"
    && step.decision.toolName === decision.toolName
    && stableJson(step.decision.input) === stableJson(decision.input)
  );
  if (matchingCalls.length !== 1 || matchingCalls[0].result?.retryable !== true) return false;
  return steps.some((step) => step.step > matchingCalls[0].step && step.result?.status === "success");
}

function isSuccessfulSourceRefresh(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.synced === true && result.sourceChanged === true;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}

function emptyCompletedResult(eventKey: string): AgentTurnResult {
  return { eventKey, status: "completed", reply: null, steps: [] };
}

/**
 * Dependencies may retain abort listeners until an operation settles. Giving
 * each planner/tool call a short-lived child signal prevents listeners from
 * accumulating on the turn-wide signal while preserving turn cancellation.
 */
async function runWithChildSignal<T>(
  parent: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const child = new AbortController();
  const abortChild = () => child.abort(parent.reason);
  if (parent.aborted) abortChild();
  else parent.addEventListener("abort", abortChild, { once: true });

  try {
    return await operation(child.signal);
  } finally {
    parent.removeEventListener("abort", abortChild);
  }
}
