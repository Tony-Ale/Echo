import { DateTime } from "luxon";
import type { RecurringSchedule } from "../types.js";

const WEEKDAYS: Readonly<Record<string, number>> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

export type RecurringScheduleParseResult =
  | { ok: true; schedule: RecurringSchedule }
  | { ok: false; reason: string };

/**
 * Parses only explicit recurring calendar language. The model may identify the
 * raw phrase, but recurrence and timestamps remain deterministic backend data.
 */
export function parseRecurringSchedule(
  rawPhrase: string,
  timezone = "Europe/London",
): RecurringScheduleParseResult {
  const phrase = rawPhrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase) return { ok: false, reason: "I could not find a recurring schedule." };

  const time = parseTime(phrase);
  if (!time) return { ok: false, reason: "Please include the time for each run, such as `at 6pm`." };

  if (/\b(?:every day|daily)\b/.test(phrase)) {
    return { ok: true, schedule: { frequency: "daily", time, timezone } };
  }

  if (/\b(?:every week|each week|weekly|every monday|every tuesday|every wednesday|every thursday|every friday|every saturday|every sunday)\b/.test(phrase)) {
    const weekdayName = Object.keys(WEEKDAYS).find((day) => new RegExp(`\\b${day}\\b`).test(phrase));
    if (!weekdayName) {
      return { ok: false, reason: "Please include which weekday the task should run." };
    }
    return {
      ok: true,
      schedule: { frequency: "weekly", weekday: WEEKDAYS[weekdayName], time, timezone },
    };
  }

  if (/\b(?:every month|each month|monthly)\b/.test(phrase)) {
    const dayMatch = phrase.match(/\bon\s+(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/);
    const dayOfMonth = dayMatch ? Number(dayMatch[1]) : Number.NaN;
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) {
      return { ok: false, reason: "Please include which day of each month the task should run." };
    }
    return {
      ok: true,
      schedule: { frequency: "monthly", dayOfMonth, time, timezone },
    };
  }

  return { ok: false, reason: "Please use an explicit daily, weekly, or monthly recurring schedule." };
}

export function nextRecurringRun(schedule: RecurringSchedule, after: DateTime): DateTime {
  const zoned = after.setZone(schedule.timezone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const withTime = (date: DateTime) => date.set({ hour, minute, second: 0, millisecond: 0 });

  if (schedule.frequency === "daily") {
    const today = withTime(zoned);
    return today > zoned ? today : today.plus({ days: 1 });
  }

  if (schedule.frequency === "weekly") {
    let candidate = withTime(zoned.startOf("week").plus({ days: schedule.weekday - 1 }));
    if (candidate <= zoned) candidate = candidate.plus({ weeks: 1 });
    return candidate;
  }

  let candidate = withTime(clampDayOfMonth(zoned, schedule.dayOfMonth));
  if (candidate <= zoned) candidate = withTime(clampDayOfMonth(zoned.plus({ months: 1 }), schedule.dayOfMonth));
  return candidate;
}

export function describeRecurringSchedule(schedule: RecurringSchedule): string {
  const time = DateTime.fromFormat(schedule.time, "HH:mm", { zone: schedule.timezone }).toFormat("h:mm a");
  if (schedule.frequency === "daily") return `every day at ${time}`;
  if (schedule.frequency === "weekly") {
    const weekday = Object.entries(WEEKDAYS).find(([, value]) => value === schedule.weekday)?.[0] ?? "week";
    return `every ${capitalize(weekday)} at ${time}`;
  }
  return `day ${schedule.dayOfMonth} of every month at ${time}`;
}

function parseTime(phrase: string): string | null {
  const match = phrase.match(/\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? "0");
  const meridiem = match[3];
  if (minute > 59 || hour < 0) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "am" && hour === 12) hour = 0;
    if (meridiem === "pm" && hour !== 12) hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clampDayOfMonth(base: DateTime, day: number): DateTime {
  return base.startOf("month").set({ day: Math.min(day, base.endOf("month").day) });
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
