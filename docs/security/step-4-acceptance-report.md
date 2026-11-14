# Step 4 — Files, Databases and Site Import: Acceptance Report

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
| 14 | `long-statements-keep-their-place` | PASS (`HP_ACCEPT_LONG=1` only; skipped in normal runs) | Run only with `HP_ACCEPT_LONG=1` (skipped when unset in normal runs): Site A runs two `SELECT SLEEP(325)` statements concurrently while `phpmyadmin-upstream.ts` imposes no headers timeout; both remain active in MariaDB past `305s` (`runningAt305=2`, client requests still pending); across `10` samples of a 10 s window, active queries stay capped (`maxRunningWindow=2`), a third site A `SELECT SLEEP(1)` request waits instead of taking a third worker, site B answers `200` within `5 s` (`maxSiteBMs=79`), container `OOMKilled=false` and `StartedAt` stay unchanged; once the slow queries finish (`slow1Status=503`, `slow2Status=503`, `totalElapsedMs=326104`), the queued third request completes with `200` (`follow3WaitMs=20960`) and a final site A load returns `200` (`70 ms`). |
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
