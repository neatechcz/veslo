import { expect } from "@wdio/globals";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";
import {
  E2E_SKILL_REGISTRY_FIXTURE,
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  E2E_SKILL_REGISTRY_USER_ID,
  E2E_SKILL_REGISTRY_WORKSPACE_ID,
  readSkillRegistryFixtureBaseUrl,
  resetSkillRegistryFixtureState,
  useUpdatedRuntimeSkillVersion,
} from "../helpers/skill-registry-fixture.js";
import {
  readStandaloneWorkspaceLockfile,
  startStandaloneVesloServerProfile,
  syncStandaloneWorkspaceSkillMaterialization,
  type WorkspaceSkillLockfile,
} from "../helpers/veslo-server-process.js";

type InventoryCard = {
  name: string;
  scope: string;
  workspaceId: string;
  section: "all-workspaces" | "workspace-specific" | "unknown";
  text: string;
};

type EffectiveSkill = {
  name: string;
  path: string;
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

const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const workspaceRoot = () => join(isolatedProfileRoot(), "workspaces", "visual-workspace");
const workspaceSkillsRoot = () => join(workspaceRoot(), ".opencode", "skills");
const workspaceManagedSkillsRoot = () => join(workspaceSkillsRoot(), "veslo-managed");
const globalSkillsRoot = () => join(isolatedProfileRoot(), ".config", "opencode", "skills");
const lockfilePath = () => join(workspaceRoot(), ".opencode", "veslo.skills.lock.json");

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function writeSkill(root: string, name: string, description: string): string {
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
    "utf8",
  );
  return skillDir;
}

function seedPersonalGlobalShadowFixture(): void {
  rmSync(workspaceManagedSkillsRoot(), { recursive: true, force: true });
  rmSync(lockfilePath(), { force: true });
  writeSkill(
    globalSkillsRoot(),
    "e2e-org-shadowed-skill",
    "Personal global copy that must not win the effective shared workspace resolution.",
  );
}

function listSkillDirsOneLevel(root: string): string[] {
  if (!existsSync(root)) return [];

  const skillDirs: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const direct = join(root, entry.name);
    if (existsSync(join(direct, "SKILL.md"))) {
      skillDirs.push(direct);
      continue;
    }

    for (const nested of readdirSync(direct, { withFileTypes: true })) {
      if (!nested.isDirectory()) continue;
      const nestedDir = join(direct, nested.name);
      if (existsSync(join(nestedDir, "SKILL.md"))) skillDirs.push(nestedDir);
    }
  }

  return skillDirs;
}

function resolveEffectiveSkillsForSharedWorkspace(): EffectiveSkill[] {
  const seen = new Set<string>();
  const skills: EffectiveSkill[] = [];

  for (const root of [workspaceSkillsRoot(), globalSkillsRoot()]) {
    for (const skillDir of listSkillDirsOneLevel(root)) {
      const name = skillDir.split(/[\\/]/).at(-1) ?? "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      skills.push({ name, path: skillDir });
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function readLockfileFixture(): {
  workspaceId: string;
  skillSetId: string;
  skillSetRevision: string;
  entries: Array<{ name: string; packageSha256: string; installationId: string; versionId: string; skillId: string }>;
} {
  return JSON.parse(readFileSync(lockfilePath(), "utf8"));
}

function lockfileEntryFingerprint(lockfile: Pick<WorkspaceSkillLockfile, "entries">): string[] {
  return lockfile.entries
    .map((entry) => `${entry.skillId}:${entry.versionId}:${entry.packageSha256}`)
    .sort();
}

async function assertStandaloneProfileLockMaterialization(
  profileName: string,
  userId: string,
): Promise<{
  profileRoot: string;
  workspaceRoot: string;
  workspaceId: string;
  lockfilePath: string;
  lockfile: WorkspaceSkillLockfile;
}> {
  const profile = await startStandaloneVesloServerProfile({
    profileName,
    profileRoot: join(isolatedProfileRoot(), "shared-profile-materialization", profileName),
    registryBaseUrl: readSkillRegistryFixtureBaseUrl(),
  });

  try {
    const syncPayload = await syncStandaloneWorkspaceSkillMaterialization({
      profile,
      denToken: E2E_SKILL_REGISTRY_TOKEN,
      orgId: E2E_SKILL_REGISTRY_ORG_ID,
      userId,
    }) as WorkspaceMaterializationSyncStatus;
    const lockfile = readStandaloneWorkspaceLockfile(profile);

    expect(syncPayload.synced).toBe(true);
    expect(syncPayload.workspaceId).toBe(profile.workspaceId);
    expect(syncPayload.materializedSkills.map((skill) => skill.name).sort()).toEqual([
      "e2e-managed-runtime-skill",
      "e2e-org-locked-skill",
      "e2e-org-shadowed-skill",
    ]);
    expect(lockfile.workspaceId).toBe(profile.workspaceId);
    expect(lockfile.skillSetId).toBe(E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetId);
    expect(lockfile.skillSetRevision).toBe(E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetUpdatedRevision);
    expect(lockfile.entries.map((entry) => entry.name).sort()).toEqual([
      "e2e-managed-runtime-skill",
      "e2e-org-locked-skill",
      "e2e-org-shadowed-skill",
    ]);
    expect(lockfile.entries.map((entry) => entry.skillId)).not.toContain(
      E2E_SKILL_REGISTRY_FIXTURE.personalShadowSkill.skillId,
    );
    expect(lockfile.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.packageSha256))).toBe(true);

    return {
      profileRoot: profile.profileRoot,
      workspaceRoot: profile.workspaceRoot,
      workspaceId: profile.workspaceId,
      lockfilePath: profile.lockfilePath,
      lockfile,
    };
  } finally {
    await profile.stop();
  }
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
      timeoutMsg: "Local Veslo server did not become ready for shared skill lock checks.",
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

async function assertWorkspaceLockMaterializationContract(userId: string): Promise<ReturnType<typeof readLockfileFixture>> {
  const connection = await waitForLocalVesloServerReady();
  rmSync(workspaceManagedSkillsRoot(), { recursive: true, force: true });
  rmSync(lockfilePath(), { force: true });

  const materializeResponse = await fetch(
    `${connection.baseUrl}/workspace/${E2E_SKILL_REGISTRY_WORKSPACE_ID}/skills/materialization/sync`,
    {
      method: "POST",
      headers: {
        "x-veslo-host-token": connection.hostToken,
        "x-veslo-den-token": E2E_SKILL_REGISTRY_TOKEN,
        "x-veslo-den-org-id": E2E_SKILL_REGISTRY_ORG_ID,
        "x-veslo-den-user-id": userId,
        "content-type": "application/json",
        accept: "application/json",
      },
    },
  );

  expect(materializeResponse.status).toBe(200);
  const materializePayload = (await materializeResponse.json()) as WorkspaceMaterializationSyncStatus;
  expect(materializePayload.synced).toBe(true);
  expect(materializePayload.materializedSkills.map((skill) => skill.name)).toContain("e2e-org-shadowed-skill");
  expect(materializePayload.materializedSkills.map((skill) => skill.skillId)).not.toContain(
    E2E_SKILL_REGISTRY_FIXTURE.personalShadowSkill.skillId,
  );

  const status = await fetchWorkspaceMaterializationStatus(connection);
  const materializedByName = new Map(status.materializedSkills.map((skill) => [skill.name, skill]));
  const lockfile = readLockfileFixture();

  expect(status.workspaceId).toBe("e2e-visual-workspace");
  expect(status.registryConfigured).toBe(true);
  expect(normalizePath(status.rootDir)).toBe(normalizePath(workspaceManagedSkillsRoot()));
  const materializedNames = [...materializedByName.keys()].sort();
  for (const expected of [
    "e2e-managed-runtime-skill",
    "e2e-org-locked-skill",
    "e2e-org-shadowed-skill",
  ]) {
    expect(materializedNames).toContain(expected);
  }
  for (const entry of lockfile.entries) {
    expect(materializedByName.get(entry.name)?.packageSha256).toBe(entry.packageSha256);
  }

  const syncResponse = await fetch(
    `${connection.baseUrl}/workspace/${E2E_SKILL_REGISTRY_WORKSPACE_ID}/skills/materialization/sync`,
    {
      method: "POST",
      headers: {
        "x-veslo-host-token": connection.hostToken,
        "x-veslo-den-token": E2E_SKILL_REGISTRY_TOKEN,
        "x-veslo-den-org-id": E2E_SKILL_REGISTRY_ORG_ID,
        "x-veslo-den-user-id": userId,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ activeRun: true }),
    },
  );

  expect(syncResponse.status).toBe(202);
  const syncPayload = (await syncResponse.json()) as WorkspaceMaterializationSyncStatus;
  expect(syncPayload.workspaceId).toBe("e2e-visual-workspace");
  expect(syncPayload.synced).toBe(false);
  expect(syncPayload.reloadRequired).toBe(true);
  expect(normalizePath(syncPayload.rootDir)).toBe(normalizePath(workspaceManagedSkillsRoot()));
  const activeRunSkillNames = syncPayload.materializedSkills.map((skill) => skill.name).sort();
  for (const expected of [
    "e2e-managed-runtime-skill",
    "e2e-org-locked-skill",
    "e2e-org-shadowed-skill",
  ]) {
    expect(activeRunSkillNames).toContain(expected);
  }

  return lockfile;
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

async function waitForSharedWorkspaceCards(): Promise<InventoryCard[]> {
  let latestCards: InventoryCard[] = [];

  await browser.waitUntil(
    async () => {
      latestCards = await readInventoryCards();
      const shadowedCards = latestCards.filter((card) => card.name === "e2e-org-shadowed-skill");
      const hasWorkspaceShadowed = shadowedCards.some((card) =>
        card.scope === "workspace" &&
        card.workspaceId === "e2e-visual-workspace" &&
        card.section === "workspace-specific" &&
        card.text.includes("Organization-managed workspace skill")
      );
      const hasGlobalShadowed = shadowedCards.some((card) =>
        card.scope === "user-global" &&
        card.section === "all-workspaces" &&
        card.text.includes("Personal global copy")
      );
      const hasLocked = latestCards.some((card) =>
        card.name === "e2e-org-locked-skill" &&
        card.scope === "workspace" &&
        card.workspaceId === "e2e-visual-workspace" &&
        card.section === "workspace-specific"
      );

      return shadowedCards.length === 2 && hasWorkspaceShadowed && hasGlobalShadowed && hasLocked;
    },
    {
      timeout: 15_000,
      timeoutMsg: "Shared workspace lock fixture did not appear on the Skills page.",
    },
  );

  return latestCards;
}

const runWhenIsolatedProfile = process.env.E2E_USE_EXISTING_PROFILE?.trim() === "1"
  ? describe.skip
  : describe;

runWhenIsolatedProfile("Shared workspace skill lock", () => {
  it("keeps lockfile entries consistent and resolves org-managed skills before personal globals", async () => {
    seedPersonalGlobalShadowFixture();
    await resetSkillRegistryFixtureState();
    await useUpdatedRuntimeSkillVersion();

    const firstProfileLock = await assertStandaloneProfileLockMaterialization(
      "first-profile",
      E2E_SKILL_REGISTRY_USER_ID,
    );
    const secondProfileLock = await assertStandaloneProfileLockMaterialization(
      "second-profile",
      "user_veslo_e2e_second",
    );
    const lockfile = await assertWorkspaceLockMaterializationContract(E2E_SKILL_REGISTRY_USER_ID);

    const effectiveSkills = resolveEffectiveSkillsForSharedWorkspace();
    const shadowedEffectiveSkills = effectiveSkills.filter((skill) => skill.name === "e2e-org-shadowed-skill");

    expect(normalizePath(firstProfileLock.profileRoot)).not.toBe(normalizePath(secondProfileLock.profileRoot));
    expect(normalizePath(firstProfileLock.workspaceRoot)).not.toBe(normalizePath(secondProfileLock.workspaceRoot));
    expect(normalizePath(firstProfileLock.lockfilePath)).not.toBe(normalizePath(secondProfileLock.lockfilePath));
    expect(firstProfileLock.workspaceId).not.toBe(secondProfileLock.workspaceId);
    expect(firstProfileLock.lockfile.skillSetId).toBe(lockfile.skillSetId);
    expect(secondProfileLock.lockfile.skillSetId).toBe(lockfile.skillSetId);
    expect(firstProfileLock.lockfile.skillSetRevision).toBe(lockfile.skillSetRevision);
    expect(secondProfileLock.lockfile.skillSetRevision).toBe(lockfile.skillSetRevision);
    expect(lockfileEntryFingerprint(firstProfileLock.lockfile)).toEqual(lockfileEntryFingerprint(lockfile));
    expect(lockfileEntryFingerprint(secondProfileLock.lockfile)).toEqual(lockfileEntryFingerprint(lockfile));

    expect(existsSync(lockfilePath())).toBe(true);
    expect(lockfile.workspaceId).toBe("e2e-visual-workspace");
    expect(lockfile.skillSetId).toBe(E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetId);
    expect(lockfile.skillSetRevision).toBe(E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetUpdatedRevision);
    const lockfileNames = lockfile.entries.map((entry) => entry.name).sort();
    for (const expected of [
      "e2e-managed-runtime-skill",
      "e2e-org-locked-skill",
      "e2e-org-shadowed-skill",
    ]) {
      expect(lockfileNames).toContain(expected);
    }
    expect(lockfile.entries.map((entry) => entry.skillId)).not.toContain(E2E_SKILL_REGISTRY_FIXTURE.personalShadowSkill.skillId);
    expect(lockfile.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.packageSha256))).toBe(true);
    expect(shadowedEffectiveSkills).toHaveLength(1);
    expect(shadowedEffectiveSkills[0]?.path.replace(/\\/g, "/")).toContain(
      "/.opencode/skills/veslo-managed/e2e-org-shadowed-skill",
    );

    await navigateToHash("/dashboard/skills");
    await waitForHashRoute("#/dashboard/skills");

    const page = await $('[data-testid="skills-page"]');
    await page.waitForExist({ timeout: 10_000 });

    const cards = await waitForSharedWorkspaceCards();
    const workspaceCards = cards.filter((card) =>
      card.name === "e2e-org-shadowed-skill" && card.scope === "workspace"
    );

    expect(workspaceCards).toHaveLength(1);
  });
});
