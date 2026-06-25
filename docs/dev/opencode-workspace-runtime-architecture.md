# OpenCode Workspace Runtime Architecture

This is the canonical developer reference for Veslo's OpenCode workspace runtime
architecture. Use it before changing prompt sending, session creation,
workspace switching, local Veslo server lifecycle, orchestrator routing,
sandbox behavior, or any server route that talks to OpenCode.

The historical design and implementation planning documents live in
`docs/plans/2026-06-07-opencode-workspace-runtime-design.md` and
`docs/plans/2026-06-07-opencode-workspace-runtime-implementation-plan.md`.
Those documents explain the decision history. This file is the durable source
of truth for future implementation work.

## Core Rule

OpenCode sessions are created in the correct workspace directory and then remain
bound to that directory through the Veslo conversation.

The app must not create an OpenCode session, choose an OpenCode session id, or
override the OpenCode directory as a side effect of current UI selection. The
app sends intent. Veslo resolves execution.

## Verified OpenCode Behavior

OpenCode 1.16.2 was empirically checked outside this repository with one
`opencode serve` process and multiple temporary directories.

Verified behavior:

- one OpenCode server process can create multiple sessions in different
  directories,
- concurrent shell actions in those sessions run in their own session
  directories,
- an existing session remains pinned to the directory where it was created,
- passing a different directory later does not retarget that existing session.

Implication: the non-sandbox runtime can use a shared OpenCode process for
multiple workspaces, but each Veslo conversation must create or reuse the
OpenCode session that already belongs to its workspace directory.

This verification covered session and shell filesystem behavior. Real model
prompt streaming still needs desktop end-to-end validation when implementation
changes.

## Ownership Boundaries

### Solid App

The app owns user intent and visible UI state.

The app may send:

- workspace id,
- conversation id when continuing a known conversation,
- message content,
- user-selected model, agent, or variant choices.

The app must not send:

- a client-chosen OpenCode session id for a new run,
- a raw OpenCode directory override,
- a run target based only on the currently selected workspace,
- global busy or error state that represents a different workspace run.

When the user sends the first message, the app should show a prepared local
message and let the runtime attach the workspace and create the conversation in
the background. Workspace activation must not be a UI-blocking precondition for
the send action.

### Veslo Server

Veslo server owns the app-facing conversation and run boundary.

Responsibilities:

- validate the workspace id,
- validate and normalize the workspace directory,
- create or resolve the Veslo conversation,
- create or resolve the bound OpenCode session,
- persist the mapping from Veslo conversation to OpenCode session,
- create a run record before submitting work to OpenCode,
- reject conversation ids that belong to another workspace,
- reject directories outside the authorized workspace roots,
- strip client-supplied OpenCode routing fields from mutation bodies.

The server route shape should remain workspace-scoped:

- `POST /workspace/:id/conversations`
- `GET /workspace/:id/conversations`
- `GET /workspace/:id/sessions/:sessionOrConversationId/transcript`
- `POST /workspace/:id/conversations/:conversationId/runs`
- `POST /workspace/:id/conversations/:conversationId/abort`
- `GET /workspace/:id/conversations/:conversationId/runs/latest`

Server-controlled writes must remain expressible through Veslo server APIs.
Avoid adding Tauri-only filesystem mutations for behavior that changes
`.opencode/` state.

### Orchestrator

The orchestrator owns execution strategy and process routing.

It must support two execution modes behind one runtime boundary:

- shared OpenCode process without sandbox,
- workspace-scoped sandboxed engine process.

The run/conversation model must not depend on sandbox availability. Sandbox is
an isolation strategy, not the only mechanism for parallel workspace execution.

### Desktop Shell

The desktop shell owns the local Veslo server process lifecycle.

The local Veslo server must be able to reach a ready state without an active
workspace. Starting, recovering, or refreshing the local server must not be a
side effect of switching the visible workspace.

Fresh desktop profiles have no configured workspace yet. The desktop shell must
therefore allow a managed `veslo-server` restart with an empty workspace list,
using the app data directory as a stable process cwd until the first workspace is
created. Private chat workspace creation must also create the app-owned private
workspace root before validating or registering the nested scratch directory, so
the first `Chat` click cannot dead-end on a missing parent directory.

`Invalid bearer token` between the app and the local Veslo server is a local
connection-state failure. It is not a message failure or a conversation failure.
The app and desktop shell should recover the current server URL and client token
before retrying operations that have not yet created irreversible work.

## Runtime Modes

### Configured vs Effective Sandbox

`/capabilities.sandbox` is the configured local server capability. It must not
be treated as proof that the currently running engine is actually sandboxed.

The effective runtime state comes from the engine child kind:

- `childKind=wsl` means the engine is running through the Windows WSL2 sandbox
  and WSL path aliasing can be used.
- `childKind=direct` means the engine is running directly on the host, even when
  the configured backend is `windows-wsl2`.
- missing `childKind` is unknown/configured state, not proof of a WSL runtime.

The app resolves this through
`packages/app/src/app/lib/runtime-sandbox-state.ts`. Prompt preflight, managed AI
routing, directory query path mode, debug traces, and Settings devtools should
use that effective state. Settings devtools also show both configured and
effective values, including `sandboxFallback`, so a Windows machine without a
ready WSL sandbox is auditable as `configured=windows-wsl2` and
`effective=none`.

### Without Sandbox

Use this mode when sandboxing is unavailable or disabled.

Expected behavior:

- one shared OpenCode process may serve multiple workspaces,
- every Veslo conversation has its own OpenCode session created in the correct
  workspace directory,
- simultaneous conversations in different workspace directories may run at the
  same time,
- there is no filesystem isolation guarantee beyond normal host permissions.

Correctness in this mode means correct routing and concurrency. It does not
mean security isolation.

When Windows WSL2 sandbox launch fails because WSL, the managed `VesloSandbox`
distro, bubblewrap, or workspace mountability is unavailable, Veslo falls back
to a direct host engine. That fallback remains per-workspace by default. It does
not enable the shared unsandboxed engine unless both `VESLO_DISABLE_SANDBOX=1`
and `VESLO_SHARED_OPENCODE_ENGINE=1` are explicitly configured.

### With Sandbox

Use this mode when workspace isolation is enabled.

Expected behavior:

- the sandbox implementation from `origin/local/sandbox-merge` is the reference
  direction,
- the orchestrator may start workspace-scoped engine processes,
- sandboxed execution still uses the same Veslo conversation and run boundary,
- switching the visible workspace never retargets a running conversation.

Do not build a separate conversation model only for sandboxed execution.

## First Message Flow

1. The user writes a message in a new or existing conversation.
2. The app records the prepared message locally.
3. The app sends a Veslo intent to the workspace-scoped server API.
4. Veslo server validates the workspace and directory.
5. Veslo server creates the conversation when needed.
6. Veslo server creates or resolves the bound OpenCode session.
7. Veslo server creates the run record.
8. The orchestrator resolves the execution target.
9. OpenCode receives the prompt for the bound session and directory.
10. Events and transcript data are mirrored back to the conversation and run.

If any step fails, store the failure at the narrowest correct level:

- local server connection failure,
- workspace attach failure,
- conversation creation failure,
- OpenCode session creation failure,
- run submission failure,
- model/provider failure.

Avoid generic "send failed" state when the failing layer is known.

## Workspace Switching

Workspace switching changes only what the user is looking at.

It must not:

- change the OpenCode session of an existing conversation,
- change the directory of an existing conversation,
- abort or restart a run in another workspace,
- move a global busy/error state into the newly selected workspace.

The selected workspace is display context. The run's workspace and directory are
part of the persisted conversation/run state.

## Error Handling Rules

- Local server unavailable: surface local runtime readiness and retry recovery.
- Invalid bearer token: refresh local server connection state, then retry only
  operations that have not created irreversible work.
- Workspace unavailable: keep the prepared message and show workspace attach
  progress or failure.
- OpenCode session creation failure: mark the conversation/run as failed for
  that workspace.
- Submit failure after run creation: mark the run failed; do not blindly create
  another run.
- Active run conflict: reject or surface the active run id; do not submit a
  second active run to the same conversation.

## Validation Requirements

Changes to this architecture require real desktop validation when they affect
user-visible runtime behavior.

Minimum coverage for implementation work:

- server tests for conversation binding, directory validation, body stripping,
  and cross-workspace rejection,
- orchestrator tests for shared-process and sandbox execution selection,
- app tests proving prompt send goes through Veslo conversation APIs,
- desktop or Tauri-pilot coverage for local server startup and recovery,
- Tauri-pilot scenario for two concurrent workspace directories without
  sandbox,
- Tauri-pilot scenario for sandboxed execution when the sandbox feature is part
  of the change.

If `packages/server/src` changes, rebuild the server binary with:

```bash
pnpm --filter veslo-server build:bin
```

If desktop behavior depends on the server change, refresh sidecars and validate
against the rebuilt binary.
