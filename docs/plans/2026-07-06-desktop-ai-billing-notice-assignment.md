# Zadani: trvale upozorneni na chybejici AI predplatne v nainstalovane aplikaci

## Kontext

V nainstalovane desktop aplikaci Veslo musi byt beznemu uzivateli jasne sdeleno, ze AI neni dostupna, pokud jeho organizace nema aktivni placene predplatne ani aktivni trial.

Aktualni stav neni dostatecne srozumitelny: uzivatel muze videt obecnou hlasku o AI access konfiguraci nebo chybu z backendu az pri pokusu o pouziti AI. To neni vhodne, protoze uzivatel dopredu nepozna, ze problem je v chybejicim predplatnem nebo trialu organizace.

## Pozadovane chovani

Pokud organizace nema aktivni predplatne ani trial, aplikace ma v uzivatelskem session/chat rozhrani zobrazovat trvale upozorneni tesne nad composerem.

Upozorneni ma byt viditelne po celou dobu, kdy je AI pro organizaci z tohoto duvodu nedostupna. Nema jit jen o toast, jednorazovou chybu po odeslani promptu nebo technickou hlasku z API.

Uzivatel ma pred odeslanim promptu pochopit:

- ze AI neni pro jeho organizaci dostupna,
- ze duvodem je chybejici aktivni predplatne nebo trial,
- co ma udelat dal podle sve role.

## Zakladni text

Doporuceny zakladni text:

**AI neni dostupna**

Vase organizace nema aktivni predplatne ani trial. Pro pouzivani AI si aktivujte predplatne nebo pozadejte administratora o zkusebni pristup.

## Kratsi varianta

**AI je zablokovana**

Pro tuto organizaci neni aktivni predplatne ani trial.

## Obchodnejsi varianta

**Nemate aktivni AI predplatne**

Aktivujte predplatne nebo trial, abyste mohli pouzivat AI ve Veslu.

## Stav po skonceni pristupu

Pokud trial nebo predplatne skoncilo:

**Pristup k AI skoncil**

Trial nebo predplatne pro tuto organizaci uz neni aktivni.

## Stav pri problemu s platbou

Pokud existuje predplatne, ale platba selhala nebo je stav po splatnosti:

**Platba se nezdarila**

AI je docasne zablokovana. Aktualizujte platebni udaje nebo kontaktujte administratora.

## Role a akce

Pokud je uzivatel organizacni admin nebo ma opravneni spravovat billing, upozorneni muze obsahovat akci:

- Spravovat predplatne
- Aktivovat predplatne

Pokud je uzivatel bezny clen organizace, upozorneni ma uzivatele smerovat na administratora:

- Kontaktujte administratora
- Pozadejte administratora o aktivaci predplatneho nebo trialu

## Terminologie

Nepouzivat text "dosly vam kredity", pokud produkt v dane casti skutecne nepracuje s kreditovym modelem.

Preferovana terminologie pro aktualni billing model:

- predplatne
- trial
- pristup k AI
- AI neni dostupna
- AI je zablokovana

## Co nema byt vysledkem

Toto zadani neni implementacni plan.

Neurcuje konkretni komponenty, API endpointy, datovy tok, testovaci strategii ani technicke kroky. Popisuje pouze produktove chovani, stavy a texty, ktere ma uzivatel v nainstalovane aplikaci videt.
