import { expect } from "@wdio/globals";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type EngineInfo = {
  running: boolean;
  baseUrl: string | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
};

type WorkspaceInfo = {
  id: string;
  path: string;
  directory?: string | null;
};

type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

type InventoryCard = {
  name: string;
  scope: string;
  workspaceId: string;
  section: "all-workspaces" | "workspace-specific" | "unknown";
};

const isolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const globalSkillsRoot = () => join(isolatedProfileRoot(), ".config", "opencode", "skills");
const TEST_SKILL_NAME = "e2e-user-only-private-chat-skill";

function trimText(value: string | null | undefined) {
  return (value ?? "").trim();
}

function writeUserSkill(): void {
  const skillDir = join(globalSkillsRoot(), TEST_SKILL_NAME);
  rmSync(skillDir, { recursive: true, force: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      `# ${TEST_SKILL_NAME}`,
      "",
      "User-global fixture skill that must not be copied into private chat workspaces.",
      "",
    ].join("\n"),
  );
}

async function tauriInvoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.executeAsync(
    (
      args: { command: string; payload: Record<string, unknown> },
      done: (value: { ok: boolean; value?: unknown; error?: string }) => void,
    ) => {
      const invoke = (
        window as typeof window & {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;

      if (typeof invoke !== "function") {
        done({ ok: false, error: "Tauri invoke bridge is unavailable" });
        return;
      }

      invoke(args.command, args.payload).then(
        (value) => done({ ok: true, value }),
        (error) =>
          done({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    },
    { command, payload },
  ) as { ok: boolean; value?: T; error?: string };

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? "unknown error"}`);
  }

  return result.value as T;
}

async function activeWorkspace(): Promise<WorkspaceInfo> {
  const bootstrap = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
  const active = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.activeId);
  if (!active?.path) {
    throw new Error("Active workspace is not ready");
  }
  return active;
}

function workspaceSkillPath(workspacePath: string): string {
  return join(workspacePath, ".opencode", "skills", TEST_SKILL_NAME, "SKILL.md");
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
      };
    });
  });
}

async function waitForPrivateChatSkillInventory(): Promise<InventoryCard[]> {
  let latestCards: InventoryCard[] = [];
  await navigateToHash("/dashboard/skills");
  await waitForHashRoute("#/dashboard/skills", 10_000);
  await browser.waitUntil(
    async () => {
      latestCards = await readInventoryCards();
      return latestCards.some((card) => card.name === TEST_SKILL_NAME);
    },
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: `User skill ${TEST_SKILL_NAME} did not appear in Skills inventory.`,
    },
  );
  return latestCards;
}

async function ensureActiveEngineStarted(): Promise<void> {
  const existing = await tauriInvoke<EngineInfo>("engine_info").catch(() => null);
  if (existing?.running && trimText(existing.baseUrl)) return;

  const workspace = await activeWorkspace();
  const directory = trimText(workspace.directory) || trimText(workspace.path);
  if (!directory) throw new Error("Active workspace directory is not ready");

  await tauriInvoke<EngineInfo>("engine_start", {
    projectDir: directory,
    preferSidecar: true,
    runtime: "direct",
    workspacePaths: [directory],
  });
}

async function createPrivateWorkspace(): Promise<WorkspaceInfo> {
  const privateRoot = await tauriInvoke<string>("workspace_private_root");
  const folder = join(privateRoot, `${Date.now()}-e2e-user-skills-chat`);
  const created = await tauriInvoke<WorkspaceList>("workspace_create", {
    folderPath: folder,
    name: "Private workspace",
    preset: "starter",
  });
  const active = created.workspaces.find((workspace) => workspace.id === created.activeId);
  if (!active?.path) {
    throw new Error("Created private workspace was not active");
  }
  return active;
}

async function createSessionInActiveWorkspace(): Promise<string> {
  const { baseUrl, opencodeUsername, opencodePassword } = await tauriInvoke<EngineInfo>("engine_info");
  const workspace = await activeWorkspace();
  const directory = trimText(workspace.directory) || trimText(workspace.path);
  if (!baseUrl || !directory) throw new Error("Active engine context is not ready");

  // @ts-expect-error -- shared app test utilities are JS-only in this workspace.
  const { makeClient, waitForHealthy } = await import("../../app/scripts/_util.mjs");
  const client = makeClient({
    baseUrl,
    directory,
    auth: {
      username: trimText(opencodeUsername) || undefined,
      password: trimText(opencodePassword) || undefined,
    },
  });
  await waitForHealthy(client, { timeoutMs: 20_000, pollMs: 250 });
  const created = await client.session.create({
    title: `Private chat user skill copy check ${Date.now()}`,
    directory,
  });
  return String(created.id ?? "");
}

describe("Private chat user skills", () => {
  before(async () => {
    await navigateToHash("/session");
    await waitForHashRoute("#/session", 5_000);
  });

  it("does not copy user-global skills into a newly created private chat workspace", async () => {
    writeUserSkill();

    const workspaceAfterScratchCreate = await createPrivateWorkspace();
    expect(workspaceAfterScratchCreate.path).toContain("private-workspaces");
    expect(existsSync(workspaceSkillPath(workspaceAfterScratchCreate.path))).toBe(false);

    await ensureActiveEngineStarted();
    const sessionId = await createSessionInActiveWorkspace();
    expect(sessionId.length).toBeGreaterThan(0);

    const workspaceAfterRuntimeStart = await activeWorkspace();
    expect(workspaceAfterRuntimeStart.id).toBe(workspaceAfterScratchCreate.id);
    expect(existsSync(workspaceSkillPath(workspaceAfterRuntimeStart.path))).toBe(false);

    const cards = await waitForPrivateChatSkillInventory();
    const matchingCards = cards.filter((card) => card.name === TEST_SKILL_NAME);
    expect(matchingCards).toHaveLength(1);
    expect(matchingCards[0]!.scope).toBe("user-global");
    expect(matchingCards[0]!.section).toBe("all-workspaces");
    expect(matchingCards[0]!.workspaceId).toBe("");
  });
});
