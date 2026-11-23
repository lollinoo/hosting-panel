# ADR 0040 — Notifiche: Email, Webhook e Telegram

- **Stato:** `PROPOSTO` — scelte N1–N12 prese dall'agente su direttiva del proprietario del 2026-11-22 («vorrei funzionasse come funziona Coolify»); in attesa di approvazione
- **Data:** 2026-11-23
- **Riferimento:** `ADR-0026` (salute e avvisi: gli avvisi che questo ADR racconta), `ADR-0018` e `ADR-0025` (relay di posta e mail del pannello: la mail delle notifiche passa di lì), `ADR-0015` (segreti cifrati a riposo); issue #71
- **Migrazioni:** `0029` (additiva; file `packages/database/migrations/0029_notifications.sql`)

Questo ADR fa dire al pannello quando qualcosa richiede attenzione: all'amministratore del server e a ogni cliente, per email, con un webhook o su Telegram. Non cambia che cosa è un avviso né quando nasce: racconta quelli che la pagina **Stato** calcola già.

## 1. Contesto

Il pannello oggi non dice niente a nessuno. Un disco pieno, un backup fallito nella notte, un sito fermo o un certificato che sta per scadere si vedono solo nella pagina **Stato** dell'amministratore, e solo mentre qualcuno la guarda. Un cliente non viene mai a sapere che il suo sito si è fermato.

La tabella delle funzioni concordata con il proprietario dice, alla riga «notifiche»: prenderle, email, webhook e Telegram. Il pannello ragiona per **cliente**, non per gruppo di lavoro: l'amministratore ha le sue notifiche per tutto il server, ogni cliente le sue, che parlano solo dei suoi siti.

Che cosa c'è già:

- **Gli avvisi.** `AdminHealthService.alerts()` calcola 17 tipi di avviso (`ALERT_KINDS`) dallo stato salvato, ogni volta che la pagina viene letta. Non sono salvati da nessuna parte: nulla sa quando uno si apre o si chiude. Ogni avviso ha un tipo e un soggetto (il sito, il componente, il nome host…), che insieme lo identificano.
- **La posta.** L'unica mail che il pannello scrive da sé è il link per reimpostare la password: l'API la chiede all'esecutore, che la compone da testi fissi e la consegna al relay (`PANEL_MAIL_KINDS = ["password_reset"]`).
- **Le richieste verso l'esterno.** L'API non ne fa nessuna in HTTP: interroga solo il DNS, con resolver pubblici (`HP_DNS_RESOLVERS`). Non esiste quindi una regola su quali indirizzi può chiamare.
- **I segreti delle impostazioni** (la password del relay, la chiave S3) sono cifrati a riposo con la chiave principale (`secrets-crypto.ts`).

I vincoli sono quelli di `HARNESS.md`: solo `hp-docker-executor` parla con Docker; nessun segreto in DTO, righe di audit, righe dell'outbox, operazioni o log; nessuna dipendenza npm, programma dell'host o variabile d'ambiente nuova; nulla è copiato da altri pannelli.

## 2. Decisioni

### N1 — Che cosa viene detto

Gli avvisi della pagina **Stato**, quando si aprono e quando si chiudono. Nient'altro: nessun messaggio per le cose andate bene (un backup riuscito, un'installazione finita) e nessun evento delle applicazioni, perché nessun avviso parla ancora di un'applicazione. Un tipo di avviso nuovo, in futuro, entra nelle notifiche aggiungendo la sua riga alla tabella dei gruppi e le sue frasi: il compilatore lo pretende.

### N2 — A chi

Due ambiti, ognuno con impostazioni sue:

- **Server**, dell'amministratore: tutti i 17 tipi.
- **Cliente**: sette tipi, e solo per i siti di quel cliente — il sito non è in funzione, un backup è fallito o è incompleto, un ripristino ha lasciato il sito non ripristinato, un certificato sta per scadere o non è stato emesso, un certificato caricato a mano sta per scadere. Gli altri dieci (disco, componenti del pannello, destinazioni dei backup, operazioni bloccate…) sono lavoro dell'amministratore e il cliente non li riceve.

Gli avvisi sono divisi in quattro **gruppi**, e ogni canale sceglie quali vuole: *disponibilità*, *backup*, *certificati*, *server*. L'ultimo esiste solo nell'ambito server.

### N3 — Canali

Tre canali, al più uno per tipo in ogni ambito, ognuno acceso o spento:

- **Email**, attraverso il relay di posta del pannello. Nell'ambito server va a un elenco di indirizzi scritto dall'amministratore (da uno a cinque). Nell'ambito cliente va ai **proprietari** del cliente, all'indirizzo con cui accedono: il cliente non scrive indirizzi, così il pannello non può essere usato per mandare posta a terzi.
- **Webhook**: una richiesta `POST` HTTPS con un corpo JSON (gli eventi, e lo stesso testo degli altri canali). Se è impostata una chiave di firma, la richiesta porta `X-Hosting-Panel-Signature: t=<secondi>,v1=<HMAC-SHA256 esadecimale di "<secondi>.<corpo>">`.
- **Telegram**: un messaggio di testo semplice da un bot creato dall'amministratore o dal cliente, verso una chat scelta da loro (`sendMessage`, senza anteprima dei link).

Finché nessuno accende un canale non parte nulla.

### N4 — Quando

Un passaggio dell'API ogni due minuti. Se nessun canale è acceso legge una riga e si ferma lì. Altrimenti legge gli avvisi aperti e, per ogni canale acceso, li confronta con ciò che quel canale sa già:

- un avviso si dice **aperto** al secondo passaggio consecutivo che lo vede: ciò che si apre e si richiude tra un passaggio e l'altro non produce nulla;
- un avviso si dice **non più aperto** al primo passaggio che non lo vede più, e solo se la sua apertura era stata detta;
- un avviso che da «attenzione» diventa «critico» viene detto di nuovo;
- tutto ciò che un canale deve sapere in un passaggio parte come **un solo messaggio**, con al più cinquanta eventi: se sono di più, il messaggio dice quanti ne mancano e rimanda al pannello;
- un canale acceso mentre ci sono avvisi aperti li riceve, come se si aprissero allora; spegnere un gruppo o un canale non manda nulla.

**Quando chi osserva non risponde, non si chiude nulla che dipende da lui.** Se l'esecutore o Docker non rispondono, lo stato dei container diventa «sconosciuto» e i loro avvisi spariscono dalla pagina **Stato** senza che il guasto sia finito. In quel caso il passaggio non dice «non più aperto» per un sito o un componente: lo dirà quando l'osservazione torna e l'avviso non c'è più.

### N5 — Testi

I testi sono fissi, in italiano e in inglese, scritti dal pannello: nessuno scrive il testo di una notifica. Sono funzioni pure di un **evento**, un record chiuso (tipo, aperto o non più aperto, gravità e pochi fatti limitati: il nome del sito, il nome host, il nome di un certificato, una data, una percentuale). Le stesse funzioni, nel pacchetto dei contratti, servono all'esecutore per la mail e all'API per Telegram e per il webhook.

- Una frase per tipo e per pubblico: l'amministratore legge le parole della pagina **Stato**, il cliente frasi senza vocabolario del server.
- Un messaggio ha due elenchi, **nuovi avvisi** e **non più aperti**. La chiusura ripete la frase dell'avviso e non dice perché si è chiuso: il pannello non lo sa (un sito «non in funzione» si chiude anche quando il cliente lo ferma).
- I nomi che vengono da un utente sono tagliati a una lunghezza fissa e ripuliti dai caratteri di controllo prima di entrare in un evento, e lo schema dell'evento li rifiuta comunque. L'oggetto di una mail non contiene mai testo di un utente.
- La lingua è quella di chi riceve quando è un utente del pannello (la mail ai proprietari), altrimenti quella di chi ha salvato il canale.

### N6 — Chi spedisce

- **La mail** segue la strada che esiste: l'API la chiede all'esecutore, che la compone e la consegna al relay. La richiesta di mail acquista un secondo tipo, `notification`, che porta **eventi**, mai testo libero.
- **Webhook e Telegram** li spedisce l'API, da un solo modulo (`apps/api/src/notifications/outbound-http.ts`). L'esecutore tiene il socket di Docker e l'agente dell'host gira come root: nessuno dei due deve mai chiamare un indirizzo scelto da un cliente.

### N7 — Quali indirizzi si possono chiamare

L'API finora non chiamava nessuno. La regola nasce qui e vale per ogni richiesta del modulo, anche verso Telegram:

- solo `https://`, verso un **nome** DNS: niente indirizzi IP scritti a mano, niente nome utente o password nell'indirizzo;
- il nome è risolto con i resolver pubblici del pannello (gli stessi dei controlli DNS dei domini), non con quello del server: i nomi interni non esistono;
- **ogni** indirizzo ottenuto dev'essere pubblico. Sono rifiutati gli intervalli privati, di loopback, link-local (compreso l'indirizzo dei metadati cloud), condivisi dei provider, di documentazione, multicast e riservati, in IPv4 e in IPv6, e gli indirizzi IPv4 scritti dentro un IPv6;
- sono rifiutati anche **gli indirizzi di questo server** (quelli delle sue interfacce di rete): una richiesta che parte dal server verso il suo stesso indirizzo pubblico non passa dal firewall, e raggiungerebbe servizi che da fuori non si vedono;
- la connessione va **all'indirizzo che è stato controllato**, con il nome originale per il certificato: una seconda risoluzione non può portare altrove;
- un reindirizzamento non viene seguito ed è un fallimento; il tempo massimo è cinque secondi; il corpo della risposta non viene letto: conta solo la classe dello stato HTTP.

Il controllo si fa quando l'indirizzo viene salvato (e il salvataggio è rifiutato) e di nuovo a ogni invio.

### N8 — Coda, tentativi, esito

Ogni messaggio è una riga con i suoi eventi; per la mail, una riga per destinatario, così ognuno ha il suo esito e la sua lingua. Il primo tentativo è nel passaggio che lo crea; i successivi dopo 2, 10 e 30 minuti; dopo un'ora dalla nascita il messaggio è **non consegnato** e non si riprova più: una notizia vecchia di un'ora non serve. Un passaggio spedisce al più venti messaggi. L'esito di ogni messaggio (consegnato, non consegnato e perché: indirizzo non ammesso, irraggiungibile, rifiutato con il suo stato HTTP, posta non configurata) resta trenta giorni e si vede nella pagina.

La consegna è «almeno una volta»: se l'API si ferma tra l'invio e la scrittura dell'esito, il messaggio parte di nuovo al riavvio. Ogni messaggio ha un identificativo, nel corpo del webhook, per riconoscere il doppione.

### N9 — Dati e segreti

Tre tabelle nuove: i **canali** (uno per tipo e per ambito), ciò che ogni canale **sa già** (un avviso aperto per riga, con l'evento così com'era all'apertura, perché alla chiusura l'avviso non c'è più) e i **messaggi** con il loro esito.

L'indirizzo del webhook (che spesso contiene una chiave nel percorso), la chiave di firma e il token del bot sono cifrati a riposo come gli altri segreti delle impostazioni, e non compaiono mai in un DTO, in una riga di audit, in una riga dell'outbox, in un'operazione o in un log. La pagina mostra del webhook solo il nome host, e di Telegram solo la chat. Un errore di invio è registrato con un codice, mai con l'indirizzo o con la risposta dell'altra parte.

### N10 — Permessi e API

Due chiavi nuove, `notification.read` e `notification.manage`, del ruolo **proprietario** del cliente. Un collaboratore non le ha, e non entrano nella visita di supporto: dove vanno le notifiche di un cliente lo decide il cliente. Le impostazioni del server sono solo degli amministratori del server.

- `GET /v1/admin/notifications`, `PUT` e `DELETE /v1/admin/notifications/channels/:channel`, `POST /v1/admin/notifications/channels/:channel/test`
- le stesse quattro sotto `/v1/organizations/:orgId/notifications`

Il messaggio di prova parte subito, sul canale così com'è salvato, e la risposta dice se è arrivato; non più di uno ogni trenta secondi per canale. Ogni salvataggio, cancellazione e prova scrive una riga di audit senza segreti.

### N11 — Interfaccia

Una pagina **Notifiche** per l'amministratore (nel menu laterale) e una per il cliente (nel menu dell'account), in italiano e in inglese: una scheda per canale con l'interruttore, i gruppi, i suoi campi, il pulsante **Invia un messaggio di prova**, e sotto gli ultimi messaggi con il loro esito. La pagina del cliente non usa vocabolario del server. Un campo segreto già salvato appare vuoto con la dicitura «già impostato»: lasciarlo vuoto lo conserva.

### N12 — Downgrade e fuori ambito

Una versione senza questa funzione non sa spedire: `hp-update` rifiuta di tornarci finché esiste un canale (funzione `notifications`, codice di uscita 8, a meno di `--allow-feature-loss`). Le tabelle e le due chiavi di permesso in più non disturbano una versione precedente.

Fuori ambito, ognuno un'issue futura: messaggi per ciò che è andato bene; eventi delle applicazioni; i formati che i prodotti di chat si aspettano sui loro webhook; più di un canale per tipo; indirizzi email scritti dal cliente; una lingua scelta per ogni destinatario.

### Alternative scartate

- **Far spedire tutto all'esecutore**, che già spedisce la posta. Darebbe al processo con il socket di Docker il compito di chiamare indirizzi scelti dai clienti.
- **Far emettere un evento a ogni servizio** quando qualcosa va storto, al posto del confronto periodico. Vorrebbe dire toccare ogni servizio che oggi alimenta la pagina **Stato** e tenere due verità (la pagina e gli eventi). Il confronto usa l'unica che c'è, al prezzo di un ritardo di qualche minuto.
- **Una libreria** per la posta, per Telegram o per le richieste HTTP. Servono una `POST` e un controllo sugli indirizzi: stanno in un modulo, senza dipendenze nuove.
- **Indirizzi email scritti dal cliente.** Il pannello diventerebbe un modo di mandare posta a chiunque dal dominio del server.

## 3. Conseguenze

- L'API fa per la prima volta richieste HTTPS verso l'esterno. Su un server da cui non si esce in HTTPS, webhook e Telegram falliscono e la pagina lo dice; la mail non ne risente.
- Un avviso arriva da due a quattro minuti dopo che la pagina **Stato** lo mostrerebbe, e gli avvisi hanno già le loro attese (un sito fermo è un avviso dopo cinque minuti).
- La notizia di un guasto del pannello stesso parte solo se l'API è in piedi: se l'API è ferma nessuno avvisa. Chi vuole sapere che il server è spento deve guardarlo da fuori.
- Il passaggio rifà ogni due minuti le letture della pagina **Stato**; con nessun canale acceso costa una riga.
