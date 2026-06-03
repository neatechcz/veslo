import { expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { navigateToHash, waitForHashRoute } from "../helpers/app-launcher.js";

type WorkspaceInfo = {
  id: string;
  path: string;
  directory?: string | null;
};

type WorkspaceList = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

type SeededSessionTree = {
  parentId: string;
  parentTitle: string;
  childId: string;
  childTitle: string;
};

type CollapseMetrics = {
  exists: boolean;
  height: string;
  opacity: string;
  region: string | null;
  renderedText: string;
  transform: string;
  transition: string;
};

const WAIT_TIMEOUT_MS = 20_000;
const SIDEBAR_VIEW_MODE_KEY = "veslo.sidebar-session-view.v1";
const SIDEBAR_COLLAPSED_PROJECTS_KEY = "veslo.sidebar-collapsed-projects.v1";
const SIDEBAR_EXPANDED_PARENT_SESSIONS_KEY = "veslo.sidebar-expanded-parent-sessions.v1";
const SESSION_ROW_SELECTOR = '[data-session-sidebar-row="true"]';
const SESSION_BRANCH_REGION_SELECTOR = '[data-sidebar-collapse-region="session-branch"]';
const PROJECT_REGION_SELECTOR = '[data-sidebar-collapse-region="project"]';

const defaultIsolatedProfileRoot = () => join(process.cwd(), ".tmp-veslo-home");
const sidebarWorkspaceRoot = () =>
  join(defaultIsolatedProfileRoot(), "workspaces", "sidebar-collapse-animation-workspace");
const opencodeDbPath = () => join(defaultIsolatedProfileRoot(), ".local", "share", "opencode", "opencode.db");

function trimText(value: string | null | undefined) {
  return (value ?? "").trim();
}

function normalizePath(value: string | null | undefined): string {
  return trimText(value).replace(/\\/g, "/").replace(/\/+$/, "");
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

async function ensureSidebarWorkspaceActive(): Promise<string> {
  const directory = sidebarWorkspaceRoot();
  mkdirSync(directory, { recursive: true });

  const before = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
  let workspace = before.workspaces.find((candidate) => normalizePath(candidate.path) === normalizePath(directory));

  if (!workspace) {
    await tauriInvoke<WorkspaceList>("workspace_create", {
      folderPath: directory,
      name: "Sidebar Collapse Animation Workspace",
      preset: "starter",
    });
    const afterCreate = await tauriInvoke<WorkspaceList>("workspace_bootstrap");
    workspace = afterCreate.workspaces.find((candidate) => normalizePath(candidate.path) === normalizePath(directory));
  }

  if (!workspace?.id) {
    throw new Error("Sidebar collapse animation workspace was not registered.");
  }

  await tauriInvoke<WorkspaceList>("workspace_set_active", {
    workspaceId: workspace.id,
    promoteToFront: true,
  });

  return directory;
}

function sqlite3Command(): string {
  if (existsSync("/usr/bin/sqlite3")) return "/usr/bin/sqlite3";
  if (existsSync("/opt/homebrew/bin/sqlite3")) return "/opt/homebrew/bin/sqlite3";
  return "sqlite3";
}

function sql(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function slugForTitle(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "session";
}

function seedOpenCodeDbSessionTree(input: SeededSessionTree & { directory: string }) {
  const dbPath = opencodeDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  const now = Date.now();
  const projectId = `project-${input.parentId}`;
  const script = `
PRAGMA foreign_keys = OFF;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS project (
  id text PRIMARY KEY,
  worktree text NOT NULL,
  vcs text,
  name text,
  icon_url text,
  icon_color text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_initialized integer,
  sandboxes text NOT NULL,
  commands text,
  icon_url_override text
);
CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  parent_id text,
  slug text NOT NULL,
  directory text NOT NULL,
  title text NOT NULL,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  revert text,
  permission text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_compacting integer,
  time_archived integer,
  workspace_id text,
  path text
);
INSERT OR REPLACE INTO project (
  id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands, icon_url_override
) VALUES (
  ${sql(projectId)}, ${sql(input.directory)}, NULL, ${sql("Sidebar Collapse Animation Workspace")}, NULL, NULL, ${sql(now)}, ${sql(now)}, NULL, ${sql("[]")}, NULL, NULL
);
INSERT OR REPLACE INTO session (
  id, project_id, parent_id, slug, directory, title, version, share_url,
  summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
  time_created, time_updated, time_compacting, time_archived, workspace_id, path
) VALUES (
  ${sql(input.parentId)}, ${sql(projectId)}, NULL, ${sql(slugForTitle(input.parentTitle))},
  ${sql(input.directory)}, ${sql(input.parentTitle)}, ${sql("0.0.0")}, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, ${sql(now)}, ${sql(now)}, NULL, NULL, NULL, ${sql(input.directory)}
);
INSERT OR REPLACE INTO session (
  id, project_id, parent_id, slug, directory, title, version, share_url,
  summary_additions, summary_deletions, summary_files, summary_diffs, revert, permission,
  time_created, time_updated, time_compacting, time_archived, workspace_id, path
) VALUES (
  ${sql(input.childId)}, ${sql(projectId)}, ${sql(input.parentId)}, ${sql(slugForTitle(input.childTitle))},
  ${sql(input.directory)}, ${sql(input.childTitle)}, ${sql("0.0.0")}, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, ${sql(now + 1)}, ${sql(now + 1)}, NULL, NULL, NULL, ${sql(input.directory)}
);
`;
  execFileSync(sqlite3Command(), [dbPath], { input: script });
}

async function seedSessionTree(): Promise<SeededSessionTree> {
  const directory = await ensureSidebarWorkspaceActive();
  const runId = `e2e-sidebar-collapse-${Date.now()}`;
  const tree = {
    parentId: `${runId}-parent`,
    parentTitle: `${runId} parent`,
    childId: `${runId}-child`,
    childTitle: `${runId} subagent`,
  };

  seedOpenCodeDbSessionTree({ ...tree, directory });
  return tree;
}

async function setSidebarMode(mode: "by-project" | "recent") {
  await browser.execute(
    (
      viewModeKey: string,
      collapsedProjectsKey: string,
      expandedParentSessionsKey: string,
      nextMode: "by-project" | "recent",
    ) => {
      localStorage.setItem(viewModeKey, nextMode);
      localStorage.removeItem(collapsedProjectsKey);
      localStorage.removeItem(expandedParentSessionsKey);
    },
    SIDEBAR_VIEW_MODE_KEY,
    SIDEBAR_COLLAPSED_PROJECTS_KEY,
    SIDEBAR_EXPANDED_PARENT_SESSIONS_KEY,
    mode,
  );
}

async function forceNoReducedMotion() {
  await browser.execute(() => {
    const state = window as typeof window & {
      __vesloE2eOriginalMatchMedia?: typeof window.matchMedia;
    };
    if (!state.__vesloE2eOriginalMatchMedia) {
      state.__vesloE2eOriginalMatchMedia = window.matchMedia.bind(window);
    }
    const originalMatchMedia = state.__vesloE2eOriginalMatchMedia;

    window.matchMedia = (query: string): MediaQueryList => {
      const result = originalMatchMedia(query);
      if (!query.includes("prefers-reduced-motion")) return result;

      return {
        media: query,
        matches: false,
        onchange: null,
        addEventListener: result.addEventListener.bind(result),
        removeEventListener: result.removeEventListener.bind(result),
        dispatchEvent: result.dispatchEvent.bind(result),
        addListener: result.addListener.bind(result),
        removeListener: result.removeListener.bind(result),
      };
    };
  });
}

async function waitForSidebarRow(title: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (selector: string, expectedTitle: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector)).some((row) =>
            row.textContent?.includes(expectedTitle),
          ),
        SESSION_ROW_SELECTOR,
        title,
      ),
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 250,
      timeoutMsg: `Sidebar row did not appear: ${title}`,
    },
  );
}

async function clickSidebarRow(title: string) {
  const result = await browser.execute(
    (selector: string, expectedTitle: string) => {
      const row = Array.from(document.querySelectorAll<HTMLElement>(selector)).find((candidate) =>
        candidate.textContent?.includes(expectedTitle),
      );
      if (!row) {
        return {
          clicked: false,
          rows: Array.from(document.querySelectorAll<HTMLElement>(selector)).map((candidate) =>
            candidate.textContent?.trim() ?? "",
          ),
        };
      }
      row.scrollIntoView({ block: "center" });
      row.click();
      return { clicked: true, rows: [] };
    },
    SESSION_ROW_SELECTOR,
    title,
  ) as { clicked: boolean; rows: string[] };

  if (!result.clicked) {
    throw new Error(`Could not click sidebar row "${title}". Visible rows: ${JSON.stringify(result.rows)}`);
  }
}

async function clickProjectHeaderContaining(title: string) {
  const result = await browser.execute((expectedTitle: string) => {
    const projects = Array.from(document.querySelectorAll<HTMLElement>("[data-project-key]"));
    const project = projects.find((candidate) => candidate.textContent?.includes(expectedTitle));
    const button = project?.querySelector<HTMLButtonElement>("button");
    if (!project || !button) {
      return {
        clicked: false,
        projects: projects.map((candidate) => candidate.textContent?.trim() ?? ""),
      };
    }
    button.scrollIntoView({ block: "center" });
    button.click();
    return { clicked: true, projectKey: project.dataset.projectKey ?? "", projects: [] };
  }, title) as { clicked: boolean; projectKey: string; projects: string[] };

  if (!result.clicked) {
    throw new Error(`Could not click project containing "${title}". Projects: ${JSON.stringify(result.projects)}`);
  }

  return result.projectKey;
}

async function waitForCollapseRegion(
  selector: string,
  expectedText: string,
  expectedRegion: "project" | "session-branch",
) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (regionSelector: string, text: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(regionSelector)).some((region) =>
            region.textContent?.includes(text),
          ),
        selector,
        expectedText,
      ),
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 100,
      timeoutMsg: `${expectedRegion} collapse region did not contain "${expectedText}"`,
    },
  );
}

async function readCollapseRegionMetrics(selector: string, expectedText: string): Promise<CollapseMetrics> {
  return browser.execute(
    (regionSelector: string, text: string) => {
      const region = Array.from(document.querySelectorAll<HTMLElement>(regionSelector)).find((candidate) =>
        candidate.textContent?.includes(text),
      );
      if (!region) {
        return {
          exists: false,
          height: "",
          opacity: "",
          region: null,
          renderedText: "",
          transform: "",
          transition: "",
        };
      }
      const style = window.getComputedStyle(region);
      return {
        exists: true,
        height: style.height,
        opacity: style.opacity,
        region: region.dataset.sidebarCollapseRegion ?? null,
        renderedText: region.textContent?.trim() ?? "",
        transform: style.transform,
        transition: style.transition,
      };
    },
    selector,
    expectedText,
  ) as Promise<CollapseMetrics>;
}

async function readProjectCollapseRegionMetrics(projectKey: string): Promise<CollapseMetrics> {
  return browser.execute((key: string) => {
    const project = Array.from(document.querySelectorAll<HTMLElement>("[data-project-key]")).find(
      (candidate) => candidate.dataset.projectKey === key,
    );
    const region = project?.querySelector<HTMLElement>('[data-sidebar-collapse-region="project"]') ?? null;
    if (!region) {
      return {
        exists: false,
        height: "",
        opacity: "",
        region: null,
        renderedText: "",
        transform: "",
        transition: "",
      };
    }
    const style = window.getComputedStyle(region);
    return {
      exists: true,
      height: style.height,
      opacity: style.opacity,
      region: region.dataset.sidebarCollapseRegion ?? null,
      renderedText: region.textContent?.trim() ?? "",
      transform: style.transform,
      transition: style.transition,
    };
  }, projectKey) as Promise<CollapseMetrics>;
}

async function waitForNoCollapseRegionText(selector: string, text: string) {
  await browser.waitUntil(
    async () =>
      browser.execute(
        (regionSelector: string, expectedText: string) =>
          !Array.from(document.querySelectorAll<HTMLElement>(regionSelector)).some((region) =>
            region.textContent?.includes(expectedText),
          ),
        selector,
        text,
      ),
    {
      timeout: WAIT_TIMEOUT_MS,
      interval: 100,
      timeoutMsg: `Collapse region still contained "${text}" after exit animation`,
    },
  );
}

async function waitForActiveCollapseTransition(
  selector: string,
  expectedText: string,
  expectedRegion: "project" | "session-branch",
) {
  let metrics = await readCollapseRegionMetrics(selector, expectedText);

  try {
    await browser.waitUntil(
      async () => {
        metrics = await readCollapseRegionMetrics(selector, expectedText);
        return (
          metrics.exists &&
          metrics.region === expectedRegion &&
          metrics.transition.includes("height") &&
          metrics.transition.includes("opacity") &&
          metrics.height !== "auto"
        );
      },
      {
        timeout: 800,
        interval: 16,
        timeoutMsg: `${expectedRegion} collapse region did not enter an active height transition`,
      },
    );
  } catch (error) {
    const debug = await browser.execute(
      (regionSelector: string, rowSelector: string, text: string) => ({
        expectedText: text,
        lastReduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        regions: Array.from(document.querySelectorAll<HTMLElement>(regionSelector)).map((region) => {
          const style = window.getComputedStyle(region);
          return {
            height: style.height,
            html: region.outerHTML.slice(0, 800),
            opacity: style.opacity,
            region: region.dataset.sidebarCollapseRegion ?? null,
            text: region.textContent?.trim() ?? "",
            transform: style.transform,
            transition: style.transition,
          };
        }),
        rows: Array.from(document.querySelectorAll<HTMLElement>(rowSelector)).map((row) =>
          row.textContent?.trim() ?? "",
        ),
      }),
      selector,
      SESSION_ROW_SELECTOR,
      expectedText,
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nCollapse debug:\n${JSON.stringify(debug, null, 2)}`,
    );
  }

  return metrics;
}

async function waitForActiveProjectCollapseTransition(projectKey: string) {
  let metrics = await readProjectCollapseRegionMetrics(projectKey);

  try {
    await browser.waitUntil(
      async () => {
        metrics = await readProjectCollapseRegionMetrics(projectKey);
        return (
          metrics.exists &&
          metrics.region === "project" &&
          metrics.transition.includes("height") &&
          metrics.transition.includes("opacity") &&
          metrics.height !== "auto"
        );
      },
      {
        timeout: 800,
        interval: 16,
        timeoutMsg: "project collapse region did not enter an active height transition",
      },
    );
  } catch (error) {
    const debug = await browser.execute((key: string) => {
      const project = Array.from(document.querySelectorAll<HTMLElement>("[data-project-key]")).find(
        (candidate) => candidate.dataset.projectKey === key,
      );
      const region = project?.querySelector<HTMLElement>('[data-sidebar-collapse-region="project"]') ?? null;
      const style = region ? window.getComputedStyle(region) : null;
      return {
        key,
        lastReduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        projectHtml: project?.outerHTML.slice(0, 1200) ?? null,
        region: region
          ? {
              height: style?.height ?? "",
              html: region.outerHTML.slice(0, 800),
              opacity: style?.opacity ?? "",
              text: region.textContent?.trim() ?? "",
              transform: style?.transform ?? "",
              transition: style?.transition ?? "",
            }
          : null,
      };
    }, projectKey);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nProject collapse debug:\n${JSON.stringify(debug, null, 2)}`,
    );
  }

  return metrics;
}

function expectActiveCollapseTransition(metrics: CollapseMetrics, expectedRegion: "project" | "session-branch") {
  expect(metrics.exists).toBe(true);
  expect(metrics.region).toBe(expectedRegion);
  expect(metrics.transition).toContain("height");
  expect(metrics.transition).toContain("opacity");
  expect(metrics.height).not.toBe("auto");
}

describe("Sidebar collapse animation", () => {
  it("animates recent subagent branches when collapsing and expanding a parent session", async () => {
    const tree = await seedSessionTree();

    await navigateToHash("/session");
    await waitForHashRoute("#/session", WAIT_TIMEOUT_MS);
    await setSidebarMode("recent");
    await browser.refresh();
    await waitForHashRoute("#/session", WAIT_TIMEOUT_MS);
    await forceNoReducedMotion();
    await waitForSidebarRow(tree.parentTitle);

    await clickSidebarRow(tree.parentTitle);
    await waitForHashRoute(`#/session/${tree.parentId}`, WAIT_TIMEOUT_MS);
    await waitForSidebarRow(tree.parentTitle);
    await clickSidebarRow(tree.parentTitle);

    const openingMetrics = await waitForActiveCollapseTransition(
      SESSION_BRANCH_REGION_SELECTOR,
      tree.childTitle,
      "session-branch",
    );
    await expectActiveCollapseTransition(openingMetrics, "session-branch");

    await browser.pause(250);
    await clickSidebarRow(tree.parentTitle);

    const closingMetrics = await waitForActiveCollapseTransition(
      SESSION_BRANCH_REGION_SELECTOR,
      tree.childTitle,
      "session-branch",
    );
    await expectActiveCollapseTransition(closingMetrics, "session-branch");
    await waitForNoCollapseRegionText(SESSION_BRANCH_REGION_SELECTOR, tree.childTitle);
  });

  it("animates by-project project bodies when collapsing a project", async () => {
    const tree = await seedSessionTree();

    await navigateToHash("/session");
    await waitForHashRoute("#/session", WAIT_TIMEOUT_MS);
    await setSidebarMode("by-project");
    await browser.refresh();
    await waitForHashRoute("#/session", WAIT_TIMEOUT_MS);
    await forceNoReducedMotion();
    await waitForSidebarRow(tree.parentTitle);
    await waitForCollapseRegion(PROJECT_REGION_SELECTOR, tree.parentTitle, "project");

    const projectKey = await clickProjectHeaderContaining(tree.parentTitle);

    const closingMetrics = await waitForActiveProjectCollapseTransition(projectKey);
    await expectActiveCollapseTransition(closingMetrics, "project");
    await waitForNoCollapseRegionText(PROJECT_REGION_SELECTOR, tree.parentTitle);
  });
});
