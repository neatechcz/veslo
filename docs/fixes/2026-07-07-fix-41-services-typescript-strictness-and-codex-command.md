# Fix 41: Services TypeScript Strictness and Codex Command Hardening

Date: 2026-07-07

## Scope

This checkpoint records the pass over `services/` to add moderate TypeScript
guard rails and fix the concrete issues those checks surfaced.

Covered service packages:

- `services/ai-gateway`
- `services/den`
- `services/worker-manager`

`services/openwork-share` has no TypeScript build configuration, and
`services/den-worker-runtime` currently only contains a README in this checkout,
so neither was changed in this pass.

The worktree already contained unrelated service changes around
`http/proxy*`, provider imports, and `proxy-dependencies.ts`; those are not
claimed by this checkpoint.

## What Changed

- Enabled `noFallthroughCasesInSwitch`, `noImplicitReturns`, and
  `noUncheckedIndexedAccess` in `services/ai-gateway/tsconfig.json`.
- Enabled `noFallthroughCasesInSwitch` and `noImplicitReturns` in
  `services/den/tsconfig.json`.
- Enabled `noFallthroughCasesInSwitch`, `noImplicitReturns`,
  `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` in
  `services/worker-manager/tsconfig.json`.
- Fixed array-index assumptions in AI gateway deployment endpoint parsing and
  Codex CLI worker token-usage parsing.
- Fixed `worker-manager` optional Docker resource limits so `memoryBytes` and
  `nanoCpus` are only present when configured instead of being passed as
  explicit `undefined`.
- Hardened package-local Codex CLI command resolution for Windows in
  `ai-gateway` and DEN managed-AI code paths. The default package-local command
  now runs through the Node entrypoint on Windows instead of relying on a
  Unix-style `.bin/codex` shell wrapper.
- Made Codex worker/status tests portable on Windows by avoiding POSIX-only
  permission assertions and by running fake `.cjs` commands through Node where
  needed.
- Relaxed one DEN onboarding-page source assertion to check the intended
  ordering instead of exact whitespace.

## Findings

`noUncheckedIndexedAccess` was useful in `ai-gateway`: it found real unsafe
array access around fallback host parsing and reverse log-line scanning.

`worker-manager` was small enough to support the stricter optional-property
contract after a small object-shape cleanup.

`den` is not ready for global `noUncheckedIndexedAccess` or
`exactOptionalPropertyTypes` yet. Diagnostic runs showed broader cleanup work
across request params, DB result rows, skill registry routes, worker routes,
connector routes, and managed-AI optional payloads. Those checks should be
introduced in smaller ownership slices rather than as one service-wide flip.

The full service test run also exposed Windows portability holes in Codex CLI
test fixtures and package-local command resolution. Those were fixed because
they were small and directly affected confidence in the services test suite.

## Future Direction

- Introduce a shared services TypeScript base config once `den` has been
  narrowed enough to support the same strictness profile as `ai-gateway` and
  `worker-manager`.
- Split the remaining DEN strictness work by ownership area:
  request parameter guards, DB single-row helpers, skill registry routes,
  worker routes, connector OAuth/MCP routes, and managed-AI provider payloads.
- Add small helper APIs for common patterns that `noUncheckedIndexedAccess`
  exposes repeatedly, especially "require one DB row", "read required param",
  and "append optional fields only when defined".
- Keep `exactOptionalPropertyTypes` as a design goal for service boundaries,
  but introduce it per module/package only after payload builders stop emitting
  explicit `undefined` for absent optional fields.
- Preserve Windows subprocess coverage for Codex CLI paths. Any future Codex
  command wrapper should be tested through the same code path used by runtime
  probes, not only through Unix shebang fixtures.

## Verification

Run on 2026-07-07:

```powershell
pnpm --filter @neatech/ai-gateway exec tsc -p tsconfig.json --noEmit
# exit 0

pnpm --filter @neatech/den exec tsc -p tsconfig.json --noEmit
# exit 0

pnpm --filter @neatech/worker-manager exec tsc -p tsconfig.json --noEmit
# exit 0

pnpm --filter @neatech/ai-gateway test
# pass 297, fail 0

pnpm --filter @neatech/den test
# pass 588, fail 0, skipped 1

pnpm --filter @neatech/worker-manager test
# pass 5, fail 0

git diff --check -- services/ai-gateway services/den services/worker-manager
# exit 0, LF/CRLF warnings only
```

Diagnostic checks intentionally not enabled globally:

```powershell
pnpm --filter @neatech/den exec tsc -p tsconfig.json --noEmit --noFallthroughCasesInSwitch --noImplicitReturns --noUncheckedIndexedAccess
# failed with broad DEN cleanup findings

pnpm --filter @neatech/den exec tsc -p tsconfig.json --noEmit --exactOptionalPropertyTypes
# failed with broad DEN optional-property contract findings
```

## Status

The services strictness checkpoint is complete for the safe package-level
settings. `ai-gateway`, `den`, and `worker-manager` all pass typecheck and their
service test suites in this checkout. The remaining strictness work is a future
DEN cleanup track, not a blocker for this checkpoint.
