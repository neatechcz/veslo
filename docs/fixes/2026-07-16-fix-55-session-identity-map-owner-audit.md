# Fix 55: Session-Identity Map Owner Audit

Date: 2026-07-16

## Scope

This audit reviews production maps whose variable names indicate session-keyed
state. It specifically tests whether one raw session id can occur in multiple
workspaces or directories without sharing execution, transcript, or sidebar
state.

## Finding and Fix

The sidebar hierarchy model already resolves tree relationships through scoped
row keys, but its public lookup also exposed unused raw-session-id indexes.
Those indexes were ambiguous for duplicate ids and made a future accidental
cross-workspace lookup easy. They were removed. The hierarchy API now exposes
only row-key indexes for parent/child traversal.

## Audit Result

No additional confirmed cross-workspace execution defect was found:

- The selection guard receives the app's composite UI conversation key and
  rejects stale selection loads when that key changes.
- Sidebar row and prefetch owners retain duplicate session ids by scoped row
  key, workspace, and directory; ambiguous legacy references are ignored.
- Transcript prefetch in-flight, invalidation, and cache paths include
  workspace and normalized directory.
- AI Gateway keeps multiple active-run contexts per raw OpenCode id and
  filters by workspace, failing closed when a fallback would be ambiguous.
- The remaining raw-id maps are bounded diagnostics, same-workspace indexes,
  or unrelated administrative upload-session state. They remain informational
  audit output rather than a false passing/failed gate.

## Verification

```powershell
corepack pnpm@10.27.0 --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/components/session/workspace-session-list-model.test.ts src/app/tests/context/select-session-guard.test.ts src/app/tests/context/session-selection-controller.test.ts
# passed: 67/67

pnpm --filter veslo-server exec bun test src/tests/session-transcript-prefetch.test.ts src/tests/ai-gateway-runtime-owner.test.ts
# passed: 30/30

pnpm --filter @neatech/veslo-ui typecheck
# passed

pnpm audit:session-identity
# passed; 19 informational owner-review maps, down from 21
```

## Status

Implemented and locally verified. Future work should retain the audit as an
owner-review inventory and add a targeted duplicate-id test whenever a new
session-keyed execution or cache map is introduced.
