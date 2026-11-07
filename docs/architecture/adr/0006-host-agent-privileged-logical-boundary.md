# ADR 0006 — Confine Logico Privilegiato per lo «Host Agent»

- **Stato:** `BASELINE LOGICA`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §1.3, §2.2, §4.2, §5.2, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

La gestione del sistema operativo sottostante (configurazione di interfacce di rete, regole di firewalling `nftables`/`iptables`, allocazione di dataset su filesystem, quote utente e aggiornamenti di sicurezza dell'OS) richiede privilegi elevati (`root` o specifiche Linux capabilities).

Permettere al processo API del Control Plane di eseguire comandi shell arbitrari (es. `child_process.exec`, script bash non verificati o chiamate SSH root non controllate) costituisce un gravissimo difetto di progettazione che trasforma qualsiasi vulnerabilità applicativa in Remote Code Execution (RCE) ad alto impatto.

---

## 2. Decisione Architetturale

Si stabilisce il confine logico del **Host Agent** come perimetro privilegiato rigorosamente isolato:

1. **Contratto Tipizzato Allowlist-Only (`HostAgentPort`)**:
   Le interazioni con il sistema operativo host avvengono unicamente tramite l'interfaccia contrattuale definita in `@hosting-panel/host-agent-contracts`. L'interfaccia espone un insieme chiuso e tassativo di operazioni consentite (es. ispezione metadati host, verifica spazio libero su disco).
2. **Divieto di Shell Arbitraria e Comandi Non Strutturati**:
   È fatto divieto assoluto di accettare o trasmettere stringhe di comando shell non tipizzate, percorsi di script esterni o parametri non sanitizzati.
3. **Segregazione dei Ruoli di Autorizzazione (`AC-F1-03`)**:
   Il modello autorizzativo distingue nettamente tra la gestione del catalogo hosting e la gestione del sistema operativo:
   - Il ruolo `infrastructure_admin` detiene la visibilità sulle metriche hardware e la responsabilità di manutenzione dell'host.
   - Il ruolo `hosting_admin` riceve un **esplicito diniego (`deny`)** su tutti i permessi del gruppo `host.maintenance.*`, `host.security.manage` e `host.docker.engine.manage`.
4. **Implementazione di Fase 1: Disabilitazione Completa (`AC-F1-10`)**:
   Nella Fase 1, l'interfaccia `HostAgentPort` è implementata tramite `Phase1DisabledHostAgent`. Tutte le chiamate restituiscono `NOT_SUPPORTED`. **Nessun demone con privilegi di root o script shell viene eseguito in Fase 1**.

---

## 3. Conseguenze

### Vantaggi
- **Prevenzione dell'Escalation di Privilegi (`HostingAdmin -> Root`)**: Anche in presenza di un account `hosting_admin` compromesso, l'attaccante non può eseguire comandi a livello di sistema operativo host o alterare le configurazioni di sicurezza dell'appliance.
- **Auditabilità e Tracciabilità**: Ogni eventuale mutazione a livello host dovrà transitare in Fase 2 attraverso operazioni strutturate e registrate nel log di audit append-only.
- **Preparazione alla Fase 2**: La scelta definitiva della topologia di processo dell'Host Agent (demone `systemd` separato, protocollo IPC autenticato con credenziali Unix peer o socket mTLS) rimane aperta e documentata in `ADR-010`.
