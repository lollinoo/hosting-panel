import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostFirewallStateWireSchema,
  HostJobStateWireSchema,
  HostJournalLineWireSchema,
  HostOsPackagesWireSchema,
  HostServiceStateWireSchema,
} from "@hosting-panel/contracts";
import { HOST_JOBS, createApprovedHostSecurityCommand, type HostFirewallSets } from "@hosting-panel/host-agent-contracts";
import { buildFirewallSetsProgram, validateFirewallSets } from "../src/firewall-sets.js";
import { InMemoryHostSimulatorAdapter } from "../src/simulator-adapter.js";

const EMPTY: HostFirewallSets = { openedPorts: [], blockedV4: [], blockedV6: [] };
const SETS: HostFirewallSets = {
  openedPorts: [9100, 8080],
  blockedV4: ["198.51.100.0/24", "192.0.2.1"],
  blockedV6: ["2001:db8::2", "2001:db8::1"],
};
const NOW = new Date("2026-11-17T10:00:00.750Z");

const sims: InMemoryHostSimulatorAdapter[] = [];
function sim(jobEndDelayMs = 5): InMemoryHostSimulatorAdapter {
  const s = new InMemoryHostSimulatorAdapter({ jobEndDelayMs, nowProvider: () => NOW });
  sims.push(s);
  return s;
}
afterEach(() => {
  for (const s of sims.splice(0)) for (const job of HOST_JOBS) s.releaseHostJob(job);
});

async function code(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => "resolved", (e: unknown) => (e as { code?: unknown }).code);
}

describe("firewall-sets", () => {
  it("builds one program that flushes the three sets and adds the non-empty lists", () => {
    const flush = [
      "flush set inet hp_dedicated_filter opened_tcp_ports",
      "flush set inet hp_dedicated_filter blocked_v4",
      "flush set inet hp_dedicated_filter blocked_v6",
    ];
    expect(buildFirewallSetsProgram(EMPTY)).toBe(`${flush.join("\n")}\n`);
    expect(buildFirewallSetsProgram({ ...EMPTY, openedPorts: [8080, 9100] })).toBe(
      `${[...flush, "add element inet hp_dedicated_filter opened_tcp_ports { 8080, 9100 }"].join("\n")}\n`,
    );
    expect(buildFirewallSetsProgram(SETS)).toBe(`${[
      ...flush,
      "add element inet hp_dedicated_filter opened_tcp_ports { 9100, 8080 }",
      "add element inet hp_dedicated_filter blocked_v4 { 198.51.100.0/24, 192.0.2.1 }",
      "add element inet hp_dedicated_filter blocked_v6 { 2001:db8::2, 2001:db8::1 }",
    ].join("\n")}\n`);
  });

  it("accepts canonical lists of safe ports and blocks", () => {
    expect(validateFirewallSets(SETS)).toEqual(SETS);
  });

  it.each([
    ["an injected text", { ...EMPTY, blockedV4: ["192.0.2.1 }; flush ruleset"] }],
    ["a short injected text", { ...EMPTY, blockedV4: ["192.0.2.1};flush"] }],
    ["a port outside the safe list", { ...EMPTY, openedPorts: [22] }],
    ["a repeated port", { ...EMPTY, openedPorts: [8080, 8080] }],
    ["an address not in its canonical form", { ...EMPTY, blockedV4: ["192.0.2.1/32"] }],
    ["an IPv6 address in the IPv4 list", { ...EMPTY, blockedV4: ["2001:db8::1"] }],
    ["an IPv4 address in the IPv6 list", { ...EMPTY, blockedV6: ["192.0.2.1"] }],
    ["two overlapping blocks", { ...EMPTY, blockedV4: ["198.51.100.0/24", "198.51.100.7"] }],
    ["an extra key", { ...EMPTY, extra: [] }],
  ])("refuses %s before any program is built", (_name, input) => {
    let refused: unknown;
    try {
      buildFirewallSetsProgram(validateFirewallSets(input));
    } catch (err) {
      refused = err;
    }
    expect(refused).toMatchObject({ code: "HOST_POLICY_DENIED", message: "Firewall lists refused" });
  });
});

describe("simulator firewall", () => {
  it("starts current with empty lists", async () => {
    const state = await sim().readFirewall();
    expect(HostFirewallStateWireSchema.parse(state)).toEqual({ baseRules: "current", ...EMPTY, readAt: NOW.toISOString() });
  });

  it("stores the lists sorted and returns what readFirewall returns", async () => {
    const s = sim();
    const written = await s.replaceFirewallSets(SETS);
    expect(written).toEqual({
      baseRules: "current",
      openedPorts: [8080, 9100],
      blockedV4: ["192.0.2.1", "198.51.100.0/24"],
      blockedV6: ["2001:db8::1", "2001:db8::2"],
      readAt: NOW.toISOString(),
    });
    expect(await s.readFirewall()).toEqual(written);
  });

  it("leaves the stored lists untouched when it refuses a list", async () => {
    const s = sim();
    await s.replaceFirewallSets(SETS);
    const before = await s.readFirewall();
    expect(await code(s.replaceFirewallSets({ ...SETS, openedPorts: [22] }))).toBe("HOST_POLICY_DENIED");
    expect(await s.readFirewall()).toEqual(before);
  });

  it.each(["absent", "outdated"] as const)("answers RESOURCE_LOCKED when the base rules are %s", async (state) => {
    const s = sim();
    s.setFirewallBaseRules(state);
    expect(await code(s.replaceFirewallSets(SETS))).toBe("RESOURCE_LOCKED");
    expect(await s.readFirewall()).toMatchObject({ baseRules: state, ...EMPTY });
  });

  it("writes the kernel side unchecked with overwriteFirewallSets", async () => {
    const s = sim();
    s.overwriteFirewallSets({ openedPorts: [22, 8080], blockedV4: ["192.0.2.0/24", "192.0.2.1"], blockedV6: [] });
    expect(await s.readFirewall()).toMatchObject({ openedPorts: [22, 8080], blockedV4: ["192.0.2.0/24", "192.0.2.1"] });
  });

  it("empties the lists and makes the base rules current when the apply policy runs", async () => {
    const s = sim();
    await s.replaceFirewallSets(SETS);
    s.setFirewallBaseRules("outdated");
    s.overwriteFirewallSets(SETS);
    await s.executeSecurityPolicy(createApprovedHostSecurityCommand({ hostId: "hst-01", policyRef: "apply_dedicated_nftables_22_80_443" }));
    expect(await s.readFirewall()).toMatchObject({ baseRules: "current", ...EMPTY });
  });

  it("R203 3.2: refuses the apply on unmanaged, as the real agent, and changes no state", async () => {
    const s = sim();
    s.setFirewallBaseRules("unmanaged");
    const r = await s.executeSecurityPolicy(createApprovedHostSecurityCommand({ hostId: "hst-01", policyRef: "apply_dedicated_nftables_22_80_443" }));
    expect(r.status).toBe("failed");
    expect(JSON.parse(r.output ?? "")).toMatchObject({ reason: "panel firewall not installed on this server" });
    expect(await s.readFirewall()).toMatchObject({ baseRules: "unmanaged", ...EMPTY });
  });
});

describe("simulator jobs", () => {
  it("has never run a job at first", async () => {
    expect(await sim().readHostJob("panel_update")).toEqual({ job: "panel_update", state: "never_run", exitStatus: null, startedAt: null, endedAt: null });
  });

  it("runs a job, ends it with status 0 and keeps its last end", async () => {
    const s = sim();
    const started = await s.requestHostJob("os_refresh");
    expect(HostJobStateWireSchema.parse(started)).toEqual({
      job: "os_refresh", state: "running", exitStatus: null, startedAt: "2026-11-17T10:00:00.000Z", endedAt: null,
    });
    await vi.waitFor(async () => expect((await s.readHostJob("os_refresh")).state).toBe("succeeded"));
    const ended = await s.readHostJob("os_refresh");
    expect(ended).toEqual({ job: "os_refresh", state: "succeeded", exitStatus: 0, startedAt: "2026-11-17T10:00:00.000Z", endedAt: "2026-11-17T10:00:00.000Z" });
    expect(await s.readHostJob("os_refresh")).toEqual(ended);
    expect((await s.readHostJob("os_upgrade")).state).toBe("never_run");
  });

  it("ends with the exit status set for it", async () => {
    const s = sim();
    s.setHostJobExitStatus("panel_update", 3);
    await s.requestHostJob("panel_update");
    await vi.waitFor(async () => expect(await s.readHostJob("panel_update")).toMatchObject({ state: "failed", exitStatus: 3 }));
  });

  it("refuses a second request while the job runs, and stays running while held", async () => {
    const s = sim();
    s.holdHostJob("restart_hp_web");
    await s.requestHostJob("restart_hp_web");
    expect(await code(s.requestHostJob("restart_hp_web"))).toBe("RESOURCE_LOCKED");
    await new Promise((r) => setTimeout(r, 30));
    expect((await s.readHostJob("restart_hp_web")).state).toBe("running");
    s.releaseHostJob("restart_hp_web");
    await vi.waitFor(async () => expect((await s.readHostJob("restart_hp_web")).state).toBe("succeeded"));
    expect((await s.requestHostJob("restart_hp_web")).state).toBe("running");
  });
});

describe("simulator reads", () => {
  it("answers fixed defaults that parse with the wire schemas", async () => {
    const s = sim();
    const services = await s.readHostServices();
    expect(services.map((x) => HostServiceStateWireSchema.parse(x).unit)).toEqual(["hp-api", "hp-web", "hp-docker-executor", "hp-host-agent"]);
    for (const line of await s.readHostJournal("hp-os-upgrade", 500)) HostJournalLineWireSchema.parse(line);
    expect(HostOsPackagesWireSchema.parse(await s.readOsPackages()).canUpgrade).toBe(true);
  });

  it("replaces the defaults with the three setters", async () => {
    const s = sim();
    const services = [
      { unit: "hp-api", active: false, activeState: "failed", since: null, restarts: 4 },
      { unit: "hp-web", active: true, activeState: "active", since: "2026-11-17T09:00:00.000Z", restarts: 0 },
      { unit: "hp-docker-executor", active: true, activeState: "activating", since: null, restarts: 1 },
      { unit: "hp-host-agent", active: true, activeState: "active", since: null, restarts: 0 },
    ] as const;
    s.setHostServices(services);
    expect(await s.readHostServices()).toEqual(services);
    const lines = [1, 2, 3].map((n) => ({ at: `2026-11-17T09:00:0${n}.000Z`, message: `line ${n}` }));
    s.setHostJournal("hp-panel-update", lines);
    expect(await s.readHostJournal("hp-panel-update", 2)).toEqual(lines.slice(1));
    const packages = { packages: [], rebootRequired: true, canUpgrade: false, listsReadAt: null };
    s.setOsPackages(packages);
    expect(await s.readOsPackages()).toEqual(packages);
  });

  it.each([
    ["a unit outside the list", "sshd", 10],
    ["zero lines", "hp-api", 0],
    ["too many lines", "hp-api", 501],
    ["a fraction of a line", "hp-api", 1.5],
  ])("refuses a journal request with %s", async (_name, unit, lines) => {
    expect(await code(sim().readHostJournal(unit as "hp-api", lines))).toBe("HOST_POLICY_DENIED");
  });
});

describe("simulator unavailable", () => {
  it("throws HOST_AGENT_UNAVAILABLE from each of the seven calls", async () => {
    const s = sim();
    s.setUnavailable(true);
    const calls = [
      s.readFirewall(),
      s.replaceFirewallSets(EMPTY),
      s.readHostServices(),
      s.readHostJournal("hp-api", 10),
      s.readOsPackages(),
      s.requestHostJob("os_refresh"),
      s.readHostJob("os_refresh"),
    ];
    for (const call of calls) expect(await code(call)).toBe("HOST_AGENT_UNAVAILABLE");
    s.setUnavailable(false);
    expect((await s.readFirewall()).baseRules).toBe("current");
  });
});
