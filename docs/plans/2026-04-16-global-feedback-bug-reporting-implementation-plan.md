# Global Feedback Bug Reporting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a global bug-report flow to the Veslo desktop app that saves canonical feedback records in Den and projects each saved report into YouTrack with enough context to find the matching runtime logs.

**Architecture:** Extend the shared titlebar shell with a feedback CTA, capture the current app surface plus route/runtime context in the app, send one authenticated JSON payload to Den, persist that payload as the canonical record, and project it asynchronously into YouTrack through a small server-side MCP adapter. Keep Den as the source of truth; YouTrack is only a projection target.

**Tech Stack:** SolidJS, TypeScript, Tailwind utility classes, node:test source-contract tests, Express, Drizzle ORM, MySQL, minimal Node stdio MCP adapter

---

### Task 0: Prepare an Isolated Worktree

**Files:**
- Review: `docs/plans/2026-04-16-global-feedback-bug-reporting-design.md`
- Review: `packages/app/src/app/app.tsx`
- Review: `services/den/src/http/org-auth.ts`

**Step 1: Sync and create a dedicated worktree**

Run:

```bash
git fetch --all --prune
git worktree add ../Veslo-feedback-bug-reporting -b codex/global-feedback-bug-reporting
```

Expected: a fresh worktree at `../Veslo-feedback-bug-reporting` on branch `codex/global-feedback-bug-reporting`

**Step 2: Install dependencies in the new worktree**

Run:

```bash
cd ../Veslo-feedback-bug-reporting
pnpm install
```

Expected: dependencies installed cleanly in the isolated worktree

### Task 1: Lock the Shared Shell Contract with Tests

**Files:**
- Modify: `packages/app/src/app/components/titlebar-menu-toggles.test.ts`
- Create: `packages/app/src/app/app-feedback-flow.contract.test.ts`
- Verify: `packages/app/src/app/components/titlebar-menu-toggles.tsx`
- Verify: `packages/app/src/app/app.tsx`
- Verify: `packages/app/src/app/pages/dashboard.tsx`
- Verify: `packages/app/src/app/pages/session.tsx`

**Step 1: Write the failing tests**
- Update `titlebar-menu-toggles.test.ts` to require a dedicated right-side content slot in addition to the existing right toggle button.
- Add a new app-level source-contract test that expects:
  - feedback modal state in `app.tsx`
  - feedback trigger wiring from both `DashboardView` and `SessionView`
  - the shared titlebar path, not ad-hoc page-local buttons

**Step 2: Run the targeted tests to verify they fail**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/titlebar-menu-toggles.test.ts src/app/app-feedback-flow.contract.test.ts
```

Expected: FAIL because the shared titlebar currently has no right-content slot and the app shell has no feedback modal wiring

### Task 2: Implement the Global Feedback Button and Modal Shell

**Files:**
- Create: `packages/app/src/app/components/feedback-modal.tsx`
- Modify: `packages/app/src/app/components/titlebar-menu-toggles.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`

**Step 1: Write the minimal shell implementation**
- Extend `TitlebarMenuToggles` with a right-side content slot that sits before the existing right toggle.
- Add a compact `Feedback` button in the shared titlebar path for both dashboard and session views.
- Create a dedicated `FeedbackModal` with exactly two user-editable fields: title and description.
- Keep technical metadata hidden; render only a passive note that Veslo will attach the current screen and technical details automatically.
- Manage modal open/close state in `app.tsx`, not in individual pages, so one flow owns the context snapshot and submit handler.

**Step 2: Re-run the shell contract tests**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/components/titlebar-menu-toggles.test.ts src/app/app-feedback-flow.contract.test.ts
```

Expected: PASS

**Step 3: Commit the shell wiring**

```bash
git add packages/app/src/app/components/feedback-modal.tsx \
  packages/app/src/app/components/titlebar-menu-toggles.tsx \
  packages/app/src/app/components/titlebar-menu-toggles.test.ts \
  packages/app/src/app/app.tsx \
  packages/app/src/app/app-feedback-flow.contract.test.ts \
  packages/app/src/app/pages/dashboard.tsx \
  packages/app/src/app/pages/session.tsx \
  packages/app/src/i18n/locales/en.ts \
  packages/app/src/i18n/locales/cs.ts

git commit -m "feat: add global feedback shell"
```

### Task 3: Add App-Side Screenshot Capture and Den Transport

**Files:**
- Modify: `packages/app/package.json`
- Create: `packages/app/src/app/lib/feedback.ts`
- Create: `packages/app/src/app/lib/feedback.test.ts`
- Modify: `packages/app/src/app/app.tsx`
- Verify: `packages/app/src/app/lib/den-auth.ts`

**Step 1: Write the failing transport tests**
- Add unit tests for a `feedback.ts` helper that:
  - reads Den auth state from `readDenAuth()`
  - builds a JSON payload with the approved runtime context fields
  - captures the current app surface screenshot through a frontend DOM capture helper
  - falls back to `screenshotStatus=failed` when capture throws
  - POSTs authenticated JSON to `POST /v1/feedback`

**Step 2: Run the transport tests to verify they fail**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/lib/feedback.test.ts
```

Expected: FAIL because the feedback helper, screenshot capture path, and Den request do not exist yet

**Step 3: Implement the feedback transport**
- Add a frontend screenshot dependency such as `html2canvas` to `packages/app/package.json`.
- Create `feedback.ts` to:
  - capture the app surface from the root shell element
  - compress/serialize the image as JSON-safe data
  - build the full payload from `app.tsx` state (`view`, tabs, selected session, workspace, app version, locale, platform)
  - send the payload with the existing Den bearer token
- Keep the submit boundary in `app.tsx` so the UI can report success immediately after Den confirms persistence.

**Step 4: Re-run the transport tests**

Run:

```bash
cd packages/app
node --test --import=tsx/esm src/app/lib/feedback.test.ts src/app/components/titlebar-menu-toggles.test.ts src/app/app-feedback-flow.contract.test.ts
```

Expected: PASS

**Step 5: Commit the app transport**

```bash
git add packages/app/package.json \
  packages/app/src/app/lib/feedback.ts \
  packages/app/src/app/lib/feedback.test.ts \
  packages/app/src/app/app.tsx

git commit -m "feat: submit feedback to den"
```

### Task 4: Add Den Feedback Persistence and the Authenticated Route

**Files:**
- Modify: `services/den/src/db/schema.ts`
- Add: `services/den/drizzle/0009_feedback_reports.sql`
- Create: `services/den/src/http/feedback.ts`
- Modify: `services/den/src/index.ts`
- Create: `services/den/test/feedback-route.test.ts`
- Modify: `services/den/README.md`

**Step 1: Write the failing Den route tests**
- Add a route test that expects:
  - authenticated `POST /v1/feedback`
  - org resolution through `x-veslo-org-id`
  - validation errors for missing title/description and oversized screenshot payloads
  - inserted feedback rows with `status="pending"`
  - no assignee or YouTrack dependency in the request path

**Step 2: Run the Den route tests to verify they fail**

Run:

```bash
cd services/den
pnpm test --test feedback-route.test.ts
```

Expected: FAIL because there is no feedback schema, no route, and the server still uses the default JSON body size limit

**Step 3: Implement the persistence layer**
- Add `feedback_report` and `feedback_projector_attempt` to the Drizzle schema.
- Add the matching SQL migration.
- Mount a new `feedbackRouter` from `services/den/src/http/feedback.ts`.
- Raise the Express JSON body limit in `services/den/src/index.ts` so screenshot-bearing JSON requests are accepted.
- Store screenshot data directly on the feedback row for v1 instead of introducing new blob/object storage infrastructure.
- Document the new route and payload expectations in `services/den/README.md`.

**Step 4: Re-run the Den route tests**

Run:

```bash
cd services/den
pnpm test --test feedback-route.test.ts
```

Expected: PASS

**Step 5: Commit the Den persistence work**

```bash
git add services/den/src/db/schema.ts \
  services/den/drizzle/0009_feedback_reports.sql \
  services/den/src/http/feedback.ts \
  services/den/src/index.ts \
  services/den/test/feedback-route.test.ts \
  services/den/README.md

git commit -m "feat: persist feedback reports in den"
```

### Task 5: Add the YouTrack Projector and Retry Loop

**Files:**
- Modify: `services/den/src/env.ts`
- Create: `services/den/src/integrations/mcp-stdio-client.ts`
- Create: `services/den/src/integrations/youtrack-mcp.ts`
- Create: `services/den/src/feedback/projector.ts`
- Modify: `services/den/src/http/feedback.ts`
- Modify: `services/den/src/index.ts`
- Create: `services/den/test/feedback-projector.test.ts`
- Modify: `services/den/README.md`

**Step 1: Write the failing projector tests**
- Add projector tests that expect:
  - one immediate projection attempt after persistence
  - `[Bug] <title>` summary formatting
  - the locator block in the issue body (`feedbackId`, user/org/session/workspace/worker/run IDs, suggested log window)
  - success to store `youtrackIssueId` and `youtrackIssueUrl`
  - failures to write an attempt row, set `lastProjectorError`, and schedule the next retry
  - no duplicate issue creation after `youtrackIssueId` is already present

**Step 2: Run the projector tests to verify they fail**

Run:

```bash
cd services/den
pnpm test --test feedback-projector.test.ts
```

Expected: FAIL because there is no projector service, no MCP adapter, and no retry scheduler

**Step 3: Implement the projector**
- Add env/config for the locally installed YouTrack MCP transport and default target project.
- Create a tiny stdio MCP client wrapper that can call the configured YouTrack MCP server from Den.
- Build a dedicated `youtrack-mcp.ts` adapter that exposes a narrow `createIssue()` interface to the projector.
- Implement a feedback projector service that:
  - runs the first attempt immediately after insert
  - writes attempt rows
  - updates the feedback row on success/failure
  - schedules in-process retries using `next_projector_attempt_at`
- Keep the HTTP route thin: it should persist the row and delegate projection work to the projector service.

**Step 4: Re-run the projector tests and the route tests together**

Run:

```bash
cd services/den
pnpm test --test feedback-route.test.ts
pnpm test --test feedback-projector.test.ts
```

Expected: PASS

**Step 5: Commit the projector**

```bash
git add services/den/src/env.ts \
  services/den/src/integrations/mcp-stdio-client.ts \
  services/den/src/integrations/youtrack-mcp.ts \
  services/den/src/feedback/projector.ts \
  services/den/src/http/feedback.ts \
  services/den/src/index.ts \
  services/den/test/feedback-projector.test.ts \
  services/den/README.md

git commit -m "feat: project feedback into youtrack"
```

### Task 6: Verify the Full Desktop Flow

**Files:**
- Create: `packages/e2e/specs/feedback-bug-report.spec.ts`
- Modify: `packages/e2e/helpers/*` only if the new spec needs shared helpers

**Step 1: Write the failing end-to-end spec**
- Add a Tauri/WebdriverIO spec that:
  - opens the desktop app
  - opens feedback from dashboard
  - fills title + description
  - submits successfully
  - repeats from a session view
- Stub or fixture the Den projector layer so the spec verifies the full desktop flow without requiring a live YouTrack account.

**Step 2: Run the e2e workflow to verify it fails**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd ../e2e
pnpm test --spec ./specs/feedback-bug-report.spec.ts
```

Expected: FAIL because the feedback flow and spec hooks do not exist yet

**Step 3: Make the spec pass and run the focused verification suite**
- Fix any remaining app selectors, modal behaviors, or async waits until the new spec passes.
- Re-run the focused app tests and Den tests once the e2e path is green.

Run:

```bash
cd ../../packages/app
node --test --import=tsx/esm src/app/components/titlebar-menu-toggles.test.ts src/app/app-feedback-flow.contract.test.ts src/app/lib/feedback.test.ts

cd ../../services/den
pnpm test --test feedback-route.test.ts
pnpm test --test feedback-projector.test.ts

cd ../../packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd ../e2e
pnpm test --spec ./specs/feedback-bug-report.spec.ts
```

Expected: PASS across the focused app, Den, and desktop e2e checks

**Step 4: Manual smoke against real Den + YouTrack MCP**

Run:

```bash
cd /path/to/worktree-root
packaging/docker/dev-up.sh
```

Then verify manually:
- submit one feedback report from dashboard
- submit one feedback report from session
- confirm `feedback_report` rows exist in Den
- confirm matching YouTrack issues exist in the configured project
- confirm each issue contains the locator block with `feedbackId`, runtime IDs, and lookup window

**Step 5: Commit the verification harness**

```bash
git add packages/e2e/specs/feedback-bug-report.spec.ts packages/e2e/helpers
git commit -m "test: cover feedback bug report flow"
```
