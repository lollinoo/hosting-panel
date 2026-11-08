# ADR 0015 — Store Segreti Cifrati «AES-256-GCM» con AAD Tenant-Bound e Mount Effimeri su `tmpfs`

- **Stato:** `APPROVATO — Fase 2`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-003` §6 (`AC-F2-05`, `F1-012`)  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

I workload ospitati necessitano di credenziali sensibili (password di database, chiavi API, signing secret). La pratica comune di salvare segreti nelle configurazioni dichiarative o di iniettarli come variabili d'ambiente standard Docker (`Config.Env`) viola l'invariante di sicurezza `F1-012`:
1. Qualsiasi utente o strumento diagnostico che esegua `docker inspect` o legga `/proc/<pid>/environ` vedrebbe i segreti in chiaro.
2. Persistere segreti decifrati o reversibili senza legame crittografico col tenant in `stack_revisions`, `outbox_events` o log applicativi esporrebbe l'intera piattaforma a esfiltrazioni incrociate (*confused deputy* / compromissione backup DB).

---

## 2. Decisione Architetturale

Si adotta un ciclo di vita **Write-Only cifrato `AES-256-GCM` a riposo con risoluzione Just-In-Time (JIT) su `tmpfs` confinato `0700` e mount `:ro`**:

1. **Cifratura Autenticata `AES-256-GCM` con AAD Vincolato al Tenant (`0002_phase2_runtime_and_secrets.sql`)**:
   - I segreti sono archiviati nella tabella `encrypted_secrets` (`ciphertext_base64`, `iv_base64` a 12 byte casuali univoci per ogni scrittura/rotazione, `auth_tag_base64` a 16 byte, `key_version`, `version` incrementale) protetta da vincolo composto `(id, organization_id)` e FK composta `(site_id, organization_id)`.
   - Ogni operazione di cifratura e decifratura (`packages/database/src/secrets-crypto.ts`) impone come **Additional Authenticated Data (AAD)** il contesto canonico:
     ```text
     ${organizationId}:${siteId || "*"}:${secretKey}
     ```
     Se una riga venisse copiata o spostata verso un altro `organization_id`, `site_id` o `secret_key` a livello SQL, la verifica del tag GCM fallirebbe matematicamente.
2. **Semantica Rigorosamente Write-Only e Zero Persistenza nei Job**:
   - Gli endpoint `POST /v1/organizations/:orgId/secrets` e `GET /v1/organizations/:orgId/secrets` restituiscono esclusivamente `EncryptedSecretMetadataDto` (`id`, `secretKey`, `version`, `keyVersion`, `updatedAt`), **mai** il valore decifrato né i campi crittografici grezzi (bloccati anche da `FORBIDDEN_PUBLIC_DTO_KEYS`).
   - `StackRevision` registra unicamente la mappa di riferimenti `secretRefs: { "<ENV_NAME>": "sec_..." }` e `outbox_events` trasporta soltanto identificativi di operazione e revisione.
3. **Decifratura JIT e Montaggio `tmpfs` `0700` dir / `0444 :ro` leaf (Pattern `*_FILE`)**:
   - Solo nell'istante in cui l'Outbox Worker invoca `deployService` sul canale IPC firmato (`ADR-013`), i `secretRefs` della revisione vengono decifrati in RAM e trasmessi nel campo effimero `resolvedSecrets`.
   - `hp-docker-executor` isola la directory padre `/run/hosting-panel/secrets/<serviceInstanceId>` con permessi `0700` (bloccando a livello VFS qualsiasi attraversamento da parte di altri processi o utenti sull'host) e scrive il file foglia `<envName>` con mode `0444`, montandolo in sola lettura (`:ro`) nel singolo container su `/run/secrets/<envName>` con variabile puntatore `<ENV_NAME>_FILE=/run/secrets/<envName>`. Questo garantisce leggibilità ai workload multi-utente (`mysql`, `www-data`, `postgres`) eseguiti con `CapDrop: ["ALL"]` (privi di `CAP_DAC_READ_SEARCH`) senza mai concedere privilegi aggiuntivi né esporre il file sull'host.
   - All'arresto o rimozione del servizio, i file in `/run/hosting-panel/secrets/<serviceInstanceId>` vengono sovrascritti con zeri e cancellati.

---

## 3. Conseguenze

### Vantaggi
- **Zero Segreti in `docker inspect`, `stack_revisions`, `outbox_events` e Log (`AC-F2-05`)**: Nessun segreto in chiaro transita mai nelle variabili `Config.Env` del container né nelle tabelle immutabili di revisione o coda.
- **Protezione Crittografica Anti-Tampering Multi-Tenant**: Il binding dell'AAD a `organizationId`, `siteId` e `secretKey` impedisce qualsiasi riutilizzo incrociato di ciphertext tra tenant diversi.
- **Volatilità Fisica sull'Host**: Risiedendo su `tmpfs` (`/run/hosting-panel`), i file segreti non toccano mai il disco persistente dell'host e svaniscono automaticamente allo spegnimento della macchina.
