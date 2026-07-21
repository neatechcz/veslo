import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function auditFiles(): string[] {
  const primary = process.env.VESLO_SKILL_AUDIT_LOG_FILE?.trim() ||
    process.env.VESLO_SEND_WORKFLOW_TRACE_SERVER_FILE?.trim() ||
    process.env.VESLO_SEND_WORKFLOW_TRACE_FILE?.trim() ||
    process.env.VESLO_RUNTIME_TRACE_FILE?.trim();
  const mirror = process.env.VESLO_SEND_WORKFLOW_TRACE_SERVER_MIRROR_FILE?.trim() ||
    process.env.VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE?.trim();
  return Array.from(new Set([primary, mirror].filter((value): value is string => Boolean(value))));
}

const PATH_KEYS = new Set(["path", "sourcePath", "workspaceRoot", "stagingRoot", "skillDir", "rootDir"]);

function redactPath(value: string): string {
  if (!isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith("\\\\")) return value;
  const tail = value.replace(/\\/g, "/").split("/").filter(Boolean).slice(-4).join("/");
  return `<local>/${tail || basename(value)}`;
}

function sanitize(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key && PATH_KEYS.has(key) ? redactPath(value) : value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitize(childValue, childKey)]));
}

export function recordSkillAudit(event: string, payload: Record<string, unknown> = {}): void {
  const files = auditFiles();
  if (files.length === 0 && !truthy(process.env.VESLO_SKILL_AUDIT_LOG)) return;
  const entry = {
    schema: "veslo-skill-audit/v1",
    source: "server",
    at: new Date().toISOString(),
    event,
    processPid: process.pid,
    ...(sanitize(payload) as Record<string, unknown>),
  };
  for (const file of files) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // Diagnostics must never affect runtime behavior.
    }
    }
  if (truthy(process.env.VESLO_SKILL_AUDIT_CONSOLE)) {
    try { console.log(`[veslo:skill-audit] ${event} ${JSON.stringify(entry)}`); } catch {}
  }
}
