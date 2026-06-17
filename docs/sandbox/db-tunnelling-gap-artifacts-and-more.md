# Kde všude chybí „tunel do naší DB" (artefakty a další)

> Návazná kontrola po opravě sidebaru
> ([`sidebar-conversations-fix.md`](sidebar-conversations-fix.md)): kde jinde
> čteme data **sáhnutím do enginu / sandboxu** za běhu místo z vlastního
> host-side storu — tj. stejná křehkost (engine off, sandbox nedostupný,
> Windows↔WSL path mismatch, neškáluje přes víc sandboxů/workerů).
> Datum: 2026-06-17. Target repo: `…/veslo`.

## Princip

Po opravě **vlastníme na hostu jen seznam konverzací** (summaries v
`conversation-binding-store.ts` → `bindings.sqlite`). **Veškerý obsah** se
pořád čte on-demand sáhnutím do enginu nebo do sandbox filesystemu, bez
perzistence u nás. Otázka byla, jestli to platí i pro artefakty „nebo něco
dalšího". Platí — a u artefaktů je to dokonce horší.

## Artefakty — ANO, a hůř než konverzace

Jsou dva nezávislé druhy „artifact", **ani jeden nejde přes naši DB**:

### 1. Session artifacts (latest-run) — živý fetch z enginu, bez fallbacku
Route `GET /workspace/:id/sessions/:sessionId/artifacts/latest-run`
(`server.ts:5729`). Zdroj dat:

```ts
const messages = await fetchOpencodeJson(workspace, `/session/${sessionId}/message?limit=200`, …);
return deriveLatestRunArtifactsResponse({ …, messages });
```

- Zprávy se tahají **živě z OpenCode enginu** (HTTP), pak se z nich
  `session-artifacts.ts` odvodí artefakty (čistá derivace, žádné FS).
- **Žádný host-side store, ani read-store sqlite fallback.** Tohle je
  horší než transcript (ten má aspoň read-store sqlite).
- App efekt (`app.tsx:2698`) volá metodu na změnu selected session a na
  chybu **vyčistí** odpověď (`setLatestRunArtifactResponse(undefined)`).
  Není gated na `engineReady`.
- Dopad: v **browse módu / když engine neběží nebo je nedostupný**, fetch
  selže → panel artefaktů je prázdný, i když konverzace existuje. Stejná
  třída chyby, jakou jsme řešili u sidebaru — tady neřešená.

### 2. Outbox artifacts — přímé čtení sandbox filesystemu
Routes `GET /workspace/:id/artifacts` a `…/artifacts/:artifactId`
(`server.ts:6791`, `6801`). Zdroj:

```ts
const outboxRoot = resolveOutboxDir(workspace.path);   // <workspace.path>/.opencode/veslo/outbox
const items = await listArtifacts(outboxRoot);
// download: Bun.file(absPath) přímo ze souboru
```

- Čte/serveruje soubory **přímo z `<workspace.path>/.opencode/veslo/outbox/`**.
- Na Windows+WSL2 je `workspace.path` Windows cesta; pokud engine zapisuje
  outbox uvnitř WSL na cestu neviditelnou pod `workspace.path`, list je
  prázdný. Žádný host-side store, žádný tunel.

## Co dalšího sdílí ten samý vzor (reach-in, bez naší DB)

| Surface | Zdroj | Fallback | Browse-mode |
|---|---|---|---|
| **Session artifacts (latest-run)** | živě engine `/session/:id/message` | žádný | prázdné |
| **Outbox artifacts** | FS `<ws>/.opencode/veslo/outbox` | žádný | path-mismatch riziko |
| Transcript (obsah) | read-store sqlite (sandbox `opencode.db`) | binding jen pro id | sandbox dep. |
| Todos / permissions | živě engine (`session.todo`, `permission.list`) | žádný | engine-only |
| Inbox panel | FS/engine `.opencode/veslo/inbox` | žádný | reach-in |
| Skills inventory | `.opencode/skills` (engine/Tauri) | host fallback | reach-in |
| Media / attachments | cesty do sandboxu (`source.path`) | žádný | reach-in |

Společné: **jediná věc, kterou teď vlastníme host-side, je seznam
konverzací.** Všechen obsah (transcript, artefakty, todos, permissions,
inbox/outbox, media) je engine/sandbox-sourced bez perzistence u nás.

## Závažnost / pořadí

1. **Session artifacts (latest-run)** — nejvíc user-visible po sidebaru:
   v browse módu prázdný panel, žádný fallback. Kandidát na stejné ošetření
   (aspoň „nedostupné ≠ prázdné", ideálně tunel obsahu).
2. **Outbox artifacts** — Windows↔WSL path mismatch, tichý prázdný list.
3. Transcript/todos/permissions/media — sdílí sandbox závislost; mimo
   aktuální scope (rozhodnuto: transcript smí sahat do WSL).

## Doporučení (pokud rozšiřovat tunel)

- Krátkodobě (laciné, konzistentní s opravou sidebaru): u session artifacts
  **rozlišit „engine nedostupný" od „0 artefaktů"** a nepřepisovat panel
  prázdnem na chybu (analogie `shouldPreserveSidebarRowsOnRead`).
- Střednědobě: při živém běhu **tunelovat obsah do host-side storu**
  (transcript messages/parts + odvozené artefakty + outbox manifest) a
  reads servírovat z něj; sandbox jen jako enrichment. Tím by celý content
  layer přestal záviset na dosažitelnosti sandboxu a škáloval přes víc
  workerů.

## Reference
- `packages/server/src/server.ts` (`:5729` latest-run, `:6791`/`:6801` outbox,
  `loadConversationTranscriptResponse` `:4496`)
- `packages/server/src/session-artifacts.ts` (čistá derivace ze zpráv)
- `packages/app/src/app/app.tsx` (`:2698` latest-run effect)
- `packages/app/src/app/lib/veslo-server.ts` (`getSessionLatestRunArtifacts`, `downloadArtifact`)
- Souvislé: [`sidebar-and-conversations-deep-dive.md`](sidebar-and-conversations-deep-dive.md),
  [`sidebar-conversations-fix.md`](sidebar-conversations-fix.md)
</content>
