# ADR 0014 — Ingress Data Plane con Traefik v3 Dynamic File Provider «Zero-Sock» e Reti Isolate per Sito

- **Stato:** `APPROVATO — Fase 2`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-003` §4.1, §4.2 (`AC-F2-03`, `AC-F2-09`, `TH-02`, `CP-01`)  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

La configurazione tipica dei reverse proxy nel mondo container (es. Traefik con provider Docker nativo o `nginx-proxy`) prevede il montaggio diretto di `/var/run/docker.sock` all'interno del container esposto pubblicamente sulle porte `80`/`443`. Tale pattern introduce due rischi inaccettabili per la piattaforma:
1. **Minaccia di Container Escape (`TH-02`)**: Il reverse proxy elabora traffico HTTP non fidato proveniente da Internet. In caso di vulnerabilità RCE nel proxy, la presenza di `/var/run/docker.sock` consente all'attaccante di avviare container privilegiati e assumere il controllo `root` immediato dell'intero host Linux.
2. **Visibilità Orizzontale tra Siti e Accoppiamento col Control Plane (`CP-01`)**: Collegare tutti i container applicativi e di backend a un'unica rete bridge condivisa espone database e microservizi interni a scansioni laterali tra stack diversi; inoltre l'instradamento HTTP deve continuare a funzionare senza alcuna interruzione anche quando Control Plane e agenti sono spenti (`AC-F1-08`).

---

## 2. Decisione Architetturale

Si stabilisce un'architettura di **Data Plane Ingress completamente priva di socket Docker («Zero-Sock»)** governata da `hp-docker-executor`:

1. **Traefik v3 con Dynamic File Provider in Sola Lettura**:
   - Il container `hp_ingress_proxy` (`traefik:v3.3`) monta **esclusivamente in sola lettura (`:ro`)**:
     - `/var/lib/hosting-panel/ingress/static/traefik.yml:/etc/traefik/traefik.yml:ro` (`dashboard: false`, `insecure: false`, `providers.file.watch: true`);
     - `/var/lib/hosting-panel/ingress/dynamic:/etc/traefik/dynamic:ro`.
   - **Divieto assoluto di montare `/var/run/docker.sock`** nel proxy (`HOST_POLICY_DENIED` se rilevato).
   - Il container proxy è avviato con `Privileged: false`, `CapDrop: ["ALL"]`, `CapAdd: ["NET_BIND_SERVICE"]`, `SecurityOpt: ["no-new-privileges:true"]`, `PidsLimit: 256` e `RestartPolicy: { Name: "unless-stopped" }`.
2. **Aggiornamento Atomico POSIX delle Rotte (`site_<siteId>.yml`)**:
   - Ad ogni deploy o rimozione di un servizio esposto, `hp-docker-executor` genera il file YAML del sito validando rigorosamente identificativi e FQDN (`assertSafeIdentifier`, `assertSafeDomain`), scrive su un file temporaneo `.tmp` nella medesima directory e invoca `fs.rename` atomico POSIX verso `site_<siteId>.yml`.
   - Traefik rileva l'evento `inotify` e ricarica la tabella di routing a caldo con **zero downtime** e zero rischio di letture parziali.
3. **Segmentazione di Rete per `Site`**:
   - Ogni `Site` riceve una rete bridge interna dedicata `hp_site_<siteId>_net` (`Internal: true`) per la comunicazione privata tra i servizi dello stesso stack (es. app -> database).
   - I soli container con domini HTTP esposti vengono collegati alla rete di frontiera dedicata `hp_edge_<siteId>_net` condivisa unicamente con `hp_ingress_proxy`, impedendo qualsiasi visibilità diretta container-to-container tra siti distinti.

---

## 3. Conseguenze

### Vantaggi
- **Neutralizzazione di `TH-02` (`AC-F2-03`)**: Una compromissione del processo Traefik resta confinata in un container non privilegiato privo di capabilities (eccetto il bind sulla porta 80) e privo di accesso al demone Docker o al filesystem scrivibile.
- **Piena Conformità a `CP-01` e `AC-F1-08` (`AC-F2-09`)**: Poiché i file di configurazione risiedono già su disco e i container operano con `unless-stopped`, l'arresto simultaneo (`SIGKILL`) di `hp-web`, `hp-api`, `hp-docker-executor`, `hp-host-agent` e PostgreSQL mantiene il `100%` di risposte `200 OK` sui siti ospitati.
- **Allineamento con `AC-F2-10`**: In Fase 2 l'emissione automatica ACME/TLS resta esplicitamente disabilitata (`acmeTlsRuntimeAvailable: false`), demandata a `HCP-SPEC-005` senza dover modificare il confine di sicurezza del proxy.
