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
- **Un container di applicazione** (`ADR-0035`) parte senza nessuna capability, con `no-new-privileges`, con il file system di base in sola lettura, con i suoi limiti di memoria e di processi, come l'utente fissato dal piano o, se il piano non lo fissa, come quello della sua immagine. I suoi segreti sono file in sola lettura in `/run/secrets`.

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

Un'immagine senza `/bin/sh` non ha un terminale: la sessione si apre e finisce subito (`shell_exited`), con la riga di errore di Docker come unico testo. Non c'è un motivo di rifiuto nuovo per questo.

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

Ogni fine, tranne quelle in cui il container o l'esecutore non ci sono più, lancia nel container uno **script di pulizia** che uccide i processi segnati dalla sessione e tutti i processi delle loro sessioni di sistema, compresi quelli lanciati in fondo con `&`, `nohup` o `setsid`. È uno script **diverso da quello dei siti**, perché l'immagine di un'applicazione può non avere `ps`, `pkill` o `grep`: usa solo comandi interni della shell (`read`, `case`, `kill`) e i file di `/proc`. Gira come l'utente del componente, non tocca mai il processo 1 e non tocca i processi del componente, che non portano il segno.

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
- **Il terminale** (`/admin/apps/{stackId}/terminal/{componentKey}`): la console dei siti, con le sue regole di pagina (chiude la sessione quando la pagina viene lasciata, la considera persa dopo 40 secondi senza risposta).

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

- **L'amministratore può leggere i segreti dell'applicazione dal terminale**: i file in `/run/secrets` sono leggibili dall'utente del componente, come `wp-config.php` lo è nel terminale di un sito. I log restano mascherati; il terminale no.
- **L'amministratore può cambiare i dati dell'applicazione** nei suoi volumi. Il pannello non ne sa niente: la riga di audit dice che una sessione c'è stata, non che cosa ha fatto.
- **Gli strumenti sono quelli dell'immagine.** Molte immagini di applicazioni hanno pochi comandi; i programmi a schermo intero non funzionano, come per i siti.
- **Un processo che lascia la sessione e toglie il segno dal proprio ambiente sopravvive alla chiusura** finché l'applicazione non viene riavviata: è lo stesso limite dei siti (`ADR-0027` §4, limite 2).
- **I limiti contano insieme.** Quattro terminali aperti sui siti non ne lasciano nessuno per le applicazioni, e viceversa.
- L'elenco delle applicazioni dell'amministratore non è più solo un elenco in sola lettura: ogni riga porta a una pagina con due strumenti (`ADR-0035` §2.16 aggiornato).

## 4. Come è stato costruito

Da scrivere a lavoro finito.

## 5. Che cosa è provato

Da scrivere a lavoro finito.
