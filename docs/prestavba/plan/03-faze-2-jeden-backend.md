# Fáze 2 — Jeden backend

Plán přestavby Vesla, fáze 2. Navazuje na fázi 0 (regresní síť) a fázi 1 (ořez + shared engine).
Vychází z analýzy v `docs/prestavba/analyza/` (ověřené na HEAD `71215b07`, 2026-07-19) a z rozhodnutí Pavla v `docs/prestavba/ZADANI.md`.

**Pro vykonavatele:** Každý pracovní balíček níže je zadání pro jednu samostatnou AI session (Codex CLI nebo Claude Code). Balíčky se vykonávají v uvedeném pořadí. Před začátkem každého balíčku ověř vstupní soubory na aktuálním HEAD — odkazy na řádky platí k `71215b07` a fáze 0–1 je mohly posunout. Commit po každém dokončeném balíčku, push až po manuálním otestování (pravidlo repa). Platí feature freeze: žádné nové featury, jen přestavba.

---

## 1. Účel fáze

Dnes (po fázi 1) běží za frontendem stále **tři backendové procesy**: `veslo-server`, `veslo-orchestrator` daemon a OpenCode engine — s HTTP hranicemi mezi sebou, run-lifecycle handshake přes token, HTTP registrací workspace a třetí evidencí workspace v orchestrátoru (analyza/orchestrator.md, hotspot 6 a 8). To je přímý zdroj kořenové příčiny KP1 (replikovaný mutable stav bez jediného vlastníka, analyza/SYNTEZA.md §2).

Cíl fáze 2: **jediný backendový proces `veslo-server`**, který:

1. sám spawnuje a superviduje shared OpenCode engine (engine lifecycle jako knihovna, ne proces),
2. je jediným vlastníkem stavu — registr workspace, run lifecycle, transkript,
3. má workspace jako **parametr požadavku** (`/workspace/:id/...`), ne jako globální režim,
4. vystavuje **jeden SSE kanál s kurzorem** pro všechny události,
5. má auth použitelnou i mimo localhost (konec CORS `*` a tokenů v argv),
6. má **strojově čitelný kontrakt** (OpenAPI) a generovaný TS klient — hranici BE/FE dle ZADANI.md („hranice BE/FE = generovaný API klient, žádné křížové importy").

Desktop (Tauri) po této fázi superviduje **jediný sidecar** a frontend má připravený kontrakt, na který se ve fázi 3 přepne z IPC. Headless režim (Docker, `dev:web`) funguje multi-workspace — dnes je to topologie 1 workspace = 1 engine a druhá složka dostane `opencode_unconfigured` (analyza/doplneni.md, Mezera 3, bod 1).

**Proč to je bezpečné:** architektura API + SPA v repu už běží — všechna 4 povinná flow (složky, běh agenta, skills, MCP) prošla čistým HTTP bez Tauri (empiricky ověřeno, doplneni.md Mezera 3). Fáze 2 tedy nedělá návrh nové architektury, jen slučuje procesy a dotahuje deklarovaný cílový stav (`ARCHITECTURE.md:154-159`: „veslo-server = jediná API plocha").

---

## 2. Prerekvizity (co musí být hotové z předchozích fází)

Před začátkem fáze 2 ověř (a při nesplnění zastav a eskaluj Pavlovi):

| # | Prerekvizita | Z fáze | Jak ověřit |
|---|---|---|---|
| P1 | Regresní minimum funguje: unit testy zelené, `pnpm check:services` zelený, vybraná sada vynucovaných scénářů běží | 0 | `cd git && pnpm check:unit` (nebo dohodnutá podmnožina) a `pnpm check:services` |
| P2 | **Shared engine je jediná topologie** — `EnginePool` (pooled-per-workspace) smazán, sandbox plumbing pryč (varianta A z analyza/multi-workspace.md §5) | 1 | `ls packages/orchestrator/src/engine-pool.ts` → neexistuje; grep `pooled-per-workspace` → 0 v produkci |
| P3 | **Per-workspace konfigurace ve shared enginu vyřešena** (jizva 4 multi-workspace.md: last-writer-wins do jednoho config diru) — buď engine čte `.opencode/` per session directory, nebo se config předává per request | 1 | dle řešení z fáze 1; test: 2 workspace s odlišným MCP configem, souběžné sessions, konfigurace se nekříží |
| P4 | Router (`opencode-router`) vyhozen — balíček, server routa, Rust spawn, FE | 1 | grep `opencode-router` v produkčním kódu → 0 |
| P5 | Jediný provisioning (server TS), Rust `internal_provision.rs` zrušen nebo volá server | 1 | pravidlo dual provisioning v CLAUDE.md už neplatí |
| P6 | Přímý SQL přístup do `opencode.db` z Rustu zrušen (`session_reader.rs`, `misc.rs` čtečky) | 1 | grep `opencode.db` v `src-tauri` → 0 |
| P7 | Mrtvý kód dle SYNTEZA §4.1 smazán (mj. `runStart` TUI pokud to fáze 1 zahrnula — pokud ne, smaže se zde v balíčku 2.4) | 1 | knip čistý na dohodnutém seznamu |

Pokud P3 není splněno, **balíček 2.1 nelze bezpečně začít** — embedded engine přebírá shared topologii i s jejím config modelem.

**Výjimka — „Větev B z fáze 1“ (experiment 0.10 dopadl V2b/V4, balíček 1.8 proběhl větví B):** v tom případě P2 a P3 splněny doslovně NEJSOU a **není to důvod k zastavení** — fáze 2 běží v upravené podobě: balíček 2.1 místo shared enginu přebírá do serveru **EnginePool (`engine-pool.ts`, pool per workspace) jako jedinou topologii**. Per-workspace config je v poolu přirozený (každý workspace má vlastní engine proces s vlastním config direm), takže jizva 4 zaniká také; shared větev a topologické přepínání se mažou uvnitř serveru jako součást 2.1 (sjednocení topologie tedy proběhne zde, ne ve fázi 1). Důsledky: rozsah 2.1 roste o ~1 session (pool má LRU/idle/restart mašinérii navíc) a milník fáze zní „`ps` ukazuje engine procesů až N, jeden per aktivní workspace“ místo jednoho sdíleného. Před startem 2.1 v této variantě potvrď úpravu rozsahu s Pavlem; vstupem je `docs/prestavba/plan/rozhodnuti-topologie.md` z balíčku 1.8 větve B.

---

## 3. Milník fáze: co funguje, když je fáze hotová

- Desktop spouští **jediný sidecar proces** (`veslo-server`); ten sám spawnuje a superviduje shared OpenCode engine. `ps` po startu ukazuje: Tauri shell, veslo-server a engine sidecar — nic víc. (Jméno engine binárky = stav po fázi 1: balíček 1.9 zrušil symlink a bundluje jedinou binárku pravděpodobně pod jménem `opencode` — ověř v `prepare-sidecar.mjs`. Při „Větvi B z fáze 1“ — pool — je engine procesů až N, jeden per aktivní workspace.)
- Balíček `packages/orchestrator` **neexistuje** v repu ani v bundlu (−1 binárka, dle analyza/orchestrator.md §náměty 1 řádově −3 000 až −4 000 ř.).
- Headless režim (`pnpm dev:web`, Docker) umí **N workspace současně** — přidání druhé složky přes API funguje včetně engine lifecycle a run stavů (`GET .../runs/:id` už nevrací `lifecycle_unavailable`).
- Všechna FE-relevantní API jsou **workspace-scoped** (`/workspace/:id/...`); „aktivace" workspace nemá vliv na směrování požadavků.
- Existuje **jediný jmenný prostor workspace ID** (server-owned, odvozený z cesty) — žádné mapování FE↔server↔Tauri ID.
- Server vystavuje `GET /workspace/:id/events/stream` — **SSE s kurzorem** (replay přes `Last-Event-ID`), jeden kanál pro engine i serverové události.
- CORS default **není `*`**, žádné tokeny v argv žádného procesu, auditované ne-autentizované routy.
- Existuje **OpenAPI specifikace** kontraktu + generovaný TS klient (`packages/api-client`), CI hlídá drift spec↔routy, platí pravidlo aditivních změn.
- Frontend funguje **beze změny chování** (stále částečně přes IPC — jeho migrace je fáze 3), desktop build (Mac i Windows) prochází, regresní síť z fáze 0 je zelená.

---

## 4. Přehled balíčků

| Balíček | Název | Závislosti | Odhad (AI sessions) |
|---|---|---|---|
| 2.1 | Engine runtime jako knihovna serveru (za feature flagem) | fáze 1 (P2, P3) | 2–3 |
| 2.2 | Run lifecycle s jediným vlastníkem (in-process) | 2.1 | 1–2 |
| 2.3 | Desktop přechod na embedded režim (jediný supervidovaný sidecar) | 2.1, 2.2 | 2 |
| 2.4 | Smazání orchestrátoru, tenké CLI, headless supervize | 2.3 | 1–2 |
| 2.5 | Jediný jmenný prostor workspace ID | 2.4 | 1–2 |
| 2.6 | Server jako vlastník stavu — workspace = parametr požadavku | 2.5 | 1–2 |
| 2.7 | Serverové SSE s kurzorem — jeden event kanál | 2.1, 2.6 | 1–2 |
| 2.8 | Auth pro ne-localhost + bezpečný bootstrap | 2.4 | 1–2 |
| 2.9 | OpenAPI kontrakt + generovaný TS klient + zmrazení | 2.6, 2.7, 2.8 | 2 |
| | **Celkem** | | **12–19 (realisticky ~15)** |

### Pořadí a přechodné období — proč aplikace po každém balíčku funguje

Strategie: **nová cesta vzniká za feature flagem vedle staré; přepnutí je samostatný balíček; smazání staré cesty až po ověřeném přepnutí.**

| Po balíčku | Výchozí cesta desktopu | Stará cesta (orchestrátor) | Poznámka |
|---|---|---|---|
| 2.1 | beze změny (orchestrátor) | běží, default | embedded jen za `VESLO_EMBEDDED_ENGINE=1`, ověřuje se headless curl-em |
| 2.2 | beze změny | běží, default | in-process lifecycle owner aktivní jen v embedded režimu |
| 2.3 | **embedded** | kód existuje, nespouští se | rollback = env přepínač v Rustu (viz 2.3) |
| 2.4 | embedded | **smazána** | bod, odkud není návrat — proto až po manuálním otestování 2.3 na Mac i Windows |
| 2.5–2.9 | embedded | — | čistě serverová/kontraktová práce, FE beze změny chování |

Frontend po celou fázi funguje, protože jeho tři kanály zůstávají obsloužené: (a) HTTP na veslo-server — beze změny; (b) Tauri IPC → Rust → HTTP — beze změny; (c) per-workspace SDK klienti a Rust SSE most (`commands/engine_sse.rs`) — dostávají jinou base URL (server mount místo orchestrátor mountu, balíček 2.3), samotný mechanismus se nemění. Rust SSE most se **maže až ve fázi 3** (FE přejde na `EventSource`), tady se jen přesměruje.

---

## 5. Pracovní balíčky

---

### Balíček 2.1 — Engine runtime jako knihovna serveru (za feature flagem)

**Cíl:** `veslo-server` umí sám spawnout, supervidovat a proxovat shared OpenCode engine — bez orchestrátoru. Zapíná se `VESLO_EMBEDDED_ENGINE=1`; výchozí chování (orchestrátor) zůstává beze změny. Tím vzniká „shared engine z fáze 1 jako knihovna serveru".

**Vstupy:**
- Kód k přenesení (z `packages/orchestrator/src/`):
  - `shared-opencode-engine.ts` (289 ř.) — třída shared enginu,
  - `cli.ts` — funkce `startOpencode` (cca ř. 2655: spawn `veslo-code serve --hostname --port`, ~20 env proměnných, Basic auth, preload `ensureOpencodeListenerLimitPreload` ~ř. 2457), health check přes SDK klienta, `syncWorkspaceOpencodeConfigToConfigDir` (~ř. 5461),
  - `router-proxy.ts` (337 ř.) — reverzní proxy request→engine (streaming, SSE passthrough),
  - `opencode-managed-dependencies.ts` (748 ř.) — vendorování npm balíčků do `.opencode/node_modules`,
  - `persistence.ts`, `shutdown.ts`, port utility (`findFreePort`),
  - `workspace-id.ts` (78 ř.) — kanonická derivace workspace ID (`ws-<sha1(path)>`; potřebuje ji balíček 2.5),
  - `opencode-event-normalization.ts` — normalizace engine událostí (~24 SSE event typů, 8 part typů; potřebuje ji balíček 2.7).
  Poslední dva moduly samy engine runtime netvoří, ale **musí se přenést už teď** — balíček 2.4 maže celý orchestrátor a jinak by 2.5/2.7 stavěly na souborech dohledatelných jen z git historie (riziko 6: vše nevyjmenované je default „smazat v 2.4“). Při přenosu ověř i drobné utility, které tyto moduly importují.
- Cílové místo: `packages/server/src/` — zejména `server.ts` proxy `/workspace/:id/opencode/*` (~ř. 1572) a orchestrátor fallback + registrace workspace (~ř. 1218–1489), `config.ts` (CLI/env parsing, flagy `--opencode-bin` apod.).
- Test k rozšíření: `scripts/headless-services.integration.test.mjs` (spouští ho `pnpm check:services`, root `package.json:23`).
- Reporty: `analyza/orchestrator.md` (celý, zejména „Náměty 1" a hotspoty 2, 7), `analyza/multi-workspace.md` §1 a §5 varianta C, `analyza/doplneni.md` Mezera 3 (ověřená curl flow — použij jako testovací scénář).

**Kroky:**
1. Založ modul `packages/server/src/engine/` s jasnou vnitřní strukturou (malé soubory — kritérium AI-friendly z ZADANI.md):
   - `engine-process.ts` — spawn engine binárky (`… serve`), env kontrakt (převzít 1:1 z `startOpencode`, včetně preload hacku), health, restart s backoffem, řízený shutdown (engine je child s kill-on-exit). Jméno binárky = **aktuální stav po fázi 1**: balíček 1.9 symlink `opencode`→`veslo-code` zrušil a bundluje jedinou binárku pravděpodobně pod jménem `opencode` (ověř v `prepare-sidecar.mjs`) — symlink logiku nepřenášej,
   - `engine-proxy.ts` — adaptace `router-proxy.ts`: injektáž `x-opencode-directory` dle workspace registru serveru, Basic auth na upstream, SSE passthrough,
   - `engine-config-sync.ts` — **jen pokud fáze 1 config sync nezrušila** (výsledek experimentu 0.10 V2a/V3): sync `.opencode` configu **při aktivaci/ensure + fs-watcherem**, NE při každém mutujícím requestu (odstranění hot-path syncu, orchestrator.md námět 6). Při výsledku V1 (engine čte projektový config per directory, 1.8 větev A sync kompletně smazala — „jizva 4 zaniká“) **modul nevzniká** — sync se znovu nezavádí,
   - `engine-managed-deps.ts` — vendorování balíčků (zvaž, zda po fázi 1 ještě celé potřeba; co je mrtvé, nepřenášej),
   - `engine-runtime.ts` — fasáda: `ensureEngine()`, `getEngineTarget(workspaceId)`, `subscribeEngineEvents()`, `shutdown()`.
   Kód **kopíruj a adaptuj**; zdroják orchestrátoru neměň (smaže se v 2.4). Trasovací triplicitu (logger + traceRuntime + sendWorkflowTrace, orchestrator.md hotspot 3) NEpřenášej — jeden strukturovaný logger stačí.
2. Rozšiř `config.ts`: `embeddedEngine: boolean` (env `VESLO_EMBEDDED_ENGINE`, CLI `--embedded-engine`), `opencodeBin` (cesta k binárce; CLI `--opencode-bin`, env). Default `false`.
3. Zapoj do `server.ts`: je-li embedded aktivní, proxy `/workspace/:id/opencode/*` míří na in-process engine runtime; orchestrátor fallback větev (retry heuristiky podle textů chyb, server.ts ~ř. 1218–1239) se v embedded režimu nepoužije. Registrace workspace do orchestrátoru (`performOrchestratorWorkspaceRegistration`) se v embedded režimu přeskočí — registr serveru je jediný.
4. Lifecycle pravidla převzít ze současné praxe: lazy start enginu při aktivaci/ensure nebo prvním mutujícím requestu; **GET/HEAD nikdy nespouští engine** (cold start 30–60 s; pravidlo z engine-pool, multi-workspace.md §1); guard aktivní práce před restartem (`hasActiveWork` princip).
5. Přidej embedded variantu headless integračního testu (nový soubor vedle stávajícího, např. `scripts/headless-embedded.integration.test.mjs`): start server binárky s `VESLO_EMBEDDED_ENGINE=1`, dvě workspace, session + submit + transcript v obou. Stávající orchestrátorová varianta zůstává (maže se v 2.4).

**Ověření:**
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter veslo-server typecheck
pnpm --filter veslo-server test
pnpm check:services                      # stará topologie stále zelená
pnpm --filter veslo-server build:bin

# Embedded smoke (tokeny/porty libovolné; engine binárka z dev sestavení — jméno po fázi 1,
# pravděpodobně `opencode`, ověř v prepare-sidecar.mjs):
mkdir -p /tmp/veslo-f2/ws-a /tmp/veslo-f2/ws-b
VESLO_EMBEDDED_ENGINE=1 ./packages/server/dist/bin/veslo-server \
  --port 8791 --token t1 --host-token h1 --opencode-bin <cesta-k-engine-binárce> &
curl -s http://127.0.0.1:8791/health
curl -s -X POST http://127.0.0.1:8791/workspaces/local \
  -H "x-veslo-host-token: h1" -H "content-type: application/json" \
  -d '{"path":"/tmp/veslo-f2/ws-a"}'
# totéž pro ws-b; poté v OBOU: vytvořit konverzaci, submit, číst transcript
# (přesná těla requestů viz analyza/doplneni.md Mezera 3 — ověřený scénář)
curl -s -N -H "authorization: Bearer t1" \
  "http://127.0.0.1:8791/workspace/<ws-id>/opencode/event" | head -5
```
Kritérium: druhá workspace **nesmí** vrátit `opencode_unconfigured` (to je dnešní vada headless režimu, doplneni.md Mezera 3 bod 1).

**Hotovo znamená:**
- Embedded režim zvládne 2+ workspace: session, submit, transcript, SSE proxy v obou.
- Výchozí režim (bez flagu) je bit-po-bitu nezměněné chování; `pnpm check:services` zelený.
- Nový integrační test embedded topologie zelený; typecheck + unit testy serveru zelené.
- Žádný soubor v `packages/server/src/engine/` nepřesahuje ~500 ř.

**Rizika a rollback:**
- Přenášený kód z `cli.ts` má skryté závislosti (logger, trace, state persistence) — řeš minimální náhradou, ne přenosem celé infrastruktury. Riziko podcenění → proto odhad 2–3 sessions; pokud se nestíhá, rozděl: (a) engine-process + proxy, (b) config-sync + managed-deps + integrační test.
- Rollback: flag je default off — smazání flagu vrací přesně původní stav. Commit po každé dokončené sub-části.

**Odhad:** 2–3 sessions (při „Větvi B z fáze 1“ — přenos poolu místo shared enginu — počítej 3–4, viz §2).

---

### Balíček 2.2 — Run lifecycle s jediným vlastníkem (in-process)

**Cíl:** Run registry a aktivita-sonda žijí uvnitř serveru. `conversation-run-lifecycle-controller` mluví s in-process vlastníkem místo HTTP klienta na orchestrátor. Tím zaniká run-lifecycle handshake (lifecycle token, HTTP ping-pong server↔daemon) a `GET .../runs/:id` funguje i headless (dnes `lifecycle_unavailable`, doplneni.md Mezera 3 bod 2).

**Vstupy:**
- Z orchestrátoru: `src/run-store.ts` (463 ř., SQLite `runs.sqlite`), `src/run-registry.ts` (402 ř., stavový stroj submitted/running/blocked/…), `src/run-activity-probe.ts` (339 ř., sonda aktivity dotazem na OpenCode session).
- Na serveru: `src/orchestrator-lifecycle-client.ts` (282 ř. — HTTP klient, zůstane dočasně pro legacy režim), `src/conversation-run-lifecycle-controller.ts` (1 654 ř. — konzument; všimni si portů/DI v hlavičce), `src/routes/conversations.ts` (run endpointy).
- Reporty: `analyza/orchestrator.md` hotspot 6 („celý aparát existuje jen proto, že server, démon a engine jsou tři oddělené procesy"), `analyza/server.md` §5 (konverzační pipeline) a §8 („vlastnictví run lifecycle dát jednomu procesu … pipeline se může zmenšit o 30–50 %"), `analyza/SYNTEZA.md` §1.2 (run lifecycle: 3 vrstvy bez vlastníka).

**Kroky:**
1. Definuj rozhraní `RunLifecycleOwner` (register/markFailed/markAborted/status/attachEngineOwner/sweep) podle skutečných volání v `conversation-run-lifecycle-controller.ts` (grep `lifecycleOwner.` — markFailed :687, status :985, markAborted :1002, 1038 …).
2. Implementace A (nová): in-process owner nad přeneseným run-store/run-registry; `runs.sqlite` v datadiru **serveru**. Terminalizace runů při ztrátě enginu se napojí na supervision události embedded runtime z 2.1 (ekvivalent `cleanupRunsForLostEngine`).
3. Implementace B (stávající): `orchestrator-lifecycle-client.ts` beze změny — použije se, když embedded režim není aktivní. Výběr implementace při DI wiringu v `server.ts` podle configu.
4. Aktivita-sonda: přenes `run-activity-probe.ts`, dotazy směřuj na in-process engine target (žádný HTTP hop navíc).
5. Nezvětšuj kontrakt: routy `/workspace/:id/conversations/:cid/runs/*` zůstávají tvarově stejné — mění se jen vnitřní vlastník. (Redukce pipeline o 30–50 % je lákavá, ale patří až za stabilizaci — feature freeze platí i pro refaktory nad rámec zadání balíčku.)
6. Rozšiř embedded integrační test z 2.1: po submitu `GET .../runs/:runId` vrací živý stav; abort flow (`POST .../abort`) doběhne do terminálního stavu.

**Ověření:**
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter veslo-server typecheck && pnpm --filter veslo-server test
node --test scripts/headless-embedded.integration.test.mjs
# ruční curl: submit → GET runs/:id opakovaně → stavy se mění; abort → aborted
pnpm check:services   # legacy topologie stále zelená
```

**Hotovo znamená:**
- V embedded režimu žádný HTTP lifecycle handshake (`X-Veslo-Orchestrator-Token` se nikde neposílá) a `GET .../runs/:id` vrací stav.
- Legacy režim beze změny chování. Oba integrační testy zelené.

**Rizika a rollback:**
- Reconciler (1 654 ř.) je nejsložitější část serveru — drž se zásady „měním jen implementaci owner portu, ne stavový stroj". Pokud test odhalí odchylku chování (např. sweep timing), zdokumentuj a sladi s legacy chováním, nevylepšuj.
- Rollback: výběr implementace je runtime podmínka — vypnutí embedded flagu vrací legacy cestu.

**Odhad:** 1–2 sessions.

---

### Balíček 2.3 — Desktop přechod na embedded režim

**Cíl:** Tauri spouští **jen** `veslo-server` (s embedded enginem). Orchestrátor daemon se už nespouští. Z pohledu desktopu zaniká: spawn druhého sidecaru, health polling démona, proxy mount orchestrátoru pro app a třetí evidence workspace.

**Vstupy:**
- Rust: `packages/desktop/src-tauri/src/orchestrator/mod.rs` (846 ř. — `spawn_orchestrator_daemon` ~ř. 422, argv s tokeny), `veslo_server/spawn.rs` (1 218 ř. — spawn serveru, `--orchestrator-url` ~ř. 412, secrets file, ready handshake), `commands/engine_sse.rs` (768 ř. — SSE most; **base_url je parametr od FE**, ř. 194–197: `http://127.0.0.1:PORT/workspace/ws-XXX/opencode`), `commands/orchestrator.rs` (aktivace = HTTP klient na daemon).
- FE (jen minimální dotyk — velká FE migrace je fáze 3): místa, kde se sestavuje engine base URL pro per-workspace SDK klienty a SSE most — `packages/app/src/app/lib/workspace-routing.ts`, `context/workspace-server-sync.tsx`, `lib/engine-sse.ts`. Před úpravou si načti `docs/memory/frontend.md` (pravidlo repa).
- E2E: specy/helpery sahající na daemon routy (grep `daemon`/`orchestrator` v `packages/e2e/`).
- Reporty: `analyza/desktop.md`, `analyza/multi-workspace.md` §1 („Kdo co spouští"), `analyza/ipc-http-parita.csv` kategorie C2 (13 lifecycle příkazů — ve splitu z FE mizí).

**Kroky:**
1. V Rustu zaveď přepínač `VESLO_LEGACY_ORCHESTRATOR=1` (default **off** = embedded). Embedded větev: spawn `veslo-server` s `VESLO_EMBEDDED_ENGINE=1` a `--opencode-bin <cesta k engine sidecar binárce — jméno po fázi 1, pravděpodobně "opencode", ověř v prepare-sidecar.mjs>`; `--orchestrator-url` se nepředává; `spawn_orchestrator_daemon` se nevolá.
2. Health/stav: Rust polling démona (`orchestrator_engines_list` apod.) přesměruj na serverové ekvivalenty (`/health`, workspace registry). IPC příkazy kategorie C2, které jen proxovaly na daemon (`orchestrator_workspace_activate` je v Rustu jen HTTP klient, `commands/orchestrator.rs` ~ř. 698), přepni na server routy (`POST /workspaces/:id/activate`).
3. FE base URL: hodnota, ze které FE staví engine mount pro SDK klienty a SSE most, musí ukazovat na server (`http://127.0.0.1:<server-port>/workspace/<id>/opencode`). Mechanismus (SDK klienti, Rust SSE most) se **nemění** — jen cíl. Ověř tokem: odkud FE tuto URL dnes bere (Tauri event/state) a přepni zdroj.
4. E2E specy závislé na daemonu uprav na server routy.
5. Build a manuální test na **macOS i Windows** (tvrdý požadavek ZADANI.md) — na Windows zejména spawn/taskkill heuristiky a cesty.

**Ověření:**
```bash
cd "$(git rev-parse --show-toplevel)"
cd packages/desktop && cargo check && cd ../..
pnpm typecheck
cd packages/desktop && pnpm exec tauri build --debug --no-bundle -- --features e2e && cd ../..
# Spustit desktop, pak:
ps aux | grep -E "veslo-orchestrator" | grep -v grep     # → prázdné
ps aux | grep -E "veslo-server|veslo-code|opencode" | grep -v grep # → server + engine po jednom
# (engine proces se jmenuje podle stavu po fázi 1 — pravděpodobně `opencode`, viz krok 1)
# UI smyčka přes WebDriver (port 4445, dle pravidel repa):
# přidat 2 složky, v každé session + zpráva, ověřit že odpovědi nekříží workspace,
# přepínání složek bez chybových badge, restart aplikace → obnovení stavu.
./scripts/veslo-screenshot.sh
```

**Hotovo znamená:**
- Po startu desktopu běží právě 3 procesy (shell, server, engine); vše z UI smyčky výše funguje na Mac i Windows.
- `VESLO_LEGACY_ORCHESTRATOR=1` vrací starou topologii (ověř jedním smoke).
- Regresní sada z fáze 0 zelená.

**Rizika a rollback:**
- Nejrizikovější balíček fáze — mění runtime topologii pod běžícím UI. Mitigace: legacy přepínač + push až po manuálním otestování obou platforem.
- FE může mít skryté závislosti na orchestrátor URL (diagnostické stránky, settings) — grep `orchestrator` v `packages/app/src` a projdi nálezy; co je jen diagnostika, přesměruj nebo skryj.
- Rollback: `VESLO_LEGACY_ORCHESTRATOR=1` (kód staré cesty existuje do 2.4).

**Odhad:** 2 sessions.

---

### Balíček 2.4 — Smazání orchestrátoru, tenké CLI, headless supervize

**Cíl:** `packages/orchestrator` zmizí z repa, buildů i bundlu. Je rozhodnuto a zdokumentováno, co zůstává jako tenké CLI a kdo superviduje server v headless režimu.

**Vstupy:**
- `packages/orchestrator/` (celý — po 2.1–2.3 už z něj nic neběží v desktop cestě),
- rozdělení `cli.ts` (6 934 ř.) dle analyza/orchestrator.md: **do serveru šlo** (2.1–2.2): spawn/health/proxy/config-sync/run-lifecycle; **maže se**: `runRouterDaemon` (~1 780 ř. HTTP daemon vrstvy), `runStart`/`serve` host mode (~800 ř.), TUI (`src/tui/app.tsx` 884 ř. + 8 `@opentui/*` závislostí), download/manifest/SHA mašinerie binárek (~700 ř., cli.ts ~ř. 835–1683 — desktop má binárky bundlované vedle sebe), klientské podpříkazy `approvals`/`files`/`status` (~600 ř. curl wrapperů na server API), mrtvé flagy (`--opencode-workdir`, `--opencode-port` v daemon režimu); **tenké CLI**: viz krok 3,
- `packages/desktop/scripts/prepare-sidecar.mjs` + `tauri.conf.json` (seznam sidecarů), `scripts/dev-headless-web.ts` (279 ř. — dnes spawnuje orchestrátor `dev -- start`), `packaging/docker/`, root `package.json` skripty, `RELEASE.md` (npm publishing `veslo-orchestrator`),
- Rust zbytky: `orchestrator/mod.rs`, `commands/orchestrator.rs`, legacy přepínač z 2.3,
- server: `orchestrator-lifecycle-client.ts`, `orchestrator-workspace-registration-scope.ts`, fallback větve v `server.ts` (~ř. 1218–1489), flagy `--orchestrator-url`/`--orchestrator-lifecycle-token` v `config.ts` (ř. 190–195),
- Reporty: `analyza/orchestrator.md` §Duplicity a náměty 2/5, `analyza/build-pipeline.md`, `analyza/SYNTEZA.md` otázka 7 (kdo superviduje server).

**Kroky:**
1. `dev-headless-web.ts` a Docker entrypoint přepni na přímý start `veslo-server` s `VESLO_EMBEDDED_ENGINE=1` (+ `--workspace` pro dev pohodlí — flag existuje, `config.ts:200`).
2. Smaž `packages/orchestrator`, jeho přípravu v `prepare-sidecar.mjs`, položku v `tauri.conf.json`, workspace referenci v `pnpm-workspace.yaml`/root package.json a všechny CI kroky, které ho buildí.
3. Tenké CLI — návrh (potvrdit s Pavlem, viz otevřené otázky): **npm balíček `veslo-orchestrator`/`veslo` se přestává publikovat**; jediné CLI je `veslo-server` (má už `--workspace`, `--port`, `--token`). Pokud Pavel chce zachovat `veslo start` UX pro CLI uživatele, vytvoří se ~100ř. wrapper, který jen spustí `veslo-server` — nic víc.
4. Smaž legacy větve: Rust (`orchestrator/mod.rs`, daemon commandy, `VESLO_LEGACY_ORCHESTRATOR` přepínač), server (lifecycle HTTP klient, registrace do orchestrátoru, fallback heuristiky podle textů chyb, orchestrátor flagy configu), FE wrappery C2 příkazů, které už nikdo nevolá (`orchestratorStartDetached` byl mrtvý už v analýze).
5. Přepiš `check:services`: `scripts/headless-services.integration.test.mjs` nahraď embedded variantou z 2.1 (root `package.json:23` — pozor, `scripts/quality-workflow.test.mjs:44` zamyká přesný obsah skriptu, uprav i ten).
6. Zdokumentuj supervizi serveru (nový soubor `docs/dev/backend-supervision.md`): desktop = Tauri (spawn + ready handshake + restart), Docker = restart policy kontejneru, dev = `dev-headless-web.ts`/ruční start. **Vědomé rozhodnutí:** restart serveru = restart enginu (engine je child, kill-on-exit); přežití enginů přes restart serveru se neřeší (odpověď na SYNTEZA otázku 7 — potvrdit s Pavlem, viz otevřené otázky).

**Ověření:**
```bash
cd "$(git rev-parse --show-toplevel)"
# POZOR: brace-glob v `--include="*.{ts,rs,…}"` grep NEexpanduje (GNU ani BSD) — takový příkaz
# vždy „potvrdí“ 0 výskytů. Proto git grep s pathspec exclude (ověřeno funkční):
git grep -nE "veslo-orchestrator|packages/orchestrator" -- \
  ':!docs' ':!*.lock' ':!pnpm-lock.yaml' ':!node_modules'   # → 0 produkčních výskytů
pnpm install && pnpm typecheck
cd packages/desktop && cargo check && pnpm exec tauri build --debug --no-bundle && cd ../..
pnpm check:services                              # nyní embedded topologie
pnpm dev:web  # + curl scénář se 2 workspace z 2.1
# Plný bundle check (počet sidecarů):
ls "packages/desktop/src-tauri/target/debug/" | grep -c "veslo"
```

**Hotovo znamená:**
- Repo bez `packages/orchestrator`; bundle bez orchestrátor binárky; `check:services` testuje embedded topologii; dev:web i Docker běží multi-workspace; supervize zdokumentovaná.

**Rizika a rollback:**
- Bod bez návratu (velké smazání). Mitigace: samostatný commit „delete orchestrator" (snadný revert), provést až po manuálním otestování 2.3 na obou platformách; push tohoto commitu až po dalším kole manuálního testu.
- `quality-workflow.test.mjs` a další source-contract testy mohou zamykat smazané skripty — oprav je společně, ne obcházej.

**Odhad:** 1–2 sessions.

---

### Balíček 2.5 — Jediný jmenný prostor workspace ID

**Cíl:** Jedno kanonické schéma workspace ID vlastněné serverem — konec nezávislých ID schémat FE/Tauri/server/orchestrátor (orchestrátor už neexistuje, zbývá sjednotit server, Tauri persistence a FE). Žádné mapování `serverWorkspaceId` ↔ `appWorkspaceId`, žádné množiny kandidátů při lookupu.

**Vstupy:**
- Algoritmus: `workspace-id.ts` (78 ř., `ws-<sha1(path)>`) — do serveru přenesený v 2.1 (je v transferovém seznamu kroku 1; orchestrátorový originál zanikl v 2.4), FE je na SHA1 schéma historicky zarovnané (fix `e8d2982a`, analyza/multi-workspace.md jizva 3),
- server: registr workspace (`routes/workspace-management.ts`, 511 ř.; registrace v `server.ts`), místa generující/přijímající ID,
- Tauri: `veslo-workspaces.json` persistence, `workspace/server_client.rs` (registrace `POST /workspaces/local`),
- FE: `context/workspace-server-sync.tsx` (ř. 38–40 — komentář o nezávislých ID stores), lookup helpery procházející kandidáty (grep `serverWorkspaceId`, `appWorkspaceId`),
- migrační kód: `workspace-runtime-migration.ts` ekvivalenty, legacy-ID větve,
- Reporty: `analyza/multi-workspace.md` jizva 3, `analyza/SYNTEZA.md` §1.2 (registr workspace: 3 pravdy), `ZADANI.md` (čistý start OK — **žádná migrace ID se nedělá**).

**Kroky:**
1. Kanonizace na serveru: jediná funkce `workspaceIdFromPath(absolutePath)` — normalizace cesty (symlinky, trailing slash, **case-insensitive FS na macOS/Windows** — normalizuj konzistentně) + `ws-<sha1>`. Server ji vynucuje při registraci; ID v odpovědi je jediné, které kdy existuje.
2. Tauri a FE ID **nederivují** — přebírají ID z odpovědi serveru. `veslo-workspaces.json` degraduje na cache posledního známého seznamu (nebo se ruší, pokud FE stav stačí — rozhodni podle toho, co Tauri z persistence skutečně čte při startu; menší zásah vyhrává).
3. Smaž mapovací a migrační kód: kandidátní lookupy, legacy-ID větve, `workspace_registry_unsynced` smiřovací logiku tam, kde po sjednocení nemá co smiřovat.
4. Čistý start: žádná konverze starých dat. Uživatel po upgradu přidá složky znovu (rozhodnutí ZADANI.md).
5. Unit testy kanonizace (různé tvary téže cesty → totéž ID; odlišné cesty → odlišná ID; Windows cesty `C:\...`).

**Ověření:**
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter veslo-server test && pnpm typecheck
# přidání téže složky přes UI a přes curl vrací stejné ID:
curl -s -X POST http://127.0.0.1:8791/workspaces/local -H "x-veslo-host-token: h1" \
  -H "content-type: application/json" -d '{"path":"/tmp/veslo-f2/ws-a"}' | jq .id
grep -rn "appWorkspaceId\|serverWorkspaceId" packages/app/src packages/server/src \
  | grep -v test   # → 0 mapovacích míst (názvy ověř dle skutečného stavu HEAD)
# UI smyčka: přidat/odebrat/přepnout workspace, restart aplikace, stav sedí
```

**Hotovo znamená:**
- V celém repu existuje jediná derivace workspace ID (server); FE/Tauri ID jen přenášejí; mapovací a migrační kód smazán; testy zelené; UI flow beze změny chování.

**Rizika a rollback:**
- Skrytá závislost na starém ID tvaru v datadiru (config diry enginu, SQLite klíče) — projdi, kde se ID používá jako součást cesty/klíče; čistý start to řeší, ale kód nesmí míchat staré a nové v jednom běhu. Doporuč bump datadir verze (nový podadresář), ať se staré artefakty ignorují.
- Rollback: revert commitů balíčku; žádná data k záchraně (čistý start).

**Odhad:** 1–2 sessions.

---

### Balíček 2.6 — Server jako vlastník stavu: workspace = parametr požadavku

**Cíl:** „Aktivní workspace" přestává být serverový režim ovlivňující směrování — každý požadavek nese workspace ID v cestě. Aktivace se mění na idempotentní `ensure` (provisioning + engine ready). Definovaný a sepsaný **cílový tvar API** (`/workspace/:id/...`) jako vstup pro OpenAPI (2.9) a FE migraci (fáze 3). To zabíjí kořenové třídy chyb A, B, D (analyza/dokumentace.md §8 bod 5).

**Vstupy:**
- server: aktivace workspace (dnes `POST /workspaces/:id/activate`; interně „aktivace = reorder pole" — analyza/dokumentace.md třída A, analyza/SYNTEZA.md §1.2), `routes/workspace-management.ts`, globální ne-scoped proxy `/opencode/*` a single-workspace flagy `--opencode-base-url`/`--opencode-directory`/`--workspace-id` (`config.ts` ř. 170–214), routy čtoucí implicitní aktivní workspace (grep `activeId`/`activeWorkspace` v `packages/server/src`),
- Reporty: `analyza/dokumentace.md` §8 (david-eval kontrakt: „frontendový active = jen UI focus"), `analyza/multi-workspace.md` §5 „Poznámka k jádru problému" (workspace jako parametr, ne režim), `analyza/server.md` §7.

**Kroky:**
1. Audit: vypiš všechny routy a interní cesty, jejichž chování závisí na „aktivním" workspace (včetně `/opencode/*` globální proxy a `/workspaces` s `activeId`). Výstup ulož do `docs/prestavba/plan/api-kontrakt.md` (založ soubor — tabulka: routa → workspace-scoped ekvivalent → stav).
2. Každé FE-relevantní funkci zajisti workspace-scoped cestu `/workspace/:id/...` (většina už existuje — ipc-http-parita.csv kategorie A). Ne-scoped varianty označ za deprecated (zatím nemaž — FE je může používat do fáze 3; smazání = úkol fáze 3).
3. `POST /workspaces/:id/activate` → nová sémantika `POST /workspace/:id/ensure`: idempotentně zajistí provisioning + engine ready; **nemění** směrování ostatních požadavků. Starý název zůstává jako alias se stejným (novým) chováním. Reorder/implicitní fallback logiku odstraň ze serveru.
4. UI preference „která složka je vybraná": zaveď malý endpoint `GET/PUT /ui-state` (server-owned, přežije restart, funguje pro víc oken) — čistá preference bez vlivu na routing. (Alternativa FE-local — viz otevřené otázky; do rozhodnutí Pavla implementuj server-owned, je to deklarovaný cílový kontrakt z david-eval.)
5. Sepiš cílový tvar API do `api-kontrakt.md`: seznam workspace-scoped rout pro must-keep funkce (workspace, konverzace/runs, skills, MCP, soubory, events) + zásady (ID vlastní server, žádný implicitní aktivní fallback, chybové kódy).

**Ověření:**
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter veslo-server test && pnpm check:services
# Paralelní práce bez jediného "activate":
# terminál A: submit do ws-a; terminál B: současně submit do ws-b;
# oba transkripty správně, žádné křížení (kritický scénář multi-workspace)
# UI regrese: přepínání složek v desktopu beze změny chování
```

**Hotovo znamená:**
- Žádná serverová routa nemění chování podle „aktivního" workspace; paralelní curl scénář prochází; `api-kontrakt.md` existuje a pokrývá must-keep povrch; UI beze změny chování.

**Rizika a rollback:**
- FE dnes na aktivačních vedlejších efektech závisí (provisioning při přepnutí) — alias se sémantikou `ensure` je musí pokrýt; otestuj UI přepínání důkladně (historicky nejporuchovější oblast, multi-workspace.md §3).
- Rollback: alias zachovává tvar API — revert je lokální na server commity.

**Odhad:** 1–2 sessions.

---

### Balíček 2.7 — Serverové SSE s kurzorem: jeden event kanál

**Cíl:** Server vystaví `GET /workspace/:id/events/stream` — SSE kanál s kurzorem (`Last-Event-ID` + replay), který nese serverové události (run stavy, reload, provisioning) i normalizované engine události ve **Veslo-owned envelope** (ne SDK typy — anti-corruption vrstva dle ZADANI.md). Nahrazuje do budoucna polling `GET /workspace/:id/events` (ten zatím zůstává) a připravuje zánik trojitého doručování událostí SSE→Rust→IPC→UI (SYNTEZA §5.4).

**Vstupy:**
- server: `src/events.ts` (54 ř. — in-memory reload events s kurzorem), `routes/workspace-management.ts` ř. 438–446 (`GET /workspace/:id/events` — **pozor: je to JSON polling, ne SSE**; empiricky potvrzeno v doplneni.md Mezera 3), run lifecycle události z 2.2, engine event subscription z 2.1 (`subscribeEngineEvents`),
- normalizace eventů: `opencode-event-normalization.ts` přenesený z orchestrátoru (2.1) — ~24 SSE event typů, 8 part typů (analyza/opencode-vazba.md),
- Reporty: `analyza/SYNTEZA.md` §5.3 bod 6, `analyza/server.md` §3 pozn. („server nemá žádný vlastní SSE endpoint") a §7 bod 2, `analyza/doplneni.md` Mezera 3 (tabulka Streaming).

**Kroky:**
1. Event bus v serveru: per-workspace monotónní sekvence `seq`, ring buffer (např. 1 000 událostí) pro replay; při kurzoru staršímu než buffer pošli `{"type":"reset"}` a klient si stáhne snapshot přes REST.
2. Envelope (Veslo-owned, definovaný na serveru): `{ seq, ts, workspaceId, type, payload }`; typy: `run.*` (z lifecycle owneru 2.2), `reload.*` (z events.ts), `provision.*`, `engine.*` (normalizované engine události — server je **jediný** konzument engine SSE, překládá do vlastních typů; SDK typy nesmí protéct do envelope).
3. Endpoint `GET /workspace/:id/events/stream`: SSE (`text/event-stream`), `id:` = seq, podpora `Last-Event-ID` hlavičky i `?cursor=` query, heartbeat komentář à ~15 s (proti proxy timeoutům), auth stejná jako ostatní client routy.
4. Polling `GET /workspace/:id/events` zůstává funkční (FE ho může používat do fáze 3) — interně čti ze stejného busu, ať existuje jediná pravda o pořadí událostí.
5. Kontrakt (typy, replay sémantika, reset) zapiš do `docs/prestavba/plan/api-kontrakt.md` — vstup pro 2.9 a pro fázi 3 (FE `EventSource`).
6. Unit testy busu (pořadí, replay, reset) + integrační test: curl stream, souběžný submit, události tečou; reconnect s `Last-Event-ID` dostane zmeškané.

**Ověření:**
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter veslo-server test
# terminál A:
curl -s -N -H "authorization: Bearer t1" \
  "http://127.0.0.1:8791/workspace/<ws-id>/events/stream"
# terminál B: submit zprávy → v A tečou run.* události s rostoucím id:
# pak A přeruš, znovu připoj s Last-Event-ID → dorazí zmeškané události
pnpm check:services
```

**Hotovo znamená:**
- Stream funguje s replayem; engine i serverové události v jednom kanálu ve Veslo envelope; žádný `@opencode-ai/sdk` typ v public kontraktu; polling endpoint čte z téhož busu; testy zelené. FE se zatím nemění.

**Rizika a rollback:**
- Normalizace engine událostí je vazba na verzi OpenCode (~24 typů) — drž ji v jednom souboru s exhaustivním switch + `unknown` fallback (neznámý typ = předat jako `engine.raw`, nespadnout).
- Rollback: nový endpoint je aditivní — smazání ničemu neublíží.

**Odhad:** 1–2 sessions.

---

### Balíček 2.8 — Auth pro ne-localhost + bezpečný bootstrap

**Cíl:** Server je bezpečně vystavitelný mimo localhost: CORS default není `*`, žádné tokeny/hesla v argv žádného procesu, auditované ne-autentizované routy, dokumentovaný bootstrap desktop↔server. (Dnešní stav: default `corsOrigins = ["*"]` — `config.ts:434`; orchestrátor s tokeny v argv zanikl v 2.4, ale zbytek je třeba dotáhnout.)

**Vstupy:**
- server: `config.ts:434` (CORS default), `server.ts` `withCors` (~ř. 2896) a `requireClient`/`requireHost` (~ř. 2922–2968), `routing.ts` (auth mód per routa — najdi všechny `auth: "none"`), `tokens.ts` (scope tokeny), toy-ui (smazáno v balíčku 1.11 — schváleno 2026-07-19; pokud by při re-planu ještě existovalo, vypni default zde),
- bootstrap: `packages/desktop/src-tauri/src/veslo_server/spawn.rs` (secrets file `VESLO_SECRETS_FILE`, ready handshake `VESLO_SERVER_READY`; test ~ř. 1060 ukazuje, co všechno jde do argv — projdi a přesuň citlivé do secrets file), engine spawn v `packages/server/src/engine/engine-process.ts` (heslo enginu jen env, nikdy argv),
- Reporty: `analyza/orchestrator.md` §Rizika (CORS `*`, tokeny v argv viditelné v `ps aux`), `analyza/server.md` §2 Autentizace a §9, `analyza/dokumentace.md` §10 bod 4.

**Kroky:**
1. CORS: default `corsOrigins` = **pouze webview originy Tauri** (`tauri://localhost`, na Windows `http://tauri.localhost`) — nic dalšího. Ve fázi 2 desktop FE volá server přes tauri-plugin-http (fetch dělá Rust — CORS se neuplatní) a same-origin web UI ho nepotřebuje; webview originy v defaultu ale musí být, protože fáze 3 přepíná FE na přímý `fetch`/`EventSource` z webview a prerekvizita P8 fáze 3 s tím počítá (bez toho by práce visela mezi fázemi bez vlastníka). Web/Docker režim si další origin explicitně nastaví (`--cors https://…`). Hodnotu `*` povolit jen explicitně (a zalogovat varování).
2. Audit `auth: "none"` rout: projdi `routing.ts` registrace; bez auth smí zůstat jen `/health` (a případné nutné bootstrap routy — každou výjimku zdůvodni v komentáři). Pozn.: automations a soul routy zůstávají (funkce se zachovávají) a musí projít auth auditem jako každá jiná routa.
3. Argv hygiena: server čte tokeny výhradně ze secrets file (`VESLO_SECRETS_FILE`) nebo env; odstraň citlivé hodnoty z argv při spawnu (Rust) i z dokumentovaných diagnostických postupů (CLAUDE.md workdir návod „auth z ps aux" přestane fungovat — pozn. pro Pavla: aktualizovat pracovní docs/memory, mimo repo). Engine heslo: generované per start, předané env, nikdy argv.
4. Bootstrap desktop↔server zdokumentuj v `docs/dev/backend-supervision.md` (rozšíření z 2.4): Rust vygeneruje tokeny → zapíše secrets file (0600) → spawn → ready handshake → FE dostane client token přes IPC. Síťový režim: bearer tokeny + explicitní CORS; TLS terminace je mimo scope (reverse proxy), Den login handoff beze změny (Den zůstává povinný, ZADANI.md).
5. Negativní testy: request bez tokenu → 401 na všech client/host routách; cizí `Origin` → žádné `Access-Control-Allow-*` hlavičky.

**Ověření:**
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter veslo-server test
# bez tokenu:
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8791/workspaces   # → 401
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8791/health       # → 200
# cizí origin:
curl -s -D - -o /dev/null -H "Origin: https://evil.example" \
  http://127.0.0.1:8791/health | grep -i access-control                   # → nic
# žádná tajemství v procesech:
ps aux | grep -E "veslo-server|veslo-code|opencode" | grep -v grep | grep -iE "token|password" # → nic
# desktop: přihlášení přes Den + běh agenta stále funguje (manuálně v UI)
```

**Hotovo znamená:**
- Výchozí konfigurace bez CORS `*`; jediná ne-auth routa `/health` (+ zdůvodněné výjimky); žádná tajemství v argv; desktop login i běh agenta fungují; testy včetně negativních zelené.

**Rizika a rollback:**
- Utažení auth může rozbít skryté konzumenty (workspace pluginy čtou `VESLO_SERVER_STATE_PATH` s baseUrl+clientToken a volají server — server.md §9; delegate plugin musí dál fungovat, jeho token je client token, ne cookie). Otestuj skill/MCP flow v UI.
- Rollback: konfigurační defaulty — revert commitů vrací původní chování bez zásahu do dat.

**Odhad:** 1–2 sessions.

---

### Balíček 2.9 — OpenAPI kontrakt + generovaný TS klient + zmrazení

**Cíl:** Strojově čitelný kontrakt BE↔FE: OpenAPI 3.1 specifikace cílového povrchu, generovaný TS klient jako workspace balíček, CI kontrola driftu a pravidlo **jen aditivních změn**. To je hranice BE/FE dle ZADANI.md a přímá prevence historie „kontrakt revidován 41×" (SYNTEZA §5.3 bod 6).

**Vstupy:**
- `docs/prestavba/plan/api-kontrakt.md` (z 2.6 + 2.7 — cílový povrch a event kontrakt),
- server: `src/routing.ts` (62 ř. — mini-router; routy jsou registrované datově přes `addRoute`, takže jde vyrobit inventory), `src/routes/*` (22 souborů), po fázi 1 ořezané o volitelné povrchy,
- Reporty: `analyza/SYNTEZA.md` §5.3 bod 6 a otázka 9 (CalVer bez verzování API), `analyza/dokumentace.md` §8, `ZADANI.md` (hranice = generovaný klient, žádné křížové importy).

**Kroky:**
1. Zvol přístup „spec jako zdroj pravdy": ručně psaná `packages/server/openapi.yaml` (OpenAPI 3.1) pro **must-keep povrch** (workspace, ensure, konverzace + runs, transcript, skills, MCP, soubory, events + events/stream, health, capabilities). Deprecated/interní routy do spec nepatří — vedou se v allowlistu.
2. Kontraktní test (`packages/server/src/contract/openapi-inventory.test.ts`): route inventory z `routing.ts` registrací ↔ spec paths; každá spec cesta existuje v serveru a každá serverová routa je buď ve spec, nebo v explicitním allowlistu (`internal-routes.json`). Test padá při driftu.
3. Generovaný klient: nový workspace balíček `packages/api-client` (`@neatech/veslo-api-client`) — `openapi-typescript` pro typy + tenký fetch wrapper (bearer token, base URL, SSE helper pro events/stream). Žádná ruční logika navíc — jen generát + wrapper.
4. CI: krok `pnpm --filter @neatech/veslo-api-client generate && git diff --exit-code` (klient je vždy v sync se spec) + kontraktní test v `pnpm check`.
5. Pravidlo zmrazení (zapiš do `AGENTS.md` a do hlavičky `openapi.yaml`): změny kontraktu **jen aditivní** — nová pole optional, nové routy ano, přejmenování/odebrání/změna typu jen s vědomým rozhodnutím vlastníka a záznamem v `docs/prestavba/plan/api-kontrakt.md` (changelog sekce). Verzování v cestě se nezavádí (rozhodnutí viz otevřené otázky).
6. Smoke: skript, který přes vygenerovaný klient zavolá `/health`, `GET /workspaces`, vytvoří konverzaci a přečte transcript (spustitelný proti lokálnímu serveru).

**Ověření:**
```bash
cd "$(git rev-parse --show-toplevel)"
pnpm --filter @neatech/veslo-api-client generate
git diff --exit-code packages/api-client/
pnpm --filter @neatech/veslo-api-client build
pnpm --filter veslo-server test        # včetně openapi-inventory testu
node packages/api-client/scripts/smoke.mjs --base http://127.0.0.1:8791 --token t1
```

**Hotovo znamená:**
- `openapi.yaml` pokrývá must-keep povrch; inventory test zelený; klient balíček se generuje a builduje; CI drift check aktivní; pravidlo aditivních změn zapsané. FE klient **zatím nepoužívá** — adopce a import-ban lint je fáze 3.

**Rizika a rollback:**
- Riziko „spec divadlo": spec bez vynucení degraduje jako předchozí dokumentace. Vynucení je právě inventory test + git-diff check — bez nich balíček není hotový.
- Rollback: aditivní artefakty — smazání spec/klienta nic nerozbije.

**Odhad:** 2 sessions.

---

## 6. Souhrn rizik fáze

1. **Změna runtime topologie pod běžícím UI (2.3)** — historicky nejporuchovější oblast projektu je workspace switching a event delivery (multi-workspace.md §3, VSLO-86). Mitigace: feature flag + legacy přepínač, přepnutí jako samostatný balíček, manuální test na Mac i Windows před smazáním staré cesty (2.4), push až po manuálním otestování.
2. **`check:services` je nejcennější existující test** (jediný test skutečné BE kompozice — doplneni.md Mezera 5) a fáze ho přepisuje. Mitigace: v 2.1 vzniká embedded varianta **vedle** staré; stará se maže až v 2.4, takže v žádném okamžiku není BE kompozice bez testu.
3. **Restart serveru = restart enginu = přerušení všech běžících runů.** Vědomý trade-off jednoho procesu (SYNTEZA otázka 7). Mitigace: run lifecycle owner (2.2) musí přerušené runy korektně terminalizovat (engine-loss úklid) — uživatel vidí failed run, ne zombie.
4. **Windows parita** — spawn/kill logika, cesty, case-insensitive FS (2.3, 2.5). Mitigace: build + smoke na Windows po 2.3 a 2.4, ne až na konci fáze.
5. **Skryté kontrakty** — workspace pluginy (`VESLO_SERVER_STATE_PATH`), e2e helpery na daemon routách, source-contract testy zamykající obsah skriptů (`quality-workflow.test.mjs`). Mitigace: grep před smazáním, opravit společně se změnou.
6. **Rozsah přenosu z `cli.ts`** — 6 934 ř. božského souboru; hranice mezi „přenést" a „smazat" se může při práci posouvat. Mitigace: balíček 2.1 přenáší jen vyjmenované moduly; vše ostatní je default „smazat v 2.4"; nejasnosti eskalovat, ne tiše přenášet.
7. **Disciplína kontraktu** — bez vynucení (2.9) se kontrakt zase rozjede (41 revizí historicky). Mitigace: inventory test + CI diff check jsou součást DoD, ne follow-up.
8. **Feature freeze creep** — sloučení svádí k vylepšování (redukce konverzační pipeline, refactor server.ts). Mimo zadání balíčků se nic nevylepšuje; kandidáty zapisovat do `docs/prestavba/plan/napady-pozdeji.md`.

---

## 7. Otevřené otázky

**Musí rozhodnout Pavel:**

1. **Osud npm CLI** (`veslo-orchestrator`/`veslo` na npm, balíček 2.4): přestat publikovat úplně (návrh plánu), nebo udržet tenký wrapper `veslo start` nad `veslo-server`? Render/cloud cesta je stejně rozbitá (male-services.md) a router je pryč.
2. **Restart serveru = restart enginu** (2.4): akceptuješ, že update/restart backendu přeruší běžící runy ve všech složkách (runy se korektně terminalizují, transcript zůstává)? Alternativa (přežití enginů přes restart serveru) je výrazně složitější a plán ji nenavrhuje.
3. **UI preference aktivní složky** (2.6): server-owned `/ui-state` (návrh plánu — přežije restart, funguje pro víc oken), nebo čistě FE-local (localStorage)?
4. **Verzování API** (2.9): postačí pravidlo „jen aditivní změny" bez verze v cestě (návrh plánu, odpovídá SYNTEZA otázce 9 s N-1 kompatibilitou přes aditivnost), nebo chceš `/v1/` prefix od začátku?
5. **Závazek „žádné WebSockety"** (SYNTEZA otázka 10): plán staví vše na SSE. Potvrdit jako trvalé rozhodnutí (ovlivňuje budoucí proxy/deploy scénáře).

**Musí ověřit fáze 0 / začátek fáze 2 (blokátory):**

6. **P3 — per-workspace konfigurace ve shared enginu** (jizva 4, multi-workspace.md): jak přesně to fáze 1 vyřešila (config per session directory vs. per request)? Bez odpovědi nelze začít 2.1 — embedded runtime přebírá tento model. (Pokud fáze 1 skončila větví B balíčku 1.8, platí varianta „Větev B z fáze 1“ v §2 — 2.1 pak přebírá pool.)
7. **Skutečný tvar workspace ID na serveru na aktuálním HEAD** (2.5): analýza doložila nezávislá ID schémata a zarovnání FE na SHA1 (fix `e8d2982a`); před 2.5 ověřit, co z toho po fázi 1 zbylo, a podle toho zúžit/rozšířit kroky.
8. **Co všechno jde dnes do argv serveru z Rustu** (2.8): test `spawn.rs:1060` naznačuje, že tokeny mohou být v argv i při existenci secrets file — ověřit na HEAD a podle toho určit rozsah argv hygieny.
9. **Fáze 3 počítá s tím, že Rust SSE most (`commands/engine_sse.rs`) žije až do FE přechodu na `EventSource`** — v 2.3 se jen přesměrovává. Koordinovat s plánem fáze 3, aby se nesmazal dřív.

---

*Konec plánu fáze 2. Navazuje: fáze 3 (frontend na jediném HTTP/SSE kontraktu — přepnutí `invoke()` → generovaný klient, zánik Rust SSE mostu, redukce IPC na ~11 nativních příkazů).*
