# Settings Tabs in Developer Mode Design

## Summary

Restore all existing but currently hidden Settings subsections when developer mode is enabled.

## Current Problem

- The Settings page still renders `model` and `advanced` sections.
- Dashboard and session flows still navigate to `advanced`.
- The visibility helper and tab list now hide both tabs, so developer-mode navigation silently falls back to `general`.

## Desired Behavior

- Non-developer mode shows only `general` and `archived`.
- Developer mode shows `general`, `archived`, `model`, `advanced`, and `debug`.
- Existing navigation to `openSettings("advanced")` lands on the actual `advanced` tab instead of falling back to `general`.

## Implementation Notes

- Restore the developer-mode tab contract in the shared settings tab visibility helper.
- Restore the same tab set in the Settings tab list UI.
- Update tests so they assert developer mode exposes the hidden tabs again.
- Update canonical feature docs because this is shipped Settings behavior.
