// M5d "the host": independent QA (qa-host, qa-c13). A fake runner and temp dirs only; no program, no container.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  FIREWALL_SAFE_PORTS,
  HostJobStateWireSchema,
  HostJournalLineWireSchema,
  HostOsPackagesWireSchema,
  HostServiceStateWireSchema,
  checkFirewallBlock,
  signIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKeyring,
} from "@hosting-panel/contracts";
import {
  HOST_JOBS,
  HOST_JOB_UNITS,
  HOST_SERVICE_UNITS,
  createApprovedHostSecurityCommand,
  type HostFirewallSets,
} from "@hosting-panel/host-agent-contracts";

// execFile is a spy that fails: nothing in this file may start a real program.
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify: p } = await import("node:util");
  const real = await importOriginal<typeof import("node:child_process")>();
  const fail = (): never => {
    throw new Error("a real program must not start in this test");
  };
  return { ...real, execFile: Object.assign(vi.fn(fail), { [p.custom]: vi.fn(fail) }) };
});

const { execFile } = await import("node:child_process");
const {
  ALLOWED_LINUX_BINARIES,
  DEDICATED_NFTABLES_RULESET_SHA256,
  HostAgentIpcServer,
  LinuxSystemHostAdapter,
  REPO_DEDICATED_NFTABLES_RULESET_PATH,
  buildFirewallSetsProgram,
  isClosedArgumentForm,
  parseAptUpgradeSimulation,
  parseFirewallListing,
  runAllowlistedBinary,
  validateFirewallSets,
} = await import("../src/index.js");
type ExecFileRunner = import("../src/index.js").ExecFileRunner;
type AllowedLinuxBinary = import("../src/index.js").AllowedLinuxBinary;
type Adapter = ConstructorParameters<typeof HostAgentIpcServer>[0]["adapter"];

const execFileCustom = (execFile as unknown as Record<symbol, Mock>)[promisify.custom]!;

const ROOT = resolve(import.meta.dirname, "../../..");
const SRC = resolve(import.meta.dirname, "../src");
const UNITS_DIR = join(ROOT, "infra/systemd");
const TOOL_FAILED = "A host tool failed or gave an answer the agent cannot read";
const MARK = "qamarkerzebra";
const TABLE = "inet hp_dedicated_filter";
const NFT_LIST = ["-j", "list", "table", "inet", "hp_dedicated_filter"];
const SERVICES_ARGV = [
  "show", "--timestamp=unix", "--property=Id,ActiveState,ActiveEnterTimestamp,NRestarts", "--",
  "hp-api.service", "hp-web.service", "hp-docker-executor.service", "hp-host-agent.service",
];
const jobArgv = (unit: string): string[] => [
  "show", "--timestamp=unix",
  "--property=Id,LoadState,ActiveState,Result,ExecMainStartTimestamp,ExecMainExitTimestamp,ExecMainStatus", "--",
  `${unit}.service`, `${unit}.path`,
];
const journalArgv = (unit: string, lines: string): string[] => [
  `--unit=${unit}.service`, `--lines=${lines}`, "--output=json", "--output-fields=MESSAGE", "--no-pager", "--quiet",
];

const codeOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(() => "resolved", (e: unknown) => (e as { code?: unknown }).code);

const tempDirs: string[] = [];
// The installer's boot copy, outside every test's directory so their listings stay exact.
const INSTALLED_PATH = join(await mkdtemp(join(os.tmpdir(), "hp-m5d-qa-nft-")), "hosting-panel.nft");
await writeFile(INSTALLED_PATH, "# installer copy\n");
afterAll(() => rm(dirname(INSTALLED_PATH), { recursive: true, force: true }));
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "hp-m5d-qa-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  (execFile as unknown as Mock).mockClear();
  execFileCustom.mockClear();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Call { readonly binary: AllowedLinuxBinary; readonly args: readonly string[]; readonly program?: string }

// The sets program is a file the agent writes for this one nft call and removes after it.
const isSetsProgramFile = (path: string | undefined): path is string =>
  path !== undefined && dirname(path).startsWith(join(os.tmpdir(), "hp-nft-")) && path.endsWith("/sets.nft");

// A recording runner; every call must be a closed form, as the real runner would demand.
function adapterWith(answer: (c: Call) => { stdout: string; stderr?: string } | string | Error, dir: string, extra: object = {}) {
  const calls: Call[] = [];
  const runner: ExecFileRunner = async (binary, args) => {
    const program = binary.endsWith("/nft") && args[0] === "-f" && isSetsProgramFile(args[1]) ? readFileSync(args[1], "utf8") : undefined;
    const call: Call = { binary, args: [...args], ...(program === undefined ? {} : { program }) };
    calls.push(call);
    expect(isClosedArgumentForm(binary, args)).toBe(true);
    const out = answer(call);
    if (out instanceof Error) throw out;
    return typeof out === "string" ? { stdout: out, stderr: "" } : { stdout: out.stdout, stderr: out.stderr ?? "" };
  };
  const adapter = new LinuxSystemHostAdapter({
    execFileRunner: runner,
    hostJobTriggerDir: join(dir, "host-jobs"),
    rebootRequiredPath: join(dir, "reboot-required"),
    aptListsDir: join(dir, "lists"),
    unattendedUpgradePath: join(dir, "unattended-upgrade"),
    nftablesRulesetPath: REPO_DEDICATED_NFTABLES_RULESET_PATH,
    nftablesInstalledPath: INSTALLED_PATH,
    ...extra,
  });
  return { adapter, calls };
}

function listing(sets: HostFirewallSets): string {
  const el = (a: string): unknown => (a.includes("/") ? { prefix: { addr: a.split("/")[0], len: Number(a.split("/")[1]) } } : a);
  const set = (name: string, type: string, elem: unknown[]) => ({ set: { family: "inet", name, table: "hp_dedicated_filter", type, handle: 4, ...(elem.length ? { elem } : {}) } });
  return JSON.stringify({ nftables: [
    { metainfo: { version: "1.1.6", json_schema_version: 1 } },
    { table: { family: "inet", name: "hp_dedicated_filter", handle: 3 } },
    { chain: { family: "inet", table: "hp_dedicated_filter", name: "forward", handle: 2, type: "filter", hook: "forward", prio: 0, policy: "accept" } },
    set("opened_tcp_ports", "inet_service", [...sets.openedPorts]),
    set("blocked_v4", "ipv4_addr", sets.blockedV4.map(el)),
    set("blocked_v6", "ipv6_addr", sets.blockedV6.map(el)),
  ] });
}
const EMPTY: HostFirewallSets = { openedPorts: [], blockedV4: [], blockedV6: [] };
const CURRENT = listing(EMPTY);
const SETS: HostFirewallSets = { openedPorts: [8080], blockedV4: ["192.0.2.7", "198.51.100.0/24"], blockedV6: ["2001:db8::/48"] };

// The strict shape of one sets program (P3); returns the elements it adds per set.
function readProgram(program: string): Record<string, string[]> {
  expect(program.endsWith("\n")).toBe(true);
  const lines = program.slice(0, -1).split("\n");
  expect(lines.slice(0, 3)).toEqual([
    `flush set ${TABLE} opened_tcp_ports`, `flush set ${TABLE} blocked_v4`, `flush set ${TABLE} blocked_v6`,
  ]);
  const el: Record<string, string> = {
    opened_tcp_ports: "[1-9][0-9]{0,4}",
    blocked_v4: "(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:/(?:[12][0-9]|3[0-2]))?",
    blocked_v6: "[0-9a-f:]{2,39}(?:/(?:3[2-9]|[4-9][0-9]|1[01][0-9]|12[0-8]))?",
  };
  const out: Record<string, string[]> = { opened_tcp_ports: [], blocked_v4: [], blocked_v6: [] };
  const order: string[] = [];
  for (const line of lines.slice(3)) {
    const m = /^add element inet hp_dedicated_filter (opened_tcp_ports|blocked_v4|blocked_v6) \{ (.+) \}$/.exec(line);
    expect(m, line).not.toBeNull();
    const [, set, body] = m!;
    expect(new RegExp(`^${el[set!]}(?:, ${el[set!]})*$`).test(body!), line).toBe(true);
    expect(order).not.toContain(set);
    order.push(set!);
    out[set!] = body!.split(", ");
  }
  for (const bad of [";", "#", "\r", "\t", "$", "`", "\\", "\"", "'", "@", "table ", "chain", "rule", "ruleset", "include", "define", "delete", "insert", "replace", "jump", "goto"])
    expect(lines.slice(3).join("\n").replaceAll(`add element ${TABLE}`, "").includes(bad), bad).toBe(false);
  for (const line of lines) expect((line.match(/\{/g) ?? []).length).toBeLessThanOrEqual(1);
  return out;
}

// ---- P1: no shell where the agent or root's units run a program -------------------------------

describe("P1 no shell in the agent source", () => {
  it("src has no subdirectory, and only linux-adapter.ts imports child_process, and only execFile", async () => {
    const entries = await readdir(SRC, { withFileTypes: true });
    expect(entries.filter((e) => !e.isFile()).map((e) => e.name)).toEqual([]);
    for (const e of entries.filter((x) => x.name.endsWith(".ts"))) {
      const text = await readFile(join(SRC, e.name), "utf8");
      if (e.name === "linux-adapter.ts") {
        expect(text.match(/child_process/g)).toHaveLength(1);
        expect(text).toContain('import { execFile } from "node:child_process";');
      } else {
        expect(text, e.name).not.toMatch(/child_process|\brequire\(|import\(/);
      }
      expect(text, e.name).not.toMatch(/\bspawn|\bexecSync|(?<![.\w])exec\(|\bfork\(|shell:\s*true|["'`](?:\/bin\/|\/usr\/bin\/)?(?:sh|bash|dash|zsh)["'`]/);
      // "-c" appears once: nft's check flag in the fixed verify form.
      expect((text.match(/["'`]-c["'`]/g) ?? []).length, e.name).toBe(e.name === "linux-adapter.ts" ? 1 : 0);
      if (e.name === "linux-adapter.ts") expect(text).toContain('execFileRunner(nftBinary, ["-c", "-f", this.nftablesRulesetPath])');
    }
  });

  it("one runner: execFileAsync is called once, with shell:false, and every program path is one of the allowed seven", async () => {
    const text = await readFile(join(SRC, "linux-adapter.ts"), "utf8");
    expect(text.match(/execFileAsync\(/g)).toHaveLength(1);
    expect(text.match(/\bexecFile\(/g) ?? []).toHaveLength(0);
    expect(text).toMatch(/execFileAsync\(binaryPath, \[\.\.\.args\], \{[^}]*shell: false/);
    // Every first argument of the runner or runTool is a literal allowed path or the nft resolver.
    const firsts = [...text.matchAll(/(?:execFileRunner|runTool)\(([^,)]+)/g)].map((m) => m[1]!.trim());
    expect(firsts.length).toBeGreaterThanOrEqual(10);
    for (const f of firsts) {
      const literal = /^"([^"]+)"$/.exec(f);
      if (literal) expect(ALLOWED_LINUX_BINARIES).toContain(literal[1]);
      else expect(["nftBinary", "await this.resolveNftBinaryPath(", "binary: AllowedLinuxBinary", "binary"]).toContain(f);
    }
    // The nft resolver can only answer one of the two allowed nft paths.
    expect(text).toMatch(/const candidates: readonly AllowedLinuxBinary\[\] = \["\/usr\/sbin\/nft", "\/usr\/bin\/nft"\];/);
    // No argument list is built by joining or splitting a command string.
    expect(text).not.toMatch(/\.split\(" "\)\s*\)|args\.join\(" "\)\s*[,)]/);
  });
});

describe("P1 no shell in the root units", () => {
  const JOB_UNIT_FILES = [
    "hp-unit-restart@.path", "hp-unit-restart@.service", "hp-panel-update.path", "hp-panel-update.service",
    "hp-os-refresh.path", "hp-os-refresh.service", "hp-os-upgrade.path", "hp-os-upgrade.service",
  ];

  it.each(JOB_UNIT_FILES)("%s: only ExecStart/ExecStartPre, absolute fixed paths, no $, no % other than %i, no environment", async (name) => {
    const text = await readFile(join(UNITS_DIR, name), "utf8");
    expect(text).not.toMatch(/^\s*(Environment|EnvironmentFile|PassEnvironment|ExecStartPost|ExecStop|ExecStopPost|ExecReload|ExecCondition)\s*=/m);
    expect(text).not.toMatch(/[$`]/);
    for (const m of text.matchAll(/%(.)/g)) expect(m[1]).toBe("i");
    if (!name.startsWith("hp-unit-restart@")) expect(text).not.toContain("%");
    for (const line of text.split("\n").filter((l) => /^\s*Exec/.test(l))) {
      // No systemd prefix (-, @, :, +, !) and an absolute program path.
      expect(line, line).toMatch(/^Exec(Start|StartPre)=\/(usr\/bin|usr\/local\/sbin)\/[a-z-]+( |$)/);
      expect(line).not.toMatch(/\b(sh|bash)\b| -c |[;&|<>]/);
    }
    if (name.endsWith(".path")) expect(text).toMatch(/^PathExists=\/run\/hosting-panel\/host-jobs\/hp-[a-z-]+(@%i)?$/m);
  });

  it("%i of the restart template is bounded by the enabled instances: every hp-unit-restart@ instance in the shipped scripts is one of the four services", async () => {
    const found = new Set<string>();
    for (const f of ["bootstrap-dedicated.sh", "install.sh", "update.sh"]) {
      const text = await readFile(join(ROOT, "infra/linux", f), "utf8");
      for (const m of text.matchAll(/hp-unit-restart@([^.\s"']*)/g)) if (m[1] !== "") found.add(m[1]!);
    }
    expect(found.size).toBeGreaterThan(0);
    for (const i of found) expect(HOST_SERVICE_UNITS as readonly string[]).toContain(i);
    expect(Object.values(HOST_JOB_UNITS).filter((u) => u.startsWith("hp-unit-restart@")).map((u) => u.slice(16)).sort()).toEqual([...HOST_SERVICE_UNITS].sort());
  });
});

// ---- P2: closed argument forms, refused before anything runs ----------------------------------

describe("P2 closed argument forms through the real runner (execFile is a spy)", () => {
  const refused: Array<[string, AllowedLinuxBinary, string[]]> = [
    ["systemctl start of an upgrade", "/usr/bin/systemctl", ["start", "hp-os-upgrade.service"]],
    ["systemctl restart of a panel service", "/usr/bin/systemctl", ["restart", "hp-api.service"]],
    ["systemctl show on a unit outside the list", "/usr/bin/systemctl", jobArgv("ssh")],
    ["systemctl show of the services with one outside the list", "/usr/bin/systemctl", [...SERVICES_ARGV.slice(0, -1), "ssh.service"]],
    ["apt-get install", "/usr/bin/apt-get", ["install", "qa-invented-pkg"]],
    ["apt-get -o before the form", "/usr/bin/apt-get", ["-o", "APT::Get::Assume-Yes=true", "-s", "upgrade"]],
    ["apt-get -o after the form", "/usr/bin/apt-get", ["-s", "upgrade", "-o", "Dir::Etc=/tmp"]],
    ["apt-get upgrade without -s", "/usr/bin/apt-get", ["upgrade"]],
    ["apt-get --simulate spelled long", "/usr/bin/apt-get", ["--simulate", "upgrade"]],
    ["journalctl on a unit outside the list", "/usr/bin/journalctl", journalArgv("ssh", "10")],
    ["journalctl --file", "/usr/bin/journalctl", ["--file=/tmp/x.journal", ...journalArgv("hp-api", "10").slice(1)]],
    ["journalctl --directory", "/usr/bin/journalctl", ["--directory=/tmp", ...journalArgv("hp-api", "10").slice(1)]],
    ["journalctl --vacuum-size=1", "/usr/bin/journalctl", ["--vacuum-size=1"]],
    ["journalctl with the unit given as a path", "/usr/bin/journalctl", journalArgv("../hp-api", "10")],
  ];
  it.each(refused)("refuses %s", async (_n, binary, args) => {
    expect(isClosedArgumentForm(binary, args)).toBe(false);
    await expect(runAllowlistedBinary(binary, args)).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect(execFileCustom).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  const accepted: Array<[AllowedLinuxBinary, string[]]> = [
    ["/usr/bin/systemctl", SERVICES_ARGV],
    ...Object.values(HOST_JOB_UNITS).map((u): [AllowedLinuxBinary, string[]] => ["/usr/bin/systemctl", jobArgv(u)]),
    ...[...HOST_SERVICE_UNITS, "hp-panel-update", "hp-os-refresh", "hp-os-upgrade"].map((u): [AllowedLinuxBinary, string[]] => ["/usr/bin/journalctl", journalArgv(u, "500")]),
    ["/usr/bin/apt-get", ["-s", "upgrade"]],
  ];
  it(`refuses every accepted form (${accepted.length}) plus one extra element at the end`, async () => {
    for (const [binary, args] of accepted) {
      expect(isClosedArgumentForm(binary, args)).toBe(true);
      for (const extra of ["", "--", "x", "--now", "--file=/x", "-y", args[args.length - 1]!]) {
        expect(isClosedArgumentForm(binary, [...args, extra]), `${binary} ${args.join(" ")} +${extra}`).toBe(false);
        await expect(runAllowlistedBinary(binary, [...args, extra])).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
      }
    }
    expect(execFileCustom).not.toHaveBeenCalled();
  });

  it("refuses a program outside the seven before execFile", async () => {
    for (const p of ["/bin/sh", "/usr/bin/bash", "/usr/bin/env", "nft", "/usr/sbin/nft ", "/tmp/usr/sbin/nft"])
      await expect(runAllowlistedBinary(p as AllowedLinuxBinary, [])).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect(execFileCustom).not.toHaveBeenCalled();
  });
});

// ---- P2 from the nft side: every adapter call that can reach nft --------------------------------

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY: IpcSigningKey = { keyId: "ipc-qa-host", algorithm: "hmac-sha256", secret: SECRET };
const KEYRING: IpcVerificationKeyring = { "ipc-qa-host": { keyId: "ipc-qa-host", algorithm: "hmac-sha256", secret: SECRET } };

const servers: InstanceType<typeof HostAgentIpcServer>[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});
async function serve(adapter: Adapter): Promise<string> {
  const socketPath = join(await tempDir(), "agent.sock");
  const server = new HostAgentIpcServer({ adapter, keyring: KEYRING, transportConfig: { transport: "uds", socketPath } });
  servers.push(server);
  await server.start();
  return socketPath;
}
interface Raw { status: number; text: string; json: { data?: unknown; error?: { code: string; message: string } } }
function raw(socketPath: string, method: "GET" | "POST", path: string, body?: unknown, sign: "ok" | "none" | "tampered" | "old" = "ok"): Promise<Raw> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  let headers: Record<string, string> = {};
  if (sign !== "none") {
    headers = { ...signIpcRequest({ method, pathWithQuery: path, body: text ?? null, key: KEY, ...(sign === "old" ? { timestampMs: Date.now() - 60_000 } : {}) }) };
    if (sign === "tampered") {
      const k = Object.keys(headers).find((h) => /signature/i.test(h))!;
      const v = headers[k]!;
      headers[k] = v.slice(0, -1) + (v.endsWith("0") ? "1" : "0");
    }
  }
  if (text !== undefined) headers["content-type"] = "application/json";
  return new Promise((done, fail) => {
    const req = http.request({ socketPath, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const t = Buffer.concat(chunks).toString("utf8");
        done({ status: res.statusCode ?? 0, text: t, json: JSON.parse(t) });
      });
    });
    req.on("error", fail);
    req.end(text);
  });
}

function expectNftCallsClosed(calls: readonly Call[], rulesetPath: string): void {
  const forms = [["-c", "-f", rulesetPath], ["-f", rulesetPath], NFT_LIST].map((f) => JSON.stringify(f));
  for (const c of calls.filter((x) => x.binary.endsWith("/nft"))) {
    expect(["/usr/sbin/nft", "/usr/bin/nft"]).toContain(c.binary);
    if (c.program === undefined) expect(forms, JSON.stringify(c.args)).toContain(JSON.stringify(c.args));
    else {
      expect(c.args).toHaveLength(2);
      readProgram(c.program);
    }
  }
}

describe("P2 every nft call is one of four argument lists", () => {
  it("both shipped policies, readFirewall and replaceFirewallSets (valid and hostile) use only the four forms", async () => {
    const dir = await tempDir();
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    for (const policyRef of ["verify_baseline_firewall", "apply_dedicated_nftables_22_80_443"] as const)
      expect(await adapter.executeSecurityPolicy(createApprovedHostSecurityCommand({ hostId: "host-qa", policyRef, reason: "qa" }))).toMatchObject({ status: "succeeded" });
    await adapter.readFirewall();
    await adapter.replaceFirewallSets(SETS);
    await adapter.replaceFirewallSets(EMPTY);
    for (const bad of [{ ...SETS, blockedV4: ["192.0.2.7 } ; flush ruleset"] }, { ...SETS, extra: 1 }, "x", null])
      expect(await codeOf(adapter.replaceFirewallSets(bad as HostFirewallSets))).toBe("HOST_POLICY_DENIED");
    const nft = calls.filter((c) => c.binary.endsWith("/nft"));
    expect(nft.map((c) => (c.program === undefined ? c.args.join(" ") : "-f <sets program>"))).toEqual([
      `-c -f ${REPO_DEDICATED_NFTABLES_RULESET_PATH}`, `-f ${REPO_DEDICATED_NFTABLES_RULESET_PATH}`,
      NFT_LIST.join(" "), NFT_LIST.join(" "), "-f <sets program>", NFT_LIST.join(" "), NFT_LIST.join(" "), "-f <sets program>", NFT_LIST.join(" "),
    ]);
    expectNftCallsClosed(calls, REPO_DEDICATED_NFTABLES_RULESET_PATH);
  });

  it("a ruleset whose SHA-256 is not the pin never reaches nft", async () => {
    const dir = await tempDir();
    const copy = join(dir, "ruleset.conf");
    await copyFile(REPO_DEDICATED_NFTABLES_RULESET_PATH, copy);
    await writeFile(copy, `${await readFile(copy, "utf8")}\n# qa\n`);
    const { adapter, calls } = adapterWith(() => CURRENT, dir, { nftablesRulesetPath: copy });
    for (const policyRef of ["verify_baseline_firewall", "apply_dedicated_nftables_22_80_443"] as const)
      await expect(adapter.executeSecurityPolicy(createApprovedHostSecurityCommand({ hostId: "host-qa", policyRef, reason: "qa" }))).rejects.toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("over IPC, hostile bodies never change the path or the program nft gets", async () => {
    const dir = await tempDir();
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    const sock = await serve(adapter);
    const evil = join(dir, "evil.conf");
    for (const policyRef of ["verify_baseline_firewall", "apply_dedicated_nftables_22_80_443"]) {
      const r = await raw(sock, "POST", "/v1/security", { hostId: "host-qa", policyRef, reason: "qa", rulesetPath: evil, nftablesRulesetPath: evil, args: ["-f", evil] });
      expect(r.status).toBe(200);
    }
    for (const policyRef of ["flush_ruleset", "verify_baseline_firewall -f /x", ""])
      expect((await raw(sock, "POST", "/v1/security", { hostId: "host-qa", policyRef })).status).toBeGreaterThanOrEqual(400);
    for (const body of [
      { ...SETS, blockedV4: ["203.0.113.7 } ; flush ruleset"] },
      { ...SETS, blockedV6: ["2001:db8::1\nflush ruleset"] },
      { ...SETS, openedPorts: ["8080; flush ruleset"] },
      { ...SETS, program: "flush ruleset" },
      { openedPorts: [8080] },
    ]) expect((await raw(sock, "POST", "/v1/firewall/sets", body)).status).toBe(403);
    expect((await raw(sock, "POST", "/v1/firewall/sets", SETS)).status).toBe(200);
    expect(calls.filter((c) => c.program !== undefined)).toHaveLength(1);
    expectNftCallsClosed(calls, REPO_DEDICATED_NFTABLES_RULESET_PATH);
    expect(JSON.stringify(calls)).not.toContain(evil);
  });
});

// ---- P3: generated valid lists, then the program -------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SAFE = Object.values(FIREWALL_SAFE_PORTS);

function generate(r: () => number): HostFirewallSets {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const hex = (): string => Math.floor(r() * 0x10000).toString(16);
  const openedPorts = SAFE.filter(() => r() < 0.4).sort(() => r() - 0.5);
  const grow = (n: number, make: () => string): string[] => {
    const out: string[] = [];
    for (let k = 0; k < n * 4 && out.length < n; k++) {
      const c = checkFirewallBlock(make(), { stored: out, requesterAddress: null });
      if (c.ok) out.push(c.cidr);
    }
    return out;
  };
  const big = r() < 0.05;
  const blockedV4 = grow(big ? 300 : Math.floor(r() * 12), () => {
    const base = pick(["192.0.2", "198.51.100", "203.0.113"]);
    const len = pick([24, 26, 28, 30, 31, 32, 32, 32]);
    const last = Math.floor(r() * 256) & (0xff << (32 - len)) & 0xff;
    return len === 32 ? `${base}.${last}` : `${base}.${last}/${len}`;
  });
  const blockedV6 = grow(big ? 150 : Math.floor(r() * 12), () => {
    const len = pick([32, 48, 64, 128, 128]);
    if (len === 32) return "2001:db8::/32";
    if (len === 48) return `2001:db8:${hex()}::/48`;
    if (len === 64) return `2001:db8:${hex()}:${hex()}::/64`;
    return `2001:db8:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`;
  });
  return { openedPorts, blockedV4, blockedV6 };
}

describe("P3 generated valid lists through validateFirewallSets and buildFirewallSetsProgram", () => {
  it("400 lists: only 3 flush lines and add-element lines of the 3 sets, each element round-trips", () => {
    const r = rng(0x5eed1114);
    let elements = 0;
    for (let n = 0; n < 400; n++) {
      const sets = generate(r);
      const valid = validateFirewallSets(sets);
      expect(valid).toEqual(sets);
      const got = readProgram(buildFirewallSetsProgram(valid));
      expect(got.opened_tcp_ports).toEqual(sets.openedPorts.map(String));
      expect(got.blocked_v4).toEqual(sets.blockedV4);
      expect(got.blocked_v6).toEqual(sets.blockedV6);
      for (const p of got.opened_tcp_ports!) expect(SAFE).toContain(Number(p));
      elements += sets.openedPorts.length + sets.blockedV4.length + sets.blockedV6.length;
    }
    expect(elements).toBeGreaterThan(3000);
  });

  it("parseFirewallListing reads back what was sent", () => {
    const r = rng(42);
    for (let n = 0; n < 50; n++) {
      const sets = generate(r);
      const read = parseFirewallListing(listing(sets));
      expect(read.baseRules).toBe("current");
      expect(new Set(read.openedPorts)).toEqual(new Set(sets.openedPorts));
      expect(new Set(read.blockedV4)).toEqual(new Set(sets.blockedV4));
      expect(new Set(read.blockedV6)).toEqual(new Set(sets.blockedV6));
    }
  });

  const DOC_501 = Array.from({ length: 501 }, (_, i) => (i < 256 ? `192.0.2.${i}` : `198.51.100.${i - 256}`));
  const hostile: Array<[string, HostFirewallSets | unknown]> = [
    ["999.1.1.1", { ...EMPTY, blockedV4: ["999.1.1.1"] }],
    ["a name", { ...EMPTY, blockedV4: ["example.test"] }],
    ["a text after an address", { ...EMPTY, blockedV4: ["203.0.113.7 } ; flush ruleset"] }],
    ["a newline inside an element", { ...EMPTY, blockedV4: ["203.0.113.7\nflush ruleset"] }],
    ["an address with a zone", { ...EMPTY, blockedV6: ["2001:db8::1%eth0"] }],
    ["capitals", { ...EMPTY, blockedV6: ["2001:DB8::1"] }],
    ["a non-canonical v6", { ...EMPTY, blockedV6: ["2001:db8:0:0::1"] }],
    ["a non-canonical v4", { ...EMPTY, blockedV4: ["192.0.2.07"] }],
    ["a /32 written out", { ...EMPTY, blockedV4: ["192.0.2.7/32"] }],
    ["host bits", { ...EMPTY, blockedV4: ["198.51.100.1/24"] }],
    ["v6 in the v4 list", { ...EMPTY, blockedV4: ["2001:db8::1"] }],
    ["v4 in the v6 list", { ...EMPTY, blockedV6: ["192.0.2.1"] }],
    ["a mapped v4 in the v6 list", { ...EMPTY, blockedV6: ["::ffff:192.0.2.1"] }],
    ["an overlap", { ...EMPTY, blockedV4: ["198.51.100.0/24", "198.51.100.7"] }],
    ["an overlap, smaller first", { ...EMPTY, blockedV6: ["2001:db8:1::/48", "2001:db8::/32"] }],
    ["a duplicate", { ...EMPTY, blockedV4: ["192.0.2.1", "192.0.2.1"] }],
    ["port 22", { ...EMPTY, openedPorts: [22] }],
    ["port 80", { ...EMPTY, openedPorts: [80] }],
    ["port 443", { ...EMPTY, openedPorts: [443] }],
    ["port 3000", { ...EMPTY, openedPorts: [3000] }],
    ["a duplicate port", { ...EMPTY, openedPorts: [8080, 8080] }],
    ["a port as text", { ...EMPTY, openedPorts: ["8080"] }],
    ["one address too many", { ...EMPTY, blockedV4: DOC_501 }],
    ["a missing list", { openedPorts: [], blockedV4: [] }],
    ["an extra key", { ...EMPTY, table: "x" }],
  ];
  it.each(hostile)("refuses %s before the runner, and over IPC", async (_n, body) => {
    expect(() => validateFirewallSets(body)).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED", message: "Firewall lists refused" }));
    const dir = await tempDir();
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    expect(await codeOf(adapter.replaceFirewallSets(body as HostFirewallSets))).toBe("HOST_POLICY_DENIED");
    expect(calls).toEqual([]);
    const res = await raw(await serve(adapter), "POST", "/v1/firewall/sets", body);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

// ---- P4: requestHostJob writes exactly one fixed file ------------------------------------------

function jobOut(unit: string, service: Record<string, string> = {}, path: Record<string, string> = {}): string {
  const b = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");
  return `${b({ Id: `${unit}.service`, LoadState: "loaded", ActiveState: "inactive", Result: "success", ExecMainStartTimestamp: "", ExecMainExitTimestamp: "", ExecMainStatus: "0", ...service })}\n\n${b({ Id: `${unit}.path`, LoadState: "loaded", ActiveState: "active", Result: "success", ExecMainStartTimestamp: "", ExecMainExitTimestamp: "", ExecMainStatus: "0", ...path })}\n`;
}
const tree = async (d: string): Promise<string[]> => (await readdir(d, { recursive: true })).map(String).sort();

describe("P4 host jobs create exactly the fixed file", () => {
  it.each([...HOST_JOBS])("%s writes one empty 0600 file with its fixed name and nothing else", async (job) => {
    const dir = await tempDir();
    await mkdir(join(dir, "host-jobs"));
    const unit = HOST_JOB_UNITS[job];
    const { adapter, calls } = adapterWith(() => jobOut(unit), dir);
    expect(HostJobStateWireSchema.parse(await adapter.requestHostJob(job))).toMatchObject({ job, state: "running" });
    expect(await tree(dir)).toEqual(["host-jobs", `host-jobs/${unit}`]);
    const st = await stat(join(dir, "host-jobs", unit));
    expect([st.size, st.mode & 0o777]).toEqual([0, 0o600]);
    expect(calls.map((c) => c.args)).toEqual([jobArgv(unit)]);
  });

  it.each([
    ["../x", "../x"], ["a name with a slash", "a/b"], ["capitals", "OS_REFRESH"], ["an empty string", ""],
    ["an array", ["os_refresh"]], ["null", null], ["a number", 1], ["the unit name", "hp-os-refresh"], ["a prototype key", "constructor"],
  ])("refuses %s over IPC with 403 before any file or program", async (_n, job) => {
    const dir = await tempDir();
    await mkdir(join(dir, "host-jobs"));
    const { adapter, calls } = adapterWith(() => jobOut("hp-os-refresh"), dir);
    const sock = await serve(adapter);
    expect((await raw(sock, "POST", "/v1/host-jobs", { job })).status).toBe(403);
    if (typeof job === "string") expect((await raw(sock, "GET", `/v1/host-jobs?job=${encodeURIComponent(job)}`)).status).toBe(403);
    expect(calls).toEqual([]);
    expect(await tree(join(dir, "host-jobs"))).toEqual([]);
    expect(await tree(dir)).toEqual(["host-jobs"]);
  });

  it("an existing trigger answers RESOURCE_LOCKED and is not overwritten", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "host-jobs"));
    await writeFile(join(dir, "host-jobs", "hp-panel-update"), "keep");
    const { adapter } = adapterWith(() => jobOut("hp-panel-update"), dir);
    expect(await codeOf(adapter.requestHostJob("panel_update"))).toBe("RESOURCE_LOCKED");
    expect(await readFile(join(dir, "host-jobs", "hp-panel-update"), "utf8")).toBe("keep");
  });

  it("a dangling link at the trigger path answers RESOURCE_LOCKED and its target is never created", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "host-jobs"));
    const target = join(dir, "elsewhere");
    await symlink(target, join(dir, "host-jobs", "hp-os-refresh"));
    const { adapter } = adapterWith(() => jobOut("hp-os-refresh"), dir);
    expect(await codeOf(adapter.requestHostJob("os_refresh"))).toBe("RESOURCE_LOCKED");
    expect(await stat(target).then(() => true, () => false)).toBe(false);
    expect(await readlink(join(dir, "host-jobs", "hp-os-refresh"))).toBe(target);
  });

  it("a stale trigger with no active path unit is removed and nothing else is touched (R198 2.4)", async () => {
    const dir = await tempDir();
    await mkdir(join(dir, "host-jobs"));
    await writeFile(join(dir, "host-jobs", "hp-os-upgrade"), "");
    await writeFile(join(dir, "host-jobs", "hp-os-refresh"), "");
    const { adapter } = adapterWith(() => jobOut("hp-os-upgrade", {}, { ActiveState: "inactive" }), dir);
    expect(await codeOf(adapter.requestHostJob("os_upgrade"))).toBe("NOT_SUPPORTED");
    expect(await tree(join(dir, "host-jobs"))).toEqual(["hp-os-refresh"]);
  });
});

// ---- P5: parsers take hostile lines as data ---------------------------------------------------

async function expectDataOrFixedSentence<T>(p: Promise<T>, check: (v: T) => void): Promise<void> {
  try {
    check(await p);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === undefined) throw err;
    expect(e.code).toBe("NOT_SUPPORTED");
    expect(e.message).toBe(TOOL_FAILED);
  }
}
const svc = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join("\n");

describe("P5 hostile program output", () => {
  const GOOD = HOST_SERVICE_UNITS.map((u) => ({ Id: `${u}.service`, ActiveState: "active", ActiveEnterTimestamp: "@1794902400", NRestarts: "0" }));
  it.each([
    ["blocks out of order", [...GOOD].reverse().map(svc).join("\n\n")],
    ["a missing key", [{ Id: "hp-api.service", ActiveState: "active" }, ...GOOD.slice(1)].map(svc).join("\n\n")],
    ["a value with =", [{ ...GOOD[0]!, ActiveState: "active=1" }, ...GOOD.slice(1)].map(svc).join("\n\n")],
    ["an Id with =", [{ ...GOOD[0]!, Id: "hp-api.service=x" }, ...GOOD.slice(1)].map(svc).join("\n\n")],
    ["a newline-like sequence", [{ ...GOOD[0]!, ActiveState: "active\\nId=ssh.service" }, ...GOOD.slice(1)].map(svc).join("\n\n")],
    ["a CR line end", GOOD.map(svc).join("\r\n\r\n")],
    ["a timestamp in another form", [{ ...GOOD[0]!, ActiveEnterTimestamp: "Tue 2026-11-17 08:00:00 UTC" }, ...GOOD.slice(1)].map(svc).join("\n\n")],
    ["a fifth block outside the list", [...GOOD, { ...GOOD[0]!, Id: "ssh.service" }].map(svc).join("\n\n")],
    ["a repeated block", [...GOOD, GOOD[0]!].map(svc).join("\n\n")],
    ["NRestarts not a number", [{ ...GOOD[0]!, NRestarts: "1e3" }, ...GOOD.slice(1)].map(svc).join("\n\n")],
  ])("systemctl show with %s: a schema-valid answer or the fixed sentence", async (_n, out) => {
    const { adapter } = adapterWith(() => out, await tempDir());
    await expectDataOrFixedSentence(adapter.readHostServices(), (v) => {
      expect(v).toHaveLength(4);
      for (const s of v) HostServiceStateWireSchema.parse(s);
      expect(v.map((s) => s.unit)).toEqual([...HOST_SERVICE_UNITS]);
    });
  });

  const APT_TAIL = "\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n";
  const inst = (name: string): string => `Inst ${name} [1.0-1] (1.0-2 Example:13/stable-security [amd64])`;
  it.each([
    ["a name with a space", `${inst("qa pkg")}\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`],
    ["a shell metacharacter", `${inst("qa;pkg$(x)")}\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`],
    ["markup", `${inst("<script>qa</script>")}\n1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n`],
    ["a count mismatch", `${inst("qa-pkg")}${APT_TAIL}`],
    ["a 100,000-char line", `Inst ${"q".repeat(100_000)}${APT_TAIL}`],
    ["no summary line", inst("qa-pkg")],
  ])("apt-get -s upgrade with %s: a schema-valid answer or the fixed sentence", async (_n, out) => {
    const { adapter } = adapterWith(() => out, await tempDir());
    await expectDataOrFixedSentence(adapter.readOsPackages(), (v) => {
      HostOsPackagesWireSchema.parse(v);
      for (const p of v.packages) expect(p.name).toMatch(/^[a-z0-9][a-z0-9+.-]*$/);
    });
  });

  // Defect posted on the channel (TEAM.md message 682): INST_LINE backtracks quadratically.
  it("apt-get -s upgrade with a 96,000-char bracket line is refused within 250 ms", () => {
    const line = `Inst a [1] (2 ${" [x".repeat(32_000)}`;
    const t = performance.now();
    expect(() => parseAptUpgradeSimulation(`${line}${APT_TAIL}`)).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED" }));
    expect(performance.now() - t).toBeLessThan(250);
  });

  const jl = (o: unknown): string => JSON.stringify(o);
  it.each([
    ["control characters", jl({ __REALTIME_TIMESTAMP: "1794902400123456", MESSAGE: "a\u0000b\u0007c\u001b[31mred\u001b[0m\u009b2J" })],
    ["a message as a byte array (non-UTF8)", jl({ __REALTIME_TIMESTAMP: "1794902400123456", MESSAGE: [0xff, 0xfe, 0x41, 0x1b] })],
    ["extra JSON keys", `{"__REALTIME_TIMESTAMP":"1794902400123456","MESSAGE":"ok","_CMDLINE":"x","__proto__":{"polluted":1},"constructor":"x"}`],
    ["a null message", jl({ __REALTIME_TIMESTAMP: "1794902400123456", MESSAGE: null })],
    ["a missing timestamp", jl({ MESSAGE: "x" })],
    ["a line that is not JSON", "{\"MESSAGE\": \"x\""],
    ["a 20,000-char message", jl({ __REALTIME_TIMESTAMP: "1794902400123456", MESSAGE: "q".repeat(20_000) })],
    ["a lone surrogate", `{"__REALTIME_TIMESTAMP":"1794902400123456","MESSAGE":"\\ud800x"}`],
  ])("journalctl with %s: schema-valid single-line data or the fixed sentence", async (_n, out) => {
    const { adapter } = adapterWith(() => out, await tempDir());
    await expectDataOrFixedSentence(adapter.readHostJournal("hp-api", 10), (v) => {
      for (const l of v) {
        HostJournalLineWireSchema.parse(l);
        expect([...l.message].filter((ch) => { const c = ch.codePointAt(0)!; return c < 0x20 || (c >= 0x7f && c <= 0x9f); })).toEqual([]);
        expect(l.message.length).toBeLessThanOrEqual(4096);
      }
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("no thrown error, no IPC answer and no console or stdio write holds program output", async () => {
    const seen: string[] = [];
    const spies = [
      ...(["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void seen.push(a.map(String).join(" ")))),
      vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (seen.push(String(c)), true)),
      vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (seen.push(String(c)), true)),
    ];
    try {
      const outs = [
        { stdout: `${MARK} out`, stderr: `${MARK} err` },
        Object.assign(new Error(`Command failed: ${MARK}`), { stdout: MARK, stderr: `Error: ${MARK}` }),
        Object.assign(new Error(`${MARK} Operation not permitted`), { stderr: `Error: ${MARK} Operation not permitted` }),
        Object.assign(new Error(`${MARK}`), { code: "ETIMEDOUT", stderr: MARK }),
      ];
      for (const out of outs) {
        const dir = await tempDir();
        await mkdir(join(dir, "host-jobs"));
        const { adapter } = adapterWith(() => out, dir);
        const errors: string[] = [];
        const grab = async (p: Promise<unknown>) => {
          try {
            errors.push(JSON.stringify(await p));
          } catch (e) {
            errors.push(String((e as Error).message), JSON.stringify(e), String((e as Error).stack));
          }
        };
        await grab(adapter.readFirewall());
        await grab(adapter.replaceFirewallSets(SETS));
        await grab(adapter.readHostServices());
        await grab(adapter.readHostJournal("hp-api", 10));
        await grab(adapter.readOsPackages());
        await grab(adapter.requestHostJob("os_refresh"));
        await grab(adapter.readHostJob("os_refresh"));
        for (const policyRef of ["verify_baseline_firewall", "apply_dedicated_nftables_22_80_443"] as const)
          await grab(adapter.executeSecurityPolicy(createApprovedHostSecurityCommand({ hostId: "host-qa", policyRef, reason: "qa" })));
        const sock = await serve(adapter);
        for (const [m, p, b] of [
          ["GET", "/v1/firewall"], ["POST", "/v1/firewall/sets", SETS], ["GET", "/v1/host-services"],
          ["GET", "/v1/host-journal?unit=hp-api&lines=10"], ["GET", "/v1/os-packages"],
          ["POST", "/v1/host-jobs", { job: "os_refresh" }], ["GET", "/v1/host-jobs?job=os_refresh"],
          ["POST", "/v1/security", { hostId: "host-qa", policyRef: "verify_baseline_firewall" }],
          ["POST", "/v1/security", { hostId: "host-qa", policyRef: "apply_dedicated_nftables_22_80_443" }],
        ] as Array<["GET" | "POST", string, unknown?]>) errors.push((await raw(sock, m, p, b)).text);
        for (const e of errors) expect(e).not.toContain(MARK);
      }
      for (const s of seen) expect(s).not.toContain(MARK);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});

// ---- P6: the seven new routes refuse unsigned, tampered and old requests before the adapter -------

describe("P6 signed IPC on the seven M5d routes", () => {
  const ROUTES: Array<["GET" | "POST", string, unknown?]> = [
    ["GET", "/v1/firewall"], ["POST", "/v1/firewall/sets", SETS], ["GET", "/v1/host-services"],
    ["GET", "/v1/host-journal?unit=hp-api&lines=10"], ["GET", "/v1/os-packages"],
    ["POST", "/v1/host-jobs", { job: "os_refresh" }], ["GET", "/v1/host-jobs?job=os_refresh"],
  ];
  const CASES = ROUTES.flatMap(([m, p, b]) => (["none", "tampered", "old"] as const).map((s): [typeof s, "GET" | "POST", string, unknown] => [s, m, p, b]));
  it.each(CASES)(
    "refuses %s signature on %s %s with 401 before the adapter",
    async (sign, method, path, body) => {
      const dir = await tempDir();
      await mkdir(join(dir, "host-jobs"));
      const { adapter, calls } = adapterWith(() => CURRENT, dir);
      const spies = (["readFirewall", "replaceFirewallSets", "readHostServices", "readHostJournal", "readOsPackages", "requestHostJob", "readHostJob"] as const).map((m) => vi.spyOn(adapter, m));
      const res = await raw(await serve(adapter), method, path, body, sign);
      expect(res.status).toBe(401);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(await tree(join(dir, "host-jobs"))).toEqual([]);
    },
  );

  it.each([
    ["lines -1", "/v1/host-journal?unit=hp-api&lines=-1"], ["lines empty", "/v1/host-journal?unit=hp-api&lines="],
    ["lines with a space", "/v1/host-journal?unit=hp-api&lines=%2010"], ["lines 500.0", "/v1/host-journal?unit=hp-api&lines=500.0"],
    ["lines 1000", "/v1/host-journal?unit=hp-api&lines=1000"], ["no lines", "/v1/host-journal?unit=hp-api"],
    ["a unit with .service", "/v1/host-journal?unit=hp-api.service&lines=10"], ["a unit ../x", "/v1/host-journal?unit=..%2Fx&lines=10"],
    ["a unit outside the list", "/v1/host-journal?unit=ssh&lines=10"], ["a unit in capitals", "/v1/host-journal?unit=HP-API&lines=10"],
  ])("refuses %s with 403 before the adapter", async (_n, path) => {
    const dir = await tempDir();
    const { adapter, calls } = adapterWith(() => "", dir);
    const res = await raw(await serve(adapter), "GET", path);
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  // Design note: the three routes without parameters ignore a query; it never reaches a program.
  it("a query on a route without parameters changes nothing in the argument lists", async () => {
    const dir = await tempDir();
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    const sock = await serve(adapter);
    for (const p of ["/v1/firewall?x=1", "/v1/host-services?unit=ssh", "/v1/os-packages?args=-o"]) await raw(sock, "GET", p);
    expect(calls.map((c) => [c.binary.endsWith("/nft") ? "nft" : c.binary, c.args])).toEqual([
      ["nft", NFT_LIST], ["/usr/bin/systemctl", SERVICES_ARGV], ["/usr/bin/apt-get", ["-s", "upgrade"]],
    ]);
  });

  it("accepts lines 1 and 500 with the exact journalctl form", async () => {
    const dir = await tempDir();
    const { adapter, calls } = adapterWith(() => "", dir);
    const sock = await serve(adapter);
    for (const n of ["1", "500"]) expect((await raw(sock, "GET", `/v1/host-journal?unit=hp-web&lines=${n}`)).status).toBe(200);
    expect(calls.map((c) => c.args)).toEqual([journalArgv("hp-web", "1"), journalArgv("hp-web", "500")]);
  });
});

// ---- P7: the ruleset file -------------------------------------------------------------------------

describe("P7 the dedicated ruleset", () => {
  const METADATA_DROPS = [
    'iifname "docker0" ip daddr 169.254.0.0/16 drop', 'iifname "br-*" ip daddr 169.254.0.0/16 drop',
    'iifname "docker0" ip6 daddr fd00:ec2::254 drop', 'iifname "br-*" ip6 daddr fd00:ec2::254 drop',
  ];
  const read = (): Promise<string> => readFile(join(ROOT, "infra/linux/nftables-dedicated.conf"), "utf8");
  const body = (text: string, chain: string): string[] =>
    new RegExp(`chain ${chain} \\{\\n([\\s\\S]*?)\\n  \\}`).exec(text)![1]!.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

  it("its SHA-256 equals the pin", async () => {
    expect(createHash("sha256").update(await readFile(REPO_DEDICATED_NFTABLES_RULESET_PATH)).digest("hex")).toBe(DEDICATED_NFTABLES_RULESET_SHA256);
  });

  it("prerouting accepts 22 before any drop, and the blocked sets are used only to drop", async () => {
    const text = await read();
    const pre = body(text, "prerouting");
    expect(pre[0]).toBe("type filter hook prerouting priority raw; policy accept;");
    const i22 = pre.indexOf("tcp dport 22 accept");
    expect(i22).toBeGreaterThan(0);
    expect(pre.slice(0, i22 + 1).some((l) => /\bdrop\b|\breject\b/.test(l))).toBe(false);
    expect(pre.slice(i22 + 1)).toEqual([
      "icmpv6 type { nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept",
      "ip saddr @blocked_v4 drop",
      "ip6 saddr @blocked_v6 drop",
    ]);
    expect(text.match(/@blocked_v4/g)).toHaveLength(1);
    expect(text.match(/@blocked_v6/g)).toHaveLength(1);
  });

  it("80/443/22 are fixed rules, the opened set only accepts, 3000 only from the bridges, and the only drops are the designed ones", async () => {
    const text = await read();
    const input = body(text, "input");
    expect(input[0]).toBe("type filter hook input priority filter; policy drop;");
    expect(input).toContain("tcp dport { 22, 80, 443 } ct state new accept");
    expect(input).toContain("tcp dport @opened_tcp_ports ct state new accept");
    expect(text.match(/@opened_tcp_ports/g)).toHaveLength(1);
    expect(input.filter((l) => l.includes("3000"))).toEqual([
      'iifname "docker0" tcp dport 3000 ct state new accept', 'iifname "br-*" tcp dport 3000 ct state new accept',
    ]);
    const drops = text.split("\n").map((l) => l.trim()).filter((l) => /\bdrop\b/.test(l) && !l.startsWith("type "));
    expect(drops).toEqual(["ip saddr @blocked_v4 drop", "ip6 saddr @blocked_v6 drop", "ct state invalid drop", ...METADATA_DROPS]);
    expect(text).not.toMatch(/flush ruleset|include|define|\$|reject|jump|goto/);
    expect(new Set([...text.matchAll(/table (\S+ \S+)/g)].map((m) => m[1]))).toEqual(new Set([TABLE]));
    expect(text).toMatch(/set opened_tcp_ports \{\s*type inet_service\s*\}/);
    expect(text).toMatch(/set blocked_v4 \{\s*type ipv4_addr\s*flags interval\s*\}/);
    expect(text).toMatch(/set blocked_v6 \{\s*type ipv6_addr\s*flags interval\s*\}/);
  });

  // R207 host.1: a site's code never reaches the cloud metadata address; nothing else of the file moved.
  it("the forward chain accepts by default, passes DNS and drops only bridge traffic to the metadata addresses", async () => {
    const text = await read();
    const forward = body(text, "forward");
    // R207 addendum 2 A: DNS to the link-local resolver passes before the drops (policy accept, so from any interface).
    expect(forward).toEqual([
      "type filter hook forward priority filter; policy accept;",
      "ip daddr 169.254.0.0/16 udp dport 53 accept", "ip daddr 169.254.0.0/16 tcp dport 53 accept", ...METADATA_DROPS,
    ]);
    const block = /\n(?: {2}# [^\n]*\n)+ {2}chain forward \{\n[\s\S]*?\n {2}\}\n/.exec(text)![0];
    // The file before host.1 (pinned in cycle 14): prerouting, input, output and the sets are byte for byte the same.
    expect(createHash("sha256").update(text.replace(block, "")).digest("hex")).toBe("80c56bc1101e13b8e858fd0cf5f26bb74684f637050656bd0ef8372284011651");
  });

  // A blocked address still reaches tcp 22 (accepted before the drops so the operator cannot lock out SSH),
  // ICMPv6 neighbour discovery (so IPv6 keeps working), and anything arriving on lo, docker0 or br-*.
  it("a blocked address can still reach exactly 22, ND, and the local and bridge interfaces", async () => {
    const pre = body(await read(), "prerouting");
    const beforeDrops = pre.slice(1, pre.indexOf("ip saddr @blocked_v4 drop"));
    expect(beforeDrops).toEqual([
      'iifname "lo" accept', 'iifname "docker0" accept', 'iifname "br-*" accept', "tcp dport 22 accept",
      "icmpv6 type { nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept",
    ]);
  });
});
