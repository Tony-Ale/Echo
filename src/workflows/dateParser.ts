import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { logData } from "../logger/execLogger.js";
import { clockService } from "../shared/clockService.js";

export interface ParsedReminderDate {
  iso: string;
  displayDate: string;
  displayTime: string;
  timezone: string;
}

export interface DateParseResult {
  ok: boolean;
  value?: ParsedReminderDate;
  reason?: string;
  failure?: "missing" | "unrecognized" | "ambiguous" | "invalid" | "past";
}

const DEFAULT_TIME = { hour: 9, minute: 0 };
const DEFAULT_ZONE = "Europe/London";

export function parseReminderDatePhrase(
  rawDatePhrase: string | undefined,
  options: { now?: DateTime; timezone?: string } = {}
): DateParseResult {
  const phrase = rawDatePhrase?.trim();
  if (!phrase) {
    const result: DateParseResult = { ok: false, failure: "missing", reason: "Please include when I should remind you." };
    logData({ rawDatePhrase, result }, "Reminder date parsing rejected empty phrase");
    return result;
  }

  const timezone = options.timezone ?? DEFAULT_ZONE;
  const now = (options.now ?? clockService.now(timezone)).setZone(timezone);
  if (isExplicitlyPastRelativePhrase(phrase)) {
    const result: DateParseResult = {
      ok: false,
      failure: "past",
      reason: "That reminder time is in the past. Please choose a future time.",
    };
    logData({ phrase, now: now.toISO(), result }, "Reminder date parsing rejected explicit past direction");
    return result;
  }
  const results = chrono.en.GB.parse(phrase, now.toJSDate(), { forwardDate: true });

  if (results.length === 0) {
    const result: DateParseResult = { ok: false, failure: "unrecognized", reason: `I could not understand "${phrase}" as a future date.` };
    logData({ phrase, result }, "Reminder date parsing found no chrono results");
    return result;
  }

  if (results.length > 1) {
    const result: DateParseResult = { ok: false, failure: "ambiguous", reason: "That date sounds ambiguous. Please give me one clear date or time." };
    logData({ phrase, resultCount: results.length, result }, "Reminder date parsing rejected ambiguous phrase");
    return result;
  }

  const result = results[0];
  let resolved = DateTime.fromJSDate(result.start.date(), { zone: timezone });

  const hasHour = result.start.isCertain("hour");
  if (!hasHour) {
    resolved = resolved.set(DEFAULT_TIME);
  }

  if (!resolved.isValid) {
    const result: DateParseResult = { ok: false, failure: "invalid", reason: "That date is invalid. Please try a different date." };
    logData({ phrase, result }, "Reminder date parsing rejected invalid date");
    return result;
  }

  if (resolved <= now) {
    const result: DateParseResult = { ok: false, failure: "past", reason: "That reminder time is in the past. Please choose a future time." };
    logData({ phrase, resolved: resolved.toISO(), now: now.toISO(), result }, "Reminder date parsing rejected past date");
    return result;
  }

  const parsed = {
    ok: true,
    value: {
      iso: resolved.toISO()!,
      displayDate: resolved.toFormat("dd/LL/yyyy"),
      displayTime: resolved.toFormat("h:mm a"),
      timezone,
    },
  };
  logData({ phrase, parsed }, "Reminder date phrase parsed");
  return parsed;
}

/** Explicit past direction is authoritative and must never be shifted forward. */
function isExplicitlyPastRelativePhrase(phrase: string): boolean {
  return /\b(?:yesterday|last\s+(?:night|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d+\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago)\b/i.test(phrase);
}

/**
 * Resolves an edited temporal phrase while preserving the reminder's existing
 * calendar date when the user changes only its time (for example, "7pm").
 */
export function normalizeReminderDateEditPhrase(
  rawDatePhrase: string,
  existingScheduledFor: string,
  options: { now?: DateTime; timezone?: string } = {},
): string {
  const timezone = options.timezone ?? DEFAULT_ZONE;
  const now = (options.now ?? clockService.now(timezone)).setZone(timezone);
  const results = chrono.en.GB.parse(rawDatePhrase, now.toJSDate(), { forwardDate: true });
  const parsed = results.length === 1 ? results[0] : undefined;
  const isTimeOnly = parsed?.start.isCertain("hour")
    && !parsed.start.isCertain("day")
    && !parsed.start.isCertain("month")
    && !parsed.start.isCertain("year");

  if (!isTimeOnly) return rawDatePhrase;

  const existingDate = DateTime.fromISO(existingScheduledFor, { zone: timezone });
  if (!existingDate.isValid) return rawDatePhrase;

  return `${existingDate.toFormat("dd/LL/yyyy")} ${rawDatePhrase}`;
}

export function formatReminderDate(iso: string, timezone = DEFAULT_ZONE): ParsedReminderDate {
  const date = DateTime.fromISO(iso, { zone: timezone });
  return {
    iso,
    displayDate: date.toFormat("dd/LL/yyyy"),
    displayTime: date.toFormat("h:mm a"),
    timezone,
  };
}

export function getCurrentWeekStart(now: DateTime = clockService.now(DEFAULT_ZONE)): string {
  return now.startOf("week").toISODate()!;
}
