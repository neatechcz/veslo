# OpenCode Workspace Runtime Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Zavést OpenCode 1.16.2 a novou běhovou cestu zpráv tak, aby Veslo spolehlivě spouštělo více souběžných konverzací v různých pracovních prostorech s pískovištěm i bez něj.

**Architecture:** Uživatelské rozhraní posílá pouze záměr k odeslání. Veslo server vlastní konverzaci, běh, vazbu na relaci OpenCode a pracovní adresář. Orchestrátor vlastní prováděcí režim: sdílený OpenCode proces bez pískoviště, nebo izolovaný pracovní proces z větve `origin/local/sandbox-merge`.

**Tech Stack:** Tauri desktop, SolidJS, Bun/TypeScript Veslo server, Bun/TypeScript orchestrátor, OpenCode 1.16.2, `@opencode-ai/sdk` 1.16.2, `tauri-pilot`.

---

## Zásady Pro Implementaci

- Pracuj v čistém pracovním stromu založeném na `origin/local/sandbox-merge`, případně nejdřív tuto větev začleň do implementační větve. Nepoužívej starší `origin/sandbox`.
- Neověřuj desktopové chování přes webový vývojový server. Finální ověření musí běžet přes Tauri a `tauri-pilot`.
- Při změnách v `packages/server/src` vždy po testech spusť `pnpm --filter veslo-server build:bin`.
- Každý úkol dokonči malým commitem.
- Při řešení konfliktů zachovej existující rozpracované změny uživatele. Nic nesouvisejícího nerevertuj.

## Task 1: Připravit Implementační Větev A Převzít Sandbox Základ

**Files:**
- Read: `docs/plans/2026-06-07-opencode-workspace-runtime-design.md`
- Read: `docs/dev/testing-playbook.md`
- Read: `docs/dev/development-startup.md`
- Base branch: `origin/local/sandbox-merge`

**Step 1: Vytvoř čistý pracovní strom**

Run:

```bash
git fetch origin
git worktree add ../Veslo-opencode-runtime -b codex/opencode-workspace-runtime origin/local/sandbox-merge
cd ../Veslo-opencode-runtime
```

Expected: nový pracovní strom na `codex/opencode-workspace-runtime`.

**Step 2: Přenes schválené plánovací dokumenty, pokud ve větvi chybí**

Run:

```bash
git checkout dev_vaclav -- \
  docs/plans/2026-06-07-opencode-workspace-runtime-design.md \
  docs/plans/2026-06-07-opencode-workspace-runtime-implementation-plan.md
```

Expected: návrhový i prováděcí dokument jsou přítomné. Pokud ve větvi už jsou,
tento krok přeskoč.

**Step 3: Ověř, že pracuješ nad novějším sandbox základem**

Run:

```bash
git log --oneline --decorate -10
test -f packages/orchestrator/src/engine-pool.ts
test -f packages/orchestrator/src/sandbox/index.ts
test -f packages/server/src/conversation-service.ts
test -f packages/server/src/server-conversations.test.ts
```

Expected: všechny soubory existují. Pokud některý chybí, nejdřív začleň `origin/local/sandbox-merge`.

**Step 4: Commit pouze pokud bylo potřeba přenášet dokumenty**

Run:

```bash
git status --short
git add docs/plans/2026-06-07-opencode-workspace-runtime-design.md docs/plans/2026-06-07-opencode-workspace-runtime-implementation-plan.md
git commit -m "docs: add opencode workspace runtime plans"
```

Expected: commit vznikne jen při skutečných změnách dokumentace.

## Task 2: Upgradovat OpenCode A SDK Na 1.16.2

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `packages/orchestrator/package.json`
- Modify: `packages/app/package.json`
- Modify: `packages/opencode-router/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `packages/orchestrator/src/opencode-version.test.ts`
- Modify: `packages/app/scripts/session-directory-switch.mjs`
- Modify: `packages/desktop/src-tauri/sidecars/versions.json`

**Step 1: Napiš test, který zafixuje očekávané verze**

Do `packages/orchestrator/src/opencode-version.test.ts` přidej test, který načte `packages/desktop/package.json` a `packages/orchestrator/package.json` a ověří `opencodeVersion === "1.16.2"`.

Příklad testu:

```ts
test("desktop and orchestrator pin OpenCode 1.16.2", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const root = resolve(import.meta.dir, "../../..");
  const desktop = JSON.parse(await readFile(resolve(root, "packages/desktop/package.json"), "utf8"));
  const orchestrator = JSON.parse(await readFile(resolve(root, "packages/orchestrator/package.json"), "utf8"));

  expect(desktop.opencodeVersion).toBe("1.16.2");
  expect(orchestrator.opencodeVersion).toBe("1.16.2");
});
```

**Step 2: Spusť test a ověř, že selže**

Run:

```bash
pnpm --filter veslo-orchestrator exec bun test src/opencode-version.test.ts
```

Expected: FAIL, protože balíčky zatím ukazují starší OpenCode.

**Step 3: Změň verze**

Nastav:

- `packages/desktop/package.json`: `opencodeVersion` na `1.16.2`
- `packages/orchestrator/package.json`: `opencodeVersion` na `1.16.2`
- `packages/app/package.json`: `@opencode-ai/sdk` na `1.16.2`
- `packages/orchestrator/package.json`: `@opencode-ai/sdk` na `1.16.2`
- `packages/opencode-router/package.json`: `@opencode-ai/sdk` na `1.16.2`

Run:

```bash
pnpm install --lockfile-only
```

Expected: `pnpm-lock.yaml` obsahuje `@opencode-ai/sdk@1.16.2`.

**Step 4: Aktualizuj sidecar manifest**

Run:

```bash
VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar
```

Expected: sidecar manifest ukazuje OpenCode 1.16.2. Pokud příkaz stáhne binárku, ověř, že `packages/desktop/src-tauri/sidecars/versions.json` odpovídá nové verzi.

**Step 5: Uprav ověřovací skript pro nové chování OpenCode**

V `packages/app/scripts/session-directory-switch.mjs` doplň kontrolu, že:

- nová relace v adresáři A běží v A,
- nová relace v adresáři B běží v B,
- akce nad existující relací A zůstává v A i při omylem předaném adresáři B.

**Step 6: Spusť ověření**

Run:

```bash
pnpm --filter veslo-orchestrator exec bun test src/opencode-version.test.ts
pnpm --filter @neatech/veslo-ui test:session-directory-switch
```

Expected: PASS.

**Step 7: Commit**

Run:

```bash
git add packages/desktop/package.json packages/orchestrator/package.json packages/app/package.json packages/opencode-router/package.json pnpm-lock.yaml packages/orchestrator/src/opencode-version.test.ts packages/app/scripts/session-directory-switch.mjs packages/desktop/src-tauri/sidecars/versions.json
git commit -m "chore: upgrade opencode to 1.16.2"
```

## Task 3: Dokončit Serverovou Hranici Konverzace A Běhu

**Files:**
- Create/Modify: `packages/server/src/conversation-binding-store.ts`
- Create/Modify: `packages/server/src/conversation-read-store.ts`
- Create/Modify: `packages/server/src/conversation-service.ts`
- Create/Modify: `packages/server/src/orchestrator-lifecycle-client.ts`
- Modify: `packages/server/src/server.ts`
- Test: `packages/server/src/conversation-binding-store.test.ts`
- Test: `packages/server/src/conversation-read-store.test.ts`
- Test: `packages/server/src/conversation-service.test.ts`
- Test: `packages/server/src/server-conversations.test.ts`

**Step 1: Rozšiř serverový test o neměnné pravidlo směrování**

Do `packages/server/src/server-conversations.test.ts` přidej test:

- vytvoř pracovní prostor A a B,
- vytvoř konverzaci v A,
- zavolej běh v A s tělem obsahujícím cizí `sessionID`, `directory`, `kind` a libovolné další pole,
- upstream OpenCode smí dostat jen řízené části zprávy,
- `sessionID` a adresář se musí vzít z vazby konverzace, ne z těla požadavku.

Expected assertions:

```ts
expect(receivedBodies[1]?.sessionID).toBeUndefined();
expect(receivedBodies[1]?.directory).toBeUndefined();
expect(receivedRunPaths[0]).toBe(`/session/sess-created/prompt_async?directory=${encodeURIComponent(workspaceRootA)}`);
expect(receivedRunDirectories[0]).toBe(workspaceRootA);
```

**Step 2: Spusť test a ověř, že selže, pokud pravidlo ještě není zapojené**

Run:

```bash
pnpm --filter veslo-server exec bun test src/server-conversations.test.ts
```

Expected: FAIL na chybějícím nebo nedostatečně přísném směrování.

**Step 3: Implementuj nebo převezmi služby ze `sandbox-merge`**

Pokud implementace není přímo založená na `origin/local/sandbox-merge`, převezmi:

- ukládání vazby `workspaceId + directory + conversationId + opencodeSessionId`,
- pasivní čtení konverzací z uložených dat OpenCode,
- založení konverzace přes serverovou službu,
- převod `conversationId` na `opencodeSessionId`,
- odmítnutí adresářů mimo pracovní prostor,
- odmítnutí konverzace z jiného pracovního prostoru,
- registraci běhu v orchestrátoru před odesláním do OpenCode.

**Step 4: Zapoj rozhraní serveru**

V `packages/server/src/server.ts` zkontroluj a doplň:

- `POST /workspace/:id/conversations`
- `GET /workspace/:id/conversations`
- `GET /workspace/:id/sessions/:sessionOrConversationId/transcript`
- `POST /workspace/:id/conversations/:conversationId/runs`
- `POST /workspace/:id/conversations/:conversationId/abort`
- `GET /workspace/:id/conversations/:conversationId/runs/latest`

Všechny mutace musí používat pracovní prostor z cesty a adresář ověřený serverem.

**Step 5: Spusť serverové testy**

Run:

```bash
pnpm --filter veslo-server exec bun test src/conversation-binding-store.test.ts src/conversation-read-store.test.ts src/conversation-service.test.ts src/server-conversations.test.ts
pnpm --filter veslo-server build:bin
```

Expected: PASS a serverová binárka je znovu sestavená.

**Step 6: Commit**

Run:

```bash
git add packages/server/src/conversation-binding-store.ts packages/server/src/conversation-read-store.ts packages/server/src/conversation-service.ts packages/server/src/orchestrator-lifecycle-client.ts packages/server/src/server.ts packages/server/src/conversation-binding-store.test.ts packages/server/src/conversation-read-store.test.ts packages/server/src/conversation-service.test.ts packages/server/src/server-conversations.test.ts packages/server/dist/bin/veslo-server
git commit -m "feat(server): add workspace conversation run boundary"
```

## Task 4: Zobecnit Provádění Pro Režim Bez Pískoviště I S Pískovištěm

**Files:**
- Create: `packages/orchestrator/src/execution-manager.ts`
- Create: `packages/orchestrator/src/execution-manager.test.ts`
- Modify: `packages/orchestrator/src/engine-pool.ts`
- Modify: `packages/orchestrator/src/cli.ts`
- Modify: `packages/orchestrator/src/run-registry.ts`
- Modify: `packages/orchestrator/src/run-store.ts`
- Test: `packages/orchestrator/src/engine-pool.test.ts`
- Test: `packages/orchestrator/src/run-registry.test.ts`

**Step 1: Napiš test výběru prováděcího režimu**

V `packages/orchestrator/src/execution-manager.test.ts` vytvoř testy:

```ts
test("uses one shared OpenCode process when sandbox is disabled", async () => {
  const manager = createExecutionManager({
    sandboxEnabled: false,
    sharedOpenCodeBaseUrl: "http://127.0.0.1:1111",
    workspaceEnginePool: fakePool(),
  });

  const a = await manager.resolveTarget({ workspaceId: "ws-a", directory: "/tmp/a" });
  const b = await manager.resolveTarget({ workspaceId: "ws-b", directory: "/tmp/b" });

  expect(a.baseUrl).toBe("http://127.0.0.1:1111");
  expect(b.baseUrl).toBe("http://127.0.0.1:1111");
  expect(a.directory).toBe("/tmp/a");
  expect(b.directory).toBe("/tmp/b");
});

test("uses workspace engine pool when sandbox is enabled", async () => {
  const pool = fakePool();
  const manager = createExecutionManager({
    sandboxEnabled: true,
    sharedOpenCodeBaseUrl: "http://127.0.0.1:1111",
    workspaceEnginePool: pool,
  });

  await manager.resolveTarget({ workspaceId: "ws-a", directory: "/tmp/a" });

  expect(pool.ensureStartedCalls).toEqual(["ws-a"]);
});
```

**Step 2: Spusť test a ověř, že selže**

Run:

```bash
pnpm --filter veslo-orchestrator exec bun test src/execution-manager.test.ts
```

Expected: FAIL, protože `execution-manager.ts` ještě neexistuje.

**Step 3: Implementuj minimální správce provádění**

Vytvoř `packages/orchestrator/src/execution-manager.ts` s typy:

```ts
export type ExecutionMode = "shared-opencode" | "sandboxed-workspace";

export type ExecutionTarget = {
  mode: ExecutionMode;
  workspaceId: string;
  directory: string;
  baseUrl: string;
};

export type ExecutionManager = {
  resolveTarget(input: { workspaceId: string; directory: string }): Promise<ExecutionTarget>;
};
```

Chování:

- bez pískoviště vrať sdílený OpenCode proces a původní adresář požadavku,
- s pískovištěm deleguj na `EnginePool` pro daný pracovní prostor,
- nikdy neměň adresář existující konverzace.

**Step 4: Zapoj správce do orchestrátorového démonu**

V `packages/orchestrator/src/cli.ts` uprav směrování `/workspace/:id/opencode/*` tak, aby:

- režim bez pískoviště směřoval na sdílený OpenCode proces,
- režim s pískovištěm směřoval na pracovní proces z `EnginePool`,
- do OpenCode se vždy dostal správný `directory` dotaz nebo hlavička podle verze klienta,
- směrování nebylo odvozené z aktuálně zobrazeného pracovního prostoru.

**Step 5: Zajisti životní cyklus běhů**

V `run-registry` a `run-store` ověř:

- jeden aktivní běh na jednu konverzaci,
- různé konverzace v různých pracovních prostorech mohou běžet souběžně,
- při selhání odeslání do OpenCode se běh označí jako selhaný,
- při nedostupném pracovním procesu se stav vrací jako zastaralý nebo selhaný, ne jako úspěšný.

**Step 6: Spusť orchestrátorové testy**

Run:

```bash
pnpm --filter veslo-orchestrator exec bun test src/execution-manager.test.ts src/engine-pool.test.ts src/run-registry.test.ts
pnpm --filter veslo-orchestrator build
```

Expected: PASS.

**Step 7: Commit**

Run:

```bash
git add packages/orchestrator/src/execution-manager.ts packages/orchestrator/src/execution-manager.test.ts packages/orchestrator/src/engine-pool.ts packages/orchestrator/src/cli.ts packages/orchestrator/src/run-registry.ts packages/orchestrator/src/run-store.ts packages/orchestrator/src/engine-pool.test.ts packages/orchestrator/src/run-registry.test.ts
git commit -m "feat(orchestrator): route workspace runs through execution manager"
```

## Task 5: Stabilizovat Životní Cyklus Místní Služby Veslo

**Files:**
- Modify: `packages/desktop/src-tauri/src/veslo_server/mod.rs`
- Modify: `packages/desktop/src-tauri/src/veslo_server/spawn.rs`
- Modify: `packages/desktop/src-tauri/src/veslo_server/manager.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Test: `packages/desktop/owned-server-defaults.test.mjs`
- Create/Modify: `packages/e2e/pilot-scenarios/veslo-server-startup.toml`
- Docs: `docs/dev/state-and-config-reference.md`

**Step 1: Přidej test na start bez pracovního prostoru**

Do desktopového nebo E2E testu doplň očekávání:

- místní služba se spustí i bez aktivního pracovního prostoru,
- `veslo_server_info` vrátí `running: true`, `baseUrl` a `clientToken`,
- `/health` projde s tímto tokenem,
- stav rozlišuje připraveno bez pracovního prostoru od připraveno s pracovním prostorem.

**Step 2: Spusť test a ověř, že zachytí dnešní slabé místo**

Run:

```bash
pnpm --filter @neatech/veslo-e2e test -- --scenario veslo-server-startup
```

Expected: FAIL, pokud scénář ještě není převedený na `tauri-pilot` nebo služba bez pracovního prostoru není stabilní.

**Step 3: Přesuň vlastnictví služby na desktop**

V desktopové vrstvě zajisti:

- služba se spouští jako stabilní místní host,
- restart služby není postranní efekt přepnutí pracovního prostoru,
- stav spojení obsahuje generaci nebo revizi přístupového klíče,
- přetrvávající stav neukládá hostitelský přístupový klíč tam, kde má být jen klientský,
- starý stav se při neplatném nebo mrtvém procesu zahodí.

**Step 4: Doplň obnovu po neplatném přístupovém klíči**

Při odpovědi 401/403 z místní služby:

- označ spojení jako zastaralé,
- obnov `veslo_server_info`,
- vytvoř nového klienta s aktuálním `baseUrl` a `clientToken`,
- opakuj jen požadavky, které ještě nezaložily běh agenta.

**Step 5: Ověř desktopovou vrstvu**

Run:

```bash
pnpm --filter @neatech/veslo exec cargo test --manifest-path src-tauri/Cargo.toml veslo_server
pnpm --filter veslo-server build:bin
VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar
```

Expected: PASS a sidecar obsahuje aktuální server.

**Step 6: Commit**

Run:

```bash
git add packages/desktop/src-tauri/src/veslo_server packages/desktop/src-tauri/src/lib.rs packages/desktop/owned-server-defaults.test.mjs packages/e2e docs/dev/state-and-config-reference.md packages/desktop/src-tauri/sidecars
git commit -m "fix(desktop): stabilize local veslo server lifecycle"
```

## Task 6: Přepojit Odeslání Zprávy Na Serverovou Konverzační Hranici

**Files:**
- Create: `packages/app/src/app/lib/conversation-client.ts`
- Create: `packages/app/src/app/lib/conversation-client.test.ts`
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/lib/opencode-session.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Test: `packages/app/src/app/app-send-prompt-session-creation.test.ts`
- Test: `packages/app/src/app/app-stale-local-runtime-recovery.test.ts`
- Test: `packages/app/src/app/app-conversation-abort.test.ts`

**Step 1: Napiš klientský test pro nové serverové rozhraní**

V `conversation-client.test.ts` ověř, že klient:

- volá `POST /workspace/:id/conversations`,
- volá `POST /workspace/:id/conversations/:conversationId/runs`,
- neposílá do těla `directory` ani `sessionID` z rozhraní,
- správně zpracuje `run_already_active`, `invalid_directory` a `opencode_failed`.

**Step 2: Spusť test a ověř, že selže**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/conversation-client.test.ts
```

Expected: FAIL, protože klient ještě neexistuje.

**Step 3: Implementuj `conversation-client.ts`**

Minimální tvar:

```ts
export type CreateConversationInput = {
  workspaceId: string;
  title: string;
};

export type SubmitRunInput = {
  workspaceId: string;
  conversationId: string;
  parts: Array<{ type: "text"; text: string } | Record<string, unknown>>;
  model?: { providerID: string; modelID: string };
  agent?: string;
};
```

Klient skládá pouze Veslo adresy. Neobsahuje přímé volání OpenCode relací.

**Step 4: Uprav tok `sendPrompt`**

V `app.tsx` změň první odeslání takto:

1. vyřešit text zprávy,
2. zapsat místní připravený stav zprávy,
3. zajistit dostupnost místní služby,
4. připojit pracovní prostor,
5. vytvořit konverzaci přes Veslo server,
6. založit běh přes Veslo server,
7. průběh číst z existujících událostí nebo transcriptů.

Pro existující konverzaci použij uložený `conversationId`, ne aktuální vybranou relaci OpenCode.

**Step 5: Zachovej příkazy nad existující relací**

Příkazy jako abort, compact, revert a rename musí projít přes serverovou vazbu, pokud konverzace vznikla novým tokem. Dočasně může zůstat kompatibilní cesta pro staré relace, ale nesmí měnit adresář podle aktuálně aktivního pracovního prostoru.

**Step 6: Aktualizuj texty chyb**

Přidej uživatelské stavy:

- místní služba se spouští,
- pracovní prostor se připojuje,
- zakládám konverzaci,
- zakládám běh,
- relace OpenCode selhala,
- spojení s místní službou bylo obnoveno.

**Step 7: Spusť app testy**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/conversation-client.test.ts src/app/app-send-prompt-session-creation.test.ts src/app/app-stale-local-runtime-recovery.test.ts src/app/app-conversation-abort.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 8: Commit**

Run:

```bash
git add packages/app/src/app/lib/conversation-client.ts packages/app/src/app/lib/conversation-client.test.ts packages/app/src/app/app.tsx packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/opencode-session.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/en.ts packages/app/src/app/*.test.ts
git commit -m "feat(app): submit messages through veslo conversations"
```

## Task 7: Přidat Koncové Ověření Souběžných Pracovních Prostorů

**Files:**
- Create: `packages/e2e/pilot-scenarios/opencode-workspace-runtime.toml`
- Modify: `packages/e2e/helpers/pilot-runner.ts`
- Modify: `packages/e2e/helpers/app-launcher.ts`
- Test assets under: `packages/e2e/.tmp-veslo-home`

**Step 1: Přidej pilot scénář**

Scénář musí v reálné desktopové aplikaci ověřit:

- aplikace nastartuje místní službu,
- vytvoří nebo připojí dva pracovní adresáře,
- odešle zprávu nebo řízený shell běh do pracovního prostoru A,
- odešle zprávu nebo řízený shell běh do pracovního prostoru B,
- výstup A vznikne jen v A,
- výstup B vznikne jen v B,
- přepnutí zobrazeného pracovního prostoru během běhu nepřesměruje běh.

**Step 2: Napiš scénář nejdřív jako selhávající**

Použij skrytý marker v DOM podobně jako existující pilot scénáře. Při chybě do markeru vypiš:

- stav místní služby,
- posledních 30 položek odesílací stopy,
- seznam pracovních prostorů,
- stav posledního běhu.

**Step 3: Spusť scénář proti aktuálnímu stavu**

Run:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true

pnpm --filter veslo-server build:bin
VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
cd ../e2e
pnpm test -- --scenario opencode-workspace-runtime
```

Expected: po implementaci PASS. Před dokončením může FAIL ukázat, která vrstva ještě není zapojená.

**Step 4: Commit**

Run:

```bash
git add packages/e2e/pilot-scenarios/opencode-workspace-runtime.toml packages/e2e/helpers/pilot-runner.ts packages/e2e/helpers/app-launcher.ts
git commit -m "test(e2e): cover multi-workspace opencode runtime"
```

## Task 8: Dokumentace A Migrační Poznámky

**Files:**
- Modify: `docs/dev/veslo-server-app-contract.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/testing-playbook.md`
- Modify: `docs/features/`

**Step 1: Aktualizuj smlouvu mezi aplikací a serverem**

Popiš:

- uživatelské rozhraní posílá záměr,
- Veslo server vlastní konverzaci a běh,
- OpenCode relace je interní detail,
- adresář relace vzniká při založení konverzace,
- pískoviště je izolační strategie, ne jediný mechanismus souběhu.

**Step 2: Aktualizuj stav a nastavení**

Doplň:

- stavy místní služby,
- obnova po neplatném přístupovém klíči,
- rozdíl mezi pracovním prostorem, konverzací, během a relací OpenCode,
- pravidla pro migraci starých relací.

**Step 3: Aktualizuj testovací návod**

Přidej nový pilot scénář jako povinný ověřovací průchod pro změny běhové vrstvy.

**Step 4: Commit**

Run:

```bash
git add docs/dev/veslo-server-app-contract.md docs/dev/state-and-config-reference.md docs/dev/testing-playbook.md docs/features
git commit -m "docs: document workspace runtime contract"
```

## Task 9: Finální Ověření A Předání

**Files:**
- No planned source edits.

**Step 1: Spusť cílené testy**

Run:

```bash
pnpm --filter veslo-server exec bun test src/conversation-binding-store.test.ts src/conversation-read-store.test.ts src/conversation-service.test.ts src/server-conversations.test.ts
pnpm --filter veslo-orchestrator exec bun test src/opencode-version.test.ts src/execution-manager.test.ts src/engine-pool.test.ts src/run-registry.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/lib/conversation-client.test.ts src/app/app-send-prompt-session-creation.test.ts src/app/app-stale-local-runtime-recovery.test.ts src/app/app-conversation-abort.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 2: Sestav binárky a sidecary**

Run:

```bash
pnpm --filter veslo-server build:bin
pnpm --filter veslo-orchestrator build:bin
VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar
```

Expected: PASS.

**Step 3: Spusť desktopové ověření**

Run:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true

cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
cd ../e2e
pnpm test -- --scenario opencode-workspace-runtime
pnpm test:pilot:smoke
```

Expected: PASS.

**Step 4: Ověř pracovní strom**

Run:

```bash
git status --short
```

Expected: čistý strom kromě záměrně nezahrnutých artefaktů. Pokud `graphify-out/` vznikne automaticky, nestaguj ho bez samostatného důvodu.

**Step 5: Připrav závěr**

Do závěru uveď:

- OpenCode 1.16.2 ověřeno,
- režim bez pískoviště umí více souběžných relací v různých adresářích,
- režim s pískovištěm používá stejnou konverzační a běhovou hranici,
- místní služba Veslo startuje a obnovuje se nezávisle na aktivním pracovním prostoru,
- přesné příkazy, které prošly.
