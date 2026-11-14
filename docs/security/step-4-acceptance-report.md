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
