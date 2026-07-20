# Analýza: services/den — identity/auth služba (control plane)

## Účel a rozsah

Den je **cloudová „control plane" služba** celého Vesla — Express + better-auth + Drizzle ORM nad **MySQL**, nasazovaná přes owned-server Compose stack (`packaging/owned-server/compose.yml`, služba `den` + `den-db` MySQL 8.4), veřejně dostupná jako `api.veslo.work` (výchozí doména `veslo.work` je zadrátovaná v `services/den/src/deployment-endpoints.ts:13`). **Neběží lokálně u uživatele** — desktop aplikace k ní přistupuje přes HTTPS (Tauri fetch, CORS allowlist `tauri://localhost`, `http://localhost:1420/1421` v `src/index.ts:132`).

Navzdory názvu „identity/auth" je Den ve skutečnosti **monolit s ~10 nesouvisejícími subsystémy**:

| Subsystém | Umístění | LOC | Co dělá |
|---|---|---|---|
| Auth (better-auth) | `src/auth.ts`, `src/auth/` | ~700 | e-mail+heslo, GitHub OAuth, signup gate (pozvánky, domény, seat limity) |
| Organizace | `src/orgs.ts`, `src/org-admin/`, `src/http/orgs.ts` | ~1 500 | orgs, členství, role, pozvánky, domény |
| Desktop auth handoff | `src/http/desktop-auth.ts` (466) + `desktop-auth-v2.ts` (653) + helpers | ~1 400 | v1 handoff kód + v2 PKCE transakce — **oba flow živé současně** |
| Skill registry | `src/skills/` | 6 596 | plnohodnotný registr skill balíčků: verze, review, approval, rollout policies, search |
| Managed AI runtime | `src/managed-ai/` | 9 483 | **fork služby `services/ai-gateway`** — proxy na OpenAI/Anthropic/Codex OAuth/Codex CLI, credentials, leases, usage accounting |
| Cloud workers | `src/http/workers.ts` (635), `src/workers/` (592) | ~1 200 | provisioning cloud workerů přes Render API / owned worker-manager, Vercel DNS vanity domény |
| Billing 2× | `src/billing/` | 2 877 | Polar (paywall cloud workerů) **a zároveň** Stripe (org billing managed AI) |
| Integrace/konektory | `src/google-workspace/`, `src/microsoft/`, `src/http/org-mcp-catalog.ts` | ~2 700 | OAuth ke Google Workspace a Microsoftu; **Den sám hostuje MCP servery** (SharePoint JSON-RPC v `src/microsoft/sharepoint-mcp.ts`, Google MCP proxy v `src/http/google-workspace.ts:238`) |
| Telemetrie | `src/debug-logs/`, `src/http/diagnostic-dumps.ts` | ~1 300 | šifrovaný ingest debug logů (AES, retence), streamované diagnostic dumpy |
| Feedback → YouTrack | `src/feedback/`, `src/integrations/youtrack-rest.ts` | ~570 | projekce bug reportů do YouTracku s retry smyčkou |
| Soul | `src/soul/`, `src/http/soul.ts` | ~650 | verzované „soul" dokumenty (org/user), konzumuje je veslo-server (`packages/server/src/soul-den-client.ts`) |
| Admin | `src/http/admin.ts` (1 224) + `admin-runtime.ts` (2 902) + `managed-ai/http/admin.ts` (1 631) + `public-admin/` (3 200) | ~9 000 | admin API + **ručně psaná vanilla-JS admin SPA** (`public-admin/app.js`, 2 799 řádků) |

**Rozsah:** `src/` = 36 689 řádků TS, `test/` = 28 796 řádků (109 souborů), `public/index.html` = 1 077 řádků (onboarding stránka s inline JS), `public-admin/` = ~3 200 řádků, 22 SQL migrací. Celkem ~66 k řádků, jak uvádí zadání.

## Architektura a klíčové soubory

- `src/index.ts` (1 190) — entry point. Mountuje ~25 routerů. Z toho **řádky 631–1168 jsou ručně psané runtime DDL** (`ensureTables`: `CREATE TABLE IF NOT EXISTS` + `ensureColumn` + `ensureIndex` + `ensureVarcharColumnMinimumLength` + `reconcileOrgMembershipRoleColumn`) — tj. schéma se spravuje **dvakrát**: v kódu při startu a paralelně v `drizzle/*.sql` migracích.
- `src/env.ts` (307) — **83 env proměnných** (Render, Vercel, Polar, Stripe, YouTrack, Lettr, Google, Microsoft, Codex, …). Sama konfigurační plocha je hotspot.
- `src/auth.ts` (319) — better-auth s Drizzle adaptérem, bearer plugin, databaseHooks pro signup gate; vlastní obálka `createAuthNodeHandler`, která čte raw body před better-auth (signup guard, invite tokeny přes base64 header `x-veslo-signup-invite-token`).
- `src/http/desktop-auth-v2.ts` — PKCE flow: desktop → `POST /v2/desktop-auth/start` → browser otevře `GET /?desktopOnboarding=1&tid=…` (inline HTML `public/index.html`) → redirect s kódem na `127.0.0.1:port` / `veslo://` → `POST /v2/desktop-auth/exchange`.
- `src/skills/store.ts` (2 142) — typy + **`InMemorySkillRegistryStore`** (kompletní paralelní implementace registru, použitá jen v testech); `src/skills/db-store.ts` (2 136) — DB verze téhož.
- `src/managed-ai/` — fork `services/ai-gateway` (viz Duplicity).
- `src/workers/provisioner.ts` (409) — tři režimy: `stub` / `render` (Render API + Vercel DNS) / `owned-server` (HTTP na worker-manager). Jediné místo v Denu, kde se objevuje slovo „opencode" (řádek 278, startovní příkaz workeru).

## Komunikační vazby

Vše je **HTTP/JSON** (žádné WebSockety/SSE ze strany Dena):

**Konzumenti Dena (příchozí):**
- `packages/app` (desktop UI) — `src/app/lib/den-auth.ts` (desktop auth v1+v2, `/v1/me`, Bearer token, výchozí base `deploymentServiceUrl("api")` = `https://api.veslo.work`), `lib/ai-access.ts`, skills registry (`/v1/skills*`, `/v1/skill-installations*`, `/v1/skill-rollout-policies*`), integrace (`/v1/orgs/:id/integrations/google|microsoft/...`), feedback (`/v1/feedback`). Auth snapshot se persistuje přes Tauri IPC příkazy `den_auth_snapshot_read/write`.
- `packages/server` (veslo-server sidecar) — `denApiBase` z configu (`src/config.ts:461`, env `VESLO_DEN_API_BASE`); volá MCP katalog + runtime tokeny (`src/routes/mcp.ts`), workspace skills (`src/routes/workspace-skills.ts`), soul (`src/soul-den-client.ts`).
- `packages/desktop` (Rust) — `src-tauri/src/debug_logs_forwarder.rs` posílá šifrované batch logy přímo do Dena (`post_direct_den_batch`, řádek 952; fallback `/v1/desktop-diagnostics`).
- `services/ai-gateway` — volá `/v1/internal/platform-admin-recipients` s interním tokenem `DEN_AI_GATEWAY_INTERNAL_TOKEN` (`src/index.ts:160`).
- `packages/web` (Next.js landing) — `components/cloud-control.tsx` volá `/v1/workers` (**jediný konzument celé cloud-workers funkce**); proxy `app/api/den/[...path]`.
- `packages/e2e` — seed skripty a fixture přes `VESLO_DEN_API_BASE`.

**Odchozí závislosti Dena:** MySQL (2 DB: den + volitelně managed-ai), YouTrack REST (feedback), Stripe API + webhook, Polar API, Render API, Vercel API (DNS), Lettr (e-maily), Google OAuth/API, Microsoft OAuth/Graph, OpenAI/Anthropic/Codex upstreamy (managed AI), owned worker-manager (interní HTTP).

## Vazba na OpenCode

**Prakticky nulová — Den je engine-agnostický.** Jediný výskyt: startovní příkaz cloud workeru v `src/workers/provisioner.ts:278` (`veslo serve … --opencode-port 4096`). Nepřímé vazby: (a) MCP katalog — Den vydává definice MCP serverů, které veslo-server zapisuje do OpenCode konfigurace workspace; (b) skills — balíčky, které se instalují do workspace. Výměna OpenCode enginu by Den nezasáhla vůbec (formát skill balíčků a MCP je engine-neutrální).

## Hotspoty složitosti

1. **Fork AI gateway uvnitř Dena** — `src/managed-ai/` (9 483 LOC) je divergentní kopie `services/ai-gateway` (17 396 LOC). Stejná adresářová struktura (access/alerts/audit/credentials/leases/providers/runtime/usage), ale rozjeté: env prefixy `MANAGED_AI_*` vs `AI_GATEWAY_*`, ai-gateway umí streaming, den kopie ho odmítá (`codex-cli-worker-transport.ts` diff). **Obě běží v produkci současně** (compose: `den` s `MANAGED_AI_*` env + samostatná služba `ai-gateway`), desktop volá gateway přes veslo-server proxy (`packages/server/src/routes/ai-gateway.ts`).
2. **Dvojí správa DB schématu** — runtime DDL v `src/index.ts:631–1168` + 22 drizzle migrací + „schema-reconcile" heuristiky. Každá změna tabulky se dělá na dvou místech.
3. **Dva souběžné desktop-auth protokoly** — v1 handoff i v2 PKCE, oba mountované (`index.ts:226–227`), aplikace volá oba.
4. **Dvě billing integrace** — Polar (paywall cloud workerů, `billing/polar.ts` 732 LOC) a Stripe (org billing, ~1 900 LOC vč. webhooků).
5. **Trojitá admin vrstva** — `http/admin.ts` (kontrakt) + `http/admin-runtime.ts` (2 902) + `managed-ai/http/admin.ts` (1 631) + ručně psaná vanilla-JS SPA `public-admin/app.js` (2 799). Admin router je navíc mountovaný 2× (`/v1/admin` i `/admin/api`, `index.ts:228–229`).
6. **Onboarding stránka jako 1 077řádkový inline HTML** (`public/index.html`) — sign-in/sign-up/reset/verifikace v jednom souboru bez buildu.
7. **Testovací antipattern „source testy"** — 29 ze 109 testovacích souborů čte zdrojáky přes `readFileSync` a assertuje **regexy nad textem kódu** (např. `test/root-route-source.test.ts`: `assert.match(denSource, /app\.get\("\/"/)`). Každý refaktor je rozbije, i když se chování nezmění — přímá příčina toho, že „AI-asistovaný vývoj selhává".
8. **83 env proměnných** v jedné službě (`src/env.ts`).

## Duplicity a mrtvý kód

- `src/managed-ai/` ↔ `services/ai-gateway/src/` — ~9,5 k řádků forku (viz výše). Největší duplicita v celém repu.
- `deployment-endpoints.ts` — **5 kopií** s odlišnými md5: `services/den/src/`, `services/ai-gateway/src/`, `packages/server/src/`, `packages/app/src/app/lib/`, `packages/web/lib/`.
- `InMemorySkillRegistryStore` (`src/skills/store.ts:485`, ~1 700 řádků) — plnohodnotná paralelní implementace registru používaná **jen v testech**; obdobně `src/soul/store.ts` vs `soul/db-store.ts`.
- **Cloud workers stack je z pohledu desktop produktu mrtvý** — `/v1/workers` konzumuje jedině `packages/web/components/cloud-control.tsx` (Next.js web, který dle AGENTS.md nesmí být runtime). README (řádky 228–232) uvádí, že Render deploy je „retired"; Render+Vercel kód (provisioner, vanity-domain, worker-token šifrování) zůstává.
- Polar billing — vázaný výhradně na (mrtvý) cloud-workers paywall, feature gate default `false`.
- Desktop-auth v1 — legacy vůči v2 PKCE, stále mountovaný a volaný.
- Dvojitý mount admin routeru (`/v1/admin` + `/admin/api`).

## Co by znamenalo oddělení BE/FE

Den **už je** čistý web-model (API + oddělené UI) — přesně architektura, ke které vlastník směřuje. Při rozdělení zbytku aplikace na API+SPA by Den nevyžadoval žádnou změnu; SPA by ho volala stejně jako dnes desktop. Relevantní otázka není „jak Den oddělit", ale **„kolik z Dena produkt vůbec potřebuje"**. Minimální jádro pro zachované funkce (workspace, agenti, skills, MCP) je: auth + orgs + desktop handoff (v2) + skill registry + MCP katalog/konektory — tj. řádově ~12–15 k LOC z 36 k. Zbytek (managed AI fork, cloud workers, Polar, debug logs, feedback→YouTrack, soul, admin SPA) je provozní infrastruktura firmy, ne produkt.

## Náměty na zjednodušení

1. **Smazat `src/managed-ai/` a nechat jediný AI gateway** (`services/ai-gateway`) — okamžitě −9,5 k LOC + polovina env proměnných; nutné přesměrovat interní admin UI na gateway admin. Náročnost: střední.
2. **Vyhodit cloud workers + Polar + Render + Vercel** (workers.ts, workers/, billing/polar.ts, části env) — −~2,5 k LOC; jediný konzument je zakázaná Next.js web app. Náročnost: nízká.
3. **Zrušit runtime DDL a nechat jen drizzle migrace** — −~550 řádků v index.ts a konec dvojí údržby schématu. Náročnost: nízká–střední (nutná jistota, že migrace pokrývají produkce).
4. **Zrušit desktop-auth v1**, ponechat jen v2 PKCE (po ověření, že žádný starý klient v1 nepoužívá). Náročnost: nízká.
5. **Smazat „source testy"** (29 souborů regexpujících zdrojáky) a nahradit je HTTP kontraktními testy — zásadně to odblokuje refaktoring a AI-asistovaný vývoj. Náročnost: nízká.
6. **Sjednotit `deployment-endpoints.ts` do sdíleného balíčku** (5 kopií → 1). Náročnost: nízká.
7. **Zvážit nahrazení auth vrstvy hotovým řešením** — better-auth už hotové je, ale obalené ~5 k LOC vlastní logiky (signup gate, seat limity, domény, invite tokeny přes base64 hlavičky). Pokud produkt nepotřebuje enterprise org-správu, lze zredukovat na e-mail+heslo / OAuth + jednoduchou org tabulku. Alternativně Keycloak/Clerk/Supabase Auth — desktop PKCE handoff by ale zůstal vlastní.
8. **Rozhodnout o volitelnosti Dena pro local-first režim** — dnes je Den tvrdá závislost pro start desktopu (onboarding/přihlášení). Pro „BYO API key" uživatele by aplikace mohla fungovat úplně bez Dena; to by byl největší krok ke zjednodušení celého produktu.

## Rizika

- **Produkční data** — MySQL s reálnými uživateli, šifrovanými OAuth granty a Stripe stavem; jakékoli mazání subsystémů vyžaduje migrační/deprekační plán, ne jen smazání kódu.
- **Divergence forku managed-ai** — čím déle obě kopie žijí, tím dražší sjednocení (env prefixy, streaming, mysql schémata už se liší).
- **Runtime DDL maskuje drift schématu** — produkce může mít schéma, které neodpovídá ani migracím, ani kódu; před úklidem je nutný audit skutečného stavu DB.
- **Source testy dávají falešný pocit pokrytí** — po jejich smazání se ukáže, kolik chování reálně testy nekryjí.
- **Bezpečnostní plocha** — Den drží šifrovací klíče (debug logy, OAuth tokeny, worker tokeny) a interní tokeny mezi službami; konsolidace vyžaduje pečlivou rotaci.
- **Desktop handoff je křehký bod UX** — změny v auth flow rozbijí přihlášení všech nainstalovaných klientů (v1/v2 kompatibilita).
