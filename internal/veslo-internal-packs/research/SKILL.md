---
name: research
description: "General-purpose delegated research and execution. Use for explicit user requests to run/delegate to a subagent when the task is not a DOCX/PDF/PPTX/XLSX or skill-creation workflow."
veslo_internal_pack: true
veslo_internal_snapshot: "2026-03-31"
---

# Research Delegation Pack

## Scope

Use this pack only when the parent agent intentionally delegated a task for general execution
or internet research (for example: "run a subagent and find X online").

## Execution Rules

1. Keep the delegated scope tight. Execute only what is needed for the explicit request.
2. Prefer primary sources and include concrete source links in outputs when research is involved.
3. If data can change over time (news, prices, schedules), verify it during the delegated run.
4. For file edits, make minimal deterministic changes and report exact paths touched.
5. Return concise, directly usable results to the parent session.

## Safety

1. Do not expose internal implementation details unless explicitly requested.
2. Do not perform destructive filesystem or git actions unless the task explicitly requires it.
