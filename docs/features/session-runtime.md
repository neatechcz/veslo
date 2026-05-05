# Session Runtime

This document describes the shipped session behavior that future coding agents should preserve.

## Main Session Surface

The session view lives in `packages/app/src/app/pages/session.tsx`.

Key sub-surfaces:

- composer
- message list
- timeline and technical details
- artifacts panel
- context and document side panels
- share modal

## Composer

The composer supports:

- prompt mode
- shell mode
- slash commands
- mentions
- file references
- pasted content placeholders
- attachments

Main source of truth:

- `packages/app/src/app/components/session/composer.tsx`

## Pending Drafts

Unstarted sessions are modeled as pending drafts.

Current behavior:

- pending drafts are durable local state
- pending drafts do not appear in the sidebar until the user presses `Run`
- `New session` reopens the one existing unpublished private draft instead of creating another unpublished private worker
- project `+` actions reopen the pending draft for that project directory when one already exists
- a real OpenCode session is materialized only when the pending draft is sent successfully

## Titlebar Context

The centered chat titlebar shows session context before and after a run starts.

Current behavior:

- unsent new chats show a distinct `New session` state label
- unsent new chats for a concrete directory show `New session` plus the directory label
- unsent private drafts hide generated private workspace paths so the state label is not mistaken for a directory
- existing chats with messages show the directory or remote workspace context without the `New session` prefix
- long local paths can be abbreviated in the titlebar, but the full path remains available as the location tooltip

## Global Model and Thinking Behavior

Session UI can expose model-related controls, but future runs still follow the product's global model policy.

Important behaviors:

- model changes act on the global runtime model contract
- thinking visibility is controlled by `showThinking`
- model variant controls reasoning effort or variant selection
- auto-compaction is a separate preference

## Managed AI Runtime

When managed AI is enabled, signed-in app identity and desktop handoff can come from DEN. Provider/model/Codex assignment is resolved by the service that receives the routed managed-AI request. If the configured managed-AI base URL points at standalone AI Gateway, including the development gateway at `https://veslo-ai-gateway-dev.onrender.com`, standalone AI Gateway's AI-access repository and admin UI are the runtime authority. DEN and standalone AI Gateway show the same assignment and credential state only when they share the same managed-AI backing database and config.

New DEN sign-ups automatically receive a healthy eligible Codex credential with default model `gpt-5.5` when one is available. The assignment is applied during the auth sign-up hook and is skipped without blocking account creation when no eligible credential exists.

In desktop local workspaces, the app can read managed-AI access policy from DEN or standalone AI Gateway, but generated OpenCode provider config must still route through the active local Veslo server. Remote DEN/Veslo URLs are not valid provider `baseURL` targets for local-first desktop execution.

For `codex_oauth`, local OpenCode remains the agent runtime. OpenCode sends tool-capable OpenAI-compatible chat-completions requests through the local Veslo server to the managed gateway; the gateway resolves the server-side Codex OAuth credential, calls the ChatGPT Codex Responses endpoint, translates the Responses stream back to OpenAI-compatible JSON/SSE, and returns it without running `codex exec` for local desktop sessions. Codex OAuth secrets stay server-side, while local config contains only Veslo-scoped proxy tokens.

The local Veslo server normalizes managed-AI proxy compression at the gateway boundary. It requests identity encoding from the managed service and does not forward stale `Content-Encoding` headers on streamed responses, because the local fetch runtime may already have decoded the upstream body before the response reaches OpenCode.

Managed-AI proxy endpoints accept larger JSON request bodies than the default Express parser limit so OpenCode can send realistic accumulated session context. This larger parser is scoped to provider proxy routes; unrelated API surfaces keep their narrower defaults or route-specific limits.

Managed-AI usage is attributed by request, user, org, session, and credential. Accounting stores input tokens, output tokens, cached tokens, and total tokens from the routed provider response.

OpenAI-compatible custom providers are admin-managed. The desktop app receives provider `openai_compatible` and a model id in the read-only AI access policy, writes local OpenCode routing for `@ai-sdk/openai-compatible`, and sends prompts through the local Veslo server route `/ai-gateway/providers/openai_compatible/v1/chat/completions`. The managed-AI service that receives the request, DEN or standalone AI Gateway, resolves the assigned platform credential, reads the encrypted base URL and API key, forwards to `${baseUrl}/chat/completions`, and records usage against provider `openai_compatible`.

Codex limit exhaustion is temporary ineligibility, not a credential health failure. When every automatically selectable Codex credential is exhausted, the request fails explicitly with `all_codex_credentials_exhausted`. Permanent OAuth, token refresh, or auth-material failures are credential health failures when the credential lifecycle marks them that way; provider/runtime auth failures during selection or routing can also make a credential ineligible or rebindable without implying that every upstream invalid-auth response changes credential health.

An assigned Codex or OpenAI-compatible credential is a hard constraint. If the assigned credential is exhausted, unavailable, missing, or invalid for the assigned provider, the request fails explicitly instead of silently rotating to another credential. Automatic credential selection can rotate to another eligible credential only for providers that support unassigned platform-pool selection.

## Permissions

Permission prompts are surfaced as first-class runtime events. The session UI is responsible for keeping approval flows visible and understandable rather than hiding them in logs.

## Artifacts

Artifacts are modeled as run-scoped families:

- Files
- Skills
- MCP
- Soul

Server-backed artifact provenance is preferred when available. Technical noise such as `AGENTS.md`, `SKILL.md`, and `.opencode/**` should not appear as generic file artifacts unless they are the actual user-facing target.

Main model source:

- `packages/app/src/app/components/session/artifact-family-model.ts`

## Archive and Restore

Session archive behavior removes sessions from the active primary list and exposes archived items through Settings.

In local desktop mode, archive state can be persisted through the local Veslo server without a cloud sign-in by using a local desktop archive owner key. Remote/cloud archive state still requires a stable signed-in account identity so records do not mix across users.

If archive semantics change, update this doc and `docs/features/settings-and-preferences.md`.

## Feedback

Session and dashboard surfaces can open the feedback modal.

Current behavior:

- captures the current visible app surface
- includes technical details
- submits to Den-backed feedback API
- waits for Den to create or reuse the YouTrack task
- shows the returned YouTrack task number, for example `VSLO-1234`, in the feedback modal after a successful submit

Main sources:

- `packages/app/src/app/components/feedback-modal.tsx`
- `packages/app/src/app/lib/feedback.ts`

## Sharing Entry Points

Session view includes live-access sharing and public-link sharing through `ShareWorkspaceModal`.

Those semantics are documented in `docs/features/workspace-config-and-sharing.md`.

## Source of Truth

- session page: `packages/app/src/app/pages/session.tsx`
- composer: `packages/app/src/app/components/session/composer.tsx`
- message rendering: `packages/app/src/app/components/session/message-list.tsx`
- artifacts: `packages/app/src/app/components/session/artifact-family-model.ts`
- feedback: `packages/app/src/app/lib/feedback.ts`
