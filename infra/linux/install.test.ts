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
const ARGS = ["--hostname", "panel.example.com", "--admin-email", "admin@acme-hosting.it", "--admin-name", "Ada Admin"];

function install(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HP_OS_RELEASE_FILE: osRelease("debian", "trixie"),
      HP_INSTALL_STATE_DIR: join(tmp(), "empty-state"),
      HP_ADMIN_PASSWORD: CANARY,
      // Host-independent defaults (honoured only in --dry-run).
      HP_SSHD_PORTS: "22",
      HP_DOCKER0_IPV4: "172.17.0.1",
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

describe("install.sh shared database and memory", () => {
  it("dry-run step 12 waits for hp_mariadb", () => {
    const r = dry();
    expect(r.code).toBe(0);
    expect(r.out.slice(r.out.indexOf("[STEP 12/12]"))).toContain("hp_mariadb");
  });

  const meminfo = (kb: number) => {
    const f = join(tmp(), "meminfo");
    writeFileSync(f, `MemTotal:       ${String(kb)} kB\nMemFree:          100000 kB\n`);
    return f;
  };

  it("warns but continues below 2 GB RAM", () => {
    const r = dry({ HP_MEMINFO_FILE: meminfo(1015808) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("at least 2 GB");
    expect(r.out).toContain("992 MB");
    expect(r.out).toContain("[STEP 12/12]");
  });

  it("installer warns when the IPv4 is private and continues", () => {
    const r = dry({}, ["--ipv4", "10.0.0.5"]);
    expect(r.code).toBe(0);
    expect(r.out + r.err).toContain("WARNING: 10.0.0.5 is a private address.");
    expect(r.out).toContain("Dry run complete");
    expect(dry({}, ["--ipv4", "203.0.113.7"]).out).not.toContain("private address");
  });

  it("installer refuses a reserved ACME email", () => {
    for (const e of ["ops@example.com", "ops@example.org", "ops@host.test", "ops@x.invalid"]) {
      expect(dry({}, ["--acme-email", e]).code).toBe(2);
    }
    expect(dry({}, ["--acme-email", "ops@acme-hosting.it"]).code).toBe(0);
  });

  it("no memory warning at 4 GB", () => {
    const r = dry({ HP_MEMINFO_FILE: meminfo(4026532) });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("at least 2 GB");
  });
});

describe("install.sh SSH-safe firewall", () => {
  it("refuses with exit 7 when SSH is not on port 22", () => {
    const r = dry({ HP_SSHD_PORTS: "2222" });
    expect(r.code).toBe(7);
    expect(r.err).toContain("SSH listens on port 2222");
    expect(r.err).toContain("--skip-firewall");
  });

  it("--skip-firewall lets a non-22 SSH host through and skips step 10", () => {
    const r = dry({ HP_SSHD_PORTS: "2222" }, ["--skip-firewall"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[STEP 10\/12\][^\n]*\n\s*\S*\s*skip/i);
  });

  it("passes when SSH also listens on 22", () => {
    expect(dry({ HP_SSHD_PORTS: "22 2222" }).code).toBe(0);
  });

  it("reads the bound port from sshd -T listenaddress lines (they override port)", () => {
    const r = dry({ HP_SSHD_T_OUTPUT: "port 22\nlistenaddress 0.0.0.0:2222\nlistenaddress [::]:2222\n" });
    expect(r.code).toBe(7);
    expect(r.err).toContain("SSH listens on port 2222;");
    expect(dry({ HP_SSHD_T_OUTPUT: "port 22\nlistenaddress [::]:22\nlistenaddress 0.0.0.0:22\n" }).code).toBe(0);
    expect(dry({ HP_SSHD_T_OUTPUT: "port 22\n" }).code).toBe(0);
  });

  // Live order: sshd listeners in ss, else an active ssh.socket's Listen=, else sshd -T.
  const SOCKET_2222 = "0.0.0.0:2222 (Stream)\n[::]:2222 (Stream)\n";
  const sshdSs = (port: number) => `LISTEN 0 128 0.0.0.0:${port} 0.0.0.0:* users:(("sshd",pid=900,fd=3))`;

  it("an active ssh.socket on 2222 wins over sshd -T port 22 (live lockout case)", () => {
    const r = dry({ HP_SSHD_T_OUTPUT: "port 22\n", HP_SSH_SOCKET_LISTEN: SOCKET_2222, HP_SS_OUTPUT: "" });
    expect(r.code).toBe(7);
    expect(r.err).toContain("SSH listens on port 2222;");
  });

  it("a live sshd listener on 22 passes even if sshd -T says 2222 (config not yet applied)", () => {
    const r = dry({ HP_SSHD_T_OUTPUT: "port 2222\n", HP_SSH_SOCKET_LISTEN: SOCKET_2222, HP_SS_OUTPUT: sshdSs(22) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("SSH listens on port 22");
  });

  it("a live sshd listener only on 2222 is refused even if sshd -T says 22", () => {
    const r = dry({ HP_SSHD_T_OUTPUT: "port 22\n", HP_SS_OUTPUT: sshdSs(2222) });
    expect(r.code).toBe(7);
    expect(r.err).toContain("SSH listens on port 2222;");
  });

  it("ignores generic systemd listeners in ss (unrelated socket units)", () => {
    const ss = 'LISTEN 0 4096 *:2222 *:* users:(("systemd",pid=1,fd=50))';
    expect(dry({ HP_SSHD_T_OUTPUT: "port 22\n", HP_SS_OUTPUT: ss }).code).toBe(0);
  });

  it("exit 7 when no source yields a port", () => {
    const r = dry({ HP_SSHD_T_OUTPUT: "", HP_SS_OUTPUT: "", HP_SSH_SOCKET_LISTEN: "" });
    expect(r.code).toBe(7);
    expect(r.err).toContain("Cannot detect which port SSH listens on");
  });
});

describe("install.sh --archive", () => {
  function archive(version: string, content = version) {
    const d = tmp();
    mkdirSync(join(d, "src", `hosting-panel-${content}`), { recursive: true });
    writeFileSync(join(d, "src", `hosting-panel-${content}`, "VERSION"), `${content}\n`);
    const name = `hosting-panel-${version}-linux-x64.tar.gz`;
    const r = spawnSync("bash", ["-c", `cd "${d}" && tar -czf "${name}" -C src "hosting-panel-${content}" && sha256sum "${name}" > "${name}.sha256"`]);
    expect(r.status).toBe(0);
    return join(d, name);
  }

  it("verifies a private copy in step 1, before any package step", () => {
    const a = archive("0.3.0");
    const tmpDir = tmp();
    const r = dry({ TMPDIR: tmpDir }, ["--archive", a]);
    expect(r.code, r.err).toBe(0);
    const verified = /Release 0\.3\.0 verified \((.*)\)/.exec(r.out);
    expect(verified?.[1]?.startsWith(`${tmpDir}/`)).toBe(true);
    expect(verified?.[1]).not.toBe(a);
    expect(r.out.indexOf("Release 0.3.0 verified")).toBeLessThan(r.out.indexOf("[STEP 2/12]"));
  });

  it("exits 4 in step 1 on a checksum mismatch", () => {
    const a = archive("0.3.0");
    spawnSync("bash", ["-c", `printf x >> "${a}"`]);
    const r = dry({}, ["--archive", a]);
    expect(r.code).toBe(4);
    expect(r.out).not.toContain("[STEP 2/12]");
  });

  it("refuses a mislabelled archive (name 0.3.0, content 0.2.0) with exit 2", () => {
    const r = dry({}, ["--archive", archive("0.3.0", "0.2.0")]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("mislabelled");
  });

  it("lists libatomic1 among the apt prerequisites (Node 26 needs it)", () => {
    expect(dry().out).toMatch(/apt-get install -y .*\blibatomic1\b/);
  });
});

describe("docker0 bind address", () => {
  it("dry-run passes without docker0", () => {
    const r = dry({ HP_DOCKER0_IPV4: "" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("HP_WEB_BIND_ADDRESS=<docker0 IPv4>");
  });

  it("live lookup exits 6 (not 1) when docker0 has no IPv4", () => {
    const bin = join(tmp(), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "ip"), "#!/bin/sh\necho 'Device \"docker0\" does not exist.' >&2\nexit 1\n", { mode: 0o755 });
    const r = spawnSync("bash", ["-c", `source "${SCRIPT}"; set -euo pipefail; bind="$(panel_bind_address)"; echo "got:$bind"`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    });
    expect(r.status).toBe(6);
    expect(r.stderr).toContain("docker0 has no IPv4");
  });
});

describe("docker engine API", () => {
  const run = (api: string) => {
    const bin = join(tmp(), "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho '${api}'\n`, { mode: 0o755 });
    return spawnSync("bash", ["-c", `source "${SCRIPT}"; set -euo pipefail; require_docker_api; echo ok`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    });
  };
  it("accepts API 1.48 and newer (GwPriority)", () => {
    expect(run("1.48").status).toBe(0);
    expect(run("1.56").status).toBe(0);
  });
  it("exits 3 on an engine older than API 1.48", () => {
    const r = run("1.47");
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("1.48");
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

it("reads the apt candidate in the C locale (a localized apt prints 'Candidato:')", () => {
  expect(readFileSync(SCRIPT, "utf8")).toMatch(/LC_ALL=C apt-cache policy "\$5" \| awk '\/Candidate:\//);
});
