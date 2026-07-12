# Organization Audit Integrity and Model-Policy Load Safety Design

## Goal

Make the organization audit workspace truthful across DEN-owned and AI Gateway-owned changes, and prevent stale platform-model-policy loads from replacing newer or dirty browser state.

## Audit ownership and flow

DEN remains authoritative for organization, billing, member, domain, and invite mutations. It exposes a narrow authenticated admin endpoint for one authorized organization. The query filters by organization in SQL, orders newest first, applies a bounded limit, and returns a secret-free event projection.

AI Gateway stops emitting duplicate local events for DEN-owned mutations. Its organization-audit route fetches DEN events and Gateway-local organization-scoped events, fails closed if either source is unavailable, labels each source, assigns a stable composite identifier, merges newest first, and applies the final hard limit after merging.

Gateway-owned AI-access mutations are allowed only from the canonical Organization AI Access workspace. The routed organization must be authorized and match the target user's DEN membership, and the actor comes from the authenticated admin session. Fallible response preparation completes before policy persistence and audit persistence are coupled transactionally; the route must not report success if required audit persistence fails.

## Browser load safety

Platform model-policy loading owns an AbortController and a monotonically increasing request generation. A completion may update state only when it is the latest request, the route is still AI Infrastructure, and the draft has not become dirty since the load began. Navigation and sign-out abort outstanding work.

## Verification

Tests cover DEN authorization, server-side organization filtering, order, limit, and secret-free output; Gateway source labeling, stable IDs, merge order, hard limit, duplicate removal, and partial-source failure; real actor and audit failure behavior for AI-access updates; and executable browser regressions for stale, aborted, navigated, and dirty model-policy loads.
