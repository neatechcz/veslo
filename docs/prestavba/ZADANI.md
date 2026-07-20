# Zadání přestavby — rozhodnutí a mantinely od Pavla

Zaznamenáno 2026-07-19 (odpovědi na otázky ze závěrečné analýzy, viz `analyza/SYNTEZA.md` §7 a otázky pro uživatele).

## Produktová rozhodnutí

| Otázka | Rozhodnutí |
|---|---|
| **Uživatelé dnes / cílově** | Dnes nikdo (produkt ještě nikde neběží). Reálně budou **desítky až stovky uživatelů**. |
| **Migrace dat** | **Čistý start je OK.** Žádná migrace sessions/workspaces/přihlášení se řešit nemusí. |
| **Platformy** | **Windows + Mac, tvrdý požadavek.** Multiplatformní desktopová aplikace. Alternativa „webová app v Chromu" je teoreticky přípustná, ale Pavlovi přijde jednodušší práce se soubory přes desktop aplikaci. |
| **Zákazníkův model použití** | Zákazník má složku, ve které pracuje a dělá úpravy (co-work nad složkou). AI napojení na OpenAI. |
| **Vize do budoucna** | Napojit na **lokální modely na výkonném hardwaru**. (→ engine i gateway musí zůstat provider-agnostické.) |
| **Remote práce** | **Neřešit.** Komplikuje to celé (vzdálený stroj nemá soubory). Cloud workers pravděpodobně nikdo nepoužívá. |
| **Telegram/Slack router** | **Nepoužívá se vůbec → vyhodit.** |
| **Sandbox** | Otevřená otázka — kde agent běží, jak sandbox řešit, jestli jsme toho schopni. Dříve rozhodnuto sandbox nedělat (moc složitý). Není blokující pro přestavbu. |
| **Den** | **Zůstává povinný a vždy dostupný** — přes něj jde celá AI komunikace (API). Je to součást architektury. |
| **AI gateway (codex_oauth větev)** | Rozpor s ToS je známý, **vědomé dočasné řešení, zůstává beze změny**. |

## Procesní rozhodnutí

| Otázka | Rozhodnutí |
|---|---|
| **Engine (OpenCode vs. Codex vs. jiný)** | **Deleguje na Clauda.** Záměr výměny byl vždy jen prostředek ke zjednodušení, ne cíl. Pokud by pod frontendem běžel Codex „fungující podobně jako OpenCode", proč ne — ale Pavel si není jistý proveditelností. Rozhodovací kritérium: jednoduchost + funkčnost + slučitelnost s vizí lokálních modelů. |
| **Kdo přestavbu programuje** | **Claude** (AI-asistovaný vývoj). → Architektura musí být AI-friendly: malé soubory, lokalizovatelné změny, dokumentovaný kontrakt. To je samo o sobě architektonické kritérium. |
| **Feature freeze** | **Ano.** Žádné nové featury, teď se stabilizuje. Cíl: dostat produkt ke klientům, aby aspoň nějak fungoval („teď je to divoké, moc to nefunguje"). |
| **Multi-workspace** | Kritická funkce (paralelní práce ve více složkách současně) — historicky největší bolest, viz `analyza/multi-workspace.md`. |
| **Dokumentace přestavby** | Vše ukládat do `docs/prestavba/` — „je to velká věc, ať o to nepřijdeme". |

## Rozhodnutí z 2026-07-19 (večer) — schválení směru

| Otázka | Rozhodnutí |
|---|---|
| **Varianta postupu** | **Varianta 2 — rozdělení BE+FE, fázovaně** (obsah varianty 1 „ořez" jako prerekvizita). Pavel: „naprosto souhlasím, tohle vypadá dobře." |
| **Repozitář** | **Zůstává jedno monorepo.** Hranice BE/FE = generovaný API klient z OpenAPI, žádné křížové importy — budoucí rozdělení do dvou repozitářů tím zůstane levné. |
| **UI framework** | **Zůstává SolidJS** (+ Tauri jako tenký shell). Flutter/Dart zamítnut — problém není framework, ale správa stavu; přechod by znamenal přepis fungujícího UI bez odstranění příčin. |
| **Engine** | **Zůstává OpenCode** + anti-corruption vrstva (vlastní typy v UI, zákaz přímých SDK importů, konec přímého SQL do `opencode.db`) — engine zůstane levně vyměnitelný později. |
| **Realizace** | **Plán se předá kolegovi, který ho bude vykonávat pomocí AI (Claude Code).** Plán proto musí být self-contained — kolega nemá kontext našich konverzací. Domov plánu: `docs/prestavba/plan/`. |
| **Režim teď** | **Jen plánování, nic se nespouští** — implementace až po Pavlově schválení plánu. |

## Rozhodnutí z 2026-07-19 (pozdě večer) — schválení plánu a otevřené otázky

| Otázka | Rozhodnutí |
|---|---|
| **Plán přestavby** | **Schválen** („tak jo, to je dobrý"). Implementace se zatím nespouští. |
| **Vykonavatel a nástroj** | Kolega bude pravděpodobně pracovat **přes Codex CLI** — pravidlo „vše přes Codex" v `CLAUDE.md` se **NEruší**. Plán musí být agent-agnostický (Codex i Claude Code). |
| **toy-ui** | Pavel nevznesl námitku → platí doporučení **vyhodit** (balíček 1.11). Veto stále možné. |
| **document-runtime** | **Vyhodit** — „není potřeba, když se office skills dělají přes něco jiného" (balíček 1.12). Office skills nedotčeny. |
| **soul** | **ZŮSTÁVÁ** — záměrně přidané: popis firmy + pseudoprompt uživatele (vykání apod.). Balíček 1.13 se ruší. |
| **automations** | **ZŮSTÁVÁ** („do budoucna by tam měly být") — ořez UI se nekoná, balíček 1.14 se ruší; funkce se během přestavby nesmí dále rozbít, dokončení je mimo scope (feature freeze). |
| **inbox-panel** | **Smazat** — Pavel neví, o čem je („nedává mi smysl"). |
| **windows-sandbox-repair** | **Smazat** — patřilo k odloženému sandboxu. |
| **Přesun složky workspace** | **Historie chatů se PŘENÁŠÍ** — ale implementace server-side (žádný Rust regex do `opencode.db`). Zpětná kompatibilita se starou verzí je jedno; jde o chování nové aplikace do budoucna. Mění rozsah balíčku 1.7. |

## Co z toho plyne (souhrn mantinelů pro návrh)

1. Zachovat: práce se složkami (workspace), spouštění agentů, skills, MCP, desktop app Win+Mac, Den jako AI brána.
2. Vyhodit lze: messaging router, cloud workers / remote stack, vše prokázaně mrtvé.
3. Nebrat ohled na: migraci dat, zpětnou kompatibilitu, stávající uživatele (nejsou).
4. Optimalizovat na: stabilitu pro první klienty, udržovatelnost AI-asistovaným vývojem, budoucí lokální modely.
