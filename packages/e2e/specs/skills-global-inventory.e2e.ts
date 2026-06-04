import { expect } from "@wdio/globals";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
const skillPath = (root: string, name: string) => join(root, name, "SKILL.md");

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
  rmSync(join(workspaceSkillsRoot(), "e2e-global-skill"), { recursive: true, force: true });
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

  try {
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

        return hasGlobal && hasWorkspace && hasOverrideGlobal;
      },
      {
        timeout: 15_000,
        timeoutMsg: "Skills inventory fixture did not appear on the Skills page.",
      },
    );
  } catch (error) {
    const bodyText = await browser.execute(() => document.body.innerText).catch(() => "");
    throw new Error(
      `Skills inventory fixture did not appear on the Skills page. ` +
      `Latest cards: ${JSON.stringify(latestCards)}. ` +
      `Body: ${bodyText.slice(0, 1_000)}`,
      { cause: error },
    );
  }

  return latestCards;
}

async function refreshSkillsInventoryFromUi(): Promise<void> {
  const clicked = await browser.execute(() => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const refreshButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-testid="skills-page"] button'),
    ).find((button) => normalize(button.textContent ?? "") === "Refresh");

    refreshButton?.click();
    return Boolean(refreshButton);
  });

  expect(clicked).toBe(true);
}

async function setInventoryScopeFilter(scope: "all" | "user-global" | "workspace"): Promise<void> {
  const changed = await browser.execute((nextScope) => {
    const scopeSelect = Array.from(document.querySelectorAll<HTMLSelectElement>('[data-testid="skills-page"] select'))
      .find((select) =>
        Array.from(select.options).some((option) => option.value === "user-global") &&
        Array.from(select.options).some((option) => option.value === "workspace")
      );
    if (!scopeSelect) return false;

    scopeSelect.value = nextScope;
    scopeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, scope);

  expect(changed).toBe(true);
}

async function waitForInventoryCard(
  predicate: (card: InventoryCard) => boolean,
  timeoutMsg: string,
): Promise<void> {
  await browser.waitUntil(
    async () => (await readInventoryCards()).some(predicate),
    {
      timeout: 10_000,
      interval: 250,
      timeoutMsg,
    },
  );
}

async function clickInventoryCardSelector(selector: string): Promise<void> {
  const clicked = await browser.execute((cardSelector) => {
    const card = document.querySelector<HTMLElement>(cardSelector);
    card?.click();
    return Boolean(card);
  }, selector);
  expect(clicked).toBe(true);
}

async function isInventoryCardSelected(selector: string): Promise<boolean> {
  return browser.execute((cardSelector) => {
    return Boolean(document.querySelector<HTMLInputElement>(`${cardSelector} input[type="checkbox"]`)?.checked);
  }, selector);
}

async function clickInventoryCardDetailButton(selector: string): Promise<void> {
  const clicked = await browser.execute((cardSelector) => {
    const button = document.querySelector<HTMLElement>(`${cardSelector} [data-testid="skill-inventory-detail-button"]`);
    button?.click();
    return Boolean(button);
  }, selector);
  expect(clicked).toBe(true);
}

async function clickSkillDetailButton(label: string): Promise<void> {
  const result = await browser.execute((buttonLabel) => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const drawer = document.querySelector<HTMLElement>('[data-testid="skill-detail-drawer"]');
    const button = Array.from(drawer?.querySelectorAll<HTMLButtonElement>("button") ?? [])
      .find((candidate) => normalize(candidate.textContent ?? "") === buttonLabel);
    button?.click();
    return {
      disabled: button?.disabled ?? null,
      found: Boolean(button),
      text: drawer?.innerText ?? "",
    };
  }, label);

  expect(result.found).toBe(true);
  expect(result.disabled).toBe(false);
}

async function waitForSkillDetailText(
  predicate: (text: string) => boolean,
  timeoutMsg: string,
): Promise<string> {
  let latestText = "";
  await browser.waitUntil(
    async () => {
      latestText = await browser.execute(() =>
        document.querySelector<HTMLElement>('[data-testid="skill-detail-drawer"]')?.innerText ?? ""
      );
      return predicate(latestText);
    },
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg,
    },
  );
  return latestText;
}

async function waitForSkillFileState(path: string, expectedExists: boolean): Promise<void> {
  await browser.waitUntil(
    async () => existsSync(path) === expectedExists,
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: `Expected ${path} existence to be ${String(expectedExists)}.`,
    },
  );
}

async function closeSkillDetailIfOpen(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await $('[data-modal-shell-root]').isExisting()) {
      await browser.keys('Escape');
      await browser.pause(100);
      continue;
    }

    if (!(await $('[data-testid="skill-detail-drawer"]').isExisting())) return;

    const clicked = await browser.execute(() => {
      const drawer = document.querySelector<HTMLElement>('[data-testid="skill-detail-drawer"]');
      const closeButton = drawer?.querySelector<HTMLButtonElement>('button[aria-label]');
      closeButton?.click();
      return Boolean(closeButton);
    });
    if (!clicked) {
      await browser.keys('Escape');
    }
    await browser.pause(100);
  }

  await expect($('[data-testid="skill-detail-drawer"]')).not.toExist();
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

    await setInventoryScopeFilter("all");
    await refreshSkillsInventoryFromUi();
    const cards = await waitForInventoryFixture();
    const workspaceSectionText = await $('[data-testid="skills-workspace-specific-section"]').getText();

    expect(cards.filter((card) => card.name === "e2e-global-skill")).toHaveLength(1);
    expect(workspaceSectionText).not.toContain("e2e-global-skill");
    expect(cards.some((card) =>
      card.name === "e2e-override-skill" &&
      card.scope === "workspace" &&
      card.workspaceId === "e2e-visual-workspace"
    )).toBe(false);

    await setInventoryScopeFilter("workspace");
    await waitForInventoryCard(
      (card) =>
        card.name === "e2e-override-skill" &&
        card.scope === "workspace" &&
        card.workspaceId === "e2e-visual-workspace" &&
        card.section === "workspace-specific",
      "Workspace override skill did not appear after filtering to workspace scope.",
    );
    await setInventoryScopeFilter("all");
    await waitForInventoryCard(
      (card) => card.name === "e2e-global-skill" && card.scope === "user-global",
      "Global skill did not reappear after restoring the all-scope inventory filter.",
    );

    const globalSkillSelector = '[data-testid="skill-inventory-card"][data-skill-inventory-name="e2e-global-skill"]';
    const workspaceSkillSelector = '[data-testid="skill-inventory-card"][data-skill-inventory-name="e2e-workspace-skill"]';
    await closeSkillDetailIfOpen();
    await clickInventoryCardSelector(globalSkillSelector);
    await expect($('[data-testid="skill-detail-drawer"]')).not.toExist();
    await browser.waitUntil(() => isInventoryCardSelected(globalSkillSelector), {
      timeout: 5_000,
      timeoutMsg: "Global skill card was not selected after clicking the card.",
    });
    await waitForBodyText("1 selected");
    await expect($('[data-testid="skills-bulk-install-workspace-button"]')).toExist();

    await $('[data-testid="skills-bulk-install-workspace-button"]').click();
    await expect($('[data-testid="skill-install-workspace-modal"]')).toExist();
    await $('[data-testid="skill-install-workspace-close"]').click();
    await expect($('[data-testid="skill-install-workspace-modal"]')).not.toExist();

    await clickInventoryCardSelector(workspaceSkillSelector);
    await waitForBodyText("2 selected");
    await expect($('[data-testid="skills-bulk-install-workspace-button"]')).not.toExist();
    await expect($('[data-testid="skills-bulk-copy-to-user-button"]')).not.toExist();
    await expect($('[data-testid="skills-bulk-move-to-user-button"]')).not.toExist();

    await clickInventoryCardSelector(workspaceSkillSelector);
    await waitForBodyText("1 selected");

    await clickInventoryCardDetailButton(globalSkillSelector);
    await expect($('[data-testid="skill-detail-drawer"]')).toExist();

    await $('[data-testid="skill-detail-install-workspace-button"]').click();
    await expect($('[data-testid="skill-install-workspace-modal"]')).toExist();
    const workspaceInstallMetrics = await browser.execute(() => {
      const modal = document.querySelector<HTMLElement>('[data-testid="skill-install-workspace-modal"]');
      const shell = modal?.closest<HTMLElement>("[data-modal-shell-root]");
      const rect = modal?.getBoundingClientRect();
      const centerElement = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return rect && shell
        ? {
            bottom: rect.bottom,
            height: rect.height,
            modalIsTopAtCenter: Boolean(centerElement?.closest('[data-testid="skill-install-workspace-modal"]')),
            top: rect.top,
            viewportHeight: window.innerHeight,
            zIndex: getComputedStyle(shell).zIndex,
          }
        : null;
    });

    expect(workspaceInstallMetrics).not.toBeNull();
    expect(workspaceInstallMetrics!.zIndex).toBe("60");
    expect(workspaceInstallMetrics!.modalIsTopAtCenter).toBe(true);
    expect(workspaceInstallMetrics!.top).toBeGreaterThanOrEqual(16);
    expect(workspaceInstallMetrics!.bottom).toBeLessThanOrEqual(workspaceInstallMetrics!.viewportHeight - 16);
    expect(workspaceInstallMetrics!.height).toBeLessThanOrEqual(workspaceInstallMetrics!.viewportHeight - 32);

    await browser.keys('Escape');
    await expect($('[data-testid="skill-install-workspace-modal"]')).not.toExist();
    await expect($('[data-testid="skill-detail-drawer"]')).toExist();

    await $('[data-testid="skill-detail-install-workspace-button"]').click();
    await expect($('[data-testid="skill-install-workspace-modal"]')).toExist();
    await $('[data-testid="skill-install-workspace-close"]').click();
    await expect($('[data-testid="skill-install-workspace-modal"]')).not.toExist();
    await expect($('[data-testid="skill-detail-drawer"]')).toExist();

    await $('button=Publish to organization').click();
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
    expect(reviewDialogText).toContain("What will be submitted");
    expect(reviewDialogText).toContain("Where to publish");
    expect(reviewDialogText).toContain("Pre-submit check");
    expect(reviewDialogText).toContain("valid package");

    await browser.keys('Escape');
    await expect($('[data-testid="skill-review-dialog"]')).not.toExist();
    await expect($('[data-testid="skill-detail-drawer"]')).toExist();

    await $('[data-testid="skill-detail-install-workspace-button"]').click();
    await expect($('[data-testid="skill-install-workspace-modal"]')).toExist();
    await $('[data-testid="skill-install-workspace-confirm"]').click();
    try {
      await expect($('[data-testid="skill-install-workspace-modal"]')).not.toExist();
    } catch (error) {
      const bodyText = await browser.execute(() => document.body.innerText).catch(() => "");
      throw new Error(`Install-to-workspace modal stayed open. Body: ${bodyText.slice(0, 1_000)}`, { cause: error });
    }
    await setInventoryScopeFilter("workspace");
    await waitForInventoryCard(
      (card) =>
        card.name === "e2e-global-skill" &&
        card.scope === "workspace" &&
        card.workspaceId === "e2e-visual-workspace" &&
        card.section === "workspace-specific",
      "Installing a user skill into the workspace did not create a workspace skill row.",
    );

    await browser.keys('Escape');
    await expect($('[data-testid="skill-detail-drawer"]')).not.toExist();

    await clickInventoryCardDetailButton(workspaceSkillSelector);
    await expect($('[data-testid="skill-detail-drawer"]')).toExist();
    await expect($('button=Edit')).toExist();
    await expect($('button=Copy to user skills')).toExist();
    await expect($('button=Move to user skills')).toExist();
    await expect($('button=Deactivate')).toExist();
    await expect($('button=Publish to organization')).toExist();
    await expect($('button=Request system catalog approval')).toExist();

    await clickSkillDetailButton("Move to user skills");
    await waitForSkillFileState(skillPath(workspaceSkillsRoot(), "e2e-workspace-skill"), false);
    await waitForSkillFileState(skillPath(globalSkillsRoot(), "e2e-workspace-skill"), true);
    const movedDetailText = await waitForSkillDetailText(
      (text) => text.includes("Install to workspace") && !text.includes("Move to user skills"),
      "Skill detail did not reload from workspace actions to user-skill actions after moving the skill.",
    );
    expect(movedDetailText).toContain("Publish to organization");
    expect(movedDetailText).toContain("Request system catalog approval");

    await browser.keys('Escape');
    await expect($('[data-testid="skill-detail-drawer"]')).not.toExist();

    await expect($('[data-testid="skills-hub-section"]')).toExist();

    await navigateToHash("/dashboard/settings");
    await waitForHashRoute("#/dashboard/settings");
    await waitForBodyText("Settings");
  });
});
