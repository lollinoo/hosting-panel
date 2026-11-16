# Step 4 — Files, Databases, Site Import and Backups: Acceptance Report

This report grows with step 4. Each part is a scripted run against a real Docker Engine with
throw-away objects; nothing here was run on a production server yet.

## Part 1 — Web file manager (ADR 0019)

**Run:** 2026-11-14 on branch `feat/step-3-6-site-tools-and-admin`, Docker Engine 29.9.2, Node 24.15.0,
image `wordpress:7.1.4-php8.4-apache` (already on the machine, never pulled by the check).

**Command:** `corepack pnpm run build && node infra/linux/accept-m1-files.mjs`

**Result:** 17 of 17 steps passed in about 13 seconds. The script exits `0` only when every step passes.

The script drives the executor's real adapter (`DockerEngineSocketAdapter.siteFiles`), the same code the
signed IPC route `POST /v1/sites/files` calls. Every object it creates has `swarmtest` in its name and
is removed by exact name at the end, also on Ctrl-C. It publishes no host port and never prunes.
The site data lives on a memory-backed volume, so the result does not depend on free disk space.

| # | Step | What it proves |
|---|---|---|
| 1 | `preflight` | The engine answers and the WordPress image is present. |
| 2 | `seed` | A site volume owned by `33:33` with a WordPress-like tree, a stand-in site container using it, links that point outside the site and one that points inside. |
| 3 | `helper-spec` | The first listing creates the per-site helper `hp_files_<id>` with: user `33:33`, no network, read-only root filesystem, every capability dropped, `no-new-privileges`, exactly two mounts, no `service_instance_id` label. |
| 4 | `program-timeout-tool` | The image ships a `timeout` tool that kills an over-time command (`-s KILL`, exit 137), and the helper really starts its program under `timeout -s KILL <seconds>`. The per-operation time limit relies on both. |
| 5 | `roundtrip` | Upload, list, edit, download: the bytes that come back are the bytes that went in. |
| 6 | `large-upload` | A file of four 512 KiB chunks plus a rest, with one chunk sent twice, arrives with the same SHA-256 and is owned by `33:33`. |
| 7 | `path-validation` | `../x`, `/etc/x`, a name with a NUL byte and the reserved `.htpanel-` prefix are refused before anything runs in the helper. |
| 8 | `symlink-escape` | Read, list, write and new-folder through a link that points outside the site are refused (`PERMISSION_DENIED`, reason `protected`). A link that points inside the site still works. |
| 9 | `protected` | The panel's mail plug-in (`wp-content/mu-plugins/hp-mail.php`) and its parent folders cannot be deleted, moved, overwritten or added to. |
| 10 | `delete-link` | Deleting a link removes the link, not what it points to. |
| 11 | `zip-attacks` | Archives with `..` names, absolute names, links, 20,001 entries or a decompression bomb are refused and leave the site unchanged. |
| 12 | `zip-roundtrip` | Zipping `wp-content` and unpacking it elsewhere gives the same content. |
| 13 | `list-large` | A folder with 5,000 names of about 200 bytes each (half of them accented) is answered in under 1 MiB and marked as cut short. |
| 14 | `cp01-site-untouched` | The site's own container is still running with the same start time and restart count `0`, and nothing was ever executed inside it (CP-01). |
| 15 | `idle-removal` | An idle helper is removed on its own, and the next request brings it back. |
| 16 | `purge` | Removing the site removes the helper and does not bring the volume back. |
| 17 | `protected-before-disk` | On a volume below the 1 GiB free-space floor, a write to a place the site may not write is refused as `protected`, not as "disk full". |

**First run and what it changed.** The first run passed 9 of 14 steps. The five failures had one cause:
the machine had about 310 MB free and the helper refuses writes below 1 GiB free. Two things were
fixed because of it: the write-permission check now comes before the free-space check, and the script
moved its site data to a memory-backed volume. Three steps were added (4, 13, 17).

**Not covered here.**
- The HTTP routes, tenancy (`404` across organizations), permissions, audit events and the browser
  screens: covered by the integration tests on the simulator (`apps/api/test/site-files.integration.test.ts`,
  `apps/web/test/site-files-*.test.ts`).
- The unit tests of the PHP helper program (`apps/docker-executor/test/site-files-program.test.ts`) are
  skipped on a machine without PHP, as this one is. CI installs PHP with the zip extension and runs them.
- A real server with real WordPress traffic. Run the same script there after `hp-update`.

## Part 2 — SFTP (ADR 0020)

**Run:** 2026-11-14 on branch `feat/step-3-6-site-tools-and-admin`, Docker Engine `29.9.2`, Node `v26.13.1`, OpenSSH client `OpenSSH_9.6p1 Ubuntu-3ubuntu13.20` (`OpenSSL 3.0.13`), pinned image `linuxserver/openssh-server@sha256:161e0b670b31d9539ca1718bc5943e981779331b4e1c9d32e8929d7652a1f22f` (already on the machine, never pulled by the check; stand-in site container uses `alpine:3`).

**Command:** `corepack pnpm --filter @hosting-panel/contracts run build && corepack pnpm --filter @hosting-panel/docker-executor run build && node infra/linux/accept-m1-sftp.mjs`

**Result:** 19 of 19 steps passed twice in a row (35.8s and 35.6s; final run: `accept-m1-sftp: 19/19 passed in 35.6s`). The script exits `0` only when every step passes. Run once more on the same machine after the last fixes (host key checked before the server is stopped, the unsupported `PrintLastLog` line removed from the server's configuration): `accept-m1-sftp: 19/19 passed in 35.5s`, with `many-sessions` at `44.12MiB / 256MiB`, 61 processes.

The script drives the executor's real adapter (`DockerEngineSocketAdapter.applySftpAccess`, `ensureSftpFromState`, `getSftpStatus`) together with the API's real `sha512Crypt` (`apps/api/dist/sites/sha512-crypt.js`) and real OpenSSH `sftp` / `ssh` / `ssh-keygen` clients over an ephemeral loopback port on `127.0.0.1` (password passed via `SSH_ASKPASS`). Every container, network and volume it creates starts with `hp_swarmtest_` and is removed by exact name in `finally` (also on Ctrl-C), with no prune command ever run.

| # | Step | Result | What it proves |
|---|---|---|---|
| 1 | `setup` | PASS | Ephemeral port on `127.0.0.1`, temporary `0700` state dir, two `33:33` site volumes (with `secret-b.txt` seeded in volume B), and a running stand-in site container (`alpine:3`) mounting volume A. |
| 2 | `apply-user-a` | PASS | Applying user A (hashed via API `sha512Crypt`) starts the SFTP container, `getSftpStatus()` reports `running=true` and the port, and `hostKeyFingerprint` matches `ssh-keygen -lf` on the generated `.pub` key. |
| 3 | `container-hardening` | PASS | `docker inspect` confirms `Privileged=false`, `ReadonlyRootfs=true`, `CapDrop=["ALL"]`, `CapAdd=["SETGID","SETUID","SYS_CHROOT"]`, `no-new-privileges:true`, `256 MiB` memory/swap (`268435456`), `PidsLimit=512`, `0.5` CPU, no `docker.sock` mount, no bind mount outside the state directory, and no other container on the SFTP bridge network. |
| 4 | `upload-and-ownership` | PASS | Real `sftp` `put up.txt` using `SSH_ASKPASS` succeeds and a separate `stat` container confirms `33:33` ownership inside volume A. |
| 5 | `confinement` | PASS | `get /etc/passwd` fails, `ls -a /` lists only `.`, `..`, and `files`, and `cd ..` followed by `pwd` stays at `/`. |
| 6 | `second-site-isolation` | PASS | Adding user B on site `sb` recreates the SFTP container with a new `Id`; user A cannot read `/srv/sftp/sb/files/secret-b.txt` or `../sb/files/secret-b.txt`, while user B (sharing uid `33`) reads `secret-b.txt`. |
| 7 | `symlink-escape` | PASS | Symlinks created through SFTP pointing to `/etc/passwd`, `/srv/sftp/sb/files/secret-b.txt`, `../../../../etc/passwd`, and `../../../sb/files/secret-b.txt` cannot be read via SFTP, while an in-site symlink resolves inside the user's own root. |
| 8 | `no-shell-no-pty` | PASS | `ssh -T id` produces no shell `uid=` output and `ssh -tt id` receives `PTY allocation request failed` with no `uid=`. |
| 9 | `no-forwarding` | PASS | `ssh -N -W 127.0.0.1:22` exits `255` with `administratively prohibited`, and `ssh -N -oExitOnForwardFailure=yes -R 0:127.0.0.1:1` exits `255` within 15 seconds. |
| 10 | `second-user-no-recreate` | PASS | Adding user A2 on already-served site `sa` keeps the same container `Id`, `State.StartedAt`, and `users/passwd` inode, and A2 logs in immediately and sees `up.txt`. |
| 11 | `serves-without-panel` | PASS | `docker restart` of the SFTP container still serves user A2 with the same host key fingerprint, and a brand-new `DockerEngineSocketAdapter` calling `ensureSftpFromState()` keeps the same container `Id` and `State.StartedAt` while logins continue to work. |
| 12 | `many-sessions` | PASS | User A holds 20 concurrent SFTP sessions open (opened in batches of 4 under `PerSourceMaxStartups 10`); `docker stats --no-stream` measured `44.14MiB / 256MiB (17.24%)` with `61` PIDs (`44.12MiB / 256MiB`, `61` PIDs on the prior run), while user B of site `sb` still logs in and lists `secret-b.txt`. |
| 13 | `site-deletion-volume-removal` | PASS | Applying desired state without site B recreates the container without volume B, allowing `docker volume rm` on volume B to succeed while user A still logs in. |
| 14 | `delete-cuts-session` | PASS | With user A2 holding an open SFTP session, applying without A2 changes `State.StartedAt`, ends or breaks A2's open session within a few seconds, refuses a new login for A2, and allows remaining user A to log in again. |
| 15 | `add-user-no-restart` | PASS | With site A served for one user (user A) holding an open SFTP session, adding user A2 keeps the same container `Id` and `State.StartedAt`, the already-open session of user A still lists `up.txt`, and user A2 logs in. |
| 16 | `new-password` | PASS | Applying a new `$6$` password hash for user A2 changes `State.StartedAt`, refuses the old password (`Permission denied`), and accepts the new password. |
| 17 | `cp01-site-untouched` | PASS | The stand-in site container on volume A stays running with the same `StartedAt`, `RestartCount=0`, and no `ExecIDs` (CP-01). |
| 18 | `empty-apply-preserves-host-key` | PASS | Applying `{ users: [] }` removes the SFTP container while preserving the host key on disk (`running=false`, same fingerprint), and re-applying restores the server with the exact same fingerprint (`known_hosts` login succeeds). |
| 19 | `wrong-password-penalty` | PASS | Repeated wrong passwords fail with `Permission denied` (`255`), triggering `PerSourcePenalties` (`authfail:10s`, `min:15s`, so two failures block the third attempt before auth with `Connection closed`), and the correct password succeeds again within 120 seconds. |

**Not covered here.**
- Idle timeouts (`ClientAliveInterval 60`, `ClientAliveCountMax 3`, `ChannelTimeout session=30m`, `UnusedConnectionTimeout 10m`) were not waited out in real time.
- A real server with a public IP address (this run binds `127.0.0.1` on an ephemeral high port).
- The cloud provider firewall or external port reachability on TCP `2222`.
- The source IP address seen by `PerSourcePenalties` behind a real network or NAT/hairpin path (on loopback/bridge here, `sshd` sees the local gateway/proxy address rather than a remote client IP).
- SFTP logins over IPv6.
- Memory usage under many fast uploads at once.

## Part 3 — Databases (ADR 0021)

**Run:** 2026-11-14 on branch `feat/step-3-6-site-tools-and-admin`, Docker Engine `29.9.2`, Node `v26.13.1`, pinned MariaDB image `mariadb:12.3.3` (and `wordpress:7.1.4-php8.4-apache` for the PHP `mysqli` client; both already on the machine, never pulled by the check).

**Command:** `corepack pnpm run build && node infra/linux/accept-m2-databases.mjs`

**Result:** 17 of 17 steps passed in 20.1s (`accept-m2-databases: 17/17 passed in 20.1s`; prior two consecutive fix-round runs on the same code: 20.1s and 21.2s). The script exits `0` only when every step passes.

The script drives the executor's real adapter (`DockerEngineSocketAdapter.siteDatabases`, pointed at the throw-away MariaDB via `sharedDbContainerName`), the built `SiteDatabasesRunner` + `mariadbRootExec` for the sign-on SQL half (with a no-op `ensurePhpMyAdmin`), and the real `DB_PROVISION_SCRIPT` via `buildSiteJobContainerPayload`. Every container and network it creates starts with `hp_swarmtest_` and is removed by exact name in `finally` (also on Ctrl-C), with no host ports published and no prune command ever run.

| # | Step | Result | What it proves |
|---|---|---|---|
| 1 | `setup` | PASS | Isolated bridge network, temporary `0400` root key file, hardened throw-away `mariadb:12.3.3` container (`CapDrop=["ALL"]`, `no-new-privileges:true`, no `PortBindings` or `ExposedPorts`), and `DockerEngineSocketAdapter` configured via `sharedDbContainerName`. |
| 2 | `readiness` | PASS | Polling `adapter.siteDatabases({ op: "list" })` succeeds within 120s once MariaDB finishes initializing, and hardened `mariadb:12.3.3` and `wordpress:7.1.4-php8.4-apache` client containers start on the isolated network. |
| 3 | `provision-own-databases` | PASS | Real `DB_PROVISION_SCRIPT` with `HP_DB_NAME_ESCAPED` provisions site A and site B (`primary: true`); site A's WordPress user reads/writes its own DB, gets `1044` trying to `CREATE DATABASE wpX<hexA>`, and cannot see or `USE` site B's DB (`1044`). |
| 4 | `lifecycle-per-site` | PASS | `createDatabase` (`_shop`), `createUser` (`_app` with `mysqlNativePasswordHash`), and `grant` produce the exact expected `list` output with primary and custom flags. |
| 5 | `isolation` | PASS | From both `mariadb` CLI (password on stdin) and PHP `mysqli` in the WordPress container, `P_app` sees only `P_shop` and `information_schema`, gets `1044` on site B's DB and `CREATE DATABASE`, and gets `1044` on a root-created wildcard decoy `wpX<hexA>_shop`. |
| 6 | `password-rotation` | PASS | `setUserPassword` kills an active `SELECT SLEEP(60)` session (`0` remaining in `PROCESSLIST`), rejects the old password with `1045`, and accepts the new password. |
| 7 | `revoke` | PASS | `revoke` kills an active `USE P_shop; SELECT SLEEP(1)` loop session (`0` remaining in `PROCESSLIST`), blocks subsequent `USE P_shop` with `1044`, and a second `revoke` returns `{}`. |
| 8 | `delete-and-recreate` | PASS | Granting `dbShop` to `P_app`, dropping `dbShop` via `P_app` SQL `DROP DATABASE` leaves `1` stale row in `mysql.db`, and calling `createDatabase` for `dbShop` strips access (`1044` on `USE`) and leaves `0` rows in `mysql.db`. |
| 9 | `delete-user` | PASS | `deleteUser` kills an active `SELECT SLEEP(60)` session (`0` remaining in `PROCESSLIST`) and subsequent login fails with `1045`. |
| 10 | `quota` | PASS | 10 custom databases and 10 custom users succeed (primary DB and primary user not counted), an 11th of each fails with `QUOTA_EXCEEDED`, and a DB created directly as root triggers `ALREADY_EXISTS` on `createDatabase`. |
| 11 | `injection-refusal` | PASS | Five hostile/cross-site requests (`'`, `` ` ``, `;`, `\`, and site B's prefix) fail with `VALIDATION_ERROR`/`NOT_FOUND`, leaving root `SHOW DATABASES` and `mysql.user` unchanged. |
| 12 | `signon-sql` | PASS | `phpMyAdminSignOn` returns `pma_<hexA>`, sees exact site A databases as databases are created/deleted (and removes deleted grant rows from `mysql.db`), kills the prior session and rejects the old password (`1045`) on re-sign-on, and `SHOW GRANTS` contains no `GRANT OPTION`. |
| 13 | `connection-budget` | PASS | Reads `max_user_connections` from `mysql.user` on real MariaDB (`40` for primary user provisioned via `DB_PROVISION_SCRIPT`, `5` for extra user `qu1`, `10` for sign-on account `pma_<hexA>`, budget `<= 100`), holds `5` concurrent `SELECT SLEEP(60)` connections as `qu1`, and proves a 6th concurrent connection is refused with error `1226`. |
| 14 | `drop-all` | PASS | `dropAll` on site A removes all `SCHEMATA`, `mysql.user`, and `mysql.db` rows under site A's prefix and `pma_<hexA>`, leaves site B's list untouched, and is idempotent (`{}`) on repeat and on a never-used `siteId`. |
| 15 | `server-never-restarted` | PASS | `docker inspect` confirms the MariaDB container kept `State.Running=true`, `RestartCount=0`, and the exact initial `State.StartedAt`. |
| 16 | `no-secrets-in-output` | PASS | Scans `JSON.stringify` of every `adapter.siteDatabases` and `signOnRunner.run` result, every caught error message, and every output line, confirming none of the generated passwords or MariaDB hashes appear. |
| 17 | `cleanup` | PASS | Exact-name removal leaves zero containers, volumes, or networks matching this run's `hp_swarmtest_` prefix. |

**Not covered here.**
- The HTTP routes and the browser screens, which the API and web simulator tests cover.
- phpMyAdmin container hardening, sign-on cookie, and web forwarder, which have their own acceptance report part.
- A real server with real WordPress traffic.
- Sites created before this version, which keep their old unescaped wildcard grant and uncapped primary user until the updater handles them.

## Part 4 — phpMyAdmin (ADR 0021)

**Run:** 2026-11-14 on branch `feat/step-3-6-site-tools-and-admin`, Docker Engine `29.9.2`, Node `v26.13.1`, pinned phpMyAdmin image `phpmyadmin@sha256:e4b3eb5305cd42d21512bb55def2bab52625d56df927ad4ee1864a9354c84d40` and pinned MariaDB image `mariadb:12.3.3` (both already on the machine, never pulled by the check).

**Command:** `corepack pnpm run build && node infra/linux/accept-m2-phpmyadmin.mjs` (plus `HP_ACCEPT_LONG=1 node infra/linux/accept-m2-phpmyadmin.mjs` for step 14)

**Result:** 24 of 24 active steps passed twice in a row (`55.2s` and `53.9s`; second normal run: `accept-m2-phpmyadmin: 24/24 passed in 53.9s`, with `long-statements-keep-their-place` skipped unless `HP_ACCEPT_LONG=1` is set). With `HP_ACCEPT_LONG=1`, all 25 of 25 steps passed (`accept-m2-phpmyadmin: 25/25 passed in 380.3s`). The script exits `0` only when every non-skipped step passes. Every container and network created starts with `hp_swarmtest_` and is removed by exact name in `finally` (including on `SIGINT`/`SIGTERM`), with temporary files placed under `/dev/shm`, spawned child processes (including `next start`) stopped before exit, and no Docker prune command ever run.

Steps 1–18 drive the real executor adapter (`DockerEngineSocketAdapter.siteDatabases`, `ensurePhpMyAdmin`), `ensurePhpMyAdminContainer`, `SiteDatabasesRunner` + `mariadbRootExec`, and `mysqlNativePasswordHash` together with the real panel session module (`apps/web/src/lib/session.ts`) and real forwarder (`apps/web/src/lib/phpmyadmin-forwarder.ts`), served over `127.0.0.1` by a local `node:http` server alongside a stub panel API (`GET` and `POST .../databases/phpmyadmin`), talking to real `mariadb:12.3.3` and locked-down `phpmyadmin` containers. All steps reach phpMyAdmin through the production upstream client (`apps/web/src/lib/phpmyadmin-upstream.ts`), which imposes no time limit of its own on headers or bodies and drains the remainder of an already-started upload if phpMyAdmin answers or closes early. Steps 19–25 then start the real built Next.js panel (`next start --hostname 127.0.0.1 --port <nextPort>` with `NODE_ENV=production`, `API_INTERNAL_URL`, `BFF_SESSION_SECRET`, `HP_PHPMYADMIN_PORT`) against that same stub API and running throw-away phpMyAdmin and MariaDB containers, using `redirect: "manual"` on every HTTP request (plus a no-redirect `curl` navigation request carrying `Sec-Fetch-Mode: navigate`).

| # | Step | Result | What it proves |
|---|---|---|---|
| 1 | `setup` | PASS | Ephemeral ports on `127.0.0.1`, temporary `hp_swarmtest_*` MariaDB container (`mariadb:12.3.3`) with two isolated sites seeded (`siteA` with primary + custom `app` DB, `siteB` with `site_b_secret`), real `session.ts` session cookie, stub panel API (`GET`/`POST .../databases/phpmyadmin`), and `node:http` server running `createPhpMyAdminForwarder`. |
| 2 | `signon-and-ensure` | PASS | Calling `adapter.siteDatabases({ siteId, op: "phpMyAdminSignOn", passwordHash })` via `mysqlNativePasswordHash` ensures the `hp_swarmtest_*` phpMyAdmin container starts and passes HTTP readiness, and seals a real `hp_pma` cookie via `sealPmaCookie`. |
| 3 | `direct-port-unauth` | PASS | Direct `GET` to phpMyAdmin's loopback port without credentials returns HTTP `401` and reveals neither site database prefix. |
| 4 | `no-session-refused` | PASS | Without `hp_session` (even when `hp_pma` is present), a browser navigation gets HTTP `303` to `/login`, an API/XHR call gets HTTP `401`, and phpMyAdmin's Apache access log line count remains unchanged. |
| 5 | `no-pma-cookie-refused` | PASS | With a valid panel `hp_session` but no `hp_pma` cookie, browser navigation redirects (`303`) to `/sites/<siteId>/database`, XHR gets HTTP `401`, and zero requests reach phpMyAdmin's access log. |
| 6 | `login-page-and-headers` | PASS | Missing trailing slash returns `308` to `/phpmyadmin/<siteId>/`; authenticated `GET /phpmyadmin/<siteId>/` returns `200`, strips `www-authenticate`, scopes every `Set-Cookie` to `Path=/phpmyadmin/<siteId>/` with no `Domain=`, hides Apache/MariaDB versions (`ShowServerInfo=false`), emits no blowfish warning, and leaks neither password nor Basic token. |
| 7 | `site-scope-and-isolation` | PASS | Inside the signed-on phpMyAdmin session, `SHOW DATABASES;` shows site A's primary and `app` databases and excludes site B's prefix; site A's table list shows `site_a_tbl`; querying `siteB.site_b_secret` fails at MariaDB (`#1044`/`#1142` access/command denied) without exposing `site-b-confidential`; `POST` collation update returns `302` with `Location` kept under `/phpmyadmin/<siteId>/`. |
| 8 | `cross-site-cookie-refused` | PASS | Presenting site A's `hp_pma` cookie at `/phpmyadmin/<siteB>/` returns `404` and adds zero entries to phpMyAdmin's access log. |
| 9 | `cross-site-post-refused` | PASS | Cross-origin `POST` (`Origin: https://evil.example`, `Sec-Fetch-Site: cross-site`) is rejected with HTTP `403` and adds zero entries to phpMyAdmin's access log. |
| 10 | `wrong-password-clears-cookie` | PASS | A sealed `hp_pma` cookie carrying a wrong DB password returns HTTP `401` without `www-authenticate` and emits `Set-Cookie` clearing `hp_pma` (`Max-Age=0`, `Path=/phpmyadmin/<siteId>/`). |
| 11 | `import-size-limit` | PASS | Uploading a 20 MB SQL comment-only file triggers PHP's `64M` limit (`Fatal error: Allowed memory size of 67108864 bytes exhausted`, HTTP `200`, not forwarder `503`), keeps `State.OOMKilled=false` and `State.StartedAt` unchanged, and leaves site B answering `200` immediately afterwards; the 20 MB batch-`INSERT` SQL file imports all generated rows (`SELECT COUNT(*)` verified) with `State.OOMKilled=false`; a 40 MB upload completes without connection reset and returns phpMyAdmin's `32 MiB` upload-limit error page; and during 4 concurrent 20 MB comment imports for site A (`elapsedMs=15887` / `15812`, all 4 returning `200`), site B still answers `200` within `5 s` (`168 ms` / `188 ms`) while `hp_phpmyadmin` stays `running=true`, `OOMKilled=false`, `restartCount=0`, and identical `StartedAt`. |
| 12 | `concurrent-page-requests` | PASS | Eight parallel `GET /phpmyadmin/<siteId>/` requests under `MaxRequestWorkers 4`, per-site limit `2`, and `MAX_USER_CONNECTIONS 10` all return `200` (`statuses=[200,200,200,200,200,200,200,200]`). |
| 13 | `one-site-two-workers` | PASS | Site A dispatches two slow `SELECT SLEEP(12)` requests whose clients abort after ~1 s followed by two more requests for site A (`SELECT SLEEP(1)`); across `12` polls, `pma_<hexA>` never exceeds `2` running queries in `information_schema.PROCESSLIST`, site B answers `200` within `5 s` (`maxSiteBMs=77` / `76`), container `OOMKilled=false` and `StartedAt` stay unchanged, and site A's subsequent queued requests and final page load succeed (`200`). |
| 14 | `long-statements-keep-their-place` | PASS (`HP_ACCEPT_LONG=1` only; skipped in normal runs) | Run only with `HP_ACCEPT_LONG=1` (skipped when unset in normal runs): Site A runs two `SELECT SLEEP(325)` statements concurrently while `phpmyadmin-upstream.ts` imposes no headers timeout; both remain active in MariaDB past `305s` (`runningAt305=2`, client requests still pending); across `10` samples of a 10 s window, active queries stay capped (`maxRunningWindow=2`), a third site A `SELECT SLEEP(1)` request waits instead of taking a third worker, site B answers `200` within `5 s` (`maxSiteBMs=79`), container `OOMKilled=false` and `StartedAt` stay unchanged; the forwarder returns the `503` waiting page at the `310 s` detach point (`slow1Status=503`, `slow2Status=503`) while both queries keep running to `~325 s`; once they finish (`totalElapsedMs=326104`), the queued third request completes with `200` (`follow3WaitMs=20960`) and a final site A load returns `200` (`70 ms`). |
| 15 | `second-signon-ends-first` | PASS | An active `SELECT SLEEP(30)` TCP session using sign-on #1 appears in `information_schema.PROCESSLIST` and terminates non-zero when a second `phpMyAdminSignOn` call rotates credentials; the old `hp_pma` cookie is subsequently refused with `401`, while a newly sealed `hp_pma` cookie succeeds with `200`. |
| 16 | `network-isolation` | PASS | A separate container on an independent bridge network cannot connect to phpMyAdmin's container IP on port `80` or its bridge gateway `<gateway>:<port>`. |
| 17 | `container-hardening` | PASS | `docker inspect` and mounted MPM config confirm `512 MiB` memory and swap (`536870912`), `MaxRequestWorkers 4`, `MEMORY_LIMIT=64M`, `UPLOAD_LIMIT=32M`, `User="33:33"`, `Privileged=false`, `ReadonlyRootfs=true`, `CapDrop=["ALL"]`, empty `CapAdd`, `SecurityOpt` containing `no-new-privileges:true`, `PidsLimit=100`, `0.5` CPU (`NanoCpus=500000000`), only the 4 designed `tmpfs` mounts (`/sessions`, `/tmp`, `/var/run/apache2`, `/var/www/html/tmp`), only the two `:ro` config bind mounts (`config.inc.php` and `hp-mpm.conf`), `PortBindings` strictly limited to one entry `80/tcp -> 127.0.0.1:<port>`, zero secrets in `Env`, and network membership limited strictly to phpMyAdmin and MariaDB. |
| 18 | `config-change-recreates-cp01` | PASS | Changing the port via `DockerEngineSocketAdapter.ensurePhpMyAdmin()` recreates the container (`Id` changes), and changing configuration text (`dbHost` via `ensurePhpMyAdminContainer`) recreates it again with the updated `/etc/phpmyadmin/config.inc.php` serving `200` through the forwarder, while the `hp_swarmtest_*` MariaDB container keeps the exact same `Id`, `State.StartedAt`, and `RestartCount` (CP-01). |
| 19 | `next-signon` | PASS | Starts real built `next start` (`NODE_ENV=production`) on `127.0.0.1` pointed at the stub API and throw-away phpMyAdmin container, and calls `POST /api/bff/orgs/<orgId>/managed-sites/<siteId>/databases/phpmyadmin` (`redirect: "manual"`, `hp_session`, `Origin`, `X-CSRF-Token`); receives `200` `{ data: { url: "/phpmyadmin/<siteA>/" } }` without credentials in the body and `Set-Cookie: hp_pma=...` with `Path=/phpmyadmin/<siteA>/`, `HttpOnly`, and `SameSite=Strict`. |
| 20 | `next-phpmyadmin-open` | PASS | `GET /phpmyadmin/<siteA>/` through real `next start` (`redirect: "manual"`, with `hp_session` and the BFF-issued `hp_pma` cookie) answers `200` directly with phpMyAdmin's HTML listing site A's primary (`wp_<hexA>`) and custom (`wp_<hexA>_app`) databases, excluding site B (`wp_<hexB>`), without leaking the sign-on password, and scoping `Set-Cookie` to `Path=/phpmyadmin/<siteA>/` with no `Domain=`. |
| 21 | `next-trailing-slash-no-loop` | PASS | `GET /phpmyadmin/<siteA>` (no slash) through real `next start` (`redirect: "manual"`) returns exactly one `308` (`Location: /phpmyadmin/<siteA>/`), and following it with both cookies answers `200` (`2` hops total, zero redirect loop) showing site A's databases and excluding site B. |
| 22 | `next-no-session-refused` | PASS | `GET /phpmyadmin/<siteA>/` through real `next start` without `hp_session` (even with `hp_pma`) returns `401` on `fetch` (`redirect: "manual"`, `sec-fetch-mode: cors`) and `303` (`Location: /login`) on browser navigation (`Accept: text/html`, `Sec-Fetch-Mode: navigate`), with empty body (zero phpMyAdmin content) and zero entries added to phpMyAdmin's access log. |
| 23 | `next-phpmyadmin-static-asset` | PASS | Fetching the static asset extracted from the page (`/phpmyadmin/<siteA>/themes/pmahomme/jquery/jquery-ui.css`) through real `next start` (`redirect: "manual"`) returns `200` (`Content-Type: text/css`, `36566` bytes). |
| 24 | `next-panel-trailing-slash` | PASS | `GET /login/` through real `next start` (`redirect: "manual"`) answers `200` directly with zero redirects (`Location: null`) and renders the panel login form HTML, confirming `skipTrailingSlashRedirect: true` does not break normal panel pages. |
| 25 | `next-frame-headers` | PASS | `GET /login` through real `next start` carries `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`, whereas forwarded `GET /phpmyadmin/<siteA>/` carries phpMyAdmin's own upstream `X-Frame-Options: DENY` and upstream `Content-Security-Policy` (`default-src 'self' ...`) unchanged without the panel's `frame-ancestors 'none'`. |

**What is proved on the real Next.js server.**
- The real BFF sign-on route (`POST /api/bff/orgs/.../databases/phpmyadmin`), `hp_pma` cookie scoping (`Path=/phpmyadmin/<siteId>/`), `/phpmyadmin/<siteId>` -> `/phpmyadmin/<siteId>/` single-`308` redirect without a Next.js trailing-slash loop, authenticated `200` rendering and static asset delivery through `/phpmyadmin/<siteId>/`, refusal when `hp_session` is missing, `/login/` trailing-slash rendering (`200` directly), and R39 frame header separation all work end-to-end under `next start`.

**Not covered here.**
- No real browser is driven (requests use Node `fetch(..., { redirect: "manual" })` and `curl` against `127.0.0.1`; clicking "Open phpMyAdmin" in the React Database tab UI and browser DOM/cookie-jar execution are not exercised here).
- No real Traefik ingress proxy or HTTPS termination sits in front of `next start`, so the ingress proxy's 60-second upload/read timeout and TLS termination are not exercised.
- The panel API behind `next start` is the script's loopback stub (`GET` and `POST .../databases/phpmyadmin` backed by `SiteDatabasesRunner` against the throw-away MariaDB container), not the full NestJS + PostgreSQL `apps/api` server.
- Steps 11 (`import-size-limit`, 40 MB refusal) and 14 (`long-statements-keep-their-place`, >300s statements) are exercised against the loopback `node:http` server wrapping `createPhpMyAdminForwarder` rather than through `next start` (though both paths share `createPhpMyAdminForwarder` and `fetchPhpMyAdminUpstream`).

## Part 5 — Backups (ADR 0022)

**Run:** 2026-11-15 (cycle 5 M3b restore & download, after fix round 2) on branch `feat/step-3-6-site-tools-and-admin`, Docker Engine `29.9.2`, Node `v26.13.1`, pinned images already present on the host (never pulled by the check, `pullMissingImages: false`): `restic/restic:0.19.1` (`sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510`), `rustfs/rustfs:1.0.5` (`sha256:b81d16a90ee25bd9511280127ca1471788c6e874cf0f0da759645f46b2dc1d74`), `mariadb:12.3.3` (`sha256:4ebbcf100a3ba320766dfa0e1af008df12261301db6ef72798c7650f70794aed`), and `wordpress:7.1.4-php8.4-apache` (`sha256:63dbbdf2c9ea29a2e4f417c0d4e7c4b821725d115127f70838dbbc5051ee4db0`).

**Command:** `timeout 900 node infra/linux/accept-m3-backups.mjs` (driven against built `apps/docker-executor/dist/index.js` and `packages/contracts/dist/index.js`)

**Result:** 28 of 28 steps passed in the last two runs (`accept-m3-backups: 28/28 passed in 223.4s`, exit `0`; `accept-m3-backups: 28/28 passed in 224.1s`, exit `0`). Six runs were made in a row for the new switch step (`restore-switch-refuses-name-added-after-prepare`); it passed in all of them. One of those runs ended 27/28: `restart-in-flight-cleanup-and-recovery` failed once with `DOCKER_ENGINE_UNAVAILABLE` (`Failed to remove previous container instance (HTTP 409)`). That is the known rare race in `stopAndRemoveContainer`: the second adapter's `cleanupOrphanJobs` removes a backup container while Docker is still removing it. It has nothing to do with restore. It was fixed after these runs (`R108`): after a `409` the adapter looks again every 100 ms for up to 5 seconds and fails only when the container is still there after that time. The run on the tree with that fix passed 28 of 28 steps (`accept-m3-backups: 28/28 passed in 225.6s`, exit `0`). In the two 28/28 runs named first:
- **Measured `restore-full` maintenance-gate window (100 ms HTTP polling):** longest `503` run was `1213 ms` (`13` consecutive `503` answers across `64` polls) and `1216 ms` (`13` across `64` polls). Every poll returned `200` or `503`, never broken markers after the first `503`, and `200` with the original markers and the intact `hp-mail.php` mount at the first `succeeded` status (`R79`).
- **Measured archive zip size and preparation time (`download-archive`):** `12592800 bytes` in `2106 ms` and `12592801 bytes` in `2105 ms`, stored outside the site volume in `0700` `<backupWorkDir>/archives/<jobId>.zip` owned by the executor UID (`R78`).
- **Real WordPress maintenance gate (`gate-is-wordpress-own`):** `302` → `503` after writing `RESTORE_MAINTENANCE_FILE_CONTENT` into `/var/www/html/.maintenance` as `33:33` → `302` after removing it, in both runs.
- **Object-name log lines:** every refused name produced exactly one `restore_invalid_object_name` record with `step` (`prepare` or `switch`), `objectKind` and `database` only; the hostile name never appears in any log or container output.
- **Isolation & cleanup:** the RustFS secret key holds `#` and `;`. Every harness container, network and volume starts with `hp_swarmtest_` (plus `hp_vol_svc_swarmtest_<hex>_html`); adapter objects start with `hp_bk_`. No host port is published; keys, work and shared-DB dirs live under `/dev/shm`; everything is removed by exact name, never with `docker system prune`. Docker queries for `hp_swarmtest` and `hp_bk_` and `ls /dev/shm/hp_swarmtest_*` were empty after the runs.

**Rules of the restore database script (`RESTORE_DB_SCRIPT` in `apps/docker-executor/src/restore-jobs.ts`):**
- Object names are quoted only by the database server: doubled backticks, `EXECUTE IMMEDIATE`, a rename file the server writes, and `--` before any name argument. The shell never builds a quoted name itself.
- A database object name holding a control character or a backslash is refused with exit `84` (`RESTORE_EXIT_INVALID_OBJECT_NAME`). It is `restore_prepare_failed` in prepare, `switch_undone` at the start of the switch (the switch checks again, so a name added after prepare is caught), and `undo_incomplete` in the undo. The executor logs `restore_invalid_object_name` with the step (`prepare`, `switch` or `undo`), the object kind and the database only.
- The undo touches `.maintenance` only after `gate_recorded`, and puts WordPress's own `.maintenance` back byte-identical from a copy that never follows a link. A failure before the switch never shows `503`.
- Only trigger headers lose the site's own database qualifier, and only on the trigger name and on the table after `ON`. Bodies, string literals, views, routines and events stay as the dump wrote them. A trigger header the restore cannot read refuses the restore in prepare (`restore_prepare_failed`, logged as kind `TRIGGER`) before the site is touched.
  - Header forms that `mariadb-dump` from `mariadb:12.3.3` writes and the restore accepts: `IF NOT EXISTS` with any whitespace; unquoted names with non-ASCII (UTF-8) bytes; backtick and double-quote (`ANSI_QUOTES`) names; no whitespace next to a quoted name (``TRIGGER`db`.`tr`BEFORE DELETE ON`db`.`t`FOR``); any keyword case (`trigger … after delete on … for`); any whitespace or line break between words; whitespace around the dot. The own qualifier is removed whether it is unquoted, in backticks or in double quotes.
  - Header forms that still refuse the restore: a comment inside the header (the dump keeps one only when the client sent it with `--comments`); another database's qualifier; a header cut off at the end of the file; a `/*!50003 CREATE*/` line without the `TRIGGER` keyword; any other shape.

**R92:** every replay of customer text runs with `mariadb --sandbox --binary-mode`. The 30-case probe contained 29 cases. The 30th is a hand-written dump replayed as root, which breaks out; it is deferred to M6 (replay with an account limited to the site's databases). A customer cannot reach it, because `mariadb-dump` writes the dump.

**Evidence and red runs.** Fix round 1 added eight steps (rows 11, 14, 17, 18, 20, 21, 22, 23); each would be red on the tree before fix round 1, judged by reading the old script. No red run of these steps is on record, and none was produced: no fix is switched off in the tree to get one. Fix round 2 added one step (row 19) and two triggers to row 21. They were not seen red in a script run either: row 19 would need the switch's check switched off. What was seen red, outside the script:
- The trigger-header parser: the unit test `restore-jobs strip_db_qual (R88/R91)` failed 5 cases on the old parser (`IF NOT EXISTS` with a non-ASCII name, no-space quoted names, lower-case keywords, line breaks around the dot, a `CREATE` line without `TRIGGER`), and the old parser run inside `mariadb:12.3.3` on a real dump exited `3` on `IF NOT EXISTS`, a non-ASCII name and a no-space name. It also passed a lower-case header through unchanged, and a replay of that output re-created the trigger in the live database. All are green now.
- The undo log line: the unit test `logs RESTORE_EXIT_INVALID_OBJECT_NAME from the undo's database step and keeps undo_incomplete (R101)` failed on the old runner and passes now.

| # | Check | Outcome |
| --- | --- | --- |
| 1 | `setup` — isolated bridge network, RustFS 1.0.5 (`#`/`;` secret key, bucket and read-only user), MariaDB 12.3.3, PHP 8.4 stand-in site on a local volume (`hp-mail.php:ro`, 2 databases with FK tables, trigger and view), restic key files under `/dev/shm` | PASS |
| 2 | `connection-test-ok` — `testConnection` creates and checks the repository under the prefix within 30 s: `{ outcome: "ok", problem: null }` | PASS |
| 3 | `connection-test-failures` — 7 failure modes settle within 30 s with the exact R55 codes | PASS |
| 4 | `backup-and-list-copy` — site files and 2 databases backed up; 64-hex snapshot id; an independent `restic` listing finds the marker file and one dump per database | PASS |
| 5 | `bucket-ciphertext-only` — every bucket object downloaded; file marker, row markers and database names appear 0 times (with a negative control) | PASS |
| 6 | `second-backup-dedup` — a second backup gives a new snapshot id with fewer bytes added | PASS |
| 7 | `forget-snapshot-and-idempotent-repeat` — forgetting a snapshot removes one snapshot object; forgetting it again still succeeds | PASS |
| 8 | `restore-full` — deleted, changed and extra files, changed rows, dropped table, view and trigger all come back byte-for-byte and DDL-for-DDL; `hp-mail.php:ro` intact; no `.maintenance` at `succeeded`; `503` window measured | PASS |
| 9 | `restore-mounts-as-ruled` — all 5 `_rs_*` containers are named `hp_bk_<jobId>_rs_*`, mount no `docker.sock`, `_rs_prepare` mounts no site volume, dumps land only in staging (R77) | PASS |
| 10 | `restore-fails-before-switch` — `definer_missing` in prepare: broken state kept, site stays `200`, never `503` (R89) | PASS |
| 11 | `restore-pre-switch-keeps-wp-maintenance` — a failure before the switch keeps a WordPress `.maintenance` byte-identical (R89) | PASS |
| 12 | `restore-fails-inside-switch` — a lock wait over `BACKUP_RESTORE_LOCK_WAIT_S` settles as `failed`/`switch_undone`, site back to `200`, broken files and databases exactly as before, no temp schemas or dirs | PASS |
| 13 | `restore-interrupted-settled-at-start` — executor child `SIGKILL`ed mid-switch; a fresh start (`cleanupOrphanJobs` → `settleRestores` → `emptyArchives`) settles `failed`/`switch_undone`, removes `.maintenance` and every orphan; settling a prepare-stage note never shows `503` (R89) | PASS |
| 14 | `restore-prepare-settle-never-503` — every poll during the prepare-stage settle of row 13 answered `200` (R89) | PASS |
| 15 | `download-archive` — a real zip (~12.6 MB) read in ≤ 512 KiB chunks, `unzip -t` and file hashes, `0700` archive dir, single-archive replacement, `discardArchive`, `archive_gone` | PASS |
| 16 | `gate-is-wordpress-own` — real WordPress answers `302`, `503` with the product's `.maintenance`, `302` after removal | PASS |
| 17 | `restore-hostile-object-names` — names with backticks, quotes, `;`, `$(id)`, a leading `-` and `CREATE DATABASE` payloads, in the copy and in the live database, restore cleanly; canary, databases, users and grants untouched (R88) | PASS |
| 18 | `restore-refuses-newline-and-backslash-names` — a name with a newline or a backslash, in the live database or in the copy, is refused with exit `84` in prepare (`restore_prepare_failed`); site and databases untouched; the name is in no log (R88) | PASS |
| 19 | `restore-switch-refuses-name-added-after-prepare` — a newline-named live table created after prepare's check and before the switch container exists: the switch container itself exits `84`, the restore ends `failed`/`switch_undone`, the site gives `200` with the same body, the table is still there, the name is in no log, nothing left over (R102) | PASS |
| 20 | `restore-switch-failure-keeps-wp-maintenance` — real WordPress with a 20-minute-old `.maintenance` (`200`) keeps the file byte-identical and stays `200` after `switch_undone` (R90) | PASS |
| 21 | `restore-db-qualified-objects-from-backup` — a dump with own-database-qualified triggers, view, routine and event, plus a row holding the database name as text, restores once and works: the row text is unchanged, and the triggers written `IF NOT EXISTS db.tr_é` and ``TRIGGER`db`.`tr`AFTER DELETE ON`db`.`t`FOR`` exist under their own names and fire (R91, R100) | PASS |
| 22 | `restore-failed-prepare-leaves-live-untouched` — a prepare failure leaves the live tables, views, triggers, routines, events and rows unchanged (R91) | PASS |
| 23 | `restore-db-qualifier-injection-refused` — names holding `<db>.` keep their quotes, no database or user is injected; a trigger header with a comment inside refuses the restore in prepare (exit `84`, kind `TRIGGER`), live untouched (R88, R91) | PASS |
| 24 | `restart-in-flight-cleanup-and-recovery` — a second adapter's `cleanupOrphanJobs()` removes the in-flight backup container, staging volume and secrets dir (`unknown`); a stale `locks/` object after `SIGKILL` is cleared and the next backup succeeds | PASS |
| 25 | `cp01-site-and-db-untouched` — site and MariaDB containers keep id, `StartedAt`, `RestartCount` and zero exec ids through every backup and restore (CP-01) | PASS |
| 26 | `no-secrets-in-containers-or-outputs` — every `hp_bk_*` container, result, error, stdout and restore note holds no secret (with a negative control) | PASS |
| 27 | `hostile-requests-refused` — malformed requests to every action throw `VALIDATION_ERROR` before any container is created | PASS |
| 28 | `cleanup` — harness containers, volumes, network, `/dev/shm` dir and adapter `hp_bk_*` objects all absent | PASS |

**Covered by automated tests, not by this run:**
- Retention expiry of old backups while keeping the newest good backup (`apps/api/test/backup-retention.unit.test.ts` `R1`, `R2`; `apps/api/test/site-backups.integration.test.ts` `T13 & prune`).
- Manual backup cap keeping 3 newest manual backups (`MANUAL_BACKUPS_KEPT = 3`, unit-tested via `selectExpired` in `apps/api/test/backup-retention.unit.test.ts` `R4`; no HTTP integration test executes 4 sequential manual `POST .../backups` requests end-to-end).
- Deletion of backups belonging to a deleted site (`apps/api/test/backup-retention.unit.test.ts` `R3`; `apps/api/test/site-backups.integration.test.ts` `T13 & prune`; `apps/api/test/admin-backups.integration.test.ts` `T12`, `T14`).
- Interrupted backup recovery (`unknown` status settling as `failed`/`interrupted` in `apps/api/test/site-backups.integration.test.ts` `T11`, plus `POST .../sites/:siteId/run` in `apps/api/test/admin-backups.integration.test.ts` `T14`; an immediate retry on the same site after `T11`'s `interrupted` record is not chained in a single integration test).
- Secret redaction from audit events and outbox records (`apps/api/test/site-backups.integration.test.ts` `T7`; `apps/api/test/admin-backups.integration.test.ts` `T1`, `T3`, `T14`; `apps/api/test/site-restore-applier.integration.test.ts`).
- Platform capability flag `productionBackupRuntimeAvailable` true only on `linux-systemd` (`packages/contracts/test/contracts.test.ts` `isBackupAvailable` / `createPlatformCapabilities`; `apps/api/test/site-backups.integration.test.ts` `T9`; `apps/api/test/admin-backups.integration.test.ts` `T9`).
- Note on `/etc/hosting-panel/backup.key` provisioning: `infra/linux/install.test.ts` and `apps/api/test/infra-layout.test.ts` verify `bootstrap-dedicated.sh --dry-run` output and script text, not live execution of the `BACKUP_KEY_PATH` (`0440 root:hp-executor`, create-once) provisioning block on a host.
- Restore undo edge cases (`undo_incomplete` freeze & R80 cleanup on later succeeded restore, crash recovery across every restore note stage including `stage: "switched"` -> `succeeded` and corrupt/unreadable notes, E14 step hard timeouts killing hung containers, exit-code tables and `RESTORE_FETCH_SCRIPT` / `RESTORE_PREPARE_SCRIPT` / `ARCHIVE_SCRIPT` / `RESTORE_FINISH_EXIT_CODES` R79 classification, `ARCHIVE_TTL` 60-minute expiry & `emptyArchives`): covered in `apps/docker-executor/test/restore-runner.test.ts` (`handles switch and files failures (including 124 and create error) via ordered undo, and freezes leftovers on undo_incomplete`; `enforces R79 on _rs_finish and R80 cleanup of same-site undo_incomplete leftovers on later succeeded restore`; `settles all crash note stages at start, honors TTL & R80 retention, keeps noted volumes in removeOrphans, and guards corrupt/unreadable notes`; `enforces E14 step timeouts and kills hung containers at their exact step budget`; `handles full archive lifecycle: build zip, 0700 dir, chunked reads < 1 MiB, replacement, expiry, discard, failures, and emptyArchives`) and `apps/docker-executor/test/restore-jobs.test.ts` (`exports E14 time limits and unique named exit codes`; `classifies _rs_fetch and _zip exits`; `classifies _rs_prepare, _rs_switch, _rs_files, _rs_undo, and _rs_finish per R79`).
- `no_space` pre-flight refusal on full staging / MariaDB disk (`errno 28` -> exit `75` -> `no_space`, `statfs` floor check): covered in `apps/docker-executor/test/backup-jobs.test.ts`, `apps/docker-executor/test/backup-runner.test.ts`, and `apps/docker-executor/test/restore-runner.test.ts` (`handles pre-switch failures (_rs_fetch, MariaDB disk space, _rs_prepare) by running _rs_undo_db and keeping failure class`).
- Post-restore WordPress URL update (`wordpress.set-url`) and `address_not_updated` handling, recovery of `unknown` restore/download operations via `settle`, retention `discardArchive` cleanup, and customer confirmation (`confirmName`), E11 6/hr heavy-action rate limit, tenancy/RBAC/suspended-org guards, and audit logging: covered in `apps/api/test/site-restore-applier.integration.test.ts` (`applies a restore that succeeds, runs wordpress.set-url with previous and current URLs, settles row/steps/op, and writes one system audit`; `keeps restore succeeded with address_not_updated when wordpress.set-url fails or throws`; `recovers unknown restore ops via settle without calling restore again (running -> pending -> succeeded, unknown -> interrupted)`; `retention discards archives of deleted/forgotten rows once and ignores discardArchive errors`) and `apps/api/test/site-restore-routes.integration.test.ts` (`enforces exact check order on POST restore and POST download (404 -> 422 -> 400 not_configured -> 409 not_ready -> confirmName)`; `POST download queues prepare, reuses active preparing/ready archives, clears peer archive state, and rejects wrong-backup replay`; `GET download enforces strict query, streams real simulator archive chunks with EOCD, audits offset=0 only, handles expiry and executor gone`; `enforces auth, cross-tenant 404, collaborator 403 + denied audit, and suspended org 403 on all 3 new routes`; `enforces E11 limit of 6 customer heavy actions per site per hour, preserves rollback/replays/admin/nightly/other-site, and allows again after window`).

**Not covered:**
- End-to-end execution of `wordpress.set-url` (`wp-cli` search-replace) against a real WordPress site container after a restore onto a changed site URL (`site-restore-applier.integration.test.ts` exercises a mocked executor `runSiteJob` call rather than a real container).
- Full browser download through Next.js BFF + Traefik TLS ingress streaming a multi-chunk archive zip end-to-end (`site-restore-routes.integration.test.ts` verifies chunked streaming at the Fastify API layer).
- Real systemd service restart recovery of the executor daemon process (`accept-m3-backups.mjs` drives `cleanupOrphanJobs()` -> `settleRestores()` -> `emptyArchives()` in-process after `SIGKILL` of a Node child worker rather than via `systemctl restart hp-executor`).
- Live triggering of `no_space`, E14 step hard timeouts (`120s`/`60s`/`300s`), `BACKUP_ARCHIVE_TTL_MS` 60-minute clock expiry, and `undo_incomplete` freeze against the real Docker Engine (covered in unit tests above).
- A container removal that is still running after 5 seconds. Since `R108`, `stopAndRemoveContainer` (`apps/docker-executor/src/docker-engine-adapter.ts`) waits that long after Docker's `409` for an overlapping removal to finish; a removal that takes longer still ends with `DOCKER_ENGINE_UNAVAILABLE`. The wait is covered by two unit tests in `apps/docker-executor/test/docker-executor.test.ts`. The race failed `restart-in-flight-cleanup-and-recovery` in one of seven real-Docker runs before the fix; the one run made after the fix passed, which cannot prove a rare race gone.
- The 30th R92 probe case (a hand-written dump replayed as root) is deferred to M6; see R92 above.
- The undo's own refusal of a bad name (exit `84` in the undo, logged with `step: "undo"`) is covered by `apps/docker-executor/test/restore-runner.test.ts` only; a real-Docker run would need the switch's check to let the name through first.

## Part 6 — Panel copy and the way back (ADR 0022)

**Run:** 2026-11-15 (cycle 6 M3c, phase qa-c6) on branch `feat/step-3-6-site-tools-and-admin`, Docker Engine `29.9.2`, Node `v26.13.1`. The images were already on the host and the check pulled nothing (`pullMissingImages: false`): `postgres:18-bookworm` (PostgreSQL `18.7-1.pgdg12+2`, `sha256:ece55f7868da684e400f82f1030a050718adbdd65c23aa500c486f6e2950dc0f`), `busybox:latest` (`sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4`, used only to set the owner of the hand-over folder), plus the restic, RustFS, MariaDB and WordPress images pinned in Part 5.

**Command:** `timeout 1500 node infra/linux/accept-m3-panel.mjs`. It drives the built `apps/docker-executor/dist`, `packages/contracts/dist` and `apps/api/dist/backups/panel-dump.js`.

**Result:** 11 of 11 steps passed in three runs in a row: `RESULT 11/11 passed in 77s`, `76s` and `76s`, each with exit `0`. The second and third runs (16:08:02 → 16:09:18 and 16:09:18 → 16:10:34) ran on the final script. The first run ran on the script before two lint-only edits. An earlier trial run ended 10/11 because of a bug in the script itself (it compared labels in key order); the script now compares them sorted. The check builds a real `hosting_panel` database from `packages/database/migrations` in one Postgres container. It runs the product's own `pg_dump` command against it, then stores the copy with the executor's `panelStart` job in RustFS. It fetches the copy back with the shipped `panel-fetch` CLI and restores it into an empty second Postgres container. It then runs `infra/linux/hp-restore-panel.sql` there and brings back a site of which nothing was left. `pg_dump`, `pg_restore`, `psql`, `dropdb` and `createdb` ran only inside the check's own Postgres containers, never on the host. Those containers have their data on tmpfs, run with `--user 1000:1000`, `--cap-drop ALL` and `--network none`, and use `--auth-host=scram-sha-256`. The arguments were:
- `pg_dump`: exactly the product's `buildPanelDumpCommand` output, `/usr/lib/postgresql/18/bin/pg_dump --format=custom --compress=none --no-password --file <hand-over>/<jobId>.dump`. It ran with `docker exec -u 4001:30` under `umask 027`. Its environment (`LC_ALL, PGCONNECT_TIMEOUT, PGAPPNAME, PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE`) came from a `0600` env file, so no password was on the command line.
- `dropdb -U postgres --force --if-exists hosting_panel`, then `createdb -U postgres -O hosting_panel hosting_panel`, then `pg_restore -U postgres --dbname=hosting_panel --role=hosting_panel --no-owner --exit-on-error` with the fetched dump on stdin.
- `psql -X -q -v ON_ERROR_STOP=1 --single-transaction -U postgres -d hosting_panel -f -` with `hp-restore-panel.sql` on stdin, run twice.

**Re-run after R121 (phase eng-c6-fixup1, 2026-11-15, same engine, images and Node):** `pg_restore` and `hp-restore-panel.sql` now connect the way `restore-panel.sh` does: `pg_restore --dbname=hosting_panel --no-owner --exit-on-error -h 127.0.0.1 -U hosting_panel` and `psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d hosting_panel -f - -h 127.0.0.1 -U hosting_panel`, through `docker exec -e PGPASSWORD`, so the password of `hosting_panel` is only in the environment of the `docker` child, never in an argument; no `--role`. `dropdb` and `createdb` stay as `postgres`. A new step `panel-restore-hostile-copy` was added. Result: 12 of 12 steps passed in three runs in a row with `timeout 900 node infra/linux/accept-m3-panel.mjs`: `RESULT 12/12 passed in 80s`, `81s` and `80s`, each with exit `0`. `pg_restore` into the empty database (drop, create, restore) took `329`, `357` and `348 ms` for `35` tables; the site restore with `createVolume` took `6814`, `6411` and `6211 ms`. The table below is the re-run's; the measurements below are qa-c6's.

**Re-run after R123 (phase eng-c6-fixup2, 2026-11-15, same engine, images and Node, `dist` not rebuilt):** a new step `panel-count-hostile-copy` (row 10) was added after `panel-restore-hostile-copy`. Result: 13 of 13 steps passed in three runs in a row with `timeout 900 node infra/linux/accept-m3-panel.mjs` (17:25 → 17:29): `RESULT 13/13 passed in 79s`, `78s` and `78s`, each with exit `0`. Rows 1–9 and 11–13 are unchanged from the R121 re-run.

Measured in the three runs:
- Dump: `130`, `110` and `111 ms` for `94227`, `94217` and `94227` bytes (the size changes by a few bytes with the random seed).
- Copy job (`panelStart` until `succeeded`): `6017`, `5617` and `5612 ms`. The snapshot holds `fileCount 2` (the dump plus the 64-byte `masterKey` file) and `totalBytes` equal to the dump size + 64 (`94291`, `94281`, `94291`). The restic part took `707`, `716` and `697 ms`.
- Bucket after the copy: `6` objects and `17261`, `17263` and `17258` bytes. That is less than the dump, which is consistent with restic compressing the data.
- `pg_restore` into the empty database (drop, create, restore): `313`, `307` and `318 ms` for `35` tables.
- Site restore with `createVolume`: `6208`, `6607` and `6212 ms`. The whole site step took `22481`, `22958` and `22811 ms`.

| # | Step | Result | What it proves |
|---|------|--------|----------------|
| 1 | `setup` | PASS | Network on a free `/24`, RustFS on tmpfs with no port, two Postgres 18 containers, MariaDB from `buildSharedDatabaseContainerPayload`, and a hand-over folder `root:30` `2770`, all named `hp_swarmtest_*`, with no host port. |
| 2 | `panel-db-real-schema` | PASS | Every migration applies to a real PostgreSQL 18 as the product's runner applies them, and the seed rows hold a marker and an awkward value (single and double quotes, backslashes, `$$`, `;--`, a tab, a line break, `ü€`). |
| 3 | `panel-dump-product-args` | PASS | The product's `pg_dump` command, run as `4001:30`, writes a `PGDMP` file `0640` owned `4001:30` that holds the marker. A wrong password exits non-zero and leaves no usable file. |
| 4 | `panel-copy-stored` | PASS | `panelStart` (retention 30) stores the dump and the key in one snapshot. Neither the bucket nor any job container (Env, Cmd, Labels) holds the marker in clear, the master key (hex or raw), the S3 secret or the backup key. The key reaches the upload container only as a read-only mount from `job_bk_mk_<job>`, with `GroupAdd ["30"]` and no `docker.sock`. The secret folders are gone afterwards, no `hp_bk_` object is left, and the dump on disk is unchanged. |
| 5 | `panel-copy-refusals` | PASS | A missing dump, a symlink and a non-`PGDMP` file give `panel_dump_missing` with no container and no new snapshot. A second panel job while one runs gets `RESOURCE_LOCKED`. The same job id again gives the same status, one upload container and one new snapshot. Six hostile requests get `VALIDATION_ERROR` before any Docker call. |
| 6 | `panel-fetch-byte-for-byte` | PASS | The shipped `panel-fetch` CLI, with the S3 keys on stdin only, returns the dump byte for byte (sha256 equal), and `restore.key` equals the master key. Both files are `0600` and the snapshot is the job's. Bad stdin exits `2`, a wrong backup key `5`, wrong S3 keys `3` and an empty prefix `4`, and each leaves no file behind. |
| 7 | `panel-restore-into-empty` | PASS | The fetched dump restores as `hosting_panel` over TCP (no superuser, no `--role`) into an empty server whose old database is replaced. Row count and md5 of all 35 tables match the source, every object in `public` is owned by `hosting_panel`, `schema_migrations` is equal and the awkward value is equal in hex. The install's migration reader works on the copy and detects an unknown migration in a probe database. |
| 8 | `panel-sql-leaves-nothing-unfinished` | PASS | `hp-restore-panel.sql`, run as `hosting_panel` over TCP, sets every unfinished operation, step, outbox event, quota reservation, backup, restore, archive and site to its documented end state, with nothing left open. A second run changes nothing, and finished rows stay byte-equal. |
| 9 | `panel-restore-hostile-copy` | PASS | A copy made in a throw-away database holds a table with one row and a `CHECK` that calls a PL/pgSQL function doing `RESET ROLE` and then `COPY (SELECT 1) TO PROGRAM 'touch <file>'`, so the function runs while the rows load. Control: loaded the old way (`-U postgres --role=hosting_panel`) the file appears inside the container. Loaded the product's way `pg_restore` fails with "permission denied to COPY to or from an external program" (`pg_execute_server_program`) and the file does not appear. An expression index, as R121 first named, cannot carry this: PostgreSQL 18 refused `RESET` in the IMMUTABLE function an index needs ("RESET is not allowed in a non-volatile function"), in a probe container removed afterwards. |
| 10 | `panel-count-hostile-copy` | PASS | The site count of a second run of `hp-restore-panel` reads only the panel user's table. A copy is made in a throw-away database owned by `hosting_panel`, by `hosting_panel` itself (only an owner's rights): a real `public.sites` with two rows, a schema `postgres` (the name of the container's superuser), a VOLATILE PL/pgSQL function there doing `COPY (SELECT 1) TO PROGRAM 'touch <file>'`, and a view `postgres.sites` that calls it. The product's way loads it without error. The product's count (`SELECT count(*) FROM public.sites` as `hosting_panel` over TCP) answers `2` and the file does not appear. Control: the old count (unqualified `sites` as `postgres`, whose search path starts with `"$user"`) makes the file appear inside the container. |
| 11 | `panel-keep-rule` | PASS | Keep rule for retention 30: copies aged 1/3/5/10/20/40 days keep the newest plus 1/3/5 days. Copies aged 30/60/90/120 keep 0/30/60. `fetchPanelCopy` returns the newest copy. |
| 12 | `site-back-from-nothing` | PASS | After the site's container, files volume and database are removed, `siteState` answers `false/false`. A restore without `createVolume` fails `restore_prepare_failed` and creates nothing. With `createVolume` and an unknown snapshot it fails and removes the volume it made. With `createVolume` it succeeds: same labels, root `33:33` `755`, the page answers `200` with the marker, and a plain restore after that still succeeds. The start times of the other containers do not change. |
| 13 | `nothing-left` | PASS | After the run (also on a signal), no `hp_swarmtest_*` or job `hp_bk_*` container, volume or network and no `/dev/shm/hp_swarmtest_*` folder is left. |

**How each key step can fail:**
- Step 3: a change to `buildPanelDumpCommand` (format, `--no-password`, env keys), to the hand-over group or to the umask gives a file the executor cannot read or a non-`PGDMP` file.
- Step 6: a key on the command line or in the environment, a leftover `restore.pgdump`/`restore.key` after a failure, or a wrong exit-code mapping makes `hp-restore-panel` tell the operator the wrong thing.
- Step 7: an object owned by `postgres`, an object the non-superuser `hosting_panel` may not create (an extension, a foreign owner), or a type `pg_restore` cannot create stops the restore under `--exit-on-error`, or changes rows.
- Step 8: a new state the SQL file does not know (a new operation or backup status), or a statement that is not idempotent, leaves something "running" for ever or changes finished rows on the second run.
- Step 9: a load that connects as a superuser (with or without `--role`) runs the copy's program: the control half shows it would.
- Step 10: a count that connects as a superuser runs the copy's program, with or without `public.`: the control half shows it would.
- Step 12: a restore that creates a volume without the product labels, owner or mode, or that removes a volume it did not create, gives a site that does not start or loses data.

**Test set-up differs from production here:**
- The CLI ran through a small wrapper that injects `createAdapter`. Its default uses `/run/hosting-panel/secrets` and `hp_backup_net`, which the check may not touch.
- The site's database was made with SQL through `mariadbRootExec` instead of `db.provision`, because the product uses the fixed `hp_mariadb_net`.
- "Deploy" was a `php -S` stand-in container serving a mysqli page and `marker.txt`, because the `wordpress:cli` image is not on the host and nothing may be pulled.
- "The newest copy wins" and "counted from now" cannot be told apart, because `panelStart` always makes the newest copy.
- Before the run, a scratch container `hp_swarmtest_schema_pg` was used once to read the schema. It was removed by exact name.

**Clean-up proof:** after the third run of the R123 re-run (17:29) `docker ps -a`, `docker volume ls` and `docker network ls` filtered on `hp_swarmtest` and on `hp_bk_` were empty and `/dev/shm/hp_swarmtest_*` found nothing. After the third run of the R121 re-run the same filters were empty again and `/dev/shm/hp_swarmtest_*` found nothing. After the third qa-c6 run, `docker ps -a`, `docker volume ls` and `docker network ls` filtered on `hp_swarmtest` and on `hp_bk_` were empty, and `ls -d /dev/shm/hp_swarmtest_*` found nothing. `docker ps -a` listed the same 61 containers, with the same names and ages, before the runs (15:46) and after them (16:10). No product leftover was found, so none was removed.

**Secrets in logs (block A3, R113):** `apps/docker-executor/test/panel-secrets-qa.test.ts` passes 28 of 28 tests. It covers seven runner paths: success, dump missing, symlink, wrong key, storage unreachable, the keep step failing, and an engine `500` that echoes the request. On every path, the master key (lower and upper case), the S3 keys and the backup key appear in no console line, status, error, request body, container `Env/Cmd/Entrypoint/Labels/User`, file other than the one read-only key file, or `util.inspect` output. The test also covers eight schema refusals (`VALIDATION_ERROR`, no Docker call), the real adapter, the signed IPC client and server (raw `400` bodies), and the CLI's exit codes and output for every result.

**Covered by automated tests, not by this run:**
- Nightly queueing and recovery: `apps/api/test/panel-backup.integration.test.ts` and `apps/api/test/panel-backup-qa.integration.test.ts`.
- The administrator's restore route, with its order, tenancy and audit: `apps/api/test/admin-restore.integration.test.ts` and `apps/api/test/panel-backup-qa.integration.test.ts`.
- The order, refusals and marker of `hp-restore-panel` with stubs: `infra/linux/restore-panel.test.ts`, including that `pg_restore` and the SQL file connect as `hosting_panel` to `127.0.0.1` with the password only as `PGPASSWORD` in their own environment, the refusals of a missing or unexpected `DATABASE_URL`, the copy's date and the `y/N` question with `--yes`.
- The administrator's page: `apps/web/test/backups-panel-qa.test.ts` and `apps/web/test/admin-backups.test.ts`.

**Not covered:**
- `hp-restore-panel` run as root on a real server, with `runuser`, systemd and `/var/lib/hosting-panel`.
- A real S3 service: only RustFS was used, with no TLS.
- Two servers alive on the same storage at the same time.

## Part 7 — WordPress tools (ADR 0023)

**Run:** 2026-11-15 (cycle 7 M4a, fix round 2, after rulings R139, R140 and R147.1) on branch `feat/step-3-6-site-tools-and-admin`, Docker Engine `29.9.2`, Node `v26.13.1`. The images were already on the host and the check pulled nothing (`pullMissingImages: false`): `wordpress:cli-2.12.0-php8.4`, `wordpress:7.1.4-php8.4-apache` and `mariadb:12.3.3` (digests as in the first run of this part, unchanged).

**Command:** `timeout 900 node infra/linux/accept-m4-wordpress.mjs`, after the last build of `apps/docker-executor/dist`. It drives the built `apps/docker-executor/dist` (`DockerEngineSocketAdapter.runSiteJob` with the product's own job specifications, and `buildSiteJobContainerPayload` for step 8) and `packages/contracts/dist`.

**Result:** 12 of 12 steps passed in both runs in a row: `12/12 passed in 171.5 s` (→ 22:15:38 UTC) and `12/12 passed in 169.6 s` (→ 22:18:27 UTC), each with exit `0`. The check first asks wordpress.org from its own container on its own network and stops with `wordpress.org not reachable` and exit `1` when there is no answer. It then makes one throw-away site the product's way: `deployService` for the site container, a database on the check's own MariaDB container, and `wordpress.install` with the address `http://wp-a.example.test`, the mail address `admin@example.test` and the title "Test site". `wordpress.inspect`, `wordpress.update`, `wordpress.settle` and `wordpress.reset-password` then run through the real engine against that site, with logins over HTTP to the site's container address. Every name the check gives starts with `hp_swarmtest_m4wp_<hex>`. Objects the product names itself keep the product prefixes `job_`, `hp_site_`, `hp_edge_` and `hp_vol_` and carry `hp_swarmtest_m4wp_<hex>` inside the name, so they do not start with it. The check's own networks get a free `/24`. The site and edge networks are created by the product and use Docker's default pool. No host port is published. Secrets reach containers only as files in the check's `0700` temporary folder, never on a command line. Everything is removed by exact name in `finally` and on `SIGINT`/`SIGTERM`, containers with their anonymous volumes. No prune command is run.

| # | Step | Result | What it proves |
|---|------|--------|----------------|
| 1 | `site-made-the-product-way` | PASS | `deployService` plus `wordpress.install` give a site that answers `GET /` with `200` on its edge network. An install with a wrong database password fails (exit `1` in both runs); the check removes the `wp-config.php` it left, and the install with the right password works. |
| 2 | `check-lists-the-outdated-plugin` | PASS | `wordpress.inspect` lists Classic Editor with its header set back to `0.1` and offers `1.7.0`; core `7.1.4`, the administrator with id `1`, `updatesKnown` true. |
| 3 | `honest-after-failed-lookups` | PASS | A must-use plugin makes WordPress's own update and version look-ups to api.wordpress.org fail, while the job's test request still works. `wordpress.inspect` exits `0` with `updatesKnown` false, `coreUpdate` null, no `updateVersion` on any item and Classic Editor `0.1` still listed. With the plugin removed, the same check gives `updatesKnown` true and Classic Editor `0.1 → 1.7.0` again. Then the same site with no plugin at all (all deactivated, the plugins folder moved aside and put back afterwards; WordPress then stores no `checked` for plugins, only `response`): with answered look-ups `updatesKnown` is true; with the must-use plugin back it is false, `coreUpdate` null and no `updateVersion` on any item. |
| 4 | `one-plugin-updated` | PASS | `wordpress.update` of `plugin:classic-editor` goes `0.1 → 1.7.0`, the files stay owned by `33`, no `.maintenance` is left and `GET /` answers `200`. No newer WordPress was offered (`coreUpdate` null), so a core update could not be shown. |
| 5 | `password-reset` | PASS | The reset gives the administrator a new password: the new one logs in with `302` and the cookie, the old one gets `200` and no cookie. For a subscriber the job exits `40` (`not_administrator`) and the administrator still logs in. |
| 6 | `hostile-site-code` | PASS | A must-use plugin floods both streams (200 000 lines and a 50 MiB line each) and writes a forged result to `php://fd/3`, `/proc/1/fd/1` and `/proc/1/fd/2`. Its proof file shows it ran inside the job and never in the image's start-up script (no `wp help` load, no `docker-entrypoint.sh` parent). The job ends `0` with the true result and no forged value, in 5.5 s and 5.6 s, the adapter reads 263 680 bytes, the kept log is 263 680 bytes (bound 1 MiB), the tail is 4 096 characters. A plugin titled `<img src=x onerror=alert(1)>` comes back as that plain text, the hostile plugin is removed by exact path and a normal check works again. |
| 7 | `cut-short-then-settled` | PASS | A plugin sleeps 120 s while the update downloads; with `jobTimeoutMs: 20000` the adapter answers `124` after 20.6 s and 20.7 s, the container is gone, WordPress's `.maintenance` is there and the site answers `503`. `wordpress.settle` removes it, the site answers `200` and the next check reports the version on disk (`0.1`). |
| 8 | `ends-by-itself` | PASS | The product's own `wordpress.reset-password` container (limit 60 s) is started straight on the engine, with no executor timer, against a site whose must-use plugin sleeps 600 s. It ends by itself with exit `137` (not out of memory) after 65.1 s and 65.2 s, and the engine's events show `die` with no `kill` or `stop`: nobody stopped it from outside. |
| 9 | `honest-without-internet` | PASS | With the site cut off from its edge network and that network removed, `wordpress.inspect` exits `0` with `updatesKnown` false and the installed versions, and `wordpress.update` exits `30` (`wordpress_org_unreachable`) and changes no file (the hash of every path, size, time and owner under `/var/www/html` is equal before and after). |
| 10 | `job-shape` | PASS | `docker container inspect` of all 17 WordPress jobs while running: `User 33:33`, `Memory` and `MemorySwap` `536870912`, `PidsLimit 128`, `CapDrop ALL`, not privileged, `json-file` `1m`/`1`, the product's exact `Entrypoint` (`timeout -s KILL <limit+5> sh -c <script>`), no `Cmd`, `Init` true, the site network, the edge network only for inspect and update while it exists (2 jobs ran offline), and no secret in `Env`, `Entrypoint` or `Labels`. The 5 installs have `Entrypoint` `sh -c <install script>`, no `Cmd` and `Init` true. |
| 11 | `secrets-never-in-a-tail` | PASS | Installs with administrator passwords of 19, 64 and 128 characters and one holding `'`, `"` and `\` each give a login with `302` and the `wordpress_logged_in_` cookie. In 22 jobs (including the failed install) no 8-character window of any secret appears in any job tail or in the raw container log (both streams) read before the adapter removes the container. |
| 12 | `nothing-left` | PASS | 50 containers, 3 networks and 1 volume were removed by exact name; `docker ps -a`, `docker network ls` and `docker volume ls` filtered on the run's name are empty, the volume list equals the one before the run and the temporary folder is gone. |

**Fixed since the first run of this part (step `hostile-site-code` failed there):** a WordPress job now sets its whole command as `Entrypoint` and no `Cmd` (R139), so the `wordpress:cli` image's start-up script, which ran `wp help "$1"` and loaded the site code before the job, no longer runs. Each job also runs under an init (`HostConfig.Init` true), so the `KILL` of `timeout` reaches the script (step 8). The check also no longer says `updatesKnown` true when WordPress's own look-ups failed (R140, step 3), and on a site with no plugin it now says `updatesKnown` true when the look-ups answered: "answered" is read from the stored `response`, which WordPress writes on every answered look-up, instead of `checked`, which it writes only per installed plugin (R147.1, step 3).

**How each key step can fail:**
- Step 3: the second check, without the plugin, must name the waiting `1.7.0` again, so a check that never names an update fails the step. The no-plugin case failed against the build of fix round 1 (`11/12`, exit `1`: `updatesKnown` false with answered look-ups).
- Step 6: the proof file must show the code ran inside the job; any load from `wp help` or under `docker-entrypoint.sh` fails the step, and so does any forged value in the result.
- Step 8: the same step against the same payload without `Init` failed once (scratch copy, not shipped): after the 120 s wait the container was still running (`Running` true, no exit code); the process tree showed `sh -c …` and `php … wp core is-installed`, still waiting.
- Step 9: the update must exit exactly `30` and the hash of the whole `/var/www/html` listing must be equal before and after; a real download would change sizes and times.
- Step 10: each field is compared with the product's values, and `Entrypoint` with the kind's own constant script and limit; self-checks with one changed byte of the script, a `Cmd` of `wp shell` and no `Init` must each be reported.
- Step 11: the scan reads every tail and both streams of every raw log before the adapter removes the container, and a self-check first plants a secret window in a sample and must find it.

**Accepted limit (ADR 0023, Risk 4):** site code that runs inside the job can write the job's own files in `/tmp/hp` and so forge its own listing. This run does not test that as a defect.

**Measured in the two runs:** the whole run `171.5 s` and `169.6 s`. Per kind (min–max seconds, the same in both runs except where noted): `wordpress.install` 5 jobs each, `0.8–2.9`; `wordpress.inspect` 11 each, `1.6–5.5` and `1.5–5.6`; `wordpress.update` 3 each, `0.7–20.6` and `0.6–20.7` (the upper value is the job cut short); `wordpress.reset-password` 2 each through the adapter, `0.9–1.1`, plus the one of step 8 (`65.1 s` and `65.2 s`, exit `137`); `wordpress.settle` 1 each, `0.4`. Versions: WordPress `7.1.4` (no core update offered), Classic Editor `0.1 → 1.7.0`, wp-cli image `cli-2.12.0-php8.4`.

**Log bound:** the 1 MiB bound of the kept log is checked through the engine API (bytes returned by `GET /containers/<id>/logs` with both streams), because the log file under `/var/lib/docker` is not readable for the check.

**Clean-up proof:** after the second run `docker ps -a`, `docker volume ls` and `docker network ls` filtered on `hp_swarmtest_m4wp` printed nothing, and no `hp_swarmtest_*` folder was left in `/tmp` or `/dev/shm`.

**Covered by automated tests, not by this run:**
- The reset with the image missing (no pull, `DOCKER_ENGINE_UNAVAILABLE`): `apps/docker-executor/test/site-jobs.test.ts` ("a reset with the image missing answers DOCKER_ENGINE_UNAVAILABLE and pulls nothing").
- The sentence when the site tools cannot be connected ("Could not connect the site tools to the internet"), for a failed connect and a failed look-up of the edge network: `apps/docker-executor/test/site-jobs.test.ts` ("a failed connect or look-up of the edge network gives the fixed sentence and removes the container").
- `wordpress.set-url`: same payload as the other kinds (`Entrypoint` `sh -c <script>`, `Init` true) in the unit test of every kind; not run by this script.
- The API's steps, recovery, tenancy and audit: `apps/api/test/site-wordpress.integration.test.ts`, `apps/api/test/site-wordpress.qa.test.ts` and `apps/api/test/site-wordpress-applier.test.ts`.
- The page: `apps/web/test/site-wordpress-ui.test.ts`, `apps/web/test/site-wordpress-qa.test.ts` and `apps/web/test/site-wordpress-bff.test.ts`.

**Not covered:**
- A core update: none was offered for WordPress `7.1.4`.
- A failed look-up of the core version alone: WordPress keeps its last core answer when the look-up fails, so the check counts on the plugin and theme answers and, when those are missing, shows no core update either.
- A large site (many plugins, a big database).
- A real customer's plugins.
- A server with the product installed.

## Part 8 — WordPress import

**Run:** 2026-11-16 (cycle 8, milestone M4b-1) on branch `feat/step-3-6-site-tools-and-admin`, Docker Engine `29.9.2`, Node `v26.13.1`. The images were already on the host and the check pulled nothing (`pullMissingImages: false`): `wordpress:cli-2.12.0-php8.4`, `wordpress:7.1.4-php8.4-apache` and `mariadb:12.3.3` (`12.3.3-MariaDB-ubu2404`). WordPress `7.1.4`.

**Command:** `timeout 1800 node infra/linux/accept-m4-import.mjs`, against the built `apps/docker-executor/dist`, `packages/contracts/dist` and `packages/executor-contracts/dist`. The check drives the files helper's `import.*` operations through `DockerEngineSocketAdapter.siteFiles` and the jobs `db.import`, `db.import-load`, `wordpress.import-finalize` and `wordpress.set-url` through `runSiteJob`. Each answer is checked against its contracts schema (`SITE_FILES_RESULT_SCHEMAS`, `WordpressImportLoadResultSchema`).

**Result (fix-up 3, after R166):** all 13 steps passed, exit `0`: `13/13 passed in 128.8 s` (2026-11-16, ended 05:55:04 CET). The executor was built after the line `fix3-files: program done`. The goal holds: a sample WordPress export imported into a fresh site answers `GET /` with `200` and `<title>Imported Title`.

**Earlier results:** fix-up 2 (after R165) passed 13 of 13 twice (`129.8 s`, `127.3 s`). QA, before fix-up 1, passed 12 of 13 steps in both runs (`129.1 s` each, exit `1`). Both failed `imported-site-answers-with-its-title` because the old five-pair address rewrite left two values behind (defect below). Fix-up 1 passed 13 of 13 twice (`127.4 s` each) with a rewrite that R165 then replaced (see the measurements below).

The check makes two throw-away sites the product's way: `deployService` with the site mail set-up, `db.provision`, then `wordpress.install`. The source site is at `http://old.example.test`, titled "Imported Title", with table prefix `old_`. The target is at `http://wp-a.example.test`, titled "Test site". Both use the mail address `admin@example.test`. The source holds a post and a serialized option that both carry its address. It also holds a post whose sentence ends with the address and which names the different host `http://old.example.test.example/x` (`Visit http://old.example.test. Not http://old.example.test.example/x.`), an administrator whose `user_url` is exactly the address, and a table named `` old_hp_o`d; d `` (a backtick, a `;` and a space) with two rows, `plain` and `http://old.example.test/odd`. Its export is a `mariadb-dump` and a zip made with PHP's ZipArchive. The zip has one top folder and a top-level `__MACOSX`, and it also holds:
- a foreign `wp-config.php` with other credentials, which leaves a marker if it runs;
- `wp-content/object-cache.php`, which answers `500`;
- `wp-content/mu-plugins/mark.php`, a marker;
- a nested `wp-content/uploads/.htaccess`.

The source site is removed once its export exists.

The product's database jobs look for the container `hp_mariadb` and join the network `hp_mariadb_net`, and `deployService` attaches `hp_mariadb` and `hp_mail_relay` to each new site network. The check never creates or touches those names. A wrapper around the adapter's Docker client sends those requests elsewhere:
- the look-up of `hp_mariadb`, its attach to the site network (with the alias `hp-mariadb`) and the `NetworkMode` of every database job go to the check's own MariaDB container and network (44 requests per run);
- the attach of `hp_mail_relay`, which does not exist on this host, is answered `404` without reaching the engine; the product reads `404` as "not created yet";
- any other request that names `hp_mariadb` stops the run.

The check's own MariaDB container is built from the product's `buildSharedDatabaseContainerPayload`, with restart `no`, its own `/24` network and the root key in a `0400` file. Every name the check gives starts with `hp_swarmtest_m4imp_<hex>`. Objects the product names itself keep the product prefixes (`job_`, `hp_site_`, `hp_edge_`, `hp_vol_`, `hp_files_`) and carry `hp_swarmtest_m4imp_<hex>` inside the name. No host port is published; each site is reached at its address on its edge network. Secrets reach containers only as files in the check's temporary folder or on stdin, never on a command line. Everything is removed by exact name in `finally` and on `SIGINT`/`SIGTERM`, containers with their anonymous volumes. No prune command is run, and nothing needs the internet.

| # | Step | Result | What it proves |
|---|------|--------|----------------|
| 1 | `source-site-and-its-export` | PASS | A site with prefix `old_` at the old address, a 104 118-byte dump and a 37 MB zip of 4 261 entries with the four planted entries and `__MACOSX`. |
| 2 | `staging-is-never-served` | PASS | The archive goes up in full and the dump in chunks. While the dump is half-written, 12 requests to the staging folder all answer `403`: the archive, the dump, the staging `.htaccess`, the folder itself and the `.part` file. The same holds with a hostile root `.htaccess` in place (`Options +Indexes`, `Require all granted` for every file, a rewrite of `/peek` to the archive); that file is removed afterwards. `import.stat` shows both slots `complete` with their sizes and `remains: false`. `import.take` moves a site file into the dump slot (104 118 bytes). It refuses `../../../etc/hostname` (`invalid_path`) and a link to a file outside the site (`is_a_directory`), and the slot stays as it was. |
| 3 | `import-in-the-ruled-order` | PASS | The jobs run in the ruled order: `import.unpack` (4 261 entries; `leftOut` names `wp-config.php`, `.htaccess`, `wp-content/mu-plugins` and `wp-content/object-cache.php`), `db.import` prepare, `db.import-load`, `import.switch` (49 moves), `db.import` switch, `wordpress.import-finalize`, `import.finish`, `db.import` finish. Every job exits `0`. The load answers `{"prefix":"old_","oldUrl":"http://old.example.test","tables":13}` (the odd-named table included). |
| 4 | `gate-holds-through-the-switch` | PASS | At each of three points (after `import.switch`, after `db.import` switch, and after finalize but before `import.finish`), `/`, `/wp-admin/install.php` and `/wp-login.php` were each asked 10 times, 200 ms apart. All 30 answers at each point were `403`, never a `200` and never a WordPress page. The `503` of the `wp-config.php` gate never showed, because the `.htaccess` gate answers first. After `import.finish`, `GET /` answered `200` after 0.33 s and 0.34 s with no `503` before it. |
| 5 | `imported-site-answers-with-its-title` | PASS | `GET /` answers `200` with `<title>Imported Title`. A `wp search-replace --regex` dry run outside `guid`, using the product's own boundary (read from the exported `WORDPRESS_SET_URL_SCRIPT`), finds `0` of `http://old.example.test`. `old_users.user_url` reads `http://wp-a.example.test`. The sample post reads `Visit http://wp-a.example.test. Not http://old.example.test.example/x.`: the sentence end was rewritten and the other host was left byte for byte. The serialized option still unserializes, now holding the new address. The table `` old_hp_o`d; d `` came through the switch and reads `plain http://wp-a.example.test/odd`: its value with the old address was rewritten. `wp-config.php` starts with `<?php`, has no gate, has `HP_MANAGED` and the panel's database name and password, and holds none of the export's credentials. No marker file exists. `object-cache.php` and the foreign must-use plugin are absent. The nested `.htaccess` is back under its own name. Every file belongs to uid `33`, except the root-owned mount point `wp-content/mu-plugins`. The panel block is in the root `.htaccess`. `.htpanel-import` is gone, and no `hp_is_`/`hp_ia_`/`hp_im_` schema or `hp_iu_` account is left. The mail plug-in is unchanged. (The plain dry run of the bare host `old.example.test`, which is only reported, finds the one planted `old.example.test.example`.) |
| 6 | `address-job-still-works` | PASS | `user_url` and the sample post are set back to the old address, then `wordpress.set-url` (old → new) exits `0` on the imported `old_` tables. `user_url` reads `http://wp-a.example.test`, the post reads `Visit http://wp-a.example.test. Not http://old.example.test.example/x.`, and `GET /` answers `200`. A second `wordpress.set-url` with the same addresses exits `0` and the `CHECKSUM TABLE … EXTENDED` of every table is unchanged. |
| 7 | `refused-exports-change-nothing` | PASS | Each refused export gives its exact exit code (results below). After the undo pair (`db.import` undo, then `import.undo`), the files, the `CHECKSUM TABLE … EXTENDED` of every table, the schema list and `GET /` (`200`, own title) are the same as before. |
| 8 | `refused-archives-change-nothing` | PASS | Each archive is refused with its reason (below), the site is unchanged and no archive entry is outside `.htpanel-import`. |
| 9 | `undo-after-the-switch` | PASS | A full import ran up to and including `db.import` switch; the live schema then held the export (`home` was the old address). The site's own database account then made a trigger on the imported `old_posts`: `db.import` undo answered `92`, nothing was renamed (the marker table still reads `after`, `home` is still the old address), and the account dropped its trigger. The undo pair answered `0` and `{complete:true}`, twice. Each time the files, tables, schemas and `200` with the site's own title were the same as before. The table `` old_hp_o`d; d `` is back and reads `plain http://wp-a.example.test/odd`. The site's own database account reads its rows, an insert of a child row with no parent still fails with `1452`, and no staging or aside schema and no staging account is left. |
| 10 | `killed-in-the-middle-of-the-swap` | PASS | A half-done swap was built by hand as `33:33`, the same way `import.switch` builds it: the saved files, both gates, a plan of 51 entries (26 out), then only the first 38 moves. `import.undo` answers `{complete:true}` and the files and tables are equal. With all moves done and one moved-out entry deleted from the aside folder, so it is missing on both sides, `import.undo` answers `{complete:false}`. The gate, the saved files and the plan are unchanged, and the work folder is kept. Once the entry is put back, `import.undo` answers `{complete:true}`. |
| 11 | `an-unfinished-import-is-left-alone` | PASS | With a work folder that holds a plan, `import.stat` answers `remains: true`. `import.discard` empties both slots and leaves that folder's listing unchanged. `import.unpack` with the same id is refused `staging_unsafe`. |
| 12 | `no-secret-in-any-tail` | PASS | The scan covers 48 jobs and 17 secrets: the root key, both site database passwords, both administrator passwords and 12 staging secrets. No 8-character window of any secret appears in any job tail, in either stream of the raw log (read before the adapter removes the container), or in the `Env`, `Cmd`, `Entrypoint` or `Labels` of the job container. The container is inspected while it runs, for each of the six kinds used. A self-check first plants a window and must find it. |
| 13 | `nothing-left` | PASS | 113 containers, 5 networks and 2 volumes were removed by exact name. `docker ps -a`, `docker volume ls` and `docker network ls` filtered on the run's name are empty, the volume list equals the one before the run and the temporary folder is gone. |

**Defect found by QA (step 5, fixed in fix-up 1):** after `wordpress.import-finalize` the old address was still in `old_users.user_url` (exactly `http://old.example.test`) and in WordPress's Privacy Policy draft (`Our website address is: http://old.example.test.</p>`). The dry run found `2` where `0` is expected. The cause: `ADDRESS_REWRITE` in `apps/docker-executor/src/site-jobs.ts` rewrote the origin only before `/`, `"` or `'` (and their escaped forms).

**The fix (R163, R164.1, R165):** `ADDRESS_REWRITE` in `apps/docker-executor/src/site-jobs.ts` is one pass, the same text for `wordpress.set-url` and `wordpress.import-finalize`. The script builds the pattern from the checked `HP_PREVIOUS_URL`, with its dots escaped: `https?:(\\?/)\1<host>(?![A-Za-z0-9\x80-\xff-]|\.[A-Za-z0-9\x80-\xff-]|:[0-9]|@)`, replaced with `<new scheme>:${1}${1}<new host>`.
- It covers both schemes and both slash forms, plain and JSON-escaped, through the back-reference.
- The origin is kept where the next byte continues the host: a letter, a digit, `-`, a byte 0x80–0xff, a `.` followed by one of those, `:` and a digit, or `@`. It is replaced everywhere else, including at the end of the value.

**Way B, built in fix-up 2 (R165.1):** the pass is our own loop inside one `wp eval --skip-plugins --skip-themes`, and it never calls `search-replace`.
- It reads only the base tables of the site's prefix (`wp_get_table_names` with `all-tables-with-prefix` and `base-tables-only`), so views are left alone.
- From each table it reads the text columns (`text` or `varchar` in the type), except `guid` and `user_pass`. `user_pass` is the column wp-cli itself always skips. A table without a primary key is skipped.
- It finds only rows where one of those columns holds the old host (`LIKE BINARY`, with `%`, `_` and `\` escaped), 500 at a time, in primary-key order. Composite keys page with the expanded `OR` form. Since fix-up 3 (R166.1) this batch query reads only the primary-key columns; each row is then read on its own by its key, so PHP holds one row, not 500.
- Each value goes through wp-cli's own `WP_CLI\SearchReplacer` in regex mode, with the pattern and replacement above (delimiter `chr(1)`, objects recursed, as `search-replace --regex` does). So serialized values are rebuilt with their lengths.
- A row is written back (`UPDATE … WHERE <primary key>`) only when a value changed. Since fix-up 3 (R166.2) a new value longer than its column's limit is not written and keeps its old value, as wp-cli's `$wpdb->update` did; the other columns of that row are still written. The limit comes from `DESCRIBE`: characters for `varchar(N)`, bytes for `tinytext` (255), `text` (65 535) and `mediumtext` (16 777 215); `longtext` has none. The session's SQL mode is not changed. Names are quoted with their backticks doubled. All values travel as parameters (`execute_query`), never inside the SQL.
- `mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT)` is the first statement. Then autocommit goes off, and the work runs inside a `try`/`catch (Throwable)` that exits `1`. The shell turns that into exit `26` with nothing committed and no SQL or value in the tail. Since fix-up 3 (R166.3), right after the commit and still inside the `try`, `mysqli_report(MYSQLI_REPORT_OFF)` and autocommit on hand the session back as WordPress had it before the shutdown hooks of the site's must-use plugins run.

**Why way B:** R165 asked for a pass that touches only the rows that hold the old host. On the sparse sample, way A (the earlier `wp search-replace --regex` text) took `312.8 s`, 30 times the ten-pass text, because it reads and runs the regex on every row. Way B took `2.05 s` there and was also the fastest on the dense sample (table below).

**Fix-up 3 (R166), defect first, in a throw-away lab (`hp_swarmtest_fix3_*`, internal network, no host port, removed by exact name; each text run as the product's job runs it, as `33:33` with `512m`; the new text is the constant taken from the built `dist`; peak memory is the job container's `memory.peak`):**
- **Memory (R166.1).** Inside `wp eval`, wp-cli sets PHP's `memory_limit` to `-1` (`php -r` alone answers `128M`), so the bound is the job's 512 MB, not PHP's limit. 600 `postmeta` rows of about 452 KB did not break the fix-up 2 text (exit `0`, `8.1 s`, peak 519 MB, just under the limit). With rows of about 994 KB, the old address many times in each value, plain and with escaped slashes, the fix-up 2 text was killed by the container limit (`Killed`, exit `26`, `4.8 s`, peak 537 MB). All 600 rows still held the old address while `home`/`siteurl` were already new; every retry ends the same way. The new text: exit `0`, `15.7 s`, peak 68 MB, no old address left (both forms rewritten); on the 452 KB rows `7.4 s`, peak 68 MB.
- **Too-long value (R166.2).** A `varchar(30)` of exactly 30 characters (`http://old.example.test/abcdef`) and a `tinytext` of 255 bytes, each beside a column with room. With the fix-up 2 text they came out cut short (`http://wp-a.example.test/abcde`, 255 bytes) with exit `0`. With the new text both keep their old value, the column beside each is rewritten, exit `0`. A `varchar(30)` value of 29 characters with five `é` (34 bytes) becomes 30 characters and is written: the limit counts characters.
- **Shutdown hook (R166.3).** A must-use plugin adds a `shutdown` action. (a) `$wpdb->query("SELECT * FROM hp_no_such_table")`: with the fix-up 2 text the job exited `26` (`PHP Fatal error: Uncaught mysqli_sql_exception`) after a rewrite that had committed. (b) `update_option` of a marker: with the fix-up 2 text the write inside the pass was lost (a plain `wp eval` writes it). Both defects showed, so both statements are built; with the new text (a) exits `0` and (b) writes the marker.
- **All cases of fix-up 2 (`cases.sh`) on the new text:** the same results as listed below (26 values after runs 1, 2 and 3; second run `Handler_update` +0 and checksums equal; odd-named table, table without key, composite key, broken view, `guid`, serialized arrays; the refused write `26`, 67-byte tail, checksums equal, 18 cases still old).

**Lab measurements (fix-up 2: a separate throw-away lab on the same images, `hp_swarmtest_fix2_*`, internal network, removed by exact name; each script text is run as the product's job runs it, as `33:33` with `512m`; way B is the constant taken from the built `dist`):**

| Sample | Ten-pass text | Way A | Way B (fix-up 2) | Fix-up 3 text |
|---|---|---|---|---|
| Sparse: 100 000 posts, 1 % with the old address; 1 000 000 postmeta rows without it | `10.5 s` | `312.8 s` (exit `0`, under the `600 s` cap) | `2.05 s`; second run `1.87 s` | `2.61 s`; second run `1.71 s`; peak 63 MB |
| Dense: 100 000 posts and 100 000 postmeta rows, the old address in every row | `72.6 s` | `166.7 s` and `166.1 s` | `35.8 s`; a rerun after the killed run `35.1 s`; `35.7 s` in fix-up 3's lab | `66.8 s` twice; peak 63 MB |

The dense ten-pass and way A figures come from fix-up 1's lab, run on the same sample and images, and were not measured again. Every way B and fix-up 3 figure is under its gate (`120 s` sparse, `240 s` dense). The extra read per matching row costs the dense sample about `31 s` for 200 000 matching rows (fix-up 3 lab, same sample: `35.7 s` → `66.8 s`).

- **Correctness:** `cases.sh` holds 26 values, each read back byte for byte after every run.
  - Replaced: the exact value; before `.`, `/`, `"`, `'`, `<`, `)`, `?`, `#`, a space, a line end and `. `; `http:\/\/…\/x` and the end of a JSON string; a serialized array as the whole string and inside a longer one; the `https` form. `user_url` and `post_content` were rewritten too.
  - Kept: `.test.example/x`, `.test-b.example/x`, `.testing.example`, `:8080/x`, `@other.example/`, `é` after the address, the same inside a serialized value, and `guid`.
  - All 26 were right after run 1 (old → `http://wp-a.example.test`), run 2 (the same again) and run 3 (scheme alone, → `https://wp-a.example.test`). The serialized options still unserialize as arrays.
- **New cases in fix-up 2:**
  - The table `` wp_o`d; d `` (a backtick, a `;` and a space) with rows `plain` and `http://old.example.test/odd` reads `plain http://wp-a.example.test/odd`.
  - A table without a primary key that holds the old address is skipped, and the job still exits `0`.
  - A table with a composite primary key `(INT, VARCHAR)` and 1 200 rows, which is three batches, is fully rewritten.
  - A view over a dropped table, which cannot be read, stays a view, is not touched, and the job exits `0`.
- **Second run:** the server's `Handler_update` counter did not move, and the `CHECKSUM TABLE` of every table was unchanged.
- **A refused write** (a trigger that raises `SIGNAL` on a `wp_options` row): exit `26`. The tail is 67 bytes, only wp-cli's two `Success: Updated` lines for `home` and `siteurl`, with no trace, SQL or value. Every table, the composite one included, has the same checksum as before (`home` and `siteurl` were set back first), and the 18 cases the pass would change still hold the old address.
- **Killed run (fix-up 2 text, not run again):** the dense pass was killed (`SIGKILL`, exit `137`) after `18.2 s`, with 104 338 rows changed inside the open transaction. Afterwards all 100 000 posts and 100 000 postmeta rows still held the old address, `home`/`siteurl` held the new one (they are set before the pass), and no transaction was left open. A rerun took `35.1 s`, exited `0` and left no old address.
- **Exported `WORDPRESS_IMPORT_FINALIZE_SCRIPT`:** it holds the same `ADDRESS_REWRITE` text (pinned by `site-jobs.test.ts`). The lab did not run it; the real-Docker check above did (steps 3, 5 and 9).

**Breaks shown on purpose and restored:**
- With the old five-pair text, step 5 failed (the QA runs above).
- With `LIKE BINARY ?` replaced by `IS NOT NULL OR ? IS NULL` (every row read), the unit tests failed 2 of 48 in `site-jobs.test.ts`.
- With the old way A text, the same 2 pinned tests failed.
- The guard in `site-jobs-import.test.ts` ("every query is read into a variable first…") was tried with four lines put into the load script, one at a time: `[ "$(marker)" = after ] || exit 97`, `live_ok || exit 85`, `if live_ok; then :; fi`, `! q 'SELECT 1'` and `for x in $(marker); do :; done` (a bare `$(marker)`, which the earlier form of the guard missed). The guard test failed for each (1 of 20); for the first two the stand-in run of the load script failed too (2 of 20). To pass the guard, seven lines of `DB_IMPORT_LOAD_SCRIPT` now read their value into a variable before the `[ ]` test (exit codes `50`–`55` unchanged).
- Fix-up 3: with a text column put back into the batch query (`array_merge($k, $c)`), `site-jobs.test.ts` failed 1 of 48; the R166 pins also failed 1 of 48 on the fix-up 2 text.
- With `names` back in place of `objs` in the undo, the unit tests failed 3 of 68 and this script failed `undo-after-the-switch`: the undo answered `1` (MariaDB refused the RENAME) instead of `92`, and two later steps failed after the half-undone import. `nothing-left` still passed.

**Refused exports (step 7, the same in both runs).** The target was the imported site at `http://wp-a.example.test`, with `old_` tables, after `wordpress.set-url`, plus a parent/child table pair with a foreign key.

| Case | Exit | Answer |
|------|------|--------|
| export cut mid-statement | `60` | `{"line":187,"errorNumber":1064}` |
| export cut at a statement boundary | `53` | |
| cut gzip | `51` | |
| two databases (`old_` and `two_` in one dump) | `55` | |
| `USE` of another schema | `61` | `{"line":1,"errorNumber":1044}` |
| `GRANT` | `61` | `{"line":638,"errorNumber":1045}` |
| `DEFINER` view | `61` | `{"line":638,"errorNumber":1142}`, the line of the view statement |
| `DATA DIRECTORY` | `57` | |
| `old_blogs` | `56` | |
| symlinked slot | `50` | |

**Refused archives (step 8, the same in both runs):**

| Case | Refused | Reason |
|------|---------|--------|
| not a zip | at upload | `not_a_zip` |
| a zip without WordPress | at unpack | `archive_not_wordpress` |
| a `..` entry | at unpack | `archive_unsafe` |
| a symlink entry | at unpack | `archive_unsafe` |
| 200 001 empty entries (16.7 MiB) | at unpack, in 2.3 s | `archive_limit` |

**How each key step can fail:**
- Step 2: a `2xx` on any staged path, on the `.part` of the half-written dump or on `/peek` under the hostile `.htaccess` fails the step. So does a slot that `import.stat` does not show as `complete` with the exact size, a take that leaves the file in place, or a take from outside the site that is not refused.
- Step 4: any `200`, or any body that names `wp-content`, `wp-includes`, `wp-admin` or WordPress, at any of the 90 probes fails the step. So does more than 2 s of `503`, or any other status, before the first `200` after `import.finish`.
- Step 7: the exit code must be the exact one per case, and `60`/`61` must carry a `{line, errorNumber}` answer. One changed row anywhere (`CHECKSUM TABLE … EXTENDED`), one changed file size, inode, time or owner, an extra schema, or a page that is not `200` with the site's title fails the step.
- Step 9: the check first proves the swap happened (`home` is the old address in the live schema). A trigger from the site's account that does not give `92`, or a rename despite it (marker not `after`), fails the step. Any difference after either undo pair, a site account that cannot read its rows, a child insert that succeeds, or a leftover `hp_is_`/`hp_ia_`/`hp_im_` schema or `hp_iu_` account fails the step.
- Step 12: a window of any secret in a tail, in a raw log or in the inspected `Env`/`Cmd`/`Entrypoint`/`Labels` fails the step, and so does a job kind that was never inspected while running.

**Measured in the fix-up 3 run:**
- **Whole run:** `128.8 s`.
- **Peak disk use:** `436 MiB` (the free space of `/`, sampled every second). `df -h /` showed `8.8G` free before and after the run.
- **Per kind** (min–max seconds):

| Kind | Count per run | Seconds |
|---|---|---|
| `db.provision` | 2 | `0.57–0.63` |
| `wordpress.install` | 3 | `2.75–2.94` |
| `db.import` | 28 | `0.56–1.29` |
| `db.import-load` | 12 | `0.46–1.93` |
| `wordpress.import-finalize` | 1 | `1.80` |
| `wordpress.set-url` | 2 | `1.23` |

- **Files helper:**

| Operation | Count per run | Seconds |
|---|---|---|
| `import.put` | 196 | `0.06–0.33` |
| `import.unpack` | 9 | `0.06–0.74`; the full 4 261-entry export takes about `0.7` |
| `import.switch` | 2 | `0.08` |
| `import.undo` | 15 | `0.06–0.20` |
| `import.finish` | 1 | `0.21` |

**Clean-up proof:** after the run `docker ps -a`, `docker volume ls` and `docker network ls` filtered on `hp_swarmtest` printed nothing (step 13 also checks the temporary folder).

**Covered by automated tests, not by this run:**
- The answer `earlier_import_unfinished` (R155) and the API's steps, recovery and audit: `apps/api/test/site-wordpress-import.integration.test.ts` ("busy: files_incomplete, and earlier_import_unfinished while the simulator holds a plan (R155)"), `apps/api/test/site-wordpress-import.service.test.ts`, `apps/api/test/site-wordpress-import-applier.test.ts` and `apps/api/test/site-wordpress-import.qa.test.ts`.
- The job payload per kind and step, the parameter and secret checks, and the static checks of the import scripts: `apps/docker-executor/test/site-jobs-import.test.ts` (this file also checks that a secret planted in `Env`, `Cmd` or a label is caught).
- Tails without secrets, and the secrets purged when a job fails: `apps/docker-executor/test/site-jobs.test.ts`. The same file checks the one-pass rewrite and its boundary on the pattern as PCRE reads it (bytes), and pins way B's text: the `LIKE BINARY` filter, the skipped columns, the base tables of the prefix, the replacer call, the doubled backticks, strict reporting first, the session handed back after the commit and the `catch` last, and no `search-replace`. Since fix-up 3 it also pins the key-only batch query, the read of one row by its key and the column limits taken from `DESCRIBE`.
- A failed query in `db.import` and `db.import-load` (exit `1`, never `54`/`56`/`59`), and the undo's `92` for an object in live or aside before any rename, with a stand-in `mariadb`: `apps/docker-executor/test/site-jobs-import.test.ts` ("the database scripts against a stand-in mariadb").
- The files program's import operations with real PHP and ZipArchive: `apps/docker-executor/test/site-files-program.test.ts`. This covers:
  - `import.put` and `import.take`;
  - forged plan lines;
  - a switch cut after `k` moves;
  - a gate changed in place;
  - the ceilings, which apply only to the import.
- The contracts: `packages/contracts/test/site-wordpress-import.test.ts` and `packages/contracts/test/site-files-ipc-schemas.test.ts`.

**Not covered:**
- An import killed in the middle of the address rewrite in this script: the lab killed the pass alone (above), not a whole import.
- A value the replacer cannot handle (for example a serialized object it cannot rebuild): `SearchReplacer` returns it unchanged or skips it, so it is not an exit `26`, and PHP may print a warning about it to the tail. The same was true of way A. Not measured.
- Multisite.
- One single value of tens of megabytes: it still needs a few times its size in PHP memory and can end the pass at the job's 512 MB, as with wp-cli (R166.5). Not measured.
- A `char(N)` column: the column filter reads only `text` and `varchar` types, so such a column is not rewritten at all (unchanged since fix-up 2).
- A trigger in the aside schema in this script (the unit test covers it).
- Archives and exports near the 4 GiB limits.
- Other WordPress or PHP versions.
- A real customer site.
- A server with the product installed: the run used its own database and network in place of `hp_mariadb`/`hp_mariadb_net`, and there was no mail relay.
- The API and the page: this run drives the executor directly.
