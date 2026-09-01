import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { formatDate } from "./helpers.js";
import { clockService } from "../../../shared/clockService.js";

/**
 * Parses temporal expressions in a user query using Chrono,
 * and appends the results as structured "Temporal Context".
 *
 * @param query - The user's raw query
 * @returns The query with temporal context appended
 */
export function addTemporalContext(query: string){
    // Set reference date in UK timezone
    const ukNow = clockService.now("Europe/London").toJSDate();

    // Resolve week and weekday phrases deterministically before Chrono handles
    // the remaining UK-formatted temporal expressions.
    const relativeWeeks = [...query.matchAll(/\b(?:this|current|next|last|previous) week\b/gi)]
        .map((match) => resolveRelativeWeek(match[0]))
        .filter((value): value is NonNullable<typeof value> => value !== null);
    const weekScopedWeekdays = relativeWeeks.length === 1
        ? resolveWeekdaysWithinWeek(query, relativeWeeks[0].date_equivalent)
        : [];
    const weekdays = weekScopedWeekdays.length > 0
        ? weekScopedWeekdays
        : relativeWeeks.length === 0 ? resolveUnqualifiedWeekdays(query) : [];
    const retainedRelativeWeeks = weekScopedWeekdays.length > 0 ? [] : relativeWeeks;
    const resolvedWeekdayNames = new Set(weekdays.map((value) => value.text.toLowerCase()));
    const results = chrono.en.GB.parse(query, ukNow)
        .filter((result) => resolveRelativeWeek(result.text) === null)
        .filter((result) => ![...resolvedWeekdayNames].some((weekday) => result.text.toLowerCase().includes(weekday)));

    // If no temporal info found, return original query
    if (results.length === 0 && retainedRelativeWeeks.length === 0 && weekdays.length === 0) {
        return {query, temporalData: [], augmentedQuery: query};
    }

    // Map results to structured format
    const temporalData = [...retainedRelativeWeeks, ...weekdays, ...results.map(r => {
        const res = formatDate(r.start.date())
        const end = r.end ? formatDate(r.end.date()).formatted : undefined
        const date = res.formatted;
        const day = res.day;
        return {
            text: r.text, // the text in the query that was recognized as temporal
            date_equivalent: date,
            end_date_equivalent: end,
            day_equivalent: day,
        }
    })];

    // Append temporal context as JSON to the query
    const augmentedQuery = `${query}\n\n[Temporal Context: ${JSON.stringify(temporalData)}]`;

    return {query, temporalData, augmentedQuery}
}

const WEEKDAYS: ReadonlyMap<string, number> = new Map([
    ["monday", 1],
    ["tuesday", 2],
    ["wednesday", 3],
    ["thursday", 4],
    ["friday", 5],
    ["saturday", 6],
    ["sunday", 7],
]);

/** Bare weekday names mean their nearest occurrence today or in the future. */
function resolveUnqualifiedWeekdays(query: string) {
    const now = clockService.now("Europe/London").startOf("day");
    return unqualifiedWeekdayMatches(query)
        .map((match) => {
            const weekday = WEEKDAYS.get(match[0].toLowerCase());
            if (!weekday) throw new Error(`Unsupported weekday '${match[0]}'.`);
            const date = now.plus({ days: (weekday - now.weekday + 7) % 7 });
            const formatted = formatDate(date);
            return {
                text: match[0],
                date_equivalent: formatted.formatted,
                end_date_equivalent: undefined,
                day_equivalent: formatted.day,
            };
        });
}

/** Resolves named days inside an explicitly requested relative week. */
function resolveWeekdaysWithinWeek(query: string, weekStart: string) {
    const monday = DateTime.fromFormat(weekStart, "dd/LL/yyyy", { zone: "Europe/London" }).startOf("day");
    return unqualifiedWeekdayMatches(query).map((match) => {
        const weekday = WEEKDAYS.get(match[0].toLowerCase());
        if (!weekday) throw new Error(`Unsupported weekday '${match[0]}'.`);
        const date = monday.plus({ days: weekday - 1 });
        const formatted = formatDate(date);
        return {
            text: match[0],
            date_equivalent: formatted.formatted,
            end_date_equivalent: undefined,
            day_equivalent: formatted.day,
        };
    });
}

function unqualifiedWeekdayMatches(query: string): RegExpMatchArray[] {
    return [...query.matchAll(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi)]
        .filter((match) => {
            const before = query.slice(0, match.index).toLowerCase();
            const after = query.slice((match.index ?? 0) + match[0].length);
            return !/(?:last|previous|next|this|coming)\s*$/.test(before)
                && !/^\s*,?\s+\d{1,4}\b/.test(after);
        });
}

/** Chrono treats "this week" as a nearby day; retrieval needs the full UK week. */
function resolveRelativeWeek(text: string) {
    const normalized = text.trim().toLowerCase();
    const weekOffset = /^(?:this|current) week$/.test(normalized)
        ? 0
        : /^next week$/.test(normalized)
            ? 1
            : /^(?:last|previous) week$/.test(normalized)
                ? -1
                : undefined;
    if (weekOffset === undefined) return null;

    const start = clockService.now("Europe/London").startOf("week").plus({ weeks: weekOffset });
    const end = start.plus({ days: 6 });
    return {
        text,
        date_equivalent: formatDate(start).formatted,
        end_date_equivalent: formatDate(end).formatted,
        day_equivalent: formatDate(start).day,
    };
}

/**
 * Keeps temporal scope from the active request when a concise planner query
 * drops words such as "yesterday" or "this week". The planner still owns the
 * information need and source selection; retrieval owns deterministic dates.
 */
export function preserveTemporalQueryScope(plannedQuery: string, requestText?: string): string {
    const request = requestText?.trim()
    if (!request) return plannedQuery
    if (addTemporalContext(plannedQuery).temporalData.length > 0) return plannedQuery
    if (addTemporalContext(request).temporalData.length === 0) return plannedQuery
    return `${plannedQuery}\n\nCurrent request temporal scope: ${request}`
}


