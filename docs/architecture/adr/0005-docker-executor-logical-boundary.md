# ADR 0005 — Confine Logico Isolato per il «Docker Executor»

- **Stato:** `BASELINE LOGICA`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §1.3, §2.2, §5.2, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

L'accesso diretto al socket Unix del daemon Docker (`/var/run/docker.sock`) da parte del processo API del Control Plane rappresenta uno dei più gravi rischi di sicurezza nell'architettura di un pannello di hosting. Chiunque riesca a compromettere il processo API o a iniettare chiamate REST arbitrarie potrebbe creare container privilegiati con mount della root del filesystem host (`/`), ottenendo istantaneamente il pieno controllo `root` del server host.

Inoltre, legare il codice applicativo del Control Plane all'API Docker Engine rende impossibile l'esecuzione di test deterministici e test di integrazione senza avviare e gestire container reali su ogni postazione di sviluppo.

---

## 2. Decisione Architetturale

Si stabilisce il confine logico del **Docker Executor** come componente rigorosamente isolato e disaccoppiato dal Control Plane:

1. **Interfaccia Tipizzata Esclusiva (`DockerExecutorPort`)**:
   Il Control Plane comunica con il sottosistema Docker unicamente attraverso il contratto tipizzato definito nel pacchetto `@hosting-panel/executor-contracts`.
2. **Specifiche Approvate e Sanificate (`ApprovedServiceSpec`)**:
   L'esecutore non riceve mai file Docker Compose grezzi, né comandi shell o stringhe non strutturate. Esso accetta esclusivamente strutture dati `ApprovedServiceSpec` già convalidate e autorizzate dal `PolicyEngine`.
3. **Divieto di Endpoints Docker Generici (`HCP-SPEC-002` §5.2)**:
   È tassativamente vietata l'esposizione di route HTTP pass-through o endpoint generici come `POST /docker/*` o `/containers/*`.
4. **Implementazione di Fase 1: Disabilitazione Controllata (`AC-F1-10`)**:
   Nella Fase 1, l'interfaccia `DockerExecutorPort` è istanziata tramite `Phase1DisabledDockerExecutor`. Qualsiasi tentativo di invocazione restituisce un errore normalizzato di tipo `NOT_SUPPORTED`. **Nessun processo del Control Plane tenta di accedere a `/var/run/docker.sock` o di eseguire comandi del client `docker`**.

---

## 3. Conseguenze

### Vantaggi
- **Eliminazione del Vettore di Fuga da Socket in Fase 1**: Il Control Plane non possiede né richiede permessi di accesso al socket del daemon Docker.
- **Portabilità e Testabilità**: È possibile testare l'intera catena di provisioning, generazione revisioni, quote e validazione policy a freddo e in memoria, con tempi di esecuzione dell'ordine dei millisecondi.
- **Predisposizione per la Fase 2**: La separazione contrattuale consente di implementare il Docker Executor in Fase 2 come processo locale isolato, demone di sistema (`systemd`) o servizio IPC a privilegi minimi (`ADR-010`).

### Invarianti di Sicurezza
- Nessuna chiave privata, token sensibile o parametro di mount dell'host può attraversare il confine di `executor-contracts` in chiaro.
- Il socket `/var/run/docker.sock` non deve mai essere montato o referenziato in alcun manifest o configurazione di servizio (`AC-F1-04`).
