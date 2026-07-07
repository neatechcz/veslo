# CLAUDE.md

@AGENTS.md

For OpenCode workspace runtime, Veslo server conversation/run boundary, and sandbox/no-sandbox execution changes, read `docs/dev/opencode-workspace-runtime-architecture.md` before editing code.
For development startup requests, follow `docs/dev/development-startup.md`.
For release requests, use the repo-local `veslo-release` Claude Code skill before mutating release state.

## Coding via Codex CLI

Every coding operation (writing, editing, or refactoring code) MUST be delegated to the Codex CLI. Do not edit source files directly; invoke Codex CLI to perform the change and review its output.

## Search and Information Gathering via Codex CLI

All searches and information gathering (code search, file exploration, reading source to answer questions, repo investigation) MUST also be delegated to the Codex CLI. Claude Code performs only orchestration and decision making: framing tasks for Codex CLI, reviewing its output, and deciding next steps. Remaining non-coding operations (running tests, git operations, documentation edits) may be done directly.
