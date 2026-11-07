# Active Task Contracts & Progress (`hosting-panel`)

## Current Macro Goal
Build POC v0.1 of the Coolify-based Multi-Tenant Hosting Control Panel (`HCP-SPEC-001`) on branch `main` using verified atomic Conventional Commits.

## Approved Dependency Allowlist (Exact Registry Versions Verified 2026-11-07)
- Workspace & Build: `typescript@6.0.3`, `vitest@5.1.0`, `eslint@10.14.0`, `@eslint/js`, `typescript-eslint@8.72.1`, `@types/node@24.x`
- Shared Contracts & Auth: `zod@4.6.7`, `jose@6.2.15`
- Database: `drizzle-orm@0.45.4`, `drizzle-kit@0.31.11`, `@electric-sql/pglite@0.5.15`, `pg@8.23.1`, `@types/pg@8.23.1`
- Backend (`apps/api`): `@nestjs/common@12.4.0`, `@nestjs/core@12.4.0`, `@nestjs/platform-fastify@12.4.0`, `fastify@5.12.8`, `reflect-metadata@0.2.2`, `rxjs@7.8.2`, `bullmq@6.7.1`
- Frontend (`apps/web`): `next@16.4.5`, `react@19.3.1`, `react-dom@19.3.1`, `@types/react@19.3.0`, `@types/react-dom@19.3.0`, `@tanstack/react-query@5.107.1`, `lucide-react@1.70.0`, `tailwindcss@4.3.5`, `@tailwindcss/postcss@4.3.5`, `postcss@8.5.32`

## Atomic Commit Plan & Status
- [x] Branch renamed `mainBranch` -> `main`
- [ ] **Unit 1**: `chore: initialize harness, project brain, and foundational ADRs`
  - Deliverables: `HARNESS.md`, `.agents/brain/decisions.md`, `.agents/brain/state.md`, `.gitignore`, `.editorconfig`, `.node-version`, `docs/architecture/adr/0001-poc-architecture-and-runtime.md`
- [ ] **Unit 2**: `build: configure monorepo workspace and shared TypeScript tooling`
  - Deliverables: `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.workspace.ts` / root scripts, `packages/config/*`
- [ ] **Unit 3**: `feat(contracts): define v1 API schemas, permissions, and error codes`
  - Deliverables: `packages/contracts/*` + unit tests
- [ ] **Unit 4**: `feat(authz): implement default-deny RBAC/ABAC policy engine`
  - Deliverables: `packages/authz/*` + unit tests (roles, grants, deny precedence, cross-tenant deny)
- [ ] **Unit 5**: `feat(database): add Drizzle PostgreSQL schema, migrations, and PGlite driver`
  - Deliverables: `packages/database/*` + SQL migration + composite tenant ownership constraints + seed + transactional outbox/lock integration tests
- [ ] **Unit 6**: `feat(coolify-adapter): implement typed Coolify v4 client with secret redaction`
  - Deliverables: `packages/coolify-adapter/*` + §7.5 contract test suite (`200`, `401`, `403`, `404`, `409`, `429 Retry-After`, redirect block, host allowlist, secret redaction)
- [ ] **Unit 7**: `feat(api): implement v1 control-plane API, outbox worker, and fake Coolify lab`
  - Deliverables: `apps/api/*`, `docs/api/openapi.yaml`, Fake Coolify v4 Lab server, OIDC `jose` issuer/verifier, Outbox worker & reconciler, integration tests for `AC-001`..`AC-011`, `AC-017`, `AC-022`
- [ ] **Unit 8**: `feat(web): build Next.js 16 BFF session layer and Italian MVP control panel`
  - Deliverables: `apps/web/*` (`HttpOnly` BFF cookie/proxy allowlist, Italian UI screens: Login, Choose Org, Overview, Servers, Applications, Application Detail + Deploy/Restart + Timeline, Databases, Domains/TLS, Operations, Admin) + tests & production build check
- [ ] **Unit 9**: `chore(infra): add local Docker Compose topology, CI workflow, and documentation`
  - Deliverables: `infra/local/docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml`, `README.md`
