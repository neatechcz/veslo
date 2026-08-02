# Legacy Veslo Tauri Pilot Workflow

> **Archived.** Do not use this workflow. Veslo desktop debugging and E2E
> validation use WebDriverIO; see `docs/dev/testing-playbook.md`.

This document is historical context for older artifacts only. Its commands must
not be run or extended.

## Start And Attach

Run Veslo as a debug Tauri app first. For local work use the Windows Pilot
binary because the app runs as a Windows Tauri process:

```powershell
pnpm tauri dev
C:\Users\jajse\.cargo\bin\tauri-pilot.exe ping
C:\Users\jajse\.cargo\bin\tauri-pilot.exe windows
C:\Users\jajse\.cargo\bin\tauri-pilot.exe state
C:\Users\jajse\.cargo\bin\tauri-pilot.exe snapshot -i
```

In PowerShell, quote Pilot refs. `@e28` without quotes is parsed by PowerShell:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe click '@e28'
C:\Users\jajse\.cargo\bin\tauri-pilot.exe fill '@e52' "ahoj"
```

Refs are snapshot-local. Take a new `snapshot -i` after route changes,
workspace switches, modal opens, reloads, or large sidebar updates.

## Capture Evidence

Use these commands before and after the scenario:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe logs
C:\Users\jajse\.cargo\bin\tauri-pilot.exe network
C:\Users\jajse\.cargo\bin\tauri-pilot.exe screenshot .\veslo-pilot.png
```

For focused log reads:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe logs |
  Select-String -Pattern "SENDTRACE|OWPERF|WSDBG|workspace:busy|session:status|sidebar:error"

C:\Users\jajse\.cargo\bin\tauri-pilot.exe network |
  Select-String -Pattern "prompt_async|/session|workspace/|8787|9876"
```

When running manual runtime logging, save the scenario name, app start time, user
actions, and Pilot logs together. The most useful scenario note is literal:
"typed `ahoj`, submitted, waited for reply, switched to test-repo2, submitted
again".

## Send A Message

1. Take a snapshot.
2. Find the composer textbox and send button refs.
3. Fill the composer.
4. Click the send button or press Enter.
5. Watch logs until the assistant response reaches the UI.

Typical commands:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe snapshot -i
C:\Users\jajse\.cargo\bin\tauri-pilot.exe fill '@e52' "Return exactly one line: PILOT_OK"
C:\Users\jajse\.cargo\bin\tauri-pilot.exe press Enter
```

If the snapshot has nested textboxes, verify the filled value:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe value '@e52'
C:\Users\jajse\.cargo\bin\tauri-pilot.exe value '@e53'
```

If Pilot `click` returns `ok` but the app does not react, install a temporary
capture listener and repeat the click. This proves whether the event reached the
WebView:

```powershell
@'
(() => {
  window.__vesloPilotClicks = [];
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    const row = {
      text: button ? (button.textContent || "").replace(/\s+/g, " ").trim() : null,
      aria: button?.getAttribute("aria-label") ?? null,
      time: Date.now(),
    };
    window.__vesloPilotClicks.push(row);
    console.log("[pilot-click-capture]", row);
  }, true);
  return "installed";
})()
'@ | C:\Users\jajse\.cargo\bin\tauri-pilot.exe eval -

C:\Users\jajse\.cargo\bin\tauri-pilot.exe click '@e28'

@'
JSON.stringify(window.__vesloPilotClicks || [], null, 2)
'@ | C:\Users\jajse\.cargo\bin\tauri-pilot.exe eval -
```

Use `eval` only as a diagnostic fallback. It should not replace normal Pilot
clicks unless the click layer itself is under investigation.

## Message Timeline

For a correct send, the logs should show one submit path:

- `composer:sendDraft:start`
- `app:sendPrompt:start`
- `sendPrompt:ensure-engine-for-workspace:start`
- optional cold engine startup
- `createSessionAndOpen` only if there is no session yet
- `runConversationFromVesloWriteApi:start`
- `server:conversation-run:opencode-submit`
- `session:status running`
- streamed message updates
- `session:status idle`

Check duplicate sends with:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe logs |
  Select-String -Pattern "runConversationFromVesloWriteApi:start|server:conversation-run:opencode-submit|prompt_async"
```

One UI send should produce one `prompt_async` submit. Multiple sidebar refreshes,
MCP refreshes, or SSE events are not duplicate sends by themselves.

## Workspace Switching

Workspace switching must be scoped by workspace id and conversation id. A
background engine may keep running for another workspace, but the visible UI
must not reuse that workspace's session id after a switch.

Manual switch scenario:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe snapshot -i
C:\Users\jajse\.cargo\bin\tauri-pilot.exe click '@e28'   # Otevrit projekt test-repo2
Start-Sleep -Seconds 2
C:\Users\jajse\.cargo\bin\tauri-pilot.exe state
C:\Users\jajse\.cargo\bin\tauri-pilot.exe logs |
  Select-String -Pattern "workspace:activate|activate:|ui-reset|session.select|sidebar:error|connect:multi"
```

If Pilot click does not dispatch a DOM event, use this diagnostic fallback:

```powershell
@'
(() => {
  const button = [...document.querySelectorAll("button")]
    .find((el) => (el.textContent || "").includes("test-repo2"));
  if (!button) return "button-not-found";
  button.click();
  return "clicked";
})()
'@ | C:\Users\jajse\.cargo\bin\tauri-pilot.exe eval -
```

After switching workspaces, watch for these bad signs:

- `session.select` for an old session id under the new workspace key,
- `sidebar:error` against an old workspace proxy port,
- visible route still pointing to a session from the previous workspace,
- `renderedMessageCount:0` after a known transcript should be available,
- `workspace:busy mark` resetting `startedAt` for the same session.

For a concrete `/session/:id` route, an explicit project-open switch should log
the route reset before activation:

```text
[WSDBG] route:workspace-project-open:clear-session-route ...
[WSDBG] activate:start ...
[WSDBG] ui-reset:displayed-session ... "selectedSessionId":null ...
```

There should be no `session.select:start` for the old session after that route
reset. If it appears, the route controller is still rehydrating a previous
workspace's visible conversation.

## Cold Send UI Handoff

For first send in a workspace, distinguish backend delay from UI reset:

- Cold WSL/orchestrator startup can legitimately take seconds.
- UI timers and optimistic message should not reset during that wait.
- Sidebar refresh may be deferred during active send; this is expected:
  `sidebar.sessions:refresh-defer-active-send`.
- MCP refresh may be skipped during active send; this is expected:
  `workspace.mcp:refresh-skip-active-send`.

Root-cause checks:

```powershell
C:\Users\jajse\.cargo\bin\tauri-pilot.exe logs |
  Select-String -Pattern "uiScopeKey|pending-workspace|onMaterializedSessionId|session.window:state|transcript-first-paint"
```

The UI scope should be `ws:<workspaceId>:...`, never `ws:default` after
workspace hydration.

## Runtime And Sidecar Logs

When the app is started through manual runtime logging, keep these artifacts
together:

- Tauri stdout/stderr,
- Pilot console logs,
- Pilot network logs,
- runtime trace,
- OpenCode health trace,
- exact scenario note.

Useful searches:

```powershell
rg -n "engine_not_running|engine spawn failed|version mismatch|workspace:ensureEngine|startHost|activate:" dev-specific/tauri-pilot
rg -n "SENDTRACE|OWPERF|WSDBG|sidebar:error|session.select|workspace:busy" dev-specific/tauri-pilot
rg -n "prompt_async|POST /session|GET /session|workspaceId" dev-specific/tauri-pilot
```

Use current run timestamps to choose the right manual-runtime directory. Do not
compare a user scenario against an older run unless the timestamps match.

## Local Debug Sink

Veslo logs boot traces to the console by default. The old hardcoded
`http://127.0.0.1:9876` sink must not be used by default because WebView logs
`ERR_CONNECTION_REFUSED` even when fetch errors are caught.

To opt in to an external local boot-trace sink:

```powershell
@'
localStorage.setItem("veslo:boot-trace-sink", "http://127.0.0.1:9876")
'@ | C:\Users\jajse\.cargo\bin\tauri-pilot.exe eval -
```

To disable it:

```powershell
@'
localStorage.removeItem("veslo:boot-trace-sink")
'@ | C:\Users\jajse\.cargo\bin\tauri-pilot.exe eval -
```

Only loopback `http`/`https` URLs are accepted.

## What To Report

For every Tauri Pilot run, report:

- app URL and selected route,
- active workspace id and visible project,
- exact user action,
- request counts for `/session` and `prompt_async`,
- first incorrect state transition,
- whether the final UI matches the expected workspace and session.

Prefer root causes over symptoms. "Timer reset" is a symptom; "duplicate
`running` status rewrote `startedAt` for the same session" is a cause.
