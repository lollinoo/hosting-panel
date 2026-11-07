# ADR 0013 — Protocollo IPC su Unix Domain Socket Firmato e Protezione Anti-Replay

- **Stato:** `APPROVATO — Fase 2`  
- **Data:** 2026-11-07  
- **Riferimento di specifica:** `HCP-SPEC-003` §3 (`AC-F2-02`), `ADR-008`, `ADR-010`  
- **Autore:** Core Architecture Group  

---

## 1. Contesto e Problema

Con la separazione fisica dei processi stabilita in `ADR-010`, `hp-api` (Outbox Worker e Reconciler) comunica localmente con `hp-docker-executor` e `hp-host-agent`. Affidarsi unicamente ai permessi POSIX del filesystem sul socket Unix non è sufficiente per tre ragioni:
1. Qualsiasi processo compromesso appartenente al gruppo condiviso potrebbe iniettare richieste prive di integrità sul payload o rigiocare (*replay*) comandi catturati.
2. In vista dell'evoluzione opzionale verso il Management Hub multi-host (`ADR-008`), l'autenticazione a livello di messaggio deve essere agnostica rispetto al trasporto fisico sottostante.
3. L'apertura di porte TCP locali (`127.0.0.1` o `0.0.0.0`) esporrebbe i demoni privilegiati a rischi di *SSRF* (*Server-Side Request Forgery*) da workload o processi non autorizzati sull'host.

---

## 2. Decisione Architetturale

Si adotta un protocollo IPC basato su **HTTP/1.1 JSON su Unix Domain Socket (UDS) con firma crittografica per singola richiesta e cache anti-replay**:

1. **Confinamento del Trasporto UDS (Zero Porte TCP)**:
   - In produzione Linux, i demoni ascoltano esclusivamente su `/run/hosting-panel/executor.sock` e `/run/hosting-panel/host-agent.sock`.
   - La directory `/run/hosting-panel` è creata con permessi `0750` e ciascun socket con mode `0660` ristretto al gruppo di sistema `hp-ipc`.
   - Nessuna porta TCP viene aperta in produzione; il supporto a Named Pipe o loopback effimero (`127.0.0.1:0`) è confinato ai soli test automatizzati multipiattaforma (`HP_IPC_TRANSPORT=pipe|loopback-test`).
2. **Autenticazione Crittografica `HMAC-SHA256` / `Ed25519` (`packages/contracts/src/ipc-auth.ts`)**:
   Ogni richiesta trasporta cinque intestazioni obbligatorie:
   - `X-HP-Key-Id`: identificativo della chiave attiva nel keyring (rotazione zero-downtime).
   - `X-HP-Timestamp`: timestamp UTC in millisecondi.
   - `X-HP-Nonce`: identificativo univoco casuale per singola richiesta (UUIDv4 / token ad alta entropia).
   - `X-HP-Body-Sha256`: digest SHA-256 esadecimale del body raw.
   - `X-HP-Signature`: firma calcolata tramite `node:crypto` (`HMAC-SHA256` con chiave a 256+ bit da `/etc/hosting-panel/ipc.key` `0440` oppure chiave asimmetrica `Ed25519` predisposta per `ADR-008`) sul payload canonico:
     ```text
     ${METHOD}\n${PATH_WITH_QUERY}\n${TIMESTAMP}\n${NONCE}\n${BODY_SHA256}
     ```
3. **Finestra Temporale (`±30s`) e Anti-Replay (`60s`)**:
   - Richieste prive di header, con digest del body difforme, con firma non valida (verifica `crypto.timingSafeEqual`) o con `|now - timestamp| > 30_000 ms` vengono rigettate con **`401 UNAUTHORIZED`** (`UNAUTHENTICATED`).
   - Solo dopo aver provato autenticità crittografica e freschezza temporale, il demone verifica e registra il `nonce` in `IpcNonceReplayCache` (TTL `60_000 ms`, cap massimo `10_000` voci anti-OOM). Qualsiasi riutilizzo di `nonce` viene rifiutato con **`409 CONFLICT`** (`IDEMPOTENCY_CONFLICT`).

---

## 3. Conseguenze

### Vantaggi
- **Eliminazione SSRF e Replay Locale (`AC-F2-02`)**: Nessun endpoint TCP è raggiungibile via rete e nessun pacchetto IPC valido può essere riutilizzato entro la finestra di skew.
- **Resistenza a DoS sulla Cache Nonce**: La registrazione del `nonce` avviene rigorosamente *dopo* la verifica crittografica della firma, impedendo ad attaccanti non autenticati di saturare la cache anti-replay.
- **Prontezza Nativa per `ADR-008`**: Il supporto nativo a `Ed25519` e keyring multi-chiave consente la futura federazione con un Management Hub remoto senza ridisegnare la semantica applicativa dei messaggi.
