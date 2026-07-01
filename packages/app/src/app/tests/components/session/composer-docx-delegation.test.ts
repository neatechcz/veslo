import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composerSource = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../../../app.tsx", import.meta.url), "utf8");
const appShellEnvironmentSource = readFileSync(
  new URL("../../../context/app-shell-environment.ts", import.meta.url),
  "utf8",
);

test("composer keeps dropped files as attachment chips and does not inject path text on drop", () => {
  assert.doesNotMatch(
    composerSource,
    /insertPlainTextAtCursorOrEnd\(/,
    "composer should not inject staged paths into editor text",
  );

  assert.match(
    composerSource,
    /setAttachments\(\(current: ComposerAttachment\[\]\) => \[\.\.\.current, \.\.\.next\]\);/,
    "composer should keep dropped files as attachment chips",
  );
});

test("all attachment staging happens in session-directory send pipeline, not in composer", () => {
  assert.match(
    appSource,
    /const stageAttachmentsIntoSessionDirectory = async \(\s*draft: ComposerDraft,\s*sessionID: string,\s*preflight\?: SendPreflightContext,\s*\): Promise<StagedSessionAttachment\[]> =>/,
    "app send pipeline should stage attachments into the active session directory",
  );

  assert.match(
    appSource,
    /const attachmentsToStage = draft\.attachments;/,
    "staging should process every composer attachment",
  );

  assert.doesNotMatch(
    appSource,
    /uploadInbox\(/,
    "composer send flow should not stage attachments through inbox uploads",
  );

  assert.match(
    appSource,
    /ready\.client\.createFileSession\(ready\.workspaceId, \{[\s\S]*write: true,/,
    "staging should open a writable file session",
  );

  assert.match(
    appSource,
    /const resolveWorkspaceIdForAttachmentStaging = async \(\s*client: NonNullable<ReturnType<typeof vesloServerClient>>,\s*\) => \{[\s\S]*const response = await client\.listWorkspaces\(\);/s,
    "attachment staging should include a dedicated lazy Veslo workspace resolver",
  );

  assert.match(
    appSource,
    /let ready: AttachmentStagingWorkspaceReady = resolution\?\.serverWorkspaceId[\s\S]*ensureWorkspaceReadyForAttachmentStaging\(client\);/,
    "staging should reuse the send preflight workspace resolution and lazily resolve the Veslo workspace id as a fallback",
  );

  assert.match(
    appSource,
    /await client\.readFileBatch\([^,]+, \[candidatePath\]\)/,
    "staging should probe for filename collisions in the session directory",
  );

  assert.match(
    appSource,
    /await ready\.client\.writeFileBatch\([^,]+, \[/,
    "staging should write attachments into the session directory",
  );

  assert.match(
    appSource,
    /absolutePath: resolveWorkspaceAbsolutePath\(relativePath\),/,
    "staging should record the exact absolute path for each staged attachment",
  );

  assert.match(
    appSource,
    /const routedDraft = routeStagedAttachmentsForModel\(\{\s*draft: resolvedDraft,\s*stagedAttachments,\s*model,\s*providers: providers\(\),\s*\}\);/s,
    "send pipeline should route staged attachments only after it knows the selected model capabilities",
  );

  assert.match(
    appSource,
    /stageAttachmentsIntoSessionDirectory\(resolvedDraft, sessionID, sendPreflight\)/,
    "send pipeline should stage attachments after session selection and before provider calls",
  );

  assert.doesNotMatch(
    appSource,
    /stagedPaths\.join\("\\n"\)/,
    "staging should not append attachment filenames directly into prompt text",
  );
});

test("app installs a global file-drop navigation guard for the webview", () => {
  assert.match(
    appSource,
    /createAppShellEnvironment\(\{[\s\S]*isTauriRuntime,[\s\S]*\}\);/,
    "app should compose the shell environment module",
  );

  assert.match(
    appShellEnvironmentSource,
    /win\.addEventListener\("dragover", handleGlobalFileDropGuard, true\);[\s\S]*win\.addEventListener\("drop", handleGlobalFileDropGuard, true\);/s,
    "shell environment should suppress browser default file navigation at window scope so dropped files cannot replace the whole UI",
  );

  assert.match(
    appShellEnvironmentSource,
    /const handleGlobalFileDropGuard = \(event: DragEvent\) => \{\s*if \(shouldInterceptFileDrag\(event\.dataTransfer\) === false\) return;\s*event\.preventDefault\(\);\s*\};/s,
    "global file-drop guard should only intercept actual file drags",
  );
});
