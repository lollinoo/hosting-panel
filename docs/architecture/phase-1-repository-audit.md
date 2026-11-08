# Audit Architetturale del Repository — Fase 1 (`HCP-SPEC-002`)

- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` rev. 1.0 («Hosting Control Panel Docker-native — Fase 1»)  
- **Stato:** Normativo / Approvato  
- **Classificazione:** Architettura di Piattaforma e Baseline di Control Plane  

---

## 1. Obiettivo dell'Audit e Baseline Clean-Slate

Il presente documento formalizza l'audit architetturale del repository `hosting-panel` in conformità al processo di sviluppo a fasi definito in `HCP-SPEC-002` (§8 Step 0).

La presente iterazione (Fase 1) segna il passaggio definitivo a un'architettura **Docker-native standalone e multi-tenant**, eliminando qualsiasi residuo concettuale o software proveniente da sperimentazioni pregresse o da sistemi di orchestrazione terzi. Il controllo del ciclo di vita delle risorse computazionali e la gestione multi-tenant sono ora radicati in un dominio proprietario rigorosamente tipizzato, governato da un Control Plane transazionale e da politiche di sicurezza dichiarative.

Il codice del repository è stato rifondato a partire da un baseline *clean-slate*, introducendo una suddivisione modulare a 8 pacchetti e 2 applicazioni, una suite di validazione automatica conforme a `AC-F1-01`..`AC-F1-10`, e un dataset di persistenza unificato con migrazione SQL idempotente (`0001_phase1_docker_native.sql`).

---

## 2. Stack Tecnologico e Scelte Strumentali

L'infrastruttura di sviluppo, compilazione ed esecuzione si basa su versioni moderne e verificate dell'ecosistema TypeScript e Node.js:

| Componente | Versione Adottata | Ruolo Architetturale & Giustificazione |
| :--- | :--- | :--- |
| **Node.js** | `>= 26.0.0` | Runtime server conforme a `.node-version`; supporto nativo a ES modules, modern crypto e performance V8 avanzate. |
| **Package Manager** | `corepack pnpm` (v12) | Gestione del monorepo tramite workspaces `pnpm`; isolamento deterministico delle dipendenze e hoisting rigoroso. |
| **TypeScript** | `6.0.3` | Compilatore statico unificato (`tsconfig.base.json`); compatibilità con i decoratori ECMAScript / stage-3 e i target di build. |
| **Control Plane API** | NestJS `12.4.0` + Fastify `5.12.8` | Backend modulare ad alte prestazioni; adotta Fastify 5 come HTTP adapter per minimizzare l'overhead di latenza e massimizzare il throughput. |
| **Frontend UI & BFF** | Next.js `16.4.5` (App Router) + React `19.3.1` | Architettura a componenti server/client in lingua italiana con Backend-For-Frontend (BFF) isolato e sessioni su cookie crittografati JWE. |
| **Design System** | `shadcn@4.23.0` + `radix-ui@1.8.1` + Tailwind v4 | Libreria di primitive accessibili, non-opinionated e altamente componibili; conformità estetica e usabilità su tre console distinte. |
| **ORM & Schema DB** | Drizzle ORM `0.45.4` + Drizzle Kit `0.31.11` | Mappatura relazionale tipizzata zero-overhead; pieno controllo delle DDL SQL, dei vincoli composti di chiave e dei trigger di immutabilità. |
| **Database Engines** | PostgreSQL `18.1` / `@electric-sql/pglite@0.5.15` | Architettura dual-mode: PGlite in-process (WASM) per test unitari e CI headless senza dipendenze esterne; PostgreSQL 18.1 per ambienti persistenti e staging. |
| **Contratti & Validazione** | `zod@4.6.7` | Validazione a runtime di DTO, payload REST, configurazioni d'ambiente e specifiche dichiarative `StackRevision`. |
| **Sicurezza & Crittografia** | `jose@6.2.15` | Firma e verifica dei token JWT Bearer (OIDC) e crittografia autenticata JWE per i cookie di sessione BFF. |
| **Test Runner & Linter** | Vitest `5.1.0` + ESLint `10.14.0` | Esecuzione rapida e concorrente della suite di test (unitari, contrattuali e di integrazione) e controllo statico rigoroso. |

---

## 3. Struttura del Monorepo e Modello a 8 Pacchetti

In conformità a `HCP-SPEC-002` (§9), il monorepo è rigorosamente segmentato in confini di responsabilità ben definiti per prevenire accoppiamenti indebiti tra dominio, policy, database e runtime:

```text
hosting-panel/
├── apps/
│   ├── api/                      # Control Plane API (NestJS 12, Fastify 5, Dev OIDC, Outbox Reconciler)
│   └── web/                      # Console Web UI (Next.js 16, shadcn@4.23.0, Radix UI, Tailwind CSS v4, BFF)
├── packages/
│   ├── config/                   # Costanti di piattaforma HCP-SPEC-002, feature flag, configurazioni TS/ESLint
│   ├── contracts/                # Single Source of Truth: DTO Zod, ruoli, permessi, codici errore, guard DTO
│   ├── authz/                    # Motore RBAC + ABAC: default-deny, resource grants, isolamento tenant, deny-precedence
│   ├── hosting-domain/           # Entità di dominio, builder/hasher StackRevision, Site aggregate, drift detector
│   ├── policy-engine/            # Validatori di ammissione Dedicated/Shared, policy di sicurezza stack, quote transazionali
│   ├── executor-contracts/       # Interfaccia logica DockerExecutorPort e implementazione stub Fase 1 (NOT_SUPPORTED)
│   ├── host-agent-contracts/     # Interfaccia logica HostAgentPort e implementazione stub Fase 1 (NOT_SUPPORTED)
│   └── database/                 # Schema Drizzle, migrazione 0001 SQL, vincoli composti, client dual-mode PGlite/pg
├── docs/                         # Documentazione normativa di architettura, ADR 0001..0012, diagrammi e security plan
├── infra/local/                  # Topologia Docker Compose di supporto al Control Plane (Postgres 18, Redis 7, Keycloak 26)
└── .agents/brain/                # Memoria persistente dello swarm: decisions.md e state.md
```

### Relazioni di Dipendenza tra Pacchetti
1. `contracts` non dipende da alcun pacchetto interno (zero dependency verso database o authz).
2. `authz` dipende unicamente da `contracts`.
3. `hosting-domain` dipende da `contracts` e implementa la logica pura di business.
4. `policy-engine` consuma `contracts`, `hosting-domain` e `authz` per applicare i vincoli di ammissione.
5. `executor-contracts` e `host-agent-contracts` definiscono i contratti di astrazione verso il piano host.
6. `database` consuma `contracts` e `hosting-domain` traducendoli nelle tabelle PostgreSQL e nei vincoli di integrità relazionale.
7. `apps/api` orchestra i pacchetti del dominio ed espone la superficie REST `/v1`.
8. `apps/web` consuma unicamente `contracts` ed espone l'interfaccia utente tramite il proprio BFF server-side.

---

## 4. Perimetro Funzionale: Implementato in Fase 1 vs Non-Implementato (Fase 2)

Per garantire la massima integrità ingegneristica ed evitare false assunzioni (`HCP-SPEC-002` §1.3 e `AC-F1-10`), il repository traccia in modo esplicito la demarcazione tra le funzionalità operative nella Fase 1 e i requisiti differiti alla Fase 2:

### 4.1 Funzionalità Pienamente Implementate (Fase 1)
- **Modello di Dominio Unificato (`HCP-SPEC-002` §3)**: Gestione completa delle entità `PlatformInstallation`, `Host`, `HostAllocation`, `Site`, `ServiceTemplate`, `ServiceInstance`, `StackRevision`, `DockerResource`, `ObservedState`, `ResourceQuota`, `QuotaReservation`, `Operation`, `AuditEvent`.
- **Modello di Autorizzazione a 4 Livelli (`HCP-SPEC-002` §4.1–4.2)**:
  - Ruoli: `infrastructure_admin`, `hosting_admin`, `customer_owner`, `customer_collaborator`.
  - ABAC granulare tramite `ResourceGrant` e precedenza assoluta alle regole di diniego (`deny`).
  - Separazione rigorosa: `hosting_admin` non possiede permessi operativi sull'OS host (`AC-F1-03`).
  - Isolamento BOLA: qualsiasi risorsa appartenente a un'altra organizzazione restituisce `404 Not Found`.
- **Politica di Collocazione Dedicated-First (`AC-F1-01`)**:
  - Ammissione rigorosa di una sola organizzazione cliente per host in modalità `dedicated`.
  - Concorrenza protetta da lock transazionale su database (`allocateHostTransactional`).
- **Blocco della Transizione Diretta `dedicated -> shared` (`AC-F1-06`)**:
  - Rigetto a livello di policy di qualsiasi mutazione di stato da `dedicated` a `shared` sullo stesso host senza una procedura formale di de-allocazione e bonifica.
- **Specifica Dichiarativa Immutabile `StackRevision` (`AC-F1-05`)**:
  - Specifica `ServiceSpec` canonica con hashing crittografico SHA-256 del contenuto normalizzato.
  - Generazione deterministica delle risorse `DockerResource` logiche (container, network, volume).
  - Immutabilità garantita a livello di trigger PostgreSQL (nessun update consentito su revisioni create).
- **Validatore di Sicurezza delle Specifiche Stack (`AC-F1-04`, `F1-012`)**:
  - Rifiuto preventivo di container `privileged`, `network_mode: host`, `pid: host`, `ipc: host`.
  - Blocco assoluto del montaggio del socket Docker (`/var/run/docker.sock`) e di filesystem host arbitrari.
  - Rifiuto di capability Linux grezze e segreti in chiaro nel manifest.
- **Gestione Transazionale delle Quote (`AC-F1-07`)**:
  - Calcolo atomico delle risorse consumate e riservate (`cpu_millicores`, `memory_bytes`, `disk_bytes`, `sites_limit`, `domains_limit`).
  - Rifiuto con `409 QUOTA_EXCEEDED` di qualsiasi allocazione che superi i massimali definiti.
- **Backend-For-Frontend (BFF) e Tre Console Web (`AC-F1-10`)**:
  - Console `Infrastructure Admin` (`/admin/*`): stato host, allocazioni, audit di sistema.
  - Console `Hosting Admin` (`/hosting/*`): catalogo template, allocazione tenant, monitoraggio quote.
  - Console `Customer Workspace` (`/o/[orgSlug]/*`): gestione siti, servizi, domini, revisioni stack.
  - Sessione crittografata con cookie JWE `HttpOnly` (`hp_session`), protezione CSRF e sanitizzazione perimetrale dei DTO (nessun dato sensibile esposto al browser).

### 4.2 Componenti Intenzionalmente NON Implementati in Fase 1 (`AC-F1-10` / §1.3)
1. **Esecuzione Live sul Socket Docker (`/var/run/docker.sock`)**: Nella Fase 1 non esiste alcuna comunicazione con il daemon Docker reale né esecuzione di comandi Docker CLI. L'interfaccia `DockerExecutorPort` è instanziata tramite `Phase1DisabledDockerExecutor`, che solleva un errore controllato `NOT_SUPPORTED`.
2. **Host Agent Root Privilegiato**: Nessun processo con privilegi di root o comandi shell arbitrari viene eseguito sul sistema operativo host. L'interfaccia `HostAgentPort` è implementata tramite `Phase1DisabledHostAgent` (`NOT_SUPPORTED`).
3. **Data Plane Reverse Proxy & Routing Dinamico**: Nessun server di reverse proxy (es. Traefik, Caddy, Nginx) è configurato o aggiornato a runtime nella Fase 1.
4. **Ciclo di Vita Certificati ACME / TLS**: Nessun handshake crittografico o rilascio di certificati Let's Encrypt / ZeroSSL è attivo nella Fase 1.
5. **Server SFTP e Gestione File Host**: Nessun demone SFTP con chroot o file manager web è implementato.
6. **Database Gestiti per Clienti & Motori di Backup/Restore**: Nessun database engine multi-tenant (es. MariaDB o PostgreSQL ad uso applicativo cliente) o procedura di snapshot/backup S3 è attivo.
7. **Modalità Shared Hosting in Produzione**: La modalità `shared` è bloccata e mantenuta inattiva in attesa della risoluzione dei vincoli di quota disco e storage (`ADR-007`, `ADR-011`).
8. **Multi-Host Management Hub Distribuito**: La Fase 1 è progettata e validata esclusivamente come appliance standalone per singolo VPS / server dedicato (`ADR-003`).

---

## 5. Matrice di Analisi dei Rischi e Contromisure Adottate

L'audit ha evidenziato le seguenti aree di rischio architetturale e le relative difese incorporate nel codice:

| Area di Rischio | Livello di Gravità | Mitigazione Implementata in Fase 1 | Verifica Meccanica |
| :--- | :---: | :--- | :--- |
| **BOLA / IDOR Cross-Tenant** | CRITICO | Tutte le query SQL e i controlli policy verificano l'appartenenza a `organization_id`. Se la risorsa appartiene a un altro tenant, l'API restituisce `404 Not Found`. | Test unitari e di integrazione `AC-F1-02` |
| **Fuga del Socket Docker** | CRITICO | Divieto normativo di includere `/var/run/docker.sock` in mount o chiamate. Il pacchetto `executor-contracts` è un'astrazione logica disabilitata. | Validator `PolicyEngine` (`AC-F1-04`) |
| **Escalation di Ruolo HostingAdmin** | ALTO | Matrice permessi in `packages/authz`: `hosting_admin` riceve esplicito `deny` su `host.maintenance.*`, `host.security.manage`, `host.docker.engine.manage`. | Test autorizzativi `AC-F1-03` |
| **Race Condition su Quota & Allocazioni** | ALTO | Operazioni di allocazione host e riserva quota eseguite dentro transazioni PostgreSQL con lock riga `FOR UPDATE`. | Test di concorrenza `AC-F1-01`, `AC-F1-07` |
| **Drift di Stato tra Desiderato e Osservato** | MEDIO | Modello esplicito `StackRevision` vs `ObservedState` con valutazione dello stato di drift (`in_sync`, `drifted`, `unknown`). | Test di dominio in `hosting-domain` |
| **Perdita di Tracciabilità degli Eventi** | MEDIO | Tabella `audit_events` protetta da trigger PostgreSQL che inibisce istruzioni `UPDATE` o `DELETE` (append-only log). | Test di integrazione su database |

---

## 6. Conclusioni dell'Audit

Il repository rispetta integralmente le prescrizioni strutturali, contrattuali e di sicurezza di `HCP-SPEC-002` Fase 1. La base di codice è autonoma, deterministica nei test, manutenibile e libera da debiti tecnici legati a sistemi terzi, pronta per l'espansione controllata del runtime nella Fase 2.
