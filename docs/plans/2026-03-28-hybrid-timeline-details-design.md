# Hybrid Timeline Details Design

**Date:** 2026-03-28  
**Status:** Approved  
**Branch:** main

## Goal

Redesign expanded session timeline details so users can quickly understand what the agent did, while keeping the default collapsed state compact and non-technical.

## Scope

- Expanded/collapsed behavior for session execution timeline in:
  - `packages/app/src/app/components/session/message-list.tsx`
- Timeline section derivation and summary copy.
- Event-row information hierarchy, status chips, and secondary technical disclosure.
- Localized copy needed for the new timeline chrome.

Out of scope:

- New tabs or filtered timeline views.
- Changes to the underlying session event model from OpenCode.
- Full redesign of chat bubbles outside the execution timeline block.
- Changes to non-session surfaces.

## Validated Product Decisions

1. Use the hybrid timeline direction, not the raw log list and not the heavier phase-card-only version.
2. Do not add top-level tabs such as `All`, `Explore`, `Action`, `Issues`.
3. The entire timeline block must support `expand / collapse`.
4. Each section inside the timeline must also support independent `expand / collapse`.
5. Multiple sections may remain open at the same time.
6. Sections are derived from actual runtime events, not from a fixed required workflow.
7. `Plan` only appears when the run explicitly contains planning content.
8. The collapsed timeline header must summarize what happened in human language.
9. Raw commands and other technical payloads must be secondary disclosure, not the main row content.

## Recommended Approach (Approved)

Keep the current single outer execution block per message or steps cluster, but replace the flat list of step rows with a two-level hierarchy:

- outer execution timeline block
- inner derived sections such as `Plan`, `Explore`, `Action`, `Verify`, `Issues`
- compact event rows inside each section

This preserves density in the default collapsed state while making expanded detail readable and visually structured.

## Information Architecture

### Outer timeline block

- Default state: collapsed.
- Collapsed header shows:
  - section-aware human summary
  - last meaningful action
  - active/running indicator when applicable
- Expanding the block reveals the derived sections stacked vertically.

### Inner sections

Sections appear only when relevant events exist.

Preferred section order:

1. `Plan`
2. `Explore`
3. `Action`
4. `Verify`
5. `Issues`

Rules:

- Consecutive events of the same section type are grouped into a single section.
- If the flow returns to a previous section type, a new section is created.
- `Issues` may exist as a standalone section when failures or warnings are present.

## Section Derivation Rules

### Plan

Show `Plan` only when reasoning/text explicitly states intent or steps before the main execution work begins.

### Explore

Use for context-gathering operations such as:

- `read`
- `grep`
- `search`
- `glob`
- `list`
- `list_files`

Reasoning immediately attached to exploration should stay inside the same section.

### Action

Use for actual work being carried out:

- `edit`
- `write`
- `apply_patch`
- `bash`
- `task`
- `skill`
- `webfetch`
- other non-exploration tools that represent execution

### Verify

Use for explicit checking and validation:

- test runs
- lint/build checks
- post-change review
- verification-oriented reasoning or tool results

### Issues

Use for:

- tool errors
- diagnostics/warnings
- permission blocks
- synthetic session error turns

## Collapsed Summary Model

Collapsed copy must explain the work, not the tool names.

Examples:

- `Prozkoumáno 3 soubory · 2 akce · ověření OK`
- `Naplánováno · prozkoumán kontext · 1 problém`
- `2 akce · poslední: typecheck`

Requirements:

- no raw commands in collapsed summary
- no internal/tool-centric jargon
- last-action detail should be short and human-readable

## Event Row Model

Each event row inside a section uses one clear hierarchy:

- leading icon
- primary line: what happened
- trailing status chip
- secondary line: what came out of it
- optional technical disclosure below

### Primary line

The primary line answers: "What happened?"

Examples:

- `Načetl message-list.tsx`
- `Vyhledal "timeline"`
- `Upravil seskupení kroků`
- `Spustil typecheck`
- `Delegoval kontrolu UI`

### Secondary line

The secondary line answers: "What came out of it?"

Examples:

- `řádky 640-1040 · timeline labels a summary`
- `12 shod ve 2 souborech`
- `1 soubor změněn`
- `bez chyb`
- `subagent: explorer`

### Technical disclosure

Raw command, tool input, or payload should only appear behind an explicit secondary disclosure such as `Technický detail`.

The raw detail must never be the default primary content of the row.

## Visual Language

- Remove semantic dependence on the current dot-led row styling.
- Icons become the primary visual orientation point for rows.
- Status is communicated by small chips such as `Hotovo`, `Běží`, `Chyba`, `Pass`.
- Primary row text is semibold.
- Secondary row text is quieter and smaller.
- Monospace command text is reserved for technical detail disclosure.

Recommended icon mapping:

- `Explore`: `Eye`, `Search`, `FolderSearch`
- `Action`: `Pencil`, `Terminal`, `Bot`, `Sparkles`
- `Verify`: `CheckCircle` or `ShieldCheck`
- `Issues`: `CircleAlert`

## Interaction Model

- Whole timeline block: `expand / collapse`
- Individual sections: independent `expand / collapse`
- Multiple sections may stay open simultaneously
- When a run is active, the currently running section may auto-open
- Otherwise the default expanded state should stay compact

## Acceptance Criteria

- The collapsed timeline header communicates the work in human language.
- Expanded detail is organized into derived sections instead of a flat technical list.
- No tabs are introduced.
- Users can collapse/expand the whole timeline and also each section individually.
- Event rows clearly separate:
  - what happened
  - what resulted
  - technical detail
- Raw command text is not the default first thing a user sees.
