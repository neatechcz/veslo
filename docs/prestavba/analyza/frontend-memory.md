> Kopie pracovní paměti frontendu (2026-07-19, původně mimo repo v docs/memory/frontend.md). Ber jako historický kontext k timing pastím SolidJS, ne jako aktuální mapu kódu.

# Frontend architektura — sidebar, workspace, sessions

Podrobná mapa reaktivních závislostí frontendu Vesla. Pomáhá pochopit, jak spolu komunikují sidebar, workspace switching a session management, a kde vznikají timing problémy.

## Klíčové soubory

| Soubor | Účel |
|--------|------|
| `git/packages/app/src/app/app.tsx` | Hlavní app — sidebar signály, efekty, `chooseFolderForCurrentSession`, routing |
| `git/packages/app/src/app/context/workspace.ts` | Workspace store — `activateWorkspace`, `connectToServer`, `forgetWorkspace`, `createLocalWorkspace` |
| `git/packages/app/src/app/context/session.ts` | Session store — `selectSession`, `loadSessions`, `sessions()` signál, SSE stream |
| `git/packages/app/src/app/components/session/sidebar.tsx` | Sidebar komponenta — renderuje `WorkspaceSessionGroup[]` |
| `git/packages/app/src/app/types.ts` | Typy `SidebarSessionItem`, `WorkspaceSessionGroup` |

## Sidebar — signály a rendering

### Signály (app.tsx)
- **`sidebarSessionsByWorkspaceId`** (~řádek 2037): `Record<string, SidebarSessionItem[]>` — sessions per workspace
- **`sidebarSessionStatusByWorkspaceId`**: status per workspace (idle/loading/ready/error)
- **`sidebarSessionErrorByWorkspaceId`**: error messages per workspace
- **`sidebarWorkspaceGroups`** (~řádek 2390): `createMemo` — kombinuje workspaces + sessions + status → `WorkspaceSessionGroup[]`

### Kdo zapisuje do `sidebarSessionsByWorkspaceId`:
1. `refreshSidebarWorkspaceSessions(id)` — po API fetchi (~řádek 2234)
2. SSE sync efekt (~řádek 2337) — když se změní `sessions()` a sidebar je "ready"
3. Nová session (~řádek 4888) — optimistic prepend
4. Smazání session (~řádek 1627) — filter
5. `chooseFolderForCurrentSession` — optimistic move + re-patch

### `refreshSidebarWorkspaceSessions(id)` (~řádek 2127)
1. Resolve workspace, get client config
2. Pro lokální bez baseUrl (engine offline) → mark "idle", return
3. Increment sequence counter (`sidebarRefreshSeqByWorkspaceId`)
4. Discover workspace directory from engine
5. **API call:** `c.session.list({ directory, roots: true, limit: 200 })`
6. Check stale (sequence number)
7. Apply directory overrides (`sessionDirectoryOverrideById`)
8. Merge: pro sessions s overridem, které nejsou v API response, fetch individuálně přes `c.session.get({ sessionID })`
9. Sort, filter internal, build `SidebarSessionItem[]`
10. `setSidebarSessionsByWorkspaceId()` — **PŘEPÍŠE** celý array pro daný workspace

### `refreshAllSidebarWorkspaceSessions(prioritizeId?)` (~řádek 2248)
- Sekvenčně refreshne všechny workspaces
- Prioritizuje zadaný workspace (refreshne ho první)
- Yield (setTimeout 0) mezi workspaces

## Reaktivní efekty ovlivňující sidebar

### Efekt 1: Workspace/engine watcher (~řádek 2277)
- **Sleduje:** `workspaceStore.engine()`, `workspaceStore.workspaces()`
- **Spouští:** `refreshAllSidebarWorkspaceSessions()` jako `void` (fire-and-forget!)
- **Trigger:** jakákoli změna ve workspace listu nebo engine auth
- **Důležité:** `forgetWorkspace` → `setWorkspaces()` → tento efekt se spustí

### Efekt 2: Active workspace idle loader (~řádek 2327)
- **Sleduje:** `workspaceStore.activeWorkspaceId()`, `sidebarSessionStatusByWorkspaceId()`
- **Spouští:** `refreshSidebarWorkspaceSessions(id)` pokud status je "idle"
- Jednorázový — neopakuje se

### Efekt 3: SSE sync (~řádek 2337)
- **Sleduje:** `sessions()`, `connectingWorkspaceId()`, `activeWorkspaceId()`
- **Spouští:** `setSidebarSessionsByWorkspaceId()` pokud status je "ready"
- Filtruje sessions podle workspace root, sortuje, přepisuje sidebar pro aktivní workspace
- **Důležité:** Když `loadSessions()` v `connectToServer` změní `sessions()`, tento efekt přepíše sidebar

## Workspace switching flow

### `activateWorkspace(id)` (workspace.ts ~řádek 514)
1. Set `connectingWorkspaceId`
2. Set connection state "connecting"
3. Pro lokální: `setProjectDir`, load config
4. Pokud switch z remote na local nebo local→local se změnou cesty:
   - Clear session state (selectedSessionId=null, messages=[], todos=[])
   - `activateOrchestratorWorkspace()` + `activateVesloHostWorkspace()`
   - **`connectToServer()`**
5. Set connection state "connected"

### `connectToServer(baseUrl, directory, context)` (workspace.ts ~řádek 1118)

**3 obranné guardy hned na začátku** (commit `67451d6a`):

1. **In-flight dedupe** — pokud je connect na stejný klíč už in-flight, vrátí existing promise
2. **Stale-workspace ABORT** — pokud `context.workspaceType === "local"` a `activeWorkspaceRoot()` neodpovídá `incomingDirectory`, return false. Chrání před opožděnými reload-ami pro workspace, ze kterého user mezitím odešel (engine reload pro starý workspace by jinak rebindnul klienta na cizí ws).
3. **Idempotent SKIP** — pokud klient existuje a `baseUrl + directory` se shodují s aktuálním stavem, return true (no-op). Chrání před redundantními reconnects (např. delayed bootstrap retry z `cb02cf21`).

Pak teprve `run` blok:
1. Create OpenCode client + wait for healthy
2. **Conditional state RESET** — wipe `selectedSessionId/messages/todos/sessionStatus` JEN POKUD `directoryChanged` (klient null nebo previous directory != incoming directory). Pro engine reload na **stejný** workspace (managed AI config patch, manual reload) state zůstane.
3. `setClient(nextClient)` + setBaseUrl + setClientDirectory
4. Load providers (async, ne blocking)
5. **`loadSessions(targetRoot)`** — updatne `sessions()` signál
6. Refresh skills, plugins, pendingPermissions
7. Navigate to dashboard if no session selected

### `forgetWorkspace(id)` (workspace.ts ~řádek 1551)
1. `workspaceForget(id)` — Tauri command
2. **`setWorkspaces(ws.workspaces)`** — spouští reaktivní efekt 1!
3. `clearWorkspaceConnectionState(id)`
4. `syncActiveWorkspaceId(ws.activeId)`
5. `setProjectDir(active.path)`
6. **Pokud `ws.activeId !== previousActive`** → `activateWorkspace(ws.activeId)` — ZNOVU connectToServer!

## Session directory overrides (app.tsx ~řádek 856)
- **`sessionDirectoryOverrideById`**: `Record<sessionId, directoryPath>` — v localStorage
- **`persistSessionDirectoryOverride(sessionID, directory)`**: uloží override
- **`resolveSessionDirectory(session)`**: vrátí override nebo originál
- **`applySessionDirectoryOverride(session)`**: aplikuje override na session objekt
- Používá se v `refreshSidebarWorkspaceSessions` pro merge sessions s overridem

## Routing a session view

### `goToSession(sessionId, options?)` (app.tsx ~řádek 335)
- Čistě router navigace: `navigate('/session/{id}')`
- Nenačítá data

### `selectSession(sessionID)` (session.ts ~řádek 866)
1. `setSelectedSessionId(sessionID)`
2. Health check
3. Fetch messages: `c.session.messages({ sessionID, limit: 140 })`
4. `setMessagesForSession(sessionID, msgs)`
5. Extract model, load todos, permissions
6. Má stale detection — abortne pokud se session změní během loadu

### Route effect (app.tsx ~řádek 6533)
- Sleduje URL `/session/{id}`
- **Řádek 6548: Pokud `sessionsLoaded()` a session NENÍ v `sessions()` → redirect na `/session` (prázdný stav)!**
- Pokud valid session → `selectSession(id)`
- Pokud invalid → redirect `/session`

### Session view (pages/session.tsx ~řádek 3838)
- `messages.length === 0` → quickstart cards / empty state
- `messages.length > 0` → `<MessageList>` s chatem
- Závisí na `selectedSessionId` a `messages` signálech

## chooseFolderForCurrentSession flow (app.tsx ~řádek 4939)

1. Validace (Tauri, session, private workspace)
2. File picker loop (s conflict handling)
3. Copy souborů do target
4. **`sessionSnapshot`** — uložit data session PŘED aktivací (po ní je `sessions()` přepsán)
5. `ensureWorkspaceForFolder(selectedDirectory)` — vytvoří/najde workspace
6. **`ensureLocalWorkspaceActive(targetWorkspace.id)`** → `activateWorkspace` → `connectToServer` → clear session state
7. `persistSessionDirectoryOverride(sessionID, targetWorkspace.path)`
8. **Přidat session do `sessions()`** — buď update directory nebo přidat ze snapshotu (klíčové pro route efekt!)
9. Update session-to-workspace mapping
10. Optimistic sidebar move
11. **`goToSession(sessionID)` + `selectSession(sessionID)`** — znovu načte session
12. `refreshSidebarWorkspaceSessions(targetWorkspace.id)`
13. **`forgetWorkspace(sourceWorkspaceId)`** — spustí reactive effect → async `refreshAllSidebarWorkspaceSessions()`
14. Re-patch sidebar (safety net)

## Známé timing pasti

### Past 1: Session zmizí z `sessions()` po aktivaci workspace
`ensureLocalWorkspaceActive` → `connectToServer` → `loadSessions(targetRoot)` načte jen sessions pro cílový adresář. Session z temp workspace tam není. Route efekt (řádek 6548) ji nenajde a redirectuje na prázdný stav.
**Řešení:** Uložit snapshot session před aktivací, po aktivaci ji přidat zpět do `sessions()`.

### Past 2: Async refresh přepisuje optimistic update
`forgetWorkspace` → `setWorkspaces()` → reactive efekt 1 → `void refreshAllSidebarWorkspaceSessions()` (fire-and-forget). Běží async a po dokončení přepíše sidebar. Refresh by měl najít session přes directory override (bod 8 v `refreshSidebarWorkspaceSessions`).

### Past 3: `connectToServer` maže session state
`setSelectedSessionId(null)` + `setMessages([])`. Pokud `forgetWorkspace` změní `activeId`, volá `activateWorkspace` znovu → `connectToServer` → vymaže vše znovu.

### Past 5: `createSessionAndOpen` registruje session do špatného workspace
`createSessionAndOpen` (~řádek 4894) používal `activeWorkspaceId` pro optimistic prepend do sidebaru. Při workspace přepínání (klik na "+" u jiného workspace) je `activeWorkspaceId` stále starý → session se zaregistruje do starého workspace, cílový má 0 sessions → `buildProjectGroups` ho nezobrazí → workspace zmizí ze sidebaru.
**Řešení:** Použít `connectingWorkspaceId ?? activeWorkspaceId` (stejný vzor jako SSE sync efekt na řádku 2351).

### Past 4: SolidJS efekt si ruší vlastní timer
V overlay efektu (~řádek 5811) čtení `workspaceSwitchVisibleSinceMs` uvnitř efektu způsobí re-trigger při jeho změně → `onCleanup` zruší hold-open timer. Řešení: `untrack()`.

## Local runtime lifecycle — 4 cesty jsou úmyslně odlišné (VSLO-103)

V `engine-store.ts` a `workspace.ts` existují 4 cesty, které vypadají jako duplicity reconnect / engine sync / auth derivace:

1. **workspace activation** (`activateWorkspace` při kliknutí na workspace)
2. **browsing-mode attach** (připojení k běžícímu enginu bez vlastního startu)
3. **reload** (po hot-reload nebo manuálním refresh)
4. **host start** (startEngine při prvním spuštění aplikace)

**NEKONSOLIDOVAT do jednoho sdíleného helperu** bez explicitního re-rozhodnutí. Zhodnoceno v refactor cyklu skupiny A (29.4.2026, VSLO-103) — rozdíly mezi cestami jsou behaviorálně úmyslné, ne copy-paste:
- různé pořadí auth derivace vs engine snapshot publishing
- různá toleranci k chybám (browsing-mode tichý reconnect vs host start fail-fast)
- různé route-stability garance (activation nesmí přepnout route, reload může)

VSLO-103 byl uzavřen jako obsolete (Vykonáno 30.4.2026). Plán `git/docs/plans/2026-04-19-vslo-103-local-runtime-lifecycle.md` zůstává jako historie, ale neimplementovat bez nového posouzení rozdílů.

**Co by ale dávalo smysl** (mikro-refactor, ne plný VSLO-103): vytáhnout izolované kousky, které jsou opravdu identické (typicky derivace auth ze snapshotu) — bez sahání na lifecycle ordering.
