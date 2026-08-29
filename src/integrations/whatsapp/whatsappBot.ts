import {
  DisconnectReason,
  WAMessage,
  WASocket,
  fetchLatestBaileysVersion,
  makeWASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import type { IncomingMessage, OutgoingMessage } from "../../framework/contracts/messages.js";
import QRCode from "qrcode";
import type { IdentityRepository } from "../../agent/ports.js";
import { useSupabaseAuthState } from "./auth.js";
import { areScheduledMessagesDisabled, disableScheduledMessages, enableScheduledMessages as enableSchedulerMessages } from "../../integrations/scheduler/jobScheduler.js";
import type { MessageRouter } from "../../app/messageRouter.js";
import { WhatsAppFrameworkAdapter } from "./frameworkAdapter.js";
import type { WorkflowService } from "../../workflows/workflowService.js";
import type { ReminderScheduler } from "../../workflows/reminderScheduler.js";
import type { ReminderRecord } from "../../workflows/types.js";
import type { EchoAgentService } from "../../agent/services/echoAgentService.js";
import type { ScheduledAgentTaskService } from "../../agent/services/scheduledAgentTaskService.js";
import type { ChoirScheduleService } from "../../domains/choir/operations/choirScheduleService.js";
import { applyWhatsAppConversationPolicy } from "./conversationPolicy.js";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * WhatsApp transport adapter built with Baileys.
 */
export class WhatsAppBot {
  private socket: WASocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private connected = false;
  private ready = false;
  private stopped = true;
  private botJid = "";
  private botLid = "";
  private botPhoneJid = "";
  private botName = "";
  private readonly transportAdapter = new WhatsAppFrameworkAdapter(
    () => [this.botJid, this.botLid, this.botPhoneJid],
  );

  /**
   * @param messageHandler Application-level handler for incoming messages.
   */
  public constructor(
    private readonly messageRouter: MessageRouter,
    private readonly workflowService?: WorkflowService,
    private readonly reminderScheduler?: ReminderScheduler,
    private readonly agentService?: EchoAgentService,
    private readonly choirScheduleService?: ChoirScheduleService,
    private readonly identities?: IdentityRepository,
    private readonly scheduledTasks?: ScheduledAgentTaskService,
  ) {
    this.messageRouter.setScheduledMessageControls({
      disable: disableScheduledMessages,
      enable: () => this.enableScheduledMessages(),
      isDisabled: areScheduledMessagesDisabled,
    });
  }
  /**
   * Starts WhatsApp connection and message listeners.
   */
  public async start(): Promise<void> {
    this.stopped = false;
    if (this.connectPromise) return this.connectPromise;

    const connecting = this.openSocket();
    this.connectPromise = connecting;
    try {
      await connecting;
    } finally {
      if (this.connectPromise === connecting) this.connectPromise = null;
    }
  }

  /** Indicates that WhatsApp is connected and startup recovery has completed. */
  public isReady(): boolean {
    return this.ready;
  }

  /** Stops reconnects and releases the current socket during application shutdown. */
  public stop(): void {
    this.stopped = true;
    this.connected = false;
    this.ready = false;
    this.cancelReconnectTimer();
    this.disposeSocket(this.socket);
  }

  private async openSocket(): Promise<void> {
    const { state, saveCreds } = await useSupabaseAuthState(env.WHATSAPP_SESSION_ID);
    const { version } = await fetchLatestBaileysVersion();
    if (this.stopped) return;

    this.disposeSocket(this.socket);
    const socket = makeWASocket({
      auth: state,
      version,
      markOnlineOnConnect: true,
      emitOwnEvents: true,
      syncFullHistory: false
    });
    this.socket = socket;

    socket.ev.on("creds.update", () => {
      void saveCreds().catch((error) => {
        logger.error({ error }, "Failed to persist WhatsApp credentials");
        this.scheduleReconnect(socket);
      });
    });
    socket.ev.on("connection.update", (update) => {
      const { qr } = update;

      // WhatsApp needs authentication
      if (qr) {
        void this.printPairingQr(qr);
      }

      void this.onConnectionUpdate(socket, update.connection, update.lastDisconnect?.error as Boom | undefined)
        .catch((error) => {
          logger.error({ error }, "WhatsApp connection recovery failed");
          this.scheduleReconnect(socket);
        });
    });
    socket.ev.on("messages.upsert", (event) => {
      this.printObservedGroupIds(event.messages);
      void this.onMessages(socket, event.messages).catch((error) => {
        logger.error({ error }, "Failed processing WhatsApp message batch");
      });
    });
  }

  private async onConnectionUpdate(
    socket: WASocket,
    connection: string | undefined,
    error?: Boom
  ): Promise<void> {
    if (socket !== this.socket || this.stopped) return;

    if (connection === "open") {
      this.connected = true;
      this.botJid = socket.user?.id ?? "";
      this.botLid = socket.user?.lid ?? "";
      this.botPhoneJid = socket.user?.jid ?? "";
      this.botName = socket.user?.name ?? "";
      this.reminderScheduler?.setHandlers(
        (reminder) => this.sendScheduledReminder(reminder),
        (id) => this.workflowService?.completeReminder(id) ?? Promise.resolve()
      );
      await this.workflowService?.recoverSchedules();
      await this.workflowService?.recoverWorkflowCache();
      await this.scheduledTasks?.recover();
      await this.choirScheduleService?.start();

      if (socket !== this.socket || this.stopped) return;
      this.ready = true;
      this.reconnectAttempt = 0;
      logger.info(
        { botJid: this.botJid, botLid: this.botLid, botPhoneJid: this.botPhoneJid, botName: this.botName },
        "WhatsApp connected",
      );
      return;
    }

    if (connection === "close") {
      this.connected = false;
      this.ready = false;
      const code = error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, "WhatsApp connection closed");
      if (!shouldReconnect) {
        this.stopped = true;
        this.disposeSocket(socket);
        return;
      }
      this.scheduleReconnect(socket);
    }
  }

  private scheduleReconnect(expectedSocket?: WASocket): void {
    if (this.stopped || this.reconnectTimer) return;
    if (expectedSocket && expectedSocket !== this.socket) return;

    this.ready = false;
    this.connected = false;
    if (expectedSocket) this.disposeSocket(expectedSocket);
    const delay = reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    logger.warn({ attempt: this.reconnectAttempt, delay }, "WhatsApp reconnect scheduled");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start().catch((error) => {
        logger.error({ error, attempt: this.reconnectAttempt }, "Failed to reconnect WhatsApp");
        this.scheduleReconnect();
      });
    }, delay);
  }

  private cancelReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private disposeSocket(socket: WASocket | null): void {
    if (!socket) return;
    socket.ev.removeAllListeners("creds.update");
    socket.ev.removeAllListeners("connection.update");
    socket.ev.removeAllListeners("messages.upsert");
    try {
      socket.end(undefined);
    } catch (error) {
      logger.warn({ error }, "Failed to close previous WhatsApp socket cleanly");
    }
    if (this.socket === socket) {
      this.socket = null;
      this.connected = false;
      this.ready = false;
    }
  }

  private async printPairingQr(qr: string): Promise<void> {
    try {
      const qrString = await QRCode.toString(qr, { type: "terminal", small: true });
      console.log(qrString);
    } catch (error) {
      logger.error({ error }, "Failed to render WhatsApp pairing QR");
    }
  }

  private async onMessages(socket: WASocket, messages: WAMessage[]): Promise<void> {
    if (socket !== this.socket || !this.connected) return;

    for (const raw of messages) {
      if (socket !== this.socket || !this.connected) return;
      try {
        const normalized = await this.normalizeMessage(raw);
        if (!normalized) {
          continue;
        }

        const reply = await this.messageRouter.handle(normalized);
        if (!reply) {
          continue;
        }

        await this.sendAgentMessage(normalized.conversationId, reply);
      } catch (error) {
        logger.error({ error }, "Failed processing incoming WhatsApp message");
      }
    }
  }

  /** Prints group IDs from raw events before application routing filters run. */
  private printObservedGroupIds(messages: WAMessage[]): void {
    if (!env.WHATSAPP_LOG_GROUP_IDS) return;
    const groupIds = new Set(
      messages
        .map((message) => message.key?.remoteJid)
        .filter((groupId): groupId is string => Boolean(groupId?.endsWith("@g.us"))),
    );
    for (const groupId of groupIds) console.log(`[WhatsApp group ID] ${groupId}`);
  }

  private async normalizeMessage(raw: WAMessage): Promise<IncomingMessage | null> {
    const normalized = this.transportAdapter.toFrameworkMessage(raw);
    if (!normalized) return null;

    // --- Allowed chats ---

    const isGroup = normalized.conversationId.endsWith("@g.us");
    const member = !isGroup ? await this.identities?.resolveSender(normalized.sender) : null;
    const privateSenderAllowed = Boolean(member?.roles.some((role) => role === "superuser" || role === "creator"));
    return applyWhatsAppConversationPolicy(normalized, {
      groupId: env.WHATSAPP_GROUP_ID,
      allowAllGroups: env.WHATSAPP_ALLOW_ALL_GROUPS,
      privateSenderAllowed,
    });
  }

  public async sendAgentMessage(chatId: string, reply: OutgoingMessage): Promise<{ messageId: string }> {
    if (!this.socket || !this.connected) {
      throw new Error("WhatsApp transport is not connected.");
    }
    const payload = this.transportAdapter.toNativeMessage(reply);
    const sent = await this.socket.sendMessage(chatId, payload);
    const confirmationMessageId = sent?.key.id;
    const workflowConfirmation = reply.metadata?.workflowConfirmation as {
      workflowType: "reminder";
      workflowId: string;
      ownerId: string;
      state: string;
    } | undefined;
    if (workflowConfirmation && confirmationMessageId) {
      await this.workflowService?.registerConfirmationMessage({
        ...workflowConfirmation,
        confirmationMessageId,
      });
    }
    const agentApproval = reply.metadata?.agentApproval as { approvalId: string } | undefined;
    if (agentApproval && confirmationMessageId) {
      await this.agentService?.registerApprovalMessage(agentApproval.approvalId, confirmationMessageId);
    }
    return { messageId: confirmationMessageId ?? "" };
  }

  private async sendScheduledReminder(reminder: ReminderRecord): Promise<void> {
    const mention = reminder.creatorId;
    const phone = mention.split("@")[0];
    await this.sendAgentMessage(reminder.chatId, {
      text: `@${phone} Reminder\n\n${reminder.message}`,
      mentions: [mention],
    });
  }

  private enableScheduledMessages(): void {
    enableSchedulerMessages();
    void (async () => {
      await this.workflowService?.recoverSchedules();
      await this.scheduledTasks?.recover();
      await this.choirScheduleService?.start();
    })().catch((error) => {
      logger.error({ error }, "Failed to restore scheduled messages");
    });
  }

}

/** Exponential reconnect delay capped to avoid hot-looping during outages. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(INITIAL_RECONNECT_DELAY_MS * 2 ** Math.max(0, attempt), MAX_RECONNECT_DELAY_MS);
}
