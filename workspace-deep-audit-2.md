# Workspace Switching Deep Audit 2

Datum: 2026-06-17

Rozsah: audit soucasneho prepinani workspaces v repo `C:\Users\jajse\Desktop\projekty\veslo`.

## Executive Summary

Workspace switching dnes neni jedno misto ani jedna pravda. Je to kombinace:

- frontend runtime state (`activeWorkspaceId`, `projectDir`, `activeWorkspaceRoot`)
- Tauri persisted state (`veslo-workspaces.json`)
- Veslo server workspace order, kde `workspaces[0]` funguje jako active workspace
- orchestrator router state (`activeId`) a per-workspace engine pool
- explicitni workspace-scoped routes, ktere globalni active id obchazeji zamerne

Nejdulezitejsi prekvapeni: kliknuti na session muze byt jen browse-only bez runtime prepnuti, ale send/retry/replace pred odeslanim workspace opravdu aktivuje. To znamena, ze UI muze ukazovat data z jineho workspace drive, nez je runtime pro ten workspace pripojeny.

## Hlavni Frontend State

Hlavni store zije v `packages/app/src/app/context/workspace.ts`.

Drzi:

- `workspaces`
- `activeWorkspaceId`
- `projectDir`
- `activeWorkspaceDisplay`
- `activeWorkspacePath`
- `activeWorkspaceRoot`
- `connectingWorkspaceId`
- `workspaceConnectionStateById`

Verejna aktivace jde pres `workspaceStore.activateWorkspace`, ktera je slozena z:

- `workspace-activation-controller.ts`
- `workspace-activation-local.ts`
- `workspace-activation-remote.ts`
- `workspace-runtime-controller.ts`

Aktivace ma guard proti prekryvajicim se switchum (`createWorkspaceActivateGuard`). Novejsi aktivace muze supersednout starsi, takze nektere mezivysledky jsou zamerne ignorovane.

## Local Workspace Activation

Local aktivace dela nekolik veci v poradi:

1. Nastavi startup preference na local.
2. Porovna predchozi root, `projectDir`, aktivni root a skutecny engine dir.
3. Pokud se scope zmenil, vycisti displayed session state.
4. Hned v UI nastavi `activeWorkspaceId` a `projectDir`.
5. V Tauri nacte `.opencode/veslo.json`.
6. Persistuje active workspace pres `workspaceSetActive`.
7. Podle situace bud jen prejde do browse mode, nebo restartuje/reattachne runtime.

Dulezite: pri local-to-local browse modu muze workspace vypadat jako aktivni, ale engine zustava detached. Sidebar/session history se nacte ze SQLite a engine se pripojuje az pozdeji, typicky pri sendu.

## Remote Workspace Activation

Remote aktivace:

- nastavuje startup preference na server
- pro Veslo remote resolvuje host a workspace
- pro direct remote pouziva ulozeny base URL/directory
- vola `connectToServer`
- pro Veslo remote muze provisionovat workspace system
- persistuje remote metadata pres Tauri `workspaceUpdateRemote`
- nakonec persistuje active selection pres `workspaceSetActive`

Remote aktivace ma dva typy:

- Veslo remote (`remoteType: "veslo"`)
- direct OpenCode remote (`remoteType: "opencode"`)

## Tauri Persistent State

Desktop source pro lokalni seznam workspaces je `packages/desktop/src-tauri/src/workspace/state.rs` a command surface v `packages/desktop/src-tauri/src/commands/workspace.rs`.

Tauri zapisuje `active_id` do workspace state souboru.

Mista, ktera meni active id:

- `workspace_bootstrap`: nacte persisted active id, pripadne migruje nebo opravi invalidni active id na prvni workspace.
- `workspace_set_active`: explicitni prepnuti active id, volitelne promuje workspace na zacatek listu.
- `workspace_create`: vytvori local workspace a nastavi ho jako active.
- `workspace_create_remote`: vytvori remote workspace a nastavi ho jako active.
- `workspace_import_config`: importovany workspace nastavi jako active.
- `workspace_forget`: pokud se zapomina aktivni workspace, active id se prepne na prvni zbyvajici workspace nebo prazdny string.

Necekany detail: `ensureWorkspaceForFolder` ve frontendu muze pri vytvoreni noveho workspace neprimo nastavit active id uz pres Tauri create command, jeste pred plnou runtime aktivaci.

## Veslo Server Active Model

Veslo server nema stejny model jako frontend signal. V serveru je active workspace typicky prvni workspace v `config.workspaces`.

Relevantni route:

- `GET /workspaces`: vraci `activeId` jako id prvniho workspace.
- `POST /workspaces/local`: novy workspace prepende do `config.workspaces`, cimz se stane active.
- `POST /workspaces/:id/activate`: presune workspace na prvni misto, provisionuje interni system, zapise audit event `workspace.activate`.
- `DELETE /workspaces/:id`: po smazani vraci active id jako prvni zbyvajici workspace.
- `GET /w/:id/workspaces`: workspace-scoped view vraci jen dany workspace a active id nastavuje na nej.

Dulezite: server `/workspaces/:id/activate` neznaci jen UI switch. Dela i provisioning a audit. Frontend na nej sahne neprimo pres `activateVesloHostWorkspace`, aby local Veslo server registry odpovidala aktivnimu local workspace.

## Orchestrator Active Model

Orchestrator ma vlastni router state s `activeId`.

Relevantni routes/CLI:

- `GET /workspaces`: vraci `activeId` a workspaces.
- `POST /workspaces`: zaregistruje local workspace, ale active id meni jen pokud zadne active neni nebo pokud migruje legacy id.
- `POST /workspaces/remote`: zaregistruje remote workspace, active id meni jen pokud zadne active neni.
- `POST /workspaces/:id/activate`: nastavi `state.activeId`, ulozi state a pro local workspace synchronne zajisti engine.
- CLI `workspace switch` vola `POST /workspaces/:id/activate`.

Nejdulezitejsi runtime detail: `/workspace/:id/opencode/*` routuje podle explicitniho workspace id v URL, ne podle globalniho `activeId`. GET/HEAD engine nespawnuji a mohou vratit `503 engine_not_running`; non-GET requesty mohou engine spawnout pres proxy ensure.

## Runtime Lifecycle

Frontend local runtime lifecycle (`packages/app/src/app/utils/local-runtime-lifecycle.ts`) dela pri local switchi:

- orchestrator workspace activation
- Veslo host workspace activation
- `engineInfo` read pro konkretni workspace
- connect do routed clienta bud normalne, nebo quiet mode

Pro `veslo-orchestrator` runtime aktivace znamena:

1. `orchestrator_workspace_activate`
2. `activateVesloHostWorkspace`
3. `engineInfo(workspaceId, workspacePath)`
4. routing/connect client

Pro non-orchestrator runtime se dela stop/start engine.

## Sidebar A Session UI

Jsou dve relevantni plochy:

- `components/session/workspace-session-list.tsx`
- starsi/alternativni `components/session/sidebar.tsx`

V `workspace-session-list.tsx`:

- klik na project header vola `onActivateWorkspace(workspaceId, { origin: "workspace-session-list:project-open" })`
- project plus a nektere pending draft flow jdou pres pending draft controller a mohou workspace aktivovat
- workspace menu recover/test/edit nema vzdy stejny efekt:
  - recover aktivniho remote workspace muze aktivovat
  - test connection jen testuje connection state bez prepnuti active workspace
  - edit connection nemusi aktivovat

V `app.tsx` je wrapper `handleActivateWorkspace`, ktery pri project-open z jineho workspace a soucasne `/session/:id` route nejdriv naviguje na `/session`, aby nezustala session route z predchoziho workspace.

## Session Navigation: Browse Versus Runtime Switch

`packages/app/src/app/pages/session-navigation.ts` definuje helpery:

- `openSessionWithWorkspaceActivation`
- `createSessionWithWorkspaceActivation`
- `openPendingDraftWithWorkspaceActivation`
- `createSessionFromDirectorySelection`
- `openPendingDraftFromDirectorySelection`

Dulezity detail: `openSessionWithWorkspaceActivation` aktivuje workspace jen pokud `activateWorkspaceBeforeOpen` je true. Jinak jen otevira session a zachovava browse scope.

To znamena:

- otevreni existujici session muze byt browse-only
- vytvoreni session v jinem workspace aktivuje workspace
- otevreni pending draft v jinem workspace aktivuje workspace
- folder picker si snapshotuje active workspace pred `ensureWorkspaceForFolder`, protoze samotne zajisteni folderu muze vytvorenim workspace zmenit active id

## Send / Retry / Replace Path

Send path je jedno z nejdulezitejsich neprimych mist.

`workspace-send-target.ts`:

- resi target workspace podle pending draftu nebo selected session scope
- `ensureSelectedSessionWorkspaceActiveForSend` aktivuje target workspace, pokud selected session patri do jineho workspace nez aktualni active workspace

`app.tsx` send flow:

- pred odeslanim zjisti send target workspace
- pokud existuje scoped session id, vola `ensureSelectedSessionWorkspaceActiveForSend`
- pokud engine neni ready, vola `workspaceStore.ensureEngineForWorkspace(targetWorkspaceId)`
- az potom bere routed client pro target workspace

Stejne schema pouziva `replaceUserMessage`.

Prakticky dopad: uzivatel muze browsovat session z jineho workspace bez runtime switchu, ale jakmile v ni posle zpravu nebo nahradi zpravu, workspace se aktivuje a engine se rozjede/pripoji pro target workspace.

## Composer Target Switch

`composer-target-controller.ts` umi aktivovat workspace pri:

- prepnuti composer targetu na workspace
- prepnuti composer targetu na chat/private pending draft z jineho workspace
- vytvoreni noveho private scratch workspace

Pri vytvoreni private workspace se vola create scratch workspace, coz samo nastavuje active id, a pak jeste explicitni `activateWorkspace`.

## Pending Draft Flows

`pending-session-draft-controller.ts` aktivuje workspace pri:

- otevreni existujiciho private pending draftu
- vytvoreni noveho private scratch workspace
- otevreni pending directory draftu v danem workspace
- folder picker flow pres `openDirectorySessionFromPicker`

U directory pending draftu existuje zajimavy rozdil:

- samotne `openDirectoryPendingDraft({ workspaceId, directory })` jen vytvori/otevre draft a nastavi view
- wrapper `openPendingDirectoryDraftInWorkspace` nejdriv aktivuje workspace, pokud neni aktivni

## Create / Import / Forget

`workspace-local-workspaces.ts`:

- `createWorkspaceFlow` vytvori workspace pres Tauri, cimz se stane active, pak vola `activateFreshLocalWorkspace`
- `createScratchWorkspace` dela to same pro private workspace
- `ensureWorkspaceForFolder` u existujiciho workspace pouze posune polozku v UI listu dopredu, u noveho workspace vytvari a tim meni active id
- `ensureLocalWorkspaceActive` explicitne aktivuje workspace a pripadne startuje host
- `forgetWorkspace` po Tauri forget synchronizuje active id a pokud se active workspace zmenil, aktivuje novy active workspace

## Remote Store Recover

`remote-store.ts`:

- `recoverWorkspace(id)` pokud id odpovida active workspace, vola `activateWorkspace(id, { origin: "remote-store:recover-active-workspace" })`
- pokud id neni active, vola jen `testWorkspaceConnection(id)`

To je dalsi rozdil mezi "recover" jako runtime reconnect pro aktivni workspace a "test" pro neaktivni workspace.

## Reload Workspace Engine

V `app.tsx` remote reload flow:

- pro local vola `workspaceStore.reloadWorkspaceEngine()`
- pro remote Veslo workspace vola `client.reloadEngine(workspaceId)`
- po remote reloadu vola `workspaceStore.activateWorkspace(activeWorkspaceId, { origin: "app:reload-workspace-engine" })`
- pote refreshuje MCP

To znamena, ze i reload muze reaktivovat aktualni workspace a obnovit connection state.

## Dashboard / Session Deep Links Do Workspace Actions

Props z `app.tsx` predavaji `activateWorkspace` do dashboard a session view.

Nalezena pouziti:

- dashboard open Soul workspace aktivuje workspace pred otevrenim Soul nastaveni
- session open Soul workspace dela podobne
- dashboard/session workspace list pouziva stejny `handleActivateWorkspace`

## Workspace Server Registry Reconciliation

`workspace-server-registry.ts` drzi local Veslo server registry v souladu s frontend/Tauri workspaces.

Relevantni chovani:

- `reconcileVesloServerWorkspaces` doplnuje chybejici local workspaces do serveru
- `activateVesloHostWorkspace(workspacePath)` najde workspace na serveru podle path, pripadne ho prida, a pokud neni active, vola server `activateWorkspace`

Toto neni primarne UI switch, ale meni Veslo server active workspace order a zapisuje server audit.

## Mista, Ktera Vypadaji Jako Switch, Ale Nejsou Plny Switch

- Klik na existujici session muze jen nastavit selected session a browse scope.
- `testWorkspaceConnection` meni connection state, ale nemusi aktivovat workspace.
- Workspace-scoped server/orchestrator routes podle `/workspace/:id/...` obchazeji globalni active workspace.
- Sidebar fallback project open a pending draft open maji odlisne cesty, i kdyz UX vypada podobne.
- `ensureWorkspaceForFolder` u existujiciho workspace meni poradi v UI listu, ale nevola Tauri `workspaceSetActive`.

## Rizika A Slaba Mista

1. Vice active pravd

Frontend, Tauri, Veslo server a orchestrator mohou byt docasne mimo sync. Nektere cesty je synchronizuji best-effort a chyby ignoruji.

2. Browse-only stav

UI muze ukazovat workspace/session jako aktivni z pohledu prohlizeni, ale runtime client jeste nemusi existovat. Send path to opravuje pozde.

3. Create side effects

Vytvoreni/import workspace meni active id uz v Tauri commandu. Volajici to casto kompenzuji snapshotem stareho active id nebo naslednou plnou aktivaci.

4. Server active model je order-based

Server active id je `workspaces[0]`. To muze byt neintuitivni pri debugovani, protoze aktivace je fyzicky reorder listu.

5. Explicitni workspace routes maskuji active mismatch

Orchestrator/server requesty s explicitnim workspace id mohou fungovat i tehdy, kdy globalni active id ukazuje jinam.

6. Recover/test/edit nejsou semanticky stejne

Remote workspace menu akce mohou bud aktivovat, jen testovat, nebo jen otevrit edit modal podle kontextu.

7. Ignorovane chyby pri best-effort syncu

Nektere Tauri/server registry update chyby jsou zamerne ignorovane. To snizuje UX hluk, ale muze schovat active mismatch mezi vrstvami.

## Prakticky Mental Model

Pro debug workspace switchu je potreba oddelit tyto otazky:

1. Ktery workspace je aktivni ve frontend signalu?
2. Ktery workspace je persisted active v Tauri state?
3. Ktery workspace je prvni v Veslo server workspace listu?
4. Ktery workspace ma orchestrator `activeId`?
5. Existuje routed client pro dany workspace?
6. Bezi per-workspace engine, nebo je workspace jen v browse mode?
7. Je zobrazena session skutecne z active workspace, nebo jen browse scope z jineho workspace?

Bez toho se ruzne chovani muze jevit jako bug, i kdyz cast je zamerna lazy/browse architektura.
