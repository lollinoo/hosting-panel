# Architectural Decisions Log (`hosting-panel` — `HCP-SPEC-002` Phase 1)

Settled architectural and product boundary decisions aligned via `/grill-me` with the user on 2026-11-07 for `HCP-SPEC-002` rev. 1.0 («Hosting Control Panel Docker-native — Fase 1»).

---

## Settled `/grill-me` Design Decisions (2026-11-07)

1. **Zero Coolify / Clean-Room Replacement (`Q1`, `Q3`, `Q5`)**:
   - Eliminate all Coolify references, `packages/coolify-adapter`, `FakeCoolifyLabServer`, `COOLIFY_*` environment variables, and `0001_initial_poc.sql` legacy tables (`provider_instances`, `provider_connections`, `server_allocations`, `hosting_resources`).
   - Do not retain legacy compatibility shims or `@deprecated` POC code; recreate the monorepo cleanly around the canonical `HCP-SPEC-002` domain model with a single clean SQL baseline (`0001_phase1_docker_native.sql`).
   - Retain dual-mode local persistence (`@electric-sql/pglite` embedded + `pg` external pool) and local `jose` OIDC dev issuer so deterministic tests and local UI workflows run without requiring a live Linux Docker daemon.

2. **Strict Separation of Authority Roles (`Q2` — `HCP-SPEC-002` §4.1–4.2, `AC-F1-03`)**:
   - Define four explicit role tiers:
     - `infrastructure_admin`: Host lifecycle, Linux maintenance, security posture, Docker Engine status, allocations, operations & audit read (`host.*`, `allocation.*`, `template.read`, `quota.read`, `operation.read`, `audit.read`). No implicit unrestricted customer secret/data access without policy/audit.
     - `hosting_admin`: Service templates, allocations, tenant sites/services/quotas within installation/assigned scopes (`host.read`, `host.metrics.read`, `host.docker.read`, `allocation.*`, `template.*`, `site.*`, `service.*`, `quota.*`, `operation.read`, `audit.read`), **strictly denied** `host.maintenance.*`, `host.security.manage`, and `host.docker.engine.manage` (`AC-F1-03`).
     - `customer_owner`: Organization-scoped management of own sites, services, stack revisions, quotas read, operations read, and organization members (`AC-F1-02`, `AC-F1-04`).
     - `customer_collaborator`: Least-privilege collaborator governed by explicit `ResourceGrant` / scoped bindings (ABAC + deny precedence).

3. **Explicit 8-Package Monorepo Boundaries (`Q6` — `HCP-SPEC-002` §9)**:
   - `@hosting-panel/config`, `@hosting-panel/contracts`, `@hosting-panel/authz`, `@hosting-panel/hosting-domain`, `@hosting-panel/policy-engine`, `@hosting-panel/executor-contracts`, `@hosting-panel/host-agent-contracts`, `@hosting-panel/database`.
   - `executor-contracts` and `host-agent-contracts` expose strictly typed internal interfaces (`ApprovedServiceSpec`, `DockerExecutorPort`, `HostAgentPort`) with Phase 1 disabled implementations returning `NOT_SUPPORTED` (zero `/var/run/docker.sock` or shell calls).

4. **Phase 1 API Surface & New `shadcn@4.23.0` Italian UI (`Q4`, `Q7`, `Q8` — `AC-F1-10`)**:
   - Approved UI dependencies added to workspace: `shadcn@4.23.0`, `radix-ui@1.8.1`, `class-variance-authority@0.7.1`, `clsx@2.1.1`, `tailwind-merge@3.7.0`, `tw-animate-css@1.4.0`.
   - Build three distinct authority consoles (`Infrastructure Admin`, `Hosting Admin`, `Customer Workspace`) with `shadcn` components over the encrypted `HttpOnly` JWE BFF boundary, strictly honoring `AC-F1-10` (clearly marking `Shared Hosting`, `Docker Executor`, `Host Agent`, `ACME/TLS`, `SFTP`, and production backups as Phase 2 / non-active in Phase 1).
   - Deliver all normative `HCP-SPEC-002` §8 & §10 documents, keeping `ADR-010` (agent/executor process topology & IPC) and `ADR-011` (shared storage & disk quota mechanism) explicitly `OPEN`.

---

## Canonical ADR Register (`HCP-SPEC-002` §10)
- **ADR-001**: Dual Hosting Mode (`Dedicated` & `Shared`) in a Unified Domain — **APPROVED**
- **ADR-002**: `Dedicated` Standalone VPS as First Release (MVP) — **APPROVED**
- **ADR-003**: Local Standalone Appliance Baseline without Mandatory Central SaaS — **BASELINE**
- **ADR-004**: Single Multi-Tenant Canonical Domain (`Host -> HostAllocation -> Site -> ServiceInstance -> StackRevision`) — **BASELINE**
- **ADR-005**: `Docker Executor` as Isolated Logical Boundary — **LOGICAL BASELINE**
- **ADR-006**: `Host Agent` as Isolated Privileged Boundary — **LOGICAL BASELINE**
- **ADR-007**: Controlled `Shared` Hosting Behind Mandatory Security Gate — **BASELINE**
- **ADR-008**: Optional Multi-Host Management Hub with Single-Writer Fencing — **OPTIONAL FUTURE**
- **ADR-009**: Immutable Declarative `StackRevision` & Desired vs Observed Drift Model — **BASELINE**
- **ADR-010**: Concrete Process Topology & IPC for `Docker Executor` / `Host Agent` — **OPEN (Phase 2)**
- **ADR-011**: Filesystem & Volume Disk Quota Enforcement for `Shared` Hosting — **OPEN (Before Shared)**
- **ADR-012**: Threat Model Constraint on Untrusted Workloads (WordPress Plugins / Custom Code) in Shared Hosting — **CONSTRAINT**
