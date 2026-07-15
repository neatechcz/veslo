# Deep audit: proč dev funguje a Windows MSI ne

Datum: 2026-07-15

Stav: read-only audit; žádný aplikační kód nebyl měněn.

Implementační autorita: jednotný, proti živé codebase revalidovaný plán je v
`docs/plans/2026-07-15-windows-msi-post-install-parity-audit-and-remediation-plan.md`.
Pořadí práce a akceptační návrhy níže zůstávají auditní evidencí; při rozporu je
nahrazuje uvedený implementační plán.

## Rozsah, artefakty a hranice srovnání

Tento audit nyní odděluje tři různé cíle. Nesmí se mezi nimi přenášet závěr
bez ověření stejné verze a stejného payloadu:

| Cíl | Přesný stav | Důkaz |
| --- | --- | --- |
| Vývojový checkout | `main` na tagu `v2026.7.11`, commit `0029edef` | živý checkout |
| Aktuální veřejný artefakt | `veslo-desktop-windows-x64.msi`, ProductVersion `26.7.11` | SHA-256 `e49fa08891f81d402d0cc427835f00b7a5da6aa0fbc054f5b247cb96bcd0f64d` |
| Skutečně nainstalovaný produkt na tomto PC | `Veslo by Neatech` DisplayVersion `26.6.26`, instalace `2026-06-26` v `C:\Program Files\Veslo by Neatech\` | živý uninstall registry záznam a obsah Program Files |

Mezi tagy `v2026.6.26` a `v2026.7.11` je `527` commitů a `1 995` změněných
souborů. Selhání současné lokální instalace proto samo o sobě nedokazuje chybu
veřejného MSI `26.7.11`; může jít o už opravený problém staršího vydání.

| Důkaz o veřejném MSI `26.7.11` | Hodnota |
| --- | --- |
| Instalace v MSI | `ALLUSERS=1`, tedy per-machine instalace |
| Prohlídka MSI | read-only Windows Installer database a výpis CABu; žádná instalace do systému |
| Runtime probe | z MSI byl do dočasného adresáře vytažen pouze `Bin_veslo_server.exe`, spuštěn na loopback portu s izolovaným pracovním adresářem, po probe ukončen a dočasný adresář smazán |

Největší nález není obecná odlišnost buildů. Je to reprodukovatelná chyba
v reálném sidecaru z veřejného MSI.

## Verdikt

1. **P0 pro reprodukci — lokálně nainstalovaný produkt není stejný release jako
   dev ani auditovaný veřejný MSI.** Je to `26.6.26`, nikoli `26.7.11`; jeho
   Chrome DevTools MCP navíc nemá přibalený Node ani package. Konkrétní problém
   této staré instalace je popsán ve F0.
2. **P0 — Windows document runtime je v současném veřejném MSI nefunkční.**
   Zkompilovaný `veslo-server.exe` se snaží dynamicky načíst zdrojový modul z
   virtuální cesty `B:\document-runtime\src\index.mjs`. Modul v MSI není a
   route proto vrátí `blocked` místo stavu, z něhož by šla stáhnout/opravit
   document-runtime package. Blokuje to `veslo-docx`, `veslo-xlsx`,
   `veslo-pdf` a `veslo-pptx`.
3. **P1 — MSI explicitně neřeší WebView2.** Na počítači bez již
   nainstalovaného Edge WebView2 runtime se aplikace podle konfigurace Tauri
   nemá jak spustit ani opravit závislost. Dev stroj tuto podmínku téměř vždy
   maskuje.
4. **Největší systémová příčina rozdílu je, že dev vůbec netestuje stejný
   server.** Dev spouští `bun --watch src/cli.ts` ve zdrojovém checkoutu;
   MSI spouští zkompilovaný sidecar z app-data pracovního adresáře. P0 je
   přímý důkaz, že tato odlišnost už způsobila produkční chybu.
5. Další rozdíly (čistý profil, WSL onboarding, diagnostika, debug fallback,
   dev-only autostart, druhý start a updater) samy o sobě nejsou všechny
   potvrzené bugy, ale jsou to přesné nepokryté větve parity.

## F0 — P0 pro reprodukci: lokální instalace je starý release s jiným Chrome MCP payloadem

**Stav:** potvrzeno přímo v právě nainstalovaném produktu; nejedná se o tvrzení
o aktuálním veřejném MSI `26.7.11`.

Uninstall registry uvádí `Veslo by Neatech` ve verzi `26.6.26`, nainstalované
`2026-06-26` do `C:\Program Files\Veslo by Neatech\`. Jeho
`versions.json.exe` potvrzuje `veslo-server`, router a orchestrator `2026.6.26`
a OpenCode `1.17.4`; dev checkout a veřejný MSI jsou `2026.7.11` / OpenCode
`1.17.13`.

### Přesná stará Chrome DevTools MCP chyba

V nainstalovaném `26.6.26` existuje `chrome-devtools-mcp.exe`, ale vedle něj
neexistuje ani `veslo-node.exe` / `Bin_veslo_node.exe`, ani adresář
`chrome-devtools-mcp-package`. Historický shim z tagu `v2026.6.26` začíná přes
Node a spouští:

```ts
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const args = ["exec", "--yes", packageSpec, "--", ...effectiveArgs];
```

Na stroji bez hostitelského Node/npm proto tato cesta nemůže spustit Chrome
DevTools MCP. Je to konkrétní post-install problém staré lokální instalace,
ne hypotéza o PATH.

Aktuální veřejný MSI `26.7.11` tento konkrétní payload deficit nemá:
`Bin_veslo_node.exe` v něm existuje a má `85 588 976` bytů. To však nijak
nevyvrací F1 — document runtime je v aktuálním MSI samostatně rozbitý.

### Správné srovnávací scénáře

1. Chceme-li vysvětlit současné chování na tomto PC, testujeme explicitně
   nainstalovanou `26.6.26` a její Chrome MCP cestu bez hostitelského Node/npm.
2. Chceme-li potvrdit release paritu, nejdříve nainstalujeme přesně veřejný
   `26.7.11` MSI a porovnáme ho s checkoutem stejného tagu.
3. Chceme-li testovat migraci, je to samostatný scénář `26.6.26 -> 26.7.11`,
   nikoli náhrada čisté instalace.

## F1 — P0: document runtime se v reálném MSI nemůže načíst

**Stav:** potvrzeno přímo proti veřejnému `v2026.7.11` MSI.

**Dopad:** všechny čtyři document skill cesty jsou označeny jako nepřipravené;
uživatel nemá dostupné tlačítko pro instalaci ani opravu.

### Přesná chyba z artefaktu

`GET /document-runtime/status` proti `Bin_veslo_server.exe` vytaženému z
veřejného MSI vrátil HTTP 200 s tímto relevantním payloadem:

```json
{
  "status": "blocked",
  "ready": false,
  "skills": [
    { "id": "veslo-docx", "ready": false, "reason": "blocked" },
    { "id": "veslo-xlsx", "ready": false, "reason": "blocked" },
    { "id": "veslo-pdf", "ready": false, "reason": "blocked" },
    { "id": "veslo-pptx", "ready": false, "reason": "blocked" }
  ],
  "repair": {
    "available": false,
    "blockedReason": "document_runtime_provider_unavailable",
    "lastError": "ResolveMessage: Cannot find module 'B:\\document-runtime\\src\\index.mjs' from 'B/~BUN/root/veslo-server-bun-windows-x64-baseline.exe'"
  }
}
```

To není hypotéza založená jen na konfiguraci. Je to odpověď skutečného
`117,053,264`-bytového `Bin_veslo_server.exe` z distribuovaného MSI.

### Proč stejná cesta v dev režimu nepadá

Výchozí loader v
`packages/server/src/routes/document-runtime.ts:234-244` dělá toto:

```ts
const moduleUrl = moduleOverride ||
  new URL("../../../document-runtime/src/index.mjs", import.meta.url).href;
const loaded = await import(moduleUrl);
```

Dev launcher nastaví `VESLO_SERVER_DEV_WATCH=1` a
`VESLO_SERVER_DEV_DIR=packages/server`
(`packages/desktop/scripts/tauri-dev.mjs:507-510`). Rust pak spustí
`bun --watch src/cli.ts` právě v tomto zdrojovém adresáři
(`packages/desktop/src-tauri/src/veslo_server/spawn.rs:706-724`). Relativní
cesta tedy vede do existujícího checkoutu `packages/document-runtime/src`.

Porovnávací probe běžící přes `bun src/cli.ts` se stejným čistým workspace
vrátil místo toho:

```json
{
  "status": "missing",
  "repair": {
    "available": true,
    "blockedReason": null,
    "lastError": "Document runtime active pointer missing: C:\\Users\\jajse\\AppData\\Local\\Veslo\\document-runtime\\active.json"
  }
}
```

To je správně odlišný stav: provider je načtený a aplikace může nabídnout
instalaci package. V MSI provider nelze načíst vůbec.

### Proč to v instalaci nemá kam ukázat

Produkční větev nepoužívá Bun ze zdrojů. Spouští sidecar `veslo-server` a jako
pracovní adresář mu nastavuje `app.path().app_data_dir()`
(`spawn.rs:661-724`). Windows release config zároveň záměrně nebalí
`resources/document-runtime/windows-native-x64`; release test to výslovně
označuje jako „Windows package-only“
(`scripts/release/desktop-document-runtime-workflows.test.mjs:9-35`).

`package-only` by samo o sobě bylo v pořádku, pokud by sidecar uměl načíst
provider, stáhnout package feed a runtime nainstalovat do user data. Aktuální
loader ale odkazuje na zdrojový soubor, který v binárce ani v MSI není.

### Projev v UI je zbytečně neprůhledný

Server posílá konkrétní `lastError`, ale pro stav `blocked` UI zobrazuje jen
`repair.blockedReason` a nastaví `action: "none"`
(`packages/app/src/app/lib/document-runtime.ts:220-233`). Uživatel tedy vidí
obecné `document_runtime_provider_unavailable`, ne „chybí modul
`B:\document-runtime\src\index.mjs`“, a nemá možnost opravy.

### Akceptační podmínka opravy

Neřešit to developer override proměnnou. Oprava musí zajistit, že produkční
sidecar načte zabalený provider nebo explicitní produkční modul a že z
čistého app-data adresáře:

1. `GET /document-runtime/status` není `blocked` s
   `document_runtime_provider_unavailable`;
2. při chybějícím package vrací `missing` a `repair.available=true`;
3. `POST /document-runtime/repair` skutečně přejde do package instalace;
4. test běží proti vytaženému `Bin_veslo_server.exe` z finálního MSI, ne jen
   proti `bun test` nebo staging adresáři.

## F2 — P1: WebView2 je povinná, ale MSI ji neinstaluje ani nekontroluje

**Stav:** potvrzená konfigurace a obsah MSI; konkrétní selhání je podmíněné
počítačem bez WebView2 runtime.

**Dopad:** na čistém/enterprise/LTSC Windows bez Edge WebView2 runtime se
nemusí zobrazit funkční aplikační shell.

V `packages/desktop/src-tauri/tauri.conf.json:37-39` je:

```json
"webviewInstallMode": { "type": "skip" }
```

Aktuální dokumentace Tauri pro `skip` říká, že se přeskočí download check a
aplikace nebude fungovat, pokud WebView2 není předinstalovaný. Read-only
inspekce veřejného MSI našla **nula** WebView souborů a **nula** WebView
custom actions. Existuje pouze WSL custom action.

To je vědomá politika: test
`packages/desktop/scripts/tauri-config.test.mjs` výslovně potvrzuje
„Windows MSI does not run a nested WebView2 installer custom action“.
Odstranění nested installeru může být správné kvůli spolehlivosti MSI, ale
bez náhradného prerequisite checku je výsledkem nepodporovaný fresh-machine
stav.

Dev tento problém slabě odhaluje: stroj, na kterém se daří spustit Tauri dev,
už WebView2 typicky má. Nestačí tedy „funguje `pnpm dev`“ ani test na běžném
Windows 11 vývojovém stroji.

**Akceptační test:** čistá Windows VM bez WebView2 musí buď dostat srozumitelný
prerequisite flow, nebo instalace/aplikace musí runtime bezpečně zajistit.
Stejný test je potřeba udělat i s WebView2, aby se nevrátil starý problém s
nested MSI instalátorem.

## F3 — potvrzený kořen rozdílu: dev a aktuální MSI provádějí jiný runtime kontrakt

Tato tabulka popisuje checkout `v2026.7.11` proti veřejnému MSI `v2026.7.11`.
Starou lokální instalaci `26.6.26` popisuje odděleně F0.

| Oblast | `pnpm dev` | Veřejné MSI `v2026.7.11` | Význam pro chyby |
| --- | --- | --- | --- |
| Server | `bun --watch src/cli.ts` | zkompilovaný `veslo-server.exe` | Dev má přístup ke všem zdrojovým relativním importům; MSI ne. F1 je přímý důkaz. |
| Pracovní adresář serveru | `packages/server` | Tauri app-data adresář | Kód závislý na checkoutu nebo `process.cwd()` v instalaci selže. |
| UI | Vite `devUrl` `http://localhost:5173` | statický `frontendDist` | Jiný build-time env, origin a lokální stav. |
| Sidecar fallback | debug povolí externí binárky z `PATH` | release je odmítne, pokud není explicitní developer override | Dev může náhodou používat lokální Bun/Node/OpenCode, kde MSI po chybě bundle správně selže. |
| Orchestrator po bootu | debug build po 1,5 s auto-startuje scratch daemon | release tuto větev vůbec nekompiluje | Dev může maskovat cold-start/race problém, který release musí vyřešit on-demand. |
| Diagnostika | launcher standardně aktivuje Pilot/E2E a runtime/send trace | release build má diagnostiku vypnutou | Produkční chyba má výrazně méně důkazů. |

Bezpečnostní release fallback je konkrétně v
`packages/desktop/src-tauri/src/supervised_process.rs:48-79`: v debug buildu
jsou externí runtime binárky povolené automaticky, v release je chybějící
sidecar odmítnut s chybou:

```text
Bundled <sidecar> sidecar is unavailable (...); refusing to run external <binary> from PATH.
```

To není chyba, kterou je vhodné odstranit. Je to důvod, proč musí package
testovat skutečný release runtime místo spoléhání na nástroje z developerova
`PATH`.

Dev-only orchestrator autostart je pod `#[cfg(debug_assertions)]` v
`packages/desktop/src-tauri/src/lib.rs:424-428`; release tedy tuto pomoc
nemá. Současný frontend obsahuje on-demand recovery, takže zde nebyla
reprodukována aktuální chyba. Přesto jde o reálnou rozdílnou startovní
sekvenci, kterou musí pokrýt fresh-MSI smoke test prvního workspace a prvního
sendu.

## F4 — P2: release diagnostika je přesně opačná než dev diagnostika

Dev launcher bez explicitního vypnutí zapíná manual Pilot runtime, `e2e`
feature, `VESLO_RUNTIME_DIAGNOSTICS=1`, workflow trace, health diagnostiku a
`RUST_BACKTRACE=1` (`tauri-dev.mjs:49-54`, `:171-214`, `:507-534`).

Windows release workflow naopak buildí s:

```text
VESLO_RUNTIME_DIAGNOSTICS=0
VITE_VESLO_RUNTIME_DIAGNOSTICS=0
```

(`.github/workflows/release-macos-aarch64.yml:747-758`). Navíc je výchozí
`support_diagnostics=false`
(`packages/desktop/src-tauri/src/runtime_preferences.rs:24-29`). UI workflow
trace se při tomto nastavení nevytváří a Rust `log_ui_event` ji také odmítá.

To není prvotní příčina F1, ale je to důvod, proč se na instalovaném stroji
snadno objeví jen neurčité „blocked“ bez trace, zatímco dev má plné artefakty.
Pro support reprodukci potřebuje fresh instalace jasně dostupný opt-in
diagnostiky, který se aktivuje **před** prvním pokusem o problematickou akci.

## F5 — P2: čistá MSI instalace nemá dev profil, cache ani dev env

| Rozdíl | Přesný stav |
| --- | --- |
| Tauri identita | release `com.neatech.veslo`; dev `com.neatech.veslo.dev` (`tauri.conf.json:5`, `tauri.dev.conf.json:4`) |
| Dev data | launcher používá `%LOCALAPPDATA%\com.neatech.veslo.dev\veslo-orchestrator-dev`, pokud není nastaven `VESLO_DATA_DIR` |
| Release instalace | MSI má `ALLUSERS=1`; app data a config jsou pro skutečného uživatele oddělené od dev profilu |
| Environment | dev launcher načítá root `.env` (`tauri-dev.mjs:21`); release UI dostane jen build-time hodnoty z CI |
| Frontend | dev používá Vite `devUrl`; release balí `../../app/dist` (`tauri.conf.json:7-10`) |

To neprokazuje jednu konkrétní chybu v aplikaci. Znamená to ale, že přihlášení,
workspace, localStorage feature flag, runtime preference a případná lokální
cache z dev nelze považovat za důkaz, že čistý uživatel projde stejný flow.
Tento rozdíl je zvlášť důležitý u WebView2, WSL a diagnostiky: dev profil už
může mít stav, který fresh MSI teprve vytváří.

## F6 — P2: WSL policy installeru a onboarding flow si odporují

**Stav:** potvrzená nekonzistence; není prokázáno jako hlavní příčina běžného
startu, protože Windows defaultně používá shared unsandboxed engine.

Ve veřejném MSI je `VESLO_ENABLE_WSL_INSTALLER=0`. Jediný WSL custom action
`VesloProvisionWslSandbox` se provede pouze při:

```text
VESLO_ENABLE_WSL_INSTALLER="1" AND NOT REMOVE~="ALL"
```

Defaultní MSI tedy WSL nepřipravuje. To potvrzuje i
`packages/desktop/src-tauri/windows/wsl2-sandbox-installer.wxs:8-10,61`.

Po startu ale `WindowsSandboxRepair` má
`WINDOWS_WSL_SANDBOX_REPAIR_ENABLED = true`, je namountovaný v onboarding i
settings a jednou za app session automaticky volá check/provisioning
(`packages/app/src/app/components/windows-sandbox-repair.tsx:52-175`). Pokud
WSL už existuje, může importovat per-user `VesloSandbox`; pokud neexistuje,
zobrazí warning nebo nabídne ruční elevovaný krok.

V praxi to znamená: čistý MSI install nejdřív WSL nezřídí, ale aplikace po
startu přesto začne WSL kontrolovat. To může vyvolat první viditelnou chybu či
warning, i když runtime ji nakonec nepotřebuje. Současný default
`shared_unsandboxed_engine` je na Windows `true`
(`runtime_preferences.rs:24-39`), proto WSL selhání nemá být blokující. Je
vhodné ověřit, že onboarding tento nonblocking kontrakt opravdu dodržuje na
  čistém Windows bez WSL.

## F7 — P1 testovací mezera: dev se před startem uklidí, instalace a updater musí přežít reálný stav systému

**Stav:** potvrzen rozdíl v kontraktu; zatím není reprodukován konkrétní bug
`26.7.11` na obsazeném portu nebo druhém startu.

Na Windows spouští `tauri-dev.mjs` ve výchozím nastavení
`cleanup-dev-processes.mjs` (pokud není `VESLO_DEV_CLEANUP=0`). Cleanup cíleně
ukončuje jen repo sidecary a Bun watchery z debug/sidecar adresářů a kontroluje
výchozí dev port `8787`. Dev tedy typicky nezačíná se zbytkovým vlastním
serverem ani listenerem.

Nainstalovaná aplikace takový široký cleanup dělat nemůže — nesmí ukončit cizí
uživatelský proces jen proto, že používá stejný port. Musí umět bezpečně rozlišit
svůj stale runtime, cizí listener a nedokončený shutdown. To je přesně větev,
která v běžném `pnpm dev` chybí.

Updater přidává další samostatný kontrakt: před instalací čeká maximálně
`15` sekund na ukončení managed Veslo procesů a Windows update předává MSI
verbose log do `C:\ProgramData\veslo-updater-msi.log`. Čistá instalace ani
source test tento shutdown/upgrade průchod netestují.

**Povinné reprodukce:**

1. Druhý start po nuceném ukončení vlastního runtime: aplikace se buď
   zreconciliuje, nebo zobrazí konkrétní diagnostiku; nesmí tiše timeoutovat.
2. Start s cizím listenerem: cizí proces zůstane nedotčený a uživatel dostane
   rozlišitelnou chybu, ne slepé ukončování procesů.
3. Upgrade `26.6.26 -> 26.7.11` s minimálním produkčním profilem: po upgradu
   ověřit verze sidecarů, první start, Chrome MCP a document-runtime status;
   při selhání uložit updater log.

## Proč prošly současné testy

Všechny tři cílené testy prošly:

```text
9 pass  packages/server/src/tests/server.document-runtime-routes.test.ts
13 pass packages/desktop/scripts/tauri-config.test.mjs
3 pass  scripts/release/desktop-document-runtime-workflows.test.mjs
```

To F1 nevyvrací:

- document-runtime unit test vkládá vlastní provider loader; netestuje výchozí
  `loadDefaultDocumentRuntimeProvider()` uvnitř `bun --compile` exe;
- release policy test správně ověřuje, že Windows je package-only, ale
  neověřuje, že package-only provider lze z vydaného sidecaru načíst;
- release workflow volá
  `verify-bundled-versions.mjs` nad
  `target/<triple>/release` (`release-macos-aarch64.yml:1010-1015`). Script
  kontroluje soubory ve staging adresáři, nikoli HTTP chování sidecaru
  vytaženého z finálního MSI.
- žádný z těchto testů neinstaluje starší MSI, neprovádí upgrade ani nezakládá
  stav po nuceném ukončení/obsazeném portu. Nemůže tedy zachytit F0 ani F7.

## Co aktuální veřejný MSI `26.7.11` naopak nemá

Tyto dřívější podezřelé body jsem ověřil, aby se oprava nezaměřila špatně:
Tabulka se úmyslně nevztahuje na lokálně nainstalovaný `26.6.26`; ten je popsán
ve F0.

| Podezření | Výsledek v aktuálním veřejném MSI |
| --- | --- |
| Chybí Windows Node runtime | Ne. `Bin_veslo_node.exe` je v MSI a má `85,588,976` bytů. |
| Windows release config se neslučuje | Ne. Workflow explicitně používá `--config src-tauri/tauri.windows.release.conf.json`; aktuální MSI obsahuje i Windows sidecary. |
| MSI je nepodepsané / blokuje jej neplatný podpis | Ne. `Get-AuthenticodeSignature` vrací `Valid`; podpis je pro Neatech. |
| WSL custom action se spouští vždy | Ne. Property má default `0` a action je opt-in. |

## Doporučené pořadí práce

1. **Srovnat release před další reprodukcí.** Pro aktuální post-install bug
   nejdříve nainstalovat přesně `26.7.11`; pro současnou lokální instalaci
   ponechat samostatný scénář `26.6.26`. Upgrade testovat výhradně jako
   `26.6.26 -> 26.7.11`.
2. **Opravit F1 a přidat artifact-level regresní test.** Je to jediný nález,
   který jsem přímo reprodukoval z reálného veřejného MSI `26.7.11` s přesnou
   chybou. Test musí volat `/document-runtime/status` proti sidecaru z finálního
   MSI a bez source checkoutu.
3. **Rozhodnout WebView2 policy.** Buď podporovat pouze stroje s WebView2 a
   detekovat to před použitím, nebo dodat bezpečný prerequisite mechanismus.
4. **Zavést clean-install a upgrade smoke lane.** Musí používat nový Windows
   user profile, prázdný app-data adresář, žádný repo checkout jako CWD a pouze
   binárky vytažené/instalované z finálního MSI. Testovat bez hostitelského
   Node/npm/Bun na `PATH`.
5. **Do lane zařadit přesné stavy:** document-runtime status + repair, Chrome
   MCP z bundled Node/package, první workspace, první send/on-demand engine
   start, stav bez WSL, druhý start po pádu, cizí listener a upgrade/updater
   diagnostiku.

Nejdůležitější změna v testovacím přístupu je jednoduchá: `pnpm dev` a testy
nad zdroji nesmějí být release gate pro code path, který v produkci běží jako
zkompilovaný Bun sidecar.

## Povinná artifact-level akceptační matice

| Scénář | Vstupní stav | Povinný důkaz | Release blocker |
| --- | --- | --- | --- |
| Čistá instalace `26.7.11` | nový Windows user, prázdná app data, bez hostitelského Node/npm/Bun | verze a sidecary z Program Files; první start; Chrome MCP z bundled payloadu | hostitelský Node je nutný, chybí resource nebo app nedojde do připraveného stavu |
| Document runtime `26.7.11` | sidecar vytažený z finálního MSI nebo skutečná instalace, bez source checkoutu | `/document-runtime/status` vrací `missing` + `repair.available=true` při chybějícím package, ne `blocked` | `document_runtime_provider_unavailable`, zdrojová `B:\...` cesta nebo nefunkční repair |
| WebView2 absence | čistá VM/image bez Evergreen WebView2 | runtime se dodá, nebo produkt zobrazí konkrétní prerequisite/repair stav | prázdné okno nebo tiché selhání |
| Upgrade | `26.6.26` + minimální produkční profil -> přesně `26.7.11` | nové sidecar verze, první start, document runtime a Chrome MCP | starý payload zůstane, migrace/start selže nebo chybí updater log |
| Druhý start | nuceně ukončený vlastní runtime; samostatně cizí listener | vlastní stale runtime se bezpečně zreconciliuje; cizí proces zůstane běžet | tichý timeout nebo ukončení cizího procesu |
| WSL bez instalace | čistý Windows bez WSL | základní non-sandbox engine projde onboardingem; WSL je jen volitelný repair | onboarding blokuje běžné použití |
