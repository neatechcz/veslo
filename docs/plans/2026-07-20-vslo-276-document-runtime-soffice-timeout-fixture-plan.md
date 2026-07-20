---
title: "VSLO-276: Make the document-runtime soffice timeout fixture independent of managed PATH"
date: 2026-07-20
status: proposed
done: false
ticket: VSLO-276
repository_snapshot: origin/main at e998709bf39ba541160464ce8c80112d2bee74ef
working_tree_scope: documentation-only plan; do not alter unrelated dirty worktree changes
scope: POSIX test fixture reliability for the document-runtime doctor timeout contract
---

# VSLO-276: Document-runtime `soffice` Timeout Fixture

## Problem

`Quality / Unit` failed on Ubuntu in the document-runtime test named
`doctor fails when soffice times out`:

```text
packages/document-runtime/src/runtime.test.mjs:229
Expected values to be strictly equal:
true !== false
```

The failing CI run is
[29504706011](https://github.com/neatechcz/veslo/actions/runs/29504706011).
The test completed in about 22 ms, rather than waiting for its 100 ms timeout.
This is a fixture defect, not evidence that the production timeout path accepts
a genuinely hanging LibreOffice process.

The non-Windows `writeSofficeProbe()` fixture writes this script shape:

```sh
#!/bin/sh
sleep 1
exit 0
```

`doctor()` intentionally executes managed commands with `PATH` restricted to
the package's `bin` directory. The fixture provides `soffice` there but does
not provide `sleep`. On POSIX, `/bin/sh` reports `sleep: not found`, continues
to `exit 0`, and makes the fake probe appear healthy before the timeout.

The Windows fixture does not have this defect because it uses an absolute
`%SystemRoot%\\System32\\ping.exe` path. A local Windows run is therefore green
without disproving the Linux failure.

The helper with unqualified `sleep` was introduced in `cc0e0f0d`; the bug scan
commit `b4304720` only exposed it. The affected test and runtime source remain
unchanged through the current `origin/main` snapshot.

## Decision

Fix only the non-Windows **test fixture**. Keep the managed runtime's isolated
`PATH` contract unchanged.

The delayed POSIX fake `soffice` will `exec` the absolute current Node binary
(`process.execPath`) with a small `-e` program that exits after `delayMs`.
`exec` replaces the shell, so the production timeout kills the direct delayed
child instead of leaving a shell-owned helper process behind.

Do not add host paths to `buildManagedEnv()`, do not add `sleep` to the managed
runtime package, and do not change `doctor()` timeout behavior.

## Implementation

**Owner:** `packages/document-runtime/src/runtime.test.mjs`

1. Add a small POSIX shell-quoting helper for fixture-generated arguments. It
   must safely quote `process.execPath` and the JavaScript `-e` source.
2. In the non-Windows branch of `writeSofficeProbe()`, replace the delayed
   `sleep` line with an `exec` of `process.execPath`.

   The JavaScript process must call `process.exit(exitCode)` after `delayMs`,
   so the helper preserves both the configured delay and exit-code semantics.
   When `delayMs` is zero, retain the existing direct shell `exit` behavior.
3. Leave the Windows `%SystemRoot%\\System32\\ping.exe` fixture unchanged.
4. Keep the existing behavioral assertion: a 1000 ms probe with
   `timeoutMs: 100` yields `result.ok === false` and the `soffice` check reports
   `Timed out after 100ms`.

## Verification

1. Run `pnpm --filter veslo-document-runtime test` on Windows. This is a
   regression check for the untouched Windows branch.
2. Run the same command on Linux (or let the Ubuntu Quality runner execute it).
   The timeout test must pass rather than return a false healthy result.
3. Run the `Quality / Unit` GitHub Actions job. The document-runtime package
   must execute after earlier unit suites are green and report no timeout-fixture
   failure.
4. Run `git diff --check`.

## Non-goals

- Changing production `packages/document-runtime/src/runtime.mjs`.
- Relaxing the managed `PATH` isolation contract.
- Changing the 15-second real `soffice` doctor allowance.
- Updating a document-runtime package, desktop installer, Den, or AI Gateway.
  This is test-only code and requires no service or desktop release.

## Completion criteria

VSLO-276 is complete only when the POSIX timeout test passes in Quality / Unit
and the test still proves a real managed child process is reported as timed out.
