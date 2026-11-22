import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM helper without type declarations
import { writeReleaseTree } from "./test-release-tree.mjs";
// @ts-expect-error -- plain ESM script without type declarations
import { releaseImages } from "../release/build-release.mjs";
import * as contracts from "../../packages/contracts/src/index.js";
import { DEFAULT_TRAEFIK_IMAGE } from "../../apps/docker-executor/src/traefik-config.js";

const SCRIPT = resolve(__dirname, "update.sh");
const hasHost = existsSync("/sys/fs/cgroup/cgroup.controllers") && spawnSync("bash", ["-c", "command -v docker"]).status === 0;
const RESTART = "restart hp-host-agent hp-docker-executor hp-api hp-web";
const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "hp-update-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function sh(cmd: string) {
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}
/** hosting-panel-<v>-linux-x64.tar.gz (+ .sha256) in a fresh dir; `content` is the version inside. */
function makeArchive(version: string, content = version, marker = "", features?: string) {
  const d = tmp();
  mkdirSync(join(d, "src", `hosting-panel-${content}`), { recursive: true });
  writeFileSync(join(d, "src", `hosting-panel-${content}`, "VERSION"), `${content}\n`);
  if (marker) writeFileSync(join(d, "src", `hosting-panel-${content}`, marker), "");
  if (features !== undefined) writeFileSync(join(d, "src", `hosting-panel-${content}`, "RELEASE.json"), `${JSON.stringify({ version: content, features }, null, 2)}\n`);
  const name = `hosting-panel-${version}-linux-x64.tar.gz`;
  sh(`cd "${d}" && tar -czf "${name}" -C src "hosting-panel-${content}" && sha256sum "${name}" > "${name}.sha256"`);
  return join(d, name);
}

/** Root with releases/<v> for each version, current -> releases/<current>, and logging stubs. */
function fixture(current: string, others: string[] = [], healthFailsFor = "", opts: { features?: string; featuresCmd?: string } = {}) {
  const d = tmp();
  const root = join(d, "root");
  for (const v of [current, ...others]) {
    mkdirSync(join(root, "releases", v), { recursive: true });
    writeFileSync(join(root, "releases", v, "VERSION"), `${v}\n`);
  }
  symlinkSync(`releases/${current}`, join(root, "current"));
  const log = join(d, "systemctl.log");
  writeFileSync(log, "");
  const stub = (name: string, body: string) => {
    writeFileSync(join(d, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    return join(d, name);
  };
  if (opts.features !== undefined) writeFileSync(join(root, "releases", current, "RELEASE.json"), `${JSON.stringify({ version: current, features: opts.features }, null, 2)}\n`);
  const env: Record<string, string> = {
    HP_ROOT: root,
    HP_SYSTEMCTL: stub("systemctl", `echo "$*" >> "${log}"`),
    HP_BOOTSTRAP_CMD: stub("bootstrap", `echo "bootstrap $1" >> "${join(d, "bootstrap.log")}"`),
    // Fails when current points at healthFailsFor ("*" = always).
    HP_HEALTH_CMD: stub(
      "health",
      `v="$(basename "$(readlink "${root}/current")")"; [[ "${healthFailsFor}" != "*" && "$v" != "${healthFailsFor}" ]]`
    )
  };
  if (opts.featuresCmd !== undefined) env.HP_FEATURES_CMD = stub("features", `touch "${join(d, "features.asked")}"\n${opts.featuresCmd}`);
  return { root, log, env, d };
}
function update(args: string[], env: Record<string, string>) {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const cur = (root: string) => readlinkSync(join(root, "current"));
const restarts = (log: string) => readFileSync(log, "utf8").split("\n").filter((l) => l === RESTART).length;

describe("update.sh downgrade gate (features in use)", () => {
  const BOTH = "manual-tls backup-targets";
  const gated = (featuresCmd: string, features = BOTH) => fixture("0.2.0", [], "", { features, featuresCmd });
  const old = () => makeArchive("0.1.0", "0.1.0", "", "");
  const asked = (f: { d: string }) => existsSync(join(f.d, "features.asked"));

  it("refuses a downgrade that drops a feature in use (exit 8) and installs nothing", () => {
    const f = gated("echo manual-tls");
    const r = update(["--archive", old(), "--allow-downgrade"], f.env);
    expect(r.code, r.err).toBe(8);
    expect(r.err).toContain("manual-tls");
    expect(r.err).not.toContain("backup-targets");
    expect(r.err).toContain("--allow-feature-loss");
    expect(cur(f.root)).toBe("releases/0.2.0");
    expect(readFileSync(f.log, "utf8")).toBe("");
    expect(existsSync(join(f.root, "releases/0.1.0"))).toBe(false);
  });

  it("refuses a downgrade while an application stack exists (exit 8), naming only that feature", () => {
    const f = gated("echo app-stacks", "manual-tls backup-targets site-templates app-stacks");
    const r = update(["--archive", old(), "--allow-downgrade"], f.env);
    expect(r.code, r.err).toBe(8);
    for (const t of ["app-stacks", "--allow-feature-loss", "application stacks"]) expect(r.err).toContain(t);
    for (const t of ["manual-tls", "backup-targets", "site-templates"]) expect(r.err).not.toContain(t);
    expect(cur(f.root)).toBe("releases/0.2.0");
    expect(readFileSync(f.log, "utf8")).toBe("");
  });

  it("refuses a downgrade while an application address has routing options (exit 8), naming only that feature", () => {
    const all = "manual-tls backup-targets site-templates app-stacks app-routing-options";
    const f = gated("echo app-routing-options", all);
    // The target knows application stacks, not the options of their addresses.
    const older = makeArchive("0.1.0", "0.1.0", "", "manual-tls backup-targets site-templates app-stacks");
    const r = update(["--archive", older, "--allow-downgrade"], f.env);
    expect(r.code, r.err).toBe(8);
    for (const t of ["app-routing-options", "--allow-feature-loss", "password-protected address"]) expect(r.err).toContain(t);
    for (const t of ["manual-tls", "backup-targets", "site-templates", "app-stacks"]) expect(r.err).not.toContain(t);
    expect(cur(f.root)).toBe("releases/0.2.0");
    expect(readFileSync(f.log, "utf8")).toBe("");
  });

  it("--allow-feature-loss lets the downgrade through", () => {
    const f = gated("echo manual-tls");
    const r = update(["--archive", old(), "--allow-downgrade", "--allow-feature-loss"], f.env);
    expect(r.code, r.err).toBe(0);
    expect(cur(f.root)).toBe("releases/0.1.0");
    expect(r.err).toContain("manual-tls");
  });

  it("fails closed when the database cannot be asked", () => {
    const f = gated("exit 1");
    const r = update(["--archive", old(), "--allow-downgrade"], f.env);
    expect(r.code, r.err).toBe(8);
    expect(r.err).toContain("Cannot tell");
    expect(cur(f.root)).toBe("releases/0.2.0");
  });

  it("proceeds when no lacking feature is in use", () => {
    const f = gated("true");
    expect(update(["--archive", old(), "--allow-downgrade"], f.env).code).toBe(0);
    expect(asked(f)).toBe(true);
    expect(cur(f.root)).toBe("releases/0.1.0");
  });

  it("an in-use feature the target knows does not block, and the database is not asked", () => {
    const f = gated("echo manual-tls");
    const r = update(["--archive", makeArchive("0.1.0", "0.1.0", "", BOTH), "--allow-downgrade"], f.env);
    expect(r.code, r.err).toBe(0);
    expect(asked(f)).toBe(false);
  });

  it("a release without a features list is never gated", () => {
    const f = fixture("0.2.0", [], "", { featuresCmd: "echo manual-tls" });
    expect(update(["--archive", old(), "--allow-downgrade"], f.env).code).toBe(0);
    expect(asked(f)).toBe(false);
  });

  it("an upgrade never asks the database", () => {
    const f = gated("echo manual-tls");
    const r = update(["--archive", makeArchive("0.3.0", "0.3.0", "", "")], f.env);
    expect(r.code, r.err).toBe(0);
    expect(asked(f)).toBe(false);
  });

  it("refuses HP_FEATURES_CMD as root", () => {
    if (process.getuid?.() !== 0) return;
    expect(update(["--archive", old()], { HP_FEATURES_CMD: "/bin/true" }).code).toBe(2);
  });

  it("the dry-run plan names --allow-feature-loss and exit 8", () => {
    const r = update(["--version", "0.1.0", "--dry-run"], fixture("0.2.0").env);
    expect(r.out).toContain("--allow-feature-loss");
    expect(r.out).toContain("(exit 8)");
  });
});

describe("update.sh", () => {
  it("update swaps current and prunes on healthy restart", () => {
    const f = fixture("0.1.0", ["0.0.1", "0.0.2", "0.0.3"]);
    const r = update(["--archive", makeArchive("0.2.0")], f.env);
    expect(r.code, r.err).toBe(0);
    expect(cur(f.root)).toBe("releases/0.2.0");
    const log = readFileSync(f.log, "utf8");
    expect(log.split("\n").filter((l) => l.startsWith("restart"))).toEqual([RESTART]);
    expect(log).toContain("daemon-reload");
    expect(log.split(/\s+/)).not.toContain("docker");
    expect(log).not.toContain("docker.service");
    expect(log).not.toContain("nftables");
    expect(readFileSync(join(f.d, "bootstrap.log"), "utf8")).toContain(join(f.root, "releases/0.2.0"));
    expect(existsSync(join(f.root, "releases/0.1.0"))).toBe(true);
    expect(existsSync(join(f.root, "releases/0.0.3"))).toBe(true);
    expect(existsSync(join(f.root, "releases/0.0.2"))).toBe(false);
    expect(r.out).toContain("updated 0.1.0 → 0.2.0");
  });

  it("update rolls back when health check fails", () => {
    const f = fixture("0.1.0", ["0.0.1", "0.0.2", "0.0.3"], "0.2.0");
    const r = update(["--archive", makeArchive("0.2.0")], f.env);
    expect(r.code).toBe(6);
    expect(cur(f.root)).toBe("releases/0.1.0");
    expect(restarts(f.log)).toBe(2);
    expect(r.out + r.err).toContain("rolled back to 0.1.0");
    // No prune on failure; the failed release stays for inspection.
    expect(existsSync(join(f.root, "releases/0.0.1"))).toBe(true);
    expect(existsSync(join(f.root, "releases/0.2.0"))).toBe(true);
    // The previous release's bootstrap restores its units.
    expect(readFileSync(join(f.d, "bootstrap.log"), "utf8")).toContain(join(f.root, "releases/0.1.0"));
  });

  it("exits 7 naming both versions when the rollback is unhealthy too", () => {
    const f = fixture("0.1.0", [], "*");
    const r = update(["--archive", makeArchive("0.2.0")], f.env);
    expect(r.code).toBe(7);
    expect(cur(f.root)).toBe("releases/0.1.0");
    expect(r.err).toContain("0.1.0");
    expect(r.err).toContain("0.2.0");
  });

  it("update refuses downgrade without flag", () => {
    const f = fixture("0.2.0");
    const archive = makeArchive("0.1.0");
    expect(update(["--archive", archive], f.env).code).toBe(2);
    expect(cur(f.root)).toBe("releases/0.2.0");
    expect(readFileSync(f.log, "utf8")).toBe("");
    expect(update(["--archive", archive, "--allow-downgrade"], f.env).code).toBe(0);
    expect(cur(f.root)).toBe("releases/0.1.0");
  });

  it("update is a no-op for the same version", () => {
    const f = fixture("0.2.0");
    const r = update(["--archive", makeArchive("0.2.0")], f.env);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already up to date");
    expect(readFileSync(f.log, "utf8")).toBe("");
  });

  it("update aborts on checksum mismatch before touching releases", () => {
    const f = fixture("0.1.0");
    const archive = makeArchive("0.2.0");
    sh(`printf x >> "${archive}"`);
    const r = update(["--archive", archive], f.env);
    expect(r.code).toBe(4);
    expect(existsSync(join(f.root, "releases/0.2.0"))).toBe(false);
    expect(readFileSync(f.log, "utf8")).toBe("");
  });

  it("refuses a mislabelled archive (name 0.3.0, content 0.2.0) with exit 2, current untouched", () => {
    const f = fixture("0.2.0");
    writeFileSync(join(f.root, "releases/0.2.0/ORIGINAL"), "");
    const r = update(["--archive", makeArchive("0.3.0", "0.2.0")], f.env);
    expect(r.code).toBe(2);
    expect(r.err).toContain("mislabelled");
    expect(cur(f.root)).toBe("releases/0.2.0");
    expect(existsSync(join(f.root, "releases/0.2.0/ORIGINAL"))).toBe(true);
    expect(existsSync(join(f.root, "releases/0.3.0"))).toBe(false);
    expect(readFileSync(f.log, "utf8")).toBe("");
  });

  it("installs the private copy of --archive, not the original path (no swap after verify)", () => {
    const f = fixture("0.1.0");
    const archive = makeArchive("0.2.0");
    const evil = makeArchive("0.2.0", "0.2.0", "EVIL");
    const bin = join(f.d, "bin");
    mkdirSync(bin);
    // Every tar run first swaps the operator's original for another archive, as an attacker
    // racing the verify/extract window would.
    writeFileSync(join(bin, "tar"), `#!/usr/bin/env bash\ncp "${evil}" "${archive}"\nexec /usr/bin/tar "$@"\n`, { mode: 0o755 });
    const r = update(["--archive", archive], { ...f.env, PATH: `${bin}:${process.env.PATH}` });
    expect(r.code, r.err).toBe(0);
    expect(cur(f.root)).toBe("releases/0.2.0");
    expect(existsSync(join(f.root, "releases/0.2.0/VERSION"))).toBe(true);
    expect(existsSync(join(f.root, "releases/0.2.0/EVIL"))).toBe(false);
  });

  it("refuses to run while another update holds the lock", () => {
    const f = fixture("0.1.0");
    const r = spawnSync("flock", [join(f.root, ".update.lock"), "bash", SCRIPT, "--archive", makeArchive("0.2.0")], {
      encoding: "utf8",
      env: { ...process.env, ...f.env }
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Another update is running");
    expect(cur(f.root)).toBe("releases/0.1.0");
  });

  it("requires root unless running against a test HP_ROOT", () => {
    if (process.getuid?.() === 0) return;
    expect(update(["--archive", makeArchive("0.2.0")], { HP_ROOT: "" }).code).toBe(1);
  });

  it("--dry-run changes nothing and, without --archive, says what to pass", () => {
    const f = fixture("0.1.0");
    const r = update(["--version", "0.2.0", "--dry-run"], f.env);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("[STEP 1/");
    expect(r.out).toContain("pass --archive to print the new release's packages");
    expect(cur(f.root)).toBe("releases/0.1.0");
    expect(existsSync(join(f.root, "releases/0.2.0"))).toBe(false);
    expect(readFileSync(f.log, "utf8")).toBe("");
  });

  it("--dry-run --archive checks the checksum (exit 4) and the VERSION (exit 2) and needs the archive's infra (exit 1), changing nothing", () => {
    const f = fixture("0.1.0");
    const bad = makeArchive("0.2.0");
    sh(`printf x >> "${bad}"`);
    expect(update(["--archive", bad, "--dry-run"], f.env).code).toBe(4);
    expect(update(["--archive", makeArchive("0.3.0", "0.2.0"), "--dry-run"], f.env).code).toBe(2);
    const r = update(["--archive", makeArchive("0.2.0"), "--dry-run"], f.env);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Cannot read hosting-panel-0.2.0/infra");
    expect(cur(f.root)).toBe("releases/0.1.0");
    expect(readdirSync(join(f.root, "releases"))).toEqual(["0.1.0"]);
    expect(readFileSync(f.log, "utf8")).toBe("");
  });

  it.skipIf(!hasHost)("--dry-run --archive from a layout an older version left prints what the new bootstrap adds", () => {
    const f = fixture("0.5.0");
    const listing = () => readdirSync(f.root, { recursive: true }).map(String).sort();
    const before = listing();
    const images: string[] = releaseImages(contracts, DEFAULT_TRAEFIK_IMAGE);
    const d = tmp();
    writeReleaseTree(join(d, "src"), "9.9.9", images);
    const name = "hosting-panel-9.9.9-linux-x64.tar.gz";
    sh(`cd "${d}" && tar -czf "${name}" -C src hosting-panel-9.9.9 && sha256sum "${name}" > "${name}.sha256"`);
    const r = update(["--archive", join(d, name), "--dry-run"], f.env);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("current: 0.5.0");
    const pathUnits = ["api", "web", "docker-executor", "host-agent"].map((s) => `hp-unit-restart@hp-${s}.path`);
    for (const s of [
      `systemctl enable --now ${[...pathUnits, "hp-panel-update.path", "hp-os-refresh.path", "hp-os-upgrade.path"].join(" ")}`,
      ...["hp-unit-restart@.path", "hp-unit-restart@.service", "hp-panel-update.path", "hp-panel-update.service"].map((u) => `/etc/systemd/system/${u}`),
      ...["hp-os-refresh.path", "hp-os-refresh.service", "hp-os-upgrade.path", "hp-os-upgrade.service"].map((u) => `/etc/systemd/system/${u}`),
      "/usr/local/sbin/hp-restore-panel",
      "/etc/hosting-panel/backup.key",
      ...["sftp", "phpmyadmin", "backups", "panel-dump"].map((p) => `/var/lib/hosting-panel/${p}`),
      "/run/hosting-panel/host-jobs",
      "/run/hosting-panel/acme-dns",
      "ingress/dynamic/manual-certs",
      "/var/lib/hosting-panel/local-repos (2770 hp-executor:hp-executor, HP_BACKUP_LOCAL_ROOT)",
      "unattended-upgrades",
      "2222 (site SFTP)",
      "127.0.0.1:8306"
    ]) {
      expect(r.out).toContain(s);
    }
    const line = (i: string) => `Image (pulled by hp-docker-executor, never by this script): ${i}`;
    const printed = r.out.split("\n").filter((l) => l.includes("Image (pulled by")).map((l) => l.slice(l.indexOf("Image (")));
    expect(printed).toEqual(images.map(line));
    for (const i of [contracts.SFTP_IMAGE, contracts.PHPMYADMIN_IMAGE, contracts.RESTIC_IMAGE]) expect(r.out).toContain(line(i));
    const pkgLine = r.out.indexOf("[DRY-RUN] Would install with apt-get, before anything else");
    expect(pkgLine).toBeGreaterThan(-1);
    expect(pkgLine).toBeLessThan(r.out.indexOf("[DRY-RUN] Would ensure system group: hp-ipc"));
    expect(r.out).toContain("80, 443 (Traefik) and 2222 (site SFTP) published by Docker on all addresses, where of the base rules only the block list filters them");
    expect([listing(), cur(f.root)]).toEqual([before, "releases/0.5.0"]);
    expect(readFileSync(f.log, "utf8")).toBe("");
  });

  it("the bootstrap installs missing OS packages first, flags changed rules and never runs nft", () => {
    const boot = readFileSync(resolve(__dirname, "bootstrap-dedicated.sh"), "utf8");
    const step = boot.indexOf('MISSING_PACKAGES="$(missing_os_packages)"');
    expect(step).toBeGreaterThan(boot.indexOf("Live provisioning requires root privileges"));
    expect(step).toBeLessThan(boot.indexOf("groupadd"));
    expect(boot).toContain("; nothing else was changed.");
    const flag = boot.indexOf("on Administration > Firewall use Apply base rules.");
    expect(flag).toBeGreaterThan(boot.indexOf('cmp -s "${NFTABLES_SRC_FILE}" /etc/nftables.d/hosting-panel.nft'));
    expect(flag).toBeLessThan(boot.indexOf('install -m 0644 -o root -g root "${NFTABLES_SRC_FILE}" /etc/nftables.d/hosting-panel.nft'));
    expect(boot).not.toMatch(/^\s*(nft|sudo nft|\{?\s*nft)\s/m);
    expect(boot).not.toMatch(/\$\(\s*nft\s|\|\|\s*nft\s|&&\s*nft\s/);
  });

  it("downloads into a fresh private dir, ignores a planted one, removes it afterwards", () => {
    const f = fixture("0.1.0");
    const archive = makeArchive("0.2.0");
    const tmpDir = join(f.d, "tmp");
    const planted = join(tmpDir, "hosting-panel-update");
    mkdirSync(planted, { recursive: true });
    writeFileSync(join(planted, "hosting-panel-0.2.0-linux-x64.tar.gz"), "evil");
    const bin = join(f.d, "bin");
    mkdirSync(bin);
    const curlLog = join(f.d, "curl.log");
    // Fake curl: answers the GitHub API and serves the fixture archive/.sha256 to -o <file>.
    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env bash
out=""; url=""; while (($#)); do case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
case "$url" in
  *api.github.com*) echo '{"tag_name": "v0.2.0"}' ;;
  *.sha256) cp "${archive}.sha256" "$out"; echo "$(dirname "$out") $(stat -c %a "$(dirname "$out")")" >> "${curlLog}" ;;
  *) cp "${archive}" "$out" ;;
esac
`,
      { mode: 0o755 }
    );
    const r = update([], { ...f.env, TMPDIR: tmpDir, PATH: `${bin}:${process.env.PATH}` });
    expect(r.code, r.err).toBe(0);
    expect(cur(f.root)).toBe("releases/0.2.0");
    const [dir, mode] = readFileSync(curlLog, "utf8").trim().split(" ");
    expect(dir.startsWith(`${tmpDir}/`)).toBe(true);
    expect(dir).not.toBe(planted);
    expect(mode).toBe("700");
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(planted, "hosting-panel-0.2.0-linux-x64.tar.gz"), "utf8")).toBe("evil");
  });

  it("installer and updater never download into a fixed shared path", () => {
    for (const s of ["install.sh", "update.sh"]) {
      expect(readFileSync(resolve(__dirname, s), "utf8")).not.toMatch(/\/var\/tmp\/hosting-panel/);
    }
  });

  it("health check gives up early when a unit has failed", () => {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
    writeFileSync(join(d, "systemctl"), "#!/bin/sh\n[ \"$1\" = is-failed ]\n", { mode: 0o755 });
    const start = Date.now();
    const r = spawnSync("bash", ["-c", `source "${resolve(__dirname, "lib/common.sh")}"; panel_health_check 127.0.0.1 90`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYSTEMCTL: join(d, "systemctl") }
    });
    expect(r.status).toBe(1);
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(r.stdout.match(/waiting for health/g)).toHaveLength(1);
  });

  /**
   * Runs panel_health_check with curl exiting <curlRc> and the given systemctl stub body; with
   * <executorEnv>, also an executor.env with that content and a docker stub printing <proxyRunning>.
   */
  function healthCheck(curlRc: number, systemctl: string, timeout: number, executorEnv?: string, proxyRunning = "true") {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\nexit ${curlRc}\n`, { mode: 0o755 });
    writeFileSync(join(d, "systemctl"), `#!/usr/bin/env bash\n${systemctl}\n`, { mode: 0o755 });
    writeFileSync(join(d, "docker"), `#!/bin/sh\necho "$*" >> "${d}/docker.log"\necho ${proxyRunning}\n`, { mode: 0o755 });
    const envFile = join(d, "executor.env");
    if (executorEnv !== undefined) writeFileSync(envFile, executorEnv);
    const start = Date.now();
    const r = spawnSync("bash", ["-c", `source "${resolve(__dirname, "lib/common.sh")}"; panel_health_check 127.0.0.1 ${timeout} "${envFile}"`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYSTEMCTL: join(d, "systemctl"), HP_DOCKER_CMD: join(d, "docker") }
    });
    const dockerLog = existsSync(join(d, "docker.log")) ? readFileSync(join(d, "docker.log"), "utf8") : "";
    return { code: r.status, ms: Date.now() - start, err: r.stderr, dockerLog };
  }
  const ACTIVE = `case "$1" in is-active) exit 0;; is-failed) exit 1;; show) printf 'active\\nrunning\\n';; esac`;

  it("health check passes when probes answer and all four units are active", () => {
    expect(healthCheck(0, ACTIVE, 30).code).toBe(0);
  });

  it("health check waits for hp_ingress_proxy when the panel ingress is enabled", () => {
    const r = healthCheck(0, ACTIVE, 1, "HP_PANEL_HOSTNAME=panel.example.com\n", "false");
    expect(r.code).toBe(1);
    expect(r.dockerLog).toContain("inspect -f {{.State.Running}} hp_ingress_proxy");
    expect(healthCheck(0, ACTIVE, 30, "HP_PANEL_HOSTNAME=panel.example.com\n", "true").code).toBe(0);
  }, 15_000);

  it("health check skips the proxy when the panel ingress is disabled", () => {
    const r = healthCheck(0, ACTIVE, 30, "HP_PANEL_HOSTNAME=\n", "false");
    expect(r.code).toBe(0);
    expect(r.dockerLog).toBe("");
  });

  it("health check is not satisfied by HTTP probes while a daemon unit is down", () => {
    // hp-host-agent inactive (dead): not failed, not crash-looping, so only the timeout ends it.
    const r = healthCheck(0, `[[ "$1 $3" == "is-active hp-host-agent" ]] && exit 3\n${ACTIVE}`, 1);
    expect(r.code).toBe(1);
  }, 15_000);

  it("health check gives up early when a unit is crash-looping (activating/auto-restart)", () => {
    const r = healthCheck(
      7,
      `case "$1" in is-active) exit 3;; is-failed) exit 1;; show) [[ "$5" == hp-api ]] && printf 'activating\\nauto-restart\\n' || printf 'active\\nrunning\\n';; esac`,
      90
    );
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(10_000);
    expect(r.err).toContain("hp-api is crash-looping");
  });

  it("rejects bad arguments with exit 2", () => {
    const f = fixture("0.1.0");
    expect(update(["--version", "x"], f.env).code).toBe(2);
    expect(update(["--bogus"], f.env).code).toBe(2);
  });
});
