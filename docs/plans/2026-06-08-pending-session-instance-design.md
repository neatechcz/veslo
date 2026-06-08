# Pending Session Instance Design

## Context

Veslo now routes conversation creation and prompt runs through workspace-scoped
Veslo server APIs. In the reported flow, the final server-side behavior is
correct: messages are submitted to the right conversations and workspaces.

The broken behavior is in the first local UI phase after Send. When a user
creates a new session, sends a first message, then quickly creates another new
session and sends another first message, the optimistic submitted messages can
temporarily render in the same chat window. This can happen across workspaces,
between chat and project sessions, or inside the same project. The issue is
that the session page has pending send state that is scoped too broadly for
multiple simultaneously materializing sessions.

## Goals

- Preserve the current send rendering: the user message appears immediately,
  and the existing response indicator appears below it.
- Keep final server routing unchanged: the Veslo server remains responsible for
  creating and binding conversations to workspaces.
- Prevent pending messages, run state, edit state, queue state, and failure
  state from leaking between simultaneously created sessions.
- Ensure the left sidebar creates or updates the session row in the correct
  section or workspace group as soon as the session is locally materialized.
- Cover multiple end-to-end variants, including two chats, chat plus project
  session, and two project sessions in the same workspace.

## Non-Goals

- Do not change message list layout, transcript grouping, response indicator
  visuals, or composer behavior.
- Do not make the app wait for server session creation before showing the user
  message.
- Do not move OpenCode session id selection into the app.
- Do not change Veslo server conversation binding semantics.

## Proposed Design

Introduce a local pending session instance identity for every first-send flow.
The id is created at the moment the user submits a message for a not-yet-real
session, for example `pending-session:<uuid>`.

This id is UI-only. It is not an OpenCode session id, not a Veslo conversation
id, and not persisted as a durable runtime identifier. It exists to keep all
local state for one materializing session isolated until the server returns the
real conversation/session identity.

Each pending session instance stores immutable target context:

- pending session instance id,
- target workspace id,
- workspace root or chat/private target context,
- submitted draft,
- optimistic title,
- created timestamp.

Mutable state for that instance includes:

- optimistic submitted message state,
- run indicator state,
- editable failed pending message state,
- queued drafts,
- stop/paused queue state,
- materialization state and any local failure.

When the server creates the real conversation/session, the app atomically maps
only the matching pending session instance to the returned session id,
conversation id, OpenCode session id, workspace id, and directory. Other
pending sessions, including sessions in the same workspace, are not touched.

## Rendering Contract

The visual behavior remains the same as today:

1. The submitted user message appears immediately in the active chat.
2. The existing response indicator appears below it.
3. The message list still renders the pending message through the same
   user-message path used by the current optimistic submit model.

The only change is selection: the session page derives the active pending
runtime state from the current session key or pending session instance id, not
from a single global optimistic submitted draft.

## Sidebar Contract

First-send session materialization creates a sidebar entry tied to the pending
session instance and its target workspace context.

Before the server returns, the sidebar may show a local placeholder row with the
optimistic title in the correct section:

- chat sessions in the chat/private section,
- project sessions in the correct workspace group.

After the server returns, that placeholder is replaced or remapped to the real
session id. The update uses the workspace id captured for the pending session
instance, or the workspace id returned by the conversation API, not whatever
workspace happens to be active after a user click.

This prevents a quick workspace switch from inserting the row into the wrong
workspace group.

## Failure Behavior

Failures remain scoped to the pending session instance or real session that
caused them.

- If creation fails before a real session exists, the pending message remains
  in its pending session context and can be edited or retried there.
- If the conversation was created but the run fails, the sidebar row remains in
  the correct workspace group and the error is shown only in that session.
- Switching away during send does not clear, move, or globally overwrite
  pending state.

## Test Matrix

Add focused model/unit coverage for pending session state:

- two pending sessions in different workspaces do not merge,
- two pending sessions in the same workspace do not merge,
- pending-to-real remap affects only the matching pending instance,
- failures stay with the correct pending or real session.

Add or extend Tauri-pilot coverage against the real desktop runtime:

- two clean chat sessions created and sent quickly,
- one clean chat plus one project session created and sent quickly,
- two new sessions in the same project created and sent quickly.

Each E2E scenario should verify the pending phase and the post-materialization
phase:

- the left sidebar has distinct rows in the correct location,
- each selected session shows only its own submitted message,
- the existing response indicator behavior is preserved.

## Risks

The main risk is coupling too much behavior to pending session ids and changing
normal existing-session sends by accident. The implementation should keep the
new state path limited to first-send materialization and continue using real
session ids for existing conversations.

Another risk is sidebar duplication if both a local placeholder and a server
conversation list refresh arrive. Sidebar reconciliation must treat a remapped
pending instance and the server session as the same row once the real id is
known.
