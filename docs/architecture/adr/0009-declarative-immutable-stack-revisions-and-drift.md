# ADR 0009 — Revisioni Dichiarative Immutabili (`StackRevision`) e Modello di Drift

- **Stato:** `BASELINE`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §3.1, §3.3, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Nei sistemi di gestione hosting tradizionali basati su approcci imperativi, le modifiche ai servizi applicativi (cambio variabili d'ambiente, aggiunta domini, ridimensionamento risorse) vengono applicate direttamente tramite comandi sequenziali `docker update` o modifiche in-place ai file di configurazione.

Questo approccio genera criticità gravi:
- *Configuration Drift*: Impossibilità di sapere quale configurazione sia effettivamente in esecuzione sul server rispetto a quanto registrato nel database.
- Impossibilità di eseguire rollback deterministici e sicuri a stati precedenti conosciuti.
- Mancanza di audit crittografico per verificare se una configurazione sia stata manomessa da interventi manuali su host via SSH.

---

## 2. Decisione Architetturale

Si stabilisce il paradigma **Dichiarativo Immutabile** basato sull'entità `StackRevision` e sul modello di riconciliazione Desired vs. Observed:

1. **Immutabilità Assoluta delle Revisioni (`AC-F1-05`)**:
   Ogni modifica a un'istanza di servizio (`ServiceInstance`) non aggiorna il record esistente, ma genera una nuova istanza di `StackRevision` contrassegnata da un numero di versione sequenziale (`revision_number`).
2. **Hash Crittografico del Contenuto (SHA-256)**:
   La specifica del servizio (`ServiceSpec`), normalizzata in formato canonico, viene sottoposta a hashing SHA-256 (`spec_hash`). Qualsiasi alterazione del manifest produce un hash differente, garantendo la verifica di integrità.
3. **Trigger di Immutabilità a Livello Database**:
   La tabella `stack_revisions` in PostgreSQL è protetta da un trigger DDL che inibisce istruzioni `UPDATE` o `DELETE` su revisioni consolidate.
4. **Separazione tra Stato Desiderato e Stato Osservato**:
   - **Stato Desiderato (Desired State)**: Formalizzato nella `StackRevision` attiva e associato alle risorse logiche `DockerResource` (container, volume, network).
   - **Stato Osservato (Observed State)**: Registrato nell'entità `ObservedState`, contenente l'ispezione periodica non intrusiva proveniente dall'host.
5. **Classificazione Formale del Drift**:
   Il comparatore di drift (`packages/hosting-domain`) calcola lo stato di allineamento tra Desired e Observed:
   - `in_sync`: Il container è attivo e i parametri operativi coincidono con la specifica dichiarativa.
   - `drifted`: Rilevata discrepanza tra la specifica desiderata e lo stato osservato sull'host (es. immagine modificata, variabili alterate o container terminato anomalo).
   - `unknown`: Mancanza di telemetria recente o timeout di ispezione dell'host.
6. **Ciclo di Vita Transazionale Outbox**:
   Le mutazioni transitano attraverso l'Outbox Pattern con stati espliciti: `queued -> processing -> succeeded | failed | unknown | cancelled`. In caso di risposta ambigua o timeout di rete, l'operazione transita a `unknown` mantenendo acquisito il lock di mutazione per impedire replay ciechi e scritture distruttive concorrenti.

---

## 3. Conseguenze

### Vantaggi
- **Rollback Istantaneo e Riproducibile**: È possibile ripristinare qualsiasi stato precedente selezionando la `StackRevision` target e riapplicandola senza ambiguità.
- **Rilevazione Tempestiva di Interventi Fuori-Banda**: Qualsiasi modifica manuale effettuata direttamente via SSH sull'host viene immediatamente etichettata come `drifted` nella console amministrativa.
- **Integrità Storica**: Lo storico delle revisioni fornisce un registro completo di tutte le mutazioni intervenute nel tempo sul servizio.
