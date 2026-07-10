# Release Skill

Veslo keeps the release skill in the repository so release agents use the same process as the project documentation and scripts.

## Locations

- `.opencode/skills/veslo-release/SKILL.md` is the Codex/OpenAI-compatible skill package for repo-local use. It also includes `agents/openai.yaml` UI metadata.
- `.claude/skills/veslo-release/SKILL.md` is the Claude Code project skill.
- `.opencode/skills/release/SKILL.md` is a compatibility wrapper for older generic release prompts and should point to `veslo-release`.

Keep the two `veslo-release` `SKILL.md` files functionally identical when changing the release process.

## Required Behavior

The skill must:

- resolve whether the user wants beta or production before mutating release state, unless the prompt already makes that explicit;
- use the private Veslo repository as the source of truth;
- treat `neatechcz/veslo-updates` as the public updater target, not a required local checkout;
- generate release notes from real git changes and keep them public-safe;
- use the repository release scripts and `RELEASE.md` instead of hand-written version/tag steps;
- verify both the source release and the public updater release before calling a production release complete.
- require macOS certificate signing for every distributed macOS build. Every distributed macOS build must be signed with the Apple Developer ID Application certificate. Do not use `allow_unsigned_macos=true` or `ALLOW_UNSIGNED_MACOS=true` for production, beta, prerelease, staging, or tester-distributed macOS builds.
- require notarization and stapling for every distributed macOS release. Every distributed macOS release must be notarized and stapled before upload. Do not ship signed-only macOS builds.
- verify the expected certificate identity, `Developer ID Application: Neatech s.r.o. (D7XT3SG9WA)`, with `codesign --verify --deep --strict --verbose=2` for the `.app` and `codesign --verify --verbose=2` for the `.dmg`, then verify notarization with `xcrun stapler validate`.
- require Windows Artifact Signing metadata to keep `AzureCliCredential` as the only credential provider by listing every other provider in `ExcludeCredentials`.
- require a real Artifact Signing executable preflight before each Windows desktop bundle, a 120-second per-attempt timeout, at most two attempts, and a correlation ID that includes the GitHub run attempt.
- treat `Submitting digest for signing...` without an `OperationId` as an upstream signing-request stall and retain the run timestamps and correlation ID for `SignTransactions` diagnostics.

## Local Installation

Project-aware agents can use the committed skill in place. If a local agent runtime only reads personal skills, install from the matching repository directory into that runtime's configured skills directory, then keep the repository copy as the source of truth.
