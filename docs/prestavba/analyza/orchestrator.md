# Analýza: `packages/orchestrator` — CLI orchestrátor (binárka `veslo`)

Analyzovaný kořen: `packages/orchestrator`

## Účel a rozsah

`veslo-orchestrator` (npm balíček instalující příkaz `veslo`, kompilovaný Bunem do samostatné binárky) je **supervizor procesů a HTTP router**. V jednom balíčku žijí ve skutečnosti **tři různé aplikace**:

1. **`veslo start` / `veslo serve`** — „host mode" pro CLI: spustí trojici procesů OpenCode engine + `veslo-server` + `veslo-code-router` pro jeden workspace, počká na health, vypíše párovací údaje (URL + tokeny) a volitelně ukáže interaktivní TUI dashboard (`src/cli.ts:6085` `runStart`, TUI v `src/tui/app.tsx`, 884 řádků na OpenTUI/SolidJS).
2. **`veslo daemon run`** — **režim, který reálně používá desktopová aplikace**: dlouho běžící HTTP démon (`src/cli.ts:3960` `runRouterDaemon`, ~1 780 řádků v jedné funkci) s registrem workspace, poolem OpenCode enginů, run-lifecycle registrem (SQLite) a reverzní HTTP/SSE proxy na enginy.
3. **Klientské podpříkazy** — `workspace add/list/switch`, `instance dispose`, `approvals`, `files`, `status` — tenké HTTP klienty na démona nebo na `veslo-server` (`runWorkspaceCommand` :3873, `runFiles` :5767, `runApprovals` :5971, `runStatus` :6027).

Rozsah: **~13 900 řádků ne-testového TS** (z toho `cli.ts` samotný 6 934 řádků), ~5 100 řádků testů, ~1 800 řádků build/publish skriptů; celkem 68 souborů.

## Architektura a klíčové soubory

| Soubor | Řádky | Role |
|---|---|---|
| `src/cli.ts` | 6 934 | Vše: parsování argumentů, logger, stahování/ověřování binárek, spawn tří sidecароv, HTTP démon se všemi routami, klientské příkazy, help |
| `src/engine-pool.ts` | 1 058 | `EnginePool` — per-workspace OpenCode engine (max 8, idle-suspend 15 min, LRU evikce, health strikes 3×, restart backoff) |
| `src/shared-opencode-engine.ts` | 289 | Alternativní topologie: jeden nesandboxovaný engine pro všechny workspace (opt-in `VESLO_SHARED_OPENCODE_ENGINE=1` + `VESLO_DISABLE_SANDBOX=1`, `src/engine-topology.ts`) |
| `src/router-proxy.ts` | 337 | Reverzní proxy request→engine: streaming, SSE passthrough, přepis JSON těl/odpovědí (WSL cesty), headers timeout |
| `src/run-store.ts` + `src/run-registry.ts` + `src/run-activity-probe.ts` | 1 204 | Run-lifecycle: SQLite (`bun:sqlite`) v `~/.veslo/veslo-orchestrator/conversations/runs.sqlite`, stavový stroj submitted/running/blocked/…, sonda aktivity dotazem na OpenCode session, heuristiky „stale/no-progress" |
| `src/opencode-managed-dependencies.ts` | 748 | Vendorování `@opencode-ai/plugin`, `zod`, `@ai-sdk/*` atd. do `.opencode/node_modules` workspace/config diru |
| `src/sandbox/*` | ~900 | macOS `sandbox-exec` přes `@anthropic-ai/sandbox-runtime`, Windows WSL2 (discovery + PowerShell provisioning), stuby |
| `src/engine-paths.ts` | 176 | Mapování hostitelských cest ↔ cesty uvnitř WSL enginu (přepisy `directory` v query/JSON/SSE) |
| `src/tui/app.tsx` | 884 | TUI dashboard (jen pro interaktivní `veslo start`) |
| `src/workspace-id.ts`, `workspace-runtime-migration.ts` | 159 | Odvození workspace ID (`ws-<sha1(path)>`), migrace legacy ID config dirů |
| `src/persistence.ts`, `shutdown.ts` | 316 | Atomický zápis stavu JSON, debounced persist, řízený shutdown |

**Stav démona** se persistuje do `~/.veslo/veslo-orchestrator/veslo-orchestrator-state.json` (`routerStatePath`, cli.ts:1691): seznam workspace, `activeId`, snapshoty enginů, PID/port démona, diagnostika binárek.

### Co přesně orchestruje (procesy, porty, auth)

**Režim `daemon run` (desktop):**
- Tauri spawne sidecar `veslo-orchestrator` s argumenty `daemon run --data-dir … --daemon-host 127.0.0.1 --daemon-port <volný> --opencode-bin … --opencode-password … --veslo-token … --lifecycle-token …` (`packages/desktop/src-tauri/src/orchestrator/mod.rs:422`).
- Démon **nespouští `veslo-server`** — ten si Tauri spawne sám (`packages/desktop/src-tauri/src/veslo_server/spawn.rs`) a předá mu `--orchestrator-url` démona.
- Démon spawnuje **OpenCode enginy lazy**: při `POST /workspaces/:id/activate` (synchronně, čeká až 60 s na cold start — cli.ts:5032) nebo při prvním ne-GET proxy requestu; GET/HEAD engine nikdy nespouští, vrací 503 `engine_not_running`/`engine_starting` (cli.ts:5266).
- Každý engine = proces `veslo-code serve --hostname <host> --port <volný port>` (`startOpencode`, cli.ts:2655), volitelně obalený do sandboxu; Basic auth `opencode:<heslo z flagu/env>`.
- Porty: démon náhodný volný (vybírá Rust), enginy náhodné volné (`findFreePort`), vše na 127.0.0.1.

**Režim `start`/`serve` (CLI):**
- Spawne v pořadí: OpenCode (port volný/`--opencode-port`, Basic auth `opencode` + random UUID heslo), `veslo-code-router` (health port volný, výchozí by byl 3005), `veslo-server` (`--port`, `--token`, `--host-token` — UUID tokeny) — cli.ts:6546–6700.
- `--check`/`--check-events` = smoke test a exit; `--detach` = odpojení dětí a exit.

**Auth přehled:**
- Démon: **většina rout bez autentizace** (`/health`, `/workspaces`, aktivace, dispose, proxy `/workspace/:id/opencode/*`). Jen run-lifecycle routy `/workspace/:id/runs/*` vyžadují hlavičku `X-Veslo-Orchestrator-Token` (cli.ts:274, :4813). CORS je `Access-Control-Allow-Origin: *` (cli.ts:4785).
- Engine: Basic auth, heslo teče přes argv/env; proxy ho injektuje do upstream requestu a klientský `authorization` header stripuje.
- `veslo-server`: klientský token + host token.

## Komunikační vazby

| Protistrana | Kanál | Popis |
|---|---|---|
| Tauri desktop (Rust) | spawn procesu + argv/env | `spawn_orchestrator_daemon` — sidecar `veslo daemon run` s tokeny a porty v argumentech |
| Tauri desktop (Rust) | HTTP | `/health` (poll engine stavů, `orchestrator_engines_list`), `/workspaces/:id/activate`, `/instances/:id/dispose`, `/shutdown`, e2e routy |
| Tauri desktop (Rust) | HTTP/SSE | `engine_sse.rs` čte `GET <daemon>/workspace/<ws>/opencode/event` — SSE stream proxovaný démonem z enginu |
| `veslo-server` | HTTP | Registrace workspace `POST /workspaces` (`performOrchestratorWorkspaceRegistration`, server.ts:1279), OpenCode volání přes `…/workspace/:id/opencode/*` (`buildOrchestratorWorkspaceOpencodeBaseUrl`, route-helpers.ts:256), run-lifecycle `POST /workspace/:id/runs/register|failed|aborted…` s lifecycle tokenem |
| OpenCode engine (`veslo-code`) | spawn + env + HTTP/SSE | `serve --hostname --port`; ~20 env proměnných (`OPENCODE_CONFIG_DIR`, `OPENCODE_SERVER_USERNAME/PASSWORD`, `OPENCODE_HOT_RELOAD*`, preload skript pro zvýšení EventEmitter limitů…); health přes `@opencode-ai/sdk` klienta; proxy injektuje `x-opencode-directory` |
| `veslo-code-router` | spawn + env + HTTP | `serve <workspace>`; health port env `OPENCODE_ROUTER_HEALTH_PORT`; TUI spravuje identity (Telegram/Slack) přes veslo-server endpointy `/opencode-router/*` |
| GitHub releases | HTTPS download | Manifest sidecarů `github.com/neatechcz/veslo/releases/...`, OpenCode fork z `github.com/anomalyco/opencode/releases` (`resolveOpencodeDownload`, cli.ts:1081), SHA-256 ověření |
| Souborový systém | soubory | Stav JSON, SQLite runs, JSONL trace soubory (`runtime-trace`, `send-workflow-trace`), zrcadlení `.opencode` configu workspace → per-workspace config dir (`syncWorkspaceOpencodeConfigToConfigDir`) **při každém ne-GET proxy requestu** (cli.ts:5461) |
| Cloud (`ai.veslo.work`) | env → server | `deployment-endpoints.ts` — výchozí `VESLO_MANAGED_AI_BASE_URL` předávaná do `veslo-server` |

## Vazba na OpenCode

**Velmi těsná — orchestrátor je fakticky „OpenCode process manager":**

- Spouštěná binárka `veslo-code` je přejmenovaný/forkovaný OpenCode (verze pinovaná v `package.json` pole `opencodeVersion: 1.17.13`; fallback download z forku `anomalyco/opencode`).
- Závislost na `@opencode-ai/sdk` (health klient) a `@opencode-ai/plugin` (vendorované do workspace).
- Znalost interních chování OpenCode: hot-reload env proměnné, `OPENCODE_DISABLE_CLAUDE_CODE`, preload hack na `EventEmitter.defaultMaxListeners` (`ensureOpencodeListenerLimitPreload`, cli.ts:2457 — obchází limit v OpenCode přes `--require`/`--preload`), sanitizace runtime configu (`opencode-config-sanitizer.ts`), normalizace eventů (`opencode-event-normalization.ts`), sonda project API (`opencode-project-api.ts`).
- ~270 řádků **zdrojáku OpenCode plugin nástrojů vložených jako pole stringů** (`opencodeRouterSendToolSource`/`StatusToolSource`, cli.ts:1756–2026) — zapisují se do config diru enginu, aby agent uměl posílat Telegram/Slack zprávy přes health port routeru.
- Run-activity sonda čte OpenCode session/message stav, aby poznala, jestli run ještě žije.
- Vendorování 9 npm balíčků s pinovanými verzemi synchronizovanými s OpenCode (`opencode-managed-dependencies.ts`).

**Výměna enginu** by znamenala přepsat: spawn + env kontrakt, health protokol, proxy sémantiku (`?directory=`, `x-opencode-directory`), run-activity sondu, vendorování pluginů, embedded tool zdrojáky, config-dir zrcadlení a sandbox write-allowlisty (XDG cesty OpenCode). Prakticky celý balíček kromě generických částí (proxy transport, persistence, port utils).

## Hotspoty složitosti

1. **`cli.ts` = božský soubor (6 934 řádků, ~130 funkcí)** — tři aplikace, HTTP router psaný ručně přes `if (parts[0] === …)`, žádný framework, žádné rozdělení do modulů. Funkce `runRouterDaemon` má ~1 780 řádků, `runStart` ~800.
2. **Dvě topologie enginů** (`pooled-per-workspace` vs. `shared-unsandboxed`) — podmínky na topologii prorůstají celou proxy cestou (cli.ts:4686, :5059, :5108, :5304, :5417, :5576, :5643…). Spawn/health closury pro pool a shared engine jsou ~150 řádků téměř identického kódu (cli.ts:4331–4457 vs. 4482–4622).
3. **Trojité trasování** — každý proxy request generuje logger + `traceRuntime` (JSONL) + `writeSendWorkflowTrace` (JSONL) události s duplikovanými payloady; proxy handler má ~420 řádků, z toho odhadem 70 % je diagnostika (cli.ts:5249–5671).
4. **Matice rozlišování binárek** — `bundled`/`downloaded`/`external` × 3 binárky + verzní manifesty + SHA-256 + GitHub download + rozbalování zip/tar/PowerShell (~700 řádků, cli.ts:835–1683).
5. **Sandbox subsystém** — macOS `sandbox-exec`, Windows WSL2 (včetně PowerShell provision skriptu a přepisu cest ve všech JSON tělech, odpovědích i SSE řádcích), fallback režimy (`resolved`/`explicit-none`/`disabled-by-env`/`unavailable`/`launch-fallback`).
6. **Run-lifecycle distribuovaný stav** — server registruje runy u démona přes HTTP, démon je páruje na enginy (`attachEngineOwner`), při pádu enginu je terminalizuje, sonduje aktivitu dotazy do OpenCode, sweepuje legacy runy… Celý tento aparát existuje jen proto, že server, démon a engine jsou tři oddělené procesy bez sdíleného stavu.
7. **Sync configu v hot path** — `syncWorkspaceOpencodeConfigToConfigDir` + stat souborů při **každém ne-GET requestu** na proxy (cli.ts:5459–5484).
8. **Trojí evidence workspace** — démon (state JSON), `veslo-server` (vlastní registr, do démona se jen „registruje") a Tauri (reconcile). K tomu smiřovací logika `serverWorkspaceId` vs. `appWorkspaceId` vs. path-hash ID + migrace config dirů (`workspace-id.ts`, `workspace-runtime-migration.ts`).

## Duplicity a mrtvý kód

- **Mrtvá větev `orchestrator_start_detached`**: Tauri command (`commands/orchestrator.rs:808`) volá `veslo start --detach`, frontend wrapper `orchestratorStartDetached` existuje (`packages/app/src/app/lib/tauri.ts:814`), ale **nemá žádného volajícího v UI**. Celý `runStart` je tedy z pohledu desktopu mrtvý — slouží jen CLI uživatelům npm balíčku.
- **TUI dashboard (884 řádků + 8 `@opentui/*` závislostí včetně platformových)** — používá ho jen interaktivní CLI `veslo start`; obsahuje i správu Telegram/Slack identit. Pro desktopový produkt nulová hodnota. Navíc křehký hack: interceptování `console.error` a detekce stringu „React is not defined" pro fallback z TUI (cli.ts:6389–6410).
- **Flag `--opencode-workdir`** — desktop ho posílá do `daemon run` (orchestrator/mod.rs:455) a wrapper `daemon start` ho přeposílá (cli.ts:3769), ale `runRouterDaemon` ho **nikdy nečte** → mrtvý parametr.
- **`--opencode-port` v daemon režimu** — resolvuje se (cli.ts:4093), ale pool si porty hledá sám; komentář přiznává, že je to legacy kompat.
- **Legacy pole `opencode`** ve state souboru (deprecated singleton, cli.ts:1712).
- Duplicitní spawn/health/trace closury pool vs. shared engine (viz hotspot 2).
- `resolveVesloServerBin` / `resolveOpencodeBin` / `resolveOpenCodeRouterBin` — tři ~90řádkové takřka identické funkce.
- README sekce sandbox Docker/Apple container označené `*** DEPRECATED ***`; skripty `sandbox-smoke.ts`, `sandbox-realworld-test.ts`, `windows-wsl2-*` jsou vývojářské one-off nástroje.
- **Duplicitní provisioning napříč balíčky**: vendorování pluginů/nástrojů dělá orchestrátor (`opencode-managed-dependencies.ts`), ale obdobný provisioning existuje i v `packages/server/src/internal-system.ts` a v Rustu `internal_provision.rs` (pravidlo „dual provisioning" v kořenovém CLAUDE.md) — tři místa, která se musí ručně držet v synchronu.
- Klientské příkazy `approvals`/`files`/`status` duplikují API, které už vystavuje `veslo-server` (jsou to jen curl wrappery).

## Co by znamenalo oddělení BE/FE (web model API + SPA)

- Orchestrátor-démon **už je čistě headless HTTP backend** — žádná UI vazba (TUI je oddělená a jen pro CLI). Z pohledu SPA se nic nemění; SPA by mluvila stále jen s `veslo-server`.
- Skutečný problém je **řetěz tří backendů**: UI → `veslo-server` → orchestrátor-démon (proxy) → OpenCode engine. Každý hop přidává vlastní health/timeout/retry logiku a trace vrstvu. Ve web modelu je přirozené **sloučit `veslo-server` a démona do jednoho procesu**: engine pool, run-lifecycle i workspace registr jako knihovna uvnitř serveru. Tím zmizí: HTTP run-lifecycle handshake s lifecycle tokenem, registrace workspace přes HTTP, jedna reverse-proxy vrstva a třetí evidence workspace.
- Tauri specifika, která by odpadla: spawn sidecar binárky s tokeny v argv, `/health` polling z Rustu, SSE most v Rustu (`engine_sse.rs`) — SPA si SSE vezme přímo ze serveru.
- Co je nutné zachovat v jakémkoli scénáři: spawn/lifecycle OpenCode enginů per workspace (to je jádro hodnoty tohoto balíčku — `engine-pool.ts` + `startOpencode` + proxy) a autentizaci enginů.
- Pozor: démon dnes běží bez autentizace s CORS `*` — ve web modelu (server dostupný ze sítě) by tenhle model musel být od základu předělán.

## Náměty na zjednodušení

1. **Sloučit orchestrátor-démona do `veslo-server`** (engine pool jako knihovna, ne proces). Zmizí celá HTTP mezivrstva, run-lifecycle přes HTTP, lifecycle token, registrace workspace, jeden proxy hop. Odhad: −3 000 až −4 000 řádků a jedna sidecar binárka méně. (vysoká náročnost, největší přínos)
2. **Smazat `runStart`/`serve` + TUI + detached flow** — pokud CLI „host mode" není produkt, odpadne ~800 řádků `runStart`, 884 řádků TUI, 8 opentui závislostí, mrtvý Tauri command a klientské příkazy `approvals`/`files`/`status` (~600 řádků). (nízká náročnost)
3. **Zrušit `shared-unsandboxed` topologii**, pokud není nutná — odstraní druhou cestu ve všech podmínkách proxy + 289 řádků třídy + duplikované closury. (střední)
4. **Vyříznout trasovací triplicitu** za jeden strukturovaný logger s podmíněným JSONL sinkem — proxy handler se smrskne na třetinu. (nízká–střední)
5. **Zjednodušit resoluci binárek**: v desktop distribuci jsou binárky vždy bundlované vedle sebe — celá download/manifest/SHA mašinerie může být oddělený „CLI installer" balíček nebo úplně pryč. (střední)
6. **Config sync mimo hot path** — synchronizovat `.opencode` config při aktivaci workspace + fs-watcherem, ne při každém POST. (nízká)
7. **Embedded tool zdrojáky** přesunout do skutečných souborů v repozitáři (build je zkopíruje) místo polí stringů. (nízká)
8. **Sjednotit provisioning na jedno místo** (dnes orchestrátor + server TS + Rust). (střední)

## Rizika

- **Bezpečnost lokálního API**: démon má CORS `*`, bez autentizace na proxy a workspace routách; jediná ochrana je bind na 127.0.0.1 a náhodný port. Webová stránka v prohlížeči může na localhost dělat cross-origin requesty (port by musela uhodnout, ale odpovědi by díky CORS `*` i přečetla).
- **Tokeny a hesla v argv** (`--opencode-password`, `--veslo-token`, `--lifecycle-token`) — viditelné v `ps aux`; projektová dokumentace to dokonce doporučuje jako diagnostický postup.
- **Pin na fork OpenCode 1.17.13** (`anomalyco/opencode`) — upgrade enginu vyžaduje současnou aktualizaci vendorovaných balíčků, preload hacků a sanitizerů; download závisí na dostupnosti GitHub releasů forku.
- **Křehké heuristiky**: health strikes → restart enginů, `markUnhealthy` při proxy chybách (u shared enginu může chybný klasifikátor způsobit restart při obyčejném odpojení SSE), run-activity sondy s progress-signature heuristikami.
- **Stav ve třech evidencích** (démon JSON, server, Tauri) + legacy-ID migrace — trvalý zdroj race conditions a „rozbitých workspace".
- Jakýkoli refaktor musí zachovat kontrakt HTTP rout démona, na kterém závisí jak Rust (Tauri), tak `veslo-server` (registrace, proxy, run-lifecycle) — chybí sdílená typová definice tohoto API (Rust má vlastní structy, server vlastní klienty).
