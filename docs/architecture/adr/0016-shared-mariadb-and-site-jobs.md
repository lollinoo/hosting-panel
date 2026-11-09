# ADR 0016 — MariaDB Condiviso di Piattaforma, Job di Setup Effimeri e Siti WordPress Gestiti

- **Stato:** `APPROVATO — Step 2a`
- **Data:** 2026-11-08
- **Riferimento:** spec `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md`, `CP-01`, `F1-012`, `AC-F1-01`
- **Migrazioni:** `0004` (additiva, più cinque FK ricreate con `ON UPDATE CASCADE`) e `0005` (il trigger di `stack_revisions` consente le cancellazioni a cascata)

## 1. Contesto

Lo Step 2a introduce l'unico tipo di sito creabile (WordPress, PHP `8.3`/`8.4`/`8.5`, default `8.4`) e un database MariaDB condiviso. Servono database e utenti per sito, un'installazione di WordPress senza segreti in env/argv, e sopravvivenza ai riavvii senza control plane (`CP-01`).

## 2. Decisioni

1. **MariaDB è un container di piattaforma (`hp_mariadb`) eseguito come utente dedicato `hp-mariadb`**, non come `hp-executor` (che è nel gruppo `docker`, quindi equivale a root sull'host). La chiave root (`/etc/hosting-panel/mariadb-root.key`, 32 byte, `0440 hp-mariadb:hp-executor`) è un file persistente generato dal bootstrap: il database si riavvia (`RestartPolicy: unless-stopped`) senza nulla da `/run/hosting-panel` e senza control plane. La password arriva al container solo come file (`MARIADB_ROOT_PASSWORD_FILE`). Dati in `/var/lib/hosting-panel/mariadb/data` (`0700 hp-mariadb`). `root` è limitato alla **subnet di amministrazione** `172.30.250.0/24` (rete `hp_mariadb_net`, override `HP_MARIADB_ADMIN_SUBNET`, solo IPv4 /8, /16, /24): ci accedono i job di setup, mai un sito. `hp_mariadb` e il proxy sono ricreati solo se cambiano immagine o configurazione; l'updater non li tocca.
2. **Immagini fissate per tag, non per digest.** Docker Hub ripubblica i tag per rebuild di sicurezza; accettiamo questa deriva finché lo Step 6 «Updates» non introduce i pin per digest. I tag stanno solo in `packages/contracts/src/site-runtime.ts`.
3. **Un solo budget di timeout e rinnovo del lease per passo.** Pull immagine 240 s e attesa job 240 s nell'executor; IPC API→executor: `deployService` 300 s, `runSiteJob` 510 s, `purgeSite` 120 s, log 35 s. Il claim dell'outbox dà un lease di 60 s: prima di ogni passo di provisioning l'operazione viene rinnovata a 12 minuti, così un job lungo non viene rieseguito da un altro worker.
4. **Job come container effimeri, non `docker exec`.** L'API sceglie solo un `SiteJobKind` (`db.provision`, `db.drop`, `wordpress.install`); immagine, comando, mount e rete sono fissati dall'executor (`site-jobs.ts`). I parametri arrivano come `$HP_*`, i segreti come file `/run/secrets/<NAME>` letti con redirezione stdin o builtin di shell. Il job ha `CapDrop: ALL`, `no-new-privileges`, 512 MiB, 1 CPU, `PidsLimit 128` e nessuna porta host. `docker exec` richiederebbe di comporre comandi su un container di runtime già esposto.
5. **Nessun sito conserva un segreto di runtime.** La password del DB sito è di 64 caratteri esadecimali minuscoli (l'executor rifiuta altro prima dell'SQL) e vive solo come segreto cifrato `AES-256-GCM` (`ADR-0015`). La password admin WordPress digitata alla creazione è un segreto cifrato cancellato a installazione riuscita. I clienti non possono scrivere le chiavi di piattaforma (`SITE_DB_PASSWORD`, `WP_ADMIN_PASSWORD_INITIAL`, `HP_*`). Messaggi d'errore e di passo sono testi fissi; l'output grezzo del job va solo nei dettagli di audit riservati agli admin.
6. **Capability del runtime WordPress.** L'immagine ufficiale parte come root, ascolta sulla 80 e poi scende a `www-data`: mantiene l'insieme certificato `CHOWN`, `SETUID`, `SETGID`, `NET_BIND_SERVICE` sopra `CapDrop: ALL`, con `no-new-privileges`, limiti (1000 milli-CPU, 512 MiB, pids 256) e nessuna porta host.
7. **Organizzazione «platform-ops».** Un sito creato dall'admin senza cliente è detenuto da `org_platform_ops` (`PLATFORM_OPS_ORG_ID`) ed è **escluso** da `AC-F1-01` (isolamento tra tenant) perché non appartiene a nessun tenant; nessun cliente lo vede e solo `/v1/admin/sites` lo raggiunge.
8. **Il passaggio di proprietà rigenera la cifratura.** L'AAD dei segreti include `organizationId`: spostare un sito richiede di ri-cifrare ogni suo segreto per la nuova organizzazione nella stessa transazione, altrimenti il tag GCM fallirebbe.

## 3. Conseguenze

- I siti gestiti si modificano solo da `managed-sites` e `admin/sites`; le rotte generiche (servizi, revisioni, lifecycle, segreti) li rifiutano.
- Ogni azione admin è registrata come `admin.site.*`.
- I flag di capability non cambiano: `acmeTlsRuntimeAvailable` diventa `true` nello Step 2b.
- Solo installazioni nuove; minimo 2 GB di RAM (l'installer avvisa sotto 1.800.000 kB, senza bloccare).
- Il proxy nasce con `GwPriority: 1` su `hp_ingress_net` (Docker Engine API ≥ 1.48, Docker 28+; l'installer rifiuta motori più vecchi): senza priorità Docker sposterebbe la rotta di default sulla prima rete `hp_edge_*` collegata e bloccherebbe le richieste al pannello in corso (O2).
- Il cambio di proprietario non tocca WordPress: gli account di amministrazione WP (e il codice installato) del vecchio proprietario restano validi per il nuovo, e il pannello non può revocarli; la conferma lo dice e invita a reimpostarli da WP Admin.
