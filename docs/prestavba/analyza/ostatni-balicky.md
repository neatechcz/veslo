# Analýza vedlejších balíčků: web, landing, e2e, docs, document-runtime, openwork

Rozsah: `packages/{web,landing,e2e,docs,document-runtime,openwork}`. Vše ověřeno čtením kódu, ne dokumentace. Datum: 2026-07-19.

---

## 1. Účel a rozsah

| Balíček | Skutečný účel (ověřeno v kódu) | Rozsah | Aktivita (commity za 12 měs.) |
|---|---|---|---|
| `web` | **Cloud aplikace** `app.veslo.work` — přihlášení proti Den, spouštění cloud workerů, billing (Polar), desktop auth handoff přes `veslo://` deep link. NENÍ to landing page (CLAUDE.md v kořeni pracovního adresáře je zde zastaralý). | ~4 500 řádků TS/TSX, 22 souborů | 53 |
| `landing` | **Marketingový web** `veslo.work` — homepage, download (čte GitHub releases), enterprise, den, waitlist formulář. | ~1 700 řádků, 18 souborů | 48 |
| `e2e` | **Hlavní regresní síť projektu** — Tauri Pilot scénáře (TOML) + Playwright testy Den admin UI + „live" testy s reálnými credentials. | ~18 400 řádků TS + ~12 900 řádků TOML (80 scénářů) + 21 MB PNG snapshotů | **225** (nejaktivnější) |
| `docs` | **Mintlify dokumentační web** — 10 MDX stránek (introduction, cli, quickstart, tutorials…), `docs.json`. Žádný build v CI. | 10 MDX + logo | 9 (poslední 2026-05-29) |
| `document-runtime` | **Manifest + updater kontrakt pro spravovaný dokumentový runtime** (soffice, pandoc, poppler, qpdf, weasyprint, Python, Node, fonty) distribuovaný jako podepsaný `.veslopkg`. CLI `veslo-document-runtime` (pack/install/stage/doctor). | ~3 150 řádků (z toho ~1 100 testy) + manifesty | 7 |
| `openwork` | **Mrtvé reziduum forku.** Jediný soubor: `docs/style-guide.md` — „OpenWork Style Guide" původního upstream projektu (OpenWork od Different AI). | 1 soubor | 1 (únor 2026) |

---

## 2. Architektura a klíčové soubory

### packages/web (cloud app)
- `components/cloud-control.tsx` — **3 348 řádků, jediná React komponenta** = 74 % celého balíčku. Obsahuje: sign-in/sign-up, e-mail verifikaci, forgot/reset password, výběr organizace, seznam a spouštění workerů (`POST /v1/workers`), billing shrnutí/faktury/checkout, tokeny workerů, desktop onboarding handoff (`/v1/desktop-auth/handoff` → redirect na `veslo://auth-complete?code=…`, řádek 1636).
- `app/api/den/[...path]/route.ts` (216 ř.) — Next.js server-side proxy na Den API (řeší CORS), s fallbackem na auth origin při 5xx.
- `app/api/loops/den-signup/route.ts` — zápis signup kontaktu do Loops.
- `lib/deployment-endpoints.ts` — odvození `api.<doména>` / `app.<doména>` z env `NEXT_PUBLIC_VESLO_DEPLOYMENT_DOMAIN`.
- `scripts/*.mjs` a `lib/*.test.ts` — viz sekce Duplicity a mrtvý kód (pseudo-testy).
- `pr/screenshots/billing-reliability-2026-03-01/` — PR artefakty commitnuté do repa.
- Nasazení: Vercel (`vercel.json`), CI buildí (`.github/workflows/ci.yml:38`).

### packages/landing (marketing)
- `app/page.tsx` (491 ř.), `app/download/page.tsx` (223 ř., čte GitHub releases přes `lib/github.ts`), `app/den/page.tsx`, `app/enterprise/page.tsx`, `app/starter-success/page.tsx`.
- `app/enteprise/page.tsx` — 5řádkový redirect překlepové URL na `/enterprise`.
- `components/opencode-logo.tsx` — jediná zmínka OpenCode, čistě brandová.
- Žádné sdílení kódu s `web` — dvě nezávislé Next.js 14.2.5 aplikace s duplicitní konfigurací (tailwind, postcss, next.config, tsconfig).

### packages/e2e (testovací infrastruktura)
Tři odlišné mechanismy v jednom balíčku:

1. **Tauri Pilot** (dominantní): desktop se buildí s `--features e2e` = `tauri-plugin-pilot/press` (`packages/desktop/src-tauri/Cargo.toml:9,25`, verze 0.7.2). Externí CLI `tauri-pilot` (v CI `cargo install tauri-pilot-cli --version 0.7.2`, `e2e-ui.yml:39`) komunikuje s aplikací přes unix socket `/tmp/veslo-pilot-<hash>/tauri-pilot-<id>.sock` (Windows: named pipe) — `helpers/app-launcher.ts:411–418`. Scénáře jsou **TOML soubory** (`pilot-scenarios/*.toml`, 80 ks, 12 908 řádků) s kroky `wait`/`assert-visible`/`eval`.
2. **Playwright** (4 specy): `den-admin-billing-{integrated,lifecycle,stripe-live}.playwright.spec.ts` a `live-admin-codex-auth-upload.playwright.spec.ts` — testují **Den admin web UI** na `http://127.0.0.1:8788`, ne desktop.
3. **Node test runner**: `.pilot.ts` specy (5 ks, programově spouštějí aplikaci + fixture servery) a `.test.ts` „meta-testy" (4 ks).

- `helpers/` (~45 souborů): launcher aplikace s izolovaným profilem, seed desktop auth, **fixture servery** — `skill-registry-fixture.ts`, `managed-ai-gateway-fixture.ts` (393 ř., mock AI gatewaye), `session-queue-runtime-fixture.ts`, `feedback-server.ts` (mock `/v1/feedback`), `veslo-server-process.ts` (spouští standalone `veslo-server` binary), redakce logů, JUnit výstup, run-store s historií.
- `helpers/pilot-runner.ts` — definice sad: `current-gate` = 25 scénářů (řádky 77–104), `live-inference` = 1, `live-inference-lifecycle` = 1. **Zbylých ~53 scénářů není v žádné sadě** — spouštějí se jen jednotlivě (per-script v package.json) nebo vůbec.
- `helpers/app-launcher.ts:69–75` — `APP_IDENTIFIERS` stále uklízí procesy legacy identit `com.differentai.openwork(.dev)` — pozůstatek forku.
- `__snapshots__/` — 67 PNG, **21 MB binárních dat v gitu** (vizuální regresní baseline).

### packages/docs
- Mintlify (`docs.json`), obsah: introduction, veslo, cli, opencode-router, quickstart, create-veslo-instance, 4 tutoriály, development. `cli.mdx` popisuje `npm install -g veslo` / `veslo-server` (CLI-first tok). Není v žádném CI workflow.

### packages/document-runtime
- `src/manifest.mjs` (310 ř.) — validace manifestu, package feedu (`neatechcz/veslo-updates`), dependency/license inventáře, CalVer porovnání.
- `src/runtime.mjs` (1 464 ř.) — jádro: `resolveActiveRuntime`, `buildManagedEnv` (PATH/PYTHONPATH bez mutace globálního prostředí), `doctor` (ověří soffice/pandoc/pdftoppm/…/Python importy/Node moduly/fonty), `packExpandedPackage`/`installPackageArchive` (vlastní formát `.veslopkg` = gzip NDJSON, ověření sha256), `execManaged`.
- `src/cli.mjs` — příkazy `pack|install|stage|doctor|path|exec`.
- **Živé, hluboko zapojené**: `packages/server/src/routes/document-runtime.ts` (HTTP routy `GET /document-runtime/status`, `POST /document-runtime/repair`, import `veslo-document-runtime` na ř. 3), `packages/app/src/app/lib/document-runtime.ts` (UI stav v settings/dashboard), Tauri release configy (`tauri.macos.*.release.conf.json` bundlují resources), `services/den` a ~15 release skriptů (`scripts/release/verify-document-runtime-*`).

### packages/openwork
- Pouze `docs/style-guide.md`. Odkazován jen z `.github/instructions/server.instructions.md:2` (applyTo glob) a `packages/app/pr/openwork-server.md`. Žádný kód, žádný package.json.

---

## 3. Komunikační vazby

| Odkud | Kam | Kanál | Popis |
|---|---|---|---|
| web (prohlížeč) | Den API | HTTP přes Next proxy `/api/den/*` | auth, `/v1/orgs`, `/v1/workers`, `/v1/workers/billing`, `/v1/me`, `/v1/desktop-auth/handoff` |
| web | desktop | **deep link `veslo://`** | `veslo://auth-complete?code=…` (onboarding handoff), `veslo://connect-remote?…` (připojení k workeru), `cloud-control.tsx:760,1636` |
| web | Loops API | HTTP (server-side) | signup kontakty |
| landing | GitHub API | HTTP (SSR) | releases + stargazers pro download stránku |
| e2e | desktop binary | **spawn procesu + unix socket / named pipe** | `tauri-pilot` CLI → tauri-plugin-pilot v aplikaci |
| e2e | webview aplikace | `eval` JS přes pilot | scénáře volají přímo `window.__TAURI_INTERNALS__.invoke` (Tauri IPC zevnitř testu) |
| e2e | veslo-server, Den, mock servery | HTTP | fixture servery (skill registry, AI gateway, feedback), Playwright na Den admin :8788 |
| e2e | souborový systém | soubory | izolovaný profil `.tmp-veslo-home`, seed workspace stavu, JUnit/artefakty |
| document-runtime | GitHub releases feed | HTTP | `installPackageFromFeed` z `neatechcz/veslo-updates` |
| document-runtime | lokální FS + child_process | soubory, spawn | staging `packages/<verze>`, `active.json`, spouštění soffice/pandoc/… |
| server → document-runtime | in-process import | import | routy `/document-runtime/*` |

---

## 4. Vazba na OpenCode

- **web, landing, docs, document-runtime, openwork: prakticky nulová.** Web mluví jen s Den API; landing má jen logo komponentu; document-runtime je zcela engine-agnostický; docs zmiňují `opencode-router` obsahově.
- **e2e: nepřímá, ale hluboká.** Scénáře netestují OpenCode API přímo, ale asserují chování celého stacku postaveného nad OpenCode (sessions, message roundtrip, managed AI model policy, skill registry). Výměna enginu by zneplatnila značnou část z 80 scénářů obsahově, nikoli mechanicky — samotný tauri-pilot mechanismus je engine-agnostický.

---

## 5. Hotspoty složitosti

1. **`web/components/cloud-control.tsx` (3 348 řádků, 1 komponenta)** — auth + org + workers + billing + desktop handoff v jednom `useState` monolitu. Jakákoli změna auth toku = editace obřího souboru. Závažnost: vysoká.
2. **JS programy vložené jako stringy v TOML scénářích** — např. `pilot-scenarios/global-managed-ai-model-policy.toml` (424 ř.) obsahuje desítky řádků JS v `action = "eval"` včetně přímých `window.__TAURI_INTERNALS__.invoke` volání. Žádný typecheck, žádný lint, ladí se přes regexové meta-testy. Závažnost: kritická pro udržovatelnost.
3. **Meta-testy testující text zdrojáků regexy** — `e2e/specs/gpt-5-6-sol-three-message-roundtrip.test.ts` (asserty `assert.match(scenario, /aiAccess\?\.provider === "codex_oauth"/)` na obsah TOML), `web/scripts/auth-email-flows.mjs`, `web/lib/owned-server-defaults.test.ts` (regexy na zdroják route.ts). Falešný pocit pokrytí, rozbijí se při každém refaktoru formulace. Závažnost: vysoká.
4. **Rozsah e2e infrastruktury** — 18 400 řádků TS helperů (vlastní runner, redakce, run-store, 4 fixture servery, JUnit generátor) + 3 paralelní testovací mechanismy (pilot TOML / Playwright / node:test) v jednom balíčku. 225 commitů za rok = největší údržbová zátěž ze všech šesti balíčků. Závažnost: vysoká.
5. **„Live" testy vyžadující reálné credentials** (Stripe live, Codex OAuth, YouTrack, platform admin heslo v defaultu — `den-admin-billing-integrated.playwright.spec.ts:7-8` má natvrdo `vaclav.soukup@neotech.cz` / `VesloAdmin123!`) smíchané s hermetickými testy. Závažnost: střední (+ bezpečnostní pach).
6. **21 MB PNG snapshotů v gitu** (`e2e/__snapshots__/`). Závažnost: nízká.

---

## 6. Duplicity a mrtvý kód

- **`packages/openwork` — celý mrtvý.** Jen style-guide upstream forku (OpenWork, Different AI). Smazat + vyčistit glob v `.github/instructions/server.instructions.md`.
- **Pseudo-testy web nejsou nikde zapojeny**: `test:font-source`, `test:desktop-auth-mode`, `test:auth-email-flows` (package.json web) ani `lib/*.test.ts` nejsou volány z CI ani z kořenových `check:*` skriptů (ověřeno grepem přes `.github/workflows` a root package.json).
- **~53 z 80 pilot scénářů není v žádné sadě** (`current-gate` má 25) — velká část jsou jednorázové regresní scénáře k uzavřeným ticketům (`vslo-171-*`, `vslo-235-*`, `vslo-270-*`, `vslo-271-*`), které se pravděpodobně nikdy nespouštějí.
- **Legacy identity forku** v `e2e/helpers/app-launcher.ts:69-75` (`com.differentai.openwork`).
- **web vs. landing**: nejde o obsahovou duplicitu (cloud app vs. marketing), ale o **duplicitní stack** — dvě samostatné Next.js aplikace se shodnou konfigurací a nulovým sdílením kódu; dvojí údržba dependencies.
- **`landing/app/enteprise/`** — překlepová routa (funkční redirect, ale kandidát na middleware).
- **`web/pr/screenshots/`** — PR artefakty v repu.
- **Zastaralá dokumentace**: kořenový CLAUDE.md pracovního adresáře označuje `web` za „Landing page"; `packages/docs` má 9 commitů za rok a poslední změnu z května 2026 — vysoká šance rozjetí s realitou.

---

## 7. Co by znamenalo oddělení BE/FE (API + SPA)

- **`packages/web` je důkaz, že model API+SPA už v projektu funguje**: je to čistý webový klient Den API (přes proxy), bez jediného Tauri importu. Desktop UI by po splitu vypadalo analogicky.
- **Největší výhra by byla v e2e**: celá tauri-pilot mašinerie (socket, TOML, eval-stringy, build desktopu s e2e feature, cargo install CLI v CI) existuje jen proto, že UI žije uvnitř Tauri webview. Kdyby UI bylo SPA nad HTTP API, 80–90 % scénářů by šlo přepsat jako standardní Playwright testy proti prohlížeči (typované, laditelné, bez custom runneru) a tauri-pilot by zbyl jen pro tenkou desktop slupku (okno, deep linky, tray).
- **document-runtime** se splitu netýká — je to backend/release záležitost; jen by jeho HTTP routy (`/document-runtime/*` na veslo-serveru) zůstaly součástí API kontraktu.
- **landing a docs** jsou splitu zcela neúčastné.
- **Pozor na `veslo://` handoff**: web → desktop deep link (`auth-complete`, `connect-remote`) je jediné místo, kde cloud web závisí na existenci desktop shellu; při splitu zůstává beze změny.

---

## 8. Náměty na zjednodušení

| Námět | Dopad | Náročnost |
|---|---|---|
| Smazat `packages/openwork` (+ glob v server.instructions.md) | −1 balíček, nulové riziko | triviální |
| Vyřadit z gitu 21 MB snapshotů (LFS nebo artefakt CI) | menší repo, rychlejší clone | nízká |
| Smazat pseudo-testy (web `scripts/*.mjs`, `lib/*.test.ts`, e2e regexové meta-testy) | −~1 000 řádků křehkého kódu bez reálného pokrytí | nízká |
| Archivovat ~53 pilot scénářů mimo sadu (ponechat current-gate 25) | −~8 000 řádků TOML, kratší CI, méně falešných baseline | nízká |
| Přesunout JS z TOML `eval` kroků do typovaných TS helperů (nebo rovnou na Playwright po BE/FE splitu) | typecheck+lint pro testovací logiku, konec regex meta-testů | střední |
| Rozbít/napsat znovu `cloud-control.tsx` (3 348 ř. → moduly auth/workers/billing) — nebo celý `web` odložit, pokud cloud workers a billing nejsou v „must keep" množině (workspace/agenti/skills/MCP tam nejsou) | výrazně nižší údržba cloud větve | střední |
| Sloučit `web` + `landing` do jedné Next.js aplikace (pokud web zůstává) | jedna konfigurace, jeden deploy, jedna sada dependencies | střední |
| Oddělit „live" testy (Stripe/Codex/YouTrack) do samostatného opt-in balíčku a odstranit natvrdo zapsané admin credentials | hermetické CI, čistší bezpečnost | nízká |
| docs: zmrazit nebo generovat z kódu; teď je to ruční Mintlify web bez CI, který zaostává | méně rozjeté dokumentace | nízká |

---

## 9. Rizika

1. **e2e je faktická hlavní regresní síť projektu** (AGENTS.md výslovně preferuje E2E testy). Jakékoli výrazné zjednodušení architektury zneplatní obsah scénářů — před přestavbou je nutné rozhodnout, kterých 20–30 scénářů tvoří skutečný kontrakt, a jen ty přenést.
2. **`web` nese produkční desktop onboarding** (`/v1/desktop-auth/handoff` → `veslo://auth-complete`). Nelze ho vyhodit, dokud desktop přihlášení závisí na `app.veslo.work`.
3. **document-runtime je zadrátovaný do release pipeline** (podpisy, feed `veslo-updates`, ~15 verify skriptů, Tauri bundle resources) — změny se propisují do releasu všech platforem.
4. **Externí závislost `tauri-pilot-cli` 0.7.2** instalovaná přes `cargo install` v CI — pin na konkrétní verzi cizího nástroje, který drží pohromadě celý e2e mechanismus.
5. **Pseudo-testy a mrtvé scénáře vytvářejí iluzi pokrytí** — reálně chráněná plocha je menší, než 31 000 řádků testovacího kódu naznačuje.
6. **Natvrdo zapsané admin credentials v testech** (`den-admin-billing-integrated.playwright.spec.ts:7-8`) — pokud odpovídají reálnému prostředí, jde o únik.
