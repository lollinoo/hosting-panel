# Project Operating Contract

## Operating Boundaries
- Allowed scope: Modify only files explicitly assigned in the current task contract (`.agents/brain/state.md`).
- Forbidden actions:
  - Never delete existing tests to make a suite pass.
  - Never add unverified external dependencies without explicit approval in the task contract.
  - Never expose Coolify tokens, internal `provider_id` / `coolify_uuid` selectors, or unredacted provider payloads to browser clients or logs.
  - Never implement a generic pass-through Coolify HTTP proxy (`HCP-SPEC-001` §0.2).

## Project Map
- `/apps/api`: NestJS 12 + Fastify 5 `/v1` Control Plane API, Dev OIDC Issuer (`jose`), Outbox Worker/Reconciler, and Fake Coolify v4 Lab Server
- `/apps/web`: Next.js 16 App Router UI (Italian primary language) + `HttpOnly` BFF session boundary
- `/packages/contracts`: Shared Zod schemas, `/v1` DTOs, normalized error codes, permission catalog, and operation state types
- `/packages/authz`: Default-deny RBAC + ABAC policy engine (`RolePermission`, `MembershipRole`, `ResourceGrant`, deny precedence)
- `/packages/database`: Drizzle ORM PostgreSQL schema, SQL migrations, tenant ownership invariants, and dual-mode `PGlite` / `pg` driver
- `/packages/coolify-adapter`: Typed Coolify v4 client with host allowlist, redirect blocking, rate-limit handling, and secret redaction
- `/packages/config`: Shared TypeScript and ESLint configuration
- `/infra/local`: Docker Compose topology for PostgreSQL 18, Redis, and Keycloak
- `/docs`: Architectural Decision Records (`docs/architecture/adr/`) and OpenAPI 3.1 contract (`docs/api/openapi.yaml`)
- `/.agents/brain/decisions.md`: Durable log of accepted architectural choices (ADRs)
- `/.agents/brain/state.md`: Active task contracts, atomic commit progress, and unresolved blockers

## Verification Protocol (Objective Sensors)
Before marking any code unit complete or committing to `main`, run these checks in order:
1. Linter: `corepack pnpm run lint`
2. Typecheck: `corepack pnpm run typecheck`
3. Test Suite: `corepack pnpm run test`
4. Build Check (when apps exist): `corepack pnpm run build`
5. Contract & Security Check: Verify deliverables, non-goals, and `HCP-SPEC-001` security invariants via `swarm-verifier`.

## Failure Escalation
If a test or sensor fails twice consecutively on the exact same error with zero progress:
- Stop autonomous editing immediately
- Print the exact error log
- State the proposed fix and wait for user confirmation
