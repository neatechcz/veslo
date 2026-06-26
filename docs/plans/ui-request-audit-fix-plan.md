# Plán: Audit a náprava UI requestů bez controllera/ownera

## Context

Deep audit odhalil 3 vrstvy problémů v komunikaci UI ↔ backend:

1. **KRITICKÝ**: 19 routes pro Telegram/Slack identities vrací 404 — klient (`veslo-server.ts`) volá prefix `/veslo-code-router/`, server (`server.ts`) registruje `/opencode-router/`. Stránka `identities.tsx` je kompletně nefunkční.
2. **MEDIUM**: `server.ts` je 12 967řádkový monolit se 163 routes bez jakéhokoli doménového rozdělení — kdokoliv chce pochopit danou feature, musí scrollovat tři tisíce řádků.
3. **LOW**: ~15 admin/interních routes nemá žádný UI caller ani dokumentovaného ownera.

**Cíl**: jedno doménové soubor = jeden owner = jeden namespace. Vzor podle `services/den/src/` (20+ souborů, doménově organizovaných). Server používá vlastní Bun routing systém (`addRoute`/`matchRoute`), takže vzor bude `registerXxxRoutes(routes, deps)` vracející pole route definic.

---

## Fáze 1 — Fix kritického prefix mismatche (~30 minut)

**Riziko: NÍZKÉ. Dotek jednoho souboru.**

**Vítěz jména: `/opencode-router/`** — server je v tomto konzistentní (2 proxy bloky, 13 addRoute volání, env proměnné `OPENCODE_ROUTER_*`, config soubor `opencode-router.json`). npm package name `veslo-code-router` je produktová vrstva, neovlivňuje HTTP routing.

**Akce**: V `packages/app/src/app/lib/veslo-server.ts` nahradit všech 19 výskytů `/veslo-code-router/` → `/opencode-router/` ve URL path stringách.

Konkrétní řádky: 2593, 2599, 2610, 2612, 2859, 2876, 2888, 2895, 2906, 2925, 2933, 2944, 2962, 2977, 2988, 3024, 3028, 3029, 3057.

**Neměnit**: `package.json` name, binaries, Rust source files, orchestrator refs, `identities.tsx` (ref je file path do workspace, ne URL).

**Verifikace**: Otevřít Identities page → health check + identity listings musí odpovídat HTTP 200.

---

## Fáze 2 — Routing primitives (foundation, ~2 hodiny)

**Riziko: NÍZKÉ. Zero behavior change, čistě strukturální.**

### 2a. Vytvořit `packages/server/src/routing.ts`

Přesunout z `server.ts`:
- `type AuthMode`
- `interface Route`
- `interface RequestContext`
- `function pathToRegex(path, keys)`
- `function addRoute(routes, method, path, auth, handler)`
- `function matchRoute(routes, method, path)`

### 2b. Vytvořit `packages/server/src/route-helpers.ts`

Přesunout z `server.ts` pure/context-only funkce:
- `scopeRank`, `requireClientScope`, `ensureWritable`
- `resolveWorkspace`, `isAuthorizedRoot`, `isAuthorizedRootSync`
- `requireApproval`, `requireSoulApproval`
- `emitReloadEvent`
- `readJsonBody`, `readOptionalJsonBody`, `jsonResponse`
- Body parsing utilities (`readRequestTextWithLimit`, `readMaxBytes`, atd.)

### 2c. Přidat `ServerRouteDeps` typ do `server.ts`

Typ popisuje veškerý closure state uvnitř `createRoutes()` — každý doménový soubor dostane pouze `Pick<ServerRouteDeps, K>` slice který potřebuje:

```typescript
type ServerRouteDeps = {
  serverDataDir: string;
  fileSessions: FileSessionStore;
  sessionArchives: ReturnType<typeof createSessionArchiveStore>;
  conversationService: ReturnType<typeof createConversationService>;
  conversationRunQueueStore: ReturnType<typeof createConversationRunQueueStore>;
  lifecycleClient: OrchestratorLifecycleClient | null;
  sessionTranscriptPrefetch: ReturnType<typeof createSessionTranscriptPrefetchStore>;
  serializeWorkspaceForResponse: (w: WorkspaceInfo) => unknown;
  resolveFileSession: (ctx: RequestContext, sessionId: string) => { session: any; workspace: WorkspaceInfo };
  recordWorkspaceFileEvent: (...) => void;
  scheduleConversationQueueDrain: (...) => void;
  loadConversationTranscriptResponse: (...) => Promise<unknown>;
  readOrganizationSoulModel: (ctx: RequestContext) => Promise<unknown>;
  readUserSoulModel: (ctx: RequestContext) => Promise<unknown>;
  readWorkspaceSoulModel: (ctx: RequestContext, workspace: WorkspaceInfo) => Promise<unknown>;
};
```

**Validace po Fázi 2**: `pnpm --filter veslo-server typecheck` musí projít clean.

---

## Fáze 3 — Doménová extrakce (incremental, ~2h/doménu)

Všechny doménové soubory v `packages/server/src/routes/`. Každý exportuje `registerXxxRoutes(routes: Route[], deps: XxxDeps)`.

**Vzor**:

```typescript
// packages/server/src/routes/opencode-router.ts
import { type Route, addRoute } from "../routing.js";
import { ensureWritable, requireClientScope, resolveWorkspace, readJsonBody, jsonResponse } from "../route-helpers.js";

export function registerOpenCodeRouterRoutes(routes: Route[]): void {
  addRoute(routes, "POST", "/workspace/:id/opencode-router/telegram-token", "client", async (ctx) => {
    ensureWritable(ctx.config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(ctx.config, ctx.params.id);
    // ... identický handler body ...
  });
  // + 12 dalších routes
}
```

V `createRoutes()` na konci:
```typescript
import { registerOpenCodeRouterRoutes } from "./routes/opencode-router.js";
registerOpenCodeRouterRoutes(routes);
```

**Validace po každé doméně**: typecheck + build + ruční test jednoho endpointu dané domény.

### Pořadí extrakce (nejnižší → nejvyšší riziko)

| Krok | Soubor | Routes | Lines v server.ts | Deps |
|---|---|---|---|---|
| 3a | `routes/opencode-router.ts` | 13 | 7205–8077 | none (vše přes `ctx`) |
| 3b | `routes/automations.ts` | ~10 + agentlab | 10367–10702 | `automationRunner` přes `ctx` |
| 3c | `routes/soul.ts` | 14 | 10734–11252 | `Pick<…, "serverDataDir" \| soul helpers>` |
| 3d | `routes/skill-registry.ts` | ~15 | 8777–9066 | none |
| 3e | `routes/skills-global.ts` | ~15 | 9302–9676 | `Pick<…, "serverDataDir">` |
| 3f | `routes/skills-workspace.ts` | ~10 | 9676–10012 | none |
| 3g | `routes/plugins.ts` | 3 | 8703–8776 | none |
| 3h | `routes/mcp.ts` | 7 | 10013–10284 | none |
| 3i | `routes/commands.ts` | 4 | 10285–10366 | none |
| 3j | `routes/conversations.ts` | 8 | 6654–7013 | `Pick<…, "conversationService" \| "…">` |
| 3k | `routes/sessions.ts` | 4 | 7014–7161 | `Pick<…, "sessionTranscriptPrefetch" \| "…">` |
| 3l | `routes/file-sessions.ts` | ~12 | 8239–8702 | `Pick<…, "fileSessions" \| "…">` |
| 3m | `routes/health.ts` | 6 | 6083–6131 | none |
| 3n | `routes/workspace-management.ts` | ~10 | 6131–6376 | `Pick<…, "serializeWorkspaceForResponse">` |
| 3o | `routes/session-archives.ts` | 3 | 6318–6375 | `Pick<…, "sessionArchives">` |
| 3p | `routes/ai-gateway.ts` | 4 | 6376–6437 | none |

Po dokončení: `server.ts` se zmenší z ~13 000 na ~2 000 řádků (zůstane jen bootstrap, shared state creation, middleware, fetch handler dispatch).

---

## Fáze 4 — Admin/orphaned routes (~30 minut)

**Riziko: NÍZKÉ. Pouze dokumentace a přesun, žádná routes se neruší.**

Vytvořit `packages/server/src/routes/admin.ts` s hlavičkou:

```typescript
/**
 * @domain admin
 * @owner platform-infra: /tokens, /whoami
 * @owner workflow-engine: /approvals
 * @owner skills-platform: skill rollout policies, registry events, user-global-store, materialization sync
 *
 * AUDIT: Žádná z těchto routes NENÍ volána žádným production UI v packages/app.
 * Mohou být volány: CLI skripty, Den service, interní automace, integrační testy.
 * Před odstraněním route provést grep celého monorepa.
 */
```

Routes do `admin.ts`:
- `GET|POST|DELETE /tokens`
- `GET /whoami`
- `GET|POST /approvals`, `POST /approvals/:id`
- `POST /v1/skill-review-requests/:requestId/approve` a `.../reject`
- `GET|POST|DELETE|PATCH /v1/skill-rollout-policies`
- `GET /v1/skill-registry-events`
- `GET|POST|DELETE /skills/user-global-store`
- `GET|POST /skills/materialization`
- `GET|POST /workspace/:id/skills/materialization`

AgentLab routes (`/workspace/:id/agentlab/automations/*`) zůstanou v `automations.ts` s anotací `// @internal: toy-ui only, no production UI callers`.

---

## Fáze 5 — Client-side domain grouping (VOLITELNÉ, nižší priorita, ~4h)

Plochý objekt `VesloServerClient` (~80 metod) přeorganizovat na doménové namespace:

```typescript
return {
  // Legacy flat API (deprecated, zachovat pro přechod)
  health: () => ...,
  
  // Nové domain namespaces
  openCodeRouter: { health, bindings, telegramIdentities, slackIdentities, ... },
  conversations: { list, create, getTranscript, submitRun, abort },
  skills: { list, resolve, hubInstall, delete, batchRemove, ... },
  soul: { getOrg, getUser, getWorkspace, patchOrg, ... },
  // ...
}
```

**Doporučení: odložit na po stabilizaci Fází 1–4.** Server-side cíl "jeden domain = jeden soubor" je plně dosažitelný bez doteku klientského kódu.

---

## Soubory celkem

**Modifikované:**
- `packages/app/src/app/lib/veslo-server.ts` — Fáze 1 (19 string replacements)
- `packages/server/src/server.ts` — Fáze 2–3 (postupná extrakce; ~13 000 → ~2 000 řádků)

**Vytvořené:**
- `packages/server/src/routing.ts`
- `packages/server/src/route-helpers.ts`
- `packages/server/src/routes/opencode-router.ts`
- `packages/server/src/routes/automations.ts`
- `packages/server/src/routes/soul.ts`
- `packages/server/src/routes/skill-registry.ts`
- `packages/server/src/routes/skills-global.ts`
- `packages/server/src/routes/skills-workspace.ts`
- `packages/server/src/routes/plugins.ts`
- `packages/server/src/routes/mcp.ts`
- `packages/server/src/routes/commands.ts`
- `packages/server/src/routes/conversations.ts`
- `packages/server/src/routes/sessions.ts`
- `packages/server/src/routes/file-sessions.ts`
- `packages/server/src/routes/health.ts`
- `packages/server/src/routes/workspace-management.ts`
- `packages/server/src/routes/session-archives.ts`
- `packages/server/src/routes/ai-gateway.ts`
- `packages/server/src/routes/admin.ts`

---

## Verifikace end-to-end

1. **Fáze 1**: Otevřít Identities page → Telegram/Slack identities se načtou, health check vrátí 200
2. **Po každé Fázi 3.x**: `pnpm --filter veslo-server typecheck` + `pnpm --filter veslo-server build:bin` + ruční test route z dané domény
3. **Celková regresní kontrola**: spustit E2E testy (`packages/e2e/`) po dokončení Fáze 3p
