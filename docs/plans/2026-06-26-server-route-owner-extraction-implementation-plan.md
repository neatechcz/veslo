# Implementacni plan: route adapter extrakce a UI request agregace

Status note: this plan is historical implementation history. The route adapter
and UI domain facade work described here is complete, and newer controller/owner
extraction work added `ai-gateway-runtime-owner.ts`, `soul-controller.ts`,
`workspace-config-owner.ts`, and `dashboard-update-pill-model.ts`. For the
current source-of-truth map, use `docs/dev/app-map.md` and
`docs/fixes/2026-07-01-fix-17-controller-owner-extraction.md`.

## Kontext

Puvodni audit spravne nasel rozpad smlouvy mezi UI klientem a serverem a prilis velky `server.ts`.
Sirsi kontrola ale ukazala, ze vetsina velkych domen uz ma business ownera nebo resource ownership model.
Tento plan proto **nevytvari nove domenove ownery**. Cilem je vytahnout HTTP route adaptery ze `server.ts`,
pripojit je k existujicim domenam a zaroven zavest jednu UI-facing request fasadu pro kazdou rozumnou skupinu
pozadavku.

Rozpad smlouvy mezi UI a serverem se nevyresi pouze tim, ze se kod presune ze `server.ts` do `routes/*`.
Musime soucasne zmensit a zpresnit klientsky kontrakt: UI nema skladat jednu obrazovku z nahodnych metod ve
velkem `veslo-server.ts`, ale ma mluvit pres jeden soubor/fasadu pro danou domenu nebo read model.

Pravidlo pro tento plan:

- `done: false` znamena planovano nebo rozpracovano, ale jeste neovereno.
- `done: true` nastavujeme az po presunu kodu, pruchodu cilene validace, typechecku, `build:bin` pri zmene server source a `git diff --check`.
- Pri realizaci se meni pouze konkretni polozky, ktere byly opravdu dokoncene.
- Kazda implementacni jednotka jde test-first: nejdriv jeden cilene pojmenovany test pro jednu vec, potom minimalni implementace, potom spusteni testu proti teto veci.

## Slovnik

- `existingOwner`: domena nebo modul, ktery uz vlastni business logiku / produktove chovani.
- `resourceOwnerModel`: existujici `ResourceOwner` envelope pro app-facing inventar (`workspace`, `user`, `organization`, `platform`).
- `routeAdapter`: novy soubor v `packages/server/src/routes/*`, ktery pouze registruje HTTP routy a vola existujici domenove moduly.
- `domainClientFacade`: jeden UI-facing soubor pro skupinu pozadavku, napr. `veslo-server-domains/mcp.ts`; vlastni klientsky kontrakt a path mapping pro danou domenu.
- `aggregateReadEndpoint`: server endpoint, ktery vraci uceleny read model pro jednu obrazovku nebo skupinu UI pozadavku; nepouzivat pro mutace.
- `legacyFlatClientMethod`: puvodni flat metoda na `VesloServerClient`, ktera zustava jako wrapper kvuli kompatibilite call sites; implementacne zije v `packages/app/src/app/lib/veslo-server/client.ts`, zatimco `veslo-server.ts` je public barrel.
- `done`: stav implementace route adapteru, ne stav business domeny.

## Korigovane zjisteni

- `soul` uz ma business moduly: `soul-cache`, `soul-den-client`, `soul-memory`, `soul-materializer`.
- `skills` uz maji business moduly: `skills`, `skill-registry-client`, `skill-materializer`, `skill-resolver`, `skill-hub`, `user-skill-store`, `workspace-skill-set`, `skill-removal-journal`, `skill-enabled-overrides`, `platform-managed-skills`.
- `mcp` uz ma domenovy modul `mcp.ts` a dokumentovany connected-app owner. `ResourceOwner` u MCP znamena vlastnika durable config/listingu, ne runtime polling, OAuth grant nebo token refresh ownera.
- `plugins`, `commands`, `MCP`, `skills` a `soul` uz pouzivaji nebo vraci app-facing ownership metadata. Route extrakce to nesmi duplikovat.
- `opencode-router` je HTTP namespace a sidecar package, ale produktovy owner teto casti je Messaging/Identities surface (`identities.tsx`) a OpenCode Router bridge.
- `automations` uz maji ownera v `automations.ts`, `automation-store.ts`, `automation-runner.ts` a dokumentaci. Route adapter je pouze HTTP vrstva.
- UI `soul`, `skills`, `mcp`, `plugins`, `commands` a `automations` realne vola; nejsou obecne orphaned/admin.
- Zbyvajici problem: HTTP adaptery pro tyto domeny a dalsi route clustery jsou porad registrovane primo v `server.ts`.

## Upresnene rozhodnuti: UI request agregace

Chceme zavest dve komplementarni vrstvy:

- **UI domain facade**: jeden soubor na klientovi pro jednu skupinu pozadavku. UI stranka nebo context sahne na
  `client.mcp`, `client.skills`, `client.identities`, `client.automations` atd., ne na desitky flat metod ani raw path stringu.
- **Server route adapter**: jeden soubor na serveru pro HTTP namespace dane domeny. Adapter je tenky a vola existujici
  owner/modul (`mcp.ts`, `skills.ts`, `automations.ts`, `soul-*`, ...).
- **Aggregate read endpoint**: pouzit jen tam, kde jedna UI obrazovka dnes potrebuje vice requestu pro jeden uceleny
  pohled. Fasada muze nejdriv agregovat klientsky a az potom se prida server read model, pokud to opravdu snizi
  chatty UI nebo zpevni kontrakt.

Co tim resime:

- UI uz nebude muset hledat jednu feature v jednom velkem `veslo-server.ts` a nekolika pages/context souborech.
- Server routy budou podle domen, ale nevzniknou duplicitni business ownery.
- Testovatelny kontrakt bude lezet na hranici `domainClientFacade <-> routeAdapter`, ne implicitne v string literal
  cestach rozesetych po aplikaci.

Co tim zamerne neresime ted:

- Modularizaci velkych UI komponent a pages mimo request vrstvu.
- Prepis vsech endpointu na nove URL. Stavajici HTTP kontrakt zustava kompatibilni, pokud neni explicitne opravovana
  chyba jako `/veslo-code-router` vs `/opencode-router`.
- Slouceni MCP, plugins a skills pod novy "extensions" business owner. Muze vzniknout `extensions-inventory` read model
  pro UI prehled, ale mutations a domenove ownership zustanou oddelene.

## Otevrena rozhodnuti pred implementaci

- Otazka: Ma byt `extensions-inventory` samostatna UI fasada pro prehled extensions?
  - Doporuceny default: ano, ale pouze jako read model/fasada. Nesmime z nej udelat noveho ownera pro MCP, plugins,
    skills nebo commands.

- Rozhodnuti: Maji legacy flat metody na `VesloServerClient` zustat verejne dostupne behem migrace?
  - Ano. Zustanou jako delegujici wrappery v `veslo-server/client.ts`, dokud nejsou migrovane call sites a testy dane domeny. Public `veslo-server.ts` zustava jen barrel.

- Otazka: Ma byt server aggregate endpoint povinny hned pri vytvoreni UI fasady?
  - Doporuceny default: ne. Nejdriv udelat klientskou fasadu nad existujicimi endpointy; server aggregate endpoint pridat
    jen tam, kde jedna obrazovka realne sklada vice requestu do jednoho read modelu.

## Test-first realizacni cyklus

Kazda polozka v implementacnim poradi se dela v malych krocich. Jeden krok znamena jednu overitelnou vec:
jeden route prefix, jedna domenova fasada, jedna legacy wrapper metoda, jeden aggregate read endpoint nebo jedna migrace
jedne UI call site skupiny.

Pro kazdy krok plati:

1. **Napsat test**
   - Test musi popsat jeden konkretni kontrakt nebo chovani.
   - Typicky testy:
     - client facade sklada spravny path a HTTP metodu,
     - server route adapter registruje stejny path,
     - legacy flat metoda deleguje do nove domenove fasady,
     - UI page/context pouziva jednu domenovou fasadu,
     - aggregate read endpoint vraci jeden stabilni read model.
   - Pokud je mozne test nejdriv spustit jako cerveny, spustit ho pred implementaci a ponechat si vystup v poznamce.
     Pokud uz chovani nahodou prochazi, test porad zustava jako kontrakt pred refactorem.

2. **Implementovat jednu vec**
   - Udelat pouze minimalni zmenu potrebnou pro prave napsany test.
   - Nemichat route extrakci, UI migraci, prejmenovani a aggregate endpoint v jednom kroku.
   - Neprepisovat souvisejici velke soubory nad ramec daneho testu.

3. **Spustit cilene testy**
   - Nejdriv spustit presne test, ktery byl pridan nebo zmenen.
   - Pokud test spadne, opravit jen tuto vec a znovu spustit stejny test.
   - Teprve po zelenem cilenem testu prejit na dalsi jednotku.

4. **Spustit domenovou validaci**
   - Po dokonceni cele domeny spustit souvisejici suite uvedenou u dane polozky.
   - Pri zmene `packages/server/src` vzdy spustit `pnpm --filter veslo-server build:bin`.
   - Na konci checkpointu spustit `git diff --check`.

`done: true` pro implementacni polozku je povolene az kdyz:

- existuje test napsany pred nebo soucasne s implementaci dane jednotky,
- implementace timto testem prosla,
- prosly domenove validace uvedene v polozce,
- plan ma doplnenou konkretni validation poznamku.

## Cilova mapa UI-facing fasad

- `packages/app/src/app/lib/veslo-server.ts`
  - zustava public barrel a kompatibilni import path pro app code.
  - root composer je `packages/app/src/app/lib/veslo-server/client.ts`.
  - shared transport je `packages/app/src/app/lib/veslo-server/transport.ts`.
  - nebude mistem, kde UI hleda konkretni feature kontrakt.

- `packages/app/src/app/lib/veslo-server-domains/messaging-identities.ts`
  - UI owner: `identities.tsx`.
  - Server adapter: `routes/opencode-router.ts`.
  - Ucel: Telegram/Slack identities a OpenCode Router bridge.

- `packages/app/src/app/lib/veslo-server-domains/automations.ts`
  - UI owner: automations surface.
  - Server adapter: `routes/automations.ts`.
  - Ucel: Veslo automations CRUD/run/list read model.

- `packages/app/src/app/lib/veslo-server-domains/mcp.ts`
  - UI owner: MCP connected apps.
  - Server adapter: `routes/mcp.ts`.
  - Ucel: hub/workspace MCP listing, install/connect/status actions.

- `packages/app/src/app/lib/veslo-server-domains/plugins.ts`
  - UI owner: OpenCode plugins config surface.
  - Server adapter: `routes/plugins.ts`.
  - Ucel: plugin listing/install/remove/config read model.

- `packages/app/src/app/lib/veslo-server-domains/commands.ts`
  - UI owner: commands runtime/config surface.
  - Server adapter: `routes/commands.ts`.
  - Ucel: command inventory a enable/disable/config calls.

- `packages/app/src/app/lib/veslo-server-domains/skills.ts`
  - UI owner: skills surfaces.
  - Server adapters: `routes/skill-registry.ts`, `routes/workspace-skills.ts`, `routes/user-global-skills.ts`,
    `routes/skill-enabled.ts`, `routes/skill-removals.ts`, `routes/skill-materialization.ts`.
  - Ucel: jedna klientska vstupni cesta pro skills UI, i kdyz server zustane rozdelen podle subdomen.

- `packages/app/src/app/lib/veslo-server-domains/soul.ts`
  - UI owner: Soul surface.
  - Server adapter: `routes/soul.ts`.
  - Ucel: soul summaries, materialization, memory/cache operations.

- `packages/app/src/app/lib/veslo-server-domains/extensions-inventory.ts`
  - UI owner: pouze read model pro extension overview, ne business owner.
  - Server adapters: sklada `mcp`, `plugins`, `skills`, pripadne `commands`.
  - Ucel: jedna cesta pro obrazovku, ktera potrebuje spolecny prehled extensions. Mutace zustanou v domenovych
    fasadach (`mcp`, `plugins`, `skills`, `commands`).

- `packages/app/src/app/lib/veslo-server-domains/workspace.ts`
  - UI owner: workspace management/platform runtime.
  - Server adapters: `routes/workspace-management.ts`, `routes/health.ts`, `routes/status.ts`.
  - Ucel: workspace config/events/system/audit/status.

- `packages/app/src/app/lib/veslo-server-domains/conversations.ts`
  - UI owner: conversation runtime.
  - Server adapter: `routes/conversations.ts`, `routes/sessions.ts`.
  - Ucel: sessions, transcripts, conversation state.

- `packages/app/src/app/lib/veslo-server-domains/files.ts`
  - UI owner: filesystem workflows.
  - Server adapter: `routes/file-sessions.ts`.
  - Ucel: file sessions, inbox, artifacts.

## Aktualni checkpoint

- id: owner-alignment-audit
  done: true
  scope: Opravena interpretace planu: nevytvaret nove ownery pro domeny, ktere uz ownera maji.
  validation: grep pres `docs/dev/veslo-server-app-contract.md`, `docs/features/extensions-and-integrations.md`, `docs/features/soul-and-automations.md`, `docs/dev/state-and-config-reference.md`, `packages/server/src/resource-owner.ts`, `mcp.ts`, `automations.ts`.

- id: fix-opencode-router-contract
  done: true
  existingOwner: messaging-identities / opencode-router-bridge
  routeAdapter: `routes/opencode-router.ts`
  scope: UI klient, orchestrator a server route namespace sjednocene na `/opencode-router`.
  note: Nazev route adapteru zustava podle HTTP namespace; nevytvari novy OpenCode owner.
  validation: UI route contract tests, orchestrator route test, typechecky.

- id: add-routing-primitives
  done: true
  existingOwner: platform-runtime
  routeAdapter: `routing.ts`, `route-helpers.ts`
  scope: Sdilene Bun route primitive a helpery mimo `server.ts`.
  validation: server typecheck.

- id: extract-opencode-router-routes
  done: true
  existingOwner: messaging-identities / opencode-router-bridge
  routeAdapter: `routes/opencode-router.ts`
  routes: 13
  namespace: `/workspace/:id/opencode-router`
  sourceModules: `packages/opencode-router`, OpenCode Router config file, `identities.tsx`
  note: Toto je Messaging/Identities HTTP adapter nad OpenCode Routerem, ne MCP a ne obecny OpenCode runtime owner.
  validation: server route contract test, mount/normalizace testy, server typecheck, `build:bin`.

- id: extract-automations-routes
  done: true
  existingOwner: veslo-automations
  routeAdapter: `routes/automations.ts`
  routes: 12
  namespace: `/workspace/:id/automations`, legacy `/workspace/:id/agentlab/automations`
  sourceModules: `automations.ts`, `automation-store.ts`, `automation-runner.ts`
  note: Legacy AgentLab routy zustaly kompatibilni, ale owner je Veslo Automations; nevznikl novy AgentLab owner.
  validation: automations domain tests, automations server E2E, server typecheck, `build:bin`.

## Implementacni poradi

### Faze 0: kontrakt a UI request agregace

- id: define-ui-domain-facade-map
  done: true
  scope: Zafixovat mapu `domainClientFacade -> routeAdapter -> existingOwner` podle sekce "Cilova mapa UI-facing fasad".
  validation: Plan review pri server route extrakci; zbyvajici adaptery ponechaly MCP, plugins, skills, soul, workspace, conversations a files jako oddelene existujici ownery/read-model skupiny bez noveho duplicitniho business ownera.

- id: add-ui-domain-client-directory
  done: true
  scope: Pridat `packages/app/src/app/lib/veslo-server-domains/*` a sdileny typed transport/helpery pro path composition.
  note: `veslo-server.ts` je public barrel; `veslo-server/client.ts` je root composer a kompatibilni adapter pro legacy flat metody.
  validation: Prvni fasady `veslo-server-domains/messaging-identities.ts`, `veslo-server-domains/automations.ts`, `veslo-server-domains/plugins.ts`, `veslo-server-domains/commands.ts` a `veslo-server-domains/mcp.ts` pridany test-first; targeted domain facade tests passed; OpenCode Router, automations, plugins, commands a MCP client tests passed; app typecheck passed.

- id: compose-domain-clients-in-veslo-server-client
  done: true
  scope: `createVesloServerClient` bude vracet domenove vstupy typu `client.identities`, `client.automations`, `client.mcp`, ...
  note: `client.identities`, `client.automations`, `client.plugins`, `client.commands`, `client.mcp`, `client.skills`, `client.soul`, `client.workspace`, `client.conversations`, `client.files` a read-only `client.extensionsInventory` hotove; legacy flat metody zustavaji docasne wrappery delegujici do domenovych fasad, aby migrace nemusela byt big bang.
  validation: Test-first `createVesloServerClient exposes remaining domain facades`, `skills domain facade exposes workspace, registry and materialization endpoints`, `soul domain facade exposes soul read and mutation endpoints`, `workspace domain facade exposes management and status endpoints`, `conversations domain facade exposes conversation, transcript and archive endpoints`, `files domain facade exposes file session, workspace file and artifact endpoints` and `extensions inventory domain facade aggregates read-only extension requests` added; targeted `veslo-server.test.ts`, route manifest contract test, domain modularization test and app typecheck passed.

- id: migrate-identities-ui-to-domain-facade
  done: true
  existingOwner: messaging-identities / opencode-router-bridge
  domainClientFacade: `veslo-server-domains/messaging-identities.ts`
  routeAdapter: `routes/opencode-router.ts`
  scope: `identities.tsx` a souvisejici testy pouziji jeden klientsky vstup pro Telegram/Slack identity calls.
  validation: Test-first `identities page uses the messaging identities domain facade for router requests` added, failed before migration and passed after migration; full identities contract test passed; app typecheck passed.

- id: migrate-automations-ui-to-domain-facade
  done: true
  existingOwner: veslo-automations
  domainClientFacade: `veslo-server-domains/automations.ts`
  routeAdapter: `routes/automations.ts`
  scope: Automations UI bude pouzivat jednu fasadu misto flat metod.
  validation: Test-first `automations domain facade exposes workspace automation endpoints` added, failed before implementation and passed after implementation; `App uses the automations domain facade for server automation requests` failed before app migration and passed after migration; scheduled automations contract tests passed; app typecheck passed.

- id: migrate-plugins-ui-to-domain-facade
  done: true
  existingOwner: opencode-plugins
  resourceOwnerModel: `PluginItem.owner` pres `ResourceOwner`
  domainClientFacade: `veslo-server-domains/plugins.ts`
  routeAdapter: `routes/plugins.ts`
  scope: Extensions plugin flows pouziji `client.plugins` misto flat plugin metod.
  validation: Test-first `plugins domain facade exposes workspace plugin endpoints` added, failed before implementation and passed after implementation; `extensions plugin requests use the plugins domain facade` failed before extensions migration and passed after migration; app typecheck passed.

- id: add-commands-domain-facade
  done: true
  existingOwner: commands-runtime
  resourceOwnerModel: `CommandItem.owner` pres `ResourceOwner`
  domainClientFacade: `veslo-server-domains/commands.ts`
  routeAdapter: `routes/commands.ts`
  scope: `createVesloServerClient` exposes `client.commands`; legacy flat command methods delegate to it.
  note: No Veslo server command UI caller found to migrate. The visible composer `.listCommands()` flow is OpenCode session command completion, not this Veslo server commands API.
  validation: Test-first `commands domain facade exposes workspace command endpoints` added, failed before implementation and passed after implementation; app typecheck passed.

- id: migrate-mcp-ui-to-domain-facade
  done: true
  existingOwner: mcp-connected-apps
  resourceOwnerModel: `McpItem.owner` pres `ResourceOwner`; config/listing owner only
  domainClientFacade: `veslo-server-domains/mcp.ts`
  routeAdapter: `routes/mcp.ts`
  scope: `createVesloServerClient` exposes `client.mcp`; `extensions.ts` a `app.tsx` pouzivaji jednu MCP fasadu pro hub catalog a workspace connected-app requests.
  note: Legacy flat MCP metody zustavaji docasne wrappery delegujici do `client.mcp`. Nevznika novy `extensions-platform` owner.
  validation: Test-first `mcp domain facade exposes hub and workspace mcp endpoints` added, failed before implementation and passed after implementation; `extensions store uses the mcp domain facade for hub mcp server requests` and `App uses the mcp domain facade for workspace mcp server requests` failed before migration and passed after migration; `mcp-hub-contract.test.ts`, `mcp-runtime-install-contract.test.ts`, targeted MCP client tests and app typecheck passed.

- id: add-route-manifest-contract-tests
  done: true
  scope: Doplnit test, ktery porovna klientsky path mapping domenove fasady se server route adapterem pro kazdou migrovanou domenu.
  note: Cilem je zachytit dalsi `/client-prefix` vs `/server-prefix` drift driv nez v runtime UI.
  validation: Test-first `veslo-server-route-manifest-contract.test.ts` added; automations facade requests now match `routes/automations.ts`, messaging identities workspace requests now match `routes/opencode-router.ts`, plugins facade requests now match `routes/plugins.ts`, commands facade requests now match `routes/commands.ts` and MCP facade requests now match `routes/mcp.ts`; targeted manifest test passed.

- id: add-aggregate-read-model-policy
  done: true
  scope: Pro kazdou obrazovku urcit, zda staci klientska fasada nad existujicimi endpointy, nebo ma vzniknout server aggregate read endpoint.
  rule: Agregovat read modely, ne mutace. Mutace zustavaji explicitni a domenove.
  policy: V tomto checkpointu nevznika zadny novy server aggregate endpoint. `identities`, `automations`, `plugins`, `commands`, `mcp`, `skills`, `soul`, `workspace`, `conversations` a `files` staci jako klientske domenove fasady nad existujicimi endpointy. `extensionsInventory` je pouze client-side read model skladajici `mcp`, `plugins`, `skills` a `commands`; mutace zustavaji v puvodnich domenovych fasadach.
  futureRule: Server aggregate read endpoint muze vzniknout az po explicitnim plan update pro konkretni obrazovku/read model a nesmi prijimat mutace.
  validation: `extensionsInventory.overview` pokryto testem jako read-only client aggregate; nebyl pridan novy server aggregate endpoint ani novy `extensions-platform` owner; targeted app client test and app typecheck passed.

### Faze 1: male route adaptery s jasnym existujicim modulem

- id: extract-plugins-routes
  done: true
  existingOwner: opencode-plugins
  resourceOwnerModel: `PluginItem.owner` pres `ResourceOwner`
  routeAdapter: `routes/plugins.ts`
  routes: 3
  namespace: `/workspace/:id/plugins`
  sourceModules: `plugins.ts`, OpenCode config
  note: Nevytvaret "extensions-platform" owner. Plugins jsou OpenCode-native config surface s resource owner envelope pro inventar.
  validation: Test-first `server.plugins-routes.test.ts` added, failed before `routes/plugins.ts` existed and passed after extraction; plugin route registration test passed; plugin UI/server manifest contract test passed; server typecheck, app typecheck and `build:bin` passed.

- id: extract-commands-routes
  done: true
  existingOwner: commands-runtime
  resourceOwnerModel: `CommandItem.owner` pres `ResourceOwner`
  routeAdapter: `routes/commands.ts`
  routes: 3
  namespace: `/workspace/:id/commands`
  sourceModules: `commands.ts`
  note: `GET /commands?scope=global` zachovava puvodni host authorization pres injectnuty `requireHost`; nevznikl novy owner.
  validation: Test-first `server.commands-routes.test.ts` added, failed before `routes/commands.ts` existed and passed after extraction; command route registration test passed; command UI/server manifest contract test passed; server typecheck, app typecheck and `build:bin` passed.

- id: extract-scheduler-routes
  done: true
  existingOwner: scheduler-runtime
  routeAdapter: `routes/scheduler.ts`
  routes: 2
  namespace: `/workspace/:id/scheduler/jobs`
  sourceModules: `scheduler.ts`
  note: Scheduler routy nedavat pod automations; Veslo Automations ma vlastni API a scheduler je legacy/runtime system-job surface.
  validation: Test-first `server.scheduler-routes.test.ts` added, failed before `routes/scheduler.ts` existed and passed after extraction; scheduler route registration test passed; server typecheck and `build:bin` passed.

- id: extract-session-archives-routes
  done: true
  existingOwner: session-history
  routeAdapter: `routes/session-archives.ts`
  routes: 3
  namespace: `/session-archives`
  sourceModules: `session-archives.ts`
  deps: `sessionArchives`
  validation: Test-first `server.session-archives-routes.test.ts` added, failed before `routes/session-archives.ts` existed and passed after extraction; session archive route registration, mounted route tests, store tests, server typecheck and `build:bin` passed.

- id: extract-ai-gateway-routes
  done: true
  existingOwner: ai-gateway
  routeAdapter: `routes/ai-gateway.ts`
  routes: 6
  namespace: `/ai-gateway`
  sourceModules: AI gateway proxy helpers currently in server
  note: Adapter pouze mapuje HTTP paths na existujici proxy funkce pres dependency; proxy/session/runtime authorization logika zustava v puvodnim ownerovi.
  validation: Test-first `server.ai-gateway-routes.test.ts` added, failed before `routes/ai-gateway.ts` existed and passed after extraction; full `server.ai-gateway.test.ts`, server typecheck and `build:bin` passed.

- id: extract-mcp-routes
  done: true
  existingOwner: mcp-connected-apps
  resourceOwnerModel: `McpItem.owner` pres `ResourceOwner`; config/listing owner only
  routeAdapter: `routes/mcp.ts`
  routes: 7
  namespace: `/hub/mcp`, `/workspace/:id/mcp`
  sourceModules: `mcp.ts`, `den-catalog.ts`, OpenCode config
  note: Nevytvaret "extensions-platform" owner. MCP page je connected-app owner. Runtime status polling, OAuth grants a connector token refresh zustavaji oddelene od `McpItem.owner`.
  validation: Test-first `server.mcp-routes.test.ts` added, failed before `routes/mcp.ts` existed and passed after extraction; `server.hub-mcp.test.ts`, `mcp.remote-connect.e2e.test.ts`, `den-catalog.test.ts`, MCP app contract tests, MCP UI/server manifest contract, server typecheck, app typecheck and `build:bin` passed.

### Faze 2: files, conversations a runtime state

- id: extract-file-session-routes
  done: true
  existingOwner: filesystem-workflows
  routeAdapter: `routes/file-sessions.ts`
  routes: 15
  namespace: `/files/sessions`, `/workspace/:id/files`, `/workspace/:id/inbox`, `/workspace/:id/artifacts`
  deps: `fileSessions`, `recordWorkspaceFileEvent`
  validation: Test-first `server.file-sessions-routes.test.ts` added, failed before `routes/file-sessions.ts` existed and passed after extraction; `server.bounded-body.test.ts`, `session-artifacts.test.ts`, server typecheck, `build:bin` and `git diff --check` passed.

- id: extract-conversation-session-routes
  done: true
  existingOwner: conversation-runtime
  routeAdapter: `routes/conversations.ts`
  routes: 12
  namespace: `/workspace/:id/conversations`, `/workspace/:id/sessions`
  deps: `conversationService`, `conversationRunQueueStore`, `sessionTranscriptPrefetch`, lifecycle helpers
  note: Conversation a session transcript/artifact routy jsou zamerne v jednom adapteru, protoze tvori jednu UI/runtime skupinu.
  validation: Test-first `server.conversation-session-routes.test.ts` added, failed before `routes/conversations.ts` existed and passed after extraction; `server-session-transcript-prefetch.test.ts`, `server-conversations.test.ts`, `server-stale-active-run.integration.test.ts`, `server.bounded-body.test.ts`, `session-artifacts.test.ts`, server typecheck, `build:bin` and `git diff --check` passed.

### Faze 3: skills podle realnych subdomen

- id: extract-skill-registry-routes
  done: true
  existingOwner: skills-registry
  routeAdapter: `routes/skill-registry.ts`
  routes: 17
  namespace: `/v1/skills`, `/v1/skill-installations`, `/v1/skill-rollout-policies`, `/v1/skill-registry-events`
  sourceModules: `skill-registry-client.ts`, `skill-registry-types.ts`, `workspace-skill-set.ts`
  note: Toto nejsou orphaned routy; UI je pres klienta realne pouziva. Registry ownership zustava cloud/registry-side, server route je lokalni proxy adapter.
  validation: Test-first `server.skill-registry-routes.test.ts` added, failed before `routes/skill-registry.ts` existed and passed after extraction; `server.skill-registry-search.test.ts`, `skill-registry-client.test.ts`, `skill-registry-types.test.ts`, `workspace-skill-set.test.ts`, app `veslo-server.test.ts`, server typecheck, `build:bin` and `git diff --check` passed.

- id: extract-skill-removal-routes
  done: true
  existingOwner: skills-runtime
  routeAdapter: `routes/skill-removals.ts`
  routes: 3
  namespace: `/skill-removals`, `/skills/batch-remove`
  sourceModules: `skill-removal-journal.ts`, `skills.ts`
  validation: Test-first `server.skill-removal-routes.test.ts` added, failed before `routes/skill-removals.ts` existed and passed after extraction; `skill-removal-journal.test.ts`, `server.skill-batch-remove.test.ts`, server typecheck, `build:bin` and `git diff --check` passed.

- id: extract-skill-enabled-routes
  done: true
  existingOwner: skills-runtime
  routeAdapter: `routes/skill-enabled.ts`
  routes: 2
  namespace: `/skills/disabled`, `/skills/enabled-state`
  sourceModules: `skill-enabled-overrides.ts`
  validation: Test-first `server.skill-enabled-routes.test.ts` added, failed before `routes/skill-enabled.ts` existed and passed after extraction; `skills.test.ts`, app `veslo-server.test.ts`, server typecheck, `build:bin` and `git diff --check` passed. No existing standalone `server.skill-enabled-overrides.test.ts` file was present.

- id: extract-user-global-skills-routes
  done: true
  existingOwner: user-global-skills
  resourceOwnerModel: user-owned `ResourceOwner`
  routeAdapter: `routes/user-global-skills.ts`
  routes: 6
  namespace: `/skills/user-global-store`, `/skills/user-global`
  sourceModules: `user-skill-store.ts`, `skills.ts`
  note: `/workspace/:id/skills/user-global-store/sync` zustava v materialization checkpointu, protoze materializuje user-global store do workspace runtime.
  validation: Test-first `server.user-global-skills-routes.test.ts` added, failed before `routes/user-global-skills.ts` existed and passed after extraction; `user-skill-store.test.ts`, `server.user-skill-store.test.ts`, `skill-removal-journal.test.ts`, app `veslo-server.test.ts`, server typecheck, `build:bin` and `git diff --check` passed.

- id: extract-skill-materialization-routes
  done: true
  existingOwner: skills-materialization
  routeAdapter: `routes/skill-materialization.ts`
  routes: 5
  namespace: `/skills/materialization`, `/workspace/:id/skills/materialization`, `/workspace/:id/skills/user-global-store/sync`
  sourceModules: `skill-materializer.ts`, `workspace-skill-lockfile.ts`, `platform-managed-skills.ts`, `workspace-skill-set.ts`
  deps: `serverDataDir`
  validation: Test-first `server.skill-materialization-routes.test.ts` added, failed before `routes/skill-materialization.ts` existed and passed after extraction; `server.skill-materialization.test.ts`, server typecheck and `build:bin` passed.

- id: extract-workspace-skills-routes
  done: true
  existingOwner: workspace-skills
  resourceOwnerModel: workspace-owned `ResourceOwner`
  routeAdapter: `routes/workspace-skills.ts`
  routes: 7
  namespace: `/hub/skills`, `/workspace/:id/skills`
  sourceModules: `skills.ts`, `skill-hub.ts`, `skill-resolver.ts`
  validation: Test-first `server.workspace-skills-routes.test.ts` added, failed before `routes/workspace-skills.ts` existed and passed after extraction; `server.hub-skills.test.ts`, `server.skill-materialization.test.ts`, `skills.test.ts`, `skill-hub.test.ts`, `workspace-skill-set.test.ts`, server typecheck and `build:bin` passed.

### Faze 4: Soul HTTP adapter

- id: extract-soul-routes
  done: true
  existingOwner: soul-runtime
  resourceOwnerModel: Soul summaries return organization/user/workspace `ResourceOwner`
  routeAdapter: `routes/soul.ts`
  routes: 17
  namespace: `/soul`, `/workspace/:id/soul`
  sourceModules: `soul-cache.ts`, `soul-den-client.ts`, `soul-memory.ts`, `soul-materializer.ts`
  deps: `serverDataDir`, soul read/materialization helper slice
  note: Soul business ownership uz existuje; extrahuje se pouze HTTP adapter a jeho orchestrace.
  validation: Test-first `server.soul-routes-registration.test.ts` added, failed before `routes/soul.ts` existed and passed after extraction; `soul-routes.test.ts`, `soul-memory.test.ts`, `soul-den-client.test.ts`, `soul-cache.test.ts`, `soul-materializer.test.ts`, server typecheck and `build:bin` passed.

### Faze 5: platform/admin a workspace management

- id: extract-health-status-ui-routes
  done: true
  existingOwner: platform-runtime
  routeAdapter: `routes/health.ts`
  routes: 11
  namespace: `/health`, `/status`, `/capabilities`, `/ui`, `/w/:id/*`
  note: Pred extrakci rozdelit health/ui/status od workspace-management, aby nevznikl novy monolit.
  validation: Test-first `server.health-status-routes.test.ts` added, failed before `routes/health.ts` existed and passed after extraction; hub capabilities tests, server typecheck and `build:bin` passed.

- id: extract-workspace-management-routes
  done: true
  existingOwner: workspace-management
  routeAdapter: `routes/workspace-management.ts`
  routes: 13
  namespace: `/workspaces`, `/workspace/:id/config`, `/workspace/:id/events`, `/workspace/:id/system`, `/workspace/:id/audit`, import/export
  deps: `serializeWorkspaceForResponse`, workspace config/provision helpers
  validation: Test-first `server.workspace-management-routes.test.ts` added, failed before `routes/workspace-management.ts` existed and passed after extraction; `server.workspaces-crud.test.ts`, `server.automations.test.ts`, `soul-routes.test.ts`, server typecheck and `build:bin` passed.

- id: extract-admin-token-approval-routes
  done: true
  existingOwner: platform-infra / approval-workflow
  routeAdapter: `routes/admin.ts`
  routes: 6
  namespace: `/tokens`, `/whoami`, `/approvals`
  note: Tyto routy nejsou produkcni UI feature ownership; jsou platform/admin infrastruktura.
  validation: Test-first `server.admin-routes-registration.test.ts` added, failed before `routes/admin.ts` existed and passed after extraction; `tokens.test.ts`, approval coverage in `server.automations.test.ts` and `soul-routes.test.ts`, server typecheck and `build:bin` passed.

## Duplicate/remediation notes

- id: remove-fake-owner-labels-from-plan
  done: true
  scope: Plan no longer uses broad labels such as `extensions-platform` for MCP/plugins where a more precise existing owner exists.
  validation: plan review.

- id: keep-opencode-router-route-adapter-name
  done: true
  scope: `routes/opencode-router.ts` remains named after HTTP namespace, but plan documents existing owner as Messaging/Identities.
  validation: no code rename required.

- id: keep-automations-route-adapter
  done: true
  scope: `routes/automations.ts` matches existing Veslo Automations ownership; no duplicate owner introduced.
  validation: automations E2E already passed.

- id: do-not-merge-mcp-plugins-skills-under-extensions-platform
  done: true
  scope: Future route extraction must keep MCP, plugins and skills as separate adapters because the repo already documents separate surfaces.
  validation: Enforced during remaining skills route extraction; `routes/mcp.ts`, `routes/plugins.ts`, `routes/skill-*.ts` and `routes/workspace-skills.ts` remain separate adapters without an extensions-platform owner.

## Pracovni pravidla pro kazdou extrakci

- id: test-first-one-thing
  done: true
  rule: Kazda zmena zacina jednim testem pro jednu vec; implementace smi pokryt jen chovani popsane timto testem.

- id: run-targeted-test-before-next-change
  done: true
  rule: Pred dalsi implementacni jednotkou musi projit cilene testy pro prave dokoncovanou vec.

- id: no-batched-contract-changes
  done: true
  rule: Nemichat vice kontraktnich zmen v jednom kroku. Pokud se meni route adapter i UI fasada, musi mit samostatne testy a samostatne overeni.

- id: preserve-route-contract
  done: true
  rule: HTTP metoda, path, auth mode, response shape a error kody zustavaji stejne.

- id: prefer-existing-business-modules
  done: true
  rule: Route controller ma volat existujici domenove moduly; nepresouvat business logiku zpet do `server.ts`.

- id: avoid-fake-owners
  done: true
  rule: Nedeklarovat nove ownership hranice, pokud uz v kodu nebo dokumentaci existuji; pojmenovat pouze HTTP adapter ownership.

- id: keep-resource-owner-semantics
  done: true
  rule: `ResourceOwner` popisuje durable inventar/config vlastnictvi. Nevyvozovat z nej runtime readiness, polling, OAuth granty ani token refresh ownership.

- id: one-ui-entrypoint-per-domain
  done: true
  rule: Nova nebo migrovana UI feature ma pouzivat jednu `domainClientFacade` pro svou skupinu pozadavku, ne raw path stringy ani nahodne flat metody.

- id: keep-flat-client-methods-as-compat-wrappers
  done: true
  rule: Stare flat metody na `VesloServerClient` zustanou v `veslo-server/client.ts` jako docasne delegujici wrappery, dokud nejsou migrovane vsechny call sites dane domeny.

- id: aggregate-reads-not-mutations
  done: true
  rule: Agregovat server-side pouze read modely pro obrazovky. Mutace zustavaji explicitni v domenove fasade a route adapteru.

- id: validate-each-domain-before-next
  done: true
  rule: Po kazde domene pustit cilene testy, server typecheck, `pnpm --filter veslo-server build:bin` a `git diff --check`.

- id: update-this-plan-during-implementation
  done: true
  rule: Po dokonceni konkretni polozky zmenit pouze jeji `done` na `true` a pripadne doplnit validation poznamku.

## Finalni validace

- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server.test.ts`
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-route-manifest-contract.test.ts`
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-modularization.test.ts`
- `pnpm --filter @neatech/veslo-ui typecheck`
- `pnpm --filter veslo-server typecheck`
- `pnpm --filter veslo-server build:bin`
- `pnpm --filter veslo-server exec bun test src`
- `git diff --check`

Poznamka: `git diff --check` prosel bez whitespace chyb; Git pouze vypsal LF -> CRLF warningy pro upravene soubory na Windows.
