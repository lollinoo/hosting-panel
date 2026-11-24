# ADR 0039 — Database Autonomi e Collegamento Privato tra Applicazioni

- **Stato:** `PROPOSTO` — scelte D1–D12 prese dall'agente su direttiva del proprietario del 2026-11-22 («vorrei funzionasse come funziona Coolify»); in attesa di approvazione
- **Data:** 2026-11-23
- **Riferimento:** `ADR-0035` (stack applicativi: questo ADR aggiunge un'eccezione, con limiti, alla regola «un componente sta solo sulle reti della propria applicazione»); issue #66, PR #67
- **Migrazioni:** `0028` (additiva; file `packages/database/migrations/0028_app_stack_links.sql`)

Questo ADR dà al cliente un database suo (MariaDB, PostgreSQL o Valkey) come applicazione a sé, e un collegamento privato perché le sue altre applicazioni lo usino. Non apre porte pubbliche e non tocca il proxy. I siti WordPress e il loro database condiviso non cambiano.

## 1. Contesto

Con `ADR-0035` ogni applicazione ha una rete privata sua (`hp_appnet_<stackId>`, senza uscita) e un componente è attaccato solo a quella, più la rete del proxy se riceve traffico web. Un modello non può pubblicare porte. Ne segue che un database installato da un modello non è raggiungibile da nessuno, e che due applicazioni dello stesso cliente non possono parlarsi. Oggi l'unico modo di dare un database a un'applicazione è metterlo dentro lo stesso modello: non si può condividere, dimensionare o sostituire da solo.

La tabella delle funzioni concordata con il proprietario dice, alla riga «database autonomi»: prenderli, MariaDB, PostgreSQL e Valkey per primi. Il pannello ragiona per **cliente**, non per gruppo di lavoro: un database è di un cliente, e solo le applicazioni dello stesso cliente possono usarlo.

Prima di scrivere codice ho provato su Docker reale (Docker Engine 29.10.0, oggetti usa-e-getta, nessuna immagine scaricata) che cosa il disegno può promettere:

- **MariaDB 12.3.3** parte con le protezioni di un componente così come sono (file system in sola lettura, nessuna capacità, utente fisso `999:999`, `/tmp` limitato), con socket e file del pid sotto `/tmp`. Le password arrivano come file; database e utente sono creati; una riga sopravvive a un riavvio.
- **PostgreSQL 18.7** con le stesse protezioni **non** si inizializza: lo script d'avvio dell'immagine deve scrivere il socket in `/run/postgresql` mentre crea il database, fallisce, e all'avvio successivo trova una cartella di dati e salta l'inizializzazione. Il server allora gira **senza il database richiesto**. Con un'area temporanea in più su quella cartella (1 MB, in memoria, niente di eseguibile) si inizializza, il file della password funziona e una riga sopravvive a un riavvio.
- **Il collegamento** (il container del database attaccato a una seconda rete privata con un nome fisso) si può fare su un container acceso, fermo o creato e mai avviato, e resta dopo un riavvio. Un'applicazione su quella rete raggiunge il database con quel nome; un'applicazione su una terza rete non risolve il nome e non raggiunge l'indirizzo. Attaccare due volte, o staccare due volte, è un errore di Docker.
- **Un pericolo:** a database fermo Docker lascia cancellare la rete dell'applicazione collegata, e poi il database **non parte più** («network not found») finché l'attacco rimasto non viene tolto. Staccare un database fermo e poi cancellare la rete funziona, e il database riparte.

I vincoli sono quelli di `HARNESS.md` e di `ADR-0035`: solo `hp-docker-executor` parla con Docker; nessun segreto in DTO, righe di audit, righe dell'outbox, operazioni, log o variabili d'ambiente di un container; un `POST` verso l'esecutore non si ripete alla cieca dopo un esito incerto; nessuna dipendenza npm, programma dell'host o variabile d'ambiente nuova; nulla è copiato da altri pannelli.

## 2. Decisioni

### D1 — Un database è un'applicazione

Un database è un'applicazione installata da un modello di categoria `database`. Non nasce un tipo di risorsa nuovo: installazione, avvio, fermo, aggiornamento, ritorno alla versione precedente, cancellazione, valori riservati, log e limiti sono quelli di ogni applicazione. Tre modelli integrati si aggiungono ai due esistenti e, come quelli, sono creati al primo avvio **disattivati**: un amministratore del server li attiva.

| Modello | Immagine | Porta | Dati |
| :--- | :--- | :--- | :--- |
| `mariadb` | `docker.io/library/mariadb:12.3.3` | 3306 | `/var/lib/mysql` |
| `postgresql` | `docker.io/library/postgres:18-bookworm` (PostgreSQL 18.7) | 5432 | `/var/lib/postgresql` |
| `valkey` | `valkey/valkey:9.2.0-alpine3.24` | 6379 | `/data` |

Ogni modello ha un solo componente, un volume di dati che resta quando l'applicazione viene cancellata (salvo richiesta esplicita) e nessun indirizzo web.

### D2 — Immagini

L'elenco delle immagini ammesse (`APP_IMAGE_ALLOWLIST`) guadagna due righe: `docker.io/library/mariadb` e `docker.io/library/postgres`, entrambe con utente `999:999`. La riga di `valkey/valkey` esiste già. Una riga vale solo per il nome scritto esattamente come lei, e queste due sono scritte per intero di proposito: `mariadb` e `postgres` scritti corti restano senza riga e non vanno mai «normalizzati» (`packages/contracts/test/app-image-allowlist-spelling.test.ts`). Il modello WordPress della release 0.10.0 (formato esteso, `ADR-0036`) scrive `mariadb` corto e fa girare il suo database con l'utente dell'immagine: una riga corta gli imporrebbe `999:999` e farebbe rifiutare dall'API e dall'esecutore i piani salvati delle applicazioni già installate. Per la stessa regola un file Compose che scrive l'immagine per intero (`docker.io/library/mariadb:…`) trova la riga e nella sua bozza prende l'utente della riga, mentre con il nome corto (`mariadb:…`) non la trova e resta all'utente dell'immagine. Come per le altre, ogni riga aspetta la conferma del proprietario; le immagini sono fissate per digest nei modelli:

| Modello | Immagine |
|---|---|
| Database MariaDB | `docker.io/library/mariadb:12.3.3@sha256:4aaf88b3106382c8c18e49f0cec60267be618fc22f858c4503afb2a2555afed3` |
| Database PostgreSQL | `docker.io/library/postgres:18-bookworm@sha256:194e55feb2597b1465dbee81cc9fd8d204566cd2eb42c8d22fd6c931a38781b1` |
| Archivio Valkey | `valkey/valkey:9.2.0-alpine3.24@sha256:c8e2d17498838af5d91e12eb7c11220b3434a7b7131a333e3af52ad5e0b80882` |

### D3 — Protezioni del container

MariaDB e Valkey girano con le protezioni di ogni componente, senza eccezioni. MariaDB parte con `mariadbd --socket=/tmp/mysqld.sock --pid-file=/tmp/mysqld.pid` nella prima versione del modello (`atv_mariadb_1`); la seconda (`atv_mariadb_2`) aggiunge `--tmpdir=/var/lib/mysql`, perché `/tmp` è un'area di 64 MB in memoria e un ordinamento o una tabella temporanea più grandi si fermavano con «No space left on device». Un'applicazione già installata resta sulla versione 1 finché il cliente non accetta l'aggiornamento (il container viene ricreato, il volume non cambia, i dati restano).

Valkey tiene al massimo 256 MB di dati (`--maxmemory 256mb`, politica `noeviction`): quando è pieno rifiuta le nuove scritture e tiene quello che ha, e le due descrizioni del modello lo dicono al cliente. La seconda versione (`atv_valkey_2`) porta il limite di memoria del container da 384 MB a 512 MB, il doppio del tetto, perché il processo, i suoi buffer e la copia fatta per uno snapshot o per riscrivere il file dei comandi possono superarlo, e senza swap il container che lo supera viene fermato; il tetto e ogni altro argomento restano quelli della versione 1. L'aggiornamento chiede 128 MiB in più al massimo di memoria del cliente: se è già al massimo, è rifiutato con la frase del limite del piano e l'archivio resta acceso sulla versione 1, intatto.

PostgreSQL ha bisogno di una sola area temporanea in più, `/run/postgresql`. La dichiara la **riga dell'immagine nell'elenco delle immagini ammesse** (campo `scratchPaths`), non il modello: nessun modello e nessun cliente può chiederne una. L'esecutore calcola le aree temporanee di un componente dalla riga della sua immagine (`/tmp` come oggi, più ogni percorso dichiarato con `rw,noexec,nosuid,nodev,size=1m`), e il controllo delle protezioni fatto prima di ogni creazione si aspetta esattamente quell'insieme. Per un'immagine senza `scratchPaths` il risultato è quello di oggi, byte per byte. Il formato dei modelli e il piano non cambiano.

### D4 — Credenziali

Le password sono **Valori riservati** che il cliente imposta, come per ogni applicazione: arrivano al container come file in sola lettura (`MARIADB_ROOT_PASSWORD_FILE`, `MARIADB_PASSWORD_FILE`, `POSTGRES_PASSWORD_FILE`), mai come variabili d'ambiente.

- **MariaDB:** database `app`, utente `app` con la password del cliente; l'account amministratore ha una password sua ed è utilizzabile solo da dentro il container (`MARIADB_ROOT_HOST=localhost`).
- **PostgreSQL:** database `app`, utente `app` (amministratore di quel server) con la password del cliente. Dalla rete la password è sempre richiesta.
- **Valkey:** senza password. È raggiungibile solo dalle applicazioni collegate (D5). Il programma accetta una password solo come argomento o in un file di regole che il cliente dovrebbe scrivere a mano; nessuna delle due forme passa per un file riservato senza una shell, che i modelli non possono usare.

Nome del database e utente sono fissi: il formato dei modelli di oggi non sa limitare i caratteri di un testo libero, e un nome sbagliato farebbe fallire la prima inizializzazione lasciando un volume a metà. Password, utenti e nomi generati dal pannello, e una password per Valkey, hanno bisogno del formato esteso (#42, non ancora unito) e sono l'issue #68.

### D5 — Collegamento privato

Un collegamento attacca il container del database alla **rete privata dell'applicazione** che lo usa (`hp_appnet_<stackId dell'applicazione>`), con un nome fisso. Non si crea nessuna rete nuova, non si apre nessuna porta, il proxy non è coinvolto.

- L'applicazione collegata raggiunge il database con quel nome e la porta del database.
- Un'applicazione non collegata non risolve il nome e non raggiunge l'indirizzo.
- Due applicazioni collegate allo stesso database non si vedono tra loro: stanno su due reti diverse, senza instradamento tra l'una e l'altra.
- Il database vede i componenti delle applicazioni a cui è collegato. È accettato: l'immagine del database è nell'elenco di quelle ammesse e tutto appartiene allo stesso cliente.

### D6 — Chi può essere collegato

- Il **database** è un'applicazione il cui modello ha categoria `database` e il cui piano ha un solo componente con una sola porta dichiarata. La regola è letta dall'API al momento del collegamento; il formato dei modelli non cambia.
- L'**applicazione** è una qualunque altra applicazione dello stesso cliente che non sia a sua volta un database.
- Al massimo 4 database per applicazione e 8 applicazioni per database. Un collegamento che si sta ancora togliendo (D8) conta finché il server non ha confermato.
- Un collegamento si può creare anche prima che una delle due parti sia installata: resta «in attesa» e si attiva da solo (D9).
- Non si crea un collegamento mentre una delle due parti sta cambiando (un'installazione, un avvio, un fermo o una cancellazione in corso) o mentre la sua cancellazione è rimasta a metà: la richiesta risponde `409` e si ripete dopo.
- **Finché un'applicazione lo usa, un database resta collegabile.** Una versione nuova del database il cui piano non ha più un solo componente con una sola porta è rifiutata (`database_in_use`): prima si tolgono i collegamenti.

### D7 — Nome interno

Il nome è l'identificativo dell'applicazione-database con `-` al posto di `_`: `stk_<24 cifre esadecimali>` diventa `stk-<24 cifre esadecimali>`. È lo stesso per tutte le applicazioni collegate, non cambia mai e non può coincidere con il nome di un componente: è lungo 28 caratteri, uno più del massimo di una chiave di componente, e un identificativo che darebbe un nome più corto, o non valido come nome DNS, è rifiutato. La pagina lo mostra con la porta come «indirizzo interno». L'esecutore lo calcola da sé dall'identificativo: la richiesta non porta un nome scelto da altri.

### D8 — Dati

Migrazione additiva `0028_app_stack_links.sql`, tabella `app_stack_links`: identificativo, cliente, applicazione (`consumer_stack_id`), database (`provider_stack_id`), stato, chi l'ha creato, quando è stato creato e quando è cambiato l'ultima volta. Una sola riga per coppia; le due parti sono diverse e dello stesso cliente (chiavi esterne composte verso `app_stacks(id, organization_id)`).

Il componente e la porta del database **non** sono nella riga: si leggono dal piano del database ogni volta che il collegamento viene applicato o mostrato. Una versione nuova del database non può così lasciare una riga che nomina un componente che non c'è più.

Gli stati sono tre:

- `pending` — registrato, non attaccato sul server, o non più per quanto il pannello ne sa (D9). La pagina dice «In attesa».
- `active` — attaccato, secondo l'ultima risposta del server. Non è una lettura continua dello stato di Docker.
- `removing` — il cliente l'ha tolto. La riga resta finché il server conferma che il database è staccato, poi è cancellata: un collegamento tolto mentre il server non risponde non sparisce dal pannello restando attaccato. Collegare di nuovo la stessa coppia nel frattempo riporta la stessa riga a `pending`.

### D9 — Come si applica

L'esecutore ha **una** chiamata nuova, `syncAppStackLinks`: per un database, l'elenco delle applicazioni a cui deve essere collegato. La chiamata legge lo stato e cambia solo ciò che differisce:

1. calcola il nome interno dall'identificativo del database (D7) e rifiuta un elenco che contiene il database stesso o un identificativo che non è quello di un'applicazione;
2. legge il container del database; se non c'è, risponde che ogni collegamento è in attesa e non tocca nulla. Se l'applicazione ha più di un container, o il container ha un'altra chiave, rifiuta: si collega solo un'applicazione con un componente;
3. controlla dalle etichette che Docker conserva che il container sia di quell'applicazione e di quel cliente. Rifiuta tutto, prima di cambiare qualcosa, se il container è attaccato a una rete che non è una delle sue due né la rete privata di un'altra applicazione, o se una rete da attaccare non è la rete privata dell'applicazione nominata, dello stesso cliente;
4. solo dopo che ogni controllo è passato: stacca le reti private delle applicazioni che non sono nell'elenco; stacca e rifà un attacco che il server non può più onorare (la rete non esiste più, è stata ricreata con lo stesso nome, o l'attacco non porta il nome interno); poi attacca quelle che mancano. Un'applicazione la cui rete non esiste ancora, o che l'esecutore sta cambiando in quel momento, lascia il collegamento in attesa.

La chiamata non avvia, non riavvia e non ricrea nessun container. La risposta dice, per ogni applicazione, «attaccato», «già attaccato» o «in attesa», e non contiene identificativi di Docker. Mentre l'esecutore sta cambiando il database, o sta già applicando i suoi collegamenti, la chiamata è rifiutata: una modifica del database non aspetta mai un collegamento.

L'API la invoca in tre momenti, sempre con l'elenco completo letto dal database del pannello e un passaggio alla volta per ogni database:

- quando un collegamento è creato o tolto (la risposta alla richiesta del cliente dice già se è attivo);
- all'inizio del passo di avvio di un'installazione, aggiornamento, ritorno, avvio o riavvio: per un'applicazione ogni database a cui è collegata (la sua rete può essere appena nata); per un database i suoi collegamenti (il container può essere appena stato sostituito e ha perso gli attacchi). Per un database la chiamata parte **sempre**, anche senza collegamenti registrati: un attacco rimasto verso una rete che non esiste più viene così tolto prima dell'avvio che farebbe fallire (§1);
- dall'osservatore, a ogni suo giro completo (ogni minuto, se l'intervallo non è impostato diversamente; un giro che dura di più è seguito da un solo giro, non da uno per ogni minuto passato), per al più 20 database senza operazioni in corso, quello che aspetta da più tempo per primo: quelli che hanno un collegamento da togliere, il collegamento di un'applicazione cancellata, oppure un collegamento in attesa verso un'applicazione senza operazioni in corso, quando database e applicazione hanno già una versione. Dopo 45 secondi il giro non chiama più l'esecutore per un altro database (una chiamata già partita arriva alla fine): un database che il giro ha raggiunto passa in fondo all'ordine, perché la risposta dell'esecutore, la sua mancanza o una versione a cui non si può chiedere nulla aggiornano le sue righe, e il giro dopo comincia da quelli non raggiunti. Così un esecutore lento non trattiene a lungo le richieste sugli indirizzi web, che aspettano lo stesso giro, e nessun database resta indietro per sempre.

Che cosa il pannello registra dopo la chiamata:

- un collegamento attaccato diventa `active`; uno che il server non ha attaccato resta o torna `pending`; uno `removing` è cancellato a ogni risposta, perché la chiamata stacca tutto ciò che non è nell'elenco;
- se l'esecutore rifiuta o non risponde, del server non si sa nulla: i collegamenti `active` di quel database tornano `pending` e l'osservatore chiede di nuovo. Non si ripete nulla alla cieca: ogni passaggio legge lo stato prima di cambiare qualcosa;
- una riga che il cliente ha cambiato mentre il passaggio era in corso non è sovrascritta: ogni scrittura vale solo per una riga ancora nello stato in cui era stata letta;
- di un database mai installato sul server non c'è nulla: i collegamenti restano in attesa e quelli tolti sono cancellati senza chiedere;
- se il pannello non ha un server a cui chiedere, le righe restano come sono;
- se la versione del database che è sul server non si legge o ha più di un componente, al server non si può chiedere nulla e sul server non cambia nulla: i collegamenti restano nello stato in cui sono (uno `active` continua a funzionare e resta `active`), ma le righe sono toccate, così il database passa in fondo all'ordine dell'osservatore e non tiene il posto di quelli che si possono applicare.

Un collegamento che non si riesce ad applicare **non fa fallire** l'operazione in corso: resta in attesa. Non c'è un tipo di operazione nuovo né un passo nuovo.

**Cancellazioni.** Un database che qualche applicazione usa ancora non si cancella (`database_in_use`): prima si tolgono i collegamenti. Cancellare un'applicazione toglie i suoi collegamenti nella stessa transazione che mette in coda la cancellazione. L'esecutore, prima di cancellare la rete privata di un'applicazione, stacca i componenti di altre applicazioni dello stesso cliente che vi sono attaccati, fermi o accesi (è la risposta al pericolo del §1); se uno non si lascia staccare la rete resta e la cancellazione fallisce, e se sulla rete c'è qualcos'altro la cancellazione è rifiutata come oggi. I collegamenti di un'applicazione cancellata da una release che non li conosce sono tolti al primo passaggio del loro database.

### D10 — Permessi

Nessun permesso nuovo: `app.read` per leggere i collegamenti, `app.update` per crearli e toglierli. Le due parti devono essere dello stesso cliente; l'applicazione o il database di un altro cliente risponde `404`.

### D11 — API

- `GET /v1/organizations/:orgId/app-stacks/:stackId/links` — che cosa è l'applicazione (`database` o `application`), i suoi collegamenti e il loro limite; se è un database il suo indirizzo interno, se non lo è i database che si possono ancora collegare (al più 50, per nome).
- `POST /v1/organizations/:orgId/app-stacks/:stackId/links` con `{ databaseStackId }` — collega un database all'applicazione `:stackId`. Si chiama solo dalla parte dell'applicazione. Risponde `201` con l'elenco aggiornato, che dice già se il collegamento è attivo.
- `DELETE /v1/organizations/:orgId/app-stacks/:stackId/links/:linkId` — toglie il collegamento, da una qualunque delle due parti, e risponde l'elenco aggiornato.

Le tre route sono sincrone come quelle degli indirizzi web: nessuna `Idempotency-Key`, nessuna operazione. L'indirizzo interno (nome e porta) è vuoto per un database che non è collegabile.

I rifiuti: `404` per un'applicazione o un database che non è del cliente; `400` con motivo `database_as_application`, `not_a_database`, `database_not_linkable` o `STACK_QUOTA_EXCEEDED` (limite raggiunto); `409` con motivo `link_exists`, oppure con lo stato dell'applicazione come motivo mentre una delle due parti sta cambiando; `422` finché la funzione delle applicazioni è spenta. La cancellazione e l'aggiornamento di un database in uso rispondono `400` con motivo `database_in_use` dalle route delle applicazioni che esistono già.

Righe di audit `app.stack.link.create` e `app.stack.link.remove`, con i due identificativi di applicazione e nient'altro. Nessuna risposta contiene un nome di rete, un identificativo di Docker o una password.

### D12 — Interfaccia, downgrade, fuori ambito

- **Pagina.** Sulla pagina di un database: l'indirizzo interno, la porta e le applicazioni che lo usano. Sulla pagina di un'applicazione: i database che usa, con i comandi per collegarne uno e per scollegarlo. Italiano e inglese, senza vocaboli di Docker. L'indirizzo va copiato dal cliente nelle impostazioni dell'applicazione: il pannello non scrive variabili nell'applicazione collegata.
- **Downgrade.** Nome di funzione `app-stack-links` per `hp-update`: in uso appena esiste una riga in `app_stack_links`. Una release precedente non saprebbe riattaccare un database dopo averne sostituito il container.
- **Ripristino del pannello.** Dopo `hp-restore-panel` sul server nuovo non c'è nessun container: i collegamenti `active` tornano `pending` e si attivano di nuovo quando le due applicazioni sono reinstallate.
- **Fuori ambito:** credenziali generate dal pannello e una password per Valkey (#68; serve #42); copia di un database senza fermarlo (#58); database raggiungibile da fuori del server; MySQL, MongoDB e altri motori; collegamento tra due applicazioni nessuna delle quali è un database; variabili scritte automaticamente nell'applicazione collegata. Le voci senza numero non hanno ancora un'issue.

### Alternative scartate

- **Una rete condivisa per cliente.** Tutte le applicazioni di un cliente si vedrebbero tra loro, anche quelle che non devono; oggi ognuna è isolata e deve restarlo.
- **Una rete nuova per ogni collegamento.** Funziona, ma obbliga a ricreare o riattaccare anche i componenti dell'applicazione e moltiplica gli oggetti da ripulire. Attaccare il solo database alla rete che l'applicazione ha già tocca un container solo.
- **Pubblicare la porta del database sull'host.** Apre il database a tutto il server e, senza regole di firewall nuove, a Internet. `ADR-0035` vieta le porte dell'host.
- **Un'area temporanea dichiarata dal modello.** Darebbe a chi scrive un modello una chiave in più da cui chiedere memoria eseguibile o grande; la riga dell'immagine è già il posto in cui il proprietario approva che cosa un'immagine può fare.
- **Un'operazione in coda per ogni collegamento.** Un collegamento tocca due applicazioni, e il blocco delle operazioni è per applicazione: servirebbero due blocchi insieme. La chiamata è breve, non ferma nulla e legge prima di cambiare: non le serve la coda.
- **Avviare PostgreSQL come utente `root` per lasciargli sistemare le cartelle.** Chiederebbe capacità che i componenti non hanno.

## 3. Conseguenze

- Un cliente può avere un database senza un sito WordPress, e più applicazioni possono usare lo stesso database.
- La regola di `ADR-0035` «un componente sta solo sulle reti della propria applicazione» ha ora un'eccezione scritta: il solo componente di un database, sulla rete privata di un'applicazione dello stesso cliente, attaccato dall'esecutore dopo i controlli di D9. `HARNESS.md` la fissa come azione vietata in ogni altra forma.
- Il container di un database collegato vede i componenti delle applicazioni che lo usano (D5).
- Un database in uso non si cancella e non passa a una versione che non è più collegabile: prima si tolgono i collegamenti.
- Il cliente copia a mano indirizzo, porta, utente e password nelle impostazioni dell'applicazione (D4, D12).
- Finché esiste un collegamento, `hp-update` rifiuta di tornare a una release che non conosce la funzione (codice 8), salvo `--allow-feature-loss`.
- Le quattro funzioni delle applicazioni restano spente su questo ramo come su `main` (le accende #43): nessun cliente raggiunge queste pagine finché non sono accese.

## 4. Come è stato costruito

- **Contratti.** `packages/contracts/src/app-templates/stack-links.ts` ha la categoria che fa di un'applicazione un database, i due limiti, i tre stati, il nome interno calcolato dall'identificativo (D7), la regola «un solo componente, una sola porta» (D6), la richiesta e la risposta della chiamata dell'esecutore e la forma delle risposte al cliente; `packages/contracts/src/app-templates/stack-operations.ts` aggiunge le due azioni di audit; `packages/contracts/src/app-templates/images.ts` ha le righe `mariadb` e `postgres` e le aree temporanee dichiarate per immagine (D2, D3); `packages/contracts/src/app-templates/built-in.ts` ha i tre modelli (D1); `packages/executor-contracts/src/stack-port.ts` aggiunge la chiamata alla porta dell'esecutore.
- **Database.** `packages/database/migrations/0028_app_stack_links.sql` crea la tabella di D8; `packages/database/src/app-stack-links-repository.ts` la legge e la scrive: la creazione con i limiti e il blocco delle due applicazioni, i tre stati, l'elenco dei database da ripassare; `packages/database/src/app-stacks-repository.ts` rifiuta la cancellazione e la versione non collegabile di un database in uso e toglie i collegamenti di un'applicazione cancellata.
- **Esecutore.** `apps/docker-executor/src/app-stacks/engine.ts` ha la chiamata di D9 e lo stacco dei database prima di cancellare una rete privata; `apps/docker-executor/src/app-stacks/container-payload.ts` dà a un componente `/tmp` e le aree dichiarate dalla riga della sua immagine e rifiuta ogni altro insieme (D3); `apps/docker-executor/src/server.ts` e `apps/docker-executor/src/client.ts` portano la chiamata sul canale firmato tra API ed esecutore (`POST /v1/app-stacks/links`, attesa massima di 60 secondi); `apps/docker-executor/src/simulator-app-stacks.ts` risponde allo stesso modo senza Docker.
- **API.** `apps/api/src/controllers/app-stack-links.controller.ts` ha le tre route di D11; `apps/api/src/app-stacks/app-stack-links.service.ts` controlla la richiesta, scrive la riga e l'audit e compone le risposte; `apps/api/src/app-stacks/app-stack-links-applier.ts` porta il server alle righe (D9) e non restituisce mai un errore a chi lo chiama; `apps/api/src/app-stacks/app-stack-runtime.ts` lo chiama all'inizio del passo di avvio e `apps/api/src/app-stacks/app-stack-observer.service.ts` a ogni giro; `apps/api/src/app-stacks/app-stack-errors.ts` traduce i rifiuti; `docs/api/openapi.yaml` descrive le route.
- **Pagina.** `apps/web/src/components/app-stacks/app-stack-links.tsx` è la sezione della pagina dell'applicazione (`apps/web/src/app/apps/[stackId]/page.tsx`): «Collegamento» per un database, con indirizzo, porta e applicazioni che lo usano; «Database» per ogni altra applicazione, con i database collegati e quelli che si possono collegare. Le richieste passano per `apps/web/src/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/links/route.ts` e `apps/web/src/app/api/bff/orgs/[orgId]/app-stacks/[stackId]/links/[linkId]/route.ts`; i testi sono in `apps/web/src/i18n/it.ts` e `apps/web/src/i18n/en.ts`.
- **Installazione.** `infra/linux/lib/common.sh` e `infra/linux/update.sh` hanno il controllo del downgrade e `infra/release/build-release.mjs` il nome della funzione (D12); `infra/linux/hp-restore-panel.sql` riporta a `pending` i collegamenti `active` dopo un ripristino del pannello.

Scostamenti dalla proposta scritta prima del codice:

- **Un terzo stato, `removing`.** La proposta aveva `pending` e `active` e cancellava la riga subito. Con il server che non risponde, il collegamento sarebbe sparito dal pannello restando attaccato su Docker.
- **Il componente del database non è più nella riga** (D8): si legge dal piano.
- **Un database in uso non passa a una versione non collegabile** (D6). La proposta non lo diceva; senza il rifiuto un aggiornamento avrebbe lasciato collegamenti che nessuno può più applicare.
- **All'avvio di un database la chiamata parte sempre**, anche senza collegamenti (D9). La proposta la faceva partire solo per i collegamenti registrati; così un attacco rimasto verso una rete cancellata non veniva tolto prima dell'avvio.
- **La chiamata ripara più casi**: oltre alla rete che non esiste più, la rete ricreata con lo stesso nome e l'attacco senza il nome interno. La rete sparita e la rete ricreata sono provate su Docker reale (passo `stale-attachment-repaired`, §5).
- **I momenti in cui l'API chiama sono tre**; la proposta ne annunciava quattro e ne elencava tre.
- **Dopo un ripristino del pannello i collegamenti tornano in attesa** (D12): la proposta non ne parlava.

## 5. Che cosa è provato

- **Prima del codice, su Docker reale** (2026-11-23, comandi `docker` a mano su oggetti usa-e-getta): i quattro punti del §1, e in più che PostgreSQL si inizializza con l'area temporanea in `/run/postgresql`, che un collegamento fatto su un container creato e mai avviato è attivo dopo l'avvio, e che staccare un database fermo permette di cancellare la rete e di riavviare il database.
- **Con Docker reale, sul codice** (`infra/linux/accept-app-stack-databases.mjs`, 23 passi su 23 il 2026-11-23 su Docker Engine 29.10.0, un passo saltato perché chiede `root`; il copione ha ora 25 passi: `mariadb-earlier-version-upgrades` (un'applicazione MariaDB creata sulla versione 1 e portata alla 2 tiene la sua riga; un'istruzione oltre i 64 MB di file temporanei si ferma sulla 1 e finisce sulla 2) e `valkey-earlier-version-upgrades` (un'applicazione Valkey creata sulla versione 1 e portata alla 2 tiene la sua chiave, ha 512 MiB di memoria e risponde con un tetto di 256 MB) sono scritti dopo quella esecuzione e non sono ancora stati eseguiti su Docker reale): l'adattatore di produzione dietro un socket che lascia passare solo le richieste previste (457 richieste, nessuna rifiutata, nessuna immagine scaricata, nessuna rete del proxy creata o nominata).
  - I tre database partono dai modelli incorporati con le protezioni di ogni componente (PostgreSQL con `/run/postgresql` come sola area in più) e nessun processo come `root`. Le password sono solo file in sola lettura su un'area temporanea e non compaiono nella descrizione del container che Docker restituisce, nei piani e nelle risposte dell'esecutore. Una password sbagliata è rifiutata; l'amministratore di MariaDB è rifiutato dalla rete e accettato dal socket locale. I dati restano dopo un riavvio.
  - Un'applicazione non collegata non risolve il nome di un database e non ne raggiunge l'indirizzo. Dopo il collegamento lo raggiunge con il nome interno e solo con quello (non con `db`), senza che il database sia riavviato o ricreato; la risposta non nomina oggetti di Docker; un secondo passaggio uguale non manda nessuna scrittura.
  - Due applicazioni collegate allo stesso database leggono gli stessi dati e non si raggiungono tra loro.
  - Un riavvio del database tiene gli attacchi; un container sostituito da una versione nuova li riceve prima dell'avvio e risponde allo stesso nome con i dati di prima.
  - Fermare un'applicazione collegata non tocca i database: restano attaccati alla sua rete, accesi, e la seconda applicazione, collegata a Valkey, continua a leggerlo. Avviata di nuovo, l'applicazione raggiunge i tre database con lo stesso nome; il passaggio prima dell'avvio non manda nessuna scrittura.
  - Cancellare un'applicazione stacca il database, acceso (che continua a girare) o fermo (che poi riparte).
  - Un attacco verso una rete che non esiste più impedisce l'avvio del database; il passaggio successivo lo toglie e il database parte. Una rete ricreata con lo stesso nome è sostituita nell'attacco dal passaggio prima dell'avvio.
  - Sono rifiutati senza cambiare nulla: il database nel suo stesso elenco, un identificativo non valido, un'applicazione con due componenti come database, un'altra chiave di componente (`STACK_PLAN_INVALID`); un'applicazione di un altro cliente, da una parte o dall'altra (`STACK_NAMESPACE_CONFLICT`). Nessun rifiuto nomina oggetti di Docker.
  - Staccare toglie la raggiungibilità senza riavvii; un database collegato si cancella con i suoi dati lasciando intatta la rete dell'applicazione; alla fine non resta nulla della prova e nulla di ciò che c'era prima è stato tolto.
  - **Limite di questa prova:** l'immagine usata come applicazione non ha un client di MariaDB o di PostgreSQL. Dal container dell'applicazione sono provate la risoluzione del nome e l'apertura della porta per i tre database, e lettura e scrittura per Valkey. L'accesso con utente e password a MariaDB e a PostgreSQL al nome del collegamento è fatto dal client del database, dentro il container del database.
- **Contratti e modelli** (`packages/contracts/test/app-stack-links.test.ts`, `packages/contracts/test/app-template-images.test.ts`, `packages/contracts/test/app-template-built-in.test.ts`, `packages/policy-engine/test/app-template-built-in.test.ts`): il nome interno è un nome DNS valido, diverso per ogni identificativo e mai uguale a una chiave di componente; il bersaglio è il solo componente sulla sua sola porta; richiesta e risposta dell'esecutore rifiutano chiavi in più; le risposte al cliente non hanno nomi di Docker né valori riservati. Solo la riga `postgres` dichiara un'area temporanea, sotto `/run` e mai `/run/secrets`. I tre modelli danno un piano con un componente, l'utente atteso, le password come file e nessun indirizzo web; MariaDB e PostgreSQL non danno un piano finché il cliente non ha impostato le password.
- **Database** (`packages/database/test/app-stack-links-repository.test.ts`, `packages/database/test/app-stacks-lifecycle.test.ts`, `packages/database/test/rollback-compat.test.ts`, `packages/database/test/restore-panel-sql.test.ts`, `packages/database/test/app-stack-links-downgrade-gate.test.ts`): i vincoli di D8; i rifiuti di D6 (stessa coppia, altro cliente, parte cancellata, in corso di modifica o cancellata a metà) e i due limiti; lo stato `removing` da una parte e dall'altra e il ritorno a `pending`; le scritture che valgono solo per una riga ancora nello stato letto; un database in uso non si cancella e non passa a una versione non collegabile; cancellare un'applicazione toglie i suoi collegamenti; la release precedente lavora con la tabella presente; dopo un ripristino del pannello nessun collegamento resta `active`; il controllo del downgrade scatta per una riga in qualunque stato.
- **Esecutore** (`apps/docker-executor/test/app-stack-links.test.ts`, `apps/docker-executor/test/app-stack-payload.test.ts`, `apps/docker-executor/test/app-stack-hardening.qa.test.ts`): attacco con il nome calcolato, anche di un container creato e mai avviato, senza avviarlo; stacco di ciò che non è nell'elenco; i rifiuti prima di qualunque modifica; la chiamata cede a una modifica del database in corso e non la fa mai aspettare né fallire; nulla è attaccato a un'applicazione che sta cambiando; le riparazioni degli attacchi; la cancellazione di un'applicazione stacca i database collegati e, se non ci riesce, fallisce tenendo la rete; il simulatore tiene lo stesso contratto. Le aree temporanee seguono la riga dell'immagine: `/tmp` da sola per ogni immagine che non ne dichiara, e un insieme diverso è rifiutato.
- **Route e passaggi** (`apps/api/test/app-stack-links.integration.test.ts`, `apps/api/test/app-stack-errors.test.ts`, `apps/api/test/app-stack-observer.unit.test.ts`): che cosa vedono un database e un'applicazione; un collegamento verso una parte non installata aspetta e si applica da solo; collegare e scollegare cambiano solo l'attacco; i rifiuti non scrivono nulla; `app.read` e `app.update`, con `403` e una riga di accesso negato; quattro database e otto applicazioni; un server che non risponde lascia il collegamento in attesa e l'osservatore lo applica dopo; con un server lento il giro dell'osservatore non chiama l'esecutore dopo 45 secondi e il giro dopo comincia dai database non raggiunti; un giro lungo dell'osservatore è seguito da un solo giro; venti database la cui versione ha più di un componente non tengono il posto di uno che si può collegare, e i loro collegamenti restano nello stato in cui erano, anche `active`; un collegamento che non si può applicare non fa fallire un avvio.
- **Pagina** (`apps/web/test/app-stacks-detail.test.ts`, `apps/web/test/app-stacks-bff.test.ts`, `apps/web/test/m6-web-qa-guards.test.ts`): ciò che la sezione mostra nei due ruoli e nei tre stati, il limite, collegare e scollegare, i testi dei rifiuti, il nome della sezione; le due route del collegamento sono le sole aggiunte alla pagina e non portano `Idempotency-Key`.
- **Installazione** (`infra/linux/features-gate.test.ts`, `infra/linux/update.test.ts`, `infra/release/release-manifest.test.ts`): un downgrade è rifiutato con codice 8 finché un database è collegato, e una release che conosce i collegamenti non è trattenuta.

Non provato:

- **Su Docker reale** (#70): il passo che legge le regole del firewall dell'host (chiede `root`); l'accesso a MariaDB e a PostgreSQL dal container di un'applicazione; un riavvio dell'host con database collegati.
- **`infra/linux/accept-m3-panel.mjs`** non è stato rieseguito con la riga nuova di `infra/linux/hp-restore-panel.sql`; quella riga è provata su PGlite (#70).
- **Le pagine viste da una persona** su un pannello installato.

Punti aperti:

- Le credenziali sono scritte a mano dal cliente e Valkey non ha password (#68).
- Un avvio rifiutato per un attacco verso una rete che non esiste più dice «Component db is not created», che non è la causa (#69). Dalle operazioni del pannello il caso non si presenta, perché il passaggio dei collegamenti viene prima dell'avvio.
- Quando il pannello non ha un server a cui chiedere, un collegamento `active` resta scritto così fino al primo passaggio che raggiunge l'esecutore.
- Un collegamento creato mentre la versione applicata del database ha ancora più di un componente aspetta l'installazione della versione collegabile.
