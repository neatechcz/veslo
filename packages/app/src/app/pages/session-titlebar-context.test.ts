import assert from "node:assert/strict";
import test from "node:test";

import { resolveSessionTitlebarContext } from "./session-titlebar-context.js";

test("empty local chat shows new-session state and directory", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: null,
    messageCount: 0,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/projects/veslo",
    localWorkspaceLabel: "Local workspace",
    remoteWorkspaceLabel: "Remote workspace",
    newSessionLabel: "New session",
    chatFallbackLabel: "Chat",
    isPrivateWorkspacePath: false,
  });

  assert.deepEqual(context, {
    stateLabel: "New session",
    locationLabel: "veslo",
    locationTitle: "/Users/example/projects/veslo",
    locationUsePathStyle: true,
  });
});

test("private new-session draft hides generated workspace directory", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: null,
    messageCount: 0,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/.veslo/workspaces/private/session-123",
    localWorkspaceLabel: "Private workspace",
    remoteWorkspaceLabel: "Remote workspace",
    newSessionLabel: "New session",
    chatFallbackLabel: "Chat",
    isPrivateWorkspacePath: true,
  });

  assert.deepEqual(context, {
    stateLabel: "New session",
    locationLabel: null,
    locationTitle: null,
    locationUsePathStyle: false,
  });
});

test("selected private chat shows chat title instead of private directory", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: "ses_chat",
    selectedSessionTitle: "Plan weekend",
    messageCount: 2,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/.veslo/private-workspaces/chat-a",
    localWorkspaceLabel: "Local workspace",
    remoteWorkspaceLabel: "Remote workspace",
    newSessionLabel: "Chat",
    chatFallbackLabel: "Chat",
    isPrivateWorkspacePath: true,
  });

  assert.deepEqual(context, {
    stateLabel: "Plan weekend",
    locationLabel: null,
    locationTitle: null,
    locationUsePathStyle: false,
  });
});

test("selected private chat falls back to Chat label", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: "ses_chat",
    selectedSessionTitle: "",
    messageCount: 1,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/.veslo/private-workspaces/chat-a",
    localWorkspaceLabel: "Local workspace",
    remoteWorkspaceLabel: "Remote workspace",
    newSessionLabel: "Chat",
    chatFallbackLabel: "Chat",
    isPrivateWorkspacePath: true,
  });

  assert.equal(context?.stateLabel, "Chat");
  assert.equal(context?.locationLabel, null);
});

test("existing chat with messages keeps directory-only context", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: "ses_123",
    messageCount: 3,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/projects/veslo",
    localWorkspaceLabel: "Local workspace",
    remoteWorkspaceLabel: "Remote workspace",
    newSessionLabel: "New session",
    chatFallbackLabel: "Chat",
    isPrivateWorkspacePath: false,
  });

  assert.deepEqual(context, {
    stateLabel: null,
    locationLabel: "veslo",
    locationTitle: "/Users/example/projects/veslo",
    locationUsePathStyle: true,
  });
});

test("message-bearing chat without a selected id does not use new-session state", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: null,
    messageCount: 1,
    workspaceType: "local",
    activeWorkspaceRoot: "/Users/example/projects/veslo",
    localWorkspaceLabel: "Local workspace",
    remoteWorkspaceLabel: "Remote workspace",
    newSessionLabel: "New session",
    chatFallbackLabel: "Chat",
    isPrivateWorkspacePath: false,
  });

  assert.deepEqual(context, {
    stateLabel: null,
    locationLabel: "veslo",
    locationTitle: "/Users/example/projects/veslo",
    locationUsePathStyle: true,
  });
});

test("new chat without a known local directory still shows the state", () => {
  const context = resolveSessionTitlebarContext({
    selectedSessionId: null,
    messageCount: 0,
    workspaceType: "local",
    activeWorkspaceRoot: "",
    localWorkspaceLabel: "Local workspace",
    remoteWorkspaceLabel: "Remote workspace",
    newSessionLabel: "New session",
    chatFallbackLabel: "Chat",
    isPrivateWorkspacePath: false,
  });

  assert.deepEqual(context, {
    stateLabel: "New session",
    locationLabel: null,
    locationTitle: null,
    locationUsePathStyle: false,
  });
});
