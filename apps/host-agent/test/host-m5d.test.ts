import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  HostFirewallStateWireSchema,
  HostOsPackagesWireSchema,
  signIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKeyring,
} from "@hosting-panel/contracts";
import { HOST_JOB_UNITS, HOST_JOBS, createApprovedHostSecurityCommand, type HostFirewallSets, type HostJob } from "@hosting-panel/host-agent-contracts";

// No test of this file may start a real program: execFile is a spy that fails unless a test sets it.
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify: p } = await import("node:util");
  const real = await importOriginal<typeof import("node:child_process")>();
  const fail = (): never => {
    throw new Error("a real program must not start in this test");
  };
  return { ...real, execFile: Object.assign(vi.fn(fail), { [p.custom]: vi.fn(fail) }) };
});

// A list file apt-get update removes between readdir and stat, and one stat refuses (R202 3).
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const fsError = (code: string) => Object.assign(new Error(`${code}: sentinel`), { code });
  return {
    ...real,
    stat: (async (path: Parameters<typeof real.stat>[0], ...rest: unknown[]) => {
      if (String(path).endsWith("vanished_Packages")) throw fsError("ENOENT");
      if (String(path).endsWith("denied_Packages")) throw fsError("EACCES");
      return (real.stat as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof real.stat,
  };
});

const { execFile } = await import("node:child_process");
const {
  HostAgentIpcServer,
  InMemoryHostSimulatorAdapter,
  REPO_DEDICATED_NFTABLES_RULESET_PATH,
  LinuxSystemHostAdapter,
  SignedHostAgentIpcClient,
  isClosedArgumentForm,
  parseAptUpgradeSimulation,
  parseFirewallListing,
  parseHostServices,
  parseJournalJson,
  parseSystemctlShow,
  hostJobState,
  runAllowlistedBinary,
} = await import("../src/index.js");
type ExecFileRunner = import("../src/index.js").ExecFileRunner;
type AllowedLinuxBinary = import("../src/index.js").AllowedLinuxBinary;

const execFileCustom = (execFile as unknown as Record<symbol, Mock>)[promisify.custom]!;

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

async function code(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => "resolved", (e: unknown) => (e as { code?: unknown }).code);
}

describe("closed argument forms (R198 2.1)", () => {
  it("accepts exactly the forms of the design", () => {
    expect(isClosedArgumentForm("/usr/bin/systemctl", SERVICES_ARGV)).toBe(true);
    for (const unit of Object.values(HOST_JOB_UNITS)) expect(isClosedArgumentForm("/usr/bin/systemctl", jobArgv(unit))).toBe(true);
    for (const unit of ["hp-api", "hp-web", "hp-docker-executor", "hp-host-agent", "hp-panel-update", "hp-os-refresh", "hp-os-upgrade"])
      for (const n of ["1", "100", "500"]) expect(isClosedArgumentForm("/usr/bin/journalctl", journalArgv(unit, n))).toBe(true);
    expect(isClosedArgumentForm("/usr/bin/apt-get", ["-s", "upgrade"])).toBe(true);
  });

  const swap = <T>(a: readonly T[], i: number): T[] => {
    const b = [...a];
    [b[i], b[i + 1]] = [b[i + 1]!, b[i]!];
    return b;
  };
  const refused: Array<[string, AllowedLinuxBinary, string[]]> = [
    ["systemctl with an appended argument", "/usr/bin/systemctl", [...SERVICES_ARGV, "--now"]],
    ["systemctl job form with an appended argument", "/usr/bin/systemctl", [...jobArgv("hp-os-refresh"), "x.service"]],
    ["systemctl with a swapped order", "/usr/bin/systemctl", swap(SERVICES_ARGV, 4)],
    ["systemctl job form with a swapped order", "/usr/bin/systemctl", swap(jobArgv("hp-os-refresh"), 4)],
    ["systemctl on a unit outside the list", "/usr/bin/systemctl", jobArgv("sshd")],
    ["systemctl with three services", "/usr/bin/systemctl", SERVICES_ARGV.slice(0, -1)],
    ["systemctl restart", "/usr/bin/systemctl", ["restart", "hp-api.service"]],
    ["systemctl with no argument", "/usr/bin/systemctl", []],
    ["journalctl with an appended argument", "/usr/bin/journalctl", [...journalArgv("hp-api", "10"), "--file=/x"]],
    ["journalctl with a swapped order", "/usr/bin/journalctl", swap(journalArgv("hp-api", "10"), 2)],
    ["journalctl on a unit outside the list", "/usr/bin/journalctl", journalArgv("sshd", "10")],
    ["journalctl --lines=0", "/usr/bin/journalctl", journalArgv("hp-api", "0")],
    ["journalctl --lines=501", "/usr/bin/journalctl", journalArgv("hp-api", "501")],
    ["journalctl --lines=1e2", "/usr/bin/journalctl", journalArgv("hp-api", "1e2")],
    ["journalctl --lines=010", "/usr/bin/journalctl", journalArgv("hp-api", "010")],
    ["journalctl --file=/x", "/usr/bin/journalctl", ["--file=/x", ...journalArgv("hp-api", "10").slice(1)]],
    ["journalctl --vacuum-size=1", "/usr/bin/journalctl", ["--vacuum-size=1"]],
    ["journalctl with no argument", "/usr/bin/journalctl", []],
    ["apt-get with an appended argument", "/usr/bin/apt-get", ["-s", "upgrade", "-y"]],
    ["apt-get with a swapped order", "/usr/bin/apt-get", ["upgrade", "-s"]],
    ["apt-get install", "/usr/bin/apt-get", ["install", "examplelib"]],
    ["apt-get with no argument", "/usr/bin/apt-get", []],
  ];
  it.each(refused)("refuses %s before anything starts", async (_name, binary, args) => {
    expect(isClosedArgumentForm(binary, args)).toBe(false);
    await expect(runAllowlistedBinary(binary, args)).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect(execFileCustom).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("starts an accepted form with execFile, no shell, the fixed environment and the input on stdin", async () => {
    const end = vi.fn();
    execFileCustom.mockImplementationOnce(() =>
      Object.assign(Promise.resolve({ stdout: "out", stderr: "" }), { child: { stdin: { on: vi.fn(), end } } }),
    );
    await expect(runAllowlistedBinary("/usr/sbin/nft", ["-f", "-"], { input: "flush set x\n" })).resolves.toEqual({ stdout: "out", stderr: "" });
    expect(execFileCustom).toHaveBeenCalledWith("/usr/sbin/nft", ["-f", "-"], expect.objectContaining({
      shell: false, timeout: 10_000, maxBuffer: 256 * 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    }));
    expect(end).toHaveBeenCalledWith("flush set x\n");
    execFileCustom.mockClear();
  });
});

// ---- parsers ---------------------------------------------------------------------------------

function block(props: Record<string, string>): string {
  return Object.entries(props).map(([k, v]) => `${k}=${v}`).join("\n");
}
const SERVICES_OUT = [
  block({ NRestarts: "0", Id: "hp-web.service", ActiveState: "active", ActiveEnterTimestamp: "@1794902400" }),
  block({ Id: "hp-api.service", ActiveState: "active", ActiveEnterTimestamp: "@1794902401", NRestarts: "2" }),
  block({ Id: "hp-host-agent.service", ActiveState: "activating", ActiveEnterTimestamp: "", NRestarts: "0" }),
  block({ Id: "hp-docker-executor.service", ActiveState: "failed", ActiveEnterTimestamp: "@1794902402", NRestarts: "7" }),
].join("\n\n") + "\n";

describe("systemctl show", () => {
  it("reads the four services from blocks out of order", () => {
    expect(parseHostServices(SERVICES_OUT)).toEqual([
      { unit: "hp-api", active: true, activeState: "active", since: "2026-11-17T08:00:01.000Z", restarts: 2 },
      { unit: "hp-web", active: true, activeState: "active", since: "2026-11-17T08:00:00.000Z", restarts: 0 },
      { unit: "hp-docker-executor", active: false, activeState: "failed", since: "2026-11-17T08:00:02.000Z", restarts: 7 },
      { unit: "hp-host-agent", active: false, activeState: "activating", since: null, restarts: 0 },
    ]);
  });

  it.each([
    ["a missing service", SERVICES_OUT.split("\n\n").slice(1).join("\n\n")],
    ["a line without =", `${SERVICES_OUT}\ngarbage`],
    ["a timestamp in another form", SERVICES_OUT.replace("@1794902400", "Tue 2026-11-17 06:20:00 CET")],
    ["a restart count that is not a number", SERVICES_OUT.replace("NRestarts=2", "NRestarts=two")],
    ["an empty answer", ""],
  ])("refuses %s with a fixed sentence", (_name, text) => {
    expect(() => parseHostServices(text)).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED", message: "A host tool failed or gave an answer the agent cannot read" }));
  });

  it("reads a not-found unit as a block like any other", () => {
    const blocks = parseSystemctlShow("Id=hp-os-refresh.service\nLoadState=not-found\nActiveState=inactive\n");
    expect(blocks.get("hp-os-refresh.service")).toMatchObject({ LoadState: "not-found" });
  });
});

const SVC = { Id: "hp-os-refresh.service", LoadState: "loaded", ActiveState: "inactive", Result: "success", ExecMainStartTimestamp: "", ExecMainExitTimestamp: "", ExecMainStatus: "0" };
const PATH_UNIT = { Id: "hp-os-refresh.path", LoadState: "loaded", ActiveState: "active", Result: "success", ExecMainStartTimestamp: "", ExecMainExitTimestamp: "", ExecMainStatus: "0" };
const jobOut = (svc: Partial<typeof SVC> = {}, path: Partial<typeof PATH_UNIT> = {}): string =>
  `${block({ ...PATH_UNIT, ...path })}\n\n${block({ ...SVC, ...svc })}\n`;
const RAN = { ExecMainStartTimestamp: "@1794902400", ExecMainExitTimestamp: "@1794902460" };

describe("job state, the six rules in order", () => {
  const state = (text: string, trigger = false) => hostJobState("os_refresh", parseSystemctlShow(text), trigger);

  it("1. a unit that is not loaded is NOT_SUPPORTED", () => {
    expect(() => state(jobOut({ LoadState: "not-found" }))).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED" }));
    expect(() => state(jobOut({}, { LoadState: "not-found" }))).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED" }));
  });
  it("2. a failed path unit with the file present is failed with no status", () => {
    expect(state(jobOut({ ...RAN }, { ActiveState: "failed" }), true)).toMatchObject({ state: "failed", exitStatus: null });
  });
  it("3. the file present, or the service activating or deactivating, is running", () => {
    expect(state(jobOut({ ...RAN }), true)).toEqual({ job: "os_refresh", state: "running", exitStatus: null, startedAt: "2026-11-17T08:00:00.000Z", endedAt: null });
    expect(state(jobOut({ ActiveState: "activating", ExecMainStartTimestamp: "@1794902400" }))).toMatchObject({ state: "running" });
    expect(state(jobOut({ ActiveState: "deactivating", ExecMainStartTimestamp: "@1794902400" }))).toMatchObject({ state: "running" });
  });
  it("4. a failed service is failed, with its status only when it exited", () => {
    expect(state(jobOut({ ...RAN, ActiveState: "failed", Result: "exit-code", ExecMainStatus: "1" }))).toEqual({
      job: "os_refresh", state: "failed", exitStatus: 1, startedAt: "2026-11-17T08:00:00.000Z", endedAt: "2026-11-17T08:01:00.000Z",
    });
    expect(state(jobOut({ ActiveState: "failed", Result: "exit-code", ExecMainStartTimestamp: "@1794902400", ExecMainStatus: "0" }))).toMatchObject({ state: "failed", exitStatus: null, endedAt: null });
  });
  it("5. success with an exit time is succeeded", () => {
    expect(state(jobOut({ ...RAN }))).toEqual({ job: "os_refresh", state: "succeeded", exitStatus: 0, startedAt: "2026-11-17T08:00:00.000Z", endedAt: "2026-11-17T08:01:00.000Z" });
  });
  it("6. otherwise never run", () => {
    expect(state(jobOut())).toEqual({ job: "os_refresh", state: "never_run", exitStatus: null, startedAt: null, endedAt: null });
  });
  it("refuses an exit status that is not a number", () => {
    expect(() => state(jobOut({ ...RAN, ActiveState: "failed", ExecMainStatus: "x" }))).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED" }));
  });
});

const jl = (fields: Record<string, unknown>): string =>
  JSON.stringify({ __CURSOR: "s=0;i=1", __REALTIME_TIMESTAMP: "1794902400123456", __MONOTONIC_TIMESTAMP: "1", _BOOT_ID: "0f", ...fields });

describe("journal JSON lines", () => {
  it("reads a string, a byte array, null, and replaces control characters", () => {
    const text = [
      jl({ MESSAGE: "Started example unit." }),
      jl({ MESSAGE: [104, 105, 0xff, 9, 27, 91, 49, 109] }),
      jl({ MESSAGE: null }),
      jl({ MESSAGE: "bell\u0007 and c1\u0085 kept\ttab" }),
      "",
    ].join("\n");
    expect(parseJournalJson(text)).toEqual([
      { at: "2026-11-17T08:00:00.123Z", message: "Started example unit." },
      { at: "2026-11-17T08:00:00.123Z", message: "hi�\t�[1m" },
      { at: "2026-11-17T08:00:00.123Z", message: "(line too long to show)" },
      { at: "2026-11-17T08:00:00.123Z", message: "bell� and c1� kept\ttab" },
    ]);
  });
  it("cuts a message at the wire length", () => {
    expect(parseJournalJson(jl({ MESSAGE: "x".repeat(5000) }))[0]!.message).toHaveLength(4096);
  });
  it("answers an empty list for an empty journal", () => {
    expect(parseJournalJson("")).toEqual([]);
  });
  it.each([
    ["a line that is not JSON", "-- No entries --"],
    ["a message of another type", jl({ MESSAGE: { a: 1 } })],
    ["a byte array with a value over 255", jl({ MESSAGE: [256] })],
    ["a missing timestamp", JSON.stringify({ MESSAGE: "x" })],
    ["a timestamp that is not a number", jl({ __REALTIME_TIMESTAMP: "soon", MESSAGE: "x" })],
  ])("refuses %s", (_name, text) => {
    expect(() => parseJournalJson(text)).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED" }));
  });
});

const APT_OUT = `NOTE: This is only a simulation!
      apt-get needs root privileges for real execution.
      Keep also in mind that locking is deactivated,
      so don't depend on the relevance to the real current situation!
Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages will be upgraded:
  examplelib othertool sample-tool vendorpkg
4 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
Inst examplelib [1.0-1] (1.0-2 Ubuntu:24.04/noble-security [amd64])
Inst sample-tool [2.1-1] (2.2-1 Ubuntu:24.04/noble-updates [all]) []
Inst othertool:amd64 [3.0~rc1] (3.0+dfsg-1 Example Vendor:stable/stable, Debian:12.5/stable, Debian-Security:12/stable-security [amd64]) [examplelib:amd64 ]
Inst vendorpkg [1:1.0] (1:1.1 Example Vendor:stable/stable [amd64])
Conf examplelib (1.0-2 Ubuntu:24.04/noble-security [amd64])
Conf sample-tool (2.2-1 Ubuntu:24.04/noble-updates [all])
`;

describe("apt-get -s upgrade", () => {
  it("reads every Inst line with its origin class", () => {
    expect(parseAptUpgradeSimulation(APT_OUT)).toEqual([
      { name: "examplelib", installedVersion: "1.0-1", newVersion: "1.0-2", origin: "security" },
      { name: "sample-tool", installedVersion: "2.1-1", newVersion: "2.2-1", origin: "distribution" },
      { name: "othertool:amd64", installedVersion: "3.0~rc1", newVersion: "3.0+dfsg-1", origin: "security" },
      { name: "vendorpkg", installedVersion: "1:1.0", newVersion: "1:1.1", origin: "other" },
    ]);
  });
  it("reads nothing to upgrade", () => {
    expect(parseAptUpgradeSimulation("Calculating upgrade...\n0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n")).toEqual([]);
  });
  it.each([
    ["a count that does not match", APT_OUT.replace("4 upgraded", "5 upgraded")],
    ["no count line", APT_OUT.replace(/^4 upgraded.*$/m, "")],
    ["an Inst line of another form", APT_OUT.replace("Inst vendorpkg [1:1.0]", "Inst vendorpkg 1:1.0")],
    ["a name outside the wire form", APT_OUT.replace("Inst vendorpkg", "Inst Vendor$pkg")],
  ])("refuses %s", (_name, text) => {
    expect(() => parseAptUpgradeSimulation(text)).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED" }));
  });
});

// The listing in the JSON form nft prints (libnftables-json), with invented addresses.
function listing(sets: Array<{ name: string; type: string; elem?: unknown[] }>): string {
  return JSON.stringify({
    nftables: [
      { metainfo: { version: "1.1.6", json_schema_version: 1 } },
      { table: { family: "inet", name: "hp_dedicated_filter", handle: 3 } },
      { chain: { family: "inet", table: "hp_dedicated_filter", name: "input", handle: 2, type: "filter", hook: "input", prio: 0, policy: "drop" } },
      ...sets.map((s, i) => ({ set: { family: "inet", name: s.name, table: "hp_dedicated_filter", type: s.type, handle: 4 + i, ...(s.elem ? { elem: s.elem } : {}) } })),
      { rule: { family: "inet", table: "hp_dedicated_filter", chain: "input", handle: 21, expr: [] } },
    ],
  });
}
const CURRENT = listing([
  { name: "opened_tcp_ports", type: "inet_service", elem: [9100, 8080] },
  { name: "blocked_v4", type: "ipv4_addr", elem: [{ prefix: { addr: "198.51.100.0", len: 24 } }, "192.0.2.1"] },
  { name: "blocked_v6", type: "ipv6_addr", elem: ["2001:db8::2"] },
]);

describe("parseFirewallListing", () => {
  it("reads a current table and sorts the lists as the simulator does", () => {
    expect(parseFirewallListing(CURRENT)).toEqual({
      baseRules: "current", openedPorts: [8080, 9100], blockedV4: ["192.0.2.1", "198.51.100.0/24"], blockedV6: ["2001:db8::2"],
    });
  });
  it("reads a set with no elem key as empty", () => {
    expect(parseFirewallListing(listing([
      { name: "opened_tcp_ports", type: "inet_service" },
      { name: "blocked_v4", type: "ipv4_addr" },
      { name: "blocked_v6", type: "ipv6_addr", elem: [{ prefix: { addr: "2001:db8:1::", len: 48 } }] },
    ]))).toEqual({ baseRules: "current", openedPorts: [], blockedV4: [], blockedV6: ["2001:db8:1::/48"] });
  });
  it("reads a table without the three sets as outdated", () => {
    expect(parseFirewallListing(listing([]))).toEqual({ baseRules: "outdated", openedPorts: [], blockedV4: [], blockedV6: [] });
    expect(parseFirewallListing(listing([{ name: "blocked_v4", type: "ipv4_addr" }]))).toMatchObject({ baseRules: "outdated" });
    expect(parseFirewallListing(listing([
      { name: "opened_tcp_ports", type: "inet_service" }, { name: "blocked_v4", type: "ipv6_addr" }, { name: "blocked_v6", type: "ipv6_addr" },
    ]))).toMatchObject({ baseRules: "outdated" });
  });
  it.each([
    ["a range element", listing([
      { name: "opened_tcp_ports", type: "inet_service" },
      { name: "blocked_v4", type: "ipv4_addr", elem: [{ range: ["192.0.2.1", "192.0.2.9"] }] },
      { name: "blocked_v6", type: "ipv6_addr" },
    ])],
    ["an address in the port set", listing([
      { name: "opened_tcp_ports", type: "inet_service", elem: ["192.0.2.1"] },
      { name: "blocked_v4", type: "ipv4_addr" }, { name: "blocked_v6", type: "ipv6_addr" },
    ])],
    ["a text that is not JSON", "Error: something"],
    ["JSON of another form", JSON.stringify({ tables: [] })],
  ])("refuses %s", (_name, text) => {
    expect(() => parseFirewallListing(text)).toThrow(expect.objectContaining({ code: "NOT_SUPPORTED" }));
  });
});

// ---- the Linux adapter with the program runner mocked -----------------------------------------

interface Call { readonly binary: AllowedLinuxBinary; readonly args: readonly string[]; readonly input?: string; readonly maxBuffer?: number }

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), "hp-m5d-"));
  tempDirs.push(dir);
  await writeFile(join(dir, "hosting-panel.nft"), "# installer copy\n");
  return dir;
}
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function adapterWith(answer: (call: Call) => string | Error, dir: string) {
  const calls: Call[] = [];
  const runner: ExecFileRunner = async (binary, args, options) => {
    const call = { binary, args, ...options };
    calls.push(call);
    expect(isClosedArgumentForm(binary, args), `${binary} ${args.join(" ")}`).toBe(true);
    const out = answer(call);
    if (out instanceof Error) throw out;
    return { stdout: out, stderr: "" };
  };
  const adapter = new LinuxSystemHostAdapter({
    execFileRunner: runner,
    hostJobTriggerDir: join(dir, "host-jobs"),
    rebootRequiredPath: join(dir, "reboot-required"),
    aptListsDir: join(dir, "lists"),
    unattendedUpgradePath: join(dir, "unattended-upgrade"),
    nftablesRulesetPath: REPO_DEDICATED_NFTABLES_RULESET_PATH,
    nftablesInstalledPath: join(dir, "hosting-panel.nft"),
  });
  return { adapter, calls };
}
const nftError = (stderr: string): Error => Object.assign(new Error("Command failed: nft"), { stderr });
// 501 addresses, all in the documentation ranges.
const DOC_501 = Array.from({ length: 501 }, (_, i) => (i < 256 ? `192.0.2.${i}` : `198.51.100.${i - 256}`));
const SETS: HostFirewallSets = { openedPorts: [9100, 8080], blockedV4: ["198.51.100.0/24", "192.0.2.1"], blockedV6: ["2001:db8::2"] };

describe("Linux adapter: firewall", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });

  it("reads the table with the fixed listing form", async () => {
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    const state = await adapter.readFirewall();
    expect(HostFirewallStateWireSchema.parse(state)).toMatchObject({ baseRules: "current", openedPorts: [8080, 9100] });
    expect(calls).toHaveLength(1);
    expect(["/usr/sbin/nft", "/usr/bin/nft"]).toContain(calls[0]!.binary);
    expect(calls[0]!.args).toEqual(["-j", "list", "table", "inet", "hp_dedicated_filter"]);
  });

  it("reads absent base rules from the error nft gives for a missing table", async () => {
    const { adapter } = adapterWith(() => nftError("Error: No such file or directory\nlist table inet hp_dedicated_filter\n"), dir);
    expect(await adapter.readFirewall()).toMatchObject({ baseRules: "absent", openedPorts: [], blockedV4: [], blockedV6: [] });
  });

  it("turns any other nft failure into a fixed sentence", async () => {
    const { adapter } = adapterWith(() => nftError("Error: Operation not permitted 203.0.113.9"), dir);
    await expect(adapter.readFirewall()).rejects.toMatchObject({ code: "NOT_SUPPORTED", message: "A host tool failed or gave an answer the agent cannot read" });
  });

  it("replaces the sets through nft -f - on standard input and answers a fresh read", async () => {
    const { adapter, calls } = adapterWith((c) => (c.args[0] === "-f" ? "" : CURRENT), dir);
    const state = await adapter.replaceFirewallSets(SETS);
    expect(calls.map((c) => c.args.join(" "))).toEqual([
      "-j list table inet hp_dedicated_filter", "-f -", "-j list table inet hp_dedicated_filter",
    ]);
    expect(calls[1]!.input).toBe([
      "flush set inet hp_dedicated_filter opened_tcp_ports",
      "flush set inet hp_dedicated_filter blocked_v4",
      "flush set inet hp_dedicated_filter blocked_v6",
      "add element inet hp_dedicated_filter opened_tcp_ports { 9100, 8080 }",
      "add element inet hp_dedicated_filter blocked_v4 { 198.51.100.0/24, 192.0.2.1 }",
      "add element inet hp_dedicated_filter blocked_v6 { 2001:db8::2 }",
      "",
    ].join("\n"));
    expect(state).toMatchObject({ baseRules: "current", blockedV4: ["192.0.2.1", "198.51.100.0/24"] });
  });

  it.each([
    ["a text nft would resolve as a host name", { ...SETS, blockedV4: ["192.0.2.999"] }],
    ["an injected program", { ...SETS, blockedV4: ["203.0.113.7 } ; flush ruleset"] }],
    ["an overlap", { ...SETS, blockedV4: ["198.51.100.0/24", "198.51.100.7"] }],
    ["a repeated port", { ...SETS, openedPorts: [8080, 8080] }],
    ["a port outside the safe list", { ...SETS, openedPorts: [22] }],
    ["501 addresses", { ...SETS, blockedV4: DOC_501 }],
    ["an IPv6 address in the IPv4 list", { ...SETS, blockedV4: ["2001:db8::1"] }],
    ["an address not in canonical form", { ...SETS, blockedV6: ["2001:DB8::1"] }],
  ])("refuses %s before nft runs", async (_name, sets) => {
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    expect(await code(adapter.replaceFirewallSets(sets))).toBe("HOST_POLICY_DENIED");
    expect(calls).toEqual([]);
  });

  it.each([
    ["outdated", listing([])],
    ["absent", nftError("Error: No such file or directory")],
  ] as const)("answers RESOURCE_LOCKED and writes nothing when the base rules are %s", async (_name, answer) => {
    const { adapter, calls } = adapterWith(() => answer, dir);
    expect(await code(adapter.replaceFirewallSets(SETS))).toBe("RESOURCE_LOCKED");
    expect(calls.map((c) => c.args[0])).toEqual(["-j"]);
  });
});

describe("Linux adapter: firewall without the installer's copy (R202 1.2)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
    await rm(join(dir, "hosting-panel.nft"));
  });

  it("reads unmanaged and starts no program", async () => {
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    expect(HostFirewallStateWireSchema.parse(await adapter.readFirewall())).toMatchObject({ baseRules: "unmanaged", openedPorts: [], blockedV4: [], blockedV6: [] });
    expect(calls).toEqual([]);
  });

  it("counts a path that is not a file as no copy", async () => {
    await mkdir(join(dir, "hosting-panel.nft"));
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    expect((await adapter.readFirewall()).baseRules).toBe("unmanaged");
    expect(calls).toEqual([]);
  });

  it.each(["verify_baseline_firewall", "apply_dedicated_nftables_22_80_443"] as const)("ends %s failed with a fixed reason before any nft call", async (policyRef) => {
    const { adapter, calls } = adapterWith(() => "", dir);
    const result = await adapter.executeSecurityPolicy(createApprovedHostSecurityCommand({ hostId: "host_1", policyRef }));
    expect(result.status).toBe("failed");
    expect(JSON.parse(result.output!)).toMatchObject({ reason: "panel firewall not installed on this server" });
    expect(result.output).not.toContain(dir);
    expect(calls).toEqual([]);
  });

  it("refuses a change with RESOURCE_LOCKED and starts no program", async () => {
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    expect(await code(adapter.replaceFirewallSets(SETS))).toBe("RESOURCE_LOCKED");
    expect(calls).toEqual([]);
  });

  it("with the copy back, applies the ruleset as before", async () => {
    await writeFile(join(dir, "hosting-panel.nft"), "# installer copy\n");
    const { adapter, calls } = adapterWith(() => "", dir);
    const result = await adapter.executeSecurityPolicy(createApprovedHostSecurityCommand({ hostId: "host_1", policyRef: "apply_dedicated_nftables_22_80_443" }));
    expect(result.status).toBe("succeeded");
    expect(calls.map((c) => c.args)).toEqual([["-f", REPO_DEDICATED_NFTABLES_RULESET_PATH]]);
  });
});

describe("Linux adapter: services, journal, packages", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });

  it("reads the four services with the fixed systemctl form", async () => {
    const { adapter, calls } = adapterWith(() => SERVICES_OUT, dir);
    expect(await adapter.readHostServices()).toHaveLength(4);
    expect(calls).toEqual([{ binary: "/usr/bin/systemctl", args: SERVICES_ARGV }]);
  });

  it("reads a journal with the fixed journalctl form and a 10 MiB buffer", async () => {
    const { adapter, calls } = adapterWith(() => jl({ MESSAGE: "Ready." }), dir);
    expect(await adapter.readHostJournal("hp-panel-update", 200)).toEqual([{ at: "2026-11-17T08:00:00.123Z", message: "Ready." }]);
    expect(calls).toEqual([{ binary: "/usr/bin/journalctl", args: journalArgv("hp-panel-update", "200"), maxBuffer: 10 * 1024 * 1024 }]);
  });

  it.each([
    ["a unit outside the list", "sshd", 10],
    ["zero lines", "hp-api", 0],
    ["501 lines", "hp-api", 501],
    ["a fraction of a line", "hp-api", 1.5],
  ])("refuses a journal request with %s before anything runs", async (_name, unit, lines) => {
    const { adapter, calls } = adapterWith(() => "", dir);
    expect(await code(adapter.readHostJournal(unit as "hp-api", lines))).toBe("HOST_POLICY_DENIED");
    expect(calls).toEqual([]);
  });

  it("reads the packages, the restart flag, the newest list time and whether the upgrade tool is there", async () => {
    const { adapter, calls } = adapterWith(() => APT_OUT, dir);
    expect(await adapter.readOsPackages()).toEqual({ packages: parseAptUpgradeSimulation(APT_OUT), rebootRequired: false, canUpgrade: false, listsReadAt: null });
    expect(calls).toEqual([{ binary: "/usr/bin/apt-get", args: ["-s", "upgrade"], maxBuffer: 1024 * 1024 }]);

    await mkdir(join(dir, "lists", "partial"), { recursive: true });
    await writeFile(join(dir, "lists", "a_Packages"), "");
    await writeFile(join(dir, "lists", "b_Packages"), "");
    await utimes(join(dir, "lists", "a_Packages"), new Date("2026-11-16T10:00:00Z"), new Date("2026-11-16T10:00:00Z"));
    await utimes(join(dir, "lists", "b_Packages"), new Date("2026-11-17T07:00:00Z"), new Date("2026-11-17T07:00:00Z"));
    await writeFile(join(dir, "reboot-required"), "");
    await writeFile(join(dir, "unattended-upgrade"), "", { mode: 0o755 });
    expect(HostOsPackagesWireSchema.parse(await adapter.readOsPackages())).toMatchObject({
      rebootRequired: true, canUpgrade: true, listsReadAt: "2026-11-17T07:00:00.000Z",
    });
  });
});

describe("Linux adapter: a list file that disappears during a refresh (R202 3)", () => {
  it("skips a file gone between the listing and its stat; any other stat failure still fails the read", async () => {
    const dir = await tempDir();
    const { adapter } = adapterWith(() => APT_OUT, dir);
    await mkdir(join(dir, "lists"));
    await writeFile(join(dir, "lists", "a_Packages"), "");
    await utimes(join(dir, "lists", "a_Packages"), new Date("2026-11-16T10:00:00Z"), new Date("2026-11-16T10:00:00Z"));
    await writeFile(join(dir, "lists", "vanished_Packages"), "");
    expect((await adapter.readOsPackages()).listsReadAt).toBe("2026-11-16T10:00:00.000Z");
    await writeFile(join(dir, "lists", "denied_Packages"), "");
    await expect(adapter.readOsPackages()).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("Linux adapter: host jobs", () => {
  let dir: string;
  let triggerDir: string;
  beforeEach(async () => {
    dir = await tempDir();
    triggerDir = join(dir, "host-jobs");
    await mkdir(triggerDir);
  });
  const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

  it("reads a job with the fixed systemctl form for its two units", async () => {
    const { adapter, calls } = adapterWith(() => jobOut({ ...RAN }), dir);
    expect(await adapter.readHostJob("os_refresh")).toMatchObject({ job: "os_refresh", state: "succeeded" });
    expect(calls).toEqual([{ binary: "/usr/bin/systemctl", args: jobArgv("hp-os-refresh") }]);
  });

  it("reads a job as running while its trigger file exists", async () => {
    await writeFile(join(triggerDir, "hp-os-refresh"), "");
    const { adapter } = adapterWith(() => jobOut({ ...RAN }), dir);
    expect(await adapter.readHostJob("os_refresh")).toMatchObject({ state: "running" });
  });

  it("writes exactly the fixed empty file of the job and answers running without a second read (R203 1.1)", async () => {
    const web = "hp-unit-restart@hp-web";
    const { adapter, calls } = adapterWith(() => jobOut({ ...RAN, Id: `${web}.service` }, { Id: `${web}.path` }), dir);
    expect(await adapter.requestHostJob("restart_hp_web")).toMatchObject({ job: "restart_hp_web", state: "running" });
    const file = join(triggerDir, "hp-unit-restart@hp-web");
    const st = await stat(file);
    expect(st.size).toBe(0);
    expect(st.mode & 0o777).toBe(0o600);
    expect(calls.map((c) => c.args)).toEqual([jobArgv("hp-unit-restart@hp-web")]);
  });

  it("answers RESOURCE_LOCKED while the job runs, and when the file already exists", async () => {
    const running = adapterWith(() => jobOut({ ActiveState: "activating" }), dir);
    expect(await code(running.adapter.requestHostJob("os_refresh"))).toBe("RESOURCE_LOCKED");
    expect(await exists(join(triggerDir, "hp-os-refresh"))).toBe(false);
    await writeFile(join(triggerDir, "hp-os-refresh"), "");
    const idle = adapterWith(() => jobOut({ ...RAN }), dir);
    expect(await code(idle.adapter.requestHostJob("os_refresh"))).toBe("RESOURCE_LOCKED");
  });

  it("removes a stale trigger file and answers NOT_SUPPORTED when the path unit is not active (R198 2.4)", async () => {
    await writeFile(join(triggerDir, "hp-os-upgrade"), "");
    const { adapter } = adapterWith(() => jobOut({ Id: "hp-os-upgrade.service" }, { Id: "hp-os-upgrade.path", ActiveState: "failed" }), dir);
    expect(await code(adapter.requestHostJob("os_upgrade"))).toBe("NOT_SUPPORTED");
    expect(await exists(join(triggerDir, "hp-os-upgrade"))).toBe(false);
    const inactive = adapterWith(() => jobOut({ Id: "hp-os-upgrade.service" }, { Id: "hp-os-upgrade.path", ActiveState: "inactive" }), dir);
    expect(await code(inactive.adapter.requestHostJob("os_upgrade"))).toBe("NOT_SUPPORTED");
    expect(await exists(join(triggerDir, "hp-os-upgrade"))).toBe(false);
  });

  // R203 1: only missing units are NOT_SUPPORTED on the job calls; a failed systemctl is retryable.
  const timedOut = (): Error => Object.assign(new Error("Command failed: systemctl show (timed out)"), { killed: true, signal: "SIGTERM" });
  const failure = (p: Promise<unknown>) => p.then(() => ({}), (e: { code?: unknown; message?: unknown }) => ({ code: e.code, message: e.message }));
  const UNAVAILABLE = { code: "HOST_AGENT_UNAVAILABLE", message: "A host tool failed or gave an answer the agent cannot read" };

  it("R203 1.1: a request whose trigger was written answers running and starts systemctl once", async () => {
    let n = 0;
    const { adapter, calls } = adapterWith(() => (++n === 1 ? jobOut({ Id: "hp-os-upgrade.service" }, { Id: "hp-os-upgrade.path" }) : timedOut()), dir);
    expect(await adapter.requestHostJob("os_upgrade")).toMatchObject({ job: "os_upgrade", state: "running" });
    expect(await exists(join(triggerDir, "hp-os-upgrade"))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("R203 1.2: a first read that fails refuses the request with HOST_AGENT_UNAVAILABLE and writes no trigger", async () => {
    const { adapter } = adapterWith(timedOut, dir);
    expect(await failure(adapter.requestHostJob("os_upgrade"))).toEqual(UNAVAILABLE);
    expect(await exists(join(triggerDir, "hp-os-upgrade"))).toBe(false);
  });

  it("R203 1.2: a read with a failing runner or an unreadable answer is HOST_AGENT_UNAVAILABLE with the fixed sentence", async () => {
    expect(await failure(adapterWith(timedOut, dir).adapter.readHostJob("os_refresh"))).toEqual(UNAVAILABLE);
    expect(await failure(adapterWith(() => "sentinel unreadable answer", dir).adapter.readHostJob("os_refresh"))).toEqual(UNAVAILABLE);
    expect(await failure(adapterWith(() => jobOut({ ...RAN, ExecMainStartTimestamp: "sentinel" }), dir).adapter.readHostJob("os_refresh"))).toEqual(UNAVAILABLE);
  });

  it("R203 1.2: units that are not loaded stay NOT_SUPPORTED with the units sentence", async () => {
    const missing = { code: "NOT_SUPPORTED", message: "The host job units are not installed or not active" };
    expect(await failure(adapterWith(() => jobOut({ LoadState: "not-found" }), dir).adapter.readHostJob("os_refresh"))).toEqual(missing);
    expect(await failure(adapterWith(() => jobOut({ LoadState: "not-found" }), dir).adapter.requestHostJob("os_refresh"))).toEqual(missing);
    expect(await exists(join(triggerDir, "hp-os-refresh"))).toBe(false);
  });

  it("refuses a job outside the list before any file or program", async () => {
    const { adapter, calls } = adapterWith(() => jobOut(), dir);
    for (const job of ["../../etc/passwd", "hp-os-refresh", "toString", "__proto__"]) {
      expect(await code(adapter.requestHostJob(job as HostJob))).toBe("HOST_POLICY_DENIED");
      expect(await code(adapter.readHostJob(job as HostJob))).toBe("HOST_POLICY_DENIED");
    }
    expect(calls).toEqual([]);
  });
});

// ---- the seven routes through a real client and server over a socket --------------------------

const SECRET = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const KEY: IpcSigningKey = { keyId: "ipc-m5d-test", algorithm: "hmac-sha256", secret: SECRET };
const KEYRING: IpcVerificationKeyring = { "ipc-m5d-test": { keyId: "ipc-m5d-test", algorithm: "hmac-sha256", secret: SECRET } };

describe("IPC routes and client", () => {
  const servers: InstanceType<typeof HostAgentIpcServer>[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
  });

  async function serve(adapter: ConstructorParameters<typeof HostAgentIpcServer>[0]["adapter"]) {
    const socketPath = join(await tempDir(), "agent.sock");
    const server = new HostAgentIpcServer({ adapter, keyring: KEYRING, transportConfig: { transport: "uds", socketPath } });
    servers.push(server);
    await server.start();
    return { socketPath, client: new SignedHostAgentIpcClient({ signingKey: KEY, socketPath }) };
  }

  function raw(socketPath: string, method: "GET" | "POST", pathWithQuery: string, body?: unknown): Promise<{ status: number; json: { error?: { code: string; message: string } } }> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { ...signIpcRequest({ method, pathWithQuery, body: text ?? null, key: KEY }) };
    if (text !== undefined) headers["content-type"] = "application/json";
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath, method, path: pathWithQuery, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      });
      req.on("error", reject);
      req.end(text);
    });
  }

  it("answers each of the seven calls through the client", async () => {
    const sim = new InMemoryHostSimulatorAdapter({ jobEndDelayMs: 5 });
    const { client } = await serve(sim);
    expect(await client.readFirewall()).toMatchObject({ baseRules: "current", openedPorts: [] });
    expect(await client.replaceFirewallSets(SETS)).toMatchObject({ openedPorts: [8080, 9100], blockedV4: ["192.0.2.1", "198.51.100.0/24"] });
    expect(await client.readHostServices()).toHaveLength(4);
    expect((await client.readHostJournal("hp-api", 1))).toHaveLength(1);
    expect(await client.readOsPackages()).toMatchObject({ canUpgrade: true });
    expect(await client.requestHostJob("os_refresh")).toMatchObject({ job: "os_refresh", state: "running" });
    await vi.waitFor(async () => expect(await client.readHostJob("os_refresh")).toMatchObject({ state: "succeeded", exitStatus: 0 }));
    for (const job of HOST_JOBS) sim.releaseHostJob(job);
  });

  it("carries unmanaged across the wire: the server answers it, the client parses it, a change is 409 (R202 1.3)", async () => {
    const dir = await tempDir();
    await rm(join(dir, "hosting-panel.nft"));
    const { adapter, calls } = adapterWith(() => CURRENT, dir);
    const { client } = await serve(adapter);
    expect(await client.readFirewall()).toMatchObject({ baseRules: "unmanaged", openedPorts: [], blockedV4: [], blockedV6: [] });
    await expect(client.replaceFirewallSets(SETS)).rejects.toMatchObject({ code: "RESOURCE_LOCKED", statusCode: 409 });
    expect(calls).toEqual([]);
  });

  it("answers 409 RESOURCE_LOCKED through the client", async () => {
    const sim = new InMemoryHostSimulatorAdapter();
    sim.holdHostJob("panel_update");
    const { client } = await serve(sim);
    await client.requestHostJob("panel_update");
    await expect(client.requestHostJob("panel_update")).rejects.toMatchObject({ code: "RESOURCE_LOCKED", statusCode: 409 });
    sim.setFirewallBaseRules("outdated");
    await expect(client.replaceFirewallSets(SETS)).rejects.toMatchObject({ code: "RESOURCE_LOCKED", statusCode: 409 });
    sim.releaseHostJob("panel_update");
  });

  it("answers 422 NOT_SUPPORTED with a fixed sentence, never the text of a program", async () => {
    const dir = await tempDir();
    const { adapter } = adapterWith(() => nftError("Error: secret-sentinel-text 203.0.113.9"), dir);
    const { client, socketPath } = await serve(adapter);
    await expect(client.readFirewall()).rejects.toMatchObject({ code: "NOT_SUPPORTED", statusCode: 422, message: "A host tool failed or gave an answer the agent cannot read" });
    const res = await raw(socketPath, "GET", "/v1/host-services");
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.json)).not.toContain("secret-sentinel-text");
  });

  it.each([
    ["sets with an extra key", "POST", "/v1/firewall/sets", { ...SETS, extra: [] }],
    ["sets with 501 addresses", "POST", "/v1/firewall/sets", { ...SETS, blockedV4: DOC_501 }],
    ["sets with a port outside the safe list", "POST", "/v1/firewall/sets", { ...SETS, openedPorts: [22] }],
    ["sets with a text after an address", "POST", "/v1/firewall/sets", { ...SETS, blockedV4: ["192.0.2.1 }; flush ruleset"] }],
    ["sets that are not an object", "POST", "/v1/firewall/sets", ["x"]],
    ["a job outside the list", "POST", "/v1/host-jobs", { job: "reboot" }],
    ["a job with an extra key", "POST", "/v1/host-jobs", { job: "os_refresh", unit: "sshd" }],
    ["no body for a job", "POST", "/v1/host-jobs", undefined],
    ["a job query outside the list", "GET", "/v1/host-jobs?job=hp-os-refresh", undefined],
    ["a job query with an extra key", "GET", "/v1/host-jobs?job=os_refresh&x=1", undefined],
    ["a journal unit outside the list", "GET", "/v1/host-journal?unit=sshd&lines=10", undefined],
    ["a journal of 0 lines", "GET", "/v1/host-journal?unit=hp-api&lines=0", undefined],
    ["a journal of 501 lines", "GET", "/v1/host-journal?unit=hp-api&lines=501", undefined],
    ["a journal of 1e2 lines", "GET", "/v1/host-journal?unit=hp-api&lines=1e2", undefined],
    ["a journal query with an extra key", "GET", "/v1/host-journal?unit=hp-api&lines=10&file=/x", undefined],
    ["a journal query with a repeated key", "GET", "/v1/host-journal?unit=hp-api&unit=sshd&lines=10", undefined],
  ] as const)("refuses %s with 403 HOST_POLICY_DENIED", async (_name, method, path, body) => {
    const sim = new InMemoryHostSimulatorAdapter();
    const spy = vi.spyOn(sim, "replaceFirewallSets");
    const jobSpy = vi.spyOn(sim, "requestHostJob");
    const { socketPath } = await serve(sim);
    const res = await raw(socketPath, method, path, body);
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("HOST_POLICY_DENIED");
    expect(spy).not.toHaveBeenCalled();
    expect(jobSpy).not.toHaveBeenCalled();
  });

  it("refuses through the client too", async () => {
    const { client } = await serve(new InMemoryHostSimulatorAdapter());
    await expect(client.readHostJournal("sshd" as "hp-api", 10)).rejects.toMatchObject({ code: "HOST_POLICY_DENIED", statusCode: 403 });
    await expect(client.requestHostJob("reboot" as HostJob)).rejects.toMatchObject({ code: "HOST_POLICY_DENIED", statusCode: 403 });
    await expect(client.replaceFirewallSets({ ...SETS, openedPorts: [22] })).rejects.toMatchObject({ code: "HOST_POLICY_DENIED", statusCode: 403 });
  });

  it("answers 503 when the agent behind the routes is unavailable", async () => {
    const sim = new InMemoryHostSimulatorAdapter();
    sim.setUnavailable(true);
    const { client } = await serve(sim);
    await expect(client.readHostServices()).rejects.toMatchObject({ code: "HOST_AGENT_UNAVAILABLE", statusCode: 503 });
  });
});
