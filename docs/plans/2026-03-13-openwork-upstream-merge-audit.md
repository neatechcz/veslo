# Openwork Upstream Merge Audit (2026-03-13)

## Scope
- Target fork: `origin/main` (`444c9d5d`)
- Upstream baseline: `upstream/dev` (`a0a79788`)
- Common ancestor: `dba19b5e`
- Analysis branch: `codex/upstream-merge-audit-20260313`
- Analysis worktree: `.worktrees/codex/upstream-merge-audit`

## Reality Check
- Divergence: `main...upstream/dev` = `78` local commits vs `144` upstream commits.
- Upstream changed files since divergence: `359`.
- Full merge dry-run conflicts: `80` files.
- Conclusion: **do not do a blanket merge**. Use selective import by feature area.

## Merge Decision Matrix (Visible Product Surfaces)

| Function | Upstream commit(s) | What it changes | Decision |
|---|---|---|---|
| Fix automations URL on scheduled page | `c4a16167` | Corrects automation link target in scheduler UI. | **MERGE** |
| Settings copy/link correction | `72078491` | Small settings text/link correction. | **MERGE** |
| Theme-aware colors in identities/scheduled | `276eb4af` | Removes hardcoded colors for better theme compatibility. | **MERGE** |
| Provider disconnect from settings | `15bf1a3f` | Adds explicit disconnect flow in settings. | **MERGE (manual adapt)** |
| Provider OAuth polling reliability | `222ba9d3` | Hardens provider auth polling and status handling. | **MERGE (manual adapt)** |
| Model picker provider sectioning | `b6737e6b` | Corrects provider grouping/sections in model picker. | **MERGE (manual adapt)** |
| MCP auth flow stabilization | `dd44dc63` | Stabilizes auth handoff and post-auth state updates. | **MERGE (manual adapt)** |
| Shared bundle imports via blueprints | `091e57f6` | Routes imported shared bundles to blueprint flow. | **MERGE (manual adapt)** |
| Shared bundle import target correctness | `53ba8cce` | Ensures imported bundle lands on created worker target. | **MERGE (manual adapt)** |
| User-friendly 413 errors | `d44e627d` | Converts raw 413 failures into actionable user message. | **MERGE** |
| Markdown `<strong>/<em>` explicit styles | `50840499` | Adds deterministic markdown emphasis styling in chat. | **MERGE** |
| Prevent raw markdown flash while streaming | `4ec2eb03` | Avoids transient unrendered markdown in streaming UI. | **MERGE** |
| Dock todo strip to composer | `87aa2560` | Keeps todo strip anchored to composer. | **MERGE** |
| Keep app/worker opens on new session screen | `a2f5d1df` | Prevents navigation away from new-session screen at wrong time. | **MERGE (manual adapt)** |
| Inline session errors in chat timeline | `660aa7ac` | Surfaces session-level failures as visible chat turns. | **MERGE (manual adapt)** |
| Keep workspace shell navigation reachable | `85d3b32c` | Improves shell layout so nav controls stay reachable. | **MERGE (manual adapt)** |
| Skill sharing + hot-reload reliability | `5e67502b` | Tightens sharing flow and hot-reload behavior. | **MERGE (manual adapt)** |
| Browser quickstart defaults to Chrome MCP | `8db0222a` | Prioritizes Chrome MCP in quickstart command path. | **MERGE** |
| Seed Control Chrome as `chrome-devtools` | `9785a73a` | Fixes MCP seed alias to expected chrome-devtools id. | **MERGE** |
| Isolate OpenCode dev state | `13d79aee` | Separates dev runtime state between app and OpenCode. | **DEFER (phase 2 manual adapt)** |
| Prevent Docker preflight hangs | `73862d9d` | Adds timeout + stage handling for orchestrator preflight. | **MERGE** |
| Add stage diagnostics to timeout errors | `a8ad72da` | Improves timeout error detail for debugging startup. | **MERGE** |
| Improve sandbox startup diagnostics | `9be0e66d` | Adds better surfacing of startup stage and diagnostics. | **MERGE (manual adapt)** |
| Fully clear reset state on relaunch | `ef95a95d` | Ensures reset clears stale local state before relaunch. | **MERGE (manual adapt)** |
| Fail fast on missing Linux deps | `dc484b67` | Early failure with explicit missing dependency checks. | **MERGE** |
| UTF-8 skill description truncation fix | `0b4f92f2` | Prevents truncation/corruption in non-ASCII skill descriptions. | **MERGE** |
| Add Vietnamese locale | `b1461d50` | Adds `vi` translations and locale registration. | **SKIP (optional product choice)** |
| Local-file-path declaration | `961b092f` | Adds TS declaration for local file path shim. | **SKIP (already covered in fork)** |
| Session-loss fix + later revert | `ab2a20cd`, `85cddda7` | Temporary fix was reverted upstream. | **SKIP (no net upstream state)** |
| Starter-task empty-state + later revert | `ea5d6f19`, `4bf25d5d` | Experiment rolled back upstream. | **SKIP (no net upstream state)** |
| Unified status-bar revert | `f4211e31` | Reverts earlier status indicator work. | **SKIP** |
| Remove soul mode surfaces | `6496d1cc` | Deletes soul pages/commands/state. | **SKIP (conflicts with fork custom surfaces)** |

## Merge Decision Matrix (Not Visible in Current Veslo Surface)

| Function group | Upstream commit(s) | Decision |
|---|---|---|
| Landing redesign/content/visual churn | Multiple `packages/landing` commits | **SKIP** |
| Openwork branding/icons/logos | `30404b2b`, `91d5d563`, `f9fbbda4`, `365a08a6`, related assets | **SKIP** |
| OpenWork Share replatform/restyle/Next migration | `22988731`, `4dc7a6e9`, `44ab1018`, `c8c0ec9d`, `6516a8db`, related | **SKIP** (unless actively shipping share service) |
| Den cloud-control CTA/copy and pricing tweaks | `6d35b7b1`, `c7ccb734`, `51f25e3a`, `7794fa95`, related | **SKIP** |
| Den admin backoffice + allowlist | `ca2dbe3a`, `121c56b3`, `a0a79788` | **SKIP** |
| Web auth callback domain change | `3a3e4afe` | **DEFER** (only if your auth domain architecture matches) |
| Google signup on Den web | `d70f0348` | **SKIP** |
| Local Den web dev stack | `f96b50a1` | **SKIP** |
| Version bumps, AUR, download stats, workflow churn | many `chore:*` + metrics/stat commits | **SKIP** |
| Evidence/PR/docs cleanup from upstream repo shape | deletes/moves in `pr/`, `evidence/` | **SKIP** |

## Recommended Execution Order

### Phase 1: Low-risk direct cherry-picks
Use direct cherry-picks first for low-conflict, visible reliability fixes:

```bash
git cherry-pick -x c4a16167 72078491 276eb4af d44e627d 50840499 4ec2eb03 87aa2560 8db0222a 9785a73a 73862d9d a8ad72da dc484b67 0b4f92f2
```

### Phase 2: Manual ports (high-value, high-conflict)
Manually port behavior from these commits into Veslo-renamed files and local UX architecture:

- `15bf1a3f`, `222ba9d3`, `b6737e6b`, `dd44dc63`
- `a2f5d1df`, `660aa7ac`, `85d3b32c`, `5e67502b`
- `091e57f6`, `53ba8cce`, `9be0e66d`, `ef95a95d`
- `13d79aee` (optional phase 2b)

### Phase 3: Verification gate
After each phase run:

```bash
pnpm test:health
pnpm test:sessions
pnpm test:permissions
pnpm test:session-switch
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo build
```

For desktop/runtime diagnostics changes, also run:

```bash
pnpm --filter @neatech/veslo test:health
pnpm --filter @neatech/veslo exec tauri --version
```

## Why this strategy
- A full merge currently collides with Veslo-specific rebrand, cloud/local policy changes, sidebar/session UX customizations, and service split decisions.
- Selective import keeps your differentiated behavior while still pulling in upstream reliability fixes that users can actually see.
- This gives a deterministic path with bounded risk and clear rollback points.
