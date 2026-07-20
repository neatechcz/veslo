# Fáze 0 — Záchranná síť

> Součást plánu přestavby Vesla (schválená varianta 2 — BE/FE split fázovaně, viz `docs/prestavba/ZADANI.md`).
> Tento dokument je self-contained: každý balíček lze zadat jako samostatnou AI session (Codex CLI nebo Claude Code) bez dalšího kontextu.
> Repozitář: https://github.com/neatechcz/veslo (tento repozitář). Plán je ověřen proti HEAD `71215b07` (main, 2026-07-19).

## Účel fáze

Dnes projekt **nemá žádnou fungující záchrannou síť**: branch protection na GitHubu neexistuje, jediný workflow běžící na aktivní větvi `main` (Quality) má **0 úspěšných běhů v celé historii**, unit testy jsou červené i lokálně (14 selhání) a sada 80 E2E scénářů se v CI **nikdy ani nezačala vykonávat** (workflow umírá v setupu). Releasy se balí a publikují bez jakékoli automatické verifikace. Detailní důkazy: `docs/prestavba/analyza/doplneni.md` (Mezera 5).

Bez záchranné sítě nelze bezpečně provést žádný z velkých zásahů fáze 1+ (ořez mrtvého kódu, sjednocení engine topologie, BE/FE hranice). Fáze 0 proto:

1. zprovozní lokální verifikační smyčku (build, typecheck, testy) a zdokumentuje ji,
2. opraví červené unit testy a všech 5 jobů Quality workflow,
3. zapne Quality / Gate jako **vynucovaný** required check (branch protection),
4. zprovozní minimální E2E gate (~14 scénářů pokrývajících 4 povinná flow: workspace, běh agenta, skills, MCP),
5. provede **experiment s per-workspace konfigurací ve sdíleném enginu** — jeho výsledek určuje tvar klíčových balíčků fáze 1 (smazání engine poolu vs. jiné řešení).

**Feature freeze platí**: v této fázi se neopravuje architektura ani se nepřidávají featury. Mění se jen testy, CI konfigurace, a produkční kód výhradně tam, kde je prokázaná chyba blokující zelený gate (lint chyby, rustfmt, případné reálné regrese — ty vždy nejdřív nahlásit Pavlovi).

## Prerekvizity

Fáze 0 je první fáze — nemá závislosti na jiných fázích. Vyžaduje ale:

| Prerekvizita | Detail |
|---|---|
| Vývojové prostředí | macOS (primárně; Windows joby se iterují přes CI). Node 20.20.0, pnpm 10.27.0, Bun 1.3.6+ (CI pin 1.3.11), Rust přes **rustup** s toolchainem 1.96.0 (CI pin) + komponenty `clippy,rustfmt`. POZOR: homebrew Rust je nepoužitelný (na analyzovaném stroji měl rozbitý dyld link na LLVM) — vždy rustup. |
| Přístupy | Klon repa `neatechcz/veslo`, **push práva na non-main větve** (CI iterace vyžaduje pushovat pracovní větve), přihlášené `gh` CLI (`gh auth status`). Branch protection nastavuje člověk s admin právy (Pavel) — viz balíček 0.7. |
| Znalost mantinelů | Přečíst `docs/prestavba/ZADANI.md` (rozhodnutí Pavla) a pro kontext `docs/prestavba/analyza/SYNTEZA.md`. |
| Commit disciplína | Commit po každém dokončeném balíčku (bez `Co-Authored-By`), **push na `main` až po manuálním otestování a souhlasu Pavla**. Pracovní větve pro CI iteraci se pushují průběžně — to je součást úkolu, ne porušení pravidla. |

**Pravidlo v repu — VYŘEŠENO 2026-07-19**: `CLAUDE.md` obsahuje pravidlo „Every coding operation MUST be delegated to the Codex CLI". Pravidlo **ZŮSTÁVÁ beze změny** — vykonavatel přestavby bude pravděpodobně pracovat právě přes Codex CLI. Pokud by přesto pracoval v Claude Code, pravidlo se na přestavbové sessions nevztahuje (plán je nadřazená instrukce) — pracujte přímo.

## Milník fáze — co funguje, když je fáze hotová

1. `pnpm check` projde lokálně zeleně (lint, types, unit, rust, architecture).
2. Workflow **Quality** je zelený na `main` (všech 5 jobů + Gate) — poprvé v historii projektu.
3. Na `main` je zapnutá branch protection s required checkem `Quality / Gate`, ověřená reálně blokovaným testovacím PR.
4. V CI běží E2E suite ~14 pilot scénářů pokrývající workspace / běh agenta / skills / MCP a je zapojená jako required check (nebo minimálně zelená a připravená k zapnutí — viz balíček 0.9).
5. Existuje zdokumentovaný výsledek experimentu „per-workspace config ve sdíleném enginu" s jednoznačným doporučením pro fázi 1.
6. Existuje ověřený návod dev-verifikační smyčky (build/typecheck/spuštění + očekávané výstupy), podle kterého nový člověk rozjede prostředí bez pomoci.

## Přehled balíčků

| # | Balíček | Závislosti | Odhad (AI sessions) |
|---|---|---|---|
| 0.1 | Dev-verifikační smyčka a baseline červeného stavu | — | 1 |
| 0.2 | Oprava červených unit testů — skupina session/composer/draft (8 testů) | 0.1 | 1 |
| 0.3 | Oprava červených unit testů — skupina managed AI / skills / MCP / sidebar (6 testů) | 0.1 | 1 |
| 0.4 | Quality: zelený job Static a Rust (lint + rustfmt + clippy) | 0.1 | 1 |
| 0.5 | Quality: zelený job Services — oprava `check:services` (2 padající integrační testy) | 0.1 | 1–2 |
| 0.6 | Quality: zelený job Desktop recovery (Windows, iterace přes CI) | 0.4 | 1–2 |
| 0.7 | Zelený Gate na `main` + branch protection (checklist pro Pavla) | 0.2, 0.3, 0.4, 0.5, 0.6 | 1 |
| 0.8 | E2E gate 1/2: zprovoznění `e2e-ui.yml` (scénáře se v CI reálně spouštějí) | 0.1 | 1–2 |
| 0.9 | E2E gate 2/2: výběrová suite ~14 scénářů, stabilizace, zapnutí jako gate | 0.8, 0.7 | 1–2 |
| 0.10 | EXPERIMENT: per-workspace konfigurace ve sdíleném enginu + rozhodovací strom pro fázi 1 | 0.1 | 1 |

**Celkem: 10 balíčků, odhad 10–14 sessions.** Balíčky 0.2–0.6 a 0.8, 0.10 jsou vzájemně nezávislé a lze je dělat v libovolném pořadí (0.10 doporučuji co nejdřív — jeho výsledek potřebuje plánování fáze 1).

## Ověřený stav na HEAD 71215b07 (naměřeno 2026-07-19)

Tento snapshot je výchozí bod. POZOR: na `main` se dál přímo pushuje — každá session musí začít `git pull` a re-enumerací aktuálního stavu (příkazy v balíčcích). Naměřeno přímo na stroji:

| Kontrola | Příkaz | Stav na 71215b07 |
|---|---|---|
| Lint | `pnpm check:lint` | **FAIL** — 2 chyby `solid/reactivity`: `packages/app/src/app/components/session/composer.tsx:472` a `packages/app/src/app/context/veslo-server-connection.ts:1101` |
| Typecheck | `pnpm check:types` | PASS (~5 min, 11 workspace typechecků) |
| Architecture audity | `pnpm check:architecture` | PASS |
| App unit testy | `pnpm --filter @neatech/veslo-ui test:unit` | **FAIL** — 374 testů, 348 pass, **14 fail** (všech 14 = regex-on-source kontraktní testy, viz balíčky 0.2/0.3) |
| Solid reactivity testy | `pnpm --filter @neatech/veslo-ui test:reactivity` | PASS (45/45) |
| Renderer recovery | `pnpm --filter @neatech/veslo-ui test:renderer-recovery` | PASS (1/1) |
| Server testy | `pnpm --filter veslo-server test` | PASS (1075 pass, 0 fail) |
| Orchestrator router testy | `pnpm --filter veslo-orchestrator test:router` | PASS |
| Code-router unit | `pnpm --filter veslo-code-router test:unit` | PASS (23/23) |
| Document runtime | `pnpm --filter veslo-document-runtime test` | PASS (32/32) |
| Headless services | `pnpm check:services` | **FAIL** — 2 testy (viz balíček 0.5); padá stejně na macOS lokálně i na Windows v CI |
| Rust fmt (CI Windows) | job Quality / Rust | **FAIL** — `cargo fmt --check` hlásí formátovací drift (viditelné v logu CI runu 29696345819) |
| Desktop recovery (CI Windows) | job Quality / Desktop recovery | **FAIL** — pilot scénář `vslo-235-local-host-child-exit` selže po úspěšném buildu (viz balíček 0.6) |
| Quality / Gate | — | **FAIL** — 0 úspěchů v celé historii workflow |
| Branch protection | `gh api repos/neatechcz/veslo/branches/main/protection` | 404 = **žádná** |
| E2E UI workflow | `.github/workflows/e2e-ui.yml` | 12/12 běhů failure, vždy v kroku „Prepare sidecars"; triggeruje jen na mrtvé větvi `dev` |

Neprobováno lokálně (doběhne v balíčku 0.1): `@neatech/ai-gateway test`, `@neatech/den test`, `@neatech/worker-manager test`, `veslo-share-service test` (součásti `check:unit` za fail-fast bariérou).

---

## Balíček 0.1 — Dev-verifikační smyčka a baseline červeného stavu

### Cíl
Rozjet kompletní lokální prostředí, ověřit všechny verifikační příkazy, zdokumentovat očekávané výstupy (včetně známých červených) a vytvořit baseline, proti kterému se měří pokrok dalších balíčků. Výstupem je i krátký návod pro kohokoli dalšího.

### Vstupy
- Kód: `package.json` (root skripty `check:*`, `dev`, `dev:web`), `packages/app/package.json` (test skripty), `scripts/dev-headless-web.ts`
- Dokumentace v repu: `docs/dev/engineering-quality-gates.md`, `docs/dev/development-startup.md`
- Analýza: `docs/prestavba/analyza/doplneni.md` — Mezera 5 (stav CI/testů) a Mezera 3 (web režim, ověřené curl příkazy)

### Kroky
1. Instalace toolchainů (pokud chybí): Node 20.20.0, pnpm 10.27.0 (`corepack enable` nebo `npm i -g pnpm@10.27.0`), Bun (`curl -fsSL https://bun.sh/install | bash`), rustup + `rustup toolchain install 1.96.0 --component clippy --component rustfmt`.
2. `cd git && git pull && git log --oneline -1` — zaznamenat aktuální HEAD (plán je kalibrován na `71215b07`; pokud je HEAD novější, očekávané výstupy se mohou lišit — rozdíly zaznamenat).
3. `pnpm install --frozen-lockfile`
4. Spustit postupně a zaznamenat výstup (pass/fail + počty + trvání):
   ```bash
   pnpm check:lint            # očekávání: FAIL, 2× solid/reactivity
   pnpm check:types           # očekávání: PASS, ~5 min
   pnpm check:architecture    # očekávání: PASS
   pnpm --filter @neatech/veslo-ui test:unit 2>&1 | grep -E "^not ok|^# (tests|pass|fail)"
                              # očekávání: 374 testů, 14 fail — uložit seznam "not ok" řádků
   pnpm --filter @neatech/veslo-ui test:reactivity          # PASS 45/45
   pnpm --filter @neatech/veslo-ui test:renderer-recovery   # PASS 1/1
   pnpm --filter veslo-server test                          # PASS ~1075
   pnpm --filter veslo-orchestrator test:router             # PASS
   pnpm --filter veslo-code-router test:unit                # PASS 23
   pnpm --filter veslo-document-runtime test                # PASS 32
   pnpm --filter @neatech/ai-gateway test                   # stav neznámý — zaznamenat
   pnpm --filter @neatech/den test                          # stav neznámý — zaznamenat
   pnpm --filter @neatech/worker-manager test               # stav neznámý — zaznamenat
   pnpm --filter veslo-share-service test                   # stav neznámý — zaznamenat
   node --test scripts/quality-workflow.test.mjs            # PASS 3/3
   pnpm check:services        # očekávání: FAIL, 2 testy (~3 min)
   ```
5. Ověřit spuštění desktop aplikace: `pnpm dev` (Tauri dev s hot-reload; první Rust build trvá desítky minut). Ověřit, že se otevře okno Vesla. Ukončit Ctrl+C.
6. Ověřit headless web režim (rychlejší smyčka pro pozdější fáze):
   ```bash
   VESLO_PORT=8791 VESLO_WEB_PORT=5199 pnpm dev:web
   # v druhém terminálu:
   curl -s http://127.0.0.1:8791/health     # očekávání: ok + verze
   curl -s http://127.0.0.1:5199/ | head -3 # očekávání: HTML index
   ```
7. Zapsat výsledky do `docs/prestavba/plan/00-baseline-faze-0.md`: tabulka příkaz → očekávaný výstup → naměřený výstup + sekce „Jak rozjet prostředí od nuly" (destilát kroků 1–6).
8. Commit (jen soubor v `docs/prestavba/plan/`).

### Ověření
- Všechny příkazy z kroku 4 doběhly (byť některé červeně) a výstupy jsou zapsané.
- `pnpm dev` otevře okno aplikace; `curl http://127.0.0.1:8791/health` v dev:web režimu vrací ok.

### Hotovo znamená
- Existuje `docs/prestavba/plan/00-baseline-faze-0.md` s kompletní tabulkou baseline a návodem na prostředí.
- Je zaznamenán přesný HEAD, na kterém baseline vznikl.
- Případné odchylky od tohoto plánu (nové červené testy, jiné počty) jsou explicitně vypsané.

### Rizika a rollback
- **HEAD se posunul** a červených testů je víc/míň než 14 → nic se neopravuje, jen se aktualizuje baseline; balíčky 0.2/0.3 pak pracují s aktuálním seznamem.
- **Neprobované suity (ai-gateway, den, …) mohou být červené** → zaznamenat; pokud jsou červené, přidat jejich opravu do balíčku 0.5 nebo vytvořit nový balíček (rozhodnout podle rozsahu, informovat Pavla).
- Rollback: balíček nic nemění v kódu — není co vracet.

### Odhad
1 session.

---

## Balíček 0.2 — Oprava červených unit testů: skupina session/composer/draft

### Cíl
Zezelenat 8 ze 14 padajících unit testů — všechny z domény composer/session/draft. Všech 14 selhání jsou tzv. **regex-on-source kontraktní testy**: čtou produkční zdroják přes `readFileSync` a asserují regexem přesný tvar kódu. Selhávají, protože zdroják byl v červencových commitech refaktorován a regexy zestárly — není to (nutně) rozbité chování.

### Vstupy
- Testy (ověřené soubory + padající testy na HEAD 71215b07):

  | Testovací soubor | Padající test |
  |---|---|
  | `packages/app/src/app/pages/session-composer-entry.test.ts` | „session view receives composer target picker state from app" |
  | týž | „switchComposerTarget seeds the target draft before activating the target key" |
  | týž | „switchComposerTarget moves current pending drafts instead of cloning them" |
  | týž | „centered composer entry keeps composer text left aligned" |
  | `packages/app/src/app/pages/session-pending-instance.test.ts` | „pending session materialization remaps only that pending run UI state" |
  | `packages/app/src/app/tests/session-route-client-resume.test.ts` | „hydrates active pending draft state from the desktop draft store and prefers real session composer keys" |
  | `packages/app/src/app/context/session-lifecycle-recovery.test.ts` | „lifecycle recovery traces are mirrored into the enabled dev-runtime send trace" (regexová část souboru, ř. 20–34; zbytek souboru je behaviorální a prochází) |
  | `packages/app/src/app/tests/app-send-latency-trace.test.ts` | „pending permission interval skips active sends and single-client mode covered by SSE" |

- Produkční zdrojáky, na které regexy míří: `packages/app/src/app/app.tsx`, `pages/session.tsx`, `components/session/composer.tsx`, `context/session.ts` a sousední moduly (přesný cíl je vidět z `readFileSync(new URL(...))` na začátku každého testu).
- Analýza: `docs/prestavba/analyza/doplneni.md` — Mezera 5 (potvrzený červený stav), `docs/prestavba/analyza/ostatni-balicky.md` — §5 bod 3 (regexové meta-testy jako známý antipattern v repu), `docs/prestavba/analyza/git-historie.md` (červencové refaktory send-path, které drift způsobily).

### Kroky
1. `git pull`, pak re-enumerace aktuálních selhání (přesný příkaz pro výčet červených testů):
   ```bash
   cd git && pnpm --filter @neatech/veslo-ui test:unit 2>&1 | grep -E "^not ok"
   ```
   Mapování testu na soubor: `cd packages/app && grep -rl "<název testu>" src/app --include='*.test.ts'`.
2. Pro každý test z tabulky (spouštění jednotlivě: `cd packages/app && node --test --import=tsx/esm <cesta k testu>`):
   a. Přečíst padající regex a najít v cílovém zdrojáku aktuální podobu konstruktu, který regex hledal.
   b. Zjistit z historie, kdy a proč se zdroják rozešel s testem: `git log --oneline -10 -- <cílový zdroják>` a `git log --oneline -5 -- <testovací soubor>`.
   c. Rozhodnout podle **rozhodovací procedury**:
      - **(A) Kontrakt sémanticky stále platí, jen kód je jinak zapsaný** → minimálně upravit regex, aby odpovídal aktuálnímu kódu. (Očekávaný většinový případ.)
      - **(B) Kontrakt byl záměrně změněn** pozdějším vývojem (test popisuje chování, které už není chtěné) → test smazat nebo přepsat na aktuální kontrakt; do commit message napsat zdůvodnění s odkazem na commit, který kontrakt změnil.
      - **(C) Kontrakt platí a kód ho porušuje = reálná regrese** → NEOPRAVOVAT test ani kód; zapsat nález (soubor, řádek, co je rozbité) a **eskalovat na Pavla** — oprava produkčního kódu je zásah nad rámec tohoto balíčku a musí být schválena.
3. Po každé opravě spustit dotčený testovací soubor; na konci celou suitu: `pnpm --filter @neatech/veslo-ui test:unit`.
4. Commit (jedním commitem za balíček; do zprávy vypsat rozhodnutí A/B/C per test).

### Ověření
```bash
cd git && pnpm --filter @neatech/veslo-ui test:unit 2>&1 | grep -E "^# (tests|pass|fail)"
# fail musí klesnout o počet testů řešených v tomto balíčku (z 14 na ≤6)
```

### Hotovo znamená
- Žádný z 8 testů z tabulky není červený (opraven, nebo smazán se zdůvodněním, nebo eskalován jako regrese s explicitním záznamem).
- Nezhoršil se počet passů nikde jinde (`test:unit` celkově: fail ≤ 6, pass ≥ 348).
- Nebyl změněn žádný produkční soubor (pokud ano — jen po schválení Pavlem, zvlášť zdokumentováno).

### Rizika a rollback
- **Regexy míří na 5000řádkové soubory** (`app.tsx`, `session.tsx`) — hledání aktuálního konstruktu může být pracné; držet se `git log -S` a diffu mezi commitem, kdy test naposledy prošel, a HEAD.
- **Riziko „opravy testu" zamaskováním regrese** — proto povinná procedura A/B/C; při pochybnosti volit C (eskalace), nikdy neoslabovat assert jen aby prošel.
- Rollback: změny jsou jen v testovacích souborech — `git checkout -- <soubor>` / revert commitu je bezpečný.

### Odhad
1 session. Závisí na: 0.1.

---

## Balíček 0.3 — Oprava červených unit testů: skupina managed AI / skills / MCP / sidebar

### Cíl
Zezelenat zbývajících 6 ze 14 padajících unit testů. Stejný charakter i procedura jako balíček 0.2 (regex-on-source drift).

### Vstupy
- Testy (ověřené na HEAD 71215b07):

  | Testovací soubor | Padající test |
  |---|---|
  | `packages/app/src/app/tests/app-managed-ai-bootstrap-gate.test.ts` | „managed AI bootstrap skips veslo-server config patches when the computed managed config is unchanged" |
  | `packages/app/src/app/tests/app-managed-ai-config-sync-contract.test.ts` | „managed AI runtime config sync executes controller decisions" |
  | týž | „managed AI config sync ignores stale async runs before writing config" |
  | `packages/app/src/app/tests/app-skill-registry-events.test.ts` | „app composes the skill registry event orchestrator after extension store setup" |
  | `packages/app/src/app/tests/app-unread-session-indicator.test.ts` | „app shell passes unread state to both sidebar surfaces" |
  | `packages/app/src/app/tests/mcp-hub-contract.test.ts` | „forced hub MCP refresh queues behind in-flight refreshes" |

- Produkční zdrojáky dle `readFileSync` hlaviček testů (mj. `app.tsx`, `app-view-props.ts`, `context/app-shell-environment.ts`, MCP hub moduly).
- Analýza: stejné podklady jako balíček 0.2. Navíc pozor: poslední commity na main („SKILL MATERIALIZATION + NEW CONFIGS", „fix skill registry package contract and send reload gating") sahají přesně do skill-registry domény — drift zde může být čerstvý a záměrný (případ B).

### Kroky
Identické s balíčkem 0.2 (enumerace → per-test procedura A/B/C → run → commit), aplikované na 6 testů z tabulky.

### Ověření
```bash
cd git && pnpm --filter @neatech/veslo-ui test:unit 2>&1 | grep -E "^# (tests|pass|fail)"
# očekávání po 0.2 + 0.3: fail = 0
```

### Hotovo znamená
- `pnpm --filter @neatech/veslo-ui test:unit` = 0 fail (ve spojení s balíčkem 0.2).
- Rozhodnutí A/B/C zdokumentováno per test v commit message; případné regrese (C) eskalovány.

### Rizika a rollback
Stejná jako 0.2. Rollback: revert commitu (jen testovací soubory).

### Odhad
1 session. Závisí na: 0.1 (na 0.2 nezávisí — jiné soubory, lze paralelně).

---

## Balíček 0.4 — Quality: zelený job Static a Rust

### Cíl
Opravit dvě lokálně reprodukované příčiny červeného jobu **Quality / Static** (2 lint chyby) a příčinu červeného jobu **Quality / Rust** (rustfmt drift) a ověřit clippy + cargo testy.

### Vstupy
- Lint chyby (ověřené lokálně na 71215b07, `pnpm check:lint`):
  - `packages/app/src/app/components/session/composer.tsx:472` — `solid/reactivity`: „The reactive variable 'props.draftStorageKey' should be used within JSX, a tracked scope, or inside an event handler"
  - `packages/app/src/app/context/veslo-server-connection.ts:1101` — `solid/reactivity`: „This function should be passed to a tracked scope or an event handler because it contains reactivity"
- Rust: `packages/desktop/src-tauri/` — CI log runu Quality 29696345819 ukazuje selhání `cargo fmt --check` (diff v testovacím kódu redakce logů, mj. přeformátovaný `assert_eq!` blok kolem „server:conversation-run:lifecycle-register").
- CI definice: `.github/workflows/quality.yml` (job `static` ř. 23–46, job `rust` ř. 98–129; Rust job běží na `windows-2022` s toolchainem 1.96.0).
- Kontrakt gate: `docs/dev/engineering-quality-gates.md` (výslovně zakazuje řešit selhání přes `continue-on-error` apod.).
- Analýza: `docs/prestavba/analyza/doplneni.md` — Mezera 5.

### Kroky
1. `git pull`, reprodukce: `pnpm check:lint` (očekávané 2 chyby výše; pokud jich je jinak, zaznamenat a řešit všechny).
2. Opravit obě `solid/reactivity` chyby. Pozor — jde o produkční kód: oprava musí být **behaviorálně neutrální** (obalení do tracked scope / správné čtení props), ne umlčení pravidla. `eslint-disable` je zakázán, pokud pro něj není silné zdůvodnění schválené Pavlem. Po opravě znovu `pnpm check:lint` a cílené unit testy dotčených souborů (composer: `node --test --import=tsx/esm src/app/pages/session-composer-entry.test.ts` a okolní testy dle `grep -rl "composer" src/app --include='*.test.ts'`).
3. Rustfmt: `cargo +1.96.0 fmt --manifest-path packages/desktop/src-tauri/Cargo.toml --all` (zapíše formát), poté `cargo +1.96.0 fmt --manifest-path packages/desktop/src-tauri/Cargo.toml --all -- --check` musí projít.
4. Clippy a Rust testy lokálně (macOS): `pnpm check:rust`. POZOR: CI běží na Windows — Windows-specifický kód (`#[cfg(windows)]`) se na macOS nezkompiluje, takže lokální zelená nezaručuje CI zelenou; finální ověření je krok 6.
5. `pnpm check:types && pnpm check:architecture` (musí zůstat zelené).
6. Commit na pracovní větev `faze0/quality-static-rust`, push, otevřít **draft PR do main** → tím se spustí Quality. Ověřit v CI: joby `Quality / Static` a `Quality / Rust` zelené (`gh pr checks` nebo `gh run watch`).
7. Po zelené CI: merge/rebase do main dle dohody s Pavlem (v této fázi ještě není branch protection — nechat merge na Pavlovi, nebo mergnout po jeho souhlasu).

### Ověření
```bash
cd git && pnpm check:lint && echo LINT-OK
cargo +1.96.0 fmt --manifest-path packages/desktop/src-tauri/Cargo.toml --all -- --check && echo FMT-OK
pnpm check:rust && echo RUST-OK
gh run list --workflow=quality.yml --limit 1   # poslední běh na PR větvi: static PASS, rust PASS
```

### Hotovo znamená
- `Quality / Static` a `Quality / Rust` zelené v CI na commitu obsahujícím opravy.
- Lint opraven bez `eslint-disable` a bez změny chování (dotčené unit testy zelené).

### Rizika a rollback
- **Oprava `solid/reactivity` může změnit reaktivní chování** (přesně tahle doména generovala historicky nejvíc bugů — viz `git-historie.md` §3). Minimalizovat zásah; po merge ověřit ručně v `pnpm dev`, že composer funguje (napsat zprávu, přepnout session).
- **Clippy na Windows může hlásit chyby neviditelné na macOS** → iterace přes PR CI (proto pracovní větev).
- Rollback: revert commitu; změny jsou malé a izolované.

### Odhad
1 session. Závisí na: 0.1.

---

## Balíček 0.5 — Quality: zelený job Services — oprava `check:services`

### Cíl
Opravit 2 padající testy headless services integrace. Je to nejcennější existující test v repu — jediný, který ověřuje reálnou BE kompozici (orchestrator + veslo-server + fake OpenCode) bez UI, tedy přesně vrstvu, která se ve fázích 2+ stane samostatným backendem.

### Vstupy
- Test: `scripts/headless-services.integration.test.mjs` (spouští se přes `pnpm check:services`, který nejdřív buildne server binary: `pnpm --filter veslo-server build:bin`).
- Padající testy (ověřeno lokálně na macOS i v CI na Windows — **není to Windows-specifické**):
  1. „headless services recover a dropped upstream prompt connection through the materialized session"
  2. „headless services resume a queued follow-up after a full topology restart"
- Diagnostika: test při selhání zachovává runtime artefakty — cesta je v chybové hlášce, vzor `.tmp/headless-services-*/logs/<uuid>/orchestrator.log` + `trace/<uuid>/server.ndjson`, `orchestrator.ndjson` (funkce `preservedRuntimeError`, ~ř. 264 testu).
- Produkční kód, kterého se testy týkají: `packages/server/src/conversation-run-lifecycle-controller.ts`, `packages/server/src/conversation-service.ts`, `packages/orchestrator/src/run-store.ts`, `run-registry.ts` (recovery/queue dráhy).
- Analýza: `docs/prestavba/analyza/doplneni.md` — Mezera 5 §5.6 bod 2 (proč je tento test klíčový), `docs/prestavba/analyza/server.md` a `orchestrator.md` (mapy vrstev).

### Kroky
1. `git pull`, reprodukce: `cd git && pnpm check:services` — potvrdit, že padají tytéž 2 testy (~3 min běh).
2. Analýza artefaktů z `.tmp/headless-services-*/`: přečíst `orchestrator.log` a oba `.ndjson` trace soubory; najít, ve kterém kroku scénář uvázl (recovery po přerušeném prompt spojení / obnova fronty po restartu topologie).
3. Určit příčinu — tři možné třídy:
   - **(a) Test zestárl vůči záměrné změně chování** (červencové přestavby transcript/run lifecycle — viz `git-historie.md`): upravit test na aktuální kontrakt, zdůvodnit commitem, který chování změnil.
   - **(b) Reálný bug v recovery dráze** (server/orchestrator): jde o stabilizační bugfix, který feature freeze připouští — opravit produkční kód minimálním zásahem, ale **před zásahem nahlásit Pavlovi nález + návrh opravy** (recovery dráha je citlivá).
   - **(c) Flaky/timing na pomalém stroji**: prokázat opakovanými běhy (5× za sebou); pak zvýšit determinismus testu (ne timeouty naslepo).
4. Po opravě: `pnpm check:services` 3× za sebou zeleně (ochrana proti flake).
5. Doběhnout i zbytek `check:unit` řetězu, který byl dosud za fail-fast bariérou: `pnpm check:unit` celé (zahrnuje i ai-gateway/den/worker-manager/share-service testy — pokud tam baseline z 0.1 našel červené, opravit zde stejnou procedurou, nebo pokud je rozsah velký, vrátit Pavlovi návrh na samostatný balíček).
6. Commit na větev `faze0/services`, push, draft PR → ověřit `Quality / Services (Windows)` a `Quality / Unit` zelené v CI.

### Ověření
```bash
cd git && for i in 1 2 3; do pnpm check:services || break; done && echo SERVICES-OK-3x
pnpm check:unit && echo UNIT-CHAIN-OK
gh pr checks   # Services (Windows) PASS, Unit PASS
```

### Hotovo znamená
- `pnpm check:services` stabilně zelené lokálně (3× po sobě) i v CI na Windows.
- Celý `pnpm check:unit` řetěz zelený lokálně.
- Případný produkční bugfix schválen Pavlem a zdokumentován (co bylo rozbité, jak se to projevovalo).

### Rizika a rollback
- **Nejnejistější balíček fáze** — recovery dráha je hluboká (lifecycle controller má 1 654 řádků) a příčina může být architektonická (pak hrozí přetečení do 2 sessions; při zablokování napsat handoff dokument se stavem diagnostiky).
- Windows CI může mít dodatečné selhání i po lokální zelené (path handling) → iterace přes PR.
- Rollback: revert commitu. Pokud byla oprava produkční (třída b), revert vrací i bug — proto samostatný commit pro test a samostatný pro produkční fix.

### Odhad
1–2 sessions. Závisí na: 0.1.

---

## Balíček 0.6 — Quality: zelený job Desktop recovery (Windows)

### Cíl
Zprovoznit job `Quality / Desktop recovery` — jediný desktop E2E krok v Quality: build debug Tauri binárky s e2e feature na Windows + běh pilot scénáře `vslo-235-local-host-child-exit` (ověřuje: engine ready → řízený pád child procesu → automatická náhrada s novým PID → zdravý host).

### Vstupy
- CI definice: `.github/workflows/quality.yml` ř. 131–173 (runner `windows-2022`, timeout 45 min, instaluje `tauri-pilot-cli 0.7.2` přes cargo, při selhání uploaduje artefakt `quality-desktop-recovery-diagnostics` z `packages/e2e/tauri-pilot-failures/**`).
- Lokální ekvivalent: root skript `check:desktop-recovery` (`package.json:27`): build server binary → `prepare:sidecar` → `tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e` → `pilot-runner.ts --scenario vslo-235-local-host-child-exit`.
- Scénář: `packages/e2e/pilot-scenarios/vslo-235-local-host-child-exit.toml`; runner: `packages/e2e/helpers/pilot-runner.ts`.
- Stav v CI (run 29696345819): build proběhl, selhal až samotný `pilot-runner.ts` běh (exit 1) — příčina je v artefaktu diagnostiky.
- Analýza: `docs/prestavba/analyza/doplneni.md` — Mezera 5; `docs/prestavba/analyza/ostatni-balicky.md` — §2 (mechanika tauri-pilot, unix socket / named pipe).

### Kroky
1. Stáhnout diagnostiku posledního selhání: `gh run list --workflow=quality.yml --limit 1` → `gh run download <run-id> --name quality-desktop-recovery-diagnostics --dir /tmp/dr-diag` (pokud artefakt neexistuje, spustit čerstvý běh přes draft PR z kroku 3). Analyzovat logy scénáře.
2. Volitelně reprodukce na macOS: `pnpm check:desktop-recovery` (scénář není Windows-only; lokální běh vyžaduje `cargo install tauri-pilot-cli --version 0.7.2 --locked` a plný debug Rust build — desítky minut; žádná jiná instance Vesla nesmí běžet — single-tenant pravidlo z `AGENTS.md`). Pokud padá i na macOS, ladit lokálně (rychlejší smyčka).
3. Opravit příčinu (typické třídy: časování startu enginu ve scénáři, cesty na Windows, stale assert po červencových změnách runtime). Iterovat přes větev `faze0/desktop-recovery` + draft PR → CI.
4. Po zelené: 2× po sobě zelený běh jobu v CI (re-run přes `gh run rerun <id>`), kvůli flake.
5. **Fallback (rozhodnutí Pavla):** pokud po 2 sessions není stabilně zelený, předložit Pavlovi volbu: (a) dočasně vyjmout job z agregátu `gate` v `quality.yml` (s TODO a issue), aby šla zapnout branch protection se zbylými 4 joby, nebo (b) investovat další session. Bez Pavlova souhlasu gate neoslabovat.

### Ověření
```bash
gh run list --workflow=quality.yml --limit 2   # job Desktop recovery: success 2× po sobě
# lokálně (volitelné): pnpm check:desktop-recovery && echo DR-OK
```

### Hotovo znamená
- `Quality / Desktop recovery` zelený ve 2 po sobě jdoucích CI bězích, NEBO zdokumentované a Pavlem schválené dočasné vyjmutí z Gate s follow-up úkolem.

### Rizika a rollback
- **Nejdražší iterační smyčka fáze**: každý CI běh = Rust build na Windows (~10+ min i s cache) + pilot běh; artefakty číst pečlivě, neiterovat naslepo.
- Externí závislost `tauri-pilot-cli 0.7.2` (cizí nástroj, pin) — pokud je příčina v něm, zvážit upgrade pinu (malý, kontrolovaný zásah).
- Scénář může být zastaralý vůči červencovým runtime změnám → úprava TOML se zdůvodněním je legitimní (má hodnotu specifikace, viz analýza).
- Rollback: revert; job byl červený i před balíčkem, nic se nerozbije víc.

### Odhad
1–2 sessions. Závisí na: 0.4 (Rust prostředí a fmt/clippy vyřešené, ať se chyby nemíchají).

---

## Balíček 0.7 — Zelený Gate na `main` + branch protection

### Cíl
Dostat kompletní Quality (všech 5 jobů + Gate) zeleně na `main` a zapnout branch protection s required checkem `Quality / Gate`. Zapnutí provádí člověk s admin právy (Pavel) podle checklistu níže; balíček checklist připraví, provede podpůrné kroky a ověří vynucování testovacím PR.

### Vstupy
- Výsledky balíčků 0.2–0.6 (všechny joby jednotlivě zelené na pracovních větvích).
- `.github/workflows/quality.yml` (job `gate`, name `Quality / Gate` — přesný název required checku).
- `docs/dev/engineering-quality-gates.md` ř. ~88–92 („administrators must separately require only Quality / Gate … verify it with a real blocked pull request").
- Analýza: `docs/prestavba/analyza/doplneni.md` — Mezera 5 §5.4 (potvrzení: protection dnes žádná; přímé pushe na main).

### Kroky
1. Zajistit, že opravy z balíčků 0.2–0.6 jsou sloučené do `main` (po souhlasu Pavla), a počkat na Quality běh na `main`: `gh run watch $(gh run list --workflow=quality.yml --branch main --limit 1 --json databaseId --jq '.[0].databaseId')` — **všech 5 jobů + Gate zelené**. To je historicky první zelený Quality — zaznamenat run ID.
2. Předat Pavlovi checklist (níže) a asistovat.
3. Po zapnutí protection provést **ověřovací test vynucení**: větev `faze0/protection-probe` se záměrnou lint chybou → PR do `main` → počkat na červený `Quality / Gate` → ověřit, že GitHub **blokuje merge** → PR zavřít bez merge, větev smazat.
4. Zapsat výsledek (datum, kdo zapnul, run ID prvního zeleného Quality, číslo blokovaného PR) do `docs/prestavba/plan/00-baseline-faze-0.md`.

#### Checklist pro Pavla (vyžaduje admin práva na neatechcz/veslo)
Varianta UI:
1. GitHub → `neatechcz/veslo` → **Settings → Branches → Add classic branch protection rule** (nebo Rulesets → New branch ruleset).
2. Branch name pattern: `main`.
3. Zaškrtnout **Require status checks to pass before merging** → vyhledat a přidat check **`Quality / Gate`** (jen tento jeden — jednotlivé joby ne, agregát je hlídá).
4. Zaškrtnout **Require branches to be up to date before merging**.
5. Zaškrtnout **Do not allow bypassing the above settings** (platí i pro adminy).
6. Ponechat vypnuté „Require pull request reviews" (tým je malý, review vynucovat nechceme — jen zelený gate).
7. Uložit.

Varianta CLI (ekvivalent, spustí Pavel):
```bash
gh api -X PUT repos/neatechcz/veslo/branches/main/protection \
  -H "Accept: application/vnd.github+json" \
  --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "checks": [ { "context": "Quality / Gate" } ] },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
```
Kontrola: `gh api repos/neatechcz/veslo/branches/main/protection --jq '.required_status_checks.checks'` → musí vrátit `Quality / Gate`.

**Důsledek pro workflow týmu (říct Pavlovi explicitně):** po zapnutí už nejde pushovat přímo na `main` se selhávajícím Quality — veškerá práce jde přes PR, nebo přes push na main se zeleným Quality. To je záměr fáze 0.

### Ověření
```bash
gh api repos/neatechcz/veslo/branches/main/protection --jq '{strict: .required_status_checks.strict, checks: [.required_status_checks.checks[].context], enforce_admins: .enforce_admins.enabled}'
# očekávání: checks == ["Quality / Gate"], enforce_admins == true
# + existuje zavřený probe PR, u kterého GitHub hlásil "Merging is blocked"
```

### Hotovo znamená
- Quality zelený na `main` (run ID zaznamenáno).
- Branch protection na `main` aktivní s required checkem `Quality / Gate`, `enforce_admins` zapnuto.
- Vynucení ověřeno reálně blokovaným PR (číslo zaznamenáno).

### Rizika a rollback
- **Mezi zelenou na větvích a mergem do main může někdo pushnout nové červené** (main je do té doby nechráněný) → udělat merge + zapnutí protection v co nejkratším okně, ideálně v koordinaci s Pavlem („nikdo nepushuje, dokud nezapneme").
- Zapnutá protection zablokuje release proces, pokud release skripty pushují přímo na main → prověřit `scripts/release/*` (release dělá tag + workflow_dispatch, ne push do main — ale ověřit); případný konflikt nahlásit Pavlovi před zapnutím.
- Rollback: protection lze v Settings kdykoli vypnout (Pavel) — žádná změna kódu.

### Odhad
1 session (plus Pavlův admin krok). Závisí na: 0.2, 0.3, 0.4, 0.5, 0.6.

---

## Balíček 0.8 — E2E gate 1/2: zprovoznění `e2e-ui.yml` (scénáře se v CI reálně spouštějí)

### Cíl
Dostat E2E UI workflow ze stavu „12/12 běhů umřelo v setup kroku Prepare sidecars" do stavu „pilot scénáře se v CI reálně vykonávají a reportují výsledky". Bez toho nelze stavět E2E gate (balíček 0.9).

### Vstupy
- Workflow: `.github/workflows/e2e-ui.yml` — triggeruje jen na `dev` (mrtvá větev, poslední aktivita 2026-06-25); vlastní komentář ř. 48–50 přiznává nedokončenost: „Sidecar download — adapt the full platform-aware download logic from build-desktop.yml when enabling this workflow."
- **Hlavní diagnostická hypotéza (ověřeno čtením workflow na HEAD):** `e2e-ui.yml` **neinstaluje Bun**, zatímco funkční `build-desktop.yml` má `oven-sh/setup-bun@v2` před krokem `prepare:sidecar` (ř. 54, 79) a `prepare-sidecar.mjs` Bun potřebuje (kompiluje `veslo-server` a `veslo-code-router` na bun targety — `packages/desktop/scripts/prepare-sidecar.mjs`, ř. ~153–208, `bunTarget`). Srovnat oba workflow soubory krok po kroku.
- Sidecar skript: `packages/desktop/scripts/prepare-sidecar.mjs`.
- Runner a suite: `packages/e2e/helpers/pilot-runner.ts` (suite `current-gate` = 25 scénářů, ř. 77–111), `packages/e2e/package.json:12`.
- Analýza: `docs/prestavba/analyza/doplneni.md` — Mezera 5 §5.1, §5.4; `docs/prestavba/analyza/ostatni-balicky.md` — §2 a §5 (mechanika tauri-pilot, rizika).

### Kroky
1. Diff setup kroků `e2e-ui.yml` vs. `build-desktop.yml` a vs. `quality.yml` job `desktop-recovery` (ten sidecar krok v CI zvládá — projde až k pilot běhu). Přenést chybějící kroky (minimálně `oven-sh/setup-bun@v2`; zkontrolovat i verzi pnpm/Node pin a `GITHUB_TOKEN` env).
2. Úpravy workflow na větvi `faze0/e2e-ui`:
   - přidat trigger `pull_request: branches: [main]` a `push: branches: [main]` (dev nechat — uklidí se ve fázi 1),
   - **zmenšit matici na jeden OS** pro zprovoznění: `macos-latest` (nejblíž primární dev platformě) — ubuntu a windows přidat až po zelené (windows je povinná platforma, přidat v balíčku 0.9),
   - nechat běžet default suite `current-gate` (výběrová suite se řeší v 0.9).
3. Otevřít draft PR → sledovat běh: `gh run watch`. Iterovat, dokud krok „Prepare sidecars" a „Build Tauri" neprojdou a **pilot scénáře se nezačnou vykonávat** (v logu vidět jednotlivé scénáře).
4. Zaznamenat výsledek prvního reálného běhu 25 scénářů (kolik pass/fail — očekávejme selhání, scénáře 2 měsíce nikdo nespouštěl; jejich stabilizace je 0.9).
5. Commit + ponechat PR otevřený pro balíček 0.9 (nebo merge po dohodě, workflow zatím nikoho neblokuje — není required).

### Ověření
```bash
gh run list --workflow=e2e-ui.yml --limit 1
gh run view <run-id> --log | grep -E "scenario|Running" | head -30
# důkaz DoD: v logu jsou vidět spuštěné scénáře (např. "smoke", "navigation"), ne smrt v "Prepare sidecars"
```

### Hotovo znamená
- CI běh `E2E UI Tests`, ve kterém setup (sidecars + Tauri debug build) prošel a pilot runner vykonal scénáře (bez ohledu na jejich pass/fail).
- Zapsaný seznam pass/fail per scénář z prvního běhu (vstup pro 0.9).

### Rizika a rollback
- Za Bun hypotézou mohou být další vrstvy selhání (download rate-limit GitHub releases, platformní cesty) → proto iterace na jednom OS.
- Tauri debug build v CI je pomalý (`Swatinem/rust-cache` je ve workflow — ověřit, že cache funguje; jinak běhy 30+ min).
- Rollback: změny jen v `.github/workflows/e2e-ui.yml` na větvi — revert bez dopadu (workflow je dnes stejně nefunkční).

### Odhad
1–2 sessions. Závisí na: 0.1.

---

## Balíček 0.9 — E2E gate 2/2: výběrová suite ~14 scénářů, stabilizace, zapnutí jako gate

### Cíl
Vybrat ~10–15 z 80 TOML scénářů pokrývajících 4 povinná flow (workspace, běh agenta, skills, MCP), stabilizovat je v CI a zapojit jako skutečně vynucovaný gate.

### Vstupy
- Scénáře: `packages/e2e/pilot-scenarios/*.toml` (80 souborů, existence všech kandidátů níže ověřena výpisem adresáře na HEAD 71215b07).
- Runner + suite definice: `packages/e2e/helpers/pilot-runner.ts` (`PILOT_SCENARIO_SUITES`, ř. 77–111).
- **Kontraktní zámek**: `packages/e2e/helpers/pilot-selection-contract.test.ts` — ř. 63 zamyká počet TOML na 80, ř. 124 zamyká fixture `helpers/__fixtures__/pilot-selection-contract.v1.json` na 93 případů. Přidání suite vyžaduje **záměrnou** regeneraci fixture (test to v chybové hlášce vyžaduje) — jinak spadne kontraktní test v `check:unit` řetězu.
- Interní audit kvality scénářů: `docs/testing/findings/2026-07-16-tauri-pilot-dev-runtime-parity-audit.md` (22 z 25 current-gate scénářů mutuje localStorage sdílené instance aplikace → výsledky závislé na pořadí; gate běží nad syntetickým účtem).
- Analýza: `docs/prestavba/analyza/doplneni.md` — Mezera 5 §5.2 (bilance 80 scénářů), `docs/prestavba/analyza/ostatni-balicky.md` — §5, §9 bod 1.

#### Navržení kandidáti (14 scénářů; názvy = soubory v `pilot-scenarios/`, existence ověřena)

| Flow | Scénář | Dnešní status |
|---|---|---|
| Workspace | `smoke` | v current-gate |
| Workspace | `veslo-server-startup` | v current-gate |
| Workspace | `navigation` | v current-gate |
| Workspace | `folder-access-consent` | jen ruční skript (`test:pilot:folder-access-consent`) |
| Workspace | `multi-workspace-restart` | **osiřelý** (žádný vstupní bod — prověřit aktuálnost, kritické multi-workspace flow) |
| Běh agenta | `session` | v current-gate |
| Běh agenta | `composer` | v current-gate |
| Běh agenta | `session-message-replacement` | v current-gate |
| Běh agenta | `session-artifacts` | v current-gate |
| Skills | `skills-global-inventory` | v current-gate |
| Skills | `skill-registry-materialization` | v current-gate |
| Skills | `shared-workspace-skill-lock` | v current-gate |
| MCP | `extensions-mcp` | v current-gate |
| MCP | `google-mcp-connectors` | jen ruční skript (`test:pilot:google-mcp`); běží proti fixture serverům, ne živému Googlu — ověřit hermetičnost v helpers |

Náhradníci (pokud se některý kandidát ukáže nestabilizovatelný): `session-capabilities`, `session-prefetch`, `settings-gear-navigation`, `sharepoint-mcp-connectors`, `skills-enabled-state`. NEvybírat: `live-*` a `den-managed-*` scénáře (vyžadují reálné credentials), `visual-regression` (křehká PNG baseline, 21 MB v gitu), jednorázové `vslo-*` regresní scénáře (kromě child-exit, který už hlídá Quality).

### Kroky
1. Ověřit kandidáty proti výsledkům prvního reálného běhu z balíčku 0.8: kandidáti, kteří prošli, jdou rovnou do suite; u padajících rozhodnout opravit/nahradit náhradníkem (procedura jako 0.2: scénář je specifikace — upravit smí se zdůvodněním, při podezření na reálnou regresi eskalovat).
2. U `multi-workspace-restart`, `folder-access-consent` a `google-mcp-connectors` nejdřív lokální běh (`pnpm --filter @neatech/veslo-e2e exec node --import=tsx/esm ./helpers/pilot-runner.ts --scenario <název>` po `check:desktop-recovery`-stylu buildu) — jsou mimo current-gate, jejich stav je neznámý.
3. Přidat do `PILOT_SCENARIO_SUITES` v `pilot-runner.ts` novou suite `rebuild-gate` se schválenou množinou; přidat skript `test:e2e:gate` do `packages/e2e/package.json` a root `package.json`. Regenerovat fixture kontraktního testu (dle instrukce v chybové hlášce testu) a spustit `node --import=tsx/esm --test helpers/*.test.ts` v `packages/e2e` (všechny kontraktní testy v `helpers/` musí projít — konkrétní počet neuvádíme, stárne).
4. Přepnout `e2e-ui.yml` z default suite na `--suite rebuild-gate`; kvůli pořadové závislosti (localStorage audit) seřadit scénáře od nejizolovanějších a ověřit, že suite projde i v obráceném pořadí (rychlý detektor pořadové závislosti) — pokud ne, zúžit/opravit dotčené scénáře.
5. Rozšířit matici na `macos-latest` + `windows-latest` (Windows je povinná platforma dle ZADANI). Ubuntu vynechat (není cílová platforma — úspora CI času).
6. Stabilita: 3 po sobě zelené běhy na obou OS (re-run přes `gh run rerun`).
7. **Zapnutí jako vynucovaný gate** (s Pavlem): přidat required check jobu E2E do branch protection na `main` (stejný postup jako balíček 0.7 — `gh api` s rozšířeným `checks` polem; přesný název checku = jméno jobu z workflow, ověřit přes `gh api repos/neatechcz/veslo/commits/<sha>/check-runs --jq '.check_runs[].name'`). Pokud je E2E běh příliš pomalý na PR smyčku (>25 min), předložit Pavlovi alternativu: required jen na `push` do main + PR jen Quality — rozhodnutí zapsat.
8. Commit + merge přes PR (nyní už přes zapnutou protection z 0.7).

### Ověření
```bash
cd packages/e2e && node --import=tsx/esm --test helpers/*.test.ts   # kontraktní testy vč. regenerované fixture
gh run list --workflow=e2e-ui.yml --limit 3   # 3× success (oba OS)
gh api repos/neatechcz/veslo/branches/main/protection --jq '[.required_status_checks.checks[].context]'
# očekávání: obsahuje Quality / Gate + E2E check
```

### Hotovo znamená
- Suite `rebuild-gate` (10–15 scénářů, všechna 4 flow pokrytá) existuje v runneru, kontraktní testy zelené.
- 3 po sobě zelené CI běhy na macOS + Windows.
- Check zapnutý v branch protection (nebo Pavlem schválená a zapsaná alternativa vynucování).

### Rizika a rollback
- **Největší nejistota fáze vedle 0.5**: 25 current-gate scénářů nemá jediný dokončený CI běh v historii; reálná pass-rate je neznámá do konce balíčku 0.8. Rozsah stabilizace může přetéct — pak zúžit suite (minimum: 10 scénářů, každé flow ≥2) a zbytek nechat jako follow-up.
- Pořadová závislost přes sdílený localStorage (audit 2026-07-16) — detektor v kroku 4; skutečná oprava izolace je práce pro fázi 1+, tady se jí vyhýbáme výběrem robustních scénářů.
- Windows běhy tauri-pilot mají named-pipe mechaniku (`app-launcher.ts:411–418`) — historicky netestováno v CI; možná platformní překvapení.
- Rollback: suite je aditivní (nový klíč v `PILOT_SCENARIO_SUITES` + workflow přepnutí) — revert commitu vrací current-gate stav; branch protection úprava se dá vrátit v Settings.

### Odhad
1–2 sessions. Závisí na: 0.8 (funkční workflow), 0.7 (protection existuje — pro krok 7).

---

## Balíček 0.10 — EXPERIMENT: per-workspace konfigurace ve sdíleném enginu

### Cíl
Empiricky rozhodnout klíčovou otázku pro fázi 1: **čte OpenCode (stock binárka 1.17.13, dnešní pin) projektovou konfiguraci per session directory, když jeden sdílený proces obsluhuje víc adresářů?** Dnes je výchozí topologie na macOS/Windows `shared-unsandboxed` (jeden engine pro všechny workspace) a orchestrátor před každým mutujícím requestem kopíruje config workspace do JEDNOHO sdíleného config diru — dva workspace s odlišnou konfigurací (MCP, skills) si ji vzájemně přepisují, **last writer wins** (jizva 4). Výsledek experimentu určuje, zda fáze 1 může smazat engine pool a config-sync hack, nebo musí volit jinou cestu.

### Vstupy
- Analýza: `docs/prestavba/analyza/multi-workspace.md` — celý dokument, zejména §1 (topologie), jizva 4 v §3, §4 (co umí OpenCode: per-request `?directory=` ověřen, per-directory CONFIG neověřen) a §5 varianta A.
- Kód (ověřeno na HEAD): `packages/orchestrator/src/cli.ts` ř. ~4459–4475 (SharedOpenCodeEngine: jeden `configDirectory = dataDir/opencode-config/shared-unsandboxed`) a ř. ~5459–5461 (`syncWorkspaceOpencodeConfigToConfigDir` na každý non-GET request); `packages/orchestrator/src/engine-topology.ts` (režimy a env přepínače); `packages/desktop/src-tauri/src/runtime_preferences.rs:33–35` (shared default na mac/win).
- Kanonický doc: `docs/dev/opencode-workspace-runtime-architecture.md` — sekce „Verified OpenCode Behavior" (empirie na 1.16.2: sessions v různých adresářích fungují; o configu neříká nic → přesně to doplňujeme).
- Binárka: `packages/desktop/src-tauri/sidecars/veslo-code`. **POZOR:** lokální kopie může být stará (na analyzovaném stroji hlásila 1.14.29). Pin je `opencodeVersion: 1.17.13` (`packages/desktop/package.json:5`) — před experimentem binárku obnovit přes `pnpm --filter @neatech/veslo run prepare:sidecar` a ověřit `./packages/desktop/src-tauri/sidecars/veslo-code --version` → `1.17.13`.

### Kroky

**Příprava (izolovaně od běžící instance Vesla — nic z Vesla nesmí běžet):**
1. Obnovit binárku na 1.17.13 (viz výše).
2. Vytvořit scratch strukturu (mimo repo, např. `/tmp/veslo-exp/`):
   - `global-config/` — neutrální globální config dir (prázdný nebo minimální `opencode.json`),
   - `ws-a/` a `ws-b/` — dva „workspace" adresáře s **rozdílnou** projektovou konfigurací:
     - `ws-a/opencode.json`: `{"mcp": {"probe-a": {"type": "local", "command": ["node", "/tmp/veslo-exp/canary-a.js"], "enabled": true}}}` a `ws-a/.opencode/skills/skill-a/SKILL.md` (minimální skill),
     - `ws-b/` totéž s `probe-b`, `canary-b.js`, `skill-b`.
   - `canary-a.js` / `canary-b.js`: mini MCP „kanárek" — Node skript, který při spuštění zapíše marker soubor (`/tmp/veslo-exp/started-a.txt` resp. `-b.txt`) a pak čte stdin (drží proces). Slouží jako filesystem důkaz, že engine daný MCP server nastartoval.
3. Spustit sdílený engine ručně, přesně jako orchestrátor: `OPENCODE_CONFIG_DIR=/tmp/veslo-exp/global-config ./packages/desktop/src-tauri/sidecars/veslo-code serve --hostname 127.0.0.1 --port 4599` s workdir `/tmp/veslo-exp/` (neutrální adresář, ani A ani B). (Orchestrátor spouští `veslo-code serve --hostname <host> --port <port>` — `cli.ts:2684`; config adresář předává env proměnnou `OPENCODE_CONFIG_DIR` — `cli.ts:2733`, srov. 2412. **POZOR: nezaměnit s `OPENCODE_CONFIG`** — ta v upstreamu značí cestu ke config SOUBORU. Auth vypnout/neřešit, jde o lokální experiment.) Kontrolní sonda, že engine globální config dir skutečně načetl: do `global-config/opencode.json` vlož rozpoznatelný marker (např. MCP klíč `probe-global`) a ověř, že ho `GET /config` (bez `directory` parametru) vrací.

**Sondy (od nejprůkaznější):**
4. Stáhnout OpenAPI popis API: `curl -s http://127.0.0.1:4599/doc > /tmp/veslo-exp/openapi.json` a projít: (a) přijímá `GET /config` parametr `directory`? (b) existuje per-request/per-session config override? (c) jaké endpointy vracejí MCP/commands/agents seznam?
5. Sonda CONFIG: `curl -s "http://127.0.0.1:4599/config?directory=/tmp/veslo-exp/ws-a"` vs. `...ws-b` — liší se vrácený config (mcp klíče `probe-a`/`probe-b`)? Totéž bez parametru (globál).
6. Sonda SESSION: vytvořit session v každém adresáři (`curl -X POST "http://127.0.0.1:4599/session?directory=/tmp/veslo-exp/ws-a" -H 'Content-Type: application/json' -d '{}'`, dtto ws-b) a per session dotáhnout, co engine vidí (endpointy z kroku 4 — commands/skills/MCP status pro session/directory).
7. Sonda KANÁREK (filesystem důkaz): po vytvoření sessions zkontrolovat `ls /tmp/veslo-exp/started-*.txt` — spustil engine `probe-a` jen pro session v A a `probe-b` jen pro session v B? Nebo oba/žádný globálně?
8. Sonda INTERFERENCE: změnit `ws-a/opencode.json` za běhu (přidat další MCP), vytvořit novou session v A a ověřit, že (ne)ovlivnila session/config v B.
9. Vše zapsat do `docs/prestavba/plan/00-vysledek-experimentu-config.md`: verze binárky, přesné příkazy, raw odpovědi, verdikt.

**Interpretace — rozhodovací strom pro fázi 1:**

- **Výsledek V1 — engine čte projektový config per directory** (sondy 5–7 ukazují rozdílný config/MCP per adresář): → Fáze 1 může provést **variantu A z multi-workspace analýzy v plné síle**: smazat `pooled-per-workspace` topologii (EnginePool, 1 058 ř. + LRU/idle/restart mašinérie), **smazat per-request `syncWorkspaceOpencodeConfigToConfigDir` hack** — config žije ve workspace a engine si ho čte sám. Jizva 4 (last-writer-wins) zaniká bez náhrady.
- **Výsledek V2 — engine čte jen globální config dir** (sessions v A i B vidí totéž; kanárci startují podle globálu):
  - **V2a — API nabízí config override per request/session** (nalezeno v kroku 4): → fáze 1 maže pool i sync hack, config se předává per request z veslo-serveru. Mírně větší práce než V1 (server musí config skládat), ale topologicky stejný výsledek.
  - **V2b — žádný per-request mechanismus**: → fáze 1 má tři možnosti, rozhodne Pavel s těmito daty: (i) **pool per workspace jako jediná topologie** (varianta B z analýzy — smazat shared, nechat pool; per-workspace config přirozeně, ale zůstává správa flotily procesů), (ii) shared engine + serializace mutací se sync hackem (status quo — nedoporučeno, korektnostní díra trvá), (iii) **upgrade enginu** na novější verzi (upstream jede ~1,5 dne/release; funkce mohla přibýt) a experiment zopakovat — levný test, dělat před rozhodnutím (i).
- **Výsledek V3 — částečně** (např. skills per directory, MCP globálně): → zmapovat, které per-workspace rozdíly Veslo reálně potřebuje (MCP a skills ano — obě flow jsou v povinné čtyřce), a rozhodnout per vrstva: co je per-directory, přestat synchronizovat; co je globální, řešit dle V2a/V2b.
- **Výsledek V4 — nedeterministické/kešované chování**: zopakovat s restartem enginu mezi kroky; pokud nestabilní i pak, zacházet jako s V2b a nález (nedeterminismus) explicitně zapsat — je to samostatný argument proti spoléhání na sdílený config.

**Úklid:** zabít engine proces, smazat `/tmp/veslo-exp/`.

### Ověření
- Existuje `docs/prestavba/plan/00-vysledek-experimentu-config.md` s: verzí binárky (musí být 1.17.13), přesnými příkazy, raw výstupy sond 4–8, jednoznačným verdiktem (V1/V2a/V2b/V3/V4) a doporučením pro fázi 1 dle stromu výše.
- Reprodukovatelnost: dokument obsahuje vše potřebné k zopakování experimentu na jiné verzi enginu (bude se hodit při budoucích upgradech).

### Hotovo znamená
- Verdikt je podložen minimálně dvěma nezávislými sondami (API odpověď + filesystem kanárek).
- Plánovací dokument fáze 1 má k dispozici jednoznačný vstup: „pool se maže a config sync se maže" NEBO „pool se maže, config per request" NEBO „pool zůstává jedinou topologií" NEBO eskalace na Pavla (V2b/V4).

### Rizika a rollback
- Endpointy/parametry API se mohou lišit od předpokladů — proto krok 4 (OpenAPI discovery) předchází sondám; při nejasnosti konzultovat zdroják upstreamu `anomalyco/opencode` tag v1.17.13 (config loading vrstva).
- Experiment nesmí běžet vedle živé instance Vesla (kolize portů/procesů, single-tenant pravidlo) — preflight: `ps aux | grep -E "veslo|opencode" | grep -v grep` musí být čistý.
- Žádný rollback není potřeba — experiment se repa nedotýká (jen scratch adresář + výsledkový dokument v `docs/prestavba/plan/`).

### Odhad
1 session. Závisí na: 0.1. **Doporučené pořadí: co nejdřív — výsledek potřebuje plánování fáze 1.**

---

## Souhrn rizik fáze

1. **Pohyblivý cíl**: na `main` se dál přímo pushuje (bez protection až do balíčku 0.7) — mezi baseline a dokončením mohou přibýt nové červené testy. Mitigace: každý balíček začíná `git pull` + re-enumerací; balíček 0.7 zavírá okno co nejrychlejší koordinací s Pavlem.
2. **`check:services` může skrývat reálný bug v recovery dráze** (balíček 0.5) — oprava může být hlubší než session; jde zároveň o nejcennější test pro budoucí BE/FE split. Mitigace: handoff dokument při přetečení, eskalace produkčních zásahů Pavlovi.
3. **E2E vrstva nemá jediný dokončený CI běh v historii** — reálná pass-rate 25 scénářů je neznámá do balíčku 0.8; stabilizace v 0.9 může přetéct. Mitigace: zprovoznit nejdřív 1 OS, zúžitelná suite (minimum 10 scénářů), náhradníci.
4. **Windows joby se iterují jen přes CI** (drahá smyčka, ~10+ min/běh) — balíčky 0.5, 0.6, 0.9. Mitigace: vždy nejdřív artefakty/logy, neiterovat naslepo; zvážit Windows stroj (otevřená otázka).
5. **Riziko zamaskování regresí při opravě testů**: všech 14 unit selhání jsou regex-on-source testy — láká „jen upravit regex". Mitigace: povinná procedura A/B/C s eskalací podezřelých případů.
6. **Externí závislosti CI**: `tauri-pilot-cli 0.7.2` (cizí nástroj přes cargo install), download sidecar binárek z GitHub releases bez checksum pinu. V této fázi jen evidovat; řešení patří do fáze 1.
7. **Opravy `solid/reactivity` lintu jsou zásah do nejporuchovější domény projektu** (composer/connection) — malé diffy, manuální ověření v běžící aplikaci.

## Otevřené otázky

1. **Pro Pavla — Desktop recovery fallback:** pokud se job `Quality / Desktop recovery` nepodaří stabilizovat do 2 sessions (balíček 0.6), smí se dočasně vyjmout z agregátu Gate, aby šla zapnout branch protection se 4 joby? (Doporučení: ano, s follow-up úkolem.)
2. **Pro Pavla — větev `dev`:** je mrtvá od 2026-06-25 a visí na ní 3 CI workflow (`ci.yml`, `ci-tests.yml`, `prerelease.yml`). Fáze 0 ji neřeší (jen `e2e-ui.yml` dostává trigger na main) — smazání/přepojení workflow provede fáze 1, balíček 1.5 krok 8 (smazání větve samotné je admin krok Pavla). Souhlas?
3. **Pro Pavla — pravidlo Codex CLI v `CLAUDE.md` — VYŘEŠENO 2026-07-19:** pravidlo ZŮSTÁVÁ beze změny; vykonavatel bude pravděpodobně pracovat přes Codex CLI (viz ZADANI.md). Plán je psaný agent-agnosticky a funguje v obou nástrojích.
4. **Pro Pavla — práva vykonavatele:** kolega potřebuje push práva na non-main větve `neatechcz/veslo` a `gh` auth; branch protection (balíček 0.7) a její pozdější rozšíření o E2E check (0.9) vyžadují admin zásah Pavla. Zajistit před startem.
5. **Pro Pavla — E2E gate na PR, nebo jen na push:** pokud E2E běh přesáhne ~25 min, má být required na každém PR, nebo jen na push do main (PR hlídá jen Quality)? (Balíček 0.9, krok 7.)
6. **Ověří fáze 0 (balíček 0.1):** stav dosud neprobovaných testovacích suit (`ai-gateway`, `den`, `worker-manager`, `share-service`) — pokud jsou červené, rozšíří se balíček 0.5, nebo vznikne nový balíček.
7. **Ověří fáze 0 (balíček 0.8):** skutečná příčina smrti `e2e-ui.yml` v „Prepare sidecars" — hlavní hypotéza je chybějící Bun setup (ověřeno srovnáním s funkčním `build-desktop.yml`), ale mohou být další vrstvy.
8. **Ověří fáze 0 (balíček 0.10):** zda OpenCode 1.17.13 čte projektový config per session directory — výsledek (V1/V2a/V2b/V3/V4) determinuje tvar engine balíčků fáze 1 (smazání poolu a config-sync hacku vs. config per request vs. pool jako jediná topologie).
9. **Ověří fáze 0 (balíčky 0.2/0.3):** zda některé ze 14 červených testů kryjí reálné regrese (procedura C) — každý takový nález = rozhodnutí Pavla o opravě produkčního kódu.
