# Veslo Infrastructure Principles

Veslo is an experience layer. `opencode` is the engine. This document defines how infrastructure is built so every component is usable on its own, composable as a sidecar, easy to automate, and honest about the difference between local execution, cloud-backed sync, and optional remote capability.

## Core Principles

1.  CLI-first, always

* Every infrastructure component must be runnable via a single CLI command.
* The Veslo UI may wrap these, but never replace or lock them out.

2.  Unix-like interfaces

* Prefer simple, composable boundaries: JSON over stdout, flags, and env vars.
* Favor readable logs and predictable exit codes.

3.  Sidecar-composable

* Any component must run as a sidecar without special casing.
* The UI should connect to the same surface area the CLI exposes.

4.  Clear boundaries

* OpenCode remains the engine; Veslo adds a thin config + UX layer.
* When OpenCode exposes a stable API, use it instead of re-implementing.

5.  Local-first, graceful degradation

* Default to local execution.
* Cloud sync is first-class, but cloud does not mean remote execution by default.
* If a sidecar or workspace is missing or offline, the UI falls back to read-only or explicit user guidance.

6.  Portable configuration

* Use config files + env vars; avoid hidden state.
* Keep credentials outside git and outside the repo.

7.  Observability by default

* Provide health endpoints and structured logs.
* Record audit events for every config mutation.

8.  Security + scoping

* All filesystem access is scoped to explicit workspace roots or Veslo-managed private workspaces.
* Writes require explicit host approval when requested remotely.

9.  Honest multi-device behavior

* Session/chat history may sync independently of workspace files.
* If a backing workspace exists only on one device, other devices must show that session as history/view-only.
* Continuation on another device requires the workspace to be available there.
* Future explicit "move workspace to cloud" flows can make work continuable across devices.

10. Debuggable by agents
    Agents like (you?) make tool calls tool calls can do a variety of things form using chrome
    to calling curl, using the cli, using bun, making scripts.

You're not afraid to run the program on your OS but to benefit from it you need to design the arch
so these things are callable.

E.g. it is very hard to call a things from the desktop app (you have not a lot of control).

But what you can do is:

* run the undelrying clis (since they are implented as sidecar)
* run against real opencode value
* use bash to test endpionts of these various servers/etc
* if needed don't hestiate to ask for credentialse.g. to test telegram or other similar flow
  -you should be able to test 99% of the flow on your own

## Applied to Current Components

### opencode Engine

* Always usable via `opencode` CLI.
* Veslo never replaces the CLI; it only connects to the engine.
* All sessions run against real directories, including Veslo-managed private workspaces.

### Veslo Server

* Runs standalone via `openwork-server` CLI.
* Provides filesystem-backed config surfaces (skills, plugins, MCP, commands).
* Sidecar lifecycle is described in `packages/app/pr/openwork-server.md`.
* Serves the same filesystem-backed surfaces for local-first clients and future remote-capable clients.

### Veslo-managed Private Workspaces

* `New session` creates a persistent app-managed local workspace directory.
* These private workspaces are real execution roots, not a fake folderless mode.
* They are implicitly authorized on the device that created them.
* Their session history may sync to cloud even when their files stay local.
* On other devices, sessions backed by these workspaces are view-only until the workspace is explicitly moved to cloud in a future flow.

### Veslo Cloud Control Plane

* Hosted deployment of identity, organization, chat history, and sync capabilities.
* May also expose workspace/runtime lifecycle as a platform capability.
* Current product contract:
  - sync account, organization, and chat/session history
  - show sessions whose workspaces are unavailable locally as view-only on other devices
  - later support explicit "move workspace to cloud" flows for cross-device continuation
* Remote attach/provision flows remain supported in platform architecture, but they are not the default BFU UI path today.

### OpenCode Router

* Runs standalone via `opencode-router` CLI.
* Must be able to use Veslo server for config and approvals.
* Messaging connectors are still implemented as infrastructure capability, but are intentionally hidden from current end-user UI.
* Native mobile app delivery is prioritized over messaging-surface UX.

## Non-goals

* Replacing OpenCode primitives with custom abstractions.
* Forcing cloud-only lock-in (self-hosted desktop/CLI paths must remain valid).

## References

* `VISION.md`
* `PRINCIPLES.md`
* `ARCHITECTURE.md`
* `packages/app/pr/openwork-server.md`
