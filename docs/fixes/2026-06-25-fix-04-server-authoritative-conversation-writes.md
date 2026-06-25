# Fix 04: Server-Authoritative Conversation Writes

## Problem

When the server conversation create/run/compact API was unavailable, the app silently fell back to direct OpenCode SDK writes. That could create sessions or submit work outside the server lifecycle that owns workspace scope, run state, tracing, and persistence.

## Fix

- Prompt, shell, and slash-command sends now use the server conversation run path as the only write path.
- Compaction now fails when the server conversation run path is unavailable instead of calling the legacy compact SDK helper.
- Session creation now requires an active workspace id and a successful server conversation create response.
- Abort fallback remains unchanged because it only attempts to stop already-running work and does not create or submit new conversation work.
- Added source-level regression coverage to prevent legacy create/run/compact SDK fallback paths from returning.

## Files

- `packages/app/src/app/app.tsx`
- `packages/app/src/app/tests/app-send-latency-trace.test.ts`
- `packages/app/src/app/tests/pending-session-send-flow.test.ts`
- `packages/app/src/app/tests/app-attachment-workspace-readiness.test.ts`

## Verification

```powershell
cd packages/app
node --test --import=tsx/esm src/app/tests/app-send-latency-trace.test.ts src/app/tests/pending-session-send-flow.test.ts src/app/tests/app-attachment-workspace-readiness.test.ts
```

Result: pass.
