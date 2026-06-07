# Návrh běhové vrstvy pro OpenCode a pracovní prostory

## Cíl

Veslo musí umět spouštět více souběžných konverzací v různých pracovních
prostorech. Musí to fungovat ve dvou režimech:

- bez izolovaného pískoviště, pro uživatele, kteří pískoviště nemají nebo ho
  nechtějí používat,
- s izolovaným pískovištěm podle novější větve `origin/local/sandbox-merge`.

Současně je potřeba opravit třídu chyb, kdy aplikace po spuštění nemá spolehlivý
přístup k místní službě Veslo, odeslání první zprávy selže, nevznikne konverzace
ani relace OpenCode a uživatel vidí chybu typu `Invalid bearer token`.

## Ověřené východisko

OpenCode 1.16.2 bylo ověřeno mimo repozitář v dočasných adresářích.

Výsledek ověření:

- jeden běžící proces `opencode serve` umí vytvořit více relací nad různými
  adresáři,
- relace A vytvořená v adresáři A zapisovala jen do adresáře A,
- relace B vytvořená v adresáři B zapisovala jen do adresáře B,
- obě relace šlo obsloužit souběžně,
- existující relace zůstává připnutá k adresáři, ve kterém vznikla.

Z toho plyne hlavní pravidlo návrhu: relace OpenCode se musí vytvořit rovnou ve
správném pracovním adresáři a potom se bere jako pevně svázaná s konverzací
Veslo. Uživatelské rozhraní nesmí později rozhodovat, do jakého adresáře se
požadavek pošle.

Ověření nepokrývalo skutečný požadavek na poskytovatele modelu. Pokrývalo ale
nejdůležitější otázku pro směrování pracovních prostorů bez pískoviště: jeden
proces OpenCode zvládne více relací v různých adresářích.

## Současný stav

Současné chování nemá jednu autoritativní běhovou osu. Několik částí aplikace se
může podílet na tom, kdy se spustí místní služba, kdy se připojí pracovní
prostor, kdy se obnoví spojení a kdy se pošle požadavek do OpenCode.

Praktický důsledek:

- místní služba Veslo nemusí být po startu aplikace připravená,
- stará adresa nebo starý přístupový klíč mohou zůstat v části aplikace,
- chyba spojení se projeví až jako chyba odeslání zprávy,
- první zpráva může selhat ještě před založením konverzace,
- pracovní prostor a relace OpenCode nejsou dostatečně pevně svázané,
- přepnutí pracovního prostoru může nepřímo ovlivnit požadavky, které už měly
  běžet jinde.

Tento stav nejde spolehlivě opravit jednou lokální záplatou. Chyba
`Invalid bearer token` je pouze viditelný projev širšího problému: není jasně
určeno, kdo vlastní místní službu, kdo vlastní pracovní prostor, kdo vlastní běh
agenta a kdo smí rozhodnout o adresáři relace OpenCode.

## Cílový stav

Cílový stav má jednu autoritativní cestu od odeslání zprávy po běh agenta.

Uživatelské rozhraní pošle pouze záměr:

- pracovní prostor,
- konverzaci,
- text zprávy,
- uživatelsky zvolená nastavení agenta a modelu, pokud existují.

Veslo potom samo vyřeší:

- zda je místní služba připravená,
- zda je pracovní prostor známý a dostupný,
- jaký adresář patří ke konverzaci,
- zda už existuje relace OpenCode,
- jestli je potřeba relaci založit,
- který běhový režim se použije,
- jak se uloží běh agenta a jeho stav.

Přepnutí pracovního prostoru v rozhraní mění jen zobrazení. Nesmí přesunout
konverzaci, změnit adresář běžící relace ani přerušit běh agenta v jiném
pracovním prostoru.

## Rozhodnutí

Nebudeme opravovat současné chování po jednotlivých chybách. Nahradíme běhovou
osu zprávy novou vrstvou pro konverzace, běhy a provádění.

Nejde o velký přepis celé aplikace. Produktové části a stávající obrazovky mohou
zůstat. Musí se ale změnit cesta zprávy:

1. uživatelské rozhraní vytvoří viditelný záměr k odeslání,
2. místní služba Veslo připraví pracovní prostor,
3. Veslo založí nebo najde konverzaci,
4. Veslo založí běh agenta,
5. Veslo vybere běhový režim,
6. Veslo založí relaci OpenCode ve správném adresáři, pokud ještě neexistuje,
7. Veslo odešle zprávu do OpenCode,
8. Veslo ukládá průběh a výsledek běhu.

Tím zachováme uživatelské chování, které je pro produkt důležité: uživatel po
odeslání zprávy vidí, že zpráva existuje a systém pracuje. Pracovní prostor se
připojuje až jako součást řízeného běhu, ne jako předběžná podmínka blokující
celé rozhraní.

## Složky návrhu

### Místní služba Veslo

Místní služba musí být vlastněná desktopovou aplikací. Má být připravená i bez
aktivního pracovního prostoru a má mít jasné stavy:

- spouští se,
- připravená bez pracovního prostoru,
- připravená s pracovním prostorem,
- obnovuje spojení,
- selhala.

Neplatný přístupový klíč mezi aplikací a místní službou není chyba zprávy. Je to
porucha spojení mezi vrstvami. Aplikace musí zahodit staré spojení, převzít
aktuální adresu a aktuální přístupový klíč a pokračovat jen tam, kde ještě
nevznikl nevratný běh.

### Služba konverzací

Služba konverzací je hranice mezi rozhraním a OpenCode. Přijímá uživatelský
záměr a mění ho na řízenou práci:

- ověří pracovní prostor,
- vybere adresář,
- založí konverzaci,
- přiřadí relaci OpenCode,
- založí běh agenta,
- vrací stav rozhraní.

Rozhraní nesmí posílat vlastní adresář OpenCode ani vlastní cizí relaci
OpenCode. Tím se zabrání tomu, aby omyl v rozhraní poslal požadavek do špatného
pracovního prostoru.

### Správce běhů

Správce běhů ukládá každý pokus o práci agenta jako samostatný běh. Běh je
navázaný na pracovní prostor, konverzaci, relaci OpenCode a adresář.

Stavy běhu musí být oddělené od globálního stavu aplikace:

- čeká na místní službu,
- připojuje pracovní prostor,
- zakládá relaci,
- běží,
- čeká na rozhodnutí uživatele,
- dokončený,
- selhaný,
- zrušený.

Selhání jednoho běhu nesmí znečistit jiný pracovní prostor ani jinou konverzaci.

### Správce provádění

Správce provádění vybírá, jak se požadavek pošle do OpenCode.

Režim bez pískoviště:

- může použít jeden sdílený proces OpenCode,
- každá konverzace má vlastní relaci založenou rovnou ve správném adresáři,
- souběžné relace v různých adresářích jsou podporované ověřením OpenCode 1.16.2,
- tento režim neřeší bezpečnostní izolaci souborového systému, řeší správné
  směrování a souběh.

Režim s pískovištěm:

- naváže na novější větev `origin/local/sandbox-merge`,
- izolovaný pracovní proces nebo skupina procesů zůstane vlastněná běhovou
  vrstvou,
- pracovní prostor, adresář a relace OpenCode zůstanou svázané stejně jako v
  režimu bez pískoviště,
- pískoviště přidává izolaci, ale nesmí být jediným mechanismem pro souběžné
  pracovní prostory.

Tím se `sandbox-merge` nezahazuje. Je potřeba jej zobecnit: současný návrh
pracovních procesů pro pískoviště se stane jednou prováděcí strategií, vedle
strategie sdíleného OpenCode procesu bez pískoviště.

### Převodník OpenCode

Převodník OpenCode je jediná vrstva, která zná konkrétní rozhraní OpenCode. Má
řešit rozdíly mezi verzemi OpenCode, zakládání relací, posílání zpráv, čtení
událostí, práci s oprávněními a změny ve výstupech.

Zavedení OpenCode 1.16.2 a odpovídající knihovny klienta má proběhnout před
přepojením hlavního toku zpráv, aby bylo jasné, proti jakému chování stavíme.

## Tok první zprávy

1. Uživatel napíše zprávu v novém projektu nebo nové konverzaci.
2. Rozhraní vytvoří místní záznam o připravené zprávě.
3. Rozhraní pošle do Veslo záměr k odeslání.
4. Veslo ověří nebo obnoví spojení s místní službou.
5. Veslo připojí pracovní prostor, pokud ještě není připojený.
6. Veslo založí konverzaci.
7. Veslo založí běh agenta.
8. Správce provádění vybere režim bez pískoviště nebo s pískovištěm.
9. Veslo založí relaci OpenCode ve správném adresáři.
10. Veslo odešle zprávu do OpenCode.
11. Události z OpenCode se ukládají k danému běhu a konverzaci.
12. Rozhraní průběžně zobrazuje stav běhu.

Když některý krok selže, chyba se uloží k příslušnému běhu nebo spojení. Nesmí
se projevit jako obecné „odesílání selhalo“ bez informace, zda problém byl v
místní službě, pracovním prostoru, relaci OpenCode nebo samotném běhu.

## Chybové stavy

### Místní služba není připravená

Aplikace má zobrazit stav místní služby a průběžně se pokoušet o obnovu. Při
odeslání zprávy má být běh ve stavu čekání na místní službu, ne tichá chyba
odesílání.

### Neplatný přístupový klíč

Chyba `Invalid bearer token` znamená nesoulad mezi desktopovou aplikací a místní
službou. Aplikace musí obnovit běhové údaje spojení. Pokud ještě nebyl založen
běh agenta, požadavek může pokračovat. Pokud už běh vznikl, automatické
opakování musí být opatrné, aby nevznikla dvojitá práce.

### Pracovní prostor není připojený

Připojení pracovního prostoru je součást řízeného odeslání. Zpráva se má
uživateli tvářit jako připravená a systém má připojení dokončit na pozadí.

### Relace OpenCode nejde založit

Chyba patří ke konkrétní konverzaci a běhu. Nepatří do globálního stavu celé
aplikace.

### Běh selže po založení relace

Stav se uloží jako selhaný běh. Další pokus má být vědomá akce uživatele nebo
řízené opakování nad stejnou konverzací, ne slepé znovuodeslání.

### Uživatel přepne pracovní prostor během běhu

Přepnutí mění jen zobrazení. Běh pokračuje ve svém původním pracovním prostoru a
ve své původní relaci OpenCode.

## Postup zavedení

### 1. Zavést OpenCode 1.16.2

Sjednotit verzi vloženého OpenCode a odpovídající klientské knihovny. Ověřit
změny v poskytovatelích, modelech, relacích, zprávách, oprávněních a průběžných
událostech.

### 2. Zavést hranici konverzace a běhu

Přesměrovat mutace zpráv přes Veslo. Rozhraní posílá záměr, Veslo rozhoduje o
pracovním prostoru, adresáři, relaci a běhu.

### 3. Zavést správce provádění

Připravit společné rozhraní pro provádění bez pískoviště i s pískovištěm.
Sdílený proces OpenCode bez pískoviště musí umět více relací v různých
adresářích. Pískoviště z větve `sandbox-merge` se připojí jako izolační
strategie, ne jako jediný zdroj souběhu.

### 4. Přestavět životní cyklus místní služby

Desktopová aplikace musí vlastnit místní službu Veslo. Služba musí být
připravená i bez pracovního prostoru, mít obnovitelné spojení a nesmí být
restartovaná jako postranní efekt přepínání pracovních prostorů.

### 5. Přepojit stav rozhraní

Nahradit obecné chyby odesílání konkrétními stavy služby, pracovního prostoru,
konverzace, relace a běhu.

### 6. Ověřit v desktopové aplikaci

Ověření musí proběhnout v reálné desktopové aplikaci. Samotné webové rozhraní
není pro tento úkol dostatečné.

## Ověřovací scénáře

Minimální ověření:

- start aplikace bez otevřeného pracovního prostoru,
- první zpráva v novém projektu,
- první zpráva v nové konverzaci,
- souběžné běhy ve dvou různých adresářích bez pískoviště,
- souběžné běhy se zapnutým pískovištěm,
- přepnutí pracovního prostoru během běhu,
- restart místní služby a obnova spojení,
- neplatný přístupový klíč a zotavení,
- selhání založení relace OpenCode,
- selhání po založení relace OpenCode,
- migrace existujících konverzací po aktualizaci OpenCode.

Preferované ověření je koncový test přes desktopovou aplikaci. Nižší testy mají
smysl tam, kde chrání konkrétní směrovací pravidla: uživatelské rozhraní nesmí
poslat adresář OpenCode, konverzace z jednoho pracovního prostoru se nesmí
použít v jiném a běh se po založení nesmí přesměrovat.

## Otevřená rizika

- Ověření OpenCode 1.16.2 zatím nepokrývalo skutečný požadavek na poskytovatele
  modelu.
- Pískoviště ve větvi `sandbox-merge` je potřeba sladit se společným správcem
  provádění, aby nevznikly dvě konkurenční běhové vrstvy.
- Převod existujících konverzací musí jasně určit, jak se doplní vazba na
  pracovní prostor, adresář a relaci OpenCode.
- Obnova po neplatném přístupovém klíči musí rozlišovat mezi požadavkem, který
  ještě nezačal nevratnou práci, a během, který už mohl změnit soubory.

## Shrnutí

Základní směr je řízená náhrada běhové osy zprávy, ne sada lokálních oprav.
OpenCode 1.16.2 potvrzuje, že režim bez pískoviště může podporovat více
souběžných relací v různých adresářích. Větev `sandbox-merge` zůstává důležitá,
ale musí se zapojit jako izolační strategie do stejné autoritativní vrstvy pro
konverzace, běhy a provádění.
