# ADR 0034 — Limite di Siti per Cliente

- **Stato:** `APPROVATO` — implementato (M1); la revisione del proprietario è in attesa: lo sciame non può approvare al suo posto
- **Data:** 2026-11-21
- **Riferimento:** richiesta del proprietario (limite di siti per cliente, impostato e modificabile dall'amministratore), `ADR-0025`, `ADR-0029`, `ADR-0033`
- **Migrazioni:** `0023` (additiva, senza backfill; file `packages/database/migrations/0023_organization_site_limit.sql`)

Questo ADR è la versione «as built» di M1: i file, le funzioni e le route create sono scritti tra apici inversi e le prove reali sono in §7. Le decisioni di §2 valgono per tutti i punti in cui un sito nasce o cambia cliente. I limiti noti sono in §4.

## 1. Contesto

Fino a M0 un cliente poteva creare tutti i siti che voleva: nessun controllo, né sul numero né sulla ripartizione delle risorse del server. L'amministratore non aveva modo di dire «questo cliente ha diritto a cinque siti».

Esistono tre modi di creare un sito, tutti diretti alla stessa funzione del database:

1. la route del cliente `POST /v1/organizations/:orgId/managed-sites`;
2. la route dell'amministratore `POST /v1/admin/sites` (con un cliente proprietario, oppure senza: il sito resta alla piattaforma);
3. la route generica `POST /v1/organizations/:orgId/sites`, aperta al `customer_owner` con il permesso `site.create`.

Le prime due passano da `ManagedSitesService.create` (`apps/api/src/sites/managed-sites.service.ts`); la terza chiama direttamente `createSiteTransactional` (`packages/database/src/operations-repository.ts`). A queste si aggiunge il cambio di proprietario (`POST /v1/admin/sites/:siteId/owner`): mette in coda un'operazione `site.reassign`, e lo spostamento vero è eseguito poi da un lavoro in background con `moveSiteToOrganizationTransactional` (`packages/database/src/sites-repository.ts`). Un limite che non copre anche lo spostamento si aggira creando il sito altrove e passandolo al cliente.

Altri fatti del codice che il limite deve rispettare:

- **Non esiste l'eliminazione logica.** Un sito è una riga di `sites`: la cancellazione porta prima lo stato a `maintenance` e rimuove la riga solo quando l'operazione riesce.
- **Il filtro delle eccezioni** (`apps/api/src/common`) conserva di un errore del pacchetto database solo `code` e `message`: i `details` si perdono se l'errore non è già un `ControlPlaneError`.
- **Esiste già un conteggio per cliente:** `OrganizationDetailDto.siteCount`, che è quello che il limite deve usare, così schermate e controllo concordano.

## 2. Decisioni

### 2.1 Il dato: `organizations.max_sites`

- La migrazione `0023` aggiunge a `organizations` la colonna `max_sites INTEGER` e il vincolo `organizations_max_sites_check` (`max_sites IS NULL OR max_sites >= 0`). Nello schema Drizzle è `organizations.maxSites` (`packages/database/src/schema.ts`).
- **`NULL` = nessun limite.** Non c'è backfill: ogni cliente esistente resta illimitato e il comportamento di oggi non cambia. `0` è un limite valido e vieta il primo sito.
- **Additiva e compatibile con il rollback.** La colonna è nullable e senza DEFAULT; la migrazione si può rieseguire (`ADD COLUMN IF NOT EXISTS`, vincolo eliminato e ricreato). Il rollback automatico di `hp-update` riporta la release precedente, che non conosce la colonna e continua a inserire `organizations` e `sites` senza di essa. Nessun gate di downgrade è necessario: una release precedente ignora il limite, non rompe dati.
- **L'organizzazione `org_platform_ops` (`PLATFORM_OPS_ORG_ID`) è esente:** il suo `max_sites` resta `NULL` e nessuna route può cambiarlo (§2.5).
- **`resource_quotas.max_sites` e `used_sites` restano come sono** (colonne di `resource_quotas`, riempite dal seed con un valore fisso e mai aggiornate): non fanno parte di questo limite e non lo implicano. La route `GET /v1/organizations/:orgId/quotas` continua a mostrarle; ripulirle è fuori da M1.

### 2.2 Che cosa conta come «sito esistente»

`usedSites = count(*) FROM sites WHERE organization_id = <cliente>`: **ogni riga conta, qualunque sia lo stato o il `site_type`**. Contano quindi i siti in `deploying`, `failed`, `stopped` e `maintenance` (compresa un'eliminazione in corso) e i siti nudi creati dalla route generica, altrimenti quella route aggirerebbe il limite. Un'eliminazione fallita tiene il suo posto; il posto si libera quando la riga viene cancellata davvero. Il conteggio vale a prescindere dal modello usato per creare il sito (ADR-0033): il limite non sa che cosa c'è dentro un sito.

Questo conteggio coincide con `OrganizationDetailDto.siteCount`.

### 2.3 Il controllo con blocco: `packages/database/src/site-limit.ts`

Il modulo è esportato da `packages/database/src/index.ts` e contiene:

- **`SiteLimitReachedError`** (`code = "QUOTA_EXCEEDED"`, con `organizationId`, `maxSites`, `usedSites`);
- **`lockSiteLimitUsage(tx, organizationId)`:** dentro una transazione blocca la riga dell'organizzazione con `SELECT … FOR NO KEY UPDATE`, poi conta i siti con un'istruzione separata. Sotto `READ COMMITTED` (nessun codice imposta un altro livello di isolamento) chi ha atteso il blocco vede quindi i siti che il vincitore ha confermato. Un'organizzazione inesistente dà un errore `NOT_FOUND`;
- **`assertSiteLimitAvailable(tx, organizationId)`:** `lockSiteLimitUsage`, poi `SiteLimitReachedError` se `maxSites !== null && usedSites >= maxSites`;
- **`countSitesByOrganization(db, ids)`:** conteggio senza blocco per le letture (un solo `GROUP BY`; le organizzazioni senza siti valgono 0);
- **`updateOrganizationSiteLimitTransactional(db, {organizationId, maxSites})`:** transazione propria (un savepoint se annidata): blocca la riga, legge il valore precedente, scrive `max_sites` e `updated_at`, restituisce `{previousMaxSites, maxSites, usedSites}`; `null` se l'organizzazione non esiste.

`FOR NO KEY UPDATE` non confligge con il blocco `KEY SHARE` preso dagli inserimenti con chiave esterna: le altre scritture sotto la stessa organizzazione non vengono fermate. Il blocco dura una transazione breve, senza chiamate di rete né processi esterni; il conteggio usa il vincolo univoco esistente `uq_sites_org_slug` (`organization_id`, `slug`).

**Dove si applica:**

- **`createSiteTransactional`** chiama `assertSiteLimitAvailable(tx, input.organizationId)` dopo il controllo dell'allocazione e **prima** dell'inserimento in `sites`. Il blocco si prende sempre, anche con limite `NULL`, così una modifica concorrente del limite non si infila fra controllo e inserimento. Un rifiuto annulla l'intera transazione: nessun sito, dominio o riga di audit resta.
- **`moveSiteToOrganizationTransactional`** lo chiama in testa alla transazione, **prima** del `FOR UPDATE` della riga del sito, sull'organizzazione di destinazione `to`. Se lancia, il passo `move_ownership` fallisce e il sito resta al cliente di partenza; «Riprova» funziona quando il limite viene alzato.
- **Ordine dei blocchi, ovunque: organizzazione → sito → stato TLS → domini.** È l'ordine già usato dalla creazione e dall'importazione dei certificati; l'unico codice che scrive righe di `organizations` è `updateOrganizationSiteLimitTransactional`, e nulla prende un blocco di sito o di TLS prima di quello dell'organizzazione: nessun ciclo di deadlock.
- **Solo due punti inseriscono in `sites`:** `createSiteTransactional` e il seed demo (`HP_SEED_DEMO`, spento fuori dallo sviluppo, quindi esente; lo è anche lo script di collaudo `infra/linux/accept-m3-panel.mjs`). Ripristino dei backup, importazione WordPress e lavori in background lavorano su un sito che esiste già; l'unico punto che cambia `sites.organization_id` è `moveSiteToOrganizationTransactional`.

### 2.4 Il contratto d'errore: `QUOTA_EXCEEDED`, 409, un solo dettaglio

Nessun nuovo `ErrorCode`: si riusa `QUOTA_EXCEEDED` (409), quindi gli elenchi pinned dei codici non cambiano. Poiché il filtro delle eccezioni perderebbe i `details`, `siteLimitError` (`apps/api/src/sites/site-limit.ts`) trasforma `SiteLimitReachedError` in un `ControlPlaneError("QUOTA_EXCEEDED", …)` con **esattamente un dettaglio**:

```json
{ "field": "sites", "reason": "site_limit_reached", "message": "<N> of <M> sites in use." }
```

La costante è `SITE_LIMIT_REACHED_REASON` in `packages/contracts/src/resources.ts`. Il dettaglio è uno solo perché il web legge `details[0].reason`. Qualsiasi altro errore passa invariato. Il messaggio è neutro: «This customer has reached its site limit. Delete a site or ask the administrator to raise the limit.».

Il rifiuto compare nelle quattro operazioni:

| Operazione | Dove si trasforma l'errore |
|---|---|
| `POST /v1/organizations/:orgId/managed-sites` (cliente) e `POST /v1/admin/sites` (amministratore) | `ManagedSitesService.create`, nel blocco `catch` |
| `POST /v1/organizations/:orgId/sites` (generica) | `createSite` in `apps/api/src/controllers/organizations.controller.ts`, con `.catch((err) => { throw siteLimitError(err); })` |
| `POST /v1/admin/sites/:siteId/owner`, in coda | `ManagedSitesService.reassign`, nella transazione, prima del `FOR UPDATE` del sito e solo se l'operazione non è un semplice `redeployOnly`: controllo **consultivo**, per dare subito un 409 all'amministratore |
| Lo spostamento in background (`moveSiteToOrganizationTransactional` in `apps/api/src/runtime/site-provisioner.ts`) | il controllo **vincolante**, sotto il blocco; se il cliente di destinazione si è riempito dopo la messa in coda, l'operazione fallita viene registrata come `QUOTA_EXCEEDED` (e non `INTERNAL_ERROR`) con lo stesso `siteLimitError`; il sito resta dov'era |

Un sito affidato a `org_platform_ops` (amministratore senza `ownerOrganizationId`) non è mai limitato.

### 2.5 Idempotenza: la stessa chiave si ripete

`ManagedSitesService.create` ripete già la risposta originale per la stessa `Idempotency-Key` prima della transazione. Non basta: due richieste concorrenti con la stessa chiave si mettono in fila sul blocco della riga, e la seconda troverebbe il conteggio pieno e riceverebbe un 409 invece del 202 della prima. Nel `catch`, quindi, **se l'errore è `SiteLimitReachedError` si tenta prima `#replay(organizationId, idempotencyKey)`** e si restituisce il gemello se esiste; solo altrimenti si lancia `siteLimitError`. Con chiavi diverse, invece, due creazioni concorrenti per l'ultimo posto lasciano esattamente un sito (un 202 e un 409). La route generica `POST /sites` chiede una `Idempotency-Key` ma non la ripete: è un comportamento precedente a M1 (§4).

### 2.6 La route dell'amministratore: `PATCH /v1/admin/organizations/:orgId/site-limit`

È in `apps/api/src/controllers/admin-users.controller.ts` (`@Controller("v1/admin")`, metodo `updateSiteLimit`), quindi `app.module.ts` non cambia.

- **Richiesta:** `UpdateOrganizationSiteLimitInputSchema` = `{ maxSites: intero 0..10000 | null }`, `.strict()`; `MAX_SITES_CEILING = 10_000`. `null` toglie il limite.
- **Risposta:** 200 con `{ data: { organizationId, maxSites, usedSites } }` (`OrganizationSiteLimitDtoSchema`). È sincrona e non prende `Idempotency-Key`: imposta un valore.
- **Permesso:** `requireServerAdmin(this.authz, req, orgId, "organization")` **per primo**, prima di leggere il corpo e prima del 404. Richiede `platform.users.manage`, che ha solo `infrastructure_admin` (non `hosting_admin`). Il proprietario di un cliente, un collaboratore, un utente senza ruolo e un chiamante anonimo sono rifiutati prima che il corpo venga letto (401/403, con riga di audit `denied` dove previsto).
- **404** (`NOT_FOUND`, «Customer not found.») per `org_platform_ops` e per un'organizzazione sconosciuta.
- **Audit:** `admin.customer.site_limit` (`targetType: organization`, `targetId: orgId`) con `details: { from, to }`, scritto **nella stessa transazione** della modifica tramite `recordAudit(auth, req, input, tx)`. Nessun segreto nell'audit.
- **Abbassare il limite sotto l'uso attuale è consentito:** i siti esistenti restano (non si cancella né si ferma nulla), i nuovi sono rifiutati, compreso un sito spostato a quel cliente. La risposta mostra `usedSites > maxSites` e l'interfaccia lo segnala (§2.8).

### 2.7 DTO e OpenAPI

In `packages/contracts/src/resources.ts`:

- `OrganizationDetailDto.maxSites` (intero ≥ 0 o `null`, obbligatorio); l'uso è il già esistente `siteCount`.
- `AdminSitesListDto.customers[]` aggiunge `maxSites` (nullable) e `siteCount`; `ManagedSitesService.listAll` li riempie con `organizations.maxSites` e `countSitesByOrganization`.
- `getOrganization` in `organizations.controller.ts` restituisce `maxSites`.

In `docs/api/openapi.yaml`: nuovo percorso `/v1/admin/organizations/{orgId}/site-limit` (`adminUpdateOrganizationSiteLimit`, 200/400/401/403/404), gli schemi `UpdateOrganizationSiteLimitInput` (`additionalProperties: false`) e `OrganizationSiteLimitDto`, i campi nuovi dei due DTO e, sulle quattro operazioni di §2.4, la risposta 409 `QUOTA_EXCEEDED` con la nota `details[0].reason: site_limit_reached`.

### 2.8 Il web

- **BFF:** `apps/web/src/app/api/admin/organizations/[orgId]/site-limit/route.ts` (`PATCH`): valida il segmento `orgId`, verifica CSRF e Origin, valida il corpo con lo schema stretto del contratto e inoltra a `v1/admin/organizations/<orgId>/site-limit`; la risposta d'errore dell'API, `details` compresi, arriva invariata al browser.
- **Console amministratore:** la scheda `apps/web/src/components/admin/customer-site-limits.tsx` (`CustomerSiteLimits`) è montata in `/admin/sites` (`apps/web/src/app/admin/sites/page.tsx`) sopra l'elenco dei siti. Una riga per cliente con l'uso («3 di 5», oppure «3 (nessun limite)»), il badge «Limite raggiunto» quando `siteCount >= maxSites` e la finestra «Modifica limite» (numero da 0, casella «Nessun limite»). Il testo avverte che abbassare il limite non tocca i siti esistenti, e mostra l'avviso «ha già N siti» se il nuovo valore è sotto l'uso. Il salvataggio invia `PATCH` con `X-CSRF-Token` tramite `keyedSend` e poi `router.refresh()`. `parseSiteLimit` usa lo schema del contratto, quindi ciò che il contratto rifiuta non parte.
- **Rifiuti dell'amministratore:** `adminSiteErrorText` (in `change-owner-dialog.tsx`, usata anche da `create-site-for-customer-dialog.tsx`) mostra la frase dedicata `admin.sites.limitReached` quando il codice è `QUOTA_EXCEEDED` e il motivo `site_limit_reached`; ogni altro rifiuto conserva il testo del suo codice.
- **Cliente, `/sites/new`:** la pagina legge l'organizzazione (`fetchServerOrg`) e passa a `NewSite` (`apps/web/src/components/customer/new-site.tsx`) il limite `{ used: siteCount, max: maxSites }`, oppure `null` se non c'è limite o la lettura fallisce. Con un limite compare la riga d'uso **«N di M siti»**. Con `used >= max` (anche dopo che il limite è stato abbassato) compare lo **stato pieno**: un avviso con il numero massimo, il consiglio di eliminare un sito o chiedere all'amministratore, e il modulo non viene mostrato. Se invece qualcun altro ha preso l'ultimo posto dopo il caricamento, `createErrorView` mostra la frase `limitReachedSubmit` e chiede di ricaricare i dati.
- **Visita di supporto:** la visita non ha `organization.read`; la lettura sarebbe rifiutata con 403 e registrata come `denied` a ogni caricamento. La pagina quindi **salta `fetchServerOrg`** quando `support` è impostato (commit `229b39f`): nessuna riga d'uso, ma il rifiuto di §2.4 arriva comunque con la sua frase.
- **Testi:** le chiavi `site.create.usage`, `site.create.limitReached`, `site.create.limitReachedSubmit`, `admin.sites.limitReached` e `admin.sites.customers.*` sono in `apps/web/src/i18n/it.ts` ed `en.ts`. Nulla va nell'oggetto `errors` di primo livello (`QUOTA_EXCEEDED` vi ha già altri significati). I testi rivolti al cliente non usano le parole vietate dal test `ui-copy`.

## 3. Alternative scartate

- **Usare `resource_quotas.max_sites`:** sono righe per cliente popolate con un valore fisso e mai aggiornate (`used_sites` non cambia): confonderebbe due concetti e il valore predefinito 10 verrebbe preso per il limite.
- **Una colonna `NOT NULL` con un valore predefinito:** imporrebbe un limite ai clienti esistenti e romperebbe la compatibilità con il rollback; `NULL` = illimitato conserva il comportamento attuale.
- **Controllare solo nelle route:** lo spostamento avviene in un lavoro in background e la route generica chiama il database direttamente; il controllo vincolante deve stare nelle due funzioni del database, sotto il blocco.
- **Controllare solo al momento della messa in coda dello spostamento:** il cliente di destinazione può riempirsi nel frattempo; il controllo in coda è solo consultivo.
- **Contare solo i siti «attivi»:** un sito in eliminazione, fallito o fermo occupa comunque risorse e una riga; escluderli permetterebbe di aggirare il limite creando e lasciando in `failed`.
- **Conteggio senza blocco o blocco più forte (`FOR UPDATE`):** senza blocco due richieste concorrenti superano il limite; `FOR UPDATE` bloccherebbe anche gli inserimenti con chiave esterna sotto la stessa organizzazione.
- **Un `ErrorCode` nuovo (`SITE_LIMIT_REACHED`):** cambierebbe gli elenchi pinned dei codici e i cataloghi; il motivo nel dettaglio basta e il web già legge `details[0].reason`.
- **Mettere il dettaglio dell'uso nell'errore del database e lasciare il filtro:** il filtro perde i `details`; serve un `ControlPlaneError`.
- **Un elenco dei siti gestiti con il limite per il cliente:** non esiste un endpoint di elenco dei siti gestiti (l'elenco del cliente è `GET /v1/organizations/:orgId/sites`, un array semplice); l'uso sta in `OrganizationDetailDto`, che ha già `siteCount`.
- **Rifiutare l'abbassamento del limite sotto l'uso:** costringerebbe l'amministratore a cancellare siti prima di potere fermare nuove creazioni; l'effetto voluto è «tieni quelli che hai, niente nuovi».

## 4. Limiti noti

1. **Un cambio di proprietario ripetuto con la stessa chiave può rispondere 409.** Il controllo consultivo di `reassign` precede la ripetizione della chiave: se il cliente di destinazione si è riempito fra le due richieste, il secondo invio riceve 409 invece del 202 originale. Lo spostamento della prima richiesta fallirebbe comunque (`assertSiteMovable` si comporta allo stesso modo).
2. **La route generica `POST /v1/organizations/:orgId/sites` non ripete la `Idempotency-Key`:** la chiede ma non la usa; è precedente a M1 e non è stata modificata.
3. **Una visita di supporto non vede la riga «N di M»:** non ha `organization.read`. Non può comunque aggirare il limite: la creazione riceve lo stesso 409 con la sua frase.
4. **Il limite conta le righe, non le risorse:** un sito grande e uno piccolo pesano uguale; non esistono limiti di CPU, memoria o disco per cliente in questo ADR.
5. **Un sito la cui eliminazione fallisce tiene il suo posto** finché la riga non viene rimossa (§2.2).
6. **Abbassare il limite sotto l'uso non ferma né elimina nulla:** il cliente resta «sopra il limite» finché non cancella siti; l'unica conseguenza è il rifiuto dei nuovi.
7. **Un cambio di proprietario in background che fallisce per il limite** lascia l'operazione fallita (`QUOTA_EXCEEDED`) e il sito marcato come degradato; l'amministratore alza il limite del cliente di destinazione (o libera un posto) e usa «Riprova».
8. **`resource_quotas.max_sites`/`used_sites` restano fuorvianti** (§2.1): ripulirli o allinearli è una questione separata, fuori da M1.
9. **Test dell'amministratore sensibile al carico:** nella revisione, una prova di `apps/api/test/admin-route-guard.integration.test.ts` ha superato il timeout predefinito di 5 secondi con la macchina carica; ogni nuova route amministratore rallenta quel giro di verifiche. Non è un difetto di M1: nel commit `cabb4bc` le due prove di giro hanno un timeout di 60 secondi (`SWEEP_TIMEOUT_MS`).
10. **Revisione del proprietario in attesa** (§8).

## 5. Divergenze

Non esiste una specifica numerata da cui questo ADR diverga: la decisione nasce dalla richiesta del proprietario. Le sole divergenze dal progetto iniziale (`design/m1-site-limit.md`) sono due:

| Punto del progetto | Questo ADR | Motivo |
|---|---|---|
| scheda `customers-card.tsx` con una finestra «Modifica limite» | `customer-site-limits.tsx` (`CustomerSiteLimits`), con `parseSiteLimit` e `siteUsageText` esportati | i nomi dei file e dei metodi sono stati scelti dal web; il comportamento è lo stesso |
| la pagina `/sites/new` legge sempre l'organizzazione; una visita di supporto non vede l'uso | la lettura è saltata durante la visita (`229b39f`) | la lettura sarebbe rifiutata con 403 e registrata come `denied` a ogni caricamento (rilevato dalla revisione di M1) |

## 6. Minacce

| Minaccia | Contromisura | Dove |
|---|---|---|
| Un cliente aggira il limite con la route generica `POST /sites` | stesso controllo nella stessa funzione del database (`createSiteTransactional`) | §2.3, `apps/api/test/site-limit.integration.test.ts` |
| Corsa fra due creazioni per l'ultimo posto | riga dell'organizzazione bloccata con `FOR NO KEY UPDATE`, conteggio dopo il blocco | §2.3 |
| Aggiramento con il cambio di proprietario | controllo vincolante in `moveSiteToOrganizationTransactional`, sotto lo stesso blocco | §2.3, §2.4 |
| Un cliente alza da sé il proprio limite | la route richiede `platform.users.manage` (solo `infrastructure_admin`), controllato prima di leggere il corpo | §2.6 |
| Cliente senza limite per errore, o cliente della piattaforma limitato | `org_platform_ops` risponde 404 alla modifica e non ha mai un limite | §2.1, §2.6 |
| Modifica del limite senza traccia | riga `admin.customer.site_limit` `{from, to}` nella stessa transazione | §2.6 |
| Deadlock fra creazione, spostamento, importazione TLS e modifica del limite | ordine unico dei blocchi: organizzazione → sito → TLS → domini | §2.3 |
| Doppio 202 o falso 409 con la stessa chiave | ripetizione nel `catch` di `SiteLimitReachedError` | §2.5 |
| Righe di audit `denied` indesiderate da una visita di supporto | `/sites/new` salta la lettura dell'organizzazione | §2.8 |

## 7. Verifica

Test automatici, tutti con prova scritta prima del codice:

- **Database** — `packages/database/test/site-limit.test.ts`: la migrazione `0023` aggiunge una colonna nullable senza DEFAULT e il vincolo rifiuta `-1` e accetta `0` e `NULL`; compatibilità con il rollback (righe esistenti illimitate, gli `INSERT` della release precedente senza `max_sites` funzionano, la seconda esecuzione è innocua); `NULL` = illimitato; il sito oltre il limite dà `SiteLimitReachedError` e non lascia sito, dominio o audit; `max 0`; contano i siti in `deploying` e `maintenance`; il limite è per cliente; abbassare sotto l'uso; spostamento verso un cliente pieno (il sito resta) e verso uno con posto; `updateOrganizationSiteLimitTransactional` (valore precedente, uso, `null` per l'organizzazione sconosciuta); `countSitesByOrganization`; due creazioni parallele lasciano un sito, più la verifica sul sorgente che il blocco sia `.for("no key update")` (PGlite serializza). La migrazione è nei quattro elenchi di `packages/database/test/phase2-database.test.ts` e `packages/database/test/site-sftp-users-database.test.ts`.
- **Contratti** — `packages/contracts/test/site-limit.test.ts`: l'input accetta `0`, `5`, `10000`, `null` e rifiuta `-1`, `1.5`, `"3"`, il valore mancante, `10001` e chiavi extra; i DTO portano i campi nuovi; la costante del motivo e il tetto sono pinned; non c'è alcun `ErrorCode` nuovo.
- **API** — `apps/api/test/site-limit.integration.test.ts`: la `PATCH` risponde 200 e scrive l'audit, `null` toglie il limite, il tetto è accettato, 404 per cliente sconosciuto e per `org_platform_ops`, rifiuto di chi non è amministratore di server prima della lettura del corpo, anche il proprietario di un altro cliente e un anonimo; creazione del cliente, dell'amministratore e generica rifiutate con un solo dettaglio `site_limit_reached` e senza lasciare nulla; `limit 0`; creazione per `org_platform_ops` mai limitata; limite per cliente; ripetizione della stessa chiave anche a limite pieno; due creazioni concorrenti con la stessa chiave (il gemello è ripetuto) e con chiavi diverse (un sito); alzare, abbassare, eliminare per liberare il posto; coda dello spostamento verso un cliente pieno (409) e con posto (202); lo spostamento in background che trova il cliente pieno (`QUOTA_EXCEEDED`, `cabb4bc`); `maxSites` e `siteCount` nel dettaglio dell'organizzazione e nell'elenco `GET /v1/admin/sites`. Toccati anche `apps/api/test/admin-sites.integration.test.ts` e `apps/api/test/admin-route-guard.integration.test.ts`.
- **Web** — `apps/web/test/admin-site-limit.test.ts` (scheda dei clienti, `parseSiteLimit`, `siteUsageText`, pagina `/admin/sites`, frase dedicata del rifiuto, chiavi IT/EN), `apps/web/test/site-limit-bff.test.ts` (segmento, CSRF e Origin, corpo, sessione, rifiuto dell'API), `apps/web/test/create-site.test.ts` (riga d'uso, stato pieno con il modulo nascosto, `limit` a `0` e sotto l'uso, frase del rifiuto in invio, visita di supporto senza `fetchServerOrg`); il test `ui-copy` resta verde.
- **Revisione:** tre revisioni (database e API; contratti, OpenAPI e web; sicurezza) non hanno trovato aggiramenti. I due rilievi bassi sono stati sistemati (`229b39f`, `cabb4bc`) o annotati (§4, punto 1).

Commit di M1: `5be7345` (database), `4b76067` (contratti), `23fbcd2` (API), `68512ee` (OpenAPI), `3ab4975` (web), `229b39f` e `cabb4bc` (correzioni dalla revisione).

## 8. Come costruito: voci aperte

**Revisione del proprietario: in attesa.** Lo stato `APPROVATO` descrive il codice consegnato (M1), non un'approvazione del proprietario. Decisioni che il proprietario può rivedere: il limite si conta sulle righe di `sites` senza distinguere gli stati (§2.2); l'abbassamento sotto l'uso è consentito (§2.6); `org_platform_ops` è esente (§2.1); `resource_quotas.max_sites` resta inutilizzato (§2.1). README e `HARNESS.md` sono aggiornati da un'attività di documentazione successiva.
