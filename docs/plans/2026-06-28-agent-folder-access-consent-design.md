# Agent Folder Access Consent Design

## Goal

When an agent tries to read a folder outside the current workspace, Veslo should pause and ask the user for explicit, understandable folder access before retrying. The native OS picker should open as close as possible to the requested folder, but Veslo owns the consent explanation because the OS picker does not explain agent runtime semantics.

This design covers macOS and Windows desktop behavior. It does not change cloud Google Drive OAuth behavior.

## User Experience

The runtime detects a denied local filesystem path and reports a structured access request to the app. The app shows a Veslo modal before opening the OS picker.

The modal explains:

- the folder the agent tried to read
- why access is needed
- that access includes subfolders
- the access mode, defaulting to read-only
- the duration, defaulting to remembered for the current workspace until removed
- that the native picker may open at the nearest available parent folder

Primary action opens the native folder picker. Secondary action cancels and returns the denial to the agent.

Suggested English copy:

```text
Allow folder access?

The agent tried to read:

{requestedPath}

To continue, Veslo needs your permission to let this workspace read the selected folder and its subfolders.

Access: Read-only
Duration: This workspace until removed

The picker may open at the nearest available parent folder. Select the folder above or a parent folder that contains it.
```

Buttons:

- Choose folder
- Cancel

The prompt must be localized through the existing app i18n system. Add keys for the title, body fragments, access labels, duration labels, picker guidance, and actions in every current locale: `en`, `cs`, and `zh`.

## Picker Behavior

The app computes a picker start path from the requested path:

1. If the requested path exists and is a directory, use it.
2. If it is a file or missing leaf, use the nearest existing parent.
3. If the target is a restricted provider root such as a macOS File Provider location that cannot be listed, use the nearest existing listable parent and explain that the user must select the requested folder or containing folder.

Use the existing Tauri dialog plugin with folder selection, `title`, and `defaultPath`. On macOS this maps to the native open panel. On Windows this maps to the native folder picker. Veslo should not rely on the picker to explain permission scope.

## Grant Validation

After the user selects a folder, Veslo validates that the selected folder is either:

- exactly the requested folder, or
- a parent folder that contains the requested path.

If the selection does not contain the requested path, show a localized error and let the user choose again or cancel.

If the selected path is equivalent to a more accessible mirror of the requested provider path, Veslo may store the selected path as the canonical grant path. For example, a user may select a readable Google Drive mirror path instead of an unlistable macOS CloudStorage provider root.

## Runtime Model

Store approved folders in the workspace `authorizedRoots` list. Keep the current workspace root as an implicit or explicit authorized root.

For sandboxed engines, translate approved non-workspace roots into read-only `extraMounts` when spawning or restarting the workspace engine. This connects the existing user-facing authorization model to the orchestrator sandbox model.

Read-only is the default. Write access is out of scope for this first design and should require a separate prompt if added later.

If the engine is already running and a new grant is added, Veslo should restart or reload the workspace runtime in a controlled way before retrying the operation, because sandbox mounts are selected at process launch.

## Error Handling

Cancellation returns a clear denial to the agent so it can explain that the user declined folder access.

If the OS picker returns no path, treat it as cancellation.

If the chosen path cannot be validated or mounted, show a localized error and keep the original run paused or failed with an actionable message.

If the app is running on a remote workspace, do not offer local folder access. Explain that local paths are only available to local desktop workspaces.

## Testing

Prefer desktop E2E coverage with Tauri Pilot because this depends on real desktop runtime behavior and native picker wiring.

Core scenarios:

- denied read path creates a localized consent prompt
- cancel returns a denial without changing `authorizedRoots`
- choosing a folder that contains the requested path persists the grant
- choosing an unrelated folder shows a localized validation error
- granted folders become read-only sandbox mounts on the next engine start
- remote workspaces do not offer local folder access

Lower-level tests can cover path containment, nearest-existing-parent selection, localization key presence, and sandbox mount translation.

