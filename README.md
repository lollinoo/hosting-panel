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
5. **Segreti Cifrati `AES-256-GCM` Write-Only e File in Sola Lettura (`ADR-015`, `F1-012`, `AC-F2-05`)**:
   Cifratura autenticata con AAD vincolato a `organizationId:siteId:secretKey`, risoluzione JIT in RAM nell'Outbox Worker e file `0444` dentro cartelle `0700` sul server, montato in sola lettura (`:ro`) su `/run/secrets/<KEY>` (+ variabile `<KEY>_FILE`): ogni processo di quel container lo può leggere, mentre le cartelle `0700` lo chiudono agli altri utenti del server. I segreti non compaiono mai in `GET`, `stack_revisions`, `outbox_events` o `docker inspect`.
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
| **Telemetria Linux, Manutenzione Allowlisted & `nftables`** | ✅ **Operativo** | `hp-host-agent` via `execFile`, zero shell (`AC-F2-04`); firewall, aggiornamenti, pacchetti e giornali dal pannello, lavori di root solo tramite unità `systemd` fisse (`ADR-0028`) |
| **Segreti Write-Only `AES-256-GCM` & File `0444` in Cartelle `0700`** | ✅ **Operativo** | Migrazione `0002` + `ADR-015` (`AC-F2-05`) |
| **Outbox `202 Accepted`, Recovery `unknown` & Drift Reconciler** | ✅ **Operativo** | `SKIP LOCKED`, `TH-08`, `TH-10` (`AC-F2-06`..`AC-F2-08`) |
| **Unit `systemd`, Bootstrap Linux & Runner Outage `AC-F1-08`** | ✅ **Operativo** | `infra/systemd/*`, `infra/linux/*` (`AC-F2-09`) |
| **2 Console Web (`/admin/*`, `/sites/*`) `shadcn@4.23.0` con `OperationTimeline` Live** | ✅ **Operativo** | `apps/web` BFF JWE + `runtimeBackend` dinamico |
| **Modalità Shared Hosting (`sharedHostingEnabled`)** | ❌ **Chiuso (`false`)** | Restituisce `409 SHARED_MODE_GATED` (`AC-F1-06`, `AC-F2-10`) |
| **Quote Disco per Volumi Condivisi (`ADR-011`)** | ❌ **`OPEN — prima di Shared`** | Differito a `HCP-SPEC-007` (`AC-F2-10`) |
| **Emissione / Rinnovo Certificati ACME/TLS Automatici** | ✅ **Operativo** | `acmeTlsRuntimeAvailable: true` su `linux-systemd` (`ADR-0017`, `AC-F2-10`) |
| **Web File Manager dei Siti** | ✅ **Operativo** | Helper isolato per sito, chunk 512 KiB, zip/unzip asincroni (`ADR-0019`, `AC-F2-10`) |
| **Accesso SFTP per Sito (Chroot)** | ✅ **Operativo** | `sftpAvailable: true` su `linux-systemd`, contenitore `hp_sftp` porta TCP `2222` (`ADR-0020`, `AC-F2-10`) |
| **Database per Sito & phpMyAdmin** | ✅ **Operativo** | `phpMyAdminAvailable: true` su `linux-systemd`, `hp_mariadb` + `hp_phpmyadmin` su `127.0.0.1` (`ADR-0021`, `AC-F2-10`) |
| **Backup dei Siti (S3)** | ✅ **Attivo su linux-systemd** | `productionBackupRuntimeAvailable: true` (`ADR-0022`) |
| **Strumenti WordPress** | ✅ **Attivo su linux-systemd** | `wordpressToolsAvailable: true`: versioni, aggiornamenti con copia preventiva, reimpostazione della password di un amministratore (`ADR-0023`) |
| **Importazione WordPress** | ✅ **Attivo su linux-systemd** | `wordpressToolsAvailable: true`: porta su un sito WordPress del pannello i file e il database di un sito WordPress di fuori, con copia preventiva e ritorno com'era se qualcosa fallisce (`ADR-0024`) |
| **Certificati TLS Importati** | ✅ **Attivo su linux-systemd** | `manualTlsCertificatesAvailable: true`: importazione di un certificato in formato PEM (nessun PFX) e assegnazione ai domini di un sito, con Traefik che lo serve al posto di quello automatico (`ADR-0031`) |
| **Destinazione Backup Locale** | ✅ **Attivo su linux-systemd** | `localBackupTargetsAvailable: true`: i backup possono essere scritti anche su una cartella del server, accanto o al posto dello storage S3 |
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
│   └── database/                 # Schema Drizzle, migrazioni 0001..0020 (encrypted_secrets, heartbeats, outbox, …), PGlite/pg
├── docs/
│   ├── architecture/             # Specifica HCP-SPEC-003 Fase 2, audit Fase 1, diagrammi ER e confini di fiducia
│   │   ├── adr/                  # Registro delle 30 Architectural Decision Records (ADR 0001..0030; ADR-011 OPEN)
│   │   └── diagrams/             # Diagramma di flusso trust boundaries e schema ER
│   ├── security/                 # Matrice delle minacce, outage Control Plane (AC-F1-08), report di collaudo e di audit
│   └── api/                      # Specifica contrattuale OpenAPI 3.1
├── infra/
│   ├── local/                    # Topologia Docker Compose di sviluppo: PostgreSQL 18.1, Redis 7.4, Keycloak 26.2.0
│   ├── systemd/                  # Unit systemd blindate: hp-web, hp-api, hp-docker-executor, hp-host-agent + lavori root (hp-panel-update, hp-os-refresh, hp-os-upgrade, hp-unit-restart@)
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
Per predisporre un nodo Linux dedicato con utenti isolati (`hp-web`, `hp-api`, `hp-executor`, `hp-agent`), gruppo `hp-ipc`, chiavi `/etc/hosting-panel/{ipc.key,secrets-master.key,mariadb-root.key,backup.key}` e unit `systemd` blindate:

```bash
sudo bash infra/linux/bootstrap-dedicated.sh
```

Il bootstrap genera anche la chiave di firma JWT (`/etc/hosting-panel/jwt-signing.pem`, RSA 3072, `0400`) e un file env per servizio (`api.env`, `web.env`, `executor.env`, `0400 root:root`; `web.env` contiene `BFF_SESSION_SECRET`, `api.env` ha `ENABLE_DEV_OIDC=false` e `HP_SEED_DEMO=false`).

### Installazione su un nuovo server

Requisiti: **minimo 2 GB di RAM** (l'installer avvisa sotto circa 1,8 GB e prosegue). Sistemi supportati: Ubuntu 24.04/26.04 e Debian 12/13 (Node 26, PostgreSQL 18 da PGDG, Traefik 3.7, Docker CE). Scaricare e verificare la release, poi lanciare l'installer:

```bash
V=0.6.0
curl -fsSLO https://github.com/lollinoo/hosting-panel/releases/download/v$V/hosting-panel-$V-linux-x64.tar.gz
curl -fsSLO https://github.com/lollinoo/hosting-panel/releases/download/v$V/hosting-panel-$V-linux-x64.tar.gz.sha256
sha256sum -c hosting-panel-$V-linux-x64.tar.gz.sha256
tar xzf hosting-panel-$V-linux-x64.tar.gz
sudo bash hosting-panel-$V/infra/linux/install.sh --archive hosting-panel-$V-linux-x64.tar.gz \
  --hostname pannello.example.com --admin-email admin@example.com --admin-name "Nome Cognome"
```

**Sicurezza di `--archive`**: tenere archivio e `.sha256` in una directory scrivibile solo da root (ad esempio `/root`), non in un download condiviso o in `/tmp` accessibile ad altri utenti.

Flag di `install.sh`: `--hostname`, `--admin-email`, `--admin-name`, `--acme-email` (predefinito: email admin), `--ipv4`, `--version` oppure `--archive` (senza, usa l'ultima release GitHub), `--acme-staging`, `--skip-firewall`, `--dry-run`, `--allow-other-linux`. La password dell'amministratore va inserita nel prompt nascosto (chiesta due volte, almeno 12 caratteri): è il metodo raccomandato. Solo per installazioni automatizzate si può passare la variabile d'ambiente `HP_ADMIN_PASSWORD`, ma senza mai scriverla sulla riga di comando: finirebbe nella cronologia della shell e sarebbe visibile ad altri utenti tramite `ps`. Codici di uscita: `0` ok, `1` errore generico (un passo è fallito: correggere la causa e rilanciare), `2` argomenti errati, archivio il cui `VERSION` non corrisponde al nome del file o versione diversa da quella installata, `3` OS non supportato o pacchetto assente per il codename, `4` checksum errato, `5` timeout health check, `6` `docker0` senza IPv4, `7` SSH non sulla porta 22 (usare `--skip-firewall` e gestire il firewall a mano).

**Su un server già installato** l'installer accetta solo la versione installata; non è un aggiornamento. Per ogni altra versione esce con `2` e dice cosa lanciare:

- versione **più vecchia**: rilanciare l'installer con `--version` e la versione installata, oppure installare la versione più vecchia con `hp-update --allow-downgrade`;
- versione **più nuova** (anche `--version latest`, se l'ultima non è quella installata): aggiornare con `sudo hp-update --version <versione>`, che controlla la salute e torna indietro se serve, oppure rilanciare l'installer con la versione installata.

`--skip-firewall` su un server il cui firewall è già del pannello (c'è `/etc/nftables.d/hosting-panel.nft`) non cambia niente, e l'installer lo avvisa: il pannello continua a gestire il firewall e le regole di base restano caricate. Per gestirlo da sé: cancellare quel file e la sua riga `include` in `/etc/nftables.conf`, poi lanciare `sudo nft delete table inet hp_dedicated_filter`.

1. **DNS**: creare un record A `<hostname>` verso l'IP del server. Finché il DNS non punta al server il pannello è raggiungibile su `https://<ip-server>` con certificato autofirmato; su `https://<hostname>` arriva il certificato Let's Encrypt appena il DNS è propagato. Per server di prova usare `--acme-staging` (certificati di staging, non attendibili dai browser).
2. **Enrolment TOTP**: al passo 11 l'installer stampa **una sola volta** il segreto TOTP e l'URI `otpauth` dell'amministratore: registrarli subito in un'app di autenticazione (il 2FA è obbligatorio per gli amministratori).
3. **Backup delle chiavi**: salvare subito fuori dal server `/etc/hosting-panel` — in particolare `/etc/hosting-panel/backup.key` (cifra i backup dei siti; se va persa, nessun backup potrà più essere letto), `secrets-master.key`, `ipc.key`, `mariadb-root.key` e i file `api.env`, `web.env`, `executor.env` (`0400` root). Senza queste chiavi i segreti cifrati e i backup dei siti non sono recuperabili.
4. **Salute**: `/health/live` e `/health/ready`.

### Siti WordPress

L'unico tipo di sito creabile è **WordPress** (la pagina di creazione non chiede il tipo), con PHP `8.3`, `8.4` (predefinita) o `8.5`; la versione si cambia dalla pagina del sito. I clienti creano, avviano/fermano, aggiornano il PHP, leggono i log ed eliminano i propri siti (l'eliminazione chiede di digitare il nome del sito). L'amministratore del server usa la pagina **Siti**: crea un sito per un cliente (o lo tiene a nome della piattaforma), cambia il proprietario e riprova le operazioni fallite; ogni azione è registrata nell'audit come `admin.site.*`.

**Cambio di proprietario e database.** Il cambio dà all'account del database del sito una password nuova: il pannello la scrive prima nel `wp-config.php` del sito, la salva solo dopo che quella scrittura è riuscita, poi la imposta in MariaDB e chiude le connessioni ancora aperte con la vecchia, che la vecchia organizzazione non può più usare. Un programma esterno che usava la vecchia password va aggiornato. Un sito il cui `wp-config.php`, modificato a mano, non contiene esattamente una riga standard `define( 'DB_PASSWORD', … )` non si può spostare: il cambio finisce non riuscito prima di toccare MariaDB e il sito continua a funzionare con la password di prima; rimettere la riga standard e riprovare. Se invece il cambio si ferma dopo aver scritto la password nel sito (MariaDB non risponde, oppure il servizio che esegue i lavori si interrompe a metà), il sito mostra un errore di database finché l'amministratore non riprova l'operazione dalla pagina **Siti**: il nuovo tentativo crea un'altra password e rimette d'accordo sito, pannello e MariaDB.

Ogni sito porta il suo **tipo**. Un servizio senza un tipo noto non è un sito gestito: file, SFTP, database, backup e terminale lo rifiutano. Che cos'è un tipo e i passi per aggiungerne uno: [ADR 0029](docs/architecture/adr/0029-site-types.md).

I siti usano un unico MariaDB di piattaforma (`hp_mariadb`, utente di sistema `hp-mariadb`, riavvio automatico anche senza control plane). Dati: `/var/lib/hosting-panel/mariadb/data` (`0700`). Chiave root: `/etc/hosting-panel/mariadb-root.key` (32 byte, `0440 hp-mariadb:hp-executor`), generata dal bootstrap e **mai rigenerata**: va inclusa nei backup insieme ai dati. L'accesso root è limitato alla subnet `172.30.250.0/24` (modificabile con `HP_MARIADB_ADMIN_SUBNET` in `executor.env`). Dettagli: [ADR 0016](docs/architecture/adr/0016-shared-mariadb-and-site-jobs.md).

### Domini e HTTPS

Ogni sito può avere fino a **10 indirizzi**; uno è il principale e gli altri vi reindirizzano. Dalla scheda Domini del sito il cliente vede cosa impostare presso il proprio registrar: un record **A** verso l'IPv4 del server (l'opzione «Anche www» aggiunge anche `www`). **Non devono esistere record AAAA**: il server serve solo IPv4 e un AAAA blocca il certificato. Il DNS è ricontrollato periodicamente e con «Controlla ora».

Quando il DNS punta al server, Traefik ottiene da Let's Encrypt un certificato per ogni nome (HTTP-01, porta 80 raggiungibile da Internet) e lo rinnova da solo, anche con il control plane fermo. Dopo un errore il tentativo è ripetuto con attese crescenti (15 min, 1 h, 3 h, 6 h, 24 h; 24 h se Let's Encrypt limita le richieste). Non è attivo **HSTS**.

Di base si usa HTTP-01 (porta 80). L'amministratore può impostare un fornitore DNS nella pagina «Certificati» (lista chiusa: Cloudflare, DigitalOcean, Gandi, Hetzner, IONOS, OVH, endpoint HTTP generico) e scegliere DNS-01 per ogni dominio nella pagina Domini del sito. Con DNS-01 il certificato arriva anche prima che il record A punti al server, e la porta 80 non serve per il certificato. Il record A serve comunque ai visitatori. Le credenziali sono di sola scrittura, cifrate, e arrivano a Traefik solo come file. Dopo un riavvio del server con il pannello fermo i rinnovi DNS-01 aspettano il pannello: Traefik rinnova 30 giorni prima della scadenza, quindi c'è margine.

- **Pannello**: creare il record A del pannello **prima** di installare; l'installer avvisa se il nome non risolve all'IPv4 e, finché non risolve, il pannello usa un certificato temporaneo. Avvisa anche se l'IPv4 è privato (server dietro NAT: rilanciare con `--ipv4 <IPv4 pubblico>`). L'email `--acme-email` è il contatto Let's Encrypt e deve essere reale (no `example.com`, `.test` ecc.).
- **Prove**: `--acme-staging` usa la CA di staging (certificati non attendibili dai browser, limiti larghi).
- **Dove sono i certificati**: `/var/lib/hosting-panel/ingress/acme/acme.json` (`acme-staging.json` per lo staging); da includere nei backup.
- **Avvisi**: l'amministratore vede un avviso quando un certificato scade entro 14 giorni o non è stato emesso.

Dettagli e limiti: [ADR 0017](docs/architecture/adr/0017-domains-dns-and-acme-tls.md) e, per DNS-01, [ADR 0030](docs/architecture/adr/0030-dns-01-certificates.md).

### Email in uscita

I siti inviano email attraverso un relay Postfix del pannello che inoltra a un fornitore SMTP scelto dall'amministratore (pagina admin «Email in uscita»). Non ci sono caselle: solo invio.

- **Cosa inserire**: l'**hostname** del fornitore (non un IP: il TLS è verificato e il certificato deve corrispondere a un nome), porta, utente, password e dominio mittente. I messaggi partono da `noreply@<dominio mittente>` con il nome del sito; `Reply-To` è mantenuto.
- **Porta**: preferire la **587**. Molti fornitori cloud bloccano la porta 25 in uscita.
- **SPF e DKIM**: verificare il dominio mittente presso il fornitore (SPF e DKIM), altrimenti i messaggi finiscono nello spam. Il cliente non deve impostare nulla.
- **Limiti fissi**: 200 messaggi e 1000 destinatari all'ora per sito, 100 destinatari per messaggio, 25 MiB per messaggio. Per una newsletter serve un servizio esterno.
- **Coda**: se il fornitore non risponde i messaggi restano in coda fino a 5 giorni. Dopo un riavvio del server con il pannello fermo i messaggi restano in coda e vengono consegnati (coda svuotata) quando il pannello torna e riapplica la password.
- **Aggiornamento alla 0.5.0**: ogni sito in esecuzione viene **riavviato una volta** (pochi secondi ciascuno); i siti fermi sono aggiornati dopo il successivo avvio.
- **Plugin SMTP del sito**: se un sito ha un proprio plugin SMTP, quello ha la precedenza.
- **Email del pannello**: anche la mail di reimpostazione della password del cliente parte da `noreply@<dominio mittente>` attraverso questo relay. Il pannello sa solo che il relay l'ha presa in coda, non che è stata consegnata.

Dettagli e limiti: [ADR 0018](docs/architecture/adr/0018-outgoing-mail-relay.md).

### File manager dei siti

Dalla scheda **File** del sito i clienti navigano le directory, caricano e scaricano file (a chunk base64 fino a 512 KiB ciascuno, fino a 2 GiB per file), modificano file di testo, creano cartelle, spostano/rinominano, eliminano ed eseguono archiviazione ed estrazione `.zip` asincrone (`202 Accepted` con `Idempotency-Key`). Le operazioni girano in un helper isolato per sito (`hp_files_<id>`) senza rete e con filesystem root in sola lettura, senza toccare il container del sito. Voci protette: `wp-content/mu-plugins/hp-mail.php` e cartelle antenate.

Dettagli e limiti: [ADR 0019](docs/architecture/adr/0019-site-file-manager.md).

### Accesso SFTP dei siti

Su runtime `linux-systemd` (`sftpAvailable: true`), i clienti con permesso `site.sftp.manage` gestiscono utenti SFTP per sito (fino a `10` per sito) dal link **SFTP** nella scheda **File**: password temporanee mostrate una sola volta (hash `$6$` in DB e su `/etc/shadow` bindato), nessuna shell, nessun forwarding e chroot sul volume del sito (`/files`). Un unico contenitore di piattaforma isolato (`hp_sftp`, immagine digest-pinned `linuxserver/openssh-server`, porta TCP `2222` su `HP_SFTP_PORT`, solo IPv4) serve tutti i siti senza toccare i container WordPress (`CP-01`). Le modifiche che riavviano il server SFTP condiviso (il primo account di un sito, la reimpostazione di una password, l'eliminazione di un account) sono al massimo `12` per organizzazione in un'ora; una modifica che non riesce non conta. Finché le `12` sono usate, il pannello rifiuta ogni nuovo account e ogni nuova password con «Troppe richieste» (`429 RATE_LIMITED`) senza cambiare nulla; l'eliminazione di un account invece riesce sempre, e conta. Se la password di un account è finita in mani sbagliate mentre il limite è raggiunto, eliminare l'account e crearne uno nuovo più tardi, entro un'ora. Il conteggio è in memoria e riparte da zero al riavvio dell'API. Aprire TCP `2222` nell'eventuale firewall del provider cloud; il comportamento su server Docker/VM reale è verificato a tempo di installazione e collaudo.

Dettagli e limiti: [ADR 0020](docs/architecture/adr/0020-site-sftp.md).

### Database dei siti e phpMyAdmin

Su runtime `linux-systemd` (`phpMyAdminAvailable: true`), i clienti con permesso `site.databases.manage` gestiscono database aggiuntivi (fino a `10` per sito) e utenti database aggiuntivi (fino a `10` per sito, con grant per singolo database) nella scheda **Database** del sito: lo stato è letto direttamente da `hp_mariadb` senza tabelle speculari sul pannello, le password temporanee (`24` caratteri) sono mostrate una sola volta e solo l'hash MariaDB `*<40 hex>` attraversa l'IPC verso l'executor, senza mai riavviare MariaDB né i container WordPress (`CP-01`). Il pulsante **Apri phpMyAdmin** crea un account di sign-on temporaneo limitato ai database del sito, rilascia il cookie cifrato `hp_pma` e apre `/phpmyadmin/<siteId>/` tramite il forwarder autenticato del pannello (al massimo `2` richieste simultanee per sito con coda da `30 s`, così un sito non blocca gli altri) verso il singolo contenitore di piattaforma `hp_phpmyadmin` (`512 MiB`, `4` worker) in ascolto solo su `127.0.0.1` (`HP_PHPMYADMIN_PORT`, predefinita `8306`, stesso valore in `executor.env` e `web.env`; configurazione in `/var/lib/hosting-panel/phpmyadmin`). Il forwarder invia le richieste verso phpMyAdmin tramite il client `node:http` dedicato (`phpmyadmin-upstream.ts`), privo di timeout propri (a differenza dei `300 s` di `fetch` di Node), così operazioni da oltre `5` minuti non liberano prematuramente il posto del sito e dopo `310 s` mostrano la pagina `503` di attesa (*"phpMyAdmin sta ancora lavorando"*) finché la richiesta reale termina. Riaprire phpMyAdmin dalla scheda **Database** interrompe eventuali operazioni lente rimaste attive su quel sito.

Dettagli e limiti: [ADR 0021](docs/architecture/adr/0021-site-databases.md).

### Strumenti WordPress

Attivi solo su runtime `linux-systemd` (`wordpressToolsAvailable: true`). Ogni sito WordPress ha la scheda **WordPress**, subito dopo Panoramica.

- **Versioni.** La scheda mostra la versione di WordPress, i plugin, i temi e gli amministratori del sito, con le versioni nuove disponibili. «Controlla ora» rilegge tutto; la scheda lo fa anche da sola quando l'ultimo controllo ha più di `12` ore. Se wordpress.org non risponde, la scheda dice che gli aggiornamenti non sono noti, mai che il sito è aggiornato. La Panoramica mostra quanti aggiornamenti sono in attesa.
- **Aggiornamenti.** Il cliente aggiorna WordPress, un plugin, un tema o tutto insieme, dopo una conferma. Subito prima il pannello prende una copia del sito (sono tenute le ultime `3`). Se la copia non riesce, non si aggiorna nulla. Se i backup non sono configurati sul server, la conferma dice che nessuna copia sarà presa. Non c'è un pulsante per annullare: per tornare indietro si ripristina la copia dalla scheda **Backup**. Un aggiornamento conta nel limite di `6` azioni pesanti l'ora per sito.
- **Password di un amministratore.** «Reimposta password» crea una nuova password, la mostra una sola volta e disconnette quella persona da ogni dispositivo. La vecchia password smette subito di funzionare. Il pannello non la salva e non la invia per email.
- **Privacy.** Un controllo o un aggiornamento contatta wordpress.org, e WordPress gli invia l'indirizzo del sito.

Dettagli e limiti: [ADR 0023](docs/architecture/adr/0023-wordpress-tools.md).

### Importazione WordPress

Attiva solo su runtime `linux-systemd` (`wordpressToolsAvailable: true`). Nella scheda **WordPress**, la card «Importa un sito» apre una procedura guidata («Avvia un'importazione»).

- **Cosa serve.** Due file del vecchio sito: uno zip con la cartella di WordPress e l'export del database (`.sql`, anche compresso con gzip), fatto con mysqldump, mariadb-dump o phpMyAdmin. Si caricano dalla pagina, che è fatta per riprendere un caricamento interrotto (scegliendo di nuovo lo stesso file), oppure si mandano via SFTP e se ne scrive il percorso. Ogni file può essere al massimo `2 GiB`.
- **Cosa cambia.** I file e le tabelle del sito diventano quelli del vecchio sito. L'indirizzo del vecchio sito è sostituito, nei contenuti, con quello del sito del pannello. Restano del pannello l'accesso, l'indirizzo, SFTP, la connessione al database e i backup. Alcuni file del vecchio sito non entrano: `wp-config.php`, `.htaccess` (messo accanto come `.htaccess.imported`), i plugin must-use e i drop-in. La pagina li elenca alla fine.
- **Prima e durante.** Il cliente conferma scrivendo il nome del sito. Se i backup sono configurati sul server, il pannello prende prima una copia del sito; se la copia non riesce, non si importa nulla. Per qualche minuto il sito è chiuso ai visitatori, che vedono una pagina di accesso negato, e gli altri strumenti WordPress di quel sito non sono disponibili. Si può chiudere la pagina: l'importazione continua.
- **Se qualcosa fallisce.** Il pannello rimette il sito com'era e dice perché, con una frase che dice cosa fare. Se non riesce a rimetterlo del tutto, il sito resta chiuso e la via per tornare indietro è la copia presa prima, dalla scheda **Backup**; senza copia, solo l'amministratore del server può ripararlo. Non c'è un pulsante per annullare un'importazione finita.
- **Cosa non si importa.** Un multisite, un sito da un indirizzo web, un backup di un altro pannello, un sito installato in una sottocartella, con «Indirizzo WordPress» e «Indirizzo sito» su domini diversi o con lettere maiuscole nel dominio. Se i due indirizzi differiscono solo per `http` e `https`, l'importazione va avanti. Un'importazione conta nel limite di `6` azioni pesanti l'ora per sito.

Dettagli e limiti: [ADR 0024](docs/architecture/adr/0024-wordpress-import.md).

### Backup dei Siti

Su runtime `linux-systemd` (`productionBackupRuntimeAvailable: true`), il pannello esegue e conserva backup cifrati dei siti WordPress su storage compatibile S3 tramite contenitore effimero `restic/restic:0.19.1` gestito da `hp-docker-executor`. Gli amministratori configurano la destinazione S3 (endpoint, regione, bucket, prefisso e credenziali), eseguono il test di connessione e impostano la pianificazione notturna in **UTC** (predefinita `02:00 UTC`, eseguita un sito dopo l'altro) e la conservazione automatica (`1–365` giorni, predefinita `14` giorni; i backup manuali conservati sono al massimo `3` per sito; per un sito che esiste ancora le copie riuscite più recenti, tante quanti i giorni di conservazione, non scadono mai per età, quindi un server che ha smesso di fare backup tiene le ultime copie buone; le copie di un sito eliminato scadono per età). I clienti con permesso `site.backups.manage` consultano la cronologia e gestiscono backup manuali, ripristini e download dalla scheda **Backup** del sito. Ogni archivio include i file del sito e un dump logico per ciascun database MariaDB del sito senza riavviare i contenitori (`CP-01`), ed è cifrato con la chiave di installazione `/etc/hosting-panel/backup.key` (`0440 root:hp-executor`), creata una sola volta al bootstrap e mai sovrascritta dagli aggiornamenti. Dalla scheda **Backup** il cliente può ripristinare l'intero sito sul posto (mai singoli file o un singolo database) dietro conferma esplicita del nome del sito e pagina di manutenzione automatica con annullamento in caso di errore. Può inoltre preparare e scaricare una copia decifrata in un unico archivio ZIP (al massimo uno per sito, conservato `60` minuti nella cartella protetta `/var/lib/hosting-panel/backups`; creazione manuale, ripristino e preparazione download condividono il limite di `6` azioni pesanti l'ora per sito).

**Copia del pannello:** ogni notte, dopo i backup dei siti, il pannello salva nello stesso bucket (`<percorso>/panel`) una copia cifrata del proprio database (account, siti, impostazioni) e della chiave `secrets-master.key`; **Amministrazione › Backup** mostra quando è stata fatta l'ultima, la dimensione dell'ultimo backup di ogni sito e il totale, e permette di ripristinare un sito anche quando sul server non ne resta nulla.

Dettagli, deviazioni e limiti completi: [ADR 0022](docs/architecture/adr/0022-site-backups.md).

#### Il server è perso: riportare il pannello su un nuovo server

Serve: la copia di `/etc/hosting-panel/backup.key` tenuta fuori dal server, i dati del bucket (endpoint, regione, bucket, percorso) e le sue chiavi di accesso.

1. Spegni il vecchio server, se è ancora acceso: due server che scrivono nello stesso percorso del bucket si rovinano le copie a vicenda.
2. Installa il pannello sul nuovo server con `install.sh` (stessa versione del vecchio server o più recente).
3. Rimetti la chiave salvata:
   ```bash
   sudo install -m 0440 -o root -g hp-executor backup.key /etc/hosting-panel/backup.key
   ```
4. Riporta il pannello. Lo script chiede le due chiavi S3 (il segreto senza mostrarlo): non scriverle sulla riga di comando, finirebbero nella cronologia della shell. Prima di cambiare qualcosa mostra la data della copia trovata e chiede `y/N`; `--yes` salta la domanda (per un uso senza terminale, dove altrimenti la risposta è no).
   ```bash
   sudo hp-restore-panel --endpoint https://s3.example.com --region us-east-1 --bucket <bucket> --prefix <percorso>
   ```
5. Accedi con l'account amministratore del vecchio server: gli account creati da `install.sh` sul nuovo server non esistono più e tutte le sessioni vanno rifatte.
6. Punta i domini dei siti all'indirizzo del nuovo server.
7. In **Amministrazione › Backup** usa **Ripristina** su ogni sito: il pannello ricrea database, file e sito dall'ultimo backup riuscito.

Codici di uscita: `0` pannello riportato, `1` un passo è fallito (il messaggio dice cosa fare; rilanciarlo è sicuro), `2` rifiutato (argomenti errati, non root, `backup.key` mancante, server con siti già presenti, copia fatta da una versione più recente: aggiorna prima con `hp-update --version <v>`; oppure la domanda non è stata confermata con `y`).

Cosa sapere prima:
- La copia del pannello è quella dell'ultima notte: quanto creato o cambiato dopo (siti, account, impostazioni) non torna.
- Viene presa sempre la copia del pannello più recente.
- Un sito che era fermo torna avviato dopo **Ripristina**.
- Gli utenti database aggiuntivi tornano senza password: reimpostala dalla scheda **Database**.
- Mentre lo script carica la copia il pannello resta fermo e non mostra l'avanzamento; su copie grandi può volerci qualche minuto.

#### Aggiornamento

```bash
sudo hp-update                    # ultima release
sudo hp-update --version 0.6.0    # oppure --archive <file>
```

`hp-update` (wrapper dello `update.sh` della release corrente) accetta `--version` | `--archive`, `--allow-downgrade`, `--dry-run`, `--allow-other-linux`. Riavvia **solo** `hp-host-agent`, `hp-docker-executor`, `hp-api` e `hp-web`; non tocca mai direttamente container Docker, proxy o firewall. Dopo l'aggiornamento esegue il health check e, se fallisce, esegue il rollback automatico; conserva le ultime 3 release. Codici di uscita: `0` aggiornato o già aggiornato, `1` errore generico (un passo è fallito o un altro aggiornamento è in corso), `2` downgrade rifiutato, argomenti errati o archivio il cui `VERSION` non corrisponde al nome del file, `4` checksum, `6` rollback eseguito, `7` rollback fallito.

**Da una versione più vecchia** l'aggiornamento scompatta la nuova versione accanto a quella in uso, poi installa i pacchetti del sistema che la nuova versione vuole e il server non ha (per esempio `nftables` e `unattended-upgrades`), con `apt-get`, e solo dopo installa le unità e i comandi della nuova versione e passa a quella. Se i pacchetti non si installano si ferma, e il pannello resta sulla versione in uso, senza riavvii: controllare le sorgenti di `apt` e la rete, aspettare che finisca un altro `apt` in corso (l'aggiornamento non lo aspetta) e rilanciare. Se le regole di base del firewall sono cambiate, l'aggiornamento scrive il file nuovo ma non lo carica, e stampa «The base firewall rules changed in this version and are not loaded yet»: l'amministratore preme una volta **Applica le regole di base** nella pagina **Amministrazione › Firewall**, che mostra le regole di base come non aggiornate (vedi **Firewall** sotto); fino a quel momento le porte aperte e gli indirizzi bloccati restano in vigore.

**Dalla 0.5.0, cos'altro cambia.** Il database del pannello riceve la migrazione `0019` (17 indici, uno su `audit_events`, uno su `outbox_events`, due su `operations`); su una tabella `audit_events` molto grande il tempo non è misurato. Al primo avvio, quando il MariaDB condiviso è pronto, l'esecutore ripassa l'account database di ogni sito esistente: gli ridà i permessi sul proprio database e, se non aveva un limite, lo limita a 40 connessioni contemporanee (`MAX_USER_CONNECTIONS 40`, [ADR 0021](docs/architecture/adr/0021-site-databases.md)); un sito molto frequentato che dopo l'aggiornamento mostra «troppe connessioni» viene da qui. Dopo l'aggiornamento l'amministratore guarda i servizi generici (non i siti) del server: quelli creati da un cliente restano e il loro proprietario può ancora avviarli; quelli sopra i nuovi tetti (64 GiB di memoria, 64 CPU) o che pubblicano una porta del server ora riservata (per esempio 22, 80, 443, 2222, 3000, 4000) continuano a girare, ma se il loro container sparisce non si possono più ricreare, né correggere con una nuova configurazione: si possono solo eliminare ([ADR 0029](docs/architecture/adr/0029-site-types.md)).

Dal pannello, **Amministrazione › Aggiornamenti** fa lo stesso senza SSH. Il comando `hp-update` resta e funziona come prima.

- **Pannello**: **Cerca una nuova versione** legge l'ultima versione pubblicata; il risultato si perde quando l'API riparte. **Aggiorna il pannello** lancia `hp-update` come root, tramite l'unità `hp-panel-update`. Dura di solito un minuto e mezzo; il database e il proxy possono riavviarsi una volta; se il nuovo pannello non risponde, torna da solo alla versione di prima, e in quel caso il database e il proxy possono riavviarsi una seconda volta. Il suo giornale è nella pagina **Log** («hp-panel-update»). Un `1` per un aggiornamento già in corso si legge come un errore.
- **Container del pannello e siti**: il pannello confronta le immagini in uso con quelle fissate nella versione installata, senza chiedere niente a un registry. **Applica** sposta un container del pannello sulla sua immagine; **Aggiorna** fa lo stesso per un sito avviato (un sito fermo va prima avviato).
- **Pacchetti del sistema**: l'elenco viene da una simulazione (`apt-get -s upgrade`), diviso in sicurezza, distribuzione e altri. **Aggiorna l'elenco dei pacchetti** lancia `apt-get update`; **Installa gli aggiornamenti di sicurezza** lancia `unattended-upgrade` (che `install.sh` installa, e che un aggiornamento da una versione più vecchia aggiunge se manca). Gli altri pacchetti e il riavvio del server si fanno da SSH (`sudo apt-get upgrade`, `sudo reboot`).

Ogni lavoro da root è un'unità `systemd` fissa: l'agente host scrive solo un file vuoto in `/run/hosting-panel/host-jobs` e un'unità *path* avvia il comando scritto nell'unità. Uno solo alla volta, mai durante un backup, un ripristino, un aggiornamento WordPress o un'importazione. Se un'unità *path* è in errore, il pannello rifiuta il lavoro: da SSH `sudo systemctl reset-failed <unità>.path` e `sudo systemctl start <unità>.path`. Su Debian `unattended-upgrades` può accendere aggiornamenti notturni (non verificato); per spegnerli, `sudo dpkg-reconfigure unattended-upgrades`.

#### Recupero accessi

```bash
sudo hp-accounts unlock --email <email>
sudo hp-accounts reset-password --email <email>
sudo hp-accounts reset-totp --email <email>
```

`hp-accounts` supporta anche `setup` e `create-admin`. `sudo hp-break-glass emergency-token --reason <testo> (--user-id <id> | --email <email>) [--ttl 300]` stampa un token di emergenza: un'autorizzazione per chiamare l'API dal server stesso a nome di un amministratore attivo, valida al massimo 300 secondi. **Non apre le pagine del pannello**: nessuna pagina lo accetta. Entrambi i wrapper sono in `/usr/local/sbin`, girano come `hp-api` e leggono `DATABASE_URL` da `/etc/hosting-panel/api.env`.

**Un amministratore tenuto fuori da qualcuno da fuori.** Chi conosce l'email di un amministratore può tenerne bloccato l'account ripetendo tentativi sbagliati (5 in 15 minuti; anche un tentativo con un codice TOTP conta prima che la password sia controllata). SSH non ne è toccato. Da SSH si crea un secondo amministratore con un indirizzo che nessuno fuori conosce:

```bash
sudo hp-accounts create-admin --email <nuovo-indirizzo> --name "Nome Cognome"
```

La password è chiesta in un prompt nascosto; il comando stampa una sola volta la chiave TOTP e l'URI `otpauth`, da registrare subito. Il blocco vale per account: chi non conosce il nuovo indirizzo non lo può bloccare. `unlock` da solo sblocca il vecchio account, che può essere bloccato di nuovo subito.

**Troppe richieste.** Il server controlla al massimo 2 password alla volta e ne tiene 16 in attesa. Un accesso con un indirizzo che non ha un account può occupare solo 4 di questi posti: quando sono occupati riceve subito «Email o password non corrette», la stessa risposta che dà dopo un controllo. Così un'ondata di accessi con indirizzi inventati non tiene fuori gli account veri, e l'amministratore creato con `create-admin` entra anche durante l'ondata. Un link di reimpostazione che non esiste, è scaduto o è già stato usato è rifiutato senza occupare posti. Quando i posti sono tutti occupati da account veri, l'accesso (e il cambio di una password, la reimpostazione con un link valido, la disattivazione del TOTP, la creazione di un utente) risponde subito «Troppe richieste» (`429 RATE_LIMITED`); questa risposta non conta come tentativo sbagliato, né all'accesso né nella pagina dell'account. Riprovare dopo un minuto.

Dal pannello (**Amministrazione › Utenti**):

- **Altri amministratori.** Un amministratore crea un altro amministratore con nome ed email. Il pannello mostra **una sola volta** la password temporanea e la chiave del secondo fattore (TOTP): chi crea l'account le vede e le consegna. Al primo accesso il nuovo amministratore deve cambiare la password. Un amministratore può disattivare e riattivare gli altri, non se stesso; il pannello rifiuta di disattivare l'ultimo amministratore attivo. La password e il TOTP di un amministratore si reimpostano ancora **solo** con i comandi qui sopra, sul server.
- **Password dimenticata (cliente).** Dalla pagina di accesso, «Password dimenticata?» chiede l'email e invia un link per scegliere una nuova password. Il link vale **30 minuti** e **una volta**; dopo il cambio ogni sessione aperta si chiude, mentre il secondo fattore resta com'era. La pagina risponde allo stesso modo per ogni indirizzo, quindi non dice se un account esiste. Al massimo 3 richieste all'ora per account e 20 all'ora in tutto. Serve l'**email in uscita configurata** (vedi sopra); senza, nessuna mail parte e il cliente deve chiedere all'amministratore. Un amministratore non riceve mai questa mail.
- **Accesso di assistenza.** Dalla pagina **Siti**, «Apri la vista di assistenza» apre i siti del cliente nella sua stessa vista, per **60 minuti**, con un segno in cima alle pagine dei siti che dice di chi sono i siti e fino a che ora (non compare in phpMyAdmin, su una pagina di errore imprevisto, su un indirizzo che non corrisponde a nessuna pagina, né quando il pannello non riesce a leggere l'account durante la visita: lì compare solo l'errore di caricamento, senza dati del cliente); «Esci» chiude la visita. L'amministratore può fare tutto ciò che il cliente fa sui propri siti, ma non tocca i membri né le impostazioni del cliente. Apertura e uscita sono registrate nell'audit (`admin.support_access.open`, `admin.support_access.close`); ogni azione fatta durante la visita è registrata come al solito, con l'amministratore come autore.

Dettagli e limiti: [ADR 0025](docs/architecture/adr/0025-people-and-access.md).

#### Stato, avvisi e log

**Amministrazione › Stato** dice cosa funziona ora su questo server. La pagina si calcola a ogni apertura: per un nuovo controllo si ricarica.

- **Avvisi**: i problemi aperti, prima i critici. Ogni avviso dice cosa fare, spesso con il comando da usare sul server. Un avviso sparisce da solo quando il problema finisce; non c'è uno storico degli avvisi.
- **Parti del pannello**: API, pannello web, database del pannello, esecutore, agente host, Docker Engine e i cinque container del pannello (`hp_ingress_proxy`, `hp_mariadb`, `hp_phpmyadmin`, `hp_sftp`, `hp_mail_relay`). Stati: Funziona, Degradato, Non funziona, Non in uso (un container che il pannello non usa ancora, per esempio phpMyAdmin prima del primo accesso), Sconosciuto. L'esecutore e l'agente host risultano «Non funziona» se non inviano segnali da 5 minuti. I container sono controllati ogni 15 secondi.
- **Container dei siti**: per ogni sito, come dovrebbe essere e com'è, la differenza dalla configurazione voluta e i riavvii. Un dato più vecchio di 5 minuti è segnato come «non rilevato di recente».
- **Servizi del server**: i quattro servizi del pannello (`hp-api`, `hp-web`, `hp-docker-executor`, `hp-host-agent`), letti dal vivo a ogni apertura (al massimo 3 secondi; se l'agente host non risponde la scheda lo dice). Ognuno ha **Riavvia**, con un motivo, come i container (`admin.host_service.restart` e, alla fine, `admin.host_service.restart.end`).
- **Dischi**: lo spazio usato dei dischi che contengono `/var/lib/hosting-panel`, `/var/lib/docker`, `/var/lib/postgresql` e `/`. Dal 90% c'è un avviso critico.

In cima a ogni pagina di **Amministrazione** una riga dice quanti avvisi sono aperti e il livello più alto, con il link a **Stato**; senza avvisi la riga non c'è. La riga si aggiorna a ogni cambio di pagina. Se gli avvisi non si possono caricare, la riga lo dice: in quel caso la pagina non sa se va tutto bene.

**Amministrazione › Log** mostra le ultime righe (100, 200 o 500) dei cinque container del pannello, del container di ogni sito e dei giornali di systemd dei quattro servizi del pannello e dei tre lavori del server (`hp-panel-update`, `hp-os-refresh`, `hp-os-upgrade`). Nelle righe di phpMyAdmin la parte dopo `?` degli indirizzi è nascosta. Leggere il log di un sito è registrato nel **Registro attività** (`admin.site.logs.read`); leggere quello di un container del pannello o un giornale no. Per righe più vecchie delle ultime 500 si usa `journalctl` sul server.

I container dei siti e `hp_mariadb` tengono al massimo 3 file di log da 10 MB. Un container creato prima di questa versione non ha questo limite finché non viene ricreato: quello di un sito al suo prossimo deploy, `hp_mariadb` solo se manca o cambia la sua configurazione.

**Amministrazione › Registro attività** mostra chi ha fatto cosa, dal più recente. Si filtra per organizzazione, azione e date (**Dal** incluso, **Al** escluso, nel fuso orario del browser) e si legge a pagine; dopo 100 pagine si restringono le date.

Dettagli e limiti: [ADR 0026](docs/architecture/adr/0026-health-alerts-and-logs.md).

#### Riavviare un sito o un container del pannello

In **Amministrazione › Stato** il pulsante **Riavvia** è su ogni riga dei **Container dei siti** e sulle righe dei cinque container del pannello (non su un container «Non in uso», mancante o con il runtime disattivato). Il riavvio chiede un **motivo** (obbligatorio, al massimo 500 caratteri): finisce nel **Registro attività** (`admin.site.restart`, `admin.panel_container.restart` e, alla fine, `admin.panel_container.restart.end`) perché chi legge dopo sappia perché è stato fatto; i clienti non lo vedono mai. La finestra dice cosa si interrompe, poi segue il riavvio fino alla fine (dopo 3 minuti senza risposta dice che non lo sa: ricarica la pagina).

- **Un sito**: non risponde per qualche secondo; una pagina in caricamento o un upload in corso falliscono. Se il cliente aveva fermato il sito, **Riavvia lo fa ripartire** e resta attivo finché qualcuno non lo ferma (la finestra lo avvisa). Se il container del sito non c'è più, viene creato di nuovo dalla configurazione salvata dal pannello, purché la creazione del sito fosse riuscita e nessuno ne abbia chiesto la cancellazione.
- **`hp_ingress_proxy`**: tutti i siti e il pannello non rispondono per qualche secondo; la pagina si ricollega da sola.
- **`hp_mariadb`**: i database dei siti si fermano, di solito per meno di un minuto; un backup o un ripristino di database in corso fallisce e va rifatto.
- **`hp_phpmyadmin`**: si ferma per qualche secondo; chi lo usa lo riapre dalla scheda **Database**.
- **`hp_sftp`**: le connessioni SFTP aperte si chiudono; un trasferimento in corso va rifatto.
- **`hp_mail_relay`**: la posta che un sito invia in quei secondi può fallire e non viene rinviata.

Un riavvio del pannello parte circa 2 secondi dopo la richiesta e dura al massimo 35 secondi; se non riesce, la riga di **Stato** dice com'è davvero il container.

**Dopo un riavvio del server** i siti ripartono da soli. Un servizio generico (non un sito) che usa segreti non riparte da solo, e il pannello non ha un pulsante per riavviarlo: lo riavvia il proprietario dal browser con la route BFF `POST /api/bff/orgs/{orgId}/services/{serviceId}/lifecycle` (sessione `hp_session` e `X-CSRF-Token`, corpo `{"action":"restart"}` o `{"action":"deploy"}`; l'API `/v1` ascolta solo su `127.0.0.1`), e l'esecutore riscrive i file dei segreti prima di avviarlo.

#### Terminale di un sito

**Terminale** è un link sulla riga di un sito in **Amministrazione › Stato** (container in esecuzione o degradato) e in **Amministrazione › Siti** (sito pronto o degradato). Apre una shell di solo testo dentro il container del sito, come utente del web server (`33:33`, mai root), nella cartella del sito.

- Serve l'**autenticazione in due passaggi** sull'account: ogni apertura chiede un **codice nuovo** dell'app; un codice già usato (anche per l'accesso) è rifiutato fino al prossimo. I codici errati si contano come quelli dell'accesso: al quinto l'account è bloccato per 15 minuti.
- Si possono lanciare comandi riga per riga (al massimo 4096 byte per riga), fermarli con **Ctrl-C** e chiudere la shell con **Ctrl-D**. Non funzionano i programmi a schermo intero (editor, pager, `top`).
- Una sessione per sito e quattro sul server. Una sessione finisce da sola dopo **30 minuti**, o **60 secondi** dopo che la pagina smette di leggere (scheda chiusa o in sospensione).
- Il **Registro attività** registra chi ha aperto la sessione, su quale sito, quando, quanto è durata e come è finita (`admin.terminal.open`, `admin.terminal.close`), e ogni apertura rifiutata (`admin.terminal.denied`). Ciò che viene digitato e ciò che la shell stampa **non** è mai registrato.

Dettagli e limiti: [ADR 0027](docs/architecture/adr/0027-restart-and-terminal.md).

#### Firewall

**Amministrazione › Firewall** gestisce il firewall `nftables` del server (tabella `inet hp_dedicated_filter`).

- **Regole di base**: in ingresso restano aperte solo SSH sulla 22, HTTP e HTTPS (80, 443) e le porte sicure aperte nella pagina; la porta del pannello web (3000) risponde solo ai container del server (la console si raggiunge dalla 443); tutto il resto in ingresso è chiuso, anche SSH su un'altra porta, tranne l'SFTP dei siti sulla 2222, che va a un container e non passa da queste regole. La pagina dice se sono in vigore; **Applica le regole di base** le carica di nuovo. Se SSH ascolta su un'altra porta, non applicarle. Le regole di base hanno anche una catena `forward`: quanto parte dai container dei siti (`docker0`, `br-*`) verso `169.254.0.0/16` è scartato, tranne il DNS (porta 53, UDP e TCP), e verso `fd00:ec2::254` è scartato tutto, così il codice di un sito non raggiunge l'indirizzo dei metadati di un server cloud. Non sono coperti un servizio di metadati fuori da quell'intervallo (per esempio `168.63.129.16`, `100.100.100.200`) né la porta 53 dell'intervallo `169.254.0.0/16`.
- **Server aggiornato da una versione senza la catena `forward`**: la pagina mostra le regole di base come non aggiornate e offre **Applica le regole di base**; finché nessuno lo preme resta caricata la tabella di prima, che continua a servire le porte aperte e i blocchi, e la modifica di una voce è rifiutata con la richiesta di applicare prima le regole di base. Una pressione ricarica le regole di base (la tabella è cancellata e ricreata, le liste ripartono vuote), poi il pannello rimanda le voci salvate; se l'invio non riesce, le voci si mostrano «Salvato, non attivo» fino ad **Applica di nuovo**, alla prossima modifica o al prossimo avvio dell'API. Limite noto: tra i due passi, per un momento, le porte sicure aperte sono chiuse alle nuove connessioni e gli indirizzi bloccati passano.
- **Server installato con `--skip-firewall`**: il pannello non tocca il firewall del server, e la pagina lo dice; non offre **Applica le regole di base** né le modifiche, e quanto è salvato nella pagina non è in vigore. Il pannello gestisce il firewall solo se c'è `/etc/nftables.d/hosting-panel.nft`, che l'installer scrive solo dopo aver controllato che SSH ascolti sulla 22. Per affidargli il firewall: controlla che SSH ascolti sulla 22, poi rilancia sul server, via SSH, il comando `sudo bash …/install.sh` dell'installazione (sopra) con `--version` e la versione installata che mostra la pagina **Aggiornamenti** (o l'archivio di quella versione), gli altri argomenti come all'installazione, senza `--skip-firewall`; l'installer controlla di nuovo la porta di SSH e carica le regole di base, e il pannello si riavvia e resta assente per circa un minuto. L'installer accetta solo la versione installata: per ogni altra esce con `2` e dice cosa lanciare (per una più nuova, `sudo hp-update --version <versione>`). Rilanciarlo con `--skip-firewall` su un server il cui firewall è del pannello non lo restituisce: l'installer avvisa e dice come toglierlo (sopra, nell'installazione).
- **Porte sicure**: sei porte da aprire o chiudere per nome (8080, 8443, 9100, 10050, 6556, 5666). Mai 22, 80, 443, 3000, un database o una porta di Docker. La porta SFTP 2222 non è qui.
- **Indirizzi bloccati**: un indirizzo o una rete IPv4 (fino a `/16`) o IPv6 (fino a `/32`), con una nota; al massimo 500 per famiglia. Un indirizzo bloccato non raggiunge più i siti né il pannello, e il server e i siti non ricevono più le sue risposte. La porta 22 resta raggiungibile. Il pannello rifiuta un blocco che contiene l'indirizzo da cui lo stai usando, quando lo conosce.

Le liste sono salvate nel database e mandate al server a ogni modifica e a ogni avvio dell'API. Una voce salvata ma non nel kernel si mostra «Salvato, non attivo»: **Applica di nuovo** la rimette (se un blocco ti ha chiuso fuori, prima toglilo). Dopo un riavvio del server le liste mancano finché l'API non riparte. Ogni modifica è nel **Registro attività** (`admin.firewall.port_open`, `port_close`, `block`, `unblock`).

**Se un blocco ti chiude fuori dal pannello**, entra con SSH (la 22 resta aperta) e svuota i blocchi:

```bash
sudo nft flush set inet hp_dedicated_filter blocked_v4
sudo nft flush set inet hp_dedicated_filter blocked_v6
```

Vale fino alla prossima modifica del firewall o al prossimo avvio dell'API, che rimandano le liste salvate: appena rientri nel pannello togli il blocco sbagliato (si vede come «Salvato, non attivo») e solo dopo usa **Applica di nuovo**, che rimanda tutte le voci salvate.

Dettagli e limiti: [ADR 0028](docs/architecture/adr/0028-host-firewall-and-updates.md).

Per collegare in locale container reali PostgreSQL 18.1, Redis 7.4 e Keycloak 26.2.0 vincolati su `127.0.0.1`:

```bash
docker compose -f infra/local/docker-compose.yml up -d
cp .env.example .env
corepack pnpm run build
```

---

## 5. Ruoli e Console

Il prodotto ha **due ruoli** in uso, ciascuno con la sua console; la radice `/` porta l'utente alla sua (`/admin/hosts` o `/sites`). L'interfaccia è in italiano (predefinito) e inglese, per utente.

| Ruolo | Chi | Console | Cosa fa |
| :--- | :--- | :--- | :--- |
| **`infrastructure_admin`** | Amministratore del server (`users.platform_role`, 2FA TOTP obbligatorio), creato da `install.sh`, da `hp-accounts create-admin` o da **Amministrazione › Utenti** | `/admin/*` | Server, siti di tutti i clienti, utenti, backup, firewall, aggiornamenti, stato, log e registro attività. Sui siti di un cliente agisce come il cliente solo con l'accesso di assistenza (sopra). |
| **`customer_owner`** | Il cliente, creato dall'amministratore in **Amministrazione › Utenti** con la sua organizzazione | `/sites/*` | I propri siti: avvio e arresto, PHP, domini, file, SFTP, database, backup, strumenti WordPress, log. |

Il login (`POST /v1/auth/login`) blocca l'account dopo 5 tentativi falliti in 15 minuti (contatore separato per il codice TOTP). La tabella dei permessi contiene anche `hosting_admin` e `customer_collaborator`, ma nessuna pagina e nessun comando del pannello li assegna (li usano solo i dati di prova di sviluppo): non hanno una console. Creare un servizio generico (non un sito), cambiarne la configurazione e invitare un membro in un'organizzazione chiedono un amministratore del server che sia anche membro dell'organizzazione del cliente, e il pannello non rende mai un amministratore membro di un'organizzazione cliente: su un server installato queste azioni sono chiuse a tutti. Un cliente di un'altra organizzazione, o un amministratore senza visita o con una visita chiusa, riceve `404`; un membro che non è amministratore, una visita scaduta o una visita aperta ricevono `403`. Un servizio generico e un secondo membro di un'organizzazione non sono funzioni di questa versione.

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
- [Registro delle ADR (`ADR 0001..0030`)](docs/architecture/adr/): Decisioni architetturali formali (inclusi `ADR-010` approvato, `ADR-011` `OPEN — prima di Shared`, `ADR-013..0015` `ADR-0016` MariaDB condiviso e job dei siti, `ADR-0017` domini e TLS, `ADR-0018` email in uscita, `ADR-0019` file manager dei siti, `ADR-0020` accesso SFTP per sito, `ADR-0021` database per sito e phpMyAdmin, `ADR-0022` backup dei siti su S3, `ADR-0023` strumenti WordPress, `ADR-0024` importazione WordPress, `ADR-0025` amministratori, password per email e accesso di assistenza, `ADR-0026` stato, avvisi e log, `ADR-0027` riavvio e terminale, [`ADR-0028`](docs/architecture/adr/0028-host-firewall-and-updates.md) firewall, aggiornamenti, pacchetti e giornali del server, [`ADR-0029`](docs/architecture/adr/0029-site-types.md) tipi di sito, `ADR-0030` certificati DNS-01).
- [Diagrammi di Confine e Modello ER](docs/architecture/diagrams/domain-er-and-boundaries.md): Confini di fiducia e schema relazionale PostgreSQL.
- [Piano di Sicurezza e Protocollo di Outage (`AC-F1-08`)](docs/security/phase-1-test-and-outage-plan.md): Matrice delle minacce e specifica del test di outage `CP-01`.
- [Report di audit](docs/security/audit-report.md): ogni finding dell'audit di M6 con il suo stato, aperto o chiuso.
