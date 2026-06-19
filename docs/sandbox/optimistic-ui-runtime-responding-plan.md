# Optimistic UI vs runtime responding - problem k pozdejsimu rozpoznani

Datum: 2026-06-19

Stav: sandbox poznamka a implementacni plan. Cilem neni okamzite odstranit
optimistic UI, ale zafixovat hranici, co optimistic UI smi a nesmi vlastnit.

## Problem

Pri prepinani konverzaci muze uzivatel nabyt dojmu, ze se odeslana zprava
abortla, pokud po navratu do puvodni konverzace zmizi stav typu "odpovidam".

Backendove logy z posledniho runtime behu ukazaly jinou realitu:

- `prompt_async` requesty byly prijate/submitted jako `ok`, pripadne `queued`.
- Nebyl videt skutecny `session.abort` vyvolany prepinanim konverzace.
- Problem byl v UI vrstve: run UI state se mazal pri navigaci mezi sessions.

Produktovy kontrakt:

- Prepnuti workspace nebo konverzace neni abort.
- Pri navratu do konverzace, ktera porad bezi, ma byt porad videt "odpovidam".
- "Odpovidam" nesmi byt odvozene jen od prave viditelne route.
- "Odpovidam" musi byt vlastnene runtime/session statusem pro konkretni
  workspace + session.

## Proc optimistic UI porad dava smysl

Optimistic UI je uzitecne pro okamzite zobrazeni odeslane uzivatelske zpravy.
Bez nej by po odeslani mohlo nastat prazdne nebo matoucne okno:

- backend request muze byt prijaty rychle, ale transcript/SSE/host DB update
  dorazi pozdeji;
- u prvni zpravy jeste nemusi existovat real session id;
- pending session se musi remapovat na materializovanou real session;
- pri selhani handoffu je potreba mit co oznacit jako failed a vratit uzivateli.

Optimistic UI ale nema predstirat assistant odpoved.

Spravna hranice:

- optimistic UI smi zobrazit uzivatelskou submitted zpravu;
- optimistic UI smi drzet pending/failed stav submitted zpravy;
- optimistic UI smi premostit pending session -> real session;
- optimistic UI nesmi generovat synthetic assistant message;
- optimistic UI nesmi vlastnit zivotnost runtime indikatoru "odpovidam";
- run indikator ma ridit runtime/session status a SSE udalosti.

## Soucasny stav po posledni oprave

Aktualni smer v kodu:

- run UI state je keyed podle UI conversation key, tedy workspace + session;
- prepnuti session uz nema run UI state predchozi session mazat;
- cleanup run UI state ma prijit az pri scoped status prechodu do `idle`;
- skutecny abort zustava jen explicitni akce uzivatele typu stop/cancel.

To resi symptom "vratim se do konverzace a odpovidam zmizelo", pokud runtime
porad hlasi aktivni stav.

## Riziko k pozdejsimu rozpoznani

Optimistic UI je stale sirsi pojem a muze se casem znovu rozsirit do oblasti,
ktera patri runtime ownerovi.

Signaly, ze se problem vratil:

- po switchi zpet do bezici konverzace neni videt "odpovidam";
- v logu je `run-state:reset` bez skutecneho runtime idle/status eventu;
- UI ukazuje optimistic assistant-like obsah pred real transcript/SSE eventem;
- pending first-send handoff vytvori real session, ale ztrati submitted user row;
- failed send necha viset run indicator, nebo naopak smaze user submitted row;
- queue drain zacne posilat do prave viditelne session misto captured session key.

## Cile

1. Zachovat okamzity feedback po odeslani zpravy.
2. Udrzet optimistic UI pouze pro submitted user draft.
3. Presunout "odpovidam" ciste pod runtime/session status.
4. Zajistit, ze session/workspace switch nikdy neabortuje ani neresetuje aktivni
   run.
5. Mit stejny kontrakt pro sandbox i non-sandbox topologii:
   - sandbox: vice workspace enginu;
   - non-sandbox: shared engine s workspace/directory routingem;
   - UI kontrakt je stejny.

## Implementacni plan

### Faze 1 - formalizovat model vlastnictvi

- Pojmenovat v kodu hranici:
  - `optimistic submitted user draft`;
  - `runtime activity / responding state`;
  - `pending session handoff`;
  - `queue state`.
- Doplnit kratke komentare jen tam, kde se tyto hranice krizuju.
- Nepouzivat obecny nazev "optimistic UI" pro runtime indicator.

### Faze 2 - testy kontraktu

Pridat nebo udrzet targeted source/behavior testy:

- session switch zachova active run UI state pro predchozi session;
- scoped `sessionStatusById` prechod non-idle -> idle smaze run UI state;
- optimistic submitted draft se remapuje z pending session na real session;
- optimistic submitted draft se odstrani az po tom, co transcript obsahuje real
  user message;
- failed first-send zustane viditelny jako failed user row;
- queue drain pouziva captured session key, ne aktualne viditelnou session;
- `cancelRun`/explicit stop je jedina UI cesta, ktera vola skutecny abort.

### Faze 3 - oddelit render zdroje

- V message renderu explicitne oddelit:
  - real transcript messages;
  - optimistic user submitted message;
  - runtime footer/indicator state.
- Overit, ze "odpovidam" se renderuje jako run indicator/footer, ne jako
  synthetic assistant message.
- Overit, ze optimistic submitted user message nezmeni scroll/layout tak, aby
  prekryla runtime indicator.

### Faze 4 - runtime status jako source of truth

- Pro active i background sessions cist status pres scoped workspace/session
  lookup.
- Nepouzit globalni `engineReady` nebo aktualni route jako source of truth pro
  konkretni run.
- Pri background SSE `session.idle`/`session.error` provest cleanup jen pro
  odpovidajici workspace + session.
- Pri route/session switchi pouze zmenit viditelny kontext, ne runtime stav.

### Faze 5 - live overeni v Tauri runtime

Scenar pro manual runtime debug:

1. Spustit appku s runtime send workflow trace.
2. V workspace A poslat zpravu.
3. Jakmile je videt "odpovidam", prepnout do jine konverzace.
4. Vratit se zpet do puvodni konverzace.
5. Ocekavani: "odpovidam" je porad videt, dokud backend neposle idle/error.
6. Overit trace:
   - zadny `session.abort` pri switchi;
   - zadny navigacni `run-state:reset`;
   - pripadny reset ma reason odpovidajici runtime idle/status cleanupu.

Stejny scenar zopakovat:

- v sandbox/WSL pooled-per-workspace rezimu;
- v non-sandbox shared-engine rezimu, pokud je explicitne zapnuty.

## Definition of done

- Prepinani sessions/workspaces nikdy neshodi active run indicator jen kvuli
  navigaci.
- Po navratu do bezici konverzace je porad videt "odpovidam".
- Optimistic UI zobrazuje jen submitted user message a je scoped podle
  workspace/session.
- Assistant content pochazi pouze z real transcript/SSE dat.
- Explicitni abort zustava samostatna uzivatelska akce.
- Targeted tests pokryvaji session switch, pending handoff, failed send, queue
  drain a runtime idle cleanup.

## Poznamka k terminologii

Pro dalsi praci je lepsi nepouzivat "optimistic UI" jako zastresujici pojem pro
cele send flow. Presnejsi rozdeleni:

- optimistic submitted user message;
- pending session handoff;
- runtime responding indicator;
- scoped session status;
- queue state.

Tohle rozdeleni brani tomu, aby optimistic render zacal znovu vlastnit runtime
lifecycle.
