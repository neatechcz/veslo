import assert from "node:assert/strict";
import test from "node:test";

const editorState = await import("../public-admin/model-policy-editor-state.js")
  .catch(() => ({} as Record<string, unknown>)) as Record<string, any>;

const savedPolicy = {
  enabledModels: [
    { provider: "codex_oauth", model: "gpt-5.4" },
    { provider: "openai_compatible", model: "custom-v1" },
  ],
  activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
  updatedAt: "2026-07-12T10:00:00.000Z",
};

test("stale discovery cannot populate a newly selected credential", () => {
  assert.equal(typeof editorState.createModelDiscoveryState, "function");
  assert.equal(typeof editorState.selectModelDiscoveryCredential, "function");
  assert.equal(typeof editorState.beginModelDiscovery, "function");
  assert.equal(typeof editorState.completeModelDiscovery, "function");

  const state = editorState.createModelDiscoveryState();
  editorState.selectModelDiscoveryCredential(state, "cred_a");
  const requestA = editorState.beginModelDiscovery(state);
  editorState.selectModelDiscoveryCredential(state, "cred_b");
  const requestB = editorState.beginModelDiscovery(state);

  assert.equal(editorState.completeModelDiscovery(state, requestA, ["model-a"]), false);
  assert.equal(state.credentialId, "cred_b");
  assert.deepEqual(state.models, []);
  assert.equal(state.loading, true);

  assert.equal(editorState.completeModelDiscovery(state, requestB, ["model-b"]), true);
  assert.deepEqual(state.models, ["model-b"]);
  assert.equal(state.loading, false);
});

test("save success retains a newer draft created while the request was pending", () => {
  assert.equal(typeof editorState.createModelPolicyState, "function");
  assert.equal(typeof editorState.replaceModelPolicyDraft, "function");
  assert.equal(typeof editorState.beginModelPolicySave, "function");
  assert.equal(typeof editorState.completeModelPolicySave, "function");

  const state = editorState.createModelPolicyState(savedPolicy);
  editorState.replaceModelPolicyDraft(
    state,
    [...savedPolicy.enabledModels, { provider: "codex_oauth", model: "gpt-5.5" }],
    { provider: "codex_oauth", model: "gpt-5.5" },
  );
  const submission = editorState.beginModelPolicySave(state);
  const submittedPolicy = {
    enabledModels: submission.enabledModels,
    activeModel: submission.activeModel,
    updatedAt: "2026-07-12T11:00:00.000Z",
  };

  editorState.replaceModelPolicyDraft(
    state,
    [...submission.enabledModels, { provider: "codex_oauth", model: "gpt-5.6" }],
    { provider: "codex_oauth", model: "gpt-5.6" },
  );
  assert.equal(editorState.completeModelPolicySave(state, submission, submittedPolicy), true);

  assert.deepEqual(state.saved.enabledModels, submittedPolicy.enabledModels);
  assert.deepEqual(state.draftActiveModel, { provider: "codex_oauth", model: "gpt-5.6" });
  assert.equal(state.dirty, true);
  assert.equal(state.saving, false);
});

test("failed save preserves the prior saved policy and dirty draft", () => {
  assert.equal(typeof editorState.failModelPolicySave, "function");

  const state = editorState.createModelPolicyState(savedPolicy);
  editorState.replaceModelPolicyDraft(
    state,
    [...savedPolicy.enabledModels, { provider: "codex_oauth", model: "gpt-5.5" }],
    { provider: "codex_oauth", model: "gpt-5.5" },
  );
  const expectedDraft = structuredClone(state.draftEnabledModels);
  const submission = editorState.beginModelPolicySave(state);

  assert.equal(editorState.failModelPolicySave(state, submission, "request_failed"), true);
  assert.deepEqual(state.saved, savedPolicy);
  assert.deepEqual(state.draftEnabledModels, expectedDraft);
  assert.equal(state.dirty, true);
  assert.equal(state.saving, false);
  assert.equal(state.error, "request_failed");
});

test("dirty state is canonical and clears after a semantic revert", () => {
  assert.equal(typeof editorState.createModelPolicyState, "function");
  assert.equal(typeof editorState.replaceModelPolicyDraft, "function");
  const state = editorState.createModelPolicyState(savedPolicy);
  const initialVersion = state.draftVersion;

  editorState.replaceModelPolicyDraft(
    state,
    [savedPolicy.enabledModels[1], savedPolicy.enabledModels[0], savedPolicy.enabledModels[0]],
    savedPolicy.activeModel,
  );
  assert.equal(state.dirty, false);
  assert.equal(state.draftVersion, initialVersion, "canonical duplicate/reorder no-op changed the draft version");

  editorState.replaceModelPolicyDraft(state, savedPolicy.enabledModels, savedPolicy.enabledModels[1]);
  assert.equal(state.dirty, true);

  editorState.replaceModelPolicyDraft(state, savedPolicy.enabledModels, savedPolicy.activeModel);
  assert.equal(state.dirty, false);
});

test("stale model policy loads cannot replace a newer load", () => {
  assert.equal(typeof editorState.beginModelPolicyLoad, "function");
  assert.equal(typeof editorState.completeModelPolicyLoad, "function");

  const state = editorState.createModelPolicyState(savedPolicy);
  const older = editorState.beginModelPolicyLoad(state);
  const newer = editorState.beginModelPolicyLoad(state);
  const newerPolicy = {
    ...savedPolicy,
    activeModel: savedPolicy.enabledModels[1],
    updatedAt: "2026-07-12T12:00:00.000Z",
  };

  assert.equal(editorState.completeModelPolicyLoad(state, older, savedPolicy), false);
  assert.equal(state.loading, true);
  assert.equal(editorState.completeModelPolicyLoad(state, newer, newerPolicy), true);
  assert.deepEqual(state.saved.activeModel, savedPolicy.enabledModels[1]);
  assert.equal(state.loading, false);
});

test("a model policy load cannot replace a draft edited while it was pending", () => {
  assert.equal(typeof editorState.beginModelPolicyLoad, "function");
  assert.equal(typeof editorState.completeModelPolicyLoad, "function");

  const state = editorState.createModelPolicyState(savedPolicy);
  const request = editorState.beginModelPolicyLoad(state);
  editorState.replaceModelPolicyDraft(
    state,
    [...savedPolicy.enabledModels, { provider: "codex_oauth", model: "gpt-5.5" }],
    { provider: "codex_oauth", model: "gpt-5.5" },
  );
  const dirtyDraft = structuredClone(state.draftEnabledModels);

  assert.equal(editorState.completeModelPolicyLoad(state, request, savedPolicy), false);
  assert.deepEqual(state.draftEnabledModels, dirtyDraft);
  assert.equal(state.dirty, true);
  assert.equal(state.loading, false);
});

test("invalidating a model policy load makes its completion inert", () => {
  assert.equal(typeof editorState.invalidateModelPolicyLoad, "function");
  const state = editorState.createModelPolicyState(savedPolicy);
  const request = editorState.beginModelPolicyLoad(state);

  editorState.invalidateModelPolicyLoad(state);

  assert.equal(editorState.completeModelPolicyLoad(state, request, savedPolicy), false);
  assert.equal(state.loading, false);
});

test("only the current unchanged model policy load may publish an error", () => {
  assert.equal(typeof editorState.failModelPolicyLoad, "function");
  const state = editorState.createModelPolicyState(savedPolicy);
  const stale = editorState.beginModelPolicyLoad(state);
  const current = editorState.beginModelPolicyLoad(state);

  assert.equal(editorState.failModelPolicyLoad(state, stale, "stale_error"), false);
  assert.equal(state.error, "");
  assert.equal(editorState.failModelPolicyLoad(state, current, "current_error"), true);
  assert.equal(state.error, "current_error");
  assert.equal(state.loading, false);
});
