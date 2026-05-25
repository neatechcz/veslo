import { expect } from "@wdio/globals";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type InventoryCard = {
  name: string;
  scope: string;
  workspaceId: string;
  section: "all-workspaces" | "workspace-specific" | "unknown";
  text: string;
};

const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const workspaceRoot = () => join(isolatedProfileRoot(), "workspaces", "visual-workspace");
const globalSkillsRoot = () => join(isolatedProfileRoot(), ".config", "opencode", "skills");
const workspaceSkillsRoot = () => join(workspaceRoot(), ".opencode", "skills");

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

function seedSkillInventoryFixture(): void {
  writeSkill(globalSkillsRoot(), "e2e-global-skill", "Global inventory fixture skill.");
  writeSkill(globalSkillsRoot(), "e2e-override-skill", "Global copy used by override fixture.");
  writeSkill(workspaceSkillsRoot(), "e2e-workspace-skill", "Workspace-only inventory fixture skill.");
  writeSkill(workspaceSkillsRoot(), "e2e-override-skill", "Workspace override inventory fixture skill.");
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

async function readInventoryCards(): Promise<InventoryCard[]> {
  return browser.execute(() => {
    const allSection = document.querySelector('[data-testid="skills-all-workspaces-section"]');
    const workspaceSection = document.querySelector('[data-testid="skills-workspace-specific-section"]');

    return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="skill-inventory-card"]')).map((card) => {
      const section = allSection?.contains(card)
        ? "all-workspaces"
        : workspaceSection?.contains(card)
          ? "workspace-specific"
          : "unknown";

      return {
        name: card.dataset.skillInventoryName ?? "",
        scope: card.dataset.skillInventoryScope ?? "",
        workspaceId: card.dataset.skillInventoryWorkspaceId ?? "",
        section,
        text: card.innerText,
      };
    });
  });
}

async function waitForInventoryFixture(): Promise<InventoryCard[]> {
  let latestCards: InventoryCard[] = [];

  await browser.waitUntil(
    async () => {
      latestCards = await readInventoryCards();
      const hasGlobal = latestCards.some((card) =>
        card.name === "e2e-global-skill" &&
        card.scope === "user-global" &&
        card.section === "all-workspaces"
      );
      const hasWorkspace = latestCards.some((card) =>
        card.name === "e2e-workspace-skill" &&
        card.scope === "workspace" &&
        card.workspaceId === "e2e-visual-workspace" &&
        card.section === "workspace-specific"
      );
      const overrideCards = latestCards.filter((card) => card.name === "e2e-override-skill");
      const hasOverrideGlobal = overrideCards.some((card) =>
        card.scope === "user-global" &&
        card.section === "all-workspaces"
      );
      const hasOverrideWorkspace = overrideCards.some((card) =>
        card.scope === "workspace" &&
        card.workspaceId === "e2e-visual-workspace" &&
        card.section === "workspace-specific" &&
        card.text.includes("Workspace overrides")
      );

      return hasGlobal && hasWorkspace && hasOverrideGlobal && hasOverrideWorkspace;
    },
    {
      timeout: 15_000,
      timeoutMsg: "Skills inventory fixture did not appear on the Skills page.",
    },
  );

  return latestCards;
}

const runWhenIsolatedProfile = process.env.E2E_USE_EXISTING_PROFILE?.trim() === "1"
  ? describe.skip
  : describe;

runWhenIsolatedProfile("Skills global inventory", () => {
  it("shows global, workspace-only, override, Hub, and Settings surfaces in the desktop app", async () => {
    seedSkillInventoryFixture();

    await navigateToHash("/dashboard/skills");
    await waitForHashRoute("#/dashboard/skills");

    const page = await $('[data-testid="skills-page"]');
    await page.waitForExist({ timeout: 10_000 });

    const cards = await waitForInventoryFixture();
    const workspaceSectionText = await $('[data-testid="skills-workspace-specific-section"]').getText();

    expect(cards.filter((card) => card.name === "e2e-global-skill")).toHaveLength(1);
    expect(workspaceSectionText).not.toContain("e2e-global-skill");
    await expect($('[data-testid="skills-hub-section"]')).toExist();

    await navigateToHash("/dashboard/settings");
    await waitForHashRoute("#/dashboard/settings");
    await waitForBodyText("Settings");
  });
});
