import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { createAiGatewayTestApp } from '@neatech/ai-gateway/test-support';

export const E2E_MANAGED_AI_USER_ID = 'user_veslo_e2e_managed_ai';
export const E2E_MANAGED_AI_SECOND_USER_ID = 'user_veslo_e2e_managed_ai_second';
export const E2E_MANAGED_AI_ORG_ID = 'org_veslo_e2e_managed_ai';
export const E2E_MANAGED_AI_TOKEN = 'veslo-e2e-managed-ai-token';
export const E2E_MANAGED_AI_SECOND_TOKEN = 'veslo-e2e-managed-ai-second-token';
export const E2E_MANAGED_AI_GATEWAY_ACCESS_TOKEN = 'veslo-e2e-managed-ai-gateway-access-token';

const ACTIVE_MODEL = { provider: 'codex_oauth', model: 'gpt-5.4' } as const;
const ENABLED_MODELS = [
  ACTIVE_MODEL,
  { provider: 'codex_oauth', model: 'gpt-5.3-codex' } as const,
];
const CREDENTIAL_ID = 'cred_veslo_e2e_codex';
const BINDING_ID = 'binding_veslo_e2e_codex';
const FIXTURE_SUPPORTED_CODEX_MODELS = new Set([
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.5',
  'gpt-5.6-sol',
]);

type FixtureModelRef = {
  provider: 'openai' | 'anthropic' | 'codex_oauth' | 'openai_compatible';
  model: string;
};

type FixtureModelCapabilityVerifier = {
  checkHealthyCredentialForModel(model: FixtureModelRef): Promise<
    | { status: 'supported'; credentialId: string }
    | { status: 'unsupported' }
    | { status: 'transient'; reason: string }
  >;
  checkHealthyCredentialsForModels(models: FixtureModelRef[]): Promise<Array<
    | { model: FixtureModelRef; status: 'supported'; credentialId: string }
    | { model: FixtureModelRef; status: 'unsupported'; reason: 'no_healthy_credential' | 'model_unsupported' }
    | { model: FixtureModelRef; status: 'transient'; reason: string }
  >>;
  checkCredentialForModel(credentialId: string, model: FixtureModelRef): Promise<
    | { status: 'supported'; credentialId: string }
    | { status: 'unsupported' }
    | { status: 'transient'; reason: string }
  >;
  hasHealthyCredentialForModel(model: FixtureModelRef): Promise<boolean>;
  invalidateCredential(credentialId?: string): void;
};

export type ManagedAiGatewayFixtureRequest = {
  at: string;
  method: string;
  pathname: string;
  authorizationPresent: boolean;
  userId: string;
  orgId: string | null;
  sessionId: string;
  model: string;
  promptNonce: string;
  stream: boolean;
  status: number;
};

export type ManagedAiGatewayFixture = {
  baseUrl: string;
  modelCapabilities: FixtureModelCapabilityVerifier;
  requests: ManagedAiGatewayFixtureRequest[];
  server: Server;
};

type FixtureUser = { id: string; email: string };
type PendingTransportRequest = {
  model: string;
  promptNonce: string;
  stream: boolean;
};

function fixtureUserForToken(token: string): FixtureUser | null {
  if (token === E2E_MANAGED_AI_TOKEN || token === E2E_MANAGED_AI_GATEWAY_ACCESS_TOKEN) {
    return { id: E2E_MANAGED_AI_USER_ID, email: 'veslo-managed-ai-e2e@example.test' };
  }
  if (token === E2E_MANAGED_AI_SECOND_TOKEN) {
    return { id: E2E_MANAGED_AI_SECOND_USER_ID, email: 'veslo-managed-ai-second-e2e@example.test' };
  }
  return null;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return compactText(value.map(textFromContent).filter(Boolean).join(' '));
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
  return textFromContent(record.input) || textFromContent(record.prompt) || null;
}

function extractPromptNonce(promptText: string | null): string {
  return promptText?.match(/\b[a-z0-9][a-z0-9_-]*-\d{10,}\b/i)?.[0] ?? 'managed-ai-fixture';
}

function readBodyModel(body: unknown): string {
  if (!body || typeof body !== 'object') return ACTIVE_MODEL.model;
  const model = (body as Record<string, unknown>).model;
  return typeof model === 'string' && model.trim() ? model.trim() : ACTIVE_MODEL.model;
}

function readBodyStream(body: unknown): boolean {
  return Boolean(body && typeof body === 'object' && (body as Record<string, unknown>).stream === true);
}

function buildChatCompletionResponse(model: string, content: string) {
  return {
    id: `chatcmpl_e2e_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
  };
}

function buildChatCompletionStream(model: string, content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const id = `chatcmpl_e2e_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const events = [
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function responseDelayMs(): number {
  const parsed = Number(process.env.E2E_MANAGED_AI_RESPONSE_DELAY_MS?.trim() ?? '0');
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30_000) : 0;
}

async function delayResponseIfRequested(): Promise<void> {
  const delayMs = responseDelayMs();
  if (delayMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
}

export async function startManagedAiGatewayFixture(): Promise<ManagedAiGatewayFixture> {
  const requests: ManagedAiGatewayFixtureRequest[] = [];
  const pendingTransportRequests: PendingTransportRequest[] = [];
  const now = new Date('2026-07-12T00:00:00.000Z');
  const modelPolicy = {
    async getPolicy() {
      return {
        id: 'platform' as const,
        enabledModels: ENABLED_MODELS.map((entry) => ({ ...entry })),
        activeModel: { ...ACTIVE_MODEL },
        createdAt: now,
        updatedAt: now,
      };
    },
    async replacePolicy() {
      throw new Error('fixture model policy is immutable');
    },
  };
  const aiAccess = {
    async getUserAiAccess(userId: string) {
      if (userId !== E2E_MANAGED_AI_USER_ID && userId !== E2E_MANAGED_AI_SECOND_USER_ID) return null;
      return {
        id: `ai_access_${userId}`,
        userId,
        enabled: true,
        provider: 'codex_oauth' as const,
        credentialId: CREDENTIAL_ID,
        defaultModel: ACTIVE_MODEL.model,
        allowedModels: ENABLED_MODELS.map((entry) => entry.model),
        assignmentOrigin: 'admin_assigned' as const,
        createdAt: now,
        updatedAt: now,
      };
    },
    async upsertUserAiAccess() {
      throw new Error('fixture access policy is immutable');
    },
    async countEnabledPolicies() {
      return 2;
    },
  };
  const sessionResolver = {
    async resolveSession(token: string) {
      const user = fixtureUserForToken(token);
      return user ? { token, user } : null;
    },
  };
  const credentialRecord = {
    id: CREDENTIAL_ID,
    name: 'E2E Codex credential',
    ownerUserId: 'platform:codex_oauth',
    provider: 'codex_oauth',
    credentialType: 'oauth',
    state: 'healthy',
    secretRef: 'secret_veslo_e2e_codex',
    createdAt: now,
    updatedAt: now,
    lastFailureAt: null,
  };
  const binding = {
    id: BINDING_ID,
    ownerUserId: 'platform:codex_oauth',
    provider: 'codex_oauth',
    credentialRecordId: CREDENTIAL_ID,
    createdAt: now,
    updatedAt: now,
  };
  const modelCapabilities: FixtureModelCapabilityVerifier = {
    async checkHealthyCredentialForModel() {
      return { status: 'supported', credentialId: CREDENTIAL_ID };
    },
    async checkHealthyCredentialsForModels(models) {
      return models.map((model) => {
        if (model.provider !== 'codex_oauth') {
          return { model, status: 'unsupported', reason: 'no_healthy_credential' };
        }
        if (!FIXTURE_SUPPORTED_CODEX_MODELS.has(model.model)) {
          return { model, status: 'unsupported', reason: 'model_unsupported' };
        }
        return { model, status: 'supported', credentialId: CREDENTIAL_ID };
      });
    },
    async checkCredentialForModel() {
      return { status: 'supported', credentialId: CREDENTIAL_ID };
    },
    async hasHealthyCredentialForModel() {
      return true;
    },
    invalidateCredential() {},
  };
  const credentials = {
    async getCredentialRecordById(id: string) {
      return id === CREDENTIAL_ID ? credentialRecord : null;
    },
    async listHealthyCredentialRecordIds() {
      return [CREDENTIAL_ID];
    },
    async getBindingByCredentialId(id: string) {
      return id === CREDENTIAL_ID ? binding : null;
    },
    async getCredentialRecordByBindingId(id: string) {
      return id === BINDING_ID ? credentialRecord : null;
    },
    async markCredentialState() {},
  };
  const proxy = {
    gatewaySessions: sessionResolver,
    managedAiEntitlement: {
      async resolve(input: { requestedOrgId: string | null }) {
        return { orgId: input.requestedOrgId ?? E2E_MANAGED_AI_ORG_ID, canUseManagedAi: true };
      },
    },
    aiAccess,
    modelPolicy,
    credentials,
    secrets: {
      async put() { return { secretRef: credentialRecord.secretRef }; },
      async get() { return { kind: 'codex_auth_json' as const, authJson: '{"fixture":true}' }; },
      async replace() {},
    },
    usageRepository: {
      async recordUsage(input: {
        ownerUserId: string;
        orgId: string | null;
        sessionId: string;
        model: string;
      }) {
        const transport = pendingTransportRequests.shift();
        if (!transport) throw new Error('fixture transport request was not captured');
        requests.push({
          at: new Date().toISOString(),
          method: 'POST',
          pathname: '/providers/codex_oauth/v1/chat/completions',
          authorizationPresent: true,
          userId: input.ownerUserId,
          orgId: input.orgId,
          sessionId: input.sessionId,
          model: input.model,
          promptNonce: transport.promptNonce,
          stream: transport.stream,
          status: 200,
        });
      },
    },
    leaseBroker: {
      async getOrCreateActiveLease(input: { ownerUserId: string; provider: 'codex_oauth'; sessionId: string }) {
        return {
          id: `lease_${input.ownerUserId}_${input.sessionId}`,
          ownerUserId: input.ownerUserId,
          provider: input.provider,
          sessionId: input.sessionId,
          activeBindingId: BINDING_ID,
        };
      },
      async handleUpstreamFailure() {
        throw new Error('unused');
      },
    },
    tokenBroker: { async getUpstreamAuth() { return { kind: 'oauth' as const, value: 'fixture' }; } },
    codexOAuthTransport: {
      async chatCompletions(input: { body: unknown }) {
        const model = readBodyModel(input.body);
        const promptText = extractPromptText(input.body);
        const promptNonce = extractPromptNonce(promptText);
        const stream = readBodyStream(input.body);
        pendingTransportRequests.push({ model, promptNonce, stream });
        await delayResponseIfRequested();
        const content = `Veslo managed AI fixture response for ${promptNonce}.`;
        return stream
          ? {
              status: 200,
              body: buildChatCompletionStream(model, content),
              headers: { 'content-type': 'text/event-stream; charset=utf-8' },
              usage: { inputTokens: 8, outputTokens: 8, cachedTokens: 0, totalTokens: 16 },
            }
          : {
              status: 200,
              body: buildChatCompletionResponse(model, content),
              usage: { inputTokens: 8, outputTokens: 8, cachedTokens: 0, totalTokens: 16 },
            };
      },
    },
    openAiTransport: { async chatCompletions() { throw new Error('unused'); } },
    anthropicTransport: { async messages() { throw new Error('unused'); } },
    openAiCompatibleTransport: { async chatCompletions() { throw new Error('unused'); } },
  };
  const app = createAiGatewayTestApp({
    runtime: {} as never,
    admin: {} as never,
    readiness: {
      probes: [{ provider: 'codex_oauth', url: 'http://fixture.invalid' }],
      fetchImpl: async () => new Response('{}', { status: 200 }),
      credentials,
      aiAccess,
      modelPolicy,
      modelCapabilities,
    },
    userCredentials: { sessionResolver, aiAccess, modelPolicy },
    proxy: proxy as never,
  });

  app.get('/__e2e/model-policy', async (_req, res) => {
    const policy = await modelPolicy.getPolicy();
    res.json({ enabledModels: policy.enabledModels, activeModel: policy.activeModel });
  });
  app.get('/__e2e/requests', (_req, res) => res.json({ requests }));
  app.post('/__e2e/reset', (_req, res) => {
    requests.splice(0, requests.length);
    pendingTransportRequests.splice(0, pendingTransportRequests.length);
    res.json({ ok: true });
  });
  app.get('/api/me', (req, res) => {
    const authorization = req.header('authorization') ?? '';
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
    const user = fixtureUserForToken(token);
    if (!user) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.json({ user, org: { id: E2E_MANAGED_AI_ORG_ID, slug: 'veslo-managed-ai-e2e' } });
  });

  const server = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader(
      'access-control-allow-headers',
      'authorization,content-type,x-veslo-den-org-id,x-veslo-org-id,x-veslo-session-id',
    );
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    app(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Managed AI gateway fixture did not bind to a TCP port.');
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, modelCapabilities, requests, server };
}

export async function stopManagedAiGatewayFixture(fixture: ManagedAiGatewayFixture | null): Promise<void> {
  if (!fixture) return;
  fixture.server.close();
  await once(fixture.server, 'close');
}
