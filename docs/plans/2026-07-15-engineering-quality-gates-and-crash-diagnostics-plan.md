---
title: KISS engineering quality gates and crash diagnostics implementation plan
date: 2026-07-15
target: veslo-main developer workflow, required CI, one desktop recovery smoke, and release crash diagnostics
status: ready-for-implementation
done: false
base_branch: main
base_commit: 0029edef42817b1a889fb3f83b458137e61672fc
baseline_worktree: dirty
---

# KISS quality gates a crash diagnostika — implementační plán

## Cíl

Zavést nejmenší sadu kontrol, která zabrání nejčastějším falešně zeleným
změnám od lidí i AI agentů a současně udělá produkční pád dohledatelný.

Po implementaci musí platit:

- existuje jeden běžný lokální příkaz `pnpm check`;
- stejný kontrakt je required GitHub status pro `main` i `dev`;
- žádný first-party TypeScript workspace není mimo typecheck;
- JS/TS async a Solid chyby zachytí type-aware lint, ne jen formatter;
- Rust má povinný format a Clippy;
- jeden skutečný Tauri test ověří bootstrap, send, neočekávaný child exit,
  recovery a cleanup;
- GlitchTip ukáže původní TS/TSX nebo symbolizovaný native frame a skutečně
  odešle alert.

Tento plán nezavádí nový build systém, test framework ani monitoring backend.

## Proč pouze těchto pět kroků

Veslo už má velké množství testů, Tauri Pilot, Knip, Madge, vlastní audity,
packaged smoke, release verifikátory, GlitchTip a debug-log spool. Hlavní problém
není absence nástrojů, ale to, že netvoří jeden povinný a pravdivý kontrakt.

Nejvyšší leverage proto mají pouze:

1. čistá baseline;
2. formatter + type-aware lint + repo-wide typecheck + Rust statika;
3. jeden required gate;
4. jeden desktop recovery smoke;
5. symbolizovaná produkční chyba a alert.

Všechno ostatní je v první implementaci explicitně odloženo.

## Ověřená baseline k 2026-07-15

Baseline byla změřena v `veslo-main` na commitu uvedeném ve front matter, ale
nad rozpracovaným worktree. Před opravami se musí zopakovat nad čistým
integrovaným commitem.

| Kontrola | Aktuální výsledek |
| --- | --- |
| root `pnpm typecheck` | zelený, ale kontroluje pouze app package |
| app/server/orchestrator/router typecheck | jednotlivě zelené |
| E2E `tsc --noEmit` | červený na driftu AI Gateway fixture kontraktů |
| app broad unit suite | více selhání, včetně křehkých source-regex testů |
| `cargo fmt --check` | červený v rozpracovaných Rust souborech |
| import-boundary audit | jeden cross-owner E2E -> AI Gateway import |
| cycle audit | zelený pro definované ownery |
| route audit | hard checks zelené; warning/info zůstávají reportem |
| strict Knip | červený na unused files/dependencies a unlisted binary |
| GlitchTip SDK | browser i Rust inicializace existuje |
| source maps/native symbols | upload gate v repu chybí |

Tato červená místa se nesmí skrýt baselinem nebo `continue-on-error`. Nejdřív
se opraví nebo přesně klasifikují, potom se zapne required gate.

## Pevná KISS rozhodnutí

### Tři veřejné příkazy

| Příkaz | Účel |
| --- | --- |
| `pnpm check` | všechny povinné non-desktop kontroly pro běžný PR |
| `pnpm check:desktop` | existující Tauri Pilot current-gate + jeden recovery smoke |
| `pnpm check:release` | existující release review, packaged/final-artifact gates a monitoring canary |

Package-specific příkazy mohou zůstat pro rychlé ladění. Nesmí být prezentovány
jako náhrada `pnpm check` před handoffem.

### Jedna autorita pro každou vrstvu

- Format: Biome.
- JS/TS correctness: ESLint flat config s type-aware `typescript-eslint` a
  Solid pravidly.
- Type correctness: `tsc --noEmit` v každém first-party TS workspace.
- Rust: rustfmt + Clippy.
- Desktop behavior: Tauri Pilot.
- Produkční chyby: existující GlitchTip + debug-log pipeline.
- Merge: jeden stabilní required aggregate GitHub status.

### První verze vždy kontroluje celý scope

První implementace nebude obsahovat changed-file graph, dependent selection,
path-based skipy ani vlastní baseline engine. Full non-desktop check je
jednodušší a nemůže omylem vynechat konzumenta.

Jestli bude později příliš pomalý, nejdřív se změří cache a paralelizace.
Affected optimalizace smí přijít až jako samostatný plán a musí se po přechodnou
dobu porovnávat s full runem.

### Co smí a nesmí být required

Required od první verze:

- format check;
- ESLint;
- typecheck všech TS workspace;
- app/server/service/unit contract suites zahrnuté v `pnpm check`;
- rustfmt a Clippy;
- import boundaries, cycles, route hard checks a po vyčištění strict Knip.

Non-blocking report:

- owner hotspots;
- fallback inventory;
- client-logic heuristiky;
- workflow-surface heuristiky;
- route warnings/info;
- globální coverage procento.

## Implementační kroky

### QG00 — Uzavřít dnešní červenou baseline (P0)

done: false

1. Zopakovat baseline nad čistým integrovaným commitem.
2. Opravit E2E type drift, Rust format a cross-owner import.
3. Broad app unit failures rozdělit na:

   - skutečný behavior/contract defect;
   - stale test;
   - křehký source-regex architecture test.

4. Behavior failure se nesmí „opravit“ změnou regexu. Source-text testy
   používat pouze pro stabilní zakázané importy/symboly; lifecycle chování
   převést na importovatelný model nebo skutečný runtime test.
5. Strict Knip findings odstranit nebo přesně nakonfigurovat. Globální ignore a
   `--no-exit-code` nejsou řešení.
6. Změřit studený a teplý čas budoucích kroků. Čas je zatím metrika, ne důvod
   kontrolu vynechat.

Akceptace:

- všechny budoucí required kroky jsou dvakrát po sobě zelené na čistém checkoutu;
- žádný test/type/lint failure není označen jako známý povolený baseline;
- u každého odstraněného Knip findingu je jasné, zda šlo o dead code nebo
  přesnou tool konfiguraci;
- žádný cizí proces ani rozpracovaný worktree není během ověření změněn.

### QG01 — Přidat minimální statickou ochranu (P0)

done: false

#### Biome pouze jako formatter

1. Přidat pinned Biome a root config.
2. Formátovat first-party JS/TS/TSX/JSON/CSS.
3. Ignorovat generated, vendored a runtime artefakty (`node_modules`, `dist`,
   Cargo `target`, `.tmp-*`, Pilot profiles, sidecar payloady a vendored Chrome
   MCP package).
4. `pnpm format:check` nikdy nezapisuje; `pnpm format:fix` zapisuje explicitně.
5. První full format provést v samostatném mechanickém PR bez behavior změn.

#### ESLint pouze jako correctness lint

1. Přidat flat `eslint.config.mjs` s:

   - `typescript-eslint` `recommendedTypeChecked`;
   - `parserOptions.projectService: true`;
   - Solid-specific correctness pravidly;
   - `reportUnusedDisableDirectives` jako error;
   - úzkými overrides pro JS/config/test soubory;
   - žádnými stylistickými pravidly překrývajícími Biome.

2. Povinně zachytit alespoň:

   - floating promises;
   - misused promises;
   - unsafe call/assignment/member access na runtime hranicích;
   - await nad ne-promise hodnotou;
   - Solid reactive/JSX chyby;
   - nevyužité lint-disable komentáře.

#### Repo-wide typecheck

1. Přidat explicitní non-emitting `typecheck` do každého first-party TS
   workspace, minimálně app, E2E, server, orchestrator, OpenCode router, web,
   landing, Den, AI Gateway a worker manager.
2. Root `typecheck` se změní na `typecheck:all`; nesmí dál kontrolovat jen app.
3. Přidat jednoduchý contract test, že nový first-party TS workspace bez
   `typecheck` scriptu shodí kontrolu. Nepoužívat `--if-present` jako důkaz
   pokrytí.

#### Rust

1. Přidat `cargo fmt --all -- --check`.
2. Přidat `cargo clippy --all-targets --all-features -- -D warnings`.
3. Clippy výjimka musí být lokální a komentovaná; broad crate-wide allow není
   akceptace.
4. Windows CI musí alespoň zkompilovat Windows-only `cfg` větve.

Akceptace:

- druhý formatter běh vytvoří nulový diff;
- úmyslná floating promise, Solid violation, E2E type drift a Rust warning
  každá shodí odpovídající příkaz s cestou a řádkem;
- CI nepoužívá `--fix` ani `--write`;
- žádný first-party TS workspace není tichý skip;
- vendored/generated obsah není přeformátován.

### QG02 — Jeden `pnpm check` a required CI status (P0)

done: false

Přidat malý cross-platform Node runner, například
`scripts/quality-check.mjs`. Runner pouze skládá existující příkazy; neobsahuje
vlastní lint, test selection ani build graph.

`pnpm check` spustí:

1. `format:check`;
2. ESLint;
3. `typecheck:all`;
4. explicitní seznam first-party unit/contract suites;
5. rustfmt + Clippy;
6. import boundaries;
7. cycles;
8. route hard checks;
9. strict Knip.

Nezávislé kroky mohou běžet s omezenou paralelizací. Seznam kroků zůstává
statický a čitelný.

Runner musí:

- fungovat na Windows, macOS a Linux;
- na konci vypsat `step / status / duration / command`;
- zachovat plný log chybového kroku;
- vrátit `1` při kterémkoli required failure;
- rozlišit failure a infra timeout, ale obojí ponechat červené;
- failnout, pokud povinný target našel 0 testů;
- při Ctrl+C/timeout ukončit pouze vlastní child procesy;
- volitelně uložit redigovaný JSON summary bez secrets, promptů a raw user paths;
- mít unit testy pro success, failure, timeout, zero-tests, cleanup a redakci.

CI:

1. Vytvořit paralelní jobs `Quality / Static`, `Quality / Unit` a
   `Quality / Rust`.
2. Přidat stabilní aggregate status `Quality / Gate`, který je zelený pouze,
   když projdou všechny required jobs.
3. Spouštět na PR i push pro `main` a `dev`.
4. Používat frozen lockfile, pinned toolchain, job timeout a
   `concurrency.cancel-in-progress: true`.
5. Při failure nahrát redigovaný summary a relevantní test logy.
6. YAML pouze volá repo příkazy; nekopíruje jejich implementaci.
7. V branch protection/ruleset nastavit `Quality / Gate` jako required pro obě
   aktivní integrační větve. Bez ověřeného rulesetu není QG02 hotové.
8. Aktualizovat `AGENTS.md` a testing playbook: běžný handoff končí
   `pnpm check`; užší zelený test jej nenahrazuje.

Akceptace:

- stejná záměrná lint/type/test/Rust/import chyba failne lokálně i v CI;
- lokální a CI výstup používají stejné step IDs a reprodukční příkazy;
- žádný required job nemá `continue-on-error`;
- nový commit zruší starý CI run stejného PR;
- docs-only nebo malý diff může být zpočátku pomalejší, ale nikdy nevynechá
  konzumenta kvůli chybnému path mappingu;
- PR nelze mergnout po `--no-verify` nebo ručním tvrzení „tests pass“.

### QG03 — Jeden skutečný desktop recovery smoke (P1)

done: false

Nepřidávat obecný fault-injection framework. Přidat jeden deterministický Tauri
Pilot scénář za existující E2E build guard.

Scénář používá fresh izolovaný profil a ověří:

1. desktop bootstrap dosáhne ready;
2. vytvoření/otevření workspace;
3. první send dostane deterministickou odpověď;
4. test ukončí pouze desktop-owned Veslo server child po ready;
5. aplikace ukáže actionable failure/recovery stav místo tichého zamrznutí;
6. explicitní retry/reopen obnoví ready a další send projde;
7. shutdown uklidí pouze procesy a temp data vytvořená scénářem.

Pravidla:

- fault injection není dostupná v produkčním MSI;
- test má bounded timeouty a `finally` cleanup;
- před kill operací ověří PID, executable a ownership marker;
- success vyžaduje, že send i kill/recovery skutečně proběhly;
- failure artifact obsahuje screenshot, Pilot trace, bootstrap diagnostics,
  child stdout/stderr tail a cleanup summary;
- browser-only test není náhrada.

`pnpm check:desktop` zavolá existující Tauri Pilot current-gate a tento recovery
scénář. Spustí se na desktop/runtime PR a před releasem; první verze nemusí mít
vlastní affected selector — CI scope může být explicitní workflow/label
rozhodnutí, dokud full runtime lane zůstává bezpečná.

Akceptace:

- úmyslný owned-child exit vytvoří jednoznačný pozorovaný stav;
- aplikace se obnoví bez restartu celého test runneru nebo test skončí jasným
  podporovaným recovery kontraktem;
- po success i failure nezůstane osiřelý Veslo test proces;
- stejný scénář projde dvakrát za sebou s fresh profilem;
- production build neobsahuje fault-injection capability.

### QG04 — Symbolizovaná chyba a fungující alert (P1)

done: false

Rozšířit existující GlitchTip integraci. Nevytvářet nový error backend ani nový
log store.

1. Frontend release build generuje hidden source maps.
2. Release helper použije oficiální `glitchtip-cli` pro:

   - inject debug IDs;
   - upload frontend source maps;
   - upload PDB/dSYM/debug files pro native část, pokud platforma artefakt
     poskytuje.

3. Frontend pořadí musí být přesně:

   `poslední Vite build -> inject -> upload -> odstranit .map -> Tauri bundle`.

   Po injectu nesmí následovat další implicitní frontend rebuild. Release gate
   ověří, že zabalené JS assets odpovídají injectnutým assets a installer
   neobsahuje `.map` soubory.

4. Browser i native SDK používají shodný release/commit/environment a
   low-cardinality platform/component tags.
5. Top-level Solid ErrorBoundary zachytí render crash přes existující reporter
   a zobrazí bezpečnou recovery obrazovku s krátkým incident ID.
6. Neočekávaný owned child exit emituje přes existující diagnostics pipeline
   pouze redigované fields: component, lifecycle phase, exit code/signal,
   expected/unexpected, release/platform a incident ID.
7. Staging canary bezpečně vyvolá kontrolovanou frontend chybu a native test
   error bez produkční debug route. Přes GlitchTip API ověří:

   - event dorazil;
   - release/environment/platform sedí;
   - frontend frame ukazuje původní TS/TSX soubor a řádek;
   - native frame je symbolizovaný nebo má explicitní platformní blocker;
   - payload neobsahuje token, prompt, raw file content ani user path.

8. Nastavit alert na nový fatal issue a opakovaný crash stejného release.
   Projít jeden cvičný incident až k ownerovi.
9. Publish workflow failne, pokud je monitoring required a upload/canary chybí.
   Ad-hoc build může zůstat warning-only stejně jako dnešní DSN env gate.

Akceptace:

- staging frontend crash je v GlitchTip čitelný v původním TS/TSX zdroji;
- native canary má symbolizovaný owned frame nebo konkrétní zdokumentovaný
  platformní blocker;
- render crash ukáže recovery UI a incident ID;
- incident ID je dohledatelný v existující debug-log pipeline bez citlivých dat;
- alert skutečně dorazí zvolenému ownerovi;
- release bez required upload/canary výsledku nepublikuje.

## Explicitně odložené věci

Tyto nápady mohou být užitečné, ale nejsou součástí tohoto plánu:

- changed-file/dependent graph a path-based CI selection;
- obecný baseline/ratchet engine pro heuristické audity;
- Lefthook nebo jiný Git hook manager;
- `pnpm doctor`;
- dependency bot, CodeQL a nový security workflow;
- mutation testing a coverage threshold;
- nightly trend dashboard;
- automatické vytváření issues;
- automatické vyhodnocování `done: true` v plánech;
- široká fault-injection matice;
- nový logger, telemetry backend nebo runtime state store.

Odložená věc se nesmí nenápadně přidat do některého QG kroku. Potřebuje vlastní
důkaz problému a samostatné schválení scope.

## Ověřovací matice

Po implementaci musí být veřejná cesta:

```powershell
pnpm install --frozen-lockfile
pnpm check

# Po desktop runtime preflightu z testing playbooku:
pnpm check:desktop

# Pouze pro release změny:
pnpm check:release
```

Při diagnostice může summary odkázat na menší package-specific command, ale
závěrečný handoff znovu používá odpovídající veřejný příkaz.

## Doporučené PR řezy

1. **PR A — baseline repair:** QG00, bez nových toolů a bez mass formatu.
2. **PR B — static guardrails:** QG01 config a typecheck scripts; mechanický
   full format jako samostatný commit nebo samostatný PR.
3. **PR C — one gate:** QG02 runner, CI, ruleset a canonical docs.
4. **PR D — desktop recovery:** QG03 jeden Pilot scénář a artifacts.
5. **PR E — actionable crashes:** QG04 source maps, native symbols, canary a
   alert.

PR B a PR C se nesmí spojit, pokud by review současně obsahovalo mass format,
novou lint policy a CI enforcement.

## Stop rules

Implementace se zastaví a návrh se opraví, pokud:

1. `pnpm check` může přeskočit first-party workspace bez explicitní chyby;
2. known baseline dovolí červený type/test/lint/Rust gate;
3. CI a lokální runner spouštějí jiný seznam required kroků;
4. required CI používá path mapping před ověřením proti full runu;
5. CI auto-fixuje checkout;
6. test cleanup může ukončit cizí proces;
7. fault injection pronikne do production buildu;
8. summary nebo monitoring payload obsahuje secret, prompt nebo raw user data;
9. source-only test je prezentován jako packaged desktop důkaz;
10. source maps patří jinému JS buildu než installer payload.

## Completion rules

Celkový `done: true` je povolen pouze když:

- QG00–QG04 mají `done: true` a vlastní akceptační důkaz;
- `pnpm check`, `pnpm check:desktop` a `pnpm check:release` jsou dokumentované;
- `Quality / Gate` je reálně required pro `main` i `dev`;
- žádný first-party TS workspace není mimo typecheck;
- type-aware ESLint, rustfmt, Clippy a tvrdé architecture audity jsou required;
- desktop recovery smoke dvakrát projde a nezanechá procesy;
- GlitchTip canary má symbolizovaný frame a alert dorazí ownerovi;
- canonical `docs/dev` a agent instrukce odpovídají implementovanému stavu;
- čistý checkout projde finální maticí bez baseline výjimek.

P2 nápady z odloženého seznamu nejsou podmínkou dokončení tohoto plánu.
