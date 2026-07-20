# Přestavba Vesla — přehled plánu (začni číst tady)

Datum: 2026-07-19 · Plán kalibrován na HEAD `main` @ `71215b07` · Repozitář: `git/` (klon https://github.com/neatechcz/veslo)

Tento dokument je vstupní bod pro vykonavatele, který o projektu nic neví. Přečti ho celý, pak `docs/prestavba/ZADANI.md` (rozhodnutí vlastníka — nesmí se porušit) a poté dokument fáze, kterou právě vykonáváš. Hloubková analýza kódu s file:line důkazy leží v `docs/prestavba/analyza/` (start: `SYNTEZA.md`).

| Soubor | Obsah |
|---|---|
| `00-PREHLED.md` | tento přehled |
| `01-faze-0-zachranna-sit.md` | Fáze 0 — záchranná síť (testy, CI, branch protection, experiment) |
| `02-faze-1-orez.md` | Fáze 1 — velký ořez (mrtvý kód, router, duplicity, bundle) |
| `03-faze-2-jeden-backend.md` | Fáze 2 — jeden backend (sloučení procesů, kontrakt) |
| `04-faze-3-fe-na-http.md` | Fáze 3 — frontend na HTTP + rozbití god files |
| `../ZADANI.md` | mantinely a rozhodnutí Pavla (vlastník) |
| `../analyza/SYNTEZA.md` | syntéza analýzy — proč se to celé dělá |

---

## 1. Co je Veslo a co se tu děje

**Veslo** je local-first desktopová aplikace pro spouštění AI agentů nad složkami uživatele (workspace): uživatel přidá složku, v ní vede konverzace s agentem, který smí číst a upravovat soubory, a rozšiřuje ho o skills a MCP servery. UI je SolidJS ve webview Tauri (Rust) shellu, jádrem je **OpenCode engine** (stock upstream binárka, žádný fork), AI komunikace jde povinně přes cloudovou službu **Den** (identity + AI gateway). Monorepo `packages/` obsahuje `app` (UI), `desktop` (Tauri), `server` (veslo-server, filesystem-backed API), `orchestrator` (engine lifecycle daemon), `e2e` a další. Čtyři povinné funkce, které musí přežít každou změnu: **práce se složkami (workspace, včetně více složek souběžně), běh agenta (session + zpráva + transkript), skills, MCP** — na macOS i Windows.

**Proč přestavba:** aplikace historicky vyrostla do 6 lokálních procesů se 3 HTTP proxy vrstvami za sebou, replikovaným stavem bez jediného vlastníka (4 „pravdy" o aktivním workspace, 3 registry, 2 transkripty, 3 identity session), god files (`app.tsx` 5 339 ř., `cli.ts` 6 934 ř., 180–258polové prop bagy) a čtyřnásobnou vazbou na OpenCode včetně přímého SQL do jeho interní databáze ze dvou jazyků. Důsledek: 31–34 % všech commitů jsou opravy (trvale, bez klesajícího trendu), CI gate nikdy nebyl zelený a releasy jdou ven bez testů. Produkt zatím nemá uživatele, ale má jít k prvním klientům — cílem je stabilita a udržovatelnost AI-asistovaným vývojem, ne nové funkce. Kompletní důkazy: `../analyza/SYNTEZA.md`.

**Cílový stav** (schválená varianta 2 ze SYNTEZA §6 — BE/FE split fázovaně): **jediný backendový proces `veslo-server`**, který sám spawnuje a superviduje OpenCode engine, vlastní veškerý stav (workspace registr, run lifecycle, transkript) a vystavuje jeden HTTP + SSE kontrakt popsaný OpenAPI specifikací; **SolidJS frontend** mluví výhradně přes generovaný HTTP klient a jediný SSE kanál, stejně v desktopu i v čistém prohlížeči; **Tauri je tenký shell** s ~11 nativními schopnostmi (folder picker, clipboard, okno, updater…); **engine zůstává OpenCode**, ale za anti-corruption vrstvou (vlastní Veslo typy, zákaz SDK importů v UI, žádné přímé SQL) — takže zůstane levně vyměnitelný. Monorepo zůstává, hranice BE/FE = generovaný API klient.

---

## 2. Mapa fází

| Fáze | Cíl | Milník (co funguje na konci) | Balíčků | Odhad sessions |
|---|---|---|---|---|
| **0 — Záchranná síť** (`01-…`) | Zprovoznit testy, CI a branch protection; experiment per-workspace configu | `pnpm check` zelený; Quality zelený a vynucovaný na `main`; E2E gate ~14 scénářů běží; experiment vyhodnocen (určuje tvar fáze 1) | 10 | 10–14 |
| **1 — Velký ořez** (`02-…`) | −25–35 k LOC produkce beze změny chování povinných funkcí | App funguje na Mac+Win; router neexistuje; 3 sidecary místo 5; bundle −~230 MB; jediný provisioning; žádné přímé SQL do `opencode.db` (přesun složky zachovává historii přes server); (podmíněně) jediná engine topologie. **→ PO TÉTO FÁZI LZE DÁVAT KLIENTŮM** | 12 (10 jádro + 2 schválené ořezy; 1.13/1.14 zrušeny — Soul a automations zůstávají) | 13–15 jádro; 15–17 se schválenými ořezy |
| **2 — Jeden backend** (`03-…`) | Sloučit 3 backendové procesy do jednoho `veslo-server` | Desktop superviduje 1 sidecar; orchestrátor smazán; headless umí N workspace; server-owned stav a workspace ID; SSE s kurzorem; auth bez CORS `*`; OpenAPI + generovaný klient | 9 | 12–19 (realisticky ~15) |
| **3 — FE na HTTP + god files** (`04-…`) | FE kompletně na HTTP/SSE; anti-corruption vrstva; dekompozice | 0× `invoke()` mimo runtime adapter; ≤11 IPC příkazů; 0 SDK importů (lint-ban); jedna identita session; E2E na Playwright; `app.tsx` ≤800 ř., prop bagy smazány | 19 | 28–38 |
| **Celkem** | | | **50** | **63–86 jádro; 65–88 se schválenými ořezy** |

K součtu přičti **4 re-plan checkpointy** (jedna session na začátku každé fáze, viz §3) → **realisticky ~69–92 AI sessions**. (Rozhodnutími Pavla z 2026-07-19 jsou všechny dříve podmíněné balíčky vyřešeny: 1.11 a 1.12 schváleny, 1.13 a 1.14 zrušeny, OO-2 = historie se přenáší server-side.)

**Kalendářní odhad při tempu 2–3 sessions/den:** 22–47 pracovních dní, tj. zhruba **5–10 pracovních týdnů**. Kalendářně počítej spíš **2–3 měsíce** — rezerva na čekání na Pavlova rozhodnutí (podmíněné balíčky, otevřené otázky), manuální testy před push a pomalé Windows CI iterace.

**Klíčový milník pro byznys: konec fáze 1** — aplikace je ořezaná, stabilnější, menší a plně funkční na obou platformách; od tohoto bodu lze dělat release pro první klienty, zatímco fáze 2–3 pokračují. Fáze 2 a 3 pak drží pravidlo „aplikace funguje po každém balíčku", takže releasovatelný stav se už nikdy neopouští.

**Závislosti mezi fázemi:** 0 → 1 → 2 → 3 přísně sekvenčně (výjimka: balíčky 1.1–1.3 lze začít už během fáze 0). Uvnitř fází jsou závislosti v tabulce balíčků každého dokumentu.

---

## 3. Jak s plánem pracovat

Přestavbu vykonává člověk s pomocí AI nástroje — **Codex CLI nebo Claude Code**, pracovní model je pro oba stejný (pozn.: `CLAUDE.md` předepisuje Codex CLI a toto pravidlo zůstává v platnosti). Pracovní model:

1. **Jedna AI session = jeden pracovní balíček.** Každý balíček v dokumentech fází je self-contained zadání: Cíl / Vstupy (soubory + report z analýzy) / Kroky / Ověření (spustitelné příkazy) / Hotovo znamená / Rizika a rollback / Odhad. Session začni tím, že AI přečte: `ZADANI.md`, sekci svého balíčku a reporty uvedené ve Vstupech. Nikdy nezačínej další balíček, dokud předchozí není zelený a commitnutý.

2. **Re-plan checkpoint na začátku KAŽDÉ fáze** (samostatná session): `git pull`, přečti dokument fáze, ověř klíčová tvrzení proti aktuálnímu HEAD (plány jsou kalibrované na `71215b07` a předchozí fáze i běžný vývoj kód posunuly — každá fáze má sekci Prerekvizity s ověřovacími příkazy), aktualizuj plánovací soubor fáze (počty, čísla řádků, stavy balíčků) a rozdíly poznamenej. Bez checkpointu se nesmí spustit první balíček fáze.

3. **Commit po každém dokončeném balíčku** (jeden squashnutý commit, formát např. `faze1: 1.4 odstraneni opencode-routeru`, bez Co-Authored-By). **Push až po manuálním otestování** (ruční průchod aplikace, u větších zásahů na Mac i Windows) a souhlasu Pavla. Výjimka: pracovní větve pro CI iteraci (fáze 0) se pushují průběžně — to je součást úkolu.

4. **Když se realita rozejde s plánem** (soubor neexistuje, počty nesedí, krok nedává smysl): neimprovizuj mlčky. Aktualizuj plánovací soubor dané fáze (kroky, čísla, stav v tabulce balíčků) a zapiš důvod odchylky přímo do dokumentu. Plán je živý dokument — jeho aktuálnost je součást práce. Stav exekuce se značí v tabulce balíčků fáze („hotovo YYYY-MM-DD").

5. **Jak spouštět ověření:** kompletní dev-verifikační smyčku (toolchainy, `check:*` příkazy, očekávané výstupy, start desktopu i headless web režimu) staví fáze 0 — balíček 0.1 a bod 6 milníku fáze 0; jejím výstupem je `docs/prestavba/plan/00-baseline-faze-0.md` s baseline a návodem „jak rozjet prostředí od nuly". Od fáze 1 dál platí „standardní ověření" definované v §5.2 dokumentu fáze 1 (typecheck, unit, server testy, `check:services`, cargo check, knip, debug build) + E2E gate z fáze 0. Zlaté pravidlo repa: **po každé editaci build — nikdy nehlásit hotovo bez proběhlého buildu.**

6. **Feature freeze disciplína:** nápady na vylepšení mimo zadání balíčku se zapisují do `docs/prestavba/plan/napady-pozdeji.md`, ne do kódu.

---

## 4. Mantinely (výtah ze ZADANI.md — plné znění `../ZADANI.md` má přednost)

- **Schválená varianta 2**: BE/FE split fázovaně; ořez (varianta 1) je její prerekvizitou. Nic jiného se nestaví.
- **Monorepo zůstává**; hranice BE/FE = generovaný API klient z OpenAPI, žádné křížové importy.
- **SolidJS + Tauri zůstává** (Tauri jako tenký shell). Žádný přepis UI do jiného frameworku.
- **Engine zůstává OpenCode** + anti-corruption vrstva (vlastní typy v UI, zákaz přímých SDK importů, konec přímého SQL do `opencode.db`).
- **Feature freeze**: žádné nové featury, jen stabilizace a přestavba. Jediné povolené změny chování jsou ty explicitně vyjmenované v DoD balíčků.
- **Čistý start OK**: žádná migrace dat (sessions, workspaces, přihlášení) — produkt zatím nikdo nepoužívá.
- **Windows + macOS povinné** (tvrdý požadavek); Linux není cílová platforma.
- **Messaging router (Telegram/Slack) se vyhazuje** kompletně.
- **Den zůstává povinný** — veškerá AI komunikace jde přes něj; AI gateway (codex_oauth) beze změny.
- **Remote/cloud workers se neřeší; sandbox se neřeší** (na desktopu fakticky opuštěný).
- **Soul a automations ZŮSTÁVAJÍ** (rozhodnutí 2026-07-19) — nesmí se přestavbou rozbít; jejich dokončení je mimo scope.
- **Přesun složky workspace zachovává historii chatů** — implementace server-side (balíček 1.7), žádný Rust regex do `opencode.db`.
- **Multi-workspace je kritická funkce** — souběžná práce ve více složkách nesmí žádným balíčkem degradovat.
- **Cloudová vrstva (Den, ai-gateway) se v tomto plánu nemění** — jen evidenční příloha fáze 1 §7.
- Vše k přestavbě se ukládá do `docs/prestavba/`.

---

## 5. Rizika celku a eskalace

Hlavní rizika napříč fázemi (detailní souhrny rizik jsou na konci každého fázového dokumentu):

1. **Regresní síť vzniká až fází 0 a je tenká** — gate pokrývá zlomek chování; ruční smoke testy v balíčcích nejsou volitelné.
2. **Pohyblivý cíl**: na `main` se vyvíjí dál; plán je kalibrován na `71215b07`. Ochrana: re-plan checkpointy + povinné ověření grepem před každým smazáním.
3. **Jednosměrné kroky**: smazání engine poolu (1.8), smazání orchestrátoru (2.4), smazání Rust SSE mostu (3.8). Vždy nejdřív nová cesta + ověření na obou platformách, teprve pak mazání; u 1.8 rozhoduje experiment z fáze 0.
4. **Testy jako beton**: 40–50 % LOC jsou testy svázané s vnitřní strukturou (včetně regex-on-source). Politika: testy mrtvého kódu se mažou; „oprava testu" nesmí zamaskovat reálnou regresi (procedura A/B/C z fáze 0).
5. **Windows parita** se ověřuje průběžně (staging buildy, CI), ne až na konci — Windows iterace jsou drahé a pomalé.
6. **Historicky nejporuchovější domény** — workspace switching, event delivery, bootstrap — se dotýkají balíčků 2.3, 3.7, 3.8, 3.15; tam platí zvýšená opatrnost, malé commity a E2E po každém.

**Zastav práci a eskaluj Pavlovi, když:**

- balíček by vyžadoval **porušení ZADANI.md** nebo změnu chování 4 povinných funkcí nad rámec DoD;
- narazíš na **reálnou regresi v produkčním kódu** (procedura C fáze 0) — oprava produkce mimo rozsah balíčku vyžaduje schválení;
- krok balíčku odkazuje na dosud nerozhodnutou otevřenou otázku pro Pavla (seznamy „Otevřené otázky" na konci každé fáze — projít s Pavlem vždy před startem fáze; dříve podmíněné balíčky 1.11–1.14 už Pavel 2026-07-19 rozhodl);
- experiment/prerekvizita dopadne jinak, než plán předpokládá (např. výsledek V2b/V4 experimentu 0.10, nesplněné prerekvizity P1–P9 fází 2–3);
- práce na balíčku **přeteče přes 2 sessions** bez jasného konce — napiš handoff dokument do `docs/prestavba/handoffs/` (v repu) se stavem diagnostiky a nech rozhodnout o pokračování;
- chystáš se na **push, release nebo jakýkoli nevratný krok** (branch protection, npm deprecate, smazání dat) — ty vždy schvaluje Pavel.

Kontakt: Pavel (vlastník, `pavel.vejnar`) — zadává úkoly, schvaluje plány a rozhoduje otevřené otázky; vykonavatel implementuje.

---

*Další krok po přečtení: `01-faze-0-zachranna-sit.md`, re-plan checkpoint fáze 0 a balíček 0.1.*
