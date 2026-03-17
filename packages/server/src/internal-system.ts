import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists, ensureDir } from "./utils.js";

export const INTERNAL_SYSTEM_VERSION = "2026-03-16.1";
const INTERNAL_SYSTEM_SOURCE = "openwork-snapshot";
const MANIFEST_SCHEMA_VERSION = 1;
const ROUTING_BLOCK_VERSION = 1;

const ROUTING_BLOCK_START = "<!-- VESLO_INTERNAL_ROUTING_START -->";
const ROUTING_BLOCK_END = "<!-- VESLO_INTERNAL_ROUTING_END -->";

const INTERNAL_PACKS = ["docx", "pdf", "pptx", "xlsx", "skill-creator"] as const;
const INTERNAL_AGENT_FILES = [
  "veslo-internal-docx.md",
  "veslo-internal-pdf.md",
  "veslo-internal-pptx.md",
  "veslo-internal-xlsx.md",
  "veslo-internal-skill-creator.md",
] as const;

type ProvisionStats = { written: number; unchanged: number };

export type WorkspaceProvisionResult = {
  version: string;
  status: "updated" | "unchanged";
  written: number;
  unchanged: number;
};

type InternalManifest = {
  schemaVersion: number;
  version: string;
  source: string;
  packs: string[];
  agents: string[];
  routingBlockVersion: number;
};

async function resolveInternalPackSourceRoot(): Promise<string> {
  const candidates = [
    join(import.meta.dir, "..", "..", "..", "internal", "veslo-internal-packs"),
    join(process.cwd(), "internal", "veslo-internal-packs"),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new Error("Internal pack source directory not found");
}

async function collectFiles(root: string, relative = ""): Promise<string[]> {
  const dir = relative ? join(root, relative) : root;
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const out: string[] = [];
  for (const entry of entries) {
    const nextRel = relative ? join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(root, nextRel)));
      continue;
    }
    if (entry.isFile()) {
      out.push(nextRel);
    }
  }
  return out;
}

async function writeIfChanged(path: string, content: string | Uint8Array, stats: ProvisionStats) {
  const nextBytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
  const existing = (await exists(path)) ? await readFile(path) : null;
  if (existing && Buffer.compare(existing, nextBytes) === 0) {
    stats.unchanged += 1;
    return;
  }
  await ensureDir(dirname(path));
  await writeFile(path, nextBytes);
  stats.written += 1;
}

function internalAgentDocument(input: { label: string; pack: string; summary: string }) {
  return `---
description: Veslo internal ${input.label} execution agent
mode: subagent
hidden: true
temperature: 0.1
tools:
  "*": false
  "read": true
  "write": true
  "edit": true
  "apply_patch": true
  "glob": true
  "grep": true
  "list": true
  "bash": true
---

You are a hidden Veslo internal execution agent.

Scope:
- ${input.summary}
- Use resources from \`.opencode/veslo/internal/${input.pack}\`.
- Load \`.opencode/veslo/internal/${input.pack}/SKILL.md\` first, then only the needed helper files.

Rules:
- Perform concrete file/tool work end-to-end.
- Keep edits deterministic and minimal.
- Return concise execution status and outputs to the parent.
- Do not expose internal implementation details unless explicitly requested in developer/debug mode.
`;
}

function internalSkillCreatorAgentDocument() {
  return `---
description: Veslo internal skill-creator execution agent
mode: subagent
hidden: true
temperature: 0.1
tools:
  "*": false
  "read": true
  "write": true
  "edit": true
  "apply_patch": true
  "glob": true
  "grep": true
  "list": true
  "bash": true
---

You are a hidden Veslo internal execution agent for reusable skill authoring.

Scope:
- Use resources from \`.opencode/veslo/internal/skill-creator\`.
- Load \`.opencode/veslo/internal/skill-creator/SKILL.md\` first.

Rules:
- Only run for explicit requests to create/update reusable skills.
- Create or update skills only in this workspace at \`.opencode/skills/<name>/SKILL.md\`.
- Keep the resulting skill concise and runnable.
- Do not write company-global/shared skills in this flow.
- Do not expose internal implementation details unless explicitly requested in developer/debug mode.
`;
}

function managedVesloRoutingBlock() {
  return `${ROUTING_BLOCK_START}
## Managed Internal Delegation (Veslo)

This block is managed by Veslo. Keep it intact.

Use hidden internal subagents for specialized document/skill work:
- \`veslo-internal-docx\`
- \`veslo-internal-pdf\`
- \`veslo-internal-pptx\`
- \`veslo-internal-xlsx\`
- \`veslo-internal-skill-creator\`

Delegation rules (balanced routing):
- Delegate to document subagents on strong signals:
  - file extensions (\`.docx\`, \`.pdf\`, \`.pptx\`, \`.xlsx\`)
  - attached files of those types
  - explicit file paths or workspace references to those files
  - strong phrasing about editing/extracting/converting/generating those formats
- Do not delegate general coding, planning, or plain-text tasks without document/file signals.
- Delegate to \`veslo-internal-skill-creator\` only when the user explicitly asks to create/update a reusable skill.
- For skill creation, keep output workspace-local in \`.opencode/skills/<name>/SKILL.md\`.

Execution behavior:
- Internal subagent identities are implementation details; do not surface their names unless explicitly requested in developer/debug context.
- Return normal progress/results in the parent session.
${ROUTING_BLOCK_END}`;
}

function upsertManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(ROUTING_BLOCK_START);
  if (start >= 0) {
    const end = existing.indexOf(ROUTING_BLOCK_END, start);
    if (end >= 0) {
      const afterEnd = end + ROUTING_BLOCK_END.length;
      const before = existing.slice(0, start).replace(/\n+$/g, "");
      const after = existing.slice(afterEnd).replace(/^\n+/g, "");
      const compactBlock = block.trimEnd();
      if (!before && !after) {
        return `${compactBlock}\n`;
      }
      const prefix = before ? `${before}\n\n` : "";
      const suffix = after ? `\n\n${after}` : "";
      return `${prefix}${compactBlock}${suffix}\n`;
    }
  }

  const trimmed = existing.trimEnd();
  if (!trimmed) return `${block.trimEnd()}\n`;
  return `${trimmed}\n\n${block.trimEnd()}\n`;
}

async function ensureVesloAgentRouting(workspaceRoot: string, stats: ProvisionStats) {
  const path = join(workspaceRoot, ".opencode", "agents", "veslo.md");
  const existing = (await exists(path)) ? await readFile(path, "utf8") : "";
  const next = upsertManagedBlock(existing, managedVesloRoutingBlock());
  await writeIfChanged(path, next, stats);
}

async function writeInternalAgents(workspaceRoot: string, stats: ProvisionStats) {
  const agentsRoot = join(workspaceRoot, ".opencode", "agents");
  await ensureDir(agentsRoot);

  const docs: Array<[string, string]> = [
    [
      "veslo-internal-docx.md",
      internalAgentDocument({
        label: "DOCX",
        pack: "docx",
        summary: "Handle .docx authoring, editing, conversion, and XML-safe patching tasks.",
      }),
    ],
    [
      "veslo-internal-pdf.md",
      internalAgentDocument({
        label: "PDF",
        pack: "pdf",
        summary: "Handle PDF extraction, form filling, transformation, and validation tasks.",
      }),
    ],
    [
      "veslo-internal-pptx.md",
      internalAgentDocument({
        label: "PPTX",
        pack: "pptx",
        summary: "Handle .pptx generation, slide edits, and OOXML-safe presentation updates.",
      }),
    ],
    [
      "veslo-internal-xlsx.md",
      internalAgentDocument({
        label: "XLSX",
        pack: "xlsx",
        summary: "Handle spreadsheet recalculation and workbook-safe mutation tasks.",
      }),
    ],
    ["veslo-internal-skill-creator.md", internalSkillCreatorAgentDocument()],
  ];

  for (const [filename, doc] of docs) {
    await writeIfChanged(join(agentsRoot, filename), doc, stats);
  }
}

async function copyInternalPacks(workspaceRoot: string, stats: ProvisionStats) {
  const sourceRoot = await resolveInternalPackSourceRoot();
  const destinationRoot = join(workspaceRoot, ".opencode", "veslo", "internal");
  await ensureDir(destinationRoot);

  for (const pack of INTERNAL_PACKS) {
    const sourcePack = join(sourceRoot, pack);
    const destinationPack = join(destinationRoot, pack);
    if (!(await exists(sourcePack))) {
      throw new Error(`Missing internal pack source: ${pack}`);
    }
    await ensureDir(destinationPack);

    const files = await collectFiles(sourcePack);
    for (const relativePath of files) {
      const sourcePath = join(sourcePack, relativePath);
      const destinationPath = join(destinationPack, relativePath);
      const content = await readFile(sourcePath);
      await writeIfChanged(destinationPath, content, stats);
    }
  }
}

async function writeInternalManifest(workspaceRoot: string, stats: ProvisionStats) {
  const manifest: InternalManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version: INTERNAL_SYSTEM_VERSION,
    source: INTERNAL_SYSTEM_SOURCE,
    packs: [...INTERNAL_PACKS],
    agents: INTERNAL_AGENT_FILES.map((name) => name.replace(/\.md$/i, "")),
    routingBlockVersion: ROUTING_BLOCK_VERSION,
  };
  const path = join(workspaceRoot, ".opencode", "veslo", "internal", "manifest.json");
  await writeIfChanged(path, `${JSON.stringify(manifest, null, 2)}\n`, stats);
}

export async function provisionWorkspaceInternalSystem(workspaceRoot: string): Promise<WorkspaceProvisionResult> {
  const stats: ProvisionStats = { written: 0, unchanged: 0 };

  await copyInternalPacks(workspaceRoot, stats);
  await writeInternalAgents(workspaceRoot, stats);
  await ensureVesloAgentRouting(workspaceRoot, stats);
  await writeInternalManifest(workspaceRoot, stats);

  return {
    version: INTERNAL_SYSTEM_VERSION,
    status: stats.written > 0 ? "updated" : "unchanged",
    written: stats.written,
    unchanged: stats.unchanged,
  };
}
