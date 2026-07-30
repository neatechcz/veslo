import { fail } from "../attach-smoke.mjs";
import { captureUiState } from "./snapshots.mjs";
import { waitForSubmittedRunToSettle } from "./waits.mjs";

export async function expectNoVisibleRuntimeError(browser) {
  const state = await captureUiState(browser, "assert-no-runtime-error");
  if (state.operationalError || state.rendererRecoveryVisible) {
    fail(`Visible runtime error: ${state.operationalError ?? "renderer recovery is visible"}.`);
  }
  return state;
}

export async function expectRunCompleted(browser, workspaceLabel, timeout) {
  await waitForSubmittedRunToSettle(browser, workspaceLabel, timeout);
  return expectNoVisibleRuntimeError(browser);
}
