# Czech Primary Flow Localization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove remaining hardcoded English from the main user-facing Veslo flows and ensure Czech users see localized copy on the primary session, Soul, sidebar, composer, and inbox surfaces.

**Architecture:** Keep English as the source locale, add any missing translation keys to the locale catalogs, and switch primary-flow components to use the existing `i18n` helpers instead of inline strings. Preserve the existing English markdown command templates for functional behavior, and add locale-aware fallback quickstart prompt bodies for Czech so user-visible prompts are translated without changing the default command payload files.

**Tech Stack:** SolidJS, existing `packages/app/src/i18n` locale catalogs, Node-based repo guard scripts, TypeScript.

---

### Task 1: Add a failing primary-flow localization guard

**Files:**
- Create: `packages/app/scripts/primary-flow-localization.mjs`
- Modify: `packages/app/package.json`

**Step 1: Write the failing test**

Create a guard script that reads the primary user-facing files and asserts they do not contain the currently leaked English strings:
- `packages/app/src/app/pages/session.tsx`
- `packages/app/src/app/pages/soul.tsx`
- `packages/app/src/app/components/session/composer.tsx`
- `packages/app/src/app/components/session/workspace-session-list.tsx`
- `packages/app/src/app/components/session/inbox-panel.tsx`

The assertions should cover the known visible leaks, including quickstart cards, choose-folder copy, Soul labels, workspace/session chrome, and inbox labels.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/veslo-ui test:primary-localization`

Expected: FAIL because the current files still contain hardcoded English strings.

**Step 3: Wire the test command**

Add `"test:primary-localization": "node scripts/primary-flow-localization.mjs"` to `packages/app/package.json`.

**Step 4: Re-run the guard**

Run: `pnpm --filter @neatech/veslo-ui test:primary-localization`

Expected: still FAIL until implementation lands.

### Task 2: Localize the main session entry flow

**Files:**
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`

**Step 1: Add missing session keys**

Add locale keys for:
- empty-state session setup card
- quickstart card titles/descriptions
- search toolbar labels/buttons
- session menu actions
- earlier message loading labels
- command palette labels/help
- run status/toast labels that are currently hardcoded and user-visible

**Step 2: Run locale parity test if keys are added**

Run: `pnpm --filter @neatech/veslo-ui test:i18n`

Expected: PASS after both English and Czech catalogs contain the same keys.

**Step 3: Switch `session.tsx` to `t(...)`**

Add the i18n import/helper and replace hardcoded user-facing strings with locale keys, including:
- `Start a new session`
- `New session`
- `What do you want to do?`
- `Pick a starting point...`
- browser/Soul quickstart card copy
- search actions and labels
- session menu items
- permission modal copy
- command palette labels and navigation hints
- visible toasts and run labels in the main session flow

**Step 4: Keep quickstart command files stable**

Do not rewrite the raw markdown template files used as English command templates. Instead, add locale-aware fallback prompt body text in `session.tsx` for Czech users.

**Step 5: Run the primary guard**

Run: `pnpm --filter @neatech/veslo-ui test:primary-localization`

Expected: session-related assertions now pass.

### Task 3: Localize composer, workspace list, inbox, and Soul page

**Files:**
- Modify: `packages/app/src/app/components/session/composer.tsx`
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/components/session/inbox-panel.tsx`
- Modify: `packages/app/src/app/pages/soul.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`

**Step 1: Add missing locale keys**

Add locale keys for:
- composer choose-folder/workspace labels, slash search labels, attachment labels, agent/thinking menus, send/stop titles
- workspace sidebar actions and empty states
- inbox upload/refresh/empty-state copy
- Soul headers, cards, buttons, status labels, placeholders, cadence labels, and guidance text

**Step 2: Replace hardcoded copy in each component**

Use `t(...)` with the current locale inside each component/page. Keep existing behavior unchanged; only replace user-visible text.

**Step 3: Re-run the primary guard**

Run: `pnpm --filter @neatech/veslo-ui test:primary-localization`

Expected: PASS with no remaining known English leaks in the audited primary-flow files.

### Task 4: Verification

**Files:**
- No additional code changes expected

**Step 1: Run locale parity**

Run: `pnpm --filter @neatech/veslo-ui test:i18n`

Expected: PASS

**Step 2: Run the primary localization guard**

Run: `pnpm --filter @neatech/veslo-ui test:primary-localization`

Expected: PASS

**Step 3: Run targeted UI guard regression**

Run: `pnpm --filter @neatech/veslo-ui test:local-ui-guards`

Expected: PASS after the guard is updated for localized primary-flow copy.

**Step 4: Run a targeted typecheck**

Run: `pnpm --filter @neatech/veslo-ui typecheck`

Expected: PASS
