# Czech Localization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a complete Czech UI localization, keep Chinese for compatibility, and hide Chinese from visible language selectors.

**Architecture:** The app already centralizes locale registration in `packages/app/src/i18n/index.ts` and stores translation maps as flat key-value modules in `packages/app/src/i18n/locales/`. The implementation will add a full `cs` locale, keep `zh` in the runtime translation map for compatibility, restrict the visible language list to `en` and `cs`, and add a script-based parity check that compares locale keys against English.

**Tech Stack:** SolidJS app package, TypeScript, Node.js script checks, pnpm workspace.

---

### Task 1: Add a failing locale parity test

**Files:**
- Create: `packages/app/scripts/i18n-parity.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

Create a Node script that:
- loads `packages/app/src/i18n/locales/en.ts`
- expects `packages/app/src/i18n/locales/cs.ts` to exist
- compares English and Czech key sets
- exits non-zero and prints missing/extra keys when Czech is absent or incomplete

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:i18n`
Expected: FAIL because `src/i18n/locales/cs.ts` does not exist yet.

**Step 3: Write minimal implementation**

Add the package script entry only after the parity script exists.

**Step 4: Run test to verify it still fails for the right reason**

Run: `pnpm --filter @neatech/veslo-ui test:i18n`
Expected: FAIL with Czech locale missing or parity mismatch, not a script crash.

**Step 5: Commit**

```bash
git add packages/app/scripts/i18n-parity.mjs packages/app/package.json
git commit -m "test: add locale parity check"
```

### Task 2: Add the Czech locale

**Files:**
- Create: `packages/app/src/i18n/locales/cs.ts`
- Reference: `packages/app/src/i18n/locales/en.ts`

**Step 1: Write the failing test**

Use the parity test from Task 1 as the failing test.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:i18n`
Expected: FAIL because `cs.ts` is missing or incomplete.

**Step 3: Write minimal implementation**

Create `cs.ts` with the full English key set translated into Czech. Keep brand and product terms in English where required: `Veslo`, `OpenCode`, `MCP`, `Skills`, `Plugins`, and `OpenPackage` where it appears as a product name.

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui test:i18n`
Expected: PASS with zero missing or extra Czech keys.

**Step 5: Commit**

```bash
git add packages/app/src/i18n/locales/cs.ts
git commit -m "feat: add Czech locale"
```

### Task 3: Wire Czech into the app and hide Chinese from the picker

**Files:**
- Modify: `packages/app/src/i18n/index.ts`
- Modify: `packages/app/src/i18n/locales/index.ts`

**Step 1: Write the failing test**

Extend the parity script or use targeted assertions to require:
- `Language` support includes `cs`
- the visible `LANGUAGE_OPTIONS` list contains `en` and `cs`
- `zh` remains available in the translation map for stored preferences

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:i18n`
Expected: FAIL because locale wiring still exposes `zh` and does not register `cs`.

**Step 3: Write minimal implementation**

Update locale imports, `Language`, `LANGUAGES`, `LANGUAGE_OPTIONS`, and `TRANSLATIONS` so:
- runtime supports `en`, `zh`, `cs`
- visible selector options expose only `en` and `cs`

**Step 4: Run test to verify it passes**

Run: `pnpm --filter @neatech/veslo-ui test:i18n`
Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/i18n/index.ts packages/app/src/i18n/locales/index.ts
git commit -m "feat: wire Czech locale and hide Chinese selector"
```

### Task 4: Verify the app package and document residual risk

**Files:**
- No new files required unless follow-up notes are needed

**Step 1: Run focused verification**

Run:
- `pnpm --filter @neatech/veslo-ui test:i18n`
- `pnpm --filter @neatech/veslo-ui typecheck`

Expected:
- locale parity test passes
- typecheck may still fail on the pre-existing `local-file-path.impl.js` declaration issue

**Step 2: Inspect language picker references**

Run: `rg -n "LANGUAGE_OPTIONS|type Language =|TRANSLATIONS" packages/app/src/i18n packages/app/src/app/pages/settings.tsx packages/app/src/app/components/language-picker-modal.tsx`
Expected: only `en` and `cs` appear in visible picker data; `zh` remains in the translation map.

**Step 3: Commit**

```bash
git add packages/app/package.json packages/app/scripts/i18n-parity.mjs packages/app/src/i18n/index.ts packages/app/src/i18n/locales/index.ts packages/app/src/i18n/locales/cs.ts
git commit -m "feat: ship Czech localization"
```
