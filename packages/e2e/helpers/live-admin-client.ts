type FetchLike = typeof fetch;

export type AdminBrowserIntent = 'signin' | 'signup';

export type AdminBrowserStartInput = {
  intent: AdminBrowserIntent;
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

export type AdminBrowserStartResult = {
  authorizeUrl: string;
  sessionId: string;
};

export type AdminBrowserExchangeInput = {
  code: string;
  sessionId: string;
  state: string;
  codeVerifier: string;
};

export type AdminSession = {
  user?: {
    id?: string;
    email?: string;
    name?: string;
  } | null;
  activeOrgId?: string | null;
  organizations?: Array<{
    id?: string;
    name?: string;
    slug?: string;
    role?: string;
  }>;
};

export type AdminUserRecord = {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
  status?: string;
  platformAdmin?: boolean;
  disabled?: boolean;
  memberships?: Array<{
    membershipId?: string;
    orgId?: string;
  }>;
};

export type AdminOrganizationMemberRecord = {
  membershipId: string;
  userId: string;
  status: 'active' | 'disabled' | 'removed';
};

export type AdminCredentialRecord = {
  id?: string;
  provider?: string;
  state?: string;
  name?: string;
  credentialType?: string;
};

export type AdminUserAiAccessRecord = {
  id?: string;
  userId?: string;
  enabled?: boolean;
  provider?: string | null;
  credentialId?: string | null;
};

export type CreateAdminUserInput = {
  email: string;
  name: string;
  platformAdmin?: boolean;
  orgId?: string | null;
  orgRole?: 'owner' | 'member';
};

export type UpsertAdminUserAiAccessInput = {
  enabled: boolean;
  provider: string | null;
  credentialId?: string | null;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

async function parseJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text().catch(() => '');
  if (!text.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function requestJson(
  fetchImpl: FetchLike,
  input: {
    method: 'GET' | 'POST' | 'PUT';
    url: string;
    token?: string;
    body?: unknown;
  },
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };

  if (input.token) {
    headers.authorization = `Bearer ${input.token}`;
  }

  if (input.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetchImpl(input.url, {
    method: input.method,
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const payload = await parseJsonBody(response);

  if (!response.ok) {
    const error = readText(payload?.error) || readText(payload?.message) || `request_failed_${response.status}`;
    throw new Error(`${error} (${response.status})`);
  }

  return payload;
}

export async function startAdminBrowserSession(
  fetchImpl: FetchLike,
  gatewayBase: string,
  input: AdminBrowserStartInput,
): Promise<AdminBrowserStartResult> {
  const payload = await requestJson(fetchImpl, {
    method: 'POST',
    url: `${normalizeBaseUrl(gatewayBase)}/admin/api/auth/browser/start`,
    body: {
      intent: input.intent,
      redirectUri: input.redirectUri,
      state: input.state,
      codeChallenge: input.codeChallenge,
    },
  });

  const authorizeUrl = readText(payload?.authorizeUrl);
  const sessionId = readText(payload?.sessionId);
  if (!authorizeUrl || !sessionId) {
    throw new Error('admin_auth_start_invalid_response');
  }

  return {
    authorizeUrl,
    sessionId,
  };
}

export async function exchangeAdminBrowserSession(
  fetchImpl: FetchLike,
  gatewayBase: string,
  input: AdminBrowserExchangeInput,
): Promise<string> {
  const payload = await requestJson(fetchImpl, {
    method: 'POST',
    url: `${normalizeBaseUrl(gatewayBase)}/admin/api/auth/browser/exchange`,
    body: {
      code: input.code,
      sessionId: input.sessionId,
      state: input.state,
      codeVerifier: input.codeVerifier,
    },
  });

  const token = readText(payload?.token);
  if (!token) {
    throw new Error('admin_auth_exchange_missing_token');
  }

  return token;
}

export async function getAdminSession(
  fetchImpl: FetchLike,
  gatewayBase: string,
  token: string,
): Promise<AdminSession> {
  return ((await requestJson(fetchImpl, {
    method: 'GET',
    url: `${normalizeBaseUrl(gatewayBase)}/admin/api/session`,
    token,
  })) ?? {}) as AdminSession;
}

export async function listAdminUsers(
  fetchImpl: FetchLike,
  gatewayBase: string,
  token: string,
): Promise<AdminUserRecord[]> {
  const payload = await requestJson(fetchImpl, {
    method: 'GET',
    url: `${normalizeBaseUrl(gatewayBase)}/admin/api/users`,
    token,
  });

  return Array.isArray(payload?.users) ? (payload.users as AdminUserRecord[]) : [];
}

export async function listAdminOrganizationMembers(
  fetchImpl: FetchLike,
  gatewayBase: string,
  token: string,
  organizationId: string,
): Promise<AdminOrganizationMemberRecord[]> {
  const payload = await requestJson(fetchImpl, {
    method: 'GET',
    url: `${normalizeBaseUrl(gatewayBase)}/admin/api/organizations/${encodeURIComponent(organizationId)}/members`,
    token,
  });
  if (!Array.isArray(payload?.members)) {
    throw new Error('admin_organization_members_invalid_response');
  }

  const membershipIds = new Set<string>();
  const userIds = new Set<string>();
  return payload.members.map((value) => {
    if (!value || typeof value !== 'object') {
      throw new Error('admin_organization_members_invalid_response');
    }
    const member = value as Record<string, unknown>;
    const membershipId = readText(member.membershipId);
    const userId = readText(member.userId);
    const status = readText(member.status);
    if (
      !membershipId
      || !userId
      || (status !== 'active' && status !== 'disabled' && status !== 'removed')
      || membershipIds.has(membershipId)
      || userIds.has(userId)
    ) {
      throw new Error('admin_organization_members_invalid_response');
    }
    membershipIds.add(membershipId);
    userIds.add(userId);
    return { membershipId, userId, status };
  });
}

export async function resolveAdminUserActiveOrganizationId(
  fetchImpl: FetchLike,
  gatewayBase: string,
  token: string,
  user: AdminUserRecord,
  preferredOrganizationId = '',
): Promise<string> {
  const userId = readText(user.id);
  const preferredId = preferredOrganizationId.trim();
  const candidateOrganizationIds = preferredId
    ? [preferredId]
    : Array.from(new Set(
        (Array.isArray(user.memberships) ? user.memberships : [])
          .map((membership) => readText(membership.orgId))
          .filter(Boolean),
      ));
  if (!userId || candidateOrganizationIds.length === 0) {
    throw new Error('admin_user_active_organization_not_found');
  }

  const scopedMemberships = await Promise.all(
    candidateOrganizationIds.map(async (organizationId) => ({
      organizationId,
      members: await listAdminOrganizationMembers(fetchImpl, gatewayBase, token, organizationId),
    })),
  );
  const activeOrganizationIds = scopedMemberships
    .filter(({ members }) => members.some((member) => member.userId === userId && member.status === 'active'))
    .map(({ organizationId }) => organizationId);

  if (activeOrganizationIds.length === 0) {
    throw new Error('admin_user_active_organization_not_found');
  }
  if (activeOrganizationIds.length > 1) {
    throw new Error('admin_user_active_organization_ambiguous');
  }
  return activeOrganizationIds[0]!;
}

export function findAdminUserByEmail(users: AdminUserRecord[], email: string): AdminUserRecord | null {
  const normalized = email.trim().toLowerCase();
  return users.find((user) => readText(user.email).toLowerCase() === normalized) ?? null;
}

export async function createAdminUser(
  fetchImpl: FetchLike,
  gatewayBase: string,
  token: string,
  input: CreateAdminUserInput,
): Promise<AdminUserRecord> {
  const payload = await requestJson(fetchImpl, {
    method: 'POST',
    url: `${normalizeBaseUrl(gatewayBase)}/admin/api/users`,
    token,
    body: {
      email: input.email,
      name: input.name,
      platformAdmin: input.platformAdmin ?? false,
      orgId: input.orgId ?? null,
      orgRole: input.orgRole ?? 'member',
    },
  });

  const user = payload?.user;
  if (!user || typeof user !== 'object') {
    throw new Error('admin_user_create_invalid_response');
  }

  return user as AdminUserRecord;
}

export async function listAdminCredentials(
  fetchImpl: FetchLike,
  gatewayBase: string,
  token: string,
): Promise<AdminCredentialRecord[]> {
  const payload = await requestJson(fetchImpl, {
    method: 'GET',
    url: `${normalizeBaseUrl(gatewayBase)}/admin/api/credentials`,
    token,
  });

  return Array.isArray(payload?.credentials) ? (payload.credentials as AdminCredentialRecord[]) : [];
}

export async function upsertAdminUserAiAccess(
  fetchImpl: FetchLike,
  gatewayBase: string,
  token: string,
  organizationId: string,
  userId: string,
  input: UpsertAdminUserAiAccessInput,
): Promise<AdminUserAiAccessRecord> {
  const payload = await requestJson(fetchImpl, {
    method: 'PUT',
    url: `${normalizeBaseUrl(gatewayBase)}/admin/api/organizations/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}/ai-access`,
    token,
    body: {
      enabled: input.enabled,
      provider: input.provider,
      credentialId: input.credentialId ?? null,
    },
  });

  const aiAccess = payload?.aiAccess;
  if (!aiAccess || typeof aiAccess !== 'object') {
    throw new Error('admin_user_ai_access_invalid_response');
  }

  return aiAccess as AdminUserAiAccessRecord;
}
