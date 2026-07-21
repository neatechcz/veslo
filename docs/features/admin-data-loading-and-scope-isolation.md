# Admin Data Loading and Scope Isolation

This document defines the shipped loading, request ownership, and data-scope
contract for the standalone AI Gateway admin portal. It applies to the static
admin shell at `/admin`, including platform pages and organization workspaces.

The central rule is fail closed: a destination route does not render previous,
sample, global, or other-organization data while its own required data is being
loaded. Route chrome may remain visible, but the route-owned data surface is
cleared synchronously and becomes usable only after the current route
generation settles.

## Canonical route scopes

Every supported admin route has a canonical scope key. The organization id is
part of every organization key, so the same subpage in two organizations is
still two different data scopes.

| Route | Scope key |
| --- | --- |
| `/admin` | `platform:overview` |
| `/admin/organizations` | `platform:organizations` |
| `/admin/ai-infrastructure` | `platform:ai-infrastructure` |
| `/admin/ai-infrastructure/usage` | `platform:ai-usage` |
| `/admin/ai-infrastructure/alerts` | `platform:ai-alerts` |
| `/admin/platform-users` | `platform:platform-users` |
| `/admin/audit` | `platform:audit` |
| `/admin/organizations/:organizationId/overview` | `organization:<organizationId>:overview` |
| `/admin/organizations/:organizationId/members` | `organization:<organizationId>:members` |
| `/admin/organizations/:organizationId/domains-invites` | `organization:<organizationId>:domains-invites` |
| `/admin/organizations/:organizationId/billing` | `organization:<organizationId>:billing` |
| `/admin/organizations/:organizationId/ai-access` | `organization:<organizationId>:ai-access` |
| `/admin/organizations/:organizationId/audit` | `organization:<organizationId>:audit` |

Platform routes never retain an organization id. Organization routes always
carry the routed organization id in both the URL and the scope key.

## Organization-administration delegation invariant

Every administration operation available to an organization administrator is
also available to a platform administrator when the platform administrator has
explicitly selected and routed into the target organization. This is capability
delegation, not identity impersonation:

- both roles use the same organization-scoped operation, validation, and data
  boundary;
- the organization id must be explicit in the route and server request;
- a platform administrator does not need a membership in the target
  organization, but the server must independently verify the platform role;
- audit records preserve the real actor user id, the target organization id,
  and whether the operation was performed via `organization_admin` or
  `platform_admin` authority;
- platform pages do not mutate organization-owned state, and organization pages
  do not load a global directory and filter it in the browser.

This invariant applies to current and future organization administration
domains, including members, domains and invites, billing, AI access, audit, and
organization-managed skills. Platform-only controls may be added alongside an
organization workspace, but they must not replace or fork the organization
administrator's canonical operation.

## Page-load state

The client owns one current page-load record with a canonical key, a
monotonically increasing generation, a status, and a safe display error. The
durable statuses are:

- `loading`: the previous route state has been cleared, the neutral loading
  surface is visible, and route actions are locked;
- `ready`: all required data succeeded for the current generation and real
  route content was revealed atomically;
- `empty`: the required requests succeeded and the current route's explicit
  empty predicate matched, so a deliberate page-level empty state is rendered;
- `error`: the current generation failed and no previous data is used as a
  fallback.

`idle` is an internal state used before a valid route starts and when an
aborted generation no longer owns the page. In normal navigation, the next
valid generation immediately owns the destination in `loading` state.

Starting a route load happens before route rendering or route requests. It:

1. increments the page generation and aborts the previous route controller;
2. closes route-owned dialogs and clears selected records;
3. clears route-owned arrays, summaries, and editor state;
4. disables route actions;
5. renders the fail-closed loading surface;
6. starts the required destination requests, in parallel where possible.

A completion may commit only when its scope key and generation still match the
current page-load record. Aborted, late, or superseded responses are inert.

## Loading presentation

Navigation, the destination title and description, organization context, and
the backend connection indicator remain visible during a load. The data region
shows neutral shape-only skeletons with the existing `Loading data...` status.

The skeleton surface is subtly blurred and is hidden from the accessibility
tree. The loading status is announced politely, and the page state carries
`aria-busy="true"`. Real records are removed from the DOM before the loading
surface is painted; blur is a presentation treatment for neutral skeletons,
not a privacy boundary around previously loaded data.

When the current generation settles, `aria-busy` becomes false and the page
atomically reveals either real data, an intentional empty state, or an error.
Empty classification is route-specific rather than a generic check that every
returned collection contains a row. The outcomes are distinct:

- a successful result that matches the route's empty predicate renders the
  page-level empty state;
- a network failure or retryable backend failure renders `Unable to load data`
  with Retry;
- `401` clears the admin session and returns to sign-in;
- `403` renders a blank, non-retryable `Access denied` state;
- `404` on an organization route renders a blank, non-retryable
  `Organization not found` state;
- an aborted request renders no error because it no longer owns the page.

Previous data is never an empty-state or error fallback.

Page-level `empty` currently applies to an empty platform organization, alert,
user, audit, or usage result; AI Infrastructure without credentials or a saved
model policy; organization Members or AI Access without members; Billing
without a billing record; and Organization Audit without events. Platform and
Organization Overview settle `ready` after their required records succeed.
Domains & Invites also settles `ready` after its required requests succeed,
even when domains or invites are empty; each section renders its own empty
message. Other `ready` pages may likewise render an empty subsection without
changing the whole page to `empty`.

## Directory and organization boundaries

Global directories are platform data and are not organization-workspace data:

- Platform Organizations may load the full organization directory.
- Platform Users may load the full user directory.
- Platform Overview may load the global user collection only to derive its
  platform-wide user count.
- Organization Overview loads the routed organization directly.
- Organization Members and Organization AI Access load only the routed
  organization's member collection.
- Other organization subpages use only organization-qualified domains,
  invites, billing, audit, or organization resources.

No organization page may download a global directory and filter it in the
browser. Client-side filtering is neither an authorization boundary nor an
acceptable loading-state boundary.

The organization member collection is served through:

```text
GET    /admin/api/organizations/:organizationId/members
POST   /admin/api/organizations/:organizationId/members
PATCH  /admin/api/organizations/:organizationId/members/:membershipId
DELETE /admin/api/organizations/:organizationId/members/:membershipId
```

The server verifies that the admin may access the routed organization. Member
updates use the membership id from that scoped response; a mismatched member or
user response cannot publish success and forces a scoped refresh.

## Organization-qualified AI access

Organization AI Access first loads the routed organization's member list.
The UI invokes assignment reads and writes from the canonical Organization AI
Access workspace and uses only these endpoints:

```text
GET /admin/api/organizations/:organizationId/members/:userId/ai-access
PUT /admin/api/organizations/:organizationId/members/:userId/ai-access
```

Server authorization is independent of the browser route or referrer. Before
either operation reaches the Gateway-owned assignment repository, the server
requires the managed-AI admin capability, access to the organization named in
the API path, a valid scoped member response, and exactly one active membership
for the target user in that organization. Missing, inactive, duplicate, or
malformed membership evidence fails closed.

The former unqualified routes below are removed and must not be used by the
admin UI, helpers, scripts, or new integrations:

```text
GET /admin/api/users/:userId/ai-access
PUT /admin/api/users/:userId/ai-access
```

Requests to those legacy API paths receive the normal JSON API `404`; they do
not fall through to the admin HTML shell.

AI-access administration owns only the `enabled` toggle. Provider,
`credentialId`, model, redemption, and other routing fields are derived by the
Gateway and rejected when supplied in user AI-access writes. Backend model and
credential management belongs under AI Infrastructure: platform administrators
may enable multiple backend models but select exactly one active model for all
managed-AI users. Users cannot choose or switch models.

## Required route data and readiness

Real route content is revealed only after the current route's required data is
complete. Independent requirements start concurrently. Examples include:

- Platform Overview: credentials, alerts, global user count, and usage;
- AI Infrastructure: credentials and the global model policy;
- Domains & Invites: routed organization, domains, and invites;
- AI Access: routed organization and scoped members, with an individual
  assignment loaded only after a member is selected;
- Organization Audit: the routed organization's merged scoped audit stream.

Inference readiness is background-only. It starts independently after session
bootstrap, updates only its own status signal, and is never awaited before a
route request or route reveal. A slow or failed readiness probe therefore
cannot hold Organizations, Members, Billing, or another admin page in loading.

## Mutation ownership

Every asynchronous admin mutation captures both the canonical route and the
current page generation. Its completion may update status, close a dialog,
redirect, change selection, or render data only while that same route
generation remains current. Changing route, changing organization, refreshing
the same route into a newer generation, or signing out therefore invalidates
pending route-owned work.

AI-access loads and saves add a member-selection identity guard: organization
id, user id, membership id, selected user, page key, and page generation must
still match. Selecting another AI Access member therefore makes the older
member's completion inert. This additional selection rule is specific to the
implemented AI-access flow; selecting a different credential, alert, domain,
invite, or other entity does not by itself promise to invalidate every pending
operation for that entity. Those operations retain the route/page-generation
guard and any operation-specific checks they implement.

Route actions remain locked until the scoped page is `ready` or `empty`, and
sensitive values such as credential secrets or upload commands are cleared when
their owning route scope changes.

## No-stale-frame acceptance rule

The isolation guarantee applies to every rendered transition frame and to
user-exposed visible and accessibility-semantic content. From the initiating
navigation event until the destination settles:

- no old page or old organization record may remain in visible text;
- no old record may remain in exposed accessible names, labels, values, live
  regions, or selected controls;
- no realistic sample content may come from the initial HTML;
- no late response may restore user-exposed data, status, selection, or an open
  dialog owned by an abandoned scope;
- no organization Members or AI Access transition may request the global user
  directory.

The browser isolation suite uses delayed responses and frame-level plus DOM
mutation observation to enforce this rule. Its negative controls must also
prove that the observer detects both visible and exposed semantic-only leaks.
The observer intentionally skips descendants of closed, hidden,
`aria-hidden`, inert, `display: none`, or `visibility: hidden` regions. Internal
form values in such non-exposed dialog content are outside this frame-level
observer contract unless production explicitly clears them; closing a dialog
alone does not prove that every internal field was erased.
