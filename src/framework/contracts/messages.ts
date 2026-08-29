/** A transport-neutral identity supplied by an integration adapter. */
export interface ExternalIdentity {
  id: string;
  displayName?: string;
  /** Transport-specific identifiers remain opaque to the agent runtime. */
  identifiers: Record<string, string | undefined>;
}

export interface QuotedMessage {
  id?: string;
  authorId?: string;
  text: string;
}

/** Canonical message consumed by the agent regardless of its source transport. */
export interface IncomingMessage {
  id: string;
  conversationId: string;
  transport: string;
  sender: ExternalIdentity;
  text: string;
  rawText?: string;
  mentions: string[];
  mentionedAgent?: boolean;
  repliedToAgent?: boolean;
  quotedMessage?: QuotedMessage;
  metadata: Record<string, unknown>;
}

/** Canonical response produced by the agent and encoded by a transport adapter. */
export interface OutgoingMessage {
  text: string;
  mentions?: string[];
  /** Human-readable labels aligned by index with mention targets. */
  mentionLabels?: string[];
  replyToMessageId?: string;
  /** Workflow extensions are carried without coupling the framework to a domain. */
  metadata?: Record<string, unknown>;
}

export interface SentMessageReceipt {
  messageId: string;
}

/** Contract implemented by WhatsApp today and future transports later. */
export interface TransportAdapter<TNativeIncoming, TNativeOutgoing> {
  readonly id: string;
  toFrameworkMessage(message: TNativeIncoming): IncomingMessage | null;
  toNativeMessage(message: OutgoingMessage): TNativeOutgoing;
}
