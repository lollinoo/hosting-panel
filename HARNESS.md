# Project Operating Contract (`HCP-SPEC-003` — Phase 2 Dedicated Runtime)

## Operating Boundaries
- Allowed scope: Modify only files explicitly assigned in the active task contract (`.agents/brain/state.md`).
- Forbidden actions:
  - Never retain or reintroduce any external third-party orchestrator adapter, legacy POC artifact, or unapproved environment variable.
  - Never add unverified external dependencies outside the approved allowlist in `.agents/brain/state.md`.
  - Never allow `/apps/api` or `/apps/web` to access `/var/run/docker.sock` (`InaccessiblePaths=/var/run/docker.sock`); Docker Engine socket access is strictly confined to the isolated `hp-docker-executor` daemon (`ADR-010`, `AC-F2-01`).
  - Never mount `/var/run/docker.sock` inside the Data Plane ingress proxy (`hp_ingress_proxy` / Traefik v3 uses read-only Dynamic File Provider only — `ADR-014`, `TH-02`, `AC-F2-03`).
  - Never invoke `sh -c`, shell command interpolation, or unapproved OS binaries in `hp-host-agent` (`execFile` on static absolute paths and closed enums only — `AC-F2-04`).
  - Never expose raw Docker container/network/volume IDs, socket paths, host filesystem paths, ciphertexts, or plaintext secrets in public DTOs, `StackRevision` specs, `outbox_events`, `Config.Env`, or logs (`F1-008`, `F1-012`, `ADR-015`, `AC-F2-05`).
  - Never blindly replay mutating `POST` IPC calls for operations in `unknown` state (`TH-08`, `AC-F2-07`), and never let the Drift Reconciler restart or recreate running tenant containers autonomously (`TH-10`, `AC-F2-08`).
  - Never enable `Shared Hosting` (`409 SHARED_MODE_GATED`) or close `ADR-011` (`OPEN — prima di Shared`) (`AC-F1-06`, `AC-F2-10`).
  - Never claim a capability whose flag is still `false`; flags turn `true` only when the feature ships per `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md`.
  - Never enable dev OIDC or demo seeding by default (`ENABLE_DEV_OIDC` and `HP_SEED_DEMO` stay `false` outside dev launchers).

## Project Map
- `/apps/api`: NestJS 12 + Fastify 5 `/v1` Docker-Native Control Plane API, Dev OIDC `jose` issuer/verifier, signed UDS IPC clients, PostgreSQL Transactional Outbox Worker (`202 Accepted`), `unknown` read-only recovery, observe-only Drift Reconciler, write-only `AES-256-GCM` secrets endpoints, and local break-glass CLI
- `/apps/web`: Next.js 16 App Router UI (`shadcn@4.23.0` + `radix-ui@1.8.1` + Tailwind CSS v4, Italian primary language) + encrypted `HttpOnly` JWE BFF boundary across 3 authority consoles (`InfrastructureAdmin`, `HostingAdmin`, `Customer`) with live `OperationTimeline`, write-only secrets UI, host telemetry/daemon heartbeats, and truthful `runtimeBackend` capabilities
- `/apps/docker-executor`: Isolated non-root Node.js 26 + TypeScript daemon (`hp-docker-executor`), signed UDS/pipe IPC server (`ADR-013`), native Docker Engine REST (`v1.45+`) adapter with container hardening (`CapDrop: ["ALL"]`, `no-new-privileges`, `PidsLimit`, per-site isolated networks, `0700`-confined `:ro` `tmpfs` secret mounts), atomic Traefik v3 dynamic file generator (`ADR-014`), and deterministic `InMemoryDockerSimulatorAdapter`
- `/apps/host-agent`: Isolated minimal-capability Node.js 26 + TypeScript daemon (`hp-host-agent`), signed UDS/pipe IPC server (`ADR-013`), `/proc` & `statfs` host telemetry, `ALLOWLISTED_HOST_MAINTENANCE_ACTIONS`, static `nftables` posture verification via `execFile` (zero shell), and `InMemoryHostSimulatorAdapter`
- `/packages/config`: Shared TypeScript, ESLint, and platform specification metadata (`HCP-SPEC-002` / `HCP-SPEC-003`)
- `/packages/contracts`: Shared Zod DTOs, §4.1 roles, §4.2 permissions, normalized error codes, operation/drift state machines, dynamic `PlatformCapabilitiesDto` (`runtimeBackend`), signed IPC auth (`HMAC-SHA256` / `Ed25519` + anti-replay nonce cache), and forbidden public DTO key guards
- `/packages/authz`: Default-deny RBAC + ABAC policy engine (`InfrastructureAdmin`, `HostingAdmin`, `CustomerOwner`, `CustomerCollaborator`, cross-tenant `404`, deny precedence)
- `/packages/hosting-domain`: Canonical entities and invariants (`PlatformInstallation`, `Host`, `HostAllocation`, `Site`, `ServiceTemplate`, `ServiceInstance`, immutable `StackRevision`, `DockerResource`, `ObservedState` & drift)
- `/packages/policy-engine`: Dedicated/Shared placement admission rules, `dedicated -> shared` transition gate (`AC-F1-06`), declarative stack security validator (`AC-F1-04`), and quota calculators
- `/packages/executor-contracts`: Internal typed `ApprovedServiceSpec`, transient `resolvedSecrets` IPC wire schemas, `DockerExecutorPort`, and Phase 1 disabled fallback
- `/packages/host-agent-contracts`: Internal allowlisted `HostAgentPort`, maintenance/security policy enums, IPC wire schemas, and Phase 1 disabled fallback
- `/packages/database`: Drizzle ORM PostgreSQL schema, `0001_phase1_docker_native.sql` + additive `0002_phase2_runtime_and_secrets.sql` migrations (`encrypted_secrets` with tenant-bound `AES-256-GCM` AAD, `host_agent_heartbeats`, `uq_operations_active_lock`, `FOR UPDATE SKIP LOCKED` outbox), immutability triggers, and dual-mode `PGlite` / `pg` driver
- `/infra/local`: Local Docker Compose topology for PostgreSQL 18, Redis 7, and Keycloak 26 (loopback-bound)
- `/infra/systemd`: Hardened Linux `systemd` service units (`hp-web.service`, `hp-api.service`, `hp-docker-executor.service`, `hp-host-agent.service`)
- `/infra/linux`: Idempotent Ubuntu 24.04/26.04 / Debian 12/13 bootstrap script (`bootstrap-dedicated.sh`), static `nftables` profile, and live `AC-F1-08` Control Plane outage runner (`run-outage-ac-f1-08.mjs`)
- `/infra/release`: Release packaging (`build-release.mjs`, `smoke-release.mjs`); archive `dist-release/hosting-panel-<v>-linux-x64.tar.gz` + `.sha256`, published by `.github/workflows/release.yml` on `v*` tags
- `/infra/linux/{install.sh,update.sh,lib/release.sh}`: Fresh-server installer, safe updater (`hp-update`: health check + automatic rollback) and shared release library; wrappers `hp-accounts`/`hp-break-glass`
- `/docs`: Phase 1 Repository Audit, `HCP-SPEC-003` Phase 2 Normative Spec, ADRs (`0001..0015`, with `ADR-010` approved and `ADR-011` explicitly `OPEN — prima di Shared`), ER & boundary diagrams, Security/Outage Test Plan (`AC-F1-08`), and OpenAPI 3.1 contract (`docs/api/openapi.yaml`)
- `/.agents/brain/decisions.md`: Durable log of settled `/grill-me` choices and ADRs
- `/.agents/brain/state.md`: Active Bounded Contract, swarm execution waves, and verification status

## Verification Protocol (Objective Sensors)
Before marking any unit complete or merging into `main`, run these checks in order:
1. Build Check: `corepack pnpm run build`
2. Linter: `corepack pnpm run lint`
3. Typecheck: `corepack pnpm run typecheck`
4. Test Suite: `corepack pnpm run test`
5. Clean-Room & Phase 1/2 Contract Check: Verify zero legacy remnants in code/config and full compliance with `AC-F1-01`..`AC-F1-10` and `AC-F2-01`..`AC-F2-10` via independent `swarm-verifier`.

## Failure Escalation
If a test or sensor fails twice consecutively on the exact same error with zero progress:
- Stop autonomous editing immediately
- Print the exact error log
- State the proposed fix and wait for user confirmation
