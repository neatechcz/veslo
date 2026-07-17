import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SESSION_QUEUE_VESLO_SERVER_TOKEN = 'session-queue-e2e-server-token';
const SESSION_QUEUE_VESLO_WORKSPACE_ID = 'session-queue-e2e-workspace';

type LifecycleStatus = 'running' | 'completed' | 'failed' | 'aborted';

type FixtureRun = {
  workspaceId: string;
  conversationId: string;
  runId: string;
  engineSessionId: string;
  clientMessageId: string | null;
  origin: string | null;
  status: LifecycleStatus;
  error: string | null;
  createdAt: number;
};

export type SessionQueueFixtureSession = {
  id: string;
  title: string;
  directory: string;
  parentID: null;
  time: { created: number; updated: number };
};

export type SessionQueueFixtureTranscript = {
  messages: unknown[];
  partsByMessageId: Record<string, unknown[]>;
};

type FixtureSession = SessionQueueFixtureSession;
type FixtureTranscript = SessionQueueFixtureTranscript;

type FixtureState = {
  sessions: Map<string, FixtureSession>;
  transcripts: Map<string, FixtureTranscript>;
  workspacePath: string | null;
  runs: Map<string, FixtureRun>;
  eventStreams: Set<ServerResponse>;
  emittedEventCount: number;
  runStatusReads: number;
  promptCalls: number;
  failedPromptCalls: number;
  failNextPromptCalls: number;
};

export type SessionQueueRuntimeFixture = {
  baseUrl: string;
  lifecycleToken: string;
  vesloServerBaseUrl: string;
  vesloServerToken: string;
  vesloWorkspaceId: string;
  startVesloServer: (options: StartSessionQueueVesloServerOptions) => Promise<void>;
  stop: () => Promise<void>;
};

export type StartSessionQueueVesloServerOptions = {
  workspacePath: string;
  dataDir: string;
};

type SessionQueueVesloServer = {
  child: ChildProcess;
  stop: () => Promise<void>;
};

const ACTIVE_STATUSES = new Set<LifecycleStatus>(['running']);
const normalized = (value: unknown) => typeof value === 'string' ? value.trim() : '';

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  const parsed = JSON.parse(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
};

const sendJson = (response: ServerResponse, status: number, payload: unknown) => {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization, x-veslo-orchestrator-token',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
};

const lifecyclePayload = (run: FixtureRun) => ({
  runId: run.runId,
  status: run.status,
  stale: false,
  clientMessageId: run.clientMessageId,
  origin: run.origin,
  error: run.error,
  activityKind: run.status === 'running' ? 'unknown' : 'idle',
  waitReason: run.status === 'running' ? 'assistant_message_open' : 'session_idle',
  lastUsefulProgressAt: run.createdAt,
  noProgressSeconds: 0,
});

const fixtureStatePayload = (state: FixtureState) => ({
  promptCalls: state.promptCalls,
  failedPromptCalls: state.failedPromptCalls,
  failNextPromptCalls: state.failNextPromptCalls,
  sseSubscriberCount: state.eventStreams.size,
  emittedEventCount: state.emittedEventCount,
  runStatusReads: state.runStatusReads,
  runs: [...state.runs.values()].map((run) => ({
    workspaceId: run.workspaceId,
    conversationId: run.conversationId,
    runId: run.runId,
    engineSessionId: run.engineSessionId,
    clientMessageId: run.clientMessageId,
    status: run.status,
  })),
});

const emitFixtureEvent = (state: FixtureState, event: unknown) => {
  state.emittedEventCount += 1;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of state.eventStreams) {
    if (response.writableEnded || response.destroyed) {
      state.eventStreams.delete(response);
      continue;
    }
    response.write(payload);
  }
};

const activeRunForConversation = (state: FixtureState, workspaceId: string, conversationId: string) =>
  [...state.runs.values()]
    .filter((run) => run.workspaceId === workspaceId && run.conversationId === conversationId)
    .filter((run) => ACTIVE_STATUSES.has(run.status))
    .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;

const latestRunForConversation = (state: FixtureState, workspaceId: string, conversationId: string) =>
  [...state.runs.values()]
    .filter((run) => run.workspaceId === workspaceId && run.conversationId === conversationId)
    .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;

const findRunById = (state: FixtureState, workspaceId: string, runId: string) => {
  const run = state.runs.get(runId) ?? null;
  return run?.workspaceId === workspaceId ? run : null;
};

const transcriptMessageId = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? normalized((value as Record<string, unknown>).id)
    : '';

const transcriptPartId = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? normalized((value as Record<string, unknown>).id)
    : '';

const transcriptRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const fixtureOpenCodeDatabasePath = (workspacePath: string) =>
  join(workspacePath, '.opencode', 'opencode.db');

const fixtureOpenCodeSchema = `
  CREATE TABLE IF NOT EXISTS session (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    directory TEXT NOT NULL,
    parent_id TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS part (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    session_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
`;

function ensureFixtureOpenCodeDatabase(workspacePath: string): string {
  const databasePath = fixtureOpenCodeDatabasePath(workspacePath);
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(fixtureOpenCodeSchema);
    return databasePath;
  } finally {
    database.close();
  }
}

export function materializeSessionQueueFixtureTranscript(
  workspacePath: string,
  session: SessionQueueFixtureSession,
  transcript: SessionQueueFixtureTranscript | undefined,
): string {
  const databasePath = ensureFixtureOpenCodeDatabase(workspacePath);
  const database = new DatabaseSync(databasePath);
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    database.prepare(`
      INSERT INTO session (id, title, directory, parent_id, time_created, time_updated)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        directory = excluded.directory,
        parent_id = excluded.parent_id,
        time_created = excluded.time_created,
        time_updated = excluded.time_updated
    `).run(
      session.id,
      session.title,
      session.directory,
      session.parentID,
      session.time.created,
      session.time.updated,
    );

    const upsertMessage = database.prepare(`
      INSERT INTO message (id, session_id, data)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        data = excluded.data
    `);
    const upsertPart = database.prepare(`
      INSERT INTO part (id, message_id, session_id, data)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        message_id = excluded.message_id,
        session_id = excluded.session_id,
        data = excluded.data
    `);
    for (const message of transcript?.messages ?? []) {
      const id = transcriptMessageId(message);
      const record = transcriptRecord(message);
      if (!id || !record) continue;
      upsertMessage.run(id, session.id, JSON.stringify(record));
    }
    for (const [messageId, parts] of Object.entries(transcript?.partsByMessageId ?? {})) {
      const normalizedMessageId = messageId.trim();
      if (!normalizedMessageId || !Array.isArray(parts)) continue;
      for (const part of parts) {
        const id = transcriptPartId(part);
        const record = transcriptRecord(part);
        if (!id || !record) continue;
        upsertPart.run(id, normalizedMessageId, session.id, JSON.stringify(record));
      }
    }
    database.exec('COMMIT');
    transactionStarted = false;
    return databasePath;
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the materialization error; the connection will close below.
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function materializeFixtureSession(state: FixtureState, sessionId: string): string | null {
  const workspacePath = state.workspacePath;
  const session = state.sessions.get(sessionId);
  if (!workspacePath || !session) return null;
  return materializeSessionQueueFixtureTranscript(workspacePath, session, state.transcripts.get(sessionId));
}

function materializeFixtureState(state: FixtureState): string | null {
  let databasePath: string | null = null;
  for (const sessionId of state.sessions.keys()) {
    databasePath = materializeFixtureSession(state, sessionId) ?? databasePath;
  }
  return databasePath;
}

const appendFixtureTranscript = (state: FixtureState, sessionId: string, input: Record<string, unknown>) => {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const suppliedParts = input.partsByMessageId;
  const partsByMessageId = suppliedParts && typeof suppliedParts === 'object' && !Array.isArray(suppliedParts)
    ? suppliedParts as Record<string, unknown>
    : {};
  const current = state.transcripts.get(sessionId) ?? { messages: [], partsByMessageId: {} };
  const messageIds = new Set(messages.map(transcriptMessageId).filter(Boolean));
  const mergedMessages = [
    ...current.messages.filter((message) => !messageIds.has(transcriptMessageId(message))),
    ...messages,
  ];
  const mergedParts = { ...current.partsByMessageId };
  for (const [messageId, parts] of Object.entries(partsByMessageId)) {
    const id = messageId.trim();
    if (!id || !Array.isArray(parts)) continue;
    mergedParts[id] = parts;
  }
  const transcript = { messages: mergedMessages, partsByMessageId: mergedParts };
  state.transcripts.set(sessionId, transcript);
  materializeFixtureSession(state, sessionId);
  return transcript;
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Session queue fixture did not receive a loopback port.');
  return address.port;
}

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return port;
}

function resolveVesloServerBinaryPath(): string {
  const binary = process.platform === 'win32' ? 'veslo-server.exe' : 'veslo-server';
  return resolve(__dirname, '..', '..', 'server', 'dist', 'bin', binary);
}

function appendBounded(previous: string, chunk: Buffer, limit = 8_000): string {
  return `${previous}${chunk.toString('utf8')}`.slice(-limit);
}

async function waitForVesloServerReady(baseUrl: string, child: ChildProcess, stderr: () => string): Promise<void> {
  let lastError = 'health endpoint did not respond';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Session queue Veslo server exited before readiness: ${stderr().trim() || 'no stderr'}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(150);
  }
  throw new Error(`Session queue Veslo server did not become ready: ${lastError}; ${stderr().trim() || 'no stderr'}`);
}

async function stopVesloServerChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill();
  await Promise.race([
    exited,
    sleep(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }),
  ]);
}

export async function startSessionQueueRuntimeFixture(): Promise<SessionQueueRuntimeFixture> {
  const state: FixtureState = {
    sessions: new Map(),
    transcripts: new Map(),
    workspacePath: null,
    runs: new Map(),
    eventStreams: new Set(),
    emittedEventCount: 0,
    runStatusReads: 0,
    promptCalls: 0,
    failedPromptCalls: 0,
    failNextPromptCalls: 0,
  };
  const lifecycleToken = 'session-queue-fixture-token';
  const vesloServerPort = await reserveLoopbackPort();
  const vesloServerBaseUrl = `http://127.0.0.1:${vesloServerPort}`;
  let vesloServer: SessionQueueVesloServer | null = null;
  let lastVesloServerOptions: StartSessionQueueVesloServerOptions | null = null;

  const startVesloServer = async (options: StartSessionQueueVesloServerOptions) => {
    if (vesloServer) return;
    const binaryPath = resolveVesloServerBinaryPath();
    if (!existsSync(binaryPath)) {
      throw new Error(`Session queue Veslo server binary is missing: ${binaryPath}`);
    }
    mkdirSync(options.workspacePath, { recursive: true });
    mkdirSync(options.dataDir, { recursive: true });
    state.workspacePath = options.workspacePath;
    const openCodeDatabasePath = ensureFixtureOpenCodeDatabase(options.workspacePath);
    materializeFixtureState(state);
    const secretsPath = join(options.dataDir, 'session-queue-secrets.json');
    writeFileSync(secretsPath, JSON.stringify({
      clientToken: SESSION_QUEUE_VESLO_SERVER_TOKEN,
      hostToken: 'session-queue-e2e-host-token',
      orchestratorLifecycleToken: lifecycleToken,
    }), 'utf8');
    let stderr = '';
    const child = spawn(binaryPath, [
      '--host', '127.0.0.1',
      '--port', String(vesloServerPort),
      '--approval', 'auto',
      '--workspace', options.workspacePath,
      '--workspace-id', SESSION_QUEUE_VESLO_WORKSPACE_ID,
      '--opencode-base-url', `http://127.0.0.1:${port}`,
      '--opencode-directory', options.workspacePath,
      '--orchestrator-url', `http://127.0.0.1:${port}`,
      '--orchestrator-lifecycle-token', lifecycleToken,
      '--cors', '*',
    ], {
      env: {
        ...process.env,
        VESLO_DATA_DIR: options.dataDir,
        VESLO_SECRETS_FILE: secretsPath,
        VESLO_OPENCODE_DB_PATH: openCodeDatabasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk);
    });
    try {
      await waitForVesloServerReady(vesloServerBaseUrl, child, () => stderr);
    } catch (error) {
      await stopVesloServerChild(child);
      throw error;
    }
    lastVesloServerOptions = options;
    vesloServer = {
      child,
      stop: () => stopVesloServerChild(child),
    };
  };

  const restartVesloServer = async () => {
    if (!vesloServer || !lastVesloServerOptions) {
      throw new Error('Session queue Veslo server was not started by the harness.');
    }
    const previous = vesloServer;
    vesloServer = null;
    await previous.stop();
    await startVesloServer(lastVesloServerOptions);
  };

  const server = createServer(async (request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (method === 'OPTIONS') {
      sendJson(response, 204, null);
      return;
    }
    if (url.pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (method === 'GET' && url.pathname.endsWith('/global/health')) {
      sendJson(response, 200, { healthy: true });
      return;
    }
    if (method === 'GET' && url.pathname.endsWith('/event')) {
      response.writeHead(200, {
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
      });
      response.write(': session queue fixture connected\n\n');
      state.eventStreams.add(response);
      request.once('close', () => state.eventStreams.delete(response));
      return;
    }
    if (url.pathname === '/__session_queue_fixture/state' && method === 'GET') {
      sendJson(response, 200, fixtureStatePayload(state));
      return;
    }
    if (url.pathname === '/__session_queue_fixture/release' && method === 'POST') {
      for (const run of state.runs.values()) {
        if (ACTIVE_STATUSES.has(run.status)) run.status = 'aborted';
      }
      sendJson(response, 200, fixtureStatePayload(state));
      return;
    }
    if (url.pathname === '/__session_queue_fixture/fail-next-prompt' && method === 'POST') {
      const body = await readJson(request);
      const count = Number(body.count);
      state.failNextPromptCalls = Number.isInteger(count) && count > 0 ? count : 1;
      sendJson(response, 200, fixtureStatePayload(state));
      return;
    }
    if (url.pathname === '/__session_queue_fixture/emit-session-error' && method === 'POST') {
      const body = await readJson(request);
      const sessionId = normalized(body.sessionId);
      const message = normalized(body.message) || 'Session queue fixture emitted session.error.';
      if (!sessionId) {
        sendJson(response, 400, { error: 'session_id_required' });
        return;
      }
      emitFixtureEvent(state, {
        type: 'session.error',
        properties: { sessionID: sessionId, error: { name: 'FixtureSessionError', message } },
      });
      sendJson(response, 200, fixtureStatePayload(state));
      return;
    }
    if (url.pathname === '/__session_queue_fixture/emit-session-idle' && method === 'POST') {
      const body = await readJson(request);
      const sessionId = normalized(body.sessionId);
      if (!sessionId) {
        sendJson(response, 400, { error: 'session_id_required' });
        return;
      }
      emitFixtureEvent(state, { type: 'session.idle', properties: { sessionID: sessionId } });
      sendJson(response, 200, fixtureStatePayload(state));
      return;
    }
    if (url.pathname === '/__session_queue_fixture/emit-operational-error' && method === 'POST') {
      const body = await readJson(request);
      const message = normalized(body.message) || 'Session queue fixture emitted an unrelated operational error.';
      emitFixtureEvent(state, {
        type: 'session.error',
        properties: { error: { name: 'FixtureOperationalError', message } },
      });
      sendJson(response, 200, fixtureStatePayload(state));
      return;
    }
    if (url.pathname === '/__session_queue_fixture/emit-session-created' && method === 'POST') {
      const body = await readJson(request);
      const sessionId = normalized(body.sessionId);
      const session = state.sessions.get(sessionId);
      if (!session) {
        sendJson(response, 404, { error: 'session_not_found' });
        return;
      }
      emitFixtureEvent(state, { type: 'session.created', properties: { info: session } });
      sendJson(response, 200, fixtureStatePayload(state));
      return;
    }
    if (url.pathname === '/__session_queue_fixture/append-session-transcript' && method === 'POST') {
      const body = await readJson(request);
      const sessionId = normalized(body.sessionId);
      if (!sessionId || !state.sessions.has(sessionId)) {
        sendJson(response, 404, { error: 'session_not_found' });
        return;
      }
      sendJson(response, 200, appendFixtureTranscript(state, sessionId, body));
      return;
    }
    if (url.pathname === '/__session_queue_fixture/restart-veslo-server' && method === 'POST') {
      try {
        await restartVesloServer();
        sendJson(response, 200, { ok: true });
      } catch (error) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === 'POST' && url.pathname === '/session') {
      const body = await readJson(request);
      const id = normalized(body.id) || `ses_fixture_${state.sessions.size + 1}`;
      const existing = state.sessions.get(id);
      const session = existing ?? {
        id,
        title: normalized(body.title) || id,
        directory: normalized(body.directory) || '/fixture/workspace',
        parentID: null,
        time: { created: Date.now(), updated: Date.now() },
      };
      state.sessions.set(id, session);
      materializeFixtureSession(state, id);
      sendJson(response, 200, session);
      return;
    }
    if (method === 'GET' && url.pathname === '/session') {
      sendJson(response, 200, [...state.sessions.values()]);
      return;
    }
    if (segments[0] === 'session' && segments.length >= 2) {
      const sessionId = segments[1] ?? '';
      if (method === 'GET' && segments.length === 2) {
        const session = state.sessions.get(sessionId);
        if (!session) {
          sendJson(response, 404, { error: 'session_not_found' });
          return;
        }
        sendJson(response, 200, session);
        return;
      }
      if (method === 'GET' && segments[2] === 'message' && segments.length === 3) {
        const transcript = state.transcripts.get(sessionId);
        sendJson(response, 200, (transcript?.messages ?? []).map((info) => ({
          info,
          parts: transcript?.partsByMessageId[transcriptMessageId(info)] ?? [],
        })));
        return;
      }
      if (method === 'GET' && segments[2] === 'message' && segments[4] === 'part') {
        const messageId = segments[3] ?? '';
        sendJson(response, 200, state.transcripts.get(sessionId)?.partsByMessageId[messageId] ?? []);
        return;
      }
      if (method === 'POST' && segments[2] === 'abort') {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (method === 'POST' && segments[2] === 'prompt_async') {
        state.promptCalls += 1;
        if (state.failNextPromptCalls > 0) {
          state.failNextPromptCalls -= 1;
          state.failedPromptCalls += 1;
          sendJson(response, 500, { error: 'session queue fixture delivery failed' });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }
    }
    if (segments[0] === 'workspace' && segments[2] === 'runs' && method === 'POST' && segments[3] === 'register') {
      const workspaceId = segments[1] ?? '';
      const body = await readJson(request);
      const conversationId = normalized(body.conversationId);
      const current = activeRunForConversation(state, workspaceId, conversationId);
      if (current) {
        sendJson(response, 409, { activeRunId: current.runId });
        return;
      }
      const runId = normalized(body.runId);
      const created: FixtureRun = {
        workspaceId,
        conversationId,
        runId,
        engineSessionId: normalized(body.engineSessionId),
        clientMessageId: normalized(body.clientMessageId) || null,
        origin: normalized(body.origin) || null,
        status: 'running',
        error: null,
        createdAt: Date.now(),
      };
      state.runs.set(runId, created);
      sendJson(response, 200, lifecyclePayload(created));
      return;
    }
    if (segments[0] === 'workspace' && segments[2] === 'runs' && method === 'POST' && segments.length >= 5) {
      const workspaceId = segments[1] ?? '';
      const run = findRunById(state, workspaceId, segments[3] ?? '');
      if (!run) {
        sendJson(response, 404, { error: 'run_not_found' });
        return;
      }
      const action = segments[4];
      if (action === 'failed') {
        run.status = 'failed';
        run.error = normalized((await readJson(request)).error) || 'Session queue fixture run failed.';
      }
      if (action === 'completed') run.status = 'completed';
      if (action === 'aborted') run.status = 'aborted';
      sendJson(response, 200, lifecyclePayload(run));
      return;
    }
    if (segments[0] === 'workspace' && segments[2] === 'conversations' && segments[4] === 'runs' && method === 'GET') {
      state.runStatusReads += 1;
      const workspaceId = segments[1] ?? '';
      const conversationId = segments[3] ?? '';
      const requestedRunId = segments[5] ?? '';
      const run = requestedRunId === 'active'
        ? activeRunForConversation(state, workspaceId, conversationId)
        : requestedRunId === 'latest'
          ? latestRunForConversation(state, workspaceId, conversationId)
          : findRunById(state, workspaceId, requestedRunId);
      if (!run) {
        sendJson(response, 404, { error: 'run_not_found' });
        return;
      }
      sendJson(response, 200, lifecyclePayload(run));
      return;
    }

    sendJson(response, 404, { error: 'session_queue_fixture_route_not_found', path: url.pathname, method });
  });

  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    lifecycleToken,
    vesloServerBaseUrl,
    vesloServerToken: SESSION_QUEUE_VESLO_SERVER_TOKEN,
    vesloWorkspaceId: SESSION_QUEUE_VESLO_WORKSPACE_ID,
    startVesloServer,
    stop: async () => {
      if (vesloServer) {
        const runningServer = vesloServer;
        vesloServer = null;
        await runningServer.stop();
      }
      await new Promise<void>((resolveStop, rejectStop) => {
        server.close((error) => error ? rejectStop(error) : resolveStop());
      });
    },
  };
}
