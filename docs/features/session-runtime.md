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

## Menu Return Behavior

Dashboard and menu-style surfaces preserve a return path to session work. When the user opens a dashboard/menu tab from a session and clicks the left menu button again, Veslo returns to the active session. If the live selection is currently empty, the app falls back to the active workspace's persisted last selected session. When neither id is available, Veslo closes the dashboard/menu surface to bare `/session`, which is the draft-ready new-session screen without a directory. Re-selecting the active dashboard destination, including Settings from the header or left sidebar status controls, follows the same close-to-session behavior.

## Unread Session Indication

The left session menu marks a session title in bold when an assistant response arrives while the user is not actively reading that session. Active reading means the session is selected and the app window has focus.

Opening the session clears its unread indication. If the app regains focus while that session is already selected, the unread indication is also cleared. The indicator is local UI state for the current app run and is not persisted or synced.

## Composer

The composer supports:

- prompt mode
- shell mode
- slash commands
- mentions
- file references
- pasted content placeholders
- attachments

Files pasted, dropped, or selected into the composer are inlined as attachment data only while they fit the 8 MB inline limit. When an oversized pasted or dropped file exposes a local path, the composer inserts a file reference instead and shows a toast with the file size and inline limit. On desktop macOS, pasted Finder files also consult the native pasteboard for file paths because WebKit can expose the file blob without the local path.

Current keyboard behavior:

- unmodified arrow keys can navigate composer history only from an empty live draft or after history navigation is already active
- typed text or attachments in the live draft keep native cursor movement and must not be replaced by history entries

Submit behavior:

- a submitted draft is rendered immediately as a temporary user message while workspace/session/message handoff is pending
- the Composer visually clears and locks that submitted draft until the handoff settles
- if handoff fails before a real message exists, the temporary message is removed and the original draft is restored for correction
- once a real message exists, later model or run failures stay in the transcript and use the normal message editing, retry, and resend flows

Main source of truth:

- `packages/app/src/app/components/session/composer.tsx`

## Session Message Queue

When a session is running or streaming, plain Enter and the queue send button add the draft to a session-local queue instead of interrupting the active run. Ctrl/Meta+Enter and send-now bypass the queue and submit immediately.

Stopping a run pauses the current session queue before the abort can make the session idle. The queue resumes when the user sends a queued Enter draft or after an accepted send-now draft finishes. When a non-idle session returns to idle and the queue is not paused, Veslo drains the first queued or retryable queued draft.

Queued drafts can be edited, canceled, and reordered before they are sent. Saving an edited queued draft with Enter updates the queued item; saving with send-now submits it immediately.

Queued drafts are app/session UI state, not a durable server queue contract. They are keyed by session id, or by the pending draft key before a real session exists. Queue sends capture their source session before awaiting asynchronous send setup so a draft queued in one session is not accidentally submitted to a different session after navigation. If a queued item is draining in a background session, Veslo avoids starting run UI for the newly selected session while still letting the original session queue continue after that session becomes idle.

## Latest Message Editing

Veslo can show an edit pencil beside the latest user message only when the action is safe at render time. The pencil is hidden while the session is running, while the composer has content, while the selected session queue is non-empty, or when the message is not the latest visible user message.

After the candidate user message, only read-only assistant activity may exist. Reasoning, step markers, blank assistant text, and known read/list/search-style tools are allowed. Visible assistant text, mutating tools, unknown tools, shell or terminal activity, and unreconstructable attachments hide the pencil.

Clicking the pencil loads the reconstructed user draft into the composer and arms a replacement send. Submitting the edited draft uses OpenCode revert semantics: Veslo reverts to the original user message boundary and then sends the revised draft to the same session. If the revised send is rejected, Veslo attempts to restore the prior revert boundary.

## Message Scroll Anchoring

When the user is already at the latest message, new user posts and streamed assistant output keep the message list pinned to the bottom. Auto-scroll may be throttled for render performance, but the final pending scroll must still run while the bottom pin intent remains active. If the user scrolls away from the latest message, Veslo stops auto-pinning and shows the jump-to-latest control instead of forcing the viewport downward.

## Pending Drafts

Unstarted sessions are modeled as pending drafts.

Current behavior:

- pending drafts are durable local state
- pending drafts do not appear in the sidebar until the user presses `Run`
- `Chat` reopens the one existing unpublished private draft instead of creating another unpublished private workspace
- project `+` actions reopen the pending draft for that project directory when one already exists
- a real OpenCode session is materialized only when the pending draft is sent successfully

## Titlebar Context

The centered chat titlebar shows session context before and after a run starts.

Current behavior:

- unsent private chats show a distinct `Chat` state label
- unsent new chats for a concrete directory show `Chat` plus the directory label
- unsent private drafts hide generated private workspace paths so the state label is not mistaken for a directory
- existing chats with messages show the directory or remote workspace context without the `Chat` prefix, except private chat sessions use the chat title instead of the generated private workspace path
- in by-project sidebar mode, private workspace sessions are grouped into a bottom `Chats` section; recent mode keeps them mixed with all other conversations by activity
- long local paths can be abbreviated in the titlebar, but the full path remains available as the location tooltip
- titlebar labels are non-selectable and participate in the Tauri drag region so the window can be moved from the text itself
- desktop titlebar chrome is platform-aware: macOS keeps the native overlay behavior, while Windows uses the app-owned titlebar rail so shared navigation, context, feedback, and window controls occupy the top caption area

## Global Model and Thinking Behavior

Session UI can expose model-related controls, but future runs still follow the product's global model policy.

Important behaviors:

- model changes act on the global runtime model contract
- thinking visibility is controlled by `showThinking`
- model variant controls reasoning effort or variant selection
- auto-compaction is a separate preference

## Managed AI Runtime

When managed AI is enabled, signed-in app identity and desktop handoff can come from DEN. Provider/model/Codex assignment is resolved by the service that receives the routed managed-AI request. New desktop and orchestrator builds default to the owned standalone AI Gateway at `https://ai.veslo.work`; if the configured managed-AI base URL points at any standalone AI Gateway, that gateway's AI-access repository and admin UI are the runtime authority. DEN and standalone AI Gateway show the same assignment and credential state only when they share the same managed-AI backing database and config.

New DEN sign-ups automatically receive a healthy eligible Codex credential with default model `gpt-5.5` when one is available. The assignment is applied during the auth sign-up hook, marked `auto_assigned`, and skipped without blocking account creation when no eligible credential exists.

Standalone AI Gateway admin exposes model choices for assignments through the credential model-list endpoint. OpenAI-compatible credentials use live upstream `/models` discovery. Codex OAuth credentials use the gateway-owned Codex model catalog, with `gpt-5.5` as the default, so admins can select from known Codex model ids without relying on experimental Codex model-discovery internals.

Standalone AI Gateway admin can soft-delete unusable credentials from the credential detail view. Deleted credentials are hidden from the default credential inventory, exposed only by the Show Deleted toggle, tombstone their stored secret material, and are excluded from assignment, automatic rotation, lease selection, and user AI-access options while their historical usage, alert, and audit records remain inspectable.

In desktop local workspaces, the app can read managed-AI access policy from DEN or standalone AI Gateway, but generated OpenCode provider config must still route through the active local Veslo server. Remote DEN/Veslo URLs are not valid provider `baseURL` targets for local-first desktop execution.

For `codex_oauth`, local OpenCode remains the agent runtime. OpenCode sends tool-capable OpenAI-compatible chat-completions requests through the local Veslo server to the managed gateway; the gateway resolves the server-side Codex OAuth credential, calls the ChatGPT Codex Responses endpoint, translates the Responses stream back to OpenAI-compatible JSON/SSE, and returns it without running `codex exec` for local desktop sessions. Codex OAuth secrets stay server-side, while local config contains only Veslo-scoped proxy tokens.

If the managed gateway reports that no eligible Codex credential is available, the desktop session must stop the active run and surface an explicit AI access error in the session UI. This is a terminal send failure until an admin refreshes or reassigns Codex access; it must not leave the session in an indefinite thinking/responding state.

The local Veslo server normalizes managed-AI proxy compression at the gateway boundary. It requests identity encoding from the managed service and does not forward stale `Content-Encoding` headers on streamed responses, because the local fetch runtime may already have decoded the upstream body before the response reaches OpenCode.

Managed-AI proxy endpoints accept larger JSON request bodies than the default Express parser limit so OpenCode can send realistic accumulated session context. This larger parser is scoped to provider proxy routes; unrelated API surfaces keep their narrower defaults or route-specific limits.

Managed-AI usage is attributed by request, user, org, session, and credential. Accounting stores input tokens, output tokens, cached tokens, and total tokens from the routed provider response.

OpenAI-compatible custom providers are admin-managed. The desktop app receives provider `openai_compatible` and a model id in the read-only AI access policy, writes local OpenCode routing for `@ai-sdk/openai-compatible`, and sends prompts through the local Veslo server route `/ai-gateway/providers/openai_compatible/v1/chat/completions`. The managed-AI service that receives the request, DEN or standalone AI Gateway, resolves the assigned platform credential, reads the encrypted base URL and API key, forwards to `${baseUrl}/chat/completions`, and records usage against provider `openai_compatible`.

Codex limit exhaustion is temporary ineligibility, not a credential health failure. When every automatically selectable Codex credential is exhausted, the request fails explicitly with `all_codex_credentials_exhausted`. Permanent OAuth, token refresh, or auth-material failures are credential health failures when the credential lifecycle marks them that way; provider/runtime auth failures during selection or routing can also make a credential ineligible or rebindable without implying that every upstream invalid-auth response changes credential health.

When the gateway runs a Codex status probe from stored OAuth auth JSON, the probe uses a temporary Codex home. If Codex refreshes `auth.json` during that probe, the gateway persists the refreshed auth JSON back into the encrypted credential secret before deleting the temporary home. This keeps future probes from reusing a refresh token that Codex has already rotated.

An assigned Codex credential is repaired on the next Codex request when it is exhausted, unavailable, missing, or invalid for the assigned provider. The managed-AI service can update either an `auto_assigned` or `admin_assigned` Codex policy to another healthy eligible Codex credential before routing, preserving the original assignment origin and model policy. If a legacy Codex policy has no model during repair, the gateway fills the Codex catalog default. If no replacement exists, the request fails explicitly and the stored assignment is kept. OpenAI-compatible credentials remain hard constraints because the assigned credential determines the upstream base URL and API key.

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

Archiving the last visible session must not hide a local non-private workspace. The sidebar keeps the empty workspace visible as a workspace-only project so the user can create a new session, open workspace actions, or re-add the same directory without the app appearing to do nothing. This applies in by-project mode and as a Recent-mode fallback when no recent rows remain visible.

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
- keeps failed YouTrack projections in Den storage for retry; Den retries pending due rows after process restarts

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
