import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_IDS,
  auditEvents,
  createDatabaseClient,
  firewallBlocks,
  firewallOpenPorts,
  seedPhase1Dataset,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { HostAgentPort, HostFirewallSets, HostFirewallState } from "@hosting-panel/host-agent-contracts";
import { FirewallService, type FirewallActor } from "../src/firewall/firewall.service.js";

const ACTOR: FirewallActor = { userId: DEMO_IDS.users.infra, ipAddress: "192.0.2.10", userAgent: "sentinel-agent", requestId: "req_sentinel" };
const READ_AT = "2026-11-17T06:00:00.000Z";
const err = (code: string) => Object.assign(new Error("sentinel agent text"), { code });

/** A fake agent: a kernel state, and switches for failures. */
function fakeAgent() {
  const state = { baseRules: "current" as HostFirewallState["baseRules"], sets: { openedPorts: [], blockedV4: [], blockedV6: [] } as HostFirewallSets };
  const knobs = { available: true, readError: null as string | null, replaceError: null as string | null, replaceDelayMs: 0 };
  const sent: HostFirewallSets[] = [];
  const snapshot = (): HostFirewallState => ({ baseRules: state.baseRules, ...state.sets, readAt: READ_AT });
  const agent = {
    get isRuntimeAvailable() {
      return knobs.available;
    },
    readFirewall: vi.fn(async () => {
      if (knobs.readError) throw err(knobs.readError);
      return snapshot();
    }),
    replaceFirewallSets: vi.fn(async (sets: HostFirewallSets) => {
      sent.push(sets);
      if (knobs.replaceDelayMs) await new Promise((r) => setTimeout(r, knobs.replaceDelayMs));
      if (knobs.replaceError) throw err(knobs.replaceError);
      state.sets = sets;
      return snapshot();
    }),
  };
  return { agent, port: agent as unknown as HostAgentPort, state, knobs, sent };
}

describe("FirewallService", () => {
  let dbClient: DatabaseClient;
  let fake: ReturnType<typeof fakeAgent>;
  let service: FirewallService;
  let warn: ReturnType<typeof vi.spyOn>;
  let seen: Set<string>; // audit rows are append-only: earlier tests' rows are skipped

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await seedPhase1Dataset(dbClient.db);
  });
  afterAll(async () => dbClient.close());

  beforeEach(async () => {
    await dbClient.db.delete(firewallOpenPorts);
    await dbClient.db.delete(firewallBlocks);
    seen = new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
    fake = fakeAgent();
    service = new FirewallService(dbClient, fake.port);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await service.stop();
    warn.mockRestore();
  });

  const audits = async () => (await dbClient.db.select().from(auditEvents)).filter((r) => !seen.has(r.id));
  const codeOf = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; details?: { reason?: string }[] }) => ({ code: e.code, reason: e.details?.[0]?.reason }));

  it("opens a port: its number reaches the agent, one audit row, inForce true", async () => {
    const dto = await service.setPort("node_exporter", true, ACTOR);
    expect(fake.sent).toEqual([{ openedPorts: [9100], blockedV4: [], blockedV6: [] }]);
    expect(dto.ports.find((p) => p.name === "node_exporter")).toEqual({ name: "node_exporter", port: 9100, open: true, inForce: true });
    expect(dto.ports.find((p) => p.name === "nrpe")).toEqual({ name: "nrpe", port: 5666, open: false, inForce: true });
    expect(dto.baseRules).toBe("current");
    expect(dto.readAt).toBe(READ_AT);
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "admin.firewall.port_open", targetType: "firewall", targetId: "node_exporter", organizationId: null,
      ipAddress: "192.0.2.10", userAgent: "sentinel-agent",
      details: { outcome: "succeeded", requestId: "req_sentinel", name: "node_exporter", port: 9100 },
    });
  });

  it("a port already in the wanted state: no audit row, no replace", async () => {
    await service.setPort("nrpe", false, ACTOR);
    await service.setPort("nrpe", true, ACTOR);
    await service.setPort("nrpe", true, ACTOR);
    expect(fake.agent.replaceFirewallSets).toHaveBeenCalledTimes(1);
    expect((await audits()).map((r) => r.action)).toEqual(["admin.firewall.port_open"]);
    await service.setPort("nrpe", false, ACTOR);
    expect(fake.sent.at(-1)).toEqual({ openedPorts: [], blockedV4: [], blockedV6: [] });
    expect((await audits()).map((r) => r.action).sort()).toEqual(["admin.firewall.port_close", "admin.firewall.port_open"]);
  });

  it("an unknown port name is refused and never reaches the agent", async () => {
    expect(await codeOf(service.setPort("ssh" as never, true, ACTOR))).toEqual({ code: "VALIDATION_ERROR", reason: "unknown_port" });
    expect(fake.agent.replaceFirewallSets).not.toHaveBeenCalled();
    expect(await dbClient.db.select().from(firewallOpenPorts)).toEqual([]);
  });

  it.each(["absent", "outdated"] as const)("base rules %s give 409 and nothing is stored", async (baseRules) => {
    fake.state.baseRules = baseRules;
    expect(await codeOf(service.setPort("http_alt", true, ACTOR))).toEqual({ code: "FIREWALL_BASE_RULES_NOT_CURRENT", reason: undefined });
    expect((await codeOf(service.block({ address: "192.0.2.0/24" }, null, ACTOR)))?.code).toBe("FIREWALL_BASE_RULES_NOT_CURRENT");
    expect(await dbClient.db.select().from(firewallOpenPorts)).toEqual([]);
    expect(await dbClient.db.select().from(firewallBlocks)).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(fake.agent.replaceFirewallSets).not.toHaveBeenCalled();
  });

  it("unmanaged (R202 1.3): start pass loads nothing, changes answer as for absent, the view says unmanaged", async () => {
    await dbClient.db.insert(firewallOpenPorts).values({ name: "zabbix_agent" });
    fake.state.baseRules = "unmanaged";
    const executeSecurityPolicy = vi.fn();
    Object.assign(fake.agent, { executeSecurityPolicy });
    // As the real agent: a replace is refused unless the base rules are current, and nothing reaches the kernel.
    fake.agent.replaceFirewallSets.mockImplementation(async (sets: HostFirewallSets) => {
      fake.sent.push(sets);
      throw err("RESOURCE_LOCKED");
    });
    await service.syncAtStart(5);
    expect(fake.sent).toHaveLength(1);
    expect(fake.state.sets).toEqual({ openedPorts: [], blockedV4: [], blockedV6: [] });
    expect(executeSecurityPolicy).not.toHaveBeenCalled();
    await dbClient.db.delete(firewallOpenPorts);
    expect(await codeOf(service.setPort("http_alt", true, ACTOR))).toEqual({ code: "FIREWALL_BASE_RULES_NOT_CURRENT", reason: undefined });
    expect((await codeOf(service.block({ address: "192.0.2.0/24" }, null, ACTOR)))?.code).toBe("FIREWALL_BASE_RULES_NOT_CURRENT");
    // R203 3.1: on unmanaged the message does not send the administrator to an apply that always fails.
    await expect(service.setPort("http_alt", true, ACTOR)).rejects.toThrow("The panel firewall is not installed on this server.");
    expect(await dbClient.db.select().from(firewallOpenPorts)).toEqual([]);
    expect(await dbClient.db.select().from(firewallBlocks)).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(fake.sent).toHaveLength(1);
    const dto = await service.view();
    expect(dto.baseRules).toBe("unmanaged");
    expect(dto.ports.every((p) => p.inForce === null)).toBe(true);
    expect(executeSecurityPolicy).not.toHaveBeenCalled();
  });

  it("a disabled runtime gives 422 before the agent is read; the view says disabled", async () => {
    fake.knobs.available = false;
    expect((await codeOf(service.setPort("http_alt", true, ACTOR)))?.code).toBe("NOT_SUPPORTED");
    expect((await codeOf(service.unblock("fwb_00000000000000000000000000000000", ACTOR)))?.code).toBe("NOT_SUPPORTED");
    expect(fake.agent.readFirewall).not.toHaveBeenCalled();
    const dto = await service.view();
    expect(dto).toMatchObject({ baseRules: "disabled", readAt: null });
    expect(dto.ports.every((p) => p.inForce === null)).toBe(true);
    expect(await service.sync()).toBeNull();
  });

  it("a replace failure still stores: 2xx, inForce false, one log line with the code only", async () => {
    fake.knobs.replaceError = "HOST_POLICY_DENIED";
    const dto = await service.block({ address: "198.51.100.0/24", note: "" }, null, ACTOR);
    expect(dto.blocks).toEqual([expect.objectContaining({ address: "198.51.100.0/24", family: "ipv4", note: null, inForce: false })]);
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "firewall_sync_failed", code: "HOST_POLICY_DENIED" }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("sentinel agent text");
    const [row] = await audits();
    expect(row).toMatchObject({ action: "admin.firewall.block", targetId: dto.blocks[0]!.id, details: { outcome: "succeeded", address: "198.51.100.0/24", family: "ipv4", note: null } });
  });

  it("an unreadable agent: the change is stored, baseRules unreadable, inForce null", async () => {
    fake.knobs.readError = "HOST_AGENT_UNAVAILABLE";
    fake.knobs.replaceError = "HOST_AGENT_UNAVAILABLE";
    const dto = await service.setPort("https_alt", true, ACTOR);
    expect(dto).toMatchObject({ baseRules: "unreadable", readAt: null });
    expect(dto.ports.find((p) => p.name === "https_alt")).toEqual({ name: "https_alt", port: 8443, open: true, inForce: null });
    expect((await service.view()).baseRules).toBe("unreadable");
  });

  it("blocks and unblocks: canonical form, families, refusals with reasons, 404 for an unknown id", async () => {
    const a = await service.block({ address: "2001:0db8:0000:0000:0000:0000:0000:0000/32", note: "sentinel note" }, null, ACTOR);
    expect(a.blocks[0]).toMatchObject({ address: "2001:db8::/32", family: "ipv6", note: "sentinel note", inForce: true });
    await service.block({ address: "203.0.113.9" }, null, ACTOR);
    expect(fake.sent.at(-1)).toEqual({ openedPorts: [], blockedV4: ["203.0.113.9"], blockedV6: ["2001:db8::/32"] });
    expect(await codeOf(service.block({ address: "203.0.113.0/24" }, null, ACTOR))).toEqual({ code: "VALIDATION_ERROR", reason: "overlaps" });
    expect(await codeOf(service.block({ address: "198.51.100.0/24" }, "198.51.100.7", ACTOR))).toEqual({ code: "VALIDATION_ERROR", reason: "own_address" });
    expect(await codeOf(service.block({ address: "198.51.100.0/24" }, "not-an-address", ACTOR))).toBeNull();
    expect(await codeOf(service.block({ address: "192.0.2.0/24", note: "bad‮note" }, null, ACTOR))).toEqual({ code: "VALIDATION_ERROR", reason: "note_invalid" });
    const refused = await service.block({ address: "203.0.113.0/24; flush ruleset" }, null, ACTOR).catch((e: Error) => e);
    expect(JSON.stringify({ ...refused, message: (refused as Error).message })).not.toContain("flush");
    expect((await audits()).map((r) => r.action)).toEqual(["admin.firewall.block", "admin.firewall.block", "admin.firewall.block"]);
    const view = await service.view();
    expect(view.blocks.map((b) => b.address)).toEqual(["198.51.100.0/24", "203.0.113.9", "2001:db8::/32"]);
    const id = view.blocks[1]!.id;
    const after = await service.unblock(id, ACTOR);
    expect(after.blocks.map((b) => b.address)).toEqual(["198.51.100.0/24", "2001:db8::/32"]);
    expect(fake.sent.at(-1)!.blockedV4).toEqual(["198.51.100.0/24"]);
    expect((await audits()).filter((r) => r.action === "admin.firewall.unblock")).toEqual([
      expect.objectContaining({ targetId: id, details: { outcome: "succeeded", requestId: "req_sentinel", address: "203.0.113.9", family: "ipv4" } }),
    ]);
    expect((await codeOf(service.unblock(id, ACTOR)))?.code).toBe("NOT_FOUND");
  });

  it("an entry missing from the kernel shows inForce false; a port open in the kernel but closed in the store too", async () => {
    await service.block({ address: "192.0.2.0/24" }, null, ACTOR);
    fake.state.sets = { openedPorts: [8080], blockedV4: [], blockedV6: [] };
    const dto = await service.view();
    expect(dto.blocks[0]!.inForce).toBe(false);
    expect(dto.ports.find((p) => p.name === "http_alt")!.inForce).toBe(false);
  });

  it("two concurrent changes run one after the other and send in order", async () => {
    fake.knobs.replaceDelayMs = 30;
    await Promise.all([service.setPort("http_alt", true, ACTOR), service.setPort("nrpe", true, ACTOR), service.sync()]);
    expect(fake.sent.map((s) => s.openedPorts)).toEqual([[8080], [5666, 8080], [5666, 8080]]);
  });

  it("syncAtStart retries on HOST_AGENT_UNAVAILABLE and OPERATION_AMBIGUOUS, then stops at RESOURCE_LOCKED", async () => {
    await dbClient.db.insert(firewallOpenPorts).values({ name: "zabbix_agent" });
    const codes = ["HOST_AGENT_UNAVAILABLE", "OPERATION_AMBIGUOUS", "RESOURCE_LOCKED"];
    fake.agent.replaceFirewallSets.mockImplementation(async (sets: HostFirewallSets) => {
      fake.sent.push(sets);
      throw err(codes.shift() ?? "RESOURCE_LOCKED");
    });
    await service.syncAtStart(5);
    expect(fake.sent).toEqual(Array(3).fill({ openedPorts: [10050], blockedV4: [], blockedV6: [] }));
  });

  it("syncAtStart stops at the first success, and stop() ends a retry in progress", async () => {
    await service.syncAtStart(5);
    expect(fake.agent.replaceFirewallSets).toHaveBeenCalledTimes(1);
    fake.knobs.replaceError = "HOST_AGENT_UNAVAILABLE";
    const running = service.syncAtStart(60_000);
    await vi.waitFor(() => expect(fake.agent.replaceFirewallSets).toHaveBeenCalledTimes(2));
    await service.stop();
    await running;
    expect(fake.agent.replaceFirewallSets).toHaveBeenCalledTimes(2);
  });
});
