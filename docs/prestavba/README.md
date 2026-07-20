# Přestavba Vesla 2026-07 — zjednodušení architektury

Domovská složka iniciativy. Cíl: výrazně zjednodušit Veslo tak, aby bylo stabilní pro první klienty a udržovatelné AI-asistovaným vývojem, při zachování funkcí workspace / agenti / skills / MCP.

**Stav: plán hotový, Pavlem schválený a s promítnutými rozhodnutími (50 balíčků ve 4 fázích) — balík je připraven k předání vykonavateli (Codex CLI nebo Claude Code). Implementace zatím nespuštěna.**

## Dokumenty

| Soubor | Obsah |
|---|---|
| [ZADANI.md](ZADANI.md) | Pavlova rozhodnutí a mantinely (2026-07-19) — schválená varianta 2, čistý start OK, Win+Mac povinné, router pryč, Den zůstává, monorepo, SolidJS, OpenCode + anti-corruption |
| [plan/00-PREHLED.md](plan/00-PREHLED.md) | **Vstupní bod pro vykonavatele** — co je Veslo, mapa fází, pracovní model (1 session = 1 balíček, re-plan checkpointy), mantinely, rizika, eskalace |
| [plan/01–04](plan/) | Fázové plány: 0 záchranná síť (10 balíčků), 1 velký ořez (12), 2 jeden backend (9), 3 FE na HTTP + rozbití god files (19). Prošlo adversariální kritikou (27 nálezů zapracováno); rozhodnutí Pavla promítnuta 2026-07-19 |
| [analyza/SYNTEZA.md](analyza/SYNTEZA.md) | Závěrečný architektonický report (syntéza 23 agentů): skutečná architektura, 6 kořenových příčin, vazba na OpenCode, mrtvý kód, proveditelnost BE/FE splitu, 3 varianty |
| [analyza/](analyza/) | 17 podkladových reportů s file:line odkazy + `ipc-http-parita.csv` (klasifikace všech 96 IPC příkazů) |

## Odhad (z plánu, finální po rozhodnutích 2026-07-19)

~69–92 AI sessions (jádro 63–86 + schválené ořezy + 4 re-plan checkpointy). Při tempu 2–3 sessions/den 5–10 pracovních týdnů, kalendářně 2–3 měsíce. **Milník „lze dávat klientům" je po fázi 1.**

## Klíčová fakta z analýzy (2026-07-19, HEAD `71215b07`)

- 6 lokálních procesů, 3 HTTP proxy vrstvy, 460 MB binárek (vlastní app 11 MB = 2,4 %); fix commity trvale 31–34 %.
- Kořenová příčina č. 1: replikovaný mutable stav bez vlastníka (4 pravdy o aktivním workspace, 3 registry, 2 transkripty, 3 id session). Č. 2: god files (`app.tsx` 5 339 ř., `cli.ts` 6 934 ř.) — přímá příčina selhávání AI vývoje.
- OpenCode NENÍ fork — stock upstream binárka. Draho stojí přímý SQL přístup do `opencode.db` a SDK typy v 61 souborech UI, ne engine sám.
- CI nechrání nic (0 úspěchů Quality workflow, žádná branch protection, 14 červených unit testů) — „ztráta záchranné sítě" není protiargument přestavby.
- Web režim (API+SPA) už empiricky funguje (`pnpm dev:web`): všechna 4 povinná flow prošla čistým HTTP. 71 % IPC povrchu je web-ready; skutečně nativních příkazů je 11.
- Okamžitě smazatelných ~7 000 LOC produkce (+ ~2× testy), vyčlenitelných dalších ~20 000 (router, toy-ui, document-runtime, soul…), −165 MB bundlu z build duplicit.

## Navržený směr (čeká na schválení)

Doporučená varianta: **2 — rozdělení BE+FE** (fázovaně; obsah varianty 1 „ořez" je prerekvizitou). Engine: **zůstat u OpenCode** + anti-corruption vrstva (vlastní typy v UI, konec přímého SQL) — engine tím zůstane vyměnitelný později. Detaily fází v ROADMAP a v konverzačním návrhu z 2026-07-19; po schválení vznikne `PLAN.md`.

## Historie

- 2026-07-19 — hloubková analýza (23 Fable agentů), syntéza, Pavlova rozhodnutí → `ZADANI.md`
