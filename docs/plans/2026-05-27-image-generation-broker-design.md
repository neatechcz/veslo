# Image Generation Broker Design

## Goal

Implement VSLO-24 as a Veslo-managed image generation broker that is available to agents during normal chat. Users should not need a special mode, command, or UI flow. A user can ask for an image in plain language, the agent can call the Veslo image tool, and Veslo saves and renders the generated image as a session/workspace artifact.

## Approved Direction

Use an internal Veslo broker tool plus a server/gateway image endpoint.

The tool is the model-facing surface. It accepts the image request and relevant session/workspace context, but it does not hold provider credentials or write files directly. The local Veslo server is the broker and the persistence authority. The managed AI Gateway handles Codex OAuth image generation when that is the active assignment.

## Current Context

Veslo already has:

- workspace activation provisioning for internal Veslo agents and tools
- local server routes for workspace capabilities, MCP, AI Gateway proxying, inbox, outbox, and latest-run artifact provenance
- managed AI Gateway and Den-managed AI `codex_oauth` proxy transports backed by the Codex Responses endpoint
- app UI that renders file parts, tool images, latest-run artifact families, and workspace outbox artifacts
- MCP hub installation flows for user/org-provided capabilities

The existing artifact model is mostly file-oriented. The first slice can store generated images as file artifacts, while adding media metadata that leaves room for general preview support later.

## Options Considered

### Option 1: Internal Veslo broker tool plus gateway image endpoint

The agent receives a Veslo-managed `veslo_image_generate` style tool. The tool calls the local Veslo server. The server chooses the backend, persists the final image, and returns renderable metadata.

Pros:

- matches the local-first runtime model
- keeps provider credentials out of the agent tool implementation
- lets Veslo enforce deterministic backend priority and no hidden platform fallback
- gives the app one canonical persistence and artifact path

Cons:

- touches server, gateway, provisioning, and UI/artifact surfaces

### Option 2: MCP-only image generation

Add an image generation MCP entry and rely on the model to use it.

Pros:

- simpler to expose through the existing MCP surface

Cons:

- does not guarantee Codex OAuth priority
- cannot reliably enforce automatic artifact persistence
- makes fallback semantics too implicit

### Option 3: UI or slash-command image generation

Expose a manual image generation action from the app.

Pros:

- explicit and easier to reason about

Cons:

- conflicts with the requirement that users write ordinary chat requests
- bypasses the agentic tool-selection flow

Option 1 is approved.

## Runtime Architecture

The Veslo internal system provisions an agent-callable image generation tool into the active workspace. The tool accepts:

- prompt
- optional output format, size, quality, and count where supported
- optional source image or file references for future image-editing support
- session/workspace context supplied by the runtime

The tool calls a local Veslo server route. The server does the backend selection and writes the result. This keeps credentials, routing, audit, and artifact semantics server-owned.

Backend priority:

1. Codex OAuth Responses image generation, when the active managed-AI assignment uses `codex_oauth`.
2. User, workspace, or organization image capability exposed through configured MCP or OpenCode plugin fallback.
3. Explicit `not_configured` error.

The broker must not use a hidden platform OpenAI credential as fallback. Fallback is only for support, availability, routing, or capacity. It must not bypass safety or content policy refusals.

## Codex OAuth Path

The local Veslo server calls the configured managed AI service through a new image-generation route. The managed service selects the server-side Codex OAuth credential using the same assignment and lease model as the existing `codex_oauth` proxy. It then calls the Codex Responses endpoint with the built-in `image_generation` tool.

The managed route returns a normalized result:

- MIME type
- image bytes or base64
- suggested filename/title
- provider and model metadata
- request id
- revised prompt or provider note when available
- usage metadata when available
- classified failure reason when unsuccessful

If the Codex Responses endpoint does not support image generation for the assigned model/runtime, the route returns `unsupported` so the broker can continue to configured fallback capabilities.

## Fallback Capability Contract

Fallback capability is explicit user/org/workspace configuration. It can be an MCP server or OpenCode plugin implementing the Veslo media/image generation contract.

Minimum input:

- prompt
- workspace/session context
- optional source image or file references
- preferred output format, size, quality, and count

Minimum output:

- bytes/base64 or a file reference
- MIME type
- filename/title
- provider metadata
- revised prompt or provider note when available
- classified error when unsuccessful

Credentials and permissions remain owned by the fallback provider configuration. The broker only invokes capabilities already available to the workspace/user/org.

## Persistence And Rendering

The local Veslo server writes the generated image into the workspace/session output area with a collision-safe filename. The first implementation can use the existing outbox/file artifact path, but the returned metadata should include media-specific fields so the UI is not forced to infer all semantics from a filename.

The tool output should include:

- workspace-relative path
- artifact id or artifact metadata when available
- MIME type
- dimensions when known
- provider/capability metadata
- request id
- inline render data or a renderable URL/path suitable for the transcript

The transcript should show the image immediately after tool completion. The artifacts panel should show the saved file as a generated image artifact.

## Preview Direction

The first slice targets generated PNG, JPEG, or WebP images. The data model should not assume that image generation is the only media flow. Use a general media artifact and preview contract so later work can add previews for:

- ordinary image artifacts
- PDF previews
- Word/DOCX previews
- HTML screenshots/renders
- other previewable formats

The app should ask the backend for preview/render metadata. It should not implement ad hoc document conversion in the UI.

## Error Handling

Broker errors are classified as:

- `unsupported`
- `unavailable`
- `exhausted`
- `not_configured`
- `policy_rejected`
- `invalid_result`
- `persistence_failed`

Fallback is allowed for `unsupported`, `unavailable`, `exhausted`, and routing/capability availability failures. Fallback is not allowed for `policy_rejected`.

Invalid or partial provider results are not saved as final artifacts. If persistence fails after a valid provider response, the broker returns `persistence_failed` and includes safe diagnostic metadata, not raw credential or token material.

## Audit And Observability

Image generation should be auditable without storing raw secrets. Audit or usage records should capture:

- workspace id
- session id
- user/org identity where available
- provider or fallback capability
- request id
- model where available
- generated artifact path/id
- usage metadata where available
- classified error for failures

## Acceptance Criteria

- A user can ask for an image in ordinary chat and the agent can call the Veslo image broker tool.
- With active `codex_oauth` assignment, the broker tries Codex OAuth Responses image generation first.
- With non-Codex assignment, the broker only uses configured MCP/plugin fallback capability.
- Generated images are automatically saved into workspace/session output.
- Generated images appear in the transcript and in artifacts.
- No hidden platform OpenAI credential is used as fallback.
- Policy refusals are not bypassed by fallback routing.
- The data model leaves room for future preview support for images, PDF, Word/DOCX, and HTML.

## Testing Strategy

Prefer E2E and integration coverage around real Veslo runtime boundaries.

Primary tests:

- server route tests for backend routing, no hidden platform fallback, error classification, and persistence
- AI Gateway and Den managed-AI transport tests for Responses image generation request/response parsing
- artifact provenance tests proving the generated image appears as a latest-run file/media artifact
- desktop E2E smoke using a fake image backend, proving a normal chat prompt produces an inline image and an artifacts entry

Focused lower-level tests are appropriate for:

- safe filename/path generation
- provider result validation
- error classification
- metadata-to-artifact mapping
