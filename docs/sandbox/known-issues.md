# Known issues — současné pain pointy

Tohle jsou problémy, které **stále existují** v stavu k commitu
`60c5d93d` (květen 2026), nebo byly opraveny ale jejich kořenová příčina
zůstává v architektuře. Cíl: nový vývojář ví, co očekávat, a nepokouší
se "opravit" něco, co je úmyslné nebo neopravitelné bez velkého
refactoru.

Pro chronologii **toho, co už bylo opraveno**, viz
[`fixes-timeline.md`](fixes-timeline.md). Pro **jak debugovat**, když
narazíš, viz [`debug-playbook.md`](debug-playbook.md).

## 1. Engine cold start trvá 30-60 sekund

**Symptom:** První `sendPrompt` v daném workspace blokuje UI ~30-60 s.
Spinner "status.connecting", composer button šedý.

**Příčina:** Engine = OpenCode native (`veslo-code serve`) spuštěný
v macOS `sandbox-exec`. Při startu:

1. Sandbox profile load
2. Bun JIT initialization
3. SQLite migration na workspace DB
4. Plugin load (`@opencode-ai/plugin` + workspace plugins)
5. Provider config bootstrap
6. HTTP server listen

V dev profile s prázdnou Bun cache to běžně přesahuje **30 s**. Komentář
v `packages/orchestrator/src/cli.ts:3563-3572` (engine pool
`waitForHealthy`) timeout proto nastavený na **60 s**.

**Opravitelné?** Ne v rámci Vesla. Záležitost OpenCode + Bun runtime.
Možné mitigace:

- **Engine warm pool** — pre-spawn engine pro aktivní workspace v
  pozadí, dokud uživatel jen brouzdá. Nereagoval bych na to ihned,
  protože spotřebovává RAM (engines ~200-400 MB každý).
- **Lepší UX během cold startu** — místo "status.connecting" ukázat
  progress bar a popis kroků (`"Spouštím sandbox… 12 s"`,
  `"Načítám config…"`). Vyžaduje engine logy přes IPC do UI.

**Kód k pochopení:**
- `packages/orchestrator/src/engine-pool.ts::EnginePool::ensure`
- `packages/orchestrator/src/cli.ts:3536` `spawnEngine`
- `packages/desktop/src-tauri/src/commands/engine.rs::spawn_engine`

## 2. Tauri HTTP plugin má jeden IPC channel

**Symptom:** Při bootu nebo při rychlém přepínání workspaces se v console
objeví:

```
[Warning] [http] timeout {method: "GET", url: "...", timeoutMs: 30000}
[Warning] [http] timeout {method: "GET", url: ".../soul/status", timeoutMs: 10000}
[Warning] [engine-sse] stream error {message: "upstream status 502 Bad Gateway"}
[Error] Unhandled Promise Rejection: Timed out waiting for session.messages
```

**Příčina:** `@tauri-apps/plugin-http` v2 routuje **každý** `fetch`
z webview do Rust handleru přes **jeden IPC kanál**. Dlouhotrvající
fetch (typicky SSE subscribe) drží `fetch_read_body` invoke otevřený
a krátké requesty čekají ve frontě. Po překročení client-side timeout
fronta odbíhá s timeout errory.

**Co je opraveno:**

- Engine SSE (per-workspace `/event` stream) jde přes **Rust-side SSE
  proxy** (`packages/desktop/src-tauri/src/commands/engine_sse.rs`,
  commit `1dffda5e`). Rust se připojí přes `reqwest`, parsuje SSE
  chunks, emit-uje events přes Tauri event bus. UI jen `listen()`-uje,
  neblokuje IPC.
- Global SDK SSE (= veslo-server `/event`) jde přes stejnou Rust proxy
  s **Bearer auth** support (commit `661d4475`).

**Co zůstává problém:**

- Krátké requesty (status polls, soul/status, capabilities, ai-access
  preflight) běží přes Tauri HTTP plugin. Když fronta nahromadí 6+
  paralelních volání + nějaká delší (např. cold engine activate), starší
  fronta hits timeout.

**Možné mitigace:**

- Audit boot sequence, redukce počtu paralelních fetchů (debounce, sequence).
- Cache `/ai-gateway/me/ai-access` v paměti (TTL 5 min) — nyní se volá
  při každém `sendPrompt` preflight.
- Migrace dalších HTTP volání do Rust commands (přes ureq/reqwest).

**Reference:**
- `packages/desktop/src-tauri/src/commands/engine_sse.rs:3-15` (komentář
  o IPC kanálu, autoritativní popis problému)
- `packages/app/src/app/lib/http.ts::fetchWithTimeout` (kde se logují
  timeout warningy)

## 3. Reactive cascade ve frontendu (SolidJS)

**Symptom:** Po kliku na workspace UI začne dělat 10+ věcí paralelně
(load sessions, load config, refresh permissions, refresh providers,
refresh soul status, reconcile gateway tokens, …). Část selže
timeout, část retry-uje, console je plný.

**Příčina:** SolidJS effect re-fire při změně reactive signálu. Workspace
switch změní `activeWorkspaceId` signal → fire all effects co ten signal
čtou. Konkrétně (audit z `packages/app/src/app/context/workspace.ts`):

- `restoreSessionStateForActiveWorkspace` — load session cache
- `refreshSoulData` — `/workspace/<id>/soul/status` × N workspaces
- `reconcileManagedAiApiKeys` — `client.getConfig` + `client.patchConfig`
- `refreshPendingPermissions` — `client.session.permission.list` × N
  per-WS clients
- `engineStore.refreshEngine` + `refreshEngineDoctor`
- SSE multiplex effect (re-attach engine SSE per entry)
- `ensureLocalVesloServerRunning` (proverka veslo-server PID)

Některé jsou triggered z root effects, některé z per-workspace effects.
Bez explicitního state machine je obtížné garantovat pořadí a
deduplikaci.

**Opravitelné?** Ne v rámci ad-hoc fixů. Doporučené systémové řešení:
**WorkspaceLifecycleStateMachine** (viz [`handoff.md`](handoff.md)
sekce "Doporučená strategie").

## 4. Tři zdroje workspace identity

**Symptom:** Klik na workspace 404'd na orchestrator daemon nebo
veslo-server, sidebar byl OK ale activate selhal.

**Příčina:** Workspace ID (`ws-<hex>`) historicky generovaly 3 různé
algoritmy:

- Tauri local state: `DefaultHasher` (SipHash, random per-boot seed) → fresh ID každý boot
- Orchestrator daemon: `sha1(path).slice(0, 12)` → deterministic
- Veslo-server: `sha256(path).slice(0, 12)` s prefix `ws_` (underscore!) → deterministic ale jiný

Tj. UI dostalo ID z Tauri (siphash), poslalo POST `/workspaces/:id/activate`
na orchestrator (sha1 path) → 404 → silent failure → UI hangne na
30s activate timeout.

**Co je opraveno:**

- `e8d2982a` — Tauri sjednoceno na `sha1` + migrace existujícího state
  na disku.
- `04a2ba75` (fix #3) — veslo-server přepnut z `sha256/ws_` na
  `sha1/ws-`.

**Co zůstává:** všechny tři zdroje **nyní** souhlasí, ale je to konvence,
ne enforced. Pokud někdo přidá další store (např. nový cache), musí
ručně zachovat formát. Jeden centralizovaný helper neexistuje (jen
duplikovaná logika v Rust + TS + Bun).

## 5. AI gateway preflight timeout (30 s)

**Symptom:** Při bootu nebo `sendPrompt` se v console objeví:

```
[Warning] [http] timeout {method: "GET", url: "http://127.0.0.1:8787/ai-gateway/me/ai-access", timeoutMs: 30000}
```

UI vypadá zaseknuté 30 s.

**Příčina:** UI volá `GET /ai-gateway/me/ai-access` před každým send,
aby věděla jestli má uživatel platný Den access token. Endpoint je
v cestě: UI → tauriFetch → Tauri HTTP plugin IPC → veslo-server proxy
→ Den cloud → response. Pokud Den je pomalá, Tauri plugin overloaded,
nebo cokoli v cestě hangne → 30 s timeout.

**Opravitelné?**

- Cache výsledku v UI paměti (TTL 5 min). Den access se nemění často.
- Skip preflight pokud uživatel poslal nedávno (= bezpečně máme platný
  token v paměti).

Tohle zatím **není implementováno**, je to jeden z otevřených úkolů
v [`handoff.md`](handoff.md).

## 6. Engine spawn může vyžadovat reaktivní pool retry

**Symptom:** Po fresh boot nebo restart Vesla se občas objeví:

```
[Error] engine spawn failed: Unable to connect. Is the computer able to access the url?
[Warning] [engine-sse] stream error {message: "upstream status 502 Bad Gateway"}
```

A engine se nikdy nespawne, dokud uživatel restartne aplikaci.

**Příčiny (multi-faktor):**

- Sandbox-exec policy denial — engine se spustí, ale `read()` na
  workspace soubor selže → engine umře → "Unable to connect" na
  subsequent request.
- Stale plugin / vendoring mezi `~/.veslo/veslo-orchestrator-dev/opencode-config/<wsId>/`
  a `<workspace>/.opencode/node_modules/`. Engine `bun.resolve()` hledá
  z plugin file path → musí najít plugin v workspace dir, ne v configDir.
- Tauri shell plugin nezabíjí spawned child při Drop. Po cargo rebuild
  Tauri restart drop-uje `CommandChild` ale zombie zustává — port
  squatting + race s novou spawn.
- Idle suspend killne engine před uživatelův další request → orchestrator
  proxy zachytí "Unable to connect" než stihne respawn.

**Co je opraveno:**

- `c988a2c1` — workspace plugin vendoring fix.
- `df5d0ffc` — `idleSuspendMs<=0` treated as disabled.
- `bdccc0c6` (fix #7) — `resolve_veslo_port` reapne vlastní zombie
  bun procesy před bind.

**Co zůstává:** sandbox-exec denials jsou case-by-case, vyžadují ruční
audit profile. Žádný systémový fix bez OpenCode upstream práce.

## 7. WorkspaceClientStaleError jako unhandled rejection

**Symptom:** V console (často v desítkách):

```
[Error] Unhandled Promise Rejection: WorkspaceClientStaleError: Workspace client is stale: anchored to "ws-23d1e5cbc0b8", active is "ws-23bd3d4f67d4"
```

**Příčina:** Race condition během rychlého workspace switche. SDK
volání rozjeté pro workspace A bylo guarded proxy
(`packages/app/src/app/context/workspace-routing.ts:46`); když mezitím
uživatel přepnul na B, guard vyhodí stale error. To je **úmyslné** —
chrání proti zápisu do špatného workspace. Ale catchování není
konzistentní napříč callsites, takže Promise rejection bubliká do
window.onerror.

**Opravitelné?** Ano, jednorázový audit callsites a centralizované
catchování. Není to fatal, ale poškozuje signál v console. Otevřený úkol.

## 8. Veslo-code-router běží zbytečně v dev mode

**Symptom:** Další proces v `ps aux`, který v multi-workspace flow
nemá co dělat. Pollne `/global/health` na orchestrator daemon a může
generovat noise v log.

**Příčina:** `engine_start` v `commands/engine.rs:873` vždy spawne
veslo-code-router (= Telegram/Slack messaging bridge). V dev mode
pro multi-workspace stabilizaci se messaging nepoužívá, ale router
přesto běží.

**Opravitelné?** Conditional spawn (env var `VESLO_SKIP_ROUTER=1`) nebo
přesun do explicit user action (Settings → Messaging → Enable). Drobný
úklid, ne kritické.

## 9. Logy jsou roztroušené napříč 5 místy

**Symptom:** Debugovat single user click vyžaduje otevřít:

1. Webview DevTools console (Cmd-Opt-I v Tauri okně) — frontend logs
2. `pnpm dev` terminal — Rust + spawned process stdout/stderr
3. `/tmp/veslo-runtime.log` — Tauri runtime log
4. `~/.veslo/opencode-router/logs/opencode-router.log` — router pino log
5. Orchestrator state.json snapshot — engine state

Žádný centralizovaný stream.

**Opravitelné?** Ano (= jeden `/tmp/veslo-trace.log` co dostane vše).
Doporučený systémový úkol, viz [`handoff.md`](handoff.md).

## 10. Build / restart cyklus je pomalý

**Symptom:** Změnit Rust → cargo build → Tauri restart → 30-60 s před
testem. Pokud zapomeneš `--features e2e`, není WebDriver, musíš rebuildit.

**Příčina:** Tauri dev mode má cargo watch (= rebuild na change), ale
plný rebuild trvá ~5-15 s. Plus restart Tauri main = drop child procesů
= bun --watch zombie squatting. (Opraveno fix #7 reapingem.)

**Opravitelné?** Vimle:

- Incremental cargo build je rychlý (`cargo check`), full build pomalejší.
- `pnpm dev` defaultně nemá `--features e2e` — musíš to dopsat ručně
  do scriptu. To je trochu padlina, lze přidat jako env var
  (`VESLO_E2E=1` → script přidá `--features e2e`).
