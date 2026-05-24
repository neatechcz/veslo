# Titlebar Nonselectable Text Design

## Goal

Prevent the text labels in the custom titlebar from becoming selected when users grab the titlebar to move the window.

## Scope

The affected labels are the app name, the session state label, and the project or location label shown in the centered session titlebar context. Buttons, tooltips, and existing drag-region behavior stay unchanged.

## Approach

Use CSS selection prevention on only the textual titlebar labels. This keeps the change local to the display text that interferes with window dragging and avoids changing hit testing or runtime session state.

## Alternatives Considered

- Apply non-selection styling to the whole titlebar. This is simpler but risks affecting future interactive content in the shared chrome.
- Cancel selection through pointer or selection JavaScript. This is more fragile and unnecessary for static labels.

## Testing

Add a focused source-level test that requires non-selection styling on the titlebar brand and centered titlebar content, then run the focused unit test and the app typecheck.
