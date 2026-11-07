# Project Operating Contract (`HCP-SPEC-002` — Phase 1)

## Operating Boundaries
- Allowed scope: Modify only files explicitly assigned in the active task contract (`.agents/brain/state.md`).
- Forbidden actions:
  - Never retain or reintroduce any Coolify reference, adapter, environment variable, or legacy `HCP-SPEC-001` POC artifact.
  - Never add unverified external dependencies outside the approved allowlist in `.agents/brain/state.md`.
  - Never implement live Docker Engine socket execution (`/var/run/docker.sock`), generic `POST /docker/*` endpoints, or arbitrary Linux root/shell execution in Phase 1 (`HCP-SPEC-002` §1.3, §5.2).
  - Never expose raw Docker container/network/volume IDs, host filesystem paths, or secrets in public DTOs, `StackRevision` specs, or logs (`F1-008`, `F1-012`).
  - Never enable Shared Hosting in MVP or permit direct `dedicated -> shared` field toggles (`AC-F1-06`).
  - Never claim in UI or documentation that `Docker Executor`, `Host Agent`, `Shared Hosting`, `ACME/TLS`, `SFTP`, or production backups are active runtime features in Phase 1 (`AC-F1-10`).

## Project Map
- `/apps/api`: NestJS 12 + Fastify 5 `/v1` Docker-Native Control Plane API (Phase 1 metadata, policy, transactional placement/quotas, Dev OIDC `jose` issuer/verifier)
- `/apps/web`: Next.js 16 App Router UI (`shadcn@4.23.0` + `radix-ui@1.8.1` + Tailwind CSS v4, Italian primary language) + encrypted `HttpOnly` JWE BFF boundary across 3 authority consoles (`InfrastructureAdmin`, `HostingAdmin`, `Customer`)
- `/packages/config`: Shared TypeScript, ESLint, and platform specification metadata (`HCP-SPEC-002`)
- `/packages/contracts`: Shared Zod DTOs, §4.1 roles, §4.2 permissions, normalized error codes, operation/drift state types, and forbidden public DTO key guards
- `/packages/authz`: Default-deny RBAC + ABAC policy engine (`InfrastructureAdmin`, `HostingAdmin`, `CustomerOwner`, `CustomerCollaborator`, cross-tenant `404`, deny precedence)
- `/packages/hosting-domain`: Canonical entities and invariants (`PlatformInstallation`, `Host`, `HostAllocation`, `Site`, `ServiceTemplate`, `ServiceInstance`, immutable `StackRevision`, `DockerResource`, `ObservedState` & drift)
- `/packages/policy-engine`: Dedicated/Shared placement admission rules, `dedicated -> shared` transition gate, declarative stack security validator (`AC-F1-04`), and quota calculators
- `/packages/executor-contracts`: Internal typed `ApprovedServiceSpec` and `DockerExecutorPort` contracts (Phase 1 stub returning `NOT_SUPPORTED`; zero daemon access)
- `/packages/host-agent-contracts`: Internal allowlisted `HostAgentPort` contracts (Phase 1 stub returning `NOT_SUPPORTED`; zero shell access)
- `/packages/database`: Drizzle ORM PostgreSQL schema, `0001_phase1_docker_native.sql` migration, SQL composite ownership constraints, immutability triggers (`audit_events`, `stack_revisions`), transactional placement & quota reservations, and dual-mode `PGlite` / `pg` driver
- `/infra/local`: Local Docker Compose topology for PostgreSQL 18, Redis 7, and Keycloak 26 (loopback-bound)
- `/docs`: Phase 1 Repository Audit, ADRs (`0001..0012`), ER & boundary diagrams, Phase 2 Open Decisions, Security/Outage Test Plan (`AC-F1-08`), and OpenAPI 3.1 contract (`docs/api/openapi.yaml`)
- `/.agents/brain/decisions.md`: Durable log of settled `/grill-me` choices and ADRs
- `/.agents/brain/state.md`: Active Bounded Contract, swarm execution waves, and verification status

## Verification Protocol (Objective Sensors)
Before marking any unit complete or merging into `main`, run these checks in order:
1. Build Check: `corepack pnpm run build`
2. Linter: `corepack pnpm run lint`
3. Typecheck: `corepack pnpm run typecheck`
4. Test Suite: `corepack pnpm run test`
5. Zero-Coolify & Phase 1 Contract Check: Verify zero Coolify remnants in code/config and full compliance with `AC-F1-01`..`AC-F1-10` via independent `swarm-verifier`.

## Failure Escalation
If a test or sensor fails twice consecutively on the exact same error with zero progress:
- Stop autonomous editing immediately
- Print the exact error log
- State the proposed fix and wait for user confirmation
