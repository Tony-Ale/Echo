import type { AnyMessageContent, WAMessage } from "@whiskeysockets/baileys";
import type { OutgoingMessage, TransportAdapter } from "../../framework/contracts/messages.js";
import { formatOutgoingWhatsAppMentions, normalizeWhatsAppMessage } from "./messageUtils.js";

/** Complete Baileys-to-framework boundary used by the WhatsApp plugin. */
export class WhatsAppFrameworkAdapter implements TransportAdapter<WAMessage, AnyMessageContent> {
  public readonly id = "whatsapp";

  public constructor(private readonly getBotIds: () => string[]) {}

  public toFrameworkMessage(message: WAMessage) {
    return normalizeWhatsAppMessage(message, this.getBotIds());
  }

  public toNativeMessage(message: OutgoingMessage): AnyMessageContent {
    return {
      text: formatOutgoingWhatsAppMentions(message.text, message.mentions, message.mentionLabels),
      mentions: message.mentions,
    };
  }
}
