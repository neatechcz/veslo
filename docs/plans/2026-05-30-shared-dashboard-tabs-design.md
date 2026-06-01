# Shared Dashboard Tabs Design

## Goal

Make the Settings tab rail available on every dashboard destination it links to, not only on Settings.

## Current State

Settings renders its own local tab rail with `General`, `Archived`, `Automations`, `Soul`, `Skills`, and `Extensions`.
The dashboard pages reached by those link tabs still render their normal page content without the same rail, so a user can navigate from Settings to Automations, Skills, or Extensions and then lose the contextual tab navigation.

## Design

Extract the tab rail into a shared component owned by the dashboard shell.
The rail exposes:

- Settings-owned tabs: `General`, `Archived`
- dashboard link tabs: `Automations`, `Soul`, `Skills`, `Extensions`

The component receives the active dashboard tab, active Settings tab, and two callbacks:

- `onOpenSettingsTab(tab)` for `General` and `Archived`
- `onOpenDashboardTab(tab)` for `Automations`, `Soul`, `Skills`, and `Extensions`

Settings uses the component with the active Settings tab highlighted.
Automations, Soul, Skills, and Extensions use the same component with their dashboard tab highlighted.

Left-menu navigation remains unchanged. These tabs are additional links to the same destinations, not duplicate pages or nested Settings content.

## Testing

Use source-level tests to verify:

- Settings imports and renders the shared tab rail instead of owning a private copy.
- Dashboard non-Settings pages render the shared tab rail above page content.
- The rail keeps the order `General`, `Archived`, `Automations`, `Soul`, `Skills`, `Extensions`.
- Dashboard tab clicks still route through the existing dashboard selection handler.

Keep the existing E2E selector contract on the tab buttons so desktop specs can continue to exercise the rail.
