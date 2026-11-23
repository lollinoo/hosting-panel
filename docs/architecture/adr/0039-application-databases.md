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
| `mariadb` | `mariadb:12.3.3` | 3306 | `/var/lib/mysql` |
| `postgresql` | `postgres:18-bookworm` (PostgreSQL 18.7) | 5432 | `/var/lib/postgresql` |
| `valkey` | `valkey/valkey:9.2.0-alpine3.24` | 6379 | `/data` |

Ogni modello ha un solo componente, un volume di dati che resta quando l'applicazione viene cancellata (salvo richiesta esplicita) e nessun indirizzo web.

### D2 — Immagini

L'elenco delle immagini ammesse (`APP_IMAGE_ALLOWLIST`) guadagna due righe: `mariadb` e `postgres`, entrambe con utente `999:999`. La riga di `valkey/valkey` esiste già. Come per le altre, ogni riga aspetta la conferma del proprietario; le immagini sono fissate per digest nei modelli.

### D3 — Protezioni del container

MariaDB e Valkey girano con le protezioni di ogni componente, senza eccezioni. MariaDB parte con `mariadbd --socket=/tmp/mysqld.sock --pid-file=/tmp/mysqld.pid`.

PostgreSQL ha bisogno di una sola area temporanea in più, `/run/postgresql`. La dichiara la **riga dell'immagine nell'elenco delle immagini ammesse** (campo `scratchPaths`), non il modello: nessun modello e nessun cliente può chiederne una. L'esecutore calcola le aree temporanee di un componente dalla riga della sua immagine (`/tmp` come oggi, più ogni percorso dichiarato con `rw,noexec,nosuid,nodev,size=1m`), e il controllo delle protezioni fatto prima di ogni creazione si aspetta esattamente quell'insieme. Per un'immagine senza `scratchPaths` il risultato è quello di oggi, byte per byte. Il formato dei modelli e il piano non cambiano.

### D4 — Credenziali

Le password sono **Valori riservati** che il cliente imposta, come per ogni applicazione: arrivano al container come file in sola lettura (`MARIADB_ROOT_PASSWORD_FILE`, `MARIADB_PASSWORD_FILE`, `POSTGRES_PASSWORD_FILE`), mai come variabili d'ambiente.

- **MariaDB:** database `app`, utente `app` con la password del cliente; l'account amministratore ha una password sua ed è utilizzabile solo da dentro il container (`MARIADB_ROOT_HOST=localhost`).
- **PostgreSQL:** database `app`, utente `app` (amministratore di quel server) con la password del cliente. Dalla rete la password è sempre richiesta.
- **Valkey:** senza password. È raggiungibile solo dalle applicazioni collegate (D5). Il programma accetta una password solo come argomento o in un file di regole che il cliente dovrebbe scrivere a mano; nessuna delle due forme passa per un file riservato senza una shell, che i modelli non possono usare.

Nome del database e utente sono fissi: il formato dei modelli di oggi non sa limitare i caratteri di un testo libero, e un nome sbagliato farebbe fallire la prima inizializzazione lasciando un volume a metà. Password, utenti e nomi generati dal pannello hanno bisogno del formato esteso (#42, non ancora unito) e sono un'issue successiva.

### D5 — Collegamento privato

Un collegamento attacca il container del database alla **rete privata dell'applicazione** che lo usa (`hp_appnet_<stackId dell'applicazione>`), con un nome fisso. Non si crea nessuna rete nuova, non si apre nessuna porta, il proxy non è coinvolto.

- L'applicazione collegata raggiunge il database con quel nome e la porta del database.
- Un'applicazione non collegata non risolve il nome e non raggiunge l'indirizzo.
- Due applicazioni collegate allo stesso database non si vedono tra loro: stanno su due reti diverse, senza instradamento tra l'una e l'altra.
- Il database vede i componenti delle applicazioni a cui è collegato. È accettato: l'immagine del database è nell'elenco di quelle ammesse e tutto appartiene allo stesso cliente.

### D6 — Chi può essere collegato

- Il **database** è un'applicazione il cui modello ha categoria `database` e il cui piano ha un solo componente con una sola porta dichiarata. La regola è letta dall'API al momento del collegamento; il formato dei modelli non cambia.
- L'**applicazione** è una qualunque altra applicazione dello stesso cliente che non sia a sua volta un database.
- Al massimo 4 database per applicazione e 8 applicazioni per database.
- Un collegamento si può creare anche prima che una delle due parti sia installata: resta «in attesa» e si attiva da solo (D9).

### D7 — Nome interno

Il nome è l'identificativo dell'applicazione-database con `-` al posto di `_`: `stk_<24 cifre esadecimali>` diventa `stk-<24 cifre esadecimali>`. È lo stesso per tutte le applicazioni collegate, non cambia mai e non può coincidere con il nome di un componente: è lungo 28 caratteri, uno più del massimo di una chiave di componente, e un identificativo che darebbe un nome più corto, o non valido come nome DNS, è rifiutato. La pagina lo mostra con la porta come «indirizzo interno». L'esecutore lo calcola da sé dall'identificativo: la richiesta non porta un nome scelto da altri.

### D8 — Dati

Migrazione additiva `0028_app_stack_links.sql`, tabella `app_stack_links`: identificativo, cliente, applicazione (`consumer_stack_id`), database (`provider_stack_id`), componente del database, stato (`pending` o `active`), chi l'ha creato e quando. Una sola riga per coppia; le due parti sono diverse e dello stesso cliente (chiavi esterne composte verso `app_stacks(id, organization_id)`).

`active` significa: attaccato all'ultima applicazione dei collegamenti. Non è una lettura continua dello stato di Docker.

### D9 — Come si applica

L'esecutore ha **una** chiamata nuova, `syncAppStackLinks`: per un database, l'elenco delle applicazioni a cui deve essere collegato. La chiamata legge lo stato e cambia solo ciò che differisce:

1. legge il container del database; se non c'è, risponde che ogni collegamento è in attesa;
2. controlla dalle etichette che Docker conserva che il container sia di quell'applicazione e di quel cliente, e che ogni rete da attaccare sia la rete privata dell'applicazione nominata, dello stesso cliente; rifiuta tutto se il container è attaccato a una rete che non è sua né la rete privata di un'applicazione;
3. solo dopo che ogni controllo è passato: stacca le reti private di altre applicazioni che non sono nell'elenco (comprese quelle rimaste da una rete che non esiste più), poi attacca quelle che mancano. Una rete che non esiste ancora lascia il collegamento in attesa.

La chiamata non avvia, non riavvia e non ricrea nessun container.

L'API la invoca in quattro momenti, sempre con l'elenco completo letto dal database del pannello:

- quando un collegamento è creato o tolto (la risposta alla richiesta del cliente dice già se è attivo);
- all'inizio del passo di avvio di un'installazione, aggiornamento, ritorno, avvio o riavvio: per un database i suoi collegamenti (il container può essere appena stato sostituito e ha perso gli attacchi), per un'applicazione ogni database a cui è collegata (la sua rete può essere appena nata);
- dall'osservatore, ogni minuto, per i collegamenti in attesa le cui due parti sono installate e senza operazioni in corso.

Un collegamento che non si riesce ad applicare **non fa fallire** l'operazione in corso: resta in attesa. Dopo una risposta persa non si ripete nulla alla cieca: il collegamento è segnato in attesa e il passaggio successivo legge lo stato prima di cambiare qualcosa. Non c'è un tipo di operazione nuovo né un passo nuovo.

**Cancellazioni.** Un database che qualche applicazione usa ancora non si cancella: prima si tolgono i collegamenti. Cancellare un'applicazione toglie i suoi collegamenti nella stessa transazione che mette in coda la cancellazione; l'esecutore, prima di cancellare la rete privata di un'applicazione, stacca i componenti di altre applicazioni dello stesso cliente che vi sono attaccati, fermi o accesi (è la risposta al pericolo del §1). Se sulla rete c'è qualcos'altro, la cancellazione è rifiutata come oggi.

### D10 — Permessi

Nessun permesso nuovo: `app.read` per leggere i collegamenti, `app.update` per crearli e toglierli. Le due parti devono essere dello stesso cliente; l'applicazione o il database di un altro cliente risponde `404`.

### D11 — API

- `GET /v1/organizations/:orgId/app-stacks/:stackId/links` — i collegamenti dell'applicazione nei due ruoli, l'indirizzo interno se è un database, i database che si possono ancora collegare se non lo è.
- `POST /v1/organizations/:orgId/app-stacks/:stackId/links` con `{ databaseStackId }` — collega un database all'applicazione `:stackId`.
- `DELETE /v1/organizations/:orgId/app-stacks/:stackId/links/:linkId` — toglie il collegamento, da una qualunque delle due parti.

Righe di audit `app.stack.link.create` e `app.stack.link.remove`. Nessuna risposta contiene un nome di rete, un identificativo di Docker o una password.

### D12 — Interfaccia, downgrade, fuori ambito

- **Pagina.** Sulla pagina di un database: l'indirizzo interno, la porta e le applicazioni che lo usano. Sulla pagina di un'applicazione: i database che usa, con i comandi per collegarne uno e per scollegarlo. Italiano e inglese, senza vocaboli di Docker. L'indirizzo va copiato dal cliente nelle impostazioni dell'applicazione: il pannello non scrive variabili nell'applicazione collegata.
- **Downgrade.** Nome di funzione `app-stack-links` per `hp-update`: in uso appena esiste una riga in `app_stack_links`. Una release precedente non saprebbe riattaccare un database dopo averne sostituito il container.
- **Fuori ambito**, ciascuno un'issue successiva: credenziali generate dal pannello (serve #42); copia di un database senza fermarlo (#58); database raggiungibile da fuori del server; MySQL, MongoDB e altri motori; collegamento tra due applicazioni nessuna delle quali è un database; variabili scritte automaticamente nell'applicazione collegata.

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
- Finché esiste un collegamento, `hp-update` rifiuta di tornare a una release che non conosce la funzione (codice 8), salvo `--allow-feature-loss`.
- Le quattro funzioni delle applicazioni restano spente su questo ramo come su `main` (le accende #43): nessun cliente raggiunge queste pagine finché non sono accese.

## 4. Come è stato costruito

Compilato a lavoro finito.

## 5. Che cosa è provato

- **Prima del codice, su Docker reale** (2026-11-23, comandi `docker` a mano su oggetti usa-e-getta): i quattro punti del §1, e in più che PostgreSQL si inizializza con l'area temporanea in `/run/postgresql`, che un collegamento fatto su un container creato e mai avviato è attivo dopo l'avvio, e che staccare un database fermo permette di cancellare la rete e di riavviare il database.
- Il resto è compilato a lavoro finito.
