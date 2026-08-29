import { WhatsAppBot } from "../integrations/whatsapp/whatsappBot.js";
import { env } from "../config/env.js";
import { createEchoApplication } from "./createEchoApplication.js";

/**
 * Dependency container factory.
 */
export class Container {
  /**
   * Builds WhatsApp bot runtime with all dependencies wired.
   *
   * @returns WhatsApp bot adapter.
   */
  public static async createBotRuntime(): Promise<WhatsAppBot> {
    const application = await createEchoApplication({ chatId: env.WHATSAPP_GROUP_ID, transportId: "whatsapp" });
    const bot = new WhatsAppBot(
      application.messageRouter,
      application.workflowService,
      application.reminderScheduler,
      application.agentService,
      application.choirScheduleService,
      application.identities,
      application.scheduledTasks,
    );
    application.agentService.setTransport({
      send: (chatId, reply) => bot.sendAgentMessage(chatId, reply),
    });
    return bot;
  }
}
