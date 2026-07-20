# Analýza: packages/opencode-router (veslo-code-router)

## Účel a rozsah

Balíček `packages/opencode-router` (npm jméno `veslo-code-router`, verze 2026.7.12) je **messaging most Telegram + Slack → OpenCode engine**. Příchozí zprávu z chatu přeloží na OpenCode session prompt v konkrétním adresáři (workspace) a odpověď modelu pošle zpět do chatu. WhatsApp byl odstraněn — zbyly po něm jen pozůstatky (viz mrtvý kód). Popis v kořenovém CLAUDE.md monorepa („Telegram/Slack/WhatsApp") je tedy zastaralý.

Rozsah kódu:

- `src/` — **~5 800 řádků TS** ve 14 souborech
- `test/` — ~1 520 řádků (8 souborů, node:test + bun, poměrně slušné pokrytí: e2e bridge s fake adaptery, multiworkspace, health-send, permission fallbacky)
- `scripts/`, `script/` — ~290 řádků (setup, smoke, build binárky přes `bun build --compile`)
- Integrační kód v **jiných balíčcích navíc ~4 000 řádků**: `packages/server/src/routes/opencode-router.ts` (1 567), `packages/desktop/src-tauri/src/commands/opencode_router.rs` (576) + `opencode_router/` (157), `packages/app/src/app/pages/identities.tsx` (1 494, **mrtvá**), `packages/app/src/app/lib/veslo-server-domains/messaging-identities.ts` (315), části `packages/orchestrator/src/cli.ts`.

Kompiluje se přes `bun build --compile` na samostatnou binárku — je to **jeden z 5 sidecar binaries** Tauri aplikace (`veslo-code-router`). Publikuje se i na npm (installer `install.sh`, `npx veslo-code-router`).

## Architektura a klíčové soubory

| Soubor | Řádky | Role |
|---|---|---|
| `src/bridge.ts` | 2 396 | Jádro. `startBridge()` je **jedna funkce ~2 100 řádků** se zanořenými closures: správa adaptérů, routing (channel, identityId, peerId) → directory, SSE event stream, health-server handlery (~750 řádků inline), Telegram pairing gate, chat commandy (`/opus`, `/codex`, `/model`, `/reset`, `/pair`, `/dir`, `/agent`, `/help`) |
| `src/cli.ts` | 635 | Commander CLI: `start/serve/health/status/config/telegram/slack/bindings/send` |
| `src/health.ts` | 699 | Ručně psaný `node:http` control server: `/health`, `/send`, `/bindings`, `/identities/telegram|slack`, `/config/groups` + legacy aliasy |
| `src/config.ts` | 296 | Env + JSON config `~/.veslo/opencode-router/opencode-router.json`, migrace legacy single-bot → multi-bot formátu |
| `src/telegram.ts` | 440 | Adaptér: grammY long-polling, stahování médií, skupiny jen při @mention |
| `src/slack.ts` | 459 | Adaptér: Socket Mode (WebSocket) + Web API, vlákna přes `peerId = C123|thread_ts` |
| `src/db.ts` | 260 | `bun:sqlite` — tabulky `sessions`, `bindings`, `allowlist`, `settings` v `~/.veslo/opencode-router/opencode-router.db` + in-place migrace schémat |
| `src/media.ts`, `src/media-store.ts` | 337 | Inbound média do `<workspace>/.opencode-router/media`, outbound validace souborů |
| `src/opencode.ts` | 43 | Tovární funkce OpenCode SDK klienta (Basic auth) + permission rules |
| `src/delivery.ts` | 157 | Klasifikace chyb doručení + retry s exponenciálním backoffem |
| `src/events.ts` | 34 | Normalizace OpenCode v2 „sync" event obálek (strip `.N` schema suffixů) |

Datový tok: chat → adaptér → `handleInbound()` (bridge.ts:1867) → pairing gate / commandy → lookup binding v SQLite → `session.create`/reuse → `session.prompt` s wrapper promptem (instrukce z `<workspace>/.opencode/agents/opencode-router.md` + defaultní messaging instrukce) → text odpovědi zpět adaptérem. Paralelně SSE stream (`event.subscribe`) hlásí tool-cally, permission requesty a stav session.

## Komunikační vazby

1. **Telegram Bot API** — HTTPS long-polling (grammY) + download souborů (`api.telegram.org/file/bot<token>/...`, telegram.ts:191).
2. **Slack** — WebSocket (Socket Mode) pro příjem, HTTPS Web API pro odesílání.
3. **OpenCode engine** — HTTP (`session.create`, `session.prompt`, `permission.reply`, `global.health`) + **SSE** (`client.event.subscribe`, bridge.ts:1661), Basic auth z `OPENCODE_SERVER_USERNAME/PASSWORD`, per-directory cache klientů (bridge.ts:431).
4. **Vlastní control/health HTTP server** na `127.0.0.1:<port>` (default 3005; Tauri i orchestrator přidělují náhodný volný port). Přes něj router ovládá zbytek systému.
5. **veslo-server → router**: dvě cesty současně —
   a) generická reverse proxy `/opencode-router/*` a `/w/:id/opencode-router/*` → health server (server.ts:558–863);
   b) 13 dedikovaných rout `/workspace/:id/opencode-router/...` (routes/opencode-router.ts), které **zapisují přímo do config souboru routeru** (`persistOpenCodeRouterTelegramIdentity` atd.) a teprve pak POSTují na health server, aby se změna aplikovala.
6. **Sdílené soubory**: JSON config a SQLite DB v `~/.veslo/opencode-router/` — zapisují do nich **dva různé procesy** (router i veslo-server) bez zámků.
7. **Spouštění (2 nezávislé cesty!)**:
   a) orchestrator CLI `veslo start` spawnuje binárku jako child proces s env `OPENCODE_URL`, `OPENCODE_DIRECTORY`, `OPENCODE_ROUTER_HEALTH_PORT`, credentials (cli.ts:3157–3220); default zapnuto (`readBool(..., "veslo-code-router", true)`, cli.ts:6266);
   b) Tauri má vlastní `OpenCodeRouterManager` + commandy `opencodeRouter_start/stop/status/info/config_set` (commands/opencode_router.rs), které spawnují sidecar přímo — používá je tlačítko „Restart router" v settings.tsx.
8. **Cloud/remote deploye router vypínají**: `services/den/src/workers/provisioner.ts:278` i `services/worker-manager/src/docker.ts:126` startují s `--no-veslo-code-router`.
9. **Soubor s instrukcemi agenta**: `<workspace>/.opencode/agents/opencode-router.md` (mtime-cache, `@agent <name>` na prvním řádku vybírá OpenCode agenta).

## Vazba na OpenCode

Přímá, ale úzká a dobře lokalizovaná:

- `@opencode-ai/sdk` **pinned na 1.17.13**; klient z `@opencode-ai/sdk/v2/client` (opencode.ts:3).
- Použité API: `global.health`, `session.create` (s permission rules), `session.prompt`, `event.subscribe` (SSE), `permission.reply` — s **trojitým fallbackem** v2 → v1 → legacy `respond()` (bridge.ts:207–250), což prozrazuje, že balíček přežil několik breaking changes OpenCode.
- `events.ts` normalizuje v2 „sync" obálky se schema suffixy (`session.status.3` → `session.status`) — další vrstva obrany proti driftu enginu.
- Event typy natvrdo: `message.updated`, `session.status`, `session.idle`, `message.part.updated`, `permission.asked`, `permission.v2.asked`.

**Výměna enginu**: dotčené je `opencode.ts` (43 ř.) a části `bridge.ts` (session lifecycle, event handling, permission reply — odhadem 400–600 řádků). Adaptéry Telegram/Slack, DB, media a health server jsou engine-agnostické. Z celého Vesla je to jeden z **nejsnáze přepojitelných** subsystémů — potřebuje jen „create session / prompt / stream událostí / auto-approve permissions".

## Hotspoty složitosti

1. **`startBridge()` monolit** (bridge.ts:300–2396) — ~2 100 řádků jedné funkce; health-server handlery (~750 ř.), pairing, path normalizace, send logika, event stream — vše jako closures nad sdíleným mutable stavem (`config.telegramBots.splice(...)` apod.).
2. **Trojí duplicitní zápis konfigurace identit** do téhož JSON souboru: (1) `cli.ts` `upsertTelegramBot/upsertSlackApp` (ř. 110–156), (2) health handlery v `bridge.ts` `upsertTelegramIdentity/upsertSlackIdentity` (ř. 915–1336), (3) `packages/server/src/routes/opencode-router.ts` `persistOpenCodeRouterTelegramIdentity/...Slack...` (ř. 1073–1396). K tomu **4×** zduplikovaná `normalizeIdentityId` (cli.ts:102, bridge.ts:292, config.ts:146, server routes:971) a 2× pairing-hash logika (bridge.ts:281, server routes:1001).
3. **Normalizace adresářů** (bridge.ts:506–586): `/workspace` alias, WSL `/mnt/c` → `C:\`, case-insensitivita na Windows, kontrola úniku z workspace rootu — platformově specifické, křehké, bez sdílení s obdobnou logikou jinde v monorepu.
4. **Bezpečnostní model**: default `PERMISSION_MODE=allow` → session s pravidlem allow-all (opencode.ts:36) a `permission.asked` eventy se auto-schvalují `"always"` (bridge.ts:1738). Kdo píše botovi, spouští libovolné tooly ve workspace. Pairing gate chrání jen „private" Telegram identity.
5. **CORS-open control server bez autentizace**: health server odráží libovolný `Origin`, povoluje `Access-Control-Allow-Private-Network` (health.ts:163–182) a nemá žádné ověření — jakákoli webová stránka v prohlížeči uživatele může POSTovat `/send`, měnit tokeny a bindingy na localhost portu.
6. **Hardcoded model presety** `opus → anthropic/claude-opus-4-5-20251101`, `codex → openai/gpt-5.3-codex` (bridge.ts:176–179); `/help` přitom tvrdí „GPT 5.2 Codex" (bridge.ts:2267). Per-user override jen v paměti procesu (ztratí se restartem).
7. **Dvě spawn cesty** téhož binary (orchestrator vs. Tauri manager) — riziko dvou běžících instancí a rozjetých portů; health port je pokaždé náhodný, ale config/DB jsou globálně sdílené pro všechny instance.

## Duplicity a mrtvý kód

- **`packages/app/src/app/pages/identities.tsx` (1 494 řádků) není nikde importována** — jediná reference je contract test, který čte její zdroják jako text. Celé UI pro správu messaging identit je tedy mrtvé.
- **`messaging-identities.ts` doména (315 ř.)** je zapojená do `VesloServerClient` (client.ts:395), ale žádná živá stránka ji nevolá — mrtvý klientský kód.
- **Typing indikátor je no-op**: `Adapter.sendTyping` nikdo neimplementuje (telegram.ts:414–439 a slack.ts vrací jen `sendMessage/sendText`), takže celý mechanismus `TYPING_INTERVAL_MS`/`typingLoops`/`startTyping`/`stopTyping` (bridge.ts:155, 621–642) nikdy nic neodešle.
- **`sendFile` fallback větev v `deliverParts`** (bridge.ts:807–836) — reálné adaptéry mají `sendMessage`, větev se použije jen v testech s injektovanými adaptery.
- **DB tabulky `allowlist` a `settings`** + metody `isAllowed/allowPeer/seedAllowlist/getSetting/setSetting` (db.ts:212–255) — používá je pouze `test/db.test.js`.
- **WhatsApp pozůstatky**: pole `whatsapp: false` v health snapshotu „for backward compatibility" (bridge.ts:858–859), migrace `DROP TABLE pairing_requests` (db.ts:130), typ `channels.whatsapp` v health.ts:16.
- **Legacy aliasy**: HTTP `/config/telegram-token`, `/config/slack-tokens` (health.ts:202, 241), legacy single-bot config formát (config.ts:189–194, 219–225), dvojí jméno binárky (`opencode-router` i `veslo-code-router`).
- **CLI `send`** (cli.ts:515–624) duplikuje odesílací logiku přímo přes grammY/Slack WebClient, mimo adaptéry — třetí implementace odesílání.

## Co by znamenalo oddělení BE/FE

Router je paradoxně **nejlépe připravený kus** na model API + SPA: už dnes je to samostatný proces s vlastním HTTP API a UI s ním komunikuje výhradně přes veslo-server (proxy + dedikované routy) — žádný přímý Tauri IPC pro data (IPC se používá jen na lifecycle start/stop/restart). Pro čistý split by stačilo:

1. Zrušit přímé zápisy veslo-serveru do config souboru routeru a nechat **jediný kanál = health HTTP API** (dnes to brání běhu routeru na jiném stroji než veslo-server).
2. Lifecycle (start/stop/restart) přesunout z Tauri IPC na orchestrator/server endpoint — Tauri `OpenCodeRouterManager` pak lze smazat.
3. Health serveru dát autentizaci (token), protože po splitu už nebude „jen localhost".

Žádná část routeru nezávisí na Tauri ani na SolidJS — je to čistý backend démon.

## Náměty na zjednodušení

1. **Rozhodnout, zda feature vůbec žije.** UI stránka je mrtvá, cloud deploye router vypínají, takže messaging dnes reálně nemá ovládací plochu. Pokud se nepoužívá: smazat balíček + 1 567 ř. server rout + 733 ř. Rustu + ~1 800 ř. mrtvého FE + 1 sidecar binárku a sekci sidecar build/publish skriptů. Úspora ~10 000 řádků a jeden proces méně v každé instanci Vesla.
2. Pokud zůstává: **jediný zdroj pravdy pro config** — všechny zápisy jen přes health API routeru; z veslo-serveru smazat `persistOpenCodeRouter*` a config-file logiku (≈500 řádků) a nechat jen tenkou proxy.
3. **Rozbít `startBridge()`**: health handlery, pairing, path-scoping a send logiku do samostatných modulů s explicitním stavem; zrušit mutace `config.telegramBots` na místě.
4. **Smazat mrtvý kód**: typing loop, sendFile fallback, allowlist/settings, WhatsApp pole, legacy aliasy, identities.tsx + messaging-identities doména (nebo je naopak skutečně zapojit), CLI `send` přepojit na adaptéry.
5. **Jedna spawn cesta** (jen orchestrator); Tauri commandy nahradit voláním orchestrator API.
6. Model presety a instrukce přesunout do configu; sjednotit `normalizeIdentityId` do jednoho modulu.

## Rizika

- **Bezpečnost**: auto-allow permissions + neautentizovaný CORS-open control server = přístup k Telegram botovi nebo lokální webová stránka může spouštět příkazy ve workspace a číst výstupy.
- **Souběžné zápisy** dvou procesů do `opencode-router.json` bez zamykání — tichá ztráta konfigurace.
- **Globální sdílený stav** (`~/.veslo/opencode-router/` DB + config) při více instancích Vesla — porty jsou náhodné, ale data se míchají mezi workspace instancemi.
- **Pinned SDK 1.17.13** + trojitý permission fallback — každý upgrade OpenCode může rozbít event stream nebo permission flow (historie fallbacků to dokládá).
- Odstranění balíčku vyžaduje úklid na mnoha místech (release skripty, sidecar manifesty, tauri.conf.json, orchestrator flags, docs) — vazby jsou rozeseté v ~50 souborech mimo balíček.
