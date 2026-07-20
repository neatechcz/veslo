# Fáze 1 — Velký ořez

Datum plánu: 2026-07-19 · Vstupní stav kódu: `main` @ `71215b07` · Navazuje na: `01-faze-0-*.md` (regresní minimum + experimenty) · Následuje: fáze 2 (BE/FE split)

Tento dokument je **self-contained plán pro exekutora bez kontextu předchozích konverzací**. Každý pracovní balíček je zadatelný jako samostatná Claude Code session. Všechny cesty ke kódu jsou relativní ke kořeni monorepa `git/` (tj. klon https://github.com/neatechcz/veslo). Podkladová analýza s file:line důkazy leží v `docs/prestavba/analyza/` — u každého balíčku je uveden relevantní report. Rozhodnutí vlastníka (Pavel) jsou v `docs/prestavba/ZADANI.md` a tento plán je nesmí porušit.

---

## 1. Účel fáze

Veslo má dnes ~182 000 řádků produkčního kódu (app + server) + srovnatelný objem testů, 5 sidecar binárek a ~460 MB binárek v bundlu, z čehož vlastní aplikace tvoří 11 MB (2,4 %). Analýza (`analyza/SYNTEZA.md` §4, `analyza/doplneni.md` Mezera 6) prokázala:

- **~7 000 LOC produkce je ověřeně mrtvých** (0 importérů, potvrzeno knipem + nezávislým druhým průchodem),
- **messaging router (Telegram/Slack) se nepoužívá** — Pavel rozhodl: vyhodit (~10–12 000 LOC + 1 sidecar),
- **dvě systémové duplicity generují trvalou daň**: dual provisioning TS↔Rust (2× 1 243 ř., každá změna se dělá dvakrát) a přímé SQL do interní `opencode.db` enginu ze dvou jazyků (nejkřehčí vazba na upstream — engine mění schéma ~7,6× měsíčně),
- **dvě engine topologie současně** (pool + shared) znamenají dvojí spawn/health/proxy kód,
- **bundle nese −165+ MB čistých duplicit** (2. kopie OpenCode binárky, 3vrstvý chrome-devtools-mcp shim).

Cíl fáze 1: **radikálně zeštíhlit kódovou bázi bez změny chování 4 povinných funkcí** (práce se složkami/workspace, spouštění agentů, skills, MCP). Fáze nemění architekturu kanálů (Tauri IPC model zůstává) — to je úloha fáze 2. Ořez je ale prerekvizitou splitu: každý smazaný řádek je řádek, který se ve fázi 2 nemusí portovat, a díky testům (40–50 % LOC) má každé smazání ~dvojnásobný efekt.

**Feature freeze platí**: žádný balíček této fáze nepřidává funkce. Jediné povolené změny chování jsou ty explicitně popsané v DoD balíčku (např. zánik router UI sekce v settings).

**Cloudová vrstva (Den, ai-gateway) se v této fázi NEŘEŠÍ** — jen desktop/lokální monorepo. Volitelný úklid Den je zmíněn v příloze §7 mimo kritickou cestu.

---

## 2. Prerekvizity (výstupy fáze 0)

Před startem balíčků 1.4 a výše musí být z fáze 0 hotovo:

1. **Regresní minimum**: 14 dříve červených unit testů zelených (`pnpm --filter @neatech/veslo-ui test:unit` → 0 fail), workflow Quality zelený, branch protection na `main` zapnutá. Bez toho se maže bez jakékoli záchranné sítě (dnes fakticky žádná neexistuje — `analyza/doplneni.md` Mezera 5).
2. **E2E gate**: z 80 TOML scénářů vybraných ~10–15 kritických (workspace, běh agenta, skills, MCP) spustitelných lokálně jedním příkazem. Dále „gate z fáze 0“.
3. **Experiment „config díra“** vyhodnocen: umí OpenCode ve shared režimu (1 proces, N složek) číst per-workspace konfiguraci (`.opencode/`, `opencode.json`) per session directory, nebo per-request — místo dnešního last-writer-wins kopírování do jednoho sdíleného config diru (`packages/orchestrator/src/cli.ts:5459`)? Výsledek určuje větev balíčku **1.8** (viz rozhodovací strom tam).
4. **Baseline metriky** zapsané (velikost .app bundlu, LOC produkce/testy, počet sidecarů, čas buildu) — pro měření výnosu fáze.

Balíčky **1.1–1.3** (mazání prokázaně mrtvého kódu) lze zahájit i před dokončením fáze 0 — mažou kód s 0 importéry, riziko je minimální a ověření je typecheck + build. **Při dřívějším startu** ale počítej s tím, že části „standardního ověření“ (§5.2) jsou do dokončení fáze 0 červené z baseline důvodů (14 unit testů do 0.2/0.3, `pnpm check:services` do 0.5): ověřuj proti baseline z balíčku 0.1 — kritérium je „žádné NOVÉ červené testy oproti baseline“, plná zelená se vyžaduje až po dokončení fáze 0.

---

## 3. Milník — co funguje, když je fáze hotová

- Aplikace se buildí a spouští na **macOS i Windows**; všechny 4 povinné funkce (workspace, agenti, skills, MCP) fungují beze změny chování; gate z fáze 0 je zelený.
- Bundle má **3 sidecary místo 5** (`veslo-code`/engine, `veslo-server`, `veslo-orchestrator`) a je o **~230 MB menší** (router −62 MB, duplicitní opencode −104 MB, chrome-mcp shim −61 MB).
- **Messaging router neexistuje** — žádný balíček, routa, Rust manager, binárka ani build krok.
- **Provisioning `.opencode/` má jedinou implementaci** (veslo-server); Rust dvojče `internal_provision.rs` je smazané; pravidlo „každá změna 2×“ zrušeno i v dokumentaci.
- **Rust nedělá žádné přímé SQL do `opencode.db`** (čtení ani zápis) — upgrade OpenCode přestává být ohrožen změnami schématu na Rust straně.
- Repo je o **~25–35 000 LOC produkce** lehčí (+ zhruba dvojnásobek s testy); `pnpm audit:knip` nehlásí žádné mrtvé soubory.
- Pokud experiment fáze 0 dopadl kladně: existuje **jediná engine topologie** (shared) a EnginePool + sandbox subsystém jsou smazané.

---

## 4. Přehled balíčků

| # | Balíček | Stav | Závisí na | Odhad (AI sessions) |
|---|---------|------|-----------|---------------------|
| 1.1 | Mrtvé soubory dle knip + prázdné skořápky | schváleno | — | 1 |
| 1.2 | Mrtvé FE stránky a klientské domény | schváleno | — | 1 |
| 1.3 | Mrtvé serverové/IPC cesty, legacy scheduler, embedded automations plugin | schváleno | — | 1 |
| 1.4 | Odstranění opencode-routeru — runtime kód | **schváleno Pavlem** | — | 1–2 |
| 1.5 | Odstranění opencode-routeru — build & release pipeline | schváleno | 1.4 | 1 |
| 1.6 | Jediný provisioning (server vlastní, Rust volá API) | schváleno | 1.3 | 2 |
| 1.7 | Konec přímého SQL do `opencode.db` z Rustu | schváleno — OO-2 rozhodnuto: varianta (b) | 1.3 | 2 |
| 1.8 | Jediná engine topologie (shared) | **podmíněno experimentem fáze 0** | fáze 0, 1.4 | 2 |
| 1.9 | Build úklid: bundle −165 MB, sidecary 5→3 | schváleno | 1.4, 1.5 | 1–2 |
| 1.10 | Jeden zdroj verze + zjednodušení pinů | schváleno | 1.5 | 1 |
| 1.11 | toy-ui + legacy agentlab aliasy | **SCHVÁLENO 2026-07-19** (bez námitky, dle doporučení) | 1.3 | 1 |
| 1.12 | document-runtime | **SCHVÁLENO 2026-07-19** | — | 1 |
| 1.13 | Soul (server + UI) | **ZRUŠENO 2026-07-19 — Soul zůstává** | — | — |
| 1.14 | Automations (UI + routy + runner) | **ZRUŠENO 2026-07-19 — automations zůstávají** | — | — |

**Součet: jádro (1.1–1.10) = 13–15 sessions; se schválenými ořezy (1.11, 1.12) = 15–17. Balíčky 1.13 a 1.14 jsou zrušeny — Soul i automations zůstávají v produktu (rozhodnutí Pavla 2026-07-19, viz ZADANI.md).**

Doporučené pořadí exekuce = číselné pořadí. Balíčky 1.1–1.3 jsou nezávislé a lze je dělat v libovolném pořadí; **nedělat je však souběžně** — sdílejí soubory (`lib.rs`, `tauri.ts`, `server.ts`) a paralelní sessions by kolidovaly. Schválené ořezy (1.11, 1.12) lze vsunout kdykoli po svých závislostech.

---

## 5. Společná pravidla pro všechny balíčky

### 5.1 Metodika session

- Jeden balíček = jedna AI session (Codex CLI nebo Claude Code — vykonavatel používá svůj nástroj; u 2sessionových balíčků je dělicí bod popsán v Krocích).
- Na začátku session si přečti: tento dokument (sekci svého balíčku), reporty uvedené ve Vstupech, a `docs/prestavba/ZADANI.md`.
- **Mazat znamená smazat** — žádné zakomentování, žádné `#[allow(dead_code)]`, žádné prázdné soubory-pahýly.
- **Testy mrtvého kódu se mažou spolu s ním**, nikdy se neopravují, aby prošly bez smazaného kódu.
- Analýza je ověřená na HEAD `71215b07`. Pokud mezitím přibyly commity, **před smazáním každé položky ověř grepem, že je stále bez importérů** — příkazy jsou v Krocích.
- Po každé editaci build (viz 5.2) — nikdy nehlásit hotovo bez proběhlého buildu.

### 5.2 Standardní ověření (dále jen „standardní ověření“)

Spouští se z kořene `git/`. U balíčků bez Rust změn lze cargo krok vynechat; u balíčků bez FE změn lze vynechat FE testy.

```bash
pnpm install                                     # po změnách závislostí
pnpm typecheck                                   # TS typy napříč workspace
pnpm --filter @neatech/veslo-ui test:unit        # FE unit testy (po fázi 0 zelené)
pnpm --filter veslo-server test                  # server testy
pnpm check:services                              # headless integrační test BE kompozice (nejcennější existující test)
cd packages/desktop/src-tauri && cargo check && cd -   # Rust
pnpm audit:knip                                  # nesmí zbýt/přibýt mrtvé soubory
cd packages/desktop && pnpm exec tauri build --debug --no-bundle && cd -   # ověření, že se desktop zkompiluje celý
```

Funkční smoke (u balíčků, které to vyžadují — uvedeno v Ověření): `pnpm dev` (Tauri okno), přidat testovací složku, vytvořit session, poslat prompt, ověřit skills a MCP taby. Plus gate z fáze 0.

Pozn.: root skript `check:unit` obsahuje řetěz filtrů včetně balíčků, které se v této fázi mažou (`veslo-code-router`, `veslo-document-runtime`) — příslušné balíčky ho upravují, viz Kroky 1.4 a 1.12.

### 5.3 Commit disciplína (dle pravidel repa)

- **Commit po každém dokončeném balíčku** (jeden squashnutý commit na balíček; dílčí WIP commity slučovat).
- Commit message: `faze1: <číslo balíčku> <krátký popis>` — např. `faze1: 1.4 odstraneni opencode-routeru (runtime)`.
- **Push až po manuálním otestování** (Pavel nebo exekutor ručně proklikne desktop app). Nikdy nepushovat automaticky.
- Rollback před pushem = `git reset`; po pushi jedině po explicitním souhlasu Pavla.
- Do commitů nepatří změny v `docs/prestavba/` — stav plánu (odškrtnutí balíčku) aktualizuj samostatným commitem v pracovním adresáři.

---

## 6. Pracovní balíčky

---

### Balíček 1.1 — Mrtvé soubory dle knip + prázdné skořápky

**Cíl:** Smazat 19 souborů s 0 importéry (2 312 LOC) nalezených knipem, 2 prázdné adresáře balíčků a drobné duplicitní/mrtvé zbytky. Nejbezpečnější možný start fáze.

**Vstupy:**
- Report: `docs/prestavba/analyza/doplneni.md` §Mezera 6 (tabulka 6.2 — přesný seznam, dvakrát nezávisle ověřený), `analyza/SYNTEZA.md` §4.1.
- Kód: seznam níže.

**Kroky:**
1. `pnpm audit:knip` — porovnej aktuální výstup s tabulkou níže; maž jen průnik (kdyby mezitím něco ožilo, nech to a poznamenej).
2. Smaž souborů z knip seznamu (LOC orientačně):
   - `packages/app/src/app/components/session/context-panel.tsx` (394)
   - `packages/server/src/reload-watcher.ts` (392)
   - `packages/app/src/app/components/windows-sandbox-repair.tsx` (298)
   - `packages/app/src/app/components/session/inbox-panel.tsx` (295)
   - `packages/app/src/app/components/reload-workspace-toast.tsx` (150)
   - `services/ai-gateway/src/typecheck/repository-contracts.ts` (143) — jediná výjimka z „cloud neřešíme“: je to mrtvý soubor bez runtime dopadu
   - `packages/app/src/app/lib/model-picker-options.ts` (129)
   - `packages/app/src/app/components/session/minimap.tsx` (127)
   - `packages/e2e/helpers/feedback-server.ts` (98)
   - `packages/app/src/app/components/thinking-block.tsx` (76)
   - `packages/app/src/app/components/language-picker-modal.tsx` (64)
   - `packages/app/src/app/lib/safe-run.ts` (62)
   - `packages/app/src/app/context/sync.tsx` (34)
   - `packages/app/src/app/components/card.tsx` (21)
   - `packages/server/src/paths.ts` (20)
   - `packages/app/src/i18n/locales/index.ts` (6)
   - `packages/app/src/app/state/extensions.ts`, `state/sessions.ts`, `state/system.ts` (3)
   - **POZOR — NEmazat** `packages/app/src/app/context/global-sync.tsx`: starší seznamy ho uváděly jako mrtvý, ale je importován v `entry.tsx:3` a `app.tsx:301` (ověřeno, `doplneni.md` 6.1).
3. Smaž prázdné skořápky: `packages/openwork/` (jen `docs/style-guide.md`), `services/den-worker-runtime/` (jen README) — včetně referencí v `pnpm-workspace.yaml`/root configu, pokud existují.
4. Smaž duplicitní root test `packages/desktop/windows-hidden-sidecar-contract.test.mjs` — kanonická verze žije v `packages/desktop/tests/` (liší se jen relativní cestou — `analyza/desktop.md` §Duplicity bod 5); před smazáním ověř, že cílová kopie v `tests/` skutečně existuje. **POZOR — `owned-server-defaults.test.mjs` NEmazat:** v `packages/desktop/tests/` žádná kopie není (ověřeno find-em) — root soubor je jediná živá kopie kontraktního testu na `veslo_server/spawn.rs` (deployment domain, managed AI). Buď ho přesuň do `tests/` (s opravou relativní cesty ke `spawn.rs`), nebo ponech na místě.
5. Smaž testy smazaných souborů (najdi grepem názvy modulů v `packages/*/tests`, `packages/*/src/**/*.test.*`).
6. Před smazáním každého souboru: `grep -rn "<basename-bez-přípony>" packages services --include="*.ts" --include="*.tsx" | grep -v test` — musí vracet jen soubor sám.

**Ověření:** standardní ověření (bez cargo — Rust se nemění, ale `tauri build --debug` stejně spusť kvůli FE bundlu). `pnpm audit:knip` už nesmí hlásit žádný ze smazaných souborů.

**Hotovo znamená:** 19 knip souborů + 2 skořápky + 1 duplicitní test neexistují (`owned-server-defaults.test.mjs` zachován, případně přesunut do `tests/`); typecheck, unit testy, build a knip čisté; commit `faze1: 1.1 …`.

**Rizika a rollback:** Minimální — vše má prokázaně 0 importérů. Pojistka OO-5 **vyřešena 2026-07-19**: Pavel potvrdil smazání obou souborů (`windows-sandbox-repair.tsx` patřil k odloženému sandboxu; `inbox-panel.tsx` „nedává smysl" ani Pavlovi). Případné obnovení = `git revert` jednoho commitu. Rollback: reset commitu.

**Odhad:** 1 session.

---

### Balíček 1.2 — Mrtvé FE stránky a klientské domény

**Cíl:** Smazat mrtvé stránky UI (identities, proto) a mrtvé klientské domény — ~3 700 LOC produkce + testy + 5 npm závislostí.

**Vstupy:**
- Reporty: `doplneni.md` Mezera 6 (6.1, 6.3), `analyza/router.md` §Duplicity, `SYNTEZA.md` §4.1.
- Kód: `packages/app/src/app/pages/identities.tsx` (1 494), `pages/proto-v1-ux.tsx` (676), `pages/proto-workspaces.tsx` (451), `lib/veslo-server-domains/messaging-identities.ts` (315), `lib/veslo-server/client.ts` (identity metody ř. 528–569), `components/live-markdown-editor.tsx`, `context/app-route-sync.ts` (ř. 82–83, 193–194), `controllers/app-startup-controller.ts` (ř. 61–75).

**Kroky:**
1. Smaž `pages/identities.tsx` + jeho contract test `packages/app/tests/pages/identities-contract.test.ts` (test čte soubor jako surový text — jediná reference).
2. Smaž `lib/veslo-server-domains/messaging-identities.ts` a z `lib/veslo-server/client.ts` odstraň exportované identity metody (`telegramIdentities`, `upsertTelegramIdentity`, … ř. 528–569) + zapojení domény (client.ts:395 dle `router.md`). Smaž jejich testy.
3. Smaž `pages/proto-v1-ux.tsx` + `pages/proto-workspaces.tsx`. Odstraň view `proto` z routingu: `app.tsx` Switch/Match větev (ř. ~5150–5182), `context/app-route-sync.ts:82–83`, redirect logiku `controllers/app-startup-controller.ts:61–75` (reasons `proto-tauri`/`proto-web`), typ view v `types.ts`. V Tauri byly proto stránky aktivně redirectované pryč, ve webu dosažitelné jen ručním URL — žádný UI prvek na ně nenaviguje.
4. Smaž `components/live-markdown-editor.tsx`; ověř grepem, že nemá importéry (`grep -rn "live-markdown-editor" packages/app/src`); poté odstraň z `packages/app/package.json` závislosti `@codemirror/commands`, `@codemirror/lang-markdown`, `@codemirror/language`, `@codemirror/state`, `@codemirror/view` (ř. 51–55) — předtím ověř, že je neimportuje nic jiného: `grep -rn "@codemirror" packages/app/src --include="*.ts*" | grep -v live-markdown-editor` → 0.
5. Ukliď i18n klíče a mrtvé odkazy (grep na `identities`, `proto-v1`, `protoWorkspaces` v `packages/app/src`).

**Ověření:** standardní ověření + `pnpm dev` smoke: aplikace startuje, dashboard, session view a settings fungují; ruční URL `/proto-v1-ux` ve web režimu vrací 404/redirect (nikoli pád).

**Hotovo znamená:** 0 výskytů `identities.tsx`, `proto-v1-ux`, `proto-workspaces`, `messaging-identities`, `live-markdown-editor`, `@codemirror` v `packages/app` (mimo lockfile); build + testy zelené.

**Rizika a rollback:** `client.ts` je sdílený — při odstraňování metod nechat ostatní domény netknuté (editovat chirurgicky, ne přepisem souboru). Proto stránky mohly sloužit jako designový prototyp — jsou v git historii, kdykoli dohledatelné. Rollback: reset commitu.

**Odhad:** 1 session.

---

### Balíček 1.3 — Mrtvé serverové/IPC cesty, legacy scheduler, embedded automations plugin

**Cíl:** Smazat mrtvý kód na serveru a v IPC vrstvě: legacy scheduler (3. generace zpět), hard-disabled embedded automations plugin (2× ~395 ř. nikdy nezapisovaného zdrojáku), mrtvé IPC příkazy a serverové routy. ~2 500+ LOC produkce + testy.

**Vstupy:**
- Reporty: `analyza/server.md` §6 (Duplicity a mrtvý kód), `doplneni.md` 6.1 (enable flagy s přesnými řádky), `doplneni.md` Mezera 1 (mrtvé IPC), `analyza/desktop.md` §Duplicity.
- Kód: `packages/server/src/scheduler.ts`, `routes/scheduler.ts`, `internal-system.ts` (ř. 515–913 + mrtvé exporty), `packages/desktop/src-tauri/src/commands/scheduler.rs`, `workspace/internal_provision.rs` (ř. 198–~604), `packages/app/src/app/lib/tauri.ts`.

**Kroky:**
1. **Legacy scheduler** (správa staré generace `opencode-job-*` launchd/systemd jednotek — tři generace plánovačů, tohle je nejstarší):
   - server: `src/scheduler.ts` + `src/routes/scheduler.ts` (64) + registrace v `server.ts` `createRoutes`;
   - desktop: `src-tauri/src/commands/scheduler.rs` + registrace v `lib.rs`;
   - FE: scheduler wrappery v `lib/tauri.ts` + jejich volající (ověř grepem `scheduler` — pozor, nezaměnit s balíčkem automations/`scheduled.tsx`, ten se řeší v 1.14).
2. **Embedded automations plugin** (hard-disabled na obou stranách, nikdy se nezapíše — místo toho běží aktivní karanténa):
   - TS: v `src/internal-system.ts` smaž `automationsPluginEnabled()` (ř. 515–517), `activeAutomationsPluginSource()` + embedded zdroják (ř. 519–913); **karanténní logiku `disableAutomationsPlugin` PONECH** (uklízí instalace z minulých verzí);
   - Rust: v `workspace/internal_provision.rs` smaž `automations_plugin_enabled_from_env()` (ř. 198–203) + embedded zdroják (ř. 209–~604) + test ř. 1036–1045; `disable_automations_plugin` ponech;
   - oprav nekonzistenci: TS manifest deklaruje `plugins: [DELEGATE_PLUGIN_FILE]` (internal-system.ts:1190), ale delegate plugin se jinde jen maže (`removeManagedLegacyDelegatePlugin`, ř. 465–475) — odstraň deklaraci artefaktu, který se nikdy nevytváří.
3. **Mrtvé exporty v `internal-system.ts`**: `internalAgentDocument`, `internalSkillCreatorAgentDocument`, `managedVesloRoutingBlock`, `provisionCentralPacks` (+ Rust `provision_central_packs`, internal_provision.rs:667) — před smazáním každý ověř grepem bez konzumenta.
4. **Mrtvé serverové drobnosti**: `src/skill-adoption.ts` (143), `src/skill-package-cache.ts` (124), routa `/whoami` (bez volajícího v app i desktopu).
5. **Mrtvé IPC**: v `lib/tauri.ts` smaž wrapper `orchestratorStartDetached` (ř. ~814, žádný volající v UI) a v Rustu příkaz `orchestrator_start_detached` (`commands/orchestrator.rs:808` + registrace v lib.rs). Příkaz `opencodeRouter_config_set` neřeš — zanikne celý v 1.4.
6. Smaž testy všech smazaných položek.

**Ověření:** standardní ověření včetně cargo + smoke `pnpm dev` (vytvoření workspace → provisioning proběhne — embedded plugin se stejně nikdy nezapisoval, chování se nesmí změnit). Grep DoD: `grep -rn "automationsPluginEnabled\|activeAutomationsPluginSource\|provisionCentralPacks\|orchestrator_start_detached" packages | grep -v target` → 0.

**Hotovo znamená:** scheduler (legacy), embedded plugin, mrtvé exporty a mrtvé IPC neexistují; oba provisioning soubory se zmenšily o ~400 ř. (příprava na 1.6); vše zelené.

**Rizika a rollback:** `internal-system.ts` a `internal_provision.rs` se zde edituje poprvé — **v tomto balíčku ještě platí pravidlo dual provisioningu**: obě strany se musí změnit zrcadlově (naposledy — 1.6 pravidlo ruší). Riziko záměny legacy scheduleru s živými automations — legacy poznáš podle `opencode-job-*`/launchctl/systemctl. Rollback: reset commitu.

**Odhad:** 1 session.

---

### Balíček 1.4 — Odstranění opencode-routeru: runtime kód

**Cíl:** Kompletně odstranit messaging most Telegram/Slack z běžícího systému: balíček, serverové routy a proxy, Rust manager + IPC, orchestrator spawn, FE zbytky. Pavel rozhodl: „Nepoužívá se vůbec → vyhodit.“ (~10 000 LOC + testy.)

**Vstupy:**
- Reporty: `analyza/router.md` (celý — zejména §Komunikační vazby, kde je mapa všech integračních bodů), `SYNTEZA.md` §4.2.
- Kód: `packages/opencode-router/` (celý), `packages/server/src/routes/opencode-router.ts` (1 567) + proxy v `server.ts` (ř. 558–863 + mount `/opencode-router`), `packages/desktop/src-tauri/src/commands/opencode_router.rs` (576) + `src/opencode_router/` (~157), `lib.rs` (registrace + `OpenCodeRouterManager`), `packages/orchestrator/src/cli.ts` (spawn ř. 3157–3220, default flag ř. 6266, embedded tool sources ř. 1756–2026, `resolveOpenCodeRouterBin`), `packages/app/src/app/pages/settings.tsx` (ř. 562–612), `lib/tauri.ts` (opencodeRouter_* wrappery).

**Kroky (session 1 — kód):**
1. Smaž celý `packages/opencode-router/` (src, test, scripts — 7 746 + ~1 800 ř.).
2. Server: smaž `src/routes/opencode-router.ts` + registraci v `createRoutes`; v `server.ts` smaž generickou proxy `/opencode-router/*` a `/w/:id/opencode-router/*` (ř. 558–863) a všechny `persistOpenCodeRouter*` reference; ukliď `types.ts`; smaž testy `server.opencode-router-routes.test.ts` a router části dalších testů.
3. Desktop Rust: smaž `commands/opencode_router.rs`, adresář `src/opencode_router/`, v `lib.rs` odregistruj příkazy `opencodeRouter_*` a stav `OpenCodeRouterManager`; ukliď zmínky v `commands/orchestrator.rs` a `commands/engine.rs` (grep `opencode_router\|OpenCodeRouter`).
4. Orchestrátor: v `cli.ts` smaž spawn routeru (ř. 3157–3220), health/port plumbing (`OPENCODE_ROUTER_HEALTH_PORT`), embedded router tool zdrojáky (ř. 1756–2026, ~270 ř. — pluginy pro posílání Telegram/Slack zpráv), `resolveOpenCodeRouterBin`, default `readBool(..., "veslo-code-router", true)` (ř. 6266). **CLI flag `--no-veslo-code-router` ponech jako přijímaný no-op s deprecation poznámkou** — posílají ho cloud provisionery (`services/den/src/workers/provisioner.ts:278`, `services/worker-manager/src/docker.ts:126`), které v této fázi neměníme; neznámý flag by shodil start.
5. FE: v `pages/settings.tsx` smaž sekci router status/restart/stop (ř. 562–612); v `lib/tauri.ts` smaž `opencodeRouter_*` wrappery; ukliď i18n klíče (grep `router` v locales — pozor na kolizi s pojmem „route“).
6. Root `package.json`: z řetězu `check:unit` odstraň `pnpm --filter veslo-code-router test:unit`; ukliď `knip.jsonc`, pnpm lockfile (`pnpm install`).
7. Data na disku (`~/.veslo/opencode-router/`) neuklízet — čistý start je OK, migrace se neřeší (ZADANÍ).

**Ověření:** standardní ověření + smoke: `pnpm dev`, ověř že orchestrátor startuje bez routeru (log neobsahuje `veslo-code-router`), settings stránka bez router sekce, session flow funguje. Curl: `curl -s http://127.0.0.1:<port>/opencode-router/health` → 404. Gate z fáze 0 zelený.

**Hotovo znamená:** `grep -rn "opencode-router\|opencodeRouter\|veslo-code-router" packages --include="*.ts" --include="*.tsx" --include="*.rs" | grep -v target | grep -v node_modules | grep -v "no-veslo-code-router"` → 0 výskytů (build skripty řeší 1.5). **Jediný povolený výskyt** je deprecated no-op flag `--no-veslo-code-router` v `packages/orchestrator/src/cli.ts` (viz krok 4 — bez výjimky v grepu by DoD a krok 4 nešly splnit současně); aplikace plně funkční bez routeru.

**Rizika a rollback:** Vazby jsou rozesety v ~50 souborech mimo balíček (`router.md` §Rizika) — proto DoD stojí na grep sweep, ne na paměti. Riziko rozbití cloud deployů přes odstraněný CLI flag — mitigace v kroku 4. Orchestrátorový `cli.ts` (6 934 ř.) je god file — editace úzce cílit, po každé spustit `pnpm --filter veslo-orchestrator test:router`… pozor: tento test skript může sám patřit routeru — pokud testuje messaging router, smaž ho a vyřaď z `check:unit`; pokud testuje daemon routing (HTTP), ponech. Rozliš podle obsahu testů. Rollback: reset commitu (jeden commit na session).

**Odhad:** 1–2 sessions (dělicí bod: po kroku 3 — Rust a server hotové a zelené, orchestrátor + FE + root config druhá session).

---

### Balíček 1.5 — Odstranění opencode-routeru: build & release pipeline

**Cíl:** Odstranit router z build/release pipeline a dokumentace — 5. sidecar binárka zaniká (5→4), bundle −62 MB.

**Vstupy:**
- Reporty: `analyza/build-pipeline.md` (§prepare-sidecar, §Release orchestrace, §Duplicity), `analyza/router.md` §Rizika.
- Kód: `packages/desktop/scripts/prepare-sidecar.mjs`, `src-tauri/tauri.conf.json` + `tauri.windows.conf.json` (externalBin), `src-tauri/build.rs`, `scripts/release/review.mjs`, `.github/workflows/*.yml`, `packages/desktop/scripts/cleanup-dev-processes.mjs`, `sidecars/opencode-router` (101B stub).

**Kroky:**
1. `prepare-sidecar.mjs`: smaž build sekci `veslo-code-router` (bun compile + verzová cache) a jeho zápis do `versions.json` manifestu.
2. Tauri conf: odstraň `sidecars/veslo-code-router` z `externalBin` ve **všech** variantách (`tauri.conf.json`, `tauri.windows.conf.json` + zkontroluj zbylých 7 variant grepem).
3. `build.rs`: smaž `ensure_*` větve pro router (stub/copy logika).
4. Smaž mrtvý stub `src-tauri/sidecars/opencode-router` (pozůstatek přejmenování).
5. `scripts/release/`: v `review.mjs` odstraň router fragmenty/kontroly; v release workflow (`release-macos-aarch64.yml`, `prerelease.yml`, `build-staging-app.yml`, `build-desktop.yml`, `build-windows-msi.yml`) odstraň router kroky včetně npm publish jobu pro `veslo-code-router` (grep `veslo-code-router\|opencode-router` v `.github/` a `scripts/`).
6. Dev skripty: `cleanup-dev-processes.mjs` + `.test.mjs` — odstraň router proces z kill listu; `tauri-dev.mjs` zmínky.
7. Dokumentace v repu: aktualizuj `CLAUDE.md` (tabulka balíčků), `AGENTS.md`, `ARCHITECTURE.md`, `INFRASTRUCTURE.md`, `RELEASE.md` — router už neexistuje. (Historické dokumenty v `docs/plans` nech být.)
8. **Úklid mrtvé větve `dev` a jejích workflow** (slib z fáze 0, otevřená otázka 2 — provést po souhlasu Pavla): smaž workflow `ci.yml` a `ci-tests.yml` triggerované jen na mrtvé větvi `dev` (poslední aktivita 2026-06-25); `prerelease.yml` se v tomto balíčku edituje kvůli router krokům — rozhodni s Pavlem, zda ho smazat, nebo přepojit na `main`. Smazání větve `dev` samotné je admin krok Pavla (mimo repo commit).
9. npm balíček `veslo-code-router` na registru: navrhni Pavlovi `npm deprecate` (vyžaduje jeho práva) — do plánu jen poznámka, neblokuje.

**Ověření:** standardní ověření + **plný release-like build**: `cd packages/desktop && pnpm exec tauri build --bundles app` (bez signing klíče skončí chybou podpisu — to je OK, .app se vygeneruje). Ověř obsah: `ls "src-tauri/target/release/bundle/macos/Veslo by Neatech.app/Contents/MacOS/"` — nesmí obsahovat `veslo-code-router`. `node scripts/release/review.mjs --strict` projde (nebo aspoň nefailuje na router fragmentech). Šlo by ověřit i `pnpm --filter @neatech/veslo run prepare:sidecar` samostatně (root skript `prepare:sidecar` neexistuje).

**Hotovo znamená:** repo-wide grep `veslo-code-router|opencode-router` (mimo `docs/plans`, git historii a lockfile artefakty) → 0; .app bundle bez router binárky; review.mjs zelený.

**Rizika a rollback:** `review.mjs` je regexový lint workflow — po úpravách YAML může failovat na nesouvisejících kontrolách; opravuj jen router fragmenty, nerozšiřuj zásah. Release workflow je netestovatelný jinak než ostrým releasem — proto po fázi 1 udělat jeden staging build (`build-staging-app.yml` přes workflow_dispatch) před ostrým releasem. Rollback: reset commitu.

**Odhad:** 1 session.

---

### Balíček 1.6 — Jediný provisioning: server vlastní, Rust volá API

**Cíl:** Zrušit ručně zrcadlené dvojče `internal-system.ts` (TS) ↔ `internal_provision.rs` (Rust) — po balíčku 1.3 už ~850 ř. na každé straně. Cílový stav: **veslo-server je jediný vlastník provisioningu `.opencode/`**; Rust workspace vrstva volá server HTTP API. Ruší se trvalá daň „každá změna 2×“ (pravidlo zapsané dnes i v kořenovém CLAUDE.md repa).

**Vstupy:**
- Reporty: `analyza/desktop.md` §Duplicity bod 1–2 + §Náměty 1, `analyza/server.md` §8 (řádek „Zrušit dual provisioning“), `doplneni.md` Mezera 3 (důkaz: server provisioning běží — `POST /workspaces/local` i aktivace píší `.opencode/`, ověřeno curl-em), `SYNTEZA.md` §6 (průnik no-regret kroků).
- Kód: `packages/server/src/internal-system.ts`, `packages/desktop/src-tauri/src/workspace/internal_provision.rs`, `workspace/files.rs` (1 177 — seeding, částečný překryv), `workspace/server_client.rs` (808 — existující HTTP klient Rust→server), `commands/workspace.rs` (bootstrap/create flow).

**Kroky (session 1 — analýza + přepojení):**
1. **Diff obou implementací**: projdi `internal_provision.rs` a `internal-system.ts` funkci po funkci; sestav tabulku „co dělá Rust navíc / co dělá TS navíc“. Z analýzy víme: TS už je bohatší (workspace instructions, interní agent dokumenty) — drift nastal. Cokoli, co má jen Rust, doplň do TS verze (má to být malé; pokud objevíš větší unikátní Rust logiku, zapiš a rozhodni s Pavlem).
2. **Najdi všechna volání Rust provisioningu**: `grep -rn "internal_provision" packages/desktop/src-tauri/src --include="*.rs"` — typicky bootstrap/create/aktivace workspace v `commands/workspace.rs` a `workspace/files.rs`.
3. **Přepoj Rust na server API**: místo lokálního provisioningu volej přes `workspace/server_client.rs` existující endpoint (registrace `POST /workspaces/local` a aktivace už provisioning spouštějí — ověřeno; pokud chybí samostatný endpoint „reprovision workspace“, přidej na server tenkou routu, která zavolá existující `internal-system` funkce — to není nová featura, jen expozice existující logiky).
4. **Ošetři pořadí startu**: Rust spouští veslo-server a čeká na ready handshake (`VESLO_SERVER_READY`, `src/cli.ts:35–77` serveru) — provisioning volej až po ready. Pro cold-start hrany (workspace vytvořený, když server ještě neběží) se opři o lazy provisioning při aktivaci (už existuje).

**Kroky (session 2 — smazání dvojčete):**
5. Smaž `workspace/internal_provision.rs` (celý) + jeho testy + `mod` deklarace.
6. V `workspace/files.rs` odstraň části duplikující serverový provisioning (legacy cleanup bloky duplikované s internal-system — `desktop.md` §Duplicity 4); seeding, který server nedělá (native složkové operace při vzniku workspace), buď ponech (a zapiš jako known-remainder), nebo přesuň do TS — rozhodni podle diff tabulky z kroku 1. Cíl fáze: **nula zrcadlené logiky**; nativní minimum smí zůstat.
7. **Aktualizuj dokumentaci pravidla**: z kořenového `CLAUDE.md`/`AGENTS.md` repa odstraň pravidlo „Dual provisioning — TypeScript + Rust… při každé změně upravit oba soubory“ a nahraď větou „provisioning vlastní veslo-server; Rust volá API“. (Stejné pravidlo je i v pracovním `CLAUDE.md` mimo repo — připomeň hlavní session, ať ho aktualizuje.)

**Ověření:** standardní ověření včetně cargo + funkční test provisioningu:
```bash
# po spuštění `pnpm dev`: přidej NOVOU testovací složku přes UI (storage/veslo-test-X)
ls storage/veslo-test-X/.opencode/   # musí vzniknout: agents/veslo.md, opencode.json, …
# srovnej obsah s workspace provisionovaným před změnou (git stash / záložní kopie) — musí být ekvivalentní
```
Plus `pnpm check:services` (headless kompozice používá TS provisioning — musí projít beze změny) a gate z fáze 0.

**Hotovo znamená:** `internal_provision.rs` neexistuje; nový workspace dostane identický `.opencode/` obsah jako před změnou (diff obsahu adresáře); pravidlo dual provisioningu odstraněno z dokumentace repa; cargo + testy zelené.

**Rizika a rollback:** (a) Timing — Rust provisioning dnes může běžet dřív, než server naběhne; mitigace krok 4, testovat cold start (smazat app data dir a spustit čistý first-run). (b) Windows: cesty a WSL — provisioning přes server běží v Bun procesu na hostiteli, chování musí ověřit Windows smoke build. (c) Skrytí konzumenti markerů (`VESLO_AGENT_INSTRUCTIONS_*`, `VESLO_INTERNAL_ROUTING_*`) — obsah generuje nadále táž TS logika, markery se nemění. Rollback: revert obou commitů; do té doby Rust dvojče žije v git historii.

**Odhad:** 2 sessions.

---

### Balíček 1.7 — Konec přímého SQL do `opencode.db` z Rustu

**Cíl:** Odstranit nejkřehčí vazbu na engine: přímé čtení i **zápis** (včetně regex přepisů JSON blobů zpráv!) interní SQLite databáze OpenCode z Rustu. Upstream mění schéma ~7,6 migrace/měsíc a ~40 % migrací se týká právě čtených tabulek `session`/`message` (`doplneni.md` Mezera 2) — každý upgrade enginu dnes riskuje tiché rozbití.

**Vstupy:**
- Reporty: `analyza/desktop.md` §Vazba na OpenCode bod 3 + §Náměty 5, `doplneni.md` Mezera 2 (kvantifikace rizika) a Mezera 1 (kategorie A: HTTP ekvivalenty existují), `analyza/opencode-vazba.md`.
- Kód: `packages/desktop/src-tauri/src/commands/session_reader.rs` (402 — SELECT nad `session`/`message`/`part`, příkazy `opencode_db_read_sessions`/`opencode_db_read_transcript`), `commands/misc.rs` — POZOR na orientaci: SELECTy na ř. 899–917 leží uvnitř `#[cfg(test)] mod tests` (modul ř. 756–924; smažou se spolu s mazanou funkcí, nejsou to produkční čtecí cesty); produkční kód je `opencode_db_migrate` (fn ř. 927 — subprocess `opencode` CLI, NEmazat, viz krok 4) a `opencode_db_update_session_directory` (fn ř. 1032 — SQL UPDATE `session.directory` + regex přepis JSON blobů `message.data`/`part.data`), `commands/workspace.rs` (ř. 170, 197 — `try_cleanup_sessions_via_sqlite` fallback), FE: `lib/db-reader.ts` (123), `lib/tauri.ts` (wrappery), `controllers/session-folder-move-controller.ts` (ř. 203 — jediný živý volající zápisové cesty).

**Kroky:**
1. **Čtecí cesta (mrtvá v produkci)**: `db-reader.ts` importují jen testy (ověřeno na HEAD). Smaž: `lib/db-reader.ts` + jeho testy (`tests/lib/db-reader*.test.ts`), FE wrappery `opencode_db_read_*` v `tauri.ts`, Rust `commands/session_reader.rs` celý + registraci v `lib.rs`. Sidebar/transcript čtení už jde přes serverové conversations API (kategorie A v `ipc-http-parita.csv`).
2. **Cleanup fallback**: v `commands/workspace.rs` smaž `try_cleanup_sessions_via_sqlite` (ř. 170) a jeho volání (ř. 197); ponech pouze preferovanou HTTP cestu mazání sessions přes OpenCode API (workspace.rs:99).
3. **Zápisová cesta — jediné živé místo**: `opencode_db_update_session_directory` volá `session-folder-move-controller.ts` (přesun/přejmenování složky workspace se zachováním session historie — přepisuje cesty v DB enginu regexem). **ROZHODNUTO 2026-07-19 (OO-2): varianta (b) — historie chatů se při přesunu složky PŘENÁŠÍ, implementace se stěhuje na server.** Postup: přesuň logiku do veslo-serveru (TS, poblíž `conversation-*` vrstvy) jako dočasně jediný SQL writer s explicitní poznámkou v kódu „zrušit ve fázi 2 náhradou za engine API / binding store“; přidej serverový endpoint (např. `POST /workspace/:id/sessions/relocate`), `session-folder-move-controller.ts` přepni z IPC na tento endpoint a smaž `opencode_db_update_session_directory` z misc.rs + IPC wrapper. Duplicitu jazyků to ruší — přímé SQL zůstane na jednom místě v jednom jazyce (server, kde už SQL čtení `opencode.db` existuje) a Rust je čistý.
4. **Co se NEmaže**: `opencode_db_migrate` a `opencode_mcp_auth` v misc.rs jsou subprocess volání `opencode` CLI (ne přímé SQL) — ponech.
5. Pokud po krocích 1–3 v `Cargo.toml` nezbývá žádný uživatel `rusqlite`, odstraň závislost (ověř: `grep -rn "rusqlite" packages/desktop/src-tauri/src`).

**Ověření:** standardní ověření včetně cargo + funkční smoke: sidebar se sessions se načítá, transkript se čte, mazání workspace uklidí sessions (přes HTTP). Smoke přesunu složky: přesuň workspace do jiné cesty a ověř, že historie chatů zůstává viditelná a session pokračuje v nové složce. Grep DoD: `grep -rn "opencode.db\|rusqlite" packages/desktop/src-tauri/src | grep -v target` → 0 (resp. bez SQL přístupů).

**Hotovo znamená:** v Rustu neexistuje žádný SELECT/UPDATE na `opencode.db`; FE nečte engine DB přes IPC; přesun složky zachovává historii přes serverový endpoint (pokrytý testem); upgrade OpenCode už na Rust straně nezávisí na schématu DB.

**Rizika a rollback:** (a) Čtecí IPC cesta mohla být výkonnostní zkratka pro sidebar (SYNTEZA otevřená otázka 6) — po smazání sleduj rychlost načítání sidebaru s mnoha sessions; server conversations API + prefetch cache existují. (b) Serverový přepis cest je vědomě dočasný SQL writer — v kódu označit TODO pro fázi 2 (náhrada engine API / binding store), jinak zůstane trvale. Rollback: reset commitu.

**Odhad:** 2 sessions (varianta b).

---

### Balíček 1.8 — Jediná engine topologie (shared) — PODMÍNĚNO fází 0

**Cíl:** Zrušit souběh dvou engine topologií (`pooled-per-workspace` × `shared-unsandboxed`), které dnes zdvojují spawn/health/proxy kód a prorůstají podmínkami celý orchestrátor. Cílový stav: **jeden sdílený OpenCode proces pro všechny workspace jako jediný režim** (dnes už default na macOS + Windows), smazání EnginePool (1 058 ř.) a sandbox plumbingu.

**Vstupy:**
- Reporty: `analyza/multi-workspace.md` (celý — zejména §1 topologie, §3 jizva 4 „config díra“, §5 varianta A), `analyza/orchestrator.md` (hotspot 2, náměty 3), `SYNTEZA.md` §7 otázky 1–3.
- Kód: `packages/orchestrator/src/engine-pool.ts` (1 058), `shared-opencode-engine.ts` (289), `engine-topology.ts`, `opencode-proxy-target.ts`, `cli.ts` (topologické větve ř. 4686, 5059, 5108, 5304, 5417, 5576, 5643; duplikované spawn/health closury ř. 4331–4457 vs. 4482–4622; config sync ř. 5459–5484), `src/sandbox/*` (~900), `engine-paths.ts` (WSL přepisy), `router-proxy.ts` (WSL přepisy těl/SSE), `packages/desktop/src-tauri/src/runtime_preferences.rs` (ř. 33–35, 156–157), `wsl_sandbox.rs`.

**Rozhodovací strom (podle výsledku experimentu „config díra“ z fáze 0):**

**Větev A — experiment potvrdil, že per-workspace config lze ve shared režimu doručit korektně** (OpenCode čte `.opencode/` config per session directory, NEBO config lze předat per request):

1. Zafixuj mechanismus per-workspace configu podle výsledku experimentu (např. zrušit kopírování do sdíleného config diru a spolehnout se na per-directory čtení; nebo sync přesunout z hot path na aktivaci + fs watcher — námět `orchestrator.md` 6). Tím se zavírá dnešní korektnostní díra last-writer-wins (`multi-workspace.md` jizva 4).
2. Smaž `engine-pool.ts` celý + testy; smaž `shared`/`pooled` větvení: `engine-topology.ts` zjednoduš na konstantu, `opencode-proxy-target.ts` (engineKind `"pooled" | "shared"`) zredukuj, v `cli.ts` odstraň všechny topologické podmínky a duplikovanou spawn/health closuru poolu.
3. Smaž opt-in env mechaniku (`VESLO_SHARED_OPENCODE_ENGINE`, `VESLO_DISABLE_SANDBOX` jako podmínku topologie) — shared je jediný režim, **i na Linuxu** (dnes tam default pool; sjednocení otestuj aspoň buildem, Linux není povinná platforma).
4. Smaž sandbox subsystém: `src/sandbox/*`, `childKind`/`sandboxMode` plumbing, WSL2 discovery + PowerShell provisioning, WSL path-rewriting v `engine-paths.ts`/`router-proxy.ts` (přepisy `directory` v query/JSON/SSE), desktop `wsl_sandbox.rs` + navazující IPC. Pavel: sandbox se neřeší; na desktopu je fakticky opuštěný (shared = unsandboxed default). **Pozor:** serverový transcript mirror („host je durable source of truth kvůli sandbox/WSL“) se v této fázi NEruší — to je zásah do konverzační pipeline, patří do fáze 2.
5. Desktop: zjednoduš `runtime_preferences.rs` (odstranění platformních defaultů topologie) a poolové větve stavů v `commands/engine.rs`.
6. Aktualizuj `docs/dev/opencode-workspace-runtime-architecture.md` (canonical doc topologie).

**Větev B — experiment díru potvrdil a per-request/per-directory config nefunguje:**

1. **Pool se ve fázi 1 NEmaže** — sjednocení topologie se odkládá do fáze 2, kde ho převezme **balíček 2.1 ve variantě „Větev B z fáze 1“** (viz `03-faze-2-jeden-backend.md` §2 — embedded runtime pak do serveru přebírá EnginePool jako jedinou topologii; per-workspace config je v poolu přirozený). Zapiš rozhodnutí + důkazy do `docs/prestavba/plan/rozhodnuti-topologie.md`, ať má fáze 2 jednoznačný vstup.
2. Proveď jen bezpečnou podmnožinu: smaž sandbox subsystém (krok 4 větve A — nezávislý na topologii, sandbox je rozhodnut), a duplikované closury/trasovací triplicitu, kde to nejde proti žádné topologii.
3. NEPŘEPÍNAT defaulty platforem (macOS/Windows shared zůstává, Linux pool zůstává).

**Ověření:** standardní ověření + **vícesložkový smoke** (kritická funkce dle Pavla): `pnpm dev`, přidej 2–3 workspace (storage/veslo-test-A/B/C), v každém spusť session s promptem souběžně, ověř: odpovědi se nemíchají mezi workspace, každý workspace vidí své skills/MCP (test per-workspace configu!), přepínání workspace nerestartuje engine. Gate z fáze 0 + `pnpm check:services`. Windows: staging build + tentýž smoke.

**Hotovo znamená (větev A):** jediná topologie v kódu (`grep -rn "pooled" packages/orchestrator/src` → 0), sandbox/* neexistuje, vícesložkový smoke prochází vč. odlišných per-workspace configů. **(větev B):** sandbox smazán, rozhodnutí zdokumentováno, obě topologie fungují jako dřív.

**Rizika a rollback:** Největší balíček fáze. (a) Restart sdíleného enginu = výpadek všech workspace najednou — chování už dnes na macOS/Win, nezhoršuje se. (b) SYNTEZA otázka 2: rozpor v dokumentaci o defaultní topologii na macOS — před začátkem ověř na HEAD skutečný default (`runtime_preferences.rs:33`). (c) WSL path-rewriting může mít skryté konzumenty mimo sandbox (Windows cesty) — mazat po grep sweep `wsl\|/mnt/`. (d) Po smazání poolu neexistuje cesta zpět bez revertu — proto podmínka experimentem. Rollback: reset commitů; větev B je sama o sobě fallback plán.

**Odhad:** 2 sessions (větev A: 1. orchestrátor, 2. desktop+doc+smoke; větev B: 1 session obvykle stačí).

---

### Balíček 1.9 — Build úklid: bundle −165 MB, sidecary na 3

**Cíl:** Odstranit binární duplicity z bundlu: druhou kopii OpenCode enginu (104 MB) a 3vrstvý chrome-devtools-mcp shim (61 MB + Node runtime). Po 1.5 (router pryč) klesá počet sidecarů na **3**: engine, veslo-server, veslo-orchestrator.

**Vstupy:**
- Reporty: `analyza/build-pipeline.md` (§Co je v zabaleném .app, §Náměty 2–3, 8; §Duplicity — mrtvý macOS veslo-node, Vercel větev), `SYNTEZA.md` §4.2 poslední řádek.
- Kód: `packages/desktop/scripts/prepare-sidecar.mjs` (symlink ř. 1050–1074, chrome-mcp ř. 465–485, veslo-node ř. 725–823), `src-tauri/tauri.conf.json` (externalBin ř. 67–76), `tauri.windows.conf.json`, `workspace/files.rs` (seeding chrome-devtools MCP konfigurace do `opencode.json`), `scripts/build.mjs` (ř. 4–6 mrtvá Vercel větev).

**Kroky:**
1. **Duplicitní OpenCode kopie**: symlink `opencode` → `veslo-code` se při Tauri bundlování materializuje na plnou kopii (104 MB ×2). Engine se sám verifikuje přes `which opencode`, proto symlink vznikl. Řešení (doporučené): **bundlovat jedinou binárku pod jménem `opencode`** a přepnout všechny spawn reference z `veslo-code` na ni (grep `veslo-code` v `packages/desktop/src-tauri/src`, `packages/orchestrator/src/cli.ts` — `resolveOpencodeBin`, `prepare-sidecar.mjs`, tauri confy, `versions.json` generace). Alternativa, pokud narazíš na tvrdou závislost na jménu `veslo-code`: ponechat `veslo-code` a místo symlinku zajistit `opencode` na PATH per spawn (env manipulace) — složitější, volit jen nouzově. Ověř na finálním bundlu, že je jen jedna 104MB binárka.
2. **chrome-devtools-mcp on-demand**: smaž z bundlu shim (`chrome-devtools-mcp-shim.ts` + kompilát), vendorovaný npm balíček (`chrome-devtools-mcp-package/`), a `veslo-node` runtime (vč. mrtvého macOS provisioning bloku — stejně se nebundluje, `build-pipeline.md` §Duplicity). Náhrada: MCP konfigurace ve `workspace/files.rs` (a TS ekvivalentu po 1.6) přepne launcher na on-demand instalaci při prvním použití (managed install do app data dir, download s checksumem), nebo — nejjednodušší varianta — chrome-devtools MCP se přestane seedovat defaultně a stane se opt-in položkou v MCP katalogu. Zvol jednodušší cestu, která nevyžaduje novou infrastrukturu (feature freeze); preferuj opt-in.
3. `externalBin` v tauri confech zredukuj na: engine, `veslo-server`, `veslo-orchestrator` (+ JSON manifesty — hack „JSON jako binárka“ zatím nech, řeší se až s pipeline redesignem ve fázi 2).
4. Smaž mrtvou Vercel větev v `scripts/build.mjs` (odkaz na neexistující `services/veslo-share`).
5. `build.rs` a `versions.json` generaci uveď do souladu (bez chrome-mcp, bez veslo-node, jedno jméno enginu).

**Ověření:** plný bundle build `cd packages/desktop && pnpm exec tauri build --bundles app` a změř: `du -sh …/Contents/MacOS/` — očekávání ≤ ~235 MB (ze ~460 MB; −62 router z 1.5, −104 duplicitní engine, −61 chrome-mcp). Smoke: `pnpm dev` — engine startuje (spawn s novým jménem!), session flow funguje; MCP tab funguje; chrome-devtools MCP buď funkční on-demand, nebo čistě nepřítomný (dle zvolené cesty v kroku 2). Gate z fáze 0. Windows staging build.

**Hotovo znamená:** bundle obsahuje právě 3 sidecar binárky + Tauri shell; velikost binárek klesla o ≥160 MB proti baseline z fáze 0; vše funkční na macOS i Windows.

**Rizika a rollback:** (a) Přejmenování enginu je zásah do spawn kontraktu — `which opencode` self-check je důvod, proč jméno `opencode` musí existovat; testuj cold start s čistým data direm. (b) Odebrání chrome-devtools MCP z defaultu je viditelná změna — potvrď s Pavlem preferovanou cestu (otevřená otázka OO-6). (c) Windows: `spawn_hidden_command` a Authenticode hash logika pracují se jmény binárek — projít grep `veslo-code` i ve skriptech `scripts/release/`. Rollback: reset commitu.

**Odhad:** 1–2 sessions (dělicí bod: krok 1 samostatně, kroky 2–5 druhá session).

---

### Balíček 1.10 — Jeden zdroj verze + zjednodušení pinů

**Cíl:** Verze aplikace dnes žije v **7 souborech** (5× package.json, Cargo.toml, tauri.conf.json — bump skript je přepisuje) a pin OpenCode na **5 místech** (2× `opencodeVersion`, 2× `@opencode-ai/*` deps, Rust konstanta). Cíl: jeden kanonický zdroj pro každou z obou verzí + automatická propagace a konzistenční check.

**Vstupy:**
- Reporty: `analyza/build-pipeline.md` (§Release orchestrace — bump-version, hotspot 7), `analyza/opencode-vazba.md` §2.1, `SYNTEZA.md` §1.2 (tabulka pravd).
- Kód: `packages/app/scripts/bump-version.mjs`, `packages/desktop/package.json` (`opencodeVersion`), `packages/orchestrator/package.json` (`opencodeVersion` + `@opencode-ai/plugin`/`sdk` deps), `packages/app/package.json` (`@opencode-ai/sdk`), `packages/desktop/src-tauri/src/orchestrator/mod.rs:21` (`EXPECTED_OPENCODE_PLUGIN_VERSION`), `prepare-sidecar.mjs` (ř. 686–691 vynucení shody).

**Kroky:**
1. **Verze aplikace**: zaveď kořenový soubor `VERSION` (CalVer `YYYY.M.P`) jako jediný ručně editovaný zdroj; `bump-version.mjs` přepiš tak, aby četl `VERSION` a generoval zbylých 7 míst (zachovej i odvozenou WiX verzi). Přidej konzistenční check (skript `scripts/verify-version-consistency.mjs`, zapoj do `check:architecture` nebo `review.mjs`), který selže při ručním rozjetí.
2. **Pin OpenCode**: kanonický zdroj = `packages/desktop/package.json` pole `opencodeVersion`. Orchestrátorový `opencodeVersion` a obě `@opencode-ai/*` závislosti kontroluj checkem proti kanonickému (prepare-sidecar už shodu plugin↔engine vynucuje — rozšiř kontrolu na všechna 4 npm místa). Rust konstantu `EXPECTED_OPENCODE_PLUGIN_VERSION` generuj v `build.rs` z package.json (env `VESLO_OPENCODE_VERSION` → `env!` v Rustu) místo ruční synchronizace.
3. Aktualizuj `RELEASE.md` (postup bumpu = editace `VERSION` + spuštění skriptu).
4. Nezaváděj nic navíc (žádné nové nástroje typu changesets — feature freeze platí i pro tooling).

**Ověření:** `node packages/app/scripts/bump-version.mjs <aktuální verze>` doběhne a `git diff` je prázdný (idempotence); záměrně rozhoď jednu verzi → check selže; standardní ověření + `cargo check` (generovaná konstanta); `pnpm --filter @neatech/veslo run prepare:sidecar` projde.

**Hotovo znamená:** verze aplikace se mění editací 1 souboru; pin OpenCode má 1 ručně editované místo; rozjetí verzí zachytí automatický check.

**Rizika a rollback:** Nízké — čistě build-time změna. Riziko: `review.mjs` regexy mohou kontrolovat stará místa verzí — uprav souběžně. Rollback: reset commitu.

**Odhad:** 1 session.

---

### Balíček 1.11 — toy-ui + legacy agentlab aliasy — SCHVÁLENO 2026-07-19

> **Schváleno Pavlem 2026-07-19** (bez námitky, dle doporučení — nechráněný `/ui` povrch bez uživatelů). Krok 0 (fallback „ponechat“) je bezpředmětný.
> **Pozor — balíček 1.14 byl zrušen, automations ZŮSTÁVAJÍ:** mazat výhradně agentlab aliasy (`routes/automations.ts:233–397`) a legacy migraci (`readLegacyAgentLabStore`); zbytek `routes/automations.ts`, `automation-runner.ts` i `automation-store.ts` je živá funkce a zůstává.

**Cíl:** Odstranit vestavěný debug web frontend serveru (`/ui`, 1 812 LOC, **bez autentizace a defaultně zapnutý**) a s ním svázané legacy agentlab aliasy.

**Vstupy:** `analyza/server.md` (hotspot toy-ui, §6), `doplneni.md` 6.1 (řádky enable flagů: `server.ts:3047–3051` — prázdné `VESLO_TOY_UI` → zapnuto). Kód: `packages/server/src/toy-ui.ts`, `routes/health.ts` (ř. 267–288 — servírování `/ui`, `/ui/assets/*`), `server.ts` (`resolveToyUiEnabled` ř. 3047, použití ř. 2978, 4516), `routes/automations.ts` (ř. 233–397 — aliasy `/workspace/:id/agentlab/automations`, označené `@internal: toy-ui only`), `automation-store.ts` (ř. 49–230 `readLegacyAgentLabStore`).

**Kroky:**
0. (Fallback při „ponechat“) Přepni default `resolveToyUiEnabled()` na `false` — jediná změna.
1. Smaž `src/toy-ui.ts` + testy; z `routes/health.ts` odstraň `/ui*` routy; ze `server.ts` odstraň `resolveToyUiEnabled` a wiring.
2. Smaž agentlab aliasy v `routes/automations.ts:233–397` a `readLegacyAgentLabStore` migraci v `automation-store.ts:49–230` (jediní konzumenti byli toy-ui; produkční UI je nevolá — komentáře v kódu).
3. Grep sweep `toy-ui\|toyUi\|agentlab` v `packages/server` → 0.

**Ověření:** standardní ověření + `curl -s http://127.0.0.1:<port>/ui` → 404; `pnpm check:services`; smoke `pnpm dev` (automations/scheduled tab funguje beze změny — automations zůstávají, 1.14 zrušen).

**Hotovo znamená:** žádný nechráněný `/ui` povrch; agentlab vrstva pryč; server testy zelené.

**Rizika a rollback:** toy-ui je funkční dev nástroj — tým o něj přijde (náhrada: curl / budoucí řádné UI). Rollback: reset commitu.

**Odhad:** 1 session.

---

### Balíček 1.12 — document-runtime — SCHVÁLENO 2026-07-19

> **Schváleno Pavlem 2026-07-19** („není potřeba, když se office skills dělají přes něco jiného“). Office skills (docx/pdf/pptx/xlsx přes interní packy) tímto balíčkem NEJSOU dotčeny.

**Cíl:** Odstranit balíček `packages/document-runtime` (3 109 LOC), jeho serverovou routu (439) a ~15 release verify skriptů (~1 800 ř. v release pipeline).

**Vstupy:** `SYNTEZA.md` §4.2, `analyza/server.md` (routes tabulka), `analyza/build-pipeline.md` (document-runtime feed v release workflow). Kód: `packages/document-runtime/`, `packages/server/src/routes/document-runtime.ts`, `scripts/document-runtime/`, `scripts/release/verify-document-runtime*`, `.github/workflows/release-macos-aarch64.yml` (document-runtime feed kroky), root `package.json` (`check:unit` obsahuje `veslo-document-runtime test`).

**Kroky:**
1. Zjisti FE konzumenty routy (`grep -rn "document-runtime" packages/app/src`) a smaž je (dle analýzy je funkce volitelná bez must-keep vazby; pokud najdeš živé použití v must-keep flow, STOP a eskaluj Pavlovi).
2. Smaž `routes/document-runtime.ts` + registraci; smaž `packages/document-runtime/`; ukliď `check:unit` řetěz, knip.jsonc, lockfile.
3. Release pipeline: smaž `scripts/document-runtime/`, `verify-document-runtime*` skripty a feed kroky ve workflow; uprav `review.mjs` fragmenty.

**Ověření:** standardní ověření + repo-wide grep `document-runtime` (mimo docs) → 0; `review.mjs --strict` projde; smoke `pnpm dev`.

**Hotovo znamená:** balíček, routa i pipeline stopa neexistují; buildy zelené.

**Rizika a rollback:** Release workflow úpravy netestovatelné bez release — ověřit staging buildem spolu s 1.5. Rollback: reset commitu.

**Odhad:** 1 session.

---

### Balíček 1.13 — Soul (server + UI) — ZRUŠENO 2026-07-19 (Soul zůstává)

> **ZRUŠENO 2026-07-19: Soul v produktu ZŮSTÁVÁ.** Pavel: funkce je záměrná — popis firmy + „pseudoprompt“ uživatele (např. vykání). Balíček se NEPROVÁDÍ; text níže je ponechán jen jako historie úvahy. Fáze 2 a 3 se Soulem počítají jako s živou funkcí (jeho routy a UI se udržují funkční).

**Cíl:** Odstranit funkci Soul: serverové routy (749), UI stránku (926), Den sync klienta a provisioning šablon. (Soul = persona/paměť vrstva; z pohledu 4 povinných funkcí volitelná.)

**Vstupy:** `SYNTEZA.md` §4.2, `analyza/server.md`, `doplneni.md` 6.4 (dashboard taby). Kód: `packages/server/src/routes/soul.ts` (749, 15 rout), `src/soul-den-client.ts`, `packages/app/src/app/pages/soul.tsx` (926), dashboard tab `soul` (`types.ts:369–377`, `dashboard.tsx`), soul šablony v provisioningu (`internal-system.ts` po 1.6; `workspace/files.rs`), orchestrátor hook „reload engine when soul updates“ (grep `soul` v `packages/orchestrator/src`).

**Kroky:**
1. UI: smaž `pages/soul.tsx`, tab `soul` z `types.ts` + `dashboard.tsx` + navigace; i18n klíče.
2. Server: smaž `routes/soul.ts` + registraci, `soul-den-client.ts`, soul části provisioningu (`.opencode/soul-*.md` šablony) — soubory v existujících workspace nech ležet (čistý start, neuklízet data).
3. Orchestrátor/desktop: grep `soul` → smaž reload hooky a zbytky.
4. E2E: soul scénáře (`test:pilot:soul-*`) smaž z `packages/e2e` + package.json skriptů.

**Ověření:** standardní ověření + smoke: dashboard bez soul tabu, session flow beze změny; grep `soul` v `packages` (mimo docs, případ-insensitive s ručním tříděním falešných zásahů) → 0 produkčních výskytů.

**Hotovo znamená:** Soul neexistuje v UI, na serveru ani v provisioningu; gate zelený.

**Rizika a rollback:** Soul má Den stranu (registry/sync) — cloudová strana se NEmění (mimo rozsah), jen lokální klient; Den endpointy zůstanou bez konzumenta, což je v pořádku. Rollback: reset commitu.

**Odhad:** 1 session.

---

### Balíček 1.14 — Automations (UI + routy + runner) — ZRUŠENO 2026-07-19 (automations zůstávají)

> **ZRUŠENO 2026-07-19: automations v produktu ZŮSTÁVAJÍ.** Pavel: „do budoucna by tam měly být.“ Balíček se NEPROVÁDÍ; text níže je ponechán jen jako historie úvahy. UI tab `scheduled`, `routes/automations.ts`, `automation-runner.ts` i `automation-store.ts` zůstávají a přestavba je nesmí dále rozbít; jejich DOKONČENÍ je ale mimo scope (feature freeze).
>
> Pozn. 1: klientský OpenCode plugin k automations je hard-disabled (nikdy nic nespustil) a maže se i nadále nepodmíněně v 1.3 — jeho smazání chování nemění. Pozn. 2: balíček 1.11 maže z `routes/automations.ts` POUZE legacy agentlab aliasy (viz upozornění tam).

**Cíl:** Odstranit plánované automatizace: UI tab `scheduled` (1 206), serverové routy `automations.ts` (to, co zbude po odstranění agentlab aliasů v 1.11; celkem 655) a aktuální generaci runneru.

**Vstupy:** `SYNTEZA.md` §4.2, `analyza/server.md` (tři generace plánovačů — legacy scheduler šel v 1.3, agentlab aliasy v 1.11, tady jde poslední generace), `doplneni.md` 6.4. Kód: `packages/app/src/app/pages/scheduled.tsx` (1 206), tab `scheduled` v `types.ts`/`dashboard.tsx` (pozn.: je to defaultní redirect cíl `/dashboard/scheduled` — přepnout default na jiný tab, např. `skills`), `packages/server/src/routes/automations.ts`, `automation-runner.ts`, `automation-store.ts` (zbytek po 1.11), zápisy `.opencode/veslo/automations.json`.

**Kroky:**
1. UI: smaž `pages/scheduled.tsx` + tab + navigaci; přesměruj defaultní dashboard tab (grep `dashboard/scheduled` — vyskytuje se i v `app-startup-controller.ts` redirectech z 1.2).
2. Server: smaž `routes/automations.ts` + registraci, `automation-runner.ts`, `automation-store.ts`; provisioning přestane spravovat `automations.json`.
3. Grep sweep `automation` v `packages/app/src` a `packages/server/src` → 0 produkčních výskytů (pozor na nesouvisející slova).
4. E2E: automations TOML scénáře smaž (stejně nemají žádný vstupní bod — `doplneni.md` Mezera 5).

**Ověření:** standardní ověření + smoke: dashboard startuje na novém defaultním tabu; session/skills/MCP beze změny; gate zelený.

**Hotovo znamená:** funkce automations neexistuje; default tab funguje; testy zelené.

**Rizika a rollback:** Změna defaultního tabu je viditelná změna chování — uvést v release notes. Rollback: reset commitu.

**Odhad:** 1 session.

---

## 7. Volitelná příloha mimo kritickou cestu: úklid cloudové vrstvy (Den)

**V této fázi se neprovádí** — jen evidence pro pozdější rozhodnutí (vyžaduje migrační plán, v Den jsou produkční data a MySQL schéma s možným driftem — `SYNTEZA.md` §7 otázka 8):

- Divergovaný fork AI gateway uvnitř Den (`services/den/src/managed-ai/`, 9 483 LOC) — čistá duplicita běžící v produkci dvakrát.
- Cloud workers stack (worker-manager 831, provisioner, Render cesta s rozbitým pinem `veslo-orchestrator@0.11.113`) — z pohledu desktopu mrtvý; Pavel: remote se neřeší.
- `packages/web` (4 503, Next.js account stránky) + `packages/landing` (1 791, druhý Next.js) + `services/openwork-share` (1 182).
- Po 1.4/1.5: v `services/den` a `services/worker-manager` zůstává předávání flagu `--no-veslo-code-router` (no-op) — uklidit při prvním zásahu do Den.

---

## 8. Souhrn rizik fáze

1. **Testy jako beton**: 40–50 % LOC jsou testy pevně svázané s vnitřní strukturou; každé mazání strhne testy. Pravidlo: testy mrtvého kódu se mažou, ne opravují. Odhady sessions to už zohledňují.
2. **Regresní síť je čerstvá a tenká**: gate z fáze 0 pokrývá zlomek chování. Kompenzace: ruční smoke test v každém balíčku + Windows staging build u 1.4–1.9 (Windows je tvrdý požadavek, ale většina vývoje běží na macOS).
3. **God files jako místo střetu**: `server.ts` (4 883), `cli.ts` (6 934), `lib.rs`, `tauri.ts` edituje většina balíčků → **balíčky vykonávat sériově**, ne paralelně; po každém balíčku commit.
4. **„Mrtvý“ kód může být rozdělaná funkce**: u inbox-panel a windows-sandbox-repair Pavel 2026-07-19 smazání potvrdil (OO-5 vyřešeno); u dalších nálezů platí povinný grep-ověřovací krok před smazáním.
5. **Release pipeline je netestovatelná bez releasu**: změny workflow (1.5, 1.9, 1.10, 1.12) ověřit jedním staging buildem (`build-staging-app.yml` dispatch) před prvním ostrým releasem po fázi.
6. **Schválené ořezy mění viditelné chování** (zmizelý `/ui` povrch, chrome-mcp opt-in) — zmínit v release notes. Soul i `scheduled` tab v UI zůstávají (1.13/1.14 zrušeny), default tab se nemění.
7. **Balíček 1.8 je jednosměrný** (smazaný pool se bez revertu nevrátí) — proto je tvrdě podmíněn experimentem fáze 0 a má definovanou větev B (odklad).
8. **Drift analýzy vs. HEAD**: analýza platí k `71215b07`; každý balíček má povinný krok „ověř grepem před smazáním“.

---

## 9. Otevřené otázky

Otázky, které musí rozhodnout **Pavel** (P) nebo ověřit **fáze 0** (F0), než se dotčený balíček spustí:

- **OO-1 (P) — VYŘEŠENO 2026-07-19:** toy-ui ANO vyhodit (bez námitky, dle doporučení), document-runtime ANO vyhodit, Soul NE (zůstává, 1.13 zrušen), automations NE (zůstávají, 1.14 zrušen). Viz ZADANI.md.
- **OO-2 (P) — VYŘEŠENO 2026-07-19:** varianta (b) — historie chatů se při přesunu složky PŘENÁŠÍ, implementace server-side (žádný Rust regex do `opencode.db`). Balíček 1.7 upraven, odhad 2 sessions.
- **OO-3 (F0):** Výsledek experimentu „config díra“ — čte OpenCode per-workspace config ve shared režimu (per session directory / per request)? Určuje větev A/B balíčku 1.8.
- **OO-4 (F0/P):** Ověřit na HEAD skutečný default topologie na macOS (rozpor dokumentů — `runtime_preferences.rs:33` vs. starší david-eval; SYNTEZA §7 ot. 2).
- **OO-5 (P) — VYŘEŠENO 2026-07-19:** inbox-panel i windows-sandbox-repair SMAZAT (windows-sandbox-repair patřil k odloženému sandboxu; inbox-panel Pavel nezná a nedává mu smysl). Balíček 1.1 je maže bez podmínky.
- **OO-6 (P):** chrome-devtools MCP (balíček 1.9): stačí opt-in z MCP katalogu (doporučeno, nejjednodušší), nebo je potřeba on-demand managed install při prvním použití?
- **OO-7 (P, nespěchá):** Osud CLI host modu orchestrátoru (`veslo start` + TUI dashboard, ~1 700 ř. + 8 `@opentui/*` závislostí; z pohledu desktopu mrtvé — `analyza/orchestrator.md` §Duplicity). Není v rozsahu fáze 1; přirozeně zanikne při sloučení orchestrátoru do serveru ve fázi 2, ale lze předřadit jako levný ořez.
- **OO-8 (P, nespěchá):** `npm deprecate veslo-code-router` po 1.5 (vyžaduje npm práva vlastníka).

---

*Konec plánu fáze 1. Stav exekuce značit odškrtáváním v tabulce §4 (sloupec Stav → „hotovo YYYY-MM-DD“).*
