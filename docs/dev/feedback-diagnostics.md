# Feedback Diagnostics Runbook

This is the canonical debugging and support runbook for diagnostics explicitly attached to a Veslo feedback report. Use it to retrieve, preserve, and interpret the last ten minutes of local desktop diagnostics after a user reports a problem.

It complements `docs/dev/veslo-application-logs.md`, which covers the broader owned-server log estate.

## Scope and Boundaries

Feedback diagnostics are a user-opted-in retrospective attachment. They are not continuous production log forwarding and they are not GlitchTip data.

- The desktop keeps the most recent ten minutes in a redacted, disk-backed ring with a 50 MiB total limit.
- When the user attaches diagnostics, desktop creates a local snapshot first.
- The feedback report is stored in Den before that snapshot is queued for delivery.
- The snapshot is uploaded to Den separately in bounded batches of at most 1,000 events or 512 KiB.
- Den stores the events in the encrypted debug-log store and links them to the feedback report through `diagnosticCaptureId`.
- Feedback persistence does not create or project a YouTrack issue.

The native desktop queue is durable. The feedback modal remains in its attachment-delivery state until native status confirms `uploaded`, `uploaded_with_truncation`, or a terminal delivery failure. Keep Veslo open while it is still uploading; a failed or unavailable status is not a successful attachment.

## Retrieve One Feedback Capture

Run commands from the repository root. The helper makes one read-only SSH request and decrypts payloads only inside the Den container.

```bash
# Most recent feedback, compact redacted summary in the terminal
pnpm admin:feedback-diagnostics --

# A known feedback report
pnpm admin:feedback-diagnostics -- --feedback <feedback-id>

# Save a durable, automatically named summary artifact
pnpm admin:feedback-diagnostics -- --feedback <feedback-id> --output-dir .tmp/feedback-diagnostics

# Save the complete diagnostic context as NDJSON
pnpm admin:feedback-diagnostics -- --feedback <feedback-id> --include-events --output-dir .tmp/feedback-diagnostics
```

The default summary deliberately omits the title and body of the feedback. Add `--include-feedback-text` only when that content is required for the investigation. Add `--json` when another script will consume the summary.

## Artifact Naming and Retention

Prefer `--output-dir` for every investigation. It creates one artifact per invocation with a stable format:

```text
feedback-diagnostics-<feedback-id-or-latest>-<UTC timestamp>-<unique suffix>-<summary-or-events>.<txt|json|ndjson>
```

For example:

```text
feedback-diagnostics-fb_123-20260801T141919Z-a1b2c3d4-events.ndjson
```

This prevents one investigation from replacing another. The directory is intentionally operator-owned; clean old artifacts only when their investigation value has ended and according to the applicable support-data retention policy.

`--output <path>` remains useful for an exact location. It creates missing parent directories but never overwrites an existing file. For a full event export, the helper streams rows to a temporary file and creates the final file only after the remote read succeeds.

## Interpreting the Summary

Start with the time window, event count, sources, and named signals. Then correlate anomalies with `runId`, `conversationId`, and `clientMessageId` in the full NDJSON only when the compact summary is insufficient.

The per-run section is intentionally a bounded convenience summary. It tracks at most 2,000 distinct `runId` values recognized in structured Veslo traces. It does not cap, delete, or omit raw stored events. If the summary says that further observations were omitted, use the full NDJSON export for the complete context; the number is observations after the summary capacity was reached, not a count of distinct omitted runs.

## Troubleshooting

| Symptom | Meaning and next action |
| --- | --- |
| `Diagnostics: no diagnostic capture was attached` | The feedback was valid but no snapshot was attached. Investigate regular application logs instead. |
| `diagnostics_unavailable` in the feedback UI | The feedback was saved, but a local snapshot could not be created or queued. It is not recoverable from the feedback export. |
| UI remains on attachment delivery | The queue is still pending. Keep Veslo open; do not call it delivered until status says `uploaded` or `uploaded_with_truncation`. |
| `uploaded_with_truncation` | The attachment reached the 50 MiB local snapshot limit. The available events are valid but the earliest retained context may be incomplete. |
| Helper cannot connect or returns invalid JSON | Check the owned-server deployment and operator SSH configuration described in `docs/dev/veslo-application-logs.md`; do not work around the helper by copying database credentials or encryption keys locally. |

## Verification

For changes to the export helper, run:

```bash
node --check scripts/admin/feedback-diagnostic-report.mjs
node --test scripts/admin/feedback-diagnostic-report.test.mjs
```

For changes to the desktop feedback UI or native queue, run the relevant focused application and native tests before considering a real signed-in desktop check. Do not use the legacy feedback-to-YouTrack smoke as evidence for this flow: feedback diagnostics terminate in Den and do not depend on YouTrack.
