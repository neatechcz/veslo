import { fail } from "../attach-smoke.mjs";
import { selectors } from "./selectors.mjs";
import { waitForComposerReady } from "./waits.mjs";

const visibleComposerText = (selector) => {
  const composer = Array.from(document.querySelectorAll(selector)).find((element) => {
    const style = window.getComputedStyle(element);
    return element.getClientRects().length > 0
      && style.visibility !== "hidden"
      && style.display !== "none";
  });
  return composer?.textContent?.trim() ?? "";
};

export async function focusComposer(browser) {
  const composer = await waitForComposerReady(browser, 10_000);
  await composer.click();
  return composer;
}

export async function clearOwnedScenarioDraftIfPresent(browser, workspaceLabel) {
  const composer = await focusComposer(browser);
  const currentText = await browser.execute(
    visibleComposerText,
    selectors.composerInput,
  );
  if (!currentText) return false;

  // The owned sidebar scenario reuses the development profile. It may be
  // interrupted after it has typed one of its own prompts; clear only that
  // recognizable leftover through the visible editor, never an arbitrary
  // user draft in the selected workspace.
  const isOwnedScenarioDraft = currentText.startsWith("Create exactly one workspace-local skill named ")
    || currentText === "Reply with exactly: workspace skill sidebar verification.";
  if (!isOwnedScenarioDraft) {
    fail(`Composer contains a non-scenario draft for ${workspaceLabel}; refusing to clear it.`);
  }
  await browser.execute((selector) => {
    const editor = Array.from(document.querySelectorAll(selector)).find((element) => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    });
    if (!editor) return false;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return document.execCommand("delete");
  }, selectors.composerInput);
  await browser.waitUntil(
    async () => !(await browser.execute(visibleComposerText, selectors.composerInput)),
    { timeout: 5_000, timeoutMsg: `Owned scenario draft did not clear for ${workspaceLabel}.` },
  );
  return true;
}

export async function writeComposer(browser, message, workspaceLabel) {
  const composer = await focusComposer(browser);
  const currentText = await browser.execute(
    visibleComposerText,
    selectors.composerInput,
  );
  if (currentText) {
    fail(`Composer is not empty before writing the message for ${workspaceLabel}.`);
  }
  await composer.addValue(message);
  const acceptedByNativeDriver = await browser.waitUntil(
    async () => (await browser.execute(visibleComposerText, selectors.composerInput)).includes(message),
    { timeout: 750, interval: 50 },
  ).then(() => true, () => false);
  if (acceptedByNativeDriver) return;

  const dispatched = await browser.execute((selector, text) => {
    const editor = Array.from(document.querySelectorAll(selector)).find((element) => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0
        && style.visibility !== "hidden"
        && style.display !== "none";
    });
    if (!(editor instanceof HTMLElement) || editor.getAttribute("contenteditable") !== "true") {
      return false;
    }
    // The loopback Tauri driver can acknowledge elementSendKeys for a
    // freshly replaced contenteditable without delivering characters. Keep
    // normal WebDriver input as the primary path; this fallback exercises the
    // mounted Composer's real bubbling `input` handler, then all submission,
    // server, and projection assertions stay on the visible app path.
    if (!(editor.textContent ?? "").includes(text)) {
      editor.textContent = text;
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      }));
    }
    return true;
  }, selectors.composerInput, message);
  if (!dispatched) {
    fail(`Composer cannot accept driver input for ${workspaceLabel}.`);
  }
  await browser.waitUntil(
    async () => (await browser.execute(visibleComposerText, selectors.composerInput)).includes(message),
    { timeout: 5_000, timeoutMsg: `Composer did not receive the message for ${workspaceLabel}.` },
  );
}

export async function submitComposer(browser, message, workspaceLabel) {
  const sendButton = await browser.$(selectors.composerSend);
  await sendButton.waitForEnabled({ timeout: 10_000 });
  await sendButton.click();
  await browser.waitUntil(
    async () => !(await browser.execute(visibleComposerText, selectors.composerInput)).includes(message),
    { timeout: 15_000, timeoutMsg: `The message for ${workspaceLabel} was not accepted by the UI.` },
  );
}

export async function sendComposerMessage(browser, message, workspaceLabel) {
  await writeComposer(browser, message, workspaceLabel);
  await submitComposer(browser, message, workspaceLabel);
}

export async function queueComposerMessageWithEnter(browser, message, workspaceLabel) {
  await writeComposer(browser, message, workspaceLabel);
  await browser.keys("Enter");
  await browser.waitUntil(
    async () => !(await browser.execute(visibleComposerText, selectors.composerInput)).includes(message),
    { timeout: 15_000, timeoutMsg: `The queued message for ${workspaceLabel} was not accepted by the UI.` },
  );
}
