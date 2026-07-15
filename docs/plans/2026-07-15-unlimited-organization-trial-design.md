# Unlimited Organization Trial Design

## Goal

Give every Veslo organization a revocable, unlimited platform trial for Managed AI until the commercial billing policy is changed. The trial has no Veslo-defined expiration, seat cap, or token cap. Managed-AI usage continues to be recorded, and upstream provider capacity and rate limits still apply.

The behavior applies to all existing organizations during migration and to every newly created organization. A paid Stripe subscription remains authoritative and replaces the platform trial when Stripe reports active or trialing subscription evidence.

## Non-goals

- Removing usage accounting or upstream provider limits.
- Bypassing organization context, user enablement, model policy, credential eligibility, or other Managed-AI controls.
- Replacing Stripe billing or changing product prices.
- Granting a platform trial over an already configured Stripe subscription.

## State model

Unlimited access is represented explicitly on the organization billing account:

- mode: `manual_access`
- source: `manual_trial`
- status: `trialing`
- manual access enabled: `true`
- manual access unlimited: `true`
- manual access expiry: `null`
- license quantities: zero, because unlimited access is not a synthetic seat purchase

A dedicated `manual_access_unlimited` boolean is added instead of treating a missing expiry as unlimited by itself or storing a sentinel seat count. Existing finite platform trials continue to use `manual_access_unlimited=false`, a future expiry, and explicit license quantities.

Entitlement responses expose both `isUnlimited` and a nullable `licenseLimit`. Unlimited access returns `isUnlimited=true` and `licenseLimit=null`; finite and paid access keep a numeric license limit.

## Existing organizations

The Den migration inserts an unlimited trial billing account for organizations that do not have one. Existing billing accounts without a Stripe subscription are converted to the unlimited trial state. Accounts with a configured Stripe subscription are preserved because Stripe billing has already replaced trial access.

The migration is idempotent through the existing unique organization billing-account constraint and deterministic update conditions.

## New organizations

The canonical personal-organization creation path inserts the organization, owner membership, and unlimited billing account in one database transaction. This ensures a successfully created organization is immediately entitled without a window where Managed AI returns `payment_required`.

Existing organizations discovered by the idempotent default-organization helper are not overwritten at runtime; the migration owns historical backfill and Stripe remains authoritative.

## Admin behavior

The billing API serializes the unlimited flag. Platform-admin updates accept `manualAccess.unlimited` and enforce these rules:

- an unlimited platform trial must have no expiry and needs no seat quantity;
- a finite platform trial still requires a future expiry and enough licenses;
- a platform trial cannot be granted over a configured Stripe subscription;
- revocation clears enabled, unlimited, and expiry fields and blocks access immediately;
- Stripe activation clears the unlimited trial flag together with all other manual-trial fields.

The admin UI labels this state `Unlimited trial`, renders licenses and remaining capacity as `Unlimited`, does not require an end date or seat count to create it, and retains an explicit revoke action.

## Safety and observability

The change is an organization billing entitlement, not a gateway-wide bypass. Requests still traverse authenticated session, Den entitlement, user assignment, global model policy, credential selection, and provider execution. Usage recording remains unchanged.

Production rollout uses the repository-owned deployment workflow, which runs database migrations before health verification. After deployment, verification must prove:

1. every non-Stripe organization has the unlimited trial state;
2. a real existing organization receives `canUseManagedAi=true`;
3. a newly created organization receives the default unlimited trial;
4. a managed inference request passes the former 402 entitlement gate and returns a provider response;
5. usage for that request is recorded.

## Testing

Primary coverage is an end-to-end admin billing lifecycle scenario for unlimited display, creation, and revocation. Supporting Den tests cover schema/migration backfill, entitlement derivation, repository mapping, admin validation and serialization, Stripe handoff, and transactional default-organization creation.
