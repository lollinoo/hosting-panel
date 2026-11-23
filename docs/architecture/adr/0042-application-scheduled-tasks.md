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

All'avvio l'esecutore fa la stessa pulizia, per qualunque esecuzione, in ogni container di applicazione in esecuzione che ha ancora un comando aperto: un'attività rimasta da una vita precedente dell'esecutore non sopravvive al suo riavvio.

### A5 — L'esecutore controlla, non si fida

L'API manda all'esecutore l'applicazione, l'organizzazione, la chiave del componente, l'id dell'esecuzione, gli argomenti e il limite di tempo: mai un nome o un id di container. L'esecutore:

- ricava da sé il nome del container e rifiuta se le sue etichette non dicono che è gestito dal pannello, di quell'applicazione, di quell'organizzazione, con il ruolo di componente e con quella chiave. È lo stesso controllo della lettura dei log;
- rifiuta se il container non è in esecuzione;
- ricontrolla gli argomenti con la stessa regola del validatore (limiti, niente shell, niente segnaposto) e il limite di tempo;
- esegue **una sola attività alla volta per applicazione**;
- ricorda in memoria le ultime esecuzioni per id: una seconda chiamata con lo stesso id non lancia il comando un'altra volta, e l'API può chiedere com'è finita un'esecuzione di cui ha perso la risposta;
- non restituisce mai un id di Docker.

Le due chiamate (esegui, leggi l'esito) sono nuove e stanno in un'interfaccia opzionale accanto a quella delle applicazioni. Con un esecutore che non le offre, la richiesta di lanciare un'attività è rifiutata (`422`).

### A6 — Un'esecuzione è lavoro in coda dell'applicazione

Lanciare un'attività crea un'operazione di tipo nuovo, `stack.task`, **sotto il blocco dell'applicazione**: mentre un'attività è in coda o gira, l'applicazione non può essere fermata, aggiornata o eliminata, e non parte un'altra attività; mentre l'applicazione viene cambiata, nessuna attività parte. La richiesta è rifiutata con `409` se l'applicazione è occupata, ferma o mai installata. Lo stato dell'applicazione non cambia per un'attività.

Le attività hanno una **corsia propria** nel lavoratore della coda: un'attività lunga non ferma l'installazione di un'altra applicazione, e viceversa.

Il comando che parte è quello della versione del modello **installata** in quel momento, letto quando l'esecuzione comincia. Nell'operazione e nella coda ci sono solo l'applicazione e l'id dell'esecuzione.

L'operazione riesce solo se il comando finisce con codice 0. Se la risposta dell'esecutore va persa (l'API o l'esecutore si riavviano a metà), l'API chiede una volta all'esecutore com'è finita; se l'esecutore non lo sa, l'esecuzione resta con **esito non noto** e **non viene mai rilanciata da sola**. L'operazione si chiude comunque, così il blocco dell'applicazione si libera: un'attività dall'esito non noto non lascia l'applicazione in uno stato da riparare.

### A7 — Quando

Per ogni attività il cliente sceglie tra: **mai** (solo a mano), **ogni ora**, **ogni giorno** a un'ora, **ogni settimana** in un giorno e a un'ora. Le ore sono intere e in UTC, come quelle dei backup; la pagina le mostra anche nel fuso di chi guarda. Non c'è un'espressione cron.

Una passata dell'API, ogni minuto, mette in coda ciò che è in programma:

- ogni orario parte **al massimo una volta**: l'orario servito è scritto nella stessa transazione che crea l'operazione;
- se in quel momento l'applicazione è occupata, la passata riprova per **30 minuti**; poi l'orario è saltato. Un orario saltato (applicazione occupata, ferma, API spenta in quel momento) è scritto sulla riga del programma con il motivo, non come un'esecuzione, e non viene recuperato dopo;
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

Una voce nuova, `app-tasks`, tra le funzioni di una release. `hp-update` rifiuta di tornare a una release che non la dichiara finché esiste una versione di modello con attività, a meno di forzare: una release più vecchia rifiuterebbe quel modello a ogni nuova installazione (per lei `x-hp-tasks` è una chiave sconosciuta), non ha la passata dei programmi e non sa eseguire un'operazione `stack.task`, che resterebbe in coda tenendo il blocco dell'applicazione.

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

- **Un'attività lunga tiene occupata la sua applicazione**: per al massimo dieci minuti il cliente non può fermarla o aggiornarla. È il motivo del limite di tempo.
- **Un componente senza `/bin/sh` non può eseguire attività.** Lo si scopre alla prima esecuzione, non quando si salva il modello.
- **Il mascheramento copre i valori dei segreti così come sono.** Un comando che stampa un segreto trasformato (in base64, a pezzi) lo mostra a chi ha `app.read` su quell'applicazione. Il comando lo scrive l'amministratore.
- **Un processo che toglie il segno dal proprio ambiente e lascia la sessione sopravvive alla pulizia** finché l'applicazione non viene riavviata. Resta dentro i limiti del componente.
- **Gli orari sono in UTC e a ore intere**, e due attività della stessa applicazione alla stessa ora partono una dopo l'altra.
- **Chi scrive un modello decide che cosa può essere lanciato** in ogni applicazione che lo usa, anche in quelle già installate, quando vengono aggiornate a quella versione.
