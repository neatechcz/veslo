# Settings Header Update Controls Design

## Goal
Přesunout kompaktní update status a primární update akci z těla stránky Nastavení vedle nadpisu `Nastavení` v dashboard headeru.

## Scope
- Dashboard settings header nově zobrazí update status a primární akci (`Zkontrolovat`, `Stáhnout`, `Instalovat`) vedle názvu stránky.
- Původní kompaktní update row uvnitř settings obsahu se odstraní.
- Detailní update karta v sekci General zůstane, ale bez duplicitní primární akce a bez konkurenčního status row.

## Design
- Update cluster se bude renderovat jen v `tab === "settings"`, aby se neobjevil v jiných dashboard pohledech.
- Status label zůstane odvozený ze stejné update state logiky jako dnes, aby nevznikly dva různé textové modely pro update stav.
- Primární akce se bude řídit stejným state machine:
  - `idle` nebo `error` -> `Check`
  - `available` -> `Download`
  - `ready` -> `Install`
  - `checking` nebo `downloading` -> disabled button se stavovým textem
- V settings obsahu zůstanou update toggly a detailní metadata (`last checked`, `published date`, progress, error`), ale ne duplicitní status/action row.

## Testing
- Upravit kontrakt test pro settings layout tak, aby hlídal odstranění starého row z `settings.tsx`.
- Přidat nebo upravit dashboard header test tak, aby potvrzoval render update statusu a akce vedle nadpisu Settings.
