# Prompt-Grouped Hybrid Timeline Design

**Date:** 2026-04-01  
**Status:** Approved  
**Branch:** main

## Goal

Redesign session timeline grouping so all agent operations generated for a single user prompt are shown as one collapsible group, with independent collapsible subgroups by operation type.

## Problem

Current behavior splits operations across multiple adjacent timeline blocks when assistant output is fragmented across multiple messages. This makes one logical run appear as multiple blocks and prevents users from collapsing the full run at once.

## Product Decisions

1. Outer grouping is defined strictly by user prompt boundaries.
2. Exactly one outer timeline group is rendered for each user prompt.
3. Inner subgroups are defined by operation type transitions.
4. `issues` are status/events inside the current subgroup, not a subgroup boundary.
5. The full outer group must be collapsible independently from inner subgroup toggles.
6. Inner subgroups must remain independently collapsible.
7. Context compaction operations must appear as explicit subgroup type (`compaction`).
8. Design must be extensible for new operation types (for example MCP activity).

## Information Architecture

### Outer Group: `PromptGroup`

- Unit: all assistant/runtime events associated with one user prompt.
- Header:
  - human summary of the full run
  - latest meaningful action
  - running indicator when active
- Interaction:
  - one toggle for collapse/expand of complete run content

### Inner Groups: `Subgroup`

- Unit: contiguous rows of the same operation type within one `PromptGroup`.
- Suggested subgroup label kinds:
  - `thinking`
  - `subagent`
  - `action`
  - `mcp`
  - `compaction`
  - `other` (fallback)
- Interaction:
  - each subgroup has independent collapse state
  - multiple subgroups can remain open

## Grouping Rules

### Rule 1: Prompt boundary

A new `PromptGroup` starts only on a new user message.

### Rule 2: Type boundary

Within one `PromptGroup`, a new subgroup starts only when operation type changes.

Example:

- `thinking -> action -> thinking -> subagent -> action`
- Results in one outer group with five subgroups.

### Rule 3: Issues behavior

`issues` do not force subgroup split. They remain rows/status in the currently active subgroup.

### Rule 4: Compaction behavior

Context compaction operations are classified as subgroup type `compaction` and must remain visible in timeline.

## Data Flow

1. Read message/part stream in timeline order.
2. Enrich each part with:
   - prompt ownership (nearest preceding user prompt)
   - subgroup kind classification
   - row status metadata
3. Build `PromptGroup[]` by prompt ownership.
4. For each `PromptGroup`, build contiguous `Subgroup[]` by subgroup kind transitions.
5. Render UI from this view model only.

## Rendering Contract

- `PromptGroup` collapse hides all subgroup content.
- Expanding `PromptGroup` restores subgroup headers and rows.
- Subgroup headers show label, summary, and status chip.
- Row rendering remains the same hierarchy:
  - icon
  - primary line
  - secondary line
  - status chip
  - optional technical detail disclosure

## Acceptance Criteria

1. Two or more adjacent assistant action windows for one user prompt render as one outer group.
2. One click on outer group collapses/expands all operations for that prompt.
3. Subgroups are still independently collapsible by type.
4. `issues` rows do not split subgroup into a new section.
5. Compaction appears as explicit subgroup in timeline.
6. Existing running/streaming indicators remain functional.
7. No regressions in thinking-on/off visibility behavior.

## Non-Goals

- Redesign of non-timeline chat bubble layout.
- Changing OpenCode event schema.
- Introducing timeline tabs.

## Risks

- Classification drift for uncommon tools/events.
- Mis-association of late-arriving runtime parts to wrong prompt group.

## Mitigations

- Centralize classification in one pure helper.
- Cover prompt-boundary and classification edge cases with focused tests.
- Keep fallback subgroup (`other`) to avoid dropping events.
