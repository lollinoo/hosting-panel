# Hosting Control Panel (`hosting-panel`)

> **Piattaforma di Hosting Docker-Native Standalone & Multi-Tenant — Fase 2 (`Dedicated` Runtime)**  
> Riferimenti normativi di progetto: **`HCP-SPEC-002` rev. 1.0 (Fase 1)** & **`HCP-SPEC-003` rev. 1.0 (Fase 2)**

---

## 1. Visione e Principi Architetturali

Il progetto **Hosting Control Panel (HCP)** è una piattaforma di hosting moderna, sicura e nativamente integrata con l'ecosistema container Docker. Progettata per superare le fragilità dei pannelli tradizionali, adotta un approccio rigoroso orientato alla sovranità dei dati, alla riproducibilità dichiarativa e alla separazione fisica dei domini di privilegio e di guasto.

L'architettura consolidata tra Fase 1 (`HCP-SPEC-002`) e Fase 2 (`HCP-SPEC-003`) si fonda sui seguenti pilastri ingegneristici:

1. **Doppia Modalità di Hosting (`Dedicated` Attiva, `Shared` Gated) (`ADR-001`, `ADR-007`, `ADR-011`)**:
   - **`Dedicated` (Operativa in Fase 1 & Fase 2)**: Ciascun host fisico o VPS Linux è assegnato in esclusiva a una singola organizzazione cliente (`AC-F1-01`), con runtime container e agenti operativi attivi in Fase 2.
   - **`Shared` (Chiusa / Gated anche in Fase 2 — `AC-F1-06`, `AC-F2-10`)**: Bloccata a livello di policy (`409 SHARED_MODE_GATED`) e subordinata alla futura chiusura di `ADR-011` (`OPEN — prima di Shared`) e al Security Gate `ADR-007`.
2. **Topologia «Split Agents» a 3 Domini di Privilegio e IPC Firmato (`ADR-010`, `ADR-013`, `AC-F2-01`, `AC-F2-02`)**:
   - **Control Plane (`hp-web`, `hp-api`)**: Zero Linux Capabilities e `InaccessiblePaths=/var/run/docker.sock`.
   - **Docker Executor (`hp-docker-executor`)**: Demone isolato non-root, unico autorizzato a comunicare con `/var/run/docker.sock`.
   - **Host Agent (`hp-host-agent`)**: Demone confinato con sole `CAP_NET_ADMIN` + `CAP_DAC_READ_SEARCH`, invocazione esclusiva `execFile` su comandi e profili `nftables` statici allowlisted (zero `sh -c`, `AC-F2-04`).
   - Comunicazione locale su **Unix Domain Sockets (`0660`, gruppo `hp-ipc`, zero porte TCP)** con firma crittografica per richiesta (`HMAC-SHA256` / `Ed25519`), finestra temporale `±30s` e cache anti-replay dei `nonce` (`60s`).
3. **Indipendenza tra Control Plane e Data Plane & Traefik «Zero-Sock» (`CP-01`, `ADR-014`, `AC-F1-08`, `AC-F2-03`, `AC-F2-09`)**:
   Il reverse proxy `hp_ingress_proxy` (Traefik v3) utilizza unicamente il **Dynamic File Provider montato in sola lettura (`:ro`) senza `/var/run/docker.sock`**, aggiornato tramite `rename` atomico POSIX, con reti bridge isolate per ciascun `Site` (`hp_site_<id>_net` + `hp_edge_<id>_net`). L'uccisione (`SIGKILL`) di Web, API, agenti e database lascia il traffico HTTP dei siti al `100% 200 OK` con zero restart dei container.
4. **Transactional Outbox, Recovery `unknown` Read-Only e Drift Reconciler Observe-Only (`AC-F2-06`, `AC-F2-07`, `AC-F2-08`)**:
   Le mutazioni asincrone (`202 Accepted`) sono coordinate su PostgreSQL tramite `SELECT ... FOR UPDATE SKIP LOCKED` e indice parziale di lock (`uq_operations_active_lock`). Le operazioni interrotte convergono tramite sola lettura (`getObservedState`, zero replay ciechi `POST`, `TH-08`) e il Drift Reconciler segnala modifiche fuori-banda come `drifted` senza mai riavviare o terminare container attivi (`TH-10`).
5. **Segreti Cifrati `AES-256-GCM` Write-Only e Mount `tmpfs` `0400` (`ADR-015`, `F1-012`, `AC-F2-05`)**:
   Cifratura autenticata con AAD vincolato a `organizationId:siteId:secretKey`, risoluzione JIT in RAM nell'Outbox Worker e montaggio read-only `0400` su `tmpfs` (`/run/secrets/<key>` + variabile `<KEY>_FILE`), senza mai esporre segreti in `GET`, `stack_revisions`, `outbox_events` o `docker inspect`.
6. **Isolamento Multi-Tenant Nativo & BFF JWE `HttpOnly` (`AC-F1-02`)**:
   Vincoli relazionali composti `(organization_id, id)` con risposte `404 Not Found` cross-tenant e perimetro Next.js 16 BFF con cookie cifrati `A256GCM` + protezione anti-CSRF timing-safe su tutte le console in italiano (`shadcn@4.23.0`).

---

## 2. Stato di Implementazione: Fase 1 & Fase 2 (`AC-F1-10` / `AC-F2-10`)

In ottemperanza ai criteri di veridicità contrattuale **`AC-F1-10`** e **`AC-F2-10`**, la tabella seguente distingue con esattezza le capacità attive in Fase 2 (`HCP-SPEC-003`) dai componenti che restano tassativamente chiusi (`false`):

| Componente / Funzionalità | Stato Fase 2 (`HCP-SPEC-003`) | Riferimento Normativo |
| :--- | :---: | :--- |
| **Dominio Multi-Tenant, RBAC+ABAC, Policy & Quote (`0001`)** | ✅ **Operativo** | `HCP-SPEC-002` (`AC-F1-01`..`AC-F1-09`) |
| **Split Agents `hp-docker-executor` & `hp-host-agent`** | ✅ **Operativo** | `ADR-010` approvato (`AC-F2-01`) |
| **Canale IPC su UDS `0660` Firmato + Anti-Replay** | ✅ **Operativo** | `ADR-013` (`HMAC-SHA256` / `Ed25519`, `AC-F2-02`) |
| **Runtime Docker Hardened & Ingress Traefik v3 Zero-Sock** | ✅ **Operativo** | `ADR-014` (`CapDrop: ALL`, reti per `Site`, `AC-F2-03`) |
| **Telemetria Linux, Manutenzione Allowlisted & `nftables`** | ✅ **Operativo** | `hp-host-agent` via `execFile`, zero shell (`AC-F2-04`) |
| **Segreti Write-Only `AES-256-GCM` & Mount `tmpfs` `0400`** | ✅ **Operativo** | Migrazione `0002` + `ADR-015` (`AC-F2-05`) |
| **Outbox `202 Accepted`, Recovery `unknown` & Drift Reconciler** | ✅ **Operativo** | `SKIP LOCKED`, `TH-08`, `TH-10` (`AC-F2-06`..`AC-F2-08`) |
| **Unit `systemd`, Bootstrap Linux & Runner Outage `AC-F1-08`** | ✅ **Operativo** | `infra/systemd/*`, `infra/linux/*` (`AC-F2-09`) |
| **3 Console Web `shadcn@4.23.0` con `OperationTimeline` Live** | ✅ **Operativo** | `apps/web` BFF JWE + `runtimeBackend` dinamico |
| **Modalità Shared Hosting (`sharedHostingEnabled`)** | ❌ **Chiuso (`false`)** | Restituisce `409 SHARED_MODE_GATED` (`AC-F1-06`, `AC-F2-10`) |
| **Quote Disco per Volumi Condivisi (`ADR-011`)** | ❌ **`OPEN — prima di Shared`** | Differito a `HCP-SPEC-007` (`AC-F2-10`) |
| **Emissione / Rinnovo Certificati ACME/TLS Automatici** | ❌ **Chiuso (`false`)** | `acmeTlsRuntimeAvailable: false` (`HCP-SPEC-005`, `AC-F2-10`) |
| **Server SFTP Chroot & Web File Manager** | ❌ **Chiuso (`false`)** | `sftpAvailable: false` (`HCP-SPEC-005`, `AC-F2-10`) |
| **Backup Incrementali S3 di Produzione & DB Gestiti** | ❌ **Chiuso (`false`)** | `productionBackupRuntimeAvailable: false` (`HCP-SPEC-005`, `AC-F2-10`) |
| **Multi-Host Management Hub Federato Remoto** | ❌ **Non in Fase 2** | Differito a `HCP-SPEC-008` (`ADR-008`) |

---

## 3. Mappa del Monorepo

Il progetto è strutturato come monorepo basato su workspaces `pnpm` (8 pacchetti condivisi + 4 applicazioni):

```text
hosting-panel/
├── apps/
│   ├── api/                      # Control Plane API: NestJS 12 + Fastify 5, Outbox Worker, Drift Reconciler, Break-Glass CLI
│   ├── web/                      # Console Web UI: Next.js 16 (App Router), shadcn@4.23.0, BFF JWE, OperationTimeline, Segreti
│   ├── docker-executor/          # Demone isolato hp-docker-executor: UDS IPC firmato, Docker Engine v1.45+, Traefik zero-sock
│   └── host-agent/               # Demone isolato hp-host-agent: UDS IPC firmato, telemetria /proc, execFile allowlist & nftables
├── packages/
│   ├── config/                   # Metadati di piattaforma HCP-SPEC-002/003, configurazioni condivise TS ed ESLint
│   ├── contracts/                # Schemi Zod, ruoli/permessi, PlatformCapabilitiesDto, firma IPC e guardie DTO pubblici
│   ├── authz/                    # Policy Engine: RBAC + ABAC default-deny, resource grants, isolamento tenant (404)
│   ├── hosting-domain/           # Entità di dominio, Site aggregate, StackRevision builder/hasher, drift detector
│   ├── policy-engine/            # Ammissione Dedicated/Shared, gate dedicated->shared, validatore sicurezza stack, quote
│   ├── executor-contracts/       # Contratti tipizzati ApprovedServiceSpec, resolvedSecrets IPC e DockerExecutorPort
│   ├── host-agent-contracts/     # Contratti tipizzati HostAgentPort, enum manutenzione e profili sicurezza nftables
│   └── database/                 # Schema Drizzle, migrazioni 0001 + 0002 (encrypted_secrets, heartbeats, outbox), PGlite/pg
├── docs/
│   ├── architecture/             # Specifica HCP-SPEC-003 Fase 2, audit Fase 1, diagrammi ER e confini di fiducia
│   │   ├── adr/                  # Registro delle 15 Architectural Decision Records (ADR 0001..0015; ADR-011 OPEN)
│   │   └── diagrams/             # Diagramma di flusso trust boundaries e schema ER
│   ├── security/                 # Matrice delle minacce e protocollo/report di outage Control Plane (AC-F1-08)
│   └── api/                      # Specifica contrattuale OpenAPI 3.1
├── infra/
│   ├── local/                    # Topologia Docker Compose di sviluppo: PostgreSQL 18.1, Redis 7.4, Keycloak 26.2.0
│   ├── systemd/                  # Unit systemd blindate: hp-web, hp-api, hp-docker-executor, hp-host-agent
│   └── linux/                    # Script bootstrap-dedicated.sh, nftables-dedicated.conf, runner run-outage-ac-f1-08.mjs
├── .agents/brain/                # Memoria persistente dello swarm: decisions.md e state.md
├── .github/workflows/ci.yml      # Pipeline CI GitHub Actions con esecuzione di tutti i sensori meccanici
├── .env.example                  # Template variabili d'ambiente per Zero-Docker, Simulator e Linux Dedicated
├── HARNESS.md                    # Contratto operativo e protocollo di verifica meccanica
└── package.json                  # Script e configurazione root del monorepo
```

---

## 4. Avvio Rapido

### Prerequisiti di Sistema
- **Node.js**: Versione `>= 26.0.0` (verificare con `.node-version`)
- **Package Manager**: `corepack pnpm`

---

### Opzione A: Modalità Zero-Docker / Local Simulator (Sviluppo Rapido)
Non richiede container esterni: utilizza PostgreSQL 18 in-process `@electric-sql/pglite`, Dev OIDC `jose` e può operare sia con runtime `disabled` (compatibilità pura Fase 1) sia con `local-simulator` (ciclo completo `202 Accepted` -> Outbox -> IPC firmato in memoria):

```bash
# 1. Abilitare pnpm tramite Corepack e installare le dipendenze
corepack enable
corepack pnpm install

# 2. Compilare tutti i pacchetti, i demoni e le applicazioni
corepack pnpm run build

# 3. Avviare il Control Plane API (porta 4000) e il Frontend Web BFF (porta 3000)
corepack pnpm run dev:api
corepack pnpm run dev:web
```

Gli script `dev:*` attivano esplicitamente `ENABLE_DEV_OIDC=true` e `HP_SEED_DEMO=true` (dati demo). Aprire il browser su **`http://127.0.0.1:3000`** e accedere con il login reale usando gli utenti demo (vedi sotto).

> **Solo sviluppo, mai usato se `HP_SEED_DEMO` non è `true`.** Quando il dataset demo viene seminato, ogni utente demo ha la password `demo-password-123` (es. `elena@acme.it`, amministratore hosting del cliente demo). L'amministratore server demo `infra@hcp.local` richiede anche il 2FA, con segreto TOTP fisso `JBSWY3DPEHPK3PXP` (aggiungilo a un'app di autenticazione o calcola il codice a 6 cifre da quel segreto). In produzione entrambi i valori non esistono: nessun utente demo viene creato.

---

### Opzione B: Modalità VPS Linux Dedicated (`Ubuntu 24.04` / `Ubuntu 26.04` / `Debian 12` / `Debian 13`)
Per predisporre un nodo Linux dedicato con utenti isolati (`hp-web`, `hp-api`, `hp-executor`, `hp-agent`), gruppo `hp-ipc`, chiavi `/etc/hosting-panel/{ipc.key,secrets-master.key}` e unit `systemd` blindate:

```bash
sudo bash infra/linux/bootstrap-dedicated.sh
```

Il bootstrap genera anche la chiave di firma JWT (`/etc/hosting-panel/jwt-signing.pem`, RSA 3072, `0400`) e un file env per servizio (`api.env`, `web.env`, `executor.env`, `0400 root:root`; `web.env` contiene `BFF_SESSION_SECRET`, `api.env` ha `ENABLE_DEV_OIDC=false` e `HP_SEED_DEMO=false`).

**Primo avvio in produzione** (nessun utente demo): creare l'installazione e il primo amministratore server con i wrapper `hp-accounts` e `hp-break-glass` (installati in `/usr/local/sbin`), che leggono `DATABASE_URL` da `api.env`, girano come `hp-api` e applicano da soli le migrazioni. L'installer completo che compila `DATABASE_URL` arriva con il Plan 1b.

```bash
sudo hp-accounts setup --name "<nome server>" --hostname <hostname> --ipv4 <ip>
sudo hp-accounts create-admin --email <email> --name "<nome>"
```

`create-admin` legge la password da `HP_NEW_PASSWORD` o da un prompt nascosto e stampa il segreto TOTP e l'URI `otpauth` da registrare in un'app di autenticazione (il 2FA è obbligatorio per gli amministratori). Recupero accessi: `accounts.js reset-password --email`, `reset-totp --email`, `unlock --email`. La CLI break-glass richiede `--user-id` oppure `--email`. Usare `sudo hp-accounts ...` e `sudo hp-break-glass ...`.

Per collegare in locale container reali PostgreSQL 18.1, Redis 7.4 e Keycloak 26.2.0 vincolati su `127.0.0.1`:

```bash
docker compose -f infra/local/docker-compose.yml up -d
cp .env.example .env
corepack pnpm run build
```

---

## 5. Modello dei Ruoli di Autorizzazione & Demo Persona

Il prodotto ha **due ruoli**: l'**amministratore server** (`users.platform_role = 'infrastructure_admin'`, 2FA TOTP obbligatorio) e l'**amministratore hosting del cliente** (membership `customer_owner`, un solo cliente per server). Il login (`POST /v1/auth/login`) blocca l'account dopo 5 tentativi falliti in 15 minuti (contatore separato per il codice TOTP). L'interfaccia è in italiano (predefinito) e inglese, per utente. La tabella seguente descrive il modello di autorizzazione sottostante.

| Ruolo di Piattaforma | Console Assegnata | Privilegi e Confini di Sicurezza |
| :--- | :--- | :--- |
| **`infrastructure_admin`** | `/admin/*` | Gestione nodi host, telemetria live, stato demoni IPC, manutenzione allowlisted, postura `nftables` e audit globale. |
| **`hosting_admin`** | `/hosting/*` | Gestione catalogo service template, allocazione tenant e monitoraggio quote. **Rigido diniego (`403 PERMISSION_DENIED` + audit) su manutenzione e sicurezza dell'OS host (`AC-F1-03`, `AC-F2-04`)**. |
| **`customer_owner`** | `/o/[orgSlug]/*` | Controllo dell'organizzazione cliente: siti, servizi, revisioni immutabili, segreti cifrati write-only, lifecycle (`Deploy`, `Riavvia`, `Arresta`) e membri. |
| **`customer_collaborator`** | `/o/[orgSlug]/*` | Collaboratore a privilegi minimi regolato da `ResourceGrant` ABAC sui soli siti e servizi autorizzati. |

---

## 6. Comandi di Verifica Meccanica (Objective Sensors)

Tutti i sensori oggettivi di qualità devono terminare con codice di uscita `0`:

```bash
export PATH="$HOME/.local/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm run build
corepack pnpm run lint
corepack pnpm run typecheck
corepack pnpm run test
```

---

## 7. Indice della Documentazione Architetturale

- [Specifica Normativa Fase 2 (`HCP-SPEC-003`)](docs/architecture/hcp-spec-003-phase-2.md): Topologia Split Agents, IPC firmato, Traefik zero-sock, Outbox/Reconciler, segreti `AES-256-GCM` e protocollo `AC-F1-08`.
- [Audit Architetturale Fase 1](docs/architecture/phase-1-repository-audit.md): Analisi baseline del repository e demarcazione dei confini.
- [Registro delle ADR (`ADR 0001..0015`)](docs/architecture/adr/): Decisioni architetturali formali (inclusi `ADR-010` approvato, `ADR-011` `OPEN — prima di Shared`, e `ADR-013..0015`).
- [Diagrammi di Confine e Modello ER](docs/architecture/diagrams/domain-er-and-boundaries.md): Confini di fiducia e schema relazionale PostgreSQL.
- [Piano di Sicurezza e Protocollo di Outage (`AC-F1-08`)](docs/security/phase-1-test-and-outage-plan.md): Matrice delle minacce e specifica del test di outage `CP-01`.
