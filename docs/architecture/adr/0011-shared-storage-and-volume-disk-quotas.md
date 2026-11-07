# ADR 0011 — Architettura di Storage Condiviso e Meccanismo di Quote Disco per Volumi

- **Stato:** `OPEN — prima di Shared`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-002` §5.1, §8 Step 5, §10  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Nel modello *Shared Hosting*, più tenant scrivono simultaneamente dati persistenti sul sottosistema di storage del medesimo host (file di codice applicativo, upload multimediali, log, database embedded o cache).

I container Docker standard montano tipicamente volumi nominati o bind-mount da directory dell'host (es. `/var/lib/docker/volumes/...`). Per impostazione predefinita, Docker e il filesystem ext4 standard **non applicano alcun limite rigido di dimensione su tali directory**: qualsiasi container o script PHP/WordPress compromesso può generare un file gigantesco saturando l'intero disco dell'host (`ENOSPC`), provocando il blocco catastrofico di tutti i servizi del server (*denial of service* esteso).

Pertanto, l'abilitazione della modalità Shared Hosting richiede obbligatoriamente un meccanismo di quota disco non aggirabile a livello di storage del sistema operativo.

---

## 2. Opzioni Tecnologiche a Confronto

### Opzione A: Dataset ZFS con `refquota` Dedicata
Creazione di un dataset ZFS indipendente per ciascuna directory di volume o per ciascun tenant (es. `zpool/hosting/org-123/site-456/data`).
- *Vantaggi*: Quote rigide applicate nativamente dal filesystem con zero overhead; supporto a snapshot atomici istantanei, deduplicazione e compressione LZ4; isolamento completo; ridimensionamento al volo senza smontare il volume.
- *Svantaggi*: Richiede ZFS installato sull'host (modulo kernel OpenZFS / `zfs-dkms`), che non è sempre pre-installato o supportato sui kernel stock di tutti i provider cloud; elevato consumo di RAM per la cache ARC.

### Opzione B: XFS con «Project Quotas» (`pquota` / `prjquota`)
Utilizzo del filesystem XFS (standard di fatto su distribuzioni enterprise quali RHEL/AlmaLinux e ampiamente supportato su Ubuntu) con opzione di mount `pquota`.
- *Vantaggi*: Nativo nel kernel Linux per XFS; non richiede moduli kernel esterni; consente di applicare una quota rigida su una specifica struttura di directory (Project ID) indipendentemente dall'UID/GID dei file contenuti; eccellente per container multi-utente.
- *Svantaggi*: Richiede che il filesystem radice o la partizione `/var/lib/hosting-panel/volumes` sia formattata esplicitamente in XFS con supporto project quotas attivo nel file `/etc/fstab`.

### Opzione C: Subvolume Btrfs con Quota Groups (`qgroups`)
Creazione di subvolume Btrfs per ciascun tenant con abilitazione delle quote gerarchiche (`btrfs qgroup limit`).
- *Vantaggi*: Supporto nativo nel kernel Linux mainline; snapshot e compressione integrati.
- *Svantaggi*: Storicamente, l'implementazione dei qgroups in Btrfs ha evidenziato cali di prestazioni significativi e instabilità sotto elevata concorrenza di I/O o in presenza di un numero elevato di snapshot.

### Opzione D: File Immagine Loopback Formattati a Dimensione Fissa
Creazione di un file pre-allocato di dimensione fissa (es. `volume.raw` da 5 GB), formattato in ext4 e montato in loopback su `/dev/loopX`.
- *Vantaggi*: Portabilità assoluta su qualsiasi filesystem e distribuzione Linux; limite hardware invalicabile.
- *Svantaggi*: Grave inefficienza di allocazione dello spazio (*thin provisioning* complesso); overhead di gestione dei loop device del kernel; rigidità estrema nel ridimensionamento a caldo delle quote.

---

## 3. Decisione: Stato «OPEN» Obbligatorio prima dell'Abilitazione Shared

**Questa decisione rimane formalmente APERTA (OPEN — prima di Shared) e NON viene risolta nella Fase 1**.

### Motivazione e Limiti di Fase 1 (`AC-F1-10`)
1. **Piena Compatibilità con il Rilascio «Dedicated-First» (`ADR-002`)**:
   Nella Fase 1, la piattaforma opera esclusivamente in modalità `Dedicated`. Poiché un host è interamente riservato a un singolo tenant cliente, le quote specificate nel modello relazionale (`ResourceQuota`) agiscono come massimali contrattuali e limiti logici, non richiedendo il partizionamento a livello di blocco o filesystem tra tenant concorrenti.
2. **Divieto di Scelta Implicita**:
   È espressamente vietato scegliere o vincolare il codice di Fase 1 a uno specifico filesystem (es. forzare ZFS o XFS) prima di aver condotto i benchmark prestazionali e verificato i prerequisiti di installazione sulle distribuzioni Linux target (Ubuntu 24.04 LTS vs AlmaLinux 9).
3. **Conferma di Chiusura Differita anche in Fase 2 (`HCP-SPEC-003` §1.2, `AC-F2-10`)**:
   Anche con l'attivazione del runtime `Dedicated` in Fase 2 (`HCP-SPEC-003`), questo ADR rimane tassativamente in stato **`OPEN — prima di Shared`**. La modalità Shared Hosting resta bloccata (`sharedHostingEnabled: false`, `409 SHARED_MODE_GATED`) fino alla futura specifica dedicata (`HCP-SPEC-007`) e al superamento integrale del Security Gate (`ADR-007`).
