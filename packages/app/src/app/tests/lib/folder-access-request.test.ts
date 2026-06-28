import { strict as assert } from "node:assert";
import test from "node:test";

import {
  choosePickerStartPath,
  resolveFolderAccessRequestFromPermission,
  selectedFolderContainsRequestedPath,
} from "../../lib/folder-access-request";

test("starts picker at requested directory when it exists", () => {
  const result = choosePickerStartPath({
    requestedPath: "/Users/me/Drive/NDA",
    existingDirectories: new Set(["/Users", "/Users/me", "/Users/me/Drive", "/Users/me/Drive/NDA"]),
  });
  assert.equal(result, "/Users/me/Drive/NDA");
});

test("falls back to nearest existing parent for missing leaf", () => {
  const result = choosePickerStartPath({
    requestedPath: "/Users/me/Drive/NDA/file.docx",
    existingDirectories: new Set(["/Users", "/Users/me", "/Users/me/Drive", "/Users/me/Drive/NDA"]),
  });
  assert.equal(result, "/Users/me/Drive/NDA");
});

test("falls back to filesystem root when root is the nearest existing parent", () => {
  const result = choosePickerStartPath({
    requestedPath: "/Users/me/Drive/NDA/file.docx",
    existingDirectories: new Set(["/"]),
  });
  assert.equal(result, "/");
});

test("starts picker at nearest existing UNC parent without collapsing the share root", () => {
  const result = choosePickerStartPath({
    requestedPath: "\\\\Server\\Share\\Team\\NDA\\file.docx",
    existingDirectories: new Set(["\\\\Server\\Share", "\\\\Server\\Share\\Team"]),
  });
  assert.equal(result, "//Server/Share/Team");
});

test("accepts selected folder containing requested path", () => {
  assert.equal(
    selectedFolderContainsRequestedPath("/Users/me/Drive", "/Users/me/Drive/NDA/file.docx"),
    true,
  );
});

test("accepts filesystem root containing requested path", () => {
  assert.equal(selectedFolderContainsRequestedPath("/", "/Users/me/Drive/NDA/file.docx"), true);
});

test("accepts Windows paths with mixed separators and drive-letter casing", () => {
  assert.equal(
    selectedFolderContainsRequestedPath("C:\\Users\\Me\\Drive", "c:/users/me/drive/NDA/file.docx"),
    true,
  );
});

test("rejects requested paths that traverse outside the selected folder", () => {
  assert.equal(
    selectedFolderContainsRequestedPath("/Users/me/Drive", "/Users/me/Drive/../Other/file.docx"),
    false,
  );
});

test("rejects unrelated selected folder", () => {
  assert.equal(
    selectedFolderContainsRequestedPath("/Users/me/Other", "/Users/me/Drive/NDA/file.docx"),
    false,
  );
});

test("extracts folder access request from explicit permission metadata", () => {
  const request = resolveFolderAccessRequestFromPermission({
    permission: {
      id: "perm-folder",
      workspaceId: "ws-a",
      permission: "folder_access",
      patterns: [],
      metadata: {
        requestedPath: "/Users/me/Drive/NDA/file.docx",
        reason: "Read the requested document",
      },
    },
    workspacePath: "/Users/me/work",
    activeWorkspaceId: "ws-a",
    workspaces: [{ id: "ws-a", path: "/Users/me/work", workspaceType: "local" }],
    authorizedDirs: ["/Users/me/work"],
  });

  assert.deepEqual(request, {
    permissionId: "perm-folder",
    workspaceId: "ws-a",
    workspacePath: "/Users/me/work",
    requestedPath: "/Users/me/Drive/NDA/file.docx",
    reason: "Read the requested document",
    pickerStartPath: "/Users/me/Drive/NDA/file.docx",
  });
});

test("does not treat ordinary command permissions as folder access requests", () => {
  const request = resolveFolderAccessRequestFromPermission({
    permission: {
      id: "perm-bash",
      permission: "bash",
      patterns: ["git status"],
      metadata: {},
    },
    workspacePath: "/Users/me/work",
    authorizedDirs: ["/Users/me/work"],
  });

  assert.equal(request, null);
});

test("does not treat generic permissions with absolute path metadata as folder access requests", () => {
  const request = resolveFolderAccessRequestFromPermission({
    permission: {
      id: "perm-bash-path",
      permission: "bash",
      patterns: ["cat /Users/me/Drive/NDA/file.docx"],
      metadata: {
        path: "/Users/me/Drive/NDA/file.docx",
      },
    },
    workspacePath: "/Users/me/work",
    activeWorkspaceId: "ws-a",
    workspaces: [{ id: "ws-a", path: "/Users/me/work", workspaceType: "local" }],
    authorizedDirs: ["/Users/me/work"],
  });

  assert.equal(request, null);
});

test("uses the permission workspace id to resolve the local workspace path", () => {
  const request = resolveFolderAccessRequestFromPermission({
    permission: {
      id: "perm-folder-b",
      workspaceId: "ws-b",
      permission: "folder_access",
      patterns: [],
      metadata: {
        requestedPath: "/Users/me/Drive/NDA/file.docx",
      },
    },
    workspacePath: "/Users/me/work-a",
    activeWorkspaceId: "ws-a",
    workspaces: [
      { id: "ws-a", path: "/Users/me/work-a", workspaceType: "local" },
      { id: "ws-b", path: "/Users/me/work-b", workspaceType: "local" },
    ],
    authorizedDirs: ["/Users/me/work-a"],
  });

  assert.equal(request?.workspaceId, "ws-b");
  assert.equal(request?.workspacePath, "/Users/me/work-b");
});

test("does not resolve folder access requests for remote permission workspaces", () => {
  const request = resolveFolderAccessRequestFromPermission({
    permission: {
      id: "perm-folder-remote",
      workspaceId: "ws-remote",
      permission: "folder_access",
      patterns: [],
      metadata: {
        requestedPath: "/Users/me/Drive/NDA/file.docx",
      },
    },
    workspacePath: "/Users/me/work-a",
    activeWorkspaceId: "ws-a",
    workspaces: [
      { id: "ws-a", path: "/Users/me/work-a", workspaceType: "local" },
      {
        id: "ws-remote",
        path: "/Users/me/remote-cache",
        directory: "/Users/me/remote-cache",
        workspaceType: "remote",
      },
    ],
    authorizedDirs: ["/Users/me/work-a"],
  });

  assert.equal(request, null);
});
