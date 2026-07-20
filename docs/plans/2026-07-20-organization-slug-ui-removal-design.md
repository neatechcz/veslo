# Organization Slug UI Removal Design

## Status

Approved on 2026-07-20.

## Goal

Remove the organization slug from the AI Gateway admin UI so neither platform admins nor organization admins can view, enter, or change it. Keep slug storage and API compatibility on the cloud backend.

## Scope

- Change only the AI Gateway admin UI and its tests.
- Do not change the Veslo desktop application, `veslo-server`, DEN behavior, database schema, or public API contracts.
- Keep existing organization slugs intact and available internally to cloud services.

## UI Behavior

- Remove the slug input from the organization overview form.
- Do not render slug values in the organization directory or organization selector.
- Change organization search and selector copy so it refers only to the organization name or ID.
- Prefer the organization name for visible labels, with the organization ID as the fallback.
- Saving an organization must omit `slug` from the PATCH payload. Platform admins can still save the name and seat limit; organization admins can still save the name.
- Unsaved-change detection must compare only editable fields visible to the current role.

## Backend Compatibility

The backend organization model and PATCH endpoint continue accepting and returning `slug`. This preserves compatibility for existing integrations and internal routing. The admin browser must neither expose nor mutate that field.

## Verification

- Source-level UI tests assert that no slug input or visible slug copy remains and that organization saves omit the field.
- Browser-level tests cover the organization overview as both platform admin and organization admin.
- Existing AI Gateway tests, type checking, and the relevant Playwright admin suite must pass.
