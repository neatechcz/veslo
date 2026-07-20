import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname as localHostname } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PILOT_RUN_SCHEMA = 'veslo-tauri-pilot-run/v1';
export const PILOT_RUN_EVENT_SCHEMA = 'veslo-tauri-pilot-run-event/v1';
export const PILOT_RUN_MANIFEST_FILE = 'run.json';
export const PILOT_RUNS_DIRNAME = '.pilot-runs';
export const DEFAULT_PILOT_RUN_KEEP_TERMINAL = 10;
export const DEFAULT_PILOT_RUN_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_PILOT_RUN_STALE_AFTER_MS = 120_000;

export type PilotRunStatus = 'running' | 'passed' | 'failed' | 'abandoned';
export type PilotRunTerminalStatus = Exclude<PilotRunStatus, 'running'>;
export type PilotRunEventValue = string | number | boolean | null | PilotRunEventValue[] | {
  readonly [key: string]: PilotRunEventValue;
};

export type PilotRunOwner = {
  hostname: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
};

export type PilotRunMetadata = {
  suite: string | null;
  scenarios: string[];
  binary: string | null;
  profileMode: string | null;
  authMode: string | null;
  fixtures: string[];
};

export type PilotRunManifest = {
  schema: typeof PILOT_RUN_SCHEMA;
  runId: string;
  status: PilotRunStatus;
  startedAt: string;
  finishedAt: string | null;
  abandonedAt: string | null;
  abandonmentReason: string | null;
  owner: PilotRunOwner;
  metadata: PilotRunMetadata;
};

export type CreatePilotRunContextOptions = {
  rootDir: string;
  suite?: string | null;
  scenarios: readonly string[];
  binary?: string | null;
  profileMode?: string | null;
  authMode?: string | null;
  fixtures?: readonly string[];
  runId?: string;
  pid?: number;
  hostname?: string;
  now?: () => Date;
  randomId?: () => string;
};

export type PilotRunFinish = {
  reason?: string | null;
};

export type PilotRunContext = {
  runId: string;
  runDir: string;
  traceDir: string;
  appLogDir: string;
  scenariosDir: string;
  scenarioDir(name: string): string;
  record(event: string, payload?: Record<string, PilotRunEventValue>): void;
  heartbeat(): void;
  startHeartbeat(intervalMs?: number): () => void;
  finish(status: Extract<PilotRunStatus, 'passed' | 'failed'>, details?: PilotRunFinish): void;
  manifest(): PilotRunManifest;
};

export type ReconcileAbandonedPilotRunsOptions = {
  rootDir: string;
  activeRunId?: string | null;
  now?: Date;
  hostname?: string;
  staleAfterMs?: number;
  isOwnerProcessAlive?: (pid: number) => boolean;
  warn?: (message: string) => void;
};

export type ReconcileAbandonedPilotRunsResult = {
  abandonedRunIds: string[];
  retainedRunningRunIds: string[];
  skippedInvalidDirectories: string[];
};

export type PrunePilotRunHistoryOptions = ReconcileAbandonedPilotRunsOptions & {
  keepTerminal?: number;
};

export type PrunePilotRunHistoryResult = {
  reconciliation: ReconcileAbandonedPilotRunsResult;
  removedRunIds: string[];
  retainedRunIds: string[];
  skippedInvalidDirectories: string[];
};

type DiscoveredPilotRun = {
  runDir: string;
  manifest: PilotRunManifest;
};

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

function normalizeStringArray(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function isPilotRunStatus(value: unknown): value is PilotRunStatus {
  return value === 'running' || value === 'passed' || value === 'failed' || value === 'abandoned';
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isValidOwner(value: unknown): value is PilotRunOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.hostname === 'string' && candidate.hostname.trim().length > 0 &&
    Number.isInteger(candidate.pid) && Number(candidate.pid) > 0 &&
    isIsoDate(candidate.startedAt) && isIsoDate(candidate.heartbeatAt);
}

function isValidMetadata(value: unknown): value is PilotRunMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.suite === null || typeof candidate.suite === 'string') &&
    Array.isArray(candidate.scenarios) && candidate.scenarios.every((item) => typeof item === 'string') &&
    (candidate.binary === null || typeof candidate.binary === 'string') &&
    (candidate.profileMode === null || typeof candidate.profileMode === 'string') &&
    (candidate.authMode === null || typeof candidate.authMode === 'string') &&
    Array.isArray(candidate.fixtures) && candidate.fixtures.every((item) => typeof item === 'string');
}

function isPilotRunManifest(value: unknown): value is PilotRunManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schema === PILOT_RUN_SCHEMA &&
    typeof candidate.runId === 'string' && candidate.runId.trim().length > 0 &&
    isPilotRunStatus(candidate.status) &&
    isIsoDate(candidate.startedAt) &&
    (candidate.finishedAt === null || isIsoDate(candidate.finishedAt)) &&
    (candidate.abandonedAt === null || isIsoDate(candidate.abandonedAt)) &&
    (candidate.abandonmentReason === null || typeof candidate.abandonmentReason === 'string') &&
    isValidOwner(candidate.owner) &&
    isValidMetadata(candidate.metadata);
}

function cloneManifest(manifest: PilotRunManifest): PilotRunManifest {
  return JSON.parse(JSON.stringify(manifest)) as PilotRunManifest;
}

function manifestPath(runDir: string): string {
  return join(runDir, PILOT_RUN_MANIFEST_FILE);
}

function writeManifestAtomic(runDir: string, manifest: PilotRunManifest): void {
  const target = manifestPath(runDir);
  const temporary = join(runDir, `.${PILOT_RUN_MANIFEST_FILE}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(temporary, target);
}

function sanitizeRunSegment(value: string): string {
  const base = basename(value.replaceAll('\\', '/')).replace(/\.toml$/i, '');
  const safe = base
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
  return safe || 'pilot';
}

function buildRunId(options: CreatePilotRunContextOptions, now: Date): string {
  const explicit = options.runId?.trim();
  if (explicit) {
    const safe = explicit.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 128);
    if (!safe) throw new Error('Pilot runId must contain at least one filesystem-safe character.');
    return safe;
  }

  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const label = sanitizeRunSegment(options.suite ?? options.scenarios[0] ?? 'pilot');
  const suffix = (options.randomId?.() ?? randomUUID()).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'run';
  return `${stamp}-${label}-${suffix}`;
}

function isPathInside(rootDir: string, candidate: string): boolean {
  const root = resolve(rootDir);
  const target = resolve(candidate);
  const pathRelative = relative(root, target);
  return pathRelative.length > 0 && pathRelative !== '..' && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative);
}

function defaultIsOwnerProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== 'ESRCH';
  }
}

function terminalTimestamp(manifest: PilotRunManifest, runDir: string): number {
  // A stale run can be discovered much later than it stopped. Retention must
  // order it by the last proof of life, not by the newer reconciliation time.
  const timestamp = manifest.status === 'abandoned'
    ? manifest.owner.heartbeatAt || manifest.startedAt
    : manifest.finishedAt ?? manifest.startedAt;
  const parsed = Date.parse(timestamp);
  if (Number.isFinite(parsed)) return parsed;
  try {
    return statSync(runDir).mtimeMs;
  } catch {
    return 0;
  }
}

function warnWith(options: { warn?: (message: string) => void }, message: string): void {
  (options.warn ?? console.warn)(`[e2e] ${message}`);
}

function discoverPilotRuns(rootDir: string, options: { warn?: (message: string) => void }): {
  runs: DiscoveredPilotRun[];
  skippedInvalidDirectories: string[];
} {
  const root = resolve(rootDir);
  if (!existsSync(root)) return { runs: [], skippedInvalidDirectories: [] };

  const runs: DiscoveredPilotRun[] = [];
  const skippedInvalidDirectories: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = resolve(root, entry.name);
    if (!isPathInside(root, runDir)) {
      skippedInvalidDirectories.push(entry.name);
      warnWith(options, `Skipping Pilot run outside artifact root: ${entry.name}`);
      continue;
    }

    const manifest = readPilotRunManifest(runDir);
    if (!manifest || manifest.runId !== entry.name) {
      skippedInvalidDirectories.push(entry.name);
      warnWith(options, `Skipping Pilot run with an invalid manifest: ${entry.name}`);
      continue;
    }
    runs.push({ runDir, manifest });
  }
  return { runs, skippedInvalidDirectories };
}

export function readPilotRunManifest(runDir: string): PilotRunManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(runDir), 'utf8')) as unknown;
    return isPilotRunManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createPilotRunContext(options: CreatePilotRunContextOptions): PilotRunContext {
  const now = options.now ?? (() => new Date());
  const createdAt = now();
  const rootDir = resolve(options.rootDir);
  const runId = buildRunId(options, createdAt);
  const runDir = resolve(rootDir, runId);
  if (!isPathInside(rootDir, runDir)) {
    throw new Error(`Refusing to create Pilot run outside artifact root: ${runId}`);
  }
  if (existsSync(runDir)) {
    throw new Error(`Pilot run directory already exists: ${runDir}`);
  }

  const traceDir = join(runDir, 'traces');
  const appLogDir = join(runDir, 'app');
  const scenariosDir = join(runDir, 'scenarios');
  const ownerHostname = options.hostname?.trim() || localHostname();
  const ownerPid = options.pid ?? process.pid;
  if (!ownerHostname || !Number.isInteger(ownerPid) || ownerPid < 1) {
    throw new Error('Pilot run owner must have a hostname and positive PID.');
  }
  mkdirSync(traceDir, { recursive: true });
  mkdirSync(appLogDir, { recursive: true });
  mkdirSync(scenariosDir, { recursive: true });

  let currentManifest: PilotRunManifest = {
    schema: PILOT_RUN_SCHEMA,
    runId,
    status: 'running',
    startedAt: createdAt.toISOString(),
    finishedAt: null,
    abandonedAt: null,
    abandonmentReason: null,
    owner: {
      hostname: ownerHostname,
      pid: ownerPid,
      startedAt: createdAt.toISOString(),
      heartbeatAt: createdAt.toISOString(),
    },
    metadata: {
      suite: normalizeOptionalText(options.suite),
      scenarios: normalizeStringArray(options.scenarios),
      binary: normalizeOptionalText(options.binary),
      profileMode: normalizeOptionalText(options.profileMode),
      authMode: normalizeOptionalText(options.authMode),
      fixtures: normalizeStringArray(options.fixtures),
    },
  };
  writeManifestAtomic(runDir, currentManifest);

  const record = (event: string, payload: Record<string, PilotRunEventValue> = {}) => {
    const name = event.trim();
    if (!name) throw new Error('Pilot run event must have a name.');
    appendFileSync(join(runDir, 'runner.ndjson'), `${JSON.stringify({
      schema: PILOT_RUN_EVENT_SCHEMA,
      at: now().toISOString(),
      event: name,
      payload,
    })}\n`, 'utf8');
  };

  const heartbeat = () => {
    if (currentManifest.status !== 'running') return;
    currentManifest = {
      ...currentManifest,
      owner: {
        ...currentManifest.owner,
        heartbeatAt: now().toISOString(),
      },
    };
    writeManifestAtomic(runDir, currentManifest);
  };

  record('run.started', {
    runId,
    suite: currentManifest.metadata.suite,
    scenarios: currentManifest.metadata.scenarios,
  });

  return {
    runId,
    runDir,
    traceDir,
    appLogDir,
    scenariosDir,
    scenarioDir(name: string): string {
      const directory = resolve(scenariosDir, sanitizeRunSegment(name));
      if (!isPathInside(scenariosDir, directory)) {
        throw new Error(`Refusing to create Pilot scenario directory outside run: ${name}`);
      }
      mkdirSync(directory, { recursive: true });
      return directory;
    },
    record,
    heartbeat,
    startHeartbeat(intervalMs = DEFAULT_PILOT_RUN_HEARTBEAT_INTERVAL_MS): () => void {
      if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
        throw new Error(`Pilot run heartbeat interval must be at least 1000ms: ${intervalMs}`);
      }
      const timer = setInterval(heartbeat, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    finish(status, details = {}): void {
      if (currentManifest.status !== 'running') return;
      const finishedAt = now().toISOString();
      currentManifest = {
        ...currentManifest,
        status,
        finishedAt,
      };
      writeManifestAtomic(runDir, currentManifest);
      record('run.finished', {
        status,
        reason: normalizeOptionalText(details.reason),
      });
    },
    manifest: () => cloneManifest(currentManifest),
  };
}

export function reconcileAbandonedPilotRuns(
  options: ReconcileAbandonedPilotRunsOptions,
): ReconcileAbandonedPilotRunsResult {
  const now = options.now ?? new Date();
  const hostname = options.hostname?.trim() || localHostname();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_PILOT_RUN_STALE_AFTER_MS;
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < DEFAULT_PILOT_RUN_HEARTBEAT_INTERVAL_MS) {
    throw new Error(`Pilot run stale timeout must be at least ${DEFAULT_PILOT_RUN_HEARTBEAT_INTERVAL_MS}ms.`);
  }
  const isOwnerProcessAlive = options.isOwnerProcessAlive ?? defaultIsOwnerProcessAlive;
  const discovered = discoverPilotRuns(options.rootDir, options);
  const abandonedRunIds: string[] = [];
  const retainedRunningRunIds: string[] = [];

  for (const run of discovered.runs) {
    const manifest = run.manifest;
    if (manifest.status !== 'running') continue;
    if (manifest.runId === options.activeRunId) {
      retainedRunningRunIds.push(manifest.runId);
      continue;
    }
    if (manifest.owner.hostname !== hostname) {
      retainedRunningRunIds.push(manifest.runId);
      warnWith(options, `Keeping stale-looking Pilot run from another host: ${manifest.runId}`);
      continue;
    }
    const heartbeatAt = Date.parse(manifest.owner.heartbeatAt);
    if (!Number.isFinite(heartbeatAt) || now.getTime() - heartbeatAt <= staleAfterMs) {
      retainedRunningRunIds.push(manifest.runId);
      continue;
    }

    let ownerAlive = true;
    try {
      ownerAlive = isOwnerProcessAlive(manifest.owner.pid);
    } catch {
      retainedRunningRunIds.push(manifest.runId);
      warnWith(options, `Keeping stale-looking Pilot run because owner PID probe failed: ${manifest.runId}`);
      continue;
    }
    if (ownerAlive) {
      retainedRunningRunIds.push(manifest.runId);
      warnWith(options, `Keeping stale-looking Pilot run because owner PID is still alive: ${manifest.runId}`);
      continue;
    }

    const abandonedAt = now.toISOString();
    const abandoned: PilotRunManifest = {
      ...manifest,
      status: 'abandoned',
      finishedAt: abandonedAt,
      abandonedAt,
      abandonmentReason: 'owner-process-not-alive',
    };
    writeManifestAtomic(run.runDir, abandoned);
    appendFileSync(join(run.runDir, 'runner.ndjson'), `${JSON.stringify({
      schema: PILOT_RUN_EVENT_SCHEMA,
      at: abandonedAt,
      event: 'run.abandoned',
      payload: { reason: abandoned.abandonmentReason },
    })}\n`, 'utf8');
    abandonedRunIds.push(manifest.runId);
  }

  return {
    abandonedRunIds,
    retainedRunningRunIds,
    skippedInvalidDirectories: discovered.skippedInvalidDirectories,
  };
}

export function prunePilotRunHistory(options: PrunePilotRunHistoryOptions): PrunePilotRunHistoryResult {
  const keepTerminal = options.keepTerminal ?? DEFAULT_PILOT_RUN_KEEP_TERMINAL;
  if (!Number.isInteger(keepTerminal) || keepTerminal < 0) {
    throw new Error(`Pilot run retention count must be a non-negative integer: ${keepTerminal}`);
  }

  const reconciliation = reconcileAbandonedPilotRuns(options);
  const discovered = discoverPilotRuns(options.rootDir, options);
  const terminalRuns = discovered.runs
    .filter((run) => run.manifest.status !== 'running' && run.manifest.runId !== options.activeRunId)
    .sort((left, right) => terminalTimestamp(right.manifest, right.runDir) - terminalTimestamp(left.manifest, left.runDir));
  const retainedRunIds = terminalRuns.slice(0, keepTerminal).map((run) => run.manifest.runId);
  const removedRunIds: string[] = [];
  const rootDir = resolve(options.rootDir);

  // Remove oldest candidates first. If Windows temporarily holds a file open,
  // a failed deletion cannot cause a newer eligible run to be removed first.
  for (const run of terminalRuns.slice(keepTerminal).reverse()) {
    if (!isPathInside(rootDir, run.runDir)) {
      warnWith(options, `Refusing to prune Pilot run outside artifact root: ${run.manifest.runId}`);
      continue;
    }
    try {
      rmSync(run.runDir, { recursive: true, force: true });
      removedRunIds.push(run.manifest.runId);
    } catch {
      warnWith(options, `Could not prune Pilot run: ${run.manifest.runId}`);
    }
  }

  return {
    reconciliation,
    removedRunIds,
    retainedRunIds,
    skippedInvalidDirectories: [...new Set([
      ...reconciliation.skippedInvalidDirectories,
      ...discovered.skippedInvalidDirectories,
    ])],
  };
}
