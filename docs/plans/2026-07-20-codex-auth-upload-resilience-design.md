# Codex Auth Upload Resilience Design

## Context

The admin creates a one-time Codex authentication upload session before the
local helper starts Codex device authorization. The server currently retains
that session in memory for 10 minutes, while the Codex device code is valid for
15 minutes. A valid device login can therefore finish after the upload session
has expired.

The helper also prompts for confirmation after login. When it runs without an
interactive stdin, the readline prompt can reach EOF and let the process exit
successfully without uploading or reporting cancellation. Retrying the command
then consumes more of the already-short upload window.

Successful uploads already replace the credential's encrypted persistent
secret. Temporary upload sessions do not need to survive an AI Gateway restart,
but authentication that has been uploaded successfully must remain durable
across restarts.

## Decision

Keep one-time upload sessions in process memory and extend their lifetime to 20
minutes. This provides five minutes of margin beyond the current 15-minute Codex
device-code window without introducing persistent bearer-token storage or a
database migration.

Keep the explicit confirmation prompt for interactive users. When the helper is
non-interactive and `--yes` was not supplied, fail with a nonzero exit code and
an actionable message explaining that `--yes` is required. Do not silently
continue and do not silently succeed.

Continue consuming the upload session only after the credential secret has been
persisted and the credential has been reconnected. The encrypted credential
secret remains the durable source of truth after a successful response; a later
AI Gateway restart may discard unused upload sessions but must not discard the
uploaded authentication.

## Data Flow

1. An authenticated platform admin creates a one-time upload session.
2. AI Gateway records the random bearer token and 20-minute expiry in memory.
3. The local helper runs Codex device authorization in its isolated profile.
4. The helper validates the generated authentication JSON.
5. An interactive caller confirms the upload, or an automated caller supplies
   `--yes` explicitly.
6. AI Gateway validates the one-time session and authentication payload.
7. AI Gateway replaces the encrypted persistent credential secret, reconnects
   the credential, records the audit event, and consumes the session.
8. Subsequent AI Gateway processes read the persisted credential secret through
   the normal secret-store path.

## Failure Handling

- A missing, expired, reused, or restart-lost upload session remains rejected.
- A non-interactive helper invocation without `--yes` fails before any network
  upload and tells the caller how to proceed.
- Invalid authentication JSON remains rejected before confirmation or upload.
- A failed secret replacement or reconnect does not report upload success.

## Verification

- Add a helper subprocess regression test that closes stdin and proves the
  command exits nonzero with an actionable `--yes` message and sends no upload.
- Add server tests proving a session is valid before 20 minutes and rejected at
  the expiry boundary.
- Keep the existing one-time consumption coverage.
- Add or extend persistence coverage proving the uploaded authentication is read
  from the same durable secret backing after service reconstruction.
- Run focused helper and AI Gateway tests, then the repository `pnpm check` gate.
- Deploy the exact pushed feature-branch revision through the manual owned-server
  workflow, wait for completion, verify public AI Gateway health, and complete a
  fresh real upload using the already-saved local Codex authentication.
