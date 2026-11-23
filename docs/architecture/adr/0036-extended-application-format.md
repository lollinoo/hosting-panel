# ADR 0036 — Formato esteso delle applicazioni (`HCP-STACK/v2`), importatore Compose e WordPress dal catalogo

- **Stato:** `PROPOSTO` — scritto dall'agente su indicazione del proprietario del 2026-11-22 («partirei con WordPress ma vorrei funzionasse come funziona Coolify»); le scelte segnate «scelta dell'agente» non sono state confermate una per una e diventano definitive con il merge della PR #43
- **Data:** 2026-11-22
- **Riferimento:** `ADR-0035` (stack applicativi, che questo ADR modifica nei punti elencati al §2.1), `ADR-0015` (segreti), `ADR-0014` (Traefik a file); issue #42, PR in bozza #43; progetto in `docs/superpowers/specs/2026-11-22-extended-application-format-design.md`
- **Migrazioni:** nessuna (`app_template_versions.spec_version` accetta già valori ≥ 1; il piano è JSONB)

Questo ADR aggiunge un secondo formato di modello, `HCP-STACK/v2`, accanto a `HCP-STACK/v1`, che resta identico. Il v2 serve a far girare immagini ufficiali reali (per prima WordPress con MariaDB) senza dare a nessuno Compose libero né il socket Docker: immagini da qualunque registro ma sempre fissate per digest, un **profilo di esecuzione** chiuso al posto delle capability, segreti consegnati anche come variabili d'ambiente, valori generati dalla piattaforma, e un **importatore** che traduce un file Compose in una bozza v2 che l'amministratore rilegge prima di pubblicarla.

## 1. Contesto

`ADR-0035` ha costruito il catalogo con un formato volutamente stretto: tre immagini in un'allowlist, filesystem in sola lettura, nessuna capability, segreti solo come file. Con quelle regole le immagini ufficiali `wordpress` e `mariadb` non partono (scrivono nel proprio filesystem, cambiano proprietario ai file, scendono di utente da root, leggono le password dall'ambiente). Il proprietario vuole l'esperienza di un PaaS self-hosted, partendo da WordPress.

Nei PaaS di riferimento chi può modificare un'applicazione controlla di fatto il server: il file Compose è eseguito com'è. Qui si porta **che cosa fanno** quelle funzioni, non **come**: l'altro progetto ragiona per team, questo pannello per **cliente**. Tutto ciò che può toccare l'host (modelli, Compose, immagini, proxy) resta dell'amministratore del server; il cliente sceglie dal catalogo e compila un modulo breve.

Restano validi tutti i vincoli di `ADR-0035` §1: solo `hp-docker-executor` parla con Docker; nessuna dipendenza npm, programma dell'host o variabile d'ambiente nuova; clean-room (nessun file di modello copiato da altri progetti: i nomi `SERVICE_*` letti dall'importatore sono una convenzione d'interfaccia, il modello WordPress e i file di prova sono scritti da zero); il prodotto «sito WordPress gestito» non cambia.

## 2. Decisioni

### 2.1 Che cosa cambia di ADR-0035

| Punto di ADR-0035 | Prima | Ora |
|---|---|---|
| §2.3 formato | solo `schemaVersion: 1` | `1` (invariato) oppure `2` (§2.2) |
| §2.5, L5 immagini | digest + riga esatta di `APP_IMAGE_ALLOWLIST` | v1 invariato; v2: digest obbligatorio, repository libero (§2.3) |
| §2.4, L16–L18 corpo del container | un solo corpo indurito | v1 invariato; v2: profilo `strict` (lo stesso corpo) o `standard` (§2.4) |
| §2.6, L6 segreti | solo come file | v1 invariato; v2: anche come variabile d'ambiente, e valori generati (§2.5, §2.6) |
| §2.12 catalogo iniziale | due modelli | più `atpl_wordpress_mariadb` (§2.9) |
| §2.13, L19 flag | tutti `false` | `applicationTemplatesAvailable` e `applicationStacksAvailable` `true` su `linux-systemd` (§2.10) |
| §8.2 seguiti | risoluzione del tag in digest | consegnata (§2.7) |

Tutto il resto di `ADR-0035` (reti, ingresso e TLS, quote, operazioni, volumi, permessi, downgrade `app-stacks`) vale anche per il v2.

### 2.2 Due formati affiancati, non uno allargato

`AppTemplateSpecSchema` e `ApprovedStackPlanSchema` diventano unioni discriminate su `schemaVersion`: l'oggetto v1 non riceve nessuna chiave nuova, quindi una sorgente v1 produce la stessa specifica, lo stesso hash e lo stesso piano di prima, e un piano v1 già salvato resta valido. Una chiave del v2 in una sorgente v1 è `KEY_UNKNOWN`. Il validatore, il compilatore e l'esecutore decidono per versione in pochi punti nominati; non esiste una modalità «non sicura» né un'opzione che allenti il v1.

### 2.3 Immagini (v2)

Il digest resta obbligatorio e `latest` resta rifiutato: il piano porta solo `nome@sha256:…` e l'esecutore scarica per digest e ricontrolla `RepoDigests`. Cade soltanto il vincolo dell'allowlist: l'amministratore può pubblicare un modello con un'immagine di qualunque registro pubblico. Se il repository ha una riga in `APP_IMAGE_ALLOWLIST`, l'utente forzato di quella riga vale ancora. L'allowlist continua a valere per intero sui modelli v1.

Motivo: l'allowlist nel codice rendeva impossibile un catalogo vero; il digest e la gabbia del §2.4 sono le difese che contano. L'immagine la sceglie solo l'amministratore del server.

### 2.4 Profilo di esecuzione (v2)

Ogni servizio v2 dichiara `x-hp-profile: strict | standard` (assente = `strict`). Il nome è l'unica cosa che una sorgente o un piano possono dire: né capability, né utente, né `privileged`, né percorsi dell'host, né porte. Il significato sta in una costante dell'esecutore.

| | `strict` (il corpo di ADR-0035) | `standard` |
|---|---|---|
| Filesystem radice | sola lettura | scrivibile |
| Capability | tolte tutte | tolte tutte, poi aggiunte **solo** `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, `NET_BIND_SERVICE` |
| `/tmp` | tmpfs da 64 MiB | quello dell'immagine |
| `PidsLimit` | 256 | 512 |
| Uguale nei due | `Privileged: false`, `no-new-privileges:true`, memoria = swap, quota di CPU, reti dello stack, solo volumi con nome, file dei segreti in sola lettura, nessun `Entrypoint`, nessuna porta dell'host, log json-file 10m × 3 |

L'elenco delle capability è misurato (§7), non copiato: senza `DAC_OVERRIDE` o `FOWNER` WordPress non parte; `KILL` non serve per un arresto pulito. È un sottoinsieme delle capability predefinite di Docker. `assertAppStackPayloadHardening` confronta il corpo con quello chiuso del profilo, chiave per chiave.

### 2.5 Segreti nell'ambiente (v2)

Molte immagini leggono le password solo dall'ambiente. Nel v2 una voce `secret:` il cui nome non finisce in `_FILE` è consegnata come variabile d'ambiente, e `${chiave}` di un parametro segreto è ammesso dentro un `value` dell'ambiente (mai in `command`).

- Il **piano non contiene il valore**: porta `secretEnvironment[{ name, pieces }]`, dove ogni pezzo è un testo letterale oppure `{ parameterKey, version }`, come già fa `secretFiles`. Piano, anteprima, hash, outbox, audit, DTO e log non vedono il testo in chiaro.
- Il valore viaggia solo nella chiamata IPC firmata `create` (campo transitorio `secretContents`, inviato solo se il piano ne ha bisogno) e in quella di avvio; l'esecutore lo scrive in `Config.Env` del container e non lo restituisce mai (non legge `Config.Env` nelle ispezioni che espone).
- Ruotare un segreto = nuova versione → nuovo piano → il componente è ricreato (l'hash del componente copre i pezzi).
- L'esecutore scrive comunque ogni segreto del componente nella sua directory su tmpfs, così il mascheramento dei log copre anche i segreti d'ambiente; nel container sono montati solo quelli di tipo file.
- Una voce senza riferimenti a segreti conserva le regole del v1 (nomi e valori che sembrano segreti sono rifiutati).

Limite accettato: chi può eseguire `docker inspect` sull'host (root) legge l'ambiente di un container; è lo stesso livello di fiducia che già legge i file dei segreti su tmpfs.

### 2.6 Valori generati (v2)

Un parametro `secret` può dichiarare `generate: { kind, length }` con `kind` fra `password`, `hex`, `base64`, `user`. L'API genera il valore con `node:crypto` alla creazione dello stack (e a un upgrade che introduce un parametro generato nuovo) e lo salva come riga normale di `app_stack_secrets`, versione 1. Con `customer: false` (ammesso solo insieme a `generate`) il cliente non lo vede e non può cambiarlo; con `customer: true` può sostituirlo dalla route dei segreti. Il cliente non digita mai una password per installare.

### 2.7 Dal tag al digest

Nuovo metodo dell'esecutore `resolveAppStackImage`: chiede al motore `GET /distribution/<nome[:tag]>/json` e restituisce il digest dell'indice. Lo usa solo l'importatore; non invia credenziali (registri pubblici).

### 2.8 Importatore Compose (solo amministratore)

Funzione pura in `packages/policy-engine`: Compose in ingresso, bozza v2 più un **rapporto** (voci `changed`, `dropped`, `refused`, `info`) in uscita. La route `POST /v1/admin/app-templates/import-compose` risolve i digest, esegue l'importatore e restituisce bozza, rapporto e verdetto del validatore; non salva nulla. L'amministratore rilegge la bozza nell'editor esistente e la salva dalle route esistenti, che la validano di nuovo. Ciò che può toccare l'host (`privileged`, `cap_add`, dispositivi, rete dell'host, percorsi dell'host, `docker.sock`, `build`) è **rifiutato**, non tradotto; le porte pubblicate e le opzioni senza effetto qui sono **tolte** con una riga nel rapporto. Le variabili `SERVICE_PASSWORD_*`, `SERVICE_USER_*`, `SERVICE_BASE64_*`, `SERVICE_HEX_*` diventano parametri generati; `SERVICE_FQDN_*` e `SERVICE_URL_*` diventano un ingresso. Il lettore è il sottoinsieme YAML esistente: un file con ancore o scalari a blocchi è rifiutato con riga e colonna. Le regole complete sono nel progetto, §7.

### 2.9 Modello WordPress

`atpl_wordpress_mariadb` (v2, scritto per questo repository): `wordpress` (immagine ufficiale, profilo `standard`, volume su `/var/www/html`, ingresso sulla porta 80) e `db` (`mariadb` ufficiale, profilo `standard`, volume su `/var/lib/mysql`, solo rete privata), con due segreti generati. È seminato **disattivato** come gli altri modelli iniziali: lo pubblica l'amministratore. Licenze: WordPress GPL-2.0-or-later, MariaDB Server GPL-2.0-only; il pannello non ridistribuisce le immagini, le scarica l'esecutore.

### 2.10 Flag

`applicationTemplatesAvailable` e `applicationStacksAvailable` valgono `true` sul backend `linux-systemd` (scelta dell'agente: la accende un commit separato, così il proprietario può toglierlo dalla PR). `stackPublicPortsAvailable` e `gitBuildsAvailable` restano `false`. Il merge della PR è la decisione del gate W6 di `ADR-0035` §8.1; le prove sulle VM del proprietario elencate lì restano da fare e sono riportate nella PR.

### 2.11 Compatibilità e downgrade

- v1: stessa specifica, stesso hash, stesso piano; i test esistenti non cambiano.
- Una versione di modello salva la versione del proprio formato (`spec_version` 1 o 2).
- Nuovo gate di downgrade `app-format-v2`: `hp-update` rifiuta (codice 8) una release che non conosce il v2 finché esiste uno stack non cancellato installato da una versione v2, o che conserva una revisione scritta nel v2 (una destinazione di rollback che la release precedente non saprebbe leggere). Il gate guarda gli stack, non i modelli: la release 0.9.0 mostra un modello v2 con cifre a zero all'amministratore e lo lascia fuori dal catalogo del cliente, e ogni pannello ha la riga del modello WordPress integrato; un gate sui modelli rifiuterebbe ogni downgrade. Il gate `app-stacks` resta com'è.

## 3. Alternative scartate

- **Eseguire il Compose così com'è**: chi scrive il file controlla il server. Contrario a `ADR-0035` e a `HARNESS.md`.
- **Allargare il v1**: cambierebbe il significato dei modelli già salvati e renderebbe condizionali le garanzie del v1.
- **Capability scelte dal modello** (anche da un elenco ammesso): ogni modello diventerebbe una decisione di sicurezza; un profilo chiuso si verifica una volta.
- **Segreti solo come file anche nel v2**: molte immagini non leggono `*_FILE`; servirebbe uno script d'avvio, cioè una shell.
- **Allowlist dei registri**: non ferma un'immagine ostile su un registro ammesso; il digest e la gabbia sì.

## 4. Limiti noti

1. Lo strato scrivibile di un container `standard` non ha un limite di spazio proprio. I log sì (10 MiB per tre file); i volumi no, come già deciso in `ADR-0035` §2.11.
2. I segreti d'ambiente sono leggibili da root sull'host con `docker inspect` (§2.5).
3. L'importatore non legge ancore, scalari a blocchi e chiavi di fusione; un controllo di salute `exec` diventa una sonda TCP.
4. Nessuna variabile «URL dello stack» dentro un modello: WordPress prende l'indirizzo dalla richiesta.
5. Registri privati non supportati.
6. Un valore sotto un nome che sembra un segreto deve essere un segreto: non c'è un'eccezione per i falsi positivi.

## 5. Minacce (aggiunte a ADR-0035 §6)

| Minaccia | Contromisura |
|---|---|
| T17 — Un modello v2 chiede più privilegi di quelli del profilo | la sorgente e il piano non hanno chiavi per capability, utente, dispositivi o percorsi; il profilo è un nome chiuso; l'esecutore ricostruisce e ricontrolla il corpo |
| T18 — Segreto d'ambiente che esce dal piano, dall'anteprima, dai log o dagli errori | il piano porta solo chiave e versione; i tre cercatori di chiavi vietate girano sull'intero piano; mascheramento dei log sui valori del componente; l'esecutore non restituisce `Config.Env` |
| T19 — Immagine ostile o sostituita | digest obbligatorio, pull per digest, controllo di `RepoDigests`; l'immagine gira nella gabbia del profilo, su reti dello stack, senza porte dell'host |
| T20 — L'importatore traduce in silenzio qualcosa di pericoloso | ciò che tocca l'host è rifiutato; ogni cambiamento è una riga del rapporto; la bozza passa dal validatore stretto prima di essere salvata |
| T21 — Risoluzione dei digest usata per sondare la rete | solo l'amministratore, attraverso il motore Docker, senza credenziali; nome dell'immagine validato |

## 6. Verifica

Test unitari di contratti, validatore, compilatore, importatore ed esecutore (per profilo); test dell'API sul simulatore (installazione con segreti generati, route d'importazione); script su Docker reale `infra/linux/accept-app-stack-wordpress.mjs`; il comando di verifica del repository. Le righe di `HARNESS.md` che cambiano sono la 12 e la 22.

## 7. Fatti misurati

Docker Engine 29.10.0, immagini `wordpress:7.1.4-php8.4-apache@sha256:4bf2c44f19a5eba28de4e5cbe50e1c5dc55ae3f8b894f681f4d7676a7e2512e5` e `mariadb:12.3.3@sha256:4aaf88b3106382c8c18e49f0cec60267be618fc22f858c4503afb2a2555afed3`, corpo `standard` (`--cap-drop ALL` più le sei capability, `no-new-privileges`, 512 pid, memoria = swap = 512 MiB, volumi con nome, database solo su una rete `--internal`):

- entrambi partono; WordPress risponde `200` su `/wp-admin/install.php` senza errori di database; un riavvio con i volumi esistenti funziona;
- `docker stop -t 10` termina in 1,2 s e 0,16 s con uscita 0, senza `KILL`;
- WordPress raggiunge `https://api.wordpress.org` dalla rete edge; il database, solo sulla rete privata, non esce;
- maschera effettiva `00000000000004cb`; `mariadbd` gira come `mysql` con `CapEff 0` e `NoNewPrivs: 1`;
- senza `NET_BIND_SERVICE` funziona tutto (resta nell'elenco per le immagini che ascoltano sotto la 1024 come utente non root); senza `DAC_OVERRIDE` WordPress esce con 1 (`wp-config.php: Permission denied`); senza `FOWNER` esce con 2 (`tar: … Cannot change mode`);
- `GET /distribution/<nome:tag>/json` sul socket del motore risponde 200 con `Descriptor.digest` uguale al digest dell'indice del registro.

## 8. Come costruito

Questa sezione registra ciò che il codice fa dove il testo dei §2–§4 e del progetto era generico o è stato precisato durante il lavoro. Dove non dice altro, vale il testo sopra. Sono tutte scelte dell'agente, come quelle del §2.

### 8.1 Formato, piano ed esecutore

- **Limiti dei segreti d'ambiente** (`APP_STACK_SECRET_ENV_LIMITS` in `packages/contracts/src/app-templates/limits.ts`): un segreto usato in una variabile d'ambiente è lungo al massimo 4 096 **byte** UTF-8 (non caratteri); un valore ha al massimo 4 riferimenti a segreti e 9 pezzi; il valore espanso è lungo al massimo 32 768 byte.
- **Forma canonica dei pezzi.** In `secretEnvironment` due testi letterali vicini sono un pezzo solo e ogni voce ha almeno un riferimento a un segreto: lo schema del piano rifiuta le altre forme, così lo stesso valore ha un solo hash.
- **Una versione per segreto.** In un piano v2 ogni chiave di segreto ha una sola versione, fra file e ambiente: una sola voce di contenuto serve i due usi.
- **Segreto facoltativo non impostato.** La variabile d'ambiente è omessa, come il file nel v1; non diventa una stringa vuota.
- **Anteprima.** `profile` e `secretEnvironment` sono chiavi facoltative dell'anteprima, presenti solo per un corpo v2: l'anteprima di un piano v1 non cambia di un byte.
- **Tipi per versione.** I contratti esportano i tipi dei due formati con il suffisso `V1` e `V2` (`AppTemplateSpecV1`, `AppTemplateSpecV2`, `ApprovedStackPlanV1`, `ApprovedStackPlanV2` e quelli di parametro, servizio e componente).
- **Il v2 contiene il v1.** Una sorgente v1 in cui si scrive `schemaVersion: 2` è una sorgente v2 valida; i suoi servizi hanno il profilo `strict`.
- **Dal tag al digest** (§2.7): è la route IPC di sola lettura `GET /v1/app-stacks/image-digest?image=…` dell'esecutore. La ricerca nel motore ha un tempo massimo di 30 s, la chiamata del client di 40 s. Per un'immagine che il registro non conosce il motore non risponde `200` (misurato: `403`) e l'esecutore rifiuta con `STACK_IMAGE_PULL_FAILED`.
- **Controllo del corpo** (`assertAppStackPayloadHardening` in `apps/docker-executor/src/app-stacks/container-payload.ts`): `Env` deve contenere le voci in chiaro del piano, uguali e nello stesso ordine, poi una voce per ogni segreto d'ambiente con il nome scritto nel piano. Il valore di un segreto è opaco per il controllo; il testo letterale intorno è quello del piano ed è controllato, anche per `docker.sock`. Un corpo con le chiavi del profilo `standard` è accettato solo insieme al piano che dichiara quel profilo.

### 8.2 API

- **Che cosa vede il cliente.** Il catalogo del cliente riceve i parametri nella forma del v1, senza i segreti generati: il modulo d'installazione non chiede mai un valore generato. Il dettaglio di un'applicazione non elenca i segreti con `customer: false`; un segreto generato con `customer: true` compare come impostato.
- **Che cosa vede l'amministratore.** Le route dei modelli restituiscono i parametri di tutte e due le forme. Nel contratto OpenAPI (`docs/api/openapi.yaml`) sono schemi distinti: `AppTemplateParameter` per il cliente, `AdminAppTemplateParameter` e `AppSecretGenerate` per l'amministratore.
- **Quando si genera.** Alla creazione dello stack (anche in bozza) e a un upgrade che introduce un parametro generato nuovo, dentro la stessa transazione dell'operazione; mai a una ripetizione idempotente. L'anteprima di un upgrade non scrive nulla. L'audit registra solo i nomi dei parametri generati (`generatedParameterKeys`).
- **Route dei segreti.** Per un segreto con `customer: false` la route risponde come per una chiave sconosciuta. Un valore più lungo di 4 096 byte per un segreto usato nell'ambiente è rifiutato.
- **Consegna.** `secretContents` parte con la chiamata `create` solo se il piano ha segreti d'ambiente; avvio e riavvio inviano solo i segreti del componente.

### 8.3 Modello WordPress

Categoria `content`. Slug `wordpress-mariadb`. I due componenti hanno un controllo di salute `tcp` (porta 80 e porta 3306) e il limite di 1 CPU e 512 MiB ciascuno. Il nome del database e quello dell'utente sono valori fissi (`wordpress`); le due password sono generate, lunghe 32 caratteri, con `customer: false`. Il modello non installa WordPress: dopo aver collegato il dominio, chi apre il sito per primo completa la prima configurazione (§8.8).

### 8.4 Importatore

Le regole complete sono nel progetto, §7, e nei test di `packages/policy-engine/test`. Quelle decise durante il lavoro:

- **Riconoscere un segreto.** Per nome (la variabile finisce con una parola da segreto), per posto (la password dentro un indirizzo, letta come la legge un client: dopo il primo `:` che segue `://`, fino all'ultima `@` prima del primo `/` o spazio, anche quando contiene una `@` non codificata) o per testo (un valore che il file scrive anche sotto un nome da segreto). Un valore debole (per esempio `wordpress`) è sostituito solo sotto un nome da segreto o al posto della password di un indirizzo, non dovunque compaia.
- **Valori condivisi.** Due variabili con lo stesso segreto diventano un solo parametro generato; un segreto riconoscibile scritto dentro un altro valore è tagliato via e sostituito dal riferimento, e il resto del valore resta. Il taglio viene prima della ricerca della password di un indirizzo: un indirizzo che ripete la password scritta sotto un'altra variabile ne condivide il parametro.
- **Impostazione sotto un nome da segreto.** Un interruttore, un numero o un percorso sotto un nome che sembra un segreto (per esempio `MARIADB_RANDOM_ROOT_PASSWORD: "yes"`) è **tolto** con una riga del rapporto: un modello non può portare un valore in chiaro sotto quel nome e un segreto generato avrebbe un altro significato.
- **Credenziali esterne.** Una chiave di un servizio esterno scritta nel file diventa un valore generato a caso: l'amministratore deve sostituire il parametro nella bozza con uno che il cliente compila.
- **Comandi.** Un comando che porta un segreto è rifiutato: un modello è pubblicato com'è scritto.
- **Controlli di salute.** Un controllo `CMD` che chiede un indirizzo HTTP locale diventa un controllo `http` sullo stesso percorso; se l'indirizzo ha una query, un frammento o un percorso che un modello non accetta, o se il comando è un altro, diventa un controllo `tcp`. I tempi fuori dai limiti sono portati al limite, con una riga del rapporto.
- **Limiti.** Più di 64 segreti diversi scritti in chiaro: nessuna bozza; oltre il limite l'importatore non crea un parametro per ogni segreto in più, e se il limite è superato già prima della conversione dei servizi il file è rifiutato lì, senza le righe del rapporto sui servizi. Un rapporto ha al massimo 200 righe. Una chiave che l'importatore non conosce rifiuta il file.

### 8.5 Route d'importazione e pagine web

- **Risposta.** `{ source, report, validation }`; `source` e `validation` sono `null` quando l'importatore rifiuta il file. La route non salva e non registra nulla nell'audit, come la route di validazione.
- **Ordine dei controlli.** Amministratore del server, poi `applicationTemplatesAvailable`, poi il corpo (al massimo 64 KiB in UTF-8).
- **Ricerca dei digest.** In parallelo, al massimo otto immagini. Se il registro rifiuta un'immagine, quella resta senza digest e il rapporto la nomina (`IMAGE_UNRESOLVED`). Ogni altro errore (motore spento, tempo scaduto) fa fallire tutta la richiesta con `DOCKER_ENGINE_UNAVAILABLE`, ripetibile, e un testo fisso: ciò che dice l'esecutore non arriva al chiamante.
- **Pagine.** **Amministrazione › Modelli › Importa da Compose**: file, nome e categoria; poi il rapporto, raggruppato per gravità, e la bozza nell'editor esistente, già validata. La bozza si salva solo da lì. La route del pannello web aspetta la risposta al massimo 60 s. La categoria predefinita di una bozza importata è `apps` («Altre applicazioni»).

### 8.6 Flag

I flag seguono il backend di esecuzione nel codice: `appFeaturesFor` in `packages/contracts/src/resources.ts` dà i quattro valori, `createPlatformCapabilities` li usa quando nessuno gliene passa altri, e `resolveAppFeatureGate` in `apps/api/src/app-stacks/app-feature-gate.ts` li registra nell'API. Nessuna variabile d'ambiente e nessuna opzione di avvio li cambia; solo un test può passarne altri. Su `local-simulator` restano tutti `false`: una prova locale del catalogo passa ancora i flag al proprio avvio di prova. Il flag è letto solo dalle route: accenderlo non avvia nessun lavoro in background, e un server senza stack non fa nessuna chiamata a Docker per gli stack.

### 8.7 Prove su Docker reale

Lo script `infra/linux/accept-app-stack-wordpress.mjs` è stato eseguito il 2026-11-22 su Docker Engine 29.10.0, da un utente non root, su una macchina che ospita anche un pannello in funzione. Parte dal piano: lo compila con il motore di policy, lo passa all'adattatore dell'esecutore e raggiunge Docker solo attraverso il proprio socket filtrato. Non passa dall'API né dalle pagine web, e il proxy è una copia a perdere su `127.0.0.1`, in HTTP.

| Esecuzione | Esito | Tempo | Richieste a Docker (rifiutate) |
| :--- | :--- | :--- | :--- |
| Modello integrato | 21/21, 1 passo saltato | 40,5 s | 312 (0) |
| `--imported`: la bozza importata dal file Compose dei test dell'importatore | 22/22, 2 passi saltati | 48,8 s | 372 (0) |
| `--imported` con `HP_ACCEPT_REGISTRY_CASES=1` | 23/23, 1 passo saltato | 52,7 s | 399 (0) |

- **Che cosa provano.** Un piano con una chiave vietata è rifiutato prima di qualunque richiesta a Docker. Il corpo dei container è quello del profilo `standard`; ogni segreto arriva solo al suo componente; un container non raggiunge il pannello. La route è pubblicata dopo il controllo di salute e WordPress si installa davvero dalla sua pagina di prima configurazione. I dati restano dopo arresto, avvio e upgrade; il lettore dei log nasconde i segreti d'ambiente; la rimozione conserva i volumi, la distruzione dei dati li toglie e alla fine non resta nulla.
- **Bozza importata.** L'importazione toglie 4 voci del file, ne cambia 5 e scrive 7 note. La bozza ha tre valori generati (anche l'account del database) e supera gli stessi controlli del modello integrato. Il file nomina le versioni fissate dal modello integrato e l'importazione riceve i digest registrati con esse, così non si scarica nulla di nuovo. Con `HP_ACCEPT_REGISTRY_CASES=1` lo script chiede anche i due tag al registro pubblico attraverso il prodotto: una lettura per tag, nessun'altra richiesta, e gli stessi due digest.
- **Passo saltato.** `host-nft-metadata-drop-on-stack-net` chiede root: resta fra le voci del gate W6 (§8.9).
- **Incidente con il pannello in funzione.** In un'esecuzione precedente del modello integrato l'esecutore del pannello installato sulla stessa macchina ha collegato il proprio proxy alla rete edge della prova: lo collega a ogni rete con l'etichetta di ruolo `app_edge`, chiunque l'abbia creata. I passi di rimozione sono falliti (18/21) e la rete è rimasta. Il proxy del pannello non è stato riavviato e ha continuato a rispondere; è stato staccato a mano dalla rete della prova, poi la rete è stata rimossa. Ora il filtro dello script scrive in Docker un altro valore di quell'etichetta per la rete edge della prova e lo traduce nei due sensi, e due controlli nuovi lo provano. Nelle tre esecuzioni della tabella nessun container del pannello è stato collegato a una rete della prova. I due script più vecchi che creano una rete edge non hanno ancora questa protezione (#52).

### 8.8 Limiti noti aggiunti al §4

7. Un segreto scritto in chiaro che l'importatore non riconosce né per nome, né per posto, né per testo resta nella bozza: l'amministratore deve rileggerla (§2.8).
8. Il controllo di salute non è cercato per segreti; un percorso con un segreto resterebbe nella bozza.
9. La ricerca anonima dei digest conta nei limiti di frequenza del registro; un tempo scaduto fa fallire tutta l'importazione.
10. «Importa un altro file» scarta le modifiche non salvate della bozza.
11. I parametri di una bozza importata hanno come etichetta il nome della variabile, e una categoria scritta nell'intestazione del file che il pannello non conosce è mostrata com'è.
12. I segreti generati alla creazione contano, dopo, nel limite orario dei segreti che il cliente può cambiare.
13. Un segreto di tipo file lungo fino a 24 576 byte, impostato sotto una versione precedente e poi usato più volte in un valore d'ambiente dopo un upgrade, può superare i 32 768 byte: la creazione è rifiutata con `STACK_PLAN_INVALID` prima che qualcosa sia rimosso.
14. WordPress resta aperto alla prima configurazione finché qualcuno non la completa: chi apre il dominio per primo sceglie l'utente amministratore.

### 8.9 Da approvare dal proprietario

- Questo ADR (`PROPOSTO`) e le scelte E1–E14 di `.agents/brain/decisions.md`.
- Il commit che accende i due flag (§2.10): è separato dagli altri e si può togliere dalla PR.
- Le voci del gate W6 di `ADR-0035` §8.1 ancora aperte: l'accettazione sulle VM del proprietario con un'organizzazione reale, la prova del riavvio, il passo `host-nft-metadata-drop-on-stack-net` eseguito da root, l'emissione ACME su un hostname reale di uno stack, un `hp-update` fra due release reali, il merge.

### 8.10 Seguiti registrati

Ogni seguito è una issue del repository; nessuno fa parte di questa PR.

| Issue | Che cosa | Limite |
| :--- | :--- | :--- |
| #44 | L'importatore legge ancore, chiavi di fusione e scalari a blocchi | §4, 3 |
| #45 | Controlli di salute con un comando dentro il componente | §4, 3 |
| #46 | L'indirizzo pubblico dell'applicazione dentro un modello | §4, 4 |
| #47 | Limite di spazio per lo strato scrivibile del profilo `standard` | §4, 1 |
| #48 | Immagini da registri che chiedono un accesso | §4, 5 |
| #49 | Aiuti alla revisione di una bozza importata: eccezione per un'impostazione sotto un nome da segreto, credenziali esterne, etichette e categorie | §4, 6 e 11 |
| #50 | I segreti generati non devono contare nel limite orario del cliente | §4, 12 |
| #51 | Chiudere la finestra della prima configurazione di un WordPress appena installato | §4, 14 |
| #52 | Gli script di accettazione più vecchi nascondono la rete edge della prova a un pannello in funzione | §8.7 |

Restano limiti scritti, senza issue: il 2 (è la scelta del §2.5) e i limiti 7, 8, 9, 10 e 13. Una capability in più per il profilo `standard` (per esempio `KILL`) si valuta solo quando un'immagine la chiede: oggi nessuna delle due immagini misurate ne ha bisogno.
