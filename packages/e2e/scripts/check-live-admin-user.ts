import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  createAdminUser,
  exchangeAdminBrowserSession,
  findAdminUserByEmail,
  getAdminSession,
  listAdminCredentials,
  listAdminUsers,
  startAdminBrowserSession,
  upsertAdminUserAiAccess,
} from '../helpers/live-admin-client.js';
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
    listCredentials: process.env.VESLO_ADMIN_CHECK_LIST_CREDENTIALS === '1',
    provider: process.env.VESLO_ADMIN_CHECK_PROVIDER?.trim() || '',
    credentialId: process.env.VESLO_ADMIN_CHECK_CREDENTIAL_ID?.trim() || '',
    disableAiAccess: process.env.VESLO_ADMIN_CHECK_DISABLE_AI_ACCESS === '1',
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
      continue;
    }
    if (arg === '--list-credentials') {
      result.listCredentials = true;
      continue;
    }
    if (arg === '--provider' && argv[index + 1]) {
      result.provider = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (arg === '--credential-id' && argv[index + 1]) {
      result.credentialId = argv[index + 1].trim();
      index += 1;
      continue;
    }
    if (arg === '--disable-ai-access') {
      result.disableAiAccess = true;
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
  const {
    email,
    gatewayBase,
    timeoutMs,
    attemptCreate,
    createEmail,
    createName,
    listCredentials,
    provider,
    credentialId,
    disableAiAccess,
  } = parseArgs(process.argv.slice(2));
  const state = randomBase64Url(32);
  const codeVerifier = randomBase64Url(32);
  const codeChallenge = sha256Base64Url(codeVerifier);

  const callback = await waitForAdminBrowserCallback({
    timeoutMs,
    onReady: async ({ redirectUri }) => {
      const startPayload = await startAdminBrowserSession(fetch, gatewayBase, {
        intent: 'signin',
        redirectUri,
        state,
        codeChallenge,
      });

      console.log(`[admin-check] Browser auth started for target ${email}`);
      console.log(`[admin-check] Redirect URI: ${redirectUri}`);
      console.log(`[admin-check] Opening browser: ${startPayload.authorizeUrl}`);

      try {
        await openBrowser(startPayload.authorizeUrl);
      } catch (error) {
        console.warn(`[admin-check] Failed to open the browser automatically: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`[admin-check] Open this URL manually: ${startPayload.authorizeUrl}`);
      }
    },
  });

  if (!callback.code || !callback.sessionId) {
    throw new Error('Admin browser callback completed without code/sessionId.');
  }

  const token = await exchangeAdminBrowserSession(fetch, gatewayBase, {
    code: callback.code,
    sessionId: callback.sessionId,
    state,
    codeVerifier,
  });

  const [sessionPayload, users, credentials] = await Promise.all([
    getAdminSession(fetch, gatewayBase, token),
    listAdminUsers(fetch, gatewayBase, token),
    listCredentials ? listAdminCredentials(fetch, gatewayBase, token) : Promise.resolve([]),
  ]);

  const match = findAdminUserByEmail(users as AdminUserRecord[], email);
  const organizations = Array.isArray(sessionPayload?.organizations) ? sessionPayload.organizations : [];
  const createTargetEmail = (createEmail || email).trim();

  let createdUser: AdminUserRecord | null = null;
  if (attemptCreate && createTargetEmail && !match) {
    const orgId =
      (typeof sessionPayload?.activeOrgId === 'string' && sessionPayload.activeOrgId.trim()) ||
      (typeof organizations[0]?.id === 'string' ? organizations[0].id : '') ||
      null;
    createdUser = await createAdminUser(fetch, gatewayBase, token, {
      email: createTargetEmail,
      name: createName,
      platformAdmin: false,
      orgId,
      orgRole: 'member',
    });
  }

  const targetUser = match ?? createdUser;
  const shouldUpsertAiAccess = disableAiAccess || provider;
  const aiAccess = shouldUpsertAiAccess && targetUser?.id
    ? await upsertAdminUserAiAccess(fetch, gatewayBase, token, targetUser.id, {
        enabled: !disableAiAccess,
        provider: disableAiAccess ? null : provider || null,
        credentialId: disableAiAccess ? null : credentialId || null,
      })
    : null;

  console.log(
    JSON.stringify(
      {
        adminUser: sessionPayload?.user?.email ?? sessionPayload?.user?.id ?? null,
        activeOrgId: sessionPayload?.activeOrgId ?? null,
        organizationCount: organizations.length,
        userCount: users.length,
        found: Boolean(match),
        match,
        createAttempted: attemptCreate,
        createEmail: attemptCreate ? createTargetEmail : null,
        createdUser,
        credentialCount: credentials.length,
        credentials,
        aiAccessApplied: Boolean(aiAccess),
        aiAccess,
        targetUser,
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
