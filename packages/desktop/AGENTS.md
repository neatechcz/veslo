# AGENTS.md

This package is the authoritative Veslo runtime under test.

## Rules

- Do not use `packages/web` as proof that desktop behavior works.
- For "test the app" or desktop-runtime validation, use the real Tauri binary and the `packages/e2e` `tauri-pilot` harness.
- Treat Veslo desktop as single-tenant. Before launching dev mode or `tauri-pilot`, run the desktop test preflight from `docs/dev/testing-playbook.md`: detect running Veslo dev/test processes, stop internally started instances from this repo, and verify the runtime is clear before launching the test build.
- Do not reuse an existing `tauri-pilot` app/socket by default. Attaching to an existing socket is only for an explicitly requested debug attach flow, and teardown must not stop an app instance the harness did not launch.
- Legacy WebdriverIO specs are historical only. Convert a legacy spec to `tauri-pilot` before using it as desktop validation.
- If you touch native commands, updater flow, windowing, deep links, tray behavior, or desktop filesystem integration, verify in the real desktop runtime.
- Use `docs/dev/testing-playbook.md` and `docs/dev/build-and-rebuild-matrix.md` to choose the smallest correct verification path.
