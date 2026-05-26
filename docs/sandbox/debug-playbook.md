# Debug playbook — jak se v aplikaci vyznat

Konkrétní postupy pro nový vývojář. Předpokládá macOS dev prostředí
(arm64). Pro odlišnosti viz [`docs/dev/development-startup.md`](../dev/development-startup.md).

## Prerekvizity

- Rust stable (`rustup default stable`)
- Bun 1.3.6+ (`brew install bun` nebo `curl -fsSL https://bun.sh/install | bash`)
- Node 20+
- pnpm 10.27+ (`corepack enable && corepack prepare pnpm@10.27 --activate`)
- macOS Xcode CLI (`xcode-select --install`)

První instalace:

```bash
cd packages-root/git
pnpm install
```

## Spuštění dev modu

### Variant A: standard pnpm dev (= primární dev workflow)

```bash
cd git
pnpm dev
```

Spustí `tauri dev --config src-tauri/tauri.dev.conf.json`. Vite na :5173,
Tauri Rust shell + auto-spawn child procesy.

**Bez WebDriver** — pro WebDriver feature:

```bash
cd git/packages/desktop
VESLO_DATA_DIR="$HOME/.veslo/veslo-orchestrator-dev" \
VESLO_SERVER_DEV_WATCH=1 \
VESLO_SERVER_DEV_DIR="$PWD/../server" \
pnpm exec tauri dev --config src-tauri/tauri.dev.conf.json -- --features e2e
```

Po startupu (cca 60-90 s) WebDriver naslouchá na `127.0.0.1:4445`.

### Variant B: production-like binary (= E2E test workflow)

```bash
cd git/packages/desktop
pnpm exec tauri build --debug --no-bundle -- --features e2e
```

Vyrobí `packages/desktop/src-tauri/target/debug/veslo`. Spuštění
přímo:

```bash
./packages/desktop/src-tauri/target/debug/veslo
```

Použije production Tauri identifier `com.neatech.veslo` (= jiná data
dir než dev), tedy uvidí workspaces v
`~/Library/Application Support/com.neatech.veslo/veslo-workspaces.json`.

## Jak zjistit, kde co poslouchá

```bash
# Všechny Veslo procesy
ps aux | grep -E "target/debug/veslo|bun.*src/cli.ts|veslo-orchestrator|veslo-code|veslo-code-router" | grep -v grep

# Co na kterém portu poslouchá
lsof -nP -iTCP -sTCP:LISTEN | grep -E "veslo|bun"
```

### Klíčové porty

| Port | Co | Auth |
|---|---|---|
| 8787 (nebo random fallback) | veslo-server | Bearer token (`token` flag) + host token (`x-veslo-host-token`) |
| Random (např. 60023) | orchestrator daemon `--daemon-port` | Basic `opencode:<password>` |
| Random | OpenCode engine `serve --port` | Basic `opencode:<password>` |
| Random | veslo-code-router | Internal |
| 4445 (jen e2e build) | Tauri WebDriver | None |
| 5173 (jen pnpm dev) | Vite dev server | None |

### Jak najít token a port veslo-serveru

```bash
ps aux | grep "bun.*src/cli.ts" | grep -v grep | \
  grep -oE "(host|port|token|host-token) [^ ]+"
```

Příklad výstupu:

```
host 0.0.0.0
port 8787
token ce498fdf-dcbf-4ac2-91e6-bd0dbb8ab96e
host-token 0312d502-458b-48a2-823f-1e9abb0894a9
```

### Jak najít orchestrator daemon

```bash
ps aux | grep "veslo-orchestrator daemon" | grep -v grep | \
  grep -oE "(daemon-port|opencode-password|opencode-port) [^ ]+"
```

## Kde jsou logy

| Zdroj | Lokace | Co obsahuje |
|---|---|---|
| Webview console | DevTools v Tauri okně (Cmd-Opt-I, jen debug build) | Frontend SolidJS logs, fetch warnings, Promise rejections |
| Rust + spawned children | `pnpm dev` terminal stdout | Vše z Tauri main + child stderr |
| Tauri runtime log | `/tmp/veslo-runtime.log` | Workspace lifecycle, internal provisioning |
| Opencode-router | `~/.veslo/opencode-router/logs/opencode-router.log` | Health polls, messaging events |
| Orchestrator state | `~/.veslo/veslo-orchestrator-dev/veslo-orchestrator-state.json` | Engine snapshot, daemon meta |
| Veslo-server state | `~/Library/Application Support/com.neatech.veslo.dev/veslo-server-state.json` | Token, port, PID, baseUrl |
| Tauri workspaces | `~/Library/Application Support/com.neatech.veslo.dev/veslo-workspaces.json` | Registry workspaces (Tauri-side) |

Pro production identifier (`com.neatech.veslo` bez `.dev`) jsou stejné
soubory v `~/Library/Application Support/com.neatech.veslo/`.

### Tail více logů zároveň

```bash
# Veslo runtime + opencode-router současně
tail -f /tmp/veslo-runtime.log ~/.veslo/opencode-router/logs/opencode-router.log
```

Nebo udělej alias:

```bash
alias vlog='tail -f /tmp/veslo-runtime.log ~/.veslo/opencode-router/logs/opencode-router.log'
```

## Otevření DevTools v Tauri okně

V debug buildu (= `pnpm dev` nebo `tauri build --debug`):

1. V Tauri okně **pravý klik** kdekoli mimo composer
2. Vybrat **Inspect Element**
3. Otevře se Safari Web Inspector (WebKit engine)

V production buildu DevTools nedostupné — musíš rebuildit s `--debug`
nebo přes E2E WebDriver.

## Manuální health check celého stacku

```bash
# Veslo-server
curl -s http://127.0.0.1:8787/health | head -c 200

# Orchestrator daemon (port + pass z ps aux)
DAEMON_PORT=$(ps aux | grep "veslo-orchestrator daemon" | grep -v grep | head -1 | grep -oE 'daemon-port [0-9]+' | awk '{print $2}')
DAEMON_PASS=$(ps aux | grep "veslo-orchestrator daemon" | grep -v grep | head -1 | grep -oE 'opencode-password [^ ]+' | awk '{print $2}')
curl -s -u "opencode:$DAEMON_PASS" "http://127.0.0.1:$DAEMON_PORT/health" | head -c 1000

# Veslo-server workspaces list (Bearer)
TOKEN=$(curl -s http://127.0.0.1:8787/health | grep -oE '"token":"[^"]*"' | sed 's/.*":"//' | sed 's/"$//')
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/workspaces | head -c 2000
```

## Test session přes orchestrator (= bez UI)

Užitečné pro ověření engine spawn / AI inference bez UI clicků.

```bash
DAEMON_URL="http://127.0.0.1:$DAEMON_PORT"
AUTH="opencode:$DAEMON_PASS"
WS_ID="ws-f3e85d625b5d"  # např. veslo-test3-C
PROXY="$DAEMON_URL/workspace/$WS_ID/opencode"

# Activate workspace
curl -s -u "$AUTH" -X POST "$DAEMON_URL/workspaces/$WS_ID/activate" \
  -H "Content-Type: application/json" -d ''

# Vytvořit session (cold engine spawn cca 30-60 s)
SESSION_JSON=$(curl -s -u "$AUTH" -X POST "$PROXY/session" \
  -H "Content-Type: application/json" -d '{}' --max-time 90)
SID=$(echo "$SESSION_JSON" | grep -oE '"id":"ses_[^"]*"' | head -1 | \
  sed 's/.*":"//' | sed 's/"$//')

# Poslat zprávu
curl -s -u "$AUTH" -X POST "$PROXY/session/$SID/message" \
  -H "Content-Type: application/json" \
  -d '{"parts":[{"type":"text","text":"Odpověz JEN: PONG_TEST"}]}' \
  --max-time 90

# Vyčíst response (po pár sekundách)
sleep 10
curl -s -u "$AUTH" "$PROXY/session/$SID/message" | tail -c 1500
```

Pokud assistant message má `"parts":[]` a `tokens=0`, engine nevolal AI
provider (= problém s gateway token / Den auth, viz
[`known-issues.md`](known-issues.md) bod 5).

## Reset stavu

Občas chceš úplně čistý start (= žádné stale processes, žádné cached
tokens).

```bash
# Killnout vše
for pid in $(ps aux | grep -E "target/debug/veslo|bun.*src/cli.ts|veslo-orchestrator|veslo-code|tauri.js dev|node.*tauri-before" | grep -v grep | awk '{print $2}'); do
  kill -KILL $pid 2>/dev/null
done

# Smazat persistent state (= ZTRATÍŠ workspace registry!)
rm -rf ~/.veslo/veslo-orchestrator-dev/
rm -f "$HOME/Library/Application Support/com.neatech.veslo.dev/veslo-server-state.json"
rm -f "$HOME/Library/Application Support/com.neatech.veslo/veslo-server-state.json"

# Restart
pnpm dev
```

## Screenshot Vesla okna (= visual debug bez WebDriver)

V macOS lze pořídit screenshot aktivního Vesla okna přes
`screencapture`:

```bash
# Aktivní okno (klik kdekoli → po pípnutí klik na Vesla okno)
screencapture -W /tmp/veslo.png

# Cele Vesla okno bez interakce — najít window-id přes Quartz API
# (viz `man screencapture` -l flag pro window id mode)
```

Pak `open /tmp/veslo.png` nebo Read tool v Claude.

## Připojení WebDriver session přes wd-cli (interaktivně)

Pokud máš Vesla s `--features e2e` running na port 4445, můžeš se
připojit programatically z Node:

```javascript
const { remote } = require('webdriverio');
const browser = await remote({
  hostname: '127.0.0.1',
  port: 4445,
  path: '/',
  capabilities: { browserName: 'chrome', 'goog:chromeOptions': {} },
});
// browser.execute(() => document.body.innerText)
```

Nebo přes WebDriverIO spec — viz [`e2e-specs.md`](e2e-specs.md).

## Když se Vesla zasekne — checklist

1. **Webview ještě reaguje?** Zkus pravý klik. Pokud ne → Rust main
   deadlock, kill `target/debug/veslo` a restart.
2. **Console má timeouty?** Otevři DevTools, sleduj `[http] timeout`
   warnings. Pokud `/ai-gateway/me/ai-access` 30 s → Den/preflight problém.
3. **Engine pool stav?** `curl orchestrator /health` — kolik engines a
   v jakém stavu? Pokud žádné a klik na workspace → orchestrator-side
   spawn problém.
4. **Workspace identita?** `cat veslo-workspaces.json` + orchestrator
   `/workspaces` — souhlasí IDs? Pokud mismatch → ID schema regrese.
5. **Token rotace?** `cat <workspace>/opencode.jsonc | grep apiKey` —
   souhlasí s `/health` tokenem? Pokud ne → stale opencode.jsonc.

Pro každý symptom má [`known-issues.md`](known-issues.md) odpovídající
sekci s root cause a referencí na fix.

## Useful one-liners

```bash
# Sledovat workspace activate steps real-time
tail -f /tmp/veslo-runtime.log | grep "workspace:activate\|workspace:ensureEngine"

# Spočítat engine procesy
ps aux | grep "veslo-code serve" | grep -v grep | wc -l

# Zjistit token v opencode.jsonc (uprav cestu na tvůj workspace)
grep apiKey <workspace-root>/opencode.jsonc

# Stav všech E2E test sessions
ls -la <workspace-root>/.opencode/

# Kill zombies (= bun --watch z předchozího Tauri main restart)
for pid in $(ps aux | grep "bun --watch src/cli.ts" | grep -v grep | awk '{print $2}'); do
  echo "kill $pid"; kill -KILL $pid
done
```
