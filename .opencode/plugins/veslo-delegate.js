import { tool } from "@opencode-ai/plugin";

/**
 * Veslo Delegate Plugin
 *
 * Registers a `delegate` tool that the model can call via native tool_use
 * to route work to specialized Veslo internal subagents (docx, pdf, pptx,
 * xlsx, skill-creator).
 *
 * This replaces the previous text-based routing block in veslo.md with a
 * hard tool-call mechanism — the same way the model invokes read, bash, etc.
 *
 * Managed by Veslo internal system. Do not edit manually.
 */

const AGENTS = [
  "veslo-internal-docx",
  "veslo-internal-pdf",
  "veslo-internal-pptx",
  "veslo-internal-xlsx",
  "veslo-internal-skill-creator",
];

export default async (ctx) => {
  const { client } = ctx;

  return {
    tool: {
      delegate: tool({
        description: [
          "Delegate a task to a specialized Veslo document subagent.",
          "Use this tool when the user's message involves working with documents:",
          "- veslo-internal-xlsx: Excel/spreadsheet files (.xlsx, .xlsm, .csv, .tsv) — reading, writing, editing, charting, formulas",
          "- veslo-internal-docx: Word documents (.docx) — authoring, editing, conversion, formatting",
          "- veslo-internal-pdf: PDF files (.pdf) — extraction, form filling, transformation, merging",
          "- veslo-internal-pptx: PowerPoint presentations (.pptx) — creating, editing slides",
          "- veslo-internal-skill-creator: Creating or updating reusable skills (only on explicit user request)",
          "",
          "Delegate on any signal that document work is needed: file extensions, attached files,",
          "file paths, references to document content, or phrasing about editing/reading/creating",
          "those formats. When unsure whether a file exists, delegate to search for it.",
          "Do not delegate general coding or plain-text tasks without document signals.",
          "",
          "Return the subagent's results directly. Do not expose internal agent names to the user.",
        ].join("\n"),
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
            const created = await client.session.create({
              body: {
                parentID: context.sessionID,
                title: `Delegate: ${args.agent}`,
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
            const result = textParts.map((p) => p.text).join("\n").trim();
            return result || "Task completed (no text output from subagent).";
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return `Error during delegation to ${args.agent}: ${message}`;
          }
        },
      }),
    },
  };
};
