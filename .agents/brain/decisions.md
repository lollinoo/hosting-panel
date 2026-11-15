# Architectural Decisions Log (`hosting-panel` — `HCP-SPEC-002` & `HCP-SPEC-003`)

Durable log of settled architectural and product boundary decisions aligned via `/grill-me` with the user.

---

## Phase 1 Settled `/grill-me` Design Decisions (`HCP-SPEC-002` — 2026-11-07)

1. **Clean-Room Docker-Native Baseline (`Q1`, `Q3`, `Q5`)**:
   - Eliminate all external third-party orchestrator adapters, simulation servers, legacy environment variables, and POC tables.
   - Recreate the monorepo cleanly around the canonical `HCP-SPEC-002` domain model with a single SQL baseline (`0001_phase1_docker_native.sql`).
   - Retain dual-mode local persistence (`@electric-sql/pglite` embedded + `pg` external pool) and local `jose` OIDC dev issuer so deterministic tests and local UI workflows run without requiring a live Linux Docker daemon.

2. **Strict Separation of Authority Roles (`Q2` — `HCP-SPEC-002` §4.1–4.2, `AC-F1-03`)**:
   - Define four explicit role tiers:
     - `infrastructure_admin`: Host lifecycle, Linux maintenance, security posture, Docker Engine status, allocations, operations & audit read (`host.*`, `allocation.*`, `template.read`, `quota.read`, `operation.read`, `audit.read`). No implicit unrestricted customer secret/data access without policy/audit.
     - `hosting_admin`: Service templates, allocations, tenant sites/services/quotas within installation/assigned scopes (`host.read`, `host.metrics.read`, `host.docker.read`, `allocation.*`, `template.*`, `site.*`, `service.*`, `quota.*`, `operation.read`, `audit.read`), **strictly denied** `host.maintenance.*`, `host.security.*`, and `host.docker.engine.manage` (`AC-F1-03`).
     - `customer_owner`: Organization-scoped management of own sites, services, stack revisions, quotas read, operations read, and organization members (`AC-F1-02`, `AC-F1-04`).
     - `customer_collaborator`: Least-privilege collaborator governed by explicit `ResourceGrant` / scoped bindings (ABAC + deny precedence).

3. **Explicit 8-Package Monorepo Boundaries (`Q6` — `HCP-SPEC-002` §9)**:
   - `@hosting-panel/config`, `@hosting-panel/contracts`, `@hosting-panel/authz`, `@hosting-panel/hosting-domain`, `@hosting-panel/policy-engine`, `@hosting-panel/executor-contracts`, `@hosting-panel/host-agent-contracts`, `@hosting-panel/database`.
   - In Phase 1, `executor-contracts` and `host-agent-contracts` exposed strictly typed internal interfaces (`ApprovedServiceSpec`, `DockerExecutorPort`, `HostAgentPort`) with disabled stubs returning `NOT_SUPPORTED`.

4. **Phase 1 API Surface & `shadcn@4.23.0` Italian UI (`Q4`, `Q7`, `Q8` — `AC-F1-10`)**:
   - Approved UI dependencies added to workspace: `shadcn@4.23.0`, `radix-ui@1.8.1`, `class-variance-authority@0.7.1`, `clsx@2.1.1`, `tailwind-merge@3.7.0`, `tw-animate-css@1.4.0`.
   - Built three distinct authority consoles (`Infrastructure Admin`, `Hosting Admin`, `Customer Workspace`) with `shadcn` components over the encrypted `HttpOnly` JWE BFF boundary.

---

## Phase 2 Settled `/grill-me` Design Decisions (`HCP-SPEC-003` — 2026-11-07)

1. **Scope & Deliverable Boundary (`Q1`)**:
   - Author the normative specification `docs/architecture/hcp-spec-003-phase-2.md`, close `ADR-010`, and implement the full Phase 2 runtime inside the monorepo (`apps/docker-executor`, `apps/host-agent`, authenticated IPC, Outbox/Reconciler, minimal `Dedicated` ingress proxy, `systemd` units, Linux bootstrap/break-glass scripts, and `AC-F1-08` outage harness), while initially keeping `Shared Hosting`, `ADR-011`, `ACME/TLS` (later enabled in `ADR-0017`), `SFTP` (later enabled in `ADR-0020`), and production `Backups` (later enabled in `ADR-0022`) closed/gated (`Shared Hosting` remains gated).

2. **Split-Agent Process Topology & Toolchain (`Q2` — Closing `ADR-010` Part 1)**:
   - Enforce three separate privilege domains (`hp-api`/`hp-web`, `hp-docker-executor`, `hp-host-agent`) deployed as independent `systemd` services.
   - Implement `apps/docker-executor` and `apps/host-agent` as lightweight standalone Node.js 24 + TypeScript daemons (zero NestJS, zero new external dependencies), directly sharing `@hosting-panel/contracts`, `@hosting-panel/executor-contracts`, `@hosting-panel/host-agent-contracts`, and `zod`.

3. **Authenticated Local IPC Channel (`Q3` — Closing `ADR-010` Part 2 + `ADR-008` Readiness)**:
   - Use Unix Domain Sockets (`/run/hosting-panel/executor.sock` and `/run/hosting-panel/host-agent.sock`, directory `0750`, socket `0660` confined to group `hp-ipc`, zero open TCP ports) combined with per-request cryptographic signing (`node:crypto` HMAC-SHA256 / Ed25519 over method, path, timestamp, nonce, and SHA-256 body digest, with ±30s clock-skew check and anti-replay nonce cache).
   - Retain portable Named Pipe / ephemeral loopback transport fallback for isolated test suites and non-Linux dev runs.

4. **Docker Engine Boundary & Zero-Sock Data Plane Ingress (`Q4` — `TH-02`, `TH-04`, `CP-01`)**:
   - Confine `/var/run/docker.sock` access exclusively to `hp-docker-executor` via a native `node:http` Docker Engine API (`v1.45+`) client enforcing `Privileged: false`, `CapDrop: ["ALL"]`, `no-new-privileges:true`, `PidsLimit`, CPU/RAM cgroup v2 limits, and isolated per-site bridge networks (`hp_site_<siteId>_net`).
   - Run **Traefik v3 with a read-only Dynamic File Provider** (`/var/lib/hosting-panel/ingress/dynamic:ro`, `watch: true`, `restart: unless-stopped`, **zero `docker.sock` mount**) for atomic hot-reloaded domain routing and 100% Data Plane survival during Control Plane outages (`CP-01`).

5. **Zero-Root Linux Privilege Model & `systemd` Hardening (`Q5` — `TH-03`, `ADR-006`)**:
   - Zero services run as `root`: provision dedicated `/usr/sbin/nologin` system users (`hp-web`, `hp-api`, `hp-executor`, `hp-agent`) and group `hp-ipc`.
   - Mask `/var/run/docker.sock` from Control Plane processes (`InaccessiblePaths=/var/run/docker.sock`) with empty `CapabilityBoundingSet=`.
   - Grant `hp-host-agent` only `AmbientCapabilities=CAP_NET_ADMIN CAP_DAC_READ_SEARCH` with `NoNewPrivileges=yes`, `ProtectSystem=strict`, `SystemCallFilter=@system-service`, and strict `execFile` execution on fixed binary paths without shell invocation (`ALLOWLISTED_HOST_MAINTENANCE_ACTIONS` + static `nftables` `22/80/443` posture checks).

6. **PostgreSQL Transactional Outbox, `unknown` Recovery & Observe-Only Drift Reconciler (`Q6` — `TH-08`, `TH-10`)**:
   - Use PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` for the Transactional Outbox Worker (compatible with both `pg` and `PGlite`, zero mandatory Redis/BullMQ dependency), returning `202 Accepted` (`AsyncAcceptedEnvelope`) and enforcing active operation locks (`409 CONFLICT`).
   - Recover interrupted mutations via the `unknown` state using read-only `getObservedState` inspection (never blind `POST` replay).
   - Keep the Drift Reconciler strictly **observe-only** (`in_sync` / `drifted` + `audit_event`, zero autonomous container restarts or recreations).

7. **Target Linux OS & Live Execution of `AC-F1-08` on Dedicated Linux Environment (`Q7`)**:
   - Standardize on **Ubuntu 24.04 LTS / Debian 12** (`systemd`, `cgroups v2`, `nftables`, Docker Engine CE).
   - Deliver `infra/systemd/*.service`, `infra/linux/bootstrap-dedicated.sh`, break-glass CLI, and `infra/linux/run-outage-ac-f1-08.mjs`, and **execute `AC-F1-08` (`T0..T5` with `SIGKILL` on Web/API/Worker + DB stop under HTTP load) live on the dedicated Linux environment**, recording real measurements in `docs/security/ac-f1-08-execution-report.md`.

8. **Additive Phase 2 DB Migration & `AES-256-GCM` `tmpfs` Secrets (`Q8` — `F1-012`)**:
   - Add non-destructive migration `0002_phase2_runtime_and_secrets.sql` (`encrypted_secrets` encrypted at rest with `AES-256-GCM`, agent heartbeats, and partial unique index on active operation `lock_key`).
   - Mount resolved secrets JIT as read-only files (`0444 :ro` inside `0700`-confined per-service directories for `CapDrop: ["ALL"]` non-root UID compatibility) on `tmpfs` (`/run/hosting-panel/secrets/<serviceId>/<ref>`, Docker `*_FILE` pattern) so plaintext secrets never appear in `stack_revisions`, `outbox_events`, `Config.Env` (`docker inspect`), DTOs, or logs.

9. **Dynamic `PlatformCapabilitiesDto` & Truthful 3-Console `shadcn@4.23.0` Unlock (`Q9` — `AC-F1-10`)**:
   - Evolve `PlatformCapabilitiesDto` to expose `phase: "phase-1" | "phase-2"` and `runtimeBackend: "linux-systemd" | "local-simulator" | "disabled"`, keeping `sharedHostingEnabled` strictly `false` (while `acmeTlsRuntimeAvailable` was later unlocked on `linux-systemd` per `ADR-0017`, `sftpAvailable` was unlocked on `linux-systemd` per `ADR-0020`, `phpMyAdminAvailable` was unlocked on `linux-systemd` per `ADR-0021`, and `productionBackupRuntimeAvailable` was unlocked on `linux-systemd` per `ADR-0022`).
   - Unlock async `202 Accepted` lifecycle controls, `OperationTimeline`, write-only encrypted secret refs, `in_sync`/`drifted` badges, and `InfrastructureAdmin` host telemetry/maintenance/security controls across `apps/web`.

---

## Canonical ADR Register (`HCP-SPEC-002` & `HCP-SPEC-003`)
- **ADR-001..009**: Phase 1 Approved / Baseline ADRs (`docs/architecture/adr/0001..0009`)
- **ADR-010**: Concrete Process Topology & IPC (`Split Agents` + Signed UDS IPC) — **To transition from `OPEN` to `APPROVATO — Fase 2` during `HCP-SPEC-003` implementation**
- **ADR-011**: Filesystem & Volume Disk Quota Enforcement for `Shared` Hosting — **Remains `OPEN — prima di Shared`**
- **ADR-012**: Threat Model Constraint on Untrusted Workloads in Shared Hosting — **VINCOLO**

---

## Production Hosting Panel Owner Decisions (2026-11-08)

Source: `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md`.

1. **Two product roles**: server administrator (`users.platform_role='infrastructure_admin'`, TOTP 2FA mandatory) and customer hosting admin (`customer_owner` membership).
2. **One customer per server**: the panel runs on a dedicated server for a single hosting customer.
3. **No mail hosting**: no mailboxes. Outgoing mail of sites goes through an SMTP relay configured by the admin.
4. **Languages**: UI in Italian (default) and English, per-user language.
5. **Site-first UI**: customer shell centred on the site (top-bar switcher, tabs), Coolify-like look.
6. **DNS stays at the registrar**: the panel checks DNS, never hosts zones.
7. **Backups**: S3 target configured by the admin.
8. **SFTP and web file manager are mandatory**; databases with phpMyAdmin.
9. **Container terminal only**: no host terminal in the panel.
10. **Delivery order** (steps 1–6): 1 foundation (auth, roles, i18n, shell, installer); 2 sites, domains, TLS, outgoing mail; 3 backups; 4 files, databases, site import (first go-live line is steps 1–4); 5 WordPress tools; 6 admin console completion. Each step has its own plan and passes the four sensors plus a real-server check.

## Step 2c Outgoing Mail Owner Decisions (2026-11-09)

Source: `docs/architecture/adr/0018-outgoing-mail-relay.md`.

1. **Sender**: `noreply@<sender domain>`, with the site name and `Reply-To` kept.
2. **Send failures** are visible to the server administrator only.
3. **Panel password-reset emails** are deferred to Step 6.
4. **No per-site SPF/DKIM**: the customer sees "nothing to set up"; the admin page hints SPF/DKIM for the single sender domain.
5. **A site's own SMTP plugin wins**: ours is a default mu-plugin at `PHP_INT_MIN`.
6. **Verified TLS** to the provider: the host must be a hostname, not an IP.
7. **Pre-0.5.0 sites** are redeployed once automatically on update; sites whose service is stopped are upgraded after they are started again.
8. **Limits**: 200 messages/h per site, 100 recipients, 25 MiB. A newsletter needs an external service.
9. **`CP-01` exception**: after a reboot with the panel down, mail is queued, not delivered, until the API is back and re-applies the password (it lives only in tmpfs).
10. **Test send timeout** returns `OPERATION_AMBIGUOUS` ("may have been sent").

## M1a/M1b File Manager & Site SFTP Decisions (2026-11-14)

Sources: `docs/architecture/adr/0019-site-file-manager.md`, `docs/architecture/adr/0020-site-sftp.md`.

1. **Web File Manager (`ADR-0019`)**: isolated per-site `hp_files_<id>` helper container (`network=none`, read-only rootfs, 512 KiB base64 chunks, 2 GiB file cap, async 202 zip/unzip, protected `wp-content/mu-plugins/hp-mail.php`).
2. **Site SFTP (`ADR-0020`, `sftpAvailable: true` on `linux-systemd`)**: single shared digest-pinned `hp_sftp` container (`linuxserver/openssh-server`, port TCP `2222` / `HP_SFTP_PORT`, isolated `hp_sftp_net` bridge) serving chrooted site volumes (`/srv/sftp/<siteId>/files`, UID/GID `33:33`).
3. **Auth & isolation**: password-only SFTP (no SSH keys in cycle 2, no shell, no forwarding); `sha512Crypt` lives in `apps/api/src/sites/sha512-crypt.ts` (`@hosting-panel/contracts` stays browser-safe). Passwords shown once; only `$6$` hashes are persisted (`site_sftp_users`, migration `0008`) and pushed over IPC.
4. **In-place user files & selective recreate**: bind-mounted `passwd`/`group`/`shadow` rewritten in place (`r+` + `ftruncate`) per login without restarting `hp_sftp`; container recreates only when the active site-volume set, image, port, or `sshd_config` changes (`1–3 s` session drop, never touching site containers per `CP-01`).
5. **Compensation, convergence & deletion**: DB writes roll back on executor failure/timeout (`503 DOCKER_ENGINE_UNAVAILABLE`), converged by `HP_SFTP_RETRY_INTERVAL_MS` (`60_000` ms default on `linux-systemd`); `SiteProvisioner.remove` calls `removeSite` before `deleteService`/`purgeSite`.
6. **No firewall rule change**: Docker-published port `2222` traverses DNAT/`FORWARD` bypassing `nftables` `input` and `ufw`; only `bootstrap-dedicated.sh` (`/var/lib/hosting-panel/sftp`, `0700` `hp-executor`) and `install.sh` texts change. Zero new npm dependencies.

---

## M2 Site Databases & phpMyAdmin Decisions (2026-11-14)

Source: `docs/architecture/adr/0021-site-databases.md`.

1. **Shared MariaDB as sole source of truth (`ADR-0021`)**: zero new PostgreSQL tables/migrations; `SiteDatabasesRunner` queries `hp_mariadb` (`information_schema.SCHEMATA`/`TABLES`, `mysql.user`, `mysql.db`) as root via `runDockerExec` (`mariadb` CLI reading `/run/secrets/mariadb-root`, SQL on stdin, `lock_wait_timeout = 30`, `15 s` state / `45 s` batch timeout, per-site serial queue `siteQueues`, no API-side `list`-before-`create`).
2. **Site namespace & double validation**: deterministic `wp_<12hex>` prefix (`siteDatabasePrefix`) and `pma_<12hex>` sign-on account (`siteDatabaseSignOnUser`), suffix `^[a-z0-9][a-z0-9_]{0,15}$`, cap of `10` custom databases and `10` custom users per site (`409 QUOTA_EXCEEDED`), primary DB/user protected (`400 VALIDATION_ERROR`, `reason: "protected"`). Names are validated before SQL (`SiteDatabasesIpcRequestSchema`, `isSiteDatabaseName`) and re-validated when read back (`parseSiteDatabasesState`, `buildSiteDatabasesBatch`), with `_` escaped (`\_`) in `LIKE` and `` `<db_esc>`.* `` (plus `HP_DB_NAME_ESCAPED` in `db.provision` for new sites).
3. **Passwords, connection budget, termination & deletion**: API generates 24-char passwords (`temporaryPassword`, shown once, never persisted/logged) and sends only `*<40hex>` hashes (`mysqlNativePasswordHash` in `@hosting-panel/contracts`) over IPC. Shared `hp_mariadb` keeps `--max-connections=150` (`CP-01`), with per-site `MAX_USER_CONNECTIONS` caps of `40` (primary user via initial `db.provision`), `5` (each extra user), and `10` (sign-on account) — up to `100` connections per site. `KILL USER` runs after password reset, extra-user rotation on site move (`SiteProvisioner.reassign` step `redeploy`), delete user, revoke, phpMyAdmin sign-on rotation, and `SiteProvisioner.remove` (`dropAll` after `db.drop` on valid pattern-matching names).
4. **Shared `hp_phpmyadmin` + authenticated forwarder (`phpMyAdminAvailable: true` on `linux-systemd`)**: single digest-pinned `phpmyadmin@sha256:...` (`5.2.3-apache`) container bound only to `127.0.0.1:${HP_PHPMYADMIN_PORT:-8306}` (`HP_PHPMYADMIN_PORT` must match across `executor.env` and `web.env`; port `2222` also refused), `User: "33:33"`, `ReadonlyRootfs: true`, `CapDrop: ["ALL"]`, `Memory=512 MiB`, `MemorySwap=512 MiB`, `MaxRequestWorkers 4` (`hp-mpm.conf` mounted `:ro` alongside `config.inc.php`), `MEMORY_LIMIT=64M`, `$cfg['MemoryLimit'] = '0'`, `hp_pma_net` attached to `hp_mariadb` without restarting MariaDB (`CP-01`). Reached only via `/phpmyadmin/<siteId>/` (`next.config.mjs` sets `skipTrailingSlashRedirect: true` and anti-framing `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'` outside `/phpmyadmin/...`; forwarded phpMyAdmin keeps upstream `X-Frame-Options` or falls back to `SAMEORIGIN` with upstream CSP unchanged) checking `hp_session`, `hp_pma` JWE (`dir`/`A256GCM`, `HttpOnly`, `SameSite=Strict`, `4h`), and `GET .../databases/phpmyadmin` on every request (`30 s` cache). Forwarder calls phpMyAdmin via `apps/web/src/lib/phpmyadmin-upstream.ts` (`node:http`/`node:stream`, no timeout of its own (`R50`), replacing Node `fetch`'s 300s headers/body timeouts so long PHP work never releases the slot early) and enforces at most `2` concurrent upstream requests per site (`R49`, FIFO `30 s` queue wait -> localized `503` busy page or empty `503`), keeping each slot until the real phpMyAdmin exchange finishes: client cancel or `310 s` upstream header wait (`detached` -> localized `503` "still working" page instructing the customer to wait or reopen phpMyAdmin from the Database tab, or empty `503` for non-page requests) drains in background without aborting phpMyAdmin; bodyless `HEAD`/`204`/`205`/`304`/`401`/redirects release immediately.
5. **Accepted risks & carry-over**: same-origin `/phpmyadmin/<siteId>/` accepted for M2 (upgrade path: dedicated subdomain `db.<panel host>` / `pma.<panel host>`, needs extra DNS record per `BLOCKED.md` row 6); shared `hp_phpmyadmin` (`4` workers / `512 MiB`) still lets two busy sites saturate all `4` workers, and phpMyAdmin sets no DB statement timeout (`R49`, customer can re-open phpMyAdmin from Database tab to `KILL USER` slow queries); `hp_pma_net` egress not blocked (`internal: false` required for loopback bind); `UPLOAD_LIMIT=32M` / 60s Traefik `readTimeout`; customer can drop primary DB in phpMyAdmin; two active sites can still exhaust MariaDB's 150 connections; removed members/suspended orgs keep working DB passwords usable only from same-server sites; pre-M2 sites keep unescaped `wp_<hex>` grant and uncapped primary user until one-time M6 updater re-grant/cap (and primary WordPress DB password unchanged on move goes to M6 audit). Zero new npm dependencies.

---

## M3a Site Backups Decisions (2026-11-15)

Source: `docs/architecture/adr/0022-site-backups.md`.

1. **Tooling, pinned image & per-site encrypted S3 repositories (`ADR-0022`, `productionBackupRuntimeAvailable: true` on `linux-systemd`)**: run site backups via ephemeral `restic/restic:0.19.1` containers orchestrated exclusively by `apps/docker-executor` (`docker.sock` stays executor-only), writing one encrypted repository per site under `<prefix>/sites/<siteId>`. Zero new runtime/dev npm dependencies (`restic` speaks S3 natively; allowlist unchanged).
2. **Encryption key lifecycle & secret isolation**: `infra/linux/bootstrap-dedicated.sh` provisions `/etc/hosting-panel/backup.key` once (`64` lowercase hex chars without newline, mode `0440`, owner `root:hp-executor`, never overwritten on updates); `infra/linux/run-dev-docker.mjs` creates a dev key (`0o640`, `HP_BACKUP_KEY_FILE`); `infra/linux/install.sh` carries the bilingual (`IT` + `EN`) `backup.key` data-loss warning inside its 78-column closing box. Keys and S3 credentials never cross IPC in plaintext or appear in `ContainerSpec.Env`, outbox rows, audit logs, or `.env.example` (S3 secret encrypted/decrypted via `secrets-master.key` and staged into job-private `tmpfs`).
3. **Payload, `CP-01` & normalized problems**: each backup captures the site's WordPress files plus one consistent logical MariaDB dump per database of that site without restarting site containers or MariaDB (`CP-01`), mapping failures into the `17` `BACKUP_PROBLEMS` codes (`16` `BACKUP_FAILURE_CLASSES` + `site_busy`).
4. **Long-running async job model, dedicated outbox lane & migration `0009_backups.sql`**: backups run asynchronously (`start -> poll` with renewed executor lease) on a dedicated outbox lane so slow uploads cannot block site lifecycle operations. Migration `0009_backups.sql` stores global backup settings (UTC nightly schedule defaulting to `02:00 UTC`, retention `1–365` days defaulting to `14`, up to `3` retained manual backups) and per-site backup records.
5. **Retention, permissions & M3a boundaries**: panel-driven pruning (`site.backups.prune` system operation) enforces retention under the single permission `site.backups.manage` (`site.backups.create` is an operation kind, not a permission) for customer manual create/list (no cancel in M3a), while keeping up to `3` manual backups and never deleting the newest valid backup of an existing site (`0` valid backups remain only after site deletion/cleanup). Restore from panel, archive download, panel database backup, lost-server key recovery, and remaining `R60`/`R73` operational bounds are documented in `docs/architecture/adr/0022-site-backups.md` (deferred to **M3b**/**M6**); live Docker acceptance Part 5 ran on the local Docker Engine (`accept-m3-backups.mjs`, `12/12` pass, recorded in `docs/security/step-4-acceptance-report.md`), while live acceptance on the owner's dedicated server with a real S3 bucket remains pending. Zero new npm dependencies.
