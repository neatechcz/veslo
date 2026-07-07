import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveLaunchTimeout,
  resolvePilotRuntimeDir,
  resolvePilotSocketPath,
  startApp,
  stopApp,
} from "../helpers/app-launcher.js";
import { resolvePilotBinary } from "../helpers/pilot-runner.js";
import {
  E2E_SKILL_REGISTRY_ORG_ID,
  readSkillRegistryFixtureEvents,
  resetSkillRegistryFixtureState,
} from "../helpers/skill-registry-fixture.js";

process.env.E2E_TAURI_PILOT_RUNTIME_DIR ||= join(tmpdir(), `vpsp${process.pid.toString(36)}`);
process.env.E2E_SEED_SKILL_ENABLE_INVENTORY = "1";
process.env.E2E_SKILL_REGISTRY_AUTH_BASE = "fixture";
process.env.VESLO_DISABLE_DEV_AUTOSTART ||= "1";

type VesloServerInfo = {
  running?: boolean;
  baseUrl?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
};

type PublishableSkillRow = {
  name: string;
  scope: string;
  lifecycle: string;
  text: string;
};

const targetSkillName = "e2e-enable-global-skill";
const reviewReason = "Please review this E2E publish request.";
const launchTimeoutMs = resolveLaunchTimeout();
const pilotCommand = resolvePilotBinary();
const pilotSocketPath = resolvePilotSocketPath({ runtimeDir: resolvePilotRuntimeDir() });

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    input?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn(command, args, {
    env: {
      ...process.env,
      TAURI_PILOT_SOCKET: pilotSocketPath,
      TAURI_PILOT_WINDOW: "main",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let settled = false;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}\n${stderr}\n${stdout}`));
      }
    });

    child.stdin?.end(options.input ?? "");
  });
}

async function pilotJson<T>(args: string[], input?: string, timeoutMs?: number): Promise<T> {
  const result = await runProcess(pilotCommand, ["--json", ...args], { input, timeoutMs });
  const raw = result.stdout.trim();
  return (raw ? JSON.parse(raw) : undefined) as T;
}

async function pilotEval<T>(script: string, timeoutMs?: number): Promise<T> {
  return pilotJson<T>(["eval", "-"], `(async () => { ${script} })()`, timeoutMs);
}

async function waitForPilotReady(): Promise<void> {
  const deadline = Date.now() + launchTimeoutMs;
  let latestError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await pilotJson(["ping"], undefined, 5_000);
      await pilotJson(["state"], undefined, 5_000);
      await pilotEval("return document.readyState;", 5_000);
      console.log("[pilot-e2e] tauri-pilot is ready.");
      return;
    } catch (error) {
      latestError = error;
      await delay(500);
    }
  }
  throw new Error(`tauri-pilot did not become ready on ${pilotSocketPath}: ${latestError}`);
}

async function hostPoll<T>(
  label: string,
  budgetMs: number,
  intervalMs: number,
  probe: () => Promise<T | null | false | undefined>,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let latest: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result) return result;
      latest = result;
    } catch (error) {
      latest = error instanceof Error ? error.message : String(error);
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} did not succeed within ${budgetMs}ms. Latest=${JSON.stringify(latest)}`);
}

async function waitForLocalVesloServerReady(): Promise<void> {
  await hostPoll("Veslo server readiness", 60_000, 1_000, async () => {
    const info = await pilotEval<VesloServerInfo>(
      'return await window.__TAURI_INTERNALS__.invoke("veslo_server_info");',
      5_000,
    ).catch(() => null);
    const baseUrl = info?.baseUrl?.trim().replace(/\/+$/, "");
    const clientToken = info?.clientToken?.trim();
    const hostToken = info?.hostToken?.trim();
    if (!info?.running || !baseUrl || !clientToken || !hostToken) return null;
    const health = await fetch(`${baseUrl}/health`).catch(() => null);
    const capabilities = await fetch(`${baseUrl}/capabilities`, {
      headers: {
        authorization: `Bearer ${clientToken}`,
        "X-Veslo-Host-Token": hostToken,
      },
    }).catch(() => null);
    return health?.ok && capabilities?.ok;
  });
}

async function prepareSkillsPage(): Promise<void> {
  await pilotEval(`
    window.localStorage.setItem("veslo.language", "en");
    window.localStorage.setItem("veslo.onboardingComplete", "1");
    window.localStorage.setItem("veslo.startupPref", "local");
    const oldUrl = window.location.href;
    window.location.hash = "/dashboard/skills";
    window.dispatchEvent(new HashChangeEvent("hashchange", {
      oldURL: oldUrl,
      newURL: window.location.href,
    }));
    return window.location.hash;
  `);
  await pilotJson(["wait", "--selector", '[data-testid="skills-page"]', "--timeout", "30000"], undefined, 35_000);
}

async function refreshSkillsInventory(): Promise<void> {
  const clicked = await pilotEval<boolean>(`
    const button = document.querySelector('[data-testid="skills-refresh-button"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  `);
  assert.equal(clicked, true, "Expected skills refresh button to be clickable.");
}

async function waitForPublishableSkill(): Promise<PublishableSkillRow> {
  return hostPoll("publishable skill inventory row", 60_000, 1_000, async () => {
    return await pilotEval<PublishableSkillRow | null>(`
      const selector = [
        '[data-testid="skill-inventory-card"][data-skill-inventory-name="${targetSkillName}"][data-skill-inventory-scope="user-global"]',
        '[data-testid="skill-inventory-table-row"][data-skill-inventory-name="${targetSkillName}"][data-skill-inventory-scope="user-global"]',
      ].join(", ");
      const row = document.querySelector(selector);
      if (!(row instanceof HTMLElement)) return null;
      return {
        name: row.dataset.skillInventoryName ?? "",
        scope: row.dataset.skillInventoryScope ?? "",
        lifecycle: row.dataset.skillInventoryLifecycle ?? "",
        text: row.innerText,
      };
    `);
  });
}

async function selectPublishableSkill(): Promise<void> {
  const selected = await pilotEval<boolean>(`
    const selector = [
      '[data-testid="skill-inventory-card"][data-skill-inventory-name="${targetSkillName}"][data-skill-inventory-scope="user-global"]',
      '[data-testid="skill-inventory-table-row"][data-skill-inventory-name="${targetSkillName}"][data-skill-inventory-scope="user-global"]',
    ].join(", ");
    const row = document.querySelector(selector);
    if (!(row instanceof HTMLElement)) return false;
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (!(checkbox instanceof HTMLInputElement)) return false;
    if (!checkbox.checked) {
      checkbox.click();
    }
    return checkbox.checked;
  `);
  assert.equal(selected, true, `Expected ${targetSkillName} to be selected.`);
}

async function waitForBulkPublishEnabled(): Promise<void> {
  try {
    await hostPoll("enabled bulk publish button", 30_000, 500, async () => {
      return await pilotEval<boolean>(`
        const button = document.querySelector('[data-testid="skills-bulk-publish-button"]');
        return button instanceof HTMLButtonElement && !button.disabled;
      `);
    });
  } catch (error) {
    const buttonState = await pilotEval<string>(`
      const button = document.querySelector("[data-testid='skills-bulk-publish-button']");
      return JSON.stringify({
        title: button?.getAttribute('title'),
        disabled: button?.disabled,
        checkedCount: document.querySelectorAll('[data-testid="skill-inventory-card"] input[type=checkbox]:checked, [data-testid="skill-inventory-table-row"] input[type=checkbox]:checked').length,
      });
    `);
    throw new Error(`${error instanceof Error ? error.message : String(error)} ${buttonState}`);
  }
}

async function submitPublishRequest(): Promise<void> {
  const opened = await pilotEval<boolean>(`
    const button = document.querySelector('[data-testid="skills-bulk-publish-button"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  `);
  assert.equal(opened, true, "Expected enabled bulk publish button to open the review dialog.");

  await pilotJson(["wait", "--selector", '[data-testid="skill-review-dialog"]', "--timeout", "30000"], undefined, 35_000);
  const submitted = await pilotEval<boolean>(`
    const dialog = document.querySelector('[data-testid="skill-review-dialog"]');
    if (!(dialog instanceof HTMLElement)) return false;
    const textarea = dialog.querySelector("textarea");
    if (textarea instanceof HTMLTextAreaElement) {
      textarea.value = ${JSON.stringify(reviewReason)};
      textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: ${JSON.stringify(reviewReason)} }));
    }
    const submit = dialog.querySelector('[data-testid="skill-review-submit-button"]');
    if (!(submit instanceof HTMLButtonElement) || submit.disabled) return false;
    submit.click();
    return true;
  `);
  assert.equal(submitted, true, "Expected review dialog submit button to be clickable.");
}

async function waitForPublishMutations(): Promise<void> {
  await hostPoll("skill publish registry mutations", 30_000, 500, async () => {
    const events = await readSkillRegistryFixtureEvents();
    return events.createSkillRequests.length > 0 &&
      events.createVersionRequests.length > 0 &&
      events.reviewRequestRequests.length > 0;
  });
}

async function assertPublishMutations(): Promise<void> {
  const events = await readSkillRegistryFixtureEvents();
  assert.equal(events.createSkillRequests.length, 1);
  assert.equal(events.createVersionRequests.length, 1);
  assert.equal(events.reviewRequestRequests.length, 1);

  const [createSkill] = events.createSkillRequests;
  const [createVersion] = events.createVersionRequests;
  const [reviewRequest] = events.reviewRequestRequests;
  assert.ok(createSkill);
  assert.ok(createVersion);
  assert.ok(reviewRequest);

  assert.equal(createSkill.body.scope, "user");
  assert.equal(createSkill.body.name, targetSkillName);
  assert.equal(createSkill.body.displayName, targetSkillName);
  assert.equal(createVersion.skillId, createSkill.responseSkillId);
  assert.equal(createVersion.body.package?.metadata?.name, targetSkillName);
  assert.equal(createVersion.body.package?.entrypoint, "SKILL.md");
  assert.ok(
    Array.isArray(createVersion.body.package?.files) &&
      createVersion.body.package.files.some((file) => file?.path === "SKILL.md"),
    "Expected published package archive to include SKILL.md.",
  );
  assert.equal(reviewRequest.skillId, createSkill.responseSkillId);
  assert.equal(reviewRequest.body.versionId, createVersion.responseVersionId);
  assert.equal(reviewRequest.body.scope, "org");
  assert.equal(reviewRequest.body.orgId, E2E_SKILL_REGISTRY_ORG_ID);
  assert.equal(reviewRequest.body.reason, reviewReason);
}

async function assertSuccessUi(): Promise<void> {
  await hostPoll("review dialog closed after publish request", 30_000, 500, async () => {
    return await pilotEval<boolean>(`
      return !document.querySelector('[data-testid="skill-review-dialog"]') &&
        (document.body.innerText || "").includes("Skill publish request sent for organization review.")
    `);
  });
}

async function run(): Promise<void> {
  await startApp();
  try {
    await waitForPilotReady();
    await waitForLocalVesloServerReady();
    await resetSkillRegistryFixtureState();
    await prepareSkillsPage();
    await refreshSkillsInventory();

    const row = await waitForPublishableSkill();
    assert.equal(row.name, targetSkillName);
    assert.equal(row.scope, "user-global");
    assert.equal(row.lifecycle, "active");

    await selectPublishableSkill();
    await waitForBulkPublishEnabled();
    await submitPublishRequest();
    await waitForPublishMutations();
    await assertPublishMutations();
    await assertSuccessUi();

    console.log("[pilot-e2e] Skill publish request tauri-pilot E2E passed.");
  } finally {
    await stopApp();
  }
}

run().catch(async (error) => {
  await stopApp().catch(() => {});
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
