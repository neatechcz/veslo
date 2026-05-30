import assert from "node:assert/strict";
import test from "node:test";

import {
  buildYouTrackFeedbackQuery,
  extractYouTrackIssues,
  resolveLiveFeedbackYouTrackConfig,
} from "./live-feedback-youtrack.js";

test("buildYouTrackFeedbackQuery scopes by project and quotes the feedback title", () => {
  assert.equal(
    buildYouTrackFeedbackQuery("VSLO", 'Codex "feedback" smoke'),
    'project: VSLO "Codex \\"feedback\\" smoke"',
  );
});

test("extractYouTrackIssues reads REST issue search results", () => {
  assert.deepEqual(
    extractYouTrackIssues([{ idReadable: "VSLO-1", summary: "[Bug] A" }], "https://yt.example"),
    [
      {
        id: "VSLO-1",
        summary: "[Bug] A",
        url: "https://yt.example/issue/VSLO-1",
      },
    ],
  );

  assert.deepEqual(extractYouTrackIssues([{ summary: "[Bug] missing id" }]), []);
});

test("resolveLiveFeedbackYouTrackConfig uses REST environment overrides", () => {
  const config = resolveLiveFeedbackYouTrackConfig({
    E2E_YOUTRACK_PROJECT_KEY: "TEST",
    E2E_YOUTRACK_URL: "https://youtrack.example.test/",
    E2E_YOUTRACK_TOKEN: "service-token",
    E2E_YOUTRACK_TIMEOUT_MS: "1500",
    E2E_YOUTRACK_POLL_TIMEOUT_MS: "2500",
    E2E_YOUTRACK_POLL_INTERVAL_MS: "750",
  });

  assert.equal(config.projectKey, "TEST");
  assert.equal(config.baseUrl, "https://youtrack.example.test");
  assert.equal(config.token, "service-token");
  assert.equal(config.requestTimeoutMs, 1500);
  assert.equal(config.pollTimeoutMs, 2500);
  assert.equal(config.pollIntervalMs, 750);
});
