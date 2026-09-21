# Gmail Attachment Download Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let a Veslo agent save the exact bytes of a Gmail attachment, including ZIP files, into its active workspace without asking the user to upload the file again.

**Architecture:** Den will augment only the `google-gmail` MCP proxy with a `download_attachment` tool. The tool returns a five-minute URL signed for one organization, user, message, and attachment; a new Den endpoint verifies that token, fetches the bytes through Gmail REST with the stored grant, and returns a bounded attachment response. Existing hosted Google MCP traffic remains pass-through.

**Tech Stack:** TypeScript, Express, Node crypto, Gmail REST API, JSON-RPC/MCP, Node test runner, pnpm, GitHub Actions staging deployment.

---

### Task 1: Signed attachment-download tokens

**Files:**
- Modify: `services/den/src/google-workspace/state.ts`
- Test: `services/den/test/google-workspace-state.test.ts`

**Step 1: Write the failing token tests**

Add tests that create a deterministic Gmail attachment token and verify that it
round-trips all authority fields:

```ts
const token = createSignedGoogleWorkspaceAttachmentToken({
  orgId: "org_1",
  userId: "user_1",
  messageId: "message_1",
  attachmentId: "attachment_1",
  filename: "archive.zip",
  mimeType: "application/zip",
  secret,
  now: () => 1_000,
  randomUUID: () => "nonce_1",
})

assert.deepEqual(verifySignedGoogleWorkspaceAttachmentToken(token, {
  secret,
  now: () => 1_001,
}), {
  v: 1,
  kind: "google-gmail-attachment",
  nonce: "nonce_1",
  orgId: "org_1",
  userId: "user_1",
  connectorId: "google-gmail",
  messageId: "message_1",
  attachmentId: "attachment_1",
  filename: "archive.zip",
  mimeType: "application/zip",
  issuedAt: 1_000,
  expiresAt: 301_000,
})
```

Also assert rejection for a changed signature, trailing token segments, blank
identifiers, a non-Gmail connector payload, and the exact expiry instant.

**Step 2: Run the focused state test and verify RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/google-workspace-state.test.ts
```

Expected: FAIL because the attachment token functions are not exported.

**Step 3: Implement the minimal signed-token functions**

Add a typed payload with `kind: "google-gmail-attachment"` and fixed
`connectorId: "google-gmail"`. Reuse the existing HMAC signer and timing-safe
comparison. Default expiry is five minutes, and verification requires nonblank
message id, attachment id, filename, and MIME type.

**Step 4: Re-run the focused state test and verify GREEN**

Run the command from Step 2.

Expected: all Google Workspace state tests pass.

**Step 5: Commit**

```bash
git add services/den/src/google-workspace/state.ts services/den/test/google-workspace-state.test.ts
git commit -m "feat(den): sign Gmail attachment downloads"
```

### Task 2: Bounded Gmail attachment client

**Files:**
- Create: `services/den/src/google-workspace/gmail-attachments.ts`
- Create: `services/den/test/google-workspace-gmail-attachments.test.ts`

**Step 1: Write failing byte-download tests**

Cover the Gmail REST request URL and bearer header, exact base64url decoding for
a ZIP-like byte fixture, upstream 401/403/404/429/5xx mapping, malformed JSON or
data, and an oversized declared or decoded payload.

```ts
const result = await downloadGmailAttachment({
  accessToken: "google_access",
  messageId: "message/1",
  attachmentId: "attachment+1",
  fetchImpl,
})

assert.deepEqual([...result.bytes], [...zipBytes])
```

**Step 2: Run the focused client test and verify RED**

```bash
pnpm --filter @neatech/den exec tsx --test test/google-workspace-gmail-attachments.test.ts
```

Expected: FAIL because the client module does not exist.

**Step 3: Implement the minimal client**

Request the exact Gmail REST endpoint:

```ts
https://gmail.googleapis.com/gmail/v1/users/me/messages/<messageId>/attachments/<attachmentId>
```

Validate a JSON `{ size, data }` response, require canonical base64url content,
decode it to bytes, enforce a 50 MiB decoded limit, and throw a typed,
secret-free error containing only the stable failure category and HTTP status.

**Step 4: Re-run the focused client test and verify GREEN**

Run the command from Step 2.

Expected: all attachment-client tests pass.

**Step 5: Commit**

```bash
git add services/den/src/google-workspace/gmail-attachments.ts services/den/test/google-workspace-gmail-attachments.test.ts
git commit -m "feat(den): fetch Gmail attachment bytes"
```

### Task 3: Expose the Gmail MCP download tool and endpoint

**Files:**
- Modify: `services/den/src/http/google-workspace.ts`
- Test: `services/den/test/google-workspace-oauth.test.ts`

**Step 1: Write the failing MCP and endpoint tests**

Add focused integration tests proving:

- a successful Gmail `tools/list` keeps upstream tools and appends exactly one
  `download_attachment` definition;
- Calendar and Drive `tools/list` responses are not modified;
- a valid Gmail `tools/call` returns structured metadata and a short-lived
  download URL without forwarding the call to Google's MCP endpoint;
- invalid arguments return JSON-RPC `-32602`;
- following the URL returns exact ZIP bytes, a safe `Content-Disposition`, and
  the requested MIME type while Gmail receives the stored bearer token;
- a tampered or expired URL is unauthorized;
- an upstream attachment failure returns a stable, secret-free HTTP error.

**Step 2: Run the focused router test and verify RED**

```bash
pnpm --filter @neatech/den exec tsx --test test/google-workspace-oauth.test.ts
```

Expected: FAIL because the proxy does not yet augment tools or serve downloads.

**Step 3: Add MCP request recognition and response helpers**

Recognize JSON-RPC `tools/list` and `tools/call` bodies without changing any
other MCP request. Define the custom tool with required `messageId`,
`attachmentId`, `filename`, and `mimeType` strings and a description that tells
the agent to save the returned URL in the current workspace instead of asking
the user to re-upload.

**Step 4: Add `tools/list` augmentation**

For Gmail only, parse successful JSON responses and append the custom tool when
the name is not already present. Preserve upstream status, headers, request id,
tools, and response unchanged when parsing or shape checks fail.

**Step 5: Add local `tools/call` dispatch**

Validate arguments, sign the attachment token using the verified runtime-token
identity, and return an MCP text plus structured result containing
`downloadUrl`, `filename`, `mimeType`, and `expiresAt`. Do not call the hosted
MCP endpoint for this one tool.

**Step 6: Add the download endpoint**

Verify the signed token, resolve or refresh the same user's Gmail grant, call
the bounded attachment client, sanitize CR/LF and path components from the
filename, and return the bytes as an attachment. Translate typed client failures
to stable HTTP responses without logging the token, URL, grant, or bytes.

**Step 7: Run focused router and state/client tests and verify GREEN**

```bash
pnpm --filter @neatech/den exec tsx --test \
  test/google-workspace-state.test.ts \
  test/google-workspace-gmail-attachments.test.ts \
  test/google-workspace-oauth.test.ts
```

Expected: all focused tests pass.

**Step 8: Commit**

```bash
git add services/den/src/http/google-workspace.ts services/den/test/google-workspace-oauth.test.ts
git commit -m "feat(den): expose Gmail attachment downloads"
```

### Task 4: Document the durable connector behavior

**Files:**
- Modify: `docs/features/extensions-and-integrations.md`
- Modify: `docs/dev/cloud-deployments.md`

**Step 1: Update the feature contract**

Document that Veslo augments Google's Gmail MCP toolset with a short-lived,
scoped attachment download URL and that the agent saves original bytes into the
workspace. State that the existing `gmail.readonly` scope is sufficient and
that no Google tokens enter workspace config or transcripts.

**Step 2: Update staging verification guidance**

Add a concise staging check for the Gmail MCP augmented `tools/list` behavior
while keeping connected-account attachment-byte validation as an authenticated
smoke.

**Step 3: Run documentation-sensitive tests**

```bash
pnpm --filter @neatech/den exec tsx --test test/google-workspace-oauth.test.ts test/org-mcp-catalog.test.ts
```

Expected: all tests pass.

**Step 4: Commit**

```bash
git add docs/features/extensions-and-integrations.md docs/dev/cloud-deployments.md
git commit -m "docs: describe Gmail attachment downloads"
```

### Task 5: Full verification and staging deployment

**Files:**
- Verify: all files changed by Tasks 1–4

**Step 1: Run Den verification**

```bash
pnpm --filter @neatech/den typecheck
pnpm --filter @neatech/den test
pnpm --filter @neatech/den build
```

Expected: exit 0; zero failed tests.

**Step 2: Run repository quality gates**

```bash
pnpm check
```

Expected: exit 0.

**Step 3: Review the branch diff and commits**

```bash
git status --short
git diff main...HEAD --check
git log --oneline main..HEAD
```

Expected: clean status, no whitespace errors, only planned Gmail attachment and
documentation changes.

**Step 4: Push the reviewed branch**

```bash
git push -u origin fix/gmail-attachment-download
```

Expected: the exact reviewed commit is present on the remote branch.

**Step 5: Dispatch the staging server deployment**

```bash
gh workflow run deploy-staging-server.yml \
  --repo neatechcz/veslo \
  --ref fix/gmail-attachment-download \
  -f branch=fix/gmail-attachment-download \
  -f install_backup_timer=true \
  -f run_backup_now=false
```

Expected: a new `Deploy Staging Server` run starts for the reviewed branch.

**Step 6: Wait for and inspect the deployment**

Use `gh run list` to identify the run, then `gh run watch <run-id> --exit-status`
and `gh run view <run-id> --log-failed` if necessary.

Expected: every deployment, migration, Compose health, and public endpoint step
passes.

**Step 7: Verify staging health and the deployed revision**

```bash
curl -fsS https://api.staging.veslo.work/health
curl -fsSI https://app.staging.veslo.work >/dev/null
```

Then verify the deployed checkout/container revision through the staging runner
evidence and, when an authenticated staging Gmail runtime token is safely
available, call Gmail MCP `tools/list` and confirm `download_attachment` is
present. If a connected fixture email is available, download its ZIP and compare
the byte hash without printing token material or file content.

Expected: public health is green, deployed revision equals the reviewed commit,
and the augmented tool is observable through the authenticated connector.
