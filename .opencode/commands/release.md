---
description: Run the Veslo release flow
---

You are running the Veslo release flow in this repo.

Arguments: `$ARGUMENTS`
- If empty, resolve whether this is beta or production before mutating release state.
- If set to `beta`, use the beta/prerelease path.
- If set to `production`, `prod`, or `stable`, use the production path.

Do the following, in order, and stop on any failure:

1. Read `.opencode/skills/veslo-release/SKILL.md` and `RELEASE.md`.
2. Check branch, remotes, tags, and dirty state without discarding user changes.
3. Generate public-safe release notes from real git changes since the previous stable app tag.
4. For production, run `pnpm release:review`, then `pnpm release:prepare`, then `pnpm release:ship`.
5. For beta, use the repository prerelease path and keep the release marked prerelease unless the user explicitly asks otherwise.
6. Watch or inspect the Release App GitHub Actions workflow.
7. Verify the source release in `neatechcz/veslo`.
8. Verify the public updater release in `neatechcz/veslo-updates`, including `latest.json` for production.

Report the release type, tag, public-safe notes status, source release status, public updater release status, and any skipped publishing jobs.
