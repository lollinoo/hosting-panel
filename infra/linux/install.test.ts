import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM helper without type declarations
import { writeReleaseTree } from "./test-release-tree.mjs";
// @ts-expect-error -- plain ESM script without type declarations
import { releaseImages } from "../release/build-release.mjs";
import * as contracts from "../../packages/contracts/src/index.js";
import { DEFAULT_TRAEFIK_IMAGE } from "../../apps/docker-executor/src/traefik-config.js";

const SCRIPT = resolve(__dirname, "install.sh");
const OS_LIB = resolve(__dirname, "lib/os.sh");
const hasHost = existsSync("/sys/fs/cgroup/cgroup.controllers") && spawnSync("bash", ["-c", "command -v docker"]).status === 0;
const CANARY = "canary-pass-123456";
const PORTS_LINE =
  "Ports: 22, 80, 443 accepted in the input chain of the base rules; 3000 (web console) from the Docker bridges only; 80, 443 (Traefik) and 2222 (site SFTP) published by Docker on all addresses, where of the base rules only the block list filters them; ports of a generic service published by Docker on 127.0.0.1 only; 127.0.0.1:4000 (API), 127.0.0.1:5432 (PostgreSQL), 127.0.0.1:8306 (phpMyAdmin) on loopback";
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

/** A temp dir holding a fake dpkg-query that reports only `installed` as installed. */
function fakeDpkg(installed: string[] = []) {
  const bin = tmp();
  writeFileSync(join(bin, "dpkg-query"), `#!/usr/bin/env bash\ncase " ${installed.join(" ")} " in *" \${@: -1} "*) printf 'install ok installed' ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
  return bin;
}
function install(args: string[], env: Record<string, string> = {}, script = SCRIPT) {
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HP_OS_RELEASE_FILE: osRelease("debian", "trixie"),
      HP_INSTALL_STATE_DIR: join(tmp(), "empty-state"),
      // No case reads this machine's /opt/hosting-panel (R203 2.2).
      HP_INSTALL_ROOT: join(tmp(), "empty-root"),
      HP_ADMIN_PASSWORD: CANARY,
      // Host-independent defaults (honoured only in --dry-run).
      HP_SSHD_PORTS: "22",
      HP_DOCKER0_IPV4: "172.17.0.1",
      // No case asks this machine's dpkg.
      PATH: `${fakeDpkg()}:${process.env.PATH}`,
      ...env
    }
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
// No case reads this machine's firewall sign file.
const dry = (env: Record<string, string> = {}, extra: string[] = []) =>
  install([...ARGS, ...extra, "--dry-run"], { HP_NFT_SIGN_FILE: join(tmp(), "absent.nft"), ...env });

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

describe("install.sh public addresses", () => {
  /** A fake `ip` whose default route leaves from `src`: no case reads this machine's routes. */
  const routeFrom = (src: string) => {
    const bin = tmp();
    writeFileSync(join(bin, "ip"), `#!/usr/bin/env bash\nprintf '1.1.1.1 via 198.51.100.1 dev eth0 src ${src} uid 0\\n'\n`, { mode: 0o755 });
    return { PATH: `${bin}:${fakeDpkg()}:${process.env.PATH}` };
  };
  /** The state an earlier run left: the IPv4 it recorded and its administrator. */
  const savedState = (ipv4: string) => {
    const state = tmp();
    writeFileSync(join(state, "executor.env"), `HP_PANEL_HOSTNAME=panel.example.com\nHP_PANEL_IPV4=${ipv4}\n`);
    writeFileSync(join(state, "admin-created"), "");
    return { HP_INSTALL_STATE_DIR: state };
  };
  const SETUP = "would run hp-accounts setup --name panel.example.com --hostname panel.example.com";

  it("a rerun without --ipv4 keeps the IPv4 the last run recorded, and setup keeps the panel's", () => {
    const r = dry({ ...routeFrom("198.51.100.7"), ...savedState("203.0.113.7") });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Panel IPv4: 203.0.113.7 (kept from the last run");
    expect(r.out).toContain("HP_PANEL_IPV4=203.0.113.7 ");
    // A remembered IPv4 never replaces the one the panel records: only --ipv4 does.
    expect(r.out).toContain(
      `${SETUP} --ipv4-default 203.0.113.7 (the recorded IPv4, if any, stays as it is; the recorded IPv6 stays as it is)`,
    );
    expect(r.out).not.toContain("--ipv4 203.0.113.7");
    expect(r.out).toMatch(/skip.*administrator already created/i);
    expect(r.out).not.toContain("198.51.100.7");
  });

  it("--ipv4 wins over the IPv4 the last run recorded, and setup records it", () => {
    const r = dry({ ...routeFrom("198.51.100.7"), ...savedState("203.0.113.7") }, ["--ipv4", "203.0.113.8"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Panel IPv4: 203.0.113.8 (given with --ipv4)");
    expect(r.out).toContain(`${SETUP} --ipv4 203.0.113.8 (the recorded IPv6 stays as it is)`);
    expect(r.out).not.toContain("203.0.113.7");
  });

  it("without a recorded IPv4 the installer takes the source of the default route and says so", () => {
    const r = dry(routeFrom("198.51.100.7"));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Panel IPv4: 198.51.100.7 (source address of the default route;");
    expect(r.out).toContain(`${SETUP} --ipv4-default 198.51.100.7 (the recorded IPv4, if any, stays as it is;`);
    // A recorded value that is not an IPv4 is not kept.
    const bad = dry({ ...routeFrom("198.51.100.7"), ...savedState("203.0.113.07") });
    expect(bad.code).toBe(0);
    expect(bad.out).toContain("Panel IPv4: 198.51.100.7 (source address of the default route,");
  });

  it("refuses an IPv4 with a leading zero with exit 2", () => {
    for (const a of ["203.0.113.05", "203.0.113.005", "203.0.113.00", "023.0.113.5", "203.0.113.256"]) {
      const r = dry({}, ["--ipv4", a]);
      expect(r.code, a).toBe(2);
      expect(r.err).toContain("Invalid --ipv4");
    }
    for (const a of ["203.0.113.0", "203.0.113.9", "203.0.113.99", "203.0.113.199", "203.0.113.255"]) {
      expect(dry({}, ["--ipv4", a]).code, a).toBe(0);
    }
  });

  it("after setup it warns when the panel keeps another IPv4 than this run uses, and goes on", () => {
    const warn = (recorded: string, inUse: string) =>
      spawnSync(
        "bash",
        ["-c", `source "${SCRIPT}"; set -euo pipefail; recorded_ipv4_warning "$1" "$2"; echo went-on`, "bash",
          `{"installationId":"pin_1","hostId":"hst_1"}\n{"recordedIpv4":"${recorded}"}`, inUse],
        { encoding: "utf8" },
      );
    const differs = warn("203.0.113.7", "203.0.113.8");
    expect(differs.status, differs.stderr).toBe(0);
    expect(differs.stdout).toBe(
      "  WARNING: the panel has 203.0.113.7 recorded as this server's public IPv4, but this run uses 203.0.113.8. " +
        "Run the installer again with --ipv4 <address> to record the right one.\nwent-on\n",
    );
    const same = warn("203.0.113.7", "203.0.113.7");
    expect(same.status, same.stderr).toBe(0);
    expect(same.stdout).toBe("went-on\n");
  });

  it("--ipv6 hands the address to hp-accounts setup, --ipv6 none removes the recorded one", () => {
    expect(install(["--help"]).out).toContain("--ipv6 <addr> | --ipv6 none");
    const given = dry({}, ["--ipv4", "203.0.113.7", "--ipv6", "2001:db8::1"]);
    expect(given.code).toBe(0);
    expect(given.out).toContain("Panel IPv6: 2001:db8::1 (given with --ipv6)");
    expect(given.out).toContain(`${SETUP} --ipv4 203.0.113.7 --ipv6 2001:db8::1`);
    const none = dry({}, ["--ipv4", "203.0.113.7", "--ipv6", "none"]);
    expect(none.code).toBe(0);
    expect(none.out).toContain(`${SETUP} --ipv4 203.0.113.7 --ipv6 none (removes the recorded IPv6)`);
    const left = dry({}, ["--ipv4", "203.0.113.7"]);
    expect(left.code).toBe(0);
    expect(left.out).toContain(`${SETUP} --ipv4 203.0.113.7 (the recorded IPv6 stays as it is)`);
  });

  it("refuses with exit 2 what can never be an IPv6", () => {
    for (const a of ["[2001:db8::1]", "fe80::1%eth0", "2001:db8::/64", "hello", "203.0.113.7", ""]) {
      const r = dry({}, ["--ipv4", "203.0.113.7", "--ipv6", a]);
      expect(r.code, a).toBe(2);
      expect(r.err, a).toContain("Invalid --ipv6");
    }
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
    expect(r.out).toContain("skip: --skip-firewall given; manage the firewall yourself");
  });

  it("--skip-firewall on a server whose firewall the panel manages warns, naming the file and the table", () => {
    const sign = join(tmp(), "hosting-panel.nft");
    writeFileSync(sign, "");
    const r = dry({ HP_NFT_SIGN_FILE: sign }, ["--skip-firewall"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`warning: --skip-firewall given, but ${sign} is there`);
    expect(r.out).toContain("the panel still manages the firewall");
    expect(r.out).toContain("nft delete table inet hp_dedicated_filter");
    expect(r.out).not.toContain("skip: --skip-firewall given");
  });

  it("refuses HP_NFT_SIGN_FILE outside a dry run", () => {
    const r = install(ARGS, { HP_NFT_SIGN_FILE: join(tmp(), "absent.nft") });
    expect(r.code).toBe(2);
    expect(r.err).toContain("HP_NFT_SIGN_FILE is only for --dry-run tests");
  });

  it("an active ufw gets a rule letting the docker bridges reach the panel on 3000 (live 504 case)", () => {
    const r = dry({ HP_UFW_ACTIVE: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("would run ufw allow from 172.16.0.0/12 to 172.17.0.1 port 3000 proto tcp");
  });

  it("no ufw rule when ufw is not active", () => {
    expect(dry({ HP_UFW_ACTIVE: "0" }).out).not.toContain("ufw allow");
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

  // R203 2.1: the installer never puts an older release over a newer one.
  function installedRoot(current?: string) {
    const root = tmp();
    mkdirSync(join(root, "releases", "0.3.1"), { recursive: true });
    if (current) symlinkSync(join("releases", current), join(root, "current"));
    return root;
  }
  const listing = (root: string) => readdirSync(root, { recursive: true }).map(String).sort();

  it("refuses --version 0.3.0 over an installed 0.3.1 with exit 2, naming both, and changes nothing", () => {
    const root = installedRoot("0.3.1");
    const before = listing(root);
    const r = dry({ HP_INSTALL_ROOT: root }, ["--version", "0.3.0"]);
    expect(r.code, r.out).toBe(2);
    expect(r.err).toMatch(/0\.3\.0.*0\.3\.1/);
    expect(r.err).toContain("--version 0.3.1");
    expect(r.out).not.toContain("[STEP 2/12]");
    expect([listing(root), readlinkSync(join(root, "current"))]).toEqual([before, "releases/0.3.1"]);
  });

  it("refuses an older --archive over an installed release", () => {
    const r = dry({ HP_INSTALL_ROOT: installedRoot("0.3.1") }, ["--archive", archive("0.3.0")]);
    expect(r.code, r.out).toBe(2);
    expect(r.out).not.toContain("Release 0.3.0 verified");
  });

  it("refuses --version 0.4.0 over an installed 0.3.1 with exit 2, naming hp-update, and changes nothing", () => {
    const root = installedRoot("0.3.1");
    const before = listing(root);
    const r = dry({ HP_INSTALL_ROOT: root }, ["--version", "0.4.0"]);
    expect(r.code, r.out).toBe(2);
    expect(r.err).toContain("sudo hp-update --version 0.4.0");
    expect(r.err).toContain("--version 0.3.1");
    expect(r.out).not.toContain("[STEP 2/12]");
    expect([listing(root), readlinkSync(join(root, "current"))]).toEqual([before, "releases/0.3.1"]);
  });

  it("refuses a newer --archive over an installed release", () => {
    const r = dry({ HP_INSTALL_ROOT: installedRoot("0.3.1") }, ["--archive", archive("0.4.0")]);
    expect(r.code, r.out).toBe(2);
    expect(r.err).toContain("sudo hp-update --version 0.4.0");
    expect(r.out).not.toContain("Release 0.4.0 verified");
  });

  it("goes on with the same version, or no installed release", () => {
    expect(dry({ HP_INSTALL_ROOT: installedRoot("0.3.1") }, ["--version", "0.3.1"]).code).toBe(0);
    expect(dry({ HP_INSTALL_ROOT: installedRoot() }, ["--version", "0.3.0"]).code).toBe(0);
  });

  it("without --version or --archive the dry run says the check waits for the lookup", () => {
    const r = dry({ HP_INSTALL_ROOT: installedRoot("0.3.1") });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("would refuse the latest release unless it is the installed one (exit 2)");
  });

  it("refuses HP_INSTALL_ROOT outside a dry run", () => {
    const r = install(ARGS, { HP_INSTALL_ROOT: installedRoot("0.3.1") });
    expect(r.code).toBe(2);
    expect(r.err).toContain("HP_INSTALL_ROOT is only for --dry-run tests");
  });

  it("step 2 installs the one package list of lib/os.sh", () => {
    const list = spawnSync("bash", ["-c", `. "${OS_LIB}"; printf '%s' "\${HP_OS_PACKAGES[*]}"`], { encoding: "utf8" }).stdout;
    expect(list).toContain("unattended-upgrades");
    expect(dry().out).toContain(`[DRY-RUN] apt-get install -y ${list}\n`);
  });

  it("missing_os_packages prints only the packages dpkg does not report installed", () => {
    const run = (installed: string[]) =>
      spawnSync("bash", ["-c", `. "${OS_LIB}"; missing_os_packages; printf '|%s' "\${HP_OS_PACKAGES[*]}"`], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${fakeDpkg(installed)}:${process.env.PATH}` }
      }).stdout.split("|");
    const [, all] = run([]);
    const list = all!.split(" ");
    expect(list).toEqual(expect.arrayContaining(["curl", "tar", "unattended-upgrades"]));
    expect(run([])[0]).toBe(all);
    expect(run(["curl", "tar"])[0]).toBe(list.filter((p) => p !== "curl" && p !== "tar").join(" "));
    expect(run(list)[0]).toBe("");
  });

  it.skipIf(!hasHost)("the dry run of a release prints what its bootstrap provisions", () => {
    const images: string[] = releaseImages(contracts, DEFAULT_TRAEFIK_IMAGE);
    const rel = writeReleaseTree(tmp(), "0.9.0", images) as string;
    const r = install([...ARGS, "--dry-run"], { HP_NFT_SIGN_FILE: join(tmp(), "absent.nft") }, join(rel, "infra/linux/install.sh"));
    expect(r.code, r.err).toBe(0);
    const step7 = r.out.slice(r.out.indexOf("[STEP 7/12]"), r.out.indexOf("[STEP 8/12]"));
    const units = readdirSync(resolve(__dirname, "../systemd")).filter((f) => /\.(service|path)$/.test(f));
    const packages = spawnSync("bash", ["-c", `. "${OS_LIB}"; printf '%s' "\${HP_OS_PACKAGES[*]}"`], { encoding: "utf8" }).stdout;
    const line = (i: string) => `Image (pulled by hp-docker-executor, never by this script): ${i}`;
    const printed = step7.split("\n").filter((l) => l.includes("Image (pulled by")).map((l) => l.slice(l.indexOf("Image (")));
    expect(printed).toEqual(images.map(line));
    for (const i of [contracts.SFTP_IMAGE, contracts.PHPMYADMIN_IMAGE, contracts.RESTIC_IMAGE]) expect(step7).toContain(line(i));
    const pkgLine = step7.indexOf("[DRY-RUN] Would install with apt-get, before anything else");
    expect(pkgLine).toBeGreaterThan(-1);
    expect(pkgLine).toBeLessThan(step7.indexOf("[DRY-RUN] Would ensure system group: hp-ipc"));
    expect(step7).toContain(`[DRY-RUN] ${PORTS_LINE}\n`);
    for (const s of [
      ...units.map((u) => `/etc/systemd/system/${u}`),
      "hp-panel-update.path hp-os-refresh.path hp-os-upgrade.path",
      ...["sftp", "phpmyadmin", "backups", "panel-dump"].map((d) => `/var/lib/hosting-panel/${d}`),
      "/run/hosting-panel/host-jobs",
      "backup.key",
      "hp-restore-panel",
      "2222",
      "3000",
      "8306",
      packages
    ]) {
      expect(step7).toContain(s);
    }
  });

  it("lists libatomic1 among the apt prerequisites (Node 26 needs it)", () => {
    expect(dry().out).toMatch(/apt-get install -y .*\blibatomic1\b/);
  });

  it("lists unattended-upgrades among the apt prerequisites (the security upgrade job runs it)", () => {
    expect(dry().out).toMatch(/apt-get install -y .*\bunattended-upgrades\b/);
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

describe("panel_has_admin", () => {
  const PW = "0123456789abcdef".repeat(4);
  const run = (psqlRc: number) => {
    const d = tmp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    const log = '"$(basename "$0") $*" >> "$D/calls.log"; env >> "$D/env.log"; [[ -n "${PGPASSWORD+x}" ]] && echo "$PGPASSWORD" >> "$D/pgpw.log"';
    writeFileSync(join(bin, "psql"), `#!/usr/bin/env bash\necho ${log}\n((${psqlRc} == 0)) || { echo 'relation does not exist' >&2; exit ${psqlRc}; }\necho 1\n`, { mode: 0o755 });
    writeFileSync(join(bin, "runuser"), `#!/usr/bin/env bash\necho ${log}\nexit 1\n`, { mode: 0o755 });
    const env = join(d, "api.env");
    writeFileSync(env, `NODE_ENV=production\nDATABASE_URL=postgresql://hosting_panel:${PW}@127.0.0.1:5432/hosting_panel\n`);
    for (const f of ["calls.log", "env.log", "pgpw.log"]) writeFileSync(join(d, f), "");
    const r = spawnSync("bash", ["-c", `source "${SCRIPT}"; set -euo pipefail; has="$(panel_has_admin "${env}")"; echo "got:$has"`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, D: d }
    });
    const file = (n: string) => readFileSync(join(d, n), "utf8");
    return { code: r.status, out: r.stdout + r.stderr, calls: file("calls.log"), env: file("env.log"), pgpw: file("pgpw.log") };
  };

  it("asks public.users as hosting_panel over 127.0.0.1, the password only in that child's environment", () => {
    const r = run(0);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("got:1");
    expect(r.calls).toBe(
      "psql -X -qtA -h 127.0.0.1 -U hosting_panel -d hosting_panel -c select 1 from public.users where platform_role = 'infrastructure_admin' limit 1\n"
    );
    expect(r.pgpw).toBe(`${PW}\n`);
    expect(r.calls + r.out).not.toContain(PW);
  });

  it("a failed query means no administrator, as before", () => {
    const r = run(2);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("got:\n");
  });

  it("the installer never opens the panel database as the superuser", () => {
    expect(readFileSync(SCRIPT, "utf8")).not.toMatch(/runuser -u postgres[^\n]*(\\\n[^\n]*)?-d hosting_panel/);
  });
});

it("reads the apt candidate in the C locale (a localized apt prints 'Candidato:')", () => {
  expect(readFileSync(SCRIPT, "utf8")).toMatch(/LC_ALL=C apt-cache policy "\$5" \| awk '\/Candidate:\//);
});

it("closing warning box names backup.key, carries the bilingual warning, and keeps every line at 78 columns", () => {
  const src = readFileSync(SCRIPT, "utf8");
  expect(src).toContain("backup.key cifra i backup");
  expect(src).toContain("backup.key encrypts the site backups");
  const match = /^#{78}\n[\s\S]*?^#{78}$/m.exec(src);
  expect(match).not.toBeNull();
  for (const line of match![0].split("\n")) {
    expect([...line].length, line).toBe(78);
  }
});
