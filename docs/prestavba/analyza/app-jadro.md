# Analýza: packages/app — JÁDRO (entry, routing, globální stav, workspace/session management)

Analyzovaná cesta: `packages/app`

## Účel a rozsah

Balíček `@neatech/veslo-ui` je sdílený SolidJS app-shell — jediné UI pro tři běhové režimy: Tauri desktop (primární), web-dev (Vite proti lokálnímu enginu) a web-remote/cloud (SPA servírované veslo-serverem přes proxy `/opencode`).

Rozsah (změřeno, bez node_modules/dist):

| Oblast | Soubory / LOC |
|---|---|
| Celkem `src/` | 792 souborů TS/TSX, **227 309 řádků** |
| `app/context/` (stores, controllery) | 77 souborů, **37 119 LOC** |
| `app/pages/` | 33 336 LOC |
| `app/components/` | 104 souborů, 25 972 LOC |
| `app/lib/` | 96 souborů, 22 188 LOC |
| `app/tests/` | 393 testovacích souborů, **85 582 LOC** |
| `i18n/` | 6 635 LOC (ručně udržované locale soubory en 2528 / cs 2524 / zh 1426 řádků) |

Reaktivní hustota (mimo testy): **218× `createEffect`**, 279× `createSignal`, 127× `setTimeout`, 159 přímých přístupů k `localStorage`, **250 volání `isTauriRuntime()`** a 39× `CLOUD_ONLY_MODE` — tři běhové režimy jsou propletené podmínkami skrz celý kód, nejsou odděleny vrstvou.

## Architektura a klíčové soubory

### Vstupní řetězec
1. `src/index.tsx` — bootstrap: téma, i18n, Sentry, startup request audit, volba routeru (**HashRouter v Tauri, jinak Router** — řádek 65), `Platform` abstrakce (openLink/restart/notify/storage/fetch).
2. `src/app/entry.tsx` — výpočet výchozí URL enginu (desktop `http://127.0.0.1:4096`, web přes proxy `/opencode`) a řetěz providerů: `ServerProvider → GlobalSDKProvider → GlobalSyncProvider → LocalProvider → App`.
3. `src/app/app.tsx` — **5 339 řádků**, jediná funkce `App()` = kompoziční kořen celé aplikace.

### App() jako kompoziční kořen (hlavní zdroj složitosti)
`App()` ručně instancuje ~30 továren („store“, „controller“, „workflow“, „facade“, „presenter“…) a propojuje je obřími options-objekty plnými callbacků:

- `createWorkspaceStore` (`context/workspace.ts`, 1 805 LOC) — options objekt má **~50 položek** (settery, gettery, callbacky) a vrací **~80 metod/signálů** (řádky 1719–1804). Uvnitř skládá dalších ~10 pod-továren (`config-store`, `engine-store`, `remote-store`, activation local/remote, runtime controller, connection controller, busy state, lifecycle reducer…).
- `createSessionStore` (`context/session.ts`, 1 168 LOC) + `session-event-stream.ts` (1 704), `session-selection-controller.ts` (1 004), `session-lifecycle-recovery.ts` (1 077), `session-transcript-controller`, `session-workspace-cache`.
- `createVesloServerConnection` (`context/veslo-server-connection.ts`, 1 574 LOC) — vrací **~35 hodnot** destrukturovaných v app.tsx (řádky 551–591).
- `createSidebarWorkspaceSessions` (1 342), `createConversationService` (1 792), `createSessionSendWorkflow` (`pages/session-send-workflow.ts`, 2 348), `createSessionCreationWorkflow` (677), `createManagedAiRuntimeConfigSync` (2 131), `createExtensionsStore` (3 665 — skills+pluginy+hub v jednom), `createAppViewProps` (`app-view-props.ts`, 2 046 — čistý prop-plumbing adaptér).

Graf závislostí má **skutečné cykly** (doloženo v `lib/late-bound.ts`, komentář: „The composition graph in app.tsx has true cycles (workspace store ↔ session store ↔ sidebar sessions)“). Řeší se:
- 7 slotů `createLateBound` (workspace-store, managed-ai-access-store, managed-ai-runtime-config, markReloadRequired, …) s frontou `whenBound` a diagnostikou „early access“;
- navíc přímé closury na proměnné deklarované o 2 000 řádků níže (např. `vesloServerConnection` na řádku 530 čte `workspaceStore` definovaný až na řádku 2 551 — TDZ past, funguje jen díky laznosti closur).

### Routing
- `context/app-route-sync.ts` (307) — mapování pathname→View, hash-sync pro Tauri, startup route decision (delegováno do `controllers/app-startup-controller.ts`).
- `context/session-route-sync.ts` (300) + `controllers/session-route-controller.ts` — resume session z URL; sleduje „route conversation identity key“ složený ze 4 částí (`sessionId::workspaceId::conversationId::opencodeSessionId`).
- View se nerenderuje přes route komponenty routeru — router má jedinou catch-all route (`index.tsx:154`) a `App()` si view přepíná sám přes `<Switch>` na `currentView()` (app.tsx ~5150). Router je tedy fakticky jen zdroj `pathname` + `navigate`.

### Identita session — tři jmenné prostory
`lib/session-identity.ts` explicitně dokumentuje, že konverzaci lze adresovat **třemi id**: UI/sidebar session id, Veslo `conversationId`, OpenCode `opencodeSessionId`; runtime mapy (status, busy) mohou být klíčované kterýmkoli z nich, takže každý lookup musí projít celou množinu kandidátů. Navíc `lib/ui-conversation-scope.ts` zavádí kompozitní klíče `ws:`/`ws2:` (workspaceId+kind+id+root+directory+conversationId+opencodeSessionId). Tato trojitost prosakuje do routingu, sidebaru, statusů i transkriptů.

### Přepínání workspace — obranná mašinerie proti race conditions
- `workspace-activation-controller.ts`: verzovaný guard (`wsActivateGuard.enter/isSuperseded/exit`), overlay-suppression tokeny, 30s timeout, `requestAnimationFrame` yield, a **24 magických „origin“ stringů** (`NON_BLOCKING_LOCAL_BROWSE_ORIGINS`, řádky 11–25) rozhodujících, zda aktivace blokuje UI overlay.
- `workspace-routing.ts`: celý OpenCode SDK klient je **rekurzivně obalen `Proxy`**, který při každém volání metody kontroluje, zda se mezitím nepřepnul aktivní workspace, a hází `WorkspaceClientStaleError` (komentář popisuje původní bug: sync čtení klienta + async volání SDK → zápis do enginu špatného workspace).
- `select-session-guard.ts`: verzovaný dedup proti sekvenci kliknutí A→B→A („the app appears frozen“).
- `runtime-owner.ts`: rozhodovací vrstva „kdo vlastní runtime“ (orchestrator-ready / routed-client / not-ready) nad routingem.
- `workspace-lifecycle-state.ts`: reducer nad lifecycle eventy — další paralelní stavový model.

### Datové cesty transkriptu — dva zdroje pravdy
1. **Živé SSE** z OpenCode enginu: v Tauri přes **Rust-side SSE proxy** (`lib/engine-sse.ts` — JS jen `listen()` na Tauri event `veslo://engine-sse-event`; zavedeno kvůli VSLO-86, kdy držený fetch-stream v Tauri http pluginu blokoval IPC kanál a UI ~60 s po startu mrzlo), na webu fallback na SDK `event.subscribe()`. Globální stream konzumuje `global-sdk.tsx` (s vlastním koalescingem a 16ms flush batchingem), per-workspace streamy `session-event-stream.ts`.
2. **Čtení z veslo-serveru (SQLite)**: `conversation-service.ts` (listConversations, getSessionTranscript, create/submit/run/abort conversation), `transcript-projection-store.ts` a `live-transcript-read-policy.ts`, které rozhodují, kdy smí „offline“ snapshot přepsat živý stav.

Smíření obou cest (reconcile, selection version, expectedRunId, „projection boundary“ diagnostika) je jedna z největších koncentrací složitosti.

## Komunikační vazby

| Kanál | Protistrana | Detail |
|---|---|---|
| Tauri IPC (`invoke`) | Rust shell (`packages/desktop`) | **~83 příkazů** v `lib/tauri.ts` (1 467 LOC): workspace_* (bootstrap/create/forget/import…), engine_* (start/stop/restart/doctor/install), orchestrator_*, veslo_server_*, skills (list/read/write/uninstall…), scheduler_*, opencodeRouter_*, drafts, access proofs, obsidian, updater, reset, db migrate |
| Tauri events (`listen`) | Rust shell | `veslo://engine-sse-event` (SSE proxy), `VESLO_SERVER_STATE_EVENT`, deep-linky, updater |
| HTTP (REST) | OpenCode engine | `@opencode-ai/sdk` **1.17.13 (pinned)**: session.list/get, config, provider, mcp.status, lsp.status, project.list, vcs, permission/question replies… |
| SSE | OpenCode engine | event stream (session.status, message.part.updated, todo.updated, permission.v2.*, question.v2.*…) |
| HTTP (REST) | veslo-server | `lib/veslo-server/` (4 088 LOC vlastního klienta + request-broker + header-profiles + status-stability): conversations, transcripts, workspaces registry, skills registry, capabilities, health |
| HTTP | Den (identity) + AI gateway | `lib/den-auth.ts` (1 156 LOC), `lib/ai-access.ts`, managed-AI runtime config sync |
| localStorage | — | 159 přístupů: nastavení, tokeny, migrace, debug flagy |

### Polling (trvale běžící smyčky)
- `server.tsx`: health check enginu každých **10 s**.
- `veslo-server-connection.ts`: adaptivní status-poll (od 1 s), 30s snapshot watchdog host-info, 3× 10s dev-poll (diagnostika, engine refresh, router info), 30s poll orchestrator engines — dohromady až ~6 souběžných smyček.
- `global-sync.tsx`: refresh burst (config+providers+auth+mcp+lsp+projects) při každém health flip.

## Vazba na OpenCode

**Velmi těsná.** 41 ne-testovacích souborů importuje `@opencode-ai/sdk` přímo; typy `Session`, `Message`, `Part`, `Event` tvoří páteř všech stavových modelů (session store, event stream, sidebar, view props, transcript projekce). Názvy SSE eventů, tvary `properties`, chování `directory` query, revert/unrevert, permission/question v2 — vše natvrdo v UI. Frontend navíc **řídí lifecycle enginu** (start/stop/restart/doctor/db-migrate přes IPC) a zrcadlí interní pojmy enginu (LSP status, MCP status, VCS info, projects).

Zároveň ale existuje druhá, vlastní abstrakce — veslo-server „conversation/run“ API — kterou jde send-path (create/submit/run/abort). UI tak žije v hybridu: **zápisy přes veslo-server, živé čtení přímo z enginu, offline čtení z veslo-server SQLite**. Výměna enginu by znamenala přepsat: event stream normalizaci (`utils/messages`, `session-event-stream`), všechny SDK typy ve stavu a props (stovky výskytů), engine-lifecycle IPC, a mapování 3 id prostorů. Realisticky = přepis většiny `context/` a `pages/session*`.

## Hotspoty složitosti

1. **`app.tsx` (5 339 LOC)** — kompoziční kořen s cykly, late-bound sloty, TDZ pastmi; jakákoli změna pořadí inicializace může rozbít boot.
2. **Prop-drilling na hraně kolapsu**: `SessionViewProps` ~**180 props**, `DashboardViewProps` ~**258 props**, k tomu adaptér `app-view-props.ts` (2 046 LOC), jehož jediným smyslem je props přeskládat. Žádný sdílený context pro views.
3. **Race-guard mašinerie**: verzované guardy (activation, selection), Proxy-wrapped SDK client, overlay suppression tokeny, origin whitelisty, timeouty 8/30/45 s — každá vrstva vznikla jako oprava konkrétního race (doloženo komentáři VSLO-86, VSLO-171, „Send-timeout fix 2026-06-10“). Symptom, ne příčina: stav je distribuovaný v ~30 vzájemně se volajících stores.
4. **Dvě datové cesty pro transkript** (SSE live vs. server SQLite) + politika, kdy která smí zapisovat (`live-transcript-read-policy`, `transcript-projection-store`, selection versions, expectedRunId).
5. **`veslo-server-connection.ts`** (1 574 LOC): 12 efektů, ~6 pollingových smyček, status-stability stroj proti blikání stavu.
6. **Diagnostická infrastruktura prorostlá vším**: send-workflow-trace, perf-log, bootstrap-diagnostics, workspace-debug, session-status-trace (globals na `window.__veslo*`), startup-request-audit, ui-effect-trace — odhadem nízké desítky procent kódu jádra je defenzivní tracing.
7. **Testy 85 582 LOC** (393 souborů v `tests/`) mockující přesně tyto továrny a jejich options objekty — každá změna signatury továrny = kaskáda oprav testů. Údržbová zátěž testů je srovnatelná s produkčním kódem.
8. **`extensions.ts` (3 665 LOC)** — skills, pluginy, hub katalog, install targety a reload-guard v jediném store.

## Duplicity a mrtvý kód

- **`GlobalSyncProvider` je z ~90 % mrtvý**: udržuje store `config/providerAuth/mcp/lsp/project/projectMeta/vcs` + per-directory `WorkspaceState` child stores (sessions/messages/parts/todos!) + vlastní SSE subscriptions + refresh burst — ale jediný reálný konzument je seznam providerů (`app.tsx:2355–2364`). `context/sync.tsx` (`SyncProvider`/`useSync`) nemá **žádného** konzumenta. Jde o paralelní, nepoužívaný stavový model session dat vedle session store.
- **`src/app/state/`** — jen re-export shimy (`state/sessions.ts` → `context/session` apod.), legacy aliasy.
- **Prototypy v produkci**: `pages/proto-workspaces.tsx` (451) a `pages/proto-v1-ux.tsx` (676) routované na `/proto`, přibalené v bundle.
- **`scripts/legacy-symbol-audit.mjs`** — repo má vlastní nástroj na hlídání známých legacy/fallback/compat symbolů (`runConversationFromVesloWriteApi` = „legacy-run-submit“, `compactCurrentSession` = „legacy-compact-submit“…), tj. vrstvení starých a nových send-cest je známý, institucionalizovaný stav.
- **Vícenásobné modely téhož stavu**: session status existuje v session store (`sessionStatus`), v event-stream store, v `scoped-session-status` (aliasované klíče), ve `workspace-session-snapshots`, v sidebar items a (mrtvě) v global-sync.
- `lib/*.impl.js` + TS wrapper dvojice (`cloud-policy`, `runtime-policy`, `local-file-path`) — duplicitní implementace kvůli node --test.
- `pr/` adresář s ad-hoc poznámkami a screenshoty přímo v balíčku.
- i18n `zh.ts` (1 426 řádků) výrazně zaostává za en/cs (2 528/2 524) — parity drift hlídaný jen skriptem.

## Co by znamenalo oddělení BE/FE (API + SPA)

**Pro toto:** SPA režim už částečně existuje — `entry.tsx` umí web build proti veslo-server proxy (`/opencode`), `Platform` abstrakce odděluje notifikace/restart/storage, `CLOUD_ONLY_MODE` větev existuje. Send-path už jde přes veslo-server conversation API.

**Proti / práce navíc:**
1. **~83 Tauri IPC příkazů** je na desktopu nosných (workspace bootstrap/CRUD, engine lifecycle, skills FS operace, drafts, scheduler, access proofs, updater). Pro čisté API+SPA musí všechny přejít na veslo-server REST — část ekvivalentů už na serveru je (viz dual provisioning TS/Rust), ale frontend je volá přes IPC, ne přes HTTP.
2. **SSE přes Rust proxy** (`engine-sse.ts`) existuje kvůli specifické vadě Tauri http pluginu; v čistém webu odpadá (nativní EventSource/fetch stream funguje) — tj. web split tuto vrstvu **zjednodušuje**.
3. 250 větvení `isTauriRuntime()` by se muselo zredukovat na jedinou platformní vrstvu.
4. Živé čtení přímo z enginu (session.list, mcp/lsp/project/vcs) by muselo jít přes server proxy — což už proxy `/opencode` umí; hlavní práce je sjednotit **jeden** zdroj pravdy pro transkript (dnes dva).
5. Autentizace: dnes mix localStorage tokenů, settings tokenů a header-profiles — pro web nutno konsolidovat.

Závěr: oddělení je proveditelné a paradoxně by **odstranilo** dvě velké vrstvy složitosti (Rust SSE proxy, IPC duplicitu k server API), ale vyžaduje dotažení veslo-server API na paritu s IPC příkazy.

## Náměty na zjednodušení

1. **Smazat mrtvou global-sync vrstvu** (GlobalSyncProvider child stores, sync.tsx, state/ shimy, proto pages) — ~2–4 tis. LOC bez rizika, okamžitě.
2. **Jeden zdroj pravdy pro transkript**: přesunout reconciliaci SSE×SQLite na server (server streamuje už smířený stav, ideálně vlastní SSE/WebSocket s conversationId jako jediným id) → zrušit `live-transcript-read-policy`, `transcript-projection-store`, většinu `session-event-stream` a 3-id join (`session-identity`, `ui-conversation-scope`). Toto je největší páka — odhadem −15–25 tis. LOC v jádru + zásadní úbytek race bugů.
3. **Rozbít `App()`**: nahradit ruční drátování ~30 továren s callback-options buď (a) skutečnými Solid contexty s vlastními providery, nebo (b) jediným app-store (reducer/state-machine) s odvozenými selektory. Cíl: zrušit `createLateBound`, TDZ closury a options objekty s 50 položkami.
4. **Zrušit prop-drilling**: SessionView/DashboardView číst z contextů; smazat `app-view-props.ts` (2 046 LOC) a ~440 props.
5. **Sjednotit desktop na server API**: desktop Rust jen spouští veslo-server jako sidecar a otevírá webview na něj; ~83 IPC příkazů zredukovat na hrstku čistě nativních (dialogy, updater, deep-linky). Tím zmizí dvojkolejnost IPC vs. HTTP i dual provisioning.
6. **Nahradit polling push kanálem**: status/health/engines konsolidovat do jednoho server-push streamu místo ~7 nezávislých smyček.
7. **Zredukovat trace infrastrukturu** na jeden vypínatelný diagnostický modul.
8. **Testovací pyramidu otočit**: 85 tis. LOC unit/reactivity testů mockujících interní továrny nahradit menší sadou E2E + kontraktních testů API — dnes testy betonují právě tu architekturu, kterou je třeba změnit.

## Rizika

- **Křehkost bootu**: pořadí inicializace v `App()` je implicitní kontrakt; late-bound + TDZ closures znamenají, že refaktor snadno vytvoří tiché no-op okno při startu (přesně to, co `onEarlyAccess` diagnostika přiznává).
- **Pinned SDK 1.17.13**: upgrade OpenCode SDK může rozbít normalizaci eventů a typy napříč 41 soubory; zároveň setrvání = drift vůči enginu.
- **Race-guard vrstvy se navzájem znají**: odstranění jedné (např. Proxy guard) bez odstranění příčiny (distribuovaný stav) vrátí staré bugy — zjednodušovat lze bezpečně jen shora (změna datového toku), ne vytrháváním guardů.
- **Testy jako betonáž**: jakýkoli architektonický zásah znamená přepis velké části 393 test souborů — nutno počítat do odhadů.
- **Tři režimy v jednom kódu**: změny pro web split mohou tiše rozbít desktop (a naopak) — 250 `isTauriRuntime()` větví není pokryto typovým systémem.
- **Dokumentace/memory zaostává za kódem**: `docs/prestavba/analyza/frontend-memory.md` (kopie v repu) popisuje starší uspořádání (sidebar signály v app.tsx, dnes v `sidebar-workspace-sessions.ts`) — orientace podle dokumentace je nespolehlivá, což zhoršuje AI-asistovaný vývoj.
