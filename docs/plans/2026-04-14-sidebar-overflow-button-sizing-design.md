# Sidebar Overflow Button Sizing Design

## Goal

Tighten the top rail hierarchy in the workspace session sidebar by making the `More actions` control a compact round icon button, letting `Add directory / project` expand into the freed space, and increasing the `FolderPlus` icon so it reads as more prominent than the `Plus` icon in `New session`.

## Approved Direction

- Keep `New session` visually unchanged.
- Keep `Add directory / project` as the middle text CTA, but let it occupy more width than it does today.
- Change `More actions` from a full-width third CTA to a compact round icon button.
- Increase the `FolderPlus` icon so it is visibly larger than the `Plus` icon on `New session`.

## Layout Rules

- The control rail stays on one row.
- `New session` remains a standard pill button.
- `Add directory / project` remains a standard pill button and uses the extra horizontal space.
- `More actions` becomes a fixed-size round icon button aligned with the same height as the other controls.
- The overflow menu behavior and accessible labeling stay unchanged.

## Testing Scope

- Update the source-contract layout test to assert the new compact `More actions` wrapper/button structure.
- Update the same test to assert that `FolderPlus` renders larger than `Plus`.
- Re-run the focused sidebar source-contract tests after implementation.
