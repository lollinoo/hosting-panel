# Active Bounded Operating Contract (`hosting-panel` — `HCP-SPEC-002` Phase 1)

## Current Macro Goal
Execute a complete, clean-room implementation of **`HCP-SPEC-002` Fase 1 — Hosting Control Panel Docker-native** in an isolated swarm branch (`feat/hcp-spec-002-phase-1`), eliminating 100% of Coolify/POC legacy code and building the 8-package domain/policy/DB core, the NestJS 12 `/v1` Phase 1 API, the Next.js 16 + `shadcn@4.23.0` 3-console Italian UI, and all normative Phase 1 architecture/ADR/security deliverables.

---

## Bounded Contract

### 1. Deliverables (Exact Target Scope)
- **Removed completely**:
  - `packages/coolify-adapter/**`
  - `packages/database/migrations/0001_initial_poc.sql`
  - `apps/api/src/lab/fake-coolify-server.ts` and all Coolify-coupled providers/controllers/tests
  - `docs/architecture/adr/0001-poc-architecture-and-runtime.md` and `docs/runbooks/poc-operations.md`
- **Created / Rebuilt cleanly**:
  - Workspace root: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `.env.example`, `HARNESS.md`, `README.md`
  - `packages/config/**`: `HCP-SPEC-002` metadata & shared TS config + tests
  - `packages/contracts/**`: §4.1 roles, §4.2 permissions, §6.2 error catalog, DTOs (`Host`, `HostAllocation`, `Site`, `ServiceTemplate`, `ServiceInstance`, `StackRevision`, `ResourceQuota`, `QuotaReservation`, `Operation`, `ObservedState`, `AuditEvent`), forbidden public DTO key guards, unsafe Docker input detectors + unit tests
  - `packages/authz/**`: Default-deny RBAC + ABAC policy engine (`infrastructure_admin`, `hosting_admin`, `customer_owner`, `customer_collaborator`, `HostingAdminScope`, `ResourceGrant`, cross-tenant `404`, deny precedence, commercial suspension guard, last-owner guard) + unit tests (`AC-F1-02`, `AC-F1-03`)
  - `packages/hosting-domain/**`: Entities, immutable `StackRevision` builder/hasher, `Site` multi-service aggregate, `DockerResource` rebinding (`AC-F1-05`), `Desired` vs `Observed` drift evaluator (`drifted`/`unknown`) + unit tests (`F1-004`, `F1-005`, `AC-F1-05`)
  - `packages/policy-engine/**`: Dedicated single-customer-org occupancy admission (`AC-F1-01`), `dedicated -> shared` direct toggle denial (`AC-F1-06`), template & stack security policy validator rejecting `privileged`/`hostPath`/`docker.sock`/host namespaces/raw flags/plaintext secrets (`AC-F1-04`, `F1-012`), quota admission calculator + unit tests
  - `packages/executor-contracts/**`: Typed `ApprovedServiceSpec`, `DockerExecutorPort`, and `Phase1DisabledDockerExecutor` (`NOT_SUPPORTED`, zero daemon access) + unit tests
  - `packages/host-agent-contracts/**`: Allowlisted `HostAgentPort` and `Phase1DisabledHostAgent` (`NOT_SUPPORTED`, zero shell access) + unit tests
  - `packages/database/**`: Drizzle schema, `migrations/0001_phase1_docker_native.sql`, SQL composite ownership FKs, immutability triggers on `audit_events` and `stack_revisions`, transactional `allocateHostTransactional` (`AC-F1-01` under concurrency), transactional `reserveQuotaTransactional` (`AC-F1-07` under concurrency), transactional outbox/idempotency/locks, `seedPhase1Dataset`, dual-mode `PGlite`/`pg` client + integration tests (`AC-F1-01`, `AC-F1-05`, `AC-F1-07`, `AC-F1-09`)
  - `apps/api/**`: NestJS 12 + Fastify 5 `/v1` API (`Health`, `Auth/Dev OIDC`, `Me`, `Hosts` & `HostAllocations`, `ServiceTemplates`, `Organizations`, `Sites`, `ServiceInstances` & `StackRevisions`, `Quotas` & `Reservations`, `Operations`, `Admin Audit`) + integration test suite covering `AC-F1-01`..`AC-F1-10`
  - `apps/web/**`: Next.js 16 App Router + `shadcn@4.23.0` (`radix-ui@1.8.1`, Tailwind CSS v4) Italian UI across `InfrastructureAdmin` (`/admin/*`), `HostingAdmin` (`/hosting/*`), and `Customer` (`/o/[orgSlug]/*`), encrypted `HttpOnly` JWE BFF (`hp_session`) + CSRF + perimeter DTO sanitizer + BFF integration tests
  - `infra/local/docker-compose.yml` & `.github/workflows/ci.yml`: Clean local Postgres 18 / Redis 7 / Keycloak 26 topology and CI verification
  - `docs/**`:
    - `docs/architecture/phase-1-repository-audit.md`
    - `docs/architecture/adr/0001-dual-hosting-modes.md` .. `0012-untrusted-workloads-shared-risk.md` (`ADR-010` and `ADR-011` kept `OPEN`)
    - `docs/architecture/diagrams/domain-er-and-boundaries.md`
    - `docs/architecture/phase-2-open-decisions.md`
    - `docs/security/phase-1-test-and-outage-plan.md` (`AC-F1-08`)
    - `docs/api/openapi.yaml` (OpenAPI 3.1 aligned with all `/v1` Phase 1 endpoints)

### 2. Constraints & Approved Dependency Allowlist
- **Existing Verified Workspace Dependencies**:
  - Build/Test/Lint: `typescript@6.0.3`, `vitest@5.1.0`, `eslint@10.14.0`, `@eslint/js`, `typescript-eslint@8.72.1`, `@types/node@24.x`
  - Contracts/Auth: `zod@4.6.7`, `jose@6.2.15`
  - Database: `drizzle-orm@0.45.4`, `drizzle-kit@0.31.11`, `@electric-sql/pglite@0.5.15`, `pg@8.23.1`, `@types/pg@8.23.1`
  - API: `@nestjs/common@12.4.0`, `@nestjs/core@12.4.0`, `@nestjs/platform-fastify@12.4.0`, `fastify@5.12.8`, `reflect-metadata@0.2.2`, `rxjs@7.8.2`, `bullmq@6.7.1`
  - Web Base: `next@16.4.5`, `react@19.3.1`, `react-dom@19.3.1`, `@types/react@19.3.0`, `@types/react-dom@19.3.0`, `@tanstack/react-query@5.107.1`, `lucide-react@1.70.0`, `tailwindcss@4.3.5`, `@tailwindcss/postcss@4.3.5`, `postcss@8.5.32`
- **Newly Approved `shadcn` v4 Dependencies (`Q7`, verified 2026-11-07)**:
  - `shadcn@4.23.0` (devDependency), `radix-ui@1.8.1`, `class-variance-authority@0.7.1`, `clsx@2.1.1`, `tailwind-merge@3.7.0`, `tw-animate-css@1.4.0`
- **Strict Architectural Constraints**:
  - Zero Coolify dependencies, types, env vars, or endpoints anywhere in code/config.
  - All Phase 1 edits remain in isolated worktrees/branches (`feat/hcp-spec-002-phase-1`) until user sign-off (`"go"`).

### 3. Non-Goals (`HCP-SPEC-002` §1.3)
- Do NOT connect to `/var/run/docker.sock`, run Docker CLI/daemon commands, or implement an active Linux root agent.
- Do NOT implement live reverse proxy / Traefik routing, DNS zone mutations, ACME certificate issuance, SFTP servers, file managers, or production DB backup/restore engines.
- Do NOT enable `shared` hosting mode or silently resolve `OPEN` decisions (`ADR-010`, `ADR-011`).

### 4. Acceptance Criteria (Mechanical Sensors + Adversarial Gate)
- `corepack pnpm run build` -> exit code `0`
- `corepack pnpm run lint` -> exit code `0`
- `corepack pnpm run typecheck` -> exit code `0`
- `corepack pnpm run test` -> exit code `0` (covering `AC-F1-01`..`AC-F1-10` across unit, DB concurrency/migration, API integration, and BFF integration suites)
- Case-insensitive repository grep confirms zero residual Coolify tokens/identifiers in `packages/`, `apps/`, `infra/`, `.env.example`, `HARNESS.md`, `README.md`, and `docs/api/openapi.yaml`.
- Independent `swarm-verifier` sign-off on all `HCP-SPEC-002` §7 & §11 Definition of Done items.

---

## Execution Progress
- [x] Step 0: Parallel repository audit (`research` subagents) & baseline sensor verification
- [x] `/grill-me` Round 1 & Round 2: All architectural forks (`Q1`..`Q8`) settled with user
- [ ] Wave 1 (Parallel Isolated Worktrees):
  - [ ] Unit A (`swarm-editor`): Workspace deps (`shadcn@4.23.0`), removal of `coolify-adapter`, and clean implementation of all 8 `packages/*` + tests
  - [ ] Unit D (`swarm-editor`): Normative `docs/*` (Step 0 audit, `ADR-001..012`, ER/boundary diagrams, `AC-F1-08` outage/security plan, Phase 2 open decisions), `.env.example`, `infra/local/docker-compose.yml`, `README.md`
- [ ] Wave 2 (Parallel Isolated Worktrees on top of Wave 1):
  - [ ] Unit B (`swarm-editor`): Clean `apps/api` (`/v1` Phase 1 Control Plane) + `docs/api/openapi.yaml` + `AC-F1-01..10` integration tests
  - [ ] Unit C (`swarm-editor`): Clean `apps/web` (`shadcn@4.23.0` Italian 3-console UI + JWE BFF) + BFF integration tests
- [ ] Pass 2 Verification (`swarm-verifier`): Full mechanical sensor run + skeptical adversarial review on `feat/hcp-spec-002-phase-1`
- [ ] Sign-Off Gate: Present summary diff + Step 6 Final Report and await user `"go"` before merging into `main`
