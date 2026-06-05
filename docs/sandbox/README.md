# Sandbox docs — multi-workspace + sandbox runtime (VSLO-86)

Tahle složka je **handoff dokumentace** pro nového vývojáře, který přebírá
práci na multi-workspace stabilizaci a lokálním sandbox runtime Vesla
(interní označení VSLO-86). Původně vznikla v květnu 2026 na branchi
`sandbox`; po červnových Windows/WSL opravách je aktualizovaná tak, aby
popisovala současnou realitu větve `local/sandbox-merge`.

> **Pozor na slovo "sandbox":** tahle složka řeší **multi-workspace
> stabilizaci** i **filesystem isolation** pro lokální OpenCode engine.
> Na macOS je backend `sandbox-exec` přes `@anthropic-ai/sandbox-runtime`.
> Na Windows je aktuální řešení **WSL2 + bwrap** v managed nebo explicitně
> zvolené WSL2 distribuci; native Windows Job Object/AppContainer cesta není
> produktový backend v aktuálním kódu.

## Komu je to určeno

Externí vývojář, který Veslo neviděl. V `docs/sandbox/` najdeš všechno
potřebné — od architektury po debug postup — bez nutnosti číst zbytek
repozitáře. Odkazy do `docs/dev/`, `docs/features/` a kořenového
`ARCHITECTURE.md` jsou jen pro hlubší kontext, ne jako prerekvizita.

## Co je VSLO-86

**Multi-workspace** = uživatel má v aplikaci současně přepínatelné
projektové adresáře (workspaces). Klik v sidebaru → uvidí historii
sessions toho workspace, napíše zprávu → AI odpoví v kontextu toho
workspace. Každý workspace má vlastní izolovaný **engine** (OpenCode
instance spuštěná přes platformní sandbox backend), který pracuje s jeho
soubory. Backend je platformní:

- macOS: `mac-sandbox-exec` (`sandbox-exec` přes Anthropic sandbox runtime)
- Windows: `windows-wsl2` (`wsl.exe` + Linux OpenCode runtime uvnitř bwrap)
- Linux host mimo WSL: aktuálně bez podporovaného orchestrator sandbox backendu

VSLO-86 řeší **stabilitu** tohohle flow — freezy při bootu, mrtvé
spinnery při kliku, engine crash cascade, neúplné token rotace. Detaily
viz [`known-issues.md`](known-issues.md) a [`fixes-timeline.md`](fixes-timeline.md).

## Pořadí čtení

| # | Soubor | O čem | Kdy číst |
|---|--------|-------|----------|
| 1 | [`architecture.md`](architecture.md) | 6 procesů Vesla a kdo s kým mluví | Hned. Bez toho další docs nedávají smysl. |
| 2 | [`data-flows.md`](data-flows.md) | Konkrétní cesty: boot, klik workspace, klik session, send | Po architektuře. Tady uvidíš, který proces co dělá v reálném scénáři. |
| 3 | [`known-issues.md`](known-issues.md) | Aktuální pain pointy a proč existují | Před debugováním. Mnoho symptomů má hluboké příčiny. |
| 4 | [`fixes-timeline.md`](fixes-timeline.md) | Chronologie commitů, co řešily, jak verifikované | Pokud potřebuješ vědět, co už bylo opraveno (a v jakém stavu to bylo předtím). |
| 5 | [`debug-playbook.md`](debug-playbook.md) | Jak spustit dev mode, najít porty, otevřít DevTools, číst logy | Jakmile narazíš na první problém. |
| 6 | [`e2e-specs.md`](e2e-specs.md) | Existující WebDriver specy a jak je rozšířit | Pokud chceš automatizovaně reprodukovat / verifikovat fixy. |
| 7 | [`handoff.md`](handoff.md) | Otevřené úkoly, doporučená strategie, copy-paste prompt pro novou AI session | Až budeš plánovat další krok. |
| 8 | [`windows-wsl2-sandbox-runtime.md`](windows-wsl2-sandbox-runtime.md) | Windows WSL2 + bwrap runtime, runtime selection, managed `VesloSandbox` distro | Windows sandbox/runtime provisioning. |

## Vztah k existující dokumentaci v gitu

Existující docs **nezatahuj duplikováním**, jen na ně odkazuj:

- **`ARCHITECTURE.md`** (kořen repa) — high-level vize Vesla (local-first,
  cloud-backed, layered runtime). Tahle sandbox/architecture.md je
  **konkrétní žijící graf** procesů pod multi-workspace stabilizací.
- **`docs/dev/app-map.md`** — mapa frontend kódu (SolidJS shell, routy,
  signals). Tahle sandbox/data-flows.md se na ni odkazuje pro
  konkrétní call sites.
- **`docs/dev/state-and-config-reference.md`** — kde žije jaký state
  (Tauri local state, orchestrator state.json, opencode.jsonc). Sandbox
  docs to **rozšiřují** o multi-workspace specifika (3 zdroje workspace
  identity, sjednocení ID schémat).
- **`docs/dev/testing-playbook.md`** — jak testovat Veslo obecně.
  Sandbox/debug-playbook.md doplňuje **konkrétní postupy** pro
  multi-workspace freeze symptomy.
- **`docs/features/session-runtime.md`** — feature popis session runtime.
  Sandbox/data-flows.md odkazuje pro detail v send flow.
- **`docs/plans/`** — implementační/design historie. Pro VSLO-86
  multi-workspace flow je neber jako zdroj pravdy o shipped chování; některé
  novější plány ale popisují jiné aktuální oblasti, například owned-server
  GitHub Actions. Pro aktuální chování vždy preferuj `docs/dev/`,
  service-local README a kód.

## Co dělat když se docs rozcházejí

Pokud najdeš rozpor mezi sandbox docs a něčím jiným:

1. **`ARCHITECTURE.md` v kořeni** je high-level pravda o vizi.
2. **`docs/sandbox/`** je pravda o **současném stavu kódu** pro
   multi-workspace/sandbox runtime na větvi `local/sandbox-merge`.
3. **Realita v běžící aplikaci** přebíjí všechno — viz `debug-playbook.md`
   jak ji ověřit.

Když opravíš nějaký fix, který mění popisované chování, **aktualizuj
příslušný soubor v `docs/sandbox/`** ve stejném commitu jako kód.
Jinak za měsíc tyhle docs ztratí cenu.
