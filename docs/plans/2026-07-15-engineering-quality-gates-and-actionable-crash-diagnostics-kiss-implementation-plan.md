---
title: Veslo engineering quality gates and actionable crash diagnostics — highest-leverage KISS implementation plan
date: 2026-07-15
target: veslo-main non-desktop quality gate, required CI, focused desktop recovery proof, and actionable frontend crashes
status: ready-for-implementation
done: false
base_branch: main
base_commit: 0029edef42817b1a889fb3f83b458137e61672fc
baseline_worktree: dirty
supersedes:
  - docs/plans/2026-07-15-engineering-quality-gates-and-crash-diagnostics-plan.md
  - docs/plans/2026-07-15-engineering-quality-gates-and-crash-prevention-implementation-plan.md
---

# Veslo quality gates a použitelná crash diagnostika — KISS implementační plán

## Cíl

Zavést nejmenší sadu změn, která přinese čtyři praktické výsledky:

1. běžný handoff končí jedním pravdivým příkazem `pnpm check`;
2. stejný kontrakt blokuje merge do `main` i `dev` přes jeden stabilní status;
3. existující Tauri recovery důkaz se stane pravidelným required testem;
4. frontendový produkční crash ukáže původní TS/TSX frame a pošle reálný alert.

Úspěšná cesta má být krátká:

```text
defekt -> červený check nebo alert -> konkrétní reprodukce -> konkrétní owner
```

Tento plán nepřidává nový build systém, nový test framework, druhý monitoring
backend ani obecný task runner.

## Výsledné KISS rozhodnutí

### Co skutečně zavádíme

- explicitní typecheck každého workspace s vlastním `tsconfig.json`;
- úzký type-aware ESLint pro async a Solid correctness, bez stylistických rules;
- rustfmt, Clippy a Rust testy jako required checks;
- existující high-signal import, cycle, route-hard a Veslo-header audity;
- explicitní seznam stabilních unit/contract suites;
- jeden root příkaz `pnpm check` složený z obyčejných package scripts;
- jeden required GitHub aggregate status `Quality / Gate` pro `main` i `dev`;
- existující `vslo-235-local-host-child-exit` jako focused desktop recovery gate;
- hidden frontend source maps, upload z posledního Vite buildu, top-level Solid
  ErrorBoundary, staging canary a jeden prokázaný alert drill.

### Co v prvním rolloutu nezavádíme

- Biome ani jiný nový JS/TS formatter;
- mass-format repozitáře;
- strict Knip jako merge blocker;
- owner/fallback/client-logic/workflow heuristiky jako correctness gate;
- vlastní Node orchestration runner, task DSL, cache, daemon nebo JSON reportér;
- changed-file dependency graph ani path-based skipy required gate;
- nový fault-injection framework nebo nový child-kill command;
- celý Tauri Pilot `current-gate` na každém PR;
- automatické GlitchTip API polling/retry workflow při každém releasu;
- jednotné incident ID napříč renderer crashem a každým child lifecycle eventem;
- PDB/dSYM/ELF symbol pipeline v tomto rolloutu.

Tyto body nejsou odmítnuté navždy. Nejsou ale podmínkou prvního fungujícího
engineering kontraktu a nesmí se nenápadně přidat do některé fáze níže.

## Proč je tato varianta menší než oba vstupní plány

1. **Formatter není crash-prevention nástroj.** Rust format už existuje v
   toolchainu a bude required. Přidání Biome by přineslo dependency, config a
   velký mechanický diff dřív, než repo získá chybějící correctness gate.
2. **Package scripts stačí.** GitHub Actions už měří čas a drží log každého
   kroku. Vlastní process runner s timeouty, redakcí, child cleanupem a JSON
   souhrnem by byl nový subsystém bez důkazu, že je potřeba.
3. **Knip dnes reprezentuje dluh, ne regresi.** Aktuálně hlásí desítky findings.
   Je užitečný jako report, ale required režim by vedl k broad ignore nebo k
   nesouvisejícímu cleanup PR.
4. **Recovery fault injection už existuje.** Debug+E2E gated command i focused
   Tauri Pilot scénář jsou implementované. Největší leverage je dát existující
   důkaz do pravidelného CI, ne vytvořit další framework.
5. **Frontend symbolizace má nejrychlejší produkční návratnost.** Většina
   aplikační logiky je TS/TSX a browser SDK už existuje. Native symboly jsou
   samostatný release-artifact projekt a přijdou až po změření zbývajícího
   native diagnostického gapu.

## Ověřená baseline k 2026-07-15

Baseline byla znovu částečně reprodukována na commitu z front matter, ale nad
rozpracovaným worktree. Nejde tedy o tvrzení, že stejné chyby obsahuje čistý
base commit.

| Surface | Aktuální stav |
| --- | --- |
| root `pnpm typecheck` | kontroluje pouze `packages/app` |
| TS workspace coverage | 10 workspace mají `tsconfig.json`, 6 z nich nemá `typecheck` script |
| E2E direct typecheck | fail: drift capability verifieru a AI access repository fixture |
| landing direct typecheck | fail: chybějící CSS import declaration |
| web direct typecheck | fail: response body typ a CSS import declaration |
| AI Gateway / Den / worker manager direct typecheck | pass |
| import boundaries | fail: E2E přímo importuje AI Gateway owner internals |
| route audit | hard checks pass; 6 warning a 83 info položek jsou report |
| cycle audit | pass pro všech 7 definovaných ownerů |
| strict Knip | fail: 18 files, 17 dependencies, 6 devDependencies, 1 binary |
| Veslo header audit | fail: 12 review-required literals |
| Rust format | fail na rozpracovaných desktop Rust souborech |
| desktop recovery | E2E-only child-kill command a focused VSLO-235 scénář už existují |
| GlitchTip browser/native init | existuje, včetně release env verifikace |
| source maps | Vite build je negeneruje ani neuploaduje |
| renderer boundary | root render nemá top-level Solid ErrorBoundary |
| CI branches | hlavní CI/E2E workflows cílí pouze na `dev` |

## Veřejný kontrakt po implementaci

První rollout přidá pouze dva nové veřejné příkazy:

| Příkaz | Obsah | Kdy se používá |
| --- | --- | --- |
| `pnpm check` | lint, všechny typechecky, stabilní unit/contract suites, Rust statika/testy a hard architecture audity | každý běžný handoff a required CI |
| `pnpm check:desktop-recovery` | existující focused Tauri E2E child-exit/restart scénář nad fresh profilem | required desktop lane |

Release workflow si ponechá dnešní `pnpm release:review` a existující packaged/MSI
verifikátory. Nevytvářet třetí alias, který by jen přejmenoval už zavedený release
kontrakt.

`pnpm check` je full-scope a fail-fast. Nemusí kreslit vlastní tabulku ani ukládat
JSON. Chybový package command je přímo reprodukční příkaz a CI kroky drží duration
i plný log.

## Implementační surface mapa

| Fáze | Hlavní owner surfaces |
| --- | --- |
| QG00 | root a workspace `package.json`, existující workspace `tsconfig.json`, E2E managed-AI fixture, owner-owned header constants, desktop Rust source |
| QG01 | root `package.json`, nový `eslint.config.mjs`, malý `scripts/check-typecheck-coverage.mjs`, desktop Cargo manifest/toolchain pin |
| QG02 | nový `.github/workflows/quality.yml`, root quality scripts, `AGENTS.md`, canonical testing docs |
| QG03 | existující VSLO-235 child-exit TOML, E2E package/root scripts, quality workflow; native kill command se nemění |
| QG04 | app Vite config, app root entry, existing error-monitoring owner, Tauri `beforeBuildCommand`, release helper/workflows a monitoring runbook |

Existující build/release workflows mimo tyto surfaces se nemají plošně
přepisovat. Nový quality workflow nenahrazuje dnešní binary, packaged nebo MSI
release verifikaci.

## Gate klasifikace

| Kontrola | První rollout |
| --- | --- |
| type-aware ESLint + Solid correctness | required |
| všechny workspace typechecky | required |
| stabilní unit/contract suites | required |
| rustfmt, Clippy, Rust tests | required |
| import boundaries | required, zero violations |
| cycles | required, zero cycles a zero-file guard |
| route contracts | required pouze dnešní hard errors |
| Veslo header audit | required po úzkém QG00 cleanupu |
| route warning/info inventory | report-only |
| strict Knip | report-only |
| unused exports | report-only |
| owner/fallback/client/workflow heuristiky | report-only |
| globální coverage procento | nezavádět |

Report-only command může běžet scheduled nebo ručně. Nesmí být součástí
`Quality / Gate` a nesmí být prezentovaný jako correctness success.

## Implementační fáze

### QG00 — Udělat baseline pravdivou a zelenou (P0)

done: false

Nejdřív pracovat v čistém checkoutu integrovaného commitu. Současný dirty
worktree nepoužívat jako důkaz base branch a nepřepisovat v něm rozpracované
release/MSI změny.

#### Změny

1. Přidat explicitní non-writing `typecheck` do šesti TS workspaces, kde chybí:
   E2E, landing, web, AI Gateway, Den a worker manager.
2. Opravit skutečné direct-`tsc` nálezy:
   - E2E fixture musí implementovat aktuální veřejný capability/repository
     kontrakt;
   - landing/web musí mít legitimní CSS module/import typing;
   - web response body musí odpovídat podporovanému `BodyInit` kontraktu.
3. Odstranit E2E -> AI Gateway relative import. Fixture smí použít veřejný
   test-support export nebo vlastní strukturální test double, ne owner internals.
4. Spustit rustfmt nad dotčenými Rust soubory. Nemíchat s behavior změnami.
5. U 12 header findings rozhodnout pouze mezi:
   - importem owner-owned konstanty;
   - úzkou, komentovanou legitimní boundary deklarací.

   Broad allowlist nebo regenerovaný snapshot není akceptace.
6. Spustit budoucí required unit/contract suites a opravit jen skutečné defecty,
   stale testy nebo prokazatelně křehké source-regex testy. Behavior failure se
   nesmí zazelenat rozšířením regexu.
7. U každého kroku zaznamenat command a studený/teplý čas. Čas je metrika, ne
   důvod pro skip.

#### Akceptace

- dva po sobě jdoucí full baseline runy projdou na čistém checkoutu;
- všech 10 TS workspaces projde vlastním `typecheck` s `--noEmit` nebo
  ekvivalentním non-writing režimem;
- import a Veslo-header audit mají nula hard violations;
- rustfmt je idempotentní;
- strict Knip zůstává viditelný report a neblokuje QG00;
- nevznikne known-failure baseline, broad ignore ani `continue-on-error`.

### QG01 — Jeden malý `pnpm check` (P0)

done: false

#### Typecheck coverage guard

Přidat malý script, který přes pnpm workspace inventory ověří:

1. každý workspace s root `tsconfig.json` má `typecheck` script;
2. script není write/build alias vydávaný za typecheck;
3. inventory nenašel nula workspaces.

Potom spustit workspace `typecheck` scripts. Script nekonstruuje dependency graph,
neřeší affected packages a nemá konfigurační DSL.

`veslo-document-runtime` si ponechá vlastní syntax/type check, přestože nemá
standardní `tsconfig.json`; recursive workspace run ho nesmí vynechat.

#### Type-aware correctness lint

Přidat jeden pinned ESLint flat config pro first-party TS/TSX a pouze tyto
high-signal skupiny:

- floating promises;
- misused promises;
- await nad non-promise;
- nevyužité disable komentáře;
- Solid reactivity a JSX correctness v `packages/app`.

Nezapínat stylistická pravidla ani celý `no-unsafe-*` cluster v prvním PR.
Generated, vendored, `dist`, Cargo `target`, `.tmp-*`, Pilot profiles a packaged
sidecars musí být mimo scope.

Každé pravidlo se zapne jako error až po opravě jeho čisté baseline. Žádný
globální warning budget ani snapshot současných nálezů.

#### Stabilní unit/contract set

`check:unit` používá explicitní seznam dnešních stabilních suites, minimálně:

- app `test:unit`;
- server `test`;
- orchestrator `test:router`;
- code-router `test:unit`;
- document-runtime `test`;
- AI Gateway, Den a worker-manager `test`;
- openwork-share existující Node testy přes nově pojmenovaný package `test`
  script.

Nespouštět `pnpm -r test`, protože `packages/e2e` má pod obecným názvem `test`
skutečný Tauri Pilot `current-gate`. Desktop test patří do oddělené lane.

#### Rust

`check:rust` spustí nad desktop manifestem:

```text
cargo fmt --all -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --all-features --locked
```

Přidat repo toolchain pin. Windows CI musí spustit Clippy/test tak, aby se
kompilovaly Windows-only větve; Linux-only run není jejich důkaz.

#### Root composition

Root scripts zůstanou obyčejnou čitelnou kompozicí:

```text
check
  -> check:lint
  -> check:types
  -> check:unit
  -> check:rust
  -> check:architecture
```

`check:architecture` obsahuje import boundaries, cycles, route hard checks a
Veslo headers. Nepřidávat custom child supervisor, timeout engine ani summary
format. Pokud později vznikne konkrétní problém s cleanupem nebo diagnostikou,
řešit ho v owner package commandu.

#### Akceptace

- `pnpm check` projde dvakrát na čistém checkoutu;
- záměrná floating promise, Solid violation, chybějící workspace typecheck,
  import violation a Rust warning každé shodí odpovídající krok;
- CI ani lokální check nic nezapisují a nic auto-fixují;
- failed krok vypíše nativní reprodukční command a plný error;
- žádný required target se tiše nepřeskočí přes `--if-present` bez předchozího
  coverage guardu.

### QG02 — Required GitHub gate pro `main` i `dev` (P0)

done: false

Přidat jeden quality workflow se čtyřmi stabilními job names:

- `Quality / Static` — ESLint, typechecks a hard architecture audity na Linuxu;
- `Quality / Unit` — explicitní unit/contract set na Linuxu;
- `Quality / Rust` — rustfmt, Clippy a Rust tests na Windows;
- `Quality / Gate` — aggregate nad třemi předchozími jobs.

#### Pravidla

1. Workflow běží na PR i push pro `main` a `dev`.
2. Používá frozen lockfile, repo pnpm pin, pinned Node a pinned Rust toolchain.
3. Má `concurrency` s `cancel-in-progress` pro superseded PR run.
4. Žádný required job nemá `continue-on-error`.
5. YAML pouze volá stejné repo scripts jako lokální kontrakt; nekopíruje jejich
   interní command seznam.
6. První verze nemá path filters. Docs-only PR může být pomalejší, ale required
   status vždy vznikne a nelze omylem vynechat konzumenta.
7. Fork PR nedostane monitoring/release secrets; quality gate je nepotřebuje.
8. GitHub ruleset skutečně vyžaduje pouze stabilní `Quality / Gate` na `main` i
   `dev`.

#### Akceptace

- záměrně rozbitý typecheck, unit test, Rust format a import boundary každý
  zablokuje merge přes `Quality / Gate`;
- nový commit zruší starý běh stejného PR;
- lokální a CI scripts mají stejný obsah, i když jsou v CI rozdělené do jobs;
- ruleset je ověřený reálným blocked PR, ne pouze deklarací v Markdown/YAML;
- `--no-verify` ani ruční tvrzení „tests pass“ required status nenahradí.

### QG03 — Povýšit existující desktop recovery důkaz (P1)

done: false

Nevytvářet nový scénář ani nový kill mechanismus. Použít existující:

- debug+E2E gated `veslo_server_e2e_kill_child`;
- `vslo-235-local-host-child-exit` Tauri Pilot scénář;
- fresh isolated E2E profile a dnešní launcher cleanup.

Přidat root `pnpm check:desktop-recovery`, který po povinném desktop preflightu
použije existující E2E build/sidecar flow a spustí pouze tento focused scénář.

První CI verze běží na Windows na každém PR do `main` a `dev`. Nevytvářet zatím
affected selector; dominantní náklad je Tauri build a selektor by přidal nový
zdroj falešně zelených změn. Po 20–30 reálných bězích lze samostatně rozhodnout
o cache nebo scope optimalizaci.

Workflow přidá stabilní job `Quality / Desktop recovery` a `Quality / Gate` se
rozšíří o jeho výsledek. Branch protection dál vyžaduje pouze aggregate status;
nevzniká druhý ručně spravovaný required status.

Scénář už prokazuje ready -> owned child exit -> `exited/child_exited` -> restart
-> healthy. V tomto rolloutu jej nerozšiřovat o nový model fixture ani obecný
fault framework. Samostatný follow-up je oprávněný pouze tehdy, pokud runtime
incident prokáže, že direct restart contract nestačí a je nutné pokrýt konkrétní
user-visible send/recovery flow.

#### Akceptace

- focused scenario projde dvakrát po sobě s fresh profilem;
- kill command zůstane kompilovaný pouze pod `debug_assertions + e2e`;
- test failne, pokud kill nebo restart ve skutečnosti neproběhne;
- po success i failure nezůstane proces spuštěný launcherem;
- production/MSI config nemá Pilot permission ani fault-injection command;
- `Quality / Gate` nemůže být zelený, pokud required desktop recovery job
  skončil failure; celý `current-gate` zůstává oddělený širší důkaz.

### QG04 — Akční frontend crash diagnostika (P1)

done: false

Rozšířit existující GlitchTip browser SDK a release env verifikaci. Nepřidávat
nový backend ani nový obecný logger.

#### A. Top-level renderer boundary

1. Obalit root Solid tree ErrorBoundary nad Router/AppEntry.
2. Boundary pošle render exception přes existující monitoring owner a zobrazí
   bezpečnou recovery obrazovku s akcí reload/relaunch.
3. Přidat úzkou capture funkci, která vrátí GlitchTip event ID pro fatal render
   crash. Zachovat dnešní `reportError(...): undefined` kontrakt pro stávající
   call sites.
4. UI ukáže krátké incident ID pouze pokud ho SDK skutečně vrátilo.
5. Unit/DOM test ověří fallback, jeden capture a recovery action. Tauri Pilot je
   potřeba jen pro relaunch behavior, ne pro čistý ErrorBoundary render contract.

ErrorBoundary není vydáván za ochranu async event handlerů nebo native paniců;
ty zůstávají v SDK/global/native error surfaces.

#### B. Source maps z přesného release buildu

1. Release Vite build generuje hidden source maps.
2. Jeden release-owned build helper provede přesné pořadí:

   ```text
   poslední Vite build -> inject debug IDs -> upload maps -> odstranit .map -> Tauri bundle
   ```

3. Po injectu už nesmí proběhnout druhý frontend build.
4. Runtime i upload používají dnešní jednotný `veslo@<version>` release a stejné
   environment. Commit/hash patří do evidence artifactu, ne do druhého
   konkurenčního release názvu.
5. Publish workflow failne, pokud required upload credentials chybí nebo upload
   skončí chybou. Manuální ad-hoc build může zůstat warning-only stejně jako
   dnešní DSN gate.
6. Installer nesmí obsahovat `.map`; public JS musí být přesně injectnutý JS,
   ke kterému byly mapy uploadované.

#### C. Jeden staging canary a alert drill

1. Přidat pouze staging/E2E compile-time canary entrypoint. Produkční build ho
   nesmí obsahovat ani zpřístupnit jako route/menu/IPC command.
2. Canary vyvolá chybu v reálném TS/TSX modulu z finálního staging buildu.
3. Jednorázově před zapnutím publish gate ověřit v GlitchTip:
   - správný release/environment/platform;
   - původní TS/TSX soubor a řádek;
   - žádný token, prompt, raw file content ani user path;
   - doručení alertu zvolenému ownerovi.
4. Evidence uloží pouze event ID, release, čas, symbolized frame summary a
   redaction verdict. Neuchovává celý event payload se zákaznickými daty.

V prvním rolloutu nepollovat GlitchTip API při každém releasu. Publish blokuje
chybějící/failed map upload; canary a alert drill se znovu spouští při změně
monitoring pipeline, SDK, build pořadí nebo alert pravidla.

#### Akceptace

- kontrolovaný render crash zobrazí recovery UI a incident ID;
- staging canary v GlitchTip ukáže původní TS/TSX frame;
- upload odpovídá přesně JS payloadu zabalenému do Tauri;
- installer neobsahuje source maps ani canary capability;
- alert reálně dorazí ownerovi;
- monitoring payload projde redaction kontrolou;
- release-required build bez map uploadu nepublikuje.

## Odložený native symbol follow-up

PDB/dSYM/ELF upload není součástí `done` tohoto plánu. Otevřít samostatný plán až
po dokončení QG04 a pouze s těmito vstupy:

1. jeden reálný nebo controlled native event ukáže, co dnes GlitchTip umí bez
   extra symbol artifactu;
2. pro každou podporovanou platformu je ověřené, jaký artifact skutečně vzniká
   vedle přesně podepsané/bundled binárky;
3. je rozhodnutá private retention a deletion policy;
4. release owner schválí náklad multiplatformního uploadu.

Tím se neblokuje vysokoleverage frontend symbolizace kvůli samostatnému
multiplatformnímu release projektu.

## Doporučené PR řezy

1. **PR A — baseline repair:** QG00, bez nových toolů a bez mass formatu.
2. **PR B — correctness contract:** typed ESLint, typecheck coverage guard,
   root `pnpm check` a required scripts.
3. **PR C — CI enforcement:** quality workflow, aggregate status, ruleset a
   canonical developer docs.
4. **PR D — desktop recovery promotion:** existující focused scenario jako
   required Windows lane; bez nového fault frameworku.
5. **PR E — renderer crash:** ErrorBoundary, hidden maps, final-build upload.
6. **PR F — monitoring proof:** staging-only canary, redaction check a alert
   drill; potom zapnout release-required upload gate.

PR A nesmí obsahovat lint-policy rollout. PR B nesmí obsahovat mechanický
full-repo format. PR E nesmí současně zavádět native symbol pipeline.

## Canonical docs po implementaci

Po dokončení jednotlivých fází aktualizovat skutečný stav, ne plánované sliby:

- `AGENTS.md` — běžný handoff končí `pnpm check`;
- `docs/dev/testing-playbook.md` — quality a focused desktop commands;
- `docs/dev/build-and-rebuild-matrix.md` — kdy je required desktop recovery;
- nový `docs/dev/engineering-quality-gates.md` — required/report klasifikace a
  reprodukční commands;
- `docs/dev/veslo-application-logs.md` — renderer incident, map upload a alert
  runbook;
- `docs/dev/state-and-config-reference.md` — pouze nové release-owned monitoring
  env/secrets, bez user-configurable DSN.

`docs/plans` zůstává historický handoff a po implementaci není canonical runtime
dokumentací.

## Stop rules

Implementaci zastavit a scope opravit, pokud:

1. baseline je zapínána jako permanentně červený required gate;
2. nový TS workspace může projít bez explicitního typechecku;
3. lint rollout vyžaduje broad disable nebo snapshot existujících findings;
4. někdo přidá formatter/mass-format do correctness PR;
5. strict Knip nebo heuristický audit je potichu povýšen na blocker;
6. lokální a CI kontrakt spouští rozdílné repo scripts;
7. required workflow používá path filter dřív, než vznikne důkaz proti full runu;
8. desktop cleanup může ukončit proces, který launcher nevlastní;
9. E2E kill command nebo monitoring canary pronikne do production buildu;
10. source maps patří jinému JS buildu než bundled payload;
11. monitoring artifact obsahuje secret, prompt, raw file content nebo user path;
12. ruleset chrání pouze `dev`, ale ne aktuální `main` integrační tok.

## Celkové done kritérium

`done: true` je povolen pouze když:

1. QG00–QG04 mají `done: true` a vlastní reprodukovatelný důkaz;
2. `pnpm check` projde dvakrát na čistém checkoutu;
3. každý TS workspace má non-writing typecheck a coverage guard to vynucuje;
4. typed async/Solid lint, unit/contract set, rustfmt, Clippy a hard audits jsou
   required;
5. `Quality / Gate` je reálně required pro `main` i `dev`;
6. focused desktop recovery projde dvakrát a nezanechá procesy;
7. produkční build neobsahuje Pilot/fault/canary capability;
8. staging renderer canary má původní TS/TSX frame a alert dorazil ownerovi;
9. publish-required map upload failne closed a installer neobsahuje `.map`;
10. canonical `docs/dev` a agent instrukce popisují skutečně implementovaný stav.

Native symbols, Biome, strict Knip, affected selection a automatický per-release
GlitchTip API canary nejsou součástí completion criteria tohoto plánu.
