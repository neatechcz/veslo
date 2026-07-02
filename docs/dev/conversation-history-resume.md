# Conversation History Resume

This note documents the current conversation-history behavior after CHR01-CHR06.
It is a contract for old scoped sidebar conversations, not a promise that Veslo
can fully recreate an OpenCode session from a stored transcript.

## Identity Model

Conversation history uses three related identities:

- UI session id: the id selected in the Veslo UI and used for route/cache state.
- Veslo conversation id: the durable conversation id exposed by the Veslo server.
- OpenCode session id: the engine session id used for OpenCode `session.messages`,
  prompt, transcript, and abort calls.

The UI cache may be keyed by the selected UI session id while engine reads and
server transcript writes must use the OpenCode session id. This is intentional:
route guards and sidebar selection need the UI id, but OpenCode only knows the
engine id.

## Host-First Passive Browse

Selecting an old scoped sidebar conversation is a passive browse operation. The
app reads the host transcript first and does not activate the owning workspace
or cold-start OpenCode just to browse.

The transcript read has three meaningful outcomes:

- `loaded`: host transcript has messages and is rendered from the selected UI id.
- `empty`: host transcript is durably empty and is treated as a successful load.
- `unavailable`: host history could not be read and must stay distinct from
  empty history.

Unavailable history is surfaced as a retryable state. It must not be collapsed
into an empty transcript, and it must not mark the session as message-complete.

## Live Fallback Limits

Automatic live recovery is intentionally narrow. It is allowed only when:

- the selected session has scoped conversation metadata,
- the host transcript read is `unavailable`,
- the scoped workspace is already the active workspace,
- that workspace runtime is ready, and
- an OpenCode session id is available.

In that case, `selectSession` calls live `session.messages` with the OpenCode
session id, stores the recovered messages under the UI session id, and backfills
the host transcript through the existing append path under the OpenCode session
id.

If the workspace is not active, passive browse remains passive. The retry action
is the explicit user choice that activates the owning workspace, restores the
same scoped identity, and runs selection again.

## Durable Backfill

Recovered live history is backfilled through the existing app/server append
path. Empty recovered history is also durable: the server stores an empty
transcript marker so later passive reads can distinguish "empty but available"
from "unavailable".

Conversation id routes on the server resolve through the binding store before
engine contact. Transcript, run, and abort routes must resolve to the same
OpenCode session id for the owning workspace, and cross-workspace conversation
ids are rejected before any engine call.

## What Veslo Transcript Is Not

A Veslo transcript is a host-side display and recovery cache. It is not a full
OpenCode session restore. It does not guarantee the same engine-local state,
tool/runtime state, pending prompts, provider state, or internal session metadata
that OpenCode keeps under its own session id.

If the original OpenCode session is gone, Veslo can still display durable host
history when present, but it cannot currently resume the conversation as the
same OpenCode engine session from transcript data alone.

## Future Import Research

OpenCode has a CLI import surface that may be useful for future recovery work,
but Veslo does not currently use an HTTP or SDK restore API to rebuild an
OpenCode session from a Veslo transcript. Treat CLI import as future research,
not current resume behavior.
