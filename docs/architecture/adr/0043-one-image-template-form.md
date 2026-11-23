# ADR 0043 — Un Modello di Applicazione da una Sola Immagine

- **Stato:** `PROPOSTO` — scelte I1–I8 prese dall'agente su direttiva del proprietario del 2026-11-22 («vorrei funzionasse come funziona Coolify»); in attesa di approvazione
- **Data:** 2026-11-23
- **Riferimento:** `ADR-0035` (applicazioni: modelli `HCP-STACK/v1`, elenco delle immagini ammesse, editor dei modelli); issue #79, PR #80
- **Migrazioni:** nessuna

Questo ADR dà all'amministratore del server un modulo che scrive il modello di un'applicazione fatta di **una sola immagine**: pochi campi al posto di un sorgente scritto a mano. Il modulo scrive e basta; a controllare e a salvare resta l'editor che c'è già.

---

## 1. Contesto

Nei pannelli per sviluppatori «installa un'immagine Docker» è la strada più corta: si scrive il nome dell'immagine, la porta, qualche variabile, e parte.

In questo pannello un'immagine arriva a un cliente solo dentro un **modello**, che scrive l'amministratore del server, e solo se è nell'elenco delle immagini ammesse, fissata con la sua impronta (`ADR-0035`). Il cliente non è un tecnico e non nomina mai un'immagine. Oggi però l'unico modo di fare un modello è scriverne tutto il sorgente nell'editor, partendo da una pagina vuota: è il caso più frequente ed è il più lento da fare bene.

## 2. Decisioni

### I1 — Per chi

Il modulo è per l'**amministratore del server**. Per il cliente non cambia nulla: installa il modello pubblicato come ogni altra applicazione.

### I2 — Che cosa produce

Il **sorgente** di un modello `HCP-STACK/v1` con un solo componente. Il modulo non salva, non installa e non chiama nessuna rotta: apre il sorgente nell'editor dei modelli, dove l'amministratore sceglie lo slug, lo fa controllare al server («Valida») e lo salva. Il validatore del server resta l'unica autorità su che cosa è un modello valido.

### I3 — L'immagine

Si sceglie da un menu fra i repository dell'elenco ammesso dal pannello; non è un testo libero. L'**impronta** (`sha256:` e 64 caratteri esadecimali) è obbligatoria e la scrive l'amministratore, copiandola dal registro. Il modulo non contatta nessun registro. La versione (tag) è facoltativa e serve a chi legge; `latest` è rifiutato.

### I4 — I campi

Nome, categoria e descrizione; immagine, versione e impronta; la porta su cui il software risponde, se i clienti possono dargli un indirizzo web, il controllo che sia pronto (nessuno, la porta risponde, una pagina risponde); le impostazioni; una cartella da conservare; processore e memoria. Il componente si chiama `app` e il volume della cartella `data`.

### I5 — Le impostazioni

Sono le variabili d'ambiente del software, di tre tipi:

- **valore fisso**: uguale in ogni applicazione fatta dal modello; un `$` nel valore viene scritto `$$`, perché nel formato un `$` apre un segnaposto;
- **lo sceglie il cliente**: diventa un parametro di tipo testo, con l'etichetta e il valore proposto dall'amministratore; la chiave del parametro è il nome della variabile in minuscolo;
- **valore riservato**: diventa un parametro segreto, che solo il cliente imposta; la variabile finisce con `_FILE` e il software riceve il percorso del file con il valore.

Al massimo 24 impostazioni, di cui 8 riservate (il limite del formato).

### I6 — Che cosa rifiuta il modulo, e che cosa lascia al server

Il modulo rifiuta, campo per campo, solo ciò che non potrebbe mai diventare un sorgente valido: forme e limiti (nome, categoria, impronta, porta, percorsi, processore, memoria), nomi di variabile mal formati o riservati al pannello, e tre combinazioni (un indirizzo web senza porta, un indirizzo web senza controllo, un controllo senza porta). Ciò che solo il validatore giudica (un nome o un valore che sembra un segreto, un riferimento a un indirizzo interno) lo rifiuta il **server**, nell'editor, con la riga del sorgente.

### I7 — Che cosa non cambia

Nessuna rotta dell'API, nessuna tabella, nessuna chiave del formato, nessuna riga dell'elenco delle immagini, nessuna regola dell'esecutore. Nessun permesso nuovo, nessun flag nuovo (la pagina sta dietro `applicationTemplatesAvailable`, come le altre dei modelli), nessuna dipendenza nuova.

### I8 — Fuori ambito

Un cliente che nomina un'immagine; un'immagine fuori dall'elenco o senza impronta; cercare l'impronta di una versione su un registro; più di un componente (c'è l'importatore di file Compose della PR #43); un comando di avvio diverso da quello dell'immagine, più porte o più cartelle (si aggiungono a mano nell'editor); installare direttamente dal modulo, senza un modello; riaprire nel modulo un modello già scritto.

### Alternative scartate

- **Un modulo per il cliente**, come nei pannelli per sviluppatori. Il cliente di questo pannello non è tecnico, e un'immagine scelta da un cliente non sarebbe né ammessa né fissata.
- **Una rotta dell'API che scrive il sorgente.** Il sorgente è testo che l'amministratore vede e può correggere prima di salvarlo: scriverlo nel browser basta, e non aggiunge una superficie da proteggere.
- **Lo stesso validatore nel browser.** Porterebbe nel browser tutto il motore delle regole per dire in anticipo quello che l'editor dice già un momento dopo, con la riga.
- **Testo libero per l'immagine.** Inviterebbe a scrivere immagini che il server rifiuterà; il menu mostra quello che c'è.
- **Cercare l'impronta su un registro.** Il pannello non fa richieste a indirizzi scelti da un utente se non dove un ADR lo prevede, e l'impronta giusta la sceglie chi ha letto che cosa c'è in quella versione.

## 3. Conseguenze

- **Il modulo può scrivere un sorgente che il server poi rifiuta**, per i nomi e i valori che solo il validatore giudica. L'amministratore lo vede nell'editor, corregge lì o torna al modulo.
- **Il modulo offre le immagini che il browser conosce**, cioè l'elenco compilato nel pannello. Se il server ne ammette di diverse (non succede in produzione) decide il server.
- **Un modello fatto dal modulo è un modello come gli altri**: si può aprire e cambiare a mano, e non ricorda di essere nato dal modulo.
- **Aggiungere un'immagine all'elenco resta una modifica del codice**, con la conferma del proprietario (`ADR-0035`).

## 4. Come è stato costruito

- **Scrittura del sorgente** (`packages/contracts/src/app-templates/single-image.ts`): `buildAppSingleImageTemplate` prende i campi e restituisce il sorgente, oppure l'elenco dei campi che non si possono scrivere, ciascuno con un codice di una lista chiusa. È una funzione pura: stessi campi, stesso testo. Usa le stesse regole di forma che il formato già esporta (chiavi, nomi di variabile, percorsi, limiti). Le stringhe sono scritte fra virgolette doppie, nella forma che il lettore dei modelli accetta.
- **Pagina** (`apps/web`): `/admin/templates/apps/new/image`, raggiungibile da **Modelli → Nuovo modello → Applicazione da un'immagine**. Il modulo (`components/admin/app-template-image-form.tsx`) tiene i campi come sono stati scritti, li passa alla funzione e, se il sorgente è scritto, mostra l'editor esistente con quel sorgente; «Torna al modulo» riporta ai campi. Italiano e inglese.
- **Numeri scritti male**: una porta, un processore o una memoria che non sono un numero diventano «non valido», mai un altro numero.

## 5. Che cosa è provato

- `packages/contracts/test/app-single-image.test.ts`: il sorgente intero di un esempio completo e di uno minimo, riga per riga; ogni campo rifiutato con il suo codice; le tre combinazioni rifiutate; le impostazioni che non si possono scrivere; il lettore dei modelli rilegge gli stessi valori.
- `packages/policy-engine/test/app-single-image.test.ts`: per più di mille combinazioni dei campi il **validatore del server** accetta il sorgente e ci ritrova quello che era stato chiesto (immagine, porta, cartella, indirizzo web, controllo, limiti, impostazioni, parametri); un esempio completo diventa un piano con un componente, il valore fisso com'è stato scritto, il valore del cliente al suo posto e il valore riservato come file; un nome che sembra un segreto è rifiutato dal server con la riga giusta del sorgente.
- `apps/web/test/admin-app-template-image-form.test.ts`: ogni campo ha la sua etichetta; il menu offre solo le immagini e le categorie date; i campi sbagliati sono detti a parole; il sorgente scritto arriva all'editor esistente; il modulo non chiama nessuna rotta; senza sessione si va all'accesso, con il flag spento compare l'avviso.
- Build, lint, controllo dei tipi e i test collegati passano in locale; il controllo completo è quello della CI sulla PR.

## 6. Non provato

- **La pagina in un browser.** È coperta dai test della pagina, non vista da una persona.
- **Su un pannello installato.** `applicationTemplatesAvailable` è `false` su `main`.
- **Un modello scritto dal modulo, installato su Docker reale.** Il sorgente è accettato dal validatore e diventa un piano; nessuna applicazione è stata avviata da un modello nato dal modulo (le immagini ammesse su questo ramo sono le tre dei modelli integrati).

## 7. Punti aperti

- **Le decisioni I1–I8 sono dell'agente.** Nessun proprietario le ha approvate.
- **Con tre immagini nell'elenco il modulo serve a poco**: diventa utile quando l'elenco cresce (la PR #43 ne aggiunge).
- **La PR #43 aggiunge l'importatore di file Compose nella stessa voce di menu**: chi entra dopo deve unire `main` e tenere entrambe le voci.
