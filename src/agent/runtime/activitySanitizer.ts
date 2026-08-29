const PRIVATE_KEY = /(phone|jid|identifier|token|secret|password|authorization|memberid|ownerid|senderid)/i;
const TRANSPORT_IDENTIFIER = /\b\d{7,}(?:@(?:s\.whatsapp\.net|lid))?\b/gi;
const MAX_STRING_LENGTH = 240;
const MAX_ARRAY_ITEMS = 10;
const MAX_DEPTH = 3;

/** Keeps observability useful without leaking transport IDs or unbounded payloads. */
export function sanitizeActivityInput(input: Record<string, unknown>): Record<string, unknown> {
  return sanitizeObject(input, 0);
}

export function sanitizeActivityText(value: string): string {
  const redacted = value.replace(TRANSPORT_IDENTIFIER, "[private identifier]");
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH - 3)}...`
    : redacted;
}

function sanitizeObject(input: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth >= MAX_DEPTH) return { detail: "[nested data hidden]" };
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [
    key,
    PRIVATE_KEY.test(key) ? "[private]" : sanitizeValue(value, depth + 1),
  ]));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return sanitizeActivityText(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth));
  if (value && typeof value === "object") return sanitizeObject(value as Record<string, unknown>, depth);
  return value;
}
