# Analýza git historie Veslo (3 881 commitů)

## Účel a rozsah

Analýza historie tohoto repozitáře s cílem zjistit, kde žije složitost, co se pořád rozbíjí a co z historie plyne pro rozhodnutí o zjednodušení (oddělení BE/FE, vyhazování částí, případný přepis).

**Základní čísla:**

- Celkem **3 881 commitů**, první commit **2026-01-13**, poslední **2026-07-19** — celá historie repa je stará jen ~6 měsíců (3 737 commitů spadá do okna „posledních 6 měsíců“). Nejde tedy o „posledních 6 měsíců z dlouhé historie“, ale o **kompletní život projektu**.
- Tempo: **~20 commitů denně** v průměru, špičky 136 commitů/den (2026-06-06), 88 (2026-05-24), 84 (2026-07-02). Takové jednodev­né dávky desítek commitů (např. 2026-07-12: ~35 commitů jen na `services/ai-gateway` model policy) jsou typický otisk AI-asistovaného „commit stormu“.
- Rozložení po měsících je rovnoměrně vysoké: 376 (led), 758 (úno), 540 (bře), 468 (dub), 504 (kvě), 637 (čvn), 454 (čvc do 19.). **Projekt se nikdy nezklidnil.**

**Původ projektu (klíčové zjištění):** Repozitář je fork upstreamu **different-ai/OpenWork** (viz merge „Merge pull request #148 from different-ai/feat/logo-refresh“ a commit `e0416cd9` z 2026-01-13 „Rebrand metadata for different-ai“). Upstream autoři (Benjamin Shafii 635 commitů + „ben“ 341) přispívali od 2026-01-13 do **2026-03-12**, pak přebírá tým Neatech: **Giltar 1 588 commitů** (2026-03-06 až 2026-07-15), David 354, MichalNeatech 300, Pavel Vejnar 145, Codex (bot) 65. Rebrand OpenWork→Veslo proběhl v sérii pěti velkých rename commitů 2026-03-07 (`717724b0`, `47b43010`, `4de30474`, `2de21718`, `47866f59`) — tedy **Neatech zdědil cca 1 900 upstream commitů kódu, který sám nenapsal**, a od března ho ~4,5 měsíce intenzivně přepisuje.

## Architektura a klíčové soubory (pohled historie)

Nejčastěji měněné soubory za celou historii (bez lockfiles a version-bump šumu):

| Soubor | Změn celkem | Z toho ve „fix“ commitech | Aktuální délka |
|---|---|---|---|
| `packages/app/src/app/app.tsx` | **619** | **288** | 5 339 řádků |
| `packages/app/src/app/pages/session.tsx` | 358 | 176 | 5 012 řádků |
| `packages/app/src/app/pages/dashboard.tsx` | 250 | 100 | 1 446 řádků |
| `packages/server/src/server.ts` | 212 | 78 | 4 883 řádků |
| `packages/app/src/app/context/workspace.ts` | 171 | 89 | 1 805 řádků |
| `packages/app/src/app/pages/settings.tsx` | 153 | 63 | 2 398 řádků |
| `packages/app/src/app/components/session/workspace-session-list.tsx` | 141 | 65 | 2 990 řádků |
| `packages/app/src/app/context/session.ts` | 117 | 60 | 1 168 řádků |
| `packages/app/src/app/components/session/composer.tsx` | 112 | 60 | — |
| `packages/app/src/app/components/session/message-list.tsx` | 84 | 44 | — |
| `packages/desktop/src-tauri/src/commands/engine.rs` | 70 | 43 | 1 970 řádků |
| `packages/desktop/src-tauri/src/lib.rs` | 84 | 31 | 448 řádků |

Pozn.: `tauri.conf.json` (260 změn), `Cargo.toml` (251) a jednotlivé `package.json` jsou v žebříčku vysoko jen kvůli release automatizaci — u `tauri.conf.json` je 217 z 256 commitů typu „bump/version/release“. Nejsou to skutečné hotspoty.

**Interpretace:** `app.tsx` (5 339 řádků) byl změněn ve **149 ze ~185 dní existence repa** (80 % všech dní) a opravován ve 121 různých dnech. To je monolitický „god file“ frontendu, kterým protéká prakticky každá změna. Spolu se `session.tsx` (5 012 ř.) a `server.ts` (4 883 ř.) tvoří tři obří soubory, které soustřeďují většinu churnu celého repa.

Za poslední 3 týdny se změny koncentrují takto: `packages/app` 2 341 dotčených souborů-výskytů, `packages/server` 611, `docs` 504, `services/ai-gateway` 353, `packages/e2e` 342, `packages/desktop` 229, `services/den` 211 — **frontend generuje 4× víc churnu než cokoli jiného**.

## Komunikační vazby (co o nich vypráví historie)

Historie commitů dokumentuje opakované přestavby komunikačních kanálů:

- **SSE (engine → UI):** 69 commitů zmiňuje SSE. Kanál byl přestavěn minimálně třikrát: `661d4475` (2026-05-26) „route global SDK SSE through Rust proxy with Bearer auth“, `1dffda5e` (2026-05-26) „unblock sidebar by holding engine SSE in Rust“, dále „SSE ENGINE, DEPRECATED TOKEN, RUNTIME READINESS“ (2026-07-09) a `88c7fb3c` (2026-07-12) „Runtime missed SSE workspace fix“. SSE tedy teče **z OpenCode enginu přes Rust proxy do UI** — a i po třech přestavbách se v červenci stále opravovalo „missed SSE workspace“.
- **Tauri IPC:** průběžně se přidávají a zase odebírají příkazy — `e15366f6` (2026-05-20) „remove 4 sandbox Tauri IPC commands“; hotspot `packages/desktop/src-tauri/src/commands/engine.rs` (70 změn, 43 fixů).
- **HTTP na OpenCode API:** orchestrator předává portu a Basic auth přes argumenty procesu; churn v `packages/orchestrator/src/cli.ts` (76 změn, 31 fixů).
- **Kontrakt app ↔ veslo-server:** samostatný dokument `docs/dev/veslo-server-app-contract.md` byl změněn **41×** — kontrakt mezi FE a lokálním serverem je nestabilní a průběžně se předefinovává. Podobně `docs/dev/state-and-config-reference.md` **126 změn** a `docs/features/session-runtime.md` **94 změn** — dokumentace stavu/konfigurace se přepisuje prakticky každý týden, což je symptom nestabilní architektury, ne špatné dokumentace.

## Vazba na OpenCode

- 170 commitů explicitně zmiňuje „opencode“. Projekt je fork nadstavby nad OpenCode a vazba je všudypřítomná: sidecar `veslo-code` (OpenCode engine), `opencode-router`, `.opencode/` konfigurace, `opencode.jsonc` (10 změn jen za poslední 3 týdny).
- Historie ukazuje, že tým vazbu na engine spíš **prohlubuje než izoluje**: SSE stream enginu se drží v Rustu (`1dffda5e`), provisioning workspace je zdvojen v TS i Rustu (viz CLAUDE.md pravidlo o `internal-system.ts` ↔ `internal_provision.rs`; `internal_provision.rs` má 18 fix commitů), a „opencode runner“ se řeší i v instalátorech (`30fbc0b9`, 2026-07-04 „plugins, installers, hashes, opencode runner“).
- Přejmenovávání balíčků kolem OpenCode proběhlo opakovaně: `owpenbot` → `opencode-router` (`32cc853d`, PR #567), `openwrk` → `openwork-orchestrator` (`6284b581`, PR #573) → dnes `orchestrator`. Každé přejmenování znamenalo vlnu oprav cest a CI.

**Závěr z historie:** výměna enginu by zasáhla minimálně orchestrator, Rust desktop (engine.rs, SSE proxy, provisioning), server a velkou část FE kontextů — historie neukazuje žádnou abstrakční vrstvu, která by engine izolovala; naopak fixy engine chování jsou rozprostřené napříč všemi vrstvami.

## Hotspoty složitosti

### 1. Podíl oprav je trvale ~1/3 všech commitů a neklesá

- Striktní prefix `fix:`/`hotfix:`: **1 164 z 3 737 commitů (31 %)**.
- Širší heuristika (fix/fixed/revert/repair/broken kdekoli v subjektu): **1 270 (34 %)**.
- `feat:` prefix: 647 (17 %). Revert commitů 10–19 (málo — ale viz níže, opravy se dělají „fix na fix“, ne revertem).
- Po měsících: 121/376, 244/758, 173/540, 187/468, 210/504, 220/637, 117/454 — podíl oprav **osciluje mezi 32–42 % a v čase se nezlepšuje**. Projekt nikdy nedosáhl stabilizační fáze.

### 2. `app.tsx` — permanentně hořící soubor

Fix commity na `app.tsx` po měsících: 31, 57, 39, 48, 33, 47, 31 — **každý měsíc 30–57 oprav téhož souboru po celou dobu života projektu**. Soubor o 5 339 řádcích, kterým prochází sidebar, routing, workspace přepínání, session lifecycle i auth. Je to nejsilnější jednotlivý argument pro přepis/rozbití FE.

### 3. Session send-path a „truthfulness“ transkriptu

Poslední týdny (viz níže) jsou z velké části boj s tím, aby se odeslaná zpráva zobrazila právě jednou a transkript odpovídal realitě: `dc308636` (2026-07-16) „SEND WAY - DUPLICATES, MULTIPLE EFFECTS ETC..“, `b4304720` „first send + reactivity“, `771b1437` „first message transcript bug“, `27ff3b59` (2026-07-13) „send transcripts and truthfulness - new archi.“, `c61ad577` „UI flickering and session transcription“, `d4b62024` „UI session writer flickering fixes“. Reaktivní model SolidJS + externí SSE stream + optimistické UI se tu opakovaně rozjíždějí.

### 4. Sidebar — přestavěn minimálně 3×

219 commitů zmiňuje sidebar, rozprostřených od ledna do července: `22033ca1` (2026-02-26) „unify sidebar navigation and workspace switching“, `1dffda5e` (2026-05-26) „unblock sidebar by holding engine SSE in Rust“, `f4b7d119` + `0dab96c7` (2026-07-13) „sidebar writer and UI event dispatcher“ / „sidebar workspace sessions listings“. Tatáž funkce (seznam workspace/sessions vlevo) se řeší celou historii.

### 5. Multi-workspace a race conditions

164 commitů zmiňuje stuck/freeze/hang/race. Květnová epopej VSLO-86 (multi-workspace stabilizace) čítá sérii `f0fa9724`, `e8d2982a`, `e740588e`, `b10ea2c8`, `92e1c495`, `211bb8f1`, `661d4475`, `1dffda5e`, `b211e5a0`, `60c5d93d` — deset a více commitů na jeden ticket, včetně přesunu SSE do Rustu a zásahů do workspace ID schématu (`stable_workspace_id` vs. SHA1 orchestrátoru).

### 6. Release/CI pipeline jako trvalý zdroj práce

135 commitů zmiňuje release, 87 sidecar, 40 updater, 23 installer. `.github/workflows/release-macos-aarch64.yml` má 85 změn (38 ve fix commitech), `prepare-sidecar.mjs` 51 změn (30 fixů). Poslední den historie (2026-07-19) je celý o opravách Windows release pipeline: `8b9cd60a`, `c7188345`, `1e8b05b9`, `da82b802`, `754a2cdb`, `18ca5acf`, `0cf8cd8b`, `a2778ddb` — osm CI fixů za jeden den. Skládání pěti sidecar binárek do Tauri bundlu je křehké a drahé na údržbu.

### 7. Testovací infrastruktura se sama přestavuje

E2E vrstva byla vyměněna za běhu: `fe41d03f` (2026-07-06) „test: replace WDIO gate with Tauri Pilot“ (113 souborů), následně „TAURI PILOT HARDENING“ (`90e2f4b3`, 2026-07-16). 21 commitů o „tauri pilot“ od 2026-06-04. Testy samotné jsou hotspot (`packages/e2e` 342 souborů-výskytů za 3 týdny).

## Duplicity a mrtvý kód (stopy v historii)

- **Odstraněné/přejmenované balíčky:** `packages/headless` (90 změn package.json, poté rename na `openwork-orchestrator`), `packages/owpenbot` (65 změn, rename na `opencode-router`), `packages/openwork` dnes obsahuje už jen `docs/`. Historie obsahuje celé životní cykly balíčků, které už neexistují.
- **Generované artefakty commitované do repa:** `graphify-out/` (559 souborů-výskytů za poslední 3 týdny, odstraněno až `8e6170f8`, 2026-07-09, 510 souborů v jednom commitu), `STATS.md` (44 commitů — automaticky doplňovaná tabulka downloadů), `packaging/aur/PKGBUILD` + `.SRCINFO` (135+131 změn — release automatizace).
- **Explicitní úklidové commity dokládají průběžné hromadění mrtvého kódu:** `d23cd288` (2026-07-02) „remove dead composition-shell code“, `b10ea2c8` (2026-05-24) „drop Docker sandbox backend dead-code“, `e15366f6` „remove 4 sandbox Tauri IPC commands“, `4572e70b` (2026-06-07) „retire duplicate DEN admin shell“, `08ebc332` (2026-03-20) „consolidate duplicated fetchWithTimeout“, `0d75ec5e` „extract shared child-process supervisor“ (VSLO-104), `97dfc171` „centralize path normalization helpers“ (VSLO-107).
- **Duplicitní provisioning TS/Rust:** `internal-system.ts` ↔ `internal_provision.rs` je vědomě udržovaná duplicita (18 fix commitů na Rust straně), zakotvená i v CLAUDE.md jako povinné zrcadlení.
- **i18n trojité udržování:** `en.ts` 160, `cs.ts` 131, `zh.ts` 119 změn — každá UI změna se propisuje do tří lokalizací (58/44/38 z toho ve fix commitech).

## Co by znamenalo oddělení BE/FE (pohled historie)

Historie naznačuje, že **největší bolest není hranice BE/FE, ale vnitřek FE a slepenec kanálů**:

- 2/3 fix churnu je čistě ve `packages/app` (app.tsx, session.tsx, workspace.ts, session list, composer). Oddělení FE do SPA by tento problém samo o sobě nevyřešilo — monolit `app.tsx` by se jen přestěhoval.
- Naopak by pomohlo tím, že by **zaniklo trojité doručování událostí** (SSE z enginu → Rust proxy → Tauri IPC/HTTP → UI), které bylo příčinou VSLO-86 série i červencových „missed SSE“ fixů. Čistá API+SSE hranice s jedním kanálem by odstranila celou třídu chyb, na kterých se v historii spálilo odhadem nižší stovky commitů.
- Kontrakt app ↔ veslo-server už de facto existuje (`docs/dev/veslo-server-app-contract.md`, 41 revizí) — jeho nestabilita ukazuje, že by musel být první věcí, která se zafixuje.
- Release pipeline (5 sidecarů, podepisování, MSI/DMG/AUR) by se výrazně zjednodušila, pokud by desktop shell byl jen tenký host pro SPA + jeden backend proces.

## Náměty na zjednodušení (odvozené z historie)

1. **Rozbít `app.tsx` a `session.tsx`** — 30–57 oprav měsíčně po 7 měsíců je empirický důkaz, že tyto soubory nelze bezpečně měnit. Jakýkoli plán (BE/FE split i přepis) musí začít tady.
2. **Jeden kanál událostí** — konsolidovat SSE/IPC/HTTP doručování engine událostí do jediné cesty; historie ukazuje 3 přestavby a stále to padá.
3. **Zrušit TS/Rust duplicitní provisioning** — nechat provisioning jen na jedné straně (server), Rust jen spouští procesy.
4. **Snížit počet sidecarů** — 87 commitů o sidecar + 38 fixů macOS release workflow je cena za 5 binárek; sloučení orchestrator+server, případně engine spouštěný serverem, by řezalo CI komplexitu.
5. **Vyřadit generované artefakty z gitu** (STATS.md, packaging výstupy) a zvážit, zda `services/ai-gateway` + `den` (353 + 211 změn za 3 týdny, celá červencová „model policy“ smršť ~35 commitů z 2026-07-12) patří do stejného repa jako desktop app.
6. **Zastavit „fix na fix“ cyklus procesně** — 31–34 % fix commitů bez klesajícího trendu znamená, že přidávání kódu generuje opravy rychleji, než se stíhá stabilizovat; před dalším rozvojem je racionální feature-freeze na send-path a sidebar.

## Rizika

- **Fork bez upstream synchronizace:** od 2026-03-12 žádné upstream commity; ~1 900 zděděných commitů OpenWork kódu tým vlastní sám, včetně částí, kterým se (soudě dle fix patternů) plně nerozumí.
- **Koncentrace znalostí:** 1 588 z ~2 900 post-fork commitů má jediný autor (Giltar). Bus factor ≈ 1 pro většinu aktivního kódu.
- **AI-asistované commit stormy:** dny se 35+ commity na jedno téma (2026-07-12 ai-gateway) a obří smíšené commity („SESSION HARDENING. EFFECTS, RUNTIME, AND TESTING“, 2026-07-18; „eslint findings fixes - … Tauri Pilot modularization … First message transcript artifact fixes“, 118 souborů) činí historii obtížně bisectovatelnou — revert je prakticky nemožný, což potvrzuje jen 10–19 revertů na 1 270 oprav.
- **Přepis za běhu:** poslední týdny současně mění send-path architekturu („new archi“, 2026-07-13), testovací infrastrukturu (Tauri Pilot), release pipeline (Windows MSI) a auth/model policy — čtyři stavby najednou na nestabilním základě.
- **Nestabilní kontrakty:** 41 revizí FE↔server kontraktu a 126 revizí state/config reference znamenají, že jakýkoli split BE/FE musí nejdřív kontrakt zamrazit, jinak se problém jen přesune přes síťovou hranici.
