---
title: KISS engineering quality gates and crash prevention implementation plan
date: 2026-07-15
target: Veslo monorepo quality gate, desktop crash diagnostics, and critical runtime smoke
status: ready-for-implementation
done: false
base_branch: main
base_commit: 0029edef42817b1a889fb3f83b458137e61672fc
baseline_worktree: dirty
---

# Veslo quality gates a prevence pádů — KISS implementační plán

## Cíl

Zavést minimum nástrojů, které přinese největší praktický efekt:

1. jeden jednoznačný lokální quality gate;
2. stejný gate povinný v GitHub CI;
3. semantic lint pro nejčastější TypeScript/Solid chyby;
4. čitelný a symbolizovaný produkční crash report;
5. jeden krátký test skutečné Tauri aplikace pro nejkritičtější lifecycle.

Úspěšná cesta má být krátká:

```text
chyba -> červený gate nebo alert -> konkrétní owner -> reprodukční příkaz/test
```

Tento plán nezakládá nový build systém, test framework ani observability backend.
Skládá existující `tsc`, Node/Bun testy, Cargo, Tauri Pilot, repo audity a
GlitchTip do jednoho vynutitelného kontraktu.

## Scope

- Target repo: `C:\Users\jajse\Desktop\projekty\veslo-main`.
- Autoritativní runtime: Tauri desktop v `packages/desktop`.
- Cloud/browser-only build není důkaz desktop funkčnosti.
- Existující packaged/MSI release gates zůstávají beze změny a pouze se připojí
  pod společný release command.
- Po implementaci se skutečný stav promuje do
  `docs/dev/engineering-quality-gates.md`, `docs/dev/testing-playbook.md` a
  `docs/dev/veslo-application-logs.md`. Tento plán zůstává historií.

## Co záměrně neděláme

- žádný Lefthook/Husky v první fázi;
- žádný dependency bot, CodeQL rollout ani nový dashboard;
- žádný globální coverage threshold nebo mutation testing;
- žádný vlastní dependency graph/build cache systém;
- žádné automatické retry červených testů do zelena;
- žádný full-repo refactor hotspotů;
- žádný druhý log backend vedle GlitchTip;
- žádné spuštění celé desktop OS matice na každém malém PR.

Tyto věci lze řešit později pouze tehdy, když základní gate stabilně funguje.

## Ověřený stav k 2026-07-15

Baseline byl naměřen nad rozpracovaným worktree. Před implementací se musí
zopakovat na čistém integrovaném commitu; současná selhání nejsou automaticky
defekty base commitu.

### Co už existuje

- package-level TypeScript kontroly a stovky testů;
- Tauri Pilot `current-gate` a focused desktop scénáře;
- production-shaped Windows packaged smoke;
- Knip, Madge a vlastní import/route/header/fallback/owner audity;
- browser i Rust GlitchTip SDK;
- desktop bootstrap diagnostics a supervised child process logging;
- release kontrola GlitchTip konfigurace a compiled/final artifact gates.

### Potvrzené mezery

- root `pnpm typecheck` kontroluje pouze app;
- E2E TypeScript kontrola aktuálně selhává na stale AI Gateway fixture typech;
- `cargo fmt --check` našel neformátovaný Rust v dirty worktree;
- import audit našel jeden cross-owner E2E -> AI Gateway import;
- route hard checks procházejí, ale report obsahuje 6 warnings a 83 info položek;
- strict Knip aktuálně hlásí 18 files, 17 dependencies, 6 devDependencies a
  1 unlisted binary;
- owner/fallback audity mají 96 a 1 049 heuristických findings, takže nejsou
  vhodné jako okamžitý correctness gate;
- Vite release build negeneruje source maps a release flow je neuploaduje;
- native PDB/dSYM symbol generation/upload není definován;
- app entry nemá top-level Solid ErrorBoundary s recovery UI;
- hlavní CI workflow chrání `dev`, ale ne konzistentně aktivní `main` tok;
- app script pojmenovaný `test:e2e` není skutečný Tauri desktop E2E.

## Pevná rozhodnutí

### Jedna odpovědnost na nástroj

- **Biome:** jediný formatter pro first-party JS/TS/TSX/JSON/CSS.
- **ESLint:** pouze type-aware TypeScript a Solid correctness pravidla.
- **TypeScript:** `tsc --noEmit` ve všech first-party TS workspace.
- **Rust:** rustfmt, Clippy a Cargo tests.
- **Desktop runtime:** Tauri Pilot.
- **Produkční chyby:** existující GlitchTip + debug-log pipeline.
- **Merge autorita:** GitHub required `Quality / Gate`.

Biome a ESLint nesmí mít překrývající se stylistická pravidla. CI nikdy
nepoužívá `--fix` nebo `--write`.

### Baseline policy

- Correctness checks musí být před zapnutím required gate zelené.
- Malé aktuální defekty se opraví v QG00, neallowlistují.
- Knip a heuristické audity zůstávají report-only, dokud nejsou důvěryhodně
  vyčištěné.
- Pokud je výjimka nezbytná, musí být scoped na konkrétní rule/file, mít důvod,
  ownera a datum odstranění.
- Baseline se nesmí automaticky zvětšovat regenerací snapshotu.

## Veřejný příkazový kontrakt

| Příkaz | Obsah | Použití |
| --- | --- | --- |
| `pnpm format:fix` | Biome write + `cargo fmt` | explicitní lokální oprava |
| `pnpm quality:fast` | format, semantic lint, typecheck all, rustfmt, import a route hard checks | běžný handoff |
| `pnpm quality:pr` | `fast` + unit/contract suites + cycles + Clippy | required PR gate |
| `pnpm quality:desktop` | jeden critical Tauri Pilot smoke | desktop/runtime změny |
| `pnpm quality:release` | release review + existující packaged/final artifact gates | publish readiness |

`quality:fast` má cílit na přibližně dvě minuty. Pokud je po změření pomalejší,
rozdělit ho na několik explicitních paralelních CI jobs. V první implementaci
nevytvářet obecný affected dependency graph; spolehlivý full correctness check je
důležitější než chytrá, ale děravá optimalizace.

Každý quality příkaz musí:

- skončit nenulovým exit code při required failure;
- vytisknout krátkou tabulku `step / status / duration / command`;
- zachovat plný log failed kroku;
- volitelně uložit redigovaný JSON summary pro CI artifact;
- při timeoutu nebo Ctrl+C ukončit pouze vlastní child procesy;
- nepovažovat 0 nalezených testů/souborů za úspěch required kroku.

## Implementační fáze

### QG00 — Čistá baseline a oprava falešně zelených/červených signálů (P0)

done: false

Nejdřív vytvořit čistý checkout integrovaného commitu a dvakrát zopakovat
baseline. Rozdělit každé selhání na skutečný defect, stale test, legitimní
generated/vendored výjimku nebo report-only heuristiku.

Minimální opravy před required gate:

1. opravit E2E fixture typy proti veřejnému/test-support AI Gateway kontraktu;
2. odstranit přímý cross-owner E2E import interního AI Gateway owneru;
3. opravit Rust format;
4. opravit nebo úzce klasifikovat aktuální header findings;
5. rozdělit route hard errors od warning/info reportu;
6. přejmenovat nebo v CI jasně označit app `test:e2e` tak, aby nebyl zaměnitelný
   se skutečným Tauri Pilot E2E;
7. změřit čas každého budoucího required kroku.

Knip, owner a fallback findings nejsou blocker QG00. Zůstávají viditelným
reportem; tento plán nemá uklízet celý historický dluh.

Akceptace:

- čistý checkout reprodukuje stejný baseline dvakrát;
- budoucí required checks jsou zelené bez `--no-exit-code` a broad ignores;
- je uložen přesný command, duration a owner každého kroku;
- dirty-worktree chyby nejsou prezentovány jako chyby base commitu.

### QG01 — Formatter, semantic lint, repo-wide typecheck a Rust checks (P0)

done: false

#### JS/TS/Solid

1. Přidat pinned Biome config pro first-party source a ignorovat generated,
   vendored, `dist`, Cargo `target`, `.tmp-*`, runtime profiles a packaged
   sidecars.
2. Přidat ESLint flat config s `typescript-eslint` typed lint přes
   `parserOptions.projectService: true` a Solid TypeScript pravidla.
3. Začít pouze high-signal correctness pravidly:

   - floating/misused promises;
   - await nad non-promise;
   - unused disable directives;
   - Solid reactivity a JSX correctness;
   - unsafe runtime boundary access pouze tam, kde má validní typed project.

4. JS/config soubory mimo typed project použijí `disableTypeChecked`.
5. Přidat `.editorconfig`; format-on-save smí používat pouze Biome.
6. Mechanický full format musí být samostatný commit bez behavior změn.

#### Typecheck

Každý first-party TS workspace musí mít explicitní non-writing `typecheck`.
Root `typecheck:all` musí failnout, pokud nový TS workspace typecheck nemá.
Minimálně zahrnout app, E2E, server, orchestrator, OpenCode router, web, landing,
DEN, AI Gateway a worker manager.

#### Rust

Přidat:

```text
cargo fmt --all -- --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --all-features --locked
```

Windows-only `cfg` větve musí mít Windows CI compile/check; Linux Clippy není
důkaz jejich správnosti.

Akceptace:

- `format:check`, `lint`, `typecheck:all` a Rust checks jsou zelené na clean repo;
- záměrná floating promise a Solid reactivity chyba shodí lint;
- druhý formatter běh vytvoří nulový diff;
- nový TS workspace bez typechecku shodí contract test;
- CI nic automaticky neopravuje.

### QG02 — Jeden malý quality runner a klasifikace auditů (P0)

done: false

Přidat malý cross-platform Node runner. Runner pouze spouští existující scripts,
měří čas a sjednocuje výstup; nesmí implementovat vlastní lint nebo build graph.

Klasifikace:

| Kontrola | Režim |
| --- | --- |
| Biome/ESLint/typecheck/rustfmt | required fast |
| import boundaries | required, zero violations |
| route contracts | required pouze hard checks |
| cycles | required PR |
| Clippy + unit/contract tests | required PR |
| headers | required po QG00 |
| strict Knip | report, později samostatně vyčistit |
| owners/fallbacks/client logic/workflow heuristics | report-only |

Runner musí mít unit testy pro success, failure, timeout, signal cleanup,
redakci a 0-test failure. Nepřidávat plugin API, daemon, cache ani generický task
DSL.

Akceptace:

- lokální a CI příkaz spouští stejná check IDs;
- chyba vypíše reprodukční command a owner surface;
- report-only finding nikdy nepřepíše required failure ani se netváří jako
  correctness success;
- failed run nezanechá child process.

### QG03 — Required GitHub quality gate pro `main` i `dev` (P0)

done: false

Vytvořit/reusovat workflow jobs:

- `Quality / Static`;
- `Quality / Unit`;
- `Quality / Rust`;
- `Quality / Gate` jako stabilní aggregate status.

Požadavky:

1. běží na PR do `main` i `dev` a na push do obou integračních větví;
2. používá frozen lockfile a pinned toolchain;
3. má `concurrency` + `cancel-in-progress` pro superseded PR run;
4. levný static job doběhne před drahým desktop buildem;
5. při chybě uploaduje redigovaný summary a relevantní artifacts;
6. žádný required job nepoužívá `continue-on-error`;
7. fork PR nedostane release/GlitchTip secrets;
8. branch protection/ruleset reálně vyžaduje stabilní `Quality / Gate` na
   `main` i `dev`.

Desktop Pilot se spouští pouze při změně app/session/server/desktop/runtime
surface nebo ručním labelu. KISS path filtering může být explicitní seznam;
nevytvářet vlastní dependency resolver.

Akceptace:

- záměrně rozbitý typecheck, lint, Rust format a import boundary každý zablokuje
  merge přes stejný aggregate status;
- nový commit zruší starý run stejného PR;
- docs-only PR nespouští desktop build;
- runtime diff nemůže být zelený bez `Quality / Gate` a požadovaného desktop
  checku;
- ochrana funguje pro `main` i `dev`, ne pouze v YAML deklaraci, ale v rulesetu.

### QG04 — Symbolizovaný crash, recovery UI a alert (P1)

done: false

Rozšířit existující GlitchTip a diagnostics pipeline; nepřidávat další backend.

#### Frontend

1. Release build generuje hidden source maps.
2. `glitchtip-cli` injectne debug IDs a uploaduje maps pod stejným
   `release/environment`, jaké používá runtime SDK.
3. Build pořadí musí být explicitní: poslední frontend build -> inject -> upload
   -> odstranění `.map` z public payloadu -> bundle.
4. Release gate ověří, že uploadnutý JS odpovídá zabalenému JS a installer
   neobsahuje `.map`.
5. Top-level Solid ErrorBoundary:

   - zachytí render crash;
   - odešle ho přes existující reporter;
   - zobrazí bezpečné recovery UI;
   - ukáže krátký incident ID bez citlivých dat.

#### Native symboly

Pro Windows/macOS/Linux explicitně definovat:

- Cargo/profile nastavení, které vytvoří použitelný PDB/dSYM/ELF symbol artifact;
- umístění a retention symbol artifactu;
- upload přes `glitchtip-cli debug-files upload`;
- shodu symbolu s přesnou podepsanou/bundled binárkou;
- odstranění symbolů z veřejného installeru.

Pouhé „upload symbols“ bez prokázané generace a shody není akceptace.

#### Owned child crashes

Neočekávaný exit serveru/orchestrátoru/sidecaru zapíše přes existující pipeline
low-cardinality fields:

- component;
- lifecycle phase;
- exit code/signal;
- expected/unexpected;
- restart attempt;
- release/platform;
- incident/trace ID.

Raw env, token, prompt, file content a user path se nesmí odeslat.

#### Canary a alert

Staging canary bezpečně vyvolá kontrolovanou frontend chybu a native test error
bez production debug route. Ověří doručení, release, symbolizovaný frame a
redakci. GlitchTip alert musí upozornit ownera na nový fatal issue a opakovaný
crash stejného release.

Akceptace:

- frontend canary ukazuje původní TS/TSX frame;
- native canary má symbolizovaný owned frame, nebo je platforma explicitně
  označená jako nedokončená;
- recovery UI ukáže incident ID dohledatelný v GlitchTip/debug logu;
- child crash má component/lifecycle/exit metadata;
- alert skutečně dorazí ownerovi;
- release vyžadující monitoring nepublikuje bez maps/symbol/canary důkazu.

### QG05 — Jeden critical Tauri lifecycle smoke (P1)

done: false

Nepřidávat širokou novou E2E suite. Vytvořit nebo zúžit jeden deterministický
Tauri Pilot smoke, který ověří:

1. desktop bootstrap a ready marker;
2. vytvoření/otevření fresh workspace;
3. první send a zobrazení deterministické odpovědi;
4. neočekávaný exit owned server/engine child;
5. čitelné recovery UI a diagnostický artifact;
6. shutdown bez orphan procesů.

Test používá fresh profil, lokální fixture a bounded timeout. Fault injection je
dostupná pouze v E2E/debug build configu, nikdy v produkčním MSI.

Při failure uložit pouze:

- screenshot/Pilot trace;
- bootstrap diagnostics;
- redigovaný child stdout/stderr tail;
- process cleanup summary;
- quality check ID.

Tento smoke běží na relevantním PR. Plný `current-gate` OS matrix může zůstat
scheduled nebo pro explicitní desktop/runtime změny. Existing packaged smoke a
installed-artifact gates zůstávají release důkazem a nejsou nahrazeny debug
Pilot buildem.

Akceptace:

- uměle ukončený owned child vytvoří jednoznačný failed/recovery artifact;
- test neprojde, pokud send/recovery operace vůbec nezačala;
- po success ani failure nezůstane orphan Veslo process;
- production config neobsahuje Pilot ani fault-injection capability;
- source-level green výsledek se nevydává za packaged runtime důkaz.

## Doporučené PR řezy

1. **PR A — baseline repair:** QG00, bez nových toolů a bez reformatu.
2. **PR B — formatter/lint/typecheck/Rust:** QG01 config a samostatný mechanický
   format commit.
3. **PR C — quality runner a CI:** QG02 + QG03; required zapnout až nad zeleným
   baseline.
4. **PR D — symbolizovaný crash:** QG04 frontend maps, ErrorBoundary, native
   symbol artifacts, canary a alert.
5. **PR E — critical lifecycle smoke:** QG05.

Mechanical format, behavior fix a CI enforcement nesmí být v jednom
nereviewovatelném diffu.

## Stop rules

Implementace se zastaví a návrh upraví, pokud:

1. nový required gate je permanentně červený;
2. `quality:fast` je po paralelizaci pravidelně nepoužitelně pomalý;
3. Biome a ESLint bojují o stejné stylistické pravidlo;
4. CI a lokální runner spouštějí odlišné check IDs;
5. CI zapisuje nebo auto-fixuje checkout;
6. cleanup může ukončit cizí proces;
7. artifact nebo GlitchTip event obsahuje secret či user payload;
8. uploaded source map/symbol neodpovídá zabalenému releasu;
9. Pilot/fault injection pronikne do production capability;
10. required gate chrání pouze `dev`, ale ne skutečný `main` integrační tok.

## Celkové done kritérium

`done: true` lze nastavit pouze když:

1. QG00–QG05 mají vlastní reprodukovatelný akceptační důkaz;
2. `quality:fast` a `quality:pr` jsou veřejné, dokumentované a zelené;
3. `Quality / Gate` je required na `main` i `dev`;
4. každý first-party TS workspace má non-writing typecheck;
5. Biome, typed ESLint/Solid, rustfmt a Clippy jsou required;
6. relevantní runtime PR spouští skutečný Tauri smoke;
7. GlitchTip canary prokazuje symbolizovaný frontend frame, native symbol stav a
   fungující alert;
8. recovery UI a child diagnostics používají společný incident ID;
9. packaged/final artifact gates zůstávají odděleným release důkazem;
10. canonical `docs/dev` dokumenty popisují skutečně implementovaný stav.

## Dokumentační základ nástrojů

Aktuální dokumentace ověřená 2026-07-15 podporuje zvolený KISS split:

- Biome má oddělený non-writing CI režim a lokální write režim.
- `typescript-eslint` podporuje `recommendedTypeChecked`, flat config,
  `projectService` a `disableTypeChecked` pro JS mimo type project.
- Solid ESLint plugin obsahuje TypeScript-aware reactivity/JSX pravidla.
- `glitchtip-cli` podporuje debug ID source maps i upload PDB/dSYM/ELF debug
  files.

Trvalým kontraktem ale nejsou názvy toolů. Jsou jím stabilní quality commands,
required merge gate, symbolizovaný incident a jeden reprodukovatelný desktop
recovery test.
