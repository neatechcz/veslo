---
title: Den Managed-AI Audit Event Schema Collision Remediation
status: proposed
done: false
date: 2026-07-28
issue: unlinked
scope: Den schema ownership, migration, and contract verification
related:
  - docs/plans/2026-07-28-production-runtime-error-causality-audit-plan.md
---

# Den Managed-AI Audit Event Schema Collision Remediation

## Problem

Production Den contains a physical table named `audit_event` with the original
core Den schema:

```text
id, org_id, worker_id, actor_user_id, action, payload, created_at
```

The legacy Den managed-AI audit repository still reads and writes that same
physical table name using a different schema:

```text
id, actor_user_id, entity_type, entity_id, action, result, summary, created_at
```

The managed-AI Codex capacity monitor calls `listAlreadySentEmailKeys()`, which
selects the newer columns from the older production table. MySQL rejects the
query because `entity_type`, `entity_id`, `result`, and `summary` do not exist.

This is a stale consumer of a resolved schema ownership collision, not a
transient database outage. The owner migration already created the replacement
table; Den had not followed that owner boundary.

## Evidence

- `services/ai-gateway/drizzle/0004_organization_audit_scope.sql` creates and
  backfills `ai_gateway_audit_event` without mutating core Den
  `audit_event`.
- AI Gateway schema reconciliation owns the same replacement table and its
  indexes.
- `services/den/src/managed-ai/schema.ts` had retained the obsolete
  `audit_event` physical name even though its managed-AI database is the AI
  Gateway database.
- Den's managed-AI audit and alert repositories both consumed that stale table
  symbol.
- `services/den/src/db/schema.ts` defines the older core Den `audit_event`
  contract.
- The original Den bootstrap creates the older table with `CREATE TABLE IF NOT
  EXISTS audit_event`.
- The production table was read-only inspected and matched the older schema.
- No migration was found that adds the managed-AI columns to the existing core
  table.

## Recommended ownership decision

Keep the existing core Den table unchanged and use the already-owned physical
table `ai_gateway_audit_event` for managed-AI audit data.

This is the safer KISS boundary because:

- it does not reinterpret existing core audit data;
- it does not add nullable or synthetic managed-AI fields to a live table owned
  by another subsystem;
- it makes repository ownership visible in the table name;
- it allows a forward migration without destructive production DDL;
- it prevents a future `CREATE TABLE IF NOT EXISTS audit_event` from silently
  claiming the managed-AI contract.

The source audit confirms that this is the established AI Gateway table name
and deployment migration. Renaming the original core table is out of scope for
this remediation.

## Required invariants

1. Core Den code continues to read and write the existing `audit_event` schema.
2. Managed-AI code reads and writes only its explicitly owned table.
3. No migration mutates or drops existing core audit columns.
4. A fresh installation and an upgrade from the current production schema both
   create the managed-AI table before the monitor can run.
5. The capacity monitor does not query a table owned by another subsystem.
6. Existing managed-AI alert idempotency remains preserved after migration.
7. Migration failures are observable and fail the managed-AI capability without
   corrupting core Den audit data.

## Implementation phases

### DAE01 — Make ownership explicit in code

- Rename the managed-AI Drizzle table symbol and physical table name to the
  AI Gateway-owned `ai_gateway_audit_event` name.
- Update managed-AI audit repositories, alert repositories, and all monitor
  queries.
- Search the entire Den service for raw `audit_event` references and classify
  each as core or managed-AI.
- Remove any ambiguous shared import or table symbol.

Source implementation completed on 2026-07-28: the Den managed-AI schema now
exports `ManagedAiTableNames` and `managedAiAuditEventTable`; both audit
repositories use that table. Core Den continues to own `audit_event`.

### DAE02 — Add a forward-only migration

- Reuse the existing AI Gateway forward-only migration that creates and
  conditionally backfills `ai_gateway_audit_event`.
- Do not alter, rename, or backfill the legacy core `audit_event` table unless a
  separate approved data-migration decision is made.
- Verify that the AI Gateway migration runs before the Den managed-AI capacity
  monitor starts.

The migration source and reconciliation tests pass locally. Applying it to a
production database remains a separately authorized deployment action.

### DAE03 — Add contract tests

The focused tests must fail if the collision returns:

1. A schema contract test asserts that core and managed-AI table names are
   different.
2. The existing AI Gateway legacy-schema integration fixture creates the old
   `audit_event` table, applies the owner migration, and verifies that the
   replacement table can preserve managed-AI history.
3. A monitor test verifies that `listAlreadySentEmailKeys()` reads the managed
   table and does not select `entity_type` from core `audit_event`.
4. A fresh-schema test verifies that the AI Gateway replacement table is
   created with its intended columns.
5. An upgrade test verifies that existing core audit rows remain readable and
   unchanged after the managed-AI migration.
6. A negative test fails if managed-AI SQL contains an unqualified reference to
   the core table name.

The local repository-boundary contract is complete: it executes both managed-AI
repositories against a capturing Drizzle-shaped database and asserts that their
actual read and write table arguments are the AI Gateway-owned table, never
core Den `audit_event`. The existing AI Gateway migration-chain and schema
reconciliation tests cover the forward migration source, its conditional legacy
copy, and fresh-schema ordering. They are source-level evidence only; they do
not claim a production database upgrade or a monitor run.

### DAE04 — Production read-only preflight

Before applying the migration in production, verify read-only:

- the current `audit_event` column list;
- the migration ledger state;
- whether a managed-AI table already exists under another name;
- the monitor container image/commit identity;
- the absence of active schema-changing operations.

Do not run repair DDL as part of this audit or preflight.

### DAE05 — Rollout and monitoring

- Apply the migration through the normal Den deployment path.
- Start the managed-AI monitor only after migration success.
- Confirm that the repeated unknown-column error stops.
- Confirm that core Den audit writes continue.
- Confirm that managed-AI alert idempotency does not resend already recorded
  alert emails.

## Failure handling

If the managed-AI migration is unavailable, the monitor should report a clear
managed-AI schema-unavailable diagnostic and avoid writing to core
`audit_event`. It must not fall back to querying the ambiguous legacy table,
because that would recreate the same silent collision.

## Acceptance matrix

| Scenario | Expected result |
| --- | --- |
| Existing production core `audit_event` | Remains unchanged and queryable by core Den |
| Upgrade with no managed-AI table | Migration creates the managed-AI table |
| Fresh installation | Both owned tables are created with distinct names |
| Capacity monitor run | No unknown-column query; idempotency query succeeds |
| Existing core audit rows | No loss, rewrite, or reinterpretation |
| Managed-AI migration failure | Explicit managed-AI failure; no writes to core audit |
| Future schema inspection | Table name alone identifies ownership |

## Non-goals

- Do not repair the production database directly from a shell session.
- Do not add managed-AI columns to the core table as a compatibility shortcut.
- Do not delete or rename historical core audit data.
- Do not combine this migration with the desktop send/runtime repair.
- Do not treat a green monitor after deployment as proof that the local Veslo
  engine lifecycle is fixed.

## Completion gate

Keep `status: proposed` and `done: false` until the implementation has:

- one explicit physical table owner per audit repository;
- a forward migration for fresh and existing installations;
- the focused contract and upgrade tests above;
- `pnpm check:services` or the applicable service quality gate passing;
- a production deployment identity and migration result recorded;
- a post-deployment monitor run without the unknown-column error.

## Local implementation evidence

- Den's managed-AI audit and alert repositories now target
  `ai_gateway_audit_event`; no managed-AI runtime SQL path targets the core
  Den `audit_event` table.
- The Den boundary test, Den managed-AI monitor tests, AI Gateway schema,
  migration-chain, and schema-reconcile tests, plus both service typechecks,
  passed on 2026-07-28. The boundary test exercises managed-AI audit and alert
  repository reads and writes, so a future core-table reference fails locally.
- The AI Gateway `0004_organization_audit_scope` migration remains the sole
  deployment path. This change introduces no second migration runner and does
  not alter, delete, or rename the core table.
