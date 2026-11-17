# ADR 0023 — Strumenti WordPress (M4a): Versioni, Aggiornamenti con Copia Preventiva e Reimpostazione della Password di un Amministratore

- **Stato:** `APPROVATO — M4a`
- **Data:** 2026-11-15
- **Riferimento:** spec `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md` (§3.1 scheda WordPress e card «aggiornamenti in attesa», §3.8), `CP-01`, `ADR-0016`, `ADR-0019`, `ADR-0021`, `ADR-0022`
- **Migrazioni:** `0012_wordpress_tools.sql` (additiva: tabella `site_wordpress_state`; il vincolo `site_backups_kind_check` accetta anche `pre_update`)

## 1. Contesto

Il cliente di un sito WordPress deve poter fare tre cose senza uscire dal pannello:

1. vedere la versione di WordPress, i plugin e i temi con le loro versioni, e quali di essi hanno un aggiornamento;
2. aggiornare WordPress, un plugin, un tema o tutto insieme, con una copia del sito presa subito prima;
3. riprendere l'accesso a wp-admin reimpostando la password di uno degli amministratori del sito.

Tutto passa da wp-cli, lo strumento a riga di comando di WordPress. wp-cli carica il codice del sito (`wp-config.php`, i drop-in e, senza i flag di esclusione, plugin e temi). Quindi il codice del cliente gira dentro questi lavori e il loro output non è affidabile (`§5`).

M4a aggiunge la scheda **WordPress** (seconda scheda, dopo Panoramica) e la card «aggiornamenti in attesa» della Panoramica. Ripara anche un difetto già spedito nello script di installazione (`§6`). L'importazione guidata di un sito (spec §3.9) è M4b, il ciclo successivo.

## 2. Decisioni

### 2.1 Quattro tipi di lavoro chiusi, nell'executor

Ogni azione è un lavoro di sito (`runSiteJob`) avviato solo da `hp-docker-executor`, in un contenitore effimero sull'immagine `wordpress:cli-2.12.0-php<ver>` (utente `33:33`, volume dei file del sito). L'elenco dei tipi è chiuso: vive in `packages/executor-contracts/src/port.ts`, nell'enum zod di `packages/contracts/src/ipc-schemas.ts` e nella tabella `SITE_JOB_SPECS` di `apps/docker-executor/src/site-jobs.ts`. Un tipo nuovo (M4b) aggiunge una riga a quella tabella.

| Tipo | Parametri | Segreti | Rete | Limite | Risultato |
|---|---|---|---|---|---|
| `wordpress.inspect` | `phpVersion` | nessuno | rete del sito + rete edge | `240 s` | stato del sito |
| `wordpress.update` | `phpVersion`, `target` = `all` \| `core` \| `plugin:<nome>` \| `theme:<nome>` | nessuno | rete del sito + rete edge | `240 s` | esito per elemento |
| `wordpress.settle` | `phpVersion` | nessuno | solo rete del sito | `60 s` | nessuno |
| `wordpress.reset-password` | `phpVersion`, `userId` (`/^[1-9][0-9]{0,9}$/`) | `HP_ADMIN_PASSWORD` (file) | solo rete del sito | `60 s` | nessuno |

- **Script costanti.** Ogni tipo ha un solo script fisso. I valori della richiesta arrivano allo script solo come variabili `HP_*` già passate dal controllo chiuso del tipo; i segreti solo come file sotto `/run/secrets`. Nessun valore entra mai nel testo di uno script o di un frammento PHP. Il nome di un elemento da aggiornare deve rispettare `WORDPRESS_ITEM_NAME_PATTERN` (`/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/`), quindi non inizia mai con `-`.
- **Lo script di avvio dell'immagine non gira (`R139`).** Per ogni tipo sull'immagine wp-cli (i quattro nuovi e i già spediti `wordpress.install` e `wordpress.set-url`) tutta la riga di comando sta in `Entrypoint` e il payload non ha `Cmd`, come già nei lavori di backup e ripristino. Così lo script di avvio dell'immagine (`docker-entrypoint.sh`) non gira mai: prima girava per primo e interrogava wp-cli nella cartella del sito, quindi il codice del sito girava prima dello script del lavoro, senza esclusioni e fuori dal limite di tempo.
- **Il lavoro si ferma da solo (`R139`).** L'`Entrypoint` dei quattro tipi nuovi è `["timeout","-s","KILL","<limite in secondi + 5>","sh","-c",<script>]` e ogni tipo sull'immagine wp-cli ha `HostConfig.Init: true`. Il processo init è il processo 1 del contenitore e lo script no: senza init lo script era il processo 1, il kernel scarta un `KILL` mandato dall'interno al processo 1 e il limite non scattava mai. Così il contenitore si uccide al limite anche se l'executor è fermo. Di norma il timer dell'executor arriva prima e riporta `124`. All'avvio l'executor rimuove i lavori rimasti (`cleanupOrphanJobs`). `wordpress.install` e `wordpress.set-url` non hanno un limite proprio (`sh -c <script>` in `Entrypoint`); i lavori sull'immagine MariaDB (`db.provision`, `db.drop`) restano `["sh","-c",…]` in `Cmd`, perché lo script di avvio di quell'immagine non fa nulla per `sh`.
- **Log limitato per ogni lavoro.** Ogni lavoro di sito, anche dei tipi vecchi, ha `LogConfig` `json-file` con `max-size` `1m` e `max-file` `1`. Così il log su disco e la sua lettura restano limitati anche se il sito inonda l'output.
- **Attese.** Il client IPC attende `75 s` per la reimpostazione (`WORDPRESS_RESET_CLIENT_WAIT_MS`), sotto gli `85 s` della route BFF. Per gli altri tipi resta l'attesa spedita di `510 s`. La reimpostazione non scarica mai l'immagine: se manca risponde `DOCKER_ENGINE_UNAVAILABLE` («The site tools are not ready yet. Retry in a few minutes»), così i suoi tempi reggono. Controllo e aggiornamento scaricano l'immagine quando serve.
- **Codici di uscita** (tradotti da `wordpressJobReason` in `packages/contracts/src/site-wordpress.ts`): `21` `not_wordpress`, `22` `broken_configuration`, `23` `database_unreachable`, `30` `wordpress_org_unreachable`, `31` `item_unknown`, `32` `update_failed`, `40` `not_administrator`, `64` `bad_request`, `70` `result_unreadable`, `124` e `137` `timed_out`, ogni altro `other`. Un'uscita `0` senza un risultato valido, per un tipo che ne deve dare uno, vale `result_unreadable`.
- **Un sito fermo funziona.** I lavori hanno bisogno solo del volume e di `hp_mariadb` (provato sul motore reale). Controllo, aggiornamento e reimpostazione non rifiutano un sito `stopped` (`R129`).

### 2.2 Il risultato: un canale suo, limitato e ricontrollato

- Il risultato viaggia **solo** sullo standard output. Il corpo di ogni script con risultato gira come `{ … } >&2`; solo il convertitore PHP finale, costante, scrive sullo standard output (una falsificazione tramite `php://fd/3` è stata provata e respinta). Questo non chiude il canale al codice del sito, che gira con lo stesso utente del lavoro: può **guastarlo** (per esempio tramite `/proc/1/fd/1`, dove il sistema permette quella scrittura; il lavoro finisce allora con un risultato illeggibile, `result_unreadable`; nel collaudo sul motore reale il codice ostile non ci è riuscito, ma il limite resta scritto perché nulla nel progetto lo vieta) e può **falsificare l'elenco del proprio sito** entro lo schema (per esempio preparando i file temporanei che lo script legge). Non può superare i tetti, uscire dallo schema, parlare per un altro sito né ottenere un permesso. La coda mostrata agli amministratori viene solo dallo standard error.
- Tetto `256 KiB` (`WORDPRESS_RESULT_MAX_BYTES = 262_144`), applicato da `readJobStdout` prima di tenere i byte in memoria.
- `parseWordpressJobResult` valida con zod nell'executor; il client IPC dell'API valida di nuovo. Un risultato che non passa viene scartato (non solleva errore) e la ragione diventa `result_unreadable`.
- Limiti dello schema: al massimo `500` plugin, `200` temi, `200` amministratori, `701` elementi in un aggiornamento. Nel lavoro, un titolo è tagliato a `200` caratteri e ripulito dai caratteri di controllo e bidirezionali; una versione è tagliata a `40` caratteri; un login a `60`; una versione vuota diventa `null`. Un nome, uno stato o un conteggio non validi rifiutano **tutto** il risultato.
- Un nome in un risultato è una stringa qualsiasi di `1–200` caratteri senza caratteri di controllo (la cartella di un plugin può contenere uno spazio). Il pattern stretto vale solo per il bersaglio di un aggiornamento.

### 2.3 Rete e «aggiornato» detto solo dopo aver chiesto

- Controllo e aggiornamento devono raggiungere wordpress.org. Ricevono la stessa portata del contenitore web del sito: la sua rete interna (per il database) e la sua rete edge (per Internet), niente di più. L'adattatore crea il lavoro sulla rete interna, cerca la rete edge e la collega prima dell'avvio. Gli altri due tipi restano sulla sola rete interna.
- Su Docker `29.9.2` collegare un contenitore creato a una rete che non esiste risponde `200`; è l'avvio a fallire con `404`. Per questo l'adattatore **cerca** prima la rete edge: se manca (`404`) il lavoro gira senza Internet; se la ricerca dà un altro errore risponde con la frase fissa «Could not connect the site tools to the internet», che non nomina alcuna rete.
- Senza Internet wp-cli esce `0` e non riporta aggiornamenti. Lo script di controllo quindi prova prima `curl --max-time 15` verso `api.wordpress.org` (un comando che non carica codice del sito). Se fallisce, restituisce comunque le versioni installate con `updatesKnown: false`. La scheda dice allora che il controllo non ha raggiunto wordpress.org e propone di riprovare, **mai** «aggiornato». Un aggiornamento che non raggiunge wordpress.org esce `30` e non cambia nulla. Un controllo senza Internet non tocca la cache degli aggiornamenti di WordPress (provato).
- **Anche le ricerche di WordPress devono rispondere (`R140`).** Dopo la prova, WordPress fa le proprie ricerche (WordPress, plugin, temi) con limiti di tempo brevi; se una fallisce, ogni elemento si legge «nessun aggiornamento». La regola è che `updatesKnown` sia vero solo quando, in quel controllo, anche queste ricerche hanno avuto risposta, anche su un sito senza alcun plugin (`R147`); altrimenti il risultato non porta `coreUpdate` né `updateVersion`, come un controllo senza Internet. Quanto di questa regola è costruito e provato sul motore reale, e per quali ricerche, lo dice la Parte 7 di `docs/security/step-4-acceptance-report.md`.

### 2.4 Ogni lavoro porta solo i segreti del proprio sito

Un lavoro che carica WordPress riceve solo segreti di quel sito: la password del suo database (che sta già nel suo `wp-config.php`) e la password che si sta impostando per uno dei suoi amministratori. Mai la chiave root di MariaDB, un segreto del pannello, la chiave dei backup o qualcosa di un altro sito. Un test fissa i nomi dei segreti ammessi per tipo. Nessun lavoro usa più `--prompt` (`§6`).

### 2.5 Lo stato salvato

- Una riga per sito nella tabella `site_wordpress_state` (`site_id` chiave primaria, `organization_id`, `state` e `last_update` in `JSONB`, `updated_at`; chiave esterna verso `sites` con `ON DELETE CASCADE`, quindi la riga sparisce con il sito). I salvataggi controllano l'organizzazione.
- `state` contiene: quando è stato controllato (`checkedAt`), la versione di WordPress (`coreVersion`) e il suo aggiornamento (`coreUpdate`), plugin e temi (`name`, `title`, `status`, `version`, `updateVersion`), gli amministratori (solo `id` e `login`), `updatesKnown` e un `problem` quando il sito non si è potuto leggere.
- Solo l'applier scrive la riga, e solo da un risultato validato. Se il lavoro esce `21`, `22` o `23` salva una riga con `problem` (`not_installed`, `config_broken`, `database_unreachable`), `coreVersion: null` e liste vuote. Ogni altro fallimento lascia lo stato com'era.
- Lo stato si aggiorna: (a) con «Controlla ora»; (b) alla fine di ogni aggiornamento; (c) dalla scheda stessa, una volta per apertura, quando lo stato manca o ha `12 h` o più (`WORDPRESS_STATE_STALE_MS`) e nulla è in corso. Il controllo automatico non viene mai ripetuto e i suoi errori sono silenziosi. La card della Panoramica legge solo lo stato e non avvia nulla.

### 2.6 Due operazioni e una chiamata diretta

- **Operazioni.** `site.wordpress.inspect` (passo `inspect`) e `site.wordpress.update` (passi `backup`, `update`, `settle`), elencate in `WORDPRESS_OPERATION_KINDS`. Rispondono `202`, poi la scheda segue l'avanzamento. Hanno `resourceType: "site"`, `resourceId` uguale all'id del sito e il lock `site:<id>`: una seconda richiesta mentre una è in coda o in corso riceve `RESOURCE_LOCKED`.
- **Una corsia propria.** Girano in una quinta corsia dell'outbox, così un aggiornamento lungo non ritarda creazione dei siti, domini, deploy, file o backup di alcun sito. Il lease è `SITE_STEP_LEASE_MS` (`12` minuti), rinnovato prima di ogni lavoro; il caso peggiore di un lavoro è scaricamento `240 s` + esecuzione `240 s` + circa `20 s`.
- **Ripresa dopo un'interruzione** (`recoverUnknownOperations`, un ramo per tipo). Un controllo interrotto finisce fallito («The check was interrupted. Press Check now.») senza chiamare l'executor. Un aggiornamento il cui esito non è noto **non viene mai rimandato**: se la copia non era finita, la recovery ne legge l'esito (`settleBackupJob`) e, a copia chiusa, termina senza aggiornare (`interrupted` o `backup_failed`); se l'aggiornamento era partito, esegue `wordpress.settle` e `wordpress.inspect` con nuovi id di lavoro, salva lo stato e registra `outcome_unknown` («The outcome of the update is not known. Check the versions below.»). Un aggiornamento già partito viene terminato senza la sistemazione e il controllo (`wordpress.settle`, `wordpress.inspect`) solo quando il suo sito, o il bersaglio salvato, non c'è più per sempre; un errore passeggero (una connessione al database caduta) lascia l'operazione `unknown` per il giro successivo (`R141`, `R147`). Una fine già scritta non si scrive mai una seconda volta: se `lastUpdate` porta già l'id dell'operazione, la recovery dà all'operazione solo il suo stato finale, senza lavori e senza un secondo evento di audit (`R142`).
- **La reimpostazione della password è una chiamata diretta e sincrona** (`§2.8`).

### 2.7 Un aggiornamento: copia, aggiornamento, sistemazione

- **Richiesta:** esattamente una tra *tutto*, *WordPress*, *un plugin* (per nome), *un tema* (per nome). «Tutto» esegue WordPress, poi i plugin, poi i temi, in **un solo** lavoro `wordpress.update`. Il nome di un plugin o tema deve essere nello stato salvato, altrimenti `400 VALIDATION_ERROR` con ragione `item_unknown`.
- **Passo `backup`.** Quando i backup sono configurati sul server, nella stessa transazione dell'accodamento viene inserita una riga `site_backups` di tipo `pre_update` che porta l'id dell'operazione. Il passo esegue la copia con il codice di backup già spedito (`runBackupStep`, estratto senza copiarlo da `SiteBackupsApplier`). Se la copia fallisce, **nulla viene aggiornato**, i passi `update` e `settle` sono saltati e il problema è `backup_failed`. Se i backup non sono configurati il passo è registrato come saltato; la finestra di conferma lo aveva detto al cliente prima.
- **Passo `update`.** Il lavoro restituisce per ogni elemento `type` (`core`, `plugin`, `theme`), `name`, `oldVersion`, `newVersion` e `status` (`updated` o `failed`), salvati con l'esito.
- **Passo `settle`**, eseguito **sempre** dopo un tentativo di aggiornamento, anche dopo un errore o un tempo scaduto: `wordpress.settle` rimuove il file `.maintenance` di WordPress con un comando che non carica codice del sito (un aggiornamento ucciso lascia il sito in `503`), poi `wordpress.inspect` rilegge e salva lo stato. Se `settle` fallisce si segna fallito solo quel passo; l'esito segue l'aggiornamento (WordPress stesso ignora un `.maintenance` più vecchio di `10` minuti).
- **Esito.** Riuscito quando ogni elemento chiesto è aggiornato o non c'era nulla da aggiornare. Altrimenti fallito con un problema della lista chiusa `WORDPRESS_PROBLEMS`: `wordpress_org_unreachable`, `config_broken`, `database_unreachable`, `not_installed`, `backup_failed`, `items_failed`, `item_unknown`, `outcome_unknown`, `interrupted`. Uscite `70`, `124`, `137`, `other` e gli errori non ambigui dell'executor danno `outcome_unknown`. Non esiste un ripristino automatico: la frase dice quali elementi sono falliti e che sotto Backup c'è la copia di poco prima, quando è stata presa.
- **Limiti.** Un aggiornamento conta come un'azione pesante (`HEAVY_BACKUP_OPERATION_KINDS`) nel limite spedito di `6` per sito e per ora, condiviso con backup manuali, ripristini e download.
- **Conservazione delle copie.** Si tengono le `3` copie `pre_update` riuscite più recenti di un sito (`PRE_UPDATE_BACKUPS_KEPT`), separate dalle `3` manuali (non ne occupano i posti). Valgono ancora la scadenza per età e la regola per cui la copia riuscita più recente di un sito esistente non si cancella mai (`ADR-0022 §2.6`).

### 2.8 La reimpostazione della password

1. Stessi controlli delle altre route (`§2.9`), poi il controllo «occupato»: se un'operazione tiene `site:<id>` la risposta è `409 RESOURCE_LOCKED`.
2. `userId` deve rispettare `/^[1-9][0-9]{0,9}$/` ed essere un amministratore nello stato salvato, altrimenti `400 VALIDATION_ERROR`, ragione `administrator_unknown`.
3. La password la crea il pannello con il generatore già usato per gli utenti database (`24` caratteri `[A-Za-z0-9]`).
4. Arriva **solo al lavoro**, come file `/run/secrets/HP_ADMIN_PASSWORD`. Lo script, con codice PHP costante (`wp eval` fra apici singoli), ricontrolla che l'utente esista e sia amministratore (altrimenti esce `40`), esegue `wp_set_password(wp_slash(<contenuto del file>))` e chiude tutte le sessioni di quell'utente (`destroy_all`). `wp_slash` serve perché al login WordPress confronta la password «con le barre». `wp_set_password` non invia email.
5. La risposta `200` contiene `temporaryPassword` **una sola volta e solo se il lavoro è uscito `0`**. La password non viene salvata da nessuna parte: né `encrypted_secrets`, né righe, né eventi, né log. La route BFF risponde con `Cache-Control: no-store`.
6. Errori: uscita `40` → `400 administrator_unknown`; uscite `21`, `22`, `23` → `503` con ragione `not_installed`, `config_broken` o `database_unreachable` (la password **non** è cambiata); un lavoro che ha girato ed è uscito con un altro errore → evento con `outcome: "failed"`. Quando la fine del lavoro **non è stata vista** (l'attesa è scaduta, errore dell'executor) o il lavoro è stato fermato al limite o ucciso (uscite `124` e `137`, `R143`) la risposta è `503` con ragione `unavailable` e l'evento di audit dice `outcome: "unknown"`, non `failed`: la password potrebbe essere cambiata. La scheda dice che la reimpostazione non si è potuta confermare e di rifarla.

### 2.9 Chi può fare cosa, route e audit

- **Route** (prefisso `/v1/organizations/:orgId/managed-sites/:siteId`): `GET wordpress` (stato salvato, operazione in corso, esito dell'ultimo aggiornamento, `backupsConfigured`), `POST wordpress/refresh` (`202`, `Idempotency-Key` obbligatoria), `POST wordpress/updates` (`202`, `Idempotency-Key` obbligatoria), `POST wordpress/administrators/:userId/password-reset` (`200`).
- **Permessi:** nessuna chiave nuova. Leggere chiede `site.read`; «Controlla ora», aggiornare e reimpostare chiedono `site.update` (proprietario e amministratore hosting dell'organizzazione; mutante, quindi rifiutato a un'organizzazione sospesa). Il sito di un'altra organizzazione risponde `404` su ogni route.
- **Controlli in ordine** (le tre `POST`): autorizzazione (`404` prima di tutto); capacità spenta → `422 NOT_SUPPORTED` `wordpress_unavailable`; sito non WordPress → `422 NOT_SUPPORTED` `not_wordpress`; sito `deploying` o `maintenance` → `409 RESOURCE_LOCKED` `not_ready`. Nessun rifiuto per un sito fermo. La `GET` chiede solo `site.read` e risponde `200` con uno stato vuoto (`state: null`, nessuna operazione in corso, nessun ultimo aggiornamento) quando la capacità è spenta o il sito non è WordPress (`R138`).
- **Quali siti.** Un sito WordPress è riconosciuto da un solo helper, `isWordpressSite` (oggi `phpVersion !== null`; `M6` lo sostituirà con il tipo di sito). La capacità `wordpressToolsAvailable` vale `true` solo su `linux-systemd` (`isWordpressToolsAvailable`); altrove le tre `POST` rispondono `NOT_SUPPORTED`, la `GET` lo stato vuoto e la scheda non compare; la pagina aperta dal suo indirizzo mostra «non disponibile» senza chiamare l'API (`R144`).
- **Eventi di audit:** `site.wordpress.refresh` e `site.wordpress.update` alla richiesta, con l'attore; `site.wordpress.update.finished` alla fine (attore di sistema; con bersaglio, esito, problema, stato della copia e i conteggi degli elementi aggiornati e falliti, mai gli elementi); `site.wordpress.password_reset` (con `userId` e `login`). Nessun evento, messaggio di operazione o riga di log contiene una password, un segreto o l'output grezzo di un lavoro. Le pagine dell'amministratore non cambiano: la pagina Audit mostra i nuovi eventi come gli altri.

### 2.10 La scheda WordPress e la Panoramica

- Seconda scheda, solo quando `isWordpressSite(site)` e `wordpressToolsAvailable` sono entrambi veri.
- Una riga con la versione di WordPress, quando è stata controllata e «Controlla ora». Se gli aggiornamenti sono sconosciuti o il sito non si è potuto leggere: una frase che dice cosa è successo e cosa fare, mai una tabella vuota.
- Tabelle per WordPress, plugin e temi: nome, stato, versione installata, nuova versione e «Aggiorna» per riga; «Aggiorna tutto» quando c'è almeno un aggiornamento. Per un nome che non rispetta il pattern di `§2.1` non c'è il pulsante per riga; «Aggiorna tutto» lo copre comunque.
- Ogni aggiornamento chiede conferma in una finestra che dice la conseguenza: il sito può non rispondere per qualche istante, prima viene presa una copia (oppure che **nessuna copia** sarà presa, se i backup non sono configurati) e la copia si ripristina dalla scheda Backup.
- Durante un'operazione l'avanzamento per passi resiste al ricaricamento della pagina; dopo, l'esito dell'ultimo aggiornamento con l'elenco per elemento.
- Gli amministratori con «Reimposta password»: conferma che dice che la password attuale smette subito di funzionare e che la persona viene disconnessa ovunque, poi la nuova password mostrata una volta nella stessa finestra dei flussi SFTP e database.
- La Panoramica ha la card «aggiornamenti in attesa» (numero e collegamento alla scheda; «non ancora controllato» senza stato). Nell'attività recente compare l'aggiornamento, non il controllo.
- Ogni testo esiste in italiano e in inglese e non dice Docker, container, image, network, volume, revision o job.

## 3. Alternative scartate

- **Leggere WordPress dal vivo a ogni apertura della pagina:** lenta (circa `5 s` per lavoro) e invierebbe l'indirizzo del sito a wordpress.org ogni volta.
- **Aggiornamenti automatici o pianificati:** il cliente deve scegliere quando il sito può non rispondere per qualche istante; restano fuori da M4a.
- **Ripristino automatico dopo un aggiornamento fallito:** un ripristino sostituisce tutto il sito, anche le scritture fatte nel frattempo. Il pannello indica la copia; decide il cliente.
- **Inviare la nuova password per email:** l'email resta in una casella; la password è mostrata una volta e basta.
- **Un lettore di avanzamento generico condiviso con i backup:** avrebbe toccato un file spedito di 943 righe; la scheda ha un piccolo ciclo proprio.
- **Leggere il risultato da un file nel contenitore finito, o con `exec 3>&1`:** il canale con `{ … } >&2` è più semplice e respinge un valore falsificato accanto a quello del convertitore (`§2.2` dice anche cosa non impedisce).
- **Rifiutare un sito fermo:** provato inutile, i lavori funzionano anche a sito fermo (`R129`).

## 4. Limiti accettati e note di funzionamento

1. **Il codice del sito gira nei lavori che caricano WordPress.** Può leggere i segreti del proprio sito, usare l'account database del sito e raggiungere ciò che raggiunge già il contenitore web del sito. Può guastare il canale del risultato (il lavoro finisce `result_unreadable`) e falsificare l'elenco del proprio sito (versioni, aggiornamenti) entro i limiti dello schema (`§2.2`). Non può superare i tetti del risultato e del log, uscire dallo schema, parlare per un altro sito, ottenere un permesso o sopravvivere al limite di tempo (quest'ultimo vale da `R139`, `§2.1`).
   - *Cosa significa per il cliente:* un sito compromesso può mostrare nella propria scheda dati falsi su se stesso o far fallire il proprio controllo, mai su altri siti e mai permessi in più.
2. **Un aggiornamento di WordPress non è stato misurato su un sito grande.** Il limite è `240 s`; un lavoro ucciso a metà è seguito da `settle`, che toglie la pagina di manutenzione e rilegge le versioni vere.
   - *Cosa deve fare il cliente:* leggere le versioni mostrate dopo l'esito e, se il sito non va, ripristinare la copia dalla scheda Backup.
3. **wordpress.org può smettere di rispondere subito dopo la prova.** Un aggiornamento finisce allora con elementi falliti o con l'uscita `30`, mai con «aggiornato». Per un controllo, nella stessa breve finestra, il lavoro di norma fallisce (`other`) e lo stato salvato non cambia; l'architetto dell'executor nomina un caso raro, non gestito, in cui un elenco potrebbe uscire senza un aggiornamento che esiste.
   - *Cosa deve fare il cliente:* premere di nuovo «Controlla ora».
4. **L'uscita `23` copre anche «file presenti ma WordPress non installato»** e viene mostrata come database non raggiungibile.
5. **Una copia molto grande occupa la corsia WordPress.** Il passo `backup` attende la copia dentro la corsia propria degli strumenti WordPress (fino alle `6 h` già spedite). Nel frattempo i controlli e gli aggiornamenti di **altri** siti aspettano; creazione dei siti, domini, file e backup no.
6. **Le copie `pre_update` oltre la terza** vengono rimosse al successivo giro di backup del sito, non subito.
7. **Il testo `QUOTA_EXCEEDED` dell'API dice ancora «backup actions».** La frase della scheda (`site.backups.errors.tooMany`) è stata cambiata e nomina anche gli aggiornamenti di WordPress.
8. **Vecchie righe di audit non riscritte (`§6`).** Il registro di audit è di sola aggiunta: gli eventi scritti prima di questa versione per un'installazione fallita possono contenere un frammento della password del database del sito. Sono leggibili solo dagli amministratori del server.
   - *Cosa deve fare l'amministratore:* considerare esposte le password database dei siti la cui installazione era fallita prima di M4a.
9. **Lo stato può avere fino a `12 h`.** Un controllo automatico che fallisce non viene ripetuto fino alla prossima apertura della scheda.
10. **Un aggiornamento con esito sconosciuto non viene ripetuto.** Il pannello rilegge le versioni e lascia la scelta al cliente.
11. **Una reimpostazione la cui fine non è stata vista** lascia la password sconosciuta: potrebbe essere cambiata senza che il cliente l'abbia vista. *Cosa deve fare il cliente:* reimpostarla di nuovo.
12. **Il controllo «occupato» e il lavoro di reimpostazione non sono un passo unico.** Un'operazione accodata nell'istante fra i due può girare insieme alla reimpostazione.
13. **Nessuna copia senza backup configurati.** Il cliente lo legge nella finestra di conferma prima di confermare.
14. **Plugin must-use e drop-in** sono mostrati con il loro stato; WordPress di norma non offre per loro una nuova versione, quindi di solito non hanno «Aggiorna».
15. **Un lavoro fermato perché usa troppa memoria si legge come «ci ha messo troppo».** Il kernel lo uccide con la stessa uscita `137` di un lavoro ucciso al limite di tempo (`timed_out`; per un aggiornamento `outcome_unknown`).
   - *Cosa significa per il cliente:* il messaggio parla di tempo anche quando il sito ha chiesto troppa memoria; un nuovo controllo mostra le versioni vere.
16. **Un riavvio del pannello durante la sistemazione dopo un aggiornamento** (`R142`) fa leggere l'esito come «non noto», anche se il passo di aggiornamento è mostrato come fatto.
   - *Cosa deve fare il cliente:* premere «Controlla ora»; il nuovo controllo mostra le versioni.
17. **Le reimpostazioni della password non hanno un tetto** (`R143`). Solo il proprietario o un amministratore hosting può chiederle e ognuna è registrata nell'audit. L'executor rifiuta un secondo lavoro dello stesso tipo sullo stesso sito mentre il primo gira, quindi una seconda reimpostazione nello stesso momento risponde come una fine non vista (audit `unknown`).
   - *Cosa deve fare il cliente:* aspettare la prima reimpostazione; se il messaggio dice che non si è potuta confermare, rifarla.
18. **I controlli non hanno un tetto orario e tutti i siti condividono una sola corsia per il lavoro WordPress** (`R131` a). Un server occupato li ritarda.
   - *Cosa significa per il cliente:* un controllo o un aggiornamento può restare in attesa qualche minuto prima di partire.
19. **La stessa `Idempotency-Key` inviata con una richiesta diversa** risponde con la prima operazione: è la regola comune a ogni operazione.
   - *Cosa significa per il cliente:* l'esito dell'ultimo aggiornamento (`lastUpdate.target`) mostra cosa è stato davvero eseguito.
20. **Un aggiornamento di WordPress stesso non è stato provato sul motore reale:** non era offerta una versione più nuova di `7.1.4`. Sono provati gli aggiornamenti di un plugin (Parte 7 di `docs/security/step-4-acceptance-report.md`).
   - *Cosa significa per il cliente:* l'aggiornamento di WordPress stesso segue la stessa via, con la copia prima (solo se i backup sono configurati sul server) e la sistemazione dopo, ma non è provato; dopo l'esito leggere la versione mostrata e, se il sito non va e la copia c'è, ripristinarla dalla scheda Backup.
21. **Un sito il cui codice si blocca mentre WordPress si carica** fa finire ogni strumento di quel sito come «ci ha messo troppo» al limite del lavoro (`65 s` per la reimpostazione e la sistemazione, `245 s` per controllo e aggiornamento; `R146`). `R139` lo limita, nulla lo evita.
   - *Cosa significa per il cliente:* controllo, aggiornamento e reimpostazione falliscono finché il sito non viene riparato; nessun altro sito è toccato.
22. **Un aggiornamento il cui bersaglio salvato non si può più leggere** finisce senza un «ultimo aggiornamento» (`lastUpdate`): il suo contratto chiede un bersaglio valido e uno inventato sarebbe falso (`R146`). Lo dicono l'errore dell'operazione (`OPERATION_INTERRUPTED`, esito non noto) e l'evento di audit di fine (`target: null`, `outcome_unknown`). Oggi nessuna richiesta può salvare un bersaglio così; il caso esiste per uno schema futuro più stretto.
   - *Cosa significa per il cliente:* l'esito di quell'aggiornamento non compare nella scheda: la scheda continua a mostrare l'ultimo aggiornamento precedente, se c'era, e nulla nella scheda dice che il più recente è fallito; «Controlla ora» mostra le versioni vere.
23. **Quando le ricerche di plugin e temi hanno risposto e solo quella di WordPress stesso è fallita,** una vecchia risposta su WordPress stesso può leggersi come nota (`R146`): WordPress conserva la sua ultima risposta e la regola di `§2.3` non la giudica da sola. Le tre ricerche vanno allo stesso servizio nello stesso minuto, quindi il caso non è atteso.
   - *Cosa significa per il cliente:* la riga di WordPress può mostrare quello che diceva l'ultima risposta avuta; un nuovo controllo lo corregge.

**Non in questa milestone:** aggiornamenti pianificati o automatici, una copia di prova del sito (staging), installare, rimuovere, attivare o disattivare plugin e temi, gli aggiornamenti delle lingue, la scansione di sicurezza, un controllo di salute con ritorno automatico dopo l'aggiornamento, un pulsante che annulla un aggiornamento (la via per tornare indietro è ripristinare la copia presa prima, dalla scheda Backup), qualunque azione dell'amministratore del server sul sito di un cliente (la vista di supporto è M5), un aggiornamento notturno dello stato.

**Nota sulla privacy.** Un controllo e un aggiornamento contattano wordpress.org, e WordPress gli invia l'indirizzo del sito. Per questo lo stato è salvato e non letto a ogni apertura. Le prove usano solo siti usa e getta con `http://wp-a.example.test`, `admin@example.test` e titoli neutri.

## 5. Modello di fiducia

- **Il codice del sito non è affidabile.** Gira dentro i lavori con i diritti del sito (`§4.1`), quindi può mentire nell'output e nel codice di uscita. Per questo il risultato:
  - viaggia su un canale proprio, che il codice del sito può guastare o usare per mentire solo sul proprio sito e dentro lo schema (`§2.2`, `§4.1`);
  - ha un tetto in byte e conteggi e lunghezze limitati, ed è controllato da uno schema stretto due volte (executor e client IPC dell'API);
  - è mostrato solo come testo, mai come HTML, mai usato come percorso, in una riga di comando o per decidere un permesso o saltare un passo di sicurezza;
  - un nome che il cliente rimanda (per aggiornare un plugin) ripassa il controllo del tipo **e** deve essere nello stato salvato.
- **«Aggiornato» si dice solo dopo aver chiesto.** Se wordpress.org non ha risposto, gli aggiornamenti sono «sconosciuti» (`§2.3`).
- **I segreti.** Ogni lavoro porta solo i segreti del proprio sito (`§2.4`), come file, mai in `Env` o negli argomenti. La password reimpostata è creata dal pannello, data solo al lavoro, restituita una volta e mai salvata (`§2.8`).
- **La BFF** controlla sessione, CSRF e Origin e rifiuta corpi oltre `1 MiB`; la route di reimpostazione attende `85 s` e non viene mai messa in cache.

## 6. Il difetto riparato (`R133`)

Lo script spedito `wordpress.install` passava la password del database del sito e la prima password amministratore con `--prompt`, che ripete il valore nell'output. Il filtro per corrispondenza esatta non copriva valori lunghi o con un apice: in una prova, `51` dei `64` caratteri della password del database finivano nella coda dell'output. La coda di un'installazione fallita entra in un evento di audit. Inoltre WordPress confronta al login la password «con le barre»: una prima password con `'`, `"` o `\` non permetteva mai di accedere.

Riparazione: `--prompt` è tolto da ogni script spedito. La password del database arriva a `wp config create` e la prima password amministratore all'installazione senza passare dall'output; quest'ultima è impostata con `wp_set_password(wp_slash(…))` ogni volta che il file del segreto esiste, così anche un nuovo tentativo dopo un'installazione a metà la imposta. Le righe di audit già scritte non vengono riscritte (`§4.8`).

## 7. Conformità alle regole architetturali

- **Socket Docker solo nell'executor:** API e Web non toccano Docker né eseguono wp-cli; ogni lavoro passa dall'IPC firmato.
- **`CP-01`:** nessun lavoro ferma, riavvia o ricrea il contenitore del sito o `hp_mariadb`. Un aggiornamento usa la pagina di manutenzione di WordPress, tolta sempre da `settle`.
- **Isolamento (`404`) e audit:** ogni route nuova risponde `404` per un sito di un'altra organizzazione; ogni mutazione scrive un evento senza segreti.
- **Nessun permesso nuovo, nessuna dipendenza npm nuova**; la scansione del gergo sui testi del cliente (`components/customer`) passa.
- **Testi:** ogni frase in italiano e inglese, e ogni errore dice cosa è successo e cosa fare.

## 8. Verifica

- **Test automatici di questo ciclo:**
  - contratti, schemi del risultato, pattern e tabella delle ragioni: `packages/contracts/test/{site-wordpress,contracts,backups}.test.ts`;
  - migrazione `0012_wordpress_tools.sql` e repository: `packages/database/test/{phase2-database,site-sftp-users-database}.test.ts`;
  - tipi chiusi, script costanti, `Entrypoint` byte per byte e `Init` (`R139`), segreti ammessi per tipo, rete, limiti, `LogConfig`, canale del risultato, simulatore e IPC: `apps/docker-executor/test/{site-jobs,simulator-wordpress,site-jobs-ipc}.test.ts`;
  - API, applier e conservazione: `apps/api/test/{site-wordpress.integration,site-wordpress-applier,backup-retention.unit}.test.ts`;
  - Web: `apps/web/test/site-wordpress-ui.test.ts`, `apps/web/test/bff.integration.test.ts` e i tre test che fissano l'elenco delle schede;
  - i test di sicurezza della fase QA (`qa-c7`) si aggiungono a questi.
- **Collaudo su Docker reale: `infra/linux/accept-m4-wordpress.mjs`** (questo documento dice cosa deve mostrare almeno, non quanti passi ha né che è passato: i passi e il loro esito sono nella Parte 7 di `docs/security/step-4-acceptance-report.md`). Usa l'immagine reale `wordpress:cli-2.12.0-php8.4` e le specifiche di lavoro del prodotto su un sito usa e getta creato come lo crea il prodotto, e mostra:
  - (a) il controllo di un sito con un plugin vecchio lo elenca con la nuova versione;
  - (b) quel plugin si aggiorna: la versione cambia, i file restano dell'utente `33`, nessun `.maintenance` rimasto, il sito risponde `200`;
  - (c) la password dell'amministratore si reimposta: login su `wp-login.php` con la nuova → `302` con il cookie `wordpress_logged_in_`; con la vecchia → `200` senza;
  - (d) senza Internet lo stato dice «sconosciuto», non «aggiornato», e l'aggiornamento esce `30`;
  - (e) con segreti di `19`, `64` e `128` caratteri e uno con apici e backslash, nessuna finestra di `8` caratteri consecutivi del segreto è nella coda;
  - (f) un sito il cui codice inonda l'output e falsifica un risultato non supera i tetti e viene rifiutato o mostrato come testo;
  - (g) un aggiornamento ucciso a metà non lascia `.maintenance` dopo `settle`;
  - (h) non resta nulla di nome `hp_swarmtest_*`.

  Lo script ha bisogno di wordpress.org: se non lo raggiunge lo dice ed esce con errore, senza fingere. Il suo esito è nella Parte 7 di `docs/security/step-4-acceptance-report.md`.
- **Prova di progetto già eseguita (non sostituisce lo script):** il 2026-11-15 un laboratorio sul motore reale (Docker `29.9.2`) ha passato `9` passi su `9` con l'adattatore reale: installazione con password di `64` caratteri e con una password con `'`, `"` e `\`, controllo, aggiornamento di un plugin, `settle`, reimpostazione e controllo senza rete edge. Non ha coperto un aggiornamento di WordPress stesso, i casi di inondazione e falsificazione (f) né i segreti di `19` e `128` caratteri.
