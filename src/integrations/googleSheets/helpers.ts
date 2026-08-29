import { FlattenedSheet, MonthlyRotaWeeklyDocument } from "./types";
import { ATTENDANCE, MONTHLY_ROTA, SHEET_REGISTRY, SM_LIBRARY } from "./utils";
import { DateTime } from "luxon";
/**
 * This function groups the SM Library sheets by themes.
 * @param rows 
 * @returns 
 */
export function reorganizeSmLibrary(
rows: Record<string, string>[]
): Record<string, string>[] {
    const themeMap = new Map<string, { ministrations: string[]; hymns: string[] }>();
    const {THEME, SPECIAL_MINISTRATIONS, HYMNS} = SHEET_REGISTRY[SM_LIBRARY].headers
    for (const values of rows) {
        const theme = values[THEME]?.trim();
        const ministration = values[SPECIAL_MINISTRATIONS]?.trim();
        const hymn = values[HYMNS]?.trim()

        if (!theme) continue;

        if (!themeMap.has(theme)) {
            themeMap.set(theme, { ministrations: [], hymns: [] });
        }

        if (ministration) themeMap.get(theme)!.ministrations.push(ministration);
        if (hymn) themeMap.get(theme)!.hymns.push(hymn);

    }

    const combined: Record<string, string>[] = [];

    for (const [theme, {ministrations, hymns}] of themeMap.entries()) {
        combined.push({
        [THEME]: theme,
        [SPECIAL_MINISTRATIONS]: ministrations.join(", "),
        [HYMNS]: hymns.join(", ")
        });
    }

    return combined;
}

// --------------------------------------Monthly Rota Reorganization-----------------------------------------
/**
 * Groups the monthly rota sheet into a weekly format
 * @param rows 
 * @returns 
 */
export function reorganizeMonthlyRota(
  rows: Record<string, string>[]
): MonthlyRotaWeeklyDocument[] {

    const {DATE, ROLE, LEAD, SUPPORTING_INFO} = SHEET_REGISTRY[MONTHLY_ROTA].headers

    const weekMap = new Map<string, Record<string, string>[]>();

    for (const row of rows) {
        const rawDate = row[DATE]?.trim();
        if (!rawDate) continue;

        const parsedDate = extractSheetDate(rawDate);
        if (!parsedDate) continue;

        // Echo's operational service week is Monday through Sunday. Grouping
        // from Sunday previously split Wednesday duties and the ending Sunday
        // service into different documents, which misled weekly workflows.
        const weekStart = parsedDate.startOf("week");
        const weekKey = weekStart.toISODate()!;

        if (!weekMap.has(weekKey)) {
        weekMap.set(weekKey, []);
        }

        weekMap.get(weekKey)!.push(row);
    }

    const weeklyDocuments: MonthlyRotaWeeklyDocument[] = [];

    for (const [weekKey, weekRows] of weekMap.entries()) {

        // Sort rows by actual date
        weekRows.sort((a, b) => {
        const da = extractSheetDate(a[DATE]);
        const db = extractSheetDate(b[DATE]);
        return (da?.toMillis() ?? 0) - (db?.toMillis() ?? 0);
        });

        let currentDate = "";
        let content = `Week of ${formatReadableDate(DateTime.fromISO(weekKey, { zone: "Europe/London" }))}\n\n`;

        for (const row of weekRows) {
        const rawDate = row[DATE];
        const role = row[ROLE]?.trim();
        const lead = row[LEAD]?.trim();
        const info = row[SUPPORTING_INFO]?.trim();

        if (rawDate && rawDate !== currentDate) {
            currentDate = rawDate;
            content += `${rawDate}\n`;
        }

        let line = "- ";

        if (role) line += role;

        if (lead) line += `: ${lead}`;

        if (info) line += ` (${info})`;

        content += line + "\n";
        }

        weeklyDocuments.push({
        WEEK_START: weekKey,
        CONTENT: content.trim()
        });
    }

    return weeklyDocuments;
}

function extractSheetDate(raw: string): DateTime | null {
  // Expects format: "Sunday 04/01/2026"
  const match = raw.match(/(\d{2}\/\d{2}\/\d{4})/);
  if (!match) return null;

  const [day, month, year] = match[1].split("/").map(Number);
  const parsed = DateTime.fromObject({ year, month, day }, { zone: "Europe/London" });
  return parsed.isValid ? parsed : null;
}

function formatReadableDate(date: DateTime): string {
  return date.toFormat("d LLLL yyyy");
}

// ---------------------------------------Flattening a table --------------------------------------------

/**
 * Flattens any table into a single content string suitable for embeddings.
 * Works for any number of rows and columns.
 * Usually for small tables
 * 
 * Each row becomes one line:
 *   "COL1: value1 | COL2: value2 | COL3: value3"
 */
export function flattenSheet(
  rows: Record<string, string>[]
): FlattenedSheet {
    const lines: string[] = [];

    for (const row of rows) {
        const rowParts: string[] = [];

        for (const [key, value] of Object.entries(row)) {
        const trimmedValue = value?.toString().trim();
        if (trimmedValue && key) {
            rowParts.push(`${key}: ${trimmedValue}`);
        }
        }

        if (rowParts.length > 0) {
        lines.push(rowParts.join(" | "));
        }
    }

    return {
        CONTENT: lines.join("\n"),
    };
}

//-------------------------------Attendance sheet reorganizing--------------------------------------
export type AttendanceRow = {
    rawDate: string;
    isoDate: string;
    day: string;
    members: Record<string, string>;
};

export type MonthlyAttendance = Record<string, AttendanceRow[]>;

/**
 * Groups attendance rows into monthly buckets.
 *
 * @param rows - Array of attendance rows from Google Sheet
 * @returns Object grouped by "Month Year"
 */
export function groupAttendanceByMonth(
  rows: Record<string, string>[]
): MonthlyAttendance {
    const result: MonthlyAttendance = {};

    const dateColumn = SHEET_REGISTRY[ATTENDANCE].headers.Dates_Names
    for (const row of rows) {
        const rawDate = row[dateColumn];
        if (!rawDate) continue;

        // Parse "03-January-26"
        const parsed = DateTime.fromFormat(rawDate, "dd-MMMM-yy", {
        zone: "Europe/London"
        });

        if (!parsed.isValid) continue;

        const monthKey = parsed.toFormat("LLLL yyyy"); // e.g. "January 2026"

        // Remove the date column and keep members only
        const { [dateColumn]: _, ...members } = row;

        const formattedRow: AttendanceRow = {
        rawDate,
        isoDate: parsed.toISODate()!,
        day: parsed.toFormat("cccc"),
        members
        };

        if (!result[monthKey]) {
        result[monthKey] = [];
        }

        result[monthKey].push(formattedRow);
    }

    return result;
}


/**
 * Converts grouped monthly attendance into
 * Record<string, string>[] so it fits normalizeRow().
 */
export function attendanceMonthlyToRecords(
  grouped: MonthlyAttendance
): Record<string, string>[] {
    return Object.entries(grouped).map(([month, rows]) => {
        const record: Record<string, string> = {};

        record["description"] = `This is the attendance or availability data for each member of the choir for the month of ${month}, A: Available, UA: Unavailable, U: Unsure.`

        // Sort chronologically (important for deterministic hashing)
        const sortedRows = [...rows].sort((a, b) =>
        a.isoDate.localeCompare(b.isoDate)
        );

        const servicesSummary = sortedRows
        .map((row) => {
            const membersSummary = Object.entries(row.members)
            .map(([member, status]) => `${member}: ${status || "-"}`)
            .join(", ");

            return `${row.rawDate} (${row.day}) → ${membersSummary}`;
        })
        .join("\n");

        record["attendance"] = servicesSummary;

        return record;
    });
}
