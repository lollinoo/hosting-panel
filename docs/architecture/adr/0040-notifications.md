# ADR 0040 — Notifiche: Email, Webhook e Telegram

- **Stato:** `PROPOSTO` — scelte N1–N12 prese dall'agente su direttiva del proprietario del 2026-11-22 («vorrei funzionasse come funziona Coolify»); in attesa di approvazione
- **Data:** 2026-11-23
- **Riferimento:** `ADR-0026` (salute e avvisi: gli avvisi che questo ADR racconta), `ADR-0018` e `ADR-0025` (relay di posta e mail del pannello: la mail delle notifiche passa di lì), `ADR-0015` (segreti cifrati a riposo); issue #71, PR #72
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

Il confronto rilegge il canale, e lo tiene, nella stessa transazione in cui scrive ciò che gli è detto: un salvataggio o una rimozione del canale aspetta che finisca, oppure arriva prima ed è ciò che il confronto vede. Un gruppo spento, un canale spento o rimosso mentre il passaggio guarda gli avvisi non riceve quindi nulla da quel passaggio. Un canale che non si riesce a confrontare resta com'era e viene riprovato al passaggio dopo; gli altri canali e gli invii del passaggio vanno avanti. Subito prima di ogni invio, fuori da ogni transazione, il messaggio e il suo canale sono riletti: un messaggio che non è più in attesa, o il cui canale è stato rimosso, non parte; uno di un canale spento, o i cui eventi sono tutti di gruppi ormai spenti, non parte ed è registrato come non consegnato per canale cambiato.

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
- sono rifiutati anche **gli indirizzi di questo server**: quelli delle sue interfacce di rete e quelli pubblici che il pannello registra per i suoi server (l'IPv4 e l'IPv6 di ogni riga di `hosts`: l'installatore registra l'IPv4 che gli si dà con `--ipv4` o che rileva, anche per un server dietro una traduzione degli indirizzi, dove nessuna interfaccia la porta; un IPv6 scritto nella riga conta anch'esso, ma oggi l'installatore non ne scrive nessuno, issue #184). Una richiesta che parte dal server verso il suo stesso indirizzo pubblico non passa dal firewall, e raggiungerebbe servizi che da fuori non si vedono. Gli indirizzi registrati si leggono a ogni controllo, come le interfacce; se non si riesce a leggerli in tempo, o uno di essi non è vuoto e non è un indirizzo (l'installatore accetta `203.0.113.05`, con uno zero iniziale), non parte nulla e il tentativo è «irraggiungibile»;
- la connessione va **all'indirizzo che è stato controllato**, con il nome originale per il certificato: una seconda risoluzione non può portare altrove;
- un reindirizzamento non viene seguito ed è un fallimento; il tempo massimo è cinque secondi in tutto, risoluzione del nome compresa, anche quando un resolver non risponde; il corpo della risposta non viene letto: conta solo la classe dello stato HTTP.

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

Un pannello ripristinato su un altro server (`hp-restore-panel`) dimentica ciò che ogni canale sapeva e chiude come non consegnati i messaggi che erano in attesa (`expired`): gli avvisi della copia riguardano il server di prima. I canali, i loro segreti e gli esiti già scritti restano. Sul server nuovo gli avvisi aperti sono detti come nuovi, e di quelli del server di prima non è detta la chiusura.

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

## 4. Come è stato costruito

- **Contratti.** `packages/contracts/src/notifications.ts` (N1–N3, N8, N10): i tre canali, i due ambiti, i quattro gruppi con la tabella che dà un gruppo a ognuno dei 17 tipi di avviso, i sette tipi che un cliente riceve, l'evento chiuso e la funzione che lo ricava da un avviso, gli schemi di salvataggio di ogni canale, i DTO delle impostazioni e dei messaggi, il corpo che riceve un webhook, i codici del perché un invio non è riuscito e i tempi (passaggio, tentativi, rinuncia, conservazione). `packages/contracts/src/notification-texts.ts` (N5): le frasi per tipo, pubblico e lingua, e `renderNotification`, che da un messaggio ricava oggetto e testo. `packages/contracts/src/ipc-schemas.ts` (N6): la richiesta di mail diventa un'unione di due tipi, `password_reset` e `notification`; il secondo porta eventi e, se c'è, il link al pannello, mai testo. `packages/contracts/src/permissions.ts` (N10): `notification.read` e `notification.manage`, del solo proprietario; le chiavi passano da 44 a 46 e le 15 della visita di supporto restano quelle.
- **Database.** `packages/database/migrations/0029_notifications.sql` (N9): `notification_channels` (un canale per tipo e per ambito, con due indici unici parziali; `organization_id` vuoto è l'ambito server; indirizzo, chiave e token stanno in una busta cifrata che la riga pretende per webhook e Telegram e vieta per la mail), `notification_channel_alerts` (ciò che un canale sa: una riga per avviso aperto, con `announced_at` vuoto finché l'apertura non è stata detta) e `notification_deliveries` (i messaggi: in attesa, consegnato, non consegnato, con vincoli che rifiutano un esito contraddittorio). `packages/database/src/notifications-repository.ts`: letture e scritture delle tre tabelle; la busta è legata all'ambito e al tipo del canale, e non si apre altrove. `packages/database/src/schema.ts` descrive le tabelle.
- **Esecutore.** `apps/docker-executor/src/panel-mail.ts` (N5, N6): `composePanelMail` scrive oggetto e testo di una notifica dagli eventi, con le stesse funzioni che usa l'API. `apps/docker-executor/src/smtp-submit.ts`: `encodeMailSubject` scrive un oggetto con lettere accentate come più parole codificate su righe corte, perché l'oggetto di una notifica può superare una riga. `apps/docker-executor/src/simulator-adapter.ts` tiene le mail di notifica in un elenco suo. `packages/executor-contracts/src/mail-relay.ts` esporta i due tipi di richiesta.
- **API.** `apps/api/src/notifications/outbound-http.ts` (N7): il solo modulo che fa una richiesta HTTP verso l'esterno; `isPublicAddress` decide se un indirizzo è pubblico, `createOutboundHttp` controlla il nome, si collega all'indirizzo controllato e della risposta guarda solo lo stato. `apps/api/src/notifications/notification-dispatch.service.ts` (N4, N8): il passaggio. `apps/api/src/notifications/notification-sender.service.ts` (N3, N6): un messaggio verso un canale; la mail attraverso `apps/api/src/mail/mail-relay.service.ts`, il webhook con la sua firma, Telegram verso `https://api.telegram.org`. `apps/api/src/notifications/notification-settings.service.ts` (N10): lettura, salvataggio, rimozione e prova. `apps/api/src/controllers/admin-notifications.controller.ts` e `apps/api/src/controllers/notifications.controller.ts`: le otto route. `apps/api/src/health/admin-health.service.ts` (N4): `observe` dà gli avvisi aperti insieme a ciò che lo sguardo non ha potuto vedere. `apps/api/src/create-app.ts`, `apps/api/src/app.module.ts` e `apps/api/src/tokens.ts` avviano il passaggio e collegano i servizi. `docs/api/openapi.yaml` descrive le route.
- **Pagina.** `apps/web/src/components/shared/notification-settings.tsx` (N11): un solo componente per i due ambiti. `apps/web/src/lib/notification-form.ts`: che cosa manda il modulo e che cosa controlla prima di chiamare, senza interfaccia. `apps/web/src/app/admin/notifications/page.tsx` e `apps/web/src/app/account/notifications/page.tsx`: le due pagine. Le route di passaggio stanno sotto `apps/web/src/app/api/admin/notifications/` e `apps/web/src/app/api/bff/orgs/[orgId]/notifications/`; `apps/web/src/lib/bff-proxy.ts` impara il metodo `PUT`. Le voci di menu sono in `apps/web/src/components/layout/sidebar-nav.tsx` e `apps/web/src/components/customer/top-bar.tsx`; i testi in `apps/web/src/i18n/it.ts` e `apps/web/src/i18n/en.ts`.
- **Installazione.** `infra/release/build-release.mjs`: la funzione `notifications` nell'elenco di ciò che una release conosce. `infra/linux/lib/common.sh` e `infra/linux/update.sh` (N12): il cancello del downgrade. `infra/linux/hp-restore-panel.sql` (N12): che cosa dimentica un pannello ripristinato. Procedure dell'operatore: `docs/runbooks/notifications.md`.

Scostamenti dalla proposta scritta prima del codice:

- **Ciò che lo sguardo non vede ha un nome preciso.** `observe` elenca le chiavi intere degli avvisi che non può dire chiusi (`site_container_down:<sito>`, `component_down:<componente>`) e il solo tipo `disk_high` quando i dischi non sono stati letti. È «non visto» anche un sito in installazione o in manutenzione, e uno il cui container nessuno ha guardato di recente.
- **«Non si trova» e «non ammesso» sono due cose.** Un resolver che non risponde o un nome senza indirizzi è `unreachable`; `address_not_allowed` resta a un indirizzo scritto in una forma rifiutata, o che porta a un indirizzo non pubblico o di questo server. Il salvataggio rifiuta l'uno e l'altro, con due frasi diverse.
- **Qualsiasi porta, un solo indirizzo.** L'indirizzo di un webhook può indicare una porta diversa dalla 443. Di un nome con più indirizzi tutti devono essere pubblici, e se ne prova uno solo, IPv4 per primo.
- **Ogni invio fallito si riprova allo stesso modo**, anche un rifiuto di chi riceve e la posta non impostata: entro l'ora qualcuno può correggere.
- **Il primo passaggio è due minuti dopo l'avvio dell'API**, non all'avvio.
- **La mail di un cliente va al più a venti proprietari.**
- **Il link in fondo a un messaggio** porta alla pagina **Stato** per il server e all'elenco dei siti per il cliente, sul nome host salvato del pannello, mai su quello di una richiesta. Senza un nome salvato il messaggio non ha link.
- **Il messaggio di prova** va a ogni destinatario di un canale email (una riga per ognuno; la risposta riporta il primo che non è partito), parte anche su un canale spento e, quando un cliente non ha nessun proprietario a cui scrivere, risponde `NOT_SUPPORTED`.
- **La lingua di un canale** è quella dell'utente che lo ha salvato per ultimo.
- **Spegnere, togliere, rimuovere.** Spegnere un canale cancella ciò che sapeva e chiude i messaggi in attesa come non consegnati (`channel_changed`); togliere un indirizzo dall'elenco chiude i messaggi in attesa per quell'indirizzo; rimuovere un canale cancella anche i suoi messaggi.
- **Audit.** Tipo di oggetto `notification_channel`; azioni `notification.channel.update`, `notification.channel.delete` e `notification.channel.test`; nei dettagli il canale, se è acceso, i gruppi e l'esito della prova.
- **Un canale che non esiste** nell'indirizzo di una route è `NOT_FOUND`, dopo il controllo dei permessi.
- **La pagina mostra gli ultimi venti messaggi** dei trenta giorni.
- **L'identificativo di un evento** sono i primi 24 caratteri esadecimali dello SHA-256 della chiave dell'avviso: lo stesso all'apertura e alla chiusura.
- **Nella pagina.** Una scheda mai salvata nasce accesa con tutti i gruppi dell'ambito; **Togli la chiave di firma** vince su una chiave scritta nello stesso modulo; il pulsante di prova c'è solo per un canale salvato; un salvataggio attende fino a 20 secondi (il nome va cercato) e una prova fino a 45; un amministratore del server che apre la pagina del cliente, anche in visita di supporto, viene portato alla sua; un membro senza il permesso legge «Solo un proprietario dell'account può impostare le notifiche.».
- **Il cancello del downgrade conta ogni canale**, acceso o spento, del server o di un cliente.
- **Il ripristino del pannello** non era nella proposta: è il secondo capoverso di N12.

## 5. Che cosa è provato

- **Contratti e modelli** (`packages/contracts/test/notifications.test.ts`, `packages/contracts/test/contracts.test.ts`): ogni tipo di avviso ha un gruppo; un cliente riceve solo avvisi su un sito, e solo nei suoi tre gruppi; le due chiavi sono del solo proprietario, e leggere non è cambiare; da un avviso di ogni tipo nasce un evento che tiene solo fatti limitati, ripulisce i nomi scritti da un utente e non lascia passare un carattere di controllo; c'è una frase per ogni tipo, pubblico e lingua; l'oggetto di un messaggio è fatto solo di conteggi; il testo resta sotto la lunghezza di un messaggio di chat e conta ciò che lascia fuori; la mail del server vuole da uno a cinque indirizzi diversi e quella di un cliente nessuno; le impostazioni mostrate non hanno indirizzo, chiave né token; una reimpostazione della password non porta eventi e una notifica non porta testo libero.
- **Database** (`packages/database/test/notifications-database.test.ts`, `packages/database/test/rollback-compat.test.ts`, `packages/database/test/phase2-database.test.ts`): un webhook e un bot non nascono senza la loro busta e la mail non ne ha; né il record né la riga tengono l'indirizzo o la chiave in chiaro; la busta si apre solo con la sua chiave, nel suo ambito e per il suo tipo; un salvataggio senza segreti conserva quelli che c'erano; un canale per tipo e per ambito; una prova per intervallo; un messaggio fallito torna dovuto più tardi e uno consegnato mai più; la riga rifiuta un esito contraddittorio; rimuovere un canale o un cliente porta via le sue righe; i proprietari sono solo gli utenti che possono accedere, senza collaboratori, inviti o sospesi. La migrazione `0029` aggiunge tre tabelle e non cambia nessuna colonna, indice o trigger di una tabella che c'era: le scritture della release precedente girano anche con canali presenti, e rieseguirla non fa danni.
- **Esecutore** (`apps/docker-executor/test/panel-mail.test.ts`, `apps/docker-executor/test/smtp-submit.test.ts`, `apps/docker-executor/test/docker-executor.test.ts`): la mail di una notifica è scritta dall'esecutore dagli eventi, nella lingua chiesta, ed è lo stesso testo che ricevono un webhook e una chat; una richiesta che porta un oggetto o un testo suo è rifiutata; un fallimento è registrato solo per tipo e codice; un oggetto con lettere accentate esce in parole codificate su righe corte, senza spezzare un carattere.
- **Route e passaggi** (`apps/api/test/notifications.integration.test.ts`, `apps/api/test/notification-outbound-http.unit.test.ts`, `apps/api/test/admin-health.integration.test.ts`, `apps/api/test/admin-route-guard.integration.test.ts`, `apps/api/test/support-access-tenancy.integration.test.ts`): senza canali accesi il passaggio legge i canali e si ferma; un avviso è detto al secondo passaggio che lo vede, una volta, e la sua fine al primo che non lo vede più; ciò che si apre e si chiude tra due passaggi non produce nulla; un gruppo spento, un canale spento o rimosso mentre il passaggio guarda gli avvisi non riceve nulla da quel passaggio, e un canale riacceso sente gli avvisi aperti come nuovi; un canale che non si riesce a confrontare non toglie il passaggio agli altri canali né gli invii; un canale spento mentre parte un messaggio precedente dello stesso passaggio non riceve nulla, e un nuovo tentativo per un gruppo spento nel frattempo non parte; più avvisi insieme sono un solo messaggio, che conta quelli oltre i cinquanta; ciò che lo sguardo non ha visto non viene né chiuso né dimenticato; da «attenzione» a «critico» è detto di nuovo, il contrario no; il canale di un cliente sente solo i siti di quel cliente e solo i sette tipi; i tentativi a due, dieci e trenta minuti e poi «non consegnato»; non più di venti invii per passaggio; una mail per indirizzo, ognuna nella sua lingua; con lo sguardo vero, un disco pieno arriva al canale del server e un sito fermo anche a quello del suo cliente. Le impostazioni rispondono `401` senza sessione, `403` a un cliente su quelle del server e `404` su quelle di un altro cliente, prima di leggere il corpo; nessuna risposta ridà l'indirizzo, la chiave o il token; la firma di un webhook si può ricalcolare da chi riceve; Telegram riceve testo semplice all'indirizzo del bot, senza anteprima; la prova parte subito, dice com'è andata e non più di una ogni trenta secondi; un webhook che porta all'indirizzo che il pannello registra per il server è rifiutato al salvataggio come uno privato, e la prova e il passaggio non gli mandano nulla. Il modulo delle richieste accetta solo `https://` verso un nome i cui indirizzi sono tutti pubblici e non di questo server (né delle sue interfacce né registrati dal pannello per il server, in qualunque forma siano scritti; se quelli registrati non si leggono, o uno di essi non è un indirizzo, non chiama nulla), rifiuta ogni intervallo non pubblico in IPv4 e in IPv6 (anche un IPv4 scritto dentro un IPv6), si collega all'indirizzo controllato con il nome per il certificato, non segue un reindirizzamento, non aspetta una risposta lunga, rifiuta un certificato non valido per il nome e si arrende dopo il suo tempo, che comprende la risoluzione del nome: un resolver lento lascia alla richiesta solo ciò che resta, uno che risponde dopo la scadenza non porta a nessuna connessione e uno che non risponde mai non la trattiene.
- **Pagina** (`apps/web/test/notifications.test.ts`, `apps/web/test/ui-copy.test.ts`): una scrittura senza il token CSRF giusto non arriva all'API; le otto chiamate vanno ai percorsi dell'API con i loro metodi e i loro tempi; un campo segreto lasciato vuoto non viene mandato; la pagina mostra ciò che è salvato di ogni canale e mai un segreto; un cliente non scrive indirizzi e vede solo i suoi tipi di avviso; un membro che non è proprietario legge chi può impostare le notifiche, non un errore; ogni canale, gruppo, esito e motivo del contratto ha il suo testo nelle due lingue.
- **Installazione** (`infra/linux/features-gate.test.ts`, `infra/linux/update.test.ts`, `infra/release/release-manifest.test.ts`, `packages/database/test/notifications-downgrade-gate.test.ts`, `packages/database/test/restore-panel-sql.test.ts`): `hp-update` rifiuta un downgrade con codice 8 finché esiste un canale, nominando solo quella funzione, e non trattiene una destinazione che conosce le notifiche; il testo SQL del cancello, eseguito sullo schema vero, vale per un canale del server o di un cliente, anche spento, e non vale più quando l'ultimo è rimosso; il ripristino del pannello dimentica ciò che i canali sapevano e chiude i messaggi in attesa.

Non provato:

- Le due pagine viste da una persona in un browser vero.
- Una consegna fuori dai test: un relay di posta vero, un ricevitore di webhook su Internet, l'API vera di Telegram.
- `infra/linux/accept-m3-panel.mjs`, il collaudo del ripristino del pannello su un server, non è stato rieseguito con le righe nuove: sono provate su PGlite.
- Un server da cui non si esce in HTTPS.

Punti aperti:

- Un amministratore del server non può togliere dal pannello il canale di un cliente: prima di un downgrade lo toglie il proprietario, oppure serve `--allow-feature-loss`.
- Chi riceve un webhook non sa quanti tentativi ha fatto il pannello: il corpo porta solo l'identificativo del messaggio.
- Con una chiave principale diversa da quella della copia, dopo un ripristino un canale webhook o Telegram va rimosso e impostato di nuovo.
