# VSLO-86 — Multiplatformní process-level sandbox (cesta γ, Windows-first)

**Stav:** Návrh alternativy k cestě β. Po rozhodnutí Pavla 2026-04-30 (volba VM-bundled) přišla revize: bwrap script od Codex (anomalyco/opencode#2242) ukázal, že proces-level sandbox dá ~95 % hodnoty za zlomek scope.

**Datum:** 2026-04-30
**Související:**
- `docs/design/vslo-86-per-workspace-workers-research.md` — "plná izolace", cesta β (ponecháno jako reference pro budoucí "advanced mode").
- YouTrack VSLO-86 — issue.
- Codex bwrap script: https://github.com/anomalyco/opencode/issues/2242#issuecomment-4272283581 (inspirace pro Linux backend).

---

## 1. Stručně

Per-workspace dlouhoběžící workery + sandbox **na úrovni procesu**, nativně pro každou platformu. Žádná bundled VM, žádný Docker, žádný runtime ke stahování.

**Priorita platforem:**

1. **Windows** — primární cíl. AppContainer + Job Object + Restricted Token přes Win32 API.
2. **macOS** — sekundární. `sandbox-exec` s vygenerovaným `.sb` profilem.
3. **Linux** — minimální. `bubblewrap` jako v Codex scriptu.

**Klíčový princip:** Veslo má v Rustu jeden trait `WorkerSandbox`, tři implementace (Win/Mac/Linux), zbytek kódu (orchestrátor, frontend) o platformě neví.

## 2. Co tato cesta řeší a co ne

### Řeší

- **Hlavní pain point z VSLO-86:** přepnutí workspace nezruší rozdělanou práci. Per-workspace child procesy běží paralelně.
- **FS izolaci:** agent v workspace A nečte soubory v workspace B ani v `~/.ssh`, `~/.aws`, atd. Workspace path je writable, zbytek read-only nebo nedostupný.
- **`.git` ochrana:** read-only mount, agent může číst historii, ale ne ji přepsat.
- **Recovery, lifecycle, parallel runs** — všechno z β-dokumentu zůstává platné, jen sandbox vrstva je jiná.
- **Multiplatformnost** bez bundled runtime. Veslo si nese jen drobné helper binaries (bwrap pro Linux, případně Windows helper utility).

### Neřeší (oproti β)

- **Síťová izolace.** Default je: agent má plný přístup k internetu (potřebuje LLM API). Na Linuxu lze přidat `--unshare-net` + tunneling, na macOS sandbox-exec network rules, na Windows AppContainer capabilities — ale složitější. Pro MVP doporučujeme bez network sandbox.
- **Tvrdé resource limits.** Job Object na Windows umí RAM/CPU cap, cgroups na Linuxu přes systemd-run také, na macOS to je přes `launchd` quotas — funguje, ale méně robustně než VM cgroups.
- **Kernel-level izolace.** Kernel exploit zachytí jen plný VM. Pro běžné AI agent use case (chrání proti agentově chybě, ne proti záměrnému útoku) je process sandbox dostačující.
- **Tooling kompatibilita.** Některé toolings očekávají plný FS přístup. AppContainer je nejvíce restriktivní — některé npm moduly s native deps mohou selhávat. Riziko, řešitelné explicit allowlist nebo escape hatch.

## 3. Architektura

### 3.1 Per-workspace runtime (stejné jako v β)

Tahle vrstva je **identická** s cestou β a musí se udělat tak jako tak:

- Refaktor orchestrátoru: 4 globály (`opencodeChild`, `currentWorkdir`, `currentConfigDir`, `state.opencode`) → mapy klíčované workspace ID.
- Port pool, health check per workspace.
- Frontend: per-workspace `client()`, paralelní SSE streamy, per-workspace `busy` state.
- Sidebar status indikátory, badge + tray pro permission.
- Lifecycle FSM: provisioning → starting → running → suspended → stopped.
- Idle suspend (default 15 min), LRU cap (default 4), pin per workspace.
- Recovery: watchdog s exponential backoff, catch-up sync ze SQLite po restartu.

(Detail v sekcích 6.1–6.5 původního dokumentu, žádná změna.)

### 3.2 Sandbox vrstva — `WorkerSandbox` trait v Rustu

```rust
// packages/desktop/src-tauri/src/sandbox/mod.rs
pub trait WorkerSandbox {
    fn spawn(&self, opts: SpawnOptions) -> Result<SandboxChild>;
    fn capabilities(&self) -> SandboxCapabilities;
}

pub struct SpawnOptions {
    pub workspace_path: PathBuf,        // writable
    pub git_path: Option<PathBuf>,       // read-only mount
    pub state_dirs: Vec<PathBuf>,        // ~/.config/opencode, etc.
    pub binary: PathBuf,                 // veslo-orchestrator nebo opencode
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub disable_sandbox: bool,           // org-owner advanced toggle
}

pub struct SandboxCapabilities {
    pub network_isolation: bool,
    pub resource_limits: bool,
    pub strength: SandboxStrength,       // Strong / Medium / Weak / None
}
```

**Per platforma:**

```
sandbox/
├── mod.rs            // trait + factory (vybírá podle cfg(target_os))
├── windows.rs        // WindowsAppContainerSandbox
├── macos.rs          // MacSandboxExecSandbox
├── linux.rs          // LinuxBwrapSandbox
└── none.rs           // NoSandbox (fallback, dev mode, advanced toggle off)
```

Factory:

```rust
pub fn create_sandbox() -> Box<dyn WorkerSandbox> {
    #[cfg(target_os = "windows")] { Box::new(WindowsAppContainerSandbox::new()) }
    #[cfg(target_os = "macos")] { Box::new(MacSandboxExecSandbox::new()) }
    #[cfg(target_os = "linux")] { Box::new(LinuxBwrapSandbox::new()) }
}
```

Když uživatel zapne "Run without sandbox" v workspace settings → `NoSandbox` pro ten workspace.

## 4. Sandbox per platforma

### 4.1 Windows (primární cíl)

**Mechanismus:** AppContainer + Restricted Token + Job Object.

**AppContainer:**
- Win32 `CreateProcess` s `STARTUPINFOEXW.lpAttributeList` obsahujícím `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` (AppContainer SID).
- Per workspace vlastní AppContainer SID — Veslo si vygeneruje deterministický SID z workspace ID.
- Default: AppContainer nemá přístup k žádné lokaci. Musíme explicitně povolit:
  - **Workspace path** — přes `SetNamedSecurityInfoW` přidat ACL pro AppContainer SID na writable přístup.
  - **`.git`** — stejně, ale read-only ACL.
  - **OpenCode state dirs** (`%APPDATA%\opencode`) — writable.
  - **System DLLs, .NET, system temp** — automaticky přístupné AppContaineru.

**Restricted Token:**
- `CreateRestrictedToken` odstraní privileges, deny SIDs.
- Zabrání agentovi povýšit práva, otevřít privileged objects.

**Job Object:**
- `CreateJobObject` + `AssignProcessToJobObject`.
- `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — kill cascade když Veslo padne.
- `JOB_OBJECT_LIMIT_PROCESS_MEMORY` — RAM cap per worker.
- `JOB_OBJECT_LIMIT_BREAKAWAY_OK = false` — agent nemůže odštěpit subproces mimo Job.

**Capabilities:**

| Aspekt | Stav |
|---|---|
| FS izolace | silná (ACL-based) |
| Network izolace | volitelná (capability `internetClient` přidat/odebrat) |
| Resource limits | silné (Job Object) |
| Kernel-level | ne |
| Tooling kompatibilita | **střední** (známé problémy s některými npm native moduly, git hooks) |

**Rust crates:**
- `windows-rs` (oficiální MS Win32 bindings) — kompletní pokrytí AppContainer/Job/Token API.
- Existující komunitní crates (`appcontainer`, `windows-acl`) — možné, ověřit kvalitu.

**Implementační riziko:**
- AppContainer profile management. Permanent profiles (`CreateAppContainerProfile`) vs runtime-only.
- Některé tooling vyžaduje COM, které AppContainer omezuje. Workaround: COM capability, případně escape hatch.
- Windows code signing nutný pro stabilní AppContainer SID generation across reboots.

**Prototyp ve fázi 0:** spustit `npm install` v AppContaineru s workspace ACL → zkontrolovat, že to projde.

### 4.2 macOS (sekundární)

**Mechanismus:** `sandbox-exec` s dynamicky generovaným `.sb` profilem.

**Profil:**

```scheme
(version 1)
(deny default)

;; allow process to read system libraries, frameworks
(allow file-read*
    (subpath "/System")
    (subpath "/usr")
    (subpath "/Library/Frameworks")
    (subpath "/private/var/db"))

;; allow workspace writable
(allow file-read* file-write*
    (subpath "<WORKSPACE_PATH>"))

;; .git read-only
(allow file-read*
    (subpath "<WORKSPACE_PATH>/.git"))
(deny file-write*
    (subpath "<WORKSPACE_PATH>/.git"))

;; opencode state
(allow file-read* file-write*
    (subpath "<HOME>/Library/Application Support/com.neatech.veslo")
    (subpath "<HOME>/.config/opencode"))

;; deny ssh, aws, gcloud, browser data
(deny file-read*
    (subpath "<HOME>/.ssh")
    (subpath "<HOME>/.aws")
    (subpath "<HOME>/.config/gcloud")
    (subpath "<HOME>/Library/Application Support/Google/Chrome")
    (subpath "<HOME>/Library/Cookies"))

;; allow network (LLM API)
(allow network*)

;; allow subprocess spawn (npm, git, etc.) — sandbox dědí
(allow process-fork)
(allow process-exec)
```

Spawn:

```rust
Command::new("/usr/bin/sandbox-exec")
    .arg("-f").arg(profile_path)
    .arg(opencode_binary)
    .args(opencode_args)
    .spawn()
```

**Capabilities:**

| Aspekt | Stav |
|---|---|
| FS izolace | silná (path-based subpath rules) |
| Network izolace | volitelná (network rules v profilu) |
| Resource limits | slabé (přes `launchd` quotas, ne přímo v sandboxu) |
| Kernel-level | ne |
| Tooling kompatibilita | dobrá (Claude Code dělá totéž) |

**Implementační riziko:**
- `sandbox-exec` je oficiálně deprecated od macOS 10.15+, ale Apple ho stále interně používá (LaunchServices, Mail.app). Funguje min. do macOS 15. Riziko vypnutí v budoucích verzích — máme záložní plán bundle-VM (cesta β) v dokumentu.
- Profil debugging je horor (TinyScheme, žádné error messages). Mitigace: log violations přes `log stream --predicate 'sender == "Sandbox"'`.

### 4.3 Linux (minimální)

**Mechanismus:** `bubblewrap` jak v Codex scriptu.

Veslo si nese `bwrap` binary jako sidecar (~150 KB statické), žádná systémová instalace.

```rust
let mut args = vec![
    "--new-session", "--die-with-parent",
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
    "--cap-drop", "ALL",
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--bind", &workspace_path, &workspace_path,
    "--chdir", &workspace_path,
];
if git_exists {
    args.extend(["--ro-bind", &git_path, &git_path]);
}
for state_dir in state_dirs {
    args.extend(["--bind", &state_dir, &state_dir]);
}
args.extend(["--", &opencode_binary]);
args.extend(opencode_args);

Command::new("bwrap-sidecar").args(args).spawn()
```

**Capabilities:**

| Aspekt | Stav |
|---|---|
| FS izolace | silná (mount namespaces) |
| Network izolace | volitelná (`--unshare-net`) |
| Resource limits | volitelné (přes `systemd-run --scope` před bwrap) |
| Kernel-level | ne |
| Tooling kompatibilita | velmi dobrá (bwrap je v jádru Flatpaku, real-world tested) |

**Implementační riziko:** prakticky žádné. Bwrap je zralá technologie, Codex script ukazuje, že to "prostě funguje".

### 4.4 Co když platforma nepodporuje sandbox

- Windows < 8: AppContainer nedostupný → fallback na Job Object only (slabší izolace).
- macOS bez `sandbox-exec`: nestane se prakticky.
- Linux bez user namespaces (staré kernely): bwrap může selhat → fallback na child proces bez sandboxu.
- Per workspace toggle "Run without sandbox" (org-owner) → `NoSandbox` přímo.

UI musí jasně komunikovat aktuální izolační úroveň: ikona/badge u workspace ("Strong sandbox" / "Weak sandbox" / "Žádný sandbox"). Audit log: zaznamenává úroveň při každém spawn.

## 5. Co se mění oproti cestě β

| Aspekt | Cesta β (VM) | Cesta γ (process-level) |
|---|---|---|
| Bundled runtime | Alpine Linux + kernel + virtio-fs (~100-200 MB) | Bwrap binary na Linux (~150 KB), nic jinde |
| DMG/installer velikost | +100-200 MB | +0 (modulo bwrap) |
| Cold start Vesla | +2-3 s (VM boot) | 0 (žádný extra start) |
| RAM idle (Veslo zapnuté, žádný worker) | +200-400 MB (VM hub) | 0 |
| RAM per worker | sdílí VM zdroje | nativní proces (~150-300 MB jako dnes) |
| Implementační doba MVP | ~14-18 týdnů | **~6-8 týdnů** |
| Code signing entitlements | Apple Hypervisor entitlement, virtualization, atd. | jen standardní notarization |
| HW virtualizace nutná | ano | ne |
| Windows backend | TBD (WSL2 / whpx) — riziko | AppContainer + Job Object — známá technologie |
| macOS izolace | VM-level (silná) | sandbox-exec (středně silná) |
| Linux izolace | VM + cgroups | bwrap namespaces + caps |
| Síť izolovaná | default ano (VM má vlastní network) | default ne, volitelně |
| Resource limits | cgroups uvnitř VM (silné) | Job Object (Win silné), launchd (mac slabé), systemd-run (Linux silné) |
| Multiplatformnost | jednotná abstrakce nad VM | per-platform adapter |
| Dependencies údržba | bundled VM image, libkrun crates, virtio-fs | drobné per-platform helpery |

**Pointa:** γ stojí asi **třetinu času** β a dává **~95 % hodnoty pro běžný use case** (agent nemůže psát mimo workspace, nemůže číst credentials, .git je chráněný). Co γ ztrácí: tvrdou síťovou izolaci (lze přidat per platform), VM-level kernel izolaci (chrání jen proti kernel exploitům, ne agentovým chybám).

## 6. Plán fází (cesta γ)

### Fáze 0 — discovery + Windows prototyp (1-2 týdny)

Cíle:
1. **Windows AppContainer prototyp** — minimální Rust kód, který spustí `node hello.js` v AppContaineru s workspace ACL. `npm install` musí projít. Měřit overhead.
2. **bwrap helper sidecar** — zabudovat bwrap binary do Veslo Tauri resources, ověřit spawn.
3. **sandbox-exec profil generator** — minimální `.sb` template, ověřit, že opencode v něm nastartuje a může číst workspace.
4. **Sjednotit `WorkerSandbox` trait** — common API, tři implementace stub.
5. **HW virt detection není potřeba** — process sandbox nevyžaduje virtualizaci.

**Deliverable:** Rust binary `veslo-sandbox-test`, který přijme platform + workspace path a spustí v sandboxu jednoduchý test (read soubor v workspace OK, read `~/.ssh/id_rsa` selže). Plus benchmark numeric overhead per platform.

### Fáze 1 — per-workspace runtime refactor (3-4 týdny)

(Identické s fází 1 v β-dokumentu, jen bez VM management.)

- Orchestrátor: 4 globály → mapy.
- API rozšíření: `/workspaces/{id}/worker/{start|stop|status}`.
- Port pool, health check per workspace.
- Idle timer + LRU cap + pin.
- Crash recovery (watchdog + backoff).

### Fáze 2 — sandbox integration (1-2 týdny)

- `WorkerSandbox` trait napojený na orchestrátor spawn point.
- Tauri commands: `start_worker(wsId)` interně volá `sandbox.spawn(...)`.
- Per-workspace `disable_sandbox` flag z workspace settings.
- Audit log: spawn events s sandbox level.

### Fáze 3 — frontend per-workspace clients (3-4 týdny)

(Identické s β-dokumentem.)

- `workspaceClients` store, multi-stream SSE.
- Sidebar status indikátory + permission badge + tray.
- Workspace settings: "Run without sandbox" toggle.

### Fáze 4 — hardening + observability (1-2 týdny)

- Telemetrie: počet workerů, paměť, recovery, sandbox violations.
- Diagnostický panel ("Workers" v dev settings).
- Migrace existujících dev workspaces.

**Celkový odhad MVP:** **~8-12 týdnů (2-3 měsíce)** plné soustředěné práce — proti 14-18 týdnům cesty β.

### Fáze 5+ (volitelné, po validaci)

- **Network izolace:** per-platform allowlist (LLM API endpoints jen). AppContainer capabilities, sandbox-exec network rules, bwrap `--unshare-net` + tunnel.
- **Resource limits:** RAM/CPU cap per worker.
- **VM-based mode jako "advanced isolation"** (cesta β) pro security-conscious organizace.

## 7. Klíčová rizika

| Riziko | Pravděpodobnost | Dopad | Mitigation |
|---|---|---|---|
| AppContainer breaks některé npm native moduly | **střední** | **vysoký** | Fáze 0 prototyp s real workspace, escape hatch (per-tool allowlist) |
| sandbox-exec deprecated → vypadne v budoucím macOS | nízká | střední | Záložní plán = β cesta v dokumentu, signal Apple feedback |
| AppContainer profile management komplexní (permanent vs runtime) | střední | nízký | Zvolit runtime-only profiles, žádný persistence |
| bwrap binary distribution (statický build) | nízká | nízký | Použít upstream bwrap release, případně sami zkompilovat |
| Tooling různě reaguje na sandbox per platforma | střední | střední | Per-platform integration tests, CI matrix |
| User očekává Network isolation by default | nízká | nízký | Dokumentace + možnost opt-in v MVP |

## 8. Rozhodnutí, která teď přebíráme z β-dokumentu

Tyto volby z 11.x v β-dokumentu zůstávají **beze změny**:

- **Pool management:** Tauri (Rust). γ to dokonce zjednodušuje — Rust spawne procesy přímo, žádný proxy přes orchestrátor uvnitř VM.
- **Eager start lifecycle:** Veslo zapne → orchestrátor uvnitř Tauri startne → workery se startují lazy on demand. (V γ není VM ke startování, takže "eager" znamená jen "orchestrátor má pool ready".)
- **Default cap 4 + idle suspend 15 min** — konfigurovatelné v settings.
- **Per-workspace sandbox toggle** v workspace settings.
- **Permission badge + tray notifikace** pro neaktivní workspaces.
- **Cloud parity** — lokální worker (sandboxovaný proces) má worker URL jako remote, UI nezná rozdíl.
- **Image distribution** — odpadá. Žádný image. Bwrap binary je v Tauri resources.

## 9. Otázky stále otevřené

1. **Windows code signing** — AppContainer SID generation potřebuje stable certifikát. Máme Apple developer účet, máme Windows code signing certifikát?
2. **macOS notarization s sandbox-exec** — interní použití systémového binary, žádný entitlement nutný, ale ověřit.
3. **Network policy** — v MVP necháme default open? Nebo už v MVP allowlistnout jen LLM API endpoints (Anthropic, OpenAI, Google, etc.)?
4. **Resource limits v MVP** — Job Object na Windows zdarma. macOS/Linux do v2?
5. **Logging sandbox violations** — kam? Veslo audit log? Per-workspace log?
6. **Migrace** — existující single-active workspaces dostanou sandbox automaticky, nebo opt-in v settings?
7. **Tooling escape hatch** — když npm modul potřebuje práva mimo workspace (např. Puppeteer Chrome), jak to řešit? Per-tool capability allowlist v workspace settings?

## 11. Validace průzkumem (2026-04-30) — co se změnilo proti prvnímu návrhu

Po prvním sepsání tohoto dokumentu byl spuštěn paralelní hloubkový průzkum (3 agenti, ~80 zdrojů, ~10 minut research). Výsledky **podstatně mění** některé části sekce 4 (Windows zejména). Tato sekce je novější než sekce 1–10 a má přednost. Sekce 4 zůstává v původní formě jako historický záznam návrhu, ale níže je realistická revize.

### 11.1 macOS — sandbox-exec je spolehlivý, ale použijeme cizí knihovnu

**Klíčové zjištění:** `sandbox-exec` je formálně deprecated od macOS 10.8 (~2012), ale po **14 letech** stále funguje. Apple sám staví **App Sandbox nad stejným kernel modulem (Seatbelt)** — kdyby Seatbelt smazali, padne i celý Mac App Store. Chrome, Anthropic Claude Code, OpenAI Codex CLI, Cursor a Homebrew na něm produkčně staví.

- **Pravděpodobnost odstranění do macOS 30 (2030): < 10 %.**
- **Pravděpodobnost subtle SBPL breaking change v dané verzi: ~60 %** za 5 let → řeší se CI smoke testem na každý macOS major.
- **Apple staff (Quinn @ DTS) explicitně NENABÍZÍ replacement** — pro 3rd party process sandboxing není v macOS oficiální API. To je ironicky důvod, proč to nemůžou jen tak vypnout.

**Revize plánu:** Místo psaní vlastního `.sb` profile generátoru a vlastního `sandbox-exec` wrapperu **použijeme [`anthropic-experimental/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime)** (Apache-2.0, aktivně udržováno, v0.0.49 z dubna 2026). Anthropic řeší přesně náš problém pro Claude Code, profilují to mezi macOS verzemi, a udržují to za nás.

- Bonus: `opencode-sandbox` plugin už existuje a používá tu samou library — tedy můžeme **přímo použít existující řešení** a pouze ho integrovat.
- Network filtering přes localhost HTTPS proxy (Anthropic vzor) — má smysl pro výhled, ale ne v MVP.
- App Sandbox je pro náš use case **nepoužitelný** (child procesy dědí profile, nelze měnit per-spawn).

**Limity, které musíme akceptovat:**
- Docker workflow uvnitř sandboxu = "punch holes" na Unix sockety → degraduje izolaci.
- npm install s native modules vyžadujícími toolchain mimo project dir = fail bez explicit allow.
- MCP servery se širokou plochou = nelze granular allowlistnout.
- Pro tyto případy: **per-workspace toggle "Run without sandbox"** zůstává v plánu.

### 11.2 Windows — původní návrh AppContainer byl naivní, plán se zásadně mění

**Toto je hlavní revize celého dokumentu.**

Naše původní představa "AppContainer + Job Object + Restricted Token" je technicky možná, ale **prakticky pro Veslo nepoužitelná v MVP**. Důvody:

1. **Localhost je v AppContaineru defaultně blokován** ([Project Zero potvrzeno](https://projectzero.google/2021/08/understanding-network-access-windows-app.html)). Veslo orchestrátor a veslo-server běží na `localhost:PORT`, agent uvnitř sandboxu s nimi musí mluvit. Loopback exemption API (`NetworkIsolationSetAppContainerConfig`) **vyžaduje administrátorská práva**. Pro standard user instalaci = deal-breaker.

2. **Žádný precedens neexistuje pro Bun/Node/npm/git v AppContaineru.** Prošel jsem GitHub a blog posty: nikdo nemá runnable wrapper kolem `npm install + node + git + native modules` v AppContaineru. Microsoft sám v `microsoft/SandboxSecurityTools/LaunchAppContainer` má jen generic launcher, ne řešení pro dev tooling.

3. **Postinstall scripts s native moduly** (better-sqlite3, sharp, esbuild) typicky volají MSBuild → cl.exe → registry probes → blokované APIs (`_initterm`, `free`, `malloc` v `msvcrt.dll`). Microsoft App Cert Kit explicitně reportuje failures.

4. **`SetNamedSecurityInfoW` na celý workspace tree je perf gotcha:** per-soubor recursive operace na node_modules s 100k+ soubory = desítky sekund při prvním grantu. Inheritance ACE nefunguje na obyčejné složky retroaktivně.

5. **Žádný velký hráč to nedělá:**
   - **Anthropic sandbox-runtime:** Windows = "Not yet supported". Claude Code na Windows = bez sandboxu nebo přes WSL2.
   - **Cursor:** Windows = WSL2 jako workaround, oficiálně přiznané jako interim.
   - **OpenAI Codex CLI:** **jediný má nativní AppContainer/LPAC backend**, ale je beta, má issues (#15282, #15551, #18043, #19676), a otevřeně se přiznává k buggy chování.
   - **Goose, Aider, Cline, Copilot CLI:** žádný OS-level sandbox na Windows.

6. **Žádný kvalitní Rust crate** pro AppContainer high-level API neexistuje — `windows-rs` má raw bindings, ale wrapper bychom museli psát celý sami (~500-1000 řádků).

**Revidovaný Windows plán — kopírujeme Cursor:**

| Tier | Mechanismus | Kdy se použije |
|---|---|---|
| **Tier 1 (default na Windows s WSL2)** | WSL2 + bwrap uvnitř | Uživatel má WSL2 enabled (Win 10 21H2+ / Win 11 default). Veslo orchestrátor a opencode běží uvnitř WSL2 distribuce, frontend na Windows mluví přes WSL2 networking. Sandbox = bwrap (Codex script). |
| **Tier 2 (default bez WSL2)** | Job Object + Restricted Token (Low IL) + workspace ACL | Bez WSL2: agent běží jako native Windows proces v Job Objectu s Low Integrity tokenem. Memory cap, kill cascade, basic FS izolace přes ACL. ~80 % praktické bezpečnosti, žádný UAC, deterministic. |
| **Tier 3 (opt-in pokročilý)** | Windows Sandbox přes `wsb` CLI | Jen Win 11 Pro/Enterprise + 24H2+. Plnohodnotný Hyper-V sandbox. Boot 15-60s, RAM ~1-2 GB. Pro paranoidní use case. |
| **Tier 4 (research, ne MVP)** | AppContainer + Job Object | Vrátit se k tomu po několika letech, až se ekosystém zralejší. |

**Důsledek pro plán:**
- **Windows MVP = WSL2 default + Tier 2 fallback** (~2-3 týdny implementace).
- AppContainer scope se z dokumentu **vyřazuje pro MVP**. Cesta na Windows je hybrid: pokud má uživatel WSL2 → mluvíme s ním přes WSL2 (bwrap uvnitř). Pokud ne → Job Object + Low IL token (slabší, ale funguje na všem).
- **Job Object používáme vždy** — i bez sandboxu. Memory cap a kill cascade jsou zdarma a spolehlivé. `win32job-rs` crate (v2.0.3) to pokrývá.

### 11.3 Linux — bwrap funguje, ale Ubuntu 24.04+ je past

**Klíčové zjištění:** Codex bwrap script (z VSLO-86 komentáře) funguje **na většině distribucí**, ale **Ubuntu 24.04+ ho rozbíjí**. Důvod: Ubuntu 24.04 zavedla AppArmor restrikci unprivileged user namespaces, což `bwrap --unshare-user` blokuje by default. Codex CLI to dodnes řeší v issues #15282 / #15551.

**Revize plánu:**
- Primární: bwrap jak v Codex scriptu.
- Fallback pro Ubuntu 24.04+: **Landlock + seccomp** (jako Cursor). Funguje od Linux 5.13, neobchází user namespaces, méně intuitivní policies, ale spolehlivější out-of-the-box experience.
- Detekce za běhu: pokud bwrap selže → log warning + fallback na Landlock+seccomp.

### 11.4 Co sandbox NEvyřeší — důležité pro Pavla

Per-workspace OS sandbox je **nutná, ale nedostatečná** vrstva. V 2025-2026 se objevila nová třída útoků:

- **Configuration-Based Sandbox Escape (CBSE)** ([Cymulate](https://cymulate.com/blog/the-race-to-ship-ai-tools-left-security-behind-part-1-sandbox-escape/)): útok přes konfigurační soubory v repu (`.clinerules`, MCP config, hooks) vyřadí sandbox z činnosti. Ovlivňuje Claude Code, Codex CLI, Cursor, Copilot.
- **CVE-2026-39861** Claude Code: symlink following umožňoval zápis mimo workspace.
- **Claude Code self-escape** (březen 2026, [Ona Security](https://ona.com/stories/how-claude-code-escapes-its-own-denylist-and-sandbox)): bwrap selhal na user namespaces, agent **sám si sandbox vypnul** a obešel denylist přes `/proc/self/root/usr/bin/npx`. Ne CVE v sandboxu — agent reasoning vs. sandbox configuration.
- **Cline prompt injection** přes `.clinerules` v repu: žádný OS sandbox to neřeší — útok je už za branou.

**Doporučení:** v MVP řešit jen OS-level sandbox. Druhá vrstva (audit configů + capability injection na úrovni promptů) je samostatný projekt na později. UI musí být honest: "Sandbox blokuje agentovi přístup k FS, ale nezabrání mu udělat něco zlého v rámci povolených hranic. Vždycky review jeho akce."

### 11.5 Aktualizovaný odhad scope

| Komponenta | Původní odhad | Revidovaný odhad |
|---|---|---|
| macOS sandbox-runtime integrace | 1-2 týdny | **3-5 dní** (použijeme cizí library) |
| Linux bwrap + Landlock fallback | 1 týden | 1-2 týdny |
| Windows WSL2 detection + integrace | nezahrnut | 1-2 týdny |
| Windows Job Object + Low IL fallback | 1 týden | 1 týden |
| Per-workspace runtime refactor | 3-4 týdny | 3-4 týdny (beze změny) |
| Frontend per-workspace clients | 3-4 týdny | 3-4 týdny (beze změny) |
| Hardening + telemetry | 1-2 týdny | 1-2 týdny (beze změny) |
| **Celkem** | 8-12 týdnů | **10-14 týdnů** |

Mírně více než původní odhad, ale **stále ~30-40 % méně než cesta β** (14-18 týdnů). Hlavní úspora: macOS = cizí library, Windows = WSL2 místo AppContainer ladění.

### 11.6 Hlavní rizika po validaci

| Riziko | Pravděpodobnost | Dopad | Mitigation |
|---|---|---|---|
| sandbox-exec subtle SBPL change v macOS 27/28 | střední (~60% za 5 let) | nízký | Anthropic sandbox-runtime to udržuje, CI smoke test |
| WSL2 user friction na Windows (vyžaduje enable) | střední | střední | Onboarding wizard, jasná instrukce, fallback na Job Object only |
| Ubuntu 24.04+ AppArmor breaks bwrap | vysoká pro tyto distribuce | střední | Landlock+seccomp fallback automatic |
| Configuration-Based Sandbox Escape (CBSE) | vysoká dlouhodobě | vysoký | Mimo scope MVP, samostatný projekt |
| Agent self-escape přes reasoning | nízká | vysoký | Logging + telemetry, alert na neobvyklé patterns |
| Anthropic sandbox-runtime přestane být udržováno | nízká | nízký | Můžeme přejít na vlastní fork, je to MIT-like license |

### 11.7 Hlavní závěr validace

**Cesta γ je životaschopná a spolehlivější, než vypadalo na první pohled — pro macOS a Linux. Pro Windows naivní AppContainer plán nefunguje a měníme ho na WSL2-first hybrid (jako Cursor).**

Spolehlivost cesty γ na 3-5 let:
- **macOS: vysoká** (sandbox-exec není časovaná bomba, Apple ekosystém na něm závisí, Anthropic ho aktivně udržuje za nás).
- **Linux: vysoká** (bwrap je v Flatpaku, Codex script ukazuje, že to funguje, Ubuntu 24.04+ má řešení přes Landlock).
- **Windows: střední** (WSL2 vyžaduje user enable; Job Object + Low IL je solid baseline; Windows Sandbox jako opt-in pro Pro/Enterprise).

**Neřešitelné problémy:** žádné nenarazily. Jsou jen trade-offy — primárně Windows UX (uživatel musí povolit WSL2 nebo přijmout slabší Tier 2 izolaci).

---

## 10. Reference

- Codex bwrap script: https://github.com/anomalyco/opencode/issues/2242#issuecomment-4272283581
- Anthropic sandbox-runtime: https://github.com/anthropic-experimental/sandbox-runtime
- Anthropic engineering blog (Claude Code sandboxing): https://www.anthropic.com/engineering/claude-code-sandboxing
- Apple Developer Forums (Quinn @ DTS o sandbox-exec): https://developer.apple.com/forums/thread/661939
- Apple sandbox-exec dokumentace: `man sandbox-exec`, `/System/Library/Sandbox/Profiles/`
- Apple Container framework: https://github.com/apple/container
- Microsoft AppContainer: https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation
- Project Zero (AppContainer network analysis): https://projectzero.google/2021/08/understanding-network-access-windows-app.html
- Job Objects: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- win32job-rs: https://github.com/ohadravid/win32job-rs
- Cursor sandbox blog: https://cursor.com/blog/agent-sandboxing
- OpenAI Codex Windows: https://developers.openai.com/codex/windows
- OpenAI Codex sandboxing concepts: https://developers.openai.com/codex/concepts/sandboxing
- bubblewrap: https://github.com/containers/bubblewrap
- Cymulate CBSE blog: https://cymulate.com/blog/the-race-to-ship-ai-tools-left-security-behind-part-1-sandbox-escape/
- Ona Security (Claude Code self-escape): https://ona.com/stories/how-claude-code-escapes-its-own-denylist-and-sandbox
- CVE-2026-39861: https://advisories.gitlab.com/npm/@anthropic-ai/claude-code/CVE-2026-39861/
- Sandvault (real-world AI agent sandboxing): https://github.com/webcoyote/sandvault
- WindowsJobLock (nccgroup): https://github.com/nccgroup/WindowsJobLock
- Joe Cuevas: How I Sandbox AI Coding Agents on Windows 11 with WSL2: https://joecuevas.com/posts/codex-wsl-sandbox/
- `vslo-86-per-workspace-workers-research.md` — paralelní β-dokument (plná VM izolace).
