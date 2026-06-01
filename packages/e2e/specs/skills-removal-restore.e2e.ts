import { expect } from "@wdio/globals";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type InventoryInstance = {
  kind: "card" | "table-row";
  lifecycle: string;
  name: string;
  scope: string;
  text: string;
  workspaceId: string;
};

type TauriInvokeResult<T> = {
  ok: boolean;
  value?: T;
  error?: string;
};

type VesloServerInfo = {
  running?: boolean;
  baseUrl?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
};

const WORKSPACE_ID = "e2e-visual-workspace";
const SKILL_NAME = "e2e-removal-restore-skill";
const SKILL_DESCRIPTION = "Recoverable removal and restore fixture skill.";

const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const workspaceRoot = () => join(isolatedProfileRoot(), "workspaces", "visual-workspace");
const workspaceSkillsRoot = () => join(workspaceRoot(), ".opencode", "skills");
const skillRoot = () => join(workspaceSkillsRoot(), SKILL_NAME);
const skillPath = () => join(skillRoot(), "SKILL.md");
const skillInstanceSelector = (lifecycle: "active" | "removed") =>
  `[data-skill-inventory-name="${SKILL_NAME}"]` +
  `[data-skill-inventory-scope="workspace"]` +
  `[data-skill-inventory-workspace-id="${WORKSPACE_ID}"]` +
  `[data-skill-inventory-lifecycle="${lifecycle}"]`;

function seedWorkspaceSkill(): void {
  rmSync(skillRoot(), { recursive: true, force: true });
  mkdirSync(skillRoot(), { recursive: true });
  writeFileSync(
    skillPath(),
    [
      "---",
      `name: ${SKILL_NAME}`,
      `description: ${SKILL_DESCRIPTION}`,
      "---",
      "",
      `# ${SKILL_NAME}`,
      "",
      SKILL_DESCRIPTION,
      "",
      "## When to use",
      "- Exercise recoverable local workspace skill removal and restore.",
      "",
    ].join("\n"),
    "utf8",
  );
}

async function tauriInvoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.executeAsync(
    (
      args: { command: string; payload: Record<string, unknown> },
      done: (value: TauriInvokeResult<unknown>) => void,
    ) => {
      const invoke = (
        window as typeof window & {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;

      if (typeof invoke !== "function") {
        done({ ok: false, error: "Tauri invoke bridge is unavailable." });
        return;
      }

      invoke(args.command, args.payload).then(
        (value) => done({ ok: true, value }),
        (error) => done({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    },
    { command, payload },
  ) as TauriInvokeResult<T>;

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? "unknown error"}`);
  }

  return result.value as T;
}

async function waitForLocalVesloServerReady(timeout = 45_000): Promise<void> {
  let latest: VesloServerInfo | null = null;

  await browser.waitUntil(
    async () => {
      latest = await tauriInvoke<VesloServerInfo>("veslo_server_info").catch(() => null);
      const baseUrl = latest?.baseUrl?.trim().replace(/\/+$/, "") ?? "";
      const clientToken = latest?.clientToken?.trim() ?? "";
      const hostToken = latest?.hostToken?.trim() ?? "";
      if (!latest?.running || !baseUrl || !clientToken || !hostToken) return false;

      const response = await fetch(`${baseUrl}/health`).catch(() => null);
      if (!response?.ok) return false;
      const payload = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      return payload?.ok === true;
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: "Local Veslo server did not become ready for recoverable skill removal.",
    },
  );
}

async function readInventoryInstances(): Promise<InventoryInstance[]> {
  return browser.execute(() => {
    const instances: InventoryInstance[] = [];
    for (const card of document.querySelectorAll<HTMLElement>('[data-testid="skill-inventory-card"]')) {
      instances.push({
        kind: "card",
        lifecycle: card.dataset.skillInventoryLifecycle ?? "",
        name: card.dataset.skillInventoryName ?? "",
        scope: card.dataset.skillInventoryScope ?? "",
        text: card.innerText,
        workspaceId: card.dataset.skillInventoryWorkspaceId ?? "",
      });
    }
    for (const row of document.querySelectorAll<HTMLElement>('[data-testid="skill-inventory-table-row"]')) {
      instances.push({
        kind: "table-row",
        lifecycle: row.dataset.skillInventoryLifecycle ?? "",
        name: row.dataset.skillInventoryName ?? "",
        scope: row.dataset.skillInventoryScope ?? "",
        text: row.innerText,
        workspaceId: row.dataset.skillInventoryWorkspaceId ?? "",
      });
    }
    return instances;
  });
}

async function waitForSkillInstance(lifecycle: "active" | "removed"): Promise<InventoryInstance> {
  let latestInstances: InventoryInstance[] = [];

  await browser.waitUntil(
    async () => {
      latestInstances = await readInventoryInstances();
      return latestInstances.some((instance) =>
        instance.name === SKILL_NAME &&
        instance.scope === "workspace" &&
        instance.workspaceId === WORKSPACE_ID &&
        instance.lifecycle === lifecycle
      );
    },
    {
      timeout: 15_000,
      timeoutMsg: `Workspace skill ${SKILL_NAME} did not appear with lifecycle ${lifecycle}.`,
    },
  );

  const instance = latestInstances.find((item) =>
    item.name === SKILL_NAME &&
    item.scope === "workspace" &&
    item.workspaceId === WORKSPACE_ID &&
    item.lifecycle === lifecycle
  );
  if (!instance) throw new Error(`Workspace skill ${SKILL_NAME} was not captured.`);
  return instance;
}

async function waitForNoSkillInstance(lifecycle: "active" | "removed"): Promise<void> {
  await browser.waitUntil(
    async () => {
      const instances = await readInventoryInstances();
      return !instances.some((instance) =>
        instance.name === SKILL_NAME &&
        instance.scope === "workspace" &&
        instance.workspaceId === WORKSPACE_ID &&
        instance.lifecycle === lifecycle
      );
    },
    {
      timeout: 10_000,
      timeoutMsg: `Workspace skill ${SKILL_NAME} still appeared with lifecycle ${lifecycle}.`,
    },
  );
}

async function clickSkillInstanceButton(
  lifecycle: "active" | "removed",
  testId: "skill-inventory-deactivate-button" | "skill-inventory-restore-button",
): Promise<void> {
  const result = await browser.execute(
    (selector, buttonTestId) => {
      const instance = document.querySelector<HTMLElement>(selector);
      const button = instance?.querySelector<HTMLButtonElement>(`[data-testid="${buttonTestId}"]`);
      button?.click();
      return {
        hasInstance: Boolean(instance),
        hasButton: Boolean(button),
        disabled: button?.disabled ?? null,
      };
    },
    skillInstanceSelector(lifecycle),
    testId,
  );

  expect(result.hasInstance).toBe(true);
  expect(result.hasButton).toBe(true);
  expect(result.disabled).toBe(false);
}

async function setDeletedFilterEnabled(): Promise<void> {
  const filter = await $('[data-testid="skills-filter-deleted-checkbox"]');
  await filter.waitForExist({ timeout: 10_000 });
  if (!(await filter.isSelected())) {
    await filter.click();
  }
  expect(await filter.isSelected()).toBe(true);
}

async function waitForSkillFileState(expectedExists: boolean, timeout = 30_000): Promise<void> {
  await browser.waitUntil(
    async () => existsSync(skillPath()) === expectedExists,
    {
      timeout,
      timeoutMsg: `Expected ${skillPath()} existence to be ${String(expectedExists)}.`,
    },
  );
}

async function tryWaitForSkillFileState(expectedExists: boolean, timeout: number): Promise<boolean> {
  try {
    await waitForSkillFileState(expectedExists, timeout);
    return true;
  } catch {
    return false;
  }
}

async function removeActiveSkillThroughUi(): Promise<void> {
  let lastBodyText = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForSkillInstance("active");
    await clickSkillInstanceButton("active", "skill-inventory-deactivate-button");
    await expect($('[data-testid="skill-uninstall-modal"]')).toExist();
    expect(await $('[data-testid="skill-uninstall-modal"]').getText()).toContain(SKILL_NAME);

    await $('[data-testid="skill-uninstall-confirm"]').click();
    await expect($('[data-testid="skill-uninstall-modal"]')).not.toExist();

    if (await tryWaitForSkillFileState(false, attempt === 2 ? 30_000 : 8_000)) {
      return;
    }

    lastBodyText = await browser.execute(() => document.body.innerText);
    await browser.pause(1_000);
  }

  throw new Error(`Skill file was not removed after UI confirmation. Last visible text: ${lastBodyText}`);
}

const runWhenIsolatedProfile = process.env.E2E_USE_EXISTING_PROFILE?.trim() === "1"
  ? describe.skip
  : describe;

runWhenIsolatedProfile("Skills removal restore", () => {
  it("removes a workspace skill recoverably and restores it from the deleted inventory filter", async () => {
    seedWorkspaceSkill();
    expect(existsSync(skillPath())).toBe(true);

    await navigateToHash("/dashboard/skills");
    await waitForHashRoute("#/dashboard/skills");

    const page = await $('[data-testid="skills-page"]');
    await page.waitForExist({ timeout: 10_000 });
    await waitForLocalVesloServerReady();

    const activeBeforeRemoval = await waitForSkillInstance("active");
    expect(activeBeforeRemoval.text).toContain(SKILL_DESCRIPTION);

    await removeActiveSkillThroughUi();

    await setDeletedFilterEnabled();
    const removedInstance = await waitForSkillInstance("removed");
    expect(removedInstance.text).toContain(SKILL_NAME);
    await clickSkillInstanceButton("removed", "skill-inventory-restore-button");
    await expect($('[data-testid="skill-restore-modal"]')).toExist();
    expect(await $('[data-testid="skill-restore-modal"]').getText()).toContain(SKILL_NAME);

    await $('[data-testid="skill-restore-confirm"]').click();
    await expect($('[data-testid="skill-restore-modal"]')).not.toExist();
    await waitForSkillFileState(true);
    expect(readFileSync(skillPath(), "utf8")).toContain(SKILL_DESCRIPTION);

    const activeAfterRestore = await waitForSkillInstance("active");
    expect(activeAfterRestore.text).toContain(SKILL_DESCRIPTION);
    await waitForNoSkillInstance("removed");
  });
});
