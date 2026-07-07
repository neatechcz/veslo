# Server-Owned Composer Submit

Updated: 2026-07-07

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

The `Composer` boundary is typed by `SessionSubmitResult`. The editor clears
only when the result carries `draftDisposition: "clear"`. Failed, blocked, or
missing-submit results leave the draft available for retry.

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
- optimistic pending rows,
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

The old direct run helper remains in the app service for explicit compatibility
surfaces and tests where the submit adapter is unavailable. It is not the
normal wired input-submit path. Edit-message replacement and full queue UI API
migration remain separate follow-ups.
