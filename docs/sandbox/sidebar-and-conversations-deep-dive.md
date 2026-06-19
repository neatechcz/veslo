# Sidebar a konverzace — deep dive (načítání, přepínání, mizení historie)

> Jak se v současném UI načítají proběhlé konverzace, jak funguje
> překlikávání, a proč při přepnutí workspace „zmizí" stará konverzace a
> uživatel se k ní nedostane. Plus: odkud se to bere (DB) a jestli je DB
> dobře nastavená.
>
> Stav k 2026-06-17. Target repo: `…/veslo`. Navazuje na
> [`data-flows.md`](data-flows.md) (Flow 2/3) — pozor, ta je v této oblasti
> **zastaralá** (viz B5).

---

## Stav: opraveno (scope = výpis v sidebaru), 2026-06-17

Zúžený scope dle rozhodnutí: **konverzace se musí spolehlivě vypsat v
sidebaru** z naší host-side DB; transcript (obsah) může dál číst sandbox WSL
`opencode.db`. Implementováno:

- **Owned store je autoritativní a aditivní.** `conversation-service.listConversations`
  vrací **union** sandbox readu a našeho binding-store (`bindings.sqlite`),
  takže prázdný/`unavailable`/podmnožinový sandbox read už seznam nezmenší
  (B3 částečně, hlavní příčina mizení).
- **Binding list odolný vůči directory mismatchi.** `listOpenCodeSessions`
  při 0 shodách dělá workspace-wide fallback (Windows↔WSL path-form rozdíl
  už neskryje vše) — B1 pro list.
- **App nepřepisuje sidebar prázdnem/`unavailable`.** Nový guard
  `shouldPreserveSidebarRowsOnRead` + `applyWorkspaceSidebarReadResult`
  (B3/B4); platí pro `populateSidebarFromDb` i in-store read fallback.
- **Transcript not-found ≠ úspěch.** `getTranscript` vrací `unavailable`
  místo prázdného `sqlite` (D).

Mimo scope (záměrně ponecháno): owned store pro messages/parts, WSL↔Windows
překlad cest pro čtení transcriptu. Tj. B2/B6 a plný transcript-tunel
nejsou součástí této opravy. Sekce níže popisuje původní analýzu.

## 0. TL;DR

- Historie konverzací se **NEčte** přes Tauri z OpenCode SQLite (to je dnes
  mrtvý kód, viz B5). Čte ji **lokální veslo-server read-API** přímo z
  OpenCode `opencode.db` **read-only**, filtrováno přes `directory`; když
  nic nenajde, fallbackuje na perzistentní **binding-store**
  (`conversations/bindings.sqlite`).
- Když engine běží, sidebar bere živý `session.list` z enginu. Když
  neběží (browse mód), bere read-API.
- **Hlavní příčina mizení:** přepnutí workspace spustí
  `populateSidebarFromDb(id, workspace.path)` a výsledek **bezpodmínečně
  přepíše** řádky sidebaru (`replaceWorkspaceSidebarSessions`). Když
  read-API vrátí prázdno **nebo `unavailable`** (nesedící `directory`,
  Windows↔WSL cesta, neotevřitelná DB), řádky se smažou a v browse módu
  **není záchranná cesta** → „nedostanu se zpět".
- **DB jako taková je rozumný design** (čte přímo OpenCode DB + binding
  fallback, žádný druhý plný store k synchronizaci), ale je **křehká** ve
  4 bodech (B1–B4), hlavně na Windows+WSL2.

```
engine běží  → sidebar = c.session.list (živě, filtr dle directory)
engine neběží→ sidebar = veslo-server read-API
                         → OpenCode opencode.db (read-only, WHERE directory=…)
                         → fallback: binding-store (bindings.sqlite)
```

---

## 1. Datové zdroje (3 cesty, ale jen 2 živé)

| Zdroj | Kdy | Soubor |
|---|---|---|
| **Engine live** `c.session.list` | engineReady = true | `context/sidebar-workspace-sessions.ts` |
| **Veslo read-API** (OpenCode `opencode.db` read-only + binding fallback) | browse (engine neběží) / engine nedostupný | `app.tsx listConversationsFromVesloReadApi`, `server/src/conversation-read-store.ts`, `conversation-service.ts` |
| **Tauri `opencode_db_read_*`** (přímý OpenCode SQLite) | **NIKDE** — mrtvý kód | `app/lib/db-reader.ts` |

Read-API se mapuje takto: app `workspaceId` → `serverWorkspaceId`
(`ensureConversationReadWorkspaceRegistered`) → `serverClient.listConversations`.
Server pak v `conversation-read-store.ts` otevře OpenCode DB
**read-only** a udělá `SELECT … FROM session WHERE directory IN (…) ORDER BY
time_updated DESC`. Když je `source==="sqlite"` ale 0 položek, **nebo**
`unavailable`, `conversation-service.ts` fallbackuje na
`listPersistedBindings` (binding-store).

Pozn.: `backfillConversationsToVesloReadApi` (`serverClient.importConversations`)
běží po živém engine listu — plní binding/„persisted" vrstvu. Read primárně
čte OpenCode DB, takže backfill je hlavně pro fallback, ne pro hlavní cestu.

---

## 2. Jak se načítá sidebar (proběhlé konverzace)

`createSidebarWorkspaceSessions` drží stav **per workspaceId**:
`sidebarSessionsByWorkspaceId: Record<wsId, SidebarSessionItem[]>` (+ status,
error, limit, hasMore). Klíčové efekty:

1. **engine/workspace key change** (ř. 797–840): při změně enginu nebo
   seznamu workspaces zavolá `pruneSidebarSessionState` (smaže klíče
   workspaců, které **zmizely** z `workspaces()`) a pak refresh.
2. **active + engineReady** (ř. 842–863): když je workspace aktivní a
   engine ready, refreshne z živého enginu; má „ready-empty retry".
3. **session-store sync** (ř. 865–949): synchronizuje sidebar z globálního
   `sessions()` storu pro aktivní/connecting workspace, **chráněno**
   `shouldSyncSidebarFromSessionStore` + merge `deriveSidebarRowsFromSessionStore`
   (merge, ne wipe). Tahle vrstva je defenzivní.

Živý refresh (`refreshSidebarWorkspaceSessions`) filtruje session přes
`sessionDirectoryMatchesRoot(resolveSessionDirectory(s), root)` — tj. i živá
cesta zahazuje session, jejichž directory nesedí s rootem workspace.

---

## 3. Jak funguje překlikávání (selectSession)

`context/session.ts selectSession` (ř. 1168+):

1. `setSelectedSessionId(sessionID)` hned.
2. `browseFromDb = shouldBrowseSessionFromDb(id) ?? !engineReady()`.
3. **browse:** `loadOfflineTranscript(id, limit)` → `getTranscriptFromVesloReadApi`
   → read-store `getTranscript`. Snapshot se nahydratuje do **globálního**
   transcript storu klíčovaného **jen `sessionID`** (`hydrateTranscriptSnapshot`).
4. **live:** `c.session.messages({sessionID})` (cold-spawn enginu jen když
   engine ready).

Transcript store je **globální per session id**, ne per workspace — to je
samostatný zdroj cross-workspace bleedu (viz `missaligned UI response
workspace mismatch.md`).

---

## 4. Proč přepnutí workspace „smaže" starou konverzaci a nejde se vrátit

Řetězec (lokální → lokální, browse), `context/workspace-activation-local.ts`
STEP 5-BROWSE (ř. 340–389):

```
přepnutí na workspace B (engine neběží)
  → clearDisplayedSessionState("local_browse_workspace_changed")   // smaže zobrazený transcript A (očekávané)
  → populateSidebarFromDb(B, B.path)                               // app.tsx:5327
      → listConversationsFromVesloReadApi(B, B.path)
          → read-store SELECT … WHERE directory = B.path           // OpenCode opencode.db
      → replaceWorkspaceSidebarSessions(B, items)                  // BEZ ochrany na prázdno
```

Tady jsou tři selhání, která způsobí „zmizení":

1. **Nesedící `directory`.** Předává se `workspace.path` (Windows cesta,
   např. `C:\Users\…\repo`). OpenCode engine v **WSL2** ale ukládá
   `session.directory` jako WSL cestu (`/mnt/c/…` nebo guest path).
   `directoryLookupVariants` zkouší `/`↔`\`, lowercase i `\\?\`, ale
   **nepřekládá `C:\…` ↔ `/mnt/c/…`** → `WHERE directory IN (…)` nic
   nenajde → 0 položek.
2. **`unavailable` se tváří jako „prázdno".** Když read-store neumí otevřít
   DB (cesta se resolvne na neexistující `~/.local/share/opencode/opencode.db`
   — Linux XDG fallback na Windows), vrátí `source:"unavailable", items:[]`.
   `populateSidebarFromDb` to nerozliší od „0 konverzací" a stejně zavolá
   `replaceWorkspaceSidebarSessions(B, [])` → **wipe**.
3. **V browse módu není recovery.** `replaceWorkspaceSidebarSessions` navíc
   nastaví status `"ready"`, takže ani „ready-empty retry" efekt (běží jen
   pro engineReady) ani engine refresh (ř. 845: `if (!engineReady()) return`)
   řádky neobnoví. Dokud uživatel reálně nespustí engine (živý list), zůstává
   prázdno → **„nedostanu se zpět"**.

A na úrovni transcriptu samostatné selhání: `getTranscript` při „session
nenalezena pod directory" vrací **`source:"sqlite"`** (úspěch!) s prázdnými
zprávami (`conversation-read-store.ts:349`). `getTranscriptFromVesloReadApi`
vrací `null` jen pro `unavailable`, takže prázdný „sqlite" snapshot projde a
`selectSession` nahydratuje **prázdný** transcript → konverzace vypadá
vymazaně, i když v DB existuje.

Binding-store fallback (`conversation-service.listConversations`) tohle
částečně zachraňuje — ale jen pro konverzace vytvořené přes Veslo write-API
(create/run). Konverzace vzniklé jinak / starší než binding store v něm
nejsou → fallback je prázdný → wipe zůstává.

---

## 5. „Máme DB dobře nastavenou?" — hodnocení

**Návrh je rozumný:** číst přímo OpenCode `opencode.db` (zdroj pravdy) a mít
perzistentní binding-store jako fallback je lepší než držet druhý plný
duplicitní store a synchronizovat ho. Žádný in-memory store, který by se
ztratil restartem (binding-store i opencode.db jsou soubory).

**Ale je křehká** v těchto bodech:

- **B1 — directory-exact filtr bez WSL překladu.** List i transcript
  vyžadují shodu `session.directory` s předaným `directory`. Windows↔WSL2
  (`C:\…` vs `/mnt/c/…`) se nepřekládá → na Windows+WSL2 hlavní cesta tiše
  vrací prázdno. (`conversation-read-store.ts directoryLookupVariants`)
- **B2 — resolveOpenCodeDbPath fallback na Linux cestu.** Když chybí env/
  workspace hinty a `workspace.path/.opencode/opencode.db` neexistuje,
  fallbackuje na `~/.local/share/opencode/opencode.db` → na Windows
  neexistuje → `unavailable`. (`conversation-read-store.ts:176–216`)
- **B3 — `unavailable` vs prázdno se slévá.** `populateSidebarFromDb` a
  `getTranscriptFromVesloReadApi` nerozlišují „nepodařilo se přečíst" od
  „nula konverzací" → wipe / prázdný transcript. (`app.tsx:5327`,
  `conversation-read-store.ts:349`)
- **B4 — bezpodmínečný přepis + žádná browse recovery.**
  `replaceWorkspaceSidebarSessions` přepíše i prázdným polem a označí
  `ready`; v browse módu se to neobnoví. (`sidebar-workspace-sessions.ts:148`)

Plus dva „čistotní" nálezy:

- **B5 — `app/lib/db-reader.ts` je mrtvý kód** (Tauri `opencode_db_read_*`).
  Reálně se nepoužívá (jen vlastní testy). `data-flows.md` Flow 3 ho ale
  pořád popisuje jako aktivní cestu → zastaralá dokumentace.
- **B6 — globální transcript store klíčovaný jen `sessionID`** (ne per
  workspace) → cross-workspace bleed (detail v `missaligned UI response
  workspace mismatch.md`).

---

## 6. Konkrétní bugy a závažnost

| # | Bug | Závažnost | Místo |
|---|---|---|---|
| B1 | Windows↔WSL2 directory mismatch → prázdný read | **vysoká** (Windows default) | `conversation-read-store.ts` |
| B3 | `unavailable`/„not found" se slévá s „prázdno" | **vysoká** | `app.tsx:5327`, `conversation-read-store.ts:349` |
| B4 | bezpodmínečný wipe sidebaru + žádná browse recovery | **vysoká** | `sidebar-workspace-sessions.ts:148`, browse efekty |
| B2 | DB-path fallback na neexistující Linux cestu | střední | `conversation-read-store.ts:176` |
| B6 | transcript store per-sessionID, ne per-workspace | střední | `context/session.ts` |
| B5 | mrtvý `db-reader.ts` + zastaralá `data-flows.md` | nízká (úklid) | `app/lib/db-reader.ts`, `docs/sandbox/data-flows.md` |

---

## 7. Doporučené fixy (podle hodnoty)

1. **Rozlišit `unavailable` od „prázdno" v celém řetězci.** Když read vrátí
   `unavailable` (nebo „session not found under directory"), **NEpřepisovat**
   stávající sidebar řádky a **NEvyrenderovat** prázdný transcript — nechat
   předchozí stav a/nebo zkusit fallback/retry. (`populateSidebarFromDb`,
   `getTranscriptFromVesloReadApi`, `replaceWorkspaceSidebarSessions`)
2. **WSL2 path mapping.** V `conversation-read-store.ts` přidat překlad
   `C:\X` ↔ `/mnt/c/x` (a guest cesty), nebo ukládat/queryovat directory v
   kanonické engine formě. Tím se opraví hlavní cesta na Windows.
3. **Browse recovery.** Po prázdném/`unavailable` readu v browse módu mít
   řízený retry (po krátké prodlevě / po registraci workspace na serveru),
   ne tichý wipe natrvalo.
4. **Úklid B5/B6:** smazat `db-reader.ts` + opravit `data-flows.md`; zvážit
   keying transcript storu i workspace rootem.

---

## 8. Testy k ověření (E2E preferované)

- **T1 (B1/B3):** lokální workspace s reálnými OpenCode session v
  `opencode.db`, kde `session.directory` je WSL cesta; přepnout na něj v
  browse módu a ověřit, že sidebar **není prázdný** (dnes je).
- **T2 (B4):** mít workspace A s N řádky → přepnout na B, kde read vrátí
  `unavailable` → přepnout zpět na A → A musí stále mít N řádků (dnes 0).
- **T3 (B3 transcript):** vybrat session, jejíž directory nesedí → UI nesmí
  zobrazit prázdný transcript jako „hotovo", musí signalizovat
  nedostupnost / fallback.
- **T4 (regrese):** binding-store fallback vrací konverzace vytvořené přes
  write-API i když opencode.db read je prázdný.

## Reference

- Sidebar store: `packages/app/src/app/context/sidebar-workspace-sessions.ts`
- Sync helpers: `app/lib/sidebar-session-store-sync.ts`, `…/sidebar-session-sync-guard.ts`
- Select/hydrate: `app/context/session.ts`
- Browse aktivace: `app/context/workspace-activation-local.ts` (STEP 5-BROWSE)
- Read-API (app): `app.tsx` (`listConversationsFromVesloReadApi`, `getTranscriptFromVesloReadApi`, `backfill…`)
- Read store (server): `packages/server/src/conversation-read-store.ts`, `conversation-service.ts`, `conversation-binding-store.ts`
- Mrtvý kód: `app/lib/db-reader.ts`
- Související audity: `missaligned UI response workspace mismatch.md`,
  `workspace-sidebar-history-deep-audit-1.md`
</content>
