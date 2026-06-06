# Agent Media Evidence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show images the agent analyzed or created directly in the session timeline, tied to the step or message where the image mattered.

**Architecture:** Add a small pure `MediaEvidence` derivation model, attach media evidence to timeline rows and message attachment rendering, then render compact thumbnail strips in expanded progress details. Keep this as derived UI state; do not introduce durable media storage or a separate artifact gallery.

**Tech Stack:** SolidJS, TypeScript, OpenCode transcript `Part` objects, Node test runner with `tsx/esm`, WebdriverIO desktop E2E against the Tauri app.

---

## Preconditions

Run implementation in a dedicated worktree or a clean feature branch. Do not use `packages/web`, raw Vite, or `pnpm -w dev:ui` as runtime verification.

Before any desktop E2E run, perform the Veslo desktop preflight from `docs/dev/testing-playbook.md`:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

If the first command shows a process that was not started by this implementation session, stop and ask before killing it.

---

### Task 1: Media Evidence Model Tests

**Files:**
- Create: `packages/app/src/app/components/session/media-evidence-model.test.ts`
- Create: `packages/app/src/app/components/session/media-evidence-model.ts`

**Step 1: Create the empty model module**

Create `packages/app/src/app/components/session/media-evidence-model.ts` with only exported types and throwing stubs so the tests can import it:

```ts
import type { Part } from "@opencode-ai/sdk/v2/client";

export type MediaEvidenceKind = "analyzed" | "created";
export type MediaEvidenceStatus = "available" | "missing" | "tooLarge" | "unsupported" | "redacted";

export type MediaEvidence = {
  id: string;
  kind: MediaEvidenceKind;
  title: string;
  mime: string;
  src?: string;
  path?: string;
  sourcePartId: string;
  status: MediaEvidenceStatus;
};

export type BuildMediaEvidenceInput = {
  parts: Part[];
  sourceId: string;
  workspaceRoot?: string;
  defaultKind?: MediaEvidenceKind;
};

export function buildMediaEvidenceForParts(_input: BuildMediaEvidenceInput): MediaEvidence[] {
  throw new Error("not implemented");
}
```

**Step 2: Write failing derivation tests**

Create `packages/app/src/app/components/session/media-evidence-model.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { buildMediaEvidenceForParts } from "./media-evidence-model.js";

const part = (id: string, value: Record<string, unknown>): Part => ({ id, sessionID: "s1", messageID: "m1", ...value } as any);

test("classifies inline image file parts as analyzed by default", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "message:m1",
    defaultKind: "analyzed",
    parts: [
      part("p1", {
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "data:image/png;base64,AAAA",
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "analyzed");
  assert.equal(evidence[0]?.title, "screenshot.png");
  assert.equal(evidence[0]?.mime, "image/png");
  assert.equal(evidence[0]?.src, "data:image/png;base64,AAAA");
  assert.equal(evidence[0]?.status, "available");
});

test("extracts structured tool images", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p2",
    defaultKind: "analyzed",
    parts: [
      part("p2", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ data: "BBBB", mediaType: "image/png", alt: "Browser screenshot" }],
        },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "analyzed");
  assert.equal(evidence[0]?.title, "Browser screenshot");
  assert.equal(evidence[0]?.src, "data:image/png;base64,BBBB");
});

test("classifies concrete created bitmap paths from write-like tools", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3",
    workspaceRoot: "/Users/me/project",
    parts: [
      part("p3", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "artifacts/result.webp" } },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "created");
  assert.equal(evidence[0]?.path, "artifacts/result.webp");
  assert.equal(evidence[0]?.src, "file:///Users/me/project/artifacts/result.webp");
});

test("ignores discovery-only tools and non-image files", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p4",
    parts: [
      part("p4", { type: "tool", tool: "grep", state: { input: { path: "images/logo.png" } } }),
      part("p5", { type: "file", mime: "text/plain", filename: "note.txt", url: "data:text/plain;base64,AAAA" }),
    ],
  });

  assert.deepEqual(evidence, []);
});
```

**Step 3: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/media-evidence-model.test.ts
```

Expected: FAIL with `not implemented`.

**Step 4: Commit the failing test only if your workflow allows red commits**

Preferred: do not commit yet. Keep the failing test in the worktree and proceed to Task 2.

---

### Task 2: Implement The Pure Media Evidence Model

**Files:**
- Modify: `packages/app/src/app/components/session/media-evidence-model.ts`
- Test: `packages/app/src/app/components/session/media-evidence-model.test.ts`

**Step 1: Implement minimal helpers**

Replace the throwing stub with a pure implementation shaped like this:

```ts
import type { Part } from "@opencode-ai/sdk/v2/client";

export type MediaEvidenceKind = "analyzed" | "created";
export type MediaEvidenceStatus = "available" | "missing" | "tooLarge" | "unsupported" | "redacted";

export type MediaEvidence = {
  id: string;
  kind: MediaEvidenceKind;
  title: string;
  mime: string;
  src?: string;
  path?: string;
  sourcePartId: string;
  status: MediaEvidenceStatus;
};

export type BuildMediaEvidenceInput = {
  parts: Part[];
  sourceId: string;
  workspaceRoot?: string;
  defaultKind?: MediaEvidenceKind;
};

const BITMAP_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const WRITE_TOOLS = new Set(["write", "edit", "apply_patch", "bash", "shell", "exec", "command", "run", "imagegen", "screenshot"]);
const DISCOVERY_TOOLS = new Set(["read", "grep", "glob", "search", "list", "list_files"]);

function partId(part: Part, fallback: string): string {
  const id = (part as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : fallback;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}

function extension(path: string): string {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

function mimeFromPath(path: string): string {
  const ext = extension(path);
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function isBitmapPath(path: string): boolean {
  return BITMAP_EXTENSIONS.has(extension(path));
}

function absoluteFileUrl(path: string, workspaceRoot = ""): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  if (/^data:/i.test(trimmed)) return trimmed;
  const absolute = trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)
    ? trimmed
    : workspaceRoot.trim()
      ? `${workspaceRoot.replace(/\/+$/, "")}/${trimmed}`
      : "";
  return absolute ? `file://${absolute.replace(/\\/g, "/")}` : undefined;
}

function inputObject(part: Part): Record<string, unknown> {
  const state = (part as any).state;
  const input = state?.input;
  return input && typeof input === "object" ? input as Record<string, unknown> : {};
}

function toolName(part: Part): string {
  return typeof (part as any).tool === "string" ? String((part as any).tool).toLowerCase() : "";
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function buildMediaEvidenceForParts(input: BuildMediaEvidenceInput): MediaEvidence[] {
  const evidence: MediaEvidence[] = [];

  input.parts.forEach((part, index) => {
    const sourcePartId = partId(part, `${input.sourceId}:${index}`);

    if (part.type === "file") {
      const record = part as any;
      const mime = typeof record.mime === "string" ? record.mime : "";
      const src = typeof record.url === "string" ? record.url : "";
      if (mime.startsWith("image/") && src && !src.startsWith("file://")) {
        evidence.push({
          id: `${sourcePartId}:image`,
          kind: input.defaultKind ?? "analyzed",
          title: typeof record.filename === "string" && record.filename.trim() ? record.filename.trim() : "Image",
          mime,
          src,
          sourcePartId,
          status: "available",
        });
      }
      return;
    }

    if (part.type !== "tool") return;
    const tool = toolName(part);
    const state = (part as any).state ?? {};

    const images = Array.isArray(state.images) ? state.images : [];
    images.forEach((item: any, imageIndex: number) => {
      const src = typeof item === "string"
        ? item
        : typeof item?.url === "string"
          ? item.url
          : typeof item?.src === "string"
            ? item.src
            : typeof item?.data === "string" && typeof item?.mediaType === "string"
              ? `data:${item.mediaType};base64,${item.data}`
              : "";
      const mime = typeof item?.mediaType === "string" ? item.mediaType : "image/png";
      if (!src || !mime.startsWith("image/")) return;
      evidence.push({
        id: `${sourcePartId}:image:${imageIndex}`,
        kind: input.defaultKind ?? "analyzed",
        title: typeof item?.alt === "string" && item.alt.trim() ? item.alt.trim() : "Image",
        mime,
        src,
        sourcePartId,
        status: "available",
      });
    });

    if (DISCOVERY_TOOLS.has(tool) || !WRITE_TOOLS.has(tool)) return;
    const path = stringField(inputObject(part), ["filePath", "path", "file", "outputPath"]);
    if (!path || !isBitmapPath(path)) return;
    evidence.push({
      id: `${sourcePartId}:created:${path}`,
      kind: "created",
      title: basename(path),
      mime: mimeFromPath(path),
      src: absoluteFileUrl(path, input.workspaceRoot),
      path,
      sourcePartId,
      status: absoluteFileUrl(path, input.workspaceRoot) ? "available" : "missing",
    });
  });

  return evidence;
}
```

Keep the implementation small. Do not add workspace scanning or server reads in this task.

**Step 2: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/media-evidence-model.test.ts
```

Expected: PASS.

**Step 3: Commit**

```bash
git add packages/app/src/app/components/session/media-evidence-model.ts packages/app/src/app/components/session/media-evidence-model.test.ts
git commit -m "feat(app): derive timeline media evidence"
```

---

### Task 3: Attach Media Evidence To Timeline Rows And Summaries

**Files:**
- Modify: `packages/app/src/app/components/session/timeline-detail-model.ts`
- Modify: `packages/app/src/app/components/session/timeline-detail-model.test.ts`
- Modify: `packages/app/src/app/components/session/message-list.tsx`

**Step 1: Write failing timeline model tests**

Add tests to `packages/app/src/app/components/session/timeline-detail-model.test.ts`:

```ts
test("buildTimelineDetailModel attaches created image evidence to write rows", () => {
  const model = buildTimelineDetailModel({
    workspaceRoot: "/Users/me/project",
    parts: [
      {
        id: "tool-write-image",
        type: "tool",
        tool: "write",
        state: { input: { filePath: "screenshots/result.png" }, status: "completed" },
      },
    ],
  } as any);

  const row = model.sections[0]?.rows[0];
  assert.equal(row?.mediaEvidence?.[0]?.kind, "created");
  assert.equal(row?.mediaEvidence?.[0]?.title, "result.png");
});

test("buildCollapsedSummary includes image evidence counts", () => {
  const summary = buildCollapsedSummary({
    sections: [
      {
        summary: "1 action",
        rows: [
          {
            kind: "action",
            rowType: "write",
            primary: "Write result.png",
            mediaEvidence: [{ id: "image-1", kind: "created", title: "result.png", mime: "image/png", sourcePartId: "p1", status: "available" }],
          },
        ],
      } as any,
    ],
  });

  assert.match(summary, /1 image created/i);
});
```

**Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-detail-model.test.ts
```

Expected: FAIL because `mediaEvidence` and the summary counts are not wired.

**Step 3: Extend timeline types and builder**

In `timeline-detail-model.ts`:

- import `MediaEvidence` and `buildMediaEvidenceForParts`
- add `mediaEvidence?: MediaEvidence[]` to `TimelineRowModel`
- add `workspaceRoot?: string` to `BuildTimelineDetailModelInput`
- after each row is built, attach evidence from the corresponding part

Shape:

```ts
import { buildMediaEvidenceForParts, type MediaEvidence } from "./media-evidence-model.js";

export type TimelineRowModel = {
  kind: TimelineSectionKind;
  rowType: TimelineRowType;
  primary: string;
  secondary?: string;
  status?: "done" | "running" | "error" | "pass";
  technicalDetail?: string;
  mediaEvidence?: MediaEvidence[];
};

type BuildTimelineDetailModelInput = {
  parts: Part[];
  latestLabel?: string;
  workspaceRoot?: string;
};
```

When building rows:

```ts
const row = normalizeStaleRunningReasoningRow(buildRowModel(part, kind), part, index, input.parts.length);
const mediaEvidence = buildMediaEvidenceForParts({
  parts: [part],
  sourceId: `${part.type}:${index}`,
  workspaceRoot: input.workspaceRoot,
});
return mediaEvidence.length ? { ...row, mediaEvidence } : row;
```

Do not attach media evidence to list, grep, glob, or search rows except for structured image payloads returned by a tool result.

**Step 4: Add summary counting**

Update `buildCollapsedSummary` and any message-list local collapsed summary helpers so image counts can appear beside existing action/search/verification counts:

```ts
function countMedia(rows: Array<Pick<TimelineRowModel, "mediaEvidence">>, kind: "analyzed" | "created"): number {
  return rows.reduce((total, row) => total + (row.mediaEvidence ?? []).filter((item) => item.kind === kind).length, 0);
}
```

Add English summary text first in code, then localize in Task 4. Temporary output for tests can be `1 image created`, `2 images analyzed`.

**Step 5: Pass workspace root from the renderer**

In `message-list.tsx`, update the `buildTimelineDetailModel` call inside `StepsContainer`:

```ts
const timelineModel = createMemo(() =>
  buildTimelineDetailModel({
    parts: allStepParts(),
    latestLabel: latestStepLabel(),
    workspaceRoot: props.workspaceRoot,
  }),
);
```

**Step 6: Run focused tests**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-detail-model.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/components/session/timeline-detail-model.ts packages/app/src/app/components/session/timeline-detail-model.test.ts packages/app/src/app/components/session/message-list.tsx
git commit -m "feat(app): attach media evidence to timeline rows"
```

---

### Task 4: Render Timeline Media Evidence Strips

**Files:**
- Create: `packages/app/src/app/components/session/media-evidence-strip.tsx`
- Create: `packages/app/src/app/components/session/media-evidence-strip.test.ts`
- Modify: `packages/app/src/app/components/session/message-list.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Step 1: Write a lightweight source test for the UI contract**

Create `packages/app/src/app/components/session/media-evidence-strip.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./media-evidence-strip.tsx", import.meta.url), "utf8");
const messageList = readFileSync(new URL("./message-list.tsx", import.meta.url), "utf8");

test("media evidence strip exposes stable desktop e2e selectors", () => {
  assert.match(source, /data-testid="media-evidence-strip"/);
  assert.match(source, /data-testid="media-evidence-tile"/);
  assert.match(source, /data-testid="media-evidence-detail"/);
});

test("message list renders media evidence under timeline rows", () => {
  assert.match(messageList, /<MediaEvidenceStrip evidence=\{row\.mediaEvidence/);
});
```

Run it now and expect failure:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/media-evidence-strip.test.ts
```

**Step 2: Implement `MediaEvidenceStrip`**

Create `packages/app/src/app/components/session/media-evidence-strip.tsx`:

```tsx
import { For, Show, createMemo, createSignal } from "solid-js";
import { Download, ExternalLink, Image, X } from "lucide-solid";

import { currentLocale, t } from "../../../i18n";
import type { MediaEvidence } from "./media-evidence-model";

type Props = {
  evidence: MediaEvidence[];
};

const tr = (key: string) => t(key, currentLocale());

function labelFor(kind: MediaEvidence["kind"]) {
  return kind === "analyzed" ? tr("session.media_evidence_analyzed") : tr("session.media_evidence_created");
}

export default function MediaEvidenceStrip(props: Props) {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const visible = createMemo(() => props.evidence.slice(0, 3));
  const overflowCount = createMemo(() => Math.max(0, props.evidence.length - visible().length));
  const selected = createMemo(() => props.evidence.find((item) => item.id === selectedId()) ?? null);

  return (
    <Show when={props.evidence.length > 0}>
      <div data-testid="media-evidence-strip" class="mt-2 flex flex-wrap gap-2">
        <For each={visible()}>
          {(item) => (
            <button
              type="button"
              data-testid="media-evidence-tile"
              class="group w-[112px] overflow-hidden rounded-lg border border-gray-6 bg-gray-1 text-left shadow-sm transition-colors hover:border-blue-7"
              title={item.title}
              onClick={() => setSelectedId(item.id)}
            >
              <div class="h-16 w-full bg-gray-2">
                <Show
                  when={item.status === "available" && item.src}
                  fallback={<div class="flex h-full items-center justify-center text-gray-9"><Image size={18} /></div>}
                >
                  <img src={item.src} alt={item.title} class="h-full w-full object-cover" loading="lazy" />
                </Show>
              </div>
              <div class="space-y-1 px-2 py-1.5">
                <span class="inline-flex rounded-full bg-gray-3 px-1.5 py-0.5 text-[10px] font-medium uppercase text-gray-10">
                  {labelFor(item.kind)}
                </span>
                <div class="truncate text-[11px] text-gray-11">{item.title}</div>
              </div>
            </button>
          )}
        </For>
        <Show when={overflowCount() > 0}>
          <button
            type="button"
            data-testid="media-evidence-tile"
            class="flex h-[104px] w-[72px] items-center justify-center rounded-lg border border-gray-6 bg-gray-2 text-[13px] font-medium text-gray-11"
            onClick={() => setSelectedId(props.evidence[3]?.id ?? props.evidence[0]?.id ?? null)}
          >
            +{overflowCount()}
          </button>
        </Show>
      </div>

      <Show when={selected()}>
        {(item) => (
          <div data-testid="media-evidence-detail" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6" onClick={() => setSelectedId(null)}>
            <div class="max-h-full w-full max-w-4xl overflow-hidden rounded-xl border border-gray-6 bg-gray-1 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div class="flex items-center justify-between border-b border-gray-6 px-4 py-3">
                <div class="min-w-0">
                  <div class="truncate text-[14px] font-medium text-gray-12">{item().title}</div>
                  <div class="text-[12px] text-gray-9">{labelFor(item().kind)} - {item().mime} - {item().status}</div>
                </div>
                <button type="button" class="rounded-md p-1.5 text-gray-10 hover:bg-gray-3" onClick={() => setSelectedId(null)} aria-label={tr("session.media_evidence_close")}>
                  <X size={16} />
                </button>
              </div>
              <div class="max-h-[70vh] overflow-auto bg-gray-2 p-4">
                <Show
                  when={item().status === "available" && item().src}
                  fallback={<div class="flex h-48 items-center justify-center text-gray-9"><Image size={28} /></div>}
                >
                  <img src={item().src} alt={item().title} class="mx-auto max-h-[66vh] max-w-full rounded-lg object-contain" />
                </Show>
              </div>
              <div class="flex flex-wrap items-center gap-2 border-t border-gray-6 px-4 py-3 text-[12px] text-gray-10">
                <Show when={item().path}><span class="truncate font-mono">{item().path}</span></Show>
                <Show when={item().src}>
                  <a class="ml-auto inline-flex items-center gap-1 text-blue-11 hover:text-blue-10" href={item().src} download={item().title}>
                    <Download size={13} /> {tr("session.media_evidence_download")}
                  </a>
                  <a class="inline-flex items-center gap-1 text-blue-11 hover:text-blue-10" href={item().src} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} /> {tr("session.media_evidence_open")}
                  </a>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </Show>
  );
}
```

Keep the component compact. If TypeScript complains about `href` on `data:` URLs or `file:` URLs, keep download/open actions only for non-empty `src` and let the browser/Tauri policy handle the result.

**Step 3: Wire the strip into timeline rows**

In `message-list.tsx`:

- import `MediaEvidenceStrip`
- after the row badge/detail area, render the strip when the row has evidence

Expected shape:

```tsx
import MediaEvidenceStrip from "./media-evidence-strip";
```

Inside the timeline row body:

```tsx
<Show when={row.mediaEvidence?.length}>
  <MediaEvidenceStrip evidence={row.mediaEvidence ?? []} />
</Show>
```

**Step 4: Add labels**

Add keys to all locales:

```ts
"session.media_evidence_analyzed": "Analyzed",
"session.media_evidence_created": "Created",
"session.media_evidence_close": "Close image preview",
"session.media_evidence_download": "Download",
"session.media_evidence_open": "Open",
"session.media_evidence_image_created_one": "{count} image created",
"session.media_evidence_image_created_other": "{count} images created",
"session.media_evidence_image_analyzed_one": "{count} image analyzed",
"session.media_evidence_image_analyzed_other": "{count} images analyzed",
```

Use Czech and Chinese translations consistent with nearby locale style. If unsure, keep simple literal translations and run i18n parity.

**Step 5: Replace temporary summary strings with localized labels**

In `message-list.tsx` and/or `timeline-detail-model.ts`, use the new keys for media summary counts.

**Step 6: Run focused checks**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/media-evidence-strip.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/timeline-detail-model.test.ts
pnpm --filter @neatech/veslo-ui test:i18n
pnpm typecheck
```

Expected: all PASS.

**Step 7: Commit**

```bash
git add packages/app/src/app/components/session/media-evidence-strip.tsx packages/app/src/app/components/session/media-evidence-strip.test.ts packages/app/src/app/components/session/message-list.tsx packages/app/src/app/components/session/timeline-detail-model.ts packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts
git commit -m "feat(app): render media evidence in session timeline"
```

---

### Task 5: Desktop E2E Coverage For Timeline Media Evidence

**Files:**
- Create: `packages/e2e/specs/session-media-evidence.spec.ts`
- Reuse fixture: `packages/e2e/fixtures/attachment-staging-test.png`

**Step 1: Write failing E2E spec from the existing progress grouping pattern**

Create `packages/e2e/specs/session-media-evidence.spec.ts` by copying the SQLite seeding helpers from `packages/e2e/specs/session-progress-grouping.spec.ts`, then seed a session with:

- a user message containing a text part and an inline image `file` part
- an assistant tool part with `state.images`
- an assistant write tool part pointing at a created bitmap path
- a final assistant text part

Core parts fixture:

```ts
const imageDataUrl = `data:image/png;base64,${readFileSync(join(process.cwd(), "fixtures", "attachment-staging-test.png")).toString("base64")}`;

const parts = [
  {
    id: `${messageId("001-user")}-text`,
    messageId: messageId("001-user"),
    part: { type: "text", text: "Analyze this screenshot sentinel." },
  },
  {
    id: `${messageId("001-user")}-image`,
    messageId: messageId("001-user"),
    part: { type: "file", mime: "image/png", filename: "input-screenshot.png", url: imageDataUrl },
  },
  {
    id: `${messageId("002-tool-screenshot")}-part`,
    messageId: messageId("002-tool-screenshot"),
    part: {
      type: "tool",
      tool: "browser_screenshot",
      state: {
        status: "completed",
        images: [{ data: imageDataUrl.split(",")[1], mediaType: "image/png", alt: "Browser screenshot sentinel" }],
      },
    },
  },
  {
    id: `${messageId("003-tool-write")}-part`,
    messageId: messageId("003-tool-write"),
    part: {
      type: "tool",
      tool: "write",
      state: { status: "completed", input: { filePath: "screenshots/created-output.png" } },
    },
  },
  {
    id: `${messageId("004-final")}-part`,
    messageId: messageId("004-final"),
    part: { type: "text", text: "Media evidence final answer sentinel." },
  },
];
```

Create the bitmap file under the seeded workspace root before launching the route:

```ts
mkdirSync(join(activeWorkspaceRoot(), "screenshots"), { recursive: true });
writeFileSync(join(activeWorkspaceRoot(), "screenshots", "created-output.png"), readFileSync(join(process.cwd(), "fixtures", "attachment-staging-test.png")));
```

Test expectations:

```ts
await navigateToHash(`/session/${sessionId}`);
await waitForHashRoute(`#/session/${sessionId}`, WAIT_TIMEOUT_MS);

await browser.waitUntil(async () => (await browser.execute(() => document.body.innerText)).includes("Media evidence final answer sentinel."), {
  timeout: WAIT_TIMEOUT_MS,
  interval: 250,
  timeoutMsg: "Seeded media evidence session did not render.",
});

const groups = await $$('[data-testid="session-progress-group"]');
expect(groups.length).toBe(1);
const collapsedText = await groups[0]!.getText();
expect(collapsedText).toContain("image");
expect(collapsedText.toLowerCase()).toContain("analyzed");
expect(collapsedText.toLowerCase()).toContain("created");

await groups[0]!.$("button").click();
await browser.waitUntil(async () => (await $$('[data-testid="media-evidence-strip"]')).length > 0, {
  timeout: WAIT_TIMEOUT_MS,
  interval: 250,
  timeoutMsg: "Media evidence strip did not render after expanding progress.",
});

const tiles = await $$('[data-testid="media-evidence-tile"]');
expect(tiles.length).toBeGreaterThanOrEqual(2);
await tiles[0]!.click();
expect(await $('[data-testid="media-evidence-detail"]').isExisting()).toBe(true);
```

**Step 2: Run the E2E spec and verify it fails before UI wiring if you are still before Task 4**

If Task 4 is already complete, run it to verify it passes.

Use the desktop preflight first, then:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/session-media-evidence.spec.ts
```

Expected after Task 4: PASS. If the spec cannot run because SQLite is unavailable, it should call `this.skip()` like `session-progress-grouping.spec.ts`.

**Step 3: Commit**

```bash
git add packages/e2e/specs/session-media-evidence.spec.ts
git commit -m "test(e2e): cover session media evidence timeline"
```

---

### Task 6: Documentation And Final Verification

**Files:**
- Modify: `docs/features/session-runtime.md`
- Optional modify: `docs/dev/app-map.md` only if a new model file should be listed as a main source of truth

**Step 1: Update feature documentation**

Add a short section under session runtime message/progress behavior:

```markdown
## Timeline Media Evidence

The session timeline can show image evidence attached to the step or message where it mattered.

- `Analyzed` means the image was passed to a vision-capable model as image input.
- `Created` means a concrete action in the current run created or modified a bitmap image.
- Discovery-only file listing, globbing, and search do not create media evidence.
- Timeline media evidence is derived UI state. It is not a durable gallery and does not scan arbitrary workspace images.
```

**Step 2: Run app checks**

Run:

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
pnpm --filter @neatech/veslo-ui test:i18n
```

Expected: PASS.

**Step 3: Run desktop E2E**

Run desktop preflight first, then:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/session-media-evidence.spec.ts
```

Expected: PASS.

**Step 4: Commit docs**

```bash
git add docs/features/session-runtime.md docs/dev/app-map.md
git commit -m "docs: document timeline media evidence"
```

Only include `docs/dev/app-map.md` in the commit if you actually changed it.

**Step 5: Final review**

Run:

```bash
git status --short
git log --oneline -n 6
```

Expected:

- no unexpected modified files
- only intended commits for media evidence work

Use @verification-before-completion before claiming the implementation is complete.
