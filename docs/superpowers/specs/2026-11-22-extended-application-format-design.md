# Extended application format, Compose importer and WordPress from the catalog

- **Date:** 2026-11-22
- **Tracking:** issue #42, draft PR #43, branch `feat/apps-extended-application-format-compose-importer`
- **Decision record:** `docs/architecture/adr/0036-extended-application-format.md` (amends `ADR-0035`)
- **Status:** design by the agent on the owner's directive of 2026-11-22; the points marked «agent's call» are not
  confirmed by the owner one by one and are listed again in the PR description.

## 1. Intent

The owner's words (2026-11-22): the panel at v0.9 is right for managed WordPress sites, but it is far from what a
self-hosted PaaS offers (templates, Compose, generated passwords, other applications). «Per ora partirei con WordPress
ma vorrei funzionasse come funziona Coolify.» The owner approved this order of work; this document covers its first
project: **an application format wide enough for real-world images, a Compose importer for the server administrator,
and WordPress + MariaDB installable from the catalog without the customer typing any password.**

Other panels reason by team; this panel reasons by **customer**. The server administrator owns everything that can
reach the host (templates, Compose, images, the proxy); the customer picks an application from the catalog and fills in
a short form.

## 2. Goals, non-goals, anti-goals

Goals

1. A second template format, `HCP-STACK/v2`, next to the unchanged v1.
2. Images from any registry, still pinned by digest; the server resolves a tag to its digest for the importer.
3. A closed **run profile** per service: `strict` (the v1 container body) or `standard` (enough for official images
   such as `wordpress` and `mariadb`).
4. Secrets as **environment values** (many images read nothing else), and **generated values** (passwords, users,
   keys) the customer never types.
5. A **Compose importer** for the server administrator: Compose in, v2 draft plus a report out.
6. A built-in WordPress + MariaDB template, written from scratch.
7. `applicationTemplatesAvailable` and `applicationStacksAvailable` true on `linux-systemd` (a separate commit).

Non-goals (each has or gets its own issue): routing options beyond today's (redirects, basic auth, paths), public
ports, standalone databases, application backups, terminal for applications, scheduled tasks, notifications, Git
deploys, platform URL variables inside a template, `exec` health checks, private registries, a wider YAML reader.

Anti-goals

- A template, plan or request that names a capability, a user, `privileged`, a host path, `docker.sock`, a device, the
  host network or a host port. The profile is a closed name; the executor owns what it means.
- A customer who can paste Compose, choose an image or see a generated password in a DTO, log or audit row.
- Any change to the behaviour of a v1 template, of a stored v1 plan or of the managed WordPress site product.
- Template files copied from another project (clean-room rule of `ADR-0035` §1).

## 3. Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| A. Run Compose files as they are (what the reference PaaS does) | Whoever edits the file controls the server; contradicts `ADR-0035` and `HARNESS.md` | Refused |
| B. Widen `HCP-STACK/v1` in place | Changes the meaning, spec hash and plan of stored v1 templates; the v1 guarantees become conditional | Refused |
| **C. A separate `HCP-STACK/v2` schema and plan version 2, plus an importer that converts Compose into it** | Two formats to keep; the importer cannot convert everything | **Chosen**: v1 stays byte-identical, every v2 template still passes the strict validator, and the administrator reviews what the importer changed |

## 4. `HCP-STACK/v2` (source format)

`x-hp-stack.schemaVersion: 2`. Every v1 rule holds unless this section changes it. A v1 source never gains a v2 key
(`KEY_UNKNOWN`), and v2 keys are listed in `APP_TEMPLATE_KEY_LEVELS_V2` for the security test.

### 4.1 Images

- `image: [registry/]repository[:tag]@sha256:<64 hex>`; the digest is mandatory (`IMAGE_DIGEST_REQUIRED`), the tag
  `latest` is refused (`IMAGE_TAG_LATEST`).
- The repository need not be in `APP_IMAGE_ALLOWLIST` (`IMAGE_NOT_ALLOWLISTED` is never raised for v2).
- `runAsUser` of the plan = the allowlist row's value when the repository has a row, else `null` (image default).

### 4.2 Run profile

Service key `x-hp-profile: strict | standard`; absent = `strict`. Any other value is `SERVICE_PROFILE_INVALID`.

| | `strict` (= v1) | `standard` |
|---|---|---|
| Root filesystem | read-only | writable |
| Capabilities | drop `ALL`, add none | drop `ALL`, add exactly `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, `NET_BIND_SERVICE` |
| `/tmp` | tmpfs 64 MiB `noexec,nosuid,nodev` | the image's own |
| `PidsLimit` | 256 | 512 |
| Everything else | — | identical: `Privileged: false`, `no-new-privileges:true`, memory = swap, CPU quota, per-stack networks, named volumes only, secret files read-only, `unless-stopped`, json-file 10m × 3, no `Entrypoint` |

The capability list is a constant of the executor (`APP_STACK_STANDARD_CAP_ADD`), measured on Docker Engine 29.10.0
with `wordpress:7.1.4-php8.4-apache` and `mariadb:12.3.3` (ADR-0036 §7): without `DAC_OVERRIDE` or `FOWNER` WordPress
does not start; `KILL` is not needed for a clean stop.

### 4.3 Secret parameters

```yaml
x-hp-parameters:
  - key: db_password
    label: "Password del database"
    type: secret
    required: true
    customer: false          # v2: allowed only together with generate
    generate:
      kind: password         # password | hex | base64 | user
      length: 32
```

- `generate` is optional. `kind: password` = `[A-Za-z0-9]`, 16..128 characters; `hex` = lowercase hex, 16..128
  characters; `base64` = standard base64 of `length` random bytes, 16..96 bytes; `user` = a lowercase letter then
  lowercase letters and digits, 8..32 characters. Malformed: `PARAM_GENERATE_INVALID`.
- With `generate`, `required` must be `true`. `customer: false` without `generate` stays `PARAM_SECRET_NOT_CUSTOMER`.
- `customer: true` + `generate`: generated at install, and the customer may replace it on the secret route.
  `customer: false`: only the platform sets it; the secret route refuses it.
- The API generates the value with `node:crypto` once, when the stack is created (and when an upgrade brings a
  generated parameter the stack has no row for), and stores it as an ordinary `app_stack_secrets` row (version 1,
  AES-256-GCM, same AAD). No DTO, audit row, outbox row or log carries it.

### 4.4 Secrets in the environment

```yaml
environment:
  - name: WORDPRESS_DB_PASSWORD     # no _FILE suffix: delivered as an environment value
    secret: db_password
  - name: MARIADB_PASSWORD_FILE     # _FILE suffix: delivered as a file, exactly as in v1
    secret: db_password
  - name: DATABASE_URL
    value: "mysql://app:${db_password}@db:3306/app"   # a secret parameter inside a value
```

- A `secret:` entry whose name does not end in `_FILE` is an **environment secret**. Its name follows
  `APP_STACK_ENV_NAME_PATTERN`, is not reserved, and may look like a secret (that is its purpose).
- `${key}` of a secret parameter is allowed inside an environment `value` (still `INTERP_SECRET_PARAMETER` in
  `command`). At most four secret references per value (`ENV_SECRET_REFERENCES_TOO_MANY`). An entry whose value holds a
  secret reference is an environment secret; its name may look like a secret; its literal parts are still checked by
  `envValueProblem` piece by piece, and the worst-case length rule counts a secret reference as zero.
- A value entry without a secret reference keeps every v1 rule (`ENV_NAME_SECRET_LIKE`, `ENV_VALUE_SECRET_LIKE`).
- A secret used in an environment value may be at most 4 096 characters (API rule when it is set); the executor
  refuses an expanded value over 32 768 UTF-8 bytes.

## 5. Spec and plan (contracts)

- `AppTemplateSpecSchema` = discriminated union on `schemaVersion` of the untouched v1 object and a v2 object; one
  shared refine. v2 additions: secret parameter `{…, required, customer: boolean, generate: {kind, length} | null}`;
  service `profile: "strict" | "standard"`. A stored v1 spec, its spec hash and its plan do not change.
- `ApprovedStackPlanSchema` = discriminated union on `schemaVersion` of the untouched v1 object and a v2 object.
  A v2 component adds

  ```ts
  profile: "strict" | "standard"
  secretEnvironment: { name: string; pieces: ({ literal: string } | { parameterKey: string; version: number })[] }[]
  ```

  sorted by `name`, names distinct from `environment` and `secretFiles` names, at least one parameter piece per
  entry, at most `APP_STACK_SECRET_ENV_PIECES` pieces, literal pieces checked with `appStackTextProblem`. The plan
  carries **no secret value**: only parameter keys and versions, as `secretFiles` already does. The three finders
  (`findUnsafeDockerInputFields`, `findPlaintextSecretKeys`, `findForbiddenPublicDtoKeys`) still run over the whole
  plan.
- The component hash and the plan hash cover `profile` and `secretEnvironment`, so a new secret version or a profile
  change replaces the container.
- Helpers in contracts: `appStackComponentProfile(component)` (`"strict"` for v1),
  `appStackComponentSecretEnvironment(component)` (`[]` for v1), `appStackComponentSecretRefs(component)` and
  `appStackPlanSecretRefs(plan)` (distinct `{parameterKey, version}` of `secretFiles` and `secretEnvironment`).
- The preview drops versions from `secretEnvironment` pieces as it does for `secretFiles`.

## 6. Executor

- `assertExecutableAppStackPlan`: for a v2 plan the image rule is «digest-pinned» only; when the repository has an
  allowlist row the plan's `runAsUser` must equal the row's.
- `buildAppStackContainerCreatePayload(plan, key, ctx)` builds the body of the component's profile;
  `assertAppStackPayloadHardening` checks it against the closed body of that profile (exact `CapAdd` list for
  `standard`, none for `strict`) and that every `Env` name is one of the plan's.
- **create** (`createAppStackComponents`) takes `{ plan, secretContents? }`. `secretContents` (same entry shape and
  limits as `secretFileContents`) is sent only when the plan has a `secretEnvironment` entry; the wire format of a v1
  create is unchanged. The executor refuses a missing, duplicated or foreign entry before it removes anything, expands
  the pieces into `Env`, and never returns `Config.Env` or puts a value in an error or a log line.
- **start / restart**: `secretFileContents` now carries every secret the component references (files and environment).
  All of them are written to the component's secret directory (so log masking covers them); only file secrets are
  bound into the container. A component with no secret reference has its directory purged, as today.
- **resolve** (new method `resolveAppStackImage({ image })`): `image` is `[registry/]repository[:tag]` without a digest;
  the executor asks the Engine `GET /distribution/<image>/json` and returns `{ image, digest }` (`Descriptor.digest`,
  the index digest). Failure: `STACK_IMAGE_PULL_FAILED`. No credentials are ever sent (public registries only).
- The simulator follows every point above.

## 7. Compose importer (server administrator only)

`importComposeToAppTemplate(input)` in `packages/policy-engine` — pure, synchronous, never throws.

```ts
input:  { compose: string; name?: string; category?: string; digests: ReadonlyMap<string, string> }
output: { ok: true; source: string; report: ComposeImportNote[] } | { ok: false; report: ComposeImportNote[] }
note:   { level: "info" | "changed" | "dropped" | "refused"; path: string; code: ComposeImportCode; message: string }
```

`listComposeImages(compose)` returns the image references the API must resolve first. The API route
`POST /v1/admin/app-templates/import-compose` (administrator, `applicationTemplatesAvailable`) lists the images, asks
the executor for the digests of those without one, runs the importer and returns `{ source, report, validation }`
where `validation` is the strict validator's verdict on the draft. Nothing is stored: the administrator reviews the
draft in the existing editor and saves it through the existing routes, which validate again.

Reading: the in-house YAML subset (`parseTemplateYaml`); a file outside the subset (anchors, block scalars, …) is
refused with the positioned error. Rules:

| Compose | Result |
|---|---|
| `image: name[:tag]` | pinned with the resolved digest; `latest` or no tag → the tag is dropped (`changed`); unresolved → `refused` |
| `environment` (map or list form) | value entries; a value that looks like a secret under a secret-looking name becomes a generated secret (`changed`) |
| `${SERVICE_PASSWORD_X}`, `${SERVICE_PASSWORD_64_X}`, `${SERVICE_USER_X}`, `${SERVICE_BASE64_X}`, `${SERVICE_BASE64_64_X}`, `${SERVICE_HEX_32_X}` … | one generated secret parameter per distinct name |
| `${SERVICE_FQDN_X}`, `${SERVICE_URL_X}`, with optional `_<PORT>` | an ingress entry on the service that carries it (port from the suffix, else `expose`, else the container side of `ports`, else 80 with a note); the variable itself is dropped with a note (platform URL variables are a follow-up) |
| `${VAR:-default}`, `${VAR-default}` | a `string` parameter with that default, `customer: false` |
| `${VAR}`, `${VAR:?msg}` | a `string` parameter, `customer: true`, empty default (`changed`) |
| `volumes: name:/path[:ro]` | a named volume; top-level volume options are dropped |
| `volumes: ./host:/path`, `/host:/path`, `docker.sock` | `refused` |
| `ports` | dropped (`dropped`); the container side feeds `expose` |
| `depends_on` (list or map form) | `depends_on` list |
| `healthcheck` | `curl`/`wget` on `localhost` → `http`; anything else → `tcp` on the ingress port, a known default port (MariaDB/MySQL 3306, PostgreSQL 5432, Redis/Valkey 6379, MongoDB 27017) or the first exposed port; none available → dropped with a note |
| `command` (list form) | kept; string form is split on spaces only when it has no quote or shell character, else `refused` |
| `deploy.resources.limits`, `mem_limit`, `cpus` | limits; missing → 0.5 CPU and 512M (`info`) |
| `restart`, `container_name`, `labels`, `networks`, `hostname`, `logging`, `stop_grace_period`, … | dropped (`dropped`) |
| `privileged`, `cap_add`, `devices`, `network_mode`, `pid`, `ipc`, `security_opt`, `user`, `build`, `env_file`, `entrypoint`, … | `refused` (the draft is not produced) |

Every imported service gets `x-hp-profile: standard`. The header's name and category come from the input, else from
the `# name:` / `# category:` comment lines of the file, else «Applicazione importata» / `apps`.

## 8. API and web

- Creating a stack generates the secrets of §4.3 in the same transaction. Upgrade does the same for new generated
  parameters. The secret route refuses a `customer: false` secret. Secrets used in the environment are bounded as in
  §4.4. The runtime sends `secretContents` on create when the plan needs it and every referenced secret on start.
- A stored template version records the spec version of its source (1 or 2).
- Web, administrator: «Importa da Compose» in «Modelli» (paste, import, read the report, continue in the editor);
  the preview shows each component's profile and its environment secrets by name.
- Web, customer: the install form never asks for a generated secret; a `customer: true` generated secret can be
  replaced later from the application page, a `customer: false` one is not shown.

## 9. Built-in WordPress template

`atpl_wordpress_mariadb`, v2, written for this repository: `wordpress` (official image, `standard`, `/var/www/html`
on a volume, ingress on port 80) and `db` (official `mariadb`, `standard`, `/var/lib/mysql` on a volume, internal
only), two generated secrets (`db_password`, `db_root_password`, `customer: false`). Seeded disabled like the other
built-in templates: the administrator publishes it. Its name says «in contenitore» so the chooser never confuses it
with the managed WordPress site.

## 10. Verification

- v1 fixtures: same spec, spec hash, plan and plan hash as before (existing tests unchanged).
- Contracts, validator, compiler, importer: unit tests, including the security sweep over `APP_TEMPLATE_KEY_LEVELS`
  for both versions and «no secret value in plan, preview, DTO».
- Executor: payload tests per profile, create with secrets, simulator parity.
- API: install with generated secrets end to end on the simulator, import route, sweep tests, OpenAPI.
- Real Docker: `infra/linux/accept-app-stack-wordpress.mjs` (WordPress answers through the stack path, restart keeps
  data, the hardening of the `standard` body is read back from the Engine).
- The repository's verify command.

## 11. Left to the builder

Names of private helpers, message wording (fixed texts, never echoing a value), test file layout, and the exact
Italian/English texts, within the rules above.
