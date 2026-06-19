# Windows↔WSL2 path boundary — kde všude hrozí rozejití cest

> Návazná identifikace po opravě sidebaru: kde jinde se cesta předává **do
> WSL** nebo se čte **z WSL** a může se rozejít její forma/umístění mezi
> Windows hostem (Tauri app, veslo-server) a OpenCode enginem běžícím uvnitř
> WSL2. Cíl: zmapovat rizikové plochy, ne hned opravit.
> Datum: 2026-06-17. Target repo: `…/veslo`.

## Model problému

Engine běží **uvnitř WSL2** a používá WSL cesty; host je Windows a používá
Windows cesty. Dvě nezávislé osy:

- **Forma cesty** — workspace na disku C: je v enginu vidět jako
  `/mnt/c/Users/…`, na hostu jako `C:\Users\…`. Stejné soubory, jiný řetězec.
- **Umístění dat** — engine data home (`opencode.db`, sessions) je ve **WSL
  guest filesystemu** (`/home/veslo/.local/share/opencode/…`), z hostu
  dosažitelné jen přes `\\wsl.localhost\<distro>\…`. Není pod `/mnt/c`, tj.
  není to sdílený soubor s žádnou Windows cestou.

Důležité rozlišení:
- **Workspace soubory** (`<workspace>/.opencode/veslo/outbox`, skills, config)
  leží pod `workspace.path` na disku C: → přes `/mnt/c` je to **stejný
  soubor**, host je vidí. Funguje, dokud je workspace na namapovaném disku.
- **Engine data home** (DB, transcript, sessions) leží v **guest** FS → host
  je **nevidí** přes `workspace.path` ani přes Windows home.

## Kde se překlad DĚLÁ (a je OK)

- `packages/orchestrator/src/sandbox/windows-wsl2/paths.ts`
  (`windowsPathToWslPath`, `wslPathToWindowsPath`, `isWslMappableWindowsPath`)
  — používá se při **spawnu enginu** (směr **do WSL**: cwd, mount,
  assertWslDirectory). Tahle strana je ošetřená.
- `packages/app/src/app/utils/workspace-path.ts` (`wslMountPathToWindowsPath`)
  — jen pro zobrazení relativních cest v UI.

Pozn.: `wslPathToWindowsPath` umí **jen `/mnt/<drive>/…`**, ne guest cesty
(`/home/…`, `/root/…`). Pro engine data home je tedy nepoužitelný.

## Kde překlad CHYBÍ (směr „z WSL") — rizikové plochy

### A. Lokace `opencode.db` se nikdy nenamíří do WSL guestu — POTVRZENO
- `conversation-read-store.ts` `resolveOpenCodeDbPath` zkouší
  `<workspace.path>/.opencode/opencode.db`, `XDG_DATA_HOME`, Windows home
  `~/.local/share/opencode` — **žádný `\\wsl.localhost\…` guest path**.
- `workspace.opencodeDbPath/DataDir/DataHome` by to zachránily, ale nikdo je
  **nenastavuje** — `packages/server/src/workspaces.ts` je jen prochází; žádný
  kód je neplní WSL UNC cestou. Rust `commands/session_reader.rs`
  `opencode_db_path_candidates` zkouší taky jen host-native lokace.
- Důsledek: na Windows+WSL2 read-store nejspíš **vždy vrátí `unavailable`**
  (DB neotevře). Browse list i transcript pak stojí výhradně na našem
  binding-store (proto je oprava sidebaru load-bearing).

### B. Forma directory u matchování DB řádků — POTVRZENO (částečně mitigováno)
- `conversation-read-store.ts` i `conversation-binding-store.ts`
  (`directoryLookupVariants`) řeší jen Windows varianty (slash/case/`\\?\`),
  **nepřekládají `C:\…` ↔ `/mnt/c/…`**. Engine ukládá `session.directory`
  jako `/mnt/c/…`, dotaz jde s `C:\…` → 0 shod.
- Mitigace: binding-store má teď **workspace-wide fallback** (B z fixu).
  Read-store match zůstává citlivý, ale stejně většinou `unavailable` (viz A).

### C. App-side directory matching — VYSOKÉ RIZIKO (ověřit naživo)
- `packages/app/src/app/utils/paths.ts` `normalizeDirectoryPath` /
  `sessionDirectoryMatchesRoot` dělá jen slash/case normalizaci, **žádný WSL
  překlad**. ~129 užití helperů napříč app.
- Kritická místa:
  - **Live sidebar list filtr** `sidebar-workspace-sessions.ts:550`,
    `:914` — `sessionDirectoryMatchesRoot(resolveSessionDirectory(s), root)`
    kde `root` = `workspace.path` (Windows), ale `s.directory` z enginu je
    `/mnt/c/…` → filtr je zahodí. Navíc engine-side dotaz
    `c.session.list({ directory })` jde taky s Windows formou
    (`config.directory = workspace.path`) → engine může vrátit prázdno.
  - **Session scoping** `context/session.ts:836`, `:865`, `:1607` (které
    session patří do aktivního workspace, výběr, guard).
- Důsledek (pravděpodobný): i s běžícím enginem může být list/scoping na
  Windows+WSL2 prázdný/špatný kvůli formě cesty. **Nutno ověřit** proti
  reálnému enginu (a zkontrolovat, zda `resolveSessionDirectory` /
  `sessionDirectoryOverrideById` náhodou nekompenzuje).

### D. Server FS čtení přes `workspace.path` — NIŽŠÍ (ale ne nulové)
Funguje, **dokud** je workspace na namapovaném disku (sdíleno přes `/mnt/c`):
- Outbox/Inbox: `server.ts:2610` `resolveInboxDir`, `:2614` `resolveOutboxDir`
  (+ artifacts route `/workspace/:id/artifacts`).
- Soul/skills/config materializace, `automation-runner.ts` store, files API.
Riziko, když workspace **není** na namapovaném drive (guest-native workspace,
budoucí container/remote worker) → host soubory nevidí. Žádný host-side store
jako fallback.

### E. Mrtvý Rust db-reader — kosmetické
- `commands/session_reader.rs` / `commands/workspace.rs` (`opencode_db_path`)
  hledají DB jen na host-native cestách. Napájejí mrtvý `app/lib/db-reader.ts`
  (viz předchozí audit), takže reálný dopad žádný — ale stejný špatný
  předpoklad.

## Souhrn rizik

| # | Plocha | Osa | Stav | Dopad |
|---|---|---|---|---|
| A | `opencode.db` location (read-store, Rust) | umístění | potvrzeno | read-store `unavailable` na Win |
| B | DB directory match (read/binding store) | forma | potvrzeno (B mitig.) | 0 shod bez fallbacku |
| C | App `sessionDirectoryMatchesRoot` + live list/scoping | forma | vysoké, ověřit | prázdný/špatný list i s enginem |
| D | Server FS přes `workspace.path` (outbox/inbox/skills/soul/automation) | umístění | latentní | selže mimo /mnt/c workspace |
| E | Rust db-reader candidates | obojí | mrtvé | žádný (unused) |

## Doporučení

1. **Jeden kanonický tvar cesty.** Zvolit jednu formu (nejlépe engine/WSL
   formu, protože tak data reálně leží) a v **celém matchování** převádět na
   ni — sdílený helper `toCanonicalWorkspacePath(path, platform)`, který umí i
   `C:\…`↔`/mnt/c/…`. Nahradit jím `normalizeDirectoryPath` v app i
   `directoryLookupVariants` na serveru.
2. **Vyřešit lokaci `opencode.db`.** Buď wire `opencodeDbPath` na
   `\\wsl.localhost\<distro>\home\veslo\.local\share\opencode\opencode.db`
   při registraci workspace (orchestrator zná distro a guest home), nebo
   úplně přestat sahat do guest DB a přejít na host-side tunel obsahu
   (viz [`db-tunnelling-gap-artifacts-and-more.md`](db-tunnelling-gap-artifacts-and-more.md)).
3. **Ověřit C naživo** (desktop runtime, Windows+WSL2): zda live sidebar list
   sedí, nebo padá na formě cesty — to rozhodne, jestli je C akutní fix nebo
   jen latentní.
4. **D**: nepředpokládat, že `workspace.path` je vždy host-viditelný; u
   guest-native workspaců přejít na server/engine API místo přímého FS.

## Reference
- `packages/orchestrator/src/sandbox/windows-wsl2/paths.ts` (existující překlad, jen /mnt)
- `packages/app/src/app/utils/paths.ts` (`normalizeDirectoryPath`, `sessionDirectoryMatchesRoot`)
- `packages/app/src/app/utils/workspace-path.ts` (`wslMountPathToWindowsPath`)
- `packages/server/src/conversation-read-store.ts` (`resolveOpenCodeDbPath`, `directoryLookupVariants`)
- `packages/server/src/conversation-binding-store.ts` (`directoryLookupVariants`, workspace-wide fallback)
- `packages/server/src/workspaces.ts` (pass-through opencodeDbPath, nikdy neplněno)
- `packages/server/src/server.ts` (`resolveInboxDir`/`resolveOutboxDir`, `resolveOpencodeDirectory`)
- `packages/desktop/src-tauri/src/commands/session_reader.rs` (`opencode_db_path_candidates`)
- Souvislé: `sidebar-and-conversations-deep-dive.md`, `sidebar-conversations-fix.md`,
  `db-tunnelling-gap-artifacts-and-more.md`, `windows-wsl2-sandbox-runtime.md`
</content>

## Follow-up 2026-06-17

Provjereni vyslo takto:

- Bod A zustava potvrzeny a neopraveny v tomto kroku: samotna lokace
  `opencode.db` ve WSL guest FS se stale automaticky nepredava do host
  read-store. To je samostatny problem umisteni dat, ne jen forma path stringu.
- Bod B je castecne opraveny: server read-store i binding-store uz pri directory
  lookupu berou jako ekvivalent Windows drive path a WSL mount path
  `/mnt/<drive>/...`.
- Bod C byl potvrzeny jako realna app-side mezera a je opraveny v kritickych
  cestach. App canonicalizuje WSL mount paths pri Windows porovnavani,
  `sessionDirectoryMatchesRoot` rozumi `/workspace` aliasu, a live
  `session.list` cesty zkousi host path, WSL mount path a `/workspace` fallback.
- Bod D zustava latentni: host FS cteni pres `workspace.path` funguje pro
  workspaces na namapovanem Windows disku, ale nevyresi guest-native workspace.
- Bod E zustava kosmeticky/legacy.

Overeno targeted testy pro app session scoping/sidebar kontrakty, server
conversation read/binding/service vrstvu, typechecky a rebuild server sidecaru.

## Self-review follow-up 2026-06-17

Dalsi kontrola kodu po fixu nasla tyto doplnky:

- Orchestrator uz ma vlastni proxy path mapping v
  `packages/orchestrator/src/engine-paths.ts`. Pro WSL2 maze `directory` query
  filtr u `GET /session` a prepise JSON `directory` pole mezi host path a
  sandbox `/workspace`. To znamena, ze cast live path-form problemu byla
  mitigovana uz v proxy vrstve.
- Ten orchestrator mapping ale neumel `/mnt/<drive>/...` jako alternativni
  engine/WSL tvar. Doplnene: `/mnt/c/...` se mapuje do `/workspace/...` pri
  requestech a zpet na host workspace path pri response prepisu.
- App fallback query varianty se po self-review zmenily z "vezmi prvni
  neprazdny raw vysledek" na merge vsech variant podle session id. Jinak by
  mohla zustat schovana session ulozena pod druhou path formou.
- `directoryQueryPathVariants` je ted symetricky: z `C:/...` dela i
  `/mnt/c/...` a `/workspace`, z `/mnt/c/...` dela i `C:/...` a `/workspace`.

Dalsi mista, kde by Windows<->WSL pathing mohl byt potreba, ale nejsou v tomto
fixu menena:

- `opencode-router` peer/directory bindings a generated router status tool
  filtruji nektera `directory` pole exact stringem. Pokud binding vznikne pod
  host path a tool bezi ve WSL s `/workspace`, bude potreba sdilet stejny
  mapping context i do routeru/pluginu.
- Tauri `commands/workspace.rs` cleanup a Rust `session_reader.rs` stale
  pouzivaji host-native DB/directory predpoklady. Jsou to legacy/cleanup cesty,
  ale pro Windows+WSL guest DB nejsou spolehlive.
- `opencode.db` guest-home location zustava nejvetsi nevyreseny problem
  umisteni dat. Path-form canonicalizace ho sama neopravi.
