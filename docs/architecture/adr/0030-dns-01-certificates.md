# ADR 0030 — Certificati con DNS-01 tramite un Fornitore DNS

- **Stato:** `APPROVATO — M5`
- **Data:** 2026-11-20
- **Riferimento:** `ADR-0017`, `ADR-0018`, `CP-01`, `ADR-014`
- **Migrazioni:** `0020` (additiva)

## 1. Contesto

Con HTTP-01 (ADR 0017) Let's Encrypt deve raggiungere il server sulla porta 80, quindi il record A del dominio deve già puntare al server. Con DNS-01 il pannello prova il controllo del dominio scrivendo un record TXT presso il fornitore DNS. Funziona anche prima che il record A punti al server: un sito può avere il certificato pronto prima del cambio di DNS.

## 2. Decisioni

1. **Due resolver, uno store.** `le` resta HTTP-01, è il predefinito e non cambia. `le-dns` usa DNS-01 ed esiste solo se `HP_ACME_EMAIL` è impostato e c'è un fornitore. I due condividono email, CA e lo stesso file di storage per CA (ADR 0017 §2.4): Traefik divide il file per nome del resolver. Il lettore di stato (`apps/docker-executor/src/acme-status.ts`) legge entrambe le chiavi; se un nome compare due volte vince il `notAfter` più recente. In produzione `le-dns` ha solo `dnsChallenge.provider`, senza `resolvers` né `propagation`. Il resolver è scritto da `apps/docker-executor/src/traefik-config.ts`.
2. **Un solo fornitore per installazione, da una lista chiusa.** I nomi dei campi sono le variabili di lego (la versione inclusa in Traefik v3.7.19), definite in `packages/contracts/src/dns-provider.ts`. La mappa fornitore → campi è il confine di sicurezza: nessun nome di variabile arbitrario è accettato.

   | Fornitore | Campi |
   |---|---|
   | `cloudflare` | `CLOUDFLARE_DNS_API_TOKEN` |
   | `digitalocean` | `DO_AUTH_TOKEN` |
   | `gandiv5` | `GANDIV5_PERSONAL_ACCESS_TOKEN` |
   | `hetzner` | `HETZNER_API_TOKEN` |
   | `httpreq` | `HTTPREQ_ENDPOINT`; `HTTPREQ_USERNAME` e `HTTPREQ_PASSWORD` facoltativi, entrambi o nessuno |
   | `ionos` | `IONOS_API_KEY` |
   | `ovh` | `OVH_ENDPOINT`, `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY` |

   `route53` è escluso: lego non legge le variabili `AWS_*_FILE`.
3. **Percorso del segreto.** Riga cifrata (`AES-256-GCM`, tabella `dns_provider_settings`, `packages/database/src/dns-provider-repository.ts`) → IPC firmato (`POST /v1/ingress/dns-provider/apply`) → un file `0400` per campo nella directory tmpfs `/run/hosting-panel/acme-dns` (`0700 hp-executor`, env `HP_ACME_DNS_SECRET_DIR`) → bind `:ro` della **directory** su `/run/secrets/hp-acme-dns` (stesso motivo dell'inode di ADR 0018 §2.3) → `<NOME>_FILE=/run/secrets/hp-acme-dns/<NOME>` nell'`Env` del proxy. Anche gli endpoint, che non sono segreti, passano da file: una sola regola. Le credenziali non compaiono mai in chiaro in env, argv, etichette, hash di configurazione, DTO, audit, outbox o log del pannello, con due eccezioni. Un valore sotto i 4 caratteri dentro un errore di lego resta nel dettaglio della riga di audit `site.certificate.failed`: l'executor toglie solo i valori di almeno 4 caratteri (punto 6). Il log del proxy non è ripulito: Traefik vi scrive l'errore di lego così com'è, anche quello che il fornitore ripete; lo leggono solo gli amministratori (`docker logs` e la pagina Log, `GET /v1/admin/logs/ingress_proxy`). Il DTO di `/v1/admin/dns-provider` elenca solo quali campi sono impostati (`fieldsSet`).
4. **L'executor salva la configurazione non segreta.** `dns-provider.json` (`0600`, solo fornitore e nomi dei campi) sta nella radice dell'ingress (`apps/docker-executor/src/dns-provider.ts`): dopo un riavvio dell'executor il `traefik.yml` generato è identico e il proxy non è ricreato. Un cambio della configurazione statica (fornitore aggiunto, cambiato o tolto) ricrea il proxy. Un cambio del solo contenuto di una credenziale lo riavvia, perché lego tiene in memoria il suo client. Il controllo di deriva confronta anche le voci `*_FILE` dell'`Env`. Senza fornitore il payload del proxy è identico a prima: l'aggiornamento non lo ricrea (`CP-01`). Quando lo stato del fornitore cambia, l'executor riscrive i file delle rotte dei siti, così un host dns-01 passa da `tls: {}` a `le-dns` e viceversa.
5. **La scelta è per dominio.** Nuova colonna `domains.cert_challenge` (`packages/database/migrations/0020_dns_challenge.sql`), predefinita `http-01`. Solo l'amministratore dell'infrastruttura la cambia (`PATCH /v1/admin/sites/{siteId}/domains/{domainId}`). `dns-01` senza fornitore è rifiutato (`VALIDATION_ERROR`, `dns_provider_missing`); togliere il fornitore mentre un dominio lo usa è rifiutato (`dns_challenge_in_use`). Il cliente vede la scelta in sola lettura. Un dominio `failed` (non `rate_limited`) che cambia metodo torna a `none` e può essere ordinato di nuovo.
6. **Il reconciler ordina un dominio dns-01 senza aspettare il record A.** Il controllo diventa «`le-dns` è attivo» invece di «DNS ok». Backoff, intervallo di 15 minuti e limiti restano quelli di ADR 0017 §2.2. Nuovo problema `dns_provider`: ogni errore di `le-dns`, tranne `rate_limited` e `caa_blocked`. L'executor toglie dal dettaglio i valori esatti delle credenziali di almeno 4 caratteri, dal più lungo.
7. **L'hash delle rotte aggiunge il campo solo per dns-01.** La rotta porta `challenge: "dns-01"` solo per gli host TLS in dns-01. Le rotte esistenti mantengono il loro hash e i file http-01 restano identici byte per byte. Un host dns-01 senza `le-dns` riceve `tls: {}` senza resolver e non fallisce.
8. **Il certificato del pannello resta HTTP-01** (ADR 0017 §2.11). Cambia solo il controllo del suo resolver, ora ancorato a `certResolver: le`, così `le-dns` non lo confonde.
9. **Collaudo con processi reali.** `infra/linux/accept-acme-pebble.mjs` avvia Traefik v3.7.19, Pebble e challtestsrv v2.10.3 senza root, con il fornitore `httpreq`. Verifica un certificato HTTP-01 e uno DNS-01 (per un host senza record A), e che l'ambiente del processo Traefik contenga solo nomi `*_FILE` e nessun valore.

## 3. Limiti noti

- Eccezione a `CP-01`. Dopo un riavvio dell'host con il control plane fermo, i file delle credenziali (solo in tmpfs) non ci sono: i rinnovi DNS-01 aspettano che l'API torni e li riscriva. Traefik rinnova 30 giorni prima della scadenza e riprova, quindi nessun certificato va perso se il pannello torna entro quella finestra. I rinnovi HTTP-01 non ne sono toccati.
- Una credenziale ruotata riavvia il proxy: pochi secondi senza siti.
- Il record A serve comunque ai visitatori: il cliente vede «In attesa del DNS» finché non punta al server.
- Ogni errore del fornitore in lego diventa `dns_provider`. Il dettaglio ripulito (valori di almeno 4 caratteri, dal più lungo) e al più 1 KiB è nella riga di audit `site.certificate.failed`. L'errore intero, non ripulito, è nel log del proxy, che solo gli amministratori leggono: può contenere ciò che il fornitore ripete.
- Un dominio passato a dns-01 conserva nello store il vecchio certificato `le`, che Traefik continua a rinnovare con HTTP-01 (ADR 0017, primo limite).
- Certificati wildcard non supportati in questa versione: c'è un router per host (ADR 0017 §2.3) e un hostname con `*` è rifiutato.
