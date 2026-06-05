# Oponentura — Conversation Service plán

> Protidokument k `TEMPORARY_IMPLEMENTATION_PLAN_CONVERSATION_SERVICE_CODEX.md`.
> Datum: 2026-06-05. Autor: Claude (Opus 4.8), na vyžádání.
> Cíl: ne plán zabít, ale opravit **vlastníka** a **sekvenci**, dokud se nezačalo psát.

## Zdroje, o které se opírám

- `docs/sandbox/architecture.md` a `docs/sandbox/data-flows.md` (živá topologie, 2026-06-05)
- `dev-specific/conversation-id-ui-migration-note-2026-06-05.md` (co už je nasazené, dnešní stav)
- `dev-specific/codex-conversations-2026-06-04/audit-summary.md` + `missing-code-audit-2026-06-04.md`
- skutečný kód: `packages/server/src/server.ts`, `conversation-binding-store.ts`,
  `conversation-read-store.ts`, `packages/orchestrator/src/{engine-pool,router-proxy}.ts`,
  `packages/app/src/app/context/{session,workspace-routing}.ts`

---

## TL;DR

Směr plánu (server vlastní intent, OpenCode je interní engine) je **správný a krytý**
kořenovým `ARCHITECTURE.md` ("server jako jediný API povrch… stejné flow desktop/mobil/web,
audit a approvals centrálně"). Ale plán má tři problémy, které jsou levné opravit teď a drahé později:

1. **Špatný vlastník.** Plán dává *conversation-grained run ownership* do `veslo-server` (:8787).
   Jenže `veslo-server` **není v SSE cestě** a **není vlastníkem engine lifecycle**. Obojí už dělá
   **orchestrator**. Plán zakládá třetí místo, které si myslí, že vlastní běh.
2. **Nosná zeď je odložená na „Later".** Jediná věc, co dělá run-ownership *pravdivým* — interpretace
   engine SSE streamu na úrovni konverzace — je v plánu poslední „Later" bullet. Bez ní je `conversation_run`
   tabulka dekorativní a bude lhát.
3. **Špatné tempo.** Repo je uprostřed VSLO-86 stabilizace a čerstvě po destruktivním recovery incidentu.
   Konzervativní slice už je nasazený a záměrně drží „conversationId = jen server metadata". To je správné
   tempo. Velký ownership build teď jde proti němu.

Pořadí důležitosti námitek níže: **O1 a O2 jsou blokující**, zbytek jsou opravy detailů.

---

## Co plán trefuje správně (ať je to fér)

- Identita musí být Veslo `conversationId`, ne OpenCode `session.id`. Ano.
- UI nesmí být autorita nad tím, který session/dir/workspace dostane práci. Ano.
- Deterministické conversation ID + binding store + fail-closed na neznámém ID / dir mimo workspace. Ano,
  a **už to běží** (viz níže).
- Varování před „thin proxy, co nechává ownership v UI". Správná intuice — plán ji ale poruší sám,
  jen o vrstvu níž (viz O2).

---

## Skutečný stav teď (premisa plánu je zčásti zastaralá)

### Topologie není „UI → server → OpenCode". Je to mesh přes orchestrator.

Z `docs/sandbox/architecture.md` + `data-flows.md` (živý dev stav):

```
UI (Tauri webview)
  ├─ HTTP → veslo-server :8787        (persistent state, config, AI-gateway proxy)
  ├─ HTTP → orchestrator daemon       (engine pool, lazy spawn, suspend, crash monitor)
  │           └─ HTTP proxy → OpenCode engine (1 per workspace, WSL2/bwrap | sandbox-exec)
  └─ Rust SSE proxy (engine_sse.rs) → engine /event  (PŘES orchestrator proxy)

veslo-server  ── OpenCode volání ──►  orchestrator  ──►  engine
   (:8787 /workspace/<id>/opencode -> daemon -> engine; viz data-flows Flow 4)
```

Důsledky, které plán nereflektuje:

- **UI nikdy nemluví s engine přímo.** Vždy přes orchestrator proxy. `veslo-server` taky OpenCode
  volá *přes orchestrator* (`fetchOpencodeJson` → daemon `/workspace/<id>/opencode`).
- **Engine lifecycle už vlastní orchestrator** (`engine-pool.ts`): `pool.ensure()`, idle suspend,
  crash restart, `lastSuccessfulRunStartedAt`. Plán tohle odbývá jako „Later: orchestrator-owned
  run lifecycle manager" — ale ten vlastník **už existuje**, jen na úrovni enginu, ne konverzace.
- **SSE jde engine → orchestrator (transparentně) → Rust proxy → webview.** `router-proxy.ts` stream
  jen pipuje, **neinterpretuje** ho. `veslo-server` v téhle cestě **vůbec není**.

### Conversation identity layer je už NASAZENÝ (konzervativně)

Dle `conversation-id-ui-migration-note-2026-06-05.md` a kódu v `server.ts`:

- `GET /workspace/:id/conversations` už vrací `conversationId` / `opencodeSessionId` /
  `parentConversationId` / `branchId` (přes `attachConversationBindings`).
- transcript route přijímá OpenCode session id **i** Veslo `conversationId`, resolvuje přes
  `conversation-binding-store` a vrací obě identity.
- binding store je hotový a kvalitní (deterministické ID, resolve podle obojího, UNIQUE constraint).
- **UI ale pořád selektuje řádky podle OpenCode `session.id`.** Note explicitně říká:
  *„Until then, treat `conversationId` as server metadata, not as the UI selection key."*

Co **není**: `conversation-service.ts`, `conversation_run` tabulka, run/command/abort endpointy,
klientské metody v UI. (Ověřeno glob/grep — nic z toho neexistuje.)

→ Reálný stav = **pasivní identity vrstva nasazená, aktivní run-ownership nezačal.** To je dobrý
moment plán zpochybnit, protože se ještě nepsal žádný řádek té těžké části.

### Multi-workspace bug je z velké části už ošetřený jinde

VSLO-86 už dodal per-workspace klienty + guard proxy (`WorkspaceClientStaleError`): při přepnutí
workspace mezi sync lookupem a async SDK voláním to **fail-closed vyhodí** místo zápisu do špatného
enginu (`workspace-routing.ts`, demonstrováno v `data-flows.md` Flow 5). Plán tenhle existující
mechanismus nikde nezmiňuje.

---

## Hlavní námitky

### O1 — Špatný vlastník run lifecycle *(blokující)*

**Plán:** Conversation Service na `veslo-server` je „the only module that converts conversationId into
opencodeSessionId" a vlastní run lifecycle rows + status transitions.

**Realita:** `veslo-server` je proces pro **persistent state + config + AI-gateway proxy**. Pro OpenCode
je to jen další proxy hop *před* orchestratorem. **Není v SSE cestě** a **nevlastní engine lifecycle** —
to dělá orchestrator. Conversation-grained pravda o běhu dnes žije jedině v UI (`session.ts` čte SSE).

**Riziko:** Vznikne **třetí** místo s vlastním názorem na „co běží": UI (dnes), `veslo-server`
conversation service (plán), orchestrator (engine realita). Přesně tenhle multi-store rozjezd už tým
jednou tvrdě kousl — tři workspace-identity stores nebyly v sync a *„klik na workspace 404'd silently"*
(`architecture.md`, „Workspace identita má 3 store"). Plán to opakuje o úroveň výš, na úrovni runů.

**Co s tím:** Run-state autorita patří tam, kde už je **proxy i event-path** a engine lifecycle:
do **orchestratoru**, nebo rovnou do plánovaného **merge orchestrator + veslo-server** (viz níže).
Ne do `veslo-server` solo. `veslo-server` ať zůstane fasáda (auth, scope, approval, persistence
bindingů), ale truth o běhu ať drží proces, který sedí na streamu.

### O2 — Lifecycle truth (SSE interpretace) je odložená, ale je to páteř *(blokující)*

**Plán:** `conversation_run.status` se odvodí ze synchronní návratovky `prompt_async`/`command`
+ „known behavior"; idle→completed mapování; event mirroring je „Later".

**Realita:** Skutečná pravda o běhu (stream, tool kroky, permission, přechod na idle, selhání v půlce,
abort z jiného klienta) teče **jen SSE**, které orchestrator pipuje transparentně a interpretuje
ho **jen UI**. `veslo-server` žádný engine event nevidí.

**Riziko:** Bez server-side interpretace SSE bude run tabulka **optimistická a často lživá** — run, co
selže ve streamu nebo doidluje po tool erroru, zůstane „running" navždy, nebo „completed" předčasně.
Akceptační kritérium Phase 3 („map idle→completed") je **nesplnitelné** bez SSE konzumenta. A je to
přesně ten „thin proxy" anti-pattern, před kterým plán varuje — jen spáchaný na úrovni *stavu*, ne *příkazu*.

**Co s tím:** Server-side projekce engine SSE do `conversation_run` (a do normalizovaného Veslo
conversation event streamu) **není „Later" — je to vlastní produkt.** Buď ji udělej součástí prvního
run PR, nebo buď upřímný, že PR1–2 dodávají jen *routing autoritu*, ne *lifecycle autoritu*, a
nepersistuj statusy, které neumíš udržet pravdivé.

### O3 — Čtvrtý identity-sync zdroj bez jednoho vlastníka

`conversation_run` v SQLite `veslo-serveru` je nový zdroj pravdy vedle: UI `selectedSessionId`,
orchestrator engine stavu, OpenCode SQLite transkriptu. Čtyři zdroje, žádný jednoznačný vlastník →
stejná třída bugů jako „404 silently". Když už run store vznikne, musí mít **jednoho** vlastníka
(viz O1) a jasné pravidlo, kdo koho dohání po reconnectu.

### O4 — Časování proti probíhající stabilizaci

`codex-conversations-2026-06-04/audit-summary.md`: tým právě hasí WSL2/bwrap routing, `veslo-server`
OpenCode proxy bug (ZlibError → `Accept-Encoding: identity`, `502 opencode_proxy_failed`), managed-AI
reload dedupe, a čerstvě se zotavuje z destruktivního `git restore . && git clean -fd` (recovery přes
dangling commit `1d1a43d3`, část kódu pořád chybí). Zavádět teď velkou novou ownership vrstvu na
`veslo-server` je riziko proti právě stabilizovanému proxy řetězci. Dnešní note volí správné tempo:
**conversationId zatím jen metadata, UI klíč neflipovat.** Oponentura tohle tempo podporuje.

### O5 — Duplicita s VSLO-86 guard proxy / Phase 1.5 sidecar

Phase 1.5 „scope sidecar" částečně dělá to, co už dělají per-workspace klienti + guard proxy. Plán
musí říct koncový stav: je service **náhrada** guard proxy (proxy = dočasný hack, po dokončení zmizí),
nebo vrstva navíc? Dvě překrývající se anti-cross-workspace pojistky si můžou maskovat bugy.

### O6 — Transcript/hydration contract re-specifikuje existující věc

Plánový „Transcript Identity Contract" + `hydrateTranscriptSnapshot` řeší jako greenfield něco, co
už částečně běží (transcript route už vrací obě identity) a co stojí na existující prefetch cache,
kterou plán nezmiňuje. Dnešní note přesně pojmenovává past: `hydrateTranscriptSnapshot()` dnes kešuje
pod `snapshot.sessionId`; při conversationId-UI by se transkript uložil pod OpenCode id, zatímco UI je
klíčované `conversationId` → prázdná konverzace. Sjednoť s prefetch vrstvou, nezaváděj druhou cache.

### O7 — SQLite write-frequency vs open/close-per-call

`conversation-binding-store` otevírá a zavírá DB na **každé volání** (`withDb`), a v praxi se zapisuje
~jednou. `conversation_run` se mění **několikrát na jeden prompt**, z více workspaců paralelně. Stejný
open/close vzor → kontence na zámku, a sliby „fail closed" se stanou „fail flaky". Chce to jeden
dlouhožijící handle / serializovaný writer.

### O8 — Abort přes „latest run" je nejednoznačný

S message queue můžou koexistovat queued + running run. Abort cílit explicitním `runId`, ne „latest".
A pravda o úspěchu abortu opět přijde jen SSE (viz O2).

### Drobné

- **„Veslo server" je přetížený pojem.** V repu jsou *dva* „servery": lokální `packages/server` (:8787,
  o kterém je plán) a cloud Den / AI Gateway z `docs/plans/2026-05-19-veslo-owned-server-migration.md`.
  Plán to nedisambiguuje — přidej jednu větu, ať to reviewer nesplete.
- **Umístění dokumentu.** Konvence repa: AI plány do `dev-specific-docs/*--claude.md`, durable design
  do `docs/dev`|`docs/features`, `docs/plans/` jen historie. `TEMPORARY_*.md` v rootu je proti tomu
  (tahle oponentura sedí v rootu jen na explicitní přání).

---

## Smysluplnější řešení pro budoucnost projektu

Ne jiná destinace — **jiný nosný prvek a jiná sekvence.**

### 1) Lifecycle authority > routing authority

Routing (který session/dir/workspace) je z ~80 % hotový (bindings + guard proxy). Cenné a trvanlivé je
*jedna komponenta vlastnící pravdu o běhu tím, že konzumuje engine event stream.* Plán utrácí Phase 1–5
na routing a lifecycle háže na „Later". Otoč to.

### 2) Vlastníka dej tam, kde už je proxy + event-path

Run-state autorita patří do **orchestratoru** (už sedí na proxy i SSE, už vlastní engine lifecycle,
už je per-workspace), nebo rovnou do **sloučeného `orchestrator + veslo-server`** — což `architecture.md`
sám navrhuje jako realistický refactor (*„Sloučit orchestrator + veslo-server do jednoho Bun procesu",
odhad ~3 dny*). Ten merge otázku „který proces vlastní conversation service" rovnou rozpustí. `veslo-server`
ať zůstane tenká autorizační/persistenční fasáda nad tím vlastníkem.

### 3) SSE projekce = páteř, ne „Later"

Orchestrator (resp. merged server) ať **vlastní OpenCode SSE subscription a re-emituje normalizovaný
Veslo conversation event stream**, který konzumují všichni klienti. Tohle jedním tahem: (a) udělá
run-state autoritu skutečnou, (b) zkolabuje per-workspace SSE multiplex + guard proxy složitost v UI,
(c) je **jediná** cesta k paritě mobil/web (ti nemůžou každý otevírat přímý engine SSE s tou reconnect/
catch-up logikou, co dnes žije v `session.ts`), (d) zcentralizuje audit/approvals přesně jak chce
kořenový `ARCHITECTURE.md`. Plán to má jako poslední „Later" bullet.

### 4) Ponech konzervativní tempo jako výchozí stav

Už-nasazený slice (conversationId = server metadata, UI klíč neflipovat) je PR0. Velký ownership build
se nestaví teď a nestaví se solo na `veslo-server`.

### 5) Přesekvencování PR

- **PR1:** binding-backed create + run *routing* (reuse hotových kusů). Levné, nízké riziko, zůstává na
  `veslo-server` fasádě.
- **PR2 (těžiště):** SSE konzument ve **vlastníkovi** (orchestrator / merged), který projektuje stav do
  `conversation_run` a vystaví normalizovaný event read. Desktop zatím může jet dál na přímém SSE.
- **PR3:** přemigruj **jeden** klientský povrch na normalizovaný stream → dokázaná parita.
- Abort/permission/command routing **až po PR2**, protože vše závisí na lifecycle autoritě.

### 6) Oddělit dvě motivace (plán je slévá)

- **VSLO-86 multi-workspace korektnost** — levné, skoro hotové (bindings + guard + Phase 1.5 resolve).
  Na tohle full server run-ownership **nepotřebuješ**.
- **Mobil/web parita + centrální audit** — drahé, a *tohle* ospravedlňuje full ownership + SSE hub.

Když se nerozhodne, *kterou* z těch dvou věcí PR řeší, skončí to jako velký build ospravedlňovaný
malým bugem.

---

## Otevřené otázky k rozhodnutí

1. Vlastník run-state: orchestrator solo, nebo počkat na merge `orchestrator + veslo-server`?
2. Je SSE projekce součást prvního run PR, nebo se PR1 explicitně označí jako „jen routing autorita"?
3. Je conversation service náhrada guard proxy, nebo vrstva navíc? (koncový stav VSLO-86)
4. Flipne se UI selection key na `conversationId` v tomhle cyklu, nebo zůstává „metadata only" (dnešní note)?
5. Která ze dvou motivací (VSLO-86 vs. mobil/web) je *driver* prvního PR?
