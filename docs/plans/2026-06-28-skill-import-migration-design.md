# Skill Import Migration Design

## Goal

Veslo should let users import skills they already have in other coding-agent
folders, including Codex, Claude Code, OpenCode, and legacy agent roots, without
making those foreign folders part of the runtime skill set.

Imported skills become Veslo-owned local skills. The original source folder is
only provenance for the import candidate and is never executed directly by
Veslo.

## User Experience

The Skills page exposes an import entry point named "Import from other agents".
This is separate from the removed setup panel and does not expose raw folder
management. Opening it shows an import view with candidate rows.

The user can:

- filter candidates by source agent
- search candidate names and descriptions
- filter by readiness, such as ready, needs review, invalid, or conflict
- select individual skills
- preview source metadata and warnings before import
- import the selected candidates in one action

There is no user-facing scope picker. Veslo decides the import target from the
candidate source:

- user-level source folders become Veslo user skills
- workspace-local source folders become skills in that workspace

Each row shows the resolved target as read-only context, for example "Codex -
User skill" or "Claude Code - This workspace". This keeps the user choice about
what to import and from which agent, while avoiding another scope decision.

## Candidate Discovery

The local Veslo server scans known foreign skill roots as import candidates,
not installed inventory. The first pass should include:

- Codex user skills, such as `~/.codex/skills`
- Codex workspace skills, such as `.codex/skills`
- Claude Code user skills, such as `~/.claude/skills`
- Claude Code workspace skills, such as `.claude/skills`
- OpenCode-compatible user roots already known to Veslo
- OpenCode-compatible workspace roots already known to Veslo

Candidates require a `SKILL.md` entry point. Veslo may detect one nested
category level when that matches existing local inventory behavior.

Discovery returns normalized metadata:

- candidate id
- source agent
- source path
- source location type, user-level or workspace-local
- resolved import target, user skill or workspace skill
- display name, description, trigger summary, and file count
- readiness status and warnings
- conflict status against existing Veslo-owned skills
- provenance that can be stored after import

## Import Semantics

Import copies the selected source folder into a Veslo-owned target. It never
links to, mounts, or executes the original folder.

User-level imports go through the Veslo user skill store, so the store remains
the source of truth and runtime copies are materialized later through the normal
`veslo-user` flow. Workspace-local imports copy into that workspace's
server-approved skill root.

Imported skills should keep source provenance metadata, including source agent,
source path, import time, and detected original name. This metadata is for
display, conflict handling, and auditability; it should not make runtime
execution depend on the old location.

Conflicts are explicit:

- if the target name is unused, import normally
- if a Veslo-owned skill with the same name already exists, require review
- if multiple candidates resolve to the same target name, group them as a
  conflict and require the user to choose or rename
- invalid candidates cannot be selected for bulk import

## Runtime Safety

Foreign-agent roots must not become active runtime roots just because Veslo can
discover them. The Skills inventory should show installed Veslo-local skills.
The import view should show foreign candidates.

OpenCode-compatible roots that Veslo already treats as legacy local installed
skills need special handling: they can remain visible in the existing inventory
where that is current behavior, but the migration UI should still copy them
into Veslo-owned storage when the user chooses to import them.

Any candidate with extra executable files, unusual structure, missing metadata,
or unsupported content should be marked "needs review" instead of silently
accepted as clean.

## Data Flow

1. The app requests import candidates from the local server.
2. The server scans approved user-level and workspace-local roots.
3. The app filters and selects candidates locally.
4. The app submits selected candidate ids to the server.
5. The server revalidates the selected candidates against the current
   filesystem.
6. The server copies each valid candidate into the automatic target.
7. User-skill imports update the user skill store. Workspace imports update the
   workspace skill root.
8. The app refreshes Skills inventory and materialization state.

The server owns scanning and copying. The UI owns presentation, filtering, and
selection state.

## Error Handling

The import action returns per-candidate results so partial success is visible.

Expected failures include:

- source folder disappeared
- source folder has no valid `SKILL.md`
- destination conflict
- destination is not writable
- workspace source no longer belongs to a known local workspace
- candidate is invalid or requires review but was submitted without review

The UI should keep successful imports selected only long enough to show the
result, then refresh into normal inventory. Failed candidates remain visible
with their reason.

## Testing

Prefer server-backed tests for discovery and import semantics, plus app tests
for filtering and selection. Add desktop E2E only if the final implementation
introduces desktop-only behavior.

Core coverage:

- Codex, Claude Code, and OpenCode candidate roots are detected
- user-level candidates resolve to user skills automatically
- workspace-local candidates resolve to workspace skills automatically
- source-agent filtering does not affect target resolution
- selected imports copy into Veslo-owned storage
- foreign source folders are not treated as runtime roots
- conflicts and invalid candidates block import with per-row feedback
- imported user skills participate in the existing materialization flow
