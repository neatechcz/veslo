---
title: VSLO-281 MSG Attachment Path Routing And Visible Errors Plan
date: 2026-07-24
status: planned
done: false
base_branch: main
base_commit: 45c6f129736bafdebd73a8657a4b6bd2e295d3d4
source_issue: Showstopper - attaching an MSG file produces no answer and can poison later prompts
target_area:
  - packages/app/src/app/components/session
  - packages/app/src/app/pages
  - packages/app/src/i18n/locales
  - packages/server/src/conversation-submit-contract.ts
  - packages/server/src/conversation-submit-draft-resolution.ts
  - packages/orchestrator/src/run-activity-probe.ts
  - packages/orchestrator/src/run-registry.ts
  - packages/e2e/pilot-scenarios
---

# VSLO-281: MSG Attachment Path Routing And Visible Errors

## Goal

Make non-image attachment delivery safe, understandable, and recoverable.
Veslo must never silently accept a raw binary attachment that the selected
OpenCode provider adapter cannot represent. A staged file is passed to the
agent as a workspace reference, not as an inline binary blob. If Veslo cannot
read a format such as Outlook MSG, the user receives a specific, localized,
actionable error and the conversation remains usable.

The same contract must hold for an existing conversation and for the first
message of a new conversation. The latter has no session-scoped staging target
yet, so the server must be able to create or reuse a safe workspace file before
it materializes the conversation or reserves a run.

The preferred complete outcome for MSG is:

1. keep the original `.msg` inside the target session/workspace directory;
2. deterministically extract its readable email content into a derived text
   artifact when a bundled, verified parser is available;
3. send only workspace paths and text metadata to OpenCode;
4. never send the raw MSG bytes as an OpenCode `FilePart`, including a
   `file://` part mislabeled as text;
5. if extraction is unavailable or fails, block before run admission with a
   typed user-facing error;
6. classify any unexpected OpenCode assistant error as a failed run rather
   than a successful empty completion.

## Executive Decision

The fix should restore the already-approved attachment-staging boundary from
the April attachment design: after successful staging, non-image inline blobs
are removed and the staged path becomes the execution input. The server-owned
conversation submit path is the authority for this rule. The app mirrors it to
avoid transporting unnecessary base64, but the server must remain safe when an
older or malformed client still sends both `dataUrl` and `fileSessionPath`.

Staging is ultimately server-authoritative. An existing app-staged path may be
validated and reused, but a raw non-image attachment on the first submit of a
new conversation must be staged by the server after effective workspace
resolution. It must not be rejected merely because no session-scoped path
could exist before submit.

Images remain the one explicit inline exception because vision models need
their pixels and the existing model-capability gate already owns that decision.
Changing OpenCode engine count, workspace topology, or skill loading cannot fix
VSLO-281 and is out of scope.

MSG understanding is separate from MSG transport:

- **transport safety is mandatory in the hotfix**: raw MSG bytes never reach
  the provider adapter;
- **format support is capability-gated**: Veslo may claim MSG support only
  after a deterministic extractor passes the parser gate below;
- **without that extractor**, `.msg` is rejected with the explicit unsupported
  format copy in this plan. A best-effort prompt that merely hopes a workspace
  skill can decode OLE data is not product-level support.

### Delivery slices

Treat this as independently shippable slices so parser selection and bounded
legacy repair cannot delay the showstopper fix:

1. **Required hotfix:** resolve the effective workspace, safely stage or reuse
   every non-image attachment (including the first message of a new
   conversation), remove original bytes from provider transport, return typed
   and localized errors, preserve terminal failure truth, and prove that a
   subsequent message is usable in the same chat.
2. **MSG support:** add deterministic extraction only after the parser
   capability gate passes on every supported desktop platform.
3. **Optional bounded legacy repair:** automatically remove an old poisoned
   raw part only when exact content and path identity can be proven. Otherwise
   keep history immutable and provide a clear new-chat/re-attach recovery.

Slice 1 closes the silent failure even if Slice 2 is deferred. The release must
describe MSG as unsupported until Slice 2 passes its real fixture and Tauri
gates; keeping the file in the workspace is not by itself evidence that Veslo
can read its contents.

## Incident Summary

Affected release: `v2026.7.14`.

Reproduction:

1. Open a desktop conversation.
2. Attach `Zpráva z webu tomashrachovec_cz.msg`.
3. The browser reports the file as `application/octet-stream`.
4. Send `tady je soubor` or ask Veslo to draft a reply.
5. No assistant text and no visible error appear.
6. A later text-only request in the same conversation may fail in the same
   silent way.

Expected behavior:

- a supported MSG produces a proposed email reply;
- an unsupported or malformed MSG produces a clear error explaining which
  file and format could not be read and what the user can do next;
- a failure is terminal and visible;
- the next message in the same conversation can run normally.

## Verified Current Behaviour

### 1. Composer accepts arbitrary file MIME types

The composer intentionally has no MIME allow-list. A non-image file whose
browser MIME is empty is represented as `application/octet-stream` and encoded
as a data URL. The existing regression test explicitly protects the absence of
a composer MIME allow-list.

That behavior should remain. File selection is not the correct policy boundary:
the same file may be useful through a workspace tool even when it is not valid
as a model-inline attachment.

### 2. Staging succeeds, but the raw attachment is retained

The app writes attachment bytes through the workspace file-session API and
obtains a safe relative path. For a non-image attachment it appends that path
to the resolved prompt text. It then keeps the original attachment in the
draft, and both app and server prompt builders can emit the original data URL
as an inline OpenCode file part.

The resulting request therefore contains two representations of the same file:

- a valid workspace path;
- an unsafe raw binary `FilePart`.

The raw part wins by failing prompt conversion before the model can use the
valid path.

The existing staging path is not sufficient for the first submit of a new
conversation. That server-owned flow can resolve and submit the composer draft
before a session-scoped staging target exists, so the request can still contain
only the raw attachment. A policy that merely blocks every raw-only non-image
would make the failure visible, but would not deliver the intended
workspace-file behavior for new chats.

### 3. Bundled OpenCode accepts the async request but rejects the media type

A deterministic local probe against bundled OpenCode `1.17.13` established:

| Prompt shape | `prompt_async` | Provider reached | Result |
| --- | ---: | ---: | --- |
| text only | `204` | yes | assistant response |
| text + raw `application/octet-stream` file | `204` | no | assistant `UnknownError`, no parts |
| text + staged path only | `204` | yes | assistant response |

The bundled OpenAI-compatible adapter accepts model-inline image, audio, PDF,
and text media shapes. It throws for arbitrary binary/vendor media types. A
rename from `application/octet-stream` to `application/vnd.ms-outlook` would
therefore not solve the problem.

`204` means that OpenCode accepted asynchronous work; it is not proof that the
provider was called or that a response exists.

### 4. Durable lifecycle turns the assistant error into an empty completion

OpenCode stores a terminal assistant message containing `info.error` but no
renderable text parts. The app delegates `session.error` to the server-owned
run lifecycle and deliberately avoids displaying a duplicate transient error.

The run activity probe currently collapses both successful assistant finish
and assistant error into `active: false`. The run registry then writes
`completed` for any inactive probe. The app receives a successful durable
terminal state and has neither assistant text nor a durable failure to render.

### 5. Historical raw parts can poison the conversation

The provider adapter converts the complete conversation history for each new
model request. The unsupported raw file part remains in the earlier user
message. A later text-only prompt can therefore hit the same historical media
error before provider invocation.

OpenCode exposes message-part deletion. The existing user message also contains
the staged path, so a narrowly proven legacy repair can remove only the unsafe
raw part while preserving the user's message and workspace reference.

### 6. Current tests encode the unsafe representation

Focused app, server, and orchestrator tests are green, but they do not cover
the incident. Some tests currently assert that a non-image attachment produces
both a staged path and an inline file part. There is no `.msg` fixture, MSG
parser, bundled-sidecar regression, or real Tauri scenario for this failure.

## Root Causes

1. **Transport and display attachment models are conflated.** Keeping an
   attachment chip visible also keeps its raw data in the provider request.
2. **The server has no non-image transport policy.** Any attachment data URL is
   converted into an inline `FilePart`, regardless of media compatibility.
3. **First-submit staging has no server owner.** A new conversation can reach
   submit with raw bytes before any session-scoped app staging can occur.
4. **MSG readability is undefined.** There is no deterministic MSG extractor
   and no explicit unsupported-format decision.
5. **Async acceptance is treated too optimistically.** `204` is recorded before
   prompt conversion and provider execution finish.
6. **Terminal probe outcome loses failure semantics.** Assistant error becomes
   inactive, and inactive becomes completed.
7. **User-visible copy is untyped.** Pending failures retain a string, while the
   message row reduces most errors to a generic `Send failed` label.
8. **No legacy repair exists.** An invalid historical part can break every
   future turn in the same OpenCode session.

## Blast Radius

The defect is broader than MSG. It can affect any non-image attachment with a
vendor or generic binary MIME, including Office documents, archives, and other
application formats. Those formats may be perfectly usable through workspace
tools, but they are not necessarily legal inline model input.

The corrective policy must therefore be based on attachment kind and staged
workspace ownership, not on a one-off `.msg` MIME special case.

## Target Contract

### Attachment transport matrix

| Input | Required representation | Provider behavior |
| --- | --- | --- |
| Vision image + capable model | validated inline image; staged copy may remain for workspace use | provider receives image bytes |
| Vision image + incapable/unknown model | typed blocked result; preserve draft | provider is not called |
| App-staged non-image file with a valid path | reuse validated workspace-relative path/reference only | provider receives no original binary bytes and no original-file `FilePart` |
| Raw non-image file on first/new-conversation submit | server stages idempotently, then emits a workspace-relative text reference | provider receives no original binary bytes and no original-file `FilePart` |
| Non-image file that cannot be safely staged or referenced | typed staging/reference failure | provider is not called |
| Valid MSG + verified extractor | raw MSG path plus derived readable text path; prompt points to derived text | provider receives paths/text only |
| MSG without extractor | typed unsupported-format result | no run is registered and provider is not called |
| Malformed MSG with extractor | typed processing-failed result | no run is registered and provider is not called |
| Legacy historical unsupported raw part | exact part is removed only after safe-path proof | next prompt can reach provider |

### Canonical non-image representation

After staging, preserve these concepts separately:

- **display metadata**: original filename, original MIME, size, and attachment
  chip identity;
- **workspace reference**: validated workspace-relative path;
- **provider transport**: no `dataUrl`, `contentBase64`, or original-file
  `FilePart` for non-image files.

The OpenCode request represents the original non-image file only as a stable
text line such as `Attached workspace file: <relative-path>`. It must not emit
a `file://` `FilePart`, label the original binary as `text/plain`, or decode the
original binary bytes as text. A `FilePart` is allowed only for a separately
created, verified UTF-8 derived artifact whose media type and bytes agree.

The app's optimistic message may continue to render the original attachment
chip. Canonical adoption must match the staged workspace reference rather than
requiring a `data:` file part. Removing provider bytes must not leave duplicate
local/canonical user rows or silently remove the visible filename.

### Authority and compatibility

- The server resolves the effective workspace/directory scope without creating
  a conversation or admitting a run, then resolves the final attachment
  transport representation against that scope.
- If a non-image attachment contains raw bytes and no reusable validated path,
  the server stages it after workspace resolution and before conversation
  materialization. The destination is deterministic for the submit identity
  (for example `clientMessageId` plus sanitized filename/content hash), uses a
  bounded decode and atomic write, and is idempotent across submit retries.
- An existing app-staged path is reused only after proving that its real path
  exists inside the authenticated workspace/staging root, is a regular file,
  and does not traverse or resolve through a symlink. Validation must avoid a
  check/read or check/delete scope change where the platform permits it.
- Attachment normalization, optional MSG extraction, and every known blocked
  result finish before conversation materialization and run admission. The
  current ordering, where draft/run input resolution precedes final directory
  resolution, must be adjusted rather than letting a parser infer its target
  directory from unvalidated request text.
- An old client that sends both path and data for a non-image file is accepted
  only if the path is valid; the server discards the raw data.
- A non-image attachment with raw data but no safe path is server-staged. It is
  blocked only when bounded staging fails. There is no compatibility fallback
  back to inline binary.
- The app stops sending non-image base64 after successful staging to reduce
  request size and prevent accidental reintroduction.
- Direct/legacy app prompt construction follows the same rule while that path
  remains reachable.
- Shell and slash-command flows receive quoted/escaped staged paths and never
  raw file parts.

## User-Facing Error Contract

Server results use stable codes and structured safe details. The app localizes
from the code; it does not parse an English server sentence or raw OpenCode
message. The server keeps a safe English fallback `message` for non-app API
clients.

Safe details may include `attachmentName`, normalized `format`, and suggested
alternatives. They must not include data URLs, file contents, absolute paths,
provider credentials, or unrelated prompt text.

### Required codes and copy

| Code | Czech UI copy | English UI copy | Disposition |
| --- | --- | --- | --- |
| `attachment_format_unsupported` | `Soubor „{name}“ je ve formátu {format}, který tato verze Vesla zatím neumí přečíst. Exportujte ho jako EML, PDF nebo TXT a odešlete znovu.` | `Veslo cannot read the {format} format of “{name}” in this version. Export it as EML, PDF, or TXT and send it again.` | blocked before run; restore draft/chip |
| `attachment_processing_failed` | `Soubor „{name}“ se nepodařilo přečíst. Může být poškozený nebo není platným souborem {format}. Otevřete ho a znovu exportujte.` | `Veslo could not read “{name}”. It may be damaged or not a valid {format} file. Open it and export it again.` | blocked before run; restore draft/chip |
| `attachment_staging_failed` | `Soubor „{name}“ se nepodařilo uložit do pracovní složky. Zkontrolujte, že je složka dostupná, a zkuste to znovu.` | `Veslo could not save “{name}” to the workspace. Check that the folder is available and try again.` | known pre-admission failure; keep editable draft |
| `attachment_reference_missing` | `Soubor „{name}“ se nepodařilo připravit ke zpracování. Odeberte ho, přiložte znovu a zprávu znovu odešlete.` | `Veslo could not prepare “{name}” for processing. Remove it, attach it again, and resend the message.` | blocked before run; restore draft/chip |
| `model_attachment_unsupported` | `Vybraný model neumí zpracovat obrázek „{name}“. Přepněte na model s podporou obrázků a odešlete zprávu znovu.` | `The selected model cannot inspect “{name}”. Switch to a model with image support and resend.` | blocked before run; restore draft/chip |
| `attachment_runtime_rejected` | `Soubor „{name}“ ({format}) se nepodařilo zpracovat. Odeberte ho nebo ho znovu přiložte v podporovaném formátu. Chat můžete dál používat.` | `Veslo could not process “{name}” ({format}). Remove it or attach it again in a supported format. You can continue using this chat.` | accepted run becomes failed; release queue |

Copy rules:

- show the filename and human format (`MSG`), not only
  `application/octet-stream`;
- use `attachment_format_unsupported` only after the format is identified from
  extension plus signature/capability policy; generic
  `application/octet-stream` alone does not prove that a file is unsupported;
- say what happened and what the user can do;
- suggest EML, PDF, or TXT only for confidently identified email formats such
  as MSG; generic binary/runtime errors must not recommend unrelated formats;
- do not say `Send failed` when the known cause is the file format;
- do not expose `UnknownError`, `FilePart`, provider-adapter terminology, or a
  raw upstream stack;
- retain a diagnostic code and normalized MIME in developer traces;
- use exactly one visible error owner: a pre-admission blocked/failed submit
  annotates the pending user row and creates no durable session error turn; an
  accepted run that later fails creates one durable error turn after canonical
  adoption, while the raw OpenCode event remains only a wake-up signal;
- render that owner visibly, not only in a hover `title`.

## MSG Parser Capability Gate

Do not select a parser by package popularity alone. Before Veslo labels MSG as
supported, a candidate must pass all of these gates:

1. Parse a real OLE/Compound File Binary MSG fixture, not a renamed text file.
2. Preserve Unicode subject, sender, recipients, sent date, and body.
3. Prefer plain text, with deterministic HTML-to-text and RTF fallback.
4. List embedded attachment names and sizes without executing or automatically
   opening their content.
5. Reject malformed/truncated input with a bounded typed error.
6. Enforce existing attachment size limits and bounded parse time/memory.
7. Work in the compiled Bun-based Veslo server on Windows, macOS, and Linux
   without undeclared host tools or an optional workspace skill.
8. Have an acceptable license and be added to dependency/license inventory.
9. Never load remote resources referenced by email HTML.

If no candidate passes, VSLO-281 still ships the transport and visible-error
hotfix, but MSG remains explicitly unsupported. The plan must not claim the
first acceptance criterion until the parser gate and real MSG E2E pass.

When the gate passes, normalize a valid message into a deterministic UTF-8
artifact under the target session directory. Suggested content:

```text
Subject: ...
From: ...
To: ...
Cc: ...
Date: ...

Body:
...

Embedded attachments:
- filename.ext (size)
```

The prompt references the derived text artifact and may also identify the raw
MSG path as the original. Only paths and extracted text reach the model.

## Implementation Plan

### VSLO281-01: Lock the current failure with focused tests and fixtures

Add a minimal valid MSG fixture and a malformed/truncated fixture. Fixtures
must contain synthetic data only.

Add failing tests proving the current defect:

- app staging returns a safe relative path for
  `application/octet-stream`/`.msg`;
- server dry-run currently includes a raw non-image `FilePart` and must stop;
- a first-message/new-conversation raw MSG is server-staged before conversation
  materialization and never becomes an OpenCode file part;
- an old-client payload containing both `dataUrl` and `fileSessionPath` is
  normalized to path-only;
- replaying the same submit identity reuses the same staged file and does not
  create suffixed duplicates;
- a raw-only non-image payload is blocked only when bounded server staging
  fails, and is never forwarded inline;
- no original non-image request produces a `data:`, base64, or `file://`
  `FilePart`, including one mislabeled as `text/plain`;
- path escape, symlink, missing-file, and non-regular-file references are
  rejected before read, parse, or provider invocation;
- pending transcript adoption can replace a staged path-only optimistic
  attachment without leaving a duplicate row;
- assistant `info.error` is currently reconciled as completed and must become
  failed;
- a stale assistant error from the previous turn cannot fail a newly admitted
  run, while a current-run error does;
- a known pre-admission failure and an accepted runtime failure each produce
  exactly one visible error through their respective owner;
- current generic pending copy does not identify the attachment format.

Likely test anchors:

- `packages/app/src/app/tests/lib/attachment-prompt-routing.test.ts`
- `packages/app/src/app/tests/pages/session-attachment-staging.test.ts`
- `packages/app/src/app/tests/components/session/pending-submit-reconciliation.test.ts`
- `packages/server/src/tests/conversation-submit-draft-resolution.test.ts`
- `packages/server/src/tests/conversation-submit-service.test.ts`
- `packages/orchestrator/src/tests/run-activity-probe.test.ts`
- `packages/orchestrator/src/tests/run-registry.test.ts`

Do not weaken the existing composer test that permits arbitrary files to be
selected. The new policy starts after staging.

### VSLO281-02: Make server staging and attachment transport explicit

Introduce one pure server-side attachment transport classifier used by prompt,
command, and shell resolution. Its output is one of:

- `inline-image`;
- `workspace-reference`;
- `derived-text-reference`;
- `blocked` with a stable error code and safe details.

Update conversation submit resolution:

1. Resolve the effective directory and verify that it belongs to the
   authenticated workspace before attachment normalization. This lookup must
   not materialize a conversation or reserve a run.
2. Validate every `fileSessionPath` using realpath containment against both the
   authenticated workspace root and the effective staging scope. Require an
   existing regular file and reject symlinks, devices, and path escapes.
3. For a non-image raw attachment without a reusable path, perform a bounded,
   server-owned, atomic, idempotent write under the resolved workspace. Key the
   destination from stable submit/attachment identity and sanitized filename
   or content hash so retries cannot create `(1)`/`(2)` copies.
4. For `kind: file`, ignore and erase `dataUrl` and `contentBase64` after a
   validated path exists.
5. Build only a text path reference for the original file. Do not build a
   `file://` or fake `text/plain` `FilePart` from the binary.
6. Block with `attachment_staging_failed` when raw bytes cannot be safely
   staged, or `attachment_reference_missing` when neither usable bytes nor a
   valid reference exist.
7. Keep current image model-capability validation and inline image behavior.
8. Apply the same path-only policy to command and shell arguments.
9. Trace only classification, normalized MIME, extension, and byte count; do
   not trace data URLs or absolute paths.

Only after these steps return a valid resolved run input may the submit service
materialize a new conversation, reserve a run, or call OpenCode. A blocked
first send may retain its already-staged workspace file, but it must not create
an OpenCode user message or an active run.

This server defense must pass both with an intentionally old-client request
that contains raw MSG plus a valid path and with a first-message request that
can contain only raw MSG before server staging.

### VSLO281-03: Stop app transport from retaining non-image base64

After successful staging, the app should retain display metadata while its
server submit DTO sends:

- original name/kind/MIME;
- validated `fileSessionPath`;
- no `dataUrl` or `contentBase64` for non-image files.

Update the direct compatibility prompt builder so it also emits path-only
non-image input. Do not keep an app-only behavior that can reproduce the bug
when server-owned submit is unavailable.

Keep the exact composer draft revision semantics:

- a known staging/reference/format failure restores or retains the submitted
  draft and attachment chips;
- a newer composer revision is never overwritten;
- retry reuses the same attachment identity and does not create duplicate
  optimistic rows;
- successful canonical path-only adoption preserves the visible filename.

If display metadata cannot survive canonical adoption without an inline data
part, add a Veslo-owned display projection keyed by client/canonical message
identity. Do not reintroduce raw provider bytes merely to render a chip.

### VSLO281-04: Add deterministic MSG normalization or declare it unsupported

Run the parser capability gate. If it fails, implement only the typed
`attachment_format_unsupported` result for `.msg` and record MSG support as
absent.

If it passes:

1. Add a small server-owned MSG normalizer behind the generic attachment
   classifier; do not place core attachment ingestion inside a workspace skill.
2. Validate extension, normalized MIME, and compound-file signature. MIME alone
   is untrusted and `application/octet-stream` is expected on Windows.
3. Read only the validated staged file within the workspace.
4. Produce the deterministic UTF-8 derived artifact described above.
5. Return `derived-text-reference` and reference that artifact in the prompt.
6. Preserve the original raw MSG file in the workspace.
7. Return `attachment_processing_failed` for malformed input without
   registering a run.
8. Keep embedded attachment content out of the first implementation; list safe
   metadata only.

### VSLO281-05: Carry typed errors into localized visible UI

Extend the backwards-compatible conversation submit result with optional safe
error details. Preserve the existing `code` and fallback `message` fields.

Carry `code`, fallback message, and safe details through pending submit state.
Replace substring-based generic classification for these known codes with an
explicit presentation model. Add Czech and English locale keys for the copy
matrix above.

UI requirements:

- for a pre-admission blocked/failed submit, show the full specific message in
  the pending user-turn area and do not append a durable session error turn;
- for an accepted run that later fails, adopt the canonical user row and show
  exactly one durable session error turn;
- use an accessible alert/status role;
- keep the attachment name visible;
- preserve retry/edit behavior according to `draftDisposition`;
- never show only `Odeslání selhalo` for a known attachment code;
- keep raw server/OpenCode detail available only in developer diagnostics.

### VSLO281-06: Preserve assistant-error terminal semantics

Implement this through the shared stable-terminal work in
`2026-07-24-vslo-282-duplicate-transcript-premature-terminal-recovery-plan.md`; do not
create a second VSLO-281-only terminal algorithm. VSLO-281 adds the unsupported
attachment regression and safe error mapping to that shared lifecycle owner.

The shared run activity result must distinguish at least `completed` from
`failed`. Do not infer success from `active: false`, and never classify a new
run from the last assistant message without proving that the evidence belongs
to that exact run.

Required reconciliation rules:

- current-run assistant completion/finish without error -> `completed`;
- current-run assistant `info.error` -> `failed` with a bounded sanitized
  message;
- `MessageAbortedError` with durable abort intent -> `aborted`;
- missing/unreachable evidence retains existing conservative behavior;
- an idle session-status response must not short-circuit transcript inspection
  when an active run still needs success/failure classification.

Run correlation must use either a deterministic user `messageID` carried into
OpenCode and persisted with the run, or a pre-submit transcript watermark plus
a matching post-watermark user/assistant chain. A stale completion or error
from the previous turn must leave the new run active. Stable idle/quiescence,
active-tool, and late-event behavior remains owned by the shared terminal plan.

The server lifecycle controller must ingest the terminal transcript, release
the active reservation, and wake the next queued run. The app's durable
terminal handler displays one error turn. The raw `session.error` event remains
a wake-up signal and must not create a duplicate error.

The recognized OpenCode unsupported-media error should be normalized to the
safe attachment runtime fallback, not exposed verbatim. New fixed submissions
should normally be blocked before reaching this fallback.

### VSLO281-07: Repair conversations poisoned by older releases

Before admitting a new run to an existing session, perform a bounded legacy
sanitation check when the canonical transcript contains an unsupported
non-image `data:` file part.

The automatic repair may delete only the unsafe part, never the complete user
message, and only when all of these are true:

1. the message belongs to the exact workspace, directory, and OpenCode session;
2. the file part has a media type that cannot be represented inline;
3. the referenced staged file resolves inside the workspace/staging root, is a
   regular file, and is not a symlink;
4. bounded decoding proves that the raw part and staged file have the same
   SHA-256, size, and filename/attachment identity;
5. no run is active for the conversation;
6. the bundled OpenCode version exposes the exact part-delete capability;
7. the OpenCode part ID is exact and the delete request is directory-scoped.

After deletion, reconcile the canonical transcript before submitting the next
prompt. The operation is naturally idempotent because a deleted part no longer
matches.

If any capability or content proof is absent, do not mutate history. Block with
a clear recovery message and offer a new-chat/re-attach path instead of
claiming the old chat was repaired. This optional migration must not delay the
required prevention and visible-error hotfix.

If optional automatic repair is implemented, add a bundled OpenCode integration
scenario:

1. create an old-style user message containing path text plus a raw
   `application/octet-stream` part;
2. observe the unsupported-media assistant error and zero provider calls;
3. remove the exact raw part through the supported OpenCode endpoint;
4. submit a normal follow-up in the same session;
5. prove that the provider is reached and returns assistant text.

If automatic repair is deferred, replace that positive deletion scenario with
a negative proof that no part is mutated without exact content identity and
that the user receives the documented new-chat/re-attach recovery.

### VSLO281-08: Add the real Tauri regression scenario

Replace or extend the current shallow attachment-staging Pilot scenario with a
real desktop flow named for `VSLO-281`.

Use a fresh isolated desktop profile, the real compiled Veslo server,
orchestrator, bundled OpenCode sidecar, and a deterministic loopback provider.
Drive the actual composer file input with a committed synthetic MSG fixture
whose browser MIME is `application/octet-stream`.

Required branches:

Run the primary MSG case twice: once as the first message of a brand-new chat
and once in an existing chat. The new-chat branch is mandatory because it
exercises server-owned pre-materialization staging rather than only the
existing session staging path.

#### Supported branch, only when the parser gate passes

1. Attach the valid MSG.
2. Ask for a reply to the email.
3. Assert the file is staged under the target session/workspace directory.
4. Assert the provider request contains the derived text/path and has no raw
   MSG data URL, base64, original-file `FilePart`, or binary `file://` part.
5. Assert the assistant response contains fixture-specific subject/body
   evidence.
6. Assert the run is `completed`.

#### Unsupported/malformed branch

1. Attach an unsupported or malformed MSG.
2. Submit it.
3. Assert the localized specific error contains filename, `MSG`, and an action.
4. Assert no provider call occurred.
5. Assert no run was admitted for a known preflight rejection and no active
   run remains.
6. Assert the draft/chip disposition matches the typed result.
7. Assert exactly one visible error owner; no duplicate error turn appears.

#### Conversation recovery branch

1. After a new fixed MSG rejection, submit a plain text follow-up in the same
   chat and assert that the provider returns a visible answer.
2. If optional legacy repair ships, seed an old-style poisoned message, submit
   a follow-up, and assert that content-proven sanitation removed only the
   unsafe part.
3. If legacy repair does not ship or proof is incomplete, assert that history
   is not mutated and the UI gives a clear new-chat/re-attach recovery.
4. Assert the conversation queue is empty and terminal state is correct.

Add a focused E2E script alias so this scenario can run independently before
the full current gate.

### VSLO281-09: Promote the implemented contract into durable docs

After runtime implementation is verified, update:

- `docs/dev/conversation-workflow-contract.md` with the path-only non-image
  attachment and typed failure rules;
- `docs/dev/veslo-server-app-contract.md` with the server-authoritative
  attachment normalization contract;
- `docs/features/session-runtime.md` if MSG support or unsupported-format copy
  is user-visible shipped behavior;
- the testing playbook with the focused VSLO-281 Tauri command if it becomes a
  durable quality gate.

This plan remains historical and must not become the only documentation of the
shipped behavior.

## Acceptance Criteria

- A staged non-image attachment never sends its original `dataUrl`,
  `contentBase64`, `file://` reference, or original-file `FilePart` to
  OpenCode.
- A raw first-message non-image attachment is staged idempotently by the server
  before conversation materialization; replaying the submit creates no
  duplicate file or user row.
- An old client cannot bypass that rule by sending both raw data and a path.
- A raw-only non-image attachment is blocked before provider invocation only
  when safe bounded staging fails; there is no inline-binary fallback.
- `application/octet-stream` and `application/vnd.ms-outlook` do not reach the
  OpenAI-compatible adapter as raw MSG file parts.
- A supported valid MSG is converted to a readable derived artifact and yields
  a relevant assistant response.
- If MSG support is not shipped, the UI explicitly says that MSG is unsupported
  and suggests EML, PDF, or TXT.
- A malformed MSG produces the processing-failed copy, not a generic send
  failure or raw `UnknownError`.
- The failed draft/attachment remains recoverable according to the typed
  disposition and a newer composer revision is never overwritten.
- A current-run assistant message with `info.error` terminalizes the durable
  run as `failed`, releases admission, and displays one visible error.
- A stale completion or error from an earlier run cannot terminalize a newly
  admitted run; idle alone is not terminal authority.
- A subsequent text message in the same conversation reaches the provider,
  including the legacy poisoned-session fixture.
- Canonical path-only transcript adoption leaves exactly one user row and keeps
  a visible filename/reference.
- Path validation rejects escapes, symlinks, non-regular files, and mismatched
  legacy content; unproven history is never mutated.
- The Tauri Pilot scenario covers valid or explicitly unsupported MSG,
  first-message and existing-chat staging, terminal lifecycle truth, one-error
  ownership, and same-chat recovery.
- Existing vision image behavior, slash commands, shell mode, remote workspace
  staging, and arbitrary composer file selection remain intact.

## Verification

Start with focused tests:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/attachment-prompt-routing.test.ts src/app/tests/pages/session-attachment-staging.test.ts src/app/tests/components/session/pending-submit-model.test.ts src/app/tests/components/session/pending-submit-reconciliation.test.ts src/app/tests/context/session-event-stream.test.ts src/app/context/session-lifecycle-recovery.test.ts

pnpm --filter veslo-server exec bun test src/tests/conversation-submit-draft-resolution.test.ts src/tests/conversation-submit-service.test.ts src/tests/conversation-run-lifecycle-controller.test.ts

pnpm --filter veslo-orchestrator exec bun test src/tests/run-activity-probe.test.ts src/tests/run-registry.test.ts
```

Then rebuild and run the bundled compatibility proof:

```powershell
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build
node packages/orchestrator/scripts/opencode-msg-attachment-path.integration.mjs
```

Before desktop testing, follow the single-tenant runtime preflight in
`docs/dev/testing-playbook.md`. Then build the real Pilot-enabled desktop and
run the focused scenario:

```powershell
pnpm --filter @neatech/veslo-e2e run build:desktop:e2e
pnpm --filter @neatech/veslo-e2e run test:pilot:vslo-281-msg-attachment
```

Finish with:

```powershell
pnpm check
git diff --check
```

Because this changes `packages/server/src`, the server binary rebuild is a
required gate before any orchestrator-backed or Tauri claim.

## Rollout

Ship server-owned staging, path-only transport, typed errors, and the shared
lifecycle correction without a feature flag after the bundled OpenCode and
Tauri gates pass. They restore an existing intended boundary and prevent
unsupported bytes from reaching the provider.

Legacy sanitation is optional and capability/content-proof gated. If it is not
ready, ship prevention plus truthful recovery guidance; do not weaken deletion
proof or delay the showstopper hotfix.

MSG parsing may ship in the same release only if its capability gate passes on
all supported desktop platforms. Otherwise ship the explicit unsupported MSG
copy and track parser enablement separately; do not leave a hidden best-effort
mode.

Observe redacted counters for:

- attachment transport classification;
- unsupported format by normalized extension/MIME;
- processing failure;
- legacy part sanitation success/failure;
- terminal assistant error classification.

Never record filenames in aggregate telemetry unless the existing diagnostic
capture is explicitly user-authorized; normalized format is sufficient.

## Non-Goals

- Do not change pooled/shared OpenCode engine topology or workspace skill
  loading.
- Do not add a composer MIME allow-list.
- Do not send raw non-image bytes merely because a provider may accept them in
  a future version.
- Do not rely on a workspace-local skill as the mandatory MSG ingestion layer.
- Do not execute embedded MSG content or automatically unpack embedded
  attachments in the first implementation.
- Do not redesign the whole transcript or run schema solely for attachment
  presentation.
- Do not expose raw upstream errors, absolute paths, file contents, or data URLs
  in user-visible copy or normal telemetry.

## Definition Of Done

`done: true` is allowed only after:

1. the server-authoritative path-only policy is implemented;
2. first-message raw non-image input is staged atomically and idempotently
   before conversation materialization;
3. provider proof shows zero original non-image FileParts, including
   `file://`/fake-text variants;
4. typed localized error copy has exactly one visible owner in the real desktop
   app;
5. exact-run assistant errors become durable failed runs through the shared
   stable-terminal owner, while stale prior evidence cannot close a new run;
6. same-chat follow-up passes, and any shipped legacy repair passes the
   capability plus content-identity proof;
7. the bundled OpenCode integration and focused Tauri Pilot scenario pass
   against freshly rebuilt binaries;
8. durable developer/feature documentation reflects the shipped MSG support
   level;
9. `pnpm check` and `git diff --check` pass.
