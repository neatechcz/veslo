# Workspace Config and Sharing

This document describes the workspace-scoped config surface and the sharing flows built around it.

## Workspace Config

Workspace-scoped Veslo config lives in:

- `<workspace>/.opencode/veslo.json`

Current relevant fields:

- `workspace.name`
- `workspace.createdAt`
- `workspace.preset`
- `authorizedRoots`
- `reload.auto`
- `reload.resume`

This config is distinct from OpenCode config in `opencode.json` or `opencode.jsonc`.

## Config Page

The workspace config UI lives in `packages/app/src/app/pages/config.tsx`.

Current responsibilities:

- live Veslo server connection details for the active workspace
- reload now
- workspace auto-reload toggle
- auto-resume after auto-reload toggle
- diagnostics bundle for the active workspace

## Reload Semantics

Reload is used when skills, plugins, MCP, or workspace config changes require the engine to reread startup-time state.

Important rules:

- reload is workspace-scoped
- reload can interrupt active tasks
- auto-reload is only meaningful when supported by the current workspace/runtime
- resume-after-reload only applies when auto-reload is enabled

## Live Access Sharing

The share modal includes a live access tab for:

- worker URL
- access token
- invite link

Invite links are generated through `buildVesloConnectInviteUrl()` and can prefill app connection state.

Relevant query params:

- `veslo_url`
- `veslo_token`
- `veslo_startup`

Legacy `ow_*` params are still parsed for compatibility.

## Public Link Sharing

The share modal also supports public bundle links through the publisher service. The app default still points at the separate share service; it is not part of the owned-server stack until an owned `share.veslo.work` publisher is deployed.

Current bundle types:

- `workspace-profile`
- `skills-set`
- `skill`

These are fetched and parsed through `shared-bundles.ts`.

Bundle invite links can also carry:

- intent
- source
- org id
- label

## Import and Export

Local worker config export/import behavior:

- export creates a `.veslo-workspace` archive
- import selects an archive and a target local folder
- export/import is local-worker oriented

The app also supports importing shared bundle payloads into a writable workspace.

## Source of Truth

- workspace config page: `packages/app/src/app/pages/config.tsx`
- server workspace config owner: `packages/server/src/workspace-config-owner.ts`
- share modal: `packages/app/src/app/components/share-workspace-modal.tsx`
- invite and bundle URLs: `packages/app/src/app/lib/veslo-server/connection.ts` re-exported by `packages/app/src/app/lib/veslo-server.ts`
- shared bundle parsing: `packages/app/src/app/lib/shared-bundles.ts`
- import/export workflow: `packages/app/src/app/stores/config-store.ts`
