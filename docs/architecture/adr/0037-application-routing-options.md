# ADR 0037 — Opzioni di Instradamento per gli Indirizzi delle Applicazioni

- **Stato:** `PROPOSTO` — scelte R1–R12 prese dall'agente su direttiva del proprietario del 2026-11-22 («vorrei funzionasse come funziona Coolify»); in attesa di approvazione
- **Data:** 2026-11-22
- **Riferimento:** `ADR-0035` (stack applicativi), `ADR-0014` (Traefik a file), `ADR-0017` (domini e HTTPS); issue #53, PR #54
- **Migrazioni:** `0026` (additiva; file `packages/database/migrations/0026_app_routing_options.sql`)

Questo ADR aggiunge quattro opzioni a ogni indirizzo web di un'applicazione: reindirizzamento a un altro indirizzo, protezione con password, compressione e regole di percorso. Sono le funzioni di instradamento che un PaaS self-hosted offre con le etichette del proxy; qui restano dati tipizzati, scelti dal cliente e scritti dall'esecutore nel file di route dell'applicazione.

## 1. Contesto

Con `ADR-0035` un'applicazione ha fino a otto indirizzi web. Ogni indirizzo punta a una coppia (servizio, porta) del piano approvato, riceve un certificato ACME e passa da HTTP a HTTPS quando il certificato è utilizzabile. Non c'è altro: nessun reindirizzamento tra indirizzi, nessuna protezione, nessuna compressione, nessun instradamento per percorso (`apps/docker-executor/src/traefik-config.ts`, `buildAppStackDynamicTraefikYaml`: «HTTP host routing only»).

I vincoli sono quelli di `ADR-0035` e di `HARNESS.md`:

- Il cliente non scrive mai configurazione del proxy. Sceglie tra opzioni chiuse e l'esecutore ricontrolla ogni valore prima di scriverlo.
- Solo `hp-docker-executor` scrive i file di route; Traefik li legge in sola lettura e non vede il socket Docker.
- Nessuna dipendenza npm, programma dell'host o variabile d'ambiente nuova.
- I file `site_*.yml` e `hp-panel.yml`, i siti WordPress, TLS e backup non cambiano. Nulla è copiato da altri pannelli.

## 2. Decisioni

### R1 — Quattro opzioni per indirizzo, scelte dal cliente

Le opzioni appartengono all'indirizzo (riga di `app_stack_domains`), non al modello. Le cambia chi ha `app.update` sull'applicazione, con `PATCH /v1/organizations/:orgId/app-stacks/:stackId/domains/:domainId`. La richiesta sostituisce tutte le opzioni dell'indirizzo ed è validata nel suo insieme. Ogni opzione agisce solo dentro l'applicazione: un reindirizzamento porta a un altro indirizzo della stessa applicazione, una regola di percorso porta a un'altra coppia (servizio, porta) del piano della stessa applicazione.

### R2 — Reindirizzamento

Un indirizzo può reindirizzare a un altro indirizzo della stessa applicazione (`redirectToDomainId`). Il reindirizzamento è permanente e conserva percorso e query. La destinazione non può essere l'indirizzo stesso né un indirizzo che a sua volta reindirizza. Lo schema di destinazione è `https` quando il certificato della destinazione è utilizzabile, altrimenti `http`. Un indirizzo che reindirizza non porta protezione né regole di percorso (la richiesta è rifiutata). Se la destinazione viene rimossa, la colonna torna `NULL` (`ON DELETE SET NULL`) e l'indirizzo serve di nuovo l'applicazione. Se la destinazione non è pubblicata (il suo servizio non è sano), nemmeno l'indirizzo che reindirizza è pubblicato.

### R3 — Protezione con password

Un indirizzo può chiedere nome utente e password (HTTP Basic), una coppia per indirizzo. L'API calcola subito un verificatore `$apr1$` (MD5-crypt di Apache, 1000 giri, sale casuale di 8 caratteri) con `node:crypto` (`apps/api/src/app-stacks/apr1.ts`) e scarta la password. Traefik accetta solo MD5, SHA-1 e bcrypt; bcrypt chiederebbe una dipendenza o una cifratura Blowfish scritta a mano, SHA-1 non ha sale. La password ha almeno 12 caratteri.

Il verificatore è scritto in tre posti: la riga del database, la richiesta IPC firmata verso l'esecutore e il file di route. Non compare in DTO, righe di audit, righe dell'outbox, operazioni o log; la password non è scritta da nessuna parte. Il DTO mostra solo il nome utente. Il middleware usa `removeHeader: true`: l'applicazione non riceve le credenziali. La protezione vale su ogni router che serve contenuto, anche su HTTP quando il certificato non è ancora utilizzabile (in quel caso la password viaggia in chiaro: è scritto nel runbook). La verifica ACME `http-01` non è bloccata: la serve il router interno di Traefik.

### R4 — Compressione

Un interruttore per indirizzo aggiunge il middleware `compress` di Traefik. Il valore predefinito nel database e nell'API è `false`, così righe e file esistenti non cambiano; l'interfaccia lo propone acceso per gli indirizzi nuovi.

### R5 — Regole di percorso

Un indirizzo può avere fino a quattro regole `{ pathPrefix, componentKey, port, stripPrefix }`: le richieste sotto quel percorso vanno a un'altra coppia (servizio, porta) dell'applicazione, con o senza rimozione del prefisso. Il prefisso ha al massimo 64 caratteri e fino a quattro segmenti di lettere, cifre, `.`, `_`, `~`, `-`, ciascuno con iniziale alfanumerica (quindi mai `/.well-known`). Le regole ereditano certificato, passaggio a HTTPS, protezione e compressione dell'indirizzo. Una regola la cui destinazione non è nel piano o non è sana non viene pubblicata.

### R6 — Identità byte per byte senza opzioni

I campi nuovi della richiesta di route sono omessi quando non impostati. Per un indirizzo senza opzioni la richiesta IPC, la riga `# @hp-app-route`, il file `app_<stackId>.yml` e l'impronta delle route sono identici a prima: l'aggiornamento non ripubblica nulla e Traefik non ricarica. `SiteHostRouteSchema`, il codice dei siti, `site_*.yml` e `hp-panel.yml` non sono toccati: le applicazioni hanno uno schema proprio che estende quello dei siti.

### R7 — L'esecutore ricontrolla tutto

L'esecutore non si fida dell'API: prima di scrivere ricontrolla ogni valore contro schemi stretti (prefisso, nome utente, forma del verificatore), che la destinazione di un reindirizzamento sia un altro indirizzo dello stesso file che non reindirizza, e che ogni destinazione di percorso sia una coppia del piano il cui contenitore è pronto. Un valore fuori schema fa rifiutare l'intera pubblicazione.

### R8 — Dati

La migrazione `0026` aggiunge a `app_stack_domains` le colonne `redirect_to_domain_id`, `compression`, `access_username`, `access_password_hash`, `path_routes`, con vincoli `CHECK`. È additiva: una release precedente ignora le colonne.

### R9 — Downgrade

`hp-update` rifiuta il downgrade a una release senza la funzione `app-routing-options` (codice di uscita `8`, salvo `--allow-feature-loss`) quando almeno un indirizzo reindirizza, è protetto o ha una regola di percorso. La release precedente riscriverebbe il file senza quelle opzioni: un indirizzo protetto diventerebbe pubblico. La sola compressione non conta: perderla non cambia chi vede che cosa.

### R10 — Interfaccia

Nella pagina dell'applicazione ogni indirizzo ha «Opzioni». Le parole sono quelle del cliente («Reindirizza a», «Proteggi con password», «Comprimi le risposte», «Percorsi»): niente «middleware», «router» o nomi del proxy. Le regole di percorso stanno sotto una sezione avanzata.

### R11 — Fuori ambito

Porte pubbliche TCP/UDP (`stackPublicPortsAvailable` resta `false`), altri proxy, elenchi di indirizzi IP ammessi, intestazioni personalizzate, certificati caricati o jolly per le applicazioni, le stesse opzioni per i siti WordPress.

### R12 — Alternative scartate

- **Etichette o frammenti di configurazione del proxy scritti dal cliente o dal modello.** È il modo dei PaaS a squadre; qui darebbe a un cliente il controllo del proxy condiviso del server.
- **Opzioni nel modello di applicazione.** L'indirizzo è del cliente e cambia senza un nuovo deploy; il modello resta dell'amministratore.
- **Una riga del database per regola di percorso.** Stato DNS e certificato sono dell'indirizzo; una colonna JSONB sulla riga li tiene in un posto solo.
- **bcrypt per il verificatore.** Vedi R3.

## 3. Conseguenze

- Il file di route di un'applicazione può contenere un verificatore di password. Il file sta sotto `/var/lib/hosting-panel`, leggibile solo dall'esecutore e dal proxy.
- `$apr1$` è un formato debole per gli standard di oggi: regge perché la password è lunga almeno 12 caratteri e il verificatore non esce dal server. Un formato migliore chiede una decisione sulla dipendenza.
- Una regola di percorso non riscrive i collegamenti che l'applicazione genera: con la rimozione del prefisso l'applicazione deve conoscere il proprio percorso pubblico.
