# App Controllers

Controllers own cross-store orchestration that is too stateful for UI components
and too navigation-aware for stores.

Rules:

- Keep pure route/state policy in exported helper functions with unit tests.
- Keep Solid effects thin: read reactive inputs, call a controller, execute the returned action.
- Do not let stores call router navigation directly.
- Do not let route effects mutate state that is owned by a command such as `selectSession`.

Target layout:

- `session-route-controller.ts` - URL/session route decisions.
- `session-creation-flow.ts` - create conversation/session, materialize sidebar state, route, select.
- `app-startup-controller.ts` - desktop/web boot hydration and deep-link handoff.
- `managed-ai-config-sync.ts` - model/provider config reconciliation.
