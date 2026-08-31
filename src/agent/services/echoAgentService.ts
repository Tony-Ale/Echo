import type { IncomingMessage, OutgoingMessage } from "../../framework/contracts/messages.js";
import type {
  AgentMessageTransport,
  ConversationRepository,
  IdentityRepository,
  ObligationRepository,
  ScheduledDeliveryObserver,
  ScheduledMessagePolicy,
} from "../ports.js";
import type { AgentEvent, AgentTurnConstraints, AgentTurnResult } from "../types.js";
import type { EchoAgentExecutor } from "../runtime/agentExecutor.js";
import type { AgentApprovalCoordinator } from "./approvalCoordinator.js";
import type { ScheduledAgentTaskService } from "./scheduledAgentTaskService.js";

/** Application-facing entrypoint shared by transport messages and scheduled events. */
export class EchoAgentService {
  private activeTransport?: AgentMessageTransport;

  public constructor(
    private readonly executor: EchoAgentExecutor,
    transport?: AgentMessageTransport,
    private readonly approvals?: AgentApprovalCoordinator,
    private readonly conversations?: ConversationRepository,
    private readonly identities?: IdentityRepository,
    private readonly defaultTransportId = "unknown",
    private readonly obligations?: ObligationRepository,
    private readonly deliveryObserver?: ScheduledDeliveryObserver,
    private readonly scheduledMessagePolicy?: ScheduledMessagePolicy,
    private readonly scheduledTasks?: ScheduledAgentTaskService,
  ) {
    this.activeTransport = transport;
  }

  public setTransport(transport: AgentMessageTransport): void {
    this.activeTransport = transport;
  }

  public async handleMessage(message: IncomingMessage, constraints?: AgentTurnConstraints): Promise<OutgoingMessage | null> {
    const approvalReply = await this.approvals?.handleReply(message);
    if (approvalReply !== undefined) {
      if (approvalReply) await this.recordDeterministicExchange(message, approvalReply);
      return approvalReply;
    }
    const result = await this.executor.execute({
      eventKey: `${message.transport}:${message.conversationId}:${message.id}`,
      source: "transport",
      type: "message_received",
      chatId: message.conversationId,
      message,
      constraints,
      payload: {
        transport: message.transport,
        quotedMessageId: message.quotedMessage?.id,
        mentionedAgent: message.mentionedAgent ?? false,
        repliedToAgent: message.repliedToAgent ?? false,
      },
    });
    if (result.replayed) return null;
    const scheduledTaskId = findCreatedScheduledTaskId(result);
    if (!scheduledTaskId || !this.scheduledTasks) return result.reply;

    const firstRun = await this.scheduledTasks.runNow(scheduledTaskId);
    // A null result means this deterministic initial occurrence was already
    // claimed, usually because the transport retried the creation message.
    if (!firstRun) return null;
    if (firstRun.status === "failed" || firstRun.status === "max_steps") {
      return { text: "The recurring reminder was saved, but its first run could not complete. It will try again at the next scheduled time." };
    }
    // The scheduled wake uses the active transport directly, so returning its
    // reply here would send the first result twice.
    return null;
  }

  public registerApprovalMessage(approvalId: string, messageId: string): Promise<void> {
    return this.approvals?.attachConfirmationMessage(approvalId, messageId) ?? Promise.resolve();
  }

  /** Records deterministic admin/help commands in the same durable transcript. */
  public async recordDeterministicExchange(message: IncomingMessage, reply: OutgoingMessage): Promise<void> {
    if (!this.conversations) return;
    const actor = await this.identities?.resolveSender(message.sender);
    await this.conversations.append({
      externalMessageId: message.id,
      chatId: message.conversationId,
      memberId: actor?.id,
      role: "user",
      content: message.text,
      quotedExternalMessageId: message.quotedMessage?.id,
      senderName: message.sender.displayName,
    });
    await this.conversations.append({
      chatId: message.conversationId,
      role: "assistant",
      content: reply.text,
    });
  }

  public async handleScheduledWake(input: {
    eventKey: string;
    type: string;
    chatId: string;
    payload: Record<string, unknown>;
    actorMemberId?: string;
  }): Promise<AgentTurnResult> {
    const event: AgentEvent = {
      ...input,
      source: "scheduler",
      payload: { transport: this.defaultTransportId, ...input.payload },
      actorMemberId: input.actorMemberId,
    };
    const result = await this.executor.execute(event);
    if (result.replayed) {
      return {
        ...result,
        delivery: { delivered: false, reason: "no_reply" },
      };
    }
    const allowUntargeted = input.payload.allowUntargetedMessage === true;
    const isTargeted = Boolean(result.reply?.mentions?.length);
    const policyAllows = this.scheduledMessagePolicy?.canDeliver(event, result) ?? true;
    let delivered = false;
    if (result.reply && this.activeTransport && policyAllows && (allowUntargeted || isTargeted)) {
      try {
        const receipt = await this.activeTransport.send(input.chatId, result.reply);
        delivered = true;
        await this.deliveryObserver?.onDelivered(event, result, receipt);
      } catch (error) {
        await this.settleObligation(input.payload.obligationId, "waiting_for_data", "Transport delivery failed.");
        throw error;
      }
    }
    await this.settleScheduledResult(input.payload.obligationId, result, delivered);
    return {
      ...result,
      delivery: {
        delivered,
        reason: deliveryReason({ result, delivered, policyAllows, allowUntargeted, isTargeted, hasTransport: Boolean(this.activeTransport) }),
      },
    };
  }

  private async settleScheduledResult(
    obligationId: unknown,
    result: AgentTurnResult,
    delivered: boolean,
  ): Promise<void> {
    if (typeof obligationId !== "string" || !this.obligations) return;
    if (result.status === "deferred") {
      await this.settleObligation(obligationId, "waiting_for_data", result.error ?? "The agent deferred this obligation.");
      return;
    }
    if (result.status === "failed" || result.status === "max_steps") {
      await this.settleObligation(obligationId, "failed", result.error ?? "The agent could not complete this obligation.");
      return;
    }
    const lastToolResult = [...result.steps].reverse().find((step) => step.result)?.result;
    if (lastToolResult && (lastToolResult.status === "error" || lastToolResult.status === "denied")) {
      await this.settleObligation(
        obligationId,
        lastToolResult.nonFatal ? "waiting_for_data" : "failed",
        lastToolResult.error ?? lastToolResult.summary,
      );
      return;
    }
    if (result.reply && !delivered) {
      await this.settleObligation(obligationId, "not_applicable", "No safe message target was resolved.");
      return;
    }
    await this.settleObligation(
      obligationId,
      delivered ? "satisfied" : "not_applicable",
      delivered ? "Scheduled message delivered." : "Current evidence did not require a message.",
    );
  }

  private async settleObligation(
    obligationId: unknown,
    status: "waiting_for_data" | "satisfied" | "not_applicable" | "failed",
    reason: string,
  ): Promise<void> {
    if (typeof obligationId !== "string" || !this.obligations) return;
    await this.obligations.updateStatus(obligationId, status, reason);
  }
}

function deliveryReason(input: {
  result: AgentTurnResult;
  delivered: boolean;
  policyAllows: boolean;
  allowUntargeted: boolean;
  isTargeted: boolean;
  hasTransport: boolean;
}): NonNullable<AgentTurnResult["delivery"]>["reason"] {
  if (input.delivered) return "delivered";
  if (!input.result.reply) return "no_reply";
  if (!input.policyAllows) return "policy_blocked";
  if (!input.hasTransport) return "no_transport";
  return input.allowUntargeted || input.isTargeted ? "no_transport" : "no_safe_target";
}

function findCreatedScheduledTaskId(result: AgentTurnResult): string | null {
  for (const step of result.steps) {
    if (step.decision.kind !== "tool" || step.decision.toolName !== "create_scheduled_agent_task") continue;
    const data = step.result?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const record = data as Record<string, unknown>;
    if (record.created === true && typeof record.scheduledTaskId === "string") return record.scheduledTaskId;
  }
  return null;
}
