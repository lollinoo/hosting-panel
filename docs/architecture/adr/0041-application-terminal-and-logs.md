# ADR 0041 — Terminale e Log di un'Applicazione per l'Amministratore del Server

- **Stato:** `PROPOSTO` — scelte T1–T12 prese dall'agente su direttiva del proprietario del 2026-11-22 («vorrei funzionasse come funziona Coolify»); in attesa di approvazione
- **Data:** 2026-11-23
- **Riferimento:** `ADR-0027` (riavvio e terminale: il terminale dei siti, di cui questo ADR estende le regole), `ADR-0026` (salute, avvisi e log: la lettura dei log di un sito da parte dell'amministratore), `ADR-0035` (applicazioni: componenti, etichette, limiti dei container); issue #73, PR #74
- **Migrazioni:** `0030` (additiva; file `packages/database/migrations/0030_app_terminal_sessions.sql`)

Questo ADR dà all'amministratore del server, per le applicazioni, i due strumenti che ha già per i siti WordPress: leggere i log e aprire un terminale di testo. Non dà niente di nuovo al cliente e non cambia di un byte il terminale dei siti.

## 1. Contesto

Quando l'applicazione di un cliente non funziona, l'amministratore oggi vede una riga in sola lettura nell'elenco **Applicazioni** e nient'altro: per guardare dentro deve entrare nel server con SSH e usare Docker a mano, che è proprio quello che il pannello serve a evitare.

La tabella delle funzioni concordata con il proprietario dice, alla riga «terminale, log, file»: adattarli alle applicazioni; **mai la shell dell'host**. Il pannello ragiona per **cliente**, e il suo cliente non è una persona tecnica: per questo il terminale resta uno strumento dell'amministratore, come per i siti.

Che cosa c'è già:

- **Il terminale dei siti** (`ADR-0027` §2.4). Una shell `/bin/sh` nel container del sito, come `33:33`, di solo testo, dietro un codice nuovo dell'app di autenticazione; al massimo quattro sessioni sul server e una per sito; finisce da sola dopo 60 secondi senza letture o dopo 30 minuti; ciò che è digitato e stampato non è mai salvato. È scritto per un sito: l'API cerca il sito e il suo servizio, l'esecutore controlla l'etichetta `io.hostingpanel.site_id` e lancia la shell come proprietario dei file del tipo di sito, e la colonna `site_id` della tabella `admin_terminal_sessions` non può essere vuota.
- **Lo script che chiude una sessione** usa `ps` e `pkill`. Le immagini dei siti li hanno; quelle delle applicazioni non è detto.
- **I log di un componente** si leggono solo dalla route del cliente, con il permesso `app.read` sull'organizzazione del cliente. Un amministratore del server non lo ha, nemmeno in visita di assistenza (`SUPPORT_ACCESS_PERMISSIONS` non contiene nessuna chiave `app.*`).
- **L'elenco dell'amministratore** (`GET /v1/admin/app-stacks`, `ADR-0035` §2.16) è in sola lettura e non nomina i componenti.
- **Un container di applicazione** (`ADR-0035`) parte senza nessuna capability, con `no-new-privileges`, con il file system di base in sola lettura, con i suoi limiti di memoria e di processi, come l'utente fissato dal piano o, se il piano non lo fissa, come quello della sua immagine. I suoi segreti sono file in sola lettura in `/run/secrets` e, per un modello del formato esteso, anche valori del suo ambiente (`ADR-0036` §2.5).

I vincoli sono quelli di `HARNESS.md`: solo `hp-docker-executor` parla con Docker; nessun id di Docker, percorso dell'host o segreto in DTO, righe di audit, righe dell'outbox o log; nessuna dipendenza npm, programma dell'host o variabile d'ambiente nuova; nulla è copiato da altri pannelli.

## 2. Decisioni

### T1 — Chi

Solo gli **amministratori del server**, e solo dove le applicazioni sono disponibili (`applicationStacksAvailable`). Il cliente non ha un terminale: non è una persona tecnica, e una shell nelle sue mani sposterebbe su di lui la responsabilità di ciò che rompe. I log della sua applicazione li legge già sulla pagina dell'applicazione, e lì non cambia niente.

Come per i siti, l'amministratore non ha bisogno di una visita di assistenza: le route sono quelle dell'amministratore (`/v1/admin/…`, dietro `requireServerAdmin` prima di ogni altro controllo), non quelle del cliente. Una visita di assistenza continua a non dare nessun permesso sulle applicazioni attraverso le route del cliente. Ogni lettura dei log e ogni terminale scrivono nel **Registro attività** chi, quale applicazione e di quale cliente.

### T2 — La pagina di un'applicazione

`GET /v1/admin/app-stacks/{stackId}` risponde con un'applicazione qualsiasi del server: nome, cliente, modello e versione, stato, indirizzo principale e i **componenti**, ciascuno con la sua chiave e l'ultima salute osservata. Come l'elenco, non contiene nessun segreto, nessun valore dei parametri e nessun piano. Un'applicazione sconosciuta o eliminata è `404`.

### T3 — I log di un componente

`GET /v1/admin/app-stacks/{stackId}/components/{componentKey}/logs` risponde con le ultime righe di log del componente: le stesse che vede il cliente, lette dallo stesso codice, con i valori dei segreti dell'applicazione **mascherati** e lo stesso tetto al numero di righe. La lettura scrive `admin.app_stack.logs.read` nell'audit, con l'organizzazione del cliente, l'applicazione, il componente e quante righe: quelle righe sono dati del cliente, come quelle dei log di un sito (`admin.site.logs.read`).

### T4 — Che cos'è il terminale di un componente

È il terminale dei siti: una shell `/bin/sh` di solo testo (`TERM=dumb`, 24×80), riga per riga, con i pulsanti **Ctrl-C**, **Ctrl-D** e **Chiudi**, mostrata dalla stessa console. Cambia dove gira e come chi:

- gira **dentro il container del componente**, quello che esiste già. Il pannello non lancia mai una shell sull'host e non avvia mai un container di servizio per questo;
- gira **come l'utente del componente**: l'esecutore non indica nessun utente e nessuna cartella, quindi Docker usa quelli con cui il container è stato creato. La shell eredita anche tutto il resto: nessuna capability, `no-new-privileges`, file system di base in sola lettura, i limiti di memoria e di processi del componente, le sole reti e i soli volumi del componente. **Ha i poteri del componente e non uno di più**;
- non c'è una cartella di partenza imposta: è quella dell'immagine.

Un'immagine senza `/bin/sh` non ha un terminale: la sessione si apre e finisce subito (`shell_exited`), con la riga di errore di Docker come unico testo. Non c'è un motivo di rifiuto nuovo per questo. Anche lo script di pulizia (T7) è `/bin/sh`: in un'immagine così il motore lo rifiuta con il suo messaggio (`OCI runtime exec failed…`) e il codice 127 o 126, e l'esecutore conta la pulizia come fatta, alla fine di una sessione, alla chiusura chiesta dalla passata dell'API e nella pulizia all'avvio, perché lì nessuna shell di una sessione ha mai girato. Un 126 o un 127 senza quel messaggio viene dallo script, che non stampa niente, e resta un fallimento. Il terminale dei siti non cambia.

### T5 — Aprire

`POST /v1/admin/app-stacks/{stackId}/components/{componentKey}/terminal`, con il corpo `{code}`, risponde `201` con l'id della sessione, l'applicazione, il componente, il nome del container, l'apertura e la scadenza. L'ordine dei controlli è quello dei siti:

1. amministratore del server (`403` e una riga di audit per chiunque altro) e applicazioni disponibili;
2. applicazione e componente (`404`);
3. runtime o esecutore non disponibili (`503`);
4. applicazione in modifica: il suo stato è uno di quelli occupati (in coda, in installazione, in avvio, in arresto, in aggiornamento, in eliminazione) o un'operazione tiene il suo blocco (`409`, motivo `site_changing`);
5. applicazione mai installata o fermata (`409`, motivo `container_down`);
6. il codice a sei cifre, con le stesse regole e gli stessi rifiuti dei siti: mancante (`400`), account senza autenticazione in due passaggi (`403`), account bloccato (`423`), errato o già usato (`401`). Ogni rifiuto del codice scrive `admin.terminal.denied` con il motivo, l'applicazione e l'organizzazione del cliente;
7. la riga della sessione e la riga di audit `admin.terminal.open`, salvate **prima** di chiamare l'esecutore;
8. l'esecutore.

I motivi di rifiuto restano i cinque dei siti (`container_down`, `site_changing`, `site_busy`, `server_full`, `session_ended`): sono chiavi di un elenco chiuso, non testi. Le frasi che l'amministratore legge parlano di «applicazione».

Scrivere, leggere e chiudere usano le route che ci sono già (`/v1/admin/terminal/{sessionId}/write|read|close`): servono i due tipi di sessione.

### T6 — Limiti in comune con i siti

- **Quattro sessioni sul server**, contate insieme: siti e applicazioni.
- **Una sessione per container**: una per sito, una per componente. Due componenti della stessa applicazione possono avere ciascuno la sua.
- **60 secondi senza una lettura** o **30 minuti** dall'apertura, e la sessione finisce da sola.

L'API applica i limiti sotto un blocco della tabella; l'esecutore li applica di nuovo per conto suo.

### T7 — Come finisce, e che cosa non resta

I modi di finire sono quelli dei siti (`closed`, `shell_exited`, `idle`, `time_limit`, `container_gone`, `executor_gone`, `not_started`). `container_gone` è la fine di una sessione quando l'applicazione viene fermata, riavviata, aggiornata, riportata indietro o eliminata: il container che ospitava la shell non c'è più o è ripartito.

Ogni fine, tranne quelle in cui il container o l'esecutore non ci sono più, lancia nel container uno **script di pulizia** che uccide i processi segnati dalla sessione e tutti i processi delle loro sessioni di sistema, compresi quelli lanciati in fondo con `&`, `nohup` o `setsid`. È uno script **diverso da quello dei siti**, perché l'immagine di un'applicazione può non avere `ps`, `pkill` o `grep`: usa solo comandi interni della shell (`read`, `case`, `kill`) e i file di `/proc`. Gira come l'utente del componente, non tocca mai il processo 1 né sé stesso e non tocca i processi del componente, che non portano il segno; se il processo 1 porta il segno, non uccide niente (§4).

All'avvio l'esecutore fa la stessa pulizia in ogni container di applicazione in esecuzione che ha ancora un comando aperto, come fa già per i siti: una shell rimasta da una vita precedente dell'esecutore non sopravvive al suo riavvio.

### T8 — L'esecutore controlla, non si fida

L'API manda all'esecutore l'id della sessione, l'applicazione, l'organizzazione e la chiave del componente: mai un nome o un id di container. L'esecutore:

- ricava da sé il nome del container (`hp_app_<applicazione>_<componente>`);
- rifiuta se le etichette del container non dicono che è gestito dal pannello, di quell'applicazione, di quell'organizzazione, con il ruolo di componente e con quella chiave, o se il nome non è quello ricavato. È lo stesso controllo della lettura dei log;
- rifiuta se il container non è in esecuzione.

La chiamata è nuova e separata da quella dei siti, e sta in un'interfaccia opzionale accanto a quella delle applicazioni: un esecutore che non la offre fa rispondere `503` all'API. L'elenco delle sessioni dell'esecutore contiene i due tipi; la passata dell'API ne legge solo l'id e la fine.

### T9 — Dati

Una sessione appartiene a **un sito oppure a un componente**, mai a entrambi e mai a nessuno. La migrazione `0030` rende `site_id` facoltativa, aggiunge `stack_id` e `component_key` e un vincolo che vuole esattamente uno dei due bersagli. La tabella resta senza chiavi esterne: una riga resta anche quando l'applicazione non c'è più.

Le righe di audit sono le stesse dei siti, con un bersaglio diverso: `admin.terminal.open` e una sola `admin.terminal.close` per sessione, sull'applicazione, con il componente, il nome del container, la durata e il motivo della fine.

**Ciò che viene digitato e ciò che la shell stampa non è mai salvato**: né nella tabella, né nell'audit, né nei log dell'API, del web o dell'esecutore.

Nessun DTO contiene un id di Docker: il nome del container è quello che il pannello ricava da sé.

### T10 — Pagine

- **Applicazioni** dell'amministratore: la riga di un'applicazione porta alla sua pagina.
- **La pagina di un'applicazione** (`/admin/apps/{stackId}`): cliente, modello e versione, stato; per ogni componente la salute, i log e il collegamento al terminale.
- **Il terminale** (`/admin/apps/{stackId}/terminal/{componentKey}`): il titolo nomina il componente, l'applicazione e il suo cliente, perché due clienti possono avere un'applicazione con lo stesso nome; la console dei siti, con le sue regole di pagina (chiude la sessione quando la pagina viene lasciata, la considera persa dopo 40 secondi senza risposta).

Italiano e inglese. Le pagine ci sono solo dove le applicazioni sono disponibili. Nessuna pagina del cliente cambia.

### T11 — Release precedente e ritorno indietro

Nessun blocco in `hp-update` e nessuna voce nuova tra le funzioni di una release: la migrazione è additiva e la release precedente continua a funzionare sul database migrato. Le sue scritture mettono sempre `site_id`, quindi rispettano il vincolo nuovo; la sua passata chiude come `executor_gone` una riga di applicazione rimasta aperta.

Un limite dichiarato: dopo un ritorno alla release precedente, una shell rimasta in un container di applicazione non viene uccisa dall'esecutore vecchio, che pulisce solo i siti. Nessuno è collegato a quella shell e resta dentro i limiti del componente; basta riavviare l'applicazione.

### T12 — Fuori ambito

Ciascuno è un lavoro successivo, con la sua issue: un terminale per il cliente; un file manager sui volumi di un'applicazione; un terminale nel programma di console di un database o in un container del pannello; la registrazione di una sessione.

### Alternative scartate

- **Un container di servizio con gli strumenti dentro**, attaccato ai volumi e alle reti dell'applicazione. Avrebbe una shell anche per le immagini che non ne hanno una, ma sarebbe un secondo container con poteri che il componente non ha, da creare, limitare e togliere: una superficie nuova per un caso raro.
- **La shell come `root`**, per poter installare strumenti. Il file system di base è in sola lettura e non ci sono capability: `root` non servirebbe, e sarebbe un utente che il componente non ha.
- **Un terminale per il cliente**, come nei pannelli per sviluppatori. Il cliente di questo pannello non è tecnico (`ADR-0027`, `ADR-0035`).
- **Lo script di pulizia dei siti anche per le applicazioni.** Fallirebbe in silenzio nelle immagini senza `ps` e `pkill`, lasciando vivi i processi lanciati in fondo.
- **Passare dalla visita di assistenza** (aggiungere `app.read` ai suoi permessi). Aprirebbe all'amministratore tutte le pagine del cliente sulle applicazioni, parametri compresi, per dargli due letture.
- **Una tabella nuova per le sessioni delle applicazioni.** Il limite di quattro sessioni sul server vale per i due tipi insieme: con due tabelle andrebbe contato sotto due blocchi.

## 3. Conseguenze

- **L'amministratore può leggere i segreti dell'applicazione dal terminale**: i file in `/run/secrets` sono leggibili dall'utente del componente, come `wp-config.php` lo è nel terminale di un sito, e i segreti che un modello del formato esteso dà nell'ambiente del componente sono nell'ambiente della shell, che lo eredita dal container. I log restano mascherati; il terminale no.
- **L'amministratore può cambiare i dati dell'applicazione** nei suoi volumi. Il pannello non ne sa niente: la riga di audit dice che una sessione c'è stata, non che cosa ha fatto.
- **Gli strumenti sono quelli dell'immagine.** Molte immagini di applicazioni hanno pochi comandi; i programmi a schermo intero non funzionano, come per i siti.
- **Un processo che lascia la sessione e toglie il segno dal proprio ambiente sopravvive alla chiusura** finché l'applicazione non viene riavviata: è lo stesso limite dei siti (`ADR-0027` §4, limite 2).
- **I limiti contano insieme.** Quattro terminali aperti sui siti non ne lasciano nessuno per le applicazioni, e viceversa.
- L'elenco delle applicazioni dell'amministratore non è più solo un elenco in sola lettura: ogni riga porta a una pagina con due strumenti (`ADR-0035` §2.16 aggiornato).

## 4. Come è stato costruito

- **Contratti.** `packages/contracts/src/admin-terminal.ts` (T5, T6): `AppTerminalSessionDtoSchema`, la risposta all'apertura in un componente, e `TERMINAL_SESSIONS_MAX`, il limite di quattro per i due tipi insieme. `packages/contracts/src/app-templates/admin-dto.ts` (T2): `AdminAppStackDtoSchema`, la pagina di un'applicazione. `packages/contracts/src/app-templates/stack-ipc.ts` e `packages/contracts/src/ipc-schemas.ts` (T8): la richiesta `AppStackTerminalOpenIpcRequestSchema`, che nomina la sessione, l'applicazione, l'organizzazione e il componente e nient'altro, e l'elenco delle sessioni dell'esecutore con i due tipi.
- **Database.** `packages/database/migrations/0030_app_terminal_sessions.sql` (T9). `packages/database/src/admin-terminal-repository.ts`: `openAppTerminalSession` accanto a `openTerminalSession`, sotto lo stesso blocco della tabella e con gli stessi due conteggi.
- **Contratti dell'esecutore.** `packages/executor-contracts/src/stack-terminal-port.ts` (T8): l'interfaccia opzionale `AppStackTerminalPort` e `isAppStackTerminalExecutor`, che dice se un esecutore la offre.
- **Esecutore.** `apps/docker-executor/src/terminal-docker.ts` (T4, T7): `startAppStackTerminal`, lo script di pulizia `APP_STACK_TERMINAL_KILL_SCRIPT` e `reapAppStackTerminalShells`, la pulizia all'avvio. `apps/docker-executor/src/terminal-sessions.ts` (T6): un solo gestore per i due tipi di sessione. `apps/docker-executor/src/app-stacks/engine.ts` (T8): `findAppStackComponentContainer`, il controllo del nome e delle etichette che la lettura dei log faceva già, ora in comune. `apps/docker-executor/src/simulator-terminal.ts` e `apps/docker-executor/src/simulator-app-stacks.ts`: lo stesso senza Docker.
- **API.** `apps/api/src/controllers/admin-app-stacks.controller.ts` (T1–T3, T5): le tre route nuove. `apps/api/src/app-stacks/admin-app-stacks.service.ts`: la pagina e i log. `apps/api/src/terminal/admin-terminal.service.ts`: `openInComponent`. Le tre route sono in `docs/api/openapi.yaml`.
- **Pagine.** `apps/web/src/app/admin/apps/[stackId]/page.tsx` e `apps/web/src/app/admin/apps/[stackId]/terminal/[componentKey]/page.tsx` (T10); le due route di passaggio sotto `apps/web/src/app/api/admin/app-stacks/[stackId]/components/[componentKey]/`; `apps/web/src/components/admin/terminal-console.tsx`, la console dei siti, che ora accetta un sito oppure un componente.
- **Verifica su Docker vero.** `infra/linux/accept-app-terminal.mjs`. Procedure dell'operatore: `docs/runbooks/application-stacks.md`, procedure 12 e 13.

Scelte prese costruendo. Sono dell'agente, come T1–T12, e aspettano la stessa approvazione:

- **Lo stato che la pagina mostra e quello che decide.** La pagina dell'amministratore mostra lo stato che il cliente vede sulla sua; il rifiuto di un terminale guarda lo stato salvato nella riga. «Sconosciuto» su una pagina è un'osservazione vecchia, non una modifica in corso, e non deve rifiutare un terminale.
- **Che cosa è `404`.** Un id scritto male, un'applicazione sconosciuta o eliminata, una chiave che non è tra i componenti dell'applicazione. Vale per la pagina, per i log e per il terminale.
- **Quale rifiuto.** Uno stato occupato, oppure un'operazione attiva sul blocco dell'applicazione, è `site_changing`. Un'applicazione mai installata (`draft`) o fermata (`stopped`) è `container_down`. Un runtime non disponibile e un esecutore che non offre la chiamata sono lo stesso `503`. Nessuno di questi rifiuti consuma il codice.
- **Un solo controllo del codice.** Siti e applicazioni passano dallo stesso passo, che riceve il bersaglio da scrivere nell'audit: le regole del codice non possono divergere tra i due.
- **Il nome del container lo ricava anche l'API**, per la riga della sessione e per l'audit, che sono salvati prima di chiamare l'esecutore. L'esecutore lo ricava di nuovo per conto suo e non riceve quello dell'API.
- **Ordine delle guardie nelle tre route.** Prima l'amministratore del server (`403` e riga di audit), poi le applicazioni disponibili (`422`). Chi non è amministratore riceve `403` anche dove le applicazioni sono spente.
- **L'audit dei log** tiene nei dettagli il componente e il numero di righe chieste, mai una riga letta.
- **Un'applicazione può non avere un indirizzo.** Un modello con un ingresso si installa e gira anche senza nessun dominio: la pagina lo dice («Nessun indirizzo web») invece di mostrare un campo vuoto.
- **Nell'elenco** la riga di un'applicazione ha un solo collegamento, **Apri**, alla sua pagina. Non ha pulsanti e non porta a nessuna pagina del cliente.
- **La scheda dei log** è quella della pagina del cliente, che legge dalla route dell'amministratore: lo stesso componente, lo stesso tetto di righe.
- **Le frasi.** La console usa le frasi dei siti; per un componente ne cambiano sei: cinque messaggi di errore e la fine `container_gone`.
- **Il segno della sessione non arriva da un valore del componente.** La shell porta `HP_TERMINAL_SESSION=term_…` nel suo ambiente. Lo script di pulizia legge `/proc/<pid>/environ` con `read`, che perde i separatori tra le voci, e cerca il segno come testo in qualsiasi punto, senza un limite a sinistra: vietare i nomi che cominciano con `HP_` (`APP_STACK_RESERVED_ENV_PREFIXES`) non basta. Per questo nessun valore di un componente contiene il testo `<segno>=` di un segno della piattaforma, in nessun punto (anche dentro una parola: `SHP_TERMINAL_SESSION=` contiene il segno). I segni sono un elenco chiuso, `APP_STACK_PROCESS_MARKS` in `packages/contracts/src/app-templates/text.ts`: `HP_TERMINAL_SESSION` e `HP_TASK_RUN`, il segno delle esecuzioni delle attività pianificate (PR #78), che così non ha bisogno di una seconda regola. La regola è `APP_STACK_PROCESS_MARK_PATTERN`, costruita dall'elenco, dentro `appStackTextProblem` (tipo `process_mark`). Ogni altro testo con `HP_` o `PHP_` è accettato (`Corso PHP_8`, `-d PHP_INI_SCAN_DIR=/x`, `HP_HOME=/x`, un file `.env` con `PHP_CLI_SERVER_WORKERS=4` come valore riservato): una prima regola che rifiutava ogni `HP_<NOME>=` rifiutava testi PHP comuni. La regola vale per il testo di un modello (`ENV_VALUE_PROCESS_MARK`), per il valore che il cliente dà a un parametro (`PARAM_VALUE_FORBIDDEN_CONTENT`), per il valore riempito (`RENDERED_VALUE_FORBIDDEN`) e di nuovo nel controllo del piano dell'esecutore, che non si fida dell'API. Vale anche per gli argomenti (`ARGV_ITEM_INVALID`), perché un programma può passarli nell'ambiente di ciò che avvia, e per un valore riservato: arriva al container come file, ma un'immagine può rimetterlo nell'ambiente (`X_FILE` → `X`), quindi l'API e l'esecutore lo rifiutano. Un segreto d'ambiente del formato esteso (`ADR-0036` §2.5) arriva al container come un valore solo, fatto di pezzi (il testo del modello e i valori riservati) che passano la regola uno per uno: l'esecutore controlla anche il valore unito e rifiuta (`STACK_PLAN_INVALID`) quello in cui i pezzi formano un segno solo insieme, per esempio `${a}${b}` con `a` = `xHP_TERMINAL_` e `b` = `SESSION=term_`. L'API risponde a quel rifiuto con un motivo generico, e nessuno potrebbe capire quale valore correggere: per questo l'esecutore scrive nel suo log una riga (`app_stack_env_mark_refused`) con l'applicazione e il componente, mai un valore. Un valore fatto di due valori riservati che insieme formano un segno è quindi rifiutato quando si crea il container del componente (installazione, reinstallazione, aggiornamento, ritorno indietro), e il log dell'esecutore nomina il componente. La procedura guidata, per un parametro e per un valore riservato, e il modulo dei valori riservati dicono perché prima di mandare il valore. Un processo del componente non porta quindi il segno per un valore che sceglie il cliente o che scrive un modello, e la pulizia non lo tocca, con tre limiti:
  - **Un segno formato a cavallo di due voci.** Letti senza separatori, un valore che finisce con `HP_TERMINAL_` seguito da una variabile chiamata `SESSION` il cui valore comincia con `term_`, oppure un valore che finisce con `H` o `HP` seguito da una variabile chiamata `P_TERMINAL_SESSION` o `_TERMINAL_SESSION`, formano il segno; lo stesso fa un nome che finisce con `HP_TERMINAL_SESSION`. Servono i nomi delle variabili del modello, che scrive l'amministratore del server. Un segno così sta nell'ambiente del container, quindi anche in quello del processo 1: lo script di pulizia legge per primo l'ambiente del processo 1 e, se porta il segno, non uccide niente ed esce con il codice 3 (`APP_STACK_TERMINAL_KILL_OWN_MARK_EXIT`, che nessun altro percorso dà: 0 è la pulizia fatta, 1 e 2 sono errori della shell, 126 e 127 il motore senza `/bin/sh`, da 128 in su un segnale). Chi lancia lo script, la chiusura di una sessione e la pulizia all'avvio, conta quel codice come «niente da pulire qui», e l'esecutore lo scrive una volta nel log (`terminal_own_mark`, con il numero dei componenti e nessun nome). In quel componente la pulizia all'avvio cerca il prefisso nudo del segno e quindi non toglie ciò che una sessione ha lasciato: lo toglie un riavvio dell'applicazione. La chiusura di una sessione cerca il segno con l'id della sessione, che il processo 1 non porta, e lavora come altrove. Resta un caso: un'immagine il cui programma iniziale toglie dal proprio ambiente una delle due voci; lì il processo 1 non porta il segno, i comandi aperti nel container sì, e la pulizia all'avvio li ucciderebbe, solo in quel componente e mai lo script stesso.
  - **Un programma che costruisce un ambiente da ciò che riceve.** La pulizia all'avvio cerca il prefisso nudo del segno (`HP_TERMINAL_SESSION=term_`): il figlio CGI di una richiesta con l'intestazione `HP-Terminal-Session: term_x` porta `HTTP_HP_TERMINAL_SESSION=term_x` e verrebbe ucciso, con la sua sessione di sistema, da quella pulizia. Nessuna immagine ammessa oggi esegue CGI; non c'è niente di costruito contro questo.
  - **Un valore salvato prima di questa regola.** Un piano o un valore riservato già salvato che contiene un segno è rifiutato dopo l'aggiornamento: la pagina dell'applicazione risponde con un errore e l'avvio è rifiutato. Le applicazioni sono state accese per la prima volta nella release 0.10.0, quindi non se ne aspetta nessuno; che cosa fa l'operatore se ce n'è uno è nel runbook (`docs/runbooks/application-stacks.md`, procedura 13, passo 10).
- **Una fine per `container_gone` non lancia lo script di pulizia.** I processi di una sessione finiscono con il loro container; nel container ripartito non c'è niente da cercare.
- **La richiesta di posizione del cursore.** La shell di Alpine manda `ESC[6n` dopo ogni prompt. La console toglie le sequenze di controllo prima di mostrare il testo e non risponde mai: non serve altro.

## 5. Che cosa è provato

- **Contratti** (`packages/contracts/test/app-terminal.test.ts`): la richiesta di apertura nomina l'applicazione, il suo cliente e il componente e nient'altro; un identificativo che potrebbe uscire dal nome ricavato del container è rifiutato; il DTO della sessione è stretto e nomina il componente, mai un sito. La regola del segno (§4): `packages/contracts/test/app-template-text.test.ts` (l'elenco chiuso dei segni; `HP_TERMINAL_SESSION=` e `HP_TASK_RUN=` rifiutati anche dentro un testo più lungo e dentro una parola; `Corso PHP_8`, `-d PHP_INI_SCAN_DIR=/x`, `PHP_CLI_SERVER_WORKERS=4`, `SHP_X=1`, `HP_HOME=/x`, un segno senza `=` e un valore che finisce con `HP_TERMINAL_` accettati, e restano test perché nessuno allarghi di nuovo la regola per sbaglio), il parametro del cliente (`app-template-parameters.test.ts`), il valore riservato, anche un `.env` su più righe (`app-api-dto.test.ts`), e il piano (`app-stack-plan.test.ts`); il valore unito di un segreto d'ambiente, con la riga di log che nomina l'applicazione e il componente e nessun valore (`apps/docker-executor/test/app-stack-v2.test.ts`); il compilatore, con il limite del segno a cavallo di due voci provato come accettato (`packages/policy-engine/test/app-template-compile.test.ts`), il validatore (`app-template-security.test.ts`), il controllo del piano dell'esecutore (`apps/docker-executor/test/app-stack-plan-check.test.ts`) e le frasi della procedura guidata e del modulo dei valori riservati, che nominano ogni segno dell'elenco (`apps/web/test/app-stacks-wizard.test.ts`, `apps/web/test/app-stacks-detail.test.ts`).
- **Database** (`packages/database/test/admin-terminal-repository.test.ts`, `packages/database/test/rollback-compat.test.ts`, `packages/database/test/phase2-database.test.ts`): la migrazione `0030` lascia com'era una sessione di un sito e si può eseguire due volte su una tabella con i due tipi di righe; una sessione in un componente scrive la riga con il componente e la riga di audit sull'applicazione; una sessione per componente, e siti e applicazioni contati insieme sul server; il vincolo rifiuta una sessione su entrambi i bersagli, su nessuno e su un'applicazione senza componente; la release precedente legge e scrive sul database migrato.
- **Contratti dell'esecutore** (`packages/executor-contracts/test/stack-port.test.ts`): un esecutore che apre un terminale in un componente si riconosce; un esecutore di applicazioni senza terminale resta un esecutore di applicazioni.
- **Esecutore** (`apps/docker-executor/test/app-stack-terminal.test.ts`, `apps/docker-executor/test/terminal-docker.test.ts`, `apps/docker-executor/test/m5c-exec-qa.test.ts`): la shell è `/bin/sh` con un terminale nel container controllato, senza utente e senza cartella; un componente mancante o fermo è rifiutato prima di ogni comando; la chiusura lancia lo script di pulizia con l'id della sessione e senza utente; lo script usa solo ciò che una shell ha dentro, non segnala mai il processo 1 né sé stesso e non raccoglie mai la sessione di sistema 0 o 1; dove il processo 1 porta il segno non uccide niente ed esce con il codice 3, che la chiusura e la pulizia all'avvio contano come fatto e scrivono una volta nel log, mentre per un sito resta un errore; la pulizia all'avvio elenca i container dei componenti e gira solo dove un comando è rimasto aperto; quattro sessioni sul server su qualsiasi bersaglio, una per componente; un riavvio di un componente lascia aperta la sessione di un altro; le richieste del terminale dei siti restano quelle fissate dai loro test.
- **API** (`apps/api/test/admin-app-terminal.integration.test.ts`): la pagina di un'applicazione di qualsiasi cliente; i log come li vede il cliente, mascherati, con una riga di audit per lettura; il rifiuto di chiunque non sia amministratore del server (proprietario, collaboratore, un altro cliente, nessuna sessione); un'apertura con un codice nuovo, un comando e una chiusura con una sola riga di fine; un codice mancante, malformato, errato o già usato rifiutato con il suo motivo sull'applicazione e senza chiamare l'esecutore; due aperture in gara con un solo codice danno una sola sessione; il blocco dopo cinque codici errati; i rifiuti che non consumano il codice; `503` senza consumare il codice quando l'esecutore non offre la chiamata; una sessione per componente e quattro sul server; la fine `not_started` quando l'esecutore rifiuta, senza ripeterne le parole; la fine `container_gone` quando il cliente ferma l'applicazione; niente di digitato o stampato nel database, in un errore o in una chiamata al registro; un'applicazione eliminata non ha più pagina, log o terminale; `422` dove le applicazioni sono spente.
- **Pagine** (`apps/web/test/admin-app-stack.test.ts`, `apps/web/test/admin-applications.test.ts`, `apps/web/test/m5c-web-qa.test.ts`, `apps/web/test/ux-admin-applications.qa.test.ts`): la pagina non mostra parametri, valori riservati, piani o id del motore; un'applicazione o un componente sconosciuti sono la pagina «non trovato»; le due route di passaggio accettano solo il loro metodo, rifiutano un id di forma sbagliata senza chiamare l'API e vogliono la sessione e, per il terminale, il token CSRF; un sito si apre ancora dalla sua route; la riga di un'applicazione nell'elenco ha un solo collegamento e nessun pulsante.
- **Docker vero** (`infra/linux/accept-app-terminal.mjs`, eseguito il 2026-11-23 su Docker Engine 29.10.0: 19 passi su 19). Lo script chiama l'adattatore di produzione dietro un cancello che rifiuta tutto ciò che non è suo, su due applicazioni di un cliente e una di un altro, dal modello integrato «Lavoro periodico con archivio», senza scaricare immagini e senza creare reti di ingresso. Ha mostrato che:
  - la shell, nei due componenti, ha le stesse righe `Uid`, `Gid`, `Groups`, `Cap*` e `NoNewPrivs` del processo 1 del componente, un terminale 24×80 e il file system di base in sola lettura; scrive nel volume del componente che ne ha uno, e nel componente senza volumi lo stesso percorso è in sola lettura;
  - dalla shell del lavoro si raggiunge l'archivio della stessa applicazione, e non quello di un'altra applicazione, né per indirizzo né per nome;
  - **Ctrl-C** ferma un comando e la sessione resta; **Chiudi** risponde `closed` e in quel momento non resta nessun processo segnato e nessuno dei programmi lanciati con `&`, `nohup` e `setsid`, il componente non è ripartito e il lavoro continua a scrivere; **Ctrl-D** finisce come `shell_exited` e il programma lasciato in fondo viene ucciso; senza letture la sessione finisce come `idle` al momento atteso (tempo accorciato a 4 secondi solo in quel passo);
  - una seconda sessione nello stesso componente è rifiutata, un id già usato è rifiutato, la quinta sessione (nell'applicazione di un altro cliente) è rifiutata prima di ogni richiesta a Docker, e due sessioni non vedono l'una il testo dell'altra;
  - il cliente sbagliato, un componente o un'applicazione sconosciuti sono rifiutati; sei container messi sotto il nome di un componente con le etichette sbagliate sono rifiutati uno per uno prima di ogni comando, e lo stesso container con le etichette giuste è accettato: decidono le etichette;
  - un esecutore ucciso con `SIGKILL` lascia vivi la sua shell e tre programmi; la pulizia all'avvio dell'esecutore successivo li uccide senza far ripartire nessun componente, e una seconda passata non fa danni. Nessun altro script di verifica chiama questa pulizia: era la prima volta che girava su Docker vero;
  - il riavvio di un componente e l'arresto dell'applicazione finiscono la sessione come `container_gone`, e un componente fermo non riceve né una sessione né un comando;
  - niente di ciò che è stato digitato o stampato compare in una risposta, in un record di sessione, nei log dei componenti, in una richiesta, nell'uscita di un processo o in un file, e nessuna risposta contiene un id di Docker;
  - il cancello ha visto solo le due forme di comando del prodotto (la shell e lo script di pulizia, senza utente e senza cartella), non ha rifiutato niente, e alla fine non restava nessun oggetto della prova.

Non provato:

- Le tre pagine viste da una persona in un browser vero.
- Il limite dei 30 minuti su Docker vero: è provato solo nei test dell'esecutore, con un orologio finto.
- Un'immagine senza `/bin/sh`. Tutte le immagini dell'elenco ammesso di questo ramo sono basate su Alpine e ne hanno una: il comportamento scritto in T4 è quello atteso da Docker, non uno osservato. Che la pulizia rifiutata dal motore conti come fatta, e che un 126 o un 127 senza il suo messaggio resti un fallimento, è provato solo contro il motore finto (`apps/docker-executor/test/app-stack-terminal.test.ts`).
- Un processo che lascia la sessione di proposito e toglie il segno dal proprio ambiente (`env -i setsid …`): è il limite dichiarato al §3, non una prova.
- Un ritorno alla release precedente con una shell rimasta in un componente (T11).

Punti aperti:

- **Una finestra di un secondo.** Quando una shell finisce da sola, l'esecutore aspetta un secondo prima di lanciare la pulizia, per capire se è finita la shell o il container. Se l'esecutore muore proprio in quel secondo, Docker non elenca più il comando della shell, e la pulizia all'avvio salta quel container: un programma lasciato in fondo da quella sessione resta finché l'applicazione non viene riavviata. Resta dentro i limiti del componente e nessuno vi è collegato.
- Un amministratore non può fermare o riavviare l'applicazione di un cliente dalla sua pagina: lo fa il cliente, o un amministratore di hosting dell'organizzazione.
- Le scelte T1–T12 e quelle elencate al §4 aspettano l'approvazione del proprietario.
