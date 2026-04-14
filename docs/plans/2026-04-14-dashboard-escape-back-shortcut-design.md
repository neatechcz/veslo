# Dashboard Escape Back Shortcut Design

## Goal
Použít `Escape` v dashboard view stejně jako header tlačítko zpět, aby šlo rychle zavřít Nastavení, Automatizace, Soul, Skills a Rozšíření zpět do session.

## Scope
- `Escape` v dashboard view vrátí uživatele do session přes stejnou návratovou akci jako header back button.
- Chování se aplikuje na celý dashboard surface, tedy i na podsekce jako `settings`, `scheduled`, `soul`, `skills`, `mcp/plugins` a interní `config`.
- Shortcut se nespustí, pokud je otevřený fullscreen overlay/modal, aby nepřepsal lokální close flow.

## Design
- Keyboard rozhodování se přesune do sdíleného helperu v dashboard navigation modulu, aby šlo pravidla testovat bez mountování celé stránky.
- `dashboard.tsx` přidá jediný `keydown` listener na `window`, který při validním `Escape` zavolá stejnou `returnToSession()` akci jako header back button.
- Guard bude blokovat modifikované klávesové kombinace, už preventnuté eventy a přítomnost overlaye `fixed inset-0 z-50`, protože tyto vrstvy v dashboardu reprezentují modal/overlay stav.

## Testing
- Rozšířit `dashboard-menu-navigation.test.ts` o unit testy pro ESC helper.
- Přidat source-contract test, že `dashboard.tsx` registruje `keydown` listener a mapuje validní `Escape` na `returnToSession()`.
