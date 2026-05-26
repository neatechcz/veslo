# E2E specy — automatizovaná verifikace přes WebDriver

Během VSLO-86 vznikly **3 WebdriverIO specs**, které reálně testují
multi-workspace flow přes UI klikání (= ne přes API). Specy slouží jako
regression check — když opravíš bug, pusť je a víš, že jsi nerozbil
něco jiného.

Všechny specy jsou v `packages/e2e/specs/`. Framework je
[WebdriverIO](https://webdriver.io/) 9 s Mocha. Konfigurace
`packages/e2e/wdio.conf.ts`.

## Jak spustit

### Předpoklady

1. Vesla binárka buildnutá s `--features e2e`:
   ```bash
   cd git/packages/desktop
   pnpm exec tauri build --debug --no-bundle -- --features e2e
   ```
2. Existující profile s 4 test workspaces (`veslo-test3-A/B/C/D`) v
   `~/Library/Application Support/com.neatech.veslo/`. (Pavlův dev
   profile už je má.)

### Spuštění proti **fresh launched binary**

```bash
cd git/packages/e2e
export E2E_USE_EXISTING_PROFILE=1
export E2E_TAURI_BINARY=/Users/.../git/packages/desktop/src-tauri/target/debug/veslo
pnpm exec wdio run wdio.conf.ts --spec ./specs/<name>.spec.ts
```

WebdriverIO `onPrepare` hook spawne novou Vesla instance, počká na
WebDriver port 4445, spustí test, na konci killne.

### Spuštění proti **běžící pnpm dev session** (= attach mode)

Pokud máš `pnpm dev` se `--features e2e` spuštěné jako Pavlův dev
workflow, specy se k němu přimknou (reuse).

```bash
cd git/packages/e2e
pnpm exec wdio run wdio.conf.ts --spec ./specs/<name>.spec.ts
```

`startApp` v `helpers/app-launcher.ts` detekuje běžící WebDriver na
4445 a místo spawn novou instance reuse-uje.

## Existující specy (květen 2026)

### `boot-freeze.spec.ts`

**Co testuje:** Time-to-interactive po fresh boot **bez kliků**.
Verifikuje že auto-aktivace posledního workspace nezablokuje UI.

**Klíčové asserce:**

- Composer textbox je visible do 30 s
- Žádný spinner ("Otevírám konverzaci…", "Načítám") visible
- Žádné Error badges v sidebaru

**Předfix baseline:** Pavel viděl 30-60 s spinner per boot, pak Error
badges.

**Postfix metriky:** 3× po sobě time-to-interactive **9-19 ms**,
spinner 0 ms, 0 error badges.

**Fix který spec verifikuje:** `b211e5a0`.

### `pnpm-dev-3-clicks.spec.ts`

**Co testuje:** 3 sidebar kliky po sobě (D → A → B) proti **běžící
pnpm dev**. Měří kolik milisekund každý klik trvá do stable stavu.

**Klíčové asserce:**

- Každý klik dosáhne stable composer (visible + žádný spinner) do 30 s

**Předfix baseline:** Click 1 OK, click 2 visel 30 s (timeout), click
3 visel 30 s.

**Postfix metriky:** 3× po sobě každý klik ~520 ms, total 6.5 s pro 3
kliky.

**Fix který spec verifikuje:** `eff94c02` (async orchestrator IPC).

**Pozor:** Spec předpokládá **běžící** pnpm dev (= reuse mode). Pokud
spustíš proti fresh binary, sidebar nemusí být ready před prvním
klikem — spec má `waitUntil` který lookne až 30 s, ale fresh boot
nemusí stihnout načíst všechny 4 workspaces, pokud profile není
"warm". Test spolehlivě běží proti **běžící Vesla** s pre-loaded
sidebar.

### `browse-no-engine-spawn.spec.ts`

**Co testuje:** Verifikuje že pasivní browsing (klik workspace, klik
session) **nespawne žádný engine procesy**.

**Klíčové asserce:**

- Před klikem: 0 engine procesů
- Po kliku D, A, B (každý): 0 engine procesů
- Po kliku na první session: 0 engine procesů

Engine count se zjišťuje shellem (`ps axo command= | grep "veslo-code serve"`).

**Předfix baseline:** Každý klik na session vyvolal `c.session.messages`
SDK → orchestrator proxy → `pool.ensure` → cold engine spawn (30-60 s).

**Postfix metriky:** 3/3 pass, engine count zůstává 0 v celém flow.

**Fix který spec verifikuje:** `60c5d93d` (selectSession offline-first
v browse mode).

## Helper struktura

Klíčový soubor: `packages/e2e/helpers/app-launcher.ts`.

```typescript
export async function startApp(port: number = WEBDRIVER_PORT): Promise<void> {
  if (await hasReadyWebDriverServer(port)) {
    // Reuse mode — Vesla už běží
    console.log(`[e2e] Reusing existing WebDriver server on port ${port}.`);
    return;
  }
  // Fresh spawn
  const binaryPath = resolveBinaryPath();
  // ... spawn s env, profile, snapshot, ...
}
```

Klíčové env vars:

| Var | Význam |
|---|---|
| `E2E_TAURI_BINARY` | Cesta k Vesla binárce (default: hledá v target/debug/) |
| `E2E_USE_EXISTING_PROFILE=1` | Použij real profile (= Pavlovy workspaces) místo isolated `.tmp-veslo-home` |
| `E2E_OPENCODE_HOME` | Custom OPENCODE_HOME (override skutečného `~/.veslo`) |
| `E2E_WEBDRIVER_PORT` | Default 4445 |
| `E2E_LAUNCH_TIMEOUT` | Default 30000 ms — kolik čekat na WebDriver up po spawn |
| `E2E_MOCHA_TIMEOUT` | Default 180000 ms — per-test timeout |

## Patterny v specech

### Selektory — proč `browser.execute` místo CSS

Tauri webview v test buildu je WebKit (= macOS Safari engine). CSS
selektory typu `button:contains("text")` (jQuery-like) **nefungují**.
WebDriverIO `$('button*=text')` partial-match selektor občas najde nic
i když element existuje.

Spolehlivá cesta: vyhodit do webview vlastní JS přes `browser.execute`
a najít element pomocí `document.querySelectorAll` + `textContent.includes`:

```typescript
async function clickSidebarWorkspace(name: string): Promise<boolean> {
  return browser.execute((wsName: string) => {
    const all = document.querySelectorAll('button, [role="button"], a');
    for (const el of Array.from(all)) {
      const text = (el.textContent ?? '').trim();
      if (text.includes(wsName) && text.length < 200) {
        (el as HTMLElement).click();
        return true;
      }
    }
    return false;
  }, name);
}
```

### Snapshot UI state

Pro testy které čekají na stabilní stav, snímej průběžně:

```typescript
async function snapshotUiState() {
  return browser.execute(() => {
    const textbox = document.querySelector('[role="textbox"]') as HTMLElement | null;
    const composerVisible = Boolean(textbox && textbox.offsetParent !== null);
    const spinnerActive =
      document.body.innerText.includes('Otevírám') ||
      document.body.innerText.includes('Načítám dřívější zprávy');
    return { composerVisible, spinnerActive };
  });
}
```

### Wait + poll pattern

```typescript
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  const snap = await snapshotUiState();
  if (snap.composerVisible && !snap.spinnerActive) {
    break;
  }
  await browser.pause(500);
}
```

`browser.waitUntil` je idiomatičtější, ale pro custom průběh (sběr
metrik) lépe ručně.

### Count enginů z shellu

```typescript
import { execSync } from 'node:child_process';

function countEngines(): number {
  const out = execSync(
    'ps axo command= | grep "veslo-code serve" | grep -v grep | wc -l',
    { encoding: 'utf8' }
  );
  return Number(out.trim()) || 0;
}
```

Užitečné pro asserce "tahle akce nesmí spawnout engine".

## Jak přidat nový spec

1. Vytvoř `packages/e2e/specs/<name>.spec.ts`. Šablona:

   ```typescript
   import { expect } from '@wdio/globals';

   describe('<Co testuje>', () => {
     before(async () => {
       await browser.waitUntil(
         async () => browser.execute(() => {
           // wait until UI is hydrated
           return document.querySelectorAll('button').length > 0;
         }),
         { timeout: 30_000, timeoutMsg: 'UI not hydrated within 30s' },
       );
       await browser.pause(2000);
     });

     it('<scenario>', async () => {
       // ...
       expect(true).toBe(true);
     });
   });
   ```

2. Pokud má spec běžet jako součást `pnpm test:e2e`, přidat cestu do
   `defaultSpecs` v `packages/e2e/wdio.conf.ts:16-37`.

3. Pokud spec je ad-hoc (regression check pro konkrétní fix),
   nepřidávat do `defaultSpecs` — spouštět ručně přes
   `--spec ./specs/<name>.spec.ts`.

## Známé nedostatky specs

- **Lokalizace** — specy assume English (`"Otevírám"` substring je
  hardcoded). Pokud Vesla flipne na češtinu, asserce selžou. Lze
  vyřešit i18n-aware selektory (data attribute, `data-testid`).
- **Sandbox-exec dependency** — engine spawn v testech vyžaduje
  funkční macOS sandbox-exec. Na fresh CI runner bez user privileges
  může selhat. Žádné CI integration zatím není.
- **No happy-path send test** — chybí spec "klik workspace + napsat +
  send + AI odpoví". Důvod: cold engine spawn je 30-60 s + AI inference
  3-10 s; test by trval ~90 s. Plus AI gateway preflight 30 s timeout
  je flaky.

## Co příště rozšířit

- Spec "send happy path" — jednoduchý send + assertion na assistant
  message. Akceptovat 60 s timeout.
- Spec "engine respawn po crash" — kill engine procesu, klik znovu,
  verify že se respawne a session pokračuje.
- Spec "token rotation" — restart veslo-server, verify že opencode.jsonc
  je updated a engine přejme nový token bez user akce.
- I18n-aware selektory přes `data-testid` na klíčových UI prvkích.
