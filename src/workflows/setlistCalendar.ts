import { DateTime } from "luxon";
import { clockService } from "../shared/clockService.js";

const ZONE = "Europe/London";

export function getLastFridayOfMonth(month: DateTime): DateTime {
  let cursor = month.setZone(ZONE).endOf("month").startOf("day");
  while (cursor.weekday !== 5) {
    cursor = cursor.minus({ days: 1 });
  }
  return cursor;
}

export function isLastFridayWeek(date = clockService.now(ZONE)): boolean {
  const normalized = date.setZone(ZONE).startOf("day");
  const weekStart = normalized.startOf("week");
  const weekEnd = weekStart.plus({ days: 6 }).endOf("day");
  const monthCandidates = [weekStart, weekEnd];

  return monthCandidates.some((candidate) => {
    const lastFriday = getLastFridayOfMonth(candidate);
    return lastFriday >= weekStart && lastFriday <= weekEnd;
  });
}

export function getSetlistExpiryForServiceWeek(serviceWeekStart: string): string {
  const weekStart = DateTime.fromISO(serviceWeekStart, { zone: ZONE }).startOf("day");
  if (weekStart.isValid && isLastFridayWeek(weekStart)) {
    return weekStart.plus({ days: 6 }).endOf("day").toISO()!;
  }
  return clockService.now(ZONE).plus({ weeks: 1 }).toISO()!;
}

export function getServiceWeekForSetlistSubmission(now = clockService.now(ZONE)): string {
  return now.startOf("week").toISODate()!;
}

export function randomReminderTime(): string {
  const startMinutes = 9 * 60;
  const endMinutes = 16 * 60;
  const minutes = startMinutes + Math.floor(Math.random() * (endMinutes - startMinutes + 1));
  return minutesToTime(minutes);
}

export function randomThursdayOrFridayDateTime(weekStart: string): DateTime {
  const monday = DateTime.fromISO(weekStart, { zone: ZONE }).startOf("day");
  const dayOffset = Math.random() < 0.5 ? 3 : 4;
  const [hour, minute] = randomReminderTime().split(":").map(Number);
  return monday.plus({ days: dayOffset }).set({ hour, minute });
}

function minutesToTime(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
