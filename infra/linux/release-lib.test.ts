import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const LIB = resolve(__dirname, "lib/release.sh");
const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "hp-rellib-"));
  dirs.push(d);
  return d;
}
function run(script: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", `set -euo pipefail; source "${LIB}"; ${script}`], {
    encoding: "utf8",
    env: { ...process.env, ...env }
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}
function sh(cmd: string) {
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
}
/** Builds hosting-panel-<v>-linux-x64.tar.gz (+ .sha256) in a fresh dir; returns the archive path. */
function makeArchive(version: string, opts: { topDir?: string; fileVersion?: string } = {}) {
  const d = tmp();
  const top = opts.topDir ?? `hosting-panel-${version}`;
  mkdirSync(join(d, "src", top), { recursive: true });
  writeFileSync(join(d, "src", top, "VERSION"), `${opts.fileVersion ?? version}\n`);
  const name = `hosting-panel-${version}-linux-x64.tar.gz`;
  sh(`cd "${d}" && tar -czf "${name}" -C src "${top}" && sha256sum "${name}" > "${name}.sha256"`);
  return join(d, name);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("release_asset_url", () => {
  it("builds the GitHub release URL", () => {
    expect(run("release_asset_url 1.2.3").out).toBe(
      "https://github.com/lollinoo/hosting-panel/releases/download/v1.2.3/hosting-panel-1.2.3-linux-x64.tar.gz"
    );
  });
});

describe("verify_release_archive", () => {
  it("accepts a matching checksum", () => {
    expect(run(`verify_release_archive "${makeArchive("0.1.0")}"`).code).toBe(0);
  });

  it("rejects a mismatched checksum and leaves target untouched", () => {
    const archive = makeArchive("0.1.0");
    sh(`printf x >> "${archive}"`);
    const root = join(tmp(), "root");
    const r = run(`verify_release_archive "${archive}" && install_release "${archive}" "${root}"`);
    expect(r.code).not.toBe(0);
    expect(existsSync(join(root, "releases"))).toBe(false);
  });

  it("rejects a missing checksum file", () => {
    const archive = makeArchive("0.1.0");
    rmSync(`${archive}.sha256`);
    expect(run(`verify_release_archive "${archive}"`).code).not.toBe(0);
  });
});

describe("install_release", () => {
  it("extracts and renames into releases/<v>", () => {
    const root = tmp();
    const r = run(`install_release "${makeArchive("0.2.0")}" "${root}"`);
    expect(r.out).toBe("0.2.0");
    expect(existsSync(join(root, "releases/0.2.0/VERSION"))).toBe(true);
    expect(readdirSync(join(root, "releases"))).toEqual(["0.2.0"]);
  });

  it("leaves no temp dir and current untouched on extract failure", () => {
    const root = tmp();
    mkdirSync(join(root, "releases/0.1.0"), { recursive: true });
    symlinkSync("releases/0.1.0", join(root, "current"));
    const archive = makeArchive("0.2.0");
    sh(`head -c 60 "${archive}" > "${archive}.cut" && mv "${archive}.cut" "${archive}"`);
    expect(run(`install_release "${archive}" "${root}"`).code).not.toBe(0);
    expect(readdirSync(join(root, "releases"))).toEqual(["0.1.0"]);
    expect(readlinkSync(join(root, "current"))).toBe("releases/0.1.0");
  });

  it("refuses a VERSION mismatch", () => {
    const root = tmp();
    const r = run(`install_release "${makeArchive("0.2.0", { fileVersion: "0.3.0" })}" "${root}"`);
    expect(r.code).not.toBe(0);
    expect(readdirSync(join(root, "releases"))).toEqual([]);
  });

  it("refuses a wrong top-level directory", () => {
    const root = tmp();
    expect(run(`install_release "${makeArchive("0.2.0", { topDir: "evil" })}" "${root}"`).code).not.toBe(0);
    expect(readdirSync(join(root, "releases"))).toEqual([]);
  });

  it("refuses an existing release unless HP_FORCE_REINSTALL=1", () => {
    const root = tmp();
    const archive = makeArchive("0.2.0");
    expect(run(`install_release "${archive}" "${root}"`).code).toBe(0);
    expect(run(`install_release "${archive}" "${root}"`).code).not.toBe(0);
    const r = run(`install_release "${archive}" "${root}"`, { HP_FORCE_REINSTALL: "1" });
    expect(r.out).toBe("0.2.0");
    expect(readdirSync(join(root, "releases"))).toEqual(["0.2.0"]);
  });
});

describe("swap_current / current_version", () => {
  it("is atomic and repeatable", () => {
    const root = tmp();
    for (const v of ["0.1.0", "0.2.0"]) mkdirSync(join(root, "releases", v), { recursive: true });
    expect(run(`current_version "${root}"`).out).toBe("");
    expect(run(`swap_current "${root}" 0.1.0; swap_current "${root}" 0.2.0`).code).toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe("releases/0.2.0");
    expect(existsSync(join(root, "current.new"))).toBe(false);
    expect(run(`current_version "${root}"`).out).toBe("0.2.0");
  });
});

describe("prune_releases", () => {
  it("keeps current and newest", () => {
    const root = tmp();
    for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"]) mkdirSync(join(root, "releases", v), { recursive: true });
    mkdirSync(join(root, "releases/.tmp-abc"));
    mkdirSync(join(root, "releases/notes"));
    symlinkSync("releases/0.2.0", join(root, "current"));
    expect(run(`prune_releases "${root}" 3`).code).toBe(0);
    expect(readdirSync(join(root, "releases")).sort()).toEqual([".tmp-abc", "0.2.0", "0.4.0", "0.5.0", "notes"]);
  });

  it("keeps HP_KEEP_EXTRA", () => {
    const root = tmp();
    for (const v of ["0.1.0", "0.2.0", "0.3.0", "0.4.0"]) mkdirSync(join(root, "releases", v), { recursive: true });
    symlinkSync("releases/0.4.0", join(root, "current"));
    run(`prune_releases "${root}" 1`, { HP_KEEP_EXTRA: "0.1.0" });
    expect(readdirSync(join(root, "releases")).sort()).toEqual(["0.1.0", "0.4.0"]);
  });
});

describe("version_gt", () => {
  it("compares numerically", () => {
    expect(run("version_gt 0.10.0 0.9.9").code).toBe(0);
    expect(run("version_gt 0.2.0 0.2.0").code).toBe(1);
    expect(run("version_gt 0.9.9 0.10.0").code).toBe(1);
  });
});
