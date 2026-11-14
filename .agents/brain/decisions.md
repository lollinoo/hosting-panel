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
   - Author the normative specification `docs/architecture/hcp-spec-003-phase-2.md`, close `ADR-010`, and implement the full Phase 2 runtime inside the monorepo (`apps/docker-executor`, `apps/host-agent`, authenticated IPC, Outbox/Reconciler, minimal `Dedicated` ingress proxy, `systemd` units, Linux bootstrap/break-glass scripts, and `AC-F1-08` outage harness), while keeping `Shared Hosting`, `ADR-011`, `ACME/TLS`, `SFTP`, and production `Backups` strictly closed/gated.

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
   - Evolve `PlatformCapabilitiesDto` to expose `phase: "phase-1" | "phase-2"` and `runtimeBackend: "linux-systemd" | "local-simulator" | "disabled"`, keeping `sharedHostingEnabled`, `acmeTlsRuntimeAvailable`, `sftpAvailable`, and `productionBackupRuntimeAvailable` strictly `false`.
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
