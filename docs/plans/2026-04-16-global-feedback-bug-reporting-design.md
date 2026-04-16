# Global Feedback Bug Reporting Design

## Goal
Dát uživatelům jednoduchý, globálně dostupný způsob, jak odkudkoliv z desktopové aplikace nahlásit bug, uložit každý report do cloudového Den control plane a ke každému uloženému reportu automaticky vytvořit odpovídající YouTrack issue s dostatkem runtime kontextu pro dohledání relevantních logů.

## Scope
- Globální `Feedback` CTA ve sdíleném app shellu na dashboard i session view.
- Jediný feedback typ v první verzi: `bug`.
- Krátký formulář jen s nadpisem a popisem problému.
- Automatický screenshot aktuální app plochy při odeslání.
- Uložení kanonického feedback záznamu do Den databáze.
- Asynchronní projekce každého uloženého feedbacku do YouTracku přes server-side YouTrack MCP.
- YouTrack issue bez assignee, ale s identitou reportera, screen contextem a log lookup blokem.
- Bez raw log dumpu v issue body, bez end-user triage UI, bez kategorií a bez řešení reply workflow.

## Design

### Entry Point and UX
- Rozšířit sdílený titlebar chrome (`TitlebarMenuToggles`) o pravý akční slot a v dashboard i session shellu do něj renderovat kompaktní `Feedback` tlačítko.
- Po kliknutí se otevře modal se dvěma poli:
  - `Title`
  - `What happened?`
- Modal technická metadata explicitně nezobrazuje. Uživatel jen dostane krátkou informaci, že Veslo přiloží aktuální obrazovku a technické detaily automaticky.
- První verze neřeší volbu typu feedbacku. Každé odeslání je bug report.
- UI považuje feedback za úspěšně odeslaný ve chvíli, kdy Den vrátí potvrzení o uložení do DB. Čekání na vytvoření YouTrack issue nesmí blokovat uživatelský flow.
- Pokud screenshot capture selže, feedback se i tak odešle a uložený záznam nese `screenshotStatus=failed`.

### Screenshot Capture
- V aktuálním repu není hotová feedback-specific screenshot IPC nebo Tauri plugin cesta.
- Pro první verzi je nejpraktičtější capture aktuální app plochy z frontendu, ne nová desktop-only nativní capability.
- Screenshot se pořizuje až při submitu, aby odpovídal přesnému stavu obrazovky v okamžiku kliknutí na `Feedback`.
- Payload se pošle jako JSON, ne multipart. Screenshot se proto předá jako komprimovaný data URL string nebo ekvivalentní serializovaný blob payload.
- Pokud později vznikne potřeba full-window nebo OS-level capture, může se vyměnit jen capture implementation bez změny feedback contractu.

### Client Payload and Context Snapshot
Každé odeslání vytváří jeden kanonický payload se třemi vrstvami dat:

- Uživatelský vstup:
  - `title`
  - `description`
- Identita a screen context:
  - `userId`
  - `userEmail`
  - `orgId`
  - `view`
  - `dashboardTab`
  - `settingsTab`
  - `selectedSessionId`
  - `workspaceId`
  - `workspacePath`
  - `workerId`
  - `runId`
- Diagnostická metadata:
  - `appVersion`
  - `locale`
  - `platform`
  - `osFamily`
  - `submittedAt`
  - `screenshotStatus`
  - `screenshotMimeType`
  - `screenshotBytes`
  - `screenshotData`

Payload se má skládat v `App`, protože právě tam už dnes existuje stabilní přístup k route/view stavu, vybrané session, aktivnímu workspace a verzi aplikace.

### Cloud Persistence in Den
Den je source of truth, ne YouTrack.

Persistovat každý report do tabulky `feedback_report` s minimálně těmito poli:
- `id`
- `type` (`bug` v první verzi)
- `status` (`pending`, `projected`, `failed`)
- `title`
- `description`
- `user_id`
- `user_email`
- `org_id`
- `view`
- `dashboard_tab`
- `settings_tab`
- `session_id`
- `workspace_id`
- `workspace_path`
- `worker_id`
- `run_id`
- `app_version`
- `locale`
- `platform`
- `os_family`
- `submitted_at`
- `screenshot_status`
- `screenshot_mime_type`
- `screenshot_bytes`
- `screenshot_data`
- `youtrack_issue_id`
- `youtrack_issue_url`
- `last_projector_error`
- `next_projector_attempt_at`
- `created_at`
- `updated_at`

Retry historii držet v druhé tabulce `feedback_projector_attempt`, ne v jednom JSON blobu. Každý attempt řádek má obsahovat:
- `id`
- `feedback_id`
- `attempt_no`
- `status`
- `error_message`
- `created_at`

To drží Den jako kanonickou evidenci a zároveň zachovává audit trail retry pokusů i v případě, že je YouTrack nebo MCP nedostupný.

### Den API Surface
Přidat autentizovaný Den endpoint:
- `POST /v1/feedback`

Chování endpointu:
- ověřit uživatele přes existující Better Auth session
- vybrat aktivní org přes existující `x-veslo-org-id` pattern
- validovat JSON payload a screenshot size
- uložit feedback record do DB
- vrátit `201` s `feedbackId` a aktuálním projection stavem
- po úspěšném insertu spustit první YouTrack projection attempt

Protože screenshot půjde v JSON payloadu, je potřeba zvýšit JSON body limit na Den serveru nad současný implicitní Express limit.

### YouTrack Projection
YouTrack je projekční cíl, ne zdroj pravdy.

Pravidla projekce:
- každý uložený feedback se snaží vytvořit právě jedno YouTrack issue
- summary format: `[Bug] <title>`
- issue zůstává bez assignee
- body obsahuje:
  - `Feedback ID`
  - `Submitted at`
  - `Reporter email`
  - `Org ID`
  - `View / tab context`
  - `Session / workspace / worker / run IDs`
  - `App version / locale / platform`
  - `Log lookup window`
  - `Screenshot reference`
  - původní popis od uživatele
- po úspěchu se `youtrackIssueId` a `youtrackIssueUrl` uloží zpět na feedback row

Transport:
- YouTrack volání držet za úzkým server-side adapterem, nepsat MCP logiku přímo do route handleru
- adapter komunikuje s lokálně nainstalovaným YouTrack MCP serverem na Den hostu
- konfigurace MCP transportu a výchozího YouTrack projektu patří do Den env/config, ne do desktop appky

### Retry and Idempotence
- Uživatelská success hranice je uložení feedbacku v Den.
- Den provede první projekční pokus okamžitě po insertu.
- Při chybě Den zapíše failed attempt row, aktualizuje `lastProjectorError` a naplánuje retry s backoffem, například `30s`, `5m`, `30m`.
- `feedbackId` je idempotency klíč. Projector musí zabránit duplikaci tím, že:
  - nejdřív zkontroluje, jestli už feedback row nemá `youtrackIssueId`
  - vždy zapisuje `Feedback ID: <id>` do issue body
- Po vyčerpání retry budgetu row přejde do `failed`, ale zůstává dohledatelný a znovu spustitelný.

### Log Lookup
V aktuálním repu jsem našel uploader kontrakt pro debug logy na straně lokálního serveru, ale nenašel jsem hotový Den ingest endpoint v `services/den`. První verze proto nemá být blokovaná novou log pipeline.

V první verzi má YouTrack issue obsahovat deterministický locator blok:
- `Feedback ID`
- `Submitted at`
- `User ID`
- `Org ID`
- `Session ID`
- `Workspace ID`
- `Worker ID`
- `Run ID`
- doporučené lookup okno, například `submittedAt - 10m` až `submittedAt + 2m`

To stačí k dohledání existujících app/runtime logů bez toho, aby issue neslo raw log output. Pokud později přibude Den debug-log ingest route, lze bez změny uživatelského flow doplnit i syntetický `feedback.submitted` marker keyed by `feedbackId`.

## Testing
- App source-contract testy mají zamknout rozšíření shared titlebaru, wiring feedback buttonu a tvar modalu.
- App transport testy mají ověřit screenshot fallback, serializaci payloadu a autentizovaný POST do Den.
- Den route testy mají ověřit auth, org resolution, payload validaci, persistence a `201` response.
- Den projector testy mají ověřit immediate success, retry scheduling, duplicate suppression a ukládání issue metadata.
- End-to-end ověření má běžet proti reálnému desktop runtime: otevřít feedback z dashboardu i session, odeslat bug, potvrdit Den persistence a potvrdit vznik odpovídajícího YouTrack issue s locator blokem.
