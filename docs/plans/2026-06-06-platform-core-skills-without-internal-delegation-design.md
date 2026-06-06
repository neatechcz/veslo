# Platform Core Skills Without Internal Delegation Design

Date: 2026-06-06

## Goal

Remove Veslo's special internal delegation runtime for document workflows and
skill authoring. The DOCX, PDF, PPTX, XLSX, skill-creator, and related core
workflow capabilities should become normal platform-wide read-only or locked
skills distributed through the standard skill registry and materialization
pipeline.

After this change, these capabilities are available only after sign-in and
successful registry-backed materialization, just like any other platform skill.

## Current Behavior

Veslo currently provisions an internal system into each workspace:

- internal workflow packs under `.opencode/veslo/internal/`
- hidden `veslo-internal-*` subagent definitions under `.opencode/agents/`
- a `delegate` plugin under `.opencode/plugins/`
- managed prompt blocks that tell the main agent to route document, skill, and
  explicit delegation requests through `delegate`

The plugin creates child sessions and invokes hidden subagents for specialized
work. This makes document and skill-creation work different from standard
skills in distribution, UI visibility, session timeline behavior, and failure
modes.

## Decision

Delete the internal delegation layer as product behavior.

The core workflows should be packaged as platform skills and distributed through
platform rollout policies. The main agent should use them through the same skill
mechanism it uses for every other installed skill.

This explicitly removes:

- internal workflow pack provisioning
- hidden internal subagent definitions
- the `delegate` plugin and forced-routing transforms
- child sessions for document and skill-creator work
- special tool-permission isolation for these workflows
- bundled offline fallback behavior for these capabilities

## Product Semantics

Core platform skills should be treated as standard managed skill inventory
items:

- catalog scope: platform/system
- rollout target: user-global, unless a later product decision chooses
  workspace-targeted rollout for a specific skill
- removal policy: locked for required core capabilities, or admin-removable if
  the platform wants users to see them as managed but not required
- local materialization: server-controlled `veslo-managed` skill root
- local editing: unavailable through normal user/workspace skill editing flows

The skills are not present in unsigned-out or fresh-offline runtime state. The
app can explain that platform skills sync after sign-in, but it should not
silently fall back to internal copies.

## Skill Package Shape

Each former internal pack becomes a normal skill package:

- `veslo-docx`
- `veslo-pdf`
- `veslo-pptx`
- `veslo-xlsx`
- `skill-creator`
- optional `veslo-research` only if the product still wants a general research
  skill after removing explicit subagent delegation

Each package keeps `SKILL.md` as the entrypoint and may include `scripts/`,
`references/`, and `assets/` as needed. The existing internal pack content can
be migrated, but package metadata must be rewritten so triggers are suitable for
normal skill invocation rather than hidden subagent execution.

Skill descriptions and triggers become the routing surface. They should be
specific enough to avoid broad false positives such as any mention of the word
"skill" forcing skill-creator behavior.

## Runtime Flow

On sign-in and registry sync:

1. The local server resolves matching platform rollout policies.
2. The local server downloads and validates package archives.
3. The local server materializes packages into the server-controlled managed
   skill root.
4. The app reloads or marks the workspace as requiring reload according to the
   existing skill materialization contract.
5. OpenCode discovers the managed skills as ordinary runtime skills.

During a user request, the main agent sees the standard skill list and uses the
matching skill directly. Work happens in the current session. No child session is
created for these workflows.

## Provisioning Changes

Workspace provisioning should stop writing internal delegation artifacts:

- do not copy or symlink `internal/veslo-internal-packs` into workspaces
- do not write `veslo-internal-*.md` agent files
- do not write `.opencode/plugins/veslo-delegate.js`
- do not append managed delegation instructions to `.opencode/agents/veslo.md`

The provisioning path may still write unrelated Veslo instructions that are not
about delegation, but the instructions must not claim that document or skill
requests are handled through `delegate`.

## Migration And Cleanup

Existing workspaces may already contain old internal artifacts. On upgrade,
Veslo should remove only artifacts it can identify as managed internal
delegation output:

- `.opencode/veslo/internal/manifest.json` with the internal system source or
  version metadata
- `.opencode/veslo/internal/<pack>` directories or symlinks named in that
  manifest
- managed `veslo-internal-*.md` agent files
- managed `veslo-delegate.js`
- managed routing blocks in `.opencode/agents/veslo.md`

Cleanup must not delete user-authored files that only happen to use similar
names. If ownership is ambiguous, leave the file in place and stop referencing
it from the normal runtime.

## Registry Bootstrap

The platform registry must contain approved package versions and rollout
policies before the app-side removal ships broadly. Otherwise signed-in users
will lose the existing document and skill-creator workflows.

Release sequencing:

1. Publish platform package versions for the migrated core skills.
2. Create platform rollout policies for the intended audience.
3. Verify materialization into `veslo-managed` roots after sign-in.
4. Ship the runtime cleanup that removes internal delegation.

## Error Handling

If platform skill sync fails, the app should surface normal registry or
materialization errors. It should not use internal fallback copies.

If a user asks for DOCX/PDF/PPTX/XLSX or skill-creator work before platform
skills are materialized, the agent may answer that the relevant platform skill is
not installed yet or ask the user to sign in/sync skills. The app should prefer a
clear skill-sync status over hidden runtime behavior.

## Testing Strategy

Prefer desktop E2E tests for user-visible behavior and focused server tests for
materialization and cleanup.

Server tests:

- provisioning no longer writes internal packs, internal agents, or delegate
  plugin artifacts
- cleanup removes managed internal delegation artifacts and preserves ambiguous
  user-owned files
- managed routing blocks are removed or rewritten without delegation language
- platform rollout materializes core skill packages into `veslo-managed`

App/runtime tests:

- signed-in skill sync shows core skills as managed read-only or locked skills
- document and skill-creator prompts use ordinary skill invocation, not
  `delegate`
- session timeline shows skill usage in the parent session and no internal
  subagent child session
- unsigned-out or pre-sync state does not expose bundled internal core skills

Regression tests:

- no remaining `delegate` tool appears in the OpenCode tool list after cleanup
- old workspaces with managed internal artifacts upgrade cleanly
- existing registry-managed skills continue to materialize and remain read-only
  as before

## Non-Goals

- Keep hidden subagent isolation for these workflows.
- Keep bundled offline fallback copies of the core workflow skills.
- Build a separate runtime for platform skills.
- Change the general registry package, review, or rollout policy model beyond
  what is needed to publish these core packages.
