import { expect } from "@wdio/globals";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";
import {
  E2E_SKILL_REGISTRY_FIXTURE,
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  E2E_SKILL_REGISTRY_USER_ID,
  E2E_SKILL_REGISTRY_WORKSPACE_ID,
  readSkillRegistryFixtureEvents,
  resetSkillRegistryFixtureState,
  useUpdatedRuntimeSkillVersion,
} from "../helpers/skill-registry-fixture.js";

type InventoryCard = {
  name: string;
  scope: string;
  workspaceId: string;
  section: "all-workspaces" | "workspace-specific" | "unknown";
  text: string;
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

type WorkspaceMaterializationSkill = {
  installationId: string;
  skillId: string;
  name: string;
  versionId: string;
  packageSha256: string;
  target: string;
  skillDir?: string;
};

type WorkspaceMaterializationStatus = {
  workspaceId: string;
  status: string;
  registryConfigured: boolean;
  rootDir: string;
  reloadRequired: boolean;
  materializedSkills: WorkspaceMaterializationSkill[];
};

type WorkspaceMaterializationSyncStatus = WorkspaceMaterializationStatus & {
  synced?: boolean;
};

type WorkspaceSkillListResponse = {
  items: Array<{ name: string; path: string; scope: "project" | "global" }>;
};

type WorkspaceSkillLockfile = {
  skillSetRevision: string;
  entries: Array<{ name: string; versionId: string; packageSha256: string }>;
};

const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const workspaceRoot = () => join(isolatedProfileRoot(), "workspaces", "visual-workspace");
const workspaceManagedSkillsRoot = () => join(workspaceRoot(), ".opencode", "skills", "veslo-managed");
const materializedSkillRoot = () => join(workspaceManagedSkillsRoot(), "e2e-managed-runtime-skill");
const materializedSkillPath = () => join(materializedSkillRoot(), "SKILL.md");
const materializationManifestPath = () => join(workspaceManagedSkillsRoot(), ".veslo-materialization.json");
const skillMarkerPath = () => join(materializedSkillRoot(), ".veslo-managed.json");
const lockfilePath = () => join(workspaceRoot(), ".opencode", "veslo.skills.lock.json");
const managedSkillInstanceSelector = () =>
  `[data-skill-inventory-name="${E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.name}"]` +
  `[data-skill-inventory-scope="workspace"]` +
  `[data-skill-inventory-workspace-id="${E2E_SKILL_REGISTRY_WORKSPACE_ID}"]` +
  `[data-skill-inventory-lifecycle="active"]`;

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
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

async function waitForLocalVesloServerReady(timeout = 45_000): Promise<{
  baseUrl: string;
  clientToken: string;
  hostToken: string;
}> {
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
      timeoutMsg: "Local Veslo server did not become ready for skill materialization checks.",
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

async function fetchWorkspaceMaterializationStatus(
  connection: { baseUrl: string; clientToken: string },
): Promise<WorkspaceMaterializationStatus> {
  const response = await fetch(
    `${connection.baseUrl}/workspace/e2e-visual-workspace/skills/materialization`,
    {
      headers: {
        authorization: `Bearer ${connection.clientToken}`,
        accept: "application/json",
      },
    },
  );

  expect(response.status).toBe(200);
  return (await response.json()) as WorkspaceMaterializationStatus;
}

async function fetchWorkspaceSkills(
  connection: { baseUrl: string; clientToken: string },
): Promise<WorkspaceSkillListResponse> {
  const response = await fetch(
    `${connection.baseUrl}/workspace/${E2E_SKILL_REGISTRY_WORKSPACE_ID}/skills?includeGlobal=true`,
    {
      headers: {
        authorization: `Bearer ${connection.clientToken}`,
        accept: "application/json",
      },
    },
  );

  expect(response.status).toBe(200);
  return (await response.json()) as WorkspaceSkillListResponse;
}

async function syncWorkspaceMaterialization(
  connection: { baseUrl: string; hostToken: string },
  options: { activeRun?: boolean } = {},
): Promise<{ status: number; payload: WorkspaceMaterializationSyncStatus }> {
  const response = await fetch(
    `${connection.baseUrl}/workspace/${E2E_SKILL_REGISTRY_WORKSPACE_ID}/skills/materialization/sync`,
    {
      method: "POST",
      headers: {
        "x-veslo-host-token": connection.hostToken,
        "x-veslo-den-token": E2E_SKILL_REGISTRY_TOKEN,
        "x-veslo-den-org-id": E2E_SKILL_REGISTRY_ORG_ID,
        "x-veslo-den-user-id": E2E_SKILL_REGISTRY_USER_ID,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: options.activeRun ? JSON.stringify({ activeRun: true }) : undefined,
    },
  );

  return {
    status: response.status,
    payload: (await response.json()) as WorkspaceMaterializationSyncStatus,
  };
}

function readLockfile(): WorkspaceSkillLockfile {
  return JSON.parse(readFileSync(lockfilePath(), "utf8")) as WorkspaceSkillLockfile;
}

async function assertWorkspaceMaterializationEndpointSeesFixture(): Promise<void> {
  const connection = await waitForLocalVesloServerReady();
  await resetSkillRegistryFixtureState();

  rmSync(workspaceManagedSkillsRoot(), { recursive: true, force: true });
  rmSync(lockfilePath(), { force: true });

  const deferred = await syncWorkspaceMaterialization(connection, { activeRun: true });
  expect(deferred.status).toBe(202);
  expect(deferred.payload.synced).toBe(false);
  expect(deferred.payload.reloadRequired).toBe(true);
  expect(existsSync(materializedSkillPath())).toBe(false);
  expect(existsSync(lockfilePath())).toBe(false);

  const materialized = await syncWorkspaceMaterialization(connection);
  expect(materialized.status).toBe(200);
  const materializePayload = materialized.payload;
  expect(materializePayload.synced).toBe(true);
  expect(materializePayload.registryConfigured).toBe(true);
  expect(normalizePath(materializePayload.rootDir)).toBe(normalizePath(workspaceManagedSkillsRoot()));
  expect(materializePayload.materializedSkills.some((skill) =>
    skill.name === E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.name &&
    skill.packageSha256 === E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.archive.packageSha256
  )).toBe(true);
  expect(existsSync(materializedSkillPath())).toBe(true);
  expect(existsSync(skillMarkerPath())).toBe(true);
  expect(existsSync(materializationManifestPath())).toBe(true);
  expect(readFileSync(materializedSkillPath(), "utf8")).toContain("Managed materialized runtime fixture skill from the registry.");
  expect(readLockfile().skillSetRevision).toBe(E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetRevision);

  const status = await fetchWorkspaceMaterializationStatus(connection);
  expect(status.workspaceId).toBe("e2e-visual-workspace");
  expect(status.registryConfigured).toBe(true);
  expect(normalizePath(status.rootDir)).toBe(normalizePath(workspaceManagedSkillsRoot()));
  expect(status.materializedSkills.some((skill) => normalizePath(skill.skillDir ?? "") === normalizePath(materializedSkillRoot()))).toBe(true);
  expect(status.materializedSkills.find((skill) => skill.name === E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.name)).toMatchObject({
    installationId: E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.installationId,
    skillId: E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.skillId,
    name: E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.name,
    versionId: E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.versionId,
    packageSha256: E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.archive.packageSha256,
    target: "workspace",
  });

  const skillList = await fetchWorkspaceSkills(connection);
  const runtimeSkill = skillList.items.find((skill) => skill.name === E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.name);
  expect(runtimeSkill?.scope).toBe("project");
  expect(normalizePath(runtimeSkill?.path ?? "")).toBe(normalizePath(materializedSkillPath()));

  await useUpdatedRuntimeSkillVersion();
  const updated = await syncWorkspaceMaterialization(connection);
  expect(updated.status).toBe(200);
  expect(updated.payload.synced).toBe(true);
  expect(updated.payload.materializedSkills.find((skill) => skill.name === E2E_SKILL_REGISTRY_FIXTURE.runtimeSkillUpdated.name))
    .toMatchObject({
      versionId: E2E_SKILL_REGISTRY_FIXTURE.runtimeSkillUpdated.versionId,
      packageSha256: E2E_SKILL_REGISTRY_FIXTURE.runtimeSkillUpdated.archive.packageSha256,
    });
  expect(readFileSync(materializedSkillPath(), "utf8")).toContain("Updated approved managed runtime fixture skill from the registry.");
  const updatedLockfile = readLockfile();
  expect(updatedLockfile.skillSetRevision).toBe(E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetUpdatedRevision);
  expect(updatedLockfile.entries.find((entry) => entry.name === E2E_SKILL_REGISTRY_FIXTURE.runtimeSkillUpdated.name))
    .toMatchObject({
      versionId: E2E_SKILL_REGISTRY_FIXTURE.runtimeSkillUpdated.versionId,
      packageSha256: E2E_SKILL_REGISTRY_FIXTURE.runtimeSkillUpdated.archive.packageSha256,
    });
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

async function waitForManagedSkillCard(): Promise<InventoryCard> {
  let latestCards: InventoryCard[] = [];

  await browser.waitUntil(
    async () => {
      latestCards = await readInventoryCards();
      return latestCards.some((card) =>
        card.name === "e2e-managed-runtime-skill" &&
        card.scope === "workspace" &&
        card.workspaceId === "e2e-visual-workspace" &&
        card.section === "workspace-specific" &&
        card.text.includes("Updated approved managed runtime fixture skill")
      );
    },
    {
      timeout: 15_000,
      timeoutMsg: "Managed materialized skill fixture did not appear on the Skills page.",
    },
  );

  const card = latestCards.find((item) => item.name === "e2e-managed-runtime-skill");
  if (!card) throw new Error("Managed materialized skill card was not captured.");
  return card;
}

async function clickManagedSkillRemoveButton(): Promise<void> {
  let latestResult: {
    hasInstance: boolean;
    hasButton: boolean;
    disabled: boolean | null;
    text: string;
  } | null = null;

  await browser.waitUntil(
    async () => {
      latestResult = await browser.execute(
        (selector) => {
          const instance = document.querySelector<HTMLElement>(selector);
          const button = instance?.querySelector<HTMLButtonElement>('[data-testid="skill-inventory-deactivate-button"]');
          return {
            hasInstance: Boolean(instance),
            hasButton: Boolean(button),
            disabled: button?.disabled ?? null,
            text: instance?.innerText ?? "",
          };
        },
        managedSkillInstanceSelector(),
      );
      return Boolean(latestResult.hasInstance && latestResult.hasButton && latestResult.disabled === false);
    },
    {
      timeout: 10_000,
      timeoutMsg: "Managed skill remove button did not become enabled.",
    },
  );

  const clicked = await browser.execute(
    (selector) => {
      const button = document
        .querySelector<HTMLElement>(selector)
        ?.querySelector<HTMLButtonElement>('[data-testid="skill-inventory-deactivate-button"]');
      button?.click();
      return Boolean(button);
    },
    managedSkillInstanceSelector(),
  );
  expect(clicked).toBe(true);
}

async function removeManagedSkillThroughUi(): Promise<void> {
  await clickManagedSkillRemoveButton();
  await expect($('[data-testid="skill-uninstall-modal"]')).toExist();
  expect(await $('[data-testid="skill-uninstall-modal"]').getText()).toContain(E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.name);

  await $('[data-testid="skill-uninstall-confirm"]').click();
  await expect($('[data-testid="skill-uninstall-modal"]')).not.toExist();

  await browser.waitUntil(
    async () => {
      const events = await readSkillRegistryFixtureEvents();
      return events.deletedInstallationCalls.includes(E2E_SKILL_REGISTRY_FIXTURE.runtimeSkill.installationId);
    },
    {
      timeout: 10_000,
      timeoutMsg: "Managed skill removal did not call the registry installation delete endpoint.",
    },
  );
}

async function visibleBodyText(): Promise<string> {
  return browser.execute(() => document.body.innerText);
}

const runWhenIsolatedProfile = process.env.E2E_USE_EXISTING_PROFILE?.trim() === "1"
  ? describe.skip
  : describe;

runWhenIsolatedProfile("Skill registry materialization", () => {
  it("downloads registry packages, writes managed runtime files, and surfaces them in the desktop inventory", async () => {
    await assertWorkspaceMaterializationEndpointSeesFixture();

    await navigateToHash("/dashboard/skills");
    await waitForHashRoute("#/dashboard/skills");

    const page = await $('[data-testid="skills-page"]');
    await page.waitForExist({ timeout: 10_000 });

    const card = await waitForManagedSkillCard();

    expect(card.scope).toBe("workspace");
    expect(card.section).toBe("workspace-specific");

    await removeManagedSkillThroughUi();
    const bodyText = await visibleBodyText();
    expect(bodyText).not.toContain("Managed materialized skills must be edited through the registry");
    expect(bodyText).not.toContain("Skill instance path must point to SKILL.md");
  });
});
