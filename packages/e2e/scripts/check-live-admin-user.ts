import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { waitForAdminBrowserCallback } from '../helpers/live-admin-check.js';

type AdminUserRecord = {
  id?: string;
  email?: string;
  name?: string;
  role?: string;
  status?: string;
  isPlatformAdmin?: boolean;
};

function parseArgs(argv: string[]) {
  const result = {
    email: process.env.VESLO_ADMIN_CHECK_EMAIL?.trim() || 'michal.sara@neatech.cz',
    gatewayBase: process.env.VESLO_ADMIN_CHECK_BASE?.trim() || 'https://veslo-ai-gateway-dev.onrender.com',
    timeoutMs: Number.parseInt(process.env.VESLO_ADMIN_CHECK_TIMEOUT_MS || '300000', 10),
    attemptCreate: process.env.VESLO_ADMIN_CHECK_ATTEMPT_CREATE === '1',
    createEmail: process.env.VESLO_ADMIN_CHECK_CREATE_EMAIL?.trim() || '',
    createName: process.env.VESLO_ADMIN_CHECK_CREATE_NAME?.trim() || 'Codex Live Check',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--email' && argv[index + 1]) {
      result.email = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (arg === '--base' && argv[index + 1]) {
      result.gatewayBase = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (arg === '--timeout-ms' && argv[index + 1]) {
      const parsed = Number.parseInt(argv[index + 1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        result.timeoutMs = parsed;
      }
      index += 1;
      continue;
    }
    if (arg === '--attempt-create') {
      result.attemptCreate = true;
      continue;
    }
    if (arg === '--create-email' && argv[index + 1]) {
      result.createEmail = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (arg === '--create-name' && argv[index + 1]) {
      result.createName = argv[index + 1].trim();
      index += 1;
    }
  }

  return result;
}

function randomBase64Url(size: number) {
  return randomBytes(size).toString('base64url');
}

function sha256Base64Url(value: string) {
  return createHash('sha256').update(value).digest('base64url');
}

async function openBrowser(url: string) {
  const command =
    process.platform === 'darwin'
      ? { bin: 'open', args: [url] }
      : process.platform === 'win32'
        ? { bin: 'cmd', args: ['/c', 'start', '', url] }
        : { bin: 'xdg-open', args: [url] };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.bin, command.args, {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function main() {
  const { email, gatewayBase, timeoutMs, attemptCreate, createEmail, createName } = parseArgs(process.argv.slice(2));
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);

  const callback = await waitForAdminBrowserCallback({
    timeoutMs,
    onReady: async ({ redirectUri }) => {
      const startResponse = await fetch(`${gatewayBase}/admin/api/auth/browser/start`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          intent: 'signin',
          redirectUri,
          state,
          codeChallenge,
        }),
      });

      const startPayload = await startResponse.json().catch(() => null);
      if (!startResponse.ok) {
        throw new Error(`Admin auth start failed (${startResponse.status}): ${startPayload?.error || 'unknown_error'}`);
      }

      const authorizeUrl = typeof startPayload?.authorizeUrl === 'string' ? startPayload.authorizeUrl.trim() : '';
      const sessionId = typeof startPayload?.sessionId === 'string' ? startPayload.sessionId.trim() : '';
      if (!authorizeUrl || !sessionId) {
        throw new Error('Admin auth start returned an incomplete payload.');
      }

      console.log(`[admin-check] Browser auth started for ${email}`);
      console.log(`[admin-check] Redirect URI: ${redirectUri}`);
      console.log(`[admin-check] Opening browser: ${authorizeUrl}`);

      try {
        await openBrowser(authorizeUrl);
      } catch (error) {
        console.warn(`[admin-check] Failed to open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`[admin-check] Open this URL manually: ${authorizeUrl}`);
      }
    },
  });

  if (!callback.code || !callback.sessionId) {
    throw new Error('Admin browser callback completed without code/sessionId.');
  }

  const exchangeResponse = await fetch(`${gatewayBase}/admin/api/auth/browser/exchange`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      code: callback.code,
      sessionId: callback.sessionId,
      state,
      codeVerifier,
    }),
  });
  const exchangePayload = await exchangeResponse.json().catch(() => null);
  if (!exchangeResponse.ok) {
    throw new Error(`Admin auth exchange failed (${exchangeResponse.status}): ${exchangePayload?.error || 'unknown_error'}`);
  }

  const token = typeof exchangePayload?.token === 'string' ? exchangePayload.token.trim() : '';
  if (!token) {
    throw new Error('Admin auth exchange succeeded but returned no token.');
  }

  const [sessionResponse, usersResponse] = await Promise.all([
    fetch(`${gatewayBase}/admin/api/session`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
    }),
    fetch(`${gatewayBase}/admin/api/users`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
    }),
  ]);

  const sessionPayload = await sessionResponse.json().catch(() => null);
  const usersPayload = await usersResponse.json().catch(() => null);

  const users = Array.isArray(usersPayload?.users) ? (usersPayload.users as AdminUserRecord[]) : [];
  const normalizedEmail = email.toLowerCase();
  const match =
    users.find((user) => typeof user.email === 'string' && user.email.trim().toLowerCase() === normalizedEmail) ?? null;
  const organizations = Array.isArray(sessionPayload?.organizations) ? sessionPayload.organizations : [];
  const createTargetEmail = (createEmail || email).trim();

  let createStatus: number | null = null;
  let createPayload: unknown = null;
  if (attemptCreate && createTargetEmail) {
    const orgId =
      (typeof sessionPayload?.activeOrgId === 'string' && sessionPayload.activeOrgId.trim()) ||
      (typeof organizations[0]?.id === 'string' ? organizations[0].id : '') ||
      null;

    const createResponse = await fetch(`${gatewayBase}/admin/api/users`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        email: createTargetEmail,
        name: createName,
        platformAdmin: false,
        orgId,
        orgRole: 'member',
      }),
    });
    createStatus = createResponse.status;
    createPayload = await createResponse.json().catch(() => null);
  }

  console.log(
    JSON.stringify(
      {
        adminUser: sessionPayload?.user?.email ?? sessionPayload?.user?.id ?? null,
        adminRole: sessionPayload?.membership?.role ?? null,
        sessionStatus: sessionResponse.status,
        usersStatus: usersResponse.status,
        userCount: users.length,
        found: Boolean(match),
        match,
        usersError: usersPayload?.error ?? null,
        createAttempted: attemptCreate,
        createEmail: attemptCreate ? createTargetEmail : null,
        createStatus,
        createPayload,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`[admin-check] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
