# Analýza: `packages/desktop` — Tauri shell (Rust + TS)

## Účel a rozsah

`packages/desktop` je desktopová „skořápka" Vesla: Tauri 2 aplikace, která vytváří okno s webview (SolidJS UI z `packages/app`), spouští a hlídá **čtyři sidecar procesy** (OpenCode engine `veslo-code`, `veslo-server`, `veslo-orchestrator`, `veslo-code-router`) plus vendorovaný `chrome-devtools-mcp` a bundlovaný Node runtime, provisionuje workspace adresáře (`.opencode/…`), řeší updater, deep-linky a odesílá telemetrii.

Rozsah:
- **Rust**: 50 souborů, **~29 200 řádků** (`src-tauri/src/`), z toho odhadem čtvrtina inline testy (`mod tests`).
- **JS/TS skripty**: ~3 700 řádků (`scripts/`), dominuje `prepare-sidecar.mjs` (1 414 ř.) a `tauri-dev.mjs` (580 ř.).
- **Konfigurace**: `tauri.conf.json` + **7 variantních conf souborů** (dev, e2e, staging, windows, windows.release, windows.staging, macos.aarch64/x64.release), `capabilities/default.json`, `build.rs` (644 ř. — vlastní build logika).
- **IPC povrch**: ~**85 registrovaných `tauri::command`** (`src-tauri/src/lib.rs:309-413`).

## Architektura a klíčové soubory

### Vstupní body
- `src-tauri/src/main.rs` — 5 řádků, volá `veslo::run()`.
- `src-tauri/src/lib.rs` (448 ř.) — sestavení Tauri builderu: pluginy (single-instance, deep-link, dialog, http, opener, process, shell, updater, v e2e režimu `tauri-plugin-pilot`), registrace ~85 příkazů, správa 6 stavových managerů (`EngineManager`, `OrchestratorManager`, `VesloServerManager`, `OpenCodeRouterManager`, `WorkspaceWatchState`, `EngineSseRegistry`), background vlákno `spawn_engine_event_poller`, dev-only autostart orchestrátoru, cleanup při exitu (`stop_managed_services`, `lib.rs:122-170`) a dev-only zabíjení osiřelých sidecarů přes `pgrep` (`lib.rs:194-238`).

### Správa sidecar procesů — 4× opakovaný vzor manager/spawn
Každý sidecar má vlastní modul se stejným vzorem (`inner: Mutex<State>`, `child`, `child_exited`, `last_stdout/last_stderr`, `stop_locked`):
- `engine/` (manager 78, spawn 179, doctor 270, paths 132) — přímé spuštění OpenCode („legacy" runtime, viz níže).
- `orchestrator/` (mod 846, manager) — spouští `veslo-orchestrator` daemon; čte/píše jeho `auth.json`/`state.json` na disku, HTTP health přes `ureq`.
- `veslo_server/` (**mod 2 651**, spawn 1 218, manager 283) — nejsložitější část: perzistence stavu (`state.json`, plugin-state, runtime descriptor, secrets file), „health identity" ověřování (instance id/token přes `/health`), **klasifikace a zabíjení stale procesů** (čtení metadat procesu přes `ps`/`lsof`/`taskkill`, heuristiky na jméno binárky a cwd, `veslo_server/mod.rs:733-975`), resolvování WSL bridge hostu přes PowerShell, publikace mDNS/LAN/engine URL, parsování „ready signal" z stdout dítěte.
- `opencode_router/` (mod, manager 74, spawn 81) — messaging konektor.

Sdílená infrastruktura: `supervised_process.rs` (359 ř. — obal nad tauri-plugin-shell sidecar/nativním spawnem, na Windows vlastní `spawn_hidden_command` s `shared_child` a rourami), `process_supervisor.rs` (149 ř. — generické `resolve_running_pid`/`kill_running_child`/output kolektory). Tj. **existuje generická vrstva, ale 4 moduly ji obalují vlastním, navzájem podobným kódem**.

### Dvě paralelní „runtime" cesty pro engine
`commands/engine.rs` (1 970 ř.) obsahuje `engine_start` → `engine_start_reserved` (**~700řádková funkce**, `engine.rs:974+`), která podle `EngineRuntime` buď:
1. spustí `veslo-orchestrator` daemon (výchozí; opakované pokusy, timeout 180 s, čtení health, registrace workspace), nebo
2. spustí OpenCode přímo (legacy cesta).
K tomu `engine_info` (přes 200 ř.) skládá stav z orchestrator health + persistovaného stavu + přímých probe. Mapování stavů „public engine state" → „runtime engine state" existuje ve 3 variantách funkcí (`engine.rs:166-207`).

### Workspace vrstva
- `workspace/state.rs` (899 ř.) — vlastní registr workspace (veslo-state JSON v app data dir), stabilní ID odvozená hashem cesty/URL, mapování na server-side workspace ID.
- `workspace/files.rs` (1 177 ř.) — **seeding** workspace: `veslo.md`/`plan.md` agenti, commands, chrome-devtools MCP konfigurace do `opencode.json`, Soul šablony; plus rozsáhlé **legacy migrace** (odstranění scheduler pluginu, workspace-guide/get-started skillů, přepis starých chrome-mcp příkazů).
- `workspace/internal_provision.rs` (1 243 ř.) — viz Duplicity.
- `workspace/server_client.rs` (808 ř.) — HTTP klient (ureq) na `veslo-server`: registrace/rename/mazání workspace, rekonsiliace.
- `workspace/watch.rs` (174 ř.) — `notify` watcher na `.opencode` konfigurační soubory, emituje `veslo://reload-required`.
- `commands/workspace.rs` (1 803 ř.) — bootstrap, create/forget/rename, export/import konfigurace do ZIP s redakcí tajemství, autorizace složek, **mazání sessions příslušných workspace jednak přes OpenCode HTTP API, jednak fallbackem přímým SQL** (`try_cleanup_sessions_via_sqlite`, `workspace.rs:170`).

### Ostatní příkazové moduly
- `commands/engine_sse.rs` (768 ř.) — **SSE proxy v Rustu**: `reqwest` stream na engine `/event`, parsování SSE rámců po bajtech, re-emit jako Tauri event `veslo://engine-sse-event`. Existuje kvůli VSLO-86 — dlouhé SSE spojení přes `tauri-plugin-http` blokovalo paralelní krátké požadavky v IPC kanálu (komentář v `Cargo.toml:37-39`).
- `commands/pending_session_drafts.rs` (1 337 ř.) — souborové úložiště rozepsaných zpráv včetně příloh (bytes přes IPC).
- `commands/skills.rs` (1 227 ř.) — CRUD skillů na disku (lokální/globální/scoped roots, šablony).
- `commands/misc.rs` (1 077 ř.) — mix: reset stavu, cache reset, Obsidian integrace (mirror soubory), build info, **`opencode_db_migrate`/`opencode_mcp_auth`** (subprocess `opencode db migrate` / `opencode mcp auth`), **`opencode_db_update_session_directory`** — přímý SQL přepis `session.directory` + JSON blobů `message.data`/`part.data` v `opencode.db` (`misc.rs:1000+`).
- `commands/session_reader.rs` (402 ř.) — přímé čtení sessions a transkriptů z `opencode.db` přes `rusqlite`.
- `commands/scheduler.rs`, `command_files.rs`, `config.rs`, `access_proofs.rs`, `den_auth.rs` (704 ř. — snapshot Den auth na disk), `clipboard.rs` (macOS NSPasteboard přes objc2), `wsl_sandbox.rs` (Windows WSL repair skripty), `window.rs`, `updater.rs` + `src/updater.rs` (řízené vypnutí sidecarů před instalací updatu, macOS relaunch).
- `debug_logs_forwarder.rs` (**1 566 ř.**) — spool logů sidecarů na disk (50 MB retence), redakce (tokeny, domácí cesty, URL query), dávkový upload na **Den cloud `{den_api_base}/debug-logs`** (jen s opt-in `cloudUploadEnabled`), bootstrap diagnostika.
- `error_monitoring.rs` — Sentry SDK → GlitchTip (DSN z build env).

### Build pipeline — tři vrstvy téže starosti
1. `scripts/prepare-sidecar.mjs` (1 414 ř.) — stáhne OpenCode binárku z GitHubu (`anomalyco/opencode`, verze pinovaná v `package.json` → `opencodeVersion: 1.17.13`), zbuilduje 3 bun-compile binárky (server, orchestrator, router), vendoruje `chrome-devtools-mcp` npm balíček, stáhne a ověří Node runtime, vygeneruje `opencode-managed-deps.json` (celé npm balíčky **base64-embedded v JSON**) a `versions.json` se sha256.
2. `src-tauri/build.rs` (644 ř.) — druhá vrstva: při cargo buildu znovu ověřuje/kopíruje/stubuje tytéž sidecary (debug stuby, hledání v PATH).
3. `scripts/tauri-dev.mjs` (580 ř.) + `tauri-before-dev.mjs` + `cleanup-dev-processes.mjs` — třetí vrstva pro dev režim (spouští veslo-server přes `bun --watch` mimo Rust, předává `VESLO_DEV_SERVER_URL`, zabíjí staré procesy).

Kuriozita: `tauri.conf.json` deklaruje `versions.json` a `opencode-managed-deps.json` jako `externalBin` (`tauri.conf.json:67-76`) — JSON soubory vydávané za binárky, aby je Tauri bundlovalo per-target (proto na disku vznikají soubory `versions.json-aarch64-apple-darwin` apod.).

## Komunikační vazby

| Kanál | Protistrana | Popis |
|---|---|---|
| Tauri IPC (invoke) | UI (`packages/app`) | ~85 příkazů; UI volá dalších 83 z nich (viz Duplicity — 1 neregistrovaný nikde volaný). Lifecycle, fs, skills, workspace, drafty, dialogy. |
| Tauri events (emit) | UI | `veslo://engine-event` (poller nad orchestrator health, `commands/orchestrator.rs:502`), `veslo://engine-sse-event` (SSE proxy), `veslo://reload-required` (fs watch), `deep-link://new-url`, stav veslo-serveru. |
| HTTP (ureq, z Rustu) | veslo-server, orchestrator, OpenCode | health checks, registrace workspace, dispose instancí, cleanup sessions. Timeouty 1,2–3 s. |
| HTTP stream (reqwest) | OpenCode engine `/event` | SSE subscribe s Basic auth, proxy do Tauri eventů. |
| HTTP (z UI, tauri-plugin-http) | veslo-server, engine, cloud | `capabilities/default.json` povoluje **`http://*` a `https://*` bez omezení** — UI mluví s lokálními servery i cloudem přímo. |
| Soubory | sidecary, další spuštění app | `state.json`, plugin-state (baseUrl+clientToken pro OpenCode plugin), runtime descriptor, secrets file, orchestrator `auth.json`/`state.json`, spool logů, pending drafts, obsidian-mirror, veslo-state (workspace registr). |
| SQLite (rusqlite) | `opencode.db` OpenCode enginu | čtení sessions/transkriptů, přepis `session.directory` a JSON blobů zpráv, mazání sessions. |
| stdout/stdin | sidecary | parsování „ready signal" řádku z veslo-server stdout (`veslo_server/mod.rs:533-604`); sběr stdout/stderr do bufferů + spool. |
| Procesy (ps, pgrep, kill, taskkill, lsof, PowerShell) | OS | zabíjení orphanů, klasifikace stale procesů, WSL bridge host. |
| HTTPS cloud | Den API, GlitchTip, GitHub | debug-logs upload, Sentry telemetrie, updater (`veslo-updates` releases), stahování OpenCode/Bun/Node při buildu. |

## Vazba na OpenCode

Velmi těsná, na několika úrovních:
1. **Binárka**: stahovaná z forku `anomalyco/opencode`, pin `opencodeVersion: 1.17.13` v `package.json:5`; přejmenovaná na `veslo-code` + **symlink `opencode`**, protože engine se sám ověřuje přes `which opencode` (`prepare-sidecar.mjs:1050-1052`).
2. **Verzovací zámky na 3 místech**: `package.json` (`opencodeVersion`), `orchestrator/mod.rs:21` (`EXPECTED_OPENCODE_PLUGIN_VERSION: "1.17.13"`), manifest `opencode-managed-deps.json` (`@opencode-ai/plugin` musí přesně sedět s verzí OpenCode, `prepare-sidecar.mjs:686-691`). Ruční synchronizace při každém upgradu.
3. **Přímý přístup do interní SQLite** `opencode.db` (session_reader.rs, misc.rs, workspace.rs) — závislost na interním schématu (`session`, `message`, `part`, JSON tvary `path.cwd`, `tool.filePaths`). Změna schématu v OpenCode rozbije Veslo bez varování kompilátoru.
4. **CLI subprocess**: `opencode db migrate`, `opencode mcp auth`.
5. **Provisioning `.opencode/`**: agents (`veslo.md`, `plan.md`), plugins, commands, skills, `opencode.json` — Rust zapisuje soubory, jejichž sémantiku definuje OpenCode.
6. **Auth a serve parametry**: engine_start generuje Basic auth (uživatel `opencode`), porty, bind hosty.

**Výměna enginu** by znamenala: přepsat sidecar pipeline (download/verify), celý `engine/` + orchestrator spawn protokol (env proměnné, auth soubory), SSE proxy formát, veškerý provisioning `.opencode/`, SQLite čtečky a přepisovače, managed-deps manifest a symlink hack. V tomto balíčku je to řádově 8–10 tisíc řádků dotčeného Rustu + celý build tooling. Fakticky vše kromě okna, updateru a obecného process supervisoru je tvarované OpenCode.

## Hotspoty složitosti

| Místo | Problém | Závažnost |
|---|---|---|
| `src-tauri/src/veslo_server/mod.rs` (2 651 ř.) | Recovery/attach heuristiky: health identity, klasifikace a zabíjení stale procesů podle jména/cwd, WSL bridge resolvování přes PowerShell, mDNS/LAN URL, ready-signal parsing. Obrovská plocha pro rozbití, testy simulují OS chování. | kritická |
| `src-tauri/src/commands/engine.rs:974` (`engine_start_reserved`, ~700 ř.) | Jedna funkce míchá: tvorbu adresáře, zápis configu, volbu runtime, retry smyčku orchestrátoru, forwardování logů, fallback na přímé spuštění, sestavení výsledného stavu. | vysoká |
| Dvojí provisioning `internal_provision.rs` ↔ `packages/server/src/internal-system.ts` | Každá změna 2×, drift jistý (TS verze už dělá víc — workspace instructions). | vysoká |
| Přímé SQL zápisy do `opencode.db` (`commands/misc.rs`, `commands/workspace.rs:170`) | Přepis JSON blobů zpráv regulárním nahrazováním cest; závislost na interním schématu enginu. | kritická |
| Trojitá sidecar pipeline (`prepare-sidecar.mjs` + `build.rs` + `tauri-dev.mjs`) | Tři místa, která ověřují/kopírují/stubují tytéž binárky, každé s vlastními edge-casy (Windows baseline Bun, Authenticode hash, symlinky). | vysoká |
| `debug_logs_forwarder.rs` (1 566 ř.) | Vlastní spool/retence/redakce/dávkování — plnohodnotný telemetrický subsystém uvnitř shellu. | střední |
| 4× vzor manager/spawn (engine, orchestrator, veslo_server, opencode_router) | Stejný kód s drobnými odchylkami; `process_supervisor.rs` existuje, ale nevyužívá se důsledně. | střední |
| ~85 IPC příkazů v `lib.rs` | Plochý seznam bez vrstvení; UI↔Rust kontrakt jen konvencí (žádné generované typy). | střední |
| `commands/engine_sse.rs` | Ruční SSE parser po bajtech v Rustu jen kvůli limitaci Tauri http pluginu. | střední |
| Windows/WSL větve (`wsl_sandbox.rs`, PowerShell bridge, `spawn_hidden_command`) | Platformní speciality prorostlé do obecného kódu. | střední |

## Duplicity a mrtvý kód

1. **`workspace/internal_provision.rs` (1 243 ř.) ↔ `packages/server/src/internal-system.ts` (1 243 ř.)** — potvrzený duplikát: stejná verze `2026-06-06.1`, stejné markery `VESLO_AGENT_INSTRUCTIONS_*`/`VESLO_INTERNAL_ROUTING_*`, stejný managed block, **identický ~400řádkový JS „automations plugin" embedovaný jako string v obou jazycích**. TS verze navíc obsahuje logiku, kterou Rust nemá (workspace instructions, interní agent dokumenty) — drift už nastal.
2. **Mrtvý automations plugin**: `automations_plugin_enabled()` vrací natvrdo `false` v Rustu (`internal_provision.rs:198-207`) i TS (`internal-system.ts:515-517`). Embedded zdroják pluginu (2× ~400 ř.) se nikdy nezapíše — provisioning ho naopak aktivně přesouvá do karantény. Čistě mrtvá zátěž + testy nad ní.
3. **`provision_central_packs`** (`internal_provision.rs:667`) — compatibility wrapper, jehož výsledek je dle vlastního komentáře ignorován.
4. **Legacy-cleanup kód jako velká část provisioning plochy**: odstranění `veslo-delegate.js`, interních agentů, interních packů, `workspace-guide`/`get-started` skillů, scheduler pluginu, migrace chrome-mcp příkazů — duplikováno v `workspace/files.rs` i `internal-system.ts`. Slouží jen instalacím z minulých verzí.
5. **Duplicitní test soubory v rootu balíčku**: `windows-hidden-sidecar-contract.test.mjs` a `owned-server-defaults.test.mjs` existují v rootu i v `tests/` — liší se jen relativními cestami (ověřeno diffem).
6. **`opencodeRouter_config_set`** — registrovaný IPC příkaz (`lib.rs:343`), který žádný kód v repu nevolá.
7. Zakomentované zbytky: `engine_sse.rs:580` (`register`), `veslo_server/mod.rs:436` (`resolve_connect_url`).
8. `build.rs` `ensure_*` funkce vs. `prepare-sidecar.mjs` — dvojí zajištění týchž artefaktů.
9. Tři varianty mapování stavů enginu v `commands/engine.rs:166-207`.

## Co by znamenalo oddělení BE/FE (API + SPA)

Dobrá zpráva: **UI už dnes z velké části funguje „webově"** — `capabilities/default.json` povoluje neomezené HTTP, takže data (sessions, zprávy, workspaces na serveru) tečou přímo přes HTTP na `veslo-server` a engine. Tauri IPC se používá pro tři kategorie:

1. **Přenositelné na server (většina z ~85 příkazů)** — čistá souborová/doménová logika bez potřeby nativního shellu: skills CRUD, workspace registr + bootstrap, provisioning, pending drafts, scheduler, command_files, config čtení/zápis, session_reader (čtení `opencode.db`), obsidian mirror, access proofs, den-auth snapshot. Tyto by se staly endpointy veslo-serveru a IPC vrstva by zmizela.
2. **SSE proxy (`engine_sse_*`)** — v prohlížeči/SPA zbytečná, nativní `EventSource` ji nahradí; existuje jen kvůli limitaci Tauri http pluginu.
3. **Nutně nativní (malé jádro)** — spawn/supervize procesů, updater, okno/dekorace, clipboard (NSPasteboard), nativní dialogy, deep-linky, WSL repair. To je řádově 3–5 tisíc řádků, zbytek (~25 tisíc) je logika, která do desktop shellu věcně nepatří.

Riziková místa přechodu: workspace registr je dnes **dvojmo** (veslo-state v app data dir + registr ve veslo-serveru, synchronizované přes `server_client.rs` s rekonsiliací) — při oddělení musí zůstat jediný zdroj pravdy (server). Dále „výběr složky" a oprávnění k souborům jsou dnes nativní dialogy — SPA by potřebovala server-side ekvivalent. A lifecycle sidecarů by převzal jeden supervisor proces (dnes rozprostřeno mezi Rust, tauri-dev.mjs a orchestrátor).

## Náměty na zjednodušení

1. **Zrušit duální provisioning** — jediná implementace (logicky v serveru/TS, kde už je bohatší); Rust jen zavolá server endpoint po startu. Ušetří ~1 200 ř. Rustu + trvalou daň „každá změna 2×". Náročnost: střední.
2. **Smazat mrtvý automations plugin** (2× ~400 ř. + testy) a po odeznění migrací i legacy-cleanup kód. Náročnost: nízká.
3. **Sloučit 4 manager/spawn moduly** nad `process_supervisor.rs` do jednoho generického supervisoru s deklarativní tabulkou sidecarů. Náročnost: střední, zisk ~2–3 tis. ř.
4. **Přesunout fs-backed IPC příkazy do veslo-server API** (skills, drafts, scheduler, config, session čtení) — UI pak komunikuje jednotně HTTP, IPC povrch klesne z ~85 na ~15 příkazů. Náročnost: vysoká, ale je to přesně krok k variantě „API + SPA".
5. **Odstranit přímé SQL do `opencode.db`** — nahradit OpenCode HTTP API (cleanup přes HTTP už existuje jako preferovaná cesta ve `workspace.rs:99`), případně server endpointem. Náročnost: střední; odstraní nejkřehčí vazbu na engine.
6. **Sjednotit sidecar pipeline** — jedno místo pravdy (prepare-sidecar), `build.rs` zredukovat na stub-check, dev režim ať používá tentýž mechanismus. Náročnost: střední.
7. **Přehodnotit recovery heuristiky veslo-serveru** — nahradit klasifikaci procesů podle jmen/cwd jednodušším mechanismem (lock file + instance id v health, který už existuje). Náročnost: střední, výrazně sníží nejrizikovější kód.
8. **Zrušit SSE proxy** ve prospěch přímého `EventSource` z webview (ověřit, zda současné Tauri http omezení stále platí; při BE/FE oddělení odpadá automaticky). Náročnost: nízká–střední.
9. Drobnosti: smazat duplicitní test soubory v rootu, neregistrovaný `opencodeRouter_config_set`, zakomentovaný kód; zredukovat 7 conf variant generováním.

## Rizika

- **Upgrade OpenCode = ruční synchronizace 3 verzovacích míst** + riziko tichého rozbití SQL přepisů při změně schématu `opencode.db`.
- **Heuristické zabíjení procesů** (`kill_orphan_sidecars` přes pgrep pattern, `terminate_stale_veslo_server_process` podle jména/cwd) může za nešťastných okolností zabít cizí proces; zároveň je to hlavní obrana proti „stále se něco rozbíjí" (stale porty) — odstranit lze až s náhradou.
- **Tokeny na disku**: client/host tokeny ve `state.json`/plugin-state (0600 jen na Unixu), orchestrator Basic auth v `auth.json`.
- **Webview bez CSP** (`"csp": null`) + neomezené `http://*`/`https://*` pro UI.
- **Duální workspace registr** (lokální veslo-state vs. server) — rekonsiliace je best-effort, možnost rozjetí stavů.
- **Telemetrie** — Sentry/GlitchTip + Den debug-logs: redakce je vlastní ruční kód, riziko úniku citlivých cest/tokenů při změnách formátů logů.
- Odchod od Tauri (čistá SPA) znamená znovu vyřešit: nativní výběr složky, updater, deep-linky, clipboard, WSL — dnes „zadarmo" z pluginů.
