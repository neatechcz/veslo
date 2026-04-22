import assert from "node:assert/strict";
import test from "node:test";

import {
  buildYouTrackFeedbackQuery,
  extractYouTrackIssues,
  parseMcpArgs,
  resolveLiveFeedbackYouTrackConfig,
} from "./live-feedback-youtrack.js";

test("parseMcpArgs accepts an empty value and trims JSON string arrays", () => {
  assert.deepEqual(parseMcpArgs(undefined), []);
  assert.deepEqual(parseMcpArgs(""), []);
  assert.deepEqual(parseMcpArgs('[" one ", "two", ""]'), ["one", "two"]);
});

test("parseMcpArgs rejects invalid JSON and non-string entries", () => {
  assert.throws(() => parseMcpArgs("{"), /must be a JSON string array/i);
  assert.throws(() => parseMcpArgs('["ok", 1]'), /must be a JSON string array/i);
});

test("buildYouTrackFeedbackQuery scopes by project and quotes the feedback title", () => {
  assert.equal(
    buildYouTrackFeedbackQuery("VSLO", 'Codex "feedback" smoke'),
    'project: VSLO "Codex \\"feedback\\" smoke"',
  );
});

test("extractYouTrackIssues reads structured, paged, and text MCP results", () => {
  assert.deepEqual(extractYouTrackIssues([{ id: "VSLO-1", summary: "[Bug] A", url: "https://yt/VSLO-1" }]), [
    { id: "VSLO-1", summary: "[Bug] A", url: "https://yt/VSLO-1" },
  ]);

  assert.deepEqual(extractYouTrackIssues({ issuesPage: [{ id: "VSLO-2", summary: "[Bug] B" }] }), [
    { id: "VSLO-2", summary: "[Bug] B", url: null },
  ]);

  assert.deepEqual(
    extractYouTrackIssues({
      content: [{ type: "text", text: JSON.stringify({ issuesPage: [{ id: "VSLO-3", summary: "[Bug] C" }] }) }],
    }),
    [{ id: "VSLO-3", summary: "[Bug] C", url: null }],
  );
});

test("resolveLiveFeedbackYouTrackConfig uses repo-safe defaults and environment overrides", () => {
  const config = resolveLiveFeedbackYouTrackConfig({
    HOME: "/tmp/home",
    E2E_YOUTRACK_PROJECT_KEY: "TEST",
    E2E_YOUTRACK_MCP_ARGS: '["--remote"]',
    E2E_YOUTRACK_MCP_WIRE_PROTOCOL: "content-length",
    E2E_YOUTRACK_MCP_TIMEOUT_MS: "1500",
    E2E_YOUTRACK_POLL_TIMEOUT_MS: "2500",
    E2E_YOUTRACK_POLL_INTERVAL_MS: "750",
  });

  assert.equal(config.projectKey, "TEST");
  assert.equal(config.command, "/tmp/home/.config/youtrack-mcp/run-remote.sh");
  assert.deepEqual(config.args, ["--remote"]);
  assert.equal(config.wireProtocol, "content-length");
  assert.equal(config.mcpTimeoutMs, 1500);
  assert.equal(config.pollTimeoutMs, 2500);
  assert.equal(config.pollIntervalMs, 750);
});

test("resolveLiveFeedbackYouTrackConfig defaults to line-delimited JSON-RPC for the local wrapper", () => {
  const config = resolveLiveFeedbackYouTrackConfig({ HOME: "/tmp/home" });
  assert.equal(config.wireProtocol, "line");
});
