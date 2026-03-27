# Architektura agentů ve Veslo

Zmapováno 2026-03-26 (VSLO-46). Revalidace promptů, modelů a konfigurovatelnosti.

## Tři vestavěné agent módy (UI)

Definované v `composer.tsx:465-469`, cyklování přes Shift+Tab (`session-shortcuts.ts:14,26`):

| Mód | Hodnota | Realita |
|-----|---------|---------|
| Build | `"build"` | Nativní OpenCode agent — prompt v kompilované binárce |
| Plan | `"plan"` | Nativní OpenCode agent — prompt v kompilované binárce |
| Task | `"veslo"` | Posílá se jako `"veslo"` → musí existovat `.opencode/agents/veslo.md` ve workspace, jinak **fallback na build** |

## Jak se agent předává do OpenCode

`app.tsx:1260-1268` — při odeslání zprávy:
```typescript
await c.session.promptAsync({
  sessionID, model,
  agent: agent ?? undefined,  // string jméno agenta
  variant: requestVariant,
  parts,
});
```

Agent per session se ukládá jako string v signálu `sessionAgentById` (`app.tsx:898`).

## Definice agentů — `.opencode/agents/*.md`

Markdown soubory s YAML frontmatter v `.opencode/agents/` workspace adresáři:

```yaml
---
description: Popis agenta
mode: primary          # "primary" | "subagent"
hidden: true           # skrytý v UI?
model: opencode/claude-haiku-4-5   # model override
temperature: 0.1       # 0.0–2.0
color: "#44BA81"
tools:
  "*": false
  "read": true
---
System prompt agenta zde...
```

Frontmatter parsování: `server/src/frontmatter.ts`.

## Existující agenti v repozitáři

### V `.opencode/agent/` (repozitář):
- `triage` — primary, hidden, model `opencode/claude-haiku-4-5`
- `duplicate-pr` — primary
- `docs`, `css` — primary

### Interní subagenti (`server/src/internal-system.ts:15-22`):
```typescript
const INTERNAL_PACKS = ["docx", "pdf", "pptx", "xlsx", "skill-creator"] as const;
```
Generuje `veslo-internal-*` agenty s `temperature: 0.1`, `mode: subagent`, `hidden: true`.

### Hlavní veslo agent (workspace):
- `storage/veslo-test1-K/.opencode/agents/veslo.md` — `temperature: 0.2`

## Agent typ z OpenCode SDK

```typescript
type Agent = {
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  native?: boolean;
  hidden?: boolean;
  topP?: number;
  temperature?: number;
  color?: string;
  model?: { modelID: string; providerID: string };
  prompt?: string;
  steps?: number;
  permission: PermissionRuleset;
  options: Record<string, unknown>;
};
```

Načítání: `c.app.agents()` → filtr: `!agent.hidden && agent.mode !== "subagent"` (`app.tsx:1687`).

## Konfigurovatelnost z UI

| Parametr | Kde se nastavuje | Z UI? |
|----------|-----------------|-------|
| Agent výběr | Composer tlačítka / @mention | **Ano** |
| Model | Settings / per-session picker | **Ano** |
| Temperature | Agent `.md` frontmatter | **Ne** |
| TopP | Agent `.md` frontmatter | **Ne** |
| Steps (max kroků) | Agent `.md` frontmatter | **Ne** |
| System prompt | Agent `.md` body | **Ne** |
| Tools přístup | Agent `.md` frontmatter | **Ne** |
| Variant (thinking effort) | Model variant picker | **Ano** |

## Commands s agent/model override

`server/src/commands.ts` — commands v `.opencode/commands/*.md`:
```yaml
---
name: command-name
agent: veslo          # agent override
model: anthropic/claude-3-5-sonnet  # model override
subtask: false
---
```

## Klíčové soubory

| Soubor | Účel |
|--------|------|
| `app/src/app/components/session/composer.tsx` | UI výběr agenta, @mention |
| `app/src/app/pages/session-shortcuts.ts` | Shift+Tab cyklování |
| `app/src/app/app.tsx` | `listAgents()`, `setSessionAgent()`, API volání |
| `server/src/internal-system.ts` | Interní subagenti, delegáti |
| `server/src/commands.ts` | Commands s agent/model override |
| `server/src/frontmatter.ts` | YAML frontmatter parser |
| `app/src/app/types.ts` | `ModelRef`, `ComposerPart` |
| `app/src/app/constants.ts` | `DEFAULT_MODEL`, preference keys |

## Nativní agenti v OpenCode enginu

Zdroj: `anomalyco/opencode` na GitHubu, `packages/opencode/src/agent/agent.ts`.

### Build agent
- **Popis:** "The default agent. Executes tools based on configured permissions."
- **Vlastní prompt:** Nemá — používá provider-specific system prompt (viz níže)
- **Temperature:** nedefinovaná (default enginu)
- **Permission:** vše povoleno + `question: allow` + `plan_enter: allow`
- **Nativní:** ano

### Plan agent
- **Popis:** "Plan mode. Disallows all edit tools."
- **Vlastní prompt:** Nemá, ale engine přidává `plan.txt` jako extra system message (read-only režim)
- **Temperature:** nedefinovaná (default enginu)
- **Permission:** `edit: deny` (kromě `.opencode/plans/*.md`), `plan_exit: allow`
- **Plan prompt (`plan.txt`):** Striktní read-only režim — NESMÍ editovat soubory, běžet destruktivní bash příkazy. Smí jen číst, hledat a plánovat. Workflow: 1) Explore agenti pro průzkum, 2) Plan subagent pro návrh, 3) Syntéza a otázky uživateli, 4) Zápis plánu do `.claude/plans/*.md`, 5) ExitPlanMode.
- **Nativní:** ano

### Další nativní agenti (skryté/subagenti)
| Agent | Mode | Prompt | Temperature | Účel |
|-------|------|--------|-------------|------|
| `general` | subagent | — | — | Multi-step tasks, paralelní práce |
| `explore` | subagent | `explore.txt` | — | Codebase průzkum (glob, grep, read) |
| `compaction` | primary, hidden | `compaction.txt` | — | Kompakce kontextu při overflow |
| `title` | primary, hidden | `title.txt` | 0.5 | Generování titulků sessions |
| `summary` | primary, hidden | `summary.txt` | — | Sumarizace sessions |

## Provider-specific system prompty

Výběr v `system.ts` — `SystemPrompt.provider(model)` podle model ID:

| Model | Prompt soubor | Styl |
|-------|--------------|------|
| Claude (`claude` v ID) | `anthropic.txt` | Strukturovaný, TodoWrite, skills, conventions |
| GPT-4/o1/o3 | `beast.txt` | Agresivní "keep going until solved", web research, recursivní fetching |
| GPT (ostatní) | `codex.txt` | Opatrný, conventions-first, path construction |
| Gemini | `gemini.txt` | Podobný gemini-optimized |
| Ostatní | `default.txt` | Minimalistický, concise, no-emoji |

### Skladba system promptu pro každý request

```
1. SystemPrompt.provider(model)    — provider-specific instrukce (anthropic.txt, beast.txt...)
   ↑ tohle se přidává v SessionProcessor, NE v prompt.ts
2. SystemPrompt.environment(model) — model ID, working dir, git info, datum
3. SystemPrompt.skills(agent)      — dostupné skills (pokud agent má permission)
4. InstructionPrompt.system()      — uživatelské instrukce (CLAUDE.md, AGENTS.md, .opencode config)
5. Agent.prompt (pokud definovaný) — custom system prompt z agent frontmatter
6. Plan mode: PROMPT_PLAN          — read-only instrukce (jen pro plan agenta)
7. Max steps: MAX_STEPS            — "tools disabled" (jen při dosažení limitu kroků)
```

### Klíčové charakteristiky promptů

**anthropic.txt (Claude):**
- Tón: concise, direct, <4 řádky odpovědi
- TodoWrite pro task management
- Skills systém
- Proaktivní ale ne překvapivý
- Bez emoji, bez komentářů v kódu
- Po editaci vždy lint/typecheck

**beast.txt (GPT-4/o1/o3):**
- Tón: "you are the best", autonomní řešení
- Recursivní web research (WebFetch)
- Memory systém (.github/instructions/memory.instruction.md)
- Emoji todo listy
- Agresivní: "NEVER end your turn without solving"

**default.txt (fallback):**
- Minimalistický
- Concise, <4 řádky
- Základní conventions a tool usage

## Známé problémy

1. **Task mód = Build fallback** — agent `"veslo"` se posílá do API, ale pokud workspace nemá `.opencode/agents/veslo.md`, OpenCode ho nerozpozná a použije fallback na `"build"`. Task mód je tedy často identický s Build.
2. **Žádné UI pro temperature/topP** — parametry existují v SDK i ve frontmatter, ale uživatel je nemůže měnit z UI.
3. **Build/Plan prompty nedostupné z Vesla** — jsou v OpenCode enginu (`anomalyco/opencode`), ale dají se overridnout přes `opencode.json` config (`agent.build.prompt`, `agent.plan.prompt`).

## Jak overridnout nativní agenty

Z `agent.ts` — konfigurace v `opencode.json`:
```json
{
  "agent": {
    "build": {
      "prompt": "Custom system prompt...",
      "temperature": 0.3,
      "top_p": 0.9,
      "model": "anthropic/claude-sonnet-4-5",
      "variant": "high",
      "steps": 50,
      "mode": "primary",
      "hidden": false,
      "color": "#FF0000",
      "permission": { "edit": { "*": "allow" } }
    }
  }
}
```
Lze také `"disable": true` pro vypnutí agenta.
