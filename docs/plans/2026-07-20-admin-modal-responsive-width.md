# Responsive Admin Modal Width Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every canonical AI Gateway admin modal fit the available window width without horizontal scrolling, with the user editor reflowing from two columns to one on narrow windows.

**Architecture:** Keep the change inside the canonical AI Gateway admin. Move preferred width ownership from inner cards to the dialog shell, add a wide shell modifier for the user editor, and make every card fill its shell. Prove the behavior with a Chromium geometry test that loads the real admin HTML and CSS and opens all six dialogs across multiple viewport widths.

**Tech Stack:** HTML, CSS, TypeScript, Playwright, Node.js HTTP test server, pnpm

---

### Task 1: Add a failing browser regression for modal width

**Files:**
- Create: `packages/e2e/specs/ai-gateway-admin-modal-responsive.playwright.spec.ts`

**Step 1: Create a static admin test server and geometry helpers**

Create the Playwright spec with a local server that serves the real AI Gateway admin HTML and CSS without requiring authentication or backend data:

```ts
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SPEC_DIR, '../../..');
const ADMIN_PUBLIC_ROOT = join(REPO_ROOT, 'services/ai-gateway/public-admin');
const MODAL_IDS = [
  'organization-domain-modal',
  'organization-invite-modal',
  'credential-detail-modal',
  'alert-detail-modal',
  'user-editor-modal',
  'audit-detail-modal',
] as const;

let adminServer: { origin: string; server: Server };

test.beforeAll(async () => {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === '/admin' || pathname === '/admin/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(await readFile(join(ADMIN_PUBLIC_ROOT, 'index.html')));
      return;
    }
    if (pathname === '/admin/app.css') {
      response.setHeader('content-type', 'text/css; charset=utf-8');
      response.end(await readFile(join(ADMIN_PUBLIC_ROOT, 'app.css')));
      return;
    }
    if (pathname === '/admin/app.js') {
      response.setHeader('content-type', 'application/javascript; charset=utf-8');
      response.end('');
      return;
    }
    response.statusCode = 404;
    response.end('Not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  adminServer = { origin: `http://127.0.0.1:${port}`, server };
});

test.afterAll(async () => {
  adminServer.server.close();
  await once(adminServer.server, 'close');
});

async function openAdmin(page: Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await page.goto(`${adminServer.origin}/admin`);
}
```

**Step 2: Add the viewport containment test**

For desktop, compact, and mobile widths, open each real dialog in turn and assert that the shell and card stay inside the viewport and have no horizontal scroll range:

```ts
for (const width of [1280, 900, 720, 390]) {
  test(`all admin modals fit a ${width}px window without horizontal scrolling`, async ({ page }) => {
    await openAdmin(page, width);

    for (const modalId of MODAL_IDS) {
      const modal = page.locator(`#${modalId}`);
      await modal.evaluate((node: HTMLDialogElement) => node.showModal());

      const geometry = await modal.evaluate((node) => {
        const shell = node.getBoundingClientRect();
        const cardNode = node.querySelector('.modal-card');
        if (!(cardNode instanceof HTMLElement)) throw new Error('Modal card is missing');
        const card = cardNode.getBoundingClientRect();
        return {
          viewportWidth: window.innerWidth,
          shellLeft: shell.left,
          shellRight: shell.right,
          shellClientWidth: node.clientWidth,
          shellScrollWidth: node.scrollWidth,
          cardLeft: card.left,
          cardRight: card.right,
          cardClientWidth: cardNode.clientWidth,
          cardScrollWidth: cardNode.scrollWidth,
        };
      });

      expect(geometry.shellLeft, modalId).toBeGreaterThanOrEqual(0);
      expect(geometry.shellRight, modalId).toBeLessThanOrEqual(geometry.viewportWidth);
      expect(geometry.shellScrollWidth, modalId).toBeLessThanOrEqual(geometry.shellClientWidth);
      expect(geometry.cardLeft, modalId).toBeGreaterThanOrEqual(geometry.shellLeft);
      expect(geometry.cardRight, modalId).toBeLessThanOrEqual(geometry.shellRight);
      expect(geometry.cardScrollWidth, modalId).toBeLessThanOrEqual(geometry.cardClientWidth);

      await modal.evaluate((node: HTMLDialogElement) => node.close());
    }
  });
}
```

**Step 3: Add the user-editor reflow test**

Assert that the form uses two columns in a compact desktop window and one column in a narrow window:

```ts
test('user editor reflows only when the modal becomes narrow', async ({ page }) => {
  await openAdmin(page, 900);
  const editor = page.locator('#user-editor-modal .user-editor');
  await page.locator('#user-editor-modal').evaluate((node: HTMLDialogElement) => node.showModal());
  expect((await editor.evaluate((node) => getComputedStyle(node).gridTemplateColumns)).split(' ')).toHaveLength(2);

  await page.locator('#user-editor-modal').evaluate((node: HTMLDialogElement) => node.close());
  await openAdmin(page, 720);
  await page.locator('#user-editor-modal').evaluate((node: HTMLDialogElement) => node.showModal());
  expect((await editor.evaluate((node) => getComputedStyle(node).gridTemplateColumns)).split(' ')).toHaveLength(1);
});
```

**Step 4: Run the regression and verify RED**

Run:

```bash
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/ai-gateway-admin-modal-responsive.playwright.spec.ts
```

Expected: FAIL. At wide and compact desktop widths, `user-editor-modal` has a scroll width larger than its client width because the 920-pixel card is inside the 760-pixel shell. The 900-pixel reflow assertion also reports one column instead of two.

Do not change production code until both failures are observed for these expected reasons.

### Task 2: Make the shared modal contract responsive

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.css`
- Test: `packages/e2e/specs/ai-gateway-admin-modal-responsive.playwright.spec.ts`

**Step 1: Move the wide modifier to the dialog shell**

Change the user dialog markup from:

```html
<dialog id="user-editor-modal" class="modal-shell">
  <div class="modal-card modal-card-wide">
```

to:

```html
<dialog id="user-editor-modal" class="modal-shell modal-shell-wide">
  <div class="modal-card">
```

No other modal markup changes.

**Step 2: Make the shell own preferred width and the card fill it**

Update the shared modal CSS:

```css
.modal-shell {
  --modal-preferred-width: 760px;
  width: min(var(--modal-preferred-width), calc(100vw - 32px));
  max-height: calc(100vh - 32px);
  max-height: calc(100dvh - 32px);
  padding: 0;
  overflow-x: hidden;
  overflow-y: auto;
  border: 0;
  background: transparent;
  color: var(--text);
}

.modal-shell-wide {
  --modal-preferred-width: 920px;
}

.modal-card {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 16px;
  /* retain the existing visual declarations */
}
```

Delete the old `.modal-card-wide` width rule. Do not hide a remaining oversized card merely to satisfy the visual result: the Playwright scroll-width assertions must prove the content no longer overflows.

**Step 3: Use a modal-appropriate reflow breakpoint**

Remove `.user-editor` from the `@media (max-width: 1180px)` group. Add it to the `@media (max-width: 760px)` rules:

```css
@media (max-width: 760px) {
  .user-editor {
    grid-template-columns: 1fr;
  }
}
```

Keep the existing two-column base rule with `minmax(0, 1fr)`.

**Step 4: Run the browser regression and verify GREEN**

Run:

```bash
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/ai-gateway-admin-modal-responsive.playwright.spec.ts
```

Expected: PASS for all viewport containment cases and the two-to-one-column reflow case.

**Step 5: Run focused source and type checks**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
pnpm --filter @neatech/veslo-e2e typecheck
```

Expected: both commands exit 0 with no failures.

### Task 3: Document and verify the durable behavior

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Verify: `services/ai-gateway/public-admin/index.html`
- Verify: `services/ai-gateway/public-admin/app.css`
- Verify: `packages/e2e/specs/ai-gateway-admin-modal-responsive.playwright.spec.ts`

**Step 1: Add the responsive-modal behavior to the canonical admin documentation**

In the admin behavior section, add:

```markdown
- Every canonical admin dialog is constrained to the available window width and must not introduce horizontal scrolling. Wider editors reflow their fields when the window narrows; DEN `/admin` redirects to this AI Gateway-owned surface rather than maintaining a second modal implementation.
```

**Step 2: Run whitespace and focused regression checks**

Run:

```bash
git diff --check
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/ai-gateway-admin-modal-responsive.playwright.spec.ts
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: every command exits 0.

**Step 3: Run the required repository quality gate**

Run from the repository root:

```bash
pnpm check
```

Expected: exit 0 across lint, types, unit/contract tests, Rust checks, and architecture audits.

This web-admin CSS change does not require launching the Tauri desktop runtime because the affected canonical admin surface is served by AI Gateway and DEN redirects to it.

**Step 4: Review scope and commit**

Confirm that the diff contains only the modal HTML/CSS change, its Playwright regression, and the canonical documentation update. Then run:

```bash
git add \
  services/ai-gateway/public-admin/index.html \
  services/ai-gateway/public-admin/app.css \
  packages/e2e/specs/ai-gateway-admin-modal-responsive.playwright.spec.ts \
  docs/admin-managed-ai-access.md
git commit -m "fix(admin): make modal widths responsive"
```

Expected: the commit succeeds with only those four paths.
