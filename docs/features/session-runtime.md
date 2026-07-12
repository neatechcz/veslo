# Session Runtime

This document describes the shipped session behavior that future coding agents should preserve.

## Main Session Surface

The public session page entry point remains `packages/app/src/app/pages/session.tsx`, but session
behavior is split across page-local controllers, context runtime controllers, and shell components.
New work should start at the module that owns the behavior, then inspect `session.tsx` or
`context/session.ts` for dependency wiring.

Session view ownership map:

- `packages/app/src/app/pages/session.tsx`: public `SessionView`, controller composition, dependency
  wiring, and top-level page integration.
- `packages/app/src/app/pages/session-conversation-flow.ts`: send, queue, pending-session, retry,
  replacement, and active-run orchestration.
- `packages/app/src/app/pages/session-transcript-viewport.ts`: transcript windowing, bottom pinning,
  scroll intent, and latest-message viewport state.
- `packages/app/src/app/pages/session-search-command-controller.ts`: message search, command palette
  state, command item derivation, and session keyboard command routing.
- `packages/app/src/app/pages/workspace-share-controller.ts`: shared session/dashboard workspace
  sharing, public-link publishing, export, and share-modal state.
- `packages/app/src/app/pages/session-left-sidebar.tsx`,
  `packages/app/src/app/pages/session-right-sidebar.tsx`, and
  `packages/app/src/app/pages/session-center.tsx`: large view-shell layout regions only.

Session store ownership map:

- `packages/app/src/app/context/session.ts`: public `createSessionStore` facade, Solid store
  creation, controller composition, and returned API wiring.
- `packages/app/src/app/context/session-store-model.ts`: pure session/message/part ordering,
  command display aliases, placeholder messages, and synthetic error-turn modeling.
- `packages/app/src/app/context/session-transcript-controller.ts`: transcript hydration, message
  pagination, live/background transcript ingest, deletion tracking, and freshness.
- `packages/app/src/app/context/session-runtime-prompts.ts`: permission/question refresh, active
  prompt selection, per-workspace prompt aggregation, reply routing, and stale route release.
- `packages/app/src/app/context/session-selection-controller.ts`: session list loading, selected
  session lifecycle, offline transcript fallback, directory filtering, rename, and load-earlier.
- `packages/app/src/app/context/session-event-stream.ts`: SSE stream fan-out, active/background
  event application, event coalescing, reconnect catch-up, unread assistant observation, and
  background transcript persistence triggers.
- `packages/app/src/app/context/session-workspace-cache.ts`: workspace snapshot save/load/clear,
  selected-session validation, transcript metadata restore, and snapshot eviction.
- `packages/app/src/app/context/session-reconnect.ts`: outage snapshot and reconnect notice rules.

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
- a bare new-session screen shows the Composer entry centered without starter-template action cards; once the user submits from that state, the centered entry and chat/workspace picker are dismissed immediately and the normal footer Composer/run indicator path takes over even if backend handoff is still pending
- the responding state is not rendered as assistant message text or as a footnote under the submitted user message; it belongs to the footer run indicator and must stay visible while a pending send handoff is still warming up workspace/runtime state
- while that pending send is still starting a local workspace/runtime, the footer indicator label is `Loading`/`Nahrávám`; once workspace warmup is done and the backend is simply producing the assistant turn, the same indicator returns to `Responding`/`Odpovídám`
- first-send workspace and session materialization is scoped to the session run state; it must not hold the global app busy/navigation lock or force the user back to chat if they navigate elsewhere while the handoff is still pending
- when a local workspace is in browsing mode, the OpenCode runtime warmup needed before a send must also stay outside the global app busy/navigation lock; the warmup may delay that send, but the rest of the app remains usable
- remote skill registry/Den failures during local runtime warmup are degraded telemetry conditions, not prompt-send failures, as long as local materialized skill state can still be used safely
- browsing-mode runtime warmup must preserve the currently selected session route even when the engine has to cold-start instead of reattaching to an existing runtime
- the Composer is the sole owner of its live editor value; each send snapshots one immutable draft revision
- when a pending submitted row or local queued item accepts that snapshot, the Composer clears that exact revision immediately and remains available for a separate new draft, including while a new session is still being materialized
- attachment staging, pending-session creation, and message handoff continue in the backend/session layer after that local ownership transfer; delayed results from the submitted revision cannot clear newer text
- when no local owner accepts the snapshot, a typed submit result applies only while the same Composer revision is still current
- after a pending chat is materialized into a real session, attachment staging must resolve the active workspace against the live Veslo server workspace list before opening a file session; for local desktop workspaces, a missing server workspace is recovered once by refreshing the local server/workspace state before the agent/model prompt starts
- if handoff fails before a real message exists, the temporary user message stays in the timeline with failed status instead of being restored into the Composer automatically
- failed pending submitted messages can be changed only through the explicit edit pencil, which removes that pending timeline message and loads that exact draft into the Composer
- the Composer is not an automatic rollback buffer for pre-real-message submit failures because the user may already be composing a different message or working in a different pending session
- once a real message exists, later model or run failures stay in the transcript and use the normal message editing, retry, and resend flows

Main source of truth:

- `packages/app/src/app/components/session/composer.tsx`
- `packages/app/src/app/components/session/composer-draft-handoff.ts`

## Run Truth And Transcript Adoption

After a server accepts a scoped conversation run, the durable lifecycle record owns its terminal
truth. OpenCode SSE `session.error` and `session.idle` observations are immediate reconciliation
signals: they can refresh local activity presentation and trigger a durable run-status read, but
they cannot by themselves turn an admitted run into a failed terminal outcome.

The visible run indicator, Stop control, and Escape stop shortcut use the same session-scoped
projection. A non-stale lifecycle `running` result stays active even if a transient SSE observation
has already made the engine session look idle. Failed, completed, and aborted lifecycle results have
different visible outcomes: only a durable failed result creates one scoped red error turn; completed
and aborted results settle idle without failed-run treatment. App-wide operational errors render in a
separate neutral boundary and do not change an unrelated session's run phase or abortability.

For an active `busy` engine session, lifecycle reconciliation reads the latest message parts before
settling on a generic waiting label. A running tool therefore remains visible as local tool work
instead of being collapsed into `assistant_message_open`. Chrome MCP tool transitions are recorded
with identifiers, tool name, status, and output/error presence only; URLs, inputs, and tool output
remain out of diagnostic traces. A terminal tool `error` or `failed` state is read after the engine
is idle and only when no later assistant text recovered the step. Otherwise it is persisted as the
fixed redacted reason
`opencode_tool_execution_failed`; raw tool error text remains out of traces and run storage.

Pending submissions immediately render a transient local echo while the canonical user transcript row
is unavailable. This is presentation state, not optimistic server admission or durable transcript
truth. Render replacement and durable cleanup are deliberately separate: the projection suppresses
the echo in the same render that includes its canonical row, while pending state is removed only after
confirmed canonical adoption, never merely because the server accepted the run.

`clientMessageId` is used for server admission and idempotency; it is not
forwarded as an OpenCode message id. Pending transcript adoption requires one
scoped, post-baseline user candidate. Explicit compatible client metadata wins;
otherwise the app uses a bounded text/mode/file fingerprint. Ambiguous matches
remain visible rather than being guessed. Bounded catch-up is reserved for a
missing assistant response, and only a failure known before admission is
editable.

If an existing-conversation server-submit transport loses its response, Veslo replays the same
idempotent `clientMessageId` once. A second transport failure is shown as an unconfirmed-delivery
warning, not as an editable retry with a fresh id. While any transient local submission remains
unresolved, a new normal send stays in Composer and is not dispatched without its own local owner.

Main source of truth:

- lifecycle reconciliation: `packages/app/src/app/context/session-lifecycle-recovery.ts`
- SSE arbitration: `packages/app/src/app/context/session-event-stream.ts`
- run presentation: `packages/app/src/app/pages/session-run-presentation.ts`
- pending-submission reconciliation: `packages/app/src/app/components/session/pending-submit-reconciliation.ts`

## Session Message Queue

There are two deliberately separate queue owners:

- A local queued draft is a pre-admission, editable SessionView item. It exists only for the lifetime of that view and is not restart-durable.
- An accepted server queue item is a durable `conversation_run_queue` request. The app can show a read-only projection of it, but the server remains its only execution owner.

While a session is running or streaming, plain Enter and the queue send button submit directly to server admission instead of first creating a local queue row. If the server accepts the request while another lifecycle run is active, it returns `status: "queued"`; the app immediately renders its server-owned projection. Ctrl/Meta+Enter and send-now still submit immediately. A draft becomes a local queued draft only when the local flow already owns an unsent draft, is paused after Stop, or is being edited before admission.

Stop aborts the active lifecycle run and pauses only local pre-admission drafts before that abort can make the session idle. A server-accepted queue item is not paused or cancelled by Stop and may continue after the aborted run reaches a terminal state. When a non-idle session returns to idle and its local queue is not paused, Veslo drains the first local queued draft. A failed local head requires explicit Retry and blocks later local drafts until the user retries, edits/sends, or cancels it.

Plain Escape while a run is active is a two-step stop shortcut. The first eligible Escape changes the streaming stop button from the square icon to `Esc` and does not abort the run. The next eligible Escape confirms the stop and uses the same abort path as the stop button. Escape used by command palette, search, side overlays, modals, or other handled UI must not arm or confirm the stop shortcut.

Local queued drafts can be edited, canceled, reordered, and—only for the failed head—retried before admission. Saving an edited local draft with Enter updates that local item; saving with send-now submits it immediately. Server projection rows are read-only: they do not expose Retry, Edit, Cancel, Move, Pause, or Resume controls, and their generic typed label intentionally contains no prompt text after reload.

Once a conversation run request reaches the server, the server is authoritative: if the orchestrator lifecycle reports an active run for that conversation, the server persists the request as a queued run and returns `status: "queued"` instead of surfacing `run_already_active` as a client error. The lifecycle active read reconciles stale rows against OpenCode before queueing. The server drains the durable queue after the active lifecycle run reaches a terminal state, including terminal states discovered from transcript/idle reconciliation. The app hydrates pending, starting, and failed rows for the selected scoped conversation after activation, reconnect, return from a background session, and relevant lifecycle transitions. UI state may mirror this queue, but it must not be treated as the business invariant for whether another run can start.

Queue status `submitted` means that queue processing handed the reserved run to the lifecycle; it is not a successful model response. At that point the waiting-row projection disappears, and subsequent lifecycle/transcript state keyed by `reservedRunId` owns run completion or failure. Queue-row retention and data classification are intentionally deferred to a separate decision; this behavior does not add a server mutation or acknowledgement API.

After any server-accepted submit, the app must retain the scoped conversation identity across the UI session id, OpenCode session id, and conversation id aliases so follow-up stop, queue-drain, lifecycle, and transcript operations never infer workspace scope from the currently selected workspace.

Local queued drafts are keyed by session id, or by the pending draft key before a real session exists. Queue sends capture their source session before awaiting asynchronous send setup so a draft queued in one session is not accidentally submitted to a different session after navigation. If a queued item is draining in a background session, Veslo avoids starting run UI for the newly selected session while still letting the original session queue continue after that session becomes idle.

Legacy pending queue-key prefixes remain compatibility state. They must not be removed or silently reinterpreted without separate upgrade-state evidence.

Workspace/session visibility is not the runtime boundary. A run in a non-visible workspace must keep using its workspace-scoped server/orchestrator/OpenCode runtime, including file writes and provider requests, and append to the same conversation transcript. The UI consumes background workspace SSE without merging message parts into the currently visible transcript: it updates the scoped status/busy marker, refreshes permission/question prompts, and persists background transcript snapshots through the Veslo server so returning to that workspace can hydrate from durable state. Destructive global actions such as update install, reset, or engine reload must include background `workspaceBusy` entries in their active-run guard instead of checking only the currently visible session list.

Workspace busy state is scoped as `workspaceId -> sessionId -> startedAt`, so multiple runs in one workspace cannot overwrite each other. Session status readers should prefer workspace-scoped status keys and use plain `session.id` only as a legacy fallback for older callers.

Main source of truth:

- `packages/app/src/app/pages/session-conversation-flow.ts`
- `packages/app/src/app/context/session-event-stream.ts`
- `packages/app/src/app/context/session-transcript-controller.ts`
- `packages/app/src/app/context/session-runtime-prompts.ts`
- `packages/app/src/app/context/session-workspace-cache.ts`
- page wiring in `packages/app/src/app/pages/session.tsx`

## Latest Message Editing

Veslo can show an edit pencil beside the latest user message only when the action is safe at render time. The pencil is hidden while the session is running, while the composer has content, while the selected session queue is non-empty, or when the message is not the latest visible user message.

After the candidate user message, only read-only assistant activity may exist. Reasoning, step markers, blank assistant text, and known read/list/search-style tools are allowed. Visible assistant text, mutating tools, unknown tools, shell or terminal activity, and unreconstructable attachments hide the pencil.

Clicking the pencil loads the reconstructed user draft into the composer and arms a replacement send. Submitting the edited draft uses OpenCode revert semantics: Veslo reverts to the original user message boundary and then sends the revised draft to the same session as a new backend message, leaving the original message hidden behind the revert boundary. If the revised send is rejected, Veslo attempts to restore the prior revert boundary.

## Message Scroll Anchoring

When the user is already at the latest message, new user posts and streamed assistant output keep the message list pinned to the bottom. Auto-scroll may be throttled for render performance, but the final pending scroll must still run while the bottom pin intent remains active. If the user scrolls away from the latest message, Veslo stops auto-pinning and shows the jump-to-latest control instead of forcing the viewport downward.

Main source of truth:

- `packages/app/src/app/pages/session-transcript-viewport.ts`
- `packages/app/src/app/components/session/message-list.tsx`

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

- unpublished pending drafts are durable local state
- there is one app-wide unpublished draft body before the first message creates a real conversation
- the selected pending target is metadata on that one draft: private chat, workspace id, and normalized directory
- empty pending sessions show a centered composer entry instead of the full conversation layout
- pending drafts do not appear in the sidebar until the user presses `Run`; when the pending draft is for a newly registered local directory, the directory itself can appear immediately as an empty project/workspace row in by-project mode
- `Chat`, project `+`, and the composer target picker all open the same unpublished draft body
- switching between chat and workspace targets keeps the current text and attachments, updates the selected destination metadata, and never loads a destination-specific draft body
- old per-workspace pending draft records are obsolete; they are ignored and are not migrated into the global draft
- a real OpenCode session is materialized only when the pending draft is sent successfully
- first send snapshots both the current global draft and the selected destination; once pending submission state accepts local ownership, the Composer clears only that submitted revision, and a pre-admission failure remains as an explicit editable timeline row instead of being restored automatically over a newer draft
- real OpenCode sessions keep the existing per-session composer draft behavior after materialization

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

When managed AI is enabled, signed-in app identity and desktop handoff can come from DEN. Enablement, provider, and credential assignment are resolved by the service that receives the routed managed-AI request, while the global AI Gateway platform model policy owns the enabled backend models and exactly one active model. New desktop and orchestrator builds default to the owned standalone AI Gateway derived from the deployment domain: `https://ai.veslo.work` for production or `https://ai.staging.veslo.work` for staging. If the configured managed-AI base URL points at any standalone AI Gateway, that gateway's AI-access repository, platform model policy, and admin UI are the runtime authority. DEN and standalone AI Gateway show the same access, credential, and model-policy state only when they share the same managed-AI backing database and config.

New DEN sign-ups may receive managed-AI enablement, provider, and a healthy eligible Codex credential when one is available. The access assignment is applied during the auth sign-up hook, marked `auto_assigned`, and skipped without blocking account creation when no eligible credential exists. Signup does not create a per-user model choice or default model.

Standalone AI Gateway platform administration configures the global enabled-backend-model set and its single active model. Credential-specific model listing is infrastructure evidence for validating that policy and populating its catalog, not a model choice attached to a user assignment. OpenAI-compatible credentials use live upstream `/models` discovery, while Codex OAuth credentials use the gateway-owned Codex model catalog without relying on experimental Codex model-discovery internals. `/api/me/ai-access` and its alias compose the current active model as read-only `effectiveModel`; users cannot choose or switch it.

The standalone admin shell keeps platform administration and organization workspaces as separate route areas. Platform overview, organization directory, AI infrastructure, platform users, and global audit routes never retain an organization id. Organization overview, members, domains and invites, billing, AI access, and audit routes always include the authorized organization id in `/admin/organizations/:orgId/...`; the persistent organization selector appears only in that workspace and preserves the current organization subpage when switching. Global user creation, profile edits, platform-admin assignment, disable, and delete actions are available only on the canonical Platform Users route. Organization Members writes only membership fields for the routed organization, while Organization AI Access writes only the server-authorized access assignment. Pending organization-scoped reads and mutations cannot update status, close dialogs, redirect, or render into a different organization after a route switch. Organization Billing proxies Den's canonical billing API without duplicating Stripe logic, preserves Den validation responses, and exposes manual controls only to platform admins. Organization Audit is filtered by organization in storage before ordering and limiting; organization mutations record that scope, while legacy global rows with no organization id remain available only in global audit and are intentionally absent from organization audit.

Standalone AI Gateway admin can soft-delete unusable credentials from the credential detail view. Deleted credentials are hidden from the default credential inventory, exposed only by the Show Deleted toggle, tombstone their stored secret material, and are excluded from assignment, automatic rotation, lease selection, and user AI-access options while their historical usage, alert, and audit records remain inspectable.

In desktop local workspaces, the app can read managed-AI access policy from DEN or standalone AI Gateway, but generated OpenCode provider config must still route through the active local Veslo server. Remote DEN/Veslo URLs are not valid provider `baseURL` targets for local-first desktop execution. The generated gateway model headers are run-scoped, not workspace-scoped: config keeps `x-veslo-session-id = ${OPENCODE_SESSION_ID}`, and the local proxy resolves that placeholder from OpenCode's real `x-session-id` request header. Legacy `x-veslo-workspace-id` model headers are stale runtime state and must be scrubbed from managed provider config.

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

User managed-AI access records own only enablement, provider, credential assignment, and assignment origin. The gateway composes the read-only `effectiveModel` from the current platform model policy, so historical per-user model columns cannot influence routing or API responses. Admin writes that still include legacy per-user model fields fail with `user_model_policy_not_supported`, and enabled assignments must use the active model's provider. Available assignment options and admin writes also require the selected credential itself to prove support for the complete active model reference; authoritative incompatibility is rejected without a write, while transient capability lookup failure fails closed as a service error.

An assigned Codex credential is repaired on the next Codex request when it is exhausted, unavailable, missing, or invalid for the assigned provider. The managed-AI service can update either an `auto_assigned` or `admin_assigned` assignment to another healthy eligible Codex credential before routing, preserving enablement and the original assignment origin. Model compatibility is evaluated only against the platform active model supplied to the repair operation; rotation neither reads nor writes historical per-user model columns. If no replacement exists, the request fails explicitly and the stored assignment is kept. OpenAI-compatible credentials remain hard constraints because the assigned credential determines the upstream base URL and API key.

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

Session and dashboard views include live-access sharing and public-link sharing through
`ShareWorkspaceModal`. Shared share/export orchestration lives in
`packages/app/src/app/pages/workspace-share-controller.ts`; `session.tsx` and `dashboard.tsx` only
provide page-specific labels, runtime state, and modal wiring.

Those semantics are documented in `docs/features/workspace-config-and-sharing.md`.

## Source of Truth

- session page integration: `packages/app/src/app/pages/session.tsx`
- session store facade: `packages/app/src/app/context/session.ts`
- session store model: `packages/app/src/app/context/session-store-model.ts`
- transcript state and persistence: `packages/app/src/app/context/session-transcript-controller.ts`
- runtime prompts: `packages/app/src/app/context/session-runtime-prompts.ts`
- session selection and loading: `packages/app/src/app/context/session-selection-controller.ts`
- SSE and reconnect catch-up: `packages/app/src/app/context/session-event-stream.ts`
- workspace cache: `packages/app/src/app/context/session-workspace-cache.ts`
- send/queue/pending flow: `packages/app/src/app/pages/session-conversation-flow.ts`
- transcript viewport: `packages/app/src/app/pages/session-transcript-viewport.ts`
- search and command palette: `packages/app/src/app/pages/session-search-command-controller.ts`
- sharing/export orchestration: `packages/app/src/app/pages/workspace-share-controller.ts`
- session shell layout: `packages/app/src/app/pages/session-left-sidebar.tsx`, `packages/app/src/app/pages/session-right-sidebar.tsx`, `packages/app/src/app/pages/session-center.tsx`
- composer: `packages/app/src/app/components/session/composer.tsx`
- message rendering: `packages/app/src/app/components/session/message-list.tsx`
- artifacts: `packages/app/src/app/components/session/artifact-family-model.ts`
- feedback: `packages/app/src/app/lib/feedback.ts`
