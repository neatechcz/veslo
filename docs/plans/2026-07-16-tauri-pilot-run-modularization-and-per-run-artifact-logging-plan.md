# Tauri Pilot: modularizace scénářů a per-run diagnostické artefakty

**Status:** návrh připravený z read-only auditu aktuálního pracovního stromu (2026-07-16).

**Cíl:** Udělat z každého Tauri Pilot běhu samostatně dohledatelný, redigovaný a omezeně uchovávaný artefakt. Současně zmenšit duplicitu v runneru a TOML scénářích, aniž by se ztratila 1:1 desktopová interakce s ostrým Den přihlášením a skutečným UI.

**Architektura:** Zachovat TOML jako popis viditelných uživatelských kroků. Vyčlenit malý run-store, jednotné spouštění Pilot commandů, typovaný plán scénářů a browser-side prelude s čistě UI pomocníky. Veškeré logy jednoho běhu patří do jednoho gitignored adresáře; jednotlivé zdroje zůstávají oddělené soubory.

**Ne-cíle:**

- nepřepsat všech 80 TOML scénářů do TypeScriptu;
- nepřidat obecný Rust command pro libovolné testovací skripty;
- nepřestat používat ostrou auth/snapshot cestu v live scénářích;
- automaticky mazat dosavadní historické `tauri-pilot-failures/` artefakty;
- ukládat hodnoty `Authorization`, tokeny, cookies, request body nebo prompt text jen proto, že je běh lokální.

---

## 1. Stav potvrzený auditem

### 1.1 Artefakty nemají vlastnictví jednoho běhu ani retention

Aktuální stav na disku:

- `packages/e2e/tauri-pilot-failures/`: 58 diagnostických adresářů, 46 volných souborů, 72,52 MiB;
- neexistuje implementovaný retention/prune mechanismus;
- failure diagnostika zapisuje do `tauri-pilot-failures/diagnostics-<timestamp>-<scenario>`;
- live inference success diagnostika zapisuje do `tauri-pilot-artifacts/live-inference-diagnostic-...`;
- render success artefakty zapisují do jiného `tauri-pilot-artifacts/session-render-stability-...` adresáře.

Relevantní současná místa:

- `packages/e2e/helpers/pilot-runner.ts:1386-1458` — failure bundle;
- `packages/e2e/helpers/pilot-runner.ts:1468-1509` — live success bundle;
- `packages/e2e/helpers/pilot-runner.ts:1511-1557` — session-render bundle;
- `packages/e2e/helpers/app-launcher.ts:569-574` — pouze timestampové přejmenování starého stdout/stderr bez limitu.

### 1.2 `TAURI_PILOT_LOG_DIR` není univerzální log root

`createAppLaunchEnv` nastavuje `TAURI_PILOT_LOG_DIR` do izolovaného profilu (`app-launcher.ts:634-683`). To samo o sobě nestačí:

1. `runtime_preferences.rs:171-201` při zapnutých support diagnostics sestaví vlastní cesty pro server a orchestrator.
2. Tyto hodnoty jsou při spouštění sidecarů aplikovány až po zděděném environmentu (`orchestrator/mod.rs:535`, `commands/orchestrator.rs:857`, `veslo_server/spawn.rs:754`). Mohou tedy přepsat Pilot cestu.
3. UI `log_ui_event` pro send-workflow trace skončí před zápisem, když desktop preference support diagnostics není zapnutá (`commands/misc.rs:260-269`).

Poslední harness-owned `e2e-logs/` obsahoval `app-stdout.log`, `app-stderr.log`, server a orchestrator trace, ale ne `send-workflow-trace.ui.ndjson` ani `runtime-trace.*`. Dokumentace přitom požaduje evidence pro každý běh včetně runtime trace a stdout/stderr (`docs/testing/tauri-pilot/README.md:614-629`).

### 1.3 Zelený Pilot command nemá uložený výsledek

`runPilotCommand` stdout/stderr bufferuje, ale při `exit 0` je zahodí (`pilot-runner.ts:1268-1328`). Vedle existuje téměř shodná `runPilotCommandCapture` jen pro zvláštní diagnostiky (`pilot-runner.ts:1330-1384`). Normální úspěšný scénář proto nemá `result.json`, log commandu ani JUnit artifact, ačkoli lokální Pilot dokumentace podporuje `run --junit <file>` (`docs/testing/tauri-pilot/README.md:600-612`).

### 1.4 Scenario policy je rozptýlená

`pilot-runner.ts` má při auditu 1 850 řádků. Policy je současně v suite seznamech, `MANAGED_AI_INFERENCE_SCENARIO_NAMES`, 17 `scenarioSelectionNeeds/Requires/Disables...` funkcích (`pilot-runner.ts:782-1113`), env mutacích, fixture lifecycle a post-success háčcích.

To je riziko driftu: nový scénář může být zařazen do suite, ale nemusí dostat správnou auth, profilovou izolaci, fixture, timeout, relaunch nebo success artefakt.

### 1.5 TOML scénáře duplikují browser infrastrukturu

Audit aktuálního adresáře `packages/e2e/pilot-scenarios/`:

| Metrika | Hodnota |
| --- | ---: |
| TOML scénáře | 80 |
| fyzické řádky TOML | 12 810 |
| `action = "eval"` kroky | 191 |
| scénáře s vlastní `waitUntil` | 27 |
| scénáře s vlastní `tauriInvoke` | 20 |
| scénáře s vlastním `setProgress` | 9 |
| scénáře s alespoň 300 řádky | 16 (8 121 řádků) |

`message-send-registry-degraded.toml`, `live-skills-finder-roundtrip.toml` a `session-run-truthfulness.toml` opakují stejný typ helperů: čekání, Tauri invoke, viditelný text, progress/error marker, trace summary a browser manipulaci contenteditable.

### 1.6 Redakce není jednotná hranice

Runner rediguje failure diagnostiku (`redactPilotDiagnosticText`, `pilot-runner.ts:285-315`), ale launcher zapisuje raw app stdout/stderr přímo přes `appendFileSync` (`app-launcher.ts:1380-1417`). UI, server i orchestrator zároveň přijímají a serializují obecný payload do trace eventů.

Audit neprokázal konkrétní únik credentialu. Nelze ale garantovat bezpečnost budoucího per-run archivu, pokud se ochrana aplikuje až na některé diagnostic výstupy. To je zvlášť důležité pro scénáře s ostrou Den auth a reálnými request headers.

---

## 2. Cílový run layout

```text
packages/e2e/.pilot-runs/
  20260716T183100Z-live-inference-a1b2c3d4/
    run.json
    runner.ndjson
    app/
      launch-01.stdout.log
      launch-01.stderr.log
      launch-02.stdout.log
      launch-02.stderr.log
    traces/
      send-workflow-trace.ui.ndjson
      send-workflow-trace.server.ndjson
      send-workflow-trace.orchestrator.ndjson
      runtime-trace.<run-id>.jsonl
      opencode-health.ndjson
    scenarios/
      message-send-registry-degraded/
        result.json
        pilot.stdout.log
        pilot.stderr.log
        pilot.junit.xml
        failure/
          failure.txt
          logs.json
          network.json
          screenshot.png
        success/
          live-inference-summary.json
```

Pravidla:

- `runner.ndjson` je append-only časová osa **jen tohoto runu**, nikoli globální rostoucí soubor.
- App stdout/stderr se dělí podle launch instance, aby relaunch nemazal ani nemíchal předchozí proces.
- Každý běh dostane stabilní `runId`; předá se jako `VESLO_RUN_ID` pro korelaci sidecar trace.
- `run.json` obsahuje pouze allowlisted metadata: schema, run ID, čas, stav, suite/scénáře, binary mode, profilový režim, bezpečný fixture stav, auth mode a maskovaný subject. Nikdy nedumpuje celé `process.env`.
- Run se stavy `running` a `abandoned` má owner lease (PID, hostname, start a heartbeat), aby přerušený runner neblokoval retention navždy.
- Šifrované či raw credential hodnoty nejsou součástí žádného artifactu. Pro headers stačí evidence názvů a `authorization: present|missing`, nikoli hodnota.

---

## 3. Navržené malé moduly

### 3.1 `packages/e2e/helpers/pilot-run-store.ts`

**Odpovědnost:** Vytvoření a dokončení runu, adresářová struktura, redigovaný zápis, runner eventy, scenario subdirectories a bounded retention.

Navržené API:

```ts
type PilotRunContext = {
  runId: string;
  runDir: string;
  traceDir: string;
  appLogDir: string;
  scenarioDir(name: string): string;
  record(event: string, payload?: SafeRunEvent): void;
  heartbeat(): void;
  writeResult(name: string, result: PilotCommandResult): void;
  finish(status: "passed" | "failed", details?: SafeRunFinish): void;
};

createPilotRunContext(...): PilotRunContext;
reconcileAbandonedPilotRuns(root, { activeRunId, now, isOwnerProcessAlive }): ReconcileResult;
prunePilotRunHistory(root, { keepTerminal: 10, activeRunId }): PruneResult;
```

`run.json` se průběžně aktualizuje z `running` na `passed`, `failed` nebo bezpečně zjištěné `abandoned`. Owner obsahuje `hostname`, `pid`, `startedAt` a `heartbeatAt`; heartbeat se obnoví při každém lifecycle přechodu a pravidelně během dlouhého Pilot commandu. `runner.ndjson` zaznamená například `run.started`, `fixture.started`, `app.launch.started`, `pilot.ready`, `scenario.started`, `scenario.finished`, `app.stopped` a `run.finished`.

#### Stale-run protokol

Výchozí heartbeat interval je 5 sekund a stale TTL 2 minuty; obojí je interní konstanta testovatelná přes dependency injection, ne skrytá runtime preference. `reconcileAbandonedPilotRuns` běží před založením nového runu a před retention. Run lze označit jako `abandoned` pouze tehdy, když platí vše následující:

1. není to `activeRunId` právě běžícího procesu;
2. manifest je platný, stav je `running` a jeho heartbeat překročil explicitní TTL;
3. owner hostname odpovídá lokálnímu hostu;
4. bezpečný PID probe pro owner PID prokáže, že proces už neběží.

Pak se manifest atomicky přepíše na `abandoned` s `abandonedAt`, původním ownerem a důvodem `owner-process-not-alive`. Teprve tento terminální stav je kandidátem retentionu. Chybějící PID, jiný host, čerstvý heartbeat, živý PID nebo nečitelný manifest znamenají **retain + warning**, nikdy automatické smazání. Tím se záměrně preferuje dočasně vyšší počet adresářů před rizikem smazání živého nebo neprokazatelně opuštěného běhu.

### 3.2 `packages/e2e/helpers/pilot-command.ts`

**Odpovědnost:** Jedna implementace spawn/timeout/output capture pro každý Pilot command.

Nahradí duplicitní `runPilotCommand` a `runPilotCommandCapture` jedním výsledkem:

```ts
type PilotCommandResult = {
  command: string;
  args: string[]; // redigované při persistenci
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error: string | null;
};
```

Orchestrátor rozhodne, zda non-zero výsledek vyhodí jako chybu. Store výsledek zapíše vždy — tedy i při zeleném scénáři.

### 3.3 `packages/e2e/helpers/pilot-scenario-plan.ts`

**Odpovědnost:** Přeložit celou zvolenou selekci scénářů na jeden typovaný `SelectionPlan`. Per-scenario metadata jsou jen vstup; nesmějí být výsledkem, podle kterého runner samostatně spouští neslučitelné topology.

Nezačínat 80 ručně vyplněnými metadata záznamy. Použít bezpečný default pro obyčejný izolovaný scénář a malou mapu dnešních výjimek:

```ts
type ScenarioPlan = {
  profile: "isolated" | "packaged-smoke";
  auth: "live-den" | "fixture" | "none";
  fixtures: readonly FixtureName[];
  devAutostart: "enabled" | "disabled";
  timeout: "default" | "canonical-live";
  relaunch?: "vslo-270";
  successArtifacts: readonly ("live-inference" | "session-render")[];
};

type SelectionPlan = {
  scenarios: readonly ResolvedScenarioPlan[];
  profile: "isolated" | "packaged-smoke";
  auth: "live-den" | "fixture" | "none";
  fixtures: readonly FixtureName[];
  environment: Readonly<Record<string, string>>;
  preconditions: readonly SelectionPrecondition[];
  launch: {
    devAutostart: "enabled" | "disabled";
    timeout: "default" | "canonical-live";
    relaunch?: "vslo-270";
  };
  successArtifacts: readonly SuccessArtifactName[];
};

compileSelectionPlan(selection, environment): SelectionPlan;
```

Kompilátor buď vytvoří jeden platný topology plán, nebo vrátí tentýž explicitní rejection kontrakt jako současný runner. Z per-scenario mapy se odvodí současné predicate funkce, env mutace, validace souběhu fixture, profilová izolace, relaunch i post-success artefakty. Specifické implementace fixture zůstávají v jejich současných helper souborech.

### 3.4 `packages/e2e/helpers/pilot-browser-prelude.ts`

**Odpovědnost:** Jednou po `ensurePilotReady` nainstalovat `window.__vesloPilotE2E` s opakovanými čistě browser/UI primitives:

- `waitUntil`, `withTimeout`, `invoke`;
- `visible`, `text`, `normalize`, `findVisibleButton`;
- `getComposer`, `insertContenteditableThroughBrowser`;
- `createProgressMarker`, `finishScenario`, `failScenario`;
- omezené `recentTraceSummary` bez promptů a credentialů.

Prelude se musí nainstalovat znovu i po relaunchi. Nesmí zapisovat Solid stav, volat business logiku místo uživatele ani odesílat zprávu jinak než přes skutečný Pilot `click`. Contenteditable adapter zachová současnou pravidlem vyžadovanou browser editing cestu a native click pro submit.

---

## 4. Implementační postup

### Task 1: Zavést run-store a bezpečný retention

**Files:**

- Create: `packages/e2e/helpers/pilot-run-store.ts`
- Create: `packages/e2e/helpers/pilot-run-store.test.ts`
- Modify: `packages/e2e/.gitignore`
- Modify: `packages/e2e/helpers/pilot-runner.ts`

**Steps:**

1. Vytvořit `packages/e2e/.pilot-runs/` a přidat jej do `.gitignore`.
2. Založit run context před startem app a vytvořit `run.json` se stavem `running` a owner lease (`hostname`, `pid`, `startedAt`, `heartbeatAt`).
3. Obnovovat heartbeat po lifecycle přechodech i časovačem během dlouhého Pilot commandu; normální dokončení jej atomicky nahradí terminálním stavem.
4. Před novým runem a před retention zavolat `reconcileAbandonedPilotRuns`. Stale `running` run se označí `abandoned` pouze po prošlém TTL, lokálním hostname a negativním PID probe; nejistý případ se nemaže.
5. Přesměrovat současné failure/live/render artifact collectors do `scenarios/<name>/...` pod stejný run root.
6. Po každém terminálním výsledku zavolat retention pro 10 nejnovějších terminálních runů (`passed|failed|abandoned`).
7. Mazat pouze rozpoznané adresáře s platným terminálním manifestem; aktivní, cizohostované, čerstvé, živé-PID nebo neparsovatelné adresáře ponechat a vypsat warning.
8. Před rekurzivním smazáním ověřit canonical path uvnitř `.pilot-runs/`; nikdy nemazat vypočtenou cestu bez tohoto ověření.

**Acceptance:**

- Test s 12 terminálními runy ponechá přesně 10 nejnovějších.
- Stale run s prošlým heartbeat a prokazatelně mrtvým lokálním PID se označí `abandoned` a může být promazán.
- Stale run se živým PID, cizím hostname, chybějícím PID nebo poškozeným manifestem zůstane zachovaný.
- Aktivní run, včetně právě běžícího `activeRunId`, zůstane zachovaný.
- `git status` po lokálním runu neukazuje `.pilot-runs/`.

### Task 2: Připojit app, UI, server a orchestrator logy k jednomu runu

**Files:**

- Modify: `packages/e2e/helpers/app-launcher.ts`
- Modify: `packages/e2e/helpers/app-launcher.test.ts`
- Modify: `packages/desktop/src-tauri/src/runtime_preferences.rs`
- Modify: `packages/desktop/src-tauri/src/commands/misc.rs`
- Modify: odpovídající Rust testy v `runtime_preferences.rs` a `commands/misc.rs`

**Steps:**

1. Rozšířit `StartAppOptions` o explicitní diagnostický kontext: `pilotTraceDir`, `appLogDir`, `runId` a launch sequence.
2. Launcher nebude odvozovat app log root z `OPENCODE_HOME/.veslo/e2e-logs`; použije předaný run-owned `appLogDir`.
3. Pro Pilot běh nastaví `TAURI_PILOT_LOG_DIR`, `VESLO_RUN_ID`, `VESLO_RUNTIME_TRACE_DIR`, `VESLO_RUNTIME_TRACE=1`, `VESLO_SEND_WORKFLOW_TRACE=1` a `VESLO_OPENCODE_HEALTH_DIAG=1` pouze do run-owned trace adresáře.
4. `runtime_diagnostics_env_overrides` dostane explicitní Pilot větev: pokud je přítomný platný `TAURI_PILOT_LOG_DIR`, dá sidecarům E2E diagnostic override přednost před uživatelským support-diagnostics adresářem — i když preference normálně diagnostiku vypíná.
5. `log_ui_event` dovolí send-workflow trace pro explicitní Pilot log dir; běžné non-Pilot chování a uživatelská preference zůstanou beze změny.
6. Zachovat oddělení `launch-01` a `launch-02` pro relaunch, ale trace streamy agregovat pouze v rámci stejného runu.

**Acceptance:**

- Canonical live run obsahuje v jednom run rootu UI, server, orchestrator, runtime trace a app stdout/stderr.
- User support diagnostics mimo Pilot nezmění chování.
- `vslo-270` relaunch vytvoří druhý pár app logů, nikoli nový globální root.

### Task 3: Sjednotit Pilot command execution a persistovat každý scénář

**Files:**

- Create: `packages/e2e/helpers/pilot-command.ts`
- Create: `packages/e2e/helpers/pilot-command.test.ts`
- Modify: `packages/e2e/helpers/pilot-runner.ts`
- Modify: `packages/e2e/helpers/pilot-runner.test.ts`

**Steps:**

1. Vyčlenit jediný capture/spawn/timeout mechanismus.
2. Předat každý výsledek run-store; redigovat stdout/stderr a argumenty před persistencí.
3. Pro `tauri-pilot run` doplnit `--junit <scenarioDir>/pilot.junit.xml`.
4. JUnit před uložením projít stejnou redakční hranicí, protože failure output může obsahovat citlivý text.
5. Failure collector rozšířit, nezdvojovat: uloží detail do `scenarios/<name>/failure/` a naváže jej na již existující `result.json`.
6. Success collectors uloží summary do `scenarios/<name>/success/`.

**Acceptance:**

- Každý zelený i červený scénář má `result.json`, stdout/stderr a JUnit.
- Timeout obsahuje duration, signal, exit state a první příčinný transition v manifestu.
- Eval script se nikdy neobjeví v plain textu command metadata.

### Task 4: Charakterizovat současnou policy a kompilovat jeden `SelectionPlan`

**Files:**

- Create: `packages/e2e/helpers/pilot-scenario-plan.ts`
- Create: `packages/e2e/helpers/pilot-scenario-plan.test.ts`
- Create: `packages/e2e/helpers/pilot-selection-contract.test.ts`
- Create: `packages/e2e/helpers/__fixtures__/pilot-selection-contract.v1.json`
- Modify: `packages/e2e/helpers/pilot-runner.ts`
- Modify: `packages/e2e/helpers/pilot-runner.test.ts`

**Steps:**

1. Než se smaže jediná dnešní `scenarioSelection...` větev, přidat čistý characterization adapter, který ze současné policy vytvoří serializovatelný legacy selection contract.
2. Contract pro každou vstupní selekci musí zachytit: scénáře, profile mode, auth mode, fixture lifecycle, všechny výsledné env mutace, preconditions/profile isolation, dev autostart, timeout class, relaunch a success artifact hooks — včetně důvodu zamítnutí neplatné selekce.
3. Vygenerovat reviewable fixture `pilot-selection-contract.v1.json` z kontrolovaného baseline environmentu. Regenerace fixture smí být pouze explicitní update krok, ne vedlejší efekt testu.
4. Characterization matrix musí zahrnout každý pojmenovaný suite, každý TOML scénář zvolený samostatně a explicitní multi-scenario případy současných isolation/rejection pravidel: managed-AI fixture, model-stream retry, session queue, packaged smoke, live auth a VSLO-270 relaunch.
5. Přenést suite membership a aktuální výjimky do typed mapy/defaultů a implementovat `compileSelectionPlan`.
6. V testu porovnat nový `SelectionPlan` s legacy contractem i s checked-in fixture; pro neplatné kombinace porovnávat stabilní error/rejection code, ne text náhodné chyby.
7. Teprve po zelené matici nahradit staré `endsWith` predicate funkce. `pilot-runner.ts` zůstane orchestrace: resolve → compile selection plan → start fixtures → launch → run → cleanup.
8. Validovat, že každé suite jméno ukazuje na existující TOML a že nová kombinace nemůže mlčky získat konfliktující fixture/profile topology.

**Acceptance:**

- Každý suite i každý jednotlivě zvolený TOML má v characterization matrix explicitní očekávaný `SelectionPlan` nebo očekávaný rejection code.
- Vyjmenované multi-scenario kombinace mají stejný accept/reject výsledek jako před refaktorem.
- Stávající live-inference, packaged-smoke, session queue a VSLO-270 policy testy zůstávají zelené.
- Přidání nového scénáře vyžaduje maximálně suite entry plus jednu výjimku, je-li skutečně nestandardní; jeho selection contract se ale musí objevit v matrix.

### Task 5: Vyvést browser primitives a migrovat jen reprezentativní scénáře

**Files:**

- Create: `packages/e2e/helpers/pilot-browser-prelude.ts`
- Create: `packages/e2e/helpers/pilot-browser-prelude.test.ts`
- Modify: `packages/e2e/helpers/pilot-runner.ts`
- Modify: `packages/e2e/pilot-scenarios/message-send-registry-degraded.toml`
- Modify: `packages/e2e/pilot-scenarios/live-skills-finder-roundtrip.toml`
- Modify: `packages/e2e/pilot-scenarios/session-run-truthfulness.toml`

**Steps:**

1. Po readiness installovat prelude přes jednu Pilot `eval` operaci.
2. Přenést pouze skutečně opakované primitives; specifická testovací business logika zůstane explicitně ve scénáři.
3. Zachovat hidden diagnostic markery, ale standardizovat jejich formát a bounded failure payload.
4. Ověřit parse prelude a znovuinstalaci po relaunchi.
5. Migrovat pouze tři vybrané scénáře a porovnat jejich výsledný UI kontrakt před dalším rozšiřováním.

**Acceptance:**

- Žádný helper neobchází skutečný UI submit.
- Scénáře jsou kratší o duplicitní wait/invoke/progress infrastrukturu, ale stále čitelné jako uživatelský flow.
- Canonical live auth a headers používají stejnou běžnou desktopovou cestu jako dnes.

### Task 6: Zdokumentovat nový artifact kontrakt a provést explicitní legacy úklid pouze na vyžádání

**Files:**

- Modify: `docs/testing/tauri-pilot/README.md`
- Modify: `packages/e2e/.gitignore`
- Optional Create: explicitní maintenance script pouze pokud bude legacy cleanup požadován

**Steps:**

1. Dokumentovat přesnou strukturu run adresáře, retention 10, stale-run lease/TTL pravidla a kde hledat první selhaný transition.
2. Zdokumentovat privacy contract: auth source/přítomnost headers ano, hodnoty credentialů ne.
3. Zdokumentovat, že `SelectionPlan` je kontrakt celé selekce a že každá nestandardní kombinace musí být přidána do characterization matrix.
4. Označit `tauri-pilot-failures/` a `tauri-pilot-artifacts/` za legacy roots; nemazat je automaticky při prvním release.
5. Pokud bude chtěn úklid, přidat explicitní příkaz s dry-run, nikoli skryté mazání při normálním test runu.

---

## 5. Bezpečnostní kontrakt logování

1. Runner a Pilot output musí projít redakcí před zápisem.
2. App stdout/stderr se nesmí zapisovat jako neomezený raw dump do perzistentního run archivu bez alespoň line-buffered redakce.
3. Structured trace producer má logovat whitelist polí: IDs, event, timestamp, duration, status, error code/classification, boolean readiness a hash/maskovaný subject. Ne hodnoty `authorization`, `token`, `cookie`, `secret`, `password`, `apiKey`, request `headers`, `body`, `content` nebo prompt.
4. Redakční testy musí pokrýt JSON, běžný text, `Bearer ...`, query parametr tokenu, XML/JUnit a rozdělený app-log stream.
5. Logování je test-only observability. Nesmí měnit provider selection, session state, auth nebo click path.

---

## 6. Ověření po implementaci

1. Typecheck a focused Node testy pro nové helper moduly.
2. Unit test retentionu s 12 terminálními runy, jedním právě aktivním runem, stale runem s mrtvým PID, stale runem se živým PID, cizím hostname a poškozeným manifestem.
3. Characterization matrix porovná legacy a nový `SelectionPlan` pro každý suite, každý samostatný scénář a explicitní multi-scenario isolation/rejection případy.
4. Focused scénáře:
   - `message-send-registry-degraded` s ostrou auth;
   - `live-skills-finder-roundtrip`;
   - `session-run-truthfulness`;
   - `vslo-270-stop-reload-reconnect` kvůli relaunch logům.
5. Ověřit, že každý run obsahuje manifest, runner timeline, scenario výsledky a očekávané trace streamy.
6. Spustit redaction scan nad vytvořeným run rootem s testovacími sentinel tokeny; žádný nesmí zůstat v souborech.
7. Zkontrolovat `git status --short`: nový artifact root musí zůstat ignorovaný a žádný legacy cleanup nesmí proběhnout bez explicitního příkazu.

---

## 7. Rozhodnutí, která zůstávají vědomě mimo první změnu

- Nevynucovat globální byte cap na každý stream v první verzi. Retention 10 řeší požadované meziběhové bobtnání bez ztráty důkazu z dlouhého incidentu; `run.json` má alespoň evidovat velikost streamů pro pozdější rozhodnutí.
- Nemigrovat všechny velké TOML scénáře najednou. Po třech reprezentativních migracích rozhodnout podle reálné redukce duplicity a stability.
- Nezavádět široký native E2E IPC command. Pokud se později objeví oprávněná potřeba nativního helperu, musí být debug/E2E-only a samostatně capability-scoped.
