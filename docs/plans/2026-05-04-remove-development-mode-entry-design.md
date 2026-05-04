# Remove Development Mode Entry Design

## Goal

Remove every user-facing path that can put the Veslo application into developer mode.

## Context

Developer mode is currently an in-memory SolidJS signal initialized to `false`. The Settings screen exposes a general-tab control that toggles the signal, and several dashboard/settings/session surfaces gate diagnostics, advanced navigation, config views, and debug details on that signal.

The app does not appear to persist `developerMode` today, but tests and diagnostics still reference an old `veslo.developerMode` storage key. Direct dashboard navigation to developer-only surfaces is already guarded by the runtime signal.

## Chosen Approach

Keep the developer-mode internals as disabled runtime gates, but remove the ability to turn the gate on from the application.

This means:

- Remove the Settings card/button that toggles Developer Mode.
- Remove the `toggleDeveloperMode` prop plumbing from app to dashboard to settings.
- Keep `developerMode` permanently false in normal app state.
- Ensure stale stored state and URL/deep-link/search parameters do not enable developer mode.
- Update unit and E2E tests that currently assert the toggle exists.

## Alternatives Considered

Hiding only the Settings button is simpler, but it leaves unnecessary toggle prop plumbing and makes bypass paths harder to reason about.

Deleting all developer-mode-gated diagnostic code is broader than the request and higher risk because diagnostic internals are still useful as disabled support code and for future controlled debugging.

## Testing

Use TDD with focused app tests first:

- A Settings source/layout test should assert the Developer Mode entry controls are absent.
- A settings tab helper/navigation test should assert developer-only tabs are not visible even when called with a truthy legacy flag.
- A dashboard navigation test should assert the config route falls back when developer mode cannot be entered.
- E2E navigation should stop clicking the toggle and instead verify the UI no longer offers it.

Then run the relevant app checks from the testing playbook, starting with typecheck and focused unit tests.
