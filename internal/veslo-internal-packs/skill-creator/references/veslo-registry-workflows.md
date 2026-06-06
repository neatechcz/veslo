# Veslo Registry Workflows

Use this reference when creating, publishing, reviewing, installing, rolling out, removing, restoring, or materializing Veslo skills through the registry.

## Scope Vocabulary

Veslo has two related but separate concepts:

- Catalog ownership scope: who owns and governs the skill record.
- Runtime materialization target: where the package is written for execution.

For Veslo app/local proxy mutation helpers, use:

- User skill -> `scope: "user"`
- Workspace skill -> `scope: "workspace"`
- Organization skill -> `scope: "org"`
- Public skill -> `scope: "system"`

Registry responses may expose ownership as `personal`, `workspace`, `organization`, or `platform`. Rollout and materialization targets use `user-global` or `workspace`.

## Local Proxy Routes

The local Veslo server proxies registry reads and writes. Read routes require client auth. Mutation routes require host or owner auth plus registry context.

- `GET /v1/skills/search`
- `GET /v1/skill-registry-events`
- `POST /v1/skills`
- `POST /v1/skills/:skillId/versions`
- `GET /v1/skills/:skillId/versions`
- `POST /v1/skills/:skillId/review-requests`
- `POST /v1/skill-review-requests/:requestId/approve`
- `POST /v1/skill-review-requests/:requestId/reject`
- `POST /v1/skill-installations`
- `PATCH /v1/skill-installations/:installationId`
- `DELETE /v1/skill-installations/:installationId`
- `POST /v1/skill-installations/:installationId/restore`
- `GET /v1/skill-rollout-policies`
- `POST /v1/skill-rollout-policies`
- `PATCH /v1/skill-rollout-policies/:policyId`
- `DELETE /v1/skill-rollout-policies/:policyId`
- `PATCH /v1/workspaces/:workspaceId/skill-set`

Materialization routes are local server responsibilities:

- `GET /skills/materialization`
- `POST /skills/materialization/sync-global`
- `GET /workspace/:id/skills/materialization`
- `POST /workspace/:id/skills/materialization/sync`

## Create And Publish Sequence

1. Author the skill locally and validate it.
2. Build a skill package whose manifest has schema version 1, `SKILL.md` entrypoint, normalized file paths, file digests, metadata, and package digest.
3. Create the registry record with `POST /v1/skills`.
4. Publish an immutable package version with `POST /v1/skills/:skillId/versions`.
5. Continue according to the confirmed scope.

## User Skill

Use this for a skill owned by the signed-in user and available in the user's global skill root.

Typical sequence:

1. `POST /v1/skills` with `scope: "user"`.
2. `POST /v1/skills/:skillId/versions`.
3. `POST /v1/skill-installations` with `scope: "user"`, `skillId`, `versionId`, and optional `ownerUserId`.
4. `POST /skills/materialization/sync-global` when the local runtime should download and write server-controlled user skill files.

Do not overwrite user-authored local skill directories unless the user explicitly chooses the registry-backed target.

## Workspace Skill

Use this for a selected workspace.

Typical sequence:

1. Author under the workspace skill root when the user wants immediate local use.
2. `POST /v1/skills` with `scope: "workspace"` and `workspaceId` when publishing to registry.
3. `POST /v1/skills/:skillId/versions`.
4. Use either `POST /v1/skill-installations` with `scope: "workspace"` and `workspaceId`, or `PATCH /v1/workspaces/:workspaceId/skill-set` when replacing the desired registry-backed set.
5. `POST /workspace/:id/skills/materialization/sync` when the local runtime should download and write server-controlled workspace skill files.

Managed workspace packages materialize under `.opencode/skills/veslo-managed/`.

## Organization Skill

Use this for a skill governed by an organization catalog.

Typical sequence:

1. Author and validate locally.
2. `POST /v1/skills` with `scope: "org"` and `orgId`.
3. `POST /v1/skills/:skillId/versions`.
4. `POST /v1/skills/:skillId/review-requests` with `scope: "org"`, `versionId`, and optional `reason`.
5. Stop and report pending organization approval unless an authorized org skill admin approves it.
6. After approval, an authorized admin may create installations or rollout policies.

Do not describe this as installed, distributed, or available to the organization until approval and rollout or installation have happened.

## Public Skill

Use this for a platform/public catalog skill.

Typical sequence:

1. Author and validate locally.
2. `POST /v1/skills` with `scope: "system"`.
3. `POST /v1/skills/:skillId/versions`.
4. `POST /v1/skills/:skillId/review-requests` with `scope: "system"`, `versionId`, and optional `reason`.
5. Stop and report pending platform approval unless an authorized platform admin approves it.
6. After approval, an authorized platform admin may create rollout policies for `user-global` or `workspace` targets.

Public skills that normal users must not change should be represented by registry governance and rollout policy, not by local file permissions alone. Use `removalPolicy: "locked"` only in an approved rollout policy for a required skill.

Example rollout policy body:

```json
{
  "skillId": "skill_demo",
  "versionId": "version_demo_1",
  "target": "workspace",
  "audience": "all-platform-users",
  "catalogScope": "platform",
  "enabled": true,
  "updatePolicy": "latest_approved",
  "removalPolicy": "locked"
}
```

## Safety Rules

- Do not claim organization or public skills are distributed when only a registry record, package version, or review request exists.
- Do not bypass review by installing organization or public skills as if they were local user/workspace skills.
- Do not directly delete server-controlled managed files for registry removals. Delete or restore the registry installation, or disable or re-enable the rollout policy.
- Active runs should produce pending materialization rather than mutating files underneath an executing session.
- If both user-global and workspace targets are active for the same effective skill and audience, report the target conflict and avoid materializing both.
