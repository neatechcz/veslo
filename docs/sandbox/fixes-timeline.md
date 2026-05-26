# Fixes timeline — chronologie commitů VSLO-86

Sekce dokumentuje **commity v pořadí**, jakými řešily multi-workspace
stabilizaci. Pro každý commit:

- **Symptom** — co uživatel viděl
- **Root cause** — proč to bylo
- **Fix** — co se konkrétně změnilo
- **Verification** — jak bylo ověřeno (E2E spec, API test, manuální klik)
- **Soubor(y)** — kde se to stalo

Všechny commity jsou na branchi `sandbox`. Pořadí je chronologické
(starší → novější).

Pro **vysvětlení problémů, které stále existují**, viz
[`known-issues.md`](known-issues.md). Pro **jak debugovat**, viz
[`debug-playbook.md`](debug-playbook.md).

## Pre-VSLO-86 (kontext)

| Commit | O čem |
|---|---|
| `4a48d783` | Vyčistit stale sidebar-session error při workspace re-activate |
| `f0fa9724` | Multi-workspace race + orchestrator activeId sync |
| `df5d0ffc` | `idleSuspendMs <= 0` = auto-suspend disabled (jinak engines hned suspended po ready → "Unable to connect") |
| `637256fe` | Trigger `ensureEngineForWorkspace` from browse mode (= ten samý fix, který jsem později REVERTOVAL — viz `b211e5a0`) |
| `9830cb77`, `1a31fa4e` | Workspace path validation v IPC commands (security) |
| `452307fc` | `realpath` v `resolveSafeChildPath` (blok symlink escape) |
| `e537b05f` | Strip client-supplied `x-opencode-directory` header |
| `35f49d39` | Lepší log pro spawn error/exit |
| `e810abea` | Cleanup stale `.tmp.*` state files při daemon startup |
| `e8d2982a` | **Tauri `stable_workspace_id` přepnut na sha1** (sjednocení s orchestrator) |

## Main VSLO-86 stabilizace (květen 2026)

### `1dffda5e` — Rust-side SSE proxy pro engine

**Symptom:** Po kliku na workspace každý další workspace v sidebaru
ukazoval `Error` badge, send se točil 60 s a AI neodpověděla.

**Root cause:** Tauri HTTP plugin v2 routuje fetch přes IPC kanál. Engine
SSE subscribe drží `fetch_read_body` invoke otevřený. Paralelní krátké
requesty (sidebar session listing × 4 workspaces) ve frontě → 60 s
client timeout → Error badge všude.

**Fix:** `packages/desktop/src-tauri/src/commands/engine_sse.rs` — Rust
se připojí na engine přes `reqwest`, parsuje SSE chunks, emit-uje
events přes Tauri event bus. UI jen `listen()`-uje.

**Verification:** Direct curl na engine vrátí ~70 ms; bez Rust proxy
UI hangl 60 s; s Rust proxy UI plynulé.

**Soubor:** `commands/engine_sse.rs` (new), `lib/engine-sse.ts` (new TS
wrapper).

### `c988a2c1` — workspace plugin vendoring + sandbox cleanup

**Symptom:** `Cannot find module '@opencode-ai/plugin' from .opencode/plugins/veslo-delegate.js`. Engine spawn fail. Také
`socket connection closed unexpectedly`.

**Root cause:**

1. Workspace `.opencode/plugins/veslo-delegate.js` importuje
   `@opencode-ai/plugin`. `Bun.resolve()` hledá `node_modules` z parent
   dirs od plugin file. Vendoring v `<configDir>/node_modules/`
   nepomáhalo, protože plugin v workspace dir musí najít v workspace
   tree.
2. Sandbox `allowWrite` měl `~/.bun/install/cache`, korelovalo s engine
   spawn failures.

**Fix:**

1. `internal_provision.rs` — vendoruje `@opencode-ai/plugin@1.15.10` +
   `zod@4.1.13` do `<workspace>/.opencode/node_modules/`, idempotentně.
2. Dropnut `~/.bun/install/cache` ze sandbox `allowWrite`.
3. `global-sdk.tsx` vráceno na SDK SSE path (Rust proxy bez auth
   crashlo) — pak fixnuto v `661d4475`.

**Soubor:** `workspace/internal_provision.rs`, `packages/orchestrator/src/cli.ts`,
`context/global-sdk.tsx`.

### `04a2ba75` — ID alignment + loopback wiring + auto-register

**Symptom:** Klik na workspace 404, sidebar Error badge, freeze, engine
spawn fail. Plus `opencode-router.log` se rozrostl na 97 MB protože
router pollne `192.168.1.203:51612/global/health` každou sekundu (daemon
naslouchá jen `127.0.0.1`).

**Root cause (3 problémy v jednom commitu):**

1. **Loopback wiring** — `resolve_connect_url(opencode_port)` v
   `veslo_server/mod.rs` vrací LAN IP (`http://192.168.1.203:51612`).
   Daemon binduje jen `127.0.0.1`. Router + veslo-server dostali
   unreachable URL.
2. **Workspace auto-register do orchestratoru** — Tauri local state má
   4 workspaces, orchestrator zná jen ty, které byly explicitně
   activated. Klik na neznámý workspace → 404 → 30 s timeout.
3. **ID schema mismatch** — veslo-server `sha256/ws_`, orchestrator
   `sha1/ws-`, Tauri `sha1/ws-`. Cross-system lookups silently 404.

**Fix:**

1. Hardcoded `http://127.0.0.1:{port}` v `commands/engine.rs:830,1043`.
2. `register_workspace_with_orchestrator` helper + `reconcile_orchestrator_workspaces`
   volaný po daemon + server + router boot v `engine_start`.
3. Veslo-server `workspaceIdForPath` přepnut na `sha1/ws-`
   (`packages/server/src/workspaces.ts`).

**Verification:** Po restartu orchestrator `/health` vrátí
`workspaceCount=4`, veslo-server `/workspaces` vrátí items s `ws-`
prefix a loopback baseUrl, sidebar bez Error badge.

**Soubor:** `commands/engine.rs`, `commands/orchestrator.rs`,
`packages/server/src/workspaces.ts`.

### `2dac2a81` — port 8787 reclamation v1

**Symptom:** Po `pnpm dev` rebuild se nový veslo-server objevil na
random portu (62130) místo 8787. Workspace `opencode.jsonc` má
`baseURL: 8787` → engine pointuje na dead address → AI gateway 401.

**Root cause:** Předchozí veslo-server přežil Tauri main restart (shell
plugin nedělá Drop-on-kill na child) a držel 8787. Nový server `bind`
selhal → fallback random.

**Fix:** Pokud 8787 busy, `lsof` listenera, ověř jestli PID je
`veslo-server` nebo `bun --watch src/cli.ts`, SIGTERM/SIGKILL, retry.
Random fallback zůstává pro genuine third-party konflikty.

**Soubor:** `packages/desktop/src-tauri/src/veslo_server/spawn.rs`.

### `bdccc0c6` — full restart-stability (4 fixy v jednom)

**Symptom:** Across cargo rebuild + Tauri restart cykly veslo-server
landoval na random ephemeral portu; sidebar klik visel na "Opening
conversation…"; engine literálně posílal `"[REDACTED]"` jako Den
gateway token → 401.

**Root cause (4 problémy v jednom commitu):**

1. **Aggressive zombie reaping** — Tauri shell plugin nezabíjí children
   na Drop. Předchozí `bun --watch` přežívá Tauri main restart, drží
   random port, 8787 socket lingers v TIME_WAIT.
2. **Veslo-server spawne se všemi local workspaces** — frontend předával
   jen aktivní workspace v `engine_start`; fresh server znal jen 1 entry.
3. **Symetrický reconcile na engine_start** — `reconcile_server_workspaces`
   se volá vždy, ne jen na fresh spawn.
4. **Stop redactovat `x-veslo-gateway-token`** — `isSensitiveConfigKey`
   v `server.ts` redactoval header na `[REDACTED]`. Round-trip
   `getConfig` → `formatManagedAiAccessConfig` → `patchConfig` echo-uje
   literal zpět do `opencode.jsonc`.

**Fix:**

1. `list_stale_veslo_server_pids` v `veslo_server/spawn.rs` + retry bind
   8787 do ~3s pro TIME_WAIT recovery.
2. `start_veslo_server` načte `veslo-workspaces.json` a rozšíří workspace
   list před spawn.
3. `reconcile_server_workspaces` v `engine.rs` volán vždy, ne jen po
   úspěšné start.
4. `isSensitiveConfigKey` v `server.ts` allowlist `xveslogatewaytoken`.

**Verification:** 3 back-to-back Tauri restarty → orchestrator
`workspaceCount=4` ihned, veslo-server `/workspaces` ihned 5 items,
sidebar bez Error badge, 3-clicks test 3/3 PASS.

**Soubor:** `veslo_server/spawn.rs`, `veslo_server/mod.rs`, `commands/engine.rs`,
`workspace/server_client.rs`, `packages/server/src/server.ts`.

### `d1bd61d8` — widen activate timeout + reconcile health wait

**Symptom:** Po `pnpm dev` boot frontend auto-aktivuje default workspace
B, `activateVesloHostWorkspace` hits 12 s timeout, fallback `startHost`
→ další ~minuta cold engine spawn = "freeze 60 s".

**Root cause:**

1. `reconcile_server_workspaces` POSTuje `/workspaces/local` před tím,
   než bun stihl listen → "Connection refused" → registry prázdný →
   sidebar 404.
2. 12 s timeout je málo. Direct curl `< 30 ms`, ale Tauri HTTP plugin
   queue past 12 s při bootu.

**Fix:**

1. `reconcile_server_workspaces` poll `/health` až 5 s před POSTy.
2. `vesloHostWorkspaceActivateMs` rozšířen z 12 s na 30 s.

**Verification:** Multi-workspace-restart spec 5/5 PASS přes 3 běhy.

**Soubor:** `workspace/server_client.rs`, `app/utils/workspace-switch-timeouts.ts`,
nový `packages/e2e/specs/multi-workspace-restart.spec.ts`.

### `661d4475` — Bearer SSE proxy pro global SDK

**Symptom:** V console 30+ timeoutů během prvních 60 s po boot:
`/health` × 6 (3 s), `/soul/status` × 4 (10 s), `/config` PATCH × 3
(10 s), atd. Engine SSE 502, `WorkspaceClientStaleError`.

**Root cause:** `global-sdk.tsx` měl SDK event subscription přes
`tauriFetch`. Tauri HTTP plugin v2 routuje fetch přes IPC kanál; SSE
stream drží kanál → krátké requesty timeoutují.

Engine SSE už byl přes Rust proxy (commit `1dffda5e`), ale Rust proxy
podporoval jen Basic auth. Veslo-server vyžaduje Bearer → předchozí pokus
401 reconnect loop → revert.

**Fix:** Rust `engine_sse.rs` rozšířen o `bearer_token` field. Když set,
posílá `Authorization: Bearer <token>` místo Basic. `global-sdk.tsx`
v Tauri runtime subscribe přes `engineSseSubscribe` s cached
veslo-server tokenem.

**Verification:** Console timeouty na boot vymizely.

**Soubor:** `commands/engine_sse.rs`, `lib/engine-sse.ts`, `context/global-sdk.tsx`.

### `eff94c02` — orchestrator IPC async + spawn_blocking

**Symptom:** Po prvním kliku na workspace D (rychlé, ~500 ms) druhý klik
na A visel 30 s s prázdným spinnerem. `browser.execute` přes WebDriver
také visel 30 s (= IPC channel blocked).

**Root cause:** `orchestrator_workspace_activate` declared as `pub fn`
(synchronní). Tauri schedulet sync commands na command runtime threadu;
`ureq::post` blokuje thread pro celý HTTP exchange. Další IPC ve frontě
30 s.

**Fix:** `pub async fn` + `tauri::async_runtime::spawn_blocking` pro
2 ureq POSTy. Command thread se hned vrátí; HTTP práce na blocking pool
threadu.

**Verification:** 3-clicks spec proti pnpm dev, 3× po sobě:
Run 1-3 každý 3/3 pass, ~0.5 s per klik.

**Soubor:** `commands/orchestrator.rs`, nový
`packages/e2e/specs/pnpm-dev-3-clicks.spec.ts`.

### `b211e5a0` — stop eager engine spawn on browse-mode activate

**Symptom:** Po `pnpm dev` boot spinner "Otevírám konverzaci…" 30-60 s
i bez explicit user akce. Pavel: "Apka naběhla a nic to nedělá".

**Root cause:** `STEP 5-BROWSE` v `workspace.ts:1241` (původně) fired
`void ensureEngineForWorkspace()` na každý sidebar klik — včetně
auto-activate posledního workspace při bootu. To kicks off full engine
bootstrap (sandbox-exec + opencode serve = 30-60 s) pro workspace, který
chce uživatel jen prohlížet.

**Fix:** Drop eager call. `sendPrompt` v `app.tsx` už volá
`ensureEngineForWorkspace` + `ensureManagedAiBootstrapReady` před send,
takže engine spawne při první real interakci, ne každém pasivním kliku.

**Verification:** `boot-freeze.spec.ts` (new) — 3 back-to-back boot, no
clicks, time-to-interactive **9-19 ms**, spinner 0 ms, 0 error badges.
Předtím 30-60 s spinner per boot.

**Soubor:** `context/workspace.ts:1224-1243`, nový
`packages/e2e/specs/boot-freeze.spec.ts`.

### `60c5d93d` — selectSession offline-first v browse mode

**Symptom:** Pasivní klikání mezi workspaces / sessions stále občas
spawnovalo engine. Pavel: "Najednou zelený puntík u B, ale já jsem tam
nic neposlal." Engine fail → 502 cascade → "Unable to connect".

**Root cause:** `selectSession` v `session.ts` volal
`c.session.messages({...})` přes cached SDK klienta. Klient zustal
z předchozí activate nebo `dev-autostart`, takže SDK volání trigger-uje
orchestrator `pool.ensure` → cold sandbox spawn.

**Fix:**

1. `session.ts` — `selectSession` čte nový `engineReady()` signal.
   V browse mode (engineReady=false) jde do `loadOfflineTranscript`
   fallback (= DB čtení) místo SDK.
2. `workspace.ts` — `setEngineReady(false)` přesunut **před** DB hydrate
   v STEP 5-BROWSE, jinak hydrate-driven selectSession čte stale
   engineReady=true.
3. `app.tsx` — vthread `engineReady: () => engineReady()` do session store
   options.

**Verification:** `browse-no-engine-spawn.spec.ts` (new) — boot + klik
4 workspaces + klik session = **0 engine procesů** v celém flow.

**Soubor:** `context/session.ts`, `context/workspace.ts`, `app/app.tsx`,
nový `packages/e2e/specs/browse-no-engine-spawn.spec.ts`.

## Souhrn — co je dnes (květen 2026) opraveno

| Oblast | Stav |
|---|---|
| Sidebar 404 silently | ✅ Sjednocené ID schémata |
| Boot freeze | ✅ No eager engine spawn |
| Click freeze (2. workspace) | ✅ Async orchestrator IPC |
| Engine SSE 60 s timeout | ✅ Rust SSE proxy (Basic + Bearer) |
| Engine spawn s LAN IP | ✅ Loopback wiring |
| Token rotation cascade | ✅ `[REDACTED]` allowlist + zombie reaping |
| Browse mode spawns engine | ✅ selectSession offline-first |
| AI inference test | ✅ C, A, B, D PONG přes API + UI |

## Co stále **neopravené**

Viz [`known-issues.md`](known-issues.md) a [`handoff.md`](handoff.md):

- AI gateway preflight 30 s timeout (chybí cache)
- WorkspaceClientStaleError jako unhandled rejection
- Reactive cascade ve frontendu (chybí state machine)
- Engine cold start 30-60 s (OpenCode upstream issue)
- Logy roztroušené napříč 5 místy
