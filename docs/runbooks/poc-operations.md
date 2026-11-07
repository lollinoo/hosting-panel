# Runbook Operativo POC v0.1 (`hosting-panel`)

Questo runbook documenta le procedure operative per la gestione dei principali incidenti e anomalie di integrazione tra il Control Plane di Hosting Panel e i provider Coolify v4 upstream, in conformità a `HCP-SPEC-001` (Appendice A #8).

---

## Indice

1. [Procedura 1: Revoca o Rotazione Token Coolify (AC-009)](#procedura-1-revoca-o-rotazione-token-coolify-ac-009)
2. [Procedura 2: Indisponibilità Coolify o Rate-Limit 429 (AC-008)](#procedura-2-indisponibilità-coolify-o-rate-limit-429-ac-008)
3. [Procedura 3: Recupero Operazioni in Stato `unknown` (AC-007)](#procedura-3-recupero-operazioni-in-stato-unknown-ac-007)
4. [Procedura 4: Fallimento Health Probe Post-Deploy (AC-010)](#procedura-4-fallimento-health-probe-post-deploy-ac-010)

---

## Procedura 1: Revoca o Rotazione Token Coolify (AC-009)

### Sintomo e Diagnosi
- Le chiamate di sincronizzazione o mutazione verso Coolify falliscono con HTTP `401 Unauthorized` o `403 Forbidden`.
- Nel Control Plane, le chiamate API verso i client restituiscono un errore normalizzato di piattaforma (es. `UPSTREAM_AUTH_ERROR` o `502 Bad Gateway`).
- **Garanzia di sicurezza (`AC-017` / §7.5)**: I token revocati e le credenziali Bearer **non vengono mai scritti nei log** né restituiti nei body JSON ai client browser; la funzione di redazione ricorsiva maschera qualsiasi pattern di secret.

### Azione Correttiva
1. **Generazione del nuovo token su Coolify**:
   - Accedere alla dashboard amministrativa dell'istanza Coolify v4 (`https://<coolify-host>`).
   - Navigare in **Keys & Tokens -> API Tokens**.
   - Generare un nuovo Personal Access Token con i soli privilegi necessari al Control Plane (least privilege).
2. **Aggiornamento credenziali nel Secret Vault del Control Plane**:
   - Tramite la dashboard di amministrazione del Control Plane (`/admin/providers`), individuare il provider coinvolto.
   - Inserire il nuovo Bearer Token nel campo di aggiornamento credenziali.
3. **Verifica della connettività**:
   - Cliccare sul pulsante **Test Connessione** (`POST /api/bff/admin/providers/:id/test`).
   - Verificare che il risultato indichi stato verde (`200 OK`) con tempo di risposta e versione provider convalidati.
   - Non è necessario il riavvio dei processi API grazie al caricamento dinamico delle chiavi per provider dal Secret Vault.
4. **Verifica Audit Log**:
   - Consultare `/admin/audit` per confermare la registrazione dell'evento di rotazione e la chiusura degli allarmi di autenticazione upstream.

---

## Procedura 2: Indisponibilità Coolify o Rate-Limit 429 (AC-008)

### Sintomo e Diagnosi
- Il provider Coolify upstream è sovraccarico o risponde con HTTP `429 Too Many Requests`.
- L'header standard `Retry-After` (in secondi o timestamp HTTP-Date) viene emesso da Coolify.
- Nel log di sistema appaiono messaggi di sospensione temporanea del provider:
  ```text
  [coolify-adapter] Host <coolify-host> returned 429; cooling down for 2000ms...
  ```

### Comportamento Automatico del Sistema
- Il `CoolifyV4Adapter` attiva un cooldown automatico (minimo `defaultCooldownMs = 2000ms`, fino a un tetto di sicurezza `maxCooldownMs = 15000ms`).
- Tutte le richieste non critiche verso quel provider vengono temporaneamente messe in pausa.
- Gli eventi outbox in corso **non vengono distrutti**: rimangono nella coda o vengono ripianificati con backoff esponenziale e jitter per evitare l'effetto thundering herd.

### Azione Operativa Manuale
1. **Divieto di retry a raffica**: Non effettuare chiamate manuali ripetute verso il provider.
2. **Verifica dello stato di Coolify**:
   - Controllare lo stato delle risorse computazionali (CPU, RAM, disco) sull'host su cui risiede Coolify.
   - Verificare la configurazione del reverse proxy (Nginx, Traefik o Caddy) davanti a Coolify: se il rate-limit è applicato a livello di reverse proxy, considerare l'aumento della soglia di burst per l'IP del Control Plane.
3. **Regolazione dei parametri del Control Plane**:
   - Se il volume di richieste legittime supera stabilmente la soglia, è possibile aumentare l'intervallo del worker outbox impostando `WORKER_INTERVAL_MS` nel file d'ambiente (es. `1000` o `2000`).

---

## Procedura 3: Recupero Operazioni in Stato `unknown` (AC-007)

### Regola Fondamentale (Divieto di Replay Cieco POST)
> [!CAUTION]
> È **SEVERAMENTE VIETATO** eseguire un replay cieco della richiesta HTTP `POST` originale verso Coolify se una transizione va in timeout di rete o riceve una risposta ambigua (504 Gateway Timeout, interruzione socket TCP).
> Inviare una seconda POST quando la prima potrebbe essere già in esecuzione lato Coolify può causare corruzione dello stato, lock contention distruttiva o deploy duplicati.

### Ciclo di Vita e Meccanismo di Protezione
- Quando una mutazione (deploy, restart, upgrade) subisce un timeout o un'interruzione di rete durante la chiamata a Coolify:
  1. L'operazione transita nello stato **`unknown`** (`AC-007` / §8.1).
  2. Il lock di mutazione della risorsa (`resource_mutation_locks`) **rimane acquisito** per impedire che altri utenti o job concorrenti tentino ulteriori modifiche sulla stessa applicazione.
  3. L'operazione viene inserita nella coda di riconciliazione dell'Outbox Reconciler.

### Procedura di Risoluzione
1. **Riconciliazione Automatica (Idempotent GET Polling)**:
   - Il worker esegue periodicamente richieste `GET /api/v1/applications/:uuid` per verificare lo stato effettivo del deployment su Coolify.
   - Non appena Coolify riporta che il container è in esecuzione (`running`), l'operazione transita automaticamente a `succeeded` e il lock della risorsa viene rilasciato.
   - Se Coolify segnala che il deploy è fallito (`failed`), l'operazione transita a `failed` con il dettaglio dell'errore e il lock viene rilasciato.
2. **Intervento Manuale (in caso di stallo prolungato oltre il timeout di riconciliazione)**:
   - Aprire la vista dettagli dell'operazione: `/o/:orgSlug/operations/:opId`.
   - Verificare i log e lo stato dell'applicazione su Coolify v4.
   - Se il container è attivo e funzionante: invocare la riconciliazione manuale via API / UI.
   - Se il deploy è morto o non è mai partito: rilasciare manualmente il lock marcando l'operazione come `failed` o `cancelled` via CLI/admin, consentendo all'utente di lanciare un nuovo deploy pulito.

---

## Procedura 4: Fallimento Health Probe Post-Deploy (AC-010)

### Sintomo e Diagnosi
- Il deployment su Coolify si è concluso con HTTP 200 / 202 (`accepted_by_provider`).
- Tuttavia, la verifica post-deploy indipendente effettuata da `HealthProbeService` fallisce (porta HTTP non risponde, endpoint `/health` restituisce status `5xx`, o timeout di connessione).
- Risultato nel Control Plane (`AC-010`):
  - L'operazione transita a **`failed`**.
  - Lo stato applicativo viene impostato a **`degraded`** (o `unhealthy`).
  - Il campo `healthCheckFailedAt` registra il timestamp esatto del mancato probe.
  - Viene registrato un evento di audit con l'esito diagnostico.

### Procedura di Indagine e Risoluzione
1. **Analisi dei log applicativi**:
   - Navigare su `/o/:orgSlug/applications/:appId`.
   - Ispezionare i log del container: cercare eccezioni all'avvio, fallimenti di connessione al database (es. stringa `DATABASE_URL` errata o credenziali non sincronizzate), o crash all'inizializzazione.
2. **Verifica della configurazione del Probe**:
   - Se l'applicazione impiega più tempo a completare le migrazioni o l'inizializzazione interna prima di aprire la porta HTTP, verificare se il timeout del probe o il delay iniziale devono essere estesi.
3. **Ripristino o Rollback**:
   - Correggere le variabili d'ambiente o il commit dell'applicazione.
   - Eseguire un nuovo deploy (`POST /o/:orgSlug/applications/:appId/deploy`).
   - Quando il nuovo deploy supera l'health check, lo stato applicativo torna automaticamente a `healthy`.
