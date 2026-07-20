# Analýza: services/ai-gateway

## Účel a rozsah

**AI Gateway je cloudová (hostovaná) služba — multi-tenant proxy na LLM providery.** Není to lokální komponenta desktopové aplikace; běží jako samostatný kontejner na `ai.veslo.work` (Caddy reverse proxy → `ai-gateway:4034`, viz `packaging/owned-server/Caddyfile:13-15` a `packaging/owned-server/compose.yml:252-258`). Implementuje funkci „Managed AI": platforma Veslo vlastní pool přihlašovacích údajů (Codex OAuth účty ChatGPT, OpenAI API klíče, Anthropic API klíče, libovolné OpenAI-kompatibilní endpointy) a půjčuje je uživatelům, kteří nemají vlastní klíče.

**Je živá, ačkoli v kořenovém CLAUDE.md pracovního adresáře chybí.** Git historie: 201 commitů od 2026-03-30 do 2026-07-18 (tj. den před dneškem). Je členem pnpm workspace (`pnpm-workspace.yaml` zahrnuje `services/*`), je nasazená v produkčním compose, v dev docker-compose (`packaging/docker/docker-compose.dev.yml:269-303`) a E2E testy ji spouštějí in-process přes export `@neatech/ai-gateway/test-support` (`packages/e2e/helpers/managed-ai-gateway-fixture.ts:4`).

**Rozsah kódu:**
| Část | Řádky | Soubory |
|---|---|---|
| `src/` (TypeScript) | 17 396 | 79 |
| `test/` | 26 324 | ~73 |
| `public-admin/` (vanilla JS admin SPA) | 6 840 | 5 |
| `drizzle/` (SQL migrace) | 231 | 5 |
| **Celkem** | **~50 800** | |

Testy mají 1,5× více řádků než produkční kód — jakýkoli refaktoring má obrovský „vlečený náklad".

## Architektura a klíčové soubory

**Stack:** Node.js + Express 4, MySQL přes drizzle-orm/mysql2, zod pro env, undici, závislost `@openai/codex` 0.144.5 (celé Codex CLI jako npm balíček!). Žádný Bun, žádný Tauri.

**Vstupní bod:** `src/index.ts` — `createApp()` skládá 4 routery:
1. **Readiness** (`src/http/readiness.ts`) — `GET /readiness`, provádí live probe schopností modelů.
2. **Admin** (`src/http/admin.ts`, **4 677 řádků — největší soubor**) — kompletní platformní administrace: organizace, členové, domény, pozvánky, billing (vše proxováno do Den přes `DenAdminClient`, ř. 1046), uživatelé, per-user AI access policy, platform model policy, CRUD credentialů + revoke/drain/rotate/reconnect, upload Codex `auth.json` přes jednorázové tokeny, agregace usage, alerty, audit. Admin autentizace přes browser handoff s Den (`/admin/api/auth/browser/start|exchange`, ř. 3492-3550, cookie). Servíruje i statickou admin SPA (`router.use("/admin", express.static(...))`, ř. 4642).
3. **User credentials** (`src/http/user-credentials.ts`) — `GET /api/me/ai-access` (+ legacy alias `/ai-gateway/me/ai-access`): vrací uživateli jeho přidělený provider/model roster.
4. **Proxy** (`src/http/proxy.ts`) — jádro služby. Middleware řetěz na `/providers/*`: Bearer token (nebo `x-veslo-gateway-token`) → resolve session u Den → entitlement u Den → per-user AI access → platform model policy → provider routery:
   - `/providers/openai/v1/chat/completions` (`src/http/providers/openai.ts`)
   - `/providers/anthropic/v1/messages` (`src/http/providers/anthropic.ts`)
   - `/providers/codex_oauth/v1/chat/completions` (`src/http/providers/codex-oauth.ts`)
   - `/providers/openai_compatible/v1/chat/completions` (`src/http/providers/openai-compatible.ts`)
   - Vše ještě jednou pod prefixem `/ai-gateway/...` (legacy dual-mount, `src/index.ts:56`).

**Credential pool a leasing** (podstatná část domény):
- Tajemství šifrovaná AES-256-GCM v MySQL (`src/credentials/secret-crypto.ts`, klíč = SHA-256 z env `AI_GATEWAY_SECRET_KEY`).
- `LeaseBroker` (`src/leases/lease-broker.ts`) — sticky přiřazení credentialu na OpenCode session (`session_lease` tabulka, unikátní index session×provider). Při „permanent_credential" chybě (klasifikace v `src/leases/error-classifier.ts`) přepne lease na jiný credential a request zopakuje (`executeWithRetry` v každém provider routeru).
- `DefaultTokenBroker` (`src/credentials/default-token-broker.ts`) — vydává upstream auth, refreshuje OpenAI OAuth tokeny.
- `AutoAssignedCodexCredentialRotationService` (`src/access/auto-assignment-rotation.ts`) — automatická rotace Codex credentialů podle vyčerpání limitů/kompatibility modelu.

**Codex specialita (nejkřehčí část):**
- `src/providers/codex-oauth-inference-proxy-transport.ts` (923 ř.) — volá **neoficiální API `https://chatgpt.com/backend-api/codex/responses`** s OAuth tokenem ChatGPT účtu a ručně překládá protokol Responses API ⇄ Chat Completions, včetně re-streamování SSE (tool cally, usage, deltas).
- `src/usage/codex-status.ts` (820 ř.) — zjišťuje rate limity Codex účtů tak, že **spouští zabalené Codex CLI jako subprocess** (`spawn` v `codex-cli-worker-transport.ts:524`, binárka z `node_modules/.bin/codex` — `src/providers/codex-command.ts:26-40`), parsuje jeho výstup, cachuje a zpětně ukládá obnovený `auth.json` do DB.
- `src/model-policy/capability-verifier.ts` (510 ř.) — ověřuje schopnosti modelů živými sondami.
- Katalog modelů, capacity overview, eligibility, capacity alert monitor + e-mailové smyčky (Lettr API, `src/email/admin-alert-mailer.ts`, intervaly v `src/index.ts:109-156`).

**DB schéma** (`src/db/schema.ts`): 9 tabulek — credential_record, credential_secret, credential_binding, session_lease, credential_health_event, credential_usage_event (tokeny per request), ai_gateway_audit_event, user_ai_access_policy, platform_model_policy. Při startu `ensureAiGatewaySchema` (idempotentní reconcile, `src/db/schema-reconcile.ts`).

## Komunikační vazby

Celý řetězec inference v Managed AI režimu:

```
OpenCode engine (desktop, per-workspace)
  │  HTTP: baseURL = http://127.0.0.1:<port>/ai-gateway/providers/<id>/v1
  │  (konfigurováno ve workspace opencode.json — packages/app/src/app/lib/opencode.ts:514,
  │   hlavičky Authorization + x-veslo-session-id)
  ▼
veslo-server (lokální, packages/server/src/routes/ai-gateway.ts)
  │  HTTP: https://ai.veslo.work (resolveAiGatewayBaseUrl, packages/server/src/server.ts:1719-1731;
  │  override VESLO_MANAGED_AI_BASE_URL / VESLO_AI_GATEWAY_BASE_URL)
  ▼
ai-gateway (cloud)
  ├─ HTTP → Den (api.veslo.work): GET /v1/me (auth/user-session.ts:86),
  │         GET /v1/managed-ai/entitlement (billing/den-managed-ai-entitlement-resolver.ts:112),
  │         admin proxy orgs/billing/users (http/admin.ts:1046-1090)
  ├─ TCP → MySQL (drizzle, veslo_ai_gateway)
  ├─ HTTPS → upstream LLM: api.openai.com, api.anthropic.com,
  │          chatgpt.com/backend-api/codex/responses, libovolná OpenAI-kompatibilní URL
  ├─ subprocess → Codex CLI (spawn, temp CODEX_HOME soubory) — jen status probe
  └─ HTTP → Lettr e-mail API (alerty)
```

Další konzumenti:
- **Admin SPA** (`public-admin/app.js`, 3 738 ř. vanilla JS) → `/admin/api/*` (HTTP + cookie).
- **packages/e2e** → in-process import (`createAiGatewayTestApp`) — falešný Den + falešný transport, reálná gateway app.
- **packages/orchestrator** (`cli.ts:3057-3064`) — předává `managedAiBaseUrl` do spouštěného veslo-serveru; **packages/desktop** (`spawn.rs:594`) — propaguje `VESLO_AI_GATEWAY_BASE_URL`.
- **packages/app** — UI čte `/ai-gateway/me/ai-access` přes veslo-server (nikdy přímo gateway).

## Vazba na OpenCode

**Velmi volná — gateway o OpenCode nic neví.** V `services/ai-gateway/src` není jediný import OpenCode SDK. Rozhraní je generické Chat Completions / Anthropic Messages API. Vazba existuje jen na straně klienta:

1. OpenCode engine se konfiguruje npm providerem `@ai-sdk/openai-compatible` s `baseURL` mířícím na veslo-server (`packages/app/src/app/lib/opencode.ts:505-514`).
2. Hlavička `x-veslo-session-id` nese OpenCode session id; gateway ji používá jen jako klíč sticky lease (`normalizeGatewaySessionId`, `src/http/providers/session-id.ts`).

**Výměna enginu by gateway prakticky nezasáhla** — stačí, aby nový engine uměl custom OpenAI-kompatibilní baseURL + custom hlavičky (to umí prakticky každý: Claude Code přes `ANTHROPIC_BASE_URL`, LiteLLM, aider…). Anthropic větev gatewaye dokonce už mluví nativním Messages API.

## Hotspoty složitosti

| Místo | Problém | Závažnost |
|---|---|---|
| `src/http/admin.ts` | 4 677 řádků v jednom souboru: admin service + Den proxy klient + 3 MySQL repozitáře + ~60 rout + e-mail monitory. Významná část (orgs, members, domains, invites, billing) je jen proxy do Den. | kritická |
| `src/providers/codex-oauth-inference-proxy-transport.ts` | 923 ř. ruční reimplementace překladu protokolů proti **neoficiálnímu** `chatgpt.com/backend-api` — OpenAI ho může kdykoli změnit; SSE re-streaming, tool cally, usage parsing. | vysoká |
| `src/usage/codex-status.ts` + `codex-cli-worker-transport.ts` | 1 400+ ř.: spawnování zabaleného Codex CLI (pin 0.144.5) na serveru kvůli zjištění rate limitů, parsování CLI výstupu, zpětné zapisování auth.json. Rozbije se s každou změnou CLI. | vysoká |
| Duplikát `services/den/src/managed-ai/` | Celá gateway existuje v repu **dvakrát** (viz níže). Každá oprava se musí dělat 2×, reálně se nedělá → divergence. | kritická |
| `test/` 26 324 ř. | Testovací hmota 1,5× větší než kód; mnoho testů testuje interní třídy (repozitáře, selektory), ne HTTP kontrakt → betonuje současnou strukturu. | střední |
| `src/providers/openai-transport.ts`, `anthropic-transport.ts` | Žádný streaming — celé tělo odpovědi se bufferuje a pošle najednou (`applyUpstreamResponse` res.json). Dlouhé generace = dlouhé ticho + riziko timeoutů. Streamuje jen codex_oauth větev. | střední |
| `public-admin/app.js` | 3 738 ř. ručně psané vanilla JS SPA v jednom souboru (další 1 673 ř. CSS). | střední |
| Řetěz auth závislostí | Každý inference request = 2 HTTP dotazy na Den (session + entitlement, cache jen 15 s) → Den je single point of failure pro veškerou inference. | vysoká |

## Duplicity a mrtvý kód

1. **`services/den/src/managed-ai/` — divergovaná kopie celé gatewaye uvnitř Den** (54 souborů, ~9 483 řádků). Den ji mountuje, když je nastaveno `MANAGED_AI_DATABASE_URL` (`services/den/src/index.ts:90, 184-197` — vlastní `/providers` proxy router, user-credentials router, admin UI router). Produkční compose má obě varianty (`packaging/owned-server/compose.yml:211-224` pro Den, `:252-258` pro standalone). Soubory se liší už formátováním (středníky vs. bez) a funkčně divergují: ai-gateway má navíc `billing/`, `email/`, `organization-audit`, `authorized-model-roster`, `credential-alert-email-monitor`; kopie v Den má navíc `signup-assignment.ts`. Obě větve se dál commitují (ai-gateway 2026-07-18, den kopie 2026-07-14).
2. **`deployment-endpoints.ts` zkopírován 6×** s odlišnými checksumy: `services/ai-gateway/src/`, `services/den/src/`, `packages/server/src/`, `packages/orchestrator/src/`, `packages/app/src/app/lib/`, `packages/web/lib/`.
3. **Mrtvý OAuth authorize/exchange:** `DefaultOpenAiOAuthClient.startAuthorization` a `exchangeCode` (`src/credentials/openai-oauth.ts`) nemají ve standalone gateway žádného volajícího ani mount `/auth/openai` routy (env `redirectBase` na ni přesto ukazuje, `src/env.ts:38-39`). Používá se jen `refreshToken`. (V Den kopii se OAuth klient používá pro admin UI.)
4. **`CodexCliWorkerTransport` jako inference transport se nepoužívá** — default runtime zapojuje jen `CodexOAuthInferenceProxyTransport` (`src/runtime/default-runtime.ts:161`). Z 586řádkového souboru se reálně používají jen 2 pomocné funkce (`materializeCodexAuthJson`, `isRequestedModelRuntimeIncompatibility`) pro status probe.
5. **Legacy dual-mount routy:** vše žije na `/providers/...` i `/ai-gateway/providers/...`, `/api/me/ai-access` i `/ai-gateway/me/ai-access`.
6. `src/typecheck/repository-contracts.ts` — 143 ř. čistě kompilačních kontraktů (drží duplicitní implementace v sync — symptom problému č. 1).

## Co by znamenalo oddělení BE/FE

**Skoro nic — gateway už JE model „API + SPA", o který vlastník usiluje.** Je to čistě headless Express API + oddělená statická admin SPA. Nemá žádnou vazbu na Tauri, SolidJS ani desktop IPC. Jejím klientem je veslo-server (backend), nikoli UI.

Při přestavbě Vesla na web model:
- Gateway zůstává beze změny jako cloudová služba.
- Jediné rozhodnutí: zda nový backend dál **proxuje** `/ai-gateway/*` (dnešní stav — výhoda: klientský token nikdy neopouští lokální server, tracing), nebo engine míří **přímo** na `ai.veslo.work` s Den tokenem (odpadne celá proxy vrstva v packages/server: `routes/ai-gateway.ts`, `ai-gateway-runtime-owner.ts`, `ai-gateway-proxy-headers.ts` + testy).
- Pozor: lokální proxy vrstva v packages/server dnes dělá i vlastní logiku (runtime authorization cache, abort aktivních requestů, session tracking) — při přímém napojení by se musela buď zahodit, nebo přesunout do gatewaye.

## Náměty na zjednodušení

1. **Zrušit fork `services/den/src/managed-ai`** — vybrat jednu implementaci (pravděpodobně standalone ai-gateway, je novější a bohatší) a druhou smazat; případně sdílet jako workspace balíček. Dopad: −9 500 řádků, konec dvojích oprav. Náročnost: střední (ověřit, že žádný deployment nespoléhá na embedded režim `MANAGED_AI_*`).
2. **Zásadní otázka: potřebuje local-first Veslo managed credential pool vůbec?** Pokud je cílem zjednodušení a uživatelé mohou přinést vlastní klíče (BYOK přímo do OpenCode configu), celá gateway (50k řádků vč. testů) se pro desktop stává volitelnou byznys službou, ne závislostí aplikace. Desktop by měl fungovat i bez ní — to už dnes platí (BYOK cesta existuje).
3. **Sloučit gateway do Den** (nebo naopak jasně oddělit) — dnes gateway na každý request 2× volá Den přes HTTP a admin API Den z velké části jen proxuje. Jedna služba = jeden deploy, jedna DB, žádné interní HTTP round-tripy. Náročnost: střední–vysoká, ale den/managed-ai ukazuje, že to tak už jednou bylo.
4. **Vyhodit Codex CLI ze serveru** — status probe přes spawnovanou binárku nahradit přímým HTTP voláním rate-limit hlaviček z inference odpovědí (už je gateway čte) nebo status endpointu. Dopad: −1 400 ř. nejkřehčího kódu + zmizí závislost `@openai/codex`. Náročnost: střední.
5. **Rozbít `admin.ts`** a přesunout org/billing/members/invites administraci do Den (tam data žijí); v gateway nechat jen credentials/usage/alerts/model-policy. Dopad: −2 000+ ř. Náročnost: střední.
6. **Sjednotit `deployment-endpoints.ts`** do jednoho sdíleného balíčku (6 kopií → 1). Náročnost: nízká.
7. **Smazat legacy dual-mount routy** a mrtvý OAuth authorize/exchange kód. Náročnost: nízká.
8. **Přidat streaming pass-through** pro openai/anthropic transporty (dnes buffering celých odpovědí). Náročnost: nízká–střední.

## Rizika

- **Neoficiální ChatGPT backend API** (`chatgpt.com/backend-api/codex/responses`) — OpenAI ho může kdykoli změnit/zablokovat; sdílení Codex OAuth účtů více uživateli je navíc pravděpodobně v rozporu s ToS. Byznys i technické riziko celé codex_oauth větve.
- **Centrální úložiště credentialů** — MySQL drží AES-GCM šifrovaná tajemství všech poolovaných účtů, klíč v env (`AI_GATEWAY_SECRET_KEY` má dev default `dev_only_...` — riziko úniku do špatně nakonfigurované produkce, `src/env.ts:15`).
- **Den jako single point of failure** — výpadek Den (session/entitlement) zastaví veškerou managed inference; cache jen 15 s.
- **Tichá divergence dvou implementací gatewaye** — už nastala; každý den bez rozhodnutí ji prohlubuje.
- **Pinovaná verze `@openai/codex` 0.144.5** — status probing i parsing výstupu se váže na konkrétní chování CLI.
- **Buffering odpovědí** (openai/anthropic) — dlouhé generace mohou narazit na proxy/klient timeouty.
- **Jakýkoli refaktoring táhne 26k řádků testů**, z nichž velká část testuje interní třídy místo HTTP kontraktu.
