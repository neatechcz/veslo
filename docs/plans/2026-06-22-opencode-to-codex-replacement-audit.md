# Deep Audit — Replacing OpenCode with OpenAI Codex

Status: analysis / feasibility (history doc, not yet a committed plan)
Date: 2026-06-22

**Decisions taken (2026-06-22):**
- **Full replace** (Option B). OpenCode is removed end-to-end; Codex (forked, open source)
  becomes the only engine.
- **Managed AI access** is a hard requirement: the Codex *harness runs on the customer's
  device*, but *all model API traffic flows through Veslo's backend gateway*. The customer
  never holds raw provider keys.
- Multi-provider is therefore **not** an engine problem: Codex talks to one Veslo gateway
  (OpenAI Responses wire format); Veslo's backend fans out to OpenAI / Anthropic / OpenRouter /
  etc. and injects real credentials. Codex being open source means anything missing can be
  forked in, but we prefer config + a local proxy over deep code forks to limit upstream drift.

This document audits what it would take to replace the **OpenCode engine** with the
**OpenAI Codex** agent runtime in Veslo. It is an engineering analysis: it maps the
current OpenCode integration surface, the Codex runtime capabilities (verified against
current Codex docs), the gap between them, and migration options with a recommendation.

No code is changed by this document.

---

## 0. The critical distinction first

"Replace OpenCode with Codex" can mean two very different things, and Veslo already
contains plumbing for the *wrong* one:

- **Runtime replacement (what this audit is about):** OpenCode is the *agentic engine* —
  a process that owns sessions, the agent loop, tool execution (shell/edit), streaming
  events, permissions, MCP, skills, plugins. Replacing it means swapping that engine for
  Codex (Codex CLI / `codex app-server` / `@openai/codex-sdk`).
- **Provider replacement (already partially present, NOT a runtime swap):** Veslo already
  has gateway provider ids `codex_oauth` and `openai_compatible` that route an *OpenAI/Codex
  model* into OpenCode via the Veslo AI-gateway. That is OpenCode-runs-a-Codex-*model*, not
  Codex-as-runtime. Do not mistake the existing `codex_oauth` plumbing for a runtime swap;
  it lives at the model-provider layer and would mostly be replaced/retired by a true
  runtime swap.

Everything below targets the runtime replacement.

---

## 1. Current OpenCode integration surface (the contract to replace)

OpenCode is wired into Veslo across six layers. Each is a part of the contract a Codex
adapter would have to satisfy.

### 1.1 Process / binary layer — `packages/orchestrator`
- Downloads a version-pinned OpenCode binary (`opencodeVersion: 1.17.4`) from the
  `anomalyco/opencode` fork; supports `bundled | downloaded | external | auto` sources.
- Spawns `opencode serve` as a **long-lived HTTP server on loopback** and manages it as a
  sidecar alongside `veslo-server` and `veslo-code-router`.
- Shared-engine pool: one OpenCode process can host **many sessions in many directories**
  concurrently (`shared-opencode-engine.ts`, `engine-pool.ts`, `engine-topology.ts`).
- Proxy/target resolution (`opencode-proxy-target.ts`, `router-proxy.ts`), version
  reconcile, managed dependencies, hot-reload via `POST /instance/dispose`.
- Wraps the engine in Veslo's **own** sandbox (`src/sandbox/`: `mac-sandbox-exec`,
  `windows-wsl2`, `@anthropic-ai/sandbox-runtime`).

### 1.2 Transport / SDK layer
- `@opencode-ai/sdk/v2` — an OpenAPI-generated **HTTP client** used in app, server,
  orchestrator and router. `createOpencodeClient({ baseUrl, directory, headers, fetch })`.
- Custom Tauri fetch wrapper, auth header injection (`basic` / `veslo` bearer), per-route
  timeouts (OAuth/MCP get longer ceilings).

### 1.3 Session / run model — `packages/server`
- The server owns the **conversation/run boundary** and binds a Veslo conversation to an
  engine session. Notably the binding store already uses a **generic `engineSessionId`**
  (with `opencodeSessionId` kept only as a compatibility alias) — a partial abstraction
  seam already exists here.
- Workspace-scoped routes: `POST/GET /workspace/:id/conversations`, `.../runs`,
  `.../abort`, `.../runs/latest`, transcript and artifact routes.
- SDK session methods used: `create`, `list`, `get`, `messages`, `prompt`, `abort`,
  `summarize`, `revert`, `unrevert`, `shell`, `command`.

### 1.4 Event model (SSE) — `packages/app/src/app/context/session.ts`
- `client.event.subscribe()` SSE stream; the app switches on **~24 event types**:
  `message.updated`, `message.part.updated`, `message.part.removed`, `message.removed`,
  `session.created/updated/deleted/status/idle/error`, `permission.asked/replied`,
  `question.asked/replied/rejected`, `todo.updated`, `command.executed`,
  `mcp.tools.changed`, `lsp.updated`, `server.connected`, `opencode.hotreload.applied`,
  `connected/degraded/cleared`.
- Reconnect/catch-up semantics depend on this stream (outage snapshots, `session.get`,
  `session.messages`, `session.todo`).

### 1.5 Data model (message parts) — render layer
- The UI renders OpenCode **part types**: `text`, `reasoning`, `tool`, `step-start`,
  `step-finish`, `file`, `patch`, `agent` (`part-view.tsx`, `utils/messages.ts`,
  `utils/tools.ts`, `progress-grouping-model`, `timeline-detail-model`,
  `artifact-family-model`, `media-evidence-model`).
- Artifact provenance is server-derived from run message history into typed families
  (`files`, `skills`, `mcp`, `soul`).

### 1.6 Filesystem + ecosystem contract — `.opencode/`
- `opencode.json(c)` workspace config (providers, plugins, MCP, gateway routing injected by
  `applyGatewayProviderRouting`).
- `skills/` via OpenPackage (`opkg`) — a large server-side pipeline: `skill-materializer`,
  `skill-resolver`, `skill-registry-client`, lockfiles, `skill-hub`, Den-seeded platform
  skills (`veslo-xlsx/docx/pdf/pptx`, `skill-creator`).
- `commands/` markdown slash commands; `agent/` subagents; `@opencode-ai/plugin` plugins;
  `AGENTS.md`; `opencode.db` SQLite session storage.
- Find/file/LSP API: `find.text/files/symbols`, `file.read/status`, `lsp.updated`.

### 1.7 Messaging — `packages/opencode-router`
- Telegram/Slack/WhatsApp bridge built on the OpenCode SDK. Currently **UI-disabled** but
  still in the runtime.

---

## 2. Codex runtime capabilities (verified against current Codex docs)

Codex exposes several embedding surfaces:

- **`codex app-server`** — JSON-RPC over **stdio**. `thread/start` (params: `model`, `cwd`,
  `approvalPolicy`, `sandbox`, `dynamicTools`, `selectedCapabilityRoots`, ...) →
  `thread/started`. Threads ≈ OpenCode sessions. Schemas generatable via
  `codex app-server generate-ts|generate-json-schema`.
- **`@openai/codex-sdk`** (TypeScript) — `new Codex()`, `startThread()`, `resumeThread(id)`,
  `thread.run(prompt)` and `thread.runStreamed(prompt)`. Stream events: `item.completed`,
  `turn.completed` (with `usage`). `turn.finalResponse` + `turn.items`. Item types include
  `mcp_tool_call` (confirmed: `server`, `tool`, `arguments`, `result`, `status`) and the
  agent/reasoning/command-execution/file-change/todo families.
- **`codex exec`** — non-interactive headless run with JSON output.
- **`codex mcp-server`** — Codex itself as an MCP server (inspectable with the MCP Inspector).
- **`~/.codex/config.toml`** — `approval_policy` (`untrusted`/`on-failure`/`on-request`/
  `never`), `sandbox_mode` (`read-only`/`workspace-write`/`danger-full-access`),
  `[sandbox_workspace_write].network_access`, `mcp_servers.*`, and `model_provider` +
  `model_providers.*`. Config is also injectable per-thread via SDK `config` or `-c` CLI
  overrides (flattened to dotted TOML).
- **`model_providers.<id>`** (`ModelProviderInfo`) — `base_url`, `wire_api`, `env_key`
  (API key from an env var), `http_headers` (static), `env_http_headers` (header value pulled
  from an env var → can rotate per process spawn), `request_max_retries`, `stream_max_retries`,
  `supports_websockets`. Selected via `model_provider = "<id>"` + `model = "<model>"`. Codex can
  run on a **single custom provider with no OpenAI key and no ChatGPT login** (confirmed by the
  bundled `responses-api-proxy` pattern: Codex points at `127.0.0.1:<port>/v1`).
- **`wire_api` only supports `responses`** in current codex-rs — the OpenAI **Responses API**.
  Chat-completions wire format is **no longer supported**. Any Veslo gateway Codex talks to
  must therefore speak the Responses API.
- **Built-in sandbox** — Seatbelt (macOS), Landlock/seccomp (Linux). Windows has **no native
  sandbox** (runs unsandboxed or via WSL).
- **Auth** — ChatGPT OAuth login *or* `OPENAI_API_KEY` *or* a custom provider with
  `env_key`/`env_http_headers`. For managed access we use the last option (a Veslo token), not
  ChatGPT login (which would bill the customer's ChatGPT plan).

---

## 3. Capability mapping matrix

| OpenCode contract | Codex equivalent | Verdict |
|---|---|---|
| `session.create` / bound to dir | `thread/start` (`cwd`) / `startThread` | Adapter |
| `session.prompt` (stream) | `thread.run` / `runStreamed` | Adapter |
| `session.messages` (transcript) | `turn.items` + thread/rollout read | Adapter (lossy) |
| `session.abort` | turn cancel / drop thread process | Adapter |
| `session.summarize` (auto-compact) | Codex `/compact` equivalent or app-side | Adapter / partial |
| `session.revert/unrevert` | no direct equivalent | **Gap** |
| `session.shell` | Codex command-execution items | Adapter |
| `command.list` (slash) | Codex prompts/custom commands (different format) | Adapter / rework |
| SSE `event.subscribe` (24 types) | per-thread stdio events (`item.*`/`turn.*`) | **Adapter (heavy)** |
| part types text/reasoning/tool/step/file/patch/agent | item types agent_message/reasoning/command_execution/file_change/mcp_tool_call/todo | Adapter (translation) |
| `permission.asked/reply` (once/always/reject) | `approval_policy` + per-exec approval | Adapter (granularity differs) |
| `question.asked/...` | no first-class equivalent | **Gap / app-side** |
| `find.text/files/symbols`, `file.read/status`, `lsp.updated` | none over a server API | **Gap** → Veslo server FS APIs |
| multi-provider (anthropic/openai/openrouter/local/...) | OpenAI-first + OpenAI-compatible only | **Gap / product decision** |
| `.opencode/skills` (OpenPackage/opkg) | Codex skills (different model) | **Gap (large)** |
| `.opencode/commands`, `agent/`, plugins | Codex prompts / AGENTS.md / config | Adapter / rework |
| MCP (`mcp.tools.changed`, MCP servers) | `config.toml mcp_servers` + Codex MCP client | Adapter |
| shared HTTP engine, many dirs/sessions | per-thread stdio process | **Architectural delta** |
| Veslo own sandbox (mac/wsl2/anthropic-runtime) | Codex built-in sandbox | Simplify / re-decide |
| `opencode-router` messaging | none | Retire / rewrite |
| hot-reload `instance/dispose` | restart thread/process | Adapter |

Legend: **Adapter** = mappable behind a translation layer; **Gap** = no equivalent, needs new
build or product decision; **Architectural delta** = changes a core assumption.

---

## 4. The four hard problems

### 4.1 Transport model mismatch (biggest delta)
OpenCode is a **single shared HTTP server** multiplexing many sessions across many
directories, with one SSE stream. Codex's embedding model is **per-thread stdio** (app-server
or SDK spawns/owns a process per thread/conversation). Veslo's orchestrator, proxy,
shared-engine pool, and the Veslo-server HTTP proxy all assume the HTTP model.
- Mitigation: the Codex adapter becomes a **process manager + event multiplexer** that fans
  many Codex threads into the one SSE shape the app already consumes. The orchestrator
  already abstracts "two execution modes behind one runtime boundary" — extend that boundary
  to "engine kind = opencode | codex".

### 4.2 Multi-provider — RESOLVED by the managed gateway (no longer a blocker)
Originally a blocker (Codex is OpenAI-first). With the managed-access decision it inverts:
Codex always talks to **one Veslo gateway** over the Responses wire format; the **Veslo backend**
owns provider fan-out (OpenAI / Anthropic / OpenRouter / local) and credential injection. So
the model picker stays multi-provider, but the abstraction lives in Veslo's cloud, not in the
engine. See §4.5. Residual engineering cost moves into the gateway's Responses-API
translation, not into Codex. ARCHITECTURE.md's "single global runtime model" rule is preserved
— the global model is just a gateway-routed model id.

### 4.3 Skills / commands / plugins ecosystem (largest surface-area cost)
Veslo's entire extensibility stack — OpenPackage/opkg skills, Den-seeded platform skills,
skill materializer/resolver/lockfiles/hub, markdown commands, `.opencode` agents, OpenCode
plugins — is built on the OpenCode model. Codex has its own (and diverging) skills/AGENTS/
prompts/config model. This is the single biggest port: either build a Codex-shaped
materialization pipeline or a compatibility shim, plus re-home the platform skills.

### 4.4 Event + data-model translation
24 SSE event types and 8 part types must be reproduced from Codex `item.*`/`turn.*` events to
keep the UI unchanged. The mapping is mostly possible but lossy both ways (e.g. OpenCode
`revert/unrevert`, `question.*`, `lsp.updated`, granular `permission` have no clean Codex
twin). The translation belongs at the **Veslo server boundary** (consistent with "app sends
intent, Veslo resolves execution").

### 4.5 Managed AI access — the central new architecture
The defining requirement: **harness at the customer, API at Veslo.** Codex runs on the
customer's device but must never egress to a model provider directly and never hold raw keys.

Data path:
```
Customer device                                   Veslo backend
┌──────────────────────────────────────┐         ┌───────────────────────────────┐
│ Veslo desktop (Tauri)                 │         │ Veslo AI gateway (Responses)  │
│  └ orchestrator                       │         │  ├ validate Veslo token       │
│     └ Codex (forked) per conversation │  HTTPS  │  ├ meter / quota / audit      │
│        model_provider = "veslo"  ─────┼────────▶│  ├ map model id → real prov.  │
│        base_url = <veslo gw>/v1       │ Responses│  ├ translate Responses ⇄ prov │
│        wire_api = "responses"         │   API   │  └ inject real provider key   │
│        env_http_headers: session/ws   │         │        ├─▶ OpenAI             │
│        + short-lived gateway token    │         │        ├─▶ Anthropic          │
└──────────────────────────────────────┘         │        └─▶ OpenRouter / local │
                                                  └───────────────────────────────┘
```

Key design points:
- **Token model:** the orchestrator spawns one Codex process per conversation and sets the
  per-spawn auth via `env_http_headers` (`x-veslo-gateway-token`, `x-veslo-session-id`,
  `x-veslo-workspace-id`). This reuses the exact header contract already implemented for the
  OpenCode gateway (`applyGatewayProviderRouting`) — moved from `opencode.jsonc` to Codex
  `config.toml`/`-c` overrides. Tokens stay short-lived; no raw provider key ever lands on the
  device.
- **Optional local Responses proxy:** mirror Codex's own `responses-api-proxy` — run a tiny
  Veslo-managed loopback proxy that Codex points at (`127.0.0.1`), which forwards to the cloud
  gateway and owns token rotation. This keeps secrets out of `config.toml` and gives one choke
  point for egress control. Recommended.
- **Gateway speaks Responses API** (because `wire_api = "responses"` is the only option) —
  and so do all chosen upstreams, so it is a **passthrough proxy, not a translator**: OpenAI
  exposes `/v1/responses` natively, and **OpenRouter exposes `/api/v1/responses`** ("drop-in
  replacement for OpenAI's Responses API", Beta) with reasoning, tool calling and the same
  items-based SSE vocabulary (`response.output_item.added`,
  `response.function_call_arguments.done`, `response.reasoning.delta`). The original
  "translate Responses ⇄ each provider" cost is therefore **eliminated** by routing the long
  tail through OpenRouter. See §9 for the recommended target architecture.
- **Fork policy:** prefer config + local proxy over forking codex-rs internals. Fork only when
  unavoidable (e.g. branding, removing ChatGPT-login affordances, custom event needs). Codex
  moves fast; minimize drift to keep upstream merges cheap.

---

## 5. Migration options

### Option A — Codex as an alternate runtime behind an engine adapter (recommended)
Introduce an explicit `engineKind` boundary (orchestrator + server) and a Codex adapter that:
1. manages `codex app-server`/SDK threads per Veslo conversation (process pool + lifecycle);
2. translates Codex `item.*`/`turn.*` → the existing OpenCode-shaped SSE events and parts;
3. maps the conversation binding to Codex thread ids (the generic `engineSessionId` seam
   already exists — extend it, do not special-case opencode);
4. maps permissions (`permission.*` ↔ `approval_policy` + exec approvals);
5. backs find/file with Veslo server filesystem APIs instead of OpenCode `find/file`;
6. routes auth/model via Codex (`OPENAI_API_KEY` / ChatGPT OAuth / `model_providers`),
   reusing the existing `codex_oauth` credential plumbing where possible.
- Pros: app/UI largely unchanged; preserves the conversation/run boundary; feature-flagged;
  can keep OpenCode for non-OpenAI models during transition.
- Cons: real engineering on the adapter + event translator + skills re-home.

### Option B — Full replace  ← **CHOSEN**
Rip OpenCode out end-to-end; Codex (forked) is the only engine. With the managed-gateway
decision, the two original objections to B largely fall away:
- *Multi-provider* is solved in the gateway (§4.5), not the engine.
- *UI rewrite* is **avoided**: even in full replace we keep the app's event/part vocabulary and
  translate Codex `item.*`/`turn.*` → the existing SSE/part shapes at the server boundary. Full
  replace is about the *engine and the access model*, not the UI.
- Remaining real costs stay: skills/commands ecosystem port (§4.3), the event translator
  (§4.4), find/file/LSP re-homing, and the Responses-API gateway with provider fan-out (§4.5).
- Pros: one engine, one access path, no dual maintenance, clean managed-access story.
- Cons: no dual-engine safety net during cutover → sequencing and E2E parity gating matter more.

### Option C — Provider-only (explicitly NOT a runtime replace)
Keep OpenCode; just route Codex *models* through it (extend existing `codex_oauth`).
- Use only if the real goal is "use Codex models", not "replace the engine". Flagged here so
  the team doesn't conflate it with a runtime swap.

**Decision: Option B (full replace)** — sequenced so the engine swap and the managed gateway
land together behind one cutover gate, with E2E parity as the gate.

---

## 6. Phased plan for the full replace

Even in a full replace, the safe sequence keeps OpenCode runnable internally until the Codex
path passes E2E parity — not as a shipped dual-engine, but as a dev-only fallback so cutover is
gated, not a leap.

1. **Spike / contract proof** — drive `codex app-server`/SDK for one workspace pointed at a stub
   Veslo Responses gateway; capture the full `item.*`/`turn.*` schema (`codex app-server
   generate-ts`); confirm the event→part mapping table; test resume + abort; verify per-spawn
   `env_http_headers` carry session/workspace + token. Validate on Windows (sandbox caveat).
2. **Managed Responses gateway (parallel track)** — build the Veslo backend Responses-API
   surface: token validation, metering/quota/audit, model-id → provider mapping, and the
   Responses ⇄ provider translators (OpenAI passthrough first, then Anthropic/OpenRouter). Add
   the optional loopback `responses-api-proxy` shim on the device.
3. **Engine abstraction** — formalize `engineKind` in orchestrator + server; route session
   create/prompt/abort/transcript through one interface. The generic `engineSessionId` binding
   becomes the Codex thread id; transcript hydration reads Codex thread items/rollout.
4. **Codex adapter (process + events)** — per-conversation process pool, SSE multiplexer,
   `item.*`/`turn.*` → OpenCode-shaped event/part translator, permission ⇄ approval mapping.
   **No UI changes.**
5. **FS/search re-home** — move file browser + "what changed" to Veslo server FS APIs; drop
   dependence on OpenCode `find/file/lsp`.
6. **Skills/commands/MCP** — Codex-shaped skills materialization (or shim); re-home platform
   skills (xlsx/docx/pdf/pptx/skill-creator); port markdown commands; map MCP to `config.toml
   mcp_servers`; decide the plugin story.
7. **Cutover + teardown** — flip default `engineKind` to Codex; remove the OpenCode binary
   download/sidecar, `@opencode-ai/sdk` runtime deps, and `opencode-router` (UI-disabled
   already). Keep an internal flag only until parity is signed off, then delete it.
8. **Validation gate** — Tauri-pilot E2E for prompt send, streaming, permissions, abort, resume,
   two concurrent workspaces, sandbox + no-sandbox; transcript hydration parity; managed-access
   proof (no provider key on device, all traffic via gateway, metering correct).

---

## 7. Open questions (need a decision)

Resolved: engine scope = **full replace**; multi-provider = solved in the gateway via
**OpenRouter-primary, OpenAI direct fast-path, Anthropic direct optional** (§9). No Responses
translators are needed because every upstream speaks Responses.

1. **OpenRouter Responses Beta fidelity** (§9.5) — the new top risk. Which Codex features must
   be proven before cutover (local tools, reasoning round-trip, parallel tool calls, streaming
   completeness)? Decide the contract-test fixture and the Beta-drift release gate.
2. **Token model:** per-conversation short-lived gateway tokens via `env_http_headers`, or the
   loopback `responses-api-proxy` shim owning rotation? (Recommend the proxy.)
3. **Fork policy:** what, if anything, must be forked into codex-rs vs solved by config + proxy?
   Define a drift budget and an upstream-merge cadence.
4. **Skills:** port the OpenPackage/opkg pipeline to a Codex-shaped model, build a shim, or
   reduce the skills surface? Still the largest engine-side cost driver.
5. **Sandbox:** delegate to Codex's built-in sandbox (simplifies the orchestrator) or keep
   Veslo's sandbox wrapping Codex? Codex has **no native Windows sandbox** — Veslo's existing
   `windows-wsl2` work is aligned and may need to remain the Windows path.
6. **Find/file/LSP UI:** confirm re-homing on Veslo server FS APIs (matches the long-term
   "Veslo server is the single FS surface" direction).
7. **Session features:** are `revert/unrevert` and `question.*` flows dropped, reimplemented, or
   moved app-side? No clean Codex twin.

---

## 8. Effort & risk summary

- **Chosen path:** Option B (full replace) + managed Responses gateway, sequenced behind an
  E2E parity cutover gate; OpenCode kept dev-only until parity, then deleted.
- **Biggest costs now:** (1) the managed Responses gateway as an **auth/metering/policy
  passthrough proxy** (§9 — conventional API-gateway work, no LLM wire translation), (2) the
  skills/commands ecosystem port (§4.3), (3) the Codex event/data-model translator (§4.4).
- **Biggest correctness risk:** OpenRouter Responses **Beta** fidelity for Codex's exact
  feature use (§9.5) — pinned by contract tests, gated at release.
- **No longer a blocker:** multi-provider — moved from engine to gateway (§4.2); UI rewrite —
  avoided by translating at the server boundary.
- **Helpful head starts already in the repo:** generic `engineSessionId` binding seam; the
  orchestrator's "two execution modes behind one runtime boundary"; the existing gateway header
  contract (`x-veslo-gateway-token` / session / workspace) from `applyGatewayProviderRouting`,
  reusable for Codex `env_http_headers`; the `/ai-gateway` proxy surface; existing Windows-WSL2
  sandbox work.
- **Codex specifics that shape the build:** `wire_api = "responses"` is the only wire format;
  Codex runs fine on a single custom provider with no OpenAI key / no ChatGPT login; per-spawn
  `env_http_headers` carry rotating auth; Codex ships a `responses-api-proxy` pattern worth
  mirroring; engine transport is per-thread stdio, not a shared HTTP server.
- **Validation bar:** real Tauri runtime (Tauri-pilot), per `docs/dev/testing-playbook.md` and
  `docs/dev/opencode-workspace-runtime-architecture.md`, plus a managed-access proof (zero
  provider keys on device, all model traffic via gateway, metering correct).

---

## 9. Recommended target architecture (OpenRouter-primary, Responses passthrough)

Design goals: **most maintainable, most scalable, true managed access.** The chosen shape
achieves all three by keeping **one wire format (OpenAI Responses API) end to end** and pushing
provider diversity into OpenRouter instead of into our code.

### 9.1 Provider strategy
- **Primary: OpenRouter** (`/api/v1/responses`). One integration → hundreds of models across all
  vendors. Adding a model/provider is **config, not code**.
- **Fast-path: OpenAI direct** (`/v1/responses`) for OpenAI models — native fidelity, no
  middleman margin, best for the highest-volume reasoning model.
- **Optional: Anthropic direct** — only if economics/fidelity ever justify bypassing OpenRouter;
  realistically unnecessary because OpenRouter already fronts Anthropic.

### 9.2 The gateway is a uniform Responses reverse-proxy (no format translation)
```
        DEVICE (customer)                              VESLO CLOUD
┌───────────────────────────────┐          ┌─────────────────────────────────────┐
│ Tauri ▸ orchestrator          │          │ Veslo AI Gateway                    │
│   ▸ Codex (forked) /thread    │          │  POST /ai-gateway/v1/responses (SSE)│
│      model_provider="veslo"   │  Responses│  1 authn: Veslo session token       │
│      base_url=127.0.0.1/v1 ───┼─►loopback─┼─►2 entitlement / quota / metering   │
│      wire_api="responses"     │  proxy   │  3 model-router (policy table)      │
│   ▸ local responses proxy ────┼──HTTPS──►│  4 upstream adapter (Responses)     │
│      (token rotation, egress) │  Responses│        ├─▶ OpenRouter /v1/responses │
└───────────────────────────────┘          │        ├─▶ OpenAI    /v1/responses  │
   no provider keys on device               │        └─▶ (Anthropic direct, opt) │
                                            │  5 inject real upstream key         │
                                            │  6 stream Responses SSE back        │
                                            └─────────────────────────────────────┘
```
- Every box on the right speaks **Responses**, so steps 3–6 are **route + auth-swap + meter +
  stream**, never reshape. The hard "N translators" problem does not exist.
- **Upstream adapter interface:** `(ResponsesRequest, AuthCtx) → ResponsesSSE`. Two impls at
  launch (`OpenRouterResponses`, `OpenAIResponses`). A new provider = a new row in the policy
  table (OpenRouter) or, rarely, one more adapter.
- **Model router policy** is data: `veslo model id → { upstream, upstream model id, provider
  prefs }`. Can be seeded from OpenRouter's model list so the picker scales automatically. The
  app keeps its "single global runtime model" rule — the id is just gateway-routed.

### 9.3 On-device managed access
- Orchestrator spawns Codex per conversation pointed at a **local loopback Responses proxy**
  (mirroring Codex's own `responses-api-proxy`). The proxy is the single egress point and owns
  short-lived token rotation; `config.toml` holds **no secrets** — only `base_url=127.0.0.1`.
- Per-spawn identity (`x-veslo-session-id`, `x-veslo-workspace-id`, gateway token) reuses the
  existing header contract from `applyGatewayProviderRouting`.
- Real OpenRouter/OpenAI keys live **only** in the cloud gateway.

### 9.4 Why this is the most maintainable & scalable
- **One wire format** (Responses) everywhere → zero per-provider translators to maintain.
- **Provider/model growth = configuration**, courtesy of OpenRouter's normalization.
- **Single choke point** for auth, quota, metering, audit, key custody → the managed-access
  requirement is satisfied structurally, not bolted on.
- **Minimal fork drift:** we ride upstream Codex; the only device-side change is config + a
  loopback proxy. Codex moves fast and we stay close to it.
- **Fast-paths are optional adapters**, added only when economics demand — never required for
  coverage.

### 9.5 Risks to pin in the spike (OpenRouter Responses is Beta)
1. **Feature fidelity** of OpenRouter Responses for Codex's exact use: local tools
   (`local_shell`/`apply_patch`/custom function tools), `tool_choice`, `parallel_tool_calls`,
   reasoning round-trip across turns, `max_output_tokens`, and full streaming event coverage.
   Lock with contract tests against a recorded fixture; treat Beta drift as a release gate.
2. **Statelessness:** run Codex without relying on `previous_response_id`/`store` server state
   so any upstream works (send full context per turn). Verify Codex's custom-provider mode is
   stateless or can be configured so.
3. **Reasoning continuity:** gpt-5-codex depends on reasoning; confirm reasoning is preserved
   (or acceptably re-derived) through OpenRouter, and that Anthropic "thinking" mapped via
   OpenRouter `reasoning` behaves.
4. **Capability/limit mapping:** Veslo model id ↔ OpenRouter id, context-window limits feeding
   auto-compaction (repo already special-cases `gpt-5.4` at 128k).
5. **Vendor SPOF:** OpenRouter as primary is a single dependency — mitigate with OpenRouter's
   own provider fallbacks plus the OpenAI-direct adapter as a router-level failover.

### 9.6 Net effect on the earlier cost list
- §4.5 gateway translation cost: **collapses** to a thin passthrough proxy + a policy table.
- §4.2 multi-provider: **fully solved** by OpenRouter, in config.
- Remaining real costs: the **Codex event/part translator** (§4.4), the **skills/commands port**
  (§4.3), **find/file/LSP re-homing**, and the gateway's **auth/metering/policy** plane (now the
  bulk of the backend work, but conventional API-gateway engineering — not LLM wire translation).

---

## 10. Implementation plan — delete / keep / replace (per package)

Verified inventory facts that shape this plan:
- `packages/server/src` **does not import `@opencode-ai/sdk`** — the server is already largely
  engine-agnostic; its only OpenCode coupling is the provider-proxy wire format and the
  `.opencode` config writers.
- A `/ai-gateway` surface **already exists**, including `/ai-gateway/me/ai-access` (managed-access
  entitlement). We extend it, we don't invent it.
- The app imports the OpenCode SDK in ~40 files, but mostly for **types** (`Part`, `Session`,
  `Event`, `Permission`); runtime call sites are few.
- The conversation/run boundary already keys on a generic **`engineSessionId`**.
- **`AGENTS.md` is read by Codex too** → the whole instruction surface is KEPT unchanged.

Guiding rule: **keep the conversation/run boundary, workspace model, server FS/skills/audit, and
the entire UI; replace only the engine transport, the binary/sidecar, the SDK type-coupling, and
the provider-proxy wire format.**

### 10.1 `packages/orchestrator`
- **DELETE:** `opencode-managed-dependencies.ts`, `opencode-project-api.ts`,
  `opencode-proxy-target.ts`, `opencode-version.ts`, `shared-opencode-engine.ts`,
  `router-proxy.ts`, and the OpenCode binary download/asset logic in `cli.ts`.
- **KEEP (engine-agnostic):** `engine-paths.ts`, `engine-pool.ts`, `engine-topology.ts`,
  `persistence.ts`, `run-registry.ts`, `run-store.ts`, `run-activity-probe.ts`, `sandbox/`,
  `sandbox-mode.ts`, `security.ts`, `version-manifest.ts`. Make `engine-pool` engine-kind aware.
- **REPLACE / NEW:** `codex-engine.ts` (drive `codex app-server`/`@openai/codex-sdk` per
  conversation), `codex-thread-pool.ts` (per-conversation process lifecycle), `codex-event-bridge.ts`
  (Codex `item.*`/`turn.*` → Veslo SSE events/parts), `responses-proxy.ts` (loopback Responses
  proxy + token rotation, mirroring Codex's `responses-api-proxy`).

### 10.2 `packages/server`
- **KEEP (most of it):** `conversation-service.ts`, `conversation-binding-store.ts`
  (`engineSessionId` becomes the Codex thread id), run-queue/transcript stores, `workspaces.ts`,
  `config.ts`, `audit.ts`, `approvals.ts`, `automations*`, `scheduler.ts`, `soul-*`, the skill
  pipeline modules, FS routes. No SDK churn (no SDK import today).
- **REPLACE:** the `/ai-gateway` proxy gains a **Responses route** (`/ai-gateway/v1/responses`)
  with the model-router policy + `OpenRouterResponses` / `OpenAIResponses` upstream adapters; the
  existing chat-completions provider-proxy retires with OpenCode. `commands.ts`, `plugins.ts`,
  `mcp.ts` (opencode.json-shaped) → Codex `config.toml`-shaped writers. The skill materializer's
  **output target** changes from `.opencode/skills` to the Codex skills layout.
- **KEEP & EXTEND:** `/ai-gateway/me/ai-access` entitlement, metering, audit.

### 10.3 `packages/app`
- **KEEP:** all UI — `message-list`, `part-view`, `composer`, `session.tsx`, dashboards, stores.
  The event/part **vocabulary** stays.
- **REPLACE:** introduce **Veslo-owned** `EngineEvent` / `MessagePart` / `Session` types (today
  re-exported from `@opencode-ai/sdk`) so the UI no longer imports the OpenCode SDK; the Codex
  bridge emits these. `lib/opencode.ts` (gateway routing into `opencode.jsonc`) → `lib/codex-config.ts`
  (`config.toml` / `-c` overrides). `lib/opencode-session.ts` → engine-agnostic session ops.
  `utils/providers.ts` model mapping → gateway/OpenRouter model list. `context/session.ts` keeps
  its event switch unchanged **iff** the bridge preserves event names.
- **DELETE:** `pages/plugins.tsx` (OpenCode plugins) → folded into MCP/skills UI; `pages/identities.tsx`
  (OpenCode Router, already UI-disabled).

### 10.4 `packages/desktop` (Tauri / Rust)
- **DELETE:** `commands/opencode_router.rs`, `commands/opkg.rs`; the `sidecars/opencode` +
  `sidecars/opencode-managed-deps.json` entries in `tauri.conf.json`; the OpenCode download in
  `scripts/prepare-sidecar.mjs`.
- **KEEP (generic lifecycle, retarget binary):** `engine/manager.rs`, `engine/spawn.rs`,
  `engine/paths.rs`, `engine/doctor.rs`, `commands/engine.rs`, `commands/engine_sse.rs`,
  `commands/workspace.rs`, `commands/wsl_sandbox.rs` (Windows sandbox — aligned with Codex's
  Windows gap), `commands/veslo_server.rs`, `commands/orchestrator.rs`.
- **REPLACE:** sidecar becomes the **forked Codex binary + local Responses proxy**;
  `prepare-sidecar.mjs` fetches the Codex release instead of `anomalyco/opencode`.

### 10.5 `packages/opencode-router`
- **DELETE** the entire package (UI-disabled Telegram/Slack/WhatsApp bridge built on the OpenCode
  SDK). Re-implement on Codex later only if messaging returns to the roadmap.

### 10.6 `.opencode/` workspace contract
- **REPLACE:** `opencode.json(c)` → Codex `config.toml` (`model`, `model_provider`,
  `model_providers.veslo`, `mcp_servers`, `approval_policy`, `sandbox_mode`); `agent/` subagents →
  Codex agents/prompts; `commands/` markdown → Codex prompts/custom commands; `opencode.db` → Codex
  thread/rollout storage; `@opencode-ai/plugin` plugins → MCP servers.
- **KEEP:** `skills/` as a concept (materializer re-homes to the Codex skills layout); **`AGENTS.md`
  unchanged** (Codex reads it natively — a free win).

### 10.7 Dependencies
- **REMOVE:** `@opencode-ai/sdk`, `@opencode-ai/plugin` (all packages).
- **ADD:** `@openai/codex-sdk` (or an app-server JSON-RPC client), a forked-Codex build pipeline,
  and OpenRouter Responses integration in the gateway.

### 10.8 Net-new components (the actual build)
1. **Veslo AI Gateway / Responses** — route, model-router policy table, `OpenRouterResponses` +
   `OpenAIResponses` upstream adapters, metering/quota/audit (server).
2. **Local Responses proxy** — loopback egress + token rotation (orchestrator/desktop).
3. **Codex engine adapter** — thread pool + lifecycle + `item.*`/`turn.*` → Veslo event bridge
   (orchestrator).
4. **Veslo engine types + translator** — own `EngineEvent`/`MessagePart`, Codex→Veslo mapping
   (server/app boundary).
5. **Codex config materializer** — `config.toml` writer replacing the `opencode.json` writer
   (server).
6. **Codex skills materialization target** — server skill pipeline output in Codex layout.

### 10.9 PR-sized workstream sequence
1. **Veslo engine types** — fork `Part`/`Event`/`Session`/`Permission` into Veslo-owned types; app
   imports those, not the SDK. (No behavior change; pure decoupling. Unblocks everything.)
2. **`engineKind` boundary** — orchestrator + server interface; OpenCode stays the only impl. (Green.)
3. **Responses gateway, OpenAI-direct first** — `/ai-gateway/v1/responses` + `OpenAIResponses`
   adapter + metering; contract tests.
4. **OpenRouter adapter** — add `OpenRouterResponses`; policy table; model-list seeding.
5. **Codex spike behind the flag** — `codex-engine` + `responses-proxy` + `codex-event-bridge`,
   one workspace, app-server schema captured via `generate-ts`. (Internal flag only.)
6. **Event/part translator to parity** — make the Codex bridge emit the exact Veslo event/part
   vocabulary; transcript hydration parity.
7. **Config + skills materializer** — `config.toml` writer; skills re-home; MCP via `mcp_servers`.
8. **FS/search re-home** — file browser + "what changed" on Veslo server FS APIs.
9. **Desktop sidecar swap** — Codex binary + local proxy in `prepare-sidecar.mjs` / `tauri.conf.json`.
10. **Cutover + teardown** — flip default `engineKind` to Codex; delete `@opencode-ai/*`,
    `opencode-router`, OpenCode sidecar + download, plugin/identities UI; remove the flag after the
    E2E parity gate (§6.8) passes.
