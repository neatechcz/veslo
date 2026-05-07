# VSLO-174 — veslo-server: zapojit debug-log spool/uploader + ingest endpoint

**Datum:** 2026-05-07
**Karta:** VSLO-174 (board Veslo, sprint First sprint)
**Předchůdce:** VSLO-173 (epic), `docs/plans/2026-04-12-den-log-ingest-design.md` (design)
**Navazuje:** VSLO-175 (Tauri forwarder, čeká na endpoint z této karty), VSLO-176 (Den ingest, server tým)

## Cíl

Zapojit již napsané a otestované moduly `debug-log-spool.ts`, `debug-log-uploader.ts`, `debug-log-events.ts` do běhu `veslo-server`u a vystavit HTTP endpoint, na který bude Tauri (VSLO-175) postovat batche logů. Bez Den endpointu (VSLO-176) běží uploader v pasivním režimu (config flag `enabled=false`); spool sbírá data, retence drží disk pod kontrolou. Až server tým dodá Den endpoint, jen se nastaví dvě env vars a začne to téct ven.

## Stav před prací (zjištěný čtením kódu)

- `packages/server/src/debug-log-events.ts` — kontrakt eventu, helpery serialize/parse. Hotové.
- `packages/server/src/debug-log-spool.ts` — file-per-event JSON spool s manifest-based lease. Hotové, ale **`append()` hodí `"Debug log spool is full"` při překročení `maxBytes`** (ř. 83–85). To je problém v pasivním režimu, kdy uploader spí — spool by se zaplnil a další append by shodil `recordAudit`/logger. Potřeba wrapper s retencí (drop nejstarších).
- `packages/server/src/debug-log-uploader.ts` — HTTP POST, retry s exponential backoff (default 3 pokusy, 250 ms init, 2× multiplier, max 2 s). Hotové.
- `packages/server/src/config.ts:324–339` — `DebugLogConfig` s env vars `VESLO_LOG_INGEST_URL`, `VESLO_LOG_INGEST_TOKEN`, `VESLO_LOG_BATCH_MAX_EVENTS`, `VESLO_LOG_BATCH_MAX_BYTES`, `VESLO_LOG_SPOOL_MAX_BYTES`. `enabled` se odvozuje z `Boolean(ingestUrl && ingestToken)`. Chybí `VESLO_LOG_FLUSH_INTERVAL_MS` — doplnit.
- `packages/server/src/server.ts` — 5845 řádků, route dispatch v `startServer` (ř. 334+). Auth pattern: host-token routy resolvují přes `x-veslo-host-token` header (ř. 891). Logger `createServerLogger` (ř. 118) zapisuje přímo na `process.stdout.write` — pro tee bude potřeba wrap.
- `packages/server/src/audit.ts:36` `recordAudit()` — append-only do `~/.veslo/veslo-server/audit/{workspaceId}.jsonl`. Žádný napojení na spool.
- `grep` neukazuje žádný import `debug-log-*` v `server.ts` ani `cli.ts` — moduly jsou skutečně nezapojené.
- Testy `debug-log-spool.test.ts`, `debug-log-uploader.test.ts`, `config.debug-logs.test.ts` existují a procházejí.

## Architektura cílového stavu

```
                 ┌──────────────────────────────┐
recordAudit ────►│                              │
                 │   debug-log-pipeline         │  shutdown
createServerLogger ─►│ (retention wrapper        │  hook
(level >= info)  │    + spool + uploader)       │ ◄─── flush
                 │                              │
POST /debug-logs ►│                             │  on exit
(host-token)     │                              │
                 └──────────────┬───────────────┘
                                │ batched, retry
                                ▼
                       config.debugLogs.enabled?
                          ┌─────┴─────┐
                          │           │
                       false        true
                          │           │
                       (sleep)    POST DEN_LOG_INGEST_URL
                                  Bearer DEN_LOG_INGEST_TOKEN
```

## Změny — file by file

### 1. Nový soubor: `packages/server/src/debug-log-pipeline.ts`

Tenká fasáda, která drží spool + uploader + flush loop + retention. Místo aby každý caller (logger, audit, ingest endpoint) řešil spool přímo, voláme `pipeline.append(event)`.

```ts
export interface DebugLogPipeline {
  append(event: DebugLogEvent | DebugLogEvent[]): Promise<void>;
  flushNow(): Promise<void>;        // pro tests + shutdown
  shutdown(): Promise<void>;        // stop flush loop, final flush
}

export function createDebugLogPipeline(input: {
  config: DebugLogConfig;
  spoolDir: string;                 // typicky resolveVesloDataDir() + "/debug-log-spool"
  flushIntervalMs?: number;         // default 5000
  logger?: ServerLogger;            // pro errors v uploaderu
  fetchImpl?: typeof fetch;         // testovatelnost
}): DebugLogPipeline;
```

Vnitřní logika:
- `append()` — pokud spool hodí `"Debug log spool is full"`, pipeline **vyhodí nejstarší event soubor(y)** a zkusí znovu. Tohle je retention wrapper (kód v 1.5).
- Flush loop — interval `flushIntervalMs` (default 5 s, env `VESLO_LOG_FLUSH_INTERVAL_MS`):
  - pokud `config.enabled === false`, žádný HTTP volání, jen pokračuj.
  - jinak `spool.nextBatch({ maxEvents, maxBytes })` → `uploader.upload(batch)` → `spool.ackBatch(batchId)`.
  - Při HTTP chybě uploader sám retryuje; pokud i tak shodí, batch zůstane leased (po lease TTL 60 s ho vyzvedne další tick).
- `shutdown()` — zastaví interval, jednou flushne, vrátí.
- `flushNow()` — wrapper kolem flush logiky pro testy a shutdown hook.

#### 1.5 Retention wrapper (uvnitř pipeline)

Spool dnes hodí, když je full. Pipeline před `append` zavolá `enforceRetention()`:
- Spočítá aktuální `currentSpoolBytes()` (potřebuje export z `debug-log-spool.ts`, viz #2).
- Pokud `> spoolMaxBytes * 0.9`, smaže nejstarší event soubory (lexikální sort funguje, `Date.now()` v názvu) dokud klesne pod 0.7 thresholdu.
- Logger varování: `"debug log spool retention dropped N events"` na `level: "warn"`.

### 2. `packages/server/src/debug-log-spool.ts` — drobné rozšíření

Stávající kód neměnit, ale přidat:
- Export `currentSpoolBytes()` jako součást `DebugLogSpool` interface (dnes je to vnitřní funkce, ř. 57). Pipeline ji potřebuje pro retenci.
- Export `dropOldest(count: number): Promise<number>` — smaže N nejstarších event souborů (vrátí kolik fakt smazal). Ignoruje leased.

### 3. `packages/server/src/debug-log-events.ts` — Zod schema pro ingest validaci

Přidat:

```ts
import { z } from "zod";

export const debugLogLevelSchema = z.enum(["info", "warn", "error"]);

export const debugLogEventSchema = z.object({
  id: z.string().min(1).max(128),
  userId: z.string(),
  orgId: z.string(),
  workspaceId: z.string(),
  workerId: z.string().nullish(),
  sessionId: z.string().nullish(),
  runId: z.string().nullish(),
  source: z.string().min(1).max(64),
  stream: z.string().min(1).max(32),
  level: debugLogLevelSchema.nullish(),
  timestamp: z.number().finite(),
  sequenceNo: z.number().int().nonnegative(),
  payload: z.record(z.unknown()),
});

export const debugLogBatchSchema = z.object({
  batchId: z.string().min(1),
  events: z.array(debugLogEventSchema).min(1).max(1000),
});
```

Zod už je v repu (used jinde v server.ts — ověřit `package.json`).

### 4. `packages/server/src/server.ts` — 4 změny

#### 4a. Pipeline instance v `startServer` (ř. 334+)

Hned po vytvoření `logger = createServerLogger(config)` (najdi v `startServer`, je to první věc, kterou voláš):

```ts
const debugLogPipeline = createDebugLogPipeline({
  config: config.debugLogs,
  spoolDir: join(resolveVesloDataDir(), "debug-log-spool"),
  flushIntervalMs: config.debugLogs.flushIntervalMs,
  logger,
});
```

`resolveVesloDataDir()` — exportovat z `audit.ts` (dnes je private, ř. 14). Volá se i jinde, takže export má smysl.

#### 4b. Tee z loggeru do pipeline

Wrap `createServerLogger` callsite v `startServer`:

```ts
const baseLogger = createServerLogger(config);
const logger: ServerLogger = {
  log(level, message, attributes) {
    baseLogger.log(level, message, attributes);
    if (level === "info" || level === "warn" || level === "error") {
      void debugLogPipeline.append({
        id: randomUUID(),
        userId: "",  // server-side log nemá user kontext, doplní Den z host metadata
        orgId: "",
        workspaceId: "",
        source: "veslo-server-self",
        stream: "logger",
        level,
        timestamp: Date.now() * 1_000_000,  // nano
        sequenceNo: 0,  // pipeline by mohla auto-incrementovat, nebo nech 0
        payload: { message, attributes: attributes ?? {} },
      }).catch(() => { /* never throw from logger */ });
    }
  },
};
```

**Pozn.:** void + catch je důležité — logger se volá v hot path, nesmí blokovat. `append()` je async (file write), ale fire-and-forget je akceptovatelné (worst case ztráta posledního logu při crash).

#### 4c. Tee z `recordAudit`

Audit má svůj fixní callsite (`recordAudit(workspaceRoot, entry)` v `server.ts` na vícero místech). Místo úpravy callsitů wrapnu uvnitř `audit.ts` (viz #5).

#### 4d. Nový route `POST /debug-logs`

Přidat do route dispatcheru `startServer` (vedle ostatních host-only routes; vzor je kolem ř. 506 kde se rozhoduje `route.auth`). Použij Zod schema pro body.

```ts
if (url.pathname === "/debug-logs" && request.method === "POST") {
  // host-token auth (resolver na ř. 891 vrátí actor.type === "host")
  const actor = resolveActor(request);  // existující helper
  if (actor.type !== "host") {
    return new Response("forbidden", { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = debugLogBatchSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "invalid_batch", issues: parsed.error.issues }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  await debugLogPipeline.append(parsed.data.events);
  return new Response(JSON.stringify({ ok: true, acceptedBatchIds: [parsed.data.batchId] }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}
```

**Pozn. k 202 vs 200:** 202 Accepted znamená "přijato, async zpracování" — pravdivě (pipeline append nepotvrzuje ingest do Den, jen lokální spool).

#### 4e. Shutdown hook

V `startServer`, vedle existujícího cleanup (signal handlery, server.close()):

```ts
// somewhere před / kolem `server.listen` cleanup
const shutdown = async () => {
  await debugLogPipeline.shutdown();
  // ... existing cleanup
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

(Ověřit, jestli už něco takového není a zkombinovat.)

### 5. `packages/server/src/audit.ts` — tee do pipeline

Změnit `recordAudit(workspaceRoot, entry)` aby přijala (volitelně) pipeline:

```ts
export async function recordAudit(
  workspaceRoot: string,
  entry: AuditEntry,
  options?: { debugLogPipeline?: DebugLogPipeline },
): Promise<void> {
  // ... existing JSONL append logic ...

  if (options?.debugLogPipeline) {
    void options.debugLogPipeline.append({
      id: randomUUID(),
      userId: "",
      orgId: "",
      workspaceId: entry.workspaceId ?? "",
      source: "audit",
      stream: "jsonl",
      timestamp: Date.now() * 1_000_000,
      sequenceNo: 0,
      payload: entry as unknown as Record<string, unknown>,
    }).catch(() => { /* swallow */ });
  }
}
```

A v `server.ts` callsitech `recordAudit(...)` přidat třetí argument `{ debugLogPipeline }`. Je jich ~10 — najdi přes `grep "recordAudit(" server.ts`.

Alternativa: tee uvnitř audit.ts přes module-scope holder (`setAuditDebugPipeline(pipeline)` voláno z `startServer`). Méně argumentů, ale globální stav. Preferuju explicitní arg.

### 6. `packages/server/src/config.ts` — doplnit `flushIntervalMs`

Po ř. 331:

```ts
const debugLogFlushIntervalMs =
  parsePositiveInteger(process.env.VESLO_LOG_FLUSH_INTERVAL_MS) ?? DEFAULT_DEBUG_LOG_FLUSH_INTERVAL_MS;
```

A do `DebugLogConfig` interface přidat `flushIntervalMs: number`. Najdi `interface DebugLogConfig` v `types.ts` (nebo kde je deklarovaný — `grep` ukáže) a doplň.

### 7. `packages/server/src/types.ts` — DebugLogConfig

Přidat `flushIntervalMs: number` (najdi `interface DebugLogConfig`).

### 8. Konstanty defaults

V `config.ts` najdi `DEFAULT_DEBUG_LOG_*` a přidej:

```ts
const DEFAULT_DEBUG_LOG_FLUSH_INTERVAL_MS = 5000;
```

## Testy

### Nové
- `packages/server/src/debug-log-pipeline.test.ts`:
  - append → flushNow → uploader voláno se správným batch (mock fetch).
  - enabled=false → flushNow neudělá HTTP volání, ale spool se plní.
  - Spool full → retention dropne nejstarší a append projde.
  - Shutdown → pending flush proběhne.
- `packages/server/src/server.debug-logs-route.test.ts`:
  - POST /debug-logs bez host-token → 403.
  - POST s validním host-token a validním body → 202, eventy ve spoolu (přes mock pipeline).
  - POST s nevalidním body → 400 s `issues`.
  - POST s prázdným array → 400 (Zod min(1)).

### Existující — neměnit, jen ověřit že prochází
- `debug-log-spool.test.ts`, `debug-log-uploader.test.ts`, `config.debug-logs.test.ts`.

## Verifikace end-to-end (manuálně)

```bash
# 1. Build
cd git
pnpm --filter @neatech/veslo-server build:bin   # nebo openwork-server, viz package.json
# (AGENTS.md: "If you change packages/server/src, rebuild the binary with pnpm --filter openwork-server build:bin")

# 2. Spustit server samostatně (bez Tauri) na konkrétním portu
VESLO_PORT=8787 \
VESLO_LOG_FORMAT=json \
node packages/server/dist/cli.js --workspace ../storage/veslo-test-A

# Bez VESLO_LOG_INGEST_URL/TOKEN → enabled=false, uploader spí.

# 3. POST synthetický batch
HOST_TOKEN=<vyparsovat z výstupu serveru>
curl -X POST http://localhost:8787/debug-logs \
  -H "x-veslo-host-token: $HOST_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "batchId": "test-1",
    "events": [{
      "id": "evt-1",
      "userId": "u1", "orgId": "o1", "workspaceId": "w1",
      "source": "test", "stream": "stdout",
      "timestamp": 1778160000000000000, "sequenceNo": 1,
      "payload": {"line": "hello"}
    }]
  }'
# Očekáváno: 202 Accepted, body { ok: true, acceptedBatchIds: ["test-1"] }

# 4. Ověřit spool
ls -la ~/.veslo/veslo-server/debug-log-spool/events/
# Očekáváno: 1 JSON file s eventem.

# 5. Spustit dummy ingest (echo server) a flipnout enabled
nc -l 9999 &  # nebo napsat 5řádkový node http server, který vrátí { acceptedBatchIds: ["test-1"] }
VESLO_LOG_INGEST_URL=http://localhost:9999/ingest \
VESLO_LOG_INGEST_TOKEN=fake-token \
VESLO_PORT=8787 \
node packages/server/dist/cli.js --workspace ../storage/veslo-test-A
# POST event znovu, počkej 5+ s, ověř že fetch dorazil na 9999 a spool je prázdný.

# 6. Shutdown flush
# Pošli SIGTERM, ověř že pending eventy se před exitem flushnuly (logger info "debug log pipeline shutdown flush done").
```

## Open questions / risks

- **Spool je file-per-event JSON, ne JSONL.** Při velkých objemech (1000+ eventů/s) udělá to tisíce souborů a zpomalí to disk i `nextBatch` (čte všechny soubory). VSLO-174 to nemění — patří do follow-upu (možná samostatná karta "spool: switch to JSONL append-only with rotation"). Pro VSLO-175+VSLO-176 to ale stačí, jen pohlídat retention threshold konzervativně.
- **`userId/orgId/workspaceId` na server-side eventech** (logger, audit) — server obecně nemá user kontext na úrovni jednotlivého logu. Necháváme prázdné stringy a Den ingest si je doplní z host token metadat (zná, který host odpovídá kterému uživateli/org). Pokud Den tohle nezvládne, museli bychom obohacovat per-request — to je práce navíc na obě strany. **Připomenout serveru týmu v komentáři u VSLO-176.**
- **`sequenceNo`** je v eventu povinný, ale server ho nemá kde brát (logger zatím dává 0). Buď (a) pipeline auto-inkrementuje per `(source, stream)`, nebo (b) Den ho ignoruje a generuje sám. Default: pipeline inkrementuje.
- **Fire-and-forget v loggeru** — pokud spool selže (disk full, permissions), error se spolkne. Přidám interní counter `pipeline.appendFailures` a logger ho periodicky vypíše do baseLoggeru (jednou za minutu, jen pokud > 0). Ne v MVP, ale jako follow-up.
- **Race condition v retention** — pokud flush + append běží paralelně a oba volají `currentSpoolBytes` + delete, můžou si vyrazit soubory. Mitigace: jednoduchý in-process mutex `enforceRetention()` (Promise chain). Pipeline má jen jeden interval, takže riziko je hlavně mezi inboundem (append) a flushem — flush nesahá na nejstarší (čte je do batch a pak ackuje). Konflikt jen když retention dropuje to, co flush právě leasuje. Lease v manifestu → `pruneOldest()` musí přeskočit leased.

## Out of scope této karty

- Capture stdout/stderr child procesů z Tauri (VSLO-175).
- Den endpoint, DB, encryption, admin UI (VSLO-176).
- Live tail UI / grafy / alerting.
- Migrace spool z file-per-event na JSONL append-only (samostatný follow-up).

## Dokumentační stopa

Po dokončení karty:
- Update `docs/dev/state-and-config-reference.md` — přidat sekci `debug-logs` s env vars a default hodnotami.
- Update `docs/dev/veslo-server-app-contract.md` — dokumentovat `POST /debug-logs` endpoint shape.
- Tento plán file zůstává v `docs/plans/` jako historie (per AGENTS.md: "Use `docs/plans/` only as history").
