# TypeScript Legacy Symbol Deep Audit

Date: 2026-07-07

Scope: `packages/app` TypeScript symbol audit, focused on the server-owned
composer submit migration and the remaining frontend send workflow ownership.

Related plan:
`docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md`

## Verdict

The audit tool is useful, and its highest-signal output is not the broad
`legacy` name bucket. The useful signal is the dependency-object match list for
`createSessionSendWorkflow`.

The current checkout has clearly moved the normal send path toward server-owned
submit:

- existing-session sends can call `submitConversationFromVesloWriteApi`;
- first-session materialization can pass `submitDraft` through
  `createSessionAndOpen`;
- frontend skill resolution is skipped when server submit is wired;
- attachment staging for existing UI-owned files is kept as a bounded ref
  adapter.

Follow-up cleanup on 2026-07-07 resolved the highest-signal BSW10 issue from
this report:

- the old direct-run pipeline is isolated behind
  `createLegacyConversationRunFallback`;
- `createSessionSendWorkflow` no longer declares or receives
  `buildPromptParts`, `buildCommandFileParts`,
  `routeStagedAttachmentsForModel`, `compactCurrentSession`,
  `prepareSendRuntimeForSend`, or `runConversationFromVesloWriteApi`;
- the server-submit attachment ref adapter is named
  `stageServerSubmitAttachments`;
- the audit tool's dependency-object matches dropped from `10` to `4`;
- the remaining `createSessionSendWorkflow` legacy/fallback match is the
  explicit compatibility adapter, not mixed app-owned run construction.

The practical recommendation remains to treat the audit output as a deletion
and isolation checklist, not as a generic "all legacy names are bad" report.

A second pass from wider angles found four more issue families worth tracking:

- auth/token fallback paths still exist in the app;
- server URL and server credential state still have multiple localStorage
  surfaces;
- app-local queue and pending-draft state remain separate from server durable
  queue state;
- stale/fallback route recovery still relies on symptom-level heuristics.

These are not all blockers for the server-owned composer submit rollout, but
they are the next places where the same "one owner per fact" goal can drift.

## Audit Inputs

Commands run from `packages/app`:

```powershell
node scripts/legacy-symbol-audit.mjs --limit=60
node scripts/legacy-symbol-audit.mjs --pattern=legacy --limit=80
```

Supporting checks from the repo root:

```powershell
git status --short --branch
rg -n "BSW04|BSW05|BSW06|BSW07|BSW08|BSW10|done:" docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md
rg -n "maybeResolveSkillCommand|shouldUseServerSubmitBeforeFrontendSkillResolution|prepareRuntimeForLegacySend|stageAttachmentsIntoSessionDirectory|routeStagedAttachmentsForModel|buildPromptParts|buildCommandFileParts|compactCurrentSession|runConversationFromVesloWriteApi|submitConversationFromVesloWriteApi" packages/app/src/app/pages/session-send-workflow.ts packages/app/src/app/app.tsx packages/app/src/app/pages/session-attachment-staging.ts
```

Second-pass JSON filters were run over these pattern groups:

```text
legacy|fallback|compat|deprecated|stale|old|workaround
storage|localStorage|persist
token|credential|auth|secret|bearer
runtime|server|health|ready|orchestrator|daemon|stale
pending|draft|queue|busy|inFlight|optimistic|replace|mutation|abort|compact
```

Reproducible second-pass commands from `packages/app`:

```powershell
$env:AUDIT_PATTERN = "legacy|fallback|compat|deprecated|stale|old|workaround"
node -e "const {execFileSync}=require('child_process'); const pattern=process.env.AUDIT_PATTERN; const data=JSON.parse(execFileSync(process.execPath,['scripts/legacy-symbol-audit.mjs','--json','--limit=10000','--pattern='+pattern],{encoding:'utf8',maxBuffer:64*1024*1024})); const re=new RegExp(pattern,'i'); const rows=data.candidates.filter(c=>c.tags.some(t=>/legacy|fallback|compat|deprecated|stale|old|workaround/.test(t))&&c.productionRefs>0).slice(0,60); for (const c of rows) { const loc=c.declarations[0]?.location; console.log([c.score,c.names.join('/'),c.tags.join(','),c.productionRefs+'/'+c.testRefs,c.writes,loc?loc.file+':'+loc.line:''].join(' | ')); }"

$env:AUDIT_PATTERN = "storage|localStorage|persist"
node -e "const {execFileSync}=require('child_process'); const pattern=process.env.AUDIT_PATTERN; const data=JSON.parse(execFileSync(process.execPath,['scripts/legacy-symbol-audit.mjs','--json','--limit=3000','--pattern='+pattern],{encoding:'utf8',maxBuffer:64*1024*1024})); const re=new RegExp(pattern,'i'); const rows=data.candidates.filter(c=>c.names.some(n=>re.test(n))&&c.productionRefs>0).slice(0,80); for (const c of rows) { const loc=c.declarations[0]?.location; console.log([c.score,c.names.join('/'),c.tags.join(','),c.productionRefs+'/'+c.testRefs,c.writes,loc?loc.file+':'+loc.line:''].join(' | ')); }"

$env:AUDIT_PATTERN = "token|credential|auth|secret|bearer"
node -e "const {execFileSync}=require('child_process'); const pattern=process.env.AUDIT_PATTERN; const data=JSON.parse(execFileSync(process.execPath,['scripts/legacy-symbol-audit.mjs','--json','--limit=3000','--pattern='+pattern],{encoding:'utf8',maxBuffer:64*1024*1024})); const re=new RegExp(pattern,'i'); const rows=data.candidates.filter(c=>c.names.some(n=>re.test(n))&&c.productionRefs>0).slice(0,80); for (const c of rows) { const loc=c.declarations[0]?.location; console.log([c.score,c.names.join('/'),c.tags.join(','),c.productionRefs+'/'+c.testRefs,c.writes,loc?loc.file+':'+loc.line:''].join(' | ')); }"

$env:AUDIT_PATTERN = "runtime|server|health|ready|orchestrator|daemon|stale"
node -e "const {execFileSync}=require('child_process'); const pattern=process.env.AUDIT_PATTERN; const data=JSON.parse(execFileSync(process.execPath,['scripts/legacy-symbol-audit.mjs','--json','--limit=3000','--pattern='+pattern],{encoding:'utf8',maxBuffer:64*1024*1024})); const re=new RegExp(pattern,'i'); const rows=data.dependencyMatches.filter(m=>m.tags.includes('custom-pattern')).concat(data.candidates.filter(c=>c.names.some(n=>re.test(n))&&c.productionRefs>0).slice(0,50).map(c=>({owner:'symbol',property:c.names.join('/'),tags:c.tags,location:c.declarations[0]?.location}))); for (const m of rows.slice(0,90)) { const loc=m.location; console.log([m.owner,m.property,m.tags.join(','),loc?loc.file+':'+loc.line:''].join(' | ')); }"

$env:AUDIT_PATTERN = "pending|draft|queue|busy|inFlight|optimistic|replace|mutation|abort|compact"
node -e "const {execFileSync}=require('child_process'); const pattern=process.env.AUDIT_PATTERN; const data=JSON.parse(execFileSync(process.execPath,['scripts/legacy-symbol-audit.mjs','--json','--limit=3000','--pattern='+pattern],{encoding:'utf8',maxBuffer:64*1024*1024})); const re=new RegExp(pattern,'i'); const rows=data.dependencyMatches.filter(m=>m.tags.includes('custom-pattern')).concat(data.candidates.filter(c=>c.names.some(n=>re.test(n))&&c.productionRefs>0).slice(0,60).map(c=>({owner:'symbol',property:c.names.join('/'),tags:c.tags,location:c.declarations[0]?.location}))); for (const m of rows.slice(0,100)) { const loc=m.location; console.log([m.owner,m.property,m.tags.join(','),loc?loc.file+':'+loc.line:''].join(' | ')); }"
```

Current worktree note: branch `local/sandbox-merge` is dirty and includes many
uncommitted changes from the ongoing migration. This audit reflects the checkout
state at the time above, not HEAD.

## Tool Summary

`node scripts/legacy-symbol-audit.mjs --limit=60` reported:

| Metric | Value |
| --- | ---: |
| Files scanned | 724 |
| Matched symbols | 530 |
| Dependency object matches | 10 |

The 10 dependency-object matches are the best migration handle:

| Owner | Property | Tag | Location |
| --- | --- | --- | --- |
| `createSessionSendWorkflow` | `buildCommandFileParts` | `frontend-run-part-construction` | `src/app/app.tsx:1618:5` |
| `createSessionSendWorkflow` | `buildPromptParts` | `frontend-run-part-construction` | `src/app/app.tsx:1619:5` |
| `createSessionSendWorkflow` | `compactCurrentSession` | `legacy-compact-submit` | `src/app/app.tsx:1625:5` |
| `createSessionSendWorkflow` | `isWorkspaceClientStaleError` | `stale-name` | `src/app/app.tsx:1641:5` |
| `createSessionSendWorkflow` | `prepareSendRuntimeForSend` | `frontend-runtime-admission` | `src/app/app.tsx:1652:5` |
| `createSessionSendWorkflow` | `routeStagedAttachmentsForModel` | `frontend-run-part-routing` | `src/app/app.tsx:1667:5` |
| `createSessionSendWorkflow` | `runConversationFromVesloWriteApi` | `legacy-run-submit` | `src/app/app.tsx:1670:5` |
| `createSessionSendWorkflow` | `stageAttachmentsIntoSessionDirectory` | `compat-attachment-staging` | `src/app/app.tsx:1687:5` |
| `createSessionMutationWorkflow` | `prepareSendRuntimeForSend` | `frontend-runtime-admission` | `src/app/app.tsx:1724:5` |
| `createSessionCreationWorkflow` | `isWorkspaceClientStaleError` | `stale-name` | `src/app/app.tsx:4110:5` |

## Findings

### 1. Resolved: BSW10 direct-run dependencies are isolated

Original finding: the plan marked BSW10 done while `SessionSendWorkflowOptions`
still exposed direct-run dependencies and `app.tsx` wired those dependencies
directly into `createSessionSendWorkflow`.

Evidence:

- `SessionSendWorkflowOptions` still exposes direct-run dependencies:
  `buildCommandFileParts`, `buildPromptParts`, `compactCurrentSession`,
  `prepareSendRuntimeForSend`, `routeStagedAttachmentsForModel`,
  `runConversationFromVesloWriteApi`, and
  `stageAttachmentsIntoSessionDirectory`
  (`packages/app/src/app/pages/session-send-workflow.ts:161`,
  `:162`, `:168`, `:221`, `:260`, `:272`, `:307`).
- `app.tsx` still wires those dependencies into `createSessionSendWorkflow`
  (`packages/app/src/app/app.tsx:1618`, `:1619`, `:1625`, `:1652`, `:1667`,
  `:1670`, `:1687`).
- The fallback branch still calls the old direct-run pipeline:
  `stageAttachmentsIntoSessionDirectory` at
  `packages/app/src/app/pages/session-send-workflow.ts:1225`,
  `routeStagedAttachmentsForModel` at `:1232`,
  `buildPromptParts` at `:1304`,
  `runConversationFromVesloWriteApi` at `:1319`,
  `compactCurrentSession` at `:1394`,
  and `buildCommandFileParts` at `:1423`.

Resolution 2026-07-07:

- Added `createLegacyConversationRunFallback` for the old direct-run
  compatibility path.
- `createSessionSendWorkflow` now receives one explicit
  `legacyConversationRunFallback` adapter instead of direct run-part,
  compact, runtime-admission, and run-submit dependencies.
- `stageAttachmentsIntoSessionDirectory` is no longer a main workflow prop for
  server submit; the main workflow uses `stageServerSubmitAttachments`.
- `node scripts/legacy-symbol-audit.mjs --limit=40` now reports `4`
  dependency-object matches instead of `10`. The old high-signal props are gone
  from the `createSessionSendWorkflow` dependency object.

Residual: the compatibility adapter still exists by design for no-submit-adapter
tests and follow-up compatibility surfaces. Deleting that path entirely remains
a separate product decision.

### 2. Resolved: frontend skill-resolution skip cannot fall through into legacy submit

The current code skips `maybeResolveSkillCommand` whenever
`submitConversationFromVesloWriteApi` is present:

`packages/app/src/app/pages/session-send-workflow.ts:628`

That would be safe only if the server submit route were guaranteed to own every
send target that can proceed after this point. The current code does not enforce
that invariant.

Evidence:

- `maybeResolveSkillCommand` still exists at
  `packages/app/src/app/pages/session-send-workflow.ts:324`.
- The skip branch is controlled by dependency presence, not by a final resolved
  "this target will be handled by server submit" decision
  (`packages/app/src/app/pages/session-send-workflow.ts:628`).
- `submitExistingSessionWithServer` can return `null`, for example when
  `workspaceId` or `directory` is missing
  (`packages/app/src/app/pages/session-send-workflow.ts:685`,
  `:695`).
- When that result is `null`, the workflow does not stop; it continues below the
  server-submit branch
  (`packages/app/src/app/pages/session-send-workflow.ts:996`, `:997`).
- The old direct-run fallback path remains below that branch.

Resolution 2026-07-07:

- Existing-session server submit returning no result now blocks instead of
  falling through to legacy run submission.
- Existing-session server submit with a missing workspace or directory now
  records `sendPrompt:server-submit-existing-missing-target`, reports a typed
  error, and does not run runtime prep or legacy run submission.
- First-session materialization without a submitted or queued server result
  records `sendPrompt:server-submit-first-missing-result` and stops.
- Regression coverage was added in
  `packages/app/src/app/tests/pages/session-send-workflow.test.ts`.

### 3. Medium: BSW05 is behaviorally improved but still app-owned in fallback

The server-owned path now avoids some frontend runtime preflight:

- first-session server submit records
  `sendPrompt:runtime-preflight:server-submit-first-skip`;
- existing-session server submit calls the server submit route directly.

But the app still owns runtime admission and local recovery in the legacy path:

- `prepareRuntimeForLegacySend` exists in
  `packages/app/src/app/pages/session-send-workflow.ts:1005`;
- it calls `prepareSendRuntimeForSend`;
- direct-run recovery also calls `prepareSendRuntimeForSend` after a
  recoverable local runtime error.

Recommended correction: keep this only if the legacy fallback remains a
deliberate compatibility surface. Otherwise, remove it from
`SessionSendWorkflowOptions`. If it remains, move it out of the normal workflow
so the audit can distinguish "normal send path" from "explicit compatibility".

### 4. Medium: BSW06 has a reasonable adapter, but the old builders still leak

Keeping `stageAttachmentsIntoSessionDirectory` as a bounded UI file-session ref
adapter is KISS-acceptable for now. It avoids a larger raw-byte staging rewrite
while still letting the server own submit-time policy.

The problem is that this adapter is mixed with old app-owned run-part
construction:

- `routeStagedAttachmentsForModel` is still a workflow dependency;
- `buildPromptParts` is still a workflow dependency;
- `buildCommandFileParts` is still a workflow dependency.

Recommended correction: keep one bounded adapter for existing UI-held attachment
refs, but remove model routing and OpenCode part construction from the main app
workflow. Those should be server-owned or isolated in a legacy adapter.

### 5. Medium: compact is split between server-owned and direct app paths

The server submit path appears to support `/compact`, but the old fallback still
calls `compactCurrentSession` directly:

`packages/app/src/app/pages/session-send-workflow.ts:1394`

This may be acceptable while the explicit replacement follow-up is still open,
but it should not be counted as deleted legacy frontend submit logic.

Recommended correction: if direct compact must remain for a compatibility
surface, name it that way and keep it out of the normal submit dependency
object.

### 6. Low: general `legacy` variables are separate migration debt

The `--pattern=legacy` run surfaced names that are not part of the composer
submit migration:

- `LEGACY_SIDEBAR_ARCHIVED_SESSION_IDS_KEY`
  (`packages/app/src/app/lib/session-archive-model.ts:8`);
- `legacyRaw` in persistence migration code
  (`packages/app/src/app/utils/persist.ts:162`, `:211`);
- `clearLegacySessionModelPersistence`
  (`packages/app/src/app/lib/model-persistence.ts:27`);
- `buildLegacyFallbackArtifacts`
  (`packages/app/src/app/components/session/artifact-family-model.ts:295`).

These should not be mixed into the server-owned composer submit work. They are
probably compatibility/migration bridges and should get their own allowlist or
separate cleanup issue.

### 7. Low: the tool needs one filtering improvement

`--pattern=legacy` currently acts as an additive custom-pattern marker, not as a
filter. The output still includes the high-score submit symbols.

That is not wrong for discovery, but it is easy to misread. Add one of these:

- `--only-pattern=legacy`;
- `--tag=legacy-run-submit`;
- `--owner=createSessionSendWorkflow`;
- `--dependency-matches-only`.

For the current migration, `--owner=createSessionSendWorkflow` or
`--dependency-matches-only` would be the most valuable.

## Adjacent Debt

The sections below are not in the same severity class as the BSW10 dual-submit
path and the skill-resolution fallthrough bug. They are adjacent debt found by
the same TypeScript audit approach.

### 8. Adjacent: auth fallback paths still create alternate credentials

The token/auth pass found several paths where the app can derive access from
somewhere other than the target workspace's explicit credential.

Evidence:

- `readVesloServerSettings` still reads both current and legacy token storage:
  `STORAGE_TOKEN` and `LEGACY_STORAGE_TOKEN`
  (`packages/app/src/app/lib/veslo-server/connection.ts:9`, `:12`, `:407`,
  `:408`).
- `workspace-activation-remote.ts` can reuse a global settings token for a
  remote workspace when the normalized host matches
  (`packages/app/src/app/context/workspace-activation-remote.ts:105`,
  `:107`, `:111`).
- `remote-store.ts` can create a `tokenlessFallback` workspace if direct
  OpenCode health succeeds without a Veslo server token
  (`packages/app/src/app/stores/remote-store.ts:139`, `:177`, `:191`).
- `resolveOpencodeProxyAuthHeaders` only attaches token auth for `/opencode`
  URLs and deliberately skips loopback Tauri URLs
  (`packages/app/src/app/lib/veslo-server/connection.ts:424`).

Impact: this weakens the "which credential does this server accept right now"
contract. Some of these branches may be intentional compatibility behavior, but
they are currently mixed into normal activation and connection code.

KISS correction: make one credential resolver own this decision. It should
return a typed result such as `workspace-token`, `settings-token-compat`,
`desktop-loopback`, `blocked-missing-token`, or `blocked-rejected-token`.
Anything named fallback should be explicit compatibility, not a silent alternate
success path.

### 9. Medium: server state still has multiple persistence surfaces

The storage pass found at least two app-visible server-setting surfaces:

- `context/server-url.ts` persists `veslo.server.list` and
  `veslo.server.active` for the server provider UI
  (`packages/app/src/app/context/server-url.ts:8`, `:9`).
- `lib/veslo-server/connection.ts` persists `veslo.server.urlOverride`,
  `veslo.server.port`, and `veslo.server.token`, plus the legacy
  `openwork.server.*` mirrors
  (`packages/app/src/app/lib/veslo-server/connection.ts:7` through `:12`).

`shouldPersistServerProviderStorage` avoids persisting the provider surface in
Tauri (`packages/app/src/app/context/server-url.ts:32`), which is good. The
problem is that the codebase still has more than one vocabulary for "current
server" and "current credential".

Impact: this is the same class of drift as the earlier server-access audit,
just at the app TypeScript layer. Even if desktop/runtime identity is fixed, UI
code can still preserve stale remote-mode settings and old OpenWork mirrors.

KISS correction: classify these stores. Keep localStorage only for explicit
remote-server mode, and make desktop-local mode read from the pushed descriptor
or desktop-owned state only. Add an allowlist comment or test for every legacy
mirror that is still retained for migration.

### 10. Medium: app-local queue and pending-draft state remain large

The queue/draft pass confirms that BSW08A is still a real follow-up, not a
paper task.

Evidence:

- `SessionSendWorkflowOptions` still takes pending-draft state and mutators:
  `activePendingDraftKey`, `activePendingDraftMeta`,
  `clearActivePendingDraftState`, `registerPendingSidebarSession`,
  `setActivePendingDraftKey`, `setActivePendingDraftMeta`, and
  `setComposerDraftBySessionId`
  (`packages/app/src/app/pages/session-send-workflow.ts:156`, `:157`,
  `:166`, `:231`, and `packages/app/src/app/app.tsx:1679` through `:1681`).
- `pending-session-draft-controller.ts` has its own async persistence queue and
  generation guard
  (`packages/app/src/app/context/pending-session-draft-controller.ts:272`,
  `:273`, `:288`).
- `session-queue-model.ts` owns app-local queue IDs and states:
  `queued`, `editing`, `sending`, and `error`
  (`packages/app/src/app/components/session/session-queue-model.ts:3`,
  `:14` through `:18`).
- `session-conversation-flow.ts` owns queue drain, edit, cancel, move, pause,
  and stale-drain restore behavior
  (`packages/app/src/app/pages/session-conversation-flow.ts:517`,
  `:650`, `:1310` through `:1381`).

Impact: this is acceptable while BSW08A is explicitly open, but it means the
frontend still owns meaningful send workflow semantics. Server durable run
queue and app-local draft queue are separate systems and should not be described
as one completed queue migration.

KISS correction: keep the UI queue as an explicit UI-only draft queue until the
server API exists. Do not mix it into the claim that server queue admission is
complete. When BSW08A starts, migrate one operation at a time: list, cancel,
edit, move, pause/resume.

### 11. Medium/Low: stale/fallback heuristics are still symptom-level recovery

The stale/fallback pass found two categories:

- legitimate async-race guards, such as `abortIfStale` in session selection
  (`packages/app/src/app/context/session-selection-controller.ts:525`);
- symptom-level recovery rules, such as
  `shouldReleaseStaleWorkspaceRoute`, which matches broad error text including
  `Invalid bearer token`, `unauthorized`, `401`, `404`, `502`, `503`,
  `Failed to fetch`, and timeouts
  (`packages/app/src/app/context/session-runtime-prompts.ts:29`).

There are also route fallback guards and UI transition fallbacks:

- `shouldFallbackFromSessionRoute`
  (`packages/app/src/app/lib/session-route-selection-guard.ts:21`);
- `transitionFallback` for sidebar animation completion
  (`packages/app/src/app/components/session/workspace-session-list.tsx:322`).

Impact: not all fallback names are bad. The UI transition fallback is harmless.
The broad stale-route regex is more important because it can convert auth,
identity, routing, and runtime failures into the same recovery behavior.

KISS correction: keep race guards local, but move server identity/auth/runtime
classification to typed errors or typed connection state. Regex-based release
should become a compatibility catch-all behind narrower typed checks.

### 12. Low: the audit tool needs safer wide-angle modes

The wide pattern passes showed a tooling limit: broad custom patterns such as
`runtime|server|health` or `pending|draft|queue` can produce very large JSON
payloads. One run hit the Node child-process buffer before the command was
rerun with a larger buffer and narrower grouping.

Useful next tool flags:

- `--tag=<tag>` for existing tags such as `legacy-run-submit`;
- `--owner=<factory>` for dependency-object matches;
- `--dependency-matches-only`;
- `--name-pattern=<regex>` as a real filter, separate from the current additive
  `--pattern` tag;
- reference caps in JSON output, so broad scans do not emit every reference for
  globals such as `localStorage`.

This is not required to finish the app migration, but it would make repeated
audits cheaper and less error-prone.

## BSW Mapping

| Plan item | Current audit status | Notes |
| --- | --- | --- |
| BSW04 server draft resolution | Resolved for core gate | Server-submit-wired path skips frontend skill resolution and now fails closed instead of falling through to legacy submit when server ownership cannot be established. |
| BSW05 server runtime admission | Resolved for core gate | Normal server-owned submit path does not call frontend runtime prep; the old prep is isolated in `createLegacyConversationRunFallback`. |
| BSW06 server attachment policy and parts | Resolved for core gate | Main workflow uses `stageServerSubmitAttachments` only as a bounded ref adapter; model routing and OpenCode part construction are isolated in the compatibility adapter. |
| BSW07 server compact | Resolved for core gate | Existing-session compact is server-owned in the normal path; direct compact remains only inside the compatibility adapter. BSW07B is still explicitly open. |
| BSW08 active-run queue admission | Not deeply assessed by this tool | The symbol audit does not inspect queue semantics. Validate with service tests and run/queue state transitions. |
| BSW09 frontend thin submit | Cleaner after follow-up | The normal workflow now delegates old app-owned submit logic to one compatibility adapter. |
| BSW10 delete legacy frontend submit logic | Resolved for core gate | Old direct-run dependencies are no longer direct `createSessionSendWorkflow` props. The explicit compatibility adapter remains. |

## KISS Assessment

The backend direction is not the overengineered part. Server-owned submit is the
right simplification because it collapses skill resolution, runtime admission,
queue admission, command routing, and run submission behind one typed operation.

The original KISS problem was the frontend transition shape:

- one workflow still had both the new submit command and old direct-run command;
- dependency injection hid which path was normal and which path was fallback;
- tests still need to mock legacy dependencies for a workflow that should now be
  thin;
- plan status said "done", while the dependency surface still said "dual path".

The 2026-07-07 follow-up cleanup makes that boundary explicit: normal
server-owned submit uses `submitConversationFromVesloWriteApi`, and the old
direct-run path lives behind `createLegacyConversationRunFallback`.

The simplest robust end state is:

1. `Composer` emits one typed submit intent.
2. `SessionSendWorkflow` calls one submit function for normal sends.
3. The server owns draft resolution, runtime admission, queue admission, compact,
   and run-part construction.
4. The app keeps UI concerns and, temporarily, one bounded attachment-ref
   staging adapter.
5. Any unsupported compatibility path is in a separate module with a name that
   says it is compatibility.

## Recommended Next Steps

1. Treat the dependency-object match list as the cleanup checklist for BSW10.
   The main goal is to remove old submit dependencies from
   `createSessionSendWorkflow`, not to eliminate every symbol containing
   `legacy`.
2. Decide whether the legacy direct-run fallback is still a supported product
   path. If no, delete it. If yes, extract it into a narrow compatibility module
   and keep it out of the normal workflow dependency object.
3. Tighten the frontend skill-resolution invariant. If the app skips
   `maybeResolveSkillCommand`, it must not later fall through into a frontend
   run path that required that resolution.
4. Keep `stageAttachmentsIntoSessionDirectory` only as a bounded ref adapter.
   Rename or type it that way if needed. Remove app-owned model routing and
   OpenCode part building from the normal workflow.
5. Improve the audit tool with `--dependency-matches-only` and
   `--owner=createSessionSendWorkflow`. That would make this exact review
   repeatable without scanning through lower-signal legacy migration names.

## Verification

Commands completed:

```powershell
node scripts/legacy-symbol-audit.mjs --limit=60
node scripts/legacy-symbol-audit.mjs --pattern=legacy --limit=80
git status --short --branch
rg -n "BSW04|BSW05|BSW06|BSW07|BSW08|BSW10|done:" docs/plans/2026-07-06-server-owned-composer-send-workflow-implementation-plan.md
rg -n "maybeResolveSkillCommand|shouldUseServerSubmitBeforeFrontendSkillResolution|prepareRuntimeForLegacySend|stageAttachmentsIntoSessionDirectory|routeStagedAttachmentsForModel|buildPromptParts|buildCommandFileParts|compactCurrentSession|runConversationFromVesloWriteApi|submitConversationFromVesloWriteApi" packages/app/src/app/pages/session-send-workflow.ts packages/app/src/app/app.tsx packages/app/src/app/pages/session-attachment-staging.ts
```

No code was changed by this audit report.
