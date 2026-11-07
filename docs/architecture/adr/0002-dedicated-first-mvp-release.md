# ADR 0002 — Strategia di Rilascio MVP «Dedicated-First» (Fase 1)

- **Stato:** `APPROVATO`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §1.2, §1.3, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

L'erogazione di un servizio di *Shared Hosting* multi-tenant sicuro e affidabile basato su container Docker richiede l'implementazione preventiva di meccanismi complessi:
- Quote disco rigide a livello di filesystem o dataset (es. XFS project quotas o ZFS).
- Throttling avanzato di CPU, memoria e I/O tramite cgroups v2.
- Modello di minacce per codice non fidato (es. plugin WordPress di terze parti o script PHP arbitrari).
- Hardening del runtime dei container contro fughe dal namespace (`container escape`).

Rilasciare la modalità Shared prima che tali meccanismi siano pienamente implementati e validati con test di penetrazione espone la piattaforma e gli utenti a gravi rischi di sicurezza e instabilità operativa.

---

## 2. Decisione Architetturale

Si stabilisce la strategia di rilascio **«Dedicated-First»** per la Fase 1 (MVP) della piattaforma:

1. **Priorità Assoluta alla Modalità `Dedicated`**:
   Il rilascio MVP si concentra interamente sul caso d'uso in cui ciascun host (VPS o server fisico) è allocato in via esclusiva a una singola organizzazione cliente (`AC-F1-01`).
2. **Isolamento Garantito a Livello Hardware/Hypervisor**:
   In modalità Dedicated, l'isolamento tra differenti tenant è garantito fisicamente dal confine del VPS o dell'hypervisor Linux sottostante. Eventuali vulnerabilità applicative di un tenant non possono in alcun modo impattare i carichi di lavoro o i dati di altre organizzazioni clienti.
3. **Stato della Modalità `Shared` in Fase 1 (`AC-F1-10`)**:
   La modalità `shared` è formalizzata nel modello dati, nei contratti e nelle regole di validazione del `PolicyEngine`, ma è **esplicitamente disabilitata o contrassegnata come non disponibile per la produzione (GA)**.
4. **Trasparenza Contrattuale**:
   Né l'interfaccia utente né la documentazione API devono presentare la modalità Shared come attiva o utilizzabile per carichi di lavoro reali durante la Fase 1.

---

## 3. Conseguenze

### Vantaggi
- **Mitigazione Radicale del Rischio**: Eliminazione all'origine del rischio di cross-tenant contamination o denegazione di servizio tra clienti differenti nel primo rilascio.
- **Time-to-Market Accelerato**: Focalizzazione delle risorse ingegneristiche sul core domain, sul Control Plane transazionale, sulle politiche di sicurezza dei manifest e sull'esperienza utente delle tre console.
- **Base Solida per la Fase 2**: Tutte le strutture relazionali e contrattuali sono già predisposte per la futura attivazione della modalità Shared senza richiedere migrazioni distruttive del database.

### Limitazioni
- Densità hardware inferiore rispetto al modello shared multi-tenant, compensata dal target primario rivolto ad agenzie, PMI e clienti con esigenze di risorse dedicate e autonomia operativa.
