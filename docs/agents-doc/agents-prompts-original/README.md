# OpenCode engine — nativní prompty agentů

Staženo 2026-03-26 z `anomalyco/opencode` (GitHub), větev main.
Zdroj: `packages/opencode/src/session/prompt/` a `packages/opencode/src/agent/`.

## System prompty (provider-specific)

Výběr podle model ID v `system-prompt-selector.ts`:

| Soubor | Kdy se použije | Velikost |
|--------|---------------|----------|
| `system-anthropic.txt` | Model ID obsahuje `claude` | 8 KB |
| `system-beast.txt` | Model ID obsahuje `gpt-4`, `o1`, `o3` | 11 KB |
| `system-codex.txt` | Model ID obsahuje `gpt` (ostatní) | 7 KB |
| `system-gemini.txt` | Model ID obsahuje `gemini-` | 15 KB |
| `system-trinity.txt` | Model ID obsahuje `trinity` | 8 KB |
| `system-default.txt` | Fallback pro nerozpoznané modely | 9 KB |

## Mode-specific prompty

| Soubor | Kdy se použije |
|--------|---------------|
| `plan.txt` | Přidáno k system promptu v Plan módu (read-only instrukce) |
| `plan-reminder-anthropic.txt` | Rozšířený plan prompt pro Anthropic modely (Phase 1-5 workflow) |
| `build-switch.txt` | Injektováno při přechodu z Plan do Build módu |
| `max-steps.txt` | Injektováno při dosažení max kroků agenta (tools disabled) |

## Agent prompty

| Soubor | Agent | Účel |
|--------|-------|------|
| `agent-explore.txt` | `explore` (subagent) | Codebase průzkum — glob, grep, read |
| `agent-compaction.txt` | `compaction` (hidden) | Kompakce kontextu při overflow |
| `agent-summary.txt` | `summary` (hidden) | Sumarizace sessions |
| `agent-title.txt` | `title` (hidden) | Generování titulků sessions |
| `agent-generate.txt` | — | Prompt pro generování nových agentů |

## Zdrojový kód

| Soubor | Obsah |
|--------|-------|
| `agent-definitions.ts` | Definice všech nativních agentů (permissions, mode, temperature) |
| `system-prompt-selector.ts` | Logika výběru system promptu podle modelu + environment/skills injection |
