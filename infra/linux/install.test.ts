import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "install.sh");
const CANARY = "canary-pass-123456";
const dirs: string[] = [];
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "hp-install-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function osRelease(id: string, codename: string) {
  const f = join(tmp(), "os-release");
  writeFileSync(f, `ID=${id}\nVERSION_CODENAME=${codename}\n`);
  return f;
}
const ARGS = ["--hostname", "panel.example.com", "--admin-email", "admin@example.com", "--admin-name", "Ada Admin"];

function install(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HP_OS_RELEASE_FILE: osRelease("debian", "trixie"),
      HP_INSTALL_STATE_DIR: join(tmp(), "empty-state"),
      HP_ADMIN_PASSWORD: CANARY,
      ...env
    }
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const dry = (env: Record<string, string> = {}, extra: string[] = []) => install([...ARGS, ...extra, "--dry-run"], env);

describe("install.sh arguments", () => {
  it("rejects missing --hostname with exit 2", () => {
    expect(install(["--admin-email", "a@example.com", "--admin-name", "A", "--dry-run"]).code).toBe(2);
  });

  it("rejects an invalid hostname or email with exit 2", () => {
    expect(install(["--hostname", "a b", "--admin-email", "a@example.com", "--admin-name", "A", "--dry-run"]).code).toBe(2);
    expect(install(["--hostname", "panel.example.com", "--admin-email", "nope", "--admin-name", "A", "--dry-run"]).code).toBe(2);
  });

  it("rejects an unsupported OS with exit 3", () => {
    expect(dry({ HP_OS_RELEASE_FILE: osRelease("ubuntu", "jammy") }).code).toBe(3);
  });
});

describe("install.sh --dry-run", () => {
  it("dry-run prints all 12 steps in order", () => {
    const r = dry();
    expect(r.code).toBe(0);
    let last = -1;
    for (let n = 1; n <= 12; n++) {
      const i = r.out.indexOf(`[STEP ${n}/12]`);
      expect(i, `step ${n}`).toBeGreaterThan(last);
      last = i;
    }
  });

  it("dry-run uses the detected codename for every apt repo", () => {
    const t = dry();
    expect(t.code).toBe(0);
    expect(t.out).toContain("download.docker.com/linux/debian trixie");
    expect(t.out).toContain("trixie-pgdg");
    expect(t.out).toContain("signed-by=/etc/apt/keyrings/docker.asc");
    expect(t.out).toContain("signed-by=/etc/apt/keyrings/postgresql.asc");
    expect(t.out).not.toContain("apt-key");
    expect(t.out).not.toContain("bookworm");

    const r = dry({ HP_OS_RELEASE_FILE: osRelease("ubuntu", "resolute") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("linux/ubuntu resolute");
    expect(r.out).toContain("resolute-pgdg");
    expect(r.out).not.toContain("apt-key");
    expect(r.out).not.toContain("noble");
  });

  it("dry-run never prints secrets", () => {
    const r = dry();
    expect(r.code).toBe(0);
    for (const s of [r.out, r.err]) {
      expect(s).not.toContain(CANARY);
      expect(s).not.toContain("postgresql://hosting_panel:");
    }
  });

  it("dry-run on a fresh server plans DB, keys and admin creation", () => {
    const r = dry();
    expect(r.out).toMatch(/would create.*hosting_panel/i);
    expect(r.out).toMatch(/would generate.*keys/i);
    expect(r.out).toMatch(/would create.*administrator/i);
  });

  it("install.sh is idempotent on rerun (dry-run plan shows no regeneration)", () => {
    const state = tmp();
    writeFileSync(join(state, "api.env"), "DATABASE_URL=postgresql://hosting_panel:secret@127.0.0.1:5432/hosting_panel\n");
    writeFileSync(join(state, "web.env"), "BFF_SESSION_SECRET=x\nHP_WEB_BIND_ADDRESS=127.0.0.1\n");
    writeFileSync(join(state, "executor.env"), "HP_PANEL_HOSTNAME=\n");
    for (const k of ["ipc.key", "secrets-master.key", "breakglass-jwt.key", "jwt-signing.pem"]) writeFileSync(join(state, k), "k");
    writeFileSync(join(state, "admin-created"), "");
    const r = dry({ HP_INSTALL_STATE_DIR: state });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/skip.*role hosting_panel/i);
    expect(r.out).toMatch(/skip.*key generation/i);
    expect(r.out).toMatch(/skip.*administrator/i);
    expect(r.out).not.toMatch(/would create.*hosting_panel/i);
    expect(r.out).not.toMatch(/would generate.*keys/i);
    expect(r.out).not.toContain("secret@");
  });
});

describe("set_env_keys", () => {
  it("updates only the owned keys atomically, keeps other lines, 0400", () => {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    // Non-root test: drop -o/-g so install(1) succeeds without chown.
    writeFileSync(
      join(bin, "install"),
      '#!/usr/bin/env bash\na=(); while (($#)); do case "$1" in -o|-g) shift 2;; *) a+=("$1"); shift;; esac; done\nexec /usr/bin/install "${a[@]}"\n',
      { mode: 0o755 }
    );
    const f = join(d, "executor.env");
    writeFileSync(f, "HP_PANEL_HOSTNAME=old.example.com\nSECRET=keep=me\nHP_ACME_STAGING=false\n", { mode: 0o400 });
    const r = spawnSync(
      "bash",
      ["-c", `source "${SCRIPT}"; set_env_keys "${f}" HP_PANEL_HOSTNAME=new.example.com HP_ACME_STAGING=true HP_PANEL_IPV4=203.0.113.7`],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(
      "HP_PANEL_HOSTNAME=new.example.com\nSECRET=keep=me\nHP_ACME_STAGING=true\nHP_PANEL_IPV4=203.0.113.7\n"
    );
    expect(statSync(f).mode & 0o777).toBe(0o400);
    expect(r.stdout + r.stderr).not.toContain("new.example.com");
  });
});
