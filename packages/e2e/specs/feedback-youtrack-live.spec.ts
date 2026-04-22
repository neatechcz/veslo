import { randomUUID } from "node:crypto";

import { expect } from "@wdio/globals";

import { navigateToHash } from "../helpers/app-launcher.js";
import {
  assertMcpCommandAvailable,
  resolveLiveFeedbackYouTrackConfig,
  waitForYouTrackFeedbackIssue,
  writeLiveFeedbackArtifact,
  type LiveFeedbackArtifact,
} from "../helpers/live-feedback-youtrack.js";

type SafeDenAuthSummary = {
  denApiBase: string | null;
  orgId: string | null;
  userEmail: string | null;
};

const LIVE_SMOKE_ENABLED = process.env.E2E_LIVE_FEEDBACK_YOUTRACK?.trim() === "1";

function makeRunId() {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

async function waitForRoute(hashFragment: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => (await browser.getUrl()).includes(hashFragment), {
    timeout,
    timeoutMsg: `Route did not change to ${hashFragment} within ${timeout}ms`,
  });
}

async function seedDenAuthFromEnvIfPresent() {
  const denAuthJson = process.env.E2E_DEN_AUTH_JSON?.trim();
  if (!denAuthJson) return;

  await browser.execute((authJson: string) => {
    JSON.parse(authJson);
    window.localStorage.setItem("veslo.den.auth", authJson);
    window.localStorage.setItem("veslo.den.keepSignedIn", "1");
  }, denAuthJson);
}

async function readSafeDenAuthSummary(): Promise<SafeDenAuthSummary | null> {
  return await browser.execute(() => {
    function parseAuth(raw: string | null) {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as {
          denApiBase?: string;
          orgId?: string;
          user?: { email?: string };
        };
        return {
          denApiBase: typeof parsed.denApiBase === "string" ? parsed.denApiBase : null,
          orgId: typeof parsed.orgId === "string" ? parsed.orgId : null,
          userEmail: typeof parsed.user?.email === "string" ? parsed.user.email : null,
        };
      } catch {
        return null;
      }
    }

    return parseAuth(window.localStorage.getItem("veslo.den.auth"))
      ?? parseAuth(window.sessionStorage.getItem("veslo.den.auth"));
  });
}

async function requireDenAuthSummary() {
  await seedDenAuthFromEnvIfPresent();
  const summary = await readSafeDenAuthSummary();
  if (!summary?.denApiBase || !summary.orgId) {
    throw new Error(
      "Live feedback-to-YouTrack smoke requires Den auth. Run with E2E_USE_EXISTING_PROFILE=1 for a signed-in desktop profile, or provide E2E_DEN_AUTH_JSON.",
    );
  }
  return summary;
}

async function openFeedbackModal() {
  const feedbackButton = await $('//button[normalize-space()="Feedback" or @aria-label="Feedback" or @title="Feedback"]');
  await feedbackButton.waitForDisplayed({ timeout: 10_000 });
  await feedbackButton.click();

  const dialog = await $('[role="dialog"]');
  await dialog.waitForDisplayed({ timeout: 10_000 });
  return dialog;
}

type ElementWithQuery = {
  $: (selector: string) => {
    isExisting: () => Promise<boolean>;
    isDisplayed: () => Promise<boolean>;
    getText: () => Promise<string>;
  };
};

async function readInlineError(dialog: ElementWithQuery) {
  const alert = await dialog.$('[role="alert"]');
  if (!(await alert.isExisting())) return null;
  if (!(await alert.isDisplayed())) return null;
  const text = await alert.getText();
  return text.trim() || null;
}

async function submitFeedbackFromUi(title: string, description: string) {
  const dialog = await openFeedbackModal();
  const titleInput = await dialog.$("input");
  const descriptionInput = await dialog.$("textarea");
  const submitButton = await dialog.$('//button[normalize-space()="Odeslat hlášení" or normalize-space()="Send bug report"]');

  await titleInput.waitForDisplayed({ timeout: 10_000 });
  await descriptionInput.waitForDisplayed({ timeout: 10_000 });

  await titleInput.setValue(title);
  await descriptionInput.setValue(description);
  await submitButton.waitForEnabled({ timeout: 10_000 });
  await submitButton.click();

  await browser.waitUntil(async () => {
    const inlineError = await readInlineError(dialog);
    if (inlineError) return true;
    return !(await dialog.isDisplayed().catch(() => false));
  }, {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: "Feedback modal neither closed nor showed an inline submit error.",
  });

  const inlineError = await readInlineError(dialog);
  if (inlineError) {
    throw new Error(`Feedback submit failed in the UI: ${inlineError}`);
  }

  await dialog.waitForDisplayed({ timeout: 10_000, reverse: true });
}

const maybeLiveIt = LIVE_SMOKE_ENABLED ? it : it.skip;

describe("Live feedback bug reporting to YouTrack", () => {
  maybeLiveIt("creates a YouTrack issue after submitting feedback from the desktop UI", async function () {
    this.retries(0);

    const config = resolveLiveFeedbackYouTrackConfig();
    assertMcpCommandAvailable(config);

    await navigateToHash("/dashboard/settings");
    await waitForRoute("#/dashboard/settings");

    const denAuth = await requireDenAuthSummary();
    const runId = process.env.E2E_FEEDBACK_RUN_ID?.trim() || makeRunId();
    const title = `Codex feedback E2E ${runId}`;
    const expectedSummary = `[Bug] ${title}`;
    const description = [
      `Codex live feedback-to-YouTrack smoke run ${runId}.`,
      "Submitted through the real Veslo desktop feedback UI.",
      "This report is expected to create a real YouTrack issue through the Den feedback projector.",
    ].join("\n");
    const submittedAt = new Date().toISOString();

    const artifact: LiveFeedbackArtifact = {
      runId,
      title,
      expectedSummary,
      description,
      submittedAt,
      denAuth,
    };
    writeLiveFeedbackArtifact(artifact);

    await submitFeedbackFromUi(title, description);

    const youtrackIssue = await waitForYouTrackFeedbackIssue(config, title);
    expect(youtrackIssue.summary).toBe(expectedSummary);

    writeLiveFeedbackArtifact({
      ...artifact,
      youtrackIssue,
    });
  });
});
