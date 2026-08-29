import type { RuntimeIdentityRecord } from "../../agent/persistence/identityRepository.js";
import type { MessageTransport } from "../../framework/ports/index.js";
import type { IncomingMessage, OutgoingMessage, QuotedMessage, SentMessageReceipt } from "../../framework/contracts/messages.js";
import { clockService } from "../../shared/clockService.js";
import { randomUUID } from "node:crypto";

export interface LocalChatActor {
  id: string;
  displayName: string;
  canonicalName: string | null;
  roles: string[];
  registered: boolean;
}

export interface LocalChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderType: "member" | "echo";
  text: string;
  createdAt: string;
  replyToMessageId?: string;
}

type MessageListener = (message: LocalChatMessage) => void;

export interface LocalIdentityDirectory {
  getRuntimeDirectorySnapshot(): Promise<RuntimeIdentityRecord[]>;
}

export interface LocalWorkflowConfirmationRegistry {
  registerConfirmationMessage(input: {
    workflowType: "reminder";
    workflowId: string;
    ownerId: string;
    state: string;
    confirmationMessageId: string;
  }): Promise<void>;
}

export interface LocalApprovalRegistry {
  registerApprovalMessage(approvalId: string, messageId: string): Promise<void>;
}

/**
 * In-process group-chat transport for staging. Private transport identifiers
 * are used only while normalizing incoming messages and never leave the server.
 */
export class LocalChatTransport implements MessageTransport {
  private readonly messages: LocalChatMessage[] = [];
  private readonly listeners = new Set<MessageListener>();
  private actors = new Map<string, RuntimeIdentityRecord>();
  private readonly simulatedActors = new Map<string, RuntimeIdentityRecord>();
  private sequence = 0;

  public constructor(
    private readonly conversationId: string,
    private readonly identities: LocalIdentityDirectory,
    private readonly workflows: LocalWorkflowConfirmationRegistry,
    private readonly agent: LocalApprovalRegistry,
  ) {}

  public async refreshActors(): Promise<LocalChatActor[]> {
    const records = await this.identities.getRuntimeDirectorySnapshot();
    this.actors = new Map(records.map((record) => [record.id, record]));
    for (const [id, simulated] of this.simulatedActors) {
      if (records.some((record) => sameAuthoritativeIdentity(record, simulated))) this.simulatedActors.delete(id);
    }
    return this.listActors();
  }

  /** Adds an unregistered participant so onboarding can be tested end to end. */
  public addSimulatedActor(displayName: string): LocalChatActor {
    this.sequence += 1;
    const actor: RuntimeIdentityRecord = {
      id: randomUUID(),
      canonicalName: null,
      displayName: displayName.trim(),
      phone: `999${clockService.now().toMillis()}${this.sequence}`,
      roles: [],
    };
    this.simulatedActors.set(actor.id, actor);
    return toLocalActor(actor, false);
  }

  public listActors(): LocalChatActor[] {
    return [...this.actors.values(), ...this.simulatedActors.values()]
      .filter((actor) => Boolean(actor.phone || actor.whatsappJid))
      .map((actor) => toLocalActor(actor, this.actors.has(actor.id)));
  }

  public getMessages(): LocalChatMessage[] {
    return [...this.messages];
  }

  public clearMessages(): void {
    this.messages.length = 0;
  }

  public subscribe(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public createIncoming(input: { actorId: string; text: string; replyToMessageId?: string }): IncomingMessage {
    const actor = this.getActor(input.actorId);
    if (!actor) throw new Error("Unknown staging member. Refresh the member directory and try again.");
    const authoritativeId = actor.whatsappJid ?? actor.phone;
    if (!authoritativeId) throw new Error("This member has no verified WhatsApp identifier in Supabase.");

    const quoted = input.replyToMessageId ? this.messages.find((message) => message.id === input.replyToMessageId) : undefined;
    if (input.replyToMessageId && !quoted) throw new Error("The quoted staging message no longer exists.");
    const messageId = this.nextId("member");
    const quotedMessage: QuotedMessage | undefined = quoted ? {
      id: quoted.id,
      authorId: quoted.senderId,
      text: quoted.text,
    } : undefined;

    return {
      id: messageId,
      conversationId: this.conversationId,
      transport: "local-chat",
      sender: {
        id: authoritativeId,
        displayName: actor.displayName,
        identifiers: { phone: actor.phone, whatsappJid: actor.whatsappJid },
      },
      text: input.text.trim(),
      rawText: input.text,
      mentions: [],
      mentionedAgent: true,
      repliedToAgent: quoted?.senderType === "echo",
      quotedMessage,
      metadata: {
        staging: true,
        conversationKind: "choir",
        ...(this.actors.has(actor.id) ? { actorMemberId: actor.id } : {}),
      },
    };
  }

  public recordIncoming(message: IncomingMessage, actorId: string): LocalChatMessage {
    const actor = this.getActor(actorId);
    if (!actor) throw new Error("Unknown staging member.");
    return this.append({
      id: message.id,
      senderId: actor.id,
      senderName: actor.displayName,
      senderType: "member",
      text: message.text,
      createdAt: clockService.now().toISO()!,
      replyToMessageId: message.quotedMessage?.id,
    });
  }

  public async send(conversationId: string, message: OutgoingMessage): Promise<SentMessageReceipt> {
    if (conversationId !== this.conversationId) {
      throw new Error(`Local staging cannot send to conversation '${conversationId}'.`);
    }
    const sent = this.append({
      id: this.nextId("echo"),
      senderId: "echo",
      senderName: "Echo",
      senderType: "echo",
      text: message.text,
      createdAt: clockService.now().toISO()!,
      replyToMessageId: message.replyToMessageId,
    });

    const workflow = message.metadata?.workflowConfirmation as {
      workflowType: "reminder";
      workflowId: string;
      ownerId: string;
      state: string;
    } | undefined;
    if (workflow) {
      await this.workflows.registerConfirmationMessage({ ...workflow, confirmationMessageId: sent.id });
    }
    const approval = message.metadata?.agentApproval as { approvalId: string } | undefined;
    if (approval) await this.agent.registerApprovalMessage(approval.approvalId, sent.id);
    return { messageId: sent.id };
  }

  private append(message: LocalChatMessage): LocalChatMessage {
    this.messages.push(message);
    if (this.messages.length > 300) this.messages.splice(0, this.messages.length - 300);
    for (const listener of this.listeners) listener(message);
    return message;
  }

  private nextId(sender: "member" | "echo"): string {
    this.sequence += 1;
    return `local-${sender}-${clockService.now().toMillis()}-${this.sequence}`;
  }

  private getActor(id: string): RuntimeIdentityRecord | undefined {
    return this.actors.get(id) ?? this.simulatedActors.get(id);
  }
}

function toLocalActor(actor: RuntimeIdentityRecord, registered: boolean): LocalChatActor {
  return {
    id: actor.id,
    canonicalName: actor.canonicalName,
    displayName: actor.displayName,
    roles: actor.roles,
    registered,
  };
}

function sameAuthoritativeIdentity(left: RuntimeIdentityRecord, right: RuntimeIdentityRecord): boolean {
  const leftValues = [left.phone, left.whatsappJid]
    .filter((value): value is string => Boolean(value))
    .map(normalizePhone);
  return [right.phone, right.whatsappJid]
    .filter((value): value is string => Boolean(value))
    .some((value) => leftValues.includes(normalizePhone(value)));
}

function normalizePhone(value: string): string {
  return value.split("@")[0].split(":")[0].replace(/\D/g, "");
}
