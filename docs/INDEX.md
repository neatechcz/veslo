# docs/ — index

Rozcestník dokumentace v `git/docs/`. Pro vysokoúrovňové docs viz
kořen repa (`ARCHITECTURE.md`, `VISION.md`, `PRINCIPLES.md`, `PRODUCT.md`,
`INFRASTRUCTURE.md`, `AGENTS.md`).

| Složka / soubor | O čem | Kdy číst |
|---|---|---|
| [`sandbox/`](sandbox/README.md) | **VSLO-86 multi-workspace handoff** pro nového vývojáře. Architektura procesů, conversation service, data flows, known issues, fixes timeline, debug playbook, E2E specs, handoff prompt. | Při přebírání práce na multi-workspace stabilizaci nebo conversation send/read flow. |
| [`dev/`](dev/) | Dev guidelines, app map, testing playbook, build matrix, state reference, veslo-server contract. | Před začátkem práce na frontendu nebo backendu. |
| [`features/`](features/) | Per-feature popisy (session-runtime, onboarding-and-auth, soul-and-automations, settings-and-preferences, workspace-config-and-sharing, extensions-and-integrations). | Když potřebuješ pochopit konkrétní feature. |
| [`plans/`](plans/) | **Historické plány** (březen-květen 2026). Většina je deprekovaná, používej jen jako kontext rozhodnutí. | Pokud hledáš proč bylo něco rozhodnuto, ne jak to teď funguje. |
| [`admin-managed-ai-access.md`](admin-managed-ai-access.md) | Admin-managed AI access flow (Den → veslo-server → engine). | Při práci na AI gateway. |
| [`desktop-updater.md`](desktop-updater.md) | Desktop updater (auto-update flow, signing, dmg). | Při práci na release / updater. |

## Vstupní body

- **Nový vývojář přebírá VSLO-86:** [`sandbox/README.md`](sandbox/README.md)
- **Nový vývojář obecně:** kořen `README.md` → `ARCHITECTURE.md` → `docs/dev/`
- **Existující dev při bugu:** podle oblasti `docs/features/<oblast>.md` nebo `docs/dev/testing-playbook.md`
