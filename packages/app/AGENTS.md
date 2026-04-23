# AGENTS.md

This package contains Veslo's shared SolidJS app shell and primary user-facing UI surfaces.

## Rules

- Start with `docs/dev/app-map.md` and `docs/dev/state-and-config-reference.md` before broad exploration.
- This package is shared UI code, not the runtime under test. Do not launch `pnpm -w dev:ui`, `pnpm --filter @neatech/veslo-ui dev`, or raw Vite as the app runtime; use the desktop startup flow from `docs/dev/development-startup.md`.
- When editing `packages/app/src/**/*.tsx`, follow `.opencode/skills/solidjs-patterns/SKILL.md`.
- Preserve purpose-first, premium, mobile-native UI. Favor clarity, touch-friendly layouts, and fluid motion over utilitarian admin UI.
- Prefer scoped async and loading state over global blocking state.
- Verify changes with the package-relevant checks from `docs/dev/testing-playbook.md`. Start with `pnpm typecheck` and then run the most relevant `pnpm --filter @neatech/veslo-ui test:*` commands for the changed surface.
