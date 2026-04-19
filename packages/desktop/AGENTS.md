# AGENTS.md

This package is the authoritative Veslo runtime under test.

## Rules

- Do not use `packages/web` as proof that desktop behavior works.
- For "test the app" or desktop-runtime validation, use the real Tauri binary and the `packages/e2e` WebdriverIO harness.
- Reuse running app instances when possible. Before launching, check `http://127.0.0.1:4445/status`; if WebDriver is already available, attach to it and do not force-stop the app in teardown.
- If you touch native commands, updater flow, windowing, deep links, tray behavior, or desktop filesystem integration, verify in the real desktop runtime.
- Use `docs/dev/testing-playbook.md` and `docs/dev/build-and-rebuild-matrix.md` to choose the smallest correct verification path.
