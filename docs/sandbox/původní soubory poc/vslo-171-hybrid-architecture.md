# VSLO-171 + VSLO-86 — Hybrid architektura: orchestrátor + per-workspace sandboxed engines

**Status:** Předplán (analýza, ne implementace)
**Vznikl:** 2026-05-18 · **Aktualizováno:** 2026-05-18 (po Pavlově review)
**Souvisí:** VSLO-86 (Secure running sandbox), VSLO-171 (Per-workspace workery), VSLO-47 (Docker sandbox — bude deprekován)
**Předchozí design doc:** `vslo-86-implementation-plan.md`, `vslo-86-process-sandbox-multiplatform.md`

## TL;DR

Sloučit dva problémy do jednoho architektonického řešení:

1. **VSLO-171** — přepnutí workspace nesmí killovat backend, paralelní běh agentů ve více workspacech.
2. **VSLO-86** — workspace má **OS-level izolaci** (sandbox), agent nemůže číst/zapisovat do jiných workspaces, ani do citlivých systémových složek.

**Platformy:** **pouze macOS a Windows.** Veslo nedělá Linux build, Linux je out of scope.

**Cílový model — hybrid C:**

```
                  ┌─────────────────────────────────────────┐
                  │  Veslo UI (Tauri, SolidJS)              │
                  │  - 1 HTTP klient + per-request          │
                  │    x-opencode-directory header          │
                  │  - SSE filtruje eventy per workspace    │
                  └──────────────────┬──────────────────────┘
                                     │
                  ┌──────────────────▼──────────────────────┐
                  │  Veslo Orchestrátor (jeden proces)      │
                  │  - workspace registry                   │
                  │  - per-workspace routing                │
                  │    /workspace/:id/opencode/*            │
                  │  - sdílené API klíče (env passthrough)  │
                  │  - engine pool: default 8, user-set     │
                  │    idle suspend 15 min, LRU, health,    │
                  │    crash recovery                       │
                  └──┬──────────┬──────────┬────────────────┘
                     │          │          │
              ┌──────▼──┐  ┌────▼────┐  ┌─▼──────┐
              │ Engine  │  │ Engine  │  │ Engine │   ← každý ve vlastním
              │ A       │  │ B       │  │ C      │     sandboxu (γ), OS-level
              │ sandbox │  │ sandbox │  │ sandbox│     izolace, vlastní cwd
              │ + extra │  │ + extra │  │ + extra│     + per-workspace mount
              │   mnts  │  │   mnts  │  │   mnts │       allowlist
              └─────────┘  └─────────┘  └────────┘
```

**Co se získá portováním upstream openwork** (commit `d06978b9`, dev branch):
- Workspace-scoped routing (`/workspace/:id/opencode`, `x-opencode-directory` header)
- Workspace registry + persistence
- Frontend pattern: 1 klient + header per request (žádný globální `client()` signal)
- Windows extended-path fix (`\\?\` strip)
- Bun content-encoding sanitize bugfix

**Co se získá zachováním plánu γ** (`vslo-86-implementation-plan.md`):
- OS-level izolace každého engine (Anthropic sandbox-runtime na mac, WSL2 na Windows)
- Per-workspace mount allowlist
- Lifecycle management (idle suspend, LRU cap, recovery)

**Co je explicitně nové oproti upstream:**
- Per-workspace sandbox (upstream sandbox je striktně single-workspace)
- Per-workspace extra mounty s UI správou (upstream je má jen jako CLI/JSON)
- Server-side workspace-scoped session-write endpointy (rename)

**Co padá oproti původnímu γ plánu:**
- **Linux backend** (bwrap, Landlock) — Veslo nedělá Linux build
- **Sandbox toggle "Run without sandbox"** — sandbox je vždy on, žádný opt-out

## 1. Schválená architektonická rozhodnutí (2026-05-18)

| Rozhodnutí | Hodnota |
|---|---|
| **Crash isolation** | Hybrid: orchestrátor přežije pád enginu, restartne jen ten jeden workspace. |
| **API klíče** | Sdílené napříč workspaces přes env passthrough z orchestrátoru. Žádné per-workspace credentials v MVP. |
| **Multi-mount UI** | Nutné. UI panel "Reference folders" per workspace, default RO, advanced toggle RW. Add za chodu = restart workeru (s explicitním warningem). |
| **Platformy** | **Jen macOS a Windows.** Linux out of scope (Veslo neprodukuje Linux build). |
| **Pořadí implementace** | **Mac-first.** Až bude Mac MVP odladěné a stabilní, pak Windows port jako vlastní vlna. |
| **Sandbox default** | ON vždy. **Žádný opt-out.** Žádný advanced toggle, žádná "none" větev v `WorkerSandbox` traitu. Sandbox je nedílná součást engine spawnu. |
| **Docker backend** | **Out.** Benův Docker/Apple Container sandbox bude deprekován. Migrace existujících workspaces z `--sandbox docker` → γ proces sandbox. |
| **`.git`** | V primary workspace **RO** (i v RW režimu). V secondary mount **vždy RO** bez výjimky. Jednotná policy, žádné corner cases. |
| **Engine count limit** | **Default 8**, uživatelsky nastavitelné v Settings → Performance, range 1–16. Idle suspend default 15 min, taky konfigurovatelné. |
| **Izolační hranice** | OS-level (sandbox-exec na mac, WSL2 na Windows) — soft enforcement v OpenCode (`external-directory.ts`) je sekundární vrstva. |
| **Idle suspend** | Kill enginu (clean state, cold start při resume). Sessions přežijí v SQLite. |
| **SSE** | Globální, multiplexovaný v orchestrátoru. Eventy nesou `directory`, frontend filtruje. |
| **Rename endpoint** | Zatím nedělat vlastní. Pokud orchestrátor routuje podle directory v session DB, rename request půjde tam, kde session žije. Validovat po fázi 2. |
| **Per-workspace sandbox toggle** | Per workspace v MVP (ne per session). Per session jako future, pokud bude potřeba. |

## 2. Současný stav (důkladná mapa)

### 2.1 Orchestrátor lifecycle

**Soubor:** `packages/desktop/src-tauri/src/commands/orchestrator.rs`

- `orchestrator_start_detached()` (řádek 743) — spawnuje sidecar `veslo-orchestrator` s flagy `--workspace`, `--detach`, `--veslo-port`, `--veslo-token`, `--run-id`
- Health check polling (řádky 893–985) — `GET /health` s timeout 12 s (no-sandbox) nebo 90 s (docker, brzo deprekovaný)
- Single-instance manager v `packages/desktop/src-tauri/src/orchestrator/manager.rs:21–49` (`OrchestratorManager.stop_locked()` → graceful shutdown)

**Soubor:** `packages/orchestrator/src/cli.ts`

- `currentWorkdir` (řádek 4068), `currentConfigDir` (řádek 4069) — **single-workspace assumption**
- `ensureOpencode()` (řádky 4138–4196) — reuse pokud běží, jinak spawn nový
- `switchWorkdir()` (řádky 4077–4089) — **stops child + restartuje engine** ← tohle zruší práci
- Per-workspace config dir: `~/.veslo/opencode-config/{workspaceIdHash}/`

### 2.2 Workspace registry

**Tauri side:** `packages/desktop/src-tauri/src/workspace/state.rs`
- File: `~/.app-data-dir/veslo-workspaces.json` (řádek 26)
- `stable_workspace_id()` (řádky 12–16) — hash z path
- Aktivní workspace: `set_active_workspace()` (řádek 322)

**Orchestrátor side:** `cli.ts` řádky 4262–4310
- In-memory `state.workspaces: RouterWorkspace[]` (řádek 230), aktivní `state.activeId` (řádek 229)
- Persistence: `saveRouterState(statePath, state)` (řádek 4285)

**Duplikace:** workspace info je vedeno paralelně v Tauri (Rust) a orchestrátoru (TS). Při refaktoru zvážit single source of truth.

### 2.3 Veslo server (HTTP endpointy)

**Soubor:** `packages/server/src/server.ts`

Workspace-related endpointy už existují:
- `GET /workspaces` (1920), `GET /status` (1887), `GET /workspace/:id/config` (2139)
- `GET /w/:id/workspaces` (1882), `GET /w/:id/status` (1853)
- `DELETE /workspace/:id/sessions/:sessionId` (2196)
- `POST /workspace/:id/system/provision` (2147) — internal system provisioning (dual TS+Rust mode)

**Chybí oproti upstreamu:**
- `/workspace/:id/opencode/*` kanonický OpenCode proxy mount
- `/w/:id/opencode/*` alias
- `x-opencode-directory` header normalizace + Windows extended-path fix
- Workspace-scoped session WRITE endpointy (jen pokud se ukáže, že je potřeba)

### 2.4 Frontend client signal

**Soubor:** `packages/app/src/app/context/workspace.ts`

- `createWorkspaceStore()` (řádek 103) → store s `client()` signálem (řádek 114, `Client | null`)
- `activateWorkspace(id)` (řádek 579) → Tauri `orchestratorWorkspaceActivate()` + `ensureEngineForWorkspace()`
- `ensureEngineForWorkspace()` (řádek 2424) — single-flight pattern, health check
- `connectToServer()` (řádek 1344, `options.setClient(nextClient)`) — vytváří nový klient přes `createClient(baseUrl, directory, auth)` z `lib/opencode.ts:130–138`

**~71 callsites** importujících `client()` v `packages/app/src/app/`.

**Timing guardy v `connectToServer()`** (memory `frontend.md`):
- Stale-workspace ABORT (`workspace.ts:1200–1225`) — user switchnul pryč během spojování
- Idempotent SKIP (`workspace.ts:1227–1248`) — stejný baseUrl + directory → no-op
- Conditional state RESET (`activateWorkspace` řádky 921, 1001–1004) — `engineReady`, `selectedSessionId`, `messages`, `todos`, `pendingPermissions`

**Timeouty:** `WORKSPACE_ACTIVATE_TIMEOUT_MS = 30 s`, `START_HOST_TIMEOUT_MS = 45 s` (řádky 217–218).

### 2.5 SSE / streaming

**Soubor:** `packages/app/src/app/global-sdk.tsx`

- `GlobalSDKProvider` wraps celou aplikaci
- `eventClient.event.subscribe(undefined, { signal: abort.signal })` — **jeden globální SSE na `baseUrl`**, ne per workspace
- Event coalescing per `directory` (řádky 77–151) — batch flush každých 16 ms
- AbortController per `createEffect`, cleanup přes `onCleanup`

**Pozor:** event už nese `directory`, takže filtering per workspace je primitivně možný — chybí jen explicit konzument.

### 2.6 Permission UI

**Soubor:** `packages/app/src/app/session.ts`

- `refreshPendingPermissions()` (řádek 704) → `c.permission.list()` přes global client
- `activePermission` memo (řádek 1029) — hledá pro `selectedSessionId()`
- Render v `session.tsx:4552` — inline modal v session page
- `respondPermission(requestID, reply)` (řádek 950) → `c.permission.reply()`

**Problém aktuálně:** když agent v workspace A potřebuje permission a user je ve workspace B, `c.permission.list()` vrátí jen A's permissions. Bez re-connectu se prompt v B nezobrazí.

### 2.7 Sandbox (Benův Docker kód v orchestrátoru) — bude deprekován

**Soubor:** `packages/orchestrator/src/cli.ts`

- `resolveSandboxMode()` (řádky 422–440) — `--sandbox [none|auto|docker|container]`
- Container spawn (řádky 4952–5000+) — Docker / Apple Container
- Mount allowlist (řádky 440–745) — `~/.config/veslo/sandbox-mount-allowlist.json`

**Plán:** mount allowlist logika (řádky 440–745) **se přenese** do γ sandbox abstrakce (cenná, ověřená). Container spawn (4952–5000+) a `resolveSandboxMode` se **odstraní** spolu s `--sandbox docker|container` flagy.

### 2.8 Stav upstream openwork (2026-05-17)

Z reportu agent č. 1 (commit `d06978b9` na dev branch):
- `parseWorkspaceMount` + `parseWorkspaceOpencodeMount` (`server.ts:159-184`)
- `resolveOpencodeDirectory` + `normalizeOpencodeDirectory` (`server.ts:3337-3353`) **s Windows extended-path fixem**
- `workspaceIdForPath` (`workspaces.ts:5`) — deterministický hash
- `proxyOpencodeRequest` + `sanitizeProxyResponse` (`server.ts:498-554`) **řeší Bun content-encoding bug**
- `resolveWorkspaceOpencodeConnection` (per-workspace baseUrl fallback)
- Workspace CRUD: `POST /workspaces/local` (1424), `PATCH /workspaces/:id/display-name` (1472), `POST /workspaces/:id/activate` (1510), `DELETE /workspaces/:id` (1532), `GET /workspaces` (1310)

**Co upstream nemá a my musíme dodělat:**
- Per-workspace sandbox (upstream je striktně single-workspace)
- Windows sandbox (cli.ts od 2026-04 stagnuje, `resolveSandboxMode` nemá Windows větev)
- Multi-mount UI

### 2.9 OpenCode engine — multi-workspace nativně

Z reportu agent č. 2:
- OpenCode má `InstanceStore` cachující per-directory state (`ScopedCache<directory, InstanceState>`)
- Middleware `workspace-routing.ts:71-73` čte routing per request: `?directory=` → `x-opencode-directory` header → `process.cwd()`
- Session má v DB sloupce `directory` a `workspace_id` (`session.ts:75-77`)
- Shell tool používá explicit `cwd` v `spawn`, **ne** `process.chdir` → **per-session izolace zaručena**
- `external-directory.ts` enforcuje, že tool nesmí mimo `InstanceContext`

**Závěr:** OpenCode by uměl držet N workspaces v jednom procesu. Volíme přesto N procesů kvůli OS-level izolaci (sandbox = per-engine).

## 3. Cílová architektura — hybrid C

### 3.1 Hlavní komponenty

| Komponenta | Role | Process count |
|---|---|---|
| **Tauri UI** | Renderer, SolidJS, jeden HTTP klient + per-request header | 1 |
| **Veslo Orchestrátor** | Workspace registry, routing, engine pool, lifecycle, SSE multiplexing, permission queue | **1** (změna oproti dnes) |
| **Engine A, B, C…** | OpenCode `serve` per workspace, každý ve sandboxu, vlastní cwd | **N** (default 8, range 1–16) |
| **Sandbox vrstva** | Per-platform: sandbox-exec (mac) / WSL2 (Windows), mount allowlist | součást každého engine procesu |

### 3.2 Klíčové datové struktury (nové)

**V orchestrátoru:**

```typescript
// state.engines: Map<workspaceId, EngineProcess>
type EngineProcess = {
  workspaceId: string
  pid: number
  port: number             // dynamic, allocated at spawn
  baseUrl: string          // http://127.0.0.1:<port>
  workdir: string          // workspace path
  configDir: string        // ~/.veslo/opencode-config/<id>/
  sandboxBackend: SandboxBackend  // "sandbox-exec" | "wsl2" | "win-jobobject"
  state: EngineState              // "spawning" | "ready" | "idle" | "suspended" | "crashed"
  lastActivityAt: number          // pro idle suspend + LRU
  health: HealthState
  extraMounts: Mount[]            // per-workspace
}
```

**V UI:**

```typescript
// Žádný global client() signal. Místo toho:
type WorkspaceRouting = {
  activeWorkspaceId: () => string | null
  orchestratorBaseUrl: () => string  // jediná URL
  buildHeaders: (workspaceId: string) => Record<string, string>
  // tj. { "x-opencode-directory": workspace.path, "authorization": "Bearer <token>" }
}
```

**V Settings (nové):**

```typescript
type PerformanceSettings = {
  maxConcurrentEngines: number   // default 8, range 1-16
  idleSuspendMinutes: number     // default 15, range 5-60
}
```

### 3.3 Endpoint mapa (nové na orchestrátoru / serveru)

| Endpoint | Účel | Source |
|---|---|---|
| `GET /workspaces` | List workspaces (už existuje na serveru `1920`) | dnes |
| `POST /workspaces/local` | Add workspace | port z upstream `server.ts:1424` |
| `PATCH /workspaces/:id` | Rename / update | port z upstream `server.ts:1472` |
| `DELETE /workspaces/:id` | Remove (engine kill + state cleanup) | port z upstream `server.ts:1532` |
| `POST /workspaces/:id/activate` | UI signal (orchestrátor lazy-spawne engine) | port z upstream `1510` |
| `GET /workspace/:id/opencode/*` | **Proxy do engine** workspace `:id` | port z upstream `parseWorkspaceOpencodeMount` |
| `GET /workspace/:id/health` | Engine health | nové |
| `POST /workspace/:id/mounts` | Add extra mount (vyžaduje engine restart) | nové |
| `DELETE /workspace/:id/mounts/:mountId` | Remove mount | nové |
| `GET /events` | Global SSE (multiplexovaný napříč engines) | rozšíření dnešního |

### 3.4 Workspace switch flow (cílový)

Z **kill-and-respawn** dnes (~5-30 s) na **header swap** (instant):

1. User klikne na workspace B v sidebar
2. UI: `activeWorkspaceId.set("B")` + `setSelectedSessionId(null)` + reset session state
3. UI: `POST /workspaces/B/activate` (orchestrátor lazy-spawne engine B, pokud neběží)
4. UI: další requesty mají header `x-opencode-directory: <B path>` → orchestrátor routuje na engine B
5. UI: SSE filtruje příchozí eventy podle `directory === <B path>` (engine A pokračuje v běhu, jeho eventy frontend ukládá pro tray notifikaci)

**Engine A zůstává běžet** (idle timer reset = 0). Pokud user nepřepne zpět do 15 min (default, konfigurovatelné), engine A se suspendne (idle → SQLite session state persists, proces se ukončí).

### 3.5 Sandbox vrstva — abstrakce

`WorkerSandbox` trait v Rustu (Tauri) podle `vslo-86-implementation-plan.md`:

```rust
trait WorkerSandbox {
    fn spawn(&self, config: SandboxConfig) -> Result<SandboxedProcess>;
    fn supports_dynamic_mount(&self) -> bool;  // false pro všechny γ backends
    fn extra_mounts(&self) -> &[Mount];
}

struct SandboxConfig {
    workdir: PathBuf,
    extra_mounts: Vec<Mount>,
    env: HashMap<String, String>,
    command: Vec<String>,
}
```

Per-platform impl:
- **macOS:** `MacSandboxExec` (Anthropic `sandbox-runtime` lib) — **fáze 4**
- **Windows:** `WindowsWsl2` (Tier 1) + `WindowsJobObject` (Tier 2 fallback) — **fáze 7**

Sandbox spawnuje OpenCode `serve` proces. Orchestrátor s ním komunikuje přes lokální HTTP (sandbox musí povolit localhost).

**Žádná `None` varianta** — sandbox je vždy on. Pokud platforma nemá podporu (neexistující CI runner apod.), engine se vůbec nespawne (chyba "Sandbox required, not available").

## 4. Logické fáze

Rozdělení na fáze, které jsou **samostatně testovatelné a release-schopné**. **Mac-first sekvence**, Windows až po stabilizaci Mac MVP.

### Fáze 0 — Mac sandbox smoke test + Docker deprekace plán (1–2 dny)

**Cíl:** zvalidovat Anthropic `sandbox-runtime` lib, rozhodnout o migrační cestě pro Docker.

- Smoke test `anthropic-experimental/sandbox-runtime` na macOS 15+16: spawn OpenCode `serve` v sandboxu, ověřit FS izolaci pokus o read mimo workspace
- Audit Benova Docker kódu — kteří uživatelé už `--sandbox docker` používají? (jen interní + Pavel, takže migrace levná)
- Migrační plán: workspaces s `sandboxBackend === "docker"` při startu detekovat, nabídnout přesun na γ
- Smoke test mount allowlist logiky (cli.ts:440–745) — extrahovat do samostatného TS modulu, ať jde znovu použít v γ vrstvě

**Deliverable:** krátký report o feasibility Anthropic libu + migrační plán pro Docker.

### Fáze 1 — Workspace routing port (server-side, single engine) (2–3 týdny)

**Cíl:** server umí workspace-scoped routing **bez sandboxu**, na jednom shared OpenCode procesu (jako upstream). Připravuje terén pro fázi 2.

- Port `parseWorkspaceMount` + `parseWorkspaceOpencodeMount` do `packages/server/src/server.ts`
- Port `resolveOpencodeDirectory` + `normalizeOpencodeDirectory` (vč. Windows extended-path fix)
- Port `proxyOpencodeRequest` + `sanitizeProxyResponse` (Bun content-encoding fix)
- Workspace CRUD endpointy (`POST /workspaces/local`, `PATCH /workspaces/:id`, atd.)
- Jeden OpenCode engine, single proces (zatím)
- Integrační test: dva workspaces v jednom procesu, request s `x-opencode-directory` jde do správného cwd

**Deliverable:** server umí multi-workspace přes header. UI ještě beze změn.

### Fáze 2 — Per-workspace engine pool v orchestrátoru (3–4 týdny)

**Cíl:** orchestrátor spravuje N engine procesů místo jednoho.

- Refactor `cli.ts:230` (`state.opencode` → `state.engines: Map<workspaceId, EngineProcess>`)
- Refactor `switchWorkdir` (řádky 4077–4089) — místo kill-restart jen update aktivního ID v routing tabulce
- Engine pool lifecycle FSM: `spawning → ready → idle → suspended → resuming → crashed`
- Idle suspend (default 15 min, **konfigurovatelné v Settings**)
- LRU cap (**default 8**, **konfigurovatelné v Settings**, range 1–16)
- Health check (heartbeat na `/opencode/health` každých N s)
- Recovery: pokud engine crashne, orchestrátor ho restartne (exponential backoff)
- Routing v orchestrátoru: `/workspace/:id/opencode/*` → engine podle `id`
- **Bez sandboxu zatím** — engines běží přímo (jako dnes), jen jich je N
- Integrační test Václavova scénáře: spustit dlouhou akci ve A, switchnout do B, spustit druhou akci, ověřit že A pokračuje

**Deliverable:** paralelní per-workspace běh, switch nezruší práci. **Tohle samo o sobě řeší VSLO-171.**

### Fáze 3 — Frontend refactor (per-request header, SSE filtering) (2–3 týdny)

**Cíl:** UI místo globálního `client()` používá per-request `x-opencode-directory` header.

- Refactor `packages/app/src/app/context/workspace.ts` — odstranit `client()` signál, nahradit `WorkspaceRouting` službou
- ~71 callsites `client()` → projet a refaktorovat na `routing.client(activeWorkspaceId())`
- `connectToServer()` přejmenovat / odstranit kill-restart logiku
- `GlobalSDKProvider` (`global-sdk.tsx`) — SSE filtrace eventů per workspace
- **Cross-workspace permission queue** — orchestrátor agreguje permissions ze všech enginů, UI je má v globálním store, badge v sidebar + tray notifikace
- Workspace switch v UI: <500 ms p99 (instant header swap, žádný backend restart)
- Migrate timing guardy (`stale-workspace ABORT`, `idempotent SKIP`, `conditional state RESET`) na nový model (založené na `activeWorkspaceId()` místo `client()`)
- Settings panel: Performance → Max concurrent engines (1–16), Idle suspend (5–60 min)
- Feature flag pro paralelní existování staré i nové cesty (regression check)

**Deliverable:** plynulé UX, paralelní agenti v paralelních workspaces v UI viditelně bez čekání.

### Fáze 4 — macOS sandbox abstrakce + impl (3–4 týdny)

**Cíl:** každý engine běží v OS-level sandboxu na macOS. Windows zatím vypnutý.

- `WorkerSandbox` trait v `packages/desktop/src-tauri/src/sandbox/` (nová složka)
- `MacSandboxExec` impl s Anthropic `sandbox-runtime` lib
- Stub `WindowsWsl2` / `WindowsJobObject` (jen panic při použití, fáze 7 dořeší)
- Integrace s engine pool z fáze 2 — engine spawn jde vždy přes sandbox vrstvu
- Default mount: workspace path (RW), `.git` ⊂ workspace = RO **vždy**
- Default blocked: `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `credentials`, `id_rsa`, … (port z `cli.ts:459-477`)
- Migrace existujících Docker workspaces na γ (z fáze 0 plán)
- Odstranit `--sandbox docker|container` flagy z `cli.ts`
- CI matrix: macOS 15+16
- Validation: pen-test pokus o cross-workspace read/write z agent shell

**Deliverable:** OS-level izolace mezi workspaces na macOS. **Mac MVP hotové. Tohle uzavírá VSLO-86 jádro pro macOS.**

### Fáze 5 — Multi-mount UI + per-workspace extra mounts (1–2 týdny)

**Cíl:** UI panel pro správu reference folders.

- Panel "Reference folders" v workspace settings (Tauri UI)
- Per-workspace JSON config (rozšíření o `extraMounts: Mount[]`)
- Globální allowlist (`~/.config/veslo/sandbox-mount-allowlist.json`) zůstává jako bezpečnostní hrana — workspace nemůže mountnout cestu mimo allowlist
- Default RO toggle, "Advanced: allow write" je explicitní (vyžaduje confirm s warningem)
- **`.git` v secondary mount: vždy RO** bez možnosti override
- Add mount za chodu = restart workeru (`Adding reference folder requires worker restart — continue?` dialog)
- Audit log: zaznamenat každý write mimo primary workspace path (do `~/.veslo/audit.log`)
- Sidebar badge "Workspace má rozšířený přístup: ⚠️"

**Deliverable:** user může agentovi přidat referenční složky s vědomím rizik.

### Fáze 6 — Hardening, observability, Mac release (1–2 týdny)

**Cíl:** připravit macOS release.

- Telemetrie (anonymized, opt-out per rozhodnutí 2026-04-30) — events: workspace_count, engine_spawn, engine_crash, sandbox_violation_attempt, mount_added
- Diagnostický panel v UI (engine pool stav, health, paměť, sandbox backend per workspace)
- Migrace existujících workspaces (single-engine → engine pool)
- Code signing setup: Apple Developer $99/rok
- Release notes, changelog, AGENTS.md / CLAUDE.md update
- Smoke test celého flow na čistém macOS

**Deliverable:** macOS release-ready build. **Mac MVP shipped.**

### Fáze 7 — Windows port (jen po stabilizaci Mac MVP)

**Cíl:** dotáhnout Windows backend stejnou architekturou. Spustit, až bude Mac stabilní v produkci a budou jasné edge cases.

- Risk gate: WSL2 prototyp — auto-install, networking host ↔ WSL2, mount `C:\` → `/mnt/c`, sandboxed `npm install` uvnitř
- Pokud WSL2 nedopadne → Tier 2 (Job Object + Low Integrity Token + workspace ACL) jako primární Windows backend
- `WindowsWsl2` impl trait `WorkerSandbox`
- `WindowsJobObject` fallback
- Onboarding wizard pro WSL2 enable + Ubuntu install (vyžaduje reboot, explicit consent)
- CI matrix: Windows 10 + 11, Pro + Home
- MS Trusted Signing setup ~$120/rok
- Pen-test na Windows specifika

**Deliverable:** Windows release-ready build.

**Odhad fáze 7:** 12–18 sessions (samostatná vlna, mimo timeline Mac MVP).

## 5. Timeline a závislosti — Mac MVP

```
Fáze 0  ────  1-2 dny   ──── (smoke test + migrační plán)
                              ↓
Fáze 1  ────────  2-3 týdny  ──── (server routing port)
                                    ↓
Fáze 2  ─────────  3-4 týdny  ──── (engine pool)
                                    ↓
Fáze 3  ─────  2-3 týdny  ──── (frontend refactor)
                                    ↓
Fáze 4  ─────────  3-4 týdny  ──── (macOS sandbox)
                                    ↓
Fáze 5  ───  1-2 týdny  ──── (multi-mount UI)
                                    ↓
Fáze 6  ───  1-2 týdny  ──── (hardening + Mac release)
                                    ↓
[Mac MVP SHIPPED]
                                    ↓
Fáze 7  ─────────  3-4 týdny  ──── (Windows port, samostatná vlna)
```

**Mac MVP celkem: 13-20 týdnů kalendárního času** (závisí na intenzitě)

**Co se dá releasovat po každé fázi:**
- Po fázi 1: nic uživatelsky viditelného (server připravený)
- **Po fázi 2: VSLO-171 hotové** (per-workspace workery)
- Po fázi 3: výrazně lepší UX (instant switch)
- **Po fázi 4: VSLO-86 jádro hotové na macOS** (sandbox)
- Po fázi 5: multi-mount UI bonus
- Po fázi 6: produkční kvalita, **Mac MVP shipped**
- Po fázi 7: Windows shipped

## 6. Odhad efortu — sessions s Claude

Při dvojici (já implementuju, Pavel review/decisions):

| Fáze | Sessions | Pozn. |
|---|---|---|
| Fáze 0 — smoke test + migrační plán | 2–3 | krátká |
| Fáze 1 — server routing port | 4–6 | well-scoped, většinou copy + adapt z upstreamu |
| Fáze 2 — engine pool (nejnáročnější) | **8–12** | Rust ↔ TS koordinace, lifecycle FSM, recovery |
| Fáze 3 — frontend refactor | 6–10 | 71 callsites, SSE filtering, cross-workspace permission, feature flag |
| Fáze 4 — Mac sandbox abstrakce + impl | 4–6 | `WorkerSandbox` trait + macOS backend + migrace Dockeru |
| Fáze 5 — multi-mount UI | 2–4 | UI panel + per-workspace mount config |
| Fáze 6 — hardening + Mac release | 2–3 | diagnostika, telemetrie, migrace, code signing |
| **Mac MVP celkem** | **28–44 sessions** | |
| Fáze 7 — Windows port | 12–18 | samostatná vlna |

**Kalendárně při 1 session/den (1-2h efektivní práce): cca 6–9 týdnů na Mac MVP.**
**Při intenzivních pair sessions (2-3h): 3-5 týdnů.**

### Co tomu může uškodit (realisticky)
- Frontend refactor 71 callsites bude nejvíc křehký — feature flag + souběžné cesty pomohou, ale debugging UI regressí je nepředvídatelný
- Rust ↔ TS lifecycle FSM v orchestrátoru se ladí těžko (race conditions, timing)
- Anthropic `sandbox-runtime` lib může mít subtle gotchas, které vyplavou až při integraci

### Co tomu může pomoci
- Upstream openwork dělá ~70 % server routingu už za nás (fáze 1 je hlavně port)
- OpenCode má nativní per-directory `InstanceStore`, izolace na engine level řešená
- Můžeme spawnnout Explore/Plan agenty pro hluboké průzkumy mimo session (paralelně), což sníží počet "hlavních" sessions

## 7. Rizika

| Riziko | Pravděpodobnost | Dopad | Mitigace |
|---|---|---|---|
| sandbox-exec subtle SBPL change v macOS 27+ | Nízká | Střední | CI smoke testy na nových macOS verzích |
| Anthropic `sandbox-runtime` lib bug nebo nedostatečná granularita | Střední | Střední | Fáze 0 smoke test rozhodne včas |
| Frontend refactor (71 callsites) regression | Vysoká | Vysoký | Feature flag, paralelní cesty během migrace |
| Cross-workspace prompt injection (agent v A přeskočí sandbox boundary) | Nízká (díky OS-level izolaci) | Vysoký | Pen-test ve fázi 4, audit log |
| Permission queue overflow z neaktivních workspaces | Střední | Nízký | LRU eviction promptů starších X min |
| Engine pool resource exhaustion (8 × 500 MB = 4 GB) | Nízká | Střední | User-set cap v Settings (1-16), idle suspend |
| Bun content-encoding bug — pokud Veslo přejde na Node, fix přestane platit | Nízká | Nízký | Sledovat upstream Bun fix |
| Migrace Docker workspaces nejede čistě | Nízká (málo uživatelů má Docker) | Nízký | Manuální fallback: smazat sandbox metadata, workspace běží jako fresh |
| WSL2 user friction při Windows portu | Vysoká | Vysoký | Až ve fázi 7, separate effort. Onboarding wizard + Tier 2 fallback |

## 8. Co se v MVP nedělá (out-of-scope)

- **Linux build** (Veslo nedělá Linux release vůbec)
- **Sandbox opt-out** (žádný toggle "Run without sandbox")
- **Docker / Apple Container backend** (deprekováno fází 4)
- Per-workspace API keys / multi-account credentials (sdílené přes env)
- Per-session sandbox (workspace-level je dostačující)
- Network izolace (sandbox řeší jen FS)
- VM-based "advanced isolation" mode (cesta β z `vslo-86-per-workspace-workers-research.md`)
- "Move workspace to cloud"
- Configuration-Based Sandbox Escape (CBSE) ochrany
- Prompt injection detection v agent layer
- Vlastní server-side rename endpoint (validovat po fázi 2, pravděpodobně nepotřebné)

## 9. Reference

### Veslo (interní)
- `vslo-86-implementation-plan.md` — předchozí plán γ (5 fází, Linux + Windows)
- `vslo-86-process-sandbox-multiplatform.md` — technické detaily sandbox backends (Linux část zastaralá)
- `vslo-86-per-workspace-workers-research.md` — cesta β (VM-based, advanced isolation)
- `vslo-71-fast-workspace-switch.md` — předchozí pokus o rychlejší switch
- `docs/memory/containerization.md` — stav 2026-05, Benův Docker sandbox (bude deprekován)
- `docs/memory/frontend.md` — timing guards, signál mapa
- `docs/memory/infrastructure.md` — sidecar binaries, build

### Upstream openwork (different-ai/openwork, dev branch, commit d06978b9)
- `apps/server/src/server.ts:159-184` — workspace mount parsers
- `apps/server/src/server.ts:498-554` — proxy + sanitize
- `apps/server/src/server.ts:3337-3353` — directory resolution + Windows fix
- `apps/server/src/workspaces.ts:5-29` — workspace ID hashing
- `apps/server/src/managed-opencode.ts:30-53` — OpenCode spawn

### OpenCode engine (sst/opencode → anomalyco/opencode)
- `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts:71-73` — per-request directory
- `packages/opencode/src/project/instance-store.ts:34-52` — `ScopedCache` per directory
- `packages/opencode/src/session/session.ts:75-77, 117-120` — session má directory + workspace_id
- `packages/opencode/src/tool/shell.ts:289-301, 612-614` — spawn s explicit cwd
- `packages/opencode/src/tool/external-directory.ts:26-44` — soft enforcement

### Konkurence (UX inspirace)
- Claude Code `--add-dir` + `permissions.additionalDirectories` — in-process, dynamic add
- Cursor `@folder` — context injection bez mountu, RO de-facto
- VS Code Devcontainers `mounts` + `workspaceMount` — restart-required (jako náš γ)

---

**Další krok:** Pavel review tohoto pre-planu, pak začít fází 0 (Mac sandbox smoke test + Docker migrační plán). Implementaci dělá Pavel s podporou Claude.
