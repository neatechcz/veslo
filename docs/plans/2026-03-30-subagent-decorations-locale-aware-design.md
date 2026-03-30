# Locale-Aware Subagent Decorations In Sidebar Design

**Date:** 2026-03-30  
**Status:** Approved

## Summary

Extend sidebar subagent handling so child sessions remain nested under parent sessions, and add persistent UI decorations for subagents:

- dynamic role/topic detection (AI-first with deterministic fallback),
- localized first names tied to app language,
- per-parent unique colors,
- duplicate same-role names rendered with suffixes (`#2`, `#3`, ...),
- persistent decorations across restarts.

Scope applies to both left sidebar modes:

- `Recent`
- `By project`

## Goals

- Keep sub-sessions visible under parent sessions (including completed ones).
- Preserve existing primary click behavior (open session).
- Add active-parent click behavior (expand/collapse children).
- Show full session label on hover in left menu.
- Assign decorative subagent label + color persistently in Veslo UI.
- Keep naming language-aware and aligned with app locale.

## Non-goals

- Persist custom decoration metadata into OpenCode session objects.
- Require server/API schema changes for decoration fields.
- Redesign global sidebar visuals beyond subagent row label/color decoration.

## Interaction Rules

1. Clicking a non-selected session row opens that session.
2. Clicking the already-selected parent session row toggles expand/collapse of its child rows.
3. Sub-sessions are shown only under parent hierarchy (with orphan fallback visibility if parent is missing in current loaded slice).
4. Hover over session label shows full label/title.

## Naming + Color Rules

### Locale-aware first names (explicit requirement)

- If app language is `cs`, generated/displayed first names are Czech.
- If app language is `en`, generated/displayed first names are English.
- Name mapping is stable by `(roleKey, locale)`.
- Changing app language switches display to the name for that locale; if missing, resolve it on demand (AI-first, fallback deterministic).

### Stable role behavior across sessions

- Same semantic role (e.g., excel processing) should map to the same base first name for the same locale across sessions.

### Duplicate role instances in same parent session

- Same role in one parent uses same base name with suffix:
  - `Jan`
  - `Jan #2`
  - `Jan #3`
- Colors for those duplicates must be different within the parent session.

### Colors

- Decorative only (Veslo UI presentation).
- Persistent across restart.
- Unique within one parent session.

## Architecture Decision

Use **AI-first role profiling with deterministic fallback** and UI persistence in local storage.

Why:

- Satisfies AI requirement while keeping reliability.
- Avoids dependency on unsupported OpenCode session metadata writes.
- Preserves fast UI behavior via fallback.

## Data Model

Persist per workspace in `localStorage` (versioned key):

- `roleRegistry`:
  - `roleKey -> {`
    - `displayByLocale: Record<string, string>`,
    - `firstNameByLocale: Record<string, string>`
  - `}`
- `sessionDecorations`:
  - `sessionId -> {`
    - `parentSessionId: string`,
    - `roleKey: string`,
    - `baseFirstName: string`,
    - `colorToken: string`,
    - `indexInParentRole: number`
  - `}`

Suggested key pattern:

- `veslo.subagent-decorations.v1.<workspaceId>`

## Flow

1. Detect new subagent child session via task tool metadata/session relationships.
2. If no decoration exists for `sessionId`:
   - resolve role profile:
     - AI-first classification prompt (short timeout, locale-aware),
     - deterministic fallback on timeout/error.
   - resolve stable base first name from `(roleKey, locale)` registry (create if absent).
   - assign unique color for this parent session.
   - assign duplicate index suffix counter for `(parentSessionId, roleKey)`.
   - persist decoration.
3. Render decorated label in sidebar row for child sessions.

## UI Rendering

Files in scope:

- `packages/app/src/app/components/session/workspace-session-list.tsx`
- `packages/app/src/app/components/session/workspace-session-list-model.ts`
- `packages/app/src/app/app.tsx`
- supporting lib/prefs modules (new)

Rendering behavior for child rows:

- label text: localized decorated first name + optional suffix.
- color style: derived from persisted `colorToken`.
- hover title: include full decorated label and underlying session title context.

Parent rows remain unchanged stylistically (except expand/collapse interaction).

## Persistence Strategy

- Persist in `localStorage` per active workspace ID.
- Read on workspace switch.
- Write on decoration changes.
- Versioned schema with tolerant parser and safe fallback to empty state.

## Error Handling

- AI call timeout/failure => deterministic fallback role and name.
- Invalid local storage payload => reset to safe empty registry.
- Missing parent row (pagination/limit) => child remains visible as fallback.

## Testing Strategy

### Unit tests

- New prefs/parser tests for subagent decorations persistence.
- Role resolution tests:
  - AI result acceptance,
  - fallback path on timeout/error,
  - locale-specific naming behavior (`cs`, `en`).
- Duplicate labeling tests:
  - same-role duplicates use same base name + suffix.
- Color allocation tests:
  - uniqueness within parent session.

### Sidebar model/render tests

- Child rows stay nested and visible rules hold in both modes.
- Active-parent click toggles expand/collapse.
- Non-selected click still opens session.
- Decorated label + color markup appears for child rows.
- Hover title wiring remains present.

## Acceptance Criteria

- Sub-sessions appear nested under parent in `Recent` and `By project`.
- Completed sub-sessions remain visible under parent hierarchy.
- Active parent click toggles child visibility.
- Child rows display localized first-name labels:
  - Czech app language => Czech names.
  - English app language => English names.
- Same role keeps stable base first name per locale across sessions.
- Duplicate same-role child sessions in one parent show same name with suffixes.
- Duplicate same-role child sessions in one parent have different colors.
- Decorations persist after app restart.
