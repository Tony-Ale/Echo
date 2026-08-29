import type { IncomingMessage } from "../../framework/contracts/messages.js";

/**
 * Applies deployment-level WhatsApp boundaries after normalization.
 * The configured group establishes ordinary membership for this deployment;
 * private access remains a separate privileged policy.
 */
export function applyWhatsAppConversationPolicy(
  message: IncomingMessage,
  input: { groupId: string; allowAllGroups: boolean; privateSenderAllowed: boolean },
): IncomingMessage | null {
  const isGroup = message.conversationId.endsWith("@g.us");
  if (isGroup) {
    if (!input.allowAllGroups && message.conversationId !== input.groupId) return null;
    if (!message.mentionedAgent && !message.repliedToAgent) return null;
    return { ...message, metadata: { ...message.metadata, conversationKind: "choir" } };
  }
  if (!input.privateSenderAllowed) return null;
  return { ...message, metadata: { ...message.metadata, conversationKind: "private" } };
}
