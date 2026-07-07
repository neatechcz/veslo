---
name: release
description: Use when the user asks for a Veslo app release, release notes, updater publication, beta release, production release, GitHub Release verification, or public veslo-updates handoff.
---

# Release Flow

This is a compatibility entry point for generic release prompts. For Veslo app releases, read and follow `.opencode/skills/veslo-release/SKILL.md`.

Do not use historical OpenWork or `different-ai/openwork` release commands in this repository.

At minimum, resolve beta vs production, generate public-safe notes from real git changes, use `pnpm release:review`, `pnpm release:prepare`, and `pnpm release:ship` for production, then verify both `neatechcz/veslo` and `neatechcz/veslo-updates`.

Every distributed macOS build must be signed with the Apple Developer ID Application certificate. Do not use `allow_unsigned_macos=true` or `ALLOW_UNSIGNED_MACOS=true` for production, beta, prerelease, staging, or tester-distributed macOS builds. Every distributed macOS release must be notarized and stapled before upload. Do not ship signed-only macOS builds. Verify the expected certificate identity, `Developer ID Application: Neatech s.r.o. (D7XT3SG9WA)`, with `codesign --verify --deep --strict --verbose=2` for the `.app` and `codesign --verify --verbose=2` for the `.dmg`, then verify notarization with `xcrun stapler validate`.
