# Session Artifact Provenance Design

**Date:** 2026-03-28  
**Status:** Approved  
**Branch:** main

## Goal

Replace the current heuristic session artifact sidebar with an explicit, run-scoped artifact provenance system that only shows user-relevant outputs and capabilities actually used during the run.

## Scope

- Session artifact derivation and rendering in:
  - `packages/app/src/app/utils/tools.ts`
  - `packages/app/src/app/components/session/artifacts-panel.tsx`
  - `packages/app/src/app/pages/session.tsx`
  - `packages/app/src/app/app.tsx`
- Session event handling and artifact state in:
  - `packages/app/src/app/context/session.ts`
  - `packages/app/src/app/context/global-sdk.tsx`
- Veslo server artifact provenance model and APIs in:
  - `packages/server/src/server.ts`
  - `packages/server/src/types.ts`
- Run-scoped artifact families for files, skills, MCP, and Soul.

Out of scope:

- Changes to the existing sidebar `Skills` section beyond keeping it separate from artifacts.
- Redesign of the dashboard `Skills`, `MCP`, or `Soul` pages.
- Replacing the existing workspace outbox download API.
- Retroactively reconstructing perfect provenance for all historical sessions.

## Current Problem

Today the session sidebar artifact list is derived by scanning tool state and free-form tool output for path-like strings in `deriveArtifacts()` (`packages/app/src/app/utils/tools.ts`). This produces a noisy file list instead of a meaningful explanation of what the run actually used.

Observed failures:

- Technical files such as `SKILL.md`, internal markdown docs, prompts, and config files appear as artifacts just because they were mentioned or read.
- Used skills are represented as raw markdown files instead of `this skill was used`.
- MCP usage is invisible unless it happened to create a file-like trail.
- Soul and heartbeat activity are represented as file paths instead of a meaningful product concept.
- The panel is effectively session-history-biased instead of run-scoped.

## Validated Product Decisions

1. The long-term approach is explicit provenance on the Veslo server, not a client-only file-path filter.
2. Artifacts must be scoped to the specific run, not to all session history.
3. `MCP` artifacts appear only when a specific server was actually used in the run.
4. `Files` may include both real outputs and files that were genuinely scanned/read during the run.
5. `Soul` and `Heartbeat` should be unified in the UI as one artifact family.
6. `Soul` and `Heartbeat` should remain distinct in the internal data model because they represent different evidence.
7. The existing sidebar `Skills` section remains independent from the artifact system.

## Recommended Approach (Approved)

Introduce a server-owned `RunArtifact` provenance model and make the session sidebar render artifact families derived from that model instead of regex-matched file paths.

Artifact provenance should be assembled from actual runtime events and known capability signals, then reduced into a stable set of user-facing artifact families:

- `Files`
- `Skills`
- `MCP`
- `Soul`

The current client heuristic remains only as a migration fallback for older runs that do not have provenance data yet.

## Definitions

### Run

A `run` is one prompt execution inside an existing session. Artifact visibility is always scoped to the run, not to the entire session.

### Provenance event

A normalized internal event describing that the run used or produced something relevant, for example:

- `file.scanned`
- `file.updated`
- `skill.used`
- `mcp.used`
- `soul.memory.used`
- `soul.heartbeat.used`

### Run artifact

A user-facing record derived from one or more provenance events.

### Artifact family

A top-level visual grouping in the sidebar. Families are product-facing and intentionally broader than internal event types.

## Artifact Families

### Files

Show workspace-relevant files the run truly interacted with.

Item states:

- `Scanned`
- `Updated`
- `Created`
- `Exported`

Rules:

- Read/search/list/glob activity may generate `Scanned` file artifacts.
- Write/edit/apply-patch/export activity may generate `Updated`, `Created`, or `Exported`.
- Internal prompt assets, skill markdown sources, and unrelated technical files must not surface here unless they are themselves the user-relevant target of the run.

### Skills

Show skills that were actually loaded and used during the run.

Rules:

- Render the skill identity, not `SKILL.md`.
- Installed-but-unused skills never appear.

### MCP

Show MCP servers that were actually used during the run.

Rules:

- Configured or connected MCP servers do not appear unless a tool call in the run actually used them.
- The artifact should identify the MCP server or app, not the raw low-level tool string.

### Soul

Show Soul activity as one family that can summarize both persistent memory use and heartbeat evidence.

Rules:

- UI presents one `Soul` family.
- Internal provenance keeps `soul.memory.used` and `soul.heartbeat.used` separate.
- The family detail can summarize states such as `Memory used`, `Heartbeat ran`, `Heartbeat updated`, `Healthy`, or `Stale`.

## Canonical Source Of Truth

The canonical source of truth for run artifacts moves to the Veslo server.

Reasons:

- `packages/server` already proxies OpenCode and owns Veslo-native APIs.
- Server-owned provenance works for local, host, and remote modes with one contract.
- It removes duplicate logic and divergent behavior between client surfaces.
- It gives Veslo a documented system contract instead of a UI-only heuristic.

The app should stop treating `deriveArtifacts()` as the primary truth source. The sidebar should render server-provided run artifacts and use client heuristics only when provenance is unavailable for historical runs.

## Proposed Data Model

Suggested internal server model:

```ts
type RunArtifactFamily = "files" | "skills" | "mcp" | "soul";

type RunArtifactKind =
  | "file_output"
  | "file_discovered"
  | "skill_used"
  | "mcp_used"
  | "soul_memory_used"
  | "heartbeat_used";

type RunArtifactStatus =
  | "scanned"
  | "updated"
  | "created"
  | "exported"
  | "used"
  | "active";

type RunArtifact = {
  id: string;
  runId: string;
  sessionId: string;
  workspaceId: string;
  family: RunArtifactFamily;
  kind: RunArtifactKind;
  status: RunArtifactStatus;
  title: string;
  subtitle?: string;
  path?: string;
  sourceName?: string;
  messageId?: string;
  partId?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
};
```

Suggested UI aggregation model:

```ts
type RunArtifactFamilyView = {
  family: "files" | "skills" | "mcp" | "soul";
  title: string;
  summary?: string;
  items: RunArtifact[];
};
```

## Provenance Derivation Rules

### Files

- Mutating file tools produce `file_output` artifacts.
- Read/search/list/glob tools may produce `file_discovered` artifacts.
- Only workspace-relevant paths qualify.
- If a file also maps to a stronger semantic artifact, the semantic artifact wins.

Examples:

- `.opencode/soul.md` should not render as a plain markdown file when it is acting as Soul memory.
- `SKILL.md` should not render as a generic file artifact when it represents skill usage.

### Skills

- Explicit skill tool usage should produce `skill_used`.
- The artifact title is the skill name.

### MCP

- MCP artifact derivation must map the actual used tool to the owning MCP server.
- Server resolution should prefer explicit metadata when available and only fall back to well-defined tool-to-server mapping.

### Soul

- Any use of Soul memory produces `soul_memory_used`.
- Any heartbeat execution or proof update produces `heartbeat_used`.
- The sidebar reduces both to the single `Soul` family.

## UI Contract

The artifact sidebar becomes a renderer of artifact families, not a renderer of file paths.

Display rules:

- Show only families that had activity in the current run.
- Families are ordered by actual run activity, with file outputs ahead of scanned-only file entries.
- A family with one item may render inline without extra expansion.
- A family with multiple items should support compact expansion.

Visual language:

- `Files`: file/search icon with badges such as `Scanned`, `Updated`, `Created`
- `Skills`: package or sparkle icon
- `MCP`: plug icon or known service icon
- `Soul`: heart/activity icon with summary badges derived from memory + heartbeat evidence

Actions:

- File-backed artifacts may expose `Reveal` and `Open`.
- Non-file capability artifacts should default to informative metadata rather than faux file actions.

## API Direction

The final system should expose server APIs for run-scoped artifacts, for example:

- `GET /workspace/:id/sessions/:sessionId/runs/:runId/artifacts`
- optional live updates for in-progress runs

Because the current app still sends prompts directly through the OpenCode client in `packages/app/src/app/app.tsx`, migration should happen in two phases.

## Migration Plan

### Phase 1: Server-side reduction without full run routing

- Add a server reducer that computes artifacts from known session/runtime evidence on demand.
- Use server-owned rules even if the app still starts prompts directly.
- Keep client `deriveArtifacts()` only as a fallback for older sessions without provenance.

### Phase 2: Explicit server-owned run boundaries

- Route prompt execution through Veslo server surfaces so the server assigns stable `runId`s.
- Persist and stream run-scoped artifact provenance as the run progresses.
- Remove client regex-based path extraction as the primary artifact source.

## Testing Strategy

### Server tests

- Unit tests for provenance classification:
  - file scanned
  - file updated
  - skill used
  - MCP used
  - Soul memory used
  - heartbeat used
- Negative tests proving internal markdown or prompt assets do not appear as file artifacts.

### Integration tests

Run scenarios that verify the reduced artifact families:

1. Use a skill and confirm `Skills` shows the skill name, not `SKILL.md`.
2. Use Chrome MCP and confirm `MCP` shows the Chrome server.
3. Search/read a source file without editing and confirm it appears under `Files` as `Scanned`.
4. Edit or create a file and confirm it appears under `Files` as `Updated` or `Created`.
5. Use Soul memory and heartbeat and confirm the sidebar shows one `Soul` family rather than duplicate rows.

### App tests

- Sidebar renders families rather than a flat file list.
- `Soul` family aggregates heartbeat and memory evidence correctly.
- File badges distinguish `Scanned` from `Updated`.
- Historical fallback still works when no server provenance exists.

## Documentation Requirements

This change is a system contract change, not just a UI cleanup. It must be documented as:

- a product/architecture design in `docs/plans/`
- an implementation plan describing migration tasks
- follow-up developer documentation if the server becomes the required source for session artifact truth

## Acceptance Criteria

- Session artifacts are run-scoped.
- The sidebar no longer shows random technical markdown files as artifacts.
- Used skills appear as skills, not as `SKILL.md`.
- Used MCP servers appear only when actually invoked in the run.
- Soul and heartbeat appear as one `Soul` family in the UI.
- File artifacts can represent both true outputs and genuinely scanned workspace files.
- The Veslo server is the canonical artifact provenance authority for new runs.
