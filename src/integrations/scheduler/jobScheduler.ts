import cron, { ScheduledTask } from "node-cron";
import { DateTime } from "luxon";
import { logData } from "../../logger/execLogger.js";
import { clockService } from "../../shared/clockService.js";

// The reason i have not migrated the scheduler to use the custom scheduler strategy
// is that i have not confirmed that my clockservice in conjunction with my custom scheduler is bug free and reliable
type TimerHandle = ReturnType<typeof setTimeout>;
type ScheduledJobHandle = Pick<ScheduledTask, "stop">;

// Node clamps larger setTimeout values to 1 ms. Long one-time jobs (especially
// monthly agent tasks) therefore wait in chunks and re-check the application
// clock instead of firing weeks early.
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export type SchedulerStrategy = "native" | "custom";

export type ScheduledJobCategory =
    | "rota_reminder"
    | "user_reminder"
    | "scheduled_agent_task"
    | "setlist_nudge"
    | "setlist_broadcast"
    | "cleanup"
    | "other";

export interface ScheduledJobInfo {
    jobId: string;
    category: ScheduledJobCategory;
    timezone: string;
    runOnce: boolean;
    schedulerStrategy: SchedulerStrategy;
    scheduledFor?: string;
    cronExpression?: string;
    nextRunAt?: string;
}

export interface ScheduleJobOptions {
    jobId: string;
    dateTime?: string; // "2026-03-15 18:30" for run once
    dayOfWeek?: number; // Weekly recurrence, 0 = Sunday
    dayOfMonth?: number; // Monthly recurrence
    time?: string; // "16:00"
    runOnce?: boolean;
    timezone?: string;
    category?: ScheduledJobCategory;
    schedulerStrategy?: SchedulerStrategy;
    action: () => Promise<void>;
}

const scheduledJobs: Map<string, ScheduledJobHandle> = new Map();
const scheduledJobInfo: Map<string, ScheduledJobInfo> = new Map();
const scheduledJobDefinitions: Map<string, ScheduleJobOptions> = new Map();
const activeExecutions = new Set<Promise<void>>();

let rebuilding = false;
let scheduledMessagesDisabled = false;

clockService.onChange(() => {
    rebuildScheduledJobs();
});

export function scheduleJob(options: ScheduleJobOptions): void {
    if (scheduledMessagesDisabled) {
        logData(options.jobId, "Job not scheduled because scheduled messages are disabled");
        return;
    }

    scheduleJobInternal(options, true);
}

function scheduleJobInternal(options: ScheduleJobOptions, persistDefinition: boolean): void {
    const normalized = normalizeOptions(options);

    if (scheduledJobs.has(normalized.jobId)) {
        logData(normalized.jobId, "Job already scheduled");
        return;
    }

    if (persistDefinition) {
        // Keep the caller's original options so a job that defaulted to native can
        // return to native after mock time is cleared. Normalization is applied at
        // scheduling time because the active clock mode may change.
        scheduledJobDefinitions.set(normalized.jobId, { ...options });
    }

    if (normalized.runOnce) {
        scheduleOneTimeJob(normalized);
        return;
    }

    if ((normalized.dayOfWeek === undefined && normalized.dayOfMonth === undefined) || !normalized.time) {
        throw new Error("Recurring jobs require dayOfWeek or dayOfMonth and time");
    }

    if (normalized.schedulerStrategy === "custom") {
        scheduleCustomRecurringJob(normalized);
        return;
    }

    scheduleNativeRecurringJob(normalized);
}

function scheduleOneTimeJob(options: RequiredBaseOptions): void {
    if (!options.dateTime) {
        throw new Error("runOnce requires dateTime (e.g. '2026-03-15 18:30')");
    }

    const target = parseDateTime(options.dateTime, options.timezone);
    if (!target.isValid) {
        logData(options.jobId, "Invalid dateTime format. Use yyyy-MM-dd HH:mm");
        return;
    }

    const now = clockService.now(options.timezone);
    if (target <= now) {
        if (options.schedulerStrategy === "custom") {
            void executeOneTimeJob(options);
        } else {
            logData(options.jobId, "Scheduled time already passed");
            scheduledJobDefinitions.delete(options.jobId);
        }
        return;
    }

    const delay = target.toMillis() - now.toMillis();
    scheduleOneTimeTimer(options, target);
    scheduledJobInfo.set(options.jobId, {
        jobId: options.jobId,
        category: options.category,
        timezone: options.timezone,
        runOnce: true,
        schedulerStrategy: options.schedulerStrategy,
        scheduledFor: target.toISO() ?? undefined,
        nextRunAt: target.toISO() ?? undefined,
    });

    logData({ jobId: options.jobId, runAt: target.toISO(), delay, strategy: options.schedulerStrategy }, "One-time job scheduled");
}

function scheduleOneTimeTimer(options: RequiredBaseOptions, target: DateTime): void {
    const remaining = target.toMillis() - clockService.now(options.timezone).toMillis();
    if (remaining <= 0) {
        void executeOneTimeJob(options);
        return;
    }

    const timeout = setTimeout(() => {
        scheduleOneTimeTimer(options, target);
    }, Math.min(remaining, MAX_TIMER_DELAY_MS));
    setTimerHandle(options.jobId, timeout);
}

async function executeOneTimeJob(options: RequiredBaseOptions): Promise<void> {
    return trackExecution(async () => {
    try {
        await options.action();
        logData(options.jobId, "One-time job executed");
    } catch (error) {
        logData(error, "One-time job failed");
    } finally {
        scheduledJobs.delete(options.jobId);
        scheduledJobInfo.delete(options.jobId);
        scheduledJobDefinitions.delete(options.jobId);
    }
    });
}

function scheduleNativeRecurringJob(options: RequiredBaseOptions): void {
    const cronExpression = buildCronExpression(options);
    const job = cron.schedule(
        cronExpression,
        async () => {
            await trackExecution(() => executeRecurringAction(options));
        },
        { timezone: options.timezone }
    );

    scheduledJobs.set(options.jobId, job);
    scheduledJobInfo.set(options.jobId, {
        jobId: options.jobId,
        category: options.category,
        timezone: options.timezone,
        runOnce: false,
        schedulerStrategy: "native",
        cronExpression,
        nextRunAt: getNextRecurringRun(options)?.toISO() ?? undefined,
    });

    logData({ jobId: options.jobId, cronExpression, timezone: options.timezone }, "Native recurring job scheduled");
}

function scheduleCustomRecurringJob(options: RequiredBaseOptions): void {
    const nextRun = getNextRecurringRun(options);
    if (!nextRun) {
        logData(options.jobId, "Custom recurring job could not resolve next run");
        return;
    }

    const delay = Math.max(0, nextRun.toMillis() - clockService.now(options.timezone).toMillis());
    const timeout = setTimeout(() => {
        void trackExecution(async () => {
            await executeRecurringAction(options);
            scheduledJobs.delete(options.jobId);
            if (!scheduledMessagesDisabled && scheduledJobDefinitions.has(options.jobId)) {
                scheduleCustomRecurringJob(options);
            }
        });
    }, delay);

    setTimerHandle(options.jobId, timeout);
    scheduledJobInfo.set(options.jobId, {
        jobId: options.jobId,
        category: options.category,
        timezone: options.timezone,
        runOnce: false,
        schedulerStrategy: "custom",
        cronExpression: buildCronExpression(options),
        nextRunAt: nextRun.toISO() ?? undefined,
    });

    logData({ jobId: options.jobId, nextRunAt: nextRun.toISO(), delay }, "Custom recurring job scheduled");
}

async function executeRecurringAction(options: RequiredBaseOptions): Promise<void> {
    try {
        await options.action();
        logData(options.jobId, "Recurring job executed");
    } catch (error) {
        logData({ error, jobId: options.jobId }, "Recurring job failed");
    } finally {
        refreshRecurringJobInfo(options);
    }
}

function refreshRecurringJobInfo(options: RequiredBaseOptions): void {
    const existing = scheduledJobInfo.get(options.jobId);
    if (!existing || existing.runOnce) return;

    scheduledJobInfo.set(options.jobId, {
        ...existing,
        nextRunAt: getNextRecurringRun(options)?.toISO() ?? undefined,
    });
}

function rebuildScheduledJobs(): void {
    if (rebuilding) return;
    rebuilding = true;
    try {
        const definitions = [...scheduledJobDefinitions.values()];
        const overdueRecurring = definitions.filter((definition) => {
            const info = scheduledJobInfo.get(definition.jobId);
            if (!info || info.runOnce || !info.nextRunAt) return false;
            const nextRun = DateTime.fromISO(info.nextRunAt, { zone: info.timezone });
            return nextRun.isValid && nextRun <= clockService.now(info.timezone);
        });

        for (const jobId of scheduledJobs.keys()) {
            stopJob(jobId);
        }
        scheduledJobs.clear();
        scheduledJobInfo.clear();

        for (const definition of definitions) {
            scheduleJobInternal(definition, false);
        }

        // If mock time jumped past a recurring timer, run it once and then leave
        // the freshly rebuilt schedule pointing at the next future occurrence.
        for (const definition of overdueRecurring) {
            void trackExecution(() => executeRecurringAction(normalizeOptions(definition)));
        }

        logData({ count: definitions.length, mockTime: clockService.isMockTimeEnabled() }, "Scheduled jobs rebuilt after clock change");
    } finally {
        rebuilding = false;
    }
}

export function cancelJob(jobId: string): boolean {
    const job = scheduledJobs.get(jobId);
    if (!job) return false;
    stopJob(jobId);
    scheduledJobs.delete(jobId);
    scheduledJobInfo.delete(jobId);
    scheduledJobDefinitions.delete(jobId);
    logData(jobId, "Job cancelled");
    return true;
}

export function disableScheduledMessages(): void {
    scheduledMessagesDisabled = true;
    for (const jobId of scheduledJobs.keys()) {
        stopJob(jobId);
    }
    scheduledJobs.clear();
    scheduledJobInfo.clear();
    scheduledJobDefinitions.clear();
    logData(null, "Scheduled messages disabled");
}

/** Stops timer handles without discarding their definitions during a clock transition. */
export function pauseScheduledJobs(): void {
    for (const jobId of scheduledJobs.keys()) stopJob(jobId);
    scheduledJobs.clear();
}

/** Waits until every scheduler action that has already started has completed. */
export async function waitForScheduledJobsToSettle(): Promise<void> {
    while (activeExecutions.size > 0) {
        await Promise.allSettled([...activeExecutions]);
    }
}

export function enableScheduledMessages(): void {
    scheduledMessagesDisabled = false;
    logData(null, "Scheduled messages enabled");
}

export function areScheduledMessagesDisabled(): boolean {
    return scheduledMessagesDisabled;
}

export function getScheduledJobs(): ScheduledJobInfo[] {
    return [...scheduledJobInfo.values()];
}

type RequiredBaseOptions = ScheduleJobOptions & {
    runOnce: boolean;
    timezone: string;
    category: ScheduledJobCategory;
    schedulerStrategy: SchedulerStrategy;
};

function normalizeOptions(options: ScheduleJobOptions): RequiredBaseOptions {
    return {
        ...options,
        runOnce: options.runOnce ?? false,
        timezone: options.timezone ?? "Europe/London",
        category: options.category ?? "other",
        // Mock time and real cron do not mix. When mock time is active, all jobs
        // use the custom timeout strategy so delays are derived from ClockService.
        schedulerStrategy: clockService.isMockTimeEnabled() ? "custom" : options.schedulerStrategy ?? "native",
    };
}

function parseDateTime(dateTime: string, timezone: string): DateTime {
    return DateTime.fromFormat(dateTime, "yyyy-MM-dd HH:mm", { zone: timezone });
}

function buildCronExpression(options: RequiredBaseOptions): string {
    const [hour, minute] = options.time!.split(":").map(Number);
    return options.dayOfMonth === undefined
        ? `${minute} ${hour} * * ${options.dayOfWeek}`
        : `${minute} ${hour} ${options.dayOfMonth} * *`;
}

function getNextRecurringRun(options: RequiredBaseOptions): DateTime | null {
    if (!options.time) return null;
    const [hour, minute] = options.time.split(":").map(Number);
    const now = clockService.now(options.timezone);

    if (options.dayOfMonth !== undefined) {
        return getNextMonthlyRun(now, options.dayOfMonth, hour, minute);
    }

    if (options.dayOfWeek !== undefined) {
        return getNextWeeklyRun(now, options.dayOfWeek, hour, minute);
    }

    return null;
}

function getNextWeeklyRun(now: DateTime, dayOfWeek: number, hour: number, minute: number): DateTime {
    const luxonWeekday = dayOfWeek === 0 ? 7 : dayOfWeek;
    let candidate = now
        .startOf("week")
        .plus({ days: luxonWeekday - 1 })
        .set({ hour, minute, second: 0, millisecond: 0 });

    if (candidate <= now) {
        candidate = candidate.plus({ weeks: 1 });
    }

    return candidate;
}

function getNextMonthlyRun(now: DateTime, dayOfMonth: number, hour: number, minute: number): DateTime {
    let candidate = clampMonthlyDate(now, dayOfMonth).set({ hour, minute, second: 0, millisecond: 0 });
    if (candidate <= now) {
        candidate = clampMonthlyDate(now.plus({ months: 1 }), dayOfMonth).set({ hour, minute, second: 0, millisecond: 0 });
    }
    return candidate;
}

function clampMonthlyDate(base: DateTime, dayOfMonth: number): DateTime {
    const lastDay = base.endOf("month").day;
    return base.startOf("month").plus({ days: Math.min(dayOfMonth, lastDay) - 1 });
}

function setTimerHandle(jobId: string, timeout: TimerHandle): void {
    scheduledJobs.set(jobId, {
        stop: () => clearTimeout(timeout),
    });
}

function stopJob(jobId: string): void {
    scheduledJobs.get(jobId)?.stop();
}

function trackExecution(action: () => Promise<void>): Promise<void> {
    let execution: Promise<void>;
    execution = action().finally(() => activeExecutions.delete(execution));
    activeExecutions.add(execution);
    return execution;
}
