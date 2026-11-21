# HCP-SPEC-004 Acceptance Report: Manual TLS Certificates and Backup Targets

This report gives the result of every acceptance id of HCP-SPEC-004: `TLS-01` to `TLS-14` (spec §5) and
`BKP-01` to `BKP-20` (spec §10). It states only what a test file or a recorded run proves. It does
not say a feature is "ready" where the proof is missing.

## Gate status

- **Met, with an owner item: local backup targets under the production executor unit.** The final security review (`review-final-backup`) found a HIGH defect, **S4-H1**: `RestrictSUIDSGID=yes` in `infra/systemd/hp-docker-executor.service` made the guard's `chmod` with `02770` fail with `EPERM`. It is repaired and closed in `docs/security/audit-report.md`: the guard no longer requests setgid, and `infra/linux/bootstrap-dedicated.sh` creates the local root as 2770. Proof: under `systemd-run --user -p RestrictSUIDSGID=yes -p UMask=0007` the built guard initialised a target and a site folder against a 2770 root, and `infra/linux/accept-backup-local.mjs` was run again (`RESULT 16/16 passed, 2 skipped`). That script runs the executor as a plain process, so the sandbox proof is the `systemd-run` run, not the script. **Owner part:** run the whole unit on a real server, and prepare an external volume with `chown hp-executor:hp-executor` and `chmod 2770` as root.
- **Met, with owner items:** manual TLS certificates on `linux-systemd`. The real-process proof ran on
  Traefik 3.7.19. The reboot, a commercial certificate and PFX stay with the owner or blocked.
- **Not production-ready on S3 history:** no real bucket was used (BLOCKED.md #1).

## Verdicts

| Verdict | Meaning |
|---|---|
| `PASS` | The criterion is met by the test files or the real run in the row. Where the spec asks for a real process, the row names it. |
| `FAIL` | A run failed. None at the time of writing. |
| `SKIPPED` | The step exists and did not run, with its reason. |
| `PENDING (owner: …)` | Only the owner can run it. The action is written in the row. |
| `BLOCKED (BLOCKED.md #n)` | An approval is needed first. |

A `PASS` row can still list an "Owner part": a further proof that only the owner can give. It does
not change the verdict of what is proven.

## Environment and commit

| Item | Value |
|---|---|
| Commit of the runs | `fa5aa5d` (HEAD of `feat/tls-backups-manual-certs-and-targets`), plus one uncommitted fix of the test helper `infra/linux/tls-test-certs.mjs` (see "The helper fix") |
| Host | Linux 6.8.0-151-generic, 4 CPU |
| Docker Engine | 29.10.0 |
| Node | v26.13.1 |
| Traefik | 3.7.19 (binary with a pinned SHA-256, and the image `traefik:v3.7`), Pebble v2.10.3 for ACME |
| restic | 0.19.1 (image pinned by digest, `packages/contracts/src/site-runtime.ts`) |
| S3 stand-in | RustFS 1.0.5 (a local S3-compatible endpoint, not a real bucket) |
| MariaDB | 12.3.3 |
| Package version | `0.6.0` (not bumped) |

The lead's final runs are in `.herdr-swarm/swarm-1120-235048/FINAL-RUNS.md`, with logs in
`.herdr-swarm/swarm-1120-235048/final-logs/` (kept outside git). The scripts were run one at a time.

## Runs behind the matrix

| Run | Command | Result |
|---|---|---|
| Manual TLS on real Traefik | `node infra/linux/accept-tls-manual.mjs` | RESULT 20/20 passed (111 s) |
| Manual TLS through the production adapter | `node infra/linux/accept-tls-adapter.mjs` | RESULT 18/18 passed (23 s) |
| Local backups on real Docker | `node infra/linux/accept-backup-local.mjs` | RESULT 16/16 passed, 2 skipped (120 s). The skips are the root-only cases (BLOCKED.md #6). Run again after the S4-H1 repair: the same result |
| Release build | `corepack pnpm run release:build` | exit 0: `dist-release/hosting-panel-0.6.0-linux-x64.tar.gz` and its `.sha256` |
| Release smoke | `corepack pnpm run release:smoke dist-release/hosting-panel-0.6.0-linux-x64.tar.gz` | `smoke: PASS` (web `/login` answers) |
| Sensors | `build`, `lint`, `typecheck`, `test` | 0, 0, 0 and 314 of 316 test files green; the two failing files (three web assertions pinned to M3 contracts) were repaired in `c4-fixup2` and run again: 6 files, 311 tests green. The rest of the suite had passed: 6929 tests passed, 46 skipped |
| Targeted run of this report | `corepack pnpm vitest run` on 35 files | 35/35 files, 1353 tests passed |

`accept-m3-panel.mjs --repo=local` (design row `BKP-16`) was not run in this cycle. The panel
disaster-recovery steps ran inside `accept-backup-local.mjs` (`panel-local-and-dr`).

### The helper fix

The first run of `accept-tls-adapter.mjs` of the final cycle stopped at start. The test helper
`infra/linux/tls-test-certs.mjs` wrote a DER INTEGER that was not minimal for about one random serial
in 512, and OpenSSL answered "illegal padding". The helper now writes a minimal INTEGER (3000
certificates generated without error) and the script was run again, green. This is a test
helper, not product code. The fix is not committed at the time of writing.

### Targeted run

`corepack pnpm vitest run` on the 35 test files named in the matrix (API integration and QA files, executor
guard and TLS store files, contract and database files, and the update, downgrade-gate and restore-panel
tests of `infra/linux`), on `fa5aa5d`, Node 26.13.1, 4 CPU, written while the final docs were being
edited. Result: **35 of 35 files passed; 1353 tests passed, 1 expected fail (`it.fails`), 1 skipped; 170 s.**
The expected fail is a low defect pinned on purpose (S4-L1), repaired since in #17.

## Matrix: TLS

Columns: the id, the scenario, the verdict, the command or test files that prove it, the environment, the commit,
the evidence. "AM" is `infra/linux/accept-tls-manual.mjs` (real Traefik 3.7.19 and Pebble), "AA" is
`infra/linux/accept-tls-adapter.mjs` (the production adapter, a throw-away proxy on real Docker). Step names
are the names printed by the scripts.

| Id | Scenario | Verdict | Command or tests | Environment | SHA | Evidence |
|---|---|---|---|---|---|---|
| TLS-01 | Valid PEM import | PASS | `apps/api/test/tls-certificate-validator.test.ts`; `apps/api/test/tls-certificates.integration.test.ts`; `apps/api/test/tls-keysafety.qa.test.ts`; `packages/contracts/test/tls-certificates.test.ts`; AA steps `put-version-idempotent-and-validated`, `publish-hot-serves-fingerprint` | vitest (Node 26.13.1, PGlite); AA on Docker 29.10.0, Traefik 3.7.19 | `fa5aa5d` | The resource is created with exact metadata, the response keys are an allowlist, and no `*Pem` or key field appears in a response, an audit row, an outbox event or a log (the key canary is absent everywhere). AA serves the imported fingerprint. **Owner part:** a commercial certificate (BLOCKED.md #5): the tests use a locally generated CA chain |
| TLS-02 | Wrong key, corrupt chain, expired, leaf CA, PFX, others | PASS | `apps/api/test/tls-certificate-validator.test.ts`; `apps/api/test/tls-validator-adversarial.qa.test.ts` (123 cases); `apps/api/test/tls-certificates.integration.test.ts` | vitest, Node 26.13.1 | `fa5aa5d` | Each case fails before publication with a stable `CERTIFICATE_INVALID` reason; no outbox event and no executor call. Also refused: an IP-literal SAN, a chain with duplicates or unrelated certificates, an encrypted key, a body over 512 KiB (413), a PEM body with a dash (a validation error, not a 500). PFX is refused as format (see TLS-14) |
| TLS-03 | Wildcard and several SAN | PASS | `apps/api/test/tls-certificate-validator.test.ts`; `packages/contracts/test/tls-certificates.test.ts`; `packages/contracts/test/hcp004-contracts-adversarial.test.ts`; AM step `tls07-wildcard-exact` | vitest; AM on Traefik 3.7.19 | `fa5aa5d` | `*.example.com` covers one label only: not the apex, not `a.b.example.com`. A partial wildcard and `*.com` are refused. A common name outside the SANs is refused (`cn_not_in_san`). AM serves each host with the expected certificate |
| TLS-04 | Cross-tenant, same-organisation reuse, wildcard collision | PASS | `apps/api/test/tls-tenancy.qa.test.ts` (17); `apps/api/test/tls-certificates.integration.test.ts`; `apps/api/test/tls-assignment.test.ts`; `apps/api/test/tls-domain-side-effects.integration.test.ts`; `apps/api/test/admin-route-guard.integration.test.ts`; `apps/api/test/support-access-tenancy.integration.test.ts` | vitest | `fa5aa5d` | Reuse in the same organisation works. A foreign organisation, site or certificate answers 404 on every customer and admin route, before the body is read. A wildcard covering another tenant's host is refused in both directions (`DOMAIN_CONFLICT`, nothing leaked). A site move with a manual domain answers 409 `CERTIFICATE_IN_USE`. A certificate shared by two sites rotates across both (`409 RESOURCE_LOCKED` while another site has an active operation) |
| TLS-05 | Manual certificate on an existing ACME domain | PASS | AM steps `tls05-plan-says-eviction`, `tls05-hot-superset`, `tls05-cold-evict`; AA steps `cold-path-refused-hot`, `cold-path-evicts-with-backup`, `cold-path-failed-probe-restores`, `upgrade-no-recreate`; `apps/docker-executor/test/manual-tls-store.test.ts`; `apps/docker-executor/test/traefik-routes.test.ts` | AM and AA on Docker 29.10.0, Traefik 3.7.19, Pebble v2.10.3 | `fa5aa5d` | A handshake with SNI presents the manual fingerprint, and Pebble sees no new order. A tie on the same SAN key is refused and nothing is written. The administrator's cold path backs up `acme.json`, drops the covering entries, restarts the proxy once and serves the manual certificate with no new order (`evicted 1 entry, restarts 5/5, no re-order`); a failed probe restores the byte-equal backup. The proxy made by the 680febb payload keeps its container id after the new `ensureIngressProxy`. **Owner part:** a real Let's Encrypt certificate on an owner server |
| TLS-06 | Explicit return to ACME | PASS | AM steps `tls06-back-to-acme`, `tls06-refused-under-wildcard`; `apps/docker-executor/test/traefik-routes.test.ts`; `apps/api/test/tls-lifecycle.qa.test.ts` | AM on Traefik 3.7.19, Pebble | `fa5aa5d` | The ACME resolver is back, the served certificate is the ACME one, and there is no ambiguous selection. A return under a loaded wildcard that blocks the order is refused. The route hash of an ACME host equals its frozen pin |
| TLS-07 | Wildcard and exact on different hosts | PASS | AM steps `tls07-wildcard-exact`, `wildcard-sibling-renews`, `capture-refused`; the SNI planning cases of `packages/contracts/test/tls-sni.test.ts` | AM on Traefik 3.7.19 | `fa5aa5d` | Each hostname gets the expected fingerprint (the exact certificate beats the wildcard), a sibling still renews through ACME, and a certificate that would capture another host is refused |
| TLS-08 | Rotation under HTTP load | PASS | AM step `tls08-rotation-under-load`; AA step `rotation-under-load` | AM on Traefik 3.7.19 (a binary, and a container of `traefik:v3.7`); AA through the adapter | `fa5aa5d` | AM: the switch took 2480 ms with 2714 handshakes on the old certificate, 1713 on the new one and 1131 HTTP 200, no TLS error; the container rotated with no restart. AA: 892 handshakes on host a and 593 on host b during the rotation, no error, `StartedAt` and `RestartCount` of the proxy unchanged |
| TLS-09 | Crash between files, manifest and commit | PASS | AM step `tls09-crash-recovery`; AA step `executor-restart-recovers`; `apps/docker-executor/test/manual-tls-store.test.ts`; `apps/docker-executor/test/manual-tls-adversarial.test.ts`; `apps/api/test/tls-apply.integration.test.ts` | AM, AA on Docker; vitest | `fa5aa5d` | The previous manifest stays valid after a crash at each rename, and recovery is idempotent. An unknown outcome gives a status read, never a blind second apply (a read-only recovery). A bad entry in the manifest is not fatal (`bad-entry-not-fatal`) |
| TLS-10 | Restart of Traefik, `systemctl restart`, reboot | PENDING (owner: restart `hp-docker-executor`, `hp-api` and the proxy with `systemctl`, then reboot the server, and check that every manual host serves its certificate before the control plane is back) | AM step `tls10-restart-x5`; AA step `executor-restart-recovers`; `infra/linux/restore-panel.test.ts`; `packages/database/test/restore-panel-sql.test.ts` | AM on Docker 29.10.0 and Traefik 3.7.19 | `fa5aa5d` | Proven: five proxy restarts in a row, each served the manual certificate; the executor restart recovered. The manifest and the files live under the existing `dynamic/` mount, so the certificates persist. **Not run:** `systemctl restart` of the units and a host reboot (BLOCKED.md #2) |
| TLS-11 | Delete in use, delete unused | PASS | `apps/api/test/tls-certificates.integration.test.ts`; `apps/api/test/tls-lifecycle.qa.test.ts`; AM step `gc-after-verify`; AA step `gc` | vitest; AM, AA on Docker | `fa5aa5d` | Delete of a certificate in use answers 409 `CERTIFICATE_IN_USE`. Delete of an unused one returns 204 and removes every row and all ciphertext. The files go only after the reload is confirmed, with a 5-minute grace |
| TLS-12 | Alerts at 30, 14, 7, 0 days | PASS | `apps/api/test/tls-alerts.integration.test.ts`; `apps/api/test/tls-lifecycle.qa.test.ts`; `packages/contracts/test/tls-certificates.test.ts`; `apps/web/test/tls-copy.test.ts` | vitest, Node 26.13.1 | `fa5aa5d` | The tiers are exact to the millisecond, and the same under five time zones. Over about 34 days of ticks the audit has one `warning`, one `critical` and one `expired` row per version, no endless duplicate. The IT and EN catalogs have the same keys |
| TLS-13 | Secret scan and `docker inspect` | PASS | `apps/api/test/tls-keysafety.qa.test.ts`; `apps/api/test/hcp004-m1.integration.test.ts`; AM step `inspect-no-secrets`; AA step `gate-clean` | vitest; AM, AA on Docker 29.10.0 | `fa5aa5d` | No PEM marker or key canary in responses (413 and 422 too), audit rows, outbox, operations, logs, executor answers or web HTML in IT and EN. `docker inspect` of the proxy shows no PEM in Env, Labels or Cmd and no Docker socket bind; the manifest holds file references only. The AA gate socket saw 42 requests and denied 0 on a throw-away proxy, and the live `hp_ingress_proxy` was never reached. **Owner part:** the CI security scan at release |
| TLS-14 | PFX with password and chain | BLOCKED (BLOCKED.md #3) | `apps/api/test/tls-certificates.integration.test.ts` (a PFX body is refused as `CERTIFICATE_INVALID`) | vitest | `fa5aa5d` | Node has no PKCS#12 parser. A parser dependency or an external tool needs the owner's approval first (HARNESS dependency allowlist). This release is PEM only and the UI never offers PFX. **Approval needed:** the choice of the parser or tool, pinned by version or digest |

## Matrix: backups

"AB" is `infra/linux/accept-backup-local.mjs` (real Docker, restic 0.19.1, RustFS 1.0.5, MariaDB 12.3.3). Rows with a
local copy cite "Re-run": `accept-backup-local.mjs` run again after the S4-H1 repair (16/16, 2 skipped); the sandbox of the
production unit is proven by the `systemd-run` run in "Gate status".

| Id | Scenario | Verdict | Command or tests | Environment | SHA | Evidence |
|---|---|---|---|---|---|---|
| BKP-01 | Upgrade with S3 history and new targets | PASS | `packages/database/test/rollback-compat.test.ts`; `packages/database/test/backup-targets-repository.test.ts`; `apps/api/test/backup-legacy-compat.integration.test.ts`; `apps/api/test/backup-legacy-compat.qa.test.ts`; AB step `legacy-s3-coexists` | vitest (PGlite); AB on Docker 29.10.0 with RustFS 1.0.5 | `fa5aa5d` | The backfill SQL (run from the real migration file) keeps every old backup listed with the same snapshot id, and is idempotent. Archived targets stay restorable from their old bucket. **Owner part:** a real bucket (BLOCKED.md #1). A "restore a pre-0022 dump, upgrade, download" step was not built |
| BKP-02 | Local only, no S3 | PASS | `apps/api/test/backup-policies.integration.test.ts`; `apps/api/test/backup-copies.integration.test.ts`; AB steps `local-init-and-test`, `local-backup-manual`, `local-restore` | vitest; AB on Docker 29.10.0 | `fa5aa5d` | A local-only policy is valid; the nightly run needs no `backup_settings`; a manual backup (4060 ms in the run) and a restore work on real Docker. Re-run after the S4-H1 repair (AB 16/16, 2 skipped); sandbox: the `systemd-run` proof in "Gate status". |
| BKP-03 | Legacy S3 | PASS | `apps/docker-executor/test/site-type-pins-backups.test.ts`; `apps/docker-executor/test/local-target-adversarial.test.ts` (S3 conversations hashed against `ad100f3`); `apps/api/test/backup-legacy-compat.qa.test.ts`; AB step `legacy-s3-coexists` | vitest; AB with RustFS 1.0.5 | `fa5aa5d` | The Docker requests for backup, restore, archive and the nightly run are byte-identical to the frozen pins, also after a location change and a credential rotation. Same repository path, same backup key. **Owner part:** a real bucket (BLOCKED.md #1) |
| BKP-04 | Local restic repository, nothing in clear | PASS | `apps/docker-executor/test/backup-runner-local.test.ts`; AB steps `local-repo-ciphertext-only`, `local-modes-and-users` | vitest; AB on Docker 29.10.0 | `fa5aa5d` | The repository tree holds no site or database sentinel in clear. The local containers have no network, no AWS variable, `CapDrop ALL`, `no-new-privileges`, no Docker socket, and a read-write mount on the leaf only. Re-run after the S4-H1 repair (AB 16/16, 2 skipped); sandbox: the `systemd-run` proof in "Gate status". |
| BKP-05 | Missing or read-only target, hostile paths and symlinks | PASS | `apps/docker-executor/test/local-target-guard.test.ts`; `apps/docker-executor/test/local-target-adversarial.test.ts` (253 cases); AB step `local-hostile` | vitest; AB on Docker 29.10.0 | `fa5aa5d` | A symlink root, segment or leaf, `..`, a missing marker, a wrong owner or mode, an unmounted root: each is refused with its exact problem code before any container is created and before any write outside the root. **SKIPPED (BLOCKED.md #6):** AB `local-readonly-and-no-space` and `local-root-owned-by-another-user` need root. **Owner part:** run them as root with `HP_ACCEPT_ROOT_CASES=1`. Re-run after the S4-H1 repair (AB 16/16, 2 skipped); sandbox: the `systemd-run` proof in "Gate status". |
| BKP-06 | Not enough space in staging or the repository | PENDING (owner: run `HP_ACCEPT_ROOT_CASES=1 node infra/linux/accept-backup-local.mjs` as root on a test server, to fill a real small filesystem) | `apps/docker-executor/test/local-target-guard.test.ts` (injected `statfs`); `apps/docker-executor/test/local-target-adversarial.test.ts` | vitest | `fa5aa5d` | Proven by the guard's `statfs` seam only: `no_space` before any write, the site and the database stay healthy, and the 64 MiB margin lets forget, restore and archive run on a nearly full target. The real full-disk step is SKIPPED here (`local-readonly-and-no-space`, needs root) |
| BKP-07 | S3 and local, both succeed | PASS | AB step `two-copies-both-succeed`; `apps/api/test/backup-dual-copy.integration.test.ts` (22); `apps/api/test/backup-copies.integration.test.ts` | AB on Docker 29.10.0 with RustFS 1.0.5; vitest | `fa5aa5d` | `op_x` (S3) and `op_x-t2` (local) both succeed with different snapshot ids and an identical `restic ls` of `/backup`; each repository gains exactly one snapshot. The API shows one logical `succeeded` with two copies. Re-run after the S4-H1 repair (AB 16/16, 2 skipped); sandbox: the `systemd-run` proof in "Gate status". |
| BKP-08 | S3 and local, one fails | PASS | AB step `two-copies-second-fails-partial`; `apps/api/test/backup-dual-copy.integration.test.ts`; `apps/api/test/backup-dual.qa.test.ts`; `apps/api/test/backup-restore-copy.integration.test.ts` | AB on Docker 29.10.0; vitest | `fa5aa5d` | With the marker removed before copy 2, `op_y-t2` fails with `local_target_unmounted`, no container starts, and the local root is untouched. The aggregate is `partial`, and copy 1 restores the site to its exact state. `pre_update` is refused when a required copy fails. Restore of the failed copy is refused (404). The `partial` audit is written on the recovery path too. The "S3 stopped mid-run" variant was not run. Re-run after the S4-H1 repair (AB 16/16, 2 skipped); sandbox: the `systemd-run` proof in "Gate status". |
| BKP-09 | Retention and prune | PASS | AB step `forget-per-target`; `apps/api/test/backup-retention-recovery.qa.test.ts` (34); `apps/api/test/backup-retention.unit.test.ts`; `apps/api/test/backup-dual.qa.test.ts` | AB on Docker 29.10.0; vitest | `fa5aa5d` | `op_x-forget` and `op_x-forget-t2` each touch only their own repository (checked by a tree fingerprint and an S3 listing). Retention runs per target, an archived target is pruned in its own repository, and the last good copy of a site is never forgotten |
| BKP-10 | Restore from a local copy | PASS | AB step `local-restore`; `apps/api/test/backup-restore-copy.integration.test.ts`; `apps/docker-executor/test/backup-runner-local.test.ts` | AB on Docker 29.10.0 with MariaDB 12.3.3; vitest | `fa5aa5d` | Files, the MariaDB data and the site configuration come back, and a failed restore rolls back to the previous site. Re-run after the S4-H1 repair (AB 16/16, 2 skipped); sandbox: the `systemd-run` proof in "Gate status". |
| BKP-11 | Restore from S3 after a local configuration | PASS | `apps/api/test/backup-legacy-compat.qa.test.ts`; AB step `legacy-s3-coexists` | vitest; AB with RustFS 1.0.5 | `fa5aa5d` | The legacy snapshot is still reachable and restorable with its old bucket and credentials after a local target exists. **Owner part:** a real bucket (BLOCKED.md #1) |
| BKP-12 | Plain ZIP export | PASS | AB step `local-export-zip`; `apps/api/test/backup-export-format.integration.test.ts` | AB on Docker 29.10.0; vitest | `fa5aa5d` | An authenticated download from a local copy: chunks, time to live, content check and cleanup. Re-run after the S4-H1 repair (AB 16/16, 2 skipped); sandbox: the `systemd-run` proof in "Gate status". |
| BKP-13 | `.zip.age` export | BLOCKED (BLOCKED.md #4) | AB step `zip-age-blocked`; `apps/api/test/backup-export-format.integration.test.ts`; `apps/api/test/backup-panel-export.qa.test.ts` | AB; vitest | `fa5aa5d` | The `.zip.age` format is refused with 422 `NOT_SUPPORTED` before any other lookup, an invalid recipient with 400, and nothing is recorded. `isEncryptedBackupExportAvailable` is false on every backend. **Approval needed:** a pinned (by digest) `age` tool or image; the design is in ADR-0032 |
| BKP-14 | Crash during backup or restore | PASS | `apps/api/test/backup-copies.integration.test.ts`; `apps/api/test/backup-retention-recovery.qa.test.ts`; `apps/api/test/backup-dual.qa.test.ts` | vitest | `fa5aa5d` | Recovery after a restart is read-only: a status read for backup and download, `settle` for restore, no executor call for prune or a pending restore, no second forget, job ids `op_x` and `op_x-t2`. The step "executor restart in the middle of a backup" of the design was not built on real Docker, so this row rests on the tests |
| BKP-15 | Cross-tenant or unauthorised target | PASS | `apps/api/test/backup-targets-tenancy.qa.test.ts` (20); `apps/api/test/backup-targets.integration.test.ts`; `apps/web/test/backup-targets-web.qa.test.ts` | vitest | `fa5aa5d` | A foreign backup, copy or target answers 404, the same as a missing one. A customer sees `{id, kind}` only and can pick only an offered, enabled, live target. No endpoint, bucket, key, local root, host path or snapshot id in any response, operation, outbox or audit row. One low defect is pinned (malformed JSON on an admin backup route gets 400 before the administrator check; app-wide, nothing leaks) |
| BKP-16 | Panel backup, restore on a new host | PENDING (owner: restore the panel on a new host from a local repository on a real disk, with `backup.key` kept off the host: `hp-restore-panel --local-repo`) | `packages/database/test/restore-panel-sql.test.ts`; `infra/linux/restore-panel.test.ts`; `apps/api/test/panel-backup.integration.test.ts`; AB step `panel-local-and-dr` | vitest; AB on Docker 29.10.0 | `fa5aa5d` | Proven: the `--local-repo` rules, exits 0, 2, 7 and 8, a read-only fetch, the ledger resets in `hp-restore-panel.sql`, and a panel backup with two copies from one dump. **Not run:** the foreign-uid repository case and a new host (BLOCKED.md #2, #6); `accept-m3-panel.mjs` was not run in this cycle |
| BKP-17 | Missing or wrong `backup.key` | PASS | `apps/api/test/backup-retention-recovery.qa.test.ts`; `apps/api/test/backups-restore-qa.integration.test.ts` | vitest | `fa5aa5d` | `wrong_key` and `key_file_missing` fail restore and download once and change nothing; the raw executor text never reaches the customer. The step "wrong key" of the design was not built on real Docker |
| BKP-18 | Upgrade, rollback, reboot | PENDING (owner: `hp-update` between two real releases, with a dedicated disk, then a reboot) | `packages/database/test/rollback-compat.test.ts`; `infra/linux/update.test.ts`; `infra/linux/features-gate.test.ts`; `apps/api/test/infra-layout.test.ts` | vitest | `fa5aa5d` | Proven: migrations 0021 and 0022 are additive for the previous release, the downgrade gate refuses with exit 8 (`--allow-feature-loss` overrides it, it fails closed). **Not run:** an update between two real releases and a reboot (BLOCKED.md #2) |
| BKP-19 | Legacy UI and API clients | PASS | `apps/api/test/backup-legacy-compat.integration.test.ts`; `apps/api/test/backup-legacy-compat.qa.test.ts`; `apps/api/test/admin-backups.integration.test.ts` | vitest | `fa5aa5d` | The legacy settings route keeps its 15 keys in every state, a location change creates a new target and archives the old one, `DELETE` only archives, and history is kept. The older admin backup tests are green without a change |
| BKP-20 | Concurrency and quotas | PASS | `apps/api/test/backup-retention-recovery.qa.test.ts`; `apps/api/test/backup-copies.integration.test.ts` | vitest | `fa5aa5d` | The caps (6 per hour per site, 24 per hour per organisation), the per-site lock and the one-job-per-site rule hold for every target. A second copy does not make a second operation. The step "concurrent requests" of the design was not built on real Docker |

## What stays with the owner

- **A real S3 bucket:** run the legacy history, backup, restore and download against an authorised
  bucket (`BKP-01`, `BKP-03`, `BKP-11`). Until then S3 is proven against RustFS only.
- **A host reboot and `systemctl restart`:** `TLS-10` and `BKP-18`, on a server the owner can reboot.
- **Root-only filesystem cases:** `HP_ACCEPT_ROOT_CASES=1 node infra/linux/accept-backup-local.mjs` as root (`BKP-05`, `BKP-06`).
- **A commercial certificate, and Let's Encrypt on a real server:** `TLS-01`, `TLS-05`.
- **A new-host restore:** `BKP-16`.
- **Approvals (BLOCKED):** a PKCS#12 parser or tool (`TLS-14`, BLOCKED.md #3) and a pinned `age`
  tool (`BKP-13`, BLOCKED.md #4).
- **The local backup unit (S4-H1):** run `hp-docker-executor.service` itself on a real server and prepare an
  external volume as root (`chown hp-executor:hp-executor`, `chmod 2770`); the sandbox was proven with `systemd-run --user`.

## Known limits behind a `PASS`

These are written in ADR-0031, ADR-0032 or the audit report, and do not change a verdict.

- A destination the administrator **disables** is not required for new backups: the backup succeeds
  with one copy, with no `partial` and no alert. `partial` covers a failure while the backup runs
  (an unmounted disk, an unreachable bucket, a full disk). See ADR-0032.
- The downgrade gate ignores an archived non-legacy destination that still holds copies. It
  refuses when a live non-legacy destination or a manual-certificate domain exists.
- Malformed JSON on an admin route gets 400 before the administrator check (app-wide, pre-existing).
- The findings and their state are in the HCP-SPEC-004 section of `docs/security/audit-report.md`.
