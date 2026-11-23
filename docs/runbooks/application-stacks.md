# Runbook — Application stacks

Operator procedures for application stacks (`ADR-0035`). Design record:
`docs/architecture/adr/0035-application-stacks.md`. Acceptance evidence and what is still pending:
`docs/security/hcp-spec-005-acceptance-report.md`. Databases and the private links between a database and an
application (`ADR-0039`, `docs/architecture/adr/0039-application-databases.md`) are in procedure 10.

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
  (ACME) certificates only for stack domains, no public TCP/UDP port, no stack backup.
- **Who acts on a stack:** a customer owner or a hosting administrator of the organisation (permissions `app.read`,
  `app.create`, `app.update`, `app.control`, `app.delete`). The server administrator's console has the template catalog
  (**Modelli**, kind «Applicazione multi-servizio») and a read-only list of every stack in **Applicazioni**; it has no
  stack actions; collaborators and support access have no stack permission.
- **Never run `docker rm`, `docker volume rm`, `docker network rm` or any `prune` on a stack's objects by hand**, except
  where a step below says so. The panel owns them; removing one by hand leaves the panel's view wrong.
- **Stack data is in no backup.** The site and panel backups (S3 or local) do not include stacks or their volumes.
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
5. The automatic rollback of a failed update stays ungated: migrations `0025` and `0028` are additive.
6. The links between a database and an application (procedure 10) are a feature of their own, `app-stack-links`:
   the same command exits with **code 8** while a row exists in `app_stack_links`, whatever its state, and the
   target release does not list that feature. See what blocks:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select id, consumer_stack_id, provider_stack_id, state from app_stack_links"
   ```
   To go back without forcing: the customer presses **Scollega** on each link, and the query lists nothing once the
   server has confirmed. With `--allow-feature-loss` the older release does not know the links: a database stays
   attached only until its container is replaced, nothing attaches it again, and an application cannot be deleted
   while a running database is still attached to its private network (`STACK_NAMESPACE_CONFLICT`).

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
4. **The data of the volumes is not restored**: it was in no backup. Copying data back into a volume is outside the
   panel.
5. A `delete_failed` stack: delete it again from the panel (procedure 3).
6. Links between a database and an application (procedure 10): the restore SQL sets every `active` link back to
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
   application templates) and `infra/linux/accept-app-stack-databases.mjs` (the three built-in databases and their
   private links). They import the built packages: build first (`corepack pnpm run build`), then run one at a time, never
   next to a test run (memory):
   ```bash
   node infra/linux/accept-app-stack-engine.mjs
   ```
2. They are safe on a live server: they reach Docker only through their own default-deny gate socket, create and
   remove only objects whose name contains `swarmtest_<hex>` (a random value per run) or starts with the script's own
   prefix (`hp_swarmtest_<hex>` for the engine script, `hp_swarmtest_stk_<hex>` for the two template scripts: their
   throw-away proxy `<prefix>_proxy`, its network `<prefix>_ingress`, a temp folder and `/dev/shm/<prefix>-secrets`;
   the databases script uses the same prefix for a temp folder and `/dev/shm/<prefix>-secrets` only: it starts no
   proxy and creates no edge network), never prune, and clean up at the end, also on Ctrl-C.
3. Each step prints one line: `PASS <step>`, `FAIL <step>: <reason>` or `SKIP <step>: <why>`. A step that needs root is
   skipped unless the script runs as root with `HP_ACCEPT_ROOT_CASES=1`. `INFO` lines are measurements and notes,
   never a failure. When an image the script does not pull is missing (the engine script's test image, `traefik:v3.7`
   for the HTTP-cache script), it prints `SKIP … nothing was created` and exits 1. Without a build the HTTP-cache
   script and the databases script print `FAIL preflight: run corepack pnpm run build first`. The databases script
   downloads nothing: when the image of a built-in database is not on the server, its `preflight` step fails and
   names the missing images; fetch each first (`docker pull <repository>@sha256:<digest>`, the references are in
   `ADR-0039`) and run it again.
4. The last line is `RESULT <n>/<m> passed`, followed by `, <k> skipped (not counted in n/m)` when steps were skipped,
   and the time. The exit code is 0 only when every counted step passed.
5. A `FAIL` of `gate-clean` means the script sent a Docker request the gate refused; that request never reached
   Docker. A `FAIL` of `nothing-left` lists what the run left; find it and remove it by exact name only:
   ```bash
   sudo docker ps -a --filter name=swarmtest_
   sudo docker network ls --filter name=swarmtest_
   sudo docker volume ls --filter name=swarmtest_
   ```

## 10. Databases and private links

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
   linked to it, and about once a minute for whatever still waits (at most 20 databases per pass). There is no button
   to retry, and none is needed.
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
