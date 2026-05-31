# VSLO-160 Agent Right Menu Files Design

**Date:** 2026-05-31  
**Status:** Approved  
**Issue:** VSLO-160

## Goal

Fix the agent right menu file list so it shows only user-relevant files the agent actually opened or modified during the latest run. The list must not look like a technical trace, and skill usage must be represented as a readable skill item instead of a path to `SKILL.md`.

## Current Problem

The right menu can still feel noisy because file provenance may include technical or exploratory paths. The user wants the menu to answer a narrower question: which files did the agent open, and which files did it modify?

The menu should not show:

- files found only through search, list, or glob-style exploration
- temporary files
- cache, build, generated, or helper files
- internal configuration or prompt files
- skill implementation paths such as `SKILL.md`

## Approved Product Semantics

Only two kinds of file interaction are visible in the right menu:

- **Modified**: files created or changed by write/edit/apply-patch style activity
- **Opened**: files explicitly read/opened by the agent

If the same file is opened and later modified in the same run, it appears only under **Modified**. Modified files are more important for review and should appear before opened files.

Search, list, and glob results do not create file rows. They can still help the agent reason internally, but they are not strong enough user-facing evidence for the right menu.

Skills stay separate from files. When a skill is used, the menu shows the skill name, not the path or `SKILL.md`.

## Recommended Architecture

Keep the existing server-backed artifact provenance path as the canonical source. Tighten file classification at the provenance layer so the app receives the right facts:

- read/open activity maps to a file artifact with opened semantics
- write/edit/apply-patch activity maps to a file artifact with modified semantics
- search/list/glob activity does not emit file artifacts
- technical path filtering remains active for both opened and modified files

The app artifact family model should preserve the server facts and ensure a modified file wins over an opened duplicate.

This keeps the behavior durable across local desktop, host, and remote modes. The legacy client heuristic remains only a conservative fallback when server provenance is unavailable.

## Visual Design

The right menu keeps the compact `Artifacts` block and the existing family structure, but the `Files` family gains two internal groups:

1. **Modified**
2. **Opened**

The visual hierarchy:

- `Files` header shows the total file count.
- `Modified` appears first with a compact count.
- `Opened` appears second with a compact count.
- Empty groups are hidden.
- Each row keeps stable height, filename first, relative directory below, and existing file actions such as reveal/open where available.
- Use icons from the existing Lucide set, with modified rows visually stronger than opened rows through icon choice and status chip text, not through large color blocks.

The labels should be localized through the existing i18n system. `Scanned` should no longer be the visible label for right-menu file rows under the new behavior.

## Error Handling And Fallback

If latest-run artifact provenance cannot be loaded, the UI should fall back conservatively. It is better to show fewer files than to reintroduce technical noise.

The fallback must not display skill source paths, cache/build/temp files, or broad search/list/glob-derived paths as user-facing files.

## Testing

Add focused tests for the behavior:

- server provenance emits opened files for explicit reads
- server provenance emits modified files for write/edit/apply-patch
- server provenance does not emit file rows for search/list/glob-only activity
- modified wins when the same file is both opened and modified
- app artifact grouping renders files as Modified and Opened
- skill usage renders as a skill name, not `SKILL.md`
- temporary/cache/build/internal paths are filtered

Desktop verification should use the real Tauri runtime. The E2E path should open the right menu and verify Modified/Opened grouping in the session artifacts panel.
