# Fáze 3 — Frontend na HTTP + rozbití god files

Součást plánu přestavby Vesla (schválená varianta 2 — BE/FE split fázovaně, viz `docs/prestavba/ZADANI.md`).
Podklad: analýzy v `docs/prestavba/analyza/` — především `app-integrace.md`, `ipc-http-parita.csv`, `app-jadro.md`, `app-komponenty.md`, `dokumentace.md`. Čísla ověřena na HEAD `71215b07` (2026-07-19); před každým balíčkem znovu ověř aktuální stav — fáze 1 a 2 kód změnily.

---

## Účel fáze

Po fázi 2 má backend (veslo-server) jediný HTTP+SSE kontrakt, vlastní engine pool a server-owned stav. Frontend ale stále mluví dvěma jazyky: Tauri IPC (~90 příkazů) a HTTP. Fáze 3 tuto dvojkolejnost končí:

1. **Transport**: FE přejde kompletně na HTTP/SSE kontrakt veslo-serveru. Z ~96 IPC příkazů (klasifikace v `ipc-http-parita.csv`): **31 kategorie B** se portuje na HTTP (nové malé serverové routy + přepnutí FE), **15 se škrtá** (13× C2 lifecycle — spouštění procesů je po fázi 2 věc backendu; 2× C3 SSE most — nahrazen serverovým SSE), **≤11 kategorie C1 zůstává nativních** (updater, clipboard, okna, Obsidian open, folder picker přes Tauri dialog; přesný seznam určí inventura 3.1 podle stavu po fázích 1–2 — např. WSL repair příkazy `wsl_prerequisites_repair`/`wsl_sandbox_repair` maže už fáze 1 spolu s `wsl_sandbox.rs`, balíčky 1.1/1.8), kategorie A (~34) se přepne z `invoke()` na generovaný HTTP klient tam, kde to neudělala už fáze 2. 5 příkazů kategorie E existuje jen v e2e buildu a zanikne s přechodem na Playwright.
2. **Anti-corruption vrstva**: vlastní Veslo typy (event/part/message/session) v UI, import-ban lint na `@opencode-ai/sdk` v `packages/app`, mapování výhradně na hranici. Engine zůstane levně vyměnitelný.
3. **Jedna identita**: session v UI adresována výhradně `(workspaceId, conversationId)` — konec 3 jmenných prostorů.
4. **Rozbití god files**: `app.tsx` (5 339 ř.), `session.tsx` (5 012 ř.), `app-view-props.ts` (2 046 ř., 311polový scope), `SessionViewProps` (180 props), `DashboardViewProps` (258 props) → doménové Solid kontexty; **žádný dotčený soubor přes ~800 řádků**. Průběžně mazat lifecycle-guard moduly, které po fázi 2 (server-owned stav) ztratily smysl.
5. **Runtime adapter**: 353 výskytů `isTauriRuntime()` v 59 produkčních souborech (na HEAD; analýza uvádí 471 výskytů včetně testů) → jediná modulová hranice.
6. **E2E**: přechod z tauri-pilot na standardní Playwright proti prohlížeči; desktop smoke zůstává malý.

**Proč v tomto pořadí**: nejdřív transport (Blok A) — aplikace se doména po doméně odpojuje od IPC a po každém balíčku funguje. Pak anti-corruption + identita (Blok B) — mapovací hranice se staví nad již sjednoceným transportem. Pak Playwright (Blok C) — rychlá regresní síť v prohlížeči. Teprve pak dekompozice god files (Blok D) — nejrizikovější práce na timing (SolidJS efekty), jištěná novou E2E sítí. Redukce props-drillingu je zařazena do balíčků, které dané soubory stejně otevírají (3.16–3.18).

## Prerekvizity (co musí být hotové z předchozích fází)

Před startem fáze 3 ověř, že platí následující. Pokud něco neplatí, fáze 3 nezačíná (respektive začíná jen balíčkem 3.1) a vrací se to hlavní session jako blokátor.

| # | Prerekvizita | Z fáze | Jak ověřit |
|---|---|---|---|
| P1 | Regresní minimum: gate E2E scénáře (~10–15, suite `rebuild-gate` z balíčku 0.9) zelené a vynucované v CI, unit testy zelené | 0 | `cd git && pnpm --filter @neatech/veslo-e2e run test:e2e:gate` projde (ověř aktuální název suite/skriptu v `pilot-runner.ts` — balíček 0.9); CI zelené na `main` |
| P2 | Mrtvý kód smazán (db-reader, scheduler IPC+HTTP, identities.tsx, proto stránky, …), router (opencode-router) kompletně pryč včetně `opencodeRouter_*` IPC | 1 | `grep -rn "opencodeRouter" packages/app/src packages/desktop/src-tauri/src` → 0 výskytů |
| P3 | Konec přímého SQL do `opencode.db` z Rustu; jediný provisioning (Rust `internal_provision.rs` už nezrcadlí TS) | 1–2 | `ls packages/desktop/src-tauri/src/commands/session_reader.rs` → neexistuje; `grep -rn "internal_provision" …/src-tauri/src` → jen volání server API, nebo nic |
| P4 | Orchestrátor sloučen do veslo-serveru (engine pool jako knihovna); backend si sám spravuje lifecycle enginů pro N workspace i v headless režimu | 2 | `pnpm dev:web` + druhá workspace: obě odpovídají (žádné `opencode_unconfigured`) |
| P5 | Serverový SSE endpoint s kurzorem (Last-Event-ID) pro události workspace: **`GET /workspace/:id/events/stream`** (nová cesta z balíčku 2.7; polling `GET /workspace/:id/events` fáze 2 záměrně ponechala jako JSON — maže ho až balíček 3.8) | 2 | `curl -N -H "Authorization: Bearer $TOKEN" -H "Accept: text/event-stream" $BASE/workspace/$WS/events/stream` streamuje eventy s `id:` řádky |
| P6 | OpenAPI spec serveru + **generovaný workspace-scoped TS klient** (nahrazuje ruční `lib/veslo-server/`), publikovaný jako workspace balíček | 2 | balíček `packages/api-client` existuje, generuje se a builduje: `pnpm --filter @neatech/veslo-api-client generate && pnpm --filter @neatech/veslo-api-client build`. POZOR: dle DoD 2.9 ho `packages/app` po fázi 2 ještě **neimportuje** — adopce a import-ban je náplň fáze 3 |
| P7 | Server-owned aktivní workspace a run lifecycle (aktivace = jedna serverová operace; FE `activeWorkspaceId` je jen UI focus) | 2 | `POST /workspaces/:id/activate` existuje; v FE není zápis aktivního workspace do Tauri registru |
| P8 | Auth model pro FE↔server bez IPC bootstrapu rozhodnut (token do webview, cookie/query pro SSE, CORS pro `tauri://localhost` i browser origin) | 2 | dokument fáze 2 + funkční `curl` s tokenem proti serveru |
| P9 | ~~Generování provider konfigurace přesunuto na server~~ — **zrušeno jako prerekvizita**: žádný balíček fáze 2 tuto práci neobsahuje; přesun `applyGatewayProviderRouting` (`lib/opencode.ts:400-561`) na server provede **balíček 3.4, krok 0** (tam se `lib/opencode.ts` stejně otevírá) | — (3.4) | není vstupní podmínka fáze — DoD viz balíček 3.4 |

Poznámka: pokud fáze 2 některé A-příkazy už přepnula na HTTP (pravděpodobné u workspace registru kvůli P7), příslušné kroky v balíčcích 3.2–3.6 se zkrátí — každý balíček začíná ověřením „co ještě jde přes IPC".

## Milník — co funguje, když je fáze hotová

- **Jedna aplikace, dva hostitelé**: totéž UI běží v Tauri webview i v čistém prohlížeči (`pnpm dev:web`) nad **identickým HTTP+SSE kontraktem**. Desktop navíc poskytuje jen ≤11 nativních schopností (přesný seznam z inventury 3.1) přes runtime adapter.
- `grep -rnE 'invoke(<[^>]*>)?\(' packages/app/src --include="*.ts*" | grep -v "app/runtime/"` → **0 výskytů** (POZOR: vzor musí pokrývat i generickou formu `invoke<T>("cmd")` — na HEAD prostý vzor `invoke(` najde jen 6 z 91 volání) **a** finální DoD: `grep -rn 'from "@tauri-apps/api/core"' packages/app/src --include="*.ts*" | grep -v "app/runtime/"` → **0** (ban importu, ideálně vynucený lintem `no-restricted-imports`); IPC příkazů registrovaných v Rustu ≤ 11 (+ e2e-only).
- `lib/tauri.ts`, `lib/engine-sse.ts`, `context/workspace-routing.ts` (Proxy stale-guard), `context/global-sdk.tsx`, `context/server.tsx`, ruční klient `lib/veslo-server/` — **smazány**.
- **0 importů `@opencode-ai/sdk`** v `packages/app` (vynuceno lintem), balíček není v dependencies `packages/app/package.json`.
- Session je všude identifikována `(workspaceId, conversationId)`; `lib/session-identity.ts` a `ws:`/`ws2:` kompozitní klíče neexistují.
- `app.tsx` ≤ ~800 ř., `session.tsx` rozpadnut na moduly ≤ ~800 ř., `app-view-props.ts` neexistuje, `SessionViewProps`/`DashboardViewProps` nahrazeny kontexty.
- E2E gate běží standardním Playwrightem proti prohlížeči; desktop smoke (start, bootstrap, folder picker, updater povrch) zůstává malý.
- Všechna 4 povinná flow (přidání složky, session + zpráva, transkript, skills/MCP zápis) fungují na Windows i macOS.

## Tabulka balíčků

| # | Balíček | Blok | Závisí na | Odhad (AI sessions) |
|---|---|---|---|---|
| 3.1 | Inventura IPC povrchu + kostra runtime adapteru | A | fáze 2 | 1 |
| 3.2 | Doména workspace: registr a config na HTTP | A | 3.1 | 1–2 |
| 3.3 | Doména skills na jediný serverový kanál + rozpad `extensions.ts` | A | 3.1 | 2 |
| 3.4 | Doména OpenCode config, commands, MCP auth (+ přesun provider routingu, ex-P9) | A | 3.1 | 1–2 |
| 3.5 | Doména osobního stavu: drafty, preference, access proofs, Den auth snapshot | A | 3.1 | 1–2 |
| 3.6 | Doména diagnostiky a údržby + Obsidian mirror | A | 3.1 | 1 |
| 3.7 | Škrt 13 lifecycle příkazů (C2) + bootstrap injektáží + rozpuštění `lib/tauri.ts` | A | 3.2–3.6 | 2 |
| 3.8 | Jeden SSE konzument (škrt C3, smazání Rust SSE mostu) | A | P5, 3.7 | 2 |
| 3.9 | Konec per-workspace SDK klientů a Proxy stale-guardu | A | P6, 3.8 | 1–2 |
| 3.10 | Anti-corruption I: Veslo doménové typy + mapování na hranici (render stack) | B | 3.8, 3.9 | 2 |
| 3.11 | Anti-corruption II: zbytek SDK importů + import-ban lint | B | 3.10 | 1 |
| 3.12 | Identita session = `conversationId` | B | 3.9, 3.10 | 2 |
| 3.13 | E2E na standardní Playwright proti prohlížeči | C | 3.7–3.9 | 2 |
| 3.14 | Redukce `isTauriRuntime` na modulovou hranici | D | 3.7, 3.13 | 1 |
| 3.15 | Dekompozice I: provider strom + workspace doména + úklid guardů | D | 3.13, P7 | 3–4 |
| 3.16 | Dekompozice II: SessionView na kontexty (konec `SessionViewProps`) | D | 3.15 | 2–3 |
| 3.17 | Dekompozice III: Dashboard/Settings na kontexty + smazání `app-view-props.ts` | D | 3.16 | 3 |
| 3.18 | Dekompozice IV: rozřezání `session.tsx` | D | 3.16 | 2–3 |
| 3.19 | Závěrečná kontrola fáze, metriky, aktualizace dokumentace | — | vše | 1 |

**Celkem: 19 balíčků, odhad 28–38 AI sessions.** Odhady bloku D počítají s restrukturalizací ~20 000 ř. nejkřehčího kódu včetně údržby/mazání testů (40–50 % LOC); pokud balíček přeteče, **rozděl ho po commitových švech uvedených v Krocích** — přetečení je očekávaný režim, ne selhání.

Pravidla platná pro všechny balíčky:

- **Aplikace musí fungovat po každém balíčku** — desktop (`pnpm dev`) i web (`pnpm dev:web`). Blok A: po každém balíčku spustit desktop smoke (`pnpm --filter @neatech/veslo-e2e test:pilot:smoke`) i ruční průchod hlavního flow.
- **Commit po každém dokončeném balíčku** (v `git/`, bez push — push až po manuálním otestování Pavlem). Nepřidávat Co-Authored-By.
- **Každé smazání IPC příkazu = dva kroky**: (1) FE přestane volat (smazat wrapper), (2) teprve pak odregistrovat v Rustu (`packages/desktop/src-tauri/src/lib.rs`, blok `generate_handler` cca ř. 309–413) a smazat Rust handler; po změně Rustu `cargo check` v `packages/desktop/src-tauri`.
- **Testy**: každý balíček opraví/aktualizuje zasažené testy. „Source-contract" testy (regexují zdroják) a testy betonující staré prop tvary **mazat, ne přepisovat** — chování jistí E2E gate. Toto je schválená politika (analýza `dokumentace.md` §3 třída H, SYNTEZA KP5).
- **Žádné nové featury** (feature freeze) — jakákoli „když už jsem v tom" vylepšení se zapisují do poznámek, ne do kódu.
- **Každá nová/změněná serverová routa = úprava kontraktu**: B-porty v balíčcích 3.2–3.6 (i doplňky rout v 3.9) vyžadují aktualizaci `packages/server/openapi.yaml`, regeneraci klienta (`pnpm --filter @neatech/veslo-api-client generate`) a zelený inventory drift test z balíčku 2.9. Je to součást DoD každého balíčku Bloku A — bez toho generovaný klient novou routu nemá, spadne CI drift check a hrozí obcházení hranice ručním fetchem (porušení ZADANI).
- Pracovní checklist fáze si veď v `docs/prestavba/plan/faze-3-checklist.md` (vytvoří balíček 3.1, aktualizuje každý další).

---

## Balíček 3.1 — Inventura IPC povrchu na aktuálním HEAD + kostra runtime adapteru

**Cíl:** Aktualizovaný seznam „co ještě jde přes IPC" po fázích 1–2 a nová modulová hranice `packages/app/src/app/runtime/` pro nativní operace, na kterou se budou další balíčky napojovat.

**Vstupy:**
- `docs/prestavba/analyza/ipc-http-parita.csv` — klasifikace všech 96 příkazů (kategorie, dnešní HTTP ekvivalent, poznámka)
- `docs/prestavba/analyza/app-integrace.md` §A–C (inventura IPC, Tauri events, pluginů)
- Kód: `packages/app/src/app/lib/tauri.ts` (1 467 ř., ~96 exportovaných wrapperů), `packages/desktop/src-tauri/src/lib.rs` (`generate_handler`), `packages/app/src/app/context/platform.tsx` (existující, jen částečně používaná Platform abstrakce)

**Kroky:**
1. Vygrepuj aktuální stav: `grep -rnE 'invoke(<[^>]*>)?\(' packages/app/src --include="*.ts*"` a porovnej s CSV. (POZOR: prostý vzor `invoke(` najde jen ~6 z 91 volání — wrappery v `lib/tauri.ts` volají generickou formu `invoke<T>("cmd")`; bez regexu s generiky inventura stav masivně podhodnotí.) Zapiš do `docs/prestavba/plan/faze-3-checklist.md` tabulku: příkaz → kategorie → stav (živý / už smazán fází 1–2 / už na HTTP) → cílový balíček fáze 3. Tento soubor je pracovní evidence celé fáze.
2. Založ `packages/app/src/app/runtime/` s rozhraním `NativeRuntime` pokrývajícím C1 schopnosti (≤11, přesný seznam dle inventury z kroku 1 — stav po fázích 1–2) + Tauri pluginy: `pickFolder`/`pickFile`/`saveFile` (dnes `lib/tauri.ts:878-919`, plugin-dialog), `clipboardFilePaths`, okno (titlebar/drag/minimize — dnes `lib/tauri.ts:1367-1448`), updater (`updater_environment`, `updater_prepare_install`, `updater_relaunch_after_install` + plugin-updater), `openUrl`/`openPath` (plugin-opener), `obsidianIsAvailable`/`openInObsidian`, `desktop_sandbox_environment` (jen pokud přežil sandbox ořez 1.8 — ověř), `workspace_grant_folder_access`, `set_window_decorations`, deep-link listener. WSL repair příkazy (`wsl_prerequisites_repair`, `wsl_sandbox_repair`) do adapteru **nezahrnuj** — `wsl_sandbox.rs` maže fáze 1 (balíček 1.8, obě větve) a jejich FE konzument padl už v 1.1; pokud by na HEAD přesto existovaly, zapiš do checklistu a eskaluj.
3. Dvě implementace: `runtime/tauri.ts` (skutečné invoke/pluginy) a `runtime/web.ts` (no-op / HTML5 fallback / `undefined` tam, kde schopnost v prohlížeči neexistuje — konzument se ptá `runtime.capabilities`). Výběr implementace na jednom místě při bootstrapu.
4. Přepni na adapter **první konzumenty**: volání dialogů a okna (vyhledej importy dotčených funkcí z `lib/tauri.ts`). Zbytek konzumentů se přepne v doménových balíčcích — v tomto balíčku neměň víc, než je nutné k důkazu, že adapter funguje.
5. Nic v Rustu nemaž — jen FE vrstva.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
pnpm dev          # desktop: folder picker a ovládání okna fungují
pnpm dev:web      # web: aplikace nastartuje, picker větev nespadne (fallback)
pnpm --filter @neatech/veslo-e2e test:pilot:smoke
```

**Hotovo znamená:** checklist existuje a je úplný (všech 96 příkazů má stav a cílový balíček); `runtime/` modul existuje se dvěma implementacemi; dialogy a okno jdou přes adapter; vše zelené.

**Rizika a rollback:** minimální — aditivní změna. Rollback = revert commitu. Riziko: checklist odhalí, že fáze 2 nechala víc IPC živého, než plán čekal → aktualizuj odhady balíčků 3.2–3.7, nepokračuj slepě.

**Odhad:** 1 session.

---

## Balíček 3.2 — Doména workspace: registr a config na HTTP

**Cíl:** Veškeré workspace operace FE jdou přes HTTP na veslo-server; workspace IPC příkazy smazány z FE i Rustu.

**Vstupy:**
- `ipc-http-parita.csv` řádky `workspace_*`, `runtime_prepare_workspace`
- `app-integrace.md` §A (workspace registry 13 příkazů), `dokumentace.md` §3 třída A (4 pravdy o aktivním workspace)
- Kód: `packages/app/src/app/lib/tauri.ts` (workspace wrappery), `packages/app/src/app/context/workspace-activation-local.ts` (ř. ~232–330 — aktivace přes IPC), `packages/app/src/app/context/workspace.ts`, serverové routy workspace (`packages/server/src/` — najdi podle CSV sloupce `http_ekvivalent_dnes`: `GET/POST/PATCH/DELETE /workspaces*`, `POST /workspace/:id/system/provision`, `GET/PATCH /workspace/:id/config`, `GET /workspace/:id/export`, `POST /workspace/:id/import`)

**Kroky:**
1. Ověř podle checklistu z 3.1, co z domény po fázi 2 (P7 — server-owned aktivace) ještě jde přes IPC. Očekávané A-příkazy k přepnutí: `workspace_bootstrap`, `workspace_set_active`, `workspace_create`, `workspace_update_display_name`, `workspace_forget`, `workspace_export_config`, `workspace_import_config`, `workspace_veslo_read/write`, `runtime_prepare_workspace`.
2. B-porty (nové malé routy na serveru, pokud je fáze 2 nezaložila): `workspace_private_root` → `GET /workspaces/private-root` (server zná vlastní data dir); `workspace_copy_into_folder` → `POST /workspaces/copy-into-folder` (FS kopie na serveru); `workspace_add_authorized_root` → routa v rámci auth/trust modelu fáze 2 (P8) — pokud fáze 2 trust model zjednodušila, příkaz škrtni.
3. `workspace_create_remote` / `workspace_update_remote`: remote stack se dle ZADANI neřeší — ověř, zda fáze 1 remote workspaces vyřadila. Pokud ano, škrtni; pokud ne, **zastav a nech rozhodnout Pavla** (viz otevřené otázky).
4. Přepnutí FE: volání v `workspace-activation-local.ts`, `workspace.ts` a spol. na generovaný klient (P6). Smaž workspace wrappery z `lib/tauri.ts`.
5. Po ověření FE odregistruj příkazy v Rustu (`lib.rs` + `commands/workspace.rs`), `cargo check`.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rnE 'invoke(<[^>]*>)?\("workspace' packages/app/src --include="*.ts*"   # → 0 (kromě grant_folder_access v runtime/; vzor kryje i generika invoke<T>)
cd packages/desktop/src-tauri && cargo check
# funkční: přidání složky, přejmenování, forget, export/import — v desktopu i pnpm dev:web
BASE=... TOKEN=...  # z fáze 2 auth
curl -s -H "Authorization: Bearer $TOKEN" $BASE/workspaces | head
pnpm --filter @neatech/veslo-e2e test:pilot:smoke
```

**Hotovo znamená:** žádný workspace `invoke` mimo `runtime/` (`workspace_grant_folder_access` zůstává nativní); create/rename/forget/export/import/aktivace fungují v obou hostitelích; Rust handlery smazány.

**Rizika a rollback:** aktivace workspace je historicky nejkřehčí místo (třída chyb A/B — `dokumentace.md`). Neměň logiku aktivace, jen transport — guardy se ruší až v 3.15. Rollback: revert commitu (FE i Rust změny drž v jednom commitu balíčku).

**Odhad:** 1–2 sessions.

---

## Balíček 3.3 — Doména skills na jediný serverový kanál + rozpad `extensions.ts`

**Cíl:** Skills mají jediný kanál (server HTTP); 12 IPC skills příkazů + `opkg_install` pryč; `extensions.ts` (3 665 ř.) rozpadnut na moduly ≤ ~800 ř., protože arbitráž mezi 4 zdroji skills ztrácí smysl.

**Vstupy:**
- `ipc-http-parita.csv` řádky `*skill*`, `opkg_install`, `import_skill`
- `app-integrace.md` §Duplicitní kanály (Skills CRUD — IPC/server/registry/hub) a §Hotspot 3 (`extensions.ts` kaskádové fallbacky)
- Kód: `packages/app/src/app/context/extensions.ts` (3 665 ř.), `packages/app/src/app/lib/tauri.ts` (skills wrappery), serverové routy `/workspace/:id/skills*`, `/skills/user-global-store`, `/skills/import-candidates`, `/workspace/:id/skills/hub/:name`, `/workspace/:id/mcp/hub/:name`

**Kroky:**
1. A-přepnutí (12 příkazů): `list_local_skills(_scoped)`, `read_local_skill(_at_path)`, `read_local_skill_files_at_path`, `write_local_skill(_at_path)`, `uninstall_skill(_at_path)`, `import_skill`, `install_skill_template`, `install_global_skill_template` → generovaný klient na existující routy (viz CSV).
2. B-port: `opkg_install` → `POST /workspace/:id/skills/opkg-install` (exec opkg na serveru; hub instalace už na serveru je — možná stačí rozšířit existující routu).
3. V `extensions.ts` smaž celé rameno „lokální IPC zdroj" a arbitráž podle `vesloServerStatus()` — server je vždy dostupný (je to jediný backend). Kaskádové fallbacky nahraď prostým voláním klienta.
4. Rozpadni `extensions.ts` na `context/extensions/` moduly: `skills.ts`, `plugins.ts`, `hub.ts`, `install-targets.ts` (hranice viz `app-integrace.md` — soubor dnes míchá skills+pluginy+hub+reload-guard). Žádný modul přes ~800 ř. Veřejné API store zachovej (konzumenti se nemění).
5. Smaž skills wrappery z `lib/tauri.ts`, odregistruj v Rustu (`commands/skills.rs`, `commands/opkg.rs`), `cargo check`.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rnE 'invoke(<[^>]*>)?\("(list_local|read_local|write_local|uninstall_|import_skill|install_|opkg)' packages/app/src   # → 0 (vzor kryje i generika invoke<T>)
wc -l packages/app/src/app/context/extensions/*.ts   # každý ≤ ~800
# funkční test: dashboard → Skills: list, detail, install z hubu, zápis lokálního skillu, uninstall — desktop i web
pnpm --filter @neatech/veslo-e2e test:pilot:core-platform-skills
```

**Hotovo znamená:** skills fungují v obou hostitelích výhradně přes server; `extensions.ts` neexistuje jako monolit; 13 IPC příkazů pryč z FE i Rustu.

**Rizika a rollback:** `extensions.ts` má hodně konzumentů — rozpad dělej jako přesun beze změny veřejného API. Riziko user-global skills (cesty mimo workspace) na Windows — otestuj obě platformy. Rollback: revert; transport-přepnutí a rozpad souboru drž ve **dvou samostatných commitech**, aby šel vrátit jen jeden.

**Odhad:** 2 sessions (1. transport, 2. rozpad souboru).

---

## Balíček 3.4 — Doména OpenCode config, commands, MCP auth

**Cíl:** Konfigurace enginu (`opencode.jsonc`), command soubory a MCP auth jdou přes server; 8 IPC příkazů pryč.

**Vstupy:**
- `ipc-http-parita.csv` řádky `read/write_opencode_config`, `opencode_command_*`, `opencode_mcp_auth`, `opencode_db_migrate`, `opencode_db_update_session_directory`
- `app-integrace.md` §Duplicitní kanály (opencode.jsonc, commands) a §Vazba na OpenCode bod 2 (UI přepisuje konfiguraci — po P9 už na serveru)
- Kód: `packages/app/src/app/lib/opencode.ts` (618 ř.), `lib/tauri.ts` (config/command/mcp wrappery), `packages/app/src/app/lib/mcp-connection-workflow.ts`, serverové routy `/workspace/:id/config`, `/workspace/:id/commands`, `/workspace/:id/mcp/*`

**Kroky:**
0. **Přesun provider routingu na server** (bývalá prerekvizita P9 — fáze 2 ji nedodává, vlastníkem je tento balíček): přenes `applyGatewayProviderRouting` (`lib/opencode.ts:400–561` — generování provider konfigurace enginu z Den gateway) do veslo-serveru k engine/config vrstvě z fáze 2; FE přestane provider konfiguraci skládat. DoD kroku: `grep -rn "applyGatewayProviderRouting" packages/app/src` → 0 produkčních výskytů.
1. A-přepnutí: `opencode_command_list/write/delete` → `GET/POST/DELETE /workspace/:id/commands`.
2. B-porty: `read/write_opencode_config` — workspace scope už má routu (`GET/PATCH /workspace/:id/config`); pro **globální scope** (`~/.config/opencode`) přidej `GET/PATCH /config/global`. `opencode_mcp_auth` (spouští `opencode mcp auth` CLI) → `POST /workspace/:id/mcp/:name/auth/start` na serveru (server exec; interaktivní OAuth krok vrací URL, FE ji otevře přes `runtime.openUrl`).
3. `opencode_db_migrate` a `opencode_db_update_session_directory`: podle P3 by přímý SQL měl být pryč — `opencode_db_update_session_directory` byl v balíčku 1.7 (OO-2, varianta b) nahrazen serverovým endpointem pro přesun sessions (historie se zachovává). Ověř — pokud některé z těchto IPC stále existuje, přesuň odpovědnost na server (server má k DB přístup a vlastní migrační místo) a z FE smaž; FE nikdy nesmí řídit migraci DB enginu.
4. Zbytky `lib/opencode.ts`: po kroku 0 (provider routing na serveru) v něm zbývá klient a scrubbing — scrubbing smaž (tajemství už FE nespravuje), tvorbu SDK klienta zatím nech (řeší 3.9).
5. Smaž wrappery, odregistruj Rust (`commands/config.rs`, `commands/command_files.rs`, část `commands/misc.rs`), `cargo check`.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rnE 'invoke(<[^>]*>)?\("(read_opencode|write_opencode|opencode_command|opencode_mcp_auth|opencode_db)' packages/app/src  # → 0 (vzor kryje i generika invoke<T>)
curl -s -H "Authorization: Bearer $TOKEN" $BASE/config/global | head
# funkční: dashboard → Config tab čte a zapisuje; MCP auth flow projde (dashboard → MCP)
pnpm --filter @neatech/veslo-e2e test:pilot:smoke
```

**Hotovo znamená:** config/commands/MCP auth přes server v obou hostitelích; žádné `opencode_*` IPC ve FE.

**Rizika a rollback:** MCP OAuth je interaktivní (90s timeouty, browser roundtrip) — otestuj ručně celý flow s reálným MCP. Krok 0 (provider routing) sahá do citlivé AI-gateway vazby — drž ho v samostatném commitu. Rollback: revert commitu.

**Odhad:** 1–2 sessions (krok 0 je práce navíc převzatá z prerekvizit).

---

## Balíček 3.5 — Doména osobního stavu: drafty, preference, access proofs, Den auth snapshot

**Cíl:** 11 B-příkazů osobního stavu nahrazeno serverovým úložištěm (nebo localStorage tam, kde jde o cache); FE nezávislý na app-data souborech Tauri.

**Vstupy:**
- `ipc-http-parita.csv` řádky `pending_session_drafts_*` (4), `desktop_runtime_preferences_*` (2), `access_proof_ai_*` (3), `den_auth_snapshot_*` (2)
- `app-integrace.md` §A (pending drafts — serializace příloh na bytes, `tauri.ts:296-366`; Den auth snapshot — `lib/den-auth.ts:12-13`)
- Kód: `packages/app/src/app/lib/tauri.ts` (drafts wrappery), `packages/app/src/app/lib/den-auth.ts` (1 156 ř.), Rust `commands/pending_session_drafts.rs`, `runtime_preferences.rs`, `commands/access_proofs.rs`, `commands/den_auth.rs`

**Kroky:**
1. **Pending drafts** → serverové routy `GET/PUT/DELETE /workspace/:id/drafts/:sessionKey` (+ list). Přílohy jako multipart nebo base64 — zachovej dnešní datový tvar draftu, jen změň úložiště (server app-data místo Tauri app-data). Čistý start = žádná migrace starých draftů.
2. **Runtime preferences** (`desktop_runtime_preferences_*`) → `GET/PATCH /preferences` na serveru. Pozor: pokud fáze 2 preference (topologie enginu) převzala do server konfigurace, FE příkazy jen škrtni.
3. **Access proof AI cache** → localStorage (je to cache; ztráta = re-fetch). Smaž IPC.
4. **Den auth snapshot** (persistence přihlášení) → `GET/PUT /auth/den-snapshot` na serveru (server s Denem stejně mluví — skill registry, gateway). V prohlížeči drží token server session/cookie dle P8. Uprav `lib/den-auth.ts` — čtení/zápis snapshotu přes klient; deep-link návrat (`veslo://auth-complete`) zůstává v runtime adapteru.
5. Smaž wrappery + Rust handlery, `cargo check`.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rnE 'invoke(<[^>]*>)?\("(pending_session_drafts|desktop_runtime_preferences|access_proof|den_auth_snapshot)' packages/app/src  # → 0 (vzor kryje i generika invoke<T>)
# funkční: rozepiš zprávu s přílohou, restartuj aplikaci → draft se obnoví; odhlásit/přihlásit Den; restart → přihlášení drží
pnpm --filter @neatech/veslo-e2e test:pilot:smoke
```

**Hotovo znamená:** drafty, preference a auth přežijí restart v obou hostitelích bez IPC; 11 příkazů pryč.

**Rizika a rollback:** Den auth je citlivé — pokud se snapshot rozbije, uživatel se „jen" znovu přihlásí (čistý start OK), ale otestuj ručně celý login/logout/restart cyklus. Rollback: revert commitu; auth část drž v samostatném commitu.

**Odhad:** 1–2 sessions.

---

## Balíček 3.6 — Doména diagnostiky a údržby + Obsidian mirror

**Cíl:** Zbylých 10 B-příkazů + `log_ui_event` (A) na HTTP; po tomto balíčku zbývají v IPC jen lifecycle (C2/C3 → 3.7–3.8) a nativní C1.

**Vstupy:**
- `ipc-http-parita.csv` řádky `log_ui_event`, `record_bootstrap_diagnostic`, `set/clear_bootstrap_diagnostics_cloud_context`, `app_build_info`, `reset_veslo_state`, `reset_opencode_cache`, `engine_doctor`, `engine_install`, `write/read_obsidian_mirror_file`
- Kód: `packages/app/src/app/lib/bootstrap-diagnostics.ts`, `lib/tauri.ts` (příslušné wrappery), serverová routa `POST /debug-logs` (`server.ts:877` dle CSV), `GET /status`, `GET /capabilities`

**Kroky:**
1. `log_ui_event` → existující `POST /debug-logs`. `app_build_info` → rozšíř `GET /status` o build metadata (verze UI si nese bundle sám).
2. `record_bootstrap_diagnostic` + set/clear cloud context → `POST /diagnostics/bootstrap` (server appenduje do svých logů). Zvaž zjednodušení: po zániku IPC bootstrapu (3.7) většina bootstrap diagnostiky ztrácí smysl — smaž, co nemá konzumenta.
3. `reset_veslo_state`, `reset_opencode_cache` → `POST /maintenance/reset` a `POST /maintenance/reset-opencode-cache` na serveru; restart aplikace po resetu přes `runtime.relaunch` (desktop) / reload (web).
4. `engine_doctor`, `engine_install` → po P4 je engine věcí serveru: `GET /engine/doctor`, `POST /engine/install` (pokud je fáze 2 nezaložila).
5. Obsidian mirror `write/read_obsidian_mirror_file` → `GET/PUT /obsidian-mirror?path=…` na serveru (FS čtení/zápis do vaultu). Cesta míří mimo workspace — viz otevřená otázka trust modelu; `obsidian_is_available` a `open_in_obsidian` zůstávají nativní v `runtime/`.
6. Smaž wrappery + Rust handlery (`commands/misc.rs` části, `bootstrap_diagnostics.rs`, `commands/engine.rs` doctor/install), `cargo check`.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rnE 'invoke(<[^>]*>)?\(' packages/app/src --include="*.ts*" | grep -v "app/runtime/" \
  | grep -v "engine_sse\|veslo_server_info\|engine_\|orchestrator_"    # → 0 (zbývá jen lifecycle pro 3.7–3.8; vzor kryje i generika invoke<T>)
curl -s -X POST -H "Authorization: Bearer $TOKEN" $BASE/debug-logs -d '{"event":"test"}'
# funkční: Settings → debug reset flow; Obsidian mirror zápis (pokud máš vault)
```

**Hotovo znamená:** mimo `runtime/` volá FE `invoke` už jen lifecycle příkazy; 31 B-portů z CSV je kompletně vyřízeno (porty 3.2: 3–4, 3.3: 1, 3.4: 5, 3.5: 11, 3.6: 10, ±škrty ověřené v checklistu).

**Rizika a rollback:** nízké — periferní funkce. Rollback: revert commitu.

**Odhad:** 1 session.

---

## Balíček 3.7 — Škrt 13 lifecycle příkazů (C2) + bootstrap injektáží + rozpuštění `lib/tauri.ts`

**Cíl:** FE přestane řídit životní cyklus procesů (to dělá backend od fáze 2) a přestane bootstrapovat HTTP přes IPC. `lib/tauri.ts` zanikne.

**Vstupy:**
- `ipc-http-parita.csv` kategorie C2: `engine_start/stop/info/restart`, `orchestrator_status`, `orchestrator_start_detached`, `veslo_server_info`, `veslo_server_restart` (+ `opencodeRouter_*` — po fázi 1 už neexistují; `orchestrator_engines_list/workspace_activate/instance_dispose` — po P4/P7 nahrazeny serverovými routami)
- `app-integrace.md` §Klíčový bootstrap tok (IPC `veslo_server_info` → baseUrl+tokeny) a §Rizika (bootstrap řetěz IPC→HTTP jako hlavní zdroj rozbíjení)
- `app-jadro.md` §Polling (~6 souběžných smyček ve `veslo-server-connection.ts`)
- Kód: `packages/app/src/app/context/veslo-server-connection.ts` (1 574 ř.), `packages/app/src/app/lib/tauri.ts`, Rust `commands/veslo_server.rs`, `commands/engine.rs`, `commands/orchestrator.rs`; Rust webview builder (místo pro initialization script — najdi v `packages/desktop/src-tauri/src/` vytváření hlavního okna)

**Kroky:**
1. **Bootstrap injektáží**: Rust při vytváření webview vloží initialization script `window.__VESLO_BOOTSTRAP__ = { serverBaseUrl, token }` (hodnoty, které dnes vrací `veslo_server_info`). Web hostitel je čte z env/same-origin (`pnpm dev:web` už to tak dělá). FE: `veslo-server-connection.ts` čte injektovanou konfiguraci; smaž IPC polling `veslo_server_info` i Tauri event `veslo://server-state` (stav serveru dává fáze 2 přes HTTP/SSE status).
2. Smaž FE volání celé C2 kategorie: engine start/stop/restart/info (backend spouští lazy), orchestrator_status (server status routa), veslo_server_restart (zaniká — recovery = restart aplikace, viz otevřená otázka). Zjednoduš `veslo-server-connection.ts`: cíl ≤ ~400 ř. — jeden zdroj stavu (server status/SSE), žádný z ~6 pollingů.
3. Zbylé živé exporty `lib/tauri.ts` přesuň do `runtime/tauri.ts` (mělo by jít výhradně o C1 nativní). **Smaž `lib/tauri.ts`.** Pozor na skryté HTTP volání v něm (`tauri.ts:1252,1270` — router health; po fázi 1 mrtvé).
4. Odregistruj C2 příkazy v Rustu; Rust si lifecycle správu nechává interně (spawn serveru), jen už ji neexponuje do webview. `cargo check`.
5. Aktualizuj checklist: IPC registr = ≤11 nativních (dle inventury 3.1) + e2e-only.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rnE 'invoke(<[^>]*>)?\(' packages/app/src --include="*.ts*" | grep -v "app/runtime/"   # → 0 (vzor kryje i generika invoke<T>)
grep -rn 'from "@tauri-apps/api/core"' packages/app/src --include="*.ts*" | grep -v "app/runtime/"  # → 0 (ban importu)
# Výpis registrovaných IPC příkazů (blok generate_handler začíná na lib.rs:309; `-c` s `-A` kombinovat nejde):
grep -A120 "generate_handler" packages/desktop/src-tauri/src/lib.rs | grep -cE '^\s+[a-z_:]+,?\s*$'  # ručně: ≤11 + e2e
ls packages/app/src/app/lib/tauri.ts   # → neexistuje
cd packages/desktop && pnpm exec tauri build --debug --no-bundle && cd -
# funkční: studený start desktopu end-to-end (smazat app-data → onboarding → složka → zpráva)
pnpm --filter @neatech/veslo-e2e test:pilot:smoke && pnpm --filter @neatech/veslo-e2e test:pilot:packaged-smoke
```

**Hotovo znamená:** jediné `invoke` v celé app je v `runtime/`; bootstrap nezávisí na IPC pořadí; `veslo-server-connection.ts` ≤ ~400 ř.; studený start funguje opakovaně (min. 3×).

**Rizika a rollback:** **nejrizikovější balíček Bloku A** — bootstrap je historicky hlavní zdroj rozbíjení. Injektáž otestuj i pro packaged build (ne jen dev). Rollback: revert; změnu bootstrapu (krok 1) a škrt C2 (krok 2–4) drž v oddělených commitech.

**Odhad:** 2 sessions.

---

## Balíček 3.8 — Jeden SSE konzument

**Cíl:** Jediný event kanál: serverové SSE s kurzorem (P5), jediný konzument ve FE. Rust SSE most (C3) a duplikovaní konzumenti zanikají.

**Vstupy:**
- `app-integrace.md` §F (duální SSE: Rust proxy vs. SDK subscribe; 2 konzumenti s duplikovaným coalescingem), §Náměty 4
- `app-jadro.md` §Datové cesty transkriptu (SSE live vs. server SQLite; „eventual-reconciliation")
- Kód: `packages/app/src/app/lib/engine-sse.ts` (359 ř.), `packages/app/src/app/context/session-event-stream.ts` (1 704 ř.), `packages/app/src/app/context/global-sdk.tsx` (242 ř., konzument ř. ~93–180), Rust `commands/engine_sse.rs` (+ `engine_sse.rs` modul, 768 ř. dle SYNTEZA), serverový SSE endpoint z fáze 2

**Kroky:**
1. Nový modul `packages/app/src/app/context/event-stream.ts` (≤ ~800 ř.): `EventSource` (případně fetch-stream) na serverový SSE endpoint s `Last-Event-ID` reconnectem. Funguje identicky v Tauri webview i prohlížeči — webview může volat `http://127.0.0.1:PORT` přímo, důvod Rust mostu (vada tauri-plugin-http při držených streamech, `engine-sse.ts:1-11`) odpadá, protože se plugin-http pro SSE nepoužije. Auth dle P8 (cookie/query — EventSource neumí hlavičky).
2. Přenes do něj **jednou** logiku, kterou dnes duplikují `global-sdk.tsx` a `session-event-stream.ts`: coalescing/batch flush, dispatch podle typu eventu. **Nepřenášej** catch-up „eventual-reconciliation" (`session-event-stream.ts:1355-1375`) — kurzor z P5 ji činí zbytečnou; po reconnectu se pokračuje od Last-Event-ID, plný refresh jen při ztrátě kurzoru (server vrátí signál).
3. Přepni konzumenty (session store, sidebar, statusy) na nový modul; smaž `lib/engine-sse.ts`, SSE část `global-sdk.tsx`, `session-event-stream.ts`.
4. Škrtni C3: odregistruj `engine_sse_subscribe/unsubscribe`, smaž Rust `commands/engine_sse.rs` + SSE bridge modul. `cargo check`.
5. Ověř CORS/auth pro origin webview (`tauri://localhost` resp. `http://tauri.localhost` na Windows!) — webview originy jsou v default allowlistu serveru od balíčku 2.8 (krok 1); ověř, že to na HEAD platí.
6. Po přepnutí všech FE konzumentů na stream **smaž deprecated polling `GET /workspace/:id/events`** na serveru (balíček 2.7 ho záměrně ponechal právě do této chvíle) + aktualizuj `openapi.yaml` a regeneruj klienta (společné pravidlo fáze).

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rn "engine-sse\|engine_sse" packages/app/src packages/desktop/src-tauri/src   # → 0
wc -l packages/app/src/app/context/event-stream.ts    # ≤ ~800
# funkční: pošli zprávu → odpověď streamuje živě (desktop i web); zabij server uprostřed streamu, nastartuj → UI se do ~5 s chytí bez ztráty zpráv
pnpm --filter @neatech/veslo-e2e test:pilot:session-render-stability
pnpm --filter @neatech/veslo-e2e test:pilot:session-run-truthfulness
```

**Hotovo znamená:** jediný SSE konzument, jediný transport, reconnect s kurzorem funguje (ověřeno kill-testem), Rust most smazán; deprecated polling `GET /workspace/:id/events` smazán ze serveru; Windows webview streamuje (ověřit na Windows stroji nebo v CI).

**Rizika a rollback:** ztráta eventů = „mrtvé UI" — třída chyb, kterou řešila VSLO-86 série. Kill-test je povinná část ověření. Windows origin (`http://tauri.localhost`) se liší od macOS — otestovat obě. Rollback: revert (starý stream drž funkční až do commitu, který ho maže — tj. nejdřív nový modul + přepnutí, pak mazání ve druhém commitu).

**Odhad:** 2 sessions.

---

## Balíček 3.9 — Konec per-workspace SDK klientů a Proxy stale-guardu

**Cíl:** Všechna request/response komunikace FE jde přes workspace-scoped generovaný klient z fáze 2. OpenCode SDK klient, rekurzivní Proxy stale-guard a ruční `lib/veslo-server/` klient zanikají.

**Vstupy:**
- `app-jadro.md` §Přepínání workspace (Proxy-wrapped SDK klient, `WorkspaceClientStaleError`), `app-integrace.md` §E (užívané SDK metody)
- Kód: `packages/app/src/app/context/workspace-routing.ts` (359 ř.; `new Proxy` na ř. 53–57), `packages/app/src/app/lib/opencode.ts`, `packages/app/src/app/context/server.tsx` (234 ř.), `packages/app/src/app/context/global-sdk.tsx` (zbytek po 3.8), `packages/app/src/app/lib/veslo-server/` (7 souborů) + `lib/veslo-server-domains/` (12 domén), `packages/app/src/app/pages/session-mutation-workflow.ts` (ř. ~894–968 — přímá SDK volání)

**Kroky:**
1. Zmapuj zbylé SDK metody volané z FE (grep `\.session\.\|\.question\.\|\.permission\.\|\.mcp\.\|\.command\.\|\.path\.` + `app-integrace.md` §E): `session.abort/revert/unrevert/shell/command`, `question.list/reply/reject`, `permission.list/reply`, `mcp.*`, `command.list`, `path.get`, `global.health`. Pro každou ověř serverovou cestu z fáze 2 (typovaná routa, nebo workspace-scoped průchod přes generovaný klient). Chybějící routy doplň na serveru (mechanické proxy metody).
2. Přepni volající na generovaný klient. Klient je **workspace-scoped** (workspaceId v URL, ne globální „aktivní klient") — tím mizí důvod Proxy stale-guardu: smaž `workspace-routing.ts` Proxy i `WorkspaceClientStaleError` handling (grep `workspace_registry_unsynced`, `WorkspaceClientStaleError`).
3. Smaž tvorbu SDK klienta: `lib/opencode.ts` (zbytek), `context/server.tsx`, `context/global-sdk.tsx` (zbytek). Health-check 10 s polling ze `server.tsx` nahraď stavem ze serverového SSE/status (P5).
4. Dokonči náhradu ručního klienta `lib/veslo-server/` + `lib/veslo-server-domains/` generovaným klientem (fáze 2 ho zavedla — tady se maže poslední ruční zbytek, včetně `types.ts` 1 992 ř. ručních typů).
5. `@opencode-ai/sdk` v tuto chvíli zbývá v `packages/app` **jen jako zdroj typů** — importy typů nech na balíček 3.10/3.11.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rn "createOpencodeClient\|WorkspaceClientStaleError\|workspace_registry_unsynced" packages/app/src  # → 0
ls packages/app/src/app/lib/veslo-server 2>/dev/null   # → neexistuje
grep -rn "from \"@opencode-ai/sdk" packages/app/src --include="*.ts*" | grep -v "import type" | wc -l  # → 0 (zbývají jen type importy)
# funkční: abort běžící odpovědi, revert, permission/question reply, MCP list — desktop i web
pnpm --filter @neatech/veslo-e2e test
```

**Hotovo znamená:** jediný HTTP klient (generovaný, workspace-scoped); Proxy guard a ruční klient smazány; abort/revert/permission flows fungují.

**Rizika a rollback:** stale-guard chránil před zápisem do enginu špatného workspace — jeho odstranění je bezpečné **jen** díky workspace-scoped URL adresaci; při review ověř, že žádné volání nebere workspaceId z globálního signálu v async pozici. Rollback: revert commitu.

**Odhad:** 1–2 sessions.

---

## Balíček 3.10 — Anti-corruption I: Veslo doménové typy + mapování na hranici (render stack)

**Cíl:** Vlastní typy `VesloSession`, `VesloConversationMessage`, `VesloPart`, `VesloEvent` a jediné místo mapování z tvarů enginu. Render stack transkriptu (nejhustší vazba) přepnut na Veslo typy.

**Vstupy:**
- `app-integrace.md` §Vazba na OpenCode (SDK typy jako de facto doménový model, ~40 souborů), SYNTEZA §3 (cena upgradu koncentrovaná v SDK typech)
- `app-komponenty.md` §Vazba na OpenCode (render pipeline: 13 souborů; `lib/opencode-part-access.ts` jako částečná izolace)
- Kód: `packages/app/src/app/components/part-view.tsx` (963 ř.), `components/session/message-list.tsx` (2 134 ř.) + modelové soubory (`message-editability.ts`, `pending-submit-model.ts`, `timeline-detail-model.ts`, `progress-grouping-model.ts`), `packages/app/src/app/lib/opencode-part-access.ts`, `context/event-stream.ts` (z 3.8), transcript čtení v `context/conversation-service.ts`

**Kroky:**
1. Založ `packages/app/src/app/domain/` s Veslo typy. Vyjdi z toho, co UI reálně renderuje (8 part typů, ~24 event typů — viz `opencode-vazba.md`), ne z celého SDK povrchu. Pokud fáze 2 vygenerovala typy z OpenAPI serveru, **odvoď Veslo typy z nich** (server už transcript vlastní) a v `domain/` nech jen UI nadstavby; rozhodnutí zapiš do checklistu.
2. Napiš mapper `domain/from-engine.ts`: SDK `Event/Message/Part/Session` → Veslo typy. Jediné povolené místo importu SDK typů (dočasně, do 3.11 i pro ostatní).
3. Zapoj mapper na obě hranice: `event-stream.ts` (SSE eventy) a transcript read (`conversation-service.ts`). Od hranice dál tečou jen Veslo typy.
4. Přepni render stack: `part-view.tsx`, `message-list.tsx` + modelové soubory, `lib/opencode-part-access.ts` (přejmenuj na `domain/part-access.ts`). Komponenty nesmí importovat nic z `@opencode-ai/sdk`.
5. Testy render stacku přepiš na Veslo typy (fixtures přemapuj mechanicky).

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rln "@opencode-ai/sdk" packages/app/src/app/components --include="*.ts*"   # → 0
# funkční: transkript se všemi part typy (text, tool call, reasoning, file, …) vypadá stejně jako před změnou — porovnej screenshoty
pnpm --filter @neatech/veslo-e2e test:pilot:session-render-stability
pnpm --filter @neatech/veslo-e2e test:pilot:visual-regression
```

**Hotovo znamená:** komponenty bez SDK importů; mapování na 2 hranicích; vizuální parita transkriptu.

**Rizika a rollback:** tiché rozdíly v tvarech (optional pole, union varianty) se projeví až za běhu — visual-regression scénář je povinný. Rollback: revert; mapper je aditivní, přepnutí render stacku drž v samostatném commitu.

**Odhad:** 2 sessions.

---

## Balíček 3.11 — Anti-corruption II: zbytek SDK importů + import-ban lint

**Cíl:** 0 importů `@opencode-ai/sdk` v `packages/app`, vynuceno lintem; závislost odstraněna z package.json.

**Vstupy:**
- Aktuální stav po 3.10: `grep -rln "@opencode-ai/sdk" packages/app/src --include="*.ts*" | grep -v tests` (na HEAD 43 souborů; po 3.9–3.10 výrazně méně)
- Kód: root `eslint.config.mjs` (lint běží přes `pnpm lint` = `eslint packages/app/src`), `packages/app/package.json`

**Kroky:**
1. Zbylé soubory s SDK importy přepni na `domain/` typy (po 3.9 jde už jen o type importy ve stores/utils — mechanická práce s mapperem z 3.10).
2. Přidej do `eslint.config.mjs` pravidlo `no-restricted-imports` pro `@opencode-ai/sdk*` v `packages/app/src/**` s výjimkou `app/domain/from-engine.ts` — a naplánuj i zánik té výjimky: pokud po 3.9 mluví FE jen se serverem, mapper může mapovat ze serverových (OpenAPI) typů a SDK import zmizí úplně → pak smaž `@opencode-ai/sdk` z `packages/app/package.json`.
3. Smaž mrtvé re-exporty SDK typů (grep `export type.*from "@opencode-ai`).

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint    # lint musí selhat, když zkusíš testovací import SDK mimo výjimku
grep -rn "@opencode-ai/sdk" packages/app/src --include="*.ts*" | grep -v "domain/from-engine" | grep -v tests  # → 0
grep -n "opencode-ai" packages/app/package.json   # ideálně 0
pnpm --filter @neatech/veslo-e2e test
```

**Hotovo znamená:** import-ban aktivní a ověřený; UI je engine-agnostické (výměna enginu = nový mapper + serverová práce).

**Rizika a rollback:** nízké. Rollback: revert.

**Odhad:** 1 session.

---

## Balíček 3.12 — Identita session = `conversationId`

**Cíl:** Jediný identifikátor konverzace v UI: `(workspaceId, conversationId)`. Konec 3 jmenných prostorů a multi-kandidátních lookupů.

**Vstupy:**
- `app-jadro.md` §Identita session (3 id prostory; `ws:`/`ws2:` klíče; route key ze 4 částí), `dokumentace.md` §3 třída C (cross-workspace únik přes raw session.id — High severity)
- Kód: `packages/app/src/app/lib/session-identity.ts` (44 ř.), `packages/app/src/app/lib/ui-conversation-scope.ts` (153 ř.), `context/session-route-sync.ts` + `controllers/session-route-controller.ts` (route identity key `sessionId::workspaceId::conversationId::opencodeSessionId`), `context/sidebar-workspace-sessions.ts`, runtime mapy statusů/busy (grep `opencodeSessionId`)
- Předpoklad: server (fáze 2) exponuje `conversationId` jako primární id v read modelu, transkriptech i SSE eventech; `opencodeSessionId` je interní detail serveru

**Kroky:**
1. Ověř předpoklad na API: transcript, conversation list a SSE eventy nesou `conversationId` (+ `workspaceId`). Pokud některý event nese jen `opencodeSessionId`, doplň mapování **na serveru** (server mapping vlastní), ne ve FE.
2. Překlopuj klíče map: statusy, busy, todos, archiv, sidebar items → `workspaceId:conversationId`. Smaž multi-kandidátní lookupy (`session-identity.ts` — celý soubor), `ws:`/`ws2:` kompozitní klíče (`ui-conversation-scope.ts` zjednoduš nebo smaž).
3. Route: `/session/:workspaceId/:conversationId`; zjednoduš `session-route-sync.ts` + `session-route-controller.ts` (4dílný klíč → 2dílný). Čistý start = žádná kompatibilita starých URL.
4. Sidebar a select-session cesty přepni na nový klíč; smaž fallbacky na raw `sessionId` (pozůstatky fixů 02/03/54/55).
5. Projdi grep `opencodeSessionId` — ve FE smí zbýt jen v mapperu (pokud ho server ještě posílá jako doplňkové pole).

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rn "opencodeSessionId" packages/app/src --include="*.ts*" | grep -v "domain/" | grep -v tests  # → 0
ls packages/app/src/app/lib/session-identity.ts 2>/dev/null   # → neexistuje
# funkční KRITICKÉ: 2 workspace se session stejného původu — přepínej mezi nimi, odpovědi se nesmí prolít; archivace v A nesmí schovat řádek v B
pnpm --filter @neatech/veslo-e2e test
```

**Hotovo znamená:** jeden identifikátor všude; cross-workspace scénář (2 workspace současně, přepínání, souběžné běhy) ručně ověřen; mrtvé id-mapování smazáno.

**Rizika a rollback:** dotýká se routingu, sidebaru i statusů najednou — největší plocha Bloku B. Dělej po vrstvách (mapy → route → sidebar), každou vrstvu commitni zvlášť. Rollback: revert po vrstvách.

**Odhad:** 2 sessions.

---

## Balíček 3.13 — E2E na standardní Playwright proti prohlížeči

**Cíl:** Gate scénáře běží standardním Playwrightem proti prohlížeči (rychlé, stabilní, CI-friendly). Desktop smoke zůstává malý na tauri-pilot.

**Vstupy:**
- `ostatni-balicky.md` §7 (e2e přechod na Playwright po splitu), SYNTEZA §5.4
- Kód: `packages/e2e/pilot-scenarios/` (80 TOML; gate suite `rebuild-gate` z balíčku 0.9, skript `test:e2e:gate` — ověř aktuální název suite v `pilot-runner.ts`; NEPLÉST s širší, nestabilizovanou suite `current-gate` z doby před fází 0), `packages/e2e/specs/*.playwright.spec.ts` (Playwright už je v balíčku zaveden — den-admin-billing specy), `scripts/dev-headless-web.ts` (`pnpm dev:web`), `.github/workflows/` (gate z fáze 0)

**Kroky:**
1. Vyber gate scénáře (fáze 0 jich vybrala ~10–15 do suite `rebuild-gate`, balíček 0.9 — portuj TUTO stabilizovanou množinu, ne starou `current-gate`): onboarding, přidání složky, session + zpráva + živá odpověď, transkript po restartu, skills install/uninstall, MCP přidání, přepnutí workspace, abort, archivace. Portuj je do `packages/e2e/specs/*.playwright.spec.ts` proti prohlížeči.
2. Setup: Playwright `webServer` spouští `pnpm dev:web` (headless veslo-server + UI). Workspace zakládej **přes API** (`POST /workspaces/local` s cestou do temp adresáře) — folder picker se v prohlížeči neklikají. AI odpovědi: použij mock/fixture cestu, pokud ji fáze 0/2 zavedla; jinak označ scénáře se živou inferencí jako samostatnou `live` suite mimo gate.
3. Desktop smoke ponech malý (tauri-pilot): start, bootstrap injektáž, folder picker, updater povrch, okno. Zbylé pilot scénáře, které pokrývá Playwright, označ za deprecated a smaž z gate (TOML nech smazat až v 3.19).
4. Přepni CI gate na: Playwright suite (povinná) + desktop smoke (povinná) + typecheck/lint. **Změnu required checků v branch protection provede Pavel** (admin krok — stejný postup jako v balíčcích 0.7/0.9: checklist, `gh api`, ověření reálně blokovaným PR); bez jeho zásahu balíček nelze dokončit — naplánuj s ním předem (viz Otevřené otázky).
5. E-kategorie IPC příkazů (5× e2e-only kill/position) — s odchodem scénářů z tauri-pilot smaž ty, které už žádný pilot scénář nepoužívá.

**Ověření:**
```bash
cd git && pnpm --filter @neatech/veslo-e2e exec playwright test    # gate suite zelená, < ~10 min
pnpm --filter @neatech/veslo-e2e test:pilot:smoke                  # desktop smoke zelený
# CI: PR s úmyslně rozbitým flow (např. zakomentovaný submit) musí zčervenat
```

**Hotovo znamená:** gate v CI = Playwright (prohlížeč) + malý desktop smoke; červený test blokuje merge; doba běhu gate ≤ ~10 min.

**Rizika a rollback:** flaky testy = ztráta důvěry v gate — každý scénář musí projít 5× po sobě, jinak ho stabilizuj nebo vyřaď. Rollback: gate lze dočasně vrátit na pilot suite (nechávej ji funkční až do 3.19).

**Odhad:** 2 sessions.

---

## Balíček 3.14 — Redukce `isTauriRuntime` na modulovou hranici

**Cíl:** Runtime větvení desktop/web existuje jen uvnitř `app/runtime/`; zbytek aplikace se ptá na schopnosti (`runtime.capabilities`), ne na platformu.

**Vstupy:**
- `app-integrace.md` §Hotspot 6, `doplneni.md` Mezera 3 (347 produkčních větví / 471 výskytů; po Bloku A většina mrtvá)
- Kód: grep `isTauriRuntime` v `packages/app/src` (na HEAD: 353 výskytů v 59 produkčních souborech), `packages/app/src/app/context/platform.tsx`, `packages/app/src/index.tsx` (volba routeru HashRouter/Router — legitimní zbytková větev)

**Kroky:**
1. Grep všech výskytů; roztřiď: (a) mrtvé po Bloku A (transport větve) → smaž, (b) nativní schopnost → nahraď dotazem na `runtime.capabilities`/přesunem do `runtime/`, (c) legitimně zbytkové (volba routeru v `index.tsx`, CSS titlebar) → přesuň do `runtime/` modulu jako exportovanou konstantu.
2. Slouč s existující `Platform` abstrakcí (`context/platform.tsx`, `index.tsx` Platform objekt) — jedna vrstva, ne dvě; `CLOUD_ONLY_MODE` větve (39×) zredukuj stejně.
3. Přidej lint pravidlo: import `isTauriRuntime` povolen jen v `app/runtime/**`.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rn "isTauriRuntime" packages/app/src --include="*.ts*" | grep -v "app/runtime/" | grep -v tests | wc -l  # → 0
pnpm --filter @neatech/veslo-e2e exec playwright test && pnpm --filter @neatech/veslo-e2e test:pilot:smoke
```

**Hotovo znamená:** platformní větvení jen v `runtime/`; lint to vynucuje; oba hostitelé fungují.

**Rizika a rollback:** větev může skrývat funkční rozdíl, ne jen transport — u každé smazané větve ověř, že web cesta je skutečně ekvivalentní (ne jen „nespadne"). Rollback: revert.

**Odhad:** 1 session.

---

## Balíček 3.15 — Dekompozice I: provider strom + workspace doména + úklid guardů

**Cíl:** `App()` přestává být ruční drátovna ~30 továren: vznikne strom skutečných Solid providerů. Workspace doména jde první; guard moduly, které po P7 (server-owned aktivace) ztratily smysl, se mažou.

**Vstupy:**
- `app-jadro.md` §App() jako kompoziční kořen (cykly, 7 late-bound slotů, TDZ pasti; `createWorkspaceStore` ~50 options / ~80 návratových hodnot) a §Přepínání workspace (guard mašinerie)
- `docs/prestavba/analyza/frontend-memory.md` (timing pasti SolidJS — čti před začátkem, ale ber jako historický kontext, ne aktuální mapu)
- Kód: `packages/app/src/app/app.tsx` (5 339 ř.), `packages/app/src/app/lib/late-bound.ts`, `context/workspace.ts` (1 805 ř.), `context/workspace-activation-controller.ts` (verzovaný guard + allowlist 13 origin stringů, ř. 11–25), `context/select-session-guard.ts`, `context/runtime-owner.ts`, `context/workspace-lifecycle-state.ts`, `context/workspace-activation-local.ts`

**Kroky:**
1. Zaveď vzor: doménový kontext = Solid `createContext` + provider komponenta + `useX()` hook. Založ `WorkspaceProvider` (nad `createWorkspaceStore`) a `ConnectionProvider` (nad zjednodušenou server connection z 3.7). Provider čte závislosti z nadřazených kontextů — žádné options objekty s 50 callbacky.
2. Zjednoduš aktivaci workspace na tvar po fázi 2: `POST /workspaces/:id/activate` + potvrzení přes SSE. Pak smaž: `workspace-activation-controller.ts` (verzovaný guard, overlay-suppression tokeny, origin allowlist), `workspace-lifecycle-state.ts` (paralelní stavový model), `runtime-owner.ts` (rozhodování „kdo vlastní runtime" — vlastní ho server). `select-session-guard.ts` nech na 3.16. **Guard maž až poté, co zmizela příčina** — u každého ověř v komentářích/gitu, proti čemu chránil, a že to po fázi 2 nemůže nastat; nejasné případy nech a zapiš do checklistu.
3. Zruš late-bound sloty (`lib/late-bound.ts`) navázané na workspace doménu; cykly workspace↔session řeš tak, že sdílený stav (např. aktivní conversationId) žije v kontextu výš, ne vzájemným voláním.
4. `workspace.ts` (1 805 ř.) rozpadni na `context/workspace/` moduly ≤ ~800 ř. (store, config, aktivace, busy state — švy podle pod-továren popsaných v `app-jadro.md`).
5. `app.tsx` po tomto balíčku: workspace/connection sekce nahrazeny `<WorkspaceProvider>` — očekávaný pokles o ~1 000–1 500 ř.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -rn "createLateBound" packages/app/src | wc -l    # klesá; workspace sloty 0
wc -l packages/app/src/app/app.tsx packages/app/src/app/context/workspace/*.ts
pnpm --filter @neatech/veslo-e2e exec playwright test   # KRITICKÉ: scénář přepnutí workspace + rychlé přepnutí A→B→A
pnpm --filter @neatech/veslo-e2e test:pilot:smoke
```

**Hotovo znamená:** WorkspaceProvider + ConnectionProvider existují; jmenované guard moduly smazány (nebo zdůvodněně ponechány v checklistu); žádný dotčený soubor > ~800 ř.; přepínání workspace stabilní v E2E i ručně (min. 10 rychlých přepnutí).

**Rizika a rollback:** **nejrizikovější balíček fáze** — mění timing inicializace (boot je implicitní kontrakt, viz `app-jadro.md` §Rizika). Postupuj po jednom provideru na commit; po každém commitu spusť E2E. Rollback: revert posledního provideru, ne celého balíčku.

**Odhad:** 3–4 sessions (provider strom + rozpad `workspace.ts` + mazání guardů v timing-nejcitlivější doméně; při přetečení dělit po commitových švech z Kroků).

---

## Balíček 3.16 — Dekompozice II: SessionView na kontexty (konec `SessionViewProps`)

**Cíl:** Session doména jako `SessionProvider`; `SessionView` čte z kontextu — `SessionViewProps` (180 polí) zaniká, session část `app-view-props.ts` se maže.

**Vstupy:**
- `app-komponenty.md` §Architektura (prop bagy; `SessionViewProps` 180 props na `pages/session.tsx:343`; `app-view-props.ts` 2 046 ř., scope 311 polí) a §Rizika (dvojí pravda prop/kontext časově ohraničit)
- Kód: `packages/app/src/app/app-view-props.ts`, `packages/app/src/app/pages/session.tsx` (definice props), `context/session.ts` (1 168 ř.), `context/conversation-service.ts` (1 792 ř.), `pages/session-send-workflow.ts` (2 348 ř.), `context/session-selection-controller.ts`, `context/select-session-guard.ts`

**Kroky:**
1. Založ `SessionProvider` (session store + event stream z 3.8 + conversation service + send workflow) uvnitř `WorkspaceProvider`. Workflow soubory z `pages/` (`session-send-workflow.ts`, `session-conversation-flow.ts`) přesuň do `context/session/` nebo `services/` — jsou UI-free (viz `app-komponenty.md` námět 6).
2. `SessionView` a jeho přímé děti (composer, message-list, sidebars) přepni na `useSession()`/`useWorkspace()`. Props nech jen pro čistě prezentační listové komponenty (`ComposerProps` ~34 polí je v pořádku).
3. Smaž `SessionViewProps` a session část `app-view-props.ts`. Dvojí pravda (prop i kontext) nesmí přežít balíček.
4. Smaž `select-session-guard.ts` (verzovaný dedup kliknutí) — po jednom zdroji pravdy a scoped identitě (3.12) ověř, že rychlé přepínání session nedělá race; pokud dělá, příčina je jinde — zapiš a neřeš guardem.
5. Zasažené soubory > ~800 ř. rozpadni (`conversation-service.ts`, `session-send-workflow.ts` — švy: send path / lifecycle / transcript read).

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
grep -n "SessionViewProps" packages/app/src -r | wc -l    # → 0
wc -l packages/app/src/app/app-view-props.ts              # výrazně menší (zbývá dashboard/settings část)
pnpm --filter @neatech/veslo-e2e exec playwright test     # scénáře: session select, send, abort, rychlé přepnutí sessions
```

**Hotovo znamená:** SessionView bez prop bagu; send/select/abort fungují; žádný dotčený soubor > ~800 ř.

**Rizika a rollback:** timing efektů při výběru session (historicky „app appears frozen"). E2E scénář rychlého přepínání je povinný. Rollback: revert po commitech (provider → přepnutí view → mazání props).

**Odhad:** 2–3 sessions.

---

## Balíček 3.17 — Dekompozice III: Dashboard/Settings na kontexty + smazání `app-view-props.ts`

**Cíl:** `DashboardViewProps` (258 polí) a `SettingsViewProps` (95) nahrazeny kontexty; `app-view-props.ts` smazán; `app.tsx` ≤ ~800 ř.

**Vstupy:**
- `app-komponenty.md` (dashboard jako dispečer 7 tabů; `pages/dashboard.tsx` 1 446 ř., `pages/settings.tsx` 2 398 ř., `pages/skills.tsx` 3 273 ř.)
- Kód: `packages/app/src/app/app-view-props.ts` (zbytek), `pages/dashboard.tsx`, `pages/settings.tsx`, `pages/skills.tsx`, `app.tsx` (zbytek — modály, view switch)

**Kroky:**
1. Dashboard taby čtou přímo doménové kontexty (`useExtensions()` z 3.3, `useWorkspace()`, `useSettings()` — nový malý provider pro nastavení). Dashboard.tsx přestává být přeposílač props.
2. Smaž `DashboardViewProps`, `SettingsViewProps`, `SkillsViewProps` a **celý `app-view-props.ts`**.
3. Modály v `app.tsx` (reset, confirm, feedback, MCP auth, create-workspace) vytáhni do `components/modals/` s vlastním malým kontextem (modal registry), ať `App()` je jen provider strom + view switch.
4. `pages/settings.tsx` (2 398) a `pages/skills.tsx` (3 273) rozpadni na pod-taby/sekce ≤ ~800 ř. (settings: 4 pod-taby už existují logicky; skills: grid/detail/review/install — švy viz `app-komponenty.md`).
5. Slouč `pages/extensions.tsx` (78 ř. kosmetický obal) s `pages/mcp.tsx`.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
ls packages/app/src/app/app-view-props.ts 2>/dev/null   # → neexistuje
wc -l packages/app/src/app/app.tsx                       # ≤ ~800
pnpm --filter @neatech/veslo-e2e exec playwright test    # scénáře: skills, MCP, settings průchody
```

**Hotovo znamená:** žádný view prop bag; `app.tsx` ≤ ~800 ř.; všech 7 dashboard tabů funkčních.

**Rizika a rollback:** plošná, ale mechanická práce; největší riziko je zapomenutý drát (prop, který nikdo nepřevzal do kontextu) — typecheck to většinou chytí, E2E dorazí zbytek. Rollback: revert po commitech (tab po tabu).

**Odhad:** 3 sessions (~9 000 ř. napříč 4 soubory + smazání `app-view-props.ts` včetně údržby testů).

---

## Balíček 3.18 — Dekompozice IV: rozřezání `session.tsx`

**Cíl:** `pages/session.tsx` (5 012 ř., 43 signálů, 37 efektů) rozpadnut na moduly ≤ ~800 ř.

**Vstupy:**
- `app-komponenty.md` §Hotspot 2 (session.tsx míchá layout, modály, klávesové zkratky, search, sidebar resize, folder-access consent, skill confirmation)
- Kód: `packages/app/src/app/pages/session.tsx`, `pages/session-left-sidebar.tsx`, `pages/session-right-sidebar.tsx`, `pages/session-center.tsx`, `pages/session-search-command-controller.ts` (700 ř.), `pages/session-transcript-viewport.ts` (711 ř.)

**Kroky:**
1. Vytáhni z `session.tsx` po švech (každý šev = samostatný commit): (a) modály (rename/delete) → `components/modals/`, (b) search + command palette → vlastní modul s vlastním stavem, (c) sidebar resize → malý hook, (d) folder-access consent a implicit-skill confirmation → samostatné komponenty, (e) klávesové zkratky → hook.
2. Zbylý `session.tsx` = layout + kompozice ≤ ~800 ř.
3. Stav vytahovaných celků ber z kontextů (3.16), ne novými props.
4. Sidebar seznam sessions (`components/session/workspace-session-list.tsx`, 2 990 ř. + 6 satelitů): **nezjednodušuj funkčně** (feature freeze) — pouze pokud ho tento balíček musí otevřít kvůli kontextům, rozděl mechanicky pod ~800 ř.; jinak nech a zapiš do poznámek pro budoucí fázi.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
wc -l packages/app/src/app/pages/session*.tsx packages/app/src/app/pages/session*.ts | sort -rn | head  # nic > ~800 z dotčených
pnpm --filter @neatech/veslo-e2e exec playwright test
pnpm --filter @neatech/veslo-e2e test:pilot:session-render-stability
```

**Hotovo znamená:** session.tsx ≤ ~800 ř.; chat flow (send, search, resize, consent, zkratky) beze změny chování.

**Rizika a rollback:** hustota efektů — vytahuj po jednom celku na commit, E2E po každém. Rollback: revert posledního celku.

**Odhad:** 2–3 sessions.

---

## Balíček 3.19 — Závěrečná kontrola fáze, metriky, aktualizace dokumentace

**Cíl:** Ověřený milník fáze, smazané přechodné lešení, aktualizovaná dokumentace kontraktu.

**Vstupy:** checklist `docs/prestavba/plan/faze-3-checklist.md`, celý repozitář, `ARCHITECTURE.md`, `AGENTS.md`

**Kroky:**
1. Projdi milník bod po bodu (sekce výše) a každý ověř příkazem; výsledky zapiš do checklistu.
2. Smaž přechodné lešení: deprecated pilot TOML scénáře nahrazené Playwrightem, mrtvé guard moduly odložené „na později" (rozhodni: smazat / ponechat se zdůvodněním), zbylé `__veslo*` diagnostické globals bez konzumenta.
3. Metriky do checklistu: počet IPC příkazů v `generate_handler`, počet `invoke` volání mimo runtime/ (regex s generiky: `grep -rnE 'invoke(<[^>]*>)?\(' … | grep -v app/runtime/`) + počet importů `@tauri-apps/api/core` mimo runtime/, počet souborů > 800 ř. v `packages/app/src` (dotčené fází = 0), počet SDK importů (0), doba běhu gate.
4. Aktualizuj `ARCHITECTURE.md` (FE↔BE kontrakt: HTTP+SSE, runtime adapter, 11 nativních schopností) a `AGENTS.md` (E2E = Playwright + malý desktop smoke). Zastaralé pasáže maž, nepřepisuj opatrně kolem nich.
5. Připrav souhrn pro Pavla: co je hotové, co zůstalo v poznámkách (funkční zjednodušení odložená kvůli feature freeze), doporučení pro případnou další fázi.

**Ověření:**
```bash
cd git && pnpm typecheck && pnpm lint
pnpm --filter @neatech/veslo-e2e exec playwright test && pnpm --filter @neatech/veslo-e2e test:pilot:smoke
cd packages/desktop && pnpm exec tauri build --debug --no-bundle    # desktop build prochází
# ruční průchod všech 4 povinných flow na macOS i Windows
```

**Hotovo znamená:** všechny body milníku splněny a doloženy; dokumentace odpovídá kódu; Pavel má podklad pro schválení push/release.

**Rizika a rollback:** žádné významné — kontrolní balíček.

**Odhad:** 1 session.

---

## Souhrn rizik fáze

1. **Závislost na dokončenosti fáze 2** — balíčky 3.7–3.9, 3.12 a 3.15 stojí na server SSE s kurzorem, generovaném klientovi, server-owned aktivaci a auth modelu. Pokud cokoli z P4–P8 není hotové, fáze 3 se v daném místě zastaví; nikdy nestav FE workaround kolem chybějícího backendu. (Ex-P9, provider routing, vlastní balíček 3.4 — není vstupní podmínkou.)
2. **Přechodné období dvou cest (IPC i HTTP)** musí být krátké a řízené — proto doménové balíčky mažou IPC větev okamžitě po přepnutí (ne „až nakonec") a checklist z 3.1 je jediná evidence stavu.
3. **Timing regresí při dekompozici (Blok D)** — boot pořadí v `App()` je implicitní kontrakt; SolidJS efekty mají křehké pořadí. Mitigace: Playwright gate hotová před Blokem D (3.13), jeden provider/celek na commit, E2E po každém commitu.
4. **Testová betonáž** — desítky tisíc řádků unit testů vázaných na staré tvary (options objekty továren, prop bagy, regexy zdrojáku). Mitigace: schválená politika mazání source-contract testů; odhady balíčků už s údržbou testů počítají, přesto je to největší zdroj nejistoty odhadů.
5. **Windows parita** — SSE origin (`http://tauri.localhost`), cesty ve FS routách serveru, WSL větve. Každý balíček Bloku A ověřit i na Windows (stroj nebo CI); bez toho nelze fázi uzavřít (Win+Mac je tvrdý požadavek).
6. **Odstraňování guardů** — každý guard vznikl jako oprava reálného race. Mazat smí jen balíček, který odstranil příčinu (server-owned stav, scoped identita); nejasné případy ponechat a zapsat, ne mazat „protože překáží".
7. **Ztráta eventů po sjednocení SSE** — kill-test reconnectu je povinná součást 3.8; bez Last-Event-ID sémantiky na serveru (P5) balíček nezačínat.
8. **Rozsah fáze** (19 balíčků) — největší fáze plánu; průběžně funkční aplikace po každém balíčku je jediná ochrana proti „rozdělané přestavbě". Nikdy nezačínat další balíček s rozbitým předchozím.

## Otevřené otázky

1. **Remote workspaces** (`workspace_create_remote/update_remote`): ZADANI říká remote neřešit — potvrdí Pavel, že se škrtají úplně (pokud je fáze 1 už nevyřadila)? (balíček 3.2)
2. **Trust model pro FS cesty mimo workspace** (Obsidian vault, `workspace_add_authorized_root`): stačí serverová routa s explicitní cestou, nebo má zůstat nativní omezení? Vazba na auth model fáze 2. (balíčky 3.2, 3.6)
3. **SSE auth v prohlížeči**: EventSource neumí hlavičky — cookie, nebo query token? Musí být rozhodnuto ve fázi 2 (P8); pokud není, rozhodnout před 3.8.
4. **Domov Veslo doménových typů**: `packages/app/src/app/domain/` vs. sdílený contract balíček odvozený z OpenAPI serveru — závisí na tom, jak fáze 2 postavila generovaný klient. (balíček 3.10)
5. **`veslo_server_restart` bez náhrady**: je přijatelné, že recovery při zamrzlém serveru = restart celé aplikace (žádné tlačítko „restartovat server")? (balíček 3.7)
6. **Úložiště draftů a preferencí**: plán volí server store (funguje shodně desktop/web); alternativa localStorage je levnější, ale nepřežije čistku prohlížeče. Potvrdit default. (balíček 3.5)
7. **Sidebar seznam sessions (~4 740 ř. v 7 souborech)**: funkční zjednodušení (plochý seznam) je za hranou feature freeze — odloženo; potvrdit, že zůstává jen mechanické dělení souborů. (balíček 3.18)
8. **Živá inference v E2E**: gate poběží na mock/fixture odpovědích (rychlost, stabilita) a `live` suite zůstane mimo gate — potvrdit, případně ověřit, co z toho připravila fáze 0/2. (balíček 3.13)
9. **Přepnutí required checků na Playwright gate** (balíček 3.13, krok 4): změna branch protection vyžaduje admin zásah Pavla (stejně jako v 0.7/0.9) — naplánovat s ním před startem balíčku.
