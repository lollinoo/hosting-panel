# Step 2b — Domains, DNS Check, Let's Encrypt and HTTPS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Scope note (one plan, not split):** this is the "Step 2b" outline from the 2a plan, unchanged in scope. Reading the code showed it fits in one plan of 15 tasks, the same size as 2a:
- The ingress already has an ACME resolver (`le`, HTTP-01, `acme.json` mounted read-write) for the panel's own hostname. So 2b adds routing rules, a certificate reader and a DNS loop. It does not add a new subsystem.
- The domain table, the site lock and the job pattern all exist already.

No task depends on public DNS except the last one.

**Owner decisions that bind this plan:**
- Only WordPress sites.
- DNS stays at the registrar, and the customer creates an A record.
- Preview addresses stay deferred.
- The administrator can manage domains on any site, including unassigned ones.
- IT and EN, with Italian as the default. The customer console uses no technical jargon, and every error says what to do next.
- `CP-01`: sites, HTTPS and certificate renewal keep working while the control plane is down.
- One customer per server, and fresh installs only.
- 2b's live acceptance runs on the owner's real VM with the owner's real test domain.

**Goal:**
- A customer, or the administrator for them, adds `hotel.it` (with `www.hotel.it` as its pair) to a WordPress site.
- The panel shows the exact A records to create and checks DNS on its own and on "Check now". It shows `Waiting for DNS` until the domain points to this server.
- After that it gets a Let's Encrypt certificate automatically and switches the site and WordPress to `https://`.
- HTTP then redirects to HTTPS, and the non-primary address redirects to the primary one.
- Failures are explained in plain words, and the panel never hammers Let's Encrypt.
- Traefik renews certificates on its own, also while the control plane is down.

**Architecture:**
- **The API owns the decision and the executor writes the files.** Each domain row gets a DNS state and a certificate state (migration `0006`).
- The API turns the domain rows of a site into a **host route plan**. For each host the plan says:
  - `tls`: put `certResolver: le` on the HTTPS router;
  - `httpsRedirect`: redirect HTTP to HTTPS;
  - `redirectTo`: `null`, or the canonical origin.
- The executor writes the plan into `site_<id>.yml`. Its route-only call is the new `applySiteRoutes`, so changing a domain never recreates the WordPress container. `deployService` writes the same plan, taken from `ApprovedServiceSpec.hostRoutes`.
- **Let's Encrypt is never hammered.** Traefik 3.7 retries every failed hostname on each new dynamic configuration, with no backoff (verified in the v3.7 `pkg/provider/acme` source). So a host gets `certResolver` only while the API wants a certificate for it:
  - Request one when the DNS check passes.
  - Remove the resolver as soon as a failure shows up in the proxy log.
  - Put it back only after a backoff.
  - A host that already has a certificate in `acme.json` keeps its resolver. This is not needed for renewal: Traefik's `renewCertificates` renews **every** certificate in its store, whether or not a router uses it. It is kept so that Traefik re-obtains the certificate if the store loses it, for example after a switch of CA.
- **The certificate state is read, never written, by the executor:**
  - from `acme.json`, read-only, through `X509Certificate`;
  - from the proxy's JSON log, as the lines `Unable to obtain ACME certificate for domains`.

  Only hostnames, expiry dates and a classified failure reason cross the IPC boundary. Keys never do.
- **A background reconciler in the API runs every 60 s.** It:
  1. runs the due DNS checks (`node:dns` `Resolver` against public resolvers, with backoff);
  2. moves the certificate states;
  3. enqueues a `site.domains` operation when a site's wanted plan differs from what was last applied.

  That operation:
  1. opens a transition plan (every host serves and none redirects);
  2. runs the new `wordpress.set-url` job when the canonical URL changes;
  3. writes the final plan.

  The transition step prevents a redirect loop between WordPress's `home` URL and the proxy.
- **`CP-01`:** route files, `acme.json` and the resolver are all on disk, and Traefik renews every stored certificate by itself (it checks every 24 h and at start). Nothing in the serving or renewal path needs the API, the executor or PostgreSQL.
- **Known limit (S1):** a removed domain's certificate stays in `acme.json` and Traefik keeps renewing it. Once that name's DNS points away, the renewal fails once a day with `Error renewing ACME certificate`, far below any limit. Cleaning `acme.json` would mean rewriting it while the proxy is stopped, which is left out of 2b. ADR 0017 records this, and `acme-status.ts` carries a `shortcut:` comment.

**Tech Stack:** the existing monorepo (NestJS and Fastify, Next.js 16, Drizzle, Vitest, Docker Engine API ≥ 1.48). **No new npm dependency:** `node:dns` and `node:crypto` are built in. Pinned facts, each checked on 2026-11-09:

| Fact | Value | Source |
|---|---|---|
| Proxy image | `traefik:v3.7`, unchanged; 3.7.17 (2026-10-30) is the live-tested patch. 3.8.0-rc.1 is not used. | GitHub releases API `traefik/traefik` |
| ACME storage | `acme.json`: `{ "<resolver>": { "Account": {…}, "Certificates": [ { "domain": { "main", "sans" }, "certificate": <base64 PEM chain>, "key": <base64>, "Store": "default" } ] } }`. Written in place with `os.WriteFile(…, 0o600)`, **not atomically**. | `pkg/provider/acme/provider.go` and `local_store.go` at `v3.7` |
| Renewal | `certificatesDuration` default 2160 h. A certificate renews when fewer than 30 days remain. The check runs at start, then every 24 h, over **every** stored certificate, whether or not a router uses it. A failure logs `Error renewing ACME certificate: {<main> [<sans>]}`, with no `domains` field. No ARI. | `getCertificateRenewDurations` and `renewCertificates`, `provider.go` `v3.7.17` |
| Failure retry | A failed domain is not recorded and is retried on the next dynamic configuration. No backoff. The error log is `Unable to obtain ACME certificate for domains` with `domains` and `error` fields. | `provider.go` `v3.7` |
| HTTP-01 and redirects | "Redirection is fully compatible with the HTTP-01 challenge." The challenge entry point must be reachable on port 80. | Traefik v3.7 ACME reference |
| Log format | static `log.format: json` (default `common`), `log.level` default `ERROR`, output to stdout | Traefik v3.7 logs reference |
| LE staging | `https://acme-staging-v02.api.letsencrypt.org/directory` | letsencrypt.org/docs/staging-environment |
| LE production limits | 300 new orders per account per 3 h; 50 certificates per registered domain per 7 days; 5 per exact set of names per 7 days; **5 authorization failures per hostname per account per hour**; 1,152 consecutive authorization failures per hostname (refills 1 per day, then issuance pauses); 10 accounts per IP per 3 h | letsencrypt.org/docs/rate-limits (updated 2026-08-05) |
| LE lifetimes | Production (`classic`) is 90 days until **10 Feb 2027**, then 64 days, then 45 days from 16 Feb 2028. Staging has issued 64-day certificates since 14 Oct 2026. Traefik's "renew below 30 days" still works for 64 and 45 days, so `certificatesDuration` stays at its default. | ISRG "from 90 to 45" and LE community announcements |
| LE and IPv6 | When a AAAA record exists, the validator tries IPv6 first. It falls back to IPv4 only on a timeout, and only on the first request. | letsencrypt.org/docs/ipv6-support |
| DNS client | Node **26.13.0**, `dns.promises.Resolver({ timeout, tries })` (`tries` default 4), `setServers(["1.1.1.1", "host:port"])`, `resolve4` and `resolve6`. Error codes are compared against the constants `dns.NODATA` and `dns.NOTFOUND`, not literals. | nodejs.org/docs/latest-v26.x/api/dns.html |
| X.509 | `X509Certificate#validToDate`, `#checkHost(name)` and `#serialNumber` (Node 26.13.0, checked locally) | Node 26 crypto docs |
| Local ACME CA (harness only) | `ghcr.io/letsencrypt/pebble:2.10.1` and `ghcr.io/letsencrypt/pebble-challtestsrv:2.10.1` (2026-04-20). `profiles.default.validityPeriod` is in seconds. Set `PEBBLE_VA_NOSLEEP=1` and `PEBBLE_WFE_NONCEREJECT=0`. challtestsrv `-defaultIPv6` defaults to `::1` and must be set to `""`. | GHCR tag list, pebble `v2.10.1` README and `test/config/pebble-config.json` |

**Spec:** `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md`, mainly:
- §3.1 (header pills);
- §3.2;
- §3.4 (all of it);
- §3.9 (test before pointing the domain);
- §4 (Sites row and Health alerts; the alert lives on the Sites page until Step 6);
- §5 (panel certificate);
- §6, §8 step 2 and §9.

It builds on `docs/superpowers/plans/2026-11-08-step-2a-sites-and-shared-mariadb.md` and `docs/security/step-2a-acceptance-report.md`, including its final fix wave (`GwPriority`, Engine API ≥ 1.48).

## Global Constraints

- Everything in the 2a Global Constraints still holds: hardening, no secrets in env, argv, DTOs, logs or revisions, the timeout budget, the jargon rules, and IT/EN with Italian as the default.
- **Never hammer Let's Encrypt:**
  - A host gets `tls: true` only when one of these holds:
    - `cert_status = 'active'` (a certificate is in the store);
    - `cert_status = 'requested'`.
  - `requested` is entered in two ways:
    - from `none` or `failed`, which needs `dns_status = 'ok'` and the domain routed;
    - from `active` when a readable store no longer holds the certificate, with no DNS condition, so Traefik re-obtains it.
  - After a classified failure the resolver is removed in the same reconcile pass, at most 60 s later.
  - Retry delays:
    - `rate_limited`: 24 h;
    - any other failure: 15 min, then 1 h, 3 h, 6 h, and 24 h after that.
  - "Check now" never shortens a `rate_limited` wait. For any other failure it can bring the retry forward only to `max(now, cert_requested_at + 15 min)`, so clicking makes at most 4 attempts an hour, under the limit of 5 failures per hour.
  - Live tests use **staging first**.
- **WordPress never goes back from `https` to `http` automatically.** Once `sites.wordpress_url` starts with `https://`, only its host may change. The main address can move only to a name with a usable certificate, unless the site is still on `http`.
- **No IPv6 serving.** The proxy publishes on `0.0.0.0` only, which is unchanged. Any AAAA record blocks certificate requests (`ipv6_conflict`).
- **`CP-01`:**
  - Route files keep `certResolver` for every host whose certificate is in the store.
  - The proxy, `acme.json` and the static config are unchanged when the control plane is down.
  - An unreadable or half-written `acme.json` never downgrades a certificate state or changes routes.
- **Executor trust boundary:**
  - Every route hostname must satisfy `normalizeSiteDomain(h) === h`. That rejects wildcards, IP literals, uppercase and a trailing dot, which `assertSafeDomain` alone allows.
  - Every `redirectTo` must be `isSiteOrigin`.
  - Neither may equal the panel hostname or IPv4. Anything else gives `HOST_POLICY_DENIED`, before any YAML is written.
  - `applySiteRoutes` refuses a service whose container does not carry the matching `site_id` and `service_instance_id` labels.
- **Domains per site:** at most `MAX_SITE_DOMAINS = 10` rows, pairs included. The same hostname cannot belong to two sites, nor equal the panel hostname or IPv4. That is the existing unique index plus the 2a check.
- **Exactly one primary domain per site** (unique partial index). The primary cannot be removed, so choose another first. A site's last domain cannot be removed.
- **Customer copy:**
  - The words "A record", "AAAA record", "IPv6", "Let's Encrypt", "HTTPS", "certificate" and "server" are allowed, because registrars use them.
  - Banned: "container", "Docker", "image", "volume", "network", "service", "template", "MariaDB", "job", "organization", "revision", "drift", "allocation" and "outbox". Today `apps/web/test/ui-copy.test.ts:47` bans only `container|docker|revision|drift|allocation|outbox`; Task 10 extends that regex to the full list.
  - Each problem message names the next step, and every new string exists in IT and EN.
- **Operation and audit text:**
  - `site.domains` step and operation messages are fixed texts.
  - Raw ACME error text and job output go only into admin-only audit details (`site.certificate.failed`, `site.domains.failed`), redacted and capped at 1 KiB.
- **Capability flag:** `acmeTlsRuntimeAvailable` becomes `boolean`. It is `true` only when `runtimeBackend === "linux-systemd"`. The installer always sets an ACME email, so on a real install the resolver exists. A dev setup without `HP_ACME_EMAIL` still reports `true` while the executor's `acmeEnabled` is `false`; ADR 0017 records that.
- **Version:** root `package.json` → `0.4.0`. Migration `0006` is additive, apart from one new unique partial index.
- Every task ends green on `corepack pnpm run build && corepack pnpm run lint && corepack pnpm run typecheck && corepack pnpm run test`. After editing `packages/*`, run `build` before app tests.

## Review Focus

1. **`acme.json` is half-written, or the proxy is restarting, while the reconciler reads it.** Traefik rewrites the file in place. Expected:
   - `readable: false`;
   - no domain moves out of `active`;
   - no route change.

   Tests: Task 3 `a truncated acme.json reads as unreadable, never as empty`, and Task 8 `an unreadable store keeps every certificate state`.
2. **Issuance keeps failing** (port 80 blocked at the provider's firewall, rate limited, or a CAA record). Expected: one attempt, then the resolver is gone from the route file within one pass. Retries follow the schedule, and "Check now" cannot shorten a rate-limit wait.

   Tests: Task 7 `retry schedule never retries a rate limit before 24 h`; Task 8 `a failure removes the resolver and schedules a retry`, `check now does not shorten a rate-limit wait` and `check now cannot bring a certificate retry forward twice within 15 min`; live in Task 13 step 4.
3. **The control plane is down when a certificate needs renewing, or a visitor arrives.** HTTPS keeps serving, and Traefik renews by itself.

   Tests: Task 8 `DNS pointing away later never drops an issued certificate`, Task 13 step 6 (forced renewal with every panel unit stopped) and Task 14 step 6.
4. **The server is behind NAT, or the domain still has a AAAA record from the old host.** The customer is told exactly what to change, and no certificate is requested.

   Tests: Task 7 `evaluateDns flags any AAAA as ipv6_conflict` and `an A record set mixing this server and another is points_elsewhere`; Task 12 `installer warns when the IPv4 is private and continues`; Task 13 step 3.
5. **The primary switches (`hotel.it` → `www.hotel.it`), or the site moves from `http://` to `https://`.** No visitor ever gets a redirect loop, and WordPress ends on the new URL with its content links rewritten.

   Tests: Task 6 `a URL change opens a transition plan before running set-url`, `store briefly missing a certificate never rewrites the site to http` and `expired certificate keeps the WordPress address on https`; Task 9 `the primary cannot be removed` and `main address moves only to a name with working HTTPS`; Task 4 `set-url script, run with a recording wp shim`; Task 13 step 5.

---

## File map

| Area | Files |
|---|---|
| Contracts | `packages/contracts/src/site-domains.ts` (new), `site-runtime.ts`, `resources.ts`, `operations.ts`, `ipc-schemas.ts`, `index.ts` |
| Data model | `packages/database/migrations/0006_domains_dns_tls.sql` (new), `src/schema.ts`, `src/domains-repository.ts` (new), `src/index.ts` |
| Executor contracts | `packages/executor-contracts/src/port.ts`, `spec.ts`, `phase1-executor.ts` |
| Executor | `apps/docker-executor/src/traefik-config.ts`, `acme-status.ts` (new), `site-jobs.ts`, `docker-engine-adapter.ts`, `server.ts`, `client.ts`, `simulator-adapter.ts`, `main.ts` |
| API | `apps/api/src/sites/domain-policy.ts` (new, pure), `sites/dns-check.ts` (new), `sites/site-domains-applier.ts` (new), `sites/domain-reconciler.service.ts` (new), `sites/site-domains.service.ts` (new), `controllers/site-domains.controller.ts` (new), `controllers/admin-sites.controller.ts`, `sites/managed-sites.service.ts`, `runtime/service-spec.ts`, `runtime/site-provisioner.ts`, `runtime/outbox-worker.service.ts`, `controllers/organizations.controller.ts` (capability flag), `tokens.ts`, `app.module.ts`, `create-app.ts` |
| Web | `components/customer/domains-panel.tsx` (new), `components/customer/certificate-pill.tsx` (new), `app/sites/[siteId]/domains/page.tsx` (new), `app/admin/sites/[siteId]/domains/page.tsx` (new), BFF `app/api/bff/orgs/[orgId]/managed-sites/[siteId]/domains/**` and `app/api/admin/sites/[siteId]/domains/**` (new), `components/customer/site-tabs.tsx`, `app/sites/[siteId]/layout.tsx`, `app/sites/[siteId]/page.tsx`, `components/customer/site-form.tsx`, `components/admin/sites-table.tsx`, `app/admin/sites/page.tsx`, `lib/server-api.ts`, `lib/bff-proxy.ts`, `i18n/it.ts`, `i18n/en.ts` |
| Infra and docs | `infra/linux/install.sh`, `infra/linux/install.test.ts`, `apps/api/src/cli/accounts.ts`, `apps/api/test/accounts-cli.test.ts`, `docs/architecture/adr/0017-domains-dns-and-acme-tls.md` (new), `README.md`, `HARNESS.md`, `.agents/brain/state.md`, `docs/api/openapi.yaml`, `package.json` |

---

### Task 0: Domain contracts, capability flag and the `site.domains` kind

**Files:**
- Create: `packages/contracts/src/site-domains.ts`
- Modify:
  - `packages/contracts/src/site-runtime.ts` (`includeWww` on create);
  - `resources.ts` (capability flag);
  - `operations.ts` (`"site.domains"` in `OPERATION_KINDS`);
  - `index.ts`.
- Test: `packages/contracts/test/site-domains.test.ts`, `packages/contracts/test/contracts.test.ts` (flag expectations)

**Interfaces (produces):**
- **Status lists:**
  - `DNS_STATUSES = ["unchecked", "ok", "not_found", "points_elsewhere", "ipv6_conflict", "lookup_failed"] as const`, with `type DnsStatus`;
  - `CERT_STATUSES = ["none", "requested", "active", "failed"] as const`, with `type CertStatus`;
  - `CERT_PROBLEMS = ["rate_limited", "port_80_blocked", "not_pointing", "caa_blocked", "other"] as const`, with `type CertProblem`;
  - `MAX_SITE_DOMAINS = 10`.
- **Helpers:**
  - `wwwPartner(hostname: string): string | null`. `www.x.y` gives `x.y`. A hostname with a dot gives `www.` + hostname. If the result fails `normalizeSiteDomain`, it returns `null`.
  - `suggestWwwPair(hostname: string): boolean`: true when it has exactly 2 labels or starts with `www.`.
  - `isSiteOrigin(value: string): boolean`: `^https?://` followed by a host for which `normalizeSiteDomain(host) === host`. No path, port, userinfo or trailing slash.
- **Inputs:**
  - `AddSiteDomainInputSchema = z.object({ hostname: <same normalizing transform as CreateManagedSiteInputSchema.domain>, includeWww: z.boolean().default(true) })`. Extract that transform into a shared `SiteDomainSchema` in `site-runtime.ts`.
  - **Accented names (IDN).** The transform first converts a value that contains non-ASCII characters and none of `/ : ? # @` with `new URL("http://" + v).hostname`. That gives punycode in Node and in the browser alike. The result then goes through `normalizeSiteDomain`, so `caffè.it` is stored as `xn--caff-8oa.it`. Showing the accented form in the UI is deferred.
  - `CreateManagedSiteInputSchema` gains `includeWww: z.boolean().default(false)`. The API default stays `false`, so the 2a tests are unchanged; the form sends `true` by default.
- **DTOs:**
  - `SiteDomainDtoSchema`:
    - `id`, `hostname`, `isPrimary`;
    - `routed: boolean`: the row's `status === "active"`;
    - `dns: { status: DnsStatus; checkedAt: string | null; nextCheckAt: string; observedA: string[]; observedAaaa: string[] }`;
    - `certificate: { status: CertStatus; problem: CertProblem | null; expiresAt: string | null; retryAt: string | null; trusted: boolean }`.
  - `SiteDomainsDtoSchema = z.object({ serverIpv4: z.string(), routesPending: z.boolean(), domains: z.array(SiteDomainDtoSchema) })`.
  - `CertificateAlertDtoSchema = z.object({ kind: z.enum(["expiring", "not_issued", "panel_expiring"]), siteId: z.string().nullable(), siteName: z.string().nullable(), hostname: z.string(), expiresAt: z.string().nullable(), problem: z.enum(CERT_PROBLEMS).nullable() })`.
  - `AdminSitesListDtoSchema` gains `certificateAlerts: z.array(CertificateAlertDtoSchema)`.
- **Capability flag:** `PlatformCapabilitiesDtoSchema` and `OrganizationCapabilitiesDtoSchema` change `acmeTlsRuntimeAvailable` to `z.boolean()`. `createPlatformCapabilities` sets it to `options.runtimeBackend === "linux-systemd"`, and `DEFAULT_PLATFORM_CAPABILITIES` keeps `false`.

- [ ] **Step 1: Write the failing tests** in `site-domains.test.ts`:
  - `wwwPartner pairs bare and www`: `hotel.it` ↔ `www.hotel.it`; `blog.hotel.it` → `www.blog.hotel.it`; `www.it` → `null`.
  - `isSiteOrigin accepts only scheme plus host`:
    - accepts `https://hotel.it` and `http://www.hotel.it`;
    - rejects `https://hotel.it/`, `https://hotel.it:8443`, `https://a@hotel.it`, `ftp://hotel.it`, `https://Hotel.it` and `https://hotel.it\n`.
  - `AddSiteDomainInputSchema normalizes and defaults includeWww to true`: `"Hotel.IT."` → `{ hostname: "hotel.it", includeWww: true }`.
  - `create keeps includeWww false by default`.
  - `an accented name is converted to punycode`: `Caffè.it` → `xn--caff-8oa.it`, and `caffè.it/x` is rejected. Take the expected value from `new URL("http://caffè.it").hostname` in the test itself, not a hard-coded literal.
  - In `contracts.test.ts`: `createPlatformCapabilities` gives `acmeTlsRuntimeAvailable: true` for `linux-systemd` and `false` for `local-simulator` and `disabled`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run packages/contracts/test/site-domains.test.ts packages/contracts/test/contracts.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Then update the literal-`false` expectations that the flag change breaks:
  - `apps/api/test/api.integration.test.ts:227` and `:683`;
  - `apps/api/test/phase2-api.integration.test.ts:311` and `:326`;
  - `apps/web/test/bff.integration.test.ts:215` and `:1153`.

  Those fixtures use `disabled` or `local-simulator`, so `false` stays correct. Only the schema type changes.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(contracts): domain DNS and certificate contracts, site.domains kind`.

---

### Task 1: Migration 0006 — DNS and certificate state on domains

**Files:**
- Create: `packages/database/migrations/0006_domains_dns_tls.sql`, `packages/database/src/domains-repository.ts`
- Modify: `packages/database/src/schema.ts` (`domains`, `sites`), `src/index.ts`
- Test: `packages/database/test/sites-database.test.ts` (`describe("domains dns and tls")`)

**Interfaces (produces):**
- **SQL, exactly:**

  ```sql
  ALTER TABLE domains
    ADD COLUMN IF NOT EXISTS dns_status TEXT NOT NULL DEFAULT 'unchecked'
      CHECK (dns_status IN ('unchecked','ok','not_found','points_elsewhere','ipv6_conflict','lookup_failed')),
    ADD COLUMN IF NOT EXISTS dns_observed JSONB NOT NULL DEFAULT '{"a":[],"aaaa":[]}'::jsonb,
    ADD COLUMN IF NOT EXISTS dns_checked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dns_next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS dns_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cert_status TEXT NOT NULL DEFAULT 'none'
      CHECK (cert_status IN ('none','requested','active','failed')),
    ADD COLUMN IF NOT EXISTS cert_problem TEXT
      CHECK (cert_problem IS NULL OR cert_problem IN ('rate_limited','port_80_blocked','not_pointing','caa_blocked','other')),
    ADD COLUMN IF NOT EXISTS cert_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cert_retry_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cert_attempts INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cert_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cert_trusted BOOLEAN NOT NULL DEFAULT TRUE;
  ALTER TABLE sites
    ADD COLUMN IF NOT EXISTS applied_routes_hash TEXT,
    ADD COLUMN IF NOT EXISTS applied_routes JSONB,
    ADD COLUMN IF NOT EXISTS wordpress_url TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_domains_one_primary_per_site ON domains (site_id) WHERE is_primary;
  CREATE INDEX IF NOT EXISTS idx_domains_dns_due ON domains (dns_next_check_at);
  ```
- **Drizzle columns** in `schema.ts`, camelCase:
  - `dnsStatus` (`$type<DnsStatus>`), `dnsObserved` (`$type<{ a: string[]; aaaa: string[] }>`), `dnsCheckedAt`, `dnsNextCheckAt`, `dnsAttempts`;
  - `certStatus`, `certProblem`, `certRequestedAt`, `certRetryAt`, `certAttempts`, `certExpiresAt`, `certTrusted`;
  - on `sites`: `appliedRoutesHash`, `appliedRoutes` (`$type<SiteHostRoute[] | null>`, the last plan written as final) and `wordpressUrl`.
- **`domains-repository.ts`:**
  - `listSiteDomains(db, siteId: string): Promise<DomainRow[]>`, ordered by `hostname`;
  - `insertSiteDomains(db, { siteId, organizationId, hostnames: readonly string[], routed: boolean }): Promise<DomainRow[]>`. Ids are `dom_` plus 32 hex characters, and `status` is `active` when `routed`, else `pending`.
  - `type DomainRow = typeof domains.$inferSelect`.

- [ ] **Step 1: Write the failing tests:**
  - `0006 adds dns and cert columns with safe defaults`: a new domain row has `dnsStatus "unchecked"`, `certStatus "none"` and `certTrusted true`.
  - `rejects a second primary domain for one site` (unique violation).
  - `rejects an unknown cert_problem` (check violation).
  - `insertSiteDomains marks rows pending until routed`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run packages/database/test/sites-database.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(database): migration 0006 domain DNS and certificate state`.

---

### Task 2: Executor — per-host routes with TLS, HTTPS redirect and canonical redirects

**Files:**
- Modify:
  - `apps/docker-executor/src/traefik-config.ts`: `SiteIngressRouteEntry`, `buildSiteDynamicTraefikYaml`, `parsePersistedRoutesFromYaml`, `flushSiteDynamicFile`, `buildTraefikStaticYaml`, `PanelIngressConfig`, `ensureStaticConfig`;
  - `apps/docker-executor/src/main.ts` (`parsePanelIngressConfigFromEnv`).
- Test: `apps/docker-executor/test/traefik-routes.test.ts` (new)

**Interfaces:**
- **Consumes:** `isSiteOrigin` (Task 0) and `SiteHostRoute` (Task 5's port type). Declare the type here and re-export it from `executor-contracts` in Task 5 by moving it, so there is one definition.
- **Produces:**
  - `interface SiteHostRoute { readonly hostname: string; readonly tls: boolean; readonly httpsRedirect: boolean; readonly redirectTo: string | null }`.
  - `SiteIngressRouteEntry` becomes `{ serviceInstanceId, containerName, internalPort, hosts: readonly SiteHostRoute[] }`, replacing `domains`.
    - `parsePersistedRoutesFromYaml` still accepts an old `@hp-route` line with `domains` and maps it to `{ tls: false, httpsRedirect: false, redirectTo: null }` hosts.
    - `upsertServiceRoute` treats `hosts.length === 0` as removal, as `domains` was before.
  - `buildSiteDynamicTraefikYaml(siteId, routes, opts: { acmeEnabled: boolean; reservedHosts: readonly string[] })`. `reservedHosts` is the panel hostname and IPv4.
    - Hosts are sorted by hostname, and `key = sanitizeTraefikKey(serviceInstanceId)`.
    - `i` is **not** a position. It is the first 8 hex characters of `sha256(hostname)`, so adding a name never renames the routers of the others.
    - For each host:
      - **HTTP router** `router_<key>_<i>`: entry point `web`, `rule: "Host(\`h\`)"`, service `svc_<key>`. Middlewares: `canon_<key>_<i>` when `redirectTo` is set; else `https_<key>` when `httpsRedirect`; else none.
      - **HTTPS router** `router_<key>_<i>_tls`, only when `tls && acmeEnabled`: entry point `websecure`, the same rule and service, the same canonical middleware when `redirectTo` is set, and `tls:` / `certResolver: le`.
    - **Middlewares:**
      - `https_<key>`: `redirectScheme { scheme: https, permanent: true }`, emitted once when any host needs it;
      - `canon_<key>_<i>`: `redirectRegex { regex: "^https?://[^/]+(.*)$", replacement: "<redirectTo>${1}", permanent: true }`.
    - **Validation**, before any line is emitted, each giving `HOST_POLICY_DENIED`:
      - each hostname must satisfy `normalizeSiteDomain(h) === h`, which rejects wildcards, IP literals, uppercase and a trailing dot;
      - each `redirectTo` must satisfy `isSiteOrigin(redirectTo)`;
      - no hostname, and no `redirectTo` host, may be in `reservedHosts`.

      Duplicate hostnames give `VALIDATION_ERROR`, and so do more than 20 hosts.
    - With `acmeEnabled: false`, `tls` and `httpsRedirect` are ignored, so no router names a missing resolver.
  - `writeFileIfChanged(path, content, mode)` is a new helper next to `writeFileAtomically`. It reads the current file and **skips the write when the content is identical**. Each rename makes Traefik reload, and each reload retries any pending ACME host. `flushSiteDynamicFile` and the panel file write in `ensureStaticConfig` (`traefik-config.ts:478-479`, today unconditional) both use it.
  - `buildIngressProxyContainerPayload` adds `HostConfig.LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } }`. The executor reads failures from this log, and today it has no rotation. The proxy-drift check compares this field too, so an existing proxy is recreated once.
  - **`PanelIngressConfig`** gains `acmeCaServer: string | null` and `acmeCaCertFile: string | null`, from `HP_ACME_CA_SERVER` and `HP_ACME_CA_CERT_FILE`. `HP_ACME_CA_SERVER` must start with `https://`, otherwise the config is invalid. These are for a local test CA only; the installer never sets them.
  - `acmeStorageFileName(panel): "acme.json" | "acme-staging.json" | "acme-custom.json"`. Custom CA beats staging, which beats production.
  - **`buildTraefikStaticYaml(panel)`:**
    - always emits `log:` / `  format: json`;
    - the resolver's `storage` is `/etc/traefik/acme/<acmeStorageFileName>`;
    - `caServer` is the custom value or the staging URL;
    - with a custom CA it adds `caCertificates:` / `- /etc/traefik/acme/custom-ca.pem`.

    One static file per mode means switching between staging and production never mixes accounts or certificates.
  - `ensureStaticConfig` copies `acmeCaCertFile` to `<acme>/custom-ca.pem` (mode `0644`) when set. It also creates the active storage file with mode `0600`, as today.

- [ ] **Step 1: Write the failing tests** in `traefik-routes.test.ts`:
  - `pair with https: primary redirects to https, partner redirects to the canonical origin`. Hosts:
    - `hotel.it`: `tls`, `httpsRedirect`, `redirectTo` null;
    - `www.hotel.it`: `tls`, `redirectTo` `"https://hotel.it"`.

    Let `A` and `B` be the hash suffixes of `hotel.it` and `www.hotel.it`. The YAML contains:
    - `router_svc1_<A>_tls` with `certResolver: le`;
    - `https_svc1` with `redirectScheme`;
    - `canon_svc1_<B>` with `replacement: "https://hotel.it${1}"`.

    `router_svc1_<B>` uses `canon_svc1_<B>`, not `https_svc1`.
  - `router names do not change when a name is added`: the `hotel.it` router names are the same before and after adding `blog.hotel.it`.
  - `a host without tls has no websecure router`.
  - `tls without https redirect still emits the resolver router`: `tls: true, httpsRedirect: false` emits the `_tls` router with `certResolver`. This is YAML emission only. Task 8 owns the property that an issued certificate keeps `tls`.
  - `acme disabled strips resolver and https redirect`.
  - `rejects a redirectTo with a path or a quote`: `https://hotel.it/x` and `https://hotel.it"\n  evil:` → `HOST_POLICY_DENIED`, and no file is written.
  - `rejects wildcard, IP and panel hostnames`: `*.hotel.it`, `1.2.3.4`, the panel hostname as a host, and `https://<panel hostname>` as a `redirectTo` → `HOST_POLICY_DENIED`.
  - `rejects duplicate hostnames and more than 20 hosts`.
  - `reads a 2a route comment with domains as plain hosts`.
  - `does not rewrite an unchanged site file or panel file` (the mtime is unchanged after a second identical upsert and a second `ensureStaticConfig`).
  - `proxy log is rotated`: `buildIngressProxyContainerPayload` has `LogConfig.Config["max-size"] === "10m"`.
  - `static config logs json and stores staging certificates apart`. The staging panel config gives `storage: /etc/traefik/acme/acme-staging.json` and `caServer: https://acme-staging-v02.api.letsencrypt.org/directory`; production gives `acme.json` and no `caServer`.
  - `custom CA adds caCertificates and is refused unless https`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/docker-executor/test/traefik-routes.test.ts`.
- [ ] **Step 3: Implement.** Then update the existing route tests in `apps/docker-executor/test/docker-executor.test.ts` that build `SiteIngressRouteEntry` with `domains` to use `hosts`.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): per-host routes with Let's Encrypt, HTTPS redirect and canonical redirects`.

---

### Task 3: Executor — read certificates and ACME failures (read-only)

**Files:**
- Create: `apps/docker-executor/src/acme-status.ts`
- Test: `apps/docker-executor/test/acme-status.test.ts`

**Interfaces (produces):**
- `interface StoredCertificate { readonly hostname: string; readonly notAfter: string; readonly serialNumber: string }`.
- **`readAcmeCertificates(storePath: string, resolver = "le"): Promise<{ readable: boolean; certificates: StoredCertificate[] }>`:**
  - reads the file, and on a JSON parse error retries once after 200 ms;
  - on a second failure, or `EACCES`, returns `{ readable: false, certificates: [] }`;
  - a missing file, or a resolver key not present yet, gives `{ readable: true, certificates: [] }`;
  - for each `Certificates[]` entry it decodes `certificate` from base64 into PEM, takes `new X509Certificate(pem)` (the leaf comes first) and reports `domain.main` with `validToDate.toISOString()` and `serialNumber`;
  - it never reads or returns `key`.
- **`classifyAcmeError(text: string): CertProblem`.** The first match wins:

  | Error text contains | Result |
  |---|---|
  | `rateLimited` | `rate_limited` |
  | `:caa` | `caa_blocked` |
  | `:connection`, `Timeout during connect` or `connection refused` (case-insensitive) | `port_80_blocked` |
  | `:unauthorized`, `:dns` or `:incorrectResponse` | `not_pointing` |
  | anything else | `other` |
- **`parseAcmeFailures(lines: readonly string[], sinceMs: number): { hostname: string; at: string; kind: "obtain" | "renew"; problem: CertProblem; detail: string }[]`:**
  - parses each line as JSON (Traefik `log.format: json`) and skips the ones that do not parse;
  - keeps lines whose `time` is at or after `sinceMs`, and whose `message` starts with one of:
    - `Unable to obtain ACME certificate`: `kind: "obtain"`, one entry per name in `domains`;
    - `Error renewing ACME certificate`: `kind: "renew"`. This line has no `domains` field, so the hostname is the first token after `{` in the message (`{hotel.it [www…]}` gives `hotel.it`).
  - `detail` is `redactSensitiveString(error).slice(0, 1024)`.
- A `shortcut:` comment at the top of the module records the known limit: certificates of removed domains stay in `acme.json` and keep being renewed. The upgrade is a cleanup with the proxy stopped, in a later step.

- [ ] **Step 1: Write the failing tests:**
  - `reads hostnames and expiry, never the key`. The fixture `acme.json` is built in-test with a self-signed certificate from `node:crypto` `generateKeyPairSync` plus a minimal DER builder. If that is too costly, use a checked-in PEM fixture `apps/docker-executor/test/fixtures/acme-cert.pem`, created once with `openssl req -x509 -days 30 -subj /CN=hotel.it`. The result has `hostname "hotel.it"` and an ISO `notAfter`, and `JSON.stringify(result)` does not contain the key's base64.
  - `a truncated acme.json reads as unreadable, never as empty`: the file `{"le":{"Certificates":[{"dom` gives `readable: false`.
  - `a missing file or resolver is readable and empty`.
  - `classifyAcmeError maps the ACME problem types`. Real strings:
    - `urn:ietf:params:acme:error:rateLimited :: too many certificates (5) already issued` → `rate_limited`;
    - `urn:ietf:params:acme:error:connection :: 203.0.113.9: Timeout during connect (likely firewall problem)` → `port_80_blocked`;
    - `urn:ietf:params:acme:error:unauthorized :: Invalid response from http://hotel.it/.well-known/acme-challenge/x: 404` → `not_pointing`;
    - `urn:ietf:params:acme:error:caa` → `caa_blocked`;
    - `boom` → `other`.
  - `parseAcmeFailures keeps only recent ACME errors`. A JSON line `{"level":"error","domains":["hotel.it"],"error":"…rateLimited…","time":"2026-11-09T10:00:00Z","message":"Unable to obtain ACME certificate for domains"}` with `since` at 09:59 gives one `obtain` entry. With `since` at 10:01 it gives none, and a non-JSON line is ignored.
  - `parseAcmeFailures reads renewal failures`: `{"level":"error","error":"…connection…","time":"…","message":"Error renewing ACME certificate: {hotel.it []}"}` gives `{ hostname: "hotel.it", kind: "renew", problem: "port_80_blocked" }`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Task 13 step 4 checks the log field names against a real Traefik 3.7.17 failure, and fixes the fixture if they differ.
- [ ] **Step 5: Commit** `feat(docker-executor): read issued certificates and classify ACME failures`.

---

### Task 4: Executor — the `wordpress.set-url` job

**Files:**
- Modify: `apps/docker-executor/src/site-jobs.ts`, `packages/contracts/src/ipc-schemas.ts` (`SiteJobIpcRequestSchema.kind`), `packages/executor-contracts/src/port.ts` (`SiteJobKind`)
- Test: `apps/docker-executor/test/site-jobs.test.ts`

**Interfaces (produces):**
- `SiteJobKind` gains `"wordpress.set-url"`.
- **Allowlist entry:**
  - params `phpVersion` (`isPhpVersion`), `siteUrl` (`isSiteOrigin`) and `previousUrl` (`isSiteOrigin`);
  - no secrets;
  - `serviceInstanceId` is required;
  - image `resolveWordpressCliImage(phpVersion)`, user `33:33`, the site internal network, the `html` volume at `/var/www/html` and workdir `/var/www/html`, exactly as for `wordpress.install`.
- **Fixed script** `WORDPRESS_SET_URL_SCRIPT`, shown here exactly because the review depends on it:

  ```sh
  set -eu
  wp config has HP_MANAGED --type=constant || exit 20
  wp option update home "$HP_SITE_URL" --skip-plugins --skip-themes
  wp option update siteurl "$HP_SITE_URL" --skip-plugins --skip-themes
  [ "$HP_PREVIOUS_URL" = "$HP_SITE_URL" ] && exit 0
  p=$HP_PREVIOUS_URL; n=$HP_SITE_URL
  pe=$(printf '%s' "$p" | sed 's#/#\\/#g'); ne=$(printf '%s' "$n" | sed 's#/#\\/#g')
  for pair in "$p/|$n/" "$p\"|$n\"" "$p'|$n'" "$pe\\/|$ne\\/" "$pe\"|$ne\""; do
    wp search-replace "${pair%%|*}" "${pair#*|}" --all-tables-with-prefix --skip-columns=guid \
      --skip-plugins --skip-themes --report-changed-only
  done
  ```

  - Each pass searches the origin followed by `/`, `"` or `'`, so `http://hotel.it` never matches inside `http://hotel.italia-tours.com`.
  - The last two passes cover the JSON-escaped form (`https:\/\/hotel.it\/`) used by block attributes and page builders.
  - A bare origin at the end of plain text is not rewritten. That is accepted.
  - `|` cannot occur in a validated origin.
  - It is idempotent: neither `http://x/` nor `https://x/` is a substring of the other.
  - `guid` is never rewritten, as WordPress requires.
- `buildSiteJobContainerPayload` widens its `isWordpress` branch to both WordPress kinds. The `.htaccess` env values are added only for `wordpress.install`.

- [ ] **Step 1: Write the failing tests:**
  - `set-url passes URLs only as env`: `Cmd[2]` equals `WORDPRESS_SET_URL_SCRIPT`, and `Env` contains `HP_SITE_URL=https://hotel.it` and `HP_PREVIOUS_URL=http://hotel.it`.
  - `set-url rejects a URL with a path, a quote or a $()`: `https://hotel.it/$(id)` → `VALIDATION_ERROR`.
  - `set-url script, run with a recording wp shim`. The test writes a `wp` shell script into a temp dir that appends its argv to a file and exits as `WP_SHIM_EXIT` says. It runs `sh -c WORDPRESS_SET_URL_SCRIPT` with `PATH=<tmp>:/usr/bin:/bin` and the `HP_*` env, and asserts:
    - when `wp config has` fails, exit 20 and no other `wp` call;
    - equal URLs: two `option update` calls and no `search-replace`;
    - `http://hotel.it` → `https://hotel.it`: exactly five `search-replace` calls, whose first two arguments are `http://hotel.it/` `https://hotel.it/`, `http://hotel.it"` `https://hotel.it"`, `http://hotel.it'` `https://hotel.it'`, `http:\/\/hotel.it\/` `https:\/\/hotel.it\/`, and `http:\/\/hotel.it"` `https:\/\/hotel.it"`.
  - `set-url runs as 33:33 on the site network with the html volume and no secrets`; secrets given → `VALIDATION_ERROR`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): wordpress.set-url job switches the site address`.

---

### Task 5: Executor port, IPC, adapter, client and simulator for routes and certificates

**Files:**
- Modify:
  - `packages/executor-contracts/src/port.ts`, `spec.ts` (`hostRoutes`) and `phase1-executor.ts`;
  - `packages/contracts/src/ipc-schemas.ts`;
  - `apps/docker-executor/src/docker-engine-adapter.ts` (`applySiteRoutes`, `getCertificateStatus`, and `deployService` using `hostRoutes`);
  - `server.ts`, `client.ts`, `simulator-adapter.ts`, `main.ts`.
- Test: `apps/docker-executor/test/docker-executor.test.ts` (`describe("site routes and certificates")`), `packages/executor-contracts/test/executor-contracts.test.ts`

**Interfaces:**
- **Consumes:** Tasks 2, 3 and 4.
- **Produces:**
  - `SiteHostRoute` moves to `port.ts` and is re-exported. `traefik-config.ts` imports it.
  - `ApprovedServiceSpec` and `CreateApprovedServiceSpecInput` gain `hostRoutes?: readonly SiteHostRoute[]`. `ApprovedServiceSpecWireSchema` gains `hostRoutes: z.array(SiteHostRouteSchema).max(20).optional()`, where `SiteHostRouteSchema = z.object({ hostname: z.string().min(1).max(253), tls: z.boolean(), httpsRedirect: z.boolean(), redirectTo: z.string().max(260).nullable() })`.
  - `deployService` writes `spec.hostRoutes` when present. Otherwise it maps `spec.domains` to plain hosts.
  - **`DockerExecutorPort` gains:**
    - `applySiteRoutes(req: SiteRoutesRequest): Promise<void>`, where `interface SiteRoutesRequest { siteId: string; serviceInstanceId: string; containerName: string; internalPort: number; hosts: readonly SiteHostRoute[] }`.
    - `getCertificateStatus(req: { failuresSince: string }): Promise<CertificateStatusReport>`, where `interface CertificateStatusReport { acmeEnabled: boolean; trusted: boolean; readable: boolean; certificates: readonly StoredCertificate[]; failures: readonly AcmeFailure[] }`, and `AcmeFailure` is the `parseAcmeFailures` element type.
  - **`DockerEngineSocketAdapter.applySiteRoutes`:**
    1. Find the container by `service_instance_id`. Require its `site_id` label to equal `req.siteId` and its name to equal `containerName`; otherwise `NOT_FOUND`. `applySiteRoutes` and `deployService` pass `reservedHosts: [panel.hostname, panel.ipv4]` to the YAML builder.
    2. With hosts: `ensureIngressProxy()`, then connect the proxy to `hp_edge_<siteId>_net` (idempotent), then `upsertServiceRoute`.
    3. Without hosts: remove the route and disconnect, as `deployService` does today.
  - **`getCertificateStatus`:**
    - `acmeEnabled = Boolean(panel?.acmeEmail)`;
    - `trusted` is false for staging or a custom CA;
    - `readAcmeCertificates(<acme dir>/<acmeStorageFileName(panel)>)`;
    - proxy logs from `GET /containers/hp_ingress_proxy/logs?stdout=1&stderr=1&since=<unix s>&tail=2000`, demuxed with `demuxDockerLogStream` and parsed with `parseAcmeFailures`;
    - a 404 on the proxy gives `failures: []`.
  - **IPC routes:** `POST /v1/sites/routes` (`SiteRoutesIpcRequestSchema`) and `POST /v1/ingress/certificates` (`CertificateStatusIpcRequestSchema = z.object({ failuresSince: z.string().datetime({ offset: true }) })`). Responses are validated in the client with `CertificateStatusReportWireSchema`. Both use the default 35 s timeout.
  - `Phase1DisabledDockerExecutor` throws `NOT_SUPPORTED` for both.
  - **Simulator:**
    - `readonly appliedRoutes: Map<string, SiteRoutesRequest>`, keyed by site;
    - deploys with `hostRoutes` also record into `appliedRoutes`;
    - `issueCertificate(hostname: string, notAfter: string)`;
    - `failCertificate(hostname: string, problem: CertProblem, at?: string)`;
    - `setCertificateStoreReadable(readable: boolean)`;
    - `acmeEnabled` defaults to `true`.

- [ ] **Step 1: Write the failing tests:**
  - `applySiteRoutes writes the plan without touching the container`: with the mock daemon, there is no `POST /containers/create` or `/stop`, and `site_<id>.yml` contains `router_<svc>_0_tls`.
  - `applySiteRoutes refuses a service of another site` → `NOT_FOUND`, and no file is written.
  - `applySiteRoutes refuses the panel hostname` → `HOST_POLICY_DENIED`.
  - `deploy with hostRoutes writes the same plan as applySiteRoutes` (identical file bytes).
  - `certificate IPC returns hostnames and expiry but never a private key`: write a fixture store under the mock ingress root, call it through the signed server and client, and check that the body lacks `"key"` and the key's base64.
  - `certificate IPC reports ACME failures from the proxy log`: the mock daemon's `logsBody` is a multiplexed frame carrying the Task 3 JSON line.
  - `phase1 executor refuses routes and certificates with NOT_SUPPORTED`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.** The mock daemon in `apps/docker-executor/test/mock-docker-daemon.ts` already serves `GET /containers/<id>/logs` from `logsBody`, so reuse it.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(executor-contracts): route-only updates and read-only certificate status over signed IPC`.

---

### Task 6: API — route plan, the `site.domains` operation, and pairs at creation

**Files:**
- Create: `apps/api/src/sites/domain-policy.ts` (pure), `apps/api/src/sites/site-domains-applier.ts`
- Modify:
  - `apps/api/src/runtime/service-spec.ts` (`buildApprovedServiceSpec` sets `hostRoutes`);
  - `apps/api/src/runtime/site-provisioner.ts` (`publish_site` activates every domain of the site, and `finish` sets `wordpress_url`);
  - `apps/api/src/sites/managed-sites.service.ts` (`create` inserts the `www` partner when `includeWww`);
  - `apps/api/src/runtime/outbox-worker.service.ts` (dispatch and unknown recovery);
  - `apps/api/src/app.module.ts`.
- Test: `apps/api/test/site-domains.integration.test.ts` (new; the `local-simulator` backend, as in `managed-sites.integration.test.ts`)

**Interfaces:**
- **Consumes:** Tasks 0, 1 and 5; `listSiteDomains`, `insertSiteDomains`, `renewOperationLease`, `transitionOperation`, `updateOperationStepTransactional`, `enqueueOperationTransactional`, `latestSiteOperation`, `appendAuditEvent` and `buildApprovedServiceSpec`.
- **Produces, in `domain-policy.ts` (pure, no I/O):**
  - `certificateUsable(row: DomainRow, now: Date): boolean`: `certStatus === "active"` and `certExpiresAt > now`.
  - `buildSiteHostRoutes(rows: readonly DomainRow[], now: Date, opts?: { transition?: boolean }): SiteHostRoute[]`. Only routed rows (`status === "active"`) are included. For each row:
    - `tls = certStatus === "active" || certStatus === "requested"`;
    - `httpsRedirect = certificateUsable(row, now)`;
    - `redirectTo`: for a non-primary row, `${certificateUsable(primary) ? "https" : "http"}://${primary.hostname}`; `null` for the primary.
    - With `transition: true`, `httpsRedirect` and `redirectTo` are forced to `false` and `null`.
  - `desiredWordpressUrl(rows, now, currentUrl: string | null): string | null`:
    - `null` when the primary is not routed;
    - `https://<primary>` when `currentUrl` already starts with `https://` (**never downgrade**), or when the primary's certificate is usable;
    - else `http://<primary>`.

    So a store briefly missing a certificate, an expiry, or a CA switch never rewrites the site's content back to `http://`.
  - `routePlanHash(hosts: readonly SiteHostRoute[], wordpressUrl: string | null): string`: sha256 hex of the canonical JSON.
  - `SITE_DOMAINS_STEPS = [{ key: "prepare", label: "Prepare the change" }, { key: "update_address", label: "Update your site's address" }, { key: "publish", label: "Publish the web addresses" }] as const`.
- **Produces, `SiteDomainsApplier.apply(op)`** for kind `site.domains`, `resourceType "site"`, lock `site:<id>`:
  1. Load the site, its rows, and the spec (`buildApprovedServiceSpec`) for `containerName` and `internalPort`.
  2. Let `current = site.wordpressUrl ?? (primary routed ? "http://" + primary : null)` and `wanted = desiredWordpressUrl(rows, now, current)`. `wpInstalled` means the latest `site.provision` succeeded.
  3. **`prepare`:** if `wpInstalled && wanted && wanted !== current`, call `applySiteRoutes(transition plan)`. Otherwise mark it `skipped` "Nothing to change".
  4. **`update_address`:** under the same condition, run the `wordpress.set-url` job with `jobId: job_<op>_url`, params `{ phpVersion, siteUrl: wanted, previousUrl: current }`. Otherwise mark it `skipped`.
  5. **`publish`:** `applySiteRoutes(final plan)`, then set `sites.applied_routes = final`, `applied_routes_hash = routePlanHash(final, wanted)`, and `wordpress_url = wanted` when the job ran.
  6. On success: `succeeded`, and audit `site.domains.applied`. On failure: the operation is `failed` with errorMessage "The web address change did not finish. We'll try again shortly.", and the step message is the fixed failed text. The admin-only audit `site.domains.failed` gets `{ step, exitCode, outputTail }`. The **site status is not changed**.

  The lease is renewed to `SITE_STEP_LEASE_MS` before each step, as in `SiteProvisioner`.
- **Changes to 2a code:**
  - **`buildApprovedServiceSpec`** keeps the `exposeHttp` gate from `service-spec.ts:255`. When `exposeHttp` is true:
    - `hostRoutes` is `site.appliedRoutes` when it is set, filtered to the rows still `active` (a removed name drops out);
    - otherwise, for a site never applied, it is `buildSiteHostRoutes(activeRows, now)`. At publish no certificate exists yet and WordPress is on `http://<primary>`, so this plan needs no transition step;
    - `domains = hostRoutes.map(h => h.hostname)`.

    When `exposeHttp` is false, both are `[]`. A restart, start or PHP change therefore re-publishes exactly the last applied plan. It never publishes a new one that skips the transition step.
  - `publish_site` sets **every** domain of the site `active`, not only the primary. After its deploy it stores the plan it deployed as `applied_routes` and `applied_routes_hash`, with `wordpress_url = "http://" + primary`, so the first reconcile pass finds nothing to do.
  - `ManagedSitesService.create` adds the `wwwPartner` row (pending) in the same transaction when `body.includeWww`. The 2a domain-conflict check covers both names, and `DOMAIN_CONFLICT` names neither.
  - **Unknown recovery:** `site.domains` in `unknown` converges straight to `failed` with "This change was interrupted. We'll try again shortly." It is **not** added to `SITE_OPERATION_KINDS`, so the site is not degraded. Task 8's reconciler re-enqueues it.

- [ ] **Step 1: Write the failing tests:**
  - `create with includeWww adds a pending pair that goes live at publish`: after provisioning, `simulator.deployedSpecs.at(-1).hostRoutes` has two hosts, and `www.hotel.it` has `redirectTo "http://hotel.it"`.
  - `a URL change opens a transition plan before running set-url`:
    1. Mark `hotel.it` `certStatus active` with `certExpiresAt` 60 days ahead.
    2. Enqueue and process `site.domains`.
    3. `simulator.appliedRoutes` history shows first a plan with every `redirectTo` null and `httpsRedirect` false, then the `wordpress.set-url` job with `previousUrl http://hotel.it` and `siteUrl https://hotel.it`, then the final plan with `httpsRedirect: true`.
    4. `sites.wordpress_url` is `https://hotel.it`.

    Give the simulator an append-only `routeHistory: SiteRoutesRequest[]` for this.
  - `no URL change skips prepare and update_address`.
  - `a failed set-url keeps the site ready and leaves the safe transition plan`: `failNextJob("wordpress.set-url", 1)` gives:
    - op `failed` and site `ready`;
    - `applied_routes_hash` and `wordpress_url` unchanged;
    - the last entry in `routeHistory` is the transition plan (every host serves, no redirects), which loops for nobody;
    - the outputTail appears only in the audit.
  - `an expired certificate stops the https redirect but keeps the resolver`: `buildSiteHostRoutes` with `certExpiresAt` yesterday → `{ tls: true, httpsRedirect: false }`.
  - `expired certificate keeps the WordPress address on https`: `desiredWordpressUrl(rows with an expired primary, now, "https://hotel.it")` → `"https://hotel.it"`.
  - `store briefly missing a certificate never rewrites the site to http`:
    1. With `wordpress_url = https://hotel.it`, set the primary `requested` (as Task 8 does when the store lost it).
    2. Process `site.domains`.
    3. No `wordpress.set-url` job runs, and `wordpress_url` is still `https://hotel.it`.
  - `a restart re-publishes the last applied plan`: after an apply with `httpsRedirect: true`, change a row to `requested` without applying, then `PATCH runtime`. The deployed spec's `hostRoutes` equals `applied_routes`, not the recomputed plan.
  - `publish_site stores the applied plan`: after provisioning, `applied_routes_hash` equals the hash of the deployed plan, and a following `reconcileOnce` enqueues no `site.domains`.
  - `interrupted site.domains converges to failed without degrading the site`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm run build && corepack pnpm exec vitest run apps/api/test/site-domains.integration.test.ts`.
- [ ] **Step 3: Implement.** Rerun `apps/api/test/managed-sites.integration.test.ts` unchanged. The `domains: ["hotel.it"]` expectations must still hold, because `includeWww` defaults to `false`.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(api): host route plan and the site.domains operation with WordPress address switch`.

---

### Task 7: API — DNS check and retry policy

**Files:**
- Create: `apps/api/src/sites/dns-check.ts`
- Modify: `apps/api/src/sites/domain-policy.ts`, `apps/api/src/tokens.ts` (`DNS_LOOKUP_TOKEN`), `apps/api/src/create-app.ts` (`dnsLookup` option and `HP_DNS_RESOLVERS`), `apps/api/src/app.module.ts`
- Test: `apps/api/test/domain-policy.test.ts` (new, pure)

**Interfaces (produces):**
- **Lookup:**
  - `interface DnsLookup { lookup(hostname: string): Promise<{ a: string[]; aaaa: string[] }> }`. It throws on resolver failure.
  - `createNodeDnsLookup(servers: readonly string[]): DnsLookup`. Each `lookup` creates a **new** `dns.promises.Resolver({ timeout: 2000, tries: 1 })`, so no cache can return a stale answer to "Check now". It then calls `setServers(servers)`, and `resolve4` and `resolve6` in parallel. An error whose `code` is `dns.NODATA` or `dns.NOTFOUND` means an empty list for that family. Any other code rethrows. With 3 servers, the worst case is about 6 s per lookup.
  - `DEFAULT_DNS_RESOLVERS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"]`. `HP_DNS_RESOLVERS` is a comma list, and `host:port` is allowed for the harness.
- **Policy functions:**
  - `evaluateDns(observed: { a: string[]; aaaa: string[] }, serverIpv4: string): Exclude<DnsStatus, "unchecked" | "lookup_failed">`. The rules, in order:
    1. `a` empty → `not_found`;
    2. any `a !== serverIpv4` → `points_elsewhere`;
    3. `aaaa` not empty → `ipv6_conflict`;
    4. otherwise `ok`.
  - `nextDnsCheckAt(now, status, attempts): Date`:
    - `ok`: now + 6 h;
    - otherwise now + `[1, 2, 5, 10, 30, 60][attempts]` minutes, then 360 minutes.
  - `certRetryAt(now, problem, attempts): Date`:
    - `rate_limited`: now + 24 h;
    - otherwise now + `[15, 60, 180, 360][attempts]` minutes, then 1440 minutes.
  - `CERT_REQUEST_TIMEOUT_MS = 10 * 60_000`: a `requested` host with no certificate and no reported failure after this long counts as failed `other`.
  - `MANUAL_CHECK_MIN_INTERVAL_MS = 10_000`.
  - `MANUAL_CERT_RETRY_GAP_MS = 15 * 60_000`, and `manualCertRetryAt(now, row): Date | null`:
    - `null` (no change) for `rate_limited`, or when the row is not `failed`;
    - otherwise `max(now, certRequestedAt + MANUAL_CERT_RETRY_GAP_MS)`, and never later than the current `certRetryAt`.

- [ ] **Step 1: Write the failing tests** (pure, no DB):
  - `evaluateDns flags any AAAA as ipv6_conflict`: `{ a: [ip], aaaa: ["2001:db8::1"] }` → `ipv6_conflict`.
  - `an A record set mixing this server and another is points_elsewhere`.
  - `no A record is not_found`.
  - `retry schedule never retries a rate limit before 24 h`: for attempts 0–10, `certRetryAt(now, "rate_limited", n) - now >= 24 h`.
  - `the other failures back off 15 min, 1 h, 3 h, 6 h, then daily, so at most 2 tries per hour per hostname`, well under Let's Encrypt's 5 failed authorizations per hostname per hour.
  - `DNS checks back off 1, 2, 5, 10, 30, 60 min, then 6 h, and every 6 h once ok`: `nextDnsCheckAt` for attempts 0 to 7 with `not_found`, plus `ok` at attempt 5 → +6 h.
  - `manualCertRetryAt never allows two attempts within 15 min`: requested at T, failed at T+1 min, a click at T+2 min gives T+15 min; `rate_limited` gives `null`.
  - `createNodeDnsLookup maps NODATA to an empty list`. Inject a fake `Resolver` through an optional second parameter, `resolverFactory`, used only by this test.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(api): DNS check against public resolvers and certificate retry policy`.

---

### Task 8: API — the domain reconciler

**Files:**
- Create: `apps/api/src/sites/domain-reconciler.service.ts`
- Modify: `apps/api/src/create-app.ts` (start and stop the loop; `domainReconcileIntervalMs` option and env `HP_DOMAIN_RECONCILE_INTERVAL_MS`; default `60_000` when listening and the backend is not `disabled`, else `null`, mirroring `driftReconcileIntervalMs`), `apps/api/src/tokens.ts` (`ControlPlaneRuntimeConfig.domainReconcileIntervalMs`), `apps/api/src/app.module.ts`
- Test: `apps/api/test/site-domains.integration.test.ts` (`describe("reconciler")`)

**Interfaces:**
- **Consumes:** Tasks 5, 6 and 7.
- **Produces:**
  - `DomainReconcilerService`:
    - `startBackgroundLoop()` and `stop()`, as in `DriftReconcilerService`;
    - `reconcileOnce(now = new Date()): Promise<void>`: returns at once when the backend is `disabled`;
    - `reconcileSite(siteId: string, now: Date, opts?: { forceDnsCheck?: boolean }): Promise<void>`.
  - **Both entry points run on one in-process promise chain (`#serial`).** A request's `reconcileSite` waits for a running pass, and the pass waits for it, so two runs never touch the same rows at once.
  - Every certificate-state update is a guarded `UPDATE … WHERE id = $1 AND cert_status = $expected`. A zero row count means another writer won, and the change is skipped, along with its audit row.
  - `reconcileOnce` calls `getCertificateStatus` **once** per pass and shares the report across sites. `reconcileSite` calls it once for its own site.
  - **One pass per managed site** (`php_version IS NOT NULL`), skipping sites in `deploying` or `maintenance`:
    1. **DNS.** For each row with `dnsNextCheckAt <= now` (or `forceDnsCheck`):
       - `lookup`, then `evaluateDns` against `hosts.ipv4Address`;
       - a lookup error gives `lookup_failed`;
       - store `dnsObserved` and `dnsCheckedAt`;
       - `dnsAttempts` resets to 0 on `ok` and is incremented otherwise;
       - `dnsNextCheckAt = nextDnsCheckAt(…)`.
    2. **Certificate report.** Call `executor.getCertificateStatus({ failuresSince })`, where `failuresSince` is the oldest `certRequestedAt` among requested rows, else now − 10 min. If the call fails, skip steps 3 and 4 for this pass.
    3. **Certificate states**, per row (`stored` = the report entry with the same hostname):
       - `stored` exists → `active`, `certExpiresAt`, `certTrusted = report.trusted`, `certProblem` null, `certAttempts` 0. Audit `site.certificate.issued` on the first transition and on each new `serialNumber`, so renewals show in the activity feed.
       - The row is `active` and a `kind: "renew"` failure is reported for it → it stays `active`, but `certProblem` is set. That feeds the admin alert. A later new `serialNumber` clears it.
       - The row is `active`, `report.readable`, and there is no `stored` → `requested` with `certRequestedAt = now`. Traefik re-obtains it under the same resolver, for example after a staging-to-production switch. When `!report.readable`, **nothing changes**.
       - The row is `requested`:
         - a failure for the hostname with `at >= certRequestedAt` → `failed`, `certProblem`, `certAttempts + 1`, `certRetryAt = certRetryAt(…)`; audit `site.certificate.failed` with `{ hostname, problem, detail }` (admin-only);
         - else past `CERT_REQUEST_TIMEOUT_MS` → the same with `other`;
         - else, if `dnsStatus !== "ok"` → `none`, so the resolver is dropped.
       - The row is `none`, or `failed` with `certRetryAt <= now`, **and** `dnsStatus === "ok"`, **and** it is routed, **and** `report.acmeEnabled` → `requested`, `certRequestedAt = now`.
       - An `active` row is never moved because DNS changed.
    4. **Apply**, in the same pass as step 3, so a failure's resolver removal is enqueued at once. Compute `routePlanHash(buildSiteHostRoutes(rows, now), desiredWordpressUrl(rows, now, site.wordpressUrl))`. It counts as applied when it equals `site.appliedRoutesHash`, or when `appliedRoutesHash` is null and the plan is empty. Otherwise, enqueue `site.domains` (no actor, lock `site:<id>`) unless one of these holds:
       - a `site.domains` operation for the site is non-terminal;
       - the latest one failed less than 10 min ago.

       `RESOURCE_LOCKED` is swallowed, and the next pass retries. Then `outboxWorker.triggerAsync()`.

- [ ] **Step 1: Write the failing tests.** Use an injected `DnsLookup` fake, the simulator, `domainReconcileIntervalMs: null` and explicit `reconcileOnce(now)` calls with advancing `now`.
  - `waiting for DNS until the A record points here, then a certificate is requested and the site goes https`:
    1. DNS → `not_found`, and nothing is requested.
    2. Point it here and reconcile → `ok`, `requested`; a `site.domains` op runs, and `appliedRoutes` shows `tls: true, httpsRedirect: false`.
    3. `simulator.issueCertificate("hotel.it", +90 d)` and reconcile → `active`; the next op runs `set-url` and then applies `httpsRedirect: true`.
  - `a failure removes the resolver and schedules a retry`: `failCertificate("hotel.it", "port_80_blocked")` → `failed`, the applied plan has `tls: false`, and `certRetryAt` is 15 min later. At +16 min it is `requested` again.
  - `check now does not shorten a rate-limit wait`: after a `rate_limited` failure, `SiteDomainsService.check` at now + 1 min leaves `failed` with the same `certRetryAt`.
  - `check now cannot bring a certificate retry forward twice within 15 min`:
    1. A `port_80_blocked` failure on a request made at T.
    2. Checks at T+1, T+2 and T+3 min, with a reconcile after each.
    3. The row stays `failed` with `certRetryAt = T+15 min`, and `simulator` sees no new request before T+15.
    4. At T+16 one request is made. Its failure, then a check at T+17, gives a retry at T+31, not earlier.
  - `concurrent reconciles never request twice`: `Promise.all([reconcileOnce(now), reconcileSite(id, now)])` on a DNS-ok row gives exactly one `none → requested` and one audit row.
  - `a renewal failure keeps the certificate active and raises the problem`: an `active` row plus a `renew` failure → `active` with `certProblem "port_80_blocked"`.
  - `an unreadable store keeps every certificate state`: with an `active` row, `setCertificateStoreReadable(false)` and reconcile → still `active`, and no new `site.domains` op.
  - `DNS pointing away later never drops an issued certificate`: `active`, then DNS → `points_elsewhere` → still `active` and `tls: true`.
  - `a AAAA record blocks the request`: DNS `ipv6_conflict` → `certStatus` stays `none`.
  - `a locked site is retried on the next pass` (a `site.provision` holding the lock).
  - `the reconciler never requests with acme disabled` (simulator `acmeEnabled = false`).
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(api): domain reconciler drives DNS checks, certificate requests and route updates`.

---

### Task 9: API — domain endpoints for the customer and the administrator, and certificate alerts

**Files:**
- Create: `apps/api/src/sites/site-domains.service.ts`, `apps/api/src/controllers/site-domains.controller.ts`
- Modify: `apps/api/src/controllers/admin-sites.controller.ts`, `apps/api/src/sites/managed-sites.service.ts` (`listAll` adds `certificateAlerts`), `apps/api/src/controllers/organizations.controller.ts:323` (capability flag from config), `apps/api/src/app.module.ts`
- Test: `apps/api/test/site-domains.integration.test.ts` (`describe("endpoints")`), `apps/api/test/admin-sites.integration.test.ts`

**Interfaces:**
- **Produces, `SiteDomainsService`** (every method takes an already-authorized `siteId` and `organizationId`):
  - `list(siteId, organizationId): Promise<SiteDomainsDto>`. `routesPending` is true when the reconciler's apply test from Task 8 step 4 is false.
  - **`add(siteId, organizationId, input: AddSiteDomainInput, actorId): Promise<SiteDomainsDto>`:**
    - With `includeWww`, the names are the hostname plus `wwwPartner`.
    - A name already on **this** site is skipped, which makes the call idempotent.
    - A name on another site, or the panel's hostname or IPv4, gives `DOMAIN_CONFLICT`: "This web address is already used by another site or by the panel."
    - More than `MAX_SITE_DOMAINS` gives `VALIDATION_ERROR`: "A site can have up to 10 web addresses. Remove one first."
    - Rows are inserted with `routed` = the primary is routed. Then `reconcileSite(siteId, now, { forceDnsCheck: true })`.
  - **`remove(siteId, organizationId, domainId, actorId)`:**
    - the primary gives `VALIDATION_ERROR`: "Choose another main address first, then remove this one.";
    - the last domain gives `VALIDATION_ERROR`: "A site needs at least one web address.";
    - otherwise the row is deleted, then `reconcileSite`.
  - **`setPrimary(siteId, organizationId, domainId, actorId)`:**
    - It is allowed only when the target row's certificate is usable (`certificateUsable`), or `site.wordpressUrl` does not start with `https://`.
    - Otherwise it gives `VALIDATION_ERROR`: "Wait until HTTPS is active on this address, then make it the main address."
    - It swaps `is_primary` in one transaction (clear first, then set), then calls `reconcileSite`.
  - **`check(siteId, organizationId, domainId)`:**
    - When `dnsCheckedAt` is newer than `MANUAL_CHECK_MIN_INTERVAL_MS`, it returns the list unchanged.
    - Otherwise it resets `dnsAttempts` to 0, and sets `certRetryAt = manualCertRetryAt(now, row)` when that is not null.
    - Then `reconcileSite(…, { forceDnsCheck: true })`.
  - All four mutating methods do their row change in a transaction **before** calling `reconcileSite`, which takes the `#serial` chain from Task 8. The request waits at most one DNS lookup (about 6 s) plus one certificate report.
  - A domain id that is not on the site gives `NOT_FOUND`.
- **Customer routes** under `v1/organizations/:orgId/managed-sites/:siteId/domains`, with the same `get`-then-`requireOrgPermission` pattern as `ManagedSitesController`:
  - `GET` (`site.read`);
  - `POST` with body `AddSiteDomainInputSchema` (`site.update`) → 201;
  - `DELETE :domainId` (`site.update`) → 200;
  - `POST :domainId/primary` (`site.update`) → 200;
  - `POST :domainId/check` (`site.read`) → 200.

  Each returns `{ data: SiteDomainsDto }`. No `Idempotency-Key`: every call is idempotent by design. Audit `site.domain.add`, `site.domain.remove` and `site.domain.primary`, with `{ hostnames }`.
- **Admin routes** under `v1/admin/sites/:siteId/domains`: the same five, using `requireServerAdmin` and `ownerOf(siteId)`. Audit `admin.site.domain.*`.
- **Alerts in `listAll`:**
  - `expiring`: an `active` certificate with `certExpiresAt < now + 14 d`, or an `active` certificate with `certProblem` set (renewal is failing);
  - `not_issued`: `failed` with `certAttempts >= 2`, or a problem in `port_80_blocked`, `caa_blocked` or `other`;
  - `panel_expiring`: from `getCertificateStatus` for `hosts.hostname`, ignored when the executor is unavailable.
- `organizations.controller.ts` `#buildCapabilities()` (lines 314-327) builds its own object literal, not through `createPlatformCapabilities`. Set `acmeTlsRuntimeAvailable: this.config.runtimeBackend === "linux-systemd"` there, at line 323.

- [ ] **Step 1: Write the failing tests:**
  - `customer adds a pair and sees the A records state`: POST `{ hostname: "bellavista.it" }` → 201, two domains, `dns.status` set by the fake lookup, and `serverIpv4` equal to the host's IPv4.
  - `adding the same name twice is idempotent; another site's name is a conflict`.
  - `the primary cannot be removed`, and `the last domain cannot be removed`.
  - `set primary swaps and triggers a set-url`: after `www.hotel.it` becomes primary with both certificates active, the next op's job has `siteUrl https://www.hotel.it`.
  - `main address moves only to a name with working HTTPS`: with the site on `https://hotel.it` and `www.hotel.it` `requested`, `primary` gives 400 with the "Wait until HTTPS is active" text. On a site still on `http://`, the same call succeeds.
  - `customer cannot read or change domains of another organization's site`: 404 on all five routes, including for an unassigned admin-held site.
  - `a collaborator can read and check but not add` (403 on POST).
  - `admin manages domains of an unassigned site`, with the audit action `admin.site.domain.add`.
  - `admin list shows an expiring certificate alert` (`certExpiresAt` 10 days ahead).
  - `capabilities report acme on linux-systemd only`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(api): domain endpoints for customers and administrators, certificate alerts`.

---

### Task 10: Web — the customer Domains tab, header pills and the create form

**Files:**
- Create:
  - `apps/web/src/components/customer/domains-panel.tsx` (client);
  - `apps/web/src/components/customer/certificate-pill.tsx`;
  - `apps/web/src/app/sites/[siteId]/domains/page.tsx`;
  - BFF routes `app/api/bff/orgs/[orgId]/managed-sites/[siteId]/domains/route.ts` (GET, POST), `…/domains/[domainId]/route.ts` (DELETE), `…/domains/[domainId]/primary/route.ts` (POST) and `…/domains/[domainId]/check/route.ts` (POST).
- Modify:
  - `components/customer/site-tabs.tsx`: `SITE_TABS` order `overview`, `domains`, `logs`;
  - `app/sites/[siteId]/layout.tsx`: the certificate pill, the `Waiting for DNS` pill, and an `https://` WP Admin link when the primary certificate is usable;
  - `app/sites/[siteId]/page.tsx`: `ACTIVITY["site.domains"] = "domains"`, and the domains card links to the tab;
  - `components/customer/site-form.tsx`: an "Also `www.<domain>`" checkbox, defaulting to `suggestWwwPair`;
  - `lib/server-api.ts`: `fetchServerSiteDomains(orgId, siteId)`;
  - `lib/bff-proxy.ts`: `forwardToUpstream` accepts `"DELETE"`;
  - `i18n/it.ts` and `i18n/en.ts`.
- Test: `apps/web/test/site-domains.test.ts` (new), `apps/web/test/ui-copy.test.ts`. Extend the jargon regex at line 47 to `/\b(container|docker|image|volume|network|service|template|mariadb|job|organization|revision|drift|allocation|outbox)\b|HCP-SPEC|AC-F|ADR-/i`. That test checks only the customer sections and sources, and today the `site` copy has none of the new words. Fix any hit in the customer copy, not the regex.

**Interfaces:**
- **Consumes:** Task 9 routes and the Task 0 DTOs.
- **Produces:**
  - `domainView(d: SiteDomainDto, primary: SiteDomainDto, now: Date): { tone: "ok" | "warn" | "error" | "muted"; label: keyof Messages["site"]["domains"]["state"]; hint: keyof Messages["site"]["domains"]["hint"] | null }`, exported for tests. The order:
    1. not routed → `settingUp`;
    2. DNS not `ok` → `waitingForDns` with a hint by DNS status;
    3. certificate `requested` → `securing`;
    4. `failed` → `httpsProblem` with a hint by problem;
    5. `active` and expired → `httpsExpired`;
    6. `active` and not trusted → `testCertificate`;
    7. `active` → `secure`.
  - **`DomainsPanel({ basePath, csrfToken, initial })`:**
    - a "Records to create at your domain provider" box listing, for each domain, type `A`, name = hostname, value = `serverIpv4`, each with a copy button;
    - one row per domain: state pill, hint, "Main address" or "Redirects to <primary>", and the actions "Make main address", "Check now" and "Remove". Remove uses a confirmation that names the consequence: "Visitors using <host> will no longer reach your site.";
    - an add form with an "Also add www" checkbox.
    - It polls `GET` every 5 s while `routesPending`, or any domain is `requested` or not routed, and stops after 10 min.
    - Errors come from the API code, mapped to i18n: `DOMAIN_CONFLICT`, `VALIDATION_ERROR` (the API message is shown), `RESOURCE_LOCKED` → the existing busy text.
- **Copy (IT and EN)**, under `site.domains`:

  | Key | EN text |
  |---|---|
  | `state` | `settingUp` "Getting ready"; `waitingForDns` "Waiting for DNS"; `securing` "Setting up HTTPS"; `secure` "HTTPS active"; `httpsProblem` "HTTPS not active yet"; `httpsExpired` "HTTPS expired"; `testCertificate` "Test certificate" |
  | `hint.not_found` | "This address doesn't point anywhere yet. At your domain provider, create an A record for {host} with the value {ip}. Changes can take a few hours; we check automatically." |
  | `hint.points_elsewhere` | "{host} points to {seen}, not to this server. Change its A record at your domain provider to {ip}." |
  | `hint.ipv6_conflict` | "{host} also has an IPv6 (AAAA) record. Delete it at your domain provider: this server answers on IPv4 only." |
  | `hint.lookup_failed` | "We couldn't check right now. We'll try again automatically." |
  | `hint.rate_limited` | "Let's Encrypt asked us to wait before creating another certificate for this address. We'll try again automatically on {time}; you don't need to do anything." |
  | `hint.port_80_blocked` | "Let's Encrypt couldn't reach your site from the internet. Your server administrator has been alerted. We'll try again on {time}." |
  | `hint.not_pointing` | "Let's Encrypt reached a different server for {host}. Check that its A record is {ip} and that there is no AAAA record. We'll try again on {time}." |
  | `hint.caa_blocked` | "A setting at your domain provider (a CAA record) doesn't allow Let's Encrypt. Ask them to allow letsencrypt.org, or delete the CAA record." |
  | `hint.other` | "The certificate couldn't be created. We'll try again on {time}. If this keeps happening, contact your server administrator." |
  | `pill` | `validUntil` "HTTPS valid until {date}" |
  | `activity` | `domains` "Web addresses updated" |

  The IT texts are the faithful translations, for example "In attesa del DNS", "HTTPS attivo fino al {date}" and "Crea un record A per {host} con valore {ip}…".

- [ ] **Step 1: Write the failing tests** in `site-domains.test.ts`:
  - `domains BFF forwards add, remove, primary and check with CSRF`. A bad CSRF token gives 403 with no upstream call. The good paths call `v1/organizations/org-1/managed-sites/s1/domains[/d1[/primary|/check]]` with the right method.
  - `domainView orders states`: one case per state above.
  - `panel lists the A records with the server IP` (`renderToStaticMarkup` with `I18nProvider`): contains `hotel.it`, `www.hotel.it` and `203.0.113.10`.
  - `every domain hint exists in both languages and names a next step`: every `hint` key exists in `it` and `en`, and is non-empty.
  - `site tabs include domains between overview and logs`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm --filter @hosting-panel/web exec vitest run test/site-domains.test.ts`.
- [ ] **Step 3: Implement.** Read `apps/web/node_modules/next/dist/docs/` for any App Router change first, as `apps/web/AGENTS.md` asks.
- [ ] **Step 4: Run them and confirm they pass, plus `ui-copy.test.ts` and the four checks.**
- [ ] **Step 5: Commit** `feat(web): Domains tab with DNS guidance, HTTPS status and www pair`.

---

### Task 11: Web — administrator domains page and certificate alerts

**Files:**
- Create: `apps/web/src/app/admin/sites/[siteId]/domains/page.tsx`, BFF `app/api/admin/sites/[siteId]/domains/route.ts`, `…/[domainId]/route.ts`, `…/[domainId]/primary/route.ts` and `…/[domainId]/check/route.ts`
- Modify: `components/admin/sites-table.tsx` (a "Domains" link per row), `app/admin/sites/page.tsx` (an alerts card above the table when `certificateAlerts` is not empty), `lib/server-api.ts` (`fetchServerAdminSiteDomains(siteId)`), `i18n/it.ts`, `i18n/en.ts` (`admin.sites.domains*` and `admin.sites.alerts*`)
- Test: `apps/web/test/admin-sites.test.ts`

**Interfaces:**
- **Consumes:** Task 9 admin routes and Task 10 `DomainsPanel` (with `basePath="/api/admin/sites/<id>/domains"`).
- **Produces:**
  - The admin page reuses `DomainsPanel` unchanged.
  - Alert lines, by kind:
    - `expiring`: "<host> (<site>): certificate expires on <date> and has not renewed";
    - `not_issued`: "<host> (<site>): no certificate — <problem text>";
    - `panel_expiring`: "Panel address <host>: certificate expires on <date>".

    Admin copy may be technical and is not subject to the customer jargon test.

- [ ] **Step 1: Write the failing tests:**
  - `admin domains BFF requires CSRF and forwards to v1/admin/sites/s1/domains`.
  - `admin sites page shows certificate alerts`: render the alerts card with one `expiring` and one `not_issued`, and check that both hostnames and the date appear.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(web): admin domain management and certificate alerts`.

---

### Task 12: Installer checks, ADR 0017, docs and version

**Files:**
- Create: `docs/architecture/adr/0017-domains-dns-and-acme-tls.md`
- Modify:
  - `infra/linux/install.sh`:
    - a private-IPv4 warning after "Panel IPv4";
    - a reserved ACME email domain check after line 215;
    - the usage text says the ACME email is the Let's Encrypt contact and must be real.
  - `infra/linux/install.test.ts`;
  - `README.md` (Italian):
    - a "Domini e HTTPS" section: the A record, `www`, no AAAA, staging (`--acme-staging`), where `acme.json` lives, the alert threshold of 14 days;
    - the capability table row becomes `true`.
  - `HARNESS.md`: project map entries `acme-status.ts`, `domain-reconciler.service.ts`, `site-domains-applier.ts`, `dns-check.ts` and `domain-policy.ts`; `acme*.json` in the key and state list.
  - `.agents/brain/state.md`: Step 2b status.
  - `docs/api/openapi.yaml`: the five customer and five admin domain routes, `SiteDomainsDto`, `certificateAlerts`, and `acmeTlsRuntimeAvailable` as boolean.
  - root `package.json` `version` → `0.4.0`.
  - `apps/api/src/cli/accounts.ts` (`setupInstallation` updates the host address, M3).
- Test: `infra/linux/install.test.ts`, `apps/api/test/infra-layout.test.ts`, `apps/api/test/accounts-cli.test.ts`

**Interfaces:**
- **`install.sh`:**
  - `is_private_ipv4 <addr>` is true for `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `127/8` and `169.254/16`. When true it prints `WARNING: <ip> is a private address. Customers' A records must point to this server's public IPv4; if the server is behind NAT, rerun with --ipv4 <public address>.` and continues.
  - **Panel hostname check.** When `getent ahostsv4 <hostname>` does not list `<ipv4>`, the installer prints `WARNING: <hostname> does not resolve to <ipv4> yet. Create its A record now: until it resolves, the panel uses a temporary certificate and Let's Encrypt attempts for it fail.` and continues. The dry run skips this check. README "Domini e HTTPS" says the same. This is S2 option (b); gating the panel router is left to the owner (open question 1).
- **`apps/api/src/cli/accounts.ts` `setupInstallation` (M3).** Today it returns early when the installation and host rows exist (lines 63-64), so a rerun with a new `--ipv4` never reaches the database. It now updates `hosts.ipv4_address`, `hostname` and `name` on the existing row when they differ, and appends an audit event `host.address.change` with `{ from, to }` (actor type `system`). The rerun advice in the NAT warning therefore works: `install.sh:542` passes `--ipv4` to `hp-accounts setup` on every run, and `executor.env` `HP_PANEL_IPV4` is already rewritten.
  - An ACME email whose domain is `example.com`, `example.net` or `example.org`, or ends in `.example`, `.test`, `.invalid` or `.localhost`, gives `die 2 "Use a real --acme-email: Let's Encrypt rejects <domain>"`.
- **ADR 0017** records:
  - the API decides and the executor writes, and why route-only updates replace redeploys;
  - Traefik retries failed domains on every reload, hence the resolver gate and the backoff table;
  - one certificate per hostname (one router per host), so one bad name never blocks its pair;
  - one storage file per CA (production, staging, custom);
  - read-only `acme.json` parsing tolerant of in-place writes;
  - IPv4-only serving, so AAAA blocks issuance;
  - the transition plan around `wordpress.set-url`;
  - `CP-01` renewal with no control plane;
  - LE lifetimes moving to 64 and 45 days, and why the default `certificatesDuration` stays;
  - no HSTS in this version, so a lost certificate never locks visitors out;
  - Traefik renews **every** stored certificate, used or not, so certificates of removed domains are renewed forever. This is the known limit, with the cleanup deferred;
  - WordPress never goes from `https` back to `http` automatically;
  - LE's 1,152-consecutive-failures pause, which the backoff keeps far away;
  - the capability flag is `true` on `linux-systemd` even if a dev setup has no ACME email.

  Status `APPROVATO — Step 2b`. Migration `0006`.

- [ ] **Step 1: Write the failing tests:**
  - `installer warns when the IPv4 is private and continues`: `--dry-run --ipv4 10.0.0.5 …` prints the warning and reaches `Dry run complete`.
  - `installer refuses a reserved ACME email`: `--acme-email ops@example.com` → exit 2.
  - In `apps/api/test/accounts-cli.test.ts`: `a second setup with a new --ipv4 updates the host row`. Setup with `203.0.113.10`, then with `203.0.113.20`, leaves one host row with `ipv4Address "203.0.113.20"` and a `host.address.change` audit row. A third, identical setup writes no new audit row.
  - `step 2b docs are consistent`: README contains `Domini e HTTPS` and `acme-staging`; `openapi.yaml` contains `/v1/organizations/{orgId}/managed-sites/{siteId}/domains` and `/v1/admin/sites/{siteId}/domains`; ADR 0017 exists; the version is `0.4.0`.
- [ ] **Step 2: Run them and confirm they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `docs: step 2b domains and Let's Encrypt ADR, installer checks, version 0.4.0`.

---

### Task 13: Container-harness acceptance with a local ACME CA (manual)

Same harness as `docs/security/step-2a-acceptance-report.md`:
- privileged systemd containers as VMs on the private bridge `hp-live-net` 10.231.0.0/24;
- `--memory 2g`;
- named volumes for `/var/lib/docker` and `/var/lib/containerd`.

Run the full checklist on **Ubuntu 26.04** and **Debian 13**, and step 1 on Ubuntu 24.04 and Debian 12. Let's Encrypt staging cannot reach these VMs. **A local Pebble CA replaces it, which is cheap:**
- `pebble-challtestsrv:2.10.1` runs on the outer bridge at 10.231.0.250 with `-defaultIPv4 "" -defaultIPv6 "" -http01 "" -https01 "" -tlsalpn01 "" -doh ""`, so DNS only, on `:8053`.
  - With an empty default, a name resolves only once it has an explicit `add-a` record.
  - Every name the steps below need gets one through the management API (`curl -d '{"host":"<name>","addresses":["<ip>"]}' http://10.231.0.250:8055/add-a`). That includes the panel hostname, pointed at the VM before install.
- `pebble:2.10.1` runs at 10.231.0.251:
  - with `-dnsserver 10.231.0.250:8053`, `PEBBLE_VA_NOSLEEP=1` and `PEBBLE_WFE_NONCEREJECT=0`;
  - with a config copied from `test/config/pebble-config.json`, where `httpPort: 80` and `profiles.default.validityPeriod: 1728000` (20 days, inside Traefik's 30-day renewal window, so a proxy restart renews).
- Inside each VM, after install:
  - `/etc/hosting-panel/executor.env` gets `HP_ACME_CA_SERVER=https://10.231.0.251:14000/dir` and `HP_ACME_CA_CERT_FILE=/etc/hosting-panel/pebble.minica.pem` (from pebble `test/certs/pebble.minica.pem`);
  - `/etc/hosting-panel/api.env` gets `HP_DNS_RESOLVERS=10.231.0.250:8053`;
  - then `systemctl restart hp-docker-executor hp-api`.

Record the results in `docs/security/step-2b-acceptance-report.md`. Drive every action through the BFF, as 2a did.

- [ ] **Step 1: Install `0.4.0`.** Expected:
  - exit 0, and the private-IPv4 warning is printed (10.231.x);
  - `traefik.yml` has `format: json` and `storage: /etc/traefik/acme/acme-custom.json` after the env change;
  - the proxy was recreated exactly once by that change, and `docker ps` shows its ID otherwise unchanged across reruns.
- [ ] **Step 2: Domain lifecycle without DNS.**
  1. The customer creates `hotel.test` with "Also www" ticked.
  2. No record exists yet. `curl -H 'Host: hotel.test' http://<vm>/` gives 200. The Domains tab shows "Waiting for DNS" with the A records (value = VM IP) for both names, and the hint "doesn't point anywhere".
  3. `add-a` `hotel.test` with 192.0.2.1, then "Check now" → "points to 192.0.2.1". `acme-custom.json` has no certificate for it.
- [ ] **Step 3: AAAA and the right A record.**
  1. `add-a` `hotel.test` and `www.hotel.test` with the VM IP, and `add-aaaa` `hotel.test` with `2001:db8::1` → "also has an IPv6 (AAAA) record". `acme-custom.json` has no certificate, and `site_<id>.yml` has no `certResolver`.
  2. `clear-aaaa`, then Check now → "Setting up HTTPS", then "HTTPS active" within 2 minutes. `site_<id>.yml` has `router_…_tls` for both hosts.
  3. `curl -k --resolve hotel.test:443:<vm> https://hotel.test/` gives 200 with the Pebble issuer.
  4. `curl -I http://hotel.test/` (`--resolve`) gives 301 to `https://hotel.test/`.
  5. `http://www.hotel.test/x` gives 301 to `https://hotel.test/x`.
  6. WordPress `home` (`wp option get home` via `docker exec`) is `https://hotel.test`.
- [ ] **Step 4: Failure and no hammering.**
  1. **Block first.** Ports 80 and 443 are published by Docker, so Pebble's traffic is DNAT-ed and never reaches the `input` hook of `hp_dedicated_filter`. Use a table of its own that sees it before DNAT:

     ```
     nft add table ip hp_test_block
     nft add chain ip hp_test_block pre '{ type filter hook prerouting priority -200; }'
     nft add rule ip hp_test_block pre ip saddr 10.231.0.251 tcp dport 80 drop
     ```
  2. Create `blocked.test`, then `add-a` it with the VM IP.
  3. Expected:
     - the tab shows "couldn't reach your site from the internet" with a retry time about 15 minutes ahead;
     - Pebble's log shows **at most 2** orders for `blocked.test` in the following 10 minutes, including one second site created right after the failure (which rewrites another route file). Traefik retries on every reload until the resolver is removed, at most one pass later;
     - from the pass after the failure, the route file of `blocked.test` has no `certResolver`.
  4. Record the real Traefik JSON log line. If its fields differ from the Task 3 fixture, fix the parser and fixture in this branch.
  5. Press Check now three times within 2 minutes: no new order (M1).
  6. `nft delete table ip hp_test_block`. Press Check now after 15 minutes from the failed request. Expected: one new order, then "HTTPS active".
- [ ] **Step 5: Primary switch.**
  1. Make `www.hotel.test` the main address.
  2. A curl loop every 0.25 s on both names during the change: no response is a redirect to itself, and `curl -L --max-redirs 5` never fails with "too many redirects".
  3. It ends with `hotel.test` → 301 `https://www.hotel.test/`, and `home` is `https://www.hotel.test`.
  4. The post content of `/hello-world/` links to `www`.
- [ ] **Step 6: `CP-01` with renewal.**
  1. Record the certificate serial (`openssl s_client … | openssl x509 -serial`).
  2. Run `systemctl stop hp-web hp-api hp-docker-executor hp-host-agent`.
  3. `docker restart hp_ingress_proxy`. Traefik renews at start because 20 days is under 30.
  4. Within 2 minutes the serial changes, and HTTPS and the HTTP→HTTPS redirect keep answering throughout. A curl loop sees no failure apart from the restart gap.
  5. Then `systemctl restart docker`: all sites come back with HTTPS.
  6. Start the units: the panel later shows the new expiry, and an audit `site.certificate.issued` exists for the new serial.
- [ ] **Step 7: Delete and update.**
  1. Delete `blocked.test`: its route file is gone, and `hotel.test` is untouched.
  2. `hp-update` to `0.4.1`: a curl loop on `https://www.hotel.test` sees no failure, and the proxy ID is unchanged.
- [ ] **Step 8: Write the report and commit** `docs(security): step 2b container-harness acceptance report`.

**Not possible in this harness, so left to Task 14:**
- real Let's Encrypt staging and production;
- a real `rate_limited` answer (Pebble has no rate limits, so only Task 3's fixture covers it);
- real public resolvers;
- a real browser trusting the certificate;
- a real kernel reboot.

---

### Task 14: Real-VM acceptance with the owner's test domain (manual)

Run on the owner's real VM: public IPv4, Ubuntu 26.04 or Debian 13, at least 2 GB. Use the owner's test domain, here written `<dom>`, with the panel at `panel.<dom>`.

- **Staging always comes first.** A production attempt is made only once staging has passed every step.
- Use a real ACME contact email.
- Remove any AAAA records for `<dom>` and `www.<dom>` before starting.
- Append the results to `docs/security/step-2b-acceptance-report.md`.

- [ ] **Step 1: Install on staging:** `install.sh --hostname panel.<dom> --acme-email <real> --acme-staging …`. Expected:
  - no private-IP warning;
  - the panel serves a staging certificate (issuer contains `(STAGING)`) once `panel.<dom>` resolves;
  - the panel's certificate appears in `acme-staging.json`.
- [ ] **Step 2: Add the site domain and point the registrar.**
  1. The customer creates a site with `<dom>` and "Also www".
  2. The Domains tab shows two A records with the VM's public IP.
  3. Create them at the registrar. Expected: "Waiting for DNS" turns to "Setting up HTTPS" without pressing anything, within the backoff schedule.
  4. Record the delay after the registrar change. "Check now" makes it immediate.
- [ ] **Step 3: HTTPS on staging, HTTP→HTTPS and the www pair.** Expected:
  - "Test certificate" for both names;
  - `curl -I http://<dom>/` → 301 `https://<dom>/`;
  - `curl -I http://www.<dom>/x` → 301 `https://<dom>/x`;
  - `curl -kI https://www.<dom>/` → 301 `https://<dom>/`;
  - `home` is `https://<dom>`.

  Record the staging certificate lifetime, which is expected to be 64 days since 14 Oct 2026.
- [ ] **Step 4: Renewal path, staging only.**
  1. With **every panel unit stopped**, add `      certificatesDuration: 8760` under `le.acme` in `/var/lib/hosting-panel/ingress/static/traefik.yml`, then `docker restart hp_ingress_proxy`. A one-year duration gives a 4-month renewal window, so every 64-day staging certificate is due.
  2. Within 2 minutes the served serials change, with the panel down the whole time.
  3. Restore the file and restart the proxy.

  Never do this on production: it would spend the 5-per-week duplicate limit.
- [ ] **Step 5: Switch to production.**
  1. Rerun `install.sh` without `--acme-staging`. The proxy is recreated once, using `acme.json`.
  2. Expected within 5 minutes:
     - "HTTPS active until <date>" for both names;
     - the issuer is a production Let's Encrypt intermediate;
     - a normal browser opens `https://<dom>` with no warning, `http://www.<dom>` lands on `https://<dom>/`, and WP Admin opens on `https://`.
  3. Count the production orders in the proxy log: one per hostname.
- [ ] **Step 6: Control plane down and reboot.**
  1. `systemctl stop hp-web hp-api hp-docker-executor hp-host-agent`, then a **real** `reboot` with `hp-api` disabled.
  2. HTTPS for both names and the panel's own certificate serve right after boot.
  3. Re-enable the units: nothing is recreated, and the domains still show "HTTPS active".
- [ ] **Step 7: Failure messages on a real network.**
  1. Add a third name, `test-fail.<dom>`, with its A record pointing at 192.0.2.1 → "points to 192.0.2.1", and no order in the proxy log.
  2. Point it here, but temporarily block 80/tcp in the provider's cloud firewall → "couldn't reach your site", **one** failed order, and the next attempt at about +15 min.
  3. Unblock, wait for the retry: "HTTPS active".
  4. Remove the name.
- [ ] **Step 8: Admin view and alert.** The admin opens the site's domains page and sees the same states. The alert card is empty. Optional, only if the owner agrees: set one domain's `cert_expires_at` to `now() + interval '10 days'` in PostgreSQL to see the alert, then let the reconciler correct it on the next pass.
- [ ] **Step 9: Write the report and commit** `docs(security): step 2b real-VM acceptance with Let's Encrypt`. Flip nothing more: `acmeTlsRuntimeAvailable` already became `true` in Task 0 for `linux-systemd`, but the report must PASS before this branch merges.

---

## Following sub-plan

**Step 2c, outgoing mail relay:** unchanged from the 2a plan's outline (`2026-11-08-step-2c-smtp-relay.md`). It now builds on the HTTPS site URLs set here.

## Self-review notes

- **Spec coverage:**
  - §3.4.1, show the IP and the exact A records: Tasks 9 and 10.
  - §3.4.2, DNS check periodic and on demand, `Waiting for DNS`: Tasks 7, 8 and 10.
  - §3.4.3, Let's Encrypt HTTP-01 issue and automatic renewal: Tasks 2, 3, 5 and 8, live in 13 and 14.
  - §3.4.4, HTTP→HTTPS once active: Tasks 2 and 6.
  - `www` pair with a primary choice: Tasks 0, 6, 9 and 10.
  - Aliases "nearly free": yes, up to 10 names per site, all redirecting to the primary.
  - Failures in plain language with a next step, backoff, never hammering: Tasks 3, 7, 8 and 10.
  - Certificate status visible to the customer, and an expiry alert to the admin: Tasks 9, 10 and 11.
  - Traefik built-in ACME within zero-sock (`ADR-014`), `CP-01`, storage persisting across restarts: Tasks 2, 5 and 12, live in 13.6 and 14.6.
  - §3.1 header pills: Task 10.
  - §3.9, test before pointing: the site serves over HTTP on any host header from publish onward (Task 13 step 2). Preview addresses stay deferred.
  - §4, admin manages for the customer: Tasks 9 and 11.
  - §9, flags, README, HARNESS, state and ADR: Tasks 0 and 12.
- **Deferred on purpose:**
  - wildcard and custom certificates, and DNS hosting (spec non-goals);
  - HSTS (ADR 0017);
  - IPv6 serving;
  - a friendly page for a stopped site (2a O1);
  - "Certificate renewed" as a separate activity text (the audit and activity feed show "Web addresses updated" plus the audit row);
  - email alerts (spec: later);
  - showing accented (IDN) names in their readable form (they are stored and shown as punycode);
  - hiding actor-less `site.domains` ops from the customer activity feed;
  - rewriting site files when ACME is turned off after the fact;
  - cleaning certificates of removed domains out of `acme.json` (known limit, ADR 0017).
- **Known risks to verify live:**
  - the Traefik JSON log field names (Task 13.4);
  - Pebble HTTP-01 on port 80 through the VM's nftables;
  - the registrar's propagation time against the DNS backoff (Task 14.2);
  - the first production order rate (Task 14.5);
  - whether the panel's own router (`hp-panel`, Host rule with certResolver) also retries forever when `panel.<dom>` does not resolve yet. It does, by the same Traefik rule, so its first DNS record must exist before install or right after it. Task 14 step 1 records how many failed panel orders happen before DNS resolves.
