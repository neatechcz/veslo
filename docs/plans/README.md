# Plans Directory

This directory contains historical design and implementation plans. Treat them as
implementation history, not the source of truth for current code layout.

## Veslo Server Client Layout Note

Plans written before 2026-06-27 may tell the reader to add app client methods,
types, transport code, or route strings directly to
`packages/app/src/app/lib/veslo-server.ts`. That is now stale.

Current layout:

- `packages/app/src/app/lib/veslo-server.ts` is the public barrel.
- `packages/app/src/app/lib/veslo-server/client.ts` owns
  `createVesloServerClient`, AI access helpers, and flat compatibility aliases.
- `packages/app/src/app/lib/veslo-server/connection.ts` owns URL/settings,
  invite links, bundle links, and archive client option resolution.
- `packages/app/src/app/lib/veslo-server/transport.ts` owns request transport,
  auth headers, multipart/binary helpers, and `VesloServerError`.
- `packages/app/src/app/lib/veslo-server/types.ts` owns public `Veslo*` DTO,
  request, and response types.
- `packages/app/src/app/lib/veslo-server-domains/*.ts` owns domain request
  mapping.

For current app/server client contract rules, use:

- `docs/dev/veslo-server-app-contract.md`
- `docs/dev/app-map.md`
- `docs/plans/2026-06-27-veslo-server-client-modularization-plan.md`
