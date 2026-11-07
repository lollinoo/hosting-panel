# ADR 0001 — POC v0.1 Architecture, Security Boundaries, and Dual-Mode Runtime

- **Status:** Accepted
- **Date:** 2026-11-07
- **Specification Reference:** `HCP-SPEC-001` rev. 1.0

## Context
We are bootstrapping the greenfield `hosting-panel` repository to validate the architectural core of the Coolify-based SaaS Hosting Control Panel (`HCP-SPEC-001`). The pre-existing `coolify-hosting-backend` starter mentioned in `HCP-SPEC-001` is intentionally absent; furthermore, local developer workstations may not run a Docker daemon continuously.

## Decisions
1. **Modular Monorepo (`pnpm` workspaces):**
   - `packages/contracts`: Single source of truth for `/v1` DTOs, Zod schemas, permission keys, normalized error envelopes, and operation state machines.
   - `packages/authz`: Pure, deterministic RBAC + ABAC policy engine enforcing default-deny, explicit `deny` precedence, `ResourceGrant` scoping, and last-owner protection.
   - `packages/database`: Drizzle ORM PostgreSQL schema with composite tenant ownership invariants, transactional outbox (`operations`, `operation_steps`, `outbox_events`), resource mutation locking, and dual-mode execution (`@electric-sql/pglite` embedded for zero-Docker dev/tests; `pg` pool for external PostgreSQL 18).
   - `packages/coolify-adapter`: Typed server-only Coolify v4 REST adapter with static host allowlisting, redirect blocking when sending `Authorization`, rate-limit (`429` / `Retry-After`) awareness, and strict secret/token redaction. Zero generic HTTP proxying.
   - `apps/api`: NestJS 12 + Fastify 5 `/v1` API with `jose` OIDC token verification, local Dev OIDC issuer for standalone POC execution, Outbox Worker + Reconciler (`queued -> processing -> accepted_by_provider -> reconciling -> succeeded | failed | unknown | cancelled`), and an embedded Fake Coolify v4 Lab HTTP server.
   - `apps/web`: Next.js 16 App Router (Italian UI) acting as an authenticated BFF boundary (`HttpOnly` session cookies; zero Coolify credentials or internal provider UUIDs exposed to the client).

2. **Target `/v1` Routes from Day One:**
   - Because there is no legacy starter to migrate from, the API implements `/v1/organizations/:orgId/{servers,applications,databases,domains,certificates,operations,quotas,capabilities}` directly without `/resources/:resourceId` shim endpoints.

3. **TypeScript Compatibility Gate (`HCP-SPEC-001` §11.1):**
   - Pin `typescript@6.0.3` across the workspace to guarantee full compatibility with NestJS 12 decorators and Next.js 16 build tooling on Node `24.22.0+`.

## Consequences
- Every contributor can clone the repository and run `corepack pnpm install && corepack pnpm test && corepack pnpm dev` without Docker, while production/staging environments retain standard PostgreSQL 18, Redis/BullMQ, Keycloak, and Coolify v4 network boundaries (`infra/local/docker-compose.yml`).
