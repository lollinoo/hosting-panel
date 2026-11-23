# Runbook — Application stacks

Operator procedures for application stacks (`ADR-0035`). Design record:
`docs/architecture/adr/0035-application-stacks.md`. Acceptance evidence and what is still pending:
`docs/security/hcp-spec-005-acceptance-report.md`. Backup and restore of an application (`ADR-0038`):
`docs/architecture/adr/0038-application-backups.md`.

`<stackId>` is the id in the address of the application page (`/apps/<stackId>`, it starts with `stk_`);
`<componentKey>` and `<volumeKey>` are the names the template gives a component and a volume. The database commands
below only read; run them as written:

```bash
cd / && sudo -u postgres psql -X -d hosting_panel -c "<query>"
```

## Scope and limits (read first)

- **The four capability flags are `false` on every server in this release** (`applicationTemplatesAvailable`,
  `applicationStacksAvailable`, `stackPublicPortsAvailable`, `gitBuildsAvailable`). They are fixed in code
  (`apps/api/src/app-stacks/app-feature-gate.ts`); no environment variable or option turns them on. While they are
  `false`, every admin template route and every stack route answers `NOT_SUPPORTED` (reason
  `STACK_UNSUPPORTED_FEATURE`): nobody can create, start, stop or delete a stack from the panel. The procedures below
  apply once the owner turns the flags on.
- **First release scope:** images only (no build, no Git), Dedicated allocations only, HTTP ingress only, Let's Encrypt
  (ACME) certificates only for stack domains, no public TCP/UDP port. An application's data is backed up only when
  someone creates a backup from its page (procedure 10); no backup of an application runs on a schedule.
- **Who acts on a stack:** a customer owner or a hosting administrator of the organisation (permissions `app.read`,
  `app.create`, `app.update`, `app.control`, `app.delete`). The server administrator's console has the template catalog
  (**Modelli**, kind «Applicazione multi-servizio») and a read-only list of every stack in **Applicazioni**; it has no
  stack actions; collaborators and support access have no stack permission.
- **Never run `docker rm`, `docker volume rm`, `docker network rm` or any `prune` on a stack's objects by hand**, except
  where a step below says so. The panel owns them; removing one by hand leaves the panel's view wrong.
- **Stack data is in no backup unless someone creates one.** The site and panel backups (S3 or local) do not include
  stacks or their volumes. A customer owner or a hosting administrator of the organisation creates a backup of one
  application from its page (procedure 10, `ADR-0038`); nothing does it automatically.
- **Known limits** (`ADR-0035` §4): manual TLS certificates are not available on stack domains; the downgrade gate does
  not see the retained volumes of deleted stacks; after a forced downgrade the stack containers keep running without
  management; the panel console (`hp-web`, tcp 3000) is reachable from every Docker bridge, stack networks included, and
  is protected by its session only; a new image digest needs a new template version; after a host reboot the components
  that use secrets stay broken until someone restarts them (procedure 8); volumes have no size limit; a server reboot,
  the metadata drop on a real cloud VM and an ACME issuance on a real hostname were not proven on the build machine.

## 1. See a stack's real state

1. In the panel: the application page (`/apps/<stackId>`) shows the status, each component's health with the time of
   the last check, the domains, the history of every action with its reason, and each component's log (the last 1 to
   500 lines, secret values masked). A health observation older than 5 minutes reads as `unknown`.
2. The server administrator sees every live stack in **Applicazioni** (customer, template and version, status, web
   address; at most 200, read-only) and the stacks of one template in **Modelli** › the template › its usage list
   (organisation, name, version, status). All live stacks:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, organization_id, name, status from app_stacks where deleted_at is null order by organization_id, name"
   ```
3. What Docker has for one stack (read-only):
   ```bash
   sudo docker ps -a --filter label=io.hostingpanel.stack_id=<stackId> --format '{{.Names}}\t{{.Status}}'
   sudo docker network ls --filter label=io.hostingpanel.stack_id=<stackId>
   sudo docker volume ls --filter label=io.hostingpanel.stack_id=<stackId>
   sudo ls -l /var/lib/hosting-panel/ingress/dynamic/app_<stackId>.yml
   ```
   Names: containers `hp_app_<stackId>_<componentKey>`, private network `hp_appnet_<stackId>`, edge network
   `hp_appedge_<stackId>` (only when the stack has a web address), volumes `hp_appvol_<stackId>_<volumeKey>`, route file
   `app_<stackId>.yml`.

## 2. A stack or an operation is unknown

1. **What it means.** The API sent a step to the executor and lost the answer (a timeout after the connection, problem
   `OPERATION_AMBIGUOUS`), or the operation's lease ran out. The operation and the stack become `unknown` (a delete in
   doubt stays `deleting`). The operation keeps its lock, so every new action on that stack is refused until it settles.
2. **What the panel does.** On every outbox poll and at every API start, recovery reads the stack's state from the
   executor once (a `GET`) and settles the operation from what it sees. It never continues or repeats the action
   (`HARNESS.md`, `TH-08`):
   - deploy, upgrade, rollback, start, restart: every component of the plan exists with the plan's hash → `running` or
     `degraded` (`failed` if an essential component is not healthy); if instead the previous revision is still the one
     running, the operation fails (`OPERATION_INTERRUPTED`) and the stack keeps the status of that revision; otherwise
     the stack is `failed` with `OPERATION_INTERRUPTED`;
   - route refresh (the panel's own `stack.deploy`, no user, which only changes routes): done when the routes seen are
     today's addresses of the healthy targets, otherwise it fails with `OPERATION_INTERRUPTED`; the stack is `running`
     when it is done and every component is healthy, otherwise `degraded`, never `failed`; a later route refresh
     rewrites the routes (ten minutes later when this one failed);
   - stop: a component still running → `degraded`; none → `stopped`;
   - delete: no container, network or route file left (and no volume, when the data was to be destroyed) → `deleted`;
     otherwise `delete_failed`.

   If the executor cannot be read, the operation stays `unknown` and the next pass tries again.
3. **If it stays `unknown`.** Check the executor and the API, then look at their logs:
   ```bash
   systemctl status hp-docker-executor hp-api
   sudo journalctl -u hp-docker-executor -u hp-api --since "1 hour ago"
   ```
   When the executor is back, the next pass settles it. `sudo systemctl restart hp-api` runs recovery at once.
4. **When to retry.** Only after the operation has settled (its line in the history no longer reads «Da verificare»):
   then the customer acts again from the application page with the status it shows. A stack can also read `unknown`
   with no open operation (an interrupted stop, repaired at API start): then **Avvia**, **Arresta**, **Riavvia**,
   **Reinstalla** and delete are all allowed.
5. **A stack in `failed`.** The history on the application page names the reason (the stable code is the `problem` of
   `GET /v1/organizations/<orgId>/app-stacks/<stackId>/deployments`):
   - `STACK_SECRET_MISSING`: set the value in **Valori riservati**, then **Reinstalla**;
   - `STACK_HEALTH_TIMEOUT`: read the component logs, fix the cause, then **Riavvia** or **Reinstalla**;
   - `STACK_IMAGE_NOT_ALLOWED`, `STACK_TEMPLATE_INVALID`: the template is at fault; the administrator publishes a fixed
     version and the customer upgrades;
   - `DOCKER_ENGINE_UNAVAILABLE`, `OPERATION_INTERRUPTED`: the action was cut (Docker, the executor, an API restart or a
     restore); check procedure 2 step 3, then **Riavvia** or **Reinstalla**.

   **Reinstalla** (`stack.deploy`) recreates what differs from the plan; **Avvia** only starts components that exist.
   At API start, a stack left busy without an active operation becomes `failed` (`delete_failed` when it was deleting,
   `unknown` when it was stopping).

## 3. Delete a stack, keep or destroy its data

1. The customer deletes from the application page: they type the stack's name again; the data is destroyed only when
   they also tick the separate box **Elimina anche i dati dell'applicazione**. Without it, every volume stays on the
   server with status `retained`.
2. **`delete_failed`.** The delete stopped before the end; the history names the reason (for example
   `STACK_VOLUME_IN_USE`: a volume to destroy was still in use). The only action allowed is a new delete from the
   panel; the box of the new request decides again what happens to the data.
3. **Remove a retained volume later** (server administrator, only when the data is surely not needed):
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select v.stack_id, v.volume_key, s.status from app_stack_volumes v join app_stacks s on s.id = v.stack_id where v.status = 'retained'"
   sudo docker ps -a --filter volume=hp_appvol_<stackId>_<volumeKey>
   sudo docker volume rm hp_appvol_<stackId>_<volumeKey>
   ```
   Remove only a volume whose stack is `deleted` and that no container uses (the second command lists nothing). Use the
   exact name, never `-f`, never a filter or `prune`. The volume row keeps saying `retained`; nothing reads it again.

## 4. Downgrade while stacks exist

1. `sudo hp-update --version <older> --allow-downgrade` exits with **code 8** when the target release's `RELEASE.json`
   does not list the feature `app-stacks` and a stack that is not deleted exists (drafts included). A `psql` error also
   counts as a refusal. `--dry-run` does not run this check. See what blocks:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, organization_id, name, status from app_stacks where deleted_at is null"
   ```
2. **To go back without forcing:** delete those stacks from the panel (procedure 3; the data volumes stay unless the box
   is ticked), while the flags are still on, then run the downgrade again. Or keep the current release.
3. **To go ahead knowingly:**
   ```bash
   sudo hp-update --version <older> --allow-downgrade --allow-feature-loss
   ```
   The older release has no code for stacks: their containers keep running without management (no health, no
   restart, no route change), and their volumes stay on the server. Upgrading again brings the panel's view back.
4. The gate does not count the retained volumes of deleted stacks: they stay on disk and the older release ignores
   them. Remove them by hand (procedure 3) only if the data is not needed.
5. The automatic rollback of a failed update stays ungated: migrations `0025` and `0027` are additive.
6. **Backups of applications.** The same command exits with **code 8** also when the target release does not list the
   feature `app-stack-backups` and a row exists in `app_stack_backups`, whatever its status and also when its
   application is deleted. See what blocks:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select b.id, b.stack_id, b.kind, b.status, b.started_at, s.status as application from app_stack_backups b left join app_stacks s on s.id = b.stack_id order by b.started_at"
   ```
   No command of the panel deletes a backup; a row goes only with the nightly clean-up (procedure 10 step 7). An
   application that exists keeps its newest good backups whatever their age, so this check holds as long as that
   application lives: to go back without forcing, delete the application (procedure 3) and wait for the retention
   period, or keep the current release. With `--allow-feature-loss` the older release has no code for these backups: it
   does not list, restore or remove them. Their rows stay in the database and their copies on the destinations, and
   the database still refuses to delete a destination that holds one.

## 5. Restore the panel on a new server

1. After `hp-restore-panel` (README, «Il server è perso»), the new server has no stack container, network, volume or
   route. The restore SQL (`infra/linux/hp-restore-panel.sql`) sets: open deployments `failed`
   (`OPERATION_INTERRUPTED`), components `missing`, volumes `missing`, domains back to `pending` without a certificate,
   stacks `failed` (`delete_failed` if they were deleting). Drafts stay `draft`; revisions, parameters and secrets are
   kept.
2. Point each stack domain's DNS to the new server; the panel checks the domains again by itself.
3. The customer presses **Reinstalla** on each stack: images are pulled again by digest (the server needs the
   registries), new **empty** volumes are created, the secret files are written from the stored values. The routes
   and the Let's Encrypt certificates come back once the stack runs.
4. **The data of the volumes does not come back with the panel.** The restored database lists the backups of each
   application, and the restore SQL closes the backups and restores that were open as failed (`interrupted`); a copy
   that had finished stays good. The copies are on the backup destinations: a local destination is on the new server
   only if its folder was brought there. Writing a backup back after a panel restore (**Reinstalla** first, then
   **Ripristina**, procedure 10) **was not tried**: `ADR-0038` leaves it out of scope. Try it on the application whose
   data matters least before relying on it.
5. A `delete_failed` stack: delete it again from the panel (procedure 3).

## 6. Incident: a stack misbehaves

1. **Stop it.** The customer presses **Arresta** (`stack.stop`): the routes are withdrawn, the containers stop, the data
   stays. If it cannot wait for the customer, the server administrator stops the components by hand:
   ```bash
   sudo docker stop hp_app_<stackId>_<componentKey>
   ```
   Only `stop`, never `rm`. The containers stay stopped after a reboot (`unless-stopped`), the panel shows them not
   healthy and never restarts them itself; **Riavvia** starts them again. The panel's next route refresh withdraws the
   addresses whose target component is stopped and publishes them again once it reads healthy; the refresh only reads
   the stack's state and changes routes, it never starts anything. While only health changes, a stack gets at most one
   refresh every five minutes; a removed address is withdrawn on the next pass.
2. **Nobody installs it again.** In **Modelli**, open the template and switch off **Offerto ai clienti** (archive it if it is not built-in).
   Installed stacks keep running; a deploy or upgrade that needs a new revision of that template is refused
   (`STACK_TEMPLATE_UNPUBLISHED`).
3. **Logs.** The application page shows the last 1 to 500 lines per component with secret values masked. For more:
   `sudo docker logs --tail 500 hp_app_<stackId>_<componentKey>`; that output is **not** masked and may hold a secret
   value: never paste it into a ticket.
4. What the panel never does for a stack: the drift reconciler never restarts or recreates a stack container; a stack
   action never stops or recreates a site; a route change rewrites only `app_<stackId>.yml`.

## 7. Turn the feature off again

1. In this release the flags are already `false`: nothing is offered, and nothing needs turning off.
2. If a release with the flags on is followed by one with them off (or by a downgrade), do this first: disable or
   archive the templates so nobody installs one, and ask the customers to stop or delete their stacks. Once the flags
   are off, nobody can do it from the panel (every stack route answers `NOT_SUPPORTED`).
3. Afterwards, stacks that are running keep running until they are stopped, and no data is deleted: containers,
   volumes and rows stay, and the downgrade gate still counts the stacks.

## 8. After a host reboot

1. A stack's secret files live under `/run/hosting-panel/secrets`, a tmpfs that is empty after every boot. Docker
   starts the stack containers again (`unless-stopped`) before the executor runs, so a component that reads a secret
   file finds none and fails or runs without it. Nothing repairs this by itself. Components without secrets are not
   affected.
2. The stacks that have secrets:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select s.id, s.organization_id, s.name, s.status from app_stacks s where s.deleted_at is null and exists (select 1 from app_stack_secrets x where x.stack_id = s.id)"
   ```
3. On each, the customer (or a hosting administrator of the organisation) presses **Riavvia** (`stack.restart`): it
   writes the secret files again, then restarts every component. **Avvia** does not rewrite the files of a component
   that is already running.

## 9. Read the acceptance scripts' output

1. The real-Docker checks are `infra/linux/accept-app-stack-engine.mjs` (the stack engine),
   `infra/linux/accept-app-stack-http-cache.mjs` and `infra/linux/accept-app-stack-worker-storage.mjs` (the two built-in
   templates) and `infra/linux/accept-app-stack-backups.mjs` (backup and restore of an application, `ADR-0038`). They
   import the built packages: build first (`corepack pnpm run build`), then run one at a time, never next to a test run
   (memory):
   ```bash
   node infra/linux/accept-app-stack-engine.mjs
   ```
2. They are safe on a live server: they reach Docker only through their own default-deny gate socket, create and
   remove only objects whose name contains `swarmtest_<hex>` (a random value per run) or starts with the script's own
   prefix (`hp_swarmtest_<hex>` for the engine script, `hp_swarmtest_stk_<hex>` for the two template scripts: their
   throw-away proxy `<prefix>_proxy`, its network `<prefix>_ingress`, a temp folder and `/dev/shm/<prefix>-secrets`),
   never prune, and clean up at the end, also on Ctrl-C. The backups script uses `hp_swarmtest_<hex>` too; its job
   containers are named `hp_bk_op_<hex>…`, plus one `hp_bk_test_<16 hex>` for the destination test. It gives its
   application no address, so it creates no edge network. Its job containers carry the role of the panel's own jobs
   (`site_job`), and `hp-docker-executor` removes such containers when it starts: do not restart the executor while
   this script runs (the run would fail, without harm).
3. Each step prints one line: `PASS <step>`, `FAIL <step>: <reason>` or `SKIP <step>: <why>`. A step that needs root is
   skipped unless the script runs as root with `HP_ACCEPT_ROOT_CASES=1`. `INFO` lines are measurements and notes,
   never a failure. When an image the script does not pull is missing (the engine script's test image, `traefik:v3.7`
   for the HTTP-cache script, the test image or the backup tool's image for the backups script), it prints
   `SKIP … nothing was created` and exits 1. Without a build the HTTP-cache script prints
   `FAIL preflight: run corepack pnpm run build first`.
4. The last line is `RESULT <n>/<m> passed`, followed by `, <k> skipped (not counted in n/m)` when steps were skipped,
   and the time. The exit code is 0 only when every counted step passed.
5. A `FAIL` of `gate-clean` means the script sent a Docker request the gate refused; that request never reached
   Docker. A `FAIL` of `nothing-left` lists what the run left; find it and remove it by exact name only:
   ```bash
   sudo docker ps -a --filter name=swarmtest_
   sudo docker network ls --filter name=swarmtest_
   sudo docker volume ls --filter name=swarmtest_
   sudo docker ps -a --filter name=hp_bk_op_
   ```
   The last command also lists the job of a backup the panel is running right now (`hp_bk_op_…`): remove a container
   only when its name holds the `<hex>` the script printed.

## 10. Backup and restore of an application

Design record: `docs/architecture/adr/0038-application-backups.md`. The choices in it (K1 to K12) wait for the owner's
approval.

1. **Who and where.** A customer owner or a hosting administrator of the organisation, on the application page
   (`/apps/<stackId>`), section **Backup**: the list needs `app.read`, **Crea backup** and **Ripristina** need
   `app.control`. The server administrator's console has no command for it, and nothing runs on a schedule. A customer
   starts at most six backups or restores of one application per hour (`QUOTA_EXCEEDED`); the requests of a server
   administrator are not counted.
2. **When the section offers no command**, it says why:
   - backups cannot run on this server (the executor is not available, or the sites' backups are not available on
     it): the routes answer `NOT_SUPPORTED`;
   - the application keeps no data (its template has no data volume);
   - the server has no usable backup destination: the server administrator sets one for the sites' backups
     (`docs/runbooks/tls-and-backup-targets.md`). Applications use those destinations, at most two, and cannot choose.

   An application that was never deployed (a draft) has nothing to save: `409` with its status.
3. **What a backup does.** Its web addresses are withdrawn, the application is stopped, every data volume is copied to
   each destination (one after the other), and the application is started again by an action of its own, which the
   history shows after the backup. **The application does not answer for the whole copy.** An application that was
   stopped stays stopped. While the backup runs, every other action on that application is refused
   (`409 RESOURCE_LOCKED`, to try again later). The copy holds the data volumes only: no image, no settings, no web address and none of the **Valori riservati**.
4. **Read the result.** «Completato»: every destination has the copy. «Parziale»: one destination has it and the other
   failed; the backup can be restored. «Non riuscito»: no destination has it; the application runs again and its data
   did not change. The list gives a reason in words; the stable code is the `problem` of the row:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select b.id, b.kind, b.status, b.problem, b.started_at, b.finished_at, b.restore_status, b.restore_problem, c.priority, c.status as copy, c.problem as copy_problem from app_stack_backups b left join app_stack_backup_copies c on c.backup_id = b.id where b.stack_id = '<stackId>' order by b.started_at desc, c.priority"
   ```
5. **Restore.** **Ripristina** on a backup, then the application's name typed again. The panel stops the application,
   saves the data as they are in a backup of kind «Prima di un ripristino», writes the chosen backup back volume by
   volume (what the backup does not hold is deleted from the volume), and starts the application again. The version
   and the settings of the application do not change. If the safety backup reaches no destination, nothing is written
   and the application starts again untouched. Only a volume that is both in the backup and in the application today
   is written; a backup none of whose volumes exist any more cannot be restored.
6. **A restore that failed.** When it failed before anything was written, the application starts again by itself.
   When it failed **while writing**, or the panel cannot tell, the application **stays stopped**: its data may be
   incomplete. Restore the newest «Prima di un ripristino» backup, which holds the data as they were; do not press
   **Avvia** first unless losing that state is acceptable.
7. **What is kept.** For each application the three newest good backups made by hand and the three newest good safety
   backups, whatever their age; a failed backup until the retention period of the sites' backup policy is over (14 days
   unless changed). The backups of a **deleted** application stay for that period, then every copy and row goes. The
   clean-up runs with the nightly backup run (`stack.prune` in the history, «Pulizia dei backup»), so the list can
   show more than three for some hours. A destination that fails keeps the rows, and the next night finishes the work.
   On a server with no usable destination the nightly run does nothing, and no backup of an application is removed.
8. **Where the copies are** (server administrator). One encrypted repository per application per destination, next to
   the sites' ones and with their key: on a local destination the folder `stacks/<stackId>` under that destination's
   folder (`/var/lib/hosting-panel/local-repos/<targetId>` unless `HP_BACKUP_LOCAL_ROOT` says otherwise), on S3 the
   same path under the destination's location. Never write, move or delete there by hand. The page
   **Amministrazione › Backup** counts these copies with the others of a destination, and a destination that holds one
   cannot be deleted.
9. **The backup or the restore reads «Da verificare».** Procedure 2 applies: the panel reads the state of the
   application and of the job from the executor and settles the action; it never sends a copy or a restore twice. A
   job the executor no longer knows (it restarted) is closed as interrupted.
10. **Limits.** No scheduled backup, no restore into another application, no download of a backup, no backup without
    stopping, no destination per application (`ADR-0038` K12). Not tried on real Docker: hard links, extended
    attributes, file capabilities, device files, an S3 destination, two destinations at once. A copy is taken with the
    application stopped, so a database inside it is saved as its files on disk.
