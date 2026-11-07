# ADR 0008 — Hub di Gestione Multi-Host Opzionale con «Single-Writer Fencing»

- **Stato:** `OPZIONALE FUTURO`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §1.2, §2.1, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

La crescita del parco macchine di un operatore hosting comporta la necessità di monitorare e coordinare decine o centinaia di server distribuiti (nodi VPS o macchine dedicate).

Tuttavia, l'introduzione precoce di un'architettura distribuita multi-nodo introduce complessità estreme:
- Rischio di *split-brain* durante partizioni di rete (mutazioni concorrenti lanciate contemporaneamente dal pannello centrale e dall'amministratore locale).
- Sovraccarico di gestione del consenso distribuito (Raft / Paxos).
- Compromissione dell'intero parco macchine in caso di violazione del server centrale.

---

## 2. Decisione Architetturale

Si stabilisce che la gestione multi-host sarà demandata a un componente **«Multi-Host Management Hub» strettamente opzionale e futuro**:

1. **Priorità del Modello Standalone Autonomo (`ADR-003`)**:
   Ogni nodo locale è e rimane un'appliance completamente autonoma dotata del proprio Control Plane, del proprio database e della propria interfaccia amministrativa locale.
2. **Ruolo dell'Hub come Aggregatore e Coordinatore**:
   L'Hub futuro non sostituirà il Control Plane del nodo locale; agirà unicamente come layer federato di visibilità (cruscotto unificato), gestione centralizzata delle identità (SSO) e aggregazione della fatturazione.
3. **Requisito di «Single-Writer Fencing»**:
   Per evitare scritture concorrenti distruttive durante le mutazioni di stato, l'architettura dell'Hub dovrà implementare un meccanismo formale di *fencing*:
   - Per ciascun `Host`, deve esistere un solo scrittore autorizzato in un dato istante (*single-writer principle*).
   - Le mutazioni trasmesse dall'Hub al nodo locale dovranno includere un *fencing token* (o contatore monotonico di revisione); qualsiasi comando con token inferiore o non valido verrà scartato all'istante dal nodo locale.
4. **Resilienza durante Partizioni di Rete**:
   Qualora la connettività tra l'Hub e il nodo locale si interrompa, il nodo locale continuerà a erogare tutti i servizi applicativi (Data Plane invariato, `CP-01`) e consentirà agli amministratori locali l'accesso in modalità *break-glass*.

---

## 3. Conseguenze

### Vantaggi
- **Architettura a Rischio Zero per la Fase 1**: Nessuna complessità distribuita viene introdotta nel rilascio iniziale.
- **Garanzia di Non-Regressione**: La futura implementazione dell'Hub non richiederà di riscrittura del Control Plane locale, che rimarrà l'unità computazionale fondamentale.
- **Prevenzione Conflitti**: Il vincolo di Single-Writer Fencing garantisce l'assenza di sovrascritture di stato disallineate tra pannello locale e hub centrale.
