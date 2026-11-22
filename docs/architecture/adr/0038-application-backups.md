# ADR 0038 — Backup e Ripristino delle Applicazioni

- **Stato:** `PROPOSTO` — scelte K1–K12 prese dall'agente su direttiva del proprietario del 2026-11-22 («vorrei funzionasse come funziona Coolify»); in attesa di approvazione
- **Data:** 2026-11-23
- **Riferimento:** `ADR-0035` (stack applicativi: questo ADR sostituisce la decisione D6 e la frase sul backup del §2.11), `ADR-0022` (backup dei siti), `ADR-0032` (destinazioni di backup); issue #56, PR #57
- **Migrazioni:** `0027` (additiva; file `packages/database/migrations/0027_app_stack_backups.sql`)

Questo ADR dà a ogni applicazione installata da un modello un backup dei suoi dati e il ripristino nella stessa applicazione. Il backup usa le destinazioni che il server ha già per i siti, lo stesso programma (`restic`) e la stessa chiave. I backup dei siti e del pannello non cambiano.

## 1. Contesto

Con `ADR-0035` un'applicazione tiene i dati in volumi Docker con nome (`hp_appvol_<stackId>_<volumeKey>`). La decisione D6 ha lasciato il backup fuori: la route `POST …/app-stacks/:stackId/backups` esiste solo per rispondere `422 NOT_SUPPORTED` e la pagina dell'applicazione dice che il backup non è disponibile. Un cliente che installa un'applicazione oggi non ha modo di salvarne i dati dal pannello.

I siti hanno già tutto il necessario (`ADR-0022`, `ADR-0032`): destinazioni S3 e locale, fino a due copie per backup, lavori `restic` avviati dall'esecutore in container usa-e-getta, regole di conservazione. Quel codice però conosce la forma di un sito: un volume di file con un proprietario noto (`33:33`) e un database nel MariaDB condiviso. Un'applicazione ha un numero qualsiasi di volumi, con file di proprietari qualsiasi (un database scrive come `999`, un server web come `101`), e nessun database condiviso.

I vincoli sono quelli di `HARNESS.md` e di `ADR-0035`:

- Solo `hp-docker-executor` parla con Docker. L'API non sceglie percorsi né repository.
- La chiave di backup, i segreti S3 e i segreti dell'applicazione non compaiono in DTO, righe di audit, righe dell'outbox, operazioni, log o variabili d'ambiente di un container.
- Un `POST` verso l'esecutore non si ripete mai alla cieca dopo un esito incerto.
- Nessuna dipendenza npm, programma dell'host o variabile d'ambiente nuova. Nulla è copiato da altri pannelli.

## 2. Decisioni

### K1 — Che cosa contiene un backup

Un backup contiene tutti i volumi di dati dell'applicazione, in un solo snapshot per copia. Ogni volume è montato in sola lettura in `/data/<volumeKey>` e `restic` salva `/data`. Non contiene immagini, configurazione, indirizzi web o segreti dell'applicazione: quelli stanno nel database del pannello e nel suo backup. La riga del backup ricorda l'elenco dei volumi (`volume_keys`), fissato al momento della richiesta, e la revisione dell'applicazione. Un'applicazione senza volumi di dati non ha nulla da salvare e la richiesta è rifiutata.

### K2 — L'applicazione è ferma durante la copia

Prima della copia l'applicazione viene fermata, poi riavviata. Copiare i file di un database mentre scrive dà una copia che può non aprirsi; il pannello non sa che cosa gira dentro un'applicazione e non può chiederle un dump. La fermata rende la copia coerente per qualunque applicazione.

Il costo è il fermo: dura quanto la copia, e con due destinazioni le due copie si fanno una dopo l'altra mentre l'applicazione è ferma. Un'applicazione che era già ferma resta ferma.

### K3 — Destinazioni

Il backup va sulle destinazioni utilizzabili del criterio di backup predefinito dei siti (`default_site`), al massimo due, nell'ordine di priorità. In questa versione non c'è una scelta per applicazione. Ogni applicazione ha un repository `restic` proprio per destinazione: `stacks/<stackId>` sotto il prefisso di una destinazione S3, `<radice>/<targetId>/stacks/<stackId>` su quella locale. La chiave è la stessa dei siti. Il tipo di repository dell'esecutore guadagna la variante `stack`, con rami espliciti: le stringhe dei siti e del pannello restano identiche byte per byte.

Senza una destinazione utilizzabile la richiesta è rifiutata subito, con la stessa frase dei siti.

### K4 — Privilegi dei lavori

I file di un volume hanno proprietari qualsiasi e permessi anche chiusi. I container di lavoro girano come utente `0:0` senza alcuna capacità (`CapDrop: ALL`), più le sole capacità che servono:

- copia: `DAC_READ_SEARCH` (leggere file che non sono dell'utente);
- ripristino: `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID` (ricreare proprietari, permessi e bit speciali);
- preparazione del repository e rimozione di snapshot: nessuna.

Il resto è quello dei lavori dei siti: file system in sola lettura, `no-new-privileges`, limiti di memoria e processi, nessuna rete per una destinazione locale e la sola rete dei backup per S3, segreti montati come file. Il repository locale si raggiunge con il gruppo dell'esecutore (`GroupAdd`) e la cartella `2770` con setgid, come per i siti.

I costruttori dei container stanno in un file nuovo (`apps/docker-executor/src/app-stack-backup-jobs.ts`) e chiamano la base comune senza cambiarla. Un container di lavoro non porta mai l'etichetta `io.hostingpanel.stack_id`: il motore degli stack tratterebbe come conflitto qualunque risorsa con quell'etichetta che non sia sua. Porta il ruolo `site_job`, così la pulizia all'avvio dell'esecutore lo rimuove come gli altri lavori.

Prima di una copia o di un ripristino l'esecutore controlla che ogni volume sia dell'applicazione (etichette di stack e organizzazione) e che nessun container dell'applicazione sia in esecuzione. Se uno gira, rifiuta subito.

### K5 — Ripristino

Il ripristino riporta i dati **nella stessa applicazione**. Chi lo chiede riscrive il nome dell'applicazione. I passi:

1. l'applicazione viene fermata;
2. si fa un backup di sicurezza dei dati attuali (tipo `pre_restore`). Se non riesce su almeno una destinazione, nulla viene toccato e l'applicazione riparte;
3. per ogni volume presente sia nel backup sia nell'applicazione di oggi, `restic restore <snapshot>:/data/<volumeKey>` scrive nel volume e cancella ciò che nel backup non c'è (`--delete`);
4. l'applicazione riparte.

La versione dell'applicazione non cambia: tornano i dati, non il software. La copia usata è la prima riuscita, in ordine di priorità, la cui destinazione è ancora configurata. Un volume aggiunto dopo il backup non viene toccato; un volume che non esiste più viene saltato.

Se il ripristino fallisce dopo aver cominciato a scrivere, l'applicazione **resta ferma**: i dati possono essere a metà, il problema è scritto sulla riga e il backup di sicurezza è nell'elenco per tornare indietro.

### K6 — Operazioni

Tre tipi di operazione nuovi: `stack.backup`, `stack.restore` e `stack.prune`. Stanno nella corsia degli stack e prendono lo stesso blocco `stack:<stackId>` di deploy, avvio e arresto: mentre un backup lavora nessun'altra azione parte sull'applicazione.

- **Passi.** Backup: controllo, ritiro degli indirizzi, arresto, copia, chiusura. Ripristino: controllo, ritiro, arresto, copia di sicurezza, ripristino, chiusura. Pulizia: controllo, rimozione, chiusura.
- **Stati.** Un backup non usa `updating`. Da `running`, `degraded` o `failed` l'applicazione passa a `stopping` e poi a `stopped`; da `stopped` resta `stopped`. Da ogni altro stato la richiesta è rifiutata.
- **Riavvio.** L'applicazione non è riavviata dentro l'operazione di backup. Alla chiusura, nella stessa transazione, si accoda una normale operazione di avvio (`stack.start` da `stopped`, `stack.restart` da `degraded`), che passa per il codice di avvio già provato. Vale sia quando il backup riesce sia quando fallisce in modo certo, se l'applicazione non era ferma al momento della richiesta. L'esito dell'operazione di backup è l'esito del backup; un avvio fallito si vede come operazione di avvio fallita.
- **Attese.** Copia e ripristino sono lavori lunghi: l'API li avvia con una chiamata breve e ne legge lo stato a intervalli sotto un lease rinnovato, come per i siti.
- **Esito incerto.** Un timeout dopo la connessione lascia l'operazione `unknown`. Il recupero legge soltanto: lo stato dei container e lo stato dei lavori. Non ripete mai una chiamata che modifica. Un lavoro di cui l'esecutore non sa più nulla è chiuso come interrotto; se era il ripristino ed era già stato avviato, l'applicazione resta ferma.

L'indice unico sul blocco delle operazioni attive impone che l'avvio sia accodato dopo che l'operazione di backup è diventata terminale, nella stessa transazione: `settleOperation` guadagna un passaggio facoltativo eseguito dopo la transizione.

### K7 — Conservazione e cancellazione

La regola è quella dei siti (`selectExpired`): i tre backup manuali riusciti più recenti e i tre backup di sicurezza più recenti restano; i backup buoni più recenti non sono mai rimossi per età; il resto scade dopo i giorni di conservazione del criterio. Un backup riuscito su una sola destinazione (`partial`) conta come buono.

La rimozione ha un solo percorso: l'operazione di sistema `stack.prune`, accodata dal passaggio notturno per ogni applicazione che ha backup. Per ogni destinazione un lavoro toglie gli snapshot scaduti; le righe sono cancellate solo quando gli snapshot sono stati tolti da tutte le destinazioni ancora configurate, altrimenti restano per il passaggio successivo.

I backup di un'applicazione cancellata non spariscono con lei: restano sulle destinazioni finché non superano i giorni di conservazione, poi la stessa pulizia li rimuove. Per questo le righe dei backup non hanno chiave esterna verso l'applicazione.

### K8 — Permessi e limiti

Nessun permesso nuovo. Creare un backup e ripristinare chiedono `app.control`, l'elenco chiede `app.read`: li hanno l'amministratore dell'hosting e il proprietario del cliente. Una visita di assistenza non ha permessi sulle applicazioni e quindi non può fare né l'uno né l'altro.

Un cliente può avviare al massimo sei tra backup e ripristini per applicazione ogni ora; oltre, `QUOTA_EXCEEDED` con l'ora da cui riprovare. Il limite non vale per l'amministratore.

### K9 — Dati

Migrazione additiva `0027` con due tabelle:

- `app_stack_backups`: una riga per backup (tipo `manual` o `pre_restore`; stato `running`, `succeeded`, `partial`, `failed`), con l'operazione, la revisione, l'elenco dei volumi, se l'applicazione va riavviata, la dimensione, il problema e, sulla riga usata come sorgente di un ripristino, l'esito dell'ultimo ripristino;
- `app_stack_backup_copies`: una riga per destinazione, sul modello di `site_backup_copies`.

Lo stato del backup segue le copie: tutte riuscite `succeeded`, almeno una `partial`, nessuna `failed`. Una destinazione con copie di applicazioni non si può cancellare, come per le copie dei siti. `hp-restore-panel` chiude come interrotti i backup e i ripristini rimasti a metà.

### K10 — Downgrade

`hp-update` rifiuta di tornare a una versione che non conosce i backup delle applicazioni finché esiste una riga in `app_stack_backups` (funzione `app-stack-backups`, uscita `8`). Nessun flag di capacità nuovo: il backup è raggiungibile dove le applicazioni sono accese e il backup dei siti è disponibile.

### K11 — API e interfaccia

- `GET /v1/organizations/:orgId/app-stacks/:stackId/backups` (`app.read`): l'elenco.
- `POST …/app-stacks/:stackId/backups` (`app.control`): `202` con l'operazione. Sostituisce la risposta fissa `422`.
- `POST …/app-stacks/:stackId/backups/:backupId/restore` (`app.control`): corpo `{ confirmName }`, `202`.

L'applicazione di un altro cliente risponde `404`. La pagina dell'applicazione ha una sezione «Backup» al posto della riga «non disponibile»: elenco, «Crea backup», «Ripristina» con la conferma del nome, e l'avviso che l'applicazione si ferma per la durata della copia.

### K12 — Fuori ambito

Backup programmati delle applicazioni, ripristino in un'applicazione nuova o dopo il ripristino del pannello, download di un backup, backup senza fermare l'applicazione, scelta della destinazione per applicazione. Ognuno ha una issue propria.

### Alternative scartate

- **Sospendere i container (`docker pause`) invece di fermarli.** Il fermo è più breve, ma i file di un database sospeso sono nello stato di un'interruzione di corrente: il ripristino dipende dal recupero del database.
- **Copiare prima i volumi in un'area locale e caricare dopo.** Il fermo dura solo la copia locale, ma serve spazio su disco pari ai dati e un secondo percorso di pulizia.
- **Comandi di dump dichiarati nel modello.** Danno copie migliori per i database, ma portano l'esecuzione di comandi dentro i container dell'applicazione: è una decisione di sicurezza a parte.
- **Riavviare l'applicazione dentro l'operazione di backup.** Avrebbe duplicato il codice di avvio e di recupero.
- **Girare come l'utente dei siti (`33:33`).** Non leggerebbe i file di altri proprietari.

## 3. Conseguenze

- Un backup ferma l'applicazione: il cliente lo legge prima di confermare. Applicazioni con molti dati e due destinazioni restano ferme a lungo.
- I lavori di backup delle applicazioni girano come `root` del container con capacità limitate. È più di quanto serve ai siti; è il minimo che legge e riscrive file di proprietari qualsiasi.
- I file che `restic` crea in un repository locale sono di `root` con il gruppo dell'esecutore. L'esecutore li legge e li cancella attraverso il gruppo.
- Dopo `hp-restore-panel` le applicazioni sono `failed` e i loro volumi mancano: il ripristino dei dati in quel caso non è provato (K12).
- La route B4 di `ADR-0035` non risponde più `422 NOT_SUPPORTED` dove il backup è disponibile.

## 4. Come è stato costruito

Compilato a lavoro finito.

## 5. Che cosa è provato

- **Con Docker reale, prima del codice** (prova usa-e-getta del 2026-11-23, `restic` 0.19.1): `restic init` come `0:<gid>` senza capacità su una cartella `0770`; copia come utente `0` con la sola `DAC_READ_SEARCH` di due volumi con file di più proprietari, permessi `0000`, setuid, setgid, collegamenti e una pipe; la stessa copia senza la capacità fallisce (uscita `3`); ripristino per volume con le quattro capacità e il repository in sola lettura, elenco di proprietari, permessi, collegamenti e contenuti identico a prima.
- Il resto è compilato a lavoro finito.
