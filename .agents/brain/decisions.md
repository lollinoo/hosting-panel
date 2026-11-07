# Architectural Decisions Log (`hosting-panel`)

Settled architectural and product boundary decisions derived from `HCP-SPEC-001` (rev 1.0) and user alignment on 2026-11-07.

---

## ADR-001: Vertical Slice POC v0.1 Scope (Stage 0 + MVP Core)
- **Decision**: Deliver a complete end-to-end vertical slice covering `PLAT-00`, `AUTH-00`, `AUTH-01`, `COOLF-00`, `OPS-00`, `OBS-00`, and the Italian Next.js 16 MVP UI (`Login`, `OrgSwitcher`, `Dashboard Overview`, `Servers`, `Applications` + `Application Detail` with `202 Accepted` Deploy/Restart + live `OperationTimeline`, read-only `Databases`, `Domains & TLS`, `Operations`, and `Admin Providers & Audit`).
- **Rationale**: Absence of the legacy `coolify-hosting-backend` starter allows adopting target `/v1/organizations/:orgId/...` routes cleanly from commit 1 without legacy `/resources/:resourceId` debt.
- **Non-Goals (Deferred to R1/R2)**: Self-service cloud VPS provisioning, self-service app/DB creation from private Git, destructive S3 backup/restore execution, live Stripe/billing integration, reseller/white-label portal, email hosting.

## ADR-002: Dual-Mode Local Infrastructure (Zero-Docker Embedded + Docker Compose Ready)
- **Decision**: Support embedded `@electric-sql/pglite` (running the exact PostgreSQL Drizzle schema and SQL constraints), an in-process Transactional Outbox Worker/Reconciler, a local `jose`-backed OIDC issuer, and a Fake Coolify v4 Lab HTTP Server for zero-Docker local execution and deterministic Vitest suites, alongside `pg`/`bullmq`-compatible abstractions and `infra/local/docker-compose.yml` for external PostgreSQL 18 + Redis + Keycloak environments.
- **Rationale**: Docker is not installed on the local development host; dual-mode guarantees 100% runnable integration tests and interactive POC demo out of the box without sacrificing PostgreSQL fidelity.

## ADR-003: Toolchain & Dependency Pinning
- **Decision**: Use `pnpm` (`12.18.0` via `corepack pnpm`) workspaces, Node `24.22.0` (`>=24`), `typescript@6.0.3` (ensuring full compatibility with NestJS 12 decorator metadata per `HCP-SPEC-001` §11.1 gate), `@nestjs/core@12.4.0` + `@nestjs/platform-fastify@12.4.0` (`fastify@5.12.8`), `next@16.4.5` + `react@19.3.1`, `drizzle-orm@0.45.4`, `zod@4.6.7`, `jose@6.2.15`, and `vitest@5.1.0`.

## ADR-004: Non-Negotiable Security & Operational Invariants (`HCP-SPEC-001` §0.2)
1. **Default-Deny & Anti-BOLA**: Every endpoint resolves `organization_id` membership, RBAC+ABAC policy (explicit `deny` overrides `allow`), and internal resource ownership *before* touching Coolify. Cross-tenant resource lookups return `404` (`AC-001`).
2. **BFF Session & Zero Client Secrets**: Browser holds only an `HttpOnly` session cookie on Next.js; browser never receives Coolify tokens, provider URLs, or internal `provider_id` / `coolify_uuid` values.
3. **Typed Coolify Adapter Only**: Static admin host allowlist, HTTPS enforcement (with explicit localhost lab override only in test/dev), redirect rejection with `Authorization`, finite timeouts, `429 Retry-After` handling, and recursive secret/token redaction (`AC-008`, `AC-009`, `AC-017`).
4. **Transactional Outbox & 8-State Operations**: Mutations persist `operations` + `operation_steps` + `outbox_events` + resource lock + `Idempotency-Key` (`request_hash` mismatch -> `409`, `AC-005`/`AC-006`) atomically, returning `202 Accepted` and reconciling `queued -> processing -> accepted_by_provider -> reconciling -> succeeded | failed | unknown | cancelled` (`AC-007`, `AC-010`).
