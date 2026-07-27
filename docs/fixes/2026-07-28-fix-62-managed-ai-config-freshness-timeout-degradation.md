# Fix 62: Managed AI Config Freshness Timeout Degradation

Date: 2026-07-28

## Scope

Fixed an ordinary managed-AI conversation send that could stop before OpenCode
submission with:

```text
Managed AI configuration freshness failed: Request timed out after 10000ms:
GET http://127.0.0.1:8787/workspace/<workspace-id>/config
```

The change is limited to the app-owned managed-config admission boundary.
Desktop E2E and manual installed-runtime verification remain user-owned and are
not claimed by this fix.

## Root cause

Every server-owned send created a new freshness flight and unconditionally read
the current workspace config. The existing last-known snapshot was consulted
only after that read succeeded, so a transient loopback transport timeout was
converted into a hard preflight failure even when the same configuration had
already been verified and used successfully in the current app process.

## Implemented behavior

- Successful managed-config synchronization records the complete verified
  intent for its workspace scope.
- A send-preflight loopback transport failure may continue only when that
  complete intent is unchanged and no reload is pending for the exact server
  workspace.
- The intent covers workspace identity and root, exact server workspace,
  managed profile and model roster, server endpoint and token, provider routing,
  DEN authorization revision, and runtime authorization inputs.
- The fallback is process-local and is cleared with the existing managed-config
  tracking reset when server identity, token, or managed access changes.
- Authorization changes, server API responses such as `403`, missing prior
  verification, and pending config reloads remain fail-closed.
- The original config-read error remains in diagnostics. A successful degraded
  admission emits `managed-ai-config-sync:degraded-last-verified` with the send
  trace and safe intent hashes. The next send performs a fresh config read.

## Validation

Focused app validation:

```powershell
pnpm --filter @neatech/veslo-ui exec tsx --test src/app/tests/context/managed-ai-runtime-config.test.ts
pnpm --filter @neatech/veslo-ui exec tsx --test src/app/tests/context/managed-ai-runtime-config.test.ts src/app/tests/context/conversation-service.test.ts src/app/tests/context/send-runtime-readiness.test.ts
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Results:

- `46/46` managed-config tests passed.
- `125/125` focused managed-config, conversation-service, and send-readiness
  tests passed.
- App typecheck passed.
- A transient timeout with an exact verified intent proceeds without setting a
  user-visible config error.
- Changed authorization identity and explicit server authorization failure are
  covered as fail-closed cases.
- The repository-wide `pnpm check` still fails in pre-existing app source-shape
  assertions around session folder access and composer-key ownership. The
  focused tests and typecheck for this fix pass; the unrelated dirty app-shell
  assertions were not changed here.

## Remaining verification

Run the normal desktop flow against the same workspace and confirm that a
transient `/workspace/:id/config` timeout produces the degraded trace event and
the prompt still reaches OpenCode. This manual E2E evidence is intentionally not
claimed here.
