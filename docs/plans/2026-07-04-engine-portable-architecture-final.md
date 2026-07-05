# Final Architecture Recommendations — Engine-Portable (OpenCode → Codex-ready)

Date: 2026-07-04
Status: proposal — supersedes the "Part 2" recommendation sections of:
- `docs/plans/2026-07-04-veslo-server-access-root-causes-and-architecture.md`
- `docs/plans/2026-07-04-codebase-architecture-review.md`

The findings (Part 1) of both documents stand unchanged. This document is the
final state of the *recommendations*, revised under one added requirement:
**the coding engine must be replaceable — OpenCode today, OpenAI Codex later,
possibly both side by side during a migration.**

## 1. What an engine swap actually touches (measured)

| Layer | OpenCode coupling | Depth |
|---|---|---|
| App (SolidJS) | 57 files import `@opencode-ai/sdk` types (`Session`, `Part`, `Agent`, events); UI renders raw OpenCode parts | **Deepest** — the UI's data model is the engine's data model |
| Server | 0 SDK imports (talks raw HTTP), but 25 files read/write `.opencode/` (skills, commands, config materialization); binding store hardcodes `engine: "opencode"` (single constant, schema already has an engine column) | Medium — mostly workspace-state materialization |
| Orchestrator | Spawns/pools `opencode serve` HTTP processes, proxies them, reads `opencode.db`, reconciles OpenCode versions | Process-shaped — contained but load-bearing |
| Desktop shell | `veslo-code`, `opencode`, `veslo-code-router` sidecars; `opencode.json` handling; `--opencode-*` spawn args; basic-auth env plumbing; WSL bridge machinery for engine→gateway reachability | Mechanical |
| Contracts | Conversation API is engine-neutral by design (good); transcript payloads are opaque `unknown` keyed by ids (good); but the app-side types re-export engine shapes | Fixable at schema level |

Relevant Codex differences that drive the revisions: Codex runs as a
JSON-RPC-over-stdio app-server (or one-shot exec), not a long-lived HTTP
server; it persists rollouts as JSONL files rather than a queryable DB; it
ships its own OS-level sandbox (seatbelt/landlock); auth is ChatGPT
OAuth/API key via its own config, not per-server basic auth; custom model
providers (our managed AI gateway) are wired through its provider config,
not a base-URL override; and its multi-directory/shared-process semantics
differ from the empirically verified OpenCode 1.16.2 behavior that the
current runtime doc treats as an invariant.

## 2. The keystone change: a Veslo Engine Interface

**New recommendation, and the organizing principle for everything below.**
Define one internal engine contract, owned by the orchestrator layer:

```
EngineAdapter {
  capabilities(): {
    sharedProcessMultiDir: boolean   // OpenCode: true (verified); Codex: verify per version
    nativeSandbox: "none" | "os"     // OpenCode: none (Veslo provides); Codex: os
    resume: boolean
    authModes: [...]
  }
  createThread(workspaceDir, opts) -> engineThreadId
  submitTurn(engineThreadId, prompt, opts) -> turnHandle
  events(engineThreadId) -> stream of VesloEngineEvent   // normalized
  abort(turnHandle)
  readTranscript(engineThreadId) -> VesloTranscript      // normalized
  health() / dispose()
}
```

- The **OpenCode adapter** wraps today's behavior: HTTP `opencode serve`,
  SSE events, engine pool, `opencode.db` reads, the router, and the WSL
  bridge. All of it becomes adapter-internal, including the
  `opencode-router` package.
- The **Codex adapter** wraps `codex app-server` JSON-RPC over stdio
  (process-per-engine under the same pool), maps thread/turn/item events to
  `VesloEngineEvent`, and tails JSONL rollouts for transcript recovery.
- The conversation binding's `engine` column stops being a constant and
  becomes real data; a Veslo conversation is bound to `(engine,
  engineThreadId, directory)` for its lifetime. Engine choice is per
  workspace (or per conversation), never a global mode switch — that is what
  makes a gradual migration possible.
- Runtime-mode assumptions move from "architecture invariants" to **adapter
  capability flags**. The runtime doc's verified-OpenCode-behavior section
  becomes the OpenCode adapter's capability record; Codex gets its own
  empirical verification before its flags are trusted.

## 3. Final recommendation set

Annotated: **[unchanged]** carried over as-is, **[amended]** revised for
engine portability, **[new]** introduced by this requirement.

### 3.1 Runtime and process management

1. **[unchanged] Unified child supervisor** for all sidecars: secrets via
   env/file (never argv), READY handshake, per-boot instanceId, one state
   machine per child, event-pushed descriptors, serialized start queue.
   Engine binaries (`veslo-code` today, `codex` later) are just entries in
   the supervisor's child table — this abstraction is exactly what makes the
   swap a configuration change at the process level.
2. **[unchanged] veslo-server lifecycle decoupling**: spawn with zero
   workspaces, acknowledged workspace registration, identity-verified
   adoption, Unix stale-process termination, fixed-port strategy with
   instanceId probing.
3. **[amended] Engine wiring delivered to a running veslo-server via API,
   not argv** — previously "engine-config hot-swap avoids respawns"; now it
   is also the mechanism for switching or mixing engines at runtime. The
   `--opencode-*` flags and basic-auth env plumbing disappear into the
   OpenCode adapter.
4. **[amended] Sandbox strategy becomes capability negotiation.** Veslo's
   managed sandbox (WSL2 distro, bubblewrap, sandbox-exec) remains the
   provider for engines with `nativeSandbox: none`; for Codex the
   orchestrator configures the engine's own sandbox and Veslo's layer stands
   down. The existing configured-vs-effective sandbox reporting generalizes
   to per-adapter effective state. The Windows WSL bridge (engine→gateway
   reachability) is demoted to an OpenCode-on-Windows adapter detail.

### 3.2 Data model and contracts

5. **[new — highest priority upgrade] The app must not import engine SDKs.**
   Today's 57 SDK-importing files are the single largest migration cost and
   they grow with every feature. Define a **Veslo-owned transcript and event
   schema** (message/part union with typed common parts — text, tool-call,
   file-diff, reasoning — plus an extensible opaque payload and a renderer
   registry for engine-specific part kinds). The app consumes only Veslo
   conversation APIs and this schema. This was "delete the dual OpenCode
   data path" cleanup in the previous documents; under engine portability it
   moves from cleanup to **prerequisite**, and it is enforceable immediately
   with an import-ban lint while the migration proceeds file by file.
6. **[amended] Generated contracts** (schema-first server client,
   `tauri-specta` bindings, typed error envelope, CI drift gate) — with the
   added rule that **generated contracts may never re-export engine SDK
   types**; the normalization boundary is the adapter, and everything above
   it speaks Veslo schemas.
7. **[amended] Server-side transcript mirror becomes the canonical read
   model, not an optimization.** With OpenCode it mirrors a queryable
   sqlite; with Codex the raw material is JSONL rollout files, so UI reads
   must come from Veslo's store regardless of engine. The existing
   host-first transcript design is validated by this requirement — finish
   it: all app transcript reads go through the server store; the engine DB/
   files are adapter-internal upstream sources.
8. **[unchanged] Ownership map for state** (registry: server; runs/
   conversations: server; process descriptors: shell; preferences: scoped
   stores) with acknowledged APIs replacing reconcilers, and the state-file/
   localStorage cull.

### 3.3 Workspace state and skills

9. **[amended] Veslo owns canonical workspace capability state; engines get
   materializations.** Today 25 server files write `.opencode/` (skills,
   commands, plugins, config) as if it were the source of truth. Final
   state: the server's canonical store (already partly exists via the skill
   registry/materializer) is authoritative; **adapters materialize** it into
   engine-native form — `.opencode/skills` and `opencode.json` for OpenCode;
   prompts/AGENTS.md fragments, `config.toml` entries, and MCP registrations
   for Codex. The existing repo rule ("mutations of `.opencode/` stay
   expressible via server APIs") generalizes to: *engine workspace state is
   build output, never input.* Migration between engines then becomes a
   re-materialization, not a data migration.
10. **[amended] Managed AI gateway integration moves behind the adapter.**
    OpenCode reaches the gateway via base-URL override; Codex via a custom
    model-provider entry (base URL + env key) written into its config
    materialization. Gateway auth/proof plumbing stays engine-neutral in the
    server; only the last-mile wiring is adapter code.

### 3.4 App shell, events, and everything engine-agnostic

11. **[amended] Event spine**: one multiplexed channel from veslo-server as
    before, with the added rule that engine events are normalized to
    `VesloEngineEvent` **at the adapter** — the app-visible event schema is
    identical for OpenCode SSE and Codex JSON-RPC notifications. This also
    removes the Rust-side engine-SSE proxy special case over time.
12. **[unchanged]** App-shell layering (stores/services/workflows with
    enforced import direction, prop-bag reduction), auth/token
    consolidation, config resolvers (with the 245-env-var cull), no-silent-
    catch error policy with cross-process tracing, legacy retirement plan
    (openwork keys, `packages/web`, toy UI, WDIO specs, locale tooling),
    and the written local trust model.
13. **[amended] Testing**: the ~12 tauri-pilot scenarios remain the gate,
    but the engine-touching ones (first message, abort, crash recovery,
    concurrent workspaces, sandbox fallback) become a **capability matrix
    run per enabled adapter**. Add adapter conformance tests: a shared
    test suite any `EngineAdapter` implementation must pass (create/submit/
    stream/abort/recover), which is also the cheapest way to de-risk a Codex
    spike before committing.

### 3.5 Explicitly dropped or demoted from the previous documents

- "Verified OpenCode 1.16.2 behavior" as a load-bearing architectural
  invariant → demoted to OpenCode adapter capability record (§2).
- `opencode-router` as a standalone architectural component → folded into
  the OpenCode adapter.
- WSL bridge / engineUrl publication as core desktop-shell logic → OpenCode-
  on-Windows adapter detail.
- Any plan step that phrased app cleanup as "remove the *duplicate* OpenCode
  client" → replaced by the stronger №5 (remove *all* engine SDK usage from
  the app).

## 4. Revised phasing

**Phase 0 — guardrails (immediate, cheap):** previous Phase 0 (dependency
lints, empty-catch lint, contract drift check, pilot harness in CI) **plus**
an import-ban lint: no new `@opencode-ai/sdk` imports in `packages/app`.
Freeze the coupling before paying it down.

**Phase 1 — runtime spine (unchanged):** unified supervisor, readiness
handshake, instanceId adoption, event-pushed descriptors, token/argv fixes,
serialized starts. Engine-agnostic by construction.

**Phase 2 — Veslo-owned data plane:** define the Veslo transcript/event
schema; finish the server transcript store as the canonical read model;
generated contracts (Veslo schemas only); acknowledged workspace APIs with
server-assigned IDs. This phase buys the engine-neutral seam.

**Phase 3 — adapter extraction + app decoupling:** carve the
`EngineAdapter` interface out of the orchestrator (mostly mechanical — the
pool, proxy, and run registry modules already exist); migrate the 57 app
files onto the Veslo schema; fold in the router; move skills/config
materialization behind the adapter. At the end of this phase OpenCode is an
implementation detail.

**Phase 4 — Codex adapter (optional, when wanted):** implement the adapter
against `codex app-server`; empirically verify its capability flags
(multi-dir semantics, resume, sandbox behavior per platform) the same way
OpenCode 1.16.2 was verified; run the conformance suite and the pilot
capability matrix; enable per-workspace engine selection for a gradual
rollout, keeping existing conversations bound to the engine that created
them.

**Cost honesty:** if you are *certain* the switch will be a one-time
rip-and-replace with no overlap period, an adapter layer is still the
cheaper path here — the dominant cost is the 57-file app decoupling and the
workspace-state re-materialization, and both are required under either
strategy. The adapter adds a thin interface on top of work you must do
anyway, and Phases 0–3 are worth doing even if the Codex switch never
happens: they are the same fixes the two findings documents already justify
on reliability grounds alone.
