import type { VesloAutomationSchedule } from "../types";

export const scheduledDayOptions = [
  { id: "mo", labelKey: "scheduled.day_mo", cron: "1", weekday: 1 },
  { id: "tu", labelKey: "scheduled.day_tu", cron: "2", weekday: 2 },
  { id: "we", labelKey: "scheduled.day_we", cron: "3", weekday: 3 },
  { id: "th", labelKey: "scheduled.day_th", cron: "4", weekday: 4 },
  { id: "fr", labelKey: "scheduled.day_fr", cron: "5", weekday: 5 },
  { id: "sa", labelKey: "scheduled.day_sa", cron: "6", weekday: 6 },
  { id: "su", labelKey: "scheduled.day_su", cron: "0", weekday: 7 },
];

export type ScheduledAutomationScheduleMode = "daily" | "interval" | "oneShot";

export type ScheduledAutomationScheduleOptions = {
  timeValue: string;
  days: string[];
  intervalHours: number;
  runAtDate: string;
  runAtTime: string;
  quickMinutes: number;
};

export const resolveLocalScheduleTimezone = () => {
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
    return timezone || undefined;
  } catch {
    return undefined;
  }
};

const pad2 = (value: number) => String(value).padStart(2, "0");

export const localDateTimeInputPartsFromInstant = (value: string) => {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return { date: "", time: "" };
  return {
    date: `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`,
    time: `${pad2(parsed.getHours())}:${pad2(parsed.getMinutes())}`,
  };
};

export const buildSchedule = (
  mode: ScheduledAutomationScheduleMode,
  options: ScheduledAutomationScheduleOptions,
  timezone?: string,
): VesloAutomationSchedule | null => {
  if (mode === "interval") {
    const hours = Math.max(1, Math.round(options.intervalHours));
    return { kind: "interval", seconds: hours * 60 * 60 };
  }

  if (mode === "oneShot") {
    if (options.quickMinutes > 0) {
      return { kind: "oneShot", runAt: new Date(Date.now() + options.quickMinutes * 60 * 1000).toISOString() };
    }
    if (!options.runAtDate || !options.runAtTime) return null;
    const parsed = new Date(`${options.runAtDate}T${options.runAtTime}`);
    if (Number.isNaN(parsed.getTime())) return null;
    return { kind: "oneShot", runAt: parsed.toISOString() };
  }

  const time = parseTimeValue(options.timeValue);
  if (!time || !options.days.length) return null;
  if (options.days.length === scheduledDayOptions.length) {
    return withScheduleTimezone({ kind: "daily", hour: time.hour, minute: time.minute }, timezone);
  }
  if (options.days.length === 1) {
    const day = scheduledDayOptions.find((item) => item.id === options.days[0]);
    return day
      ? withScheduleTimezone({ kind: "weekly", weekday: day.weekday, hour: time.hour, minute: time.minute }, timezone)
      : null;
  }
  const cron = buildCronFromDaily(options.timeValue, options.days);
  return cron ? withScheduleTimezone({ kind: "cron", expression: cron }, timezone) : null;
};

const parseTimeValue = (value: string) => {
  const [hourRaw, minuteRaw] = value.split(":");
  const hour = Number.parseInt(hourRaw ?? "", 10);
  const minute = Number.parseInt(minuteRaw ?? "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour: Math.min(23, Math.max(0, hour)), minute: Math.min(59, Math.max(0, minute)) };
};

const buildCronFromDaily = (timeValue: string, days: string[]) => {
  const time = parseTimeValue(timeValue);
  if (!time || !days.length) return "";
  if (days.length === scheduledDayOptions.length) return `${time.minute} ${time.hour} * * *`;
  const daySpec = scheduledDayOptions
    .filter((day) => days.includes(day.id))
    .map((day) => day.cron)
    .join(",");
  return daySpec ? `${time.minute} ${time.hour} * * ${daySpec}` : "";
};

const withScheduleTimezone = <T extends VesloAutomationSchedule>(schedule: T, timezone?: string): T => {
  const normalized = timezone?.trim();
  if (!normalized || schedule.kind === "interval" || schedule.kind === "oneShot") return schedule;
  return { ...schedule, timezone: normalized } as T;
};
