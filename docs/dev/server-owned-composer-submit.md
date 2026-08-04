# Server-Owned Composer Submit

Updated: 2026-07-10

## State Diagram

```text
Composer
  -> Session.handleSendPrompt
  -> SessionConversationFlow.handleSendPrompt
  -> SessionSendWorkflow.sendPrompt
  -> submitConversationFromVesloWriteApi
  -> POST /workspace/:id/conversations/submit
  -> ConversationSubmitService
  -> ConversationRunLifecycleController
  -> OpenCode session prompt_async / shell / command / summarize
```

`Composer` is the only owner of the live editor value. A send snapshots one
immutable draft revision and offers that snapshot to the session flow. When a
pending submitted row or a local queued item accepts ownership, Composer clears
that exact revision immediately; runtime warmup and server admission continue
without holding the input. A later submit result cannot clear text typed after
that handoff.

When no local owner accepts the snapshot, the `SessionSubmitResult` boundary is
still authoritative. Its typed `draftDisposition` may be applied only while the
submitted Composer revision is still current. Failed, blocked, or missing-submit
results otherwise leave that same live revision available for retry.

## Submit Ownership

The wired input-submit path calls one Veslo server submit command. The server
owns:

- first-session materialization,
- prompt, shell, slash command, skill command, and `/compact` run resolution,
- document-runtime blocking,
- runtime admission through the server lifecycle controller,
- active-run conflict admission through the durable server queue,
- submit-time attachment validation and OpenCode part construction,
- idempotency through `(workspaceId, clientMessageId)`.

The app still owns:

- keyboard/button intent and `source`,
- pending submission state and terminal failure rows,
- the transient local echo used while the canonical transcript row is absent,
- pending-session visual handoff,
- focus, scrolling, toasts, and editor history,
- bounded file-session staging refs for attachments already held by the UI.

## Dependency Audit

Before the migration, the active input path made app-side decisions with these
submit dependencies:

```text
prepareSendRuntimeForSend
maybeResolveSkillCommand
stageAttachmentsIntoSessionDirectory
routeStagedAttachmentsForModel
buildPromptParts
buildCommandFileParts
compactCurrentSession
runConversationFromVesloWriteApi
```

After the migration, the wired production input path depends on:

```text
submitConversationFromVesloWriteApi
createSessionAndOpen with submitDraft for first-session materialization
stageAttachmentsIntoSessionDirectory as a bounded ref adapter
typed SessionSubmitResult / draftDisposition handling
```

The transient local echo is presentation state, not optimistic server
admission and not durable transcript truth. Render replacement and pending
cleanup are separate decisions: the render projection can suppress the echo in
the same projection that includes its canonical row, but pending state is
removed only after confirmed canonical adoption.

`clientMessageId` is the Veslo admission/idempotency key; run and queue ids are
separate lifecycle identities. The app does not inject a Veslo correlation id
into the OpenCode request body. Transcript adoption requires one scoped,
post-baseline user candidate: explicit compatible client metadata wins, then
the bounded text/mode/file fingerprint fallback applies. Ambiguous candidates
remain visible rather than being guessed.

The app input-submit path is server-owned only. `createSessionSendWorkflow`
does not construct or accept a direct-run compatibility bridge. If the Veslo
server submit adapter is unavailable, the workflow fails closed before it can
create or run an OpenCode session. Attachment staging remains a bounded app
adapter, while conversation materialization, model and command resolution,
queue admission, and run lifecycle ownership stay behind the server submit
boundary.
Edit-message replacement uses the same server-owned submit boundary and fails
closed when its submit adapter or scoped target is unavailable. It does not
fall back to app-side revert, runtime preparation, or a direct OpenCode send.
Full queue UI API migration remains a separate follow-up.
