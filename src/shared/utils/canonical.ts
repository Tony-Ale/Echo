/**
 * Recursively sorts object keys to produce stable JSON serialization.
 *
 * @param value Any JSON-like value.
 * @returns Deep-sorted value.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortKeysDeep(v));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const result: Record<string, unknown> = {};
    for (const [key, nested] of entries) {
      result[key] = sortKeysDeep(nested);
    }
    return result;
  }

  return value;
}

/**
 * Returns canonical JSON string for deterministic hashing.
 *
 * @param value Any serializable value.
 * @returns Stable JSON string.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
