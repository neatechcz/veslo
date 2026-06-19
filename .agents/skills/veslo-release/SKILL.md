---
name: veslo-release
description: Use when preparing, shipping, verifying, or writing release notes for Veslo beta releases, production releases, app updates, desktop updater releases, public Veslo updates, GitHub Releases, CalVer tags, or Veslo release handoff to the public veslo-updates repository.
---

# Veslo Release

## Overview

Run Veslo releases from the private Veslo repository as the source of truth. Produce public-safe release notes from real git changes, then use the repository release scripts and GitHub workflows to publish the desktop app and mirror public updater artifacts to `neatechcz/veslo-updates`.

This skill is repo-local. For Codex/OpenAI-compatible surfaces, use this `.opencode/skills/veslo-release` package and its `agents/openai.yaml` metadata. For Codex, keep the matching `.Codex/skills/veslo-release/SKILL.md` copy in sync.

## Release Decision

Resolve the release type before doing mutating work:
- If the user explicitly asked for beta/prerelease, continue as beta and state that assumption.
- If the user explicitly asked for production/stable/real release, continue as production and state that assumption.
- Otherwise ask one concise question: beta release or production release?

Never treat `veslo-updates` as a required local checkout. It is the public release target, not the authoritative development workspace.

## Repository Ground Rules

Work from the Veslo repository root, identified by `RELEASE.md`, `AGENTS.md`, and `packages/desktop`.

Before release commands:
- Read `RELEASE.md` and prefer the repo release scripts over hand-written release steps.
- Check branch, remotes, tags, and `git status --short`.
- Do not overwrite, stash, reset, or discard user changes.
- If the tree is dirty, inspect enough to explain the risk. Do not run production release preparation until the dirty tree is intentionally committed or the user explicitly pauses those changes outside the release.
- For desktop app behavior, the Tauri desktop app is the runtime under test. Do not use `packages/web` or UI-only web servers as release verification.

Public update invariant:
- The private Veslo repository produces the release.
- The public updater repo defaults to `neatechcz/veslo-updates`.
- Public desktop assets are mirrored by the release workflow/script, including `latest.json`.
- Required public publishing credentials live in GitHub Actions secrets/variables, not in local files.
- Do not put secrets, local paths, private repo URLs, branch names, CI implementation details, or internal debugging notes into public release notes.

## Public Release Notes

Generate notes from real changes, not memory. Use a range from the previous stable CalVer app tag to the release commit, ignoring development SHA prerelease tags and component-only tags.

Useful commands:

```bash
git tag --list 'v[0-9][0-9][0-9][0-9].[0-9]*.[0-9]*' --sort=-v:refname | head -10
git log --oneline --decorate <previous-tag>..HEAD
git diff --stat <previous-tag>..HEAD
```

Write notes for users:
- Mention observable fixes, reliability improvements, installer/update behavior, and user-facing workflow changes.
- Use plain product language. Avoid implementation names unless they are visible product concepts.
- Separate major items into short bullets under headings such as `What's Changed`, `Fixes`, and `Update Notes`.
- Exclude internal issue IDs unless public, private customer details, auth/secrets, local filesystem paths, hidden repo names, exact branch names, raw commit hashes, private CI details, and agent/session transcripts.
- Do not claim a fix unless git history or tests support it.
- If a change is only internal maintenance with no user-visible effect, omit it or summarize as stability/performance only when justified.

Keep private technical notes separately in working notes if needed, but only pass public-safe text to GitHub Releases.

## Production Release Workflow

Use this path for stable releases:

1. Confirm the working tree is intentionally clean or intentionally committed.
2. Sync `main` with origin according to `RELEASE.md`.
3. Run preflight review:

```bash
pnpm release:review
```

4. Prepare the CalVer release with the repo script:

```bash
pnpm release:prepare
```

This bumps versions, runs strict release review, commits, and tags locally.

5. Use the generated tag to create or update GitHub Release notes. Prefer workflow dispatch with explicit public notes when the default tag-triggered body would be too generic. If using tag push, edit the private Veslo GitHub Release after the workflow creates it, then edit the public `neatechcz/veslo-updates` release after mirroring creates it. The tag-triggered workflow body defaults to a generic placeholder, so do not leave either release with placeholder notes.
6. Ship only after the local tag and release notes plan are clear:

```bash
pnpm release:ship
```

7. Verify:

```bash
gh run list --repo neatechcz/veslo --workflow "Release App" --limit 5
gh release view <tag> --repo neatechcz/veslo
gh release view <tag> --repo neatechcz/veslo-updates
```

8. Confirm the public release is not left as draft and that `latest.json` is present in the public release for production.

## Beta Release Workflow

Use beta when the user wants a prerelease/internal validation build instead of the stable updater path.
- Prefer the repository's existing prerelease workflow for branch/SHA prereleases when that matches the request.
- If using the production workflow manually for a beta-style release, set the GitHub Release as prerelease and do not mark it latest.
- Make release notes public-safe, but label the release as beta/prerelease and describe expected validation scope.
- Do not publish a beta as the production latest update unless the user explicitly asks and the workflow supports that safely.

## Failure Handling

- If release review fails, stop and fix or report the exact failing release checks.
- If GitHub Actions cannot mirror to `neatechcz/veslo-updates`, check for missing `RELEASE_UPDATES_GH_TOKEN`/`VESLO_UPDATES_GH_TOKEN` or repo permissions.
- If `latest.json` is missing, do not call the production release complete.
- If notarization/signing fails, treat the release as blocked until signed artifacts are available or the user explicitly chooses an unsigned beta.
- If npm publishing is skipped because credentials are missing, report it separately from desktop release status.
