# ADR 0007 — Security Gate Obbligatorio per l'Attivazione dello «Shared Hosting»

- **Stato:** `BASELINE`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §1.2, §5.1, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Nel modello *Shared Hosting*, carichi di lavoro appartenenti a organizzazioni clienti differenti e potenzialmente ostili condividono il medesimo kernel Linux, le stesse risorse di calcolo (CPU, RAM, banda I/O) e lo stesso sottosistema di storage.

Senza meccanismi di isolamento e limitazione estremamente rigorosi, un singolo tenant (o un'applicazione compromessa da exploit su plugin di terze parti) può:
1. Saturare l'intero spazio su disco dell'host con file temporanei o log, causando il crash di tutti i database e i container dei tenant adiacenti.
2. Esaurire i file descriptor, i processi (fork bomb) o la memoria fisica, innescando l'intervento distruttivo dell'OOM killer del kernel.
3. Effettuare scansioni o sniffing del traffico di rete locale sui bridge Docker condivisi.
4. Tentare attacchi di *privilege escalation* sfruttando vulnerabilità non patchate del kernel.

---

## 2. Decisione Architetturale

Si stabilisce che la modalità **Shared Hosting** debba rimanere vincolata dietro un **Security Gate Obbligatorio e Non Negoziazione**:

1. **Divieto di Attivazione Spontanea o Toggle Diretto (`AC-F1-06`)**:
   Il `PolicyEngine` rigetta categoricamente qualsiasi tentativo di convertire direttamente un host esistente da `dedicated` a `shared` tramite una semplice modifica di campo DTO (`422 DIRECT_TRANSITION_FORBIDDEN`). Un host può essere configurato come `shared` unicamente all'atto del bootstrap o dopo una procedura certificata di bonifica integrale.
2. **I Cinque Requisiti Obbligatori del Security Gate (Fase 2)**:
   Prima che la modalità Shared possa essere promossa a stato operativo GA (*General Availability*), devono essere soddisfatti e verificati con test automatici i seguenti cinque controlli tecnici:
   - **Gate 1 — Quote Disco Rigide a Livello di Storage (`ADR-011`)**: Meccanismo a prova di bypass per bloccare la scrittura non appena un volume supera il massimale assegnato al tenant.
   - **Gate 2 — Isolamento cgroup v2 per CPU, Memoria e I/O**: Limiti rigidi (`limits.memory`, `limits.cpu`, `io.weight`) su ciascun container, impedendo starvation e blocco dell'host.
   - **Gate 3 — Segmentazione di Rete a Livello di Tenant**: Reti bridge Docker private per ciascun `Site` o tenant; divieto di comunicazione diretta inter-container tra siti di clienti diversi.
   - **Gate 4 — Runtime Non-Root e Rimappatura Utenti (`userns-remap`)**: I processi all'interno del container devono girare con UID non privilegiato, rimappato nello spazio utente del kernel per prevenire exploit di root escape.
   - **Gate 5 — Modello di Rischio per Codice Non Fidato (`ADR-012`)**: Politiche restrittive per workload contenenti script dinamici o plugin non verificati.

---

## 3. Conseguenze

### Vantaggi
- **Protezione della Reputazione e Stabilità della Piattaforma**: Nessun operatore potrà incautamente attivare la modalità shared senza che l'infrastruttura sottostante sia tecnicamente pronta a contenere i rischi.
- **Rigorosa Conformità a `HCP-SPEC-002`**: La Fase 1 si attiene scrupolosamente al perimetro sicuro e lascia aperte le discussioni implementative su filesystem e storage per la Fase 2 (`ADR-011`).
