import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPlatformCapabilities, ERROR_CODES, MAIL_RELAY_IMAGE, OPERATION_KINDS } from "@hosting-panel/contracts";

const root = resolve(__dirname, "../../..");
const hasHost = existsSync("/sys/fs/cgroup/cgroup.controllers") && spawnSync("bash", ["-c", "command -v docker"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "hp-os-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function detect(id: string, codename: string) {
  const file = join(dir, `${id}-${codename}`);
  writeFileSync(file, `ID=${id}\nVERSION_CODENAME=${codename}\n`);
  return spawnSync(
    "bash",
    ["-c", `export HP_OS_RELEASE_FILE=${file}; source infra/linux/lib/os.sh; detect_supported_os`],
    { cwd: root, encoding: "utf8" }
  );
}

describe("supported OS matrix", () => {
  it.each([
    ["ubuntu", "noble"],
    ["ubuntu", "resolute"],
    ["debian", "bookworm"],
    ["debian", "trixie"]
  ])("accepts %s %s", (id, codename) => {
    const r = detect(id, codename);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`${id} ${codename}`);
  });

  it.each([
    ["ubuntu", "jammy"],
    ["debian", "bullseye"]
  ])("rejects %s %s with the supported list", (id, codename) => {
    const r = detect(id, codename);
    expect(r.status).not.toBe(0);
    for (const v of ["noble", "resolute", "bookworm", "trixie"]) expect(r.stderr).toContain(v);
  });

  it("honours HP_ALLOW_OTHER_LINUX", () => {
    const file = join(dir, "other");
    writeFileSync(file, "ID=arch\nVERSION_CODENAME=\n");
    const r = spawnSync(
      "bash",
      ["-c", `export HP_ALLOW_OTHER_LINUX=1 HP_OS_RELEASE_FILE=${file}; source infra/linux/lib/os.sh; detect_supported_os`],
      { cwd: root, encoding: "utf8" }
    );
    expect(r.status).toBe(0);
  });
});

describe("platform baselines", () => {
  it("node and traefik baselines", () => {
    expect(readFileSync(join(root, ".node-version"), "utf8").startsWith("26")).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).engines.node).toBe(">=26.0.0");
    expect(readFileSync(join(root, "apps/docker-executor/src/traefik-config.ts"), "utf8")).toContain('"traefik:v3.7"');
  });
});

describe("per-service env files and wrappers", () => {
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  const units = ["api", "web", "docker-executor", "host-agent"].map((n) => [n, read(`infra/systemd/hp-${n}.service`)] as const);
  const envFor: Record<string, string | undefined> = { api: "api.env", web: "web.env", "docker-executor": "executor.env" };

  it("each unit loads only its own env file", () => {
    for (const [n, text] of units) {
      const lines = text.split("\n").filter((l) => l.startsWith("EnvironmentFile="));
      const want = envFor[n];
      expect(lines).toEqual(want ? [`EnvironmentFile=/etc/hosting-panel/${want}`] : []);
      expect(text).not.toContain("hosting-panel.env");
    }
  });

  it("units run from the current symlink", () => {
    for (const [, text] of units) {
      const lines = text.split("\n").filter((l) => /^(ExecStart|WorkingDirectory)=/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        for (const p of l.split(/[= ]/).filter((t) => t.startsWith("/opt/"))) expect(p.startsWith("/opt/hosting-panel/current/")).toBe(true);
        expect(l).toContain("/opt/hosting-panel/current/");
      }
    }
  });

  it("web binds to HP_WEB_BIND_ADDRESS", () => {
    const web = read("infra/systemd/hp-web.service");
    expect(web).toContain("--hostname ${HP_WEB_BIND_ADDRESS}");
    // Never an empty placeholder: `next start --hostname ""` listens on all interfaces.
    expect(read("infra/linux/bootstrap-dedicated.sh")).toContain("HP_WEB_BIND_ADDRESS=127.0.0.1");
    expect(web).toMatch(/^After=.*docker\.service/m);
  });

  it("web counts the SIGTERM exit of next start as a clean stop", () => {
    // next start exits 143 (128 + SIGTERM) on every stop; without this the unit ends up "failed".
    const web = read("infra/systemd/hp-web.service");
    const service = web.slice(web.indexOf("[Service]"), web.indexOf("[Install]")).split("\n");
    expect(service.filter((l) => l.startsWith("SuccessExitStatus="))).toEqual(["SuccessExitStatus=143"]);
    expect(service).toContain("Restart=on-failure");
  });

  it.skipIf(!hasHost)("bootstrap dry-run lists the three env files with 0400", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["api.env", "web.env", "executor.env", "0400", "/usr/local/sbin/hp-accounts", "/usr/local/sbin/hp-update"]) expect(r.stdout).toContain(s);
    expect(r.stdout).not.toContain("hosting-panel.env");
  });

  it.skipIf(!hasHost)("bootstrap dry-run provisions the mariadb user, key and data dir", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["hp-mariadb", "mariadb-root.key", "0440", "/var/lib/hosting-panel/mariadb/data"]) expect(r.stdout).toContain(s);
  });

  it("tmpfiles creates the mail relay secret directory", () => {
    const lines = read("infra/systemd/hosting-panel-tmpfiles.conf").split("\n");
    expect(lines).toContain("d /run/hosting-panel/mail-relay 0755 hp-executor hp-executor -");
    expect(lines).toContain("d /run/hosting-panel 3770 root hp-ipc -");
    const boot = read("infra/linux/bootstrap-dedicated.sh");
    expect(boot).toContain("install -d -m 0755 -o hp-executor -g hp-executor /var/lib/hosting-panel/site-mail\n");
    // Five digits: GNU install keeps the setgid bit inherited from the 3770 parent with a plain 0755.
    expect(boot).toContain("install -d -m 00755 -o hp-executor -g hp-executor /run/hosting-panel/mail-relay\n");
  });

  it("tmpfiles creates the DNS provider credential directory", () => {
    expect(read("infra/systemd/hosting-panel-tmpfiles.conf").split("\n")).toContain("d /run/hosting-panel/acme-dns 0700 hp-executor hp-executor -");
    expect(read("infra/linux/bootstrap-dedicated.sh")).toContain("install -d -m 00700 -o hp-executor -g hp-executor /run/hosting-panel/acme-dns\n");
  });

  it.skipIf(!hasHost)("bootstrap dry-run creates the mail directories", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["/run/hosting-panel/mail-relay", "/var/lib/hosting-panel/site-mail"]) expect(r.stdout).toContain(s);
  });

  it.skipIf(!hasHost)("bootstrap dry-run provisions the backup encryption key", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["/etc/hosting-panel/backup.key", "0440 root:hp-executor"]) expect(r.stdout).toContain(s);
  });

  it("wrappers never put DATABASE_URL in argv", () => {
    for (const w of ["hp-accounts", "hp-break-glass"]) {
      const src = read(`infra/linux/${w}`);
      expect(src).toContain("runuser -u hp-api");
      expect(src).toContain("/usr/bin/node /opt/hosting-panel/current/");
      expect(src).not.toMatch(/node\s[^\n]*"\$DATABASE_URL"/);
    }
    const restore = read("infra/linux/hp-restore-panel");
    expect(restore).toContain('exec bash /opt/hosting-panel/current/infra/linux/restore-panel.sh "$@"');
    expect(restore).not.toContain("DATABASE_URL");
  });

  it.skipIf(!hasHost)("bootstrap dry-run creates the panel copy directory and the restore wrapper", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    for (const s of ["/var/lib/hosting-panel/panel-dump (2770 root:hp-ipc)", "/usr/local/sbin/hp-restore-panel (0750 root:root)"]) {
      expect(r.stdout).toContain(s);
    }
  });

  it("wrapper parses DATABASE_URL safely and keeps it out of argv", () => {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    // Fake runuser: report argv and the environment instead of switching user.
    writeFileSync(join(bin, "runuser"), '#!/usr/bin/env bash\necho "ARGV:$*"\necho "ENV:$DATABASE_URL"\n', { mode: 0o755 });
    const f = join(dir, "api.env");
    const url = "postgres://u:p=a&b@127.0.0.1:5432/db?sslmode=disable&x=1";
    writeFileSync(f, `ENABLE_DEV_OIDC=false\nDATABASE_URL=${url}\n`);
    const r = spawnSync("bash", [join(root, "infra/linux/hp-accounts"), "setup"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HP_API_ENV_FILE: f }
    });
    expect(r.stdout).toContain(`ENV:${url}`);
    expect(r.stdout.split("\n")[0]).not.toContain("postgres://");
    expect(r.stdout.split("\n")[0]).toContain("dist/cli/accounts.js setup");
  });
});

describe("release workflow and docs", () => {
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  it("release workflow and docs are consistent", () => {
    // devflow publishes a draft release tagged v<version>; the archive job attaches the build and publishes it.
    const config = read(".devflow/config");
    for (const s of ["RELEASE_TAG='v{version}'", "RELEASE_DRAFT=true"]) expect(config).toContain(s);
    const wf = read(".github/workflows/devflow-release.yml");
    for (const s of ["release-main.sh", "build_sha", "release:build", "release:smoke", "gh release upload", "--draft=false --latest"]) {
      expect(wf).toContain(s);
    }
    const readme = read("README.md");
    for (const s of ["install.sh", "hp-update", "sha256sum -c", "hp-accounts"]) expect(readme).toContain(s);
    expect(readme).not.toContain("export DATABASE_URL=");
    expect(JSON.parse(read("package.json")).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("step 2a docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["WordPress", "mariadb-root.key", "2 GB"]) expect(readme).toContain(s);
    const api = read("docs/api/openapi.yaml");
    for (const s of ["/v1/organizations/{orgId}/managed-sites", "/v1/admin/sites"]) expect(api).toContain(s);
    expect(existsSync(join(root, "docs/architecture/adr/0016-shared-mariadb-and-site-jobs.md"))).toBe(true);
    expect(JSON.parse(read("package.json")).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("step 2b docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["Domini e HTTPS", "acme-staging", "HSTS"]) expect(readme).toContain(s);
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/domains",
      "/v1/admin/sites/{siteId}/domains"
    ])
      expect(api).toContain(s);
    expect(existsSync(join(root, "docs/architecture/adr/0017-domains-dns-and-acme-tls.md"))).toBe(true);
    expect(JSON.parse(read("package.json")).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("step 2c docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["Email in uscita", "587"]) expect(readme).toContain(s);
    expect(read("docs/api/openapi.yaml")).toContain("/v1/admin/mail-relay");
    const adr = read("docs/architecture/adr/0018-outgoing-mail-relay.md");
    for (const s of ["CP-01", "postqueue"]) expect(adr).toContain(s);
    expect(JSON.parse(read("package.json")).version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(MAIL_RELAY_IMAGE).toBe("boky/postfix:5.2.1-alpine");
  });

  it("m5 dns-01 docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["DNS-01", "docs/architecture/adr/0030-dns-01-certificates.md"]) expect(readme).toContain(s);
    const api = read("docs/api/openapi.yaml");
    for (const s of ["/v1/admin/dns-provider", "DnsProviderSettingsDto", "dns_provider"]) expect(api).toContain(s);
    const adr = read("docs/architecture/adr/0030-dns-01-certificates.md");
    for (const s of ["CP-01", "le-dns", "_FILE"]) expect(adr).toContain(s);
    // Every repo path the ADR writes in backticks exists (a trailing :line is dropped).
    const paths = [...adr.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, ""));
    expect(paths.length).toBeGreaterThanOrEqual(5);
    for (const p of paths) expect(existsSync(join(root, p)), p).toBe(true);
    const harness = read("HARNESS.md");
    for (const s of ["0030", "accept-acme-pebble.mjs"]) expect(harness).toContain(s);
  });

  it("hcp-spec-004 ADRs are consistent", () => {
    const adrs = [
      { file: "docs/architecture/adr/0031-manual-tls-certificates.md", tokens: ["CP-01", "manual-certs", "PEM", "checkHost"] },
      { file: "docs/architecture/adr/0032-backup-targets.md", tokens: ["HP_BACKUP_LOCAL_ROOT", "legacy_settings", "partial", "backup.key"] }
    ];
    for (const { file, tokens } of adrs) {
      expect(existsSync(join(root, file)), file).toBe(true);
      const adr = read(file);
      for (const header of ["Stato", "Riferimento", "Migrazioni"]) expect(adr, `${file} ${header}`).toMatch(new RegExp(`^- \\*\\*${header}:\\*\\*`, "m"));
      for (const s of tokens) expect(adr, `${file} ${s}`).toContain(s);
      // Every repo path the ADR writes in backticks exists (a trailing :line is dropped); at least 8 are cited.
      const paths = [...adr.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, ""));
      expect(paths.length, file).toBeGreaterThanOrEqual(8);
      for (const p of paths) expect(existsSync(join(root, p)), `${file}: ${p}`).toBe(true);
    }
  });

  it("hcp-spec-004 docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["ADR-0031", "ADR-0032", "HP_BACKUP_LOCAL_ROOT", "hp-restore-panel --local-repo", "--allow-feature-loss", "hp-restore-panel --endpoint"]) {
      expect(readme, `README ${s}`).toContain(s);
    }
    const harness = read("HARNESS.md");
    for (const s of ["0032", "0022_backup_targets_and_copies.sql", "accept-tls-manual.mjs", "accept-backup-local.mjs"]) expect(harness, `HARNESS ${s}`).toContain(s);
    const runbook = read("docs/runbooks/tls-and-backup-targets.md");
    for (let n = 1; n <= 10; n++) expect(runbook, `runbook heading ${n}.`).toMatch(new RegExp(`^## ${n}\\. `, "m"));
    const api = read("docs/api/openapi.yaml");
    for (const s of ["/v1/admin/backup-targets", "tls-certificates"]) expect(api, `openapi ${s}`).toContain(s);

    // The acceptance report: exactly one row per id, an allowed verdict, and a command and SHA on every PASS row.
    const report = read("docs/security/hcp-spec-004-acceptance-report.md");
    const ids = [
      ...Array.from({ length: 14 }, (_, i) => `TLS-${String(i + 1).padStart(2, "0")}`),
      ...Array.from({ length: 20 }, (_, i) => `BKP-${String(i + 1).padStart(2, "0")}`)
    ];
    const rows = report
      .split("\n")
      .filter((line) => line.trimStart().startsWith("|"))
      .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()))
      .filter((cells) => /^(TLS|BKP)-\d{2}$/.test((cells[0] ?? "").replace(/[`*]/g, "")));
    const verdict = /^(PASS|FAIL|SKIPPED \(.+\)|PENDING \(owner: .+\)|BLOCKED \(BLOCKED\.md #\d+\))$/;
    for (const id of ids) {
      const mine = rows.filter((cells) => cells[0]!.replace(/[`*]/g, "") === id);
      expect(mine.length, `acceptance report rows for ${id}`).toBe(1);
      const cells = mine[0]!;
      const v = (cells[2] ?? "").replace(/\*/g, "");
      expect(v, `${id} verdict`).toMatch(verdict);
      if (v === "PASS") {
        expect((cells[3] ?? "").replace(/`/g, "").trim().length, `${id} command`).toBeGreaterThan(0);
        expect(cells[5] ?? "", `${id} SHA`).toMatch(/[0-9a-f]{7,40}/);
      }
    }
    expect(rows.length, "acceptance report has no extra id rows").toBe(ids.length);

    // Both ADRs are as built and cite at least 15 repo paths that exist.
    for (const file of ["docs/architecture/adr/0031-manual-tls-certificates.md", "docs/architecture/adr/0032-backup-targets.md"]) {
      const adr = read(file);
      expect(adr, `${file} Stato`).toMatch(/^- \*\*Stato:\*\* `APPROVATO`/m);
      const paths = new Set([...adr.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, "")));
      expect(paths.size, file).toBeGreaterThanOrEqual(15);
      for (const p of paths) expect(existsSync(join(root, p)), `${file}: ${p}`).toBe(true);
    }
  });

  it("hcp-spec-004 manual tls acceptance script is registered and machine-safe", () => {
    const script = read("infra/linux/accept-tls-manual.mjs");
    const helper = read("infra/linux/tls-test-certs.mjs");
    // Same pinned Traefik and Pebble downloads as accept-acme-pebble.mjs (sha256 pins, 3.7.19).
    const pebble = read("infra/linux/accept-acme-pebble.mjs");
    for (const pin of [/TRAEFIK_SHA256 = "([0-9a-f]{64})"/, /pebble: "([0-9a-f]{64})"/, /minica: "([0-9a-f]{64})"/]) {
      expect(script.match(pin)?.[1], String(pin)).toBeDefined();
      expect(script.match(pin)?.[1]).toBe(pebble.match(pin)?.[1]);
    }
    expect(script).toContain("traefik_v3.7.19_linux_amd64.tar.gz");
    // Drives the shipped executor modules and the contracts plan, not a copy of them.
    for (const s of ["ManualTlsStore", "readAcmeStoreEntries", "evictAcmeEntries", "waitForServed", "planManualCertificates", "buildIngressProxyContainerPayload"]) {
      expect(script, s).toContain(s);
    }
    // Machine safety: loopback only, own prefix, high ports, never the host's hp_ingress_proxy, no shell.
    expect(script).toContain("hp_swarmtest_tls_");
    expect(script).toContain('const HOST = "127.0.0.1"');
    expect(script).not.toMatch(/0\.0\.0\.0|shell:\s*true|\bexec\(|execSync|spawnSync/);
    expect(script).not.toMatch(/["'`]hp_ingress_proxy["'`]/);
    expect([...script.matchAll(/\b(1[0-9]{4})\b/g)].map((m) => Number(m[1])).filter((p) => p >= 10000 && p < 16000)).toEqual([]);
    // The steps of arch-tls-ingress 4.3 and the TLS-xx rows of the test matrix.
    for (const stepName of [
      "tls05-plan-says-eviction", "tls05-hot-superset", "tls05-cold-evict", "tls07-wildcard-exact", "wildcard-sibling-renews",
      "capture-refused", "tls08-rotation-under-load", "bad-entry-not-fatal", "tls10-restart-x5", "tls09-crash-recovery",
      "tls06-back-to-acme", "tls06-refused-under-wildcard", "gc-after-verify", "container-serves-manual-0700", "inspect-no-secrets",
    ]) {
      expect(script, stepName).toContain(`"${stepName}"`);
    }
    // The DER helper is node-only (no openssl, no dependency) and covers CN-not-in-SAN and a three-level chain.
    expect([...helper.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1])).toEqual(["node:crypto"]);
    expect(helper).toMatch(/export function makeCert/);
    expect(helper).toMatch(/export function makeChain/);
    expect(helper).not.toMatch(/openssl|child_process/);
  });

  it("hcp-spec-004 production-adapter tls acceptance script is registered and machine-safe", () => {
    const script = read("infra/linux/accept-tls-adapter.mjs");
    // Drives the production adapter from dist, through the proxy/network name seam, not a replay of its pieces.
    for (const s of ["DockerEngineSocketAdapter", "ensureIngressProxy", "ingressProxyContainerName", "ingressNetworkName", "evictAcme", "acme_eviction_required", "not_served_reverted", "680febb"]) {
      expect(script, s).toContain(s);
    }
    // Machine safety: own prefix, loopback ports only (the gate rewrites HostIp), gated Docker socket, no shell,
    // and never the host's hp_ingress_proxy or hp_ingress_net by name.
    expect(script).toContain("hp_swarmtest_adp_");
    expect(script).toContain('const HOST = "127.0.0.1"');
    expect(script).toContain("site_(edge|internal)");
    expect(script).not.toMatch(/shell:\s*true|\bexec\(|execSync|spawnSync/);
    // 0.0.0.0 appears only where the gate maps the payload's HostIp back (comments aside).
    for (const line of script.split("\n").filter((l) => l.includes("0.0.0.0") && !/^\s*(\*|\/\/|\/\*)/.test(l))) expect(line).toContain('"HostIp"');
    expect(script).not.toMatch(/["'`]hp_ingress_(proxy|net)["'`]/);
    expect([...script.matchAll(/\b(1[0-9]{4})\b/g)].map((m) => Number(m[1])).filter((p) => p >= 10000 && p < 16000)).toEqual([]);
    for (const stepName of [
      "setup-proxy-through-ensure", "publish-on-fresh-empty-acme-store", "rotation-under-load", "executor-restart-recovers",
      "setup-legacy-payload-proxy", "upgrade-no-recreate", "cold-path-refused-hot", "cold-path-evicts-with-backup",
      "cold-path-failed-probe-restores", "gate-clean",
    ]) {
      expect(script, stepName).toContain(`"${stepName}"`);
    }
    // A step that cannot run is reported in the RESULT line, not passed silently (both acceptance scripts).
    for (const file of ["infra/linux/accept-tls-adapter.mjs", "infra/linux/accept-tls-manual.mjs"]) {
      expect(read(file), file).toMatch(/skipped \(not counted in n\/m\)/);
    }
  });

  it("m1a file manager docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["Web File Manager dei Siti", "ADR-0019"]) {
      expect(readme).toContain(s);
    }
    expect(readme).not.toContain("sftpAvailable: false");
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/files",
      "/files/content",
      "/files/folders",
      "/files/move",
      "/files/delete",
      "/files/archive",
      "/files/extract",
      "ALREADY_EXISTS",
      "site.files.archive",
      "site.files.extract",
      "site.files.read",
      "site.files.write",
    ]) {
      expect(api).toContain(s);
    }
    const adr = read("docs/architecture/adr/0019-site-file-manager.md");
    for (const s of ["hp_files_", "512 KiB", "2 GiB", "site.files.archive"]) {
      expect(adr).toContain(s);
    }
    expect(JSON.parse(read("package.json")).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("m1b site sftp docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["Accesso SFTP per Sito", "sftpAvailable: true", "ADR-0020"]) {
      expect(readme).toContain(s);
    }
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/sftp:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/sftp/users:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/sftp/users/{userId}/reset-password:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/sftp/users/{userId}:",
      "site.sftp.manage",
      "CreateSiteSftpUserRequest",
      "SiteSftpDto",
      "SiteSftpUserCreatedDto",
      "SiteSftpPasswordResetDto",
    ]) {
      expect(api).toContain(s);
    }
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/refresh:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/updates:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/administrators/{userId}/password-reset:",
      "SiteWordpressDto:",
      "wordpressToolsAvailable",
      "site.wordpress.update",
      "pre_update",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/import:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/import/files:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/import/files/{slot}:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/wordpress/import/files/{slot}/pick:",
      "SiteWordpressImportDto:",
      "SiteWordpressLastImportDto:",
      "site.wordpress.import",
      "import_running",
      "files_incomplete",
      "undo_incomplete",
    ]) {
      expect(api).toContain(s);
    }
    const adr = read("docs/architecture/adr/0020-site-sftp.md");
    for (const s of ["hp_sftp", "2222", "site.sftp.manage", "/var/lib/hosting-panel/sftp"]) {
      expect(adr).toContain(s);
    }
    expect(JSON.parse(read("package.json")).version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("m2 site databases and phpmyadmin docs are consistent", () => {
    const readme = read("README.md");
    for (const s of [
      "Database per Sito & phpMyAdmin",
      "phpMyAdminAvailable: true",
      "ADR-0021",
      "docs/architecture/adr/0021-site-databases.md",
    ]) {
      expect(readme).toContain(s);
    }
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/databases:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/databases/phpmyadmin:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/databases/{name}:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/database-users:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/database-users/{name}:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/database-users/{name}/reset-password:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/database-users/{name}/grants/{database}:",
      "site.databases.manage",
      "phpMyAdminAvailable",
      "CreateSiteDatabaseRequest",
      "CreateSiteDatabaseUserRequest",
      "SiteDatabaseDto",
      "SiteDatabaseUserDto",
      "SiteDatabasesDto",
      "SiteDatabaseCreatedDto",
      "SiteDatabaseUserCreatedDto",
      "SiteDatabasePasswordResetDto",
      "SiteDatabaseSignOnDto",
    ]) {
      expect(api).toContain(s);
    }
    const adr = read("docs/architecture/adr/0021-site-databases.md");
    for (const s of [
      "ADR 0021",
      "hp_mariadb",
      "hp_phpmyadmin",
      "127.0.0.1",
      "8306",
      "site.databases.manage",
      "phpMyAdminAvailable",
      "/var/lib/hosting-panel/phpmyadmin",
      "CP-01",
    ]) {
      expect(adr).toContain(s);
    }
    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain(
      "install -d -m 0755 -o hp-executor -g hp-executor /var/lib/hosting-panel/phpmyadmin",
    );
    const envExample = read(".env.example");
    expect(envExample).toContain("HP_PHPMYADMIN_PORT=8306");
  });

  it("m3a backups docs are consistent", () => {
    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/admin/backups:",
      "/v1/admin/backups/test:",
      "/v1/admin/backups/sites:",
      "/v1/admin/backups/sites/{siteId}/run:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/backups:",
      "BackupProblem",
      "BackupSettingsInput",
      "BackupTestResult",
      "BackupSettings",
      "SiteBackup",
      "SiteBackups",
      "AdminSiteBackupStatus",
      "SiteBackupAccepted",
      "site.backups.create",
      "site.backups.prune",
    ]) {
      expect(api).toContain(s);
    }
    expect(api).not.toMatch(
      /productionBackupRuntimeAvailable:\s*\n\s*type:\s*boolean\s*\n\s*(?:const:\s*false|enum:\s*\[false\])/,
    );
  });

  it("m3 site backups docs are consistent", () => {
    const readme = read("README.md");
    for (const s of [
      "Backup dei Siti",
      "productionBackupRuntimeAvailable: true",
      "ADR-0022",
      "docs/architecture/adr/0022-site-backups.md",
      "backup.key",
    ]) {
      expect(readme).toContain(s);
    }
    expect(readme).not.toContain("productionBackupRuntimeAvailable: false");
    expect(readme).not.toContain("HCP-SPEC-005");

    const adr = read("docs/architecture/adr/0022-site-backups.md");
    for (const s of [
      "ADR 0022",
      "restic/restic:0.19.1",
      "/etc/hosting-panel/backup.key",
      "site.backups.manage",
      "productionBackupRuntimeAvailable",
      "CP-01",
      "0009_backups.sql",
    ]) {
      expect(adr).toContain(s);
    }

    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain('BACKUP_KEY_PATH="/etc/hosting-panel/backup.key"');
    expect(bootstrap).toContain('chown root:hp-executor "${BACKUP_KEY_PATH}"');

    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/admin/backups:",
      "/v1/admin/backups/test:",
      "/v1/admin/backups/sites:",
      "/v1/admin/backups/sites/{siteId}/run:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/backups:",
      "BackupProblem",
      "BackupSettingsInput",
      "BackupTestResult",
      "BackupSettings",
      "SiteBackup",
      "SiteBackups",
      "AdminSiteBackupStatus",
      "SiteBackupAccepted",
      "site.backups.create",
      "site.backups.prune",
    ]) {
      expect(api).toContain(s);
    }
  });

  it("hcp-spec-004 bootstrap provisions the manual certificate directory", () => {
    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain(
      "install -d -m 0700 -o hp-executor -g hp-executor /var/lib/hosting-panel/ingress/dynamic/manual-certs\n",
    );
    // Cold-start hazard: anything below dynamic/ the proxy uid cannot read takes every site down.
    const dynamicDirs = bootstrap
      .split("\n")
      .filter((l) => l.startsWith("install -d ") && l.includes("/var/lib/hosting-panel/ingress/dynamic/"));
    expect(dynamicDirs.length).toBeGreaterThan(0);
    for (const l of dynamicDirs) {
      expect(l).toMatch(/^install -d -m 0700 -o hp-executor -g hp-executor \/var\/lib\/hosting-panel\/ingress\/dynamic\/\S+$/);
    }
  });

  it.skipIf(!hasHost)("hcp-spec-004 bootstrap dry-run mentions the manual certificate directory", () => {
    const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ingress/dynamic/manual-certs (0700 hp-executor:hp-executor)");
  });

  it("hcp-spec-004 the executor knows the local backup root", () => {
    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain(
      "install -d -m 2770 -o hp-executor -g hp-executor /var/lib/hosting-panel/local-repos\nchmod 2770 /var/lib/hosting-panel/local-repos\n",
    );
    // RestrictSUIDSGID=yes stays; it is why the root carries the setgid bit instead of the executor asking for it.
    expect(read("infra/systemd/hp-docker-executor.service")).toContain("\nRestrictSUIDSGID=yes\n");
    const unit = read("infra/systemd/hp-docker-executor.service");
    expect(unit).toContain("\nEnvironment=HP_BACKUP_LOCAL_ROOT=/var/lib/hosting-panel/local-repos\n");
    expect(unit).toContain("\nReadWritePaths=/var/lib/hosting-panel /run/hosting-panel\n");
    expect(unit).not.toContain("RequiresMountsFor");
  });

  it("hcp-spec-004 local backup acceptance script is registered and machine-safe", () => {
    const script = read("infra/linux/accept-backup-local.mjs");
    const s3Script = read("infra/linux/accept-m3-backups.mjs");
    // Same pinned RustFS as the S3 acceptance script (the legacy-coexistence step).
    const rustfs = /const RUSTFS_IMAGE =\s*"(rustfs\/rustfs:[^"]+)"/;
    expect(script.match(rustfs)?.[1]).toBeDefined();
    expect(script.match(rustfs)?.[1]).toBe(s3Script.match(rustfs)?.[1]);
    // Drives the built executor with a temporary local root and the shipped CLI, not a copy of them.
    for (const s of ["DockerEngineSocketAdapter", "backupLocalRoot", "localInit", "fetchPanelCopy", "local_repo", "panel-fetch.js", "backup-repo.json", "backup-upload.json"]) {
      expect(script, s).toContain(s);
    }
    // Machine safety: own prefix, no published port, nothing pulled or pruned, no shell, never the host's own objects.
    expect(script).toContain("hp_swarmtest_");
    expect(script).toContain("pullMissingImages: false");
    expect(script).not.toMatch(/PortBindings\s*:|["']-p["']|["']--publish["']/);
    expect(script).not.toMatch(/["'](?:prune|pull|system)["']/);
    expect(script).not.toMatch(/shell:\s*true|(?<![.\w])exec\(|execSync|spawnSync/);
    expect(script).not.toMatch(/["'`]hp_(?:ingress_proxy|ingress_net|mariadb)["'`]/);
    expect(script).toMatch(/mkdtemp\(path\.join\(os\.tmpdir\(\)/);
    // The cases that need root are gated and reported as skipped with a reason, never passed silently.
    expect(script).toContain("HP_ACCEPT_ROOT_CASES");
    expect(script).toMatch(/skipped \(not counted in n\/m\)/);
    for (const stepName of [
      "local-init-and-test", "local-backup-manual", "local-repo-ciphertext-only", "local-modes-and-users", "local-hostile",
      "local-readonly-and-no-space", "local-restore", "local-export-zip", "panel-local-and-dr", "legacy-s3-coexists", "two-copies-both-succeed",
      "two-copies-second-fails-partial", "forget-per-target", "zip-age-blocked", "no-secrets",
    ]) {
      expect(script, stepName).toContain(`"${stepName}"`);
    }
    // BKP-07/08/09: the second copy is op_x-t2, forgets are per target, and the refusal reason is pinned.
    for (const s of ["-t2", "-forget-t2", "local_target_unmounted", "isEncryptedBackupExportAvailable", "BLOCKED.md #4"]) {
      expect(script, s).toContain(s);
    }
  });

  it("application-stack engine acceptance script is registered and machine-safe", () => {
    const file = "infra/linux/accept-app-stack-engine.mjs";
    const script = read(file);
    for (const s of ["DockerEngineSocketAdapter", "hp_swarmtest_", "@sha256:", "appImageAllowlist", "pullMissingImages: false",
      "/dev/shm/", "HP_ACCEPT_ROOT_CASES", "snapshot-before", "gate-clean", "nothing-left"]) expect(script, s).toContain(s);
    for (const step of ["refuse-unpinned-image-before-docker", "refuse-over-ceiling-before-docker", "refuse-tampered-plan-before-docker",
      "apply-stack-a", "container-hardening", "secrets-only-as-files", "dns-between-components", "host-probe-reaches-internal-bridge",
      "idempotent-reapply", "status-reads-only", "no-cross-stack-reachability", "logs-masked", "network-shape-covered-by-metadata-drop",
      "internal-component-has-no-default-route", "no-docker-socket-in-components", "refuse-foreign-namespace",
      "remove-keeps-volumes", "reapply-reuses-volume-data", "remove-with-volumes", "foreign-untouched"]) expect(script, step).toContain(`"${step}"`);
    expect(script).not.toMatch(/shell:\s*true|(?<![.\w])exec\(|execSync|spawnSync/);
    expect(script).not.toMatch(/["'`]hp_(?:ingress_proxy|ingress_net|mariadb|phpmyadmin)["'`]/);
    expect(script).not.toMatch(/["'](?:prune|system)["']/);
    expect(script).not.toMatch(/PortBindings\s*:|["']-p["']|["']--publish["']|0\.0\.0\.0|:latest\b|publishAppStackRoutes/);
    expect([...script.matchAll(/\b(1[0-9]{4})\b/g)].map((m) => Number(m[1])).filter((p) => p >= 10000 && p < 16000)).toEqual([]);
    expect(script).toMatch(/skipped \(not counted in n\/m\)/);
    expect(read("HARNESS.md")).toContain("accept-app-stack-engine.mjs");
  });

  it("m3b restore and download docs are consistent", () => {
    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain(
      "install -d -m 0700 -o hp-executor -g hp-executor /var/lib/hosting-panel/backups\n",
    );
    if (hasHost) {
      const r = spawnSync("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("/var/lib/hosting-panel/backups");
    }

    expect(read("infra/systemd/hp-docker-executor.service")).toContain(
      "ReadWritePaths=/var/lib/hosting-panel",
    );
    expect(read("infra/linux/run-dev-docker.mjs")).toContain("HP_BACKUP_WORK_DIR");

    const api = read("docs/api/openapi.yaml");
    for (const s of [
      "/v1/organizations/{orgId}/managed-sites/{siteId}/backups/{backupId}/restore:",
      "/v1/organizations/{orgId}/managed-sites/{siteId}/backups/{backupId}/download:",
      "RestoreBackupInput",
      "BackupArchive",
      "BackupLastRestore",
      "BackupArchiveChunk",
      "site.backups.restore",
      "site.backups.download",
      "address_not_updated",
      "undo_incomplete",
      "QUOTA_EXCEEDED",
      "/v1/admin/backups/sites/{siteId}/restore:",
      "AdminRestoreBackupInput",
      "PanelBackupLine",
      "panel.backups.create",
      "panel_dump_failed",
      "site_not_started",
    ]) {
      expect(api).toContain(s);
    }

    const getDownloadBlock = api.slice(
      api.indexOf("operationId: readSiteBackupArchiveChunk"),
      api.indexOf("\ncomponents:"),
    );
    for (const statusCode of ['"422":', '"502":', '"503":']) {
      expect(getDownloadBlock).toContain(statusCode);
    }

    const adr = read("docs/architecture/adr/0022-site-backups.md");
    expect(adr).toContain("0010_backup_restore.sql");
    expect(adr).toContain("APPROVATO — M3a, M3b");
    expect(adr).not.toContain("presa in carico di un repository esistente");

    const readme = read("README.md");
    expect(readme).not.toContain("arrivano con la milestone successiva (**M3b**)");
  });

  it("m3c panel copy docs are consistent", () => {
    const dumpDir = "/var/lib/hosting-panel/panel-dump";
    const bootstrap = read("infra/linux/bootstrap-dedicated.sh");
    expect(bootstrap).toContain(`install -d -m 2770 -o root -g hp-ipc ${dumpDir}\nchmod 2770 ${dumpDir}\n`);
    expect(bootstrap).toContain(
      'install -m 0750 -o root -g root "${SCRIPT_DIR}/hp-restore-panel" /usr/local/sbin/hp-restore-panel\n',
    );
    for (const unit of ["hp-api", "hp-docker-executor"]) {
      expect(read(`infra/systemd/${unit}.service`)).toContain(`Environment=HP_PANEL_DUMP_DIR=${dumpDir}\n`);
    }
    expect(read("infra/systemd/hp-api.service")).toContain(`ReadWritePaths=/run/hosting-panel ${dumpDir}\n`);
    expect(read("infra/linux/run-dev-docker.mjs")).toContain("HP_PANEL_DUMP_DIR");

    const adr = read("docs/architecture/adr/0022-site-backups.md");
    for (const s of ["APPROVATO — M3a, M3b, M3c", "0011_panel_backup.sql", "hp-restore-panel", "panel_dump_tool_missing"]) {
      expect(adr).toContain(s);
    }
    expect(adr).not.toContain("(arriva in **M3c**)");

    const readme = read("README.md");
    expect(readme).toContain("hp-restore-panel --endpoint");
    expect(readme).not.toContain("Limite attuale (M3b → M3c)");
  });

  it("m5d host docs are consistent", () => {
    const readme = read("README.md");
    expect(readme).toContain("docs/architecture/adr/0028-host-firewall-and-updates.md");
    expect(readme).not.toContain("I log dei quattro servizi del pannello non sono in questa pagina");
    expect(readme).not.toContain("journalctl -u hp-api -u hp-web");

    const adr27 = read("docs/architecture/adr/0027-restart-and-terminal.md");
    const limit25 = adr27.slice(adr27.indexOf("\n25. "), adr27.indexOf("\n26. "));
    expect(limit25).toContain("pagina **Log**");
    expect(limit25).toContain("Esecutore (hp-docker-executor)");
    expect(limit25).not.toContain("non i servizi del server");

    // Every route the three M5d controllers serve is in openapi.yaml under its method.
    const api = read("docs/api/openapi.yaml");
    const routes: string[] = [];
    for (const file of ["admin-firewall", "admin-host", "admin-updates"]) {
      const code = read(`apps/api/src/controllers/${file}.controller.ts`);
      const prefix = code.match(/@Controller\("([^"]*)"\)/)![1]!;
      for (const [, method, sub] of code.matchAll(/@(Get|Post|Delete)\("([^"]*)"\)/g)) {
        const path = `/${prefix}${sub ? `/${sub}` : ""}`.replace(/:(\w+)/g, "{$1}");
        const start = api.indexOf(`\n  ${path}:\n`);
        expect(start, path).toBeGreaterThan(0);
        const block = api.slice(start + 1, start + 1 + api.slice(start + 1).search(/\n {2}\S/));
        expect(block, `${method} ${path}`).toContain(`\n    ${method!.toLowerCase()}:\n`);
        routes.push(path);
      }
    }
    expect(routes).toHaveLength(14);
    for (const s of ["FIREWALL_BASE_RULES_NOT_CURRENT", "HOST_JOB_FAILED", "- host.job", "- panel.container.apply", "hostServices:", "hp-os-upgrade]"]) {
      expect(api).toContain(s);
    }

    const harness = read("HARNESS.md");
    for (const unit of ["hp-unit-restart@", "hp-panel-update", "hp-os-refresh", "hp-os-upgrade"]) {
      expect(harness).toContain(unit);
    }
  });

  it("m6a site-type docs are consistent", () => {
    const readme = read("README.md");
    expect(readme).toContain("docs/architecture/adr/0029-site-types.md");
    expect(readme).not.toContain("Una versione più nuova data all'installer è un aggiornamento senza");

    // Every repo path the ADR writes in backticks exists (a trailing :line is dropped).
    const adr = read("docs/architecture/adr/0029-site-types.md");
    const paths = [...adr.matchAll(/`((?:apps|packages|infra|docs|\.github)\/[^`\s]+)`/g)].map((m) => m[1]!.replace(/:[\d,-]+$/, ""));
    expect(paths.length).toBeGreaterThan(20);
    for (const p of paths) expect(existsSync(join(root, p)), p).toBe(true);

    // R206 C6: the paths the repair's lines name are in the ADR and exist; CreateForm is gone.
    for (const p of [
      "apps/docker-executor/test/site-type-edge-qa.test.ts",
      "apps/docker-executor/src/site-files-helper.ts",
      "apps/docker-executor/src/site-mail.ts",
      "apps/api/src/host/host-jobs.ts",
      "apps/web/src/lib/file-browser.ts",
      "packages/contracts/src/site-databases.ts",
      "apps/api/src/sites/site-domains-applier.ts",
      "apps/api/src/runtime/site-provisioner.ts",
      "apps/api/src/sites/site-wordpress-import-applier.ts",
      "apps/docker-executor/src/terminal-docker.ts",
      "apps/docker-executor/src/sftp-platform.ts"
    ]) {
      expect(paths, p).toContain(p);
    }
    expect(adr).toContain("restore.filesImage");
    expect(adr).not.toContain("CreateForm");

    expect(read("HARNESS.md")).toContain("pinned by tag, not by digest");
  });

  // Text between two anchors; the end anchor is optional.
  const between = (text: string, from: string, to?: string) => {
    const start = text.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    const end = to === undefined ? -1 : text.indexOf(to, start + from.length);
    return text.slice(start, end < 0 ? undefined : end);
  };

  it("m6b the capability table of the README agrees with the flags", () => {
    // Both daemons up, as on an installed server.
    const caps = createPlatformCapabilities({
      runtimeBackend: "linux-systemd",
      dockerExecutorRuntimeAvailable: true,
      hostAgentRuntimeAvailable: true,
    }) as unknown as Record<string, unknown>;
    const table = between(read("README.md"), "## 2. Stato di Implementazione", "## 3. Mappa del Monorepo");
    let checked = 0;
    for (const row of table.split("\n").filter((l) => l.startsWith("|"))) {
      for (const m of row.matchAll(/`(\w+): (true|false)`/g)) {
        expect(caps, row).toHaveProperty(m[1]!);
        expect(caps[m[1]!], row).toBe(m[2] === "true");
        checked += 1;
      }
      if (row.includes("✅")) expect(row).not.toContain("sharedHostingEnabled");
    }
    expect(caps.sharedHostingEnabled).toBe(false);
    expect(checked).toBeGreaterThanOrEqual(5);
  });

  it("m6b the README names the release it ships", () => {
    const { version } = JSON.parse(read("package.json")) as { version: string };
    const readme = read("README.md");
    expect(readme).toContain(`V=${version}\n`);
    expect(readme).toContain(`hp-update --version ${version} `);
  });

  it("m6b the API description knows every operation kind and error code", () => {
    const spec = read("docs/api/openapi.yaml");
    // A schema ends where the next one at the same indent starts.
    const schema = (name: string) => {
      const block = between(spec, `\n    ${name}:\n`);
      const next = block.slice(1).search(/\n {4}\S/);
      return (next < 0 ? block : block.slice(0, next + 1)).split("\n").map((l) => l.trim());
    };
    const errors = schema("ApiErrorBody");
    for (const code of ERROR_CODES) expect(errors, code).toContain(`- ${code}`);
    const operation = schema("OperationDto");
    for (const kind of OPERATION_KINDS) expect(operation, kind).toContain(`- ${kind}`);
  });

  it("m6b the README access recovery names the emergency token and its reason", () => {
    const recovery = between(read("README.md"), "#### Recupero accessi", "\n#### ");
    expect(recovery).toContain("emergency-token");
    expect(recovery).toContain("--reason");
  });

  it("m6b the README update part names the connection cap of the site accounts", () => {
    expect(between(read("README.md"), "**Dalla 0.5.0, cos'altro cambia.**", "\n\n")).toContain("MAX_USER_CONNECTIONS");
  });

  it("m6b the audit report closes every high and critical finding", () => {
    const report = read("docs/security/audit-report.md");
    expect(read("README.md")).toContain("docs/security/audit-report.md");
    // [id, last cell without bold] of every finding row of a table.
    const states = (table: string) =>
      table
        .split("\n")
        .filter((l) => /^\| [A-Z]+\d+ \|/.test(l))
        .map((l) => [l.split(" | ")[0]!.slice(2), l.split(" | ").at(-1)!.replace(/ \|$/, "").replaceAll("**", "")]);
    const closing = between(report, "## Open high or critical findings");
    const rows = [
      ...states(between(report, "## Critical findings", "## High findings")),
      ...states(between(report, "## High findings", "## H1:")),
      ...states(closing),
    ];
    // C1, C2; H2 to H10; then C1, C2, H1 to H10 and DH1 again in the closing table.
    expect(rows.length).toBeGreaterThanOrEqual(24);
    for (const [id, state] of rows) expect(state, id).toMatch(/^(repaired|written as a limit)/);
    expect(closing.trimEnd().endsWith("\nOpen high or critical findings: 0")).toBe(true);
  });
});
