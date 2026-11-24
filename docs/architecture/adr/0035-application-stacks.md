# ADR 0035 — Stack Applicativi e Catalogo dei Modelli di Applicazione

- **Stato:** `APPROVATO` — decisioni D1–D12 approvate dal proprietario il 2026-11-22; costruito dallo sciame swarm-1122-002730
- **Data:** 2026-11-22
- **Riferimento:** HCP-SPEC-005 (stack applicativi, catalogo dei modelli, deploy dichiarativi, 2026-11-22; da non confondere con la vecchia sigla HCP-SPEC-005 di `docs/architecture/adr/0014-zero-sock-traefik-file-provider-ingress.md`), `ADR-0033` (modelli di sito), `ADR-0034` (limite per cliente), `ADR-0014` (Traefik a file), `ADR-0015` (segreti); issue #36, PR in bozza #37
- **Migrazioni:** `0025` (additiva; file `packages/database/migrations/0025_app_stacks.sql`)

Questo ADR introduce un prodotto nuovo, «Applicazioni / Stack». L'amministratore del server pubblica **modelli di applicazione** scritti in un formato proprio e limitato (`HCP-STACK/v1`, da uno a otto servizi); un cliente installa da un modello pubblicato uno **stack** sulla propria allocazione Dedicated. Il primo rilascio è volutamente stretto: solo immagini (nessuna build), solo Dedicated, solo ingresso HTTP, TLS solo ACME per i domini degli stack. I quattro capability flag `applicationTemplatesAvailable`, `applicationStacksAvailable`, `stackPublicPortsAvailable` e `gitBuildsAvailable` restano `false` su ogni backend: nulla viene offerto ai clienti finché il proprietario non li accende (gate W6). Il resto è dietro i gate del proprietario (§8.1).

**Che cosa descrive.** Questo ADR descrive ciò che è stato costruito sul ramo `feat/apps-application-stacks-and-template-catalog` (issue #36, PR in bozza #37) fino al commit `ac35ac4` (le riparazioni del secondo giro di revisione sono `6d7ec4a`, mascheramento lineare dei log, e `ac35ac4`, aggiornamento delle sole route: §2.8), più le due riparazioni chieste dal terzo e ultimo giro (`fix16-refresh-recovery` e `fix16-log-frames`, rilievi S5-M9 e S5-M10). Queste due sono fatte e provate dai loro test, ma nessun quarto giro di revisione le ha rilette (§4, limiti 27 e 28). Le divergenze dalla specifica decise durante la costruzione sono in §5, i limiti in §4, i fatti misurati in §8.3, i risultati prova per prova in `docs/security/hcp-spec-005-acceptance-report.md` e i rilievi delle revisioni in `docs/security/audit-report.md`. Ogni percorso del repository fra apici inversi esiste nel ramo.

## 1. Contesto

Oggi un sito gestito è WordPress con un solo servizio (ADR-0029, ADR-0033). I modelli di sito di ADR-0033 rifiutano di proposito più servizi, `depends_on`, `healthcheck` e `command` (`packages/policy-engine/src/site-template-validation.ts`: `SERVICES_MULTIPLE`, `KEY_UNSUPPORTED`): un modello di sito è una variante di WordPress, non un'applicazione qualunque.

Il proprietario chiede un catalogo generale: una ricetta con parametri, come gli «Egg», e l'esperienza di deploy di un PaaS self-hosted (modello, servizi, domini, variabili, archivio, deploy, log, stato). Il vincolo è che nessuno riceva Compose arbitrario né il socket Docker: né il cliente, né l'API, né Traefik.

I vincoli che l'ADR rispetta:

- `HARNESS.md`: solo `hp-docker-executor` parla con Docker; nessuna dipendenza npm, programma dell'host o variabile d'ambiente nuova; il file `infra/linux/nftables-dedicated.conf` è fissato per SHA e non si modifica.
- Clean-room (§0.1 della specifica): nulla è copiato da Pelican, Pelican Eggs, Coolify, Pterodactyl o cataloghi di terzi; i modelli iniziali sono scritti da zero.
- Additività (§20 della specifica): `site_templates` v1, `SITE_TYPE_KEYS = ["wordpress"]`, i pin di WordPress, i file Traefik `site_*.yml` e `hp-panel.yml`, TLS e backup restano identici byte per byte. Le risorse delle applicazioni sono una famiglia parallela, mai `sites.site_type = 'application'`.

## 2. Decisioni

### 2.1 Siti e stack: due famiglie parallele

Le applicazioni hanno tabelle proprie con prefisso `app_` (D1, §2.15). Non esiste un tipo di sito `application` e `SITE_TYPE_KEYS` resta `["wordpress"]`. Il motivo è triplo: il rollback automatico di `hp-update` deve poter tornare a una release che non conosce gli stack senza leggere righe che non capisce; i pin di WordPress (`apps/api/test/site-type-pins.test.ts`) non devono cambiare; il codice dei siti è saldato a un solo servizio (`stack_revisions`, `encrypted_secrets`, `domains` con `site_id NOT NULL`) e piegarlo a più componenti toccherebbe ogni percorso dei siti.

Si riusano le primitive che già esistono, senza cambiarne la semantica: il parser di ADR-0033 (`packages/contracts/src/site-templates/yaml-subset.ts`), lo scanner dell'interpolazione (`packages/policy-engine/src/site-template-interpolation.ts`), l'autorizzazione, la cifratura AES-256-GCM, l'outbox, l'esecutore e la sua IPC firmata, il proxy Traefik a file e l'audit. I piccoli helper privati del validatore dei siti sono copiati nei file nuovi con un test che ne controlla la deriva, non estratti (decisione del capo L1): così il codice dei modelli di sito non cambia di una riga.

Nei dati e nelle API le due famiglie restano separate; nelle console sono una sola cosa, le **applicazioni** (§2.16): l'amministratore ha un solo elenco «Modelli» con i due tipi e una sola voce «Applicazioni»; il cliente ha un solo elenco `/apps` e una sola pagina di creazione `/apps/new`, dove gli stack compaiono solo con `applicationStacksAvailable` vero.

### 2.2 Il modello delle risorse (migrazione `0025`)

Una sola migrazione additiva, `packages/database/migrations/0025_app_stacks.sql`, con lo schema Drizzle gemello in `packages/database/src/schema.ts`. Crea dieci tabelle: le nove della specifica (§5) senza `app_stack_port_allocations`, più `app_stack_secrets`.

- **`app_templates`**: il catalogo. `id` (`atpl_…`), `slug` unico (`^[a-z][a-z0-9-]{1,47}$`, scelto dall'amministratore), `name`, `description` (≤ 500), `category` (CHECK `^[a-z][a-z0-9-]{0,31}$`, uguale a `APP_TEMPLATE_CATEGORY_PATTERN` dei contratti per decisione del capo), `built_in`, `enabled`, `default_version_id`, `archived_at`. Bozza, pubblicato e archiviato si ricavano da queste colonne come per `site_templates`; si installa, e si aggiorna verso, soltanto la versione predefinita di un modello abilitato e non archiviato.
- **`app_template_versions`**: `id` (`atv_…`), `version_number`, `source` (il testo dell'amministratore), `spec_version = 1`, `compiled_schema` (lo spec tipizzato, senza segreti), `spec_hash`. Immutabili come le versioni di 0024.
- **`app_stacks`**: `id` (`stk_…`), organizzazione, allocazione, modello e versione, nome, revisione desiderata e applicata, `resource_quota_id`, `applied_routes_hash`, `idempotency_key` e `request_hash`. Lo stato è **memorizzato** (CHECK su quattordici valori) e cambia solo attraverso `canTransitionAppStack` (`packages/contracts/src/app-templates/stack-status.ts`); `deleted_at` è valorizzato se e solo se lo stato è `deleted`.
- **`app_stack_parameters`**: i valori pubblici, chiave `(stack_id, parameter_key)`. Mai un segreto.
- **`app_stack_secrets`**: una riga immutabile per `(stack_id, parameter_key, version)`, cifrata (§2.6).
- **`app_stack_revisions`**: `id` (`srev_…`), `revision_number`, `plan` (l'intero `ApprovedStackPlan`, ≤ 262 144 byte), `plan_hash`, la versione del modello, i totali `component_count`, `cpu_milli`, `memory_bytes` e, per decisione del capo, `parameters` (JSONB, i soli valori pubblici con cui la revisione è stata compilata, ordinati). Ogni `UPDATE` è rifiutato; un `DELETE` avviene solo a cascata. Non c'è `UNIQUE(stack_id, plan_hash)`, perché una rollback riusa un hash.
- **`app_stack_components`** e **`app_stack_volumes`**: chiave `(stack_id, component_key)` e `(stack_id, volume_key)`; i componenti portano `health` e `health_observed_at`, i volumi `retention_policy` (predefinito `retain`) e uno stato.
- **`app_stack_domains`**: `id` (`sdom_…`), hostname, la coppia `(component_key, internal_port)` di un ingresso del piano, le colonne DNS e ACME della tabella `domains`.
- **`app_stack_deployments`**: `id` (`sdep_…`), una riga per ogni operazione di stack, `operation_id` unico (senza chiave esterna verso `operations`, come `site_backups`), `revision_id` (nullable), stato, `problem` (un codice, mai testo).
- **`organizations.max_app_stacks`**: colonna nullable, `NULL` = illimitato (§2.9).

Ogni tabella figlia porta `organization_id` e una chiave esterna composta `(stack_id, organization_id)` verso `app_stacks`: uno stack non cambia mai organizzazione e una riga non può puntare allo stack di un'altra. Gli id generati dal database sono opachi, `<prefisso>_<24 esadecimali>` (prefissi `atpl`, `atv`, `stk`, `srev`, `sdep`, `sdom`, `ssec`); gli id dei due modelli incorporati sono fissi e leggibili (`atpl_http_cache`, `atv_http_cache_1`, …, §2.12); tutti gli id che questa modifica crea rispettano `APP_STACK_ID_PATTERN` (`^[a-z][a-z0-9_]{0,63}$`). Gli id che la modifica non crea (l'organizzazione, che nel pannello è `org_<uuid>` con i trattini, e l'allocazione) rispettano un formato separato, `APP_FOREIGN_ID_PATTERN` (`^[a-z][a-z0-9_-]{0,127}$`): con il formato comune il piano e l'IPC rifiutavano le organisation reali (rilievo alto S5-H1 della revisione, riparato). Componenti, volumi e parametri non hanno id proprio.

L'unicità degli hostname tra `domains`, `app_stack_domains` e `hosts.hostname` è nel database: due trigger `BEFORE INSERT OR UPDATE OF hostname`, uno su ciascuna tabella dei domini, prendono `pg_advisory_xact_lock` sul nome in minuscolo e sollevano SQLSTATE `23505` con il nome di vincolo `uq_panel_hostname_claim`. Il codice dei siti non cambia: già traduce `23505` in `DOMAIN_CONFLICT`. La porta pubblica (`app_stack_port_allocations`) appartiene alla Wave P e qui non esiste.

### 2.3 Il formato `HCP-STACK/v1`

Il sorgente è letto dallo stesso `parseTemplateYaml` di ADR-0033, **senza modifiche**: 64 KiB, profondità 16, 4096 nodi, niente ancore, alias, tag, chiavi di fusione o documenti multipli. `HCP-STACK/v1` è soltanto uno strato di schema nuovo sopra quel parser.

- **Elenco ammesso per livello** (`packages/policy-engine/src/app-template-keys.ts`). La radice ammette `x-hp-stack` (intestazione: `schemaVersion`, `name`, `category`, `description`), `x-hp-parameters`, `services`, `volumes`, `x-hp-ingress`. Un servizio ammette immagine, `command` (lista argv), `environment`, `expose`, `depends_on` (forma breve), `healthcheck`, `volumes` con nome e i limiti di `deploy.resources.limits`. Ogni altra chiave è rifiutata con un codice e un motivo; i rifiuti delle chiavi che toccano l'host (`privileged`, `cap_add`, `network_mode`, `ports`, `build`, …) sono elencati nella tabella e provati uno per uno.
- **Chiavi**: un servizio o un volume ha una chiave `^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$`, senza `_`; la chiave di un servizio ha al più **27 caratteri** (`APP_STACK_COMPONENT_KEY_MAX`), perché il nome del container `hp_app_<stackId>_<chiave>` deve restare un'etichetta DNS di al più 63 caratteri; l'esecutore ricontrolla la lunghezza del nome.
- **Da 1 a 8 servizi**; per stack al più 8 volumi, 8 ingressi e 16 porte esposte; per servizio argv di al più 64 elementi da 1024 caratteri, al più 64 variabili d'ambiente e 8 montaggi (`APP_TEMPLATE_LIMITS` in `packages/contracts/src/app-templates/limits.ts`).
- **Scalari rigidi**: un valore d'ambiente o un elemento di `command` deve essere una stringa; un numero o un booleano è rifiutato con un messaggio che chiede le virgolette.
- **Sei tipi di parametro**: `enum`, `integer`, `string`, `boolean`, `size` e `secret`; al più 32 parametri, di cui al più 8 segreti.
- **Interpolazione a un passaggio**, con lo scanner dei modelli di sito: nei valori d'ambiente e nell'argv; nell'argv un segnaposto è sempre un elemento intero, il primo elemento non ne ha mai, e il valore riempito non può essere vuoto né cominciare con `-`. Un parametro `secret` non è mai interpolato.
- **Funzioni rinviate**: `x-hp-ports`, il tipo `port_choice` e un ingresso non HTTP sono riconosciuti e rifiutati con `STACK_UNSUPPORTED_FEATURE`; `build` è invece un rifiuto per accesso all'host (`KEY_FORBIDDEN_HOST_ACCESS`, motivo `STACK_TEMPLATE_INVALID`), perché è esecuzione di codice sull'host.
- **Motivi stabili**: i nomi del §16 della specifica, più `STACK_PARAMETER_INVALID`, formano `APP_STACK_REASONS` (`packages/contracts/src/app-templates/issues.ts`) e viaggiano in `details[].reason`; ogni problema ha anche un codice fine (`UPPER_SNAKE`, come nel validatore dei siti). Non nasce nessun `ErrorCode` nuovo.

### 2.4 Pipeline e confini di fiducia

```
amministratore ──► API: validatore (validateAppTemplateSource) ──► versione immutabile del modello
cliente ──► API: solo i parametri customer: true ──► compilatore puro (sorgente + parametri)
        ──► ApprovedStackPlan senza segreti, con planHash
        ──► revisione immutabile + riga di outbox, nella stessa transazione
        ──► corsia dell'outbox riservata agli stack
        ──► chiamate IPC firmate, brevi e idempotenti (una per passo)
        ──► hp-docker-executor: ricontrolla schema, allowlist, digest, utente e hash del piano
        ──► Docker Engine REST
```

Il validatore è `packages/policy-engine/src/app-template-validation.ts`; il compilatore è `packages/policy-engine/src/app-template-compile.ts`; lo spec tipizzato e il piano sono gli schemi di `packages/contracts/src/app-templates/spec.ts` e `packages/contracts/src/app-templates/plan.ts`; gli hash sono `computeAppStackPlanHash`, `computeAppStackComponentHash` e `computeAppTemplateSpecHash`. L'esecutore non dipende dal motore delle regole: ricontrolla il piano con `ApprovedStackPlanSchema`, `appStackPlanImageProblems` e `verifyAppStackPlanHash`, cioè con codice dei soli contratti e del dominio.

Le route sono cinque famiglie: il catalogo dell'amministratore `/v1/admin/app-templates` e il limite di stack per cliente `PATCH /v1/admin/organizations/:orgId/app-stack-limit` (entrambi solo `requireServerAdmin`), il catalogo del cliente `/v1/organizations/:orgId/app-templates`, gli stack `/v1/organizations/:orgId/app-stacks` e i loro domini `/v1/organizations/:orgId/app-stacks/:stackId/domains`. Le route del cliente passano per `requireOrgPermission` con i cinque permessi nuovi `app.read`, `app.create`, `app.update`, `app.control`, `app.delete` (da 39 a 44 chiavi; concessi a `customer_owner` e `hosting_admin`, non al collaboratore, non nell'accesso di supporto), poi per il flag; uno stack di un'altra organizzazione dà `404`, uno proprio senza il permesso `403`.

| Confine | Fra | Che cosa lo protegge |
|---|---|---|
| TB-A | browser ↔ BFF | sessione, CSRF e Origin come le altre route BFF; i valori segreti solo nella richiesta di scrittura |
| TB-B | API ↔ esecutore | IPC firmata esistente. Le sette chiamate che scaricano un'immagine, preparano reti e volumi, creano, avviano o riavviano componenti, pubblicano le route o rimuovono i soli componenti nuovi portano il piano intero, che l'esecutore ricontrolla da capo (schema, allowlist, digest, utente, hash). Le cinque che arrestano lo stack, ritirano le route, rimuovono lo stack o leggono stato e log portano solo gli id dello stack e dell'organizzazione (più la scelta sui volumi, o il componente e il numero di righe): l'esecutore tocca e legge solo le risorse le cui etichette di proprietà portano quei due id (`isOwnAppStackResource`) |
| TB-C | esecutore ↔ Docker | l'esecutore è l'unico processo al socket; nessun `docker compose`, nessuna shell |
| TB-D | container dello stack ↔ rete privata dello stack | una bridge per stack, nessuna rete della piattaforma, regola metadata `br-*` |
| TB-E | proxy ↔ rete edge dello stack | solo i componenti con un ingresso e il proxy; file di route `app_<stackId>.yml` separato |

### 2.5 Politica delle immagini e allowlist proposta

La sorgente deve portare il digest: `[registro/]repository[:tag]@sha256:<64 esadecimali>`. Il tag è informativo e il digest decide; `latest` è rifiutato; il `[registro/]repository` deve essere **uguale** (confronto esatto, non per prefisso) a una riga di `APP_IMAGE_ALLOWLIST` (`packages/contracts/src/app-templates/images.ts`). Il piano porta solo `nome@sha256:…` (il tag cade) e l'utente della riga dell'allowlist; l'esecutore ricontrolla allowlist, digest e utente prima di ogni pull e scarica per digest. L'allowlist vive nel codice, non nei dati dell'amministratore, e contiene esattamente queste tre righe, lette dal registro il 2026-11-22:

| Repository (riga dell'allowlist) | Utente forzato | Riferimento fissato nei modelli iniziali | Licenze | Perché funziona con filesystem in sola lettura e senza capability |
|---|---|---|---|---|
| `nginxinc/nginx-unprivileged` | nessuno (utente dell'immagine, 101) | `nginxinc/nginx-unprivileged:1.31.7-alpine3.24-slim@sha256:a8cb0f33d51fa107c96fd2bd3a71aaf564ec131e9d2bdf8700944f0ed8b170d7` | nginx BSD-2-Clause; packaging Apache-2.0 (NGINX Inc., Verified Publisher) | ascolta su 8080, sopra 1024; pid e file temporanei in `/tmp`, che è il tmpfs; gli script d'avvio vedono `/etc/nginx` in sola lettura e proseguono; i log vanno su stdout e stderr |
| `memcached` (Docker Official Image) | nessuno (utente `memcache`, 11211) | `memcached:1.6.45-alpine3.24@sha256:084fb554292d1447bc2c68b80c2331b98834514f56c866bc21a61be3c2ee376d` | BSD-3-Clause; librerie libevent BSD-3-Clause, libsasl BSD-4-Clause (clausola pubblicitaria), gdbm GPL-3.0-or-later (aggregata, non collegata al codice del pannello) | ascolta su 11211; non scrive su disco; nessuna capability |
| `valkey/valkey` (Docker-Sponsored OSS) | `999:1000` | `valkey/valkey:9.2.0-alpine3.24@sha256:c8e2d17498838af5d91e12eb7c11220b3434a7b7131a333e3af52ad5e0b80882` | BSD-3-Clause; packaging BSD-3-Clause; tini MIT, setpriv e libcap-ng GPL-2.0-or-later (più LGPL-2.1-or-later) | l'immagine parte come root e scende di utente con `setpriv` (servirebbero capability); la riga impone `999:1000`, così lo script d'avvio salta quel ramo; scrive solo `/data`, che è un volume con nome |

Le tre immagini Alpine contengono componenti GPL-2.0-only non modificati (busybox, apk-tools). Il pannello non le ridistribuisce: le scarica l'esecutore al momento del deploy. Il digest si verifica con `docker buildx imagetools inspect <repo>:<tag>` (è il digest dell'indice multi-architettura).

Escluse, con il motivo: `busybox` (nessun modello iniziale ne ha bisogno, e in qualunque posizione dell'argv è comunque rifiutato), `redis` 7.4 e 8.x (RSALv2, SSPLv1, AGPLv3: licenza non pulita), `rustfs/rustfs` (1–2 GB di memoria indicati a monte), `caddy`, `traefik/whoami` e `alpine` (tag mobili, nessun vantaggio). Righe, digest e licenze vanno approvati dal proprietario (BLOCKED.md #4).

### 2.6 Segreti

Un parametro `secret` arriva al container **solo come file**: la voce d'ambiente `{name: X_FILE, secret: <parametro>}` diventa nel piano `secretFiles[{envName, parameterKey, version}]`; l'esecutore scrive il file `/run/secrets/<parametro>` in sola lettura su tmpfs e mette nella variabile `X_FILE` il percorso, mai il valore. Il nome deve finire in `_FILE`.

I valori stanno in `app_stack_secrets`, una riga immutabile per versione, cifrata con il servizio AES-256-GCM esistente (ADR-0015) e AAD `<org>:*:app:<stack>:<parametro>:<versione>`: una riga copiata sotto un altro stack o un'altra versione non si decifra. La revisione fissa la coppia `(chiave, versione)`; ruotare un segreto = nuova versione + nuova revisione + redeploy. Nessuna versione si cancella finché lo stack vive, così ogni revisione resta ridistribuibile.

Un valore segreto ha al più 16 384 caratteri e non contiene caratteri di controllo C0 (salvo tabulazione, a capo e ritorno carrello) né surrogati spaiati, con una regola condivisa da API ed esecutore, così il corpo di un avvio resta sotto il limite di 1 MiB dell'IPC. Uno stack accetta al più `APP_STACK_SECRET_VERSIONS_PER_HOUR` = 10 versioni nuove in un'ora mobile, contate sotto il blocco dello stack; l'undicesima riceve `429 RATE_LIMITED` con `Retry-After` (rilievo S5-M2: le righe sono immutabili e il database è di tutti).

Il testo in chiaro compare in due soli punti: la route di sola scrittura `POST …/app-stacks/:stackId/secrets` (risposta `{ key, isSet, version, setAt }`) e la chiamata IPC firmata di avvio o riavvio di un componente, nel campo transitorio `secretFileContents`. Mai nell'outbox, nel piano, nell'hash, nell'audit, nei log, nei DTO, negli errori o nelle anteprime. I nomi dei campi sono scelti in modo che le tre guardie esistenti (scanner dell'outbox, hook `preSerialization` di `apps/api/src/create-app.ts`, `bffJsonResponse` del web) non trovino mai una chiave come `secretRef`, `password` o `token`.

### 2.7 Reti

Ogni stack ha due bridge: una privata (ruolo `app_internal`, Docker `Internal`, nome `hp_appnet_<stackId>`) per il DNS fra i componenti, e una edge (ruolo `app_edge`, `hp_appedge_<stackId>`), creata solo se il piano ha un ingresso e frequentata solo dai componenti con un ingresso e dal proxy. Sono bridge semplici, senza `com.docker.network.bridge.name`: per questo ricadono nella regola `iifname "br-*" ip daddr 169.254.0.0/16 drop` di `infra/linux/nftables-dedicated.conf`, che non si modifica. Un container di stack non entra mai in una rete della piattaforma (`site_internal`, `site_edge`) e non ha porte dell'host. Con `ADR-0039` (`PROPOSTO`) il componente unico di un database può essere attaccato anche alla rete privata di un'altra applicazione dello stesso cliente, e a nessun'altra rete. Dopo una ricreazione del proxy l'esecutore lo ricollega alle reti edge degli stack.

### 2.8 Ingresso HTTP e TLS

Le route di uno stack vanno nel file `app_<stackId>.yml` della directory dinamica, accanto ai `site_*.yml`; i router e i servizi si chiamano `app_<stackId>_<chiave>_<porta>…`. Il file è scritto (`apps/docker-executor/src/traefik-config.ts`) solo se cambia, validato prima della scrittura e sostituito con una rinomina atomica; il provider Docker di Traefik non si accende mai. Le route si pubblicano solo quando il bersaglio è sano. Un cambio di dominio non ricrea container né il proxy (§2.10).

Il TLS dei domini degli stack è solo ACME, con il risolutore che già serve i siti, e scrive gli stessi eventi di audit `site.certificate.*`; la colonna `cert_challenge` ammette `dns-01`, ma nessuna route di questa modifica lo imposta. Un hostname coperto dal certificato manuale di un'altra organizzazione è rifiutato, e l'import di un certificato manuale che copre l'hostname di uno stack altrui è rifiutato: i controlli di copertura imparano gli hostname degli stack in modo additivo, e l'elenco degli host instradati dell'esecutore legge anche i file `app_*.yml`. L'unicità globale degli hostname è nel database (§2.2).

**Aggiornamento delle route da parte dell'osservatore** (decisione del capo dopo il secondo giro di revisione, rilievi S5-M5 e S5-M7). Quando gli hostname di uno stack o lo stato dei loro bersagli cambiano, l'osservatore accoda un `stack.deploy` di sistema (nessun utente, chiave d'idempotenza con il prefisso `sys_routes_`, `APP_STACK_ROUTES_KEY_PREFIX` di `apps/api/src/app-stacks/app-stack-runtime-policy.ts`) che tocca **solo le route**: `validate`, una sola lettura dello stato, poi `publish` degli hostname correnti il cui bersaglio d'ingresso risulta acceso e sano, oppure il ritiro delle route se non ne resta nessuno, poi `settle`. Non scarica, non prepara, non crea, non avvia e non riavvia nulla, non controlla immagini né segreti e non tocca le revisioni; gli altri sei passi si chiudono `skipped`. Così un hostname tolto viene ritirato al passaggio successivo, anche se un componente è fermo, e un componente fermato a mano non viene mai riacceso. Senza più hostname l'aggiornamento non legge lo stato dei certificati e ritira le route; con altri hostname ancora presenti una lettura fallita dei certificati lo fa fallire (limite noto 29). Un aggiornamento rimasto in dubbio si chiude come aggiornamento, mai come un deploy fallito: dalla sola lettura dello stato è riuscito se le route viste sono gli hostname di oggi sui bersagli sani, altrimenti fallisce con `OPERATION_INTERRUPTED`; lo stack è `running` se è riuscito e tutti i componenti sono sani, altrimenti `degraded`, mai `failed`; le revisioni non cambiano e l'hash delle route registrato fa rifare l'aggiornamento al passaggio successivo dell'osservatore (dopo dieci minuti se è fallito). Lo stack passa per `updating` e torna `running` se tutti i componenti risultano sani, altrimenti `degraded`, mai `failed`. Si fa al più un aggiornamento per stack ogni cinque minuti (`APP_STACK_ROUTE_REFRESH_INTERVAL_MS`) finché cambia solo la salute dei bersagli; un hostname aggiunto, tolto o spostato, o un cambio di certificato, non aspetta mai.

### 2.9 Quote

- **Numero di stack** per organizzazione: `organizations.max_app_stacks` (`NULL` = illimitato), cambiato dall'amministratore con audit, contato sugli stack non cancellati sotto il blocco `FOR NO KEY UPDATE` della riga dell'organizzazione, come `packages/database/src/site-limit.ts`. Un rifiuto è `QUOTA_EXCEEDED` con un solo dettaglio, motivo `STACK_QUOTA_EXCEEDED`.
- **Massimi di codice**: per stack 8 componenti, 8 volumi, 8 route; per componente CPU da 50 milli a 16 core, memoria da 32 MiB a 16 GiB (memoria = swap), `PidsLimit` 256. Sono più stretti dei tetti del motore dei servizi.
- **Addebito aggregato**: componenti, CPU e memoria della revisione desiderata si addebitano alla riga `resource_quotas` dell'allocazione dello stack, se la riga esiste quando lo stack nasce.
- Uno stack non conta mai come sito: i siti tengono `max_sites` (ADR-0034).

### 2.10 Operazioni, stati e recupero

- **Sette tipi**: `stack.deploy`, `stack.start`, `stack.stop`, `stack.restart`, `stack.upgrade`, `stack.rollback`, `stack.delete`; tipo di risorsa `stack`; blocco `stack:<stackId>`; una corsia dell'outbox dedicata (i tipi sono esclusi dalla corsia principale, così un deploy di dieci minuti non ferma i siti). I tipi di stack entrano nell'insieme che blocca i lavori dell'host e gli aggiornamenti.
- **Passi**: `validate`, `reserve`, `pull`, `prepare`, `create`, `start`, `health`, `publish`, `settle`, più `unpublish`, `stop` e `remove` per arresto e cancellazione.
- **Esecutore**: l'API guida il deploy con chiamate brevi e idempotenti, una per passo, attraverso una porta opzionale separata (`StackExecutorPort`, dodici metodi: pull di un'immagine per chiamata, preparazione di reti e volumi, creazione dei componenti, avvio e riavvio di un componente, arresto, pubblicazione e ritiro delle route, rimozione dello stack o dei soli componenti nuovi, stato, log). Le letture sono `GET`. Nessuna `POST` aspetta minuti: le attese sono letture ripetute sotto il lease dell'operazione.
- **Stati**: la macchina a stati del §10.1 della specifica, con le aggiunte elencate in §5 (`ALLOWED_APP_STACK_TRANSITIONS`). Lo stato mostrato si calcola alla lettura (un'osservazione vecchia è `unknown`); l'osservatore non scrive mai lo stato memorizzato e accoda soltanto l'aggiornamento delle route (§2.8). L'osservatore non annulla mai un arresto: finché l'ultima operazione di uno stack è uno `stack.stop`, anche fallito, non accoda nulla per quello stack; accoda solo per uno stack `running` o `degraded` con una revisione applicata (anche quando una revisione più nuova è desiderata ma non installata: l'aggiornamento pubblica la revisione che gira, `ADR-0037`), mai mentre un'altra operazione è aperta, e dopo un aggiornamento fallito aspetta dieci minuti (non per un cambio delle opzioni di un indirizzo, né per indirizzi cambiati da quando quell'aggiornamento era stato accodato, `ADR-0037`).
- **Idempotenza**: `Idempotency-Key` più l'hash della richiesta, solo sulle route che accodano lavoro. Creazione, deploy e upgrade cercano la chiave prima dei controlli preliminari: un nuovo tentativo con la stessa chiave è ripetuto anche se nel frattempo la versione predefinita è cambiata; la rollback fa ancora i controlli prima (limite noto 20).
- **Permessi delle azioni**: avvio, arresto, riavvio e deploy chiedono `app.control`; un deploy che porta `parameters` chiede anche `app.update`, controllato prima della ricerca dello stack e dopo aver letto il corpo.
- **Ambiguità**: un timeout dopo la connessione è `OPERATION_AMBIGUOUS`, l'operazione diventa `unknown`; il recupero legge soltanto lo stato e chiude l'operazione da ciò che osserva, senza mai continuare o ripetere il deploy.
- **Avvio dell'API**: una riparazione rimette in `failed` (o `delete_failed`) gli stack rimasti occupati senza un'operazione attiva; uno stack rimasto `stopping` va in `unknown`, perché la tabella delle transizioni non permette altro.
- **Upgrade e rollback**: una nuova revisione che toglie un componente o una coppia `(componente, porta)` ancora usata da un dominio è rifiutata (decisione del capo): il cliente riceve `400 VALIDATION_ERROR`, campo `domains`, motivo `domain_target_removed`, e deve prima togliere il dominio; dopo un fallimento successivo alla creazione si rimuovono solo i componenti nuovi. Prima di rimuovere qualunque cosa l'esecutore controlla tutti i corpi nuovi e legge `GET /info`: un componente che chiede più processori di quanti ne abbia il server è rifiutato subito (Docker lo rifiuterebbe solo dopo la rimozione del vecchio container).
- **Fallimento prima di `create`** (issue #92): `create` è il primo passo che tocca un container (prima ci sono solo il download delle immagini e l'aggiunta di reti e volumi). Un upgrade o una rollback che fallisce di sicuro a `validate`, `reserve`, `pull` o `prepare` riporta, nella transazione che lo chiude, revisione desiderata, versione del modello, parametri, righe dei componenti e addebito della quota a quelli della revisione desiderata che la sua richiesta ha sostituito, cioè esattamente a prima della richiesta: la riga di deploy la registra quando la richiesta è accodata (`replaced_revision_id`, migrazione `0032`). Di solito è la revisione applicata; non lo è quando la richiesta è arrivata dopo un fallimento successivo a `create` (si torna alla revisione che allora era chiesta e non installata) o su uno stack mai applicato. L'addebito restituito è l'inverso esatto di quello della richiesta e non è mai rifiutato: un'altra applicazione può aver preso, mentre l'operazione girava, la quota che la richiesta aveva liberato. Non si riporta indietro se nel frattempo un indirizzo web, o una sua regola di percorso (`ADR-0037`: su uno stack mai applicato una regola salvata mentre l'operazione gira si controlla solo sul piano chiesto), è stato collegato a una coppia che solo la revisione nuova ha: la revisione nuova resta quella chiesta, con parametri e quota, e un «Reinstalla» la installa; su uno stack mai applicato lo stato resta `failed` e non c'è via del ritorno, perché la revisione sostituita non ha mai girato. Le righe dei volumi restano, come sempre; la revisione tentata e la sua riga di deploy restano nello storico; nessuna versione di un segreto si tocca (un segreto generato per la versione nuova resta, inutilizzato e mai mostrato, e la richiesta successiva della stessa versione lo riusa invece di generarne un altro). Un esito in dubbio si chiude nel recupero, che riporta indietro solo se il passo `create` di quell'operazione è ancora `pending`, cioè non è mai stato chiamato: da `create` in poi l'esecutore può aver sostituito dei componenti. Un avvio o un riavvio rifiutato a `validate` prende, come i deploy, lo stato che la lettura dell'esecutore mostra per il piano in uso (resta `failed` senza un piano leggibile o senza lettura); fa eccezione l'avvio di un'applicazione ferma: rifiutato prima di toccare qualunque cosa la lascia `stopped`, con o senza lettura (la riga di deploy registra lo stato che la richiesta ha sostituito, `replaced_status`, migrazione `0032`; da qui la transizione `starting → stopped`), e l'operazione fallisce con il suo motivo, che la pagina mostra. Non fa eccezione l'avvio che segue un backup o un ripristino (`ADR-0038`), che non registra `replaced_status` e, rifiutato, chiude `failed`: l'applicazione l'ha fermata la piattaforma, non il cliente, e la pagina deve mostrare che non è ripartita invece di un `stopped` silenzioso. Dopo un fallimento successivo a `create` la revisione desiderata resta quella nuova (un «Reinstalla» la riprova) e il dettaglio e l'elenco portano la revisione applicata in `installed`: l'elenco e la pagina mostrano la versione installata, la pagina dice che quella chiesta non lo è stata. La via del ritorno (`rollback` del dettaglio) offre solo una revisione precedente che ha girato, cioè di cui un deploy, un upgrade o una rollback è riuscito, o è fallito dopo il passo `health` riuscito (solo le route sono state rifiutate e la revisione è stata applicata), e il cui piano non è quello attuale: mai un tentativo fallito. Finché la revisione desiderata non è quella applicata (dopo un fallimento successivo a `create`, una presa indietro rifiutata per un indirizzo web o una regola di percorso, un deploy con impostazioni nuove fallito prima di `create`), lo stato mostrato si calcola dal piano della revisione applicata: la salute segue ciò che gira, anche un arresto improvviso.
- **Bozze**: una bozza non si aggiorna mai. Una bozza la cui versione non è più quella predefinita non si distribuisce (`STACK_TEMPLATE_UNPUBLISHED`): il cliente la cancella e installa di nuovo; il web lo dice con una frase propria.

### 2.11 Volumi e backup

I volumi sono volumi Docker con nome per stack (`hp_appvol_<stackId>_<volumeKey>`, driver locale, nessuna quota di dimensione). La conservazione predefinita è `retain`: upgrade e rollback non toccano mai un volume, e la cancellazione di uno stack lascia i volumi salvo una richiesta esplicita, che chiede di riscrivere il nome dello stack e una casella separata. Il backup degli stack **non è supportato** in questo rilascio (D6): la route esiste solo per rispondere `422 NOT_SUPPORTED` (prova B4), e i backup locali e S3 dei siti e del pannello non includono gli stack. **Sostituito da `ADR-0038`** (`docs/architecture/adr/0038-application-backups.md`): dove il backup dei siti è disponibile la route avvia un backup dei volumi dell'applicazione; i backup dei siti e del pannello continuano a non includere gli stack.

### 2.12 Il catalogo iniziale

Due modelli originali, scritti da zero, arrivano nel codice (`packages/contracts/src/app-templates/built-in.ts`, `APP_BUILT_IN_TEMPLATES`) e sono inseriti a ogni avvio dell'API da `ensureBuiltInAppTemplates`, chiamata in `apps/api/src/create-app.ts` subito dopo `ensureWordpressTemplate`. Il passo li valida e ne calcola l'hash al momento della chiamata (`packages/database/src/app-templates-built-in.ts`); un modello incorporato non valido è un errore di codice che il suo test ferma prima del merge. Le righe nascono `built_in = true` e **`enabled = false`**: sono bozze, perché solo l'amministratore pubblica (§3.4 della specifica) e perché le immagini aspettano la conferma del proprietario (BLOCKED.md #4). Un secondo avvio non cambia nulla e non sovrascrive ciò che l'amministratore ha cambiato; un cambio futuro di un modello incorporato sarà una versione nuova, mai una modifica della versione 1. Questo passo sostituisce la semina prevista dal progetto del runtime (decisione del capo).

**Sito HTTP con cache** (`atpl_http_cache`, versione `atv_http_cache_1`, slug `http-cache`, categoria `web`).
Descrizione: «Un sito web leggero che risponde in HTTP, con accanto una cache in memoria raggiungibile soltanto dagli altri componenti con il nome cache:11211. La cache non conserva dati.» In inglese, solo nel codice e nella documentazione: «A lightweight website answering over HTTP, with an in-memory cache next to it that only the other components can reach, at cache:11211. The cache keeps no data.»

```yaml
x-hp-stack:
  schemaVersion: 1
  name: "Sito HTTP con cache"
  category: web
  description: "Un sito web leggero che risponde in HTTP, con accanto una cache in memoria raggiungibile soltanto dagli altri componenti con il nome cache:11211. La cache non conserva dati."
x-hp-parameters:
  - key: cache_memory_mb
    label: "Memoria della cache (MB)"
    type: integer
    min: 16
    max: 96
    default: 48
    customer: true
services:
  web:
    image: nginxinc/nginx-unprivileged:1.31.7-alpine3.24-slim@sha256:a8cb0f33d51fa107c96fd2bd3a71aaf564ec131e9d2bdf8700944f0ed8b170d7
    expose:
      - 8080
    depends_on:
      - cache
    healthcheck:
      kind: http
      port: 8080
      path: /
      intervalSeconds: 10
      timeoutSeconds: 3
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 64M
  cache:
    image: memcached:1.6.45-alpine3.24@sha256:084fb554292d1447bc2c68b80c2331b98834514f56c866bc21a61be3c2ee376d
    command: ["memcached", "-m", "${cache_memory_mb}", "-c", "256"]
    expose:
      - 11211
    healthcheck:
      kind: tcp
      port: 11211
      intervalSeconds: 10
      timeoutSeconds: 3
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 128M
x-hp-ingress:
  - service: web
    port: 8080
    protocol: http
```

Perché è sicuro: i due componenti girano con l'utente non root della loro immagine, senza segreti né volumi (la cache è volatile); `cache` non è un bersaglio d'ingresso, quindi non entra mai nella rete edge; l'unico dato del cliente è un intero da 16 a 96 usato come un elemento intero dell'argv; `memcached -m` tiene la memoria degli elementi sotto il limite di 128 MiB; nginx serve solo la propria pagina predefinita, perché in v1 non si monta alcuna configurazione (quindi il componente web non usa la cache). Totali: 500 milli-CPU, 201 326 592 byte.

**Lavoro periodico con archivio** (`atpl_worker_storage`, versione `atv_worker_storage_1`, slug `worker-storage`, categoria `jobs`).
Descrizione: «Un lavoro in background che a intervalli regolari aggiorna un contatore in un archivio chiave-valore persistente. I dati sono conservati anche quando lo stack viene cancellato, salvo richiesta esplicita.» In inglese: «A background job that updates a counter in a persistent key-value store at a regular interval. The data is kept even when the stack is deleted, unless deletion is explicitly requested.»

```yaml
x-hp-stack:
  schemaVersion: 1
  name: "Lavoro periodico con archivio"
  category: jobs
  description: "Un lavoro in background che a intervalli regolari aggiorna un contatore in un archivio chiave-valore persistente. I dati sono conservati anche quando lo stack viene cancellato, salvo richiesta esplicita."
x-hp-parameters:
  - key: worker_interval_seconds
    label: "Intervallo del lavoro (secondi)"
    type: integer
    min: 5
    max: 3600
    default: 30
    customer: true
services:
  storage:
    image: valkey/valkey:9.2.0-alpine3.24@sha256:c8e2d17498838af5d91e12eb7c11220b3434a7b7131a333e3af52ad5e0b80882
    command: ["valkey-server", "--appendonly", "yes", "--dir", "/data", "--maxmemory", "48mb", "--maxmemory-policy", "noeviction", "--protected-mode", "no"]
    volumes:
      - data:/data
    expose:
      - 6379
    healthcheck:
      kind: tcp
      port: 6379
      intervalSeconds: 10
      timeoutSeconds: 3
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 128M
  worker:
    image: valkey/valkey:9.2.0-alpine3.24@sha256:c8e2d17498838af5d91e12eb7c11220b3434a7b7131a333e3af52ad5e0b80882
    command: ["valkey-cli", "-h", "storage", "-p", "6379", "-r", "-1", "-i", "${worker_interval_seconds}", "INCR", "worker:ticks"]
    depends_on:
      - storage
    deploy:
      resources:
        limits:
          cpus: "0.1"
          memory: 32M
volumes:
  data: {}
```

Perché è sicuro: i due componenti girano come `999:1000` (la riga dell'allowlist); il lavoro è il client dell'immagine stessa in ciclo (`-r -1 -i N`), senza shell; l'archivio è raggiungibile solo dalla rete privata dello stack (nessun ingresso, nessuna porta dell'host); `--protected-mode no` serve perché il servizio ascolta sull'indirizzo del container, mentre `enable-protected-configs` resta al predefinito `no`, così `CONFIG SET dir` non può spostare le scritture fuori da `/data`; il filesystem è in sola lettura e l'unico percorso scrivibile è il volume `data`, conservato alla cancellazione; `--maxmemory 48mb noeviction` tiene il processo sotto 128 MiB. Nessun segreto: Valkey non legge una password da un file `*_FILE`, e passarla nell'argv la renderebbe visibile in `docker inspect`. Totali: 600 milli-CPU, 167 772 160 byte.

### 2.13 Capability flag

`applicationTemplatesAvailable`, `applicationStacksAvailable`, `stackPublicPortsAvailable` e `gitBuildsAvailable` sono campi booleani con predefinito `false` in entrambi i DTO delle capacità (`packages/contracts/src/resources.ts`) e valgono `false` su ogni backend. L'API li legge da un solo punto, `APP_FEATURE_GATE_TOKEN` (`apps/api/src/app-stacks/app-feature-gate.ts`), che in produzione vale sempre «tutto spento»; i test lo cambiano solo attraverso un'opzione dichiarata «solo per i test» della creazione dell'app. Non c'è una variabile d'ambiente né un'opzione di produzione che li accenda. Le route dell'amministratore dipendono dal primo flag, quelle del cliente dal secondo.

### 2.14 Compatibilità e downgrade (§20)

| Caso | Comportamento | Come / prova |
|---|---|---|
| `sites` WordPress precedenti a 0024 | invariati (`template_version_id NULL`) | nessun codice dei siti modificato; `apps/api/test/site-type-pins.test.ts` |
| `site_templates` di ADR-0033 | schema e sorgente v1 invariati; rifiuti invariati | i file dei modelli di sito non si toccano (L1); i loro test |
| `service_templates` generici | mai trasformati in stack; route solo dell'amministratore | nessun codice nuovo li legge; `apps/api/test/admin-only-routes.integration.test.ts` |
| limiti del motore delle regole | non allentati (i massimi degli stack sono più stretti) | `APP_TEMPLATE_LIMITS` sotto `MAX_SERVICE_*`; `packages/contracts/test/app-template-limits.test.ts` |
| Traefik | `app_<id>.yml` separato; i file dei siti e del pannello mai riscritti | sentinella della directory dinamica; `apps/docker-executor/test/traefik-routes.test.ts` |
| TLS manuale e ACME | stesse politiche; stack solo ACME; collisioni globali nel database | trigger `uq_panel_hostname_claim`; `packages/database/test/app-stacks-database.test.ts` |
| backup locale e S3 | invariato; gli stack restano fuori dai backup | nessun file dei backup modificato; prova B4 |
| aggiornamento con lo schema nuovo | migrazione additiva, il vecchio binario ignora le tabelle | `packages/database/test/rollback-compat.test.ts`, con un gruppo nuovo per `0025` |
| downgrade dopo un deploy | rifiuto (codice 8) finché esiste uno stack non cancellato; mai una cancellazione automatica | gate `app-stacks`; `infra/linux/features-gate.test.ts`, `infra/linux/update.test.ts` e un test nuovo che esegue il predicato su PGlite |
| archivio di release | file nuovi nei `dist` dei pacchetti esistenti, migrazione letta dalla cartella, nessun programma dell'host nuovo | `infra/release/release-manifest.test.ts`; `release:smoke` |

**Il gate `app-stacks`.** `RELEASE_FEATURES` di `infra/release/build-release.mjs` ha `"app-stacks"` in coda. Applicata la migrazione `0025_app_stacks.sql`, `panel_features_in_use` (`infra/linux/lib/common.sh`) chiede `select 'app-stacks' where exists (select 1 from public.app_stacks where deleted_at is null)`: il gate è «in uso» finché esiste uno stack non cancellato, bozze comprese. `hp-update --version <precedente> --allow-downgrade` termina con **codice 8** e il testo di `infra/linux/update.sh` dice di cancellare gli stack dal pannello (i volumi dei dati restano), di tenere la release corrente o di passare `--allow-feature-loss`. Una release di destinazione precedente alla `0.10.0` conta come se non conoscesse `app-stacks`, qualunque cosa elenchi il suo `RELEASE.json`, perché ogni release `0.9` la elenca mentre i suoi interruttori delle applicazioni sono spenti (issue #169). Un errore di `psql` conta come rifiuto, come per gli altri gate. Il rollback automatico di un aggiornamento fallito resta senza gate: le tabelle sono nuove, il vecchio binario non le nomina, `organizations.max_app_stacks` è nullable, e un evento `stack.*` preso dalla vecchia corsia principale fallisce `NOT_SUPPORTED` senza toccare righe di stack; la riparazione all'avvio del binario nuovo rimette poi quello stack in `failed`. I container già accesi restano accesi, senza gestione.

**Ripristino su un server nuovo.** `infra/linux/hp-restore-panel.sql` ha istruzioni additive dopo la chiusura generica delle operazioni: le distribuzioni in corso diventano `failed` (`OPERATION_INTERRUPTED`), i componenti `missing`, i volumi `missing` (i dati non sono in nessun backup), i domini tornano `pending` senza certificato, gli stack `failed` (o `delete_failed` se erano in cancellazione). Le bozze restano `draft`. Segreti, parametri, revisioni e versioni non si toccano (i trigger di immutabilità farebbero fallire l'intero ripristino). Lo stack si ridistribuisce a mano dal pannello. Se dopo il ripristino lo stack si cancella, i volumi `missing` diventano `removed` e i segreti dello stack si cancellano (rilievo S5-M4). La guardia «server nuovo» di `infra/linux/restore-panel.sh` conta anche gli stack non cancellati, non solo i siti; la sua query usa `query_to_xml` e quindi PostgreSQL con libxml (il PostgreSQL 18 installato ha `--with-libxml`; la query è stata provata su PGlite).

### 2.15 Decisioni D1–D12: approvate dal proprietario

Le dodici decisioni del §24 della specifica, proposte e assunte da questa esecuzione per costruire, sono state **approvate dal proprietario il 2026-11-22** dopo la dimostrazione (gate W0, BLOCKED.md #1, chiuso per D1–D12 e per questo ADR).

| D | Proposta della specifica | Come l'esecuzione l'ha assunta | Stato |
|---|---|---|---|
| D1 | `app_templates` separati da `site_templates` | dieci tabelle `app_*` nella migrazione `0025` | approvata dal proprietario (2026-11-22) |
| D2 | solo l'amministratore modifica i modelli | route `/v1/admin/app-templates` con `requireServerAdmin` | approvata dal proprietario (2026-11-22) |
| D3 | al più 8 componenti per stack | `APP_TEMPLATE_LIMITS.services = 8`, ricontrollato dall'esecutore | approvata dal proprietario (2026-11-22) |
| D4 | immagini approvate e fissate a digest | digest obbligatorio e allowlist di codice di tre righe (§2.5) | approvata dal proprietario (2026-11-22); l'allowlist e i digest restano da confermare (§8.1, BLOCKED.md #4); `ADR-0039` (`PROPOSTO`) aggiunge le righe `mariadb` e `postgres` |
| D5 | parametri `secret` sempre come file | `X_FILE` e file in sola lettura; nessun segreto nell'ambiente | approvata dal proprietario (2026-11-22) |
| D6 | backup degli stack non supportato | `NOT_SUPPORTED`; nessun flag | approvata dal proprietario (2026-11-22); sostituita da `ADR-0038` (`PROPOSTO`) |
| D7 | porte TCP/UDP dietro un gate | `stackPublicPortsAvailable = false`; `x-hp-ports` rifiutato | approvata dal proprietario (2026-11-22) |
| D8 | build Git dietro un gate | `gitBuildsAvailable = false`; `build` rifiutato | approvata dal proprietario (2026-11-22) |
| D9 | la rollback non inverte i database | i volumi non si toccano; avviso nell'anteprima del cambio | approvata dal proprietario (2026-11-22) |
| D10 | indipendente da Shared Hosting | solo Dedicated, `SHARED_MODE_GATED` invariato | approvata dal proprietario (2026-11-22) |
| D11 | import di Egg solo in futuro, solo metadati | nessun importatore | approvata dal proprietario (2026-11-22) |
| D12 | catalogo iniziale originale e revisionato per le licenze | due modelli scritti da zero, licenze in §2.5 | approvata dal proprietario (2026-11-22); `ADR-0039` (`PROPOSTO`) aggiunge tre modelli di database |

### 2.16 Secondo ciclo: un solo nome, «Applicazioni» (decisioni L22–L28 e L31, 2026-11-22)

Dopo la dimostrazione il proprietario ha chiesto di non separare più sito e applicazione nelle console: anche WordPress è
un'applicazione. Le decisioni L22–L28 sono state prese con lui; L31 è una scelta di chi ha costruito il ciclo, da confermare:

- **L22 Nome.** «Applicazioni» / «Applications». Un sito WordPress è un'applicazione di tipo WordPress; negli elenchi il tipo è il
  nome del tipo di sito per un sito e il nome del modello per uno stack.
- **L23 Testi.** Cambiano i testi che nominano la cosa gestita come categoria (menu, titoli, colonne, pulsanti «nuovo», elenchi
  vuoti, limiti, conferme); «sito» resta dove indica il sito web pubblico o una sezione che contiene solo siti WordPress. Le
  chiavi dei testi non cambiano.
- **L24 Indirizzi web.** `/apps` è l'unico elenco del cliente, `/apps/new` l'unica pagina di scelta; `/sites` porta a `/apps`;
  `/sites/<id>/…`, `/apps/<id>` e `/apps/new/<modello>` restano dove sono. Le route dell'API non cambiano.
- **L25 Flag spenti e visite di supporto.** Con `applicationStacksAvailable` spento, o in una visita di supporto, l'elenco e la
  scelta mostrano solo WordPress, senza avvisi; i quattro flag restano `false`.
- **L26 Limiti e dati.** `max_sites` e il limite degli stack restano due limiti distinti; nessuna tabella, DTO o route rinominata.
- **L27 Amministratore.** La voce «Siti» diventa «Applicazioni» (`/admin/sites`): le applicazioni WordPress come prima e, con il
  flag acceso, gli stack di tutti i clienti in sola lettura, letti dalla route nuova `GET /v1/admin/app-stacks`
  (amministratore del server, al più 200, nessun segreto né valore di parametro). Dall'`ADR-0041` la riga di uno stack porta
  alla sua pagina, dove l'amministratore legge i log di un componente e vi apre un terminale; non può ancora avviarlo,
  fermarlo o cambiarlo. «Modelli» è un solo elenco dei due tipi con un
  solo «Nuovo modello»; `/admin/templates/apps` porta a `/admin/templates`.
- **L28 Modificare un modello multi-servizio.** Nome, descrizione e categoria si cambiano dalla pagina del modello (la `PATCH`
  esistente); valgono quelli della riga, non quelli dell'intestazione `x-hp-stack` di una versione nuova. «Modifica contenuto»
  apre l'editor sulla versione predefinita; salvare crea una versione nuova, le versioni restano immutabili.
- **L31 Indirizzo di un sito WordPress.** Una riga WordPress dell'elenco mostra il suo indirizzo web grazie a una seconda route
  nuova di sola lettura, `GET /v1/organizations/:orgId/managed-sites` (permesso `site.read`, gli stessi siti che il cliente può
  già leggere, al più 200, con il dominio principale).

Codice: `apps/web/src/components/admin/template-catalog.tsx`, `apps/web/src/components/admin/app-template-detail.tsx`,
`apps/api/src/controllers/admin-app-stacks.controller.ts`, `apps/api/src/controllers/managed-sites.controller.ts`.

## 3. Alternative scartate

- **`sites.site_type = 'application'`:** romperebbe il rollback automatico (una release vecchia leggerebbe siti che non sa gestire) e i pin di WordPress.
- **Estendere `site_templates` a più servizi:** stessi motivi; il §2 della specifica lo esclude.
- **Una libreria YAML completa:** dipendenza non approvata e superficie enorme (ADR-0033 §2.4); il sottoinsieme basta.
- **Passare Compose a Docker o eseguire `docker compose up`:** un orchestratore esterno su cui il pannello non ha controllo, e il socket Docker a un altro processo.
- **Riusare `encrypted_secrets`:** è legata ai siti e ruota sul posto; una rollback non saprebbe più decifrare la versione fissata nella revisione.
- **Riusare `domains`:** `site_id` è `NOT NULL` e tutti i consumatori TLS sono legati ai siti.
- **`HEALTHCHECK` di Docker o `exec` per le sonde:** servirebbe una shell nel container, e l'esecutore dovrebbe lanciare comandi dentro il container dei clienti e leggerne l'uscita; le sonde le fa l'esecutore, TCP o HTTP verso l'indirizzo del componente.
- **Risolvere il tag in digest durante la compilazione:** il compilatore non sarebbe più puro né deterministico.
- **Una sola rete per stack:** il proxy vedrebbe anche il database dello stack.
- **Redis o RustFS nel catalogo iniziale:** licenza non pulita (Redis) e memoria (RustFS).
- **Modelli iniziali abilitati all'avvio:** pubblicazione senza un amministratore.
- **Certificati manuali sui domini degli stack ora:** toccherebbe sei punti del codice TLS dei siti.

## 4. Limiti noti

1. **TLS manuale sui domini degli stack non disponibile**: solo ACME, e nessuna route imposta `dns-01` su un dominio di stack.
2. **Il gate di downgrade non vede i volumi conservati di stack cancellati**: i dati restano in volumi Docker che la release più vecchia non vede e non rimuove.
3. **Dopo un downgrade forzato** (`--allow-feature-loss`) i container degli stack restano accesi senza gestione.
4. **La console `hp-web` (tcp 3000) è raggiungibile da ogni bridge** per la regola congelata del firewall; è protetta dalla sessione. Nella prova su questa macchina la porta 3000 è risultata rifiutata da entrambi i gateway degli stack (passo `no-control-plane-reach`), ma la regola resta quella e il limite vale dove si applica.
5. **Nessun backup degli stack** (D6). Vale per questo rilascio: `ADR-0038` aggiunge il backup e il ripristino di un'applicazione.
6. **Nessuna porta TCP/UDP pubblica e nessuna build Git** (Wave P e Wave G).
7. **I digest si aggiornano a mano**: un'immagine nuova richiede una versione nuova del modello.
8. **Le descrizioni inglesi dei modelli iniziali non sono memorizzate**: esistono solo nel codice e nella documentazione.
9. **Una bozza di stack mai distribuita blocca il downgrade** come uno stack acceso.
10. **Il riavvio del server (B6), il blocco del metadata su una VM cloud reale e l'emissione ACME su un hostname reale non sono stati provati su questa macchina**: restano al proprietario. Anche il passo `host-nft-metadata-drop-on-stack-net`, che richiede root, è saltato in tutte le esecuzioni.
11. **Traefik resta fissato per tag** (`traefik:v3.7`), come oggi.
12. **Le risorse misurate** (`docker stats`) sono di una sola esecuzione (§8.3), non di una prova di carico.
13. **Dopo un riavvio dell'host i componenti con segreti restano rotti finché qualcuno non li riavvia**: i file dei segreti stanno in un tmpfs dell'host e si perdono al riavvio, e Docker riaccende i container prima dell'esecutore. Nulla riavvia o ripara lo stack da solo, perché il riconciliatore non riavvia mai i container dei clienti (TH-10 di `HARNESS.md`): il cliente o l'amministratore usa «Riavvia» (`stack.restart`), che riscrive i file prima di riavviare. I componenti senza segreti non ne risentono.
14. **La sorgente dell'amministratore deve portare il digest dell'immagine**: un riferimento con il solo tag è rifiutato, e il pannello non risolve un tag in digest (§8.2).
15. **La regola delle shell è per nome**: rifiuta un interprete di shell in qualunque posizione del comando, e anche un argomento qualunque il cui ultimo segmento di percorso è il nome di una shell o di un lanciatore (per esempio `env`, `/usr/share/fish` o `--shell=/bin/sh`, il cui ultimo segmento è `sh`). Altri interpreti (`python -c`, `perl -e`, `awk`) non sono rifiutati: eseguono codice solo dentro il container indurito del cliente stesso, e un modello che passa loro un valore del cliente è responsabilità dell'amministratore.
16. **Gli indirizzi del metadata scritti in altre notazioni passano la regola dei testi**: la regola riconosce `169.254.`, `fd00:ec2::` e `metadata.google.internal`, non lo stesso indirizzo in decimale, in esadecimale, come IPv6 con IPv4 incorporato o con un nome breve. Il controllo è il blocco di rete del firewall dell'host (§2.7).
17. **Una bozza su una versione che non è più quella predefinita non si distribuisce né si aggiorna**: si cancella e si installa di nuovo (§2.10).
18. **Una cancellazione che distrugge i dati, fallita a metà e ripetuta con «conserva i dati»,** può lasciare righe `retained` di volumi che non esistono più, e con esse le righe dei segreti dello stack (S5-L14 di `docs/security/audit-report.md`).
19. **Nel database**: `TRUNCATE` aggira il trigger d'immutabilità dei segreti; `resource_quota_id` non è legato all'organizzazione in SQL; una cancellazione fisica di uno stack vivo si propaga a revisioni e segreti. Nessun percorso del codice fa queste cose.
20. **La rollback fa i controlli preliminari prima di cercare la chiave d'idempotenza**: un nuovo tentativo di una rollback può ricevere un rifiuto invece della ripetizione, se nel frattempo una condizione è cambiata (creazione, deploy e upgrade cercano prima la chiave).
21. **Una `ensure` concorrente del proxy** può ricollegarlo a una rete edge fra il distacco e la cancellazione di quella rete: la rimozione dello stack fallisce con un conflitto di namespace e un nuovo tentativo converge.
22. **Le opzioni `enum` di un modello possono contenere testi che sembrano segreti**: le scrive l'amministratore e sono pubbliche per definizione.
23. **L'aggiornamento delle route** (§2.8) ricorda il limite dei cinque minuti in memoria, per processo dell'API: un riavvio dell'API lo dimentica.
24. **I valori segreti più corti di 6 caratteri non si mascherano nei log**, e il mascheramento vale solo finché esistono i file dei segreti.
25. **La guardia «server nuovo» del ripristino** richiede PostgreSQL con libxml; è stata provata su PGlite, non sul PostgreSQL del server.
26. **Testi del web**: per un limite orario `RATE_LIMITED` dice di riprovare «a breve»; alcuni titoli riusano la chiave di catalogo esistente più vicina.
27. **Riparato e provato, non riletto da una revisione indipendente (rilievo medio S5-M9)**: un aggiornamento delle route rimasto in dubbio era giudicato dal recupero come un deploy completo e poteva lasciare lo stack `failed`, che l'osservatore non aggiorna più. Con `fix16-refresh-recovery` il recupero lo chiude come aggiornamento, `running` o `degraded`, mai `failed` (§2.8). Test: `apps/api/test/app-stack-recovery.unit.test.ts`, `apps/api/test/app-stack-runtime.unit.test.ts`, `apps/api/test/app-stack-runtime-policy.test.ts`. Il ciclo di revisione finisce al terzo giro: nessun quarto giro ha riletto la riparazione.
28. **Riparato e provato, non riletto da una revisione indipendente (rilievo medio S5-M10)**: un segreto che attraversava la divisione di Docker in frame da 16 KiB, quando il limite di lettura di 2 MiB tagliava il frame di continuazione, tornava nei log come un pezzo centrale non mascherato (33 esecuzioni casuali su 900 nella revisione). Con `fix16-log-frames` l'esecutore riunisce come byte i frame di una riga, per flusso, prima di decodificarla e mascherarla, e scarta la riga che il limite di lettura ha tagliato; una riga più lunga di 16 KiB torna quindi come una sola riga, tagliata a 2 000 caratteri. Test: `apps/docker-executor/test/app-stack-engine.test.ts` (la riproduzione del revisore, un taglio dentro un carattere di tre byte, 300 disposizioni casuali), `apps/docker-executor/test/app-stack-secrets.test.ts`. Nessun quarto giro ha riletto la riparazione.
29. **Una lettura fallita dello stato dei certificati** durante l'aggiornamento delle route, quando lo stack ha ancora altri hostname, fa fallire l'aggiornamento: il file di route vecchio resta e un hostname tolto resta instradato; si riprova ogni dieci minuti finché la lettura fallisce. Senza più hostname la lettura non si fa e l'ultimo viene sempre ritirato (`fix16-refresh-recovery`, non riletto da un quarto giro; S5-L20).
30. **Il costo del mascheramento** cresce con il numero di righe dei valori segreti: otto segreti di 2 340 righe ciascuno costano da 0.6 a 1.1 s e circa 80 MB di memoria per lettura dei log (S5-L19).

## 5. Divergenze da HCP-SPEC-005

La tabella unisce le divergenze dei sette documenti di architettura dello sciame, con le decisioni del capo che le correggono (dove due documenti non concordano valgono le decisioni del capo, poi i documenti del nucleo). Il codice della prima colonna dice da dove viene la riga: DV = linguaggio e piano, CD = dati, AP = API, RU = runtime, DX = esecutore, DA = garanzie e catalogo, DW = web, L = decisione del capo (L0–L21), LR = decisione del capo sulle richieste degli architetti. Le righe CB sono le decisioni prese durante la costruzione (decisioni del capo sui rilievi delle revisioni). La colonna «Costruito» descrive ciò che è stato costruito; i doppioni sono uniti in una riga.

| # | Specifica | Costruito | Motivo |
|---|---|---|---|
| DV1, L5 | §3.5 e §6.3: immagine con solo tag ammessa nella sorgente, digest risolto prima della revisione; l'esempio del §6.2 non ha digest | la sorgente deve portare `@sha256:<digest>`; il tag è informativo; `latest` rifiutato; il piano porta solo `nome@digest` | compilatore puro e A13 deterministica; la risoluzione lato server è un seguito registrato |
| DV2, CD5, RU2 | §7.2 `ingress[].domainId`; §5.1 l'hash copre l'ingresso con i domini; §3.9 e §11.1 | `plan.ingress = [{componentKey, port}]`; gli hostname stanno in `app_stack_domains` e puntano a una coppia; un cambio di dominio non crea una revisione ed è pubblicato dall'aggiornamento delle sole route (§2.8): un `stack.deploy` di sistema della revisione applicata che fa soltanto `validate`, una lettura dello stato, `publish` e `settle`; nessun container toccato, proxy non riavviato, lo stack mostra `updating` | un cambio di route non deve forzare un redeploy né un hash nuovo; un solo percorso bloccato e recuperabile per ogni scrittura dell'esecutore |
| DV3, CD1, L0 | §5 `app_stack_port_allocations`; §7.2 `portReservations`; §5.1 `portAllocations` | assenti | Wave P |
| DV4 | §7.2 `volumes[].retention` | i volumi del piano sono `{key}`; la conservazione è `app_stack_volumes.retention_policy` | non è un dato del container; ogni volume resta salvo richiesta (A18) |
| DV5 | §7.2 `resources.pids` per componente | costante `APP_STACK_PIDS_LIMIT = 256`, non è un dato né sta nel piano; `limits.pids` rifiutato | una costante in un piano hashato non aggiunge nulla; A12 vale lo stesso |
| DV6, DX2 | §7.2 `secretRefs[{envFileName, secretRefId, version}]`, risolti «nel canale effimero» | `secretFiles[{envName, parameterKey, version}]`; `(stackId, parameterKey, version)` identifica la riga di `app_stack_secrets`; i contenuti viaggiano nel campo transitorio `secretFileContents[{parameterKey, version, content}]`, solo su avvio e riavvio | nessuna chiave `secretRef*` (le guardie), nessun id in più; stessa forma della lettura dei segreti nel database |
| DV7 | §7.2 non ha un campo utente | `runAsUser` del componente copiato dalla riga dell'allowlist e ricontrollato dall'esecutore | §3.6 «eccezioni enumerate nel codice»; alcune immagini pulite per licenza partono come root |
| DV8 | §5.1 elenco dei campi dell'hash | `planHash` esclude `stackId`, `organizationId`, `hostAllocationId`, `revisionId` e sé stesso | l'elenco della specifica non li ha; li lega la riga della revisione |
| DV9 | §6.3 «chiavi ASCII sicure» | chiavi di servizio e volume `^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$`, senza `_`; la chiave di un servizio al più 27 caratteri | `hp_app_<stackId>_<chiave>` deve dividersi senza ambiguità; alias valido come etichetta DNS |
| DV10 | §6.4 parametri interpolabili nei controlli di salute | nessuna interpolazione nei controlli di salute | non serve; superficie SSRF più piccola |
| DV11 | §6.4 segnaposto come elementi singoli dell'argv | in più, un elemento fatto di un solo segnaposto non può risultare vuoto né cominciare con `-` | iniezione di opzioni attraverso i valori del cliente |
| DV12 | §6.4 l'amministratore deve prescrivere `enum` o una regex restrittiva | nessuna regex sui parametri `string` in v1; l'amministratore usa `enum` | nessuna regex scritta da un utente (ReDoS); superficie più piccola |
| DV13, DX4, L9 | §16 elenco dei motivi | più `STACK_PARAMETER_INVALID` per i valori del cliente; più i motivi del solo esecutore `STACK_PLAN_INVALID`, `STACK_PLAN_HASH_MISMATCH`, `STACK_IMAGE_PULL_FAILED`, `STACK_IMAGE_DIGEST_MISMATCH`, `STACK_IMAGE_MISSING`, `STACK_NAMESPACE_CONFLICT`, `STACK_COMPONENT_NOT_READY`, `STACK_BUSY` | A3 e A7 vogliono un motivo stabile diverso da «modello non valido»; rifiuti precisi dell'esecutore senza codici d'errore nuovi |
| DV14 | §6.4 flag `customer` di un segreto | un segreto deve essere `customer: true`; al più 8 parametri segreti per modello | nessun altro può impostarlo; limite del corpo IPC |
| DV15 | §6.3 ingresso = «componente + porta esposta» | il bersaglio deve dichiarare un controllo di salute; `protocol` deve essere `http` | le route si pubblicano solo quando il bersaglio è sano (L18) |
| DV16 | §6.3 `depends_on` con attesa condizionata a start o health | solo la forma breve; regola fissa: si aspetta «sano» se la dipendenza ha un controllo di salute, altrimenti «acceso» | nessun `condition` da validare |
| DV17 | §6.3 limiti non numerati (argv, percorso di salute, etichette, percorso nel container, byte del piano) | numeri fissati in `APP_TEMPLATE_LIMITS`; CPU da 50 milli a 16 core e memoria da 32 MiB a 16 GiB per componente, più stretti di `MAX_SERVICE_*` | il §20 ammette limiti più stretti, mai più larghi |
| DV18 | (regola dei siti) `PORT` riservato | `PORT` ammesso come nome d'ambiente di uno stack | variabile comune delle applicazioni; il motivo dei siti (porta di ripiego) qui non vale |
| DV19 | §6.4 parametri non segreti | ogni parametro non segreto deve avere un `default` | valori `customer: false` e anteprime sempre calcolabili |
| DV20, L1 | §6.1 «nuovo schema v2» del parser di ADR-0033 | parser riusato senza modifiche; `HCP-STACK/v1` è solo uno strato di schema | nessuna riga cambiata nel codice dei modelli di sito |
| DV21, L0 | §6.3 `build` «vietato» e `x-hp-ports` dietro gate | `build` → `KEY_FORBIDDEN_HOST_ACCESS` (`STACK_TEMPLATE_INVALID`); `x-hp-ports`, `port_choice` e un ingresso non HTTP → `STACK_UNSUPPORTED_FEATURE` | la build è esecuzione di codice sull'host (§17); le porte sono una funzione rinviata |
| CD2, AP1, AP2, L7 | §5 nessuna tabella dei segreti; §9.3 riusare `encrypted_secrets`; §9.2 la creazione riceve `secretRefs` | tabella `app_stack_secrets` a versioni immutabili e route propria di sola scrittura `POST …/app-stacks/:stackId/secrets`, risposta `{ key, isSet, version, setAt }`; la creazione non riceve segreti, e un modello con un segreto obbligatorio si crea con `deploy: false` (201, bozza) | `encrypted_secrets` è legata ai siti e ruota sul posto: una rollback non decifrerebbe la versione fissata; i segreti appartengono allo stack, che deve esistere prima; nessuna chiave `secretRef` nelle risposte |
| CD3 | §5 `app_stack_parameters` con valore pubblico **oppure** `secret_ref` e `type` | solo valori pubblici; i parametri segreti sono le loro versioni in `app_stack_secrets`; nessuna colonna `type` | il tipo è nello spec compilato; nessun riferimento a segreti fra i valori pubblici |
| CD4 | §5 componenti, volumi e parametri con `id`, `logical_name`, `kind`, `status`, `last_health`, `role` | chiave `(stack_id, chiave)` senza `id`; `component_key` e `volume_key`; i componenti hanno un solo `health` con `health_observed_at`; i volumi non hanno `role` | lessico del §16 della specifica; i fatti del piano restano nella revisione |
| CD5, DX6, DX8, AP3, L11 | §5 `app_stack_domains` con `certificate_assignment_id` e `tls_policy`; §11 conservare i certificati manuali, route di redirect e canoniche; §9.3 domini come operazioni | nessun `certificate_assignment_id`; `tls_policy` diventa `cert_challenge` (`http-01` o `dns-01`, lessico di `domains`) con tutte le colonne DNS e ACME di `domains`; host degli stack solo ACME o in chiaro, `source: manual` rifiutato dall'esecutore; nessun `redirectTo`; domini sincroni come quelli dei siti (nessuna operazione, nessuna `Idempotency-Key`), route pubblicate dal riconciliatore | nessuna entità di assegnazione esiste; il TLS manuale degli stack è un limite registrato; il primo rilascio non ha bisogno di redirect |
| CD6 | §5 colonne di `app_stacks` | in più `template_id` (upgrade solo nello stesso modello, garantito da chiave esterna), `resource_quota_id` (addebito), `applied_routes_hash` (idempotenza delle route), `idempotency_key` e `request_hash` | una creazione idempotente può restare bozza, perché i segreti si impostano solo dopo che lo stack esiste |
| CD7, LR | §5 `app_stack_revisions` (`number`, nessun totale) | in più `organization_id` e i totali `component_count`, `cpu_milli`, `memory_bytes`; `number` diventa `revision_number`; nessun `created_by`; per decisione del capo anche `parameters` (JSONB, i soli valori pubblici, ordinati, immutabili come il resto) | quota senza rileggere il piano; l'attore sta nella riga di audit; i valori pubblici della revisione restano legati a essa |
| CD8, LR | §5 `app_stack_deployments.desired_revision_id`, `problem` | `revision_id` nullable (arresto o cancellazione di una bozza); una riga per ogni operazione di stack, non solo per i deploy; `problem` è un membro di `APP_STACK_REASONS` quando il fallimento ne ha uno, altrimenti l'`ErrorCode`, mai testo | ogni operazione ha la sua traccia; nessun testo libero che possa contenere un dato |
| CD9, RU8 | §10.1 macchina a stati | aggiunte: il riavvio passa per `starting`; `queued → failed`; `failed → starting, stopping, updating`; `unknown → starting, stopping, updating, stopped`; `stopping → running, degraded` (arresto sicuramente fallito, mai `failed`); `starting → stopped` (avvio di un'applicazione ferma rifiutato prima di toccare qualunque cosa, issue #92); una cancellazione in dubbio resta `deleting` con l'operazione `unknown` | il cliente può agire appena il blocco è libero; i lease del §10.4 restano |
| CD10 | §4 nove passi | in più `unpublish`, `stop` e `remove` | arresto e cancellazione ne hanno bisogno |
| CD11 | §16 audit | `app.stack.denied` non è scritto (i rifiuti restano le righe automatiche con il permesso); nomi additivi `admin.app_template.update`, `app.stack.domain.remove`, `admin.customer.app_stack_limit`; gli eventi ACME degli stack riusano `site.certificate.*` | convenzioni dello scrittore di audit esistente; la memoria di 24 ore dei limiti ACME resta una |
| CD12 | §12 quote (stack, porte pubbliche, volumi) | stack contati da `organizations.max_app_stacks`; addebito aggregato solo se una riga `resource_quotas` esiste alla creazione; porte e conteggi dei volumi senza limite aggregato oltre ai massimi per stack | nessuna porta in v1; nessuna nuova tabella di quote |
| CD13, DA6 | §20 «downgrade dopo uno stack deploy: rifiuto» | il gate tiene finché esiste uno stack non cancellato (bozze comprese) e ignora i volumi conservati di stack cancellati | un solo predicato; i dati conservati non danneggiano una release più vecchia |
| AP4 | §9.2 `plan` e conferma del §10.3 | `plan` richiede `app.update` e dà gli stessi rifiuti preliminari dell'azione; `upgrade` e `rollback` devono ripetere il `planHash` del confronto rivisto, anche per uno stack senza dati | la conferma del cliente si lega al piano che ha visto |
| AP5, DW2 | §9.2 `upgrade`; §15 «modifica parametri» | si aggiorna solo verso la versione predefinita pubblicata, più nuova di quella corrente; i parametri pubblici restano quelli dell'installazione (cambiarli = una versione nuova del catalogo e un upgrade), i segreti si sostituiscono; uno stack su una versione più vecchia non cambia parametri né segreti finché non si aggiorna | nessuna route di modifica dei parametri nel §9.2; meno casi da provare |
| AP6 | §8 l'amministratore del server agisce per un cliente | l'amministratore agisce su uno stack solo attraverso un'organizzazione che raggiunge (appartenenza o ambito di hosting); nessun `/v1/admin/app-stacks`; la supervisione passa da `…/app-templates/:templateId/usage` (al più 200 stack) | stesse guardie del cliente, nessuna seconda superficie |
| AP7 | §8 «solo autorizzati al suo Dedicated» | il catalogo del cliente è uguale per ogni organizzazione; la creazione senza un'allocazione Dedicated attiva risponde `422 NOT_SUPPORTED`, motivo `STACK_UNSUPPORTED_FEATURE` | il filtro per allocazione sta nella creazione, non nel catalogo |
| AP8, DW5 | §9.2 salute di un componente | la lettura restituisce l'ultima osservazione memorizzata (con `stale` e il tipo di sonda come fonte), nessuna sonda dal vivo per richiesta; il web non chiama la route della salute, il DTO di dettaglio porta salute e ora dell'ultimo controllo | letture limitate; una lettura per pagina |
| AP9 | §9.2 log | un solo budget di concorrenza condiviso con i log dei siti (8 nel pannello, 2 per organizzazione), coda da 1 a 500 righe, mascheramento dei segreti nell'esecutore, righe di 2000 caratteri | limite 27 di ADR-0026 |
| AP10, DW11, D6 | §19 B4; §15 «backup supportato o dietro gate» | `POST …/app-stacks/:stackId/backups` esiste solo per rispondere `422 NOT_SUPPORTED`; il web mostra la riga fissa «Il backup delle applicazioni non è ancora disponibile» e nessun comando | i backup degli stack sono fuori ambito |
| AP11 | §9.3 `Idempotency-Key` | obbligatoria solo dove si accoda lavoro; catalogo dell'amministratore, segreti, domini e `plan` la ignorano | quelle route sono sincrone o pure |
| AP12 | §9.0 ripetizione della richiesta | creazione, deploy e upgrade cercano la chiave prima dei controlli preliminari e ripetono l'operazione registrata; solo la rollback fa ancora i controlli prima (limite noto 20) | stessa chiave e stesso corpo danno la stessa operazione anche se la versione predefinita è cambiata (rilievo S5-L6) |
| AP13 | §9.1 metadati del modello | nome, descrizione e categoria vengono dall'intestazione della sorgente alla creazione e si cambiano con `PATCH`; lo slug (`^[a-z][a-z0-9-]{1,47}$`) lo sceglie l'amministratore | una sola fonte alla creazione, correzioni senza versione nuova |
| RU1 | §10.2 esecuzione degli stack | una sola corsia per tutti gli stack: le operazioni di stack girano una dopo l'altra nel server; l'ordine per stack viene dal blocco `stack:<id>` | semplice; non blocca mai il lavoro dei siti |
| RU3 | §16 stato osservato | l'osservatore non scrive mai lo stato memorizzato; lo stato mostrato si calcola alla lettura (osservazione vecchia ⇒ `unknown`, componente non sano ⇒ `degraded` o `failed`) | §10.1 «il riconciliatore può solo leggere» |
| RU4 | §10.2.7 esito | un deploy con un componente accessorio non sano finisce `succeeded` con lo stack `degraded` (problema `STACK_HEALTH_TIMEOUT`); una pubblicazione delle route fallita finisce `failed` con lo stack `degraded` | «degraded o failed secondo la disponibilità dell'ingresso» |
| RU5 | §10.3 upgrade | sostituzione sul posto: il container vecchio di un componente cambiato si rimuove al passo `create` (lì comincia l'interruzione); a un fallimento successivo si rimuovono solo i container nuovi e lo stack resta `failed` fino a una rollback o a un redeploy; i dipendenti di un componente cambiato si riavviano, non si ricreano | nessun blue/green in v1 |
| RU6 | §10.2.7 primo deploy fallito | i container del primo deploy fallito restano (come i volumi), così i log si leggono; solo i fallimenti di upgrade, rollback o revisione nuova ripuliscono | diagnosi possibile |
| RU7, DX1, DX9 | §10.2 passi 4–7 come un solo flusso dell'esecutore; passo 6 «attendi health» | nove chiamate brevi e idempotenti guidate dall'API (un pull per immagine, preparazione, creazione, avvio o riavvio per componente, route); l'esecutore fa le sonde a richiesta (TCP o HTTP dall'host all'indirizzo del container); il ciclo d'attesa e il budget di 10 minuti per operazione (avvio e salute insieme), con una lettura ogni 5 secondi, sono dell'API | nulla aspetta minuti dentro una `POST`; un timeout è `unknown` e il recupero legge soltanto; esecutore senza stato |
| RU9 | §11 TLS degli stack nell'inventario | i certificati ACME degli stack non compaiono nell'inventario TLS dell'amministratore né negli avvisi dei certificati; i fallimenti si vedono sulle righe dei domini dello stack e nelle righe di audit `site.certificate.*` | quei lettori leggono solo i siti e non si toccano |
| RU10 | §10.4 recupero | il recupero non ripubblica nulla: se l'esecutore non mostra route `applied_routes_hash` diventa `null` (un aggiornamento delle route in dubbio che ne mostra registra un hash che nessun aggiornamento calcola), e uno stack `running` o `degraded` riceve le route dall'aggiornamento delle sole route che l'osservatore accoda da sé (§2.8), come ogni altra operazione registrata | il recupero resta in sola lettura |
| RU11 | §10.4 cancellazione | la cancellazione, con il runtime spento, di uno stack mai applicato si chiude senza chiedere nulla all'esecutore | non c'è nulla da leggere |
| DX3 | §3.6 rootfs in sola lettura «quando compatibile» | sempre in sola lettura, con un tmpfs `/tmp` da 64 MiB; l'elenco delle eccezioni è vuoto in v1 | le immagini iniziali non ne hanno bisogno; un'eccezione è una modifica del codice con un test |
| DX5 | §7.3 etichetta `organization_id` «solo se la policy lo consente» | messa su ogni risorsa di stack (chiave esistente `io.hostingpanel.organization_id`) | controllo della proprietà fra organizzazioni; la chiave serve già ai siti |
| DX7 | §11.1 «ripristino dell'ultimo file valido dopo errore» | validazione prima della scrittura e rinomina atomica (come per i siti); nessun passo di ripristino | sul disco c'è sempre il file precedente o quello nuovo, entrambi validi |
| DX10 | §3.7, B6 riavvio del server | i file dei segreti stanno in un tmpfs dell'host e si perdono a un riavvio dell'host: i componenti con segreti ripartono senza i loro file e restano rotti. Nulla riavvia o ripara lo stack da solo; il cliente o l'amministratore usa «Riavvia» (`stack.restart`), che riscrive i file prima di riavviare (un «Avvia» su un componente già acceso non fa nulla). È lo stesso meccanismo dei servizi generici (limite 24 di ADR-0027, `docs/architecture/adr/0027-restart-and-terminal.md`); limite noto 13 | meccanismo esistente imposto dal §3.7; un riavvio automatico romperebbe la regola per cui il riconciliatore non riavvia mai i container dei clienti (TH-10) |
| DX11 | (precedente dei siti) segreti cancellati all'arresto | all'arresto di uno stack i file restano fino alla rimozione | il mascheramento dei log e un riavvio di Docker continuano a funzionare; sempre solo tmpfs |
| DX12 | §12 volumi etichettati per proprietario | driver locale, nessuna quota di dimensione | il driver locale non ne ha; l'interfaccia non deve promettere un limite di dimensione |
| DX13 | §3.10 isolamento dal piano di controllo | nessun filtro d'uscita nell'esecutore: rete privata `Internal`, rete edge solo per i componenti HTTP, nftables dell'host per il metadata; una prova a livello di pacchetto richiede root (saltata nelle esecuzioni non root) | la base nftables è congelata (L20) |
| DX14 | §16 e §17 i log non contengono segreti | i log dei componenti si mascherano per valore esatto (almeno 6 caratteri) finché esistono i file dei segreti, prima del taglio delle righe a 2000 caratteri, e anche un pezzo di valore all'inizio o alla fine di una riga (tagli di riga, di frame e del limite di lettura), con un solo passaggio lineare (Aho-Corasick) su tutti i valori; i frame in cui Docker divide una riga si riuniscono come byte prima della decodifica e del mascheramento, e la riga tagliata dal limite di lettura si scarta (limite noto 28) | l'uscita del programma non è sotto il controllo della piattaforma |
| DA1 | §21 catalogo iniziale «descrizione in IT/EN» | la descrizione italiana sta in `app_templates.description`; quella inglese solo in `APP_BUILT_IN_TEMPLATES[].descriptionEn` e nella documentazione | una sola colonna di descrizione; i testi dei modelli sono dati dell'amministratore |
| DA2, LR | §3.5 allowlist «a livello codice/config» | solo codice (`APP_IMAGE_ALLOWLIST`, tre righe; nessuna `busybox`), nessun file di configurazione né schermata; lo script del motore (M3) usa una propria allowlist attraverso il punto d'iniezione dei test | nessuna configurazione nuova; ogni riga è una decisione del proprietario (BLOCKED.md #4) |
| DA3 | §19 script `accept-app-stack-*.mjs` «con … cert snapshots» | l'istantanea dei certificati copre la radice d'ingresso temporanea dello script; la directory d'ingresso dal vivo non si legge | installazione dal vivo su questa macchina |
| DA4 | §19 A11 «sensori reali», A14 «route HTTPS», B6 | provati qui la forma delle reti e le porte rifiutate; la lettura nft riservata a root è stata saltata in ogni esecuzione (nessun root); il blocco del metadata dal vivo, l'emissione ACME su un hostname reale e il riavvio restano al proprietario (`B6` è `PENDING (owner: …)`, le altre sono parti del proprietario di righe `PASS`) | nessun servizio metadata, nessun DNS pubblico, macchina condivisa |
| DA5 | §19 script «attraverso l'adattatore di produzione» | gli script chiamano l'adattatore di produzione `DockerEngineSocketAdapter` nel proprio processo, passo per passo come farebbe l'API, non attraverso l'API e l'IPC firmata | IPC e API sono provate dai test d'integrazione; l'adattatore è l'unico codice che parla con Docker |
| DA7 | §21 modelli iniziali «sicuri» | i modelli iniziali nascono disabilitati; il componente web del modello HTTP serve la pagina predefinita dell'immagine e non usa la cache | pubblica l'amministratore (§3.4); nessuna iniezione di file di configurazione in v1 |
| DW1 | §15 dettaglio «immagine/versione corrente» | il cliente vede il numero di versione del catalogo (e il numero di revisione), mai un riferimento d'immagine, un digest o un nome del motore | regola del lessico della console del cliente (`apps/web/test/ui-copy.test.ts`) |
| DW3 | §15 procedura «Domini/porte» | solo il passo «Domini» | le porte pubbliche sono Wave P |
| DW4 | §15 grafo dei componenti | un elenco per componente con il testo «Dipende da: …», nessun disegno | nessuna dipendenza nuova; leggibile da uno screen reader |
| DW6 | §15 catalogo con «icone originali/licenziate» | nessuna icona nelle schede del catalogo in questo rilascio | clean-room e licenze: nulla da licenziare |
| DW7 | §15 etichette dell'amministratore «porte pubbliche, Git build» | solo le etichette «HTTP» e «Storage» | quelle capacità non esistono in questo rilascio; un'etichetta le pubblicizzerebbe |
| DW8 | §15 segreti con «Sostituisci» | in più, nessun interruttore mostra/nascondi sul valore che si digita | più rigido e più semplice |
| DW9 | §15 navigazione «Modelli sito / Modelli applicazione» | sostituita nel secondo ciclo (§2.16): un solo elenco «Modelli» con una colonna «Tipo»; con il flag spento mostra solo i modelli WordPress, senza avvisi | richiesta del proprietario dopo la dimostrazione (L27) |
| DW10 | §8 l'amministratore che agisce per un cliente | durante una visita di supporto `/apps` mostra solo le applicazioni WordPress e la creazione offre solo WordPress; `/apps/<id>` e `/apps/new/<modello>` mostrano l'avviso | `app.*` non è fra i permessi dell'accesso di supporto (L13) |
| DW12 | etichette dei passi | i nomi dei passi mostrati al cliente vengono dai cataloghi del web per chiave di passo; l'etichetta inglese dell'API non si mostra | IT/EN (§15) |
| CB1 | (nessuna regola sugli id esterni) | gli id creati dalla modifica rispettano `APP_STACK_ID_PATTERN`; quelli dell'organizzazione e dell'allocazione `APP_FOREIGN_ID_PATTERN` (`^[a-z][a-z0-9_-]{0,127}$`) | le organizzazioni reali sono `org_<uuid>` con i trattini (rilievo alto S5-H1) |
| CB2 | §6.3 chiavi | la chiave di un servizio ha al più 27 caratteri (`APP_STACK_COMPONENT_KEY_MAX`); l'esecutore ricontrolla i nomi di al più 63 caratteri | `hp_app_<stackId>_<chiave>` deve essere un'etichetta DNS |
| CB3 | §7.3 nessuna shell | la regola delle shell vale in qualunque posizione dell'argv, per nome dell'ultimo segmento di percorso, con lanciatori come `env`, `busybox` e `toybox` | un interprete nascosto dietro un lanciatore o in seconda posizione; limite noto 15 |
| CB4 | §10.1 «il riconciliatore può solo leggere»; §11 route | l'osservatore accoda soltanto l'aggiornamento delle sole route (§2.8): nessun avvio, nessun ritiro rimandato, al più uno ogni cinque minuti finché cambia solo la salute; mai dopo uno `stack.stop` | un componente fermato a mano restava acceso dopo un aggiornamento (S5-M5), e un hostname tolto restava instradato (S5-M7); decisione del capo |
| CB5 | §9.2 segreti | al più 10 versioni nuove per stack in un'ora mobile, poi `429 RATE_LIMITED`; valori senza caratteri di controllo C0 (salvo tabulazione e a capo) né surrogati spaiati | le righe sono immutabili e il database è di tutti (S5-M2); il corpo dell'avvio resta sotto 1 MiB (S5-L3) |
| CB6 | §8 permessi | un deploy che porta `parameters` chiede `app.update` oltre ad `app.control` | cambiare le impostazioni è `app.update` (S5-L7) |
| CB7 | §9.2 upgrade | una bozza non si aggiorna mai; una bozza su una versione superata si cancella e si installa di nuovo | prima restava senza uscita (revisione M4b); meno casi |
| CB8 | §10.3 upgrade | prima di ogni rimozione l'esecutore controlla tutti i corpi nuovi e legge `GET /info` per i processori dell'host | un rifiuto di Docker dopo la rimozione lasciava il componente assente (S5-L4) |
| CB9 | §13 ripristino | la guardia «server nuovo» conta anche gli stack; dopo un ripristino la cancellazione rende `removed` i volumi `missing` e cancella i segreti | S5-L11, S5-M4 |

## 6. Minacce

Le contromisure valgono anche per i modelli scritti dall'amministratore: l'amministratore non è esente dalla gabbia (§17 della specifica) e non esiste una modalità «non sicura».

| Minaccia | Contromisura | Dove | Prova |
|---|---|---|---|
| T1 — Uscita dal container: `privileged`, `docker.sock`, dispositivi, montaggi dell'host, namespace dell'host, `cap_add`, `security_opt`, `sysctls`, `network_mode`, `userns_mode`, `pid`, `ipc`, `extra_hosts`, `cgroup_parent` in una sorgente | tabelle di chiavi ammesse (ogni altra rifiutata con motivo); la sorgente di un volume è una chiave dichiarata, mai un percorso; il costruttore dei container mette `CapDrop ALL`, nessun `CapAdd`, `no-new-privileges`, `ReadonlyRootfs`, nessun bind salvo i file dei segreti; l'esecutore ricontrolla piano e corpo della richiesta | `packages/policy-engine/src/app-template-keys.ts`, `packages/policy-engine/src/app-template-validation.ts`; `packages/contracts/src/app-templates/plan.ts`; controllo del piano e costruttore dei container dell'esecutore | tabella A4 in `packages/policy-engine/test/app-template-security.test.ts`; test di indurimento dell'esecutore; passo `container-hardening` degli script M7 (`docker inspect` reale) |
| T2 — Esecuzione di codice sull'host: `build`, script d'installazione, entrypoint di shell, `command: sh -c` | `build` rifiutato (`KEY_FORBIDDEN_HOST_ACCESS`); solo argv, nessun elemento è una shell o un lanciatore (`APP_STACK_SHELL_INTERPRETERS`, con `busybox`, `toybox` ed `env`; limite noto 15); `Entrypoint` mai impostato; il motore non usa l'API `exec` | `packages/contracts/src/app-templates/text.ts` (`appStackArgvExecutableProblem`, `appStackArgvItemProblem`); validatore; schema del piano | righe A4 e A7; `packages/contracts/test/app-stack-plan.test.ts` (shell rifiutata anche nel piano); scansione esistente AC-F2-01 |
| T3 — Fuga fra clienti o fra stack: reti, volumi e segreti condivisi; id indovinati | una rete privata e una edge per stack, con nomi dall'id dello stack; volumi per stack; chiavi esterne composte `(stack_id, organization_id)`; id di uno stack altrui → `404` prima di ogni lettura; l'AAD dei segreti lega organizzazione, stack, parametro e versione | `packages/database/migrations/0025_app_stacks.sql`; guardie delle route; repository dei segreti | B1; casi delle chiavi composte in `packages/database/test/app-stacks-database.test.ts`; scambio di AAD che fallisce; passo `no-cross-stack` degli script M7 |
| T4 — SSRF e furto del metadata: URL del controllo di salute, uscita verso `169.254.169.254` o `fd00:ec2::254` | il modello della salute non ha host, URL né schema: l'esecutore sonda l'indirizzo del componente, percorso fisso, nessun redirect, corpo limitato; la regola dei testi rifiuta gli indirizzi del metadata nella notazione usuale in ambiente e argv (limite noto 16); reti di stack bridge semplici, quindi coperte dalla regola `br-*` | `packages/contracts/src/app-templates/text.ts`; sonda e preparazione delle reti dell'esecutore; `infra/linux/nftables-dedicated.conf` (invariato) | `packages/contracts/test/app-template-text.test.ts`; test della sonda e delle reti; passo `network-shape`; replay della regola in `infra/linux/accept-m5-firewall.mjs`; metadata dal vivo `PENDING (owner: cloud VM)` |
| T5 — Esposizione dei segreti: ambiente, `docker inspect`, anteprime, log, hash, outbox, audit, errori, URL | i parametri `secret` solo come file `/run/secrets/<chiave>` in sola lettura, l'ambiente porta il percorso; piano, anteprima e hash portano solo `(parameterKey, version)`; testo in chiaro solo sulla route di sola scrittura e nell'IPC firmata al momento giusto; guardie delle chiavi di DTO, outbox e BFF; log mascherati | `packages/contracts/src/app-templates/plan.ts`, `packages/contracts/src/app-templates/parameters.ts`; guardie esistenti in `apps/api/src/create-app.ts` | A8: marcatore statico nei test del compilatore, test del repository dei segreti, scansione A8 dell'API, script del motore M3 (`Config.Env`, tmpfs `:ro`) |
| T6 — Abuso del parser YAML: ancore, alias, chiavi di fusione, tag, documenti multipli, bombe di profondità o di nodi, chiavi duplicate, `__proto__` | riuso del parser limitato senza modifiche (64 KiB, profondità 16, 4096 nodi) | `packages/contracts/src/site-templates/yaml-subset.ts` (invariato) | righe A5, ognuna sotto 200 ms |
| T7 — Iniezione attraverso i parametri: metacaratteri di shell, `${…}` al secondo passaggio, a capo e NUL, opzioni (`-x`), URL con credenziali | interpolazione a un passaggio, segnaposto solo come elemento intero, elemento riempito non vuoto e non con `-` iniziale, nessuna shell, valori tipizzati con limiti, segreti mai interpolati | `packages/policy-engine/src/app-template-compile.ts`; `packages/contracts/src/app-templates/parameters.ts`; `packages/policy-engine/src/site-template-interpolation.ts` (invariato) | righe A7; `packages/contracts/test/app-template-parameters.test.ts`; casi `PARAM_VALUE_ARGV_UNSAFE` e `RENDERED_VALUE_FORBIDDEN` del compilatore |
| T8 — Catena delle immagini: `latest`, tag mobili, registro non fidato, credenziali nell'URL, nomi somiglianti | digest obbligatorio, `latest` rifiutato, allowlist esatta nel codice (tre repository; cinque con `ADR-0039`), il piano porta `nome@sha256:…`, l'esecutore ricontrolla allowlist, digest e utente prima di ogni pull e scarica per digest | `packages/contracts/src/app-templates/images.ts` (`APP_IMAGE_ALLOWLIST`, `appStackPlanImageProblems`); passo di pull dell'esecutore | righe A13; `packages/contracts/test/app-template-images.test.ts`; nessun pull dopo un rifiuto; passo `refused-before-docker` (nessuna richiesta `images/*` fra quelle annotate dal socket intermedio dello script, §7) |
| T9 — Furto o collisione di porte: porte dell'host, bind su `0.0.0.0`, DNAT di Docker | nessuna porta dell'host in v1: `ports`, `x-hp-ports` e `port_choice` rifiutati; il costruttore non imposta mai `PortBindings`; `stackPublicPortsAvailable = false` | `packages/policy-engine/src/app-template-keys.ts`; costruttore dell'esecutore | A4 (`ports`); `x-hp-ports` → `STACK_UNSUPPORTED_FEATURE`; `PortBindings` vuoto nel passo `container-hardening`; il socket intermedio degli script rifiuta un container di stack con `PortBindings` |
| T10 — Esaurimento delle risorse: RAM, CPU, pids, disco, log, sonde a raffica | per componente CPU da 50 milli a 16 core, memoria da 32 MiB a 16 GiB, memoria = swap, `PidsLimit 256`, rotazione dei log json-file, intervallo e timeout delle sonde limitati, massimi per stack (8/8/8), numero di stack e addebito `resource_quotas` sotto il blocco della riga dell'organizzazione | `packages/contracts/src/app-templates/limits.ts`; costruttore dell'esecutore; limite degli stack nel database | righe A12; test del limite; B2 (due creazioni simultanee); `container-hardening` |
| T11 — Interruzione o ripetizione: crash dell'API, timeout della `POST` dopo la connessione, outbox vecchia, richiesta duplicata | `Idempotency-Key` più hash della richiesta; chiamate brevi e idempotenti; timeout dopo la connessione → `OPERATION_AMBIGUOUS` → `unknown`; il recupero legge soltanto lo stato e chiude; corsia degli stack sotto il lease dell'operazione; riparazione all'avvio | repository degli stack e runtime dell'API | A16, A17; passi `idempotent-reapply` e `recovery-reads-only` (fra le richieste annotate dal socket intermedio solo `GET`) |
| T12 — Upgrade o rollback distruttivi: rimozione di volumi, schema del database riportato indietro da un'immagine vecchia | upgrade e rollback non rimuovono mai un volume; conservazione `retain` predefinita; distruzione solo con conferma del nome e casella separata; la rollback mostra l'avviso sul rischio per i dati e non inverte mai i dati | repository degli stack; upgrade e rollback dell'API | A18, A19; passi `data-survives-upgrade-and-rollback` e `remove-keeps-volumes` |
| T13 — Modello ostile o scritto male dall'amministratore: immagine ostile, comando troppo ampio | editor solo per l'amministratore (`requireServerAdmin`); il validatore si riesegue a ogni uso nell'API (creazione, versione, installazione, upgrade), e l'esecutore fa il proprio controllo del piano (schema, hash, immagini, massimi); l'allowlist è codice, non dato dell'amministratore; nessuna modalità «non sicura» | controller del catalogo dell'amministratore; validatore; ricontrollo dell'esecutore | A2; `apps/api/test/admin-route-guard.integration.test.ts`; A4 e A13 |
| T14 — Cattura attraverso il proxy o accoppiamento con il proxy dal vivo: una rete edge raggiunta dal proxy della piattaforma, un hostname di stack che ne nasconde uno di un sito o del pannello | rete edge frequentata solo dai componenti con ingresso e dal proxy; file `app_<stackId>.yml` separato da `site_*.yml` e `hp-panel.yml`; provider Docker mai acceso; trigger di unicità `uq_panel_hostname_claim` fra `domains`, `app_stack_domains` e `hosts.hostname` | `apps/docker-executor/src/traefik-config.ts` (scrittore delle route degli stack); trigger di `packages/database/migrations/0025_app_stacks.sql` | B3; casi degli hostname in `packages/database/test/app-stacks-database.test.ts`; sentinella di Traefik; passo `route-published-after-health` (proxy usa e getta, proxy dal vivo intatto) |
| T15 — Movimento laterale da uno stack verso l'host del pannello: porte del gateway (PostgreSQL `127.0.0.1:5432` solo loopback; `hp-web` tcp 3000 aperta da ogni `br-*` per la regola congelata) | i container di stack non entrano in reti della piattaforma; nessuna porta dell'host; la console sulla 3000 è protetta dalla sessione (limite noto, §4) | costruttore delle reti dell'esecutore | passo `no-control-plane-reach` (5432, 3306, 4000 e, su questa macchina, anche 3000 rifiutate; la 3000 resta un limite noto dove la regola congelata la apre) |
| T16 — Perdita di dati al downgrade: l'operatore installa una release che non vede gli stack | gate `app-stacks`, uscita 8 salvo `--allow-feature-loss`; mai una cancellazione automatica | `infra/linux/lib/common.sh`, `infra/linux/update.sh` | `infra/linux/features-gate.test.ts`, caso nuovo in `infra/linux/update.test.ts`, test del predicato su PGlite |

## 7. Verifica

Ogni file di test si esegue da solo (`corepack pnpm exec vitest run <file> --maxWorkers=1 --no-file-parallelism`). L'ultima verifica completa registrata (build, lint, typecheck e test, dal hook pre-push su una copia pulita) è sul commit `ac35ac4`: 461 file passati, 12 933 test passati, 46 saltati (la precedente, su `96ec4c8`: 456 file, 12 767 test). Le due riparazioni del terzo giro (`2430024`, `8183a7d`) hanno superato l'esecuzione del capo dei test dell'esecutore e degli stack (128 file, 3 083 test) e i tre script su Docker reale; `release:build` e `release:smoke` sono passati su `39ea336`. La verifica della punta del ramo avviene al push, e il suo esito è nella descrizione della PR #37.

- **Contratti**: `packages/contracts/test/app-template-limits.test.ts`, `packages/contracts/test/app-template-issues.test.ts`, `packages/contracts/test/app-template-text.test.ts`, `packages/contracts/test/app-template-images.test.ts`, `packages/contracts/test/app-template-canonical.test.ts`, `packages/contracts/test/app-template-spec.test.ts`, `packages/contracts/test/app-template-parameters.test.ts`, `packages/contracts/test/app-stack-plan.test.ts` (con il fixture `app-stack-notes-demo`), `packages/contracts/test/app-stack-status.test.ts`, `packages/contracts/test/app-stack-operations.test.ts`, `packages/contracts/test/app-api-dto.test.ts`, `packages/contracts/test/app-stack-ipc.test.ts`, `packages/contracts/test/app-template-built-in.test.ts`, `packages/contracts/test/app-templates-schemas.qa.test.ts`.
- **Motore delle regole**: `packages/policy-engine/test/app-template-keys.test.ts`, `packages/policy-engine/test/app-template-graph.test.ts`, `packages/policy-engine/test/app-template-validation.test.ts`, `packages/policy-engine/test/app-template-security.test.ts` (A4, A5, A6, A7, A12, A13), `packages/policy-engine/test/app-template-compile.test.ts`, `packages/policy-engine/test/app-template-encoding-edges.test.ts`, `packages/policy-engine/test/app-template-built-in.test.ts`, `packages/policy-engine/test/app-template-pipeline.qa.test.ts`.
- **Dominio**: `packages/hosting-domain/test/app-stack-hash.test.ts`; porta dell'esecutore: `packages/executor-contracts/test/stack-port.test.ts`.
- **Database**: `packages/database/test/app-stacks-database.test.ts` (migrazione `0025`, vincoli, immutabilità, hostname), `packages/database/test/app-templates-repository.test.ts`, `packages/database/test/app-stacks-repository.test.ts`, `packages/database/test/app-stacks-lifecycle.test.ts`, `packages/database/test/app-stack-secrets-repository.test.ts`, `packages/database/test/app-stack-domains-repository.test.ts`, `packages/database/test/app-stack-limit.test.ts`, `packages/database/test/app-templates-built-in.test.ts`, `packages/database/test/app-stacks-downgrade-gate.test.ts`; esteso `packages/database/test/rollback-compat.test.ts`.
- **Esecutore**: `apps/docker-executor/test/app-stack-plan-check.test.ts`, `apps/docker-executor/test/app-stack-payload.test.ts`, `apps/docker-executor/test/app-stack-secrets.test.ts`, `apps/docker-executor/test/app-stack-health-probe.test.ts`, `apps/docker-executor/test/app-stack-engine.test.ts`, `apps/docker-executor/test/app-stack-ipc.test.ts`, `apps/docker-executor/test/app-stack-traefik-routes.test.ts`, `apps/docker-executor/test/app-stack-proxy-reattach.test.ts`, `apps/docker-executor/test/app-stack-main-seam.test.ts`, `apps/docker-executor/test/simulator-app-stacks.test.ts`, la sentinella `apps/docker-executor/test/app-stack-route-sentinel.test.ts` e le prove avverse (`apps/docker-executor/test/app-stack-hardening.qa.test.ts`, `apps/docker-executor/test/app-stack-health-probe.qa.test.ts`, `apps/docker-executor/test/app-stack-ipc.qa.test.ts`, `apps/docker-executor/test/app-stack-lifecycle.qa.test.ts`, `apps/docker-executor/test/app-stack-refusals.qa.test.ts`, `apps/docker-executor/test/app-stack-traefik.qa.test.ts`, `apps/docker-executor/test/simulator-app-stacks.qa.test.ts`); restano verdi `apps/docker-executor/test/traefik-routes.test.ts` e i pin dei tipi di sito.
- **API**: `apps/api/test/app-feature-gate.test.ts`, `apps/api/test/app-templates.integration.test.ts`, `apps/api/test/app-stacks.integration.test.ts`, `apps/api/test/app-stack-domains.integration.test.ts`, `apps/api/test/app-stack-upgrade.integration.test.ts`, `apps/api/test/app-stack-tls-coverage.integration.test.ts`, `apps/api/test/app-stack-limit.integration.test.ts`, `apps/api/test/app-stack-boot.integration.test.ts`, `apps/api/test/app-stack-runtime.unit.test.ts`, `apps/api/test/app-stack-runtime-policy.test.ts`, `apps/api/test/app-stack-recovery.unit.test.ts`, `apps/api/test/app-stack-observer.unit.test.ts`, `apps/api/test/app-stack-lane.unit.test.ts`, `apps/api/test/app-stack-logs.unit.test.ts`, `apps/api/test/app-stack-boot-sentinel.test.ts`, `apps/api/test/app-stack-seed-e2e.test.ts`, `apps/api/test/app-stack-site-witness.qa.test.ts` e le altre prove avverse (`apps/api/test/app-templates.qa.test.ts`, `apps/api/test/app-stacks-tenancy.qa.test.ts`, `apps/api/test/app-stacks-secrets.qa.test.ts`, `apps/api/test/app-stacks-lifecycle.qa.test.ts`, `apps/api/test/app-stack-concurrency.qa.test.ts`, `apps/api/test/app-stack-deploy.qa.test.ts`, `apps/api/test/app-stack-recovery.qa.test.ts`, `apps/api/test/app-stack-delete.qa.test.ts`, `apps/api/test/app-stack-secrets-runtime.qa.test.ts`, `apps/api/test/app-stack-domains.qa.test.ts`, `apps/api/test/app-stack-domains-http.qa.test.ts`, `apps/api/test/app-stack-upgrade.qa.test.ts`, `apps/api/test/app-stack-upgrade-http.qa.test.ts`); restano verdi `apps/api/test/site-type-pins.test.ts`, `apps/api/test/admin-route-guard.integration.test.ts`, `apps/api/test/openapi-routes.test.ts` (con `docs/api/openapi.yaml`) e `apps/api/test/infra-layout.test.ts`. I documenti e gli script di questa modifica sono fissati da `apps/api/test/app-stack-docs-layout.test.ts`.
- **Web**: `apps/web/test/app-stacks-text.test.ts`, `apps/web/test/admin-app-templates.test.ts`, `apps/web/test/admin-app-template-editor.test.ts`, `apps/web/test/app-templates-bff.test.ts`, `apps/web/test/app-stacks-bff.test.ts`, `apps/web/test/app-stacks-catalog.test.ts`, `apps/web/test/app-stacks-wizard.test.ts`, `apps/web/test/app-stacks-detail.test.ts`, `apps/web/test/app-stacks-actions.test.ts`, le prove `apps/web/test/m6-web-qa-guards.test.ts`, `apps/web/test/m6-web-qa-tenancy.test.ts`, `apps/web/test/m6-web-qa-flows.test.ts`, `apps/web/test/m6-web-qa-a11y.test.ts`; `apps/web/test/ui-copy.test.ts` esteso alla sezione `apps`.
- **Infra** — estesi: `infra/linux/features-gate.test.ts`, `infra/linux/update.test.ts`, `infra/linux/restore-panel.test.ts`, `infra/release/release-manifest.test.ts`. Script su Docker reale: `infra/linux/accept-app-stack-engine.mjs` (M3) e i due script dei modelli iniziali `infra/linux/accept-app-stack-http-cache.mjs` e `infra/linux/accept-app-stack-worker-storage.mjs` (M7). Ognuno usa l'adattatore di produzione collegato a un socket intermedio creato dallo script davanti a quello di Docker, che rifiuta ogni richiesta non ammessa e annota metodo e percorso di ognuna; lo script HTTP usa un proxy usa e getta su `127.0.0.1:16780/16743`. Le righe `RESULT` sono in §8.3.

**Esiti della matrice di accettazione** (§19 della specifica), riga per riga, con i comandi e il commit, nel report `docs/security/hcp-spec-005-acceptance-report.md`: 25 righe `PASS` e `B6` `PENDING (owner: …)` (riavvio di un'installazione reale). Quattro righe `PASS` hanno una parte del proprietario: `A11` (il passo nft che richiede root e il blocco del metadata su una VM cloud), `A14` e `B3` (emissione ACME su un hostname reale), `A20` (`hp-update` fra due release reali). `release:build` e `release:smoke` non sono ancora stati eseguiti in questo ciclo.

**Commit della PR #37** (le fasi si sono sovrapposte, quindi i commit sono atomici per pacchetto e per tema, non uno per milestone):

| Parte | Commit |
|---|---|
| M1 linguaggio, piano e hash | `1219728`, `36291ce`, `d44ff9d` |
| M2 dati, catalogo e fondamenta del runtime | `de3029c`, `ed3801f`, riparazioni `1c0ad33`, `c12c906` |
| M3 esecutore | `fc8a3da`, `9c8dc52`, `83d5e0b`, `8b8efd9`, riparazioni `1a0229f`, `57d4c7b` |
| M4–M5 corsia, recupero, API del cliente, domini, upgrade e rollback | `d0fcb9e`, `3e28190`, `1c29096`, riparazioni `560cc6e`, `99fe2c1`, `8d232da` |
| M6 web | `ef6d801`, `6a2ed2d`, `66c1bf7`, `96ec4c8` |
| M7 gate, ADR, script, documenti | `1b6ac74`, `5adc18b`, `31e6138`, `ec73b06` |
| Revisione di sicurezza, riparazioni | `43c8541`, `5d6aaee`, `fcfab26`, `2fae079`, `f9306a1`, `60efa54` |
| Secondo giro, riparazioni | `6d7ec4a` (mascheramento lineare dei log), `ac35ac4` (aggiornamento delle sole route) |
| Terzo giro, riparazioni | `8183a7d` (`fix16-refresh-recovery`), `2430024` (`fix16-log-frames`): fatte e provate dai loro test, non rilette da un quarto giro |

## 8. Come costruito: voci aperte

### 8.1 Da approvare dal proprietario

- **Gate W0**: l'allowlist e i digest delle tre immagini (§2.5, BLOCKED.md #4); le decisioni D1–D12 e questo ADR sono approvati (2026-11-22), e il proprietario ha confermato un solo ramo e una sola PR (#37, BLOCKED.md #3).
- **Gate W6**: accendere `applicationTemplatesAvailable` e `applicationStacksAvailable` su `linux-systemd`; l'accettazione sulle VM del proprietario con un'organizzazione reale; la prova del riavvio (B6); il passo `host-nft-metadata-drop-on-stack-net` eseguito da root (`HP_ACCEPT_ROOT_CASES=1`) e il blocco del metadata su una VM cloud (A11); l'emissione ACME su un hostname reale di uno stack (A14, B3); un `hp-update` fra due release reali (A20); il merge.

### 8.2 Seguiti registrati

- Risoluzione lato server del tag in digest (§3.5 della specifica, «MAY»).
- Certificati manuali sui domini degli stack.
- Wave P (porte TCP/UDP pubbliche, `app_stack_port_allocations`).
- Wave G (Git e build isolate).
- Backup degli stack.
- Estrazione degli helper del validatore oggi copiati dai modelli di sito.
- Descrizioni multilingua dei modelli.

### 8.3 Fatti misurati

Su una VM cloud di sviluppo (Linux 6.8.0-151-generic, 4 CPU, 7.8 GB di RAM, Docker Engine 29.10.0 con API 1.57, Node 26.13.1), accanto a un'installazione del pannello accesa, i cui quattro container sono stati trovati intatti dopo ogni esecuzione. Gli script non toccano il proxy `hp_ingress_proxy` e creano solo oggetti con il contrassegno dell'esecuzione (`swarmtest_<12 esadecimali>`, stack `stk_swarmtest_<12 esadecimali>`).

| Script | Prima esecuzione | Dopo le riparazioni del primo giro (07:05, albero del commit `f9306a1`) | Esecuzione del capo sul commit `ac35ac4` (07:38–07:41) |
|---|---|---|---|
| `infra/linux/accept-app-stack-engine.mjs` | `RESULT 25/25 passed, 1 skipped (not counted in n/m) in 70.3s` | `RESULT 25/25 passed, 1 skipped` | `RESULT 25/25 passed, 1 skipped (not counted in n/m) in 71.5s` |
| `infra/linux/accept-app-stack-http-cache.mjs` | `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 42.8s`; il socket intermedio ha visto 232 richieste e non ne ha rifiutata nessuna | `RESULT 20/20 passed, 1 skipped` | `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 39.1s` |
| `infra/linux/accept-app-stack-worker-storage.mjs` | `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 47.0s`; 311 richieste, nessuna rifiutata | `RESULT 20/20 passed, 1 skipped` | `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 48.0s` |

Il passo saltato è sempre `host-nft-metadata-drop-on-stack-net` (richiede root). Il conteggio è 20 e non quello del progetto perché ogni script ha in più il primo passo `gate-self-test`, e lo script del lavoro periodico anche `secrets-only-as-files`, su una variante del modello con un parametro segreto. Le immagini sono state scaricate per digest attraverso il socket intermedio alla prima esecuzione. Dopo l'esecuzione del capo sul commit `ac35ac4` i quattro container dal vivo erano gli stessi di prima e non restava nessun container, rete o volume con il contrassegno o con il prefisso `hp_app_`. Un albero con le riparazioni `fix16` non era ancora stato provato su Docker reale.

Misure di una sola esecuzione (`docker stats --no-stream`): `cache` (memcached) 1.875 MiB su 128 MiB, `web` (nginx) 4.641 MiB su 64 MiB, `storage` (valkey) 3.598 MiB su 128 MiB, `worker` 1.41 MiB su 32 MiB; CPU fra 0.00% e 0.14%. I tre controlli d'indurimento sono passati sulle immagini reali: filesystem radice in sola lettura, tutte le capability tolte, nessun processo come root. Il contatore del lavoro periodico è passato da 3 a 5 attraverso upgrade, rollback e riavvio dell'archivio. Dalla rete dello stack le porte 5432, 3306, 4000 e 3000 dei gateway sono risultate rifiutate.

Revisioni: nessun rilievo critico; un rilievo alto (gli id delle organizzazioni, S5-H1) riparato con il suo test; otto rilievi medi riparati, ciascuno con il suo test; il terzo e ultimo giro ha chiuso le due riparazioni del secondo (S5-M6, S5-M7) e ha trovato due medi nuovi (S5-M9, S5-M10), riparati dopo e provati dai loro test, ma non riletti da nessun quarto giro. Elenco e stato in `docs/security/audit-report.md`, sezione HCP-SPEC-005.
