# Sidebar CTA Width Balance Design

## Goal

Correct the top rail sizing after the overflow button tweak so `New session` returns to its original content-driven width, `Add directory / project` becomes the only expanding CTA, and the directory icon reads more prominently than before.

## Approved Direction

- `New session` should stay visually unchanged and stop stretching.
- `Add directory / project` should remain the only wide CTA in the row.
- `More actions` stays a compact circular icon button.
- `FolderPlus` should be larger than the `Plus` icon in `New session`, and larger than the previous follow-up size.

## Testing Scope

- Update the layout source-contract test to assert:
  - `New session` is no longer wrapped in a `flex-1` container.
  - `Add directory / project` remains the expanding middle CTA.
  - `More actions` remains compact.
  - `FolderPlus` is larger than `Plus`.
- Re-run the focused sidebar rail tests after the implementation.
