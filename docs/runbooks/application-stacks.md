# Runbook — Application stacks

Operator procedures for application stacks (`ADR-0035`). Design record:
`docs/architecture/adr/0035-application-stacks.md`. Acceptance evidence and what is still pending:
`docs/security/hcp-spec-005-acceptance-report.md`.

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
5. The automatic rollback of a failed update stays ungated: migration `0025` is additive.
6. **Extended format (`app-format-v2`, `ADR-0036`).** A target release that lists `app-stacks` but not `app-format-v2`
   knows the stacks but cannot read a plan of the extended template format (`HCP-STACK/v2`): the same command exits
   with **code 8** while a stack that is not deleted is on a template version of that format, or keeps a revision
   written in it. Stacks of the first format do not block, and neither does a template of the extended format that no
   stack uses (the built-in WordPress template is such a row on every panel). See what blocks:
   ```bash
   cd / && sudo -u postgres psql -X -d hosting_panel -c "select s.id, s.organization_id, s.name, s.status from app_stacks s where s.deleted_at is null and (exists (select 1 from app_template_versions v where v.id = s.template_version_id and v.spec_version >= 2) or exists (select 1 from app_stack_revisions r where r.stack_id = s.id and r.plan->>'schemaVersion' <> '1'))"
   ```
   To go back without forcing, delete those stacks only (step 2); `--allow-feature-loss` works as in step 3, and the
   older release then fails to read those stacks until the panel is upgraded again.

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

1. **There is no runtime switch.** On a server (runtime backend `linux-systemd`) this release turns
   `applicationTemplatesAvailable` and `applicationStacksAvailable` on in code (`appFeaturesFor`,
   `packages/contracts/src/resources.ts`); no environment variable, option or setting turns them off. What an operator
   can do instead:
   - **Stop new installations.** In **Modelli**, switch off **Offerto ai clienti** on each application template and
     archive the ones that are not built-in (procedure 6, step 2). The catalog then offers nothing to install;
     installed stacks keep running.
   - **Go back to an earlier release**, where both flags are `false` on every backend:
     `sudo hp-update --version <older> --allow-downgrade` (procedure 4). The releases before this one, from `0.9.0`,
     list `app-stacks` but not `app-format-v2` in `RELEASE.json`, so the gate exits with **code 8** while a stack that
     is not deleted uses the extended format (procedure 4, step 6); stacks of the first format do not block. An older
     release does not list `app-stacks` and refuses while any stack that is not deleted exists (procedure 4, step 1).
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

## 9. Read the acceptance scripts' output

1. The real-Docker checks are `infra/linux/accept-app-stack-engine.mjs` (the stack engine),
   `infra/linux/accept-app-stack-http-cache.mjs` and `infra/linux/accept-app-stack-worker-storage.mjs` (the two built-in
   templates of the first format) and `infra/linux/accept-app-stack-wordpress.mjs` (the built-in WordPress and MariaDB
   template of the extended format: it installs a real WordPress with two throw-away passwords, about 40 seconds when
   the images are local). They import the built packages: build first (`corepack pnpm run build`), then run one at a
   time, never next to a test run (memory):
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
   throw-away proxy `<prefix>_proxy`, its network `<prefix>_ingress`, a temp folder and `/dev/shm/<prefix>-secrets`),
   never prune, and clean up at the end, also on Ctrl-C.
   One exception (#52): the executor of the server's own panel attaches its proxy to every network whose role label
   is `app_edge`, whoever created it, each time it checks its proxy. The WordPress script hides its edge network from
   it (in Docker that label has another value, which the script's gate translates in both directions). The engine
   script and the HTTP cache script do not yet: when such a check falls inside their run, the server's proxy joins
   the run's edge network, the removal steps fail with "A stack network is still used by another container" and
   `nothing-left` reports a network. The server's proxy keeps serving and is not restarted. Repair: find the
   network the run left (its name contains `swarmtest_<hex>`), detach the server's proxy from it, remove it:
   ```bash
   sudo docker network ls --filter name=swarmtest_
   sudo docker network disconnect <network> hp_ingress_proxy
   sudo docker network rm <network>
   ```
3. Each step prints one line: `PASS <step>`, `FAIL <step>: <reason>` or `SKIP <step>: <why>`. A step that needs root is
   skipped unless the script runs as root with `HP_ACCEPT_ROOT_CASES=1`. `INFO` lines are measurements and notes,
   never a failure. When an image the script does not pull is missing (the engine script's test image, `traefik:v3.7`
   for the template scripts), it prints `SKIP … nothing was created` and exits 1. Without a build a template
   script prints `FAIL preflight: run corepack pnpm run build first`.
4. The last line is `RESULT <n>/<m> passed`, followed by `, <k> skipped (not counted in n/m)` when steps were skipped,
   and the time. The exit code is 0 only when every counted step passed.
5. A `FAIL` of `gate-clean` means the script sent a Docker request the gate refused; that request never reached
   Docker. A `FAIL` of `nothing-left` lists what the run left; find it and remove it by exact name only:
   ```bash
   sudo docker ps -a --filter name=swarmtest_
   sudo docker network ls --filter name=swarmtest_
   sudo docker volume ls --filter name=swarmtest_
   ```
