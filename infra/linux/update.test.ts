import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "update.sh");
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
/** hosting-panel-<v>-linux-x64.tar.gz (+ .sha256) in a fresh dir. */
function makeArchive(version: string) {
  const d = tmp();
  mkdirSync(join(d, "src", `hosting-panel-${version}`), { recursive: true });
  writeFileSync(join(d, "src", `hosting-panel-${version}`, "VERSION"), `${version}\n`);
  const name = `hosting-panel-${version}-linux-x64.tar.gz`;
  sh(`cd "${d}" && tar -czf "${name}" -C src "hosting-panel-${version}" && sha256sum "${name}" > "${name}.sha256"`);
  return join(d, name);
}

/** Root with releases/<v> for each version, current -> releases/<current>, and logging stubs. */
function fixture(current: string, others: string[] = [], healthFailsFor = "") {
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
  const env = {
    HP_ROOT: root,
    HP_SYSTEMCTL: stub("systemctl", `echo "$*" >> "${log}"`),
    HP_BOOTSTRAP_CMD: stub("bootstrap", `echo "bootstrap $1" >> "${join(d, "bootstrap.log")}"`),
    // Fails when current points at healthFailsFor ("*" = always).
    HP_HEALTH_CMD: stub(
      "health",
      `v="$(basename "$(readlink "${root}/current")")"; [[ "${healthFailsFor}" != "*" && "$v" != "${healthFailsFor}" ]]`
    )
  };
  return { root, log, env, d };
}
function update(args: string[], env: Record<string, string>) {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const cur = (root: string) => readlinkSync(join(root, "current"));
const restarts = (log: string) => readFileSync(log, "utf8").split("\n").filter((l) => l === RESTART).length;

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

  it("--dry-run changes nothing", () => {
    const f = fixture("0.1.0");
    const r = update(["--archive", makeArchive("0.2.0"), "--dry-run"], f.env);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("[STEP 1/");
    expect(cur(f.root)).toBe("releases/0.1.0");
    expect(existsSync(join(f.root, "releases/0.2.0"))).toBe(false);
    expect(readFileSync(f.log, "utf8")).toBe("");
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

  it("rejects bad arguments with exit 2", () => {
    const f = fixture("0.1.0");
    expect(update(["--version", "x"], f.env).code).toBe(2);
    expect(update(["--bogus"], f.env).code).toBe(2);
  });
});
