/**
 * Sanitizes any sheet name to Pinecone-safe namespace string.
 *
 * @param sheetName Raw sheet tab name.
 * @returns Lowercase namespace identifier.
 */
export function toNamespace(sheetName: string): string {
  return sheetName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
