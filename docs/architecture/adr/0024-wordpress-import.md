# ADR 0024 — Importazione WordPress (M4b): un Sito Portato da Fuori, con Copia Preventiva e Ritorno Indietro

- **Stato:** `APPROVATO — M4b`
- **Data:** 2026-11-16
- **Riferimento:** spec `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md` (§3.9 importazione guidata), `CP-01`, `ADR-0019`, `ADR-0021`, `ADR-0022`, `ADR-0023`; regole `R150`–`R175`
- **Migrazioni:** `0013_wordpress_import.sql` (additiva: `ALTER TABLE site_wordpress_state ADD COLUMN IF NOT EXISTS last_import JSONB`)

## 1. Contesto

Un cliente ha un sito WordPress altrove e vuole spostarlo su un sito WordPress già creato nel pannello. Porta due file:

1. **l'archivio dei file**: uno zip con la cartella di WordPress (`wp-includes`, `wp-content`, `wp-load.php`…);
2. **l'export del database**: il file `.sql` (anche compresso con gzip) che producono mysqldump, mariadb-dump o phpMyAdmin.

L'importazione sostituisce i file e il database del sito con quelli portati. Restano del pannello l'accesso, l'indirizzo, l'utente SFTP, il database e il suo account, i backup. Alla fine l'indirizzo del vecchio sito è sostituito, nei dati, con quello del sito del pannello.

Il contenuto portato è del cliente e non è affidabile: l'export può contenere istruzioni SQL qualsiasi e l'archivio contiene codice PHP che, alla fine, gira (`§5`). Un'importazione può anche fallire a metà, dopo che il sito è già stato toccato. Per questo ogni passo ha la sua via indietro e il pannello non dice mai «importato» senza averlo visto.

M4b-1 ha costruito il motore (executor, helper dei file, API) e ha riparato un difetto spedito in M4a (`§6`). M4b-2 aggiunge la procedura guidata nel sito web del pannello (`§2.12`) e questo documento.

Due parole usate sotto:
- **helper dei file:** il piccolo programma che lavora dentro la cartella del sito per conto del pannello (`site-files-helper`, `ADR-0019`); ha un elenco chiuso di operazioni.
- **lavoro di sito:** un contenitore effimero avviato solo dall'executor, con uno script costante (`ADR-0023 §2.1`).

## 2. Decisioni

### 2.1 La via di un'importazione (`R150`)

Un'importazione è **una** operazione recuperabile (`site.wordpress.import`) con sei passi, sempre in questo ordine:

| Passo | Chiamate, in ordine | Cosa fa |
|---|---|---|
| `check` | `import.stat` | Entrambi i file devono essere completi, altrimenti `files_missing`. Non devono esserci resti di un'importazione precedente (`remains` falso), altrimenti `earlier_import_unfinished`. |
| `backup` | la copia `pre_update` già spedita (`ADR-0023 §2.7`) | Solo se i backup sono configurati sul server; altrimenti il passo è `skipped`. |
| `unpack` | `import.unpack` | Estrae l'archivio nella cartella di lavoro `.htpanel-import/`. Il sito vivo non è toccato. |
| `database` | `db.import{prepare}` → `db.import-load` | Crea uno schema di prova e un account solo per esso, poi carica l'export lì. L'API ricontrolla la risposta. Il database vivo non è toccato. |
| `switch` | `import.switch` → `db.import{switch}` → `wordpress.import-finalize` | Chiude il sito con il cancello (`§2.8`), mette da parte `wp-config.php` e `.htaccess` vivi e scambia i file; poi scambia le tabelle con un solo `RENAME TABLE` atomico; poi sistema la configurazione e riscrive l'indirizzo (`§6`). |
| `finish` | `import.finish` → `db.import{finish}` → il controllo spedito (`inspectFor`) | Rinomina i `.htaccess` annidati, toglie il cancello, rimuove la cartella di lavoro e i due file; poi rimuove le tabelle messe da parte; poi rilegge le versioni del sito. |

Non esiste un'operazione `import.cleanup`. La pulizia prima dello scambio usa la stessa coppia dell'annullamento (`§2.2`).

**Mai inviate una seconda volta, una volta partite:** `import.unpack`, `db.import{prepare}`, `db.import-load`, `import.switch`, `db.import{switch}`, `wordpress.import-finalize`. Se la loro fine non è nota, il pannello non le ripete: annulla.

**Ripetibili senza danno (`R151`):** `import.stat`, `db.import{undo}`, `import.undo`, `import.finish`, `db.import{finish}`.

### 2.2 L'annullamento da qualunque punto (`R152`)

Ogni fallimento in `unpack`, `database` o `switch` porta alla stessa coppia, prima il database e poi i file. Un fallimento in `check` o in `backup` finisce senza chiamate: il sito non è ancora stato toccato. Un fallimento in `finish` non annulla nulla (sotto e `§4.27`).

1. `db.import{undo}`: rimette le tabelle vive dal loro posto a parte, se lo scambio è avvenuto, e rimuove schema di prova, schema a parte, segno e account.
2. `import.undo`: rimette i file vivi, toglie il cancello (salvo i casi di `§4.29`) e rimuove la cartella di lavoro.

Regole:
- `import.undo` parte solo dopo che `db.import{undo}` ha risposto con uscita `0` nello stesso giro.
- `import.undo` toglie il cancello solo quando ogni voce spostata è tornata al suo posto. Altrimenti risponde `{complete:false}` e il sito resta chiuso.
- Solo due risposte chiudono un'importazione come `undo_incomplete`: `db.import{undo}` con uscita `92`, oppure `import.undo` con `{complete:false}`.
- Ogni altro fallimento della coppia non decide nulla. L'operazione resta `unknown` e tiene il blocco del sito; la ripresa (`§2.3`) riprova e intanto risponde «in attesa». La via d'uscita dell'amministratore è lo sblocco d'emergenza (break-glass) già spedito.
- `sites.status` non cambia mai per un'importazione.

**Le tre fini.** Ogni importazione finisce in uno di questi modi, con uno dei quattro esiti del contratto e una delle `29` ragioni:

| Fine | Esito | Stato del sito |
|---|---|---|
| importato | `imported` | il sito nuovo, aperto |
| come prima | `nothing_changed` (fallita prima dello scambio) oppure `site_restored` (fallita durante o dopo lo scambio, rimesso com'era) | il sito di prima, aperto (salvo i casi di `§4.29`) |
| non rimesso | `undo_incomplete` | chiuso dal cancello (i visitatori ricevono `403`); la via indietro è la copia presa prima (`§4.26`) |

**La fine di `finish` (`R162`):**
- `import.finish` non viene mai abbandonata: un suo fallimento o una sua fine sconosciuta non decide nulla e l'operazione aspetta la ripresa.
- `db.import{finish}` parte solo dopo che `import.finish` è riuscita.
- Un fallimento di `db.import{finish}` o del controllo finale non fa fallire l'importazione: il sito è già quello nuovo. Un `db.import{finish}` fallito però può lasciare nel database le tabelle del vecchio sito, con i dati dei suoi utenti (`§4.27`).
- Finché `import.finish` non è chiusa, nessun esito viene salvato.

**Una copia che fallisce.** L'operazione finisce con il codice della copia stessa, prima che l'importazione scriva il suo esito (`R164.6.1`). La ragione salvata è comunque `backup_failed`, con esito `nothing_changed`.

### 2.3 La ripresa dopo un riavvio

Se il pannello si ferma durante un'importazione, al riavvio la ripresa delle operazioni guarda dove era arrivata:

| Dove era | Cosa fa la ripresa | Esito |
|---|---|---|
| prima di `unpack` | nessuna chiamata di annullamento; chiude solo la copia, se era partita | `nothing_changed`, ragione `interrupted` o `backup_failed` |
| `unpack` partito, scambio non partito | la coppia di annullamento come pulizia | `nothing_changed` o `undo_incomplete`, ragione `interrupted` |
| scambio partito, non finito | la coppia di annullamento | `site_restored` o `undo_incomplete` |
| scambio riuscito | ripete `finish` | `imported` |

La copia preventiva viene chiusa dalla ripresa solo se il suo passo era `running` o `unknown`; un passo ancora `pending` vuol dire `skipped` (`R164.5.2`).

### 2.4 La superficie chiusa dell'helper: otto operazioni

L'helper dei file riceve otto operazioni nuove, nell'enum zod di `packages/contracts/src/ipc-schemas.ts`. Nessuna accetta un percorso libero: lavorano solo dentro `.htpanel-import/` e sulle due «caselle» (`slot`) fisse `archive` e `dump`.

| Operazione | Risposta | Limite nell'helper | Attesa del client |
|---|---|---|---|
| `import.put` (un pezzo di un caricamento) | `{received}` | `45 s` | `60 s` |
| `import.take` (prende un file caricato via SFTP) | `{size}` | `45 s` | `60 s` |
| `import.stat` | `{archive, dump, remains}` | `45 s` | `60 s` |
| `import.discard` | vuota | `570 s` | `600 s` |
| `import.unpack` | la risposta dell'estrazione, con `leftOut` | `570 s` | `600 s` |
| `import.switch` | `{moved}` | `45 s` | `60 s` |
| `import.undo` | `{complete}` | `570 s` | `600 s` |
| `import.finish` | vuota | `570 s` | `600 s` |

I limiti stanno in `site-files-helper.ts` (`DEFAULT_OP_TIMEOUT_MS = 45_000`, `ARCHIVE_OP_TIMEOUT_MS = 570_000`) e in `client.ts` (`SITE_FILES_TIMEOUT_MS`, `SITE_FILES_ARCHIVE_TIMEOUT_MS`).

**Tetti dell'estrazione** (`site-files-program.ts`):
- per l'importazione: al massimo `200000` voci (`HP_IMPORT_MAX_ENTRIES`) e `4 GiB` estratti (`HP_IMPORT_MAX_UNCOMPRESSED`);
- l'estrazione di uno zip dal file manager del cliente resta a `20000` voci e `1 GiB`;
- invariati: rapporto di compressione `200` (oltre `1 MiB`), profondità `32`, un file al massimo `2 GiB` (`HP_MAX_FILE_BYTES`), almeno `1 GiB` libero sul disco (`HP_DISK_FREE_FLOOR`).

**Dove sta WordPress nell'archivio:** al primo livello, oppure dentro esattamente una cartella di primo livello. Devono esserci `wp-includes/version.php`, `wp-load.php` e `wp-content/`; altrimenti `archive_not_wordpress`.

**Prendere un file via SFTP** («pick») è uno spostamento, non una copia. Il file è controllato dai primi byte e può essere al massimo `2 GiB`. Un collegamento simbolico è rifiutato con il nome, strano ma accettato, `is_a_directory` (`§4`).

### 2.5 Tre tipi di lavoro chiusi

Tre righe nuove in `SITE_JOB_SPECS` (`apps/docker-executor/src/site-jobs.ts`). I limiti stanno in `SITE_JOB_LIMIT_MS` (`packages/contracts/src/site-wordpress.ts`).

| Tipo | Immagine e utente | Accesso | Parametri | Segreti | Limite |
|---|---|---|---|---|---|
| `db.import` | `mariadb:12.3.3`, utente dell'executor | rete `hp_mariadb_net`; solo la chiave root, in sola lettura; **nessun volume del sito** | `step` (`prepare`, `switch`, `undo`, `finish`), `importId` | `HP_IMPORT_DB_PASSWORD` facoltativo, letto solo da `prepare` | `300 s` |
| `db.import-load` | `mariadb:12.3.3`, utente `33:33` | rete `hp_mariadb_net`; volume dei file del sito in sola lettura (`:ro`); **nessuna chiave root** | `importId` | `HP_IMPORT_DB_PASSWORD` obbligatorio | `1500 s` |
| `wordpress.import-finalize` | wp-cli per il PHP del sito, comando in `Entrypoint`, `Init: true`, utente `33:33` | rete interna del sito; volume dei file in lettura e scrittura | `phpVersion`, `tablePrefix`, `siteUrl`, `previousUrl` | nessuno | `1200 s` |

Per ogni tipo:
- solo per `db.import`, l'executor aggiunge da sé `HP_PREFIX` (il prefisso dei nomi del database del sito, `siteDatabasePrefix`) e `HP_LOCK_S`;
- `CapDrop: ALL`, `no-new-privileges`, al massimo `128` processi, `1` CPU, `512 MB` di memoria (`JOB_MEMORY_BYTES`), log `json-file` di `1m`;
- il client dell'API aspetta il limite più `300 s`; il lavoro si uccide da solo `5 s` dopo il suo limite (`timeout -s KILL`); il lease dell'operazione è l'attesa del client più `60 s`.

Anche `wordpress.set-url`, lo strumento di M4a che cambia l'indirizzo, usa la riscrittura riparata (`§6`); il suo limite è `360 s`.

### 2.6 Script costanti, valori controllati, segreti come file

- **Uno script costante per tipo.** Lo script non contiene mai un valore del cliente. I valori arrivano solo come variabili `HP_*`, ognuna controllata prima dall'executor:
  - `step` in un elenco chiuso;
  - `importId` = le `32` cifre esadecimali dell'id dell'operazione;
  - `tablePrefix` secondo `^[A-Za-z0-9_]{1,32}$`;
  - `siteUrl` un'origine valida del sito (`isSiteOrigin`);
  - `previousUrl` al massimo `300` caratteri e conforme a `IMPORT_ORIGIN_PATTERN`.
- **Nomi nel database**, tutti derivati da `importId`: schema di prova `hp_is_<id>`, schema a parte `hp_ia_<id>`, segno `hp_im_<id>`, account `'hp_iu_<id>'@'%'` con `MAX_USER_CONNECTIONS 2` e permessi solo sullo schema di prova.
- **La password di quell'account** è di `64` cifre esadecimali, creata nella memoria dell'API e mai salvata. Arriva ai lavori solo come file (`HP_IMPORT_DB_PASSWORD`), mai in `Env` o negli argomenti.
- **Il caricamento** (`db.import-load`) usa il client con `--sandbox --local-infile=0 --binary-mode`. Riconosce un gzip dai primi byte e lo apre nel flusso. Non ripete mai l'output di errore del client. Controlla, prima e dopo il caricamento:
  - più di `4 GiB` di testo → uscita `52` (`head -c 4294967297`);
  - riga finale `-- Dump completed` mancante → `53`, solo se l'intestazione dice mysqldump o mariadb-dump;
  - al massimo `1000` tabelle (`62`); motori solo InnoDB, MyISAM o Aria; nessun `DIRECTORY` e nessuna tabella partizionata (`57`);
  - un solo prefisso con tutte le `9` tabelle di base di WordPress: nessuno → `54`, più di uno → `55`;
  - tabelle di multisite `blogs`, `site`, `sitemeta` → `56`;
  - almeno un utente; `home` e `siteurl` devono essere origini dello stesso host dopo lo schema → altrimenti `59`.
  - Gli errori del server con numero `null`, `1044`, `1045`, `1142`, `1143`, `1193`, `1227`, `1370` o `4166` danno `61` (istruzione non ammessa); ogni altro errore dà `60`.
- **Gli oggetti del database** (`db.import`): nessuna vista, trigger, routine o evento, e nessun nome con caratteri di controllo, NUL o backslash. Se lo schema vivo non passa → `85`; se lo schema di prova non passa → `84`. L'annullamento controlla allo stesso modo il vivo e quello a parte → `92`. `finish` esce `97` se il segno non è quello atteso.
- **La sistemazione** (`wordpress.import-finalize`), in ordine:
  1. `wp config has HP_MANAGED` (il `wp-config.php` del pannello è al suo posto), altrimenti uscita `20`;
  2. controllo del prefisso, altrimenti `64`;
  3. `wp config set table_prefix` con il prefisso dell'export;
  4. `wp core is-installed --skip-plugins --skip-themes`, altrimenti `25`;
  5. aggiorna `home` e `siteurl`, altrimenti `25`;
  6. se il vecchio indirizzo è diverso dal nuovo, la riscrittura (`§6`), altrimenti `26`;
  7. rilegge `home` e controlla che sia l'indirizzo del sito, altrimenti `25`.
- **Il risultato.** Solo `db.import-load` ha un risultato. Viaggia sul canale di `ADR-0023 §2.2`, con lo stesso tetto di `256 KiB`, ed è controllato da `WordpressImportLoadResultSchema` nell'executor e di nuovo nel client dell'API. Lo schema è un'unione di due forme:
  - successo: `{prefix, oldUrl, tables}` con `1..1000` tabelle;
  - errore: `{line ≥ 0, errorNumber 1..99999 | null}`.
  L'API prende `line` e `errorNumber` solo da una risposta che passa lo schema e solo per le uscite `60` e `61` (`R164.5.1`).

### 2.7 Le ragioni vengono solo dai codici di uscita (`R157`)

Un'unica tabella, nell'applier dell'API, traduce le risposte in ragioni. Nessuna ragione viene dal testo prodotto da un lavoro.

| Da | Risposta | Ragione |
|---|---|---|
| API | file non completi in `check` | `files_missing` |
| API | resti di un'importazione in `check` | `earlier_import_unfinished` |
| API | copia fallita | `backup_failed` |
| API | ripresa prima dello scambio | `interrupted` |
| ogni chiamata | uscita `124` o `137`, limite dell'helper | `timed_out` |
| ogni chiamata | uscita `11`, executor o helper non raggiungibile, `db.import` uscita `1` in `prepare` o `switch` | `unavailable` |
| ogni chiamata | qualsiasi altra risposta (per esempio uscite `20`, `64`, `86`, `97`, una ragione dell'helper non in elenco) | `other` |
| helper | `not_a_zip` | `archive_not_zip` |
| helper | `dump_not_sql`, `archive_unsafe`, `archive_limit`, `archive_not_wordpress`, `disk_full`, `staging_unsafe`, `files_missing` | lo stesso nome |
| `db.import-load` | `50` / `51` / `52` / `53` / `54` / `55` / `56` / `57` / `58` / `59` / `62` | `dump_unsafe` / `dump_not_sql` / `dump_too_large` / `dump_incomplete` / `dump_not_wordpress` / `dump_ambiguous` / `multisite_unsupported` / `dump_objects_unsupported` / `dump_names_unsupported` / `address_unsupported` / `dump_too_many_tables` |
| `db.import-load` | `60`, `61` (con `line` ed `errorNumber`) | `dump_load_failed`, `dump_statement_unsupported` |
| `db.import` | `84`, `85` | `dump_names_unsupported`, `site_objects_unsupported` |
| `db.import{undo}` | `92` | nessuna ragione propria: l'esito è `undo_incomplete` e la ragione resta quella del fallimento che ha portato all'annullamento |
| `wordpress.import-finalize` | `25`, `26` | `site_check_failed`, `address_rewrite_failed` |

La route di avvio rifiuta prima di creare l'operazione, con uno di tre motivi (`WORDPRESS_IMPORT_REFUSALS`): `import_running`, `earlier_import_unfinished`, `files_incomplete`. Controlla `earlier_import_unfinished` prima di `files_incomplete` (`R164.5.3`).

### 2.8 Il cancello e la cartella di lavoro (`R156`)

- **Il cancello** chiude il sito durante lo scambio. Ha due strati:
  - G1, alla fine del `.htaccess` principale (`<If "true">` con `Require all denied`): risponde per primo, e ogni richiesta riceve `403` (accesso negato);
  - G2, davanti a `wp-config.php`: risponde `503` (servizio non disponibile) solo se G1 manca.
  Nel collaudo (Parte 8, passo 4) tutte le `30` risposte di ogni punto sono state `403`; il `503` non si è mai visto. Dopo che il cancello è tolto può ancora comparire `503` per poco (`§4.11`).
  `.maintenance` di WordPress non basta: la pagina di installazione lo salta.
- **Il cancello si toglie dentro `import.finish`**, dopo che i `.htaccess` annidati hanno ripreso il loro nome, oppure dentro `import.undo` quando tutto è tornato al suo posto (salvo i casi di `§4.29`).
- **La cartella di lavoro** `.htpanel-import/` ha un proprio `.htaccess` rinforzato (`Require all denied`, più `<Files "*">`, più `<If "true">`). Ogni operazione dell'helper lo riscrive prima di fare altro.
- **Nell'archivio:**
  - una voce di nome `.htpanel-*` è rifiutata;
  - ogni `.htaccess` annidato viene estratto come `.htaccess.hpimport` e riprende il suo nome solo alla fine, così nessuna sua regola agisce prima del tempo;
  - un `__MACOSX` o un `.DS_Store` di primo livello è ignorato.
- **La copia** del sito lascia fuori `.htpanel-import`.
- **Un ripristino** da Backup non è stato toccato (`restore-jobs.ts`): rimuove anche `.htpanel-import`, quindi anche i file caricati in attesa di un'importazione (`R155.1`, `§4`).
- `import.discard` lascia stare una cartella di lavoro che contiene un piano di scambio (`plan`) e risponde con successo (`R155.3`). `import.unpack` invece rifiuta con `staging_unsafe` se la cartella contiene un piano.

### 2.9 Cosa resta del sito del pannello (`R161`)

Questi elementi dell'archivio **non** sostituiscono quelli del sito. L'elenco va nel risultato (`leftOut`, al massimo `16` voci mostrate):

- `wp-config.php`: resta quello del pannello, con la password del database del sito;
- `.htaccess` del primo livello: resta quello del pannello; quello portato è messo accanto come `.htaccess.imported`;
- `.maintenance`;
- `wp-content/mu-plugins` (i plugin «must-use»);
- i `12` drop-in `wp-content/{advanced-cache,object-cache,db,db-error,install,maintenance,php-error,fatal-error-handler,sunrise,blog-deleted,blog-inactive,blog-suspended}.php`.

Il motivo: questi file girano prima di tutto il resto, oppure decidono a quale database e a quale cache il sito si collega. Lasciati entrare, girerebbero già durante la sistemazione e potrebbero puntare il sito fuori dal suo database.

### 2.10 Copia preventiva, corsia e tetto

- **La copia** è la copia `pre_update` spedita in M4a, presa solo se i backup sono configurati sul server. Conta fra le `3` copie `pre_update` conservate (`PRE_UPDATE_BACKUPS_KEPT`), quindi può far rimuovere la più vecchia. La scheda Backup la chiama «Prima di un aggiornamento o di un'importazione».
- **La corsia.** L'importazione gira nella corsia degli strumenti WordPress (`WORDPRESS_LANE_KINDS`), una per tutti i siti. Mentre gira, controlli e aggiornamenti WordPress di **altri** siti aspettano (`§4`).
- **Il tetto.** L'importazione è un'azione pesante (`HEAVY_BACKUP_OPERATION_KINDS`): al massimo `6` per sito all'ora, insieme a copie, ripristini e aggiornamenti.
- **Durante un'importazione** il sito rifiuta gli altri strumenti WordPress.

### 2.11 Stato salvato, route, permessi, audit

- **Stato salvato:** la colonna `last_import` (JSONB) di `site_wordpress_state`. Contiene `operationId`, `finishedAt`, `outcome`, `reason`, `backup` (`taken`, `skipped`, `failed`), `oldAddress`, `leftOut` (al massimo `16`), `tables`, `line`, `errorNumber`.
- **Route** sotto `v1/organizations/:orgId/managed-sites/:siteId/wordpress/import`:

| Metodo e percorso | Cosa fa | Permesso |
|---|---|---|
| `GET` | stato: `available`, `backupsConfigured`, `slots`, `earlierImportUnfinished`, `runningOperation`, `lastImport` | `site.read` |
| `POST` | avvia: corpo `{confirm:true}`, `Idempotency-Key`, risponde `202` | `site.update` |
| `DELETE files` | scarta entrambi i file | `site.update` |
| `PUT files/:slot` | un pezzo di un caricamento | `site.update` |
| `POST files/:slot/pick` | prende un file caricato via SFTP | `site.update` |

- Un sito di un'altra organizzazione risponde `404`. Nessuna chiave di permesso nuova e nessun flag di capacità nuovo.
- **La BFF** del sito web espone le stesse route sotto `/api/bff/orgs/<orgId>/managed-sites/<siteId>/wordpress/import`. Le route che cambiano qualcosa chiedono `X-CSRF-Token`; una casella sconosciuta risponde `400` prima di chiamare l'API; i corpi di `PUT` e `pick` sono stretti (nessun percorso, nessuna sovrascrittura).
- **Audit**, senza segreti: `site.wordpress.import.file_uploaded {slot,size}`, `.file_picked {slot,path}`, `.files_discarded`, `.requested {operationId, backup}`, `.finished` (scritto dall'applier, con esito, ragione, copia, numero di tabelle, vecchio host senza schema e `leftOut`).
- **Disponibile** solo dove `wordpressToolsAvailable` è vero, cioè sul target `linux-systemd`.

### 2.12 La procedura guidata

Una pagina propria (nel progetto: `apps/web/src/app/sites/[siteId]/wordpress/import/`) e una card nella scheda WordPress. Mentre un'importazione gira, la scheda mostra solo la card.

La pagina ha cinque sezioni:
1. **Prima di iniziare:** cosa cambia e cosa resta; se ci sarà una copia.
2. **File del sito:** carica lo zip, oppure indica il percorso di un file già mandato via SFTP.
3. **Export del database:** lo stesso, per il file `.sql`.
4. **Controlla e conferma:** il riepilogo; il cliente scrive il nome del sito per confermare.
5. **Avanzamento ed esito.**

- I caricamenti riusano la coda a pezzi del file manager (`512 KiB` per pezzo), con la ripresa.
- La pagina segue l'importazione ogni `2 s` e smette dopo `10 minuti`; l'importazione continua anche se il cliente chiude la pagina.
- Ogni esito e ogni ragione ha una frase in italiano e in inglese che dice cosa è successo e cosa fare. Hanno una frase propria anche: un `undo_incomplete` vecchio (con o senza copia), `is_a_directory`, `staging_unsafe`, il tetto delle azioni pesanti, una fine sconosciuta, una connessione persa, la copia che può rimuovere la più vecchia, gli strumenti WordPress rifiutati durante un'importazione.

## 3. Alternative scartate

- **Tenere lo stato della procedura nel browser:** un cliente che ricarica la pagina o cambia computer perderebbe i file caricati. Lo stato sta nel pannello (`import.stat`, `lastImport`).
- **Una finestra di conferma (modale) invece di una pagina:** l'importazione ha cinque sezioni e due caricamenti lunghi; una pagina regge la ricarica e un indirizzo proprio.
- **Un componente per scegliere un file dal file manager:** più codice per un caso raro; il cliente scrive il percorso del file mandato via SFTP.
- **Ripetere un passo la cui fine non è nota:** un'estrazione o uno scambio ripetuto su uno stato sconosciuto può rovinare il sito; il pannello annulla (`§2.1`).
- **Una `import.cleanup` separata:** sarebbe stata una seconda via per lo stesso lavoro; la pulizia usa la coppia di annullamento (`R150`).
- **`.maintenance` come cancello:** la pagina di installazione di WordPress lo salta (`§2.8`).
- **Caricare l'export direttamente nel database vivo:** un export rotto a metà lascerebbe il sito senza tabelle; lo schema di prova e un solo `RENAME TABLE` rendono lo scambio tutto o niente.
- **La riscrittura dell'indirizzo con `wp search-replace --regex`:** corretta ma `30` volte più lenta su un sito con poche corrispondenze (`§6`).

## 4. Limiti accettati e note di funzionamento

Ogni limite qui sotto viene da una regola (`R…`) o dal progetto: una sezione di questo documento, la Parte 8 del collaudo, oppure `arch-api` e `arch-web`, i documenti di progetto del ciclo. La fonte è fra parentesi. Dove serve, dice cosa significa per il cliente o cosa deve fare l'amministratore.

**Spazio, tempo e server condiviso**

1. **Nessun controllo dello spazio libero dal lato database** (`R160`). Durante l'importazione lo schema di prova e quello a parte raddoppiano il database del sito.
   - *Cosa deve fare l'amministratore:* tenere libero sul server del database almeno il doppio del database più grande da importare.
2. **Un caricamento grande rallenta gli altri siti** che usano lo stesso server del database (`R160`).
   - *Cosa significa per il cliente:* durante un'importazione grande, altri siti possono rispondere più lentamente per qualche minuto.
3. **I tetti non sono stati provati per intero** (`R160`). Un export di `4 GiB` scritto con una riga per `INSERT` richiede circa `1130 s` dei `1500 s` del lavoro. Un'estrazione di `200000` voci e `4 GiB` è stimata, non eseguita.
   - *Cosa significa per il cliente:* file vicini ai tetti possono finire con `timed_out`; il sito torna com'era.
4. **L'export può usare memoria e disco del server del database** quanto può farlo l'accesso del cliente al suo database (`R164.7`). Un tetto proprio dell'importazione è rimandato a M6.
5. **Un lavoro che supera i `512 MB` non finisce come `timed_out`** (Parte 8, `§6`). Il kernel uccide un processo dentro il lavoro, e quale lo sceglie il kernel. Se non è lo script, lo script va avanti ed esce con il proprio codice: nella sistemazione il laboratorio ha visto l'uscita `26` (`address_rewrite_failed`); nel caricamento, se il processo ucciso è il client, lo script esce `60` alla riga `0` (`dump_load_failed`). Se è lo script stesso, il codice di uscita non è stato visto.
   - *Cosa deve fare l'amministratore:* davanti a uno di questi esiti su un sito grande, considerare anche la memoria del lavoro.
6. **Una riscrittura dell'indirizzo molto grande può superare il limite** (`R165.4`, `R167.2`). Per `wordpress.set-url` circa un milione di righe con il vecchio indirizzo raggiungono i `360 s`. La sistemazione di un'importazione ha `1200 s`; non è stata misurata a quel limite. Una riscrittura fermata viene annullata (rollback).
   - *Cosa significa per il cliente:* l'importazione finisce con `address_rewrite_failed` o `timed_out` e il sito torna com'era.
7. **Un solo valore di decine di megabyte** può fermare la riscrittura al tetto di `512 MB` del lavoro (`R166.5`, corretto da `R167.1`: dentro `wp eval` il limite di memoria di PHP è `-1`, quindi il vero tetto è quello del lavoro).
8. **La corsia WordPress è occupata durante un'importazione** (arch-api). Controlli e aggiornamenti WordPress di altri siti aspettano.
   - *Cosa significa per il cliente:* un controllo o un aggiornamento può restare in attesa finché un'importazione di un altro sito non finisce.
9. **La copia preventiva conta fra le tre copie `pre_update` conservate** (arch-api). Può far rimuovere la più vecchia. La frase della conferma lo dice.
10. **Il tetto delle azioni pesanti conta anche le importazioni** (arch-api): `6` per sito all'ora. La frase del cliente nomina anche le importazioni.

**Durante e dopo lo scambio**

11. **Fino a `2 s` di `503` dopo che il cancello è tolto** (`R160`), finché la cache di PHP (opcache) non vede i file nuovi.
12. **Il cliente può cancellare via SFTP il `.htaccess` della cartella di lavoro** fra due chiamate (`R160`). Ogni operazione lo riscrive prima di fare altro. Le voci messe da parte tengono il proprio `.htaccess` annidato.
    - *Cosa significa per il cliente:* solo il cliente stesso può aprire così la propria cartella di lavoro, per pochi istanti; nessun altro sito è toccato.
13. **La sistemazione esegue il codice del sito importato** dentro la rete interna del sito (`R160`). Vale quanto `ADR-0023 §4.1`.
14. **Un vecchio WordPress che non gira sul PHP del sito** finisce come `site_check_failed` e il sito torna com'era (`R160`).
    - *Cosa deve fare il cliente:* aggiornare il vecchio sito a una versione di WordPress che gira sul PHP di questo sito, poi esportare di nuovo.
15. **Il `.htaccess` portato non è attivo.** Resta accanto come `.htaccess.imported`; plugin must-use e drop-in non entrano (`R161`).
    - *Cosa deve fare il cliente:* ricopiare a mano le regole che servono, e reinstallare plugin di cache o simili.
16. **Un'importazione completata dalla ripresa** non mostra vecchio indirizzo, numero di tabelle né elenco degli elementi lasciati fuori (`R162.5`).

**L'indirizzo**

17. **Alcune forme del vecchio indirizzo non vengono riscritte** (`R160`, `R163.5`, Parte 8):
    - un host in lettere maiuscole o scritto senza `http://` o `https://`;
    - l'indirizzo codificato per URL (`%3A%2F%2F`), o in un'altra combinazione di maiuscole e minuscole;
    - l'indirizzo dentro `guid` (WordPress chiede di non cambiarlo);
    - una colonna `char(N)`;
    - una colonna `ucs2` o `utf16` (`R166.5`);
    - un valore che il sostituto di wp-cli non sa ricostruire: è saltato, forse con un avviso PHP.
    - *Cosa significa per il cliente:* alcuni collegamenti possono ancora puntare al vecchio indirizzo; si correggono dall'editor di WordPress.
18. **Il vecchio indirizzo è tenuto** (`R164.1.1`, `§6`) quando è seguito da `A-Za-z0-9-`, da un byte `0x80–0xff`, da un `.` con uno di questi, da `:` con una cifra, o da `@` Così `https://a.example.test` non tocca `https://a.example.test.example.test`.
19. **Un valore più lungo della sua colonna tiene il valore vecchio** (`R166.2`). Il limite in byte è confrontato con la lunghezza UTF-8, quindi può saltare un valore che starebbe appena in una colonna a un byte per carattere. Una colonna la cui descrizione porta più del nome del tipo (per esempio un `text` compresso) non ha limite (`R167.4`).
20. **Una tabella MyISAM o Aria è fuori dalla transazione** (`R164.1.4`). Una riscrittura fermata la lascia riscritta a metà; la riscrittura successiva la finisce.
21. **Una tabella senza chiave primaria è saltata** dalla riscrittura (`§6`).
22. **Per `wordpress.set-url` (lo strumento di M4a), non per l'importazione** (`R165.4`, `R168.3`):
    - quello che il cliente salva durante il cambio di indirizzo in un valore che contiene il vecchio indirizzo può andare perso;
    - una scrittura su una riga già cambiata dalla riscrittura aspetta la fine della riscrittura;
    - se il cambio fallisce, un plugin must-use o un drop-in che fa commit alla chiusura può tenere una riscrittura a metà.
    Durante un'importazione il sito è chiuso dal cancello e mu-plugin e drop-in portati non entrano, quindi questi casi non si presentano.
23. **Il pattern dell'indirizzo accetta una porta `0` o `99999`** (`R164.6`).

**L'export**

24. **Un export tagliato al confine di un'istruzione** (`§2.6`) passa se l'intestazione non è di mysqldump o mariadb-dump (per esempio phpMyAdmin) e le tabelle sembrano complete. La riga finale si controlla solo per mysqldump e mariadb-dump.
    - *Cosa deve fare il cliente:* se il sito importato manca di contenuti, esportare di nuovo e reimportare.
25. **Una connessione persa durante il caricamento** si legge come una riga sbagliata dell'export (uscita `60`, `dump_load_failed`) (`R165.5`).

**Quando l'annullamento non riesce**

26. **Senza copia, solo l'amministratore può riparare il sito** (`R152.5`, `R173`, `R174`, `R175`). Se i backup non sono configurati e l'importazione finisce `undo_incomplete`, il sito resta chiuso. L'operazione è chiusa e il blocco del sito è libero: lo sblocco d'emergenza vale solo per un'operazione `unknown` e qui non serve. Sotto, `<id>` è l'id dell'operazione senza `op_` (`§2.6`). Lo stato dipende dalla risposta che ha chiuso l'importazione:
    - **`db.import{undo}` con uscita `92`** (per esempio un trigger o una vista fatti dal codice importato, `§5`). Il database non è tornato: le tabelle importate sono nello schema del sito, quelle del vecchio sito in `hp_ia_<id>`; restano anche `hp_is_<id>` (vuoto) e `hp_im_<id>`. `import.undo` non è partita: i file sono quelli importati; le voci del vecchio sito sono in `.htpanel-import/<id>/aside/`; i due file salvati sono `.htpanel-import/<id>/wp-config.live` e `htaccess.live` (oppure `htaccess.absent`, se il sito non aveva un `.htaccess`). Il cancello è su.
    - **`import.undo` con `{complete:false}`, con la cartella `.htpanel-import/<id>/`.** Il database è tornato e i suoi resti sono rimossi. I file sono rimessi solo in parte (passo 3.3), o per niente: se un nome che il piano elenca come `O` e come `I` non ha più né `aside/<rel>` né `site/<rel>`, il programma non sposta nulla (passo 3). Il piano, quello che resta in `aside/` e in `site/`, i due file salvati e il cancello restano come erano.
    - **`import.undo` con `{complete:false}`, senza la cartella di lavoro o con un `.htpanel-import/<id>` che non è una cartella** (`R164.5.4`). Il database è tornato. Non ci sono piano, `aside/` né file salvati: dalla cartella di lavoro non si può rimettere nulla. Resta solo da togliere a mano quello che il cancello ha aggiunto: in testa a `wp-config.php` la riga di `HP_IMPORT_GATE_CONFIG`, `"<?php if (PHP_SAPI !== \"cli\") { header(\"Retry-After: 60\", true, 503); exit; } /* hosting-panel import gate */ ?>\n"`, e in fondo a `.htaccess` il blocco di `HP_IMPORT_GATE_HTACCESS`, `"\n# BEGIN hosting-panel import gate\n<If \"true\">\nRequire all denied\n</If>\n# END hosting-panel import gate\n"` (`apps/docker-executor/src/site-files-program.ts`). Prima va guardato quale sito sono i file, il vecchio o quello importato: il pannello non lo sa, e sopra il database di prima i file importati non vanno aperti. E va guardato il `table_prefix` in `wp-config.php`: può essere quello del sito importato (passo 5.1), non quello delle tabelle di prima.
    - *Cosa deve fare l'amministratore,* in quest'ordine.
      1. **Prima una copia a mano:** tutta la cartella dei file del sito, con dentro `.htpanel-import/<id>/`, e, dopo l'uscita `92`, un dump degli schemi nominati al passo 2 (lo schema del sito, `hp_ia_<id>`, `hp_is_<id>`, `hp_im_<id>`). Con questa copia nessuno sbaglio dei passi seguenti è senza rimedio.
      2. **Il database**, solo dopo l'uscita `92`, prima dei file: con il cancello tolto e le tabelle vecchie altrove, chiunque vedrebbe l'installazione di WordPress (`R152.1`). Con l'account root del server del database: togliere viste, trigger, routine ed eventi dallo schema del sito e da `hp_ia_<id>`; poi, solo se `hp_im_<id>` contiene la tabella `after` (il segno che lo scambio è avvenuto e non è stato rimesso), fare lo stesso `RENAME TABLE` del passo `undo` di `DB_IMPORT_SCRIPT` (`apps/docker-executor/src/site-jobs.ts`): le tabelle dello schema del sito in `hp_is_<id>`, quelle di `hp_ia_<id>` nello schema del sito; infine, con `hp_ia_<id>` vuoto, rimuovere `hp_is_<id>`, `hp_ia_<id>` e `hp_im_<id>`. Il pannello non ha uno strumento per questo passo.
      3. **I file**, come fa `hp_import_op_undo` (`apps/docker-executor/src/site-files-program.ts`). Si possono fare via SFTP, dove c'è (`ADR-0020`): ogni accesso SFTP del sito entra come l'utente `33:33` nei file del sito (`/files`, `sftp-platform.ts`), lo stesso utente con cui gira il programma che crea `.htpanel-import/<id>/` e i suoi file (`site-files-helper.ts`), e il server SFTP mostra i nomi `.htpanel-` che il file manager del pannello nasconde (un client SFTP può nascondere da sé i nomi che iniziano con un punto). Oppure dal server stesso. Il file `.htpanel-import/<id>/plan` elenca le voci, una per riga: `["O","<rel>"]` è una voce del vecchio sito messa da parte in `.htpanel-import/<id>/aside/<rel>`; `["I","<rel>"]` è una voce importata, portata nel sito da `.htpanel-import/<id>/site/<rel>`. Lo stesso nome può avere una riga `O` e una riga `I`. Come il programma (`hp_import_read_plan`), i passi seguono solo le righe che `json_decode` di PHP legge come una lista di due elementi, `"O"` o `"I"` e poi il nome di una sola voce in cima al sito o subito dentro `wp-content/`. Il nome non ha caratteri di controllo e non è `.htaccess`, `wp-config.php`, `wp-content`, `.maintenance` o `wp-content/mu-plugins`; la sua ultima parte non è `.` né `..`, ha al massimo `255` byte e non comincia con `.hp_rs_` o `.htpanel-`. Ogni altra riga si salta. Il piano lo possono scrivere anche il codice importato e ogni accesso SFTP del sito: una riga aggiunta come `["I","wp-content/mu-plugins"]` farebbe spostare in `site/` i plug-in obbligatori del pannello, compreso quello della posta, e il passo 6 li rimuoverebbe. **Prima di spostare qualunque cosa**, il controllo con cui comincia anche il programma: se per un nome con una riga `O` e una riga `I` non esiste né `aside/<rel>` né `site/<rel>`, una delle due copie è andata persa e dai nomi non si capisce quale, quindi la voce a `<rel>` nel sito può essere del vecchio sito o quella importata. Allora i passi si fermano e l'amministratore guarda la voce stessa. Se è del vecchio sito, resta dov'è e non si sposta mai. Se è quella importata, la voce del vecchio sito non è in nessuna cartella del pannello, neppure nella copia del passo 1: prima di andare avanti l'amministratore sposta quella importata in `site/<rel>` e rimette a `<rel>` quella del vecchio sito da una fonte sua; il controllo del passo 4 guarda solo che a `<rel>` ci sia una voce, non di quale sito è, e da solo non se ne accorge. Poi, per ogni nome del piano, in qualunque ordine:
         1. se `aside/<rel>` esiste ancora: prima spostare quello che c'è a `<rel>` nel sito, se c'è qualcosa, in `.htpanel-import/<id>/site/<rel>`; poi spostare `aside/<rel>` a `<rel>`;
         2. se il nome ha solo la riga `I` ed è ancora nel sito: spostarlo in `.htpanel-import/<id>/site/<rel>`;
         3. **un nome con una riga `O` la cui voce in `aside/` non c'è più è già tornato quando la copia importata è in `site/<rel>`, o il nome ha solo la riga `O`, o l'amministratore ha visto al controllo iniziale che è del vecchio sito: quello che c'è a `<rel>` nel sito non si sposta mai.**

         Se al passo 3.1 o 3.2 il posto `site/<rel>` è già occupato, l'amministratore sposta la voce a `<rel>` fuori dal sito, in un posto suo, non dentro `.htpanel-import/<id>/` (il passo 6 la rimuoverebbe), poi va avanti con il passo. Dai nomi non si capisce di quale sito sia quella voce.
      4. **Il controllo, prima di togliere il cancello**, lo stesso del programma: ogni nome con una riga `O` è nel sito e non più in `aside/`; ogni nome con solo la riga `I` non è più nel sito. Se uno solo non torna, fermarsi qui.
      5. **I due file salvati**, che tolgono il cancello. Ogni metà parte dal suo file salvato, come nel programma, che riscrive un file solo se il suo file salvato c'è:
         1. se c'è `.htpanel-import/<id>/wp-config.live`: rimuovere `wp-config.php` e spostare al suo posto `wp-config.live`. Se manca, `wp-config.php` non si rimuove, i passi si fermano qui e il sito resta chiuso. Non basta togliergli la riga del cancello: dopo `import.switch` il lavoro `wordpress.import-finalize` può aver scritto in quel file, con `wp config set`, il `table_prefix` del sito importato (`site-jobs.ts`), e il valore del vecchio sito è solo in `wp-config.live`;
         2. poi, se c'è `htaccess.live`: rimuovere `.htaccess` e spostare al suo posto `htaccess.live`; se c'è `htaccess.absent`: solo rimuovere `.htaccess`; se non c'è nessuno dei due: `.htaccess` non si rimuove, si toglie solo, nel file stesso, il blocco di `HP_IMPORT_GATE_HTACCESS` (sopra).

         In quest'ordine il `.htaccess` col cancello chiude ancora il sito mentre `wp-config.php` manca.
      6. **Rimuovere `.htpanel-import/<id>/`.** Con la cartella se ne vanno le voci importate e quello che il passo 3.1 ha tolto dal posto di una voce del vecchio sito (per esempio un file messo lì dal cliente); se servono, sono nella copia del passo 1.

      Questi passi non sono mai stati fatti a mano su un server vero. I test in `apps/docker-executor/test/site-files-program.test.ts` li fanno con semplici spostamenti di file, sugli stati lasciati dal programma stesso: «hand repair §4.26 after an undo stopped half way gives the old site back» e «hand repair §4.26 right after a full switch (exit 92, no undo run) gives the old site back, htaccess.absent too» fanno i passi 3-6 e ridanno il vecchio sito; «hand repair §4.26 stops before any move when a name in both trees has neither copy in the work folder» toglie a mano `aside/wp-includes` dopo uno scambio completo, vede `import.undo` rispondere `{complete:false}` senza spostare nulla e i passi fermarsi prima di spostare qualcosa, con il cancello su (quello che l'amministratore fa poi guardando la voce non è provato); «hand repair §4.26 keeps wp-config.php without wp-config.live, and only strips the .htaccess gate without its saved file» vede i passi fermarsi senza `wp-config.live`, con `wp-config.php` ancora lì, riga del cancello compresa, e, senza `htaccess.live` né `htaccess.absent`, togliere da `.htaccess` solo il blocco del cancello; «hand repair §4.26 moves the entry at a name whose site/<rel> is taken to the administrator's own folder», dopo uno scambio completo, rimette a mano la copia importata in `site/wp-content/uploads` e mette a `wp-content/uploads` nel sito una cartella con un file, come uno scambio fermato da un caricamento SFTP; `import.undo` risponde `{complete:false}`, poi i passi spostano quella cartella in una cartella fuori dal sito e ridanno il vecchio sito, con il cancello tolto e la cartella di lavoro rimossa, e la cartella spostata è al suo posto nuovo con il suo file; «hand repair §4.26 skips the plan lines the program skips: a planted wp-content/mu-plugins line leaves the folder in the site» aggiunge al piano la riga `["I","wp-content/mu-plugins"]`: sia `import.undo` sia i passi la saltano, ridanno il vecchio sito e `wp-content/mu-plugins` resta nel sito con il suo file. Il passo 2 non è provato. Il pannello non ha un pulsante per nessuno di questi passi.
27. **I resti nel database di un'importazione** non vengono rimossi, neppure da `db.drop` (`R155.6`, `R162.3`). Rimandato a M6. Restano in due casi:
    - dopo un `undo_incomplete` con uscita `92`: `hp_is_<id>`, `hp_ia_<id>`, `hp_im_<id>` (`§4.26`);
    - dopo un `db.import{finish}` fallito su un sito importato. L'esito resta `imported` e il passo `finish` dell'operazione è `failed` (lo è anche quando fallisce solo il controllo finale: il segno certo è che `hp_ia_<id>` o `hp_im_<id>` esiste ancora). Restano gli schemi che il passo non ha fatto in tempo a rimuovere; li rimuove in quest'ordine: `hp_is_<id>` (vuoto), `hp_ia_<id>` (le tabelle del sito di prima, con i dati dei suoi utenti), `hp_im_<id>`. `hp_is_<id>` può quindi non esserci più. L'account `'hp_iu_<id>'@'%'` non resta: lo scambio lo rimuove prima del `RENAME TABLE`.
    - *Cosa deve fare l'amministratore:* rimuoverli a mano con l'account root del server del database (dopo aver rimesso il sito, nel primo caso). Il pannello non ha uno strumento per farlo.
28. **Una cartella resa non scrivibile dal codice importato** fa fallire `import.undo` e `import.finish` ogni volta; l'operazione resta `unknown` con il blocco del sito (`R165.5`). Rimandato a M6.
    - *Cosa deve fare l'amministratore:* correggere i permessi via SFTP, oppure usare lo sblocco d'emergenza.
29. **Casi dell'annullamento non coperti** (`R166.5`, `R168.4`, `R175.4`), tutti rimandati a M6:
    - se il codice importato toglie entrambi i cancelli e un file salvato va perso, `import.undo` risponde `{complete:true}` senza rimettere nulla;
    - una cartella di lavoro cancellata a metà può ancora portare dentro una voce del sito aperto;
    - senza il file del piano, `import.undo` riscrive comunque i due file salvati (`wp-config.php`, `.htaccess`) sopra quello che il sito aperto ha cambiato;
    - se va perso un file salvato mentre il cancello è su, `import.undo`, quando ogni voce è tornata, lascia quel file col cancello, rimuove la cartella di lavoro e risponde `{complete:true}`: senza `wp-config.live` resta `wp-config.php` con la riga del cancello, senza `htaccess.live` né `htaccess.absent` resta `.htaccess` con il blocco del cancello.
    - *Cosa significa per il cliente:* nel primo caso la pagina dice che il sito è stato rimesso com'era (`site_restored`), ma sul disco restano i file importati sopra il database di prima, e le voci del vecchio sito sono state rimosse con la cartella di lavoro. Nel secondo e nel terzo il sito è quello di prima, ma può mancare una voce, o una modifica a `wp-config.php` o `.htaccess`, fatta dal sito già riaperto. Nel quarto la pagina dice che il sito è stato rimesso com'era (`site_restored`), ma i visitatori trovano ancora il sito chiuso; l'amministratore, come nel terzo stato di `§4.26`, toglie a mano quello che il cancello ha aggiunto e, se mancava `wp-config.live`, guarda il `table_prefix` in `wp-config.php`: può essere quello del sito importato, non quello delle tabelle di prima. In ogni caso la via indietro è la copia presa prima dell'importazione, dalla scheda Backup; senza copia, solo l'amministratore (`§4.26`).
30. **Una copia presa dopo un `undo_incomplete`** contiene il sito chiuso (`R164.7`).
    - *Cosa significa per il cliente:* per tornare indietro serve la copia presa **prima** di quell'importazione; la frase dell'esito lo dice.

**File, nomi e messaggi**

31. **Un ripristino da Backup rimuove i file caricati in attesa di un'importazione** (`R155.1`).
    - *Cosa deve fare il cliente:* dopo un ripristino, caricare di nuovo i due file.
32. **Un collegamento simbolico indicato con «pick» è rifiutato con `is_a_directory`** (`R164.6`). La pagina ha una frase propria per questo nome.
33. **Una copia fallita mostra il messaggio della copia** e non quello dell'importazione (`R164.6`, `§2.2`).
34. **La procedura guidata** (`arch-web`, `R171.12`):
    - nessuno l'ha aperta in un browser né ha mandato un file attraverso di essa a un'API in funzione. Caricamento, ripresa dopo una ricarica, «pick», scarto, avvio e il seguire l'importazione sono coperti solo da test che disegnano la pagina in modo statico e chiamano le sue funzioni (`§8`). Nessun caricamento, di nessuna dimensione, è stato provato dall'inizio alla fine;
    - riprendere un caricamento chiede di scegliere di nuovo lo stesso file;
    - la pagina smette di seguire dopo `10 minuti`; l'importazione continua e l'esito compare ricaricando;
    - per un file mandato via SFTP il cliente scrive il percorso;
    - un file mandato via SFTP resta scaricabile dal file manager finché non viene preso.
35. **Il controllo statico degli script è una rete per gli errori comuni, non una prova** (`R168.5`). Non vede `then`, `do`, `until` e `test "$(…)"` (`R166.5`).
36. **Un sito in una sottocartella, o con `home` e `siteurl` su host diversi, è rifiutato** (`§2.6`, `R171.15`, `R173.5`). Il caricamento vuole che `home` e `siteurl` siano ciascuno un'origine senza percorso (`http` o `https`, un host di sole lettere minuscole, cifre, `-` e `.`, una porta facoltativa) e che dopo lo schema siano uguali. Rifiuta quindi: un percorso in `home` o in `siteurl`, anche solo la `/` finale; un host o una porta diversi fra i due; un host con lettere maiuscole; un indirizzo che questo schema non prende (per esempio un indirizzo IPv6 o un nome con caratteri non ASCII). Accetta una differenza del solo schema (`http` in uno, `https` nell'altro). Esce `59` anche un export senza utenti. L'importazione finisce con `address_unsupported`, prima dello scambio.
    - *Cosa deve fare il cliente:* portare il vecchio sito alla radice del suo indirizzo, con `home` e `siteurl` sullo stesso host, poi esportare di nuovo.

**Non provato** (Parte 8 di `docs/security/step-4-acceptance-report.md`): archivi vicini ai tetti, altre versioni di WordPress e di PHP, un vero sito di un cliente. Nessuno ha aperto la procedura guidata in un browser né ha mandato un file attraverso di essa a un'API in funzione (`§4.34`).

**Non in questa milestone:** l'importazione di un multisite (rifiutata con `multisite_unsupported`); l'importazione da un indirizzo web o dal formato di backup di un altro pannello; una copia di prova del sito (staging); un pulsante che annulla un'importazione già finita (la via per tornare indietro è ripristinare la copia presa prima, dalla scheda Backup); un tetto di memoria e disco dell'export sul server del database e la rimozione dei resti di `§4.27` (M6).

**Nota sulla privacy.** L'export e l'archivio contengono i dati del vecchio sito, anche i suoi utenti. Stanno nella cartella del sito, che è del cliente. `import.finish` li rimuove alla fine di un'importazione riuscita; dopo un'importazione fallita restano finché il cliente non li scarta o un'importazione riuscita non li rimuove. I resti di `§4.27` possono tenere nel database le tabelle del sito di prima, con i dati dei suoi utenti, finché l'amministratore non li rimuove. L'audit tiene solo il vecchio host, mai un dato del database. Le prove usano solo siti usa e getta con indirizzi `example.test` e titoli neutri.

## 5. Modello di fiducia

- **Tutto quello che il cliente porta non è affidabile:** i nomi nell'archivio, le istruzioni nell'export, il codice PHP.
- **L'archivio** è letto solo dall'helper dei file, con i tetti di `§2.4`, dentro la cartella del sito. Una voce che esce dalla cartella, un collegamento o un nome riservato è rifiutato.
- **L'export** non vede mai la chiave root. Gira:
  - in un lavoro senza chiave root, con l'utente `33:33` e i file del sito in sola lettura;
  - con un account usa e getta che ha permessi solo sullo schema di prova e al massimo `2` connessioni;
  - con il client in modalità `--sandbox` (niente comandi del client come `system` o `source`) e `--local-infile=0` (niente lettura di file dal server).
  Un'istruzione che chiede di più è rifiutata dal server e finisce come `dump_statement_unsupported`.
- **Il lavoro con la chiave root** (`db.import`) non legge mai l'export. Esegue solo SQL costante, su nomi derivati dall'id dell'operazione, dopo aver controllato che nessun oggetto o nome strano sia entrato.
- **Il codice del sito importato gira** solo nella sistemazione, con i diritti del sito, come in `ADR-0023 §4.1`. Può far fallire la propria importazione e fermarne l'annullamento: un trigger o una vista fatti durante la sistemazione fanno uscire l'annullamento del database con `92`, e l'importazione finisce `undo_incomplete` (`R164.2`, `§4.26`). Può anche causare i casi di `§4.28` e `§4.29`. Non può toccare un altro sito né ottenere un permesso.
- **Il risultato** viaggia sul canale di `ADR-0023 §2.2`, ha un tetto ed è controllato due volte. Le ragioni vengono solo dai codici di uscita (`§2.7`), mai dal testo. Il testo è mostrato solo come testo.
- **I segreti** arrivano ai lavori solo come file. La password dell'account usa e getta vive solo nella memoria dell'API e nel lavoro. Nessuna coda mostrata contiene un segreto (passo `no-secret-in-any-tail` del collaudo).

## 6. Il difetto riparato (`R163`–`R167`)

La riscrittura dell'indirizzo spedita in M4a (`wordpress.set-url`, la stessa che serve all'importazione) sostituiva il vecchio indirizzo solo se seguito da `/`, `"` o `'`, in dieci passate di `wp search-replace`. Lasciava quindi il vecchio indirizzo in `user_url` (un valore che è esattamente l'indirizzo) e alla fine di una frase (la bozza della pagina Privacy). Lo ha trovato la QA.

**Primo giro (`R163`, `R164.1`):** una sola passata di `wp search-replace --regex` con un controllo in avanti che riconosce la fine dell'indirizzo (`§4.18`). Il secondo giro di verifica ha trovato che leggeva ogni cella di ogni tabella: `312,8 s` contro `10,5 s` su un sito con poche corrispondenze. La prova di velocità del lead non l'aveva visto perché il suo campione aveva l'indirizzo in ogni riga.

**Seconda riparazione (`R165`), via B:** un ciclo proprio dentro un solo `wp eval --skip-plugins --skip-themes`:
- solo le tabelle base del prefisso;
- solo le colonne di testo, tranne `guid` e `user_pass`;
- solo le righe che contengono il vecchio host (`LIKE BINARY`);
- gruppi di `500` per chiave primaria; una tabella senza chiave primaria è saltata;
- ogni valore passa da `WP_CLI\SearchReplacer` in modalità regex, che sa ricostruire i dati serializzati di PHP;
- una sola transazione; ogni errore dà uscita `26`.

Il terzo giro ha trovato due difetti. Un gruppo leggeva `500` righe intere: `600` righe di circa `994 KB` hanno ucciso il lavoro al suo tetto di memoria (uscita `26`, picco `537 MB`), mentre righe di `452 KB` passavano con un picco di `519 MB`. E un valore troppo lungo per la sua colonna veniva tagliato.

**Terza riparazione (`R166`, `R167`):**
- il gruppo legge solo le chiavi; ogni riga è letta da sola (picco `68 MB`, `15,7 s`);
- un valore più lungo della sua colonna tiene il valore vecchio: caratteri per `varchar(N)`; byte per `tinytext` (`255`), `text` (`65.535`), `mediumtext` (`16.777.215`); `longtext` non ha limite;
- dopo il commit la sessione è resa com'era: `mysqli_report(MYSQLI_REPORT_OFF)` e autocommit acceso.

Le due forme dello schema (`http`, `https`) e le due forme della barra (`/` e `\/`, come in JSON) sono fatte nella stessa passata.

**Numeri dal laboratorio** (Parte 8 di `docs/security/step-4-acceptance-report.md`):

| Sito | Dieci passate (spedito) | Via A (`--regex`) | Via B | Terza riparazione | Soglia |
|---|---|---|---|---|---|
| poche corrispondenze | `10,5 s` | `312,8 s` | `2,05 s` | `2,61 s` | sotto `120 s` |
| `200000` righe con l'indirizzo | `72,6 s` | `166,7 s` | `35,7 s` | `66,8 s` | sotto `240 s` |

Circa un milione di righe con l'indirizzo raggiungono i `360 s` di `wordpress.set-url` (`§4.6`).

## 7. Conformità alle regole architetturali

- **Socket Docker solo nell'executor:** API e Web non toccano Docker né il database del sito; ogni passo passa dall'IPC firmato verso l'executor o l'helper dei file.
- **`CP-01`:** nessun passo ferma, riavvia o ricrea il contenitore del sito o `hp_mariadb`. Il sito è chiuso solo dal cancello (`§2.8`).
- **Operazioni recuperabili:** una sola operazione con passi, lease e ripresa (`§2.3`); i passi non ripetibili non vengono mai ripetuti (`§2.1`).
- **Isolamento (`404`) e audit:** ogni route nuova risponde `404` per un sito di un'altra organizzazione; ogni mutazione scrive un evento senza segreti.
- **Nessun permesso nuovo, nessun flag di capacità nuovo, nessuna dipendenza npm nuova.** L'unica migrazione aggiunge una colonna.
- **Testi:** ogni frase in italiano e inglese; ogni errore dice cosa è successo e cosa fare; i testi del cliente non usano il gergo dei contenitori.

## 8. Verifica

- **Test automatici del motore (M4b-1):** contratti e tabella delle ragioni, helper dei file, tipi di lavoro e script costanti, applier e route dell'API. Sensori del lead `c8fix3` sull'albero `c2e8472`: build, lint, typecheck e test con uscita `0`; `140` file, `2356` test passati, `37` saltati.
- **Test del programma PHP dell'helper** sul sostituto locale: `41` passati (con i sei della riparazione a mano di `§4.26`, `R173`, `R174`, `R175`), `1` fallito. Quello fallito è il test spedito in M1 «clamps out-of-range mtime values…», che fallisce solo con il sostituto.
- **Collaudo su Docker reale: `infra/linux/accept-m4-import.mjs`**, `13` passi su un sito usa e getta creato come lo crea il prodotto, con le immagini `wordpress:cli-2.12.0-php8.4`, `wordpress:7.1.4-php8.4-apache` e `mariadb:12.3.3` (Docker `29.9.2`, Node `26.13.1`):
  1. `source-site-and-its-export`
  2. `staging-is-never-served`
  3. `import-in-the-ruled-order`
  4. `gate-holds-through-the-switch`
  5. `imported-site-answers-with-its-title`
  6. `address-job-still-works`
  7. `refused-exports-change-nothing`
  8. `refused-archives-change-nothing`
  9. `undo-after-the-switch`
  10. `killed-in-the-middle-of-the-swap`
  11. `an-unfinished-import-is-left-alone`
  12. `no-secret-in-any-tail`
  13. `nothing-left`

  Esito del lead: `13/13` in `128,2 s` (nel giro della terza riparazione: `13/13` in `128,8 s`). Tutti e otto gli script su Docker reale escono `0`.
- **Revisione della terza riparazione (`R168.1`):** la terza riparazione **non** è stata letta da un revisore nel ciclo 8. L'ha letta un solo revisore all'inizio del ciclo 9: non ha trovato difetti, ma non ha eseguito di nuovo né i test né i laboratori. I numeri di `§6` vengono dal giro della riparazione stessa.
- **Test della procedura guidata (M4b-2), scritti nel ciclo 9.** Cosa controllano:
  - `apps/web/test/wordpress-import-ui.test.ts`: la pagina, la card e le frasi di ogni esito e ragione;
  - `apps/web/test/wordpress-import-bff.test.ts`: le route BFF, il CSRF, la casella rifiutata prima di chiamare l'API, i corpi stretti;
  - `apps/web/test/wordpress-import-qa.test.ts` e `apps/web/test/ui-copy.test.ts` (fase QA): la sicurezza della procedura e il gergo vietato nei testi del cliente.
- **Nessuno ha aperto la procedura guidata in un browser** né ha mandato un file attraverso di essa a un'API in funzione. Caricamento, ripresa dopo una ricarica, «pick», scarto, avvio e il seguire l'importazione sono coperti solo da test che disegnano la pagina in modo statico e chiamano le sue funzioni.
- **Giro del lead del 2026-11-16**, sull'albero prima delle riparazioni della prima revisione del ciclo 9: `build`, `lint`, `typecheck` e `test` con uscita `0`; `143` file, `2457` test passati, `37` saltati. Di questi, `100` sono della procedura guidata: `apps/web/test/wordpress-import-ui.test.ts` `55`, `wordpress-import-qa.test.ts` `33`, `wordpress-import-bff.test.ts` `12`. Le riparazioni della revisione aggiungono test; i totali dell'albero finale sono nel testo della pull request. Gli script su Docker reale sono stati eseguiti l'ultima volta sull'albero del commit `238fe56`.
