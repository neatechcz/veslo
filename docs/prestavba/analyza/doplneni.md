# Doplnění analýzy — odpovědi na mezery od kritika

## Mezera 4: Skutečný stav rozhodnutí „nahradit OpenCode Codexem" (audit 2026-06-22)

### Co audit říká (docs/plans/2026-06-22-opencode-to-codex-replacement-audit.md, 745 řádků)

- **Statut dokumentu:** „analysis / feasibility (history doc, not yet a committed plan)" — hned na řádku 3. Sám sebe tedy neoznačuje za závazný plán.
- **Zapsané rozhodnutí (2026-06-22):** Option B — **full replace**. OpenCode se odstraní end-to-end, jediným enginem se stane forkovaný Codex (`codex app-server`, JSON-RPC přes stdio). Povinná součást: managed AI access — Codex na zařízení zákazníka mluví výhradně s Veslo Responses gateway (OpenRouter-primary, OpenAI-direct fast-path), žádné provider klíče na zařízení.
- **Vznik:** commit `b010ff4d` „opencode2 codex transition prototype plan" (2026-06-22, +576 řádků), tentýž den rozšířen commitem `f53d7220` (+172 řádků — realism review §11 a optimalizovaný exekuční plán §12).
- **Odhady pracnosti:** dokument **neobsahuje žádné číselné odhady** (člověkodny/týdny). Pracnost je jen kvalitativní: největší náklady = (1) přestavba skills ekosystému (opkg/registry/lockfile/hub), (2) překladač eventů a částí zpráv (~24 SSE event typů, 8 part typů → Codex `item.*`/`turn.*`), (3) net-new search/LSP (server žádné nemá), (4) Responses gateway. Kritická cesta: spike G0 → Veslo-owned typy (A1) + `engineKind` hranice (A2) → Codex adaptér + translator → sidecar swap → cutover, s branami G0–G4.
- Audit explicitně varuje (§0), aby se **existující `codex_oauth` plumbing nezaměňoval za runtime swap** — to je jen výměna model-providera uvnitř OpenCode.

### Co se stalo v kódu po 22. 6. — NIC z auditu se neimplementovalo

Ověřeno na HEAD k 2026-07-19:

1. **A1 (Veslo-owned engine typy):** neprovedeno. `packages/app` stále závisí na `@opencode-ai/sdk: 1.17.13` (`packages/app/package.json:61`) a importuje jej v **61 souborech** (`grep -rln "@opencode-ai/sdk" packages/app/src | wc -l` → 61). Audit uváděl ~40 souborů, dokument z 4. 7. naměřil 57, dnes 61 — **vazba na OpenCode od auditu rostla, ne klesala.**
2. **A2 (`engineKind = opencode | codex`):** neprovedeno. Jediný `engineKind` v kódu je `packages/orchestrator/src/opencode-proxy-target.ts:20` s hodnotami `"pooled" | "shared"` — topologie OpenCode enginů, s výměnou enginu nesouvisí.
3. **Codex adaptér:** neexistuje žádný z navržených souborů (`codex-engine.ts`, `codex-thread-pool.ts`, `codex-event-bridge.ts`, `responses-proxy.ts`). `find packages -name "*codex*"` najde jen 3 E2E specy pro admin codex-oauth flow (gateway credentials).
4. **Responses gateway (`/ai-gateway/v1/responses`):** neexistuje. Jediné „responses" v ai-gateway je `CODEX_RESPONSES_PATH = "/backend-api/codex/responses"` v `services/ai-gateway/src/providers/codex-oauth-inference-proxy-transport.ts:11` — to je codex_oauth provider proxy, tedy přesně ta věc, kterou audit v §0 označuje za „NOT a runtime swap".
5. **Ani Phase 0 z navazujícího dokumentu (import-ban lint na `@opencode-ai/sdk` v app):** v `eslint.config.mjs` žádné omezení na „opencode" není.

### Šev `engineSessionId` — živý, ale jen kosmetický

- Není to mrtvá příprava: `engineSessionId` je reálně nosné pojmenování v celé konverzační vrstvě serveru — `packages/server/src/conversation-binding-store.ts` (typy ř. 13/28, DB sloupec `engine_session_id`), `conversation-service.ts` (~60 výskytů), `conversation-run-lifecycle-controller.ts`, `conversation-transcript-store.ts`, `orchestrator-lifecycle-client.ts`, `routes/conversations.ts` + orchestrator (`run-store.ts`, `run-registry.ts`, `run-activity-probe.ts`).
- **Ale abstrakce je jen jménem:** `const ENGINE = "opencode" as const` (`conversation-binding-store.ts:71`), řetězec `"opencode"` je dokonce zapečený do hashe identity bindingu (ř. 229). Alias `opencodeSessionId` se v netestových zdrojích serveru vyskytuje **184×** a `conversation-service.ts` jej mapuje obousměrně (např. ř. 376, 561, 670). Schéma má sloupec `engine`, ale nikdy se do něj nezapsala jiná hodnota než „opencode". Je to tedy přejmenování, ne funkční šev — druhý engine by vyžadoval reálnou práci na celé vrstvě.

### Git historie po 22. 6. — všechny „Codex" commity jsou provider vrstva, ne engine

`git log --oneline --since=2026-06-22 -i --grep='codex' --grep='engine' --grep='replace'` → ~47 commitů, rozpad:

- **Gateway/credential práce (codex_oauth, backend):** capability probes (`1d256695`, `34aaae73`, `f6989e0b`), model policy migrace (`e75c6dd8`, `0b6b1b2d`), upgrade backend Codex runtime na 0.144.1 (`ce1cfe5e`), default GPT-5.6 Sol (`7e464296`) + design docs (`42fb90b7`, `7319f592`). `@openai/codex` 0.144.x je závislost **jen** v `services/ai-gateway/package.json:21` a `services/den/package.json:17` — čistě backend inference proxy.
- **„engine" commity = provoz OpenCode enginu:** `1dd4c0ef` (SSE ENGINE), `6a0bb4f1` (RELOAD OPENCODE ENGINE WHEN SOUL UPDATES), `58c8f735` (shared engines), `f53d7220` (VSLO-244 opencode engine not running fix).
- **Nula commitů** implementujících jakýkoli workstream auditu.

### Navazující dokumenty — rozhodnutí bylo fakticky změkčeno

- Na audit nenavazuje žádný implementační plán. Navazuje **`docs/plans/2026-07-04-engine-portable-architecture-final.md`** (221 řádků, status „proposal"), který rozhodnutí „full replace" de facto **degraduje**: navrhuje `EngineAdapter` rozhraní, volbu enginu per-workspace a Codex adaptér odsouvá do „**Phase 4 — optional, when wanted**".
- Tento dokument změřil vazbu: 57 app souborů importuje SDK (nejhlubší vrstva), 25 server souborů zapisuje `.opencode/`, binding store hardcoduje engine konstantu, server má 0 SDK importů.
- Klíčový odstavec „Cost honesty" (ř. 215–221): dominantní náklad = odpojení app od SDK + re-materializace workspace stavu — **obojí je nutné při jakékoli strategii** (adapter i rip-and-replace) a „Phases 0–3 are worth doing even if the Codex switch never happens".
- `2026-07-10-gpt-5-6-sol-managed-codex-migration*` = migrace modelu v gateway (provider vrstva), s výměnou runtime nesouvisí.

### Závěr pro rozhodnutí zjednodušit/rozdělit/přepsat

1. **Výměna enginu neprobíhá.** „Rozhodnutí" z 22. 6. existuje jen na papíře; o 12 dní později bylo staženo na „Codex-ready, možná někdy". Od té doby (červenec) jde veškerá engine práce do stabilizace OpenCode (stale runs, transcript projection, SSE recovery — viz záplava červencových plánů) a do Codex-credential provozu v gateway.
2. **Riziko vyhozené investice je asymetrické:** práce na OpenCode-specifických vrstvách (SDK typy v UI, `.opencode/` writery, opkg pipeline) by při případné výměně propadla; naopak práce, kterou oba dokumenty označují za nutnou v každém scénáři — Veslo-owned event/part schéma v app, serverový transcript store jako kanonický read model, `.opencode/` jako build output — se **kryje s tím, co by vyžadovalo i oddělení BE/FE (API + SPA)**. To je průnik „no-regret" kroků.
3. **Praktický signál:** tým 4 týdny po „rozhodnutí" nezvládl ani nejlevnější krok (lint zakazující nové SDK importy) a vazba na OpenCode dál roste (40→57→61 souborů). Plánovat zjednodušení s předpokladem „engine se stejně vymění" by bylo stavění na neexistující trajektorii; realistický předpoklad je „OpenCode zůstává, ale hranice se má zavést tak, aby byla engine-neutrální".

## Mezera 2: Je anomalyco/opencode patchovaný fork, nebo čistý upstream sst/opencode?

**Verdikt: Není to fork vůbec. `anomalyco/opencode` JE upstream — jde o tentýž repozitář, který byl na GitHubu přejmenován/převeden z organizace `sst` na `anomalyco`. Veslo žádný engine fork neudržuje; stahuje oficiální upstream binárku a pouze ji přejmenovává na `veslo-code`.**

### Důkaz 1: GitHub redirect — identický repozitář

```
curl -sI https://github.com/sst/opencode
  → HTTP/2 301, location: https://github.com/anomalyco/opencode

curl -sI https://api.github.com/repos/sst/opencode
  → HTTP/2 301, location: https://api.github.com/repositories/975734319
```

GitHub interní ID repozitáře `975734319` je totožné pro obě jména — je to jeden a tentýž repozitář (rename/transfer), nikoli kopie. Metadata `anomalyco/opencode`:

- `fork: false`, `parent: null`, `source: null` (není GitHub fork ničeho)
- `created_at: 2025-04-30` (původní datum založení sst/opencode)
- `stargazers_count: 187 438` — hvězdy se při transferu zachovávají; toto je „ten slavný" opencode
- Releases publikuje `opencode-agent[bot]` — oficiální release bot projektu (v1.17.13 vydán 2026-07-01, release notes odpovídají oficiálnímu changelogu)

Rozpor mezi reporty je tedy vyřešen: report „opencode-vazba" má pravdu (není fork ani vendorovaný kód), report „orchestrator" se mýlil — tvrzení o „forkované binárce" pravděpodobně vzniklo z neznámého jména `anomalyco` + přejmenování binárky na `veslo-code`.

### Důkaz 2: prepare-sidecar.mjs — download beze změn, jen rename

Soubor `packages/desktop/scripts/prepare-sidecar.mjs`:

- ř. 61–73: `opencodeGithubRepo` = `"anomalyco/opencode"` (přepsatelné env `OPENCODE_GITHUB_REPO`)
- ř. 947–948: download URL = `https://github.com/anomalyco/opencode/releases/download/v${verze}/${asset}` (oficiální release assets: `opencode-darwin-arm64.zip` atd., ř. 935–941)
- ř. 1024–1045: binárka se po extrakci pouze `copyFileSync` + `chmod 755` zkopíruje jako `veslo-code` — **žádné patchování, žádná rekompilace**
- ř. 1050–1051 (komentář v kódu): *„The engine binary is named veslo-code but verifies itself via `which opencode`"* — vytvářejí se symlinky `opencode` → `veslo-code`, protože jde o stock binárku, která sama sebe hledá pod původním jménem
- `git log -S "sst/opencode" -- prepare-sidecar.mjs` nevrací nic — skript od začátku (commit `471ff359`, „feat: window sidecar #205") mířil na `anomalyco/opencode`

Pinovaná verze: `packages/desktop/package.json` ř. 5: `"opencodeVersion": "1.17.13"`. SDK balíčky jsou verzně svázané: `packages/orchestrator/package.json` ř. 52–53 (`@opencode-ai/plugin` a `@opencode-ai/sdk` = 1.17.13), `packages/app/package.json` ř. 61 (sdk 1.17.13); prepare-sidecar (ř. 686–689) shodu verze pluginu s enginem přímo vynucuje.

V repu Vesla není žádný vendorovaný zdroják enginu: žádný `.gitmodules`, `find -iname "*opencode*" -type d` najde jen `.opencode/` (konfigurace/skills pro engine), `packages/opencode-router` (vlastní konektor Vesla) a `packages/e2e/.tmp-opencode-home` (test fixture).

### Důsledek pro variantu „zůstat na OpenCode a upgradovat"

- **Cena upgradu je nižší, než tvrdil orchestrator report**: nejde o rebase forku, ale o zvednutí čísla verze (`opencodeVersion` + verze `@opencode-ai/*` balíčků) a otestování. Žádné vlastní patche enginu se neudržují.
- **Supply-chain**: zdroj je oficiální upstream repo, ALE stažený archiv se **neověřuje proti pinovanému checksumu** (ř. 994–999: prostý `curl -fsSL` z pinovaného tagu; sha256 se počítá až pro výstupní manifest, ne pro verifikaci downloadu). Bundlovaný Node archiv checksum verifikaci má (`verifyBundledNodeArchiveChecksum`, ř. 763–768), engine nikoliv — drobný, snadno opravitelný nedostatek.
- **Skutečné riziko není fork, ale drift**: Veslo pinuje 1.17.13 (2026-07-01), upstream je na v1.18.3 (2026-07-16) — **11 releasů pozadu za ~3 týdny**. Upstream releasuje v průměru každých ~1,5 dne (15 releasů mezi v1.17.10 24. 6. a v1.18.3 16. 7.).

### Kvantifikace rizika přímých čtení opencode.db

Veslo čte SQLite databázi enginu přímo (mimo API):

- `packages/desktop/src-tauri/src/commands/session_reader.rs` ř. 130, 162, 177, 204, 233 — `SELECT` nad tabulkami `session`, `message`, `part` (příkazy `opencode_db_read_sessions`, `opencode_db_read_transcript`)
- `packages/desktop/src-tauri/src/commands/misc.rs` ř. 899–917 — další přímé `SELECT ... FROM session/message/part`
- UI vrstva: `packages/app/src/app/lib/db-reader.ts` (invoke Tauri commandů, parsuje JSON sloupec `data`)

Tempo změn schématu v upstreamu (adresář `packages/core/src/database/migration/` v anomalyco/opencode):

- **38 migračních souborů od 2026-01-27 do 2026-06-22** (~5 měsíců) → průměr **~7,6 migrace měsíčně**
- Přes GitHub API: **23 commitů dotýkajících se migračního adresáře jen mezi 31. 5. a 22. 6. 2026** (~1 commit/den v tomto období; starší migrace žily před refaktorem jinde, API rename nesleduje)
- Z 38 migrací se **~15 týká přímo tabulek session/message**, které Veslo čte: mj. `session_message_cursor`, `session_usage`, `session-metadata`, `session_message_projection_indexes`, `session_message_projection_order`, `session_input_inbox`, `event_sourced_session_input`, `add_session_context_snapshot`, `add_session_path`, `add_session_workspace_id`, `reset_v2_session_state`, `simplify_session_input`, `simplify_session_context_epoch`
- Názvy jako `event_sourced_session_input` a `reset_v2_session_state` naznačují, že upstream aktivně **přestavuje storage model sessions** (event sourcing, projekce) — přímé SQL dotazy Vesla na `session/message/part` jsou tedy při každém upgradu enginu ohrožené

### Shrnutí

| Otázka | Odpověď |
|---|---|
| Je anomalyco fork? | Ne — je to upstream po přejmenování (GitHub ID 975734319, 301 redirect z sst/opencode) |
| Nese vlastní patche? | Ne — Veslo stahuje oficiální release asset a jen ho přejmenovává |
| Udržuje Veslo engine fork? | Ne. Vazba je: pinovaná verze binárky + verzně svázané `@opencode-ai/*` npm balíčky + přímé SQL na opencode.db |
| Cena varianty „zůstat a upgradovat" | Nízká na straně binárky (změna čísla verze), **vysoká na straně přímých DB čtení** (~7,6 schéma-migrace/měsíc v upstreamu, ~40 % se týká čtených tabulek) |
| Supply-chain riziko | Nízké (oficiální repo), ale download není checksum-pinovaný |

## Mezera 1: Přesný inventář IPC↔HTTP parity (96 Tauri příkazů vs. 178 HTTP rout)

Úplná tabulka po jednotlivých příkazech: **`ipc-http-parita.csv`** (vedle tohoto souboru; 96 řádků, kategorie A/B/C1/C2/C3/E).

### Sladění rozcházejících se čísel

| Číslo z reportů | Co ve skutečnosti měří | Ověřeno |
|---|---|---|
| 94 | jen holé `#[tauri::command]` — grep nezachytí 2× `#[tauri::command(rename_all = "camelCase")]` v `bootstrap_diagnostics.rs:13,28` | `grep -rE '#\[tauri::command'` → **96** |
| 96 | příkazy registrované v `generate_handler!` (`packages/desktop/src-tauri/src/lib.rs:309–413`) | přesně **96**, z toho **5** za `#[cfg(all(debug_assertions, feature = "e2e"))]` → **91 v produkčním buildu** |
| 83 | řádky s `invoke` v `packages/app/src/app/lib/tauri.ts` (1467 ř.; obsahuje 1 duplicitní volání `opencodeRouter_status`) | `grep -c invoke` = 83 |
| ~85/~88 | distinct příkazy volané z `packages/app` přes literální string | **88** + 2 přes konstanty v `lib/den-auth.ts:12–13` (`den_auth_snapshot_read/write`) = **90 z 91** produkčních příkazů FE skutečně používá |

Mimo `tauri.ts` volají `invoke` už jen `lib/engine-sse.ts` a `lib/bootstrap-diagnostics.ts` (+ den-auth.ts přes konstanty). Jediný produkční příkaz, který nevolá nikdo: **`opencodeRouter_config_set`** (`commands/opencode_router.rs:485`) — mrtvý kód.

### HTTP strana: 178 rout je potvrzených

`addRoute(routes, "METODA", "/cesta", …)` v `packages/server/src/server.ts` (createRoutes od ř. 4127) + `packages/server/src/routes/*.ts` (22 souborů) = **178 unikátních rout** (žádné duplicity). Největší: skill-registry 17, conversations 16, soul 15, file-sessions 15, workspace-management 13, opencode-router 13. Navíc mimo `addRoute`: `POST /debug-logs` (server.ts:877), proxy mounty `/opencode`, `/opencode-router` a `/workspace/:id/opencode/*`.

### Výsledná klasifikace 96 příkazů

| Kategorie | Počet | Co to znamená pro BE/FE split |
|---|---|---|
| **A — HTTP ekvivalent už existuje** | **34** | FE jen přepne z `invoke()` na `fetch()`; server routa existuje (celé skills CRUD, commands CRUD, scheduler, workspace registry, export/import, provisioning, log). U 2 z nich (`opencode_db_read_sessions/transcript`) je ekvivalent přes conversations/transcript API, ne 1:1 SQLite read. |
| **B — snadno přenositelné** | **31** | Čistá FS/SQLite/exec logika bez nativních API (access proofy, drafty, preference, diagnostika, Obsidian mirror soubory, resety, DB migrace, den-auth snapshot). Nutno napsat ~15–20 nových malých rout — mechanická práce. |
| **C2 — lifecycle sidecárů** | **13** | `engine_*` (4), `orchestrator_status/start_detached` (2), `veslo_server_*` (2), `opencodeRouter_*` (5). Ve splitu **z FE mizí** — spouštění procesů je z definice úloha backendu; orchestrator daemon už dnes engine lazy-spawnuje a `orchestrator_workspace_activate` je v Rustu **jen HTTP klient na daemon** (`orchestrator.rs:698`). |
| **C3 — IPC↔SSE most** | **2** | `engine_sse_subscribe/unsubscribe` — existuje jen proto, že webview neumí přímý SSE s auth; web FE použije `EventSource` na `GET /workspace/:id/events` → **zaniká**. |
| **C1 — nutně nativní** | **11** | updater (3), WSL repair (2), Obsidian detekce/otevření (2), clipboard file-paths (1), window decorations (1), sandbox env (1), grant folder access (1). Jediné, co opravdu vyžaduje desktop shell. |
| **E — jen e2e/debug build** | **5** | kill/fail-injection + posun okna; v produkci neexistují. |

### Důsledek pro nacenění splitu

1. **Skóre parity je vyšší, než tvrdily reporty:** 34 z 91 produkčních příkazů (37 %) má routu už dnes, dalších 31 (34 %) je mechanický port. Dohromady **71 % povrchu je web-ready nebo triviálně portovatelné**.
2. **15 příkazů (C2+C3) se neportuje, ale škrtá** — jsou to artefakty toho, že FE dnes řídí životní cyklus vlastního backendu. To je zároveň hlavní zdroj křehkosti (spawn/health/retry logika ve 3 vrstvách: Rust manager, orchestrator daemon, server).
3. **Skutečně nativní zbytek je 11 příkazů** (12 % produkčního povrchu), z toho updater+WSL+Obsidian+clipboard jsou postradatelné nebo volitelné féry — minimální desktop shell (nebo čistý prohlížeč bez nich) je realistický.
4. Pozor na skrytou položku mimo IPC: FE dnes dostává engine události přes Tauri event `veslo://engine-event` z polleru (`lib.rs:422`, `spawn_engine_event_poller`) — i ten se ve splitu nahrazuje SSE, je to stejná kategorie jako C3.

## Mezera 6: Ověřený feature inventář a důkazně mrtvý kód

Ověřeno na stroji (2026-07-19) přímo v kořeni repozitáře: běh knip (repo má vlastní `knip.jsonc` + skript `audit:knip` v root `package.json:48`), grep importů pro každého jmenovaného kandidáta, kontrola enable flagů, LOC mapa funkcí.

### 6.1 Verdikt nad jmenovanými kandidáty

| Kandidát | Verdikt | Důkaz |
|---|---|---|
| `packages/app/src/app/context/sync.tsx` (34 LOC) | **MRTVÉ** | 0 importérů (grep `context/sync` napříč app = jen soubor sám); potvrzeno knipem v „Unused files" |
| `GlobalSyncProvider` (`context/global-sync.tsx`, 310 LOC) | **ŽIVÉ — reporty se mýlí** | importováno v `entry.tsx:3` (obaluje celou app, ř. 39–43) a `app.tsx:301` (`useGlobalSync`) |
| `components/session/inbox-panel.tsx` (295 LOC) | **MRTVÉ** | 0 importérů; potvrzeno knipem. Paradox: serverová inbox capability je default zapnutá (`routes/file-sessions.ts:101–105`: prázdné `VESLO_INBOX_ENABLED` → `true`) — capability bez UI |
| „agentlab" | **jen legacy vrstva, ne modul** | žádný adresář/stránka agentlab neexistuje; zbývá migrace `automation-store.ts:49–230` (`readLegacyAgentLabStore`, čte `.opencode/veslo/agentlab/automations.json`) + legacy REST aliasy `/workspace/:id/agentlab/automations` v `routes/automations.ts:233–397`, každý označen `@internal: toy-ui only, no production UI callers` |
| `packages/server/src/toy-ui.ts` (1 812 LOC) | **živé, dev-only — a default ZAPNUTÉ** | `server.ts:3047–3051`: `resolveToyUiEnabled()` vrací `true`, když `VESLO_TOY_UI` není nastaveno. Servírováno přes `routes/health.ts:267–288` (`/ui`, `/ui/assets/toy.css`, `/ui/assets/toy.js`) |
| `packages/openwork` | **prázdná skořápka** | jediný soubor `docs/style-guide.md`; žádný kód ani `package.json` |
| `services/den-worker-runtime` | **prázdná skořápka** | jediný soubor `README.md` (5 řádků); žádný kód |
| Router identity UI (`pages/identities.tsx`, 1 494 LOC) | **MRTVÉ** | 0 produkčních importérů; jediná reference je `tests/pages/identities-contract.test.ts:5`, který soubor čte jako **surový text** přes `readFileSync` — proto ho knip nehlásí (testy jsou v `knip.jsonc` entry). Klientská doména `lib/veslo-server-domains/messaging-identities.ts` (315 LOC): identity metody exportované z `lib/veslo-server/client.ts:528–569` (`telegramIdentities`, `upsertTelegramIdentity`, …) nemají žádného ne-testového konzumenta. Z routeru v UI reálně žije jen status/restart/stop v `pages/settings.tsx:562–612` |
| Embedded automations/delegate plugin | **hard-disabled na OBOU stranách** | TS: `internal-system.ts:515–516` — `automationsPluginEnabled(): boolean { return false; }`. Rust: `internal_provision.rs:198–203` — `automations_plugin_enabled_from_env()` vrací `false` bez ohledu na argumenty; test `internal_provision.rs:1036–1045` ověřuje, že i `"1"`, `"true"`, `"yes"`, `"on"` zůstává disabled. Embedded zdroják pluginu (~395 řádků v každém souboru: TS ř. 519–913, Rust ř. 209–~604) se **nikdy nezapíše** — místo toho běží aktivní karanténa (`disableAutomationsPlugin` / `disable_automations_plugin`: rename na `.disabled` do `veslo/disabled-plugins/`). Nekonzistence navíc: TS manifest stále deklaruje `plugins: [DELEGATE_PLUGIN_FILE]` (`internal-system.ts:1190`), zatímco delegate plugin se jinde pouze maže (`removeManagedLegacyDelegatePlugin`, ř. 465–475) — manifest odkazuje na artefakt, který se nikdy nevytváří |

### 6.2 Výstup knip — 19 nepoužívaných souborů, 2 312 LOC

Běh: `./node_modules/.bin/knip --no-progress --files --max-show-issues 200 --no-exit-code`

| Soubor | LOC |
|---|---|
| `packages/app/src/app/components/session/context-panel.tsx` | 394 |
| `packages/server/src/reload-watcher.ts` | 392 |
| `packages/app/src/app/components/windows-sandbox-repair.tsx` | 298 |
| `packages/app/src/app/components/session/inbox-panel.tsx` | 295 |
| `packages/app/src/app/components/reload-workspace-toast.tsx` | 150 |
| `services/ai-gateway/src/typecheck/repository-contracts.ts` | 143 |
| `packages/app/src/app/lib/model-picker-options.ts` | 129 |
| `packages/app/src/app/components/session/minimap.tsx` | 127 |
| `packages/e2e/helpers/feedback-server.ts` | 98 |
| `packages/app/src/app/components/thinking-block.tsx` | 76 |
| `packages/app/src/app/components/language-picker-modal.tsx` | 64 |
| `packages/app/src/app/lib/safe-run.ts` | 62 |
| `packages/app/src/app/context/sync.tsx` | 34 |
| `packages/app/src/app/components/card.tsx` | 21 |
| `packages/server/src/paths.ts` | 20 |
| `packages/app/src/i18n/locales/index.ts` | 6 |
| `packages/app/src/app/state/{extensions,sessions,system}.ts` | 3 |
| **Celkem** | **2 312** |

Důležitá výhrada: knip má testy jako entry points, takže **podhlašuje** — mrtvý produkční kód držený při životě jen testem nevidí (případ `identities.tsx`).

### 6.3 Mrtvé/spící mimo dosah knipu

| Položka | LOC | Poznámka |
|---|---|---|
| `pages/identities.tsx` | 1 494 | drží jen raw-text contract test |
| `pages/proto-v1-ux.tsx` + `pages/proto-workspaces.tsx` | 676 + 451 | view `proto` dosažitelné **jen ručním zadáním URL** `/proto*` (`app-route-sync.ts:82–83`, `controllers/app-startup-controller.ts:61–75`); žádný UI prvek tam nenaviguje |
| Embedded automations plugin (TS + Rust) | ~790 | 2× ~395 řádků nikdy nezapisovaného zdrojáku (viz 6.1) |
| `messaging-identities.ts` doména + mrtvé metody v `client.ts` | ~350 | jediný konzument (identities.tsx) je mrtvý |
| `packages/openwork`, `services/den-worker-runtime` | 0 kódu | smazat adresáře |
| **Součet okamžitě smazatelného** | **~6 700–7 000 LOC** | knip 2 312 + výše uvedené |

K tomu `toy-ui.ts` (1 812 LOC) — funkční, ale dev nástroj; minimálně přepnout default na vypnuto, ideálně vyčlenit (a s ním legacy agentlab aliasy).

### 6.4 Feature inventář: user-facing funkce → kód → LOC

**Routing `app.tsx:5150–5182` — 4 pohledy** (`Switch/Match` na `currentView()`):

| View | Kód | LOC | Klasifikace |
|---|---|---|---|
| `session` | `pages/session.tsx` + session-* moduly | 5 012 (jen session.tsx) | **must-keep** (běh agentů) |
| `dashboard` (default) | `pages/dashboard.tsx` | 1 446 | **must-keep** (shell) |
| `onboarding` | `pages/onboarding.tsx` | 830 | must-keep (vstup, auth) |
| `proto` | `proto-v1-ux.tsx`, `proto-workspaces.tsx` | 1 127 | **mrtvé** (jen ruční URL) |

**Dashboard taby — 7 (`types.ts:369–377`: `scheduled | soul | skills | plugins | mcp | config | settings`):**

| Tab | Kód | LOC | Klasifikace |
|---|---|---|---|
| `skills` | `pages/skills.tsx` | 3 273 | **must-keep** |
| `settings` | `pages/settings.tsx` | 2 398 | must-keep |
| `scheduled` | `pages/scheduled.tsx` | 1 206 | volitelné (automations; klientský OpenCode plugin k nim je hard-disabled) |
| `soul` | `pages/soul.tsx` | 926 | volitelné |
| `mcp` | `pages/mcp.tsx` + `extensions.tsx` | 702 + 78 | **must-keep** |
| `config` | `pages/config.tsx` | 455 | volitelné (jen `developerMode`, `dashboard.tsx:1177`) |
| `plugins` | `pages/plugins.tsx` | 453 | volitelné |

**Serverové routy (`packages/server/src/routes/`, 22 souborů, 10 865 LOC):**

| Skupina | LOC | Klasifikace |
|---|---|---|
| `conversations.ts` | 1 675 | **must-keep** (sessions/zprávy) |
| `opencode-router.ts` | 1 567 | volitelné (Telegram/Slack/WhatsApp) |
| `file-sessions.ts` | 982 | **must-keep** |
| skills celkem (`skill-materialization` 956, `skill-removals` 481, `skill-registry` 376, `workspace-skills` 311, `user-global-skills` 255, `skill-enabled` 93, `skill-imports` 82) | 2 554 | **must-keep** |
| `soul.ts` | 749 | volitelné |
| `automations.ts` + `scheduler.ts` | 655 + 64 | volitelné |
| `plugins.ts` | 592 | volitelné |
| `workspace-management.ts` | 511 | **must-keep** |
| `document-runtime.ts` | 439 | volitelné (táhne balíček document-runtime, 3 109 LOC) |
| `mcp.ts` | 379 | **must-keep** |
| `health.ts` | 313 | must-keep (minus toy-ui část) |
| `commands.ts` | 128 | must-keep (malé) |
| `ai-gateway.ts`, `session-archives.ts`, `admin.ts` | 109 + 84 + 64 | volitelné (cloud) |

Must-keep jádro rout ≈ **6,5 k z 10,9 k LOC** (60 %). Routy jsou ale jen fasáda — `server.ts` sám má 4 883 LOC, produkční server celkem 46 458 LOC.

**LOC podle balíčků a služeb** (ts/tsx/rs/js, bez node_modules/target/dist):

| Balíček | LOC | Poznámka |
|---|---|---|
| `packages/app` | 227 309 src = 135 542 produkce + **91 767 testů (40 %)** | |
| `packages/server` | 93 788 src = 46 458 produkce + **47 330 testů (50 %)** | |
| `packages/desktop` | 33 530 (z toho Rust 28 590) | |
| `packages/orchestrator` | 21 629 | |
| `packages/e2e` | 18 393 | |
| `packages/opencode-router` | 7 746 | volitelné |
| `packages/web` | 4 503 | Next.js — account/auth stránky (forgot/reset-password, verify-email, terms) |
| `packages/document-runtime` | 3 109 | volitelné |
| `packages/landing` | 1 791 | Next.js — marketing (druhý Next.js web vedle `web`!) |
| `packages/docs`, `packages/openwork` | 0 kódu | mdx docs / prázdné |
| `services/den` | 68 646 | cloud identity/auth |
| `services/ai-gateway` | 48 096 | cloud AI proxy |
| `services/openwork-share` | 1 182 | volitelné |
| `services/worker-manager` | 831 | volitelné |
| `services/den-worker-runtime` | 0 kódu | smazat |

### 6.5 Dopad na rozhodnutí (b) „části vyhodit"

1. **Okamžitě smazatelné bez rizika:** ~6,7–7 k LOC produkce (knip seznam + identities.tsx + proto stránky + embedded plugin zdrojáky + 2 prázdné adresáře) + příslušné testy (např. `identities-contract.test.ts`).
2. **Vypnutelné/vyčlenitelné:** toy-ui 1 812 (+ legacy agentlab aliasy), opencode-router 7 746 + routa 1 567 + identity klient, document-runtime 3 109 + routa 439, soul 926 + 749, automations UI 1 206 + routy 719.
3. **Must-keep jádro (workspace/agenti/skills/MCP) je menšina kódu:** v UI ~12 k z 16,8 k LOC stránek, na serveru ~60 % rout; celková produkce app+server (135 k + 46 k) je ale řádově větší, než co jádro potřebuje — váha je v session/transcript orchestraci, sync vrstvách a dvojím provisioningu (TS `internal-system.ts` 1 243 LOC ↔ Rust `internal_provision.rs` 1 243 LOC — identická délka, ručně zrcadlené, včetně 2× ~395 řádků mrtvého embedded pluginu).
4. **Cloud vrstva** (den 68,6 k + ai-gateway 48,1 k + web 4,5 k + worker-manager 0,8 k + openwork-share 1,2 k ≈ **123 k LOC**) není pro lokální must-keep funkce potřeba — kromě přihlášení, pokud má zůstat vázané na Den.
5. **Testy tvoří 40–50 % LOC** app i serveru — každé vyhození produkčního kódu má ~dvojnásobný efekt na celkový objem údržby.

## Mezera 5: Co reálně gate-uje CI a jaká je skutečná regresní síť

### Krátká odpověď

**Nic negate-uje nic.** Branch protection je vypnutá na `main` i `dev` (`gh api repos/neatechcz/veslo/branches/{main,dev}` → `"protected": false`, rulesets prázdné `[]`). Všechny workflows jsou tedy pouze informativní — a navíc jsou **červené**: `Quality` (jediný workflow běžící na aktivní větvi `main`) nemá v celé své historii ani jeden úspěšný běh (25 zaznamenaných běhů: 21 failure, 4 cancelled, 0 success; poslední běh 2026-07-19, run 29692126140 — **všech 5 jobů failed**). Sada `current-gate` (25 Pilot scénářů) se v CI **nikdy nespustila** — všech 12 zaznamenaných běhů `E2E UI Tests` selhalo, poslední (run 28186068496) na všech 3 OS už v kroku „Prepare sidecars", tedy před spuštěním jediného testu. Release workflows neobsahují žádný testovací krok. Tvrzení kritika „grep current-gate v .github/workflows nic nenašel" je technicky správné — název suite žije v `packages/e2e/package.json:12` (`"test": "…pilot-runner.ts --suite current-gate"`), na který se workflow odkazuje řetězem `pnpm test:e2e:ui` → root `package.json:37` → e2e `test`.

### Co na papíře běží na PR/push (a jaká je realita)

| Workflow | Trigger | Obsah | Realita (gh run list, 2026-07-19) |
|---|---|---|---|
| `ci.yml` („CI") | push/PR na **dev** | build web + den + orchestrator binárka, typecheck orchestrátoru, `--version/--help` smoke | poslední běh success (06-25); dev je ale od 06-25 mrtvá větev |
| `ci-tests.yml` („Veslo Tests") | push/PR na **dev** | `pnpm --filter @neatech/veslo-ui test:e2e` = unit testy + 4 headless Node skripty proti reálnému `opencode serve` (`packages/app/package.json:43`) — **žádné Tauri, žádné UI** | poslední success **2026-05-23**, od té doby vše failure |
| `e2e-ui.yml` („E2E UI Tests") | push/PR na **dev** | Tauri debug build s `--features e2e` + `tauri-pilot-cli 0.7.2` + **current-gate suite (25 scénářů)** na ubuntu/macos/windows | **12/12 běhů failure**, běhy trvají 1–4 min → umírají v setupu („Prepare sidecars"); scénáře nikdy neproběhly |
| `quality.yml` („Quality") | push/PR na **main+dev** (přidán ~07-15) | Static (lint+types+architecture), Unit, Services (Windows), Rust (Windows), Desktop recovery (1 scénář `vslo-235-local-host-child-exit`), aggregate Gate | **0 úspěchů v historii**; poslední run: všech 5 jobů failure; Unit padá na reálné assertion failures |
| `prerelease.yml`, `release-macos-aarch64.yml`, `build-desktop.yml`, `build-staging-app.yml` | release/dispatch | build + signing + notarizace | **žádný test/pilot krok** (grep „pilot|test:|check:" → 0 zásahů) — release se balí bez jakékoli automatické verifikace |

Klíčová asymetrie: vývoj se přesunul na `main` (přímé pushe 07-18/07-19, `dev` naposledy 06-25; PR se prakticky nepoužívají — celkem 11 PR za život repa, poslední merge 07-04). Na `main` ale běží **jen** `quality.yml` — tzn. tři „CI" workflows s testy jsou navěšené na opuštěnou větev.

Dokument `docs/dev/engineering-quality-gates.md:88-92` sám přiznává: administrátoři musí required check `Quality / Gate` nastavit zvlášť a „Do not claim branch protection is enabled solely because the workflow exists." Nastaveno to nikdy nebylo.

### Rozpad 80 Pilot scénářů (packages/e2e/pilot-scenarios/*.toml)

Mechanismus výběru: suite jsou hardcodované v `packages/e2e/helpers/pilot-runner.ts:77-111` (`PILOT_SCENARIO_SUITES`): `current-gate` = 25 scénářů, `live-inference` = 1, `live-inference-lifecycle` = 1. Kontraktní test `packages/e2e/helpers/pilot-selection-contract.test.ts:63` počet 80 TOML zamyká (`assert.equal(scenarios.length, 80)`).

- **26 scénářů referencuje CI**: 25× current-gate (e2e-ui.yml) + 1× `vslo-235-local-host-child-exit` (`check:desktop-recovery`, root `package.json:27`, job Quality/Desktop recovery). Ani jeden z 25 current-gate se ale v CI reálně nikdy nespustil (viz výše); desktop-recovery job je také červený.
- **14 scénářů jen v ručních skriptech** (`test:pilot:*` v `packages/e2e/package.json`): packaged-smoke, folder-access-consent, global-managed-ai-model-policy, soul-dashboard, soul-den-local, google-mcp-connectors, sharepoint-mcp-connectors, session-render-stability, session-run-truthfulness, feedback-youtrack-live, live-admin-codex-roundtrip, den-managed-openai-anthropic, message-send-registry-degraded, runtime-cold-start-session-handoff.
- **40 scénářů nespouští nic** — jediná reference je fixture `helpers/__fixtures__/pilot-selection-contract.v1.json` (statická charakterizace výběrové logiky, žádná exekuce). Mj.: automations, boot-freeze, session-queue-durability, multi-workspace-restart, všech 5 vslo-171/270/271 recovery scénářů kromě child-exit, gpt-5-6-sol-three-message-roundtrip (jeho `specs/*.test.ts` jen staticky kontroluje obsah TOML regexem, nespouští ho).
- Původní tvrzení „~53 se nikdy nespouští" je tedy zhruba správné ve slabší formě (40 zcela osiřelých + 14 pouze ručních = 54 mimo CI), ale silnější pravda je horší: **i těch 25+1 „CI" scénářů má v CI 0 provedených běhů.**

Interní audit `docs/testing/findings/2026-07-16-tauri-pilot-dev-runtime-parity-audit.md` to potvrzuje a přidává: current-gate má **0 průnik** s 11 live-auth scénáři (ř. 41), 22 z 25 current-gate scénářů mutuje localStorage sdílené jedné instance aplikace → výsledky závisí na pořadí (ř. 74-76), a gate běží nad syntetickým `@example.test` účtem, takže nic netvrdí o reálném přihlášeném flow.

### Lokální ověření (HEAD `main` = 71215b07, 2026-07-19)

- **Kontraktní testy e2e harness**: `node --import=tsx/esm --test helpers/*.test.ts` → **67/67 pass, 0,9 s**. Výběrová mašinerie je zdravá — jen se nikde nepoužívá.
- **Unit gate reprodukován červený**: `pnpm --filter @neatech/veslo-ui test:unit` → **348/374 pass, 14 fail, 4,5 s** — včetně stejného testu jako v CI („lifecycle recovery traces are mirrored into the enabled dev-runtime send trace"). Červená Quality tedy není infra flake, je to reálně rozbitý kód na `main`, přes který se dál pushuje.
- **Plný lokální běh current-gate neproveden — a je to samo o sobě nález**: vyžaduje `cargo install tauri-pilot-cli` (nainstalováno, OK), ale dále rebuild debug binárky (lokální `target/debug/veslo` je z **26. 5.**, 2 měsíce za kódem) + `prepare:sidecar` (přesně krok, na kterém umírá CI) + 25 sekvenčních bootů aplikace; navíc na stroji běžela uživatelova živá instance Vesla (veslo-server :54883, opencode :54886) a pravidlo single-tenant desktop testování zakazuje souběh. Prakticky: **suite je tak drahá a křehká, že neproběhla ani v CI, ani ji nelze bezpečně spustit vedle běžící aplikace** — což je přesný popis nulové regresní sítě.

### Skutečný kontrakt, který se musí přenést do nové architektury

1. **Funkční (zelené) dnes je jen**: build všech balíčků (ci.yml), typechecky, kontraktní testy e2e harness (67 testů) a ~93 % unit testů. Nic z toho není required check.
2. **Zamýšlený kontrakt** je `pnpm check` (`docs/dev/engineering-quality-gates.md:8-28`: lint → types → unit → rust → architecture) + `check:services` (headless orchestrator+server topologie s fake OpenCode — jediný test skutečné BE kompozice bez UI!) + 1 desktop-recovery scénář. `check:services` (`scripts/headless-services.integration.test.mjs`) je pro variantu „oddělit BE/FE" nejcennější existující test — ověřuje přesně tu server-API vrstvu, která by se stala samostatným backendem.
3. **Katalog 80 TOML scénářů má hodnotu specifikace, ne testů** — je to nejúplnější popis očekávaného chování UI (onboarding, sidebar, sessions, skills, MCP konektory, recovery), ale jako regresní síť má provedených 0 CI běhů.
4. **Důsledek pro rozhodnutí o zjednodušení**: riziko velkého zásahu se NEDÁ měřit ztrátou záchranné sítě, protože žádná neexistuje — tým už dnes fakticky vyvíjí bez brzd (červený board, přímé pushe na nechráněný main, release bez testů). Argument „přepis je riskantní, rozbije se to" neplatí o nic víc než pro současný stav; naopak každá ze tří variant by měla začít tím, že se z 80 scénářů vybere ~10-15 kritických (workspace, spuštění agenta, skills, MCP) a přepíše se na cíl nové architektury jako první skutečně vynucovaný gate.

## Mezera 6 — dodatek: nezávislé re-ověření (2026-07-19, druhý průchod)

Sekce „Mezera 6" výše byla znovu ověřena přímo na stroji, nezávislým průchodem. Všechna klíčová tvrzení potvrzena:

- **knip re-run** (`./node_modules/.bin/knip --no-progress --files --max-show-issues 200 --no-exit-code` v `git/`): identických **19 nepoužívaných souborů** jako v tabulce 6.2. Repo má vlastní `knip.jsonc` a skripty `audit:knip` / `audit:knip:strict` (root `package.json:48–49`) — nástroj tedy existuje, ale jeho výstup se neuklízí.
- **Grepy importérů**: `context/sync` → 0 konzumentů; `inbox-panel` → 0 konzumentů; `pages/identities` → jediná reference `tests/pages/identities-contract.test.ts:5` (čte soubor jako surový text přes `readFileSync`); `global-sync` → importováno v `entry.tsx`, `app.tsx` a testu — **GlobalSyncProvider je živý, kandidátský seznam se v něm mýlil**.
- **Enable flagy** (přesné řádky potvrzeny): `packages/server/src/server.ts:3047–3051` — `resolveToyUiEnabled()` vrací `true` při nenastaveném `VESLO_TOY_UI`; `packages/server/src/internal-system.ts:515–517` — `automationsPluginEnabled(): boolean { return false; }`; `packages/desktop/src-tauri/src/workspace/internal_provision.rs:198–203` — `automations_plugin_enabled_from_env(...) -> bool { false }` (ignoruje argumenty).
- **LOC na řádek přesně**: session.tsx 5 012, skills.tsx 3 273, identities.tsx 1 494, toy-ui.ts 1 812, internal-system.ts 1 243 = internal_provision.rs 1 243 (zrcadlené dvojče), sync.tsx 34, global-sync.tsx 310, inbox-panel.tsx 295; routes/ celkem 10 865 (conversations 1 675, opencode-router 1 567, file-sessions 982, …).
- **Prázdné skořápky**: `packages/openwork` obsahuje jediný soubor `docs/style-guide.md`; `services/den-worker-runtime` jediný `README.md`.

**Jedno zpřesnění navíc (zesiluje verdikt „mrtvé" u proto stránek):** v Tauri režimu startup controller `/proto-v1-ux` **aktivně přesměruje pryč** na `/dashboard/scheduled` (`packages/app/src/app/controllers/app-startup-controller.ts:61–63`, reason `"proto-tauri"`; totéž ř. 70). Proto stránky (1 127 LOC) tedy nejsou v desktopové aplikaci dosažitelné ani ručním zadáním URL — žijí jen ve web režimu (`reason: "proto-web"` = ignore, ř. 65). Cesta souboru s route-sync logikou je `packages/app/src/app/context/app-route-sync.ts` (ř. 83, 193–194).

## Mezera 4 — dodatek: nezávislé druhé ověření (2026-07-19)

Sekce „Mezera 4" výše byla nezávisle přeověřena druhým průchodem; všechna klíčová čísla potvrzena na HEAD: 61 souborů v `packages/app/src` importuje `@opencode-ai/sdk`; `engineKind` existuje jen jako `"pooled" | "shared"` v `packages/orchestrator/src/opencode-proxy-target.ts:20`; `const ENGINE = "opencode" as const` v `packages/server/src/conversation-binding-store.ts:71` a literál `"opencode"` v hashi identity bindingu (tamtéž ř. 229); `opencodeSessionId` 184× v netestových zdrojích serveru (346× včetně testů); jediné „codex" soubory v `packages/` jsou 3 E2E specy pro admin credential flow; `@openai/codex` jen v `services/ai-gateway/package.json:21` (0.144.5) a `services/den/package.json:17` (0.144.1).

Nová fakta nad rámec sekce výše:

1. **Šev `engineSessionId` NENÍ post-auditová implementační práce — audit předchází.** Zaveden commitem `7ab43b14` „basic opencode isolation + Workspace ID storage" z **2026-06-05**, tj. 17 dní před auditem. Audit (§1.3, §8) si existující pojmenování jen zapsal jako „helpful head start". Po 22. 6. tedy nevznikla žádná implementační práce na švu — ani rozšíření, ani konzumace druhým enginem.
2. **Audit dokument je od 22. 6. nedotčený.** Historie souboru má jen 2 commity, oba z 2026-06-22 (`b010ff4d` vytvoření +576 ř., `f53d7220` +172 ř. — realism review §11 + optimalizovaný plán §12). Žádná aktualizace stavu, žádné odškrtávání gate G0–G4.
3. **Navazující dokument `2026-07-04-engine-portable-architecture-final.md`** byl commitnut 2026-07-05 (`40e2ebf4`) a v kódu z něj také nic není: `EngineAdapter`, `VesloEngineEvent` ani `VesloTranscript` se v `packages/` nevyskytují, import-ban lint na `@opencode-ai/sdk` v app neexistuje (v `packages/app` není žádný eslint/dependency-cruiser config s tímto pravidlem).
4. **Orchestrator nemá žádný codex modul:** výpis `packages/orchestrator/src/` obsahuje výhradně `opencode-*` moduly (`opencode-config-sanitizer.ts`, `opencode-event-normalization.ts`, `opencode-managed-dependencies.ts`, `opencode-project-api.ts`, `opencode-proxy-target.ts`, `opencode-version.ts`, `shared-opencode-engine.ts`) + engine-agnostické (`engine-pool.ts`, `run-store.ts`, …).

Interpretace beze změny: rozhodnutí „full replace" z 22. 6. zůstává čistě papírové, o 12 dní později změkčené na „Codex-ready, Phase 4 optional", a od té doby vazba na OpenCode dále rostla. Pro volbu zjednodušit/rozdělit/přepsat platí, že jediná investice bezpečná ve všech scénářích je průnik obou dokumentů: Veslo-owned event/part schéma v app, serverový transcript store jako kanonický read model a `.opencode/` jako build output adaptéru.

## Mezera 5: Co reálně gate-uje CI a jaká je skutečná regresní síť (2026-07-19)

### 5.1 Kde žije „current-gate" a proč ho grep ve workflow nenašel

Sada `current-gate` existuje, ale není definována ve workflow YAML — je to default suite pilot runneru:
- `packages/e2e/package.json:12` — `"test": "node --import=tsx/esm ./helpers/pilot-runner.ts --suite current-gate"`
- `packages/e2e/helpers/pilot-runner.ts:78–104` — definice `PILOT_SCENARIO_SUITES['current-gate']` = **přesně 25 scénářů** (smoke, navigation, admin-managed-ai-access, attachment-staging, composer, extensions-mcp, feedback-bug-report, markdown-drop-guard, skill-publish-dialog, skills-global-inventory, session-capabilities, session-message-replacement, skill-registry-materialization, shared-workspace-skill-lock, session-artifacts, session-prefetch, session, settings-dashboard-link-tabs, settings-gear-navigation, sidebar-primary-actions-overflow, sidebar-primary-actions-pointer-navigation, typography, veslo-server-startup, visual-regression, language-persistence)
- Další suites: `live-inference` (1 scénář), `live-inference-lifecycle` (1 scénář) — tamtéž ř. 105–111.
- Workflow `e2e-ui.yml:62,66` volá `pnpm test:e2e:ui` → root `package.json:37` → e2e `test` → current-gate. Grep na „current-gate" ve workflow proto nic nenajde.

### 5.2 Bilance 80 TOML scénářů (`packages/e2e/pilot-scenarios/`, 12 908 řádků celkem)

Křížová kontrola všech 80 TOML proti suites + npm skriptům (e2e i root package.json) + workflow souborům (skript spuštěn nad repem, výstup výše v této session):
- **27 scénářů v suites** (25 current-gate + 2 live-inference) → tvrzení „~53 se nikdy nespouští ze suite" **potvrzeno přesně: 80 − 27 = 53**.
- **40 scénářů má aspoň nějaký vstupní bod** (suite nebo pojmenovaný npm skript typu `test:pilot:soul-dashboard`).
- **40 scénářů nemá žádný vstupní bod** (žádná suite, žádný npm skript, žádný workflow) — mj. automations, boot-freeze, multi-workspace-restart, session-queue-durability, celá rodina vslo-171/vslo-270/vslo-271 a 3 ze 4 vslo-235.
- Z těch 40 jich **25 není referencováno vůbec nikde** ani v kódu helpers/specs/scripts — čistě mrtvé TOML (boot-freeze, desktop-context-menu, titlebar-window-controls, sidebar-collapse-animation, pnpm-dev-3-clicks, …).

### 5.3 Co se v CI spouští na kterých větvích — a klíčový zvrat: vývoj se přesunul na `main`

| Workflow | Trigger | Obsah |
|---|---|---|
| `quality.yml` (Quality) | push+PR → **main, dev** | static (lint+types+architecture audity), unit (`check:unit`), services-Windows, Rust (fmt+clippy+test), desktop-recovery (**jediný pilot scénář** `vslo-235-local-host-child-exit`, `quality.yml:131–173`, root `package.json:27`), job `gate` vyžaduje všech 5 |
| `ci.yml` (CI) | push+PR → **jen dev** | build web, den, orchestrator binary + typecheck |
| `ci-tests.yml` (Veslo Tests) | push+PR → **jen dev** | `veslo-ui test:e2e` = unit + Node skripty proti `opencode serve` (headless, bez UI; `packages/app/package.json` test:e2e) na ubuntu-22.04 + macos-14 |
| `e2e-ui.yml` (E2E UI Tests) | push+PR → **jen dev** | tauri-pilot **current-gate** (25 scénářů), 3 OS |
| `prerelease.yml` | push → jen dev | build+publish, žádné testy (jen verify skripty) |
| `release-macos-aarch64.yml` (Release App) | tag `v*` / dispatch | release build, žádná testovací sada |
| build-desktop / build-staging-app / build-windows-msi / deploy-owned-server / apple-notary-diagnostics | workflow_dispatch | ops/buildy |

Aktuální HEAD je na `main` (commit 71215b07, „SKILL MATERIALIZATION + NEW CONFIGS"), poslední aktivita na `dev` je z **2026-06-25** (`gh run list`). Od té doby jsou CI, Veslo Tests i E2E UI Tests **spící** — na `main` z testovacích workflow triggeruje **pouze Quality**.

### 5.4 Skutečný stav bran (data z `gh run list/view`, repo neatechcz/veslo)

- **Quality: 0 úspěchů v celé dochované historii.** Posledních 25 běhů: 21 failure, 4 cancelled, žádný success. V posledních 12 bězích padá **všech 5 jobů současně** včetně Static (lint+types). Konkrétní příčiny z logu runu 29692126140 (2026-07-19): reálné `AssertionError` v unit testech (testCodeFailure), ne jen infra šum.
- **E2E UI Tests (jediné místo, kde by current-gate běžel): 12 běhů v historii, 12× failure — a všechny umírají už na kroku „Prepare sidecars", tj. 25 pilot scénářů se v CI nikdy ani nezačalo vykonávat.** Odpovídá tomu i komentář přímo ve workflow (`e2e-ui.yml:48–50`): „adapt the full platform-aware download logic … when enabling this workflow" — workflow nebyl nikdy dokončen.
- **Veslo Tests: jediný workflow, který kdy byl zelený** — 18 success / 9 failure; poslední úspěch **2026-05-23** (běh ~75–85 s). Od 25. 6. netriggeruje.
- **Branch protection: žádná.** `gh api repos/neatechcz/veslo/branches/{main,dev}/protection` → 404 (nechráněno). Pushuje se přímo na `main` s červeným Quality; release v2026.7.12 vyšel 2026-07-18 a „Release App" doběhl úspěšně 2026-07-19 v 01:15, zatímco Quality na témže commitu selhal.

### 5.5 Lokální ověření (HEAD = main, 71215b07)

- `pnpm --filter @neatech/veslo-ui test:unit`: **374 testů, 348 pass, 14 fail, 12 skip, 5,7 s** — červené i lokálně, shoduje se s CI. Padající testy pokrývají mj. composer target picker (3×), managed AI config sync (3×), pending session materialization, skill registry orchestrator, hub MCP refresh, session view state.
- **Plný lokální běh current-gate nebyl v rámci analýzy proveditelný bez zásahu do stroje:** runner vyžaduje externí binárku `tauri-pilot` (`pilot-runner.ts:226`, CI instaluje `tauri-pilot-cli 0.7.2` přes cargo), která na stroji není (`which tauri-pilot` → nenalezeno); debug e2e build `packages/desktop/src-tauri/target/debug/veslo` je z **26. 5.** (2 měsíce starý vůči kódu z 19. 7.), takže validní měření by vyžadovalo cargo install + plný Rust rebuild s `--features e2e` (řádově hodiny). Neexistuje ani žádná lokální historie běhů (`.pilot-runs/` chybí, `tauri-pilot-failures/` chybí, `.tmp-veslo-home` naposledy dotčen 26. 5.) — **poslední lokální pilot aktivita je z 26. 5.**
- Pro otázku „co gate-uje" je ale CI evidence průkaznější než lokální běh: sada, která v CI nikdy nedoběhla, negate-uje nic bez ohledu na lokální pass-rate.

### 5.6 Závěr: skutečný kontrakt, který se musí přenést do nové architektury

1. **Vynucovaný kontrakt je dnes fakticky prázdný.** Jediná brána na aktivní větvi (Quality) je trvale červená, branch protection neexistuje, releasy jdou ven bez zelené. Riziko variant (a)/(b)/(c) tedy nesnižuje žádná fungující záchranná síť — **tu je nutné vybudovat v každém scénáři**, což zároveň znamená, že žádná varianta nemá oproti ostatním výhodu „chráněného refaktoringu".
2. **Jediná historicky zelená vrstva jsou headless engine testy** (Veslo Tests → `packages/app/scripts/e2e.mjs` + session-switch/fs-engine/browser-entry proti `opencode serve`, poslední zelená 23. 5.). To je přesně vrstva API kontraktu, která přežije oddělení BE/FE — nejcennější přenositelný kus.
3. **25 TOML scénářů current-gate je použitelných jako specifikace UI chování** (session, composer, skills, extensions-mcp, sidebar, settings, startup, vizuální regrese — pokrývají všechny 4 povinné funkce), ale nikoli jako regresní síť: v CI nikdy neproběhly a lokálně 2 měsíce neběžely. Při přepisu mají hodnotu zadání, ne testu.
4. **Mrtvá váha k vyhození:** 40 z 80 pilot TOML nemá žádný vstupní bod, z toho 25 není referencováno vůbec nikde; workflow `e2e-ui.yml` je nedokončený (sidecar krok), `ci*.yml` a `prerelease.yml` visí na opuštěné větvi `dev`.
5. **Rychlá výhra nezávislá na volbě varianty:** opravit 14 červených unit testů (5,7 s běh), zprovoznit Quality/gate a zapnout branch protection na `main` — teprve pak má smysl velký zásah.

## Mezera 3: Co reálně funguje ve web režimu už dnes (empirické ověření `pnpm dev:web`)

Ověřeno spuštěním na stroji (2026-07-19): `cd git && pnpm dev:web` s izolovaným datadirem a testovacím workspacem ve scratchpadu, pevné porty (`VESLO_PORT=8791`, `VESLO_WEB_PORT=5199`). Vše testováno výhradně přes `curl` (žádný prohlížeč), FE větve doloženy čtením kódu. Stack po testu ukončen a ověřeno, že nic neběží.

### Co `dev:web` skutečně spouští (`scripts/dev-headless-web.ts`, 279 ř.)

Dva procesy: (1) Vite dev server UI s `VITE_VESLO_URL/PORT/TOKEN` (ř. 178–185, 219–234), (2) `veslo-orchestrator dev -- start --workspace … --no-opencode-auth` (ř. 236–263). Orchestrátor v režimu `start` pak sám spawne **opencode engine** (:62147), **veslo-code-router** (:62148) a **veslo-server** (:8791). Žádný Tauri, žádný Rust. Stack naběhl do ~15 s (binárky byly předbuilděné; skript je jinak auto-buildne, ř. 122–168). Není to jen dev hračka: `packaging/docker/` má dev stack (`dev-up.sh`) i **produkční kontejner** („veslo-server … the only published surface", UI na `/ui`) a FE má pro tento režim explicitní `forceProxy` větev („Docker remote mode", `packages/app/src/app/context/server.tsx:69–75`).

### Empiricky OVĚŘENÉ funkční flow — čisté HTTP, bez Tauri

| Flow | Důkaz (curl proti :8791) |
|---|---|
| Health/status/capabilities | `GET /health` → ok, verze 2026.7.12; `GET /status` → workspaceCount, approval mode; `GET /capabilities` → skills/mcp/plugins read+write vše `true` |
| UI | `GET :5199/` → 200, index 3 980 B |
| Registry složek | `GET /workspaces` → seznam + activeId |
| **Přidání složky** | `POST /workspaces/local` (hlavička `x-veslo-host-token`) → workspace vytvořen, persisted:true |
| **Přepnutí workspace** | `POST /workspaces/:id/activate` → activeId změněno + **provisioning proběhl** (`provision.status:"updated", written:3` — zapsal `.opencode` do nové složky) + sync user-global skills |
| **Vytvoření session** | `POST /workspace/:id/conversations` → reálná engine session (`ses_084b…` + `conv-b786…`) |
| **Odeslání zprávy (běh agenta)** | `POST /workspace/:id/conversations/submit` (`draft.mode:"prompt"`) → `status:"submitted"`, runId přidělen, zpráva dorazila do enginu, vznikla user i assistant message. Assistant skončil chybou `403 Connection blocked by network allowlist` — to je **můj sandbox blokující odchozí AI volání**, ne limit web režimu; celý pipeline submit→run→engine→transcript-ingest funguje |
| **Čtení transkriptu** | `GET …/conversations/:id/transcript` → obě zprávy včetně chybového detailu |
| **Streaming (SSE)** | `GET /workspace/:id/opencode/event` (proxy na engine) → `Content-Type: text/event-stream`, event `server.connected`. Pozor: `GET /workspace/:id/events` (uváděný v ipc-http-parita.csv jako SSE ekvivalent) je ve skutečnosti **JSON polling reload-eventů s kurzorem** (`routes/workspace-management.ts:438–446`), ne SSE — skutečný SSE ekvivalent je engine proxy |
| **Skills** | `GET /workspace/:id/skills` + `POST` → zapsán `.opencode/skills/web-test-skill/SKILL.md`, vrácena cesta |
| **MCP** | `GET /workspace/:id/mcp` + `POST` → zapsáno do `opencode.json` (ověřeno přes `GET /workspace/:id/config`) |
| Messaging router | `GET /opencode-router/health` (proxy) → ok, healthy engine, kanály vypnuté |

FE k tomu má reálné web větve, ne pahýly: streaming ve webu jde přes SDK SSE fallback `c.event.subscribe` (`session-event-stream.ts:1298–1328`, transport `sdk-sse-fallback`), Den login otevírá auth URL přes `window.open` + web deep-link consume (`den-desktop-auth-workflow.ts:166–172`, `app-startup-hydration.ts:542–549`), baseUrl se ve webu persistuje do localStorage (`app-startup-hydration.ts:598–601`).

### Co bez Tauri tiše degraduje nebo chybí (empiricky + kód)

1. **Engine lifecycle pro DALŠÍ workspace — hlavní díra.** Druhá složka přidaná přes API nikdy nedostane engine: `POST /workspace/ws2/engine/reload` i `POST /workspace/ws2/conversations` → `opencode_unconfigured` („OpenCode base URL is missing"). Příčina: engine pool s lazy-spawnem žije jen v **daemon režimu** orchestrátoru (`cli.ts:5032–5100`, `pool.ensure`), který spouští jen desktop (`orchestrator_start_detached`); `runStart` (`cli.ts:6085+`) daemon nevolá — `dev:web` je topologie **1 workspace = 1 engine**. Multi-workspace ve webu = zapojit daemon/pool do headless startu (backend práce, FE se nemění).
2. **Run-status endpoint nefunguje**: `GET …/runs/:runId` → `lifecycle_unavailable` („Run lifecycle owner is not configured"); debugTrace submitu ukazuje `lifecycle-owner enabled:false`. Transcript ale funguje, takže UI má odkud číst.
3. **FE přidání složky**: `pickWorkspaceFolder` ve webu vrací chybu `app.error.tauri_required` (`workspace-local-workspaces.ts:318–321`) — nativní dialog nemá web náhradu (textové pole s cestou / server-side browser neexistuje), přestože serverová routa `POST /workspaces/local` funguje. Web UI místo toho umí „remote veslo workspace" (URL+token, `workspace-activation-remote.ts`).
4. **Drafty**: pending drafts jsou Tauri-only, web větev elegantně degraduje na okamžité vytvoření session (`pending-session-draft-controller.ts:493–497`) — žádný pád.
5. Tauri-only vrstvy, které web **správně obchází**: Rust SSE most (`engine-sse.ts:134` hodí „desktop-only", ale volající má SDK fallback), `WorkspaceServerSync` („No-op in non-Tauri runtimes — web build keeps using the veslo-server proxy", `workspace-server-sync.tsx:20`), přímé SQLite čtení sessions (web čte přes conversations API).

Rozsah větvení: `isTauriRuntime` má v `packages/app/src` **471 výskytů v 99 souborech, z toho 347 v produkčním kódu** (zbytek testy) — víc, než uvádělo zadání (250).

### Verdikt: split není marketing — pro 1 workspace je fakticky hotový

Všechna 4 kritická flow (složky, běh agenta, skills, MCP) **mají funkční HTTP cestu ověřenou během** — včetně zápisů na disk, provisioningu a SSE streamu. Zbývající práce pro plnohodnotnou SPA je krátký, konkrétní seznam: (a) **backend**: engine pool/daemon v headless topologii (multi-workspace lifecycle) + zapojení run-lifecycle ownera; (b) **FE**: náhrada nativního folder-pickeru (jediné kritické flow bez web UI cesty) a úklid ~347 větví, které už dnes většinou mají fallback; (c) drobnost: sladit dokumentaci parity — `/workspace/:id/events` není SSE. Nic z toho nevyžaduje návrh nové architektury — architektura API+SPA v repu už běží, jen ji desktop nevyužívá jako primární cestu.
