# ADR 0012 — Modello di Vincolo sui Carichi di Lavoro Non Fidati e Limiti di Isolamento nello «Shared Hosting»

- **Stato:** `VINCOLO`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §5.1, §5.3, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Il mercato dell'hosting web è dominato da applicazioni basate su linguaggi interpretati (in particolare PHP / WordPress, Node.js, Python), caratterizzate da un ecosistema vastissimo di temi, estensioni e plugin di terze parti sviluppati al di fuori di qualsiasi controllo di qualità o sicurezza centrale.

In un contesto *Shared Hosting*, il codice in esecuzione all'interno di un'applicazione web deve essere considerato per definizione **non fidato (untrusted)**. La compromissione di un singolo sito tramite una vulnerabilità di tipo *unrestricted file upload* o *arbitrary code execution* in un plugin WordPress installato dal cliente finale porta alla presenza di una web shell attiva all'interno del container.

Esiste un limite intrinseco nell'architettura dei container Linux standard: **i container condividono il medesimo kernel del sistema operativo host**. Sebbene i namespace (`pid`, `net`, `mnt`, `ipc`, `user`) e i cgroup forniscano un efficace confinamento logico, essi **non costituiscono un confine di sicurezza virtualizzato a livello hardware** (come invece garantito da un hypervisor KVM, Xen o da microVM tipo Firecracker). Qualsiasi vulnerabilità *zero-day* o *1-day* nel kernel Linux può consentire a un attaccante che controlli un container di evadere sul sistema host (`container breakout`).

---

## 2. Decisione Architetturale: Vincolo Formale di Piattaforma

Si stabilisce il seguente **Vincolo Normativo («VINCOLO»)** per la piattaforma Hosting Control Panel:

1. **Riconoscimento Formale del Confine di Isolamento dei Container**:
   I container Docker standard su kernel Linux condiviso non sono considerati un perimetro di isolamento assoluto contro avversari determinati capaci di eseguire codice binario o exploit di kernel.
2. **Guida Architetturale per Carichi Non Fidati o Critici**:
   - I carichi di lavoro con elevata criticità di dati (dati sanitari, bancari, e-commerce ad alto fatturato) o con installazione di plugin/script di terze parti non certificati **devono essere allocati prioritariamente su nodi in modalità `Dedicated` (VPS / Server Dedicato)**, garantendo la separazione a livello di hardware o hypervisor KVM (`ADR-002`).
   - Per la futura espansione della modalità Shared (Fase 2 / Fase 3), si valuterà l'adozione di sandbox a micro-virtualizzazione (es. runsc/gVisor o Kata Containers) per i tenant con profili di rischio non standard.
3. **Misure di Hardening Mandatorie per lo Shared Hosting**:
   Per qualsiasi carico di lavoro in modalità `shared`, la configurazione generata da `StackRevision` e validata da `PolicyEngine` deve rispettare i seguenti vincoli insuperabili:
   - **Drop di Tutte le Capability di Default**: Rimozione esplicita di `ALL` capabilities Linux; aggiunta consentita solo ed esclusivamente per capability minime e dimostrate necessarie (es. `CHOWN`, `DAC_OVERRIDE`, `NET_BIND_SERVICE`). Divieto categorico di `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, `CAP_SYS_RAWIO`, `CAP_SYS_PTRACE`.
   - **Impedimento Acquisizione Nuovi Privilegi**: Applicazione sistematica del flag di sicurezza `no-new-privileges: true` sul container, impedendo a binari con bit `setuid` di elevare i permessi.
   - **Blocco dell'Abuso di Rete in Uscita**: Interdizione del traffico SMTP diretto in uscita (porta TCP 25, 465, 587) dai container applicativi per prevenire la trasformazione dei nodi in sorgenti di spamming; le email transazionali devono transitare obbligatoriamente da gateway/relay autorizzati.
   - **Filesystem di Root Sola Lettura**: Adozione, ove supportato dai template applicativi, di filesystem radice in sola lettura (`read_only: true`), relegando le directory scrivibili a volumi specifici soggetti a quote disco rigide (`ADR-011`).

---

## 3. Conseguenze

### Vantaggi
- **Chiarezza e Onestà Ingegneristica**: Nessuna falsa garanzia di "isolamento invulnerabile" viene fornita agli utenti; la distinzione tra `Dedicated` e `Shared` è motivata da precise considerazioni di sicurezza computazionale.
- **Difesa in Profondità (Defense-in-Depth)**: Le restrizioni applicate ai container riducono drasticamente l'efficacia degli exploit applicativi più comuni, confinando i danni all'interno del volume dello specifico sito compromesso.
- **Allineamento con i Criteri di Fase 1**: Rafforza la decisione strategica di focalizzare l'MVP sulla modalità Dedicated (`ADR-002`) rimandando lo Shared Hosting alla completa attuazione dei requisiti di Fase 2.
