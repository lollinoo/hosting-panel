# Hosting Control Panel (`hosting-panel`)

> **Piattaforma di Hosting Docker-Native Standalone & Multi-Tenant — Fase 1**  
> Riferimento normativo di progetto: **`HCP-SPEC-002` rev. 1.0**

---

## 1. Visione e Principi Architetturali

Il progetto **Hosting Control Panel (HCP)** è una piattaforma di hosting moderna, sicura e nativamente integrata con l'ecosistema container Docker. Progettata per superare le fragilità e la complessità dei pannelli tradizionali, adotta un approccio rigoroso orientato alla sovranità dei dati, alla riproducibilità dichiarativa e alla separazione dei domini di guasto.

L'architettura di Fase 1 (`HCP-SPEC-002`) si fonda sui seguenti pilastri ingegneristici:

1. **Doppia Modalità di Hosting (`Dedicated` e `Shared`) (ADR-001)**:
   La piattaforma modella nativamente due modalità di erogazione:
   - **`Dedicated` (Target MVP Fase 1)**: Ciascun host fisico o VPS è assegnato in esclusiva a una singola organizzazione cliente (`AC-F1-01`), garantendo l'isolamento hardware a livello hypervisor.
   - **`Shared` (Pianificato per Fase 2)**: Molteplici organizzazioni condividono le risorse di calcolo del medesimo host, con partizionamento rigido e vincoli di storage (`ADR-007`, `ADR-011`).
2. **Indipendenza tra Control Plane e Data Plane (Invariante `CP-01` / `AC-F1-08`)**:
   I processi del pannello di controllo (interfaccia web, API NestJS, worker e database interno) operano in domini di fallimento completamente disaccoppiati rispetto al traffico applicativo dei clienti. Un arresto, riavvio o aggiornamento del Control Plane **non interrompe in alcun modo l'erogazione dei siti web attivi** sul Data Plane.
3. **Isolamento Multi-Tenant Nativo & Prevenzione BOLA (`AC-F1-02`)**:
   La protezione dei dati dei clienti è implementata su tre livelli invalicabili:
   - Filtro di contesto obbligatorio su `organization_id` in tutte le rotte REST.
   - Vincoli di chiave composta relazionale `(organization_id, id)` e chiavi esterne composte su database PostgreSQL.
   - Risposte `404 Not Found` per qualsiasi risorsa appartenente a un altro tenant, eliminando all'origine la possibilità di attacchi IDOR/BOLA ed enumerazione di risorse altrui.
4. **Backend-For-Frontend (BFF) con Cookie JWE Cifrati**:
   L'interfaccia utente Next.js 16 (`apps/web`) agisce come perimetro di sicurezza insuperabile. Il browser dialoga unicamente con il BFF tramite cookie di sessione sicuri e crittografati (`HttpOnly`, `SameSite=Lax`, algoritmo JWE via `jose`). Nessun token Bearer, credenziale di database o ID interno dell'infrastruttura viene mai esposto nel DOM o al codice JavaScript client.
5. **Specifiche Dichiarative Immutabili (`StackRevision`) & Riconciliazione Drift (`AC-F1-05`)**:
   Tutte le modifiche ai servizi generano una nuova revisione immutabile con hash crittografico SHA-256 (`spec_hash`), protetta da trigger PostgreSQL anti-aggiornamento. Lo stato dichiarato (*Desired State*) viene continuamente comparato con lo stato rilevato (*Observed State*) per segnalare tempestivamente situazioni di *drift*.
6. **Validatore Dichiarativo di Sicurezza dello Stack (`AC-F1-04`, `F1-012`)**:
   Il `PolicyEngine` analizza ogni manifest prima dell'ammissione, bloccando container privilegiati (`privileged: true`), mount del socket Docker (`/var/run/docker.sock`), mount di percorsi arbitrari dell'host, modalità di rete host (`network_mode: host`) e capability Linux pericolose (`CAP_SYS_ADMIN`).
7. **Tre Console Utente Distinte con `shadcn@4.23.0`**:
   Interfaccia moderna e interamente in lingua italiana, segmentata per livello di responsabilità:
   - **Console Infrastruttura** (`/admin/*`): Riservata agli amministratori infrastrutturali per stato host, nodi, allocazioni e log di audit globale.
   - **Console Hosting** (`/hosting/*`): Riservata agli amministratori del servizio di hosting per catalogo template, allocazione tenant e monitoraggio quote.
   - **Workspace Cliente** (`/o/[orgSlug]/*`): Dedicato ai clienti e sviluppatori per la gestione autonoma dei propri siti, servizi, domini e revisioni applicative.

---

## 2. Stato di Implementazione: Fase 1 vs Fase 2 (`AC-F1-10`)

In ottemperanza al criterio di trasparenza contrattuale **`AC-F1-10`** e ai non-goal stabiliti in `HCP-SPEC-002` (§1.3), la seguente tabella formalizza con precisione cosa è pienamente operativo nella presente versione (Fase 1) e cosa è differito alla Fase 2:

| Componente / Funzionalità | Stato Fase 1 (`HCP-SPEC-002`) | Riferimento Normativo / Pianificazione |
| :--- | :---: | :--- |
| **Architettura Monorepo a 8 Pacchetti + 2 App** | ✅ **Operativo** | `@hosting-panel/*`, `apps/api`, `apps/web` |
| **Modello di Dominio Canonico Multi-Tenant** | ✅ **Operativo** | `Host`, `HostAllocation`, `Site`, `ServiceInstance`, `StackRevision` |
| **Persistenza Dual-Mode (PGlite / PostgreSQL 18)** | ✅ **Operativo** | Driver `@electric-sql/pglite` embedded e pool `pg` nativo (`AC-F1-09`) |
| **Autorizzazione a 4 Livelli (RBAC + ABAC)** | ✅ **Operativo** | `infrastructure_admin`, `hosting_admin`, `customer_owner`, `customer_collaborator` (`AC-F1-02`, `AC-F1-03`) |
| **Politica di Allocazione Dedicated-First** | ✅ **Operativo** | Ammissione transazionale single-tenant per host dedicated (`AC-F1-01`) |
| **Blocco Transizione Diretta `dedicated -> shared`** | ✅ **Operativo** | Diniego rigido a livello di policy engine (`AC-F1-06`) |
| **Revisioni Immutabili con Hash SHA-256** | ✅ **Operativo** | Versionamento progressivo protetto da trigger SQL (`AC-F1-05`) |
| **Validatore di Sicurezza Manifest dei Container** | ✅ **Operativo** | Rifiuto `privileged`, `docker.sock`, raw capabilities (`AC-F1-04`) |
| **Gestione Transazionale delle Quote Risorse** | ✅ **Operativo** | Calcolo atomico e riserva quota `FOR UPDATE` (`AC-F1-07`) |
| **Tre Console Web UI in Italiano con `shadcn@4.23.0`** | ✅ **Operativo** | Navigazione segmentata e protetta da perimetro BFF JWE (`AC-F1-10`) |
| **Protocollo Normativo Outage Control Plane** | ✅ **Documentato** | Specifica vincolante per l'invariante `CP-01` (`AC-F1-08`) |
| **Esecuzione Live sul Socket Docker (`docker.sock`)** | ❌ **Non in Fase 1** | Astrazione contrattuale tipizzata; stub `NOT_SUPPORTED` (Fase 2) |
| **Host Agent Root Privilegiato su Linux** | ❌ **Non in Fase 1** | Astrazione contrattuale tipizzata; stub `NOT_SUPPORTED` (Fase 2) |
| **Reverse Proxy Data Plane Dinamico (Traefik/Caddy)** | ❌ **Non in Fase 1** | Configurazione e routing a caldo previsti per la Fase 2 |
| **Rilascio Automatizzato Certificati ACME/TLS** | ❌ **Non in Fase 1** | Risoluzione sfide crittografiche Let's Encrypt prevista per la Fase 2 |
| **Server SFTP con Chroot e Web File Manager** | ❌ **Non in Fase 1** | Isolamento storage e gestione file prevista per la Fase 2 |
| **Database Gestiti per Clienti & Backup S3** | ❌ **Non in Fase 1** | Motori MariaDB/PostgreSQL e snapshot S3 previsti per la Fase 2 |
| **Modalità Shared Hosting in Produzione (GA)** | ❌ **Non in Fase 1** | Vincolata ai 5 controlli del Security Gate (`ADR-007`, `ADR-011`) |
| **Multi-Host Management Hub Federato** | ❌ **Non in Fase 1** | Coordinatore opzionale con Single-Writer Fencing (`ADR-008`) |

---

## 3. Mappa del Monorepo

Il progetto è strutturato come monorepo basato su workspaces `pnpm`:

```text
hosting-panel/
├── apps/
│   ├── api/                      # Control Plane API: NestJS 12 + Fastify 5, Dev OIDC jose, Outbox Reconciler
│   └── web/                      # Console Web UI: Next.js 16 (App Router), shadcn@4.23.0, Radix UI, Tailwind v4, BFF
├── packages/
│   ├── config/                   # Metadati di piattaforma HCP-SPEC-002, configurazioni condivise TS ed ESLint
│   ├── contracts/                # Single Source of Truth: schemi Zod, ruoli, permessi, codici errore normalizzati
│   ├── authz/                    # Policy Engine: RBAC + ABAC default-deny, resource grants, isolamento tenant
│   ├── hosting-domain/           # Entità di dominio, Site aggregate, StackRevision builder/hasher, drift detector
│   ├── policy-engine/            # Ammissione Dedicated/Shared, validatore sicurezza stack, calcolo quote
│   ├── executor-contracts/       # Interfaccia logica DockerExecutorPort e implementazione stub Fase 1 (NOT_SUPPORTED)
│   ├── host-agent-contracts/     # Interfaccia logica HostAgentPort e implementazione stub Fase 1 (NOT_SUPPORTED)
│   └── database/                 # Schema PostgreSQL Drizzle, migrazione 0001, vincoli composti, client dual-mode PGlite/pg
├── docs/
│   ├── architecture/             # Audit architetturale Fase 1, diagrammi ER e confini di fiducia, decisioni Fase 2
│   │   ├── adr/                  # Registro delle 12 Architectural Decision Records (ADR 0001..0012)
│   │   └── diagrams/             # Diagramma di flusso a 8 trust boundaries e schema ER completo
│   ├── security/                 # Matrice delle minacce e protocollo di test per outage del Control Plane (AC-F1-08)
│   └── api/                      # Specifica contrattuale OpenAPI 3.1
├── infra/
│   └── local/                    # Topologia locale di supporto: PostgreSQL 18.1 alpine, Redis 7.4 alpine, Keycloak 26.2.0
├── .agents/brain/                # Memoria persistente dello swarm: decisions.md e state.md
├── .github/workflows/ci.yml      # Pipeline CI GitHub Actions con esecuzione di tutti i sensori
├── .env.example                  # Template variabili d'ambiente per Zero-Docker e Docker Compose
├── HARNESS.md                    # Contratto operativo e protocollo di verifica meccanica
└── package.json                  # Script e configurazione root del monorepo
```

---

## 4. Avvio Rapido

### Prerequisiti di Sistema
- **Node.js**: Versione `>= 24.0.0` (raccomandata `24.22.0+`, verificare con `.node-version`)
- **Package Manager**: `corepack pnpm` (v12)

---

### Opzione A: Modalità Zero-Docker Standalone (Predefinita e Consigliata)
Questa modalità non richiede l'avvio di container Docker esterni né la presenza di un daemon Linux locale. Utilizza il motore PostgreSQL 18 in-process `@electric-sql/pglite` (compilato in WebAssembly) e l'emulatore Dev OIDC integrato basato su `jose`:

```bash
# 1. Abilitare il gestore pnpm tramite Corepack
corepack enable

# 2. Installare tutte le dipendenze del monorepo
corepack pnpm install

# 3. Compilare i pacchetti e l'applicazione web
corepack pnpm run build

# 4. In un terminale, avviare il Control Plane API (porta 4000)
corepack pnpm run dev:api

# 5. In un secondo terminale, avviare il Frontend Web BFF (porta 3000)
corepack pnpm run dev:web
```

Aprire il browser su **`http://127.0.0.1:3000`**.  
Nella schermata di login, selezionare una delle demo persona pre-configurate per accedere istantaneamente con un click!

---

### Opzione B: Modalità Docker Compose Locale / External Staging
Per eseguire il Control Plane collegato a container reali dedicati a PostgreSQL 18.1, Redis 7.4 e Keycloak 26.2.0 (tutti rigorosamente vincolati su `127.0.0.1` per sicurezza):

```bash
# 1. Avviare la topologia dei container di supporto
docker compose -f infra/local/docker-compose.yml up -d

# 2. Configurare il file d'ambiente
cp .env.example .env
# Modificare .env decommentando DATABASE_URL:
# DATABASE_URL=postgresql://hosting_panel:local_dev_db_password@127.0.0.1:5432/hosting_panel_dev

# 3. Compilare e avviare i servizi
corepack pnpm run build
corepack pnpm run dev:api
corepack pnpm run dev:web
```

---

## 5. Modello dei Ruoli di Autorizzazione & Demo Persona

Il database viene inizializzato con un dataset demo conforme a `HCP-SPEC-002` articolato sui 4 livelli di autorità:

| Ruolo di Piattaforma | Persona Demo | Console Assegnata | Privilegi e Comportamento Atteso |
| :--- | :--- | :--- | :--- |
| **`infrastructure_admin`** | `infra.admin@hosting-panel.internal` | `/admin/*` | Accesso esclusivo alla gestione hardware dell'host, allocazioni globali e consultazione del registro di audit immutabile. |
| **`hosting_admin`** | `hosting.admin@hosting-panel.internal` | `/hosting/*` | Gestione catalogo service template, allocazione tenant e monitoraggio quote. **Rigido diniego (`deny`) su manutenzione e sicurezza dell'OS host (`AC-F1-03`)**. |
| **`customer_owner`** | `elena.rossi@acme.internal` | `/o/acme-corp/*` | Pieno controllo dell'organizzazione cliente: creazione siti, istanze di servizio, revisioni stack e gestione dei collaboratori. |
| **`customer_collaborator`** | `marco.bianchi@acme.internal` | `/o/acme-corp/*` | Collaboratore a privilegi minimi regolato da `ResourceGrant` ABAC; accesso consentito solo sui siti e servizi autorizzati. |

---

## 6. Comandi di Verifica Meccanica (Objective Sensors)

Tutti i sensori di qualità del codice devono essere eseguiti e superati con codice di uscita `0`:

```bash
# 1. Linter statico ESLint
corepack pnpm run lint

# 2. Controllo statico dei tipi TypeScript (su tutti i pacchetti e le app)
corepack pnpm run typecheck

# 3. Esecuzione suite completa di test Vitest (unitari, di dominio, concorrenza e BFF)
corepack pnpm run test

# 4. Compilazione di produzione di tutti i pacchetti e dell'app Next.js
corepack pnpm run build
```

---

## 7. Indice della Documentazione Architetturale

Per approfondimenti normativi e progettuali, consultare i seguenti documenti di riferimento:

- [Audit Architetturale Fase 1](docs/architecture/phase-1-repository-audit.md): Analisi del repository, tecnologie e demarcazione dei confini.
- [Registro delle ADR (ADR 0001..0012)](docs/architecture/adr/): Tutte le decisioni architetturali registrate con i relativi stati formali.
- [Diagrammi di Confine e Modello ER](docs/architecture/diagrams/domain-er-and-boundaries.md): Gli 8 confini di fiducia e lo schema relazionale PostgreSQL completo.
- [Piano di Sicurezza e Protocollo di Outage](docs/security/phase-1-test-and-outage-plan.md): Matrice delle minacce e specifica del test di outage `CP-01` (`AC-F1-08`).
- [Registro delle Decisioni Aperte per la Fase 2](docs/architecture/phase-2-open-decisions.md): Analisi dei 10 argomenti tecnici aperti per la successiva fase di sviluppo.
