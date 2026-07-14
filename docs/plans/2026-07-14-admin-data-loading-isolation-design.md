# Admin Data Loading and Scope Isolation Design

**Date:** 2026-07-14
**Status:** Approved
**Scope:** The AI Gateway admin portal deployed to Veslo staging, including platform pages and explicit organization workspaces.

## Summary

The admin portal must never display realistic seed data, stale data from another page, global data inside an organization workspace, or data from a previously selected organization while a destination page is loading.

Every route will use a fail-closed loading transition. Navigation and route context remain visible, while the data surface is synchronously cleared and replaced with neutral blurred skeletons plus the existing `Loading data...` message. The destination data is revealed only after the required route-scoped requests complete and still belong to the current route generation.

Organization pages will use organization-scoped backend endpoints. In particular, Members and AI Access will stop loading the global user directory and filtering it in the browser. Global AI readiness remains visible as a background status signal but no longer blocks page-specific requests.

## Problem Statement

The deployed staging portal currently has four interacting failure modes:

1. The initial HTML contains realistic example users, alerts, audit events, metrics, and usage values. These can appear before authenticated data replaces them.
2. Several routes reuse the same DOM panels and shared arrays without clearing their previous rendered content when navigation begins.
3. Organization Members and AI Access load the global user collection and apply organization filtering only in the browser. A platform administrator can therefore see the global collection before the filtered render finishes.
4. Every route waits for the global AI readiness request before beginning its own data request. On staging, the readiness request currently takes more than five seconds, making unrelated admin pages appear slow.

The result is not only visual instability. It violates the product's organization boundary because incorrect data can remain in the DOM and accessibility tree during a route transition.

## Goals

- Remove all realistic seed data from the initial admin document.
- Clear route-owned data synchronously when navigation starts.
- Preserve the existing loading message and present a polished blurred loading surface.
- Ensure the blur covers only neutral skeletons, never previous real data.
- Make every page load and response commit route- and organization-aware.
- Use server-scoped organization endpoints instead of client-side filtering of global data.
- Decouple inference readiness from page navigation.
- Prevent late or cancelled responses from mutating the current page.
- Cover the behavior with end-to-end tests that observe every rendered frame during delayed requests.

## Non-Goals

- Replacing the static admin client with a frontend framework.
- Redesigning the overall admin information architecture.
- Changing organization roles, billing semantics, credential behavior, or the global model policy.
- Adding speculative caching that renders stale data during revalidation.
- Using blur as a privacy boundary around real data.

## Loading Experience

### What remains visible

The following chrome remains visible and stable during navigation:

- platform and organization navigation;
- page eyebrow, title, and description;
- the routed organization context header;
- the existing backend connection status surface.

### What is replaced

The destination page's data region is immediately replaced by neutral skeleton cards, rows, form shapes, or chart shapes. Skeletons contain no names, emails, IDs, counts, dates, status labels, or other realistic values.

The skeleton surface receives a subtle blur and opacity treatment. A centered `Loading data...` message appears above the skeleton. The skeleton is `aria-hidden`; the loading message is exposed as a polite status and the page region is marked `aria-busy="true"`.

The backend connection message keeps its existing responsibility: it explains whether the browser is connecting, connected, or offline. The page-local loading message explains that the destination page's data is still being prepared.

### Reveal behavior

Each page declares which responses are required. Required responses are requested in parallel where possible. The real page is revealed atomically only after all required responses succeed and the request still belongs to the current route generation.

Optional global status requests, including inference readiness, update their own indicators independently and never delay the page reveal.

### Empty and error states

- A successful response containing no records produces a deliberate empty state.
- A failed request removes the skeleton and shows an error with a Retry action.
- A `401` returns the browser to sign-in.
- A `403` renders a blank Access denied state.
- A `404` renders Organization not found for organization routes.
- An aborted request renders no error because a newer route owns the page.
- Previous data is never used as an error fallback.

## Route-Owned State

Every canonical route maps to a scope key:

```text
platform:overview
platform:organizations
platform:ai-infrastructure
platform:ai-usage
platform:ai-alerts
platform:platform-users
platform:audit
organization:<organizationId>:overview
organization:<organizationId>:members
organization:<organizationId>:domains-invites
organization:<organizationId>:billing
organization:<organizationId>:ai-access
organization:<organizationId>:audit
```

The client maintains one current page-load record:

```ts
type AdminPageLoadState = {
  key: string | null;
  generation: number;
  status: "idle" | "loading" | "ready" | "empty" | "error";
  error: string;
};
```

Starting a page load increments the generation, aborts the previous route controller, closes route-owned dialogs, clears selected records, clears route-owned data, disables route actions, and renders the loading surface.

A success or failure may commit only when its key and generation still match the current state. This rule applies to every loader, not only organization metadata, billing, and audit.

Filters may be remembered per canonical page, but no filtered results render until the current page load is ready. Selected user, credential, alert, audit event, member, and dialog state are cleared whenever their owning scope key changes.

## Backend Scope Boundaries

Client filtering is not an authorization or isolation boundary. Organization routes must use organization-scoped APIs and the server must verify the organization context.

### Members

Organization Members loads:

```text
GET /admin/api/organizations/:organizationId/members
```

It must not call the global `/admin/api/users` endpoint. The member response is adapted to the member-list view model and contains only records for the routed organization.

### AI Access

Organization AI Access first loads the same scoped member list. Selecting a member loads AI access through an organization-qualified endpoint:

```text
GET /admin/api/organizations/:organizationId/members/:userId/ai-access
PUT /admin/api/organizations/:organizationId/members/:userId/ai-access
```

Both operations verify that the administrator may access the organization and that the target user is a member of that organization. The existing unqualified AI-access read must not remain usable as an organization-scoped shortcut.

### Organization workspace

Organization Overview loads the routed organization directly. It does not fetch the entire organization directory before fetching the selected record. Domains, invites, billing, and audit use only their existing organization-qualified resources.

The platform Organizations page remains the only route that loads the full organization directory. Platform Users remains the only route that loads the full user directory.

## Page Requirements

| Route | Required data before reveal |
| --- | --- |
| Platform Overview | Credential summary, alert summary, user count, and usage summary in parallel |
| Organizations | Organization directory |
| AI Infrastructure | Credential inventory and global model policy |
| Platform Usage | Usage report and credential metadata |
| Platform Alerts | Platform alert collection |
| Platform Users | Global user directory |
| Global Audit | Platform audit events |
| Organization Overview | Routed organization record |
| Members | Routed organization member collection |
| Domains & Invites | Routed organization record, domains, and invites in parallel |
| Billing | Routed organization billing record |
| AI Access | Routed organization member collection; selected-member assignment loads inside its dialog |
| Organization Audit | Routed organization audit events |

## Performance Design

Inference readiness starts after session bootstrap and refreshes independently. It is never awaited by route loading.

The client avoids redundant directory requests inside organization workspaces. Independent required requests start concurrently. The backend connection indicator remains active while requests are in flight, but a slow optional request cannot hold the page in a loading state.

Request timing may be logged without payloads or personal data using route key, endpoint class, outcome, and duration. This makes regressions visible without leaking admin content.

## Mutation Safety

All route mutations capture the current route key and generation. Controls are disabled until the scoped record is ready. Mutation completion may update the page only if the same route generation is still active.

Switching route or organization closes all dialogs. A user, member, credential, alert, or audit dialog cannot survive into a route that does not own it.

## Accessibility

- The loading region uses `aria-busy="true"`.
- `Loading data...` uses `role="status"` and polite announcement.
- Skeletons use `aria-hidden="true"` and contain no textual content.
- Old data nodes are removed rather than visually hidden.
- Focus remains on navigation after a route change and moves to the page heading when appropriate.
- Error and access-denied states receive focus and expose a concise action.

## Verification Strategy

### State and API tests

- Starting a new route load clears prior data synchronously.
- Success and failure from an old generation cannot commit.
- Organization member APIs return only the routed organization's memberships.
- Organization AI-access reads and writes reject users outside the routed organization.
- Platform-only endpoints remain inaccessible to organization administrators.

### End-to-end browser tests

Network responses will be deliberately delayed so the transition itself can be inspected:

- Initial HTML never displays example users, alerts, audit events, chart values, or metrics.
- Platform Users to Organization Members removes every global user before the members request begins resolving.
- Organization A to Organization B never exposes A's members, domains, invites, billing, AI access, or audit.
- Late responses from an abandoned route do not change the destination page.
- A delayed readiness response does not delay route requests or page reveal.
- Organization Members and AI Access never call the global user endpoint.
- Loading, empty, error, retry, access-denied, and not-found states are distinguishable.
- Old content is absent from both visible text and the accessibility tree.

## Acceptance Criteria

- After navigation begins, no text or accessible element belonging to the previous data scope remains for even one rendered frame.
- No realistic sample data exists in the initial admin HTML.
- Organization Members and AI Access never download the global user directory.
- Every organization read and mutation is authorized against the routed organization on the server.
- Late requests cannot update another route or organization.
- Global readiness never blocks route data loading.
- The approved blurred skeleton and `Loading data...` message are shown consistently on every route.
- All existing admin route, authorization, billing, model-policy, and audit tests remain green.
