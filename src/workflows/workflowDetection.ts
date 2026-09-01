export function isExplicitWorkflowActivation(text: string, quotedMessageId?: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (/#submit_setlist\b/i.test(normalized)) return true;
  if (isExplicitReminderActivation(normalized)) return true;
  return Boolean(quotedMessageId) && /^(?:yes|y|no|n|edit\b|cancel\s+reminder\b)/i.test(normalized);
}

export function isExplicitReminderActivation(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return [
    /^(?:@\S+\s+)?(?:echo(?:\s*[,.:;-]\s*|\s+))?(?:please\s+)?remind\s+(?:me|us|everyone|the\s+(?:group|choir))\b/,
    /\b(?:can|could|would)\s+you\s+remind\s+(?:me|us|everyone|the\s+(?:group|choir))\b/,
    /\bplease\s+remind\s+(?:me|us|everyone|the\s+(?:group|choir))\b/,
    /\bset\s+(?:a\s+)?reminder\b/,
    /\bcreate\s+(?:a\s+)?reminder\b/,
    /\badd\s+(?:a\s+)?reminder\b/,
    /\bschedule\s+(?:a\s+)?reminder\b/,
    /\breminder\s+(?:for|to|about|on|at)\b/,
  ].some((pattern) => pattern.test(normalized));
}

/**
 * Confirms that an extracted execution parameter originated in the current
 * command. Case and whitespace may be normalized, but the model may not
 * rewrite, infer or source the phrase from other context.
 */
export function isPhrasePresentInCurrentMessage(messageText: string, phrase: string): boolean {
  const normalizedMessage = normalizePhraseOriginText(messageText);
  const normalizedPhrase = normalizePhraseOriginText(phrase);
  return normalizedPhrase.length > 0 && normalizedMessage.includes(normalizedPhrase);
}

function normalizePhraseOriginText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-GB").replace(/\s+/g, " ").trim();
}

export type ReminderReplyAction = "confirm" | "decline" | "edit" | "request_cancel";

/**
 * Resolves only explicit reminder replies. This keeps exact workflow controls
 * deterministic while leaving the LLM responsible for interpreting edit details.
 */
export function parseReminderReplyAction(text: string): ReminderReplyAction | null {
  const normalized = text.trim();
  if (/^(?:yes|y)$/i.test(normalized)) return "confirm";
  if (/^(?:no|n)$/i.test(normalized)) return "decline";
  if (/^edit\b/i.test(normalized)) return "edit";
  if (/\bcancel\s+reminder\b/i.test(normalized)) return "request_cancel";
  return null;
}
