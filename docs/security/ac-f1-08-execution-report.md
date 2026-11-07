# Report Esecuzione Reale Outage Control Plane — `AC-F1-08` / `AC-F2-09` (`CP-01`)

- **Specifica di riferimento:** `HCP-SPEC-003` §9.2, §10 (`AC-F2-09`), `docs/security/phase-1-test-and-outage-plan.md` §3 (`AC-F1-08`)
- **Run ID:** `6d0985be`
- **Inizio esecuzione:** `2026-11-07T23:03:53.997Z`
- **Fine esecuzione:** `2026-11-07T23:04:32.768Z`
- **Verdetto Oggettivo:** **`PASS`**

---

## 1. Ambiente Fisico/OS e Stack Verificato

| Componente | Valore Rilevato |
| :--- | :--- |
| **Sistema Operativo / Kernel** | `Linux 7.3.3-1-cachyos` (`x64`) |
| **Node.js Runtime** | `v26.13.0` |
| **Docker Engine** | `29.9.3` (API `v1.56`) |
| **Control Plane Database** | `PostgreSQL 18.1 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit` |
| **Migrazioni SQL Applicate su PostgreSQL 18** | `0001_phase1_docker_native.sql, 0002_phase2_runtime_and_secrets.sql` |
| **Filesystem Segreti (`/tmp`)** | `tmpfs` (mode `0700` dir / `0400` secret files `:ro`) |
| **Ingress Data Plane** | `traefik:v3.3` (`hp_ingress_proxy`, zero `docker.sock`, file provider dinamico `:ro`) |
| **Workload Tenant Data Plane** | 2 siti HTTP (`alpha-6d0985be.outage.hcp.local`, `bravo-6d0985be.outage.hcp.local` su `nginxinc/nginx-unprivileged:alpine`) + 1 datastore interno (`redis:7.4-alpine`) |

---

## 2. Verifica Criteri Pass/Fail (`AC-F1-08` & `AC-F2-09`)

| Parametro / Invariante | Soglia Richiesta | Risultato Misurato | Esito |
| :--- | :--- | :--- | :---: |
| **Disponibilità HTTP Siti Tenant (`T0..T5`)** | `100.00%` (`0` errori HTTP/TCP) | **`100.00%`** (`1521/1521` `200 OK`, `0` errori) | **PASS** |
| **Connessioni TCP Reset (`ECONNRESET`)** | `0` | **`0`** | **PASS** |
| **Uptime Ininterrotto & Container Restarts** | `RestartCount === 0`, stesso `StartedAt` | **`0` restart** su `hp_ingress_proxy` e su tutti i 3 container tenant | **PASS** |
| **Riconciliazione Post-Outage (`T5`)** | `in_sync` entro `<= 30s` senza riavvii | `alpha=in_sync`, `bravo=in_sync` in **`2.81s`** | **PASS** |
| **Zero `docker.sock` in `hp_ingress_proxy` (`TH-02`)** | Nessun mount `docker.sock` | `ingressZeroDockerSock = true` | **PASS** |
| **Confinamento Container & Segreti `*_FILE` (`AC-F2-03/05`)** | `Privileged=false`, `CapDrop=[ALL]`, `no-new-privileges`, zero segreti in `Env` | Verificato via `docker inspect` su tutti i container | **PASS** |

---

## 3. Metriche di Carico HTTP per Fase (`T0..T5`, Target `50 req/s`)

| Fase | Richieste Totali | `200 OK` | Errori HTTP | Errori TCP | `ECONNRESET` | Disponibilità | `p50` | `p95` | `p99` |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`T0`** | 147 | 147 | 0 | 0 | 0 | **100.00%** | 1.59 ms | 2.2 ms | 3.94 ms |
| **`T1`** | 154 | 154 | 0 | 0 | 0 | **100.00%** | 1.49 ms | 1.88 ms | 2.64 ms |
| **`T2`** | 154 | 154 | 0 | 0 | 0 | **100.00%** | 1.58 ms | 1.99 ms | 2.22 ms |
| **`T3`** | 108 | 108 | 0 | 0 | 0 | **100.00%** | 1.49 ms | 1.94 ms | 2.36 ms |
| **`T4`** | 746 | 746 | 0 | 0 | 0 | **100.00%** | 1.39 ms | 1.8 ms | 2.29 ms |
| **`T5`** | 212 | 212 | 0 | 0 | 0 | **100.00%** | 1.32 ms | 1.92 ms | 3.38 ms |
| **Totale `T0..T5`** | **1521** | **1521** | **0** | **0** | **0** | **100.00%** | **1.44 ms** | **1.89 ms** | **2.67 ms** |

---

## 4. Continuità Ininterrotta dei Container Data Plane (`docker inspect`)

| Ruolo | Container | Immagine | Stesso Container ID | `StartedAt` (`T0`) | `StartedAt` (`T5`) | `RestartCount` |
| :--- | :--- | :--- | :---: | :--- | :--- | ---: |
| `ingressProxy` | `hp_ingress_proxy` | `traefik:v3.3` | `true` | `2026-11-07T23:03:59.463640345Z` | `2026-11-07T23:03:59.463640345Z` | **`0`** |
| `alphaWeb` | `hp_svc_svc_4fac01fc2cd4461382ac3dff3a3e7041` | `nginxinc/nginx-unprivileged:alpine` | `true` | `2026-11-07T23:03:59.252944182Z` | `2026-11-07T23:03:59.252944182Z` | **`0`** |
| `alphaRedis` | `hp_svc_svc_803e1e77e77f4835864961bf0ef7f5d7` | `redis:7.4-alpine` | `true` | `2026-11-07T23:04:00.061362982Z` | `2026-11-07T23:04:00.061362982Z` | **`0`** |
| `bravoWeb` | `hp_svc_svc_ae28b78849814dc4b2ae46ee45aaced8` | `nginxinc/nginx-unprivileged:alpine` | `true` | `2026-11-07T23:04:00.702467453Z` | `2026-11-07T23:04:00.702467453Z` | **`0`** |

---

## 5. Timeline Operativa degli Eventi (`T0..T5`)

| Evento | Timestamp ISO-8601 | Dettaglio |
| :--- | :--- | :--- |
| `T0_STACK_READY` | `2026-11-07T23:03:58.795Z` | Control Plane online (api=:38343, web=:39945, ingress=:33149) |
| `T0_BASELINE_VERIFIED` | `2026-11-07T23:04:04.851Z` | Baseline 50 req/s active across alpha-6d0985be.outage.hcp.local & bravo-6d0985be.outage.hcp.local |
| `T1_WEB_SIGKILL` | `2026-11-07T23:04:07.954Z` | hp-web killed with SIGKILL; panel port :39945 refused connections while tenant HTTP continued |
| `T2_API_SIGKILL` | `2026-11-07T23:04:11.056Z` | hp-api killed with SIGKILL; /health/live port :38343 refused connections while tenant HTTP continued |
| `T3_DAEMONS_AND_DB_DOWN` | `2026-11-07T23:04:13.255Z` | hp-docker-executor & hp-host-agent killed (SIGKILL) and PostgreSQL 18 container stopped; zero Control Plane processes running |
| `T4_OUTAGE_WINDOW_COMPLETE` | `2026-11-07T23:04:28.324Z` | Completed 15s total Control Plane outage window under continuous HTTP load |
| `T5_RECONCILED_IN_SYNC` | `2026-11-07T23:04:32.768Z` | Control Plane recovered and reconciled in_sync in 2.81s (< 30s threshold); 0 container restarts |

---

## 6. Payload JSON Verificabile

```json
{
  "specId": "HCP-SPEC-003",
  "criterion": [
    "AC-F1-08",
    "AC-F2-09",
    "CP-01"
  ],
  "verdict": "PASS",
  "runId": "6d0985be",
  "startedAt": "2026-11-07T23:03:53.997Z",
  "completedAt": "2026-11-07T23:04:32.768Z",
  "environment": {
    "hostname": "cachyos-x8664",
    "kernel": "Linux 7.3.3-1-cachyos",
    "arch": "x64",
    "nodeVersion": "v26.13.0",
    "dockerServerVersion": "29.9.3",
    "dockerApiVersion": "1.56",
    "postgresVersion": "PostgreSQL 18.1 on x86_64-pc-linux-musl, compiled by gcc (Alpine 15.2.0) 15.2.0, 64-bit",
    "appliedMigrations": [
      "0001_phase1_docker_native.sql",
      "0002_phase2_runtime_and_secrets.sql"
    ],
    "secretsTmpfsFilesystem": "tmpfs"
  },
  "securityProofs": {
    "ingressZeroDockerSock": true,
    "allContainersUnprivileged": true,
    "allContainersCapDropAll": true,
    "allContainersNoNewPrivileges": true,
    "secretsEncryptedAndTmpfsFileOnly": true,
    "backingRedisNetworkIsolated": true
  },
  "t5Reconciliation": {
    "convergenceSeconds": 2.81,
    "thresholdSeconds": 30,
    "siteAlphaDriftStatus": "in_sync",
    "siteBravoDriftStatus": "in_sync"
  },
  "containerContinuity": [
    {
      "role": "ingressProxy",
      "containerName": "hp_ingress_proxy",
      "image": "traefik:v3.3",
      "sameContainerId": true,
      "startedAtBefore": "2026-11-07T23:03:59.463640345Z",
      "startedAtAfter": "2026-11-07T23:03:59.463640345Z",
      "uninterruptedUptime": true,
      "restartCount": 0
    },
    {
      "role": "alphaWeb",
      "containerName": "hp_svc_svc_4fac01fc2cd4461382ac3dff3a3e7041",
      "image": "nginxinc/nginx-unprivileged:alpine",
      "sameContainerId": true,
      "startedAtBefore": "2026-11-07T23:03:59.252944182Z",
      "startedAtAfter": "2026-11-07T23:03:59.252944182Z",
      "uninterruptedUptime": true,
      "restartCount": 0
    },
    {
      "role": "alphaRedis",
      "containerName": "hp_svc_svc_803e1e77e77f4835864961bf0ef7f5d7",
      "image": "redis:7.4-alpine",
      "sameContainerId": true,
      "startedAtBefore": "2026-11-07T23:04:00.061362982Z",
      "startedAtAfter": "2026-11-07T23:04:00.061362982Z",
      "uninterruptedUptime": true,
      "restartCount": 0
    },
    {
      "role": "bravoWeb",
      "containerName": "hp_svc_svc_ae28b78849814dc4b2ae46ee45aaced8",
      "image": "nginxinc/nginx-unprivileged:alpine",
      "sameContainerId": true,
      "startedAtBefore": "2026-11-07T23:04:00.702467453Z",
      "startedAtAfter": "2026-11-07T23:04:00.702467453Z",
      "uninterruptedUptime": true,
      "restartCount": 0
    }
  ],
  "httpLoadMetrics": {
    "phases": [
      {
        "phase": "T0",
        "totalRequests": 147,
        "ok200": 147,
        "httpErrors": 0,
        "tcpErrors": 0,
        "connResets": 0,
        "availabilityPct": 100,
        "p50Ms": 1.59,
        "p95Ms": 2.2,
        "p99Ms": 3.94,
        "maxMs": 9.55,
        "errorSamples": []
      },
      {
        "phase": "T1",
        "totalRequests": 154,
        "ok200": 154,
        "httpErrors": 0,
        "tcpErrors": 0,
        "connResets": 0,
        "availabilityPct": 100,
        "p50Ms": 1.49,
        "p95Ms": 1.88,
        "p99Ms": 2.64,
        "maxMs": 2.67,
        "errorSamples": []
      },
      {
        "phase": "T2",
        "totalRequests": 154,
        "ok200": 154,
        "httpErrors": 0,
        "tcpErrors": 0,
        "connResets": 0,
        "availabilityPct": 100,
        "p50Ms": 1.58,
        "p95Ms": 1.99,
        "p99Ms": 2.22,
        "maxMs": 2.42,
        "errorSamples": []
      },
      {
        "phase": "T3",
        "totalRequests": 108,
        "ok200": 108,
        "httpErrors": 0,
        "tcpErrors": 0,
        "connResets": 0,
        "availabilityPct": 100,
        "p50Ms": 1.49,
        "p95Ms": 1.94,
        "p99Ms": 2.36,
        "maxMs": 3.3,
        "errorSamples": []
      },
      {
        "phase": "T4",
        "totalRequests": 746,
        "ok200": 746,
        "httpErrors": 0,
        "tcpErrors": 0,
        "connResets": 0,
        "availabilityPct": 100,
        "p50Ms": 1.39,
        "p95Ms": 1.8,
        "p99Ms": 2.29,
        "maxMs": 13.01,
        "errorSamples": []
      },
      {
        "phase": "T5",
        "totalRequests": 212,
        "ok200": 212,
        "httpErrors": 0,
        "tcpErrors": 0,
        "connResets": 0,
        "availabilityPct": 100,
        "p50Ms": 1.32,
        "p95Ms": 1.92,
        "p99Ms": 3.38,
        "maxMs": 8.08,
        "errorSamples": []
      }
    ],
    "overall": {
      "totalRequests": 1521,
      "ok200": 1521,
      "httpErrors": 0,
      "tcpErrors": 0,
      "connResets": 0,
      "availabilityPct": 100,
      "p50Ms": 1.44,
      "p95Ms": 1.89,
      "p99Ms": 2.67,
      "maxMs": 13.01
    }
  },
  "timeline": [
    {
      "step": "T0_STACK_READY",
      "timestamp": "2026-11-07T23:03:58.795Z",
      "detail": "Control Plane online (api=:38343, web=:39945, ingress=:33149)"
    },
    {
      "step": "T0_BASELINE_VERIFIED",
      "timestamp": "2026-11-07T23:04:04.851Z",
      "detail": "Baseline 50 req/s active across alpha-6d0985be.outage.hcp.local & bravo-6d0985be.outage.hcp.local"
    },
    {
      "step": "T1_WEB_SIGKILL",
      "timestamp": "2026-11-07T23:04:07.954Z",
      "detail": "hp-web killed with SIGKILL; panel port :39945 refused connections while tenant HTTP continued"
    },
    {
      "step": "T2_API_SIGKILL",
      "timestamp": "2026-11-07T23:04:11.056Z",
      "detail": "hp-api killed with SIGKILL; /health/live port :38343 refused connections while tenant HTTP continued"
    },
    {
      "step": "T3_DAEMONS_AND_DB_DOWN",
      "timestamp": "2026-11-07T23:04:13.255Z",
      "detail": "hp-docker-executor & hp-host-agent killed (SIGKILL) and PostgreSQL 18 container stopped; zero Control Plane processes running"
    },
    {
      "step": "T4_OUTAGE_WINDOW_COMPLETE",
      "timestamp": "2026-11-07T23:04:28.324Z",
      "detail": "Completed 15s total Control Plane outage window under continuous HTTP load"
    },
    {
      "step": "T5_RECONCILED_IN_SYNC",
      "timestamp": "2026-11-07T23:04:32.768Z",
      "detail": "Control Plane recovered and reconciled in_sync in 2.81s (< 30s threshold); 0 container restarts"
    }
  ]
}
```
