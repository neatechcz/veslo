# AGENTS.md

This package is the authoritative Veslo runtime under test.

## Rules

- Do not use `packages/web` as proof that desktop behavior works.
- Before changing local Veslo server lifecycle, sidecar startup, workspace activation, or desktop runtime recovery, read `docs/dev/opencode-workspace-runtime-architecture.md`.
- For "test the app" or desktop-runtime validation, use the real Tauri binary and the WebDriverIO desktop harness.
- Treat Veslo desktop as single-tenant. Before launching dev mode or a WebDriverIO scenario, run the desktop test preflight from `docs/dev/testing-playbook.md`: detect running Veslo dev/test processes, stop internally started instances from this repo, and verify the runtime is clear before launching the test build.
- Do not reuse an existing WebDriver-enabled runtime by default. Attach only for an explicitly requested debug flow, and teardown must not stop an app instance the scenario did not launch.
- WebDriverIO is the Veslo desktop E2E surface. Do not add or run Tauri Pilot scenarios.
- If you touch native commands, updater flow, windowing, deep links, tray behavior, or desktop filesystem integration, verify in the real desktop runtime.
- Use `docs/dev/testing-playbook.md` and `docs/dev/build-and-rebuild-matrix.md` to choose the smallest correct verification path.
