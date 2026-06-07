# Graphify Agent Workflow

Graphify is an optional developer and agent navigation aid for Veslo. The project can carry Graphify instructions and a generated code graph without requiring every contributor to install the CLI.

## Team Behavior

- The checked-in graph and instructions are safe for contributors who do not have Graphify installed.
- Agents should use Graphify only when the `graphify` command is available in PATH and `graphify-out/graph.json` exists.
- If Graphify is unavailable, agents must continue with normal repo reading, `rg`, and targeted file inspection.
- The Codex hook is best-effort and must not block shell commands when the CLI is missing.

## Local Setup

Install the CLI only if you want Graphify-assisted navigation locally:

```bash
uv tool install graphifyy
```

Then query the existing graph from the repo root:

```bash
graphify query "How is the desktop app connected to the server?"
graphify explain "startServer"
graphify path "desktop" "server"
```

## Updating The Graph

The initial Veslo graph is code-only. It excludes docs, screenshots, decks, and media until semantic extraction is explicitly enabled with Graphify subagents or an LLM backend.

After code changes, update the graph when the CLI is available:

```bash
graphify update .
```

Graph updates may leave `graphify-out/` dirty. Dirty graph output is expected after incremental updates and is not by itself a reason to skip Graphify.
