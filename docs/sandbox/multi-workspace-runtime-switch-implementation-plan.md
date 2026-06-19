# Multi-workspace runtime switch implementation plan

Datum: 2026-06-18

## Verdikt

Plan je skalovatelny a udrzitelny jen pokud se implementuje jako dotazeni existujiciho refaktoru, ne jako nova paralelni architektura.

Spravna hranice zustava:

> UI workspace browse state nesmi vlastnit engine lifecycle.

Ale v projektu uz existuji moduly, ktere cast teto hranice pokryvaji. Cilem tedy neni pridat druhy `RuntimeRegistry`, druhy lifecycle reducer nebo novou routing vrstvu. Cilem je dotahnout soucasne moduly tak, aby se jejich kontrakt dodrzoval vsude.

## Terminologie

Nepouzivat `sandbox` jako synonymum pro engine pool.

- `sandbox`: bezpecnostni/pathing backend, dnes hlavne Windows WSL2 + bwrap.
- `orchestrator-pool`: Veslo runtime, ktery umi per-workspace engine pool a ma zachovat ostatni workspaces bez stop/restartu.
- `direct-host`: legacy/single-host runtime. Dnes umi nahradit proces pro jinou directory; cilovy stav je shared engine s directory-scoped OpenCode/Veslo API. Dokud to neni hotove, direct-host nesmi predstirat plny multi-engine model.
- `remote-veslo`: remote Veslo workspace.
- `remote-direct`: remote OpenCode workspace.
- `browse`: pasivni UI prohlizeni workspace/session title rows bez runtime attach/spawn.
- `runtime ensure`: explicitni akce, ktera smi nastartovat nebo pripojit runtime. Typicky send.

## Existujici moduly, na ktere se napojujeme

| Cilovy pojem | Existujici modul | Co dodelat |
|---|---|---|
| Runtime route/client per workspace | `packages/app/src/app/context/workspace-routing.ts` | Pouzit jako jedinou registry klientu. Zprisnit implicit active-client strict gate proti spawnum v browse mode. |
| Lifecycle state | `packages/app/src/app/context/workspace-lifecycle-state.ts` | Napojit realne activation/runtime eventy. Nezavadet druhy reducer. |
| Activation orchestrace | `packages/app/src/app/context/workspace-activation-controller.ts` | Rozlisit passive browse origin vs blocking activation. Overlay suppression nahradit explicitnim browse kontraktem. |
| Local browse/restart vetve | `packages/app/src/app/context/workspace-activation-local.ts` | Oddelit title-only browse od runtime restartu a transcript hydration. |
| Runtime start/attach | `packages/app/src/app/context/workspace-runtime-controller.ts` + `packages/app/src/app/utils/local-runtime-lifecycle.ts` | Orchestrator-pool nesmi shazovat jine engines. Direct-host potrebuje shared/directory-scoped cestu pred plnym multi-workspace slibem. |
| Sidebar historie | `packages/app/src/app/context/sidebar-workspace-sessions.ts` | Host DB title-first pro vsechny workspaces, transcript az pri explicitnim open conversation. |
| Spawn/network audit | `packages/app/src/app/lib/startup-request-audit.ts` | Pouzit jako runtime audit entry points, ne jako oddelenou iniciativu. |
| E2E kontrakty | `packages/e2e/specs/browse-no-engine-spawn.spec.ts`, `boot-freeze.spec.ts`, `pnpm-dev-3-clicks.spec.ts` | Rozsirit misto vytvareni duplicitnich specu. |

## Produktove invarianty

1. Klik na workspace v sidebaru je browse operace, ne engine lifecycle operace.
2. Passive browse nikdy nespawnuje engine, nestopuje engine a nerestartuje runtime.
3. Passive browse nikdy neotevira fullscreen preloader.
4. Fullscreen preloader zustava jen pro cold boot bez pouzitelneho shellu nebo explicitni blocking user akci.
5. Sidebar nacita title-only rows pro vsechny dostupne workspaces z host-side persistence.
6. Transcript se nacita az pri explicitnim open conversation.
7. Send target je explicitni workspace scope. Send smi volat runtime ensure jen pro target workspace.
8. Orchestrator-pool zachovava ostatni workspaces pri switchi i pri ensure pro target.
9. Direct-host nesmi shazovat engine pri browse. Pro send do jine workspace musi bud pouzit shared/directory-scoped route, nebo byt explicitne oznacen jako legacy omezeni.
10. Remote workspaces musi mit jasny browse stav: remote history jen kdyz je dostupny remote host/source; jinak view-only/unavailable row, ne implicitni local runtime attach.
11. Cross-device nebo missing backing workspace conversation je view-only, dokud neni dostupny workspace runtime/source.
12. `engineReady` zustava strict spawn guard, dokud neni plne nahrazen workspace-scoped lifecycle/routing derivaci.

## Nejrizikovejsi sekvence: engineReady

Tady se plan nesmi rozjet do dvou protichudnych smeru.

Spravne poradi:

1. Nejdriv zprisnit `engineReady` jako guard proti implicit SDK callum v browse mode.
2. Projit vsechny spawn entry points a rozdelit je na:
   - allowed spawn: send/runtime ensure,
   - never spawn: browse/open transcript/title list/settings passive refresh,
   - conditional: cached/preflight flows.
3. Az potom prevest `engineReady` z globalniho signalu na compatibility derivaci z `workspace-lifecycle-state` + `workspace-routing.entry(workspaceId)` + runtime snapshotu.

Nespravne poradi by bylo nejdriv demotovat `engineReady` na volny derived getter a teprve potom se snazit zpetne zavest strict gate. To by otevřelo dalsi implicit spawny.

## Non-spawning browse path

`browseWorkspace` nesmi byt jen wrapper nad dnesnim `activateWorkspace`.

Dnesni `activateWorkspace` ma stale side-effecty:

- nastavuje `connectingWorkspaceId`,
- muze nastavit `engineReady(false)`,
- cisti aktualni session state,
- vola Tauri `workspaceSetActive`,
- vola Veslo server workspace activation/provisioning pres `activateVesloHostWorkspace`,
- v nekterych vetvich vola runtime lifecycle attach/restart,
- drive volal `hydrateLatestSessionFromDb`.

Novy browse path musi vzit jen harmless casti:

- active browse workspace id,
- project directory/context,
- workspace config read,
- local Tauri active marker jen pokud zustane state-only,
- host DB title rows.

Passive browse nesmi volat:

- `orchestratorWorkspaceActivate`,
- orchestrator `POST /workspaces/:id/activate`,
- Veslo server `POST /workspaces/:id/activate`,
- `activateVesloHostWorkspace`,
- `restartWorkspaceRuntime`,
- `ensureEngineForWorkspace`,
- `workspaceRouting.ensure`,
- `hydrateLatestSessionFromDb`.

Pokud server potrebuje znat browsed workspace, musi vzniknout non-spawning cesta typu register/mark-browse/reconcile. Ta nesmi provisionovat runtime artifacts, nespousti engine a nesmi cekat na health.

## Implementacni faze

### Faze 0: Zafixovat plan proti realite kodu

Hotovo timto dokumentem:

- plan je diff proti existujicim modulům,
- `sandbox` neni engine pool,
- remote/view-only jsou soucast DoD,
- idle/suspend neni odlozeny detail, ale soucast skalovatelnosti.

### Faze 1: Audit engine-spawn entry points

Vychazi z `docs/sandbox/handoff.md` priority 1a a z rozdelaneho `startup-request-audit`.

Postup:

1. Najit vsechny app SDK/runtime vstupy:
   - `c.session.`
   - `c.global.`
   - `workspaceRouting.ensure`
   - `ensureEngineForWorkspace`
   - direct OpenCode/Veslo proxy calls, ktere mohou sahnout na engine.
2. U kazdeho callsite zapsat kategorii:
   - `allowed-spawn`
   - `never-spawn`
   - `conditional`
3. Pro `never-spawn` zavest host DB/offline path nebo explicitni no-op v browse mode.
4. Pro implicit `workspaceRouting.client()` zavest strict gate proti browse spawnum.

Verification:

- rozsireny `browse-no-engine-spawn.spec.ts`,
- startup audit summary bez necekanych runtime proxy callu po bootu a po workspace clicku.

### Faze 2: Dotahnout local passive browse

Navazuje na `workspace-activation-controller.ts` a `workspace-activation-local.ts`.

Zmeny:

- pridat skutecny `browseWorkspace` path; neprejmenovat dnesni `activateWorkspace`,
- passive browse musi obejit blocking activation controller a jeho `connectingWorkspaceId`,
- passive browse origins maji byt explicitni kontrakt, ne jen overlay suppression hack,
- `workspace-session-list:project-open` a historical session browse nesmi volat restart path,
- passive browse nesmi volat Veslo server ani orchestrator `/activate`,
- browse path nesmi volat `hydrateLatestSessionFromDb`,
- lazy boot nacita title-only sidebar rows, ne transcript,
- pokud target workspace uz ma ready orchestrator route/runtime, switch nesmi prepnout app shell do global `engineReady(false)`,
- lifecycle reducer dostane `browse-ready` event.

Verification:

- failing/source test: passive browse nevola server/orchestrator activate,
- source/unit kontrakty pro no latest transcript hydration v browse,
- E2E: active A -> active B, accordion zustava klikatelny, zadny fullscreen overlay, engine A zustava bez stopu.

### Faze 3: Preloader zmenit na explicitni blocking overlay

Soucasny problem je, ze overlay odvozuje otevreni z pretezeneho `connectingWorkspaceId`.

Zmeny:

- zavest explicitni `blockingOverlayReason`,
- `connectingWorkspaceId` nepouzivat jako obecny duvod fullscreen overlaye,
- passive browse nikdy nenastavuje blocking overlay reason,
- runtime warmup se ukazuje inline: sidebar row, composer, session header, toast/error.

Nechat fullscreen overlay jen pro:

- cold boot bez shellu,
- explicitni blocking remote connect, kdy neni co zobrazit,
- explicitni user reload/repair akci,
- unrecoverable blocking state.

### Faze 4: Sidebar title-first pro vsechny workspaces

Zmeny:

- na startupu nacist title rows pro vsechny local workspaces z host DB,
- accordion state nesmi byt prepisovan runtime warmupem,
- live session sync nesmi docasne nahradit host title list seznamem "jen jedna nova conversation",
- transcript cache zustava lazy a bounded,
- remote workspace row umi `unavailable` / `view-only`, pokud remote source neni dostupny.

Verification:

- bootstrap: sidebar ukaze workspace + title rows bez engine,
- workspace click: title rows zustanou stabilni,
- open conversation: transcript se nacte az tady,
- remote unavailable: UI nezacne local runtime attach.

### Faze 5: Runtime ensure jen pro explicitni target

Zmeny:

- `ensureEngineForWorkspace(workspaceId)` je jediny standardni entry point pro local runtime spawn,
- send path vzdy posila explicitni target workspace,
- explicit `workspaceRouting.client(workspaceId)` zustava pouzitelny pro background scoped flows,
- implicit active client je guarded a v browse mode vraci `null` nebo controlled error podle caller kontraktu.

Orchestrator-pool:

- ensure target B attachne/startne B,
- A zustava bez stop/restart,
- busy state pro A zustava viditelny.

Direct-host:

- browse nikdy nesaha na proces,
- plny multi-workspace send vyzaduje shared engine + directory-scoped API,
- dokud to neni hotove, direct-host musi mit explicitni legacy limitation a nesmi tise zabit aktivni run jine workspace.

### Faze 6: Idle/suspend policy jako soucast skalovani

Pokud myslime 10+ workspaces, nelze "per-workspace engines" brat jako neomezene bez policy.

Minimalni kontrakt:

- max engines je explicitni preference/policy,
- idle suspend je workspace-scoped,
- aktivni run nikdy nesmi byt suspendovan,
- suspended workspace zustava title-browsable,
- resume jde pres explicitni ensure target workspace.

Toto je podminka udrzitelnosti orchestrator-pool modelu.

### Faze 7: Remote a cross-device semantics

Remote browse nema stejny zdroj dat jako local host DB.

Kontrakt:

- remote-veslo muze cist title rows pres remote Veslo source, pokud je host dostupny,
- remote-direct muze byt browsable jen pokud existuje dostupny remote OpenCode/source API,
- pokud backing workspace neni dostupny, conversation row je view-only/unavailable,
- open transcript v unavailable state nesmi spustit local runtime,
- send je disabled nebo vyzaduje explicitni reconnect/source availability.

### Faze 8: Verification

Preferovat existujici E2E:

- `browse-no-engine-spawn.spec.ts`
- `boot-freeze.spec.ts`
- `pnpm-dev-3-clicks.spec.ts`

Rozsireni:

- active A -> active B bez overlaye,
- active A run zustane viditelny po browse do B,
- B title rows jsou videt pred runtime ensure,
- old conversation open pokracuje ve stejne conversation,
- remote unavailable/view-only nevytvori local runtime call,
- direct-host legacy mode neprovadi tichy destructive switch.

Unit/source testy pouzit jen tam, kde E2E neni spolehlive nebo kde hlidaji cisty helper/kontrakt.

## Definition of done

Hotovo bude, kdyz plati:

- app boot je browsable bez engine spawnu,
- workspace click je do 1 s a bez fullscreen preloaderu,
- browse do aktivni B nesrazi global runtime readiness, pokud B uz ma ready route/runtime,
- engine A se pri browse do B nezastavi ani nerestartuje,
- sidebar title rows zustavaji stabilni a nepreblikavaji mezi "jedna nova" a "vsechny",
- transcript se netaha pri startupu ani pri pouhem workspace browse,
- send do stare conversation pokracuje ve stejne conversation a targetuje spravne workspace,
- orchestrator-pool drzi per-workspace runtime bez destrukce ostatnich workspaces,
- direct-host ma bud shared/directory-scoped multi-workspace route, nebo explicitni legacy guard,
- remote a cross-device rows maji korektni view-only/unavailable chovani,
- `browse-no-engine-spawn`, `boot-freeze` a `pnpm-dev-3-clicks` prochazi v realnem Tauri runtime.

## Prvni kodove kroky po tomto planu

1. Pridat failing/source testy pro passive browse:
   - nevola server/orchestrator activate,
   - nevola runtime restart/ensure,
   - nehydratuje transcript,
   - neotevira fullscreen overlay,
   - nedemotuje ready target runtime pres global `engineReady(false)`.
2. Dodelat rozdelany passive-browse patch jen jako mezikrok:
   - skip Veslo host activation/provisioningu pri passive browse,
   - no latest transcript hydration v browse/lazy boot,
   - no global `engineReady(false)` pri switchi do ready target workspace.
3. Vyvest skutecny `browseWorkspace` mimo dnesni `activateWorkspace`.
4. Navazat na `startup-request-audit` a sepsat spawn-entry matrix.
5. Zprisnit implicit runtime call guard v `workspace-routing` / session callsites.
6. Az potom sahat na overlay policy.

## Implementation status

Stav k 2026-06-18:

- Hotovo: dedicated `browseWorkspace` metoda ve workspace store pro local passive browse origins.
- Hotovo: app-level `handleActivateWorkspace` routuje passive origins nejdriv pres `browseWorkspace`; nepasivni flows zustavaji na `activateWorkspace`.
- Hotovo: app-level browse policy pro local passive browse uz nema fallback `browseWorkspace -> activateWorkspace`; kdyz local browse selze, vrati `false` a nikdy tim nespusti runtime activation path.
- Hotovo: passive browse nevola `activateVesloHostWorkspace`, `orchestratorWorkspaceActivate`, runtime ensure/restart ani transcript hydration.
- Hotovo: lazy boot zustava title-only a preskakuje Veslo host activation/provisioning.
- Hotovo: browse do workspace s ready route/runtime zachova target readiness misto slepeho global `engineReady(false)`.
- Hotovo: source kontrakty hlidaji non-spawning/title-only browse path.
- Hotovo: `workspace-lifecycle-state` je napojeny na realne app eventy:
  - blocking activation publikuje `activation-started` a versioned `connected`/`failed`,
  - passive browse publikuje `browse-ready`,
  - explicitni `ensureEngineForWorkspace` publikuje `runtime-starting`, `connected` a `failed`.
- Hotovo: reducer ignoruje pozdni superseded eventy i pri opakovane aktivaci stejne workspace.
- Hotovo: fullscreen overlay uz necita `connectingWorkspaceId` jako trigger; blocking activation nastavuje verzovany explicitni overlay target, passive browse ho nenastavuje.
- Hotovo: fullscreen overlay se neotevira jen kvuli globalnim `status.starting_engine` / `status.restarting_engine`; runtime warmup bez explicitniho blocking targetu zustava mimo fullscreen preloader.
- Hotovo: local activation defaultne nezapina blocking overlay; explicitni `blockingOverlay: true` je nutny pro local blocking flow typu app reload.
- Hotovo: pending draft, composer target a send target cesty pouzivaji sdileny app-level browse-policy wrapper misto raw `workspaceStore.activateWorkspace`.
- Hotovo: app shell ma jeden `RuntimeOwner` bottleneck pro runtime readiness/client rozhodnuti; odvozuje `isWorkspaceRuntimeReady(workspaceId)`, active/any readiness, conversation-read sync readiness a routed client access z orchestrator ready snapshotu, routing entry, aktivniho legacy `engineReady` fallbacku a workspace busy mapy.
- Hotovo: session store, extension/skill store, system-state reload flow a `WorkspaceRoutingProvider` dostavaji owner-gated routing wrapper. Lifecycle mutace (`ensure`, `release`, engine start/stop) zustavaji ve workspace/runtime controllerech.
- Hotovo: `sessionStore` pouziva workspace-scoped readiness pro conversation-read sync, `selectSession`, SSE targety a pending permission/question refresh.
- Hotovo: send path ensureuje runtime podle cilove workspace (`sendTargetWorkspace`) misto globalniho `engineReady`.
- Hotovo: sidebar live sync, permission polling a MCP auto/runtime status refresh jsou napojene na active/any workspace readiness helpery misto raw `engineReady()`.
- Hotovo: MCP runtime status refresh single-flight je oddeleny podle workspace, directory i aktualniho MCP entries key; zmena MCP seznamu behem stareho `mcp.status()` requestu spusti novy status read a stare vysledky/status chyby uz neprepisou aktualni UI.
- Hotovo: sidebar a runtime schedulery uz nemaji option kontrakt pojmenovany `engineReady`; kontrakt explicitne rozlisuje `activeWorkspaceRuntimeReady` a `anyWorkspaceRuntimeReady`.
- Hotovo: source/unit kontrakty hlidaji, ze fullscreen overlay je napojeny na explicitni blocking workspace id, ne na `connectingWorkspaceId`.
- Hotovo: `browse-no-engine-spawn.spec.ts` rozsiruje budouci runtime E2E o kontrolu, ze passive workspace clicks nechavaji shell klikatelny a neukazuji blocking overlay.

Zbyva:

- Runtime overeni v realne Tauri appce: active A -> active B bez overlaye, bez engine stopu a s viditelnou aktivni konverzaci z A.
- Docistit zbyla raw `engineReady` UI/debug mista mimo runtime rozhodovani a rozhodnout, jestli global signal zustane jen kompatibilitni active-workspace fallback.
- Doresit direct-host/non-sandbox multi-workspace model: shared/directory-scoped runtime nebo explicitni legacy omezeni.
- Doresit remote/cross-device view-only/unavailable semantics.
