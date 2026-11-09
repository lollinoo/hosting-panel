# Step 2c — Outgoing Mail Relay: Acceptance Report

## Container harness with a local mail provider (Task 9)

**Run:** 2026-11-09 on branch `feat/step-2c-smtp-relay`, starting at `1cc101b`. The run fixed three things (`740f099`, `4ad4577`, `c80b41c`, below) and left two design questions open (O1, O2), both fixed afterwards in `0259d5f`.

**Releases:** built with `corepack pnpm release:build` (Node 26.13.0) and smoke-tested with `pnpm release:smoke` (PASS each time).

| Archive | Built from | Used for |
|---|---|---|
| `hosting-panel-0.4.0` | `a207118` (the 2b merge commit, a temporary worktree) | the update test (Debian 13, Debian 12) |
| `hosting-panel-0.5.0` | `1cc101b` | the first installs and the 0.4.0 → 0.5.0 updates |
| `hosting-panel-0.5.0` | `4ad4577` (after the first two fixes) | installed over the first build on Ubuntu 26.04 and Debian 13 before step 6 |
| `hosting-panel-0.5.1` | `4ad4577`, `package.json` bumped and not committed (`-dirty`) | step 7 on Ubuntu 26.04 and Debian 13 |
| `hosting-panel-0.5.1` | `c80b41c`, bumped and not committed (`-dirty`) | the live check of the classifier fix on Ubuntu 24.04 |

The installer keeps an existing `releases/0.5.0`, so the rebuilt 0.5.0 went in by moving the old directory aside and rerunning `install.sh --archive` (exit 0, 22 s and 24 s).

**Stack inside every VM:** Node 26.13.0, Docker CE 29.9.3, Traefik 3.7.17, `mariadb:12.3.3`, `wordpress:7.1.4-php8.4-apache`, `boky/postfix:5.2.1-alpine` (Postfix 3.11.7).

**Test bed:** the same as `step-2b-acceptance-report.md`.

- Each VM is a disposable privileged systemd container (`hp-live-<os>`, images `hp-live-vm:*`), `--memory 2g --memory-swap 2g`, with named volumes for `/var/lib/docker` and `/var/lib/containerd`.
- They sit on `hp-live-net` 10.231.0.0/24: Ubuntu 26.04 at .10, Debian 13 at .11, Ubuntu 24.04 at .12, Debian 12 at .13.
- Every panel action went through the real web BFF (`https://<vm-ip>/api/...`, cookie jar, admin password plus TOTP, `X-CSRF-Token`, matching `Origin`, `Idempotency-Key`). The customer account was created by the admin through the BFF; the customer changed the temporary password and switched to English. The admin used Italian, and English for the EN checks.
- Pebble 2.10.1 at .251 and `pebble-challtestsrv` at .250 as in 2b, with records for `panel.<vm>.test`, and the same env change in each VM after install (`HP_ACME_CA_SERVER`, `HP_ACME_CA_CERT_FILE`, `HP_DNS_RESOLVERS`).

**The fake provider:**

- `axllent/mailpit:v1.33.1` at 10.231.0.252 (`hp-live-mail`) as `mail.provider.test`: SMTP on `:587` with `--smtp-require-starttls`, a leaf for `DNS:mail.provider.test` signed by a throwaway CA, `--smtp-auth-file` for `relayuser` with the password `p:a#s$s w'rd`, the UI on `:8025`.
- A second instance at 10.231.0.253 (`hp-live-mail-plain`) as `plain.provider.test`, without TLS or auth, on `:1025`.

**Harness deviations (each one, every time it applied):**

- **Auth file:** Mailpit's auth file did not accept the password as plain text (a colon and a space inside it); it holds an `apr1` hash of the same password, made with `openssl passwd -apr1 -stdin`.
- **Throwaway CA:** the first CA had no `keyUsage`, which OpenSSL 3.5 rejects ("CA cert does not include key usage extension"). It was regenerated with `basicConstraints=critical,CA:TRUE` and `keyUsage=critical,keyCertSign,cRLSign`.
- **Port 587 on `plain.provider.test`:** Mailpit listens on one SMTP port. For step 5.2 a second Mailpit (`hp-live-mail-plain587`) ran in the same network namespace on `:587`, without TLS.
- **Step 3.5 host:** WP Mail SMTP points at `10.231.0.253:1025`, because the site container cannot resolve `plain.provider.test`.
- **LE guard narrowed:** `hp_live_guard` was loaded before install as in 2b (forward, priority -10, TCP 443 from 172.16.0.0/12 to anything outside 10.231.0.0/24 and 172.16.0.0/12). For steps 3.4 and 3.5 the sites must reach wordpress.org. So after the Pebble switch (`traefik.yml` checked), the 443 rule was narrowed to the proxy's network, `hp_ingress_net` 172.18.0.0/16. Its 443 counter stayed at 0: since `848c7a8` the panel certificate waits for DNS, and `panel.<vm>.test` does not resolve from the VMs.
- **Mail guard (added):** the same table drops TCP 25, 465, 587 and 2525 to anything outside 10.231.0.0/24 and 172.16.0.0/12, in forward (containers) and in output (the VM itself). Checked from Ubuntu 26.04: a connection to 1.1.1.1:587 was dropped, and one to 10.231.0.252:587 connected. So the relay could reach only the Mailpits. A VM reboot runs the distro's `flush ruleset`, so the guard was reloaded right after each reboot.
- **Relay instrumentation (from the brief):** `scratchpad/instr.sh` appended the CA to `/etc/ssl/certs/ca-certificates.crt` and the two names to `/etc/hosts`, then ran `postconf -e smtp_host_lookup=dns,native` and `postfix reload`. **Docker rewrites `/etc/hosts` on every container start**, so this was needed after every restart too, not only after a create. It was done by hand 44 times (27 on Ubuntu 26.04, 11 on Debian 13, 6 on Ubuntu 24.04), and after that by the watcher described below at each relay start:
  - after each panel create or recreate: step 2.2 (both VMs); after the step 2.4 variants (Ubuntu 26.04); after each host or port change in step 5 (5.2, 5.3; the relay is recreated because `RELAYHOST` is in its env); after the panel recreated it with the trimmed capabilities (both); after the 0.5.1 update on Ubuntu 24.04 (recreated, because its 0.5.0 still had six capabilities);
  - after each step 2.4 variant (10 variants on Ubuntu 26.04);
  - after each restart: the password changes of step 5.1, the manual restarts before step 4.3 and in step 5.4, the restarts of steps 6.2 and 6.3, and the probes on Ubuntu 24.04.
- **The two reboot cycles of step 6:** after a VM reboot, the VM's Docker DNS forwarded to a resolver it could not reach, and Postfix took the soft DNS failure ("Host not found, try again") without falling back to `/etc/hosts`. So from the second cycle on, a watcher in each VM (`watch-instr.sh`, driven by `docker events`) re-applied the hosts lines within about 1 s of every relay start, and set `smtp_host_lookup=native`.
- **Manual relay restarts:** used only to reset the per-client counter before step 4.3, to clear Postfix's cached dead destination in step 5.4, and once in step 6.2 to clear a DNS miss cached by the instrumentation race. Each is listed in the steps below.
- **Step 6, hp-api off:** `systemctl disable hp-api` did not keep it off. `hp-web` has `Wants=hp-api.service`, so the first reboot started hp-api anyway (O4). As in 2a, the unit file was moved aside and `daemon-reload` was run.
- **Step 6, a failed boot:** on the first reboot of Ubuntu 26.04, the VM's `cgroup.subtree_control` came up empty. Every container then failed with `openat2 …/pids.max: no such file or directory` (exit 127). That is a nested-container race: the next reboot came up normally on both VMs, and so did the step 1 reboots.

### Verdict

| OS | Scope | Result |
|---|---|---|
| Ubuntu 26.04 | full checklist, steps 1–7 (fresh 0.5.0 install) | **PASS with an open High item**: step 3.2 fails (O1); 5.4 answers "pending" with a dropping firewall (O2) |
| Debian 13 | full checklist, steps 1–7 (0.4.0 → 0.5.0 update) | **PASS with an open High item**: same as Ubuntu 26.04 |
| Ubuntu 24.04 | step 1 (fresh 0.5.0), plus probes | **PASS** after the `740f099` fix |
| Debian 12 | step 1 (0.4.0 → 0.5.0 update) | **PASS** after the `740f099` fix |

Everything else on the checklist passed on both full-checklist OSes.

- **O1:** `Reply-To` is rewritten to `noreply@` along with `From`. This breaks the "Reply-To is kept" promise of ADR 0018 §5, the README and Task 4.
- **O2:** with a port blocked by a dropping firewall, the test email answers "pending" at 20 s, and the "unreachable" row appears 30 s after the send.

Both need a design choice, so they are recorded and not fixed.

### Results per step

#### Step 1 — Install 0.5.0, and update 0.4.0 → 0.5.0 (all four OSes)

| OS | Path | Exit / time | `/run/hosting-panel/mail-relay` | After reboot | `site-mail` files | `hp_mail_relay` before setup |
|---|---|---|---|---|---|---|
| Ubuntu 26.04 | fresh 0.5.0 | 0 / 114 s | `755 hp-executor:hp-executor` | 755 | 3 × `644` | none |
| Ubuntu 24.04 | fresh 0.5.0 | 0 / 123 s | **`2755`** before `740f099` | 755 | 3 × `644` | none |
| Debian 13 | 0.4.0 (102 s), then `hp-update` 0.5.0 | 0 / 8 s | **`2755`** before `740f099`; `755` after the fixed installer | 755 | 3 × `644` | none |
| Debian 12 | 0.4.0 (122 s), then `hp-update` 0.5.0 | 0 / 9 s | **`2755`** before `740f099` | 755 | 3 × `644` | none |

The four installs ran in parallel. `boky/postfix:5.2.1-alpine` was pulled ahead of time.

- **Bug, fixed in `740f099`:** GNU `install -d -m 0755` keeps the setgid bit that the 3770 parent `/run/hosting-panel` passes down, so GNU coreutils gave `2755`. Ubuntu 26.04 uses uutils, which gave `0755`. `systemd-tmpfiles` creates it as `0755` on boot, so a reboot already hid the bug. The installer now uses `-m 00755`. On Debian 13 the fixed installer turned the existing `2755` into `755`.
  - The same inheritance makes `/run/hosting-panel/secrets` `2700` on GNU systems. That predates 2c, is harmless, and was left alone (O9).
- **The one-time redeploy:** `hp-api` started at 20:00:24 on both updated VMs. `service.deploy` was submitted at 20:00:26 and done at 20:00:27.8, and the site container was recreated at 20:00:27.
  - There was exactly one `service.deploy` after the update, after a Debian 12 reboot, after the fixed-0.5.0 installer and after the 0.5.1 update.
  - The container has the three binds: `…/site-mail/hp-mail.php:/var/www/html/wp-content/mu-plugins/hp-mail.php:ro`, `…/hp-mail.ini:/usr/local/etc/php/conf.d/zz-hp-mail.ini:ro` and `…/hp-sendmail.php:/usr/local/lib/hp-mail/hp-sendmail.php:ro`, plus the html volume.

#### Step 2 — Setup and hardening (Ubuntu 26.04, Debian 13)

1. **IP host refused:** `PATCH /api/admin/mail-relay` with host `10.231.0.252` returned 400 `VALIDATION_ERROR`, `details: [{field: "host", message: "host_invalid"}]`. The form maps that key to the field text.
   - IT: "Gli indirizzi IP non si possono usare, perché la connessione sicura viene verificata sul nome."
   - EN: "IP addresses can't be used, because the secure connection is checked against the name."
2. **Save:** the BFF answered at once with `configured: true, applied: false`. Polling `GET` each second gave `relayRunning: false` (+0 s), `true` (+1 s), then `applied: true, relayRunning: true` at **+8 s** on both VMs. Those are the states that make the page show "Avvio dell'invio email…" and then "In funzione"; the page's poll (`mail-relay-poll.ts`) stops at `applied`. A browser was not used (see the "Not covered" list).
   - The test email through the BFF came back `sent`, and Mailpit got `From: noreply@mail.hostingco.test`.
   - The Postfix line had `tls=secure`, so the colon, hash, dollar, space and quote in the password went through the `texthash:` map intact.
3. **Inspect:** `PortBindings {}`, `Binds ["/run/hosting-panel/mail-relay:/run/secrets/hp-mail:ro", "hp_mail_relay_spool:/var/spool/postfix"]`, `CapDrop [ALL]`, `no-new-privileges:true`, `PidsLimit 128`, `Memory 134217728`, `NetworkMode hp_mail_net`, `unless-stopped`. The relay is also connected to each site's internal network.
   - `sasl_passwd` is `0444 hp-executor` in the `0755` directory.
   - `grep -c 'p:a#s'` over the inspect JSON and over `journalctl -u hp-api -u hp-docker-executor -u hp-web` gave **0 and 0**, and 0 over the whole journal. This was checked again after the relay was recreated with the trimmed capabilities.
4. **Capabilities (Ubuntu 26.04):** `scratchpad/capvar.sh` recreated `hp_mail_relay` from its own inspect, each time with a different `CapAdd`. Each variant then had to pass four checks: Postfix running (`postfix status`), listening on :25 and :587, a BFF test sent, and the same again after a `docker restart`.

   | `CapAdd` | Existing spool | Fresh spool + restart | Result |
   |---|---|---|---|
   | all six | sent | — | baseline |
   | without `SETUID` | Postfix down: `postsuper: fatal: setuid(100): Operation not permitted` | — | **needed** |
   | without `SETGID` | Postfix down (`postfix-script` fatal) | — | **needed** |
   | without `DAC_OVERRIDE` | Postfix down: `chown: /var/spool/postfix/private: Permission denied` | — | **needed** |
   | without `CHOWN` | sent, but `chown … Operation not permitted` | sent | kept: the image's start script cannot reown the spool ("Cannot reown postfix:postdrop … Your installation might be broken") |
   | without `FOWNER` | sent | sent | **dropped** |
   | without `NET_BIND_SERVICE` | sent, :25 and :587 bound | sent | **dropped**: `ip_unprivileged_port_start` is 0 in the container |
   | `CHOWN,DAC_OVERRIDE,SETGID,SETUID` | — | sent, before and after restart | **kept** |

   Fixed in `4ad4577`: the code, its test, ADR 0018 §11 and the plan's Task 3. After the fixed build was installed, the panel recreated the relay once with the four capabilities, and the test was `sent`.

#### Step 3 — Site mail end to end (Ubuntu 26.04, Debian 13)

1. **Lost password:** the POST to `/wp-login.php?action=lostpassword` returned 302 to `checkemail=confirm`. Mailpit got "[Hotel Bella] Password Reset" with `From: Hotel Bella <noreply@mail.hostingco.test>` and `Return-Path: <noreply@mail.hostingco.test>`.
   - On the first try, two POSTs, one per VM and sent with no client timeout, got no answer at all (`curl` 000). They never reached Apache. Every retry answered in 0.1–4.7 s, and the problem did not come back (O10).
2. **`wp_mail` with `From: Info Hotel <info@hotel.test>`:** returned `bool(true)`, and the `From` header became `Info Hotel <noreply@mail.hostingco.test>`.
   - **FAIL:** `Reply-To` arrived as `Info Hotel <noreply@mail.hostingco.test>`, not `info@hotel.test`.
   - The mu-plugin does add `Reply-To: info@hotel.test`. Postfix then rewrites it, because `sender_canonical_classes=header_sender` covers `Reply-To:` too. Step 4.2 shows the same. See O1.
3. **`mail()` with `Cc` and `Bcc`:** `php -r 'var_dump(mail(…))'` printed `bool(true)`. Postfix logged `nrcpt=3`, and the three recipients received one message.
   - The message as relayed has `From: noreply@mail.hostingco.test`, `To` and `Cc`, and **no `Bcc` header**. The `Bcc:` line Mailpit shows at the very top, above its own `Received:`, is added by Mailpit for envelope-only recipients.
4. **Ownership:** `ls -ln wp-content` shows `33:33 1777` for `wp-content`, `plugins`, `themes` and `uploads`. `mu-plugins` is **`0:0 0755`**, made by Docker for the bind. The file bound in is `993:992 0644`, owned by the executor.
   - In the volume, Docker left an empty mount-point file `hp-mail.php`, `0:0 0644` (ADR 0018 §3).
   - `get_mu_plugins()` lists `hp-mail.php`, and `phpmailer_init` is hooked.
   - WP Admin installs plugins: log in as `maria`, then the "Install Now" link from `plugin-install.php` (`update.php?action=install-plugin&plugin=wp-mail-smtp&_wpnonce=…`) put `wp-content/plugins/wp-mail-smtp` there as `33:33`, on both VMs.
5. **The site's own SMTP plugin:** WP Mail SMTP was activated and set to `10.231.0.253:1025`, no encryption, no auth, `From: Hotel Bella Info <info@hotel.test>` (forced).
   - The activation and settings were done with the WordPress API in the container, not through its admin pages.
   - `wp_mail` landed in **that** Mailpit with `From: Hotel Bella Info <info@hotel.test>` and `Return-Path: <info@hotel.test>`, and the relay's Mailpit got nothing.
   - After `delete_plugins()`, the next `wp_mail` went through the relay again, with `From: Hotel Bella <noreply@mail.hostingco.test>`.

#### Step 4 — The fence and abuse limits (Ubuntu 26.04, Debian 13)

1. **From outside:** a TCP connect from the workstation to `10.231.0.10` and `10.231.0.11` on 587 and 25 **timed out**. The panel's INPUT policy drops it rather than refusing it, and nothing listens on the host (`ss -ltn`). So the result is no connection, as required, but the wording "refused" does not match.
2. **Spoofing:** a raw SMTP session from the site container to `hp-mail:587` used `MAIL FROM:<ceo@bank.test>` and the headers `From: CEO <ceo@bank.test>`, `Reply-To: ceo@bank.test` and `Sender: ceo@bank.test`. It got `250 … queued`. It arrived with:
   - `Return-Path: <noreply@mail.hostingco.test>`;
   - `From: CEO <noreply@mail.hostingco.test>`;
   - `Sender: noreply@mail.hostingco.test`;
   - and `Reply-To: noreply@mail.hostingco.test`.
3. **Rate limit:** the relay was restarted by hand first, to reset the per-client counter. Then 210 `wp_mail` calls in one PHP process took 9.5 s. Calls **1–200 returned true and 201–210 returned false** on both VMs, with PHPMailer's `450 4.7.1 Error: too much mail from 172.19.0.3`. Mailpit counted **200 and 200**.
   - Postfix logged `warning: Message delivery request rate limit exceeded: 201 from …[172.19.0.3] for service submission`.

#### Step 5 — Failure reporting (Ubuntu 26.04, Debian 13)

Each test went through `POST /api/admin/mail-relay/test`. The admin page `/admin/mail` was then rendered in IT and in EN (the admin's locale switched through the BFF), and the problem text was read from the HTML.

| Case | Answer time 26.04 / 13 | Outcome / problem | Detail |
|---|---|---|---|
| 5.1 wrong password | 3.7 s / 5.7 s | `deferred` / `auth_failed` | `SASL authentication failed; server mail.provider.test[10.231.0.252] said: 535 5.7.8 Authentication credentials invalid` |
| 5.2 `plain.provider.test`:587 | 5.6 s / 5.2 s | `deferred` / `tls_failed` | `TLS is required, but was not offered by host plain.provider.test[10.231.0.253]` |
| 5.3 certificate for `other.provider.test` | 9.1 s / 1.1 s | `deferred` / `tls_failed` | `Server certificate not verified` |
| 5.4 587 dropped (nft `drop`) | 22.7 s / 20.2 s | **`pending`** | the `unreachable` row (`connect to … Operation timed out`) appeared 30 s after the send (O2) |
| 5.4 587 refused (nft `reject with tcp reset`, Ubuntu 26.04) | 5.1 s | `deferred` / `unreachable` | `connect to mail.provider.test[10.231.0.252]:587: Connection refused` |

- **The page in both languages:**
  - `auth_failed`: "Il fornitore ha rifiutato nome utente o password. …" / "The provider refused the user name or password. …".
  - `tls_failed`: "La connessione sicura con … non è riuscita o il certificato non corrisponde al nome. …" / "The secure connection to … failed or its certificate does not match the name. …".
  - `unreachable`: "Questo server non raggiunge mail.provider.test sulla porta 587. …" / "This server cannot reach mail.provider.test on port 587. …".
- **A host change recreates the relay** (5.2 and 5.3), because `RELAYHOST` is in its env. That also drops the old container's log, so "sent in the last 24 hours" and "Recent problems" restart from zero (O5).
- **5.5 unblock:** after the nft table was removed at 20:33:55, every deferred message arrived exactly once. Ubuntu 26.04 sent 9 at 20:38:44–48 and the last one at 20:43:47. Debian 13 sent 4 at 20:41:38–42 and 4 at 20:46:38–42. That timing is Postfix's own retry backoff: nothing flushes the queue when the provider comes back (O3).
  - The messages deferred during 5.1–5.3 were delivered too, to the provider configured at that moment.
- **"Delivery temporarily suspended":** it appeared once the destination was marked dead. It is logged by **`postfix/error`**, not by `qmgr` or `smtp`. Three messages queued at once all tried in parallel, and each got its own `connect … timed out`.

#### Step 6 — `CP-01` (Ubuntu 26.04, Debian 13)

1. **Units stopped:** after `systemctl stop hp-web hp-api hp-docker-executor hp-host-agent`, `wp_mail` returned true and arrived. `hp-web` ended `failed`, as in 2a O5.
2. **hp-api off and a reboot:** hp-api's unit file was moved aside (see the deviations), then the VM was restarted. The relay ID was the same as before (`19298aa4f809`, `b3960b490142`), `/run/hosting-panel/mail-relay` was empty (`0755 hp-executor`), and hp-api was inactive.
   - Three `wp_mail` calls returned `true true true`, on both cycles and both VMs.
   - The relay logged `error: open database /run/secrets/hp-mail/sasl_passwd: No such file or directory` and then, per message, `status=deferred (local data error while talking to mail.provider.test[10.231.0.252])`.
   - **The 0.5.0 classifier read that as `other`.** Fixed in `c80b41c` (below), and checked live on 0.5.1: the test email answered `credentials_missing`, with the IT and EN text on the page.
   - In the first cycle, the instrumentation came too late and the deferrals were DNS misses. A manual restart cleared the cached miss, and the queued messages' next retry logged the `local data error` lines.
3. **hp-api back:** the unit file was restored, then `systemctl enable hp-api` and `start hp-api hp-web`. In the second cycle, on both VMs:
   - the relay was restarted **once**, 2–3 s after hp-api started (`kill`, `die`, `start`, `restart` in `docker events`), and its ID did not change;
   - `exec_create: postqueue -f` came in the same second and was retried every 2–3 s until Postfix was up, 5 times within 14 s;
   - every queued message was delivered within 15 s, and the queue was empty: 10 on Ubuntu 26.04 and 9 on Debian 13. That includes the 3 from the first cycle.
   - Mailpit holds **3 messages with 3 distinct Message-IDs** for each batch (`t62`, `t63` and `t63c`, per VM), so nothing was delivered twice.
   - In the first cycle, the restart and the flush happened the same way. Delivery then waited for the instrumentation, and the mail arrived on the next retry.

#### Step 7 — Update and remove (Ubuntu 26.04, Debian 13)

1. **`hp-update --archive …0.5.1…`:** "updated 0.5.0 → 0.5.1", "All panel services are healthy", in 7 s on 26.04 and 9 s on 13.
   - The relay ID was unchanged, and so was its `StartedAt`: it was not even restarted. Every container ID was unchanged.
   - `service.deploy` stayed at 0 on 26.04 (it was a fresh install) and at 1 on 13. No site was redeployed.
   - A `wp_mail` loop ran during the update, 80 calls 0.5 s apart: **80/80 true, 80 arrived, 80 distinct subjects**, on both VMs.
   - Ubuntu 24.04, updated from the first 0.5.0 (six capabilities) to the final 0.5.1, got its relay **recreated once**. That is expected: the capability change alters the config hash.
2. **Remove:** `DELETE /api/admin/mail-relay` gave `configured: false`. Within a few seconds:
   - `hp_mail_relay` was gone and `/run/hosting-panel/mail-relay` was empty;
   - `hp_mail_relay_spool` and `hp_mail_net` were still there;
   - `wp_mail` returned `bool(false)` in 0.01 s (`getaddrinfo for hp-mail failed`), and `mail()` returned `bool(false)`.
   - `GET` answered `configured: false, applied: true, relayRunning: null`.

### Items flagged by earlier reviews

- **(a) The order of `POSTFIX_*`.** The start log of `boky/postfix` runs its own steps first, then "Applying custom postfix setting: …" for every `POSTFIX_*`. `postconf` shows each value in effect (`smtp_tls_security_level = secure`, `sender_canonical_maps = static:noreply@mail.hostingco.test`, `smtpd_client_event_limit_exceptions = 127.0.0.0/8`, and so on).
  - On a **restart**, the image's upgrade step first rewrites `texthash:` to `textlmdb:` (its `s/(hash|btree):/lmdb:/` also matches inside `texthash:`). It warns "Could not rebuild map lmdb:/run/secrets/hp-mail/sasl_passwd". The custom settings that follow put `texthash:` back before Postfix starts, so this is harmless, but it only works because of this order (O6).
- **(b) CA bundle and real verification.** The image has `/etc/ssl/certs/ca-certificates.crt` (118 certificates), and `smtp_tls_CAfile` points at it.
  - On Ubuntu 24.04, `smtp_tls_CAfile` was pointed at a pristine copy of the image's bundle, without the harness CA. The test came back `deferred` / `tls_failed`, with `certificate verification failed for mail.provider.test[10.231.0.252]:587: untrusted issuer /CN=hp-live throwaway mail CA`.
  - With the CA appended, `tls=secure`. The wrong-name certificate (5.3) gave `server certificate verification failed for mail.provider.test[10.231.0.252]:587: num=62:hostname mismatch`. Postfix's `smtp` is not chrooted in this image (`master.cf` column `n`), so `/etc` is what it reads.
- **(c) The mu-plugins bind:** the plugin loads; Docker makes `mu-plugins` `root:root 0755` and leaves an empty `hp-mail.php` in the volume; WordPress still installs plugins into `wp-content/plugins` (step 3.4). No PHP warning appeared in the site log.
- **(d) Real Postfix texts:** below.
- **(e) Queue lifetime:** `postconf maximal_queue_lifetime` = `5d`, `bounce_queue_lifetime` = `5d`.

### Real Postfix 3.11.7 lines (`boky/postfix:5.2.1-alpine`)

The relay logs `<ISO time> <LEVEL> postfix/<daemon>[pid]: …`. Docker adds its own timestamp in front, which the executor reads.

```text
# sent
INFO    postfix/smtp[550]: EDF5AE101D: to=<admin-u2604@example.test>, relay=mail.provider.test[10.231.0.252]:587, delay=4.2, delays=0.01/0.09/4.1/0, tls=secure, dsn=2.0.0, status=sent (250 2.0.0 Ok: queued as 7IY3FsnnGmHtgcuIwpjEe7)
# credentials missing (sasl_passwd absent after a reboot)
ERR     postfix/smtp[518]: error: open database /run/secrets/hp-mail/sasl_passwd: No such file or directory
WARNING postfix/smtp[518]: warning: texthash:/run/secrets/hp-mail/sasl_passwd is unavailable. open database /run/secrets/hp-mail/sasl_passwd: No such file or directory
WARNING postfix/smtp[518]: warning: 9238D4939C: smtp_sasl_password_maps lookup error
INFO    postfix/smtp[518]: 9238D4939C: to=<probe-nocreds@example.test>, relay=mail.provider.test[10.231.0.252]:587, delay=7.2, delays=3/0.06/4.1/0, tls=secure, dsn=4.3.0, status=deferred (local data error while talking to mail.provider.test[10.231.0.252])
# auth failure
INFO    postfix/smtp[443]: 8056A493A2: to=<probe-nocreds2@example.test>, relay=mail.provider.test[10.231.0.252]:587, delay=67, delays=64/0.11/2.6/0, tls=secure, dsn=4.7.8, status=deferred (SASL authentication failed; server mail.provider.test[10.231.0.252] said: 535 5.7.8 Authentication credentials invalid)
# TLS not offered / wrong name / untrusted CA
INFO    postfix/smtp[441]: 3C40BE1700: to=<s5-u2604@example.test>, relay=plain.provider.test[10.231.0.253]:587, delay=2.6, delays=0.01/0.08/2.5/0, tls=!secure, dsn=4.7.4, status=deferred (TLS is required, but was not offered by host plain.provider.test[10.231.0.253])
INFO    postfix/smtp[447]: server certificate verification failed for mail.provider.test[10.231.0.252]:587: num=62:hostname mismatch
INFO    postfix/smtp[447]: C160E6925A: to=<s5-d13@example.test>, relay=mail.provider.test[10.231.0.252]:587, delay=0.08, delays=0.01/0.02/0.04/0, tls=!secure, dsn=4.7.5, status=deferred (Server certificate not verified)
INFO    postfix/smtp[537]: certificate verification failed for mail.provider.test[10.231.0.252]:587: untrusted issuer /CN=hp-live throwaway mail CA
# unreachable (dropped / refused / DNS)
INFO    postfix/smtp[447]: 855FC69260: to=<s5-d13@example.test>, relay=none, delay=30, delays=0.01/0/30/0, tls=secure?, dsn=4.4.1, status=deferred (connect to mail.provider.test[10.231.0.252]:587: Operation timed out)
INFO    postfix/smtp[536]: BDC87E1705: to=<s5-u2604@example.test>, relay=none, delay=0.11, delays=0.01/0.06/0.04/0, tls=secure?, dsn=4.4.1, status=deferred (connect to mail.provider.test[10.231.0.252]:587: Connection refused)
INFO    postfix/smtp[393]: 43A76E1708: to=<s5-u2604@example.test>, relay=none, delay=37, delays=37/0.03/0.03/0, dsn=4.3.5, status=deferred (Host or domain name not found. Name service error for name=plain.provider.test type=A: Host not found)
INFO    postfix/smtp[445]: 9238D4939C: to=<probe-nocreds@example.test>, relay=none, delay=87, delays=87/0.13/0.07/0, dsn=4.3.5, status=deferred (unable to look up host mail.provider.test: Name does not resolve)
# delivery temporarily suspended: logged by postfix/error
INFO    postfix/error[607]: D4157E1810: to=<susp2-u2604@example.test>, relay=none, delay=0.07, delays=0.06/0.01/0/0, dsn=4.4.1, status=deferred (delivery temporarily suspended: connect to mail.provider.test[10.231.0.252]:587: Operation timed out)
INFO    postfix/error[511]: CACE5E17D6: to=<cp01probe-u2604@example.test>, relay=none, delay=0.06, delays=0.05/0.01/0/0, dsn=4.4.3, status=deferred (delivery temporarily suspended: Host or domain name not found. Name service error for name=mail.provider.test type=A: Host not found, try again)
# rate limit
WARNING postfix/smtpd[569]: warning: Message delivery request rate limit exceeded: 201 from hp_svc_svc_….hp_site_site_…_net[172.19.0.3] for service submission
```

**Compared with the Task 4 fixtures:**

- The lines carry a `tls=` field before `dsn=`.
- musl writes "Operation timed out", not "Connection timed out".
- The suspended line comes from `postfix/error`. The parser already accepts `error`.
- Two texts were classified wrong, and `c80b41c` fixes them:
  - `local data error while talking to …` was read as `other`; it is now `credentials_missing`;
  - `unable to look up host …: Name does not resolve` was read as `other`; it is now `unreachable`.
- A new test pins all the real lines above.

### Bugs fixed during the run

- **`740f099` `fix(installer)`:** the relay secret directory was `2755` on GNU coreutils (Ubuntu 24.04, Debian 12, Debian 13). Bootstrap now uses `install -d -m 00755`. The layout test was updated. Verified live on Debian 13 (`2755` → `755`).
- **`4ad4577` `fix(executor)`:** the relay's `CapAdd` was trimmed to `CHOWN, DAC_OVERRIDE, SETGID, SETUID` (step 2.4), with the test, ADR 0018 §11 and the plan's Task 3 updated. Verified live: recreated once, delivers, survives a restart and the update.
- **`c80b41c` `fix(executor)`:** the real Postfix texts for missing credentials and for an unresolvable host (step 6.2, step 5) are classified correctly, with a real-line test. Verified live on 0.5.1 (`credentials_missing` through the BFF, IT and EN text).
- Each fix passed root `pnpm test` (757 passed, 2 skipped after the last one), `pnpm lint` and `pnpm -r typecheck`.

### Open items (recorded; O1 and O2 fixed afterwards)

- **O1 (High, behaviour promised to customers). `Reply-To` is rewritten to `noreply@`. Fixed in `0259d5f`** (option 1: `sender_canonical_classes=envelope_sender`, plus an inline `regexp:` `header_checks` that `REPLACE`s `From:` (display name kept) and `Sender:`). Verified live against `boky/postfix:5.2.1-alpine` and Mailpit on a throwaway internal network: quoted name with `,` and `<`, folded, bare and `Sender:` cases arrive with `Return-Path`, `From` and `Sender` at `noreply@` and `Reply-To` unchanged; `From: CEO <ceo@bank.test>` arrives as `CEO <noreply@…>`; `From: ceo@bank.test, <x@y.test>` as the bare `noreply@`.
  - `sender_canonical_classes=envelope_sender,header_sender` with `static:` rewrites every sender-class header: `From`, `Sender` and also `Reply-To`.
  - So the `Reply-To` that the mu-plugin adds, and any `Reply-To` a form plugin sets, arrives as `noreply@<sender domain>`. Replies to booking and contact mails go nowhere.
  - This contradicts ADR 0018 §5, README "Email in uscita" and the step 3.2 expectation.
  - Options:
    1. rewrite only the envelope sender with the canonical map, and the `From:` and `Sender:` headers with `header_checks` (`REPLACE`), keeping the display name;
    2. a `smtp_header_checks` or `cleanup` rule that saves `Reply-To` before the rewrite;
    3. drop the promise and document that replies go to `noreply@`.
  - The anti-spoofing goal of step 4.2 must still hold for `From` and `Sender`.
- **O2 (Medium, admin UX). A port blocked by a dropping firewall answers "Still being sent", not "unreachable". Fixed in `0259d5f`** (`POSTFIX_smtp_connect_timeout=15s`; the 20 s test wait stays; unit test only, not re-run with a dropping firewall).
  - The test waits 20 s (`mailTestWaitMs`), and Postfix's `smtp_connect_timeout` is 30 s. So a silently dropped 587, the usual cloud egress block, gives `pending` at about 20 s. The `unreachable` row appears 30 s after the send, and the page's "Check Recent problems in a minute" leads there.
  - A refused port answers `unreachable` in 5 s.
  - Options: `POSTFIX_smtp_connect_timeout=15s`, which also changes the config hash and recreates the relay once; or a test wait of about 35 s (the BFF allows 45 s).
- **O3 (Low). Nothing flushes the queue when the provider comes back.** After an outage, delivery waits for Postfix's backoff: 5–13 min here, up to `maximal_backoff_time` (4000 s) after a long outage. "Save again" restarts and flushes only if the password changed. A "retry now" action, or a flush on a successful test, would help.
- **O4 (Low, ops). `systemctl disable hp-api` does not keep it off across a reboot,** because `hp-web` has `Wants=hp-api.service`. Together with 2a O4 (no masking), the documented way to keep the API down is to stop both units or move the unit file aside.
- **O5 (Info). Relay history resets on recreate.** A host or port change recreates the relay, so "sent in the last 24 hours" and "Recent problems" start from zero. This is within ADR 0018 §3 (the status is read from the container's log), but it is visible to the admin right after a fix.
  - `credentials_missing` is only visible for a moment through the API, because a running API rewrites the password, which restarts and flushes the relay.
- **O6 (Info, image). `boky/postfix:5.2.1-alpine` quirks:**
  - `opendkim` exits 127 at every start until supervisord gives up (FATAL), although DKIM is not used;
  - supervisord logs `PermissionError` when it tries to signal it at stop (no `KILL` capability);
  - the image logs "Forwarding all emails to [host]:587 without any authentication", which is wrong: SASL is set through `POSTFIX_*`;
  - the `texthash:` → `textlmdb:` rewrite on restart, see (a);
  - none of these affected delivery. Revisit when Step 6 pins the digest.
- **O7 (Info). `hp-web` still ends `failed` on stop** (2a O5).
- **O8 (Info). Ports 25 and 587 from outside are dropped (time out), not refused.** That meets the goal; the checklist wording says "refused".
- **O9 (Info). `/run/hosting-panel/secrets` is `2700` on GNU systems,** for the same setgid inheritance fixed for `mail-relay`. It predates 2c, is harmless and was left as is.
- **O10 (Info, not reproduced).** The first two lost-password POSTs of step 3.1 got no answer and never reached Apache. Every later request answered.

### Harness notes (not product issues)

- `/etc/hosts` instrumentation must follow every relay start, not only a create, because Docker rewrites the file. After a VM reboot, the VM's Docker DNS returns a soft failure for the fake names, so a watcher with `smtp_host_lookup=native` was used.
- Mailpit's auth file needs a hashed password; its UI adds a `Bcc:` line for envelope-only recipients; and it sometimes held an SMTP connect for about 4 s (`delays=…/4.1/…`).
- The first reboot of Ubuntu 26.04 came up without cgroup controllers in the nested container, and every container failed with exit 127. The next reboot was normal.
- The admin TOTP secrets printed by the installers were used only by the harness and are not reproduced here. The test password never appeared in `docker inspect` or `journalctl` (0 hits).
- **Mail never left the bed.** The mail guard's counters showed no drop except the deliberate probe to 1.1.1.1:587, and the relay's only relayhosts were the two Mailpits. Let's Encrypt was never contacted: the 443 counter stayed at 0.
- **Cleanup:**
  - removed: the 9 `hp-live-*` containers (4 VMs, Pebble, challtestsrv, and the three Mailpits), the 8 `hp-live-*` volumes, `hp-live-net`, and the worktrees for 0.4.0 and 0.5.1;
  - kept: the `hp-live-vm:*` images and the pulled Pebble, challtestsrv and Mailpit images.

### Not covered here (Task 10, real VPS)

- A real provider with real SPF and DKIM on the sender domain, and real inbox placement.
- Real CA verification against a public certificate.
- A cloud provider's outbound port policy (25 and 587), and with it a real check of O2.
- A real kernel reboot for `CP-01`.
- The admin page in a real browser: "Avvio…" then "In funzione" without a reload, the test result, and the field error for an IP host. Here they were checked through the BFF, the i18n map and the server-rendered HTML.
