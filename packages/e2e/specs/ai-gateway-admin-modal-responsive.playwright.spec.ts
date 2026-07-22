import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
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

test('user editor reflows only when the modal becomes narrow', async ({ page }) => {
  const modal = page.locator('#user-editor-modal');
  const editor = page.locator('#user-editor-modal .user-editor');

  await openAdmin(page, 900);
  await modal.evaluate((node: HTMLDialogElement) => node.showModal());
  const compactColumns = await editor.evaluate((node) => getComputedStyle(node).gridTemplateColumns);
  expect(compactColumns.trim().split(/\s+/)).toHaveLength(2);

  await modal.evaluate((node: HTMLDialogElement) => node.close());
  await openAdmin(page, 720);
  await modal.evaluate((node: HTMLDialogElement) => node.showModal());
  const narrowColumns = await editor.evaluate((node) => getComputedStyle(node).gridTemplateColumns);
  expect(narrowColumns.trim().split(/\s+/)).toHaveLength(1);
});
