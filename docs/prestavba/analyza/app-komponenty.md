# Analýza: packages/app — komponenty a stránky

Rozsah úseku: `packages/app/src/app/pages/` a `packages/app/src/app/components/` (+ nezbytný kontext entry pointů a prop-assembleru). Vše ověřeno čtením kódu, ne dokumentace.

## Účel a rozsah

UI vrstva Vesla psaná v SolidJS. Čísla (změřeno `wc -l`, bez node_modules/dist):

| Oblast | Souborů | Řádků |
|---|---|---|
| `src/app/pages/` | 47 (17 .tsx pohledů + 24 .ts workflow/controllerů + 6 in-file testů) | 33 336 |
| `src/app/components/` (kořen) | 50 | 8 707 |
| `src/app/components/session/` | 51 | 16 992 |
| `src/app/components/layout/` | 3 | 273 |
| **Celkem úsek** | **~151** | **~59 300** |

Pro kontext: celý `src/app` má 219 638 řádků, z toho ~91 700 (42 %) jsou testy (`app/tests/` 85 582 + in-file testy 6 126). Na tento úsek připadá ~28 500 řádků testů v `app/tests/{components,pages}` + ~4 100 in-file.

**Reálně existující obrazovky:** aplikace má jen **4 top-level pohledy** (přepínač v `app.tsx:5150–5171` přes `currentView()`: `proto` | `onboarding` | `session` | `dashboard`, odvozeno z cesty v `context/app-route-sync.ts:73–86`). Dashboard pak přepíná **7 tabů** (`types.ts:369`: scheduled, soul, skills, plugins, mcp, config, settings), které renderují stránky `scheduled.tsx`, `soul.tsx`, `skills.tsx`, `plugins.tsx`, `extensions.tsx` (obal nad `mcp.tsx`), `config.tsx`, `settings.tsx` (`pages/dashboard.tsx:1033–1199`). Zbytek „stránek" jsou buď fragmenty session layoutu (`session-left-sidebar.tsx`, `session-right-sidebar.tsx`, `session-center.tsx`), mrtvý kód (`identities.tsx`), nebo statické design prototypy (`proto-v1-ux.tsx`, `proto-workspaces.tsx`).

## Architektura a klíčové soubory

Datový tok je **čistě shora dolů přes obří prop bagy** — komponenty prakticky nepoužívají SolidJS kontext (jediný výskyt: `usePlatform` v `components/part-view.tsx:6`). Vše se skládá v jednom místě:

1. **`app.tsx` — 5 339 řádků, god-komponenta.** 91 `createSignal`, 29 `createEffect`, 55 `createMemo`. Instancuje ~40 controllerů/storů z `context/`, drží veškerý stav a modály (reset, confirm, feedback, MCP auth, create-workspace…).
2. **`app-view-props.ts` — 2 046 řádků, „assembler".** Typ `AppViewPropsScope` (řádek 279) má **311 polí**; funkce `createAppViewProps` (řádek 655) z něj mapuje prop bagy pro tři pohledy.
3. **Prop bagy pohledů (změřené počty polí):**
   - `SessionViewProps` — **180 props** (`pages/session.tsx:343`, definice má 209 řádků)
   - `DashboardViewProps` — **258 props** (`pages/dashboard.tsx`, 290 řádků definice) — dashboard je z velké části jen dispečer, který props přeposílá do 7 tabů
   - `SettingsViewProps` — **95 props** (`pages/settings.tsx:65`)
   - `SkillsViewProps` — **45 props** (`pages/skills.tsx:117`)
   - `OnboardingViewProps` — 63 props
   - Naproti tomu listové komponenty jsou rozumné: `ComposerProps` 34 (`components/session/composer.tsx:49`), `MessageListProps` 23 (`components/session/message-list.tsx:79`).

**Největší soubory úseku:**

| Soubor | Řádků | Poznámka |
|---|---|---|
| `pages/session.tsx` | 5 012 | hlavní chat pohled; 43 signálů, 37 efektů, 108 memo; layout, rename/delete modály, sidebar resize, search, folder-access consent, implicit-skill confirmation |
| `pages/skills.tsx` | 3 273 | správa skills; 48 signálů, 63 memo; obsahuje i přímý `fetch()` install-linků (řádek 1631) |
| `components/session/workspace-session-list.tsx` | 2 990 | sidebar seznam sessions; + 6 satelitních souborů (`-model` 879, `-prefetch-interest` 302, `-prefs` 268, `-windowing` 159, `-order` 108, `-render-model` 34) ⇒ **~4 740 řádků na seznam sessions** |
| `pages/settings.tsx` | 2 398 | 4 pod-taby (general/archived/advanced/debug), 95 props |
| `pages/session-send-workflow.ts` | 2 348 | čistá logika odesílání (není UI) |
| `components/session/composer.tsx` | 2 288 | vstupní pole: přílohy, komprese obrázků, mention, slash příkazy, drag&drop, send-trace instrumentace |
| `pages/session-conversation-flow.ts` | 2 243 | čistá logika konverzačního toku (není UI) |
| `components/session/message-list.tsx` | 2 134 | virtualizovaný transkript (@tanstack/solid-virtual), vestavěný benchmark (`MessageBlocksStreamBenchmark`, řádek ~119) |
| `pages/identities.tsx` | 1 494 | **mrtvý** (nikdo neimportuje) |
| `pages/dashboard.tsx` | 1 446 | shell tabů |
| `components/part-view.tsx` | 963 | renderer OpenCode `Part` (markdown, tool cally, highlight) |
| `components/mcp-auth-modal.tsx` | 936 | OAuth flow pro MCP |

**Vzor „-model.ts":** větší komponenty mají oddělené čisté modelové soubory (např. `timeline-detail-model.ts` 587, `media-evidence-model.ts` 428, `progress-grouping-model.ts` 351, `session-queue-model.ts` 192). To je samo o sobě dobrá praxe (testovatelnost bez DOM), ale násobí počet souborů — session komponenty = 51 souborů.

**Instrumentace prorostlá do UI:** 205 volání `recordPerfLog`/`recordSendTrace`/`uiEffectTrace`/`__vesloSendTrace` přímo v pages/components (mimo testy) + 48 `window/document.addEventListener`. Kód UI je protkán diagnostikou na globálním `window` objektu (`composer.tsx:102–120`), zjevně stopa dlouhého ladění timing problémů.

**Stopy kodemodů:** 21 souborů importuje i18n přes alias `__vesloT`/`__vesloCurrentLocale`; `pages/config.tsx:15–16` importuje `t`/`currentLocale` ze stejného modulu **dvakrát** (jednou normálně, jednou s aliasem) — pozůstatek automatizované lokalizace.

## Komunikační vazby

Komponenty a stránky **nevolají transport přímo** — disciplína je tu překvapivě dobrá:

- **Tauri IPC:** 0 přímých `invoke()` v pages/components. Vše přes wrappery v `lib/tauri.ts` (1 467 řádků, 96 exportovaných funkcí, ~83 `invoke` volání). Importuje jej 19 souborů z pages/components.
- **HTTP (veslo-server):** `VesloServerClient` (`lib/veslo-server/client.ts`, 4 088 + 2 429 řádků domén) se **předává jako prop** `client` do stránek; importuje ho 21 souborů (skills, soul, settings, scheduled, session-workflowy…).
- **OpenCode SDK:** 13 souborů importuje typy z `@opencode-ai/sdk/v2/client`. Přímé volání SDK klienta jen v `pages/session-mutation-workflow.ts:894–968` (`c.session.delete/get/messages/todo`, `c.app.agents`).
- **SSE/event stream:** neteče do komponent — žije v `context/session-event-stream.ts`; komponenty dostávají už jen projektovaná data přes props.
- **window CustomEvent jako skrytá sběrnice:** `PROJECT_ORDER_PROMOTED_EVENT` (`workspace-session-list-prefs.ts:165` → `workspace-session-list.tsx:681`).
- **localStorage:** preference sidebaru, drafty composeru, šířky panelů — 5 souborů přímo + `platform.storage`.
- **Přímý `fetch`:** jen 2 místa — `pages/skills.tsx:1631` (stažení skill bundle z install-linku) a `pages/session-attachment-staging.ts:147` (čtení dataUrl přílohy).

## Vazba na OpenCode

- **Transkript je postaven přímo na OpenCode typech.** `part-view.tsx:3` renderuje `Part` z `@opencode-ai/sdk`; `message-list.tsx`, `message-editability.ts`, `pending-submit-model.ts`, `timeline-detail-model.ts`, `progress-grouping-model.ts` — celá pipeline zobrazení zpráv pracuje s OpenCode tvary `Message`/`Part`. Přístup k polím je částečně izolován v `lib/opencode-part-access.ts`, ale typy prosakují do 13 souborů úseku.
- Composer produkuje drafty, které se přes `session-send-workflow.ts` překládají na OpenCode parts.
- Zbytek UI (skills, soul, scheduled, settings, MCP) mluví s **veslo-serverem**, ne s OpenCode přímo — tam je vazba jen přes vlastní API typy (`VesloServerClient`).
- **Výměna enginu** by v tomto úseku znamenala: přemapovat `Part`/`Message` typy (~13 souborů, prakticky celý `components/session/` render stack) + přepsat `session-mutation-workflow.ts`. Reálné, ale ne triviální — chybí vlastní doménový model zpráv; UI model = SDK model.

## Hotspoty složitosti

1. **Prop-drilling monolit `app.tsx` (5 339) + `app-view-props.ts` (2 046, 311-polový scope) + 258/180/95-polové prop bagy.** Každá nová funkce znamená přidat pole do 3–5 typů a protáhnout ho 2–3 vrstvami. To je hlavní důvod, proč „se pořád něco rozbíjí" a proč AI-asistovaný vývoj selhává — kontext jedné změny je rozprostřen přes tisíce řádků.
2. **`pages/session.tsx` (5 012)** — míchá layout, modály, klávesové zkratky, search, sidebar resize, folder-access consent i skill confirmation v jedné funkci `SessionView`.
3. **Sidebar seznam sessions ~4 740 řádků v 7 souborech** (windowing, drag&drop řazení projektů, prefetch interest, context menu, prefs) — na funkci „seznam chatů ve složkách".
4. **`pages/skills.tsx` (3 273)** — grid/tabulka, detail drawer, review dialog, verze, import, install-link, bulk publish — vše v jedné stránce s 48 signály.
5. **Workflow soubory v `pages/`** (`session-send-workflow` 2 348, `session-conversation-flow` 2 243, `session-mutation-workflow` 1 003, `session-transcript-viewport` 711, `session-search-command-controller` 700, `session-creation-workflow` 677, …) — ~11 300 řádků ne-UI logiky ve složce „pages", s dependency-injection vzorem (`defaultX` parametry) kvůli testovatelnosti.
6. **Vestavěná diagnostika (205 volání)** — perf log, send trace, benchmark v message-listu; komplikuje čtení každého hot-path souboru.
7. **Testová zátěž jako brzda refaktoringu:** testy jsou navázané na tvary prop bagů (`tests/pages` 16 272 řádků, `tests/components/session` 10 544). Každá změna prop rozhraní rozbije desítky testů.

## Duplicity a mrtvý kód

**Prokazatelně mrtvé (0 importérů mimo vlastní testy; ověřeno i pro importy s příponou `.js`):**

| Soubor | Řádků | Poznámka |
|---|---|---|
| `pages/identities.tsx` | 1 494 | správa Telegram/Slack identit; HTTP klient (`lib/veslo-server-domains/messaging-identities.ts`) je stále živý, ale stránka není nikde namontovaná |
| `components/session/context-panel.tsx` | 394 | naposledy editován 2026-05-31 |
| `components/live-markdown-editor.tsx` | 342 | jediný uživatel **5 závislostí `@codemirror/*`** v package.json ⇒ mrtvé dependencies |
| `components/windows-sandbox-repair.tsx` | 298 | Windows repair flow, komponenta nenamontovaná (policy lib má testy) |
| `components/session/inbox-panel.tsx` | 295 | poslední změna 2026-03-13 |
| `components/reload-workspace-toast.tsx` | 150 | |
| `components/session/minimap.tsx` | 127 | |
| `components/thinking-block.tsx` | 76 | |
| `components/language-picker-modal.tsx` | 64 | |
| `components/card.tsx` | 21 | |
| `components/session/composer-disclaimer.ts` | 11 | má živý test i skript `test:composer-disclaimer` v package.json — testuje se mrtvý kód |
| **Součet** | **~3 272** | + příslušné testy v `app/tests/` |

**Prakticky mrtvé — design prototypy v produkčním bundlu:** `pages/proto-v1-ux.tsx` (676) + `pages/proto-workspaces.tsx` (451) = 1 127 řádků statických maket s hardcoded daty (falešné workspaces „Finance Ops", vzorky threadů). Importovány **staticky** v `app.tsx:154–155` (ne lazy) a dostupné na routě `/proto` — přibalují se každému uživateli.

**Duplicity / téměř duplicity:**
- `pages/extensions.tsx` (78) je jen kosmetický obal `pages/mcp.tsx` (702) — dvě vrstvy pro jeden tab.
- `create-workspace-modal.tsx` (401) vs. `create-remote-workspace-modal.tsx` (199) — dva paralelní modály na založení workspace.
- Dvojitý import i18n v `pages/config.tsx:15–16`; alias `__vesloT` ve 21 souborech vedle normálního `t` — dva styly téhož.
- Modálový systém je naopak vzorově sjednocený (`modal-shell/header/footer`, `rename-modal` jako báze pro session/workspace varianty) — tady duplicita není.

## Co by znamenalo oddělení BE/FE

Z pohledu tohoto úseku je **UI už dnes v zásadě „web-ready"**:

- Komponenty nevolají `invoke()` přímo — jediná Tauri hranice je `lib/tauri.ts` (96 funkcí). Oddělení = nahradit těchto 96 wrapperů HTTP voláními (většina má už dnes serverový ekvivalent ve `VesloServerClient`).
- `index.tsx:65` už dnes větví `HashRouter` (Tauri) vs. `Router` (web) a `entry.tsx:10–34` už řeší URL enginu pro web/Docker režim — režim „SPA proti serveru" v kódu existuje.
- Zbývající desktop-only prosaky v úseku: `@tauri-apps/api/path` v `pages/session.tsx:78` (`join`), `plugin-opener` v `pages/dashboard.tsx:658` a `app.tsx:656`, drag&drop souborů z OS v composeru, nativní dialogy (`pickDirectory`). To je řádově desítky míst, ne stovky.
- **Skutečná překážka rozdělení není transport, ale stavový monolit** `app.tsx` + `app-view-props.ts`: dokud se všechen stav skládá v jedné komponentě, nese si SPA celou složitost s sebou. Rozdělení BE/FE bez rozbití prop-drilling vzoru by ušetřilo málo.

## Náměty na zjednodušení

1. **Smazat mrtvý kód** (~3 272 řádků + testy + 5 `@codemirror` závislostí + `html2canvas` prověřit — používá ho jen `lib/feedback.ts`). Nulové riziko, okamžitý zisk. Rozhodnout osud `identities.tsx` (buď namontovat, nebo smazat i s doménovým klientem).
2. **Vyhodit `/proto` stránky z produkce** (1 127 řádků ze statického bundlu) — smazat, nebo aspoň lazy-load za dev flagem.
3. **Nahradit prop-drilling doménovými kontexty/story** (session, workspace, skills, settings…). Zrušilo by `app-view-props.ts` (2 046), srazilo `app.tsx` z 5 339 na zlomek a `SessionViewProps` ze 180 na ~10 polí. Největší páka na údržbu i AI-vývoj — změna pak bude lokální v jednom modulu.
4. **Rozřezat `session.tsx` a `skills.tsx`** na pod-komponenty s vlastním stavem (modály, search, sidebar-resize ven).
5. **Sloučit `extensions.tsx` + `mcp.tsx`** a `create-workspace` modály do jednoho s přepínačem local/remote.
6. **Přesunout workflow `.ts` soubory z `pages/` do `services/` vrstvy** — už dnes jsou UI-free a DI-testovatelné; jen se špatně jmenují a leží mezi pohledy.
7. **Stáhnout instrumentaci (205 volání) za jediný dev-only modul** nebo smazat — je to lešení z minulých debugů.
8. **Zjednodušit sidebar**: 4 740 řádků na seznam sessions je násobek účelnosti; plochý seznam s jednoduchým řazením by mohl mít ~1 000 řádků (za cenu ztráty drag&drop pořadí projektů a prefetch heuristik).
9. **Zavést vlastní view-model zprávy/partu** (adapter nad OpenCode `Part`) — zmenší povrch vazby na engine z 13 souborů na 1–2 a připraví půdu pro případnou výměnu enginu.
10. **Při redukci zvážit i testy:** 42 % řádků repa jsou testy silně svázané s prop tvary; při refaktoringu je nutné je psát znovu proti novým rozhraním, jinak zabetonují současný stav.

## Rizika

- **Testová vazba:** ~32 000 řádků testů tohoto úseku je navázáno na současné prop bagy; velký refaktor je de facto přepsání testů.
- **Timing pasti reaktivity:** projektová paměť (`docs/prestavba/analyza/frontend-memory.md`) dokumentuje křehké pořadí efektů; přesun stavu z `app.tsx` do kontextů mění timing inicializace (workspace switch, session select) — regresní riziko je vysoké a musí se jistit E2E testy, ne unit testy.
- **„Mrtvý" kód může být rozdělaná funkce:** inbox-panel, context-panel, minimap a windows-sandbox-repair vypadají jako odpojené během některého refaktoru, ne jako vědomě opuštěné — před smazáním ověřit s vlastníkem (Windows podpora!).
- **Prop-drilling je aspoň explicitní** — naivní náhrada globálními story může vytvořit skryté závislosti a zhoršit laditelnost, pokud se neudrží doménové hranice.
- **`DashboardViewProps` (258) a `SessionViewProps` (180) sdílejí desítky polí** — při postupné migraci na kontexty hrozí dlouhé období dvojí pravdy (prop i kontext), které je nutné časově ohraničit.
