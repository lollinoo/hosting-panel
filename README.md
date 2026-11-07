# Hosting Panel (`hosting-panel`)

> **Multi-Tenant Coolify v4 SaaS Control Panel — Proof of Concept v0.1**  
> Riferimento normativo di progetto: **`HCP-SPEC-001` rev. 1.0**

---

## 1. Visione e Principi Architetturali

Il progetto **Hosting Panel** nasce per trasformare un'infrastruttura gestita tramite Coolify v4 in una vera piattaforma SaaS di Hosting multi-tenant sicura, moderna e pronta per la produzione.

In molte implementazioni naive, il frontend comunica direttamente con Coolify o attraverso un proxy HTTP generico (*pass-through*). Questo approccio introduce vulnerabilità critiche di sicurezza: esposizione dei token API Coolify, falle BOLA/IDOR (Broken Object Level Authorization) tra tenant e lock contention distruttiva durante le mutazioni infrastrutturali.

**Hosting Panel adotta un'architettura rigorosamente orientata alla sicurezza e all'affidabilità**:

1. **Anti-BOLA & Default-Deny Assoluto (`AC-001`)**:
   Ogni richiesta HTTP valida prima l'appartenenza del chiamante all'organizzazione (`organization_id`), l'effettiva titolarità della risorsa all'interno dell'organizzazione e la conformità al modello RBAC + ABAC. Le risorse appartenenti ad altri tenant restituiscono invariabilmente `404 Not Found`, impedendo qualsiasi fuga di informazioni (*tenant isolation*). Le richieste verso Coolify vengono inoltrate solo e soltanto dopo che tutte le verifiche di autorizzazione sono superate.
2. **BFF (Backend-For-Frontend) & Zero Client Secrets (`AC-017`)**:
   Il browser interagisce unicamente con l'applicazione Next.js 16 (`apps/web`) tramite un cookie di sessione sicuro e criptato (`HttpOnly`, `SameSite=Lax`). Nessun token Bearer Coolify, nessun URL interno di provider e nessun identificativo univoco Coolify (`coolify_uuid`) viene mai esposto ai client browser né memorizzato nel DOM.
3. **Outbox Transazionale & Ciclo a 8 Stati (`AC-005`..`AC-007`)**:
   Tutte le mutazioni infrastrutturali (es. deploy, riavvii) vengono accettate con `202 Accepted` e gestite tramite Transactional Outbox. L'operazione, i relativi step, l'evento outbox e l'acquisizione del lock di risorsa (`resource_mutation_locks`) vengono persistiti atomicamente in un'unica transazione PostgreSQL. Gli stati seguono la macchina a stati finiti formale:  
   `queued -> processing -> accepted_by_provider -> reconciling -> succeeded | failed | unknown | cancelled`.
4. **Divieto di Blind POST Replay (`AC-007`)**:
   In caso di timeout o errore transitorio di rete durante una mutazione verso Coolify, l'operazione transita nello stato `unknown` mantenendo il lock attivo. È categoricamente vietato riemettere una seconda chiamata `POST` alla cieca; il reconciler effettua esclusivamente polling idempotente `GET` per verificare lo stato effettivo del provider.
5. **Adattatore Coolify v4 Tipizzato & Redazione Ricorsiva (`AC-008`, `AC-009`)**:
   Tutte le interazioni upstream avvengono tramite un client tipizzato (`packages/coolify-adapter`) provvisto di allowlist statica degli host, rifiuto dei redirect con header di autorizzazione, gestione nativa del rate-limit `429` (rispetto di `Retry-After` e cooldown esponenziale) e sanificazione ricorsiva di tutti i token o segreti presenti nelle risposte.
6. **Dual-Mode Runtime (Zero-Docker Standalone & Docker Staging) (ADR-002)**:
   La piattaforma supporta l'avvio immediato senza Docker tramite `@electric-sql/pglite` (eseguendo il medesimo schema PostgreSQL 18 e i vincoli Drizzle), un emulatore OIDC locale basato su `jose`, e un Fake Coolify v4 Lab HTTP Server; parallelamente, la topologia Docker Compose (`infra/local/docker-compose.yml`) fornisce PostgreSQL 18.1, Redis 7.4 e Keycloak 26.2 per ambienti standard di staging e produzione.

### Perimetro di Progetto: Distinzione tra POC v0.1 e R1/R2

In ottemperanza alla nota iniziale di `HCP-SPEC-001`, si chiarisce la netta demarcazione tra quanto implementato nella presente POC e quanto pianificato per le release successive:

| Funzionalità / Ambito | Stato POC v0.1 (Stage 0 + MVP Core) | Pianificato per R1 / R2 |
| :--- | :---: | :---: |
| **Architettura Monorepo & Contratti Condivisi** | ✅ Implementato (`contracts`, `authz`, `database`, `coolify-adapter`, `config`) | Consolidamento ed estensioni di scala |
| **Control Plane API `/v1`** | ✅ Implementato (NestJS 12 + Fastify 5, OpenAPI 3.1) | Espansione endpoint avanzati |
| **UI Control Panel in Italiano** | ✅ Implementato (Next.js 16, App Router, Tailwind CSS, TanStack Query) | Temi personalizzabili e dark mode completa |
| **Autenticazione OIDC & BFF Session** | ✅ Implementato (Cookie `HttpOnly`, Dev OIDC locale, compatibile Keycloak) | Integrazione Multi-IdP aziendale (SAML, Google) |
| **Autorizzazione RBAC + ABAC & Anti-BOLA** | ✅ Implementato (5 ruoli, grant per risorsa, precedenza deny, isolamento tenant) | Ruoli custom definiti dall'utente |
| **Transactional Outbox & 8-State Reconciler** | ✅ Implementato (Lock risorsa, idempotency key deduplication, zero blind POST replay) | Code distribuite su cluster Redis con BullMQ |
| **Deploy & Restart Applicazioni (`202 Accepted`)** | ✅ Implementato con timeline dell'operazione in tempo reale | Rollback automatico con snapshot |
| **Visualizzazione Risorse & Server Fleet** | ✅ Implementato (Server, Applicazioni, Database sola lettura, Domini/TLS, Operazioni) | Metriche grafiche CPU/RAM in tempo reale |
| **Pannello Admin Piattaforma** | ✅ Implementato (Stato provider Coolify, test connessione, audit log immutabile) | Gestione quote multi-cluster avanzata |
| **Provisioning Self-Service Cloud VPS (Hetzner)** | ❌ Non-Goal POC (infrastruttura pre-assegnata) | 🗓️ Pianificato per R1 |
| **Creazione App/DB da Git Privato Arbitrario** | ❌ Non-Goal POC (catalogo istanze gestito) | 🗓️ Pianificato per R1 |
| **Backup / Restore S3 Distruttivo** | ❌ Non-Goal POC (bloccato esplicitamente per Redis `AC-012`) | 🗓️ Pianificato per R1/R2 |
| **Billing & Integrazione Stripe Live** | ❌ Non-Goal POC (quote simulate su database) | 🗓️ Pianificato per R2 |
| **Portale Reseller / White-Label** | ❌ Non-Goal POC | 🗓️ Pianificato per R2 |
| **Hosting Email Integrato (Mailcow/Stalwart)** | ❌ Non-Goal POC | 🗓️ Pianificato per R2 |

---

## 2. Mappa del Monorepo

Il repository è strutturato come monorepo gestito tramite `pnpm` workspaces:

```text
hosting-panel/
├── apps/
│   ├── api/                      # Control Plane API: NestJS 12 + Fastify 5, Dev OIDC, Outbox Worker, Fake Coolify Lab
│   └── web/                      # Frontend UI & BFF: Next.js 16 (App Router), sessioni HttpOnly, lingua italiana
├── packages/
│   ├── contracts/                # Single Source of Truth: DTO Zod, permessi, codici errore normalizzati
│   ├── authz/                    # Policy Engine: RBAC + ABAC default-deny, resource grants, precedenza deny
│   ├── database/                 # Schema PostgreSQL Drizzle, migrazioni SQL, seed demo, driver dual-mode (PGlite / pg)
│   ├── coolify-adapter/          # Client Coolify v4 tipizzato, allowlist host, blocco redirect, redazione secret
│   └── config/                   # Configurazioni condivise TypeScript, ESLint e costanti HCP-SPEC-001
├── docs/
│   ├── api/
│   │   └── openapi.yaml          # Specifica contrattuale OpenAPI 3.1.0 completa
│   ├── architecture/adr/         # Architectural Decision Records (ADR 0001)
│   └── runbooks/
│       └── poc-operations.md     # Runbook operativo: rotazione token, rate-limit 429, recupero unknown, health probe
├── infra/
│   └── local/
│       └── docker-compose.yml    # Topologia locale: PostgreSQL 18.1 alpine, Redis 7.4 alpine, Keycloak 26.2.0
├── .agents/brain/                # Memoria persistente dell'architettura (decisions.md, state.md)
├── .github/workflows/ci.yml      # Pipeline CI GitHub Actions con esecuzione di tutti i sensori
├── .env.example                  # Template variabili d'ambiente per Zero-Docker e Docker Compose
├── HARNESS.md                    # Contratto operativo e protocollo di verifica
└── package.json                  # Script root del workspace
```

---

## 3. Avvio Rapido

### Prerequisiti
- **Node.js**: Versione `>= 24.0.0` (raccomandata `24.22.0`, consultare `.node-version`)
- **Package Manager**: `corepack pnpm` (pnpm `12.18.0`)

---

### Opzione A: Modalità Zero-Docker Standalone (Consigliata)
Non richiede Docker né servizi esterni in esecuzione. Utilizza il motore PostgreSQL 18 in-process `@electric-sql/pglite`, il server Fake Coolify Lab integrato (porta 4101) e l'emulatore OIDC locale:

```bash
# 1. Abilitare il gestore di pacchetti pnpm tramite Corepack
corepack enable

# 2. Installare tutte le dipendenze del monorepo
corepack pnpm install

# 3. Compilare i pacchetti e l'applicazione web
corepack pnpm run build

# 4. In una finestra di terminale, avviare il Control Plane API (porta 4000 + Lab porta 4101)
corepack pnpm run dev:api

# 5. In una seconda finestra di terminale, avviare il Frontend Web BFF (porta 3000)
corepack pnpm run dev:web
```

Aprire il browser su **`http://127.0.0.1:3000`**.  
Nella schermata di login, selezionare una delle demo persona pre-caricate per accedere istantaneamente con un click!

---

### Opzione B: Modalità Docker Compose / External Staging
Per eseguire la piattaforma con container reali dedicati a PostgreSQL 18.1, Redis 7.4 e Keycloak 26.2.0 (tutti rigorosamente vincolati a `127.0.0.1` per sicurezza):

```bash
# 1. Avviare la topologia dei container locali
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

## 4. Demo Persona Pre-caricate & Matrice di Accettazione

Il database viene inizializzato automaticamente con un dataset di test conforme a `HCP-SPEC-001` che include 3 organizzazioni (`Acme Corp`, `Beta Studios`, `Legacy Corp Sospesa`) e 5 utenti con differenti livelli di autorizzazione:

### Tabella delle Persona Demo

| Utente | Email Demo | Organizzazioni & Ruoli | Comportamento Atteso nel Control Panel |
| :--- | :--- | :--- | :--- |
| **Elena Rossi** | `elena.rossi@acme.it` | • **Acme Corp**: `customer_owner`<br>• **Beta Studios**: `viewer`<br>• **Legacy Corp**: `customer_owner` | Accesso completo come owner su Acme Corp (deploy, riavvii, gestione membri). Quando passa a Beta Studios, i permessi di mutazione vengono bloccati (sola lettura). Su Legacy Corp le mutazioni sono disabilitate per sospensione (`AC-021`). |
| **Marco Bianchi** | `marco.bianchi@acme.it` | • **Acme Corp**: `developer` (con ABAC su Storefront) | Può visualizzare e lanciare deploy/riavvii sull'applicazione **Acme Storefront**, ma riceve `403 PERMISSION_DENIED` se tenta mutazioni su **Acme Core API** (`AC-004`). |
| **Giulia Verdi** | `giulia.verdi@acme.it` | • **Acme Corp**: `viewer` | Accesso globale in sola lettura. Tutti i pulsanti di azione (Deploy, Riavvia) sono disabilitati o restituiscono `403` con audit immediato della violazione (`AC-003`). |
| **Luca Neri** | `luca.neri@betastudios.it` | • **Beta Studios**: `customer_owner` | Tenant completamente separato. Non può visualizzare né interagire con le risorse di Acme Corp: ogni tentativo di accesso restituisce `404 Not Found` (`AC-001`). |
| **Admin Piattaforma** | `admin@hosting-panel.it` | • Piattaforma: `isPlatformAdmin = true` | Accesso esclusivo alla sezione `/admin` (gestione provider Coolify, audit log immutabile di sistema, statistiche flotta). Vietato l'accesso ai dati tenant senza grant di supporto attivo (`AC-016`). |

---

### Matrice di Copertura Criteri di Accettazione (`AC-001` .. `AC-024`)

La suite di test automatizzati valida programmaticamente tutti gli scenari critici:

- **`AC-001` (Isolamento Multi-Tenant)**: Richieste verso risorse di un'altra organizzazione restituiscono `404` senza contattare Coolify.
- **`AC-002` (Context Switching)**: Commutazione di organizzazione via sessione con ricalcolo immediato dei ruoli e permessi.
- **`AC-003` (Enforcement Viewer)**: Diniego `403` su tentativi di mutazione da utenti con ruolo `viewer` e registrazione nel log di audit.
- **`AC-004` (ABAC Granulare per Risorsa)**: Sviluppatore abilitato solo sulle risorse specificate nel `ResourceGrant`.
- **`AC-005` & `AC-006` (Idempotency Key & Lock di Risorsa)**: Rifiuto di payload conflittuali su medesima chiave con `409 Conflict`; blocco delle mutazioni concorrenti sulla stessa risorsa finché l'operazione in corso non termina.
- **`AC-007` (Operazioni Unknown & Divieto Blind Replay)**: Timeout verso Coolify porta l'operazione in `unknown` con mantenimento del lock; riconciliazione automatica via polling idempotente `GET`.
- **`AC-008` (Rate-Limit Upstream 429)**: Rispetto del cooldown `Retry-After` con sospensione temporanea delle chiamate e messaggio sanificato al client.
- **`AC-009` (Revoca Token Coolify)**: Rilevazione del token revocato (`401`), mascheramento del segreto e segnalazione di allarme.
- **`AC-010` (Verifica Health Probe Post-Deploy)**: Se Coolify conferma il deploy ma la verifica HTTP indipendente fallisce, l'operazione viene marcata `failed` e l'applicazione posta in stato `degraded`.
- **`AC-011` (Heartbeat Stale)**: Segnalazione visiva di stato `unknown` e metadato `stale: true` quando l'heartbeat del server supera la soglia consentita.
- **`AC-012` (Vincoli Database Engine)**: Rigetto immediato (`422 NOT_SUPPORTED`) dei tentativi di ripristino su istanze Redis (backup e restore non supportati su Redis).
- **`AC-014` (Gestione Domini FQDN)**: Canonicalizzazione lowercase, validazione FQDN e rigetto di duplicati cross-tenant con `409 DOMAIN_CONFLICT` senza divulgare l'organizzazione proprietaria.
- **`AC-016` (Protezione Accesso Admin)**: L'amministratore di piattaforma può accedere a `/v1/admin/*`, ma non può leggere le risorse del tenant senza un grant di supporto esplicito.
- **`AC-017` (Redazione Segreti)**: Nessuna credenziale, token Bearer o stringa di connessione con password appare in chiaro nei body DTO o nei log di sistema.
- **`AC-021` (Organizzazioni Sospese)**: Blocco di tutte le operazioni di mutazione (`403`) su tenant in stato sospeso, consentendo la sola consultazione dello stato e delle quote.
- **`AC-022` (Protezione Ultimo Owner)**: Impossibilità di rimuovere o degradare l'unico owner di un'organizzazione (`409 LAST_OWNER_PROTECTED`).
- **`AC-024` (Revoca Immediata JWT)**: Invocazione di `POST /v1/auth/revoke` invalida istantaneamente il token `jti` memorizzato nel registro di revoca.

---

## 5. Comandi di Verifica (Objective Sensors)

Tutti i sensori di qualità del codice devono essere eseguiti e superati con successo:

```bash
# 1. Linter statico ESLint
corepack pnpm run lint

# 2. Controllo statico dei tipi TypeScript (su tutti i pacchetti e le app)
corepack pnpm run typecheck

# 3. Esecuzione suite completa di test Vitest (81 test su 7 suite)
corepack pnpm run test

# 4. Compilazione di produzione di tutti i pacchetti e dell'app Next.js
corepack pnpm run build
```

---

## 6. Documentazione Correlata

- **Specifica OpenAPI 3.1**: [`docs/api/openapi.yaml`](docs/api/openapi.yaml)
- **Runbook Operativo**: [`docs/runbooks/poc-operations.md`](docs/runbooks/poc-operations.md)
- **Decisioni Architetturali**: [`docs/architecture/adr/0001-poc-architecture-and-runtime.md`](docs/architecture/adr/0001-poc-architecture-and-runtime.md)
- **Contratto Operativo (Harness)**: [`HARNESS.md`](HARNESS.md)
- **Topologia Docker Locale**: [`infra/local/docker-compose.yml`](infra/local/docker-compose.yml)
- **Workflow CI GitHub Actions**: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)
