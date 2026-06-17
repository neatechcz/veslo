# Fix: spolehlivý výpis konverzací v sidebaru z host-side DB

> Implementační záznam k opravě symptomu „přepnutí workspace smaže konverzaci
> ze sidebaru a nejde se vrátit". Analýza příčin je v
> [`sidebar-and-conversations-deep-dive.md`](sidebar-and-conversations-deep-dive.md).
> Datum: 2026-06-17. Target repo: `…/veslo`.

## Scope (rozhodnutí)

Důležité je **jen to, aby se konverzace vypsala v sidebaru** z naší vlastní
DB mimo sandbox. Transcript (obsah po kliknutí) může dál číst přímo sandbox
WSL `opencode.db`. Owned store pro messages/parts a WSL↔Windows překlad cest
pro transcript jsou **mimo scope**.

## Příčina (krátce)

Browse-list v UI se plnil z Veslo server read-API, které preferovalo čtení
sandbox `opencode.db` (přes `\\wsl.localhost\…`) a na náš host-side store
fallbackovalo jen buď-anebo. Když sandbox read vrátil prázdno/`unavailable`
(Windows↔WSL cesta, jiný tvar path, nedostupná DB), app to **bezpodmínečně
přepsala** do sidebaru → řádky zmizely a v browse módu se neobnovily.

Náš host-side store už existoval: `conversation-binding-store.ts`
(`<vesloDataDir>/conversations/bindings.sqlite`) drží summaries konverzací a
plní se přes `importConversations`/backfill i create/run. Oprava z něj dělá
**autoritativní, aditivní** zdroj a brání přepsání prázdnem.

## Změny

### Server (`packages/server/src`)
- **`conversation-service.ts`** — `listConversations` vrací **union** sandbox
  readu a owned bindings (dedup podle engine session id, zachované pořadí:
  sandbox first, owned-only se připojí). Prázdný/`unavailable`/podmnožinový
  sandbox read už seznam nezmenší. Nový helper `mergeConversationSummaries`.
- **`conversation-binding-store.ts`** — `listOpenCodeSessions` dělá
  **workspace-wide fallback**, když directory-scoped dotaz vrátí 0 řádků
  (Windows↔WSL path-form rozdíl už neskryje celý sidebar). Izolace mezi
  workspaces zachována (filtr `workspace_id`).
- **`conversation-read-store.ts`** — `getTranscript` při „session nenalezena
  pod directory" vrací `source:"unavailable"` místo prázdného `sqlite`
  (UI nezobrazí prázdný transcript jako hotový read).

### App (`packages/app/src`)
- **`lib/sidebar-session-sync-guard.ts`** — nová čistá funkce
  `shouldPreserveSidebarRowsOnRead({ available, incomingCount, existingCount })`:
  zachovej řádky při `unavailable` nebo při prázdnu, když workspace už řádky
  má; přepiš jen při skutečném neprázdném readu nebo prázdnu u čerstvého
  workspace.
- **`context/sidebar-workspace-sessions.ts`** — nový
  `applyWorkspaceSidebarReadResult` (používá guard), nahradil bezpodmínečný
  přepis v `refreshSidebarWorkspaceSessionsFromReadApi`; exportován.
- **`app.tsx`** — `populateSidebarFromDb` volá `applyWorkspaceSidebarReadResult`
  místo `replaceWorkspaceSidebarSessions` (předává `available = source !== "unavailable"`).

## Testy
- Server (bun): `conversation-service` + `conversation-binding-store` +
  `conversation-read-store` = **25/25**, integrační `server-conversations`
  = **9/9**. Nové: union, workspace-wide fallback, transcript not-found→unavailable.
- App (node:test): `sidebar-session-sync-guard` + `sidebar-session-store-sync`
  = **10/10**. Nové: preserve-on-unavailable, replace-on-genuine-read.
- `pnpm --filter veslo-server typecheck` ✅, `pnpm --filter @neatech/veslo-ui typecheck` ✅
- `pnpm --filter veslo-server build:bin` ✅ (povinný rebuild binárky).

## Chování po opravě
- Konverzaci, kterou jsme jednou viděli živě (engine list / create / run),
  máme v `bindings.sqlite` na hostu → vypisuje se i offline a po path
  mismatchi.
- Nedostupný/prázdný read už nikdy nesmaže existující řádky sidebaru.

## Follow-up (mimo tuto opravu)
- Owned store pro transcript (messages/parts) + tunel obsahu z enginu, pokud
  budeme chtít přestat sahat do sandboxu i pro obsah.
- WSL↔Windows kanonizace cest jako systémové řešení directory matchingu.
- Ověření naživo proti reálnému `bindings.sqlite` v desktop runtime.

## Reference
- `packages/server/src/{conversation-service,conversation-binding-store,conversation-read-store}.ts`
- `packages/app/src/app/lib/sidebar-session-sync-guard.ts`
- `packages/app/src/app/context/sidebar-workspace-sessions.ts`
- `packages/app/src/app/app.tsx` (`populateSidebarFromDb`)
</content>
