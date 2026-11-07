# ADR 0003 — Baseline «Standalone Local Appliance» per Singolo VPS

- **Stato:** `BASELINE`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §1.2, §2.1, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Molte architetture moderne di hosting impongono una dipendenza vincolante da un cloud centrale proprietario (SaaS centrale) per l'autenticazione, la configurazione o l'esecuzione delle mutazioni. Questo approccio comporta svantaggi significativi:
- Mancanza di sovranità sui dati dei clienti e sui segreti applicativi.
- Vulnerabilità al *cascading failure*: un'interruzione di connettività verso il SaaS centrale blocca l'amministrazione di tutti i server distribuiti.
- Difficoltà di impiego in ambienti on-premises, reti private o infrastrutture ad alta conformità (es. sanità, pubblica amministrazione).

---

## 2. Decisione Architetturale

Si adotta il modello **«Standalone Local Appliance»** come baseline fondamentale di architettura:

1. **Autonomia Completa del Control Plane**:
   La piattaforma è progettata per operare come appliance autonoma installata direttamente su un singolo VPS o server dedicato.
2. **Persistenza Locale e Assenza di Lock-in Centrale**:
   Tutto lo stato di piattaforma (istanze di servizio, credenziali, revisioni dichiarative, registri di audit e configurazioni) risiede sul database PostgreSQL locale (o embedded in PGlite per test e bootstrap).
3. **Nessuna Connessione Obbligatoria verso SaaS Esterni**:
   Il pannello non richiede un orchestratore cloud centrale, né meccanismi di telemetria obbligatoria o "phone-home" per il normale funzionamento.
4. **Indipendenza del Data Plane (Invariante `CP-01`)**:
   L'eventuale riavvio o indisponibilità del Control Plane (API / Web) non deve in alcun modo impattare i container e i servizi applicativi in esecuzione sul Data Plane locale (`AC-F1-08`).

---

## 3. Conseguenze

### Vantaggi
- **Massima Resilienza Operativa**: Ciascun server opera indipendentemente; un problema su un'installazione non ha alcun effetto a catena sulle altre.
- **Sovranità dei Dati**: Tutte le informazioni sensibili e i certificati rimangono confinati all'interno del perimetro del server del cliente.
- **Sviluppo e Test Semplificati**: Gli sviluppatori e i team di test possono eseguire l'intero stack in locale con la medesima architettura logica utilizzata in produzione.

### Evoluzione Futura
- L'architettura non preclude l'aggiunta di un *Multi-Host Management Hub* facoltativo (`ADR-008`), che agirà unicamente come coordinatore federato opzionale, preservando l'autonomia locale del nodo.
