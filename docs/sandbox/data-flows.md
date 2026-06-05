# Data flows — co se kde děje při klíčových akcích

Tenhle dokument trasuje **konkrétní cesty** v živé aplikaci přes všech
6 procesů popsaných v [`architecture.md`](architecture.md). Cíl je
ukázat, kdo kdy co volá, kde mohou věci selhat, a kterým logem to
poznat.

Konvence v sekvenčních diagramech:

- `UI` = Tauri webview (SolidJS)
- `Rust` = Tauri Rust shell
- `Server` = veslo-server (port 8787)
- `Daemon` = orchestrator daemon (random port)
- `Engine` = OpenCode engine (per workspace; macOS `sandbox-exec`, Windows
  WSL2 + `bwrap`)
- `Managed AI` = nakonfigurovaný managed-AI backend. Aktuální produkční
  default je standalone AI Gateway na owned serveru (`https://ai.veslo.work`);
  Den pořád zajišťuje browser/app auth a může být fallback nebo zdroj user
  bearer tokenu.

Poznámka k owned-server změně: starší VSLO-86 commity a logy často používají
`Den` jako zkratku pro managed-AI cloud. V aktuálním kódu desktop/orchestrator
směřuje managed-AI default na `https://ai.veslo.work`; lokální engine pořád
volá jen lokální `veslo-server` proxy `/ai-gateway/*`.

## Flow 1 — Boot (spuštění `pnpm dev`)

```
pnpm dev
   │
   ▼
[Vite dev server na :5173]            ← UI assets
[Cargo build veslo binárky]           ← Tauri Rust shell
   │
   ▼
spawn Rust main (target/debug/veslo)
   │
   ├── otevře okno, load webview z http://localhost:5173
   │
   └── dev-autostart thread (1.5s delay)
       │
       └── engine_start (commands/engine.rs:510)
           │
           ├── spawn orchestrator daemon  → port X (random)
           │   wait pro /health
           │
           ├── start_veslo_server         → port 8787 (nebo random fallback)
           │   wait pro /health
           │
           ├── reconcile_server_workspaces (zkopíruje workspaces z Tauri state)
           │
           ├── opencodeRouter_start       → router (random port)
           │
           └── reconcile_orchestrator_workspaces (zkopíruje workspaces do daemonu)
```

Webview mezitím:

```
SolidJS shell mount
   │
   ▼
bootstrapOnboarding (context/workspace.ts)
   │
   ├── workspaceBootstrap (Tauri IPC) — načte 4 workspaces z Tauri local state
   ├── reconcileVesloServerWorkspaces — JS-side sync (idempotentní s Rust reconcile)
   ├── refreshEngine / refreshEngineDoctor
   ├── validateDenAuth (cloud check, background)
   └── activate last-active workspace
       └── STEP 1-5 (viz Flow 2)
```

**Co kdy bývá hotové (po fixech VSLO-86):**

| Čas | Stav |
|---|---|
| ~0 s | Vite + cargo build dokončen |
| ~2-3 s | Tauri okno otevřené, sidebar renderovaný |
| ~3-5 s | veslo-server + orchestrator daemon listening |
| ~5 s | Composer je interaktivní (`engineReady=false` v browse mode) |

**Žádný engine se nespawne** dokud uživatel nepošle zprávu. Verifikováno
testem `packages/e2e/specs/browse-no-engine-spawn.spec.ts` (3/3 PASS).

## Flow 2 — Klik na workspace v sidebaru (browse mode)

```
UI klik na workspace D
   │
   ▼
workspace.ts ::activate(workspaceId=D)
   │
   ├── STEP 1 syncActiveWorkspaceId + setProjectDir
   │   (změna SolidJS signálu activeWorkspaceId)
   │
   ├── STEP 2 workspaceVesloRead       — Tauri IPC, čte .opencode/veslo.json
   │
   ├── STEP 3 workspaceSetActive       — Tauri IPC, zapíše Tauri local state
   │
   ├── STEP 4 branch decision          — vybere mezi 5a (remote→local), 5b (local→local restart), 5-BROWSE
   │
   └── STEP 5-BROWSE                   ← tahle větev v browse mode
       │
       ├── setEngineReady(false)       — VSLO-86: musí být PŘED hydrate, jinak selectSession zavolá SDK
       │
       ├── populateSidebarFromDb       — Tauri IPC, načte sessions z SQLite cache
       │
       ├── hydrateLatestSessionFromDb  — Tauri IPC, načte poslední session transcript z SQLite
       │
       └── updateWorkspaceConnectionState(connected)
           — STEP 5-BROWSE konec, žádný engine spawn, žádné SDK volání

   ▼
FINALLY clearing connectingWorkspaceId
```

**Trvání po fixu:** ~100-400 ms. Žádný engine není spuštěný, žádný spinner
"Otevírám konverzaci…", žádný 502 cascade.

**Pred fixem `b211e5a0`:** STEP 5-BROWSE volalo `void ensureEngineForWorkspace()`
fire-and-forget. To trigger cold engine spawn (30-60 s) i pro workspace,
který chce uživatel jen prohlížet. UI vypadalo zaseknuté.

## Flow 3 — Klik na session v sidebaru (browse mode)

```
UI klik na session v sidebaru
   │
   ▼
session.ts ::selectSession(sessionID)
   │
   ├── setSelectedSessionId(sessionID)
   │
   ├── setMessageLoadBusyBySession[sessionID] = true    ← "Načítám" spinner ON
   │
   ├── browseModeOnly = !options.engineReady()           ← VSLO-86 fix
   │
   ├── IF !c || browseModeOnly:                         ← cesta v browse mode
   │   │
   │   ├── loadOfflineTranscript(sessionID, limit)
   │   │   │
   │   │   └── lib/db-reader.ts ::readTranscriptFromDb
   │   │       — čte přímo OpenCode SQLite DB
   │   │       — žádné SDK, žádný engine spawn
   │   │
   │   └── hydrateTranscriptSnapshot(snapshot)
   │
   └── setMessageLoadBusyBySession[sessionID] = false   ← spinner OFF
```

**Trvání po fixu:** ~50-200 ms (DB read je rychlý). Engine count: 0.

**Před fixem `60c5d93d`:** šlo se do `else` větve a volalo
`c.session.messages({sessionID})` přes OpenCode SDK. Klient byl
nakešovaný z předchozí session (nebo z `dev-autostart`), takže SDK
volání šlo orchestrator proxy → `pool.ensure` → cold engine spawn
(30-60 s). Symptom: zelené kolečko (= engine ready) se v UI rozsvítilo
u workspace, do kterého uživatel jen klikl na session, ale neposlal
žádnou zprávu — engine se spawnoval na klik session.

## Flow 4 — Send message (první v session, cold engine spawn)

```
UI uživatel napíše text + klik Send
   │
   ▼
app.tsx ::sendPrompt
   │
   ├── IF !engineReady():                               ← první send v workspace
   │   │
   │   ├── setBusy(true) + setBusyLabel("status.connecting")
   │   │
   │   └── workspaceStore.ensureEngineForWorkspace
   │       │
   │       └── restartWorkspaceRuntime (lifecycle.ts)
   │           │
   │           ├── activateOrchestratorWorkspace
   │           │   │
   │           │   ├── orchestrator_workspace_activate (Tauri IPC, async + spawn_blocking)
   │           │   │   │
   │           │   │   └── HTTP POST /workspaces + POST /workspaces/:id/activate
   │           │   │       (na orchestrator daemon)
   │           │   │
   │           │   └── activateVesloHostWorkspaceWithTimeout (30 s)
   │           │       │
   │           │       └── client.activateWorkspace
   │           │           └── HTTP POST /workspaces/:id/activate
   │           │               (na veslo-server, host token)
   │           │
   │           └── readEngineInfo (poll na engine baseUrl, 30 s timeout)
   │
   ├── ensureManagedAiBootstrapReady                    ← AI access preflight
   │   │
   │   └── HTTP GET /ai-gateway/me/ai-access (na veslo-server)
   │       — veslo-server forwarduje na configured managed-AI gateway
   │         (`/api/me/ai-access`; default `https://ai.veslo.work`)
   │
   ├── routedClient() → guarded klient k engine přes orchestrator proxy
   │
   ├── c.session.create   ← Engine vytvoří session
   │   │
   │   └── HTTP POST /workspace/<wsId>/opencode/session
   │       (na orchestrator daemon, proxy na engine)
   │       │
   │       └── orchestrator pool.ensure(<wsId>)         ← TADY první engine spawn!
   │           │
   │           ├── spawn opencode child přes WorkerSandbox
   │           │   (macOS sandbox-exec, Windows WSL2 + bwrap)
   │           ├── waitForHealthy (~30-60 s cold start)
   │           └── proxy POST na engine
   │
   ├── c.session.message  ← Engine pošle prompt
   │   │
   │   └── engine interně volá veslo-server AI gateway:
   │       HTTP POST http://127.0.0.1:8787/ai-gateway/providers/codex_oauth/v1/chat/completions
   │       │
   │       └── veslo-server forwarduje na configured managed-AI gateway
   │           managed-AI gateway → vlastní AI provider (OpenAI/Anthropic/Codex)
   │
   └── engine SSE events (přes Rust proxy) populují UI
       │
       └── setMessagesForSession(sessionID, msgs) v realtime
```

**Trvání cold first message:** **30-60 s** (engine cold start) + ~3-10 s
AI inference. Subsequent messages v stejném workspace: ~3-10 s (engine
už běží).

**Co může selhat (a kde to vidíš):**

| Symptom | Místo | Důvod |
|---|---|---|
| 30 s freeze před engine ready | `pool.ensure` v daemonu | Sandbox init (`sandbox-exec` na macOS, WSL2 + bwrap na Windows) + Bun JIT cold |
| 502 Bad Gateway na `/opencode/*` | Orchestrator proxy | Engine spawn fail (`Unable to connect`) |
| Direct orchestrator health 200, ale `:8787/workspace/.../health` 500/502 | `veslo-server` proxy | Base path dropped nebo Bun `fetch` zlib; neřešit WSL routing |
| WSL engine log končí na `Failed to fetch models.dev` před `server listening` | bwrap DNS | `/etc/resolv.conf` symlink target není bindnutý do sandboxu |
| Health přes `127.0.0.1:<engine-port>` timeout, přes WSL IP 200 | WSL host route | Windows localhost forwarding flaky; použít `connectHost` WSL guest IP |
| `WorkspaceClientStaleError` | Guard proxy v `workspace-routing.ts:59` | Uživatel přepnul workspace během SDK call |
| `Timed out waiting for session.messages` | `withTimeout` 12 s v session.ts:965 | Engine pomalý / mrtvý |
| AI gateway 401 | Veslo-server `/ai-gateway/...` | Stale gateway token v opencode.jsonc, nebo expired caller/gateway auth (typicky Den bearer token nebo managed-AI access token) |

Pokud managed-AI gateway nedostala request, prompt se zastavil lokálně.
Neřeš model backend, dokud engine health a lokální provider request nejsou
potvrzené.

## Flow 5 — Workspace switch během běžícího sendu

Klíčový edge case. Uživatel klikne na workspace B, pak ihned na A.

```
T=0 ms   UI klik B → activate B → STEP 1-5 OK
T=200 ms UI: setSelectedSessionId změní (route effect)
         → selectSession(B-session-id) FIRES
T=400 ms UI klik A → activate A → STEP 1
         setActiveWorkspaceId(A)
T=410 ms selectSession (B) ještě běží — drží referenci na c (= B client z routing)
T=420 ms c.session.messages() FIRES
         — guard proxy v workspace-routing.ts:59 čte getActiveWsId() = A
         — anchored entryWsId = B
         — A !== B → throws WorkspaceClientStaleError
         → Promise rejection (catch v selectSession → addError → spinner OFF)
T=500 ms STEP 5-BROWSE pro A doběhne, A je aktivní, sidebar OK
```

**Tohle není bug** — guard záměrně chrání proti zápisu do špatného
workspace. Ale **každý** stale call vyhodí v console
`Unhandled Promise Rejection`. V Pavlově console logu jsi viděl
desítky těchto, protože při rychlém přepínání workspaces selectSession
race-uje s activate.

Možné zlepšení (zatím není implementováno):

- Catchovat `WorkspaceClientStaleError` v `selectSession` a logovat
  jako `info`, ne unhandled rejection.
- Pasivně cancelovat běžící SDK promise při workspace switch (přes
  AbortController předaný do SDK).

## Flow 6 — Stale token rotation (po restartu pnpm dev)

```
pnpm dev restart
   │
   ▼
veslo-server respawn → nový token client_token = T2
   │
   ▼
opencode.jsonc na disku má pořád starý apiKey = T1
engine pro workspace má v paměti starý apiKey = T1 (z předchozí spawn session)
   │
   ▼
UI activate workspace → reconcileManagedAiApiKeys (app.tsx, řádek ~8000)
   │
   ├── client.getConfig(wsId)               — vrátí opencode obsah s apiKey=T1
   ├── formatManagedAiAccessConfig         — vyrobí nový obsah s apiKey=T2
   ├── client.patchConfig(wsId, content)   — server zapíše do opencode.jsonc
   │
   └── shouldAutoReloadManagedAiConfig?
       │
       └── reloadWorkspaceEngine  → orchestrator dispose engine → respawn s novým token
```

**Důležité fixy v této oblasti:**

- `bdccc0c6` (`workspaceIdForPath` sjednoceno na `ws-<sha1[:12]>`)
- `bdccc0c6` (server přestal redactovat `x-veslo-gateway-token` v config response)
- `2dac2a81` (port 8787 reclamation — token recovery přes state.json)

Bez nich token rotation tichá selhala, engine zůstal s `[REDACTED]`
nebo starým tokenem, AI gateway vrátil 401.

## Příště rozšířit

Tahle data-flows pokrývají jen happy path + nejčastější edge case.
Další scénáře k popsání (TODO pro nového vývojáře):

- Flow 7: Reload session během aktivního AI streamu (compact, abort)
- Flow 8: Engine crash recovery (idle suspend → respawn)
- Flow 9: Veslo-server respawn (token rotation kaskáda)
- Flow 10: Workspace create from UI (Add directory)
