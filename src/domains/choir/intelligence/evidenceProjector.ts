import { DateTime } from "luxon";

export interface TemporalEvidenceReference {
  text: string;
  date_equivalent: string;
  end_date_equivalent?: string;
}

interface DateWindow {
  start: DateTime;
  end: DateTime;
}

const DATE_FORMATS = [
  "yyyy-MM-dd",
  "dd/LL/yyyy",
  "dd-LLL-yy",
  "dd-LLLL-yy",
  "dd/LLL/yyyy",
  "dd/LLLL/yyyy",
] as const;
const DATE_PATTERN = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/(?:\d{1,2}|[A-Za-z]{3,9})\/\d{2,4}|\d{1,2}-[A-Za-z]{3,9}-\d{2,4})\b/gi;

/**
 * Projects dated sheet records to the user's deterministic temporal window.
 * Undated sources are preserved unchanged. This keeps retrieval source-agnostic
 * while preventing whole-year evidence from entering a single dated turn.
 */
export function projectStructuredEvidence(
  rowsBySheet: Map<string, Record<string, string>[]>,
  query: string,
  temporalReferences: TemporalEvidenceReference[],
): Map<string, Record<string, string>[]> {
  const windows = buildDateWindows(query, temporalReferences);
  if (windows.length === 0) return rowsBySheet;

  const projected = new Map<string, Record<string, string>[]>();
  for (const [sheetName, rows] of rowsBySheet) {
    const sheetContainsDates = rows.some((row) => extractDates(JSON.stringify(row)).length > 0);
    if (!sheetContainsDates) {
      projected.set(sheetName, rows);
      continue;
    }

    const relevantRows = rows
      .filter((row) => extractDates(JSON.stringify(row)).some((date) => isWithinWindows(date, windows)))
      .map((row) => projectRowLines(row, windows));
    if (relevantRows.length > 0) projected.set(sheetName, relevantRows);
  }
  return projected;
}

/**
 * Reports whether dated evidence intersects the requested temporal window.
 * This deliberately does not treat undated or wrong-week text as a match:
 * operational reminders must be supported by evidence for their target week.
 */
export function evidenceMatchesTemporalWindow(
  value: string,
  query: string,
  temporalReferences: TemporalEvidenceReference[],
): boolean {
  const windows = buildDateWindows(query, temporalReferences);
  if (windows.length === 0) return false;
  return extractDates(value).some((date) => isWithinWindows(date, windows));
}

/**
 * Removes dated semantic sections outside the requested window. Vector search
 * can return a whole monthly or annual row; passing that unprojected text to
 * the planner creates temporal noise even when one date happens to match.
 */
export function projectTextEvidence(
  value: string,
  query: string,
  temporalReferences: TemporalEvidenceReference[],
): string {
  const windows = buildDateWindows(query, temporalReferences);
  if (windows.length === 0 || extractDates(value).length === 0) return value;
  return projectLines(value.split(/\r?\n/), windows).join("\n").trim();
}

function buildDateWindows(query: string, references: TemporalEvidenceReference[]): DateWindow[] {
  const normalizedQuery = query.toLowerCase();
  return references.flatMap((reference) => {
    const start = parseReferenceDate(reference.date_equivalent);
    if (!start) return [];
    const explicitEnd = reference.end_date_equivalent
      ? parseReferenceDate(reference.end_date_equivalent)
      : null;
    if (explicitEnd) return [{ start: DateTime.min(start, explicitEnd), end: DateTime.max(start, explicitEnd) }];
    if (/\bweek(?:ly)?\b/.test(normalizedQuery)) {
      const weekStart = start.startOf("week");
      return [{ start: weekStart, end: weekStart.plus({ days: 6 }).endOf("day") }];
    }
    if (/\bmonth(?:ly)?\b/.test(normalizedQuery)) {
      return [{ start: start.startOf("month"), end: start.endOf("month") }];
    }
    return [{ start: start.startOf("day"), end: start.endOf("day") }];
  });
}

function projectRowLines(row: Record<string, string>, windows: DateWindow[]): Record<string, string> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    const lines = value.split(/\r?\n/);
    if (lines.length === 1) return [key, value];
    return [key, projectLines(lines, windows).join("\n")];
  }));
}

function projectLines(lines: string[], windows: DateWindow[]): string[] {
  let activeSection: boolean | null = null;
  return lines.filter((line) => {
    const dates = extractDates(line);
    if (dates.length > 0) activeSection = dates.some((date) => isWithinWindows(date, windows));
    return activeSection !== false;
  });
}

function extractDates(value: string): DateTime[] {
  // Create a fresh matcher because this helper is called repeatedly while
  // projecting rows; shared global RegExp state must not skip later dates.
  // JSON-serialized multiline fields contain literal `\n`, whose trailing
  // letter would otherwise hide the word boundary before the following date.
  const searchable = value.replace(/\\[nr]/g, "\n");
  const candidates = [...searchable.matchAll(new RegExp(DATE_PATTERN.source, DATE_PATTERN.flags))]
    .map((match) => match[0]);
  return candidates.flatMap((candidate) => {
    for (const format of DATE_FORMATS) {
      const parsed = DateTime.fromFormat(candidate, format, { zone: "Europe/London", locale: "en-GB" });
      if (parsed.isValid) return [parsed.startOf("day")];
    }
    return [];
  });
}

function parseReferenceDate(value: string): DateTime | null {
  const parsed = DateTime.fromFormat(value, "dd/LL/yyyy", { zone: "Europe/London" });
  return parsed.isValid ? parsed.startOf("day") : null;
}

function isWithinWindows(date: DateTime, windows: DateWindow[]): boolean {
  return windows.some((window) => date.toMillis() >= window.start.toMillis() && date.toMillis() <= window.end.toMillis());
}
