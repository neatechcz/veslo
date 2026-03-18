# Veslo Architecture

## Design principle: Predictable > Clever

Veslo optimizes for **predictability** over "clever" auto-detection. Users should be able to form a correct mental model of what will happen.

Guidelines:

- Prefer **explicit configuration** (a single setting or env var) over heuristics.
- Auto-detection is acceptable as a convenience, but must be:
  - explainable (we can tell the user what we tried)
  - overrideable (one obvious escape hatch)
  - safe (no surprising side effects)
- When a prerequisite is missing, surface the **exact failing check** and a concrete next step.

### Example: Docker-backed sandboxes (desktop)

When enabling Docker-backed sandbox mode, prefer an explicit, single-path override for the Docker client binary:

- `OPENWORK_DOCKER_BIN` (absolute path to `docker`)

This keeps behavior predictable across environments where GUI apps do not inherit shell PATH (common on macOS).

Auto-detection can exist as a convenience, but should be tiered and explainable:

1. Honor `OPENWORK_DOCKER_BIN` if set.
2. Try the process PATH.
3. On macOS, try the login PATH from `/usr/libexec/path_helper`.
4. Last-resort: try well-known locations (Homebrew, Docker Desktop bundle) and validate the binary exists.

The readiness check should be a clear, single command (e.g. `docker info`) and the UI should show the exact error output when it fails.

## opencode primitives
how to pick the right extension abstraction for 
@opencode

opencode has a lot of extensibility options:
mcp / plugins / skills / bash / agents / commands

- mcp
use when you need authenticated third-party flows (oauth) and want to expose that safely to end users
good fit when "auth + capability surface" is the product boundary
downside: you're limited to whatever surface area the server exposes

- bash / raw cli
use only for the most advanced users or internal power workflows
highest risk, easiest to get out of hand (context creep + permission creep + footguns)
great for power users and prototyping, terrifying as a default for non-tech users

- plugins
use when you need real tools in code and want to scope permissions around them
good middle ground: safer than raw cli, more flexible than mcp, reusable and testable
basically "guardrails + capability packaging"

- skills
use when you want reliable plain-english patterns that shape behavior
best for repeatability and making workflows legible
pro tip: pair skills with plugins or cli (i literally embed skills inside plugins right now and expose commands like get_skills / retrieve)

- agents
use when you need to create tasks that are executed by different models than the main one and might have some extra context to find skills or interact with mcps.

- commands 
`/` commands that trigger tools

These are all opencode primitives you can read the docs to find out exactly how to set them up.

## Core Concepts of Veslo

- uses all these primitives
- uses native OpenCode commands for reusable flows (markdown files in `.opencode/commands`)
- adds a new abstraction "workspace" is a project fodler and a simple .json file that includes a list of opencode primitives that map perfectly to an opencode workdir (not fully implemented)
  - Veslo can open a workspace.json and decide where to populate a folder with these settings (not implemented today)

## Core Architecture

Veslo is a local-first client experience that consumes Veslo/OpenCode server surfaces.

The current product architecture has three distinct layers:

### Layer 1 - Local execution (default)

- Veslo runs on a desktop/laptop and **starts** OpenCode locally.
- The OpenCode server runs on loopback (default `127.0.0.1:4096`).
- Veslo UI connects via the official SDK and listens to events.
- Every session runs against a real workspace directory.
- `New session` creates a new Veslo-managed private workspace directory.
- `Open project/folder` binds a user-selected local folder and starts a new session there.

### Layer 2 - Cloud-backed identity and sync

- Veslo Cloud stores account, organization, chat/session history, and sync metadata.
- Cloud does not mean remote execution in the current end-user UX.
- If a session is backed by a workspace that exists only on one device, other devices can show that session as history but must mark it view-only and unavailable to continue.

### Layer 3 - Remote execution capability (not in current default UI)

- Veslo can still connect to trusted remote OpenCode/Veslo runtimes.
- Hosted cloud runtimes remain a platform capability.
- These capabilities stay in the codebase, but they are not the default BFU flow in the current product UI.

### Messaging connectors (runtime capability, UI-disabled)

- OpenCode Router messaging integration (Telegram/Slack/WhatsApp) remains implemented in runtime/server layers.
- Current product UI intentionally hides messaging setup and identity management.
- Product investment is focused on delivering a native mobile app instead of messaging-surface UX.

## Cross-device Continuation

- Session history can sync to cloud independently of workspace files.
- Continuing a session requires access to its backing workspace directory.
- If the workspace exists only on one device, the session is view-only elsewhere.
- In the future, an explicit "move workspace to cloud" flow can make that workspace continuable on other devices.

## Platform Capability: Hosted Cloud Workspaces

Hosted cloud workspaces remain part of the platform architecture, but they are not the default UI flow today.

Canonical capability flow:

1. Authenticate in Veslo Cloud control surface.
2. Launch or attach a cloud workspace/runtime.
3. Wait for provisioning and health.
4. Generate/retrieve connect credentials.
5. Attach from Veslo through an explicit future cloud flow.

Technical note:

- Default connect URL should be workspace-scoped (`/w/ws_*`) when available.
- Technical diagnostics (host URL, worker ID, raw logs) should be progressive disclosure, not default UI.

## Web Parity + Filesystem Actions

The browser runtime cannot read or write arbitrary local files. Any feature that:

- reads skills/commands/plugins from `.opencode/`
- edits `SKILL.md` / command templates / `opencode.json`
- opens folders / reveals paths

must be routed through a host-side service.

In Veslo, the long-term direction is:

- Use the Veslo server (`packages/server`) as the single API surface for filesystem-backed operations.
- Treat Tauri-only file operations as an implementation detail / convenience fallback, not a separate feature set.

This ensures the same UI flows work on desktop, mobile, and web clients, with approvals and auditing handled centrally.

## OpenCode Integration (Exact SDK + APIs)

Veslo uses the official JavaScript/TypeScript SDK:

- Package: `@opencode-ai/sdk/v2` (UI should import `@opencode-ai/sdk/v2/client` to avoid Node-only server code)
- Purpose: type-safe client generated from OpenAPI spec

### Engine Lifecycle

#### Start server + client (Host mode)

Use `createOpencode()` to launch the OpenCode server and create a client.

```ts
import { createOpencode } from "@opencode-ai/sdk/v2";

const opencode = await createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  timeout: 5000,
  config: {
    model: "anthropic/claude-3-5-sonnet-20241022",
  },
});

const { client } = opencode;
// opencode.server.url is available
```

#### Connect to an existing server (Client mode)

```ts
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
  directory: "/path/to/project",
});
```

### Health + Version

- `client.global.health()`
  - Used for startup checks, compatibility warnings, and diagnostics.

### Event Streaming (Real-time UI)

Veslo must be real-time. It subscribes to SSE events:

- `client.event.subscribe()`

The UI uses these events to drive:

- streaming assistant responses
- step-level tool execution timeline
- permission prompts
- session lifecycle changes

### Sessions (Primary Primitive)

Veslo maps a "Task Run" to an OpenCode **Session**.

Core methods:

- `client.session.create()`
- `client.session.list()`
- `client.session.get()`
- `client.session.messages()`
- `client.session.prompt()`
- `client.session.abort()`
- `client.session.summarize()`

### Files + Search

Veslo's file browser and "what changed" UI are powered by:

- `client.find.text()`
- `client.find.files()`
- `client.find.symbols()`
- `client.file.read()`
- `client.file.status()`

### Permissions

Veslo must surface permission requests clearly and respond explicitly.

- Permission response API:
  - `client.permission.reply({ requestID, reply })` (where `reply` is `once` | `always` | `reject`)

Veslo UI should:

1. Show what is being requested (scope + reason).
2. Provide choices (allow once / allow for session / deny).
3. Post the response to the server.
4. Record the decision in the run's audit log.

### Config + Providers

Veslo's settings pages use:

- `client.config.get()`
- `client.config.providers()`
- `client.auth.set()` (optional flow to store keys)

### Extensibility - Skills + Plugins

Veslo exposes two extension surfaces:

1. **Skills (OpenPackage)**
   - Installed into `.opencode/skills/*`.
   - Veslo can run `opkg install` to pull packages from the registry or GitHub.

2. **Plugins (OpenCode)**
   - Plugins are configured via `opencode.json` in the workspace.
   - The format is the same as OpenCode CLI uses today.
   - Veslo should show plugin status and instructions; a native plugin manager is planned.

### Internal Delegation via `delegate` Tool

Veslo provisions specialized hidden subagents for document work (docx, pdf, pptx,
xlsx) and skill creation. These subagents are invoked through the `delegate` plugin
tool — a native `tool_use` call, not a prompt-based routing decision.

#### How it works

1. The Veslo internal system (`packages/server/src/internal-system.ts`) provisions
   a plugin file (`.opencode/plugins/veslo-delegate.js`) into each workspace.
2. OpenCode auto-discovers plugins in `.opencode/plugins/` and registers their
   tools with the model's tool list.
3. The model sees `delegate` as a callable tool (same mechanism as `read`, `bash`,
   `grep`). When context involves documents, the model calls it via `tool_use`.
4. The plugin's `execute` function creates a child session with the target subagent
   and returns the result.

#### Available subagents

| Agent | Purpose |
|-------|---------|
| `veslo-internal-xlsx` | Spreadsheets (.xlsx, .xlsm, .csv, .tsv) |
| `veslo-internal-docx` | Word documents (.docx) |
| `veslo-internal-pdf` | PDFs (.pdf) |
| `veslo-internal-pptx` | Presentations (.pptx) |
| `veslo-internal-skill-creator` | Reusable skill authoring |

#### Why tool_use instead of prompt routing

Previously, delegation was handled by a text block in `veslo.md` that described
routing rules. The model had to interpret those rules and decide whether to
delegate. This was unreliable — the model's thinking might conclude "I should look
at the Excel file" but then produce a text answer instead of acting.

By registering delegation as a tool, the model's native tool-calling mechanism
handles it. The same mechanism that reliably fires `read` and `bash` also fires
`delegate`. The model's extended thinking drives the decision, and `tool_use`
ensures the action follows.

#### Provisioning

The delegate plugin is provisioned alongside internal agents and packs via
`provisionWorkspaceInternalSystem()`. The manifest
(`.opencode/veslo/internal/manifest.json`) tracks provisioned plugins. The plugin
file is auto-generated — do not edit manually.

### Engine reload (config refresh)

- Veslo server exposes `POST /workspace/:id/engine/reload`.
- It calls OpenCode `POST /instance/dispose` with the workspace directory to force a config re-read.
- Use after skills/plugins/MCP/config edits; reloads can interrupt active sessions.
- Reload requests follow Veslo server approval rules.

### OpenPackage Registry (Current + Future)

- Today, Veslo only supports **curated lists + manual sources**.
- Publishing to the official registry currently requires authentication (`opkg push` + `opkg configure`).
- Future goals:
  - in-app registry search
  - curated list sync (e.g. Awesome Claude Skills)
  - frictionless publishing without signup (pending registry changes)

## Projects + Path

- `client.project.list()` / `client.project.current()`
- `client.path.get()`

Veslo conceptually treats a workspace as the current project/path, but there are two important workspace classes:

- user-selected project folders
- Veslo-managed private workspaces created automatically for `New session`

Both classes are real directories. Session history may sync independently of those files, but continuing the session still depends on access to the backing directory.

## Optional TUI Control (Advanced)

The SDK exposes `client.tui.*` methods. Veslo can optionally provide a "Developer Mode" screen to:

- append/submit prompt
- open help/sessions/themes/models
- show toast

This is optional and not required for non-technical MVP.

## Folder Authorization Model

Veslo enforces folder access through **two layers**:

1. **Veslo UI authorization**
   - Veslo-managed private workspaces are implicitly authorized by the app
   - user-selected project folders are explicitly authorized via native picker
   - Veslo remembers allowed roots per profile/device

2. **OpenCode server permissions**
   - OpenCode requests permissions as needed
   - Veslo intercepts requests via events and displays them

Rules:

- Default deny for anything outside allowed roots.
- "Allow once" never expands persistent scope.
- "Allow for session" applies only to the session ID.
- "Always allow" (if offered) must be explicit and reversible.
- On another device, a session without access to its backing directory must be treated as view-only.

## Open Questions

- Best packaging strategy for Host mode engine (bundled vs user-installed Node/runtime).
- Best remote transport for mobile client (LAN only vs optional tunnel).
- Scheduling API surface (native in OpenCode server vs Veslo-managed scheduler).
