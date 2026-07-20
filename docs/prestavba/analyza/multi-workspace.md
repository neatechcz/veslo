# Multi-workspace a limit „jeden engine = jedna složka" — hloubková sonda

Sonda na téma, které Pavel označil za kritické: paralelní práce ve více složkách současně.
Zdroj pravdy: kód v `git/` k commitu `71215b07`, canonical doc `docs/dev/opencode-workspace-runtime-architecture.md`.

---

## 1. Model engine↔workspace dnes

### Klíčové zjištění: existují DVĚ topologie současně, přepínané env proměnnými

`packages/orchestrator/src/engine-topology.ts:5` definuje:

- **`pooled-per-workspace`** (výchozí pro „holý" orchestrátor) — jeden OpenCode proces na workspace, spravovaný třídou `EnginePool`.
- **`shared-unsandboxed`** — JEDEN sdílený OpenCode proces pro všechny workspace, třída `SharedOpenCodeEngine`. Vyžaduje `VESLO_DISABLE_SANDBOX=1` + `VESLO_SHARED_OPENCODE_ENGINE=1` (`engine-topology.ts:65-75`).

**Na macOS a Windows je dnes výchozí režim `shared-unsandboxed`**: `packages/desktop/src-tauri/src/runtime_preferences.rs:33-35` (`default_shared_unsandboxed_engine_enabled() = cfg!(any(windows, target_os = "macos"))`) a `:156-157` — desktop nastaví obě env proměnné orchestrátoru automaticky. Linux zůstává na poolu.

### Kdo co spouští

Řetěz procesů: **desktop (Rust) → veslo-orchestrator → OpenCode engine(y)**.

- Desktop spouští orchestrátor daemon (`packages/desktop/src-tauri/src/orchestrator/mod.rs`, 846 řádků) a veslo-server (`veslo_server/spawn.rs`).
- Orchestrátor (`packages/orchestrator/src/cli.ts`, **6 934 řádků**) drží `EnginePool` (cli.ts:4256) i `SharedOpenCodeEngine` (cli.ts:4459-4461) a rozhoduje mezi nimi per request přes `resolveOpencodeProxyTarget` (`opencode-proxy-target.ts:44`).
- Engine se spouští jako `veslo-code serve --hostname <host> --port <port>` (cli.ts:2684), port z `findFreePort()` (náhodný volný). Workdir a `OPENCODE_CONFIG` dir per workspace: `join(dataDir, "opencode-config", ws.id)` (cli.ts:4265). Sdílený engine má workdir `dataDir/shared-opencode-runtime` a config dir `opencode-config/shared-unsandboxed` (cli.ts:4462-4463).

### EnginePool (pooled režim) — `engine-pool.ts` (1 058 řádků)

- Mapa `workspaceId → EngineProcess`, max **8 souběžných enginů** (`DEFAULT_ENGINE_POOL_CONFIG.maxEngines: 8`, řádek 196), LRU eviction při překročení (`evictLruIfNeeded`, :622), idle suspend po 15 min (:197), health monitor každých 5 s se 3 striky (:200-202), crash restart s exponenciálním backoffem, max 3 restarty (:204).
- `hasActiveWork` guard (:571): engine uprostřed generování drží jediné dlouhé SSE spojení, takže `lastActivityAt` ho mylně klasifikuje jako idle — bez guardu ho idle sweep zabíjel uprostřed práce. Ochranné okno aktivního runu: 2 hodiny (cli.ts:4254).
- GET/HEAD požadavky nikdy nespawnují engine (`getRunning`, :322) — studený spawn trvá „30-60s" (komentář :321), takže background polling nesmí spouštět cold start.

### Routing požadavků

Orchestrátor mountuje `/workspace/:id/opencode/*` a proxuje na správný engine (cli.ts:5593 `proxyToEngine`). Do každého požadavku injektuje `x-opencode-directory: <hostí cesta workspace>` a `x-veslo-workspace-id` (cli.ts:5502-5504) a přepisuje `directory` pole v JSON tělech (cli.ts:5613). Veslo-server při submitu runu přidává `?directory=` query param na `/session/:id/prompt_async|command|shell` (server.ts:4332-4360).

---

## 2. Vazba session↔engine↔složka

### Kde je stav

- **Conversation↔session binding**: SQLite `conversation-binding-store.ts` (packages/server) — `workspaceId + conversationId → engineSessionId + directory`. Session je **trvale připnutá k adresáři, kde vznikla** (canonical doc, „Core Rule": *„OpenCode sessions are created in the correct workspace directory and then remain bound to that directory"*).
- **Run registry**: SQLite `dataDir/conversations/runs.sqlite` v orchestrátoru (cli.ts:4183) + run lifecycle controller na serveru (`conversation-run-lifecycle-controller.ts`, 1 654 řádků).
- **Workspace registry**: orchestrátor má vlastní registr workspace s vlastními ID (SHA1 schéma) — nezávislý na frontendovém ID store (viz jizvy níže).

### Co se děje při přepnutí workspace v UI

Podle canonical docu: *„Workspace switching changes only what the user is looking at"* — nesmí restartovat engine ani přepínat session. Realita v kódu je ale vícekroková mašinérie (`workspace-activation-controller.ts` + `workspace-activation-local.ts`, dohromady ~1 000 řádků): guard proti souběžné aktivaci, „superseded" kontroly mezi každým krokem, STEP 4a remote→local reconnect, STEP 5-BROWSE offline režim ze SQLite, **STEP 5 „local→local engine restart"** (`restartLocalRuntimeForSwitch`, workspace-activation-local.ts:415+) — tj. přepnutí složky pořád může vést k restartu lokálního runtime. Frontend přepne `activeWorkspaceId` signál BRZY, před dokončením připojení, a reaktivní efekty klíčované jen na tomto signálu běží uprostřed přepnutí (přiznáno ve `workspace-deep-audit-1.md`).

Aplikace drží **per-workspace SDK klienty** (`workspace-routing.ts`): mapa `workspaceId → RoutingClient` s baseUrl na orchestrátorový proxy mount; SSE stream per workspace (`entryIds()` → multiplex v session.ts).

---

## 3. Workaroundy a jizvy

Tohle je nejvýmluvnější část — kód dokumentuje boj s architekturou:

1. **`WorkspaceClientStaleError` + rekurzivní Proxy guard** (`workspace-routing.ts:20-77`): každé volání SDK metody se za běhu kontroluje, jestli se mezitím nepřepnul aktivní workspace — protože dřív se volání „tiše routovala přes engine předchozího workspace". Léčí symptom (zápis do špatného enginu), ne příčinu (globální „aktivní workspace" stav).
2. **77 context modulů v aplikaci**, z toho ~30 jen pro workspace/session lifecycle: `workspace-activate-guard`, `workspace-switch-overlay-state`, `workspace-runtime-controller`, `session-lifecycle-recovery`, `session-queue-drain-controller`, `send-runtime-readiness` (788 řádků), `select-session-guard`, `session-reconnect`… Každý je vrstva obrany proti race condition z předchozích vrstev.
3. **Čtyři nezávislé zdroje pravdy o „aktivním workspace"** (workspace-deep-audit-1.md): Solid signál `activeWorkspaceId`, Tauri persisted `active_id`, aktivace na veslo-serveru, aktivace na orchestrátoru. Plus **nezávislé ID story**: komentář ve `workspace-server-sync.tsx:38-40` — *„frontend workspace ID doesn't match the orchestrator's (independent ID stores)"*, proxy URL s frontendovým ID vracela 404; fix e8d2982a „align stable_workspace_id with orchestrator's SHA1 scheme".
4. **Config sync na KAŽDÝ mutující request** (cli.ts:5459-5461): před každým non-GET proxy požadavkem se kopíruje `opencode.json(c)` z workspace do config diru enginu. **Ve sdíleném režimu je config dir jeden pro všechny workspace** (`opencode-config/shared-unsandboxed`) → dva workspace s odlišnou konfigurací (MCP, skills) si ji při souběžné práci vzájemně přepisují — last writer wins. To je korektnostní díra dnešního výchozího režimu na macOS/Windows.
5. **VSLO-86 série fixů** (květen 2026): `f0fa9724` multi-workspace race, `04a2ba75` „align IDs + loopback wiring + auto-register", `661d4475` SSE přes Rust proxy s Bearer auth, `df5d0ffc` — bug, kdy frontendový default `idleSuspendMs=0` znamenal „okamžitě suspenduj každý engine v momentě ready" → „Unable to connect" na každý request.
6. **HMR leak s ~500% CPU** (`workspace-server-sync.tsx:44-47`): dřívější setInterval polling leakoval timery a generoval stovky visících HTTP požadavků na veslo-server.
7. **Engine-loss terminalizace runů** (cli.ts:4207 `cleanupRunsForLostEngine`) + „route release must invalidate in-flight ensures" (canonical doc) — celá třída úklidové logiky existuje jen proto, že engine procesy umírají/rotují porty a klienti na ně drží reference.
8. **Send-boundary Zod validace s trace eventy** (`VITE_VESLO_SEND_BOUNDARY_VALIDATION`, default `report`) a `send-workflow-trace.ndjson` — rozsáhlá diagnostická infrastruktura vybudovaná čistě kvůli ladění tohoto flow; sama o sobě je přiznáním, že flow nikdo nedokáže udržet v hlavě.
9. **Startup single-owner fronta v desktopu** (canonical doc, „Desktop Shell"): *„Two concurrent orchestrator daemons can split workspace registration from the lifecycle endpoint… desktop boot must never allow that race"* — debug autostart si musí rezervovat stejnou frontu jako explicitní start.

Audit dokumenty v rootu gitu (`workspace-deep-audit-1..5.md`, `workspace-switching-specific-bugs-and-deep-test.md`, `missaligned UI response workspace mismatch.md`) + commity `6c74b2dd` „WORKSPACE SWITCH - BUG FOUND - FIXED", `93037954` „Session send contract, Workspace switches.." potvrzují, že workspace switching je opakovaně nejporuchovější oblast.

### Historická stopa limitu „jeden engine = jedna složka"

- Původně existoval **singleton engine** (jeden proces, jedna složka) — odstraněn 2026-05-18: `752fd473` „remove singleton engine path (VSLO-171 fáze 2, F2Ú3)"; komentář cli.ts:4089 „VSLO-171 fáze 2 F2Ú3: singleton engine smazán".
- Následoval **EnginePool** (engine per workspace, 2026-05-18, `70f29538`) → 14 dní VSLO-86 hašení racy.
- Nakonec **SharedOpenCodeEngine** (~2026-06-13 `bdfc913b` „Veslo engine upgrades and sandbox mode refactor", finalizace 2026-06-30 `fbd0756b`) — návrat k jednomu procesu, ale multi-directory.

Takže projekt prošel: 1 proces/1 složka → N procesů/N složek (těžké) → 1 proces/N složek (dnes default). Pool ale zůstal v kódu jako druhá topologie a obě se musí udržovat („two execution modes behind one runtime boundary", canonical doc).

---

## 4. Co umí samotný OpenCode

**Limitace „jeden engine = jedna složka" v dnešním OpenCode NEEXISTUJE.** Canonical doc (řádky 23-39) popisuje empirické ověření na OpenCode 1.16.2:

- jeden `opencode serve` proces umí vytvářet sessions v různých adresářích,
- souběžné shell akce běží každá ve svém session adresáři,
- session zůstává připnutá k adresáři vzniku; pozdější `directory` parametr existující session nepřesměruje.

Mechanismus: per-request `?directory=` query param / `directory` pole v těle — přesně to, co orchestrátor proxy injektuje. Veslo používá **stock upstream binárku**: `veslo-code` = OpenCode stažený z GitHub releases `anomalyco/opencode` v1.17.13 (prepare-sidecar.mjs:61-64, 948), žádný fork; SDK `@opencode-ai/sdk@1.17.13` v `app` i `orchestrator`.

Kde limitace historicky seděla: v **procesním modelu** (engine startoval s jedním workdir a config direm a celá aplikace na tom stála), ne v OpenCode samotném. Zbytková per-directory omezení dnes: (a) konfigurace — engine čte globální config z `OPENCODE_CONFIG` diru, který je ve sdíleném režimu jeden (viz jizva č. 4); (b) izolace — jeden proces = žádný sandbox mezi workspace (proto je režim pojmenovaný „unsandboxed" a hlídaný červeným warning bannerem, `engine-topology.ts:34-45`).

---

## 5. Architektonické varianty pro čistou paralelní práci s N složkami

Žádnou nevybírám — rozhodne vlastník. Řazeno od nejmenšího zásahu.

### Varianta A — Dotáhnout shared engine jako JEDINOU topologii
Smazat `pooled-per-workspace`: EnginePool (1 058 ř.), LRU/idle/restart mašinérii, sandbox plumbing (WSL2 path rewriting, `childKind`, `sandboxMode`, fallback klasifikace), topologické větvení v proxy, poolové větve v desktopu i aplikaci.
- **Musí se vyřešit**: per-workspace konfigurace ve sdíleném enginu (dnes last-writer-wins do jednoho config diru — buď ověřit, že OpenCode čte `.opencode/` config per session directory, nebo config předávat per request); restart sdíleného enginu = výpadek všech workspace najednou.
- **Zjednoduší**: orchestrátor se smrskne na supervisor jednoho procesu; zmizí port-per-workspace routing, cold-spawn problém (30-60 s), engine-loss úklid per workspace.
- **Zkomplikuje**: definitivně pohřbívá sandbox per workspace (ten už je ale stejně fakticky opuštěný).
- **BE/FE split**: neutrální až pozitivní — méně procesů k orchestraci znamená jednodušší backend.

### Varianta B — Engine-per-workspace jako jediný režim
Opačný řez: smazat shared mode, nechat pool.
- **Musí se vyřešit**: nic nového — pool existuje a funguje; zůstává správa portů, LRU, pomalé cold spawny, ~8enginový strop, vyšší RAM.
- **Zjednoduší**: přirozená per-workspace konfigurace i izolace; pád enginu zasáhne jen jeden workspace.
- **Zkomplikuje**: udržuje nejsložitější část orchestrátoru navždy; historicky právě tady vznikla většina racy (VSLO-86).
- **BE/FE split**: funguje, ale backend zůstává „správce flotily procesů" — složitější na provoz mimo desktop.

### Varianta C — Sloučit orchestrátor do veslo-serveru (jeden backend)
Dnes: app ↔ veslo-server ↔ orchestrátor ↔ engine, plus app ↔ orchestrátor přímo (SDK klienti), plus Tauri IPC, plus Rust SSE proxy. Tři backendové procesy (server, orchestrátor, engine) a čtyři komunikační kanály.
- **Co se udělá**: engine lifecycle (ať už A nebo B topologie) přestěhovat do veslo-serveru; app mluví JEN s veslo-serverem přes HTTP/SSE; desktop shell jen superviduje jeden proces a dělá OS integraci (folder picker, okna). Zmizí: orchestrátorový proxy mount pro app, duplicitní workspace registry a ID schémata (jizva č. 3), lifecycle endpoint handshake server↔orchestrátor.
- **Zjednoduší**: jeden zdroj pravdy o workspace/engine; frontend přijde o celou vrstvu per-workspace SDK klientů s guard proxy — všechna volání jsou workspace-scoped HTTP na server (`/workspace/:id/...`), což už je deklarovaný cílový tvar API.
- **Zkomplikuje**: velký refaktor (orchestrátorový cli.ts má 6 934 řádků, část je CLI/TUI/sidecar management, který se musí rozdělit); přechodné období dvou cest.
- **BE/FE split**: tohle JE ten split — veslo-server se stává samostatným backendem použitelným z prohlížeče; Tauri zůstává tenká skořápka.

### Varianta D — Vyměnit engine (např. Claude Agent SDK embedovaný v serveru)
Zmíněno pro úplnost: multi-folder problém neřeší lépe než A/C (ten už je vyřešený per-request directory), a znamená reimplementaci sessions/skills/MCP kontraktů, na kterých stojí server, app i router. Dává smysl jen jako součást většího rozhodnutí „odejít od OpenCode", ne jako fix paralelní práce.

### Poznámka k jádru problému
Většina jizev nepochází z enginu, ale z toho, že **„aktivní workspace" je globální mutable stav replikovaný ve 4 vrstvách** a session flow na něm reaktivně visí. I kdyby engine topologie zůstala jakákoli, klíčové zjednodušení je: workspace jako parametr požadavku (což backend s `?directory=` už umí), ne jako globální režim aplikace. Varianty A i C tímhle směrem jdou; B ho neřeší, jen izoluje procesy.
