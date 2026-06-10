# Architektura — žijící graf procesů

Tenhle dokument popisuje **co skutečně běží**, když je Veslo spuštěné
v dev modu (`pnpm dev`), a **kdo s kým mluví, jakým protokolem, jakou
autentizací**. Pro vysokoúrovňovou vizi Vesla viz kořenový
[`ARCHITECTURE.md`](../../ARCHITECTURE.md).

## Skutečný stav v dev modu

Po `pnpm dev` se postupně spustí **5 lokálních procesů** plus aplikace
mluví s **1 managed-AI HTTPS endpointem**:

```
[1] veslo                          — Tauri main, vlastní okno + IPC (port 4445 jen s --features e2e)
[2] veslo-orchestrator daemon      — Bun, engine pool + HTTP proxy (random port)
[3] bun --watch src/cli.ts         — veslo-server v dev modu (port 8787, fallback random)
[4] veslo-code-router              — Bun, Telegram/Slack messaging bridge (random port)
[5] veslo-code (× N)               — OpenCode engines, jeden per workspace (random porty,
                                      přes platformní sandbox backend)
[6] https://ai.veslo.work          — standalone AI Gateway na owned serveru
                                      (managed-AI access/proxy; Den auth běží na
                                      https://api.veslo.work)
```

V production buildu jsou procesy stejné, jen `[3]` je nativní binárka
(`veslo-server` ve `target/release/`) místo `bun --watch`.

## Co dělá každý proces

### 1) Tauri main (`veslo`)

Rust desktop shell. Drží okno, IPC channel, lifecycle child procesů.
Klíčové soubory: `packages/desktop/src-tauri/src/lib.rs`,
`packages/desktop/src-tauri/src/commands/`.

Spawne při startu (`dev-autostart` v `commands/engine.rs:119`):
- veslo-server (`commands/veslo_server.rs`)
- orchestrator daemon (`orchestrator/mod.rs`)
- veslo-code-router (`commands/opencode_router.rs`)

**Engine se NEspawne** — engine vzniká až lazy, viz `data-flows.md`.

### 2) Orchestrator daemon (`veslo-orchestrator daemon run`)

Bun proces. Drží **pool engines** (1 per workspace), spawne je na
požádání přes `pool.ensure(workspaceId)`, monitoruje crashe, suspenduje
po `idleSuspendMs` (default 15 min).

Naslouchá **jen na `127.0.0.1`** (`--daemon-host 127.0.0.1`, viz
`commands/engine.rs:629`). Náhodný port se vybere přes `find_free_port`.

Hlavní endpointy:
- `GET /health` — workspaces + engines snapshot
- `POST /workspaces` — register
- `POST /workspaces/:id/activate` — set active
- `* /workspace/:id/opencode/*` — proxy na engine pro daný workspace (non-GET lazy spawn pokud chybí; GET/HEAD nespawnuje — bez běžícího enginu vrací hned `503 engine_not_running`)
- `POST /workspace/:id/runs/register` — lifecycle register pro local conversation sendy
- `GET /workspace/:id/conversations/:conversationId/runs/:runId|latest` — lifecycle status/reconcile

Auth: HTTP Basic (`opencode:<random-uuid>` při spawn).

Zdroj: `packages/orchestrator/src/cli.ts`, `packages/orchestrator/src/engine-pool.ts`.

### 3) Veslo-server (`bun --watch src/cli.ts` v dev, `veslo-server` binárka v production)

Bun proces. Single source of truth pro **persistent state**:
- registry workspaces (`/workspaces`, `/workspaces/local`, `/workspaces/:id/activate`)
- conversation service (`/workspace/:id/conversations*`) — pasivní OpenCode
  SQLite reads, conversation bindings, write API pro create/run/abort
- session archives, session transcripts
- workspace config (`opencode.jsonc`, `.opencode/veslo.json`)
- AI gateway proxy (`/ai-gateway/providers/{openai,anthropic,codex_oauth,openai_compatible}/v1/...`)
- soul/heartbeats, debug logs

Naslouchá na `0.0.0.0:8787` (nebo random fallback pokud 8787 zabraný —
viz [`known-issues.md`](known-issues.md) k port-discovery historii).

Auth: HTTP Bearer (`token` ze spawn arg) pro klient operace,
HTTP header `x-veslo-host-token` pro host operace.

Zdroj: `packages/server/src/server.ts`, `packages/server/src/cli.ts`.

### 4) Veslo-code-router

Bun proces. Bridge na messaging platformy (Telegram, Slack, WhatsApp).
**Pro testování workspace flow irrelevantní** — ve VSLO-86 stabilizaci
se nepoužíval. V dev mode běží, ale jen poll-loopuje health.

Naslouchá random port.

Zdroj: `packages/opencode-router/src/cli.ts`.

### 5) OpenCode engines (`veslo-code serve`)

OpenCode native binárka, jedna instance per workspace. Spawne ji
orchestrator přes `engine-pool.ts::spawnEngine`. Engine neběží přímo na
hostu, ale přes `WorkerSandbox` backend z
`packages/orchestrator/src/sandbox/index.ts`:

- macOS (`process.platform === "darwin"`): `mac-sandbox-exec`, tj.
  `sandbox-exec` přes `@anthropic-ai/sandbox-runtime`.
- Windows (`process.platform === "win32"`): `windows-wsl2`, tj. `wsl.exe`
  spustí Linux OpenCode runtime uvnitř `bubblewrap` (`bwrap`) v WSL2.
  Orchestrator používá WSL guest IP jako `connectHost`, protože Windows
  localhost forwarding je v tomto flow nespolehlivý.
- Ostatní host platformy: aktuálně bez podporovaného sandbox backendu
  (`resolveSandbox()` failne closed).

Naslouchá na `0.0.0.0:<random>`. Auth: HTTP Basic, stejné credentials
jako daemon.

Hlavní endpointy (z OpenCode SDK):
- `POST /session` — vytvoří session
- `POST /session/:id/prompt_async` — submitne prompt a vrátí hned
- `GET /session/status` — runtime busy/idle status pro sessions
- `GET /session/:id/message` — vyčte messages
- `GET /event?directory=...` — SSE stream
- `GET /config/providers` — AI provider config

Zdroj engine binárky: externí OpenCode (npm `@opencode-ai/server`),
vendorovaná do `packages/desktop/src-tauri/target/debug/veslo-code`.

### 6) Managed AI gateway (owned server, default https://ai.veslo.work)

Externí HTTPS služba pro **AI access management** a provider proxy. Aktuální
produkční default je standalone AI Gateway ze `services/ai-gateway`,
nasazená přes owned-server Compose stack. Den pořád zajišťuje browser/app auth
na `https://api.veslo.work`; desktop používá Den bearer token při dotazu na
managed-AI access bundle.

`veslo-server` forwarduje lokální `/ai-gateway/*` požadavky na configured
managed-AI base URL (`VESLO_MANAGED_AI_BASE_URL`, legacy
`VESLO_AI_GATEWAY_BASE_URL`; orchestrator default `https://ai.veslo.work`).
Starý Render endpoint `https://den-control-plane-veslo.onrender.com` je
historie/rollback, ne aktuální default.

Auth: user/caller bearer přes `x-veslo-gateway-authorization`, provider requesty
používají gateway access token v `x-veslo-gateway-token`.

## Graf komunikace

Ne lineární pipeline, je to **mesh**. Šipka = "volá":

```
                                ┌──────────────────────┐
                                │   Managed AI gateway │
                                │   (owned server)     │
                                └───────────▲──────────┘
                                            │ HTTPS
                                            │ x-veslo-gateway-token /
                                            │ x-veslo-gateway-authorization
                                            │
                                  ┌─────────┴──────────┐
                                  │  veslo-server      │
                                  │  port 8787         │
                                  │  (AI gateway proxy │
                                  │   + workspace API) │
                                  └──▲────────┬────────┘
                                     │        │
                                     │        │ HTTP
                                     │        │ (provider config baseURL
                                     │        │  míří sem)
                                     │        │
            ┌────────────────────────┘        │
            │ HTTP (Bearer)                   │
            │                                 ▼
   ┌────────┴────────────┐         ┌────────────────────┐
   │ Tauri webview (UI)  │         │  OpenCode engine   │
   │ SolidJS + signals   │         │  (per workspace,   │
   │ + 3 SSE streamy     │         │   platform sandbox)│
   └──┬────┬────┬─────┬──┘         └────────▲───────────┘
      │    │    │     │                     │
      │    │    │     │ Tauri IPC           │ HTTP proxy
      │    │    │     │ (commands)          │ (přes orchestrator)
      │    │    │     ▼                     │
      │    │    │  ┌────────────────────┐   │
      │    │    │  │  Tauri Rust shell  │   │
      │    │    │  │  (engine_start,    │   │
      │    │    │  │   orchestrator_*,  │   │
      │    │    │  │   engine_sse_*)    │   │
      │    │    │  └─┬────┬────┬────────┘   │
      │    │    │    │    │    │ spawn      │
      │    │    │    │    │    │ + ureq     │
      │    │    │    ▼    ▼    ▼            │
      │    │    │  spawne veslo-server,     │
      │    │    │  orchestrator daemon,     │
      │    │    │  veslo-code-router        │
      │    │    │                            │
      │    │    │  HTTP (Basic)              │
      │    │    └─────► orchestrator         │
      │    │           daemon (random port)  │
      │    │              │                  │
      │    │              │ spawne engine    │
      │    │              │ přes WorkerSandbox
      │    │              │ + HTTP proxy ────┘
      │    │              ▼
      │    │           OpenCode engine (per workspace)
      │    │
      │    │  Rust SSE proxy (engine_sse_subscribe)
      │    └─────► engine /event stream
      │            (přes orchestrator proxy)
      │
      │  Rust SSE proxy (engine_sse_subscribe s Bearer)
      └─────► veslo-server /event stream
              (global SDK SSE)

   + veslo-code-router (Telegram/Slack bridge — pro multi-workspace flow irrelevantní)
```

## Klíčové zákonitosti grafu

### UI má 4 nezávislé outbound cesty

1. **Tauri IPC** (`@tauri-apps/api/core::invoke`) — Tauri command runtime.
   Single channel, FIFO. Pomalá synchronní command blokuje další invokes.
2. **HTTP na veslo-server** (`port 8787`) — přes Tauri HTTP plugin.
3. **HTTP na orchestrator daemon** (random port) — přes Tauri HTTP plugin.
4. **HTTP na engine přes orchestrator proxy** — přes Tauri HTTP plugin.

Tauri HTTP plugin v2 routuje **všechny** webview fetch volání jedním
IPC kanálem do Rust handleru. Dlouhotrvající fetch (SSE) drží kanál
otevřený a krátké requesty ve frontě čekají. Detail viz
[`known-issues.md`](known-issues.md).

### Engine je vždy proxy přes orchestrator daemon

UI **nikdy** nemluví s engine přímo — vždy přes
`http://127.0.0.1:<daemon-port>/workspace/<wsId>/opencode/*`. Orchestrator
proxy lazy-spawne engine pokud chybí, monitoruje crash, retry-uje.

Výjimka: **Rust-side SSE proxy** (`engine_sse_subscribe`,
`commands/engine_sse.rs`) — Rust se připojí na engine přímo a forwarduje
události webview přes Tauri event bus. To proto, aby SSE nedrželo Tauri
HTTP plugin IPC kanál (viz commit `1dffda5e`).

### Windows proxy chain má dvě vrstvy

Na Windows je nutné rozlišovat tyto dvě cesty:

```text
veslo-server :8787
  -> orchestrator /workspace/<id>/opencode
  -> WSL2/bwrap OpenCode engine
```

Když přímý orchestrator health vrací 200, ale stejný endpoint přes
`veslo-server` vrací 500/502, není to WSL routing problém. Znamená to chybu
ve `veslo-server` proxy vrstvě.

Invariant: `veslo-server` používá workspace-scoped base URL
`/workspace/<id>/opencode`, drží `--workspace` a `--workspace-id` zarovnané a
na upstream posílá `Accept-Encoding: identity`.

### Conversation service je hranice mezi UI a OpenCode sessions

Současný send/read flow už nemá být přímé UI volání OpenCode SDK pro běžné
conversation operace. UI používá Veslo server conversation API:

- read: `GET /workspace/:id/conversations` a
  `GET /workspace/:id/conversations/:conversationId/transcript`
- create: `POST /workspace/:id/conversations`
- run: `POST /workspace/:id/conversations/:conversationId/runs`
- abort: `POST /workspace/:id/conversations/:conversationId/abort`

Veslo server drží stabilní Veslo `conversationId` v binding DB a mapuje ho na
OpenCode `engineSessionId`. Pasivní list/transcript flow čte OpenCode SQLite
read-only; nemá startovat engine. Write flow může engine kontaktovat, ale run
musí nejdřív projít lifecycle registrací u orchestrator daemonu, aby jedna
conversation neměla dva aktivní runy.

Detailní contract je v [`conversation-service.md`](conversation-service.md).

### Engine konfigurace je 3-zdrojová

OpenCode engine při startu čte:
1. `OPENCODE_CONFIG_DIR` (`~/.veslo/veslo-orchestrator-dev/opencode-config/ws-xxx/`)
   — vendoring plugin + tools.
2. `<workspace>/opencode.jsonc` — provider config (baseURL, apiKey,
   gateway headers).
3. `<workspace>/.opencode/veslo.json` — Veslo-specific metadata.

`opencode.jsonc` updateuje **frontend** (po activate flow přes
`formatManagedAiAccessConfig` → veslo-server `PATCH /workspace/:id/config`
→ `updateJsoncTopLevel` zápis na disk). Engine config je tedy **stale**,
dokud frontend neprovede update.

### Workspace identita má 3 store, musí být v sync

Workspace ID se počítá deterministicky: `sha1(path).slice(0, 12)` →
`ws-<hex>`. **Všechny tři** stores to teď používají, viz commit
`e8d2982a` a `04a2ba75`:

- **Tauri local state** (`~/Library/Application Support/com.neatech.veslo/veslo-workspaces.json`)
  — frontend zdroj pro sidebar.
- **Orchestrator daemon** (`~/.veslo/veslo-orchestrator-dev/veslo-orchestrator-state.json`)
  — pool a proxy lookup.
- **Veslo-server** (in-memory, vytvořeno z `--workspace` CLI args + runtime
  `POST /workspaces/local`).

Bez sjednocení (= před `04a2ba75`) klik na workspace 404'd silently,
protože každý store používal jiné schéma. Detail v
[`known-issues.md`](known-issues.md) i [`fixes-timeline.md`](fixes-timeline.md).

## Proč zrovna 6 vrstev (a co by šlo zredukovat)

Krátce — proč nelze jen "back-end + API + front-end":

| Vrstva | Proč existuje | Lze odstranit? |
|---|---|---|
| Tauri | Desktop window, native menus, file picker, IPC do Rust | Ne (jinak ne desktop app) |
| Veslo-server | Persistent state (workspaces, sessions), AI gateway proxy | Ne, ale lze sloučit s orchestratorem |
| Orchestrator daemon | Engine pool (spawn, suspend, route), HTTP proxy | Lze sloučit do veslo-server |
| Engine (per workspace) | OpenCode native, platformní sandbox (`sandbox-exec` na macOS, WSL2 + bwrap na Windows), čte tvoje soubory | Ne (jinak žádné AI s context tvého kódu) |
| Veslo-code-router | Telegram/Slack messaging bridge | Ano (vypnout v dev) |
| Managed AI gateway | AI provider keys management, gateway | Ne (kromě případů kdy user má vlastní keys) |

Realistický refactor zacílený na zjednodušení:

1. **Sloučit orchestrator + veslo-server** do jednoho Bun procesu — sjednotí
   workspace state, jeden HTTP hop méně, jeden auth flow. Odhad **~3 dny
   práce**.
2. **Vypnout veslo-code-router v dev mode** — ušetří jeden proces, sníží
   noise v logu. **~30 minut**.

Po těchto změnách: `UI ↔ Tauri ↔ veslo-server ↔ engines ↔ Managed AI`.
4 procesy plus managed-AI HTTPS služba. To už je rozumný stack pro
multi-workspace desktop app.
