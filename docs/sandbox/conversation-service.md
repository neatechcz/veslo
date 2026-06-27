# Conversation service — current session/write architecture

Status note: this sandbox note has stale source line references. The app-facing
Veslo server public import path is still `packages/app/src/app/lib/veslo-server.ts`,
but conversation methods now live in
`packages/app/src/app/lib/veslo-server-domains/conversations.ts` and are wired
through `packages/app/src/app/lib/veslo-server/client.ts`.
Tenhle dokument popisuje současnou serverovou vrstvu, která sjednocuje
Veslo conversation id, OpenCode session id, pasivní čtení transcriptů a
odesílání runů. Je to aktuální zdroj pravdy pro send/read flow v sandbox
větvi; starší flow přes přímé OpenCode SDK volání z UI je už jen fallback
nebo interní cesta v některých okrajových místech.

## Proč conversation service existuje

Původní UI hodně věcí řešilo přes OpenCode SDK klienta:

- vytvořit session,
- vypsat sessions,
- načíst transcript,
- poslat message.

V multi-workspace browse modu je to rizikové, protože SDK request na engine
může přes orchestrator proxy lazy-spawnout engine. To rozbíjí zásadu:
kliknutí na workspace nebo session má být pasivní čtení, ne runtime start.

Conversation service proto odděluje:

- pasivní read flow z OpenCode SQLite bez engine kontaktu,
- write flow přes Veslo server endpointy,
- stabilní Veslo `conversationId`,
- původní OpenCode `engineSessionId`,
- lifecycle ochranu, aby jedna conversation neměla dva aktivní runy.

## Hlavní vrstvy

### UI

Relevantní call sites:

- `listConversationsFromVesloReadApi` v `packages/app/src/app/app.tsx:1834`
- `getTranscriptFromVesloReadApi` v `packages/app/src/app/app.tsx:1851`
- `createConversationFromVesloWriteApi` v `packages/app/src/app/app.tsx:1866`
- `runConversationFromVesloWriteApi` v `packages/app/src/app/app.tsx:1890`
- `serverClient.listConversations` v `packages/app/src/app/lib/veslo-server.ts:2272`
- `serverClient.createConversation` v `packages/app/src/app/lib/veslo-server.ts:2283`
- `serverClient.runConversation` v `packages/app/src/app/lib/veslo-server.ts:2298`

UI si drží conversation scope:

- workspace id,
- workspace root,
- directory,
- Veslo `conversationId`,
- OpenCode `opencodeSessionId`.

Před každým write voláním UI zajistí, že workspace je registrovaný ve Veslo
serveru. Tahle read/write bootstrap registrace pouze předá metadata
workspace; nemá startovat engine.

### Veslo server

Server routy:

- `GET /workspace/:id/conversations`
- `POST /workspace/:id/conversations`
- `GET /workspace/:id/conversations/:conversationId/transcript`
- `POST /workspace/:id/conversations/:conversationId/runs`
- `POST /workspace/:id/conversations/:conversationId/abort`

Hlavní soubory:

- `packages/server/src/server.ts`
- `packages/server/src/conversation-service.ts`
- `packages/server/src/conversation-binding-store.ts`
- `packages/server/src/conversation-read-store.ts`
- `packages/server/src/orchestrator-lifecycle-client.ts`

Server je hranice, kde se potkává pasivní SQLite čtení, OpenCode HTTP write
API a orchestrator lifecycle API.

### OpenCode SQLite read store

`createConversationReadStore` čte OpenCode SQLite DB read-only.

Soubor:

- `packages/server/src/conversation-read-store.ts`

Použití:

- list sessions podle `directory`,
- read transcript podle session id,
- normalize message/part JSON data,
- vrátit `source: "sqlite"` nebo `source: "unavailable"`.

DB path resolution:

1. workspace-scoped env `VESLO_OPENCODE_DB_PATH_<WORKSPACE_ID>`;
2. workspace config `opencodeDbPath` / `opencode.dbPath`;
3. global env `VESLO_OPENCODE_DB_PATH` / `OPENCODE_DB_PATH`;
4. workspace/opencode data dir variants;
5. `<workspace>/.opencode/opencode.db`, pokud existuje;
6. fallback `~/.local/share/opencode/opencode.db`.

Invariant: read store nesmí startovat engine. Když DB není dostupná, vrací
`source: "unavailable"`, neproxyuje na OpenCode.

### Conversation binding store

`createConversationBindingStore` persistuje vazbu mezi Veslo conversation id a
OpenCode session id.

Soubor:

- `packages/server/src/conversation-binding-store.ts`

Default DB:

- `<VESLO_DATA_DIR>/conversations/bindings.sqlite`

Schéma ukládá:

- `workspace_id`,
- `conversation_id`,
- `engine = "opencode"`,
- `engine_session_id`,
- `directory`,
- parent/branch metadata,
- title,
- created/updated/seen timestamps.

`conversationId` je deterministické:

```text
conv-<sha256("opencode\0workspaceId\0directory\0engineSessionId").slice(0, 20)>
```

To znamená:

- staré OpenCode sessions lze dodatečně navázat na stabilní Veslo
  conversation id;
- list sessions může připojit bindingy bez změny OpenCode DB;
- request může přijít buď s `conversationId`, nebo přímo s OpenCode
  session id.

## Read flow

### List conversations

```text
UI
  -> serverClient.listConversations(workspaceId, directory)
  -> GET /workspace/:id/conversations?directory=...
  -> conversationService.listConversations
  -> conversationReadStore.listConversations
  -> OpenCode SQLite session rows
  -> conversationBindingStore.bindOpenCodeSessions
  -> UI dostane sessions s conversationId + opencodeSessionId
```

Kritická vlastnost: list flow je pasivní. Nemá kontaktovat OpenCode HTTP
engine a nemá spouštět `pool.ensure`.

### Transcript

```text
UI
  -> serverClient.getSessionTranscript(workspaceId, sessionOrConversationId, limit, directory)
  -> GET /workspace/:id/conversations/:conversationId/transcript
  -> bindingStore.resolveOpenCodeSession
  -> readStore.getTranscript(opencodeSessionId)
  -> OpenCode SQLite message/part rows
  -> UI hydratuje transcript
```

Když binding neexistuje, server zkusí použít dodané id jako OpenCode
session id. To drží zpětnou kompatibilitu se starými session ids.

## Create conversation flow

Používá se hlavně pro první zprávu do nové session.

```text
UI createSessionAndOpen
  -> createConversationFromVesloWriteApi
  -> POST /workspace/:id/conversations
  -> conversationService.createConversation
  -> fetchOpencodeJson("/session")
  -> OpenCode vytvoří session
  -> bindingStore.bindOpenCodeSession
  -> server vrátí conversationId + opencodeSessionId
```

Důležité:

- create je write flow, takže může kontaktovat OpenCode engine;
- pokud local engine ještě neběží, cesta na OpenCode jde přes
  orchestrator proxy a může lazy-spawnout engine;
- binding se persistuje před návratem do UI;
- UI si uloží scope, aby další run posílal přes `conversationId`.

## Run flow

Primární send flow pro existující conversation:

```text
UI sendPrompt
  -> runConversationFromVesloWriteApi(sessionID, input)
  -> serverClient.runConversation(workspaceId, conversationId, input)
  -> POST /workspace/:id/conversations/:conversationId/runs
  -> resolveConversationExecutionTarget
  -> lifecycleOwner.register
  -> OpenCode /session/:opencodeSessionId/prompt_async
  -> server vrátí { status: "submitted" }
  -> UI čeká na SSE message.updated / message.part.updated
```

Server endpoint:

- `packages/server/src/server.ts:3515`

Kritický invariant:

- server nejdřív registruje run přes lifecycle owner;
- až potom volá OpenCode `/prompt_async`;
- POST vrací jen submit status, ne modelovou odpověď.

## Lifecycle owner and stale active runs

Local workspaces používají orchestrator lifecycle owner. Remote workspaces ho
nepoužívají.

Server client:

- `packages/server/src/orchestrator-lifecycle-client.ts`
- `POST /workspace/:workspaceId/runs/register`
- default local request timeout `ORCHESTRATOR_LIFECYCLE_REQUEST_TIMEOUT_MS = 5_000`

Orchestrator side:

- `packages/orchestrator/src/run-registry.ts`
- `packages/orchestrator/src/run-store.ts`
- `packages/orchestrator/src/run-activity-probe.ts`
- zapojení v `packages/orchestrator/src/cli.ts`

Run registry chrání invariant:

- jedna conversation může mít nejvýše jeden aktivní run;
- aktivní statusy jsou `submitted`, `running`, `blocked`;
- terminal statusy jsou `completed`, `failed`, `aborted`.

Když `register()` najde aktivní run pro stejnou conversation, zavolá
reconcile probe:

1. `createRunActivityProbe` vezme engine z orchestrator poolu;
2. když engine neexistuje, stale run se bere jako neaktivní;
3. když engine existuje, probe nejdřív volá `GET /session/status`;
4. `busy` nebo `retry` znamená aktivní run;
5. `idle` znamená, že stale DB záznam lze dokončit;
6. neznámý status shape fallbackuje na `GET /session/:id/message`;
7. message fallback používá latest message a terminal assistant fields
   (`time.completed`, `error`, `finish`);
8. nedostupný engine/probe znamená stale state, který dál blokuje.

Praktický výsledek:

- OpenCode `idle` odblokuje stale `running` záznam a nový run projde;
- skutečně nedostupný engine zůstává konzervativně blokovaný jako
  `409 run_already_active`;
- fallback `/message` se nemá používat pro normální idle cestu.

Test pokrývající realitu:

- `packages/server/src/server-stale-active-run.integration.test.ts`

Test seje 10 stale `running` runů, fake OpenCode vrací `/session/status =
idle`, `/session/:id/message` má nastraženou sekundovou prodlevu, a test
vyžaduje:

- 10x HTTP 200,
- 10x OpenCode `/prompt_async`,
- 0x fallback `/message`,
- staré runy jsou `completed`,
- nové runy jsou `running`.

## Abort and failed submit

Když OpenCode submit selže po úspěšné lifecycle registraci, server zavolá:

- `lifecycleOwner.markFailed(workspace.id, runId, error)`

Abort flow:

- UI volá `/workspace/:id/conversations/:conversationId/abort`,
- OpenCode abort se provede na konkrétním `opencodeSessionId`,
- orchestrator lifecycle zaznamená abort intent přes `abort-requested`.

Abort intent je metadata. Samotné dokončení runu pořád závisí na reconcile
nebo na budoucím terminal stavu.

## Latency boundaries

Neplést tři různé runtime úseky:

1. UI preflight v `sendPrompt`
   - workspace activation,
   - skill command resolve,
   - engine start při `!engineReady()`,
   - managed AI bootstrap gate,
   - local runtime health/recovery.
2. Server run registration
   - `lifecycleOwner.register`,
   - stale active reconcile,
   - OpenCode activity probe.
3. Model response
   - po úspěšném `submitted`,
   - doručuje se přes SSE, ne přes POST `/runs`.

Pokud UI ještě nedostalo `submitted` a server `/runs` se vůbec nezavolal,
hledej problém v UI preflightu.

Pokud server `/runs` začal, ale `/prompt_async` se nevolá, hledej problém v
lifecycle registeru.

Pokud `/prompt_async` proběhl a `submitted` se vrátil, ale UI nevidí odpověď,
hledej problém v SSE nebo OpenCode/model runtime.

## Source map

| Oblast | Soubor |
|---|---|
| UI write flow | `packages/app/src/app/app.tsx` |
| UI server client | `packages/app/src/app/lib/veslo-server.ts` |
| Server routes | `packages/server/src/server.ts` |
| Conversation service | `packages/server/src/conversation-service.ts` |
| Binding DB | `packages/server/src/conversation-binding-store.ts` |
| OpenCode SQLite read DB | `packages/server/src/conversation-read-store.ts` |
| Lifecycle client | `packages/server/src/orchestrator-lifecycle-client.ts` |
| Run registry | `packages/orchestrator/src/run-registry.ts` |
| Run store | `packages/orchestrator/src/run-store.ts` |
| Activity probe | `packages/orchestrator/src/run-activity-probe.ts` |
