# ADR 0010 — Topologia di Processo «Split Agents» e Canale IPC per «Docker Executor» e «Host Agent»

- **Stato:** `APPROVATO — Fase 2`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §2.2, §10; `HCP-SPEC-003` §2, §3, §5.2 (`AC-F2-01`)  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Nel modello architetturale della piattaforma (`HCP-SPEC-002` / `HCP-SPEC-003`), il Control Plane (`hp-web` e `hp-api`) è rigorosamente separato dai componenti incaricati di operare sulle risorse privilegiate del nodo Linux:
1. Il **Docker Executor** (`hp-docker-executor`): componente preposto al ciclo di vita di container, reti isolate per `Site`, volumi gestiti, mount `tmpfs` dei segreti e routing dinamico Traefik.
2. Lo **Host Agent** (`hp-host-agent`): componente confinato incaricato della raccolta telemetrica dal sistema operativo (`/proc`, `statfs`), delle azioni di manutenzione pre-approvate e della verifica/applicazione del profilo statico `nftables`.

In Fase 1 questo ADR era mantenuto nello stato `OPEN — Fase 2` con implementazioni stub (`NOT_SUPPORTED`). Con `HCP-SPEC-003` occorre consolidare in modo definitivo la topologia dei processi e il meccanismo di comunicazione inter-processo (IPC).

---

## 2. Opzioni Valutate

### Opzione A: Agente Unificato Monolitico (`unified-agent` — Scartata)
Un singolo processo privilegiato con accesso simultaneo sia a `/var/run/docker.sock` sia alle capability di amministrazione del kernel/rete Linux.
- *Motivo di esclusione*: Viola il principio del minimo privilegio (*least privilege*). Una vulnerabilità nel parsing o nella gestione del runtime container comporterebbe l'immediata compromissione dell'intero sistema operativo host.

### Opzione B: «Split Agents» a 3 Domini di Privilegio Distinti (`split-agents` — Scelta)
Separazione fisica in unità `systemd` indipendenti eseguite con utenti di sistema dedicati privi di shell (`/usr/sbin/nologin`):
1. **Dominio 1 — Control Plane & Web (`hp-web.service`, `hp-api.service`)**:
   - Utenti dedicati `hp-web` e `hp-api` (`hp-api` membro del gruppo `hp-ipc`).
   - `CapabilityBoundingSet=` vuoto, `NoNewPrivileges=yes`, `ProtectSystem=strict` e `InaccessiblePaths=/var/run/docker.sock`.
2. **Dominio 2 — Docker Executor (`hp-docker-executor.service` / `apps/docker-executor`)**:
   - Demone leggero Node.js 24 + TypeScript (zero NestJS), eseguito come utente `hp-executor` (`SupplementaryGroups=docker hp-ipc`).
   - Unico processo sull'host autorizzato ad accedere a `/var/run/docker.sock`; zero Linux Capabilities (`CapabilityBoundingSet=` vuoto).
3. **Dominio 3 — Host Agent (`hp-host-agent.service` / `apps/host-agent`)**:
   - Demone leggero Node.js 24 + TypeScript (zero NestJS), eseguito come utente `hp-agent` (`SupplementaryGroups=hp-ipc`).
   - Confinato con le sole `CAP_NET_ADMIN` e `CAP_DAC_READ_SEARCH`, `InaccessiblePaths=/var/run/docker.sock`, invocazione esclusiva tramite `execFile` su path assoluti allowlisted (zero `sh -c`).

---

## 3. Decisione Architetturale Consolidata

Si approva l'**Opzione B (`split-agents` a 3 domini di privilegio)** abbinata a un **canale IPC locale HTTP/1.1 JSON su Unix Domain Sockets dedicati e firmati crittograficamente per singola richiesta** (`ADR-013`):

- Socket Executor: `/run/hosting-panel/executor.sock` (`hp-executor:hp-ipc`, mode `0660`).
- Socket Host Agent: `/run/hosting-panel/host-agent.sock` (`hp-agent:hp-ipc`, mode `0660`).
- Directory runtime: `/run/hosting-panel` (`0750`), zero porte TCP esposte dai demoni in produzione Linux.
- Doppio adapter per ciascun demone (`DockerEngineSocketAdapter` / `InMemoryDockerSimulatorAdapter` e `LinuxSystemHostAdapter` / `InMemoryHostSimulatorAdapter`), preservando la modalità `disabled` per test regressivi di Fase 1.

---

## 4. Conseguenze

### Vantaggi
- **Isolamento Forte dei Domini di Attacco (`AC-F2-01`)**: Né `apps/web` né `apps/api` possiedono visibilità sul socket Docker; `hp-docker-executor` non dispone di capability di rete/sistema host e `hp-host-agent` non può manipolare container.
- **Indipendenza dal Data Plane (`CP-01` / `AC-F1-08`)**: Il riavvio, l'aggiornamento o la terminazione forzata (`SIGKILL`) di `hp-web`, `hp-api`, `hp-docker-executor` e `hp-host-agent` lascia inalterati i container tenant e il proxy di frontiera Traefik.
- **Impronta Minimale e Verificabilità**: I due demoni usano esclusivamente moduli built-in di Node.js 24 e contratti `zod` condivisi, riducendo la superficie di supply-chain.
