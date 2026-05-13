import { expect } from '@wdio/globals';
import { navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';

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
  const normalizedText = text.toLocaleLowerCase();
  return values.some((value) => normalizedText.includes(value.toLocaleLowerCase()));
}

describe('Extensions MCP', () => {
  it('shows only Control Chrome on the Extensions screen and keeps Add MCP server', async () => {
    await navigateToHash('/dashboard/mcp');
    await waitForHashRoute('#/dashboard/mcp');

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
