# Handoff — pro nového vývojáře, který přebírá VSLO-86

Tenhle dokument je **vstupní bod**, pokud přebíráš multi-workspace
stabilizaci (= návaznost na sérii commitů `04a2ba75 … 60c5d93d` na
branchi `sandbox` z května 2026). Předpokládá, že jsi přečetl
[`README.md`](README.md) a alespoň [`architecture.md`](architecture.md)
a [`known-issues.md`](known-issues.md).

## TL;DR — současný stav

| Aspect | Stav |
|---|---|
| Boot freeze | ✅ Vyřešeno (`b211e5a0`) |
| Click na workspace freeze | ✅ Vyřešeno (`eff94c02`) |
| Browse mode spawne engine | ✅ Vyřešeno (`60c5d93d`) |
| Engine SSE 60 s timeouts | ✅ Vyřešeno (`1dffda5e` + `661d4475`) |
| Workspace ID mismatch | ✅ Vyřešeno (`04a2ba75`) |
| Token rotation po restartu | ✅ Vyřešeno (`bdccc0c6`) |
| Port discovery (8787) | ✅ Vyřešeno (`2dac2a81` + `bdccc0c6`) |
| **AI gateway preflight 30 s timeout** | ❌ Neopraveno — vidíš v console při bootu |
| **WorkspaceClientStaleError jako unhandled** | ❌ Neopraveno — non-fatal, ale šum v console |
| **Reactive cascade ve frontendu** | ❌ Architektonický problém |
| **Engine cold start 30-60 s** | ❌ OpenCode upstream issue |
| **Logy roztroušené napříč 5 místy** | ❌ Bez systémového řešení |

Branch `sandbox`, **11+ commitů ahead origin/sandbox**, **žádný push**.
Latest commit: `60c5d93d`.

## Priorita 1 — nehas dílčí bugy, opravit systémově

**Fix-mole hra je vyčerpávající.** Symptomy "jeden bug = jeden fix" se
vrací, protože architektonický dluh produkuje nové. Tři systémové
iniciativy v pořadí ROI:

### a) Audit všech entry points pro engine spawn (~4 hodin)

Engine spawn je v současnosti vyvolán z **mnoha** míst, a každé jen
"tichý" nepřímý route (volá SDK → orchestrator proxy → `pool.ensure`).
Cíl: najít **každé** volání, klasifikovat ho:

- "OK, MUSÍ spawn" → např. `sendPrompt`
- "Nikdy, použij offline transcript" → např. `selectSession` v browse
- "Conditional" → např. AI access preflight (cache 5 min)

Klíčová místa k auditu (kde jsem už začal):

- `packages/app/src/app/context/session.ts`:
  - `selectSession` (řádek ~893) — ✅ má fix (`engineReady` gate)
  - `loadEarlierMessages` (řádek ~1034) — ⚠️ stále volá SDK, potřebuje stejný fix
  - `loadSessions` (řádek ~686) — ⚠️ stejně
- `packages/app/src/app/context/workspace.ts`:
  - `connectToServer` (~řádek 1397) — volá `routing.ensure`, který
    spustí `waitForHealthy` na engine
  - SSE multiplex effect (per `entryIds`) — re-subscribe na engine SSE
    při změně entries
- `packages/app/src/app/app.tsx`:
  - AI preflight effect (`/ai-gateway/me/ai-access`)
  - Soul status refresh (`refreshSoulData`)
  - `reconcileManagedAiApiKeys` (volá `client.getConfig`)
  - `refreshPendingPermissions` (interval 5 s)

**Postup:**

1. `grep -rn "c.session\.\|c.global\.\|routing.ensure\|ensureEngineForWorkspace" packages/app/src` → vytvoř list
2. Pro každý: ověř, jestli běží v browse mode. Pokud ano, zkontroluj
   guard (`engineReady()` nebo equivalent).
3. Přidat **strict gate** v `workspace-routing.ts::client()`: pokud
   `engineReady()` false a caller není v whitelistu, vrať `null`.

**Verification:** `browse-no-engine-spawn.spec.ts` rozšířit o
"klik na vše, scroll v session, otevři settings — engine count 0".

### b) WorkspaceLifecycleStateMachine (~1 den)

Místo 5 nezávislých signálů (`engineReady`, `busy`, `connectingWorkspaceId`,
`workspaceConnectionStateById`, `sseConnected`) zavést **jeden** state:

```typescript
type WorkspaceState =
  | { phase: 'browsing' }
  | { phase: 'connecting'; since: number }
  | { phase: 'ready'; engineBaseUrl: string }
  | { phase: 'error'; message: string };
```

Všechny effects čtou tuhle state a reagují. Žádné race conditions
mezi signály ("engineReady=true ale busy=true a connecting=B"). Existující
signály se odvodí jako memoized derivace.

**Doporučená implementace:** XState (https://xstate.js.org/) nebo
custom reducer. SolidJS supportuje obojí.

**Verification:** Existující specs musí stále PASS. Plus přidat
"klik na 4 workspaces v rychlém sledu" — žádné stale errors v console.

### c) Sloučit orchestrator + veslo-server (~3 dny)

Currently:

- veslo-server (bun, port 8787) — persistent state, AI gateway proxy
- orchestrator daemon (bun, random port) — engine pool, HTTP proxy

Oba jsou bun procesy, oba mluví HTTP. Sloučit do jednoho procesu:

- Workspace state v jednom místě (eliminuje ID schema risk)
- Jeden HTTP hop méně (UI → 1 process → engines)
- Jeden auth flow (Bearer pro client + host token, Basic odpadne)
- Méně portů ke správě

**Postup:**

1. Přesunout engine pool logic (`packages/orchestrator/src/engine-pool.ts`)
   do `packages/server/src/` jako `engine-pool.ts`.
2. Přidat veslo-server routy `/workspace/:id/opencode/*` co proxy-ují
   na engine přes pool.
3. Smazat `packages/orchestrator/` (nebo nechat jako CLI binary pro
   server-only mode).
4. Tauri Rust: odstranit `orchestrator` spawn, `start_veslo_server`
   dostane všechny child responsibilities.

**Risk:** Veliká diff, řada testů. Doporučuju feature flag (`VESLO_MERGED=1`)
během přechodu.

## Priorita 2 — drobné fixy

Pokud nemáš čas na systémové iniciativy, tahle malé fixy stojí
za méně než hodinu každý:

### AI gateway preflight cache

`GET /ai-gateway/me/ai-access` se volá při každém `sendPrompt`. Den
access se nemění často. Cache výsledku v UI paměti, TTL 5 min:

```typescript
// app.tsx někde v ensureManagedAiBootstrapReady
const cached = aiAccessCache();
if (cached && Date.now() - cached.at < 5 * 60_000) return cached.value;
// jinak fetch + cache
```

### WorkspaceClientStaleError centralized catch

V každém callsite SDK volání (= `selectSession`, `loadEarlierMessages`,
`sendPrompt`, ...) přidat catch pro `WorkspaceClientStaleError`:

```typescript
try {
  await c.session.messages(...);
} catch (err) {
  if (isWorkspaceClientStaleError(err)) {
    // log INFO, ne ERROR; abort cleanly
    return;
  }
  throw err;
}
```

Nebo lépe: wrapper `await guardedCall(c.session.messages, args)` který
to udělá centrálně.

### Vypnout veslo-code-router v dev mode

`commands/engine.rs` v dev profile (= `cfg(debug_assertions)`) skip
`opencodeRouter_start`. Pokud uživatel chce messaging, explicit toggle
v Settings.

### Centralizovaný debug log

Vytvořit `~/.veslo/debug.log` co dostane výstup z:

- Tauri Rust `eprintln!` (forward přes existing `DebugLogsForwarder`)
- Veslo-server pino logger (přidat file transport)
- Orchestrator pino logger (přidat file transport)
- Engine stderr (forward přes spawn collector)
- Webview console (přes Tauri command `log_message`)

Pak `tail -f ~/.veslo/debug.log` ukáže komplet timeline.

## Recommended workflow

1. **Před každou novou prací:**

   ```bash
   cd packages/e2e
   export E2E_USE_EXISTING_PROFILE=1
   export E2E_TAURI_BINARY=$(pwd)/../desktop/src-tauri/target/debug/veslo
   pnpm exec wdio run wdio.conf.ts --spec ./specs/browse-no-engine-spawn.spec.ts
   pnpm exec wdio run wdio.conf.ts --spec ./specs/boot-freeze.spec.ts
   pnpm exec wdio run wdio.conf.ts --spec ./specs/pnpm-dev-3-clicks.spec.ts
   ```

   Pokud kterýkoli failuje → regrese existujícího fixu. Nejdřív oprav
   tu, pak pokračuj.

2. **Při novém bugu:**

   - Reprodukuj manuálně přes `pnpm dev` (= primární dev workflow).
   - Otevři DevTools (pravý klik → Inspect Element).
   - Zkopíruj **kompletní console** + screenshot.
   - Najdi v [`known-issues.md`](known-issues.md) jestli to není známé.
   - Pokud ne, prozkoumej v [`data-flows.md`](data-flows.md) který flow
     se uplatňuje.
   - Použij [`debug-playbook.md`](debug-playbook.md) pro nástroje.

3. **Po opravě:**

   - Napsat / rozšířit E2E spec, který reprodukuje bug bez fixu a
     PASS-uje s fixem.
   - Commit message následuje stávající styl:
     `fix(area): krátký popis (VSLO-86)`, popis symptomu, root cause,
     fix, verification (viz existující commit messages od `04a2ba75`
     dál).
   - Update [`fixes-timeline.md`](fixes-timeline.md) o nový commit
     v stejném commit (jinak docs ztratí cenu rychle).

4. **Commit, ale NEPUSHOVAT** bez explicitního OK maintainera. Branch
   `sandbox` je work-in-progress, push by mohl overwrite další session.

## Copy-paste prompt pro novou AI session

Pokud používáš Claude Code / podobnou AI pro pokračování:

```
Přebírám multi-workspace stabilizaci Vesla (VSLO-86).

Branch: sandbox, latest commit 60c5d93d.

První krok: přečíst docs/sandbox/ — všechno potřebné v 7 souborech,
začni s README.md a architecture.md.

Aktuální stav: viz docs/sandbox/handoff.md sekce "TL;DR — současný
stav". Co je opraveno + co zbývá.

První úkol: audit všech entry points pro engine spawn ve frontendu
(viz handoff.md priorita 1a). Cíl: garantovat že žádné implicit volání
SDK nemůže způsobit engine spawn v browse mode. Zatím má guard jen
selectSession; loadEarlierMessages, loadSessions, AI preflight ho
nemají.

Pravidla:
- Test přes UI klikání (WebDriver), ne přes Tauri/orchestrator API
  direct calls. Vlastní spec pokud existující nepokrývá.
- Po edit vždy build (cargo check pro Rust, pnpm typecheck pro TS).
- Commit po success, nepush bez explicitního "pushni".
- Žádné Co-Authored-By v commit messages.
- Při změně v docs/sandbox/ aktualizuj stejný commit (jinak docs
  rotnou).
- NIKDY revert vlastních změn ze stejné session bez explicitního OK.

První krok pro tebe: spustit 3 E2E specs (pnpm exec wdio run …) aby
sis ověřil že stávající fixy stojí. Pokud failují, opravit dřív než
začneš nové.
```

## Produktové priority

Multi-workspace stabilizace má **uživatelskou** stránku — co projekt
opravdu chce řešit:

- **Klik na další workspace nesmí zaseknout UI** — toto je primární
  symptom, který se sleduje. Ne abstraktní "AI gateway 401".
- **Lazy engine spawn jako mentální model** — když uživatel zapne
  aplikaci, žádný workspace není aktivní, žádný kontejner. Pasivně
  prochází historii. Engine se spustí až při první send. Cokoli co
  spawne engine bez explicit user akce je bug.
- **Redukce komplexity, ne přidávání vrstev** — projekt už má
  6 procesů, frustrace s tím existuje. Doporučení vede k **redukci**
  (= sloučit orchestrator do veslo-server), ne k novým vrstvám.
- **Stabilizovat trvale, ne fix-mole** — cíl je odstranit
  architektonický dluh, ne řešit symptom po symptomu.

Tyto hodnoty se promítají do metrik:

- **Boot do 5 s.** Reálně lze (po fixu měřeno 5 s pro veslo-server
  ready). UI musí být plně interaktivní bez čekání na engine.
- **Klik na workspace do 1 s.** Aktuálně ~520 ms v pnpm dev. OK.
- **První send → AI odpoví do 30 s** (cold engine spawn dominante).
- **Subsequent send → AI odpoví do 10 s** (engine warm).
- **Žádné errory v console** během pasivního flow.

Pokud se odchýlíš od těchto čísel, sleduj proč.
