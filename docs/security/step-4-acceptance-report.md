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
