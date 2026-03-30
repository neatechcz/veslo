# Sidebar Hide More Design

**Date:** 2026-03-30  
**Owner:** Codex + user

## Context

Levé menu už umí postupně zobrazovat další sessions přes akci `sidebar.load_more`.  
Chybí opačný směr: po rozšíření seznamu není dostupná rychlá akce, která vrátí výpis na výchozí počet položek.

## User Intent

1. Uživatel chce možnost položky nejen zobrazovat, ale i skrýt zpět.
2. Text akce se má upravit z `Načíst dalších (+20)` na `Načti další`.
3. Po rozšíření listu má být dole dostupné i `Skryj další`.
4. Pokud je stále možné načíst další sessions, mají být vidět obě akce současně (`Načti další` + `Skryj další`).

## Alternatives

### 1) Dvě současné akce (recommended)

- Samostatná akce `Načti další`.
- Samostatná akce `Skryj další`.
- Pokud lze ještě načítat a současně je list rozšířený, zobrazí se obě.

**Pros:** jasné chování, odpovídá zadání, nejmenší mentální zátěž.  
**Cons:** o jednu řádku akcí navíc.

### 2) Jedno přepínací tlačítko

- Jedno tlačítko mění text i funkci mezi načtením a skrytím.

**Pros:** méně prvků v UI.  
**Cons:** horší predikovatelnost, nesplňuje explicitně požadavek „zobrazí se i skryj další“.

### 3) Globální skrytí napříč projekty

- Jedna akce vrací všechny rozšířené skupiny na default najednou.

**Pros:** rychlé „hard reset“ chování.  
**Cons:** ztráta lokální kontroly, překvapivé výsledky, vyšší riziko regresí.

## Final Design

### UX behavior

1. `Načti další`:
   - zůstává vstupní akce pro rozšíření seznamu,
   - interně dál načítá v krocích `+20` tam, kde to komponenta už dnes dělá.
2. `Skryj další`:
   - zobrazí se, jakmile je zobrazeno víc než výchozí počet.
   - jedním klikem vrátí počet viditelných sessions na výchozí stav.
3. Současná viditelnost:
   - když je co ještě načíst a list je rozšířený, zobrazí se obě akce současně.
4. Disabled stav:
   - během `loading_more` je `Načti další` disabled.
   - `Skryj další` je ve stejném okamžiku také disabled, aby se předešlo závodu mezi načítáním a resetem.

### Scope by mode

1. `Recent` režim:
   - `Skryj další` vrací viditelný počet na výchozí recent hodnotu (počítanou aktuální viewport logikou).
2. `By project` režim:
   - `Skryj další` je per projekt a vrací daný projekt na výchozích `7` položek.

### Data flow / state impact

- Změna zůstává lokální v `WorkspaceSessionList`.
- Bez změn backend request contractu.
- Bez změny `sidebar-session-pagination.ts`.
- Pouze UI viditelnost a lokální čítače (`recentVisibleCount`, `projectVisibleByKey`) získají reset větev.

### Localization

Změny i18n klíčů:

1. `sidebar.load_more`:
   - cs: `Načti další` (z `Načíst dalších (+20)`).
   - en/zh se drží jazykově konzistentního ekvivalentu bez `(+20)`.
2. nový klíč `sidebar.hide_more`:
   - cs: `Skryj další`
   - en: `Hide more`
   - zh: `收起更多`

## Testing Strategy

1. Unit/layout testy pro `WorkspaceSessionList`:
   - ověřit render obou tlačítek při kombinaci `(canLoadMore && expanded)`.
   - ověřit, že `Skryj další` vrací count na default.
2. Regrese stávajících sidebar windowing testů:
   - zachovat `+20` krok načítání.
   - zachovat sentinel/infinite behavior v recent režimu.
3. Lokalizace:
   - ověřit update `sidebar.load_more`.
   - ověřit nový `sidebar.hide_more` ve všech podporovaných locale souborech.

## Non-goals

1. Nepřepisujeme server-side paging model.
2. Neměníme řazení sessions.
3. Nepřidáváme globální „collapse all projects“.

## Acceptance Criteria

1. Uživatel může po rozšíření seznamu sessions jedním klikem skrýt další položky zpět na default.
2. V rozšířeném stavu se zobrazuje `Skryj další`.
3. Pokud lze dál načítat, zobrazují se současně `Načti další` i `Skryj další`.
4. Text `sidebar.load_more` je v češtině `Načti další`.
5. Změny jsou pokryté testy bez regresí stávajícího windowing chování.
