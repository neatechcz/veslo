# Settings Dashboard Link Tabs Design

## Goal

Replace the legacy Settings `Skills & MCP` tab with link-style Settings tabs for the main dashboard surfaces, while preserving the existing left menu and each page's current route, layout, refresh behavior, and implementation.

## Approved Behavior

The Settings tab bar will show:

- `General`
- `Archived`
- `Automations`
- `Soul`
- `Skills`
- `Extensions`

`General` and `Archived` remain real Settings sections rendered inside `SettingsView`.

`Automations`, `Soul`, `Skills`, and `Extensions` are navigation tabs. They look like the other Settings tabs, but clicking them leaves the Settings page and opens the same dashboard destination as clicking the matching left menu entry.

The left menu remains present, unchanged, and in its current order. There is no second copy of the Automations, Soul, Skills, or Extensions pages inside Settings.

## Removed Behavior

The current Settings `Skills & MCP` tab and its legacy extensions overview are removed from the visible Settings tab bar.

## Architecture

Keep `DashboardTab` as the source of truth for the main dashboard destinations. Keep `SettingsTab` only for Settings-owned content sections.

Add a small shared definition or local mapping for the Settings tab bar entries:

- content entries: set `settingsTab` and keep `tab` as `settings`
- link entries: call the same dashboard tab selection flow used by the left menu

This avoids duplicating page content or threading Skills/MCP page props through `SettingsView`.

## Components

- `DashboardView` owns the transition from Settings link tabs to dashboard tabs because it already owns `tab`, `setTab`, `settingsTab`, `setSettingsTab`, and session-return navigation behavior.
- `SettingsView` should either receive link-tab descriptors/callbacks or expose a callback when a non-Settings tab is selected.
- `SettingsTab` should no longer include `extensions` if it only represented the legacy `Skills & MCP` content.
- Locale labels should replace `settings.extensions` with a Settings tab label for `Skills` only if a real Settings-owned skills section exists. Under the approved design, use dashboard navigation labels for link tabs instead.

## Data Flow

Clicking `General` or `Archived`:

1. leaves `DashboardTab` as `settings`
2. updates `settingsTab`
3. renders Settings-owned content

Clicking `Automations`, `Soul`, `Skills`, or `Extensions` from the Settings tab bar:

1. calls the dashboard navigation handler with the matching `DashboardTab`
2. opens the existing dashboard page
3. uses existing page refresh effects and route behavior

## Error Handling

Invalid or removed Settings tab values should resolve to `general`.

Legacy route/state that still points at removed Settings `extensions` should fall back to `general` rather than rendering legacy overview content.

## Testing

Prefer focused app tests before broad desktop E2E because this is a navigation composition change in shared Solid UI:

- Settings tab layout test verifies the tab bar includes `General`, `Archived`, `Automations`, `Soul`, `Skills`, and `Extensions`.
- Settings tab layout test verifies `Skills & MCP`/legacy `extensions` content is not present.
- Dashboard navigation tests verify link tabs route to the same dashboard tabs as the left menu.
- Locale tests verify the visible tab labels come from existing dashboard labels where applicable.

Run `pnpm typecheck` and the relevant `@neatech/veslo-ui` unit tests after implementation. Use the real Tauri runtime only if final verification needs interactive desktop behavior.
