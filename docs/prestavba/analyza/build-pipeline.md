# Analýza: Build a release pipeline Veslo

Analyzovaný kořen: kořen repozitáře

## Účel a rozsah

Build a release pipeline pokrývá: přípravu 5+ sidecar binárek, build SolidJS UI, Tauri bundle (macOS .app/.dmg, Windows MSI/NSIS, Linux deb/rpm/AppImage), podepisování (Apple codesign + notarizace, Azure Artifact Signing pro Windows, minisign pro Tauri updater), publikaci na GitHub Releases (interní repo `neatechcz/veslo` + veřejný mirror `neatechcz/veslo-updates`), generování updater feedu `latest.json`, npm publish tří balíčků a „document-runtime" resource feed.

Odhad rozsahu čistě pipeline kódu (bez aplikačního kódu):

| Oblast | Rozsah |
|---|---|
| `scripts/release/` (48 souborů) | ~11 200 řádků (z toho ~4 500 testy `.test.mjs`, 1 859 ř. `verify-windows-msi-installed.ps1`, 755 ř. `verify-windows-msi-runtime.ps1`) |
| `packages/desktop/scripts/` | 3 731 řádků (`prepare-sidecar.mjs` 1 415, `tauri-dev.mjs` 581, `tauri-before-dev.mjs` 281, …) |
| `.github/workflows/` (14 souborů) | 4 224 řádků (`release-macos-aarch64.yml` **1 567 ř. / 64 kB**, `prerelease.yml` 619, `build-staging-app.yml` 488) |
| Tauri konfigurace | **9 variant** `tauri.*.conf.json` (base, dev, e2e, staging, macos.aarch64.release, macos.x64.release, windows, windows.release, windows.staging) |
| Kořenový `package.json` | ~80 npm skriptů (`package.json:5-81`) |
| `scripts/document-runtime/` + `scripts/release/verify-document-runtime*` | ~1 800 řádků |

Celkem řádově **20 000 řádků kódu jen na build/release** — srovnatelné s menší aplikací.

## Architektura a klíčové soubory

### Vstupní body

- `pnpm build` → `scripts/build.mjs` (9 řádků) → `pnpm --filter @neatech/veslo build` → `tauri build`. Pozor: na Vercelu skript volá `pnpm --dir services/veslo-share run build`, ale **adresář `services/veslo-share` neexistuje** (je `services/openwork-share`) — mrtvá/rozbitá větev (`scripts/build.mjs:4-6`).
- `tauri.conf.json` `beforeBuildCommand` (`packages/desktop/src-tauri/tauri.conf.json:8`): `prepare:sidecar` + `build:desktop-ui`.
- `pnpm dev` → `packages/desktop/scripts/tauri-dev.mjs` (581 ř.) — obaluje `tauri dev`, zapíná „manual pilot runtime" s ~25 diagnostickými env proměnnými (trace soubory, mirror trace soubory, pilot socket…), na Windows migruje legacy data dir včetně inline SQLite merge skriptu (řádky 363-499).
- `beforeDevCommand` → `tauri-before-dev.mjs` (281 ř.) — spouští `prepare-sidecar.mjs --force` a hlídá/spouští Vite.

### prepare-sidecar.mjs — jádro sidecar modelu (1 415 řádků)

`packages/desktop/scripts/prepare-sidecar.mjs` při každém buildu:

1. **veslo-server** — `bun build --compile` z `packages/server/src/cli.ts` (build vždy, bez cache — komentář na ř. 840-842: verze balíčku se nemění při každé editaci, takže cache nelze věřit).
2. **veslo-code** — **stažení binárky OpenCode enginu z GitHub releases forku `anomalyco/opencode`** (ř. 61-74, 935-1048). Verze pinovaná v `packages/desktop/package.json` (`opencodeVersion: 1.17.13`); bez pinu se stahuje „latest" z GitHub API (ř. 94-116) → **nedeterministický build**. Stahuje se přes `curl`/PowerShell `Invoke-WebRequest`.
3. **symlink `opencode` → `veslo-code`** (ř. 1050-1074) — engine se interně ověřuje přes `which opencode`, takže binárka musí existovat i pod původním jménem.
4. **veslo-code-router** — `bun build --compile` z `packages/opencode-router` (verzová cache přes `--version` spawn).
5. **veslo-orchestrator** — `bun build --compile` z `packages/orchestrator`.
6. **chrome-devtools-mcp** — Bun-kompilovaný **shim** (`chrome-devtools-mcp-shim.ts`, 75 ř.), který za běhu spouští vendorovaný npm balíček `chrome-devtools-mcp-package/` přes **bundlovaný Node.js runtime `veslo-node`** (protože balíček pod Bunem neběží). K tomu se celý npm balíček kopíruje do `sidecars/` (ř. 465-485).
7. **veslo-node** — stažení a checksum-verifikace celé distribuce Node.js 22.20.0 z nodejs.org (ř. 725-823) pro Windows a macOS targety.
8. **opencode-managed-deps.json** — manifest, kde jsou **celé soubory npm balíčků (`@opencode-ai/plugin`, `zod`, `@ai-sdk/*`, …) zakódované base64 uvnitř JSON** (ř. 493-714), aby je Rust mohl při provisioningu workspace rozbalit bez npm install. Skript validuje přesný dependency graf a shodu verze `@opencode-ai/plugin` s verzí OpenCode (ř. 686-691).
9. **versions.json** — manifest verzí + SHA-256 všech sidecarů; na Windows se hash počítá speciálně bez Authenticode sekce (`scripts/release/windows-authenticode-hash.mjs`).

Každá binárka se udržuje ve **3 kopiích** (kanonické jméno, `-<target-triple>`, `-<bun-target>`): adresář `sidecars/` má na disku **922 MB**.

### Co je v zabaleném .app

`target/release/bundle/macos/…/Contents/MacOS/` (ověřeno na reálném buildu):

| Soubor | Velikost |
|---|---|
| `veslo` (Tauri shell, Rust) | **11 MB** |
| `veslo-code` (OpenCode engine) | 104 MB |
| `opencode` (tatáž binárka — symlink se při bundlování rozbalil na plnou kopii) | **104 MB duplikát** |
| `veslo-orchestrator` (Bun runtime + TS) | 67 MB |
| `veslo-code-router` (Bun runtime + TS) | 62 MB |
| `veslo-server` (Bun runtime + TS) | 62 MB |
| `chrome-devtools-mcp` (Bun runtime + 75ř. shim) | 61 MB |

≈ **460 MB binárek, z toho vlastní aplikace 11 MB (2,4 %)**. Každá Bun-kompilovaná binárka nese vlastní ~60MB kopii Bun runtime — 4 kopie Bunu v jednom bundlu. `externalBin` navíc obsahuje hack: **JSON soubory (`versions.json`, `opencode-managed-deps.json`) deklarované jako spustitelné binárky** (`tauri.conf.json:67-76`), což se pak musí obcházet při Windows podepisování (`RELEASE.md:68`).

### Runtime vazba (proč sidecary existují)

Rust spouští jen `veslo-orchestrator` (`src-tauri/src/commands/orchestrator.rs:840` přes `supervised_process::sidecar`) s argumenty `start --workspace … --veslo-port … --veslo-token … --detach`; orchestrátor pak sám spouští engine (opencode), veslo-server a router. Desktop umí spustit i `veslo-server` přímo (`src-tauri/src/veslo_server/spawn.rs:722`). Komunikace výhradně **HTTP na localhost + tokeny** (a SSE — viz komentář VSLO-86 v `Cargo.toml` o reqwest streamu).

### Release orchestrace

- `pnpm release:prepare` (`scripts/release/prepare.mjs`, 131 ř.): bump → lockfile → `build:sidecars` → `review.mjs --strict` → commit → tag.
- `pnpm release:prod` (`dispatch-production.mjs`, 421 ř.): push tagu + `workflow_dispatch` „Release App" + watch.
- **`review.mjs` (835 ř.)** — „release lint": načte 5 tauri confů, 5 workflow YAMLů **jako text** a kontroluje je **regexy a fragmenty řetězců** (`extractWorkflowJob`, `hasOrderedFragments`, `hasGlitchTipReleaseEnv`, …). Extrémně křehké — každá úprava workflow může rozbít review a naopak.
- `generate-latest-json.mjs` (240 ř.): sestaví Tauri updater feed z assetů GitHub releasu (jména `veslo-desktop-<os>-<arch>.*` + `.sig`).
- `mirror-public-release.mjs` (191 ř.): kopíruje assety z interního repa do veřejného `neatechcz/veslo-updates`.
- Verze se bumpuje do **7 souborů najednou** (`packages/app/scripts/bump-version.mjs`): 5× `package.json`, `Cargo.toml` (+ regenerace `Cargo.lock`), `tauri.conf.json` (+ odvozená WiX verze `26.7.12` z `2026.7.12`).

### GitHub workflow „Release App" (`release-macos-aarch64.yml` — název lže, 1 567 ř.)

9 jobů: resolve-release → verify-release (strict review) → publish-tauri (matrix macOS arm64+x64: document-runtime feed, OpenCode download, GlitchTip source-map pipeline, signed build, notarizace+staple přes `notarize-macos-assets.sh`, upload) → publish-tauri-windows (Azure login, Artifact Signing dlib, signtool preflight, MSI payload gate, Authenticode verify) → mirror-public-release → publish-updater-json → publish-public-release → release-orchestrator-sidecars → publish-npm. K tomu `prerelease.yml` (push na `dev`), `build-staging-app.yml` (488 ř., staging podepsané buildy bez updateru), `build-desktop.yml`/`build-windows-msi.yml` (manuální), `quality.yml`, `ci*.yml`.

### Web režim už existuje

`pnpm dev:web` → `scripts/dev-headless-web.ts` (279 ř.): spustí orchestrátor pod Bunem (`--workspace … --allow-external --veslo-port … --veslo-token …`), veslo-server + router jako obyčejné binárky a Vite UI — **celý stack běží bez Tauri, komunikace čistě HTTP s tokeny**. Totéž `scripts/headless-services.mjs` pro integrační testy. Web model (server + prohlížeč) tedy není hypotéza — je to existující, funkční dev režim, jen je v `AGENTS.md` zakázán jako verifikační runtime.

## Komunikační vazby

| Odkud → kam | Kanál | Poznámka |
|---|---|---|
| Tauri (Rust) → veslo-orchestrator | spawn sidecar + CLI argumenty (port, tokeny) | `commands/orchestrator.rs:840` |
| orchestrátor → veslo-code (OpenCode), veslo-server, router | spawn podprocesů | mimo rozsah této části |
| UI ↔ veslo-server / OpenCode engine | HTTP + SSE na localhost, Bearer/Basic tokeny | SSE streamováno v Rustu přes reqwest (VSLO-86) |
| prepare-sidecar → internet | HTTPS stahování při buildu: GitHub releases (OpenCode fork, Bun baseline), nodejs.org (Node runtime) | build **vyžaduje síť** |
| aplikace → updater | HTTPS: `neatechcz/veslo-updates/releases/latest/download/latest.json` (`tauri.conf.json:93`) | minisign pubkey v repo |
| release workflow → GitHub API | `gh` CLI + REST (release create/upload/mirror) | dvě repa (interní + veřejné) |
| build → GlitchTip/Sentry | source-map upload (`build-desktop-ui.mjs`), pak mapy z bundlu smaže | volitelné, fail-open |
| bump-version → 7 souborů | soubory | jediný zdroj pravdy o verzi neexistuje, jen synchronizace |

## Vazba na OpenCode

- Engine je **cizí binárka z forku `anomalyco/opencode`**, stahovaná při buildu, přejmenovaná na `veslo-code` + zpětný symlink `opencode` kvůli internímu `which opencode` checku (`prepare-sidecar.mjs:1050-1057`).
- Verze OpenCode je zafixovaná na **3 místech**: `packages/desktop/package.json` (`opencodeVersion`), `packages/orchestrator/package.json` (`opencodeVersion` + dependency `@opencode-ai/plugin`/`@opencode-ai/sdk` 1.17.13) — a prepare-sidecar tvrdě vynucuje shodu (`prepare-sidecar.mjs:686-691`).
- `opencode-managed-deps.json` váže bundle na přesný dependency graf `@opencode-ai/plugin` — každý upgrade OpenCode = přegenerování manifestu, jinak build spadne.
- Release workflow má vlastní krok „Download OpenCode sidecar" duplikující logiku prepare-sidecar (workflow ř. 456-515).
- **Výměna enginu** by se v pipeline dotkla: prepare-sidecar (download+symlink+managed-deps, ~700 ř.), release workflow (download krok, verze), review.mjs (kontroly), bump-version, versions.json manifestu. Pipeline je na OpenCode navázaná středně těsně — ne API, ale distribucí (binárka + verzový zámek + plugin graf).

## Hotspoty složitosti

1. **`prepare-sidecar.mjs` (1 415 ř.)** — buildový skript, který stahuje z internetu, kompiluje 4 Bun binárky, spravuje 3 kopie každé, dělá verzové cache přes `--version` spawn, detekuje „stub" binárky čtením hlaviček, generuje base64 manifest npm balíčků a píše 2 manifesty. Jediný soubor kombinuje ~8 zodpovědností.
2. **`release-macos-aarch64.yml` (1 567 ř., 64 kB)** — jeden YAML pro macOS×2, Windows, mirror, updater, npm i sidecar release; název souboru neodpovídá obsahu. Netestovatelné jinak než ostrým release.
3. **`review.mjs` (835 ř.)** — regexový lint YAML workflow; nutnost jeho existence je sama o sobě signál, že pipeline je příliš křehká na to, aby se jí věřilo.
4. **Windows MSI gate** — 1 859 + 755 řádků PowerShellu (`verify-windows-msi-installed.ps1`, `verify-windows-msi-runtime.ps1`) + ruční checklist v `RELEASE.md:76-113` (disposable VM, 7 scénářů, WebView2 s/bez sítě).
5. **Sidecar hmotnost** — 4× Bun runtime + 1× Node runtime + 2× OpenCode engine v jednom bundlu; ~460 MB.
6. **chrome-devtools-mcp** — 3 vrstvy (Bun shim → Node runtime → vendorovaný npm balíček) pro jeden MCP server.
7. **Verze na 7 místech** + odvozená WiX verze + 3 místa pinu OpenCode.
8. **9 variant tauri confu** + inline JSON configy generované za běhu (`tauri-dev.mjs:525-536`).
9. **GlitchTip source-map pipeline** (`build-desktop-ui.mjs`, 310 ř.) — inject debug ID, upload, strip map, assert; zapletená do release i staging workflow.
10. **Pipeline má vlastní testovací suite** (~4 500 ř. `.test.mjs` v `scripts/release/` + testy v `packages/desktop/scripts/`) — testuje se build systém, ne aplikace.

## Duplicity a mrtvý kód

- **`opencode` = plná kopie `veslo-code`** v bundlu (104 MB ×2) — symlink se při Tauri bundlování materializuje.
- **3 kopie každé sidecar binárky** v `sidecars/` (922 MB na disku).
- **`sidecars/opencode-router`** — 101bajtový stub „Sidecar missing" — mrtvý pozůstatek přejmenování na `veslo-code-router`.
- **`scripts/build.mjs` Vercel větev** odkazuje na neexistující `services/veslo-share` → mrtvá/rozbitá.
- **`veslo-node` pro macOS**: `prepare-sidecar.mjs:736-801` pečlivě stahuje a checksum-verifikuje Node pro mac targety, ale **žádný macOS tauri conf ho nebundluje** (jen `tauri.windows.conf.json:10`); mac shim pak spadne na systémový `node`. Buď mrtvá práce, nebo chybějící bundle entry.
- Download OpenCode binárky implementován **2×** (prepare-sidecar.mjs + inline v release workflow).
- Aliasy skriptů: `build:ui` = `build:web` = `dev:web:ui`; `dev:web` = `dev:headless-web`.
- Skill `veslo-release` udržovaný ve **2 kopiích** (`.opencode/skills/` a `.claude/skills/`, `RELEASE.md:7`).
- 12 `audit-*.mjs` skriptů v `scripts/` — vlastní statická analýza vedle ESLint/knip.
- `RELEASE.md` vs realita: dokument v zásadě odpovídá kódu (ověřeno proti workflow a skriptům), ale sám je 169 řádků procesu s ručními kroky (VM verifikace, evidence) — dokumentuje složitost, neredukuje ji.

## Co by znamenalo oddělení BE/FE (web model: API + SPA)

Existující `dev:web` dokazuje, že architektura to už umí. V čistém web modelu (server proces + prohlížeč) by **odpadlo**:

- Celý `prepare-sidecar.mjs` (1 415 ř.) — server, orchestrátor i router by běžely jako normální Node/Bun procesy z `node_modules`/zdrojáků, žádné `bun build --compile`, žádné 60MB Bun runtime kopie, žádný veslo-node, žádný chrome-devtools shim (stačí `npx chrome-devtools-mcp`).
- Tauri vrstva podepisování a distribuce: Apple codesign + notarizace + staple, Azure Artifact Signing, minisign updater, MSI/WiX/NSIS/WebView2, `latest.json`, mirror repo, staging app workflow — tj. odhadem **~80 % z 4 224 ř. workflow a ~70 % z 11 200 ř. `scripts/release/`** (včetně 2 600 ř. PowerShell gate).
- `review.mjs` v dnešní podobě (kontroluje hlavně desktop release invarianty).
- 9 tauri confů, externalBin hacky s JSON „binárkami", bundlovaná duplicitní OpenCode binárka.
- Source-map stripping akrobacie (server-side deployment map problém řeší triviálně).

**Zůstalo by**: Vite build SPA, build/spuštění serveru + orchestrátoru, stažení/instalace OpenCode enginu (může se přesunout z build-time do install-time/first-run, jak to dělá např. `veslo-orchestrator build:sidecars` distribuce), verzování, document-runtime feed (pokud funkce přežije). **Nově by vzniklo**: instalace/aktualizace serveru u uživatele (npm balíček nebo installer), auth vrstva pro ne-localhost přístup, ztráta nativních integrací (deep-link, tray, dialogy, updater UX) — ty ale pipeline zatěžují právě těmi odpadajícími 80 %.

Střední cesta (zachovat desktop): **zredukovat sidecary na 2** — engine (OpenCode) + jeden „veslo-host" proces (server+orchestrátor+router sloučené do jednoho Bun compile) — by srazila bundle o ~250 MB a prepare-sidecar o víc než polovinu, bez ztráty desktop podoby.

## Náměty na zjednodušení

1. **Sloučit veslo-server + veslo-orchestrator + veslo-code-router do jednoho procesu/binárky.** Orchestrátor je stejně jediné, co Rust spouští; zbytek si spouští sám. −2 binárky, −120 MB, −⅓ prepare-sidecar. (střední náročnost)
2. **Zrušit duplicitní `opencode` kopii** — buď engine nechat jmenovat `opencode`, nebo vyřešit `which opencode` check jinak (env/patch forku). −104 MB okamžitě. (nízká)
3. **chrome-devtools-mcp přestat bundlovat** jako Bun shim + Node runtime; instalovat on-demand při prvním použití (npx / managed install). −61 MB + smazání shim/veslo-node logiky. (nízká–střední)
4. **Přesunout stahování OpenCode enginu z build-time na first-run** (s checksum manifestem) → deterministické, offline-schopné buildy a menší installer. (střední)
5. **Rozdělit `release-macos-aarch64.yml`** na workflow per platforma + reusable workflow; přejmenovat. Zvážit `tauri-action` místo ručních kroků. (střední)
6. **Jeden zdroj verze** (např. root soubor VERSION + generování ostatních při buildu) místo bump skriptu přepisujícího 7 souborů. (nízká)
7. **Zrušit `review.mjs` regex lint** ve prospěch méně workflow souborů a méně invariantů — lint je symptom, ne lék. (střední)
8. **Smazat mrtvé**: `sidecars/opencode-router` stub, Vercel větev `build.mjs`, macOS veslo-node provisioning (nebo ho dobundlovat a sjednotit), duplicitní OpenCode download ve workflow. (nízká)
9. Při přechodu na web model: smazat celé Windows/macOS signing+MSI gate větve (~5 000 ř.) a updater/mirror pipeline (~800 ř.). (vysoká, ale největší výnos)

## Rizika

- **Nedeterminismus buildů**: bez `OPENCODE_VERSION` pinu se stahuje „latest" engine (`prepare-sidecar.mjs:919-921`); build vyžaduje dostupnost GitHub/nodejs.org/oven-sh.
- **Křehkost review ↔ workflow**: `review.mjs` kontroluje YAML regexy — false pass i false fail při každé změně; release jde zablokovat kosmetickou úpravou workflow.
- **Verzový drift**: 7 synchronizovaných souborů + 3 piny OpenCode; jediná nesrovnalost zastaví release (dobře), ale i legitimní změnu (špatně).
- **Jediný netestovatelný release workflow**: 1 567řádkový YAML se ověří jen ostrým release; chyby se projeví až při publikaci.
- **Signing závislosti třetích stran**: Azure Artifact Signing má zdokumentované záseky (`RELEASE.md:74`), Apple notarizace timeout 30 min — release může viset na externích službách.
- **922 MB `sidecars/` + `VESLO_SIDECAR_FORCE_BUILD=1` v CI** → dlouhé buildy, velké artefakty, pomalá iterace.
- **Hack externalBin s JSON soubory** — spoléhá na nedokumentované chování Tauri (JSON projde jako „binárka"), může se rozbít s upgradem Tauri; už teď vyžaduje výjimku v Windows podepisování.
- **Šifra dvou repozitářů** (interní release + veřejný mirror + updater feed) — tři místa, kde může být release nekonzistentní.
