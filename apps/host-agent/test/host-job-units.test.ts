import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HOST_JOBS, HOST_JOB_TRIGGER_DIR, HOST_JOB_UNITS } from "@hosting-panel/host-agent-contracts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const lines = (text: string) => text.split("\n");
const rm = (n: string) => `ExecStartPre=/usr/bin/rm -f /run/hosting-panel/host-jobs/${n}`;

// The Exec lines of each pair, word for word from the design (arch-host.md, Contract, root units).
const EXEC: Record<string, readonly string[]> = {
  "hp-unit-restart@": [rm("hp-unit-restart@%i"), "ExecStart=/usr/bin/systemctl restart %i.service"],
  "hp-panel-update": [rm("hp-panel-update"), "ExecStart=/usr/local/sbin/hp-update"],
  "hp-os-refresh": [rm("hp-os-refresh"), "ExecStart=/usr/bin/apt-get update"],
  "hp-os-upgrade": [rm("hp-os-upgrade"), "ExecStart=/usr/bin/unattended-upgrade -v"],
};
const BASES = Object.keys(EXEC);
const FILES = BASES.flatMap((b) => [`${b}.path`, `${b}.service`]);
const unitText = (f: string) => read(`infra/systemd/${f}`);
// File base of a unit: the template name for an instance, the unit name otherwise.
const baseOf = (unit: string) => (unit.includes("@") ? unit.slice(0, unit.indexOf("@") + 1) : unit);
const PATH_UNITS = HOST_JOBS.map((j) => `${HOST_JOB_UNITS[j]}.path`);

describe("root units of the host jobs", () => {
  it("every job of HOST_JOBS has its pair of files, and there are exactly four pairs", () => {
    expect(new Set(HOST_JOBS.map((j) => baseOf(HOST_JOB_UNITS[j])))).toEqual(new Set(BASES));
    for (const f of FILES) expect(existsSync(join(ROOT, "infra/systemd", f)), f).toBe(true);
  });

  it("every ExecStart and ExecStartPre line equals the design, and no other Exec line exists", () => {
    for (const b of BASES) {
      expect(lines(unitText(`${b}.service`)).filter((l) => l.startsWith("Exec"))).toEqual(EXEC[b]);
      expect(lines(unitText(`${b}.path`)).filter((l) => l.startsWith("Exec"))).toEqual([]);
    }
  });

  it("no Exec line holds a shell, -c, $, a backtick or a % other than %i", () => {
    for (const l of Object.values(EXEC).flat()) {
      const words = l.slice(l.indexOf("=") + 1).split(" ");
      expect(words.some((w) => /(^|\/)(ba)?sh$/.test(w) || w === "-c"), l).toBe(false);
      expect(l, l).not.toMatch(/[$`]/);
      expect(l.replaceAll("%i", ""), l).not.toContain("%");
    }
  });

  it("the services are root oneshots with no [Install] and no hardening", () => {
    for (const b of BASES) {
      const t = unitText(`${b}.service`);
      expect(lines(t)).toContain("Type=oneshot");
      expect(t).not.toContain("[Install]");
      expect(t).not.toMatch(/^(User|Group|DynamicUser|Protect\w*|NoNewPrivileges|CapabilityBoundingSet)=/m);
    }
  });

  it("every path unit is wanted by paths.target and watches the trigger file of its job", () => {
    for (const b of BASES) expect(lines(unitText(`${b}.path`))).toContain("WantedBy=paths.target");
    for (const j of HOST_JOBS) {
      const unit = HOST_JOB_UNITS[j];
      const watched = lines(unitText(`${baseOf(unit)}.path`)).filter((l) => l.startsWith("PathExists="));
      const instance = unit.includes("@") ? unit.slice(unit.indexOf("@") + 1) : "";
      expect(watched.map((l) => l.replaceAll("%i", instance)), j).toEqual([`PathExists=${HOST_JOB_TRIGGER_DIR}/${unit}`]);
      expect(lines(unitText(`${baseOf(unit)}.service`)).map((l) => l.replaceAll("%i", instance)), j).toContain(
        `ExecStartPre=/usr/bin/rm -f ${HOST_JOB_TRIGGER_DIR}/${unit}`,
      );
    }
  });

  it("tmpfiles creates the trigger directory for the agent only", () => {
    expect(lines(read("infra/systemd/hosting-panel-tmpfiles.conf"))).toContain(`d ${HOST_JOB_TRIGGER_DIR} 0700 hp-agent hp-agent -`);
  });

  it("bootstrap installs the eight files, makes the directory, refreshes the boot ruleset and enables the seven path units", () => {
    const boot = read("infra/linux/bootstrap-dedicated.sh");
    for (const f of FILES) expect(boot).toContain(`  "${f}"\n`);
    expect(boot).toContain(`install -d -m 00700 -o hp-agent -g hp-agent ${HOST_JOB_TRIGGER_DIR}\n`);
    expect(boot).toContain(
      'if [[ -e /etc/nftables.d/hosting-panel.nft ]]; then\n  install -m 0644 -o root -g root "${NFTABLES_SRC_FILE}" /etc/nftables.d/hosting-panel.nft\nfi\n',
    );
    const enable = `systemctl enable --now ${PATH_UNITS.join(" ")}`;
    expect(lines(boot)).toContain(enable);
    // After daemon-reload, and before the quiet exit an update takes.
    expect(boot.indexOf(`\n${enable}\n`)).toBeGreaterThan(boot.indexOf("\nsystemctl daemon-reload\n"));
    expect(boot.indexOf(`\n${enable}\n`)).toBeLessThan(boot.indexOf("HP_BOOTSTRAP_QUIET"));
  });

  it.skipIf(process.platform !== "linux")("the bootstrap dry run names the eight files, the directory, the boot copy and the enable line", async () => {
    const { stdout } = await promisify(execFile)("bash", ["infra/linux/bootstrap-dedicated.sh", "--dry-run", "--allow-other-linux"], { cwd: ROOT });
    for (const f of FILES) expect(stdout).toContain(`Would install /etc/systemd/system/${f} (0644 root:root)`);
    expect(stdout).toContain(`${HOST_JOB_TRIGGER_DIR} (0700 hp-agent:hp-agent)`);
    expect(stdout).toContain("/etc/nftables.d/hosting-panel.nft");
    expect(stdout).toContain(`Would run: systemctl enable --now ${PATH_UNITS.join(" ")}`);
    expect(stdout.indexOf("enable --now")).toBeGreaterThan(stdout.indexOf("Would run: systemctl daemon-reload"));
  });
});
