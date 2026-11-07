# ADR 0010 — Topologia di Processo e Meccanismo IPC per «Docker Executor» e «Host Agent»

- **Stato:** `OPEN — Fase 2`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §2.2, §8 Step 5, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Nel design architetturale di `HCP-SPEC-002`, il Control Plane è logicamente separato da:
1. Il **Docker Executor**: componente incaricato di interagire con il motore container Docker per creare, avviare, monitorare e terminare i container, i network e i volumi dei servizi applicativi.
2. Lo **Host Agent**: componente privilegiato incaricato di eseguire operazioni a livello di sistema operativo host (configurazione firewall, allocazione storage, quote disco, monitoraggio hardware).

La questione fondamentale riguarda la **topologia fisica dei processi** e il **protocollo di comunicazione inter-processo (IPC)** da adottare su Linux tra l'applicazione NestJS (Control Plane API) e questi due componenti di esecuzione.

---

## 2. Opzioni Architetturali a Confronto

### Opzione A: Agente Unificato Monolitico (`unified-agent`)
Un unico processo daemon in esecuzione sull'host con privilegi di root, che racchiude sia l'accesso al socket Docker (`/var/run/docker.sock`) sia i comandi operativi sul sistema operativo.
- *Vantaggi*: Semplicità di packaging (un solo binario o servizio systemd da avviare).
- *Svantaggi*: Mancata segregazione dei privilegi. Se il codice di gestione dei container viene compromesso, l'attaccante ottiene direttamente l'accesso ai privilegi di amministrazione host.

### Opzione B: Agenti Separati a Privilegi Distinti (`split-agents`)
Due demoni separati eseguiti come unità `systemd` indipendenti:
- `docker-executor`: Processo dedicato, con utente non-root appartenente al gruppo di sistema `docker`, privo di permessi di amministrazione OS.
- `host-agent`: Processo minimale e confinato, con permessi root ristretti tramite Linux Capabilities (`CAP_NET_ADMIN`, `CAP_SYS_ADMIN` selettive) o policy AppArmor/seccomp, abilitato solo a comandi esplicitamente consentiti.
- *Vantaggi*: Massima applicazione del principio del minimo privilegio (*least privilege*); isolamento dei domini di guasto e di attacco.
- *Svantaggi*: Maggiore complessità di installazione, packaging e monitoraggio di due servizi distinti.

### Canali IPC Valutati
1. **Unix Domain Socket (UDS) con Credenziali Peer (`SO_PEERCRED`)**:
   Comunicazione locale ad altissime prestazioni su socket Unix dedicati (es. `/run/hosting-panel/executor.sock`), con autenticazione basata sul controllo a livello kernel di UID/GID del processo chiamante.
2. **gRPC su loopback locale con autenticazione mTLS**:
   Comunicazione tramite protocollo gRPC su interfaccia `127.0.0.1` con certificati client/server generati localmente all'installazione.
3. **HTTP/2 REST o JSON-RPC locale con token condiviso**:
   Chiamate HTTP autenticate tramite Bearer Token o secret pre-condiviso su file locale con permessi `0600`.

---

## 3. Decisione: Stato «OPEN» per la Fase 2

**Questa decisione rimane formalmente APERTA (OPEN) e NON viene risolta nella Fase 1**.

### Motivazione e Limiti di Fase 1 (`AC-F1-10`)
In conformità a `HCP-SPEC-002` §1.3 e §8 Step 5:
- Nella Fase 1, entrambi i confini sono definiti unicamente come **interfacce logiche TypeScript** (`@hosting-panel/executor-contracts` e `@hosting-panel/host-agent-contracts`).
- Le implementazioni fornite sono stub disabilitati (`Phase1DisabledDockerExecutor` e `Phase1DisabledHostAgent`) che restituiscono invariabilmente l'errore `NOT_SUPPORTED`.
- È categoricamente vietato scegliere o implementare tacitamente una specifica topologia di processo, demone di sistema o protocollo IPC prima della formale discussione e approvazione dei criteri di Fase 2.

---

## 4. Criteri di Selezione per la Fase 2

La scelta definitiva verrà effettuata all'inizio della Fase 2 basandosi sui seguenti criteri oggettivi:
1. **Superficie di Attacco e Confinamento**: Punteggio di sicurezza relativo alla capacità di contenere compromissioni a catena.
2. **Portabilità tra Distribuzioni Linux**: Facilità di deployment su Ubuntu LTS, Debian, AlmaLinux/Rocky Linux senza dipendenze esoteriche.
3. **Overhead di Risorse e Latenza**: Impronta di memoria RAM a riposo e latenza di scambio messaggi per le operazioni di sincronizzazione e telemetria.
4. **Resilienza e Riavvio Indipendente**: Capacità del Control Plane e degli agenti di riavviarsi o aggiornarsi indipendentemente senza interruzione dei container del Data Plane (`CP-01`).
