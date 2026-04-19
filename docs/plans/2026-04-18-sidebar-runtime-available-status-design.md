# Sidebar Runtime Available Status Design

**Problem:** The sidebar status dot shows `Unavailable` after switching between local workspaces in Tauri browsing mode, even though the local runtime is still running and the workspace switch is considered successful.

**Decision:** Treat local browsing mode as runtime-available for the sidebar status indicator. The dot should stay ready when the Veslo server is connected and the active workspace is marked connected, even if the OpenCode client is intentionally detached during local-to-local browsing.

**Why:** In this flow the missing client attachment is expected behavior, not a runtime failure. Showing a red unavailable state is a false negative and misleads the user into thinking something broke.

**Scope:**
- Update the sidebar status model to accept active workspace connection state.
- Pass active workspace connection state from dashboard and session views.
- Add focused unit coverage for the browsing-mode ready state.

**Non-goals:**
- Do not change engine/workspace activation behavior.
- Do not change settings diagnostics or lower-level connection semantics.
