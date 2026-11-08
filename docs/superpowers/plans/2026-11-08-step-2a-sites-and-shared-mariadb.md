# Step 2a — Sites, Site Types and Shared MariaDB — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note (why Step 2 is split):** Spec step 2 bundles four subsystems that share almost no code: (1) site runtimes plus a shared database server, (2) domain ownership, DNS checks and certificates, (3) an outgoing mail relay injected into site runtimes, and (4) the UI for each. Planning them together would give one plan of roughly 30 tasks whose last half could not be tested until the first half shipped. They are therefore split into three plans, each ending in software that works on a server:
- **2a (this plan):** sites, the three site types, the shared MariaDB, lifecycle and logs. A site answers over plain HTTP on the address the customer typed.
- **2b:** domains, DNS check, Let's Encrypt and HTTPS.
- **2c:** the SMTP relay.

2b and 2c both build on the site runtimes from 2a. Neither depends on the other. Mail delivery is only meaningful once sites have their real domains, so 2b comes before 2c. The later plans are listed at the end of this file.

**Goal:** A customer opens "Create your first site", picks WordPress, a static site or a PHP app, and types a name and a web address. For WordPress they also give a site title and admin account. A few minutes later the site is running: WordPress is already installed on its own database in one shared MariaDB server. The customer can start, stop, restart and delete it, change its PHP version, and read its recent visit and error logs. Every site keeps serving when the control plane is down or the host reboots (`CP-01`).

**Architecture:**
- **One site = one container.** This is the existing service model. Each site type maps to one official or vetted image, and the API decides that mapping (`resolveSiteRuntime`). The four-type catalog is fixed in code. The service-template table only keeps three rows so the existing foreign keys stay valid.
- **Shared MariaDB is a platform component,** like the ingress proxy. `hp-docker-executor` creates `hp_mariadb` with the following properties:
  - its data lives in a host directory owned by `hp-executor`, and it runs as that UID with no capabilities;
  - its root password is a persistent key file in `/etc/hosting-panel`;
  - it attaches to every site's internal network under the alias `hp-mariadb`;
  - it publishes no host port.
- **Setup work runs in allowlisted one-off job containers** (`runSiteJob`): create or drop a database, install WordPress with `wp-cli`, write a placeholder page.
  - The API chooses a job *kind* and passes validated parameters. The executor owns the image, user, network, mounts and the fixed shell script.
  - Job secrets use the existing tmpfs `*_FILE` mechanism (`ADR-015`) and are purged when the job ends.
- **No site needs a runtime secret.** WordPress keeps its DB password in its own `wp-config.php`, written once by the install job, as on any WordPress host. A host reboot with the control plane down therefore brings every site back with no panel involvement (`CP-01`).

**Tech Stack:** The existing TypeScript monorepo (NestJS + Fastify, Next.js 16, Drizzle, Vitest), Docker Engine REST API v1.45. **No new npm dependencies.** New container images, all checked on Docker Hub on 2026-11-08:

| Purpose | Image (exact tag pinned) | Why |
|---|---|---|
| Shared database | `mariadb:12.3.3` | 12.3 is the current MariaDB LTS (the `lts` tag = 12.3.3). 13.0 is a short-term release; 13.1 is RC. |
| WordPress runtime | `wordpress:7.1.4-php{8.3,8.4,8.5}-apache` | WordPress 7.1.4 is the newest. Apache variant: one container, `.htaccess` works. |
| WordPress setup | `wordpress:cli-2.12.0-php{8.3,8.4,8.5}` | wp-cli 2.12.0 is current, with the same PHP minor as the site. |
| Static runtime | `nginx:1.30.6-alpine` | 1.30.x is the current stable branch (1.31.x is mainline). |
| PHP app runtime | `serversideup/php:{8.3.36,8.4.27,8.5.12}-fpm-apache-trixie-v5.1.1` | It has pdo_mysql and mysqli, runs unprivileged as `www-data` 33:33 on port 8080, and sets `APACHE_DOCUMENT_ROOT` from env. The official `php:*-apache` has no MySQL extensions and cannot be extended without building our own images. **(builder's call; see open question 1)** |

PHP 8.2 is left out because its security support ends on 31 Dec 2026. 8.6 is only an RC.

**Spec:** `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md`, mainly §3.1, §3.2, §3.3, §3.11, §6, §8 step 2 and §9. Builds on Steps 1a and 1b: `docs/superpowers/plans/2026-11-08-step-1a-accounts-login-i18n-shell.md` and `…-step-1b-installer-and-releases.md`.

## Global Constraints

- **Site types in this plan:** `wordpress`, `static`, `php`.
  - `node` is deferred until Step 4 delivers files, since a Node site has no way to receive code before then (spec §3.3 "may slip").
  - These are the only things a customer can create (spec §3.3, owner decision). The service-template catalog stays hidden from the product.
- **PHP versions offered:** `8.3`, `8.4`, `8.5`. The default is `8.4`. Image tags come only from `packages/contracts/src/site-runtime.ts`, so Step 6 "Updates" has one place to bump.
- **`CP-01`:**
  - Site containers, `hp_mariadb` and the proxy all use `RestartPolicy: unless-stopped` and need nothing from `/run/hosting-panel` at runtime.
  - `hp_mariadb` and the proxy are recreated **only** when their image or config actually changed.
  - The updater never touches them.
- **Hardening:**
  - Every container (site, job, MariaDB) keeps `CapDrop: ALL`, `no-new-privileges`, CPU, memory and pids limits, and no host port.
  - The only extra capabilities are the existing certified set, granted by the existing image pattern (WordPress and nginx start as root and drop to `www-data`/`nginx`). Write that reason into `ADR-0016`.
- **Docker socket only in the executor.** The API never names an image, command, mount or network for a job. It only picks a `SiteJobKind`.
- **No secrets in:** env, argv, DTOs, revisions, outbox payloads or logs. Job secrets reach the job only as `/run/secrets/<NAME>` files, and the scripts read them through stdin redirection or shell builtins. The WordPress admin password the customer types is stored as an encrypted site secret, and deleted once the install succeeds.
- **Customer console:**
  - No "container", "image", "Docker", "volume", "network", "revision", "service", "template", "MariaDB" or "job" vocabulary. Call it "database", not "MariaDB".
  - IT and EN for every new string; Italian is the default.
  - Every error says what to do next.
  - Delete uses a confirmation that names the consequence.
- **Resource defaults** (per site, in `resolveSiteRuntime`):
  - WordPress and PHP: `cpuMilli 1000`, `memoryBytes "536870912"`.
  - Static: `cpuMilli 250`, `memoryBytes "134217728"`.
  - `hp_mariadb`: 1 GiB, `NanoCpus` 1 CPU, `PidsLimit 512`.
- **Fresh installs only** (spec §5). Migration `0004` is additive.
- Every task ends green on `corepack pnpm run build && corepack pnpm run lint && corepack pnpm run typecheck && corepack pnpm run test`. Workspace packages are consumed through `dist`, so run `build` after editing `packages/*`.

## Review Focus

1. **The host reboots, or `docker.service` restarts, while every panel unit is stopped.** WordPress, static and PHP sites and `hp_mariadb` must come back and serve without the API or executor. Tested in Task 4 (`site containers carry no tmpfs secret binds`), Task 3 (`mariadb payload binds only persistent host paths`) and live in Task 12, step 6.
2. **Provisioning fails halfway**, for example on an image pull error, an executor restart, or a wp-cli failure. The site shows "Problem" with "Try again". A retry reuses the database and user, never installs WordPress twice, and keeps the admin account. Tested in Task 7 (`retry after a failed install reuses the database and skips an installed WordPress`, and `interrupted site.provision converges to failed, not replayed`).
3. **The web address is already used** by another site, by the panel's own hostname or IP, or is an IP, a wildcard, or has uppercase letters or a trailing dot. Duplicates are rejected in plain language. Case and the trailing dot are normalized, so `Hotel.IT.` becomes `hotel.it`. Tested in Task 0 (`normalizeSiteDomain`) and Task 7 (`rejects a domain used by another site or by the panel`).
4. **Customer text contains quotes, `$()` or newlines.** For example the title `L'Hôtel "Bella" $(id)`, or an admin password with spaces. Values reach WordPress verbatim, and nothing is interpreted by a shell or SQL. Tested in Task 4 (`wordpress.install passes customer values only as env and never inside Cmd`, and `rejects a db identifier outside the pattern`) and Task 0 (`rejects an admin password with a newline`).
5. **Delete while provisioning, or delete one of two sites.** The first is refused with `RESOURCE_LOCKED`. The second removes only that site's files, database, user, networks and route. Tested in Task 5 (`purgeSite removes only volumes and networks labelled with that site`) and Task 8 (`delete while provisioning returns RESOURCE_LOCKED`, and `delete drops the site database and keeps the other site serving`).

---

## File map

| Area | Files |
|---|---|
| Site catalog and input contracts | `packages/contracts/src/site-runtime.ts` (new), `resources.ts`, `operations.ts`, `ipc-schemas.ts`, `index.ts` |
| Data model | `packages/database/migrations/0004_sites_and_databases.sql` (new), `src/schema.ts`, `src/sites-repository.ts` (new), `src/index.ts` |
| Executor port | `packages/executor-contracts/src/port.ts`, `phase1-executor.ts` |
| Executor runtime | `apps/docker-executor/src/docker-logs.ts` (new), `shared-database.ts` (new), `site-jobs.ts` (new), `docker-engine-adapter.ts`, `simulator-adapter.ts`, `server.ts`, `client.ts`, `main.ts` |
| API | `apps/api/src/runtime/service-spec.ts` (new, extracted), `runtime/site-provisioner.ts` (new), `runtime/outbox-worker.service.ts`, `controllers/managed-sites.controller.ts` (new), `controllers/organizations.controller.ts` (DTO mapping only), `app.module.ts`, `create-app.ts` |
| Web | `apps/web/src/app/sites/new/page.tsx`, `components/customer/create-site-wizard.tsx`, `site-progress.tsx`, `site-actions.tsx`, `delete-site-dialog.tsx`, `app/sites/[siteId]/logs/page.tsx`, BFF routes under `app/api/bff/orgs/[orgId]/managed-sites/`, `i18n/it.ts`, `i18n/en.ts` |
| Infra and docs | `infra/linux/bootstrap-dedicated.sh`, `infra/linux/install.sh`, `docs/architecture/adr/0016-shared-mariadb-and-site-jobs.md` (new), `README.md`, `HARNESS.md`, `.agents/brain/state.md`, `docs/api/openapi.yaml` |

---

### Task 0: Site catalog and input contracts

**Files:**
- Create: `packages/contracts/src/site-runtime.ts`
- Modify: `packages/contracts/src/resources.ts` (`SiteSummaryDtoSchema`), `operations.ts` (`OPERATION_KINDS`), `index.ts`
- Test: `packages/contracts/test/site-runtime.test.ts`

**Interfaces (produces):**
- `SITE_TYPES = ["wordpress", "static", "php"] as const`, `type SiteType`.
- `SUPPORTED_PHP_VERSIONS = ["8.3", "8.4", "8.5"] as const`, `type PhpVersion`, `DEFAULT_PHP_VERSION: PhpVersion = "8.4"`.
- `SHARED_MARIADB_IMAGE = "mariadb:12.3.3"`.
- `resolveSiteImage(type: SiteType, php: PhpVersion | null): string`. The PHP patch per minor is `{ "8.3": "8.3.36", "8.4": "8.4.27", "8.5": "8.5.12" }` for serversideup. Throws when `php` is null for wordpress or php.
- `resolveWordpressCliImage(php: PhpVersion): string` → `wordpress:cli-2.12.0-php<php>`.
- `interface SiteRuntime { image: string; internalPort: number; contentPath: string; volumeSuffix: "html"; env: Record<string, string>; resourceLimits: { cpuMilli: number; memoryBytes: string }; containerUser: "33:33" | "0:0" }`.
- `resolveSiteRuntime(input: { type: SiteType; phpVersion: PhpVersion | null; documentRoot: string | null }): SiteRuntime`:

  | Type | Port | Content path | Env | Job user |
  |---|---|---|---|---|
  | wordpress | 80 | `/var/www/html` | `{}` | `33:33` |
  | static | 80 | `/usr/share/nginx/html` | `{}` | `0:0` |
  | php | 8080 | `/var/www/html` | `APACHE_DOCUMENT_ROOT=/var/www/html` plus `/<documentRoot>` when non-empty, and `PHP_OPCACHE_ENABLE=1` | `33:33` |

  `containerUser` is the UID that owns the content; jobs that write content run as it.
- `SITE_DOCUMENT_ROOT_PATTERN = /^(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)?$/`. Segments `.` and `..` are rejected separately.
- `SITE_DB_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{2,31}$/`.
- `normalizeSiteDomain(raw: string): string | null`:
  - trims, lower-cases and strips one trailing dot;
  - requires at least one dot and labels per RFC 1123 (the same shape as the executor's `SAFE_DOMAIN_PATTERN`, but no `*.`);
  - rejects IPv4/IPv6 literals and anything over 253 chars.
- `CreateManagedSiteInputSchema`: zod `discriminatedUnion("type")`.
  - Common fields: `name` (1–80, trimmed) and `domain` (string; `normalizeSiteDomain` must not return null, otherwise the issue is on path `domain`).
  - `wordpress` adds:
    - `phpVersion?` (default `DEFAULT_PHP_VERSION`);
    - `title` (1–120);
    - `adminUser` (`/^[A-Za-z0-9._@-]{3,60}$/`);
    - `adminEmail` (email);
    - `adminPassword` (12–128, no `\r`, `\n` or `\0`).
  - `static` adds nothing.
  - `php` adds `phpVersion?` and `documentRoot?` (default `"public"`, must match the pattern).
- `SiteActionInputSchema = z.object({ action: z.enum(["start", "stop", "restart", "retry"]) })`.
- `ChangeSiteRuntimeInputSchema = z.object({ phpVersion: z.enum(SUPPORTED_PHP_VERSIONS) })`.
- `DeleteSiteInputSchema = z.object({ confirmName: z.string() })`.
- `SiteLogLineDtoSchema = z.object({ at: IsoDateTimeSchema.nullable(), stream: z.enum(["stdout", "stderr"]), text: z.string() })`.
- `SiteSummaryDtoSchema` gains `siteType: z.enum(SITE_TYPES).nullable()` and `phpVersion: z.enum(SUPPORTED_PHP_VERSIONS).nullable()`. Null means a legacy Phase 2 row.
- `OPERATION_KINDS` gains `"site.provision"` and `"site.delete"`.

- [ ] **Step 1: Write the failing tests** in `site-runtime.test.ts`:
  - `resolveSiteImage pins exact tags`: `("wordpress","8.4")` → `wordpress:7.1.4-php8.4-apache`; `("php","8.5")` → `serversideup/php:8.5.12-fpm-apache-trixie-v5.1.1`; `("static",null)` → `nginx:1.30.6-alpine`; `("php",null)` throws.
  - `resolveSiteRuntime php sets the document root`: `documentRoot "public"` → env `APACHE_DOCUMENT_ROOT === "/var/www/html/public"` and `internalPort === 8080`; `documentRoot ""` → `/var/www/html`.
  - `normalizeSiteDomain`:
    - `" Hotel.IT. "` → `"hotel.it"`;
    - `null` for each of `"localhost"`, `"203.0.113.5"`, `"*.hotel.it"`, `"hotel..it"`, `"a b.it"`, `"[::1]"`, `"-x.it"` and a 254-char name.
  - `CreateManagedSiteInputSchema`:
    - accepts a full wordpress body and defaults `phpVersion` to `"8.4"`;
    - `rejects an admin password with a newline` (issue path `adminPassword`);
    - rejects `documentRoot "../etc"` and `"public/../x"`;
    - rejects `type: "node"`;
    - a wordpress title `L'Hôtel "Bella" $(id)` is accepted unchanged.
  - `SITE_DB_IDENTIFIER_PATTERN` accepts `wp_3f9a0c1b2d4e` and rejects `wp-1`, `Wp_x` and `x`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run packages/contracts/test/site-runtime.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `site-runtime.ts`** and the `resources.ts` and `operations.ts` changes. Export everything from `index.ts`. Fix every existing `SiteSummaryDto` producer the typecheck flags by mapping null for now; Task 1 adds the real columns.
- [ ] **Step 4: Run the tests and the four checks.** Expected: all PASS.
- [ ] **Step 5: Commit** `feat(contracts): site type catalog, pinned runtime images and managed-site inputs`.

---

### Task 1: Migration 0004 — site columns, site databases, site-type templates

**Files:**
- Create: `packages/database/migrations/0004_sites_and_databases.sql`, `packages/database/src/sites-repository.ts`
- Modify: `packages/database/src/schema.ts`, `src/index.ts`, `apps/api/src/cli/accounts.ts` (`setupInstallation`), `apps/api/src/create-app.ts` (call it after migrations)
- Test: `packages/database/test/sites-database.test.ts`

**Interfaces (produces):**
- **SQL migration:**
  - `ALTER TABLE sites ADD COLUMN IF NOT EXISTS site_type TEXT CHECK (site_type IS NULL OR site_type IN ('wordpress','static','php'))`;
  - `php_version TEXT CHECK (php_version IS NULL OR php_version IN ('8.3','8.4','8.5'))`;
  - `document_root TEXT`;
  - `CREATE TABLE IF NOT EXISTS site_databases (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, site_id TEXT NOT NULL, db_name TEXT NOT NULL UNIQUE, db_user TEXT NOT NULL UNIQUE, password_secret_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), FOREIGN KEY (site_id, organization_id) REFERENCES sites(id, organization_id) ON DELETE CASCADE)`.
- **Drizzle:** `sites.siteType`, `sites.phpVersion`, `sites.documentRoot`, and a new `siteDatabases` table.
- **`sites-repository.ts`:**
  - `SITE_TYPE_TEMPLATE_IDS = { wordpress: "tpl_site_wordpress", static: "tpl_site_static", php: "tpl_site_php" } as const`.
  - `ensureSiteTypeTemplates(db): Promise<void>`: upserts the three `service_templates` rows (slug = id, `category: "site"`, `defaultImage` = `resolveSiteImage(type, DEFAULT_PHP_VERSION or null)`, `defaultPort` from `resolveSiteRuntime`, `approvedForDedicated: true`). Idempotent; it updates `defaultImage` on rerun.
  - `insertSiteDatabase(tx, row): Promise<void>`.
  - `listSiteDatabases(db, { organizationId, siteId })`.
  - `latestSiteOperation(db, { organizationId, siteId, kind })`: returns the newest `operations` row, or null.
- `setupInstallation` and API startup (after `migrate()`) both call `ensureSiteTypeTemplates`, so `hp-update` also refreshes the image pins.

- [ ] **Step 1: Write the failing tests** (PGlite, following `packages/database/test/accounts-database.test.ts`):
  - `migration 0004 adds site columns and site_databases`: insert a site with `site_type 'wordpress'` and `php_version '8.4'`; `'node'` and `'7.4'` violate the checks.
  - `ensureSiteTypeTemplates is idempotent`: called twice → exactly three `tpl_site_*` rows, and `tpl_site_wordpress.default_image === "wordpress:7.1.4-php8.4-apache"`.
  - `site_databases cascade with the site`, and `db_name` is unique.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm run build && corepack pnpm exec vitest run packages/database/test/sites-database.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the migration, schema, repository and the two call sites. In `organizations.controller.ts`, map the DTO's `siteType` and `phpVersion` from the new columns.
- [ ] **Step 4: Run the tests and the four checks.**
- [ ] **Step 5: Commit** `feat(database): site types, per-site databases and site-type templates`.

---

### Task 2: Executor — per-request Docker timeouts and log demultiplexing

**Files:**
- Create: `apps/docker-executor/src/docker-logs.ts`
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts` (`DockerSocketHttpClient.request`, new `getServiceLogs`)
- Test: `apps/docker-executor/test/docker-logs.test.ts`, `apps/docker-executor/test/docker-executor.test.ts` (new `describe("service logs")`)

**Interfaces (produces):**
- `DockerSocketHttpClient.request(method, path, body?, options?: { timeoutMs?: number })`. The default stays 30 s. Image pulls use 600 s, because a first WordPress pull exceeds 30 s on slow links.
- `interface ServiceLogLine { at: string | null; stream: "stdout" | "stderr"; text: string }`, exported from `@hosting-panel/executor-contracts` in Task 6 and re-used here.
- `demuxDockerLogStream(buf: Buffer): ServiceLogLine[]`:
  - Parses Docker's 8-byte frame header (byte 0 = stream 1/2, bytes 4–7 = big-endian length).
  - Splits on `\n` and parses a leading RFC 3339 timestamp (requested with `timestamps=1`) into `at`.
  - Caps each line at 2000 chars.
  - A truncated last frame is ignored, not thrown.
- `DockerEngineSocketAdapter.getServiceLogs(serviceInstanceId: string, tail: number): Promise<ServiceLogLine[]>`:
  - `tail` is clamped to 1..500;
  - calls `GET /containers/<id>/logs?stdout=1&stderr=1&timestamps=1&tail=<n>`;
  - throws `NOT_FOUND` when the service has no container.

- [ ] **Step 1: Write the failing tests:**
  - `demuxDockerLogStream splits stdout and stderr frames`: build two frames by hand (`Buffer.concat([header(1,len), payload])`) → two lines with the right `stream`, `at` parsed and the text without the timestamp.
  - `demuxDockerLogStream ignores a truncated trailing frame`.
  - `getServiceLogs clamps tail and returns demuxed lines`: the mock daemon from `startMockDockerDaemon` answers the list and logs routes; the requested path contains `tail=500` when asked for 9999.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/docker-executor/test/docker-logs.test.ts apps/docker-executor/test/docker-executor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `{ timeoutMs: 600_000 }` from `ensureImageAvailable`'s pull call.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): service log tail with stream demux and per-request timeouts`.

---

### Task 3: Executor — shared MariaDB platform container

**Files:**
- Create: `apps/docker-executor/src/shared-database.ts`
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts`, `apps/docker-executor/src/main.ts`, `infra/linux/bootstrap-dedicated.sh`, `infra/linux/install.sh` (step 12 wait)
- Test: `apps/docker-executor/test/shared-database.test.ts`, `apps/api/test/infra-layout.test.ts`, `infra/linux/install.test.ts`

**Interfaces (produces):**
- **Constants:**
  - `SHARED_DB_CONTAINER_NAME = "hp_mariadb"`;
  - `SHARED_DB_NETWORK_NAME = "hp_mariadb_net"` (internal bridge);
  - `SHARED_DB_ALIAS = "hp-mariadb"`;
  - `DEFAULT_SHARED_DB_DATA_DIR = "/var/lib/hosting-panel/mariadb/data"`;
  - `DEFAULT_SHARED_DB_ROOT_KEY_FILE = "/etc/hosting-panel/mariadb-root.key"`.
- `buildSharedDatabaseContainerPayload(input: { image?: string; user: string; dataDirHostPath: string; rootKeyHostPath: string }): SharedDatabaseCreatePayload`:
  - `Image` defaults to `SHARED_MARIADB_IMAGE`; `User` = `input.user`.
  - `Env`: `MARIADB_ROOT_PASSWORD_FILE=/run/secrets/mariadb-root` and `MARIADB_AUTO_UPGRADE=1`.
  - `Cmd`: `["--innodb-buffer-pool-size=256M", "--max-connections=150", "--skip-name-resolve"]`.
  - `Labels`: `io.hostingpanel.managed=true` and `io.hostingpanel.role=shared_database`.
  - `HostConfig`:
    - `CapDrop ALL` with no `CapAdd`, `no-new-privileges`;
    - `Memory` and `MemorySwap` 1073741824, `NanoCpus` 1e9, `PidsLimit` 512;
    - `RestartPolicy unless-stopped`, `NetworkMode hp_mariadb_net`;
    - `Binds`: `<data>:/var/lib/mysql` and `<key>:/run/secrets/mariadb-root:ro`;
    - no `PortBindings`.
  - `NetworkingConfig` alias `hp-mariadb`.
  - Throws `HOST_POLICY_DENIED` if any path contains `docker.sock`.
- `DockerEngineSocketAdapter.ensureSharedDatabase(): Promise<{ component: "shared_database"; status: "running" }>`:
  - Serialised like `ensureIngressProxy`.
  - Ensures `hp_mariadb_net` (internal) and the image.
  - Creates the container if missing. Recreates it **only** if `Image`, `Cmd`, `User`, the sorted `Binds` or the sorted `Env` differ. Starts it if stopped.
  - Then reattaches it to every network labelled `io.hostingpanel.network_role=site_internal`, with alias `hp-mariadb`. It skips a network that has disappeared, using the `skipMissingNetwork` pattern.
- `deployService`: after `ensureNetwork(siteNetwork)`, connects `hp_mariadb` to the site network with alias `hp-mariadb`. A 404 (no MariaDB yet) is ignored.
- Adapter options gain `sharedDbDataDir?`, `sharedDbRootKeyFile?` and `sharedDbImage?`.
- `main.ts`: with the real Docker backend, after the IPC server starts it calls `ensureSharedDatabase()`. A failure (including a missing key file) is logged as `{"event":"shared_database_ensure_failed","code":…}` and retried every 60 s. It never crashes the executor, and it runs independently of the panel-ingress retry.
- **Bootstrap:**
  - Generates `/etc/hosting-panel/mariadb-root.key` (32-byte hex, `0400 hp-executor:hp-executor`, created only if absent, written via temp + `mv` like `ipc.key`).
  - Creates `/var/lib/hosting-panel/mariadb/data` (`0700 hp-executor`).
  - The dry-run lists both.
- **`install.sh` step 12** also waits for `hp_mariadb` running (same mechanism as `hp_ingress_proxy`). The final key-backup warning now lists `mariadb-root.key`.

- [ ] **Step 1: Write the failing tests:**
  - `mariadb payload binds only persistent host paths`:
    - Binds equal exactly `["/var/lib/hosting-panel/mariadb/data:/var/lib/mysql", "/etc/hosting-panel/mariadb-root.key:/run/secrets/mariadb-root:ro"]`;
    - nothing under `/run/hosting-panel`;
    - no `PortBindings`; `CapAdd` undefined; `Env` contains no value from the key file.
  - `mariadb payload refuses docker.sock`.
  - `ensureSharedDatabase does not recreate an up-to-date container`: with the mock daemon, inspect returns a matching config, and no DELETE or create is made. A second case where only `Image` differs recreates it.
  - `deployService attaches hp_mariadb to the site network with alias hp-mariadb`: the mock records `POST /networks/hp_site_<id>_net/connect` with `Container: "hp_mariadb"` and `Aliases: ["hp-mariadb"]`.
  - `infra-layout.test.ts` → `bootstrap dry-run provisions the mariadb key and data dir`: the dry-run output contains `mariadb-root.key`, `0400` and `/var/lib/hosting-panel/mariadb/data`. Skip it under the same conditions as the existing dry-run test.
  - `install.test.ts` → `dry-run step 12 waits for hp_mariadb`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Also run `bash -n` on both scripts.
- [ ] **Step 5: Commit** `feat(docker-executor): shared MariaDB platform container attached to site networks`.

---

### Task 4: Executor — allowlisted site job containers

**Files:**
- Create: `apps/docker-executor/src/site-jobs.ts`
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts` (`runSiteJob`, `cleanupOrphanJobs`, `prewarmSiteImages`), `main.ts` (startup calls)
- Test: `apps/docker-executor/test/site-jobs.test.ts`

**Interfaces:**
- **Consumes:** `writeServiceSecrets`, `purgeServiceSecrets`, `getManagedVolumeName`, `getSiteInternalNetworkName`, `ensureSharedDatabase`, `SHARED_DB_*`, the Task 2 demux and timeouts, and `resolveSiteImage`, `resolveWordpressCliImage`, `resolveSiteRuntime`, `SITE_DB_IDENTIFIER_PATTERN` and `SITE_DOCUMENT_ROOT_PATTERN` from contracts.
- **Produces:**
  - `type SiteJobKind = "db.provision" | "db.drop" | "wordpress.install" | "site.placeholder"` (in executor-contracts, Task 6).
  - `interface SiteJobRequest { jobId: string; kind: SiteJobKind; siteId: string; organizationId: string; serviceInstanceId?: string; params: Readonly<Record<string, string>>; resolvedSecrets?: Readonly<Record<string, string>> }`.
  - `interface SiteJobResult { jobId: string; exitCode: number; outputTail: string }`. `outputTail` holds the last 50 lines, at most 4 KiB, passed through `redactSensitiveString`.
  - `buildSiteJobContainerPayload(req: SiteJobRequest, ctx: { executorUser: string; secretBinds: readonly string[]; secretFileEnv: readonly string[]; rootKeyHostPath: string }): JobContainerPayload`. It is pure and validates every param. The kinds:

  | Kind | Required params | Secrets | Image | User | Network | Mounts |
  |---|---|---|---|---|---|---|
  | `db.provision` | `dbName`, `dbUser` (`SITE_DB_IDENTIFIER_PATTERN`) | `HP_DB_PASSWORD` | `SHARED_MARIADB_IMAGE` | `executorUser` | `hp_mariadb_net` | root key `:ro` |
  | `db.drop` | `dbName`, `dbUser` | — | `SHARED_MARIADB_IMAGE` | `executorUser` | `hp_mariadb_net` | root key `:ro` |
  | `wordpress.install` | `phpVersion`, `dbName`, `dbUser`, `siteUrl` (`http://` + `normalizeSiteDomain` result), `title` (1–120), `adminUser`, `adminEmail` | `HP_DB_PASSWORD`, `HP_ADMIN_PASSWORD` | `resolveWordpressCliImage(phpVersion)` | `33:33` | site internal net | site volume `html` → `/var/www/html` |
  | `site.placeholder` | `siteType` (`static`\|`php`), `phpVersion?`, `documentRoot?` | — | `resolveSiteImage(siteType, phpVersion)` | `resolveSiteRuntime(...).containerUser` | none (`NetworkMode: "none"`) | site volume `html` → `contentPath` |

  - Every job container uses:
    - `Cmd: ["sh", "-c", <fixed script for the kind>]`, with params only as `Env` entries `HP_<UPPER_SNAKE>`;
    - the `secretFileEnv` entries;
    - `Labels` `io.hostingpanel.managed=true`, `io.hostingpanel.role=site_job`, `io.hostingpanel.site_id` and `io.hostingpanel.job_id`;
    - `CapDrop ALL`, `no-new-privileges`, `PidsLimit 128`, 512 MiB, 1 CPU, no restart policy, no ports.
  - Unknown kinds, extra params, and params failing their pattern or length throw `VALIDATION_ERROR`. Params are validated by an explicit per-kind allowlist; no param is ever spliced into the script text.
- **Fixed scripts** (constants in `site-jobs.ts`, `set -eu`):
  - **`db.provision`:**
    1. Builds the client config with the builtin `printf '[client]\nuser=root\npassword=%s\nhost=hp-mariadb\n' "$(cat /run/secrets/mariadb-root)" > /tmp/c.cnf`.
    2. Retries `mariadb --defaults-extra-file=/tmp/c.cnf -e 'SELECT 1'` for up to 60 s.
    3. Runs a heredoc to the `mariadb` client: ``CREATE DATABASE IF NOT EXISTS `$HP_DB_NAME`; CREATE USER IF NOT EXISTS '$HP_DB_USER'@'%' IDENTIFIED BY '<password read via $(cat /run/secrets/HP_DB_PASSWORD)>'; ALTER USER … IDENTIFIED BY …; GRANT ALL PRIVILEGES ON `$HP_DB_NAME`.* TO '$HP_DB_USER'@'%';``.
    - The heredoc is stdin, never argv. Identifiers are pre-validated, and the API generates the password as hex. The `ALTER USER` makes a retry re-sync the password.
  - **`db.drop`:** the same connection, then ``DROP DATABASE IF EXISTS `…`; DROP USER IF EXISTS '…'@'%';``.
  - **`wordpress.install`** (workdir `/var/www/html`):
    1. Waits up to 120 s for `wp-includes/version.php`, which the runtime container's entrypoint copies; exit 10 if it never appears.
    2. `[ -f wp-config.php ] || wp config create --dbname="$HP_DB_NAME" --dbuser="$HP_DB_USER" --dbhost=hp-mariadb --skip-check --prompt=dbpass < /run/secrets/HP_DB_PASSWORD`.
    3. `wp core is-installed || wp core install --url="$HP_SITE_URL" --title="$HP_TITLE" --admin_user="$HP_ADMIN_USER" --admin_email="$HP_ADMIN_EMAIL" --skip-email --prompt=admin_password < /run/secrets/HP_ADMIN_PASSWORD`.
    4. `wp rewrite structure '/%postname%/' --hard`.
    5. Prepends this block to `.htaccess` only if the marker is absent (2b relies on it for HTTPS behind the proxy):

       ```
       # BEGIN hosting-panel
       SetEnvIf X-Forwarded-Proto "^https$" HTTPS=on
       # END hosting-panel
       ```
  - **`site.placeholder`:** in `<contentPath>/<documentRoot>`, `mkdir -p` it, and if neither `index.html` nor `index.php` exists, write `$HP_PLACEHOLDER_HTML` with `printf '%s'`. The HTML is a constant bilingual page ("Il sito è pronto — carica i tuoi file / Your site is ready — upload your files"), passed as env.
- **`DockerEngineSocketAdapter.runSiteJob(req): Promise<SiteJobResult>`:**
  1. `assertSafeIdentifier(jobId)`, then build the payload (validation first).
  2. Pull the image. `ensureSharedDatabase()` for the `db.*` kinds.
  3. `writeServiceSecrets(secretsRoot, req.jobId, req.resolvedSecrets)`.
  4. Create the container (name = `jobId`) and start it.
  5. `POST /containers/<id>/wait` with a 300 s timeout. On timeout, kill and treat as exit 124.
  6. Fetch the log tail and remove the container (`force=true`).
  7. In a `finally`, call `purgeServiceSecrets(secretsRoot, jobId)`.
  - A non-zero exit returns a result; it does not throw. Transport failures throw `DOCKER_ENGINE_UNAVAILABLE`.
- `cleanupOrphanJobs()`: removes every container labelled `role=site_job` and purges every `job_*` directory under the secrets root. Called once at executor start.
- `prewarmSiteImages()`: fire-and-forget pull, at start, of the default-PHP images (WordPress runtime and cli, nginx, the PHP app image) plus `SHARED_MARIADB_IMAGE`. Failures are logged only. This makes first-site creation take seconds instead of minutes.
- Also add the test `site containers carry no tmpfs secret binds`: `buildHardenedContainerCreatePayload` for a spec built from `resolveSiteRuntime("wordpress", "8.4")` with no `resolvedSecrets` → no bind under `/run/hosting-panel`, and no `*_FILE` env.

- [ ] **Step 1: Write the failing tests** in `site-jobs.test.ts`:
  - `wordpress.install passes customer values only as env and never inside Cmd`: title `L'Hôtel "Bella" $(id)` → `Cmd[2]` (the script) contains neither `Bella` nor `$(id)`, and `Env` contains `HP_TITLE=L'Hôtel "Bella" $(id)` verbatim. No `Env` entry contains the admin password (canary `canary-Pass-123456`); `Env` contains `HP_ADMIN_PASSWORD_FILE=/run/secrets/HP_ADMIN_PASSWORD`.
  - `rejects a db identifier outside the pattern`: `dbName: "x; DROP"` → `VALIDATION_ERROR`.
  - `rejects unknown kinds and unexpected params`.
  - `db jobs run on hp_mariadb_net as the executor user with the root key read-only`.
  - `site.placeholder has no network and writes into the document root`: `NetworkMode === "none"`; for php with `documentRoot "public"`, `HP_TARGET_DIR=/var/www/html/public`.
  - `job payloads are hardened`: `CapDrop ["ALL"]`, `SecurityOpt` contains `no-new-privileges:true`, no `PortBindings`, no `RestartPolicy` other than `no`.
  - `runSiteJob purges secrets even when the job fails` (mock daemon: wait returns `StatusCode 3`) → result `exitCode 3`, and the `job_*` secrets dir is gone.
  - `runSiteJob times out at 300 s and reports exit 124`: inject the timeout through an adapter option `jobTimeoutMs` (set to 50 ms in the test).
  - `site containers carry no tmpfs secret binds` (above).
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/docker-executor/test/site-jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): allowlisted site job containers for database and WordPress setup`.

---

### Task 5: Executor — purge a deleted site's leftovers

**Files:**
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts`, `apps/docker-executor/src/traefik-config.ts` (`removeSiteRoutes(siteId)`)
- Test: `apps/docker-executor/test/docker-executor.test.ts` (new `describe("purge site")`)

**Interfaces (produces):**
- `TraefikIngressFileManager.removeSiteRoutes(siteId: string): Promise<void>`: drops the in-memory maps for the site and `rm -f` its `site_<id>.yml`.
- `DockerEngineSocketAdapter.purgeSite(siteId: string): Promise<void>`, in order:
  1. If any container labelled `io.hostingpanel.site_id=<siteId>` other than a `site_job` still exists, throw `RESOURCE_LOCKED`. The API deletes services first.
  2. Remove leftover `site_job` containers of the site.
  3. Disconnect `hp_ingress_proxy` from `hp_edge_<id>_net` and `hp_mariadb` from `hp_site_<id>_net` (ignore 404).
  4. `DELETE` both networks (ignore 404).
  5. `DELETE` every volume listed with filter `label=io.hostingpanel.site_id=<siteId>`.
  6. `removeSiteRoutes(siteId)`.
  - Idempotent: a second call is a no-op.

- [ ] **Step 1: Write the failing tests:**
  - `purgeSite removes only volumes and networks labelled with that site`: the mock daemon lists volumes for sites A and B. After `purgeSite("A")`, DELETE calls target only A's volume and A's two networks, and `site_A.yml` is gone while `site_B.yml` remains.
  - `purgeSite refuses while a site container exists` → `RESOURCE_LOCKED`.
  - `purgeSite is idempotent`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): purge site volumes, networks and routes on delete`.

---

### Task 6: Executor port, IPC routes, client and simulator

**Files:**
- Modify:
  - `packages/executor-contracts/src/port.ts` and `phase1-executor.ts`;
  - `packages/contracts/src/ipc-schemas.ts`;
  - `apps/docker-executor/src/server.ts`, `client.ts` and `simulator-adapter.ts`.
- Test: `apps/docker-executor/test/docker-executor.test.ts` (IPC round-trip `describe("site IPC")`), `packages/executor-contracts/test/executor-contracts.test.ts`

**Interfaces (produces):**
- `DockerExecutorPort` gains:
  - `runSiteJob(req: SiteJobRequest): Promise<SiteJobResult>`;
  - `purgeSite(siteId: string): Promise<void>`;
  - `getServiceLogs(serviceInstanceId: string, tail: number): Promise<readonly ServiceLogLine[]>`.
  - `SiteJobKind`, `SiteJobRequest`, `SiteJobResult` and `ServiceLogLine` move here (the executor imports them).
  - `Phase1DisabledDockerExecutor` throws `NOT_SUPPORTED` for the first two and returns `[]` for logs.
- **IPC routes:** `POST /v1/jobs/run`, `POST /v1/sites/purge` and `POST /v1/services/logs`, with zod schemas `SiteJobIpcRequestSchema`, `SitePurgeIpcRequestSchema` and `ServiceLogsIpcRequestSchema` in `ipc-schemas.ts`. The job route redacts `resolvedSecrets` from every log line exactly as the deploy route does.
- **`SignedDockerExecutorIpcClient` per-call timeouts:**
  - `deployService` 330 s (the first deploy may pull an image);
  - `runSiteJob` 330 s;
  - `purgeSite` 120 s;
  - `getServiceLogs` 35 s (the default).
- **`InMemoryDockerSimulatorAdapter`:**
  - records jobs in `readonly jobs: SiteJobRequest[]`;
  - `failNextJob(kind: SiteJobKind, exitCode: number)` makes the next matching job fail once;
  - `setServiceLogs(serviceInstanceId, lines)` feeds `getServiceLogs`;
  - `purgeSite` deletes the site's simulated services;
  - `isWordpressInstalled(siteId)` is true after a successful `wordpress.install`. A second install job is still recorded, since the real idempotence lives in the script.

- [ ] **Step 1: Write the failing tests:**
  - `site IPC round-trips a job and never logs the secret`: run the signed server with the simulator. `client.runSiteJob({… resolvedSecrets: { HP_DB_PASSWORD: "canary-db-pw-7788" } })` returns `exitCode 0`, and the captured server stdout and stderr do not contain the canary.
  - `site IPC rejects an unknown job kind with VALIDATION_ERROR`.
  - `client uses 330 s for deploy and job requests`: assert on the request options through the existing client test seam.
  - `phase1 executor refuses site jobs with NOT_SUPPORTED`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(executor-contracts): site jobs, site purge and service logs over signed IPC`.

---

### Task 7: API — create a managed site and provision it

**Files:**
- Create:
  - `apps/api/src/runtime/service-spec.ts`: the extracted body of `#executeServiceDeploy` that builds the `ApprovedServiceSpec`. Behavior is unchanged; the existing deploy tests guard it.
  - `apps/api/src/runtime/site-provisioner.ts`;
  - `apps/api/src/controllers/managed-sites.controller.ts`.
- Modify: `apps/api/src/runtime/outbox-worker.service.ts` (dispatch and unknown recovery), `apps/api/src/app.module.ts`
- Test: `apps/api/test/managed-sites.integration.test.ts` (the `local-simulator` backend, as in `phase2-api.integration.test.ts`)

**Interfaces:**
- **Consumes:**
  - Tasks 0, 1 and 6;
  - `createSiteTransactional`, `createServiceWithRevisionTransactional`, `enqueueOperationTransactional` (fields `lockKey`, `leaseDurationMs`, `steps`), `upsertEncryptedSecretTransactional`, `resolveDecryptedSecretRefs`, `deleteEncryptedSecretTransactional`, `transitionOperation` and `updateOperationStepTransactional`.
- **Produces:**
  - `buildApprovedServiceSpec(db, config, { organizationId, serviceInstanceId }): Promise<ApprovedServiceSpec>` in `service-spec.ts`. The outbox worker's deploy path now calls it.
  - `siteDatabaseIdentifier(siteId: string): string` → `"wp_" + sha256(siteId).hex.slice(0, 12)`. It is used for both the DB name and the user, and it lives in `site-provisioner.ts`.
  - **`POST /v1/organizations/:orgId/managed-sites`:**
    - Permission `site.create`; `Idempotency-Key` required; body `CreateManagedSiteInputSchema`.
    - **Domain checks.** Reject with `DOMAIN_CONFLICT` when the normalized domain:
      - already exists in `domains`;
      - equals `hosts.hostname` or `hosts.ipv4`. Message: "This web address is already used by another site or by the panel."
    - **Allocation.** The org's `host_allocations` row with status `active`; `NOT_FOUND` if there is none.
    - **One transaction** containing:
      1. Create the site: slug = slugified name + `-` + 6 random hex; `site_type`, `php_version` (null for static) and `document_root` (php only); status `deploying`.
      2. Create the primary domain with status `active`. In 2a, active means "routed over plain HTTP"; 2b refines this into DNS and certificate states.
      3. Create the service `web` from `SITE_TYPE_TEMPLATE_IDS[type]` with configuration `{ image, internalPort, exposeHttp: true, volumeMounts: [{ volumeSuffix: "html", containerPath }], …runtime.env }` and `resourceLimits` from `resolveSiteRuntime`.
      4. For WordPress only:
         - generate a 32-byte hex DB password and upsert the site secret `SITE_DB_PASSWORD`;
         - upsert the site secret `WP_ADMIN_PASSWORD_INITIAL` with the customer's password;
         - insert the `site_databases` row.
      5. Enqueue `site.provision`: `resourceType "site"`, `resourceId siteId`, `lockKey "site:<siteId>"`, `leaseDurationMs 20 * 60_000`, and steps `create_database`, `deploy_site`, `install_wordpress` (or `prepare_content` for static and php), `finish`.
    - Response: `202 { data: { siteId, operationId } }` plus the `links.operation` shape used by the existing async endpoints. Audit `site.create` with `{ siteType, domain }`; no secrets.
  - **`SiteProvisioner.provision(op)`** (called by the outbox worker for `site.provision`). Each step updates its `operation_steps` row:
    1. **`create_database`** (WordPress): `runSiteJob({ kind: "db.provision", jobId: "job_<op-suffix>_db", params: { dbName, dbUser }, resolvedSecrets: { HP_DB_PASSWORD } })`. For other types the step is `skipped`.
    2. **`deploy_site`:** `executor.deployService(await buildApprovedServiceSpec(…))`, then rebind the docker resource and record the observed state, as the deploy path does today.
    3. **`install_wordpress`:** `runSiteJob` kind `wordpress.install`, with `siteUrl: "http://<primary domain>"`, the title, admin user and email (from the op's site row plus the secret), and secrets `HP_DB_PASSWORD` and `HP_ADMIN_PASSWORD`. On success, `deleteEncryptedSecretTransactional(WP_ADMIN_PASSWORD_INITIAL)`.
       - **Where the title, admin user and admin email live:** store them in the outbox payload. They are not secrets, and `enqueueOperationTransactional` already rejects secret keys.
    4. **`prepare_content`** (static and php): kind `site.placeholder`.
    5. **`finish`:** site status `ready`, operation `succeeded`, audit `site.provision.succeeded`.
    - A non-zero job exit fails that step with the job's `outputTail` in the step detail. That detail is admin-visible only; the customer DTO shows the step status alone. Then: operation `failed`, site status `degraded`, audit `site.provision.failed`.
  - **Recovery:** `recoverUnknownOperations` converges `site.provision` and `site.delete` in `unknown` straight to `failed` and sets the site `degraded`. It never replays them, matching the TH-08 rule for host operations.

- [ ] **Step 1: Write the failing tests** in `managed-sites.integration.test.ts`. Use a customer created through `POST /v1/admin/customer-account`, then logged in.
  - `creates a WordPress site and provisions it end to end`:
    - The POST returns 202. After `worker.processPendingOnce()`, the operation is `succeeded` with steps `create_database`, `deploy_site`, `install_wordpress` and `finish` all `succeeded`.
    - `simulator.jobs.map(j => j.kind)` equals `["db.provision", "wordpress.install"]`.
    - The site is `ready`; `GET sites/:id` returns `siteType "wordpress"` and `phpVersion "8.4"`.
    - The encrypted secret `WP_ADMIN_PASSWORD_INITIAL` no longer exists.
  - `static site skips the database and writes a placeholder`: jobs equal `["site.placeholder"]`, and `create_database` is `skipped`.
  - `rejects a domain used by another site or by the panel`: a second site on `hotel.it` → 409 `DOMAIN_CONFLICT`; the panel hostname → 409; `"Hotel.IT."` after `hotel.it` exists → 409.
  - `no secret reaches the outbox, the operation DTO or the audit log`: the canary admin password `canary-Pass-123456` is absent from the `outbox_events.payload`, `operation_steps.detail` and `audit_events.details` rows, and from the operation GET response.
  - `retry after a failed install reuses the database and skips an installed WordPress`:
    1. `simulator.failNextJob("wordpress.install", 1)` → the operation is `failed` and the site `degraded`.
    2. `POST …/actions {action:"retry"}` → 202; after processing, `succeeded`.
    3. Exactly one `site_databases` row. The second `db.provision` job received the **same** `HP_DB_PASSWORD` as the first; compare through `simulator.jobs`.
  - `interrupted site.provision converges to failed, not replayed`: force the op to `unknown` via `markExpiredOperationsUnknownTransactional`, then run `recoverUnknownOperations` → `failed`, and no new job is recorded.
  - `customer without site.create gets 403`: use a `customer_collaborator` fixture.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm run build && corepack pnpm exec vitest run apps/api/test/managed-sites.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Extract `service-spec.ts` first and rerun `phase2-api.integration.test.ts` unchanged to prove the refactor. The `retry` action lives in Task 8's handler, but its test is here, so implement `retry` in this task.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(api): create and provision WordPress, static and PHP sites`.

---

### Task 8: API — lifecycle, PHP version, delete and logs

**Files:**
- Modify: `apps/api/src/controllers/managed-sites.controller.ts`, `apps/api/src/runtime/site-provisioner.ts` (`remove`), `outbox-worker.service.ts` (dispatch `site.delete`)
- Test: `apps/api/test/managed-sites.integration.test.ts`

**Interfaces (produces):**
- **`POST /managed-sites/:siteId/actions`** with `SiteActionInputSchema`. Each action sets `desiredStatus` and enqueues the existing operation with `lockKey "site:<siteId>"`:

  | Action | `desiredStatus` | Operation | Permission |
  |---|---|---|---|
  | `start` | `running` | `service.restart` | `service.restart` |
  | `stop` | `stopped` | `service.stop` | `service.stop` |
  | `restart` | — | `service.restart` | `service.restart` |
  | `retry` | — | a new `site.provision` (Task 7) | `site.create` |

  - `retry` is allowed only when the site is `degraded` and its latest `site.provision` is `failed`; otherwise `VALIDATION_ERROR` "There is nothing to retry."
  - Response: 202 with the operation.
- **`PATCH /managed-sites/:siteId/runtime`** with `ChangeSiteRuntimeInputSchema`:
  - WordPress and PHP sites only; otherwise `VALIDATION_ERROR`.
  - `appendStackRevisionTransactional` with `image = resolveSiteImage(type, php)` (everything else copied from the current revision).
  - Update `sites.php_version` and enqueue `service.deploy` with `lockKey "site:<siteId>"`. The files survive because the `html` volume name depends only on the service id.
- **`DELETE /managed-sites/:siteId`** with `DeleteSiteInputSchema`:
  - Permission `site.delete`.
  - `confirmName.trim()` must equal the site name, or `VALIDATION_ERROR` on field `confirmName`.
  - Enqueue `site.delete` with `lockKey "site:<siteId>"`; the existing lock check returns `RESOURCE_LOCKED` while any site operation is active. Set the site status to `maintenance`.
- **`SiteProvisioner.remove(op)`:**
  1. `deleteService` for each service.
  2. A `db.drop` job for each `site_databases` row.
  3. `purgeSite(siteId)`.
  4. Delete the `sites` row (cascades domains, services, secrets and `site_databases`).
  5. Audit `site.delete.succeeded`.
  - A `db.drop` with a non-zero exit fails the operation and keeps the row, so retrying delete is safe.
- **`GET /managed-sites/:siteId/logs?tail=200`:**
  - Permission `service.logs.read`; `tail` is clamped to 1..500.
  - Returns `{ data: SiteLogLineDto[] }` from `getServiceLogs` of the site's `web` service, newest last.
  - If the executor is unavailable: `503 DOCKER_ENGINE_UNAVAILABLE`.

- [ ] **Step 1: Write the failing tests:**
  - `stop then start sets desired status and enqueues the matching operation`.
  - `delete while provisioning returns RESOURCE_LOCKED`: enqueue a create and do not process it; the DELETE → 409 `RESOURCE_LOCKED`.
  - `delete requires the exact site name` → 400 on `confirmName`.
  - `delete drops the site database and keeps the other site serving`:
    1. Create WordPress sites A and B and process both, then delete A.
    2. The simulator records a `db.drop` for A's identifiers only, and `purgeSite("A")`.
    3. `GET sites/A` → 404. B's service is still `running` in the simulator, and B's `site_databases` row is intact.
  - `changing PHP version creates a revision with the new image and redeploys`: the new revision's `declarativeConfig.image` is `wordpress:7.1.4-php8.5-apache`; the `service.deploy` operation succeeds; `phpVersion` is `"8.5"`.
  - `PHP version change on a static site is rejected`.
  - `logs return demuxed lines and clamp tail`: `simulator.setServiceLogs(...)` → the response has `stream` and `text`; `tail=9999` asks the executor for 500.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(api): site start/stop/restart, PHP version change, delete and logs`.

---

### Task 9: Web — create a site

**Files:**
- Create:
  - `apps/web/src/app/sites/new/page.tsx`;
  - `apps/web/src/components/customer/create-site-wizard.tsx`;
  - `apps/web/src/components/customer/site-progress.tsx`;
  - `apps/web/src/app/api/bff/orgs/[orgId]/managed-sites/route.ts` (POST) and `[siteId]/actions/route.ts` (POST, used by retry here and by Task 10).
- Modify: `apps/web/src/app/sites/page.tsx` (empty state), `components/customer/top-bar.tsx` ("New site" in the switcher), `app/sites/[siteId]/page.tsx` (show progress while `deploying`), `app/sites/[siteId]/layout.tsx` (primary action), `i18n/it.ts`, `i18n/en.ts`
- Test: `apps/web/test/create-site.test.ts`, `apps/web/test/ui-copy.test.ts` (extend if it does not scan new keys automatically)

**Interfaces:**
- **Consumes:** the Task 7 endpoint, the existing `bff-guard`, `bff-response` and `upstream` helpers (same shape as `bff/orgs/[orgId]/sites/route.ts`), the existing operation BFF route `bff/orgs/[orgId]/operations/[opId]`, and `latestSiteOperation` data via `fetchServerOrgOperations`.
- **Produces:**
  - **Wizard step 1:** three cards with plain copy.
    - IT: "WordPress — Un sito o blog che gestisci da solo (la scelta più comune)"; "Sito statico — Pagine semplici che carichi come file"; "Applicazione PHP — Per sviluppatori: Laravel e simili".
    - EN equivalents.
  - **Wizard step 2:** Name and "Web address" (hint: "e.g. hotelbellavista.it — you will point it to this server in a later step").
    - WordPress adds: Site title, Admin username, Admin email, Admin password (show/hide, ≥12).
    - PHP adds "Public folder" (default `public`).
    - A collapsed "Advanced" section holds the PHP version select (WordPress and PHP).
  - One `Idempotency-Key` per wizard instance (`crypto.randomUUID()` in a `useRef`). On 202 the wizard does `router.push("/sites/<siteId>")`.
  - API error codes map to plain messages. `DOMAIN_CONFLICT` → "This web address is already used. Check for typos or choose another address."; zod field issues are shown next to their field.
  - **`SiteProgress`:**
    - Polls the operation every 2 s until it is terminal.
    - Shows the steps with labels `site.progress.{create_database,deploy_site,install_wordpress,prepare_content,finish}`, e.g. "Preparing the database", "Starting your site", "Installing WordPress", "Preparing your site", "Done". Skipped steps are hidden.
    - On `failed`: "We could not finish setting up your site. Try again — if it fails again, contact your administrator." plus a **Try again** button (`action: "retry"`).
    - Survives reloads (spec §3.2), because it reads the latest `site.provision` op from the server.
  - **Header primary action:** WordPress → "Open WP Admin ↗" (`http://<primary>/wp-admin/`); otherwise the existing "Visit site ↗".
  - The empty state becomes "Create your first site" with a button to `/sites/new`.

- [ ] **Step 1: Write the failing tests:**
  - `managed-sites BFF requires an idempotency key and forwards to the API`: no header → 400; with a header, `fetchUpstream` is called with `v1/organizations/<org>/managed-sites` and the same key. Follow `bff.integration.test.ts`.
  - `IT and EN dictionaries have the same createSite and progress keys` (the existing i18n parity helper).
  - `new customer copy has no infrastructure vocabulary`: the existing `ui-copy` scan covers `createSite.*` and `site.progress.*` and finds none of the forbidden words (Global Constraints list).
  - `empty state links to /sites/new`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/web/test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Then click through it once in `pnpm dev` with `HP_RUNTIME_BACKEND=local-simulator`: create one site of each type and see progress reach "Done".
- [ ] **Step 5: Commit** `feat(web): create-site wizard with live setup progress`.

---

### Task 10: Web — manage, delete and read logs

**Files:**
- Create:
  - `apps/web/src/components/customer/site-actions.tsx`;
  - `apps/web/src/components/customer/delete-site-dialog.tsx`;
  - `apps/web/src/app/sites/[siteId]/logs/page.tsx`;
  - BFF routes `managed-sites/[siteId]/route.ts` (DELETE), `[siteId]/runtime/route.ts` (PATCH) and `[siteId]/logs/route.ts` (GET).
- Modify: `components/customer/site-tabs.tsx` (`SITE_TABS` gains `logs`), `app/sites/[siteId]/page.tsx` ("Manage" card), the `ACTIVITY` map (`site.provision` → "Site created"), `i18n/it.ts`, `i18n/en.ts`
- Test: `apps/web/test/site-manage.test.ts`

**Interfaces (produces):**
- **"Manage" card on Overview:**
  - Start, Stop and Restart; only the valid ones are enabled for the current status. Each disables while its operation runs and shows the result inline.
  - "PHP version" select (WordPress and PHP only), with the consequence line "Your site restarts for a few seconds."
  - A danger-zone "Delete site".
- **`DeleteSiteDialog`:**
  - Body (EN): "This will permanently delete **<name>**: all its files, its database and its web address setup. This cannot be undone. Backups arrive in a later update, so download anything you need first." IT equivalent.
  - The customer types the site name to enable the button. The DELETE sends `confirmName`. On 202 → navigate to `/sites`.
- **Logs tab:**
  - Two sections, "Visits" (stdout) and "Errors" (stderr), the last 200 lines, newest first, monospaced, with a "Refresh" button.
  - Empty: "Nothing to show yet."
  - 503: "Logs are not available right now. Try again in a minute."
  - Timestamps are formatted with the user's locale.

- [ ] **Step 1: Write the failing tests:**
  - `delete BFF forwards confirmName and requires CSRF`.
  - `runtime BFF rejects a PHP version outside the list before calling upstream`.
  - `logs BFF clamps tail and forwards`.
  - `SITE_TABS includes overview and logs in that order`.
  - IT/EN parity and the forbidden-vocabulary scan for the new keys.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Click through it once with the simulator.
- [ ] **Step 5: Commit** `feat(web): site controls, PHP version, delete confirmation and logs tab`.

---

### Task 11: Docs, ADR, harness and version

**Files:**
- Create: `docs/architecture/adr/0016-shared-mariadb-and-site-jobs.md`
- Modify: `README.md` (Italian: "Siti" section with the three types, PHP versions and where MariaDB data and its key live), `HARNESS.md` (project map: `shared-database.ts`, `site-jobs.ts`, `docker-logs.ts`; mention `mariadb-root.key` in the key list), `.agents/brain/state.md` (Step 2a status), `docs/api/openapi.yaml` (the five `managed-sites` endpoints), root `package.json` `version` → `0.3.0`
- Test: `apps/api/test/infra-layout.test.ts`

**Interfaces:**
- ADR 0016 records:
  - why MariaDB is a platform container running as `hp-executor` with a persistent root key file (`CP-01`, reboot without the control plane);
  - why job containers and not `docker exec`;
  - why no site has a runtime secret;
  - the per-image capability reasons;
  - the third-party `serversideup/php` choice, with the fallback "build own images" if the owner rejects it.
- The capability flags stay unchanged (`acmeTlsRuntimeAvailable` turns true in 2b).

- [ ] **Step 1: Write the failing test** `step 2a docs are consistent`:
  - `README.md` contains `WordPress`, `mariadb-root.key` and `8.4`;
  - `openapi.yaml` contains `/v1/organizations/{orgId}/managed-sites`;
  - ADR 0016 exists;
  - `package.json` version is `0.3.0`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Write the docs and bump the version.**
- [ ] **Step 4: Run it and confirm it passes, plus the four checks.**
- [ ] **Step 5: Commit** `docs: step 2a sites, shared MariaDB ADR and API reference`.

---

### Task 12: Live acceptance in disposable systemd containers (manual)

Use the same harness as `docs/security/step-1b-acceptance-report.md`: privileged systemd containers acting as VMs, with named volumes for `/var/lib/docker` and `/var/lib/containerd`. Run the full checklist on **Ubuntu 26.04** and **Debian 13**. Run steps 1–3 on **Ubuntu 24.04** and **Debian 12**. There is no public DNS, so sites are reached with `curl -H 'Host: <domain>' http://<container-ip>/`. Record the results in `docs/security/step-2a-acceptance-report.md`.

- [ ] **Step 1: Install.** Build `0.3.0` (`pnpm run release:build`) and install with `install.sh --archive …`. Expected:
  - exit 0, and step 12 reports `hp_mariadb` running;
  - `/etc/hosting-panel/mariadb-root.key` is `0400 hp-executor`;
  - `docker inspect hp_mariadb` shows no published port, `CapAdd` null and `User` = the hp-executor UID.
- [ ] **Step 2: Create a WordPress site through the BFF.** Use the customer account and domain `hotel.test`, title `L'Hôtel "Bella"`. Expected:
  - the operation succeeds in under 3 minutes (record the time);
  - `curl -H 'Host: hotel.test'` shows the title verbatim;
  - logging in at `/wp-login.php` with the chosen admin works (curl cookie jar);
  - `docker exec hp_mariadb sh -c 'mariadb -uroot -p"$(cat /run/secrets/mariadb-root)" -e "SHOW DATABASES"'` lists `wp_<12 hex>`;
  - no `HP_*PASSWORD` value appears in `docker inspect` of any container or in `journalctl -u hp-*`.
- [ ] **Step 3: Static and PHP.** Create a static site (`static.test`) and a PHP site (`app.test`). Expected:
  - both show the bilingual placeholder;
  - for the PHP site, `docker exec <php container> php -m` lists `pdo_mysql` and `mysqli`.
- [ ] **Step 4: Change PHP and use the controls.** Change WordPress to PHP 8.5: the page and the admin login still work, and the uploaded media/test post is still there. Then Stop (`curl` → 404 from the proxy), Start (200 again), Restart. The Logs tab shows the curl requests under "Visits".
- [ ] **Step 5: Retry after a failure.** Block the image registry (`iptables -I OUTPUT -p tcp --dport 443 -j REJECT` inside the test VM, with the images not pre-pulled for PHP 8.3) and create a WordPress 8.3 site. Expected: "Problem" plus Try again. Unblock, then Try again: it succeeds, with a single database and user (`SELECT User FROM mysql.user`).
- [ ] **Step 6: CP-01.**
  1. `systemctl stop hp-web hp-api hp-docker-executor hp-host-agent`: all three sites keep answering.
  2. With the units still stopped, `systemctl restart docker`: all three sites and `hp_mariadb` come back by themselves and WordPress serves pages from the DB.
  3. Reboot the test VM container (`docker restart <vm>`) with `hp-api` masked: same result.
  4. Unmask and start the units: nothing is recreated (compare `docker ps --format '{{.ID}} {{.Names}}'` before and after).
- [ ] **Step 7: Update and rerun.** Run `hp-update` to a `0.3.1` build: the curl loop against `hotel.test` shows no failure, and the `hp_mariadb` and site container IDs are unchanged. Rerun `install.sh`: the `mariadb-root.key` checksum is unchanged.
- [ ] **Step 8: Delete.** Delete the static site through the BFF. Expected:
  - its volume, both networks and `site_<id>.yml` are gone;
  - `hotel.test` still answers.
  - Then delete the WordPress site: `wp_<…>` and its user are gone from MariaDB.
- [ ] **Step 9: Write the report and commit** `docs(security): step 2a live acceptance report`.

**Needs a real VM (not this harness):** nothing in 2a depends on public DNS or Let's Encrypt. On a real 2 GB VPS, check:
- the memory footprint with three sites plus MariaDB;
- a real kernel reboot (not a container restart) for the step 6 `CP-01` check;
- image pull time over a normal uplink.

2b's acceptance needs a real VM with a public IPv4 and a DNS name.

---

## Following sub-plans (each gets its own file, written after the previous one merges)

**Step 2b — Domains, DNS check, Let's Encrypt, HTTPS redirect** (`2026-11-08-step-2b-domains-dns-tls.md`)
- **Domains tab:**
  - Add or remove domains.
  - `www` and the bare domain form a pair, and the customer picks which one is primary; the other redirects.
  - Aliases are included, since site routes already accept several hosts.
  - The tab shows the server IP and the exact A records to create.
- **DNS check:** run by the API with `node:dns` `Resolver` against public resolvers.
  - It runs on demand ("Check now") and on a backoff schedule.
  - It warns about AAAA records pointing elsewhere.
  - The status becomes `Waiting for DNS` until the domain resolves here.
- **Routes:**
  - The site's HTTPS router gets `tls.certResolver: le` **only after DNS passes**, so Let's Encrypt is never hammered.
  - HTTP redirects to HTTPS once a certificate exists.
  - The ACME resolver must always be in Traefik's static config, so `--acme-email` becomes mandatory at install.
- **Certificate status:** an executor IPC reads expiry from `acme.json`, read-only, through `X509Certificate`. Traefik renews certificates itself, so renewal also works while the control plane is down (`CP-01`).
- **Failures:** "not pointing here", "port 80 blocked" and "rate limited" each come with a plain next step.
- **Admin alerts:** an in-panel alert for certificates expiring in under 14 days.
- A `wordpress.set-url` job switches WordPress to `https://` (the `.htaccess` block from 2a already handles proxy HTTPS).
- `acmeTlsRuntimeAvailable` → `true`.
- **Live acceptance:** on a real VM with Let's Encrypt staging, then production.

**Step 2c — Outgoing mail relay for sites** (`2026-11-08-step-2c-smtp-relay.md`)
- **Admin settings:** host, port, user, encrypted password and sender domain, plus "Send test email".
- **Relay container:** a platform `hp_mail_relay` container attached to the site internal networks under the alias `hp-mail`. It accepts mail only from site networks and forwards it, authenticated, to the admin's relay.
- **WordPress:** a read-only mu-plugin sets PHPMailer to SMTP `hp-mail:25`.
- **PHP `mail()`:** a read-only `php.ini` drop-in sets `sendmail_path` to a bundled PHP sendmail shim, because the official images ship no sendmail. The static type gets nothing.
- **Relay password:** it is a tmpfs secret that the API rehydrates at boot. While the control plane is down, sites keep serving and mail is deferred. This is the one accepted `CP-01` degradation; write it into the ADR.
- **Recent failures:** visible to the admin.
- **SPF/DKIM:** the customer gets a short plain-language hint.
- **Panel password-reset email:** sent through the relay once it is configured.
- **Live acceptance:** delivery to a real inbox needs a real VM and relay account.

**Node site type:** planned together with Step 4 (Files), because a Node site needs uploaded code and a start command before it can run.

---

## Self-review notes

- **Spec coverage (step 2a part):**
  - §3.3 site types: Tasks 0, 4, 7.
  - PHP version per site: Tasks 0, 8, 10.
  - Only the fixed types are creatable, and the catalog is hidden: Tasks 0, 1.
  - Per-site network isolation and hardening: Tasks 3, 4.
  - One shared MariaDB with a database and user per site: Tasks 3, 4, 7.
  - Lifecycle create, start, stop, restart and delete with confirmation: Tasks 7, 8, 10. The final-backup offer is deferred to Step 3, and the dialog says so.
  - §3.1 empty state "Create your first site" and the "Open WP Admin" primary action: Task 9.
  - §3.2 no jargon, plain errors, progress that survives reloads: Tasks 9, 10.
  - §3.11 logs: Tasks 2, 8, 10.
  - §9 `CP-01`: Global Constraints, Task 3, Task 4 test, Task 12 step 6.
  - Docker socket only in the executor: Task 4.
  - No secrets in env, logs or revisions: Tasks 4, 6, 7.
  - ADR and docs: Task 11.
- **Deferred on purpose:**
  - Domains, TLS and the `www` pair: 2b.
  - Mail: 2c.
  - Node: Step 4.
  - Customer database management and phpMyAdmin: Step 4. 2a creates only WordPress's own database.
  - Admin "Sites" section and support access: Step 6.
  - Image update UI: Step 6. The pins live in one file.
- **Known risks to verify live (Task 12):**
  - the MariaDB entrypoint running as a non-root UID with a bind-mounted data dir;
  - `wp core install --prompt` reading stdin from a file;
  - first-pull time against the 330 s IPC timeout;
  - `serversideup/php` volume ownership for the placeholder job (UID 33).
