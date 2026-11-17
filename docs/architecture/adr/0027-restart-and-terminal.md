# ADR 0027 — Riavvio e Terminale (M5c): Riavviare un Sito o un Container del Pannello, Start dopo Stop, e una Shell di Testo nel Sito

- **Stato:** `APPROVATO — M5c`
- **Data:** 2026-11-17
- **Riferimento:** quadro di M5c (`M5C-FRAME`, decisioni D1–D24), `ADR-0019`, `ADR-0025`, `ADR-0026`; regole `R191`, `R192`, `R193`, `R194`, `R195`, `R196`, `R197`
- **Migrazioni:** `0016_admin_terminal_sessions.sql` (additiva). Crea la tabella `admin_terminal_sessions` (`id`, `user_id`, `site_id`, `organization_id`, `container_name`, `opened_at`, `closed_at`, `close_reason`), con un vincolo sui motivi di chiusura ammessi, un vincolo che vuole `closed_at` e `close_reason` entrambi vuoti o entrambi pieni, un indice parziale sulle sessioni aperte e nessuna chiave esterna (una riga resta anche quando il sito o l'utente non ci sono più).

## 1. Contesto

Con M5b l'amministratore del server vede su **Stato** cosa non funziona, ma non può fare niente dal pannello: per riavviare un container del pannello o guardare dentro un sito deve entrare nel server con SSH. Inoltre un sito fermato dal cliente tornava a «in esecuzione» nelle viste del pannello dopo una passata, e un container di sito sparito non si poteva ricreare con Riavvia.

M5c, la terza delle quattro parti di M5, aggiunge:

1. **Riavvia** su ogni riga di sito e su ogni container del pannello in **Stato**, sempre con un motivo;
2. le riparazioni di **Start dopo Stop**: lo stato voluto di un sito è sempre quello dell'ultima azione, e un sito fermato di proposito si mostra fermo ovunque;
3. **un container sparito** viene creato di nuovo da quanto il pannello ha salvato;
4. un **terminale di testo** nel container di un sito, per l'amministratore, dietro un codice nuovo dell'app di autenticazione, registrato senza il suo contenuto.

Questo documento descrive il codice come è stato costruito. Dove il codice fa una cosa diversa dal quadro o dai rapporti degli architetti, lo dice, con la regola che lo accetta.

## 2. Decisioni

### 2.1 Riavviare un sito

- **Route:** `POST /v1/admin/sites/{siteId}/restart`, con `Idempotency-Key` e corpo `{reason}`. Ordine dei controlli: `requireServerAdmin` (un cliente riceve `403` e una riga di audit), la chiave (`400` se manca), il motivo (`RestartInputSchema`: tolti gli spazi ai lati, da 1 a 500 caratteri, nessun altro campo; `400` altrimenti), il proprietario del sito (`404`), poi la stessa azione Riavvia del cliente (`service.restart` sotto il blocco del sito; `409 RESOURCE_LOCKED` se un'altra operazione lo tiene, `409 IDEMPOTENCY_CONFLICT` se la chiave è stata usata per un'altra richiesta). Risponde `202` con `siteId` e `operationId`. Non conta nel limite delle azioni pesanti.
- **Il motivo serve a chi legge dopo.** Finisce nella riga di audit `admin.site.restart` (`details` con `reason` e `operationId`), così il **Registro attività** dice chi ha riavviato cosa e perché. I clienti non lo vedono mai. La riga è senza organizzazione, come le altre azioni dell'amministratore su un sito (R193 1.1), ed è scritta nella stessa transazione che mette in coda il riavvio: se la riga non si può scrivere, nessun riavvio parte, e la stessa richiesta ripetuta con la stessa chiave non scrive una seconda riga (R195 1.4; prima la riga era scritta dopo la coda, e una chiave ripetuta ne scriveva una seconda).
- **Riavvia fa partire un sito fermato dal suo proprietario.** Ogni azione Start, Stop o Riavvia scrive lo stato voluto (`running` per Start e Riavvia, `stopped` per Stop). Riavvia di un sito fermo lo rimette `running`, e resta attivo finché qualcuno non lo ferma. La finestra di Riavvia lo dice prima (`admin.health.restart.warn.siteStopped`), e la riga di audit dice chi l'ha fatto e perché. Riavvia è offerto su ogni riga di sito di **Stato** (R192 2.3): è l'unico pulsante dell'amministratore per un sito fermo, e la frase `container_down` del terminale rimanda proprio lì.
- **Cosa interrompe:** il sito non risponde per qualche secondo; una pagina in caricamento o un upload in corso falliscono e vanno ripetuti.

### 2.2 Start dopo Stop e un container sparito

- **Un sito voluto fermo si mostra fermo** nella scheda del sito, nell'elenco dei siti dell'amministratore e in quello del cliente (`shownSiteStatus`), invece di tornare «pronto» dopo una passata. Start lo riporta «pronto».
- **Cambiare la versione PHP di un sito fermo è rifiutato** con `400` («Start the site first, then change the PHP version.») e nessuna operazione.
- **Un ripristino non avvia un sito fermato di proposito:** il passo di avvio è saltato con il messaggio «The site was stopped on purpose; skipped».
- **Uno Stop non riuscito non lascia il sito «fermo» mentre serve pagine.** Lo Stop salva lo stato voluto `stopped` quando viene messo in coda, prima di girare. Poi:
  - se lo stop **fallisce di sicuro** (ogni errore che non sia `OPERATION_AMBIGUOUS`, cioè «esito incerto») mentre l'operazione era ancora in coda o in corso, lo stato voluto torna `running` nella stessa transazione che segna l'operazione fallita (R195 1.1). Tutte le viste dicono di nuovo che il sito è attivo, e il cliente può premere di nuovo Stop;
  - se l'esito dello stop è **incerto** (la risposta dell'esecutore non è arrivata, o l'API si è fermata a metà), l'operazione resta «sconosciuta» e lo stato voluto resta `stopped` finché non passa il **recupero**, la passata che chiude le operazioni rimaste in dubbio guardando il container senza toccarlo (`recoverUnknownOperations`). Se vede il container fermo, lo Stop riesce e il sito resta voluto fermo. Se vede il container in esecuzione, lo Stop finisce fallito (`OPERATION_INTERRUPTED`) e lo stato voluto torna `running` nella stessa transazione (R196 1.1). Se non trova il container, lo Stop finisce fallito e il sito resta voluto fermo (Start lo crea di nuovo). Se l'esecutore è spento o non risponde, non cambia niente: con l'esecutore spento l'operazione finisce fallita, se non risponde resta in dubbio per la passata successiva. La passata di controllo (drift) guarda soltanto e non decide niente di questo.
- **Un cambio di proprietario** ridistribuisce il sito e poi lo ferma di nuovo. Lo stato voluto è giusto subito; lo stato del container salvato dice «in esecuzione» fino alla passata di controllo successiva (R193 1.2; Stato non dà avvisi per un sito voluto fermo). Se lo stop dopo la ridistribuzione fallisce di sicuro, lo stato voluto diventa `running` (il sito infatti serve) e l'operazione fallisce; nessun nuovo tentativo automatico. Riprova rifà il cambio di proprietario e lo finisce con il sito attivo (R195 1.3).
- **Un container sparito è creato di nuovo da quanto il pannello ha salvato.** Se Riavvia trova il container assente (`NOT_FOUND` dall'esecutore), e solo se l'ultimo `site.provision` del sito è riuscito **e nessuno ha mai chiesto di cancellare il sito**, il sito viene distribuito di nuovo dalla revisione salvata, con i suoi volumi. Un sito che non è mai stato creato del tutto non viene inventato, e un sito di cui è stata chiesta la cancellazione non viene ricostruito, anche se la cancellazione è fallita a metà (R195 1.2): Riavvia risponde come per un sito mai creato. Stop su un container sparito riesce, salva `missing` e non crea niente.
- **Le correzioni di R191 1.2, 1.3 e 5** sono nel codice: un aumento dei riavvii seguito da nessuna osservazione non dà più `site_container_down` sei minuti dopo; un aumento ricordato si dimentica quando il container è visto mancante; i domini di un sito danno `certificate_not_issued` e `certificate_expiring`.

### 2.3 Riavviare un container del pannello

- **Route:** `POST /v1/admin/panel-containers/{component}/restart`, con `Idempotency-Key` e corpo `{reason}`. `component` è uno dei cinque nomi dell'elenco chiuso (`ingress_proxy`, `shared_database`, `phpmyadmin`, `sftp`, `mail_relay`); un altro nome è `400`. Prima di accodare legge lo stato salvato: runtime disattivato → `422 NOT_SUPPORTED`; container «non in uso», o visto fermo con motivo `missing` → `409 PANEL_CONTAINER_ABSENT` («This container is not installed. There is nothing to restart.»). Risponde `202` con `component` e `operationId`.
- **Una transazione:** l'operazione `panel.container.restart` dell'organizzazione di piattaforma (`ensurePlatformOpsOrg`), con il blocco `panel:container:<component>`, un passo «Restart the container», e la riga di audit `admin.panel_container.restart` (`details`: `outcome`, `requestId`, `operationId`, `component`, `reason`). Una chiave ripetuta non scrive una seconda riga. Un secondo riavvio dello stesso container mentre il primo è in coda o in corso è `409 RESOURCE_LOCKED`.
- **Il lavoro** (`apps/api/src/health/panel-restart.ts`): l'operazione aspetta fino a 2 secondi dopo la richiesta, così il riavvio del proxy non taglia la risposta `202`; un'operazione più vecchia di 60 secondi quando il lavoro la prende finisce `OPERATION_INTERRUPTED` senza toccare niente. L'esecutore riavvia il container per nome, con 5 secondi per fermarsi (10 per `mail_relay`) e un limite di 25 secondi verso il motore; il client aspetta al massimo 35 secondi. La fine scrive, nella stessa transazione che chiude l'operazione, la riga `admin.panel_container.restart.end` (autore `system`; `details`: `operationId`, `component`, `outcome`, `errorCode`). Un riavvio non riuscito salva sempre la stessa frase («The container did not restart. Check Health, then try again.»), mai il testo dell'esecutore.
- **L'esecutore rifiuta** (`RESOURCE_LOCKED`) il riavvio di un container mentre gira la sua creazione o il suo aggiornamento, e rifiuta un nome fuori dai cinque già nello schema dell'IPC, prima di parlare col motore.
- **Nessun avviso falso:** `component_down` non si alza mentre il riavvio gira né per un'osservazione non più recente della sua fine.
- **Cosa interrompe ciascuno** (le stesse frasi sono nella finestra di Riavvia):
  - `ingress_proxy`: tutti i siti del server e il pannello non rispondono, di solito per pochi secondi; la pagina perde la connessione e si ricollega da sola.
  - `shared_database` (`hp_mariadb`): il database di ogni sito si ferma, di solito per meno di un minuto; i siti mostrano un errore di database, e un backup o un ripristino di database in corso fallisce e va rifatto.
  - `phpmyadmin`: si ferma per pochi secondi; chi lo usa deve riaprirlo dalla scheda Database del sito.
  - `sftp`: le connessioni aperte si chiudono; un trasferimento in corso va rifatto.
  - `mail_relay`: la posta in uscita si ferma per pochi secondi; quella inviata da un sito in quei secondi può fallire e non viene rinviata.
- **Seguire un'operazione:** `GET /v1/admin/operations/{operationId}` legge qualunque operazione per id (solo l'amministratore; nessuna riga di audit; `404` se non c'è). La finestra la chiede ogni 2 secondi e dopo 3 minuti senza una fine dice che non lo sa.

### 2.4 Il terminale

- **Cos'è:** una shell `/bin/sh` dentro il container del sito, come utente `33:33` (l'utente del web server, `www-data`), **mai root**, nella cartella `/var/www/html`. È di **solo testo**: `TERM=dumb`, dimensione fissa 24×80, nessun emulatore di terminale e **nessuna dipendenza nuova**. La pagina mostra l'output come testo (`role="log"`): un ritorno carrello (`\r`) riporta all'inizio della riga e la riscrive, mentre colori e altre sequenze di controllo sono tolti. Sono tolti anche i caratteri che cambiano la direzione del testo (U+202A–202E, U+2066–2069, U+200E, U+200F, U+061C): potrebbero far sembrare un comando o un nome di file diverso da quello che è. È la stessa regola dei titoli WordPress (ADR 0023); l'arabo e l'ebraico restano (R195 3.1). Si scrive riga per riga (al massimo 4096 byte, quanto tiene il buffer del terminale); ci sono i pulsanti **Ctrl-C**, **Ctrl-D** e **Chiudi la sessione**.
- **Le route** (`v1/admin`, tutte dietro `requireServerAdmin`):
  - `POST /sites/{siteId}/terminal` apre (`201`, con `sessionId`, `containerName`, `openedAt`, `expiresAt`);
  - `POST /terminal/{sessionId}/write` scrive (`204`);
  - `POST /terminal/{sessionId}/read` legge dopo un cursore e aspetta fino a 20 secondi quando non c'è niente di nuovo (`200`); l'esecutore tiene gli ultimi 256 KiB e segnala `dropped` quando ha scartato output;
  - `POST /terminal/{sessionId}/close` chiude (`204`, anche una seconda volta).
  Una sessione di un altro amministratore, o un id che non ha la forma `term_` più 32 cifre esadecimali, è `404` come una sconosciuta.
- **Un codice nuovo a ogni apertura.** L'apertura chiede il codice a sei cifre dell'app di autenticazione, controllato su una lettura fresca dell'utente. Ordine: sito e servizio (`404`); runtime o esecutore non disponibili (`503`); sito in modifica (`409`, `site_changing`); sito voluto fermo (`409`, `container_down`, «The site is not running. Restart it, then open the terminal.»); codice mancante o non a sei cifre (`400`); account senza autenticazione in due passaggi (`403 ACCOUNT_SETUP_INCOMPLETE`); account bloccato dai codici errati (`423 ACCOUNT_LOCKED`, lo stesso conteggio dell'accesso: al quinto errore 15 minuti); codice errato o già usato (`401 TOTP_INVALID`, la stessa frase per i due casi). Ogni rifiuto del codice scrive `admin.terminal.denied` con il motivo (`code_missing`, `totp_not_enrolled`, `locked`, `code_wrong`, `code_used`) e l'organizzazione del proprietario del sito, e non arriva mai all'esecutore. Il codice usato è salvato come ultimo passo dell'utente, quindi non vale più né per l'accesso né per un'altra apertura.
- **Una sessione per sito e quattro sul server.** L'API crea l'id della sessione e, sotto un blocco della tabella, controlla prima il sito (`site_busy`) e poi il server (`server_full`), poi salva la riga della sessione con la riga di audit `admin.terminal.open` (`details`: `outcome`, `requestId`, `sessionId`, `containerName`) **prima** di chiamare l'esecutore. L'esecutore applica gli stessi limiti per conto suo. I rifiuti sono `409 RESOURCE_LOCKED` con `details[0].reason`.
- **Finisce da sola** dopo **60 secondi senza una lettura** (`idle`) o **30 minuti** dall'apertura (`time_limit`). Gli altri modi di finire: `closed` (Chiudi), `shell_exited` (Ctrl-D o `exit`), `container_gone` (il container si è fermato o riavviato), `executor_gone` (l'esecutore non ha più la sessione), `not_started` (l'apertura è stata rifiutata dopo la riga salvata). `executor_gone` e `not_started` li scrive solo l'API, quando l'esecutore non ha la sessione: per quelle due fini non parte nessuno script (alle shell rimaste pensa l'esecutore al suo avvio, limite 3). Ogni altra fine, tranne `container_gone`, lancia nel container uno script, come `33:33`, che uccide i processi segnati della sessione e i loro gruppi, compresi quelli lanciati in fondo con `&`, `nohup` o `setsid`. Lo script conta come riuscito quando finisce con 0, o quando il container non c'è più o è fermo. Se non riesce, la sessione resta segnata come «da uccidere»: la passata dell'API (ogni 30 secondi) chiede di nuovo la chiusura e l'esecutore rilancia lo script, finché riesce o finché scadono i 10 minuti in cui tiene una sessione finita; allora scrive nel suo log una sola riga `terminal_kill_failed` con il codice fisso `INTERNAL_ERROR`, senza testo (R195 2.1). Vale anche per la fine `shell_exited`, cioè Ctrl-D o `exit` (R196 1.2). Una sessione finita non occupa il posto del sito né uno dei quattro. Una sessione chiusa mentre la sua shell stava ancora partendo prova l'uccisione una volta sola.
- **Una passata ogni 30 secondi** confronta le righe aperte con l'elenco dell'esecutore: chiude con il motivo dell'esecutore le sessioni finite, chiude come `executor_gone` le righe che l'esecutore non conosce più da oltre 60 secondi dall'apertura, e chiede all'esecutore di chiudere quelle che non hanno una riga aperta. Se l'elenco non si legge, non fa niente. All'avvio l'esecutore uccide le shell di terminale rimaste da una sua vita precedente (`reapTerminalShells`).
- **Cosa è registrato e cosa no.** Una riga `admin.terminal.open` e una sola `admin.terminal.close` per sessione, con chi, quale sito (e il suo proprietario), quando, quanto è durata (`durationSeconds`) e come è finita (`reason`). **Ciò che viene digitato e ciò che la shell stampa non è mai salvato**: né nella tabella, né nell'audit, né nei log dell'API, del web o dell'esecutore. L'output sta solo nella memoria dell'esecutore (al massimo 256 KiB per sessione) e sulla pagina aperta.
- **La pagina** `/admin/sites/{siteId}/terminal` è collegata da **Stato** (container visto in esecuzione o degradato) e da **Siti** (sito pronto o degradato). Chiude la sessione quando la pagina viene lasciata (`pagehide`, con `keepalive`). Dopo 40 secondi senza una risposta a una lettura considera la sessione persa. Una pagina mostrata di nuovo dalla cache avanti/indietro del browser (`pageshow` con `persisted`) si ricarica da sola, perché la sua sessione è già stata chiusa da `pagehide` (R195 3.2). Il riquadro dell'output segue il testo nuovo solo se era già in fondo (entro 20 pixel), e si raggiunge e si scorre dalla tastiera (R195 3.3).

## 3. Alternative scartate

- **Un emulatore di terminale nel browser** (come xterm.js) e un WebSocket: nuova dipendenza, nuovo canale da proteggere e da registrare. Il terminale di testo con lettura lunga copre i comandi riga per riga, che è ciò che serve per controllare un sito.
- **La shell come root**, o `docker exec` senza utente: darebbe all'amministratore più di quanto ha il sito, e un errore toccherebbe il container intero.
- **Registrare quello che passa** nel terminale: conterrebbe password e dati dei clienti, e renderebbe il registro attività un posto da proteggere come un database.
- **Un codice solo all'accesso** invece che a ogni apertura: una sessione rubata del browser basterebbe per aprire una shell.
- **Riavvio senza motivo**, o un motivo facoltativo: il registro direbbe che un sito o il proxy è stato riavviato, ma non perché.
- **Mettere in coda il riavvio di un container del pannello** mentre lo stesso container viene creato o aggiornato: rifiutarlo (`RESOURCE_LOCKED`) è più semplice da capire di un riavvio che parte dopo.

## 4. Limiti accettati

Ogni limite dice su cosa non si può contare e cosa fa l'amministratore. Fonti: R192 punto 1, R193, i rischi e le deviazioni degli architetti, i rapporti degli ingegneri.

1. **I programmi a schermo intero non funzionano** (`vi`, `nano`, `less`, `top`; l'immagine dei siti non ha nemmeno `vi`, `vim`, `nano`, `less` o `htop`).
   - *Su cosa non si può contare:* modificare un file in modo interattivo dal terminale.
   - *Cosa fa l'amministratore:* usa comandi riga per riga (`sed -i`, `cat`, `more`, `ps`) o il file manager del sito.
2. **Un processo che lascia la sessione (`setsid`) e toglie il segno della sessione dal proprio ambiente sopravvive alla chiusura** finché il container non si riavvia.
   - *Su cosa non si può contare:* che Chiudi uccida un processo fatto apposta per restare.
   - *Cosa fa l'amministratore:* lo cerca con `ps` e lo ferma con `kill`, oppure riavvia il sito da **Stato**.
3. **Se l'esecutore si ferma e non riparte, le sue shell restano vive** finché non riparte (allora le uccide all'avvio).
   - *Cosa fa l'amministratore:* `sudo systemctl restart hp-docker-executor`; la pagina **Stato** mostra l'esecutore «Non funziona».
4. **Un codice già usato è rifiutato fino al prossimo**, anche se l'ha usato l'accesso pochi secondi prima.
   - *Cosa fa l'amministratore:* aspetta il codice successivo dell'app (di solito 30 secondi).
5. **Il motivo di chiusura diventa `executor_gone` quando l'API è rimasta ferma più di 10 minuti**, perché l'esecutore dimentica una sessione finita dopo 10 minuti.
   - *Su cosa non si può contare:* il motivo esatto di una sessione finita mentre l'API era ferma a lungo.
   - *Cosa fa l'amministratore:* legge durata e ora nella riga `admin.terminal.close`.
6. **I limiti contano una sessione già finita fino alla prossima lettura o passata** (al massimo 30 secondi).
   - *Cosa fa l'amministratore:* se riceve `site_busy` o `server_full` subito dopo una chiusura, riprova dopo 30 secondi.
7. **Riavvia dell'amministratore annulla lo Stop del proprietario.** Il sito resta attivo finché qualcuno non lo ferma.
   - *Su cosa non si può contare:* che un sito fermato dal cliente resti fermo dopo un Riavvia dell'amministratore.
   - *Cosa fa l'amministratore:* legge l'avviso nella finestra; se serviva solo un controllo, ferma di nuovo il sito o avvisa il cliente. La riga di audit conserva il motivo.
8. **Un riavvio di un container del pannello interrotto si mostra «non riuscito» anche se Docker lo ha finito** (l'API si è fermata durante il riavvio, o l'operazione è stata presa dopo 60 secondi).
   - *Cosa fa l'amministratore:* guarda la riga del container in **Stato**, che dice com'è davvero.
9. **Il riavvio di un container del pannello occupa la coda principale delle operazioni** per i suoi 2 secondi di attesa più il riavvio (al massimo 35 secondi): nel frattempo le altre operazioni aspettano.
10. **Un secondo di attesa prima di chiedere perché una shell è finita** (R193 1.4). Su un motore Docker troppo occupato per segnalare lo stop entro quel secondo, una sessione finita per un riavvio è registrata «la shell è terminata» (`shell_exited`) invece di «il container si è fermato o riavviato» (`container_gone`).
    - *Su cosa non si può contare:* quel motivo, in quel caso; la sessione finisce, la shell è uccisa e le due righe sono scritte lo stesso.
    - *Cosa fa l'amministratore:* confronta l'ora della chiusura con i riavvii del sito in **Stato** o nel registro.
11. **Il recupero delle shell all'avvio dell'esecutore è provato solo sul daemon finto**: elenca ogni container di sito della macchina, quindi non è stato eseguito su un motore condiviso. Non provati: la chiamata del recupero all'avvio dell'esecutore e il limite di 25 secondi del riavvio verso il motore. Se il recupero fallisce l'esecutore scrive `terminal_reap_failed` nel suo log, con il solo codice.
    - *Cosa fa l'amministratore:* dopo un riavvio dell'esecutore può cercare le shell rimaste con `ps` dal terminale di un sito, oppure riavviare il sito.
12. **Dopo un cambio di proprietario lo stato del container salvato di un sito fermo dice «in esecuzione»** fino alla passata di controllo successiva (15 secondi).
13. **La riga `admin.site.restart` non ha organizzazione**, come le altre azioni dell'amministratore su un sito.
    - *Cosa fa l'amministratore:* nel **Registro attività** la trova filtrando per azione, non per organizzazione.
14. **Il link Terminale segue due regole diverse**: in **Stato** compare per un container visto in esecuzione o degradato; in **Siti** per un sito pronto o degradato. Possono differire per una passata.
15. **Le frasi delle pagine in pochi casi sono generiche.** Nel terminale (R193 3): un rifiuto imprevisto di una scrittura mostra la frase generica; un `503` su una scrittura dice di controllare la connessione; `RATE_LIMITED` non ha una frase propria; un `504` del BFF dopo 40 secondi porta subito a «persa». Nella finestra di Riavvia, `422 NOT_SUPPORTED` (il pulsante è già nascosto con il runtime disattivato) e `409 IDEMPOTENCY_CONFLICT` mostrano la frase generica.
    - *Cosa fa l'amministratore:* riprova; se si ripete, guarda **Stato**.
16. **Una distribuzione tra il controllo e l'apertura** (pochi millisecondi) fa finire la sessione appena aperta come `container_gone`.
    - *Cosa fa l'amministratore:* apre di nuovo con il codice successivo.
17. **L'avvio di un container `unless-stopped` da parte di Docker dopo un riavvio del server non è provato** (il motore usato per le prove è condiviso e non è stato riavviato). Per i siti è stato provato che Start e Riavvia trovano tutto quello che serve (R192 2.6).
18. **Un riavvio manuale riporta a 0 il conteggio dei riavvii di Docker**: la colonna «riavvii» di **Stato** riparte da zero.
19. **La pagina del terminale non è un terminale vero:**
    - una riga riscritta più corta tiene la coda di quella vecchia (per esempio «Doneloading»);
    - una sequenza OSC più lunga di 256 caratteri è scartata e ciò che segue si vede come testo;
    - una scheda in secondo piano rallentata dal browser può smettere di leggere, e la sessione finisce `idle`;
    - la chiusura su `pagehide` è fatta al meglio: se non arriva, la sessione finisce da sola dopo 60 secondi;
    - dopo un ritorno dalla cache avanti/indietro del browser la pagina si ricarica da sola (R195 3.2): la sessione di prima è chiusa e una nuova chiede un codice nuovo;
    - quando la pagina considera la sessione persa manda la chiusura una volta, al meglio: se non arriva (la connessione è ancora giù), una nuova apertura sullo stesso sito può essere rifiutata come occupata per al massimo 60 secondi, e il codice digitato per quella apertura è consumato: si aspetta un minuto, poi si usa un codice nuovo;
    - «persa» si conta dall'inizio di ogni lettura: dopo una lettura fallita e la sua pausa, la pagina può metterci fino a circa 90 secondi dall'ultima risposta per dirlo;
    - un lettore di schermo annuncia ogni riga nuova.
    - *Cosa fa l'amministratore:* tiene la scheda in primo piano e ricarica la pagina quando la console non risponde.
20. **Dopo il riavvio di un container del pannello, se la lettura del container non riesce, l'ora di avvio restituita è vuota** (`startedAt: null`); il riavvio è comunque riuscito.
21. **Un utente che ha righe nel registro attività non si può cancellare** (il registro è immutabile); la tabella delle sessioni non ha chiavi esterne, quindi non lo impedisce lei.
22. **Due aperture nello stesso istante con lo stesso codice:** una sola riesce; l'altra è registrata `code_used` o `code_wrong`.
23. **Il rifiuto per quota dell'esecutore e l'apertura che scade sono provati con un sostituto del simulatore**, che non ha un modo diretto per produrli.
24. **Limite noto fuori da M5c (R192 punto 3):** un **servizio generico** (non un sito gestito) con `secretRefs` monta file dalla cartella temporanea `/run/hosting-panel/secrets`. Dopo un riavvio del server quella cartella è vuota: Docker crea al posto del file una cartella di root, Start risponde `400`, Riavvia `500` e una nuova distribuzione fallisce su quella cartella. I siti gestiti non montano niente da lì e ripartono normalmente.
    - *Su cosa non si può contare:* che un servizio generico con segreti riparta dopo un riavvio del server, o che Riavvia lo ripari.
    - *Cosa fa l'amministratore:* la riparazione (riscrivere i segreti prima di un avvio e togliere la cartella sbagliata) è rimandata a M6.
25. **Un'uccisione che non riesce per 10 minuti si arrende** (R195 2.1): l'esecutore scrive `terminal_kill_failed` (codice fisso `INTERNAL_ERROR`) e i processi della sessione restano finché il container del sito non si riavvia.
    - *Su cosa non si può contare:* che il pannello lo mostri (R197 2). La riga è solo nel giornale dell'esecutore, sul server: `journalctl -u hp-docker-executor`. La pagina **Log** mostra i container (i cinque del pannello e quelli dei siti), non i servizi del server.
    - *Cosa fa l'amministratore:* se trova quella riga nel giornale dell'esecutore, riavvia il sito.
26. **Una sessione chiusa mentre la sua shell stava ancora partendo prova l'uccisione una volta sola** (R196 2); se non riesce, non c'è una riga di log.
27. **Dopo «non è stato possibile inviare» una riga può girare due volte** (R195 5): la pagina non la rimanda da sola, ma se l'esecutore era bloccato per più di 8 secondi e la prima è arrivata tardi, premere di nuovo Invio la fa girare di nuovo.
    - *Cosa fa l'amministratore:* prima di ripetere un comando che cambia qualcosa, guarda l'output.
28. **Sotto una pioggia di output** la memoria resta limitata (256 KiB per sessione, quattro sessioni), ma la copia dell'output tenuto a ogni pezzo non è stata misurata (R195 5).
29. **Dopo un cambio di proprietario il cui stop è fallito il sito è attivo** (R195 1.3): il nuovo proprietario lo trova acceso e, se lo vuole fermo, lo ferma; Riprova finisce il cambio con il sito attivo.
30. **Uno stop a cui il motore Docker non risponde entro 30 secondi conta come fallito di sicuro** (R196 2): il sito torna voluto `running`; se il motore finisce lo stop dopo, il sito è giù mentre le pagine dicono che è attivo. **Stato** lo mostra giù, e un nuovo Stop sistema tutto. La riparazione cambierebbe come l'esecutore segnala un tempo scaduto per ogni chiamata ed è nell'elenco di M6.
31. **Riavvia e Start non ricostruiscono mai il container di un sito di cui qualcuno ha chiesto la cancellazione** (R195 1.2, R196 2), anche quando la cancellazione è fallita prima di togliere qualcosa.
    - *Cosa fa l'amministratore:* rifà la cancellazione (`DELETE /v1/admin/sites/{siteId}`), oppure ripristina il sito da un backup (**Amministrazione › Backup › Ripristina**). Il ripristino di un sito con la cancellazione fallita è stato letto nel codice, non eseguito (R197 3).
32. **Il recupero guarda il container una volta sola** (R197 1): se l'esecutore muore a metà di uno stop e torna entro i 10 secondi che lo stop concede al container, il recupero può vedere il container ancora in esecuzione. Allora chiude lo Stop come fallito e rimette il sito voluto `running`; poi Docker finisce lo stop, e il sito è giù mentre le pagine dicono che è attivo. È lo stesso danno del limite 30, e si esce allo stesso modo: **Stato** lo mostra giù, e un nuovo Stop sistema tutto. La riparazione (una seconda lettura dopo quei 10 secondi) è nell'elenco di M6. Nessun test copre questo caso.

## 5. Modello di fiducia

- **Tutte le sette route nuove** sono sotto `v1/admin/` e dietro `requireServerAdmin`, prima di ogni controllo del corpo: un cliente riceve `403` e una riga di audit.
- **Una sessione è di chi l'ha aperta:** un altro amministratore riceve `404` su scrittura, lettura e chiusura.
- **Il codice è chiesto a ogni apertura**, contato con i tentativi dell'accesso e salvato come usato. Un account senza autenticazione in due passaggi non apre mai un terminale.
- **La shell gira come `33:33`**, non root, solo nel container del sito scelto: l'API passa all'esecutore l'id del sito e del suo servizio; l'esecutore trova il container del servizio, controlla che la sua etichetta sia quella del sito e che sia in esecuzione, altrimenti risponde `NOT_FOUND`. L'esecutore accetta solo id `term_` più 32 cifre esadecimali e solo richieste firmate.
- **I nomi dei container del pannello** arrivano dall'elenco chiuso dei cinque; l'esecutore li traduce con la sua mappa e rifiuta ogni altro nome nello schema dell'IPC.
- **Il contenuto del terminale non viene salvato da nessuna parte**; l'audit ha solo i fatti della sessione. Il testo degli errori dell'esecutore non arriva al browser.

## 6. Conformità alle regole architetturali

- **Socket Docker solo nell'esecutore:** l'API apre, scrive, legge, chiude ed elenca le sessioni e riavvia i container del pannello con sei chiamate chiuse dell'IPC firmato.
- **`CP-01`:** un riavvio avviene solo su richiesta esplicita dell'amministratore, con un motivo registrato; la creazione di nuovo di un container sparito avviene solo dentro un Riavvia richiesto. Il terminale non riavvia né modifica container.
- **Isolamento e audit:** il percorso sulle route di amministrazione prova `403` e la riga di audit anche per le sette route nuove; ogni apertura, rifiuto e chiusura del terminale è registrata.
- **Nessuna dipendenza npm nuova** (l'elenco delle dipendenze ammesse non cambia), nessun permesso nuovo. Un codice di errore nuovo, `PANEL_CONTAINER_ABSENT` (`409`), e un tipo di operazione nuovo, `panel.container.restart`.
- **Testi:** ogni frase in italiano e inglese. Nessun testo per il cliente parla di Docker o container; l'unico cambio dal lato cliente è il rifiuto di Cambia versione su un sito fermo.

## 7. Verifica

- **Test automatici di questo ciclo:**
  - le due route di riavvio, il motivo, l'ordine dei controlli, le righe di audit della richiesta e della fine, `PANEL_CONTAINER_ABSENT` e `NOT_SUPPORTED`: `apps/api/test/admin-restart.integration.test.ts`;
  - un sito voluto fermo mostrato fermo ovunque, Riavvia che lo rimette `running`, Cambia versione rifiutato: `apps/api/test/managed-sites.integration.test.ts`; il ripristino che non avvia un sito fermo: `apps/api/test/admin-restore.integration.test.ts`; il cambio di proprietario che lo lascia fermo: `apps/api/test/admin-sites.integration.test.ts`;
  - il container sparito creato di nuovo da Riavvia e le correzioni di R191 1.2 e 5: `apps/api/test/admin-health.integration.test.ts`; R191 1.3: `packages/database/test/phase2-database.test.ts`;
  - le route del terminale, il codice, i limiti, la passata e i motivi di chiusura: `apps/api/test/admin-terminal.integration.test.ts`;
  - le prove della QA sull'API (solo l'amministratore, codice nuovo a ogni apertura, una riga di apertura e una di chiusura per ogni fine, i limiti, nessun accesso alla sessione di un altro, nessun contenuto salvato, Riavvia con motivo, sito fermo, lettura di un'operazione): `apps/api/test/m5c-api-qa.integration.test.ts`;
  - ogni route dell'amministratore risponde a un cliente `403` con una riga di audit, comprese le sette nuove: `apps/api/test/admin-route-guard.integration.test.ts`;
  - la tabella delle sessioni, il blocco dei limiti e la chiusura una sola volta: `packages/database/test/admin-terminal-repository.test.ts`;
  - i contratti (motivo, input, id della sessione, schemi dell'IPC): `packages/contracts/test/admin-terminal.test.ts` e `packages/contracts/test/contracts.test.ts`; l'esecutore della fase 1 che rifiuta le chiamate nuove: `packages/executor-contracts/test/executor-contracts.test.ts`;
  - le sessioni nell'esecutore (cursore, lettura lunga, timer, limiti, rifiuti): `apps/docker-executor/test/terminal-sessions.test.ts`; il simulatore: `apps/docker-executor/test/simulator-terminal.test.ts`; le route IPC: `apps/docker-executor/test/terminal-ipc.test.ts`;
  - l'apertura sul motore, il motivo di fine e il recupero all'avvio, sul daemon finto: `apps/docker-executor/test/terminal-docker.test.ts`; il riavvio per nome: `apps/docker-executor/test/panel-restart.test.ts`;
  - le prove della QA sull'esecutore (solo richieste firmate, una sessione intera, rifiuti prima del motore, limiti contemporanei, una sessione per sito, ogni fine uccide solo la sua shell, riavvio di un container del pannello, niente salvato): `apps/docker-executor/test/m5c-exec-qa.test.ts`;
  - le riparazioni delle due revisioni (R195 1.1–1.5, R196 1.1): `apps/api/test/m5c-review.integration.test.ts`. Prova che uno Stop fallito di sicuro rimette il sito voluto `running` in tutte le viste e si può ripetere; che uno Stop rimasto in dubbio resta voluto fermo finché il recupero non lo chiude, e che il recupero lo rimette voluto `running` solo se vede il container in esecuzione (non se lo vede fermo o non lo trova); che Riavvia non ricostruisce un sito di cui è stata chiesta la cancellazione; che un cambio di proprietario con lo stop fallito lascia il sito voluto `running` e Riprova lo finisce; che la riga `admin.site.restart` è scritta con la coda, una sola per chiave, e che senza riga non parte nessun riavvio; che un container ricostruito da Riavvia ha i volumi della revisione salvata;
  - l'uccisione che dice se è riuscita (uscita 0, uscita 1, avvio rifiutato, container sparito) e la sessione tenuta e riprovata finché riesce, con la riga `terminal_kill_failed` dopo 10 minuti, anche per la fine `shell_exited`: `apps/docker-executor/test/terminal-docker.test.ts` e `apps/docker-executor/test/terminal-sessions.test.ts`; il simulatore che lascia l'output di una sessione comunque finita: `apps/docker-executor/test/simulator-terminal.test.ts`;
  - pannello web: la finestra di Riavvia, il suo seguito e le route BFF in `apps/web/test/admin-restart.test.ts`; la pagina del terminale, il testo, il ciclo di lettura con il suo limite di 40 secondi per lettura e le route BFF in `apps/web/test/admin-terminal.test.ts`, che prova anche i caratteri di direzione tolti, la pagina che si ricarica dalla cache avanti/indietro, il riquadro dell'output che resta dove è stato scorso e la lettura vuota che non cambia niente; la finestra di Riavvia che non si chiude mentre il riavvio parte e il pulsante che dopo il `202` tiene il fuoco senza aprire niente in `apps/web/test/admin-restart.test.ts`; le prove della QA sul web (testo da una shell vera, output ostile mostrato come testo, niente salvato, limiti di tempo, frasi, accessibilità, lato cliente) in `apps/web/test/m5c-web-qa.test.ts`.
- **Cosa provano solo i test dell'API:** l'ordine dei controlli, il codice, l'audit, i limiti nella tabella, la passata e i motivi di chiusura salvati sono provati con l'API sul simulatore dell'esecutore, non su Docker.
- **Collaudo su Docker reale: `infra/linux/accept-m5-terminal.mjs`** (questo documento dice cosa mostra, non quanti passi ha né se è passato). Usa l'adattatore Docker costruito, senza API, su due container WordPress usa e getta `hp_swarmtest_m5t_<hex>_a` e `_b` (immagine locale, rete interna, nessuna porta), e mostra:
  - una sessione aperta nel container A, dimensione 24×80, utente `uid=33(www-data)`;
  - Ctrl-C ferma il comando in corso;
  - Chiudi uccide anche i processi lanciati con `&`, `nohup` e `setsid`;
  - Chiudi lascia vivi i processi del web server del container (passo 4b, R195 2.2);
  - una sessione senza letture finisce `idle` e non lascia processi;
  - Ctrl-D finisce `shell_exited` e uccide anche ciò che girava in fondo;
  - un riavvio di A finisce la sessione aperta come `container_gone`;
  - il riavvio per nome cambia l'ora di avvio di A e non di B; un nome sparito è `NOT_FOUND`; un nome fuori dai cinque è rifiutato dallo schema prima del motore;
  - alla fine non resta nessun container, volume o rete.
  Non mostra: il recupero delle shell all'avvio (mai eseguito su un motore condiviso), il riavvio dei cinque container veri del pannello, né l'avvio di Docker dopo un riavvio del server.
