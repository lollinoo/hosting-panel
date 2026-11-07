# Registro delle Decisioni Aperte per la Fase 2 (`HCP-SPEC-002`)

- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §8 Step 5, §10, `AC-F1-10`  
- **Stato:** Documento di Indirizzo e Pianificazione Fase 2  

---

## 1. Introduzione e Principi di Transizione

La Fase 1 di Hosting Control Panel (`HCP-SPEC-002`) ha consolidato il Control Plane logico: il modello di dominio relazionale, le politiche di ammissione e sicurezza, la gestione immutabile delle revisioni stack, la segregazione autorizzativa RBAC/ABAC a 4 livelli e l'interfaccia utente a tre console.

In ossequio al principio di non-selezione prematura e ai non-goal stabiliti in `HCP-SPEC-002` §1.3 e `AC-F1-10`, tutti i componenti operativi legati all'interazione a basso livello con il sistema operativo Linux e il daemon Docker sono stati deliberatamente isolati dietro interfacce contrattuali disabilitate (`NOT_SUPPORTED`).

Il presente documento analizza in modo esaustivo i **10 argomenti obbligatori per la Fase 2**, esplicitando le opzioni tecnologiche, i trade-off, i criteri decisionali oggettivi e la motivazione della loro non-implementazione nella Fase 1.

---

## 2. I 10 Argomenti Aperti della Fase 2

### 2.1 Topologia di Processo del Docker Executor
- **Descrizione e Scopo**: Definire come il componente `DockerExecutor` viene pacchettizzato ed eseguito sull'host rispetto al processo API del Control Plane.
- **Opzioni a Confronto**:
  - *Opzione 1 (In-Process)*: Esecuzione dell'esecutore all'interno dello stesso processo NestJS via socket Unix locale. Svantaggio: accoppiamento del ciclo di vita e rischio di blocco del server API in caso di operazioni Docker pesanti.
  - *Opzione 2 (Demone `systemd` Unificato)*: Un singolo servizio di sistema (`hosting-panel-agent.service`) che gestisce sia Docker sia le operazioni host. Svantaggio: violazione del principio del minimo privilegio.
  - *Opzione 3 (Split Agents)*: Due unità `systemd` distinte (`hp-docker-executor.service` privo di permessi root e `hp-host-agent.service` con privilegi ristretti). Vantaggio: massima sicurezza e isolamento dei domini di guasto.
- **Criteri Decisionali per la Fase 2**: Isolamento dei privilegi (`least privilege`), robustezza ai riavvii concorrenti, facilità di installazione e aggiornamento pacchetto.
- **Non-Selezione in Fase 1**: Nessun demone è stato creato; l'interfaccia `DockerExecutorPort` è istanziata come stub logico in `packages/executor-contracts` (`ADR-005`, `ADR-010`).

---

### 2.2 Protocollo IPC Locale Autenticato e Futuro Protocollo Hub
- **Descrizione e Scopo**: Stabilire il canale di comunicazione sicuro tra il Control Plane API e gli agenti locali, predisponendo al contempo il protocollo per l'eventuale comunicazione con l'Hub di gestione remoto (`ADR-008`).
- **Opzioni a Confronto**:
  - *Opzione 1 (Unix Domain Socket con `SO_PEERCRED`)*: Massima efficienza e sicurezza a livello kernel Linux senza overhead crittografico per la comunicazione locale.
  - *Opzione 2 (gRPC su HTTP/2 locale con mTLS)*: Fortemente tipizzato con Protocol Buffers, ideale per l'estensione verso l'Hub remoto tramite connessioni TLS bidirezionali con certificati generati durante il bootstrap.
  - *Opzione 3 (REST locale con Bearer Token pre-condiviso)*: Semplice da implementare ma più vulnerabile a fughe di file o snooping locale.
- **Criteri Decisionali per la Fase 2**: Throughput nei flussi di streaming dei log/metriche, robustezza crittografica, portabilità tra comunicazione locale e federata remota.
- **Non-Selezione in Fase 1**: Nessuna porta o socket IPC è aperta in Fase 1; i contratti sono invocati in-memory tramite interfacce TypeScript.

---

### 2.3 Minimizzazione dei Privilegi Root e Modello delle Linux Capabilities
- **Descrizione e Scopo**: Definire l'insieme minimo di privilegi necessari all'Host Agent per eseguire le attività di sistema (gestione storage, firewall, quote) senza operare come `root` indiscriminato.
- **Opzioni a Confronto**:
  - *Opzione 1 (Esecuzione come `root` completo)*: Approccio legacy insicuro; espone l'intero host a compromissione totale in caso di vulnerabilità nell'agente.
  - *Opzione 2 (Utente di sistema dedicato con sudoers ristretto)*: Script richiamati via `sudo` con comandi specificati in `/etc/sudoers.d/hosting-panel`. Svantaggio: fragilità nel parsing dei parametri e overhead di fork.
  - *Opzione 3 (Linux Capabilities dedicate + Ambient Capabilities)*: Il processo gira come utente non privilegiato `hp-agent` a cui vengono assegnate unicamente le capability indispensabili (`CAP_NET_ADMIN` per nftables, `CAP_SYS_ADMIN` ristretta per i mount, con seccomp filter).
- **Criteri Decisionali per la Fase 2**: Rifiuto categorico di privilegi root globali; verificabilità tramite test automatici di confinamento delle capabilities.
- **Non-Selezione in Fase 1**: L'Host Agent in Fase 1 non esegue alcun comando a livello di sistema operativo (`ADR-006`).

---

### 2.4 Distribuzioni Linux Target e Ciclo di Vita delle Patch OS
- **Descrizione e Scopo**: Identificare le distribuzioni Linux ufficialmente supportate per il deployment dell'appliance e definire la strategia di aggiornamento del sistema operativo host senza disservizi sui container dei clienti (`CP-01`).
- **Opzioni a Confronto**:
  - *Distribuzioni Target*: Ubuntu 24.04 LTS (Noble Numbat), Debian 12 (Bookworm), AlmaLinux 9 / Rocky Linux 9 (enterprise RHEL-compatible).
  - *Strategia Aggiornamenti*: Aggiornamenti unattended automatici per security advisories (`unattended-upgrades`); riavvio programmato del kernel gestito tramite kexec o finestre di manutenzione notturne con drenaggio e riesecuzione rapida dei container.
- **Criteri Decisionali per la Fase 2**: Stabilità a lungo termine (LTS), disponibilità di pacchetti ufficiali moderni (Docker Engine CE, kernel 6.x+), assenza di breaking change nelle API di sistema.
- **Non-Selezione in Fase 1**: La Fase 1 è agnostica rispetto alla distribuzione host e gira interamente in modalità portatile Zero-Docker (`PGlite`).

---

### 2.5 Layout dello Storage, Scelta del Filesystem e Quote Disco per Volumi
- **Descrizione e Scopo**: Selezionare l'architettura del filesystem e il meccanismo vincolante per imporre quote disco rigide per volume/tenant in modalità Shared Hosting (`ADR-011`).
- **Opzioni a Confronto**:
  - *ZFS con refquota*: Massima integrità e snapshot atomici, ma richiede supporto modulo kernel e memoria RAM aggiuntiva.
  - *XFS con Project Quotas*: Nativo in upstream Linux, ideale per quote di directory indipendenti da UID/GID, richiede partizione XFS formattata con opzione `pquota`.
  - *Btrfs con qgroups*: Buona flessibilità ma storicamente soggetto a cali prestazionali con molti snapshot.
- **Criteri Decisionali per la Fase 2**: Test comparativo di performance I/O sotto 10.000 file concorrenti, supporto nativo sulle distro target senza moduli DKMS esterni, affidabilità del blocco delle scritture al raggiungimento del limite (`ENOSPC`).
- **Non-Selezione in Fase 1**: L'architettura MVP è Dedicated-First (`ADR-002`); la decisione rimane formalmente aperta (`ADR-011`).

---

### 2.6 Segmentazione di Rete dei Container, Reverse Proxy Data Plane e Ciclo ACME/TLS
- **Descrizione e Scopo**: Definire la topologia di rete interna dei container applicativi, il motore di reverse proxy di produzione e la gestione automatizzata dei certificati crittografici TLS.
- **Opzioni a Confronto**:
  - *Motore Reverse Proxy*: Traefik v3 (nativamente orientato a Docker labels/providers) vs Caddy v2 (configurazione dichiarativa snella e gestione automatica TLS) vs Nginx/Envoy con controller generato.
  - *Topologia di Rete*: Reti bridge Docker private isolate per ciascun `Site` (`site_<id>_net`), connesse unicamente al reverse proxy. Divieto di default bridge Docker e divieto di routing inter-tenant.
  - *Ciclo ACME*: Sfida HTTP-01 automatica intercettata dal reverse proxy o DNS-01 via API del provider DNS, con rinnovo preventivo a 30 giorni dalla scadenza.
- **Criteri Decisionali per la Fase 2**: Riconfigurazione a caldo senza perdita di connessioni attive (*zero-downtime reload*), isolamento di rete verificato via test di sniffing negativo.
- **Non-Selezione in Fase 1**: Nessun proxy di rete o demone ACME è attivo; i domini sono memorizzati a livello di catalogo e metadati (`domains`).

---

### 2.7 Confinamento Chroot SFTP, Database Gestiti dei Clienti, Backup e Segreti
- **Descrizione e Scopo**: Fornire accesso sicuro ai file applicativi per gli sviluppatori (SFTP), motori di database per i siti (MariaDB / PostgreSQL gestiti) e strategie di backup e cifratura dei segreti a riposo.
- **Opzioni a Confronto**:
  - *SFTP*: OpenSSH integrato con `ChrootDirectory` confinata sul volume del sito e autenticazione a chiavi SSH pubbliche ed ED25519 vs demone SFTP in container Go dedicato per tenant.
  - *Database Gestiti*: Istanze sidecar dedicate per ciascun sito (massimo isolamento) vs cluster database multi-utente condiviso con utente e schema dedicati (maggiore densità).
  - *Backup*: Snapshot incrementali deduplicati e cifrati lato client inviati verso storage compatibile S3 (tramite restic o borgbackup), con verifica periodica di integrità del restore.
  - *Gestione Segreti*: Envelope encryption con Master Key salvata su file a permessi `0400` o integrata con TPM 2.0 / HashiCorp Vault.
- **Criteri Decisionali per la Fase 2**: Rischio zero di escape dal chroot SFTP, affidabilità del dump dei database con lock consistente, crittografia end-to-end dei backup.
- **Non-Selezione in Fase 1**: Funzionalità escluse dall'MVP per perimetro contrattuale (`HCP-SPEC-002` §1.3).

---

### 2.8 Bootstrap dell'Appliance, Installer e Procedure di «Break-Glass»
- **Descrizione e Scopo**: Progettare la procedura automatizzata per inizializzare da zero un VPS vergine (*appliance installer*) e il protocollo di recupero di emergenza (*break-glass*) in caso di perdita dell'accesso web o corruzione del database.
- **Opzioni a Confronto**:
  - *Installer*: Script shell posix minimale (`curl -sSL https://... | sh`) che installa Docker, pnpm/node o estrae binari compilati standalone, configurando systemd e firewall.
  - *Ansible Playbook / cloud-init*: Ideale per deployment automatizzato su larga scala da parte di provider infrastrutturali.
  - *Procedura Break-Glass*: Tool CLI locale (`hosting-panel-cli admin-reset`) eseguibile via sessione console/SSH dell'host per generare un token OIDC monouso ad accesso diretto o forzare il rilascio di un lock bloccato.
- **Criteri Decisionali per la Fase 2**: Semplicità di bootstrap su VPS pulito (tempo totale di installazione `< 3 minuti`), sicurezza dei token di emergenza, idempotenza dell'installer.
- **Non-Selezione in Fase 1**: In Fase 1 lo sviluppo e i test avvengono tramite script `corepack pnpm dev` e topologia Docker Compose locale.

---

### 2.9 Monitoraggio Host/Container, Streaming dei Log senza Fuga di Segreti e Resilienza
- **Descrizione e Scopo**: Raccogliere metriche di utilizzo delle risorse (CPU, RAM, disco, I/O) a intervalli regolari e offrire lo streaming in tempo reale dei log applicativi dei container proteggendo al contempo i dati sensibili.
- **Opzioni a Confronto**:
  - *Metriche*: Ispezione periodica cgroups v2 e `node_exporter` / `cadvisor` leggero integrato.
  - *Log Streaming*: Motore di streaming basato su WebSocket o Server-Sent Events (SSE) nel BFF, con pipeline di sanitizzazione automatica regex per mascherare password, token Bearer e stringhe di connessione prima dell'invio al browser.
  - *Resilienza*: Riconciliazioni periodiche del drift (`drift reconciler`) ogni 60 secondi per rilevare discrepanze o arresti inattesi dei container.
- **Criteri Decisionali per la Fase 2**: Impatto computazionale del monitoraggio (`< 1%` CPU a riposo), affidabilità del mascheramento dei segreti, latenza di streaming `< 200ms`.
- **Non-Selezione in Fase 1**: Nella Fase 1 lo stato runtime è rappresentato tramite l'entità statica `ObservedState` valorizzata nei test.

---

### 2.10 Metriche Oggettive dei Security Gate per l'Abilitazione dello Shared Hosting
- **Descrizione e Scopo**: Formalizzare i requisiti di collaudo misurabili e i test di penetrazione obbligatori da superare con successo prima di consentire l'erogazione di siti in modalità Shared in produzione (`ADR-007`).
- **Metriche e Test di Accettazione Mandatori**:
  1. *Test di Esaurimento Spazio su Disco*: Uno script nel container tenta di creare un file da 100 GB; la scrittura deve essere bloccata esattamente al tetto stabilito dalla quota (`ENOSPC`) senza impattare i file del tenant adiacente.
  2. *Test di Fork Bomb e OOM Throttling*: Uno script genera 5.000 thread o alloca memoria all'infinito; il container deve essere limitato o terminato dal cgroup senza causare instabilità sull'host o sugli altri siti.
  3. *Test di Penetrazione di Rete Inter-Container*: Uno scanner `nmap` all'interno del container di un tenant non deve essere in grado di raggiungere o scoprire le porte private dei container degli altri tenant sulla rete bridge.
  4. *Rapporto di Pen-Testing su Escape da Container*: Verifica condotta con tool di sicurezza automatizzati per escludere permessi non sicuri nei mount e vulnerabilità note del kernel.
- **Criteri Decisionali per la Fase 2**: Raggiungimento del 100% di superamento di tutti i test oggettivi e firma del comitato di sicurezza dell'operatore.
- **Non-Selezione in Fase 1**: La modalità Shared rimane rigorosamente chiusa e bloccata a livello di policy (`AC-F1-06`, `AC-F1-10`).
