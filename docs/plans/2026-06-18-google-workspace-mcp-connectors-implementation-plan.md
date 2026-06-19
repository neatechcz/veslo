# Google Workspace MCP Connectors Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship three platform-provided Google remote MCP connectors: Gmail, Calendar, and Drive.

**Architecture:** Den publishes platform MCP catalog entries; the local Veslo server validates and installs those entries into OpenCode config; the desktop app shows the three connectors as separate Google cards and drives local OpenCode MCP OAuth. Google refresh tokens remain local to the user device.

**Tech Stack:** Express/TypeScript Den service, Bun TypeScript Veslo server, SolidJS desktop app, OpenCode remote MCP OAuth, WebdriverIO desktop E2E.

---

## Context For Implementer

The approved design is in `docs/plans/2026-06-18-google-workspace-mcp-connectors-design.md`.

Key decisions:

- Use Google's hosted remote MCP servers.
- Ship Gmail, Calendar, and Drive as separate connector entries.
- Veslo owns Google Cloud OAuth app setup.
- Do not store user Google refresh tokens in Veslo Cloud for MVP.
- Keep configured, locally authorized, and runtime-ready states separate.

Google connector constants for MVP:

```ts
const GOOGLE_MCP_CONNECTORS = [
  {
    id: "google-gmail",
    name: "Google Gmail",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    scopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
  },
];
```

OpenCode supports pre-registered OAuth config as:

```jsonc
{
  "mcp": {
    "google-gmail": {
      "type": "remote",
      "url": "https://gmailmcp.googleapis.com/mcp/v1",
      "enabled": true,
      "oauth": {
        "clientId": "{env:VESLO_GOOGLE_MCP_CLIENT_ID}",
        "clientSecret": "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}",
        "scope": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"
      }
    }
  }
}
```

Do not put Google user refresh tokens in catalog payloads, app local storage, Den, or docs.

## Task 1: Add Platform Google Catalog Entries In Den

**Files:**

- Modify: `services/den/src/http/org-mcp-catalog.ts`
- Modify: `services/den/test/org-mcp-catalog.test.ts`

**Step 1: Write the failing test**

Add a test that authorized org members receive three platform Google MCP entries.

```ts
test("org mcp catalog includes platform Google Workspace connectors", async () => {
  const server = await startServer(async (req, _res, options) => ({
    session: {
      user: {
        id: "user_1",
        email: "user@example.com",
        emailVerified: true,
        name: "User One",
      },
    },
    organization: {
      id: req.params.orgId,
      name: "Org One",
      slug: "org-one",
      ownerUserId: "user_1",
    },
    membershipId: "membership_1",
    orgRole: "member",
    isPlatformAdmin: false,
  }));

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/orgs/org_1/mcp/catalog`);
    assert.equal(response.status, 200);
    const payload = await response.json() as {
      items: Array<{
        id: string;
        name: string;
        config: {
          type: string;
          url: string;
          oauth: {
            clientId: string;
            clientSecret: string;
            scope: string;
          };
        };
        source: { scope: string };
        provider?: { id: string; group: string };
      }>;
    };

    assert.deepEqual(payload.items.map((item) => item.id), [
      "google-gmail",
      "google-calendar",
      "google-drive",
    ]);
    assert.equal(payload.items[0].source.scope, "platform");
    assert.equal(payload.items[0].provider?.id, "google");
    assert.equal(payload.items[0].config.type, "remote");
    assert.equal(payload.items[0].config.url, "https://gmailmcp.googleapis.com/mcp/v1");
    assert.match(payload.items[0].config.oauth.scope, /gmail\.readonly/);
    assert.equal(payload.items[0].config.oauth.clientId, "{env:VESLO_GOOGLE_MCP_CLIENT_ID}");
    assert.equal(payload.items[0].config.oauth.clientSecret, "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}");
  } finally {
    await server.close();
  }
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/den test -- org-mcp-catalog.test.ts
```

Expected: FAIL because the route currently returns `{ items: [] }`.

**Step 3: Add catalog constants and return them**

In `services/den/src/http/org-mcp-catalog.ts`, add constants near the top:

```ts
const GOOGLE_MCP_OAUTH = {
  clientId: "{env:VESLO_GOOGLE_MCP_CLIENT_ID}",
  clientSecret: "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}",
};

const GOOGLE_MCP_CONNECTORS = [
  {
    id: "google-gmail",
    name: "Google Gmail",
    description: "Search Gmail threads and create draft email through Google MCP.",
    config: {
      type: "remote",
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      oauth: {
        ...GOOGLE_MCP_OAUTH,
        scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
      },
    },
    source: { scope: "platform" },
    provider: { id: "google", group: "Google" },
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "List calendars, inspect availability, and manage events through Google MCP.",
    config: {
      type: "remote",
      url: "https://calendarmcp.googleapis.com/mcp/v1",
      oauth: {
        ...GOOGLE_MCP_OAUTH,
        scope: [
          "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
          "https://www.googleapis.com/auth/calendar.events.freebusy",
          "https://www.googleapis.com/auth/calendar.events.readonly",
        ].join(" "),
      },
    },
    source: { scope: "platform" },
    provider: { id: "google", group: "Google" },
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Find and work with Google Drive files through Google MCP.",
    config: {
      type: "remote",
      url: "https://drivemcp.googleapis.com/mcp/v1",
      oauth: {
        ...GOOGLE_MCP_OAUTH,
        scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
      },
    },
    source: { scope: "platform" },
    provider: { id: "google", group: "Google" },
  },
] as const;
```

Then change the route response:

```ts
res.json({ items: GOOGLE_MCP_CONNECTORS });
```

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/den test -- org-mcp-catalog.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/org-mcp-catalog.ts services/den/test/org-mcp-catalog.test.ts
git commit -m "Add Google MCP platform catalog entries"
```

## Task 2: Accept Rich Platform MCP Catalog Payloads In Veslo Server

**Files:**

- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/den-catalog.ts`
- Modify: `packages/server/src/mcp.ts`
- Modify: `packages/server/src/tests/server.hub-mcp.test.ts`

**Step 1: Write the failing catalog validation test**

Add a test in `packages/server/src/tests/server.hub-mcp.test.ts` that the server accepts a platform-scoped Google entry with `oauth` object and provider metadata.

```ts
test("GET /hub/mcp accepts platform Google MCP entries with OAuth config", async () => {
  const denServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () =>
      new Response(JSON.stringify({
        items: [
          {
            id: "google-gmail",
            name: "Google Gmail",
            description: "Search Gmail.",
            config: {
              type: "remote",
              url: "https://gmailmcp.googleapis.com/mcp/v1",
              oauth: {
                clientId: "{env:VESLO_GOOGLE_MCP_CLIENT_ID}",
                clientSecret: "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}",
                scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
              },
            },
            source: { scope: "platform" },
            provider: { id: "google", group: "Google" },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  runningServers.push(denServer as { stop?: (closeActiveConnections?: boolean) => void });

  const { server } = await startFixture({ denApiBase: `http://127.0.0.1:${denServer.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/hub/mcp`, {
    headers: {
      Authorization: "Bearer client-token",
      "x-veslo-den-token": "den-token",
      "x-veslo-den-org-id": "org_1",
    },
  });

  expect(response.status).toBe(200);
  const payload = await response.json() as { items: Array<any> };
  expect(payload.items[0].source.scope).toBe("platform");
  expect(payload.items[0].provider).toEqual({ id: "google", group: "Google" });
  expect(payload.items[0].config.oauth.scope).toContain("gmail.readonly");
});
```

**Step 2: Write the failing install preservation test**

Add a second test in the same file:

```ts
test("POST /workspace/:id/mcp/hub/:name preserves Google OAuth object", async () => {
  const denServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () =>
      new Response(JSON.stringify({
        items: [
          {
            id: "google-gmail",
            name: "Google Gmail",
            config: {
              type: "remote",
              url: "https://gmailmcp.googleapis.com/mcp/v1",
              oauth: {
                clientId: "{env:VESLO_GOOGLE_MCP_CLIENT_ID}",
                clientSecret: "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}",
                scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
              },
            },
            source: { scope: "platform" },
            provider: { id: "google", group: "Google" },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  runningServers.push(denServer as { stop?: (closeActiveConnections?: boolean) => void });

  const { server, workspaceRoot } = await startFixture({ denApiBase: `http://127.0.0.1:${denServer.port}` });

  const response = await fetch(`http://127.0.0.1:${server.port}/workspace/ws_1/mcp/hub/google-gmail`, {
    method: "POST",
    headers: {
      Authorization: "Bearer client-token",
      "x-veslo-den-token": "den-token",
      "x-veslo-den-org-id": "org_1",
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });

  expect(response.status).toBe(200);
  const configRaw = await readFile(join(workspaceRoot, "opencode.jsonc"), "utf8");
  expect(configRaw).toContain("\"google-gmail\"");
  expect(configRaw).toContain("\"clientId\": \"{env:VESLO_GOOGLE_MCP_CLIENT_ID}\"");
  expect(configRaw).toContain("\"clientSecret\": \"{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}\"");
  expect(configRaw).toContain("gmail.readonly");
});
```

**Step 3: Run tests to verify they fail**

Run:

```bash
pnpm --filter veslo-server test -- server.hub-mcp.test.ts
```

Expected: FAIL because `source.scope` only accepts `org`, and `oauth` only accepts boolean.

**Step 4: Update server types**

In `packages/server/src/types.ts`, update `HubMcpItem`:

```ts
export type HubMcpOAuthConfig =
  | boolean
  | {
      clientId: string;
      clientSecret?: string;
      scope?: string;
    };

export interface HubMcpItem {
  id: string;
  name: string;
  description?: string;
  config: {
    type: "remote" | "local";
    url?: string;
    command?: string[];
    oauth?: HubMcpOAuthConfig;
  };
  source:
    | { scope: "org"; orgId: string }
    | { scope: "platform" };
  provider?: {
    id: string;
    group?: string;
  };
}
```

**Step 5: Update Den catalog validation**

In `packages/server/src/den-catalog.ts`, add a helper:

```ts
function toMcpOAuthConfig(value: unknown, index: number) {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  if (!value || typeof value !== "object") {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  const payload = value as Record<string, unknown>;
  if (typeof payload.clientId !== "string") {
    throw new ApiError(502, "den_catalog_invalid_payload", `Invalid Den catalog item at index ${index}`);
  }

  return {
    clientId: payload.clientId,
    ...(typeof payload.clientSecret === "string" ? { clientSecret: payload.clientSecret } : {}),
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
  };
}
```

Update `toHubMcpItem` so `source.scope` accepts `platform` without `orgId`, preserves provider metadata, and uses `toMcpOAuthConfig(config.oauth, index)`.

**Step 6: Preserve OAuth object during install**

In `packages/server/src/mcp.ts`, change the remote branch:

```ts
if (item.config.type === "remote") {
  config.url = item.config.url;
  if (typeof item.config.oauth === "boolean" || typeof item.config.oauth === "object") {
    config.oauth = item.config.oauth;
  }
}
```

Do not copy `provider` or `source` into OpenCode config unless OpenCode supports those keys. The runtime config should stay focused on OpenCode-supported fields.

**Step 7: Run tests**

Run:

```bash
pnpm --filter veslo-server test -- server.hub-mcp.test.ts
pnpm --filter veslo-server typecheck
```

Expected: PASS.

**Step 8: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/den-catalog.ts packages/server/src/mcp.ts packages/server/src/tests/server.hub-mcp.test.ts
git commit -m "Support platform MCP catalog entries"
```

## Task 3: Carry Connector Metadata Through The App Client And Store

**Files:**

- Modify: `packages/app/src/app/types.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/context/extensions.ts`
- Modify: `packages/app/src/app/tests/lib/veslo-server.test.ts`

**Step 1: Write failing client tests**

Extend the existing `listHubMcp forwards den auth context headers when provided` test in `packages/app/src/app/tests/lib/veslo-server.test.ts`, or add a nearby test:

```ts
test("listHubMcp preserves platform connector metadata", async () => {
  const requests: Array<{ path: string }> = [];
  const server = await startTestServer((req) => {
    requests.push({ path: new URL(req.url).pathname });
    return json({
      items: [
        {
          id: "google-drive",
          name: "Google Drive",
          description: "Find Drive files.",
          config: {
            type: "remote",
            url: "https://drivemcp.googleapis.com/mcp/v1",
            oauth: {
              clientId: "{env:VESLO_GOOGLE_MCP_CLIENT_ID}",
              clientSecret: "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}",
              scope: "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file",
            },
          },
          source: { scope: "platform" },
          provider: { id: "google", group: "Google" },
        },
      ],
    });
  });

  try {
    const client = createVesloServerClient(server.url, { token: "token" });
    const result = await client.listHubMcp({ denToken: "den", denOrgId: "org_1" });
    assert.equal(result.items[0].source.scope, "platform");
    assert.equal(result.items[0].provider?.id, "google");
    assert.equal(typeof result.items[0].config.oauth, "object");
  } finally {
    await server.close();
  }
});
```

Use the helper names already present in that test file; do not create a second test server abstraction if one already exists.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: FAIL if type assumptions or assertions reject non-boolean OAuth metadata.

**Step 3: Update app types**

In `packages/app/src/app/types.ts`, mirror the server type:

```ts
export type HubMcpOAuthConfig =
  | boolean
  | {
      clientId: string;
      clientSecret?: string;
      scope?: string;
    };
```

Then use it in `HubMcpItem.config.oauth`.

Extend `HubMcpCard`:

```ts
export type HubMcpCard = {
  id: string;
  name: string;
  description?: string;
  type: "remote" | "local";
  url?: string;
  command?: string[];
  oauth: HubMcpOAuthConfig;
  provider?: {
    id: string;
    group?: string;
  };
  source?: HubMcpItem["source"];
};
```

In `packages/app/src/app/lib/veslo-server.ts`, update `VesloHubMcpItem` the same way.

**Step 4: Update mapping**

In `packages/app/src/app/context/extensions.ts`, update `refreshHubMcp` mapping:

```ts
oauth: entry.config.oauth === undefined ? true : entry.config.oauth,
provider: entry.provider,
source: entry.source,
```

Do not coerce OAuth object to `true`.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/types.ts packages/app/src/app/lib/veslo-server.ts packages/app/src/app/context/extensions.ts packages/app/src/app/tests/lib/veslo-server.test.ts
git commit -m "Preserve MCP connector metadata in app"
```

## Task 4: Render Google Connectors As Three Independent Cards

**Files:**

- Modify: `packages/app/src/app/pages/mcp.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Add or modify: `packages/app/src/app/tests/pages/mcp-google-connectors.test.ts`

**Step 1: Write failing render tests**

Create a focused unit test for the MCP page if one does not already exist. The test should render `McpPage` with three `HubMcpCard` items whose `provider.id` is `google`, then assert:

- a Google group label is visible
- three cards are visible
- clicking Gmail calls `installHubMcp("google-gmail")`
- clicking Gmail does not install Calendar or Drive

Pseudo-code:

```ts
test("renders Google hub MCP connectors as independent cards", async () => {
  const installs: string[] = [];
  render(() => (
    <McpPage
      quickConnect={[]}
      hubMcpCards={[
        googleCard("google-gmail", "Google Gmail"),
        googleCard("google-calendar", "Google Calendar"),
        googleCard("google-drive", "Google Drive"),
      ]}
      hubMcpStatus={null}
      refreshHubMcp={() => undefined}
      installHubMcp={async (name) => {
        installs.push(name);
        return { ok: true, message: "installed" };
      }}
      // Fill remaining required props with the current test helpers.
    />
  ));

  assert.match(document.body.textContent ?? "", /Google/);
  assert.match(document.body.textContent ?? "", /Google Gmail/);
  assert.match(document.body.textContent ?? "", /Google Calendar/);
  assert.match(document.body.textContent ?? "", /Google Drive/);

  clickCard("Google Gmail");
  await nextTick();
  assert.deepEqual(installs, ["google-gmail"]);
});
```

Use existing Solid test utilities already used in `packages/app/src/app/tests/pages` or `packages/app/src/app/tests/components`.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: FAIL because the page does not group provider cards or may use display names instead of ids for install.

**Step 3: Update UI grouping**

In `packages/app/src/app/pages/mcp.tsx`, split hub cards:

```ts
const googleHubCards = createMemo(() =>
  orgCatalogQuickConnect().filter((entry) => entry.provider?.id === "google"),
);

const otherHubCards = createMemo(() =>
  orgCatalogQuickConnect().filter((entry) => entry.provider?.id !== "google"),
);
```

Render a compact Google group above other org catalog cards:

```tsx
<Show when={googleHubCards().length}>
  <div class="space-y-3">
    <div class="flex items-center justify-between">
      <h4 class="font-product type-ui-xs font-bold text-dls-secondary uppercase tracking-widest">
        {tr("mcp.google_group")}
      </h4>
      <span class="font-product type-ui-xs text-dls-secondary">
        {tr("mcp.local_device_auth")}
      </span>
    </div>
    <div class="grid gap-3 grid-cols-1 sm:grid-cols-2 xl:grid-cols-3">
      <For each={googleHubCards()}>
        {(entry) => renderHubMcpCard(entry)}
      </For>
    </div>
  </div>
</Show>
```

Extract the repeated hub card into a small local render helper if needed. Do not create a shared component unless the local duplication becomes hard to read.

**Step 4: Use connector id for install**

When installing hub MCP cards, call:

```ts
void props.installHubMcp(entry.id || entry.name).then(...)
```

This ensures display name changes do not break install lookup.

**Step 5: Add translations**

Add these keys:

```ts
"mcp.google_group": "Google",
"mcp.local_device_auth": "Authorization is local to this device",
"mcp.connected_on_device": "Connected on this device",
```

Use Czech and Chinese equivalents consistent with the existing locale style. If in doubt, add English fallback-quality copy and run i18n parity checks.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/pages/mcp.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/tests/pages/mcp-google-connectors.test.ts
git commit -m "Show Google MCP connectors separately"
```

## Task 5: Preserve OAuth Config And Local-Device Copy In Auth UI

**Files:**

- Modify: `packages/app/src/app/pages/mcp.tsx`
- Modify: `packages/app/src/app/components/mcp-auth-modal.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Add or modify: `packages/app/src/app/tests/components/mcp-auth-modal.test.ts`

**Step 1: Write failing auth-copy test**

Add a component test that renders `McpAuthModal` for `Google Gmail` and asserts:

- title names the connector
- body says the connection is local to this device
- already-connected state uses "Connected on this device"

Pseudo-code:

```ts
test("Google MCP auth modal explains local device authorization", async () => {
  render(() => (
    <McpAuthModal
      open
      entry={{
        id: "google-gmail",
        name: "Google Gmail",
        description: "Search Gmail.",
        type: "remote",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        oauth: {
          clientId: "{env:VESLO_GOOGLE_MCP_CLIENT_ID}",
          clientSecret: "{env:VESLO_GOOGLE_MCP_CLIENT_SECRET}",
          scope: "https://www.googleapis.com/auth/gmail.readonly",
        },
        provider: { id: "google", group: "Google" },
      }}
      // Fill remaining required props with no-op helpers and a fake client.
    />
  ));

  assert.match(document.body.textContent ?? "", /Google Gmail/);
  assert.match(document.body.textContent ?? "", /local to this device/i);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: FAIL because current copy says only generic connect/account language.

**Step 3: Update auth modal copy**

In `packages/app/src/app/components/mcp-auth-modal.tsx`, detect Google entries:

```ts
const isGoogleConnector = () => props.entry?.provider?.id === "google";
```

Show an additional small note near the connect body:

```tsx
<Show when={isGoogleConnector()}>
  <p class="text-xs text-gray-11">
    {translate("mcp.auth.local_device_note")}
  </p>
</Show>
```

Add translations:

```ts
"mcp.auth.local_device_note": "This authorization is stored locally on this device. Other devices will ask you to connect again.",
"mcp.auth.connected_on_device": "Connected on this device",
```

Use `mcp.auth.connected_on_device` for Google entries in the already-connected block.

**Step 4: Keep OAuth object intact**

Review helper functions in `packages/app/src/app/pages/mcp.tsx` such as `supportsOauth(entry)`. Ensure `oauth` object is treated as OAuth enabled:

```ts
function supportsOauth(entry: McpDirectoryInfo | McpServerEntry | HubMcpCard) {
  return entry.config?.type === "remote" && entry.config.oauth !== false;
}
```

Adjust exact code to match the existing types in the file.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/app/src/app/pages/mcp.tsx packages/app/src/app/components/mcp-auth-modal.tsx packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/app/tests/components/mcp-auth-modal.test.ts
git commit -m "Clarify local Google MCP authorization"
```

## Task 6: Add Desktop E2E Coverage For Independent Install/Remove

**Files:**

- Add or modify: `packages/e2e/specs/google-mcp-connectors.spec.ts`
- Modify helper only if needed: `packages/e2e/helpers/*`

**Step 1: Write failing E2E test**

Create a desktop E2E spec that uses the real Tauri runtime and a stubbed Den catalog response with the three Google entries. The test should:

1. Start the app through the existing desktop E2E harness.
2. Open Extensions/MCP.
3. Verify Google Gmail, Calendar, and Drive cards are visible.
4. Install Gmail.
5. Verify Gmail appears in connected apps or configured apps.
6. Verify Calendar and Drive remain available/uninstalled.
7. Remove Gmail.
8. Verify Calendar and Drive are still available.

Use existing E2E helpers for startup, navigation, and screenshots. Do not start a Vite or web-only runtime.

**Step 2: Run E2E to verify it fails**

Follow `docs/dev/testing-playbook.md` preflight, then run the narrow spec:

```bash
pnpm --filter @neatech/veslo-e2e test -- --spec ./specs/google-mcp-connectors.spec.ts
```

Expected: FAIL until UI and stub wiring exist.

**Step 3: Implement minimal test fixture support**

If the E2E harness already supports Den fixtures, reuse it. If not, add only the smallest helper needed to serve:

```json
{
  "items": [
    { "id": "google-gmail", "name": "Google Gmail", "...": "..." },
    { "id": "google-calendar", "name": "Google Calendar", "...": "..." },
    { "id": "google-drive", "name": "Google Drive", "...": "..." }
  ]
}
```

Do not mock OpenCode MCP auth in this test; this is an install/remove/config test. Full Google OAuth should remain a manual or gated live test.

**Step 4: Run E2E to verify it passes**

Follow preflight again, then run:

```bash
pnpm --filter @neatech/veslo-e2e test -- --spec ./specs/google-mcp-connectors.spec.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/e2e/specs/google-mcp-connectors.spec.ts packages/e2e/helpers
git commit -m "Cover Google MCP connector install flow"
```

## Task 7: Document Runtime Semantics

**Files:**

- Modify: `docs/features/extensions-and-integrations.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Write docs update**

In `docs/features/extensions-and-integrations.md`, add a Google MCP section under MCP:

```md
### Google Workspace MCP Connectors

Veslo may show Google Gmail, Google Calendar, and Google Drive as platform
catalog MCP connectors. They are separate connector entries, not one broad
Google Workspace install.

The first version uses Google-managed remote MCP servers and local OpenCode MCP
OAuth. Veslo Cloud distributes connector metadata and Veslo-owned OAuth client
configuration. User Google refresh tokens are stored locally by the runtime and
are not stored in Veslo Cloud.

Authorization is per device. A connector that is available or installed from
catalog policy can still require local authorization on a new device.
```

In `docs/dev/state-and-config-reference.md`, document the new catalog metadata and state split:

```md
Google MCP catalog entries may include provider metadata and OAuth client
configuration for pre-registered remote MCP OAuth. This is connector metadata,
not a user token. User Google OAuth refresh tokens remain in the local OpenCode
MCP auth store for the MVP.
```

**Step 2: Run docs check**

Run:

```bash
git diff --check -- docs/features/extensions-and-integrations.md docs/dev/state-and-config-reference.md
```

Expected: no output.

**Step 3: Commit**

```bash
git add docs/features/extensions-and-integrations.md docs/dev/state-and-config-reference.md
git commit -m "Document Google MCP connector semantics"
```

## Task 8: Verify OAuth Against A Real Google Test App

**Files:**

- No required code files.
- Optional verification note: `docs/plans/2026-06-18-google-workspace-mcp-connectors-verification.md`

**Step 1: Prepare Google Cloud test app**

In the Veslo-owned Google Cloud project:

1. Enable Gmail API, Calendar API, Drive API.
2. Enable Gmail MCP API, Calendar MCP API, Drive MCP API.
3. Configure OAuth consent.
4. Create the OAuth client required by Google's MCP docs.
5. Add test users while the app is unverified.
6. Set local environment variables used by the installed config:

```bash
export VESLO_GOOGLE_MCP_CLIENT_ID="..."
export VESLO_GOOGLE_MCP_CLIENT_SECRET="..."
```

Do not commit these values.

**Step 2: Run desktop app with real runtime**

Follow `docs/dev/development-startup.md` fresh rebuild flow. Do not use `packages/web`, raw Vite, or `pnpm -w dev:ui`.

**Step 3: Install and authorize one connector**

Use Gmail first:

1. Open Extensions/MCP.
2. Install Google Gmail.
3. Reload the runtime if prompted.
4. Click Connect.
5. Complete Google OAuth in browser.
6. Confirm the UI returns to connected-local state.

**Step 4: Verify OpenCode sees auth status**

Use the real runtime path if available from the app, or run the equivalent local command in the workspace:

```bash
opencode mcp list
```

Expected: `google-gmail` shows authenticated/connected. If it reports missing OAuth client registration or unsupported auth, stop and revise the OAuth config path before implementing Calendar and Drive live checks.

**Step 5: Repeat for Calendar and Drive**

Authorize Calendar and Drive separately. Confirm one failed/revoked connector does not affect the others.

**Step 6: Record result**

If the check succeeds, add a short verification note with:

- Google Cloud project alias, not project secrets
- connector names tested
- commands run
- pass/fail result
- screenshots if useful

Do not include OAuth client secret, refresh tokens, raw auth JSON, or local auth-store contents.

## Final Verification

Run the full relevant verification set:

```bash
pnpm --filter @neatech/den test -- org-mcp-catalog.test.ts
pnpm --filter @neatech/den build
pnpm --filter veslo-server test -- server.hub-mcp.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter openwork-server build:bin
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-e2e test -- --spec ./specs/google-mcp-connectors.spec.ts
```

Because this changes `packages/server/src`, rebuild the server binary before relying on orchestrator-backed flows:

```bash
pnpm --filter openwork-server build:bin
```

If `openwork-server` is not the current package filter name, use the exact package name that owns `packages/server` in this checkout and update this plan before execution.

## Open Risks

- Google Workspace MCP APIs are Developer Preview, so endpoints or required OAuth behavior can change.
- Google's remote MCP servers may require pre-registered OAuth and may not support dynamic client registration. Keep the real OAuth verification task early.
- The OAuth client secret handling must not become user-token handling. If Google requires confidential-client behavior that cannot be safely supported from local desktop config, pause and redesign around a Veslo MCP gateway before beta.
- Public rollout depends on Google OAuth verification and possible restricted-scope security review.
