import { DateTime, type DurationLike } from "luxon";
import { logData } from "../logger/execLogger.js";

const DEFAULT_ZONE = "Europe/London";
const CLOCK_FORMAT = "yyyy-LL-dd HH:mm";

type ClockChangeListener = () => void;

/**
 * Central application clock.
 *
 * The rest of the app should read "current time" through this service instead of
 * calling DateTime.now(), Date.now(), or new Date() for live timestamps. When mock
 * time is enabled, every caller receives the same deterministic time.
 */
class ClockService {
  private mockNow: DateTime | null = null;
  private readonly listeners = new Set<ClockChangeListener>();

  public now(timezone = DEFAULT_ZONE): DateTime {
    const current = this.mockNow ?? DateTime.now().setZone(DEFAULT_ZONE);
    return current.setZone(timezone);
  }

  /** Returns wall-clock time even when application mock time is enabled. */
  public systemNow(timezone = DEFAULT_ZONE): DateTime {
    return DateTime.now().setZone(timezone);
  }

  public parseDateTime(dateTime: string, timezone = DEFAULT_ZONE): DateTime {
    return this.parseClockDateTime(dateTime, timezone);
  }

  /**
   * Clock-backed equivalent of the native Date constructor.
   *
   * - clockService.Date() returns the current application time as a JS Date.
   * - clockService.Date(value) mirrors new Date(value).
   * - clockService.Date(year, monthIndex, day...) mirrors new Date(year, monthIndex, day...).
   *
   * Use this for code that still needs JS Date objects for library compatibility.
   */
  public Date(): Date;
  public Date(value: string | number | Date): Date;
  public Date(year: number, monthIndex: number, day?: number, hours?: number, minutes?: number, seconds?: number, milliseconds?: number): Date;
  public Date(...args: [] | [string | number | Date] | [number, number, number?, number?, number?, number?, number?]): Date {
    if (args.length === 0) {
      return this.now(DEFAULT_ZONE).toJSDate();
    }

    if (args.length === 1) {
      const [value] = args;
      return new Date(value);
    }

    const [year, monthIndex, day = 1, hours = 0, minutes = 0, seconds = 0, milliseconds = 0] = args;
    return new Date(year, monthIndex, day, hours, minutes, seconds, milliseconds);
  }

  public setMockTime(dateTime: string, timezone = DEFAULT_ZONE): void {
    const parsed = this.parseClockDateTime(dateTime, timezone);
    this.mockNow = parsed;
    logData({ now: parsed.toISO(), timezone }, "Clock mock time set");
    this.notifyChange();
  }

  public advanceTime(options: DurationLike): void {
    const base = this.mockNow ?? this.now(DEFAULT_ZONE);
    this.mockNow = base.plus(options);
    logData({ now: this.mockNow.toISO(), options }, "Clock mock time advanced");
    this.notifyChange();
  }

  public clearMockTime(): void {
    this.mockNow = null;
    logData("system time", "Clock mock time cleared");
    this.notifyChange();
  }

  public isMockTimeEnabled(): boolean {
    return Boolean(this.mockNow);
  }

  public onChange(listener: ClockChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private parseClockDateTime(dateTime: string, timezone: string): DateTime {
    const parsed = DateTime.fromFormat(dateTime, CLOCK_FORMAT, { zone: timezone });
    if (parsed.isValid) return parsed;

    const iso = DateTime.fromISO(dateTime, { zone: timezone });
    if (iso.isValid) return iso;

    throw new Error(`Invalid mock time. Use ${CLOCK_FORMAT} or ISO datetime.`);
  }

  private notifyChange(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const clockService = new ClockService();
