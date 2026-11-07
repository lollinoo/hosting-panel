# Active Bounded Operating Contract (`hosting-panel` — `HCP-SPEC-002` Phase 1)

## Current Macro Goal
Completed clean-room implementation of **`HCP-SPEC-002` Fase 1 — Hosting Control Panel Docker-native** merged onto `main`, delivering the 8-package domain/policy/DB core, the NestJS 12 `/v1` Phase 1 API, the Next.js 16 + `shadcn@4.23.0` 3-console Italian UI, and all normative Phase 1 architecture/ADR/security deliverables.

---

## Approved Dependency Allowlist (Verified 2026-11-07)
- **Build/Test/Lint**: `typescript@6.0.3`, `vitest@5.1.0`, `eslint@10.14.0`, `@eslint/js@10.0.1`, `typescript-eslint@8.72.1`, `@types/node@24.19.2`
- **Contracts/Auth**: `zod@4.6.7`, `jose@6.2.15`
- **Database**: `drizzle-orm@0.45.4`, `drizzle-kit@0.31.11`, `@electric-sql/pglite@0.5.15`, `pg@8.23.1`, `@types/pg@8.23.1`
- **API (`apps/api`)**: `@nestjs/common@12.4.0`, `@nestjs/core@12.4.0`, `@nestjs/platform-fastify@12.4.0`, `fastify@5.12.8`, `reflect-metadata@0.2.2`, `rxjs@7.8.2`
- **Web (`apps/web`)**: `next@16.4.5`, `react@19.3.1`, `react-dom@19.3.1`, `@types/react@19.3.0`, `@types/react-dom@19.3.0`, `@tanstack/react-query@5.107.1`, `lucide-react@1.70.0`, `tailwindcss@4.3.5`, `@tailwindcss/postcss@4.3.5`, `postcss@8.5.32`, `shadcn@4.23.0`, `radix-ui@1.8.1`, `class-variance-authority@0.7.1`, `clsx@2.1.1`, `tailwind-merge@3.7.0`, `tw-animate-css@1.4.0`

---

## Execution & Verification Progress
- [x] Step 0: Parallel repository audit (`research` subagents) & baseline sensor verification
- [x] `/grill-me` Round 1 & Round 2: All architectural forks (`Q1`..`Q8`) settled with user
- [x] Wave 1 (Parallel Isolated Worktrees):
  - [x] Unit A (`swarm-editor`, `swarm/wave1-packages` @ `33bfe8f`): 8 clean-room `packages/*` + `76/76` tests green
  - [x] Unit D (`swarm-editor`, `swarm/wave1-docs` @ `a65e89e`): Normative `docs/*` (`ADR-001..012`, ER/boundary diagrams, `AC-F1-08` outage plan, Phase 2 open decisions), `.env.example`, `infra/local/docker-compose.yml`, `README.md`
- [x] Wave 2 (Parallel Isolated Worktrees on top of Wave 1):
  - [x] Unit B (`swarm-editor`, `swarm/wave2-api` @ `27a5749`): Clean `apps/api` (`/v1` Phase 1 Control Plane) + `docs/api/openapi.yaml` + `31/31` `AC-F1-01..10` integration tests green
  - [x] Unit C (`swarm-editor`, `swarm/wave2-web` @ `fdc41c5`): Clean `apps/web` (`shadcn@4.23.0` Italian 3-console UI + JWE BFF) + `6/6` BFF integration tests & Next.js 16 production build green
- [x] Pass 2 Verification (`swarm-verifier` on `feat/hcp-spec-002-phase-1` @ `0aec98f`): **VERDICT: PASS** (`build: 0`, `lint: 0`, `typecheck: 0`, `test: 0` with `113/113` tests across 10 suites, 100% API<->BFF<->OpenAPI route alignment)
- [x] Sign-Off Gate: Approved by user (`"go"`); merged onto `main` and verified green.
