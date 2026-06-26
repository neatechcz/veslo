# AI Gateway — deep audit + živé výsledky

> Co se s inference requestem děje od chvíle, kdy ho opencode pustí, přes
> náš lokální proxy, až na `https://ai.veslo.work` a do reálného upstreamu —
> plus **naměřená** data z ostrých testů, zbytečné delays a duplicitní/mrtvý
> kód. KISS, technicky.
>
> Stav k 2026-06-17. Navazuje na [`data-flows.md`](data-flows.md) (Flow 4c)
> a [`proxy-issue-no-response.md`](proxy-issue-no-response.md).

---

## 0. TL;DR

- **Průchod funguje.** Ostrý běh: 12/12 placených inference případů OK
  (cloud i přes náš lokální proxy, stream i non-stream); chybové cesty
  vrací správné kódy.
- **Streaming ale reálně nestreamuje** (F1): u `stream:true` přijde první
  byte až s celým tělem (`ttfb ≈ total`, 1 chunk). User-facing, nejdůl.
- **Cold codex „status probe" = Codex CLI subproces v hot-path** (F2) →
  první request po pauze ~30 s vs warm ~4 s.
- **`services/den/src/managed-ai` je ~50souborová, rozešlá kopie
  `services/ai-gateway`** (F3) — obě aktivně nasazené.
- **Mrtvý kód:** `CodexCliWorkerTransport` se nikde neinstancuje (F4).

```
opencode → lokální veslo-server proxy (/ai-gateway/...) → ai.veslo.work
         → (Den /v1/me → ai_access → access-policy → lease/binding
            → token-broker → transport) → Anthropic / OpenAI / Codex / OpenAI-compat
```

`ai.veslo.work` = Caddy → kontejner `ai-gateway:4034` =
`services/ai-gateway` (`packaging/owned-server/Caddyfile`,`compose.yml`).

---

## 1. Krok 1 — co opencode pošle

opencode nezná žádnou Veslo logiku; mluví standardním OpenAI-compatible /
Anthropic protokolem na custom `baseURL`. Routing generujeme do
`opencode.jsonc` (`packages/app/src/app/lib/opencode.ts`,
`applyGatewayProviderRouting`):

- `provider.<id>.options.baseURL = <serverBaseUrl>/ai-gateway/providers/<id>/v1`
- Anthropic-styl: `models.<m>.headers.Authorization = "Bearer {env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}"`
- OpenAI-compat (`codex_oauth`,`openai_compatible`): `options.apiKey = "{env:VESLO_OPENCODE_SERVER_CLIENT_TOKEN}"`
- v `models.<m>.headers`: `x-veslo-session-id = ${OPENCODE_SESSION_ID}`; `x-veslo-workspace-id` je legacy runtime state a managed config ho scrubuje
- `opencode.jsonc` nesmi obsahovat live gateway credentials; cloud gateway bearer drzi lokalni Veslo server jen v runtime memory.

Cíl skoku (`resolveManagedAiProviderRoutingTarget`,
`packages/app/src/app/lib/ai-access.ts`):

| Runtime / workspace | baseURL | token |
|---|---|---|
| desktop + local workspace (loopback) | lokální veslo-server (127.0.0.1:8787) | local server client token |
| desktop + remote / non-desktop | `https://ai.veslo.work` (default) | gateway access token |

**`${OPENCODE_SESSION_ID}` opencode NEexpanduje** — reálné session id
doplní až náš lokální server z active-run kontextu (krok 2).

---

## 2. Krok 2 — lokální veslo-server proxy (`/ai-gateway/...`)

„Náš backend" před cloudem. `packages/server/src/server.ts`,
`proxyAiGatewayRequest` + routy `/ai-gateway/providers/...`.

Pořadí zpracování:

1. cíl = `resolveAiGatewayBaseUrl()` (override `VESLO_MANAGED_AI_BASE_URL` /
   `VESLO_AI_GATEWAY_BASE_URL`, jinak `http://127.0.0.1:4034`; v desktopu
   `https://ai.veslo.work`) + `gatewayPath` + `?search`.
2. **auth swap:** OpenCode se autentizuje lokalnim server tokenem z `VESLO_OPENCODE_SERVER_CLIENT_TOKEN`; lokalni Veslo server dohleda managed-AI runtime authorization z pameti a na cloud posle `Authorization: Bearer ...`. Legacy `x-veslo-gateway-token` je jen docasny fallback pro stare bezici configy.
3. **session-id resolve:** prázdné / `${OPENCODE_SESSION_ID}` → dohledat
   reálné `opencodeSessionId` z active-run kontextu; nelze → **400
   `gateway_session_unresolved`** (na cloud se nepošle).
4. **strip hlaviček:** interní (`x-veslo-gateway-*`, `-host-token`,
   `-client-id`, `-workspace-id`, `-send-trace-id`), local-only
   (`x-session-id`, `x-session-affinity`), hop-by-hop + `host`/`origin`/
   `content-length`; `accept-encoding` → `identity`; přidá `x-veslo-request-id`.
5. **tělo** forwarduje verbatim (stream); paralelně čte „model diagnostic"
   jen pro log.
6. **timeout/abort:** header-timeout `VESLO_AI_GATEWAY_PROXY_HEADERS_TIMEOUT_MS`
   default **45 000 ms**; conversation-abort z UI umí request cíleně přerušit.
7. `fetch` na cloud; **timing markery** (log `[veslo:ai-gateway] proxy {…}`
   + trace `server:ai-gateway:proxy:timing`): `totalMs`, `localPreflightMs`,
   `upstreamHeadersMs` (TTFB z cloudu), `upstreamBodyMs`, `redactionMs`.
8. odpověď: SSE/non-JSON streamuje dál; JSON s redakcí tokenů (limit 64 KB);
   chyby → 502/504/503/499.

---

## 3. Krok 3 — uvnitř `ai.veslo.work` (`services/ai-gateway`)

App: `express.json({ limit: "10mb" })`, `GET /health`, proxy router na `/`
i `/ai-gateway`.

**Společný `/providers` middleware** (`http/proxy.ts`):
1. token z `Authorization`; chybí → 401. Lokalni Veslo server uz legacy `x-veslo-gateway-token` na cloud neforwarduje.
2. identita: `GET ${denApiBase}/v1/me` (prod `api.veslo.work`); fail → 401.
3. policy: `aiAccess.getUserAiAccess(userId)` z **vlastní ai-gateway DB**;
   `!enabled` → 403 `ai_access_not_configured`.

**Provider router** (Anthropic jako referenční, `http/providers/anthropic.ts`):
1. `x-veslo-session-id` povinné (400); `normalizeGatewaySessionId` — pokud
   pořád obsahuje placeholder, **zahashuje** `user+provider` na jednu
   fallback session (viz W7).
2. **access-policy** (`applyAiAccessPolicy`): provider match
   (403 `provider_not_assigned`), normalizace modelu, default fallback,
   allow-list (403 `model_not_allowed`), **injekce `body.model`**.
3. **lease/binding** (`leaseBroker`): sticky lease per `(user,provider,session)`,
   binding z **platform poolu** (`platform:<provider>`) round-robin; codex má
   navíc eligibility probe (viz F2).
4. **token-broker**: API key nebo OAuth access token; expirovaný OAuth
   refresh single-flight (W9).
5. **transport** → reálný upstream.
6. **retry/rebind** jen na `permanent_credential`; jinak alert + throw (1 pokus).
7. **usage accounting** best-effort.

**Codex OAuth** (`http/providers/codex-oauth.ts`) navíc: lazy repair
přiřazeného credentialu, vyžaduje assigned binding + `codex_auth_json`,
transport má v repu skutečný SSE streaming (`flushHeaders()` +
`ReadableStream`) — viz F1, v prod neúčinné.

---

## 4. Verdikt z ostrých testů: PRŮCHOD FUNGUJE

Probe `dev-specific/ai-gateway-live/ai-gateway-live-probe.mjs`, run
`full-20260617-ai-gateway-live`: **12/12 placených inference případů OK**,
cloud i přes lokální proxy, stream i non-stream. Chybové cesty:

| Případ | Status | Význam |
|---|---|---|
| cloud bad token | 401 | Den `/v1/me` odmítl |
| cloud missing session | 400 | `x-veslo-session-id` povinné |
| cloud invalid model | 403 | access-policy `model_not_allowed` |
| local missing client auth | 401 `Invalid bearer token` | server auth |
| local missing runtime gateway authorization | 401 `gateway_runtime_authorization_required` | proxy |
| local missing session | 400 `gateway_session_required` | proxy |
| local invalid runtime gateway authorization | 502 + `upstreamStatus:401` | gateway odmítl |

---

## 5. Naměřené nálezy

### F1 (HLAVNÍ) — streaming NEstreamuje inkrementálně

Per-chunk probe (`dev-specific/ai-gateway-live/stream-timing-probe.mjs`)
čte SSE chunk po chunku a značkuje čas každého `data:` eventu:

| Test | TTFB / headers | total | chunků | spread | incremental |
|---|---|---|---|---|---|
| cloud stream (cold) | 30 109 ms | 30 112 ms | **1** | **0 ms** | **ne** |
| cloud stream (warm) | 4 088 ms | 4 090 ms | **1** | **0 ms** | **ne** |
| cloud non-stream (warm) | 3 072 ms | 3 073 ms | – | – | – |
| curl stream, default enc. | 3.70 s | 3.70 s | – | – | ne |
| curl stream, `Accept-Encoding: identity` | 7.90 s | 7.91 s | – | – | ne |

**První byte přijde až s celým tělem** (`ttfb ≈ total`, vše v **jednom**
chunku), bez ohledu na délku generace (4/8/30 s vždy jeden burst na konci).
opencode tedy při streamu nedostane ani jeden token průběžně; stream je
dokonce ~1 s **pomalejší** než non-stream.

Vyloučené příčiny: klient nebufferuje (`curl -N` i ruční `reader.read()`);
není to komprese (`identity` nepomohl). **Nejpravděpodobnější příčina:**
prod `ai.veslo.work` běží **starý codex transport** čekající na celé
upstream tělo (`await response.text()`) — fix je v repu, ale nenasazený
(viz [`proxy-issue-no-response.md`](proxy-issue-no-response.md) → „Co fix
neřeší / Remote deploy"). Caddy pro `text/event-stream` flushuje sám, takže
je nepravděpodobný viník; potvrdit lze probe-em přímo na `ai-gateway:4034`
za Caddy.

**Dopad:** s timeouty (proxy 45 s, OpenCode 60 s) u delších/reasoning
generací hrozí 504/retry storm. **Fix:** nasadit aktuální `ai-gateway`
build a ověřit probe-em `spread > 150 ms` a `msToFirstContent ≪ msTotal`.

### F2 (DELAY) — cold codex status probe spouští Codex CLI subproces na hot-path

První stream 30 s, druhý 4 s. Rozdíl = codex eligibility/status probe na
cestě výběru bindingu (`leases/binding-selector.ts` → `usage/codex-status.ts`),
který **spawnuje Codex CLI subproces**:

```
codex … --skip-git-repo-check --sandbox read-only
        --output-last-message <tmp> "Reply with exactly OK."
```

…ve vlastním temp `codexHome`, parsuje rate-limity ze session `.jsonl`,
uklízí temp adresáře. Reálné spuštění modelu jen kvůli eligibilitě.

- Cache 5 min (`AI_GATEWAY_CODEX_STATUS_TTL_MS`), warm requesty ji neplatí.
- **První request po >5 min nečinnosti / po rotaci** = ~20–25 s navíc.
- Probe timeout `AI_GATEWAY_CODEX_TIMEOUT_MS` default **120 s** (vysoké).

**Fix:** eligibility ne přes plný CLI run modelu; status probe na pozadí
(periodický warmer mimo request); snížit timeout.

### F3 (DUPLICITA + DRIFT) — `den/managed-ai` ≈ rozešlá kopie `ai-gateway`

`services/den/src/managed-ai` je téměř kompletní druhá kopie (~50 souborů:
`http/providers/*`, `leases/*`, `credentials/*`, `providers/*`, `usage/*`).
**Obě aktivně nasazené:** `ai.veslo.work` → `ai-gateway`; den
(`api.veslo.work`) mountuje svoji kopii (`services/den/src/index.ts`,
`createProxyRouter` z `./managed-ai/...`, log `[den] managed-ai runtime enabled`).

A logika se **rozešla** (diff core souborů):

| Soubor | Změněných řádků |
|---|---|
| `leases/binding-selector.ts` | 186 |
| `http/providers/anthropic.ts` | 149 |
| `credentials/default-token-broker.ts` | 141 |
| `leases/lease-broker.ts` | 89 |
| `providers/anthropic-transport.ts` | 66 |
| `http/providers/access-policy.ts` | 44 |
| `usage/token-accounting.ts` | 42 |
| `leases/error-classifier.ts` | 38 |
| `credentials/token-broker.ts` | 12 |

**Dopad:** dvě implementace téhož s odlišným chováním; oprava v jedné
kopii neplatí pro druhou. Souvisí s rozporem v dokumentaci
(`docs/admin-managed-ai-access.md` označuje `ai-gateway` za „transitional/
reference", Caddy/data-flows za produkční boundary).

**Doporučení:** jeden zdroj pravdy (owned-server → `ai-gateway`); druhou
kopii smazat nebo z ní udělat tenký re-export.

### F4 (MRTVÝ KÓD) — `CodexCliWorkerTransport` se nikde neinstancuje

`providers/codex-cli-worker-transport.ts` exportuje třídu
`CodexCliWorkerTransport`, ale runtime používá `CodexOAuthInferenceProxyTransport`
(`runtime/default-runtime.ts`); `new CodexCliWorkerTransport` = 0 zásahů.
Z souboru se reálně používá jen helper `materializeCodexAuthJson`
(import v `usage/codex-status.ts`). Zbytek je mrtvý — i v duplikátu v
`den/managed-ai`.

**Doporučení:** vytáhnout `materializeCodexAuthJson` do helperu, transport
třídu + test smazat (obě kopie).

---

## 6. Slabá místa (struktura, nad rámec F1–F4)

| # | Slabé místo | Dopad |
|---|---|---|
| W1 | Header-timeout 45 s vs time-to-first-token; s F1 (žádný early flush) se snáz potká → falešné 504/retry. |
| W3 | Dva zdroje policy: identita z Den `/v1/me`, autorizace z **vlastní** ai-gateway DB; app čte z Den `/api/me/ai-access`. Divergence → `provider_not_assigned`/`model_not_allowed` přes „validní" UI. |
| W4 | `/v1/me` na každý request bez cache v gateway → závislost na Den uptime/latenci. |
| W5 | Anthropic router: `catch` → vždy 502, ztratí upstream status (429 vypadá jako 502); retry jen na permanent_credential. |
| W6 | Lokální proxy `accept-encoding: identity` → nekomprimovaný přenos cloud→lokál. |
| W7 | Fallback session-hash: neexpandovaný placeholder → všechny requesty kolabují na jeden lease/binding → špatná rotace + smíchaná atribuce usage. |
| W8 | Usage u streamu best-effort/non-blocking; abort uprostřed = ztracené usage. |
| W9 | OAuth refresh single-flight jen per-proces → při scale-out riziko `invalid_grant: refresh token already used`. |
| W10 | Žádný per-user rate/cost guard kromě 10 MB JSON limitu. |

---

## 7. Test rig a reprodukce

```bash
# per-chunk streaming timing (cloud only; pouziva runtime/env auth, tokeny nevypisuje)
node dev-specific/ai-gateway-live/stream-timing-probe.mjs --cloud-only

# plná matice cloud+local (spustí vlastní lokální veslo-server; vyžaduje volný :8787)
node dev-specific/ai-gateway-live/ai-gateway-live-probe.mjs
```

Po nasazení F1 fixu ověřit: `chunks > 1`, `spread > 150 ms`,
`msToFirstContent ≪ msTotal`.

## 8. Priorita

1. **F1** — nasadit streaming gateway na `ai.veslo.work` (user-facing).
2. **F2** — codex status probe pryč z request hot-path.
3. **F3** — sjednotit gateway na jeden zdroj, smazat/ztenčit den kopii.
4. **F4** — smazat mrtvou `CodexCliWorkerTransport`.

## Reference

- Klient/config: `packages/app/src/app/lib/{opencode,ai-access}.ts`
- Lokální proxy: `packages/server/src/server.ts` (`proxyAiGatewayRequest`)
- Cloud gateway: `services/ai-gateway/src/**`
- Duplikát: `services/den/src/managed-ai/**`
- Deploy: `packaging/owned-server/{Caddyfile,compose.yml}`
- Test rig: `dev-specific/ai-gateway-live/{ai-gateway-live-probe,stream-timing-probe}.mjs`
- Souvislé: [`data-flows.md`](data-flows.md), [`proxy-issue-no-response.md`](proxy-issue-no-response.md)
</content>
