import { canonicalJson } from "../shared/utils/canonical.js";
import { sha256 } from "../shared/utils/hash.js";
import { SheetRow } from "../shared/types.js";
import { isMonthlyRotaSheet } from "../integrations/googleSheets/utils.js";

const STABLE_KEY_CANDIDATES = [
  "date",
  "role",
  "lead",
  "supporting link/ info",
  "song",
  "month",
  "composer",
  "event",
  "theme",
];

/**
 * Builds a deterministic row ID from stable fields if present; otherwise from the full row.
 *
 * @param sheetName Sheet tab name.
 * @param values Key/value object for row cells.
 * @returns Deterministic row identifier.
 */
export function buildDeterministicRowId(sheetName: string, values: Record<string, string>): string {
  const normalizedEntries = Object.entries(values).map(([k, v]) => [k.trim().toLowerCase(), v.trim()] as const);
  const map = new Map(normalizedEntries);
  const stablePairs: string[] = [];

  for (const candidate of STABLE_KEY_CANDIDATES) {
    const value = map.get(candidate);
    if (value) {
      stablePairs.push(`${candidate}:${value}`);
    }
  }

  if (stablePairs.length === 0) {
    const all = normalizedEntries
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`);
    stablePairs.push(...all);
  }

  return sha256(`${sheetName}|${stablePairs.join("|")}`);
}

/**
 * Converts a sheet row into canonical content + hash suitable for vector indexing.
 *
 * @param sheetName Source sheet name.
 * @param values Key/value data for one logical row.
 * @returns Normalized row model.
 */
export function normalizeRow(sheetName: string, values: Record<string, string>): SheetRow {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }
    cleaned[normalizedKey] = String(value ?? "").trim();
  }

  const rowId = `${sheetName}-${buildDeterministicRowId(sheetName, cleaned)}`;
  const canonical = canonicalJson({ sheetName, values: cleaned });
  const contentHash = `${sheetName}-${sha256(canonical)}`;
  const content = Object.entries(cleaned)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  // handle metadata
  const metadata: Record<string, string> = {};

  if (isMonthlyRotaSheet(sheetName)){
    metadata["WEEK_START"] = values.WEEK_START
  }
  return {
    sheetName,
    rowId,
    values: cleaned,
    content,
    contentHash,
    metadata
  };
}
