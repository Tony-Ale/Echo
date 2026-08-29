import { createHash } from "node:crypto";

/**
 * Computes SHA256 digest from input text.
 *
 * @param input Raw text content.
 * @returns Hex digest string.
 */
export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
