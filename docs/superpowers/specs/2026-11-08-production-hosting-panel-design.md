# Production Hosting Panel — Design

- **Date:** 2026-11-08
- **Status:** Draft for owner approval
- **Builds on:** `HCP-SPEC-002` (Phase 1) and `HCP-SPEC-003` (Phase 2), both merged on `main`
- **Supersedes:** the Phase 2 non-goals for ACME/TLS, SFTP, production backups and managed databases (`AC-F2-10`, `HARNESS.md` forbidden actions). Shared hosting stays closed.

Notes marked **(builder's call)** were decided by Claude during design, not by the owner. They can be changed without asking again, as long as the intent below holds.

---

## 1. Intent

Turn `hosting-panel` into a production base for a Plesk-style web hosting panel that runs on Docker. The target customer is a non-technical small business owner. The reference persona is **the owner of a hotel who manages their WordPress website**.

### The one test that matters

> **If the hotel owner gets lost or confused using it, the product has failed, even if every feature works.**

Every screen, label, error and flow is judged by this first. Plesk is the functional reference ("everything a customer needs for websites, domains and certificates"). Plesk's *interface* is the anti-reference: the owner finds it too cluttered. Coolify's clean look is the visual reference.

### Business model

- **One customer, one server.** Each server is dedicated to one customer and runs any number of their websites and services as Docker containers. This is the existing `Dedicated` mode.
- Each server runs **its own panel**. There is no central panel managing many servers in this version (future: `ADR-008` hub).
- The hosting company (the owner of this project) operates many such servers and logs into each server's panel as **server administrator**.

---

## 2. Users and roles

Two kinds of login per server, in the same panel:

| Role (product name) | Who | Manages |
|---|---|---|
| **Hosting admin** (customer) | The hotel owner, or whoever runs the business's sites | Their sites, domains, certificates (status), files, databases, backups (view/download/restore), WordPress |
| **Server administrator** | The hosting company | Everything about the machine: health, updates, backups config, logs, firewall, restarts, container terminal, plus support access to customer sites |

- The existing four roles (`infrastructure_admin`, `hosting_admin`, `customer_owner`, `customer_collaborator`) collapse into these two for the product. **(builder's call:** keep the authz engine and map *Hosting admin* → existing customer-owner permissions plus site/service creation; *Server administrator* → `infrastructure_admin` plus the hosting-admin set. Do not rip out the engine.)
- Inviting extra customer users (e.g. a web agency) is **not** in this version. Keep the data model able to add it later.

### Authentication (must replace the demo login)

- Real accounts with email and password (strong hashing, e.g. argon2id or scrypt from `node:crypto`), password reset, and session revocation.
- **2FA (TOTP)**: mandatory for server administrators; optional but encouraged for hosting admins.
- The current demo persona login (`/v1/dev/auth/token`, `/api/session/login` with empty body → infrastructure admin) and demo data seeding at startup **must not exist in production builds**. Dev mode may keep them behind an explicit opt-in flag that defaults to off.
- First server administrator is created during installation (CLI prompt or one-time setup link). The administrator then creates the hosting admin account for the customer.
- Login is rate-limited and lockout-protected.
- External identity providers (Keycloak/OIDC) are **not** needed in this version. **(builder's call)**

---

## 3. Customer experience (Hosting admin)

### 3.1 Layout: site-first with tabs (owner chose option B)

- Top bar: product logo, **site switcher** dropdown (`hotelbellavista.it ▾`), language switch, account menu.
- Opening the panel lands on the last-used site. With no sites yet, it lands on a friendly empty state with "Create your first site".
- Site header: domain name, status pill (`Online` / `Stopped` / `Waiting for DNS` / `Problem`), certificate pill (`HTTPS valid until Feb`), and a primary action (`Open WP Admin ↗` for WordPress, `Visit site ↗` otherwise).
- Tabs per site: **Overview · WordPress** (WordPress sites only) **· Domains · Files · Database · Backups · Logs**.
- Overview shows cards for pending updates, last backup (with download), disk use, and a plain-language recent activity feed ("Backup completed · today 03:00", "Certificate renewed · 2 days ago").
- Account-level pages (outside a site): profile, password, 2FA, language, and a list of all sites.

### 3.2 UX rules (derived from the one test)

- No Docker, container, image, network, volume or revision vocabulary anywhere in the customer console.
- Every error tells the owner **what happened and what to do next** in plain language, never only an error code.
- Every destructive action (delete site, restore backup, delete database) uses a confirmation that names the consequence ("This will replace your current website with the copy from 3 Nov, 03:00").
- Long operations show progress in place and survive page reloads. The existing `OperationTimeline` and `202 Accepted` flow can be reused, but presented as friendly steps.
- Italian and English from day one (section 7).

### 3.3 Sites

Site types in this version:

| Type | What it runs | Notes |
|---|---|---|
| **WordPress** | PHP-FPM + web server image with WordPress, database on the shared MariaDB | One-click install: site title, admin user, admin email, password |
| **Static** | Web server serving files | Files via SFTP / file manager |
| **PHP app** (Laravel and similar) | PHP-FPM + web server, configurable document root (e.g. `/public`) | Composer is run by the developer, not the panel **(builder's call)** |
| **Node** ("maybe") | Node runtime with start command and port | Lowest priority type; may slip to a later step without blocking go-live |

- The customer can choose the PHP version per site from a supported list, and the Node version per Node site. **(builder's call)**
- **These four site types are the only things a customer or admin can create (owner decision).** There is no catalog of extra services (Redis, other apps). The existing service-template catalog and its screens are hidden from the product or removed; internally, templates may still be used to define the four site types. **(builder's call on how)**
- Each site runs in its own containers on its own network (existing per-site network isolation). The existing container hardening (`CapDrop: ALL`, `no-new-privileges`, limits) stays, relaxed only where an image genuinely requires it, with the reason documented.
- **One shared MariaDB server per machine**, with a separate database and user per site. **(builder's call:** lighter than one DB container per site on a single-customer server.) The panel's own PostgreSQL stays separate and is never exposed to customers.
- Site lifecycle: create, start, stop, restart, delete (with confirmation and an offer to download a final backup).

### 3.4 Domains and TLS (day-one critical)

- DNS stays at the customer's registrar. The panel does **not** host DNS zones.
- Adding a domain to a site:
  1. The panel shows the server's public IP and the exact A record to create (and `www`).
  2. The panel **checks DNS** periodically and on demand ("Check now"), showing `Waiting for DNS` until the domain resolves to this server.
  3. Once it resolves, a **Let's Encrypt** certificate is issued automatically (HTTP-01 challenge) and renewed automatically before expiry.
  4. HTTP redirects to HTTPS once a certificate is active.
- `www` and the bare domain are handled as a pair, with a choice of which one is primary (the other redirects). **(builder's call)**
- A site can have more than one domain (aliases) only if it comes nearly free. Otherwise it is out of this version. **(builder's call)**
- Out of this version: wildcard certificates (need DNS control), uploading custom certificates. **(builder's call)**
- Failures (DNS not pointing, Let's Encrypt rate limit, port 80 blocked) are shown in plain language with the next step. The panel retries with backoff and never hammers Let's Encrypt.
- Certificate status and expiry are visible to the customer. Expiry problems raise an alert to the server administrator.
- Implementation direction: the existing Traefik v3 data plane has a built-in ACME resolver. Use it if it fits the zero-docker-socket, file-provider-only ingress design (`ADR-014`). The proxy must keep serving existing sites while the Control Plane is down (`CP-01`), including serving existing certificates. Certificate storage must persist across proxy restarts.

### 3.5 Backups (day-one critical)

- **Storage:** one external S3-compatible bucket per server, configured by the server administrator (endpoint, region, bucket, access key, secret key, optional path prefix). The admin can test the connection from the panel. Backups are never stored only on the same server.
- **Content:** per site: site files + that site's database dump, as one restorable unit.
- **Schedule:** automatic nightly backups. Retention defaults to 14 days, adjustable by the administrator. **(builder's call)** The customer and admin can also start a backup by hand.
- **Encryption:** backups are encrypted on the server before upload with a key held by the panel. **(builder's call)** The key must be backed up by the administrator, and the installer and admin UI must say so loudly, since losing it makes the backups useless.
- **Customer actions:** list backups (date, size, status), **download** a backup as a normal archive (decrypted for them), **restore** a site from a backup with a consequence-naming confirmation. Restore is a guess the owner did not explicitly confirm ("check backups"). Keep it in, but it may be cut if it threatens go-live.
- **Admin view:** last success/failure per site, retry, storage usage, failure alerts.
- Tool choice is the builder's (e.g. restic, or tar + database dump + client-side encryption + S3 upload). Keep in mind the dependency allowlist practice in `HARNESS.md`. New tools need to be added to the allowlist deliberately.

### 3.6 Files (mandatory)

- **SFTP** per site, locked to that site's folder (chroot), with SFTP users created and passwords reset in the panel. Key-based login is a nice-to-have. **(builder's call)**
- **Web file manager**: browse, upload (including large files), download, create folder, rename, move, delete, edit text files, zip and unzip. Confined to the site's folder; must never escape it (path traversal, symlinks).
- File ownership and permissions must work for both SFTP writes and the site's runtime (e.g. WordPress updating its own plugins).
- Git deploy: later, not in this version.

### 3.7 Databases (mandatory)

- The customer can create databases and database users, set and reset passwords, and grant a user access to a database, all on the shared MariaDB.
- **phpMyAdmin** opens from the panel, scoped so a customer only sees their own databases. Single sign-on from the panel is preferred over retyping credentials. **(builder's call)**
- phpMyAdmin must not be publicly reachable without going through the panel's login. **(builder's call)**

### 3.8 WordPress tools

- See installed WordPress version, plugins and themes, and which have updates.
- Update core, plugins and themes individually or "update all", with an automatic backup taken just before. **(builder's call)**
- Reset the WordPress admin password from the panel. This is the owner's "change passwords" chore. Mailboxes are out of scope.
- Implementation direction: `wp-cli` inside the site's container, triggered through the executor (never through a host shell).
- Out of this version: staging copies, security scanning, scheduled auto-updates. **(builder's call)**

### 3.9 Bringing an existing site in (first go-live, owner decision)

Real customers almost always already have a WordPress site elsewhere. Moving it in must be possible **at the first go-live**.

- Minimum: the customer or administrator can move a site in by hand with SFTP, the file manager and phpMyAdmin (this is why files and databases are part of the first go-live; see section 8).
- Plus a simple **import wizard for WordPress** in the site's WordPress tab: upload (or SFTP-drop) a files archive and a database dump. The panel unpacks them into the site, imports the dump into the site's database, rewrites `wp-config.php` to the panel's database credentials, and replaces the old domain with the new one in the database (`wp search-replace`). **(builder's call:** archive + dump upload. Importing straight from a remote host or from vendor backup formats is out.)
- The DNS check (3.4) lets the customer test the moved site before pointing the domain. A temporary preview address per site is a nice-to-have. **(builder's call)**

### 3.10 Outgoing email for sites (first go-live, owner decision)

Hotel sites send booking confirmations and contact-form emails. If those don't arrive, the owner will think the site is broken.

- The server administrator configures **one outgoing SMTP relay per server** (host, port, user, password, sender domain), e.g. a transactional email service the hosting company uses, and can send a test email from the panel.
- Every site sends mail through that relay without the customer configuring anything: PHP `mail()` and WordPress `wp_mail` work out of the box (e.g. a sendmail-compatible relay client inside the site containers). **(builder's call on mechanism)**
- The relay password is stored like other secrets (encrypted, never in container env or logs).
- The admin can see recent send failures. The customer sees a short plain-language hint about SPF/DKIM for their domain at their registrar or email provider. **(builder's call)**
- Out of this version: receiving mail, mailboxes, per-site relay settings.
- Once the relay is configured, the panel itself may also send password-reset emails. The admin-reset path stays available. **(builder's call)**

### 3.11 Logs

- The customer can see recent access and error logs for their site (the first thing needed when WordPress shows a white page). **(builder's call)**

---

## 4. Server administrator experience

Same clean visual style. Layout: **sidebar with server-wide sections** (Health, Sites, Backups, Firewall, Logs, Updates, Users, Settings). **(builder's call)** The administrator can also open any customer site in the same site-first view (support access, recorded in the audit log).

| Area | Must do |
|---|---|
| **Health** | CPU, RAM, disk, uptime; status of each panel component (API, web, executor, host agent, proxy, MariaDB); status of each customer container (running, stopped, restarting, drifted). In-panel alerts (disk > 90%, certificate expiring, backup failed, component down). Email notifications are later. **(builder's call)** |
| **Updates** | See and apply updates for container images (WordPress base, PHP, MariaDB, Traefik, phpMyAdmin) and for the panel itself. OS package updates through the existing allowlisted host maintenance actions. Kernel reboots happen over SSH. **(builder's call)** |
| **Backups** | Configure S3 and schedule/retention, test connection, see per-site status, retry, see the encryption key warning. |
| **Logs** | Panel logs, audit trail (who did what, when), proxy access/error logs, per-container logs. |
| **Firewall** | View current rules, open/close ports from a safe list, block/unblock IPs. Can never lock out SSH or the panel itself. **(builder's call)** Must keep the zero-shell, allowlisted `execFile` model of `hp-host-agent`. |
| **Restart services** | Restart any customer container or panel component, with a reason recorded in the audit log. |
| **Container terminal** | Interactive shell inside a customer's container from the browser, for debugging. Admin only, 2FA required, every session recorded in the audit log (who, which container, when, how long). **(builder's call)** **No host terminal.** The host is reached over normal SSH. |
| **Users** | Create, disable and reset the customer's hosting admin account, and manage other server administrators. |

---

## 5. Installation and operation

- A fresh Ubuntu 24.04 / Debian 12 server is turned into a panel server by one documented install procedure, building on `infra/linux/bootstrap-dedicated.sh` and the existing `systemd` units. It installs everything needed (Docker, proxy, MariaDB, panel), generates keys, and creates the first administrator.
- The panel is reached over HTTPS on its own hostname, entered by the administrator at install time and normally under the hosting company's domain (e.g. `srv12.hostingcompany.it`), with its own Let's Encrypt certificate. Until that DNS record resolves, the installer falls back to a self-signed certificate on the server IP so first-admin setup is never blocked. **(builder's call)**
- Branding: one product name and logo for all servers in this version. Per-company branding comes later. **(builder's call)**
- **Release and update source:** the panel is installed and updated from versioned release archives (built artifacts, checksum-verified) published by the project, not built from git on the server. Self-update downloads a release, swaps it in, runs additive migrations, and restarts only Control Plane services. **(builder's call)**
- Panel self-update must not interrupt running customer sites (keeps the `CP-01` property: sites keep serving while the Control Plane is down).
- **Fresh installs only:** no existing Phase 2 server holds real customer data, so data model and role changes need no upgrade-in-place from the old demo data. **(builder's call; correct this if any real server exists.)**
- **Password recovery:** the server administrator can always reset a customer's password, and a lost-2FA administrator is recovered with the existing break-glass CLI over SSH. Email-based reset works only once the SMTP relay (3.10) is configured. **(builder's call)**
- Panel database (PostgreSQL) and its keys (IPC key, secrets master key, backup encryption key) must themselves be backed up. At minimum the panel database goes to the same S3 bucket. **(builder's call)**

---

## 6. Goals, non-goals, anti-goals

### Goals
- A hotel owner can take a WordPress site live on their own domain with HTTPS and nightly off-site backups, without help, and never feel lost.
- A server administrator can maintain the machine fully from the panel, except host-level shell work, which stays on SSH.
- A production base: real auth, no demo backdoors, installable on a fresh server, safe defaults.

### Non-goals (this version)
- Email hosting / mailboxes / receiving mail (owner: "only web hosting for now"). Outgoing site mail through a relay *is* in scope (3.10).
- A catalog of extra services beyond the four site types.
- DNS hosting.
- Central multi-server panel (`ADR-008` hub, future).
- Several customers on one server (`Shared` mode stays gated; `ADR-011` stays open).
- Git deploy, staging, WordPress security scanner, scheduled WP auto-updates, invited extra customer users, external IdP, email notifications, wildcard/custom certificates.
- Host terminal in the browser.

### Anti-goals (failure even if it "works")
- The hotel owner gets lost or confused. This is the primary failure.
- A cluttered, Plesk-like interface.
- Docker/infrastructure jargon reaching the customer.
- Any path from the web panel to a host shell or to the Docker socket outside the executor.
- Backups that exist only on the same server, or that cannot actually be restored.

---

## 7. Languages

- Italian and English for every screen, message, error, email-like text and confirmation, from the first step. Italian is the default. Each user picks their language. **(builder's call)**
- The current UI is Italian-only with hardcoded strings. Move it to a translation catalog. The i18n approach/library is the builder's choice (Next.js App Router compatible), subject to the dependency allowlist.

---

## 8. Delivery order

The work is several projects built in sequence. Each step ends with something that works on a real server. **Steps 1–4 are the first go-live line**: after them, a hotel can move its existing WordPress site in, run it on its own domain with HTTPS, send its booking and contact emails, and have nightly off-site backups.

1. **Foundation**: real auth (passwords, TOTP 2FA, two roles), removal of demo login/seed from production, first-admin setup, i18n scaffolding (IT/EN), customer site-first layout shell, installer on a fresh server, release/update packaging.
2. **Sites, domains, TLS and outgoing mail**: site types (WordPress, static, PHP app; Node if cheap), shared MariaDB, domain add + DNS check + Let's Encrypt issue/renew + HTTPS redirect, admin SMTP relay for site mail.
3. **Backups**: S3 config, nightly encrypted per-site backups, manual backup, customer download and restore, admin status.
4. **Files, databases and site import**: SFTP, web file manager, databases/users, phpMyAdmin, WordPress import wizard.
   — **first go-live line** —
5. **WordPress tools**: updates with pre-update backup, WP admin password reset.
6. **Admin console completion**: health and alerts, updates, firewall, logs, restarts, container terminal, user management.

Each step gets its own implementation plan. Each step must pass the existing sensors (`build`, `lint`, `typecheck`, `test`) and be checked on a real Linux server, as Phase 2 was.

---

## 9. Constraints carried over from the existing project

- Keep the stack: TypeScript monorepo, NestJS API, Next.js web (shadcn), split daemons (`hp-docker-executor`, `hp-host-agent`), signed Unix-socket IPC, Traefik file-provider ingress, PostgreSQL panel DB. **(builder's call:** build on it, do not rewrite.)
- Docker socket only in the executor. No shell in the host agent. No secrets in DTOs, logs, revisions or container env (existing rules still hold).
- Data plane keeps serving sites when the Control Plane is down (`CP-01`). New pieces (ACME, MariaDB, SFTP, phpMyAdmin) must not break this for already-running sites.
- `HARNESS.md`, `.agents/brain/state.md`, `README.md`, the capability flags (`acmeTlsRuntimeAvailable`, `sftpAvailable`, `productionBackupRuntimeAvailable`) and the related ADRs must be updated as each capability actually ships. Flags only turn `true` when the feature truly works.
- New dependencies follow the existing allowlist practice: proposed, justified, then added.

---

## 10. Left to the builder

- Exact images, versions and container layout per site type.
- Backup tool and archive format; ACME integration details within the zero-sock proxy design.
- SFTP server implementation (OpenSSH chroot vs a containerized SFTP server), as long as each site stays confined.
- File manager implementation and where it runs (must stay confined to the site folder).
- How phpMyAdmin is scoped and single-signed-on.
- Password hashing parameters, TOTP library or implementation, session lifetime.
- i18n library and translation file structure.
- Data model changes and migrations (additive where possible).
- Exact admin sidebar grouping and visual details, within the Coolify-like clean style and the site-first customer layout the owner chose.
