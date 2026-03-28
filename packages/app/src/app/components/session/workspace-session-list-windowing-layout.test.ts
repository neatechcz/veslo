import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./workspace-session-list.tsx", import.meta.url), "utf8");

test("workspace session list accepts paging metadata + load-more callback props", () => {
  assert.match(
    source,
    /workspaceSessionPagingById\?: Record<string, \{ hasMore: boolean; loadingMore: boolean \}>;/,
    "WorkspaceSessionList should accept per-workspace paging metadata",
  );

  assert.match(
    source,
    /onLoadMoreWorkspaceSessions\?: \(workspaceId: string\) => Promise<boolean> \| boolean \| Promise<void> \| void;/,
    "WorkspaceSessionList should accept callback for incremental sidebar loading",
  );
});

test("by-project mode uses per-project visible window with default 7 rows", () => {
  assert.match(
    source,
    /PROJECT_VISIBLE_DEFAULT/,
    "by-project rendering should be driven by shared default window constant",
  );

  assert.match(
    source,
    /project\.sessions\.slice\(0, visibleCount\(\)\)/,
    "by-project rows should render only the visible window slice",
  );
});

test("by-project mode renders project-level load more controls", () => {
  assert.match(
    source,
    /tr\("sidebar\.load_more"\)/,
    "project list should render localized load-more label",
  );

  assert.match(
    source,
    /tr\("sidebar\.more_ellipsis"\)/,
    "project list should expose ellipsis affordance before the load-more action",
  );
});

test("recent mode has sentinel + fallback load more button", () => {
  assert.match(
    source,
    /recentSentinelRef/,
    "recent mode should expose a sentinel target for infinite loading",
  );

  assert.match(
    source,
    /props\.onLoadMoreWorkspaceSessions\(workspaceId\)/,
    "recent mode should invoke load-more callback when local rows are exhausted",
  );
});
