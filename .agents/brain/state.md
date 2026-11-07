# Active Bounded Operating Contract (`hosting-panel` — `HCP-SPEC-003` Phase 2)

## Current Macro Goal
Implement **`HCP-SPEC-003` Fase 2 — Runtime Operativo `Dedicated`, Split Agents (`hp-docker-executor` + `hp-host-agent`), IPC Firmato, Outbox/Reconciler, Segreti `AES-256-GCM` su `tmpfs`, Hardening `systemd` ed Esecuzione Reale `AC-F1-08`** (`docs/architecture/hcp-spec-003-phase-2.md`) on the dedicated Linux environment.

- **Phase 1 Baseline Status**: `HCP-SPEC-002` Phase 1 completed, verified (`113/113` tests green), and merged on `main` (`31b3753`).
- **Phase 2 Design Status**: `/grill-me` `Q1`–`Q9` settled and persisted in `docs/architecture/hcp-spec-003-phase-2.md` and `.agents/brain/decisions.md`. Ready for Swarm implementation waves on Linux.

---

## Approved Dependency Allowlist
- **Build/Test/Lint**: `typescript@6.0.3`, `vitest@5.1.0`, `eslint@10.14.0`, `@eslint/js@10.0.1`, `typescript-eslint@8.72.1`, `@types/node@24.19.2`
- **Contracts/Auth**: `zod@4.6.7`, `jose@6.2.15`
- **Database**: `drizzle-orm@0.45.4`, `drizzle-kit@0.31.11`, `@electric-sql/pglite@0.5.15`, `pg@8.23.1`, `@types/pg@8.23.1`
- **API (`apps/api`)**: `@nestjs/common@12.4.0`, `@nestjs/core@12.4.0`, `@nestjs/platform-fastify@12.4.0`, `fastify@5.12.8`, `reflect-metadata@0.2.2`, `rxjs@7.8.2`
- **Web (`apps/web`)**: `next@16.4.5`, `react@19.3.1`, `react-dom@19.3.1`, `@types/react@19.3.0`, `@types/react-dom@19.3.0`, `@tanstack/react-query@5.107.1`, `lucide-react@1.70.0`, `tailwindcss@4.3.5`, `@tailwindcss/postcss@4.3.5`, `postcss@8.5.32`, `shadcn@4.23.0`, `radix-ui@1.8.1`, `class-variance-authority@0.7.1`, `clsx@2.1.1`, `tailwind-merge@3.7.0`, `tw-animate-css@1.4.0`
- **Phase 2 Daemons (`apps/docker-executor`, `apps/host-agent`)**: Pure Node.js 24 built-ins (`node:http`, `node:net`, `node:crypto`, `node:fs/promises`, `node:child_process`) + workspace packages + `zod@4.6.7` (**zero new external npm packages required**).

---

## Bounded Contract Deliverables & Planned Swarm Waves

- [x] **Step 0**: `/grill-me` (`Q1`–`Q9`) completed & `docs/architecture/hcp-spec-003-phase-2.md` persisted on `main`
- [x] **Wave 1 (Core Contracts, IPC Signing, Secrets & DB Migration `0002`)**:
  - Update `packages/contracts`, `packages/executor-contracts`, `packages/host-agent-contracts` (dynamic `PlatformCapabilitiesDto`, IPC envelope/signing utilities, `resolvedSecrets` transient mount contract, `nftables` security policy enum).
  - Add `packages/database/migrations/0002_phase2_runtime_and_secrets.sql` + Drizzle tables/repositories (`encrypted_secrets` with `AES-256-GCM`, `host_agent_heartbeats`, `FOR UPDATE SKIP LOCKED` Outbox claim/complete, `uq_operations_active_lock`).
- [x] **Wave 2 (Parallel Isolated Daemons & Infra)**:
  - **Unit 2A (`apps/docker-executor`)**: Signed UDS/pipe HTTP server, native Docker Engine API (`v1.45+`) client with container hardening (`CapDrop: ["ALL"]`, `no-new-privileges`, `PidsLimit`, per-site bridge networks, `:ro` `tmpfs` `0400` secret mounts), atomic Traefik v3 dynamic file-provider generator (zero `docker.sock` in proxy), and `InMemoryDockerSimulatorAdapter` + contract/adversarial tests.
  - **Unit 2B (`apps/host-agent` + `infra/systemd/` + `infra/linux/`)**: Signed UDS/pipe HTTP server, `/proc` & `statfs` telemetry, `ALLOWLISTED_HOST_MAINTENANCE_ACTIONS` and static `nftables` verification via `execFile` (zero shell), `InMemoryHostSimulatorAdapter`, `systemd` hardened units, `bootstrap-dedicated.sh`, and `run-outage-ac-f1-08.mjs` + tests.
- [x] **Wave 3 (Control Plane API, Web Consoles & Normative ADRs)**:
  - **Unit 3A (`apps/api` + `docs/api/openapi.yaml`)**: Signed IPC clients, PostgreSQL Outbox Worker, `unknown` state read-only recovery (`TH-08`), observe-only Drift Reconciler (`TH-10`), encrypted secrets CRUD (write-only), `202 Accepted` mutations (`lifecycle`, `maintenance`, `security`), break-glass CLI, and `AC-F2-01..10` integration tests.
  - **Unit 3B (`apps/web` + `docs/architecture/adr/*` + `HARNESS.md` + `README.md`)**: BFF routes & `shadcn@4.23.0` UI unlock (`202` lifecycle + `OperationTimeline`, write-only secrets, `in_sync`/`drifted` badges, `InfrastructureAdmin` telemetry/daemon status/maintenance/security, truthful `runtimeBackend` banner), close `ADR-010`, add `ADR-013..015`.
- [x] **Wave 4 (Live Linux Execution of `AC-F1-08` & Two-Pass Adversarial Verification)**:
  - Run `build`, `lint`, `typecheck`, `test` (`0` exit code — `15/15` suites, `167/167` tests).
  - Execute `infra/linux/run-outage-ac-f1-08.mjs` against real Docker Engine `29.9.3` + PostgreSQL `18.1` + Traefik `v3.3` + tenant site containers on the dedicated Linux host and record verified metrics (`1521/1521` `200 OK`, `0` restarts, `2.81s` `in_sync` convergence) in `docs/security/ac-f1-08-execution-report.md`.
  - Independent `swarm-verifier` Pass 2 adversarial findings (`F-01`..`F-05`) remediated & regression-tested (`167/167` green); awaiting final verifier sign-off + user `"go"` to merge `feat/hcp-spec-003-phase-2` into `main`.
