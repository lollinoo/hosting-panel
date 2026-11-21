# ADR 0033 — Modelli di Sito: WordPress come Primo Modello Configurabile

- **Stato:** `APPROVATO` — implementato (M2–M4 e fase finale: creazione da modello, passaggio di versione, Updates, OpenAPI); la revisione del proprietario è in attesa: lo sciame non può approvare al suo posto
- **Data:** 2026-11-21
- **Riferimento:** richiesta del proprietario (modelli orizzontali, in stile Coolify, scritti dall'amministratore e scelti dal cliente), `ADR-0029` (i moduli dei tipi di sito che questo ADR estende), `ADR-0034` (limite di siti per cliente), `ADR-0016`, `ADR-0028` (aggiornamenti e `hp-update`); `HARNESS.md`
- **Migrazioni:** `0024` (additiva; file `packages/database/migrations/0024_site_templates.sql`)

Questo ADR è la versione «as built» di M2–M4: i file, le funzioni e le route create sono scritti tra apici inversi e le prove reali sono in §7. Le decisioni di §2 valgono per ogni punto in cui un sito nasce, cambia versione di modello o cambia versione di PHP. I limiti noti sono in §4 e le differenze dal progetto in §5.

## 1. Contesto

Fino a M1 il pannello sapeva creare un solo tipo di sito, WordPress, e lo faceva con valori scritti nel codice: l'immagine (`resolveWordpressImage`), il volume, la porta, i limiti di CPU e memoria (`1000` milli, 512 MiB), la posta. ADR-0029 ha spostato i *fatti* di WordPress in un modulo per livello, ma non ha dato all'amministratore alcuna leva: per cambiare un limite, aggiungere una variabile d'ambiente o alzare `upload_max_filesize` bisognava cambiare il codice e fare una nuova release.

Il proprietario vuole un catalogo di **modelli** che l'amministratore scrive e il cliente sceglie alla creazione del sito, nello stile di Coolify: un documento tipo Compose con qualche parametro. Il vincolo di sicurezza è che un documento scritto da una persona non può mai dare al contenitore più di quanto il pannello approva: l'esecutore accetta qualunque stringa di immagine e il pannello non ha altra barriera tra l'amministratore e l'host.

Fatti del codice di cui l'ADR tiene conto:

- Un sito gestito ha una chiave `sites.site_type` (ADR-0029) e un servizio `web` con una revisione (`stack_revisions`), da cui `apps/api/src/runtime/service-spec.ts` ricava lo spec approvato per l'esecutore. Lo spec WordPress deve restare identico byte per byte (i test dei *pin*, `apps/api/test/site-type-pins.test.ts` e `apps/api/test/fixtures/site-type-pins/spec-hash.json`).
- `sites.php_version` esiste solo per WordPress; il cambio di versione PHP (`ManagedSitesService.changeRuntime`) ricrea l'immagine con `type.image(phpVersion)`.
- I confini dei livelli sono controllati: `apps/api/test/site-type-boundary.test.ts` scansiona i file dei contratti e dell'esecutore alla ricerca di parole proprie di un tipo; per questo `phpIni` e il modulo `site-php.ts` non contengono nomi di tipi.
- I DTO che il web legge usano **array** per i nomi scelti dall'utente (`{key, value}`), non oggetti con chiave: il BFF oscura chiavi come `password` in qualsiasi risposta.

## 2. Decisioni

### 2.1 Modulo = codice, modello = dato

- Il **modulo** (ADR-0029) è codice: `SITE_TEMPLATE_MODULES` (`packages/contracts/src/site-templates/modules.ts`) è un `Record` su `SITE_TYPE_KEYS` con i fatti che solo il codice decide: il servizio (`serviceTemplateId`), il nome dell'istanza (`web`), la funzione `image(phpVersion)`, le versioni PHP ammesse, il volume e il percorso obbligatori, la porta interna, `exposeHttp`, `siteMail`, i limiti predefiniti. Una chiave nuova senza fatti non compila.
- Le **regole** che il validatore applica a un modulo stanno a parte, in `SITE_TEMPLATE_POLICIES` (`packages/policy-engine/src/site-template-policies.ts`): repository dell'immagine ammesso, forma del tag, minimi di risorse, se sono ammessi volumi extra e impostazioni PHP, massimo di parametri visibili al cliente. Restano fuori da `SiteTypeDefinition`, che ogni livello legge e che un test scansiona.
- Il **modello** è un dato: un documento scelto dall'amministratore che può solo scegliere *dentro* i fatti del modulo (un'immagine del repository ammesso, limiti entro i tetti, le variabili d'ambiente). Un modello non può cambiare ciò che il codice decide.

### 2.2 Il modello dei dati (migrazione `0024`)

- **`site_templates`** (`siteTemplates` in `packages/database/src/schema.ts`): `id` (`stpl_…`), `module`, `name` (1–80 caratteri; unico senza distinguere maiuscole tra i modelli non archiviati: `uq_site_templates_name_active`), `description` (≤ 500), `built_in`, `enabled`, `default_version_id`, `archived_at`. Vincoli: un modello abilitato ha una versione predefinita (`ck_site_templates_enabled_needs_default`); un modello archiviato è disabilitato; quello incorporato non si archivia. La versione predefinita è una chiave esterna composta `(default_version_id, id)` verso `site_template_versions`: deve essere una versione dello stesso modello.
- **`site_template_versions`**: `id` (`stv_…`), `template_id`, `version_number` (da 1, unico per modello), `source` (il testo scritto dall'amministratore, 1–65 536 byte), `spec` (JSONB: il risultato del validatore), `spec_hash` (SHA-256), `created_by`. **Una versione è immutabile**: il trigger `trg_prevent_site_template_versions_mutation` rifiuta ogni `UPDATE` che cambi una colonna diversa da `created_by` e ogni `DELETE`. Per cambiare un modello si aggiunge una versione.
- **`sites.template_version_id`** (nullable, chiave esterna `ON DELETE RESTRICT`) e **`sites.template_parameters`** (JSONB array di `{key, value}`, nullable). **`NULL` in `template_version_id` = sito storico = versione 1 del modello incorporato** (`BUILT_IN_VERSION_BY_MODULE`). I siti nuovi salvano sempre l'id della versione. `sites.php_version` resta com'è; è `NULL` per un modello senza il parametro `php_version`.
- **Additiva e compatibile con il rollback.** Tabelle nuove e due colonne nullable, senza DEFAULT né backfill; la migrazione si può rieseguire (`IF NOT EXISTS`, vincoli eliminati e ricreati). Il rollback automatico di `hp-update` riporta una release che non conosce le colonne e continua a inserire i siti senza di esse. Il rischio sta nel downgrade scelto dall'operatore: vedi §2.11.
- Le righe di audit dei modelli non contengono mai `source` né `spec` (solo id, nomi, numeri e hash).

### 2.3 Il modello incorporato di WordPress

`packages/contracts/src/site-templates/built-in.ts`:

- `BUILT_IN_WORDPRESS_TEMPLATE_ID = "stpl_wordpress"`, `BUILT_IN_WORDPRESS_VERSION_ID = "stv_wordpress_1"`. La versione 1 ha un solo parametro, `php_version` (`enum` `8.3`/`8.4`/`8.5`, predefinito `8.4`, visibile al cliente), un volume `html:/var/www/html`, la porta `80`, `cpus: "1.0"` e `memory: 512M`.
- **L'immagine è `${HP_MODULE_IMAGE}`**, ammessa solo come *intero* valore di `image`: il renderer la risolve con `facts.image(phpVersion)`, cioè con il pin del codice (`resolveWordpressImage`). Così la versione 1, che è immutabile, non invecchia quando una release alza il pin: i siti incorporati seguono il pin come prima di M2.
- `BUILT_IN_WORDPRESS_SPEC` è il risultato del validatore su `BUILT_IN_WORDPRESS_SOURCE`; `packages/policy-engine/test/site-template-built-in.test.ts` li tiene uguali. Le versioni PHP sono letterali nel sorgente e non derivano da `SUPPORTED_PHP_VERSIONS`, perché una versione salvata non cambia.
- **`ensureBuiltInSiteTemplates(db)`** (`packages/database/src/site-templates-repository.ts`) inserisce modello e versione con `ON CONFLICT DO NOTHING` e imposta versione predefinita e `enabled = true` **solo se `default_version_id` è ancora `NULL`**. Non sovrascrive mai ciò che l'amministratore ha cambiato (nome, disabilitazione, nuova versione predefinita). Viene chiamata alla fine di `ensureWordpressTemplate` (`packages/database/src/sites-repository.ts`), cioè a ogni avvio dell'API, perché la chiave esterna di `tpl_site_wordpress` ne ha già bisogno.
- **Un modello creato dall'amministratore nasce disabilitato** (`enabled = false`): va prima provato (§2.9), poi abilitato.

### 2.4 Il sorgente: un sottoinsieme di YAML senza dipendenze

`parseTemplateYaml` (`packages/contracts/src/site-templates/yaml-subset.ts`) è un parser scritto a mano, in TypeScript puro e senza moduli di Node, così lo stesso codice gira nell'editor del browser e nell'API.

- **Perché nessuna dipendenza:** il progetto non ne aggiunge senza approvazione (`HARNESS.md`), un parser YAML completo ha una superficie enorme (ancore, alias, tag, fusioni, documenti multipli: tutte vie per gonfiare un documento o nascondervi cose) e il browser dovrebbe caricarlo. Il sottoinsieme rifiuta tutto ciò che non serve.
- **Non è YAML:** niente ancore, alias, tag, chiavi di fusione (`<<`), blocchi di testo (`|`, `>`), chiavi complesse, direttive, secondi documenti, testo su più righe; tipizzazione minima (solo `null`, booleani e interi sicuri: `8.4`, `yes`, `0123`, `1e3` restano stringhe). Una chiave duplicata è un errore.
- **Limiti:** `TEMPLATE_SOURCE_MAX_BYTES = 65 536` (misurati in byte UTF-8), `YAML_MAX_DEPTH = 16`, `YAML_MAX_NODES = 4096`, `YAML_MAX_KEY_LENGTH = 128`.
- **Non lancia mai:** restituisce `{ok:true, value, locate}` oppure **un solo** errore con `code` (uno dei venticinque `YAML_ERROR_CODES`, per esempio `TAB_INDENT`, `ANCHOR`, `DUPLICATE_KEY`, `TOO_DEEP`), `line` e `column` (1-based). `locate(path, "key"|"value")` dà la posizione di qualunque percorso, e il validatore la usa per posizionare ogni suo errore.

### 2.5 Il validatore: il motore delle regole

`validateSiteTemplateSource(source, module)` (`packages/policy-engine/src/site-template-validation.ts`) parte da un documento YAML e restituisce lo `SiteTemplateSpec` oppure **tutti** i problemi trovati (al massimo `SITE_TEMPLATE_MAX_ISSUES = 50`, ordinati per posizione), ciascuno con `code`, `path`, `line`, `column`. Non lancia e il messaggio non ripete mai il valore di una variabile d'ambiente. **È un elenco ammesso, non un elenco vietato:** ogni chiave non nominata è `KEY_UNKNOWN`, così una funzione di Compose che raggiunge l'host non passa solo perché è stata dimenticata. La radice ammette `x-hp-module`, `x-hp-parameters`, `x-hp-php`, `services`, `volumes`.

Le famiglie di rifiuto:

| Famiglia | Che cosa si rifiuta | Codici |
|---|---|---|
| Sicurezza del contenitore | `privileged`, `cap_add`, `cap_drop`, `devices`, `security_opt`, `sysctls`, `userns_mode`, `pid`, `ipc`, `uts`, `cgroup`, `runtime`, `group_add`, `user`, … | `KEY_FORBIDDEN_SECURITY` |
| Rete | `ports`, `network_mode` (quindi anche la rete dell'host), `networks`, `extra_hosts`, `dns`, `links`, `hostname`, … ; la radice `networks` | `KEY_FORBIDDEN_NETWORK` |
| Accesso all'host | `build`, `container_name`, `env_file`, `secrets`, `configs`, `labels`, `volumes_from`, `tmpfs`, `extends`, `include`, … | `KEY_FORBIDDEN_HOST_ACCESS` |
| Gestito dalla piattaforma | `command`, `entrypoint`, `healthcheck`, `restart`, `logging`, `ulimits`, `mem_limit`, `cpus` del servizio, `deploy.replicas`, `reservations`, … | `KEY_UNSUPPORTED` |
| Un solo servizio | zero servizi o più di uno | `SERVICES_MISSING`, `SERVICES_MULTIPLE` |
| Immagine | repository diverso da quello ammesso del modulo (per WordPress: `wordpress` ufficiale, **senza prefisso di registro**), `latest`, tag che non è un pin a tre componenti (`6.9.1-php8.4-apache`; `php8.4-apache` e `6.9-php8.4-apache` fluttuano), **digest** (fissa una sola variante e non segue la versione scelta), riferimento malformato, variabili diverse dal parametro che sceglie la variante | `IMAGE_*` |
| Volumi | percorsi dell'host e bind (`./x:/y`, `/x:/y`), `docker.sock`, sintassi lunga, modalità diversa da `rw`, nome non dichiarato sotto `volumes`, opzioni di volume (`driver`, `external`, …), duplicati, volume extra (solo il volume obbligatorio del modulo), volume obbligatorio mancante | `VOLUME_*` |
| Porte | solo la porta del sito, una voce, senza mappatura né protocollo | `EXPOSE_INVALID` |
| Limiti | `cpus` e `memory` insieme; **minimi 0,1 CPU e 128 MiB** (quelli di `tpl_site_wordpress`), **tetti** del motore (`MAX_SERVICE_CPU_MILLI` = 64 CPU, `MAX_SERVICE_MEMORY_BYTES` = 64 GiB) | `LIMIT_*` |
| Ambiente | nomi `HP_*`, `LD_*`, `DOCKER_*`, `*_FILE`, `PATH`, `PHPRC`, `PHP_INI_SCAN_DIR`, `PORT`; nomi che sembrano segreti (`*_PASSWORD`, `*_TOKEN`, `*_KEY`, …, per segmenti, quindi `TOKENIZER_MODE` passa); valori che sembrano segreti (chiavi private, `Bearer`, `AKIA…`, `ghp_…`, credenziali in un URL) o che nominano `docker.sock`; caratteri di controllo; una voce senza valore (verrebbe presa dall'host); più di 64 voci | `ENV_*` |
| Interpolazione | `${NAME}` con `NAME` = `[A-Za-z_][A-Za-z0-9_]*`, `$$` per un `$` letterale; ogni altro `$`, i valori predefiniti (`${a:-b}`), l'annidamento: errore; una variabile sconosciuta; `${HP_MODULE_IMAGE}` fuori da `image`; un valore che una volta riempito supera 4096 caratteri nel caso peggiore | `INTERP_*` |
| Parametri | più di 16; chiave non valida o duplicata; tipo fuori da `enum`/`integer`/`string`/`boolean`/`size`; opzioni, limiti e predefinito coerenti col tipo (ogni parametro ha un predefinito); un predefinito `string` o un'opzione `enum` con un contenuto che un valore d'ambiente letterale rifiuta (percorso di `docker.sock`, testo che sembra un segreto: `PARAM_DEFAULT_INVALID`, `PARAM_OPTIONS_INVALID`); un parametro `size` non può essere scelta del cliente; `php_version` obbligatorio per il modulo WordPress e deve essere `enum` visibile al cliente | `PARAM_*`, `PHP_PARAM_*` |
| Impostazioni PHP | `x-hp-php` solo per i moduli che le ammettono; solo le sei chiavi chiuse (§2.8); `post_max_size` non sotto `upload_max_filesize`; `memory_limit` non oltre la memoria del contenitore | `PHP_*` |

**Variabili magiche.** Oltre ai propri parametri un valore d'ambiente può usare `HP_SITE_ID`, `HP_SITE_DOMAIN` e `HP_SITE_URL`. Sono riempite **una sola volta, alla creazione del sito** (e di nuovo se il sito passa a una versione nuova, §2.10): un cambio successivo del dominio principale o del passaggio a HTTPS non riscrive la revisione. `HP_SITE_URL` alla creazione è `http://<dominio>`. Per la stessa ragione l'anteprima e il confronto dell'immagine in Updates usano valori vuoti o di esempio (`SITE_TEMPLATE_PREVIEW_CONTEXT`: `example.com`).

### 2.6 Difesa in profondità: il validatore si riesegue

Il validatore non gira solo al salvataggio. `assertTemplateUsable` (`apps/api/src/sites/site-template-runtime.ts`) lo riesegue sul sorgente **salvato**: quando si abilita un modello o si cambia la sua versione predefinita (`SiteTemplatesService.update`: l'abilitazione ricontrolla la versione predefinita **sotto il blocco del modello**, non su una lettura fatta prima), quando si crea un sito da esso e quando un sito passa a una versione nuova. Il motivo: l'esecutore accetta qualunque stringa di immagine, quindi l'API è l'unica barriera; una politica più severa di una release successiva deve fermare anche le versioni scritte prima, e un sorgente scritto direttamente nel database non deve poter passare. Un rifiuto è `409 RESOURCE_LOCKED` con motivo `template_invalid` (messaggio neutro, senza il testo del problema).

### 2.7 I parametri

`packages/contracts/src/site-templates/spec.ts` e `parameters.ts`:

- **Tipi:** `enum` (con `options`), `integer` (con `min`/`max`), `string` (≤ 256 caratteri, senza caratteri di controllo né `${`: un valore non viene mai interpolato due volte), `boolean`, `size` (`^[1-9][0-9]{0,4}[KMG]$`).
- **Destinatario:** `customer: true` = il cliente lo sceglie alla creazione; `customer: false` = lo imposta solo l'amministratore, e il cliente che lo invia riceve un rifiuto. Al massimo 8 parametri per il cliente (`maxCustomerParameters`).
- **`php_version`** è il parametro speciale che sceglie la variante dell'immagine; il suo valore vive in `sites.php_version`, non in `template_parameters` (`toStoredSiteTemplateParameters` lo esclude) e non si invia dentro `parameters`.
- **Valori che l'esecutore rifiuterebbe.** Il validatore (§2.5) rifiuta al salvataggio un predefinito `string` o un'opzione `enum` che un valore d'ambiente letterale non ammetterebbe; ma il valore scelto alla creazione non si vede prima, quindi anche `renderSiteTemplate` rifiuta un valore finale che l'esecutore rifiuterebbe (`SiteTemplateRenderError`, `code` `unsafe_value`, messaggio che non ripete il valore). Un valore del cliente non può così creare un sito che non si potrebbe mai distribuire: alla creazione è un 400 sul campo `parameters` e nulla resta scritto (§2.9).
- `resolveSiteTemplateParameters(spec, entries, {audience, phpVersion})` non lancia: raccoglie ogni problema come `{field: "parameters.<key>" | "phpVersion", reason, message}` (chiave sconosciuta o duplicata, valore fuori dalle opzioni, tipo sbagliato, parametro riservato all'amministratore), e riempie i predefiniti. `restoreSiteTemplateParameterMap` è la variante indulgente per ricostruire i valori di un sito esistente contro una versione diversa.

### 2.8 Impostazioni PHP: `x-hp-php` → `phpIni`

`PhpSettingsSchema` (`packages/contracts/src/php-settings.ts`) è un oggetto chiuso su sei chiavi (`PHP_SETTING_KEYS`): `upload_max_filesize`, `post_max_size`, `memory_limit`, `max_execution_time`, `max_input_time`, `max_input_vars`. Le dimensioni sono `^[1-9][0-9]{0,4}[KMG]$` in maiuscolo (niente `-1`, `0`, segni, spazi, `MB`); `upload_max_filesize` e `post_max_size` al più 4 GiB, `memory_limit` al più 64 GiB; i tempi da 1 a 3600; `max_input_vars` da 100 a 100 000. `disable_functions`, `open_basedir` e ogni altra direttiva sono rifiutate.

**Il trasporto**, in quattro punti dove la chiave poteva perdersi in silenzio (gli oggetti zod scartano le chiavi ignote e l'adattatore ricostruisce lo spec campo per campo):

1. il renderer scrive `configuration.phpIni` **solo** se il modello ha `x-hp-php` (altrimenti la chiave non esiste, né `null` né `{}`) e la revisione la salva in `declarative_config` (quindi è coperta da `spec_hash`);
2. `apps/api/src/runtime/service-spec.ts` la passa a `createApprovedServiceSpec` (`phpIni` è in `STRUCTURED_CONFIG_KEYS`: non diventa mai una variabile d'ambiente). Un valore salvato che non è più valido dà `VALIDATION_ERROR` «The saved PHP settings are not valid.»: un deploy non perde in silenzio i limiti scelti;
3. `ApprovedServiceSpec.phpIni` (`packages/executor-contracts/src/spec.ts`) e lo schema IPC `ApprovedServiceSpecWireSchema.phpIni` (`packages/contracts/src/ipc-schemas.ts`);
4. l'esecutore ricostruisce lo spec in `apps/docker-executor/src/docker-engine-adapter.ts` e `server.ts`.

**Che cosa fa l'esecutore** (`apps/docker-executor/src/site-php.ts`): `renderPhpIni` riconvalida con `PhpSettingsSchema` e scrive un'intestazione più una riga `chiave = valore` per impostazione, in ordine; `writeSitePhpIni` scrive `/var/lib/hosting-panel/site-php/<serviceInstanceId>.ini` con file temporaneo più rinomina (un collegamento simbolico piantato sul percorso viene sostituito, mai seguito), modo `0644` perché il PHP del sito lo deve leggere; `sitePhpBinds` dà **una sola** voce, il file di quel servizio, montata **in sola lettura** su `/usr/local/etc/php/conf.d/zz-hp-site.ini` (viene dopo `zz-hp-mail.ini`; i due non impostano le stesse chiavi). Altre voci o un'altra modalità danno `HOST_POLICY_DENIED`; la verifica delle modifiche fuori banda ammette solo il bind del servizio stesso. Il file si rimuove con il servizio; un file rimasto dopo un redeploy senza `phpIni` non è montato, quindi innocuo. **`phpIni` assente = deploy identico a prima**: l'esecutore non legge, scrive né monta nulla. La directory è creata da `bootstrap-dedicated.sh` (`install -d -m 0755 -o hp-executor -g hp-executor /var/lib/hosting-panel/site-php`); non c'è una variabile d'ambiente nuova (`DEFAULT_SITE_PHP_DIR`, opzione `sitePhpDir` dell'adattatore per i test). Il simulatore espone `phpIniByService`. **I lavori WP-CLI non leggono questo file** (sono contenitori a parte): un limite PHP vale per il sito, non per i comandi lanciati dal pannello.

### 2.9 Le route

Tutte le route dell'amministratore chiamano per prima `requireServerAdmin(…)` (permesso `platform.users.manage`), prima di leggere il corpo e prima del 404; le scritture sono nella stessa transazione della riga di audit.

**Catalogo (`apps/api/src/controllers/admin-site-templates.controller.ts`, `SiteTemplatesService` in `apps/api/src/site-templates/site-templates.service.ts`):**

| Route | Effetto | Audit |
|---|---|---|
| `GET /v1/admin/site-templates` | elenco (con i moduli e le loro versioni PHP, versione predefinita, siti per versione) | — |
| `POST /v1/admin/site-templates/validate` | 200 con `valid`, errori con riga/colonna/percorso/codice, e `preview` (costruita dagli array dello spec, mai dalla `configuration`); non scrive nulla | — |
| `POST /v1/admin/site-templates` | 201, crea modello **disabilitato** con versione 1 predefinita; sorgente non valido → 400 con i dettagli | `admin.site_template.create` |
| `GET /v1/admin/site-templates/:templateId` | dettaglio, versioni dalla più nuova | — |
| `GET /v1/admin/site-templates/:templateId/versions/:versionId` | una versione con il `source` | — |
| `POST /v1/admin/site-templates/:templateId/versions` | 201 con `created`; `makeDefault` predefinito `true`; un sorgente identico all'ultima versione non crea nulla (`created: false`, nessun audit) | `admin.site_template.version` |
| `PATCH /v1/admin/site-templates/:templateId` | nome, descrizione, `enabled`, `defaultVersionId`; nessun cambiamento non scrive audit | `admin.site_template.update` (con `changes`) |
| `DELETE /v1/admin/site-templates/:templateId` | archivia (non cancella): il modello si disabilita, i siti esistenti tengono la loro versione; **idempotente**: su un modello già archiviato non cambia nulla e non scrive audit | `admin.site_template.archive` (una sola volta) |

Rifiuti (motivi in `details[0].reason`): `name_taken` (409 `ALREADY_EXISTS`, nome già usato senza distinguere maiuscole), `built_in` (409, il modello incorporato non si archivia), `template_archived` (409 `RESOURCE_LOCKED`, un modello archiviato non si modifica), `template_invalid` (§2.6), `unknown_version` (400, versione predefinita di un altro modello), `module_mismatch`.

**Cliente — `GET /v1/organizations/:orgId/site-types`** (`site-types.controller.ts`, permesso `site.create` sull'organizzazione): i modelli abilitati e non archiviati, con il modulo, le versioni PHP, la `defaultPhpVersion` e **solo i parametri `customer: true`** (senza `php_version`). Non restituisce mai `source`, immagine né limiti. Il modello incorporato viene per primo, poi per nome.

**Creazione del sito** (`POST /v1/organizations/:orgId/managed-sites` e `POST /v1/admin/sites`): i campi nuovi sono `templateId?`, `parameters?: [{key, value}]` e `phpVersion?` (ora opzionale, senza valore predefinito). L'ordine dei controlli in `ManagedSitesService.create` è: ripetizione dell'`Idempotency-Key`, **modello e parametri** (`loadTemplateForCreate`, `assertTemplateUsable`, `resolveCreateParameters`), dominio e server, poi la transazione con il limite di siti (ADR-0034): un modello non disponibile dà il suo `404` anche a chi ha esaurito il limite. Un modello sconosciuto, non abilitato (per il cliente) o archiviato dà sempre la stessa risposta `404 NOT_FOUND` con motivo `template_unavailable`, indistinguibile. **Senza `templateId`** entrambi i destinatari prendono il modello incorporato: se l'amministratore l'ha disabilitato, la creazione senza `templateId` dà `404 template_unavailable`; la disabilitazione non si aggira. L'**amministratore** che nomina un modello disabilitato (non archiviato) può usarlo e può impostare i parametri `customer: false`: serve a provare un modello nuovo (nasce disabilitato) prima di offrirlo. Il rendering avviene dentro la transazione (`renderSiteTemplate`) e `SiteTemplateRenderError` è un rifiuto 400 sul campo `parameters` (motivo = `code` dell'errore), non un 500. La ripetizione della stessa chiave dopo la disabilitazione del modello restituisce la risposta originale.

**Cambio di versione PHP** (`ManagedSitesService.changeRuntime`): l'immagine si ricava dal modello del sito (`#imageFor`); un sito storico (`NULL`) usa `type.image(phpVersion)` come prima. Una versione fuori dalle opzioni → 400 sul campo `phpVersion`. Non esiste un motivo «versione PHP fissa»: il validatore impone `php_version` con `customer: true` e le versioni sono immutabili, quindi il caso non può darsi (se il validatore venisse allentato, il controllo va ripristinato). La nuova revisione è `{...precedente, image}`: variabili, limiti e `phpIni` restano.

**Passaggio a una versione più nuova — `POST /v1/admin/sites/:siteId/template-version`** (`admin-sites.controller.ts`, `Idempotency-Key` obbligatoria, corpo `{versionId}`): `ManagedSitesService.changeTemplateVersion` riesegue il rendering **completo** della versione scelta con i parametri salvati (vedi sotto per quali), scrive una revisione nuova (gli extra aggiunti a mano con le route generiche dei servizi non si portano; le `secretRefs` della revisione in esecuzione restano), aggiorna `template_version_id` e `template_parameters` e accoda un `service.deploy`. Un sito storico conta come versione 1 del modello incorporato. **L'ordine conta:** per prima viene la **ripetizione dell'`Idempotency-Key`** (`#deployReplay`: un'operazione `service.deploy` dello stesso servizio già accettata con quella chiave), che restituisce l'operazione originale *prima* di ogni rifiuto: nell'ordine del progetto un nuovo tentativo dopo un successo trovava il sito già sulla versione e riceveva `already_current` (400). Una chiave già legata a un'altra operazione o a un altro servizio arriva all'accodamento e dà `IDEMPOTENCY_CONFLICT` (409). Poi i rifiuti, tutti `VALIDATION_ERROR` 400 salvo dove indicato: `stopped` (senza campo: avviare prima il sito), versione sconosciuta (404 con `unknown_version` sul campo `versionId`), `other_template`, `already_current`, `not_newer` (sul campo `versionId`), `template_archived` (409 `RESOURCE_LOCKED`), `template_invalid` (409, §2.6), poi un valore salvato che la versione nuova non accetta più, per esempio un'opzione tolta da un `enum` (sul campo `parameters.<chiave>`, nessuna revisione scritta). **I valori portati.** Ogni valore salvato passa alla versione nuova, con una sola eccezione: il valore salvato di un parametro riservato all'amministratore (`customer: false`) **uguale al predefinito della versione VECCHIA** segue il predefinito della versione NUOVA. Un valore mai cambiato non resta così fermo al vecchio predefinito (un limite alzato dalla versione nuova arriva anche ai siti che non lo avevano toccato); un valore scelto dal cliente (`customer: true`) non è distinguibile da un predefinito e si porta sempre, come ogni valore diverso dal vecchio predefinito. Una chiave salvata che la versione nuova non dichiara viene scartata; il caso «parametro nuovo senza predefinito» non esiste perché il validatore pretende un predefinito per ogni parametro (`PARAM_DEFAULT_MISSING`). **Solo versioni più nuove dello stesso modello, nessun ritorno indietro**: tornare indietro richiederebbe la stessa verifica dei parametri in senso inverso e non è stato chiesto. Audit `admin.site.template_version` con `templateId`, `fromVersionId`, `toVersionId`, `fromVersionNumber`, `toVersionNumber` e l'id dell'operazione, scritto nella stessa transazione dell'operazione, solo se non è una ripetizione.

**Elenco dei siti dell'amministratore** (`GET /v1/admin/sites`): ogni sito gestito porta `template` (`AdminSiteTemplateRefDto`: modello, versione in uso, versione predefinita attuale); un sito storico compare come `stpl_wordpress`, versione 1.

**Updates.** La deriva (`UpdatesService.#sitesBehind`) confronta l'immagine della revisione in esecuzione con l'immagine che la versione di modello *del sito* produce oggi: per un sito con `template_version_id` è `expectedTemplateImage(spec, sito)` (rendering con i parametri salvati e la versione PHP del sito; lo spec si legge una volta per versione distinta con `getSiteTemplateVersionById` e `readSiteTemplateSpec`); per un sito storico (`NULL`) resta l'espressione di prima, `type.image(phpVersion)`. Un sito su un modello incorporato segue quindi il pin del codice come prima; un modello con tag letterale è «aggiornato» finché la revisione porta quel tag e cambia solo con una versione nuova. **Una versione che non si può leggere** (riga mancante o spec corrotto: solo la lettura dello spec è in `try/catch`, un errore del database non diventa «niente è indietro») **o rendere non è mai «indietro»**: il pannello non propone un redeploy che non saprebbe costruire. L'immagine di arrivo (`toImage`) viaggia sulla riga «indietro», così il filtro, `updateSiteImage` e l'audit `admin.update.site_image` (`fromImage`/`toImage`) usano un solo valore; `updates()` la toglie dalla risposta. Se il sito non è indietro l'aggiornamento dell'immagine dà `already_current` (400) e non scrive nulla. `UpdatesDto` non cambia.

### 2.10 Il web

- **Amministratore**, sotto `/admin/templates` (voce «Modelli» nel menu): elenco (`site-template-list.tsx`), dettaglio con le versioni e i siti per versione (`site-template-detail.tsx`), pagine `new` ed `edit`. L'**editor** (`site-template-editor.tsx`, con `code-editor.tsx`, senza dipendenze, con numeri di riga e marcatori d'errore) dà un riscontro immediato sulla sintassi con lo stesso `parseTemplateYaml` del server, poi **Verifica** (`POST …/validate`: errori con riga e colonna, anteprima del servizio generato) e **Salva** (crea il modello o aggiunge la versione). Un risultato descrive il sorgente per cui è stato fatto: ogni modifica lo scarta, così non si vede mai un'anteprima vecchia. Le azioni passano dalle route BFF `apps/web/src/app/api/admin/site-templates/**` (CSRF e Origin come le altre).
- **Siti dell'amministratore** (`sites-table.tsx`, `upgrade-site-template-dialog.tsx`): mostra la versione del modello di ogni sito e, se ce n'è una più nuova, la finestra per spostarlo (`POST …/template-version` dal BFF).
- **Cliente**, `/sites/new`: la pagina legge `GET …/site-types`. **La scelta del tipo (`site-type-chooser.tsx`) compare solo con più di un tipo**; con uno solo il modulo è quello di prima. Il modulo (`site-form.tsx`) mostra i parametri `customer: true` del tipo scelto e invia `templateId` e `parameters` (nome e descrizione del tipo sono parole dell'amministratore, mostrate così come sono).
- I testi sono in `apps/web/src/i18n/it.ts` ed `en.ts`; quelli rivolti al cliente dicono «tipo di sito», mai «modello» (test `ui-copy`).

### 2.11 Il gate di downgrade `site-templates`

`RELEASE_FEATURES` (`infra/release/build-release.mjs`) è ora `["manual-tls", "backup-targets", "site-templates"]`; `RELEASE.json` di una release che non conosce i modelli non elenca `site-templates`. `panel_features_in_use` (`infra/linux/lib/common.sh`) chiede al database se, **applicata la migrazione `0024_site_templates.sql`**, esiste un sito con `template_version_id` non `NULL` e diverso da `stv_wordpress_1`: solo allora il gate è «in uso». I siti storici (`NULL`) e quelli sul modello incorporato versione 1 non lo attivano, perché una release precedente li gestisce. Un errore di `psql` conta come rifiuto (chiuso per difetto, come per gli altri gate). `hp-update --version <precedente> --allow-downgrade` con il gate in uso termina con **codice 8**; `--allow-feature-loss` lo supera (i dati restano irraggiungibili finché non si aggiorna di nuovo). Il gate scatta per un sito su un modello personalizzato e anche per uno su una versione del modello incorporato diversa dalla 1. Per scendere senza forzare bisogna eliminare quei siti o ricrearli sulla versione 1 del modello incorporato (un sito si sposta solo a una versione più nuova del proprio modello, mai a un altro modello né indietro), oppure tenere la release corrente; il testo del rifiuto di `hp-update` (`infra/linux/update.sh`) dice proprio questo e nomina `--allow-feature-loss`. Il rollback automatico resta incondizionato (§2.2). Il runbook è `docs/runbooks/tls-and-backup-targets.md`, §10.

## 3. Alternative scartate

- **Usare YAML completo con una libreria:** nuova dipendenza non approvata e superficie troppo ampia (§2.4); il sottoinsieme basta per un servizio con ambiente, un volume e dei limiti.
- **Un elenco di funzioni vietate invece di uno ammesso:** ogni funzione di Compose dimenticata sarebbe una via verso l'host. Con l'elenco ammesso la dimenticanza è un rifiuto.
- **Ammettere un digest nell'immagine:** fissa una sola variante e non segue il parametro `php_version`; il pin a tre componenti è già riproducibile.
- **Rendere la versione 1 incorporata con l'immagine scritta nel sorgente:** diventerebbe vecchia a ogni aggiornamento del pin e, essendo immutabile, non si potrebbe correggere. `${HP_MODULE_IMAGE}` la tiene allineata.
- **Un nuovo `ErrorCode` per i modelli:** i motivi (`template_unavailable`, `name_taken`, …) stanno nei dettagli, come in ADR-0034; gli elenchi pinned dei codici non cambiano.
- **Ammettere ai clienti i modelli disabilitati, o all'amministratore la creazione senza `templateId` con il modello incorporato disabilitato:** la disabilitazione sarebbe aggirabile. Il caso dell'amministratore che nomina un modello disabilitato è invece voluto (§2.9): senza, un modello nuovo non si potrebbe provare prima di offrirlo.
- **Una variabile d'ambiente per la directory delle impostazioni PHP:** `HARNESS.md` vieta variabili non approvate; basta una costante e l'opzione dell'adattatore.
- **Passare le impostazioni PHP come variabili d'ambiente:** l'immagine ufficiale non le legge e finirebbero in `declarative_config` come ambiente; un file `.ini` montato in sola lettura è il modo normale e non lascia scrivere al sito la propria configurazione.
- **Permettere il ritorno a una versione più vecchia:** non richiesto; è una modifica di una riga (il caso `<`) più lo stesso controllo dei parametri, ma amplia i casi da provare.
- **Un modello a più servizi:** fuori da questa versione (`SERVICES_MULTIPLE`).

## 4. Limiti noti

1. **Solo il modulo WordPress.** Esiste una sola chiave in `SITE_TYPE_KEYS`: un modello oggi è una variante di WordPress (immagine ufficiale, volume `html`, porta 80, versioni PHP 8.3–8.5). Il modello dei dati e il validatore sono già per modulo; aggiungerne uno richiede fatti nuovi in `SITE_TEMPLATE_MODULES` e una voce in `SITE_TEMPLATE_POLICIES`.
2. **Un solo servizio, nessun segreto.** `secretRefs` della revisione renderizzata è sempre vuoto: un modello non può portare segreti (i nomi e i valori che li sembrano sono rifiutati). La password del database e quella dell'amministratore restano quelle create dal pannello.
3. **Le variabili magiche si fissano alla creazione** (§2.5). `HP_SITE_URL` parte da `http://<dominio>`; un cambio di dominio principale o il passaggio a HTTPS non riscrive la revisione fino al prossimo cambio di versione del modello.
4. **Il passaggio di versione sostituisce l'intera configurazione.** Variabili o limiti aggiunti a mano con le route generiche dei servizi su quel sito non si portano nella versione nuova.
5. **Solo avanti.** Non si torna a una versione più vecchia (§2.9); per farlo si aggiunge una versione nuova con lo stesso contenuto.
6. **Archiviare un modello non tocca i siti:** restano sulla loro versione e funzionano, ma non si possono spostare a un'altra versione dello stesso modello (`template_archived`).
7. **L'ultima parola sulla deriva è dell'immagine.** Un modello con tag letterale non compare mai in Updates, anche se esiste un tag più recente; lo cambia l'amministratore con una versione nuova.
8. **I lavori WP-CLI non leggono il file `.ini` del sito** (§2.8).
9. **Il file `.ini` di un servizio resta sul disco** dopo un redeploy senza `phpIni` finché il servizio non viene eliminato; non è montato, quindi non ha effetto.
10. **Il downgrade chiede un passo manuale** per i siti su versioni personalizzate (§2.11); sul modello incorporato non serve nulla.
11. **Un sito senza `php_version` nel modello** ha `sites.php_version = NULL`: il cambio di versione PHP non si applica a lui.
12. **Nome e descrizione di un tipo sono testo dell'amministratore** e il cliente li vede così come sono; non sono passati da un filtro di contenuto.
13. **Revisione del proprietario in attesa** (§8).

## 5. Divergenze dal progetto

La decisione nasce dalla richiesta del proprietario; non c'è una specifica numerata. Le differenze dal progetto dello sciame (`design/*`) sono:

| Punto del progetto | Questo ADR | Motivo |
|---|---|---|
| immagine «fissata da tag o digest» | solo tag a tre componenti; il digest è rifiutato (`IMAGE_DIGEST_NOT_ALLOWED`) | un digest non segue il parametro `php_version` (§3) |
| `line`, `column` e `path` degli errori come campi opzionali | nullable nel DTO (`SiteTemplateIssueDto`); il web tratta `null` e assente allo stesso modo | decisione del capo, per tenere la forma del DTO costante |
| il passaggio di versione controlla `already_current`/`not_newer` prima dell'accodamento | la ripetizione dell'`Idempotency-Key` precede ogni rifiuto (`#deployReplay`) | nell'ordine del progetto un nuovo tentativo dopo un successo riceveva 400 `already_current` invece dell'operazione originale |
| motivo `php_version_fixed` per il cambio di versione PHP | rimosso | irraggiungibile: il validatore impone `php_version` con `customer: true` e le versioni sono immutabili (§2.9) |
| `updateSiteImage` ricalcola l'immagine di arrivo | `toImage` viaggia sulla riga «indietro» di `#sitesBehind` | un solo valore per filtro, aggiornamento e audit (§2.9) |
| il modello incorporato viene inserito dall'avvio in `create-app.ts` | `ensureBuiltInSiteTemplates` è chiamata alla fine di `ensureWordpressTemplate` | i test con client iniettato hanno già bisogno di `ensureWordpressTemplate` (chiave esterna di `tpl_site_wordpress`) |
| il fixture `customSource` ha un solo `upload_max_filesize` | ne ha due (`upload_max_filesize` 64M e `post_max_size` 128M) | il validatore rifiuta `post_max_size` sotto `upload_max_filesize` (`PHP_POST_BELOW_UPLOAD`) |

## 6. Minacce

| Minaccia | Contromisura | Dove |
|---|---|---|
| L'amministratore (o un account rubato) porta un contenitore privilegiato, un bind dell'host o `docker.sock` | elenco ammesso di chiavi; volumi solo con nome e dichiarati; il validatore si riesegue alla creazione | §2.5, §2.6 |
| Un'immagine di un altro registro o una che finge di essere ufficiale | repository esatto senza registro, tag a tre componenti | §2.5 |
| Risorse oltre l'host o sotto il minimo | tetti del motore e minimi 0,1 CPU / 128 MiB | §2.5 |
| Segreti scritti in chiaro nel modello e nelle revisioni | nomi e valori che li sembrano rifiutati; `secretRefs` sempre vuoto; l'audit non contiene il sorgente | §2.5, §2.2 |
| Iniezione tramite interpolazione (`${…}` annidato, secondo passaggio) | grammatica chiusa, un solo passaggio, i valori dei parametri non possono contenere `${` | §2.5, §2.7 |
| Un cliente sceglie un modello non offerto o un parametro riservato | modello disabilitato/archiviato = `404` identico; `customer: false` rifiutato | §2.9 |
| Un cliente o un non amministratore usa le route dei modelli | `requireServerAdmin` per primo; i non amministratori ricevono 403 prima che il corpo sia letto | §2.9 |
| Impostazioni PHP pericolose (`disable_functions`, `open_basedir`, …) | sei chiavi chiuse, valori con modello fisso, file montato in sola lettura, bind unico | §2.8 |
| Un collegamento simbolico piantato sul percorso del file `.ini` | scrittura con file temporaneo e rinomina | §2.8 |
| Documento enorme o profondo (consumo di CPU/memoria) | 64 KiB, profondità 16, 4096 nodi, chiavi di 128 caratteri | §2.4 |
| Una versione cambiata sotto i siti | versioni immutabili (trigger e `ON DELETE RESTRICT`) | §2.2 |
| Release precedente che non sa leggere un modello | gate `site-templates` (exit 8) | §2.11 |
| Disabilitazione del modello incorporato aggirata | senza `templateId` valgono le stesse regole per tutti | §2.9 |

## 7. Verifica

Test automatici (i numeri non sono riportati: i file sono il riferimento).

- **Contratti** — `packages/contracts/test/site-template-yaml.test.ts` (parser, limiti, ogni codice d'errore), `site-template-spec.test.ts`, `site-template-parameters.test.ts`, `site-template-render.test.ts` (rendering, ordine, variabili magiche, anteprima), `site-template-dto.test.ts`, `site-template-modules.test.ts`, `php-settings.test.ts`, `ipc-php-ini.test.ts`, `site-create-input.test.ts` (`phpVersion` opzionale senza predefinito, `templateId`, `parameters`), `site-template-yaml-adversarial.test.ts`, `site-template-render-adversarial.test.ts`.
- **Motore delle regole** — `packages/policy-engine/test/site-template-validation.test.ts`, `site-template-security.test.ts` (i tentativi di uscire dal contenitore e dall'host, uno per famiglia di §2.5), `site-template-env.test.ts`, `site-template-interpolation.test.ts`, `site-template-policies.test.ts`, `image-reference.test.ts`, `site-template-built-in.test.ts` (sorgente e spec del modello incorporato uguali), `site-template-bypass.test.ts` (i tentativi di aggirare il validatore).
- **Database** — `packages/database/test/site-templates-database.test.ts` (migrazione `0024`, vincoli, trigger di immutabilità, rollback), `site-templates-repository.test.ts` (creazione, versioni, modello incorporato che non sovrascrive l'amministratore, archiviazione), `site-templates-invariants.test.ts` (invarianti sotto concorrenza); la migrazione è negli elenchi di `phase2-database.test.ts` e `site-sftp-users-database.test.ts`.
- **Esecutore** — `executor-contracts/test/spec-php-ini.test.ts`, `apps/docker-executor/test/site-php.test.ts` (ordine, rifiuto di valori con riga nuova, `;`, `"`, collegamento simbolico sostituito, bind unico), `site-php-wiring.test.ts` (deploy con e senza `phpIni`, redeploy senza, rimozione, deriva fuori banda), `site-php-adversarial.test.ts` (iniezione e percorsi ostili).
- **API** — `apps/api/test/service-spec-php-ini.test.ts`, `site-template-runtime.test.ts`, `site-template-render-pin.test.ts` (**il WordPress incorporato produce lo spec byte per byte** dei pin di ADR-0029; vedi anche `site-type-pins.test.ts`), `site-templates.integration.test.ts` (le otto route del catalogo, i permessi, l'audit senza sorgente, la route del cliente), `site-template-upgrade.integration.test.ts` (il passaggio di versione), `admin-updates-templates.integration.test.ts` (deriva per modello), `site-templates-sites.integration.test.ts` (creazione da modello e ordine dei controlli, cambio di versione PHP, elenco dei siti dell'amministratore), `openapi-routes.test.ts` (ogni route dei controller è nell'OpenAPI, `docs/api/openapi.yaml`, e viceversa); toccati `admin-route-guard.integration.test.ts` e `managed-sites.integration.test.ts`.
- **Web** — `apps/web/test/admin-site-templates.test.ts`, `admin-site-template-editor.test.ts`, `code-editor.test.ts`, `admin-site-upgrade.test.ts`, `create-site.test.ts` (la scelta compare solo con più di un tipo), `site-templates-bff.test.ts`; `ui-copy.test.ts` resta verde.
- **Infra** — `infra/linux/features-gate.test.ts` (il gate in uso, assente, errore di `psql`), `infra/release/release-manifest.test.ts` (`RELEASE_FEATURES`); `bootstrap-dedicated.sh` crea la directory (asserito in `site-php.test.ts`).

Commit principali: `99a3f75`, `d6adf09`, `4cd9b53`, `8f5230c`, `3bad35d` (contratti, schema, validatore di base), `387b80a`, `6f73672`, `2948e02`, `2e8a1f4` (validatore, esecutore), `66445ab` (gate), `53eab13` (BFF), `54e6a41` (repository), `2f5347f`, `df87cf2`, `1fd16c5` (esecutore, infra, spec), `090db7e`, `40b1ee5`, `507b061`, `4e24e13`, `7fde82a` (web), `51a4478` (route del catalogo e del cliente). Ultima fase: `eb4f670` (creazione da modello, cambio di versione PHP, elenco dei siti e `changeTemplateVersion`), `de78e95` (route del passaggio di versione), `09fd03d` (Updates per modello), `80ba999` (OpenAPI), `08b57f2` (la prova di tutte le route contro l'OpenAPI e la guardia delle route dei modelli). Prove avverse: `2b07e9d` (contratti), `4742fb1` (validatore), `27434eb` (database), `a2023f8` (esecutore).

## 8. Come costruito: voci aperte

**Revisione del proprietario: in attesa.** Lo stato `APPROVATO` descrive il codice consegnato (M2–M4), non un'approvazione del proprietario. Decisioni che il proprietario può rivedere: il modello nasce disabilitato (§2.3); l'amministratore può creare da un modello disabilitato (§2.9); solo versioni più nuove (§2.9); le variabili magiche si fissano alla creazione (§2.5); il digest è rifiutato (§2.5); il gate scatta solo per versioni diverse da `stv_wordpress_1` (§2.11); un secondo modulo e più servizi per modello restano fuori (§4). Il messaggio exit 8 di `infra/linux/update.sh` non promette più uno spostamento che nessuna route offre: dice di eliminare o ricreare quei siti sulla versione 1 del modello incorporato (§2.11).
