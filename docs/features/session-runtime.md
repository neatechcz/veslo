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

## Desktop Context Menu

The desktop app must not expose the webview's default browser context menu or web inspector entry points. Unhandled right-clicks are cancelled globally. If the user has selected text, Veslo shows a small app-owned context menu with only Copy. If a surface already handles `contextmenu` for its own menu, that surface remains authoritative and the global copy menu does not replace it. App-owned right-click menus are viewport-fixed, top-layer controls that clamp inside the visible window instead of being clipped by sidebar scroll containers.

## Unread Session Indication

The left session menu marks a session title in bold when an assistant response arrives while the user is not actively reading that session. Active reading means the session is selected and the app window has focus.

Opening the session clears its unread indication. If the app regains focus while that session is already selected, the unread indication is also cleared. The indicator is local UI state for the current app run and is not persisted or synced.

## Session Titles

When a pending draft is first sent and a real OpenCode session must be created, Veslo uses the trimmed composer text as the session's initial backend title. The title comes from the text the user entered in the composer, not from internally resolved prompt text. If the first send has no text, such as an attachment-only send, the backend default title can remain in place.

Later backend session title updates remain authoritative. The app accepts `session.updated` events into the session store and sidebar, so an explicit rename or backend title update can replace the prompt-derived initial title when the backend emits it.

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

Mentions are token-scoped composer input. A file mention opens only when `@` starts the current token, such as at the beginning of the draft or after whitespace; `@` characters embedded in URLs or email addresses remain plain text.

Current keyboard behavior:

- unmodified arrow keys can navigate composer history only from an empty live draft or after history navigation is already active
- typed text or attachments in the live draft keep native cursor movement and must not be replaced by history entries

Submit behavior:

- a submitted draft is rendered immediately as a temporary user message while workspace/session/message handoff is pending
- a bare new-session screen shows the Composer entry centered without starter-template action cards; once the user submits from that state, the centered entry is dismissed immediately and the normal footer Composer/run indicator path takes over even if backend handoff is still pending
- the responding state is not rendered as assistant message text or as a footnote under the submitted user message; it belongs to the footer run indicator and must stay visible while a pending send handoff is still warming up workspace/runtime state
- while that pending send is still starting a local workspace/runtime, the footer indicator label is `Loading`/`Nahrávám`; once workspace warmup is done and the backend is simply producing the assistant turn, the same indicator returns to `Responding`/`Odpovídám`
- first-send workspace and session materialization is scoped to the session run state; it must not hold the global app busy/navigation lock or force the user back to chat if they navigate elsewhere while the handoff is still pending
- when a local workspace is in browsing mode, the OpenCode runtime warmup needed before a send must also stay outside the global app busy/navigation lock; the warmup may delay that send, but the rest of the app remains usable
- remote skill registry/Den failures during local runtime warmup are degraded telemetry conditions, not prompt-send failures, as long as local materialized skill state can still be used safely
- browsing-mode runtime warmup must preserve the currently selected session route even when the engine has to cold-start instead of reattaching to an existing runtime
- the Composer clears immediately and remains available for a separate new draft, including while a new session is still being materialized
- attachment staging, pending-session creation, and message handoff continue in the backend/session layer after the Composer releases the submitted draft
- after a pending chat is materialized into a real session, attachment staging must resolve the active workspace against the live Veslo server workspace list before opening a file session; for local desktop workspaces, a missing server workspace is recovered once by refreshing the local server/workspace state before the agent/model prompt starts
- if handoff fails before a real message exists, the temporary user message stays in the timeline with failed status instead of being restored into the Composer automatically
- failed pending submitted messages can be changed only through the explicit edit pencil, which removes that pending timeline message and loads that exact draft into the Composer
- the Composer is not an automatic rollback buffer for pre-real-message submit failures because the user may already be composing a different message or working in a different pending session
- once a real message exists, later model or run failures stay in the transcript and use the normal message editing, retry, and resend flows

Main source of truth:

- `packages/app/src/app/components/session/composer.tsx`

## Session Message Queue

When a session is running or streaming, plain Enter and the queue send button add the draft to a session-local queue instead of interrupting the active run. Ctrl/Meta+Enter and send-now bypass the queue and submit immediately.

Stopping a run pauses the current session queue before the abort can make the session idle. The queue resumes when the user sends a queued Enter draft or after an accepted send-now draft finishes. When a non-idle session returns to idle and the queue is not paused, Veslo drains the first queued or retryable queued draft.

Plain Escape while a run is active is a two-step stop shortcut. The first eligible Escape changes the streaming stop button from the square icon to `Esc` and does not abort the run. The next eligible Escape confirms the stop and uses the same abort path as the stop button. Escape used by command palette, search, side overlays, modals, or other handled UI must not arm or confirm the stop shortcut.

Queued drafts can be edited, canceled, and reordered before they are sent. Saving an edited queued draft with Enter updates the queued item; saving with send-now submits it immediately.

The app-owned queue remains the editable local affordance for drafts that have not yet been accepted by the Veslo server. Once a conversation run request reaches the server, the server is authoritative: if the orchestrator lifecycle reports an active run for that conversation, the server persists the request as a queued run and returns `status: "queued"` instead of surfacing `run_already_active` as a client error. The server drains that durable queue after the active lifecycle run reaches a terminal state. UI state may mirror this queue, but it must not be treated as the business invariant for whether another run can start.

Local queued drafts are keyed by session id, or by the pending draft key before a real session exists. Queue sends capture their source session before awaiting asynchronous send setup so a draft queued in one session is not accidentally submitted to a different session after navigation. If a queued item is draining in a background session, Veslo avoids starting run UI for the newly selected session while still letting the original session queue continue after that session becomes idle.

Workspace/session visibility is not the runtime boundary. A run in a non-visible workspace must keep using its workspace-scoped server/orchestrator/OpenCode runtime, including file writes and provider requests, and append to the same conversation transcript. The UI consumes background workspace SSE without merging message parts into the currently visible transcript: it updates the scoped status/busy marker, refreshes permission/question prompts, and persists background transcript snapshots through the Veslo server so returning to that workspace can hydrate from durable state. Destructive global actions such as update install, reset, or engine reload must include background `workspaceBusy` entries in their active-run guard instead of checking only the currently visible session list.

Workspace busy state is scoped as `workspaceId -> sessionId -> startedAt`, so multiple runs in one workspace cannot overwrite each other. Session status readers should prefer workspace-scoped status keys and use plain `session.id` only as a legacy fallback for older callers.

## Latest Message Editing

Veslo can show an edit pencil beside the latest user message only when the action is safe at render time. The pencil is hidden while the session is running, while the composer has content, while the selected session queue is non-empty, or when the message is not the latest visible user message.

After the candidate user message, only read-only assistant activity may exist. Reasoning, step markers, blank assistant text, and known read/list/search-style tools are allowed. Visible assistant text, mutating tools, unknown tools, shell or terminal activity, and unreconstructable attachments hide the pencil.

Clicking the pencil loads the reconstructed user draft into the composer and arms a replacement send. Submitting the edited draft uses OpenCode revert semantics: Veslo reverts to the original user message boundary and then sends the revised draft to the same session as a new backend message, leaving the original message hidden behind the revert boundary. If the revised send is rejected, Veslo attempts to restore the prior revert boundary.

## Message Scroll Anchoring

When the user is already at the latest message, new user posts and streamed assistant output keep the message list pinned to the bottom. Auto-scroll may be throttled for render performance, but the final pending scroll must still run while the bottom pin intent remains active. If the user scrolls away from the latest message, Veslo stops auto-pinning and shows the jump-to-latest control instead of forcing the viewport downward.

## Message Progress Grouping

Assistant activity between a user message and the final assistant answer is treated as progress for that user turn. While a run is still streaming, the newest visible assistant text can stay live because the UI cannot yet know whether it is the final answer. Once the turn has a later final assistant text, earlier actions and intermediate assistant comments are collapsed into one expandable progress group before the final answer.

The collapsed group summarizes both action rows and intermediate comments. Expanding it preserves original order and shows non-final assistant text comments directly as normal assistant-visible text without card framing. Tool/action rows, subagent rows, and verification rows stay as nested collapsed progress items so the user can expand only the detail they want to inspect. Intermediate comments are normal assistant-visible text, not model thinking.

User-open progress groups, nested action sections, and technical detail disclosures are UI-owned state. Streaming assistant comments, reasoning visibility changes, tool status updates, or later actions in the same turn must not collapse them while the corresponding progress row still exists.

`showThinking=false` hides model reasoning content and reasoning technical details only. It must not hide progress actions, non-final assistant comments, tool summaries, or other non-reasoning progress details that regular users need in order to understand what happened during the run.

Expanded intermediate comments and expanded technical detail values expose scoped copy controls. Their text values remain directly selectable, but copying a single value should not require selecting across the surrounding agent output.

Markdown code blocks in assistant messages, including `text`-labeled value boxes, expose an icon-only scoped copy control on block hover or focus that copies only the code block value.

## Timeline Media Evidence

The session timeline can show image evidence attached to the step or message where it mattered.

- `Analyzed` means the image was passed to a vision-capable model as image input.
- `Created` means a concrete action in the current run created or modified a bitmap image.
- Discovery-only file listing, globbing, and search do not create media evidence.
- Timeline media evidence is derived UI state. It is not a durable gallery and does not scan arbitrary workspace images.

## Pending Drafts

Unstarted sessions are modeled as pending drafts.

Current behavior:

- pending drafts are durable local state
- empty pending sessions show a centered composer entry instead of the full conversation layout
- pending drafts do not appear in the sidebar until the user presses `Run`; when the pending draft is for a newly registered local directory, the directory itself can appear immediately as an empty project/workspace row in by-project mode
- `Chat` reopens the one existing unpublished private draft instead of creating another unpublished private workspace
- project `+` actions reopen the pending draft for that project directory when one already exists
- the composer target picker can switch the centered entry between the private chat draft and workspace pending drafts
- when the target has no meaningful draft content, switching targets moves the current draft there and consumes the previous pending draft instead of cloning the same text into multiple empty workspaces
- when switching targets would collide with an existing draft, Veslo requires an explicit choice between keeping the current text for the destination or loading the existing destination draft
- a real OpenCode session is materialized only when the pending draft is sent successfully

## Titlebar Context

The centered chat titlebar shows session context before and after a run starts.

Current behavior:

- unsent private chats show a distinct `Chat` state label
- unsent new chats for a concrete directory show `Chat` plus the directory label
- unsent private drafts hide generated private workspace paths so the state label is not mistaken for a directory
- existing chats with messages show the directory or remote workspace context without the `Chat` prefix, except private chat sessions use the chat title instead of the generated private workspace path
- in by-project sidebar mode, private workspace sessions are grouped into a bottom `Chats` section; recent mode keeps them mixed with all other conversations by activity
- subagents launched from private chat sessions stay nested under their parent chat and inherit that parent chat's sidebar context, so they do not surface as separate project/workspace rows
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

In desktop local workspaces, the app can read managed-AI access policy from DEN or standalone AI Gateway, but generated OpenCode provider config must still route through the active local Veslo server. Remote DEN/Veslo URLs are not valid provider `baseURL` targets for local-first desktop execution. The generated gateway model headers are workspace-scoped with `x-veslo-workspace-id`, so runtime validation must reject config copied from another workspace or config missing the workspace correlation header.

For `codex_oauth`, local OpenCode remains the agent runtime. OpenCode sends tool-capable OpenAI-compatible chat-completions requests through the local Veslo server to the managed gateway; the gateway resolves the server-side Codex OAuth credential, calls the ChatGPT Codex Responses endpoint, translates the Responses stream back to OpenAI-compatible JSON/SSE, and returns it without running `codex exec` for local desktop sessions. Codex OAuth secrets stay server-side, while local config contains only Veslo-scoped proxy tokens.

If the managed gateway reports that no eligible Codex credential is available, the desktop session must stop the active run and surface an explicit AI access error in the session UI. This is a terminal send failure until an admin refreshes or reassigns Codex access; it must not leave the session in an indefinite thinking/responding state.

The local Veslo server normalizes managed-AI proxy compression at the gateway boundary. It requests identity encoding from the managed service and does not forward stale `Content-Encoding` headers on streamed responses, because the local fetch runtime may already have decoded the upstream body before the response reaches OpenCode.

Managed-AI proxy endpoints accept larger JSON request bodies than the default Express parser limit so OpenCode can send realistic accumulated session context. This larger parser is scoped to provider proxy routes; unrelated API surfaces keep their narrower defaults or route-specific limits.

The local Veslo server must stream provider request bodies through to the managed gateway without first parsing the full OpenCode payload for diagnostics. Model extraction for normalized error details is best-effort and limited to small requests with a known `Content-Length`; large or chunked provider requests may omit model from local error details.

The same local server boundary keeps full-body parsing byte-limited. Provider error diagnostics read only a bounded sanitized preview, provider success responses stay streamed unless a small redacted management response must be parsed, and OpenCode transcript/helper JSON responses fail explicitly when they exceed local parsing limits. Local JSON and multipart API ingress rejects oversized payloads before normal schema or form parsing where the request size is known.

Session transcript prefetch is bounded by both entry count and estimated bytes per workspace. Large tool outputs or message parts can evict older warm transcript snapshots even when the session-count limit has not been reached.

Managed-AI usage is attributed by request, user, org, session, and credential. Accounting stores input tokens, output tokens, cached tokens, and total tokens from the routed provider response.

Managed-AI admin usage also reports Codex capacity from functional Codex credentials. The capacity overview tracks remaining five-hour and weekly limits, separates measured, unknown, and unavailable Codex status, and feeds admin alerts at 80%, 90%, 95%, and 100% usage. The 95% and 100% thresholds generate admin alert emails, with 100% treated as critical. If the server cannot see Codex limits for any functional credential, it generates a critical visibility alert email that includes the affected Codex credentials and their known or unknown capacity state. Email delivery is de-duplicated per alert and recipient through audit events, while synthetic capacity alerts in the admin alert list are best-effort so stored alert history remains available if Codex status probing is unavailable. Standalone AI Gateway delivery requires Lettr sender env plus `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS`; without them, alerts remain visible in the admin UI but are not e-mailed.

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

The right menu Files family is intentionally narrow. It shows only files explicitly opened/read during the latest run and files modified by the latest run. Modified files are grouped ahead of opened files, and a file that is both opened and modified appears in the modified group. Search, glob, list, and similar discovery-only tool results do not create file rows. Skill execution should appear as the skill name in the Skills family rather than as the backing `SKILL.md` file read.

File rows expose the local desktop reveal action when a file path is available. They do not expose editor-specific open shortcuts.

Main model source:

- `packages/app/src/app/components/session/artifact-family-model.ts`

## Right Menu Capabilities

The session right menu shows a read-only summary of Skills and MCP servers available to the selected chat's workspace directory. This summary is scoped by the selected chat directory, not by the currently active runtime workspace. It includes installed workspace capabilities plus globally inherited capabilities and excludes Hub-only catalog items.

## Archive and Restore

Session archive behavior removes sessions from the active primary list and exposes archived items through Settings.

Archiving the last visible session must not hide a local non-private workspace. The sidebar keeps the empty workspace visible as a workspace-only project so the user can create a new session, open workspace actions, or re-add the same directory without the app appearing to do nothing. This applies in by-project mode and as a Recent-mode fallback when no recent rows remain visible.

Adding a local directory follows the same empty-workspace visibility rule. The directory is published to the sidebar as soon as it is registered, before the existing pending-draft activation/opening flow continues, so by-project mode shows the new project immediately at the top without requiring a real session to exist first.

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
