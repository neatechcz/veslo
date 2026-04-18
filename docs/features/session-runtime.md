# Session Runtime

This document describes the shipped session behavior that future coding agents should preserve.

## Main Session Surface

The session view lives in `packages/app/src/app/pages/session.tsx`.

Key sub-surfaces:

- composer
- message list
- timeline and technical details
- artifacts panel
- context and document side panels
- share modal

## Composer

The composer supports:

- prompt mode
- shell mode
- slash commands
- mentions
- file references
- pasted content placeholders
- attachments

Main source of truth:

- `packages/app/src/app/components/session/composer.tsx`

## Global Model and Thinking Behavior

Session UI can expose model-related controls, but future runs still follow the product's global model policy.

Important behaviors:

- model changes act on the global runtime model contract
- thinking visibility is controlled by `showThinking`
- model variant controls reasoning effort or variant selection
- auto-compaction is a separate preference

## Permissions

Permission prompts are surfaced as first-class runtime events. The session UI is responsible for keeping approval flows visible and understandable rather than hiding them in logs.

## Artifacts

Artifacts are modeled as run-scoped families:

- Files
- Skills
- MCP
- Soul

Server-backed artifact provenance is preferred when available. Technical noise such as `AGENTS.md`, `SKILL.md`, and `.opencode/**` should not appear as generic file artifacts unless they are the actual user-facing target.

Main model source:

- `packages/app/src/app/components/session/artifact-family-model.ts`

## Archive and Restore

Session archive behavior removes sessions from the active primary list and exposes archived items through Settings.

If archive semantics change, update this doc and `docs/features/settings-and-preferences.md`.

## Feedback

Session and dashboard surfaces can open the feedback modal.

Current behavior:

- captures the current visible app surface
- includes technical details
- submits to Den-backed feedback API

Main sources:

- `packages/app/src/app/components/feedback-modal.tsx`
- `packages/app/src/app/lib/feedback.ts`

## Sharing Entry Points

Session view includes live-access sharing and public-link sharing through `ShareWorkspaceModal`.

Those semantics are documented in `docs/features/workspace-config-and-sharing.md`.

## Source of Truth

- session page: `packages/app/src/app/pages/session.tsx`
- composer: `packages/app/src/app/components/session/composer.tsx`
- message rendering: `packages/app/src/app/components/session/message-list.tsx`
- artifacts: `packages/app/src/app/components/session/artifact-family-model.ts`
- feedback: `packages/app/src/app/lib/feedback.ts`
