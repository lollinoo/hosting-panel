# ADR 0042 — Attività Programmate nei Componenti di un'Applicazione

- **Stato:** `PROPOSTO` — scelte A1–A12 prese dall'agente su direttiva del proprietario del 2026-11-22 («vorrei funzionasse come funziona Coolify»); in attesa di approvazione
- **Data:** 2026-11-23
- **Riferimento:** `ADR-0035` (applicazioni: modelli, componenti, etichette, regole dei comandi), `ADR-0027` (terminale dei siti: il segno sui processi e la pulizia alla fine), `ADR-0022` (backup dei siti: una passata che mette in coda ciò che è in programma); issue #77, PR #78
- **Migrazioni:** `0031` (additiva; file `packages/database/migrations/0031_app_stack_tasks.sql`)

Questo ADR dà a un'applicazione la possibilità di lanciare un comando dentro uno dei suoi componenti, a mano oppure a un'ora fissa, e di vedere com'è andata. Il comando lo scrive chi scrive il modello; il cliente decide solo **quando**.

---

## 1. Contesto

Molte applicazioni hanno bisogno di un comando periodico per funzionare: il loro pianificatore interno, una coda da svuotare, una pulizia. Oggi un'applicazione del pannello lancia solo il comando di lunga durata di ogni componente. Per il resto serve un componente scritto apposta, oppure una persona con una shell sul server, come `root` e senza che resti niente di scritto.

La tabella delle funzioni concordata con il proprietario dice, alla riga «operazioni programmate nei container»: prendere. Un pannello per sviluppatori lascia scrivere il comando a chi usa l'applicazione. Questo pannello ragiona per **cliente**, e il suo cliente non è una persona tecnica: un cliente non deve mai scrivere un comando.

Che cosa c'è già:

- **Il modello di un'applicazione** (`ADR-0035`) ha cinque chiavi di primo livello e nessuna parla di qualcosa da lanciare su richiesta. Una chiave che non è nell'elenco è rifiutata.
- **Il comando di un componente** è un elenco di argomenti, mai una riga di shell, e una shell non può esserne il primo argomento.
- **L'esecutore** lancia comandi nei container delle applicazioni solo per i suoi controlli. Il suo esecutore di comandi, allo scadere del tempo, chiude il collegamento ma lascia vivo il processo nel container.
- **Il lavoro in coda di un'applicazione** (installare, fermare, aggiornare) passa una cosa alla volta per applicazione, sotto il blocco dell'applicazione, e una sola alla volta su tutto il server.
- **La parola «operazione»** nel pannello indica già il lavoro in coda. Qui si usa **attività** (in inglese *task*).

---

## 2. Decisioni

### A1 — Di chi è il comando

Le attività appartengono al **modello**. Le scrive un amministratore del server, con le regole che valgono già per i comandi dei componenti, e il pannello le valida quando salva la versione del modello.

Il cliente vede le attività del modello della sua applicazione, ne lancia una e sceglie quando parte da sola. **Nessuna richiesta dell'API contiene un comando**: contiene solo la chiave di un'attività.

### A2 — Il formato nel modello

Una chiave nuova di primo livello, `x-hp-tasks`: un elenco di **al massimo 8** attività. Ogni attività ha:

- `key`: come la chiave di un componente, unica nel modello;
- `label`: il nome che legge il cliente, al massimo 80 caratteri;
- `description` (facoltativa): una riga che dice a che cosa serve, al massimo 200 caratteri;
- `service`: un componente dello stesso modello;
- `command`: un elenco di argomenti con le regole del `command` di un componente (limiti di numero e lunghezza, niente caratteri di controllo, mai una shell o un lanciatore come primo argomento o come argomento). In più, **nessun segnaposto**: nel comando di un'attività non entra nessun valore scelto dal cliente e nessun segreto;
- `timeoutSeconds` (facoltativa): da 5 a 600, 60 se manca.

Un modello **senza** la chiave dà la stessa specifica validata, byte per byte, e lo stesso piano di prima: la specifica ha il campo `tasks` solo quando il modello ne dichiara. Le attività non entrano nel piano dell'applicazione né nella sua impronta.

### A3 — Che cos'è un'esecuzione

Un'esecuzione è il comando dell'attività lanciato **nel container che il componente ha già**. L'esecutore non nomina un utente né una cartella: il comando gira come l'utente del componente, con le sue capability (nessuna), i suoi volumi, le sue reti e i suoi limiti di memoria e di processore, e niente di più. Non ha un terminale e non riceve input.

Il comando parte direttamente, non attraverso una shell. Nel suo ambiente c'è in più una variabile, `HP_TASK_RUN`, con l'id dell'esecuzione: è il **segno** che serve a ritrovare i suoi processi.

### A4 — Limite di tempo, e che cosa non resta

Un'esecuzione finisce da sola oppure allo scadere del suo limite di tempo. Alla fine, in tutti e due i casi, l'esecutore lancia nel container uno **script di pulizia** che uccide i processi con il segno di quell'esecuzione e tutti i processi delle loro sessioni di sistema, compresi quelli lasciati in fondo. Lo script usa solo comandi interni della shell e i file di `/proc`, perché l'immagine di un'applicazione può non avere `ps` o `pkill`; gira come l'utente del componente e non tocca mai il processo 1 né i processi del componente, che non portano il segno.

Lo script ha bisogno di `/bin/sh` nell'immagine. Per questo l'esecutore **lo prova prima** di lanciare il comando: se non riesce, l'attività non parte e l'esecuzione lo dice («questo componente non può eseguire attività»). Un comando che il pannello non saprebbe fermare non viene lanciato.

All'avvio l'esecutore fa la stessa pulizia, per qualunque esecuzione, in ogni container di componente in esecuzione, anche in quelli dove il motore non elenca più comandi aperti (il motore toglie un comando dall'elenco quando il comando finisce, e ciò che ha lasciato in fondo resta): un'attività rimasta da una vita precedente dell'esecutore non sopravvive al suo riavvio.

### A5 — L'esecutore controlla, non si fida

L'API manda all'esecutore l'applicazione, l'organizzazione, la chiave del componente, l'id dell'esecuzione, gli argomenti e il limite di tempo: mai un nome o un id di container. L'esecutore:

- ricava da sé il nome del container e rifiuta se le sue etichette non dicono che è gestito dal pannello, di quell'applicazione, di quell'organizzazione, con il ruolo di componente e con quella chiave. È lo stesso controllo della lettura dei log;
- rifiuta se il container non è in esecuzione;
- ricontrolla gli argomenti con la stessa regola del validatore (limiti, niente shell, niente segnaposto) e il limite di tempo;
- esegue **una sola attività alla volta per applicazione**;
- ricorda in memoria le ultime esecuzioni per id: una seconda chiamata con lo stesso id non lancia il comando un'altra volta, e l'API può chiedere com'è finita un'esecuzione di cui ha perso la risposta;
- non restituisce mai un id di Docker.

Le due chiamate (esegui, leggi l'esito) sono nuove e stanno in un'interfaccia opzionale accanto a quella delle applicazioni. Con un esecutore che non le offre, la richiesta di lanciare un'attività è rifiutata (`422 NOT_SUPPORTED`) prima di mettere in coda qualcosa, e la passata dei programmi non mette in coda niente: l'orario resta dovuto e, finita la sua finestra, è scritto come saltato (`missed`).

### A6 — Un'esecuzione è lavoro in coda dell'applicazione

Lanciare un'attività crea un'operazione di tipo nuovo, `stack.task`. Per ogni applicazione **una sola esecuzione alla volta aspetta o gira**: la richiesta è rifiutata con `409` se un'altra esecuzione dell'applicazione è in coda o in corso, se l'applicazione è occupata, ferma o mai installata. Un'esecuzione **in coda** non tiene l'applicazione: aspetta con un blocco suo (`stack:<id>:task`), e nel frattempo l'applicazione può essere fermata, aggiornata o eliminata. Un'esecuzione prende il **blocco dell'applicazione** solo quando parte: da lì finché non è chiusa l'applicazione non può essere cambiata. Se quando tocca a lei l'applicazione è occupata o ferma, l'esecuzione non parte (`not_started`, motivo «occupata» o «componente fermo»); un orario programmato in quel caso torna dovuto e viene riprovato dentro i suoi 30 minuti (A7). Lo stato dell'applicazione non cambia per un'attività.

Le attività hanno una **corsia propria** nel lavoratore della coda: un'attività lunga non ferma l'installazione di un'altra applicazione, e viceversa.

Il comando che parte è quello della versione del modello **installata** in quel momento, letto quando l'esecuzione comincia. Nell'operazione e nella coda ci sono solo l'applicazione e l'id dell'esecuzione.

L'operazione riesce solo se il comando finisce con codice 0. Se la risposta dell'esecutore va persa (l'API o l'esecutore si riavviano a metà), l'API chiede una volta all'esecutore com'è finita; se l'esecutore non lo sa, l'esecuzione resta con **esito non noto** e **non viene mai rilanciata da sola**. L'operazione si chiude comunque, così il blocco dell'applicazione si libera: un'attività dall'esito non noto non lascia l'applicazione in uno stato da riparare.

### A7 — Quando

Per ogni attività il cliente sceglie tra: **mai** (solo a mano), **ogni ora**, **ogni giorno** a un'ora, **ogni settimana** in un giorno e a un'ora. Le ore sono intere e in UTC, come quelle dei backup; la pagina le mostra anche nel fuso di chi guarda. Non c'è un'espressione cron.

Una passata dell'API, ogni minuto, mette in coda ciò che è in programma:

- ogni orario parte **al massimo una volta**: l'orario servito è scritto nella stessa transazione che crea l'operazione;
- se in quel momento l'applicazione è occupata, la passata riprova per **30 minuti**; poi l'orario è saltato. Lo stesso vale per un orario già in coda la cui esecuzione, quando è toccato a lei, ha trovato l'applicazione occupata o ferma: l'orario torna dovuto. Un orario saltato (applicazione occupata, ferma, API spenta in quel momento) è scritto sulla riga del programma con il motivo, non come un'esecuzione, e non viene recuperato dopo;
- un programma di un'attività che la versione installata non ha più resta fermo e torna a valere se una versione successiva, o un ritorno indietro, riporta quell'attività.

### A8 — Che cosa resta di un'esecuzione

Di ogni esecuzione restano: l'attività, il componente, chi l'ha chiesta (una persona o il programma), l'inizio, la fine, l'esito (`succeeded`, `failed`, `timed_out`, `not_started`, `unknown`), il codice di uscita e le **ultime righe stampate**: al massimo 16 KiB e 200 righe, senza caratteri di controllo, con i valori dei segreti del componente mascherati come nei log.

Le righe stampate stanno **solo** nella riga dell'esecuzione: mai nell'audit, nell'operazione, nella coda o in un log dell'API, del web o dell'esecutore. Per ogni attività restano le ultime 20 esecuzioni.

Due righe di audit, solo per ciò che fa una persona: `app.task.run` (chi ha lanciato quale attività) e `app.task.schedule` (chi ha cambiato quale programma, e come). Un'esecuzione partita dal programma non ha una riga di audit: la sua traccia è l'esecuzione stessa.

### A9 — Chi

- Chi ha `app.read` sull'organizzazione vede le attività, i programmi e le esecuzioni.
- Chi ha `app.control` lancia un'attività e cambia un programma.
- Nessuna chiave di permesso nuova. Una visita di assistenza continua a non dare niente sulle applicazioni.
- L'amministratore del server scrive le attività nel modello; non ha una pagina sulle esecuzioni dei clienti.

### A10 — Pagine

Nella pagina di un'applicazione il cliente trova la scheda **Attività programmate**, solo se il modello installato ne dichiara. Per ogni attività: il nome e la descrizione, quando parte da sola, com'è andata l'ultima volta, il pulsante **Esegui ora**, il programma da scegliere e le ultime esecuzioni con le righe stampate.

Italiano e inglese, senza parole da server: mai «container», «comando», «codice di uscita» o il testo del comando. La pagina non mostra mai gli argomenti di un'attività.

### A11 — Release precedente e ritorno indietro

La migrazione `0031` è additiva (due tabelle nuove) e la release precedente continua a funzionare sul database migrato finché nessun modello dichiara attività.

Una voce nuova, `app-tasks`, tra le funzioni di una release. `hp-update` rifiuta di tornare a una release che non la dichiara finché esiste una versione di modello con attività, a meno di forzare: una release più vecchia rifiuterebbe quel modello a ogni nuova installazione (per lei `x-hp-tasks` è una chiave sconosciuta), non ha la passata dei programmi e non sa eseguire un'operazione `stack.task`.

### A12 — Fuori ambito

Ciascuno è un lavoro successivo, con la sua issue: un comando scritto da un cliente, o da un amministratore per una sola applicazione; un programma scritto come espressione cron o con i minuti; fermare a mano un'esecuzione; un avviso quando un'esecuzione fallisce; attività nei modelli incorporati e nel catalogo; attività per i siti WordPress del prodotto classico, che hanno i loro strumenti; una scheda per l'amministratore.

### Alternative scartate

- **Un comando scritto dal cliente**, come nei pannelli per sviluppatori. Il cliente di questo pannello non è tecnico, e un comando libero dentro un container è una shell con un altro nome (`ADR-0041` la dà solo all'amministratore, dietro un codice).
- **Un container nuovo per ogni esecuzione**, con l'immagine e i volumi del componente. Sarebbe più pulito alla fine (basta eliminarlo), ma monterebbe volumi scrivibili in due container insieme, raddoppierebbe la memoria, e l'attività non vedrebbe i processi né i file temporanei del componente, che è quello che molte attività devono toccare.
- **Segnaposto nel comando di un'attività**, come nel comando di un componente. Un valore del cliente finirebbe negli argomenti di un comando lanciato più tardi, in un punto che il piano approvato non copre.
- **Le attività dentro il piano dell'applicazione.** Cambierebbero l'impronta di ogni piano e ogni modifica di un'attività chiederebbe una nuova installazione.
- **La corsia delle applicazioni anche per le attività.** Un'attività di dieci minuti fermerebbe ogni altra installazione sul server.
- **Un'espressione cron.** Non è una scelta che un cliente non tecnico sa leggere, e apre orari ogni minuto che il pannello non vuole servire.
- **Rilanciare un'esecuzione dall'esito non noto.** Un comando non è detto che si possa ripetere senza danno.

## 3. Conseguenze

- **Un'attività che gira tiene occupata la sua applicazione**: per al massimo dieci minuti (il limite di tempo) il cliente non può fermarla o aggiornarla. Un'attività **in coda** non la tiene: la corsia delle attività è una per tutto il server, e un'esecuzione può aspettare a lungo dietro quelle di altre applicazioni; in quel tempo l'applicazione si ferma, si aggiorna e si elimina come sempre, e l'esecuzione, se l'applicazione è occupata o ferma quando tocca a lei, non parte.
- **Un componente senza `/bin/sh` non può eseguire attività.** Lo si scopre alla prima esecuzione, non quando si salva il modello.
- **Il mascheramento copre i valori dei segreti così come sono.** Un comando che stampa un segreto trasformato (in base64, a pezzi) lo mostra a chi ha `app.read` su quell'applicazione. Il comando lo scrive l'amministratore.
- **Un processo che toglie il segno dal proprio ambiente e lascia la sessione sopravvive alla pulizia** finché l'applicazione non viene riavviata. Resta dentro i limiti del componente.
- **Gli orari sono in UTC e a ore intere.** Più attività della stessa applicazione alla stessa ora non partono insieme: una sola alla volta aspetta o gira, le altre sono rifiutate come «occupata» e riprovate a ogni passata, e un orario che non riesce a partire entro 30 minuti è saltato (`busy`). Quattro attività di dieci minuti alle 03:00: la prima parte alle 03:00, la seconda verso le 03:11, la terza verso le 03:21, la quarta è saltata alle 03:30.
- **Chi scrive un modello decide che cosa può essere lanciato** in ogni applicazione che lo usa, anche in quelle già installate, quando vengono aggiornate a quella versione.

## 4. Come è stato costruito

Le scelte qui sotto sono state prese dall'agente durante la costruzione, dentro le decisioni A1–A12. Aspettano la stessa approvazione.

**Formato (`packages/contracts`, `packages/policy-engine`).**

- Il comando di un'attività usa la stessa grammatica del `$` di un comando di componente: `$$` è un dollaro, qualunque `${NOME}` è rifiutato (`TASK_COMMAND_PLACEHOLDER`), un `$` da solo è un errore di sintassi. Nel modello compilato gli argomenti sono scritti **come vengono eseguiti** (dopo `$$` → `$`).
- `tasks` è facoltativo e, quando c'è, ha almeno un elemento: un modello senza la chiave, o con `x-hp-tasks: []`, dà lo stesso modello compilato di prima, byte per byte, e lo stesso piano. Le attività non sono nel piano né nella sua impronta.
- Le attività restano nell'ordine del sorgente. `service` deve essere un componente dichiarato. Dentro un'attività sono rifiutate per nome `user`, `privileged`, `cap_add`, `group_add` (sicurezza) e `schedule`, `cron`, `environment`, `working_dir`, `entrypoint`, `shell`, `tty`, `stdin_open` (non previste).
- Una sola regola sugli argomenti, `appStackTaskArgvProblem`, usata dal validatore, dall'API e dall'esecutore. Come per il comando di un componente, **nessun argomento** può avere il nome di una shell o di un programma che ne lancia una (`sh`, `bash`, `busybox`, `env`, …: conta il nome dopo l'ultima `/`).

**Database (`packages/database`, migrazione `0031`).**

- Nessuna riga in `app_stack_task_schedules` vuol dire «mai»: scegliere «mai» cancella la riga. Una programmazione cambiata riparte pulita: nessun orario precedente al cambio è dovuto.
- Un'esecuzione è una riga di `app_stack_task_runs` e un'operazione `stack.task`, scritte nella stessa transazione. L'operazione aspetta con il blocco `stack:<id>:task` (una sola esecuzione in coda o in corso per applicazione) e, quando parte, in una sola transazione con la riga dell'applicazione bloccata, lo cambia nel blocco dell'applicazione `stack:<id>` e passa l'esecuzione a `running`; se in quel momento un'altra operazione dell'applicazione è in coda o in corso, o l'applicazione non è `running` o `degraded`, non scrive niente e l'esecuzione non parte. `stack.task` è un tipo di operazione ma **non** uno dei tipi che cambiano l'applicazione: nessuna riga di installazione, nessuna revisione, stato invariato. Si può chiedere solo mentre l'applicazione è `running` o `degraded` e non ha altre operazioni in coda o in corso; mentre un'esecuzione **gira**, una modifica dell'applicazione è rifiutata (`409`).
- Un'esecuzione programmata che non può partire restituisce il suo orario: la riga del programma torna a doverlo, con il motivo (`busy` o `not_running`), e l'esecuzione, che non è partita, viene cancellata (un orario saltato non è un'esecuzione). La passata la rimette in coda dentro i 30 minuti; un orario partito non torna mai indietro.
- Le applicazioni si cancellano scrivendo `deleted_at` (la riga resta): un trigger toglie le loro programmazioni e le loro esecuzioni. Le operazioni restano.
- Per ogni attività restano le ultime 20 esecuzioni. Un'esecuzione che **non è partita** non ha un'ora di inizio, anche se era già stata inviata all'esecutore.
- Un'esecuzione rimasta `queued` o `running` con l'operazione già chiusa (il pannello si è fermato fra le due scritture) viene chiusa dalla passata della programmazione: la prima come non partita, la seconda come esito non noto. Nessuna delle due viene rilanciata.

**Esecutore (`packages/executor-contracts`, `apps/docker-executor`).**

- Una porta facoltativa a parte, `StackTaskExecutorPort`, con due chiamate: `runAppStackTask` e `getAppStackTaskRun`. Sull'IPC: `POST /v1/app-stacks/tasks/run` e `GET /v1/app-stacks/<stackId>/task-runs/<runId>`; la lettura è un `GET` perché non può mai essere una chiamata dall'esito ambiguo. Un esecutore senza la porta risponde `422 NOT_SUPPORTED`. Il client aspetta la risposta per il limite di tempo dell'attività più 120 secondi.
- Il codice sta in file nuovi (`app-stacks/tasks.ts`, `app-stacks/task-ipc.ts`, `simulator-app-stack-tasks.ts`), non nel motore delle applicazioni.
- L'ordine di un'esecuzione: richiesta ricontrollata con lo schema; esecuzione già vista (stessa risposta di prima, mai un secondo avvio); una sola per applicazione; container cercato per il nome che l'esecutore deriva, con etichette, nome e stato ricontrollati; da lì in poi il container è indicato con l'id letto in quel controllo, mai restituito; pulizia provata **prima** del comando (se non riesce, il comando non parte); comando avviato con il solo segno `HP_TASK_RUN=<id>` nell'ambiente; ultime righe raccolte fino alla fine o al limite; pulizia per quell'esecuzione; lettura del codice di uscita.
- L'ingresso standard viene aperto e chiuso subito (è la strada già usata dagli altri comandi dell'esecutore): il comando legge «fine dell'input».
- Se l'avvio del comando fallisce e non si può dire se il processo è partito, l'esecutore lo tratta come **forse partito**: fa la pulizia e risponde `failed` senza codice di uscita.
- L'esecutore aspetta la fine dell'uscita del comando, non interroga il processo. Su Docker reale l'uscita finisce quando finisce il comando, anche se ha lasciato un processo fuori dalla sua sessione: l'esito è quello del comando e la pulizia chiude subito ciò che è rimasto. Se l'uscita restasse aperta, l'esecuzione finirebbe al limite di tempo come `timed_out`.
- Quando il motore non riesce ad avviare il programma (non è nell'immagine, codice 127; non è eseguibile, codice 126) scrive un suo messaggio che nomina il programma. L'esecutore non lo restituisce come uscita dell'esecuzione: resta il codice di uscita, nella riga.
- Di ciò che il comando stampa l'esecutore tiene gli ultimi 64 KiB mentre gira; poi maschera i segreti del componente e taglia a 200 righe e 16 KiB. Una riga spezzata dal taglio iniziale viene tolta.
- L'esecutore ricorda le ultime 200 esecuzioni finite, in memoria. Dopo un suo riavvio non ne conosce nessuna.
- Se la pulizia dopo un'esecuzione fallisce viene ritentata 5 volte a 5 secondi di distanza; poi l'esecutore scrive nel suo registro `app_task_cleanup_failed` con un codice e nient'altro. La pulizia all'inizio dell'esecuzione successiva e quella all'avvio dell'esecutore sono le altre due reti.
- All'avvio l'esecutore fa la pulizia in ogni componente in esecuzione, con o senza comandi aperti (`app_task_reap_failed` se non riesce). Un componente senza shell non ha mai eseguito attività e non è un errore.

**API (`apps/api`).**

- Quattro rotte sotto l'applicazione (in `docs/api/openapi.yaml`): elenco delle attività, ultime esecuzioni di una, «esegui ora» (`202`, con `Idempotency-Key`, corpo vuoto), programmazione (`PUT`). La risposta al cliente non ha il codice di uscita: resta nella riga, per chi amministra.
- Le attività si leggono dal **sorgente** della versione del modello della revisione installata, ricontrollato con le regole di oggi: una versione che oggi non passerebbe i controlli non ha attività, e niente di suo viene eseguito. Così fanno l'elenco, la richiesta, il lavoratore e la programmazione.
- Una corsia a parte nel lavoratore: le attività del server girano una dopo l'altra, senza fermare installazioni, backup o lavori dei siti. Un'esecuzione che aspetta il suo turno non tiene la sua applicazione; il riquadro di avanzamento della pagina la mostra comunque, se nessun'altra operazione dell'applicazione è in corso.
- L'operazione tiene il suo blocco per il limite di tempo più 180 secondi. Se la risposta dell'esecutore si perde, l'operazione resta `unknown` e a ogni passata di recupero il pannello **legge** dall'esecutore: finita → esito scritto; ancora in corso → si aspetta, e l'applicazione resta ferma; non conosciuta → esito non noto, operazione chiusa come fallita, niente rilancio.
- Un rifiuto certo dell'esecutore chiude l'esecuzione come non partita, con il motivo: componente fermo, il server non poteva (motore non raggiungibile, un'altra attività già in corso, esecutore senza la porta), rifiutata (etichette o richiesta non valide). Un'esecuzione che trova l'applicazione occupata quando tocca a lei si chiude come non partita con il motivo `busy` (una programmata restituisce invece il suo orario); una che la trova ferma, con `component_not_running`.
- Mentre un'attività è in coda o in corso l'aggiornamento del pannello, l'aggiornamento del sistema e il riavvio dell'esecutore dall'amministrazione aspettano, come per i backup: `stack.task` è fra i lavori che li bloccano.
- La passata della programmazione gira ogni minuto, senza variabile d'ambiente e senza una passata all'avvio. A ogni passata conta solo l'orario più recente di ogni programmazione.
- Dopo un ritorno automatico alla release precedente, il lavoratore vecchio chiude come fallita un'operazione di un tipo che non conosce: il suo blocco si libera. La riga dell'esecuzione viene sistemata alla passata successiva della release nuova.

**Pagine (`apps/web`).**

- La sezione «Attività programmate» compare, dopo i registri, solo se la versione installata ha attività. Mostra il nome, la descrizione, quando parte da sola (ora UTC e ora locale), l'ultimo orario non eseguito e il perché, con parole diverse finché è ancora riprovato («in attesa») e dopo che è stato saltato, l'esito dell'ultima esecuzione; «Esegui ora»; la scelta della programmazione; le ultime esecuzioni con ciò che hanno stampato. Non mostra il componente, il comando o il codice di uscita.
- Un'attività in coda o in corso compare nel riquadro di avanzamento della pagina con parole sue, e alla fine la pagina si aggiorna.

**Aggiornamenti (`infra`).** La funzione di rilascio `app-tasks`: `hp-update` rifiuta di tornare a una release che non la conosce mentre esiste una versione di modello con attività. Le versioni dei modelli non si cancellano, quindi da lì si torna indietro solo con `--allow-feature-loss`.

## 5. Che cosa è provato

**Prove automatiche** (tutte verdi su questo ramo; i file nominati nella regola di `HARNESS.md` esistono):

- *Formato*: `packages/policy-engine/test/app-template-tasks.test.ts` (ogni rifiuto con il suo codice; un modello senza attività dà lo stesso modello compilato e lo stesso piano) e `packages/contracts/test/app-stack-tasks.test.ts` (schemi, orari, limiti dell'uscita).
- *Database*: `packages/database/test/app-stack-tasks-database.test.ts` (105 casi: vincoli, trigger alla cancellazione, un orario al più una volta, rifiuto mentre l'applicazione è occupata o ferma, chiusura delle esecuzioni rimaste a metà) e `rollback-compat.test.ts` (la release precedente lavora sul database migrato).
- *Esecutore*: `apps/docker-executor/test/app-stack-tasks.test.ts` (34 casi contro un motore finto: richiesta esatta inviata a Docker, senza utente, cartella e terminale; etichette sbagliate, componente fermo o mancante; nessuna shell → non parte; limite di tempo; codici di uscita; mascheramento e limiti dell'uscita; una per applicazione; mai due volte; lettura solo per quell'applicazione e quel cliente; pulizia ritentata; pulizia all'avvio; rotte IPC firmate; simulatore) e `packages/executor-contracts/test/stack-task-port.test.ts`.
- *API*: `apps/api/test/app-stack-tasks.integration.test.ts` (12 casi su HTTP, lavoratore e programmazione con l'esecutore simulato: permessi, altro cliente, nessun comando accettato, comando letto dal modello, stato dell'applicazione invariato, uscita solo nella riga dell'esecuzione, orario in coda una volta sola, risposte perse mai rilanciate, cancellazione) e `apps/api/test/app-stack-task-runtime.unit.test.ts` (7 casi sul lavoratore con un esecutore a copione). La corsia a parte e il recupero sono in `app-stack-lane.unit.test.ts`.
- *Pagine*: `apps/web/test/app-stacks-detail.test.ts` (la sezione, le parole, «Esegui ora», la programmazione, le ultime esecuzioni, il riquadro di avanzamento), `app-stacks-bff.test.ts` (le tre rotte: sessione, CSRF, corpo rifiutato prima dell'API) e `m6-web-qa-guards.test.ts` (inventario delle rotte).
- *Aggiornamenti*: `infra/linux/features-gate.test.ts`, `infra/linux/update.test.ts` e `infra/release/release-manifest.test.ts`; la domanda che `hp-update` fa al database è eseguita sullo schema migrato nel test di integrazione dell'API.

**Docker reale** (`infra/linux/accept-app-tasks.mjs`, eseguito il 2026-11-23 su Docker Engine 29.10.0): `RESULT 17/17 passed, 1 skipped`. Due applicazioni di un cliente e una di un altro, dal modello integrato «Lavoro periodico con archivio» (immagine Alpine, shell busybox); l'adattatore di produzione dietro un cancello che nega tutto ciò che non è di quella prova; nessuna immagine scaricata, nessuna rete «edge» creata, tutto rimosso alla fine, le reti del proxy del pannello vivo uguali prima e dopo. Ha mostrato che:

- il comando gira con lo stesso utente, gli stessi gruppi e la stessa cartella del componente, e vede il segno della propria esecuzione; il componente non viene riavviato;
- una shell come comando è rifiutata prima di qualunque richiesta a Docker;
- il codice di uscita e l'uscita tornano come sono; un programma che non c'è nell'immagine dà `failed` con codice 127 e nessuna uscita;
- al limite di tempo (5 secondi) la risposta arriva dopo 5,2 secondi e nel componente non resta il comando; lo stesso per un comando lanciato da un altro programma (`timeout … sleep`) e per uno che lascia la sessione (`setsid sleep`): in quel caso l'esecuzione finisce come il comando e il processo rimasto viene chiuso subito;
- una seconda attività nella stessa applicazione è rifiutata mentre la prima gira, un'altra applicazione no; la stessa esecuzione chiesta due volte non manda un secondo comando; un altro cliente legge «non conosciuta»;
- sei container messi sotto il nome di un componente con etichette sbagliate sono rifiutati prima di qualunque comando, come il cliente sbagliato, il componente fermo e l'applicazione che non esiste;
- un esecutore chiuso con `SIGKILL` lascia il comando in esecuzione; la pulizia all'avvio dell'esecutore successivo lo chiude, senza riavviare componenti e senza toccare quelli che non avevano comandi aperti (prova del 2026-11-23: da allora la pulizia all'avvio passa in ogni componente in esecuzione, e il passo della prova è stato riscritto così, ma non ancora rieseguito);
- il cancello ha visto solo le due forme previste (il comando con il suo segno, la pulizia) e non ha negato nulla.

**Controllo complessivo**: build, lint, controllo dei tipi e i test collegati alla modifica passano in locale; il controllo completo è quello della CI sulla PR.

## 6. Non provato

- **Su un pannello installato.** I flag delle applicazioni sono `false` su `main`: le rotte e la sezione rispondono solo nei test, che li accendono.
- **Le pagine in un browser.** Sono coperte dai test delle pagine, non viste da una persona.
- **Un componente senza `/bin/sh` su Docker reale.** Ogni immagine ammessa in questo ramo ha una shell: il passo è saltato. Il comportamento atteso (codice 126 o 127 dalla pulizia, con il messaggio del motore «OCI runtime exec failed» → l'attività non parte; lo stesso codice senza quel messaggio è una pulizia non riuscita, non «senza shell») è provato solo contro il motore finto.
- **Lo script di pulizia in una shell diversa da quella di busybox** (dash, bash): usa solo comandi interni e `/proc`, ma su Docker reale è stato eseguito solo nell'immagine Alpine.
- **Il mascheramento dei segreti su Docker reale**: il modello usato non ha segreti. È provato contro il motore finto e nel simulatore.
- **La programmazione attraverso un'ora vera** e il limite di 600 secondi: i test muovono l'orologio.
- **Un ritorno alla release precedente con un'esecuzione in coda**: il comportamento del lavoratore vecchio è stato letto nel codice, non eseguito con una release precedente vera.
- **Più attività lunghe di applicazioni diverse insieme**: la corsia è una; non è stata misurata l'attesa.

## 7. Punti aperti

- **Le decisioni A1–A12 e quelle del §4 sono dell'agente.** Nessun proprietario le ha approvate.
- **Niente di questo è raggiungibile su un pannello installato**, finché `applicationStacksAvailable` resta `false` (lo accende la PR #43 per il backend `linux-systemd`).
- **La corsia delle attività è una per tutto il server.** Un'attività di dieci minuti ritarda le attività delle altre applicazioni; non le installazioni, e chi aspetta non tiene la propria applicazione. Un'esecuzione programmata già in coda parte quando arriva il suo turno, anche più di 30 minuti dopo il suo orario. Il lavoratore non esegue in parallelo le attività di applicazioni diverse.
- **Un processo che toglie il segno dal proprio ambiente e lascia la sessione sfugge alla pulizia**, fino al riavvio dell'applicazione. Resta nei limiti del componente.
- **Un'immagine che avesse già `HP_TASK_RUN=srun_…` nel proprio ambiente** vedrebbe i propri processi (non il primo) chiusi dalla pulizia. Un modello non può scriverlo (i nomi che cominciano con `HP_` sono riservati); le immagini ammesse le sceglie l'amministratore, e l'effetto resterebbe dentro quell'applicazione.
- **La regola sulla shell guarda i nomi degli argomenti.** Un programma che al suo interno lancia una shell (uno script con la sua prima riga, un programma che esegue altri programmi) non viene riconosciuto, come oggi nel comando di un componente. Il modello lo scrive l'amministratore.
- **Finché l'esecutore non è raggiungibile, un'esecuzione dalla risposta persa tiene ferma la sua applicazione.** Si sblocca quando l'esecutore risponde (se è ripartito: esito non noto).
- **Nessun avviso quando un'attività fallisce** (A12): si vede nella pagina. Le notifiche della PR #72 non conoscono le attività.
- **Nessuna attività nei modelli integrati e nel catalogo** (A12): oggi un'attività esiste solo in un modello scritto da un amministratore.
- **Questa PR e le PR #43, #54, #57, #67, #72 e #74 toccano le stesse righe** di alcuni file (`HARNESS.md`, `README.md`, il diagramma, il runbook, `openapi.yaml`, i messaggi, il lavoratore, l'adattatore dell'esecutore): chi entra dopo deve unire `main` e tenere entrambe le parti. La migrazione è la `0031`; i numeri da `0026` a `0030` sono sulle altre.
