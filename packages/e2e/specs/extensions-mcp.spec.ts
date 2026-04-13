import { expect } from '@wdio/globals';
import { navigateToHash } from '../helpers/app-launcher.js';

async function waitForRoute(hashFragment: string, timeout = 5000): Promise<void> {
  await browser.waitUntil(
    async () => (await browser.getUrl()).includes(hashFragment),
    { timeout, timeoutMsg: `Route did not change to ${hashFragment} within ${timeout}ms` },
  );
}

async function waitForBodyText(expected: string, timeout = 5000): Promise<string> {
  await browser.waitUntil(
    async () => {
      const text = await browser.execute(() => document.body.innerText);
      return text.includes(expected);
    },
    { timeout, timeoutMsg: `Body did not include ${expected} within ${timeout}ms` },
  );

  return browser.execute(() => document.body.innerText);
}

function containsAny(text: string, values: string[]): boolean {
  return values.some((value) => text.includes(value));
}

describe('Extensions MCP', () => {
  it('shows only Control Chrome on the Extensions screen and keeps Add MCP server', async () => {
    await navigateToHash('/dashboard/mcp');
    await waitForRoute('#/dashboard/mcp');

    const bodyText = await waitForBodyText('Control Chrome');

    expect(bodyText).toContain('Control Chrome');
    expect(bodyText).not.toContain('Notion');
    expect(bodyText).not.toContain('Linear');
    expect(bodyText).not.toContain('Sentry');
    expect(bodyText).not.toContain('Stripe');
    expect(bodyText).not.toContain('Context7');
    expect(bodyText).not.toContain('Advanced settings');
    expect(bodyText).not.toContain('Technical details');
    expect(containsAny(bodyText, ['Add MCP server', 'Přidat MCP server', '添加服务器'])).toBe(true);
  });
});
