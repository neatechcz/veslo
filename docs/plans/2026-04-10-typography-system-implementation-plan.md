# Typography System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ship a self-hosted typography system for Veslo that makes chat and reading-heavy surfaces more readable, gives product chrome a consistent branded tone, and keeps technical text visually compatible across the desktop app.

**Architecture:** Introduce self-hosted open-source fonts and a centralized typography contract in CSS, then migrate the app from implicit inheritance and local font overrides to explicit semantic roles: reading, product, and mono. Use CSS custom properties plus shared utility classes for the contract, wire Tailwind `font-sans` and `font-mono` to the new stacks, then update the highest-impact surfaces first: editor/forms, session/chat, and core shell pages.

**Tech Stack:** SolidJS, TailwindCSS v4-style CSS utilities, CodeMirror, `node:test`, Tauri desktop runtime, WebdriverIO, Docker dev stack, Chrome MCP via `@openwork-docker-chrome-mcp`, Solid patterns via `@solidjs-patterns`.

---

### Task 1: Sync Main And Create A Dedicated Worktree

**Files:**
- None. Repo state only.

**Step 1: Sync the repo and submodules**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
git fetch --all --prune --recurse-submodules
git checkout main
git pull --ff-only
git submodule update --init --recursive
```

Expected: `main` matches the remote tip and submodules are initialized.

**Step 2: Create the isolated feature worktree**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo
git worktree add ../Veslo-typography-system -b codex/typography-system origin/main
```

Expected: a clean worktree exists at `/Users/vaclavsoukup/AI agent projects/Veslo-typography-system`.

**Step 3: Verify the new worktree is clean**

Run:

```bash
git -C /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system status --short
```

Expected: no output.

**Step 4: Commit**

No commit. This task only prepares the execution environment.

### Task 2: Add Self-Hosted Font Assets And The Central Typography Contract

**Files:**
- Create: `packages/app/public/fonts/source-sans-3/SourceSans3-Regular.woff2`
- Create: `packages/app/public/fonts/source-sans-3/SourceSans3-Semibold.woff2`
- Create: `packages/app/public/fonts/ibm-plex-sans/IBMPlexSans-Regular.woff2`
- Create: `packages/app/public/fonts/ibm-plex-sans/IBMPlexSans-Medium.woff2`
- Create: `packages/app/public/fonts/ibm-plex-sans/IBMPlexSans-SemiBold.woff2`
- Create: `packages/app/public/fonts/ibm-plex-mono/IBMPlexMono-Regular.woff2`
- Create: `packages/app/public/fonts/ibm-plex-mono/IBMPlexMono-Medium.woff2`
- Create: `packages/app/src/styles/typography.css`
- Create: `packages/app/src/styles/typography-contract.test.ts`
- Modify: `packages/app/src/app/index.css`
- Modify: `packages/app/tailwind.config.ts`

**Step 1: Write the failing typography contract test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const typography = readFileSync(new URL("./typography.css", import.meta.url), "utf8");
const indexCss = readFileSync(new URL("../app/index.css", import.meta.url), "utf8");
const tailwind = readFileSync(new URL("../../tailwind.config.ts", import.meta.url), "utf8");

test("index.css imports the centralized typography contract", () => {
  assert.match(indexCss, /@import "\.\.\/styles\/typography\.css";/);
});

test("typography contract defines reading, product, and mono font variables", () => {
  assert.match(typography, /--veslo-font-reading:/);
  assert.match(typography, /--veslo-font-product:/);
  assert.match(typography, /--veslo-font-mono:/);
  assert.match(typography, /font-family:\s*"Source Sans 3"/);
  assert.match(typography, /font-family:\s*"IBM Plex Sans"/);
  assert.match(typography, /font-family:\s*"IBM Plex Mono"/);
});

test("typography contract defines shared semantic utilities and scale tokens", () => {
  assert.match(typography, /@utility font-reading/);
  assert.match(typography, /@utility font-product/);
  assert.match(typography, /@utility type-reading-md/);
  assert.match(typography, /@utility type-title-md/);
  assert.match(typography, /--veslo-type-reading-md:/);
  assert.match(typography, /--veslo-type-ui-sm:/);
});

test("tailwind maps sans and mono to the Veslo font variables", () => {
  assert.match(tailwind, /fontFamily:/);
  assert.match(tailwind, /sans:\s*\["var\(--veslo-font-product\)"/);
  assert.match(tailwind, /mono:\s*\["var\(--veslo-font-mono\)"/);
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/app
pnpm exec node --test --import=tsx/esm src/styles/typography-contract.test.ts
```

Expected: FAIL because `typography.css`, font files, and the new Tailwind/font mappings do not exist yet.

**Step 3: Write the minimal implementation**

- Add self-hosted WOFF2 files under `packages/app/public/fonts/**`.
- Create `packages/app/src/styles/typography.css` with:
  - `@font-face` declarations using `font-display: swap`
  - `--veslo-font-reading`, `--veslo-font-product`, `--veslo-font-mono`
  - scale tokens such as `--veslo-type-ui-sm`, `--veslo-type-reading-md`, `--veslo-type-title-lg`
  - semantic utilities such as `font-reading`, `font-product`, `type-ui-sm`, `type-ui-md`, `type-reading-md`, `type-title-sm`, `type-title-md`, `type-title-lg`
- Import `../styles/typography.css` from `packages/app/src/app/index.css`.
- Switch `body` to `font-family: var(--veslo-font-product)`.
- Update `packages/app/tailwind.config.ts` so `font-sans` resolves to `var(--veslo-font-product)` and `font-mono` resolves to `var(--veslo-font-mono)`.

Representative contract:

```css
:root {
  --veslo-font-reading: "Source Sans 3", ui-sans-serif, system-ui, sans-serif;
  --veslo-font-product: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
  --veslo-font-mono: "IBM Plex Mono", ui-monospace, monospace;
  --veslo-type-ui-sm: 0.8125rem;
  --veslo-type-ui-md: 0.875rem;
  --veslo-type-reading-md: 0.9375rem;
  --veslo-type-title-md: 1.5rem;
}

@utility font-reading { font-family: var(--veslo-font-reading); }
@utility font-product { font-family: var(--veslo-font-product); }
@utility type-reading-md { font-size: var(--veslo-type-reading-md); line-height: 1.6; }
@utility type-title-md { font-size: var(--veslo-type-title-md); line-height: 1.2; font-weight: 600; }
```

**Step 4: Run the test to verify it passes**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/app
pnpm exec node --test --import=tsx/esm src/styles/typography-contract.test.ts
```

Expected: PASS for imported contract, semantic utilities, and Tailwind font mappings.

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system
git add packages/app/public/fonts packages/app/src/styles/typography.css packages/app/src/styles/typography-contract.test.ts packages/app/src/app/index.css packages/app/tailwind.config.ts
git commit -m "feat(app): add typography contract and self-hosted fonts"
```

### Task 3: Migrate Shared Controls And The Markdown Editor To Semantic Typography Roles

**Files:**
- Create: `packages/app/src/app/components/shared-typography.test.ts`
- Modify: `packages/app/src/app/components/live-markdown-editor.tsx`
- Modify: `packages/app/src/app/components/button.tsx`
- Modify: `packages/app/src/app/components/text-input.tsx`

**Step 1: Write the failing shared-typography test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(new URL("./live-markdown-editor.tsx", import.meta.url), "utf8");
const button = readFileSync(new URL("./button.tsx", import.meta.url), "utf8");
const textInput = readFileSync(new URL("./text-input.tsx", import.meta.url), "utf8");

test("markdown editor no longer hard-codes the Inter stack", () => {
  assert.doesNotMatch(editor, /Inter, ui-sans-serif/);
  assert.match(editor, /var\(--veslo-font-reading\)/);
});

test("shared button uses the product font and semantic ui sizing", () => {
  assert.match(button, /font-product/);
  assert.match(button, /type-ui-md/);
});

test("text input separates label chrome from reading text", () => {
  assert.match(textInput, /font-product type-ui-xs/);
  assert.match(textInput, /font-reading type-ui-md/);
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/app
pnpm exec node --test --import=tsx/esm src/app/components/shared-typography.test.ts
```

Expected: FAIL because these components still use ad hoc typography and the editor still hard-codes `Inter`.

**Step 3: Write the minimal implementation**

- Update the CodeMirror theme in `live-markdown-editor.tsx` to use `var(--veslo-font-reading)`.
- Normalize editor line/body sizes to `type-reading-md` semantics instead of a one-off `14px` stack.
- Update `button.tsx` so the base class uses `font-product type-ui-md`.
- Update `text-input.tsx` so:
  - labels use `font-product type-ui-xs`
  - input text uses `font-reading type-ui-md`
  - hint text stays on a semantic small UI size

Representative change:

```ts
const base =
  "font-product type-ui-md inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 ...";
```

```ts
".cm-scroller": {
  fontFamily: "var(--veslo-font-reading)",
},
```

**Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/app
pnpm exec node --test --import=tsx/esm src/app/components/shared-typography.test.ts
pnpm typecheck
```

Expected: PASS for shared typography contract checks and TypeScript.

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system
git add packages/app/src/app/components/shared-typography.test.ts packages/app/src/app/components/live-markdown-editor.tsx packages/app/src/app/components/button.tsx packages/app/src/app/components/text-input.tsx
git commit -m "feat(app): align shared controls with typography system"
```

### Task 4: Migrate Session And Reading-Heavy Surfaces

**Files:**
- Create: `packages/app/src/app/components/session/session-typography.test.ts`
- Modify: `packages/app/src/app/components/session/message-list.tsx`
- Modify: `packages/app/src/app/components/session/composer.tsx`
- Modify: `packages/app/src/app/components/part-view.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`

**Step 1: Write the failing session typography test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const messageList = readFileSync(new URL("./message-list.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
const sessionPage = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const partView = readFileSync(new URL("../part-view.tsx", import.meta.url), "utf8");

test("chat message bubbles use reading typography instead of dense ui typography", () => {
  assert.match(messageList, /font-reading/);
  assert.match(messageList, /type-reading-md/);
});

test("technical detail blocks stay mono and compact", () => {
  assert.match(messageList, /font-mono/);
  assert.match(messageList, /type-ui-xs/);
});

test("composer and markdown content use reading typography", () => {
  assert.match(composer, /font-reading/);
  assert.match(partView, /font-reading/);
});

test("session page headings use product title styles", () => {
  assert.match(sessionPage, /font-product/);
  assert.match(sessionPage, /type-title-sm|type-title-md/);
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/app
pnpm exec node --test --import=tsx/esm src/app/components/session/session-typography.test.ts
```

Expected: FAIL because the session surface still uses `text-[14px] font-medium`, ad hoc small labels, and local typography decisions.

**Step 3: Write the minimal implementation**

- In `message-list.tsx`, move assistant and user message content to `font-reading type-reading-md`.
- Keep attachment metadata and technical disclosure rows on `font-product type-ui-xs` or `font-mono type-ui-xs` depending on meaning.
- In `composer.tsx`, make the prompt input and related readable text use the reading role, while chips/buttons stay on the product role.
- In `part-view.tsx`, use reading typography for markdown paragraphs/headings and mono only for code/diff sections.
- In `session.tsx`, convert the empty state and page-level titles to `font-product type-title-*`.

Representative bubble target:

```tsx
block.isUser
  ? "font-reading type-reading-md max-w-[80%] px-5 py-3 rounded-[24px] ..."
  : "font-reading type-reading-md max-w-[960px] ..."
```

**Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/app
pnpm exec node --test --import=tsx/esm src/app/components/session/session-typography.test.ts
pnpm exec node --test --import=tsx/esm src/app/components/session/message-list-path-layout.test.ts
pnpm typecheck
```

Expected: PASS for typography role adoption, existing message-list layout contracts, and TypeScript.

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system
git add packages/app/src/app/components/session/session-typography.test.ts packages/app/src/app/components/session/message-list.tsx packages/app/src/app/components/session/composer.tsx packages/app/src/app/components/part-view.tsx packages/app/src/app/pages/session.tsx
git commit -m "feat(app): apply typography system to session surfaces"
```

### Task 5: Normalize Shell Chrome, Dense Pages, And Technical Text Usage

**Files:**
- Create: `packages/app/src/app/pages/app-shell-typography.test.ts`
- Modify: `packages/app/src/app/components/session/sidebar.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/pages/mcp.tsx`
- Modify: `packages/app/src/app/pages/onboarding.tsx`

**Step 1: Write the failing shell typography test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebar = readFileSync(new URL("../components/session/sidebar.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");
const onboarding = readFileSync(new URL("./onboarding.tsx", import.meta.url), "utf8");

test("shell titles and nav chrome use product typography roles", () => {
  assert.match(sidebar, /font-product/);
  assert.match(dashboard, /font-product/);
  assert.match(settings, /type-title-sm|type-title-md/);
  assert.match(onboarding, /type-title-md|type-title-lg/);
});

test("dense shell metadata uses semantic small sizes instead of ad hoc 10px\/11px hotspots", () => {
  assert.match(sidebar, /type-ui-xs/);
  assert.match(settings, /type-ui-xs/);
});

test("technical diagnostics remain mono while labels stop using mono decoratively", () => {
  assert.match(settings, /font-mono/);
  assert.doesNotMatch(dashboard, /font-mono[\s\S]*Skills/);
});
```

**Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/app
pnpm exec node --test --import=tsx/esm src/app/pages/app-shell-typography.test.ts
```

Expected: FAIL because the shell still uses many raw `text-[10px]`, `text-[11px]`, `font-sans`, and decorative mono patterns.

**Step 3: Write the minimal implementation**

- In `sidebar.tsx` and `dashboard.tsx`, migrate titles, nav labels, and empty states to `font-product` plus semantic `type-*` utilities.
- In `settings.tsx`, keep diagnostics/endpoints/IDs on `font-mono`, but move labels and surrounding chrome to product/UI roles.
- In `skills.tsx`, `mcp.tsx`, and `onboarding.tsx`, replace repeated hard-coded tiny text and title sizes in the primary headers and section labels with semantic `type-*` utilities.
- Remove only obvious decorative mono usage during this pass; leave truly technical strings on `font-mono`.

Representative header target:

```tsx
<h2 class="font-product type-title-md text-dls-text">{translate("skills.title")}</h2>
```

**Step 4: Run the tests to verify they pass**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/app
pnpm exec node --test --import=tsx/esm src/app/pages/app-shell-typography.test.ts
pnpm exec node --test --import=tsx/esm src/app/pages/dashboard-sidebar-navigation-layout.test.ts
pnpm exec node --test --import=tsx/esm src/app/pages/session-sidebar-navigation-layout.test.ts
pnpm typecheck
```

Expected: PASS for shell typography adoption, existing navigation layout contracts, and TypeScript.

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system
git add packages/app/src/app/pages/app-shell-typography.test.ts packages/app/src/app/components/session/sidebar.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/settings.tsx packages/app/src/app/pages/skills.tsx packages/app/src/app/pages/mcp.tsx packages/app/src/app/pages/onboarding.tsx
git commit -m "feat(app): normalize typography across shell pages"
```

### Task 6: Add Desktop Runtime Typography Regression Coverage

**Files:**
- Create: `packages/e2e/specs/typography.spec.ts`
- Modify: `packages/e2e/specs/visual-regression.spec.ts`

**Step 1: Write the failing WebdriverIO typography spec**

```ts
import { expect } from "@wdio/globals";
import { navigateToHash } from "../helpers/app-launcher.js";

describe("Typography system", () => {
  it("exposes the expected font families via CSS variables", async () => {
    await navigateToHash("/dashboard/settings");

    const families = await browser.execute(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        reading: style.getPropertyValue("--veslo-font-reading"),
        product: style.getPropertyValue("--veslo-font-product"),
        mono: style.getPropertyValue("--veslo-font-mono"),
      };
    });

    expect(families.reading).toContain("Source Sans 3");
    expect(families.product).toContain("IBM Plex Sans");
    expect(families.mono).toContain("IBM Plex Mono");
  });
});
```

**Step 2: Run the spec to verify it fails**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/e2e
pnpm test --spec ./specs/typography.spec.ts
```

Expected: FAIL because the CSS variables are not present yet or still point to the old typography setup.

**Step 3: Write the minimal implementation**

- Add `packages/e2e/specs/typography.spec.ts`.
- Extend `visual-regression.spec.ts` so it continues to cover `settings`, `skills`, and `session` after typography changes.
- If needed for selector stability, add minimal non-user-facing `data-typography-role` hooks during implementation rather than brittle DOM traversal.

**Step 4: Run the specs to verify they pass**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo/packages/e2e
pnpm test --spec ./specs/typography.spec.ts
pnpm test --spec ./specs/visual-regression.spec.ts
```

Expected: PASS, with WebDriver attaching to an existing compatible app on `http://127.0.0.1:4445/status` if available.

**Step 5: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system
git add packages/e2e/specs/typography.spec.ts packages/e2e/specs/visual-regression.spec.ts
git commit -m "test(e2e): add typography desktop regression coverage"
```

### Task 7: Run Full Verification, Docker Gate, Chrome MCP Review, And Save Screenshots

**Files:**
- Create: `docs/plans/assets/typography-system/session.png`
- Create: `docs/plans/assets/typography-system/settings.png`
- Create: `docs/plans/assets/typography-system/skills.png`
- Create: `docs/plans/assets/typography-system/onboarding.png`
- Create: `docs/plans/assets/typography-system/README.md`

**Step 1: Run the focused app test suite**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/app
pnpm exec node --test --import=tsx/esm src/styles/typography-contract.test.ts
pnpm exec node --test --import=tsx/esm src/app/components/shared-typography.test.ts
pnpm exec node --test --import=tsx/esm src/app/components/session/session-typography.test.ts
pnpm exec node --test --import=tsx/esm src/app/pages/app-shell-typography.test.ts
pnpm typecheck
```

Expected: PASS for all typography contract tests and typecheck.

**Step 2: Build and verify the desktop runtime**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system/packages/e2e
pnpm test --spec ./specs/session.spec.ts
pnpm test --spec ./specs/typography.spec.ts
pnpm test --spec ./specs/visual-regression.spec.ts
```

Expected: PASS in the real Tauri runtime. Do not substitute a web-only run.

**Step 3: Start the Veslo Docker dev stack**

Run:

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system
packaging/docker/dev-up.sh
```

Expected: local supporting services start cleanly for end-to-end verification.

**Step 4: Use Chrome MCP to review the impacted flows**

Use `@openwork-docker-chrome-mcp` from `.opencode/skills/openwork-docker-chrome-mcp/SKILL.md`.

Review:

- session/chat readability
- settings density and diagnostics readability
- skills and MCP page heading/label hierarchy
- onboarding copy/title hierarchy if touched during implementation

If no browser-backed flow is materially affected, record that explicitly in the verification notes and keep the real Tauri runtime as the authoritative gate.

**Step 5: Save screenshots into the repo**

- Capture screenshots from the validated runtime state.
- Save them under `docs/plans/assets/typography-system/`.
- Add a short `README.md` describing what each screenshot proves.

**Step 6: Final verification summary**

Write `docs/plans/assets/typography-system/README.md` with:

- exact commands run
- pass/fail result
- whether WebDriver reused a running app or launched a new one
- whether Docker and Chrome MCP succeeded
- any remaining visual tuning notes

**Step 7: Commit**

```bash
cd /Users/vaclavsoukup/AI\ agent\ projects/Veslo-typography-system
git add docs/plans/assets/typography-system
git commit -m "docs: add typography verification artifacts"
```
