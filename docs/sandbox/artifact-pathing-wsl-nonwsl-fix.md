# Artifact pathing: WSL/non-WSL fix

Datum: 2026-06-17

## Cil

Artefakty z OpenCode konverzaci musi byt citelne a otevritelne bez ohledu na to,
jestli runtime vrati:

- sandbox alias `/workspace/...`
- WSL mount path `/mnt/<drive>/...`
- host absolute path
- workspace-relative path

Zaroven z toho nesmi vzniknout novy predpoklad, ze Veslo uklada data do
root-level `C:\...` lokaci. Windows server data maji jit pres AppData-style
uloziste nebo explicitni `VESLO_DATA_DIR`.

## Co je opravene

### 1. Latest-run artifact scoping

Latest-run artifact endpoint uz necte jen implicitni aktivni workspace
directory. UI klient posila `directory` pro zobrazenou/scoped session a server
ho predava dal do OpenCode requestu:

- jako `directory` query parametr
- jako `x-opencode-directory` header

Server directory nejdriv autorizuje stejnou cestou jako transcript read. To je
dulezite pro minule konverzace, protoze stejny `sessionId`/engine view muze
existovat pod jinym directory scope.

### 2. Directory alias mapping

Server umi pri read scopingu normalizovat:

- `/workspace` a `/workspace/...` na efektivni OpenCode directory
- `workspace/...` na efektivni OpenCode directory
- WSL mount `/mnt/<drive>/...` na odpovidajici Windows drive path

Efektivni OpenCode directory ma prednost pred registry `workspace.path`. To je
dulezite pro workspaces, kde `workspace.directory` ukazuje na konkretni working
directory uvnitr projektu. WSL directory request se pred `path.resolve`
prevede na host path.

### 3. Artifact path mapping

Artifact paths jsou normalizovane tak, aby UI pracovalo s workspace-relative
paths, kdyz je to bezpecne:

- `/workspace/src/file.ts` -> `src/file.ts`
- host absolute path pod workspace root -> relative path
- WSL mount path odpovidajici Windows workspace root -> relative path

Kdyz server zna workspace root a tool vrati absolute path mimo tento root,
generic file artifact se zahodi uz na serveru. API tak nema emitovat cizi
absolute paths a spolehat az na app-side filtr.

Stejny kontrakt je pokryty pro:

- latest-run server artifacts
- right sidebar artifact family rows
- markdown/code file links v assistant outputu
- media evidence/file URL generation
- legacy fallback artifacts

### 4. Soul artifacts

WSL alias paths pro Soul (`/workspace/.opencode/soul.md`,
`/workspace/.opencode/soul/heartbeat.jsonl`) se mapuji pred klasifikaci, takze
se nezobrazi jako genericke file artifacts a zustanou v Soul family.

### 5. Windows storage default

Windows default pro server data dir uz neni `~/.veslo/veslo-server`. Pokud neni
nastaveny `VESLO_DATA_DIR`, server pouzije:

- `%LOCALAPPDATA%\com.neatech.veslo\veslo-server`
- fallback `%APPDATA%\com.neatech.veslo\veslo-server`

Kvuli kompatibilite po updatu se Windows server pri prvnim resolve pokusi
nedestruktivne zkopirovat existujici legacy data z
`<home>\.veslo\veslo-server` do AppData defaultu. Legacy adresar nemaze.
Pokud kopie selze, proces vrati legacy path, aby stare bindings/audit/cache
metadata nezmizely.

Mac/Linux default zustal `<home>/.veslo/veslo-server`. Explicitni
`VESLO_DATA_DIR` porad vyhrava. Tohle se tyka lokalni server DB/cache/spool
vrstvy, ne workspace souboru.

### 6. WSL/runtime binarky

`veslo-server` je host sidecar. Na Windows se prebuilduje Windows `.exe`.
WSL2 runtime pro engine se nespousti pres `veslo-server` Linux binary; orchestrator
pouziva `wsl.exe` a Linux OpenCode runtime uvnitr WSL2/bwrap. Tento pathing fix
tedy vyzaduje rebuild server sidecaru, ne samostatnou WSL `veslo-server`
binarku.

Pri overeni jsem narazil na Windows-specific problem v agregovanem sidecar
build skriptu: Node `spawnSync("pnpm", ...)` nenasel PowerShell/corepack shim.
Runner je upraveny tak, aby na Windows spoustel `pnpm` pres `cmd.exe`; diky
tomu `build:sidecars` projde a prebali host `veslo-server` i router sidecary.

### 7. Test fixtures nejsou PC-specific

Z testu dotcenych timto pathingem jsem odstranil konkretni lokalni user cesty
a root-level Windows fixture typu `C:/workspace/...`. Windows/WSL kontrakty
pouzivaji synteticke AppData-style paths nebo runtime temporary directories.

## Co druhy audit doplnil

`db-tunnelling-gap-artifacts-and-more.md` spravne upozornuje na sirsi problem:

- session latest-run artifacts se porad derivuji z live OpenCode messages
- outbox artifacts se porad ctou primo z `.opencode/veslo/outbox`
- neni tu host-side persisted artifact manifest ani fallback pro browse mode

Tento fix resi path mapping a spravny directory scope. Nezavadi jeste DB tunel
pro obsah artefaktu/outbox. Pokud budeme delat DB tunel, mel by zapisovat do
server data diru/AppData, ne do root-level `C:\...`.

## Review follow-up

Po self-review a externi kontrole byly doplneny tri korekce:

- Windows AppData data-dir change ma legacy migration/fallback.
- `/workspace` directory alias preferuje effective OpenCode directory, ne
  registry workspace path.
- Server-side generic file artifacts dropuji absolute paths mimo znamy root.

## Sandbox/non-sandbox follow-up

Dalsi kontrola ukazala, ze samotne "zkus vsechny varianty" neni idealni.
Prvni request ma jit rovnou do spravneho tvaru podle runtime:

- Windows WSL2 sandbox: `/workspace`, potom `/mnt/<drive>/...`, potom host path.
- Sandbox disabled / backend `none`: host path, potom `/mnt/<drive>/...`, potom
  `/workspace`.
- Neznamy backend: zachova se puvodni vstup jako prvni a dalsi varianty jsou
  fallback.

App to odvozuje z `veslo-server` capabilities `sandbox.enabled/backend`, ktere
server plni z `VESLO_SANDBOX_BACKEND` a `VESLO_DISABLE_SANDBOX`. Sidebar i
session store stale merguji odpovedi ze vsech variant podle session id, aby
nezmizely starsi zaznamy ulozene pod jinym tvarem cesty.

Live Tauri overeni ukazalo, ze `pnpm dev` desktop spawn poustel `veslo-server`
bez `VESLO_SANDBOX_BACKEND`, zatimco orchestrator uz bezelo ve WSL2 sandboxu.
Server pak hlasil `backend=none` a app-side pathing by volil non-sandbox order.
Desktop spawn ted predava platformni backend do server env:

- Windows default `windows-wsl2`
- macOS default `mac-sandbox-exec`
- ostatni hosty `none`
- `VESLO_DISABLE_SANDBOX=1` ma prednost a vynuti `none`
- explicitni `VESLO_SANDBOX_BACKEND` zustava override

Opraveny byl i `opencode-router`:

- directory matching pro bindings rozumi `/workspace`, `workspace/...` a na
  Windows take `/mnt/<drive>/...` vuci workspace rootu routeru
- `/bindings?directory=...` filtruje na strane routeru, ne az exact stringem
  v generated pluginu
- generated router status tool posila `directory` do `/bindings` query a
  ponechava lokalni filtr jen pro `peerId`

Zustava samostatny problem umisteni dat: `opencode.db` ve WSL guest home neni
timto vyreseny. Tohle je path-form fix, ne DB/content tunnel.

## Overeni

Proslo:

- `pnpm --filter veslo-server exec bun test src/tests/audit.test.ts src/tests/session-artifacts.test.ts src/tests/conversation-binding-store.test.ts src/tests/conversation-read-store.test.ts`
- `pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm ...` pro artifact family, media evidence, path links, client prefetch, latency/source kontrakty a dotcene path utils
- `pnpm --filter veslo-server typecheck`
- `pnpm --filter @neatech/veslo-ui typecheck`
- `node --test --import=tsx/esm src/app/tests/utils/paths.test.ts` v
  `packages/app`
- `bun test ./test/health-send.test.js` v `packages/opencode-router`
- `pnpm --filter veslo-code-router typecheck`
- `pnpm --filter veslo-orchestrator typecheck`
- `pnpm --filter veslo-server build:bin`
- `pnpm --filter veslo-orchestrator build:sidecars`
- `pnpm --filter @neatech/veslo exec cargo test --manifest-path src-tauri/Cargo.toml veslo_server::spawn::tests --no-default-features`
- `pnpm --filter @neatech/veslo exec cargo build --manifest-path src-tauri/Cargo.toml --no-default-features`
- live Tauri runtime pres `pnpm dev` + Tauri Pilot: `/capabilities` vratilo
  `sandbox.enabled=true`, `sandbox.backend=windows-wsl2`; switch
  `test-repo2 -> test-repo1 -> test-repo2` udrzel spravny `veslo.projectDir`

Server binary byl po zmene `packages/server/src` znovu prebuiltnuty a
agregovany sidecar bundle byl znovu vygenerovany.

Poznamka k overeni: `pnpm --filter @neatech/veslo-ui test:unit -- ...` v tomto
repo spusti cely `src/app/tests/**/*.test.ts` glob a aktualne narazi na dva
starsi staticke kontrakty mimo pathing zmenu. Cileny path utils soubor prosel
samostatne. Router package `test:unit` je take historicky nestabilni na Windows,
protoze kombinuje Bun runtime s `node:test` soubory a e2e testem bez beziciho
OpenCode; novy health/path alias test prosel samostatne pres Bun.
