import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const E2E_MANAGED_AI_USER_ID = 'user_veslo_e2e_managed_ai';
export const E2E_MANAGED_AI_ORG_ID = 'org_veslo_e2e_managed_ai';
export const E2E_MANAGED_AI_TOKEN = 'veslo-e2e-managed-ai-token';
export const E2E_MANAGED_AI_GATEWAY_ACCESS_TOKEN = 'veslo-e2e-managed-ai-gateway-access-token';

export type ManagedAiGatewayFixtureRequest = {
  at: string;
  method: string;
  pathname: string;
  authorization: string | null;
  sessionId: string | null;
  model: string | null;
  promptText: string | null;
  stream: boolean | null;
};

export type ManagedAiGatewayFixture = {
  baseUrl: string;
  requests: ManagedAiGatewayFixtureRequest[];
  server: Server;
};

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'authorization,content-type,x-veslo-gateway-authorization,x-veslo-gateway-token,x-veslo-session-id,x-veslo-request-id',
  );
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
  }
  return body;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return compactText(value.map(textFromContent).filter(Boolean).join(' '));
  }
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return compactText([
    textFromContent(record.text),
    textFromContent(record.content),
    textFromContent(record.input),
  ].filter(Boolean).join(' '));
}

function extractPromptText(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const messages = Array.isArray(record.messages) ? record.messages : [];
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== 'object') continue;
    const messageRecord = message as Record<string, unknown>;
    if (messageRecord.role && messageRecord.role !== 'user') continue;
    const text = textFromContent(messageRecord.content);
    if (text) return text;
  }
  const fallback = textFromContent(record.input) || textFromContent(record.prompt);
  return fallback || null;
}

function extractToken(promptText: string | null): string {
  const prompt = promptText ?? '';
  return prompt.match(/\b[a-z0-9][a-z0-9_-]*-\d{10,}\b/i)?.[0] ?? 'managed-ai-fixture';
}

function buildChatCompletionResponse(model: string, content: string) {
  return {
    id: `chatcmpl_e2e_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content,
      },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: 8,
      completion_tokens: 8,
      total_tokens: 16,
    },
  };
}

function responseDelayMs(): number {
  const raw = process.env.E2E_MANAGED_AI_RESPONSE_DELAY_MS?.trim() ?? '';
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30000) : 0;
}

async function delayResponseIfRequested(): Promise<void> {
  const delayMs = responseDelayMs();
  if (!delayMs) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function sendChatCompletionStream(res: ServerResponse, model: string, content: string): void {
  setCorsHeaders(res);
  res.statusCode = 200;
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  const id = `chatcmpl_e2e_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  chunk({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  });
  chunk({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  res.end('data: [DONE]\n\n');
}

export async function startManagedAiGatewayFixture(): Promise<ManagedAiGatewayFixture> {
  const requests: ManagedAiGatewayFixtureRequest[] = [];

  const server = createServer(async (req, res) => {
    try {
      setCorsHeaders(res);
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/__e2e/requests') {
        sendJson(res, 200, { requests });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/__e2e/reset') {
        requests.splice(0, requests.length);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/me') {
        sendJson(res, 200, {
          user: { id: E2E_MANAGED_AI_USER_ID, email: 'veslo-managed-ai-e2e@example.test' },
          org: { id: E2E_MANAGED_AI_ORG_ID, slug: 'veslo-managed-ai-e2e' },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/me/ai-access') {
        sendJson(res, 200, {
          accessToken: E2E_MANAGED_AI_GATEWAY_ACCESS_TOKEN,
          aiAccess: {
            id: 'ai_access_veslo_e2e_managed_ai',
            userId: E2E_MANAGED_AI_USER_ID,
            enabled: true,
            provider: 'codex_oauth',
            defaultModel: 'gpt-5.4',
            allowedModels: ['gpt-5.4'],
            updatedAt: new Date(0).toISOString(),
          },
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/providers/codex_oauth/v1/chat/completions') {
        const rawBody = await readBody(req);
        const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
        const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'gpt-5.4';
        const promptText = extractPromptText(body);
        const stream = typeof body.stream === 'boolean' ? body.stream : false;
        requests.push({
          at: new Date().toISOString(),
          method: req.method ?? 'POST',
          pathname: url.pathname,
          authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
          sessionId: typeof req.headers['x-veslo-session-id'] === 'string' ? req.headers['x-veslo-session-id'] : null,
          model,
          promptText,
          stream,
        });

        const content = `Veslo managed AI fixture response for ${extractToken(promptText)}.`;
        await delayResponseIfRequested();
        if (stream) {
          sendChatCompletionStream(res, model, content);
        } else {
          sendJson(res, 200, buildChatCompletionResponse(model, content));
        }
        return;
      }

      sendJson(res, 404, { error: 'not_found', path: url.pathname });
    } catch (error) {
      sendJson(res, 500, {
        error: 'fixture_error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Managed AI gateway fixture did not bind to a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    server,
  };
}

export async function stopManagedAiGatewayFixture(fixture: ManagedAiGatewayFixture | null): Promise<void> {
  if (!fixture) return;
  fixture.server.close();
  await once(fixture.server, 'close');
}
