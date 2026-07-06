# Cloudflare Email Worker - EON W1000 feldolgozó

Ez egy szervermentes Cloudflare Email Worker, amely a bejövő e-mail csatolmányaként érkező EON W1000 XLSX fájlokat parse-olja, majd a kinyert negyedórás adatokat óránkénti kumulatív statisztikává aggregálja, végül Home Assistant-ba továbbítja az API-n keresztül.

## Miért más/jobb, mint az n8n megoldás?

*   **Nem igényel IMAP hozzáférést:** Mivel az emailek közvetlenül a Cloudflare-hez érkeznek (vagy oda vannak továbbítva), nem kell megadnod az email fiókod jelszavát vagy alkalmazásjelszót egy külső rendszernek.
*   **Felhős (szervermentes) architektúra:** Nincs szükség saját szerverre (pl. Docker, n8n futtatására), az e-mail fogadása és feldolgozása a Cloudflare hálózatán történik, 0-24 órában, megbízhatóan.
*   **Ingyenes:** A Cloudflare Email Routing és a Cloudflare Workers ingyenes csomagja (Free tier) bőven elegendő erre a feladatra.
*   **Azonnali feldolgozás:** Az e-mail beérkezésének pillanatában azonnal lefut a Worker, nincs polling vagy ütemezett várakozás.

## Alternatív megoldások

Amennyiben más megközelítést keresel (például rendelkezel már saját futó **n8n** szerverrel, vagy nem szeretnél Cloudflare-t használni), érdemes megnézned a [Netesfiu/EON-W1000-n8n](https://github.com/Netesfiu/EON-W1000-n8n) projektet. Ott az alábbi alternatívák érhetőek el:
*   **n8n workflow-k:** Az adatok lekérdezését és feldolgozását n8n segítségével oldják meg (IMAP vagy Gmail OAuth2 API eléréssel).
*   **Golang alapú feldolgozó (Docker-scratch containerben):** A projekt `prixeus` mappájában található, önálló, minimális erőforrás-igényű Go alkalmazás, ami szintén IMAP/Gmail postaládából olvassa ki és dolgozza fel az adatokat.

## Követelmények

*   **Cloudflare fiók:** Egy ingyenes Cloudflare fiók.
*   **Saját domain név:** A domain DNS kezelésének a Cloudflare-en kell lennie, és be kell állítani az [Email Routing](https://developers.cloudflare.com/email-routing/) funkciót.
*   **Egy dedikált email cím:** Ahova az EON küldi a leveleket (pl. `eon-w1000@sajatdomain.hu`).
*   **Elérhető Home Assistant:** A Worker számára elérhetőnek kell lennie a Home Assistant API végpontjának (pl. Cloudflare Tunnel-en keresztül).
*   **Home Assistant Long-Lived Access Token:** A Worker ezzel fog autentikálni a HA felé.
*   **Spook integráció:** A statisztikák importálásához elengedhetetlen a [Spook (Not your homie)](https://spook.boo/) egyedi integráció telepítése HACS-en keresztül, ami elérhetővé teszi a `recorder.import_statistics` API végpontot a Home Assistant-ban.

## Működés

1.  Az EON portál elküldi az exportot az email címre (vagy Gmail továbbítja azt).
2.  A Cloudflare Email Routing fogadja a bejövő emailt a megadott egyedi címen.
3.  Az Email Routing az e-mailt a hozzárendelt Worker-nek (`eon-w1000-worker`) passzolja.
4.  A Worker kinyeri a `.xlsx` fájlt, parse-olja a benne lévő adatokat, és egy HTTP POST kéréssel beküldi a statisztikákat a Home Assistant API-jába (`/api/services/recorder/import_statistics`).

## Email továbbítás beállítása (pl. Gmail esetén)

Ha nem szeretnéd, hogy az EON közvetlenül a saját domainedre küldje a levelet, használhatsz egy Gmail címet és egy továbbítási szabályt:

1. A Cloudflare Email Routing-ban hozz létre egy egyedi címet (Custom address), pl. `eon-w1000@sajatdomain.hu`, ami Action-ként az `eon-w1000-worker`-t hívja meg.
2. A Gmail fiókodban lépj a **Beállítások -> Továbbítás és POP/IMAP** fülre.
3. Kattints a **Továbbítási cím hozzáadása** gombra, és add meg a Cloudflare-es címedet (`eon-w1000@sajatdomain.hu`).
4. *Tipp: A Gmail egy megerősítő kódot küld erre a címre. Ezt legkönnyebben úgy tudod kiolvasni, ha ideiglenesen a Cloudflare Routing-ban beállítod, hogy erre az egyedi címre érkező leveleket a saját email címedre továbbítsa. Miután megkaptad és beírtad a megerősítő kódot a Gmailben, állítsd vissza a Routing Action-t a Worker-re.*
5. Hozz létre egy új **Szűrőt** a Gmailben:
   * **Feladó:** Az EON email címe, ahonnan az export érkezik.
   * **Tartalmazza a szavakat:** Esetleg szűrhetsz a tárgyra vagy a fájl nevére (pl. `W1000`).
   * A következő lépésben pipáld be a **Továbbítás a következő címre** opciót, és válaszd ki a Cloudflare-es címed.

## Biztonság és Hozzáférés-kezelés

**Figyelem!** Nem ajánlott a Home Assistant API-t teljesen publikusan, védelem nélkül kitenni az internetre!

*   **Cloudflare Tunnel:** A legbiztonságosabb és legkényelmesebb lehetséges megoldás, ha a HA egy Cloudflare Tunnel mögött van. A Cloudflare Access (Zero Trust) felületén tudod beállítani a pontos hozzáférési szabályokat.
*   **Cloudflare Service Token:** Amennyiben Tunnel-t használsz, egy egyedi Service Token segítségével adhatsz hozzáférést a Worker-nek. A Worker HTTP fejlécébe (headers) be kell tenni a generált `CF-Access-Client-Id` és `CF-Access-Client-Secret` értékeket.
*   **ASN szintű limitáció:** Ha hagyományos portnyitást (pl. Nginx Proxy Manager) használsz, érdemes tűzfal vagy Cloudflare WAF szabályokkal limitálni a hozzáférést úgy, hogy **csak a Cloudflare ASN (AS13335) IP tartományainak engedélyezed a csatlakozást**, így kizárólag a Cloudflare hálózata (és benne a te Worker-ed) tudja elérni a HA példányodat.

## Telepítés és beállítás

1.  Lépj a `worker` mappába és telepítsd a függőségeket:
    ```bash
    cd worker
    npm install
    ```

2.  **Környezeti változók (Environment) beállítása:**
    Készíts egy másolatot a `wrangler.toml.template` fájlból `wrangler.toml` néven:
    ```bash
    cp wrangler.toml.template wrangler.toml
    ```
    Ezután nyisd meg az újonnan létrehozott `wrangler.toml` fájlt, és a `[vars]` szekcióban írd át a `HA_URL` értékét a te Home Assistant példányod elérhetőségére:
    ```toml
    [vars]
    HA_URL = "https://ha.sajatdomain.hu:8123" # Vagy a Tunnel URL-ed
    ```

3.  **Titkos adatok (Secrets) beállítása:**
    A Long-Lived Access Token egy érzékeny adat, így azt *nem* a konfigurációs fájlba írjuk, hanem a Cloudflare biztonságos titkosításába (Secrets) töltjük fel az alábbi paranccsal:
    ```bash
    npx wrangler secret put HA_TOKEN
    # Amikor kéri, másold be a HA-ban generált tokent.
    ```
    *(Opcionális: Ha esetleg extra Cloudflare Service Token vagy egyéb hitelesítést is használsz, akkor a `WORKER_SECRET` értéket is secrettel tudod hozzáadni, ami az `X-Worker-Secret` HTTP fejlécben fog átmenni).*

4.  Telepítsd a Workert:
    ```bash
    npx wrangler deploy
    ```

### Cloudflare Email Routing beállítása

1.  Lépj be a Cloudflare Dashboardba, és válaszd ki a domained.
2.  Bal oldalon kattints az **Email -> Routing** menüpontra, majd a **Routing rules** fülre.
3.  Hozz létre egy új egyedi címet (Custom address), pl. `eon-w1000`.
4.  Az Action legyen **Send to a Worker**.
5.  Válaszd ki az imént telepített Workert.
6.  Mentsd el.

## Home Assistant előkészítés

Létre kell hozni a két `input_number` és a két `template_sensor` entitást, amelyek a statisztikát fogadják.

```yaml
# configuration.yaml vagy input_number.yaml
input_number:
  grid_import_meter:
    name: grid_import_meter
    mode: box
    initial: 0
    min: 0
    max: 9999999999
    step: 0.001
    unit_of_measurement: kWh
  grid_export_meter:
    name: grid_export_meter
    mode: box
    initial: 0
    min: 0
    max: 9999999999
    step: 0.001
    unit_of_measurement: kWh
```

```yaml
# configuration.yaml vagy template.yaml
template:
  - sensor:
      - name: "grid_energy_import"
        state: "{{ states('input_number.grid_import_meter') | float(0) }}"
        unit_of_measurement: "kWh"
        device_class: energy
        state_class: total_increasing
      - name: "grid_energy_export"
        state: "{{ states('input_number.grid_export_meter') | float(0) }}"
        unit_of_measurement: "kWh"
        device_class: energy
        state_class: total_increasing
```

## Lehetséges hibák és hibakeresés

A Worker futás közbeni logjait élőben is nézheted a következő paranccsal (vagy a Cloudflare Dashboardon):
```bash
npx wrangler tail
```

Gyakori hibaokok és megoldások:
*   **Cloudflare Bot Protection / Captcha:** Ha a Home Assistant-od szintén Cloudflare (vagy Tunnel) mögött van, a Cloudflare biztonsági rendszere "botnak" minősítheti a Worker-ből induló HTTP kérést. Ilyenkor a Worker HTTP 200 helyett egy Captcha oldalt kap vissza (HTTP 403). Ezt a Cloudflare *Security -> Events* menüpontjában tudod ellenőrizni, és szükség esetén a WAF beállításokban egy kivételt (Skip/Bypass rule) kell létrehoznod a Worker IP címeire, ASN-jére vagy Service Token-jére.
*   **400 Bad Request hiba az API-tól (ServiceNotFound):** A Home Assistant Core alapból nem rendelkezik a statisztikák importálásához szükséges szolgáltatással. Győződj meg róla, hogy a **Spook** integráció telepítve van a HACS-ből, és újraindítottad a HA-t, különben az importálás mindig 400-as hibára fut!
*   **401 Unauthorized:** A `HA_URL` vagy a `HA_TOKEN` hibásan lett megadva, esetleg lejárt.
*   **Nincs csatolmány hiba:** Az e-mail formátuma megváltozott, és a Worker nem találja az XLSX fájlt az üzenetben. Ellenőrizd az e-mail felépítését a Cloudflare Worker logjaiban.
