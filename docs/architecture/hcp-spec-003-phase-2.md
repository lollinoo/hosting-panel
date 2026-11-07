# HCP-SPEC-003 — Hosting Control Panel Docker-native

## Fase 2 — Topologia di processo, Docker Executor, Host Agent, IPC autenticato, hardening OS/systemd, Outbox/Reconciler ed esecuzione reale `AC-F1-08`

| Metadato | Valore |
|---|---|
| Identificativo | `HCP-SPEC-003` |
| Revisione | `1.0` |
| Data | 7 novembre 2026 |
| Stato | **Specifica normativa approvata per l'implementazione della Fase 2** (decisioni `/grill-me` `Q1`–`Q9` consolidate) |
| Lingua | Italiano, con nomenclatura tecnica in inglese |
| Documento di partenza | `HCP-SPEC-002`, rev. 1.0, 7 novembre 2026, «Fase 1 — Modello architetturale evolutivo: Dedicated → Shared → Multi-host» |
| Scopo | Chiudere `ADR-010`; progettare e implementare i demoni isolati `hp-docker-executor` e `hp-host-agent`, il canale IPC locale firmato, l'Outbox/Drift Reconciler, lo store segreti cifrato su `tmpfs`, l'ingress Data Plane senza `docker.sock`, l'hardening `systemd`/Linux e l'esecuzione reale del test di outage `AC-F1-08` su ambiente Linux dedicato |
| Destinatari | Product owner, architetto, sviluppatori, AI coding agent, QA e operatori infrastrutturali |

> **Uso del documento da parte di un AI agent.** Questa specifica traduce le decisioni architetturali approvate con il product owner (`Q1`–`Q9`) in un contratto esecutivo vincolante per la Fase 2. Prima di modificare codice, l'agente deve ispezionare lo stato effettivo del repository (`HARNESS.md`, `.agents/brain/decisions.md`, `.agents/brain/state.md`), eseguire la baseline dei sensori meccanici (`build`, `lint`, `typecheck`, `test`) e rispettare rigorosamente l'allowlist delle dipendenze approvate e i non-obiettivi residui (`ADR-011`, Shared Hosting, ACME/TLS, SFTP, Backup di produzione).

---

## 0. Executive summary

La Fase 1 (`HCP-SPEC-002`) ha consegnato il Control Plane logico completo: dominio relazionale canonico a 24 tabelle (`0001_phase1_docker_native.sql`), motore RBAC+ABAC default-deny a 4 livelli di autorità, policy engine di ammissione `Dedicated`/`Shared`, contratti tipizzati disabilitati (`NOT_SUPPORTED`) per `DockerExecutorPort` e `HostAgentPort`, API `/v1` NestJS 12 + Fastify 5 e UI a 3 console Next.js 16 + `shadcn@4.23.0` dietro perimetro BFF JWE `HttpOnly`.

La **Fase 2 (`HCP-SPEC-003`)** attiva il runtime operativo per la modalità **`Dedicated`** su VPS Linux autonoma, chiudendo formalmente `ADR-010` e validando dal vivo l'invariante fondamentale di disaccoppiamento tra Control Plane e Data Plane (`CP-01` / `AC-F1-08`).

### Decisioni cardine consolidate (`Q1`–`Q9`)

1. **Split Agents a 3 domini di privilegio separati (`Q2`, chiusura `ADR-010`)**:
   - `hp-api` / `hp-web` (Control Plane): nessun accesso a `/var/run/docker.sock` (`InaccessiblePaths=/var/run/docker.sock`) e zero Linux Capabilities.
   - `hp-docker-executor` (`apps/docker-executor`): demone standalone Node.js 24 + TypeScript (zero NestJS), utente non-root `hp-executor`, unico componente autorizzato a dialogare con `/var/run/docker.sock`.
   - `hp-host-agent` (`apps/host-agent`): demone standalone Node.js 24 + TypeScript (zero NestJS), utente non-root `hp-agent` confinato con sole `CAP_NET_ADMIN` + `CAP_DAC_READ_SEARCH` per telemetria host, manutenzione allowlisted e verifica postura `nftables`.
2. **Canale IPC locale firmato senza porte TCP (`Q3`, `ADR-010` + `ADR-008`)**:
   - Trasporto su Unix Domain Sockets dedicati (`/run/hosting-panel/executor.sock` e `/run/hosting-panel/host-agent.sock`, directory `0750`, socket `0660` ristretti al gruppo `hp-ipc`).
   - Autenticazione crittografica applicativa per singola richiesta (`node:crypto` HMAC-SHA256 / Ed25519 con `timestamp`, `nonce` anti-replay e SHA-256 canonico del body), già predisposta per un futuro trasporto mTLS verso il Management Hub (`ADR-008`) e compatibile con Named Pipe / loopback effimero per test portatili.
3. **Data Plane Ingress autonomo senza `docker.sock` (`Q4`, `TH-02`, `CP-01`)**:
   - `hp-docker-executor` parla con Docker Engine REST API (`v1.45+`) via `node:http` nativo, creando reti bridge isolate per ciascun `Site` (`hp_site_<siteId>_net`) e imponendo `Privileged: false`, `CapDrop: ["ALL"]`, `no-new-privileges:true`, `PidsLimit` e quote cgroups v2 CPU/RAM.
   - Il reverse proxy Data Plane è **Traefik v3 configurato con Dynamic File Provider in sola lettura** (`/var/lib/hosting-panel/ingress/dynamic:ro`, `watch: true`, `restart: unless-stopped`, **nessun mount di `/var/run/docker.sock`**): zero rischio di container escape dal proxy (`TH-02`), hot-reload atomico via `inotify` e sopravvivenza totale del traffico HTTP anche con Control Plane e agenti terminati.
4. **Zero processi `root` e hardening `systemd` (`Q5`, `TH-03`, `ADR-006`)**:
   - Tutti i processi girano come utenti dedicati privi di shell; `hp-host-agent` usa esclusivamente `execFile` su path assoluti fissi ed enum statici (divieto categorico di `sh -c` o interpolazione shell).
5. **Transactional Outbox su PostgreSQL, recovery `unknown` e Drift Reconciler *observe-only* (`Q6`, `TH-08`, `TH-10`)**:
   - Mutazioni asincrone (`202 Accepted`) orchestrate tramite `outbox_events` con `SELECT ... FOR UPDATE SKIP LOCKED` (compatibile con `pg` e `PGlite`, senza dipendenza obbligatoria da Redis/BullMQ).
   - In caso di crash in volo, transizione protetta in `unknown` e riconciliazione tramite query di sola lettura (`getObservedState`), senza replay cieco `POST`.
   - Il Drift Reconciler rileva le discrepanze `StackRevision.specHash` vs label container marcando `in_sync` o `drifted` + evento di audit, **senza mai riavviare o ricreare autonomamente i container attivi** (`AC-F1-08` step `T5`).
6. **Segreti cifrati `AES-256-GCM` e montaggio `tmpfs` `0400` (`Q8`, `F1-012`)**:
   - Migrazione additiva non distruttiva `0002_phase2_runtime_and_secrets.sql` con tabella `encrypted_secrets`; risoluzione JIT dei `secretRefs` su file read-only `0400` in `/run/hosting-panel/secrets/<serviceId>/<ref>` (pattern `*_FILE`), evitando qualsiasi segreto in chiaro in `Env`, `docker inspect`, `stack_revisions`, `outbox_events` o log.
7. **Target Ubuntu 24.04 LTS / Debian 12 ed esecuzione reale `AC-F1-08` (`Q7`, `Q9`)**:
   - Kit completo in `infra/systemd/` e `infra/linux/` (`bootstrap-dedicated.sh`, CLI break-glass, runner automatico `run-outage-ac-f1-08.mjs`) da eseguire dal vivo sull'ambiente Linux dedicato, accompagnato dallo sblocco veritiero delle 3 console `shadcn@4.23.0` (`PlatformCapabilitiesDto` dinamico con `runtimeBackend`).

---

## 1. Ambito di Fase 2 e non-obiettivi

### 1.1 Incluso in `HCP-SPEC-003` (Fase 2)

- Chiusura formale di `ADR-010` e redazione degli ADR operativi di Fase 2 (`ADR-013` IPC firmato e UDS, `ADR-014` Data Plane Traefik file-provider zero-sock, `ADR-015` Store segreti `AES-256-GCM` e mount `tmpfs`).
- Nuovi pacchetti/applicazioni monorepo `apps/docker-executor` e `apps/host-agent` (Node.js 24 + TypeScript, zero dipendenze esterne oltre l'allowlist approvata).
- Estensione compatibile di `@hosting-panel/contracts`, `@hosting-panel/executor-contracts`, `@hosting-panel/host-agent-contracts` e `@hosting-panel/database` (`0002_phase2_runtime_and_secrets.sql`).
- Worker Transactional Outbox, recovery `unknown`, Drift Reconciler *observe-only*, endpoint segreti cifrati e risposte `202 Accepted` in `apps/api` + aggiornamento `docs/api/openapi.yaml`.
- Aggiornamento delle 3 console `shadcn@4.23.0` in `apps/web` (lifecycle asincrono con `OperationTimeline`, gestione `secretRefs`, badge `in_sync`/`drifted`, telemetria host, stato demoni IPC, manutenzione allowlisted e verifica postura `nftables`).
- Unit `systemd` blindate (`infra/systemd/*.service`), script di bootstrap idempotente (`infra/linux/bootstrap-dedicated.sh`), CLI locale di break-glass ed esecuzione reale dello scenario di outage `AC-F1-08` (`infra/linux/run-outage-ac-f1-08.mjs`) sull'ambiente Linux dedicato.

### 1.2 Non-obiettivi espliciti di Fase 2 (`AC-F1-10` continuità)

Restano tassativamente fuori perimetro e marcati `false` in `PlatformCapabilitiesDto`:

- **Shared Hosting (`sharedHostingEnabled: false`)**: la transizione `dedicated -> shared` e le allocazioni `shared` continuano a restituire `409 SHARED_MODE_GATED` (`AC-F1-06`).
- **Quote disco per volumi Shared (`ADR-011`)**: `ADR-011` rimane esplicitamente in stato `OPEN — prima di Shared` (`HCP-SPEC-007`).
- **Emissione/rinnovo certificati ACME/TLS automatici (`acmeTlsRuntimeAvailable: false`)**: disciplinati in `HCP-SPEC-005` (in Fase 2 l'ingress Traefik opera in HTTP / TLS statico locale per validare il routing per dominio e `CP-01`).
- **Server SFTP chroot e file manager (`sftpAvailable: false`)**: disciplinati in `HCP-SPEC-005`.
- **Backup/restore incrementali S3 di produzione e provisioner DB multi-utente (`productionBackupRuntimeAvailable: false`)**: disciplinati in `HCP-SPEC-005`.
- **Management Hub multi-host remoto attivo**: disciplinato in `HCP-SPEC-008` (`ADR-008`).

---

## 2. Topologia di processo e chiusura di `ADR-010`

### 2.1 I tre domini di privilegio sull'host Linux

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ DOMINIO 1 — Control Plane & Web (Utenti: hp-web, hp-api | Zero root)       │
│  - hp-web.service (Next.js 16 BFF, JWE HttpOnly)                           │
│  - hp-api.service (NestJS 12 /v1 + Outbox Worker + Drift Reconciler)       │
│  - CapabilityBoundingSet= (VUOTO)                                          │
│  - InaccessiblePaths=/var/run/docker.sock                                  │
└───────────────┬─────────────────────────────────────────┬──────────────────┘
                │ UDS /run/hosting-panel/executor.sock    │ UDS /run/hosting-panel/host-agent.sock
                │ (0660 hp-executor:hp-ipc + HMAC/Ed25519)│ (0660 hp-agent:hp-ipc + HMAC/Ed25519)
                ▼                                         ▼
┌───────────────────────────────────────┐ ┌──────────────────────────────────┐
│ DOMINIO 2 — Docker Executor           │ │ DOMINIO 3 — Host Agent           │
│  - hp-docker-executor.service         │ │  - hp-host-agent.service         │
│  - User=hp-executor                   │ │  - User=hp-agent                 │
│  - SupplementaryGroups=docker hp-ipc  │ │  - SupplementaryGroups=hp-ipc    │
│  - CapabilityBoundingSet= (VUOTO)     │ │  - AmbientCapabilities=          │
│  - Accesso esclusivo a docker.sock    │ │    CAP_NET_ADMIN                 │
│  - Scrive rotte Traefik e tmpfs 0400  │ │    CAP_DAC_READ_SEARCH           │
│                                       │ │  - Solo execFile allowlisted     │
└───────────────┬───────────────────────┘ └───────────────┬──────────────────┘
                │ /var/run/docker.sock                    │ /proc, statfs, /usr/sbin/nft
                ▼                                         ▼
┌───────────────────────────────────────┐ ┌──────────────────────────────────┐
│ DATA PLANE — Docker Engine            │ │ LINUX KERNEL / OS                │
│  - hp_ingress_proxy (Traefik v3,      │ │  - Ubuntu 24.04 LTS / Debian 12  │
│    file provider :ro, ZERO sock)      │ │  - systemd + cgroups v2          │
│  - Reti isolate hp_site_<id>_net      │ │  - nftables (22, 80, 443)        │
│  - Container tenant (CapDrop: ALL)    │ │  - tmpfs /run/hosting-panel      │
└───────────────────────────────────────┘ └──────────────────────────────────┘
```

### 2.2 Struttura dei nuovi workspace nel monorepo

- `apps/docker-executor`:
  - Demone leggero in Node.js 24 + TypeScript senza framework pesanti (`node:http`, `node:net`, `node:fs/promises`, `node:crypto`).
  - Dipende esclusivamente da `@hosting-panel/config`, `@hosting-panel/contracts`, `@hosting-panel/hosting-domain`, `@hosting-panel/executor-contracts` e `zod`.
  - Supporta due adapter di esecuzione selezionabili via configurazione esplicita:
    1. `DockerEngineSocketAdapter`: parla realmente con `/var/run/docker.sock` (API `v1.45+`), governa reti `hp_site_<id>_net`, volumi `hp_vol_<svcId>_*`, segreti `tmpfs` e file di routing Traefik.
    2. `InMemoryDockerSimulatorAdapter`: simulatore deterministico fedele per test unitari/integrazione isolati e sviluppo locale su macchine prive di Docker.
- `apps/host-agent`:
  - Demone leggero in Node.js 24 + TypeScript (`node:http`, `node:fs/promises`, `node:child_process.execFile`, `node:os`, `node:crypto`).
  - Dipende esclusivamente da `@hosting-panel/config`, `@hosting-panel/contracts`, `@hosting-panel/host-agent-contracts` e `zod`.
  - Supporta:
    1. `LinuxSystemHostAdapter`: legge `/proc/stat`, `/proc/meminfo`, `fs.statfs`, informazioni kernel/OS e invoca `execFile` su path assoluti verificati (`/usr/sbin/nft`, `/usr/bin/df`, `/usr/bin/uname`).
    2. `InMemoryHostSimulatorAdapter`: simulatore deterministico per test e sviluppo non-Linux.

---

## 3. Protocollo IPC locale autenticato (`ADR-010` + `ADR-008`)

### 3.1 Trasporto

- **Produzione / Staging Linux**: HTTP/1.1 JSON su Unix Domain Socket:
  - Executor: `/run/hosting-panel/executor.sock` (owner `hp-executor:hp-ipc`, mode `0660`).
  - Host Agent: `/run/hosting-panel/host-agent.sock` (owner `hp-agent:hp-ipc`, mode `0660`).
  - Directory runtime: `/run/hosting-panel` gestita da `RuntimeDirectory=hosting-panel` con mode `0750`.
  - **MUST**: nessuna porta TCP (`0.0.0.0` né `127.0.0.1`) deve essere aperta dai due demoni in produzione Linux.
- **Portabilità Test / Dev non-Linux**: lo stesso server `node:http` accetta un path Named Pipe Windows (`\\.\pipe\hp-executor-<id>`) o socket effimero `127.0.0.1:0` esclusivamente quando `HP_IPC_TRANSPORT=pipe|loopback-test`.

### 3.2 Autenticazione crittografica per-messaggio e anti-replay

Ogni richiesta HTTP su IPC **DEVE** includere i seguenti header firmati tramite `node:crypto` (chiave simmetrica `HMAC-SHA256` a 256 bit da `/etc/hosting-panel/ipc.key` `0440` o coppia asimmetrica `Ed25519` pronta per il futuro Hub `ADR-008`):

- `X-HP-Key-Id`: identificativo della chiave attiva (supporto rotazione senza downtime).
- `X-HP-Timestamp`: epoch millisecondi UTC.
- `X-HP-Nonce`: UUIDv4 / 16 byte random esadecimali univoci per richiesta.
- `X-HP-Body-Sha256`: digest SHA-256 esadecimale del body raw (o stringa vuota `e3b0c442...` per `GET`).
- `X-HP-Signature`: firma su stringa canonica:
  ```text
  ${METHOD}\n${PATH_WITH_QUERY}\n${TIMESTAMP}\n${NONCE}\n${BODY_SHA256}
  ```

**Regole di verifica lato demone (`MUST`)**:
1. Rifiutare con `401 UNAUTHORIZED` qualsiasi richiesta priva degli header o con firma non valida (confronto in tempo costante `crypto.timingSafeEqual`).
2. Rifiutare con `401 UNAUTHORIZED` qualsiasi richiesta con `|now - timestamp| > 30_000 ms`.
3. Mantenere una cache in-memory dei `nonce` ricevuti negli ultimi `60_000 ms` (cap massimo protetto contro OOM) e rifiutare con `409 CONFLICT` qualsiasi riutilizzo di `nonce` (protezione anti-replay).
4. Validare il body con gli schemi `zod` condivisi prima di invocare qualsiasi logica operativa.

---

## 4. `hp-docker-executor`, confine Docker Engine e Data Plane Ingress

### 4.1 Hardening obbligatorio dei container tenant (`TH-02`, `TH-04`, `TH-05`)

Prima di invocare `POST /v1.45/containers/create` su `/var/run/docker.sock`, `hp-docker-executor` **DEVE**:

1. Ri-validare l'`ApprovedServiceSpec` contro `findUnsafeDockerInputFields` e `findPlaintextSecretKeys` (difesa in profondità: anche se `apps/api` fosse compromesso, `hp-docker-executor` rifiuta payload non conformi).
2. Forzare nella struct `HostConfig` inviata a Docker Engine:
   - `Privileged: false`
   - `CapDrop: ["ALL"]` (con eventuale aggiunta esplicita delle sole capability strettamente richieste da template certificati, es. `CHOWN`, `SETUID`, `SETGID`, `NET_BIND_SERVICE`; **MAI** `SYS_ADMIN`, `NET_ADMIN`, `SYS_MODULE`, `SYS_PTRACE`)
   - `SecurityOpt: ["no-new-privileges:true"]`
   - `NetworkMode`: rete bridge dedicata del sito `hp_site_<siteId>_net` (**MAI** `host` né `bridge` di default)
   - `PidsLimit`: default `256` (configurabile entro il tetto policy)
   - `NanoCpus`: `cpuMilli * 1_000_000`
   - `Memory`: `Number(memoryBytes)` + `MemorySwap: Number(memoryBytes)` (niente swap illimitato)
   - `RestartPolicy: { Name: "unless-stopped" }` (fondamentale per `CP-01` e sopravvivenza al reboot host)
3. Applicare label deterministiche di riconciliazione:
   - `io.hostingpanel.managed=true`
   - `io.hostingpanel.organization_id=<orgId>`
   - `io.hostingpanel.site_id=<siteId>`
   - `io.hostingpanel.service_instance_id=<serviceInstanceId>`
   - `io.hostingpanel.revision_number=<revisionNumber>`
   - `io.hostingpanel.spec_hash=<specHash>`
4. Consentire mount esclusivamente verso:
   - volumi Docker gestiti con prefisso `hp_vol_<serviceInstanceId>_*`;
   - file segreti in sola lettura `/run/hosting-panel/secrets/<serviceInstanceId>/<secretKey>:ro`.
   Qualsiasi bind-mount verso `/`, `/etc`, `/var/run`, `/proc`, `/sys`, `/root` o contenente `..` viene bloccato con errore `HOST_POLICY_DENIED`.

### 4.2 Isolamento di rete per `Site` e Reverse Proxy Traefik v3 senza `docker.sock`

1. **Rete Ingress condivisa (`hp_ingress_net`) + Reti isolate per Sito (`hp_site_<siteId>_net`)**:
   - Ogni `Site` possiede una rete bridge privata `hp_site_<siteId>_net` (`Internal: true` per i servizi backend/DB non esposti; i soli servizi HTTP esposti sono raggiungibili dall'ingress sulla rete dedicata di frontiera per sito `hp_edge_<siteId>_net`, impedendo la visibilità diretta container-to-container tra `Site` diversi).
2. **Container `hp_ingress_proxy` (`traefik:v3.3` o digest pinnato)**:
   - Pubblica le porte host `80:80` (ed eventuale `443:443`).
   - Monta **in sola lettura** `/var/lib/hosting-panel/ingress/static/traefik.yml:/etc/traefik/traefik.yml:ro` e `/var/lib/hosting-panel/ingress/dynamic:/etc/traefik/dynamic:ro`.
   - **NON monta `/var/run/docker.sock`**.
   - `providers.file.directory = "/etc/traefik/dynamic"` con `watch = true`.
   - `hp-docker-executor` aggiorna la configurazione di ciascun sito tramite scrittura su file temporaneo `.tmp` nella stessa directory + `fs.rename` atomico POSIX (`site_<siteId>.yml`), garantendo zero letture parziali e zero-downtime reload.

---

## 5. `hp-host-agent`, privilegi Linux e hardening `systemd`

### 5.1 Azioni supportate da `hp-host-agent` (Zero Shell)

`hp-host-agent` espone sul proprio socket IPC esclusivamente:

1. `GET /v1/telemetry`: legge metriche reali host (`cpuUsagePercent` calcolato su campionamento `/proc/stat`, `memoryUsedBytes` / `memoryTotalBytes` da `/proc/meminfo`, `storageUsedBytes` / `storageTotalBytes` su `/var/lib/hosting-panel` via `fs.statfs`, `uptimeSeconds`, versione kernel e raggiungibilità socket Docker).
2. `POST /v1/maintenance`: esegue unicamente le 3 azioni in `ALLOWLISTED_HOST_MAINTENANCE_ACTIONS`:
   - `collect_diagnostics`: snapshot strutturato sanitizzato di carico, memoria, filesystem, cgroup v2 (`unified` hierarchy check) e stato servizi;
   - `verify_storage_posture`: verifica permessi `0750`/`0700` su `/var/lib/hosting-panel` e `/run/hosting-panel`, spazio libero residuo e opzioni mount;
   - `refresh_host_inventory`: rileva CPU logiche, RAM fisica, storage totale e architettura per allineare i metadati host.
3. `POST /v1/security`: accetta `policyRef` appartenente a un enum chiuso (`verify_baseline_firewall`, `apply_dedicated_nftables_22_80_443`), invocando `/usr/sbin/nft` tramite `execFile` con file ruleset statico verificato da hash (nessun parametro utente concatenato agli argomenti del comando).

### 5.2 Matrice di hardening delle unit `systemd` (`infra/systemd/`)

| Direttiva `systemd` | `hp-web.service` | `hp-api.service` | `hp-docker-executor.service` | `hp-host-agent.service` |
|---|---|---|---|---|
| `User=` | `hp-web` | `hp-api` | `hp-executor` | `hp-agent` |
| `SupplementaryGroups=` | — | `hp-ipc` | `docker hp-ipc` | `hp-ipc` |
| `NoNewPrivileges=` | `yes` | `yes` | `yes` | `yes` |
| `CapabilityBoundingSet=` | *(vuoto)* | *(vuoto)* | *(vuoto)* | `CAP_NET_ADMIN CAP_DAC_READ_SEARCH` |
| `AmbientCapabilities=` | *(vuoto)* | *(vuoto)* | *(vuoto)* | `CAP_NET_ADMIN CAP_DAC_READ_SEARCH` |
| `ProtectSystem=` | `strict` | `strict` | `strict` | `strict` |
| `ProtectHome=` | `yes` | `yes` | `yes` | `yes` |
| `PrivateTmp=` | `yes` | `yes` | `yes` | `yes` |
| `InaccessiblePaths=` | `/var/run/docker.sock` | `/var/run/docker.sock` | — | `/var/run/docker.sock` |
| `ProtectKernelModules=` | `yes` | `yes` | `yes` | `yes` |
| `ProtectKernelTunables=` | `yes` | `yes` | `yes` | `yes` |
| `RestrictSUIDSGID=` | `yes` | `yes` | `yes` | `yes` |
| `LockPersonality=` | `yes` | `yes` | `yes` | `yes` |
| `SystemCallArchitectures=` | `native` | `native` | `native` | `native` |
| `SystemCallFilter=` | `@system-service` | `@system-service` | `@system-service` | `@system-service` |

---

## 6. Migrazione DB Fase 2 e gestione segreti `AES-256-GCM` (`F1-012`)

### 6.1 Migrazione non distruttiva `0002_phase2_runtime_and_secrets.sql`

La migrazione `0002` **NON modifica né elimina** vincoli di `0001_phase1_docker_native.sql`, aggiungendo:

1. Tabella `encrypted_secrets`:
   - `id` (`sec_<uuid>`), `organization_id` (FK verso `organizations`, composite unique `(id, organization_id)`), `site_id` opzionale (FK composta `(site_id, organization_id)` verso `sites`), `secret_key` (es. `db_password`, univoca per scope), `ciphertext_base64`, `iv_base64` (12 byte GCM), `auth_tag_base64` (16 byte GCM), `key_version`, `version` incrementale, `created_by_user_id`, `created_at`, `updated_at`.
   - Vincolo SQL `CHECK`: `ciphertext_base64 <> ''` e nessun campo plaintext.
2. Tabella `host_agent_heartbeats` (o colonne additive su `hosts` / tabella dedicata):
   - Traccia `host_id`, `component` (`docker_executor` | `host_agent`), `status` (`online` | `degraded` | `offline`), `version`, `last_seen_at`, `telemetry_snapshot` (`jsonb`), aggiornata dal loop di healthcheck IPC.
3. Indice parziale di mutua esclusione sulle operazioni attive (`uq_active_operation_lock`):
   - `CREATE UNIQUE INDEX uq_operations_active_lock ON operations (lock_key) WHERE status IN ('queued', 'processing', 'accepted', 'reconciling', 'unknown') AND lock_key IS NOT NULL;`
   - Garantisce a livello PostgreSQL che nessuna race condition concorrente possa avviare due mutazioni simultanee sullo stesso servizio o host (`409 CONFLICT`).

### 6.2 Flusso JIT dei segreti su `tmpfs` (`*_FILE`)

1. L'utente (`customer_owner` o `customer_collaborator` autorizzato) registra un segreto via `POST /v1/organizations/:orgId/secrets` (write-only: le API `GET` restituiscono solo metadati `id`, `secretKey`, `version`, `updatedAt`, **MAI** il valore decifrato).
2. `StackRevision` continua a salvare esclusivamente `secretRefs: { "WORDPRESS_DB_PASSWORD": "sec_..." }`.
3. `outbox_events` contiene esclusivamente l'ID dell'operazione e della revisione, **zero segreti**.
4. Solo nell'istante in cui l'Outbox Worker invoca `deployService` sul canale IPC locale firmato, il worker decifra in RAM i segreti referenziati dalla `StackRevision` e li trasmette nel campo effimero `resolvedSecrets` del payload IPC firmato (mai loggato, mai persistito).
5. `hp-docker-executor` scrive ciascun segreto in `/run/hosting-panel/secrets/<serviceInstanceId>/<envName>` (`tmpfs` in RAM, mode `0400`), monta il file `:ro` in `/run/secrets/<envName>` nel container e imposta `<ENV_NAME>_FILE=/run/secrets/<envName>`. Nessun segreto appare in `Config.Env` di `docker inspect`. Alla rimozione/stop del servizio, i file `tmpfs` vengono sovrascritti e rimossi.

---

## 7. Outbox Worker, recovery `unknown` e Drift Reconciler

### 7.1 Ciclo di vita delle mutazioni asincrone (`202 Accepted`)

1. Gli endpoint:
   - `POST /v1/organizations/:orgId/services/:serviceId/lifecycle` (`deploy`, `restart`, `stop`)
   - `POST /v1/hosts/:hostId/maintenance`
   - `POST /v1/hosts/:hostId/security`
   richiedono `Idempotency-Key` valida:
   - Se `runtimeBackend === "disabled"` (modalità pura Fase 1), continuano a restituire `422 NOT_SUPPORTED`.
   - Se il runtime è attivo (`linux-systemd` o `local-simulator`), acquisiscono il lock `lockKey` (`svc:<serviceId>` o `host:<hostId>`), inseriscono atomicamente `operations` (`queued`), `operation_steps` e `outbox_events` e rispondono `202 Accepted` con `AsyncAcceptedEnvelope`.
2. **Outbox Worker (`FOR UPDATE SKIP LOCKED`)**:
   - Preleva i job `pending` da `outbox_events`, porta l'operazione in `processing`, invoca l'azione IPC verso `hp-docker-executor` o `hp-host-agent`, transiziona in `accepted` -> `reconciling`, verifica `getObservedState` / risultato agente, aggiorna `docker_resources` e `observed_states`, e chiude in `succeeded` o `failed`.

### 7.2 Crash recovery da stato indeterminato (`TH-08`)

- All'avvio del worker (o se una chiamata IPC va in timeout dopo l'invio del socket), qualsiasi operazione rimasta in `processing` o `accepted` oltre la soglia di lease viene portata nello stato **`unknown`** mantenendo attivo il `lockKey`.
- **MUST (`TH-08`)**: è vietato rieseguire automaticamente un comando mutante `POST` per un'operazione `unknown`.
- Il riconciliatore interroga in sola lettura `dockerExecutor.getObservedState(serviceInstanceId)`:
  - Se il container attivo espone già `io.hostingpanel.spec_hash === targetRevision.specHash` ed è `running` (o `stopped` per `service.stop`), l'operazione transiziona `unknown -> reconciling -> succeeded`.
  - Se il container non è stato creato o è rimasto alla revisione precedente ed è fermo/assente, transiziona `unknown -> failed` con codice `OPERATION_INTERRUPTED` rilasciando il lock in sicurezza.

### 7.3 Drift Reconciler *Observe-Only* (`TH-10` & `AC-F1-08` `T5`)

- Periodicamente (default ogni `30s` configurabile) e al bootstrap post-riavvio (`T5`), il Drift Reconciler interroga `getObservedState` per le istanze attive:
  - Se `observedStatus === desiredStatus` e `observedRevisionHash === currentRevision.specHash` e `!outOfBandModified`, aggiorna `observed_states` come allineato (`in_sync`).
  - Se rileva discrepanze (immagine/env/stato alterati manualmente via `docker` CLI sull'host), aggiorna `observed_states` (`outOfBandModified: true`), calcola lo stato di drift `drifted` e scrive un `audit_event` (`actorType: "system"`, `action: "service.drift.detected"`).
  - **MUST**: il riconciliatore **non riavvia né termina mai** autonomamente i container in esecuzione.

---

## 8. Contratti di capability e aggiornamento delle 3 console UI (`shadcn@4.23.0`)

1. **`PlatformCapabilitiesDtoSchema` (`packages/contracts`)**:
   - `phase`: `"phase-1" | "phase-2"`
   - `runtimeBackend`: `"linux-systemd" | "local-simulator" | "disabled"`
   - `hostingMode`: `"dedicated"`
   - `dockerExecutorRuntimeAvailable`: `boolean`
   - `hostAgentRuntimeAvailable`: `boolean`
   - `sharedHostingEnabled`: `z.literal(false)`
   - `acmeTlsRuntimeAvailable`: `z.literal(false)`
   - `sftpAvailable`: `z.literal(false)`
   - `productionBackupRuntimeAvailable`: `z.literal(false)`
2. **Console Customer (`/o/[orgSlug]/*`)**:
   - Gestione metadati `SecretRefs` cifrati (`write-only` input, elenco chiavi senza valori).
   - Pulsanti operativi `Deploy`, `Riavvia`, `Arresta` su dettaglio sito/servizio con gestione `202 Accepted`, banner di stato operazione in corso e polling automatico della `OperationTimeline`.
   - Badge esplicito `In Sync` / `Drifted` / `Unknown` derivato da `ObservedState`.
3. **Console Infrastructure Admin (`/admin/*`)**:
   - Stato live dei demoni `hp-docker-executor` e `hp-host-agent` + badge veritiero del `runtimeBackend`.
   - Telemetria host reale (CPU, RAM, storage, uptime) e trigger asincroni `202 Accepted` per le 3 azioni `ALLOWLISTED_HOST_MAINTENANCE_ACTIONS` e per la verifica postura `nftables`.
4. **Console Hosting Admin (`/hosting/*`)**:
   - Visualizzazione stato allocazioni, template e salute servizi, mantenendo rigorosamente bloccate (`403 PERMISSION_DENIED` + audit) tutte le azioni `host.maintenance.*`, `host.security.*` e `host.docker.engine.manage` (`AC-F1-03`).

---

## 9. Bootstrap Linux, Break-Glass ed esecuzione reale `AC-F1-08`

### 9.1 Kit operativo Linux (`infra/systemd/` & `infra/linux/`)

1. `infra/systemd/hp-docker-executor.service`, `infra/systemd/hp-host-agent.service`, `infra/systemd/hp-api.service`, `infra/systemd/hp-web.service`: unit complete pronte per Ubuntu 24.04 LTS / Debian 12.
2. `infra/linux/bootstrap-dedicated.sh`: script POSIX/bash idempotente che:
   - verifica Ubuntu 24.04 / Debian 12, kernel 6.x+, `cgroups v2` e Docker Engine;
   - crea il gruppo `hp-ipc` e gli utenti di sistema `hp-web`, `hp-api`, `hp-executor`, `hp-agent` (`/usr/sbin/nologin`);
   - predispone `/etc/hosting-panel` (`0750`), genera in modo idempotente `ipc.key` e `secrets-master.key` (`0440` / `0400`), crea `/var/lib/hosting-panel/{ingress/static,ingress/dynamic,sites}` e installa/ricarica le unit `systemd`.
3. CLI Break-Glass (`apps/api/src/cli/break-glass.ts`): comando amministrativo locale eseguibile da root/console SSH sull'host per:
   - ispezionare e sbloccare manualmente un `lockKey` bloccato in `unknown` con motivazione obbligatoria registrata in `audit_events` (`actorType: "system"`, `action: "breakglass.operation.unlock"`);
   - emettere un token di emergenza a vita breve (`5 min`) per `infrastructure_admin` in caso di indisponibilità dell'IdP esterno.

### 9.2 Esecuzione reale dello scenario di outage `AC-F1-08` (`infra/linux/run-outage-ac-f1-08.mjs`)

Sull'ambiente Linux dedicato con Docker Engine attivo, il runner automatizza integralmente le fasi `T0..T5` definite in `docs/security/phase-1-test-and-outage-plan.md`:

1. **`T0` (Baseline)**: avvia lo stack completo (`PostgreSQL`, `hp-docker-executor`, `hp-host-agent`, `hp-api`, `hp-web`), effettua il deploy reale tramite API `202 Accepted` di `hp_ingress_proxy` (Traefik v3 file-provider senza `docker.sock`) e di **almeno 2 siti tenant containerizzati** con domini distinti, verificando `200 OK` sotto carico HTTP continuo (`50 req/s`).
2. **`T1` (`SIGKILL` Web BFF)**: termina forzatamente `hp-web`; verifica che la UI pannello sia irraggiungibile mentre il generatore di carico verso i 2 siti registra **0 errori HTTP (`100% 200 OK`)**.
3. **`T2` (`SIGKILL` API Control Plane)**: termina forzatamente `hp-api`; verifica indisponibilità di `/v1/health` e continuità al **`100% 200 OK`** sui siti tenant.
4. **`T3` (`SIGKILL` Agenti/Worker e stop DB Control Plane)**: arresta worker, agenti `hp-docker-executor` / `hp-host-agent` e il database di Control Plane; verifica che `hp_ingress_proxy` e i container dei siti restino `running` (zero container restart).
5. **`T4` (Finestra di Outage Sotto Carico)**: mantiene il carico HTTP continuo sui siti tenant raccogliendo latenze `p95`/`p99`, conteggio risposte `200 OK`, errori TCP (`0` ammessi) e `RestartCount` Docker (`0` ammessi).
6. **`T5` (Ripristino e Riconciliazione Trasparente)**: riavvia DB, demoni IPC, `hp-api` e `hp-web`; attende il ciclo del Drift Reconciler (< 30s) e verifica tramite API che tutti i servizi risultino `in_sync`, con `RestartCount === 0` e uptime continuo dei container Data Plane.
7. Produce un report JSON/Markdown verificabile in `docs/security/ac-f1-08-execution-report.md` con timestamp reali, output metriche e verdetto oggettivo Pass/Fail.

---

## 10. Criteri di accettazione di Fase 2 (`AC-F2-01`..`AC-F2-10`)

| ID | Criterio di Accettazione | Verifica Oggettiva |
|---|---|---|
| **`AC-F2-01`** | **`ADR-010` chiuso con Split Agents**: `apps/docker-executor` e `apps/host-agent` compilano ed eseguono come processi distinti da `apps/api`, senza accesso a `docker.sock` in `apps/api` o `apps/web`. | Build/test monorepo + ispezione unit `systemd` (`InaccessiblePaths=/var/run/docker.sock`). |
| **`AC-F2-02`** | **Autenticazione IPC e Anti-Replay**: richieste su socket IPC prive di firma valida, con timestamp fuori finestra (> 30s) o con `nonce` duplicato vengono rigettate (`401` / `409`). | Suite di test contrattuali/avversari IPC in `apps/docker-executor` e `apps/host-agent`. |
| **`AC-F2-03`** | **Confinamento Container & Zero `docker.sock` nel Proxy (`TH-02`, `TH-04`)**: `hp-docker-executor` impone `CapDrop: ["ALL"]`, `no-new-privileges`, `PidsLimit`, reti isolate per `Site` e configura Traefik v3 esclusivamente via file provider `:ro` senza montare `docker.sock`. | Test unitari/integrazione `hp-docker-executor` + ispezione container su Linux (`docker inspect`). |
| **`AC-F2-04`** | **Privilegi Minimi `hp-host-agent` e Zero Shell (`TH-03`)**: `hp-host-agent` rifiuta qualsiasi azione fuori da `ALLOWLISTED_HOST_MAINTENANCE_ACTIONS` / enum `policyRef`, non usa mai shell (`sh -c`), e `hosting_admin` riceve `403 PERMISSION_DENIED` + audit su endpoint host. | Test `apps/host-agent` + test integrazione `apps/api`. |
| **`AC-F2-05`** | **Segreti Cifrati `AES-256-GCM` & `tmpfs` (`F1-012`)**: i segreti sono salvati cifrati in `encrypted_secrets`, mai restituiti in chiaro dalle `GET`, mai presenti in `stack_revisions`/`outbox_events`/`Config.Env`, e montati come file `0400` `:ro`. | Test DB/API segreti + verifica `docker inspect` privo di segreti in `Env`. |
| **`AC-F2-06`** | **Outbox Asincrono `202 Accepted` & Lock Concorrenza**: `deploy`/`restart`/`stop`/`maintenance` restituiscono `202 Accepted` con `Idempotency-Key`, bloccano mutazioni concorrenti sulla stessa risorsa (`409 CONFLICT`) e completano il ciclo fino a `succeeded`. | Test integrazione `apps/api` + test transazionali `packages/database`. |
| **`AC-F2-07`** | **Recovery `unknown` senza Replay Cieco (`TH-08`)**: un'operazione interrotta in `processing`/`accepted` transiziona in `unknown` e converge tramite sola lettura `getObservedState` senza rieseguire `POST` mutanti. | Test deterministici di crash recovery del worker. |
| **`AC-F2-08`** | **Drift Reconciler *Observe-Only* (`TH-10`)**: una modifica out-of-band allo stato osservato marca il servizio `drifted` e genera un `audit_event`, senza riavviare né terminare container in esecuzione. | Test del Drift Reconciler in `apps/api`. |
| **`AC-F2-09`** | **Esecuzione Reale `AC-F1-08` su Linux (`CP-01`)**: l'uccisione con `SIGKILL` di `hp-web`, `hp-api`, worker/agenti e lo stop del DB di Control Plane lasciano il traffico HTTP verso i siti tenant al `100% 200 OK` con `0` container restart e riconciliazione `in_sync` a `T5`. | Esecuzione di `infra/linux/run-outage-ac-f1-08.mjs` su Linux + report generato in `docs/security/ac-f1-08-execution-report.md`. |
| **`AC-F2-10`** | **Veridicità Continua Capabilities & Shared Gated (`AC-F1-06`, `AC-F1-10`)**: `Shared Hosting`, `ADR-011`, `ACME/TLS`, `SFTP` e `Backup` restano disabilitati (`false` / `409 SHARED_MODE_GATED`) in API, UI e documentazione. | Test integrazione `apps/api`, `apps/web` e verifica `swarm-verifier`. |

---

## 11. Definition of Done della Fase 2

L'implementazione di `HCP-SPEC-003` è completata quando:

- [ ] `ADR-010` è aggiornato allo stato `APPROVATO — Fase 2` e `ADR-011` resta `OPEN — prima di Shared`;
- [ ] `0002_phase2_runtime_and_secrets.sql` si applica in modo pulito sopra `0001_phase1_docker_native.sql` sia su `PGlite` sia su PostgreSQL 18 reale;
- [ ] `apps/docker-executor` e `apps/host-agent` superano build, lint, typecheck e test contrattuali/sicurezza;
- [ ] `apps/api` e `apps/web` gestiscono il ciclo completo `202 Accepted` -> Outbox -> IPC firmato -> Drift Reconciler + segreti cifrati;
- [ ] `infra/systemd/*.service`, `infra/linux/bootstrap-dedicated.sh` e la CLI di break-glass sono presenti e verificati;
- [ ] lo scenario di outage `AC-F1-08` è stato eseguito realmente sull'ambiente Linux dedicato con Docker Engine attivo e i risultati reali sono allegati in `docs/security/ac-f1-08-execution-report.md`;
- [ ] `corepack pnpm run build`, `corepack pnpm run lint`, `corepack pnpm run typecheck` e `corepack pnpm run test` terminano tutti con codice `0` e superano la revisione avversaria indipendente (`swarm-verifier`).

---

**Fine del documento HCP-SPEC-003, revisione 1.0.**
