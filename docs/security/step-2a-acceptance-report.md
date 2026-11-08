# Step 2a — WordPress Sites and Shared MariaDB: Live Acceptance Report

**Run:** 2026-11-08 on branch `feat/step-2-sites-domains-tls`. The base was `2c44640`; the run fixed one bug (`3a50bb9`, below).

**Releases:** `hosting-panel-0.3.0-linux-x64.tar.gz` and `hosting-panel-0.3.1-linux-x64.tar.gz` were built with `corepack pnpm run release:build`. 0.3.1 is the same tree with `package.json` bumped and not committed, so its `RELEASE.json` says `-dirty`.

- The first 0.3.0 build (`2c44640`) was installed on Ubuntu 26.04, Ubuntu 24.04 and Debian 12.
- After the fix, both archives were rebuilt at `3a50bb9`:
  - Ubuntu 26.04 moved to the fixed code through the step 7 update (0.3.0 → 0.3.1).
  - Debian 13 was rebuilt from empty volumes and installed fresh with the fixed 0.3.0, then ran the whole checklist on it.

**Stack inside every VM:** Node 26.13.0, Docker CE 29.9.3, PostgreSQL 18.6 PGDG, Traefik 3.7.17, `mariadb:12.3.3`, `wordpress:7.1.4-php8.{3,4,5}-apache` and `wordpress:cli-2.12.0-php8.{3,4,5}`.

**Test bed:** the same as `step-1b-acceptance-report.md`.

- Each VM is a disposable privileged systemd container (`hp-live-<os>`) with `--memory 2g --memory-swap 2g`.
- Named volumes hold `/var/lib/docker` and `/var/lib/containerd`.
- The VMs sit on a private bridge, `hp-live-net` 10.231.0.0/24, so their own `docker0` (172.17/16) does not clash with the outer one.
- There is no public DNS. Sites were reached with `curl -H 'Host: <domain>' http://<vm-ip>/`.

**How the panel was driven:** every panel action went through the real web BFF, as a browser would:

- `https://<vm-ip>/api/...` through Traefik;
- real login sessions (a cookie jar, admin password plus TOTP);
- `X-CSRF-Token` from `/api/session`, a matching `Origin`, and an `Idempotency-Key` on every mutation.

Nothing called the API directly.

## Verdict

| OS | Scope | Result |
|---|---|---|
| Ubuntu 26.04 | full checklist, steps 1–8 | **PASS**, with the fix below and the open items |
| Debian 13 | full checklist, steps 1–8, fixed build | **PASS**, with the open items |
| Ubuntu 24.04 | steps 1–2 | **PASS** |
| Debian 12 | steps 1–2 | **PASS** |

One blocker was found and fixed: a failed setup was shown to the customer as "Online", with no "Try again". The open items are recorded below. None of them stops a site from being created, served, updated or deleted.

## Results per step

### Step 1 — Install (all four OSes)

**The install finishes cleanly on every OS.**

| OS | Exit | Time | Step 12 output |
|---|---|---|---|
| Ubuntu 26.04 | 0 | ~63 s | ingress proxy healthy, then `Shared database (hp_mariadb) is running` |
| Debian 13 (first run) | 0 | ~69 s | same |
| Debian 13 (fresh, fixed build) | 0 | 113 s | same; the extra time was slower apt and Node downloads |
| Ubuntu 24.04 | 0 | 70 s | same |
| Debian 12 | 0 | 61 s | same |

**The MariaDB root key and container match the corrected expectation on every OS:**

- `/etc/hosting-panel/mariadb-root.key` is `0440 hp-mariadb:hp-executor` and 64 bytes. The uid/gid were 991/992 on 26.04 and 13, and 994 for hp-mariadb on 24.04 and 12.
- `docker inspect hp_mariadb` shows:
  - `User` is the hp-mariadb `uid:gid`, for example `991:990`;
  - `CapAdd` is empty (shown as `<no value>` or `[]`) and `CapDrop` is `[ALL]`;
  - `PortBindings` is `{}`, so `3306/tcp` is exposed but not published;
  - `RestartPolicy` is `unless-stopped`;
  - memory 1 GiB, `PidsLimit` 512, 1 CPU, `no-new-privileges:true`;
  - its only network is `hp_mariadb_net`, at 172.30.250.2.

**The installer also pulled the default site images ahead of time.** The executor pulls the default PHP 8.4 images at startup, which took about 12 s for 4 images together with Traefik and MariaDB. The PHP 8.3 and 8.5 images were not pulled ahead.

**The low-RAM warning works and does not block.** `HP_MEMINFO_FILE=<MemTotal: 1500000 kB> install.sh --dry-run …` printed `WARNING: this server has 1464 MB of RAM; at least 2 GB is required … Continuing.`. The plan still reached step 12 (`would wait up to 300 s for hp_mariadb`) and ended with `Dry run complete`. This held on all four OSes.

A container's memory limit does not change `/proc/meminfo`, which reports the 15.7 GB of the workstation. So the real installs showed no warning.

### Step 2 — Customer creates `hotel.test` (all four OSes)

The site was created from the customer session with title `L'Hôtel "Bella"` and PHP 8.4.

| OS | Create → first 200 | Proxy answer before publish | Title | `/wp-login.php` | `/hello-world/` | Database |
|---|---|---|---|---|---|---|
| Ubuntu 26.04 | 7.7 s | 404 only | verbatim | 302 to `/wp-admin/` plus the `wordpress_logged_in` cookie | 200 | `wp_e5b710239088` |
| Debian 13 | 9.2 s | 404 only | verbatim | same | 200 | `wp_0961ad8f6574` |
| Ubuntu 24.04 | 10.8 s | 404 only (21 samples) | verbatim | same | 200 | `wp_31141db9f6e4` |
| Debian 12 | 10.8 s | 404 only (21 samples) | verbatim | same | 200 | `wp_e30f1ef7e245` |

- **Time:** every site was serving in under 11 s, well inside 3 minutes. The images were already pulled at install.
- **WordPress was never public before publish.** A curl loop every 0.5 s got only 404 while `install_wordpress` ran. The last 404 came 2.6–3.2 s after `publish_site` showed as running, and the first 200 came right after it.
- **The title is kept exactly.** The HTML `<title>` is `L&#039;Hôtel &quot;Bella&quot;`, and `blogname` in the database holds the same string.
- **Login works.** A wrong password stays on the login page (200, no cookie).
- **Permalinks work.** `permalink_structure` is `/%postname%/`. `.htaccess` has `# BEGIN hosting-panel … # END hosting-panel`, then `# BEGIN WordPress … # END WordPress`.
- **Database users:**
  - `SHOW DATABASES` lists `wp_<12 hex>`, and `mysql.user` has the matching user `wp_<12 hex>@%`.
  - `root` exists only for `localhost` and `172.30.250.%`.
- **No secret leaked.** These were searched for across `docker inspect` of every container and `journalctl -u 'hp-*'`:
  - each site's 64-hex database password, read from its `wp-config.php`;
  - the WordPress admin passwords;
  - the MariaDB root key.

  There were 0 hits each, and 0 `HP_*PASSWORD=` env entries. The site container env holds only the image's own variables, with no `WORDPRESS_*` and no secrets.
- **The site container is hardened as designed:**
  - `CapDrop [ALL]` plus `CapAdd [CHOWN SETUID SETGID NET_BIND_SERVICE]`;
  - `no-new-privileges`;
  - 512 MiB, `PidsLimit` 256;
  - no published ports, `unless-stopped`.

### Step 3 — Admin creates and assigns a site; UI check for Tasks 10–12 (Ubuntu 26.04, Debian 13)

Everything ran through the BFF, with the admin session and the customer session side by side.

1. **Unassigned, the customer cannot see it.** The admin created `bellavista.test` with `ownerOrganizationId: null`.
   - The admin list showed it `ready` with owner `null`, and the `/admin/sites` page showed "Non assegnato".
   - The customer's pages did not mention it: the site switcher's payload had no "Bella Vista".
   - `/sites/<bv>` returned 404 to the customer, while `curl` got 200.
2. **Assigned, the customer can manage it.** The admin assigned it to the customer's account (`POST /api/admin/sites/<id>/owner`, 202).
   - The customer's site switcher listed it, and `/sites/<bv>` rendered (200).
   - Stop gave 202, the operation succeeded in 2.5 s, and the site stopped serving.
   - Start gave 202, it succeeded in 1.4 s, and the site answered 200 again.
   - `GET …/logs?tail=20` returned 200 with the access-log lines.
3. **Unassigned again, it leaves the customer's panel and keeps serving.** The admin set it back to "Not assigned".
   - The site disappeared from the customer's switcher.
   - `/sites/<bv>` and the logs route both returned 404.
   - `curl` still got 200.

**Pages:** every page answered 200 with no visible error text and no React error digest:

- customer: `/sites/<id>`, `/sites/<id>/logs` and `/sites/new`;
- admin: `/admin/sites`, which lists both sites with owners, PHP version, status and the "Cambia proprietario" and "Elimina" actions.

`/sites` answers 307 to the last or only site. Its body carries only the normal `NEXT_REDIRECT` digest.

**What a human should still check in a browser:**

- the layout and styling of these pages;
- the create-site form's client-side validation and the live progress card animating through the five steps;
- the stop, start and delete confirmations and the dialogs on the admin page, including Esc and clicking outside while busy;
- the Visits and Errors split on the Logs tab, which is done client-side;
- the language switch.

This harness checked rendered HTML and BFF responses, not client-side JavaScript.

### Step 4 — PHP change and controls (Ubuntu 26.04, Debian 13)

- **The PHP switch keeps the site and its content.** Switching `hotel.test` to 8.5 succeeded in 17 s on 26.04 and 27 s on 13; both times included pulling the 8.5 image.
  - The site then sends `X-Powered-By: PHP/8.5.12`.
  - The title, `/hello-world/` (200) and the admin login all survived.
- **The controls work, but a stopped site gives 502, not 404.**
  - Stop succeeded, but the proxy then answers **502 Bad Gateway**, not the 404 the checklist expects. See open item O1.
  - Start gave 200 and Restart gave 200.
- **Visits show up in the logs.** Three curl requests with a marker user agent all appeared as `stdout` lines in the BFF logs response, and the Logs page renders 200.

### Step 5 — Retry after a failure (Ubuntu 26.04, Debian 13)

1. **A setup that cannot download its images fails cleanly.** Outgoing TCP to port 443 was dropped inside the VM (`nft … tcp dport 443 drop`). The PHP 8.3 images were not present.
   - Creating `terza.test` on PHP 8.3 failed at `deploy_site` after 31.6 s on 26.04 and 60.7 s on 13.
   - The step texts stayed friendly: "Could not finish this step", and the operation message was "Site setup did not finish".
   - The site was never routed (404).
   - **Bug B1 showed up here, on the unfixed 0.3.0 (Ubuntu 26.04).** The site page said "Online — Il tuo sito è online e funziona", with no "Problema" and no "Riprova", while the admin list said `degraded`.
   - After the fix, on Debian 13 and on 26.04 after the update, the page shows the "Problema" badge, the setup card's failure text and the **Riprova** button.
2. **Try again finishes the setup without duplicates.** After unblocking 443, Riprova (`action: retry`) succeeded in 55 s, mostly the 8.3 image pulls.
   - There is still exactly one database user for the site (`SELECT User FROM mysql.user`: one `wp_…` per site, no duplicate).
   - The admin chosen at creation logs in (302 to `/wp-admin/`).
   - On the fixed build, the page now shows "Online".
   - A second failure point was also checked on 26.04 after the update. A PHP 8.5 site whose CLI image could not be pulled failed at `install_wordpress` and showed Problema and Riprova. Its Try again then succeeded the same way.
3. **A site cannot log in as MariaDB root.** This ran from a WordPress container:

   ```
   docker exec -i <wp container> php -r '… new mysqli("hp-mariadb","root",trim(file_get_contents("php://stdin"))) …' < /etc/hosting-panel/mariadb-root.key
   ```

   PHP read 64 bytes from stdin (`keylen=64`), so the key really arrived. The result was `mysqli_sql_exception: Access denied for user 'root'@'172.25.0.3' (using password: YES)` on 13, and the same from 172.23.0.3 on 26.04.

### Step 6 — `CP-01` (Ubuntu 26.04, Debian 13)

Three sites were running on each VM. Every check below fetched both `/` and `/hello-world/` for every site; the permalink is served from the database.

1. **Panel units stopped:** after `systemctl stop hp-web hp-api hp-docker-executor hp-host-agent`, all three sites answered 200/200.
2. **Docker restarted with the units still stopped:** all sites, `hp_mariadb` and the proxy came back by themselves. Every site was back to 200/200 within 4 s.
3. **VM restarted with `hp-api` disabled:** after `docker restart <vm>`, all sites were 200/200 within 5–7 s, and `hp-api` stayed inactive.
   - **Deviation:** `systemctl mask hp-api` does not work. The units are installed in `/etc/systemd/system` (`Failed to mask unit: File '/etc/systemd/system/hp-api.service' already exists`).
   - So the unit file was moved aside and `daemon-reload` was run, which has the same effect. See open item O4.
4. **Units started again:** after restoring and starting the units, the `docker ps --no-trunc` IDs were identical to those taken before 6.1. Nothing was recreated through all of step 6.

### Step 7 — Update and installer rerun (Ubuntu 26.04, Debian 13)

- **Update:** `hp-update --archive …0.3.1…` said "updated 0.3.0 → 0.3.1" and "All panel services are healthy". It took 7 s on 26.04 and 14 s on 13.
  - A curl loop every 0.25 s on `hotel.test` got 32/32 and 48/48 answers of 200, with no failure.
  - The IDs of `hp_mariadb`, the site containers and the proxy were unchanged.
- **Installer rerun:** `install.sh` with the 0.3.1 archive exited 0 in 16 s on 26.04 and 23 s on 13.
  - It printed `Preserved existing MariaDB root key`, `skip: role … already provisioned` and `skip: administrator already created`.
  - The `mariadb-root.key` sha256 was unchanged, and the container IDs were unchanged again.

### Step 8 — Customer deletes `hotel.test` (Ubuntu 26.04, Debian 13)

- **The site is deleted completely.** `DELETE` with `confirmName: "Hotel Bella"` succeeded in 2.5–2.8 s, through the steps `drop_database`, `remove_site` and `finish`. Afterwards none of these remain:
  - the site container;
  - its volume `hp_vol_svc_<id>_html`;
  - both networks, `hp_site_site_<id>_net` and `hp_edge_site_<id>_net`;
  - `site_site_<id>.yml`;
  - the `wp_…` schema and its `mysql.user` row (0 and 0).
- **The other sites are untouched.** `hotel.test` now gets 404, while `bellavista.test` and `terza.test` (and `quarta.test`) still answer 200.

## Bugs found and fixed during the run

- **B1 (High, customer-visible), fixed in `3a50bb9` `fix(api): site page shows a failed WordPress setup as a problem with Try again`.**
  - **Cause:** `GET /v1/organizations/:org/sites/:id`, which the customer site page uses, computed `status` only from the service aggregate. A failed `site.provision` leaves no failing service, so the page said "Online" and never offered "Riprova". Meanwhile the admin list, which reads `sites.status`, said `degraded`.
  - **Fix:** for a managed site (`php_version` set), the row's status is used whenever it is not `ready`. That covers `degraded`, `deploying` and `maintenance`. A `ready` row still uses the aggregate, so stopped and drifted sites look as before.
  - **Test:** a new integration test in `managed-sites.integration.test.ts`.
  - **Checks:** `build`, `lint`, `typecheck` and `test` all pass (42 files, 500 tests).
  - **Verified live** on Debian 13 and on Ubuntu 26.04 after the update.

## Open items (recorded, not fixed)

- **O1 (Medium, UX). A stopped site answers 502 Bad Gateway, not 404.** The checklist expects 404 in step 4 and in step 3.2.
  - Stop keeps `site_<id>.yml`, so Traefik routes to a container that is down.
  - Visitors see a bare "Bad Gateway" page.
  - Either drop the route on stop or route to a friendly "site stopped" page.
- **O2 (Medium). A panel request can hang while a site is published.**
  - On every provisioning watched (6 of 6, on all four OSes), one BFF request in flight at `publish_site` hung. One took 207 s; the others were cut off by the harness's 30 s timeout.
  - A probe inside the VM saw one panel connection refused (`000`) at the same second the executor connected `hp_ingress_proxy` to the new `hp_edge_site_<id>_net` (docker events at 20:50:48).
  - The API and the web console probed directly (`127.0.0.1:4000`, `172.17.0.1:3000`) never slowed down. New short curl connections to the panel and to other sites during a publish all succeeded (190/190 and 300/300).
  - So connections already open through the proxy are dropped or stalled when Docker attaches the proxy to a new network.
  - **Impact:** a browser that keeps one HTTP/2 connection open to the panel could see the live setup progress freeze until the connection times out or the page is reloaded. A visitor's long download could break too.
  - Confirm on a real VM, and consider attaching the proxy to the edge network before WordPress is installed, so the attach does not happen at publish time.
- **O3 (Low). Every job leaves an empty anonymous Docker volume behind.**
  - The `mariadb` image declares `VOLUME /var/lib/mysql`, and the job containers are removed without `v=true`.
  - That made 8 empty dangling volumes on 26.04 and 6 on 13: one per `db.*` and `wordpress.*` job, still there after delete.
  - Remove job containers with `?v=true`, or mount a tmpfs on the image's declared volumes.
- **O4 (Low, ops). The panel units cannot be masked.** They are installed as files in `/etc/systemd/system`, so `systemctl mask hp-api` fails. Installing them into `/usr/lib/systemd/system`, or linking them, would allow masking.
- **O5 (Cosmetic). `systemctl stop hp-web` leaves the unit `failed`.** Next exits 143 on SIGTERM. Add `SuccessExitStatus=143` to `hp-web.service`.
- **O6 (Low, UX). Acting on a site right after it is assigned can be refused.** For about 2 s after an owner change, the customer's actions get 409 `RESOURCE_LOCKED`, while the `site.reassign` operation finishes. The admin list already shows the new owner and `ready`. The error is retryable; make sure the UI shows it as "busy, try again in a moment".
- **O7 (Info). The operation can finish slightly before the site serves.** An operation reports `succeeded` up to about 2–3 s before Traefik's file provider serves the new route, so an immediate curl can still get 404.
- **O8 (Info). The proxy container has no memory limit.** Docker stats show it limited only by the host. The global constraints list limits only for sites, jobs and MariaDB, so this is noted, not a violation.

## Harness notes (not product issues)

- **The VM's public DNS had to be pinned.** Docker's embedded DNS (127.0.0.11) relies on NAT rules in the container's netns.
  - When the VM restarts, the distro `nftables.service` runs `flush ruleset` and wipes them, so the VM loses DNS.
  - On a real server that flush runs before Docker and there is no embedded DNS.
  - This briefly broke the Ubuntu 26.04 "Try again" (after the step 6.3 restart) until `/etc/resolv.conf` was pointed at a public resolver in every VM.
  - The installer's own nftables handling (no flush at install time) behaved correctly.
- **Admin-created site operations live in the platform account,** so their progress was followed through the admin site list rather than the customer operation route.
- **Memory with 3–4 sites running:**
  - each WordPress container used 18–82 MiB, MariaDB about 165 MiB and the proxy 31–69 MiB;
  - the panel daemons used about 195 MiB together (API 67, web 75, executor 27, host-agent 26);
  - the VM cgroup sat near its 2 GiB limit, mostly page cache, and nothing was OOM-killed.

## Still to verify on a real VM

- Memory on a real 2 GB VPS with three WordPress sites plus MariaDB: the real `MemTotal`, swap and the OOM behaviour.
- A real kernel reboot, not a container restart, for the step 6 `CP-01` check.
- Image pull time on a normal uplink. Here the 240 s budget was never close: a cold pull of two 8.3 images took about 55 s.
- O2: whether attaching the proxy to a network drops connections already open on a normal host. Check with a real browser holding HTTP/2 to the panel during a site creation.
- The low-RAM warning on a real 1 GB VM.
- Step 2b (domains, Let's Encrypt) needs a public IPv4 and the owner's test domain.
