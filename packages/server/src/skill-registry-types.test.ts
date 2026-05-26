import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import {
  validateRegistrySkillInstallationResponse,
  validateRegistrySkillListResponse,
  validateRegistrySkillPackageResponse,
  validateRegistrySkillResponse,
  validateRegistrySkillReviewRequestResponse,
  validateRegistrySkillSearchResponse,
  validateRegistrySkillVersionsResponse,
  validateWorkspaceSkillSetResponse,
} from "./skill-registry-types.js";
import { buildSkillPackageManifest } from "./skill-package-model.js";
import type { SkillPackageFile } from "./skill-package-model.js";
import { MAX_SKILL_PACKAGE_FILE_SIZE_BYTES } from "./skill-packages.js";

const digest = "a".repeat(64);
const skillText = "# Demo\n";
const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

const packageFile = (overrides: Partial<SkillPackageFile> = {}): SkillPackageFile => ({
  path: "SKILL.md",
  sha256: sha256(skillText),
  sizeBytes: Buffer.byteLength(skillText),
  mediaType: "text/markdown",
  text: skillText,
  ...overrides,
});

const registrySkill = (overrides: Record<string, unknown> = {}) => ({
  id: "skill_demo",
  slug: "demo",
  name: "Demo Skill",
  visibility: "workspace",
  reviewStatus: "approved",
  createdAt: "2026-05-26T10:00:00.000Z",
  updatedAt: "2026-05-26T11:00:00.000Z",
  latestVersion: {
    id: "version_demo_1",
    version: "1.0.0",
    packageSha256: digest,
    createdAt: "2026-05-26T10:30:00.000Z",
  },
  ...overrides,
});

const versionSummary = (overrides: Record<string, unknown> = {}) => ({
  id: "version_demo_1",
  version: "1.0.0",
  packageSha256: digest,
  createdAt: "2026-05-26T10:30:00.000Z",
  ...overrides,
});

const installation = (overrides: Record<string, unknown> = {}) => ({
  installationId: "install_1",
  skillId: "skill_demo",
  versionId: "version_demo_1",
  enabled: true,
  source: "workspace",
  installedAt: "2026-05-26T12:00:00.000Z",
  ...overrides,
});

test("validateRegistrySkillListResponse accepts conservative skill summaries", () => {
  const response = validateRegistrySkillListResponse({
    skills: [registrySkill()],
    nextCursor: "cursor_2",
  });

  expect(response.skills[0].id).toBe("skill_demo");
  expect(response.skills[0].latestVersion?.packageSha256).toBe(digest);
  expect(response.nextCursor).toBe("cursor_2");
});

test("validateRegistrySkillListResponse rejects unknown visibility and invalid digests", () => {
  expect(() =>
    validateRegistrySkillListResponse({
      skills: [registrySkill({ visibility: "public" })],
    }),
  ).toThrow(/visibility/);

  expect(() =>
    validateRegistrySkillListResponse({
      skills: [
        registrySkill({
          latestVersion: {
            id: "version_demo_1",
            version: "1.0.0",
            packageSha256: "not-a-digest",
            createdAt: "2026-05-26T10:30:00.000Z",
          },
        }),
      ],
    }),
  ).toThrow(/packageSha256/);
});

test("validateRegistrySkillResponse accepts a skill detail and rejects invalid dates", () => {
  const response = validateRegistrySkillResponse({
    skill: registrySkill({
      description: "Runs the demo workflow",
      tags: ["demo", "workflow"],
    }),
  });

  expect(response.skill.description).toBe("Runs the demo workflow");
  expect(response.skill.tags).toEqual(["demo", "workflow"]);

  expect(() =>
    validateRegistrySkillResponse({
      skill: registrySkill({ updatedAt: "not-a-date" }),
    }),
  ).toThrow(/updatedAt/);

  expect(() =>
    validateRegistrySkillResponse({
      skill: registrySkill({ updatedAt: "2026-02-31T10:00:00.000Z" }),
    }),
  ).toThrow(/updatedAt/);

  expect(() =>
    validateRegistrySkillResponse({
      skill: registrySkill({ updatedAt: "2026-05-26" }),
    }),
  ).toThrow(/updatedAt/);

  expect(() =>
    validateRegistrySkillResponse({
      skill: registrySkill({ updatedAt: "1" }),
    }),
  ).toThrow(/updatedAt/);
});

test("validateRegistrySkillVersionsResponse accepts versions and rejects invalid response shape", () => {
  const response = validateRegistrySkillVersionsResponse({
    versions: [versionSummary()],
    nextCursor: null,
  });

  expect(response.versions[0].version).toBe("1.0.0");
  expect(response.nextCursor).toBeNull();

  expect(() =>
    validateRegistrySkillVersionsResponse({
      versions: versionSummary(),
    }),
  ).toThrow(/versions/);
});

test("validateRegistrySkillPackageResponse validates the embedded skill package archive", async () => {
  const file = packageFile();
  const emptyFile = {
    path: "assets/empty.txt",
    sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    sizeBytes: 0,
    mediaType: "text/plain",
    text: "",
  };
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "Demo Skill", tags: ["demo"] },
    files: [file, emptyFile],
  });

  const response = validateRegistrySkillPackageResponse({
    versionId: "version_demo_1",
    skillId: "skill_demo",
    package: {
      ...manifest,
      files: [
        { ...file, contentBase64: Buffer.from(file.text ?? "").toString("base64") },
        { ...emptyFile, contentBase64: "" },
      ],
    },
  });

  expect(response.package.metadata.name).toBe("Demo Skill");
  expect(response.package.files[0].path).toBe("SKILL.md");
  expect(response.package.files.find((entry) => entry.path === "assets/empty.txt")?.contentBase64).toBe("");
});

test("validateRegistrySkillPackageResponse rejects package bytes that do not match the manifest", async () => {
  const file = packageFile();
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "Demo Skill" },
    files: [file],
  });

  expect(() =>
    validateRegistrySkillPackageResponse({
      versionId: "version_demo_1",
      skillId: "skill_demo",
      package: {
        ...manifest,
        files: [{ ...file, contentBase64: Buffer.from("# Xemo\n").toString("base64") }],
      },
    }),
  ).toThrow(/sha256/);
});

test("validateRegistrySkillPackageResponse rejects invalid or oversized package base64 content", async () => {
  const file = packageFile();
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "Demo Skill" },
    files: [file],
  });

  expect(() =>
    validateRegistrySkillPackageResponse({
      versionId: "version_demo_1",
      skillId: "skill_demo",
      package: {
        ...manifest,
        files: [{ ...file, contentBase64: "not base64!" }],
      },
    }),
  ).toThrow(/base64/);

  expect(() =>
    validateRegistrySkillPackageResponse({
      versionId: "version_demo_1",
      skillId: "skill_demo",
      package: {
        ...manifest,
        files: [{ ...file, contentBase64: Buffer.from(`${file.text ?? ""}extra`).toString("base64") }],
      },
    }),
  ).toThrow(/too large/);
});

test("validateRegistrySkillPackageResponse rejects package files over local install limits before decoding", async () => {
  const file = packageFile({
    sha256: "b".repeat(64),
    sizeBytes: MAX_SKILL_PACKAGE_FILE_SIZE_BYTES + 1,
    text: undefined,
  });
  const manifest = await buildSkillPackageManifest({
    metadata: { name: "Demo Skill" },
    files: [file],
  });

  expect(() =>
    validateRegistrySkillPackageResponse({
      versionId: "version_demo_1",
      skillId: "skill_demo",
      package: {
        ...manifest,
        files: [{ ...file, contentBase64: Buffer.alloc(0).toString("base64") }],
      },
    }),
  ).toThrow(/too large/);
});

test("validateRegistrySkillInstallationResponse accepts an installation and rejects unknown sources", () => {
  const response = validateRegistrySkillInstallationResponse({
    installation: installation({
      updatedAt: "2026-05-26T12:10:00.000Z",
    }),
  });

  expect(response.installation.source).toBe("workspace");
  expect(response.installation.updatedAt).toBe("2026-05-26T12:10:00.000Z");

  expect(() =>
    validateRegistrySkillInstallationResponse({
      installation: installation({ source: "platform" }),
    }),
  ).toThrow(/source/);
});

test("validateWorkspaceSkillSetResponse accepts installations and rejects duplicate skill ids", () => {
  const response = validateWorkspaceSkillSetResponse({
    workspaceId: "workspace_1",
    skills: [installation()],
  });

  expect(response.skills[0].source).toBe("workspace");

  expect(() =>
    validateWorkspaceSkillSetResponse({
      workspaceId: "workspace_1",
      skills: [
        installation(),
        installation({
          installationId: "install_2",
          versionId: "version_demo_2",
          installedAt: "2026-05-26T12:01:00.000Z",
        }),
      ],
    }),
  ).toThrow(/duplicate skillId/);
});

test("validateRegistrySkillReviewRequestResponse accepts review state and rejects draft status", () => {
  const response = validateRegistrySkillReviewRequestResponse({
    requestId: "review_1",
    skillId: "skill_demo",
    status: "pending_review",
    createdAt: "2026-05-26T13:00:00.000Z",
    updatedAt: "2026-05-26T13:05:00.000Z",
  });

  expect(response.status).toBe("pending_review");

  expect(() =>
    validateRegistrySkillReviewRequestResponse({
      requestId: "review_1",
      skillId: "skill_demo",
      status: "draft",
      createdAt: "2026-05-26T13:00:00.000Z",
    }),
  ).toThrow(/status/);
});

test("validateRegistrySkillSearchResponse accepts query results and rejects empty query", () => {
  const response = validateRegistrySkillSearchResponse({
    query: "demo",
    skills: [registrySkill()],
  });

  expect(response.query).toBe("demo");
  expect(response.skills[0].id).toBe("skill_demo");

  expect(() =>
    validateRegistrySkillSearchResponse({
      query: " ",
      skills: [registrySkill()],
    }),
  ).toThrow(/query/);
});
