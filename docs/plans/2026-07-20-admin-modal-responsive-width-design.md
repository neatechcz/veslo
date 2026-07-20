# Responsive Admin Modal Width Design

**Date:** 2026-07-20
**Status:** Approved

## Goal

Keep every canonical admin modal within the available window width without horizontal scrolling. The user editor remains wider than the detail dialogs when space is available, and its form reflows responsively when the window narrows.

## Runtime boundary

DEN does not serve its legacy `public-admin` frontend. DEN `/admin` page traffic redirects to the canonical AI Gateway admin, and the legacy DEN frontend contains no modal dialogs. The responsive modal work therefore belongs to the AI Gateway admin and covers its domain, invite, credential, alert, user, and audit dialogs.

## Root cause

The shared dialog shell is limited to 760 pixels while the user editor's inner card requests 920 pixels. The wider child overflows the narrower dialog. In addition, the user form switches from two columns to one based on a broad page-level breakpoint, making the modal taller even when the dialog itself still has enough room for two columns.

## Considered approaches

1. **Shared responsive modal contract — selected.** Make the dialog shell own width, constrain it to the viewport, and make its card fill the shell. Add a wide shell variant for the user editor and reflow the form at a modal-appropriate narrow breakpoint. This fixes the structural cause and protects all dialogs.
2. **Synchronize the two fixed widths.** Increasing the shared dialog width to match the user card would fix the current mismatch but remain fragile when future modal variants are added.
3. **Restructure every modal.** Adding new header, body, and footer wrappers would allow more extensive scrolling behavior, but it is unnecessary for this width-only defect and would increase regression risk.

## Design

- The shared modal shell uses border-box sizing and can never exceed the viewport minus a consistent edge gutter.
- The normal shell keeps the existing detail-dialog measure. A wide modifier on the user dialog increases its preferred width without exceeding the viewport.
- Modal cards use the shell's available width, have no independent preferred width, and allow grid children to shrink.
- Horizontal modal overflow is prevented by construction rather than hidden as a symptom.
- The user editor keeps two columns while its available width supports them and switches to one column only at the narrow modal breakpoint.
- Existing vertical overflow behavior, actions, focus, close behavior, and data workflows remain unchanged.

## Verification

A browser-level regression test will open every canonical admin dialog at representative desktop, compact-window, and mobile widths. It will assert that each dialog and card stays within the viewport and has no horizontal scroll range. The user editor will additionally be checked for two-column layout at a suitable width and one-column layout when narrow.

Focused AI Gateway tests and the repository quality gate will run after the browser regression passes.

## Out of scope

- Reviving or redesigning DEN's unmounted legacy admin frontend.
- Changing modal data, actions, vertical scrolling, or visual styling beyond responsive width behavior.
- Altering the desktop app's separate SolidJS modal system.
