# Analýza dokumentace Veslo — vize vs. realita, historie bolesti

> **Pozn. k cestám:** tento report vznikl mimo repozitář a jako jediný si nechává původní konvenci — cesty s prefixem `git/` míří do tohoto repozitáře, holé `docs/...` do pracovního adresáře NAD repozitářem (mimo git). Ostatní dokumenty v `docs/prestavba/` už používají repo-relativní cesty bez prefixu.

Analyzovaný úsek: pracovní adresář `docs/` nad repozitářem (mimo git) + `*.md` (kořenové dokumenty repozitáře včetně 8 audit souborů) + přesahy do `git/docs/` (fixes/, dev/, sandbox/, features/, plans/), na které kořenové dokumenty odkazují.

Datum analýzy: 2026-07-19. Všechna tvrzení jsou ověřená proti souborům v repu; kde dokumentace tvrdí něco, co v repu není, je to explicitně označeno.

---

## 1. Účel a rozsah

Projekt má **tři paralelní dokumentační systémy**:

1. **Kořenové vize dokumenty v `git/`** — `VISION.md`, `PRODUCT.md`, `PRINCIPLES.md`, `ARCHITECTURE.md`, `INFRASTRUCTURE.md`, `README.md`, `AGENTS.md` (+ `CLAUDE.md`, `RELEASE.md`). Definují záměr: „nejtenčí možná vrstva nad OpenCode".
2. **`git/docs/`** — in-repo vývojářská dokumentace: `dev/` (36 souborů, kanonické runtime/testing docs + deep audity), `features/` (9 kanonických feature kontraktů), `plans/` (60+ návrhů, historické), **`fixes/` (57 fix-checkpoint dokumentů od 2026-06-25 do 2026-07-17)**, `sandbox/` (22 souborů — handoff pro multi-workspace + sandbox stabilizaci VSLO-86).
3. **Pracovní `docs/` mimo git** (Pavlův workspace) — `INDEX.md`, `ROADMAP.md`, `DECISIONS.md`, `ARCHITECTURE.md`, `memory/` (14 tématických pamětí), `handoffs/` (9), `design/` (8), `architecture/sandbox/` (7) a `architecture/david-main-eval-2026-07.md`.

K tomu leží **v kořeni `git/` osm audit souborů** (`workspace-deep-audit-1..5.md`, `workspace-sidebar-history-deep-audit-1.md`, `workspace-switching-specific-bugs-and-deep-test.md`, `missaligned UI response workspace mismatch.md`) — datované 2026-06-17, commitnuté do kořene repa. Jsou to nejcennější dokumenty celého repa pro pochopení, kde žije složitost.

Rozsah: ~66 souborů v pracovním `docs/`, 23 MD v kořeni `git/`, ~200+ souborů v `git/docs/`.

---

## 2. Architektura a klíčové soubory

### 2.1 Zamýšlená architektura (vize)

- `git/VISION.md:23` — *„We care about maximally using the opencode primitives. And build the **thinest possible layer** — always favoring opencode apis over custom built ones."* OpenCode = engine, Veslo = experience (onboarding, permissions, artifacts, premium UI pro BFU).
- `git/ARCHITECTURE.md:91-118` — tři vrstvy: (1) lokální exekuce (OpenCode na loopbacku), (2) cloud jen pro identitu/historii/sync (Den), (3) remote exekuce jako skrytá platformní capability. Messaging konektory (Telegram/Slack/WhatsApp přes opencode-router) implementované, ale **záměrně skryté z UI**.
- `git/ARCHITECTURE.md:154-159` — dlouhodobý směr: **Veslo server (`packages/server`) jako jediná API plocha pro filesystem operace**, Tauri-only operace jen jako „implementation detail / convenience fallback". To je přesně směr „web model API + SPA", který vlastník zvažuje — **dokumentace ho už dnes předepisuje**.
- `git/PRODUCT.md:24-28` — success metriky: < 3 min do prvního úspěšného tasku, > 90 % úspěšnost bez terminálu, 60 fps, < 100 ms latence.
- `git/PRINCIPLES.md:16-23` — „Parity: UI actions map to OpenCode server APIs", „Server-consumption first", „thin layer".

### 2.2 Skutečná architektura (jak ji přiznává vlastní dokumentace)

`git/docs/sandbox/architecture.md` („žijící graf procesů") popisuje realitu: po `pnpm dev` běží **5 lokálních procesů + 1 HTTPS endpoint**:

| # | Proces | Kanál | Port/Auth |
|---|--------|-------|-----------|
| 1 | `veslo` (Tauri main, Rust) | Tauri IPC + spawn dětí | port 4445 jen s `--features e2e` |
| 2 | `veslo-orchestrator` daemon (Bun) | HTTP, engine pool + proxy | random port, 127.0.0.1, HTTP Basic |
| 3 | `veslo-server` (Bun) | HTTP | **0.0.0.0:8787**, Bearer + `x-veslo-host-token` |
| 4 | `veslo-code-router` (Bun) | HTTP | random port — *„pro testování workspace flow irelevantní… jen poll-loopuje health"* |
| 5 | `veslo-code` × N (OpenCode engine per workspace) | HTTP + SSE | random porty, přes sandbox backend |
| 6 | `https://ai.veslo.work` (AI gateway) + `https://api.veslo.work` (Den) | HTTPS | cloud |

Rozpor vize vs. realita je tedy dokumentovaný samotným projektem: „nejtenčí vrstva nad OpenCode" má 5 vlastních procesů, vlastní conversation service, vlastní AI gateway, vlastní provisioning ve dvou jazycích (pravidlo dual provisioning TS `internal-system.ts` + Rust `internal_provision.rs` v kořenovém CLAUDE.md) a 57 fix dokumentů za tři týdny.

### 2.3 Vyhodnocení směru (David, `main`, 2026-07-01)

`docs/architecture/david-main-eval-2026-07.md` je nejlepší syntéza aktuálního směru:

- **Transporty z UI klesly ze 4 na ~2** (Tauri IPC + veslo-server HTTP; přímý fetch z `app/` na orchestrátor i engine = 0 výskytů).
- **Vznikla „intent" hranice pro zápis**: `POST /workspace/:id/conversations/:cid/runs` — frontend posílá záměr, backend resolvuje session + directory + run.
- **Server modularizace reálná**: 20 route modulů, ~8 500 řádků vytaženo, 0 cyklů. (Od té doby dále: `server.ts` dnes **4 883 řádků**, `app.tsx` po Fix 18 modularizaci **5 339 řádků** — čísla v eval dokumentu, 6 136 resp. 13 648, jsou už zastaralá — kód se zjednodušuje rychleji, než stárne dokumentace.)
- **Zbývající dva propletence**: (a) **dvojí čtecí kontrakt** — vedle intent API drží UI raw OpenCode SDK tunel `${vesloServerBaseUrl}/opencode` pro `session.messages`, config, mcp, permission; (b) **doménová logika v `server.ts`** — `submitConversationRunToOpenCode`, `reconcileConversationRunLifecycle`, 6 globálních Map AI-gateway stavu jako closures ve wiring funkci.
- **Topologie inverzně svázaná se sandboxem**: shared engine jen když sandbox OFF (`engine-topology.ts` — `throw` na shared+sandbox); default platform-gated (`runtime_preferences.rs` — Windows = 1 shared engine, **Mac = pool až 8 sandboxovaných procesů**, cold-start 30–60 s).

---

## 3. Historie bolesti — opakující se třídy chyb a kořenové příčiny

Toto je syntéza z 8 kořenových audit souborů, 57 fixes, 9 handoffů a memory souborů. Třídy jsou seřazeny podle toho, kolik nezávislých dokumentů je potvrzuje.

### Třída A: Více zdrojů pravdy o „aktivním workspace" (kořenová příčina č. 1)

**Dokumenty:** workspace-deep-audit-1 („Multiple Sources Of Truth", ř. 312-323), audit-2 (ř. 277-305), audit-3 (ř. 337-338, 378-415).

Existují **čtyři nezávislé reprezentace aktivního workspace**:
1. Solid signál `activeWorkspaceId` (frontend)
2. Tauri persistovaný `active_id` (`veslo-workspaces.json`)
3. Veslo server — active = **`config.workspaces[0]`** (aktivace je fyzicky reorder pole!)
4. Orchestrator router state `activeId`

Synchronizace je best-effort, chyby se místy záměrně ignorují (audit-2, riziko 7). Audit-3 to **potvrdil živě** na běžící aplikaci: frontend + orchestrátor na `test-repo1`, Veslo server stále na `scratch` — probe hlásil `app-server-active-path-mismatch` (ř. 399-406). *„There is no single atomic cross-layer switch transaction."* (audit-3, nález 4).

### Třída B: Optimistický early-publish + implicitní přepnutí workspace

**Dokumenty:** audit-1 (ř. 22, 68, 326-331), audit-2, audit-3 (nález 1), workspace-switching-specific-bugs (Bug 1, 2, 4), DECISIONS.md (VSLO-51), memory/frontend.md (pasti 1-5).

- Lokální aktivace publikuje `activeWorkspaceId` a `projectDir` **před** Tauri persistencí a před runtime připojením → reaktivní efekty klíčované na `activeWorkspaceId` běží uprostřed přechodu.
- Workspace se přepíná z **~19 různých entry pointů** (výčet origin tagů v audit-1, ř. 122-136), z toho mnoho **implicitních**: nový private chat, otevření pending draftu, send do session z jiného workspace, otevření Soul, vytvoření/import workspace (Tauri create nastaví `active_id` jako vedlejší efekt), forget workspace.
- Race: supersedovaná lokální aktivace může zůstat jako finální stav, když novější remote aktivace selže (specific-bugs, Bug 1); superseded remote connect mutuje globální client/baseUrl (Bug 4).
- memory/frontend.md dokumentuje SolidJS pasti: fire-and-forget refresh přepisuje optimistický update, efekt si ruší vlastní timer (nutný `untrack()`), `connectToServer` maže session state.

### Třída C: Raw `session.id` jako identita v multi-workspace UI

**Dokumenty:** workspace-sidebar-history-deep-audit-1 (celý), „missaligned UI response workspace mismatch" (celý), audit-4 (nález 6, 7), fixes 02, 03, 54, 55.

Dvě workspaces mohou legitimně obsahovat stejné `session.id`. Důsledky pojmenované dokumentací:
- sidebar hierarchy dropne jeden ze dvou řádků (`emittedSessionIds` Set na raw id),
- archivace v A schová řádek i v B (globální Set archivovaných id),
- **UI zobrazí odpověď z jiného workspace**: message/parts cache, transcript freshness, todos i `isKnownSessionId` jsou klíčované jen `sessionId`; background prefetch, DB warmup a legacy SSE fallback stream (prázdný source workspace id) zapisují do globálního store, který čte viditelná session — dokument „missaligned UI…" to klasifikuje jako **High severity**,
- AI gateway active-run registry je session-id-first → provider traffic přiřazený špatnému běhu.

Fixy 02/03/54/55 (červen–červenec) to postupně řeší scoped klíčem `workspaceId:sessionId` — třída byla známá minimálně od 2026-06-17 a opravovala se ještě 2026-07-16.

### Třída D: „Implicit active fallback" (pojmenovaná kořenová bug-class)

**Dokument:** workspace-deep-audit-5 — syntéza: *„The bug class is not simply 'single active exists'. The bug class is **implicit active fallback**: code that receives or can infer a workspace/session scope, but drops it and calls the active client/store anyway."*

Konkrétní projevy (audit-4, s file:line): questions jsou single-active zatímco permissions už per-workspace; `renameSession`/`deleteSessionById` jdou přes aktivní klient i pro session browsovanou z jiného workspace (destruktivní!); `connectToServer` idempotent-skip nechá globální klient navázaný na předchozí workspace; pending sidebar řádky leakují po selhání create/send.

### Třída E: Engine lifecycle / spawn / porty / ID schémata

**Dokumenty:** handoffy 2026-05-24 až 2026-05-26, handoff vslo-171-multi-mode-debug, memory/engine-spawn-timeout.md, fixes 05, 14, 21, 23, 25, 26, 28, 30.

- **Dva nezávislé workspace ID story**: frontend a orchestrátor generovaly různá ID pro tentýž adresář → proxy URL `/workspace/<frontendId>/opencode` orchestrátor neznal → 404 → „Blocked: workspace switch in progress" nekonečně. Fix: SHA1 stable ID v Tauri (handoff 2026-05-25).
- Wildcard bind `0.0.0.0` mapovaný na client baseUrl → „Unable to connect" → engine respawn loop (tamtéž).
- Loopback request storm — vyčerpání socketů na `127.0.0.1:8787` (fix 14).
- Cold start: plugin autoload zpomaloval engine start (fix 26), health OK ale session API ještě neodpovídá (fix 25), „starting" nerozlišené od „not running" (fix 28).
- Vendoring `node_modules` do každého workspace kvůli delegate pluginu importujícímu `@opencode-ai/plugin` (handoff 2026-05-26).

### Třída F: Pravdivost run lifecycle / optimistické UI vs. durable stav

**Dokumenty:** fixes 15, 22, 27, 46, 47, 48, 52.

Konverzace visící v „Answering" navždy (stale `conversation_run` řádek), model retry bez viditelného pokroku, Stop které nešlo na backend abort, první odpověď asistenta „zmizí" z UI, předčasný `idle` event uvolní optimistický stav před terminálním stavem durable běhu. Kořen: **tři vrstvy lifecycle** (OpenCode SSE, Veslo server durable run, frontend optimistický stav) bez jediného vlastníka pravdy.

### Třída G: God-files a jejich postupná dekompozice

**Dokumenty:** fixes 12, 13, 17, 18, 19; david-eval.

`app.tsx` (13,6k řádků), `session.tsx`, `session.ts`, `server.ts` (8k) — vše dokumentované jako „high-risk monolith", modularizace proběhla v červnu–červenci 2026 (dnes `app.tsx` 5 339, `server.ts` 4 883 řádků). Fix 19 přiznává „šest init-order seams patchovaných ad-hoc mutable proměnnými" — přístup před přiřazením byl tichý no-op.

### Třída H: Křehké testování

Audit-3 (ř. 376): *„Much of the app-layer coverage is **source-contract testing via regex over source files**. That protects exact ordering but can become noisy if the implementation is refactored."* — testy, které zamykají přesný tvar zdrojáku, jsou přesně to, co dělá AI-asistovaný refaktoring bolestivý.

### Souhrnná diagnóza kořenových příčin (jak je pojmenovává sama dokumentace)

1. Žádná atomická cross-layer transakce pro přepnutí workspace; 4 pravdy o aktivním stavu.
2. Optimistické publikování stavu + best-effort sync s ignorovanými chybami.
3. Neskopovaná identita (raw sessionId) v multi-workspace systému.
4. Implicit active fallback jako systémový vzor.
5. Tři vrstvy run-lifecycle bez jednoho vlastníka.
6. Duplicitní implementace (TS/Rust provisioning; frontend/orchestrátor ID).
7. „Connected" ≠ „engine attached" — přetížená sémantika stavů (audit-5 navrhuje i renaming: `connected` nesmí znamenat runtime-ready).

---

## 4. Komunikační vazby (jak je dokumentuje projekt)

| Protistrana | Kanál | Popis |
|---|---|---|
| Frontend ↔ Tauri shell | Tauri IPC | ~83 commandů (david-eval: ~80 % legitimně nativní — clipboard, okna, updater, workspace CRUD; ~15-20 se dotýká engine/db/sse) |
| Frontend ↔ veslo-server | HTTP + SSE | Bearer token; intent API pro zápis (`POST .../runs`), conversation read API, skills/plugins/MCP config, AI gateway proxy; **plus raw `/opencode` SDK tunel pro čtení** (dvojí kontrakt) |
| veslo-server / frontend ↔ orchestrátor | HTTP | Basic auth, random port; engine pool, `/workspace/:id/opencode/*` proxy (routuje podle ID z URL, ne activeId) |
| orchestrátor ↔ OpenCode engines | HTTP + SSE + spawn | 1 engine per workspace (Mac default), lazy spawn na non-GET, `503 engine_not_running` na GET |
| Engine SSE → frontend | SSE (multiplex přes Rust proxy + SDK stream) | multiplex tagovaný source workspace id; **legacy fallback stream s prázdným source id = díra** (missaligned UI doc) |
| Tauri ↔ sidecary | spawn + stdout/stderr | `process_supervisor` modul; lock ordering Engine → Orchestrator → VesloServer → Router |
| Soubory | filesystem | `.opencode/veslo.json`, `opencode.json(c)`, Tauri `veslo-workspaces.json`, orchestrátor state JSON, OpenCode SQLite `~/.local/share/opencode/opencode.db` (Veslo do ní i **přímo zapisuje** — VSLO-51/57!), internal-packs symlinky |
| Desktop ↔ browser (auth) | deep link `veslo://auth-complete` | Den auth handoff (PRODUCT.md:149-157) |
| App ↔ Den / AI gateway | HTTPS | api.veslo.work (identita, sync), ai.veslo.work (managed AI proxy) |

Bezpečnostní poznámky z `docs/architecture/sandbox/06-known-issues.md`: `--cors *` na veslo-serveru a `--approval auto` jsou vedené jako „design choice" (KI-2, KI-3) — s tokenem, ale bez origin kontroly.

---

## 5. Vazba na OpenCode

Dokumentovaná vazba je **mnohem těsnější, než vize připouští**:

1. **SDK povrch**: `@opencode-ai/sdk/v2` — session.*, event.subscribe (SSE), permission.reply, find/file API, config/providers, tui.* (git/ARCHITECTURE.md:161-433). UI je typově navázané na SDK shape (dvojí čtecí kontrakt, david-eval).
2. **Filesystem kontrakt**: `.opencode/skills|plugins|commands|agent`, `opencode.json(c)`, `AGENTS.md`/`CLAUDE.md` discovery — Veslo provisioning zapisuje do každého workspace (dual TS+Rust), vendoruje `node_modules` kvůli delegate pluginu.
3. **Intruzivní zásahy do engine internals**: přímé SQL UPDATE do OpenCode SQLite (`session.directory`, `message.data`, `part.data`) při „Choose folder" (ROADMAP, VSLO-51); mazání sessions z DB při forget (VSLO-57); env workaroundy `OPENCODE_DISABLE_CLAUDE_CODE=1` (VSLO-77); nemožnost nastavit `worktree` pro non-git workspace (VSLO-83 — klíč v config schématu neexistuje, fix selhal).
4. **Engine lifecycle ownership**: orchestrátor spawnuje/suspenduje pool OpenCode procesů, proxy-injektuje `x-opencode-directory` (server header autoritativně přepisuje — KI-5 fix).
5. **Upstream drift**: projekt vznikl úpravou open-source OpenWork (`packages/app/pr/openwork-*.md`, `docs/plans/2026-03-13-openwork-upstream-merge-audit.md`, balíček `packages/openwork` — už jen `docs`), fork engine byl explicitně zavržen („nechceme drift od upstreamu", VSLO-83).

**Co by znamenala výměna enginu**: podle dokumentace by padlo (a) celý raw SDK čtecí tunel v UI, (b) filesystem provisioning kontrakt (.opencode struktura, plugin/skill formát), (c) SSE event schéma a celý session store, (d) orchestrátor engine-pool (spawn/health/proxy sémantika `opencode serve`), (e) přímé SQLite manipulace. Jediné, co je engine-agnostické, je intent write API (`conversations/runs`) a Den/AI-gateway vrstva. Vize „thin layer" by výměnu měla umožňovat, realita dokumentovaná v git/docs ji činí velmi drahou.

---

## 6. Hotspoty složitosti (podle dokumentace)

| Místo | Problém | Závažnost |
|---|---|---|
| Workspace switching aparát (`packages/app/src/app/context/workspace-*.ts` — 8+ souborů) | 4 pravdy o aktivním stavu, ~19 entry pointů, optimistický early-publish, guardy na guardech (activate guard, routing stale guard, connection guard, sidebar sync guard, snapshot guard, navigation queues) — 8 audit dokumentů jen o tomhle | kritická |
| Session identity / store (`context/session.ts`, `conversation-scope.ts`) | raw sessionId klíče v messages/parts/todos/archive/SSE filtru → cross-workspace leak odpovědí (High severity dle „missaligned UI…") | kritická |
| `server.ts` (dnes 4 883 ř.) | run orchestrace + 6 globálních AI-gateway Map jako closures; abort svazuje conversation + gateway + orchestrátor fallback | vysoká |
| Sidebar (`workspace-session-list*`, refresh pipeline) | 6 datových zdrojů (live session.list, read API fallback, store sync, lokální mutace, archiv, grouping) s různou sémantikou úplnosti → „sessions se někdy zobrazí, někdy ne" (11 mechanismů v sidebar auditu) | vysoká |
| Send path (`workspace-send-target.ts`, composer submit) | preflight řetěz: ensure workspace active → ensure managed AI → ensure runtime reachable → routed client → create/send; každý krok má vlastní failure mode (fixes 05, 37-40, 44, 45, 48, 52) | vysoká |
| Dual provisioning (`internal-system.ts` + `internal_provision.rs`) | každá změna 2× ve dvou jazycích, ruční zrcadlení (pravidlo v CLAUDE.md) | vysoká |
| Topologie × sandbox (`engine-topology.ts`, `runtime_preferences.rs`) | inverzní coupling (shared jen bez sandboxu, `throw`), platform-gated default (Mac pooled = 8 procesů, cold start 30-60 s) | střední |
| Run lifecycle (SSE ↔ durable run ↔ optimistické UI) | tři vrstvy bez jednoho vlastníka; opravováno 7 fixy (15, 22, 27, 46, 47, 48, 52) | vysoká |
| Dokumentace samotná | 3 systémy (git kořen, git/docs, workdir docs) s duplikací a driftem; file:line odkazy zastarávají v řádu týdnů | střední |

---

## 7. Duplicity a mrtvý kód / zastaralá dokumentace

### Duplicitní dokumentační systémy
- **Dvě „sandbox" dokumentace**: `docs/architecture/sandbox/` (filesystem izolace, workdir) vs. `git/docs/sandbox/` (multi-workspace handoff) — INDEX.md musí explicitně varovat, že jde o jiné věci.
- **Dvě architektury**: `docs/ARCHITECTURE.md` (workdir) vs. `git/ARCHITECTURE.md` vs. `git/docs/sandbox/architecture.md` — tři popisy téhož s různou mírou stáří.
- **Roadmap duplicitně**: `docs/ROADMAP.md` (workdir) vs. YouTrack vs. `git/docs/plans/`.

### Prokazatelně zastaralá dokumentace (tvrdí něco, co v repu není)

| Dokument | Zastaralé tvrzení | Realita |
|---|---|---|
| `docs/ARCHITECTURE.md` (workdir) | monorepo = packages {app, desktop, orchestrator, server, web, e2e, opencode-router}, services {den, den-worker-runtime, openwork-share}; „e2e = Playwright" | chybí `landing`, `docs`, `document-runtime`, `openwork` a services `ai-gateway`, `worker-manager`; E2E je **tauri-pilot**, ne Playwright (git/AGENTS.md: „WebdriverIO is not part of the Veslo E2E surface") |
| kořenový `CLAUDE.md` (workdir) | „web = Landing page (Next.js)"; UI testy „vždy tauri-plugin-webdriver port 4445" | landing je `packages/landing`; `packages/web` je web-app pro auth handoff (port 3005); repo předepisuje **Tauri Pilot** scénáře |
| `docs/ROADMAP.md` | poslední update 2026-05-07, sekce „Rozpracované" prázdná | mezitím v `git/docs/fixes/` 57 fixů a velká přestavba (server-owned composer, modularizace app.tsx/server.ts) — roadmapa nepokrývá 2,5 měsíce práce |
| `docs/memory/frontend.md` | odkazuje na `components/session/sidebar.tsx`; čísla řádků v `app.tsx` (~2037, ~6533…) | `sidebar.tsx` byl smazán jako dead code (handoff vslo-171-auth-and-switch to plánoval); `app.tsx` po modularizaci má 5 339 řádků — všechny line-odkazy neplatné |
| `git/workspace-deep-audit-3.md` | „`workspace-lifecycle-state.ts` looks like a lifecycle model but is not wired into runtime" | dnes importován z `workspace.ts`, `runtime-owner.ts`, `workspace-runtime-controller.ts` — nález opraven, dokument ne |
| `git/ARCHITECTURE.md` | default OpenCode `127.0.0.1:4096`; příklad modelu `claude-3-5-sonnet-20241022` | reálně random porty per engine + veslo-server 8787; model příklad ~2 roky starý |
| `git/PRODUCT.md:137` | „use the design from ./design.ts that is your core reference" | `design.ts` v kořeni repa **neexistuje** |
| `git/INFRASTRUCTURE.md:84` | sidecar lifecycle „described in `packages/app/pr/openwork-server.md`" | soubor existuje, ale sám je označený „legacy filename" — PR-notes z doby OpenWork |
| `docs/architecture/david-main-eval-2026-07.md` | `server.ts` 6 136 ř., `app.tsx` 13 648 ř. | dnes 4 883 / 5 339 — eval je 3 týdny starý a klíčová čísla už neplatí (zde ve prospěch kódu) |
| `git/README.md` | instalace `veslo-code-router` z `github.com/neatech/veslo-code-router`, dvě sekce „Quick Start" | router žije v monorepu jako `packages/opencode-router`; README je slepenec více období |

### Mrtvý / zombie obsah
- `packages/app/pr/` — ~20 PR-notes z éry OpenWork (openwork-10x.md, openwork-orchestrator.md…), README je řadí jako „historical", ale INFRASTRUCTURE.md na ně odkazuje jako na živou referenci.
- `packages/openwork/` — obsahuje už jen `docs/`, zbytek balíčku pryč.
- `veslo-code-router` běží v každém dev/prod spuštění, ale je „pro workspace flow irelevantní… jen poll-loopuje health" (sandbox/architecture.md) a UI ho záměrně skrývá (VISION.md:14) — **běžící proces bez užitku pro hlavní flow**.
- Kořenové audit soubory (8 ks) v rootu repa — hodnotná historie, ale matou (root repa není místo pro pracovní audity; část nálezů už je opravena fixy 02-55 bez zpětné aktualizace).

---

## 8. Co by znamenalo oddělení BE/FE (web model: API + SPA)

Dokumentace paradoxně ukazuje, že **projekt už k tomu směřuje a má to napsané jako cíl**:

1. `git/ARCHITECTURE.md:154-159`: veslo-server má být jediná API plocha; Tauri-only file ops jen fallback. `git/AGENTS.md`: „Any capability that mutates `.opencode/` should stay expressible via the Veslo server API."
2. Davidova práce (david-eval) už postavila **zápisovou intent hranici** (`POST .../conversations/:cid/runs`) a stáhla transporty z UI na 2. Server-owned composer submit je hotový (fixes 37-39).
3. **Co zbývá pro čisté API+SPA** (přímo z david-eval, sekce 6):
   - sjednotit **čtení/streaming** pod tutéž bránu — zrušit raw `/opencode` SDK tunel (nebo vědomě potvrdit „parity" tradeoff),
   - vytáhnout conversation-run + AI-gateway stav ze `server.ts` do služby,
   - dokončit migraci od globálního `client()`,
   - zkolabovat 4 pravdy o aktivním workspace na jednu server-owned (frontendový „active" pak je jen UI focus — přesně kontrakt z audit-5),
   - z ~83 Tauri IPC commandů je jen ~15-20 engine/db/sse — ty se přesunou za server API; zbytek (okna, clipboard, updater, picker) je legitimní nativní shell, který v SPA modelu zůstane malý.
4. **Riziko dokumentované pro web klienta**: browser neumí lokální FS (git/ARCHITECTURE.md:144-152) — proto server-side surface; folder picker a deep-link auth zůstávají desktop-specifické.
5. Oddělení by zabilo největší třídu bugů (A, B, D): pokud aktivní stav vlastní výhradně server a frontend jen zobrazuje, mizí early-publish races, implicit fallback na aktivní klient i cross-layer desync.

---

## 9. Náměty na zjednodušení (odvozené z vlastní dokumentace projektu)

1. **Jedna pravda o aktivním workspace** — server-owned; frontendový `activeWorkspaceId` degradovat na UI focus (kontrakt z audit-5 a david-eval). Zabíjí třídy A, B, D najednou.
2. **Scoped identita všude** — `(workspaceId, sessionId)` jako jediný klíč pro messages/parts/archiv/SSE filtr; dokončit, co začaly fixy 02/03/54/55, a smazat legacy raw-id fallbacky. Zabíjí třídu C.
3. **Dokončit intent API pro čtení/streaming** — jeden kontrakt UI↔server, SDK tunel pryč; pak je UI engine-agnostické a výměna/upgrade OpenCode je lokalizovaná do serveru.
4. **Vyhodit `veslo-code-router` z default runtime** — je UI-hidden a flow-irelevantní; nechat jako opt-in CLI. −1 proces, −1 spawn/health/port aparát.
5. **Zrušit dual provisioning** — provisioning jen v jedné implementaci (server API; Rust jen volá server nebo se provisioning přesune celý do serveru). Pravidlo „při každé změně upravit oba soubory" je dokumentovaný generátor chyb.
6. **Rozpojit topologii od sandboxu a zvážit shared engine default na Macu** — David už jednodušší shared topologii postavil (Windows default); Mac drží pool 8 procesů s 30-60 s cold-starty.
7. **Zredukovat source-contract regex testy** ve prospěch behaviorálních testů — audit-3 je označuje za křehké; jsou přímou brzdou AI-asistovaného refaktoringu.
8. **Konsolidovat dokumentaci** — jeden domov (git/docs), kořenové audity přesunout do git/docs/audits, workdir memory soubory buď mazat, nebo datovat s expirací; zavěsit „poslední ověření" na každý file:line odkaz.
9. **Uzavřít messaging/remote/cloud-exec povrchy, které vize sama označuje za skryté** — VISION.md je deklaruje jako „intentionally hidden"; kód i procesy pro ně ale žijí a platí se za ně údržbou.

---

## 10. Rizika

1. **Dokumentace zastarává v řádu týdnů** — david-eval (3 týdny starý) už má neplatná klíčová čísla; memory/frontend.md odkazuje na smazané soubory. Každý agent, který se řídí workdir docs, pracuje s ~2 měsíce starým obrazem. Samotné docs varují: „před citací file:line ověř, že stále platí".
2. **Tři dokumentační systémy bez synchronizace** — workdir docs vs. git/docs vs. kořenové MD; riziko, že AI asistent naviguje podle špatného z nich (a přesně to je dokumentovaný mechanismus „AI-asistovaný vývoj selhává").
3. **Nálezy auditů zůstávají v repu jako „otevřené", i když jsou opravené** — a naopak: část kritických nálezů (legacy SSE fallback stream, questions single-active) nemá potvrzený fix dokument; nelze z dokumentace poznat aktuální stav bez čtení kódu.
4. **Bezpečnostní kompromisy vedené jako design choice** — `--cors *` + `--approval auto` na serveru vázaném na `0.0.0.0:8787` (KI-2/KI-3); pro budoucí web/SPA model to bude nutné přehodnotit.
5. **`git/CLAUDE.md` nařizuje delegovat veškeré kódování i vyhledávání na Codex CLI** — neobvyklé pravidlo, které samo může být příčinou degradace AI-asistovaného vývoje (dvojitá vrstva agentů, ztráta kontextu), a je v konfliktu s workdir pamětí „Veslo nepoužívá Codex CLI přímo".
6. **Rychlost oprav vs. rychlost vzniku chyb**: 57 fix dokumentů za 22 dní je symptom, ne řešení — dokud se nezkolabují zdroje pravdy, budou fixy dál dohánět tentýž generátor chyb.
7. **Sandbox-podmíněná složitost na Macu** (pool 8 procesů, cold-starty, tichý downgrade na unsandboxed v `sandbox-mode.ts`) — Pavel sandbox deprioritizoval, ale default konfigurace ho na Macu stále platí výkonem i složitostí.

---

## Příloha: klíčové zdrojové soubory této analýzy

- `git/VISION.md`, `git/PRODUCT.md`, `git/PRINCIPLES.md`, `git/ARCHITECTURE.md`, `git/INFRASTRUCTURE.md`, `git/README.md`, `git/AGENTS.md`, `git/CLAUDE.md`
- `git/workspace-deep-audit-{1..5}.md`, `git/workspace-sidebar-history-deep-audit-1.md`, `git/workspace-switching-specific-bugs-and-deep-test.md`, `git/missaligned UI response workspace mismatch.md`
- `git/docs/fixes/` (57 souborů, 2026-06-25 → 2026-07-17), `git/docs/sandbox/architecture.md`, `git/docs/dev/` (36 souborů)
- `docs/INDEX.md`, `docs/ROADMAP.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `docs/memory/frontend.md`, `docs/memory/infrastructure.md`, `docs/architecture/david-main-eval-2026-07.md`, `docs/architecture/sandbox/06-known-issues.md`, `docs/handoffs/2026-05-2{4,5,6}-*.md`
- Ověřovací sondy do kódu: `git/packages/` (výpis balíčků), `wc -l app.tsx server.ts`, existence `sidebar.tsx`, `workspace-lifecycle-state.ts` importy, `design.ts`, `packages/app/pr/openwork-server.md`
