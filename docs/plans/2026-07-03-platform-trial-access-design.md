# Platform Trial Access Design

## Goal

Add a platform-admin-only way to grant temporary trial access to an organization without creating a Stripe subscription. The trial uses the same billing workspace and license inputs as paid checkout so the operator can create a trial with the same Basic and Extended seat quantities they would otherwise sell.

## Decisions

- The feature is called `Platform trial` in platform-admin controls.
- Organization admins see `Trial access`.
- Only platform admins can create, edit, or revoke trials.
- A trial always has an explicit end date.
- Trial seats use the existing Basic and Extended quantity inputs.
- Trial grant/edit can include an optional note if the UI can fit it without making the form noisy.
- A trial cannot be created for an organization that already has a Stripe subscription configured.
- An organization can start Stripe Checkout during an active trial.
- When Stripe subscription entitlement becomes active, Den disables the trial immediately and Stripe becomes the sole entitlement source.
- Revoking or expiring a trial behaves like unpaid access with no grace period.

## User Experience

Platform admins use the existing organization billing workspace:

- Select an organization in the platform billing view.
- Enter Basic and Extended license quantities in the same controls used for checkout.
- Set `Trial ends on`.
- Click `Create trial`.
- If a trial is active, the same controls allow editing quantities and end date; the primary action becomes `Save trial`.
- A `Revoke trial` action is available for active trials.
- `Start checkout` remains available for paid Stripe setup.

The UI should not create a separate trial form that duplicates the billing plan UI. The core interaction is: choose the same licenses as checkout, set an end date, then create the trial instead of redirecting to Stripe.

Organization admins do not see platform trial controls. If a trial is active, their billing summary shows:

- `Trial access is active`
- trial end date
- trial seat count
- checkout remains available so the organization can buy during the trial

## Backend And Data Flow

The feature builds on the existing organization billing account model:

- `mode: "manual_access"`
- `source: "manual_trial"`
- `status: "active"`
- quantities from the shared Basic and Extended license inputs
- `manualAccess.enabled: true`
- `manualAccess.expiresAt: <trial end date>`

Trial grant and edit go through the platform billing update path. The backend remains authoritative and must reject:

- non-platform-admin callers
- trial creation while a Stripe subscription is configured
- missing or past trial end dates
- zero, negative, fractional, or insufficient seat counts

Trial revoke disables manual access and removes the trial entitlement. It must not create a grace period.

Stripe purchase during a trial follows normal checkout. When Stripe webhook processing links or activates the subscription, Den clears the active trial fields so Stripe becomes the entitlement source. If payment later fails, the expired/cleared trial is not a fallback.

## Error Handling

Client-side validation catches obvious form errors:

- missing end date
- end date in the past
- no licenses selected
- invalid license counts

Backend errors should remain stable:

- `platform_admin_required`
- `stripe_subscription_exists`
- `invalid_manual_access_expires_at`
- `invalid_billing_quantities`
- `requested_license_limit_below_active_users`

The billing action status area shows failures without changing the visible billing state. Successful create, edit, or revoke reloads the selected organization billing summary.

## Testing

Backend tests:

- platform admin can create and edit a trial
- organization admin cannot create a trial
- trial grant is rejected when a Stripe subscription exists
- invalid end date and invalid quantities are rejected
- trial expiry and revoke block Managed AI without grace
- active Stripe subscription webhook clears trial access

UI tests:

- platform admin creates trial from the same Basic/Extended billing controls
- platform admin edits trial seats and end date
- platform admin revokes trial
- organization admin sees trial access but not platform controls
- organization admin can still start Stripe Checkout during trial
- trial create is disabled or rejected for an organization with Stripe subscription configured

