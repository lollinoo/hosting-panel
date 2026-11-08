import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
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

  const hasHost = existsSync("/sys/fs/cgroup/cgroup.controllers") && spawnSync("bash", ["-c", "command -v docker"]).status === 0;
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

  it("wrappers never put DATABASE_URL in argv", () => {
    for (const w of ["hp-accounts", "hp-break-glass"]) {
      const src = read(`infra/linux/${w}`);
      expect(src).toContain("runuser -u hp-api");
      expect(src).toContain("/usr/bin/node /opt/hosting-panel/current/");
      expect(src).not.toMatch(/node\s[^\n]*"\$DATABASE_URL"/);
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
    const wf = read(".github/workflows/release.yml");
    for (const s of ["tags:", "v*", "release:build", "release:smoke", "gh release create"]) expect(wf).toContain(s);
    const readme = read("README.md");
    for (const s of ["install.sh", "hp-update", "sha256sum -c", "hp-accounts"]) expect(readme).toContain(s);
    expect(readme).not.toContain("export DATABASE_URL=");
    expect(JSON.parse(read("package.json")).version).toBe("0.3.0");
  });

  it("step 2a docs are consistent", () => {
    const readme = read("README.md");
    for (const s of ["WordPress", "mariadb-root.key", "2 GB"]) expect(readme).toContain(s);
    const api = read("docs/api/openapi.yaml");
    for (const s of ["/v1/organizations/{orgId}/managed-sites", "/v1/admin/sites"]) expect(api).toContain(s);
    expect(existsSync(join(root, "docs/architecture/adr/0016-shared-mariadb-and-site-jobs.md"))).toBe(true);
    expect(JSON.parse(read("package.json")).version).toBe("0.3.0");
  });
});

