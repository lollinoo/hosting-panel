# M6b Security and Quality Audit: Findings and Their State

This report lists every finding of the M6b audit and what happened to it. It rests on the ten
audit reports, on ruling R207 with its seven addenda, on the two reviews of the repairs, on the last read after them, on the repair reports, and on a reading of the
code and the tests in the working tree. Where a repair report and the code differ, this report says
what the code does.

## Scope

- **What was read:** the whole repository, by ten auditors. Each auditor had one slice:
  - `aud-access`: sign-in, accounts, permissions, the audit table;
  - `aud-backups`: backups, restore, retention;
  - `aud-console`: logs, the terminal, health;
  - `aud-data`: the shared database, phpMyAdmin, site moves;
  - `aud-docs`: README, HARNESS, the ADRs, the API description, the reports;
  - `aud-exec`: the executor and its adapter, the proxy;
  - `aud-files`: the file manager and SFTP;
  - `aud-host`: the host agent, the firewall, the installer, the updater, the release archive;
  - `aud-runtime`: the queue worker, operations, the organisations controller, migrations;
  - `aud-web`: the web server and its routes.
- **The weights,** as the audit lead defined them:
  - **critical:** one customer reads or changes another customer's data, a panel secret is read,
    a program runs outside its own site, or data is lost with no way back;
  - **high:** harm beyond one's own site, a secret in clear text, an administrator locked out
    through the panel, a breach of the control-plane rules (CP-01), data that is silently wrong,
    or a load that takes the panel down;
  - **medium:** the harm needs an unlikely condition, or the product recovers from it, or a
    HARNESS rule is broken without harm, or a guard has no test;
  - **low:** any other real defect.
  - A limit already accepted in an ADR is not a finding.
- **The states:**
  - **repaired:** changed in the code, with a test. This report names the R207 item, the file,
    the test file and the test name. "Repaired" is written only after reading the change and its
    test.
  - **written as a limit:** not changed; a document says what a person cannot rely on and what to
    do instead.
  - **open:** not changed. Only medium and low findings are open, each with its reason.

### Counts

| Weight | Found | Repaired | Written as a limit | Open |
|---|---|---|---|---|
| critical | 2 | 2 | 0 | 0 |
| high | 9 | 9 | 0 | 0 |
| medium | 24 | 23 | 1 | 0 |
| low | 82 | 14 | 2 | 66 |

How the rows are counted:

- One row per finding. A finding that two auditors made is one row.
- H1 is counted as **medium**: the auditor rated it high, the lead rated it medium (see
  "H1" below). With the auditor's rating, high would read 10 found, 9 repaired, 1 written as a limit.
- A finding with two parts that were repaired at different times is two rows (M6 and M7).
- The repairs of `aud-docs`' findings in README, HARNESS, the brain notes and the API description
  were made by the documents phase (`docs-truth`). They are counted as repaired when a grep of the
  file shows the change.
- The findings of the repair phase, of the two reviews of the repairs and of the last read are
  not in this table. They have their own sections, with their own counts.
- The low rows L54 to L82 were added after the review of the documents: every row of the ten
  auditors' tables that the auditor marked "true today" and that had no line here. They are taken
  as the auditor wrote them; this report did not read each one again in the code.
- Not counted: what an auditor marked "unconfirmed", and what an auditor found to be an accepted
  ADR limit.

## Critical findings

| id | Where | What could happen | Auditor | State |
|---|---|---|---|---|
| C1 | `apps/api/src/runtime/site-provisioner.ts`, the step `redeploy` of a move to another organisation | The old organisation still knows the password of the site's own database account and can use it from another site it has on the server. | `aud-data` | **repaired** (`data.1`, with R207 addendum 1 A). The move makes a new password, has the site's configuration rewritten with it (`databasePasswordJob`, for WordPress the job `wordpress.settle`), stores it as `SITE_DB_PASSWORD` only after that job ends with exit 0 (R207 `d.3`), then `db.provision` sets it and cuts the open connections. Tests: `apps/api/test/site-databases.integration.test.ts`, "moving a site gives the site's own account and every extra account a new password, keeping databases and grants (C1)" and "a site configuration the job cannot rewrite fails the move before MariaDB changes, and a retry completes it (C1)" and "a failed password job of a move keeps the stored database password (C1)"; `apps/docker-executor/test/site-jobs.test.ts`, "wordpress.settle with the site's database password rewrites only DB_PASSWORD in wp-config.php (C1)"; `apps/api/test/site-restore-applier.integration.test.ts`, "a restore after an owner change writes the stored database password into the site's files before the address job (C1)". Limits: ADR 0021 §4 (the bullet on a site without the standard password line, and the bullet on a move that stops after the password was written into the site). |
| C2 | `apps/docker-executor/src/restore-jobs.ts`, the restore container that fetched both files and database copies | Site code swaps the folder the database copies go through; MariaDB root then replays the site's own SQL. | `aud-backups` | **repaired** (`restore.1`). No restore container mounts both the site volume and the staging volume. Test: `apps/docker-executor/test/restore-volumes-apart.test.ts`, "restore: the site volume and the staging volume never meet (C2)", one case per container and per kind of restore, and "the settle of a note at stage …". The changed pins of the restore scripts are `apps/docker-executor/test/fixtures/site-type-pins/restore-fetch.sh`, `restore-db.sh` and `restore-steps.json`. ADR 0022 §5.2 describes the new containers. |

## High findings

| id | Where | What could happen | Auditor | State |
|---|---|---|---|---|
| H2 | `apps/api/src/auth/password.ts` | A flood of sign-ins or reset confirmations fills the threads that hash passwords; every signed-in user then waits seconds. | `aud-access` | **repaired** (`limits.2`). At most 2 hashes run, at most 16 wait; one more gets `429 RATE_LIMITED` at once. Tests: `apps/api/test/password-gate.unit.test.ts`, "of 30 calls started in one tick serves 18, refuses 12 with RATE_LIMITED and never runs more than 2 scrypt at once"; `apps/api/test/login.integration.test.ts`, "a sign-in refused by the full password gate answers 429 RATE_LIMITED, writes no row and counts no try". After R207 `a.8` an address with no account holds at most 4 places and never gets 429 (see the review of the documents below). Written in ADR 0025 limit 20. |
| H3 | `apps/api/src/auth/login.service.ts`, `apps/api/src/auth/authz-context.service.ts` | Every failed sign-in and every refused request writes an audit row that nothing removes; one visitor can fill the disk. | `aud-access` | **repaired** (`limits.3`). No row for an unknown address or for a try on a locked account that is refused before any check; a checked try on a locked account keeps its row (R207 `a.3`); at most 120 refused rows per actor per minute, and the first refusal the cap drops writes one log line `audit_denied_rows_capped` (R207 `a.6`). Tests: `apps/api/test/login.integration.test.ts`, "100 sign-ins on a locked account and 100 on an unknown address add no audit row"; `apps/api/test/audit-bounds.integration.test.ts`, "200 refused requests of one user inside one minute add 120 rows; the next minute and another user still get theirs". Further tests: `apps/api/test/login.integration.test.ts`, "a bypass try with the right password and a wrong code on a locked account keeps its bad_totp row"; `apps/api/test/audit-bounds.integration.test.ts`, "the first refusal the cap drops in a window writes one log line with the actor's id and nothing of the request". Written in ADR 0025 limit 21. |
| H4 | `apps/docker-executor/src/site-databases.ts`; ADR 0021 promised a pass in M6 | Sites made on release 0.5.0 keep a database account with no connection limit and a grant written without escaping. | `aud-data` | **repaired** (`data.2`). New file `apps/docker-executor/src/db-account-upgrade.ts`, run from `apps/docker-executor/src/main.ts` each time the shared database is ready. Test: `apps/docker-executor/test/db-account-upgrade.test.ts`, "caps an old-style site account and re-grants its unescaped grant, escaped first" and "runs the plan once, and a second pass over the result changes nothing". |
| H5 | `apps/api/src/sites/site-sftp.service.ts` | One customer who keeps changing SFTP accounts keeps the shared SFTP server restarting for everybody. | `aud-files` | **repaired** (`limits.4`). At most 12 such changes per organisation per hour. Test: `apps/api/test/site-sftp.unit.test.ts`, "refuses the 13th change that restarts the shared SFTP server for one organisation in an hour, before the queue, the database and the executor". Written in ADR 0020 §4. |
| H6 | `apps/web/src/app/api/session/login/route.ts` (the sign-in route of the web server) | The route reads a body of any size into memory (the auditor ran it: 131 to 1334 MiB). | `aud-web` | **repaired** (`web.1`). Test: `apps/web/test/bff-body-bounds.test.ts`, "web.3 (b): a body that never ends is refused and its read stops at the limit". |
| H7 | 13 routes under `apps/web/src/app/api` and the helper `forwardSiteCall` (`apps/web/src/lib/bff-files.ts`) | The same, for a signed-in user (the auditor ran it: 136 to 1035 MiB). | `aud-web` | **repaired** (`web.2`, `web.3`). Tests: `apps/web/test/bff-body-bounds.test.ts`, "no route or helper calls a body reader on a request outside bff-proxy.ts", and the cases of "web.3 (b)". |
| H8 | `getOperations` in `apps/api/src/controllers/organizations.controller.ts`; `operation_steps` | The list loads every operation and one query per operation on each view of a site's page; `operation_steps` has no index; sixteen indexes of the schema are in no migration (about 120 s per request at 20 000 operations). | `aud-runtime` | **repaired** (`orgs.1`). One page in SQL, one count, one query for the steps of the page; migration `packages/database/migrations/0019_operation_step_indexes.sql`. Tests: `apps/api/test/operations-list.integration.test.ts`, "answers page 2 of 300 operations with the right rows, in order, with their steps, in as many queries as for 30"; `packages/database/test/schema-indexes.test.ts`, "creates each index that schema.ts declares, on its table". The page is read with a keyset cursor, not the `OFFSET` R207 named. |
| H9 | `createService` and `appendRevision` in `apps/api/src/controllers/organizations.controller.ts`; `validateExecutorServiceSpec` in `apps/docker-executor/src/docker-engine-adapter.ts` | A customer creates a generic service with any image and limits as large as the server, through routes ADR 0029 said only an administrator reaches. | `aud-runtime`, `aud-exec` | **repaired** (`orgs.2`, `exec.1`). Only a server administrator passes; memory above 64 GiB and CPU above 64 000 milli are refused in the API and again in the executor. Tests: `apps/api/test/admin-only-routes.integration.test.ts`, "lets an administrator who is also an owner create a service and a revision" and "refuses a revision above the ceiling with VALIDATION_ERROR and stores nothing"; `packages/policy-engine/test/policy-engine.test.ts`, "rejects resource limits above the ceiling and accepts the ceiling itself"; `apps/docker-executor/test/service-spec-limits.test.ts`, "refuses memory above 64 GiB and CPU above 64000 milli". With addendum 4 A (R207 `a.1`) the organisation check comes first again, which closes the routes to everybody on an installed server: the five answers are the cases of `describe("generic service routes and invitations are for the server administrator only")` in the same file (ADR 0029, "Il servizio generico"). |
| H10 | `apps/docker-executor/src/backup-runner.ts`, the write of the note `switched` | The panel says "nothing was changed" over a site that was changed, and an administrator's restore into a new volume deletes the restored files. | `aud-backups` | **repaired** (`restore.2`). The failure is `undo_incomplete`; staging and the created volume are kept (`keepOnUndoIncomplete`). Test: `apps/docker-executor/test/restore-runner.test.ts`, "a failed switched note write after the files switch is undo_incomplete and removes nothing: %s", for a customer's restore and for an administrator's restore into a new volume. Written in ADR 0022 §5.4. |

## H1: an administrator kept out of sign-in by a visitor

- **Where:** `apps/api/src/auth/login.service.ts` and `apps/api/src/auth/attempt-limits.ts`
  (`MAX_FAILURES = 5`, `LOCK_MS` 15 minutes).
- **What could happen:** a visitor who knows an administrator's e-mail address keeps that account
  locked: five wrong tries every 15 minutes. A try that carries a second-factor code is counted
  before the password is checked.
- **Ratings:** **high** by the auditor (`aud-access`: an administrator locked out through the
  panel). **Medium** by the lead (R207 §2). This report counts it as medium.
- **The lead's three reasons (R207 §2), in full:**
  1. Nobody is kept out of the server: SSH is not touched by sign-in.
  2. The way back into the panel exists today and no visitor can close it: `hp-accounts
     create-admin` makes a second administrator in one command, under an address that nobody
     outside knows. The lock is per account, so whoever does not know the new address cannot
     lock it.

     Reason 2 holds also during a flood of sign-ins with unknown addresses: after R207 `a.8` such a flood holds at most 4 places of the password gate,
     and a real account with the right password is served (`apps/api/test/login.integration.test.ts`,
     "with the gate held by sign-ins of unknown addresses, a real account with the right password is
     served"). Against a flood made with real accounts whose passwords are known it holds up to
     about 17 such accounts, because every password check of an account (sign-in, password change,
     second-factor removal) runs one at a time (LR-M1 below). Only an API caller (`POST /v1/auth/login` with `totpCode`) can pass a lock
     with the password and the code; the panel's sign-in form cannot. `hp-break-glass
     emergency-token` prints an API token that the sign-in form does not take: it is not a way
     back into the panel.
  3. Counting a try with a second-factor code before the password check is deliberate (ADR 0025:
     during a lock, nothing tells whether the password was right). ADR 0025 line 43 already
     accepts the same lock for a customer.
- **What the administrator does** (README "Recupero accessi", ADR 0025 limit 19), from SSH on the
  server:
  - `sudo hp-accounts create-admin --email <new-address> --name "<name>"` makes a second
    administrator under an address nobody outside knows. The password is asked in a hidden prompt.
    The command prints the second-factor key once.
  - `sudo hp-accounts unlock --email <address>` unlocks the old account. A visitor who still knows
    its address can lock it again.
- **State:** written as a limit (ADR 0025 limit 19, README "Recupero accessi"). No code changed.
- **The owner may overrule this rating.** The run's `BLOCKED.md` row 14 (a) holds the question for
  the owner.

## Medium findings

| id | Where | What could happen | Auditor | State |
|---|---|---|---|---|
| H1 | see "H1" above | An administrator kept out of sign-in by a visitor. | `aud-access` | **written as a limit**: ADR 0025 limit 19; README "Recupero accessi". |
| M1 | `POST /v1/organizations/:orgId/invitations` (`createInvitation`, `apps/api/src/controllers/organizations.controller.ts`) | An owner adds any account of the server to their organisation; an existing member gave 500. | `aud-access` | **repaired** (`orgs.3`). Only a server administrator passes; an existing member gives `409 ALREADY_EXISTS`. Test: `apps/api/test/admin-only-routes.integration.test.ts`, "lets an administrator who is also an owner invite a new account, and answers 409 for an account that is already a member". The organisation check comes first (addendum 4 A, R207 `a.1`). |
| M2 | removing a member | No test proves that a removed member loses access. | `aud-access` | **repaired** (`limits.5`). Test: `apps/api/test/member-removal.integration.test.ts`, "is refused with the token they already hold on the next request to a site of that organisation". |
| M3 | `apps/docker-executor/src/site-databases.ts`, the phpMyAdmin sign-on account | Two sites hold all phpMyAdmin workers for ever; ADR 0021 understated it. | `aud-data` | **repaired** (`data.3`). `MAX_STATEMENT_TIME 300` on the sign-on account. Test: `apps/docker-executor/test/site-databases.test.ts` (the expected `CREATE USER` and `ALTER USER` statements). ADR 0021 risk (2) corrected. |
| M4 | `apps/api/src/backups/backup-retention.ts`, `selectExpired` | A clock jumped forward deletes every copy but the newest, with no way back. | `aud-backups` | **repaired** (`restore.3`). The newest `retentionDays` good copies of an existing site are never chosen by age. Tests: `apps/api/test/backup-retention.unit.test.ts`, "R12: old pre_update copies among the newest retentionDays good copies of the site stay" and "R13: keeps the newest retentionDays good copies when now is 400 days after the newest". ADR 0022 §2 corrected. |
| M5 | `apps/api/src/backups/panel-backup-applier.ts` | The lease renewal during a long panel database dump has no test. | `aud-backups` | **repaired** (#10). Test: `apps/api/test/panel-backup.integration.test.ts`, "renews the operation lease every leaseMs/3 while a long panel dump runs and stops after it" and "stops renewing the lease when the panel dump fails". |
| M6 | `apps/docker-executor/src/docker-logs.ts` | A log read held the whole Engine answer in the executor. | `aud-console` | **repaired** (`exec.3`). The read stops after 2 MiB and closes the stream. Tests: `apps/docker-executor/test/docker-logs.test.ts`, "readCappedBody returns 2 MiB of a stream that never ends and destroys it" and "readContainerLogs returns from an Engine answer that never ends and closes it". Addendum 4 C (R207 `d.1`): what was read is given. Tests: `apps/docker-executor/test/docker-logs.test.ts`, "ends a payload cut inside a multi-byte character at the last whole one"; `apps/docker-executor/test/panel-containers-qa.test.ts`, "one line of several megabytes gives an answer of one 2000-character line, without id or host path". Past 2 MiB the oldest lines of the read are kept and the newest are missing: ADR 0026 limit 9. |
| M7 | customer log reads (`apps/api/src/sites/managed-sites.service.ts`) | No rate limit and no cap on reads at once. | `aud-console` | **repaired** (#10). At most 8 customer log reads in flight, 2 per organisation; more get `429` (`RATE_LIMITED`) before the executor is called; the administrator's read is not counted. Tests: `apps/api/test/log-read-gate.unit.test.ts`; `apps/api/test/managed-sites.integration.test.ts`, "a third log read of one organisation at once gets 429 RATE_LIMITED without reaching the executor". ADR 0026 limit 27. |
| M8 | `README.md` install and update examples | They named old releases (0.3.0, 0.2.1). | `aud-docs` | **repaired** in the documents phase (`docs-truth`); the case "m6b the README names the release it ships" of `apps/api/test/infra-layout.test.ts` keeps it. |
| M9 | `README.md` | It promised secret files `0400`; the code writes `0444` in `0700` folders. | `aud-docs` | **repaired** in the documents phase (`docs-truth`). |
| M10 | `README.md` roles table | It listed roles and consoles that do not exist. | `aud-docs` | **repaired** in the documents phase (`docs-truth`). |
| M11 | `docs/api/openapi.yaml`, `OperationDto.kind` | Four operation kinds the API returns were missing. | `aud-docs` | **repaired** in the documents phase (`docs-truth`); case "m6b the API description knows every operation kind and error code" of `apps/api/test/infra-layout.test.ts`. |
| M12 | `docs/architecture/adr/0020-site-sftp.md` §4 | Three accepted SFTP risks were not written down. | `aud-docs` | **repaired** in the documents phase: ADR 0020 §4 now has them. |
| M13 | `validateExecutorServiceSpec` in `apps/docker-executor/src/docker-engine-adapter.ts` | A service publishes any free host port, including ports of the server's own services. | `aud-exec`, `aud-runtime` | **repaired** (`exec.2`). `RESERVED_HOST_PORTS`: 22, 80, 443, 2222, 3000, 4000, 5432 and the phpMyAdmin port. Test: `apps/docker-executor/test/service-spec-limits.test.ts`, "refuses every port the server itself uses". |
| M14 | `infra/linux/nftables-dedicated.conf` | A site's code reaches the metadata address of a cloud server. | `aud-exec` | **repaired** (`host.1`, corrected by addenda 1 B and 2 A). A forward chain drops traffic from `docker0` and `br-*` to `169.254.0.0/16` (DNS port 53 passes) and to `fd00:ec2::254`. Tests: `apps/host-agent/test/m5d-host-qa.test.ts`, "the forward chain accepts by default, passes DNS and drops only bridge traffic to the metadata addresses"; `apps/host-agent/test/host-m5d.test.ts`, "reads the three sets without the forward chain as outdated, also when another table has one". Limits: ADR 0028 limits 33 and 34. |
| M15 | `apps/docker-executor/src/docker-engine-adapter.ts`, published ports | The `127.0.0.1` publish guard has no test. | `aud-exec` | **repaired** (`exec.4`). Test: `apps/docker-executor/test/service-spec-limits.test.ts`, "publishes another port on 127.0.0.1 only". |
| M16 | the proxy's static configuration | Nothing tests that the proxy dashboard and its insecure API stay off. | `aud-exec` | **repaired** (`exec.4`): an assertion of `dashboard: false` and `insecure: false` in `apps/docker-executor/test/docker-executor.test.ts`. |
| M17 | the IPC body limit | The only test of the 1 MiB limit passed without the limit. | `aud-exec` | **repaired** (`exec.4`): `apps/docker-executor/test/site-files-ipc.test.ts`, "refuses an oversized IPC body (>1 MiB) before reaching the adapter", now asserts the limit's own message. |
| M18 | the file manager's zip and unzip | The 1 GiB free-space floor has no test. | `aud-files` | **repaired** (#10). Tests: `apps/docker-executor/test/site-files-program.test.ts`, "pins the 1 GiB free-space floor and its three checks in the program", "archive refuses with disk_full one byte under the free-space floor and works at the floor" and "extract refuses with disk_full when the free space minus the declared size is one byte under the floor, and works at the floor" (the last two need PHP with ZipArchive; they run in CI). |
| M19 | `infra/release` copy filter | Nothing fails if `.next/cache`, `.next/dev` or `.next/trace` get into the archive. | `aud-host` | **repaired** (`host.2`). Test: `infra/release/release-manifest.test.ts`, "leaves .next/cache, .next/dev and .next/trace out of the archive, and nothing else". |
| M20 | `apps/api/src/runtime/outbox-worker.service.ts` (R189 3.2) | An operation still `queued` whose event failed keeps its site locked. | `aud-runtime` | **repaired** (`host.3`). It moves to `cancelled` with the failure, in one transaction. Test: `apps/api/test/outbox-queued-failure.unit.test.ts`, "still queued: the event fails, the operation is cancelled and the site takes a new action". ADR 0026 limit 24. |
| M21 | the mail upgrade (`REVISION_MOVED` guard) | The guard has no test. | `aud-runtime` | **repaired** (#10). Test: `apps/api/test/mail-relay.integration.test.ts`, "a revision added between the read and the upgrade is not overwritten; the next tick upgrades it". |
| M22 | the web server's 413 tests | They checked the status only, not that the read stopped. | `aud-web` | **repaired** (`web.3`). Test: `apps/web/test/bff-body-bounds.test.ts`, "…: 413, the stream is cancelled after about the limit, nothing reaches the API". |
| M23 | `apps/web/src/lib/server-session.ts` | A session cookie with a broken `%` code gives 500 on every BFF route. | `aud-web` | **repaired** (`web.4`). Test: `apps/web/test/session-expired.test.ts`, "a foreign cookie with a broken % code is skipped: the session still reads, and alone it means no session". |

## Low findings

An open low row has one reason unless it says another: R207 §5 keeps low findings open in the
last cycle unless a repair item names them.

| id | Where | What could happen | Auditor | State |
|---|---|---|---|---|
| L1 | `apps/api/src/auth/login.service.ts` | After 5 wrong tries, sign-in answers 423 for an existing account and 401 for an unknown one, so it tells them apart. | `aud-access` | **repaired** (#9). An address with no account counts its wrong tries in memory with the same threshold and window, so six wrong sign-ins give 401 five times and then 423 for both. Test: `apps/api/test/login.integration.test.ts`, "six wrong sign-ins give the same answers for an existing account and for an unknown address". The counter is bounded and empties on a restart (ADR 0025 limit 22). |
| L2 | `resolveSecretsMasterKey` (`apps/api/src`) | An import cycle. | `aud-access` | **open.** |
| L3 | the audit table | A user or organisation with audit rows can never be deleted; nothing removes audit rows. | `aud-access` | **open.** R207 §5 names it. Removing audit rows is a retention policy nobody has decided. |
| L4 | `apps/api/src/controllers/admin-health.controller.ts` | Restarting the shared database from Health is not refused while a restore runs. | `aud-backups` | **open.** |
| L5 | `apps/api/src/sites/managed-sites.service.ts`, the log read | A log read that timed out showed the executor's own sentence to the customer. | `aud-console` | **repaired** (`orgs.4`). Test: `apps/api/test/managed-sites.integration.test.ts`, "logs keep what the executor said away from the customer on a time-out". |
| L6 | backups of a site without a known type | The item `backup_failed` lasts for ever for such a site. | `aud-console` | **open.** |
| L7 | logs to the Logs page | Control and text-direction characters reach the page. | `aud-console` | **open.** |
| L8 | the import undo | With a deleted plan file the undo says "put back" while the imported files stay. | `aud-data` | **open.** Needs a file deleted by hand on the server. |
| L9 | phpMyAdmin uploads | The real panel cuts uploads at 300 s; the proof turned that limit off. | `aud-data` | **open.** |
| L10 | `docs/api/openapi.yaml` | No test of the repository parses the file (R201 5). | `aud-docs` | **open.** The infra-layout case added in the documents phase compares the operation kinds and error codes; a full parse is not in the repository. |
| L11 | `docs/api/openapi.yaml`, `CreateManagedSiteInput` | `includeWww` missing. | `aud-docs` | **repaired** in the documents phase (`docs-truth`). |
| L12 | `apps/api/test/infra-layout.test.ts` | No test ties the README capability table to the flags. | `aud-docs` | **repaired** in the documents phase: case "m6b the capability table of the README agrees with the flags". |
| L13 | `infra/linux/accept-m6-site-type.mjs` | No acceptance report records a run of it (E6). | `aud-docs` | **repaired** (in the documents). The run of 2026-11-17 on the final tree is recorded in `docs/security/step-6-acceptance-report.md`, section "M6b": 15 checks passed, 0 failed, 1 skipped (the real SFTP login of a type whose files belong to group 1000, ADR 0029 limit 5). |
| L14 | `docs/security/step-6-acceptance-report.md`, opening | The opening sentence was stale. | `aud-docs` | **repaired** in the documents phase. |
| L15 | `docs/security/step-4-acceptance-report.md`, `docs/security/step-2b-*.md` | They describe the machines they ran on (a client build string, lab addresses). | `aud-docs` | **open.** Outside the files of this documents phase; no secret is in them. |
| L16 | `README.md`, `HARNESS.md`, `.agents/brain/state.md`, `pnpm-workspace.yaml` | Stale counts and lists; an unused `bullmq` catalog entry. | `aud-docs` | **open** for this report: the documents phase (`docs-truth`) owns these files; this report did not check each line. |
| L17 | `.agents/brain/decisions.md` item 12; ADR 0029 line 21 (E1); ADR 0029 limit 19 | A wrong sentence about `releaseImages`; "thirteen reads" that cannot be counted; line numbers that drifted. | `aud-docs` | **repaired** in the documents phase for ADR 0029 (no count, file names instead of line numbers). `decisions.md` belongs to `docs-truth`. |
| L18 | `apps/api/test/site-type-boundary.test.ts` (D2) | The allow entry for `file-browser.ts` matched with `includes`. | `aud-docs` | **repaired** (`orgs.5`). Test: "the allow line of file-browser.ts covers that exact line only (R206 addendum 2)". |
| L19 | ADR 0029 line 137 (D3) | It said the boundary scan needs no work for a new type. | `aud-docs` | **repaired** in the documents phase (ADR 0029 §7). |
| L20 | the proxy container | No memory limit and no read-only root. | `aud-exec` | **open.** |
| L21 | the shipped executor | It starts the simulator under production settings. | `aud-exec` | **open.** |
| L22 | the simulator | Its purge and restart differ from the real executor. | `aud-exec` | **open.** Tests only. |
| L23 | the certificate status | One bad certificate entry makes the whole status unreadable. | `aud-exec` | **open.** |
| L24 | the file manager, recursive delete | No depth limit; it can stop half-way. | `aud-files` | **open.** |
| L25 | file names and paths | Text-direction characters are allowed. | `aud-files` | **open.** |
| L26 | unfinished uploads | Their hidden files are swept only when a helper is created. | `aud-files` | **open.** |
| L27 | unzip | An unzip killed at its time limit leaves half the files, and a retry is refused. | `aud-files` | **open.** |
| L28 | `apps/api/src/sites/site-sftp.service.ts` | The SFTP page of a site without a known type still reads the server's SFTP status. | `aud-files` | **open.** |
| L29 | `infra/linux/accept-m6-site-type.mjs`, `sftp-real-login` | The step can only skip. | `aud-files` | **open.** |
| L30 | `apps/docker-executor/test/site-files-helper.test.ts` | The case `stale_stopped` was not seeded with its binds. | `aud-files` | **repaired** (`exec.5`). |
| L31 | ADR 0028 limit 16 | It said 120 s; the code gives up after 60 s. | `aud-host` | **repaired** in the documents phase (ADR 0028 limit 16). |
| L32 | the release archive | It ships source maps and the build machine's absolute path. | `aud-host` | **open.** |
| L33 | the release archive, the host agent | The demo seed and the agent simulator ship; the agent does not refuse the simulator in production. | `aud-host` | **open.** |
| L34 | `infra/linux/install.sh`, `infra/linux/bootstrap-dedicated.sh` | `apt-get` does not wait for the package-manager lock. | `aud-host` | **open.** |
| L35 | the installer tests | They check only part of the OS package list. | `aud-host` | **open.** |
| L36 | `infra/linux/bootstrap-dedicated.sh` | After an update from the Updates page, the "base firewall rules changed" line goes only to the journal, and no test checks it. | `aud-host` | **written as a limit**: ADR 0028 limit 27. No test was added. |
| L37 | PostgreSQL | `listen_addresses` is never set; no test checks that it listens only locally. | `aud-host` | **open.** |
| L38 | `infra/linux/update.sh` | Its refusal of test overrides under root has no test. | `aud-host` | **open.** |
| L39 | `apps/api/src/sites/site-domains-applier.ts` | The `wordpressUrl` audit key is not pinned by a test. | `aud-runtime` | **open.** |
| L40 | `packages/database/src/client.ts` | The migration runner takes no advisory lock. | `aud-runtime` | **open.** |
| L41 | `apps/docker-executor/src/docker-engine-adapter.ts` (R192 3) | Stop, then Restart, breaks `secretRefs`. | `aud-runtime` | **repaired** (#7). Restart sends the secrets and the executor writes the files again before Docker restarts the container. Tests: `apps/docker-executor/test/service-secrets-reboot.test.ts`, "stop, then restart, writes the secret files again (L41)"; `apps/api/test/service-restart-secrets.integration.test.ts`. ADR 0027 limit 24. |
| L42 | `apps/api/src/runtime/outbox-worker.service.ts`, the ambiguous branch | The engine's sentence is stored in public answers. | `aud-runtime` | **open.** |
| L43 | `createService` (`initialDomain`) | The generic service's first domain is not normalised or checked against hosts. | `aud-runtime` | **repaired** (#116). The route that takes `initialDomain` is `createSite` in `apps/api/src/controllers/organizations.controller.ts`: it now asks `platform.users.manage` after `site.create`, as `createService` does; `CreateSiteInputSchema.initialDomain` is `SiteDomainSchema`, the typed route's normalisation, and the handler calls `assertNewSiteAddressesFree` (`apps/api/src/sites/managed-sites.service.ts`), the typed route's check against other sites and the servers, with its `409 DOMAIN_CONFLICT`; a refusal inside the transaction (an application's address, which the database trigger refuses, or a manual certificate that captures it) goes through `newSiteError`, the typed route's mapping. `site.create` is a support visit's permission, but the route refuses a visit (`refuseSupportVisit` of `requireOrgPermission` in `apps/api/src/auth/authz-context.service.ts`): an administrator on an open visit gets `createService`'s `403` and its `SUPPORT_ACCESS_PERMISSION_DENIED` row (ADR 0029 §2). Tests: `apps/api/test/admin-only-routes.integration.test.ts`, "stores an administrator's first domain of a site the way the typed route writes it (L43)" and "refuses an administrator's first domain the typed route refuses, with the typed route's error, and stores nothing (L43)" and "refuses an administrator's first domain that is an application's address with the typed route's 409, not a 500 (L43)", and the cases of "a site" in `describe("generic service routes and invitations are for the server administrator only")`. |
| L44 | `#refuseManagedSite` (E9) | An unknown `site_type` is handled as a generic service. | `aud-runtime` | **written as a limit**: ADR 0029 §2 says it is the rule ("Un sito senza tipo noto non è gestito"). |
| L45 | `apps/web/next.config.mjs` | No HSTS, `nosniff` or `Referrer-Policy` headers. | `aud-web` | **repaired** (#115). `headers()` in `apps/web/next.config.mjs` sends `X-Content-Type-Options: nosniff` and `Referrer-Policy: same-origin` with the frame headers on every path but `/phpmyadmin/`, whose pages and relay pages send them already, and `Strict-Transport-Security: max-age=15552000` on every path, without `includeSubDomains` or `preload`; a browser ignores it over plain HTTP or on an IP address. The proxy's own answers do not carry the three headers: its redirect from port 80 and its `502` / `504` pages when the web server does not answer. Tests: `apps/web/test/next-config.test.ts`, "sends nosniff, a same-origin referrer and HSTS without includeSubDomains on pages and /api/ (L45)" and "leaves phpMyAdmin's own nosniff and referrer headers alone and adds only HSTS there (L45)". |
| L46 | the web server's sign-in route | No Origin check; `text/plain` is accepted. | `aud-web` | **repaired** (#114). The routes without a session (sign-in with its second step, sign-out, password reset request and confirmation) refuse a missing or foreign `Origin` with `403 PERMISSION_DENIED` (`validateOrigin` in `apps/web/src/lib/bff-guard.ts`, the check the CSRF guard uses), and `readBoundedJsonBody` refuses a body not sent as `application/json` with `415` before it reads it. Tests: `apps/web/test/bff.integration.test.ts`, "17. sign-in and sign-out refuse a foreign Origin, a missing Origin and a body not sent as JSON before the upstream (L46)"; `apps/web/test/password-reset.test.ts`, "request: …" and "confirm: a foreign Origin, a missing Origin and a body not sent as JSON are refused before the upstream (L46)"; `apps/web/test/bff-body-bounds.test.ts`, "web.6: a JSON body is read only when it comes as application/json (L46)"; `apps/web/test/bff-guard.test.ts`, "validateOrigin". |
| L47 | `bff-guard.ts` (R172.1) | The CSRF and Origin refusals share `PERMISSION_DENIED`. | `aud-web` | **open.** |
| L48 | `packages/contracts/src/resources.ts`, the redaction patterns | `secretAccessKey`, `newPassword`, `currentPassword`, `smtpPassword` and `totpSecret` are not matched. | `aud-web` | **open.** R207 §5: no path was found that stores one; a wider pattern can make a shipped answer throw. |
| L49 | `apps/web/src/components/customer/site-tabs.tsx` | Tabs on a site without a type. | `aud-web` | **repaired** (#116). `SiteTabs` takes `managed`, and the site layout (`apps/web/src/app/sites/[siteId]/layout.tsx`) passes false for a site with no known type, which then shows only the overview tab: the other tabs are hidden (ADR 0029 §2). Test: `apps/web/test/site-types.test.ts`, "a site without a type gets only the overview tab and no header button, and keeps its visit link (L49)". |
| L50 | `operation-timeline.tsx`, `site-progress.tsx` | Polling ignores a hidden tab and stacks requests. | `aud-web` | **open.** |
| L51 | `apps/web/test/ui-copy.test.ts` | The vocabulary test missed `common`, `errors` and the Italian words. | `aud-web` | **repaired** (`web.5`). Test: "reads every catalog section but the administrator's (a new section must be classified), and knows the Italian words". |
| L52 | four web tests | They reach into React internals. | `aud-web` | **open.** |
| L53 | the web server | Node's request time limit of 300 s. | `aud-web` | **open.** |
| L54 | `admin-audit.controller.ts`, old audit rows | Rows written before the repairs may hold fragments of a database password; no tool removes them. Whether any exist was not settled. | `aud-access` | **open.** |
| L55 | `backup-runner.ts` (about line 2660), `backup-jobs.ts` (about line 26) | A backup that waits 24 hours for the database and then sees the executor restart ends as interrupted. | `aud-backups` | **open.** |
| L56 | the real-Docker restore script | It does not assert `restore_invalid_object_name`. | `aud-backups` | **open.** |
| L57 | `restore-jobs.ts` (about line 355) | When the header and the import both fail, the import's error is the one reported. | `aud-backups` | **open.** |
| L58 | `restore-jobs.ts` (about line 1014) | A failed note write leaves a `.tmp` file. | `aud-backups` | **open.** |
| L59 | restore notes | No test for a failed note delete (`restore_note_remove_failed`). | `aud-backups` | **open.** |
| L60 | the settle worker | Its second write has no test. | `aud-backups` | **open.** |
| L61 | `panel-fetch.ts` (about line 105) | SIGHUP is not handled. | `aud-backups` | **open.** |
| L62 | `backup-runner.ts` (about line 573) | No log line when the forced removal of the fetch container fails. | `aud-backups` | **open.** |
| L63 | `restore-panel.sh` (about line 165) | The output of `psql` and `pg_restore` reaches root's terminal. | `aud-backups` | **open.** |
| L64 | `restore-panel.sh` | A copy restored on another server changes its role's password (it needs `backup.key`). | `aud-backups` | **open.** |
| L65 | `restore-panel.sh` (about line 154) | A "y" typed early answers the question. | `aud-backups` | **open.** |
| L66 | `restore-panel.sh` (about line 140) | Step 3 runs as root. | `aud-backups` | **open.** |
| L67 | `backup-runner.ts` (about line 1495) | K3a: two creates at once can race. | `aud-backups` | **open.** |
| L68 | restore notes | K3c: a flagged note past its lifetime leaves an empty volume. | `aud-backups` | **open.** |
| L69 | the key setup | K4: the key is placed before the marker; a rerun repairs it. | `aud-backups` | **open.** |
| L70 | the nightly tick | No test that a settled stuck backup frees the nightly tick. | `aud-backups` | **open.** |
| L71 | `restore-panel.sh`, step 1 | An IPv6 literal or query options in `DATABASE_URL` are not read. | `aud-backups` | **open.** |
| L72 | the systemd units | No `NoExecPaths` hardening. | `aud-backups`, `aud-host` | **open.** |
| L73 | `backup-runner.ts` (about line 902) | restic exits 0 with a summary that cannot be read. | `aud-backups` | **open.** |
| L74 | `backup-runner.ts` (about line 2497), `panel-jobs.ts` (about line 40) | If `_pdrop` fails after an upload that exits 3, the newest panel copy can be incomplete, and `--latest 1` picks it. | `aud-backups` | **open.** |
| L75 | `backups-repository.ts` (about line 770) | The administrator's list shows a site with no known type; a run on it answers 404. | `aud-backups` | **open.** |
| L76 | `site-databases.ts` (about line 400) | A stop between CREATE and GRANT leaves an account without rights until the next sign-on. | `aud-data` | **open.** |
| L77 | `docker-engine-adapter.ts` (about line 1826) | A recreated `hp_mariadb` is joined to `hp_pma_net` again only at the next sign-on. | `aud-data` | **open.** |
| L78 | `ipc-schemas.ts` | An executor older than the API is not detected; no version check. | `aud-data` | **open.** |
| L79 | the terminal | Its opening lock was never tested on a real PostgreSQL. | `aud-console` | **open.** |
| L80 | `bootstrap-dedicated.sh` (about line 144) | No test asserts the dry-run line of the refreshed rules file. | `aud-host` | **open.** |
| L81 | `install.test.ts` | Port 3000 is asserted in the install case only. | `aud-host` | **open.** |
| L82 | E4 install and update dry-run tests | They skip without cgroups v2 or Docker. | `aud-host` | **open.** |

Low rows: 82. Repaired 17 (in the code with a test: L1, L5, L18, L30, L41, L43, L45, L46, L49, L51; in the
documents: L11, L12, L13, L14, L17, L19, L31). Written as a limit: 2 (L36, L44). Open: 63 (L2 to L53 less
the eighteen others above, and L54 to L82).

## Findings the lead judged not a defect

| What | Auditor | Reason |
|---|---|---|
| The image of a generic service is any image. | `aud-runtime`, `aud-exec` (part of H9) | R207 `orgs.2`: the image stays the administrator's choice; with the routes closed to customers, a rule on tags would only break what an administrator may rightly deploy. |
| H1 rated high. | `aud-access` | Rated medium (R207 §2); see "H1". |
| Three things `fix-limits` built differently (R207 addendum 3 E): an admitted sign-in may wait when more than 16 wait; with the gate full a locked account answers 423 (an unknown address answered 429 then; after R207 `a.8` it gets 401 at once); two first SFTP accounts at the same instant count twice. | the repair phase | Judged by the review of the repairs (see below). Each is written in ADR 0025 limit 20 or ADR 0020 §4 as built today. |

Accepted ADR limits that auditors confirmed (for example ADR 0019 "Corsia dedicata", ADR 0020
R18, ADR 0028 limits 2 and 29) are not findings and are not listed.

## Findings of the repair phase

| id | Where | What | State |
|---|---|---|---|
| R207 add. 1 A | `data.1` | WordPress reads its database password from `wp-config.php`, so a new password plus a redeploy would leave the site without its database. | **repaired**: the move and the restore run the type's `databasePasswordJob` (`wordpress.settle`, secret `HP_DB_PASSWORD`). Tests as C1. ADR 0021 §4, ADR 0029 §5. |
| R207 add. 1 B | `apps/host-agent/src/firewall-sets.ts`, `parseFirewallListing` | An updated server running the old table would have said `current` and hidden **Apply base rules**. | **repaired**: a listing without the chain `forward` is `outdated`. Test: `apps/host-agent/test/host-m5d.test.ts`, "reads the three sets without the forward chain as outdated, also when another table has one". |
| R207 add. 2 A | `infra/linux/nftables-dedicated.conf` | The first `host.1` dropped all traffic to `169.254.0.0/16`, which cuts name resolution on clouds whose resolver lives there. A correction of the first repair. | **repaired**: port 53 (UDP and TCP) passes. Test: `apps/host-agent/test/m5d-host-qa.test.ts`, "the forward chain accepts by default, passes DNS and drops only bridge traffic to the metadata addresses". Pinned hash `2f1e6d14fabd435ffde4e222e99072017077d2015ec56883e40dc075f5d9fd1d` (`apps/host-agent/src/nftables-baseline.ts`). Limits: ADR 0028 limits 33 and 34. |
| R207 add. 2 D | `linux-adapter.ts`, `firewall.sync()` in `outbox-worker.service.ts` | A press of **Apply base rules** empties the three sets for a moment; if the second command fails, the entries stay out until the next change, **Applica di nuovo** or the next API start. | **open, low.** Written as ADR 0028 limit 3. |
| R207 add. 4 A | `createService`, `appendRevision`, `createInvitation` (`organizations.controller.ts`) | As built, a server administrator with no visit can add any account to a customer's organisation and create a service or revision inside a customer's site. Caught by the shipped test `apps/api/test/support-access-tenancy.integration.test.ts` (5 of 6 red). | **repaired** (R207 `a.1`). The organisation check comes first, then the platform permission `platform.users.manage`. Tests: `apps/api/test/admin-only-routes.integration.test.ts`, the cases of `describe("generic service routes and invitations are for the server administrator only")`; `apps/api/test/support-access-tenancy.integration.test.ts`, "without a visit, with a closed one, and on any other organization: 404 and no audit row on every route". ADR 0025, ADR 0029. |
| R207 add. 4 B | `authz-context.service.ts` (the cap of refused rows) and the same tenancy test | The test's last case writes more than 120 refused rows of one actor in a minute, so rows it reads are not written. | **repaired** (R207 `a.2`). The cap stays at 120; the test empties the cap's memory (`deniedWindows`) before each case. Addendum 4 B calls the cap `limits.4`; in R207 §3 it is `limits.3`. |
| R207 add. 4 C | `apps/docker-executor/src/docker-logs.ts` (`exec.3`) | One log line longer than 2 MiB gives an empty answer (shipped case in `apps/docker-executor/test/panel-containers-qa.test.ts` is red). | **repaired** (R207 `d.1`). What was read is given; a cut line is clamped to 2000 characters. Tests: `apps/docker-executor/test/docker-logs.test.ts`, "ends a payload cut inside a multi-byte character at the last whole one"; `apps/docker-executor/test/panel-containers-qa.test.ts`, "one line of several megabytes gives an answer of one 2000-character line, without id or host path". ADR 0026 limit 9. |
| R207 add. 4 D | `apps/api/test/backups-restore-qa.integration.test.ts`, case E7 | The test's job handler answers exit 1 to every kind except one, so the new `wordpress.settle` of a restore fails. | **repaired.** The handler answers exit 1 only to `wordpress.set-url`. Test: "runs wordpress.set-url once on success (E7), tolerates its failure as address_not_updated, and skips it on failed restore". A test change; no product code. |
| docs-1 | `apps/api/src/controllers/account.controller.ts` (password change, second-factor disable) | A password try is reserved before the hash gate, so a `429 RATE_LIMITED` there still costs the user one of five tries. Found by `docs-truth` in the documents phase. | **repaired** (R207 `a.4`). Both routes look at the gate before they count a try. Test: `apps/api/test/account.integration.test.ts`, "with the password gate full, changing the password or turning off 2FA answers 429 and counts no try". |

Repair phase: 9 rows. Repaired 8, open 1 (R207 add. 2 D, low).

## Findings of the two reviews of the repairs

Two reviews read the repairs of R207: one of the code, one of the documents. Their findings are
counted here, not in the counts above. The lead's rulings on them are R207 addenda 5 to 7.

### Review of the code

| id | Weight | What | State |
|---|---|---|---|
| CR-M1 | medium | A checked bypass try on a locked account wrote no row. | **repaired** (R207 `a.3`). Test: `apps/api/test/login.integration.test.ts`, "a bypass try with the right password and a wrong code on a locked account keeps its bad_totp row". |
| CR-M2 | medium | The password change and the second-factor disable counted a try before the gate refused (docs-1). | **repaired** (R207 `a.4`). Test: `apps/api/test/account.integration.test.ts`, "with the password gate full, changing the password or turning off 2FA answers 429 and counts no try". |
| CR-M3 | medium | A sure failure of the restore's password job was reported as a clean undo. | **repaired** (R207 `d.2`): it is `undo_incomplete`. Test: `apps/api/test/site-restore-applier.integration.test.ts`, "a restore after an owner change writes the stored database password … (C1)". ADR 0022 §5. |
| CR-M4 | medium | The move stored the new database password before the job wrote it into the site. | **repaired** (R207 `d.3`): stored only after the job succeeds. Test: `apps/api/test/site-databases.integration.test.ts`, "a failed password job of a move keeps the stored database password (C1)". What is left is CR-L9. |
| CR-L1 | low | While the SFTP budget was spent, the removal of an account was refused too. | **repaired** (R207 `a.5`). Test: `apps/api/test/site-sftp.unit.test.ts`, "with the twelve changes of the hour spent, a removal still reaches the executor and is counted, a new account and a new password answer 429". ADR 0020 §4. |
| CR-L2 | low | A sign-in already admitted to the gate may wait beyond the 16 places. | **written as a limit** (ADR 0025 limit 20). Test: `apps/api/test/password-gate.unit.test.ts`, "lets 30 admitted calls wait beyond the bound, never runs more than 2, and refuses a plain call while more than 16 wait". |
| CR-L3 | low | A refusal the cap drops left no trace. | **repaired** (R207 `a.6`): one log line `audit_denied_rows_capped`. Test: `apps/api/test/audit-bounds.integration.test.ts`, "the first refusal the cap drops in a window writes one log line with the actor's id and nothing of the request". ADR 0025 limit 21. |
| CR-L4 | low | The vocabulary test did not know some Italian words of the server's inside. | **repaired** in the documents phase: `apps/web/test/ui-copy.test.ts` knows `servizio`, `rete`, `revisione`, `organizzazione` and their plurals. |
| CR-L5 | low | The route index test checks names only, and its static scan misses a body read written `req["json"]()`. | **open.** |
| CR-L6 | low | A failed log read keeps no trace of its cause: the executor error becomes the fixed sentence and is logged nowhere (`apps/api/src/sites/managed-sites.service.ts`, the `catch` of the log read). | **open.** |
| CR-L7 | low | A generic service made by 0.5.0 with limits above the ceiling or on a reserved port is not re-created if its container disappears. | **open.** Written in ADR 0029 limit 20 and in the README update part. |
| CR-L8 | low | A site operation cancelled by the outbox before it starts leaves the site `deploying` or `maintenance`. | **open.** Written in ADR 0026 limit 26. |
| CR-L9 | low | A move whose `db.provision` fails after the job wrote the new password into the site leaves the site with a password MariaDB does not have. | **open.** Written in ADR 0021 §4. |
| CR-L10 | low | After an unclear failure of the move's password job, or a store that fails, the site holds a password neither the store nor MariaDB has (R207 `d.3`, addendum 7). | **written as a limit** (ADR 0021 §4: try the move again). |

Code review: 14 rows. Medium 4, all repaired. Low 10: repaired 3 (CR-L1, CR-L3, CR-L4), written as
a limit 2 (CR-L2, CR-L10), open 5 (CR-L5 to CR-L9).

What the code review could not confirm, and where each is written:

- The old organisation's SFTP sign-in may last one interval after a move whose SFTP apply failed:
  ADR 0020 §4.
- `KILL USER` of the site's account, the reach of the account upgrade pass, and an account made by
  hand that matches the site prefix: ADR 0021 §4.
- A few seconds between the files switch and the password rewrite of a restore, and exit 20 of a
  backup made before a move: ADR 0022 §5.
- A restore settled at the stage `prepare`, and the phpMyAdmin forwarder: not written; no defect
  was shown.
- Migration `0019_operation_step_indexes.sql` on large tables was not measured.
- A generic service of 0.5.0 can still be started after the update (no test): ADR 0029 limit 20,
  README.
- The base rules on a real kernel and Ubuntu's `nft` reading the file: see "What only the owner
  can check".

### Review of the documents

| id | Weight | What | State |
|---|---|---|---|
| DH1 | high | A flood of sign-ins with unknown addresses filled the password gate, so every account, the administrator's and the one made by `hp-accounts create-admin` included, got `429`. | **repaired** (R207 `a.8`). Tests: `apps/api/test/login.integration.test.ts`, "with the gate held by sign-ins of unknown addresses, a real account with the right password is served", "of many sign-ins of unknown addresses started in one tick, at most 4 reach the gate and none writes a row" and "an unknown address answered at once and one answered after a check get the same answer"; `apps/api/test/password-reset.integration.test.ts`, "with the gate full, a confirmation with a token that does not exist answers invalid at once and starts no hash". ADR 0025 limits 20 and 22 to 27. |
| DM1 | medium | ADR 0025 limit 19 said the right password and code pass a lock; from the panel's sign-in form they do not (only an API caller passes). | **repaired**: ADR 0025 limit 19 says so; see "H1". The sentence that `hp-break-glass` is a way back into the panel (withdrawn by R207 addendum 6) is gone from ADR 0025, the README and this report. |
| DM2 | medium | Low rows of the auditors were missing from this report. | **repaired**: rows L54 to L82. |
| DL1 | low | The README update part did not say what else changes from 0.5.0. | **repaired**: README "Dalla 0.5.0, cos'altro cambia". Test: `apps/api/test/infra-layout.test.ts`. |
| DL2 | low | The version is still 0.5.0. | **repaired** after the audit: the release commit raises the root version to `0.6.0` (see "The owner's release step"). |
| DL3 | low | The layout test only looked for a sentence of this report. | **repaired**: `apps/api/test/infra-layout.test.ts` reads the tables of this report. |
| DL4 | low | "Open high or critical findings: 0" stood above the table that proves it. | **repaired**: it stands under the table. |

Documents review: 7 rows. High 1, repaired. Medium 2, repaired. Low 4: repaired 4 (DL2 by the release commit, after the audit).

The rows of R207 `a.8` that the lead judged low and written as a limit (addendum 6 §1 and the
lead's ruling at the start of the documents phase), each in ADR 0025:

| Limit | What | State |
|---|---|---|
| ADR 0025 limit 22 | Signs of whether an address has an account (the 423 sign is repaired: L1); on a locked account with the second factor a sign-in with a code still runs a check, and a full gate answers `429` only to real accounts. | **written as a limit.** |
| ADR 0025 limit 23 | During a flood a mistyped address gets "wrong e-mail or password" at once. | **written as a limit.** |
| ADR 0025 limit 24 | A flood made of many real addresses is bounded by each account's counters and one password check at a time per account (sign-in, password change, second-factor removal); about 18 accounts with known passwords fill the gate; no limit per visitor (`BLOCKED.md` row 16). | **written as a limit.** |
| ADR 0025 limit 25 | Parallel confirmations of one live reset token each run a hash. | **written as a limit.** |
| ADR 0025 limit 26 | The token of an account disabled or made an administrator stays live until it expires. | **written as a limit.** |
| ADR 0025 limit 27 | The share of 4 counts every check in the gate. | **written as a limit.** |

These are 6 low rows, all written as a limit.

### The last read

Two reviewers read the last repairs (`a.1` to `a.8`, `d.1` to `d.3`) and the documents written
after them. No engineer worked after them. The sentences marked "repaired (the sentence)" were
corrected by the lead as the reviewer proposed, and no reviewer read them afterwards.

| id | Weight | What | State |
|---|---|---|---|
| LR-M1 | medium | `apps/api/src/auth/login.service.ts`: a right password sets the try counter back, so about five accounts whose passwords are known, each with up to five sign-ins in flight, keep the password gate full with no lock; while it lasts every other sign-in gets `429` on most tries, the administrator's and the one of an account made by `hp-accounts create-admin` included. The reviewer proved it with a test kept outside the repository; a timed flood on a server was not run. R207 addendum 6 and ADR 0025 limit 24 said such a flood takes thousands of accounts. | **repaired**. Every password check of one account (sign-in, `POST /v1/me/password`, `POST /v1/me/totp/disable`) runs one at a time, so an account holds at most one place of the password gate. Test: `apps/api/test/login.integration.test.ts`, "sign-ins of a few accounts with known passwords hold one place of the gate each, so another account is served"; `apps/api/test/password-check-serial.integration.test.ts`, "wrong password changes, 2FA off and a sign-in of one account hold one gate place; another account is served meanwhile". About 18 accounts with known passwords can still fill the gate (ADR 0025 limit 24). |
| LR-L1 | low | `sshRepair` in both catalogs named `hp-break-glass` as a repair for an administrator's lost password or second factor. | **repaired** (the sentence). |
| LR-L2 | low | The "H1" block of this report kept the withdrawn break-glass sentence, and row DM1 named the wrong finding. | **repaired** (the sentences). |
| LR-L3 | low | Row "R207 add. 4 C" named a test that was green before the repair as proof of `d.1`. | **repaired** (the sentence). |
| LR-L4 | low | The limit of `d.3` had no row of its own. | **repaired**: row CR-L10. |
| LR-L5 | low | Row CR-L6 described another finding than the reviewer made. | **repaired** (the sentence). |
| LR-L6 | low | README, on the three actions closed to everyone: wrong answer codes for a visit that ran out and for a customer of another organisation. | **repaired** (the sentence). |
| LR-L7 | low | The administrator's two `undo_incomplete` sentences said an undo failed after a failed password step, where none runs. | **repaired** (the sentences, in both catalogs and in the alert table of ADR 0026). |

Last read: 8 rows. Medium 1, repaired. Low 7, all repaired.

Not confirmed by the last read, and by nobody since: that the owner of a generic service made on
0.5.0 can still start it (README "Dalla 0.5.0", ADR 0029 limit 20; read in the code, no test),
and how an administrator looks at those services after the update (the reader found no
administrator page that lists them and did not look further).

## What was not audited or could not be proved

- **The firewall** ran with a real `nft` only inside a throw-away container, never on a server.
- **No cloud metadata service** was reached. The forward chain was checked inside that container
  only, not on a real cloud server.
- **No real S3 store** was used.
- **The load findings** (H2, H6, H7, H8) rest on reasoning, counted queries and the auditors' own
  runs on one machine. No load test of a whole installed server was run.
- What each auditor wrote under "Unconfirmed" stays unconfirmed. Examples: how restic follows a
  folder swapped during a restore (`aud-backups`); two API processes at once (`aud-runtime`); the
  terminal session of one administrator written to by another (`aud-access`).
- The engineers of the repair phase did not run the real-Docker scripts. The lead ran all twelve
  on the final tree: see "Runs of the lead".

## What only the owner can check

- **The base rules on a real kernel, next to Docker's chains.** The rules file was loaded only
  inside a throw-away container. On an installed server, check after the update that sites answer,
  that a site reaches the internet and name resolution, and that **Firewall** says `current`.
- **Ubuntu's `nft` reading the file.** The file was read by the `nft` of the test container, not by
  the one of the supported Ubuntu release. On a test server, run the updater and read its log.

## The owner's release step

- Done after the merge: the root version is `0.6.0` (DL2), in a commit of its own, and the README's
  install and update examples name it. Every run in this report was made on `0.5.0`, before that
  commit. The tag `v0.6.0` starts `.github/workflows/release.yml`, which had never run before.
  Later note: `release.yml` was removed when the devflow workflow was installed (#22), and pushing
  a tag no longer starts a release. `.github/workflows/devflow-release.yml` now runs after every
  merge on `main`: it bumps the version, creates the draft release `v<version>`, runs the tests on
  that commit, attaches the archive and only then publishes the release. A merge that changes
  only documents, tests or the workflow tooling makes no release.

## Runs of the lead

The lead ran these on 2026-11-17 with Node 26.13.1, one after another on one machine, on the
tree after the last read and after the lead's corrections of its sentences.

- **The four sensors** (build, lint, typecheck, test): each at exit 0. 229 test files, 4140 tests
  passed, 43 skipped, 0 failed.
- **The release build and its smoke:** both at exit 0. The archive is
  `hosting-panel-0.5.0-linux-x64.tar.gz` (116.8 MiB) and the smoke ends with `smoke: PASS`.
- **The twelve real-Docker scripts** (`infra/linux/accept-*.mjs` in the tree of the runs): each at
  exit 0 with no failed check, and none of their containers, volumes or networks was left behind.
  One check was skipped, in `accept-m6-site-type.mjs` (see L13). The result of each script is in
  the M6b section of `docs/security/step-6-acceptance-report.md`. The thirteenth script,
  `accept-acme-pebble.mjs` (DNS-01, ADR 0030, no Docker), came after these runs and is not one of
  them.

These lines were written after the runs. When they were written, only this report, the
acceptance report and one sentence of `.agents/brain/state.md` differed from the tree of the runs.
The repairs marked #7, #9 and #10 and DNS-01 (ADR 0030) came later: these runs do not cover them,
and the tests their rows cite did not exist in the tree of the runs.

## Runs on a real server (2026-11-20)

The lead ran these on a fresh Ubuntu 24.04.5 VPS (4 CPU, 7.7 GB, Docker 29.10.0, nftables 1.0.9),
on the tree of pull request #13, with `infra/linux/install.sh --acme-staging` and the server's public
name under a wildcard DNS service. The findings below are not in the counts above.

- **The twelve real-Docker scripts:** ten at exit 0 at once. `accept-m3-panel.mjs` and
  `accept-m4-wordpress.mjs` failed on assumptions of the scripts, not of the product: the first
  wanted the user in group 30, the second took the word `core` of the constant update script for a
  value once WordPress 7.1.5 existed. After the repair of the two scripts: 13/13 and 12/12, nothing
  left behind.
- **`accept-m7-secrets-reboot.mjs`** (new, #7 on the real engine): 8/8. After a simulated reboot,
  Docker answers 400 "not a directory" and leaves a root-owned folder for the service and each secret;
  Restart and Deploy with the secrets set the folder aside and the container runs with the right
  values. A Restart without the secrets ends in the coded error `DOCKER_ENGINE_UNAVAILABLE` (Docker
  refuses the folder), never a crash; the API always sends them.
- **The installer:** exit 0. Let's Encrypt staging certificates for the panel and for a site, both
  through HTTP-01, the site's about a minute after it was made.
- **#8:** a session with a temporary password gets `403 PASSWORD_CHANGE_REQUIRED` on GET and POST
  routes, reads `GET /v1/me`, changes the password, then works with the same token.
- **DNS-01** (httpreq with an endpoint that does not exist and a marker as password): the files are
  0400 `hp-executor` in the 0700 tmpfs folder, the proxy gets only the `_FILE` entries and a read-only
  bind; a dns-01 domain whose A record points elsewhere is ordered at once and ends `failed` with
  `dns_provider` and a retry 15 minutes later. The marker is in no `docker inspect`, file under
  `/var/lib/hosting-panel` or `/etc/hosting-panel`, journal line, proxy log line or `pg_dump`.
- **SFTP on 2222** from the public address: the host key matches the one the API shows, the upload
  works and the site serves the file.

| ID | Where | What | Found by | State |
|---|---|---|---|---|
| RS1 | `apps/host-agent/src/linux-adapter.ts`, `replaceFirewallSets` | Every port opened or closed and every address blocked in the panel stayed "Saved, not active": `nft -f -` refuses the socket Node gives a child as stdin ("Not a regular file: /dev/stdin"). The unit tests replace the runner and `accept-m5-firewall.mjs` gives nft a pipe, so neither saw it. | lead (real server) | **repaired.** The program goes to a 0600 file in a new folder of the agent's private `/tmp`, nft reads that file, the folder is removed afterwards. Tests: `apps/host-agent/test/host-m5d.test.ts`, "replaces the sets through nft -f on a 0600 file of its own, removes the file and answers a fresh read" and "removes the program file and its folder when nft fails, and answers the fixed sentence". On the server (the installed release with the repaired file copied in): ports 8080 and 9100 opened and closed and 192.0.2.10 blocked and unblocked from the admin API reach the kernel sets at once. |

**A reboot of the server**, with a port open, an address blocked and a DNS provider saved: a one-time
check four minutes after the boot found the 35 lines of the snapshot taken before it unchanged.
- The panel's four services came back with no restart and no error line in their journals.
- `nftables.service` loaded the base rules. The API sent the saved lists again, through the
  repaired path of RS1, with no `firewall_sync_failed`: the port and the address are in the kernel
  sets, and the boot file holds none.
- The API wrote the DNS provider's files again on the empty tmpfs, 11 s after the boot. The proxy
  has the same `_FILE` entries, and the marker is still nowhere.
- The containers run, and the panel and the site serve the same certificates, so nothing was
  ordered again. The SFTP login works with the same host key.

**SFTP from another network:** the owner connected to port 2222 from a client outside the server and
confirmed that everything worked. The SFTP container's log shows the accepted login from an address
other than the server's own.

Not run on the server: a backup to a real S3 bucket, DNS-01 with a real provider, `hp-update` between
two versions.

## HCP-SPEC-004: manual TLS certificates and backup targets

This section lists what the reviews and the QA of the HCP-SPEC-004 work found, and what became of
each finding. It is separate from the M6b counts above: the ids start with `S4-`, and the tables
of M6b were not changed. The proof, id by id, is in `docs/security/hcp-spec-004-acceptance-report.md`.

**How it was read.** Five rounds of independent review (opus, one reviewer per slice plus one on
security), seven QA engineers on the TLS work, five on the local backup target and four on the second
destination, and a final security review of the whole branch. Each QA engineer wrote tests that
fail before a repair. The plan of the adversarial QA (arch-infra-qa §4.4) was covered like this:

| §4.4 area | Covered by | Result |
|---|---|---|
| 1 Auth bypass | `tls-tenancy.qa.test.ts`, `backup-targets-tenancy.qa.test.ts`, `hcp004-m1.integration.test.ts`, the route walks of `admin-route-guard` and `support-access-tenancy` | holds: foreign ids answer 404 before the body is read; one low app-wide finding (S4-L1, repaired in #17) |
| 2 Path traversal and filesystem | `local-target-adversarial.test.ts` (253), `manual-tls-adversarial.test.ts` (80), AB step `local-hostile` | holds for the code; two store defects repaired (S4-M9); the executor unit's sandbox defect (S4-H1) was found by the final review and repaired |
| 3 Secret leakage | `tls-keysafety.qa.test.ts`, `backup-targets-web.qa.test.ts`, `tls-web.qa.test.ts`, `docker inspect` steps of the acceptance scripts | the key canary is absent everywhere; the audit guard bug S4-H2 was found and repaired |
| 4 Races | `tls-lifecycle.qa.test.ts`, `backup-dual.qa.test.ts`, `backup-retention-recovery.qa.test.ts` | holds. PGlite runs one transaction at a time, so the row locks are proven by outcome only, not by contention (S4-L6) |
| 5 CP-01 (no proxy recreate) | `accept-tls-manual.mjs`, `accept-tls-adapter.mjs` (rotation under load, `upgrade-no-recreate`) | holds on a throw-away proxy; a live proxy on the test host was never touched. Reboot not run (owner) |
| 6 Irreversible restore | `backup-retention-recovery.qa.test.ts`, `backups-restore-qa.integration.test.ts`, `restore-panel.test.ts` | holds in tests; no real new-host restore (owner) |
| 7 SNI capture and ACME eviction | `tls-tenancy.qa.test.ts`, `manual-tls-adversarial.test.ts`, AM steps `capture-refused`, `tls05-*` | holds |
| 8 Downgrade gate | `update.test.ts`, `features-gate.test.ts`, `rollback-compat.test.ts` | holds; one documented limit (S4-L4) |

### High findings

| id | Weight | Finding | State |
|---|---|---|---|
| S4-H1 | high | Local backup targets cannot work under the real `hp-docker-executor` unit. The unit sets `RestrictSUIDSGID=yes`, and `local-target-guard.ts` runs `chmod` with `02770` on every folder it creates, so the call fails with `EPERM` and becomes `local_target_unsafe`. Initialise always fails on `panel/`, the first local copy of every site fails on `sites/<id>`, and the folder left at 0700 then fails the exact-mode check for good. A "local" policy gives `failed`, and "Both" gives `partial`, every time. It fails closed: nothing is written outside the root. Found by `review-final-backup`; reproduced with `systemd-run --user -p RestrictSUIDSGID=yes` by the reviewer and again when this report was written (`chmod 0770` works, `chmod 2770` gives `EPERM`). No test ran the executor inside the unit's sandbox | repaired (`ffix-local-root-setgid`): the guard no longer requests setgid. It creates each folder with mode 0770 and takes setgid and the executor group from the parent, checks the parent before and that the new folder is exactly 2770 after, and removes a folder that fails the check. `infra/linux/bootstrap-dedicated.sh` creates the local root as 2770, so the unit keeps `RestrictSUIDSGID=yes`. Proof: under `systemd-run --user -p RestrictSUIDSGID=yes -p UMask=0007` a plain `chmod 2770` still gives `EPERM`, and the built guard ran Initialise and a site guard against a 2770 root and left `panel/`, `sites/` and `sites/<id>` at 2770; `infra/linux/accept-backup-local.mjs` gave `RESULT 16/16 passed, 2 skipped` (the two root-only cases) on real Docker, run outside the sandbox. Tests: `apps/docker-executor/test/local-target-guard.test.ts` (an `EPERM` seam for any mode with setgid), `apps/docker-executor/test/local-target-adversarial.test.ts`, `infra/linux/update.test.ts`. Not proved: the whole unit under `systemd` on a real server (owner). An external volume must be prepared by root (`chown hp-executor:hp-executor`, `chmod 2770`); the runbook says so |
| S4-H2 | high | The audit check for PEM text threw after the change was saved. A header `X-Request-ID: -----BEGIN` passes the request-id pattern and lands in the audit details, so the change stayed and its audit row was lost. Found by `review-security` and `review-db-repos` | repaired (`eng-fixup1`): the audit now redacts and always writes the row; a second round made it safe for keys, class instances, `\u0000` and lone surrogates. Tests: `packages/database/test/hcp004-adversarial.test.ts`, `apps/api/test/hcp004-m1.integration.test.ts` |
| S4-H3 | high | A certificate with a DNS SAN shaped like an IPv4 address (`1.2.3.4`) made `tls.connect` throw inside the `server.listen` callback of the validator: an uncaught exception that stops the API, reachable by any tenant with a self-made certificate. Found by `review-c2-api-validation` and `qa-tls-validator-adversarial` | repaired (`c2-fixup1`): an IP-literal SAN is refused and the handshake cannot throw. Test: `apps/api/test/tls-validator-adversarial.qa.test.ts` |

### Medium findings

| id | Finding | State |
|---|---|---|
| S4-M1 | The unique-location index of backup targets compared raw text, so a legacy target, JSON `null` parts, an endpoint in other case or with the default port gave several live S3 targets on one restic repository; panel retention could then prune another target's snapshots | repaired (`eng-fixup1`): `s3_location_key` and `hp_s3_location_key()`, strict S3 config checks. Test: `hcp004-adversarial.test.ts` |
| S4-M2 | The key of the legacy S3 target went stale when `backup_settings` changed (today's route, or an older release after a rollback) | repaired (`eng-fixup2`): a trigger keeps the live key in sync, and a unique violation fails closed |
| S4-M3 | The trigger archived the legacy target on a settings delete, so "clear, then save" left no live S3 target | repaired (`eng-fixup3`): the trigger acts on INSERT and UPDATE only; the first insert creates the target when none exists |
| S4-M4 | `tlsVersionId` was documented in OpenAPI but silently ignored (a Let's Encrypt domain was created) | repaired: refused with 422 `NOT_SUPPORTED` until M2, implemented in M2 |
| S4-M5 | Chain duplicates, the leaf inside the chain and unrelated certificates were accepted and stored | repaired (`c2-fixup1`): chain order, duplicates and unrelated certificates are refused |
| S4-M6 | A `-` in a PEM body passed the shape check and made the validator throw a `TypeError` (500) | repaired (`c2-fixup1`): strict PEM bodies |
| S4-M7 | The empty `acme.json` that `ensureStaticConfig` creates made every first manual publish fail with `CERTIFICATE_APPLY_FAILED` | repaired (`c2-fixup1`): empty means an empty store. Proved by AA step `publish-on-fresh-empty-acme-store` |
| S4-M8 | A certificate shared by two sites of one organisation could not be rotated or assigned (site-scoped activation always gave `manual_overlap`) | repaired (`c2-fixup1`, `c2-fixup2`, `c2-fixup3`): one operation moves every same-organisation domain, a permission check per site, and `409 RESOURCE_LOCKED` while another affected site has an active operation |
| S4-M9 | `manual-tls-store.ts`: `gc()` and `inventory()` followed a symlinked `manual-certs`, `readVersion` accepted a folder of any mode, and a revert could write a manifest that named a vanished version | repaired (`c2-fixup1`, `c2-fixup2b`). Test: `manual-tls-adversarial.test.ts` |
| S4-M10 | Domain add with `tlsVersionId` skipped `site.certificates.manage` and the assign audit | repaired (`c2-fixup1`) |
| S4-M11 | The adapter acceptance script still expected the old `evicted` result after a reverted cold publish (17/18) | repaired (`c2-fixup3`): the script is 18/18 |
| S4-M12 | The 1 GiB free-space floor also stopped forget, restore and archive, so retention could not free a nearly full local target | repaired (`c3-fixup1`): the floor applies only to writes into the repository; 64 MiB margin for the others |
| S4-M13 | Retention reused the forget job id for a third target, which orphaned its snapshots and deleted their rows | repaired (`c3-fixup1`): distinct ids per target (up to nine targets per run, S3 pins unchanged) |
| S4-M14 | A site whose destinations were all archived or disabled was skipped each night with no alert | repaired (`c3-fixup1`): alert `backup_site_without_target` |
| S4-M15 | A stale setup in `backup-targets.integration.test.ts` skipped 45 tests | repaired (`c3-fixup1`): the 45 tests run |
| S4-M16 | The audit of a partial backup was missing on the recovery path | repaired (`c4-fixup1`) |

### Low findings and limits

| id | Finding | State |
|---|---|---|
| S4-L1 | Malformed JSON on an admin route gets 400 before the administrator check (`create-app.ts`, the JSON parser). It is app-wide and older than HCP-SPEC-004. Nothing leaks | repaired (#17), on every route: the parser keeps the error, and the route raises it at its first allowed permission check or when it reads the body (`apps/api/src/common/deferred-body-error.ts`). So the caller gets the route's own 401, 403 (with its denied row) or 404 first, and 400 only once authorised; no route acts on a malformed body. Tests: the former `it.fails` in `backup-targets-tenancy.qa.test.ts`, and the walk of every route with a body, for five callers, in `admin-route-guard.integration.test.ts` |
| S4-L2 | The customer `GET backup-policy`, when destinations are inherited, returns the ids of default-policy targets that are not offered to customers. Only the bare id leaks | repaired (`ffix-api-lows`): the inherited customer policy now returns only target ids that the customer is offered. Test: `apps/api/test/backup-policies.integration.test.ts` |
| S4-L3 | Initialise does not check that the expected disk is mounted, so with an external disk unmounted the folder is made on the system disk (spec 6.5.6). The alert `backup_target_space_low` uses only the last admin test, so it can go stale | written as a limit (`review-final-backup`; ADR-0032 section 4): the marker is the only check, so the administrator must mount the disk before Initialise; the space alert follows the last admin test, and a target that is not tested again keeps its old value |
| S4-L4 | The downgrade gate ignores an archived non-legacy destination that still holds copies. A disabled required destination is dropped at enqueue (a plain `succeeded`, no `partial`) | written as a limit (`.agents/brain/decisions.md` for the gate; ADR-0032 section 5 for the disabled destination) |
| S4-L5 | Copies of the panel backup are not cascaded when an older release moves the legacy location after a forced downgrade | open, low: ADR-0032 limit 10 says a forced downgrade hides the local copies from the old release, but not this carry-over for panel copies |
| S4-L6 | PGlite runs one transaction at a time, so the `FOR UPDATE` locks are proved by outcome, not by contention | open, low: no test shows the locks under real contention; the outcomes are tested |
| S4-L7 | `application/xml` and form bodies answered 500; the import cap of ten per hour reset on delete; the other lows of the reviews (store hardening, torn reads, texts) | repaired in the fix-up rounds (`c2-fixup1`, `c2-fixup2b`, `c3-fixup1`, `c3-fixup2`) |
| S4-L8 | Pending addresses of a site that is still deploying are not protected from a wildcard (`tls-assignment.ts`). A wildcard assigned in that window covers them once routed, and every later publish is refused with `captures_host` | written as a limit (`review-final-tls`; ADR-0031 section 4). Same organisation only |
| S4-L9 | Deleting a domain while its own apply runs leaves an `active` version with no domain, still loaded, which blocks same-organisation subdomains and certificate deletion until the next certificate change (`site-domains.service.ts`) | written as a limit (`review-final-tls`; ADR-0031 section 4). Same organisation only |
| S4-L10 | The API had no limit that matched the executor's 64 hosts per version, so a 65th address failed with a generic `CERTIFICATE_APPLY_FAILED` | repaired (`ffix-api-lows`): `checkAssignment` refuses it before the executor with `VALIDATION_ERROR`, reason `too_many_sans`, and no hostname in the details. The 200 expectations are trimmed by the executor and never fail an apply. Test: `apps/api/test/tls-assignment.test.ts` |

### Counts and what no one could prove

| Weight | Found | Repaired | Written as a limit | Open |
|---|---|---|---|---|
| high | 3 | 3 | 0 | 0 |
| medium | 16 | 16 | 0 | 0 |
| low (listed above) | 10 | 4 (S4-L1, S4-L2, S4-L7, S4-L10) | 4 (S4-L3, S4-L4, S4-L8, S4-L9) | 2 (S4-L5, S4-L6) |

The lows of the reviews that the fix-up rounds repaired in a group are counted once, in S4-L7.

Not proved by anyone: a real S3 bucket, a reboot, a root-only filesystem, a commercial certificate,
a restore on a new host, PFX and `.zip.age` (blocked). The list and the actions are in the acceptance
report.

## HCP-SPEC-005: application stacks

This section lists what the reviews of the HCP-SPEC-005 work (application stacks and the template
catalog, `docs/architecture/adr/0035-application-stacks.md`, branch
`feat/apps-application-stacks-and-template-catalog`, draft PR #37) found, and what became of each
finding. The ids start with `S5-` and are numbered here once for the whole feature; the "Source"
column gives the reviewer's own id (each reviewer numbered from 1). The tables above are not changed.
The proof, id by id, is in `docs/security/hcp-spec-005-acceptance-report.md`.

**How it was read.** Five code reviews by milestone (M1 language, M2, M3, M4a, M4b, with the ADR),
then an independent security review in five slices (R1 language, R2 executor, R3 API and runtime,
R4 web and BFF, R5 infra, docs and release) by agents that did not write the code, then two rounds
that re-read only the repairs (round 2: five slices; round 3: the two round-2 repairs). More than 30
QA test files were written by agents that did not write the code under test. Most findings were
reproduced by their reviewer; those only traced in the code say so. The independent review
found **no critical and no high defect**. The third and last round closed S5-M6 and S5-M7 and found
two new mediums in the same repairs (S5-M9, S5-M10). Both are repaired (`fix16-refresh-recovery`,
`fix16-log-frames`) and covered by their engineers' failing-first tests; the review loop ends at round
3, so no fourth round re-read those two repairs.

### High findings

| id | Source | Weight | Finding | State |
|---|---|---|---|---|
| S5-H1 | review-m2 (contracts) | high | Real organisation ids (`org_<uuid>`, with hyphens, from the admin customer-account route) failed the plan and IPC organisation-id pattern `^[a-z][a-z0-9_]{0,63}$`: the built-in templates compiled for `org_acme` but gave `STACK_TEMPLATE_INVALID` for a real organisation, and the IPC refused it. Reproduced | repaired (`fix3-ids`, `1c0ad33`): a separate `APP_FOREIGN_ID_PATTERN` (`^[a-z][a-z0-9_-]{0,127}$`) for the ids this feature does not mint (organisation, host allocation). Tests: `packages/contracts/test/app-stack-plan.test.ts`, `packages/contracts/test/app-stack-ipc.test.ts`, `packages/contracts/test/app-stack-operations.test.ts` |

### Medium findings

| id | Source | Finding | State |
|---|---|---|---|
| S5-M1 | R2 S5-M1 | Secret masking in the stack logs ran after the 2000-character line cut and the 2 MiB read limit, so a secret that crossed a cut was not masked (18 of 33 characters came back). Reproduced on the built executor | repaired (`fix10-executor`, `f9306a1`): the executor reads the logs itself, masks before the cut, and also masks a line end that starts a value and a line start that ends one. Test: `apps/docker-executor/test/app-stack-secrets.test.ts` |
| S5-M2 | R3 S5-M1 | No cap on secret versions: every write of the secret route inserts an immutable encrypted row of up to 32 768 characters, kept while the stack lives; 300 writes gave 300 rows (6.5 MB) in 0.86 s. The database is shared by every tenant | repaired (`fix10-api`, `5d6aaee`, `60efa54`): at most `APP_STACK_SECRET_VERSIONS_PER_HOUR` = 10 versions per stack in a rolling hour, counted under the stack lock; the route answers 429 `RATE_LIMITED` with `Retry-After`. Tests: `packages/database/test/app-stack-secrets-repository.test.ts`, `apps/api/test/app-stacks.integration.test.ts` |
| S5-M3 | R4 S5-M1 | Four web tests still expected the upstream read that the path-id repair had removed, so the verify was red | repaired (`fix11-web`, `2fae079`): the four tests expect no read for an id that is not one path segment. Tests: `apps/web/test/m6-web-qa-tenancy.test.ts`, `apps/web/test/admin-app-templates.test.ts`, `apps/web/test/admin-app-template-editor.test.ts` |
| S5-M4 | R5 S5-M1 | After a panel restore marks every stack volume `missing`, a delete that keeps data finalised those rows as `retained`, so the stack's secret rows were never purged and the runbook listed volumes that do not exist. Reproduced on PGlite | repaired (`fix12-db`, `5d6aaee`): a `pending` or `missing` volume becomes `removed`; only a `present` volume with `retain` becomes `retained`. Test: `packages/database/test/app-stacks-lifecycle.test.ts` |
| S5-M5 | R5 S5-M2 | The runbook and ADR-0035 said the panel never restarts components stopped by hand, but a route-hash change made the observer queue a full system `stack.deploy`, which started every component. Traced in the code | repaired: first by a hold in the observer (`fix12-observer`, `60efa54`), which round 2 found harmful (S5-M7); then by the routes-only refresh (`fix15-routes`, `ac35ac4`): the refresh reads status once and publishes or withdraws routes, and never pulls, creates, starts or restarts anything. Tests: `apps/api/test/app-stack-runtime.unit.test.ts`, `apps/api/test/app-stack-observer.unit.test.ts` |
| S5-M6 | round 2, r2-executor (a regression of the S5-M1 repair) | The new line-edge masking compared every match one by one: one crafted secret and 2 MiB of long log lines blocked the executor's event loop for 23 to 50 s, and every other executor request timed out meanwhile. Reproduced on the built executor | repaired (`fix15-mask`, `6d7ec4a`; closed by round 3): one Aho-Corasick pass over all values, forward for whole values and line ends, backward for line starts, with the same output; the reviewer's 2 MiB cases take about 95–150 ms. Test: `apps/docker-executor/test/app-stack-secrets.test.ts` (2 MiB cases with a time bound) |
| S5-M7 | round 2, r2-api (a regression of the first S5-M5 repair) | While any component read `stopped` or `missing`, the observer's hold skipped the route refresh; a domain delete frees the hostname at once and relies on that refresh, so the removed hostname kept routing to the stack while another organisation could claim it, and an added hostname stayed `pending`. Reachable by a customer through a deploy whose health budget ran out | repaired (`fix15-routes`, `ac35ac4`, lead ruling; closed by round 3): the hold is removed; the refresh (`stack.deploy` with an idempotency key starting `sys_routes_`) publishes the current hostnames whose ingress target reads running and healthy, and withdraws the rest. At most one refresh per stack per five minutes while only target health changed; a hostname added, removed or moved, or a certificate change, is never delayed. Tests: `apps/api/test/app-stack-runtime.unit.test.ts`, `apps/api/test/app-stack-runtime-policy.test.ts`, `apps/api/test/app-stack-observer.unit.test.ts` |
| S5-M9 | round 3, r3-routes | An in-doubt route refresh (an ambiguous publish or unpublish, or the API restarting during the refresh) goes to recovery, which judges it as a full deploy: an unhealthy target or a missing component settles the stack `failed`. The observer never refreshes a `failed` stack, so the routes are not restored when the target is healthy again and a hostname removed later stays routed. Reproduced | repaired (`fix16-refresh-recovery`, in the tree after `ac35ac4`), not re-reviewed: recovery settles an in-doubt refresh as a refresh from one status read: done when the routes seen are today's hostnames of the healthy targets, else failed with `OPERATION_INTERRUPTED`; the stack `running` or `degraded`, never `failed`; revisions unchanged, and the stored routes hash makes the observer's next pass refresh again. Tests: `apps/api/test/app-stack-recovery.unit.test.ts`, `apps/api/test/app-stack-runtime.unit.test.ts`, `apps/api/test/app-stack-runtime-policy.test.ts`. The review loop ends at round 3: no fourth round re-read the repair |
| S5-M10 | round 3, r3-mask (S5-M1 not closed for one input) | A secret that crosses a 16 KiB Docker partial-entry split, when the 2 MiB read limit then cuts the continuation frame, comes back as a bare middle piece that is neither a line-start suffix nor a line-end prefix: 18 characters of a 40-character secret, 33 of 900 random runs. Reproduced on the built executor; present since `f9306a1` | repaired (`fix16-log-frames`, in the tree after `ac35ac4`), not re-reviewed: the executor joins the frames Docker split one line into, per stream and as bytes, before decoding and masking, and drops the line the read limit cut; a line longer than 16 KiB now comes back as one line, cut at 2 000 characters. Tests: `apps/docker-executor/test/app-stack-engine.test.ts` (the reviewer's reproduction, a three-byte split, 300 seeded layouts), `apps/docker-executor/test/app-stack-secrets.test.ts`. The review loop ends at round 3: no fourth round re-read the repair |
| S5-M8 | code reviews M1 to M4b (grouped) | The mediums of the milestone reviews: a BigInt refine that threw on a bad `memoryBytes`; a shell rule that missed `rbash`, padded names and launchers; a preview that skipped the plan size cap; lone surrogates that reached the plan; a NUL accepted in a secret by the API and refused by the executor at every start; drafts that could not take hostnames; a retried delete that destroyed kept data; a replace that deleted before checking the new body; a body scan that refused valid plans; a backend DNS name over 63 characters; a missing guard on the allowlist test seam; a stop after recovery that left routes published; a timed-out upgrade mislabelled after recovery; an observer that undid a failed stop; health-pass starvation; a draft on an outdated version left at a dead end; an unknown outcome shown as failed; wizard address errors not located; three ADR sentences that were not true | repaired in the fix-up rounds (`fix1-contracts`, `fix1-policy`, `fix1-adr`, `fix2-repos`, `fix3-ids`, `fix5-executor`, `fix5-keylen`, `fix6-runtime`, `fix6-observer`, `fix7-wiring`, `fix8-api`, `fix8-db`, `fix9-web`), each with a test in the file of the code it changed; round 2 re-read every repair and found them closed. Tests, among others: `packages/policy-engine/test/app-template-encoding-edges.test.ts`, `packages/database/test/app-stacks-repository.test.ts`, `apps/docker-executor/test/app-stack-engine.test.ts`, `apps/docker-executor/test/app-stack-main-seam.test.ts`, `apps/api/test/app-stack-observer.unit.test.ts`, `apps/web/test/app-stacks-detail.test.ts` |

### Low findings and limits

| id | Source | Finding | State |
|---|---|---|---|
| S5-L1 | R1 S5-L1 | The metadata text rule matches only `169.254.`, `fd00:ec2::` and `metadata.google.internal`: the decimal, hexadecimal, IPv4-mapped, written-out IPv6, short-name and ideographic-dot spellings pass | written as a limit (ADR-0035 §4, limit 16): the host firewall's drop on the stack bridges is the control; the text rule is a second layer |
| S5-L2 | R1 S5-L2 | Free-text DTO fields (template name and description, stack name) accepted an unpaired surrogate: an admin PATCH would give a 500 on the jsonb audit row | repaired (`43c8541`): the text rule refuses unpaired surrogates in those fields. Test: `packages/contracts/test/app-api-dto.test.ts` |
| S5-L3 | R1 S5-L3 | Eight secrets of 16 384 control characters plus a full plan made a start body over the executor's 1 MiB limit | repaired (`43c8541`): secret values refuse C0 control characters other than tab, LF and CR, through one rule shared by the API and the executor. Tests: `packages/contracts/test/app-api-dto.test.ts`, `packages/contracts/test/app-stack-ipc.test.ts` |
| S5-L4 | R2 S5-L1 | An upgrade could remove a running component and then have its create refused by Docker for asking more CPUs than the host has. Traced | repaired (`f9306a1`): the executor reads `GET /info` and refuses before any removal when a component asks more than the host's CPUs. Test: `apps/docker-executor/test/app-stack-engine.test.ts` |
| S5-L5 | R2 S5-L2 | The container hardening check accepted an extra network or a fixed endpoint IP, a `site_job` role label and `User: "0"`; no plan input produced such a body | repaired (`f9306a1`): exact network keys, labels and user. Test: `apps/docker-executor/test/app-stack-payload.test.ts` |
| S5-L6 | R3 S5-L1 | A create or deploy retried with the same `Idempotency-Key` could be refused (`STACK_TEMPLATE_UNPUBLISHED`) instead of replayed after the default version changed | repaired for create and deploy (`60efa54`): the key is looked up before the preflight. Test: `apps/api/test/app-stacks.integration.test.ts`. Open, low, for rollback: it still runs its preflight before the replay |
| S5-L7 | R3 S5-L2 | A deploy that changes settings needed only `app.control` (the spec asks `app.update`); no preset role could reach the gap | repaired (`60efa54`, `fix14-deploy-order`): a deploy with `parameters` also needs `app.update`, checked before the stack lookup and after the body is known to be well formed. Tests: `apps/api/test/app-stacks.integration.test.ts`, `apps/api/test/admin-route-guard.integration.test.ts` |
| S5-L8 | R4 S5-L1 | Installing an outdated draft from the detail page showed "no longer offered" instead of "delete the draft and install again" | repaired (`2fae079`). Test: `apps/web/test/app-stacks-actions.test.ts` |
| S5-L9 | R4 S5-L2 | A kept `Idempotency-Key` could replay an old stop after a lost reply, a start and a second stop | repaired (`2fae079`): the key name is the action and the shown status, and kept keys are dropped when the status changes. Test: `apps/web/test/app-stacks-actions.test.ts` |
| S5-L10 | R4 S5-L3 | With the flag off, the admin "new template" page still showed the editor (the API refused both calls) | repaired (`2fae079`): the new and edit pages read the flag first and show the notice. Test: `apps/web/test/admin-app-template-editor.test.ts` |
| S5-L11 | R5 L1 | The fresh-server guard of the panel restore counted only sites, so a server with stacks and no sites passed it | repaired (`fcfab26`): it also counts live stacks. Test: `infra/linux/restore-panel.test.ts`. Limit: the query needs PostgreSQL built with libxml; it ran on PGlite only |
| S5-L12 | R5 L2 | Runbook §9.2 names only `swarmtest_<hex>`, but the HTTP script also creates `hp_swarmtest_stk_<hex>_proxy`, its network and a `/dev/shm` folder | repaired (documentation): runbook §9 step 2 names both the stack marker `swarmtest_<hex>` and the scripts' own prefixes, as the scripts' gate and cleanup use them |
| S5-L13 | R5 L3 | The acceptance report and the docs guard did not exist | repaired: `docs/security/hcp-spec-005-acceptance-report.md`; the guard `apps/api/test/app-stack-docs-layout.test.ts` is written by its own slice |
| S5-L14 | round 2, r2-database | A destroying delete that fails partway and is retried with "keep data" can leave `retained` rows of volumes that no longer exist, which keeps that stack's secret rows | written as a limit (ADR-0035 §4) |
| S5-L15 | review-m2 (migration) | `TRUNCATE` bypasses the secret immutability trigger; `resource_quota_id` is not bound to the organisation in SQL; a hard delete of a live stack row cascades to its revisions and secrets | written as a limit: no code path does these |
| S5-L16 | reviews, notes | A concurrent ingress ensure can re-attach the proxy between a removal's detach and its network delete (the removal fails with a namespace conflict and a retry converges); enum options may hold secret-looking literals (administrator-written, public by design) | written as a limit (ADR-0035 §4) |
| S5-L17 | fix15-routes engineer | The five-minute refresh record is kept in memory per API process, so a restart forgets it | written as a limit (ADR-0035 §4) |
| S5-L18 | round 2, r2-web-docs | Web copy: `RATE_LIMITED` on the secret form says "try again shortly" for an hourly cap; the README list of restore exit-2 causes omits applications | the README list (and the restore runbook's) now names applications; open, low (wording): `RATE_LIMITED` |
| S5-L19 | round 3, r3-mask | Eight multi-line secrets (2 340 six-character lines each) cost 0.6–1.1 s and about 80 MB of heap per log read; the multi-byte frame-split gap noted in round 2 is unchanged | the frame-split gap is repaired with S5-M10 (`fix16-log-frames`: a character split across frames decodes whole), not re-reviewed; open, low: the cost |
| S5-L20 | round 3, r3-routes | The route refresh also reads the certificate status; when that read fails, the refresh fails, the old route file stays and the last removed hostname stays routed, retried every 10 minutes while the read fails. Reproduced | repaired for the last hostname (`fix16-refresh-recovery`), not re-reviewed: with no hostname rows the refresh skips the read and withdraws the routes. Test: `apps/api/test/app-stack-runtime.unit.test.ts`. Open, low: while other hostnames remain, a failed read still fails the refresh and a removed hostname stays routed until the read works |

Constraints recorded with these findings: the console `hp-web` (tcp 3000) is reachable from every
bridge under the frozen firewall rule (ADR-0035 limit 4; refused on the test machine); the downgrade
gate ignores the retained volumes of deleted stacks; stack hostnames are ACME only.

### Counts and what no one could prove

| Weight | Found | Repaired | Written as a limit | Open |
|---|---|---|---|---|
| critical | 0 | 0 | 0 | 0 |
| high | 1 | 1 | 0 | 0 |
| medium (S5-M8 groups the milestone reviews) | 10 | 10 (S5-M9 and S5-M10 not re-reviewed) | 0 | 0 |
| low (listed above) | 20 | 12 (S5-L2 to S5-L13) | 5 (S5-L1, S5-L14 to S5-L17) | 3 (S5-L18 to S5-L20, each partly repaired), plus rollback in S5-L6 |

Not proved by anyone: a host reboot with stacks, the metadata drop on a cloud VM, the root-only nft
step, ACME issuance on a real stack hostname, an update between two real releases, the feature with
its flags on for a real customer. The list and the actions are in the acceptance report.

## Open high or critical findings

| id | Weight | State |
|---|---|---|
| C1 | critical | repaired (`data.1`) |
| C2 | critical | repaired (`restore.1`) |
| H1 | high (auditor), medium (lead) | written as a limit (ADR 0025 limit 19) |
| H2 | high | repaired (`limits.2`) |
| H3 | high | repaired (`limits.3`, `a.2`, `a.3`, `a.6`) |
| H4 | high | repaired (`data.2`) |
| H5 | high | repaired (`limits.4`) |
| H6 | high | repaired (`web.1`) |
| H7 | high | repaired (`web.2`) |
| H8 | high | repaired (`orgs.1`) |
| H9 | high | repaired (`orgs.2`, `exec.1`, `a.1`) |
| H10 | high | repaired (`restore.2`) |
| DH1 | high | repaired (`a.8`) |

Open high or critical findings: 0
