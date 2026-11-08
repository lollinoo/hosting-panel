# Step 1a — Real Accounts, Login, 2FA, IT/EN and Customer Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the demo persona login with real password + TOTP accounts for the two product roles (server administrator, customer hosting admin), make production builds free of demo backdoors, add Italian/English translations, and give the customer the site-first console shell the owner chose.

**Architecture:** The API keeps issuing its own RS256 JWTs, but the signing key is persisted to disk and every token is backed by a row in a new `user_sessions` table (revocation survives restarts). Passwords use `node:crypto` scrypt, TOTP is a small RFC 6238 implementation on `node:crypto`, and the TOTP secret is encrypted with the existing AES-256-GCM secrets helpers. The Next.js BFF calls the new `/v1/auth/login` instead of the dev token endpoint. Translations are plain typed TypeScript dictionaries with no new dependency.

**Tech Stack:** TypeScript 6, NestJS 12 + Fastify 5, Drizzle + PGlite/pg, `jose`, `zod`, Next.js 16 App Router, shadcn/radix, Vitest 5. **No new npm dependencies.**

**Spec:** `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md` (sections 2, 3.1, 3.2, 4 "Users", 5, 7, 8 step 1)

**Scope note:** Spec step 1 is split in two plans. **This plan (1a)** covers auth, roles, demo removal, first-admin CLI, i18n, the customer shell and the admin Users page. **Plan 1b (next)** covers the fresh-server installer and release/update packaging. Plan 1a only touches `infra/` to provision the new keys.

## Global Constraints

- No new npm packages. Use `node:crypto`, `jose`, `zod` and the existing shadcn components (`apps/web/src/components/ui/*`).
- Dev conveniences are **opt-in**. `ENABLE_DEV_OIDC` and `HP_SEED_DEMO` are on only when exactly `"true"`. Production defaults are off.
- Product roles: **Server administrator** = `users.platform_role = 'infrastructure_admin'`. **Hosting admin (customer)** = `customer_owner` membership in the server's single customer organization. No other role is created through the product UI.
- 2FA (TOTP) is **mandatory for server administrators** (login refused until enrolled; it cannot be disabled). It is optional for customers.
- Passwords: minimum **12** characters. Login lockout: **5** consecutive failures lock the account for **15 minutes**.
- Session/token lifetime: **12 hours** (JWT `exp` = `user_sessions.expires_at` = BFF cookie `maxAge`).
- Every user-visible string in screens touched by this plan comes from the IT/EN dictionaries. **Italian is the default.** The language is chosen per user.
- Customer console vocabulary: no "container", "Docker", "image", "revision", "service instance", "stack", "drift", "allocation", "outbox" or spec IDs (`HCP-SPEC-*`, `AC-F*`, `ADR-*`) visible to the customer.
- Errors shown to users say what happened and what to do next (spec 3.2).
- Shared mode stays gated. Do not touch `ADR-011` or the capability flags.
- Workspace packages are consumed through `dist`. After editing `packages/*`, run `corepack pnpm run build` before running app tests.
- Every task ends green on: `corepack pnpm run build && corepack pnpm run lint && corepack pnpm run typecheck && corepack pnpm run test`.

## Review Focus

1. **A login request arrives with a valid password but a wrong or reused TOTP code.** It must fail. The same 30-second code must not work twice (Task 4: `rejects a TOTP code reused within its window`).
2. **The API restarts.** Existing browser sessions keep working (persisted key), and logged-out sessions stay logged out (DB revocation) (Task 3: `revoked session stays revoked after app restart`).
3. **The BFF is started in production without `BFF_SESSION_SECRET`.** It must refuse to create sessions instead of using a hard-coded key (Task 8: `throws in production when BFF_SESSION_SECRET is missing`).
4. **The email is entered with different case or surrounding spaces** (`  Mario@Hotel.IT `). It must find the same account (emails stored lower-cased and trimmed) (Task 4: `login is case- and whitespace-insensitive on email`).
5. **An unknown email is tried repeatedly.** The response is indistinguishable from a wrong password: same code `INVALID_CREDENTIALS`, same message (Task 4: `unknown email and wrong password return identical errors`).

---

### Task 1: Database migration 0003 — accounts and sessions

**Files:**
- Create: `packages/database/migrations/0003_production_accounts.sql`
- Modify: `packages/database/src/schema.ts` (`users` table; new `userSessions` table)
- Modify: `packages/database/src/seed.ts` (set `platformRole` on `usr_infra`)
- Test: `packages/database/test/accounts-database.test.ts`

**Interfaces:**
- Produces: Drizzle columns on `users`: `passwordHash: text | null`, `platformRole: "infrastructure_admin" | null`, `locale: "it" | "en"` (default `"it"`), `mustChangePassword: boolean` (default `false`), `totpCiphertextBase64 | totpIvBase64 | totpAuthTagBase64: text | null`, `totpEnabledAt: timestamp | null`, `totpLastStep: bigint (mode number) | null`, `failedLoginCount: integer` (default 0), `lockedUntil: timestamp | null`.
- Produces: `userSessions` table: `id text PK` (= JWT `jti`), `userId text FK users ON DELETE CASCADE`, `createdAt`, `expiresAt timestamptz not null`, `revokedAt timestamptz null`, `ip text null`. Index on `user_id`.
- Produces: export `userSessions` from `packages/database/src/index.ts`.

- [ ] **Step 1: Write the failing test** `accounts-database.test.ts` using `createDatabaseClient({ mode: "pglite" })` + `migrate()`:
  - `applies 0003 and exposes new users columns`: insert a user with only `id/email/name`, then read back `locale === "it"`, `mustChangePassword === false`, `failedLoginCount === 0`, `platformRole === null`.
  - `rejects locale outside it/en`: raw insert with `locale = 'fr'` rejects (CHECK constraint).
  - `rejects platform_role other than infrastructure_admin`: raw insert with `'hosting_admin'` rejects.
  - `cascades sessions on user delete`: insert user + session, delete user, session count is 0.
  - `seed marks usr_infra as server admin`: after `seedPhase1Dataset`, `usr_infra.platformRole === "infrastructure_admin"`, and `usr_elena.platformRole === null`.
- [ ] **Step 2: Run it and confirm it fails.** Run `corepack pnpm exec vitest run packages/database/test/accounts-database.test.ts`. Expected: FAIL (missing columns/table).
- [ ] **Step 3: Write `0003_production_accounts.sql`** (additive `ALTER TABLE users ADD COLUMN ...` with `CHECK (locale IN ('it','en'))` and `CHECK (platform_role IS NULL OR platform_role = 'infrastructure_admin')`, plus `CREATE TABLE user_sessions`). Mirror it in `schema.ts`, and set `platformRole: "infrastructure_admin"` on the `usr_infra` seed row.
- [ ] **Step 4: Run the test, then the full database suite.** Run `corepack pnpm run build && corepack pnpm exec vitest run packages/database`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(database): add 0003 production accounts and user_sessions`.

---

### Task 2: Password hashing and TOTP primitives

**Files:**
- Create: `apps/api/src/auth/password.ts`, `apps/api/src/auth/totp.ts`
- Test: `apps/api/test/auth-primitives.test.ts`

**Interfaces:**
- Produces (`password.ts`):
  - `hashPassword(plain: string): Promise<string>`: format `scrypt$32768$8$1$<saltB64>$<hashB64>`, 16-byte salt, 64-byte key, `maxmem: 64 * 1024 * 1024`.
  - `verifyPassword(plain: string, stored: string): Promise<boolean>`: parses the parameters from `stored`, compares with `timingSafeEqual`, returns `false` on a malformed `stored` (never throws).
  - `assertPasswordPolicy(plain: string): void`: throws `ControlPlaneError("VALIDATION_ERROR", ...)` when shorter than 12 characters.
  - `generateTemporaryPassword(): string`: 16 characters from an unambiguous alphabet (no `0O1lI`), via `randomInt`.
- Produces (`totp.ts`):
  - `generateTotpSecret(): string`: 20 random bytes, base32 (RFC 4648, no padding).
  - `totpCodeAt(secretBase32: string, step: number, digits?: 6 | 8): string`: HMAC-SHA1, dynamic truncation.
  - `verifyTotp(secretBase32: string, code: string, nowMs: number, lastUsedStep: number | null): { ok: true; step: number } | { ok: false }`: 30-second steps, window ±1. Rejects any `step <= lastUsedStep`, and rejects non-6-digit codes.
  - `buildOtpauthUri(secretBase32: string, accountEmail: string, issuer: string): string`: `otpauth://totp/<issuer>:<email>?secret=..&issuer=..&algorithm=SHA1&digits=6&period=30` (URI-encoded).

- [ ] **Step 1: Write failing tests:**
  - `hashes and verifies a password`: `verifyPassword("correct horse battery", await hashPassword("correct horse battery")) === true`, and the wrong password gives `false`.
  - `two hashes of the same password differ` (random salt).
  - `verifyPassword returns false on malformed hash` for `"garbage"`.
  - `rejects passwords shorter than 12 chars`: `assertPasswordPolicy("short")` throws, and `assertPasswordPolicy("twelve-chars")` does not.
  - `temporary password is 16 unambiguous chars`: matches `/^[A-HJ-NP-Za-km-z2-9]{16}$/`.
  - `RFC 6238 SHA1 vectors`: secret `"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"` (= ASCII `12345678901234567890`). `totpCodeAt(s, Math.floor(59/30), 8) === "94287082"`, `totpCodeAt(s, Math.floor(1111111109/30), 8) === "07081804"`, `totpCodeAt(s, Math.floor(1234567890/30), 8) === "89005924"`.
  - `accepts current and ±1 step, rejects ±2`.
  - `rejects a TOTP code reused within its window`: verify once with `lastUsedStep = null` (ok, `step` S), then again with `lastUsedStep = S` (`ok: false`).
  - `otpauth uri encodes issuer and email`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/api/test/auth-primitives.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement both modules** with the signatures above.
- [ ] **Step 4: Run them and confirm they pass.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(api): add scrypt password hashing and RFC 6238 TOTP primitives`.

---

### Task 3: Production defaults, persisted signing key and DB-backed sessions

**Files:**
- Modify: `apps/api/src/create-app.ts`. `enableDevOidc` default becomes `process.env.ENABLE_DEV_OIDC === "true"`. Seeding becomes `options?.seedPhase1 ?? process.env.HP_SEED_DEMO === "true"`. Add option `jwtSigningKeyPem?: string`. When `runtimeBackend === "linux-systemd"` and no option is given, read PKCS#8 PEM from `HP_JWT_SIGNING_KEY_FILE` (default `/etc/hosting-panel/jwt-signing.pem`) and fail startup if it is missing.
- Modify: `apps/api/src/tokens.ts` (`ControlPlaneRuntimeConfig.jwtSigningKeyPem: string | null`)
- Modify: `apps/api/src/auth/oidc.service.ts`.
  - With a PEM, import the key pair via `importPKCS8` (RS256) and derive the public key. Otherwise generate an ephemeral key (dev/tests).
  - Replace the in-memory `#revokedJtis` with DB checks.
  - Default/max TTL becomes 43_200 s.
- Modify: `apps/api/src/auth/authz-context.service.ts`.
  - Replace the `usr_infra` / `infra@hcp.local` check with `user.platformRole === "infrastructure_admin"`.
  - Reject `userStatus !== "active"` with `UNAUTHENTICATED`.
- Modify: `apps/api/src/controllers/auth.controller.ts` (`/v1/auth/revoke` writes `revoked_at`)
- Modify: `apps/api/test/api.integration.test.ts`, `apps/api/test/phase2-api.integration.test.ts`: add `seedPhase1: true` to every `createControlPlaneApp` call.
- Modify: root `package.json` scripts: `dev:api` and `dev:api:sim` prefix `ENABLE_DEV_OIDC=true HP_SEED_DEMO=true`.
- Test: `apps/api/test/production-defaults.integration.test.ts`

**Interfaces:**
- Produces on `OidcService`:
  - `issueSessionToken(input: { userId: string; email: string; displayName: string; ip: string | null }): Promise<IssuedJwtResult>`: inserts a `user_sessions` row (`id = jti`, `expiresAt = now + 12h`) and signs the JWT with the same `jti`/`exp`.
  - `revokeSession(jti: string): Promise<void>`
  - `revokeAllSessionsForUser(userId: string, exceptJti?: string): Promise<void>`
- Changes: `verifyAuthorizationHeader` (RS256 branch) rejects with `UNAUTHENTICATED` unless a `user_sessions` row exists with `revoked_at IS NULL AND expires_at > now()`. The break-glass HS256 branch is unchanged. The existing dev `issueToken` must also insert a session row, so dev tokens keep verifying.
- Produces: `CreateControlPlaneAppOptions.jwtSigningKeyPem?: string`

- [ ] **Step 1: Write failing tests** in `production-defaults.integration.test.ts`, each with its own PGlite client passed through `databaseClient` and `listen: true, port: 0`:
  - `dev token endpoint is 404 by default`: no `enableDevOidc` option, env unset. `POST /v1/dev/auth/token` gives 404.
  - `no demo data is seeded by default`: users table count is 0 after boot.
  - `revoked session stays revoked after app restart`:
    1. Boot with `jwtSigningKeyPem` (generated in-test via `generateKeyPairSync("rsa", { modulusLength: 2048 })` exported as PKCS#8 PEM) and `seedPhase1: true, enableDevOidc: true`.
    2. Get a token, call `/v1/me` (200), revoke it, close the app.
    3. Boot again with the same PEM and DB. `/v1/me` with the revoked token gives 401.
    4. A second, non-revoked token issued before the restart still gives 200.
  - `disabled user is rejected`: set `user_status = 'disabled'` on `usr_elena`. Her token on `/v1/me` gives 401.
  - `server admin comes from platform_role`: clear `platform_role` on `usr_infra`. `/v1/me.globalRoles` no longer contains `infrastructure_admin`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm run build && corepack pnpm exec vitest run apps/api/test/production-defaults.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the changes listed under Files.**
- [ ] **Step 4: Run the whole API suite** (`corepack pnpm exec vitest run apps/api`). Expected: PASS, including the existing suites with `seedPhase1: true`.
- [ ] **Step 5: Commit** `feat(api): opt-in dev auth/seed, persisted JWT key, DB-backed sessions`.

---

### Task 4: Login API with lockout and TOTP

**Files:**
- Modify: `packages/contracts/src/errors.ts` (add `INVALID_CREDENTIALS` → 401, `ACCOUNT_LOCKED` → 423, `TOTP_INVALID` → 401, `ACCOUNT_SETUP_INCOMPLETE` → 403)
- Modify: `packages/contracts/src/resources.ts` (add `LoginInputSchema`, `LoginResultDtoSchema`)
- Create: `apps/api/src/auth/login.service.ts`
- Modify: `apps/api/src/controllers/auth.controller.ts` (`POST /v1/auth/login`), `apps/api/src/app.module.ts` (provider)
- Test: `apps/api/test/login.integration.test.ts`

**Interfaces:**
- Produces (contracts):
  - `LoginInputSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(1024), totpCode: z.string().regex(/^\d{6}$/).optional() })`
  - `LoginResultDto = { status: "ok"; accessToken: string; expiresAt: string; mustChangePassword: boolean } | { status: "totp_required" }`
- Produces: `LoginService.login(input: LoginInput, ip: string | null): Promise<LoginResultDto>`.
- Consumes: `verifyPassword`, `verifyTotp` (Task 2), `OidcService.issueSessionToken` (Task 3), `decryptSecretAesGcm` from `@hosting-panel/database`. The TOTP secret AAD context is `{ organizationId: "platform", siteId: null, secretKey: "totp:" + userId }`.
- Behaviour, in this order:
  1. If `locked_until > now`, return `ACCOUNT_LOCKED`.
  2. If the user is unknown, has no `password_hash`, has a wrong password, or is not `active`, increment `failed_login_count` when the user exists. At 5 failures, set `locked_until = now + 15 min` and reset the count. Return `INVALID_CREDENTIALS` with the fixed message `"Email o password non corretti."`.
  3. If the user is a server admin without `totp_enabled_at`, return `ACCOUNT_SETUP_INCOMPLETE`.
  4. If TOTP is enabled and there is no `totpCode`, return `{ status: "totp_required" }` (the failure counter is not touched).
  5. If the code is wrong or reused, count it as a failure and return `TOTP_INVALID`.
  6. On success, reset the counter, store `totp_last_step`, issue a session token, and audit `auth.login.success`. Failures audit `auth.login.failure` with `{ reason }` and never include the password.

- [ ] **Step 1: Write failing tests.** Seed users directly in PGlite with `hashPassword`. The TOTP secret is encrypted with a test master key passed as `secretsMasterKey`.
  - `logs in with correct password` → 200 `status: "ok"`, and the token works on `/v1/me`.
  - `unknown email and wrong password return identical errors` → both give 401 `INVALID_CREDENTIALS` with an identical `error.message`.
  - `login is case- and whitespace-insensitive on email` (`"  Mario@Hotel.IT "`).
  - `locks after 5 failures for 15 minutes`: the 6th attempt, even with the right password, gives 423 `ACCOUNT_LOCKED`. After moving `locked_until` into the past, the right password gives 200.
  - `requires TOTP when enabled` → `{ status: "totp_required" }`. The correct code gives `ok`, and a wrong code gives 401 `TOTP_INVALID`.
  - `rejects reused TOTP code`: the same code twice → the second gives 401 `TOTP_INVALID`.
  - `server admin without TOTP cannot log in` → 403 `ACCOUNT_SETUP_INCOMPLETE`.
  - `mustChangePassword is reported` when the flag is set.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm run build && corepack pnpm exec vitest run apps/api/test/login.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the contracts, `LoginService` and the route.**
- [ ] **Step 4: Run them and confirm they pass**, plus `vitest run packages/contracts apps/api`.
- [ ] **Step 5: Commit** `feat(api): password + TOTP login with lockout and audit`.

---

### Task 5: Self-service account API (password, 2FA, language)

**Files:**
- Create: `apps/api/src/controllers/account.controller.ts` (prefix `v1/me`). Register it in `app.module.ts`.
- Modify: `packages/contracts/src/resources.ts` (`MeDtoSchema` gains `user.locale: "it" | "en"`, `user.totpEnabled: boolean`, `user.mustChangePassword: boolean`, `user.isServerAdmin: boolean`)
- Modify: `apps/api/src/controllers/me.controller.ts` (fill the new fields)
- Test: `apps/api/test/account.integration.test.ts`

**Interfaces (all require an authenticated session; all audited):**
- `POST /v1/me/password { currentPassword, newPassword }`: verify the current password, enforce the policy, save the hash, clear `must_change_password`, and revoke all other sessions (`revokeAllSessionsForUser(userId, currentJti)`). Returns 204.
- `POST /v1/me/totp/setup`: generates a secret and stores it encrypted, leaving `totp_enabled_at` null. Returns `{ data: { secretBase32, otpauthUri } }` (issuer `"Hosting Panel"`). Returns 400 `VALIDATION_ERROR` if TOTP is already enabled.
- `POST /v1/me/totp/enable { code }`: verifies against the pending secret, then sets `totp_enabled_at` and `totp_last_step`. Returns 204.
- `POST /v1/me/totp/disable { password, code }`: customers only. Server admins get 403 `PERMISSION_DENIED`. Clears the TOTP columns. Returns 204.
- `PATCH /v1/me/locale { locale: "it" | "en" }`: returns 204.

- [ ] **Step 1: Write failing tests:**
  - `change password revokes other sessions`: two sessions; changing the password via A leaves A at 200 and B at 401.
  - `wrong current password is rejected` → 401 `INVALID_CREDENTIALS`.
  - `new password under 12 chars is rejected` → 400 `VALIDATION_ERROR`.
  - `totp setup then enable`, using `totpCodeAt(secret, Math.floor(Date.now()/30000))` → `/v1/me.user.totpEnabled === true`.
  - `server admin cannot disable totp` → 403.
  - `customer can disable totp with password and code`.
  - `locale round-trip`: PATCH `"en"` → `/v1/me.user.locale === "en"`. PATCH `"fr"` → 400.
  - `/v1/me exposes no secret material`: `findForbiddenPublicDtoKeys` is empty, and the body does not contain the base32 secret.
- [ ] **Step 2: Run them and confirm they fail.** Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat(api): self-service password, TOTP enrolment and language`.

---

### Task 6: Accounts CLI (first setup, first admin, recovery)

**Files:**
- Create: `apps/api/src/cli/accounts.ts`. Follow the shape of `apps/api/src/cli/break-glass.ts`: exported functions plus a thin `runCli` with `--flag value` parsing.
- Modify: `apps/api/package.json` (`"accounts": "node dist/cli/accounts.js"`)
- Test: `apps/api/test/accounts-cli.test.ts`

**Interfaces (each takes `db: HostingPanelDatabase` and `secretsMasterKey`; each writes an `audit_events` row with `actorType: "system"`):**
- `setupInstallation(db, input: { installationName: string; hostHostname: string; hostIpv4: string }): Promise<{ installationId: string; hostId: string }>`: idempotent. It creates the single `platform_installations` row and the single local `hosts` row (`hostingMode: "dedicated"`), filling CPU/RAM/storage from `os.cpus().length * 1000`, `os.totalmem()`, `statfs("/")`. A second call returns the existing IDs.
- `createServerAdmin(db, key, input: { email: string; name: string; password: string }): Promise<{ userId: string; totpSecretBase32: string; otpauthUri: string }>`: applies the password policy, lower-cases the email, sets `platform_role` and enrols TOTP immediately (`totp_enabled_at = now`). Throws `ControlPlaneError("VALIDATION_ERROR")` (400) on a duplicate email.
- `resetUserPassword(db, input: { email: string }): Promise<{ temporaryPassword: string }>`: sets `must_change_password = true`, unlocks the account and revokes all sessions.
- `resetUserTotp(db, key, input: { email: string }): Promise<{ totpSecretBase32: string; otpauthUri: string } | null>`: for a server admin it re-enrols and returns the new secret. For a customer it clears TOTP and returns `null`.
- CLI commands: `setup`, `create-admin` (password from env `HP_NEW_PASSWORD`, otherwise an interactive hidden prompt via `node:readline`), `reset-password`, `reset-totp`. Database and key resolution reuse `resolveSecretsMasterKey` and `DATABASE_URL`, as in break-glass.

- [ ] **Step 1: Write failing tests** against PGlite:
  - `setupInstallation is idempotent`: two calls return the same IDs, and there is 1 host row.
  - `createServerAdmin enrols TOTP and can log in`: create, then boot the app on the same DB and log in with the password plus `totpCodeAt(secret, now)` → `ok`.
  - `createServerAdmin rejects weak password and duplicate email`.
  - `resetUserPassword sets mustChangePassword and unlocks`.
  - `resetUserTotp re-enrols admins and clears customers`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat(api): accounts CLI for setup, first admin and recovery`.

---

### Task 7: Admin user-management API (customer account)

**Files:**
- Modify: `packages/contracts/src/permissions.ts` (add `"platform.users.manage"` to `PERMISSION_KEYS` and to `PRESET_ROLE_PERMISSIONS.infrastructure_admin` only)
- Modify: `packages/contracts/src/resources.ts` (`AdminUserDtoSchema`, `CreateCustomerAccountInputSchema`)
- Create: `apps/api/src/controllers/admin-users.controller.ts` (prefix `v1/admin`). Register it.
- Test: `apps/api/test/admin-users.integration.test.ts`

**Interfaces (all `requirePlatformPermission(auth, req, "platform.users.manage", ...)`; all audited):**
- `AdminUserDto = { id, email, name, role: "server_admin" | "customer", status: "active" | "disabled", totpEnabled: boolean, mustChangePassword: boolean, lockedUntil: string | null, createdAt }`
- `GET /v1/admin/users` → `{ data: AdminUserDto[] }`
- `POST /v1/admin/customer-account { organizationName, ownerEmail, ownerName }` → 201 `{ data: { organizationId, userId, temporaryPassword } }`. In one transaction:
  1. Create the org (slug derived from the name).
  2. Create the dedicated allocation of the single local host via the existing `allocateHostTransactional`.
  3. Create the user (`must_change_password = true`), the membership and the `customer_owner` membership role.
  - Returns 409 `DEDICATED_HOST_OCCUPIED` if a customer organization already exists (one customer per server), and 404 `NOT_FOUND` if `setup` was never run (no host).
- `POST /v1/admin/users/:userId/reset-password` → `{ data: { temporaryPassword } }` (reuses `resetUserPassword` from Task 6)
- `POST /v1/admin/users/:userId/reset-totp` → customers only (admins use the CLI); 204
- `PATCH /v1/admin/users/:userId { status: "active" | "disabled" }` → disabling revokes all sessions. An admin cannot disable themself (403).

- [ ] **Step 1: Write failing tests:**
  - `server admin creates the customer account`: the response has a 16-char temp password. The customer logs in → `mustChangePassword: true`, and `/v1/me.memberships[0].role === "customer_owner"`.
  - `second customer account is refused` → 409 `DEDICATED_HOST_OCCUPIED`.
  - `customer cannot call admin endpoints` → 403 `PERMISSION_DENIED`, with an audit row of the denied type.
  - `disabling a user revokes their sessions` → their token gets 401.
  - `admin cannot disable themself` → 403.
  - `user list exposes no password hash or TOTP data` (`findForbiddenPublicDtoKeys` empty; no `scrypt$` in the body).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run them and confirm they pass**, plus the whole `apps/api` + `packages/authz` suites (permission list changed).
- [ ] **Step 5: Commit** `feat(api): admin user management and one-customer account creation`.

---

### Task 8: BFF — real login, hardened session, account and admin routes

**Files:**
- Modify: `apps/web/src/lib/session.ts`.
  - Secret from `BFF_SESSION_SECRET`.
  - When `NODE_ENV === "production"`, throw if it is missing or shorter than 32 characters. In dev, fall back to the existing constant.
  - `SessionUser` gains `locale`, `isServerAdmin`, `mustChangePassword`.
  - `ConsoleContext` becomes `"admin" | "customer"`.
  - Expiry is `"12h"`.
- Modify: `apps/web/src/lib/server-session.ts` (cookie `maxAge` `60 * 60 * 12`)
- Modify: `apps/web/src/app/api/session/login/route.ts`. It forwards `{ email, password, totpCode }` to `v1/auth/login`, passes `{ status: "totp_required" }` through as 200 without setting a cookie, maps upstream error codes to the response, and sets `activeConsole` = `"admin"` if `isServerAdmin`, else `"customer"`.
- Delete: `apps/web/src/app/api/session/switch-context/route.ts`
- Create BFF routes (CSRF + Origin validated via `validateCsrfAndOrigin`, path segments via `validatePathSegments`, pattern as in the existing `bff/` routes):
  - `app/api/account/password/route.ts` (POST)
  - `app/api/account/totp/setup/route.ts` (POST)
  - `app/api/account/totp/enable/route.ts` (POST)
  - `app/api/account/totp/disable/route.ts` (POST)
  - `app/api/account/locale/route.ts` (PATCH; also re-issues the session cookie with the new locale)
  - `app/api/admin/users/route.ts` (GET)
  - `app/api/admin/customer-account/route.ts` (POST)
  - `app/api/admin/users/[userId]/route.ts` (PATCH)
  - `app/api/admin/users/[userId]/reset-password/route.ts` (POST)
  - `app/api/admin/users/[userId]/reset-totp/route.ts` (POST)
- Modify: `apps/web/test/bff.integration.test.ts`. The mock upstream serves `/v1/auth/login` instead of `/v1/dev/auth/token`. Update test 1 and remove test 3 (switch-context).
- Test: add cases to `apps/web/test/bff.integration.test.ts`

- [ ] **Step 1: Write failing tests:**
  - `throws in production when BFF_SESSION_SECRET is missing`: set `NODE_ENV=production`, unset the secret; `encryptSession` rejects. Restore the env afterwards.
  - `login passes totp_required through without a cookie`: no `Set-Cookie` header.
  - `login maps ACCOUNT_LOCKED to 423`, and the body has no `accessToken`.
  - `successful login sets admin console for server admin and customer console otherwise`.
  - `account and admin mutating routes reject missing CSRF` (403) for each new POST/PATCH route.
  - `locale PATCH re-issues cookie with new locale` (decrypt the new cookie → `user.locale === "en"`).
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/web/test`. Expected: FAIL.
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat(web): real BFF login, hardened session secret, account/admin routes`.

---

### Task 9: IT/EN translation scaffolding

**Files:**
- Create: `apps/web/src/i18n/it.ts`, `apps/web/src/i18n/en.ts`, `apps/web/src/i18n/index.ts`, `apps/web/src/i18n/provider.tsx`
- Modify: `apps/web/src/app/layout.tsx` (`<html lang={locale}>`, wrap children in `I18nProvider`, product title `"Hosting Panel"`)
- Test: `apps/web/test/i18n.test.ts`

**Interfaces:**
- `it.ts`: `export const it = { common: {...}, login: {...}, account: {...}, shell: {...}, site: {...}, admin: {...}, errors: {...} } as const;`. Nested string leaves. Placeholders use the form `{name}`.
- `en.ts`: `export const en: Messages = {...}`, where `Messages` is the `it` shape with every leaf widened to `string` (exported from `index.ts`), so a missing key is a type error.
- `index.ts`:
  - `type Locale = "it" | "en"`, `DEFAULT_LOCALE: Locale = "it"`
  - `getMessages(locale: Locale): Messages`
  - `format(template: string, vars: Record<string, string | number>): string`
  - `resolveLocale(session: SessionData | null, cookieValue: string | undefined): Locale`: session user locale first, then the `hp_locale` cookie, then `"it"`.
  - `getRequestLocale(): Promise<Locale>`: server helper using `getServerSession` + `cookies()`.
  - `errorMessage(messages: Messages, code: string): string`: maps API error codes to friendly text, falling back to `errors.generic`.
- `provider.tsx`: `"use client"`; `I18nProvider({ locale, messages, children })`, `useMessages(): Messages`, `useLocale(): Locale`.
- `errors` must contain friendly copy, with the next step, for at least: `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED` ("Too many attempts. Try again in 15 minutes or ask your administrator."), `TOTP_INVALID`, `ACCOUNT_SETUP_INCOMPLETE`, `PERMISSION_DENIED`, `NOT_FOUND`, `VALIDATION_ERROR`, `INTERNAL_ERROR`, `generic`.

- [ ] **Step 1: Write failing tests:**
  - `it and en have identical key sets` (recursive key walk).
  - `no empty translations` in either language.
  - `format replaces placeholders`: `format("Ciao {name}", { name: "Mario" }) === "Ciao Mario"`.
  - `resolveLocale prefers session, then cookie, then it`.
  - `errorMessage falls back to generic for unknown codes`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement it.**
- [ ] **Step 4: Run them and confirm they pass.**
- [ ] **Step 5: Commit** `feat(web): add typed IT/EN translation scaffolding`.

---

### Task 10: Login, 2FA and forced password-change screens

**Files:**
- Rewrite: `apps/web/src/app/login/page.tsx` (server component; renders `LoginForm`)
- Create: `apps/web/src/components/auth/login-form.tsx` (client)
  - Step A: email + password.
  - On `totp_required`, step B: a 6-digit code field (`inputMode="numeric"`, `autoComplete="one-time-code"`). Email and password are kept in component state only.
  - Errors via `errorMessage`.
  - Language switch on the login page (sets the `hp_locale` cookie).
- Create: `apps/web/src/app/account/change-password/page.tsx` (forced screen)
- Delete: `apps/web/src/components/auth/persona-selector.tsx`, `apps/web/src/app/choose-context/page.tsx`, and `fetchServerPersonas` in `lib/server-api.ts`
- Modify: `apps/web/src/app/page.tsx`. No session → `/login`. `mustChangePassword` → `/account/change-password`. Admin → `/admin/hosts`. Customer → `/sites`.
- Test: `apps/web/test/ui-copy.test.ts`

- [ ] **Step 1: Write the failing test.** `ui-copy.test.ts` statically scans `apps/web/src/app/login`, `apps/web/src/app/account`, `apps/web/src/app/sites` and `apps/web/src/components/{auth,customer}`:
  - `no persona or dev-login remnants`: no `persona`, `dev/auth`, `fetchServerPersonas`.
  - `customer surfaces avoid infrastructure jargon`: case-insensitive, none of `container`, `docker`, `revision`, `drift`, `allocation`, `outbox`, `HCP-SPEC`, `AC-F`, `ADR-` appear in string literals or JSX text. `it.ts`/`en.ts` keys under `shell`/`site`/`login`/`account` are scanned too.
- [ ] **Step 2: Run it and confirm it fails** (the login page still contains "Persona" and spec IDs).
- [ ] **Step 3: Implement the screens.** All copy comes from the dictionaries. The visual style is clean, Coolify-like: centered card, one primary button, no architecture marketing panels.
- [ ] **Step 4: Run the test, then `corepack pnpm run build`.** Expected: PASS.
- [ ] **Step 5: Manual check.** Run `corepack pnpm run dev:api` and `corepack pnpm run dev:web`. Create an admin with the CLI (`HP_NEW_PASSWORD=... node apps/api/dist/cli/accounts.js create-admin ...` against the dev DB), log in with an authenticator code, and switch to English on the login page.
- [ ] **Step 6: Commit** `feat(web): real login with 2FA step and forced password change`.

---

### Task 11: Customer site-first shell and account page

**Files:**
- Delete: `apps/web/src/app/o/` (all customer pages), `apps/web/src/app/hosting/` (hosting console), `apps/web/src/components/customer/site-detail-interactive.tsx`, `apps/web/src/components/customer/new-site-dialog.tsx`, `apps/web/src/components/hosting/`. Keep the `api/bff/orgs/*` routes; later steps reuse them.
- Create: `apps/web/src/app/sites/layout.tsx`. Guard: customer session only (an admin is redirected to `/admin/hosts`). Resolves the single organization from `/v1/me.memberships[0]`. Renders `CustomerTopBar`.
- Create: `apps/web/src/app/sites/page.tsx`. No sites → empty state (`shell.emptyTitle` / `shell.emptyBody`: "Your administrator is preparing your first site." — the create button comes in step 2). Otherwise redirect to the `hp_last_site` cookie's site if it still exists, else the first site.
- Create: `apps/web/src/app/sites/[siteId]/layout.tsx`. Site header (name, status pill, primary-domain link "Visit site ↗") plus `SiteTabs`. Sets the `hp_last_site` cookie.
- Create: `apps/web/src/app/sites/[siteId]/page.tsx` (Overview). Cards: status, domains (hostname + plain status), recent activity (the org's operations for this site, latest 5, as friendly sentences via the dictionaries).
- Create: `apps/web/src/components/customer/top-bar.tsx` (logo, `SiteSwitcher` dropdown, `LanguageSwitch`, account menu with "Account" and "Log out")
- Create: `apps/web/src/components/customer/site-tabs.tsx`. Tab list driven by a typed array `SITE_TABS: { key: "overview"; href: (siteId) => string }[]`. Only `overview` exists in step 1; later steps append.
- Create: `apps/web/src/components/customer/status-pill.tsx`. `toSiteStatusView(status: SiteStatus, driftSummary): { tone: "ok" | "warn" | "error" | "muted"; labelKey: keyof Messages["site"]["status"] }`, with plain words: Online / Stopped / Problem / Being set up.
- Create: `apps/web/src/components/shared/language-switch.tsx` (calls `PATCH /api/account/locale` when logged in, otherwise sets the `hp_locale` cookie; then `router.refresh()`)
- Create: `apps/web/src/app/account/page.tsx` + `apps/web/src/components/account/{password-form,totp-card}.tsx`
  - Change password.
  - 2FA: setup shows the `otpauthUri` as a link and the base32 secret in groups of 4, with a code field to confirm. Disable is hidden for admins.
  - Language.
  - Shared by both roles. The admin reaches it from their header.
- Test: `apps/web/test/customer-shell.test.ts` + the `ui-copy.test.ts` scan from Task 10 (already covers `sites/` and `components/customer`)

- [ ] **Step 1: Write failing tests:**
  - `toSiteStatusView maps every SiteStatus to a known label key` (iterate the `SiteStatus` enum; every result's `labelKey` exists in both `it` and `en`).
  - `SITE_TABS has overview first`.
  - `pickLandingSite returns last-used site if present, else first, else null`. Export `pickLandingSite(sites: SiteSummaryDto[], lastSiteId: string | undefined): string | null` from `apps/web/src/app/sites/landing.ts`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement the shell, pages and components.** Use the existing shadcn `dropdown-menu`, `tabs`, `card`, `badge` and `button`.
- [ ] **Step 4: Run the tests and `corepack pnpm run build`.** Expected: PASS.
- [ ] **Step 5: Manual check.**
  1. With `dev:api` (demo seed), create a customer through the admin API (Task 7) or use `elena@acme.it`. In dev, set a password via the CLI `reset-password`.
  2. Log in, change the password, land on `/sites/<id>`, switch sites, switch to English.
  3. Confirm the console never shows infrastructure words.
- [ ] **Step 6: Commit** `feat(web): site-first customer shell, account page, language switch`.

---

### Task 12: Admin console — Users page and translation of existing admin screens

**Files:**
- Modify: `apps/web/src/app/admin/layout.tsx` (guard: `isServerAdmin`). Modify `apps/web/src/components/layout/sidebar-nav.tsx`. Admin sections in this step: **Server** (`/admin/hosts`), **Users** (`/admin/users`), **Audit** (`/admin/audit`). Remove the `hosting`/`org` contexts.
- Modify: `apps/web/src/components/layout/header.tsx` (no context switcher; user menu with Account, Language, Log out)
- Create: `apps/web/src/app/admin/users/page.tsx` + `apps/web/src/components/admin/users-table.tsx` + `apps/web/src/components/admin/create-customer-dialog.tsx`.
  - The table shows role, status, 2FA and locked state, with actions: reset password, reset 2FA (customers), disable/enable.
  - The create dialog shows the temporary password **once**, with a copy button and the note "Share it securely; the customer must change it at first login."
  - The create button is hidden when a customer already exists.
- Modify (move all literals to the dictionaries under `admin.*`): `apps/web/src/app/admin/hosts/page.tsx`, `apps/web/src/app/admin/hosts/[hostId]/page.tsx`, `apps/web/src/app/admin/audit/page.tsx`, `apps/web/src/components/admin/host-detail-actions.tsx`, `apps/web/src/components/admin/audit-table.tsx`, `apps/web/src/components/shared/operation-timeline.tsx`, `apps/web/src/app/not-found.tsx`
- Test: `apps/web/test/ui-copy.test.ts`. Add `admin hard-coded Italian is gone`: in `apps/web/src/app/admin` and `apps/web/src/components/{admin,layout,shared}`, JSX text nodes and `title`/`placeholder`/`aria-label` string literals contain no letters (they must come from `messages`). Allowed: technical tokens such as `nftables` inside dictionary values only.
- [ ] **Step 1: Write the failing test** (above).
- [ ] **Step 2: Run it and confirm it fails** (the current admin pages are hard-coded Italian).
- [ ] **Step 3: Implement the Users page and move the copy.**
- [ ] **Step 4: Run all web tests and `corepack pnpm run build`.** Expected: PASS.
- [ ] **Step 5: Manual check.** As admin, create the customer account, copy the temp password, log in as the customer in a private window, and confirm the forced password change. Back as admin, disable and re-enable the customer, and confirm they are logged out after disable.
- [ ] **Step 6: Commit** `feat(web): admin users page and IT/EN admin console`.

---

### Task 13: Ops wiring, docs and harness

**Files:**
- Modify: `infra/linux/bootstrap-dedicated.sh`.
  - Idempotently generate `/etc/hosting-panel/jwt-signing.pem` (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072`, `0400`, owner `hp-api`).
  - Ensure `/etc/hosting-panel/hosting-panel.env` contains `BFF_SESSION_SECRET=<64 random hex>` (generate only if absent; mode `0440`, group readable by `hp-web`), `ENABLE_DEV_OIDC=false` and `HP_SEED_DEMO=false`.
  - Print the next step: `sudo -u hp-api node /opt/hosting-panel/apps/api/dist/cli/accounts.js setup ... && ... create-admin ...`.
- Modify: `infra/systemd/hp-api.service` (`Environment=HP_JWT_SIGNING_KEY_FILE=/etc/hosting-panel/jwt-signing.pem`)
- Modify: `infra/linux/run-outage-ac-f1-08.mjs`: add `HP_SEED_DEMO: "true"` next to `ENABLE_DEV_OIDC: "true"` (line ~621) so the outage runner keeps working.
- Modify: `.env.example` (`ENABLE_DEV_OIDC=false`, `HP_SEED_DEMO=false`, `BFF_SESSION_SECRET` comment "required in production, ≥32 chars", `HP_JWT_SIGNING_KEY_FILE`)
- Modify: `docs/api/openapi.yaml` (the new `/v1/auth/login`, `/v1/me/*`, `/v1/admin/*` endpoints and error codes)
- Modify: `README.md` (quick start: dev scripts opt into demo; production first-run = `setup` + `create-admin`; two roles; 2FA mandatory for admins)
- Modify: `.agents/brain/state.md` (new macro goal: production hosting panel spec; step 1a in progress) and `.agents/brain/decisions.md` (append the owner decisions from the spec: two roles, one customer per server, no mail hosting, outgoing relay, IT/EN, site-first UI)
- Modify: `HARNESS.md`. Replace the forbidden-action bullet that bans claiming ACME/TLS/SFTP/Backups with: "never claim a capability whose flag is still `false`; flags turn `true` only when the feature ships per `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md`". Add: "never enable dev OIDC or demo seeding by default".
- Test: `apps/api/test/production-defaults.integration.test.ts`. Add `openapi documents the login endpoint`: parse `docs/api/openapi.yaml` text and assert it contains `/v1/auth/login`, `/v1/me/totp/setup` and `/v1/admin/customer-account`.

- [ ] **Step 1: Write the failing test** (above).
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Make the file changes.** Check the bootstrap script with `bash -n infra/linux/bootstrap-dedicated.sh` and its existing dry-run mode (see `usage()` in the script). Expected: exit 0 and the dry-run lines mention `jwt-signing.pem` and `BFF_SESSION_SECRET`.
- [ ] **Step 4: Run all four sensors.** Run `corepack pnpm run build && corepack pnpm run lint && corepack pnpm run typecheck && corepack pnpm run test`. Expected: all exit 0.
- [ ] **Step 5: Commit** `chore(ops,docs): provision JWT key and BFF secret, document production login`.

---

## Self-review notes

- **Spec coverage (step 1 slice):**
  - Real login, passwords and TOTP: Tasks 2, 4, 5.
  - Two roles: Tasks 3, 7, 12.
  - Demo login/seed off in production: Task 3.
  - First admin: Task 6.
  - Lockout/rate limit: Task 4.
  - Password reset by admin and lost-2FA recovery over SSH: Tasks 6, 7.
  - No external IdP: nothing added.
  - IT/EN with Italian default and per-user language: Tasks 9–12.
  - Site-first shell with top-bar switcher, tabs, empty state and account pages: Task 11.
  - Admin Users area: Task 12.
  - Installer and release packaging: **Plan 1b**.
- **Not in this plan, on purpose:**
  - Site creation (step 2): the empty state says the admin prepares the site.
  - Email password reset: no SMTP relay until step 2.
  - Admin support access to customer sites (step 6).
  - Per-IP rate limiting: per-account lockout only. `shortcut:` comment in `login.service.ts`; upgrade when the panel is exposed beyond the hosting company's own proxy.
  - Recovery codes: admins recover via the CLI; customers via the admin.
