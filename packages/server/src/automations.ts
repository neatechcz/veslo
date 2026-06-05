import { CronExpressionParser } from "cron-parser";

import { ApiError } from "./errors.js";

export type AutomationSchedule =
  | { kind: "oneShot"; runAt: string; timezone?: string }
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number; timezone?: string }
  | { kind: "weekly"; weekday: number; hour: number; minute: number; timezone?: string };

export type AutomationStatus = "active" | "paused" | "completed" | "failed" | "cancelled";
export type AutomationRunStatus = "queued" | "running" | "success" | "failed" | "skipped";

export type AutomationTarget = {
  preferredSessionId?: string;
  fallbackTitle?: string;
  agent?: string;
  model?: string | null;
  variant?: string | null;
};

export type VesloAutomation = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  status: AutomationStatus;
  schedule: AutomationSchedule;
  prompt: string;
  target: AutomationTarget;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string | null;
  completedAt?: string | null;
  lastRunId?: string | null;
};

export type AutomationRun = {
  id: string;
  automationId: string;
  scheduledFor: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  status: AutomationRunStatus;
  sessionId?: string | null;
  createdSession: boolean;
  error?: string | null;
};

const AUTOMATION_STATUSES: AutomationStatus[] = ["active", "paused", "completed", "failed", "cancelled"];
const AUTOMATION_RUN_STATUSES: AutomationRunStatus[] = ["queued", "running", "success", "failed", "skipped"];

export function parseAutomationSchedule(value: unknown): AutomationSchedule {
  if (!value || typeof value !== "object") {
    throw invalidPayload("schedule is required");
  }

  const schedule = value as Record<string, unknown>;
  const kind = typeof schedule.kind === "string" ? schedule.kind.trim() : "";

  if (kind === "oneShot") {
    const runAt = requireIsoInstant(schedule.runAt, "schedule.runAt");
    const timezone = normalizeScheduleTimezone(schedule.timezone);
    return timezone ? { kind, runAt, timezone } : { kind, runAt };
  }

  if (kind === "cron") {
    const expression = requireNonEmptyString(schedule.expression, "schedule.expression");
    const timezone = normalizeScheduleTimezone(schedule.timezone);
    validateCronExpression(expression, timezone, "schedule.expression");
    return timezone ? { kind, expression, timezone } : { kind, expression };
  }

  if (kind === "interval") {
    return {
      kind,
      seconds: requireInt(schedule.seconds, { min: 60, max: 7 * 24 * 60 * 60, name: "schedule.seconds" }),
    };
  }

  if (kind === "daily") {
    const hour = requireInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = requireInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    const timezone = normalizeScheduleTimezone(schedule.timezone);
    return timezone ? { kind, hour, minute, timezone } : { kind, hour, minute };
  }

  if (kind === "weekly") {
    const weekday = requireInt(schedule.weekday, { min: 1, max: 7, name: "schedule.weekday" });
    const hour = requireInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = requireInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    const timezone = normalizeScheduleTimezone(schedule.timezone);
    return timezone ? { kind, weekday, hour, minute, timezone } : { kind, weekday, hour, minute };
  }

  throw invalidPayload("schedule.kind must be oneShot, cron, interval, daily, or weekly");
}

export function parseAutomationStatus(value: unknown): AutomationStatus {
  if (typeof value === "string" && AUTOMATION_STATUSES.includes(value as AutomationStatus)) {
    return value as AutomationStatus;
  }
  throw invalidPayload("status must be active, paused, completed, failed, or cancelled");
}

export function parseAutomationRunStatus(value: unknown): AutomationRunStatus {
  if (typeof value === "string" && AUTOMATION_RUN_STATUSES.includes(value as AutomationRunStatus)) {
    return value as AutomationRunStatus;
  }
  throw invalidPayload("status must be queued, running, success, failed, or skipped");
}

export function computeNextAutomationRunAt(schedule: AutomationSchedule, fromMs: number): string | null {
  if (!Number.isFinite(fromMs)) {
    throw invalidPayload("fromMs must be finite");
  }

  if (schedule.kind === "oneShot") {
    return schedule.runAt;
  }

  if (schedule.kind === "interval") {
    const seconds = requireInt(schedule.seconds, { min: 60, max: 7 * 24 * 60 * 60, name: "schedule.seconds" });
    return new Date(fromMs + seconds * 1000).toISOString();
  }

  if (schedule.kind === "daily") {
    const hour = requireInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = requireInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    return computeCronNextRunAt(`${minute} ${hour} * * *`, schedule.timezone, fromMs);
  }

  if (schedule.kind === "weekly") {
    const weekday = requireInt(schedule.weekday, { min: 1, max: 7, name: "schedule.weekday" });
    const hour = requireInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = requireInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    const cronWeekday = weekday === 7 ? 0 : weekday;
    return computeCronNextRunAt(`${minute} ${hour} * * ${cronWeekday}`, schedule.timezone, fromMs);
  }

  return computeCronNextRunAt(schedule.expression, schedule.timezone, fromMs);
}

export function isValidIsoInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function normalizeTimezone(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw invalidPayload("schedule.timezone must be a string");
  }
  const timezone = value.trim();
  if (!timezone) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw invalidPayload("schedule.timezone must be a valid timezone");
  }
  return timezone;
}

function computeCronNextRunAt(expression: string, timezone: string | undefined, fromMs: number): string | null {
  try {
    const interval = CronExpressionParser.parse(expression, {
      currentDate: new Date(fromMs),
      ...(timezone ? { tz: timezone } : {}),
    });
    return interval.next().toDate().toISOString();
  } catch {
    throw invalidPayload("schedule.expression must be a valid cron expression");
  }
}

function validateCronExpression(expression: string, timezone: string | undefined, fieldName: string): void {
  try {
    CronExpressionParser.parse(expression, {
      currentDate: new Date(0),
      ...(timezone ? { tz: timezone } : {}),
    });
  } catch {
    throw invalidPayload(`${fieldName} must be a valid cron expression`);
  }
}

function normalizeScheduleTimezone(value: unknown): string | undefined {
  return normalizeTimezone(value);
}

function requireIsoInstant(value: unknown, name: string): string {
  if (typeof value !== "string" || !isValidIsoInstant(value)) {
    throw invalidPayload(`${name} must be a UTC ISO instant with millisecond precision`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, name: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw invalidPayload(`${name} is required`);
  }
  return trimmed;
}

function requireInt(value: unknown, options: { min: number; max: number; name: string }): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw invalidPayload(`${options.name} must be an integer`);
  }
  if (value < options.min || value > options.max) {
    throw invalidPayload(`${options.name} must be between ${options.min} and ${options.max}`);
  }
  return value;
}

function invalidPayload(message: string): ApiError {
  return new ApiError(400, "invalid_payload", message);
}
