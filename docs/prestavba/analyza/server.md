# Analýza: packages/server (veslo-server)

Analyzováno čtením kódu v `packages/server` (commit stav k 2026-07-19). Všechny cesty níže jsou relativní k tomuto adresáři, pokud není uvedeno jinak.

---

## 1. Účel a rozsah

**veslo-server** je samostatná HTTP služba („Filesystem-backed API for Veslo remote clients", `package.json`), kompilovaná do nativní binárky přes `bun build --compile` (`build:bin`). Běží jako **sidecar Tauri desktopu** — spouští ji Rust (`packages/desktop/src-tauri/src/veslo_server/spawn.rs`), default `127.0.0.1:8787`.

Slouží jako **centrální aplikační backend Vesla**:

1. **API pro SolidJS frontend** — 178 registrovaných rout (skills, plugins, MCP, automatizace, konverzace, soul/paměť, soubory, workspace management).
2. **Reverzní proxy na OpenCode engine** — `/opencode/*` a `/workspace/:id/opencode/*` s doplněním basic auth a `x-opencode-directory` hlavičky (`src/server.ts:1572`).
3. **Proxy na opencode-router** (messaging sidecar Telegram/Slack) — `/opencode-router/*` (`src/server.ts:1684`).
4. **AI gateway broker** — `/ai-gateway/providers/*`: engine má za „model provider" URL tohoto serveru; server injektuje cloudovou autorizaci přihlášeného uživatele do model requestů (`src/ai-gateway-runtime-owner.ts`, `src/server.ts:2331`).
5. **Konverzační vrstva nad OpenCode sessions** — vlastní SQLite databáze bindingů a transkriptů, fronta runů, lifecycle reconciler.
6. **Provisioning workspace** — zápis managed bloků do `AGENTS.md`, `.opencode/agents/veslo.md`, soul souborů, `opencode.json` (`src/internal-system.ts`).

**Rozsah:** 246 souborů, ~93 800 řádků TS v `src/`. Z toho **~47 300 řádků (50 %) jsou testy** (129 `*.test.ts` souborů). Produkční kód ~46 500 řádků. Největší soubory: `src/server.ts` (4 883), `src/toy-ui.ts` (1 812), `src/routes/conversations.ts` (1 675), `src/conversation-run-lifecycle-controller.ts` (1 654), `src/routes/opencode-router.ts` (1 567), `src/internal-system.ts` (1 243).

Řádky podle subsystémů (bez testů): **skills ~9 160**, **conversations ~8 550**, plugins ~2 780, soul ~2 690, toy-ui 1 812, ai-gateway ~1 100 (+ ~600 v server.ts).

**Je to samostatně spustitelný backend?** Ano — `src/cli.ts` je čistý CLI entry point, žádný import Tauri, konfigurace přes CLI/env/`~/.config/veslo/server.json`. Prakticky je ale **provozně srostlý s desktopem**: Rust mu předává secrets file (`VESLO_SECRETS_FILE`), runtime descriptor path, sandbox backend, OpenCode credentials, port opencode-routeru atd. a čte jeho ready handshake (`VESLO_SERVER_READY {json}` na stdout + atomický descriptor soubor, `src/cli.ts:35-77`).

---

## 2. Architektura a klíčové soubory

### Vstup a jádro
| Soubor | Role |
|---|---|
| `src/cli.ts` (102) | Entry point: parse args → config → start → ready handshake |
| `src/config.ts` (517) | Precedence CLI > secrets file > env > server.json; workspaces, tokeny, orchestrátor URL, Den API base |
| `src/server.ts` (4 883) | **God file**: `Bun.serve` fetch handler, auth (`requireClient/requireHost`, ř. 2922–2968), 3 proxy (OpenCode, router, AI gateway), orchestrátor fallback + registrace workspace (ř. 1218–1489), AI gateway diagnostika/trace, `buildCapabilities` (ř. 2972), `createRoutes` — DI wiring všech stores (ř. 4127–4650) |
| `src/routing.ts` (62) | Vlastní mini-router (regex, `:param`), auth mód per routa (`none/client/host/hostOrClient`) |
| `src/routes/` (22 souborů) | Registrace rout po doménách |

### Autentizace
- **Client token** (bearer) + **host token** (`X-Veslo-Host-Token`); generují se, nebo přijdou ze secrets file.
- Dodatečné tokeny se scope `owner/collaborator/viewer` v `~/.config/veslo/tokens.json` (`src/tokens.ts`).
- Proxy na OpenCode má per-scope politiku povolených cest (`assertOpencodeProxyAllowed`, `src/server.ts:626`).

### Persistence (roztříštěná, 4 mechanismy)
1. **SQLite** (`bun:sqlite`): conversation bindings + transkripty v `bindings.sqlite` v datadiru (`src/conversation-binding-store.ts`, `src/conversation-transcript-store.ts`). Transkript store je **host-side zrcadlo engine `opencode.db`** — komentář v kódu: sandbox/WSL runtime je jen producent, host je „durable source of truth".
2. **JSON soubory v datadiru / home**: `~/.veslo/veslo-server/session-archives`, run queue, submit attempts, user-skill store, skill enabled overrides, plugin policy…
3. **Zápisy do workspace `.opencode/`**: skills, plugins, `automations.json` (`.opencode/veslo/automations.json`), MCP konfigurace v `opencode.json(c)` (`src/mcp.ts`), managed bloky v `AGENTS.md`, soul soubory.
4. **In-memory**: approvals, file sessions, reload events (polling přes `/workspace/:id/events`, ne SSE — `src/events.ts`).

### Konverzační pipeline (nejsložitější část)
Řetěz: `routes/conversations.ts` → `conversation-submit-service.ts` (552) → `conversation-submit-contract.ts` (409) + `conversation-submit-draft-resolution.ts` (545) + `conversation-submit-attempt-store.ts` (dedup) → `conversation-service.ts` (843, binding + transcript) → `conversation-run-queue-store.ts` (683) → `conversation-run-lifecycle-controller.ts` (1 654, background reconciler) → OpenCode HTTP (`fetchOpencodeJsonWithOrchestratorFallback`) + orchestrátor lifecycle klient. K tomu `conversation-transcript-ingest*.ts`, `session-transcript-prefetch.ts` (611, cache). Vše je propojené přes ports/DI vzor s desítkami typů (viz hlavička `conversation-run-lifecycle-controller.ts`).

### AI gateway broker
`src/ai-gateway-runtime-owner.ts` (936) drží: runtime autorizace uživatelů (z desktop loginu), registr aktivních runů, „session hit" heuristiku s 5 zdroji resolution (`veslo-session-header`, `opencode-session-header`, `workspace-active-run-context`, `sessionless-fallback`, `unresolved`), abort propagaci do probíhajících model requestů a rozsáhlou diagnostiku. Cíl proxy: cloud `veslo.work` (Den AI gateway) nebo lokální `AI_GATEWAY_PORT`.

---

## 3. Komunikační vazby

| Protistrana | Kanál | Popis |
|---|---|---|
| SolidJS app (`packages/app`) | HTTP (fetch, bearer token) | Hlavní konzument; klient v `packages/app/src/app/lib/veslo-server/client.ts` + `veslo-server-domains/*` (12 domén) |
| Desktop Rust (`packages/desktop`) | proces (spawn, stdout handshake, env, secrets file) + HTTP | Rust server spouští a superviduje; sám je i HTTP klientem (`src-tauri/src/workspace/server_client.rs` — registrace lokálních workspace přes `POST /workspaces/local`, host token) |
| OpenCode engine | HTTP proxy + přímá REST volání | `/opencode/*` proxy (streaming SSE průchozí); interně `fetchOpencodeJson` na `/session`, `/session/:id/prompt_async|command|shell|summarize|abort|revert` (`src/server.ts:4331-4437`) |
| Orchestrátor daemon | HTTP (`X-Veslo-Orchestrator-Token`) | (a) run lifecycle: `POST /workspace/:id/runs/register`, `.../failed`, `.../aborted`, `GET .../runs/:id` (`src/orchestrator-lifecycle-client.ts`); (b) fallback cesta k enginu přes orchestrátorem mountovaný `/workspace/:id/opencode`, včetně registrace workspace do orchestrátoru (`src/server.ts:1279-1489`) |
| opencode-router sidecar | HTTP proxy + sdílený soubor | Proxy na `http://127.0.0.1:$OPENCODE_ROUTER_HEALTH_PORT`; přímé zápisy konfigurace do `~/.veslo/opencode-router/opencode-router.json` (`src/routes/opencode-router.ts:907`) |
| Den cloud (veslo.work) | HTTPS | AI gateway proxy, skill registry (`/v1/skill-*`, `src/skill-registry-client.ts`), soul sync (`src/soul-den-client.ts`), hub katalog skills/MCP (`src/den-catalog.ts`), debug-log shipping (`src/debug-log-uploader.ts`) |
| OpenCode pluginy ve workspace | soubor | Delegate plugin čte server state ze souboru `VESLO_SERVER_STATE_PATH` (baseUrl + clientToken) a volá server HTTP — vzor viz embedded (vypnutý) automations plugin v `src/internal-system.ts:664-689` |
| Legacy plánovač | procesy | `src/scheduler.ts` volá `launchctl`/`systemctl` pro mazání `opencode-job-*` jednotek |

Pozn.: server **nemá žádný SSE/WebSocket vlastní endpoint** — real-time engine události jdou buď přes proxy `/opencode/event`, nebo mimo server přes Tauri IPC (`engine_sse.rs` v desktopu). Vlastní události (reload, file sessions) jsou polling.

---

## 4. Vazba na OpenCode

- **Žádný SDK import**: produkční kód neimportuje `@opencode-ai/*` (jediný výskyt je uvnitř mrtvého embedded plugin stringu). Vazba je čistě **HTTP REST + souborové konvence**.
- **Zadrátované REST cesty enginu**: `/session`, `/session/:id/prompt_async` atd. přímo v `server.ts`.
- **Souborový layout `.opencode/`**: skills (`.opencode/skills/`), plugins (`.opencode/plugins/`), automatizace (`.opencode/veslo/`), MCP a instrukce v `opencode.json(c)`, soul soubory (`.opencode/soul-*.md`). Server je de facto správcem tohoto layoutu.
- **Pojmenování prosakuje všude**: 48 z 92 produkčních modulů obsahuje „opencode"; `ConversationBinding.engine` je hardcoded `"opencode"` (`src/conversation-binding-store.ts:12`).
- **Duální cesta k enginu**: přímý `workspace.baseUrl` vs. orchestrátorem mountovaný engine, s křehkou retry heuristikou postavenou na textech chyb („connection refused", „engine_not_running"… `src/server.ts:1218`).
- **Zrcadlení engine dat**: transcript store duplikuje obsah engine `opencode.db` do vlastní SQLite (kvůli sandbox/WSL běhu).

**Výměna enginu** by znamenala přepsat: proxy vrstvu, conversation service (mapování session), submit paths, transcript ingest, provisioning (`internal-system.ts`), zápis MCP/instrukcí do `opencode.json`, skill roots. Díky absenci SDK a koncentraci volání do `server.ts` (22 call-sites) je to však **výrazně schůdnější než v desktopu** — engine je za HTTP hranicí.

---

## 5. Hotspoty složitosti

| Místo | Problém | Závažnost |
|---|---|---|
| `src/server.ts` (4 883 ř.) | God file: auth + 3 proxy + AI gateway diagnostika + orchestrátor fallback/registrace + DI wiring všech stores. Každá změna prochází tudy. | kritická |
| Konverzační pipeline (~8 550 ř., 15+ souborů) | Vlastní stavový stroj runů duplikuje stav, který drží orchestrátor (server se ho doptává HTTP); ports/DI vzor s desítkami typů; queue + attempt dedup + lifecycle reconciler + transcript ingest + prefetch cache. | kritická |
| Skill subsystém (~9 160 ř., ~20 modulů + 7 route souborů) | 4 skill roots (user/workspace/org/platform), vzdálený registry s review/rollout workflow (`/v1/skill-*`), lockfile, removal journal, enabled overrides, import candidates, materializer — enterprise-grade správa pro desktop appku. | vysoká |
| `src/ai-gateway-runtime-owner.ts` (936 ř.) | Heuristické párování engine model-requestů na uživatelskou autorizaci (5 zdrojů, TTL, fallbacky) — implicitně křehké, obsáhlá diagnostika svědčí o častém ladění. | vysoká |
| Dual provisioning | `src/internal-system.ts` (1 243 ř.) se musí ručně zrcadlit do `packages/desktop/src-tauri/src/workspace/internal_provision.rs` (1 243 ř.). | vysoká |
| `src/toy-ui.ts` (1 812 ř.) | Embedded debug web UI na `/ui`, bez autentizace (routy `auth: "none"`), **defaultně zapnuté** (`resolveToyUiEnabled`, `src/server.ts:3047` — bez `VESLO_TOY_UI` → true). | střední |
| Konfigurace přes env | **127 různých env proměnných** čtených napříč `src/` — skryté stavy, těžká reprodukce chyb. | vysoká |
| Tři generace plánovačů | `src/scheduler.ts` (launchd/systemd `opencode-job-*`), `agentlab` automations (v kódu označené „toy-ui only, no production UI callers"), aktuální `automation-runner.ts`. | střední |
| Orchestrátor fallback | Retry rozhodování podle textu chybové hlášky (`src/server.ts:1218-1239`). | střední |
| Testy = 50 % balíčku | 47 300 řádků testů brzdí každý refaktor (musí se přepisovat spolu s kódem). | střední |

---

## 6. Duplicity a mrtvý kód

**Prokazatelně mrtvé (bez importu mimo testy):**
- `src/reload-watcher.ts` (392 ř.) — `startReloadWatchers` nemá jediného volajícího.
- `src/skill-adoption.ts` (143 ř.), `src/skill-package-cache.ts` (124 ř.), `src/paths.ts` (20 ř.).

**Mrtvé uvnitř `src/internal-system.ts`:**
- `automationsPluginEnabled()` vrací natvrdo `false` (ř. 515) → `activeAutomationsPluginSource()` (~400 ř. embedded JS pluginu, ř. 519–913) se nikdy nezapíše; provisioning místo toho existující kopie aktivně **maže** (quarantine).
- `internalAgentDocument`, `internalSkillCreatorAgentDocument`, `managedVesloRoutingBlock` — definované, nikde nevolané.
- `provisionCentralPacks` — export „compatibility wrapper" bez konzumenta v celém repu.
- Velká část souboru je jednorázový legacy cleanup (`removeLegacy*`).

**Legacy/duplicitní API:**
- 6 rout `/workspace/:id/agentlab/automations*` — v kódu komentář „@internal: toy-ui only, no production UI callers" (`src/routes/automations.ts:232+`).
- `/workspace/:id/scheduler/jobs*` + celý `src/scheduler.ts` — správa staré generace `opencode-job-*` jednotek.
- `/whoami` — bez volajícího v app i desktopu.
- Duplicitní skill store API: `/skills/user-global-store/*` vs. `/skills/user-global/*` (dvě generace téhož).
- Dual provisioning TS/Rust (viz výše) — z definice 1 243 řádků duplicitní logiky.
- Transcript store = záměrná duplikace engine dat (druhý zdroj pravdy).
- `src/toy-ui.ts` — paralelní mini-frontend vedle skutečné SPA.

---

## 7. Co by znamenalo oddělení BE/FE

**Dobrá zpráva: tento balíček UŽ JE oddělený backend.** Čisté HTTP API, bearer auth, CORS, žádný import Tauri, samostatná binárka, mount `/w/:id` pro vzdálený single-workspace přístup. Model „API + SPA" tady v zásadě existuje.

Co reálně chybí / co by se muselo dořešit:

1. **Polovinu backend práce dnes dělá desktop Rust** — spawn a supervize enginů, orchestrátoru, routeru, provisioning (Rust twin), health-checky portů, secrets, forwarding engine SSE přes Tauri IPC. Skutečné oddělení = přesunout lifecycle procesů do serveru/orchestrátoru a nechat Tauri jen jako tenký shell (nebo zrušit).
2. **Real-time kanál**: server nemá vlastní SSE/WS; UI by muselo engine události brát přes proxy `/opencode/event` (funguje, streaming je průchozí) a serverové události převést z pollingu na SSE.
3. **Auth handshake**: dnes desktop-centric (secrets file, runtime descriptor, `VESLO_SERVER_STATE_PATH`); pro web model nahradit standardním loginem (Den auth už existuje).
4. **AI gateway runtime autorizace** je navázaná na desktop login flow — pro čistý web model by se zjednodušila (autorizace by přišla rovnou s requestem).
5. Endpointy pro souborový přístup (`/files/sessions/*`, `/workspace/:id/files/*`) a export/import už vzdálený klient předpokládají.

Čili: oddělení BE/FE není u serveru přepis, ale **ořez desktopové obsluhy okolo něj**.

---

## 8. Náměty na zjednodušení

| Nápad | Dopad | Náročnost |
|---|---|---|
| Smazat mrtvý kód: reload-watcher, skill-adoption, skill-package-cache, paths, mrtvé části internal-system, agentlab routy, scheduler routy + scheduler.ts, `/whoami` | ~2 500+ ř. produkčního kódu + příslušné testy; menší API surface | nízká |
| Vypnout/vyhodit toy-ui (1 812 ř.), nebo aspoň default off | Menší binárka, menší nechráněný povrch | nízká |
| Zrušit dual provisioning — jediná implementace na serveru, Rust volá server API (pravidlo „server-consumption first" už je v AGENTS.md) | Konec ručního zrcadlení 2×1 243 ř.; jediný zdroj pravdy | střední |
| Jediná cesta k enginu (vždy přes orchestrátor mount, žádný direct-baseUrl fallback) | Odpadne registrace/fallback logika v server.ts (~300 ř.) a křehké retry heuristiky | střední |
| Vlastnictví run lifecycle dát jednomu procesu (orchestrátor NEBO server) | Odpadne HTTP ping-pong a duplicitní stavový stroj; konverzační pipeline se může zmenšit o 30–50 % | vysoká |
| Skill systém zredukovat na 2 roots (workspace + user), registry/review/rollout (`/v1/skill-*`) přesunout do Den nebo vyhodit | ~4–5 000 ř. méně; ubydou 4 route soubory | střední–vysoká |
| Konsolidovat konfiguraci: 127 env proměnných → jeden typovaný config | Reprodukovatelnost, méně skrytých stavů | střední |
| Rozbít server.ts na moduly (auth, proxy, wiring) | Bezpečnější změny, lepší AI-asistovaný vývoj | střední |
| Zvážit zrušení host-side transcript mirroru, pokud padne sandbox/WSL požadavek | −2 000+ ř. (transcript store + ingest + prefetch) | vysoká (produktové rozhodnutí) |

---

## 9. Rizika

- **Křehkost god file**: většina provozních cest (auth, proxy, submit) prochází `server.ts`; regrese se snadno šíří napříč funkcemi.
- **Dva zdroje pravdy pro konverzace** (engine DB vs. server SQLite) — riziko rozjetí transkriptů; složitá reconcile logika už dnes existuje právě kvůli tomu.
- **Heuristiky místo kontraktů**: orchestrátor fallback podle textu chyb; AI gateway session resolution podle TTL heuristik — typický zdroj „pořád se něco rozbíjí".
- **Konfigurační entropie**: 127 env proměnných + 4 persistence mechanismy + secrets file + server.json → obtížná diagnostika u uživatelů.
- **Nechráněný `/ui`** (toy UI, default on) — malé riziko (bind na 127.0.0.1, API volání stále chtějí token), ale zbytečný povrch; CORS default `*`.
- **Refaktor brzdí testy**: 47k řádků testů je pevně svázáno s vnitřní strukturou (ports/DI) — každé zjednodušení znamená masivní úpravy testů.
- **Skryté kontrakty s pluginy**: delegate plugin čte `VESLO_SERVER_STATE_PATH` a volá server — změny API mohou tiše rozbít workspace pluginy.
- **CalVer bez API verzování**: 178 rout bez verzí (kromě `/v1/skill-*`) — klienti (app, Rust, pluginy) jsou vázáni na přesnou verzi serveru.
