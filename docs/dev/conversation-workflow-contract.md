# Conversation Workflow Contract

This is the short contract for switching between conversations and continuing them through the server-owned composer flow.

## Owners

- Sidebar identity: `workspace-session-list-model.ts` builds scoped row keys and `SidebarSessionOpenTarget`.
- Sidebar open: `session-navigation.ts` is the shared entrypoint for `SessionView` and `DashboardView`.
- Route owner: `app-route-sync.ts` owns URL/hash navigation; `session-route-sync.ts` owns route-to-selection decisions.
- Browse scope: `workspace-session-selection.ts` records the workspace, directory, conversation id, and OpenCode session id for the selected UI session.
- Transcript owner: `session.ts` and `session-transcript-controller.ts` hydrate and guard cached transcript snapshots.
- Live draft owner: `composer.tsx` and `composer-draft-handoff.ts` own the current editor revision and exact-revision release.
- Composer flow: `session-conversation-flow.ts` owns transferred pending submission snapshots, scoped queues, and pending handoff remaps.
- Transcript adoption: `pending-submit-reconciliation.ts` separates same-render local-echo replacement from confirmed pending cleanup.
- Submit transport: `session-send-workflow.ts` and `session-mutation-workflow.ts` own server-owned submit requests.
- Post-submit recovery: `submitted-run-transcript-catchup.ts` owns delayed transcript catch-up after accepted server submits.
- Server warm path: `session-transcript-prefetch.ts` owns transcript prefetch queues and warm snapshots.

## Invariants

- New UI opens must enter through `openSidebarSessionFromList` or another helper that records browse scope before route navigation.
- Raw `sessionId` is not a full identity when rows can share the same id across directories. New callers must pass scoped targets or scoped UI conversation keys.
- Pending session aliases are local UI identities. They must not be selected as real server sessions.
- Route handlers may select a session, but scoped routes must decode to the same UI key that was encoded by `goToSession`.
- Sidebar prefetch should prefer scoped refs (`clickedSession`, `selectedSession`, `loadedTopLevelSessions`, `expandedSubagentSessions`). Legacy raw id fields are compatibility only and must not guess when a raw id is ambiguous.
- Server-owned submit may return `submitted`, `queued`, `blocked`, or `failed`. Assistant catch-up is a bounded fallback for accepted submitted work when the live transcript path did not observe an assistant response.
- Catch-up may hydrate only while the submitted UI session is still selected and belongs to the expected workspace. Assistant SSE or cached assistant messages stop it before another transcript read.
- Pending user rows adopt only a unique, scoped post-baseline transcript candidate. Explicit client metadata wins when present; otherwise normalized text, mode, and attachment/file fingerprints are the bounded fallback.
- Local echo is transient presentation. Same-render replacement does not confirm cleanup, and server acceptance alone does not delete pending state.
- An ambiguous transcript candidate remains visible as local echo rather than being guessed. Only a known pre-admission failure is editable.
- Transcript hydration must ignore unavailable, older, and shorter non-authoritative snapshots.

## Test Anchors

- Sidebar open contract: `packages/app/src/app/tests/pages/session-navigation.test.ts`
- Route contract: `packages/app/src/app/tests/context/app-route-sync.test.ts` and `packages/app/src/app/tests/context/session-route-sync.test.ts`
- Prefetch identity contract: `packages/app/src/app/tests/components/session/workspace-session-list-prefetch-interest.test.ts` and `packages/server/src/tests/session-transcript-prefetch.test.ts`
- Submit and catch-up contract: `packages/app/src/app/tests/pages/session-send-workflow.test.ts`, `packages/app/src/app/tests/pages/session-mutation-workflow.test.ts`, and `packages/app/src/app/tests/context/submitted-run-transcript-catchup.test.ts`
- Queue and pending handoff contract: `packages/app/src/app/tests/pages/session-conversation-flow.test.ts` and `packages/app/src/app/tests/pages/session-message-queue.test.ts`
