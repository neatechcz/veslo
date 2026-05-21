# Owned Server Production Cutover Checklist

This checklist is the operator record for moving Veslo production traffic from Render/Den-hosted surfaces to the owned server at `62.109.146.43`.

## Current State

- Maintenance approval: received on 2026-05-21.
- `app.veslo.work` resolves to `62.109.146.43`.
- `api.veslo.work` and `ai.veslo.work` resolve through `app.veslo.work` to `62.109.146.43`.
- The owned-server stack is already serving public HTTPS traffic for the owned domains.
- Existing released desktop builds may still use Render defaults until a new build is shipped or an operator-provided override is applied.

## Pre-Window Checks

- Confirm Phase 4 health, auth, managed AI, feedback, debug-log ingest, and backup checks passed.
- Confirm no unrelated deploys, migrations, or production worker changes are planned during the window.
- Confirm `sudo docker ps` and `sudo docker compose` access on the owned server.
- Confirm Caddy can bind public ports 80 and 443.
- Confirm DNS edit access and current TTL values for `app.veslo.work`, `api.veslo.work`, and `ai.veslo.work`.
- Confirm Render Den and Render AI Gateway health endpoints still answer as rollback targets.
- Confirm the desktop, orchestrator, web proxy, and AI Gateway production defaults point at owned domains in the build being released.

## Final Data Handling

- If Render can still receive writes, freeze or pause the Render write path before taking a final dump.
- Take final Render database dumps for Den and AI Gateway and record checksums.
- Restore final dumps to the owned-server databases only when the owned server has not accepted newer writes, or after a deliberate merge/reconciliation plan.
- Do not overwrite an already-live owned-server database with a Render dump unless the residual owned-server writes have been accounted for.
- Run Den and AI Gateway migrations after any restore.
- Take an owned-server backup immediately before and after the cutover window.

## DNS And Traffic Switch

- Point selected production records to `62.109.146.43`.
- For the current owned-domain cutover, the DNS records already point to the owned server.
- Treat the release that changes desktop/orchestrator defaults as the client-routing cutover for newly installed or updated desktop clients.
- Keep Render services running during the observation window for rollback and for old clients that still default to Render.

## Post-Cutover Checks

- `https://api.veslo.work/health` returns HTTP 200 with `{ "ok": true }`.
- `https://ai.veslo.work/health` returns HTTP 200 with `{ "ok": true, "service": "ai-gateway" }`.
- `https://app.veslo.work` returns HTTP 200.
- Existing bearer auth and exchanged desktop auth tokens can call `/v1/me`.
- Desktop auth start, browser handoff, and exchange complete.
- Managed-AI access returns the expected enabled Codex OAuth policy.
- A Codex OAuth chat completion returns HTTP 200 and records usage.
- Feedback projection returns HTTP 201 and creates a YouTrack issue.
- Debug-log ingest returns HTTP 202 and the admin read path can find the event.
- Recent Den and AI Gateway logs show no matching `error`, `exception`, `unhandled`, or `fatal` lines after the smoke run.

## Rollback Decision Point

Rollback is triggered if health, auth, managed AI, feedback, or debug-log checks fail in a way that affects users and cannot be fixed within the maintenance window.

Rollback steps:

- Repoint affected DNS records back to the previous Render/front-end targets if DNS was changed in the window.
- Keep the owned-server stack running for forensic comparison.
- Do not delete or mutate restored owned-server data.
- Record whether any writes landed on the owned server before rollback.
- If writes landed on both Render and the owned server, choose a source of truth and reconcile before attempting another cutover.

## Render Freeze And Decommission Conditions

- Do not decommission Render immediately after the owned-domain cutover.
- Keep Render available until the desktop default rollout or proxy strategy is complete.
- Freeze Render writes only after confirming old clients no longer depend on Render defaults, or after Render is intentionally converted into a forwarding/maintenance surface.
- Decommission Render only after an observation window with passing production checks, verified backups, rollback documentation, and no unreconciled Render-only writes.
