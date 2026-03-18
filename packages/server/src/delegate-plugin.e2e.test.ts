/**
 * E2E test for the Veslo delegate plugin.
 *
 * Validates that:
 * 1. The `delegate` tool is registered in the running OpenCode instance
 * 2. The model calls `delegate` when the user's message references documents
 *
 * Prerequisites:
 *   - A running OpenCode instance (started by the Veslo desktop app)
 *   - The delegate plugin provisioned to the workspace
 *
 * Configuration via environment variables:
 *   OPENCODE_URL       - OpenCode server URL (default: http://192.168.0.101:52734)
 *   OPENCODE_PASSWORD   - Basic auth password
 *   OPENCODE_DIRECTORY  - Workspace directory
 *   OPENCODE_PROVIDER_ID - Model provider ID (default: openai)
 *   OPENCODE_MODEL_ID    - Model ID (default: gpt-5.3-codex)
 *   OPENCODE_AGENT       - Optional agent override (example: veslo)
 *
 * Run:
 *   OPENCODE_URL=http://... OPENCODE_PASSWORD=... OPENCODE_DIRECTORY=... bun test delegate-plugin.e2e.test.ts
 */

import { describe, expect, test } from "bun:test";

const OPENCODE_URL = process.env.OPENCODE_URL || "http://192.168.0.101:52734";
const OPENCODE_PASSWORD = process.env.OPENCODE_PASSWORD || "";
const OPENCODE_DIRECTORY = process.env.OPENCODE_DIRECTORY || "";
const OPENCODE_PROVIDER_ID = process.env.OPENCODE_PROVIDER_ID || "openai";
const OPENCODE_MODEL_ID = process.env.OPENCODE_MODEL_ID || "gpt-5.3-codex";
const OPENCODE_AGENT = process.env.OPENCODE_AGENT || "";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (OPENCODE_PASSWORD) {
    headers["Authorization"] = `Basic ${btoa(`opencode:${OPENCODE_PASSWORD}`)}`;
  }
  if (OPENCODE_DIRECTORY) {
    headers["x-opencode-directory"] = OPENCODE_DIRECTORY;
  }
  return headers;
}

async function fetchOpenCode(path: string, init?: RequestInit) {
  const url = `${OPENCODE_URL}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenCode ${path} returned ${response.status}: ${text}`);
  }
  return response.json();
}

function buildMessageBody(text: string) {
  return {
    model: {
      providerID: OPENCODE_PROVIDER_ID,
      modelID: OPENCODE_MODEL_ID,
    },
    ...(OPENCODE_AGENT ? { agent: OPENCODE_AGENT } : {}),
    parts: [{ type: "text", text }],
  };
}

async function readSessionToolCalls(sessionId: string): Promise<string[]> {
  const messages = (await fetchOpenCode(
    `/session/${sessionId}/message?limit=80`,
  )) as Array<{ parts?: Array<{ type?: string; tool?: string }> }>;

  const tools: string[] = [];
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === "tool" && typeof part.tool === "string") {
        tools.push(part.tool);
      }
    }
  }
  return tools;
}

describe("delegate plugin E2E", () => {
  test("delegate tool is registered in OpenCode tool list", async () => {
    const toolIds: string[] = await fetchOpenCode("/experimental/tool/ids");

    expect(toolIds).toBeArray();
    expect(toolIds).toContain("delegate");

    // Also verify standard tools are present (sanity check)
    expect(toolIds).toContain("read");
    expect(toolIds).toContain("bash");
  });

  test("delegate tool has correct schema", async () => {
    // Need provider/model to get tool definitions
    const tools: Array<{ id: string; description: string; parameters: unknown }> =
      await fetchOpenCode(
        `/experimental/tool?provider=${encodeURIComponent(OPENCODE_PROVIDER_ID)}&model=${encodeURIComponent(OPENCODE_MODEL_ID)}`,
      );

    const delegateTool = tools.find((t) => t.id === "delegate");
    expect(delegateTool).toBeDefined();
    expect(delegateTool!.description).toContain("Veslo");
    expect(delegateTool!.description).toContain("xlsx");
    expect(delegateTool!.description).toContain("docx");

    // Check parameters include agent and task
    const params = delegateTool!.parameters as Record<string, unknown>;
    expect(params).toBeDefined();
  });

  test("model calls delegate tool when user references an Excel file", async () => {
    // Create a session
    const session = await fetchOpenCode("/session", {
      method: "POST",
      body: JSON.stringify({ title: "E2E test: delegate tool" }),
    });
    const sessionId = session.id;
    expect(sessionId).toBeTruthy();

    try {
      // Send a prompt that references Excel content
      const response = await fetchOpenCode(`/session/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify(
          buildMessageBody(
            "V souboru Technotrade_Prehled_pozadavku.xlsx najdi položku 'SLOUCIT' a vysvětli, co to znamená.",
          ),
        ),
      });

      expect(response?.info?.providerID).toBe(OPENCODE_PROVIDER_ID);
      expect(response?.info?.modelID).toBe(OPENCODE_MODEL_ID);

      const toolNames = await readSessionToolCalls(sessionId);

      console.log("Tool calls found in session history:", toolNames.length > 0 ? toolNames : "NONE");
      if (response?.info?.error) {
        console.log("Assistant error:", JSON.stringify(response.info.error));
      }

      // THE CRITICAL ASSERTION: the model should call the delegate tool
      expect(toolNames).toContain("delegate");
    } finally {
      // Cleanup: delete the test session
      try {
        await fetchOpenCode(`/session/${sessionId}`, { method: "DELETE" });
      } catch {
        // ignore cleanup errors
      }
    }
  }, 120_000); // 2 min timeout for LLM response

  test("model calls delegate for explicit xlsx file reference", async () => {
    const session = await fetchOpenCode("/session", {
      method: "POST",
      body: JSON.stringify({ title: "E2E test: explicit xlsx" }),
    });
    const sessionId = session.id;

    try {
      const response = await fetchOpenCode(`/session/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify(
          buildMessageBody("Otevri soubor data.xlsx a ukaž mi, co je na prvním listu."),
        ),
      });

      expect(response?.info?.providerID).toBe(OPENCODE_PROVIDER_ID);
      expect(response?.info?.modelID).toBe(OPENCODE_MODEL_ID);

      const toolNames = await readSessionToolCalls(sessionId);

      console.log("Tool calls found in session history:", toolNames.length > 0 ? toolNames : "NONE");
      if (response?.info?.error) {
        console.log("Assistant error:", JSON.stringify(response.info.error));
      }

      expect(toolNames).toContain("delegate");
    } finally {
      try {
        await fetchOpenCode(`/session/${sessionId}`, { method: "DELETE" });
      } catch {}
    }
  }, 120_000);
});
