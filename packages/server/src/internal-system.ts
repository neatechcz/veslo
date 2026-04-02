import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exists, ensureDir } from "./utils.js";

export const INTERNAL_SYSTEM_VERSION = "2026-03-31.1";
const INTERNAL_SYSTEM_SOURCE = "openwork-snapshot";
const MANIFEST_SCHEMA_VERSION = 1;
const ROUTING_BLOCK_VERSION = 3;

const DELEGATE_PLUGIN_FILE = "veslo-delegate.js";

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

async function writeDelegatePlugin(workspaceRoot: string, stats: ProvisionStats) {
  const pluginsDir = join(workspaceRoot, ".opencode", "plugins");
  await ensureDir(pluginsDir);
  await writeIfChanged(join(pluginsDir, DELEGATE_PLUGIN_FILE), delegatePluginSource(), stats);
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
    plugins: [DELEGATE_PLUGIN_FILE],
    routingBlockVersion: ROUTING_BLOCK_VERSION,
  };
  const path = join(workspaceRoot, ".opencode", "veslo", "internal", "manifest.json");
  await writeIfChanged(path, `${JSON.stringify(manifest, null, 2)}\n`, stats);
}

export async function provisionWorkspaceInternalSystem(workspaceRoot: string): Promise<WorkspaceProvisionResult> {
  const stats: ProvisionStats = { written: 0, unchanged: 0 };

  await copyInternalPacks(workspaceRoot, stats);
  await writeInternalAgents(workspaceRoot, stats);
  await writeDelegatePlugin(workspaceRoot, stats);
  await ensureVesloAgentRouting(workspaceRoot, stats);
  await ensureWorkspaceInstructions(workspaceRoot, stats);
  await writeInternalManifest(workspaceRoot, stats);

  return {
    version: INTERNAL_SYSTEM_VERSION,
    status: stats.written > 0 ? "updated" : "unchanged",
    written: stats.written,
    unchanged: stats.unchanged,
  };
}
