# Step 1b — Fresh-Server Installer, Release Archives and Updates — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One documented command turns a fresh Ubuntu 24.04 / Debian 12 server into a working panel: prerequisites installed, the panel installed from a checksum-verified release archive, PostgreSQL provisioned, the first administrator created, and the panel reachable over HTTPS on its own hostname. A second command updates the panel safely with automatic rollback.

**Architecture:**
- **Releases:** a release is a self-contained archive with built apps plus production `node_modules`, so the server needs no pnpm or build step. It is published on GitHub Releases with a `.sha256` file.
- **Layout on the server:** each release is unpacked to `/opt/hosting-panel/releases/<version>/`. `/opt/hosting-panel/current` is a symlink, and every systemd unit runs from it. Updating swaps the symlink, restarts only the four Control Plane services, health-checks them, and rolls back on failure.
- **Panel HTTPS:** the existing Traefik ingress proxy gains an HTTPS entrypoint with a Let's Encrypt resolver and a single panel route to `hp-web`. Until DNS points at the server, the panel is served on the server IP with Traefik's default self-signed certificate.
- **Shell vs Node:** the installer and updater are bash, because they run before Node exists. Their risky pieces live in one small bash library that Vitest drives directly.

**Tech Stack:** bash (installer/updater), **Node 26 LTS** + TypeScript (release builder, executor changes), **Traefik v3.7**, **PostgreSQL 18** (PGDG apt; latest stable — 19 is not GA until 19 Nov 2026), Docker CE (Docker apt repo), systemd, nftables, GitHub Actions + `gh` CLI. Versions checked on 2026-11-08: Traefik 3.7.17 current (3.6 EOL Aug 2026), Node 26 Active LTS since 28 Oct 2026, PostgreSQL 18.6 latest stable.

**Spec:** `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md` (section 5 "Installation and operation", section 8 step 1, section 9 constraints). Builds on Step 1a: `docs/superpowers/plans/2026-11-08-step-1a-accounts-login-i18n-shell.md`.

## Global Constraints

- Supported OS (owner decision): **Ubuntu 24.04 LTS (`noble`), Ubuntu 26.04 LTS (`resolute`), Debian 12 (`bookworm`), Debian 13 (`trixie`)**. Detect them by `ID` + `VERSION_CODENAME` from `/etc/os-release`. Refuse others unless `--allow-other-linux`, which already exists in `bootstrap-dedicated.sh`. Apt repositories are configured with the codename and a `signed-by=/etc/apt/keyrings/<name>.asc` keyring, never `apt-key`: it is gone on Debian 13 and Ubuntu 26.04.
- **Runtime versions:** Node **26** (the `.node-version` major; the exact patch the release was built with is recorded in `RELEASE.json`), Traefik image **`traefik:v3.7`**, PostgreSQL **18** from PGDG on every supported OS. Distro PostgreSQL versions differ: Debian 12 ships 15, Debian 13 ships 17, Ubuntu 26.04 ships 18, so PGDG keeps one version everywhere.
- **No new npm dependencies.** System packages via apt are allowed: `docker-ce` (Docker apt repo), `postgresql-18` (apt.postgresql.org), `curl`, `ca-certificates`, `gnupg`, `nftables`, `openssl`, `tar`. Node comes from the official nodejs.org `linux-x64` tarball, verified against that version's `SHASUMS256.txt`.
- If Docker's apt repo has no packages for the detected codename (Docker does not officially list Ubuntu 26.04 yet), the installer stops with a clear message naming the OS and the Docker docs URL. It never falls back to the distro `docker.io` package.
- **Release source:** versioned archives `hosting-panel-<version>-linux-x64.tar.gz` and `…tar.gz.sha256`, published as GitHub Release assets on `lollinoo/hosting-panel` under tag `v<version>`. The installer and updater also accept `--archive <path>` for offline installs. Signature verification is out of scope (`shortcut:` comment where the checksum is verified).
- `<version>` = root `package.json` `"version"`. A release tag must equal `v` + that version.
- **Data plane keeps serving sites while the Control Plane is down or restarting (`CP-01`).** An update never stops or recreates tenant containers. The ingress proxy is recreated only when its configuration actually changed.
- Docker socket only in `hp-docker-executor`. No shell in `hp-host-agent`. Secrets never printed to logs. The only exception is the one-time operator output: the admin TOTP secret and the "back up your keys" notice.
- Every secret file under `/etc/hosting-panel` is `0400`, owned by `root` (env files) or by the owning service user (keys, as today). No service can read another service's env file.
- Fresh installs only (spec 5). No upgrade path from the Step 1a `hosting-panel.env` layout is needed.
- Every task ends green on `corepack pnpm run build && corepack pnpm run lint && corepack pnpm run typecheck && corepack pnpm run test`.

## Review Focus

1. **The installer is run a second time on an installed server.** It must not regenerate keys, secrets or the DB password, must not try to create the admin again, and must not interrupt running sites (Task 6: `install.sh is idempotent on rerun (dry-run plan shows no regeneration)` plus lib tests in Task 5).
2. **An update's new API fails its health check.** The updater must put the previous release back, restart it, exit non-zero, and leave sites untouched (Task 7: `update rolls back when health check fails`).
3. **The download is corrupt or truncated (checksum mismatch).** Abort before anything under `/opt/hosting-panel` changes (Task 5: `verify_release_archive rejects a mismatched checksum and leaves target untouched`).
4. **The panel hostname has no DNS yet.** The panel still answers on `https://<server-ip>` with a self-signed certificate, and the certificate is obtained automatically once DNS points here, with no manual step (Task 2: `panel route matches hostname and server IP`; Task 9 live check).
5. **The extract is interrupted, or the disk is full, during an update.** `current` still points at the old release, because the new one is fully extracted into a temp dir before an atomic rename and symlink swap (Task 5: `install_release extracts to temp and renames atomically; current unchanged on extract failure`).

---

### Task 0: Platform baseline — supported OS matrix, Node 26, Traefik 3.7

**Files:**
- Modify: `infra/linux/bootstrap-dedicated.sh` (section 1 OS check)
- Modify: `.node-version` (→ `26`), root `package.json` `engines.node` (→ `">=26.0.0"`), `@types/node` in the pnpm catalog (`pnpm-workspace.yaml`) to the latest 26.x types, `.github/workflows/ci.yml` (it already reads `.node-version`; no change unless it pins elsewhere)
- Modify: `apps/docker-executor/src/traefik-config.ts` (`DEFAULT_TRAEFIK_IMAGE = "traefik:v3.7"`), plus any docs or tests that assert `traefik:v3.3`
- Modify: `README.md` / `HARNESS.md` where they state "Node.js 24", "Ubuntu 24.04 / Debian 12" or "Traefik v3.3"
- Test: `apps/api/test/infra-layout.test.ts` (created here; Task 1 extends it)

**Interfaces:**
- Produces in `bootstrap-dedicated.sh`: `detect_supported_os` accepts exactly `ubuntu:noble`, `ubuntu:resolute`, `debian:bookworm` and `debian:trixie` (from `ID`/`VERSION_CODENAME`). It prints `ID VERSION_CODENAME` on success, and fails with the list of supported versions otherwise. It honours `--allow-other-linux`. Task 6 reuses it by sourcing the same logic. Move it into `infra/linux/lib/os.sh` so both scripts source it, and have `install.sh` and `bootstrap-dedicated.sh` source `lib/os.sh`.
- `HP_OS_RELEASE_FILE` (default `/etc/os-release`) can be overridden, for tests.

- [ ] **Step 1: Write failing tests** in `infra-layout.test.ts` (spawn `bash -c 'HP_OS_RELEASE_FILE=<fixture> source infra/linux/lib/os.sh; detect_supported_os'`):
  - `accepts the four supported releases`: fixtures for noble, resolute, bookworm and trixie each exit 0 and print `ubuntu noble` and so on.
  - `rejects other releases with the supported list`: `ubuntu jammy` and `debian bullseye` exit non-zero, and stderr names all four supported versions.
  - `node and traefik baselines`: `.node-version` starts with `26`, `package.json` `engines.node` is `">=26.0.0"`, and `traefik-config.ts` contains `"traefik:v3.7"`.
- [ ] **Step 2: Run them and confirm they fail.** Run `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm exec vitest run apps/api/test/infra-layout.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Create `lib/os.sh`; bootstrap sources it and keeps its kernel 6.x and cgroups v2 checks.
  - Bump Node, types and Traefik.
  - Reinstall with `corepack pnpm install` so the lockfile updates.
  - Install Node 26 locally (via the project's usual version manager, or nodejs.org) before running the checks.
- [ ] **Step 4: Run the four checks on Node 26.** Expected: all exit 0. Record `node --version` in the report. If a dependency breaks on Node 26, stop and report it (BLOCKED) rather than pinning back to 24.
- [ ] **Step 5: Commit** `chore(platform): support Ubuntu 24.04/26.04 and Debian 12/13, Node 26 LTS, Traefik 3.7`.

---

### Task 1: Per-service env files, `current` symlink paths, web bind address, CLI wrappers

The test file `apps/api/test/infra-layout.test.ts` already exists from Task 0; add to it.

**Files:**
- Modify: `infra/systemd/hp-api.service`, `hp-web.service`, `hp-docker-executor.service`, `hp-host-agent.service`
- Modify: `infra/linux/bootstrap-dedicated.sh` (sections 7 and the closing message)
- Create: `infra/linux/hp-accounts`, `infra/linux/hp-break-glass` (bash wrappers)
- Test: `apps/api/test/infra-layout.test.ts`

**Interfaces:**
- Produces, on the server:
  - **Env files:** `/etc/hosting-panel/api.env`, `/etc/hosting-panel/web.env` and `/etc/hosting-panel/executor.env`, all `0400 root:root` and created only if absent.
    - `api.env` holds `DATABASE_URL`, `ENABLE_DEV_OIDC=false` and `HP_SEED_DEMO=false`. Bootstrap writes an empty `DATABASE_URL=` placeholder line; Task 6 fills it in.
    - `web.env` holds `BFF_SESSION_SECRET=<64 hex>`, `API_INTERNAL_URL=http://127.0.0.1:4000` and `HP_WEB_BIND_ADDRESS=` (filled in by Task 6).
    - `executor.env` holds `HP_PANEL_HOSTNAME=`, `HP_PANEL_IPV4=`, `HP_ACME_EMAIL=`, `HP_ACME_STAGING=false` and `HP_PANEL_UPSTREAM_PORT=3000` (filled in by Task 6, consumed by Task 2).
  - **Units:** each unit loads only its own env file (`EnvironmentFile=/etc/hosting-panel/<name>.env`, not optional). `hp-host-agent` keeps no env file. `ExecStart` and `WorkingDirectory` point at `/opt/hosting-panel/current/...`.
  - `hp-web` starts with `next start --hostname ${HP_WEB_BIND_ADDRESS} --port 3000` (systemd expands the variable) and gets `After=docker.service`.
  - **Wrappers:** `hp-accounts <args>` and `hp-break-glass <args>`, installed by bootstrap to `/usr/local/sbin`, mode `0750 root:root`. They read `DATABASE_URL` from `api.env` (as root) and exec `runuser -u hp-api -- env DATABASE_URL=… HP_SECRETS_MASTER_KEY_FILE=/etc/hosting-panel/secrets-master.key node /opt/hosting-panel/current/apps/api/dist/cli/<accounts|break-glass>.js "$@"`. The secret never lands on a command line visible in `ps` for other users: pass it through the environment, not argv.
- Removes: the shared `/etc/hosting-panel/hosting-panel.env` and its `0440 root:hp-web` handling.

- [ ] **Step 1: Write failing tests** in `infra-layout.test.ts`. They read files as text; no root needed.
  - `each unit loads only its own env file`:
    - `hp-api.service` contains `EnvironmentFile=/etc/hosting-panel/api.env`, and no other `EnvironmentFile`.
    - Same pattern for web → `web.env` and executor → `executor.env`.
    - `hp-host-agent.service` has no `EnvironmentFile`.
    - No unit mentions `hosting-panel.env`.
  - `units run from the current symlink`: every `ExecStart=` and `WorkingDirectory=` path starts with `/opt/hosting-panel/current/`.
  - `web binds to HP_WEB_BIND_ADDRESS`: `hp-web.service` ExecStart contains `--hostname ${HP_WEB_BIND_ADDRESS}` and has `After=` including `docker.service`.
  - `bootstrap dry-run lists the three env files with 0400`: run `bash infra/linux/bootstrap-dedicated.sh --dry-run --allow-other-linux`. stdout mentions `api.env`, `web.env`, `executor.env`, `0400` and `/usr/local/sbin/hp-accounts`, and does not mention `hosting-panel.env`. Skip this test (`it.skipIf`) when `/sys/fs/cgroup/cgroup.controllers` or `docker` is missing on the test machine, since the dry-run checks prerequisites.
  - `wrappers never put DATABASE_URL in argv`: the wrapper source does not contain `"$DATABASE_URL"` after `node`, and does contain `runuser -u hp-api`.
- [ ] **Step 2: Run them and confirm they fail.** Run `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm exec vitest run apps/api/test/infra-layout.test.ts`. Expected: FAIL.
- [ ] **Step 3: Edit the units, bootstrap and wrappers** as listed. Bootstrap generates `BFF_SESSION_SECRET` only if `web.env` is absent. All three env files are written with `install -m 0400 -o root -g root` from a temp file, never `touch` then `chmod`. Keep the existing key generation unchanged.
- [ ] **Step 4: Run the tests and the four checks.** Run `bash -n infra/linux/bootstrap-dedicated.sh infra/linux/hp-accounts infra/linux/hp-break-glass`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(infra): per-service env files, current-release paths and CLI wrappers`.

---

### Task 2: Panel HTTPS through the ingress proxy

**Files:**
- Modify: `apps/docker-executor/src/traefik-config.ts`
- Modify: `apps/docker-executor/src/docker-engine-adapter.ts` (`ensureIngressProxy`, recreate-on-change comparison)
- Modify: `apps/docker-executor/src/main.ts` (read panel env; ensure the ingress at startup when `HP_PANEL_HOSTNAME` is set)
- Modify: `apps/docker-executor/src/simulator-adapter.ts` (same panel config, in memory)
- Modify: `infra/linux/bootstrap-dedicated.sh` (create `/var/lib/hosting-panel/ingress/acme`, `0700 hp-executor`)
- Test: `apps/docker-executor/test/docker-executor.test.ts` (new `describe("panel ingress")`)

**Interfaces:**
- Produces (in `traefik-config.ts`):
  - `interface PanelIngressConfig { readonly hostname: string; readonly ipv4: string; readonly acmeEmail: string | null; readonly acmeStaging: boolean; readonly upstreamPort: number }`
  - `buildTraefikStaticYaml(panel: PanelIngressConfig | null): string`:
    - Always: entrypoints `web` `:80` and `websecure` `:443`; the file provider unchanged.
    - With `panel?.acmeEmail`: `certificatesResolvers.le.acme` with `email`, `storage: /etc/traefik/acme/acme.json` and `httpChallenge.entryPoint: web`. With `acmeStaging` also `caServer: https://acme-staging-v02.api.letsencrypt.org/directory`.
  - `buildPanelDynamicYaml(panel: PanelIngressConfig): string`. Three routers:
    1. `hp-panel` on `websecure`, rule ``Host(`<hostname>`)``, `tls.certResolver: le` (omit `certResolver` when there is no email).
    2. `hp-panel-ip` on `websecure`, rule ``Host(`<ipv4>`)``, `tls: {}` (Traefik default self-signed cert).
    3. `hp-panel-http` on `web`, rule ``Host(`<hostname>`) || Host(`<ipv4>`)``, with a `redirectScheme` middleware to `https` (permanent).
    - All of them use service `hp-panel` → `http://host.docker.internal:<upstreamPort>`.
    - Hostname and IP go through the existing `assertSafeDomain`. IPv4 is validated with `net.isIPv4`.
  - `PANEL_DYNAMIC_FILE_NAME = "hp-panel.yml"`, written with the existing `writeFileAtomically` into the dynamic dir.
  - `buildIngressProxyContainerPayload(input)` gains:
    - `httpsHostPort` (default 443) → `PortBindings["443/tcp"]` and `ExposedPorts["443/tcp"]`;
    - `acmeDirHostPath` → bind `<acmeDirHostPath>:/etc/traefik/acme` (read-write; the only rw mount);
    - `HostConfig.ExtraHosts: ["host.docker.internal:host-gateway"]`.
  - `ensureIngressProxy()` recreates the container when **any** of `Image`, `Cmd`, `Binds`, `PortBindings` or `ExtraHosts` differs from the expected payload. Today it compares binds only. Otherwise it leaves the container running.
- Consumes: `executor.env` keys from Task 1. `main.ts` builds `PanelIngressConfig | null` (null when `HP_PANEL_HOSTNAME` is empty). When it is non-null and the backend is the real Docker adapter, it awaits `ensureIngressProxy()` after the IPC server starts. A failure is logged and retried every 60 s; it never crashes the executor.

- [ ] **Step 1: Write failing tests:**
  - `static yaml has websecure and acme resolver only with email`. With email: contains `websecure:`, `address: ":443"`, `certificatesResolvers:`, `storage: /etc/traefik/acme/acme.json`, `entryPoint: web`. Without email: contains `websecure:` but not `certificatesResolvers`. With staging: contains `acme-staging-v02`.
  - `panel route matches hostname and server IP`: `buildPanelDynamicYaml({hostname:"srv12.example.it", ipv4:"203.0.113.10", acmeEmail:"ops@example.it", acmeStaging:false, upstreamPort:3000})` contains ``Host(`srv12.example.it`)``, ``Host(`203.0.113.10`)``, `certResolver: le`, `http://host.docker.internal:3000` and `scheme: https`.
  - `panel route rejects unsafe hostname or invalid ipv4`: hostname ``"a`b"`` throws, and ipv4 `"999.1.1.1"` throws `VALIDATION_ERROR`.
  - `proxy payload binds 443, acme dir rw, host-gateway`: `PortBindings["443/tcp"][0].HostPort === "443"`, `Binds` contains `/var/lib/hosting-panel/ingress/acme:/etc/traefik/acme` without `:ro`, `ExtraHosts` equals `["host.docker.internal:host-gateway"]`, and still no `docker.sock`.
  - `ensureIngressProxy does not recreate an up-to-date proxy`: use the existing fake Docker client pattern in the test file. Inspect returns a container whose config equals the expected payload, and no `DELETE`/`create` call is made. A second case where only `PortBindings` differs triggers recreate.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run apps/docker-executor/test/docker-executor.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified. Keep the existing site routes untouched; site HTTPS is step 2.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(docker-executor): panel HTTPS route with Let's Encrypt and IP fallback`.

---

### Task 3: Firewall allows the ingress proxy to reach the panel web service

**Files:**
- Modify: `infra/linux/nftables-dedicated.conf`
- Modify: `apps/host-agent/src/nftables-baseline.ts` (pinned SHA-256 / expected content)
- Test: `apps/host-agent/test/host-agent.test.ts` (existing pin test, plus one new test)

**Interfaces:**
- In chain `input`, add exactly: `iifname { "docker0", "br-*" } tcp dport 3000 ct state new accept`. Port 3000 stays closed to every other interface. 22/80/443 are unchanged.
- The pinned hash in `nftables-baseline.ts` is updated to the new file's SHA-256.

- [ ] **Step 1: Write the failing test** `baseline allows 3000 only from docker bridges`. The ruleset text contains that exact rule, and it contains no other rule mentioning `3000`. Update the existing pin test's expected hash only after the file change.
- [ ] **Step 2: Run it and confirm it fails.** Run `corepack pnpm exec vitest run apps/host-agent/test/host-agent.test.ts`. Expected: FAIL.
- [ ] **Step 3: Edit the ruleset and update the pin.** Check the ruleset syntax with `nft -c -f infra/linux/nftables-dedicated.conf` if `nft` is available (it needs root on most systems; otherwise note "not run").
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.**
- [ ] **Step 5: Commit** `feat(infra): allow docker bridges to reach the panel web port`.

---

### Task 4: Release archive builder and smoke test

**Files:**
- Create: `infra/release/build-release.mjs`, `infra/release/smoke-release.mjs`
- Modify: root `package.json` (scripts `release:build`, `release:smoke`), `.gitignore` (`dist-release/`)
- Test: `infra/release/release-manifest.test.ts` (included by the root vitest config: add `infra/**/*.test.ts` to `vitest.config.ts` `include`)

**Interfaces:**
- `node infra/release/build-release.mjs [--version <v>] [--out dist-release]`:
  1. Runs `corepack pnpm run build`.
  2. Assembles `dist-release/hosting-panel-<v>/`, which must run with **`node` only** (no pnpm, no build tools). The builder picks the mechanism (`pnpm deploy --prod` per app, or a staged copy plus `pnpm install --prod --frozen-lockfile`). Next.js may use `output: "standalone"` if that is simpler; if so, update `hp-web.service` ExecStart in the same commit and keep `--hostname ${HP_WEB_BIND_ADDRESS}` semantics (standalone reads `HOSTNAME`/`PORT` env).
  3. Writes `VERSION` (the version string), `RELEASE.json` (`{ version, gitCommit, builtAt, node: <.node-version> }`), `hosting-panel-<v>-linux-x64.tar.gz` (top-level dir `hosting-panel-<v>/`) and `…tar.gz.sha256` (`<hex>  <filename>`, sha256sum format).
  4. Exits non-zero if `--version` differs from root `package.json` version.
- Exported pure helper (same file, ESM export): `listReleaseViolations(dir: string): Promise<string[]>`. It returns problems:
  - missing required paths: `VERSION`, `RELEASE.json`, `apps/api/dist/main.js`, `apps/api/dist/cli/accounts.js`, `apps/api/dist/cli/break-glass.js`, `apps/docker-executor/dist/main.js`, `apps/host-agent/dist/main.js`, the web server entry, `packages/database/dist/migrations/0001_phase1_docker_native.sql`, `infra/systemd/*.service`, `infra/linux/bootstrap-dedicated.sh`, `infra/linux/install.sh`, `infra/linux/update.sh`, `infra/linux/lib/release.sh`, `infra/linux/nftables-dedicated.conf`, `infra/linux/hp-accounts`, `infra/linux/hp-break-glass`;
  - forbidden content: any `*.test.ts`, any `src/**/*.ts` sources, `.env`, `.env.*` other than `.env.example`, `.git`, `.superpowers`, `node_modules/.cache`.
- `node infra/release/smoke-release.mjs <archive.tar.gz>`:
  1. Verifies the `.sha256` next to the archive and extracts it to a temp dir.
  2. Starts the API from the extracted tree with `node apps/api/dist/main.js` (`API_PORT=0` is not supported by main — use a free port found via `net.createServer().listen(0)`; `HP_RUNTIME_BACKEND=disabled`, no `DATABASE_URL` → PGlite) and waits for `GET /v1/health/live` 200 within 30 s.
  3. Starts web from the extracted tree on another free port with `API_INTERNAL_URL` set and `BFF_SESSION_SECRET` = 32 random hex, and waits for `GET /login` 200.
  4. Kills both, deletes the temp dir, and exits 0 only if both checks passed.

- [ ] **Step 1: Write failing tests** in `release-manifest.test.ts`, against a temp dir fixture (not a real build):
  - `reports missing required paths` on an empty dir: it includes `apps/api/dist/main.js` and `VERSION`.
  - `reports forbidden files`: a fixture with `apps/api/src/x.ts`, `.env` and `a.test.ts` → three violations.
  - `accepts a complete minimal tree`: touch every required path → `[]`.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run infra/release/release-manifest.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement both scripts.** `build-release.mjs` calls `listReleaseViolations` on the staged dir and fails the build if it returns anything.
- [ ] **Step 4: Run the tests, then the real thing.** Run `corepack pnpm run release:build && corepack pnpm run release:smoke dist-release/hosting-panel-$(node -p "require('./package.json').version")-linux-x64.tar.gz`. Expected: the smoke test prints both checks OK and exits 0. Record the archive size in the report.
- [ ] **Step 5: Commit** `feat(release): self-contained release archive builder and smoke test`.

---

### Task 5: Shared bash release library

**Files:**
- Create: `infra/linux/lib/release.sh`
- Test: `infra/linux/release-lib.test.ts` (Vitest runs `bash -c 'source infra/linux/lib/release.sh; <fn> …'` against temp dirs; only `bash`, `tar`, `sha256sum` are needed)

**Interfaces (bash functions; all `set -euo pipefail`-safe; they print errors to stderr and return non-zero, never `exit`):**
- `release_asset_url <version>` → prints `https://github.com/lollinoo/hosting-panel/releases/download/v<version>/hosting-panel-<version>-linux-x64.tar.gz`.
- `fetch_release <version> <dest_dir>` → downloads the archive and its `.sha256` with `curl -fsSL --retry 3` into `<dest_dir>`. It prints the archive path.
- `verify_release_archive <archive>` → checks `<archive>.sha256` with `sha256sum -c` (run in the archive's dir). Returns non-zero on mismatch or a missing checksum file. Add the comment `# shortcut: checksum only, no signature — add minisign/cosign verification before third parties publish releases`.
- `install_release <archive> <root>` (root defaults to `/opt/hosting-panel`):
  - extracts into `<root>/releases/.tmp-<random>`, checks that the top-level dir is `hosting-panel-<v>` and that `VERSION` matches;
  - `mv` renames it to `<root>/releases/<v>` (refusing if it already exists, unless `HP_FORCE_REINSTALL=1`) and prints `<v>`;
  - on any failure removes the temp dir and leaves `releases/<v>` and `current` untouched.
- `current_version <root>` → prints the version that `current` points to, or empty.
- `swap_current <root> <version>` → creates `<root>/current.new` as a symlink to `releases/<v>`, then `mv -T current.new current` (atomic).
- `prune_releases <root> <keep>` → deletes the oldest release dirs beyond `<keep>` (default 3). It never deletes the one `current` points to or the one passed as `HP_KEEP_EXTRA`.
- `version_gt <a> <b>` → returns 0 if semver `a > b` (numeric x.y.z only).

- [ ] **Step 1: Write failing tests** (each builds a tiny fixture archive with `tar` and `sha256sum` in a temp dir):
  - `verify_release_archive accepts a matching checksum`.
  - `verify_release_archive rejects a mismatched checksum and leaves target untouched`: corrupt one byte; the function returns non-zero, and `<root>/releases` does not exist afterwards when followed by the guarded `install_release` call pattern used in install/update (`verify … && install_release …`).
  - `install_release extracts to temp and renames atomically; current unchanged on extract failure`: a truncated archive → non-zero, no `.tmp-*` left behind, no `releases/<v>`, and `current` still points to the old version.
  - `install_release refuses a VERSION mismatch`.
  - `swap_current is atomic and repeatable`: swap to 0.1.0 then 0.2.0; `readlink current` = `releases/0.2.0`; no `current.new` left.
  - `prune_releases keeps current and newest`: releases 0.1.0..0.5.0 with current = 0.2.0 and keep = 3 → remaining: 0.2.0, 0.4.0, 0.5.0.
  - `version_gt compares numerically`: `0.10.0 > 0.9.9` is true; `0.2.0 > 0.2.0` is false.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run infra/linux/release-lib.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `release.sh`.**
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Also run `bash -n infra/linux/lib/release.sh`.
- [ ] **Step 5: Commit** `feat(infra): release fetch, verify, install, swap and prune library`.

---

### Task 6: Fresh-server installer `install.sh`

**Files:**
- Create: `infra/linux/install.sh`
- Test: `infra/linux/install.test.ts`

**Interfaces:**
- Usage: `sudo bash install.sh --hostname <fqdn> --admin-email <email> --admin-name "<name>" [--acme-email <email>] [--ipv4 <addr>] [--version <v> | --archive <path>] [--acme-staging] [--dry-run] [--allow-other-linux]`
  - `--acme-email` defaults to `--admin-email`.
  - `--ipv4` defaults to the source address of the default route (`ip -4 route get 1.1.1.1`).
  - `--version` defaults to "latest", resolved via `https://api.github.com/repos/lollinoo/hosting-panel/releases/latest` `tag_name`.
  - The admin password comes from env `HP_ADMIN_PASSWORD` or a hidden prompt (`read -rs`, asked twice, ≥12 chars).
- Steps, in order. Each step is idempotent and prints `[STEP n/12] …`; `--dry-run` prints the plan without changing anything and without needing root.
  1. OS check: `detect_supported_os` from `lib/os.sh` (Task 0).
  2. apt prerequisites (`curl ca-certificates gnupg nftables openssl tar`).
  3. Docker CE from the official Docker apt repo, if `docker` is missing. Use `https://download.docker.com/linux/<ubuntu|debian>`, the detected codename, and a `signed-by=/etc/apt/keyrings/docker.asc` keyring. Remove the conflicting distro packages first (`docker.io docker-compose docker-doc podman-docker containerd runc`, only if present). If `apt-get update` shows no `docker-ce` candidate for the codename, stop with exit 3 and the message from Global Constraints. Then enable and start `docker`.
  4. Node: the exact version from the release's `RELEASE.json` `node` field (e.g. `26.13.0`), installed from `https://nodejs.org/dist/v<v>/node-v<v>-linux-x64.tar.xz`, verified against `https://nodejs.org/dist/v<v>/SHASUMS256.txt`, into `/opt/node-v<v>` and symlinked to `/usr/bin/node`. Skipped when `node --version` already equals `v<v>`.
  5. PostgreSQL 18 from the PGDG apt repo (`https://apt.postgresql.org/pub/repos/apt <codename>-pgdg main`, `signed-by=/etc/apt/keyrings/postgresql.asc`) if `postgresql-18` is missing. Pin the PGDG origin so it always wins over the distro's PostgreSQL. Enable and start it.
  6. Fetch or use the archive, then `verify_release_archive`, `install_release` and `swap_current` (Task 5 library, sourced from the extracted release; for the very first fetch the installer carries a copy of the same functions — **the installer sources `lib/release.sh` next to itself**, and the documented one-liner downloads the release archive first: see the docs in Task 8).
  7. Run `current/infra/linux/bootstrap-dedicated.sh`: users, keys, dirs, units, env files, wrappers.
  8. DB: create role `hosting_panel` with a random 32-byte password and database `hosting_panel` owned by it, only if the role does not exist yet. Write `DATABASE_URL=postgresql://hosting_panel:<pw>@127.0.0.1:5432/hosting_panel` into `api.env`, replacing the placeholder line, without echoing it.
  9. Fill `web.env` `HP_WEB_BIND_ADDRESS` with the `docker0` IPv4 (`ip -4 -o addr show docker0`), and `executor.env` with the panel values (`HP_PANEL_HOSTNAME`, `HP_PANEL_IPV4`, `HP_ACME_EMAIL`, `HP_ACME_STAGING`). Rerunning with different flags updates these values; secrets are never touched.
  10. Apply the firewall: `nft -f current/infra/linux/nftables-dedicated.conf`, and install it as a persistent nftables include (`/etc/nftables.d/hosting-panel.nft` plus an `include` line in `/etc/nftables.conf` if missing). Enable `nftables.service`.
  11. First run only (no row in `users` with `platform_role`): `hp-accounts setup --name "<hostname>" --hostname <hostname> --ipv4 <ip>`, then `HP_NEW_PASSWORD=… hp-accounts create-admin --email … --name …`. Capture and print the TOTP secret/URI once.
  12. `systemctl enable --now hp-host-agent hp-docker-executor hp-api hp-web`. Wait up to 90 s for `curl -fsS http://127.0.0.1:4000/v1/health/ready` and `curl -fsS http://<bind>:3000/login`.
- Final summary:
  - the panel URL `https://<hostname>`, and `https://<ipv4>` (self-signed until DNS points here);
  - the A record to create;
  - the TOTP enrolment (first run only);
  - a loud boxed warning: "Back up /etc/hosting-panel (keys) now — without them encrypted data and backups cannot be recovered" (IT + EN lines).
- Exit codes: 0 ok, 2 bad arguments, 3 unsupported OS, 4 checksum failure, 5 health check timeout. On failure it prints which step failed and the command to rerun (it is safe to rerun).

- [ ] **Step 1: Write failing tests** (Vitest spawning `bash infra/linux/install.sh … --dry-run`; no root, no network):
  - `rejects missing --hostname with exit 2`.
  - `rejects an invalid hostname or email with exit 2` (`--hostname "a b"`, `--admin-email nope`).
  - `dry-run prints all 12 steps in order`: stdout contains `[STEP 1/12]` … `[STEP 12/12]`, in increasing order.
  - `dry-run uses the detected codename for every apt repo`: with `HP_OS_RELEASE_FILE` pointing at a trixie fixture, stdout's planned repo lines contain `download.docker.com/linux/debian trixie` and `trixie-pgdg`, and contain neither `apt-key` nor `bookworm`. Same with a resolute fixture: `linux/ubuntu resolute` and `resolute-pgdg`.
  - `dry-run never prints secrets`: stdout and stderr contain neither `HP_ADMIN_PASSWORD`'s value (set to a canary such as `canary-pass-123456`) nor `postgresql://hosting_panel:`.
  - `install.sh is idempotent on rerun (dry-run plan shows no regeneration)`: with `HP_INSTALL_STATE_DIR` pointed at a fixture that simulates an installed server (fixture files `api.env` with a non-empty `DATABASE_URL`, `web.env`, keys present, a marker `admin-created`), the dry-run says `skip` for DB role creation, key generation and admin creation. Read the state from `HP_INSTALL_STATE_DIR` (default `/etc/hosting-panel`) so it is testable.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run infra/linux/install.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `install.sh`**, sourcing `lib/release.sh`. Secrets go through files or env only, never argv (use `psql` with `PGPASSWORD`-free peer auth as `postgres` via `runuser -u postgres -- psql -v pw=… <<SQL` and `:'pw'` quoting). Use `set -euo pipefail` and a `trap` that prints the failing step.
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Also run `bash -n infra/linux/install.sh`, and `shellcheck` if it is installed (report "not run" otherwise).
- [ ] **Step 5: Commit** `feat(infra): fresh-server installer`.

---

### Task 7: Updater `update.sh` with health check and rollback

**Files:**
- Create: `infra/linux/update.sh` (bootstrap also installs it as `/usr/local/sbin/hp-update`, mode `0750 root`; add that to Task 1's bootstrap section, or here if Task 1 is already merged)
- Test: `infra/linux/update.test.ts`

**Interfaces:**
- Usage: `sudo hp-update [--version <v> | --archive <path>] [--allow-downgrade] [--dry-run]`. `--version` defaults to latest.
- Flow:
  1. Resolve and fetch.
  2. `verify_release_archive`.
  3. Refuse if `<v>` equals the current version (exit 0, "already up to date"), or if it is older than current without `--allow-downgrade` (exit 2).
  4. `install_release`, remembering the previous version.
  5. Run the new release's `bootstrap-dedicated.sh` (idempotent: refreshes units, wrappers and the tmpfiles conf; never regenerates secrets). Then `systemctl daemon-reload`.
  6. `swap_current`.
  7. `systemctl restart hp-host-agent hp-docker-executor hp-api hp-web`. The API applies additive migrations at start. **Never** touch Docker containers, `docker.service` or the ingress proxy directly; the executor recreates the proxy only if its config changed (Task 2).
  8. Health check, the same as install step 12, with a 90 s timeout.
  9. On failure: `swap_current` back to the previous version, restart the same four services, re-check health, print "rolled back to <prev>", exit 6. A failed rollback health check prints both versions and exits 7.
  10. On success: `prune_releases <root> 3`, then print "updated <prev> → <v>".
- Health check and restart commands go through overridable variables (`HP_SYSTEMCTL=systemctl`, `HP_HEALTH_CMD=<default curl checks>`) so tests can stub them.

- [ ] **Step 1: Write failing tests** (temp `HP_ROOT` fixture with releases built from tiny fixture archives; `HP_SYSTEMCTL` points at a stub script that logs its args to a file; `HP_HEALTH_CMD` is a stub that exits 0 or 1):
  - `update swaps current and prunes on healthy restart`: current 0.1.0, update to 0.2.0 → `current` = 0.2.0; the systemctl log contains exactly `restart hp-host-agent hp-docker-executor hp-api hp-web` and no `docker`; exit 0.
  - `update rolls back when health check fails`: the health stub fails for 0.2.0 → `current` = 0.1.0; the log shows two restarts; exit 6.
  - `update refuses downgrade without flag`: current 0.2.0 → `--archive` of 0.1.0 exits 2, and `current` is unchanged.
  - `update is a no-op for the same version`: exit 0, no restart logged.
  - `update aborts on checksum mismatch before touching releases`: exit 4, no new release dir.
- [ ] **Step 2: Run them and confirm they fail.** Run `corepack pnpm exec vitest run infra/linux/update.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `update.sh`**, sourcing `lib/release.sh` from its own directory (`/opt/hosting-panel/current/infra/linux/lib/` when installed as `hp-update`; resolve through `readlink -f`).
- [ ] **Step 4: Run them and confirm they pass, plus the four checks.** Also run `bash -n`.
- [ ] **Step 5: Commit** `feat(infra): safe updater with health check and automatic rollback`.

---

### Task 8: Release workflow, docs and harness

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `README.md` (Italian; replace the "Primo avvio in produzione" section), `HARNESS.md`, `.agents/brain/state.md`, `.env.example` (comment pointing to the per-service env files for production), root `package.json` `version` → `0.2.0`
- Test: `apps/api/test/infra-layout.test.ts` (add a docs/workflow check)

**Interfaces:**
- `release.yml`: on `push` of tags `v*`, on `ubuntu-latest`.
  1. Check out, set up Node from `.node-version`, `corepack enable`, `pnpm install --frozen-lockfile`.
  2. Fail if the tag ≠ `v` + package.json version.
  3. Run `pnpm run lint typecheck test`, then `pnpm run release:build` and `pnpm run release:smoke <archive>`.
  4. Run `gh release create "$GITHUB_REF_NAME" <archive> <archive>.sha256 --title "$GITHUB_REF_NAME" --notes-file …` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` and `permissions: contents: write`.
  - No third-party actions beyond `actions/checkout` and `actions/setup-node` (already used in `ci.yml`).
- README "Installazione su un nuovo server" (replaces the old first-run block). Shows:
  1. Download and verify (one block):

     ```
     V=0.2.0
     curl -fsSLO https://github.com/lollinoo/hosting-panel/releases/download/v$V/hosting-panel-$V-linux-x64.tar.gz
     curl -fsSLO …tar.gz.sha256
     sha256sum -c hosting-panel-$V-linux-x64.tar.gz.sha256
     tar xzf …
     sudo bash hosting-panel-$V/infra/linux/install.sh --archive hosting-panel-$V-linux-x64.tar.gz --hostname … --admin-email … --admin-name "…"
     ```

  2. The DNS A record.
  3. TOTP enrolment.
  4. Backing up `/etc/hosting-panel`.
  5. `sudo hp-update` and what it does and doesn't restart.
  6. `sudo hp-accounts unlock|reset-password|reset-totp --email …`.
  7. `--acme-staging` for test servers.
- `HARNESS.md` project map: mention `infra/release/` and `infra/linux/{install.sh,update.sh,lib/release.sh}`.
- `state.md`: Step 1b status.

- [ ] **Step 1: Write the failing test** `release workflow and docs are consistent`:
  - `.github/workflows/release.yml` contains `tags:` with `v*`, `release:build`, `release:smoke` and `gh release create`.
  - `README.md` contains `install.sh`, `hp-update`, `sha256sum -c` and `hp-accounts`, and no longer contains `export DATABASE_URL=`.
  - Root `package.json` version is `0.2.0`.
- [ ] **Step 2: Run it and confirm it fails.**
- [ ] **Step 3: Write the workflow and docs; bump the version.** Also remove the old DATABASE_URL first-run message from `bootstrap-dedicated.sh`'s closing text (point to `install.sh` instead).
- [ ] **Step 4: Run it and confirm it passes, plus the four checks.**
- [ ] **Step 5: Commit** `feat(release): tag-driven GitHub release workflow and installation docs`.

---

### Task 9: Live acceptance on a fresh server (manual)

This task cannot run in CI. It needs fresh VMs with a public IP, a DNS name the owner controls, and SSH.
- Run the full checklist on **Ubuntu 26.04** and **Debian 13**, the newest of each family.
- Run Steps 1–4 on **Ubuntu 24.04** and **Debian 12**, as install-only checks.
- If Docker's repo still lacks Ubuntu 26.04 packages, record the installer's refusal message as the expected result for that OS and tell the owner. Whoever runs it (the owner, or an agent with SSH access the owner grants) records results in `docs/security/step-1b-acceptance-report.md`.

- [ ] **Step 1:** Build a release from the branch (`pnpm run release:build`) and copy the archive and `.sha256` to the VM.
- [ ] **Step 2:** Before creating the DNS record, run `install.sh --archive … --hostname <fqdn> --admin-email … --admin-name … --acme-staging`. Expected:
  - exit 0, and all 12 steps logged;
  - `https://<ip>` answers with a self-signed certificate and shows the login page;
  - the admin logs in with password + TOTP.
- [ ] **Step 3:** Create the A record and wait ≤ 5 minutes. Expected: `https://<fqdn>` serves a (staging) Let's Encrypt certificate with no manual step, and `http://<fqdn>` redirects to https.
- [ ] **Step 4:** Rerun the same `install.sh` command. Expected: exit 0; keys, `api.env` and `web.env` checksums are unchanged (`sha256sum /etc/hosting-panel/*`, before and after); no second admin.
- [ ] **Step 5:** As admin, create the customer account; log in as the customer in a private window; complete the forced password change.
- [ ] **Step 6:** Build a second release with version `0.2.1` and run `hp-update --archive …`. Expected: "updated 0.2.0 → 0.2.1", and an external `curl` loop against the panel login page shows only a short gap during the restart. Then sabotage: build `0.2.2` with a broken `apps/api/dist/main.js` (e.g. `throw` at the top) and run `hp-update`. Expected: exit 6, "rolled back to 0.2.1", panel working.
- [ ] **Step 7:** Check from outside that ports 3000 and 4000 are closed (`nc -vz <ip> 3000`, `nc -vz <ip> 4000` refused or filtered), and that 22/80/443 are open.
- [ ] **Step 8:** Write the report with timestamps and outputs, then commit `docs(security): step 1b live installation acceptance report`.

---

## Self-review notes

- **Spec section 5 coverage:**
  - Fresh server to working panel via one documented procedure: Tasks 6, 8.
  - Installs Docker, proxy, PostgreSQL and the panel: Tasks 6, 2.
  - Generates keys: Task 1 bootstrap, reused.
  - First administrator: Task 6, step 11.
  - Panel over HTTPS on its own hostname with Let's Encrypt and a self-signed IP fallback: Task 2 (+ Task 3 firewall).
  - Release archives, checksum-verified: Tasks 4, 5, 8.
  - Self-update that keeps sites serving and restarts only the Control Plane: Task 7.
  - Fresh installs only: honored (no legacy migration).
  - Loud key-backup notice: Task 6 summary.
- **Deferred, on purpose:**
  - Backing up the panel DB and keys to S3: spec step 3 (Backups).
  - The "Update panel" button in the admin UI: spec step 6. `hp-update` is the engine it will call.
  - Release signatures: `shortcut:` comment in Task 5.
  - Per-IP rate limiting at the proxy: step 6 or ops.
- **Known risk to verify live (Task 9):** container-to-host reachability on `host.docker.internal:3000` across the Docker bridge plus nftables, and Traefik ACME HTTP-01 on port 80 while site routes also use port 80.
