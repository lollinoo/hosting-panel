# ADR 0029 — I Tipi di Sito (M6a): una Chiave sul Sito, un Modulo per Livello

- **Stato:** `APPROVATO — M6a`
- **Data:** 2026-11-17
- **Riferimento:** quadro di M6a (`M6A-FRAME`, decisioni D1–D27), `ADR-0016`, `ADR-0019`, `ADR-0021`, `ADR-0022`, `ADR-0027`, `ADR-0028`; regole `R205` e `R206`
- **Migrazioni:** `0018_site_type.sql` (additiva). Aggiunge a `sites` la colonna `site_type` (testo, senza vincolo) e la riempie con `wordpress` per ogni sito che ha una versione PHP.

## 1. Contesto

Fino a M5 il pannello sapeva creare un solo tipo di sito: **WordPress**. I fatti di WordPress erano scritti dentro il codice di tutti: il nome del volume dei file (`html`), la cartella (`/var/www/html`), l'utente proprietario (`33:33`, cioè *www-data*), il prefisso del database (`wp`), il programma PHP del file manager, i passi del ripristino.

Cinque parti del pannello lavorano sui file o sui dati di un sito: **file**, **SFTP**, **database**, **backup** (con il ripristino) e **terminale**. Le chiamiamo *i cinque sottosistemi*. Per aggiungere un secondo tipo bisognava cambiare tutte e cinque.

M6a non aggiunge un tipo nuovo. Sposta i fatti di WordPress in un posto solo per livello (contratti, API, esecutore, simulatore, web), così un secondo tipo si aggiunge seguendo i passi della sezione 7. Ciò che un sito WordPress manda all'esecutore resta identico, byte per byte: lo provano i test dei *pin* (sezione 8).

## 2. Che cos'è un tipo di sito

- **Una chiave salvata sul sito.** Il tipo è la colonna `sites.site_type`. Oggi l'unica chiave è `wordpress` (`SITE_TYPE_KEYS` in `packages/contracts/src/site-types/keys.ts`).
- **Fatti costanti.** I fatti del tipo sono scritti nel codice, mai letti da una richiesta, da una riga del database o da un file. La parte comune a tutti i livelli è la `SiteTypeDefinition` (sezione 5).
- **Un modulo per livello.** Ogni livello ha un registro (un elenco chiave → modulo) e un modulo per tipo: contratti, API, esecutore, simulatore e web.
- **Un sito senza tipo noto non è gestito.** Se la colonna è vuota o porta una chiave sconosciuta, il sito non è un sito gestito: è un *servizio generico*. I cinque sottosistemi lo rifiutano (lo trattano come un sito che non c'è). Non è mai trattato come WordPress. Le letture che distinguono un sito gestito da un servizio generico (per esempio in `apps/api/src/controllers/organizations.controller.ts` e `packages/database/src/backups-repository.ts`) leggono la colonna con l'elenco delle chiavi note.
- **Nessun valore indovinato.** `findSiteType` in `packages/contracts/src/site-types/registry.ts` non lancia mai: un valore sconosciuto dà `null`, cioè «non gestito». `getSiteType` vuole una chiave già nota.
- **La creazione salva il tipo.** Un sito nuovo nasce con `site_type = wordpress` (`apps/api/src/sites/managed-sites.service.ts`).
- **Riparazione all'avvio.** Se `hp-update` torna a una versione precedente e quella versione crea un sito, il sito nasce con la versione PHP ma senza tipo. All'avvio l'API dà il tipo `wordpress` a ogni sito con una versione PHP e senza tipo (`apps/api/src/create-app.ts`). Questo vale anche quando l'API non possiede la connessione al database.

### Il servizio generico

Le route generiche dei servizi in `apps/api/src/controllers/organizations.controller.ts` restano, ma in questa versione nessuno le apre (`R207` addendum 4 A). `createService`, `appendRevision` e, per i membri, `createInvitation` fanno prima il controllo dell'organizzazione (le chiavi `service.create`, `service.configuration.manage`, `organization.members.manage`) e subito dopo chiedono il permesso di piattaforma `platform.users.manage`:

| Chi chiama | Risposta |
|---|---|
| un cliente di un'altra organizzazione; un amministratore senza visita o con una visita chiusa | `404`, nessuna riga di audit |
| un amministratore con una visita scaduta | `403 PERMISSION_DENIED`, una riga di rifiuto |
| un amministratore con una visita aperta | `403`, una riga di rifiuto con la ragione `SUPPORT_ACCESS_PERMISSION_DENIED` (nessuna delle tre chiavi è tra i permessi di una visita; `createSite`, qui sotto, rifiuta la visita anche se `site.create` lo è) |
| un membro con la chiave che non è amministratore del server (il cliente) | `403 PERMISSION_DENIED`, una riga di rifiuto |
| un amministratore del server che è anche membro con la chiave | la route funziona |

Nulla nel pannello rende un amministratore del server membro dell'organizzazione di un cliente: su un server installato le tre route sono chiuse a tutti. Un servizio generico e un secondo membro di un'organizzazione non sono funzioni di questa versione. Quando la route funziona: memoria al più 64 GiB e CPU al più `64_000` milli (`MAX_SERVICE_MEMORY_BYTES`, `MAX_SERVICE_CPU_MILLI` in `packages/policy-engine/src/service-validation.ts` e `apps/docker-executor/src/docker-engine-adapter.ts`); nessuna porta del server stesso (22, 80, 443, 2222, 3000, 4000, 5432 e la porta di phpMyAdmin); una revisione passa da `validateDeclarativeServiceInput`; invitare chi è già membro risponde `409 ALREADY_EXISTS`.

La route generica dei siti (`createSite`, `POST /v1/organizations/{orgId}/sites`) crea un sito senza tipo, cioè il posto di un servizio generico, e ha la stessa guardia: prima la chiave `site.create`, poi `platform.users.manage`. Le righe della tabella valgono anche per lei: `site.create` è tra i permessi di una visita (serve alla route tipizzata), ma la route chiede a `requireOrgPermission` di rifiutare una visita (`refuseSupportVisit` in `apps/api/src/auth/authz-context.service.ts`), quindi un amministratore con una visita aperta riceve lo stesso `403` e la stessa riga di rifiuto di `createService`. Il primo dominio (`initialDomain`) è normalizzato da `SiteDomainSchema` come il dominio della route tipizzata e passa per lo stesso controllo contro gli altri siti e i server (`assertNewSiteAddressesFree` in `apps/api/src/sites/managed-sites.service.ts`): un nome non valido riceve `400 VALIDATION_ERROR`, un nome già usato `409 DOMAIN_CONFLICT`. Un rifiuto dentro la transazione (il nome di un'applicazione, che il trigger del database rifiuta, o un certificato manuale che lo cattura) passa per `newSiteError`, la stessa traduzione della route tipizzata. La pagina di un sito senza tipo mostra solo la scheda della panoramica (`apps/web/src/components/customer/site-tabs.tsx`), perché le route dietro le altre schede gli rispondono `404`.

M6a fa tre riparazioni:

- la richiesta in coda, lo stato voluto e la riga di audit si scrivono in una sola transazione;
- l'ordine dei controlli è: il servizio esiste (altrimenti `404`), il permesso (dal M6b, il controllo dell'organizzazione e poi `platform.users.manage`), il rifiuto di un sito gestito, poi la lettura del corpo. Un servizio di un'altra organizzazione con un corpo sbagliato riceve `404`, non `400`;
- un'operazione generica fallita salva una frase fissa: «This action did not finish. Try again in a few minutes.».

Con l'esecutore spento (`runtimeBackend: disabled`) un'azione su un servizio generico risponde `422 NOT_SUPPORTED` e non chiama l'esecutore.

Un servizio generico non ha database, né backup del sito (a mano o notturno), né ripristino: le route dei database rispondono `404` a un sito il cui tipo non ha database (`apps/api/src/controllers/site-databases.controller.ts`), quelle dei backup e del ripristino a un sito senza tipo (`apps/api/src/controllers/site-backups.controller.ts`), e il backup notturno sceglie solo i siti con una chiave nota (`findNextNightlySite` in `packages/database/src/backups-repository.ts`).

## 3. Che cosa riceve l'esecutore

- **Una chiave, mai un fatto.** Le richieste dei file, dei backup (`start`, `restore`, `siteState`), degli utenti SFTP e dell'apertura del terminale portano `siteType`: una chiave dell'elenco chiuso (`SiteTypeKeySchema`). Mai un percorso, un utente o un pezzo di script. L'esecutore cerca la chiave nel suo registro e prende i fatti dal suo modulo.
- **Le richieste dei database non portano la chiave.** Il database condiviso non dipende dal tipo.
- **Chiave assente = tipo storico.** Una richiesta senza `siteType` vale `wordpress` (`LEGACY_SITE_TYPE`). Il motivo: un'API più vecchia e gli undici script di collaudo con Docker vero (`infra/linux/accept-m1-files.mjs` e gli altri `accept-*`) mandano richieste senza la chiave, e devono continuare a funzionare.
- **Chiave sconosciuta = rifiuto.** Lo schema chiuso rifiuta una chiave che non è nell'elenco. `resolveExecutorSiteType` risponde `VALIDATION_ERROR` «Unknown site type».
- **Operazione che il tipo non ha = rifiuto.** Un'operazione del file manager che il tipo non dichiara riceve `VALIDATION_ERROR`.
- **La nota del ripristino.** La nota che il ripristino lascia sul server porta `siteType` solo per un tipo diverso da quello storico. Per WordPress la nota resta identica a prima (`apps/docker-executor/src/restore-jobs.ts`).
- **Il terminale.** La pulizia delle shell rimaste aperte passa su ogni chiave dell'elenco.

## 4. Che cosa non è stato rinominato, e perché

Nessun valore salvato o usato in un hash è cambiato. Rinominarli avrebbe cambiato righe già scritte, hash già calcolati o file già sul server: ogni sito sarebbe risultato diverso dal suo piano. Restano quindi:

- la colonna `wordpress_url` e la chiave `wordpressUrl` dentro il `routePlanHash`;
- la chiave del dettaglio di audit e i nomi dei DTO;
- `wordpressToolsAvailable` nelle capacità della piattaforma;
- il passo `install_wordpress` della creazione (chiave salvata);
- il nome del programma del file manager, `hp-files.php`;
- l'identificativo del lavoro di installazione, che finisce con `_wp` per ogni tipo;
- i tipi di operazione `site.wordpress.update` e `site.wordpress.import`.

## 5. I campi, livello per livello

### `SiteTypeDefinition` (contratti, `packages/contracts/src/site-types/definition.ts`)

| Campo | Significato | WordPress |
|---|---|---|
| `key` | La chiave salvata in `sites.site_type` e mandata all'esecutore. | `wordpress` |
| `templateId` | La riga del modello di servizio dietro il container del sito. | `tpl_site_wordpress` |
| `files.volumeSuffix` | La fine del nome del volume dei file. | `html` |
| `files.mountPath` | La cartella dei file dentro il container. | `/var/www/html` |
| `files.owner` | Il proprietario dei file, come `uid:gid`. | `33:33` |
| `database` | Il database del tipo e il prefisso del nome; `null` se il tipo non ne ha. | `{ namePrefix: "wp" }` |
| `heavyOperationKinds` | Le operazioni del tipo che contano come azioni pesanti. | `site.wordpress.update`, `site.wordpress.import` |

### `ApiSiteType` (API, `apps/api/src/site-types/index.ts`)

- `definition`: la `SiteTypeDefinition`.
- `image(phpVersion)`: l'immagine del sito per una versione PHP. La usano la creazione e la pagina Aggiornamenti.
- `install`: il passo di installazione della creazione, oppure `null` se il tipo non installa niente. Ha `step` (la chiave salvata), `label`, `done`, `adminSecretKey` (la prima password dell'amministratore, cancellata a fine installazione; `null` se non c'è) e `job(...)`, che costruisce il lavoro da mandare.
- `addressJob(site, siteUrl, previousUrl)`: il lavoro che sposta il sito su un indirizzo nuovo, oppure `null`.
- `databasePasswordJob`: il lavoro che scrive la password del database salvata dal pannello nella configurazione che il sito tiene nei suoi file, oppure `null`. Ha `job(site)` e `unwritableExitCode`, l'uscita di una configurazione che il lavoro non sa riscrivere (e allora non cambia niente). Per WordPress: `wordpress.settle` con il segreto `HP_DB_PASSWORD` ← `SITE_DB_PASSWORD`, uscita `20` (ADR 0021 §4).
- `fileReasonMessages`: le frasi per il cliente dei motivi di errore del file manager propri del tipo.

Un lavoro è un `SiteTypeJob`: `kind` (un tipo di lavoro dell'elenco chiuso), `params` e, se servono, `secrets` (nome della variabile → chiave del segreto). I passi della creazione vengono dal tipo (`siteProvisionSteps`): un tipo senza database e senza installazione ha solo `deploy_site`, `publish_site` e `finish`.

### `ExecutorSiteType` (esecutore, `apps/docker-executor/src/site-types/types.ts`)

- `def`: la `SiteTypeDefinition`.
- `files`: il nome del programma (`programFile`), il testo PHP che il tipo aggiunge al programma comune (`programFunctions` e `programDispatch`), le operazioni in più (`ops`), quelle lente che hanno 570 s (`slowOps`), i percorsi protetti (`protectedPaths`) e `helperImage(siteImage)`, l'immagine del container di appoggio (mai scaricata qui). Un container di appoggio non copia mai niente dalla sua immagine nel volume del sito: monta il volume come `<volume>:<cartella>:rw,nocopy` (`siteFilesHelperBinds` in `apps/docker-executor/src/site-files-helper.ts`).
- `backup.excludes`: ciò che il backup lascia fuori.
- `restore`: l'immagine che sposta i file (`filesImage`, serve GNU `mv --exchange`), le cartelle ricreate (`keptDirs`), ciò che un ripristino lascia sul posto (`leftInPlace`) e `dbGate`, il testo di shell che mette il sito in manutenzione durante il ripristino del database. `dbGate` è `null` esattamente quando `def.database` è `null`.

### `SimulatorSiteType` (simulatore, `apps/docker-executor/src/simulator-site-types.ts`)

- `def`, `protectedPaths`, `ops`: come sopra.
- `shellId`: ciò che stampa `id` nel terminale simulato.
- `seed()`: i file di partenza di un sito nuovo.
- `createOps`: le operazioni proprie del tipo nel simulatore, oppure `null`.

### `WebSiteType` (web, `apps/web/src/site-types/index.ts`)

- `available(capabilities)`: se il server ha gli strumenti del tipo. Per WordPress legge `wordpressToolsAvailable`.
- `tabs`: le schede del tipo (chiave del catalogo e percorso).
- `headerAction(origin)`: il pulsante in testa alla pagina del sito (per WordPress «WP Admin»), oppure `null`.
- `progressSteps`: i passi mostrati durante la creazione.
- `OverviewCard`: la scheda del tipo nella panoramica, oppure `null`.

## 6. I file del tipo WordPress

| Livello | File |
|---|---|
| Contratti | `packages/contracts/src/site-types/wordpress.ts` (la definizione), `packages/contracts/src/site-wordpress-files.ts` (le operazioni di importazione del file manager), `packages/contracts/src/site-wordpress.ts`, `packages/contracts/src/site-wordpress-import.ts` |
| API | `apps/api/src/site-types/wordpress.ts` (il modulo), `apps/api/src/sites/site-wordpress.service.ts`, `apps/api/src/sites/site-wordpress-applier.ts`, `apps/api/src/sites/site-wordpress-import.service.ts`, `apps/api/src/sites/site-wordpress-import-applier.ts`, `apps/api/src/controllers/site-wordpress.controller.ts`, `apps/api/src/controllers/site-wordpress-import.controller.ts` |
| Esecutore | `apps/docker-executor/src/site-types/wordpress.ts` (il modulo), `apps/docker-executor/src/site-types/wordpress-files-program.ts` (il PHP dell'importazione), `apps/docker-executor/src/site-types/wordpress-restore.ts` (la manutenzione durante il ripristino) |
| Simulatore | `apps/docker-executor/src/simulator-wordpress-files.ts` |
| Web | `apps/web/src/site-types/wordpress.tsx` (il modulo), `apps/web/src/site-types/wordpress-overview-card.tsx`, `apps/web/src/components/customer/site-wordpress.tsx`, `apps/web/src/components/customer/wordpress-dialogs.tsx`, `apps/web/src/components/customer/wordpress-import.tsx`, `apps/web/src/components/customer/wordpress-import-card.tsx`, la scheda `apps/web/src/app/sites/[siteId]/wordpress/` e le route `apps/web/src/app/api/bff/orgs/[orgId]/managed-sites/[siteId]/wordpress/` |

## 7. Aggiungere un tipo: i passi

Ogni passo dice il file e che cosa scriverci. I passi 1–6 sono il tipo vero e proprio. I passi 7–16 sono i *file di cablaggio*: file generali che oggi conoscono WordPress per nome e che un secondo tipo deve toccare. Nella chiave usare solo lettere minuscole e cifre.

1. **La chiave.** In `packages/contracts/src/site-types/keys.ts` aggiungere la chiave a `SITE_TYPE_KEYS`. I registri dei passi 2, 4, 5, 6 e 13 sono scritti come `Record` su tutte le chiavi: finché manca un modulo, il controllo dei tipi di TypeScript fallisce.
2. **La definizione.** Un file nuovo `<chiave>.ts` accanto a `packages/contracts/src/site-types/wordpress.ts`, con la `SiteTypeDefinition`. Registrarla in `SITE_TYPES` (`packages/contracts/src/site-types/registry.ts`) ed esportarla da `packages/contracts/src/site-types/index.ts`. Il suffisso del volume, la cartella e il proprietario devono essere diversi da quelli degli altri tipi.
3. **La riga del modello.** In `packages/database/src/sites-repository.ts` oggi esiste solo `ensureWordpressTemplate`, chiamata da `apps/api/src/create-app.ts` e da `apps/api/src/cli/accounts.ts`. Aggiungere la riga del modello del tipo (il suo `templateId`, l'immagine, il volume con il suffisso e la cartella della definizione) e chiamarla negli stessi due posti.
4. **Il modulo dell'API.** Un file nuovo `<chiave>.ts` in `apps/api/src/site-types/`, con l'`ApiSiteType`: `image`, `install` (o `null`), `addressJob` (o `null`), `databasePasswordJob` (o `null`) e `fileReasonMessages`. Registrarlo in `API_SITE_TYPES` (`apps/api/src/site-types/index.ts`). L'immagine del sito deve contenere la cartella `files.mountPath` con proprietario `files.owner`: il container del sito è il solo che riempie un volume vuoto, perché i container di appoggio montano il volume con `nocopy`.
5. **Il modulo dell'esecutore.** Un file nuovo `<chiave>.ts` in `apps/docker-executor/src/site-types/`, con l'`ExecutorSiteType`. Registrarlo in `EXECUTOR_SITE_TYPES` (`apps/docker-executor/src/site-types/index.ts`). Il programma del file manager del tipo viene scritto all'avvio da `ensureSiteFilesProgram`, senza altro lavoro. Un tipo senza database ha `dbGate: null`.
6. **Il simulatore.** Un `SimulatorSiteType` registrato in `apps/docker-executor/src/simulator-site-types.ts`, con i file di partenza e il proprio `shellId`.
7. **I tipi di lavoro** (solo se il tipo ha un'installazione o un cambio d'indirizzo). Aggiungere i tipi di lavoro allo schema `SiteJobIpcRequestSchema` in `packages/contracts/src/ipc-schemas.ts`, a `SiteJobKind` in `packages/executor-contracts/src/port.ts` e a `SITE_JOB_SPECS` (con il loro script) in `apps/docker-executor/src/site-jobs.ts`. Poi in `runSiteJob` di `apps/docker-executor/src/docker-engine-adapter.ts` scrivere il ramo del tipo: oggi il ramo `wordpress.` sceglie l'immagine CLI di WordPress e crea il volume `html` per `wordpress.install`. Il simulatore di questi lavori è in `apps/docker-executor/src/simulator-adapter.ts`.
8. **Le operazioni proprie del tipo** (solo se il tipo ha strumenti suoi, come la scheda WordPress). I tipi di operazione vanno in `packages/contracts/src/operations.ts` e, se sono pesanti, in `heavyOperationKinds`. Quelle di `heavyOperationKinds` bloccano da sole il riavvio dell'esecutore, l'aggiornamento del pannello e quello del sistema, attraverso `SITE_WORK_KINDS` in `apps/api/src/host/host-jobs.ts`, costruito da `SITE_TYPES`. Il worker della coda (`apps/api/src/runtime/outbox-worker.service.ts`) li deve mettere nella sua corsia (oggi `WORDPRESS_LANE_KINDS`) e mandarli al loro *applier* nello smistamento.
9. **Le immagini.** Aggiungere l'immagine del sito e quella di appoggio a `prewarmSiteImages` in `apps/docker-executor/src/docker-engine-adapter.ts` (le scarica prima) e a `releaseImages` in `infra/release/build-release.mjs` (le scrive nel file `IMAGES` della versione). Vale anche per l'immagine del ripristino, `restore.filesImage` (per WordPress è l'immagine del sito, in `apps/docker-executor/src/site-types/wordpress.ts`): se manca dai due elenchi, viene scaricata solo quando il ripristino parte (`tryEnsureImage` in `apps/docker-executor/src/backup-runner.ts`).
10. **Il gruppo SFTP.** In `apps/docker-executor/src/sftp-platform.ts` la riga di gruppo `SYSTEM_GROUP_LINES` è fissa sul gruppo 33. Un tipo con un altro gruppo proprietario deve aggiungere la sua riga.
11. **La creazione.** Oggi la creazione prende solo il modulo di WordPress: `CreateManagedSiteInputSchema` in `packages/contracts/src/site-runtime.ts` (versione PHP, titolo, utente, email e password dell'amministratore), `apps/api/src/sites/managed-sites.service.ts` (che usa il tipo storico), la route `apps/api/src/controllers/managed-sites.controller.ts`, la route BFF `apps/web/src/app/api/bff/orgs/[orgId]/managed-sites/route.ts` e la pagina `apps/web/src/components/customer/new-site.tsx`, che importa direttamente `apps/web/src/components/customer/site-form.tsx`. Per un secondo tipo serve una scelta del tipo e un corpo della richiesta per ogni tipo.
12. **La riparazione all'avvio.** In `apps/api/src/create-app.ts` ogni sito con versione PHP e senza tipo diventa `wordpress`. Se il nuovo tipo ha una versione PHP, questa regola va rivista.
13. **Il modulo web.** Un `WebSiteType` registrato in `WEB_SITE_TYPES` (`apps/web/src/site-types/index.ts`). Se il tipo ha strumenti che non girano su ogni server, serve una capacità sua: oggi c'è solo `isWordpressToolsAvailable` in `packages/contracts/src/resources.ts`, mandata da `apps/api/src/controllers/organizations.controller.ts`.
14. **I cataloghi delle frasi.** In `apps/web/src/i18n/en.ts` e `apps/web/src/i18n/it.ts`: le schede in `site.tabs`, i passi in `site.progress` (il passo di installazione del tipo) e le frasi delle sue schede. Le etichette delle attività del tipo sono in `apps/web/src/app/sites/[siteId]/page.tsx`.
15. **La pagina Aggiornamenti.** `apps/api/src/updates/updates.service.ts` confronta l'immagine del sito con `image(phpVersion)` del tipo; `apps/web/src/app/admin/updates/page.tsx` mostra la versione PHP. Un tipo senza PHP deve dire che cosa mostrare qui.
16. **La posta.** Ogni sito nasce con `siteMail: true` (`apps/api/src/sites/managed-sites.service.ts`) e riceve i tre file della posta di WordPress (`siteMailBinds` in `apps/docker-executor/src/site-mail.ts`): `/var/www/html/wp-content/mu-plugins/hp-mail.php`, `/usr/local/etc/php/conf.d/zz-hp-mail.ini` e `/usr/local/lib/hp-mail/hp-sendmail.php`. Un tipo con un'altra cartella o senza PHP deve dire come manda la posta e quali file monta.

Dopo questi passi: aggiungere il tipo ai test della sezione 8 (i test di confine leggono i valori dal registro; un file nuovo di uno dei cinque sottosistemi va invece aggiunto a mano al suo elenco in `apps/api/test/site-type-boundary.test.ts`, sezione 8) e scrivere un paragrafo del tipo in questo documento.

## 8. Che cosa impongono i test

- **La scansione dei confini** (`apps/api/test/site-type-boundary.test.ts`). Per ognuno dei cinque sottosistemi c'è un elenco di file in ogni livello, più le cartelle delle loro pagine web e route BFF e i gruppi dei cataloghi delle loro schede. Il test fallisce se uno di questi file contiene `wordpress`, `wp-` o `wp_` (in ogni maiuscola) oppure un valore di una definizione: il suffisso del volume tra virgolette, la cartella, il proprietario, il modello, il prefisso del database, `.maintenance`, `mu-plugins`, `www-data`. Le righe permesse sono poche e ognuna dice il suo motivo (per esempio `33:33` di phpMyAdmin, che è l'utente di quella immagine). Oltre ai file dei cinque sottosistemi legge `apps/web/src/lib/file-browser.ts` (con la riga permessa `"html",`, un'estensione di file modificabile) e `apps/api/src/host/host-jobs.ts` (`UPDATE_BLOCK_FILES`, il blocco degli aggiornamenti). Limite: la scansione vede un valore solo tra virgolette doppie (il lint tiene le virgolette doppie); il resto lo prendono le cuciture, dal comportamento.
- **I pin** (`apps/api/test/site-type-pins.test.ts`, `apps/docker-executor/test/site-type-pins-files.test.ts`, `apps/docker-executor/test/site-type-pins-backups.test.ts`, con i file registrati in `apps/api/test/fixtures/site-type-pins/` e `apps/docker-executor/test/fixtures/site-type-pins/`). Registrano, prima di M6a, tutto ciò che l'API manda all'esecutore per un sito WordPress e tutto ciò che l'esecutore manda a Docker: le richieste, i corpi dei container, il programma PHP, gli script del ripristino, la nota, gli hash. Dopo M6a gli stessi file devono uscire identici. Questi test e i loro file non si cambiano.
- **Le cuciture** (*seam*): ogni sottosistema è guidato con un secondo tipo che esiste solo nei test, `teststatic` (`apps/api/test/fixtures/test-site-type.ts` e `apps/docker-executor/test/support/test-site-type.ts`: volume `public`, cartella `/srv/public`, proprietario `1000:1000`, nessun database, nessuna importazione, nessuna manutenzione). Il testo prodotto porta i valori di quel tipo e nessuno di WordPress:
  - API: `apps/api/test/site-type-api-subsystems.test.ts`, `apps/api/test/site-type-api-walk.test.ts`, `apps/api/test/site-types.test.ts`;
  - esecutore: `apps/docker-executor/test/site-type-seam-files.test.ts`, `apps/docker-executor/test/site-type-seam-backups.test.ts`, `apps/docker-executor/test/site-types.test.ts` (che controlla anche che ogni valore che un modulo mette in uno script di shell, nel PHP, in un'espressione regolare o in un nome di file sia sicuro: la tabella `SAFE`);
  - simulatore: `apps/docker-executor/test/simulator-site-type-seam.test.ts`;
  - contratti: `packages/contracts/test/site-types.test.ts`, `packages/contracts/test/site-type-requests.test.ts`;
  - web: `apps/web/test/site-types.test.ts`.
- **Un sito che non è WordPress non è mai trattato come WordPress** (R205 2.1), con le cuciture di un tipo senza database nell'API: `apps/api/test/site-type-seams.test.ts`.
- **Il servizio generico:** `apps/api/test/generic-service-repairs.test.ts`.
- **I casi di bordo** (`apps/docker-executor/test/site-type-edge-qa.test.ts`): tra gli altri, un ripristino storico fermato a ogni passo lascia una nota senza `siteType` (il gruppo «B5 the notes in the middle of a restore»).
- **Collaudo con Docker vero: `infra/linux/accept-m6-site-type.mjs`** (questo documento dice che cosa guida, non se è passato). Guida l'esecutore costruito con un tipo di prova senza database (volume `public`, cartella `/srv/public`, proprietario `1000:1000`) attraverso file, backup, ripristino, SFTP e terminale, poi un passaggio dei file di WordPress nella stessa corsa. Usa solo immagini già presenti e oggetti Docker con nomi usa e getta.
- **Questo documento:** `apps/api/test/infra-layout.test.ts` controlla che il README lo nomini e che ogni percorso del repository scritto qui tra apici inversi esista.

## 9. Limiti accettati

1. **Nessuna scelta del tipo.**
   - *Su cosa non si può contare:* la creazione di un sito crea sempre WordPress; non c'è un campo per il tipo né nella pagina né nell'API.
   - *Cosa fare invece:* per un secondo tipo seguire il passo 11.
2. **Nomi storici.**
   - *Su cosa non si può contare:* che un nome con `wordpress` o `_wp` riguardi solo WordPress (sezione 4).
   - *Cosa fare invece:* leggere il tipo da `site_type`, mai da un nome.
3. **Una sola capacità degli strumenti.**
   - *Su cosa non si può contare:* `wordpressToolsAvailable` dipende solo dal backend dell'esecutore (`linux-systemd`), non dal tipo.
   - *Cosa fare invece:* un tipo con strumenti suoi aggiunge la sua capacità (passo 13).
4. **Ogni sito entra nelle reti del database condiviso e del relay della posta.**
   - *Su cosa non si può contare:* che un sito senza database sia fuori dalla rete del database condiviso. Il deploy collega ogni sito a entrambe le reti.
   - *Cosa fare invece:* trattare il database condiviso come raggiungibile da ogni sito; la sua difesa sono le password per sito.
5. **Il gruppo SFTP è fisso a 33** (passo 10).
   - *Su cosa non si può contare:* l'accesso SFTP di un tipo con un altro gruppo proprietario. Non è stato provato.
   - *Cosa fare invece:* aggiungere la riga del gruppo e provare l'accesso su un server prima di aprire il tipo ai clienti.
6. **Le immagini del tipo non si aggiungono da sole** (passo 9).
   - *Su cosa non si può contare:* che l'immagine di un tipo nuovo, del sito, di appoggio o del ripristino (`restore.filesImage`), sia scaricata in anticipo o scritta nel file `IMAGES`.
   - *Cosa fare invece:* aggiungerla nei due elenchi.
7. **I lavori del sito conoscono WordPress per nome** (passo 7).
   - *Su cosa non si può contare:* che un tipo di lavoro nuovo funzioni senza un ramo suo in `runSiteJob`; il ramo di oggi crea il volume `html`.
   - *Cosa fare invece:* scrivere il ramo del tipo.
8. **La pagina Aggiornamenti legge la versione PHP** (passo 15).
   - *Su cosa non si può contare:* una riga utile per un tipo senza PHP.
   - *Cosa fare invece:* decidere che cosa mostrare prima di aggiungere quel tipo.
9. **La riparazione all'avvio suppone WordPress** (passo 12).
   - *Su cosa non si può contare:* che un sito con una versione PHP e senza tipo sia di un altro tipo: diventa WordPress.
   - *Cosa fare invece:* con un secondo tipo PHP, rivedere la regola.
10. **Una richiesta senza chiave è WordPress.**
    - *Su cosa non si può contare:* che l'esecutore rifiuti una richiesta senza `siteType`: la tratta come WordPress (sezione 3).
    - *Cosa fare invece:* l'API manda sempre la chiave; gli script di collaudo vecchi la lasciano fuori di proposito.
11. **Una nota di ripristino di un tipo nuovo e un esecutore vecchio.**
    - *Su cosa non si può contare:* che un esecutore di una versione precedente legga la nota di un tipo diverso da WordPress: la rifiuta. Per WordPress la nota non è cambiata.
    - *Cosa fare invece:* non tornare a una versione precedente dopo aver ripristinato un sito di un tipo nuovo.
12. **Il cambio di tipo e l'SFTP.**
    - *Su cosa non si può contare:* che un cambio di `site_type` di un sito rifaccia la configurazione SFTP: il controllo delle modifiche non lo vede.
    - *Cosa fare invece:* dopo un cambio di tipo, forzare un'applicazione della configurazione SFTP.
13. **Una lettura in più.**
    - *Su cosa non si può contare:* che una richiesta del file manager faccia le stesse letture del database di prima: ne fa una in più, per leggere il tipo.
    - *Cosa fare invece:* niente; il costo è piccolo.
14. **L'utente dei passi di restic.**
    - *Su cosa non si può contare:* che ogni container di restic giri come proprietario del tipo: i container di restic che non toccano file del sito (repository, pulizia, cancellazione, copia del pannello) girano come `33:33` per ogni tipo (`BACKUP_RESTIC_USER` in `apps/docker-executor/src/backup-jobs.ts`, R205 aggiunta 5). Il container che legge i file del sito per caricarli usa il proprietario del tipo.
    - *Cosa fare invece:* niente per i file del sito; non leggere `33:33` di quei container come il proprietario di un sito.
15. **Cose non provate qui.**
    - *Su cosa non si può contare:* il programma PHP del tipo di prova non è eseguito con un vero `php` (nei test non c'è `php`); `mv --exchange` per il tipo di prova non è provato su questa versione di coreutils; un arresto a metà del passo `switch` per un tipo senza database non è provato.
    - *Cosa fare invece:* provare questi casi su un server, con il tipo vero, prima di aprirlo ai clienti.
16. **I siti senza tipo del seed di prova.**
    - *Su cosa non si può contare:* che i siti del seed di prova (`packages/database/src/seed.ts`) abbiano file, SFTP, database, backup o terminale: non hanno tipo, quindi sono servizi generici e i cinque sottosistemi li rifiutano.
    - *Cosa fare invece:* creare un sito dalla pagina per provare questi strumenti.
17. **Un cambio di PHP su un sito senza tipo noto.**
    - *Su cosa non si può contare:* che cambiare la versione PHP di un servizio generico funzioni: risponde `404`.
    - *Cosa fare invece:* niente; i servizi generici non hanno versione PHP gestita.
18. **La posta di ogni sito è quella di WordPress** (passo 16).
    - *Su cosa non si può contare:* che un sito di un altro tipo mandi posta: ogni sito nasce con `siteMail: true` e riceve i tre file della posta di WordPress, che valgono solo per un sito PHP con la cartella `/var/www/html`.
    - *Cosa fare invece:* prima di aprire un secondo tipo, decidere se ha la posta e con quali file, e provarla su un server.
19. **Ciò che un secondo tipo incontra per primo.**
    - *Su cosa non si può contare:* che queste parti seguano già il tipo:
      - i nomi dei database prendono il prefisso `wp` quando non ne ricevono un altro: `siteDatabasePrefix` in `packages/contracts/src/site-databases.ts`, chiamato senza prefisso dall'API (`apps/api/src/sites/site-databases.service.ts`, `apps/api/src/runtime/site-provisioner.ts`) e dall'esecutore (`apps/docker-executor/src/site-databases.ts`, `apps/docker-executor/src/site-jobs.ts`), mentre il ripristino usa il prefisso del tipo (`apps/docker-executor/src/restore-jobs.ts`);
      - il cambio d'indirizzo ignora i `secrets` del lavoro del tipo (`addressJob` in `apps/api/src/sites/site-domains-applier.ts`);
      - il primo passo `current` della creazione è `create_database` anche per un tipo senza database (`apps/api/src/runtime/site-provisioner.ts`);
      - le richieste dei file dell'importazione non mandano `siteType` (`siteFiles` in `apps/api/src/sites/site-wordpress-import-applier.ts`), quindi valgono `wordpress`;
      - la pulizia delle shell del terminale esegue lo script di ogni tipo in ogni container dei siti (`reapTerminalShells` in `apps/docker-executor/src/docker-engine-adapter.ts` e `apps/docker-executor/src/terminal-docker.ts`);
      - dopo un ritorno a una versione precedente, quella versione rifiuta il file di stato dell'SFTP che porta `siteType` finché non lo riscrive con la sua prima applicazione all'avvio (`writeSftpState` e `readSftpState` in `apps/docker-executor/src/sftp-platform.ts`).
    - *Cosa fare invece:* correggere ognuna di queste parti, con un test della cucitura, prima di aggiungere il secondo tipo.
20. **I servizi generici creati sulla versione 0.5.0 restano (M6b).** L'aggiornamento non li tocca e chi li possiede può ancora avviarli, fermarli e riavviarli dalle route del ciclo di vita (non confermato da un test). Uno che chiede più di 64 GiB o di `64_000` milli di CPU, o che pubblica una porta ora riservata (per esempio 22, 80, 443, 2222, 3000, 4000), continua a girare finché il suo container esiste; se il container sparisce l'esecutore rifiuta di crearlo di nuovo (`Resource limits exceed the server ceiling` o `Published host port is reserved by the server`, `apps/docker-executor/src/docker-engine-adapter.ts`), e nessuno può aggiungere una revisione corretta perché `appendRevision` è chiusa a tutti (sopra).
    - *Su cosa non si può contare:* che un servizio così torni dopo la perdita del suo container.
    - *Cosa fare invece:* dopo l'aggiornamento l'amministratore guarda i servizi generici del server; uno oltre i limiti o su una porta riservata si può solo eliminare.

## 10. Conformità alle regole architetturali

- **Socket Docker solo nell'esecutore:** l'API manda una chiave dell'elenco chiuso; i fatti stanno nel modulo dell'esecutore.
- **Nessuna dipendenza npm nuova**, nessun permesso nuovo, nessun codice di errore nuovo.
- **Testi:** il cliente non vede niente di nuovo; le pagine di un sito WordPress hanno le stesse schede nello stesso ordine.
