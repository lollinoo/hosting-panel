# Step 2b — Domains, DNS Check and Let's Encrypt: Acceptance Report

## Container harness with a local ACME CA (Task 13)

**Run:** 2026-11-09 on branch `feat/step-2b-domains-dns-tls` at `ce89cab`. No code change was needed: no blocking bug was found.

**Releases:** `hosting-panel-0.4.0-linux-x64.tar.gz` and `hosting-panel-0.4.1-linux-x64.tar.gz` were built with `corepack pnpm run release:build`. 0.4.1 is the same tree with `package.json` bumped and not committed, so its `RELEASE.json` says `-dirty`.

**Stack inside every VM:** Node 26.13.0, Docker CE 29.9.3, Traefik 3.7.17 (`traefik:v3.7`), `mariadb:12.3.3`, `wordpress:7.1.4-php8.4-apache`.

**Test bed:** the same as `step-2a-acceptance-report.md`.

- Each VM is a disposable privileged systemd container (`hp-live-<os>`, images `hp-live-vm:*`) with `--memory 2g --memory-swap 2g` and named volumes for `/var/lib/docker` and `/var/lib/containerd`.
- They sit on the private bridge `hp-live-net` 10.231.0.0/24: Ubuntu 26.04 at .10, Debian 13 at .11, Ubuntu 24.04 at .12, Debian 12 at .13.
- Every panel action went through the real web BFF (`https://<vm-ip>/api/...`, cookie jar, admin password plus TOTP, `X-CSRF-Token`, matching `Origin`, `Idempotency-Key`). The customer account was created by the admin through the BFF; the customer changed the temporary password and switched the UI to English.

**Local ACME CA:**

- `pebble-challtestsrv:2.10.1` at 10.231.0.250, DNS only on `:8053` (`-defaultIPv4 "" -defaultIPv6 "" -http01 "" -https01 "" -tlsalpn01 "" -doh ""`). Every name got its records through the management API on `:8055` (`add-a`, `clear-a`, `add-aaaa`, `clear-aaaa`), the panel hostnames `panel.<vm>.test` included, before install.
- `pebble:2.10.1` at 10.231.0.251 with `-dnsserver 10.231.0.250:8053`, `PEBBLE_VA_NOSLEEP=1`, `PEBBLE_WFE_NONCEREJECT=0`, and the shipped config with `httpPort: 80` and `profiles.default.validityPeriod: 1728000`.
- **Harness deviation:** Pebble's shipped `localhost` certificate has no IP SAN (`DNS:localhost, DNS:pebble, IP:127.0.0.1`), so Traefik could not verify `https://10.231.0.251:14000/dir`. A new server leaf with `IP:10.231.0.251` was signed with the shipped `pebble.minica.key.pem`; `HP_ACME_CA_CERT_FILE` stays `pebble.minica.pem`.
- In each VM after install, as the checklist says: `executor.env` got `HP_ACME_CA_SERVER=https://10.231.0.251:14000/dir` and `HP_ACME_CA_CERT_FILE=/etc/hosting-panel/pebble.minica.pem`, `api.env` got `HP_DNS_RESOLVERS=10.231.0.250:8053`, then `systemctl restart hp-docker-executor hp-api`.

**Let's Encrypt was never contacted.** `install.sh` starts Traefik with the production resolver (the env change comes after it), and the panel route asks for a certificate at once. So every VM got an nftables guard *before* install: `table ip hp_live_guard`, forward hook at priority -10, dropping TCP 443 from the VM's container bridges (172.16.0.0/12) to anything outside 10.231.0.0/24 and 172.16.0.0/12. Its counter showed 4–8 dropped SYNs per VM during install, which were Traefik's production attempts; none connected. The first version of the guard also dropped DNAT-ed inbound 443 and was narrowed before any panel call.

### Verdict

| OS | Scope | Result |
|---|---|---|
| Ubuntu 26.04 | full checklist, steps 1–7 | **PASS**, with the notes and open items below |
| Debian 13 | full checklist, steps 1–7 | **PASS**, with the notes and open items below |
| Ubuntu 24.04 | step 1 | **PASS** |
| Debian 12 | step 1 | **PASS** |

The DNS server is shared, so `hotel.test` can point at one VM at a time. Ubuntu 26.04 ran steps 2–7 first; then the records were moved to Debian 13, which ran steps 2–7 on the site it had created at the start.

### Results per step

#### Step 1 — Install 0.4.0 (all four OSes)

| OS | Exit | Time (4 in parallel) | Rerun | Proxy recreated by env change | Proxy ID across rerun + executor restart |
|---|---|---|---|---|---|
| Ubuntu 26.04 | 0 | 152 s | exit 0, 26 s | once (07:15:04) | unchanged |
| Debian 13 | 0 | 153 s | exit 0, 22 s | once | unchanged |
| Ubuntu 24.04 | 0 | 149 s | exit 0, 28 s | once | unchanged |
| Debian 12 | 0 | 151 s | exit 0, 23 s | once | unchanged |

- Every install printed `WARNING: 10.231.0.x is a private address. Customers' A records must point to this server's public IPv4; …`, and the rerun printed it again.
- Every install also printed `WARNING: panel.<vm>.test does not resolve to 10.231.0.x yet`. That is correct here: the VMs resolve through a public resolver, and only Pebble uses the test DNS.
- After the env change `traefik.yml` has `log: format: json`, `storage: /etc/traefik/acme/acme-custom.json`, `caServer: "https://10.231.0.251:14000/dir"` and `caCertificates: [/etc/traefik/acme/custom-ca.pem]`. `acme.json` stays empty next to `acme-custom.json`.
- Within 2 s of the restart the panel served a Pebble certificate (`issuer=CN=Pebble Intermediate CA …`) for `panel.<vm>.test`.

#### Step 2 — Domain lifecycle without DNS (Ubuntu 26.04, Debian 13)

1. The customer created `hotel.test` with `includeWww: true`; `site.provision` succeeded.
2. `curl -H 'Host: hotel.test' http://<vm>/` gave 200, and `www.hotel.test` gave 301 to `http://hotel.test/`. After the first pass both rows were `dns: not_found`. The Domains tab (rendered HTML) showed "Waiting for DNS" for both, the records table with value `10.231.0.x`, and "This address doesn't point anywhere yet. At your domain provider, create an A record for hotel.test with the value 10.231.0.10. …", the same for `www`.
3. `add-a hotel.test 192.0.2.1`, then Check now: `points_elsewhere` with `observedA ["192.0.2.1"]`, and the tab says "hotel.test points to 192.0.2.1, not to this server. Change its A record at your domain provider to 10.231.0.10." `acme-custom.json` held only the panel certificate, and the route file had no `certResolver`.

#### Step 3 — AAAA and the right A record (Ubuntu 26.04, Debian 13)

1. With A records on the VM IP for both names and `AAAA 2001:db8::1` on `hotel.test`, `hotel.test` became `ipv6_conflict`: "hotel.test also has an IPv6 (AAAA) record. Delete it at your domain provider: this server answers on IPv4 only." It got no certificate and no `certResolver`.
   - **Note:** `www.hotel.test` had no AAAA record, so it got its own certificate during this step. That is the designed one-router-per-host behaviour (ADR 0017 §2.3): a bad name never blocks its twin. The checklist's "no certificate in the store" holds for `hotel.test`.
   - `add-a` appends in challtestsrv, so the 192.0.2.1 record had to be removed with `clear-a` first.
2. After `clear-aaaa` and Check now, the row went to `requested` at once; the tab said "Setting up HTTPS". It was `active` after **21 s** on 26.04 and **37 s** on 13. `site_<id>.yml` has `router_…_tls` with `certResolver: le` for both hosts.
   - **Note:** with a custom CA the tab says "Test certificate" rather than "HTTPS active", because `trusted` is false for any CA other than Let's Encrypt production. That is by design; the "HTTPS active" label is for Task 14.
3. `curl -k --resolve hotel.test:443:<vm> https://hotel.test/` gave 200; the certificate is `issuer=CN=Pebble Intermediate CA 1d7f5a`, `SAN DNS:hotel.test`.
4. `GET http://hotel.test/` gave 301 to `https://hotel.test/`. On Debian 13 the first GET, 1 s after the status said `active`, still got 200, and 8 s later it got 301 (see O7 below).
5. `GET http://www.hotel.test/x` gave 301 to `https://hotel.test/x`.
   - Traefik answers `HEAD` (`curl -I`) with **308** and `GET` with **301** for the same permanent redirect.
6. WordPress `home` and `siteurl` are `https://hotel.test`, read with `php -r 'require "wp-load.php"; …'` in the site container. The site image has no `wp`.

#### Step 4 — Failure and no hammering (Ubuntu 26.04, Debian 13)

`hp_test_block` dropped Pebble's port 80 traffic at prerouting, priority -200, as written in the checklist. Orders were counted from Pebble's log (`Pulled a task … Value:"blocked.test"`, one per order).

| | Ubuntu 26.04 | Debian 13 |
|---|---|---|
| Check now after `add-a` | `requested` 07:24:29 | `requested` 07:56:24 |
| Traefik failure log line | 07:24:46 | 07:56:53 |
| Row `failed` / `port_80_blocked`, resolver gone from the route file | 07:24:53 (same pass) | 07:57:50 (57 s, next pass) |
| `retryAt` | 07:39:48, then 07:39:29 after Check now (= requested + 15 min) | 08:12:44, then 08:11:25 |
| Orders for `blocked.test` in the 10 min after the failure | **1** | **1** |
| Check now ×3 within 2 min | no new order, `retryAt` unchanged | same |
| After unblocking, Check now at the retry time | 1 new order, `active` in 15 s (2 orders in total) | same, 15 s |

- The tab said "Let's Encrypt couldn't reach your site from the internet. Your server administrator has been alerted. We'll try again on Nov 9, 2026, 8:12 AM."
- The admin Sites page showed "blocked.test (Blocked): nessun certificato — porta 80 non raggiungibile da internet".
- `site.certificate.requested` and `site.certificate.failed` audits were written. The failed detail holds the raw ACME error text.
- Route changes inside the window: `second.test` was created right after the failure on both VMs, and on 26.04 the Q1 experiment below also rewrote a dynamic file three times. `blocked.test` got no extra order because its resolver was already gone.

**The real Traefik 3.7.17 JSON failure line** (Ubuntu 26.04; the challenge token is shortened):

```json
{"level":"error","providerName":"le.acme","acmeCA":"https://10.231.0.251:14000/dir","providerName":"le.acme","ACME CA":"https://10.231.0.251:14000/dir","routerName":"router_svc_42c7f7d1d97448599230cc50bbc99cdb_cc5ac927_tls@file","rule":"Host(`blocked.test`)","error":"unable to generate a certificate for the domains [blocked.test]: resolver: one or more domains had a problem: [blocked.test: invalid authorization: acme: error: 400 :: urn:ietf:params:acme:error:connection :: Get \"http://blocked.test:80/.well-known/acme-challenge/95Tz…\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)]","domains":["blocked.test"],"time":"2026-11-09T07:24:46Z","message":"Unable to obtain ACME certificate for domains"}
```

`message`, `error`, `domains` and `time` match the Task 3 fixture. The line repeats `providerName` as a key; `JSON.parse` keeps the last value, so this is harmless.

#### Step 5 — Primary switch (Ubuntu 26.04, Debian 13)

- "Make main address" on `www.hotel.test` returned `routesPending: true`. The plan was settled about 3 s later.
- A curl loop every 0.25 s ran for 120 s on `http://` and `https://` of both names, each with a plain request and a `-L --max-redirs 5` request. That made 560 samples per VM:
  - 0 curl errors, 0 "too many redirects", 0 responses redirecting to themselves;
  - every `-L` request ended on 200 after at most 1 redirect.
- During the transition, about 4 s, plain `http://` requests were served 200 without the HTTPS redirect. `http://hotel.test/` also went to `http://www.hotel.test/`. The transition plan drops the HTTPS redirect while `set-url` runs; there was no loop.
- At the end, `hotel.test` (http and https) answers 301 to `https://www.hotel.test/`, and `home` and `siteurl` are `https://www.hotel.test`.
- `/hello-world/`: the stock post content has no absolute links. On Debian 13, a paragraph with `https://hotel.test/contact/` and an image from `https://hotel.test/wp-content/…` was added before the switch. After it, the post holds 2 × `https://www.hotel.test` and no `https://hotel.test`. On 26.04 the rendered page carries 55 links, all to `https://www.hotel.test`.

#### Step 6 — `CP-01` with renewal (Ubuntu 26.04, Debian 13)

1. Serials before: `www.hotel.test` `1032251C08367D15` on 26.04 and `19F22D9FB6146B08` on 13.
2. `systemctl stop hp-web hp-api hp-docker-executor hp-host-agent` (`hp-web` ends `failed`, 2a O5).
3. `docker restart hp_ingress_proxy` with every panel unit stopped.
4. **The serial changed within 4 s** (26.04: `1764BB538FC1C07C`; 13: `0DB30ABDADF74DD9`). Traefik renewed every certificate in the store at start, the panel's included.
   - The curl loop (https on `www`, the http redirect on `hotel`) failed only inside the restart second: 3 of 378 samples on 26.04 (07:40:04.1–04.6) and 3 of 229 on 13 (08:12:11.0–11.6).
   - On 26.04, 2 more https samples hit the loop's 3 s timeout at 07:41:04 and 07:42:04. A follow-up with a longer timeout showed these are 4.1 s answers of 200, not failures (O6).
   - Inside that second Debian 13 also returned one 404 and, for a moment, Traefik's default certificate, before the file provider had loaded the routes.
5. `systemctl restart docker` (units still stopped): every site was back on HTTPS in 3 s with Pebble certificates. Each proxy start renewed again (Pebble certificates are 6 or 20 days, both inside the 30-day window).
6. After the units started, the next pass wrote `site.certificate.issued` for the **current serials**, for example `61D8ACD800C62EE5` (26.04, 07:47:46) and `5DF4C579B946C95A` (13, 08:15:00). The Domains API shows the new `expiresAt`. The serials issued while the panel was down and already replaced by the next restart get no audit; detection is by `notAfter` (ADR 0017 §2.13).

#### Step 7 — Delete and update (Ubuntu 26.04, Debian 13)

1. **Delete:** `DELETE blocked.test` (`confirmName: "Blocked"`) succeeded in about 2 s. `site_<blocked>.yml` is gone, `Host: blocked.test` gets 404, and the sha256 of the `hotel.test` route file is unchanged.
2. **Update:** `hp-update --archive …0.4.1…` said "updated 0.4.0 → 0.4.1" and "All panel services are healthy", in 8 s on 26.04 and 11 s on 13.
   - The curl loop on `https://www.hotel.test` every 0.25 s got 163/163 and 156/156 answers of 200.
   - The proxy ID was unchanged (`e43a9415602d`, `1f3a6f030f35`).

### The two open questions

**Q1 — Does Traefik 3.7.17 retry a failed ACME order on every dynamic-config reload? Yes.** It also does not retry without a reload.

- On Ubuntu 26.04, with port 80 still blocked, a hand-written dynamic file put a router for `probe.test` (A → VM) with `certResolver: le`: 1 order.
- Then a separate dummy file was rewritten three times, 40 s apart, with different content each time. Pebble saw orders 2, 3 and 4, one per reload. In the next 90 s without a reload there was no new order.
- During the same test `blocked.test`, whose resolver the panel had already removed, got none.
- Both files were removed afterwards.

So removing the resolver within one pass after a classified failure (ADR 0017 §2.2) is necessary, not just prudent. Any row that keeps `certResolver` on a failing name orders again whenever any site's routes change. That decides the severity of the Task 8 deferred minor; see O1.

**Q2 — Real field names, and does `acme-status.ts` parse them? Yes, both lines parse correctly; no fix was needed.**

- **Obtain failure:** shown in step 4: `message: "Unable to obtain ACME certificate for domains"`, `domains: [...]`, `error`, `time`.
- **Renewal failure:** forced on Ubuntu 26.04 by blocking Pebble's port 80 and restarting the proxy (the token is shortened):

  ```json
  {"level":"error","providerName":"le.acme","acmeCA":"https://10.231.0.251:14000/dir","error":"resolver: one or more domains had a problem: [www.hotel.test: invalid authorization: acme: error: 400 :: urn:ietf:params:acme:error:connection :: Get \"http://www.hotel.test:80/.well-known/acme-challenge/WKpz…\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)]","time":"2026-11-09T07:49:08Z","message":"Error renewing ACME certificate: {www.hotel.test []}"}
  ```

  This line has no `domains` field. The host is only in `message` as `{main [sans]}`, which the parser's `/\{([^\s[\]{}]+)/` extracts. `:connection` classifies as `port_80_blocked`.
- **End to end:** both domains stayed `active` with `problem: port_80_blocked`, and the admin page showed "hotel.test (Hotel Bella): il certificato scade il 15 nov 2026 e non si è rinnovato". After unblocking and a new renewal, the problem cleared and the alert disappeared.
- Traefik renews certificates one after another, about 20 s each when the challenge times out.

### Bugs fixed during the run

None. Nothing blocked the checklist.

### Open items (recorded, not fixed)

- **O1 (Medium, LE safety).** Task 8 deferred a minor: a site skipped by the reconciler while `deploying` or `maintenance` keeps a `requested` resolver. Q1 shows that such a resolver orders again on every reload, which means every route change of any other site.
  - A site stuck in `deploying` or `maintenance` with a failing name would therefore hammer Let's Encrypt, up to its 5-failures-per-hour limit.
  - Fix in the final wave: drop or classify the resolver of skipped sites too.
- **O2 (Low, admin-visible). A stale renewal failure comes back after an API restart.**
  - On Ubuntu 26.04, renewal failures logged at 07:48–07:49 were followed by a successful renewal at 07:50, and the alert cleared.
  - `hp-update` restarted the API at 07:52. Both domains then showed `problem: port_80_blocked` again, and the admin alert "non si è rinnovato" returned.
  - This is the in-memory `#certSeenAt` shortcut accepted in Task 8, now confirmed live. The customer tab is not affected.
- **O3 (Low, admin-visible). The "expires … and has not renewed" alert fires on expiry alone.**
  - Pebble issued some certificates with 6 days of validity (the `shortlived` length), even right after a renewal. The panel then showed "il certificato scade il 15 nov 2026 e non si è rinnovato" for a certificate renewed minutes earlier, and "panel certificate expires on 15 Nov".
  - With Let's Encrypt's 45-day and longer certificates this cannot happen after a renewal, so this is mostly a harness effect. The wording still claims something the panel did not check.
- **O4 (Low, UX). The retry time has no time zone.** "We'll try again on Nov 9, 2026, 8:12 AM" was rendered on the server in UTC; the workstation was at UTC+1. Check in a browser whether hydration converts it to local time. If not, add the zone.
- **O5 (Low, UX). "Visit site" links to `https://` before HTTPS exists.** In step 2 the site header linked to `https://hotel.test` while the certificate was `none` and WordPress was on `http`, so a visitor would get the default certificate. "Open WP Admin" correctly used `http://`.
- **O6 (Low, performance). WordPress cron stalls a page for about 4 s once a minute when the site's own name does not resolve from the server.**
  - Every ~60 s one HTTPS request took 4.1 s. That is WordPress spawning `wp-cron.php` against `home`, whose name the site container could not resolve (`getent hosts www.hotel.test` failed after 8 s).
  - In this harness that is always the case. On a real server it happens while the customer's DNS is missing or wrong, or when a resolver is slow.
  - Consider `DISABLE_WP_CRON` plus a scheduled job, or an `/etc/hosts` entry for the site's names inside the container.
- **O7 (Info). The status says `active` a few seconds before the routes serve it.** On Debian 13, `http://hotel.test/` still answered 200 one second after the API said `active`, and 301 8 s later. The status is read from the store before the route apply has been picked up by the file provider, as in 2a O7.
- **O8 (Info). Traefik answers `HEAD` with 308 and `GET` with 301** for the same permanent redirect, so `curl -I` checks see 308.
- **O9 (Info). A plain `http://` request can get 200 without the HTTPS redirect for about 4 s while the main address switches** (the transition plan; step 5). No loop and no downgrade of WordPress itself.

### Harness notes (not product issues)

- `install.sh` contacts the configured CA during install, which is production unless `--acme-staging` is given. The harness had to block it with `hp_live_guard`; anyone repeating this harness must do the same.
- Pebble's server certificate has no IP SAN, so a new leaf was signed with the shipped minica key.
- Pebble 2.10.1 issued a mix of 20-day and 6-day certificates. Both are inside Traefik's 30-day window, so every proxy start renewed every certificate.
- The four installs ran in parallel, so the install times (149–153 s) are slower than 2a's single installs.
- The admin TOTP secrets printed by the installer were used only by the harness and are not reproduced here.
- No test password appeared in `journalctl -u 'hp-*'` (0 hits).
- **Cleanup:** every `hp-live-*` container (4 VMs, `hp-live-pebble`, `hp-live-challtestsrv`), the 8 `hp-live-*` volumes and `hp-live-net` were removed. The `hp-live-vm:*` images and the pulled Pebble images remain.

### Only the real-VM Task 14 can verify

- Let's Encrypt staging and then production (a trusted certificate, the "HTTPS active" label, a browser trusting it), and the account and storage switch from `acme-staging.json` to `acme.json`.
- A real `rate_limited` answer. Pebble has no rate limits, so only Task 3's fixture covers it, including Check now never shortening the 24 h wait.
- Real public resolvers and propagation delays, a real AAAA record left at a registrar, and CAA.
- O4 and O6 in a real browser and on a real server: the time zone after hydration, and the cron loopback once the name resolves publicly.
- Port 80 blocked at a provider firewall rather than by a local nftables rule.
- A real kernel reboot for `CP-01`.

## Real VPS with Let's Encrypt (Task 14)

**Run:** 2026-11-09, by the owner, on a cloud VPS. The archive was built on the VPS from branch `feat/step-2b-domains-dns-tls` with `corepack pnpm run release:build`, and installed with `infra/linux/install.sh --archive` from the same checkout, which includes the two installer fixes below.

**Host:** Debian 13.7 (trixie), amd64, kernel `6.12.115+deb13.1-cloud-amd64`, system language Italian. ufw was already active with an INPUT DROP policy, allowing 22, 80 and 443. The owner's real domain is not named here.

**Evidence:** the results are as the owner reported them, step by step ("all works as expected"). No raw logs or serial numbers were collected for this report.

### Verdict: PASS

| Step | Result |
|---|---|
| 1 Install on Let's Encrypt staging | PASS, after the two installer fixes below |
| 2 Add the site domain and point the registrar | PASS: DNS check correct |
| 3 HTTPS on staging, HTTP→HTTPS and the www pair | PASS |
| 4 Renewal with every panel unit stopped (`certificatesDuration: 8760`) | PASS: the served certificates changed while the panel was down; the file was restored afterwards |
| 5 Switch to production (installer rerun without `--acme-staging`) | PASS: production Let's Encrypt certificates, "HTTPS active", no browser warning |
| 6 Units stopped, `hp-api` disabled, real reboot | PASS: HTTPS for the site, `www` and the panel right after boot; nothing recreated after re-enabling |
| 7 Error messages on a real network | PASS: wrong A record (no order); port 80 blocked (one failed order, retry at about +15 min, then "HTTPS active"); name removed |
| 8 Admin view | PASS: same states as the customer; alerts card empty. The optional manual change of the expiry date was not done |

The owner also confirmed site deploys, logs, user setup and the login flows on this host.

### Installer bugs found and fixed

1. **A localized apt broke step 5** (`d93ada7`).
   - `apt-cache policy` prints `Candidato:` in Italian, but `add_apt_repo` searched only for `Candidate:`. So the installer said that PGDG had no `postgresql-18` package for trixie, when version 18.6 was there.
   - Fix: run the check with `LC_ALL=C`, plus a test.
2. **An active ufw blocked the proxy → panel traffic: the panel returned 504** (`49e5a11`).
   - ufw's INPUT chain (policy drop) also filters traffic arriving from the Docker bridges for `<docker0>:3000`. From the host the panel answered (200); from `hp_ingress_proxy` the request timed out.
   - Fix: when ufw is active, step 10 adds `ufw allow from 172.16.0.0/12 to <docker0 IPv4> port 3000 proto tcp`, plus two dry-run tests.
   - On this host the rule was added by hand before the fix. The installer's own ufw path was checked only with `--dry-run`.

### Not covered here

- The ARM64 (`aarch64`) VPS tried first was not supported: there is only the `linux-x64` archive and the installer accepts only x86_64. This is a follow-up and does not block this step.
