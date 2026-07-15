# Admin Portal and Global Managed-AI Model Policy Design

**Date:** 2026-07-12
**Status:** Approved
**Scope:** Admin information architecture, organization operating context, and platform-wide managed-AI model policy.

## Summary

Veslo will keep one canonical admin portal while separating its pages into two explicit operating areas:

1. **Platform administration** for system-wide operations.
2. **Organization workspace** for operations scoped to one selected organization.

Model configuration will no longer be part of an individual user's AI-access assignment. Platform administrators will configure multiple backend models under **AI Infrastructure**, select one active default model, and apply that model policy to every managed-AI user. Users will not see a model picker and cannot select or override the model.

## Goals

- Make it visually and conceptually clear whether an administrator is changing the whole platform or one organization.
- Keep organization selection out of pages that are inherently platform-wide.
- Separate commercial entitlement, technical AI access, and AI infrastructure.
- Move model ownership from per-user AI-access records to one platform-wide infrastructure policy.
- Allow multiple backend models to be configured without exposing model switching to users.
- Keep runtime model behavior deterministic for the first release of this design.

## Terminology and Ownership

### Billing and licenses

Billing and licenses determine whether an organization is commercially entitled to use Veslo Managed AI. This includes subscriptions, trials, manual access, seat limits, and billing status.

This concern belongs to the organization workspace and remains owned by DEN.

### AI access

AI access determines whether a user may use Managed AI. User-level AI access contains access state and any identity or provider authorization information required to route the request. It does not contain editable model configuration.

Billing is evaluated before AI access: a user cannot consume Managed AI when the organization lacks a valid entitlement, even if that user's AI access is enabled.

### AI infrastructure

AI infrastructure is the platform-wide technical control surface for:

- provider credentials and credential pools,
- configured backend models,
- the active default model,
- provider and model availability,
- credential and model health,
- capacity and platform-wide usage,
- routing alerts and related audit history.

This concern belongs to platform administration and remains owned by the AI Gateway.

## Admin Portal Information Architecture

The canonical admin portal has two top-level operating areas.

### Platform administration

Platform administration contains only global pages. These pages never inherit or silently depend on an active organization selection.

- **Overview** — platform health, urgent operational conditions, and system totals.
- **Organizations** — organization directory and entry point into an organization workspace.
- **AI Infrastructure** — credentials, providers, backend models, active default model, capacity, health, platform usage, and routing alerts.
- **Platform users and roles** — platform-level identities and platform administrator permissions.
- **Global audit** — platform-wide security and operational events.

### Organization workspace

The organization workspace is entered by selecting an organization from the organization directory or by switching organization inside the workspace itself.

Every organization page shows a persistent context header such as `Operating organization: <name>`. The organization selector is available only within this workspace.

- **Overview** — organization identity, status, and relevant totals.
- **Members and roles** — organization membership and organization-scoped roles.
- **Domains and invitations** — admission policy, domains, and pending invitations.
- **Billing and licenses** — subscription, trial, entitlement, seat limits, and billing actions.
- **AI access** — user-level Managed-AI enablement and blocking, without model controls.
- **Organization audit** — events scoped to the active organization.

## Global Model Policy

### Configuration

AI Infrastructure supports a platform-managed list of enabled backend models. Each configured model is associated with the provider or credential capability required to serve it.

Exactly one enabled model is the **active default model**. All managed-AI requests use that model unless an internal infrastructure failure prevents it.

Other enabled models are retained as backend configuration so platform administrators can validate them and deliberately promote one to active default later. Their presence does not create a user-facing choice and does not by itself enable automatic routing.

### User experience

- The installed Veslo application shows no model picker for Managed AI.
- Users cannot choose, switch, or override the active model.
- User settings describe Managed AI as administrator-managed without exposing model configuration.
- The user AI-access editor contains no default-model or allowed-model fields.
- Read-only diagnostic views may report the model that actually served a request, but must not present it as a user preference.

### Administrator experience

The AI Infrastructure model area allows a platform administrator to:

- view configured backend models and their provider/credential compatibility,
- add or enable supported backend models,
- disable a non-active model,
- select one enabled, healthy model as the active default,
- see model health or incompatibility before activation,
- review an audit trail of model-policy changes.

An active model cannot be disabled until another valid model has been selected as the active default.

### Runtime behavior

For this phase, model routing is intentionally deterministic:

1. The request passes organization billing entitlement checks.
2. The request passes user AI-access checks.
3. The AI Gateway resolves the current platform active default model.
4. The gateway selects an eligible credential capable of serving that model.
5. The request is sent using the resolved model.

The backend does not select a model based on task type, user identity, organization, session, or user preference.

## Credential and Model Separation

Credentials and models remain related but are not the same configuration:

- A **credential** proves that Veslo can access a provider or runtime.
- A **model** is an enabled backend capability available through one or more eligible credentials.
- The **active default model** is the single model used for all Managed-AI requests.

Credential rotation may select another compatible credential without changing the active model. A credential that cannot serve the active model is not eligible for requests using that model.

## Data Ownership and Migration

The AI Gateway becomes the authority for the global model policy. DEN continues to own organization entitlement and identity data.

Existing per-user model fields must no longer be treated as runtime authority. During migration:

1. Establish a valid global active default before switching runtime resolution.
2. Stop writing default-model and allowed-model values from user administration.
3. Change runtime resolution to use the global model policy after entitlement and user-access checks.
4. Preserve historical per-user values only as migration/audit data until they can be safely removed.
5. Remove obsolete model controls and model-choice state from admin and installed-app surfaces.

Migration must not infer different global behavior from conflicting historical user settings. The initial active default is an explicit platform-administrator decision.

## Failure Handling

- **No active default:** Managed-AI sends are blocked with an administrator-action-required error. Veslo must not guess a model.
- **Active model unhealthy or unsupported:** Sends fail clearly and AI Infrastructure raises an operational alert. Automatic switching to another model is out of scope for this phase.
- **No compatible healthy credential:** Sends fail with a credential/capacity error while preserving the configured active model.
- **Organization not entitled:** The request remains blocked by billing before model resolution.
- **User AI access disabled:** The request remains blocked by access policy before model resolution.
- **Attempt to request another model:** The gateway ignores no override silently; it rejects unauthorized model overrides or normalizes only internal calls that omitted a model to the active default.

## Permissions and Audit

- Only platform administrators may manage backend models or change the active default.
- Organization administrators may manage organization AI access only to the extent already allowed by product policy; they cannot configure models.
- End users have read-only effective AI availability and no model controls.
- Adding, enabling, disabling, or activating a model creates a global audit event with actor, timestamp, previous state, and new state.

## Alternatives Considered

### Per-user model policy

Rejected. It makes user administration responsible for infrastructure decisions, creates inconsistent behavior across users, and increases support and migration complexity.

### Platform-approved models with user switching

Deferred. It would preserve centralized governance but still expose model choice and require product rules for model capabilities, cost, persistence, and session behavior.

### Automatic task-based routing or fallback

Deferred. Automatic routing may be useful later, but it introduces non-deterministic behavior and needs explicit policies for quality, cost, data handling, availability, and auditability.

## Non-Goals

- User-facing or organization-specific model selection.
- Per-session model persistence.
- Automatic task classification and model routing.
- Automatic failover from the active model to a different model.
- Redesigning billing calculations or subscription products.
- Merging DEN and AI Gateway service ownership.
- Creating a second admin portal.

## Verification Requirements

### Admin portal

- Platform pages never expose or depend on an active organization selector.
- Organization pages always show explicit organization context.
- Switching organization affects only organization-workspace data.
- Organization-scoped authorization continues to prevent cross-organization access.

### Model administration

- Multiple backend models can be configured.
- Exactly one enabled model is active.
- An unhealthy, unsupported, or disabled model cannot become active.
- The active model cannot be disabled without a valid replacement.
- Model-policy changes are recorded in global audit history.

### User and runtime behavior

- User administration contains no model fields.
- The installed desktop app contains no Managed-AI model picker or override.
- Two users with AI access resolve the same active default model.
- Organization billing and user-access failures occur before model resolution.
- Requests cannot select a non-active model through client-supplied model values.
- Real desktop E2E verification proves that a Managed-AI send uses the platform active default in the Tauri runtime.

## Future Extension Point

The enabled backend model list intentionally leaves room for later routing policies. A future approved design may add controlled fallback, workload-based routing, or organization-level tiers. None of those behaviors are implied by the initial global model policy.
