import type { WAMessage } from "@whiskeysockets/baileys";
import type { IncomingMessage, QuotedMessage } from "../../framework/contracts/messages.js";

type ContextInfo = {
  mentionedJid?: string[];
  stanzaId?: string;
  participant?: string;
  quotedMessage?: Record<string, unknown>;
};

type MessageShape = Record<string, unknown> & {
  conversation?: string;
  extendedTextMessage?: { text?: string; contextInfo?: ContextInfo };
  imageMessage?: { caption?: string; contextInfo?: ContextInfo };
  videoMessage?: { caption?: string; contextInfo?: ContextInfo };
  documentMessage?: { caption?: string; contextInfo?: ContextInfo };
};

export function getBaseJid(jid: string): string {
  const [userPart, domainPart] = jid.split("@");
  return `${userPart.split(":")[0]}@${domainPart}`;
}

export function extractMessageText(message?: Record<string, unknown>): string {
  if (!message) return "";
  const content = unwrapEphemeral(message) as MessageShape;
  return (
    content.extendedTextMessage?.text ??
    content.conversation ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ""
  ).trim();
}

export function extractContextInfo(message?: Record<string, unknown>): ContextInfo | undefined {
  if (!message) return undefined;
  const content = unwrapEphemeral(message) as MessageShape;
  return (
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.documentMessage?.contextInfo
  );
}

export function isEchoMentioned(mentions: string[], botIds: string[]): boolean {
  const normalizedMentions = new Set(mentions.map(getBaseJid));
  return botIds.filter(Boolean).map(getBaseJid).some((botId) => normalizedMentions.has(botId));
}

export function isReplyToEcho(contextInfo: ContextInfo | undefined, botIds: string[]): boolean {
  if (!contextInfo?.participant) return false;
  const quotedSender = getBaseJid(contextInfo.participant);
  return botIds.filter(Boolean).map(getBaseJid).includes(quotedSender);
}

export function extractQuotedMessage(contextInfo?: ContextInfo): QuotedMessage | undefined {
  if (!contextInfo?.quotedMessage) return undefined;
  const text = extractMessageText(contextInfo.quotedMessage);
  if (!text) return undefined;
  return {
    id: contextInfo.stanzaId,
    authorId: contextInfo.participant,
    text,
  };
}

export function normalizeWhatsAppMessage(raw: WAMessage, botIds: string[]): IncomingMessage | null {
  const key = raw.key ?? {};
  if (key.fromMe) return null;

  const chatId = key.remoteJid ?? "";
  const message = (raw.message ?? {}) as Record<string, unknown>;
  const rawText = extractMessageText(message);
  if (!rawText) return null;

  const contextInfo = extractContextInfo(message);
  const mentions = contextInfo?.mentionedJid ?? [];
  const botMentioned = isEchoMentioned(mentions, botIds);
  const repliedToBot = isReplyToEcho(contextInfo, botIds);
  const cleaned = removeBotMentions(rawText, botIds);

  return {
    id: key.id ?? "",
    conversationId: chatId,
    transport: "whatsapp",
    sender: {
      id: key.participant ?? key.remoteJid ?? "",
      displayName: raw.pushName ?? undefined,
      identifiers: { participantPhoneJid: key.participantPn ?? key.senderPn },
    },
    text: cleaned,
    rawText,
    mentions,
    mentionedAgent: botMentioned,
    repliedToAgent: repliedToBot,
    quotedMessage: extractQuotedMessage(contextInfo),
    metadata: {},
  };
}

/** Removes only Echo's explicit mention token while preserving member mentions. */
export function removeBotMentions(text: string, botIds: string[]): string {
  const botUsers = new Set(
    botIds
      .filter(Boolean)
      .map((jid) => jid.split("@")[0].split(":")[0])
      .filter(Boolean),
  );
  let cleaned = text;
  for (const user of botUsers) {
    const escaped = user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`@${escaped}(?=$|\\s|[.,!?;:])`, "g"), "");
  }
  return cleaned.replace(/[ \t]{2,}/g, " ").trim();
}

/** Converts readable mention labels into the JID tokens expected by WhatsApp. */
export function formatOutgoingWhatsAppMentions(
  text: string,
  mentions: string[] = [],
  labels: string[] = [],
): string {
  if (mentions.length === 0 || mentions.length !== labels.length) return text;

  let formatted = text;
  for (const [index, mention] of mentions.entries()) {
    const label = labels[index]?.trim();
    const user = mention.split("@")[0]?.split(":")[0];
    if (!label || !user) continue;
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    formatted = formatted.replace(new RegExp(`@${escapedLabel}`, "gi"), `@${user}`);
  }
  return formatted;
}

function unwrapEphemeral(message: Record<string, unknown>): Record<string, unknown> {
  const ephemeral = message.ephemeralMessage as { message?: Record<string, unknown> } | undefined;
  const viewOnce = message.viewOnceMessage as { message?: Record<string, unknown> } | undefined;
  return ephemeral?.message ?? viewOnce?.message ?? message;
}
