# Codex OAuth Local Inference Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep Codex OAuth credentials server-side while making local Veslo/OpenCode the only agent runtime for desktop local workspaces.

**Architecture:** `codex_oauth` becomes a tool-preserving inference proxy instead of a server-side `codex exec` worker for normal desktop sessions. Local OpenCode owns tool execution and calls the local Veslo server; the local server forwards model requests to the managed gateway, which selects the Codex OAuth credential, translates OpenAI-compatible chat-completions requests to the ChatGPT Codex Responses endpoint, translates the Responses stream back to OpenAI-compatible JSON/SSE, and records usage.

**Tech Stack:** TypeScript, Express, Node test runner, Solid app config helpers, Veslo server gateway proxy, managed AI gateway and DEN managed-AI runtime.

---

## Scope

- Preserve local agent execution in Veslo/OpenCode.
- Keep Codex OAuth `auth.json`, refresh token, access token, and account id server-side.
- Keep the local OpenCode config using only Veslo-scoped proxy tokens.
- Remove server-side Codex CLI worker from the default local desktop `codex_oauth` path.
- Retain the existing Codex CLI worker only for explicit remote/sandbox diagnostics or future remote-worker flows.

## Task 1: Gateway inference proxy transport

**Files:**
- Create: `services/ai-gateway/src/providers/codex-oauth-inference-proxy-transport.ts`
- Test: `services/ai-gateway/test/codex-oauth-inference-proxy-transport.test.ts`
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`

**Steps:**
1. Write a failing transport test proving `tools` and other OpenAI-compatible request fields are translated into Codex Responses requests and converted back to OpenAI-compatible responses.
2. Verify the test fails because the transport does not exist.
3. Implement a transport that extracts the Codex OAuth access token from server-side `auth.json`, calls the configured Codex Responses endpoint, and returns OpenAI-compatible JSON/SSE to OpenCode.
4. Switch the default `codex_oauth` transport from the CLI worker to the inference proxy.
5. Run the focused transport and proxy tests.

## Task 2: DEN managed-AI parity

**Files:**
- Create: `services/den/src/managed-ai/providers/codex-oauth-inference-proxy-transport.ts`
- Test: `services/den/test/managed-ai-codex-oauth-inference-proxy-transport.test.ts`
- Modify: `services/den/src/managed-ai/runtime/default-runtime.ts`

**Steps:**
1. Add the same failing test under DEN managed AI.
2. Implement the same transport behavior in the DEN managed-AI tree.
3. Switch DEN default `codex_oauth` routing to the inference proxy.
4. Run focused DEN managed-AI tests.

## Task 3: Capability and docs cleanup

**Files:**
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify app/server tests only if provider capability metadata needs adjustment.

**Steps:**
1. Document that desktop local `codex_oauth` uses local OpenCode tools and server-side credential proxying.
2. Document that server-side Codex CLI is not the default local desktop runtime.
3. Run focused app config tests if app metadata changes.

## Acceptance

- Local OpenCode remains the only tool executor for desktop local workspaces.
- Gateway never returns Codex OAuth secrets to local config.
- `codex_oauth` proxy responses can include tool calls and are not collapsed into text-only worker output.
- The normal desktop `codex_oauth` path does not spawn `codex exec`.
- Existing lease, policy, and usage accounting remain in place.
