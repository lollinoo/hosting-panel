# ADR 0001 — Supporto al Doppio Modello di Hosting (`Dedicated` e `Shared`) nel Dominio Unificato

- **Stato:** `APPROVATO`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §1.2, §3, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Le piattaforme di hosting tradizionali si dividono storicamente in due categorie tra loro incompatibili:
1. Piattaforme di tipo *PaaS / VPS dedicato*, in cui ogni tenant ottiene una macchina virtuale isolata con overhead amministrativo elevato ma massimo isolamento.
2. Pannelli di tipo *Shared Hosting classico* (es. cPanel, Plesk), in cui centinaia di siti condividono il medesimo sistema operativo e filesystem, introducendo notevoli rischi di sicurezza, *noisy-neighbor problem* e complessità di partizionamento delle risorse.

L'obiettivo di Hosting Control Panel (`HCP-SPEC-002`) è consentire la gestione di entrambi i paradigmi di erogazione all'interno di una piattaforma coerente, senza dover duplicare l'infrastruttura di controllo, il catalogo dei template di servizio o il modello di autorizzazione.

---

## 2. Decisione Architetturale

Si stabilisce di incorporare nativamente il doppio modello di hosting all'interno del dominio relazionale di piattaforma:

1. **Definizione Esplicita della Modalità di Hosting sull'Host**:
   L'entità `Host` espone l'attributo `hosting_mode`, con valori ammessi:
   - `'dedicated'`: L'host è riservato a una e una sola organizzazione cliente.
   - `'shared'`: L'host è condiviso tra molteplici organizzazioni clienti, regolato da quote aggregate e isolamento di rete/storage.
2. **Entità `HostAllocation` per l'Occupazione Spaziale**:
   La relazione tra tenant (`Organization`) e macchina fisica/virtuale (`Host`) è formalizzata dall'entità di prima classe `HostAllocation`.
3. **Invariante di Allocazione per Host `Dedicated` (`AC-F1-01`)**:
   Quando `Host.hosting_mode == 'dedicated'`, il sistema garantisce a livello transazionale che non possa esistere più di una allocazione attiva (`status == 'active'`) associata a organizzazioni distinte. Qualsiasi tentativo di allocare un'altra organizzazione viene rifiutato con `409 HOST_ALREADY_ALLOCATED`.
4. **Separazione Funzionale tra Modalità**:
   Le entità figlie (`Site`, `ServiceInstance`, `StackRevision`) non contengono logiche condizionali sparse relative alla modalità dell'host: esse fanno riferimento a un `Host` tramite la rispettiva allocazione, ereditando le politiche applicate a monte dal `PolicyEngine`.

---

## 3. Conseguenze

### Vantaggi
- **Dominio Unificato**: Una singola API REST `/v1`, un solo motore RBAC/ABAC e un unico catalogo di template gestiscono indifferentemente carichi dedicati e condivisi.
- **Isolamento Garantito per Clienti Enterprise**: I clienti con requisiti di conformità elevati possono operare in modalità Dedicated mantenendo l'esperienza utente moderna e self-service.
- **Efficienza Economica**: La futura attivazione della modalità Shared (Fase 2) consentirà un elevato rapporto di densità per carichi a basso costo.

### Vincoli e Rischi Mitigati
- È vietata la transizione dinamica da `dedicated` a `shared` senza una previa de-allocazione completa dell'host e verifica di sicurezza (`AC-F1-06`, `ADR-007`).
- In modalità `dedicated`, le quote host fungono da limite di salvaguardia hardware, mentre in modalità `shared` le quote tenant sono hard limit vincolanti per la ripartizione equa delle risorse (`ADR-011`).
