# Průřezová analýza: vazba Vesla na OpenCode

Datum: 2026-07-19 · Rozsah: celé monorepo (kořen repozitáře)

---

## 1. Účel a rozsah

Cílem bylo přesně určit, **jakou formou je OpenCode v projektu** (npm závislost / fork / vendorovaný kód / sidecar binárka), jaké OpenCode API se konzumuje, a odhadnout cenu (a) držení kroku s upstreamem a (b) úplné výměny enginu (např. za Claude Agent SDK nebo Codex).

**Hlavní zjištění v jedné větě:** OpenCode je v projektu **čtyřmi paralelními formami najednou** — (1) prebuilt binárka stahovaná z GitHub releases upstreamu, (2) npm SDK klient, (3) generovaný plugin kód vstřikovaný do workspace, (4) **přímé čtení i zápis interní SQLite databáze enginu** — a právě kombinace všech čtyř vrstev (nikoli jedna z nich) je zdrojem extrémní křehkosti.

---

## 2. Architektura a klíčové soubory

### 2.1 Forma integrace: binárka z upstreamu, žádný fork kódu

- **Není to fork ani vendorovaný zdroják.** V repu není žádná kopie zdrojáků OpenCode; `patches/` obsahuje jen patch na `@solidjs/router` (`patches/@solidjs__router@0.15.4.patch`).
- **`veslo-code` = přejmenovaná upstream binárka OpenCode.** Skript `packages/desktop/scripts/prepare-sidecar.mjs` stahuje release asset (`opencode-darwin-arm64.zip` apod.) z GitHub repa **`anomalyco/opencode`** (řádek 61–74, override přes `OPENCODE_GITHUB_REPO`), extrahuje binárku `opencode` a uloží ji jako `veslo-code` (řádky 935–1048). Podle dokumentace (`docs/plans/2026-06-20-offline-first-wsl-runtime-distribution.md:116`) je `anomalyco/opencode` chápáno jako upstream OpenCode engine repo.
- **Symlink hack:** vedle `veslo-code` se vytváří symlink `opencode`, protože engine sám sebe verifikuje přes `which opencode` (`prepare-sidecar.mjs:1050–1074`).
- **Pinovaná verze `1.17.13`** je zapsaná na **4 místech**, která musí zůstat synchronní:
  - `packages/desktop/package.json:5` (`opencodeVersion`)
  - `packages/orchestrator/package.json:4` (`opencodeVersion`) + `:52–53` (`@opencode-ai/plugin`, `@opencode-ai/sdk`)
  - `packages/app/package.json:61` (`@opencode-ai/sdk`)
  - `packages/opencode-router/package.json:47` (`@opencode-ai/sdk`)
  - navíc `packages/orchestrator/src/opencode-managed-dependencies.ts:7` (`VESLO_MANAGED_PLUGIN_VERSION = "1.17.13"`) — build padá, když nesedí (`prepare-sidecar.mjs:686–691`).
- Bez pinu skript stahuje „latest" z GitHub API (`prepare-sidecar.mjs:94–116`) — tj. build je závislý na síti a na tom, co upstream zrovna vydal.
- Version-mismatch kontrola za běhu: `packages/orchestrator/src/opencode-version.ts` (hard fail při bundled/downloaded mismatchi).

### 2.2 Kdo engine spouští a řídí

- **Orchestrátor** (`packages/orchestrator/src/cli.ts`, **6 934 řádků** — monolit) spouští `veslo-code serve --hostname … --port … --cors …` (`startOpencode`, cli.ts:2655–2750) s env proměnnými: `OPENCODE_CONFIG_DIR`, `OPENCODE_SERVER_USERNAME/PASSWORD`, `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_CLIENT=veslo-orchestrator`, hot-reload flagy.
- **Runtime injektáž do enginu:** `ensureOpencodeListenerLimitPreload` (cli.ts:2457–2481) generuje CJS preload soubor a vnucuje ho enginu přes `NODE_OPTIONS`/`BUN_OPTIONS`/`BUN_INSPECT_PRELOAD`, aby zvedl `events.defaultMaxListeners` — tedy **zásah do vnitřního chování cizí binárky přes preload**, náhrada forku.
- **Sandbox wrapping:** engine se balí do vlastního sandboxu Vesla (`@anthropic-ai/sandbox-runtime`, macOS sandbox-exec, Windows WSL2) — `packages/orchestrator/src/sandbox-mode.ts`, `cli.ts` (resolveEngineSandbox).
- **Dvě topologie za jednou hranicí:** `engine-pool.ts` (1 058 ř. — pool per-workspace engine procesů, max 8, LRU evikce, health monitor, restart backoff) a `shared-opencode-engine.ts` (289 ř. — jeden sdílený nesandboxovaný proces pro víc workspace). Výběr: `engine-topology.ts`, `opencode-proxy-target.ts`.

### 2.3 SDK vrstva

`@opencode-ai/sdk/v2/client` (OpenAPI-generovaný HTTP klient) importuje:
- **app**: 43 ne-testových souborů (typy `Part`, `Session`, `Message`, `Agent`, `Event`, `QuestionInfo`, `McpLocalConfig`…); klienta vytváří `packages/app/src/app/lib/opencode.ts:167` (`createClient`) a `context/global-sdk.tsx:48`.
- **orchestrátor**: `cli.ts:17` (health-checky engine).
- **opencode-router**: `src/opencode.ts:3` (Telegram/Slack bridge; `session.create`, `session.prompt` — `bridge.ts:2077, 2284`, `event.subscribe`, `permission.reply`).
- **server**: **nemá SDK závislost** (viz `packages/server/package.json` — jen `zod`, `jsonc-parser`…); s enginem mluví surovým `fetch` přes proxy a čte SQLite.

Konzumované SDK/HTTP metody (grep přes app+orchestrator+router+server): `session.create/list/get/messages/prompt(_async)/abort/update/delete/revert/unrevert/shell/command`, `event.subscribe` (SSE), `config.get/providers/command`, `project.list/status`, `provider.list/auth`, `mcp.add/remove/list/status/auth/listHub/installHub/refreshRuntimeToken/logoutAuth`, `permission.list/reply`, `question.list/reply/reject`, `path.get`, `command.list`, `global.health`, `auth.remove`.

### 2.4 Event stream (SSE)

- App konzumuje `/event` SSE a přepíná na ~24+ typů událostí (`message.updated`, `message.part.updated/removed`, `session.created/updated/deleted/status/idle/error/compaction`, `permission.asked/replied`, `question.*`, `todo.updated`, `mcp.tools.changed`, `lsp.updated`, `command.executed`, `opencode.hotreload.applied`…) — `packages/app/src/app/context/session-event-stream.ts` (**1 704 ř.**), `global-sdk.tsx`, `global-sync.tsx`.
- Kvůli Tauri http pluginu (IPC kanál blokovaný dlouhým SSE) existuje **druhá implementace SSE v Rustu**: `packages/desktop/src-tauri/src/commands/engine_sse.rs` (768 ř.) — tokio task + reqwest parsuje SSE a přeposílá eventy do webview přes Tauri event bus (`veslo://engine-sse-event`). JS fallback na SDK subscribe zůstává (`global-sdk.tsx:154–212`).

### 2.5 Přímý přístup k interní SQLite DB enginu (nejhlubší vazba)

- **TypeScript (server):** `packages/server/src/conversation-read-store.ts` otevírá `opencode.db` read-only přes `bun:sqlite` (ř. 1, 314) a dotazuje se přímo na interní tabulky `session`, `message`, `part` včetně parsování JSON sloupce `data` (ř. 414–446). Cesty k DB: `~/.local/share/opencode/opencode.db`, `<workspace>/.opencode/opencode.db`, XDG overridy (ř. 245–285).
- **Rust (desktop):** `packages/desktop/src-tauri/src/commands/session_reader.rs` čte tytéž tabulky (`opencode_db_read_sessions`, `opencode_db_read_transcript`); `commands/misc.rs:1032` (`opencode_db_update_session_directory`) dokonce **zapisuje** — mění sloupec `directory` a přepisuje `path.cwd` uvnitř JSON blobů zpráv; `misc.rs:927` spouští `opencode db migrate` přes CLI binárky.
- Transkripty a seznamy konverzací tedy Veslo z velké části **nečte přes API enginu, ale přímo z jeho nedokumentovaného úložiště** — schema-drift při upgrade OpenCode se detekuje jen heuristicky (`isOpenCodeReadSchemaUnavailableError`, conversation-read-store.ts:317).

### 2.6 Generovaný plugin/agent kód vstřikovaný do workspace (duální TS + Rust)

- `packages/server/src/internal-system.ts` (1 243 ř.) generuje **jako string** zdrojáky OpenCode pluginů `veslo-delegate.js` a `veslo-automations.js` (import `@opencode-ai/plugin`, ř. 521), agent markdowny (`.opencode/agents/veslo.md`), managed bloky v `AGENTS.md` a manifest.
- Totéž **zrcadlí Rust** `packages/desktop/src-tauri/src/workspace/internal_provision.rs` (1 243 ř. — stejný obsah dvakrát, viz CLAUDE.md pravidlo o dual provisioning).
- Orchestrátor navíc **vendoruje npm balíčky do configu enginu**: `opencode-managed-dependencies.ts` (748 ř.) + `prepare-sidecar.mjs` (`opencode-managed-deps.json`, base64 obsah všech souborů 9 balíčků: `@opencode-ai/plugin`, `zod`, `@ai-sdk/*`, …) → rozbalují se do `<configDir>/node_modules`, aby generované pluginy uvnitř enginu měly runtime závislosti bez npm instalace.
- Další generátory pluginů: `cli.ts:1756+` (`opencodeRouterSendToolSource`, `opencodeRouterStatusToolSource`), `packages/server/src/plugin-materializer.ts` (1 184 ř.).

### 2.7 Konfigurační soubor `opencode.json(c)`

- App přímo generuje/patchuje workspace `opencode.jsonc`: `packages/app/src/app/lib/opencode.ts` (`applyGatewayProviderRouting`, ř. 400–561) vpisuje provider routing na AI gateway (baseURL `…/ai-gateway/providers/:id/v1`, hlavičky `x-veslo-session-id`, token template `{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}`), sanitizuje sekrety, porovnává redakce.
- Orchestrátor konfiguraci dál čistí (`opencode-config-sanitizer.ts` — migrace legacy pluginů/MCP příkazů) a synchronizuje workspace config do config diru enginu při každém mutujícím proxy requestu (`syncWorkspaceOpencodeConfigToConfigDir`, cli.ts:5460).

---

## 3. Komunikační vazby (kanály)

Řetěz pro jeden prompt: **UI (SolidJS) → Tauri IPC/HTTP → veslo-server → orchestrátor → OpenCode engine**, se **třemi HTTP proxy vrstvami za sebou**:

| # | Odkud → kam | Kanál | Kde v kódu |
|---|---|---|---|
| 1 | App → veslo-server | HTTP (Tauri http plugin fetch, Bearer/Basic) | `app/lib/opencode.ts` (createTauriFetch), `context/server.tsx` |
| 2 | veslo-server → orchestrátor | HTTP proxy mount `/workspace/:id/opencode/*` a `/w/:id/opencode/*` | `server/src/server.ts:599–626` (parseWorkspaceOpencodeMount), `proxyOpencodeRequest` (:1574) |
| 3 | Orchestrátor → engine | HTTP proxy s injektáží `x-opencode-directory`, `x-veslo-workspace-id`, Basic auth; rewrite `directory` polí v JSON body/response (WSL aliasing) | `orchestrator/src/cli.ts:5486–5593`, `router-proxy.ts` |
| 4 | Engine → App (eventy) | SSE `/event`; v Tauri drženo v Rustu a re-emitováno jako Tauri event `veslo://engine-sse-event` | `engine_sse.rs`, `global-sdk.tsx:147–213` |
| 5 | Server/Rust → engine storage | **Soubor**: přímé čtení/zápis `opencode.db` (SQLite) | `conversation-read-store.ts`, `session_reader.rs`, `misc.rs` |
| 6 | Server/Rust → workspace | **Soubory**: `.opencode/` (agents, plugins, skills, commands, opencode.jsonc), `AGENTS.md` | `internal-system.ts`, `internal_provision.rs`, `skill-materializer.ts` |
| 7 | Orchestrátor → engine (spawn) | Proces + env + preload injektáž + sandbox wrapper | `cli.ts:2655+` |
| 8 | Engine → AI gateway | HTTP (Responses/OpenAI-compatible), hlavičky z patchnutého `opencode.jsonc` | `app/lib/opencode.ts` (routing), `services/ai-gateway` |
| 9 | opencode-router → engine | HTTP SDK (`session.create/prompt`, `event.subscribe`) | `packages/opencode-router/src/bridge.ts` |
| 10 | Rust → engine CLI | Spawn `opencode db migrate`, `opencode mcp auth` | `misc.rs:927`, `misc.rs` (mcp auth) |

Pozn.: v „remote/Docker" režimu app mluví na server same-origin `/opencode` proxy (server.tsx:66–75). Automations runner v serveru volá engine přes `fetchOpencodeJsonWithOrchestratorFallback` (server.ts:1490+) — tedy i interní server logika jde přes proxy vrstvy.

---

## 4. Vazba na OpenCode — shrnutí těsnosti

| Vrstva | Těsnost | Poznámka |
|---|---|---|
| Binárka + verze | Vysoká, ale výměnná | Pin na 5 místech; stahování z GitHubu při buildu |
| SDK typy v UI | Vysoká plošně | 43 souborů app typovaných na `Part`/`Session`/`Event`; 8 part typů renderováno (`part-view.tsx`, `utils/messages.ts`, `utils/tools.ts`) |
| SSE event slovník | Vysoká | ~24 typů událostí, koalescence, reconnect sémantika (session-event-stream.ts 1 704 ř.) |
| REST endpointy | Střední | ~35 metod, ale přes proxy — jde zabalit do adaptéru |
| `.opencode/` filesystem kontrakt | Velmi vysoká | skills (opkg pipeline v serveru), agents, commands, pluginy, config — celý extensibility stack Vesla je postaven na OpenCode modelu |
| SQLite `opencode.db` | **Kritická** | Nedokumentované interní schéma; čte TS i Rust, Rust i zapisuje |
| Runtime hacky | Vysoká | preload listener-limit, `which opencode` symlink, config sync při každém POST, vendorované node_modules |

Interní audit projektu (`docs/plans/2026-06-22-opencode-to-codex-replacement-audit.md`) mapuje totéž v 6 vrstvách a došel k **rozhodnutí (2026-06-22): plný replace OpenCode → forkovaný Codex + managed Responses gateway**. Zajímavé: v binding store už existuje generický šev `engineSessionId` (`conversation-binding-store.ts:13`), tedy příprava na výměnu enginu částečně začala. Stav k dnešku: engine je stále OpenCode 1.17.13, ale AI gateway už má `@openai/codex` dependency (`services/ai-gateway/package.json`) a `codex_oauth` provider je výchozí i pro vývoj repa (`opencode.jsonc` v rootu).

### Cena držení kroku s upstreamem (a)

- Upgrade = zvednout 5 pinů + doufat, že sedí: (1) SQLite schéma (`session/message/part` + JSON blob tvary), (2) SSE event slovník, (3) part typy, (4) `@opencode-ai/plugin` API generovaných pluginů, (5) chování `OPENCODE_*` env proměnných a CLI (`db migrate`, `mcp auth`), (6) tvar `opencode.json` configu. Body 1, 4, 5 jsou **nedokumentované/interní** — každý minor upstream release je riziko.
- Prakticky: každý upgrade vyžaduje plný E2E průchod (send/stream/permission/abort/transcript hydration) na reálném Tauri runtime; kvůli zápisům do DB z Rustu je i „read-only" drift schématu potenciálně destruktivní.
- Odhad: **dny až týdny na minor verzi**, s nemalou pravděpodobností skrytých regresí (přesně to, co uživatel popisuje jako „pořád se něco rozbíjí").

### Cena úplné výměny enginu (b) — např. Claude Agent SDK

Podle vlastního auditu projektu i podle kódu jsou 4 tvrdé problémy:
1. **Transport**: OpenCode = jeden sdílený HTTP server + 1 SSE stream pro N sessions/adresářů; Claude Agent SDK i Codex = proces/stream per konverzace → orchestrátor se mění z „HTTP proxy + pool" na „process manager + event multiplexer". Střední až velká práce, ale orchestrátor už dnes abstrahuje 2 režimy.
2. **Překlad eventů a částí zpráv**: ~24 SSE typů + 8 part typů → nutný translator na hranici serveru, jinak přepis UI (43 souborů). U Claude Agent SDK by se mapovaly `assistant/tool_use/tool_result/thinking` bloky a hook eventy; bez ekvivalentu jsou `revert/unrevert`, `question.*`, `lsp.updated`.
3. **Ekosystém `.opencode/`**: skills (opkg materializer/resolver/lockfiles/hub — tisíce řádků v serveru), markdown commands, agent definice, generované pluginy. U Claude Agent SDK je výhoda: **skills, subagenty, MCP a hooks jsou nativní koncepty** (`.claude/skills`, `.claude/agents`, MCP config, hooks nahradí delegate/automations pluginy) — tj. tenhle bod je pro Claude Agent SDK levnější než pro Codex, ale pořád je to největší balík práce (přemapování celé serverové skills pipeline).
4. **Transkripty**: dnes SQLite `opencode.db`; po výměně by zdrojem byla session storage nového enginu (u Claude Agent SDK JSONL transcripty / session resume) — nutno přepsat `conversation-read-store.ts`, `session_reader.rs` a zrušit zápisové hacky.

Odhad: **měsíce práce (řádově 2–4 člověko-měsíce na paritu jádra: send/stream/abort/resume/permission/transcript; + další na skills/MCP paritu)**, ale s významnou trvalou úsporou: zmizí engine-pool/shared-engine dualita, 3 proxy vrstvy se dají zredukovat, SQLite čtení zmizí, dual TS+Rust provisioning zmizí (Claude Agent SDK nepotřebuje generované JS pluginy pro delegaci — hooks/subagenty). Podstatné: **UI se dá zachovat**, pokud se překlad udělá na hranici veslo-serveru (stejný závěr má interní audit).

---

## 5. Hotspoty složitosti

1. **`packages/orchestrator/src/cli.ts` — 6 934 ř. monolit** (kritická): spawn enginu, sandbox, proxy, run registry, trace, sidecar resolve, health, shutdown — vše v jednom souboru.
2. **Trojitá HTTP proxy** (vysoká): app → server proxy (`server.ts`) → orchestrátor proxy (`cli.ts` + `router-proxy.ts`) → engine; každá vrstva má vlastní auth, timeouty, header stripping, chybové mapování; ladění „Request timed out" prochází třemi vrstvami (viz komentáře VSLO-86 v `app/lib/opencode.ts:22–29`).
3. **Přímé čtení+zápis `opencode.db` ze dvou jazyků** (kritická): `conversation-read-store.ts` (TS), `session_reader.rs` + `misc.rs` (Rust, i zápis JSON blobů).
4. **Dual provisioning TS ↔ Rust** (vysoká): `internal-system.ts` (1 243 ř.) vs. `internal_provision.rs` (1 243 ř.) — každá změna dvakrát, generovaný JS kód jako string v obou jazycích.
5. **Vendorování runtime závislostí do enginu** (vysoká): `opencode-managed-dependencies.ts` + base64 manifest v `prepare-sidecar.mjs` (9 npm balíčků, řešení tranzitivních závislostí ručně).
6. **SSE dvěma cestami** (střední): Rust proxy (`engine_sse.rs`) + JS SDK fallback (`global-sdk.tsx`) + koalescence eventů + session-event-stream.ts (1 704 ř.).
7. **Workaroundy nahrazující fork** (střední): preload na maxListeners, `opencode` symlink, config-sync před každým POST, sanitizer configu.

---

## 6. Duplicity a mrtvý kód

- **Duplicitní provisioning**: `internal-system.ts` ↔ `internal_provision.rs` (viz výše) — deklarovaná, trvalá duplicita.
- **Duplicitní čtení transkriptů**: TS `conversation-read-store.ts` ↔ Rust `session_reader.rs` (stejné SQL nad stejnými tabulkami).
- **Duplicitní SSE klient**: Rust `engine_sse.rs` ↔ JS `eventClient.event.subscribe` fallback.
- **Duplicitní health-wait**: `app/lib/opencode.ts:waitForHealthy` ↔ orchestrátor `waitForHealthyViaProxy` (cli.ts:2501) ↔ engine-pool `waitForHealthy` dep.
- **`packages/opencode-router`** (5 811 ř. + sidecar binárka + Rust manager `opencode_router/`): dle interního auditu „currently UI-disabled but still in the runtime" — celý Telegram/Slack/WhatsApp bridge se builduje, spouští a proxuje (server routes `routes/opencode-router.ts`, 1 567 ř.), ale UI ho nevystavuje. Kandidát na vyhození č. 1.
- **`packages/server/src/toy-ui.ts`** (1 812 ř.) — debug UI serveru, duplikuje app flows (session create, prompt_async, event stream).
- **Legacy vrstvy**: `LEGACY_INTERNAL_PACKS`/`LEGACY_INTERNAL_AGENT_FILES` cleanup kód (internal-system.ts:25–37), `opencode-config-sanitizer.ts` (migrace historických configů), `opencodeSessionId` jako alias k `engineSessionId`.
- **`codex_oauth`/`openai_compatible` provider plumbing** v `app/lib/opencode.ts` (CODEX_OAUTH_MODEL_VARIANTS…) — model-provider vrstva, kterou plánovaný runtime-swap dle auditu „mostly replaced/retired".

---

## 7. Co by znamenalo oddělení BE/FE (API + SPA)

- **Polovina práce už je hotová**: app mluví s veslo-serverem a enginem výhradně přes HTTP/SSE; existuje „remote" režim (Docker), kde SPA běží proti same-origin `/opencode` proxy (server.tsx:66–75, `resolveServerProviderInitialState`). Server má workspace-scoped API kontrakt (`docs/dev/opencode-workspace-runtime-architecture.md`, řádky 152–159).
- **Co oddělení blokuje** (Tauri-only cesty, které obcházejí API):
  1. Rust čtení/zápis `opencode.db` (`session_reader.rs`, `misc.rs`) — musely by se přesunout do veslo-serveru (TS varianta už existuje!).
  2. Rust SSE proxy (`engine_sse.rs`) — v prohlížeči nahradí nativní `EventSource`/fetch stream (problém řešil jen Tauri IPC).
  3. Rust provisioning workspace (`internal_provision.rs`) — server TS verze existuje; sjednotit na server.
  4. Tauri commands pro skills/opkg/MCP auth/config (`commands/skills.rs`, `opkg.rs`, `config.rs`) tam, kde duplikují server routes.
- **Vazba enginu na lokální FS zůstává**: engine musí běžet tam, kde jsou složky uživatele — BE (veslo-server + orchestrátor + engine) by běžel lokálně jako jeden démon, SPA by byla čistý HTTP/SSE klient. Tauri by se smrsklo na tenký shell (okno + spuštění démona + folder picker), nebo úplně zmizelo.
- Vlastní pravidla projektu tomu jdou naproti: „Any capability that mutates `.opencode/` should stay expressible via the Veslo server API" (`AGENTS.md`, `packages/server/AGENTS.md`).

---

## 8. Náměty na zjednodušení

1. **Zrušit přímý přístup k `opencode.db` z Rustu** a nechat jediné čtecí místo v serveru (a ideálně přejít na API enginu `session.messages`) — odstraní nejkřehčí vazbu; malá/střední náročnost, obrovský přínos pro upgrady.
2. **Sloučit proxy vrstvy**: nechat jednu (veslo-server), orchestrátor degradovat na čistý process-manager bez vlastního HTTP routeru — střední náročnost, odstraní celou třídu timeout/auth bugů.
3. **Vyhodit `opencode-router`** (balíček, sidecar, Rust manager, server routes, generované router pluginy) dokud není v UI — nízká náročnost, −8 až 10 tis. řádků a jedna binárka.
4. **Zrušit dual provisioning**: provisioning jen v serveru (TS), Rust jen volá server — nízká/střední náročnost.
5. **Rozbít `cli.ts` (6 934 ř.)** podle už existujících modulů — střední náročnost, hlavně pro AI-asistovaný vývoj (dnes se do kontextu nevejde).
6. **Vyhodit `toy-ui.ts`** a duplicitní health/wait implementace — nízká náročnost.
7. **Při rozhodnutí o výměně enginu**: zavést nejdřív explicitní `engineKind` adaptér na hranici serveru (šev `engineSessionId` už existuje) a překlad eventů/parts do vlastního Veslo slovníku — tím se UI odpoutá od `@opencode-ai/sdk` typů ještě před výměnou enginu.

---

## 9. Rizika

1. **Schema drift `opencode.db`**: upstream může kdykoli změnit interní schéma; Rust zápis (`opencode_db_update_session_directory`) může poškodit data enginu.
2. **Build závislý na GitHub releases** `anomalyco/opencode` (a při nepinnuté verzi na „latest") — supply-chain i dostupnostní riziko; binárka se nekontroluje podpisem, jen sha256 do manifestu.
3. **Pin na 5 místech** — snadno rozjede verze SDK vs. binárky vs. vendorovaného pluginu (build to částečně hlídá, runtime už méně).
4. **Preload/env injektáž do enginu** — nedokumentované chování, může se rozbít tichou změnou upstream runtime (Bun verze uvnitř binárky).
5. **Strategická nejistota**: interní rozhodnutí z 2026-06-22 zní „full replace za Codex", ale kód dál roste na OpenCode — každá další investice do OpenCode-specifických vrstev (skills pipeline, pluginy) zvyšuje cenu výměny.
6. **UI navázané na SDK typy** (43 souborů) — bez translator vrstvy nelze engine vyměnit bez plošného zásahu do UI.
7. **Tři proxy vrstvy + dvě SSE cesty** — mnoho míst, kde se dá ztratit request; ladění vyžaduje trace přes 4 procesy (webview, Rust, server, orchestrátor, engine).
