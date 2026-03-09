# Veslo Product

## Target Users

> Susan in accounting/economy... BFU! 

Susan in accounting doesn't use opencode. She certaintly doesn't paly aorund to create workflow create agents. She wants something that works.
Veslo should be given to give her a good taste of what she can do. 
We should also eventually guide ther to:

- creating her own skills
- adding custom MCP / login into mcp oauth servers through ui)
- adding skills from a list of skills
- adding plugins from a list of plugins
- create her own commands



1. **knowledge worker**: "Do this for me" workflows with guardrails.
2. **Mobile-first user**: start/monitor tasks from phone.
3. **Power user**: wants UI parity + speed + inspection.
4. **Admin/owner**: manages a shared machine + profiles.

## Success Metrics

- < 3 minutes to first successful task on fresh install.
- > 90% task success without terminal fallback.
- Permission prompts understood/accepted (low confusion + low deny-by-accident).
- UI performance: 60fps; <100ms interaction latency; no jank.

## Product Primitives (What Veslo Exposes)

Veslo must feel like "Claude code, but for everyone."

### 1) Tasks

- A Task = a user-described outcome.
- A Run = an OpenCode session + event stream.

### 2) Plans / Todo Lists

Veslo provides a first-class plan UI:

- Plan is generated before execution (editable).
- Plan is updated during execution (step status + timestamps).
- Plan is stored as a structured artifact attached to the session (JSON) so it's reconstructable.

Implementation detail:

- The plan is represented in OpenCode as structured `parts` (or a dedicated "plan message") and mirrored in Veslo.

### 3) Steps

- Each tool call becomes a step row with:
  - tool name
  - arguments summary
  - permission state
  - start/end time
  - output preview

### 4) Artifacts

Artifacts are user-visible outputs:

- files created/modified
- generated documents/spreadsheets/presentations
- exported logs and summaries

Veslo lists artifacts per run and supports open/share/download.

### 5) Audit Log

Every run provides an exportable audit log:

- prompts
- plan
- tool calls
- permission decisions
- outputs

## UI/UX Requirements (Slick as a Core Goal)

### Design Targets

- premium, calm, high-contrast
- subtle motion, springy transitions
- zero "developer vibes" in default mode

### Performance Targets

- 60fps animations
- <100ms input-to-feedback
- no blocking spinners (always show progress state!)

### Mobile-first Interaction

- Mobile app flows are implemented, but mobile is not currently a supported product surface.
- bottom navigation
- swipe gestures (dismiss, approve, cancel)
- haptics for major events
- adaptive layouts (phone/tablet)

### Accessibility

- WCAG 2.1 AA
- reduced motion mode
- screen-reader labels for steps + permissions

## Design Reference

use the design from ./design.ts that is your core reference for building the entire ui

## Functional Requirements

### Onboarding

- User signs in or signs up with email/SSO.
- If the user has an existing organization or invite, prompt them to join it.
- Otherwise, create a new organization for them as the default fallback.
- User starts their first session immediately in a Veslo-managed private workspace, or chooses `Open project/folder` to work in an existing local folder.
- Execution runs locally. Account, organization, and chat state sync to the cloud.

#### Desktop auth handoff

When signing in from the desktop app, authentication is delegated to the browser:

1. The desktop app opens the web app with `?desktopOnboarding=1`.
2. The user authenticates in the browser and selects an organization.
3. The web app calls Den to create a one-time handoff code and redirects to `veslo://auth-complete?code=...`.
4. The desktop app receives the deep link, exchanges the code for a bearer token and user/org info, and completes sign-in locally.

### Cross-device Continuation

- Veslo syncs account state, organization state, and chat/session history across signed-in devices.
- If a session is backed by a local private workspace or a local project folder that exists only on one device, other devices can open that session as history but must mark it view-only and unavailable to continue.
- In the future, once a workspace is explicitly moved to cloud, it can become continuable on other devices.

### Task Execution

- create task
- plan preview and edit
- run with streaming updates
- pause/resume/cancel
- show artifacts and summaries

### Permissions

- clear prompts with "why"
- allow once/session
- audit of decisions

### Commands

- save a task as a command
- arguments + quick run

### Scheduling (Future)

- schedule command runs
- notify on completion

## User Flow Map (Exhaustive)

### 0. Install & Launch

1. User installs Veslo.
2. App launches.
3. User signs in or signs up.
4. User joins an existing organization when available; otherwise Veslo creates a new one.
5. User clicks `New session` to start in a Veslo-managed private workspace, or `Open project/folder` to choose an existing local folder.
6. Veslo starts local execution and syncs account/chat state to the cloud.

### 1. Cross-device Continuity

1. Veslo syncs account state and chat/session history to other signed-in devices.
2. If the backing workspace exists only on the original device, Veslo shows the session as view-only on other devices.
3. Veslo marks that session unavailable to continue until the workspace is explicitly moved to cloud in a later product flow.

### 3. Runtime Health & Recovery

1. UI pings `global.health()`.
2. If unhealthy:
   - attempt restart via `createOpencode()`
   - show reconnect guidance + diagnostics

### 4. Quick Task Flow

1. User types goal.
2. Veslo generates plan (structured).
3. User approves.
4. Create session: `session.create()`.
5. Send prompt: `session.prompt()`.
6. Subscribe to events: `event.subscribe()`.
7. Render streaming output + steps.
8. Show artifacts.

### 5. Guided Task Flow

1. Wizard collects goal, constraints, outputs.
2. Plan preview with "risky step" highlights.
3. Run execution with progress UI.

### 6. File-Driven Task Flow

1. User attaches files.
2. Veslo injects context into session.
3. Execute prompt.

### 7. Permissions Flow (Any)

1. Event indicates permission request.
2. UI modal shows request.
3. User chooses allow/deny.
4. UI calls `client.permission.reply({ requestID, reply })`.
5. Run continues or fails gracefully.

### 8. Cancel / Abort

1. User clicks "Stop".
2. UI calls `client.session.abort({ sessionID })`.
3. UI marks run stopped.

### 9. Summarize

1. User taps "Summarize".
2. UI calls `client.session.summarize({ sessionID })`.
3. Summary displayed as an artifact.

### 10. Run History

1. UI calls `session.list()`.
2. Tap a session to load `session.messages()`.
3. UI reconstructs plan and steps.

### 11. File Explorer + Search

1. User searches: `find.text()`.
2. Open file: `file.read()`.
3. Show changed files: `file.status()`.

### 12. Commands

1. Save a plan + prompt as a command.
2. Re-run command creates a new session.
