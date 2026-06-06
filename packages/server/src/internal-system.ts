import { lstat, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { exists, ensureDir } from "./utils.js";

export const INTERNAL_SYSTEM_VERSION = "2026-04-22.1";
const INTERNAL_SYSTEM_SOURCE = "openwork-snapshot";
const MANIFEST_SCHEMA_VERSION = 1;
const ROUTING_BLOCK_VERSION = 3;

const DELEGATE_PLUGIN_FILE = "veslo-delegate.js";
const AUTOMATIONS_PLUGIN_FILE = "veslo-automations.js";

const ROUTING_BLOCK_START = "<!-- VESLO_INTERNAL_ROUTING_START -->";
const ROUTING_BLOCK_END = "<!-- VESLO_INTERNAL_ROUTING_END -->";

const INSTRUCTIONS_BLOCK_START = "<!-- VESLO_INSTRUCTIONS_START -->";
const INSTRUCTIONS_BLOCK_END = "<!-- VESLO_INSTRUCTIONS_END -->";

const AGENT_BLOCK_START = "<!-- VESLO_AGENT_INSTRUCTIONS_START -->";
const AGENT_BLOCK_END = "<!-- VESLO_AGENT_INSTRUCTIONS_END -->";

const INTERNAL_PACKS = ["docx", "pdf", "pptx", "xlsx", "skill-creator", "research"] as const;
const INTERNAL_AGENT_FILES = [
  "veslo-internal-docx.md",
  "veslo-internal-pdf.md",
  "veslo-internal-pptx.md",
  "veslo-internal-xlsx.md",
  "veslo-internal-skill-creator.md",
  "veslo-internal-research.md",
] as const;
const INTERNAL_PLUGIN_FILES = [DELEGATE_PLUGIN_FILE, AUTOMATIONS_PLUGIN_FILE] as const;

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
  plugins: string[];
  routingBlockVersion: number;
  packsMode?: string;
  centralPacksDir?: string;
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
temperature: 0.5
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

MANDATORY first step:
1. Read \`.opencode/veslo/internal/${input.pack}/SKILL.md\` using the read tool.
2. Follow the workflow described in SKILL.md exactly.
3. Only read additional helper files when SKILL.md references them.

Critical rules:
- You MUST read SKILL.md before doing anything else. Do not skip this step.
- You MUST produce files in the correct binary format (e.g. .docx must be a valid ZIP/OOXML archive, not plaintext).
- If SKILL.md says to use a library (e.g. \`npm install -g docx\`, \`pip install pypdf\`), install it first via bash, then use it.
- Perform concrete file/tool work end-to-end.
- Keep edits deterministic and minimal.
- Return concise execution status and outputs to the parent.
- Do not dump raw JSON, manifests, tool payloads, or full generated file contents unless explicitly requested.
- Do not expose internal implementation details unless explicitly requested in developer/debug mode.
`;
}

function internalSkillCreatorAgentDocument() {
  return `---
description: Veslo internal skill-creator execution agent
mode: subagent
hidden: true
temperature: 0.5
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
- Do not dump raw JSON, manifests, tool payloads, or full generated file contents unless explicitly requested.
- Do not expose internal implementation details unless explicitly requested in developer/debug mode.
`;
}

function managedVesloRoutingBlock() {
  return `${ROUTING_BLOCK_START}
## Managed Internal Delegation (Veslo)

This block is managed by Veslo. Keep it intact.

Document, skill, and explicit subagent requests are handled via the \`delegate\` tool, which routes work
to specialized hidden subagents. Use it like any other tool — the model selects it
based on context (file types, document references, skill creation requests, explicit delegation language).

Execution behavior:
- Internal subagent identities are implementation details; do not surface their names unless explicitly requested in developer/debug context.
- Return normal progress/results in the parent session.
${ROUTING_BLOCK_END}`;
}

function managedVesloAgentInstructionsBlock() {
  return `${AGENT_BLOCK_START}
## Managed Agent Instructions (Veslo)

This block is managed by Veslo. Keep it intact.

### Response Style
- Simple question: answer directly and concisely.
- Complex task: outline steps first, then execute one by one.
- File question: read and explain, ask before modifying.
- Unclear request: ask one clarifying question rather than guessing.

### Output Hygiene
- Do not print raw JSON, tool payloads, message objects, file manifests, event objects, or internal diagnostic structures in the user-facing final answer unless the user explicitly asks for that raw data or a loaded skill requires it.
- When a structured file is created or updated, summarize what changed and reference the file path instead of dumping the file contents.
- If technical detail is useful, keep it short and explain it in normal language.

### Communication Style
- Progressive disclosure: start with a simple answer, add technical details only if asked.
- Explain what you're doing and why, in terms the user can understand.
- Adapt to the user's technical level based on their language and questions.
- For file operations, explain the impact before making changes.

### Document Download Safety
- Prefer stable document links when multiple variants exist; avoid session-bound or short-lived download URLs unless no stable option exists.
- If a fetch tool already returned bytes for a file URL, persist those bytes to a workspace file and reuse that file. Do not re-download the same URL with curl/wget.
- Before attaching a claimed PDF, validate bytes in the saved file: it should contain a PDF header ('%PDF-') and must not start as HTML/XML error content.
- If validation fails, do not attach the file. Continue with a short diagnostic note and request/choose a different document source.

### Veslo Tools & Features
- **delegate** — routes document tasks and explicit "use subagent/delegate" requests to specialized subagents.
- **Skills** — reusable workflows in \`.opencode/skills/\`. Suggest creating one when work repeats.
- **Scheduler** — recurring tasks (daily, weekly, interval). Mention when a task could be automated.
- **Workspace** — user may have multiple workspaces; respect workspace boundaries.

### User Memory
- When the user says "remember this", "zapamatuj si", or "ulož si", persist the information to \`.opencode/soul-user.md\`.
- Read the file first, append new entries, then write it back. Do not overwrite existing content.
- Keep entries concise — one line per fact, grouped logically.
- Never store credentials, tokens, or API keys in this file.
${AGENT_BLOCK_END}`;
}

function managedVesloInstructionsBlock() {
  return `${INSTRUCTIONS_BLOCK_START}
# Veslo

This is Veslo — a desktop AI application. When the user says "you", they mean Veslo.

## Identity
- Introduce yourself as Veslo, not OpenCode.
- Do not use CLI references (ctrl+p, /help, terminal) — the user works in a GUI.
- Do not reference opencode.ai or github.com/anomalyco/opencode.

## Tone
- Professional, calm, clear.
- Do not assume programming knowledge — explain simply.
- Adjust response length to question complexity (not always <4 lines).
- When working with files, explain what you are doing and why.

## Veslo Features
- **Skills** — reusable workflows in \`.opencode/skills/\`. If a task repeats, suggest creating a skill.
- **Office files** — Veslo can process DOCX, PDF, PPTX, XLSX via internal agents.
- **Workspace** — the user may have multiple workspaces and switch between them.
- **Scheduler** — recurring tasks can be scheduled (daily, weekly, interval).

## Safety
- Explain consequences before destructive actions.
- Never commit credentials, tokens, or API keys.
- Store sensitive data only in gitignored files.
${INSTRUCTIONS_BLOCK_END}`;
}

function upsertManagedBlock(
  existing: string,
  block: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = existing.indexOf(startMarker);
  if (start >= 0) {
    const end = existing.indexOf(endMarker, start);
    if (end >= 0) {
      const afterEnd = end + endMarker.length;
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

const LEGACY_ONBOARDING_SKILLS = ["workspace-guide", "get-started"] as const;

function normalizeLegacySkillContent(content: string) {
  return content.replace(/\r\n/g, "\n").replace(/\\"/g, '"');
}

function isLegacyWorkspaceGuideContent(content: string) {
  const normalized = normalizeLegacySkillContent(content);
  return normalized.includes("name: workspace-guide") &&
    normalized.includes("description: Workspace guide to introduce") &&
    normalized.includes("onboard new users") &&
    normalized.includes("# Welcome to") &&
    (normalized.includes("End with two friendly next actions to try") ||
      normalized.includes("local-first alternative to Claude"));
}

function isLegacyGetStartedContent(content: string) {
  const normalized = normalizeLegacySkillContent(content);
  return normalized.includes("name: get-started") &&
    normalized.includes("description: Guide users through the get started setup") &&
    normalized.includes("Chrome DevTools demo") &&
    normalized.includes('Always load this skill when the user says "get started"') &&
    normalized.includes("Reply with these four lines, exactly and in order");
}

function isLegacyOnboardingSkillContent(name: string, content: string) {
  if (name === "workspace-guide") return isLegacyWorkspaceGuideContent(content);
  if (name === "get-started") return isLegacyGetStartedContent(content);
  return false;
}

async function skillDirContainsOnlyEntrypoint(skillDir: string) {
  const entries = await readdir(skillDir, { withFileTypes: true });
  return entries.length === 1 && entries[0]?.isFile() && entries[0].name === "SKILL.md";
}

async function removeLegacyOnboardingSkills(workspaceRoot: string, stats: ProvisionStats) {
  const skillRoot = join(workspaceRoot, ".opencode", "skills");
  if (!(await exists(skillRoot))) return;

  for (const name of LEGACY_ONBOARDING_SKILLS) {
    const skillDir = join(skillRoot, name);
    const skillPath = join(skillDir, "SKILL.md");
    if (!(await exists(skillPath))) continue;
    if (!(await skillDirContainsOnlyEntrypoint(skillDir))) continue;

    const content = await readFile(skillPath, "utf8");
    if (!isLegacyOnboardingSkillContent(name, content)) continue;

    await rm(skillDir, { recursive: true, force: true });
    stats.written += 1;
  }
}

async function ensureWorkspaceInstructions(workspaceRoot: string, stats: ProvisionStats) {
  const path = join(workspaceRoot, "AGENTS.md");
  const existing = (await exists(path)) ? await readFile(path, "utf8") : "";
  const next = upsertManagedBlock(
    existing,
    managedVesloInstructionsBlock(),
    INSTRUCTIONS_BLOCK_START,
    INSTRUCTIONS_BLOCK_END,
  );
  await writeIfChanged(path, next, stats);
}

async function ensureVesloAgentRouting(workspaceRoot: string, stats: ProvisionStats) {
  const path = join(workspaceRoot, ".opencode", "agents", "veslo.md");
  // veslo.md base content is written by Rust (seed_veslo_agent) at workspace creation.
  // TS only upserts managed blocks — if the file doesn't exist, skip.
  if (!(await exists(path))) return;

  const raw = await readFile(path, "utf8");
  let next = upsertManagedBlock(raw, managedVesloRoutingBlock(), ROUTING_BLOCK_START, ROUTING_BLOCK_END);
  next = upsertManagedBlock(next, managedVesloAgentInstructionsBlock(), AGENT_BLOCK_START, AGENT_BLOCK_END);
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
    [
      "veslo-internal-research.md",
      internalAgentDocument({
        label: "Research",
        pack: "research",
        summary:
          "Handle explicit user requests to run/delegate to a subagent for general research or multi-step execution.",
      }),
    ],
  ];

  for (const [filename, doc] of docs) {
    await writeIfChanged(join(agentsRoot, filename), doc, stats);
  }
}

function delegatePluginSource(): string {
  return `import { tool } from "@opencode-ai/plugin";

/**
 * Veslo Delegate Plugin
 *
 * Registers a \`delegate\` tool that the model can call via native tool_use
 * to route work to specialized Veslo internal subagents (docx, pdf, pptx,
 * xlsx, skill-creator, research).
 *
 * This replaces text-based routing with a hard tool-call mechanism — the
 * same way the model invokes read, bash, etc.
 *
 * Managed by Veslo internal system (v${INTERNAL_SYSTEM_VERSION}). Do not edit manually.
 */

const AGENTS = [
  "veslo-internal-docx",
  "veslo-internal-pdf",
  "veslo-internal-pptx",
  "veslo-internal-xlsx",
  "veslo-internal-skill-creator",
  "veslo-internal-research",
];

const FORCE_DELEGATE_PREFIX = "[VESLO_ROUTER_FORCE_DELEGATE]";

function normalizedText(value) {
  return \` \${String(value || "")
    .toLowerCase()
    .replaceAll("\\n", " ")
    .replaceAll("\\r", " ")
    .replaceAll("\\t", " ")} \`;
}

function includesAny(value, tokens) {
  return tokens.some((token) => value.includes(token));
}

function hasExplicitDelegateRequest(value) {
  return includesAny(value, [
    " subagent ",
    " sub-agent ",
    " subagenta",
    " subagenti",
    " spusť subagenta",
    " spust subagenta",
    " použij subagenta",
    " pouzij subagenta",
    " spawn subagent",
    " run subagent",
    " start subagent",
    " use subagent",
    " delegate this ",
    " delegate to subagent",
    " delegate to a subagent",
    " deleguj na subagenta",
    " deleguj to ",
  ]);
}

function detectDelegateAgentFromText(text) {
  const value = normalizedText(text);

  if (
    includesAny(value, [
      " skill ",
      " skills ",
      " skill.md ",
      " .opencode/skills ",
      " create skill ",
      " update skill ",
      " vytvor skill ",
      " vytvorit skill ",
      " uprav skill ",
      " skill creator ",
    ])
  ) {
    return "veslo-internal-skill-creator";
  }

  if (
    includesAny(value, [
      ".xlsx",
      ".xlsm",
      ".xls ",
      ".csv",
      ".tsv",
      " excel ",
      " excelu ",
      " exelu ",
      " spreadsheet ",
      " workbook ",
      " worksheet ",
      " tabulk",
      " sesit ",
      " sloupc",
      " radek ",
      " radku ",
      " bunka ",
      " listu ",
    ])
  ) {
    return "veslo-internal-xlsx";
  }

  if (
    includesAny(value, [
      ".docx",
      ".doc ",
      " docx ",
      " word ",
      " dokument ",
      " smlouva ",
    ])
  ) {
    return "veslo-internal-docx";
  }

  if (includesAny(value, [".pdf", " pdf ", " acrobat "])) {
    return "veslo-internal-pdf";
  }

  if (
    includesAny(value, [
      ".pptx",
      ".ppt ",
      " pptx ",
      " powerpoint ",
      " prezentace ",
      " slide ",
      " slides ",
      " slajd ",
    ])
  ) {
    return "veslo-internal-pptx";
  }

  if (hasExplicitDelegateRequest(value)) {
    return "veslo-internal-research";
  }

  return null;
}

function textParts(parts) {
  return (parts || [])
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\\n")
    .trim();
}

function forceDelegateInstruction(agent, userText) {
  return [
    \`\${FORCE_DELEGATE_PREFIX} \${agent}\`,
    "Managed Veslo routing:",
    \`First action MUST be a tool call: delegate(agent=\\"\${agent}\\").\`,
    "Use the full original user request as delegate.task.",
    "Do not answer from memory before delegate returns.",
    "",
    "IMPORTANT: Do NOT use the 'skill' tool for this request. The delegate tool",
    "routes to a specialized subagent that has the correct tools and context.",
    "Using 'skill' instead of 'delegate' will produce incorrect results.",
    "",
    "Original user request:",
    userText,
  ].join("\\n");
}

export default async (ctx) => {
  const { client } = ctx;

  return {
    "chat.message": async (input, output) => {
      if (input.agent && input.agent !== "veslo") return;

      const userText = textParts(output.parts);
      if (!userText) return;
      if (userText.includes(FORCE_DELEGATE_PREFIX)) return;

      const delegateAgent = detectDelegateAgentFromText(userText);
      if (!delegateAgent) return;

      output.parts = [
        {
          type: "text",
          text: forceDelegateInstruction(delegateAgent, userText),
        },
        ...output.parts,
      ];
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return;

      let latestUser = null;
      try {
        const messages = await client.session.messages({
          path: { sessionID: input.sessionID },
          query: { limit: 8 },
        });
        const history = Array.isArray(messages.data) ? messages.data : [];
        for (let index = history.length - 1; index >= 0; index -= 1) {
          const candidate = history[index];
          if (candidate?.info?.role === "user") {
            latestUser = candidate;
            break;
          }
        }
      } catch {
        return;
      }

      if (!latestUser) return;
      if (latestUser.info?.agent && latestUser.info.agent !== "veslo") return;

      const userText = textParts(latestUser.parts);
      if (!userText) return;

      const delegateAgent = detectDelegateAgentFromText(userText);
      if (!delegateAgent) return;

      output.system.push(
        [
          "Managed Veslo routing instruction:",
          \`For the current user request, first action MUST be tool call delegate(agent=\\"\${delegateAgent}\\").\`,
          "Pass the full user request as delegate.task.",
          "Do not answer from memory before delegate returns.",
          "Do NOT use the 'skill' tool — use 'delegate' exclusively.",
        ].join("\\n"),
      );
    },
    tool: {
      delegate: tool({
        description: [
          "Delegate a task to a specialized Veslo subagent.",
          "Use this tool when the user's message involves documents, skill creation,",
          "or explicitly asks to run/delegate to a subagent:",
          "- veslo-internal-xlsx: Excel/spreadsheet files (.xlsx, .xlsm, .csv, .tsv) — reading, writing, editing, charting, formulas",
          "- veslo-internal-docx: Word documents (.docx) — authoring, editing, conversion, formatting",
          "- veslo-internal-pdf: PDF files (.pdf) — extraction, form filling, transformation, merging",
          "- veslo-internal-pptx: PowerPoint presentations (.pptx) — creating, editing slides",
          "- veslo-internal-skill-creator: Creating or updating reusable skills (only on explicit user request)",
          "- veslo-internal-research: Explicit user request to run/delegate to a subagent for general research/execution",
          "",
          "Delegate on any signal that document work is needed: file extensions, attached files,",
          "file paths, references to document content, or phrasing about editing/reading/creating",
          "those formats. When unsure whether a file exists, delegate to search for it.",
          "Do not delegate general coding or plain-text tasks unless the user explicitly requests subagent delegation.",
          "",
          "Return the subagent's results directly. Do not expose internal agent names to the user.",
        ].join("\\n"),
        args: {
          agent: tool.schema
            .enum(AGENTS)
            .describe("Which specialized subagent to delegate the task to"),
          task: tool.schema
            .string()
            .describe("Complete description of what the subagent should do, including any relevant context from the conversation"),
        },
        async execute(args, context) {
          try {
            let parentDirectory = "";
            try {
              const parent = await client.session.get({
                path: { sessionID: context.sessionID },
              });
              const candidate =
                (typeof parent?.data?.directory === "string" && parent.data.directory.trim()) ||
                (typeof parent?.directory === "string" && parent.directory.trim()) ||
                "";
              parentDirectory = candidate || "";
            } catch {
              // Fallback to default workspace directory when parent lookup fails.
            }

            const created = await client.session.create({
              ...(parentDirectory ? { query: { directory: parentDirectory } } : {}),
              body: {
                parentID: context.sessionID,
                title: \`Delegate: \${args.agent}\`,
              },
            });

            const sessionId = created.data?.id ?? created.data;
            if (!sessionId) {
              return "Error: Failed to create delegate session — no session ID returned.";
            }

            const response = await client.session.prompt({
              path: { id: typeof sessionId === "string" ? sessionId : String(sessionId) },
              body: {
                agent: args.agent,
                parts: [{ type: "text", text: args.task }],
              },
            });

            const parts = response.data?.parts ?? [];
            const textParts = parts.filter((p) => p.type === "text");
            const result = textParts.map((p) => p.text).join("\\n").trim();
            return result || "Task completed (no text output from subagent).";
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return \`Error during delegation to \${args.agent}: \${message}\`;
          }
        },
      }),
    },
  };
};
`;
}

function automationsPluginSource(): string {
  return `import { readFile } from "node:fs/promises";
import { tool } from "@opencode-ai/plugin";

/**
 * Veslo Automations Plugin
 *
 * Registers tools that create, inspect, update, cancel, and run persistent
 * Veslo app-backed automations through the running Veslo server.
 *
 * Managed by Veslo internal system (v${INTERNAL_SYSTEM_VERSION}). Do not edit manually.
 */

const AUTOMATIONS_ROUTE_TEMPLATE = "/workspace/\${workspaceId}/automations";
const TIMEZONE_CAPABLE_SCHEDULES = new Set(["oneShot", "cron", "daily", "weekly"]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDirectoryPath(value) {
  return cleanString(value).replace(/\\\\/g, "/").replace(/\\/+$/, "");
}

function firstWorkspaceIdCandidate(value) {
  if (!value || typeof value !== "object") return "";
  const direct =
    cleanString(value.workspaceId) ||
    cleanString(value.workspaceID) ||
    cleanString(value.id && value.type === "workspace" ? value.id : "") ||
    cleanString(value.workspace && value.workspace.id) ||
    cleanString(value.workspace && value.workspace.workspaceId) ||
    cleanString(value.workspace && value.workspace.workspaceID) ||
    cleanString(value.project && value.project.workspaceId) ||
    cleanString(value.project && value.project.workspaceID);
  if (direct) return direct;
  if (value.data && typeof value.data === "object") {
    return firstWorkspaceIdCandidate(value.data);
  }
  if (value.session && typeof value.session === "object") {
    return firstWorkspaceIdCandidate(value.session);
  }
  return "";
}

function firstDirectoryCandidate(value) {
  if (!value || typeof value !== "object") return "";
  const direct =
    cleanString(value.directory) ||
    cleanString(value.cwd) ||
    cleanString(value.workdir) ||
    cleanString(value.path) ||
    cleanString(value.workspace && value.workspace.directory) ||
    cleanString(value.workspace && value.workspace.path) ||
    cleanString(value.workspace && value.workspace.opencode && value.workspace.opencode.directory) ||
    cleanString(value.project && value.project.directory) ||
    cleanString(value.project && value.project.path);
  if (direct) return direct;
  if (value.data && typeof value.data === "object") {
    return firstDirectoryCandidate(value.data);
  }
  if (value.session && typeof value.session === "object") {
    return firstDirectoryCandidate(value.session);
  }
  return "";
}

async function readOpenCodeSession(context, client) {
  const sessionID = cleanString(context && context.sessionID);
  if (!sessionID || !client || !client.session || typeof client.session.get !== "function") {
    return null;
  }
  try {
    return await client.session.get({ path: { sessionID } });
  } catch {
    return null;
  }
}

function workspaceDirectoryCandidates(workspace) {
  if (!workspace || typeof workspace !== "object") return [];
  return [
    workspace.path,
    workspace.directory,
    workspace.opencode && workspace.opencode.directory,
    workspace.workspace && workspace.workspace.path,
    workspace.workspace && workspace.workspace.directory,
    workspace.workspace && workspace.workspace.opencode && workspace.workspace.opencode.directory,
  ]
    .map(normalizeDirectoryPath)
    .filter(Boolean);
}

function matchWorkspaceByDirectory(workspaces, directory) {
  const target = normalizeDirectoryPath(directory);
  if (!target || !Array.isArray(workspaces)) return "";
  const matches = [];
  for (const workspace of workspaces) {
    const id = cleanString(workspace && workspace.id);
    if (!id) continue;
    if (workspaceDirectoryCandidates(workspace).some((candidate) => candidate === target)) {
      matches.push(id);
    }
  }
  return Array.from(new Set(matches)).length === 1 ? matches[0] : "";
}

function activeWorkspaceIdWhenSafe(workspacesPayload) {
  const activeId = cleanString(workspacesPayload && workspacesPayload.activeId);
  const items = Array.isArray(workspacesPayload && workspacesPayload.items) ? workspacesPayload.items : [];
  if (!activeId || items.length !== 1) return "";
  return cleanString(items[0] && items[0].id) === activeId ? activeId : "";
}

async function fetchWorkspaces(state) {
  return await vesloFetchJson(state, "/workspaces", { method: "GET" });
}

async function resolveWorkspaceId(args, context, client, state) {
  const explicit = cleanString(args.workspaceId);
  if (explicit) return explicit;

  const fromContext = firstWorkspaceIdCandidate(context);
  if (fromContext) return fromContext;

  const session = await readOpenCodeSession(context, client);
  const fromSession = firstWorkspaceIdCandidate(session);
  if (fromSession) return fromSession;

  const directory = firstDirectoryCandidate(context) || firstDirectoryCandidate(session);
  if (state) {
    const workspaces = await fetchWorkspaces(state);
    const fromDirectory = matchWorkspaceByDirectory(workspaces.items, directory);
    if (fromDirectory) return fromDirectory;
    const fromActive = activeWorkspaceIdWhenSafe(workspaces);
    if (fromActive) return fromActive;
  }

  return "";
}

function missingWorkspaceIdError() {
  return "Error: workspaceId is required. Provide workspaceId explicitly; Veslo could not match the current OpenCode directory to a workspace.";
}

async function readServerState() {
  const statePath = cleanString(process.env.VESLO_SERVER_STATE_PATH);
  if (!statePath) {
    return {
      error: "Error: VESLO_SERVER_STATE_PATH is not set. Start the Veslo desktop server and retry.",
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: "Error: Failed to read Veslo server state: " + message };
  }

  const baseUrl = cleanString(parsed && parsed.baseUrl).replace(/\\/+$/, "");
  const clientToken = cleanString(parsed && parsed.clientToken);
  if (!baseUrl || !clientToken) {
    return {
      error: "Error: Veslo server state is missing baseUrl or clientToken. Restart the Veslo desktop server and retry.",
    };
  }

  return { baseUrl, clientToken };
}

async function vesloFetchJson(state, path, options) {
  const response = await fetch(state.baseUrl + path, {
    method: options.method,
    headers: {
      Authorization: "Bearer " + state.clientToken,
      "Content-Type": "application/json",
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = cleanString(payload && (payload.message || payload.error || payload.code));
    } catch {
      detail = cleanString(await response.text().catch(() => ""));
    }
    throw new Error("Veslo API request failed with HTTP " + response.status + (detail ? ": " + detail : ""));
  }

  if (response.status === 204) return {};
  return await response.json();
}

function automationsPath(workspaceId) {
  return "/workspace/" + encodeURIComponent(workspaceId) + "/automations";
}

async function vesloRequest(state, workspaceId, suffix, options) {
  return await vesloFetchJson(state, automationsPath(workspaceId) + suffix, options);
}

function summarizeAutomation(automation) {
  if (!automation || typeof automation !== "object") return automation;
  return {
    id: automation.id,
    status: automation.status,
    nextRunAt: automation.nextRunAt ?? null,
  };
}

function summarizeRun(run) {
  if (!run || typeof run !== "object") return run;
  return {
    id: run.id,
    automationId: run.automationId,
    status: run.status,
    sessionId: run.sessionId ?? null,
  };
}

function jsonSummary(value) {
  return JSON.stringify(value, null, 2);
}

function createTarget(args, context) {
  const explicit = args.target === undefined ? {} : args.target;
  if (!explicit || typeof explicit !== "object" || Array.isArray(explicit)) {
    return { error: "Error: target must be an object when provided." };
  }

  const target = { ...explicit };
  if (!Object.prototype.hasOwnProperty.call(target, "preferredSessionId")) {
    const sessionID = cleanString(context && context.sessionID);
    if (sessionID) {
      target.preferredSessionId = sessionID;
    }
  }
  return { target };
}

function withTopLevelTimezone(schedule, timezone) {
  const normalizedTimezone = cleanString(timezone);
  if (!normalizedTimezone || !schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    return schedule;
  }
  if (schedule.kind === "interval" || !TIMEZONE_CAPABLE_SCHEDULES.has(schedule.kind)) {
    return schedule;
  }
  if (Object.prototype.hasOwnProperty.call(schedule, "timezone")) {
    return schedule;
  }
  return { ...schedule, timezone: normalizedTimezone };
}

function definedPatch(args, keys) {
  const out = {};
  for (const key of keys) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

async function withVesloWorkspace(args, context, client, action) {
  const state = await readServerState();
  if (state.error) return state.error;

  const workspaceId = await resolveWorkspaceId(args, context, client, state);
  if (!workspaceId) return missingWorkspaceIdError();

  try {
    return await action(state, workspaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return "Error: " + message;
  }
}

export default async (ctx) => {
  const { client } = ctx;

  return {
    tool: {
      veslo_create_automation: tool({
        description: "Create a persistent Veslo automation in the current workspace through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
          id: tool.schema.string().optional().describe("Optional stable automation id."),
          name: tool.schema.string().describe("Short automation name."),
          prompt: tool.schema.string().describe("Prompt to run when the automation fires."),
          schedule: tool.schema.any().describe("Automation schedule object: oneShot, interval, daily, weekly, or cron."),
          timezone: tool.schema.string().optional().describe("Optional timezone for oneShot, cron, daily, or weekly schedules when schedule.timezone is absent."),
          target: tool.schema.any().optional().describe("Optional target overrides such as preferredSessionId, fallbackTitle, agent, model, or variant."),
          enabled: tool.schema.boolean().optional().describe("Whether the automation starts enabled."),
          status: tool.schema.enum(["active", "paused", "completed", "failed", "cancelled"]).optional().describe("Initial automation status."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            if (args.schedule === undefined) return "Error: schedule is required.";
            const target = createTarget(args, context);
            if (target.error) return target.error;
            const body = {
              ...definedPatch(args, ["id", "enabled", "status"]),
              name: args.name,
              prompt: args.prompt,
              schedule: withTopLevelTimezone(args.schedule, args.timezone),
              target: target.target,
            };
            const data = await vesloRequest(state, workspaceId, "", { method: "POST", body });
            return jsonSummary({
              action: "created",
              automation: summarizeAutomation(data.automation),
            });
          });
        },
      }),

      veslo_list_automations: tool({
        description: "List persistent Veslo automations for a workspace through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            const data = await vesloRequest(state, workspaceId, "", { method: "GET" });
            const items = Array.isArray(data.items) ? data.items.map(summarizeAutomation) : [];
            return jsonSummary({ count: items.length, items });
          });
        },
      }),

      veslo_run_automation: tool({
        description: "Run a persistent Veslo automation immediately through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
          automationId: tool.schema.string().describe("Automation id to run."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            const suffix = "/" + encodeURIComponent(args.automationId) + "/run";
            const data = await vesloRequest(state, workspaceId, suffix, { method: "POST" });
            return jsonSummary({ action: "ran", run: summarizeRun(data.run) });
          });
        },
      }),

      veslo_update_automation: tool({
        description: "Update a persistent Veslo automation through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
          automationId: tool.schema.string().describe("Automation id to update."),
          name: tool.schema.string().optional().describe("Updated automation name."),
          prompt: tool.schema.string().optional().describe("Updated automation prompt."),
          schedule: tool.schema.any().optional().describe("Updated automation schedule object."),
          target: tool.schema.any().optional().describe("Updated target object."),
          enabled: tool.schema.boolean().optional().describe("Updated enabled flag."),
          status: tool.schema.enum(["active", "paused", "completed", "failed", "cancelled"]).optional().describe("Updated automation status."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            const body = definedPatch(args, ["name", "prompt", "schedule", "target", "enabled", "status"]);
            const suffix = "/" + encodeURIComponent(args.automationId);
            const data = await vesloRequest(state, workspaceId, suffix, { method: "PATCH", body });
            return jsonSummary({
              action: "updated",
              automation: summarizeAutomation(data.automation),
            });
          });
        },
      }),

      veslo_delete_automation: tool({
        description: "Cancel a persistent Veslo automation through the running Veslo server.",
        args: {
          workspaceId: tool.schema.string().optional().describe("Veslo workspace id. Provide this when it cannot be inferred from the current session."),
          automationId: tool.schema.string().describe("Automation id to cancel."),
        },
        async execute(args, context) {
          return await withVesloWorkspace(args, context, client, async (state, workspaceId) => {
            const suffix = "/" + encodeURIComponent(args.automationId);
            const data = await vesloRequest(state, workspaceId, suffix, { method: "DELETE" });
            return jsonSummary({
              action: "cancelled",
              automation: summarizeAutomation(data.automation),
            });
          });
        },
      }),
    },
  };
};
`;
}

const DEFAULT_SOUL_COMPANY = `# Company Instructions

<!-- Edit this file to set company-wide tone, guardrails, and context. -->
<!-- This file is loaded into every workspace conversation. -->

## Tone & Style
- Professional and clear.
- Respond in the user's language.

## Guardrails
- Never share credentials, tokens, or API keys.
- Explain consequences before destructive actions.
- Respect workspace boundaries.
`;

const DEFAULT_SOUL_USER = `# User Memory

<!-- This file stores personal notes and preferences. -->
<!-- Say "remember this" or "zapamatuj si" to add entries. -->
<!-- Veslo will append new facts below. -->
`;

const SOUL_INSTRUCTIONS = [".opencode/soul-company.md", ".opencode/soul-user.md"] as const;

async function ensureSoulFiles(workspaceRoot: string, stats: ProvisionStats) {
  const opencodePath = join(workspaceRoot, ".opencode");
  await ensureDir(opencodePath);

  const files: Array<[string, string]> = [
    ["soul-company.md", DEFAULT_SOUL_COMPANY],
    ["soul-user.md", DEFAULT_SOUL_USER],
  ];

  for (const [filename, defaultContent] of files) {
    const dest = join(opencodePath, filename);
    if (await exists(dest)) {
      stats.unchanged += 1;
      continue;
    }
    await writeFile(dest, defaultContent, "utf8");
    stats.written += 1;
  }
}

async function ensureSoulInstructions(workspaceRoot: string, stats: ProvisionStats) {
  // Find opencode config (jsonc or json)
  const jsoncPath = join(workspaceRoot, "opencode.jsonc");
  const jsonPath = join(workspaceRoot, "opencode.json");
  const configPath = (await exists(jsoncPath)) ? jsoncPath : (await exists(jsonPath)) ? jsonPath : null;
  if (!configPath) return; // Config is created by Rust side; if it doesn't exist, skip

  const raw = await readFile(configPath, "utf8");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw);
  } catch {
    return; // Can't parse JSONC with JSON.parse — Rust side handles this
  }

  const existing: string[] = Array.isArray(config.instructions)
    ? (config.instructions as string[])
    : typeof config.instructions === "string"
      ? [config.instructions]
      : [];

  const merged = [...existing];
  let changed = false;
  for (const instruction of SOUL_INSTRUCTIONS) {
    if (!merged.includes(instruction)) {
      merged.push(instruction);
      changed = true;
    }
  }

  if (changed) {
    config.instructions = merged;
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    stats.written += 1;
  } else {
    stats.unchanged += 1;
  }
}

async function writeInternalPlugins(workspaceRoot: string, stats: ProvisionStats) {
  const pluginsDir = join(workspaceRoot, ".opencode", "plugins");
  await ensureDir(pluginsDir);
  await writeIfChanged(join(pluginsDir, DELEGATE_PLUGIN_FILE), delegatePluginSource(), stats);
  await writeIfChanged(join(pluginsDir, AUTOMATIONS_PLUGIN_FILE), automationsPluginSource(), stats);
}

/**
 * Write internal packs once to a central versioned directory under `appDataDir`.
 * Returns the path to the versioned central directory.
 */
export async function provisionCentralPacks(appDataDir: string): Promise<string> {
  const centralRoot = join(appDataDir, "internal-packs", INTERNAL_SYSTEM_VERSION);
  const marker = join(centralRoot, ".provisioned");

  if (await exists(marker)) {
    return centralRoot;
  }

  await ensureDir(centralRoot);

  const sourceRoot = await resolveInternalPackSourceRoot();
  for (const pack of INTERNAL_PACKS) {
    const sourcePack = join(sourceRoot, pack);
    const destinationPack = join(centralRoot, pack);
    if (!(await exists(sourcePack))) {
      throw new Error(`Missing internal pack source: ${pack}`);
    }
    await ensureDir(destinationPack);

    const files = await collectFiles(sourcePack);
    const stats: ProvisionStats = { written: 0, unchanged: 0 };
    for (const relativePath of files) {
      const sourcePath = join(sourcePack, relativePath);
      const destinationPath = join(destinationPack, relativePath);
      const content = await readFile(sourcePath);
      await writeIfChanged(destinationPath, content, stats);
    }
  }

  await writeFile(marker, INTERNAL_SYSTEM_VERSION, "utf8");

  // Cleanup stale versions
  const packsParent = join(appDataDir, "internal-packs");
  try {
    const entries = await readdir(packsParent, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== INTERNAL_SYSTEM_VERSION) {
        await rm(join(packsParent, entry.name), { recursive: true, force: true });
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  return centralRoot;
}

/**
 * Create a directory symlink from `linkPath` to `targetPath`.
 * Handles migration from real directories and stale symlinks.
 */
async function ensureSymlink(targetPath: string, linkPath: string): Promise<boolean> {
  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink()) {
      const currentTarget = await readlink(linkPath);
      if (currentTarget === targetPath) return false;
      await rm(linkPath);
    } else {
      await rm(linkPath, { recursive: stat.isDirectory(), force: true });
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  await symlink(targetPath, linkPath, "dir");
  return true;
}

async function copyInternalPacks(workspaceRoot: string, stats: ProvisionStats, centralPacksDir?: string) {
  const destinationRoot = join(workspaceRoot, ".opencode", "veslo", "internal");
  await ensureDir(destinationRoot);

  if (centralPacksDir) {
    // Symlink mode: point each pack to the central store
    let anyPackUpdated = false;
    for (const pack of INTERNAL_PACKS) {
      const linkPath = join(destinationRoot, pack);
      const targetPath = join(centralPacksDir, pack);
      if (await ensureSymlink(targetPath, linkPath)) {
        anyPackUpdated = true;
      }
    }
    if (anyPackUpdated) {
      stats.written += 1;
    }
  } else {
    // Copy mode: write packs directly (fallback when no central store)
    const sourceRoot = await resolveInternalPackSourceRoot();
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
}

async function writeInternalManifest(workspaceRoot: string, stats: ProvisionStats, centralPacksDir?: string) {
  const manifest: InternalManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version: INTERNAL_SYSTEM_VERSION,
    source: INTERNAL_SYSTEM_SOURCE,
    packs: [...INTERNAL_PACKS],
    agents: INTERNAL_AGENT_FILES.map((name) => name.replace(/\.md$/i, "")),
    plugins: [...INTERNAL_PLUGIN_FILES],
    routingBlockVersion: ROUTING_BLOCK_VERSION,
    packsMode: centralPacksDir ? "symlink" : "copy",
    centralPacksDir: centralPacksDir ?? undefined,
  };
  const path = join(workspaceRoot, ".opencode", "veslo", "internal", "manifest.json");
  await writeIfChanged(path, `${JSON.stringify(manifest, null, 2)}\n`, stats);
}

export async function provisionWorkspaceInternalSystem(
  workspaceRoot: string,
  appDataDir?: string,
): Promise<WorkspaceProvisionResult> {
  const stats: ProvisionStats = { written: 0, unchanged: 0 };

  let centralPacksDir: string | undefined;
  if (appDataDir) {
    centralPacksDir = await provisionCentralPacks(appDataDir);
  }

  await removeLegacyOnboardingSkills(workspaceRoot, stats);
  await ensureSoulFiles(workspaceRoot, stats);
  await copyInternalPacks(workspaceRoot, stats, centralPacksDir);
  await writeInternalAgents(workspaceRoot, stats);
  await writeInternalPlugins(workspaceRoot, stats);
  await ensureVesloAgentRouting(workspaceRoot, stats);
  await ensureWorkspaceInstructions(workspaceRoot, stats);
  await ensureSoulInstructions(workspaceRoot, stats);
  await writeInternalManifest(workspaceRoot, stats, centralPacksDir);

  return {
    version: INTERNAL_SYSTEM_VERSION,
    status: stats.written > 0 ? "updated" : "unchanged",
    written: stats.written,
    unchanged: stats.unchanged,
  };
}

/**
 * Resolve the Veslo app data directory (mirrors Tauri's `app_data_dir()`).
 * Returns `~/Library/Application Support/com.neatech.veslo` on macOS,
 * appropriate paths on Linux/Windows, or undefined if unsupported.
 */
export function resolveVesloAppDataDir(): string | undefined {
  const home = homedir();
  const os = platform();
  if (os === "darwin") {
    return join(home, "Library", "Application Support", "com.neatech.veslo");
  }
  if (os === "linux") {
    const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share");
    return join(xdgData, "com.neatech.veslo");
  }
  if (os === "win32") {
    const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
    return join(appData, "com.neatech.veslo");
  }
  return undefined;
}
