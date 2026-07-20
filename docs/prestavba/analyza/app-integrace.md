# Analýza: packages/app — integrační vrstva (UI ↔ okolí)

Analyzováno: 2026-07-19, zdroj `packages/app`

## Účel a rozsah

`packages/app` je sdílený SolidJS frontend (jméno balíčku `@neatech/veslo-ui`), který běží ve dvou režimech: uvnitř Tauri webview (desktop) a jako čistá SPA (web/Docker „remote" režim). Tato analýza pokrývá **výhradně integrační vrstvu** — veškerý kód, kterým UI mluví s okolím: Tauri IPC (invoke + events), HTTP klienty, SSE a OpenCode SDK.

Rozsah balíčku: **363 zdrojových souborů, ~128 000 řádků** (bez testů). Z toho integrační vrstva v užším smyslu (`lib/tauri.ts`, `lib/opencode.ts`, `lib/engine-sse.ts`, `lib/den-auth.ts`, `lib/veslo-server/*`, `lib/veslo-server-domains/*`, `context/veslo-server-connection.ts`, `context/server.tsx`, `context/global-sdk.tsx`, `lib/db-reader.ts`, `lib/feedback.ts`, `lib/publisher.ts`) činí **~13 000 řádků**. Reálná integrační logika ale prosakuje i do obřích context souborů (`context/` má celkem 37 119 řádků — `extensions.ts` 3 665, `workspace.ts` 1 805, `conversation-service.ts` 1 792, `session-event-stream.ts` 1 704, `veslo-server-connection.ts` 1 574).

## Architektura a klíčové soubory

Integrace je vrstvená do **čtyř paralelních kanálů**, které se všechny sbíhají v context vrstvě:

| Kanál | Soubor(y) | LOC | Účel |
|---|---|---|---|
| Tauri IPC (invoke) | `src/app/lib/tauri.ts` | 1 467 | Centrální wrapper: **82 call-sites, ~88 unikátních příkazů** |
| Tauri IPC (rozptýlené) | `lib/engine-sse.ts`, `lib/bootstrap-diagnostics.ts`, `lib/db-reader.ts`, `lib/den-auth.ts` | ~1 700 | SSE bridge, diagnostika, čtení SQLite, auth snapshot |
| HTTP — veslo-server REST | `lib/veslo-server/` (7 souborů, 4 088 LOC) + `lib/veslo-server-domains/` (12 domén, 2 429 LOC) | 6 517 | Vlastní ručně psaný REST klient, **~100 endpointů, ~130 metod** (`client.ts:356-679`) |
| HTTP — OpenCode SDK | `lib/opencode.ts` (618), `context/global-sdk.tsx` (243), `context/server.tsx` (234) | ~1 100 | `@opencode-ai/sdk` 1.17.13, `createOpencodeClient` s vlastním fetch |
| SSE | `lib/engine-sse.ts` (359) + konzumenti `context/global-sdk.tsx`, `context/session-event-stream.ts` (1 704) | ~2 300 | Duální transport: Rust-side proxy (IPC) vs. SDK `event.subscribe` |
| HTTP — Den identity | `lib/den-auth.ts` (1 156), `lib/deployment-endpoints.ts`, `lib/feedback.ts` (223) | ~1 500 | OAuth/PKCE desktop auth, validace tokenů, feedback |

### Klíčový bootstrap tok (desktop)

1. UI zavolá IPC `veslo_server_info` (`lib/tauri.ts:828`) → dostane `baseUrl`, `clientToken`, `hostToken` lokálního veslo-server sidecaru.
2. `context/veslo-server-connection.ts` (1 574 řádků) z toho postaví HTTP klienta (`createVesloServerClient`) a poslouchá Tauri event `veslo://server-state` pro změny životního cyklu (`veslo-server-connection.ts:223`).
3. Aktivace workspace jde přes IPC (`workspace_set_active`, `runtime_prepare_workspace` — `context/workspace-activation-local.ts:232-330`), která na Rust straně nastartuje orchestrátor/engine.
4. Per-workspace OpenCode klient se vytváří přes `context/workspace-routing.ts:275` (`createClient(baseUrl, directory, auth)`) — baseUrl je buď orchestrátor proxy, nebo veslo-server proxy `/workspace/:id/opencode` (`context/server-url.ts:45`).
5. Události tečou přes Rust-side SSE bridge: IPC `engine_sse_subscribe` + Tauri event `veslo://engine-sse-event` (`lib/engine-sse.ts`).

Na webu (bez Tauri) se kroky 1-3 přeskočí — `context/server.tsx:70-87` vynutí same-origin proxy `/opencode` a SSE jde přes SDK fallback (`global-sdk.tsx:204-212`, `session-event-stream.ts:1329`).

## Komunikační vazby — kompletní inventura

### A. Tauri IPC — invoke příkazy (~88 používaných z ~100 registrovaných v `desktop/src-tauri/src/lib.rs:309-413`)

Kategorie (vše v `lib/tauri.ts`, pokud není uvedeno jinak):

- **Engine lifecycle (7):** `engine_start`, `engine_stop`, `engine_restart`, `engine_info`, `engine_doctor`, `engine_install`, `runtime_prepare_workspace`
- **Orchestrátor (5):** `orchestrator_status`, `orchestrator_engines_list`, `orchestrator_workspace_activate`, `orchestrator_instance_dispose`, `orchestrator_start_detached` (nepoužitý)
- **Veslo-server lifecycle (2):** `veslo_server_info`, `veslo_server_restart`
- **Workspace registry (13):** `workspace_bootstrap`, `workspace_set_active`, `workspace_create`, `workspace_create_remote`, `workspace_update_remote`, `workspace_update_display_name`, `workspace_forget`, `workspace_private_root`, `workspace_copy_into_folder`, `workspace_add_authorized_root`, `workspace_grant_folder_access`, `workspace_export_config`, `workspace_import_config` — registr workspace **žije v Rustu**, ne na serveru
- **Workspace config (2):** `workspace_veslo_read/write`
- **Skills — lokální filesystem (12):** `list_local_skills`, `list_local_skills_scoped`, `read_local_skill(_at_path)`, `read_local_skill_files_at_path`, `write_local_skill(_at_path)`, `uninstall_skill(_at_path)`, `import_skill`, `install_skill_template`, `install_global_skill_template`, `opkg_install`
- **OpenCode config (2):** `read_opencode_config`, `write_opencode_config`
- **OpenCode commands (3):** `opencode_command_list/write/delete`
- **OpenCode DB přímo (4):** `opencode_db_migrate`, `opencode_db_update_session_directory`, `opencode_db_read_sessions` (mrtvé), `opencode_db_read_transcript` (mrtvé)
- **MCP (1):** `opencode_mcp_auth`
- **OpenCodeRouter (4):** `opencodeRouter_info/start/stop/status` (+ `opencodeRouter_config_set` registrován v Rustu, z UI nevolán)
- **Scheduler (2):** `scheduler_list_jobs`, `scheduler_delete_job` — **oba mrtvé** (nahrazeno HTTP automations)
- **Pending drafts (4):** `pending_session_drafts_list/get/put/delete` (rozepsané zprávy, serializace příloh na bytes — `tauri.ts:296-366`)
- **Updater (3):** `updater_environment`, `updater_prepare_install`, `updater_relaunch_after_install` + plugin-updater `check()` (`system-state.ts:540`)
- **Obsidian (4):** `obsidian_is_available`, `open_in_obsidian`, `write/read_obsidian_mirror_file`
- **Diagnostika (4):** `log_ui_event` (`tauri.ts:1466`), `record_bootstrap_diagnostic`, `set/clear_bootstrap_diagnostics_cloud_context` (`lib/bootstrap-diagnostics.ts`)
- **Den auth snapshot (2):** `den_auth_snapshot_read/write` (`lib/den-auth.ts:12-13` — dynamické konstanty, persistence auth stavu na disku)
- **AI access proof cache (3):** `access_proof_ai_read/write/clear`
- **Ostatní:** `clipboard_file_paths`, `reset_veslo_state`, `reset_opencode_cache`, `wsl_sandbox_repair`, `wsl_prerequisites_repair`, `desktop_sandbox_environment`, `desktop_runtime_preferences_read/write`, `app_build_info`, `set_window_decorations`
- **SSE bridge (2):** `engine_sse_subscribe/unsubscribe` (`lib/engine-sse.ts:250,274`)

### B. Tauri events (listen)

- `veslo://engine-sse-event` — datový tok SSE z Rustu (`engine-sse.ts:17`)
- `veslo://server-state` — push změn stavu veslo-server sidecaru (`veslo-server-connection.ts:223`)
- `veslo://auth-complete` — deep-link návrat z browser OAuth (`app.tsx`, `app-startup-hydration.ts`)
- plugin-deep-link `onOpenUrl` (`app-startup-hydration.ts:523`)

### C. Tauri pluginy (mimo invoke)

`plugin-http` (tauriFetch — **všechny** HTTP požadavky v desktopu kvůli CORS, `transport.ts:297`), `plugin-dialog` (pick/save file, `tauri.ts:878-919`), `plugin-opener` (openUrl/openPath — 6 míst), `plugin-updater`, `plugin-process` (relaunch), `plugin-deep-link`, `@tauri-apps/api/window` (titlebar, drag, minimize — `tauri.ts:1367-1448`), `@tauri-apps/api/path`, `@tauri-apps/api/webview`.

### D. HTTP — veslo-server REST (~100 endpointů)

Ručně psaný klient bez OpenAPI (`lib/veslo-server/client.ts` — 681 řádků, jen fasáda; `types.ts` — 1 992 řádků ručních typů). Domény: `/workspaces`, `/workspace/:id/{conversations,sessions,artifacts,inbox,files,skills,soul,automations,export,import,system/provision}`, `/skills/*` (materialization, user-global-store, import-candidates), `/v1/skills*` (registry: search, versions, installations, review-requests, rollout-policies), `/soul/*`, `/session-archives`, `/hub/{skills,mcp}`, `/opencode-router` (messaging identities Telegram/Slack), `/document-runtime/*`, `/ai-gateway/me/*`, `/health`, `/status`, `/capabilities`. Auth: Bearer `clientToken` / `hostToken` z IPC `veslo_server_info`. Timeouty per-operace natvrdo (`client.ts:367-393`).

- Odesílání zpráv jde primárně přes tento kanál („Veslo Write API": `createConversation` / `submitConversation` / `runConversation` — `context/conversation-service.ts:1003-1117`, `pages/session-mutation-workflow.ts:357-423`), SDK je fallback.
- Listing sessions pro sidebar: veslo-server Read API s SDK fallbackem (`context/sidebar-workspace-sessions.ts:503,703`).

### E. HTTP — OpenCode SDK (přímo z UI)

`createOpencodeClient` z `@opencode-ai/sdk/v2/client` (pinned 1.17.13). Užívané metody: `global.health`, `session.list/abort/revert/unrevert/shell/command`, `question.list/reply/reject`, `permission.list/reply`, `mcp.list/add/remove/auth/status/refreshRuntimeToken/logoutAuth/listHub/installHub`, `command.list`, `path.get`, `event.subscribe` (web fallback). SDK typy (`Message`, `Part`, `Event`, `Session`) prosakují do ~40 souborů včetně komponent (`message-list.tsx`, `part-view.tsx`, `composer.tsx`).

### F. SSE — duální implementace

1. **Desktop:** Rust-side proxy — JS jen `listen()`; zdůvodnění: SDK SSE přes tauriFetch držel IPC kanál a blokoval paralelní požadavky na 60 s (`engine-sse.ts:1-11`, `global-sdk.tsx:147-153`).
2. **Web:** SDK `event.subscribe`.
Dva nezávislé konzumenty s duplikovanou logikou coalescingu a front: `global-sdk.tsx:93-180` a `session-event-stream.ts` (1 704 řádků: reconnect, catch-up bez kurzoru — „eventual-reconciliation", `session-event-stream.ts:1355-1375`).

### G. HTTP — externí služby

- **Den identity:** `{denApiBase}/v1/me`, `/v2/desktop-auth/start|status|exchange`, `/v1/feedback` (`den-auth.ts:719-1125`, `feedback.ts:207`). Základ URL odvozen z `https://{api|ai|app|admin|workers}.veslo.work` (`deployment-endpoints.ts:13`).
- **MCP OAuth přes Den:** `mcp-connection-workflow.ts:385`.
- **Publisher/share:** `https://share.veslo.neatech.com/v1/bundles` (`publisher.ts:7,49`).
- **OpenCodeRouter health port:** přímý fetch `http://127.0.0.1:3005/config/groups` — **natvrdo v `lib/tauri.ts:1252,1270`**, tedy HTTP volání schované v „IPC" souboru.
- **Sentry/GlitchTip** (`lib/error-monitoring.ts`), boot-trace sink (`context/workspace.ts:1118`).

### Poměr IPC vs. HTTP

- **Datová rovina** (sessions, zprávy, transkripty, skills při připojeném serveru, soul, files, automations, MCP, hub): převážně **HTTP** (veslo-server + SDK) — přežije web model.
- **Řídicí rovina** (start/stop enginů, orchestrátor, registr workspace, lokální FS skills, opencode.jsonc na disku, drafty, updater, okno, dialogy): **100 % Tauri IPC** — ~88 příkazů, vyžaduje desktop.
- Hrubý odhad: **~60-65 % operací týkajících se dat už jde přes HTTP; ~35-40 % funkcí (celá řídicí rovina) je IPC-only.** Klíčové ale je, že HTTP kanál se bez IPC bootstrapu (token + baseUrl z `veslo_server_info`) v desktopu vůbec nenaváže.

## Vazba na OpenCode

1. **SDK pinned na přesnou verzi** `@opencode-ai/sdk` 1.17.13 (`package.json`), import z interní cesty `/v2/client`. Typy SDK (Message/Part/Event/Session) jsou de facto doménovým modelem UI — prosakují do ~40 souborů včetně čistě prezentačních komponent.
2. **UI přepisuje OpenCode konfiguraci:** `lib/opencode.ts:400-561` (`applyGatewayProviderRouting`) generuje provider sekce `opencode.jsonc` — směruje modely přes veslo-server AI gateway, vkládá šablony `{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}`, `${OPENCODE_SESSION_ID}` do hlaviček, spravuje varianty Codex OAuth modelů. K tomu redakce/scrubbing tajemství a porovnávání konfigurací (`managedConfigContentsMatchForServerPatch`) — frontend zde dělá práci backendu.
3. **UI zná interní chování enginu:** cold-start 15-30 s → 60s timeout (`opencode.ts:22-29`), OAuth 5 min, MCP auth 90 s; zná SSE sémantiku enginu (chybějící cursor fence), formát chyb orchestrátor proxy (`transport.ts:391-399` — „workspace not found" → `workspace_registry_unsynced`).
4. **Události enginu jsou přímo OpenCode eventy** (`session.status`, `message.part.updated`, `todo.updated`, `mcp.tools.changed` — `global-sdk.tsx:100-117`) — celý reaktivní model UI je postaven na event schématu OpenCode.
5. **Přímý přístup do OpenCode SQLite** přes Rust (`opencode_db_migrate`, `opencode_db_update_session_directory` — obcházejí engine API a sahají na interní schéma DB).

**Výměna enginu** by znamenala: vyměnit SDK a všechny typy (40 souborů), přepsat event normalizaci a coalescing (globální + session stream), přepsat generátor provider konfigurace, přepsat DB-level příkazy v Rustu, a přeladit všechny timeouty/workaroundy. Odhad: zasažena třetina až polovina balíčku — vazba je **těsná, ale z ~80 % soustředěná do lib/ + context/ vrstvy**; komponenty jsou zasaženy hlavně přes typy.

## Hotspoty složitosti

1. **`context/veslo-server-connection.ts` (1 574 ř.)** — stavový automat kombinující IPC polling (`veslo_server_info`), Tauri event push (`veslo://server-state`), HTTP health-check a restart logiku; tři různé způsoby, jak zjistit „běží server?".
2. **`context/session-event-stream.ts` (1 704 ř.)** — SSE reconnect s vlastní frontou, coalescing, catch-up bez kurzorového plotu, duální transport, trace instrumentace. Nejrizikovější soubor integrace.
3. **`context/extensions.ts` (3 665 ř.)** — arbitráž mezi ~4 zdroji skills (server HTTP / lokální IPC / hub / registry) podle `vesloServerStatus()` a capabilities; kaskádové fallbacky.
4. **`lib/opencode.ts` (618 ř.)** — generování a scrubbing provider konfigurace na frontendu (viz výše).
5. **Trojí auth model:** OpenCode basic auth (username/password), veslo-server Bearer (clientToken/hostToken), Den Bearer (user token) — a jejich kombinace v hlavičkách (`header-profiles.ts`, `resolveOpencodeProxyAuthHeaders`).
6. **`isTauriRuntime()` na 250 místech v 58 souborech** — runtime větvení desktop/web je rozeseté po celé aplikaci místo jedné abstrakce (PlatformContext existuje — `context/platform.tsx` — ale používá se jen částečně).
7. **Instrumentace jako významné procento kódu:** `recordSendWorkflowTrace`, `recordPerfLog`, `startup-request-audit` (obaluje každý fetch), `bootstrap-diagnostics`, `log_ui_event` — stopy po dlouhém debugování timing problémů.
8. **`lib/veslo-server/types.ts` (1 992 ř.)** ručních typů bez generování z API schématu — každá změna serveru = ruční synchronizace.

## Duplicity a mrtvý kód

### Duplicitní kanály (stejná funkce, 2-3 cesty)

| Funkce | IPC cesta | HTTP cesta | Poznámka |
|---|---|---|---|
| Skills CRUD | `list/read/write/uninstall_local_skill*` (12 příkazů) | server `skills.*` doména + registry `/v1/skills` + hub | arbitruje `extensions.ts` |
| OpenCode commands | `opencode_command_list/write/delete` | server `commands.*` | obojí živé |
| opencode.jsonc | `read/write_opencode_config` | server `getConfig`/`patchConfig` | obojí živé |
| Sessions listing | (`opencode_db_read_sessions` — mrtvé) | server Read API **+** SDK `session.list` fallback | 2 živé + 1 mrtvá cesta |
| Transkript | (`opencode_db_read_transcript` — mrtvé) | server `getTranscript` + `recoverTranscript` | |
| Scheduled jobs | `scheduler_list_jobs/delete_job` — **mrtvé** | server `listScheduledJobs` — **taky nevyužité** | nahrazeno `automations.*` |
| OpenCodeRouter | `opencodeRouter_*` (lifecycle IPC) | server `messaging-identities` doména + přímý fetch na healthPort | 3 kanály k jednomu procesu |
| Workspace aktivace | `workspace_set_active` + `runtime_prepare_workspace` + `orchestrator_workspace_activate` | server `workspace.activate` | 4 operace pro jeden koncept |
| SSE | Rust bridge (IPC) | SDK `event.subscribe` | duální transport + 2 duplikovaní konzumenti (global vs. session) |

### Mrtvý kód (ověřeno grep-em mimo testy)

- **`lib/db-reader.ts` celý (123 ř.)** — `readSessionsFromDb`/`readTranscriptFromDb` nevolá nikdo mimo unit testy; na to navázané Rust příkazy `opencode_db_read_sessions/transcript` (+ `commands/session_reader.rs`) drží mrtvou cestu naživu.
- **`lib/tauri.ts`:** `getOpenCodeRouterStatusDetailed` (ř. 1235), `orchestratorStartDetached` (ř. 814), `schedulerListJobs`/`schedulerDeleteJob` (ř. 1183-1189) — bez volajících.
- **Rust:** `opencodeRouter_config_set` registrován (`lib.rs:343`), z UI nikdy nevolán.
- Server klient: `listScheduledJobs`/`deleteScheduledJob` exponované na `client.ts:645-646`, bez volajících.

## Co by znamenalo oddělení BE/FE (web model: API + SPA)

**Dobrá zpráva:** architektura na to už z poloviny je. Web režim existuje (`server.tsx:70-87` forceProxy, SDK SSE fallback, `resolveFetch()` větve) a datová rovina jde přes HTTP. veslo-server už má REST API pokrývající většinu domén.

**Co by muselo přejít z IPC do API (dnes jen v Rustu):**
1. Workspace registry (13 příkazů) — dnes stav v Tauri; server má jen částečné `/workspaces`.
2. Engine/orchestrátor lifecycle (12 příkazů) — start/stop/status enginů.
3. SSE bridge — na webu už dnes funguje SDK cestou; sjednotit na jeden serverový SSE endpoint s kurzorem.
4. Pending drafts (4), AI access proof cache (3), Den auth snapshot (2) — přesun do server storage nebo localStorage.
5. Lokální skills FS operace (12) — server skills doména už většinu umí, dorovnat zbytek.
6. opencode.jsonc + commands — server `getConfig/patchConfig` a `commands.*` už existují; smazat IPC větev.

**Co v čistém web modelu zanikne nebo se změní:** nativní dialogy (nahradit HTML5/server-side picker), clipboard file paths, Obsidian integrace, updater, window management, WSL repair, deep-link auth (nahradit standardním web OAuth redirectem — Den flow `/v2/desktop-auth/*` už je PKCE, změna malá).

**Odhad:** ~55 z 88 IPC příkazů má už dnes HTTP ekvivalent nebo je snadno přenositelných; ~20 je čistě desktopová kosmetika; ~13 (engine/orchestrátor/registry) vyžaduje reálnou práci na serveru. Frontend by se zmenšil o `lib/tauri.ts`, `engine-sse.ts`, polovinu `veslo-server-connection.ts` a 250 runtime větví.

## Náměty na zjednodušení

1. **Jeden API povrch:** prohlásit veslo-server REST za jediný kanál pro data i řízení; IPC zredukovat na <15 příkazů (okno, dialogy, updater, spawn sidecarů). Odstraní to celé třídy duplicit (skills, commands, config, router) a většinu `isTauriRuntime()` větví. Náročnost: vysoká (týdny), dopad: zásadní.
2. **Generovat klienta z OpenAPI:** nahradit 6 517 řádků ručního klienta + 1 992 řádků ručních typů generovaným kódem. Náročnost: střední, dopad: velký (konec driftu FE↔BE).
3. **Smazat mrtvý kód hned:** db-reader.ts + 2 Rust příkazy + session_reader.rs, scheduler IPC+HTTP, `orchestratorStartDetached`, `getOpenCodeRouterStatusDetailed`, `opencodeRouter_config_set`. Náročnost: nízká (hodiny).
4. **Jeden SSE konzument:** sloučit logiku global-sdk + session-event-stream do jedné knihovny s jednotným transportem; ideálně server-side SSE s Last-Event-ID podporou, čímž zmizí „eventual-reconciliation" catch-up. Náročnost: střední-vysoká.
5. **Přesunout `applyGatewayProviderRouting` na server:** generování provider konfigurace nemá být ve frontendu — server má tokeny i fingerprint. Zmizí i scrubbing tajemství v UI. Náročnost: střední.
6. **Anti-corruption vrstva nad SDK typy:** vlastní `VesloMessage/VesloPart` mapované na hranici, komponenty bez importů z `@opencode-ai/sdk`. Sníží náklad výměny enginu z „třetina aplikace" na „jedna mapovací vrstva". Náročnost: střední.
7. **Zredukovat trace instrumentaci** (send-workflow-trace, startup-request-audit, perf-log) na vypínatelný modul — dnes prorůstá byznys logikou.

## Rizika

- **Bootstrap řetěz IPC→HTTP:** bez `veslo_server_info` se HTTP klient nenaváže; jakákoli změna v pořadí startu sidecarů rozbije celé UI (historicky hlavní zdroj „rozbíjení").
- **Tři zdroje pravdy pro workspace** (Tauri registry, orchestrátor, veslo-server) se synchronizují best-effort — chybové kódy typu `workspace_registry_unsynced` (`transport.ts:397`) dokládají, že drift je běžný provozní stav.
- **SSE bez kurzorového plotu** — po reconnectu hrozí ztráta zpráv; kód to řeší „eventual reconciliation", tj. spoléhá na pozdější refresh.
- **Pinned SDK 1.17.13 + interní importní cesta `/v2/client`** — upgrade OpenCode může rozbít typy v ~40 souborech najednou.
- **Ruční typy serveru (1 992 ř.)** — tichý drift mezi FE a BE; validace je jen bodová (skill registry má runtime validaci, zbytek ne).
- **Timeouty natvrdo na ~25 místech** (60 s engine, 3 s health, 90 s MCP auth, …) — ladění závodů mezi cold-startem enginu a UI; každá změna výkonu enginu znamená ruční přeladění.
- **Secrets ve frontendu:** UI drží a přepisuje `clientToken`, `hostToken`, OpenCode basic auth heslo a skládá je do konfiguračních souborů — širší útočná plocha a složitá redakce (viz scrubbing v `opencode.ts` a `transport.ts:148-182`).
