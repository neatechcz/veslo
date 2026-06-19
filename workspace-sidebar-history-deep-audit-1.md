# Workspace Sidebar History Deep Audit 1

Scope: theoretical and code-backed reasons why old conversations sometimes appear in the workspace sidebar and sometimes do not. This is not about one single flow. The sidebar currently merges several data sources and then applies several render-time filters/transforms:

- live OpenCode `session.list`
- Veslo conversation read API fallback
- app `sessions()` store sync
- sidebar local mutations for pending/new/moved/deleted sessions
- archive filter
- project/private-chat grouping
- pagination/windowing

The intermittent behavior is most likely caused by different refresh paths producing different row sets, and by render models using raw `session.id` as if it were globally unique.

## 1. Raw `session.id` can make one workspace row disappear during render

**Code evidence**

- `packages/app/src/app/components/session/workspace-session-list-model.ts` builds hierarchy maps by raw `row.session.id`.
- `rowBySessionId = new Map(rows.map((row) => [row.session.id, row]))`
- `emittedSessionIds = new Set<string>()`
- `appendRow()` returns early when `emittedSessionIds.has(row.session.id)`.
- `buildRecentRows()` and `buildProjectGroups()` both call this shared hierarchy builder.

**Failure shape**

If two workspaces contain a conversation with the same `session.id`, only one row is emitted. Which one wins depends on ordering, activity timestamps, and grouping path. That can look exactly like "workspace B has old conversations sometimes, sometimes not".

This is especially plausible because other code already treats duplicate IDs as a known hazard. For example, sidebar prefetch interest has a test that refuses to attribute a selected/clicked id when the same id exists in two workspaces.

**Expected contract**

Sidebar rows must be keyed by scoped identity:

```ts
workspaceId + "\0" + sessionId
```

or by the existing UI conversation key. Raw `session.id` is not sufficient in a multi-workspace sidebar.

**Targeted test**

Add a model test:

- workspace A has session `shared`
- workspace B has session `shared`
- `buildRecentRows([A, B])` returns two rows, one per workspace
- `buildProjectGroups([A, B])` also keeps both rows

Current code should drop one.

## 2. Archive filtering hides by raw session id across all workspaces

**Code evidence**

- `packages/app/src/app/app.tsx:6175` derives `archivedSessionIds` as `sessionArchiveRecords().map((record) => record.sessionId)`.
- `packages/app/src/app/components/session/workspace-session-list.tsx:560` converts those ids into a global `Set`.
- `shouldShowSessionRow(row)` checks only `!isSessionArchived(row.session.id)`.
- Archive records themselves contain workspace metadata: `workspaceIdAtArchive`, `workspaceIdentity`, directory/project snapshots.

**Failure shape**

If workspace A archives `sessionId = shared`, then workspace B's `shared` row is also hidden. It can look intermittent because the archive records are loaded asynchronously from server/local migration. Before archive data arrives the row can show; after archive data arrives it disappears.

**Expected contract**

Archive filtering must use `(workspaceId, sessionId)` or an archive record id, not raw `sessionId`.

**Targeted test**

- A/shared is archived
- B/shared is not archived
- sidebar renders B/shared
- archived records loaded after sidebar rows should not remove B/shared

## 3. Sidebar read fallback marks workspaces `ready` with `hasMore=false`

**Code evidence**

- `refreshSidebarWorkspaceSessionsFromReadApi()` sets:
  - rows from `listConversationsFromVesloReadApi`
  - status `"ready"`
  - error `null`
  - `hasMore=false`
- This path is used when a local workspace has no engine base URL or the runtime is unavailable.
- Live OpenCode path computes `hasMore` from `rawCount` and `requestLimit`.

**Failure shape**

When the app cannot reach the runtime, it falls back to Veslo read API. If that API is unavailable, stale, or contains only conversations that were previously backfilled, the sidebar gets an incomplete list and is marked ready with no load-more affordance.

Later, unless engine/workspace keys change or an explicit refresh happens, the sidebar may stay in that apparently successful empty/partial state.

This explains why old conversations can appear on runs where the runtime/live list wins, but disappear on runs where fallback read API wins first.

**Expected contract**

Read fallback should distinguish:

- complete result
- unavailable result
- partial/stale result

For unavailable/partial fallback, do not mark the workspace as permanently complete. Either keep retry state, preserve existing rows with a stale indicator, or keep `hasMore` unknown/true.

**Targeted test**

- workspace has existing rows
- runtime unavailable
- read API returns `{ source: "unavailable", items: [] }`
- expected: existing rows are preserved or status is not final-ready-empty
- current risk: workspace becomes ready with zero rows and `hasMore=false`

## 4. Live list and read API use different completeness semantics

**Code evidence**

- Live path calls `c.session.list({ directory: queryDirectory, limit })`.
- Live path can fetch more, hydrate ancestors, filter utility sessions, backfill to read API, and compute `hasMore`.
- Read API path directly maps all `result.items` and sets `hasMore=false`.
- `listConversationsFromVesloReadApi()` uses server-backed conversation records, which depend on prior create/import/backfill.

**Failure shape**

The same workspace can show different historical coverage depending on which path is used:

- fresh runtime available: OpenCode SQLite/session API may return old sessions
- runtime unavailable: Veslo read API may only know conversations created/imported after the feature existed
- after one successful live refresh: backfill may make the read API show more next time

That naturally creates "sometimes old conversations appear, sometimes they do not".

**Expected contract**

The sidebar should expose source/completeness in debug state and not treat read fallback as equivalent to live session list unless it is known complete.

## 5. Directory equality can filter out sessions that belong to the workspace but have a nested or migrated directory

**Code evidence**

- `sessionDirectoryMatchesRoot()` returns `sessionRoot === root`.
- The name suggests root matching, but it is exact equality, except empty session directory falls back to root.
- Sidebar live refresh filters sessions with `sessionDirectoryMatchesRoot(resolveSessionDirectory(session), root)`.
- The query sent to OpenCode also uses exact `directory`.

**Failure shape**

If an old conversation was stored with:

- a nested project directory
- a symlink-resolved path
- a moved/copied directory
- a pre-normalization path variant
- a private workspace temporary path

then it can be excluded from the sidebar for the workspace root.

This is especially visible for "former conversations" because older records are more likely to have historical path formats or directory values.

**Expected contract**

Decide whether workspace membership is exact directory or directory subtree. If subtree membership is intended, matching must allow `sessionRoot === root || sessionRoot.startsWith(root + "/")` after normalization. If exact directory is intended, then moved/nested conversations need an explicit migration or directory override path.

## 6. Sidebar store-sync can preserve stale rows, making old conversations appear only in some sessions

**Code evidence**

- The active/connecting workspace sync effect derives rows from global `sessions()`.
- `deriveSidebarRowsFromSessionStore()` returns visible incoming rows plus existing rows whose ids are not in incoming rows.

**Failure shape**

When `sessions()` contains a partial active workspace list, existing sidebar rows are retained. That can be good for avoiding flicker, but it also means:

- old rows may remain visible after an incomplete refresh
- the same old rows may disappear on a cold load where there were no existing rows to retain
- behavior differs depending on whether the user had previously loaded that workspace in the same app session

This is a classic "appears sometimes" state retention bug.

**Expected contract**

Retention should be source-aware:

- retain optimistic/pending/newly-created rows
- retain rows during explicitly stale refresh windows
- do not permanently merge unknown old rows after a confirmed complete refresh

## 7. Project grouping merges by project root, not by workspace identity

**Code evidence**

- `projectGroupKeyForRow(row)` uses `row.projectRoot` unless private.
- `buildProjectGroups()` groups rows by that key.
- The resulting group chooses `leadSession.workspace` as the group workspace.

**Failure shape**

Two different workspaces with the same normalized directory/project root can collapse into one project group. That is sometimes intentional for duplicate workspace entries, but it can also hide the fact that rows came from another workspace, attach actions to the lead workspace, and make a workspace appear empty.

Remote workspaces are especially suspicious because the key is often only `workspace.directory`, not host/workspace identity.

**Expected contract**

If grouping is intended to visually merge same project roots, the row identity and actions still need to preserve owner workspace. If the user expects one group per workspace, the key must include `workspace.id`.

## 8. Remote workspace dedupe can replace which workspace group is displayed

**Code evidence**

- `sidebarWorkspaceGroups` dedupes remote workspaces by remote type, normalized host, and either Veslo workspace id or directory.
- When duplicates exist, active/connecting workspace wins.

**Failure shape**

If two remote workspace entries resolve to the same dedupe key, only one is represented in the sidebar. Switching active/connecting workspace can change which entry wins. That can make conversations appear under one workspace entry on one pass and disappear from another on another pass.

**Expected contract**

Remote dedupe must be explicit in UI/debug state. If two entries are aliases, session rows should be merged intentionally. If they are not aliases, dedupe key is too broad.

## 9. Bulk refresh join can preserve the wrong initial empty state

**Code evidence**

- `refreshAllSidebarWorkspaceSessions()` has a single `sidebarBulkRefreshInFlight`.
- A later refresh request joins the existing run instead of starting a new prioritized/context-aware run.
- Individual workspace refreshes can mark a workspace ready-empty through read fallback.

**Failure shape**

On startup, an early bulk refresh can run before engine/server readiness. It can mark some workspaces ready with empty fallback data. Later refresh requests during that run simply join it. If no engine/workspace key changes after readiness improves, those workspaces may not be reloaded.

**Expected contract**

Readiness transition should trigger a new refresh for workspaces that completed through unavailable/partial fallback. Joining an in-flight refresh should not suppress a later stronger refresh context.

## 10. Active send deferral can suppress sidebar refresh indefinitely if send trace state gets stuck

**Code evidence**

- `refreshSidebarWorkspaceSessions()` returns early when `activeSendTraceId` exists.
- `scheduleDeferredSidebarRefresh()` keeps rescheduling while `activeSendTraceId` remains set.

**Failure shape**

If send trace state gets stuck, sidebar refreshes do not execute. Old rows stay stale or empty. This can be perceived as old conversations not appearing after send/create/switch flows.

**Expected contract**

Deferral needs a max age or fallback refresh, and debug output should show that rows are deferred because of active send trace.

## 11. Utility-session filtering can shrink the first page and distort `hasMore`

**Code evidence**

- Live path does up to four passes to compensate for utility sessions.
- Read fallback filters utility sessions once and sets `hasMore=false`.

**Failure shape**

If old visible conversations are just beyond a set of Veslo utility sessions in read fallback, they may not appear and the UI will not load more. Live path tries to compensate; read path does not.

**Expected contract**

Read fallback should either support pagination/hasMore or overfetch similarly to live path.

## Suggested highest-value tests

1. `buildRecentRows` keeps duplicate raw session ids from different workspaces.
2. `buildProjectGroups` keeps duplicate raw session ids from different workspaces.
3. Archive filtering is scoped by workspace id.
4. Read fallback unavailable does not mark workspace as complete ready-empty.
5. Live incomplete `sessions()` store sync does not permanently retain/delete old rows without source awareness.
6. Same project root in two workspaces does not collapse owner workspace actions.
7. Directory matching behavior is explicitly tested for nested directories and moved session overrides.

## Most likely explanations for the observed symptom

Top suspects, in order:

1. **Raw session id collisions in render hierarchy or archive filter.** This can hide rows without any API failure.
2. **Read API fallback being incomplete but marked complete.** This explains startup/runtime-dependent differences.
3. **Existing-row retention from `sessions()` store sync.** This explains why a row appears after it was loaded once, but not on cold load.
4. **Exact directory matching.** This explains older or moved conversations missing from a workspace.
5. **Project/remote dedupe by path/identity.** This explains rows appearing under a different group or not under the expected workspace.

