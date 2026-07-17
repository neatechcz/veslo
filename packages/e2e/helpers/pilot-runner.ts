import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveLaunchTimeout,
  resolvePilotRuntimeDir,
  resolvePilotSocketPath,
  startApp,
  stopApp,
  waitForDesktopBootstrapReady,
} from './app-launcher.js';
import {
  startPackagedSmokeModelFixture,
  type PackagedSmokeModelFixture,
} from './packaged-smoke-model-fixture.js';
import {
  buildPilotCommand,
  executePilotCommand,
  pilotCommandSucceeded,
  type PilotCommandResult,
} from './pilot-command.js';
import {
  PILOT_RUNS_DIRNAME,
  createPilotRunContext,
  prunePilotRunHistory,
  type PilotRunContext,
} from './pilot-run-store.js';
import {
  redactPilotCommandArgs,
  redactPilotDiagnosticText,
  redactPilotJUnitXml,
} from './pilot-redaction.js';
import {
  buildPilotSelectionPlan,
  compilePilotSelectionPlan,
  type PilotSelectionPlan,
  type PilotSelectionSignals,
} from './pilot-scenario-plan.js';
import { buildPilotBrowserPreludeScript } from './pilot-browser-prelude.js';
import {
  startSessionQueueRuntimeFixture,
  type SessionQueueRuntimeFixture,
} from './session-queue-runtime-fixture.js';
import { createSessionRenderArtifactManifest } from './session-render-fixture.js';

export { buildPilotCommand } from './pilot-command.js';
export { redactPilotCommandArgs, redactPilotDiagnosticText } from './pilot-redaction.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEFAULT_READY_POLL_INTERVAL = 250;
const PILOT_WEBVIEW_READINESS_TIMEOUT_MS = 30_000;
const PILOT_DESKTOP_AUTH_HYDRATION_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_PILOT_SCENARIO_COMMAND_TIMEOUT_MS = 20 * 60_000;
// A cold, real Codex OAuth response can begin long after the desktop runtime is
// ready. This bounds observation of that production path; it is not a latency
// target or a substitute for the provider-start diagnostics.
export const CANONICAL_LIVE_INFERENCE_TIMEOUT_MS = 180_000;
const CANONICAL_LIVE_INFERENCE_COMMAND_TIMEOUT_MS = CANONICAL_LIVE_INFERENCE_TIMEOUT_MS + 5_000;
const DEFAULT_PILOT_SCENARIO_NAMES = ['smoke', 'navigation'] as const;
const MANAGED_AI_INFERENCE_SCENARIO_NAMES = [
  'global-unpublished-draft',
  'gpt-5-6-sol-three-message-roundtrip',
  'message-send-registry-degraded',
  'live-skills-finder-roundtrip',
  'model-stream-retry-no-progress',
  'pending-session-instance-isolation',
  'runtime-cold-start-session-handoff',
  'sidebar-session-retention',
  'startup-sidebar-existing-sessions',
  'vslo-270-stop-reload-reconnect',
  'vslo-271-windows-idle-runtime-chain-recovery',
] as const;
const PILOT_SCENARIO_SUITES = {
  'current-gate': [
    'smoke',
    'navigation',
    'admin-managed-ai-access',
    'attachment-staging',
    'composer',
    'extensions-mcp',
    'feedback-bug-report',
    'markdown-drop-guard',
    'skill-publish-dialog',
    'skills-global-inventory',
    'session-capabilities',
    'session-message-replacement',
    'skill-registry-materialization',
    'shared-workspace-skill-lock',
    'session-artifacts',
    'session-prefetch',
    'session',
    'settings-dashboard-link-tabs',
    'settings-gear-navigation',
    'sidebar-primary-actions-overflow',
    'sidebar-primary-actions-pointer-navigation',
    'typography',
    'veslo-server-startup',
    'visual-regression',
    'language-persistence',
  ],
  'live-inference': [
    'message-send-registry-degraded',
  ],
  'live-inference-lifecycle': [
    'runtime-cold-start-session-handoff',
  ],
} as const;

type RunPilotCommandOptions = {
  binary?: string;
  socket?: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  inheritStdio?: boolean;
};

type PilotFailureDiagnosticCommand = {
  name: string;
  args: string[];
  outputFile: string;
  timeoutMs?: number;
};

type ResolvePilotScenarioSelectionOptions = {
  scenario?: string[];
  suite?: string;
};

type RunPilotScenariosOptions = ResolvePilotScenarioSelectionOptions & {
  e2eRoot?: string;
  runRoot?: string;
  binary?: string;
  socket?: string;
  timeoutMs?: number;
};

type PortContentionFixture = {
  server: Server;
  previousE2ePort: string | undefined;
};

type PilotSuccessArtifactCommand = PilotFailureDiagnosticCommand;

const SESSION_RENDER_ARTIFACT_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 900 },
  { width: 1440, height: 1000 },
] as const;

type EnvironmentRestore = () => void;

type DenAuthSummary = {
  denApiBase: string | null;
  email: string | null;
  hasToken: boolean;
  source: string | null;
  token: string | null;
};

type LiveInferenceBrowserDiagnostic = {
  clickAt: number | null;
  sendStartedAt: number | null;
  serverAcceptedAt: number | null;
  firstAssistantTextAt: number | null;
  firstAssistantTextSource: "session-sse" | "visible-render" | null;
  traceId: string | null;
  sessionId: string | null;
  runId: string | null;
  modelVariant: string | null;
  runtimeRecoveryEvents: string[];
};

type LiveInferenceTraceEntry = Record<string, unknown>;

type LiveInferenceDiagnosticsInput = {
  scenario: string;
  browser: unknown;
  serverTrace: LiveInferenceTraceEntry[];
  appStderr: string;
  env: Record<string, string | undefined>;
};

export type LiveInferenceDiagnosticSummary = {
  schema: "tauri-pilot-live-inference-diagnostic/v1";
  scenario: string;
  diagnosticsComplete: boolean;
  simulatedFailureInputs: {
    managedAiGatewayFixture: boolean;
    managedAiResponseDelay: boolean;
    runActivityProbe: boolean;
  };
  runtimeShape: {
    devAutostartDisabled: boolean;
    modelVariant: string | null;
  };
  timingMs: {
    clickToSendStart: number | null;
    clickToServerAccepted: number | null;
    serverAcceptedToProviderHit: number | null;
    providerHitToUpstreamHeaders: number | null;
    upstreamHeadersToFirstAssistantText: number | null;
    providerHitToFirstAssistantText: number | null;
    clickToFirstAssistantText: number | null;
  };
  latencyDiagnosis: {
    dominantStage: 'app-submit' | 'engine-before-provider' | 'upstream-first-headers' | 'stream-to-first-text' | null;
    dominantStageMs: number | null;
  };
  provider: string | null;
  evidence: {
    providerHit: boolean;
    upstreamHeaders: boolean;
    firstAssistantText: boolean;
  };
  fallbacks: string[];
  startupDatabaseMissingCount: number;
};

export function resolvePilotBinary(env: Record<string, string | undefined> = process.env): string {
  return env.E2E_TAURI_PILOT_BIN?.trim() || 'tauri-pilot';
}

export function resolveCanonicalLiveParityRuntimePreferencesSource(
  env: Record<string, string | undefined> = process.env,
  options: {
    platform?: NodeJS.Platform;
    fileExists?: (path: string) => boolean;
  } = {},
): string {
  const explicit = env.E2E_LIVE_PARITY_RUNTIME_PREFERENCES_SOURCE?.trim();
  if (explicit) return explicit;
  if ((options.platform ?? process.platform) !== 'win32') return '';

  const appData = env.APPDATA?.trim();
  if (!appData) return '';
  const source = win32.join(
    appData,
    'com.neatech.veslo.dev',
    'runtime-preferences.json',
  );
  return (options.fileExists ?? existsSync)(source) ? source : '';
}

export function resolvePilotScenarioCommandTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.E2E_PILOT_SCENARIO_TIMEOUT_MS?.trim() ?? '';
  if (!raw) return DEFAULT_PILOT_SCENARIO_COMMAND_TIMEOUT_MS;

  const timeoutMs = Number(raw);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) {
    throw new Error(`Invalid E2E_PILOT_SCENARIO_TIMEOUT_MS: ${raw}`);
  }
  return timeoutMs;
}

export function resolveCanonicalLiveInferenceCommandTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  return Math.min(
    resolvePilotScenarioCommandTimeoutMs(env),
    CANONICAL_LIVE_INFERENCE_COMMAND_TIMEOUT_MS,
  );
}

export function sanitizePilotArtifactName(value: string): string {
  const base = basename(value.replaceAll('\\', '/')).replace(/\.toml$/i, '');
  const safe = base
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 96);
  return safe || 'scenario';
}

export function tailText(value: string, maxLength = 20_000): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, 1_000)}\n...<truncated ${value.length - maxLength} chars>...\n${value.slice(-maxLength + 1_000)}`;
}

function safePilotRunFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/timed?\s*out/i.test(raw)) return 'pilot-command-timeout';
  if (/did not become ready/i.test(raw)) return 'pilot-not-ready';
  if (/exited with\s+\d+/i.test(raw)) return 'pilot-command-failed';
  if (/ECONNREFUSED|connection refused|os error 10060/i.test(raw)) return 'workspace-activation-unavailable';
  return 'pilot-run-failed';
}

function pilotRunLaunchDiagnostics(
  runContext: PilotRunContext,
  launchNumber: number,
): {
  traceDir: string;
  appLogDir: string;
  runId: string;
  launchId: string;
} {
  return {
    traceDir: runContext.traceDir,
    appLogDir: runContext.appLogDir,
    runId: runContext.runId,
    launchId: `launch-${String(launchNumber).padStart(2, '0')}`,
  };
}

function selectionPlanHasFixture(
  plan: PilotSelectionPlan,
  fixture: PilotSelectionPlan['fixtures'][number],
): boolean {
  return plan.fixtures.includes(fixture);
}

function selectionPlanHasEnvironmentMutation(
  plan: PilotSelectionPlan,
  key: string,
  operation?: PilotSelectionPlan['environment'][number]['operation'],
): boolean {
  return plan.environment.some((mutation) => mutation.key === key && (!operation || mutation.operation === operation));
}

function applySetIfEmptySelectionEnvironment(
  plan: PilotSelectionPlan,
  targetEnv: NodeJS.ProcessEnv = process.env,
): void {
  for (const mutation of plan.environment) {
    if (mutation.operation !== 'set-if-empty' || !mutation.value) continue;
    targetEnv[mutation.key] ||= mutation.value;
  }
}

function assertSelectionPlanMatchesLegacy(
  plan: PilotSelectionPlan,
  options: LegacyPilotSelectionContractOptions,
): void {
  const legacy = legacyPilotSelectionContract(options);
  if (JSON.stringify(plan) !== JSON.stringify(legacy)) {
    throw new Error(
      'Pilot SelectionPlan drifted from the legacy launch topology. Update the characterization matrix before changing runner behavior.',
    );
  }
}

function diagnosticRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function diagnosticText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function diagnosticTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function diagnosticDuration(end: number | null, start: number | null): number | null {
  if (end === null || start === null) return null;
  const duration = end - start;
  return Number.isFinite(duration) && duration >= 0 ? Math.round(duration * 100) / 100 : null;
}

function diagnosticModelVariant(value: unknown): string | null {
  const variant = diagnosticText(value);
  return variant && /^[a-z0-9_-]{1,32}$/i.test(variant) ? variant : null;
}

function diagnosticEvent(entry: LiveInferenceTraceEntry): string | null {
  return diagnosticText(entry.event);
}

function diagnosticEntryTimestamp(entry: LiveInferenceTraceEntry): number | null {
  return diagnosticTimestamp(entry.ts);
}

function normalizeLiveInferenceBrowserDiagnostic(value: unknown): LiveInferenceBrowserDiagnostic {
  const record = diagnosticRecord(value) ?? {};
  const recoveryEvents = Array.isArray(record.runtimeRecoveryEvents)
    ? record.runtimeRecoveryEvents
      .map(diagnosticText)
      .filter((event): event is string => Boolean(event))
      .slice(0, 16)
    : [];
  const source = diagnosticText(record.firstAssistantTextSource);
  return {
    clickAt: diagnosticTimestamp(record.clickAt),
    sendStartedAt: diagnosticTimestamp(record.sendStartedAt),
    serverAcceptedAt: diagnosticTimestamp(record.serverAcceptedAt),
    firstAssistantTextAt: diagnosticTimestamp(record.firstAssistantTextAt),
    firstAssistantTextSource: source === 'session-sse' || source === 'visible-render'
      ? source
      : null,
    traceId: diagnosticText(record.traceId),
    sessionId: diagnosticText(record.sessionId),
    runId: diagnosticText(record.runId),
    modelVariant: diagnosticModelVariant(record.modelVariant),
    runtimeRecoveryEvents: recoveryEvents,
  };
}

export function parseLiveInferenceTraceEntries(value: string): LiveInferenceTraceEntry[] {
  const entries: LiveInferenceTraceEntry[] = [];
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = diagnosticRecord(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // A process can be terminated while appending its last trace line.
    }
  }
  return entries;
}

export function parsePilotJsonOutput(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidates = [trimmed, ...trimmed.split(/\r?\n/).reverse()];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Continue with a single JSON line when Pilot adds a human-readable prefix.
    }
  }
  return null;
}

/**
 * This deliberately returns correlation ids only to the local runner. They are
 * used to join traces, then omitted from the persisted summary.
 */
export function buildPilotLiveInferenceDiagnosticScript(): string {
  return `(function () {
  const records = (value) => Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object") : [];
  const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
  const timestamp = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
  const event = (entry) => text(entry && entry.event);
  const at = (entry) => timestamp(entry && entry.ts);
  const isExplicitRuntimeRecoveryEvent = (eventName) =>
    /(?:^|:)(?:(?:create|conversation-run)-)?runtime-recovery-(?:start|ensure-engine|result|ok)$/i.test(eventName || "") ||
    eventName === "sendPrompt:runtime-recovery:validation-failed" ||
    eventName === "sse-session-error-local-runtime-recovery-result";
  const appTrace = records(window.__vesloSendTrace);
  const workflowTrace = records(window.__vesloSendWorkflowTrace);
  const nativeClick = window.__vesloMessageSendRegistryDegradedNativeClick || null;
  const clickAt = timestamp(nativeClick && nativeClick.atMs);
  const sendStart = [...appTrace].reverse().find((entry) => event(entry) === "sendPrompt:start") || null;
  const traceId = text(sendStart && sendStart.traceId);
  const sendStartedAt = at(sendStart);
  const accepted = appTrace.find((entry) => {
    if (event(entry) !== "sendPrompt:server-submit-first-success") return false;
    if (traceId && text(entry.traceId) !== traceId) return false;
    const entryAt = at(entry);
    return !sendStartedAt || !entryAt || entryAt >= sendStartedAt;
  }) || null;
  const serverAcceptedAt = at(accepted);
  const sessionId = text(accepted && (accepted.sessionID || accepted.sessionId));
  const runId = text(accepted && accepted.runId);
  const sessionAssistantText = workflowTrace.find((entry) => {
    if (event(entry) !== "session-sse:assistant-part-updated") return false;
    if (!sessionId || text(entry.sessionID) !== sessionId) return false;
    if (entry.hasText !== true && !(typeof entry.textLength === "number" && entry.textLength > 0)) return false;
    const entryAt = at(entry);
    return !serverAcceptedAt || !entryAt || entryAt >= serverAcceptedAt;
  }) || null;
  const progress = window.__vesloMessageSendRegistryDegradedProgress || null;
  const visibleRenderedAt = progress && progress.stage === "production-managed-ai-response-rendered"
    ? Date.parse(String(progress.at || ""))
    : NaN;
  const firstAssistantTextAt = at(sessionAssistantText) ?? (Number.isFinite(visibleRenderedAt) ? visibleRenderedAt : null);
  const firstAssistantTextSource = sessionAssistantText
    ? "session-sse"
    : Number.isFinite(visibleRenderedAt)
      ? "visible-render"
      : null;
  const recoveryEvents = [...appTrace, ...workflowTrace]
    .filter((entry) => {
      const entryAt = at(entry);
      return (!clickAt || !entryAt || entryAt >= clickAt) && isExplicitRuntimeRecoveryEvent(event(entry));
    })
    .map(event)
    .filter(Boolean);
  return {
    clickAt,
    sendStartedAt,
    serverAcceptedAt,
    firstAssistantTextAt,
    firstAssistantTextSource,
    traceId,
    sessionId,
    runId,
    modelVariant: text(window.localStorage.getItem("veslo.modelVariant")),
    runtimeRecoveryEvents: [...new Set(recoveryEvents)].slice(0, 16),
  };
})()`;
}

function sameLiveInferenceContext(
  entry: LiveInferenceTraceEntry,
  browser: LiveInferenceBrowserDiagnostic,
): boolean {
  const traceId = diagnosticText(entry.traceId);
  if (browser.traceId && traceId === browser.traceId) return true;
  const runId = diagnosticText(entry.runId);
  if (browser.runId && runId === browser.runId) return true;
  const sessionId = diagnosticText(entry.sessionId) ?? diagnosticText(entry.sessionID);
  return Boolean(browser.sessionId && sessionId === browser.sessionId);
}

function traceHasModelRetry(entries: LiveInferenceTraceEntry[]): boolean {
  return entries.some((entry) =>
    diagnosticText(entry.activityKind) === 'model_retry' ||
    diagnosticText(entry.waitReason) === 'model_retry_no_output' ||
    diagnosticEvent(entry)?.includes('model-retry') === true,
  );
}

function isExplicitUiRuntimeRecoveryEvent(event: string): boolean {
  return /(?:^|:)(?:(?:create|conversation-run)-)?runtime-recovery-(?:start|ensure-engine|result|ok)$/i.test(event) ||
    event === 'sendPrompt:runtime-recovery:validation-failed' ||
    event === 'sse-session-error-local-runtime-recovery-result';
}

function diagnoseLiveInferenceLatency(timingMs: LiveInferenceDiagnosticSummary['timingMs']): LiveInferenceDiagnosticSummary['latencyDiagnosis'] {
  const candidates: Array<{
    stage: NonNullable<LiveInferenceDiagnosticSummary['latencyDiagnosis']['dominantStage']>;
    durationMs: number | null;
  }> = [
    { stage: 'app-submit', durationMs: timingMs.clickToServerAccepted },
    { stage: 'engine-before-provider', durationMs: timingMs.serverAcceptedToProviderHit },
    { stage: 'upstream-first-headers', durationMs: timingMs.providerHitToUpstreamHeaders },
    { stage: 'stream-to-first-text', durationMs: timingMs.upstreamHeadersToFirstAssistantText },
  ];
  const observed = candidates.filter((candidate): candidate is { stage: typeof candidate.stage; durationMs: number } =>
    candidate.durationMs !== null,
  );
  if (observed.length === 0) {
    return { dominantStage: null, dominantStageMs: null };
  }
  const dominant = observed.reduce((current, candidate) =>
    candidate.durationMs > current.durationMs ? candidate : current,
  );
  return { dominantStage: dominant.stage, dominantStageMs: dominant.durationMs };
}

export function summarizeLiveInferenceDiagnostics(input: LiveInferenceDiagnosticsInput): LiveInferenceDiagnosticSummary {
  const browser = normalizeLiveInferenceBrowserDiagnostic(input.browser);
  const contextualEntries = input.serverTrace
    .filter((entry) => sameLiveInferenceContext(entry, browser))
    .sort((left, right) => (diagnosticEntryTimestamp(left) ?? 0) - (diagnosticEntryTimestamp(right) ?? 0));
  const entryAfterAccepted = (entry: LiveInferenceTraceEntry) => {
    const timestamp = diagnosticEntryTimestamp(entry);
    return browser.serverAcceptedAt === null || timestamp === null || timestamp >= browser.serverAcceptedAt;
  };
  const providerHit = contextualEntries.find((entry) =>
    diagnosticEvent(entry) === 'server:ai-gateway:provider-hit' && entryAfterAccepted(entry),
  ) ?? null;
  const providerHitAt = providerHit ? diagnosticEntryTimestamp(providerHit) : null;
  const providerRequestId = providerHit ? diagnosticText(providerHit.requestId) : null;
  const upstreamHeaders = contextualEntries.find((entry) =>
    diagnosticEvent(entry) === 'server:ai-gateway:upstream-headers' &&
    (providerRequestId
      ? diagnosticText(entry.requestId) === providerRequestId
      : providerHitAt === null || (diagnosticEntryTimestamp(entry) ?? 0) >= providerHitAt),
  ) ?? null;
  const upstreamHeadersAt = upstreamHeaders ? diagnosticEntryTimestamp(upstreamHeaders) : null;
  const fallbackSet = new Set<string>();
  if (/orchestrator activate failed, falling back to fresh start/i.test(input.appStderr)) {
    fallbackSet.add('orchestrator-activate-fresh-start');
  }
  if (contextualEntries.some((entry) => diagnosticEvent(entry) === 'server:conversation-run:ai-gateway-provider-start-watch:timeout')) {
    fallbackSet.add('provider-start-watch-timeout');
  }
  if (contextualEntries.some((entry) => diagnosticEvent(entry) === 'server:opencode-json:fallback-orchestrator')) {
    fallbackSet.add('opencode-fallback-orchestrator');
  }
  if (contextualEntries.some((entry) => diagnosticEvent(entry) === 'server:ai-gateway:sessionless-forward')) {
    fallbackSet.add('ai-gateway-sessionless-forward');
  }
  if (browser.runtimeRecoveryEvents.some(isExplicitUiRuntimeRecoveryEvent)) {
    fallbackSet.add('ui-runtime-recovery');
  }
  if (traceHasModelRetry(contextualEntries)) {
    fallbackSet.add('model-retry');
  }
  const firstAssistantTextObserved = browser.firstAssistantTextAt !== null;
  const providerHitObserved = providerHitAt !== null;
  const upstreamHeadersObserved = upstreamHeadersAt !== null;
  const timingMs = {
    clickToSendStart: diagnosticDuration(browser.sendStartedAt, browser.clickAt),
    clickToServerAccepted: diagnosticDuration(browser.serverAcceptedAt, browser.clickAt),
    serverAcceptedToProviderHit: diagnosticDuration(providerHitAt, browser.serverAcceptedAt),
    providerHitToUpstreamHeaders: diagnosticDuration(upstreamHeadersAt, providerHitAt),
    upstreamHeadersToFirstAssistantText: diagnosticDuration(browser.firstAssistantTextAt, upstreamHeadersAt),
    providerHitToFirstAssistantText: diagnosticDuration(browser.firstAssistantTextAt, providerHitAt),
    clickToFirstAssistantText: diagnosticDuration(browser.firstAssistantTextAt, browser.clickAt),
  };
  return {
    schema: 'tauri-pilot-live-inference-diagnostic/v1',
    scenario: input.scenario,
    diagnosticsComplete: browser.clickAt !== null &&
      browser.serverAcceptedAt !== null &&
      providerHitObserved &&
      upstreamHeadersObserved &&
      firstAssistantTextObserved,
    simulatedFailureInputs: {
      managedAiGatewayFixture: input.env.E2E_MANAGED_AI_GATEWAY_FIXTURE?.trim() === '1',
      managedAiResponseDelay: Boolean(input.env.E2E_MANAGED_AI_RESPONSE_DELAY_MS?.trim()),
      runActivityProbe: Boolean(input.env.E2E_RUN_ACTIVITY_PROBE_MODE?.trim()),
    },
    runtimeShape: {
      devAutostartDisabled: input.env.VESLO_DISABLE_DEV_AUTOSTART?.trim() === '1',
      modelVariant: browser.modelVariant,
    },
    timingMs,
    latencyDiagnosis: diagnoseLiveInferenceLatency(timingMs),
    provider: providerHit ? diagnosticText(providerHit.provider) : null,
    evidence: {
      providerHit: providerHitObserved,
      upstreamHeaders: upstreamHeadersObserved,
      firstAssistantText: firstAssistantTextObserved,
    },
    fallbacks: [...fallbackSet],
    startupDatabaseMissingCount: Array.from(input.appStderr.matchAll(/"reason":"database_missing"/g)).length,
  };
}

function formatLiveInferenceTiming(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value)}ms`;
}

export function formatLiveInferenceDiagnosticSummary(summary: LiveInferenceDiagnosticSummary): string {
  const simulated = Object.values(summary.simulatedFailureInputs).some(Boolean) ? 'yes' : 'no';
  return [
    `click→accepted=${formatLiveInferenceTiming(summary.timingMs.clickToServerAccepted)}`,
    `accepted→provider=${formatLiveInferenceTiming(summary.timingMs.serverAcceptedToProviderHit)}`,
    `provider→headers=${formatLiveInferenceTiming(summary.timingMs.providerHitToUpstreamHeaders)}`,
    `headers→first-text=${formatLiveInferenceTiming(summary.timingMs.upstreamHeadersToFirstAssistantText)}`,
    `click→first-text=${formatLiveInferenceTiming(summary.timingMs.clickToFirstAssistantText)}`,
    `bottleneck=${summary.latencyDiagnosis.dominantStage ?? 'unobserved'}:${formatLiveInferenceTiming(summary.latencyDiagnosis.dominantStageMs)}`,
    `provider=${summary.provider ?? 'unobserved'}`,
    `variant=${summary.runtimeShape.modelVariant ?? 'default/unknown'}`,
    `simulated=${simulated}`,
    `fallbacks=${summary.fallbacks.join(',') || 'none'}`,
    `diagnostics=${summary.diagnosticsComplete ? 'complete' : 'partial'}`,
  ].join('; ');
}

export function buildPilotStorageSummaryScript(scope: 'local' | 'session'): string {
  const storage = scope === 'local' ? 'window.localStorage' : 'window.sessionStorage';
  return `(() => {
  const storage = ${storage};
  const authRaw = storage.getItem("veslo.den.auth");
  const denAuth = { present: Boolean(authRaw), hasToken: false, email: null, denApiBase: null, parseError: false };
  if (authRaw) {
    try {
      const parsed = JSON.parse(authRaw);
      if (!parsed || typeof parsed !== "object") {
        denAuth.parseError = true;
      } else {
        denAuth.hasToken = typeof parsed.token === "string" && parsed.token.trim().length > 0;
        denAuth.email = typeof parsed.user?.email === "string" ? parsed.user.email : null;
        denAuth.denApiBase = typeof parsed.denApiBase === "string" ? parsed.denApiBase : null;
      }
    } catch {
      denAuth.parseError = true;
    }
  }
  return {
    scope: ${JSON.stringify(scope)},
    keyCount: storage.length,
    keys: Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(Boolean),
    denAuth,
    hasKeepSignedIn: storage.getItem("veslo.den.keepSignedIn") === "1",
  };
})()`;
}

export function buildPilotDesktopAuthHydrationCheckScript(): string {
  return `(async () => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const authRaw = window.localStorage.getItem("veslo.den.auth") ?? window.sessionStorage.getItem("veslo.den.auth");
    if (authRaw) {
      try {
        const auth = JSON.parse(authRaw);
        if (auth && typeof auth === "object" && typeof auth.token === "string" && auth.token.trim()) {
          return {
            signedIn: true,
            email: typeof auth.user?.email === "string" ? auth.user.email : null,
            source: "desktop-snapshot-hydration",
          };
        }
      } catch {
        // Keep waiting while desktop snapshot hydration settles.
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Desktop auth snapshot did not hydrate a signed-in WebView state.");
})()`;
}

export function pilotFailureDiagnosticCommands(outputDir: string): PilotFailureDiagnosticCommand[] {
  return [
    { name: 'state', args: ['--window', 'main', 'state', '--json'], outputFile: 'state.json' },
    { name: 'windows', args: ['windows', '--json'], outputFile: 'windows.json' },
    { name: 'snapshot', args: ['--window', 'main', 'snapshot', '-i', '--depth', '6'], outputFile: 'snapshot.txt' },
    { name: 'snapshot-json', args: ['--window', 'main', 'snapshot', '--json', '--depth', '5'], outputFile: 'snapshot.json' },
    { name: 'logs', args: ['--window', 'main', 'logs', '--last', '200', '--json'], outputFile: 'logs.json' },
    { name: 'network', args: ['--window', 'main', 'network', '--last', '200', '--json'], outputFile: 'network.json' },
    {
      name: 'network-failed',
      args: ['--window', 'main', 'network', '--failed', '--last', '100', '--json'],
      outputFile: 'network-failed.json',
    },
    {
      name: 'storage-local-summary',
      args: ['--window', 'main', 'eval', '--json', buildPilotStorageSummaryScript('local')],
      outputFile: 'storage-local-summary.json',
    },
    {
      name: 'storage-session-summary',
      args: ['--window', 'main', 'eval', '--json', buildPilotStorageSummaryScript('session')],
      outputFile: 'storage-session-summary.json',
    },
    { name: 'forms', args: ['--window', 'main', 'forms', '--json'], outputFile: 'forms.json' },
    {
      name: 'send-workflow-trace',
      args: [
        '--window',
        'main',
        'eval',
        '--json',
        '(window.__vesloDumpSendWorkflowTrace?.() ?? window.__vesloSendWorkflowTrace ?? []).slice(-300)',
      ],
      outputFile: 'send-workflow-trace.json',
    },
    { name: 'veslo-server-info', args: ['--window', 'main', 'ipc', '--json', 'veslo_server_info'], outputFile: 'veslo-server-info.json' },
    { name: 'workspace-bootstrap', args: ['--window', 'main', 'ipc', '--json', 'workspace_bootstrap'], outputFile: 'workspace-bootstrap.json' },
    {
      name: 'screenshot',
      args: ['--window', 'main', 'screenshot', join(outputDir, 'webview.png')],
      outputFile: 'screenshot.txt',
      timeoutMs: 10_000,
    },
  ];
}

export function defaultPilotScenarios(e2eRoot = resolve(__dirname, '..')): string[] {
  return DEFAULT_PILOT_SCENARIO_NAMES.map((name) => join(e2eRoot, 'pilot-scenarios', `${name}.toml`));
}

export function pilotScenarioSuiteNames(suiteName: string): string[] {
  const suite = PILOT_SCENARIO_SUITES[suiteName as keyof typeof PILOT_SCENARIO_SUITES];
  if (!suite) {
    throw new Error(`Unknown tauri-pilot scenario suite: ${suiteName}`);
  }
  return [...suite];
}

export function assertPilotScenarioTimeoutCap(
  scenarios: string[],
  maximumTimeoutMs = CANONICAL_LIVE_INFERENCE_TIMEOUT_MS,
): void {
  for (const scenario of scenarios) {
    const source = readFileSync(scenario, 'utf8');
    const entries = Array.from(
      source.matchAll(/^\s*(global_timeout_ms|timeout_ms)\s*=\s*(\d+)\s*$/gm),
      ([, name, rawTimeout]) => ({ name, timeoutMs: Number(rawTimeout) }),
    );
    const overLimit = entries.find((entry) => entry.timeoutMs > maximumTimeoutMs);
    if (overLimit) {
      throw new Error(
        `Pilot scenario ${scenario} has ${overLimit.name}=${overLimit.timeoutMs}, above the ${maximumTimeoutMs}ms cap.`,
      );
    }
  }
}

export function pilotReadinessProbeCommands(): string[][] {
  return [['ping'], ['state']];
}

export function resolvePilotScenarioSelection(
  options: ResolvePilotScenarioSelectionOptions = {},
  e2eRoot = resolve(__dirname, '..'),
): string[] {
  const requested = options.scenario?.map((value) => value.trim()).filter(Boolean) ?? [];
  if (requested.length > 0 && options.suite?.trim()) {
    throw new Error('Use either --scenario or --suite, not both.');
  }
  if (options.suite?.trim()) {
    return pilotScenarioSuiteNames(options.suite.trim())
      .map((name) => join(e2eRoot, 'pilot-scenarios', `${name}.toml`));
  }
  if (requested.length === 0) return defaultPilotScenarios(e2eRoot);

  return requested.map((value) => {
    if (value.endsWith('.toml') || value.includes('/') || value.includes('\\')) {
      return isAbsolute(value) ? value : resolve(e2eRoot, value);
    }
    return join(e2eRoot, 'pilot-scenarios', `${value}.toml`);
  });
}

export function scenarioSelectionNeedsAutomationSecondaryWorkspace(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/automations.toml'));
}

export function scenarioSelectionNeedsSkillRegistryAuthFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/soul-dashboard.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/soul-den-local.toml'),
  );
}

export function scenarioSelectionNeedsLegacySoulRuntime(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/soul-den-local.toml'));
}

export function scenarioSelectionNeedsSkillEnableInventoryFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/skills-enabled-state.toml'));
}

export function scenarioSelectionNeedsGoogleMcpCatalogFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/google-mcp-connectors.toml'));
}

export function scenarioSelectionNeedsSharePointMcpCatalogFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) => scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/sharepoint-mcp-connectors.toml'));
}

export function scenarioSelectionNeedsManagedAiGatewayFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/global-managed-ai-model-policy.toml'),
  );
}

export function scenarioSelectionNeedsModelStreamRetryFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/model-stream-retry-no-progress.toml') ||
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml'),
  );
}

export function scenarioSelectionDisablesDevAutostart(scenarios: string[]): boolean {
  return scenarios.some((scenario) => {
    const normalized = scenario.replaceAll('\\', '/');
    const isCanonicalLiveInference = normalized.endsWith('/pilot-scenarios/message-send-registry-degraded.toml');
    return normalized.endsWith('/pilot-scenarios/runtime-cold-start-session-handoff.toml') ||
      normalized.endsWith('/pilot-scenarios/vslo-235-local-host-child-exit.toml') ||
      normalized.endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml') ||
      normalized.endsWith('/pilot-scenarios/global-managed-ai-model-policy.toml') ||
      normalized.endsWith('/pilot-scenarios/packaged-smoke.toml') ||
      (!isCanonicalLiveInference && MANAGED_AI_INFERENCE_SCENARIO_NAMES.some((name) =>
        normalized.endsWith(`/pilot-scenarios/${name}.toml`),
      ));
  });
}

export function pilotSessionRenderSuccessArtifactCommands(outputDir: string): PilotSuccessArtifactCommand[] {
  const commands: PilotSuccessArtifactCommand[] = [];
  for (const viewport of SESSION_RENDER_ARTIFACT_VIEWPORTS) {
    const name = `${viewport.width}x${viewport.height}`;
    commands.push(
      {
        name: `position-${name}`,
        args: [
          '--window',
          'main',
          'ipc',
          'e2e_position_main_window',
          '--args',
          JSON.stringify({ width: viewport.width, height: viewport.height, x: 32, y: 32 }),
          '--json',
        ],
        outputFile: `position-${name}.json`,
      },
      {
        name: `settle-${name}`,
        args: ['--window', 'main', 'watch', '--selector', '[data-testid="session-center-pane"]', '--stable', '250', '--timeout', '10000'],
        outputFile: `settle-${name}.txt`,
        timeoutMs: 15_000,
      },
      {
        name: `screenshot-${name}`,
        args: ['--window', 'main', 'screenshot', join(outputDir, `session-${name}.png`)],
        outputFile: `screenshot-${name}.txt`,
        timeoutMs: 15_000,
      },
    );
  }
  commands.push({
    name: 'session-center-snapshot',
    args: ['--window', 'main', 'snapshot', '-i', '--selector', '[data-testid="session-center-pane"]', '--depth', '8'],
    outputFile: 'session-center.snapshot.txt',
    timeoutMs: 15_000,
  });
  return commands;
}

export function scenarioSelectionNeedsSkillRegistryWorkspaceEventFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml'),
  );
}

export function scenarioSelectionNeedsRelaunchReconnectCheck(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-270-stop-reload-reconnect.toml'),
  );
}

export function scenarioSelectionNeedsSessionQueueRuntimeFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    [
      'session-queue-durability',
      'session-render-stability',
      'session-run-truthfulness',
    ].some((name) => scenario.replaceAll('\\', '/').endsWith(`/pilot-scenarios/${name}.toml`)),
  );
}

export function scenarioSelectionNeedsPackagedSmokeFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/packaged-smoke.toml'),
  );
}

export function scenarioSelectionRequiresExplicitSessionRuntimeActivation(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    ['session-render-stability', 'session-run-truthfulness']
      .some((name) => scenario.replaceAll('\\', '/').endsWith(`/pilot-scenarios/${name}.toml`)),
  );
}

export function assertPilotScenarioSelectionIsolated(scenarios: string[]): void {
  if (scenarioSelectionNeedsManagedAiGatewayFixture(scenarios) && scenarios.length > 1) {
    throw new Error(
      'global-managed-ai-model-policy must run as a focused pilot scenario because it owns the deterministic managed-AI fixture.',
    );
  }
  if (scenarioSelectionNeedsModelStreamRetryFixture(scenarios) && scenarios.length > 1) {
    throw new Error(
      'model-stream-retry-no-progress must run as a focused pilot scenario because it enables a global orchestrator probe fixture.',
    );
  }
  if (scenarioSelectionNeedsSessionQueueRuntimeFixture(scenarios) && scenarios.length > 1) {
    throw new Error(
      'session-queue-durability must run as a focused pilot scenario because it owns a deterministic OpenCode and lifecycle fixture.',
    );
  }
  if (scenarioSelectionNeedsPackagedSmokeFixture(scenarios) && scenarios.length > 1) {
    throw new Error(
      'packaged-smoke must run as a focused pilot scenario because it owns the deterministic local model fixture.',
    );
  }
}

export function assertManagedAiGatewayFixtureProfileIsolation(
  scenarios: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!scenarioSelectionNeedsManagedAiGatewayFixture(scenarios)) return;
  if (env.E2E_USE_EXISTING_PROFILE?.trim() === '1') {
    throw new Error(
      'global-managed-ai-model-policy must use the isolated E2E profile; unset E2E_USE_EXISTING_PROFILE.',
    );
  }
  if (env.E2E_OPENCODE_HOME?.trim()) {
    throw new Error(
      'global-managed-ai-model-policy must not set E2E_OPENCODE_HOME because the runner owns its isolated auth profile.',
    );
  }
}

export function assertSessionQueueRuntimeFixtureProfileIsolation(
  scenarios: string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    scenarioSelectionNeedsSessionQueueRuntimeFixture(scenarios) &&
    env.E2E_USE_EXISTING_PROFILE?.trim() === '1'
  ) {
    throw new Error(
      'session queue deterministic acceptance coverage must not use E2E_USE_EXISTING_PROFILE=1. Use the manual live-user Pilot smoke path separately.',
    );
  }
}

export function assertPackagedSmokeProfileIsolation(
  scenarios: string[],
  env: Record<string, string | undefined> = process.env,
): void {
  if (!scenarioSelectionNeedsPackagedSmokeFixture(scenarios)) return;
  if (env.VESLO_PACKAGED_SMOKE?.trim() !== '1') {
    throw new Error('packaged-smoke must be launched through pnpm desktop:smoke-packaged.');
  }

  const explicitlyDisallowed = [
    'E2E_USE_EXISTING_PROFILE',
    'E2E_OPENCODE_HOME',
    'E2E_TAURI_BINARY',
    'E2E_PRESERVE_ISOLATED_PROFILE',
    'VESLO_DEV_SERVER_URL',
    'VESLO_DEV_SERVER_TOKEN',
    'VESLO_DESKTOP_ALLOW_EXTERNAL_RUNTIME_BINARIES',
    'OPENCODE_BIN_PATH',
    'VESLO_DEN_API_BASE',
    'VESLO_DEN_AUTH_SNAPSHOT_PATH',
    'VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE',
    'E2E_DEN_AUTH_SNAPSHOT_FILE',
    'VESLO_E2E_DEN_AUTH_JSON',
    'E2E_DEN_AUTH_JSON',
    'VESLO_MANAGED_AI_BASE_URL',
    'VESLO_AI_GATEWAY_BASE_URL',
  ];
  const inheritedE2eConfiguration = Object.entries(env)
    .filter(([name, value]) => (
      name.startsWith('E2E_')
      && name !== 'E2E_TAURI_PILOT_BIN'
      && Boolean(value?.trim())
    ))
    .map(([name]) => name);
  const inheritedCredential = Object.entries(env)
    .filter(([name, value]) => (
      /(?:^|_)(?:API_KEY|TOKENS?|SECRETS?|PASSWORDS?|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$)/i.test(name)
      && Boolean(value?.trim())
    ))
    .map(([name]) => name);
  const inheritedRuntimeOverride = Object.entries(env)
    .filter(([name, value]) => (
      (name.startsWith('VESLO_') &&
        !['VESLO_PACKAGED_SMOKE', 'VESLO_SIDECAR_FORCE_BUILD', 'VESLO_DISABLE_DEV_AUTOSTART'].includes(name)) ||
      name.startsWith('VITE_') ||
      name.startsWith('OPENCODE_')
    ) && Boolean(value?.trim()))
    .map(([name]) => name);
  const disallowed = [...new Set([
    ...explicitlyDisallowed.filter((name) => Boolean(env[name]?.trim())),
    ...inheritedE2eConfiguration,
    ...inheritedCredential,
    ...inheritedRuntimeOverride,
  ])];
  if (disallowed.length > 0) {
    throw new Error(
      'packaged-smoke rejects inherited dev, profile, binary, auth, or provider overrides: ' + disallowed.join(', ') + '.',
    );
  }
}

function assertSelectionPlanAllowed(selectionPlan: PilotSelectionPlan): void {
  if (!selectionPlan.rejection) return;
  throw new Error(`Pilot selection rejected: ${selectionPlan.rejection}.`);
}

function assertSelectionPlanLiveAuth(
  selectionPlan: PilotSelectionPlan,
  env: Record<string, string | undefined> = process.env,
): void {
  if (selectionPlan.auth !== 'live-den') return;
  assertLiveManagedAiAuthForScenarioSelection([...selectionPlan.scenarios], env);
  if (env.E2E_MANAGED_AI_GATEWAY_FIXTURE?.trim() === '1') {
    throw new Error('Pilot live managed-AI selections reject E2E_MANAGED_AI_GATEWAY_FIXTURE=1.');
  }
}

function assertSelectionPlanPackagedSmokeEnvironment(
  selectionPlan: PilotSelectionPlan,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!selectionPlan.fixtures.includes('packaged-smoke-model')) return;
  if (env.VESLO_PACKAGED_SMOKE?.trim() !== '1') {
    throw new Error('packaged-smoke must be launched through pnpm desktop:smoke-packaged.');
  }

  const explicitlyDisallowed = [
    'E2E_USE_EXISTING_PROFILE',
    'E2E_OPENCODE_HOME',
    'E2E_TAURI_BINARY',
    'E2E_PRESERVE_ISOLATED_PROFILE',
    'VESLO_DEV_SERVER_URL',
    'VESLO_DEV_SERVER_TOKEN',
    'VESLO_DESKTOP_ALLOW_EXTERNAL_RUNTIME_BINARIES',
    'OPENCODE_BIN_PATH',
    'VESLO_DEN_API_BASE',
    'VESLO_DEN_AUTH_SNAPSHOT_PATH',
    'VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE',
    'E2E_DEN_AUTH_SNAPSHOT_FILE',
    'VESLO_E2E_DEN_AUTH_JSON',
    'E2E_DEN_AUTH_JSON',
    'VESLO_MANAGED_AI_BASE_URL',
    'VESLO_AI_GATEWAY_BASE_URL',
  ];
  const inheritedE2eConfiguration = Object.entries(env)
    .filter(([name, value]) => name.startsWith('E2E_') && name !== 'E2E_TAURI_PILOT_BIN' && Boolean(value?.trim()))
    .map(([name]) => name);
  const inheritedCredential = Object.entries(env)
    .filter(([name, value]) => /(?:^|_)(?:API_KEY|TOKENS?|SECRETS?|PASSWORDS?|CREDENTIALS?|AUTH(?:ORIZATION)?)(?:_|$)/i.test(name) && Boolean(value?.trim()))
    .map(([name]) => name);
  const inheritedRuntimeOverride = Object.entries(env)
    .filter(([name, value]) => (
      (name.startsWith('VESLO_') &&
        !['VESLO_PACKAGED_SMOKE', 'VESLO_SIDECAR_FORCE_BUILD', 'VESLO_DISABLE_DEV_AUTOSTART'].includes(name)) ||
      name.startsWith('VITE_') ||
      name.startsWith('OPENCODE_')
    ) && Boolean(value?.trim()))
    .map(([name]) => name);
  const disallowed = [...new Set([
    ...explicitlyDisallowed.filter((name) => Boolean(env[name]?.trim())),
    ...inheritedE2eConfiguration,
    ...inheritedCredential,
    ...inheritedRuntimeOverride,
  ])];
  if (disallowed.length > 0) {
    throw new Error('packaged-smoke rejects inherited dev, profile, binary, auth, or provider overrides: ' + disallowed.join(', ') + '.');
  }
}

function setEnvironmentForFixture(
  values: Record<string, string>,
  targetEnv: NodeJS.ProcessEnv = process.env,
): EnvironmentRestore {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, targetEnv[key]);
    targetEnv[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete targetEnv[key];
      else targetEnv[key] = value;
    }
  };
}

export function configureManagedAiGatewayFixtureEnvironment(
  targetEnv: NodeJS.ProcessEnv = process.env,
): EnvironmentRestore {
  return setEnvironmentForFixture({
    E2E_MANAGED_AI_GATEWAY_FIXTURE: '1',
    VESLO_E2E_DEN_AUTH_JSON: '',
    E2E_DEN_AUTH_JSON: '',
    VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: '',
    E2E_DEN_AUTH_SNAPSHOT_FILE: '',
    VESLO_DEN_AUTH_SNAPSHOT_PATH: '',
  }, targetEnv);
}

export function configureLiveParityRuntimePreferencesEnvironment(
  targetEnv: NodeJS.ProcessEnv = process.env,
): EnvironmentRestore {
  const source = resolveCanonicalLiveParityRuntimePreferencesSource(targetEnv);
  if (!source) return () => {};
  return setEnvironmentForFixture({
    E2E_LIVE_PARITY_RUNTIME_PREFERENCES_SOURCE: source,
  }, targetEnv);
}

export function configureCanonicalLiveInferenceEnvironment(
  targetEnv: NodeJS.ProcessEnv = process.env,
): EnvironmentRestore {
  return setEnvironmentForFixture({
    E2E_MANAGED_AI_GATEWAY_FIXTURE: '0',
    E2E_SKILL_REGISTRY_FIXTURE: '0',
    E2E_SKILL_REGISTRY_SERVER_ENV: '0',
    E2E_SKILL_REGISTRY_AUTH_BASE: '',
    E2E_GOOGLE_MCP_CATALOG_FIXTURE: '0',
    E2E_SHAREPOINT_MCP_CATALOG_FIXTURE: '0',
    E2E_RUN_ACTIVITY_PROBE_MODE: '',
    E2E_MANAGED_AI_RESPONSE_DELAY_MS: '',
    E2E_SKILL_REGISTRY_EVENTS_MODE: '',
    // The canonical suite measures the debug development path. Cold-start
    // lifecycle coverage owns the intentionally disabled-autostart variant.
    VESLO_DISABLE_DEV_AUTOSTART: '',
    // Persist only redacted timing/fallback evidence in the harness-owned
    // profile. These flags do not alter provider selection or auth.
    // Keep the stdout/stderr capture in the harness, but make the normal
    // success signal the redacted diagnostic line. A user can opt back into
    // live app-log forwarding with E2E_FORWARD_APP_LOGS=1.
    E2E_FORWARD_APP_LOGS: targetEnv.E2E_FORWARD_APP_LOGS?.trim() || '0',
    VESLO_SEND_WORKFLOW_TRACE: '1',
    VESLO_SEND_WORKFLOW_TRACE_CONSOLE: '',
  }, targetEnv);
}

export function scenarioSelectionNeedsNoWorkspaceProfile(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-235-local-host-no-workspace.toml'),
  );
}

export function scenarioSelectionNeedsPortContentionFixture(scenarios: string[]): boolean {
  return scenarios.some((scenario) =>
    scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/vslo-235-local-host-port-contention.toml'),
  );
}

export function scenarioSelectionRequiresLiveManagedAiAuth(scenarios: string[]): boolean {
  return scenarios.some((scenario) => {
    const normalized = scenario.replaceAll('\\', '/');
    return MANAGED_AI_INFERENCE_SCENARIO_NAMES.some((name) =>
      normalized.endsWith(`/pilot-scenarios/${name}.toml`),
    );
  });
}

export type LegacyPilotSelectionContractOptions = {
  scenarios: string[];
  suite?: string | null;
  env?: Record<string, string | undefined>;
};

/**
 * This adapter intentionally derives signals from the pre-refactor predicate
 * graph. Characterization tests compare it to the independent compiler before
 * the runner delegates any launch topology to the new SelectionPlan.
 */
export function legacyPilotSelectionSignals(
  options: LegacyPilotSelectionContractOptions,
): PilotSelectionSignals {
  const env = options.env ?? process.env;
  const needsPackagedSmokeFixture = scenarioSelectionNeedsPackagedSmokeFixture(options.scenarios);
  const profileMode = env.E2E_USE_EXISTING_PROFILE?.trim() === '1'
    ? 'real-profile'
    : env.E2E_OPENCODE_HOME?.trim()
      ? 'custom-opencode-home'
      : needsPackagedSmokeFixture
        ? 'packaged-smoke'
        : 'isolated';

  return {
    scenarioNames: options.scenarios.map((scenario) => basename(scenario.replaceAll('\\', '/')).replace(/\.toml$/i, '')),
    suite: options.suite?.trim() || null,
    profileMode,
    hasPackagedSmokeLaunch: env.VESLO_PACKAGED_SMOKE?.trim() === '1',
    needsAutomationSecondaryWorkspace: scenarioSelectionNeedsAutomationSecondaryWorkspace(options.scenarios),
    needsSkillRegistryAuthFixture: scenarioSelectionNeedsSkillRegistryAuthFixture(options.scenarios),
    needsLegacySoulRuntime: scenarioSelectionNeedsLegacySoulRuntime(options.scenarios),
    needsSkillEnableInventoryFixture: scenarioSelectionNeedsSkillEnableInventoryFixture(options.scenarios),
    needsGoogleMcpCatalogFixture: scenarioSelectionNeedsGoogleMcpCatalogFixture(options.scenarios),
    needsSharePointMcpCatalogFixture: scenarioSelectionNeedsSharePointMcpCatalogFixture(options.scenarios),
    needsManagedAiGatewayFixture: scenarioSelectionNeedsManagedAiGatewayFixture(options.scenarios),
    needsModelStreamRetryFixture: scenarioSelectionNeedsModelStreamRetryFixture(options.scenarios),
    disablesDevAutostart: scenarioSelectionDisablesDevAutostart(options.scenarios),
    needsSkillRegistryWorkspaceEventFixture: scenarioSelectionNeedsSkillRegistryWorkspaceEventFixture(options.scenarios),
    needsRelaunchReconnectCheck: scenarioSelectionNeedsRelaunchReconnectCheck(options.scenarios),
    needsSessionQueueRuntimeFixture: scenarioSelectionNeedsSessionQueueRuntimeFixture(options.scenarios),
    requiresExplicitSessionRuntimeActivation:
      scenarioSelectionRequiresExplicitSessionRuntimeActivation(options.scenarios),
    needsPackagedSmokeFixture,
    needsNoWorkspaceProfile: scenarioSelectionNeedsNoWorkspaceProfile(options.scenarios),
    needsPortContentionFixture: scenarioSelectionNeedsPortContentionFixture(options.scenarios),
    requiresLiveManagedAiAuth: scenarioSelectionRequiresLiveManagedAiAuth(options.scenarios),
  };
}

export function legacyPilotSelectionContract(
  options: LegacyPilotSelectionContractOptions,
): PilotSelectionPlan {
  return buildPilotSelectionPlan(legacyPilotSelectionSignals(options));
}

function normalizeOptionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isLoopbackUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function resolveLiveDenAuthSnapshotPath(env: Record<string, string | undefined>): string | null {
  const snapshotPath = normalizeOptionalText(env.VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE)
    ?? normalizeOptionalText(env.E2E_DEN_AUTH_SNAPSHOT_FILE)
    ?? normalizeOptionalText(env.VESLO_DEN_AUTH_SNAPSHOT_PATH);
  return snapshotPath ? resolve(snapshotPath) : null;
}

function readDenAuthJsonFromSnapshot(snapshotPath: string): string {
  const raw = readFileSync(snapshotPath, 'utf8').replace(/^\uFEFF/, '');
  const snapshot = JSON.parse(raw) as { authJson?: unknown };
  return typeof snapshot.authJson === 'string' ? snapshot.authJson : raw;
}

function readDenAuthSummaryFromJson(authRaw: string, source: string | null): DenAuthSummary {
  const parsed = JSON.parse(authRaw.replace(/^\uFEFF/, '')) as {
    denApiBase?: unknown;
    token?: unknown;
    user?: { email?: unknown };
    source?: unknown;
  };
  return {
    denApiBase: normalizeOptionalText(parsed.denApiBase),
    email: normalizeOptionalText(parsed.user?.email),
    hasToken: Boolean(normalizeOptionalText(parsed.token)),
    source: normalizeOptionalText(parsed.source) ?? source,
    token: normalizeOptionalText(parsed.token),
  };
}

export function assertLiveManagedAiAuthForScenarioSelection(
  scenarios: string[],
  env: Record<string, string | undefined> = process.env,
): void {
  if (!scenarioSelectionRequiresLiveManagedAiAuth(scenarios)) return;

  if (env.E2E_MANAGED_AI_GATEWAY_FIXTURE?.trim() === '1') {
    throw new Error(
      'Managed-AI inference pilot scenarios must run the live managed-AI path. Unset E2E_MANAGED_AI_GATEWAY_FIXTURE or set it to 0.',
    );
  }

  if (env.E2E_USE_EXISTING_PROFILE?.trim() === '1' || env.E2E_OPENCODE_HOME?.trim()) {
    throw new Error(
      'Managed-AI inference pilot scenarios require the harness-owned isolated profile and auth snapshot; unset E2E_USE_EXISTING_PROFILE and E2E_OPENCODE_HOME.',
    );
  }

  const managedAiOverride =
    normalizeOptionalText(env.VESLO_MANAGED_AI_BASE_URL) ?? normalizeOptionalText(env.VESLO_AI_GATEWAY_BASE_URL);
  if (isLoopbackUrl(managedAiOverride)) {
    throw new Error(
      `Managed-AI inference pilot scenarios require a live managed-AI gateway, got loopback override: ${managedAiOverride}.`,
    );
  }

  let summary: DenAuthSummary | null = null;
  const rawAuthJson = normalizeOptionalText(env.VESLO_E2E_DEN_AUTH_JSON) ?? normalizeOptionalText(env.E2E_DEN_AUTH_JSON);
  if (rawAuthJson) {
    summary = readDenAuthSummaryFromJson(rawAuthJson, 'env');
  } else {
    const snapshotPath = resolveLiveDenAuthSnapshotPath(env);
    if (!snapshotPath) {
      throw new Error(
        'Managed-AI inference pilot scenarios require live Den auth. Set VESLO_DEN_AUTH_SNAPSHOT_PATH or VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE to a real user snapshot, for example C:\\Users\\jajse\\.veslo\\den-auth.json.',
      );
    }
    if (!existsSync(snapshotPath)) {
      throw new Error(`Live Den auth snapshot does not exist: ${snapshotPath}`);
    }
    summary = readDenAuthSummaryFromJson(readDenAuthJsonFromSnapshot(snapshotPath), snapshotPath);
  }

  const invalidReasons = [
    !summary.hasToken ? 'token missing' : null,
    !summary.email ? 'email missing' : null,
    summary.email?.endsWith('@example.test') ? `test email ${summary.email}` : null,
    summary.token?.startsWith('veslo-e2e-') ? 'E2E fixture token' : null,
    isLoopbackUrl(summary.denApiBase) ? `loopback Den base ${summary.denApiBase}` : null,
  ].filter((reason): reason is string => Boolean(reason));

  if (invalidReasons.length > 0) {
    throw new Error(
      `Managed-AI inference pilot scenarios require a real Den user auth seed, got email=${summary.email ?? 'missing'} token=${summary.hasToken ? 'present' : 'missing'} source=${summary.source ?? 'unknown'} (${invalidReasons.join(', ')}).`,
    );
  }
}

async function startPortContentionFixture(): Promise<PortContentionFixture> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error('Port contention fixture did not bind a TCP port.');
  }

  const previousE2ePort = process.env.E2E_VESLO_SERVER_PORT;
  process.env.E2E_VESLO_SERVER_PORT = String(port);
  console.log(`[e2e] Port contention fixture holding 127.0.0.1:${port}`);
  return { server, previousE2ePort };
}

async function stopPortContentionFixture(fixture: PortContentionFixture | null): Promise<void> {
  if (!fixture) return;

  if (fixture.previousE2ePort === undefined) {
    delete process.env.E2E_VESLO_SERVER_PORT;
  } else {
    process.env.E2E_VESLO_SERVER_PORT = fixture.previousE2ePort;
  }

  await new Promise<void>((resolveClose, reject) => {
    fixture.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolveClose();
    });
  });
}

function pilotCommandFailure(options: RunPilotCommandOptions, result: PilotCommandResult): Error | null {
  if (pilotCommandSucceeded(result)) return null;
  const binary = options.binary ?? resolvePilotBinary(options.env);
  const socket = options.socket ?? resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });
  const { command, args } = buildPilotCommand({ binary, socket, args: options.args });
  const safeArgs = redactPilotCommandArgs(args).join(' ');
  if (result.timedOut) {
    return new Error(`tauri-pilot command timed out after ${options.timeoutMs ?? 'the configured'}ms: ${safeArgs}`);
  }
  const detail = redactPilotDiagnosticText([
    result.error,
    result.stderr,
    result.stdout,
  ].filter((value): value is string => Boolean(value?.trim())).join('\n')).trim();
  return new Error(
    `tauri-pilot exited with ${result.exitCode ?? result.signal ?? 'an unknown status'}: ${safeArgs}` +
    (detail ? `\n${tailText(detail)}` : ''),
  );
}

async function runPilotCommandCapture(options: RunPilotCommandOptions): Promise<PilotCommandResult> {
  const binary = options.binary ?? resolvePilotBinary(options.env);
  const socket = options.socket ?? resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });
  const { command, args } = buildPilotCommand({ binary, socket, args: options.args });
  return await executePilotCommand({
    command,
    args,
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    inheritStdio: options.inheritStdio,
  });
}

export async function runPilotCommand(options: RunPilotCommandOptions): Promise<PilotCommandResult> {
  const result = await runPilotCommandCapture(options);
  const failure = pilotCommandFailure(options, result);
  if (failure) throw failure;
  return result;
}

function persistPilotScenarioCommandResult(options: {
  outputDir: string;
  scenario: string;
  result: PilotCommandResult;
  junitRawPath: string;
  junitPath: string;
}): void {
  const stdout = redactPilotDiagnosticText(options.result.stdout).trim();
  const stderr = redactPilotDiagnosticText(options.result.stderr).trim();
  const error = options.result.error ? 'pilot-command-error' : null;
  writeFileSync(join(options.outputDir, 'pilot.stdout.log'), stdout ? `${stdout}\n` : '', 'utf8');
  writeFileSync(join(options.outputDir, 'pilot.stderr.log'), stderr ? `${stderr}\n` : '', 'utf8');

  let junitCaptured = false;
  if (existsSync(options.junitRawPath)) {
    const junit = readPilotDiagnosticFile(options.junitRawPath);
    writeFileSync(options.junitPath, junit ? `${redactPilotJUnitXml(junit).trim()}\n` : '', 'utf8');
    junitCaptured = true;
  }

  writeFileSync(join(options.outputDir, 'result.json'), `${JSON.stringify({
    schema: 'tauri-pilot-command-result/v1',
    scenario: sanitizePilotArtifactName(options.scenario),
    command: options.result.command,
    args: redactPilotCommandArgs(options.result.args),
    startedAt: options.result.startedAt,
    finishedAt: options.result.finishedAt,
    durationMs: options.result.durationMs,
    exitCode: options.result.exitCode,
    signal: options.result.signal,
    timedOut: options.result.timedOut,
    error,
    junitCaptured,
  }, null, 2)}\n`, 'utf8');
}

async function runPilotScenarioWithArtifacts(options: {
  binary: string;
  socket: string;
  cwd: string;
  scenario: string;
  timeoutMs: number;
  runContext: PilotRunContext;
}): Promise<string> {
  const outputDir = options.runContext.scenarioDir(options.scenario);
  const junitPath = join(outputDir, 'pilot.junit.xml');
  const junitTemporaryDir = mkdtempSync(join(tmpdir(), 'veslo-tauri-pilot-junit-'));
  const junitRawPath = join(junitTemporaryDir, 'pilot.junit.xml');
  const args = ['run', '--junit', junitRawPath, options.scenario];
  const result = await (async () => {
    try {
      const commandResult = await runPilotCommandCapture({
        binary: options.binary,
        socket: options.socket,
        args,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        inheritStdio: true,
      });
      persistPilotScenarioCommandResult({
        outputDir,
        scenario: options.scenario,
        result: commandResult,
        junitRawPath,
        junitPath,
      });
      return commandResult;
    } finally {
      rmSync(junitTemporaryDir, { recursive: true, force: true });
    }
  })();
  const failure = pilotCommandFailure({
    binary: options.binary,
    socket: options.socket,
    args,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    inheritStdio: true,
  }, result);
  if (failure) throw failure;
  return outputDir;
}

async function collectPilotFailureDiagnostics(options: {
  binary: string;
  socket: string;
  cwd: string;
  e2eRoot: string;
  scenario: string;
  outputDir?: string;
  error: unknown;
  timeoutMs: number;
}): Promise<void> {
  if (process.env.E2E_PILOT_FAILURE_DIAGNOSTICS?.trim() === '0') return;

  const scenarioName = sanitizePilotArtifactName(options.scenario);
  const outputDir = options.outputDir ?? join(
    options.e2eRoot,
    'tauri-pilot-failures',
    `diagnostics-${Date.now()}-${scenarioName}`,
  );
  mkdirSync(outputDir, { recursive: true });

  const failureClassification = safePilotRunFailureReason(options.error);
  writeFileSync(join(outputDir, 'failure.txt'), `classification=${failureClassification}\n`, 'utf8');

  const commands = pilotFailureDiagnosticCommands(outputDir);
  const results: Array<{
    name: string;
    command: string;
    args: string[];
    outputFile: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    error: string | null;
  }> = [];

  for (const diagnostic of commands) {
    const result = await runPilotCommandCapture({
      binary: options.binary,
      socket: options.socket,
      cwd: options.cwd,
      args: diagnostic.args,
      timeoutMs: diagnostic.timeoutMs ?? Math.min(5_000, Math.max(1_000, options.timeoutMs)),
    });
    const stdout = redactPilotDiagnosticText(result.stdout).trim();
    const stderr = redactPilotDiagnosticText(result.stderr).trim();
    const error = result.error ? 'pilot-command-error' : null;
    const body = [
      stdout || null,
      stderr ? `stderr:\n${stderr}` : null,
      error ? `error:\n${error}` : null,
      result.exitCode === 0 && !result.timedOut ? null : `status: exit=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'} timedOut=${result.timedOut}`,
    ].filter(Boolean).join('\n\n');

    writeFileSync(join(outputDir, diagnostic.outputFile), body ? `${body}\n` : '', 'utf8');
    results.push({
      name: diagnostic.name,
      command: result.command,
      args: redactPilotCommandArgs(result.args),
      outputFile: diagnostic.outputFile,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      error,
    });
  }

  writeFileSync(join(outputDir, 'summary.json'), JSON.stringify({
    scenario: scenarioName,
    capturedAt: new Date().toISOString(),
    failure: failureClassification,
    commands: results,
  }, null, 2), 'utf8');

  console.error(redactPilotDiagnosticText(`[e2e] Pilot failure diagnostics captured: ${outputDir}`));
}

function readPilotDiagnosticFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readPilotAppStderrLogs(appLogDir: string): string {
  try {
    return readdirSync(appLogDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.stderr.log'))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => readPilotDiagnosticFile(join(appLogDir, entry.name)))
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}

async function collectLiveInferenceSuccessDiagnostics(options: {
  binary: string;
  socket: string;
  cwd: string;
  e2eRoot: string;
  scenario: string;
  outputDir?: string;
  logDir?: string;
  appLogDir?: string;
  timeoutMs: number;
}): Promise<void> {
  const outputDir = options.outputDir ?? join(
    options.e2eRoot,
    'tauri-pilot-artifacts',
    `live-inference-diagnostic-${Date.now()}-${sanitizePilotArtifactName(options.scenario)}`,
  );
  mkdirSync(outputDir, { recursive: true });
  const browserCapture = await runPilotCommandCapture({
    binary: options.binary,
    socket: options.socket,
    cwd: options.cwd,
    args: ['--window', 'main', 'eval', '--json', buildPilotLiveInferenceDiagnosticScript()],
    timeoutMs: Math.min(10_000, Math.max(1_000, options.timeoutMs)),
  });
  const browser = browserCapture.exitCode === 0 && !browserCapture.timedOut && !browserCapture.error
    ? parsePilotJsonOutput(browserCapture.stdout)
    : null;
  const logDir = options.logDir ?? join(options.e2eRoot, '.tmp-opencode-home', '.veslo', 'e2e-logs');
  const serverTrace = parseLiveInferenceTraceEntries(
    readPilotDiagnosticFile(join(logDir, 'send-workflow-trace.server.ndjson')),
  );
  const appStderr = options.appLogDir
    ? readPilotAppStderrLogs(options.appLogDir)
    : readPilotDiagnosticFile(join(logDir, 'app-stderr.log'));
  const summary = summarizeLiveInferenceDiagnostics({
    scenario: options.scenario,
    browser,
    serverTrace,
    appStderr,
    env: process.env,
  });
  writeFileSync(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(`[e2e] Live inference diagnostic: ${formatLiveInferenceDiagnosticSummary(summary)}`);
  console.log(redactPilotDiagnosticText(`[e2e] Live inference diagnostic artifact: ${outputDir}`));
  if (!summary.diagnosticsComplete) {
    console.warn('[e2e] Live inference diagnostics are partial; inspect the redacted summary before using this run as a latency baseline.');
  }
}

async function collectSessionRenderSuccessArtifacts(options: {
  binary: string;
  socket: string;
  cwd: string;
  e2eRoot: string;
  outputDir?: string;
  timeoutMs: number;
}): Promise<void> {
  const outputDir = options.outputDir ?? join(options.e2eRoot, 'tauri-pilot-artifacts', `session-render-stability-${Date.now()}`);
  mkdirSync(outputDir, { recursive: true });
  const commands = pilotSessionRenderSuccessArtifactCommands(outputDir);
  const results: Array<{ name: string; outputFile: string; command: string; args: string[] }> = [];

  for (const artifact of commands) {
    const result = await runPilotCommandCapture({
      binary: options.binary,
      socket: options.socket,
      cwd: options.cwd,
      args: artifact.args,
      timeoutMs: artifact.timeoutMs ?? Math.min(15_000, Math.max(1_000, options.timeoutMs)),
    });
    const stdout = redactPilotDiagnosticText(result.stdout).trim();
    const stderr = redactPilotDiagnosticText(result.stderr).trim();
    const error = result.error ? redactPilotDiagnosticText(result.error) : null;
    const body = [
      stdout || null,
      stderr ? `stderr:\n${stderr}` : null,
      error ? `error:\n${error}` : null,
      result.exitCode === 0 && !result.timedOut ? null : `status: exit=${result.exitCode ?? 'null'} signal=${result.signal ?? 'null'} timedOut=${result.timedOut}`,
    ].filter(Boolean).join('\n\n');
    writeFileSync(join(outputDir, artifact.outputFile), body ? `${body}\n` : '', 'utf8');
    if (result.exitCode !== 0 || result.timedOut || error) {
      throw new Error(`Could not capture session-render-stability artifact ${artifact.name}: ${body || 'tauri-pilot returned no detail'}`);
    }
    results.push({
      name: artifact.name,
      outputFile: artifact.outputFile,
      command: result.command,
      args: redactPilotCommandArgs(result.args),
    });
  }

  const manifest = createSessionRenderArtifactManifest({
    widths: SESSION_RENDER_ARTIFACT_VIEWPORTS.map((viewport) => viewport.width),
  });
  writeFileSync(join(outputDir, 'manifest.json'), JSON.stringify({ ...manifest, commands: results }, null, 2), 'utf8');
  console.log(redactPilotDiagnosticText(`[e2e] Session render artifacts captured: ${outputDir}`));
}

export async function ensurePilotReady(options: Omit<RunPilotCommandOptions, 'args'> = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? Math.min(PILOT_WEBVIEW_READINESS_TIMEOUT_MS, resolveLaunchTimeout());
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      for (const args of pilotReadinessProbeCommands()) {
        await runPilotCommand({
          ...options,
          args,
          timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())),
        });
      }
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, DEFAULT_READY_POLL_INTERVAL));
    }
  }

  const message = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`tauri-pilot did not become ready within ${timeoutMs}ms.${message}`);
}

async function verifyPilotDesktopAuthHydration(
  options: Omit<RunPilotCommandOptions, 'args'> = {},
): Promise<void> {
  await runPilotCommand({
    ...options,
    args: ['--window', 'main', 'eval', '--json', buildPilotDesktopAuthHydrationCheckScript()],
    timeoutMs: Math.min(
      PILOT_DESKTOP_AUTH_HYDRATION_COMMAND_TIMEOUT_MS,
      options.timeoutMs ?? resolveLaunchTimeout(),
    ),
  });
}

async function installPilotBrowserPrelude(
  options: Omit<RunPilotCommandOptions, 'args'> = {},
): Promise<void> {
  await runPilotCommand({
    ...options,
    args: ['--window', 'main', 'eval', '--json', buildPilotBrowserPreludeScript()],
    timeoutMs: Math.min(10_000, options.timeoutMs ?? resolveLaunchTimeout()),
  });
}

export async function runPilotScenarios(options: RunPilotScenariosOptions = {}): Promise<void> {
  const e2eRoot = options.e2eRoot ?? resolve(__dirname, '..');
  const scenarios = resolvePilotScenarioSelection(options, e2eRoot);
  const binary = options.binary ?? resolvePilotBinary();
  const socket = options.socket ?? resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });
  const timeoutMs = options.timeoutMs ?? resolveLaunchTimeout();
  const selectionPlan = compilePilotSelectionPlan({
    scenarios,
    suite: options.suite,
    env: process.env,
  });
  assertSelectionPlanAllowed(selectionPlan);
  assertSelectionPlanLiveAuth(selectionPlan);
  assertSelectionPlanPackagedSmokeEnvironment(selectionPlan);
  const isCanonicalLiveInferenceSuite = selectionPlan.launch.scenarioTimeout === 'canonical-live';
  const scenarioCommandTimeoutMs = isCanonicalLiveInferenceSuite
    ? resolveCanonicalLiveInferenceCommandTimeoutMs()
    : resolvePilotScenarioCommandTimeoutMs();

  for (const scenario of scenarios) {
    if (!existsSync(scenario)) {
      throw new Error(`tauri-pilot scenario not found: ${scenario}`);
    }
  }
  if (isCanonicalLiveInferenceSuite) {
    assertPilotScenarioTimeoutCap(scenarios);
  }
  const requiresLiveManagedAiAuth = selectionPlan.auth === 'live-den';
  const usesManagedAiGatewayFixture = selectionPlanHasFixture(selectionPlan, 'managed-ai-gateway');
  const usesSessionQueueRuntimeFixture = selectionPlanHasFixture(selectionPlan, 'session-queue-runtime');
  const usesPackagedSmokeFixture = selectionPlanHasFixture(selectionPlan, 'packaged-smoke-model');
  const runRoot = options.runRoot ?? join(e2eRoot, PILOT_RUNS_DIRNAME);
  prunePilotRunHistory({
    rootDir: runRoot,
    warn: (message) => console.warn(message),
  });
  const runContext = createPilotRunContext({
    rootDir: runRoot,
    suite: options.suite ?? null,
    scenarios: scenarios.map(sanitizePilotArtifactName),
    binary,
    profileMode: selectionPlan.profile.mode,
    authMode: selectionPlan.auth,
    fixtures: selectionPlan.fixtures,
  });
  const stopRunHeartbeat = runContext.startHeartbeat();
  let runCompleted = false;
  let failureReason: string | null = null;
  runContext.record('run.policy', {
    canonicalLiveInference: isCanonicalLiveInferenceSuite,
    requiresLiveManagedAiAuth,
    devAutostartDisabled: selectionPlan.launch.devAutostart === 'disabled',
    relaunch: selectionPlan.launch.relaunch,
  });
  const restoreManagedAiFixtureEnvironment = usesManagedAiGatewayFixture
    ? configureManagedAiGatewayFixtureEnvironment()
    : null;
  const restoreLiveParityRuntimePreferencesEnvironment = requiresLiveManagedAiAuth
    ? configureLiveParityRuntimePreferencesEnvironment()
    : null;
  const restoreCanonicalLiveInferenceEnvironment = isCanonicalLiveInferenceSuite
    ? configureCanonicalLiveInferenceEnvironment()
    : null;
  applySetIfEmptySelectionEnvironment(selectionPlan);
  let portContentionFixture: PortContentionFixture | null = null;
  let sessionQueueRuntimeFixture: SessionQueueRuntimeFixture | null = null;
  let packagedSmokeModelFixture: PackagedSmokeModelFixture | null = null;
  let restoreSessionQueueFixtureEnvironment: EnvironmentRestore | null = null;
  let restorePackagedSmokeFixtureEnvironment: EnvironmentRestore | null = null;

  try {
    if (selectionPlanHasFixture(selectionPlan, 'port-contention')) {
      runContext.record('fixture.starting', { fixture: 'port-contention' });
      portContentionFixture = await startPortContentionFixture();
      runContext.record('fixture.started', { fixture: 'port-contention' });
    }
    if (usesSessionQueueRuntimeFixture) {
      runContext.record('fixture.starting', { fixture: 'session-queue-runtime' });
      sessionQueueRuntimeFixture = await startSessionQueueRuntimeFixture();
      restoreSessionQueueFixtureEnvironment = setEnvironmentForFixture({
        E2E_SESSION_QUEUE_FIXTURE_BASE_URL: sessionQueueRuntimeFixture.baseUrl,
        E2E_SESSION_QUEUE_VESLO_SERVER_URL: sessionQueueRuntimeFixture.vesloServerBaseUrl,
        E2E_SESSION_QUEUE_VESLO_SERVER_TOKEN: sessionQueueRuntimeFixture.vesloServerToken,
        E2E_SESSION_QUEUE_VESLO_WORKSPACE_ID: sessionQueueRuntimeFixture.vesloWorkspaceId,
        VESLO_DEV_SERVER_URL: sessionQueueRuntimeFixture.vesloServerBaseUrl,
        VESLO_DEV_SERVER_TOKEN: sessionQueueRuntimeFixture.vesloServerToken,
        ...(selectionPlanHasEnvironmentMutation(
          selectionPlan,
          'E2E_SESSION_RUNTIME_REQUIRE_EXPLICIT_ACTIVATION',
          'set',
        )
          ? { E2E_SESSION_RUNTIME_REQUIRE_EXPLICIT_ACTIVATION: '1' }
          : {}),
        VESLO_E2E_DEN_AUTH_JSON: '{}',
        VESLO_DISABLE_DEV_AUTOSTART: '1',
      });
      console.log(`[e2e] Session queue runtime fixture: ${sessionQueueRuntimeFixture.baseUrl}`);
      runContext.record('fixture.started', { fixture: 'session-queue-runtime' });
    }

    if (usesPackagedSmokeFixture) {
      runContext.record('fixture.starting', { fixture: 'packaged-smoke-model' });
      packagedSmokeModelFixture = await startPackagedSmokeModelFixture();
      restorePackagedSmokeFixtureEnvironment = setEnvironmentForFixture({
        E2E_PACKAGED_SMOKE_MODEL_BASE_URL: packagedSmokeModelFixture.baseUrl,
        E2E_PACKAGED_SMOKE_MODEL_ID: packagedSmokeModelFixture.modelId,
        VESLO_E2E_DEN_AUTH_JSON: '',
        E2E_DEN_AUTH_JSON: '',
        VESLO_E2E_DEN_AUTH_SNAPSHOT_FILE: '',
        E2E_DEN_AUTH_SNAPSHOT_FILE: '',
        VESLO_DEN_AUTH_SNAPSHOT_PATH: '',
      });
      console.log('[e2e] Packaged smoke model fixture started on loopback.');
      runContext.record('fixture.started', { fixture: 'packaged-smoke-model' });
    }

    const queueRuntimeFixtureForLaunch = sessionQueueRuntimeFixture;
    runContext.record('app.launch.starting');
    await startApp({
      pilotDiagnostics: pilotRunLaunchDiagnostics(runContext, 1),
      ...(queueRuntimeFixtureForLaunch
        ? {
            beforeLaunch: async ({ profileRoot, opencodeHome }) => {
            if (!profileRoot || !opencodeHome) {
              throw new Error('Session queue fixture requires the isolated E2E profile and OPENCODE_HOME.');
            }
            await queueRuntimeFixtureForLaunch.startVesloServer({
              workspacePath: join(profileRoot, 'workspaces', 'visual-workspace'),
              dataDir: join(opencodeHome, '.veslo', 'session-queue-server'),
            });
            },
          }
        : {}),
    });
    runContext.record('app.launch.started');
    await ensurePilotReady({ binary, socket, cwd: e2eRoot, timeoutMs });
    runContext.record('pilot.ready');
    await installPilotBrowserPrelude({ binary, socket, cwd: e2eRoot, timeoutMs });
    runContext.record('pilot.browser-prelude.installed');
    if (requiresLiveManagedAiAuth) {
      runContext.record('auth.hydration.starting');
      await verifyPilotDesktopAuthHydration({ binary, socket, cwd: e2eRoot, timeoutMs });
      runContext.record('auth.hydration.verified');
    }
    if (usesPackagedSmokeFixture) {
      try {
        await waitForDesktopBootstrapReady({ timeoutMs: 180_000 });
      } catch (error) {
        await collectPilotFailureDiagnostics({
          binary,
          socket,
          cwd: e2eRoot,
          e2eRoot,
          scenario: scenarios[0],
          outputDir: join(runContext.scenarioDir(scenarios[0]), 'failure'),
          error,
          timeoutMs,
        });
        throw error;
      }
    }
    for (const scenario of scenarios) {
      console.log(redactPilotDiagnosticText(`[e2e] Running tauri-pilot scenario: ${scenario}`));
      runContext.record('scenario.starting', { scenario: sanitizePilotArtifactName(scenario) });
      try {
        const scenarioOutputDir = await runPilotScenarioWithArtifacts({
          binary,
          socket,
          cwd: e2eRoot,
          scenario,
          timeoutMs: scenarioCommandTimeoutMs,
          runContext,
        });
        if (isCanonicalLiveInferenceSuite) {
          await collectLiveInferenceSuccessDiagnostics({
            binary,
            socket,
            cwd: e2eRoot,
            e2eRoot,
            scenario,
            outputDir: join(scenarioOutputDir, 'success'),
            logDir: runContext.traceDir,
            appLogDir: runContext.appLogDir,
            timeoutMs,
          });
        }
        if (scenario.replaceAll('\\', '/').endsWith('/pilot-scenarios/session-render-stability.toml')) {
          await collectSessionRenderSuccessArtifacts({
            binary,
            socket,
            cwd: e2eRoot,
            e2eRoot,
            outputDir: join(scenarioOutputDir, 'success'),
            timeoutMs,
          });
        }
        runContext.record('scenario.passed', { scenario: sanitizePilotArtifactName(scenario) });
      } catch (error) {
        runContext.record('scenario.failed', {
          scenario: sanitizePilotArtifactName(scenario),
          reason: safePilotRunFailureReason(error),
        });
        await collectPilotFailureDiagnostics({
          binary,
          socket,
          cwd: e2eRoot,
          e2eRoot,
          scenario,
          outputDir: join(runContext.scenarioDir(scenario), 'failure'),
          error,
          timeoutMs,
        });
        throw error;
      }
      if (selectionPlan.launch.relaunch === 'vslo-270') {
        const reconnectScenario = join(e2eRoot, 'pilot-scenarios', 'vslo-270-relaunch-reconnect.toml');
        if (!existsSync(reconnectScenario)) {
          throw new Error(`tauri-pilot scenario not found: ${reconnectScenario}`);
        }
        console.log('[e2e] Restarting app for VSLO-270 relaunch reconnect check...');
        runContext.record('app.relaunch.starting');
        await stopApp();
        await startApp({
          preserveIsolatedProfile: true,
          pilotDiagnostics: pilotRunLaunchDiagnostics(runContext, 2),
        });
        await ensurePilotReady({ binary, socket, cwd: e2eRoot, timeoutMs });
        await installPilotBrowserPrelude({ binary, socket, cwd: e2eRoot, timeoutMs });
        runContext.record('app.relaunch.ready');
        runContext.record('pilot.browser-prelude.installed', { launch: 'relaunch' });
        console.log(redactPilotDiagnosticText(`[e2e] Running tauri-pilot scenario: ${reconnectScenario}`));
        runContext.record('scenario.starting', { scenario: sanitizePilotArtifactName(reconnectScenario) });
        try {
          await runPilotScenarioWithArtifacts({
            binary,
            socket,
            cwd: e2eRoot,
            scenario: reconnectScenario,
            timeoutMs: scenarioCommandTimeoutMs,
            runContext,
          });
          runContext.record('scenario.passed', { scenario: sanitizePilotArtifactName(reconnectScenario) });
        } catch (error) {
          runContext.record('scenario.failed', {
            scenario: sanitizePilotArtifactName(reconnectScenario),
            reason: safePilotRunFailureReason(error),
          });
          await collectPilotFailureDiagnostics({
            binary,
            socket,
            cwd: e2eRoot,
            e2eRoot,
            scenario: reconnectScenario,
            outputDir: join(runContext.scenarioDir(reconnectScenario), 'failure'),
            error,
            timeoutMs,
          });
          throw error;
        }
      }
    }
    runCompleted = true;
  } catch (error) {
    failureReason = safePilotRunFailureReason(error);
    runContext.record('run.failed', { reason: failureReason });
    throw error;
  } finally {
    stopRunHeartbeat();
    try {
      await stopApp();
      await stopPortContentionFixture(portContentionFixture);
      await sessionQueueRuntimeFixture?.stop();
      await packagedSmokeModelFixture?.stop();
      restoreSessionQueueFixtureEnvironment?.();
      restorePackagedSmokeFixtureEnvironment?.();
      restoreCanonicalLiveInferenceEnvironment?.();
      restoreLiveParityRuntimePreferencesEnvironment?.();
      restoreManagedAiFixtureEnvironment?.();
    } catch (error) {
      if (!failureReason) {
        failureReason = safePilotRunFailureReason(error);
        runContext.record('cleanup.failed', { reason: failureReason });
      }
      throw error;
    } finally {
      runContext.finish(runCompleted && !failureReason ? 'passed' : 'failed', {
        reason: failureReason,
      });
      try {
        prunePilotRunHistory({
          rootDir: runRoot,
          warn: (message) => console.warn(message),
        });
      } catch (error) {
        console.warn(`[e2e] Could not prune Pilot run history: ${safePilotRunFailureReason(error)}`);
      }
    }
  }
}

export function parsePilotRunnerArgs(argv: string[]): ResolvePilotScenarioSelectionOptions {
  const scenario: string[] = [];
  let suite: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scenario' || arg === '-s') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a scenario name or path`);
      scenario.push(value);
      index += 1;
    } else if (arg.startsWith('--scenario=')) {
      scenario.push(arg.slice('--scenario='.length));
    } else if (arg === '--suite') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a suite name`);
      suite = value;
      index += 1;
    } else if (arg.startsWith('--suite=')) {
      suite = arg.slice('--suite='.length);
    }
  }
  return { scenario, suite };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === __filename) {
  runPilotScenarios(parsePilotRunnerArgs(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
