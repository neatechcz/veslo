# VSLO-86 Windows native sandbox - Codex -> OpenCode

Status: POC poznámka. Cíl je nejjednodušší cesta, jak převzít Codex-style
Windows sandbox pro OpenCode na Windows.

Datum: 2026-05-28

## Cíl

Spustit OpenCode engine na Windows tak, aby:

- běžel v reálném Windows checkoutu uživatele
- mohl zapisovat jen do workspace a explicitních runtime cest
- nemohl zapisovat do `.git`
- defaultně neměl outbound internet
- omezení platilo i pro child procesy, které OpenCode spustí

Neřešit zatím univerzální sandbox pro všechny příkazy. Nejdřív jen OpenCode
engine spawn.

## Přímý převod z Codex řešení

| Codex | Veslo/OpenCode ekvivalent |
|---|---|
| `codex.exe` | `veslo-orchestrator` |
| `codex-windows-sandbox-setup.exe` | `veslo-windows-sandbox-setup.exe` |
| `codex-command-runner.exe` | `veslo-windows-command-runner.exe` |
| `CodexSandboxOffline` | `VesloSandboxOffline` |
| `CodexSandboxOnline` | `VesloSandboxOnline` |
| sandbox-write SID | `VesloSandboxWrite` SID/group |
| child command | `opencode serve ...` |

## Nejmenší architektura

```text
orchestrator
  -> WindowsNative.buildLaunch(workspace policy)
  -> veslo-windows-command-runner.exe
  -> restricted token
  -> opencode serve ...
```

Admin/setup věci:

```text
first-run onboarding
  -> UAC
  -> veslo-windows-sandbox-setup.exe
  -> users + firewall + ACL baseline + manifest
```

## Helper 1: setup

`veslo-windows-sandbox-setup.exe`:

1. vytvoří `VesloSandboxOffline`
2. vytvoří `VesloSandboxOnline`
3. vytvoří `VesloSandboxWrite` SID/group
4. uloží sandbox user credentials přes DPAPI
5. nastaví firewall block pro `VesloSandboxOffline`
6. nastaví read ACL pro běžné runtime cesty:
   - user profile
   - `C:\Windows`
   - `C:\Program Files`
   - `C:\Program Files (x86)`
   - `C:\ProgramData`
7. zapíše manifest:
   - helper version
   - sandbox user SIDs
   - firewall rule names
   - last setup time

Setup se nesmí spouštět z `pnpm build` ani ze smoke testu. Jen onboarding /
repair.

## Helper 2: command runner

`veslo-windows-command-runner.exe`:

1. běží jako `VesloSandboxOffline` nebo `VesloSandboxOnline`
2. otevře vlastní token
3. vytvoří restricted token
4. nastaví cwd/env/stdio
5. spustí `opencode serve ...` přes `CreateProcessAsUserW`
6. vrátí exit code orchestrátoru

Runner nemá dělat policy výpočty. Jen spustit příkaz pod správným tokenem.

## Policy pro první prototyp

Vstup z orchestrátoru:

```ts
type WindowsNativePolicy = {
  workspacePath: string
  opencodeExe: string
  opencodeArgs: string[]
  env: Record<string, string>
  mode: "offline" | "online"
  writablePaths: string[]
  readonlyPaths: string[]
  blockedReadPaths: string[]
}
```

Minimální policy:

- `workspacePath` = RW
- `<workspace>/.git` = deny-write
- OpenCode config/cache dir = RW
- `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker` = deny-read
- mode default = `offline`

Extra mounts až později.

## Orchestrator změna

Přidat backend:

```text
packages/orchestrator/src/sandbox/windows-native/
├── index.ts
├── discovery.ts
├── policy.ts
└── diagnostics.ts
```

`resolveSandbox()`:

```ts
if (process.platform === "win32") {
  if (process.env.VESLO_WINDOWS_NATIVE_SANDBOX === "1") return WindowsNative
  return WindowsWsl2
}
```

Tím zůstane WSL2 default a native sandbox bude explicitní POC flag.

## Launch flow

```text
send message
  -> pool.ensure(workspaceId)
  -> WindowsNative.buildLaunch(opts)
  -> discovery ověří setup manifest
  -> policy refreshne ACL pro workspace
  -> runner se spustí jako VesloSandboxOffline
  -> runner spustí opencode serve přes restricted token
  -> orchestrator proxy mluví s OpenCode engine
```

První POC nemusí podporovat online mode. Stačí offline engine + lokální
komunikace s orchestrátorem.

## Nejtěžší spike

Ověřit loopback:

1. firewall blokuje outbound internet pro `VesloSandboxOffline`
2. OpenCode pořád umí mluvit s Veslo serverem/orchestrátorem přes localhost
3. pokud loopback nefunguje, přejít na named pipe / stdio proxy pro engine

Bez toho nemá smysl integrovat backend do UI.

## Smoke testy

První POC pass/fail:

1. runner `whoami` vrátí `VesloSandboxOffline`
2. write do workspace projde
3. write mimo workspace selže
4. write do `.git` selže
5. read `.ssh` selže
6. child process zdědí omezení
7. outbound internet selže
8. localhost Veslo endpoint funguje
9. `opencode --version` projde
10. `opencode serve` nastartuje a odpoví na health

## Akční postup

### Fáze 0 - čistý Windows spike

- napsat malý Rust helper mimo orchestrátor
- vytvořit test user `VesloSandboxOffline`
- spustit `cmd /c whoami` jako sandbox user
- přidat restricted token
- ověřit write allow/deny na temp složkách
- ověřit firewall outbound block
- ověřit loopback

Výsledek: víme, jestli native Windows cesta technicky funguje.

### Fáze 1 - OpenCode spike

- spustit `opencode --version` přes runner
- spustit `opencode serve` přes runner
- ověřit health endpoint
- ověřit, že OpenCode child procesy neutečou z write policy

Výsledek: Codex-style runner umí hostovat OpenCode.

### Fáze 2 - Veslo backend

- přidat `WindowsNative` backend pod `packages/orchestrator/src/sandbox`
- schovat za `VESLO_WINDOWS_NATIVE_SANDBOX=1`
- mapovat jen základní policy: workspace RW, `.git` RO, config/cache RW,
  blocked sensitive paths
- napojit na engine pool

Výsledek: jeden workspace umí nastartovat OpenCode engine native sandboxem.

### Fáze 3 - onboarding/repair

- setup helper přes UAC
- manifest
- repair flow
- diagnostika v UI/logu
- fallback na WSL2

Výsledek: použitelné pro interní test, ne jen ruční spike.

## Nedělat v prvním POC

- extra mounts UI
- online mode
- per-session sandbox
- obecný sandbox pro libovolné shell tool volání
- Windows JobObject fallback
- enterprise hardening
- auto-install bez explicitního consentu

## Verdikt

Nejjednodušší překlopení Codex řešení do Vesla:

1. nechat WSL2 jako default
2. udělat explicitní Windows-native POC backend
3. z Codexu převzít jen minimální tvar:
   - setup helper
   - sandbox users
   - firewall pro offline user
   - command runner
   - restricted token
   - ACL write policy
4. cílit nejdřív pouze na `opencode serve`
5. rozhodnout podle loopback + OpenCode smoke testů

Pokud selže loopback nebo OpenCode runtime parity, native backend zastavit a
zůstat u `WSL2 + bwrap`.

## Reference

- OpenAI Engineering: "Building a safe, effective sandbox to enable Codex on
  Windows" - https://openai.com/index/building-codex-windows-sandbox/
- Lokálně ověřený Codex na tomhle stroji: `codex-cli 0.134.0`, s přítomnými
  `codex-windows-sandbox-setup.exe` a `codex-command-runner.exe`.
- Aktuální Veslo směr: [`../windows-wsl2-sandbox-runtime.md`](../windows-wsl2-sandbox-runtime.md).
