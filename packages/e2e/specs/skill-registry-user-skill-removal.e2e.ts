import { expect } from "@wdio/globals";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";
import {
  E2E_SKILL_REGISTRY_FIXTURE,
  readSkillRegistryFixtureBaseUrl,
  readSkillRegistryFixtureEvents,
  resetSkillRegistryFixtureState,
} from "../helpers/skill-registry-fixture.js";

const userSkill = E2E_SKILL_REGISTRY_FIXTURE.personalGlobalSkill;
const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const userManagedSkillsRoot = () => join(isolatedProfileRoot(), ".config", "opencode", "skills", "veslo-managed");
const userManagedSkillRoot = () => join(userManagedSkillsRoot(), userSkill.name);
const userManagedSkillSelector = () =>
  `[data-skill-inventory-name="${userSkill.name}"]` +
  `[data-skill-inventory-scope="user-global"]` +
  `[data-skill-inventory-lifecycle="active"]`;

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

async function waitForLocalVesloServerReady(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const info = await tauriInvoke<VesloServerInfo>("veslo_server_info").catch(() => null);
      const baseUrl = info?.baseUrl?.trim().replace(/\/+$/, "") ?? "";
      const clientToken = info?.clientToken?.trim() ?? "";
      const hostToken = info?.hostToken?.trim() ?? "";
      if (!info?.running || !baseUrl || !clientToken || !hostToken) return false;
      const response = await fetch(`${baseUrl}/health`).catch(() => null);
      if (response?.ok !== true) return false;
      const capabilities = await fetch(`${baseUrl}/capabilities`, {
        headers: {
          Authorization: `Bearer ${clientToken}`,
          "X-Veslo-Host-Token": hostToken,
        },
      }).catch(() => null);
      return capabilities?.ok === true;
    },
    {
      timeout: 45_000,
      interval: 500,
      timeoutMsg: "Local Veslo server did not become ready before managed user skill removal.",
    },
  );
}

async function waitForAppVesloServerConnected(): Promise<void> {
  await $('[data-testid="sidebar-connection-status-button"]').click();
  await browser.waitUntil(
    async () => {
      const status = await $('[data-testid="sidebar-veslo-server-status"]').getText().catch(() => "");
      return status.trim() === "Connected";
    },
    {
      timeout: 45_000,
      interval: 500,
      timeoutMsg: `The app did not mark the local Veslo server as connected. Body: ${await visibleBodyText()}`,
    },
  );
}

function seedUserManagedSkill(): void {
  rmSync(userManagedSkillRoot(), { recursive: true, force: true });
  mkdirSync(userManagedSkillRoot(), { recursive: true });
  writeFileSync(
    join(userManagedSkillRoot(), "SKILL.md"),
    [
      "---",
      `name: ${userSkill.name}`,
      `description: ${userSkill.archive.metadata.description}`,
      "---",
      "",
      `# ${userSkill.name}`,
      "",
      userSkill.archive.metadata.description,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(userManagedSkillRoot(), ".veslo-managed.json"),
    `${JSON.stringify({
      installationId: userSkill.installationId,
      skillId: userSkill.skillId,
      name: userSkill.name,
      versionId: userSkill.versionId,
      packageSha256: userSkill.archive.packageSha256,
      target: "personal-global",
      skillDir: userManagedSkillRoot(),
      materializedAt: new Date(0).toISOString(),
    }, null, 2)}\n`,
  );
}

async function waitForUserManagedSkill(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const found = await browser.execute((selector) => Boolean(document.querySelector(selector)), userManagedSkillSelector());
      return found;
    },
    {
      timeout: 15_000,
      timeoutMsg: "Managed user skill fixture did not appear on the Skills page.",
    },
  );
}

async function clickUserSkillRemoveButton(): Promise<void> {
  await waitForUserManagedSkill();
  const clicked = await browser.execute(
    (selector) => {
      const button = document
        .querySelector<HTMLElement>(selector)
        ?.querySelector<HTMLButtonElement>('[data-testid="skill-inventory-deactivate-button"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    userManagedSkillSelector(),
  );
  expect(clicked).toBe(true);
}

async function visibleBodyText(): Promise<string> {
  return browser.execute(() => document.body.innerText);
}

async function browserDenAuthBaseUrl(): Promise<string> {
  return browser.execute(() => {
    const raw = window.localStorage.getItem("veslo.den.auth") ?? window.sessionStorage.getItem("veslo.den.auth") ?? "";
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { denApiBase?: unknown };
    return typeof parsed.denApiBase === "string" ? parsed.denApiBase.trim().replace(/\/+$/, "") : "";
  });
}

const runWhenRegistryServerEnvDisabled = process.env.E2E_SKILL_REGISTRY_SERVER_ENV?.trim() === "0"
  ? describe
  : describe.skip;

runWhenRegistryServerEnvDisabled("Skill registry user skill removal", () => {
  it("removes a managed user skill through the registry when the local server has no registry base URL env", async () => {
    await resetSkillRegistryFixtureState();
    seedUserManagedSkill();

    await navigateToHash("/dashboard/skills");
    await waitForHashRoute("#/dashboard/skills");
    await expect($('[data-testid="skills-page"]')).toExist();
    await waitForLocalVesloServerReady();
    await waitForAppVesloServerConnected();
    expect(await browserDenAuthBaseUrl()).toBe(readSkillRegistryFixtureBaseUrl());

    await clickUserSkillRemoveButton();
    await expect($('[data-testid="skill-uninstall-modal"]')).toExist();
    expect(await $('[data-testid="skill-uninstall-modal"]').getText()).toContain(userSkill.name);

    await $('[data-testid="skill-uninstall-confirm"]').click();
    await expect($('[data-testid="skill-uninstall-modal"]')).not.toExist();

    await browser.waitUntil(
      async () => {
        const events = await readSkillRegistryFixtureEvents();
        return events.deletedInstallationCalls.includes(userSkill.installationId);
      },
      {
        timeout: 10_000,
        timeoutMsg: `Managed user skill removal did not delete installation ${userSkill.installationId}. Body: ${await visibleBodyText()}`,
      },
    );

    expect(await visibleBodyText()).not.toContain("Skill registry base URL is missing");
  });
});
