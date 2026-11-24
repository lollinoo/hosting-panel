# Runbook — Application stacks

Operator procedures for application stacks (`ADR-0035`). Design record:
`docs/architecture/adr/0035-application-stacks.md`. Acceptance evidence and what is still pending:
`docs/security/hcp-spec-005-acceptance-report.md`. The routing options of a stack's addresses (`ADR-0037`,
`docs/architecture/adr/0037-application-routing-options.md`) are procedure 10. Backup and restore of an application
(`ADR-0038`): `docs/architecture/adr/0038-application-backups.md`. Databases and the private links between a database
and an application (`ADR-0039`, `docs/architecture/adr/0039-application-databases.md`) are in procedure 12.

`<stackId>` is the id in the address of the application page (`/apps/<stackId>`, it starts with `stk_`);
`<componentKey>` and `<volumeKey>` are the names the template gives a component and a volume. The database commands
below only read; run them as written:

```bash
cd / && sudo -u postgres psql -X -d hosting_panel -c "<query>"
```

## Scope and limits (read first)

- **Two of the four capability flags are on.** `applicationTemplatesAvailable` and `applicationStacksAvailable` are
  `true` on a server (runtime backend `linux-systemd`) and `false` on the other backends; `stackPublicPortsAvailable`
  and `gitBuildsAvailable` are `false` everywhere (`ADR-0036` §2.10). They follow the runtime backend in code
  (`packages/contracts/src/resources.ts`, `apps/api/src/app-stacks/app-feature-gate.ts`); no environment variable or
  option changes them. Where a flag is `false`, the routes behind it answer `NOT_SUPPORTED` (reason
  `STACK_UNSUPPORTED_FEATURE`). Release `0.9.0` has all four `false`: there nobody can create, start, stop or delete
  a stack from the panel, and the procedures below do not apply.
- **First release scope:** images only (no build, no Git), Dedicated allocations only, HTTP ingress only, Let's Encrypt
  (ACME) certificates only for stack domains, no public TCP/UDP port. An application's data is backed up only when
  someone creates a backup from its page (procedure 11); no backup of an application runs on a schedule.
- **Who acts on a stack:** a customer owner or a hosting administrator of the organisation (permissions `app.read`,
  `app.create`, `app.update`, `app.control`, `app.delete`). The server administrator's console has the template catalog
  (**Modelli**, kind «Applicazione multi-servizio») and the list of every stack in **Applicazioni**. A row opens the
  stack's page, where the administrator reads a component's logs and opens a terminal in it (procedures 13 and 14,
  `ADR-0041`). The administrator cannot start, stop, change or delete a customer's stack from that page; collaborators
  and support access have no stack permission.
- **Never run `docker rm`, `docker volume rm`, `docker network rm` or any `prune` on a stack's objects by hand**, except
  where a step below says so. The panel owns them; removing one by hand leaves the panel's view wrong.
- **Stack data is in no backup unless someone creates one.** The site and panel backups (S3 or local) do not include
  stacks or their volumes. A customer owner or a hosting administrator of the organisation creates a backup of one
  application from its page (procedure 11, `ADR-0038`); nothing does it automatically.
- **Known limits** (`ADR-0035` §4): manual TLS certificates are not available on stack domains; the downgrade gate does
  not see the retained volumes of deleted stacks; after a forced downgrade the stack containers keep running without
  management; the panel console (`hp-web`, tcp 3000) is reachable from every Docker bridge, stack networks included, and
  is protected by its session only; a new image digest needs a new template version; after a host reboot the components
  that read a secret file stay broken until someone restarts them (procedure 8); volumes have no size limit; a server
  reboot, the metadata drop on a real cloud VM and an ACME issuance on a real hostname were not proven on the build
  machine.

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
   `OPERATION_AMBIGUOUS`), or the operation's lease ran out. An answer the panel could not read after a change was
   sent (a success answer that is not JSON or not of the expected shape, or a server error without the error
   envelope) counts as lost too. The operation and the stack become `unknown` (a delete in doubt stays `deleting`).
   The operation keeps its lock, so every new action on that stack is refused until it settles. A client error
   (`4xx`) the panel could not read is not a lost answer: the operation fails as after any other refusal.
2. **What the panel does.** On every outbox poll and at every API start, recovery reads the stack's state from the
   executor once (a `GET`) and settles the operation from what it sees. It never continues or repeats the action
   (`HARNESS.md`, `TH-08`):
   - deploy, upgrade, rollback, start, restart: every component of the plan exists with the plan's hash → `running` or
     `degraded` (`failed` if an essential component is not healthy); if instead the previous revision is still the one
     running, the operation fails (`OPERATION_INTERRUPTED`) and the stack keeps the status of that revision (an upgrade
     or a rollback whose create step never started also goes back to the version, settings and quota its request
     replaced); otherwise the stack is `failed` with `OPERATION_INTERRUPTED`. A deploy, upgrade or rollback of a stopped
     application whose create step never started leaves it `stopped` whichever of these it reads, once a version of it
     was installed (it has an applied revision); one never installed ends `failed`;
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

   The page enables only the buttons that the stored status, the stack's lock and the reader's permissions allow at
   that moment: `allowedActions` of `GET /v1/organizations/<orgId>/app-stacks/<stackId>`, never the status shown. It
   covers the backup and the restore of the **Backup** section too. While an operation holds the stack the list is
   empty. A run of a task that waits for its turn does not change the list (the page follows it and every action stays
   offered); once it runs it holds the stack like any operation. An enabled button can still be refused for a reason of its own, and the page shows that refusal: a database
   that applications still use, the hourly limit of backups and restores, a plan that no longer validates, or what the
   **Backup** section already names (backups not available on this server, no destination, no data). Two cases read
   differently on the page than in the database:
   - **A component crashed.** The page reads «Non riuscita» (`failed`) while the stored status stays `running` or
     `degraded`: **Avvia** stays disabled and **Riavvia** brings the application back (it restarts every component, and
     a stopped or crashed one starts again).
   - **«Esito da verificare» with no operation in doubt.** The panel has no fresh reading of the components (none in the
     last 5 minutes, or the last one failed; `outcomeUnknown` is `false` in the detail): the page says the state could
     not be read lately and offers the actions of the stored status. Check the executor (procedure 2 step 3); the next
     good reading puts the status back.
5. **A stack in `failed`.** The history on the application page names the reason (the stable code is the `problem` of
   `GET /v1/organizations/<orgId>/app-stacks/<stackId>/deployments`):
   - `STACK_SECRET_MISSING`: set the value in **Valori riservati**, then **Reinstalla**;
   - `STACK_HEALTH_TIMEOUT`: read the component logs, fix the cause, then **Riavvia** or **Reinstalla**;
   - `STACK_IMAGE_NOT_ALLOWED`, `STACK_TEMPLATE_INVALID`: the template is at fault; the administrator publishes a fixed
     version and the customer upgrades;
   - `DOCKER_ENGINE_UNAVAILABLE`, `OPERATION_INTERRUPTED`: the action was cut (Docker, the executor, an API restart or a
     restore); check procedure 2 step 3, then **Riavvia** or **Reinstalla**.

   An upgrade or a rollback that fails before its components are created (download, preparation) goes back to what its
   request replaced: the version, settings, components and quota asked for before that request (usually those of the
   version installed, but not after a change that failed past create, nor on an application never installed), the
   upgrade on offer again, and the failed attempt in the history. Not so when a web address or one of its paths was
   meanwhile pointed at a part only the new version has: the new version stays the one asked for and **Reinstalla**
   installs it. One that fails later leaves the stack `failed`: the page and the list show the version still installed
   and the page says which one was not (while they differ, the status shown follows the components of the installed
   one); **Reinstalla** tries that one again, the way back reinstalls the previous one. The way back only offers a
   version that ran (an install, upgrade or rollback of it succeeded, or failed only at publishing its routes once its
   components were healthy), never a failed attempt. A start of a stopped application refused before anything is
   touched leaves it `stopped`, and so does a reinstall, upgrade or rollback of it refused before its components are
   created once a version of it was installed, an upgrade or a rollback going back as above (when it does not, the new
   version stays the one asked for, as after a reinstall with new settings); one never installed ends `failed`, as no
   version of it is there to start; any other start or restart refused that way takes the status the containers show (so
   does the start that follows a backup or a restore, which then ends `failed`: the panel stopped it, not the customer);
   the history names the reason.

   **A version that adds a required private value** the customer types (issue #89): the update dialog asks for it under
   the template's label, and the update request carries it. It is stored as version 1 of an ordinary private value in
   the transaction that queues the update, and never shown again; **Valori riservati** lists it as set from then on and
   replaces it as usual. An update without it is refused at the request, next to its field (`STACK_SECRET_MISSING`,
   field `secrets.<key>`); an optional value, which is set among the private values after the update, is refused with
   `secret_not_needed`, also when the application has one already. An update taken back before create keeps the value,
   and the next attempt does not ask for it: a dialog still open on the older review that sends it is answered
   `plan_changed` and shows the review again, without the field. Only a value the new version requires and the
   application has is answered `plan_changed`: no review asks for any other. A value over 4096 UTF-8 bytes read from an environment variable, or over 24576 for any other, is refused
   with `value_too_long` next to its field. Such values are not held to the limit of 10 new versions an
   hour when they are stored (one per key, ever), and count in that hour afterwards like any value the customer sets.
   The audit names each key and its version (`app.stack.secret.rotate`). The keys a stack has, never the values:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select parameter_key, version, created_at from app_stack_secrets where stack_id = '<stackId>' order by parameter_key, version"
   ```

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
   does not list the feature `app-stacks` and a stack that is not deleted exists (drafts included), whatever its format.
   A release below `0.10.0` counts as not listing it: every `0.9` release lists `app-stacks` but has the stacks switched
   off on every backend. A `psql` error also counts as a refusal. `--dry-run` does not run this check. See what blocks:
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
5. The automatic rollback of a failed update stays ungated: migrations `0025`, `0026`, `0027`, `0028` and `0030` are additive.
6. **Extended format (`app-format-v2`, `ADR-0036`).** A target release from `0.10.0` on that lists `app-stacks` but not
   `app-format-v2` knows the stacks but cannot read a plan of the extended template format (`HCP-STACK/v2`): the same
   command exits with **code 8** while a stack that is not deleted is on a template version of that format, or keeps a
   revision written in it. Stacks of the first format do not block, and neither does a template of the extended format
   that no stack uses (the built-in WordPress template is such a row on every panel). A `0.9` release also lists
   `app-stacks` without `app-format-v2`, but step 1 applies to it: every stack blocks. See what blocks:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select s.id, s.organization_id, s.name, s.status from app_stacks s where s.deleted_at is null and (exists (select 1 from app_template_versions v where v.id = s.template_version_id and v.spec_version >= 2) or exists (select 1 from app_stack_revisions r where r.stack_id = s.id and r.plan->>'schemaVersion' <> '1'))"
   ```
   To go back without forcing, delete those stacks only (step 2); `--allow-feature-loss` works as in step 3, and the
   older release then fails to read those stacks until the panel is upgraded again.
7. **Routing options (`ADR-0037`).** The same command also exits with **code 8** when the target release does not
   list the feature `app-routing-options` and an address redirects, is protected by a password or has a path rule.
   Compression alone does not count. See what blocks:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select stack_id, hostname, redirect_to_domain_id is not null as redirects, access_username is not null as protected, jsonb_array_length(path_routes) as paths from app_stack_domains where redirect_to_domain_id is not null or access_username is not null or path_routes <> '[]'::jsonb"
   ```
   To go back without forcing: switch those options off on each address (procedure 10). With `--allow-feature-loss`
   an older release that still manages the stacks writes the route files without the options at its next route
   refresh: **a protected address becomes public**, a redirecting address serves the application and the path rules
   stop. The rows keep the options; after upgrading again they apply at the next route refresh.
8. **Backups of applications.** The same command exits with **code 8** also when the target release does not list the
   feature `app-stack-backups` and a row exists in `app_stack_backups`, whatever its status and also when its
   application is deleted. See what blocks:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select b.id, b.stack_id, b.kind, b.status, b.started_at, s.status as application from app_stack_backups b left join app_stacks s on s.id = b.stack_id order by b.started_at"
   ```
   No command of the panel deletes a backup; a row goes only with the nightly clean-up (procedure 11 step 7). An
   application that exists keeps its newest good backups whatever their age, so this check holds as long as that
   application lives: to go back without forcing, delete the application (procedure 3) and wait for the retention
   period, or keep the current release. With `--allow-feature-loss` the older release has no code for these backups: it
   does not list, restore or remove them. Their rows stay in the database and their copies on the destinations, and
   the database still refuses to delete a destination that holds one.
9. The links between a database and an application (procedure 12) are a feature of their own, `app-stack-links`:
   the same command exits with **code 8** while a row exists in `app_stack_links`, whatever its state, and the
   target release does not list that feature. See what blocks:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, consumer_stack_id, provider_stack_id, state from app_stack_links"
   ```
   To go back without forcing: the customer presses **Scollega** on each link, and the query lists nothing once the
   server has confirmed. With `--allow-feature-loss` the older release does not know the links: a database stays
   attached only until its container is replaced, nothing attaches it again, and an application cannot be deleted
   while a running database is still attached to its private network (`STACK_NAMESPACE_CONFLICT`).

## 4a. Tasks of an application (ADR-0042)

A template may declare up to eight **tasks** under `x-hp-tasks`: a command for one of its components. The customer
sees each task by its name on the application's page (section «Attività programmate»), runs it now or chooses when it
runs by itself (never, every hour, every day or every week at a whole hour, UTC). Nobody can send a command: a request
names only the key of a task, and the command is read from the template version of the **installed** revision.

1. **Declare a task** (server administrator, in the template source):
   ```yaml
   x-hp-tasks:
     - key: tidy
       label: Tidy up old notes
       description: Removes the notes deleted more than 30 days ago.
       service: app
       command: ["/app/bin/tidy", "--older-than", "30d"]
       timeoutSeconds: 120
   ```
   `command` is a list of arguments under the rules of a component's command: no argument may name a shell (`sh`,
   `bash`, `busybox`, `env`, …), and there is no placeholder (`${...}` is refused; `$$` is a literal dollar). `timeoutSeconds` is 5 to 600 (default 60). The
   component needs `/bin/sh`: the executor uses it only for its own clean-up, and a component without it answers
   «cannot run tasks» at the first run.
2. **What a run is.** The command is started directly in the component's running container, as the component's user,
   with nothing added but the environment variable `HP_TASK_RUN`. At its time limit the executor kills it and
   everything it started. One run of an application waits or runs at a time; its status does not change. The tasks of
   the whole server run one after another, so a run may wait for its turn: while it waits it does not hold the
   application (a stop, an update or a delete is accepted; its operation holds the lock `stack:<id>:task`). It takes
   the application's lock `stack:<id>` when it begins, and from then until it ends the application cannot be changed
   (`409 RESOURCE_LOCKED`); a new web address is still saved and published after the run (§10). A run that finds the application busy or stopped when its turn comes does not start
   (`not_started`, problem `busy` or `component_not_running`); a scheduled one gives its time back instead (step 4).
3. **See the runs of an application** (the last 20 per task are kept; the exit code is here and not on the page):
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, task_key, run_trigger, status, problem, exit_code, requested_at, ended_at from app_stack_task_runs where stack_id = '<stack id>' order by requested_at desc limit 20"
   ```
   Do not select `output` into a ticket or a chat: it is what the command printed (secrets of the component are
   masked, anything else is not).
   A run that failed with `exit_code` 127 and no output: the program of the task is not in the component's image
   (126: it is there but cannot be executed). Fix the template; the customer sees only «non riuscita».
4. **See the schedules and the times that were skipped:**
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select stack_id, task_key, frequency, hour_utc, weekday, served_slot_at, skipped_slot_at, skip_reason from app_stack_task_schedules order by stack_id, task_key"
   ```
   `busy` = the application was being changed or another run of it was waiting or running, `not_running` = it was
   stopped or failed, `missed` = nothing tried the time within 30 minutes (the panel was off, or the executor has no
   task calls: then the panel queues nothing). While `served_slot_at`
   is older than `skipped_slot_at` (or empty), the time is still owed and tried every minute; a scheduled run that
   could not begin leaves no row in `app_stack_task_runs` and makes its time owed again this way. After 30 minutes
   the time is given up (`served_slot_at` = `skipped_slot_at`) and never caught up. Several tasks of one application
   at the same hour run one after another; one that cannot start within 30 minutes is skipped as `busy`.
5. **A run reads «esito non noto» (`unknown`).** The answer of the executor was lost and the executor no longer knows
   the run (it restarted), or its answer to the panel's question did not have the expected shape. The panel never
   starts it again by itself: check the application, then press «Esegui ora» if running it twice is safe. While the
   executor still knows the run, the application stays held and the panel asks again at every recovery pass.
6. **The executor restarted while a task was running.** At start it kills what tasks left in the components
   (`journalctl -u hp-docker-executor | grep app_task_` shows `app_task_reap_failed` or `app_task_cleanup_failed` with
   a code only when that clean-up could not finish; restart the application to be sure nothing is left).
   `app_task_mark_in_component` with a `count`: that many running components carry `HP_TASK_RUN=` in their own
   environment (their image, or a container created before the rule against it). The clean-up kills nothing there and
   no task of such a component can run (its runs end not started, `unavailable`). Find the variable in the
   environment of the application's containers, then fix the image or recreate the component.
   The start-up clean-up works in four components at once and stops after 60 seconds, before the executor takes calls.
   `app_task_reap_unfinished` with a `count`: that many components were not cleaned by then; each is cleaned by the
   probe of its next run, and while a clean-up of it is still going no task of that application starts.
7. **Downgrade.** `hp-update --allow-downgrade` exits with **code 8** when the target release does not list the feature
   `app-tasks` and a template version that declares tasks exists: an older release refuses the source of such a version
   and cannot show the applications that use it. Template versions are never deleted, so the only way back is
   `--allow-feature-loss`. See them:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select v.id, t.slug, v.version_number from app_template_versions v join app_templates t on t.id = v.template_id where jsonb_array_length(coalesce(v.compiled_schema -> 'tasks', '[]'::jsonb)) > 0"
   ```
   The automatic rollback of a failed update stays ungated: migration `0031` is additive. A run queued at that moment
   is closed as failed by the older release and its row is repaired at the next upgrade.
8. The real-Docker check is `infra/linux/accept-app-tasks.mjs` (procedure 9: build first, run it alone).

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
   **Ripristina**, procedure 11) **was not tried**: `ADR-0038` leaves it out of scope. Try it on the application whose
   data matters least before relying on it.
5. A `delete_failed` stack: delete it again from the panel (procedure 3).
6. Links between a database and an application (procedure 12): the restore SQL sets every `active` link back to
   `pending`, because the new server has no container to attach. Nothing needs doing by hand: a link becomes
   `active` again by itself once the database and the application are both installed again.

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
3. **Logs.** The application page shows the last 1 to 500 lines per component with secret values masked. A server
   administrator reads the same masked lines without the customer (procedure 13). For more:
   `sudo docker logs --tail 500 hp_app_<stackId>_<componentKey>`; that output is **not** masked and may hold a secret
   value: never paste it into a ticket.
4. What the panel never does for a stack: the drift reconciler never restarts or recreates a stack container; a stack
   action never stops or recreates a site; a route change rewrites only `app_<stackId>.yml`.

## 7. Turn the feature off again

1. **There is no runtime switch.** On a server (runtime backend `linux-systemd`) this release turns
   `applicationTemplatesAvailable` and `applicationStacksAvailable` on in code (`appFeaturesFor`,
   `packages/contracts/src/resources.ts`); no environment variable, option or setting turns them off. What an operator
   can do instead:
   - **Stop new installations.** In **Modelli**, switch off **Offerto ai clienti** on each application template and
     archive the ones that are not built-in (procedure 6, step 2). The catalog then offers nothing to install;
     installed stacks keep running.
   - **Go back to an earlier release**, where both flags are `false` on every backend:
     `sudo hp-update --version <older> --allow-downgrade` (procedure 4). The releases below `0.10.0`, from `0.9.0`,
     list `app-stacks` in `RELEASE.json` but have both flags off, so the gate counts them as not listing it and exits
     with **code 8** while any stack that is not deleted exists, whatever its format (procedure 4, step 1); an older
     release does not list `app-stacks` and refuses the same way. From `0.10.0` on, only the features that the target
     does not list block (procedure 4, from step 6).
   - **Change the code:** a release whose `appFeaturesFor` gives `false` for `linux-systemd`.
2. If a release with the flags on is followed by one with them off (or by a downgrade), do this first: disable or
   archive the templates so nobody installs one, and ask the customers to stop or delete their stacks. Once the flags
   are off, nobody can do it from the panel (every stack route answers `NOT_SUPPORTED`).
3. Afterwards, stacks that are running keep running until they are stopped, and no data is deleted: containers,
   volumes and rows stay, and the downgrade gate still counts the stacks.

## 8. After a host reboot

1. A stack's secret files live under `/run/hosting-panel/secrets`, a tmpfs that is empty after every boot. Docker
   starts the stack containers again (`unless-stopped`) before the executor runs, so a component that reads a secret
   file finds none and fails or runs without it. Nothing repairs this by itself. A secret given in the environment
   (extended format, `ADR-0036` §2.5) is kept by Docker in the container, so a component whose secrets are all in its
   environment keeps working. Components without secrets are not affected.
2. The component logs stay masked. The executor takes the values of the environment secrets from the container
   itself (its label `io.hostingpanel.app_secret_env` names them, its environment holds them) and adds the values of
   the secret files it finds. One case needs the files: a value in which the template's text does not separate two
   secrets in one way only (two secrets side by side, or that text also inside a secret). Until **Riavvia** writes the
   files again, the executor refuses that component's logs, and the panel says they are not available right now; it
   never shows them unmasked.
3. The stacks that have secrets:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select s.id, s.organization_id, s.name, s.status from app_stacks s where s.deleted_at is null and exists (select 1 from app_stack_secrets x where x.stack_id = s.id)"
   ```
4. On each, the customer (or a hosting administrator of the organisation) presses **Riavvia** (`stack.restart`): it
   writes the secret files again, then restarts every component. **Avvia** does not rewrite the files of a component
   that is already running.

## 8a. After an update that changes how application containers are built

1. Every application container carries the label `io.hostingpanel.app_body_version`: the version of the code that
   built it (`ADR-0035` §2.10). A release that changes how containers are built for the same application (a setting,
   a label, a mount, where the secret files are) raises that version. The release that brought the label is such a
   change: every container created before it has no label and counts as older.
2. Nothing replaces a running container by itself. The update, a host reboot, **Avvia** and **Riavvia** leave every
   container as it is, with its old settings. Only the next **Reinstalla** (deploy), upgrade or return to a previous
   version of each application replaces its older containers, **once**: each one stops, is removed and is created
   again, with the short interruption a replacement has. The application's volumes and the data in them stay; what a
   container kept outside them is lost: the files it wrote in its own file system, and a folder its image declares
   that the template does not mount (issue #98). A later deploy with nothing changed replaces nothing.
3. The panel does not show which applications still run older containers. List the containers and their version
   (an empty version is a container built before the label existed):
   ```bash
   sudo docker ps -a --filter label=io.hostingpanel.role=app_component --format '{{.Names}}\t{{.Label "io.hostingpanel.app_body_version"}}'
   ```
   To bring an application to the new settings at a time that suits its customer, the customer (or a hosting
   administrator of the organisation) presses **Reinstalla** on its page. The server administrator cannot do it from
   the console.

## 9. Read the acceptance scripts' output

1. The real-Docker checks are `infra/linux/accept-app-stack-engine.mjs` (the stack engine),
   `infra/linux/accept-app-stack-http-cache.mjs` and `infra/linux/accept-app-stack-worker-storage.mjs` (the two built-in
   templates of the first format), `infra/linux/accept-app-stack-wordpress.mjs` (the built-in WordPress and MariaDB
   template of the extended format: it installs a real WordPress with two throw-away passwords, about 40 seconds when
   the images are local), `infra/linux/accept-app-stack-backups.mjs` (backup and restore of an application,
   `ADR-0038`), `infra/linux/accept-app-stack-databases.mjs` (the three built-in databases and their private
   links) and `infra/linux/accept-app-terminal.mjs` (the terminal in a component, `ADR-0041`; its own
   prefix is `hp_swarmtest_term_<hex>`, it creates no proxy and no edge network, and it needs the image of the
   «Lavoro periodico con archivio» template on the machine: its `preflight` step fails and names the image when it is
   missing). They import the built packages: build first (`corepack pnpm run build`), then run one at a time, never
   next to a test run (memory):
   ```bash
   node infra/linux/accept-app-stack-engine.mjs
   ```
   The WordPress script has a second run, for a template that comes from **Importa da Compose**: it imports the
   WordPress and MariaDB Compose file of the importer's tests and makes the same checks on the draft (three generated
   values: the database account too). The file names the versions the built-in template pins and the import is given
   the digests recorded with them, so nothing new is downloaded. With `HP_ACCEPT_REGISTRY_CASES=1` it also asks the
   public registry for the two tags through the product, a read that needs the network; without it that step is
   skipped:
   ```bash
   node infra/linux/accept-app-stack-wordpress.mjs --imported
   ```
2. They are safe on a live server: they reach Docker only through their own default-deny gate socket, create and
   remove only objects whose name contains `swarmtest_<hex>` (a random value per run) or starts with the script's own
   prefix (`hp_swarmtest_<hex>` for the engine script, `hp_swarmtest_stk_<hex>` for the three template scripts: their
   throw-away proxy `<prefix>_proxy`, its network `<prefix>_ingress`, a temp folder and `/dev/shm/<prefix>-secrets`;
   the databases script uses the same prefix for a temp folder and `/dev/shm/<prefix>-secrets` only: it starts no
   proxy and creates no edge network), never prune, and clean up at the end, also on Ctrl-C.
   The executor of the server's own panel attaches its proxy to every network whose role label is `app_edge`, whoever
   created it, so every script that creates an edge network (the engine, HTTP cache and WordPress scripts) hides it:
   in Docker that label has another value, which the script's gate translates in both directions, and the server's
   proxy never joins a run's network.
   An edge network a failed run left behind has the role `app_edge_under_test` in Docker and a name that contains
   the run's `swarmtest_<hex>`. List it, then remove it by exact name (after the run's containers, item 5):
   ```bash
   sudo docker network ls --filter label=io.hostingpanel.network_role=app_edge_under_test
   sudo docker network rm <network>
   ```
   The panel's proxy never joins such a network, because it looks only for the role `app_edge`.
   The backups script uses `hp_swarmtest_<hex>` too; its job containers are named `hp_bk_op_<hex>…`, plus one
   `hp_bk_test_<16 hex>` for the destination test. It gives its application no address, so it creates no edge network.
   Its job containers carry the role of the panel's own jobs (`site_job`), and `hp-docker-executor` removes such
   containers when it starts: do not restart the executor while this script runs (the run would fail, without harm).
3. Each step prints one line: `PASS <step>`, `FAIL <step>: <reason>` or `SKIP <step>: <why>`. A step that needs root is
   skipped unless the script runs as root with `HP_ACCEPT_ROOT_CASES=1`. `INFO` lines are measurements and notes,
   never a failure. When an image the script does not pull is missing (the engine script's test image, `traefik:v3.7`
   for the template scripts, the test image or the backup tool's image for the backups script), it prints
   `SKIP … nothing was created` and exits 1. Without a build a template script and the databases script print
   `FAIL preflight: run corepack pnpm run build first`. The databases script downloads nothing: when the image of a
   built-in database is not on the server, its `preflight` step fails and names the missing images; fetch each first
   (`docker pull <repository>@sha256:<digest>`, the references are in `ADR-0039`) and run it again.
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
6. The routing options (`ADR-0037`) have their own check, `infra/linux/accept-app-routing-options.mjs`:
   ```bash
   node infra/linux/accept-app-routing-options.mjs
   ```
   It deploys no stack. It writes a route file with the production writer, starts a throw-away proxy from
   `traefik:v3.7` on `127.0.0.1:16880` and `127.0.0.1:16843` and two small web containers, and asks the proxy what a
   visitor would get (redirect, password, compression, path rules): once as a server without Let's Encrypt, once
   with it. Unlike the scripts above it uses the `docker` command line behind a name check, not a gate socket. It
   creates only objects named `hp_swarmtest_rt_<hex>…` or `hp_app_stk_swarmtest_<hex>_…`, puts no label on them (a
   live panel never adopts them) and removes them at the end, also on Ctrl-C. It needs `traefik:v3.7` and the web
   image of the built-in «HTTP + cache» template already on the machine (`SKIP … nothing was created` otherwise) and
   both ports free. In the second pass the certificate authority is a closed local port on purpose, so no
   certificate request leaves the machine: the `INFO` line counts the proxy's error lines about it, and they are
   expected. A `FAIL` of `foreign-containers-untouched` names a container that was on the machine before the run
   and whose networks changed, or that is gone: look at it before anything else.

## 10. Routing options of an address

Each web address of a stack has four options (`ADR-0037`): a redirect to another address of the same stack, password
protection (the browser asks a user name and a password), compression, and up to four path rules that send a
sub-path such as `/api` to another component and port of the same stack. A customer owner or a hosting administrator
of the organisation (`app.update`) changes them on the application page, **Opzioni** next to the address. The server
administrator's console has no such action, and nobody writes proxy configuration.

1. **When a change applies.** Saving stores the options and, when the routes of the stack follow its addresses (first
   case below), queues the route refresh in the same transaction, so no other action can be queued in between; adding
   or removing an address does the same. The panel's periodic check of the applications (every minute by default)
   queues it again when that refresh failed and the addresses changed since it was queued.
   The refresh is a short action on the stack that rewrites `app_<stackId>.yml` for the revision that runs, also
   when a newer version was asked for and not installed (an upgrade that failed before it changed anything): the
   proxy reads the file again by itself and no container is restarted. An option change waits neither the five
   minutes of a health-only change nor the ten minutes after a failed action; after a failed refresh the periodic
   check waits those ten minutes only for the addresses that refresh was queued with (after a restart of the API, which
   remembers no queued refresh, only when the saved addresses are those the last successful publication was made from). A change either reaches every route
   file of the stack that may be in place or is refused, so the panel never shows an option the live file lacks:
   - running or partly running, with no action in progress and the last action not a stop, or with only the panel's
     own route refresh queued or running (it reads the addresses when it runs; the check after it catches a change it
     missed): saved, and the page says «Opzioni salvate: valgono tra qualche istante» (the API answers `applies: shortly`);
   - not installed yet, or stopped (a stop withdraws the routes): saved, and the page says the options apply when the
     application is started (`applies: at_start`); the next start publishes them;
   - any other state (an action the customer asked for in progress, failed, outcome to be verified, or a stop the
     customer asked for that did not finish): refused with `409 RESOURCE_LOCKED` and nothing is saved, because a route file may be in place that
     nothing would rewrite. Let the action finish, or start or restart the application, then save again. After a stop
     that did not finish the application reads running or degraded, so the reason is `stop_unfinished` and the page
     says to press Stop again or Restart.

   Removing an address frees the name for anyone, another customer included, while a live file could still serve
   it, so it is stricter: it is accepted only when the refresh it queues withdraws the name now (first case above), or
   when nothing is published and no action is open (never installed, or stopped). While the panel's own refresh is
   queued or running (it may have read the address already) or a first install runs, it is refused with the same
   `409 RESOURCE_LOCKED`; remove it once that action is over. Adding an address is always possible: it
   reads «In attesa» until a published file holds it.

   While a run of a task executes (§4a, at most its time limit) it holds the application's lock, so no refresh can
   be queued: a new address is saved, nothing is queued, `routesPending` is true, and the observer's first pass after
   the run publishes it. A change of the options or a removal that has to reach the live file is refused with
   `409 RESOURCE_LOCKED`, retryable, reason `task_running` (the page says to try again in a few minutes), and nothing
   is saved. The panel tells this case from the others by the kind (`stack.task`) of the operation that holds
   `stack:<id>`.

   When the refresh itself fails (the executor does not answer) and an action fails after it, the live file keeps
   what it had: the application's detail then has `routesPending: true` and the page shows «Opzioni non ancora attive»
   next to every address that shows an option, never the option as active. The next successful start, restart or
   refresh publishes what is saved.
   `routesPending` is exact: every successful publication stores, with the routes hash, a fingerprint of the addresses
   and options it was made from (`app_stacks.applied_addresses_hash`), whatever the health of the targets, and the
   field is true exactly while the saved ones differ from it. The same comparison decides whether a change queues the
   refresh in its own request, so a path to a part that has no address of its own, a new address, or the first
   address of an application queues it like any other change. A stop, a recovery or an older release that writes the
   routes hash alone leaves the fingerprint unknown, which reads as pending while routes are published; with nothing
   published (stopped, never installed) nothing is pending.
2. **See the options of a stack** (read-only; the query leaves the verifier column out on purpose):
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, hostname, redirect_to_domain_id, compression, access_username, path_routes from app_stack_domains where stack_id = '<stackId>' order by hostname"
   ```
3. **The password.** The panel keeps only a verifier of it (it starts with `$apr1$`), in the database row and in the
   route file; nobody can read the password back. A forgotten password is replaced from **Opzioni** with a new one of
   at least 12 characters. Never paste `app_<stackId>.yml` or the column `access_password_hash` into a ticket: a
   verifier can be attacked offline. The application never receives the user name or the password.
4. **The password travels in clear over HTTP** until the address has a usable certificate, and always on a server
   without Let's Encrypt; the options dialog says so on such an address. Once the certificate is usable, HTTP only
   sends the visitor to HTTPS and asks nothing.
5. **A redirect** is permanent and keeps path and query. The redirecting address is published only while its
   destination is. Removing the destination clears the redirect, and the address serves the application again. A
   redirecting address has no password and no path rule of its own: set them on the destination.
6. **A path rule whose target is not ready** (its component is not healthy) is not published: requests under that
   path reach the address's main component until the target reads healthy again. A path must point at an entry
   point of both the version that runs and the one asked for, and an upgrade or a rollback to a version without that
   entry point is refused (`path_target_removed`): remove the path first. The dialog offers only those entry points
   (`pathTargets` of the application's detail) and marks a target the application no longer offers as «Non più
   disponibile».
7. **Downgrade:** procedure 4, step 7. **The real-Docker check:** procedure 9, step 6.

## 11. Backup and restore of an application

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
   (`409 RESOURCE_LOCKED`, to try again later). The executor keeps the rule by itself: while a copy, restore or
   removal job of the application runs or is being cleaned up, it refuses to start, restart, install, update or remove
   that application or a part of it, also when the panel has already closed its action; stopping it stays possible. The same refusals,
   and the refusal of a new copy or restore, hold while a job container of an earlier one still runs, even after its
   job ended or the executor restarted (the executor could not stop or remove it:
   `sudo docker ps --filter label=io.hostingpanel.app_backup_of=<stackId>`); one that has stopped (created, exited or
   dead) does not count, and the executor removes it at its next start, going on to the next one when a removal fails.
   Actions on other applications are not held up: backups and restores
   run in a worker lane of their own, one at a time (a second one waits for its turn), and the nightly clean-ups in
   another. The copy holds the data volumes only: no image, no settings, no web address and none of the **Valori riservati**.

   A job container that never exits blocks start, restart, install, update and removal of that application for good,
   and the customer only reads that the action could not finish. The way out (server administrator), either:
   - restart the executor, `sudo systemctl restart hp-docker-executor`: at its start it stops and removes every job
     container (label `io.hostingpanel.role=site_job`), running ones included. That also ends every other backup job
     running at that moment (of a site, of the panel, of another application), which then closes as interrupted: first
     check with `sudo docker ps --filter label=io.hostingpanel.role=site_job` that the leftover is the only one listed;
   - or remove that one container by the name the `app_backup_of` filter prints (the one `docker rm` this procedure
     allows): `sudo docker rm -f <name>`.

   Afterwards `sudo docker ps -a --filter label=io.hostingpanel.app_backup_of=<stackId>` lists nothing (if it still
   lists the container, Docker itself cannot remove it: `sudo systemctl status docker`), and only then the customer
   presses **Avvia**. A name with `_rs_` was a restore writing a volume back: its data may be half written, so read
   step 6 first (the **Backup** section names the backup to restore).
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
   and the application starts again untouched. The executor checks this by itself: it writes a backup back only after
   it took, in the same run of the executor, a good safety copy of the same restore holding every volume it writes
   (one destination is enough); after
   an executor restart in between, the restore fails with nothing written. Only a volume that is both in the backup and in the application today
   is written; a backup none of whose volumes exist any more cannot be restored.
6. **A restore that failed.** When it failed before anything was written, the application starts again by itself.
   When it failed **while writing**, or the panel cannot tell, the application **stays stopped**: its data may be
   incomplete. The **Backup** section then names, by its date and time, the backup to restore: the newest
   «Prima di un ripristino» backup taken from whole data. It is not always the newest of its kind: a backup or a
   restore asked while the data were still half written saves a copy of those half written data, and the list marks it
   («Questa copia è stata fatta dopo un ripristino non finito»), a backup made by hand as well as a safety backup.
   Restoring such a marked copy succeeds but brings the
   half written data back: the section goes on naming the backup of whole data. Do not press **Avvia** first unless losing the state
   before the restore is acceptable: a start, or any other action asked of the application except a backup, takes the
   data as they are once it succeeds, and from then on the section names no backup to go back to. An action that
   fails takes nothing (a start the executor refuses because a backup job of the application still runs, for example:
   step 3), and while one is under way the section still names the backup. The data are half written **now** only
   while the newest operation of the application that decides is a restore whose safety backup (the row with the same
   `operation_id`) has `left_incomplete`: a restore decides unless it was cancelled, failed or not; any other action
   decides only once it succeeded; a backup, a clean-up or the run of a task (§4a) never. `incomplete_data` marks a
   copy of half written data, of either kind. To see both:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, kind, status, submitted_at from operations where lock_key = 'stack:<stackId>' and kind not in ('stack.backup', 'stack.prune', 'stack.task') and ((kind = 'stack.restore' and status <> 'cancelled') or status = 'succeeded') order by submitted_at desc, id desc limit 1"
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, kind, operation_id, status, started_at, incomplete_data, left_incomplete from app_stack_backups where stack_id = '<stackId>' order by started_at desc"
   ```
7. **What is kept.** For each application the three newest good backups made by hand and the three newest good safety
   backups, whatever their age; a failed backup until the retention period of the sites' backup policy is over (14 days
   unless changed). While the data are half written now (step 6), the safety backup the section names to go back to
   is kept too, whatever the count of newer ones; once an action takes the data as they are, it is kept like any other. The backups of a **deleted**
   application stay for that period, then every copy and row goes. The
   clean-up runs with the nightly backup run (`stack.prune`, «Pulizia dei backup»), so the list can show more than
   three for some hours. It is an operation of the platform, not of the customer: the customer cannot open it, and
   while it runs the application page says that its expired backups are being removed and every action on it answers
   `409 RESOURCE_LOCKED`. A destination that fails keeps the rows, and the next night finishes the work.
   On a server with no usable destination the nightly run does nothing, and no backup of an application is removed.
   The executor runs two backup jobs at a time: the sites' nightly backups and the panel's own nightly copy, queued in
   the same run, may find both taken by a clean-up, an application's backup or restore, or another job (the copy
   before a WordPress update). A refused one is asked again every minute under its own operation, but the night has
   one wait, shared by the sites and the panel copy with all its destinations: **15 minutes** in all from its first
   refusal. After it, each one still refused fails at once as before (a site as `site_busy`) and gets its next backup
   the next night; each night has at most one panel copy. It is reported like any failed nightly backup: the site's
   backup list shows it failed, and the server administrator's **Stato** page shows the alert of the site's failed
   backup or of the panel's. While the night waits, the worker lane of the sites' and the panel's backups is held: a
   backup, a restore or a download a person asks for then starts when the wait ends, at most 15 minutes later. A site
   that waits is locked as during its backup (its actions answer `409 RESOURCE_LOCKED`). The wait is kept in memory:
   restarting `hp-api` during the run starts another one. A backup a person asks for, and the one before a WordPress
   update, never wait for a job: with both taken they are refused at once.
8. **Where the copies are** (server administrator). One encrypted repository per application per destination, next to
   the sites' ones and with their key: on a local destination the folder `stacks/<stackId>` under that destination's
   folder (`/var/lib/hosting-panel/local-repos/<targetId>` unless `HP_BACKUP_LOCAL_ROOT` says otherwise), on S3 the
   same path under the destination's location. Never write, move or delete there by hand. The page
   **Amministrazione › Backup** counts these copies with the others of a destination, and a destination that holds one
   cannot be deleted.
9. **The backup or the restore reads «Da verificare».** Procedure 2 applies: the panel reads the state of the
   application and of the job from the executor and settles the action; it never sends a copy or a restore twice. A
   job the executor no longer knows (it restarted) is closed as interrupted. The action also reads so when the panel
   lost track of a job the executor had accepted (no answer, an answer the panel could not read, or the database
   failed while the job ran): until the job's end is read, the application keeps its lock and nothing can start it,
   because the job may still be reading or writing its data.
10. **Limits.** No scheduled backup, no restore into another application, no download of a backup, no backup without
    stopping, no destination per application (`ADR-0038` K12). Not tried on real Docker: hard links, extended
    attributes, file capabilities, device files, an S3 destination, two destinations at once. A copy is taken with the
    application stopped, so a database inside it is saved as its files on disk.

## 12. Databases and private links

1. A database is an application like the others, installed from a template of category `database`. Three come with
   the panel, disabled until the server administrator publishes them: «Database MariaDB» (`atpl_mariadb`), «Database
   PostgreSQL» (`atpl_postgresql`) and «Archivio Valkey» (`atpl_valkey`). A database has one component, one port and no
   web address: nothing outside the server reaches it, and no other application does until it is linked to it.
2. **Linking.** On the page of an application, section «Database», the customer picks one of their own databases and
   presses **Collega**; the page of either side has **Scollega**. Both need `app.update`. A link joins two
   applications of the same customer; an application has at most 4 databases and a database at most 8 applications.
   The page of the database (section «Collegamento») shows the address and the port to type into the application.
   The panel copies no address, user or password from one to the other: the customer does.
3. **What a link is on the server.** The executor attaches the database's container to the private network of the
   application, under the name `stk-<…>` (the database's id with `-` in place of `_`). Nothing else changes: no
   container is restarted or recreated, no port is published, the proxy is not involved. What Docker has (read-only):
   ```bash
   sudo docker inspect hp_app_<databaseStackId>_<componentKey> --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{println}}{{end}}'
   ```
   It lists the database's own network (`hp_appnet_<databaseStackId>`) and one `hp_appnet_<stackId>` for each
   application the database is attached to.
4. **The state of a link.** What the panel recorded:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, consumer_stack_id, provider_stack_id, state, updated_at from app_stack_links order by provider_stack_id, created_at"
   ```
   `consumer_stack_id` is the application, `provider_stack_id` the database. `active` («Attivo»): the server
   confirmed the attachment. `pending` («In attesa»): recorded, not confirmed. `removing` («Scollegamento in corso»):
   the row goes away once the server has confirmed the detach. The panel brings the server to the rows by itself:
   when a link is created or removed, at every installation, start or restart of the database or of an application
   linked to it, and about once a minute for whatever still waits (at most 20 databases per pass, and no new database
   after 45 seconds of the pass: the next pass begins with the databases it did not reach). There is no button to
   retry, and none is needed. A backup of a database (procedure 11) stops it for the copy: the applications linked to
   it cannot reach it until it runs again. Its links stay as they are (an attachment outlives a stop, and a link
   call never starts a container), and the start that follows the backup applies them before the database runs.
5. **A link that stays `pending`** is waiting for one of these: the database or the application has never been
   installed (the database has no container, or the application has no private network yet); one of the two is in the
   middle of an operation; the executor did not answer; the installed version of the database has more than one
   component. A waiting link never fails or delays a start: the application starts without it and cannot reach the
   database until the link is `active`. Check both applications (procedure 1) and the executor
   (`sudo journalctl -u hp-docker-executor`).
6. **Deleting.** A database that an application still uses cannot be deleted, and cannot move to a template version
   that is not linkable (more than one component, or no single port): the panel answers `database_in_use`. Disconnect
   it from every application first. Deleting an application removes its links; the executor detaches the databases
   from its private network before it removes that network, and the databases keep running.
7. **Never run `docker network connect` or `docker network disconnect` on a stack's container by hand.** The panel
   does not notice: its state stays as it was until the next pass for that database (a link created or removed, a
   start of the database or of one of its applications), which puts the server back to what the rows say.

## 13. Administrator: the page and the logs of a customer's application

Only a server administrator, and only where `applicationStacksAvailable` is `true` (`ADR-0041`). No support visit is
needed, and a support visit gives none of this.

1. **Amministrazione › Applicazioni**, then **Apri** on the application's row. The page (`/admin/apps/<stackId>`)
   shows the customer, the template and its version, the status the customer sees, the web address («Nessun indirizzo
   web» when the application has none) and every component with its last observed health. It shows no parameter, no
   secret and no plan.
2. **Registri** on that page: choose a component and read its last lines, 1 to 500. They are the lines the customer
   sees on their own page, with the application's secret values masked.
3. **Every read is recorded.** The audit action is `admin.app_stack.logs.read`, on the application, with the customer's
   organisation, the component and the number of lines asked; it never holds a line that was read:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select timestamp, actor_id, organization_id, target_id, details from audit_events where action = 'admin.app_stack.logs.read' order by timestamp desc limit 20"
   ```
4. What the answers mean: `403` the caller is not a server administrator (also recorded); `422` applications are off
   on this server; `404` the application is unknown or deleted, or it has no component of that name; `503` the
   executor is not running.

## 14. Administrator: a terminal in a component

A text shell (`/bin/sh`) inside the container of one component, for a server administrator (`ADR-0041`). It is the
terminal of the sites (`ADR-0027`) with a different place and a different user.

1. **Open it.** On the application's page (procedure 13), **Terminale** on the component's row. The account needs
   two-step authentication, and every open asks for a **new** six-digit code: a code already used, also for signing
   in, is refused until the next one. Wrong codes count like the ones of a sign-in: the fifth locks the account for 15
   minutes.
2. **What the shell is.** It runs as the user the component runs as, in the component's own container: no capability,
   a read-only base file system, the component's memory and process limits, only the component's volumes and networks.
   The panel never opens a shell on the host and never starts a helper container for this. The tools are the ones in
   the image, often very few; full-screen programs (editors, pagers, `top`) do not work. **Ctrl-C** stops a command,
   **Ctrl-D** ends the shell, **Chiudi** ends the session.
3. **What it can reach.** The secret files of the application in `/run/secrets`, and the secrets a template of the
   extended format gives in the component's environment (the shell inherits it: `env` prints them), are readable from
   the shell and are **not** masked: never paste what a session prints into a ticket. The shell can change the
   application's data in its volumes; the panel records that a session took place, never what it did.
4. **Limits, shared with the sites.** Four sessions on the server, counting sites and applications together; one per
   component (two components of one application may each have one). A session ends by itself 60 seconds after the
   page stops reading (tab closed or asleep) or 30 minutes after it was opened.
5. **When an open is refused**, no code is spent unless the code itself was wrong:

   | The page says | Reason | What to do |
   | :--- | :--- | :--- |
   | the component is not running | `container_down` | The application was never installed or is stopped: its customer starts it (**Avvia**), then try again. |
   | the application is being changed | `site_changing` | An operation holds the application (install, start, stop, upgrade, delete). Wait for it. |
   | a session is already open in this component | `site_busy` | Close that session, or wait 60 seconds after its page was closed. |
   | the server has no free session | `server_full` | Four sessions are open on sites and applications. Close one. |
   | the server cannot run applications now | `503` | The executor is stopped, or older than the API: `systemctl status hp-docker-executor`. |

6. **How a session ends.** `closed` (the administrator), `shell_exited` (Ctrl-D or `exit`; also an image with no
   `/bin/sh`, where the session ends at once), `idle`, `time_limit`, `container_gone` (the application was stopped,
   restarted, upgraded, rolled back or deleted while the session was open: open a new one with a new code),
   `executor_gone` (the executor stopped or was restarted), `not_started` (the executor refused the open). At every
   end where the container is still there, the executor kills what the session started, also what was left in the
   background with `&`, `nohup` or `setsid`; it never touches the component's own processes. In an image with no
   `/bin/sh` the engine refuses that clean-up too (`OCI runtime exec failed`, exit 127 or 126): no shell ever ran
   there, so the executor counts it as done and logs no `terminal_kill_failed`.
7. **What is recorded.** `admin.terminal.open` and one `admin.terminal.close` per session, on the application, with the
   component, the container's name, the duration and the reason; `admin.terminal.denied` for every refused code.
   Nothing typed and nothing printed is stored or logged anywhere. The sessions and their audit rows:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, user_id, stack_id, component_key, opened_at, closed_at, close_reason from admin_terminal_sessions where stack_id is not null order by opened_at desc limit 20"
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select timestamp, action, actor_id, target_id, details from audit_events where target_type = 'app_stack' and action like 'admin.terminal.%' order by timestamp desc limit 20"
   ```
8. **After the executor was restarted.** Nothing to do. The open sessions end as `executor_gone`, and at its start the
   executor kills what a session left in every running component that still has a command open, without restarting
   any component. If that pass fails, the executor logs one line with `"event":"terminal_reap_failed"` and a code
   (`journalctl -u hp-docker-executor`); it tries again at its next start. In a component whose own environment
   spells the session's mark (step 10), that pass kills nothing: the executor logs one line with
   `"event":"terminal_own_mark"` and the number of such components, and what a session left there stays until the
   customer's **Riavvia**.
9. **Known limits.** A process that deliberately leaves the session and removes the session's mark from its own
   environment survives the end of the session; a background program can also survive when the executor dies within
   one second after a shell ended by itself. Either stays inside the component's limits, and nobody is connected to
   it: the customer's **Riavvia** on the application ends it. After a downgrade to the previous release, a shell left
   in a component is not cleaned by the old executor (it cleans sites only): **Riavvia** ends it as well.
10. **A value that holds a platform mark.** No value of an application (a setting, a private value, a template's text
    or argument) may contain `HP_TERMINAL_SESSION=` or `HP_TASK_RUN=`: the clean-up finds what a session or a task run
    started by that text, so a component that carried it could have its own programs killed (`ADR-0041` §4). Other
    `HP_` or `PHP_` text is accepted. A new value is refused with its reason. A value made of two private values (an
    environment secret of the extended format) is checked once joined too: when the two together form a mark, the
    action that creates the component's container (install, **Reinstalla**, upgrade, rollback) fails with a generic
    reason, and the executor logs one line with `"event":"app_stack_env_mark_refused"`, the application and the
    component, never a value (`journalctl -u hp-docker-executor`); the customer replaces one of the two private
    values, then presses **Reinstalla**. A revision or a private value saved before this rule that holds such text is
    refused after the update: the application's page answers an error and a start is refused. Applications were first
    switched on in release 0.10.0, so none is expected. If one exists, correct the value (the customer replaces a
    private value from the application's page), or stop the application or delete it (procedure 3).
