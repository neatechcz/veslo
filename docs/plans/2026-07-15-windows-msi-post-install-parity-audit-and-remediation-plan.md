---
title: Windows MSI post-install parity implementation plan
date: 2026-07-15
target: Windows MSI payload, first launch, bundled sidecars, and release gates
status: implementation-in-progress
done: false
base_branch: main
base_commit: 0029edef42817b1a889fb3f83b458137e61672fc
---

# Windows MSI post-install parity — sjednocený implementační plán

## Cíl

Po implementaci nesmí být možné publikovat Windows MSI, který:

- obsahuje `veslo-server.exe`, jenž nedokáže načíst document-runtime provider;
- potřebuje hostitelský Bun, Node.js nebo npm pro server či Chrome DevTools MCP;
- na podporovaném čistém Windows tiše selže kvůli chybějícímu WebView2;
- po čisté instalaci, upgradu nebo druhém startu nedosáhne definovaného
  produkčního ready stavu;
- při výchozím shared non-sandbox režimu zbytečně kontroluje nebo připravuje WSL.

Velký Windows office/document runtime zůstává `package-only`: provider a package
installer jsou součástí compiled serveru, ale `.veslopkg` se dál stahuje,
ověřuje a aktivuje v user app-data. Oprava proto nesmí přidat celý LibreOffice,
Python a další document payload do MSI.

## Vstupní evidence

Tento plán slučuje a nahrazuje implementační části těchto dokumentů:

- `docs/dev/2026-07-15-dev-vs-msi-installed-runtime-deep-audit.md`;
- předchozí verzi tohoto plánu.

Audit rozlišuje tři různé artefakty, které se nesmí zaměňovat:

| Povrch | Ověřený stav | Význam |
| --- | --- | --- |
| Zdrojový checkout | `v2026.7.11`, commit `0029edef` | Referenční codebase pro implementaci |
| Veřejný MSI | `26.7.11`, SHA-256 `e49fa08891f81d402d0cc427835f00b7a5da6aa0fbc054f5b247cb96bcd0f64d` | Potvrzený document-runtime P0 |
| Lokálně instalovaný produkt | `26.6.26` | Pouze upgrade/legacy Chrome MCP scénář |

## Revalidace proti živé codebase

Následující body byly znovu ověřeny na uvedeném base commitu:

1. `packages/server/src/routes/document-runtime.ts` skládá výchozí provider URL
   do proměnné a volá `import(moduleUrl)`. Bun proto při `--compile` nevidí
   staticky analyzovatelnou závislost.
2. `pnpm --filter veslo-server build:bin` s Bun `1.3.14` úspěšně vytvoří
   `dist/bin/veslo-server.exe`, ale probe spuštěný mimo checkout vrátí:

   ```text
   status=blocked
   repair.available=false
   blockedReason=document_runtime_provider_unavailable
   Cannot find module 'B:\document-runtime\src\index.mjs'
   ```

3. Samostatná compile zkouška `packages/document-runtime/src/cli.mjs`, která
   používá statické relativní importy, zabalí tři moduly a z prázdného runtime
   rootu správně vrátí `status=missing`. Provider je tedy s Bun standalone
   executable kompatibilní; není potřeba nový runtime ani filesystem fallback.
4. Současné testy jsou zelené, ale compiled kontrakt nekontrolují:

   - document-runtime server testy: `9/9`;
   - cílené app testy: `15/15`;
   - desktop/release config testy: `16/16`;
   - `pnpm release:review --json`: `ok=true`.

5. `release:review` a `tauri-config.test.mjs` dnes explicitně považují
   `webviewInstallMode.type = "skip"` za úspěch. Aktuální Tauri v2 dokumentace
   přitom říká, že aplikace bez předinstalovaného WebView2 v režimu `skip`
   nebude fungovat.
6. Windows a macOS používají stejný compiled `veslo-server` loader. Defekt je
   potvrzen na Windows MSI, ale oprava a compiled-binary gate musí být
   multiplatformní, aby se stejný import nevrátil v macOS sidecaru.
7. Desktop na Windows defaultuje na `shared_unsandboxed_engine=true`, MSI WSL
   custom action je defaultně vypnutá, ale `WindowsSandboxRepair` je konstantou
   zapnutý a automaticky mountovaný v onboarding i Settings. To je policy
   nekonzistence, nikoli kořen document-runtime P0.
8. Repo už má runtime debug report v Settings a bootstrap/sidecar diagnostickou
   pipeline. Implementace je má rozšířit, ne zakládat třetí diagnostický systém.

## Rozhodnutí a hranice

### Pevná rozhodnutí

- Provider bude normální workspace dependency serveru a bude importován
  staticky. Nebude se kopírovat do Tauri resources ani hledat relativně vůči
  checkoutu.
- `VESLO_DOCUMENT_RUNTIME_MODULE` může zůstat explicitním test/support
  override, ale výchozí produkční cesta na něm nesmí záviset.
- Windows document payload zůstane package-only.
- Release bude mít dvě oddělené brány: rychlý compiled-sidecar probe a probe
  sidecaru skutečně vytaženého z hotového MSI.
- Produkční MSI nedostane `tauri-pilot` capability. Installed smoke použije
  produkční proces, existující bootstrap diagnostiku a OS-level window/process
  kontrolu.
- Produkční Windows MSI fyzicky nebalí WSL/sandbox provisioning resources ani setup hooks; app-side WSL repair je do další produktové volby vypnutý.

### WebView2 rozhodnutí

Výchozí implementační volba je Tauri `embedBootstrapper`:

- přidá přibližně 1,8 MB;
- nevyžaduje, aby uživatel bootstrapper sháněl sám;
- pro stažení WebView2 stále vyžaduje síť.

Pokud produkt požaduje skutečně offline čistou instalaci, musí se před prací na
této fázi změnit volba na `offlineInstaller` (přibližně +127 MB) a přijmout větší
artefakt. `skip` není platný fresh-install kontrakt. `fixedRuntime` je výrazně
větší a bez samostatného produktového požadavku se nepoužije.

Historický problém s nested WebView2 akcí znamená, že samotná změna JSON není
důkaz opravy. Nový režim se smí dostat do releasu až po clean-VM testu s
WebView2 i bez něj.

Dokumentační základ rozhodnutí:

- Tauri v2 Windows installer documentation:
  `https://v2.tauri.app/distribute/windows-installer/`;
- Bun standalone executable documentation:
  `https://github.com/oven-sh/bun/blob/main/docs/bundler/executables.mdx`.

## Implementační pořadí

### WMP01 — Zabudovat document-runtime provider do `veslo-server` (P0)

done: true

Změny:

1. V `packages/document-runtime/package.json` zveřejnit typovaný provider entry:

   - runtime export dál směřuje na `src/index.mjs`;
   - přidat `types` export, například `src/index.d.mts`;
   - deklarace pokryje `doctor`, `repairHeadless` a
     `installPackageFromFeed`, včetně progress callbacku používaného serverem.

2. Do `packages/server/package.json` přidat
   `veslo-document-runtime: workspace:*` a aktualizovat lockfile.
3. V serverovém document-runtime owneru použít statický namespace import
   `veslo-document-runtime`. Loader zvolí:

   - explicitní dynamický override jen když je nastaven
     `VESLO_DOCUMENT_RUNTIME_MODULE`;
   - jinak již importovaný bundled provider.

4. Zachovat validaci povinných provider funkcí. Nezavádět fallback na
   `process.cwd()`, checkout path ani Tauri resource directory.
5. Doplnit lower-level test pro výchozí provider bez injected loaderu. Tento
   test chrání mapping a override větev, nikoli compiled artefakt.

Akceptace:

- `bun test` dál ověřuje injected i výchozí provider;
- `pnpm --filter veslo-server typecheck` projde bez `any` deklarace celého
  modulu;
- `pnpm --filter veslo-server build:bin` vytvoří standalone executable;
- compiled executable spuštěný s prázdným
  `VESLO_DOCUMENT_RUNTIME_ROOT` a mimo checkout vrátí `missing` a
  `repair.available=true`;
- výstup ani binary probe neobsahuje runtime pokus o
  `B:\document-runtime\src\index.mjs`.

Stop rule: WMP01 není hotové, pokud projdou jen source testy. Rozhodující je
compiled executable.

Ověřeno 2026-07-15:

- server provider je statický workspace import s explicitním override jen pro
  `VESLO_DOCUMENT_RUNTIME_MODULE`;
- `pnpm --filter veslo-server typecheck` a document-runtime route testy prošly;
- nově sestavený `veslo-server.exe` prošel izolovaným compiled probe mimo
  checkout a vrátil `missing` + `repair.available=true`, ne `blocked`.

### WMP02 — Přidat reusable compiled-sidecar probe (P0)

done: true

Vytvořit jeden Node/Bun skript, například
`scripts/release/probe-veslo-server-document-runtime.mjs`, který přijme cestu k
binary a provede celý lifecycle:

1. vytvoří privátní temp CWD, `VESLO_DATA_DIR` a
   `VESLO_DOCUMENT_RUNTIME_ROOT`;
2. spustí server s `--port 0`, explicitním client/host tokenem a bez workspace;
3. parsuje existující `VESLO_SERVER_READY` descriptor místo pevného portu;
4. zavolá autentizované `GET /document-runtime/status`;
5. očekává `missing`, `repair.available=true` a žádný provider/import error;
6. nastaví loopback/unreachable package feed, zavolá
   `POST /document-runtime/repair` a očekává okamžitý
   `package_installing` + `repair.inProgress=true`; test nestahuje veřejný
   office package;
7. vždy ukončí child process a odstraní temp data.

Skript musí fungovat pro lokální `build:bin`, Windows target sidecar i macOS
sidecary. Přidat package command `test:compiled-document-runtime`, aby šel gate
spustit stejně lokálně i v CI.

Akceptace:

- test nejdřív prokazatelně selže nad binary z base commitu;
- po WMP01 projde nad nově sestaveným binary;
- chyby vypisují binary path, server stdout/stderr, HTTP status a redigovaný
  document-runtime payload;
- žádný proces ani temp adresář po testu nezůstane.

Ověřeno 2026-07-15:

- existuje reusable `test:compiled-document-runtime` command nad přesně zadanou
  binary cestou;
- probe spouští server s portem `0`, vlastními tokeny a izolovaným CWD/data
  profilem, čte `VESLO_SERVER_READY`, ověří status i nonblocking repair a vždy
  uklidí jen vlastní process tree;
- testy parseru/negative provider branch prošly a po skutečném běhu nezůstal
  žádný probe temp adresář ani sidecar proces.

### WMP03 — Ověřit payload hotového MSI, ne jen `target/release` (P0)

done: false

Přidat Windows-only wrapper, například
`scripts/release/verify-windows-msi-runtime.ps1`:

1. přijme přesnou cestu k jednomu MSI; wildcard s více výsledky je chyba;
2. vypočte SHA-256 a načte ProductVersion/ALLUSERS z MSI databáze;
3. provede administrativní extrakci přes `msiexec /a` do privátního temp
   adresáře s verbose logem;
4. v extrahovaném Program Files payloadu ověří právě jednu kopii:

   - Veslo desktop executable;
   - `veslo-server`, `veslo-code-router`, `veslo-orchestrator`, OpenCode;
   - `versions.json` a shodu verzí/hashů;
   - Windows `veslo-node`;
   - Chrome DevTools MCP binary a vendored package entrypoint.

   Pro Windows executable entries nesmí být hash prostý file SHA-256:
   Authenticode signing po zápisu versions.json mění checksum,
   certificate-directory a certificate table. prepare-sidecar, rychlá bundle
   předkontrola i MSI gate proto musí počítat shodný Authenticode-canonical
   SHA-256 (tyto tři signer-mutable oblasti vynechané);
   opencode-managed-deps zůstává raw file SHA-256. Starší veřejný MSI s raw
   pre-sign hashem je očekávaný release blocker, ne důkaz platnosti nové
   brány.

   Průběžná evidence 2026-07-15: lokální staging MSI
   a3de268181222c516c6c4b7530b2a6c50d68da88bd2947feecccbb6a8f906302
   prošel celý extracted-payload test včetně WMP02 a Chrome probe s čistým
   PATH. Veřejný v2026.7.11 MSI
   e49fa08891f81d402d0cc427835f00b7a5da6aa0fbc054f5b247cb96bcd0f64d
   správně padne: versions.json pro veslo-code uvádí starý raw hash
   1d312c76504369c14deadb2676746bdb55779c6e396b0e8d43e2858ad4186d03,
   zatímco podepsaný payload má canonical hash
   de4c50835828ddc343d613a777959b443f7ca498fd4cd42cffa245cb81a53e49.
   WMP03 proto zůstává done: false až do stejného výsledku nad publikovaným
   podepsaným nástupnickým MSI.

5. nad vytaženým `veslo-server` spustí WMP02 probe;
6. s PATH bez hostitelského Node/npm/Bun spustí vytažený Chrome MCP shim s
   bezpečným `--version`/help probe a ověří, že použije bundled Node a vendored
   package;
7. vždy přiloží machine-readable JSON summary a při chybě MSI/extraction log;
8. v `finally` ukončí jen procesy spuštěné testem a smaže temp payload.

Zapojení bez kopírování implementace do YAML:

- `.github/workflows/build-desktop.yml`;
- `.github/workflows/build-windows-msi.yml`;
- Windows matrix větev `.github/workflows/prerelease.yml`;
- `publish-tauri-windows` v produkčním release workflow.
- Windows větev `.github/workflows/build-staging-app.yml`, protože její MSI je
  instalovatelný artefakt pro testery.

Gate musí běžet po vytvoření MSI a před uploadem/publikací. Workflow pouze volá
sdílený skript. Prerelease Windows build proto nesmí použít uploadující
`tauri-action` před extracted-MSI/signature gate; uploaduje až po úspěšné
kontrole stejných cest jako produkční build.

Aktualizovat `scripts/release/review.mjs` a jeho testy tak, aby vyžadovaly MSI
runtime gate před prvním artefaktovým uploadem ve všech aktivních Windows
build/publish workflow. Dosavadní
`verify-bundled-versions.mjs` zůstává rychlou předkontrolou, ale nenahrazuje
WMP03.

Release blocker:

- provider status `blocked` nebo `document_runtime_provider_unavailable`;
- hostitelský Node/npm/Bun nutný pro bundled sidecar;
- chybějící nebo duplicitní payload;
- manifest/verze/hash neodpovídá sestavenému releasu;
- test neprokáže cleanup.

### WMP04 — Zpřesnit document-runtime chybu a existující diagnostiku (P1)

done: true

Tato fáze neopravuje P0 fallbackem; pouze zlepšuje support stav po WMP01.

1. V app document-runtime modelu pro `blocked` preferovat redigovaný
   `repair.lastError` před obecným `blockedReason`, pokud jde o interní provider
   chybu. Akce zůstane zakázaná, když server repair skutečně nenabízí.
2. Do již existujícího Settings `runtimeDebugReport` přidat:

   - celý redigovaný document-runtime status;
   - source/provider mode (`bundled` nebo explicit override, bez citlivé path);
   - app/sidecar verze, které už report částečně obsahuje;
   - configured/effective sandbox backend;
   - poslední bootstrap/server-launch stav.

3. Použít existující sanitizer a bootstrap diagnostics pipeline. Nevytvářet
   další log store, nový export formát ani paralelní runtime state machine.
4. Doplnit app testy pro konkrétní provider error, redakci paths/tokenů a
   dostupnost install/repair akce.

Ověřeno:

- server status nyní uvádí pouze bezpečný `providerMode`
  (`bundled`/`module_override`), nikdy cestu explicitního override;
- UI pro interní provider chybu ukáže redigovaný `lastError`, ale bez
  neexistující repair akce;
- Settings report obsahuje celý redigovaný document-runtime status, existující
  sandbox report a snapshot bootstrap/server-launch lifecycle;
- `11` serverových a `9` app testů i oba relevantní TypeScript typechecky
  prošly.

### WMP05 — Nahradit implicitní WebView2 předpoklad (P1)

done: false

Implementační stav (2026-07-15): `tauri.conf.json` a oba statické gatey nyní
vyžadují `webviewInstallMode.type = "embedBootstrapper"`; nepoužívá se novější
verzovaná vlastnost, takže uzamčený Tauri CLI `2.9.6` zůstává nezměněn. Fáze
zůstává `done: false`, dokud stejný veřejný podepsaný MSI neprojde oběma VM
větvemi níže (WebView2 přítomný i nepřítomný).

1. Změnit Windows bundle config z `skip` na rozhodnutý režim
   `embedBootstrapper` (nebo předem schválený `offlineInstaller`).
2. Změnit `tauri-config.test.mjs`, `release:review.mjs` a jejich testy: gate má
   kontrolovat podporovaný fresh-install režim, ne historické `skip`.
3. Pokud bude použitá novější vlastnost jako `minimumWebview2Version`, nejdřív
   explicitně aktualizovat a zamknout `@tauri-apps/cli` na verzi, která ji
   podporuje; současný lock obsahuje CLI `2.9.6`.
4. V disposable VM spustit dvě větve nad stejným MSI hash:

   - WebView2 již přítomný: instalace nesmí spouštět zbytečný repair ani vrátit
     starou nested-installer chybu;
   - WebView2 nepřítomný: instalace ho zajistí, případně skončí explicitní
     prerequisite chybou podle schválené online/offline policy; tiché prázdné
     okno není přípustné.

Release blocker: změna configu bez obou VM výsledků není implementovaná parita.

### WMP06 — Zcela vynechat Windows WSL sandbox provisioning (P1)

done: true

Implementační stav (2026-07-15): obě Tauri konfigurace už WSL setup soubory
nebalí; WiX fragment/component group a NSIS hook jsou pryč. Onboarding i
Settings nemountují repair komponentu a policy vrací `hidden` i pro starou
uloženou sandbox preference nebo support flow. Source support skripty zůstávají
jen mimo shipping config pro případné budoucí rozhodnutí.

1. Windows release payload nesmí obsahovat `windows-wsl2-sandbox-provision.ps1`,
   žádný `wsl2-*-installer.ps1`, WiX WSL fragment/component group ani NSIS
   WSL hook. Zdrojové support skripty mohou zůstat mimo shipping config.
2. Odstranit WSL resources z `tauri.conf.json` i
   `tauri.windows.release.conf.json`; odstranit WiX fragment a NSIS
   `installerHooks`.
3. Onboarding ani Settings nesmí mountovat `WindowsSandboxRepair`. Policy helper
   musí pro všechny preference i support flow vrátit skrytý stav, aby ani
   stará uložená sandbox preference nespustila WSL.
4. `release:review`, desktop config test a document-runtime verifier musí
   selhat při návratu WSL payloadu nebo hooku.
5. Extracted-MSI verifier musí po administrativní extrakci selhat, pokud najde
   některý ze zakázaných WSL setup souborů.

Ověřeno:

- desktop config, release review i document-runtime verifier kontrolují base i
  release overlay; extracted-MSI verifier navíc kontroluje payload i MSI
  `CustomAction` tabulku;
- čerstvě sestavený lokální MSI `26.7.11` prošel extrakcí (271 souborů), bez WSL
  setup souborů a bez WSL/VesloSandbox custom action;
- `pnpm desktop:smoke-packaged` prošel 4/4 bez WSL provisioning signálu a se
  shared non-sandbox runtime;
- app typecheck a cílené unit/release testy prošly.

Hranice ověření: tento lokální MSI byl sestaven s `--no-sign` a ověřen přes
`msiexec /a`. Skutečný `msiexec /i` běh na čisté disposable VM zůstává otevřený
ve WMP08.

### WMP07 — Přidat production-shaped lokální smoke (P1)

done: true

Přidat jeden dokumentovaný příkaz, například `pnpm desktop:smoke-packaged`,
který na Windows:

- vynutí rebuild UI a sidecarů;
- nepoužije Vite, `bun --watch`, root `.env`, dev cleanup ani PATH fallback;
- sestaví production-shaped Tauri binary se stejným UI, sidecary a release
  configem, ale s explicitním `tauri.e2e.conf.json` overlay a Cargo `e2e`
  feature;
- použije izolovaný fresh app profile;
- čeká na existující server readiness a nový redigovaný
  `desktop-bootstrap:ready` event;
- přes Tauri Pilot ověří první workspace a první server-owned send pouze s
  lokální deterministic fixture, bez live credentials;
- ukončí pouze vlastní proces tree a ověří cleanup.

Implementační stav (2026-07-15): smoke nyní vypíná debug-only orchestrator
autostart, maže všechny zděděné `VESLO_*`/`E2E_*`/`VITE_*`/`OPENCODE_*`
runtime-build overrides a používá redigovaný per-launch ready marker, který
není odstraněn úspěšným forwardem. `pnpm desktop:smoke-packaged` po této změně
znovu prošel.

Tento smoke je rychlá vývojářská zpětná vazba a jediná větev plného UI E2E.
Není to finální release binary ani náhrada finálního MSI testu; test-only Pilot
capability musí zůstat pouze v E2E overlay.

Ověřeno:

- `pnpm desktop:smoke-packaged` na Windows 15. 7. 2026 po opravě skončil exit
  code 0; log explicitně potvrdil
  `[dev-autostart] disabled by VESLO_DISABLE_DEV_AUTOSTART`;
- vynucený UI a sidecar rebuild, isolated profile, redigovaný ready event,
  bundled local server, deterministic first send a server-owned conversation
  byly vykonány v jednom reálném Tauri Pilot běhu;
- teardown ukončil pouze sidecar potomka spuštěné aplikace a post-check
  nevrátil žádný Veslo runtime proces.

### WMP08 — Installed-MSI clean/upgrade/second-start gate (P1)

done: false

Implementační stav (2026-07-15):

- `scripts/release/verify-windows-msi-installed.ps1` je připravený VM harness;
  instaluje přes přesný `msiexec /i`, vedle toho porovná payload z téhož MSI s
  Program Files a ukládá strojově čitelný evidence JSON i verbose MSI log.
  Elevaci ověří ještě před prvním `msiexec /a` nebo `/i` během.
- Ještě před kandidátním `/i` auditne `CustomAction` tabulku i administrativně
  vytažený payload a odmítne WSL/`VesloSandbox` setup. Historický baseline
  upgradu se tím nezpřísňuje, aby zůstal ověřitelný jako skutečný výchozí stav.
- Harness nespouští Tauri Pilot. Čte main-window stav, runtime descriptor,
  authenticated `/status`, document-runtime status a redigovaný per-launch
  bootstrap marker; spool zůstává pouze diagnostický fallback. Jeho cleanup zná pouze PID strom, který
  sám založil. Aplikaci spouští s prázdným verifier-owned CWD a čistým PATH,
  aby source checkout ani hostitelský runtime nemohly maskovat package fallback.
- Scénář `updater` pouze ověřuje reálně vytvořený
  `C:\ProgramData\veslo-updater-msi.log`; nesmí si jej vyrobit vlastním
  `msiexec` během testu. Musí dostat UTC timestamp zachycený před skutečným
  in-app updater během a odmítnout starší log z předchozí transakce.
- WMP08 zůstává nedokončený, dokud stejný veřejný podepsaný MSI neprojde v
  disposable VM všemi níže uvedenými scénáři. V tomto checkoutu není takový
  MSI ani VM evidence.

V disposable Windows VM nainstalovat přesný MSI z WMP03 pomocí `msiexec /i` a
ukládat verbose log. Každý run uloží tag/commit, MSI hash, Windows build,
WebView2 stav, WSL stav a installed `versions.json`.

Produkční ready signál:

- app process běží z Program Files;
- hlavní okno existuje;
- bundled server dosáhne authenticated health/readiness;
- existující bootstrap pipeline zapíše redigovaný
  `desktop-bootstrap:ready` až po obou předchozích podmínkách;
- document-runtime status je `missing`/`ready`, nikdy provider `blocked`.

Povinné scénáře:

1. čistý uživatel, žádná app-data, žádný host Node/npm/Bun;
2. čistý image bez WSL — shared non-sandbox engine a onboarding projdou bez WSL
   volání;
3. upgrade `26.6.26 -> nový MSI` s minimálním produkčním profilem;
4. druhý start po normálním shutdownu;
5. druhý start po nuceném ukončení vlastního runtime;
6. cizí listener na očekávaném portu — nesmí být ukončen, app musí zvolit
   bezpečnou větev nebo jasnou diagnostiku;
7. updater cesta s kontrolou `C:\ProgramData\veslo-updater-msi.log`.

Test nesmí používat `tauri-pilot` v produkčním MSI. Tauri Pilot zůstává pro
repo E2E build; final-artifact test čte produkční event/log a OS stav.

Release blocker:

- `msiexec=0` bez ready signálu nestačí;
- nesoulad installed manifestu;
- stale stará binary po upgradu;
- timeout bez redigovaných startup artefaktů;
- zabití cizího procesu;
- WSL blokuje výchozí non-sandbox flow.

### WMP09 — Dokumentace a release policy (P1)

done: false

Implementační stav (2026-07-15): durable zdroje už rozlišují extracted-MSI
kontrolu, production-shaped packaged smoke a installed-MSI VM gate; obsahují
konkrétní evidence/log cesty, package-only Windows document-runtime kontrakt a
release blockery. `done` zůstává `false`, dokud se do nich nedoplní skutečný
výsledek stejného veřejného podepsaného MSI z WMP08, ne jen existující harness.

Po ověření implementace aktualizovat durable zdroje pravdy:

- `docs/dev/build-and-rebuild-matrix.md` — compiled a MSI gates;
- `docs/dev/testing-playbook.md` — packaged smoke a installed VM evidence;
- `docs/dev/veslo-application-logs.md` — MSI/updater/bootstrap log locations;
- `packages/document-runtime/README.md` — skutečný Windows package-only model;
- `RELEASE.md` — povinné Windows blockery a artefakty.

`docs/plans/` zůstává historií. Po dokončení nesmí být tento plán jediným
místem, kde je nový release kontrakt popsán.

## Doporučené PR řezy

| PR | Obsah | Může se merge samostatně | Release dopad |
| --- | --- | --- | --- |
| 1 | WMP01 + WMP02 | Ano | Opraví P0 a zabrání source/compiled regresi |
| 2 | WMP03 + release-review wiring | Ano, po PR1 | Zablokuje vadný finální MSI |
| 3 | WMP04 + WMP06 | Ano | Zpřesní support a odstraní default WSL touch |
| 4 | WMP05 | Ano po VM důkazu | Zavře WebView2 fresh-install mezeru |
| 5 | WMP07 + WMP08 | Ano po stabilizaci harnessu | Zavře clean/upgrade/second-start mezeru |
| 6 | WMP09 | Spolu s posledním behavior PR | Promuje ověřený kontrakt do durable docs |

PR1 a PR2 jsou podmínkou dalšího Windows releasu. WebView2 změna se nesmí
přimíchat do document-runtime P0 PR, protože má jiný rollback a VM matici.

## Povinná akceptační matice

| Gate | Vstup | PASS | FAIL / blocker |
| --- | --- | --- | --- |
| Source provider | server test bez injected loaderu | default provider načten | checkout/path fallback |
| Compiled provider | standalone sidecar, temp CWD/root | `missing`, repair available | `blocked`, `B:\document-runtime` |
| MSI payload | sidecar vytažený z přesného MSI | compiled probe + manifest + Chrome MCP | chybějící resource nebo host tool |
| WebView2 present | čistá VM se runtime | instalace + ready event | nested installer/regrese |
| WebView2 absent | čistá VM bez runtime | bootstrap/instalace dle policy | prázdné okno/tiché selhání |
| Fresh profile | nový Windows user | UI + server ready + first send | `msiexec=0` bez ready |
| No WSL | default preference | žádné WSL volání, engine ready | onboarding warning/block |
| Upgrade | `26.6.26 -> current` | nové hashe/verze, ready | stale binary/migrace fail |
| Second start | clean i forced shutdown | reconcile vlastního runtime | timeout nebo kill cizího procesu |
| Updater | starší podporovaná verze | log + upgrade + ready | beze stopy nebo restart fail |

## Celkové done kritérium

`done: true` lze nastavit teprve, když:

1. WMP01–WMP09 mají vlastní ověřovací důkaz;
2. compiled probe a extracted-MSI probe jsou required gates všech aktivních
   Windows build/release workflow;
3. veřejně publikovaný nástupnický MSI projde stejným skriptem a jeho hash je
   uložen s výsledkem;
4. clean VM, no-WebView2 VM a upgrade scénář projdou nad tímto stejným hashem;
5. durable docs popisují skutečně implementovaný kontrakt;
6. `git diff --check`, cílené testy, `pnpm release:review --strict` a výsledný
   worktree audit jsou čisté vůči souborům dotčeným implementací.
