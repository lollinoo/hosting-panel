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

Un interruttore per indirizzo aggiunge il middleware `compress` di Traefik. Il valore predefinito nel database e nell'API è `false`, così righe e file esistenti non cambiano. La richiesta che aggiunge un indirizzo accetta un campo facoltativo `compression`; l'interfaccia lo manda `true`, quindi un indirizzo aggiunto dal pannello nasce con la compressione accesa e il cliente la spegne dalle opzioni.

### R5 — Regole di percorso

Un indirizzo può avere fino a quattro regole `{ pathPrefix, componentKey, port, stripPrefix }`: le richieste sotto quel percorso vanno a un'altra coppia (servizio, porta) dell'applicazione, con o senza rimozione del prefisso. Il prefisso ha al massimo 64 caratteri e fino a quattro segmenti di lettere, cifre, `.`, `_`, `~`, `-`, ciascuno con iniziale alfanumerica (quindi mai `/.well-known`). Le regole ereditano certificato, passaggio a HTTPS, protezione e compressione dell'indirizzo. Una regola la cui destinazione non è nel piano o non è sana non viene pubblicata. Un aggiornamento o un ritorno a una revisione precedente che toglie la destinazione di una regola è rifiutato (`400 VALIDATION_ERROR`, campo `domains`, motivo `path_target_removed`), come per la destinazione di un indirizzo (`domain_target_removed`, `ADR-0035`): il cliente toglie prima la regola. Lo ricontrolla anche la transazione che mette in coda l'aggiornamento, con la riga dell'applicazione bloccata, così una regola salvata subito dopo il controllo dell'API non passa.

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
- Le opzioni si raggiungono solo dove le applicazioni sono accese: finché `applicationStacksAvailable` vale `false`, anche questa rotta risponde `NOT_SUPPORTED`.

## 4. Come è stato costruito

- **Contratti.** `packages/contracts/src/app-templates/stack-routing.ts`: limiti e forme (`MAX_APP_ROUTE_PATHS`, prefisso, nome utente, password, verificatore) e lo schema della richiesta, stretto e con le quattro chiavi sempre presenti. La richiesta di route delle applicazioni ha uno schema proprio; quello dei siti non cambia.
- **Dati.** `packages/database/migrations/0026_app_routing_options.sql`. La destinazione di un reindirizzamento è legata alla stessa applicazione da una chiave esterna composta `(stack_id, redirect_to_domain_id)` con `ON DELETE SET NULL (redirect_to_domain_id)`. Cinque vincoli `CHECK` ripetono nel database le regole dell'API: mai verso sé stesso, nome utente e verificatore insieme, forma del nome utente e del verificatore (una password in chiaro non può finire nella colonna), al massimo quattro regole di percorso, nessuna protezione o regola su un indirizzo che reindirizza.
- **API.** `apps/api/src/controllers/app-stack-domains.controller.ts` e `apps/api/src/app-stacks/app-stack-domains.service.ts`: `PATCH` con `app.update` (proprietario del cliente e amministratore dell'hosting; un collaboratore non ha permessi sulle applicazioni), risposta con l'elenco intero degli indirizzi, rifiuti `400 VALIDATION_ERROR` con motivo `redirect_target`, `redirect_chain`, `password_required` o `unknown_ingress` (una regola di percorso punta a una coppia presente sia nella revisione che gira sia in quella desiderata, che un deploy installa così com'è), riga di audit `app.stack.domain.update` senza password né verificatore. Per tenere la password attuale la richiesta manda solo il nome utente. La risposta dice anche quando le opzioni valgono (`applies`, vedi «Quando vale un cambio»).
- **Pubblicazione.** `apps/api/src/app-stacks/app-stack-runtime-policy.ts` (`appStackRoutePlan`): un indirizzo che reindirizza entra nella voce della sua destinazione con `redirectTo`; una regola di percorso entra solo se la sua destinazione è pronta, altrimenti le richieste sotto quel percorso vanno alla parte principale dell'indirizzo. Salvare le opzioni non scrive il file: quando l'osservatore riscrive le route dell'applicazione (vedi «Quando vale un cambio») e le route salvate non sono quelle del file in vigore, il servizio mette in coda l'aggiornamento delle sole route nella stessa transazione del salvataggio, con la riga dell'organizzazione e quella dell'applicazione bloccate nell'ordine di ogni altra messa in coda (`queueRoutesRefresh` di `apps/api/src/app-stacks/app-stack-observer.service.ts`): nessuna azione può entrare in coda tra il salvataggio e l'aggiornamento. Lo stesso vale quando si aggiunge o si toglie un indirizzo. Poi chiede all'osservatore un passaggio su quell'applicazione. L'aggiornamento pubblica ciò che gira: il piano della revisione applicata, anche quando una revisione più nuova è desiderata ma non installata (un aggiornamento fallito prima di cambiare qualcosa), e il deploy che lo registra porta la revisione applicata. Se il primo tentativo non riesce, riprova il passaggio periodico (ogni minuto, salvo diversa configurazione). Un cambio di opzioni non aspetta né i cinque minuti riservati ai soli cambi di salute né i dieci minuti di pausa dopo un'azione fallita: è una richiesta del cliente, fatta una volta, non il nuovo tentativo di quell'azione. Per non scambiarlo per un cambio di salute (una regola nuova verso un bersaglio che le route pubblicate lasciano fuori sembrerebbe tale), l'osservatore ricorda, con l'ora dell'ultimo aggiornamento accodato, le route degli indirizzi con tutti i bersagli inclusi (calcolate con ACME acceso, perché lo stato di ACME non è salvato e la transazione del salvataggio non interroga l'esecutore), che cambiano solo con gli indirizzi e le loro opzioni: se sono cambiate, i cinque minuti non valgono, e dopo un aggiornamento fallito il passaggio periodico non aspetta i dieci minuti; li aspetta solo per gli indirizzi con cui l'aggiornamento fallito era stato accodato. Nessun contenitore viene riavviato.
- **Quando vale un cambio** (`appStackOptionsApply` in `apps/api/src/app-stacks/app-stack-runtime-policy.ts`). La regola: se un file di route dell'applicazione può essere pubblicato, un cambio di opzioni lo raggiunge oppure è rifiutato; il pannello non mostra mai come attiva un'opzione che il file in vigore non ha. La scelta si fa nella stessa transazione del salvataggio, con la riga dell'applicazione bloccata. Con l'applicazione `running` o `degraded`, una revisione applicata, nessuna azione in corso e l'ultima azione diversa da uno stop, l'osservatore riscrive il file: la risposta dice `applies: shortly` e la pagina «Opzioni salvate: valgono tra qualche istante». Lo stesso quando l'azione in corso è soltanto l'aggiornamento delle route del pannello (l'applicazione è `updating`): quell'aggiornamento legge gli indirizzi quando parte, e il passaggio dopo di esso vede un cambio che gli è sfuggito, senza aspettare. Con l'applicazione mai installata (nessuna revisione applicata) o ferma (`stopped`: l'arresto ritira le route) non c'è nulla di pubblicato: le opzioni sono salvate, la risposta dice `applies: at_start` e la pagina «Opzioni salvate: varranno quando l'applicazione verrà avviata»; l'avvio pubblica le opzioni del momento. In ogni altro stato (un'azione del cliente in corso, `failed`, `unknown`, uno stop chiesto dal cliente e non finito) un file di route può essere in vigore senza che nulla lo riscriva: la richiesta è rifiutata con `409 RESOURCE_LOCKED`, campo `status`, motivo lo stato, e nulla è scritto; la pagina mostra «Non è possibile ora: l'applicazione è nello stato …». Dopo uno stop non finito lo stato è `running` o `degraded`, come per le applicazioni che accettano il cambio: il motivo è allora `stop_unfinished` e la pagina dice che cosa fare («L'applicazione non si è arrestata del tutto: premi di nuovo Arresta, oppure Riavvia, poi riprova»). Togliere un indirizzo segue la stessa regola, con lo stesso rifiuto negli stessi stati: toglierlo libera il nome per chiunque, anche per un altro cliente, mentre il file in vigore lo servirebbe ancora. Non si è scelto di lasciar ritirare il nome all'aggiornamento delle sole route: quell'aggiornamento ripubblica tutti i bersagli pronti e chiude l'applicazione `running` o `degraded`, quindi su un'applicazione `failed` non sarebbe un semplice ritiro. Aggiungere un indirizzo resta sempre possibile: l'indirizzo nuovo è «In attesa» finché un file pubblicato non lo contiene. Resta un caso: l'aggiornamento accodato fallisce (l'esecutore non risponde) e poi fallisce anche un'azione del cliente, così il file in vigore resta senza ciò che è stato salvato. Per questo il dettaglio dell'applicazione porta `routesPending` (`appStackRoutesPending`): vero quando gli indirizzi e le opzioni salvati non sono quelli dell'ultimo file pubblicato con successo, di cui l'applicazione conserva l'impronta (`applied_routes_hash`), per qualunque salute dei bersagli e con ACME acceso o spento. Finché è vero, la pagina mostra «Opzioni non ancora attive» accanto a ogni indirizzo che mostra un'opzione (reindirizzamento, password, percorsi), mai l'opzione come attiva da sola. È un solo valore per applicazione: per qualche istante dopo un cambio lo mostrano anche gli indirizzi che non sono cambiati.
- **Esecutore.** `apps/docker-executor/src/app-stacks/routes-check.ts` ricontrolla la richiesta contro il piano; `apps/docker-executor/src/traefik-config.ts` (`buildAppStackDynamicTraefikYaml`) scrive i middleware: `redirectRegex` permanente per l'indirizzo che reindirizza, `basicAuth` con `removeHeader`, `compress`, e per ogni regola un router ``Host(…) && (Path(`/p`) || PathPrefix(`/p/`))`` con `stripPrefix` quando richiesto. Con il certificato utilizzabile il router HTTP porta solo il passaggio a HTTPS: non chiede la password e non serve i percorsi.
- **Downgrade.** `infra/linux/lib/common.sh`: la funzione `app-routing-options` è in uso quando esiste una riga di `app_stack_domains` con `redirect_to_domain_id` non nullo, `access_username` non nullo o `path_routes` diverso da `[]`.
- **Interfaccia.** `apps/web/src/components/app-stacks/app-stack-domain-options.tsx`: «Opzioni» su ogni indirizzo, con «Reindirizza a», «Proteggi con password», «Comprimi le risposte» e «Percorsi (avanzato)»; avvisa quando l'indirizzo non ha ancora la connessione protetta. Come destinazioni di un percorso offre solo quelle che la `PATCH` accetta, cioè le coppie presenti sia nella revisione che gira sia in quella desiderata (`pathTargets` del dettaglio dell'applicazione), non tutte quelle della versione chiesta.

## 5. Che cosa è provato

- **Con Docker reale** (`infra/linux/accept-app-routing-options.mjs`, 2026-11-22, Docker Engine 29.10.0, `traefik:v3.7`): 24 passi su 24, due esecuzioni. Il file scritto dal codice di produzione è caricato da un proxy usa-e-getta e si comporta come dicono le opzioni, una volta senza ACME e una con ACME: reindirizzamento `301` con percorso e query, `401` senza password o con password o nome sbagliati, accesso con la password giusta (anche di 12 e di 128 caratteri, con spazi, `:`, `$`, virgolette), intestazione delle credenziali mai arrivata all'applicazione, compressione solo dove è accesa, percorsi con e senza rimozione del prefisso e precedenza del percorso più profondo, cambio di opzioni senza riavvio del proxy, nessun errore di configurazione nel log del proxy. I verificatori sono calcolati dal codice dell'API.
- **Con test automatici**: i controlli dei contratti, del database, dell'API, dell'esecutore e dell'interfaccia elencati nella PR.
- **Non provato**: un certificato vero (nella seconda esecuzione l'autorità di certificazione è una porta locale chiusa e il proxy risponde con il suo certificato predefinito); un server installato; il controllo della richiesta nell'esecutore contro un piano vero, coperto solo dai test automatici (lo script non installa un'applicazione).
