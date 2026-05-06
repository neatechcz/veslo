---
name: release
description: Use when the user asks for a Veslo app release, release notes, updater publication, beta release, production release, GitHub Release verification, or public veslo-updates handoff.
---

# Release Flow

This is a compatibility entry point for generic release prompts. For Veslo app releases, read and follow `.opencode/skills/veslo-release/SKILL.md`.

Do not use historical OpenWork or `different-ai/openwork` release commands in this repository.

At minimum, resolve beta vs production, generate public-safe notes from real git changes, use `pnpm release:review`, `pnpm release:prepare`, and `pnpm release:ship` for production, then verify both `neatechcz/veslo` and `neatechcz/veslo-updates`.
