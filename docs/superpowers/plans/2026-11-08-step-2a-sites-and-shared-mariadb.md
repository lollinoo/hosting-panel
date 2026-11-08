# Step 2a — WordPress Sites and Shared MariaDB — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note (why Step 2 is split):** Spec step 2 bundles three subsystems that share almost no code:
1. WordPress site runtimes plus a shared database server;
2. domain ownership, DNS checks and certificates;
3. an outgoing mail relay injected into the site runtimes.

Planning them together would give one plan of 25–30 tasks, and its later half could not be tested until the first half shipped. So they are split, and each part ends in software that works on a server:
- **2a (this plan):** WordPress sites, the shared MariaDB, site ownership (admin-created and assignable), lifecycle and logs. A site answers over plain HTTP on the address it was given.
- **2b:** domains, DNS check, Let's Encrypt and HTTPS.
- **2c:** the SMTP relay.

2b and 2c each build only on 2a. 2b comes first because mail delivery is only meaningful once sites have their real domains. The later plans are outlined at the end.

**Owner decisions (2026-11-08), applied here and recorded in the spec:**
- **WordPress is the only site type in this version.** Static, PHP-app and Node sites are removed, not deferred.
- **The PHP version per WordPress site** stays: `8.3`, `8.4` or `8.5`, default `8.4`.
- **Preview addresses are deferred.** The owner tests 2b with a real test domain.
- **The server administrator can create sites and assign them to a customer, or reassign them.** The customer then sees and manages an assigned site as if they had created it. Customers can still create their own sites.
- **Minimum server: 2 GB RAM.** The installer warns below that and continues.

**Goal:**
- A customer, or the server administrator on the customer's behalf, creates a WordPress site with a name, web address, site title and admin account.
- A few minutes later WordPress is installed and running on its own database in one shared MariaDB server.
- The customer sees only their own sites. The administrator sees all of them, can hold a site unassigned and assign or reassign it.
- The site can be started, stopped, restarted and deleted, its PHP version changed, and its recent visit and error logs read.
- Every site keeps serving when the control plane is down or the host reboots (`CP-01`).

**Architecture:**
- **One site = one container**, as in the existing service model. Each site runs `wordpress:<ver>-php<x.y>-apache`, chosen by `resolveWordpressRuntime(php)` in contracts. The service-template table keeps one row, `tpl_site_wordpress`, only so the existing foreign keys stay valid.
- **Shared MariaDB is a platform component**, like the ingress proxy. `hp-docker-executor` creates `hp_mariadb`:
  - it runs as a dedicated `hp-mariadb` system user (no groups, not `hp-executor`) with no capabilities, and its data lives in a host directory owned by that user;
  - its root password is a persistent key file in `/etc/hosting-panel`;
  - root may log in only from the fixed admin subnet of `hp_mariadb_net`, where only setup jobs run;
  - it joins every site's internal network under the alias `hp-mariadb`;
  - it publishes no host port.
- **Setup work runs in allowlisted one-off job containers** (`runSiteJob` with kinds `db.provision`, `db.drop` and `wordpress.install`).
  - The API picks a kind and validated parameters. The executor owns the image, user, network, mounts and the fixed shell script.
  - Job secrets use the existing tmpfs `*_FILE` mechanism (`ADR-015`) and are purged when the job ends.
- **No site needs a runtime secret.** WordPress keeps its DB password in its own `wp-config.php`, written once by the install job, as on any WordPress host. A reboot with the control plane down therefore brings sites back with no panel involvement.
- **A site is not public until WordPress is installed.** Its domain stays `pending` (not routed) through setup, so nobody can reach WordPress's own web installer first. It becomes `active` and routed only after the install job succeeds.
- **One timeout budget.** Every executor-side wait (image pull 240 s, job 240 s) fits inside the API's IPC timeout for that call, and the operation lease is renewed before each step, so the API never gives up on work that is still running. The executor also refuses a second job of the same kind for the same site while one runs.
- **Ownership = the site's organization.**
  - The server has at most one customer organization (the dedicated rule `AC-F1-01`).
  - **Unassigned** sites are held by the existing internal `org_platform_ops` organization. It gets its own host allocation, and the dedicated-host rule ignores it.
  - **Reassigning** moves the site row and its children to the target organization in one transaction (composite foreign keys get `ON UPDATE CASCADE`). The same transaction re-encrypts the site's secrets under the new organization's AAD, then redeploys so the container labels match.
  - Admin endpoints live under `/v1/admin/sites` and use the existing server-admin guard. Customer endpoints stay organization-scoped. The authz presets are unchanged.

**Tech Stack:** The existing TypeScript monorepo (NestJS + Fastify, Next.js 16, Drizzle, Vitest), Docker Engine REST API v1.45. **No new npm dependencies.** New container images, all checked on Docker Hub on 2026-11-08:

| Purpose | Image (exact tag pinned) | Why |
|---|---|---|
| Shared database | `mariadb:12.3.3` | 12.3 is the current MariaDB LTS (`lts` tag = 12.3.3); 13.0 is short-term and 13.1 is RC. |
| WordPress runtime | `wordpress:7.1.4-php{8.3,8.4,8.5}-apache` | 7.1.4 is the newest WordPress. The Apache variant runs in one container and `.htaccess` works. |
| WordPress setup | `wordpress:cli-2.12.0-php{8.3,8.4,8.5}` | wp-cli 2.12.0 is current, with the same PHP minor as the site. |

PHP 8.2 is left out because its security support ends on 31 Dec 2026. PHP 8.6 is still an RC.

**Spec:** `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md`, mainly §3.1, §3.2, §3.3, §3.11, §4 (Sites row), §5 (minimum server), §6, §8 step 2 and §9. Builds on Steps 1a and 1b: `docs/superpowers/plans/2026-11-08-step-1a-accounts-login-i18n-shell.md` and `…-step-1b-installer-and-releases.md`.

## Global Constraints

- **WordPress is the only creatable site type** (owner decision). Do not add a site-type field, enum or UI choice. The service-template catalog stays hidden from the product.
- **PHP versions:** `8.3`, `8.4` and `8.5`, default `8.4`. Image tags come only from `packages/contracts/src/site-runtime.ts`, so Step 6 "Updates" has one place to bump them.
- **Minimum server:** 2 GB RAM. `install.sh` warns when `MemTotal` is below 1,800,000 kB (a "2 GB" VPS often reports 1.85–1.95 M kB) and continues; it never blocks.
- **`CP-01`:**
  - Site containers, `hp_mariadb` and the proxy all use `RestartPolicy: unless-stopped` and need nothing from `/run/hosting-panel` at runtime.
  - `hp_mariadb` and the proxy are recreated **only** when their image or config changed. The updater never touches them.
- **Hardening:**
  - Every container (site, job, MariaDB) keeps `CapDrop: ALL`, `no-new-privileges`, CPU, memory and pids limits, and has no host port.
  - The WordPress runtime keeps the existing certified set (`CHOWN`, `SETUID`, `SETGID`, `NET_BIND_SERVICE`) granted by the existing image pattern, because Apache starts as root, binds 80 and drops to `www-data`. Record that reason in `ADR-0016`.
- **Docker socket only in the executor.** The API never names an image, command, mount or network for a job; it only picks a `SiteJobKind`.
- **No secrets in:** env, argv, DTOs, revisions, outbox payloads or logs. Job secrets reach the job only as `/run/secrets/<NAME>` files, read through stdin redirection or shell builtins.
  - The WordPress admin password typed at creation is an encrypted site secret, deleted once the install succeeds.
  - The site DB password is always 64 lowercase hex chars. The executor rejects anything else before it reaches SQL, and customers cannot write the platform secret keys (`SITE_DB_PASSWORD`, `WP_ADMIN_PASSWORD_INITIAL`, any `HP_*`).
- **Managed sites are changed only through `managed-sites` and `admin/sites`.** The generic service, revision, lifecycle and site-secret routes refuse sites with `php_version IS NOT NULL` ("Manage this site from its page").
- **Operation messages are customer-visible.** Step and error messages are fixed, friendly texts; raw job output goes only into admin-only audit details.
- **Who sees what:**
  - Customers see and act only on sites of their own organization. That is the existing org-scoped policy; no change.
  - Only server administrators (`platform_role = infrastructure_admin`) reach `/v1/admin/sites`. Every admin site action is audited with action `admin.site.*`.
- **Customer console:**
  - None of these words: "container", "image", "Docker", "volume", "network", "revision", "service", "template", "MariaDB", "job", "organization".
  - IT and EN for every new string; Italian is the default.
  - Every error says what to do next.
  - Delete and reassign use confirmations that name the consequence.
- **Resource defaults:**
  - Per WordPress site: `cpuMilli 1000`, `memoryBytes "536870912"`, pids 256.
  - `hp_mariadb`: 1 GiB, 1 CPU, `PidsLimit 512`.
  - Jobs: 512 MiB, 1 CPU, `PidsLimit 128`.
- **Timeouts:** executor image pull 240 s, job wait 240 s. API→executor IPC: `deployService` 300 s, `runSiteJob` 510 s, `purgeSite` 120 s, logs 35 s. Operation lease renewed to 12 minutes before each provision step.
- **Image tags are pinned, not digests.** Docker Hub re-pushes these tags for security rebuilds; ADR 0016 accepts that drift until Step 6 "Updates" adds digest pins.
- **Fresh installs only** (spec §5). Migration `0004` is additive, apart from re-creating five FK constraints with `ON UPDATE CASCADE`.
- Every task ends green on `corepack pnpm run build && corepack pnpm run lint && corepack pnpm run typecheck && corepack pnpm run test`. After editing `packages/*`, run `build` before app tests.

## Review Focus

1. **The host reboots, or `docker.service` restarts, while every panel unit is stopped.** WordPress sites and `hp_mariadb` must come back and serve without the API or executor.
   - Task 7: `a provisioned site has no secret refs and is deployed without secrets`.
   - Task 3: `mariadb payload binds only persistent host paths`.
   - Live in Task 14, step 6.
2. **Provisioning fails halfway**, e.g. an image pull error, an executor restart, or a wp-cli failure. The site shows "Problem" with "Try again". A retry reuses the database and user, never installs WordPress twice, and keeps the admin account.
   - Task 7: `retry after a failed install reuses the database`, `a step running past 60 s keeps its lease`, and `interrupted site.provision converges to failed, not replayed`.
   - Task 4: `wordpress.install script is idempotent` and `a second job of the same kind for a site is refused`.
   - Live: Task 14, step 5 (the original admin still logs in after the retry).
3. **A customer guesses another organization's site id**, e.g. a site the admin holds unassigned, or one assigned elsewhere, on any route (read, actions, runtime, delete, logs). They get 404 and nothing leaks. After the admin assigns the site to them, it appears in their list and every action works. After reassignment away, it disappears.
   - Task 8: `customer cannot act on a site of another organization`.
   - Task 9: `customer cannot see an unassigned site until it is assigned to them`, and `reassigned site keeps serving and its secrets decrypt under the new owner`.
4. **The web address is already used** by another site (assigned or not), or by the panel's own hostname or IP; or it is an IP, a wildcard, has uppercase letters or a trailing dot. Duplicates are rejected in plain language, and `Hotel.IT.` is normalized to `hotel.it`.
   - Task 0: `normalizeSiteDomain`.
   - Task 7: `rejects a domain used by another site or by the panel`.
5. **Customer-typed text contains quotes, `$()` or newlines**, e.g. the title `L'Hôtel "Bella" $(id)`. Values reach WordPress verbatim and nothing is interpreted by a shell or SQL. A delete while provisioning is refused with `RESOURCE_LOCKED`.
   - Task 4: `wordpress.install passes customer values only as env and never inside Cmd`, and `rejects a db identifier outside the pattern`.
   - Task 0: `rejects an admin password with a newline`.
   - Task 8: `delete while provisioning returns RESOURCE_LOCKED`.

---

## File map

| Area | Files |
|---|---|
| Runtime catalog and inputs | `packages/contracts/src/site-runtime.ts` (new), `resources.ts`, `operations.ts`, `ipc-schemas.ts`, `index.ts` |
| Data model | `packages/database/migrations/0004_sites_and_databases.sql` (new), `src/schema.ts`, `src/sites-repository.ts` (new), `src/index.ts` |
| Allocation policy | `packages/policy-engine/src/host-allocation.ts`, `packages/contracts/src/resources.ts` (`PLATFORM_OPS_ORG_ID` moves here) |
| Executor port | `packages/executor-contracts/src/port.ts`, `phase1-executor.ts` |
| Executor runtime | `apps/docker-executor/src/docker-logs.ts` (new), `shared-database.ts` (new), `site-jobs.ts` (new), `docker-engine-adapter.ts`, `traefik-config.ts`, `simulator-adapter.ts`, `server.ts`, `client.ts`, `main.ts` |
| API | `apps/api/src/runtime/service-spec.ts` (new, extracted), `runtime/site-provisioner.ts` (new), `sites/managed-sites.service.ts` (new), `controllers/managed-sites.controller.ts` (new), `controllers/admin-sites.controller.ts` (new), `runtime/outbox-worker.service.ts`, `controllers/organizations.controller.ts` and `hosts.controller.ts` (small changes), `app.module.ts`, `create-app.ts` |
| Web | `apps/web/src/app/sites/new/page.tsx`, `components/customer/site-form.tsx`, `site-progress.tsx`, `site-actions.tsx`, `delete-site-dialog.tsx`, `app/sites/[siteId]/logs/page.tsx`, `app/admin/sites/page.tsx`, `components/admin/sites-table.tsx`, `create-site-for-customer-dialog.tsx`, `change-owner-dialog.tsx`, BFF routes under `app/api/bff/orgs/[orgId]/managed-sites/` and `app/api/admin/sites/`, `components/layout/sidebar-nav.tsx`, `i18n/it.ts`, `i18n/en.ts` |
| Infra and docs | `infra/linux/bootstrap-dedicated.sh`, `infra/linux/install.sh`, `docs/architecture/adr/0016-shared-mariadb-and-site-jobs.md` (new), `README.md`, `HARNESS.md`, `.agents/brain/state.md`, `docs/api/openapi.yaml` |

---

### Task 0: WordPress runtime catalog and input contracts

**Files:**
- Create: `packages/contracts/src/site-runtime.ts`
- Modify: `packages/contracts/src/resources.ts`, `operations.ts`, `index.ts`
- Test: `packages/contracts/test/site-runtime.test.ts`

**Interfaces (produces):**
- **Versions:**
  - `SUPPORTED_PHP_VERSIONS = ["8.3", "8.4", "8.5"] as const`;
  - `type PhpVersion`;
  - `DEFAULT_PHP_VERSION: PhpVersion = "8.4"`.
- **Images:**
  - `SHARED_MARIADB_IMAGE = "mariadb:12.3.3"`;
  - `resolveWordpressImage(php: PhpVersion): string` → `wordpress:7.1.4-php<php>-apache`;
  - `resolveWordpressCliImage(php: PhpVersion): string` → `wordpress:cli-2.12.0-php<php>`.
- `resolveWordpressRuntime(php: PhpVersion)` returns:

  ```ts
  {
    image: string;
    internalPort: 80;
    contentPath: "/var/www/html";
    volumeSuffix: "html";
    resourceLimits: { cpuMilli: 1000; memoryBytes: "536870912" };
  }
  ```
- `SITE_DB_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{2,31}$/`.
- `normalizeSiteDomain(raw: string): string | null`:
  - trims, lower-cases and strips one trailing dot;
  - requires at least one dot and RFC 1123 labels (the executor's `SAFE_DOMAIN_PATTERN` shape, without `*.`);
  - rejects IPv4 and IPv6 literals and anything over 253 chars.
- `PLATFORM_OPS_ORG_ID = "org_platform_ops"`, moved here from `hosts.controller.ts`, which now imports it.
- **Input schemas:**
  - `CreateManagedSiteInputSchema = z.object(...)` with:

    | Field | Rule |
    |---|---|
    | `name` | 1–80, trimmed |
    | `domain` | `normalizeSiteDomain` not null; issue path `domain`; output is the normalized value |
    | `phpVersion` | `z.enum(SUPPORTED_PHP_VERSIONS)`, default `"8.4"` |
    | `title` | 1–120 |
    | `adminUser` | `/^[A-Za-z0-9._@-]{3,60}$/` |
    | `adminEmail` | email |
    | `adminPassword` | 12–128, no `\r`, `\n` or `\0` |

  - `AdminCreateSiteInputSchema = CreateManagedSiteInputSchema.extend({ ownerOrganizationId: EntityIdSchema.nullable() })`. `null` means unassigned.
  - `ChangeSiteOwnerInputSchema = z.object({ ownerOrganizationId: EntityIdSchema.nullable() })`.
  - `SiteActionInputSchema = z.object({ action: z.enum(["start", "stop", "restart", "retry"]) })`.
  - `ChangeSiteRuntimeInputSchema = z.object({ phpVersion: z.enum(SUPPORTED_PHP_VERSIONS) })`.
  - `DeleteSiteInputSchema = z.object({ confirmName: z.string() })`.
- **DTOs:**
  - `SiteLogLineDtoSchema = z.object({ at: IsoDateTimeSchema.nullable(), stream: z.enum(["stdout", "stderr"]), text: z.string() })`.
  - `AdminSiteDtoSchema = SiteSummaryDtoSchema.extend({ primaryDomain: z.string().nullable(), owner: z.object({ organizationId: EntityIdSchema, name: z.string() }).nullable() })`. `owner` is null when the site is held by `org_platform_ops`.
  - `AdminSitesListDtoSchema = z.object({ sites: z.array(AdminSiteDtoSchema), customers: z.array(z.object({ organizationId: EntityIdSchema, name: z.string(), ownerEmail: z.string() })) })`. `customers` feeds the admin owner select, because `AdminUserDto` carries no organization.
  - `PLATFORM_SECRET_KEYS = ["SITE_DB_PASSWORD", "WP_ADMIN_PASSWORD_INITIAL"] as const` and `isPlatformSecretKey(key: string): boolean` (true for those two and for any `HP_` prefix).
  - `SiteSummaryDtoSchema` gains `phpVersion: z.enum(SUPPORTED_PHP_VERSIONS).nullable()`. Null marks a pre-Step-2 row that is not a managed WordPress site.
- `OPERATION_KINDS` gains `"site.provision"`, `"site.delete"` and `"site.reassign"`.

- [ ] **Step 1: Write the failing tests** in `site-runtime.test.ts`:
  - `resolveWordpressImage pins exact tags`: `"8.4"` → `wordpress:7.1.4-php8.4-apache`; `resolveWordpressCliImage("8.5")` → `wordpress:cli-2.12.0-php8.5`.
  - `normalizeSiteDomain`:
    - `" Hotel.IT. "` → `"hotel.it"`;
    - `null` for `"localhost"`, `"203.0.113.5"`, `"*.hotel.it"`, `"hotel..it"`, `"a b.it"`, `"[::1]"`, `"-x.it"` and a 254-char name.
  - `CreateManagedSiteInputSchema`:
    - accepts a full body and defaults `phpVersion` to `"8.4"`;
    - `rejects an admin password with a newline` (path `adminPassword`);
    - rejects `phpVersion "8.2"`;
    - accepts the title `L'Hôtel "Bella" $(id)` unchanged.
  - `AdminCreateSiteInputSchema accepts null owner`.
  - `SITE_DB_IDENTIFIER_PATTERN` accepts `wp_3f9a0c1b2d4e` and rejects `wp-1`, `Wp_x` and `x`.
  - `isPlatformSecretKey`: true for `SITE_DB_PASSWORD`, `WP_ADMIN_PASSWORD_INITIAL` and `HP_X`; false for `SMTP_PASSWORD`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run packages/contracts/test/site-runtime.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** Export everything from `index.ts`. Wherever the typecheck flags an existing `SiteSummaryDto` producer, map `phpVersion: null` for now; Task 1 adds the column.
- [ ] **Step 4: Run the tests and the four checks.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(contracts): WordPress runtime catalog, pinned images and managed-site inputs`.

---

### Task 1: Migration 0004 — PHP version, site databases, cascading ownership keys

**Files:**
- Create: `packages/database/migrations/0004_sites_and_databases.sql`, `packages/database/src/sites-repository.ts`
- Modify: `packages/database/src/schema.ts`, `src/index.ts`, `src/operations-repository.ts` (`createSiteTransactional` input), `src/phase2-repository.ts` (`renewOperationLease`), `apps/api/src/cli/accounts.ts` (`setupInstallation`), `apps/api/src/create-app.ts` (after migrations)
- Test: `packages/database/test/sites-database.test.ts`

**Interfaces (produces):**
- **SQL:**
  - `ALTER TABLE sites ADD COLUMN IF NOT EXISTS php_version TEXT CHECK (php_version IS NULL OR php_version IN ('8.3','8.4','8.5'))`.
  - `CREATE TABLE IF NOT EXISTS site_databases` with:
    - `id TEXT PRIMARY KEY`, `organization_id TEXT NOT NULL`, `site_id TEXT NOT NULL`;
    - `db_name TEXT NOT NULL UNIQUE`, `db_user TEXT NOT NULL UNIQUE`, `password_secret_id TEXT NOT NULL`;
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
    - `CONSTRAINT fk_site_databases_site_org FOREIGN KEY (site_id, organization_id) REFERENCES sites(id, organization_id) ON UPDATE CASCADE ON DELETE CASCADE`.
  - Drop and re-add, with `ON UPDATE CASCADE` and the same `ON DELETE` as today, each of `fk_service_instances_site_org`, `fk_stack_revisions_service_instance_org`, `fk_domains_site_org` and `fk_encrypted_secrets_site_org`. Mirror this in Drizzle's `foreignKey(...).onUpdate("cascade")`.
- **Drizzle:** `sites.phpVersion` and the `siteDatabases` table.
- **`createSiteTransactional`:** `CreateSiteInput` gains `status?: SiteStatus` (default `"ready"`, as today), `phpVersion?: PhpVersion | null` and `initialDomainStatus?: DomainStatus` (default as today). Today it hard-codes `status: "ready"`.
- **`renewOperationLease(db, operationId: string, leaseDurationMs: number): Promise<void>`** in `phase2-repository.ts`. It sets `lease_expires_at = now + leaseDurationMs` only while the status is `processing`, `accepted` or `reconciling`. It exists because `claimPendingOutboxEvents` resets the lease to the 60 s default at claim, and `transitionOperation` cannot move an op to its own status.
- **`sites-repository.ts`:**
  - `WORDPRESS_TEMPLATE_ID = "tpl_site_wordpress"`.
  - `ensureWordpressTemplate(db)`: upserts that `service_templates` row with `category: "site"`, `defaultImage = resolveWordpressImage(DEFAULT_PHP_VERSION)`, `defaultPort: 80` and `approvedForDedicated: true`. Idempotent; it refreshes `defaultImage` on rerun.
  - `insertSiteDatabase(tx, row)`.
  - `listSiteDatabases(db, { organizationId, siteId })`.
  - `latestSiteOperation(db, { siteId, kind })`: by `resource_id` only, regardless of org, so it still works right after a reassign.
  - `moveSiteToOrganizationTransactional(db, input)`. Input: `{ siteId: string; fromOrganizationId: string; toOrganizationId: string; toHostAllocationId: string; masterKey: string }`. Returns `Promise<void>`. In one transaction:
    1. decrypt each `encrypted_secrets` row of the site with the old AAD;
    2. `UPDATE sites SET organization_id, host_allocation_id`, which cascades to services, revisions, domains, secrets and `site_databases`;
    3. re-encrypt each secret with the new AAD (`${toOrg}:${siteId}:${key}`) and a fresh IV;
    4. `UPDATE site_databases.organization_id` happens through the cascade;
    5. `UPDATE operations SET organization_id = toOrg WHERE resource_id IN (siteId, <its service ids>)`, so the history moves with the site and the old owner can no longer list it.
    - Throws `NOT_FOUND` when the site is not in `fromOrganizationId`.
- `setupInstallation` and API startup both call `ensureWordpressTemplate`, so `hp-update` also refreshes the pin.

- [ ] **Step 1: Write the failing tests** (PGlite, following `accounts-database.test.ts`):
  - `migration 0004 adds php_version and site_databases`: `'8.4'` is accepted and `'7.4'` violates the check.
  - `ensureWordpressTemplate is idempotent`: two calls leave one row with `default_image === "wordpress:7.1.4-php8.4-apache"`.
  - `moving a site cascades to its children and re-encrypts its secrets`:
    1. Seed orgs A and B with allocations, and a site in A with a service, revision, domain, `site_databases` row and site secret `SITE_DB_PASSWORD=canary-db-1`.
    2. After the move: every child row has `organization_id = B`.
    3. `resolveDecryptedSecretRefs` with org B returns `canary-db-1`; with org A it finds nothing.
  - `moving a site from the wrong organization throws NOT_FOUND and changes nothing`.
  - `moving a site moves its operations`: a `site.provision` op of the site has `organization_id = B` afterwards.
  - `renewOperationLease extends a processing op and ignores a terminal one`.
  - `createSiteTransactional honours status, phpVersion and initialDomainStatus`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm run build && corepack pnpm exec vitest run packages/database/test/sites-database.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Map `phpVersion` in `organizations.controller.ts`'s site DTO mapping. Use the existing encrypt/decrypt helpers from `secrets-crypto.ts`.
- [ ] **Step 4: Run the tests and the four checks.**
- [ ] **Step 5: Commit** `feat(database): WordPress template, per-site databases and site ownership moves`.

---

### Task 2: Executor — per-request Docker timeouts and log demultiplexing

**Files:**
- Create: `apps/docker-executor/src/docker-logs.ts`
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts`
- Test: `apps/docker-executor/test/docker-logs.test.ts`, `apps/docker-executor/test/docker-executor.test.ts` (`describe("service logs")`)

**Interfaces (produces):**
- `DockerSocketHttpClient.request(method, path, body?, options?: { timeoutMs?: number })`. The default stays 30 s. `ensureImageAvailable`'s pull passes `PULL_TIMEOUT_MS = 240_000`, because a first WordPress pull exceeds 30 s on slow links. 240 s is part of the single budget in Global Constraints.
- `ensureImageAvailable` scans the streamed pull body for a JSON line with an `"error"` key; the Engine answers HTTP 200 even when a pull fails. On a match it throws `DOCKER_ENGINE_UNAVAILABLE` with the message "Could not download the site software". Today only the status code is checked, so a failed pull shows up later as a confusing create 404.
- `interface ServiceLogLine { at: string | null; stream: "stdout" | "stderr"; text: string }`. It moves to executor-contracts in Task 6.
- `demuxDockerLogStream(buf: Buffer): ServiceLogLine[]`:
  - parses Docker's 8-byte frame header (byte 0 = stream 1/2, bytes 4–7 = big-endian length);
  - splits lines and parses a leading RFC 3339 timestamp (`timestamps=1`) into `at`;
  - caps lines at 2000 chars;
  - ignores a truncated last frame.
- `DockerEngineSocketAdapter.getServiceLogs(serviceInstanceId: string, tail: number): Promise<ServiceLogLine[]>`:
  - `tail` is clamped to 1..500;
  - calls `GET /containers/<id>/logs?stdout=1&stderr=1&timestamps=1&tail=<n>`;
  - throws `NOT_FOUND` without a container.

- [ ] **Step 1: Write the failing tests:**
  - `demuxDockerLogStream splits stdout and stderr frames`: two hand-built frames give the right `stream`, a parsed `at`, and text without the timestamp.
  - `demuxDockerLogStream ignores a truncated trailing frame`.
  - `getServiceLogs clamps tail and returns demuxed lines`: using `startMockDockerDaemon`, the path contains `tail=500` when asked for 9999.
  - `a pull that streams an error is reported as a failure`: the mock answers `/images/create` with 200 and the body `{"status":"Pulling"}\n{"error":"manifest unknown"}` → `DOCKER_ENGINE_UNAVAILABLE`, and no `/containers/create` follows.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/docker-executor/test/docker-logs.test.ts apps/docker-executor/test/docker-executor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): service log tail, per-request timeouts and pull error detection`.

---

### Task 3: Executor — shared MariaDB platform container, installer key, 2 GB warning

**Files:**
- Create: `apps/docker-executor/src/shared-database.ts`
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts`, `main.ts`, `infra/linux/bootstrap-dedicated.sh`, `infra/linux/install.sh`
- Test: `apps/docker-executor/test/shared-database.test.ts`, `apps/api/test/infra-layout.test.ts`, `infra/linux/install.test.ts`

**Interfaces (produces):**
- **Constants:**
  - `SHARED_DB_CONTAINER_NAME = "hp_mariadb"`;
  - `SHARED_DB_NETWORK_NAME = "hp_mariadb_net"` (internal bridge, created with IPAM subnet `DEFAULT_SHARED_DB_ADMIN_SUBNET = "172.30.250.0/24"`, overridable by `HP_MARIADB_ADMIN_SUBNET` in `executor.env`);
  - `SHARED_DB_CONFIG_SHA256_LABEL = "io.hostingpanel.config_sha256"`;
  - `SHARED_DB_ALIAS = "hp-mariadb"`;
  - `DEFAULT_SHARED_DB_DATA_DIR = "/var/lib/hosting-panel/mariadb/data"`;
  - `DEFAULT_SHARED_DB_ROOT_KEY_FILE = "/etc/hosting-panel/mariadb-root.key"`.
- `buildSharedDatabaseContainerPayload(input: { image?: string; user: string; dataDirHostPath: string; rootKeyHostPath: string; adminSubnet: string })`:
  - `Image` defaults to `SHARED_MARIADB_IMAGE`; `User` = `input.user`, the `hp-mariadb` uid:gid. The adapter reads it from the owner of the data dir and refuses an owner that is 0 or the executor's own uid.
  - `Env`: `MARIADB_ROOT_PASSWORD_FILE=/run/secrets/mariadb-root`, `MARIADB_AUTO_UPGRADE=1` and `MARIADB_ROOT_HOST=<adminSubnet as a MariaDB host pattern, e.g. 172.30.250.%>`. Root can therefore log in only from setup jobs on `hp_mariadb_net`, never from a WordPress container. The variable applies at first initialisation, which fits fresh installs only.
  - Label `io.hostingpanel.config_sha256` = sha256 of the canonical JSON of `{ Image, Cmd, User, Env, Binds (sorted) }` of this payload.
  - `Cmd`: `["--innodb-buffer-pool-size=256M", "--max-connections=150", "--skip-name-resolve"]`.
  - Labels: `io.hostingpanel.managed=true` and `io.hostingpanel.role=shared_database`.
  - Hardening: `CapDrop ALL` with no `CapAdd`, `no-new-privileges`, `Memory`/`MemorySwap` 1073741824, `NanoCpus` 1e9, `PidsLimit` 512.
  - `RestartPolicy unless-stopped`, `NetworkMode hp_mariadb_net` with alias `hp-mariadb`.
  - Binds: `<data>:/var/lib/mysql` and `<key>:/run/secrets/mariadb-root:ro`. No `PortBindings`.
  - Throws `HOST_POLICY_DENIED` for any `docker.sock` path.
- `DockerEngineSocketAdapter.ensureSharedDatabase(): Promise<{ component: "shared_database"; status: "running" }>`:
  - Serialised like `ensureIngressProxy`.
  - Ensures the network and the image.
  - Before creating, it checks that the key file is a regular file and the data dir a directory. Otherwise it throws `HOST_POLICY_DENIED` "Run bootstrap first", which is logged and retried. Docker `Binds` would otherwise create a missing source as a root-owned directory.
  - Creates the container if missing. Recreates it **only** when the existing `io.hostingpanel.config_sha256` label differs from the payload's. Comparing `Config.Env` would recreate it on every start, because Docker merges the image's own ENV into it. Starts it if stopped.
  - Then reattaches it to every network labelled `io.hostingpanel.network_role=site_internal`, with alias `hp-mariadb` and `skipMissingNetwork`.
- `deployService`: after `ensureNetwork(siteNetwork)`, connect `hp_mariadb` to it with alias `hp-mariadb`. A 404 is ignored.
- `main.ts` (real Docker backend, after the IPC server starts):
  - calls `ensureSharedDatabase()`;
  - logs a failure as `{"event":"shared_database_ensure_failed","code":…}` and retries every 60 s, independently of the panel-ingress retry;
  - never crashes the executor.
- **Bootstrap:**
  - `ensure_system_user "hp-mariadb" ""`: no supplementary groups, not in `docker`;
  - creates `/etc/hosting-panel/mariadb-root.key` (32-byte hex, `0440 hp-mariadb:hp-executor` so that MariaDB and the executor's jobs can read it; only if absent, written via temp + `mv` like `ipc.key`);
  - creates `/var/lib/hosting-panel/mariadb/data` (`0700 hp-mariadb`);
  - the dry-run lists all three.
- **`install.sh`:**
  - Step 1 adds a memory preflight. It reads `MemTotal` from `${HP_MEMINFO_FILE:-/proc/meminfo}`. Below 1,800,000 kB it prints `WARNING: this server has <N> MB of RAM; at least 2 GB is required for WordPress sites and the database. Continuing.` and continues.
  - Step 12 also waits for `hp_mariadb` to be running.
  - The key-backup warning lists `mariadb-root.key`.

- [ ] **Step 1: Write the failing tests:**
  - `mariadb payload binds only persistent host paths`:
    - Binds equal exactly `["/var/lib/hosting-panel/mariadb/data:/var/lib/mysql", "/etc/hosting-panel/mariadb-root.key:/run/secrets/mariadb-root:ro"]`;
    - nothing under `/run/hosting-panel`; no `PortBindings`; `CapAdd` undefined.
  - `mariadb payload refuses docker.sock`.
  - `mariadb root may log in only from the admin subnet`: `Env` contains `MARIADB_ROOT_HOST=172.30.250.%`, and the network-create body has `IPAM.Config[0].Subnet === "172.30.250.0/24"` and `Internal: true`.
  - `ensureSharedDatabase does not recreate an up-to-date container`. The mock's inspect returns the payload's label **plus** the image's own Env lines (`PATH=…`, `MARIADB_VERSION=…`, `GOSU_VERSION=…`), and no DELETE or create call is made. A second case, where only the label differs, does recreate.
  - `ensureSharedDatabase refuses when the key file is missing` (`HOST_POLICY_DENIED`, no create), and refuses when the data dir is owned by the executor's uid.
  - `deployService attaches hp_mariadb to the site network with alias hp-mariadb`.
  - `bootstrap dry-run provisions the mariadb user, key and data dir` (`infra-layout.test.ts`): the output contains `hp-mariadb`, `mariadb-root.key`, `0440` and `/var/lib/hosting-panel/mariadb/data`. Use the same skip rule as the existing dry-run test.
  - `install.test.ts`:
    - `dry-run step 12 waits for hp_mariadb`.
    - `warns but continues below 2 GB RAM`: `HP_MEMINFO_FILE` points at a fixture with `MemTotal: 1015808 kB` → stdout contains `at least 2 GB`, and the dry-run still prints `[STEP 12/12]`.
    - `no memory warning at 4 GB`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Also run `bash -n` on both scripts.
- [ ] **Step 5: Commit** `feat(docker-executor): shared MariaDB platform container; installer key and 2 GB warning`.

---

### Task 4: Executor — allowlisted site job containers

**Files:**
- Create: `apps/docker-executor/src/site-jobs.ts`
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts` (`runSiteJob`, `cleanupOrphanJobs`, `prewarmSiteImages`), `main.ts`
- Test: `apps/docker-executor/test/site-jobs.test.ts`

**Interfaces:**
- **Consumes:** `writeServiceSecrets`, `purgeServiceSecrets`, `getManagedVolumeName`, `getSiteInternalNetworkName`, `ensureSharedDatabase`, `SHARED_DB_*`, the Task 2 timeouts and demux, and `resolveWordpressCliImage`, `normalizeSiteDomain` and `SITE_DB_IDENTIFIER_PATTERN` from contracts.
- **Produces:**
  - `type SiteJobKind = "db.provision" | "db.drop" | "wordpress.install"` (in executor-contracts, Task 6).
  - `interface SiteJobRequest { jobId: string; kind: SiteJobKind; siteId: string; organizationId: string; serviceInstanceId?: string; params: Readonly<Record<string, string>>; resolvedSecrets?: Readonly<Record<string, string>> }`.
  - `interface SiteJobResult { jobId: string; exitCode: number; outputTail: string }`. `outputTail` holds the last 50 lines, at most 4 KiB, through `redactSensitiveString`.
  - `buildSiteJobContainerPayload(req: SiteJobRequest, ctx: { executorUser: string; secretBinds: readonly string[]; secretFileEnv: readonly string[]; rootKeyHostPath: string })`. It is pure and validates each param against an explicit per-kind allowlist:

  | Kind | Params | Secrets | Image | User | Network | Mounts |
  |---|---|---|---|---|---|---|
  | `db.provision` | `dbName`, `dbUser` (pattern) | `HP_DB_PASSWORD` | `SHARED_MARIADB_IMAGE` | `executorUser` | `hp_mariadb_net` | root key `:ro` |
  | `db.drop` | `dbName`, `dbUser` | — | `SHARED_MARIADB_IMAGE` | `executorUser` | `hp_mariadb_net` | root key `:ro` |
  | `wordpress.install` | `phpVersion`, `dbName`, `dbUser`, `siteUrl` (`http://` + a valid normalized domain), `title` (1–120), `adminUser`, `adminEmail`; `serviceInstanceId` required | `HP_DB_PASSWORD`, `HP_ADMIN_PASSWORD` | `resolveWordpressCliImage(phpVersion)` | `33:33` | site internal net | site volume `html` → `/var/www/html` |

  - Every job container uses:
    - `Cmd: ["sh", "-c", <fixed script>]`, with params only as `Env` entries `HP_<UPPER_SNAKE>`, plus `secretFileEnv`;
    - labels `io.hostingpanel.managed=true`, `io.hostingpanel.role=site_job`, `io.hostingpanel.site_id` and `io.hostingpanel.job_id`;
    - `CapDrop ALL`, `no-new-privileges`, the job limits, `RestartPolicy no`, no ports.
  - Unknown kinds, extra params, or a pattern or length failure throw `VALIDATION_ERROR`. Params are never spliced into the script text.
  - Extra validation: `HP_DB_PASSWORD` must match `^[0-9a-f]{64}$`, otherwise `VALIDATION_ERROR`. The executor never trusts the API on this, because the value is spliced into root SQL.
  - A per-adapter in-memory set of running `siteId:kind` keys. A second `runSiteJob` with the same key while one runs throws `RESOURCE_LOCKED`; the key is released in the `finally`.
- **Fixed scripts.** Constants in `site-jobs.ts`, shown here exactly, because the security review depends on the text. `$HP_*` values come from validated env, and `/run/secrets/*` from tmpfs files.
  - **Shared preamble for `db.*`:**

    ```sh
    set -eu
    pw=$(cat /run/secrets/HP_DB_PASSWORD 2>/dev/null || true)   # db.provision only
    case "$pw" in *[!0-9a-f]*) exit 64;; esac                    # db.provision only; empty is caught by the length check
    [ "${#pw}" -eq 64 ] || exit 64                                # db.provision only
    printf '[client]\nuser=root\nhost=hp-mariadb\npassword=%s\n' "$(cat /run/secrets/mariadb-root)" > /tmp/c.cnf
    i=0; until mariadb --defaults-extra-file=/tmp/c.cnf -e 'SELECT 1' >/dev/null 2>&1; do i=$((i+1)); [ "$i" -ge 30 ] && exit 11; sleep 2; done
    ```
  - **`db.provision`**, after the preamble. The heredoc is stdin, never argv:

    ```sh
    mariadb --defaults-extra-file=/tmp/c.cnf <<SQL
    CREATE DATABASE IF NOT EXISTS \`$HP_DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER IF NOT EXISTS '$HP_DB_USER'@'%' IDENTIFIED BY '$pw';
    ALTER USER '$HP_DB_USER'@'%' IDENTIFIED BY '$pw';
    GRANT ALL PRIVILEGES ON \`$HP_DB_NAME\`.* TO '$HP_DB_USER'@'%';
    SQL
    ```
  - **`db.drop`**, after the preamble (without the `pw` lines):

    ```sh
    mariadb --defaults-extra-file=/tmp/c.cnf <<SQL
    DROP DATABASE IF EXISTS \`$HP_DB_NAME\`;
    DROP USER IF EXISTS '$HP_DB_USER'@'%';
    SQL
    ```
  - **`wordpress.install`** (workdir `/var/www/html`):

    ```sh
    set -eu
    i=0; until [ -f wp-includes/version.php ]; do i=$((i+1)); [ "$i" -ge 60 ] && exit 10; sleep 2; done
    if [ -f wp-config.php ]; then
      wp config has HP_MANAGED --type=constant || exit 20      # a wp-config.php the panel did not write: refuse, never adopt it
    else
      wp config create --dbname="$HP_DB_NAME" --dbuser="$HP_DB_USER" --dbhost=hp-mariadb --skip-check --prompt=dbpass < /run/secrets/HP_DB_PASSWORD
      wp config set HP_MANAGED true --raw --type=constant
    fi
    wp core is-installed || wp core install --url="$HP_SITE_URL" --title="$HP_TITLE" --admin_user="$HP_ADMIN_USER" \
      --admin_email="$HP_ADMIN_EMAIL" --skip-email --prompt=admin_password < /run/secrets/HP_ADMIN_PASSWORD
    wp rewrite structure '/%postname%/'
    grep -q '^# BEGIN WordPress' .htaccess 2>/dev/null || printf '%s\n' "$HP_HTACCESS_WORDPRESS" >> .htaccess
    grep -q '^# BEGIN hosting-panel' .htaccess || { printf '%s\n' "$HP_HTACCESS_PANEL" | cat - .htaccess > .htaccess.new && mv .htaccess.new .htaccess; }
    ```

    - `HP_HTACCESS_WORDPRESS` and `HP_HTACCESS_PANEL` are constant env values set by the executor, not params. We write the rules ourselves because `wp rewrite --hard` writes no `.htaccess` under the CLI without an `apache_modules` config.
    - `HP_HTACCESS_WORDPRESS` is the standard block:

      ```
      # BEGIN WordPress
      <IfModule mod_rewrite.c>
      RewriteEngine On
      RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
      RewriteBase /
      RewriteRule ^index\.php$ - [L]
      RewriteCond %{REQUEST_FILENAME} !-f
      RewriteCond %{REQUEST_FILENAME} !-d
      RewriteRule . /index.php [L]
      </IfModule>
      # END WordPress
      ```
    - `HP_HTACCESS_PANEL` is:

      ```
      # BEGIN hosting-panel
      SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on
      # END hosting-panel
      ```
- **`runSiteJob(req): Promise<SiteJobResult>`:**
  1. `assertSafeIdentifier(jobId)`, then build the payload (validation first), then take the `siteId:kind` key.
  2. Pull the image (240 s budget). Call `ensureSharedDatabase()` for the `db.*` kinds.
  3. `writeServiceSecrets(secretsRoot, jobId, resolvedSecrets)`.
  4. Create the container (name = `jobId`) and start it.
  5. `POST /containers/<id>/wait` with timeout `jobTimeoutMs` (default `240_000`). On timeout, kill; the exit code is 124.
  6. Fetch the log tail and force-remove the container.
  7. In a `finally`: `purgeServiceSecrets(secretsRoot, jobId)` and release the key.
  - A non-zero exit returns a result. Transport failures throw `DOCKER_ENGINE_UNAVAILABLE`.
  - The worst case (pull 240 s + wait 240 s + about 20 s of create, logs and remove) fits inside the client's 510 s.
- `cleanupOrphanJobs()`: removes containers labelled `role=site_job` and purges `job_*` secret dirs. Called at executor start.
- `prewarmSiteImages()`: a fire-and-forget pull at start of `resolveWordpressImage(DEFAULT_PHP_VERSION)`, `resolveWordpressCliImage(DEFAULT_PHP_VERSION)` and `SHARED_MARIADB_IMAGE`. Failures are only logged. This turns first-site creation from minutes into seconds.

- [ ] **Step 1: Write the failing tests** in `site-jobs.test.ts`:
  - `wordpress.install passes customer values only as env and never inside Cmd`:
    - the title `L'Hôtel "Bella" $(id)` → `Cmd[2]` contains neither `Bella` nor `$(id)`;
    - `Env` contains `HP_TITLE=L'Hôtel "Bella" $(id)` verbatim;
    - no `Env` entry contains the canary admin password `canary-Pass-123456`;
    - `Env` contains `HP_ADMIN_PASSWORD_FILE=/run/secrets/HP_ADMIN_PASSWORD`.
  - `rejects a db identifier outside the pattern`: `dbName: "x; DROP"` → `VALIDATION_ERROR`.
  - `rejects a non-hex database password`: `HP_DB_PASSWORD` = `x'; GRANT ALL ON *.* TO 'a'@'%'; --` → `VALIDATION_ERROR`, and no container is created. Also `"A".repeat(64)` → rejected.
  - `db.provision script re-checks the password is 64 hex`: `Cmd[2]` contains `*[!0-9a-f]*) exit 64` and `-eq 64`.
  - `wordpress.install script is idempotent and refuses a foreign wp-config.php`: `Cmd[2]` contains `wp config has HP_MANAGED`, `exit 20`, `wp core is-installed ||` and `# BEGIN WordPress` (via the env value), and does not contain `--hard`.
  - `a second job of the same kind for a site is refused`: start a job whose mock wait never returns, then a second `wordpress.install` for the same site → `RESOURCE_LOCKED`. A `db.provision` for the same site, or a `wordpress.install` for another site, is accepted.
  - `rejects unknown kinds and unexpected params`: `site.placeholder` is unknown.
  - `db jobs run on hp_mariadb_net as the executor user with the root key read-only`.
  - `job payloads are hardened`: `CapDrop ["ALL"]`, `no-new-privileges:true`, no `PortBindings`, `RestartPolicy` `no`.
  - `runSiteJob purges secrets even when the job fails`: the mock's wait returns `StatusCode 3` → `exitCode 3`, and the `job_*` dir is gone.
  - `runSiteJob times out and reports exit 124` (`jobTimeoutMs: 50`).
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/docker-executor/test/site-jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): allowlisted site job containers for database and WordPress setup`.

---

### Task 5: Executor — purge a deleted site's leftovers

**Files:**
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts`, `apps/docker-executor/src/traefik-config.ts`
- Test: `apps/docker-executor/test/docker-executor.test.ts` (`describe("purge site")`)

**Interfaces (produces):**
- `TraefikIngressFileManager.removeSiteRoutes(siteId: string): Promise<void>`: drops the in-memory maps for the site and `rm -f`s `site_<id>.yml`.
- `DockerEngineSocketAdapter.purgeSite(siteId: string): Promise<void>`, in order:
  1. Throw `RESOURCE_LOCKED` if a non-job container labelled with `site_id` still exists. The API deletes the service first.
  2. Remove the site's leftover job containers.
  3. Disconnect `hp_ingress_proxy` from `hp_edge_<id>_net` and `hp_mariadb` from `hp_site_<id>_net` (404 ignored).
  4. Delete both networks (404 ignored).
  5. Delete each volume matching `label=io.hostingpanel.site_id=<siteId>`.
  6. `removeSiteRoutes`.
  - Idempotent.

- [ ] **Step 1: Write the failing tests:**
  - `purgeSite removes only volumes and networks labelled with that site`: with sites A and B listed by the mock, `purgeSite("A")` deletes only A's volume and networks, `site_A.yml` is gone, and `site_B.yml` remains.
  - `purgeSite refuses while a site container exists` → `RESOURCE_LOCKED`.
  - `purgeSite is idempotent`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): purge site volumes, networks and routes on delete`.

---

### Task 6: Executor port, IPC routes, client and simulator

**Files:**
- Modify: `packages/executor-contracts/src/port.ts` and `phase1-executor.ts`; `packages/contracts/src/ipc-schemas.ts`; `apps/docker-executor/src/server.ts`, `client.ts` and `simulator-adapter.ts`
- Test: `apps/docker-executor/test/docker-executor.test.ts` (`describe("site IPC")`), `packages/executor-contracts/test/executor-contracts.test.ts`

**Interfaces (produces):**
- `DockerExecutorPort` gains:
  - `runSiteJob(req: SiteJobRequest): Promise<SiteJobResult>`;
  - `purgeSite(siteId: string): Promise<void>`;
  - `getServiceLogs(serviceInstanceId: string, tail: number): Promise<readonly ServiceLogLine[]>`.
  - `SiteJobKind`, `SiteJobRequest`, `SiteJobResult` and `ServiceLogLine` live here.
  - `Phase1DisabledDockerExecutor` throws `NOT_SUPPORTED` for all three. The API maps that to 503 for logs, so the UI says "not available" rather than "nothing to show".
- **IPC routes:** `POST /v1/jobs/run`, `POST /v1/sites/purge` and `POST /v1/services/logs`.
  - Their zod schemas `SiteJobIpcRequestSchema`, `SitePurgeIpcRequestSchema` and `ServiceLogsIpcRequestSchema` go in `ipc-schemas.ts`.
  - The job route redacts `resolvedSecrets` from logs as the deploy route does.
- **Client per-call timeouts** (the single budget in Global Constraints; each is above the executor's own worst case for that call):
  - `deployService` 300 s (pull 240 s plus create and start);
  - `runSiteJob` 510 s (pull 240 s, wait 240 s, plus overhead);
  - `purgeSite` 120 s;
  - logs keep the 35 s default.
- **Simulator:**
  - `readonly jobs: SiteJobRequest[]`;
  - `failNextJob(kind, exitCode, outputTail?)` fails the next matching job once;
  - `failNextDeploy()` makes the next `deployService` throw `DOCKER_ENGINE_UNAVAILABLE` once;
  - `onJob?: (req: SiteJobRequest) => Promise<void>`, a test hook awaited inside `runSiteJob` (used by the lease test);
  - `setServiceLogs(serviceInstanceId, lines)`;
  - `purgeSite` deletes the site's simulated services;
  - deploy appends each `ApprovedServiceSpec` to `readonly deployedSpecs` (used by Tasks 7 and 9).

- [ ] **Step 1: Write the failing tests:**
  - `site IPC round-trips a job and never logs the secret`: with the signed server and simulator, `runSiteJob({… resolvedSecrets: { HP_DB_PASSWORD: "canary-db-pw-7788" } })` returns `exitCode 0`, and the captured server output does not contain the canary.
  - `site IPC rejects an unknown job kind with VALIDATION_ERROR`.
  - `client uses 300 s for deploy and 510 s for job requests`.
  - `phase1 executor refuses site jobs, purge and logs with NOT_SUPPORTED`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(executor-contracts): site jobs, site purge and service logs over signed IPC`.

---

### Task 7: API — create a WordPress site and provision it (customer self-service)

**Files:**
- Create:
  - `apps/api/src/runtime/service-spec.ts`: the extracted spec-building body of `#executeServiceDeploy`, with unchanged behavior;
  - `apps/api/src/runtime/site-provisioner.ts`;
  - `apps/api/src/sites/managed-sites.service.ts`;
  - `apps/api/src/controllers/managed-sites.controller.ts`.
- Modify:
  - `apps/api/src/runtime/outbox-worker.service.ts` (dispatch and unknown recovery);
  - `apps/api/src/controllers/organizations.controller.ts` (the managed-site guard on the generic routes; platform secret keys);
  - `apps/api/src/app.module.ts`.
- Test: `apps/api/test/managed-sites.integration.test.ts` (the `local-simulator` backend, as in `phase2-api.integration.test.ts`)

**Interfaces:**
- **Consumes:** Tasks 0, 1 and 6; `createSiteTransactional` (with Task 1's `status`, `phpVersion` and `initialDomainStatus`), `renewOperationLease`, `createServiceWithRevisionTransactional`, `enqueueOperationTransactional` (`lockKey`, `leaseDurationMs`, `steps`, `outboxPayload`), `upsertEncryptedSecretTransactional`, `resolveDecryptedSecretRefs`, `deleteEncryptedSecretTransactional`, `transitionOperation` and `updateOperationStepTransactional`.
- **Produces:**
  - `buildApprovedServiceSpec(db, config, { organizationId, serviceInstanceId }): Promise<ApprovedServiceSpec>`. The outbox deploy path now calls it. That path also calls `renewOperationLease(db, op.id, 6 * 60_000)` right before `deployService`; a pull can outlive the 60 s claim lease there too.
  - `siteDatabaseIdentifier(siteId: string): string` → `"wp_" + sha256(siteId).hex.slice(0, 12)`, used as both the DB name and the user.
  - `ManagedSitesService.create(input: { organizationId: string; body: CreateManagedSiteInput; actorId: string; idempotencyKey: string }): Promise<{ siteId: string; operationId: string }>`:
    - **Idempotent replay first.** If an operation with this `(organizationId, idempotencyKey)` exists, return its `{ siteId: resourceId, operationId }` without touching anything. The repository's own replay check runs only inside the enqueue, after the domain check and inserts, which would turn a network retry into a 409.
    - **Domain check.** Throws `DOMAIN_CONFLICT` when the normalized domain:
      - exists in `domains`;
      - equals `hosts.hostname` or `hosts.ipv4`.

      Message: "This web address is already used by another site or by the panel."
    - **Allocation.** The org's `host_allocations` row with status `active`; `NOT_FOUND` otherwise.
    - **One transaction:**
      1. Create the site: slug = slugified name + `-` + 6 random hex; `php_version`; status `deploying`.
      2. Create the primary domain with status `pending` (not routed). It becomes `active` (routed over plain HTTP; 2b refines this) only in the `publish_site` step, after WordPress is installed. Until then nobody can reach `wp-admin/install.php` or `setup-config.php` before the panel does.
      3. Create the service `web` from `WORDPRESS_TEMPLATE_ID` with configuration `{ image, internalPort: 80, exposeHttp: true, volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }] }` and the runtime limits.
      4. Generate a 32-byte hex DB password and store it as the site secret `SITE_DB_PASSWORD`.
      5. Store the typed password as the site secret `WP_ADMIN_PASSWORD_INITIAL`.
      6. Insert the `site_databases` row.
      7. Enqueue `site.provision`:
         - `resourceType "site"`, `lockKey "site:<siteId>"`, `idempotencyKey`;
         - steps `create_database`, `deploy_site`, `install_wordpress`, `publish_site`, `finish`;
         - `outboxPayload { title, adminUser, adminEmail }`. These are not secrets; the enqueue check rejects secret keys.
  - **`POST /v1/organizations/:orgId/managed-sites`:**
    - permission `site.create`; `Idempotency-Key` required; body `CreateManagedSiteInputSchema`;
    - calls `create`;
    - returns `202 { data: { siteId, operationId } }` plus `links.operation`, in the shape of the existing async endpoints;
    - audit `site.create` with `{ domain }`, and no secrets.
  - **`SiteProvisioner.provision(op)`.** Before each step it calls `renewOperationLease(db, op.id, SITE_STEP_LEASE_MS = 12 * 60_000)`. The claim resets the lease to 60 s, and the longest step (one `runSiteJob`, 510 s) must finish inside the lease. Each step updates its `operation_steps` row with a **fixed** message (e.g. "Database ready", "Could not finish this step"):
    1. **`create_database`:** `runSiteJob({ kind: "db.provision", jobId: "job_<op-suffix>_db", params: { dbName, dbUser }, resolvedSecrets: { HP_DB_PASSWORD } })`.
    2. **`deploy_site`:** `executor.deployService(await buildApprovedServiceSpec(…))`, then rebind the docker resource and record the observed state, as the deploy path does today.
    3. **`install_wordpress`:** a `wordpress.install` job with `siteUrl: "http://<primary domain>"`, the payload fields, and secrets `HP_DB_PASSWORD` and `HP_ADMIN_PASSWORD`. On success, delete `WP_ADMIN_PASSWORD_INITIAL`.
    4. **`publish_site`:** set the primary domain `active`, then deploy again. The spec now carries the domain, so the executor writes the route; the container is recreated with the same volume.
    5. **`finish`:** site `ready`, operation `succeeded`, audit `site.provision.succeeded`.
    - **A non-zero job exit fails that step.** The step message stays fixed. `operations.error_message` is set to "Site setup did not finish". The job's `outputTail` goes **only** into the admin-only audit event `site.provision.failed` (`details: { step, exitCode, outputTail }`). Customers lack `audit.read`, while `mapOperationToDto` exposes `steps[].message` and `errorMessage` to every org member. The operation becomes `failed` and the site `degraded`; the domain stays `pending`.
  - **Managed-site guard on the generic routes** (`organizations.controller.ts`). These refuse a site with `php_version IS NOT NULL` with `VALIDATION_ERROR` "Manage this site from its page":
    - `POST sites/:siteId/services`;
    - `POST services/:serviceId/revisions`;
    - `POST services/:serviceId/lifecycle`;
    - `POST secrets` and `DELETE secrets/:secretId` with that `siteId`.

    This stops the image being swapped (any name matching the multi-user pattern gets four capabilities), `php_version` going stale, and the `site:` lock being bypassed. Independently, `POST/DELETE secrets` refuse any `isPlatformSecretKey(key)` at any scope.
  - **`ManagedSitesService.act(siteId, organizationId, "retry", actorId)`:** allowed only when the site is `degraded` and its latest `site.provision` (looked up by `resource_id`) is `failed`. It re-enqueues `site.provision` with the same steps and payload; otherwise `VALIDATION_ERROR` "There is nothing to retry." The other actions are in Task 8.
  - **Recovery:** `recoverUnknownOperations` converges `site.provision`, `site.delete` and `site.reassign` in `unknown` straight to `failed` and sets the site `degraded`. It never replays them (TH-08 rule).

- [ ] **Step 1: Write the failing tests** in `managed-sites.integration.test.ts`. Use a customer created via `POST /v1/admin/customer-account`, then logged in.
  - `creates a WordPress site and provisions it end to end`:
    - the POST returns 202; after `worker.processPendingOnce()` the operation is `succeeded` and all five steps are `succeeded`;
    - `simulator.jobs.map(j => j.kind)` equals `["db.provision", "wordpress.install"]`;
    - `simulator.deployedSpecs` has two entries for the site: the first with `domains: []` (deployed before the install), the second with `domains: ["hotel.it"]`;
    - `GET sites/:id` returns status `ready` and `phpVersion "8.4"`;
    - `WP_ADMIN_PASSWORD_INITIAL` no longer exists.
  - `the site is not routed until WordPress is installed`: `failNextJob("wordpress.install", 1)` → the domain is still `pending`, and the only deployed spec has `domains: []`.
  - `a provisioned site has no secret refs and is deployed without secrets`: the `web` revision has `secret_refs = {}`, and every deployed spec has no `resolvedSecrets`.
  - `repeating a create with the same Idempotency-Key returns the original 202`: the same `siteId` and `operationId`, one `sites` row, no `DOMAIN_CONFLICT`.
  - `a step running past 60 s keeps its lease`. Use fake timers or an injected clock:
    1. Claim the op; during `create_database`, the simulator's job hook advances the clock by 61 s and runs `markExpiredOperationsUnknownTransactional`.
    2. The op is not `unknown`, and the provision ends `succeeded`.
  - `a service.deploy that takes past 60 s keeps its lease` (same clock technique, through `PATCH runtime`).
  - `customer cannot overwrite platform secrets`: `POST secrets { secretKey: "SITE_DB_PASSWORD", siteId }` → 400, and so do `HP_X` at org scope and `DELETE` of the platform secret's id.
  - `generic service routes refuse a managed site`: a new revision with `image: "nginx:latest"` and a lifecycle `deploy` on the site's service → 400 "Manage this site from its page".
  - `failure output stays out of customer-visible fields`: `failNextJob` with an `outputTail` containing `ERROR 1045 (28000)` → that text is absent from the operation GET (`steps[].message`, `errorMessage`) and present in the `site.provision.failed` audit details.
  - `rejects a domain used by another site or by the panel`:
    - a second `hotel.it` → 409 `DOMAIN_CONFLICT`;
    - the panel hostname → 409;
    - `"Hotel.IT."` → 409.
  - `no secret reaches the outbox, the operation DTO or the audit log`: the canary `canary-Pass-123456` is absent from `outbox_events.payload`, `operation_steps.message`, `operations.error_message`, `audit_events.details`, the operation GET and the captured executor stdout.
  - `retry after a failed install reuses the database`:
    1. `failNextJob("wordpress.install", 1)` → `failed` and `degraded`.
    2. `POST …/actions {action:"retry"}` → 202, then `succeeded`.
    3. Exactly one `site_databases` row, and both `db.provision` jobs received the same `HP_DB_PASSWORD`.
  - `interrupted site.provision converges to failed, not replayed`.
  - `customer without site.create gets 403` (a `customer_collaborator` fixture).
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm run build && corepack pnpm exec vitest run apps/api/test/managed-sites.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Extract `service-spec.ts` first and rerun `phase2-api.integration.test.ts` unchanged to prove the refactor. Then add the service, provisioner, controller and the `retry` path of `POST …/actions`.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(api): create and provision WordPress sites`.

---

### Task 8: API — lifecycle, PHP version, delete and logs

**Files:**
- Modify: `apps/api/src/sites/managed-sites.service.ts`, `controllers/managed-sites.controller.ts`, `runtime/site-provisioner.ts` (`remove`), `outbox-worker.service.ts`
- Test: `apps/api/test/managed-sites.integration.test.ts`

**Interfaces (produces).** Every service method takes `(siteId, organizationId, …, actorId)`, so Task 9's admin controller reuses them unchanged.
- **`POST /managed-sites/:siteId/actions`** sets `desiredStatus` and enqueues the existing operation with `lockKey "site:<siteId>"`:

  | Action | `desiredStatus` | Operation | Permission |
  |---|---|---|---|
  | `start` | `running` | `service.restart` | `service.restart` |
  | `stop` | `stopped` | `service.stop` | `service.stop` |
  | `restart` | — | `service.restart` | `service.restart` |
  | `retry` | — | (Task 7) | `site.create` |

  Response: 202.
- **`PATCH /managed-sites/:siteId/runtime`** with `ChangeSiteRuntimeInputSchema`:
  - `appendStackRevisionTransactional` with `image = resolveWordpressImage(php)` (everything else copied);
  - update `sites.php_version` and enqueue `service.deploy` with the site lock;
  - files survive because the volume name depends only on the service id;
  - permission `service.deploy`.
- **`DELETE /managed-sites/:siteId`** with `DeleteSiteInputSchema`:
  - permission `site.delete`;
  - `confirmName.trim()` must equal the site name, otherwise `VALIDATION_ERROR` on `confirmName`;
  - enqueue `site.delete` with the site lock (the existing lock check returns `RESOURCE_LOCKED` while a site operation is active);
  - set the site to `maintenance`.
- **`SiteProvisioner.remove(op)`** (renews the lease before each step, like `provision`):
  1. a `db.drop` job per `site_databases` row, first, so a drop failure leaves the site still serving rather than offline;
  2. `deleteService` for each service;
  3. `purgeSite`;
  4. delete the `sites` row (cascade);
  5. audit `site.delete.succeeded`.
  - A failed `db.drop` fails the operation and keeps the rows, so retrying delete is safe.
- **`GET /managed-sites/:siteId/logs?tail=200`:**
  - permission `service.logs.read`; tail clamped to 1..500;
  - returns `{ data: SiteLogLineDto[] }` for the site's `web` service;
  - `503 DOCKER_ENGINE_UNAVAILABLE` when the executor is down or answers `NOT_SUPPORTED`.
- **Every `managed-sites/:siteId` route** loads the site with `WHERE id = :siteId AND organization_id = :orgId` and answers 404 otherwise, before any permission-specific work.

- [ ] **Step 1: Write the failing tests:**
  - `stop then start sets desired status and enqueues the matching operation`.
  - `delete while provisioning returns RESOURCE_LOCKED`.
  - `delete requires the exact site name` → 400 on `confirmName`.
  - `delete drops the site database and keeps the other site serving`:
    - create sites A and B, then delete A;
    - a `db.drop` job runs only for A's identifiers, plus `purgeSite("A")`;
    - `GET sites/A` → 404;
    - B is still `running` and its `site_databases` row is intact.
  - `changing PHP version creates a revision with the new image and redeploys`: `declarativeConfig.image` is `wordpress:7.1.4-php8.5-apache`, the deploy succeeds, and `phpVersion` is `"8.5"`.
  - `logs return demuxed lines and clamp tail`.
  - `customer cannot act on a site of another organization`: with a site in org B (or unassigned in platform-ops), the customer of org A calls `actions`, `PATCH runtime`, `DELETE` and `logs` under `/v1/organizations/<A>/managed-sites/<B's site>` → 404 each, and no operation is enqueued.
  - `a failed database drop keeps the site serving`: `failNextJob("db.drop", 1)` → the operation is `failed`, the service is still `running`, and the rows remain.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(api): site start/stop/restart, PHP version change, delete and logs`.

---

### Task 9: API — server administrator creates, assigns and reassigns sites

**Files:**
- Create: `apps/api/src/controllers/admin-sites.controller.ts`, `apps/api/src/auth/server-admin.guard.ts`
- Modify:
  - `packages/policy-engine/src/host-allocation.ts`;
  - `apps/api/src/controllers/admin-users.controller.ts` (uses the extracted guard; behavior unchanged);
  - `apps/api/src/sites/managed-sites.service.ts` (`ensureAdminHoldingAllocation`, `listAll`, `reassign`);
  - `apps/api/src/runtime/site-provisioner.ts` (`reassign` step);
  - `apps/api/src/controllers/hosts.controller.ts` (`#resolveHostOperationOrganizationId` must skip `PLATFORM_OPS_ORG_ID`; it imports the constant from contracts).
- Test: `packages/policy-engine/test/policy-engine.test.ts`, `apps/api/test/admin-sites.integration.test.ts`

**Interfaces (produces):**
- **Allocation policy.** `evaluateHostAllocationAdmission` ignores existing allocations whose `organizationId === PLATFORM_OPS_ORG_ID` when it applies the dedicated rule. Allocating to `PLATFORM_OPS_ORG_ID` is always admitted on a ready dedicated host. `AC-F1-01` still refuses a second *customer* org.
- **`ManagedSitesService.ensureAdminHoldingAllocation()`:** returns the `org_platform_ops` allocation id. It creates the org (same values as `hosts.controller.ts`) and an `active` dedicated allocation if missing.
- **Admin endpoints** use the same guard as `admin-users.controller.ts`: an authenticated principal holding `platform.users.manage` (only `infrastructure_admin` has it; TOTP is already enforced at login for that role). Extract the private `#guard` into `apps/api/src/auth/server-admin.guard.ts` (`requireServerAdmin(authz, req, targetId)`) and use it from both controllers. Each endpoint records an `admin.site.*` audit event.
  - **`GET /v1/admin/sites`** → `{ data: AdminSitesListDto }`:
    - `sites`: every managed site (`php_version IS NOT NULL`) in every org, with `owner` null for platform-ops, ordered by name;
    - `customers`: every org other than platform-ops that has an active allocation, with its `customer_owner`'s email.
  - **`POST /v1/admin/sites`** with `AdminCreateSiteInputSchema` and `Idempotency-Key` → 202. The target org is `ownerOrganizationId`, which must be a customer org with an active allocation (else `NOT_FOUND`). `ownerOrganizationId === PLATFORM_OPS_ORG_ID` is refused with `VALIDATION_ERROR`, because platform-ops now has an active allocation and would otherwise pass; "unassigned" is spelled `null`. With `null`, the target is platform-ops via `ensureAdminHoldingAllocation`. Then it calls `ManagedSitesService.create`.
  - **`POST /v1/admin/sites/:siteId/owner`** with `ChangeSiteOwnerInputSchema` → 202. It enqueues `site.reassign` (`lockKey "site:<siteId>"`; payload `{ fromOrganizationId, toOrganizationId }`). `PLATFORM_OPS_ORG_ID` as a target is refused like above. The same org returns `VALIDATION_ERROR` "The site already belongs to this customer.", **unless** the latest `site.reassign` of the site failed. In that case it enqueues a `site.reassign` whose `move_ownership` step is `skipped` and which only redeploys, so a half-done move can be finished.
  - **`POST /v1/admin/sites/:siteId/actions`** (`retry` only) and **`DELETE /v1/admin/sites/:siteId`** (with `confirmName`) delegate to the Task 7/8 service methods with the site's current org.
- **`SiteProvisioner.reassign(op)`**, steps `move_ownership` then `redeploy` (lease renewed before each). The move also carries the site's operations to the new org (Task 1), so the old owner can no longer list them and `retry` still finds them:
  1. `moveSiteToOrganizationTransactional` (Task 1). The target allocation is the customer's active one or the platform-ops one.
  2. Then `deployService(buildApprovedServiceSpec(...))`, so the container's `organization_id` label matches. Otherwise the out-of-band check would report drift. The site is down for a few seconds.
  3. Audit `admin.site.reassign.succeeded` with `{ from, to }`.
- **Customer visibility** is unchanged code: `GET /v1/organizations/:orgId/sites` and every `managed-sites` route are org-scoped, so a site in platform-ops or another org is 404 for the customer.

- [ ] **Step 1: Write the failing tests:**
  - `policy-engine.test.ts`:
    - `platform-ops allocation does not occupy a dedicated host`: existing = [platform-ops active] → a customer org is admitted.
    - Existing = [platform-ops, customer A] → customer B is refused with `DEDICATED_HOST_OCCUPIED`.
  - `admin-sites.integration.test.ts`:
    - `admin creates a site for the customer and the customer sees and manages it`:
      1. The admin POSTs with `ownerOrganizationId` = the customer org and the worker processes it.
      2. The customer's `GET sites` lists it.
      3. The customer's stop action → 202.
    - `customer cannot see an unassigned site until it is assigned to them`:
      1. The admin creates with `ownerOrganizationId: null`.
      2. The customer's `GET sites` is empty, and `GET sites/<id>` under their org → 404.
      3. The admin reassigns to the customer and the worker processes it.
      4. The customer sees it and its `managed-sites/:id/logs` → 200.
    - `reassigned site keeps serving and its secrets decrypt under the new owner`:
      - after the move, `simulator.deployedSpecs` (last entry) has `organizationId` = the customer org;
      - a following `PATCH runtime` (redeploy) succeeds;
      - `resolveDecryptedSecretRefs` under the customer org returns the DB password.
    - `customer cannot call admin site endpoints` → 403 on `GET /v1/admin/sites`, `POST /v1/admin/sites` and `POST /v1/admin/sites/:id/owner`.
    - `admin cannot name platform-ops as an owner` → 400 on create and on reassign.
    - `the old owner loses the site's history`: after unassigning, the customer's `GET operations` no longer lists the site's provision.
    - `a failed reassign can be finished`: `simulator.failNextDeploy()` during `redeploy` → `failed`. Repeating the same owner change → 202, `move_ownership` `skipped`, `succeeded`, and the last deployed spec has the new `organizationId`.
    - `admin list includes the customers for the owner select`: `customers` has the one customer org with its owner email, and no platform-ops entry.
    - `admin sees all sites`: one customer-created and one unassigned site both appear, with `owner` set and null respectively.
    - `admin create rejects an unknown owner` → 404.
    - `admin actions are audited`: there are `admin.site.create` and `admin.site.reassign` audit rows with the admin's `actorId`.
    - `customer account creation still works while platform-ops holds a site`: an unassigned site first, then `POST /v1/admin/customer-account` → 201.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm run build && corepack pnpm exec vitest run packages/policy-engine apps/api/test/admin-sites.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** The existing `AC-F1-01` tests must still pass unchanged.
- [ ] **Step 5: Commit** `feat(api): server admin creates, assigns and reassigns WordPress sites`.

---

### Task 10: Web — customer creates a site

**Files:**
- Create:
  - `apps/web/src/app/sites/new/page.tsx`;
  - `apps/web/src/components/customer/site-form.tsx`;
  - `apps/web/src/components/customer/site-progress.tsx`;
  - BFF routes `app/api/bff/orgs/[orgId]/managed-sites/route.ts` (POST) and `managed-sites/[siteId]/actions/route.ts` (POST).
- Modify: `app/sites/page.tsx` (empty state), `components/customer/top-bar.tsx` ("New site" in the switcher), `app/sites/[siteId]/page.tsx` (progress while `deploying`/`degraded`), `app/sites/[siteId]/layout.tsx` (primary action), `i18n/it.ts`, `i18n/en.ts`
- Test: `apps/web/test/create-site.test.ts`, plus the `ui-copy` and `i18n` tests

**Interfaces:**
- **Consumes:** the Task 7 endpoint; `bff-guard`, `bff-response` and `upstream` (same shape as `bff/orgs/[orgId]/sites/route.ts`); the existing operation BFF route; `fetchServerOrgOperations`.
- **Produces:**
  - **`SiteForm`.** It is shared with the admin dialog in Task 12, through the props `onSubmit(body)`, `submitting`, `fieldErrors` and an optional `extraFields` slot.
    - Fields: Site name, Web address (hint: "e.g. hotelbellavista.it — you will point it to this server in a later step"), Site title, Admin username, Admin email, Admin password (show/hide, at least 12).
    - A collapsed "Advanced" section holds "PHP version" (`8.4` is preselected, labelled "recommended").
  - **`/sites/new`:**
    - one `Idempotency-Key` per page instance (`crypto.randomUUID()` in a `useRef`);
    - on 202, `router.push("/sites/<siteId>")`;
    - `DOMAIN_CONFLICT` → "This web address is already used. Check for typos or choose another address.";
    - zod issues are shown on their fields.
  - **`SiteProgress`:**
    - polls the latest `site.provision` operation every 2 s until it is terminal;
    - step labels `site.progress.{create_database,deploy_site,install_wordpress,finish}`: "Preparing the database", "Starting your site", "Installing WordPress", "Done";
    - on `failed`: "We could not finish setting up your site. Try again — if it fails again, contact your administrator." plus **Try again** (`action: "retry"`);
    - survives reloads (spec §3.2).
  - **Header primary action:** "Open WP Admin ↗" → `http://<primary>/wp-admin/` (2b switches it to https).
  - **Empty state:** "Create your first site" plus a button to `/sites/new`. Also: "Your administrator can also create it for you."

- [ ] **Step 1: Write the failing tests:**
  - `managed-sites BFF requires an idempotency key and forwards to the API`: no key → 400; with a key, `fetchUpstream` is called with `v1/organizations/<org>/managed-sites` and the same key (the pattern of `bff.integration.test.ts`).
  - `IT and EN dictionaries have the same keys` (existing parity test; new keys included).
  - `new customer copy has no infrastructure vocabulary` (the existing `ui-copy` scan over the new keys, against the Global Constraints list).
  - `empty state links to /sites/new`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/web/test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Then click through once in `pnpm dev` with `HP_RUNTIME_BACKEND=local-simulator`: progress should reach "Done".
- [ ] **Step 5: Commit** `feat(web): customer create-site form with live setup progress`.

---

### Task 11: Web — customer manages a site and reads logs

**Files:**
- Create:
  - `apps/web/src/components/customer/site-actions.tsx`;
  - `apps/web/src/components/customer/delete-site-dialog.tsx`;
  - `apps/web/src/app/sites/[siteId]/logs/page.tsx`;
  - BFF routes `managed-sites/[siteId]/route.ts` (DELETE), `[siteId]/runtime/route.ts` (PATCH) and `[siteId]/logs/route.ts` (GET).
- Modify: `components/customer/site-tabs.tsx` (`SITE_TABS` gains `logs`), `app/sites/[siteId]/page.tsx` ("Manage" card), the `ACTIVITY` map (`site.provision` → "Site created"), `i18n/it.ts`, `i18n/en.ts`
- Test: `apps/web/test/site-manage.test.ts`

**Interfaces (produces):**
- **"Manage" card:**
  - Start, Stop and Restart; only the valid ones are enabled. Each disables while its operation runs and shows the result inline.
  - A "PHP version" select with the line "Your site restarts for a few seconds."
  - A danger-zone "Delete site".
- **`DeleteSiteDialog`** (shared with Task 12 through `onConfirm(confirmName)`):
  - Text: "This will permanently delete **<name>**: all its files, its database and its web address setup. This cannot be undone. Backups arrive in a later update, so download anything you need first." IT equivalent.
  - The user types the site name to enable the button.
  - On 202, navigate to `/sites`.
- **Logs tab:**
  - "Visits" (stdout) and "Errors" (stderr), the last 200 lines, newest first, monospaced, with "Refresh".
  - Empty: "Nothing to show yet."
  - 503: "Logs are not available right now. Try again in a minute."
  - Times are shown in the user's locale.

- [ ] **Step 1: Write the failing tests:**
  - `delete BFF forwards confirmName and requires CSRF`.
  - `runtime BFF rejects a PHP version outside the list before calling upstream`.
  - `logs BFF clamps tail and forwards`.
  - `SITE_TABS includes overview and logs in that order`.
  - IT/EN parity and the vocabulary scan.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Click through once with the simulator.
- [ ] **Step 5: Commit** `feat(web): site controls, PHP version, delete confirmation and logs tab`.

---

### Task 12: Web — admin Sites page (create for a customer, change owner)

**Files:**
- Create:
  - `apps/web/src/app/admin/sites/page.tsx`;
  - `apps/web/src/components/admin/sites-table.tsx`;
  - `create-site-for-customer-dialog.tsx`;
  - `change-owner-dialog.tsx`;
  - BFF routes `app/api/admin/sites/route.ts` (GET, POST), `app/api/admin/sites/[siteId]/owner/route.ts` (POST), `[siteId]/actions/route.ts` (POST) and `[siteId]/route.ts` (DELETE).
- Modify: `components/layout/sidebar-nav.tsx` ("Sites" entry), `i18n/it.ts`, `i18n/en.ts`
- Test: `apps/web/test/admin-sites.test.ts`

**Interfaces:**
- **Consumes:** the Task 9 endpoints (the owner select is filled from `AdminSitesListDto.customers`); `SiteForm` (Task 10); `DeleteSiteDialog` (Task 11); the BFF route pattern of `app/api/admin/users/route.ts`.
- **Produces:**
  - **Table columns:** Name, Web address, Owner ("Not assigned" when null), PHP, and Status (the existing `StatusPill`).
  - **Row actions:** "Change owner", "Try again" (only when `degraded`), "Delete".
  - **`CreateSiteForCustomerDialog`:** `SiteForm` plus an "Owner" select listing the customer accounts (org name and owner email) and "Not assigned yet". The default is the only customer when exactly one exists.
  - **`ChangeOwnerDialog`:** the same select. Confirmation copy: "<site> will move to <owner>. They will see and manage it from their panel. The site restarts for a few seconds." For "Not assigned", the copy is "The customer will no longer see this site."
  - The admin console may use technical words. The status pill and its copy are reused, so no new jargon reaches customers.

- [ ] **Step 1: Write the failing tests:**
  - `admin sites BFF forwards create with ownerOrganizationId and an idempotency key`.
  - `owner BFF forwards null for not assigned`.
  - `admin sites BFF rejects a customer session` (403 from the guard, as the existing admin routes test).
  - `sidebar lists Sites for server admins`.
  - IT/EN parity.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Then click through once with the simulator:
  1. As admin, create an unassigned site, then assign it.
  2. As the customer, see it appear.
- [ ] **Step 5: Commit** `feat(web): admin sites page with create-for-customer and change owner`.

---

### Task 13: Docs, ADR, harness and version

**Files:**
- Create: `docs/architecture/adr/0016-shared-mariadb-and-site-jobs.md`
- Modify:
  - `README.md` (Italian): a "Siti WordPress" section covering PHP versions, admin creation and assignment, and where the MariaDB data and key live. The installation section states **minimum 2 GB RAM**.
  - `HARNESS.md`: project map entries `shared-database.ts`, `site-jobs.ts` and `docker-logs.ts`; `mariadb-root.key` in the key list.
  - `.agents/brain/state.md`: Step 2a status.
  - `docs/api/openapi.yaml`: the `managed-sites` and `admin/sites` endpoints.
  - root `package.json` `version` → `0.3.0`.
- Test: `apps/api/test/infra-layout.test.ts`

**Interfaces:** ADR 0016 records:
- why MariaDB is a platform container running as its own `hp-mariadb` user (not `hp-executor`, which is in the `docker` group) with a persistent root key file (`CP-01` and reboots without the control plane), and why root is limited to the admin subnet;
- why tags rather than digests are pinned for now (Docker Hub re-pushes tags for rebuilds; digest pins come with Step 6 "Updates");
- the single timeout budget and the per-step lease renewal;
- why job containers rather than `docker exec`;
- why no site holds a runtime secret;
- the WordPress image's capability reason;
- the platform-ops holding org and its `AC-F1-01` exemption;
- ownership moves with AAD re-encryption.

The capability flags are unchanged (`acmeTlsRuntimeAvailable` turns true in 2b).

- [ ] **Step 1: Write the failing test** `step 2a docs are consistent`:
  - `README.md` contains `WordPress`, `mariadb-root.key` and `2 GB`;
  - `openapi.yaml` contains `/v1/organizations/{orgId}/managed-sites` and `/v1/admin/sites`;
  - ADR 0016 exists;
  - the version is `0.3.0`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Write the docs and bump the version.**
- [ ] **Step 4: Run it and confirm it passes, plus the four checks.**
- [ ] **Step 5: Commit** `docs: step 2a WordPress sites, shared MariaDB ADR and API reference`.

---

### Task 14: Live acceptance in disposable systemd containers (manual)

Use the same harness as `docs/security/step-1b-acceptance-report.md`: privileged systemd containers as VMs, with named volumes for `/var/lib/docker` and `/var/lib/containerd`. Give each container a 2 GB memory limit (`--memory 2g`) to exercise the minimum. Run the full checklist on **Ubuntu 26.04** and **Debian 13**, and steps 1–2 on **Ubuntu 24.04** and **Debian 12**. There is no public DNS, so sites are reached with `curl -H 'Host: <domain>' http://<container-ip>/`. Record the results in `docs/security/step-2a-acceptance-report.md`.

- [ ] **Step 1: Install.** Install `0.3.0` from a release archive. Expected:
  - exit 0, and step 12 reports `hp_mariadb` running;
  - `mariadb-root.key` is `0400 hp-executor`;
  - `docker inspect hp_mariadb` shows no published port, `CapAdd` null and `User` = the hp-executor UID.
  - Run `HP_MEMINFO_FILE=<fixture with MemTotal: 1500000 kB> install.sh --dry-run …`: the RAM warning is printed and the plan still reaches step 12. A container `--memory` limit does not change `/proc/meminfo`, so a real warning needs a real 1 GB VM.
- [ ] **Step 2: The customer creates a site** through the BFF: `hotel.test`, title `L'Hôtel "Bella"`. Expected:
  - the operation succeeds in under 3 minutes (record the time);
  - before the operation reaches `publish_site`, `curl -H 'Host: hotel.test'` gets the proxy's 404, so WordPress's installer is never public;
  - afterwards curl shows the title verbatim;
  - `/wp-login.php` accepts the chosen admin;
  - the default post's permalink `/hello-world/` answers 200 (the rewrite rules work), and `.htaccess` holds both the `hosting-panel` and the `WordPress` blocks;
  - `docker exec hp_mariadb sh -c 'mariadb -uroot -p"$(cat /run/secrets/mariadb-root)" -e "SHOW DATABASES"'` lists `wp_<12 hex>`;
  - no `HP_*PASSWORD` value appears in any `docker inspect` or in `journalctl -u 'hp-*'`.
- [ ] **Step 3: The admin creates and assigns a site.**
  1. The admin creates `bellavista.test` with "Not assigned yet": the customer's list does not show it.
  2. The admin assigns it to the customer: the customer sees it, can stop and start it, and reads its logs.
  3. The admin sets it back to "Not assigned": it disappears from the customer's panel and still answers on `curl`.
- [ ] **Step 4: Change PHP and use the controls.** Switch `hotel.test` to PHP 8.5: content and admin login survive. Then Stop (the proxy returns 404), Start (200), Restart. Logs show the curl requests under "Visits".
- [ ] **Step 5: Retry after a failure.**
  1. Block egress 443 inside the test VM, with the PHP 8.3 images not pre-pulled, and create a PHP 8.3 site: "Problem" plus "Try again".
  2. Unblock and press Try again: it succeeds, with one database user (`SELECT User FROM mysql.user`). The admin account chosen at creation still logs in.
  3. Ask a site container for root: `docker exec <wordpress container> php -r 'new mysqli("hp-mariadb","root",trim(file_get_contents("php://stdin")));' < /etc/hosting-panel/mariadb-root.key` is refused (`Access denied`), because root is limited to the admin subnet.
- [ ] **Step 6: CP-01.**
  1. `systemctl stop hp-web hp-api hp-docker-executor hp-host-agent`: all sites keep answering.
  2. With the units still stopped, `systemctl restart docker`: all sites and `hp_mariadb` return by themselves and WordPress serves pages from the database.
  3. `docker restart <vm>` with `hp-api` masked: same result.
  4. Unmask and start the units: nothing is recreated (`docker ps` IDs are unchanged).
- [ ] **Step 7: Update and rerun.** `hp-update` to `0.3.1`: a curl loop on `hotel.test` sees no failure, and the IDs of `hp_mariadb` and the site containers are unchanged. Rerun `install.sh`: the `mariadb-root.key` checksum is unchanged.
- [ ] **Step 8: Delete.** The customer deletes `hotel.test`. Expected:
  - its volume, both networks, `site_<id>.yml`, the `wp_<…>` database and its user are gone;
  - `bellavista.test` still answers.
- [ ] **Step 9: Write the report and commit** `docs(security): step 2a live acceptance report`.

**Needs a real VM (not this harness):** nothing in 2a depends on public DNS or Let's Encrypt. On a real 2 GB VPS, check:
- memory use with three WordPress sites plus MariaDB;
- a real kernel reboot (not a container restart) for the step 6 `CP-01` check;
- image pull time on a normal uplink.

2b's acceptance needs a real VM with a public IPv4 and the owner's test domain.

---

## Following sub-plans (each gets its own file, written after the previous one merges)

**Step 2b — Domains, DNS check, Let's Encrypt, HTTPS redirect** (`2026-11-08-step-2b-domains-dns-tls.md`)
- **Domains tab, for the customer and on the admin Sites page:**
  - add and remove domains;
  - `www` and the bare domain as a pair, with a choice of primary (the other redirects);
  - aliases, since site routes already accept several hosts;
  - the server IP and the exact A records to create.
- **DNS check:** run by the API with `node:dns` `Resolver` against public resolvers.
  - It runs on demand ("Check now") and on a backoff schedule.
  - It warns about AAAA records pointing elsewhere.
  - The status is `Waiting for DNS` until the domain resolves here.
- **Routes:**
  - The HTTPS router gets `tls.certResolver: le` **only after DNS passes**, so Let's Encrypt is never hammered.
  - HTTP redirects to HTTPS once a certificate exists.
  - The ACME resolver must always be present, so `--acme-email` becomes mandatory at install.
- **Certificate status:** read from `acme.json` by the executor, read-only, through `X509Certificate`. Traefik renews certificates itself, so renewal also works while the control plane is down (`CP-01`).
- **Failures:** "not pointing here", "port 80 blocked" and "rate limited" each come with a plain next step.
- **Admin alerts:** an in-panel alert for certificates expiring in under 14 days.
- A `wordpress.set-url` job switches WordPress to `https://`.
- `acmeTlsRuntimeAvailable` → `true`.
- **Live acceptance:** on a real VM with the owner's test domain (staging, then production).
- **Preview addresses stay deferred** (owner decision).

**Step 2c — Outgoing mail relay for WordPress sites** (`2026-11-08-step-2c-smtp-relay.md`)
- **Admin settings:** host, port, user, encrypted password and sender domain, plus "Send test email".
- **Relay container:** a platform `hp_mail_relay` container on the site internal networks under the alias `hp-mail`. It accepts mail only from site networks and forwards it, authenticated, to the admin's relay.
- **WordPress:** a read-only mu-plugin points PHPMailer at SMTP `hp-mail:25`.
- **PHP `mail()`:** a read-only `php.ini` drop-in sets `sendmail_path` to a bundled PHP sendmail shim, because the image has no sendmail.
- **Relay password:** a tmpfs secret that the API rehydrates at boot. While the control plane is down, sites still serve and mail is deferred. This is the one accepted `CP-01` degradation; write it into the ADR.
- **Recent failures:** visible to the admin.
- **SPF/DKIM:** a plain-language hint for the customer.
- **Panel password-reset email:** sent through the relay once it is configured.
- **Live acceptance:** a real inbox needs a real VM and a relay account.

---

## Self-review notes

- **Spec coverage (step 2a part):**
  - §3.3, WordPress only (owner decision): Tasks 0, 4, 7.
  - PHP version per site: Tasks 0, 8, 11.
  - Per-site network isolation and hardening: Tasks 3, 4.
  - One shared MariaDB, with a database and user per site: Tasks 3, 4, 7.
  - Create, start, stop, restart and delete with a confirmation: Tasks 7, 8, 11. The final-backup offer is deferred to Step 3, and the dialog says so.
  - §4 Sites, admin creation and assignment: Tasks 9, 12.
  - §5, 2 GB minimum: Tasks 3, 13.
  - §3.1 empty state and "Open WP Admin": Task 10.
  - §3.2 no jargon, plain errors, progress that survives reloads: Tasks 10, 11.
  - §3.11 logs: Tasks 2, 8, 11.
  - §9 `CP-01`: Global Constraints, Tasks 3 and 4 tests, Task 14 step 6.
  - Docker socket only in the executor: Task 4.
  - No secrets in env, logs or revisions: Tasks 4, 6, 7.
  - ADR and docs: Task 13.
- **Deferred on purpose:**
  - Domains, TLS and the `www` pair: 2b.
  - Mail: 2c.
  - Customer database management and phpMyAdmin: Step 4.
  - Admin start/stop/logs on a customer's site through the site-first support view: Step 6. The 2a admin page covers create, owner, retry and delete.
  - Image update UI and digest pins: Step 6.
  - Preview addresses: deferred by the owner.
- **Known risks to verify live (Task 14):**
  - the MariaDB entrypoint as a non-root UID with a bind-mounted data dir;
  - `wp core install --prompt` reading stdin from a file;
  - first-pull time against the 240 s pull budget (a slow uplink fails cleanly and "Try again" resumes);
  - two `active` allocations (platform-ops and the customer) on one host, for any other code path that assumes one. Grep for `hostAllocations.status, "active"` in Task 9;
  - a fixed admin subnet (`172.30.250.0/24`) colliding with an existing host or Docker network. Network creation then fails loudly, and `HP_MARIADB_ADMIN_SUBNET` overrides it.
