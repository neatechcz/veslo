# Session Titlebar Label Design

Date: 2026-04-08  
Repo: `/Users/vaclavsoukup/AI agent projects/Veslo`  
Status: Approved

## Context
- V session view se ve středu horní lišty zobrazoval název adresáře.
- U temporary/private cest se tím do UI dostával nečitelný hash.
- Uživatel požaduje jednotný název `session` místo názvu adresáře.

## Goal
- V session titlebaru zobrazovat vždy text `session` (lokalizovaný přes i18n), nikoli název adresáře.

## Scope
- In scope:
  - `SessionView` střed titlebaru.
  - i18n klíč pro label `session`.
  - regresní testy pro titlebar chování.
- Out of scope:
  - dashboard titlebar kontext.
  - levý brand (`Veslo by Neatech`).
  - sidebar/workspace list naming.

## Chosen Approach
Vybraná varianta: **2**  
- Session titlebar bude mít fixní text `session` pro všechny workspace.
- Cesta/název složky se ve středu titlebaru už nebude používat.
- Stávající pravidlo skrytí středu v empty chatu zůstane zachované.

## I18n
- Přidat klíč: `session.titlebar_session_label`
- Hodnoty:
  - `cs`: `session`
  - `en`: `session`
  - `zh`: `session`

## Technical Notes
- Upravit `sessionTitlebarContext` v `packages/app/src/app/pages/session.tsx`.
- Závislost na `resolveComposerWorkspaceLabel` pro center titlebar odstranit (jen pro session titlebar; helper může zůstat pro jiné použití).

## Testing
- Aktualizovat `packages/app/src/app/pages/session-titlebar-layout.test.ts`:
  - ověřit, že session titlebar používá i18n klíč `session.titlebar_session_label`.
  - ověřit zachování skrytí center labelu při `messages.length === 0`.
- Spustit cílené testy:
  - `src/app/pages/session-titlebar-layout.test.ts`
  - případně související titlebar guard testy.

## Risks
- Nízké: změna je izolovaná na text center labelu v session view.
- Funkční dopad: ztráta kontextu názvu projektu v horní liště je záměrná dle požadavku.

## Rollout
1. Implementace změny v session titlebaru.
2. Aktualizace i18n klíčů.
3. Testy.
4. Commit.
