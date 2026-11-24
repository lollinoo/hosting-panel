# Runbook — Application stacks

Operator procedures for application stacks (`ADR-0035`). Design record:
`docs/architecture/adr/0035-application-stacks.md`. Acceptance evidence and what is still pending:
`docs/security/hcp-spec-005-acceptance-report.md`. The routing options of a stack's addresses (`ADR-0037`,
`docs/architecture/adr/0037-application-routing-options.md`) are procedure 10.

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
  (**Modelli**, kind «Applicazione multi-servizio») and the list of every stack in **Applicazioni**. A row opens the
  stack's page, where the administrator reads a component's logs and opens a terminal in it (procedures 11 and 12,
  `ADR-0041`). The administrator cannot start, stop, change or delete a customer's stack from that page; collaborators
  and support access have no stack permission.
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
5. The automatic rollback of a failed update stays ungated: migrations `0025`, `0026` and `0030` are additive.
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
3. **Logs.** The application page shows the last 1 to 500 lines per component with secret values masked. A server
   administrator reads the same masked lines without the customer (procedure 11). For more:
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
   templates of the first format), `infra/linux/accept-app-stack-wordpress.mjs` (the built-in WordPress and MariaDB
   template of the extended format: it installs a real WordPress with two throw-away passwords, about 40 seconds when
   the images are local) and `infra/linux/accept-app-terminal.mjs` (the terminal in a component, `ADR-0041`; its own
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

## 11. Administrator: the page and the logs of a customer's application

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

## 12. Administrator: a terminal in a component

A text shell (`/bin/sh`) inside the container of one component, for a server administrator (`ADR-0041`). It is the
terminal of the sites (`ADR-0027`) with a different place and a different user.

1. **Open it.** On the application's page (procedure 11), **Terminale** on the component's row. The account needs
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
   (`journalctl -u hp-docker-executor`); it tries again at its next start.
9. **Known limits.** A process that deliberately leaves the session and removes the session's mark from its own
   environment survives the end of the session; a background program can also survive when the executor dies within
   one second after a shell ended by itself. Either stays inside the component's limits, and nobody is connected to
   it: the customer's **Riavvia** on the application ends it. After a downgrade to the previous release, a shell left
   in a component is not cleaned by the old executor (it cleans sites only): **Riavvia** ends it as well.
10. **A value that holds a platform mark.** No value of an application (a setting, a private value, a template's
    text or argument) may contain `HP_TERMINAL_SESSION=` or `HP_TASK_RUN=`: the clean-up finds what a session or a
    task run started by that text, so a component that carried it could have its own programs killed (`ADR-0041` §4).
    Other `HP_` or `PHP_` text is accepted. A new value is refused with its reason. A revision or a private value saved
    before this rule that holds such text is refused after the update: the application's page answers an error and a
    start is refused. Applications were first switched on in release 0.10.0, so none is expected. If one exists,
    correct the value (the customer replaces a private value from the application's page), or stop the application
    or delete it (procedure 3).
