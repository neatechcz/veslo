import { expect } from "@wdio/globals";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";
import {
  E2E_SKILL_REGISTRY_FIXTURE,
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  E2E_SKILL_REGISTRY_USER_ID,
  readSkillRegistryFixtureBaseUrl,
  readSkillRegistryFixtureEvents,
  resetSkillRegistryFixtureState,
} from "../helpers/skill-registry-fixture.js";

const userSkill = E2E_SKILL_REGISTRY_FIXTURE.personalGlobalSkill;
const orgRolloutSkill = E2E_SKILL_REGISTRY_FIXTURE.orgRolloutTool;
const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const userManagedSkillsRoot = () => join(isolatedProfileRoot(), ".config", "opencode", "skills", "veslo-managed");
const userManagedSkillRoot = () => join(userManagedSkillsRoot(), userSkill.name);
const orgRolloutSkillRoot = () => join(userManagedSkillsRoot(), orgRolloutSkill.name);
const orgRolloutSkillPath = () => join(orgRolloutSkillRoot(), "SKILL.md");
const userManagedSkillSelector = () =>
  `[data-skill-inventory-name="${userSkill.name}"]` +
  `[data-skill-inventory-scope="user-global"]` +
  `[data-skill-inventory-lifecycle="active"]`;
const orgRolloutSkillSelector = () =>
  `[data-skill-inventory-name="${orgRolloutSkill.name}"]` +
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

type VesloServerConnection = {
  baseUrl: string;
  clientToken: string;
  hostToken: string;
};

function fixtureDenAuthJson(): string {
  return JSON.stringify({
    denApiBase: readSkillRegistryFixtureBaseUrl(),
    token: E2E_SKILL_REGISTRY_TOKEN,
    orgId: E2E_SKILL_REGISTRY_ORG_ID,
    user: {
      id: `${E2E_SKILL_REGISTRY_USER_ID}_fixture`,
      email: "veslo-registry-e2e@example.test",
    },
    org: { id: E2E_SKILL_REGISTRY_ORG_ID, slug: "veslo-e2e" },
  });
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

async function waitForLocalVesloServerReady(): Promise<VesloServerConnection> {
  let latest: VesloServerInfo | null = null;
  await browser.waitUntil(
    async () => {
      latest = await tauriInvoke<VesloServerInfo>("veslo_server_info").catch(() => null);
      const baseUrl = latest?.baseUrl?.trim().replace(/\/+$/, "") ?? "";
      const clientToken = latest?.clientToken?.trim() ?? "";
      const hostToken = latest?.hostToken?.trim() ?? "";
      if (!latest?.running || !baseUrl || !clientToken || !hostToken) return false;
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

  const info = await tauriInvoke<VesloServerInfo>("veslo_server_info");
  const baseUrl = info.baseUrl?.trim().replace(/\/+$/, "") ?? "";
  const clientToken = info.clientToken?.trim() ?? "";
  const hostToken = info.hostToken?.trim() ?? "";
  if (!baseUrl || !clientToken || !hostToken) {
    throw new Error("Local Veslo server readiness returned incomplete connection data.");
  }
  return { baseUrl, clientToken, hostToken };
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

async function prepareLocalDesktopRuntime(route: string): Promise<void> {
  await browser.execute((authJson) => {
    window.localStorage.setItem("veslo.language", "en");
    window.localStorage.setItem("veslo.onboardingComplete", "1");
    window.localStorage.setItem("veslo.startupPref", "local");
    window.localStorage.setItem("veslo.den.keepSignedIn", "1");
    window.localStorage.setItem("veslo.den.auth", authJson);
    window.sessionStorage.removeItem("veslo.den.auth");
  }, fixtureDenAuthJson());
  await navigateToHash(route);
  await browser.refresh();
  await waitForHashRoute(`#${route}`);
  await expect($('[data-testid="skills-page"]')).toExist();
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

async function waitForOrgRolloutSkill(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const found = await browser.execute((selector) => Boolean(document.querySelector(selector)), orgRolloutSkillSelector());
      return found;
    },
    {
      timeout: 15_000,
      timeoutMsg: "org-rollout-tool did not appear as an active user skill on the Skills page.",
    },
  );
}

async function clickOrgRolloutSkillRemoveButton(): Promise<void> {
  await waitForOrgRolloutSkill();
  const clicked = await browser.execute(
    (selector) => {
      const button = document
        .querySelector<HTMLElement>(selector)
        ?.querySelector<HTMLButtonElement>('[data-testid="skill-inventory-deactivate-button"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    },
    orgRolloutSkillSelector(),
  );
  expect(clicked).toBe(true);
}

async function syncGlobalMaterialization(connection: VesloServerConnection): Promise<void> {
  const response = await fetch(`${connection.baseUrl}/skills/materialization/sync-global`, {
    method: "POST",
    headers: {
      "X-Veslo-Host-Token": connection.hostToken,
      "x-veslo-den-api-base": readSkillRegistryFixtureBaseUrl(),
      "x-veslo-den-token": E2E_SKILL_REGISTRY_TOKEN,
      "x-veslo-den-org-id": E2E_SKILL_REGISTRY_ORG_ID,
      "x-veslo-den-user-id": E2E_SKILL_REGISTRY_USER_ID,
      accept: "application/json",
    },
  });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    synced?: boolean;
    materializedSkills?: Array<{ name?: string }>;
  };
  expect(payload.synced).toBe(true);
  expect(payload.materializedSkills?.some((skill) => skill.name === orgRolloutSkill.name)).toBe(true);
  expect(existsSync(orgRolloutSkillPath())).toBe(true);
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

    await prepareLocalDesktopRuntime("/dashboard/skills");
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

  it("removes org-rollout-tool from active user skills through the rollout policy", async () => {
    await resetSkillRegistryFixtureState();
    rmSync(userManagedSkillsRoot(), { recursive: true, force: true });

    await prepareLocalDesktopRuntime("/dashboard/skills");
    const connection = await waitForLocalVesloServerReady();
    await waitForAppVesloServerConnected();
    expect(await browserDenAuthBaseUrl()).toBe(readSkillRegistryFixtureBaseUrl());

    await syncGlobalMaterialization(connection);
    await $('[data-testid="skills-refresh-button"]').click();
    await waitForOrgRolloutSkill();

    await clickOrgRolloutSkillRemoveButton();
    await expect($('[data-testid="skill-uninstall-modal"]')).toExist();
    expect(await $('[data-testid="skill-uninstall-modal"]').getText()).toContain(orgRolloutSkill.name);

    await $('[data-testid="skill-uninstall-confirm"]').click();
    await expect($('[data-testid="skill-uninstall-modal"]')).not.toExist();

    await browser.waitUntil(
      async () => {
        const events = await readSkillRegistryFixtureEvents();
        return events.updatedRolloutPolicyCalls.some((call) =>
          call.policyId === E2E_SKILL_REGISTRY_FIXTURE.orgRolloutToolPolicyId && call.enabled === false
        );
      },
      {
        timeout: 10_000,
        timeoutMsg: `org-rollout-tool removal did not disable rollout policy ${E2E_SKILL_REGISTRY_FIXTURE.orgRolloutToolPolicyId}. Body: ${await visibleBodyText()}`,
      },
    );

    await browser.waitUntil(
      async () => {
        const found = await browser.execute((selector) => Boolean(document.querySelector(selector)), orgRolloutSkillSelector());
        return !found;
      },
      {
        timeout: 10_000,
        timeoutMsg: `org-rollout-tool stayed visible as an active user skill after delete. Body: ${await visibleBodyText()}`,
      },
    );
    expect(existsSync(orgRolloutSkillPath())).toBe(false);
  });
});
