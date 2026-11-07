# ADR 0004 — Modello di Dominio Canonico Multi-Tenant Unificato

- **Stato:** `BASELINE`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §3, §8 Step 2, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Nei sistemi di gestione hosting multi-tenant, la modellazione approssimativa delle gerarchie di proprietà costituisce la prima causa di vulnerabilità BOLA/IDOR (Broken Object Level Authorization), allocazioni fantasma (*orphan resources*) e corruzione dei dati. È essenziale disporre di una gerarchia ontologica formale in grado di legare l'infrastruttura fisica o virtuale, i clienti organizzativi, i siti logici e le risorse container in un grafo relazionale rigorosamente verificabile.

---

## 2. Decisione Architetturale

Si definisce il **Modello di Dominio Canonico Multi-Tenant** unificato per tutte le entità di piattaforma:

```text
PlatformInstallation
  └── Host (hosting_mode: dedicated | shared)
        └── HostAllocation
              ├── Organization (Tenant)
              │     ├── ResourceQuota & QuotaReservation
              │     ├── Operation & AuditEvent
              │     └── Site (Aggregate)
              │           ├── Domain (FQDN, canonical lowercase)
              │           └── ServiceInstance
              │                 ├── StackRevision (Immutable Desired State)
              │                 │     └── DockerResource (Logical container, volume, network)
              │                 └── ObservedState (Actual Host State & Drift)
```

### Principi Costitutivi del Dominio
1. **Separazione tra Host e Tenant (`HostAllocation`)**:
   Un'organizzazione cliente non possiede direttamente un'infrastruttura fisica; interagisce con essa tramite l'entità di prima classe `HostAllocation`, che governa stato operativo, quote assegnate e modalità di hosting.
2. **Aggregato Logico `Site`**:
   Il sito rappresenta l'unità logica di business del cliente (es. un'applicazione web complessa o un e-commerce). Un `Site` raggruppa una o più istanze di servizio correlate (`ServiceInstance`), ad esempio un frontend web e un worker associato.
3. **`ServiceInstance` e `StackRevision` Immutabile**:
   Ogni servizio possiede una storia versionata di revisioni dichiarative (`StackRevision`). Ciascuna revisione contiene la specifica immutabile del servizio (`ServiceSpec`), il cui hash crittografico SHA-256 certifica che nessuna modifica non autorizzata sia avvenuta a posteriori.
4. **Vincoli di Chiave Composta su Database**:
   L'isolamento multi-tenant è garantito non solo a livello applicativo ma anche a livello relazionale PostgreSQL, mediante vincoli di chiave composta `(organization_id, id)` e chiavi esterne composte sulle tabelle figlie (`sites`, `service_instances`, `stack_revisions`, `domains`, `operations`, `audit_events`).

---

## 3. Conseguenze

### Vantaggi
- **Prevenzione Nativa BOLA/IDOR**: È strutturalmente impossibile collegare una risorsa figlia (es. un `ServiceInstance`) a un'organizzazione diversa da quella del `Site` genitore.
- **Tracciabilità e Reversibilità**: L'immutabilità delle `StackRevision` garantisce la possibilità di audit completi, disaster recovery deterministico e rollback istantanei a versioni note.
- **Tipizzazione Forte End-to-End**: Gli schemi Zod in `packages/contracts` e le tabelle Drizzle in `packages/database` rispecchiano fedelmente il medesimo grafo relazionale.

### Invarianti Obbligatori
- Nessuna entità associata a un tenant può esistere priva di un `organization_id` valido.
- Qualsiasi query REST `/v1/organizations/:orgId/...` deve includere `organization_id` nella clausola di filtro; l'accesso a risorse di un altro tenant produce invariabilmente `404 Not Found` (`AC-F1-02`).
