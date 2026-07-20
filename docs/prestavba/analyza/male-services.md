# Analýza malých services: worker-manager, openwork-share, den-worker-runtime

Analyzované adresáře:
- `services/worker-manager`
- `services/openwork-share`
- `services/den-worker-runtime`

Klíčová otázka zadání: co to je, je to živé, kdo to používá, souvisí to s „remote" funkcionalitou?

**Stručná odpověď:** Všechny tři jsou součástí cloudové/„remote" vrstvy Vesla, ne lokálního jádra. `worker-manager` a `den-worker-runtime` slouží výhradně k provozu **hostovaných vzdálených workerů** (vzdálená práce). `openwork-share` je veřejná služba pro **sdílení konfiguračních bundlů** (skills, workspace profily) přes odkaz. Všechny tři jsou formálně „živé" (testy běží v root `pnpm check:unit`, worker-manager se aktivně deployuje přes GitHub Actions), ale žádná z nich není potřebná pro lokální desktopovou funkčnost (workspace, agenti, skills, MCP).

---

## 1. Účel a rozsah

### 1.1 worker-manager (`services/worker-manager`)
- **Co to je:** Malý Express HTTP server (Node.js, závislosti pouze `express` + `zod` — `services/worker-manager/package.json`), který na serveru provozovatele („owned-server" stack) spravuje Docker kontejnery se vzdálenými workery a zároveň dělá reverzní proxy z veřejné wildcard domény na tyto kontejnery.
- **Rozsah:** ~650 řádků TS (`src/index.ts` 9, `src/app.ts` 293, `src/docker.ts` 348, `test/worker-manager.test.ts` 181).
- **Živé:** ANO. Deployuje se přes `.github/workflows/deploy-owned-server.yml:115-121` (`compose build worker-runtime-image worker-manager ...`), běží jako služba v `packaging/owned-server/compose.yml:48-77`. Testy jsou zapojené do root `package.json:22` (`pnpm --filter @neatech/worker-manager test`). Poslední změny 2026-07-16.
- **Remote:** ANO, 100 % — existuje jen kvůli hostovaným vzdáleným workerům.

### 1.2 openwork-share (`services/openwork-share`, npm název `veslo-share-service`)
- **Co to je:** Miniaturní publikační služba „share link" bundlů, určená pro nasazení na **Vercel** (serverless funkce v `api/`, úložiště Vercel Blob). Čistý JavaScript bez TypeScriptu, bez build kroku (`package.json`: build je jen `console.log('veslo-share: no build step')`).
- **Rozsah:** ~1 180 řádků JS, z toho **936 řádků je jediný soubor** `api/b/render-bundle-page.js` — HTML šablona sdílecí stránky s inline CSS.
- **Živé:** ANO. Desktop aplikace na ni napevno míří (`packages/app/src/app/lib/publisher.ts:7` — `DEFAULT_VESLO_PUBLISHER_BASE_URL = "https://share.veslo.neatech.com"`). `docs/dev/cloud-deployments.md:38` potvrzuje, že „Public bundle publishing is still served by the separate share service". Testy (`api/b/render-bundle-page.test.js`) běží v root `check:unit`.
- **Remote:** Nepřímo — sdílí konfigurace; deep link z share stránky má intent `new_worker`, takže ústí do vytvoření workeru v aplikaci.

### 1.3 den-worker-runtime (`services/den-worker-runtime`)
- **Co to je:** **Není to kód.** Adresář obsahuje jediný soubor — pětiřádkový `README.md`. Slouží výhradně jako `rootDir` kotva pro deploy vzdálených workerů na **Render.com**: Den provisioner vytváří Render web service s `rootDir: services/den-worker-runtime` (`services/den/src/env.ts:221`, default `"services/den-worker-runtime"`), buildCommand `npm install -g veslo-orchestrator@<verze>` a startCommand `veslo serve ...` (`services/den/src/workers/provisioner.ts:276-308`). Samotný runtime se tedy stahuje z npm, adresář v repu je prázdná skořápka.
- **Živé:** Formálně ano (Render režim provisioneru existuje a `packaging/owned-server/compose.yml:157` má dokonce `PROVISIONER_MODE: ${PROVISIONER_MODE:-render}` jako default), ale fakticky **zatuchlé**: pinovaná verze `veslo-orchestrator@0.11.113` (`services/den/src/env.ts:224`, `packaging/owned-server/env.example:62`) je z doby před přechodem na CalVer — aktuální orchestrátor má verzi `2026.7.12` (`packages/orchestrator/package.json`). Poslední commit v adresáři je z 2026-03-20. Render worker nasazený dnes by běžel s ~4 měsíce starým, zcela jinak verzovaným orchestrátorem.
- **Remote:** ANO, 100 % — existuje jen kvůli Render provisioningu vzdálených workerů.

---

## 2. Architektura a klíčové soubory

### 2.1 worker-manager

| Soubor | Role |
|---|---|
| `src/index.ts` | Entry point: načte env config, vytvoří Docker adaptér, spustí Express na portu (default 8790) |
| `src/app.ts` | HTTP vrstva: auth, routy, wildcard-host reverzní proxy |
| `src/docker.ts` | `DockerWorkerAdapter` — přímé volání Docker Engine API přes Unix socket (vlastní `http.request` na `/var/run/docker.sock`, žádný dockerode) |

**Routy** (`src/app.ts`):
- `GET /health` (řádek 167) — liveness.
- `GET /tls/ask` (řádek 171) — validace domény pro **Caddy on-demand TLS** (`packaging/owned-server/Caddyfile:3-4` — `ask http://worker-manager:8790/tls/ask`; wildcard blok `https://*.workers.veslo.work` na řádku 23).
- `POST /workers`, `GET /workers/:id`, `DELETE /workers/:id` (řádky 191-236) — interní API chráněné Bearer tokenem (`OWNED_WORKER_MANAGER_TOKEN`). Vytvoří Docker volume + kontejner, počká na health, vrátí `{ id, provider: "owned-server", url, status }`.
- **Catch-all** (řádek 238) — pokud Host hlavička odpovídá `<workerId>.workers.veslo.work`, proxuje požadavek na `http://veslo-worker-<id>:8787` uvnitř Docker sítě (`proxyToWorker`, řádek 266). Pozn.: čisté HTTP pipe, **bez podpory WebSocket upgrade**.

**Životní cyklus workeru** (`src/docker.ts`):
- `ensureWorker` (řádek 155): volume `veslo-worker-<id>-workspace` → kontejner `veslo-worker-<id>` → start → polling health až 180 s.
- Kontejner (řádek 111-140) dostane env `VESLO_TOKEN`, `VESLO_HOST_TOKEN`, `DEN_WORKER_ID` a **Cmd** (řádek 120-127): `veslo serve --workspace /workspace --veslo-port 8787 --opencode-host 127.0.0.1 --opencode-port 4096 ... --allow-external --veslo-server-bin /app/packages/server/dist/cli.js --no-veslo-code-router`.
- Image workeru: `veslo-owned-server-worker-runtime:local`, buildí se z `packaging/owned-server/Dockerfile` target `worker-runtime` — tam se z repa zkompiluje `veslo-server` a `veslo-orchestrator` a vytvoří wrapper `/usr/local/bin/veslo` (bun).

### 2.2 openwork-share

| Soubor | Role |
|---|---|
| `api/v1/bundles.js` | `POST /v1/bundles` — validace JSON (limit 5 MB), uložení do Vercel Blob pod `bundles/<ulid>.json`, vrací `{ url: "<base>/b/<id>" }` |
| `api/b/[id].js` | `GET /b/:id` — stáhne blob, podle Accept/`?format=json` vrátí buď JSON (i s `?download=1`), nebo HTML stránku |
| `api/b/render-bundle-page.js` | 936řádková HTML šablona: tlačítko „Open in App" (`veslo://import-bundle?veslo_bundle=<url>&veslo_intent=new_worker&veslo_source=share_service`), web fallback na `PUBLIC_VESLO_APP_URL`, kopírování odkazu, JSON preview |
| `api/health.js` | health endpoint |
| `vercel.json` | rewrites `/b/*` → `/api/b/*`, `/v1/*` → `/api/v1/*` |

**Typy bundlů** (dle README a parseru): `skill`, `skills-set`, `workspace-profile`. Odkazy jsou **veřejné, neautentizované, nešifrované** — jediná ochrana je neuhodnutelnost ULID (README řádky 77-78).

### 2.3 den-worker-runtime
Jediný soubor `README.md` (5 řádků): „Render worker services use this directory as rootDir. The control plane installs veslo-orchestrator and launches workers with the veslo command." Nic víc — žádný package.json, žádný kód.

---

## 3. Komunikační vazby

### worker-manager
| Protistrana | Kanál | Popis |
|---|---|---|
| Den (`services/den/src/workers/provisioner.ts:96-115, 247-270, 364-370`) | HTTP REST (Bearer) | Den v režimu `PROVISIONER_MODE=owned-server` volá `POST/DELETE /workers` při vytváření/rušení workeru |
| Docker daemon | HTTP přes Unix socket (`/var/run/docker.sock`) | create/start/stop/delete kontejnerů a volumes; kontejner s docker.sock namountovaným (compose.yml:56) |
| Worker kontejnery | HTTP (interní Docker síť) | health probe `http://veslo-worker-<id>:8787/health`; reverzní proxy veškerého provozu z veřejné domény |
| Caddy proxy | HTTP | `GET /tls/ask` — schvalování on-demand TLS certifikátů pro `*.workers.veslo.work` |
| Desktop app / prohlížeč | HTTPS (přes Caddy) | Klient se připojuje na `https://<workerId>.workers.veslo.work` → proxy → veslo-server (port 8787) ve workeru |

### openwork-share
| Protistrana | Kanál | Popis |
|---|---|---|
| Desktop app (`packages/app/src/app/lib/publisher.ts:49`) | HTTPS REST | `POST /v1/bundles` při sdílení skillu/workspace profilu (volá `workspace-share-controller.ts`) |
| Desktop app (`packages/app/src/app/context/app-deep-link-workflow.ts:210-331`, `lib/deep-links.ts:47-54`) | deep link `veslo://` + HTTPS GET | Stránka `/b/:id` otevře `veslo://import-bundle?veslo_bundle=...`; app pak bundle stáhne přes `?format=json` |
| UI import přes URL (`packages/app/src/app/pages/skills.tsx:3180`) | HTTPS GET | uživatel vloží `https://share.veslo.neatech.com/b/...` ručně |
| Vercel Blob | HTTPS (SDK `@vercel/blob`) | put/head/fetch JSON blobů |

### den-worker-runtime
| Protistrana | Kanál | Popis |
|---|---|---|
| Render.com | soubory v git repu | Render klonuje `neatechcz/veslo` a použije adresář jako `rootDir`; build = `npm install -g veslo-orchestrator@0.11.113`, start = `veslo serve` (`services/den/src/workers/provisioner.ts:276-308`) |

**Souhrn kanálů:** čisté HTTP/HTTPS + Unix socket + deep link (custom URL scheme) + git soubory. Žádné Tauri IPC, žádné WebSockety, žádné SSE (SSE stream OpenCode enginu ale teče *skrz* proxy worker-manageru — a ta streamování zvládá díky `pipe`, na rozdíl od WebSocketů).

---

## 4. Vazba na OpenCode

**Nepřímá, ale konstitutivní pro workery.** Žádný z těchto tří service neimportuje OpenCode SDK ani nevolá OpenCode API. Vazba je zapečená v příkazové řádce, kterou spouštějí:

- worker-manager vkládá do kontejneru Cmd `veslo serve ... --opencode-host 127.0.0.1 --opencode-port 4096` (`src/docker.ts:126`) — tj. každý vzdálený worker interně spouští **OpenCode engine** přes veslo-orchestrator.
- Totéž dělá Dockerfile target `worker-runtime` (default CMD) a Den Render provisioner (`provisioner.ts:278`).
- openwork-share je na enginu zcela nezávislá (jen JSON bloby + HTML).

**Výměna enginu** by tyto tři services téměř nezasáhla: stačilo by změnit spouštěcí příkaz kontejneru (1 řádek v `docker.ts`, 1 v Dockerfile, 1 v Den provisioneru) a npm balíček pro Render. Celý mechanismus (Docker orchestrace, wildcard proxy, TLS, share bundly) je engine-agnostický.

---

## 5. Hotspoty složitosti

1. **`api/b/render-bundle-page.js` (936 řádků)** — jediný soubor tvoří 80 % kódu openwork-share; ručně psaná HTML/CSS šablona s duplikovanou designovou řečí aplikace (barvy, karty, toasty). Netestovatelná vizuálně, drift vůči skutečnému UI zaručen.
2. **Trojí definice spouštěcího příkazu workeru** — `veslo serve` s mírně odlišnými parametry na třech místech (viz Duplicity). Kdo mění chování workeru, musí vědět o všech třech.
3. **Vlastní Docker klient** (`src/docker.ts:297-347`) — ručně psané HTTP přes Unix socket včetně parsování odpovědí a akceptovaných status kódů. Funkční, ale je to ~50 řádků infrastrukturního kódu, který by jinak řešila knihovna; každá změna Docker API se ladí ručně.
4. **Reverzní proxy bez WebSocket podpory** (`src/app.ts:266-293`) — `http.request` + pipe zvládne SSE, ale ne WS upgrade. Pokud by klient workeru někdy potřeboval WebSocket, proxy tiše selže.
5. **Tři režimy provisioneru** (stub / render / owned-server) s třemi různými defaulty: `env.ts:208` default `stub`, `compose.yml:157` default `render`, produkční owned-server stack potřebuje explicitně `owned-server`. Snadná dezorientace, který režim kde vlastně běží.

---

## 6. Duplicity a mrtvý kód

1. **Příkaz `veslo serve` 3×** (drift už nastal — liší se porty, `--allow-external`, `--veslo-server-bin`, retry logika):
   - `services/worker-manager/src/docker.ts:126` (Cmd kontejneru),
   - `packaging/owned-server/Dockerfile` target `worker-runtime` (default CMD — worker-manager ho ale stejně přepisuje vlastním Cmd, takže CMD v Dockerfile je fakticky mrtvý),
   - `services/den/src/workers/provisioner.ts:277-283` (Render startCommand).
2. **Logika worker-URL/domén 2×** — `publicWorkerUrl`/`resolveWorkerIdFromHost` ve worker-manageru vs. `customDomainForWorker` + vanity-domain logika v Den (`services/den/src/workers/vanity-domain.ts`).
3. **Render provisioning cesta = kandidát na mrtvý kód**: pin `veslo-orchestrator@0.11.113` vs. aktuální `2026.7.12` znamená, že Render worker by dnes běžel s prehistorickou verzí — buď to nikdo nepoužívá, nebo to je rozbité. S ní by odešel i celý adresář `den-worker-runtime`, ~140 řádků Render kódu v `provisioner.ts`, Vercel DNS vanity logika a sada env proměnných `RENDER_*` (compose.yml:162-176).
4. **`stub` režim provisioneru** (`provisioner.ts:355-361`) — vrací fiktivní URL `https://workers.local/<id>`; užitečné jen pro testy, v produkci mrtvá větev.
5. **Názvová duplicita openwork/veslo** — adresář `openwork-share`, balíček `veslo-share-service`, doména `share.veslo.neatech.com`, plánovaná `share.veslo.work` (docs/dev/cloud-deployments.md:38), legacy `ow_*` parametry v `connection.ts:133-141`. Pozůstatky rebrandingu.

---

## 7. Co by znamenalo oddělení BE/FE (web model API + SPA)

- **worker-manager je pro tento scénář naopak vzor:** vzdálený worker JE přesně model „backend API (veslo-server + OpenCode v kontejneru) + tenký klient přes HTTPS". Aplikace se k němu už dnes připojuje čistě přes URL + token (`packages/app/src/app/stores/remote-store.ts`, `workspaceType: "remote"`, `remoteType: "veslo"`). Pokud by celé Veslo přešlo na API + SPA, lokální režim by se stal jen „workerem na localhostu" a rozdíl local/remote by z UI z velké části zmizel.
- **openwork-share** je na architektuře aplikace nezávislá — jediné pouto je deep link `veslo://import-bundle`, který u čistého SPA nefunguje; web fallback (`?veslo_bundle=` na app URL) už ale existuje (`render-bundle-page.js:77-106`), takže přechod na SPA by share flow spíše zjednodušil.
- **den-worker-runtime** — bez dopadu; buď se smaže s Render cestou, nebo zůstane jako deploy kotva.
- Pozor na proxy: při BE/FE oddělení s reálným provozem přes `worker-manager` proxy bude potřeba doplnit WebSocket podporu, pokud by nový frontend WS používal (dnes vše jede přes HTTP/SSE, takže to zatím nevadí).

---

## 8. Náměty na zjednodušení

1. **Rozhodnout osud „remote workers" jako produktu.** Pokud vzdálení hostovaní workeři nejsou v jádru vize, smazat `worker-manager`, `den-worker-runtime`, Render+owned-server větve v `services/den/src/workers/`, workerové části `packaging/owned-server/` a `.github/workflows/deploy-owned-server.yml`. Lokální funkce (workspace, agenti, skills, MCP) na tom nijak nezávisí. Úspora: ~650 řádků TS + ~550 řádků Den provisioner/testů + Docker/Caddy/compose komplexita + celá provozní infrastruktura.
2. **Pokud remote zůstává: zrušit Render cestu, nechat jen owned-server.** Render pin `0.11.113` je stejně nefunkční vůči dnešní verzi. Smaže se `den-worker-runtime`, `provisionWorkerOnRender`, `deprovisionWorker` Render větev, vanity-domain/Vercel DNS logika a `RENDER_*`/`VERCEL_*` env. Jeden provisioner = jedna pravda.
3. **Sjednotit spouštěcí příkaz workeru na jedno místo** — nechat Cmd definovaný pouze v Dockerfile (worker-runtime target) a z worker-manageru posílat jen env proměnné; zmizí drift tří kopií.
4. **openwork-share: zvážit nahrazení prostým export/import JSON souborem** v aplikaci (soubor .veslobundle). Sdílení přes hostovanou službu je hezké, ale vyžaduje provoz Vercel projektu, Blob storage a údržbu 936řádkové HTML šablony. Minimálně tu šablonu radikálně zkrátit (stačí titulek + tlačítko + odkaz na JSON).
5. **Srovnat defaulty `PROVISIONER_MODE`** (env.ts `stub` vs. compose `render`) na jednu explicitní hodnotu, ideálně bez fallbacku.

---

## 9. Rizika

1. **Bezpečnost worker-manageru:** kontejner má namountovaný `/var/run/docker.sock` (compose.yml:56) — kompromitace worker-manageru = root na hostiteli. Interní API chrání jediný sdílený Bearer token.
2. **Veřejné share bundly bez autentizace:** kdokoli s URL čte obsah; bundle typu `workspace-profile` obsahuje konfiguraci vč. MCP/OpenCode nastavení — riziko úniku citlivých hodnot, pokud je uživatel omylem zahrne (README to jen konstatuje, aplikace to nevynucuje).
3. **Render cesta je pravděpodobně rozbitá** (pin 0.11.113) a přitom je defaultem v compose — omyl v konfiguraci vede k provisioningu nefunkčních workerů.
4. **Proxy bez WS a bez timeoutů** — dlouhé spojení na mrtvý kontejner drží socket; žádné limity počtu workerů na hostiteli (DoS na Docker daemon při chybě control plane).
5. **Smazáním „remote" větve se rozbijí testy** zapojené v root `check:unit` (worker-manager, veslo-share-service, den owned-server/render testy) — nutné čistit současně.
6. **Deep link `veslo://import-bundle`** je vstupní bod z internetu do desktop aplikace; parser (`deep-links.ts`) je jednoduchý, ale při zjednodušování je třeba ho nezapomenout jako attack surface.
