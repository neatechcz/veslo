# Czech Localization Design

**Date:** 2026-03-07

**Goal:** Add a complete Czech app localization while keeping the existing Chinese locale in the codebase for compatibility, but hiding Chinese from the language picker.

## Context

The app-level i18n system lives in `packages/app/src/i18n/`. Locale registration, validation, persistence, and the language picker all flow from the central definitions in `index.ts`.

Today the app exposes English and Chinese in the UI. The requested change is:

- Add Czech as a complete translation.
- Keep Chinese in the repository and runtime for compatibility with upstream merges and existing stored preferences.
- Remove Chinese from the visible language list for new selections.

## Decision

Use a compatibility-preserving model:

- Keep `zh` in the internal `Language` union and translation map.
- Add `cs` as a first-class locale.
- Restrict `LANGUAGE_OPTIONS` to `en` and `cs` so Chinese is hidden in the settings and modal pickers.

This gives a clean user-facing result without making upstream i18n merges harder or breaking installs that already persist `openwork.language = "zh"`.

## Translation Rules

Use English as the canonical key source.

Translate all user-facing copy into Czech except these terms, which remain in English:

- `OpenWork`
- `OpenCode`
- `MCP`
- `Skills`
- `Plugins`

Other technical or product wording should be translated when it is natural and user-facing.

## Compatibility Behavior

- Existing users with stored locale `zh` continue to receive Chinese translations.
- New users can only select English or Czech from the UI.
- No migration from `zh` to `cs` is required.

## Implementation Outline

1. Add `packages/app/src/i18n/locales/cs.ts` with complete Czech translations.
2. Update locale wiring in `packages/app/src/i18n/index.ts` to register `cs` while keeping `zh`.
3. Update `packages/app/src/i18n/locales/index.ts` to export `cs`.
4. Add a parity verification script so Czech keys stay aligned with English.
5. Keep the UI picker components unchanged except through the central `LANGUAGE_OPTIONS` data.

## Verification

Verification should cover:

- Locale key parity between `en` and `cs`.
- TypeScript type safety for the app package.
- Manual confirmation that settings only show English and Czech.

## Out of Scope

- Server-side locale negotiation.
- Runtime auto-detection of the browser language.
- Copy rewrites beyond the Czech translation itself.
