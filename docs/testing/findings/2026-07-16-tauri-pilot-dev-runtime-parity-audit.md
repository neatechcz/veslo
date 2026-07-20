# Tauri Pilot vs. dev a MSI runtime: deep parity audit

**Datum:** 2026-07-16
**Stav:** read-only audit, bez změny runtime, scénářů nebo konfigurace
**Cíl:** zjistit, proč Pilot E2E nepokrývá stejné chování jako běžný dev režim a instalované MSI, a navrhnout malé, konkrétní opravy.

## Verdikt

Současný Tauri Pilot systém je použitelný jako deterministický debug a contract harness. Není ale 1:1 ani s `pnpm dev`, ani s nainstalovaným MSI. Nejde jen o drobné odlišnosti profilu: každý režim spouští jiný typ frontendu, používá jinou Tauri identitu, jiný auth zdroj, jiné fixtures a v některých případech i test-only runtime chování.

To není důvod fixtures odstranit. Je to důvod přestat je vydávat za produkční nebo dev-parity acceptance coverage.

| Režim | Přihlášení a profil | Frontend / desktop runtime | Důsledek |
| --- | --- | --- | --- |
| `pnpm dev` | Normální uživatelský dev profil | Tauri dev + Vite dev URL/HMR | Reálný vývojový loop, ale v současnosti implicitně zapíná Pilot/E2E diagnostiku. |
| Výchozí Pilot E2E | Izolovaný profil, syntetický E2E účet | Předem sestavená debug binárka s E2E identitou | Deterministický test, ne běžný dev runtime. |
| Live-inference Pilot | Reálný auth snapshot, ale post-boot znovu injektovaný | Stále E2E debug runtime a výchozí registry fixture | Reálná inference není totéž jako čistý live desktop běh. |
| Packaged smoke | Bez live auth, lokální deterministický model | Debug build s E2E capability, bez bundle/instalace | Neověřuje nainstalované MSI. |
| Produkční MSI | Produkční profil a produkční environment | Release bundle, bez Pilot capability | Toto je runtime, který Pilot přímo nepokrývá. |

## Největší příčiny rozdílného chování

### 1. E2E runner radí sestavit špatný runtime

Když chybí E2E binárka, runner vypíše příkaz s dev Tauri konfigurací. Sám runner ale očekává E2E identitu a E2E Pilot socket. Dev konfigurace používá jinou identitu; E2E konfigurace navíc explicitně poskytuje Pilot capability.

To je konkrétní lokální failure mode: vývojář zkopíruje doporučený příkaz, vznikne dev binárka, ale runner se snaží připojit jako k E2E aplikaci.

**KISS oprava:** opravit doporučený příkaz na E2E konfiguraci a přidat malý test, který hlídá text této chyby.

### 2. Dev a E2E mohou sdílet jednu `target/debug` binárku bez kontroly původu

Dev launcher i E2E launcher pracují s výchozím debug targetem. E2E runner přijme binárku pouze podle existence souboru; nekontroluje, zda poslední build vznikl z dev nebo E2E konfigurace, zda obsahuje správnou identitu, aktuální frontend assets ani správné sidecary.

To je pravděpodobná přímá příčina nestabilního lokálního chování: po `pnpm dev` může Pilot spustit binárku sestavenou pro jiný config, než očekává jeho socket a profil.

**KISS oprava:** oddělit dev a E2E Cargo target, nebo vedle binárky zapisovat krátký build manifest (`config`, `identifier`, frontend hash, sidecar hash, commit) a E2E runner má build s neodpovídajícím manifestem odmítnout.

### 3. Současný gate netestuje ostrý login ani live inference

`current-gate` obsahuje 25 scénářů. Existuje 11 scénářů se striktní ochranou reálného Den auth, ale průnik s `current-gate` je **0**. Samostatný `live-inference` suite spouští jen dva z nich.

Výchozí auth seed používá loopback Den endpoint, fixture token a `@example.test` uživatele. To je správné pro deterministické testy, ale gate proto nemůže tvrdit, že ověřuje skutečný přihlášený user flow.

**KISS oprava:** ponechat `current-gate` jako fixture/contract gate a přidat malý povinný `live-parity` canary nad dedikovaným E2E účtem: signed-in boot, persistence přes restart a jeden skutečný send.

### 4. I "live" scénáře mají implicitní lokální service fixture

E2E launcher standardně spouští skill registry fixture a exportuje její endpoint/token do desktop procesu. Striktní live-inference guard hlídá Den auth a managed-AI gateway, ale nezakazuje tuto registry fixture.

Výsledek: scénář může mít reálný login a přitom používat lokální registry runtime. To komplikuje diagnostiku, protože selhání není čistě live ani čistě fixture.

**KISS oprava:** pro `live-parity` profil fixtures vypnout defaultně; fixture musí být explicitní vlastnost scénáře, ne implicitní výchozí stav launcheru.

### 5. Žádný deklarovaný scénář nepoužívá skutečný Pilot click/fill/press

Audit našel 80 TOML scénářů a 345 kroků:

- 185 `eval`
- 149 `wait`
- 10 `assert-url`
- 1 `assert-visible`

Není použit žádný deklarovaný Pilot `click`, `fill` nebo `press`. Naproti tomu scénáře obsahují 60 DOM `.click()` volání, 148 syntetických dispatchů eventů a 37 referencí na interní Tauri bridge napříč 27 scénáři.

Například navigační scénář mění hash přímo a scénář pojmenovaný jako tři kliknutí žádné skutečné kliknutí neprovádí. Live GPT roundtrip přímo přepíše `contenteditable`, vyšle syntetický `InputEvent` a zavolá DOM `.click()`.

Tím se nepokrývá pointer, keyboard, focus, IME ani WebView input pipeline — přesně vrstvy, které mohou fungovat jinak v debug buildu, WebView nebo MSI.

**KISS oprava:** nepřepisovat celý katalog. Převést nejdřív tři kritické user flows na skutečné Pilot UI vstupy: signed-in boot, navigace a composer/send.

### 6. Current gate sdílí jednu aplikaci a kontaminuje si settings

Runner aplikaci spustí jednou a pak sekvenčně provede celý suite. Z 25 current-gate scénářů 22 mění localStorage. V celém katalogu 49 scénářů vynucuje onboarding completion, 31 jazyk a další přepisují sidebar preference nebo tracing.

Nastavení tedy není jednotné ani scénářově nezávislé. Výsledek následujícího scénáře může záviset na pořadí předchozího scénáře, i když oba samostatně vypadají deterministicky.

**KISS oprava:** zavést jeden versionovaný baseline profil a buď spouštět každý user-flow scénář v novém procesu, nebo mezi scénáři obnovovat přesně definovaný baseline. Žádné ad-hoc `localStorage.setItem` jako obecný setup.

### 7. Live auth se po startu zbytečně znovu seeduje a reloaduje aplikaci

Auth snapshot se správně připraví před spuštěním aplikace a desktop ho hydratuje před onboardingem. Pro explicitní live auth runner následně přes Pilot `eval` znovu zapisuje auth do storage a provede `window.location.reload()`.

Live E2E tedy má jiný startup průběh než běžný dev: aplikace nejdřív nabootuje, pak se jí za běhu nahradí auth a celá se reloadne.

**KISS oprava:** ponechat pouze pre-launch snapshot. Po bootu ověřit e-mail, auth zdroj a signed-in UI stav, ale auth znovu nezapisovat.

### 8. Live token může uniknout do process argumentů a failure artefaktů

Post-boot seed vkládá celý auth JSON do argumentu Pilot `eval`. Pokud tento příkaz selže nebo timeoutuje, runner zahrnuje argumenty do chybové zprávy. Failure diagnostika navíc ukládá kompletní localStorage a sessionStorage; Pilot `storage list` vrací celé key-value páry.

To znamená riziko úniku live tokenu do terminálu, lokálních diagnostik nebo nahraného artefaktu.

**KISS oprava:** odstranit auth seed přes `eval`; v diagnostikách redigovat `veslo.den.auth`, tokeny, cookies a `Authorization` hodnoty. U live běhů ukládat maximálně e-mail, typ zdroje a hash tokenu.

### 9. E2E build aktivně mění runtime chování

E2E feature přidává Pilot capability, zapíná fault-injection surface v orchestrátoru a podle E2E identity registruje frontend hook pro umělé vložení folder-access permission. Některé scénáře proto ověřují přímo injektovaný UI stav nebo native fault endpoint, ne cestu, kterou vyvolá běžný uživatel.

Tyto testy mají hodnotu, ale jsou to `native-contract` nebo `fault` testy, nikoli dev/production parity testy.

**KISS oprava:** zviditelnit typ scénáře v metadatech: `contract`, `live-parity`, `native-fault`, `packaged`.

### 10. Fixture profil a skutečný dev profil mají jiné workspace a data lifecycle

Izolovaný E2E profil pokaždé vytváří syntetický "Visual Workspace", místy remote decoy workspace a přepisuje `HOME`, `USERPROFILE`, app data, WebView2 data, `OPENCODE_HOME`, auth snapshot i lokální server port. Dev naopak používá normální uživatelský profil a provádí legacy data migraci.

To je nutné pro determinismus, ale neodhalí migrační, upgrade ani reálně uložené preference, které se projeví v dev nebo po instalaci.

`E2E_USE_EXISTING_PROFILE=1` není bezpečná náhrada: ponechá skutečný profil, ale runner stále může přidat fixture služby a scénář může osobní data změnit.

**KISS oprava:** používat klonovaný, versionovaný test profil místo osobního profilu. Pro upgrade coverage přidat samostatný golden "starší profil" fixture.

### 11. Některé scénáře mění engine lifecycle oproti normálnímu dev běhu

Pro vybrané runtime a managed-AI scénáře runner nastavuje `VESLO_DISABLE_DEV_AUTOSTART=1`. Další scénáře spouští vlastní server, deterministic model nebo session queue fixture. To jsou legitimní testy recovery a lifecycle kontraktů, ale není správné z jejich výsledku vyvozovat běžnou dev parity.

**KISS oprava:** runtime profil musí explicitně deklarovat `engineBootstrap: normal | disabled | fixture` a suite nesmí míchat odlišné bootstrap režimy.

### 12. Fixture rozhodnutí jsou skrytá ve filename větvení runneru

Runner obsahuje 17 samostatných rozhodnutí podle názvu scénáře: sekundární workspace, auth fixture, katalog fixture, gateway fixture, autostart, relaunch, session queue, packaged smoke a další. Environment se nastavuje jednou před spuštěním sdílené aplikace; pouze část globálních fixture kombinací je vynuceně izolovaná.

Z TOML scénáře tak nelze poznat jeho efektivní auth, profile, fixture ani engine contract.

**KISS oprava:** přidat malé deklarativní metadata scénáře nebo centrální mapu `scenario -> runtimeProfile`; runner smí spustit společně jen scénáře se stejným profilem.

### 13. Packaged smoke není test nainstalovaného MSI

Packaged smoke vytváří debug binárku bez bundlování a přidává E2E capability. Produkční MSI musí Pilot capability postrádat. Jde tedy o užitečný test zabalených sidecarů a frontend assets, ne o test instalace, Windows registry/profile, updateru nebo skutečného first-run MSI režimu.

Existuje verifier nainstalovaného MSI, ale release/staging workflow nyní používá extraction/payload verifier, nikoli skutečný installed-MSI user-flow canary.

**KISS oprava:** pro staging přidat Windows canary, který MSI skutečně nainstaluje, spustí jej s čistým produkčním environmentem a ověří startup/runtime readiness. Pilot do release binárky nepřidávat.

### 14. `pnpm dev` není čistý "standardní dev" baseline

Dev wrapper ve výchozím stavu zapíná manuální Pilot runtime, E2E feature a rozsáhlé trace/diagnostic environment proměnné. Standardní dev bez této instrumentace je až explicitní opt-out.

To maže hranici mezi "dev pozorování" a "Pilot diagnostikou". Když se pak E2E srovnává s `pnpm dev`, často se porovnávají dvě různé instrumentované varianty, ne normální dev a test runtime.

**KISS oprava:** pojmenovat a oddělit režimy: standardní dev, dev s Pilot diagnostikou, izolovaný E2E a installed-MSI canary. Každý běh má vypsat svůj runtime manifest.

### 15. CI neprokazuje broad Pilot parity na hlavní/release větvi

Broad E2E UI workflow běží pro `dev`, zatímco quality workflow na `main` provádí pouze jeden focused desktop-recovery check. Neexistuje povinný live login canary ani installed-MSI UI canary pro hlavní/release cestu.

**KISS oprava:** zachovat levný fixture gate pro PR, ale přidat Windows `live-parity` canary na hlavní/staging cestu a separátní installed-MSI canary před releasem.

## Doporučený cílový model

Nemá smysl pouštět všech 80 scénářů nad osobním ostrým loginem. Bude to nedeterministické, mění to osobní data, vystavuje tokeny a vede k rate-limitům i vzájemně závislým výsledkům.

Správný malý model jsou tři explicitní profily:

1. **`contract`** — dnešní izolovaný fixture profil. Rychlý, deterministický, bez tvrzení o live paritě.
2. **`live-parity`** — izolovaný versionovaný profil, dedikovaný reálný E2E účet, stejné výchozí settings, žádná lokální registry/gateway fixture, auth pouze z pre-launch snapshotu.
3. **`installer`** — skutečně nainstalované MSI, čistý produkční profil a environment, bez Pilotu.

`native-fault` testy mohou být samostatný štítek v `contract` profilu, ale nesmí vstupovat do evidence o production parity.

## Doporučené pořadí implementace

### P0 — odstranit falešné a nebezpečné signály

1. Opravit E2E build hint z dev konfigurace na E2E konfiguraci.
2. Oddělit nebo identifikovat debug binárky build manifestem.
3. Odstranit post-boot auth `eval` + reload; ponechat snapshot před startem.
4. Redigovat auth a tokeny ve failure diagnostikách.

### P1 — zavést skutečnou malou live parity coverage

1. Přidat `live-parity` profil s dedikovaným E2E účtem a versionovanými settings.
2. Převést tři kritické flow na skutečné Pilot UI vstupy.
3. Resetovat baseline mezi user-flow scénáři nebo je spouštět v samostatném procesu.
4. Přidat runtime manifest do každého běhu: binárka/config hash, auth mode, profil, fixtures, autostart, workspace, sidecar verze a porty; bez secretů.

### P2 — dotáhnout installer evidence

1. Připojit skutečný installed-MSI canary do staging/release cesty.
2. Oddělit jeho důkaz od debug packaged smoke.
3. Nechat broad cross-platform fixture gate jako contract coverage, ne jako náhradu Windows installer acceptance.

## Závěr

Největší problém není, že E2E používá fixtures. Problém je, že jsou smíchané s live a packaged tvrzeními, profil se mezi scénáři mění, a user interactions se ve velké míře obcházejí DOM/interními zkratkami.

Nejmenší účinná změna je proto **nepřepisovat celý systém**, ale zavést jasné runtime profily, opravit build kontrakt, odstranit auth injection/reload a mít tři skutečné UI scénáře nad jedním dedikovaným live profilem. Tím se okamžitě oddělí "funguje fixture" od "funguje uživatelská dev/MSI cesta".
