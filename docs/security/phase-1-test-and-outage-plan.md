# Piano di Sicurezza, Matrice delle Minacce e Protocollo di Outage Fase 1 (`HCP-SPEC-002`)

- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §5.3, §8 Step 4, `AC-F1-08`, `AC-F1-10`  
- **Stato:** Normativo / Approvato  

---

## 1. Obiettivi del Documento

Il presente documento definisce la strategia di validazione della sicurezza per la Fase 1 di Hosting Control Panel (`HCP-SPEC-002`). Esso comprende:
1. La **Matrice di Verifica delle Minacce e Mitigazioni** (§5.3), che correla ciascun vettore di attacco identificato con le contromisure architetturali implementate e con i relativi sensori oggettivi di test.
2. Il **Protocollo Normativo di Test per l'Outage del Control Plane (`AC-F1-08`)**, che stabilisce le condizioni sperimentali per verificare l'invariante fondamentale di indipendenza tra Control Plane e Data Plane (`CP-01`).
3. La formalizzazione della **clausola di non esecuzione a runtime per la Fase 1 (`AC-F1-10`)**.

---

## 2. Matrice di Verifica Minacce e Mitigazioni (`HCP-SPEC-002` §5.3)

| ID | Nome della Minaccia | Descrizione e Vettore di Attacco | Livello di Rischio | Mitigazione Architetturale (Fase 1) | Sensore Oggettivo di Validazione |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **TH-01** | **BOLA / IDOR Cross-Tenant** | Un utente autenticato dell'Organizzazione A tenta di leggere o modificare risorse (siti, servizi, revisioni, domini) dell'Organizzazione B manipolando gli UUID nelle chiamate REST. | **CRITICO** | Isolamento su tre livelli: filtro query SQL con `organization_id`, vincoli relazionali di chiave composta `(organization_id, id)` nel database e policy engine default-deny (`packages/authz`). L'API restituisce `404 Not Found` per prevenire enumerazione di risorse altrui. | Test di integrazione `apps/api` e unit test in `packages/authz` (`AC-F1-02`). |
| **TH-02** | **Fuga da Socket Docker (`docker.sock`)** | Un processo o un manifest tenta di montare `/var/run/docker.sock` per comunicare direttamente con il demone Docker dell'host ed evadere dai namespace. | **CRITICO** | Divieto assoluto: `PolicyEngine` rigetta qualsiasi manifest contenente mount di socket (`AC-F1-04`). Nel Control Plane, `DockerExecutorPort` è un'astrazione pura disabilitata in Fase 1 (`NOT_SUPPORTED`). | Test del validator di sicurezza in `packages/policy-engine` e test `packages/executor-contracts`. |
| **TH-03** | **Escalation di Ruolo HostingAdmin -> Root** | Un amministratore delegato all'hosting tenta di accedere a funzionalità di manutenzione del sistema operativo per ottenere privilegi di root. | **ALTO** | Rigida segregazione RBAC (`HCP-SPEC-002` §4.1–4.2): il ruolo `hosting_admin` possiede un esplicito diniego (`deny`) su `host.maintenance.*`, `host.security.manage` e `host.docker.engine.manage`. | Test della matrice di autorizzazione in `packages/authz` (`AC-F1-03`). |
| **TH-04** | **Iniezione di Flag Docker Insicuri / Compose Privilegiato** | Un tenant tenta di sottomettere uno stack con `privileged: true`, `network_mode: host`, `pid: host`, `ipc: host` o capability non permesse (`CAP_SYS_ADMIN`). | **CRITICO** | Il modulo `StackSecurityValidator` analizza il payload dichiarativo prima della generazione della revisione: se rileva flag vietati, solleva eccezione `422 INVALID_STACK_SECURITY_SPEC` e interrompe l'operazione. | Suite di test di sicurezza in `packages/policy-engine` (`AC-F1-04`, `F1-012`). |
| **TH-05** | **Path Traversal sui Volumi Host** | Un payload tenta di montare directory arbitrarie del sistema host (es. `/etc`, `/root`, `../../etc/shadow`) tramite bind mount manipolati. | **CRITICO** | Validazione e sanitizzazione dei mount path: ammessi solo volumi logici gestiti o percorsi confinati all'interno del namespace dell'organizzazione cliente. Qualsiasi sequenza `..` o mount radice viene bloccata. | Test unitari su `ApprovedServiceSpec` in `packages/policy-engine`. |
| **TH-06** | **Collisione di Allocazione su Host Dedicated** | Richieste concorrenti tentano di allocare due organizzazioni clienti differenti sul medesimo host dedicato. | **ALTO** | Metodo transazionale `allocateHostTransactional` (`packages/database`) protetto da lock di riga `FOR UPDATE` e vincolo DDL escludente `EXCLUDE USING btree (host_id WITH =) WHERE (hosting_mode = 'dedicated' AND status = 'active')`. | Test di concorrenza transazionale su database PostgreSQL/PGlite (`AC-F1-01`). |
| **TH-07** | **Race Condition su Superamento Quote** | Un tenant lancia molteplici deploy o ridimensionamenti simultanei per consumare RAM/CPU oltre la quota contrattuale autorizzata. | **ALTO** | Calcolo atomico delle quote (`reserveQuotaTransactional`) con prenotazione preventiva delle risorse (`QuotaReservation`) all'interno di una transazione serializzabile. | Test di carico e concorrenza sulle quote in `packages/database` (`AC-F1-07`). |
| **TH-08** | **Crash del Worker & Replay Cieco POST** | Un worker outbox si interrompe bruscamente durante una chiamata di mutazione verso il runtime, lasciando l'operazione in stato indeterminato. | **MEDIO** | Macchina a stati finiti formale: transizione nello stato protetto `unknown` con mantenimento del lock di risorsa. Divieto assoluto di replay cieco con `POST`; la ripresa avviene solo tramite query idempotenti `GET`. | Test della macchina a stati in `packages/hosting-domain` e riconciliatore `apps/api`. |
| **TH-09** | **Compromissione del Pannello Web (Perimetro BFF)** | Un attaccante sfrutta vulnerabilità XSS nel client browser per estrarre credenziali o token amministrativi. | **ALTO** | Backend-For-Frontend (BFF) con cookie di sessione JWE cifrati `HttpOnly` e `SameSite=Lax`. Nessun token API, JWT Bearer o secret dell'infrastruttura viene mai esposto al codice JavaScript del browser o nel DOM. | Test di perimetro BFF e sanitizzazione DTO in `apps/web`. |
| **TH-10** | **Drift Configurativo da Interventi Manuali via SSH** | Un operatore modifica manualmente un container o una configurazione direttamente sull'host tramite sessione SSH non tracciata. | **MEDIO** | Il drift detector calcola la discrepanza tra `StackRevision` (Desired State) e `ObservedState` (Actual State), etichettando la risorsa come `drifted` e registrando l'evento di audit. | Test del drift evaluator in `packages/hosting-domain`. |

---

## 3. Protocollo Normativo di Outage del Control Plane (`AC-F1-08`)

### 3.1 Scopo e Invariante Fondamentale (`CP-01`)
L'invariante di architettura **`CP-01`** stabilisce che:
> *«Il Control Plane (Web UI, API, Worker e Database di gestione) e il Data Plane (Reverse Proxy Ingress, Container applicativi dei clienti, Volumi di storage e Database applicativi) operano in domini di fallimento completamente disaccoppiati. Un'avaria totale o un arresto programmato del Control Plane non deve interrompere l'erogazione del traffico web verso i siti dei clienti.»*

Il presente protocollo descrive i passi operativi per iniettare l'outage e verificare l'invariante.

### 3.2 Precondizioni del Test
1. Host VPS attivo con Linux kernel 6.x+, demone Docker attivo e runtime configurato (target Fase 2).
2. Data Plane avviato e operativo:
   - Reverse proxy di ingress (es. Traefik o Caddy) in esecuzione su porte HTTP `80` e HTTPS `443`.
   - Almeno 2 siti di tenant attivi con container applicativi in stato `running`.
   - Almeno 1 database applicativo di supporto per i siti attivo e con connessioni aperte.
3. Generatore di carico sintetico (es. `k6` o `autocannon`) configurato per inviare 50 richieste HTTP/sec verso i domini pubblici dei siti con verifica dello status `200 OK`.

### 3.3 Fasi Operative dell'Iniezione di Outage
```text
T0: Baseline nominale
    ├── Il generatore di carico invia 50 req/s -> 100% 200 OK
    └── Control Plane e Data Plane entrambi attivi

T1: Arresto violento Web BFF (SIGKILL apps/web)
    ├── La console utente diventa irraggiungibile (503 / Connection Refused sulla porta del pannello)
    └── VERIFICA: Il traffico verso i siti dei tenant prosegue con 100% 200 OK

T2: Arresto violento API Control Plane (SIGKILL apps/api)
    ├── L'endpoint REST /v1 cessa di rispondere
    └── VERIFICA: Il traffico verso i siti dei tenant prosegue con 100% 200 OK

T3: Arresto violento Worker Outbox e Database di Control Plane
    ├── Nessun processo del Control Plane rimane in esecuzione
    └── VERIFICA: I container dei siti e il reverse proxy rimangono UP e continuano a servire traffico

T4: Finestra di Outage Prolungato (Durata: 10 minuti)
    ├── Generazione ininterrotta di carico sintetico sui siti
    └── Campionamento metriche: tassi di errore, latenza p95/p99, connessioni TCP

T5: Ripristino del Control Plane (Restart apps/api, apps/web, DB)
    ├── I processi del pannello si riavviano ed eseguono il bootstrap
    ├── Il riconciliatore interroga lo stato dei container sull'host
    └── VERIFICA: Nessun container applicativo viene riavviato o terminato; lo stato rilevato è in_sync
```

### 3.4 Metriche di Superamento (Pass/Fail Criteria)

| Parametro / Metrica | Soglia di Accettazione (Pass) | Criterio di Fallimento (Fail) |
| :--- | :--- | :--- |
| **Disponibilità HTTP Siti Tenant** | **100%** (zero codici `502`, `503`, `504` sul traffico applicativo) | `> 0` errori generati dalla caduta del Control Plane. |
| **Stato dei Container del Data Plane** | Uptime ininterrotto (nessun riavvio del container registrato dal daemon) | Container terminato, riavviato o posto in stato degraded. |
| **Connessioni TCP verso Ingress** | Nessuna connessione interrotta o reset (`ECONNRESET`) | Interruzione del listener sulle porte 80/443. |
| **Riconciliazione Post-Ripristino** | Riconnessione trasparente; `ObservedState` allineato su `in_sync` entro 30 secondi | Spuria emissione di comandi di ri-deploy o disallineamento dello stato. |

---

## 4. Clausola di Non Esecuzione a Runtime in Fase 1 (`AC-F1-10`)

> [!IMPORTANT]
> **Dichiarazione Formale di Esclusione a Runtime per la Fase 1**:  
> In rigorosa osservanza del criterio di accettazione **`AC-F1-10`** e dei non-goal definiti in `HCP-SPEC-002` §1.3:
> - **Questo protocollo di test di outage a runtime NON viene eseguito durante la Fase 1**, poiché il motore di esecuzione container reale (runtime Docker della Fase 2) non è ancora implementato.
> - Nella Fase 1, le interfacce verso il piano host (`DockerExecutorPort` e `HostAgentPort`) sono collegate a stub disabilitati che restituiscono `NOT_SUPPORTED`, impedendo l'avvio di container reali su socket Docker.
> - Il presente protocollo ha valore di **specifica contrattuale e architetturale vincolante**, pronta per essere eseguita integralmente non appena il runtime di Fase 2 sarà attivato.
