# HCP-SPEC-005 Acceptance Report: Application Stacks and Template Catalog

This report gives the result of every acceptance id of HCP-SPEC-005 (spec §19): `A1` to `A20` and
`B1` to `B6`. It states only what a test file or a recorded run proves. The results are copied from
the run log of swarm `swarm-1122-002730` (`EVIDENCE.md` and the engineers' reports it names, kept
outside git). The design and its limits are in `docs/architecture/adr/0035-application-stacks.md`;
the review findings and their state are in the HCP-SPEC-005 section of `docs/security/audit-report.md`.
It does not say the feature is ready: the owner gates below are open.

## Gate status

- **Gate W6 not met.** `applicationTemplatesAvailable`, `applicationStacksAvailable`,
  `stackPublicPortsAvailable` and `gitBuildsAvailable` are `false` on every backend. Turning the
  first two on for `linux-systemd`, the live acceptance on the owner's VMs, the reboot test (`B6`) and
  the merge are the owner's (BLOCKED.md #2).
- **Gate W0 open.** Decisions D1–D12 and `ADR-0035` stay `PROPOSTO` (BLOCKED.md #1); the image
  allowlist and the three seed digests wait for the owner (BLOCKED.md #4); one branch and one draft PR
  (#37) instead of a series of small PRs (BLOCKED.md #3).
- **Security review: 0 critical, 0 high and 0 medium open; two mediums repaired after the last round
  and not re-reviewed.** The independent review found no critical and no high defect; the one high of
  the code reviews (organisation ids, S5-H1) is repaired. The third and last review round closed both
  round-2 regressions and found two new mediums: **S5-M9**, an in-doubt route refresh was recovered as
  a deploy and could leave the stack `failed`, after which no refresh ran and a removed hostname could
  stay routed; **S5-M10**, a secret across a 16 KiB Docker log frame split whose continuation the 2 MiB
  read limit cut came back as an unmasked middle piece. Both are repaired (`fix16-refresh-recovery`,
  `fix16-log-frames`) and covered by their engineers' failing-first tests, named in rows `A8` and
  `B3`. The review loop ends at round 3: no fourth round re-read these two repairs.
- **Full verify of the code: passed on `ac35ac4`.** The last full verify recorded here (repository
  pre-push hook in a clean checkout: build, lint and typecheck 0) is on `ac35ac4`: 461 test files
  passed, 12 933 tests passed, 46 skipped; it contains every test file this report marks "(added after
  `96ec4c8`)". The commits after it are the two `fix16` repairs (`2430024`, `8183a7d`), which
  passed the lead's run of the executor and stack tests (128 files, 3 083 tests) and the three
  real-Docker scripts, and the documents; the verify of the tip of the branch runs when it is pushed
  and its result is in the pull request description (#37). `release:build` (archive
  `hosting-panel-0.8.0-linux-x64.tar.gz`) exited 0 and `release:smoke` printed `smoke: PASS` on
  `39ea336`, in a clean checkout.

## Verdicts

| Verdict | Meaning |
|---|---|
| `PASS` | The criterion is met by the test files or the real run in the row. Where the spec asks for a real process, the row names it. |
| `FAIL` | A run failed. None at the time of writing. |
| `SKIPPED` | The step exists and did not run, with its reason. |
| `PENDING (owner: …)` | Only the owner can run it. The action is written in the row. |
| `BLOCKED (BLOCKED.md #n)` | An approval is needed first. |

A `PASS` row can still list an "Owner part": a further proof that only the owner can give. It does
not change the verdict of what is proven. There is no partial verdict: what is not proven is written
in the Notes cell of the row.

## Environment and commit

| Item | Value |
|---|---|
| Branch | `feat/apps-application-stacks-and-template-catalog` (issue #36, draft PR #37), started at `b70882f` = `main` `88fc80e` + an empty start commit |
| Commit of the test runs | `96ec4c8` and `ac35ac4`: the full verifies (clean detached checkout, repository pre-push hook); a row below cites the first of them that contained its files |
| Commit of the real-Docker runs | `ac35ac4` (the lead's run, 07:38–07:41, the code-complete tree before the `fix16` repairs); earlier runs on the trees committed as `8b8efd9` (engine script, 05:00), `31e6138` (the two seed scripts, 06:00 and 06:10) and `f9306a1` (all three, 07:05) |
| Host | cloud-dev VM, Linux 6.8.0-151-generic, 4 CPU, 7.8 GB RAM, with a live hosting-panel install running beside the tests (its four containers were checked untouched after every Docker run) |
| Docker Engine | 29.10.0 (API 1.57) |
| Node | v26.13.1 |
| Traefik | a throw-away proxy from the local image `traefik:v3.7` (the script never pulls it), on `127.0.0.1:16780` and `127.0.0.1:16743`; the live `hp_ingress_proxy` was never used |
| Database | PGlite in the tests; no test ran on the server's PostgreSQL 18 |
| Seed image `nginxinc/nginx-unprivileged` | `nginxinc/nginx-unprivileged:1.31.7-alpine3.24-slim@sha256:a8cb0f33d51fa107c96fd2bd3a71aaf564ec131e9d2bdf8700944f0ed8b170d7` |
| Seed image `memcached` | `memcached:1.6.45-alpine3.24@sha256:084fb554292d1447bc2c68b80c2331b98834514f56c866bc21a61be3c2ee376d` |
| Seed image `valkey/valkey` | `valkey/valkey:9.2.0-alpine3.24@sha256:c8e2d17498838af5d91e12eb7c11220b3434a7b7131a333e3af52ad5e0b80882` |
| Package version | `0.8.0` (not bumped) |

## Runs behind the matrix

### Sensors (the verify command)

| When | Tree | build | lint | typecheck | tests |
|---|---|---|---|---|---|
| 00:59–01:15 | `b70882f` (baseline) | 0 | — | — | 362 files, 9 244 passed, 46 skipped |
| 03:40–03:59 | working tree before `1219728..5adc18b` | 0 | 0 | 0 | 420 files: 419 passed, 1 failed (`support-access-tenancy`: path-parameter values missing for the new routes; the test map was extended and the file then passed 6/6) |
| 04:01–04:43 | `5adc18b`, clean checkout, pre-push hook | 0 | 0 | 0 | 420 files passed, 11 491 passed, 46 skipped |
| 05:47–06:28 | `96ec4c8`, clean checkout, pre-push hook | 0 | 0 | 0 | 456 files passed, 12 767 passed, 46 skipped |
| 07:38–08:16 | `ac35ac4`, clean checkout, pre-push hook | 0 | 0 | 0 | 461 files passed, 12 933 passed, 46 skipped |
| 08:02 | working tree with the `fix16` repairs (committed as `2430024`, `8183a7d`): executor tests, every application-stack API test, the two route sweeps, the site pins | — | 0 | 0 (executor, api) | 128 files, 3 083 passed, 45 skipped |
| after this report | tip of the branch, clean checkout, pre-push hook | | | | the result is in the pull request description (#37) |

### Real Docker Engine acceptance scripts

Each script drives the production `DockerEngineSocketAdapter` in its own process, behind a
default-deny gate socket that it creates in front of Docker and that logs every request. The run
marker is `swarmtest_<12 hex>`; the stack ids are `stk_swarmtest_<12 hex>`.

| Run | Command | Result |
|---|---|---|
| Engine (M3), first run | `node infra/linux/accept-app-stack-engine.mjs` | `RESULT 25/25 passed, 1 skipped (not counted in n/m) in 70.3s` |
| HTTP site with cache, first run | `node infra/linux/accept-app-stack-http-cache.mjs` | `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 42.8s`; the gate saw 232 requests and denied 0 |
| Worker with storage, first run | `node infra/linux/accept-app-stack-worker-storage.mjs` | `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 47.0s`; the gate saw 311 requests and denied 0 |
| All three, after the round-1 repairs (07:05) | the same three commands, one after the other | engine `RESULT 25/25 passed, 1 skipped`; http-cache `RESULT 20/20 passed, 1 skipped`; worker-storage `RESULT 20/20 passed, 1 skipped`; no object with the run marker left; the four live containers running |
| All three, the lead, 07:38–07:41 on `ac35ac4` | the same three commands, one after the other | engine `RESULT 25/25 passed, 1 skipped (not counted in n/m) in 71.5s`; http-cache `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 39.1s`; worker-storage `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 48.0s`; exit 0 each; the same four live containers before and after; 0 containers, networks or volumes with the run marker or the `hp_app_` prefix left |
| All three, the lead, 08:03–08:05 on the tree with the `fix16` repairs (`2430024`, `8183a7d`) | the same three commands, one after the other | engine `RESULT 25/25 passed, 1 skipped (not counted in n/m) in 70.5s`; http-cache `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 40.4s`; worker-storage `RESULT 20/20 passed, 1 skipped (not counted in n/m) in 48.2s`; exit 0 each; the same four live containers running; 0 leftover containers, networks and volumes |

The skipped step is the same in every run: `host-nft-metadata-drop-on-stack-net` needs root to read
the host nft ruleset (`HP_ACCEPT_ROOT_CASES=1` as root). The first run of the HTTP script pulled both
seed images by digest through the gate; later runs found them local.

`docker stats --no-stream`, one line per seed component (first runs):

| Component | Memory used / limit | CPU |
|---|---|---|
| `http-cache` `cache` (memcached) | 1.875 MiB / 128 MiB | 0.01% |
| `http-cache` `web` (nginx) | 4.641 MiB / 64 MiB | 0.00% |
| `worker-storage` `storage` (valkey) | 3.598 MiB / 128 MiB | 0.14% |
| `worker-storage` `worker` (valkey-cli) | 1.41 MiB / 32 MiB | 0.00% |

These are single readings of one run, not a load test.

## Acceptance matrix

Step names are the names the scripts print. "Engine", "HTTP" and "Worker" are the three scripts
above. A file marked "(added after `96ec4c8`)" was not in the last full verify; its green run is in
its engineer's report.

| ID | Criterion | Verdict | Evidence | Run type | Commit | Notes |
|---|---|---|---|---|---|---|
| A1 | The administrator creates a valid two-service template: the version is saved immutable and the preview matches the plan | PASS | `corepack pnpm exec vitest run packages/policy-engine/test/app-template-compile.test.ts`; also `packages/database/test/app-templates-repository.test.ts`, `packages/database/test/app-stacks-database.test.ts`, `apps/api/test/app-templates.integration.test.ts`, `apps/api/test/app-templates.qa.test.ts`, `packages/policy-engine/test/app-template-built-in.test.ts` | vitest, Node 26.13.1, PGlite | `96ec4c8` | The preview is computed from the compiled plan and equals it; versions are numbered and an UPDATE or DELETE on a version is refused by the trigger; both built-in templates validate and compile. Not proven: the admin editor in a real browser |
| A2 | A customer tries to publish a template: 403, no database or Docker write | PASS | `corepack pnpm exec vitest run apps/api/test/app-templates.qa.test.ts`; also `apps/api/test/admin-route-guard.integration.test.ts` | vitest | `96ec4c8` | Every admin template route answers 401 or 403 to an owner, a collaborator and a stranger, and the row counts stay the same; the routes sit behind `requireServerAdmin` |
| A3 | The customer sets a parameter declared `customer: false`: 400, no data change | PASS | `corepack pnpm exec vitest run packages/contracts/test/app-template-parameters.test.ts`; also `apps/api/test/app-stacks.integration.test.ts`, `apps/api/test/app-stack-compile.test.ts` | vitest | `96ec4c8` | Refused even when the value equals the default (`PARAM_VALUE_NOT_CUSTOMER`); the API answers 400 `STACK_PARAMETER_INVALID` and writes no row. The security review (R3) found the same refusal at create, draft, deploy, plan and upgrade |
| A4 | A source with `privileged`, `docker.sock`, `network_mode: host`, `build`, `ports`: each refused with a path and a stable reason | PASS | `corepack pnpm exec vitest run packages/policy-engine/test/app-template-security.test.ts`; also `packages/policy-engine/test/app-template-keys.test.ts`, `packages/policy-engine/test/app-template-encoding-edges.test.ts` | vitest | `96ec4c8` | The table walks every key level; case variants such as `Privileged` are refused as unknown keys |
| A5 | Aliases, merge keys, multiple documents, size, depth, `__proto__`, duplicate keys: refused, bounded in memory and time | PASS | `corepack pnpm exec vitest run packages/policy-engine/test/app-template-security.test.ts` | vitest | `96ec4c8` | Alias, merge key, multiple documents, tag, 65 537 bytes, depth 17, 4 097 nodes, duplicate key and `__proto__` are refused, each under 200 ms on this machine. The parser is the ADR-0033 one, unchanged |
| A6 | A dependency cycle or a missing dependency: refused before anything is created | PASS | `corepack pnpm exec vitest run packages/policy-engine/test/app-template-graph.test.ts`; also `packages/policy-engine/test/app-template-security.test.ts` | vitest | `96ec4c8` | Refused by the validator, before a template version or a stack is written |
| A7 | A parameter with shell metacharacters, `${...}`, a newline or a credential URL: refused or kept literal, with no shell | PASS | `corepack pnpm exec vitest run packages/policy-engine/test/app-template-security.test.ts`; also `packages/policy-engine/test/app-template-compile.test.ts`, `packages/contracts/test/app-template-text.test.ts`, `packages/policy-engine/test/app-template-encoding-edges.test.ts` | vitest | `96ec4c8` | Interpolation is one pass; a placeholder is always a whole argv item, and a filled item can be neither empty nor start with `-`. A shell or launcher name is refused at any argv position. Limit: other interpreters (`python -c`, `perl -e`, `awk`) are not refused (ADR-0035 limit 15) |
| A8 | A secret parameter: no plaintext in DTOs, source, plan, database, outbox, logs or `docker inspect` | PASS | `corepack pnpm exec vitest run packages/database/test/app-stack-secrets-repository.test.ts`; also `packages/policy-engine/test/app-template-compile.test.ts`, `packages/contracts/test/app-stack-plan.test.ts`, `apps/api/test/app-stacks-secrets.qa.test.ts`, `apps/api/test/app-stack-secrets-runtime.qa.test.ts`, `apps/docker-executor/test/app-stack-secrets.test.ts`; `node infra/linux/accept-app-stack-engine.mjs` steps `secrets-only-as-files`, `logs-masked`; `node infra/linux/accept-app-stack-worker-storage.mjs` step `secrets-only-as-files` | vitest; real Docker 29.10.0 | `96ec4c8` (tests), `ac35ac4` (scripts) | On real Docker the environment holds only the file path, no 8-character piece of the secret is in the inspect output, and the secret is one read-only bind from a tmpfs. The log masking was repaired after `96ec4c8` (audit S5-M1, then S5-M6). **Repaired, not re-reviewed (audit S5-M10):** a secret across a 16 KiB Docker log frame split whose continuation the 2 MiB read limit cut came back as an unmasked middle piece (33 of 900 random runs in the review); the executor now joins the frames of one line as bytes before decoding and masking, and drops the line the read limit cut. Tests: `apps/docker-executor/test/app-stack-engine.test.ts` (the reviewer's reproduction, a three-byte split, 300 seeded layouts; 84/84) and `apps/docker-executor/test/app-stack-secrets.test.ts` (16/16), the engineer's runs on the working tree after `ac35ac4`; no fourth review round re-read the repair. Limits: values shorter than 6 characters are not masked in logs; the secret files are lost at a host reboot (ADR-0035 limit 13) |
| A9 | Two linked services: an isolated network and working internal DNS | PASS | `node infra/linux/accept-app-stack-http-cache.mjs` step `health-and-dns`; `node infra/linux/accept-app-stack-worker-storage.mjs` step `worker-writes-storage`; `node infra/linux/accept-app-stack-engine.mjs` step `dns-between-components`; `corepack pnpm exec vitest run apps/docker-executor/test/app-stack-engine.test.ts` | real Docker 29.10.0; vitest | `ac35ac4` (scripts), `96ec4c8` (tests) | The worker raised the storage counter (1 to 2) over the private network by the component name |
| A10 | Stack A tries to reach the network, volume or secret of stack B: refused or impossible | PASS | `node infra/linux/accept-app-stack-http-cache.mjs` step `no-cross-stack`; `node infra/linux/accept-app-stack-engine.mjs` step `no-cross-stack-reachability`; `corepack pnpm exec vitest run packages/database/test/app-stacks-database.test.ts`; also `packages/database/test/app-stack-secrets-repository.test.ts` | real Docker 29.10.0; vitest | `ac35ac4` (scripts), `96ec4c8` (tests) | A component of one stack cannot reach the other stack; the composite keys `(stack_id, organization_id)` refuse a row that points at another organisation's stack; a secret row copied under another stack or version does not decrypt |
| A11 | A stack tries the cloud metadata, the control-plane database and the Docker socket: no access | PASS | `node infra/linux/accept-app-stack-http-cache.mjs` steps `network-shape`, `no-control-plane-reach`; `node infra/linux/accept-app-stack-engine.mjs` steps `network-shape-covered-by-metadata-drop`, `internal-component-has-no-default-route`, `no-docker-socket-in-components`; `corepack pnpm exec vitest run packages/contracts/test/app-template-text.test.ts` | real Docker 29.10.0; vitest | `ac35ac4` (scripts), `96ec4c8` (tests) | Proven: the stack networks are plain bridges with no options, so the frozen `br-*` metadata drop of `infra/linux/nftables-dedicated.conf` covers them; from the stack, ports 5432, 3306, 4000 and 3000 were refused (an `nc -z` control first reached the stack's own cache); no component has the Docker socket; the private component has no default route. Port 3000 (`hp-web`) was refused here although the frozen ruleset allows it from every bridge (ADR-0035 limit 4). SKIPPED: `host-nft-metadata-drop-on-stack-net` (needs root). **Owner part:** run that step as root with `HP_ACCEPT_ROOT_CASES=1`, and check the metadata drop on a cloud VM that has a metadata service. Limit: other spellings of the metadata address pass the text rule (ADR-0035 limit 16) |
| A12 | CPU, memory or pids over the limits: refused by the API and the executor before Docker | PASS | `corepack pnpm exec vitest run packages/policy-engine/test/app-template-security.test.ts`; also `apps/docker-executor/test/app-stack-plan-check.test.ts`, `apps/docker-executor/test/app-stack-refusals.qa.test.ts`, `apps/api/test/app-templates.integration.test.ts`, `apps/docker-executor/test/app-stack-engine.test.ts`; `node infra/linux/accept-app-stack-engine.mjs` step `refuse-over-ceiling-before-docker`; HTTP and Worker step `refused-before-docker` | vitest; real Docker 29.10.0 | `96ec4c8` (tests), `ac35ac4` (scripts) | The pids limit is a constant (256), not a template value. Since `f9306a1` the executor also reads `GET /info` and refuses a plan that asks for more processors than the host has, before it removes anything |
| A13 | An image that is not allowlisted, `latest` or a bad digest: refused, no pull | PASS | `corepack pnpm exec vitest run packages/contracts/test/app-template-images.test.ts`; also `packages/policy-engine/test/app-template-security.test.ts`, `packages/policy-engine/test/app-template-encoding-edges.test.ts`, `apps/docker-executor/test/app-stack-refusals.qa.test.ts`; `node infra/linux/accept-app-stack-engine.mjs` step `refuse-unpinned-image-before-docker`; HTTP and Worker step `refused-before-docker` | vitest; real Docker 29.10.0 | `96ec4c8` (tests), `ac35ac4` (scripts) | The repository must equal one of the three `APP_IMAGE_ALLOWLIST` rows; look-alikes (`docker.io/library/...`, upper case, two `@`, `sha512`) are refused; the plan carries only `name@sha256:...` |
| A14 | A deploy with a health check: `running`, and the HTTPS route serves only a healthy target | PASS | `corepack pnpm exec vitest run apps/api/test/app-stack-deploy.qa.test.ts`; also `apps/api/test/app-stack-seed-e2e.test.ts`; `node infra/linux/accept-app-stack-http-cache.mjs` step `route-published-after-health` | vitest; real Docker 29.10.0 with the throw-away Traefik | `96ec4c8` (tests), `ac35ac4` (scripts) | The stack is `running` only after health and publish; HTTP through the throw-away proxy reaches the healthy target. **Owner part:** HTTPS with a real ACME certificate on a public hostname (no public DNS on this machine) |
| A15 | A dependency stays unhealthy: a truthful `degraded` or `failed`, and no early route | PASS | `corepack pnpm exec vitest run apps/api/test/app-stack-deploy.qa.test.ts`; also `apps/api/test/app-stack-runtime.unit.test.ts`, `apps/docker-executor/test/simulator-app-stacks.test.ts`; `node infra/linux/accept-app-stack-http-cache.mjs` step `health-reports-unhealthy` | vitest; real Docker 29.10.0 | `96ec4c8` (tests), `ac35ac4` (scripts) | An accessory that stays unhealthy gives `degraded` and the healthy target is published; on real Docker a stopped cache reads unhealthy |
| A16 | The same idempotency key sent again: one operation, no duplicate resources | PASS | `corepack pnpm exec vitest run packages/database/test/app-stacks-repository.test.ts`; also `apps/api/test/app-stack-concurrency.qa.test.ts`, `apps/api/test/app-stacks-tenancy.qa.test.ts`, `apps/docker-executor/test/app-stack-engine.test.ts`; Engine, HTTP and Worker step `idempotent-reapply` | vitest; real Docker 29.10.0 | `96ec4c8` (tests), `ac35ac4` (scripts) | Same key and body give the same stack and operation; another body gives `IDEMPOTENCY_CONFLICT`; a re-apply on real Docker creates nothing. After `96ec4c8`, create and deploy look the key up before their checks (audit S5-L6), so a retry is replayed even when the default version changed meanwhile; rollback still runs its checks first (open low) |
| A17 | A crash between `create` and `start`: `unknown`, a read-only recovery, no blind replay | PASS | `corepack pnpm exec vitest run apps/api/test/app-stack-recovery.qa.test.ts`; also `apps/api/test/app-stack-recovery.unit.test.ts`; HTTP and Worker step `recovery-reads-only`; `node infra/linux/accept-app-stack-engine.mjs` step `status-reads-only` | vitest; real Docker 29.10.0 | `96ec4c8` (tests), `ac35ac4` (scripts) | The operation is parked `unknown` with its lock held; recovery makes one status read and settles; the gate saw only reads during recovery. Not proven: a real API process killed in the middle of a real deploy (the crash is simulated in the tests) |
| A18 | A delete without the data flag: containers and networks removed, volumes kept | PASS | `corepack pnpm exec vitest run packages/database/test/app-stacks-lifecycle.test.ts`; also `apps/api/test/app-stack-delete.qa.test.ts`, `apps/docker-executor/test/app-stack-lifecycle.qa.test.ts`; `node infra/linux/accept-app-stack-worker-storage.mjs` steps `remove-keeps-volumes`, `destroy-data-removes-volume`; `node infra/linux/accept-app-stack-engine.mjs` steps `remove-keeps-volumes`, `reapply-reuses-volume-data` | vitest; real Docker 29.10.0 | `96ec4c8` (tests), `ac35ac4` (scripts) | Volume rows become `retained`; the data volume is removed only with the separate flag. Limit: a destroying delete that fails partway and is retried with "keep data" can leave `retained` rows of volumes that no longer exist (open low) |
| A19 | An upgrade and a rollback: a new revision, the volume data kept, the database rollback warning shown | PASS | `corepack pnpm exec vitest run apps/api/test/app-stack-upgrade.integration.test.ts`; also `apps/api/test/app-stack-upgrade.qa.test.ts` (added after `96ec4c8`); `node infra/linux/accept-app-stack-worker-storage.mjs` step `data-survives-upgrade-and-rollback`; `node infra/linux/accept-app-stack-http-cache.mjs` step `upgrade-changes-only-changed-component` | vitest; real Docker 29.10.0 | `96ec4c8` (tests), `ac35ac4` (scripts) | On real Docker the counter went from 3 to 5 across upgrade, rollback and a storage restart; only the changed component was recreated. A rollback never reverts data. Not proven: a rollback over a real database schema change (no seed template has one) |
| A20 | Existing WordPress sites, site templates, backups, TLS and release update: no unintended change | PASS | `corepack pnpm exec vitest run apps/api/test/site-type-pins.test.ts`; also `apps/api/test/site-template-render-pin.test.ts`, `apps/docker-executor/test/site-type-pins-backups.test.ts`, `apps/docker-executor/test/site-type-pins-files.test.ts`, `apps/docker-executor/test/traefik-routes.test.ts`, `apps/docker-executor/test/app-stack-route-sentinel.test.ts`, `apps/api/test/app-stack-site-witness.qa.test.ts`, `apps/api/test/app-stack-boot-sentinel.test.ts`, `infra/linux/features-gate.test.ts`, `infra/linux/update.test.ts`, `packages/database/test/rollback-compat.test.ts`, `packages/database/test/app-stacks-downgrade-gate.test.ts` | vitest | `96ec4c8` | The frozen pins pass unchanged; the route files of sites and of the panel are never rewritten; the API boot makes no Docker call; a downgrade is refused with exit 8 while a stack exists. Not run in this cycle: `release:build` and `release:smoke`. **Owner part:** `hp-update` between two real releases on a real server |
| B1 | Two customers with separate Dedicated allocations: no cross access, 404 on foreign ids | PASS | `corepack pnpm exec vitest run apps/api/test/app-stacks-tenancy.qa.test.ts`; also `packages/database/test/app-stacks-repository.test.ts`, `apps/web/test/m6-web-qa-tenancy.test.ts` | vitest | `96ec4c8` | Foreign stack, template, version, revision, deployment, domain and component ids answer the same 404 on every customer route, with no audit row. Not proven: two real Dedicated hosts |
| B2 | Two simultaneous deploys of one organisation exhaust the quota: one admitted, one refused | PASS | `corepack pnpm exec vitest run packages/database/test/app-stacks-repository.test.ts`; also `apps/api/test/app-stacks-tenancy.qa.test.ts` | vitest, PGlite | `96ec4c8` | Two creates at a limit of 1 give one stack; three at a limit of 2 give two stacks and one `QUOTA_EXCEEDED`. Limit: PGlite runs one transaction at a time, so the row lock is proven by outcome, not under real contention |
| B3 | A domain change with ACME TLS: no Docker provider, no new proxy, a dynamic reload | PASS | `corepack pnpm exec vitest run apps/api/test/app-stack-domains.integration.test.ts`; also `apps/api/test/app-stack-domains.qa.test.ts` (added after `96ec4c8`), `apps/api/test/app-stack-tls-coverage.integration.test.ts`, `apps/docker-executor/test/app-stack-route-sentinel.test.ts`; `node infra/linux/accept-app-stack-http-cache.mjs` step `route-change-no-proxy-recreate` | vitest; real Docker 29.10.0 | `96ec4c8` (tests), `ac35ac4` (scripts) | The route file changes and the proxy keeps its container; the Docker provider is never on. Manual TLS on stack hostnames is not offered (ACME only). Since `ac35ac4` the route refresh is routes-only (audit S5-M7): one status read, then publish or withdraw; nothing is pulled, created, started or restarted. **Repaired, not re-reviewed (audit S5-M9):** an in-doubt route refresh was recovered as a deploy and could leave the stack `failed`; recovery now settles it as a refresh from one status read, `running` or `degraded`, never `failed`. Tests: `apps/api/test/app-stack-recovery.unit.test.ts` (11/11), `apps/api/test/app-stack-runtime.unit.test.ts` (33/33), `apps/api/test/app-stack-runtime-policy.test.ts` (63/63), the engineer's runs on the working tree after `ac35ac4`; no fourth review round re-read the repair. Open low (audit S5-L20): while the stack has other hostnames, a failed certificate read fails the refresh and a removed hostname stays routed until the read works. **Owner part:** ACME issuance on a real hostname |
| B4 | Stack backup disabled: UI and API say `NOT_SUPPORTED` | PASS | `corepack pnpm exec vitest run apps/api/test/app-stacks.integration.test.ts`; also `apps/api/test/app-stacks-lifecycle.qa.test.ts`, `apps/web/test/app-stacks-detail.test.ts` | vitest | `96ec4c8` | The backup route answers 422 `NOT_SUPPORTED` (reason `STACK_UNSUPPORTED_FEATURE`) and 404 for another organisation; no capability flag offers stack backups; the detail page shows a fixed line and no command. Site and panel backups do not include stacks |
| B5 | A failed or timed-out pull, health check or network attach: a non-destructive cleanup and a consistent state | PASS | `node infra/linux/accept-app-stack-worker-storage.mjs` steps `pull-failure-consistent`, `network-failure-consistent`, `health-timeout-consistent`; `corepack pnpm exec vitest run apps/docker-executor/test/app-stack-lifecycle.qa.test.ts`; also `apps/docker-executor/test/app-stack-engine.test.ts` | real Docker 29.10.0; vitest | `ac35ac4` (script), `96ec4c8` (tests) | The faults are injected by the gate (a canned pull answer and one network failure, `DOCKER_ENGINE_UNAVAILABLE`), not by a real registry or network outage |
| B6 | A server reboot and a control-plane outage: stacks stable, recovery after the restart, WordPress sites unchanged | PENDING (owner: reboot a real install with two stacks and one WordPress site, then check that the stacks come back, that the components with secrets work after «Riavvia», and that the site is unchanged) | none: the shared machine is not rebooted | — | — | Known before the run: the secret files live in a host tmpfs and are lost at reboot, so the components that use secrets stay broken until the customer or an administrator restarts the stack (ADR-0035 limit 13) |

## What stays with the owner

- **A host reboot** with two stacks and one WordPress site (`B6`).
- **Root and a cloud VM:** the root-only step `host-nft-metadata-drop-on-stack-net` with
  `HP_ACCEPT_ROOT_CASES=1`, and the metadata drop on a VM that has a metadata service (`A11`).
- **ACME on a real hostname** for a stack domain (`A14`, `B3`).
- **A real update** between two releases with `hp-update` (`A20`).
- **Turning the feature on:** `applicationTemplatesAvailable` and `applicationStacksAvailable` on
  `linux-systemd`, then a live acceptance with a real customer organisation (BLOCKED.md #2).
- **Approvals:** D1–D12 and `ADR-0035` (BLOCKED.md #1), the PR shape (BLOCKED.md #3), the image
  allowlist and the three digests above (BLOCKED.md #4).

## Known limits behind a PASS

These are written in `docs/architecture/adr/0035-application-stacks.md` §4 or in the audit report,
and they do not change a verdict.

- Stack hostnames are ACME only; no manual certificate on a stack hostname.
- No stack backup, no public TCP or UDP port, no Git build.
- The downgrade gate ignores the retained volumes of deleted stacks; a never-deployed draft holds it.
- After a host reboot, components with secrets need a restart from the panel; nothing repairs them
  automatically.
- The shell rule is by name: an ordinary argument whose last path segment is a listed name (`env`,
  `/usr/share/fish`, `--shell=/bin/sh`) is refused too, and other interpreters are not.
- Other spellings of the metadata address pass the text rule; the host firewall's drop is the control.
- A draft on a template version that is no longer the current one cannot be deployed or upgraded:
  it is deleted and installed again.
- The restore guard's stack count needs PostgreSQL built with libxml; it ran on PGlite only.
