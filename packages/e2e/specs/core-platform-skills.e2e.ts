import { expect } from "@wdio/globals";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";
import {
  E2E_SKILL_REGISTRY_FIXTURE,
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  E2E_SKILL_REGISTRY_USER_ID,
  readSkillRegistryFixtureBaseUrl,
  resetSkillRegistryFixtureState,
} from "../helpers/skill-registry-fixture.js";

type InventoryCard = {
  name: string;
  scope: string;
  workspaceId: string;
  section: "all-workspaces" | "workspace-specific" | "unknown";
  text: string;
  deactivateButtonDisabled: boolean | null;
  deactivateButtonTitle: string;
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

type VesloServerConnection = {
  baseUrl: string;
  clientToken: string;
  hostToken: string;
};

type GlobalMaterializationStatus = {
  scope: "personal-global";
  status: string;
  registryConfigured: boolean;
  rootDir: string;
  synced?: boolean;
  materializedSkills: Array<{
    installationId: string;
    skillId: string;
    name: string;
    versionId: string;
    packageSha256: string;
    target: string;
    skillDir?: string;
  }>;
};

type ManagedMarker = {
  installationId?: string;
  skillId?: string;
  name?: string;
  versionId?: string;
  packageSha256?: string;
  target?: string;
  skillDir?: string;
};

const coreSkill = E2E_SKILL_REGISTRY_FIXTURE.corePlatformDocxSkill;
const corePlatformInventoryScopes = new Set(["platform", "user-global"]);
const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const workspaceRoot = () => join(isolatedProfileRoot(), "workspaces", "visual-workspace");
const userManagedSkillsRoot = () => join(isolatedProfileRoot(), ".config", "opencode", "skills", "veslo-managed");
const coreSkillRoot = () => join(userManagedSkillsRoot(), coreSkill.name);
const coreSkillPath = () => join(coreSkillRoot(), "SKILL.md");
const coreSkillMarkerPath = () => join(coreSkillRoot(), ".veslo-managed.json");
const internalRoot = () => join(workspaceRoot(), ".opencode", "veslo", "internal");
const delegatePluginPath = () => join(workspaceRoot(), ".opencode", "plugins", "veslo-delegate.js");
const agentsRoot = () => join(workspaceRoot(), ".opencode", "agents");

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

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function internalAgentFileNames(): string[] {
  if (!existsSync(agentsRoot())) return [];
  return readdirSync(agentsRoot()).filter((name) => /^veslo-internal-.*\.md$/.test(name));
}

function readManagedMarker(): ManagedMarker {
  return JSON.parse(readFileSync(coreSkillMarkerPath(), "utf8")) as ManagedMarker;
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
      timeoutMsg: "Local Veslo server did not become ready before core platform skill materialization.",
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

async function syncCorePlatformGlobalMaterialization(
  connection: VesloServerConnection,
): Promise<GlobalMaterializationStatus> {
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

  const payload = (await response.json()) as GlobalMaterializationStatus;
  expect(payload.scope).toBe("personal-global");
  expect(payload.synced).toBe(true);
  expect(payload.materializedSkills.find((skill) => skill.name === coreSkill.name)).toMatchObject({
    installationId: `rollout:${E2E_SKILL_REGISTRY_FIXTURE.corePlatformDocxPolicyId}`,
    skillId: coreSkill.skillId,
    name: coreSkill.name,
    versionId: coreSkill.versionId,
    packageSha256: coreSkill.archive.packageSha256,
    target: "personal-global",
  });
  return payload;
}

async function fetchGlobalMaterializationStatus(
  connection: VesloServerConnection,
): Promise<GlobalMaterializationStatus> {
  const response = await fetch(`${connection.baseUrl}/skills/materialization`, {
    headers: {
      authorization: `Bearer ${connection.clientToken}`,
      accept: "application/json",
    },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as GlobalMaterializationStatus;
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
      const deactivateButton = card.querySelector<HTMLButtonElement>('[data-testid="skill-inventory-deactivate-button"]');

      return {
        name: card.dataset.skillInventoryName ?? "",
        scope: card.dataset.skillInventoryScope ?? "",
        workspaceId: card.dataset.skillInventoryWorkspaceId ?? "",
        section,
        text: card.innerText,
        deactivateButtonDisabled: deactivateButton ? deactivateButton.disabled : null,
        deactivateButtonTitle: deactivateButton?.getAttribute("title") ?? "",
      };
    });
  });
}

async function waitForCoreSkillInventoryCard(): Promise<InventoryCard> {
  let latestCards: InventoryCard[] = [];
  await browser.waitUntil(
    async () => {
      latestCards = await readInventoryCards();
      return latestCards.some((card) =>
        card.name === coreSkill.name &&
        corePlatformInventoryScopes.has(card.scope) &&
        card.section === "all-workspaces" &&
        card.text.includes(coreSkill.archive.metadata.description ?? "")
      );
    },
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: `Core platform skill ${coreSkill.name} did not appear in global skill inventory.`,
    },
  );

  const card = latestCards.find((candidate) =>
    candidate.name === coreSkill.name && corePlatformInventoryScopes.has(candidate.scope)
  );
  if (!card) throw new Error(`Core platform skill ${coreSkill.name} inventory card was not captured.`);
  return card;
}

async function refreshSkillsInventoryFromUi(): Promise<void> {
  const clicked = await browser.execute(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="skills-refresh-button"]');
    button?.click();
    return Boolean(button);
  });
  expect(clicked).toBe(true);
}

async function visibleBodyText(): Promise<string> {
  return browser.execute(() => document.body.innerText);
}

const runWhenLegacyWdioCorePlatformEnabled =
  process.env.E2E_ENABLE_LEGACY_WDIO_CORE_PLATFORM_SKILLS?.trim() === "1" &&
    process.env.E2E_USE_EXISTING_PROFILE?.trim() !== "1"
    ? describe
    : describe.skip;

runWhenLegacyWdioCorePlatformEnabled("Core platform skills", () => {
  it("materializes veslo-docx through the registry-only global rollout flow without internal delegation artifacts", async () => {
    await resetSkillRegistryFixtureState();
    rmSync(userManagedSkillsRoot(), { recursive: true, force: true });

    await prepareLocalDesktopRuntime("/dashboard/skills");
    const connection = await waitForLocalVesloServerReady();
    await waitForAppVesloServerConnected();

    await syncCorePlatformGlobalMaterialization(connection);
    expect(existsSync(coreSkillPath())).toBe(true);
    expect(readFileSync(coreSkillPath(), "utf8")).toContain(coreSkill.archive.metadata.description ?? "");

    const marker = readManagedMarker();
    expect(marker).toMatchObject({
      installationId: `rollout:${E2E_SKILL_REGISTRY_FIXTURE.corePlatformDocxPolicyId}`,
      skillId: coreSkill.skillId,
      name: coreSkill.name,
      versionId: coreSkill.versionId,
      packageSha256: coreSkill.archive.packageSha256,
      target: "personal-global",
      skillDir: coreSkillRoot(),
    });

    const status = await fetchGlobalMaterializationStatus(connection);
    expect(normalizePath(status.rootDir)).toBe(normalizePath(userManagedSkillsRoot()));
    expect(status.materializedSkills.find((skill) => skill.name === coreSkill.name)).toMatchObject({
      installationId: `rollout:${E2E_SKILL_REGISTRY_FIXTURE.corePlatformDocxPolicyId}`,
      skillId: coreSkill.skillId,
      versionId: coreSkill.versionId,
      packageSha256: coreSkill.archive.packageSha256,
      target: "personal-global",
      skillDir: coreSkillRoot(),
    });

    expect(existsSync(internalRoot())).toBe(false);
    expect(existsSync(delegatePluginPath())).toBe(false);
    expect(internalAgentFileNames()).toEqual([]);

    await refreshSkillsInventoryFromUi();
    const card = await waitForCoreSkillInventoryCard();
    expect(corePlatformInventoryScopes.has(card.scope)).toBe(true);
    expect(card.workspaceId).toBe("");
    expect(card.section).toBe("all-workspaces");

    if (card.text.includes("Platform") || card.deactivateButtonTitle.includes("locked")) {
      expect(card.text).toContain("Platform");
      expect(card.deactivateButtonDisabled).toBe(true);
    }
  });
});
