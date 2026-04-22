# AGENTS.md

This package is the authoritative Veslo runtime under test.

## Rules

- Do not use `packages/web` as proof that desktop behavior works.
- For "test the app" or desktop-runtime validation, use the real Tauri binary and the `packages/e2e` WebdriverIO harness.
- Treat Veslo desktop as single-tenant. Before launching dev mode or WebdriverIO, run the desktop test preflight from `docs/dev/testing-playbook.md`: detect running Veslo dev/test processes, stop internally started instances from this repo, and verify the runtime is clear before launching the test build.
- Do not reuse an existing WebDriver/app instance by default. Attaching to `http://127.0.0.1:4445/status` is only for an explicitly requested debug attach flow, and teardown must not stop an app instance the harness did not launch.
- If you touch native commands, updater flow, windowing, deep links, tray behavior, or desktop filesystem integration, verify in the real desktop runtime.
- Use `docs/dev/testing-playbook.md` and `docs/dev/build-and-rebuild-matrix.md` to choose the smallest correct verification path.
