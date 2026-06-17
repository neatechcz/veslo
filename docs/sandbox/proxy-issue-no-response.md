# Proxy issue no response

Stav k 2026-06-16. Dokumentuje debugging případu, kdy uživatel pošle zprávu
z UI, OpenCode run se vytvoří, ale odpověď se nevrátí do UI ani po desítkách
sekund. Cílem je jít po příčině, ne prodlužovat timeouty.

## Symptom

Při odeslání krátké zprávy, například `ahoj`, UI přepne do running stavu, ale
odpověď nepřijde. Po ručním abortu se v UI objeví chyba podobná:

```json
{
  "code": "ai_gateway_aborted",
  "message": "AI gateway request was aborted",
  "details": {
    "provider": "codex_oauth",
    "model": "gpt-5.5",
    "baseUrl": "https://ai.veslo.work",
    "targetUrl": "https://ai.veslo.work/providers/codex_oauth/v1/chat/completions",
    "abortReason": "conversation-abort"
  }
}
```

Při neabortovaném běhu lokální proxy končila variantou:

```text
AI gateway upstream did not send response headers before timeout
```

To je důležitý detail: problém nebyl jen v tom, že finální modelová odpověď
trvala dlouho. Lokální proxy čekala na response headers ze vzdálené gateway.

## Co jsme zkoušeli

### 1. Direct orchestrator test bez UI

Použili jsme postup z `debug-playbook.md`: vytvořit OpenCode session přes
orchestrator a poslat `prompt_async` přímo mimo frontend.

První pokus selhal na testovacím artefaktu: JSON body z PowerShellu obsahovalo
UTF-8 BOM a orchestrator vrátil `upstream request rewrite error` s parse chybou
na tokenu `ď»ż`. To nebyla produkční chyba.

Po BOM-free requestu se session vytvořila a `prompt_async` prošel, ale direct
OpenCode `/message` ukázalo assistant API error:

```text
Gateway session id placeholder could not be resolved
incomingSessionId: ${OPENCODE_SESSION_ID}
```

Závěr: čistě orchestrator-only test je pro současnou managed AI cestu
neúplný. OpenCode sám placeholder `${OPENCODE_SESSION_ID}` neexpanduje.
Placeholder řeší Veslo server přes active-run context. Direct test je užitečný
pro izolaci OpenCode, ale neověřuje plnou produkční managed AI cestu.

### 2. Veslo server conversation API bez UI

Potom jsme šli správnou cestou přes Veslo server conversation API:

1. vytvořit conversation,
2. získat `opencodeSessionId`,
3. spustit run přes server,
4. sledovat provider start watchdog,
5. polling transcriptu,
6. po 60 sekundách ruční abort.

Výsledek:

- `POST /runs` vrátil `status: submitted` velmi rychle,
- provider start watchdog uspěl přibližně do stovek milisekund,
- `send-workflow-trace.ndjson` ukázal provider hit na
  `https://ai.veslo.work/providers/codex_oauth/v1/chat/completions`,
- request měl `stream: true`, model `gpt-5.5`, systémovou i user zprávu,
- lokální proxy čekala na remote response headers a po timeoutu dostala 504,
- OpenCode/AI SDK následně request retryovalo,
- po našem abortu druhý request skončil jako 499 `ai_gateway_aborted`.

Závěr: lokální Veslo server, active-run context i placeholder resolution
fungují. Request se dostal do remote AI gateway. Primární blok byl až ve
vzdálené gateway / jejím provider transportu.

### 3. Kontrola OpenCode config modelu

Ověřili jsme proti OpenCode docs, že použití OpenAI-compatible provideru přes
custom `baseURL` je správný model pro gateway. OpenCode nepotřebuje znát Veslo
interní hlavičky. Ty jsou pro lokální Veslo proxy/orchestraci a před forwardem
na vzdálenou gateway se stripují.

To znamená, že problém není v tom, že by OpenCode neuměl naše workspace
hlavičky. Důležitá cesta je:

```text
OpenCode -> local Veslo proxy -> ai.veslo.work -> Codex OAuth inference proxy
```

## Hlavní příčina

V `services/ai-gateway` transport pro `codex_oauth` dříve u streaming requestů
čekal na celé upstream SSE tělo:

```ts
const parsedResponse = parseCodexResponsesSse(await response.text(), model)
```

To je pro SSE špatně. Express route nemůže poslat klientovi response headers,
dokud `chatCompletions()` nevrátí `ProviderTransportResponse`. Pokud transport
čeká na `response.text()`, remote gateway drží headers až do konce upstream
odpovědi. Lokální proxy proto vidí přesně tento stav:

```text
upstream did not send response headers before timeout
```

Timeout zde nemá být prodlužovaný. Správný fix je streamovat průběžně.

## Implementovaný fix

V `services/ai-gateway` byl přidán skutečný streaming path:

- `codex-oauth-inference-proxy-transport.ts`
  - pro `stream: true` vrací `ReadableStream` okamžitě po upstream headers,
  - průběžně převádí Codex Responses SSE na OpenAI chat completion SSE,
  - usage sbírá až po doběhnutí streamu přes `usagePromise`,
  - nečeká na `response.text()` u streaming requestů.

- `http/providers/codex-oauth.ts`
  - umí poslat Web `ReadableStream` přes Express,
  - volá `flushHeaders()`, aby klient dostal headers hned,
  - usage accounting pro streaming neblokuje odpověď.

- `providers/transport.ts`
  - `ProviderTransportResponse` má volitelné `usagePromise`.

## Regresní testy

Přidané/aktualizované testy ověřují:

1. streaming odpověď lze přečíst jako OpenAI-compatible SSE,
2. `chatCompletions()` vrací streaming response ještě před dokončením
   upstream body,
3. Express proxy umí poslat Web `ReadableStream`,
4. usage metadata ze streamu se uloží až po dokončení streamu.

Ověření:

```powershell
pnpm --filter @neatech/ai-gateway build
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-oauth-inference-proxy-transport.test.ts test/codex-oauth-proxy.test.ts
```

Cílená sada prošla: 12/12.

Poznámka: `pnpm --filter @neatech/ai-gateway test -- ...` kvůli package
scriptu spouští i `test/**/*.test.ts`, tedy celou sadu. Ta v době auditu
padala na nesouvisejících Windows/test-drift chybách, ne na proxy streaming
změně.

## Co fix neřeší

### Remote deploy

Repo kód je opravený lokálně. Reálná `https://ai.veslo.work` se nezmění,
dokud se nová gateway verze nenasadí. Pokud produkční gateway stále běží starý
kód s `response.text()`, UI bude dál čekat na headers a lokální proxy může
končit 504.

### Read-side transcript divergence

Při Veslo server conversation API testu přímý OpenCode `/message` ukázal user
zprávu i assistant error, ale Veslo server transcript polling vracel:

```json
{
  "messages": [],
  "source": "sqlite"
}
```

To je samostatný problém: live OpenCode state a pasivní SQLite/read transcript
nejsou synchronní. Vysvětluje to chybějící nebo pozdě načtené konverzace v UI,
ale není to příčina remote gateway header timeoutu.

Další směr:

- prověřit, proč server read API čte `count: 0`, když live OpenCode session má
  zprávy,
- rozhodnout, zda má být po engine startu backfill/import do read DB,
- případně pro aktivní run použít live OpenCode fallback, ale bez nechtěného
  lazy-spawnu engine při pasivním browse.

## Praktický debug postup příště

1. Nezačínat zvýšením timeoutu.
2. Zkontrolovat `send-workflow-trace.ndjson`:
   - zda vznikl active run,
   - zda se resolver dostal přes `${OPENCODE_SESSION_ID}`,
   - zda vznikl provider hit,
   - zda remote poslala headers.
3. Pokud provider hit vůbec nevznikne, debugovat config/readiness mezi
   OpenCode a local Veslo proxy.
4. Pokud provider hit vznikne, ale headers nepřijdou, debugovat remote gateway
   streaming/provider transport.
5. Pokud OpenCode má zprávy, ale Veslo server transcript je prázdný, řešit
   read-side SQLite/live divergence odděleně.

