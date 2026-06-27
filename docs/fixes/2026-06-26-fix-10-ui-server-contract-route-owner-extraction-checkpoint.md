# Fix 10: UI/Server Contract Route Owner Extraction Checkpoint

Status note: this is a historical checkpoint. The completed state is documented in
`docs/fixes/2026-06-27-fix-11-ui-server-contract-route-owner-extraction-complete.md`
and `docs/plans/2026-06-27-veslo-server-client-modularization-plan.md`. In the
current code, `packages/app/src/app/lib/veslo-server.ts` is a public barrel and
`packages/app/src/app/lib/veslo-server/client.ts` owns the client composition and
flat compatibility aliases.

## Problem

Audit UI requestu ukazal, ze hlavni problem neni jen velikost `server.ts`, ale rozpad implicitni smlouvy mezi UI klientem a serverem.
UI skladalo requesty pres velky `veslo-server.ts` a cast serverovych HTTP rout byla registrovana primo v `server.ts`, bez jasneho route adapteru podle domeny.

Nejviditelnejsi produkcni chyba byla drift prefixu pro identities/OpenCode Router bridge:

- UI volalo `/veslo-code-router`
- server registroval `/opencode-router`

Kvuli tomu byla identities page pro Telegram/Slack identity flow rozbita 404 odpovedmi.

Soubene jsme overili, ze neni spravne vytvaret nove business ownery pro domeny, ktere uz ownera maji. `skills`, `mcp`, `automations`, `plugins`, `commands`, `soul`, conversations a file workflows uz maji vlastni business moduly nebo resource ownership model. Potrebovali jsme vytahnout HTTP adaptery a UI request fasady, ne duplikovat domenovou logiku.

## Fix

- Sjednocen OpenCode Router/identities HTTP kontrakt na `/opencode-router`.
- Pridana pravidla do implementacniho planu: kazda jednotka jde test-first, jedna vec na jeden test, potom minimalni implementace a cilene spusteni testu.
- Pridany UI domain facades pod `packages/app/src/app/lib/veslo-server-domains/*`.
- `createVesloServerClient` zacal skladat domenove vstupy pro hotove oblasti (`identities`, `automations`, `plugins`, `commands`, `mcp`).
- Legacy flat metody ve `veslo-server.ts` zustaly jako kompatibilni wrappery, ale deleguji do domenovych fasad.
- UI call sites pro identities, automations, plugins a MCP byly presunuty na domenove fasady.
- Pridan manifest/contract test, ktery porovnava klientsky path mapping domenovych fasad se server route adaptery a chyta dalsi prefix drift driv nez runtime UI.
- Ze `server.ts` byly postupne vytazeny HTTP route adaptery do `packages/server/src/routes/*`.
- Pri extrakci jsme zachovali existujici business ownery: route adapter je pouze HTTP vrstva, domenova logika zustava v puvodnich modulech.

## Route Adapters Extracted

- `routes/opencode-router.ts`
  - owner: messaging identities / OpenCode Router bridge
  - namespace: `/workspace/:id/opencode-router`

- `routes/automations.ts`
  - owner: Veslo Automations
  - namespace: `/workspace/:id/automations`
  - legacy namespace: `/workspace/:id/agentlab/automations`

- `routes/plugins.ts`
  - owner: OpenCode plugins
  - namespace: `/workspace/:id/plugins`

- `routes/commands.ts`
  - owner: commands runtime
  - namespace: `/workspace/:id/commands`

- `routes/scheduler.ts`
  - owner: scheduler runtime
  - namespace: `/workspace/:id/scheduler/jobs`

- `routes/session-archives.ts`
  - owner: session history
  - namespace: `/session-archives`

- `routes/ai-gateway.ts`
  - owner: AI gateway
  - namespace: `/ai-gateway`

- `routes/mcp.ts`
  - owner: MCP connected apps
  - namespace: `/hub/mcp`, `/workspace/:id/mcp`

- `routes/file-sessions.ts`
  - owner: filesystem workflows
  - namespace: `/files/sessions`, `/workspace/:id/files`, `/workspace/:id/inbox`, `/workspace/:id/artifacts`

- `routes/conversations.ts`
  - owner: conversation runtime
  - namespace: `/workspace/:id/conversations`, `/workspace/:id/sessions`

- `routes/skill-registry.ts`
  - owner: skills registry
  - namespace: `/v1/skills`, `/v1/skill-installations`, `/v1/skill-rollout-policies`, `/v1/skill-registry-events`

- `routes/skill-removals.ts`
  - owner: skills runtime
  - namespace: `/skill-removals`, `/skills/batch-remove`

- `routes/skill-enabled.ts`
  - owner: skills runtime
  - namespace: `/skills/disabled`, `/skills/enabled-state`

- `routes/user-global-skills.ts`
  - owner: user global skills
  - namespace: `/skills/user-global-store`, `/skills/user-global`

## Files

- `docs/plans/2026-06-26-server-route-owner-extraction-implementation-plan.md`
- `packages/app/src/app/lib/veslo-server.ts`
- `packages/app/src/app/lib/veslo-server-domains/messaging-identities.ts`
- `packages/app/src/app/lib/veslo-server-domains/automations.ts`
- `packages/app/src/app/lib/veslo-server-domains/plugins.ts`
- `packages/app/src/app/lib/veslo-server-domains/commands.ts`
- `packages/app/src/app/lib/veslo-server-domains/mcp.ts`
- `packages/app/src/app/tests/lib/veslo-server-route-manifest-contract.test.ts`
- `packages/server/src/server.ts`
- `packages/server/src/routes/opencode-router.ts`
- `packages/server/src/routes/automations.ts`
- `packages/server/src/routes/plugins.ts`
- `packages/server/src/routes/commands.ts`
- `packages/server/src/routes/scheduler.ts`
- `packages/server/src/routes/session-archives.ts`
- `packages/server/src/routes/ai-gateway.ts`
- `packages/server/src/routes/mcp.ts`
- `packages/server/src/routes/file-sessions.ts`
- `packages/server/src/routes/conversations.ts`
- `packages/server/src/routes/skill-registry.ts`
- `packages/server/src/routes/skill-removals.ts`
- `packages/server/src/routes/skill-enabled.ts`
- `packages/server/src/routes/user-global-skills.ts`
- `packages/server/src/tests/server.*-routes.test.ts`

## Verification

Targeted contract and domain tests were run after each extracted unit. The latest checkpoint passed:

```powershell
pnpm --dir packages/server exec bun test src/tests/server.skill-registry-routes.test.ts
pnpm --dir packages/server exec bun test src/tests/server.skill-removal-routes.test.ts
pnpm --dir packages/server exec bun test src/tests/server.skill-enabled-routes.test.ts
pnpm --dir packages/server exec bun test src/tests/server.user-global-skills-routes.test.ts

pnpm --dir packages/server exec bun test src/tests/server.skill-registry-search.test.ts
pnpm --dir packages/server exec bun test src/tests/skill-registry-client.test.ts src/tests/skill-registry-types.test.ts src/tests/workspace-skill-set.test.ts
pnpm --dir packages/server exec bun test src/tests/skill-removal-journal.test.ts
pnpm --dir packages/server exec bun test src/tests/server.skill-batch-remove.test.ts
pnpm --dir packages/server exec bun test src/tests/skills.test.ts
pnpm --dir packages/server exec bun test src/tests/user-skill-store.test.ts src/tests/server.user-skill-store.test.ts

pnpm --dir packages/app exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts

pnpm --dir packages/server typecheck
pnpm --dir packages/server build:bin
git diff --check
```

Result: targeted route tests, related domain tests, app client contract tests, server typecheck, `build:bin` and whitespace check passed.

## Remaining Work

This is a checkpoint, not the end of the route-owner extraction effort. Remaining planned items:

- `routes/skill-materialization.ts`
- `routes/workspace-skills.ts`
- `routes/soul.ts`
- platform/admin/workspace management route split
- remaining UI domain facades where the plan still marks `done: false`
- aggregate read endpoints only where a UI screen really needs one stable read model

The priority stays the same: keep the UI/server contract explicit and tested, while avoiding duplicate business owners.
