import type { IncomingMessage, OutgoingMessage } from "../../framework/contracts/messages.js";
import type { ApprovalRepository, IdentityRepository } from "../ports.js";
import { AgentToolRegistry } from "../runtime/toolRegistry.js";

/** Resolves persistent approvals through transport reply chains and owner identity. */
export class AgentApprovalCoordinator {
  public constructor(
    private readonly approvals: ApprovalRepository,
    private readonly identities: IdentityRepository,
    private readonly tools: AgentToolRegistry,
  ) {}

  public attachConfirmationMessage(approvalId: string, messageId: string): Promise<void> {
    return this.approvals.attachConfirmationMessage(approvalId, messageId);
  }

  public async handleReply(message: IncomingMessage): Promise<OutgoingMessage | null | undefined> {
    const quotedMessageId = message.quotedMessage?.id;
    const answer = message.text.trim().toLowerCase();
    if (!quotedMessageId || !["yes", "y", "no", "n"].includes(answer)) return undefined;

    const approval = await this.approvals.findPendingByConfirmationMessage(quotedMessageId);
    if (!approval) return undefined;
    if (approval.chatId !== message.conversationId) {
      return { text: "That confirmation belongs to a different conversation." };
    }
    const actor = await this.identities.resolveSender(message.sender);
    if (!actor || actor.id !== approval.ownerMemberId) {
      return { text: "Only the person who requested this change can confirm it." };
    }

    if (answer === "no" || answer === "n") {
      await this.approvals.updateStatus(approval.id, "declined");
      return { text: "No problem. The proposed change was not applied." };
    }

    await this.approvals.updateStatus(approval.id, "approved");
    const result = await this.tools.execute(
      approval.toolName,
      { ...approval.arguments, confirmed: true },
      {
        event: {
          eventKey: `approval:${approval.id}`,
          source: "transport",
          type: "approval_confirmed",
          chatId: message.conversationId,
          message,
          payload: { approvalId: approval.id },
        },
        turnId: `approval:${approval.id}`,
        step: 0,
        actor,
        signal: new AbortController().signal,
      },
    );
    if (result.status !== "success") {
      await this.approvals.updateStatus(approval.id, "failed", result);
      return { text: `I could not apply that change. ${result.error ?? result.summary}` };
    }
    await this.approvals.updateStatus(approval.id, "executed", result.data ?? { summary: result.summary });
    return result.reply ?? { text: "Confirmed. The change has been applied." };
  }
}
