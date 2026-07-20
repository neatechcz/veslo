# Admin Module Routing Regression Design

**Date:** 2026-07-20
**Status:** Approved
**Scope:** AI Gateway Admin Den static JavaScript delivery through the authenticated Gateway router.

## Summary

The Admin Den entry module imports a new page-load state module, but the protected `/admin/*` shell route does not recognize that module as a static asset. The Gateway therefore returns the HTML shell with a successful status for the JavaScript URL, and the browser refuses to load the module because the MIME type is HTML.

Keep the existing authenticated shell/static boundary and add the missing module to the static-asset classification. Add a real Gateway HTTP regression that discovers every relative JavaScript module imported by the Admin entry module, requests each one through the actual Express route stack, and proves that each response is JavaScript rather than the HTML shell.

## Chosen Approach

1. Extend the explicit Admin asset allowlist with the page-load state module.
2. Exercise the production route order through `createApp` and an ephemeral loopback HTTP server.
3. Read the served Admin entry module, discover its relative static imports, and request each import through `/admin/...`.
4. Require a successful response, a JavaScript MIME type, and a non-HTML body for every discovered import.

This keeps the protected shell behavior unchanged and makes future entry-module imports fail the test automatically if their route classification is omitted.

## Alternatives Rejected

- Moving static middleware before the protected shell route would broaden the routing and authentication behavior beyond this repair.
- Adding compatibility aliases or restoring old API routes would not fix the module MIME failure and would weaken the intended architecture.
- Testing only the new module path explicitly would repair today's omission but would allow the same class of mistake on the next imported module.

## Verification

- Confirm the new HTTP regression fails before the production change because one imported module returns HTML.
- Apply the one-line route classification fix and confirm the focused regression passes.
- Run the complete AI Gateway test suite and TypeScript build.
- Probe the module through a live ephemeral Gateway and verify JavaScript content type and body.
- Run the repository quality command when available on this branch and report any branch-level tooling gap accurately.

## Non-Goals

- No desktop application API changes.
- No backward-compatibility endpoints or aliases.
- No changes to model-policy ownership or organization API scope.
- No staging deployment or branch integration.
