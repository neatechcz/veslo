# OpenCode SDK, Plugin, And MCP Contract Snapshot

Date: 2026-07-06

Plan task: OSDKMCP01 in
`docs/plans/2026-07-06-opencode-sdk-plugins-mcp-implementation-plan.md`.

## Source Priority

Use this order when sources disagree:

1. Installed package `.d.ts` files in this checkout.
2. Veslo call sites and parser behavior in this checkout.
3. Context7 current OpenCode docs.
4. Context7 v2 proposal docs, only as upgrade-spike input.

Do not migrate runtime config only because the v2 proposal uses a newer key.

## Baseline Versions

Installed in Veslo before OSDKMCP08:

| Package surface | Version |
| --- | --- |
| `packages/app` `@opencode-ai/sdk` | `1.17.4` |
| `packages/opencode-router` `@opencode-ai/sdk` | `1.17.4` |
| `packages/orchestrator` `@opencode-ai/sdk` | `1.17.4` |
| `packages/orchestrator` `@opencode-ai/plugin` | `1.17.4` |
| `packages/orchestrator` `opencodeVersion` | `1.17.4` |
| `packages/desktop` `opencodeVersion` | `1.17.4` |

NPM latest on 2026-07-06:

| Package | Latest |
| --- | --- |
| `@opencode-ai/sdk` | `1.17.13` |
| `@opencode-ai/plugin` | `1.17.13` |
| `opencode-ai` | `1.17.13` |

Baseline installed plugin package path:

`node_modules/.pnpm/@opencode-ai+plugin@1.17.4__1d19f68c912aff9b3e795be1915f080e`

## Baseline Contract Matrix

| Surface | Installed legacy `dist/gen` | Installed `dist/v2/gen` | Context7 current docs | Context7 v2 proposal |
| --- | --- | --- | --- | --- |
| Events | Legacy event surface only in the inspected contract. | `Event` union includes `EventPermissionV2Asked`, `EventPermissionV2Replied`, `EventQuestionV2Asked`, `EventQuestionV2Replied`, `EventQuestionV2Rejected`, and `syncEvent` variants. | Not strong enough for Veslo event implementation decisions. | Useful only as upgrade-spike input. |
| Prompt submission | Veslo should keep its existing conversation API to OpenCode `/session/:id/prompt_async`; OSDKMCP05 guards this. | v2 SDK presence is not a reason to rewrite prompt submission yet. | No current-doc reason found to rewrite Veslo prompt submission. | Upgrade spike must re-check before any rewrite. |
| Permission reply | Legacy top-level permission APIs remain visible in v2 SDK output. | `Permission2.reply({ sessionID, requestID, reply, message })` exists for session-scoped v2 permission requests. | Not the strongest evidence for reply shape. | Upgrade spike must re-check reply API shape. |
| Question reply | Legacy top-level `Question.reply({ requestID, answers })` remains visible in v2 SDK output. | `Question2.reply({ sessionID, requestID, questionV2Reply })` and `V2SessionQuestionReplyData` exist for session-scoped v2 question requests. | Not the strongest evidence for reply shape. | OSDKMCP03 must decide whether top-level reply covers v2 question requests. |
| MCP config | `mcp?: { [key: string]: McpLocalConfig | McpRemoteConfig }`; no `{ enabled }` sentinel in legacy lines inspected. | `mcp?: { [key: string]: McpLocalConfig | McpRemoteConfig | { enabled: boolean } }`. | Current docs use top-level `mcp.<name>` server entries. | v2 proposal nests servers under `mcp.servers`; Veslo must not write there before upgrade proof. |
| Plugin config | `plugin?: Array<string>`. | `plugin?: Array<string | [string, options]>`; tuple/options support is part of the installed v2 type surface. | Current plugin docs use singular `plugin`. | v2 proposal uses `plugins` with package/options objects; this is not current write authority. |

## Local Evidence Handles

Installed SDK types:

- Legacy plugin field: `packages/app/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1067`
- Legacy MCP field: `packages/app/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts:1128`
- v2 plugin tuple field: `packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1593`
- v2 MCP sentinel field: `packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:1629`
- v2 permission events: `packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:4276`
- v2 question events: `packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:4344`
- v2 session question reply body/path: `packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen/types.gen.d.ts:9280`
- top-level `Question.reply`: `packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:867`
- top-level `Permission.reply`: `packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:899`
- session-scoped `Permission2.reply`: `packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:1559`
- session-scoped `Question2.reply`: `packages/app/node_modules/@opencode-ai/sdk/dist/v2/gen/sdk.gen.d.ts:1580`

Baseline Veslo parser risks captured before OSDKMCP06/OSDKMCP07:

- Server plugin list parsing kept only string array items:
  `packages/server/src/plugins.ts:63`
- Plugin materializer list parsing kept only string array items:
  `packages/server/src/plugin-materializer.ts:646`
- App plugin utility parsing still needed tuple-safe handling in OSDKMCP07:
  `packages/app/src/app/utils/plugins.ts:12`
- MCP read path still treated all top-level `mcp` keys as server names:
  `packages/server/src/mcp.ts:26`

Post-upgrade current state in this checkout:

- OpenCode SDK/plugin/opencodeVersion surfaces were upgraded to `1.17.13`.
- Server/app plugin parsing preserves current singular `plugin` tuple entries.
- MCP list reads ignore future `mcp.servers` instead of listing a fake server.
- MCP writes preserve existing future `mcp.servers` and reject the reserved
  MCP name `servers` so the future-shape object cannot be overwritten through
  current top-level `mcp.<name>` mutations.

Context7 evidence:

- `/anomalyco/opencode` current/v1 MCP schema uses direct server names under
  top-level `mcp`.
- `/anomalyco/opencode` v2 config proposal uses `mcp.servers`.
- `/anomalyco/opencode` v2 config proposal uses `plugins` with package/options
  objects.
- `/anomalyco/opencode` current plugin customization evidence shows singular
  `plugin` and tuple form with options.
- `/websites/opencode_ai_plugins` current plugin docs show singular `plugin`.

Review plan identity:

- In-repo plan:
  `docs/plans/2026-07-04-opencode-sdk-v2-compatibility-kiss-plan.md`
- External review plan:
  `../veslo-review-fixes-20260706/docs/plans/2026-07-04-opencode-sdk-v2-compatibility-kiss-plan.md`
- SHA256 for both:
  `BAF4D21F851CB43AA84A4607801CE086260A0B060093EE3199CF23ABEE99808B`

## Decisions For Later Tasks

- OSDKMCP02 should normalize `syncEvent` from the installed `dist/v2/gen`
  contract, without changing direct/payload event behavior.
- OSDKMCP03 must explicitly prove or implement v2 question reply compatibility.
- OSDKMCP06 must guard both write and read paths against accidental
  `mcp.servers` treatment as current runtime config.
- OSDKMCP07 must preserve plugin tuple entries through list/add/remove and
  materialization round trips.
- OSDKMCP08 may inspect `1.17.13`, but only after OSDKMCP00 through OSDKMCP07
  are done and verified.
