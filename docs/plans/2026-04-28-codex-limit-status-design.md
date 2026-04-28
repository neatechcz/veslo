# Codex Limit Status Design

## Goal

Show Codex 5h and weekly limit status on both the hosted AI Gateway Usage page and Credentials page, using the same credential-scoped upstream status probe and making unknown limit data visibly different from broken credentials.

## Context

The hosted admin Usage page already has a per-credential upstream status shape with optional `limits.fiveHour` and `limits.weekly` windows. The Codex status parser can map 300-minute and 10080-minute windows into those fields when Codex session logs contain `rate_limits`.

The current live behavior proves two separate states can occur:

- A Codex credential can be healthy enough for assignment and runtime use because the probe completes with `codex | OK`.
- The same credential can still show no 5h or weekly limit status because the probe did not find parseable `rate_limits` in the session logs.

Those states should remain separate. A missing limits snapshot should not make a healthy credential ineligible, and an invalid refresh token or 401 should still make the credential unavailable.

## Recommended Approach

Use `upstreamStatus` as the single read model for Codex health and limit windows across both admin pages.

The Usage page should continue showing recorded Veslo usage for all credentials. For Codex credentials, it should also show:

- Health/probe result.
- 5h limit window when parsed.
- Weekly limit window when parsed.
- A clear "limits unknown" state when the probe succeeds but no rate-limit windows are parsed.
- A clear unavailable/error state for invalid grant, 401, revoked, draining, or probe-failing credentials.

The Credentials page should receive the same `upstreamStatus` block from its credentials API response and render the same Codex status summary. Non-Codex credentials should not get fake limit data.

## Data Flow

1. The admin service lists platform credentials.
2. Codex credentials are decorated with cached `upstreamStatus` from the existing Codex status provider.
3. `GET /admin/api/usage` uses that decorated status while composing per-credential usage rows.
4. `GET /admin/api/credentials` returns the same decorated status for the Credentials page.
5. The static admin app renders a shared formatter for Codex upstream health and 5h/weekly windows.

The status provider cache should prevent the Usage and Credentials pages from triggering redundant Codex probes when loaded close together.

## Probe And Parser Strategy

The existing Codex CLI probe should remain best-effort and failure-tolerant. It should never expose or log credential secrets.

The parser should keep the current `token_count.info.rate_limits` behavior and add a conservative fallback that searches known event payload shapes for a `rate_limits` object. A parsed window is valid only when it contains enough numeric data to identify the window and usage/reset state. Windows should be mapped by actual duration, not by array order:

- 300 minutes maps to `fiveHour`.
- 10080 minutes maps to `weekly`.

If only one valid window is present, the UI should render that window and mark the other as unknown.

When the probe completes successfully but no limits are parsed, the returned status should preserve the healthy probe detail and expose an unknown-limits state for display. When the probe fails with authentication or refresh-token errors, the returned status should remain unavailable and should include the existing sanitized detail.

## Admin UI Behavior

Usage should keep the existing credential usage table and improve the language around Codex limits:

- Healthy with parsed limits: show 5h and weekly usage/reset values.
- Healthy without parsed limits: show Codex OK, limits unknown.
- Unavailable/error: show the sanitized upstream error detail.

Credentials should add the same Codex limit summary in the credential row and detail area. This gives admins the answer before assigning users: whether the credential is healthy, whether limits are visible, and whether any refresh-token failure is present.

## Non-Goals

- Do not add a database migration. Limit status is live/cached probe metadata, not durable credential state.
- Do not make user assignment depend on parseable 5h/weekly limits. Assignment should depend on credential state and upstream health, not observability completeness.
- Do not run an interactive Codex session from the browser or expose Codex session logs to the admin UI.
- Do not support OpenAI or Anthropic limit windows in this change.

## Error Handling

The admin API should continue returning credentials and historical usage even when Codex limit probing fails. Probe errors should be represented in `upstreamStatus` instead of failing the whole endpoint.

Refresh-token failures such as `invalid_grant: refresh token already used` must remain visible as errors because they require reconnecting or rotating the credential. "Limits unknown" must be rendered as lower severity than those authentication errors.

## Testing

Add tests for the status parser, admin read models, and static admin UI:

- Parser coverage for the existing `token_count.info.rate_limits` shape.
- Parser coverage for nested or string-number rate-limit shapes observed from current Codex logs.
- API coverage proving Credentials returns Codex `upstreamStatus`.
- API coverage proving Usage still returns 5h and weekly windows when the provider supplies them.
- UI coverage proving Usage and Credentials both reference and render the same 5h/weekly status fields.

Focused verification should run the AI Gateway status, admin read-model, admin-action, and admin-UI tests, followed by the AI Gateway build.
