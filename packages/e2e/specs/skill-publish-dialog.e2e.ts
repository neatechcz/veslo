import { expect } from "@wdio/globals";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const globalSkillsRoot = () => join(isolatedProfileRoot(), ".config", "opencode", "skills");

function writeSkill(root: string, name: string, description: string): void {
  const skillDir = join(root, name);
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      `# ${name}`,
      "",
      description,
      "",
      "## When to use",
      `- ${description}`,
      "",
    ].join("\n"),
  );
}

async function waitForBodyText(expected: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const text = await browser.execute(() => document.body.innerText);
      return text.includes(expected);
    },
    { timeout, timeoutMsg: `Body did not include ${expected} within ${timeout}ms` },
  );
}

async function clickInventoryCardDetailButton(selector: string): Promise<void> {
  const clicked = await browser.execute((cardSelector) => {
    const button = document.querySelector<HTMLElement>(`${cardSelector} [data-testid="skill-inventory-detail-button"]`);
    button?.click();
    return Boolean(button);
  }, selector);
  expect(clicked).toBe(true);
}

const runWhenIsolatedProfile = process.env.E2E_USE_EXISTING_PROFILE?.trim() === "1"
  ? describe.skip
  : describe;

runWhenIsolatedProfile("Skill publish dialog", () => {
  it("opens the Pencil proposal publish review dialog for a local skill", async () => {
    writeSkill(globalSkillsRoot(), "e2e-publish-dialog-skill", "Publish dialog fixture skill.");

    await navigateToHash("/dashboard/skills");
    await waitForHashRoute("#/dashboard/skills");
    await waitForBodyText("e2e-publish-dialog-skill");

    const skillSelector = '[data-testid="skill-inventory-card"][data-skill-inventory-name="e2e-publish-dialog-skill"]';
    await clickInventoryCardDetailButton(skillSelector);
    await expect($('[data-testid="skill-detail-drawer"]')).toExist();

    await $("button=Publish to organization").click();
    await expect($('[data-testid="skill-review-dialog"]')).toExist();

    const reviewDialogMetrics = await browser.execute(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="skill-review-dialog"]');
      const shell = dialog?.parentElement;
      if (!shell) return null;
      const rect = shell.getBoundingClientRect();
      return {
        height: rect.height,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        width: rect.width,
      };
    });

    expect(reviewDialogMetrics).not.toBeNull();
    const expectedDialogWidth = Math.min(1080, reviewDialogMetrics!.viewportWidth - 32);
    const expectedDialogHeight = Math.min(902, reviewDialogMetrics!.viewportHeight - 32);
    expect(reviewDialogMetrics!.width).toBeGreaterThanOrEqual(expectedDialogWidth - 2);
    expect(reviewDialogMetrics!.width).toBeLessThanOrEqual(expectedDialogWidth + 2);
    expect(reviewDialogMetrics!.height).toBeGreaterThanOrEqual(expectedDialogHeight - 2);
    expect(reviewDialogMetrics!.height).toBeLessThanOrEqual(expectedDialogHeight + 2);

    const reviewDialogText = await $('[data-testid="skill-review-dialog"]').getText();
    expect(reviewDialogText).toContain("Send skill for approval");
    expect(reviewDialogText).toContain("What will be submitted");
    expect(reviewDialogText).toContain("e2e-publish-dialog-skill");
    expect(reviewDialogText).toContain("Where to publish");
    expect(reviewDialogText).toContain("Pre-submit check");
    expect(reviewDialogText).toContain("Note for approver");
    expect(reviewDialogText).toContain("valid package");
    expect(reviewDialogText).toContain("Publishing service is not connected yet");
  });
});
