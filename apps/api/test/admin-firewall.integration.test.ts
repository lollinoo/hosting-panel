import { randomUUID } from "node:crypto";
import { FirewallDtoSchema } from "@hosting-panel/contracts";
import { auditEvents, createDatabaseClient, firewallBlocks, firewallOpenPorts, type DatabaseClient } from "@hosting-panel/database";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-password-0003";
const SETUP = { installationName: "Firewall Test", hostHostname: "panel.example.test", hostIpv4: "192.0.2.1" };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("admin firewall routes", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryHostSimulatorAdapter;
  let adminToken: string;

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}) }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, as: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID(), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function start(opts: { disabled?: boolean; before?: (db: DatabaseClient) => Promise<void> } = {}): Promise<void> {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    await opts.before?.(dbClient);
    sim = new InMemoryHostSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: opts.disabled ? "disabled" : "local-simulator",
      ...(opts.disabled ? {} : { hostAgent: sim }),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
  }

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  const allAudits = () => dbClient.db.select().from(auditEvents);
  const firewallAudits = async () => (await allAudits()).filter((r) => r.action.startsWith("admin.firewall."));
  const refusal = (res: { status: number; body: Json }) => ({ status: res.status, code: res.body.error?.code, ...res.body.error?.details?.[0] });
  const kernel = () => sim.readFirewall();

  it("view, open and close: 200, the DTO parses, one audit row per change, none for a port already in its state", async () => {
    await start();
    const view = await call("GET", "/v1/admin/firewall", adminToken);
    expect(view.status).toBe(200);
    const dto = FirewallDtoSchema.parse(view.body.data);
    expect(dto).toMatchObject({ baseRules: "current", blocks: [] });
    expect(dto.hostId).toEqual(expect.any(String));
    expect(dto.ports.map((p) => p.open)).toEqual(Array(6).fill(false));

    const opened = await call("POST", "/v1/admin/firewall/ports/http_alt/open", adminToken, {});
    expect(opened.status).toBe(200);
    expect(opened.body.data.ports[0]).toEqual({ name: "http_alt", port: 8080, open: true, inForce: true });
    expect((await kernel()).openedPorts).toEqual([8080]);
    const again = await call("POST", "/v1/admin/firewall/ports/http_alt/open", adminToken, {});
    expect(again.status).toBe(200);
    expect((await call("POST", "/v1/admin/firewall/ports/nrpe/close", adminToken, {})).status).toBe(200);
    expect((await call("POST", "/v1/admin/firewall/ports/http_alt/close", adminToken)).status).toBe(200);
    expect((await kernel()).openedPorts).toEqual([]);

    const rows = await firewallAudits();
    expect(rows.map((r) => r.action).sort()).toEqual(["admin.firewall.port_close", "admin.firewall.port_open"]);
    expect(rows.find((r) => r.action === "admin.firewall.port_open")).toMatchObject({
      targetType: "firewall",
      targetId: "http_alt",
      details: { outcome: "succeeded", name: "http_alt", port: 8080, requestId: expect.any(String) },
    });
  });

  it("an unknown port name is 400 unknown_port, and the name is not echoed", async () => {
    await start();
    for (const name of ["ssh", "http_alt%3Bflush", "HTTP_ALT"]) {
      const res = await call("POST", `/v1/admin/firewall/ports/${name}/open`, adminToken, {});
      expect(refusal(res)).toMatchObject({ status: 400, code: "VALIDATION_ERROR", field: "name", reason: "unknown_port" });
      expect(JSON.stringify(res.body)).not.toMatch(/ssh|flush|HTTP_ALT/);
    }
    expect(await firewallAudits()).toEqual([]);
  });

  it("block and unblock: 201 then 200, every refusal with its reason, 404 for an unknown or malformed id", async () => {
    await start();
    const created = await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "203.0.113.0/24", note: "sentinel note" });
    expect(created.status).toBe(201);
    const block = created.body.data.blocks[0];
    expect(block).toMatchObject({ address: "203.0.113.0/24", family: "ipv4", note: "sentinel note", inForce: true });
    expect((await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "2001:db8:0:0::/32" })).status).toBe(201);
    expect(await kernel()).toMatchObject({ blockedV4: ["203.0.113.0/24"], blockedV6: ["2001:db8::/32"] });

    const cases: [unknown, Record<string, string>, string, string][] = [
      [{ address: "192.0.2.1;flush ruleset" }, {}, "address", "invalid"],
      [{ address: "::ffff:192.0.2.1" }, {}, "address", "ipv4_mapped"],
      [{ address: "192.0.2.5/24" }, {}, "address", "host_bits"],
      [{ address: "203.0.0.0/8" }, {}, "address", "too_wide"],
      [{ address: "127.0.0.1" }, {}, "address", "reserved"],
      [{ address: "198.51.100.0/24" }, { "X-HP-Client-Address": "198.51.100.77" }, "address", "own_address"],
      [{ address: "203.0.113.9" }, {}, "address", "overlaps"],
      [{ address: "192.0.2.0/24", note: "bad\u0000note" }, {}, "note", "note_invalid"],
      [{ address: 42 }, {}, "address", "invalid"],
      [{ address: "192.0.2.0/24", note: 7 }, {}, "note", "note_invalid"],
      [{ address: "192.0.2.0/24", sneaky: "x" }, {}, "address", "invalid"],
      [{}, {}, "address", "invalid"],
    ];
    // Only what was planted, in forms no hex id or time stamp can make ("bad" alone is hex).
    const PLANTED = /flush|sneaky|198\.51\.100\.|bad[^"]{0,6}note/;
    for (const [body, headers, field, reason] of cases) {
      const res = await call("POST", "/v1/admin/firewall/blocks", adminToken, body, headers);
      expect(refusal(res), JSON.stringify(body)).toMatchObject({ status: 400, code: "VALIDATION_ERROR", field, reason });
      expect(JSON.stringify(res.body)).not.toMatch(PLANTED);
    }
    // A garbage requester address skips the own-address check.
    expect((await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "198.51.100.0/24" }, { "X-HP-Client-Address": "unknown" })).status).toBe(201);

    for (const id of [`fwb_${"0".repeat(32)}`, "fwb_nothex", "x".repeat(40)]) {
      const res = await call("DELETE", `/v1/admin/firewall/blocks/${id}`, adminToken);
      expect(refusal(res)).toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(JSON.stringify(res.body)).not.toContain(id);
    }
    const removed = await call("DELETE", `/v1/admin/firewall/blocks/${block.id}`, adminToken);
    expect(removed.status).toBe(200);
    expect(removed.body.data.blocks.map((b: Json) => b.address)).toEqual(["198.51.100.0/24", "2001:db8::/32"]);
    expect((await kernel()).blockedV4).toEqual(["198.51.100.0/24"]);

    const rows = await firewallAudits();
    expect(rows.map((r) => r.action).sort()).toEqual(["admin.firewall.block", "admin.firewall.block", "admin.firewall.block", "admin.firewall.unblock"]);
    expect(rows.find((r) => r.action === "admin.firewall.unblock")).toMatchObject({
      targetId: block.id,
      details: { outcome: "succeeded", address: "203.0.113.0/24", family: "ipv4" },
    });
    expect(JSON.stringify(rows)).not.toMatch(/flush|sneaky|bad[^"]{0,6}note|readAt|baseRules/);
  });

  it("the limit refusal at 500 IPv6 entries while IPv4 is still accepted", async () => {
    await start({
      before: async (db) => {
        const rows = Array.from({ length: 500 }, (_, i) => ({ id: `fwb_${randomUUID().replace(/-/g, "")}`, family: "ipv6" as const, cidr: `2001:db8:${i.toString(16)}::/48` }));
        await db.db.insert(firewallBlocks).values(rows);
      },
    });
    expect(refusal(await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "2001:db8:ffff::/48" }))).toMatchObject({ status: 400, reason: "limit" });
    expect((await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "203.0.113.0/24" })).status).toBe(201);
  });

  it("base rules not current: 409 and nothing stored; the view shows the state", async () => {
    await start();
    sim.setFirewallBaseRules("outdated");
    const res = await call("POST", "/v1/admin/firewall/ports/nrpe/open", adminToken, {});
    expect(refusal(res)).toMatchObject({ status: 409, code: "FIREWALL_BASE_RULES_NOT_CURRENT" });
    expect((await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "203.0.113.0/24" })).status).toBe(409);
    expect(await dbClient.db.select().from(firewallOpenPorts)).toEqual([]);
    expect(await dbClient.db.select().from(firewallBlocks)).toEqual([]);
    expect(await firewallAudits()).toEqual([]);
    const view = (await call("GET", "/v1/admin/firewall", adminToken)).body.data;
    expect(view.baseRules).toBe("outdated");
    expect(view.ports[0].inForce).toBeNull();
  });

  it("an agent that does not answer: the change is stored, baseRules unreadable, inForce null", async () => {
    await start();
    sim.setUnavailable(true);
    const res = await call("POST", "/v1/admin/firewall/ports/nrpe/open", adminToken, {});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ baseRules: "unreadable", readAt: null });
    expect(res.body.data.ports.find((p: Json) => p.name === "nrpe")).toEqual({ name: "nrpe", port: 5666, open: true, inForce: null });
    expect(await firewallAudits()).toHaveLength(1);
  });

  it("a disabled runtime: the view says disabled and each change is 422", async () => {
    await start({ disabled: true });
    expect((await call("GET", "/v1/admin/firewall", adminToken)).body.data.baseRules).toBe("disabled");
    expect(refusal(await call("POST", "/v1/admin/firewall/ports/nrpe/open", adminToken, {}))).toMatchObject({ status: 422, code: "NOT_SUPPORTED" });
    expect((await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "203.0.113.0/24" })).status).toBe(422);
    expect((await call("DELETE", `/v1/admin/firewall/blocks/fwb_${"a".repeat(32)}`, adminToken)).status).toBe(422);
  });

  it("after the shipped apply of the base rules and one worker pass the host holds the stored lists again", async () => {
    await start();
    expect((await call("POST", "/v1/admin/firewall/ports/zabbix_agent/open", adminToken, {})).status).toBe(200);
    expect((await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "203.0.113.0/24" })).status).toBe(201);
    const hostId = (await call("GET", "/v1/admin/firewall", adminToken)).body.data.hostId as string;
    sim.setFirewallBaseRules("absent");
    expect((await kernel()).blockedV4).toEqual([]);
    const applied = await call("POST", `/v1/hosts/${hostId}/security`, adminToken, { policyRef: "apply_dedicated_nftables_22_80_443" });
    expect(applied.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    expect(await kernel()).toMatchObject({ baseRules: "current", openedPorts: [10050], blockedV4: ["203.0.113.0/24"], blockedV6: [] });
  });

  it("rows stored before the API starts reach the host at start", async () => {
    await start({
      before: async (db) => {
        await db.db.insert(firewallOpenPorts).values({ name: "https_alt" });
        await db.db.insert(firewallBlocks).values({ id: `fwb_${"b".repeat(32)}`, family: "ipv6", cidr: "2001:db8::/32" });
      },
    });
    await vi.waitFor(async () => expect(await kernel()).toMatchObject({ openedPorts: [8443], blockedV6: ["2001:db8::/32"] }));
  });

  it("an entry removed from the host's set shows inForce false", async () => {
    await start();
    await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "203.0.113.0/24" });
    await call("POST", "/v1/admin/firewall/blocks", adminToken, { address: "198.51.100.0/24" });
    sim.overwriteFirewallSets({ openedPorts: [], blockedV4: ["203.0.113.0/24"], blockedV6: [] });
    const blocks = (await call("GET", "/v1/admin/firewall", adminToken)).body.data.blocks as Json[];
    expect(blocks.map((b) => [b.address, b.inForce])).toEqual([["198.51.100.0/24", false], ["203.0.113.0/24", true]]);
  });

  it("a customer gets 403 and one denied row on each of the five routes, and nothing changes", async () => {
    await start();
    const created = await call("POST", "/v1/admin/customer-account", adminToken, { organizationName: "Org A", ownerEmail: "owner@example.test", ownerName: "Owner" });
    expect(created.status).toBe(201);
    const token = await login("owner@example.test", created.body.data.temporaryPassword as string);
    const routes: [string, string, unknown?][] = [
      ["GET", "/v1/admin/firewall"],
      ["POST", "/v1/admin/firewall/ports/http_alt/open", {}],
      ["POST", "/v1/admin/firewall/ports/http_alt/close", {}],
      ["POST", "/v1/admin/firewall/blocks", { address: "203.0.113.0/24" }],
      ["DELETE", `/v1/admin/firewall/blocks/fwb_${"c".repeat(32)}`],
    ];
    for (const [method, path, body] of routes) {
      const before = (await allAudits()).map((r) => r.id);
      const res = await call(method, path, token, body);
      expect(res.status, path).toBe(403);
      const added = (await allAudits()).filter((r) => !before.includes(r.id));
      expect(added).toHaveLength(1);
      expect((added[0]!.details as Json).outcome).toBe("denied");
    }
    expect(await dbClient.db.select().from(firewallOpenPorts)).toEqual([]);
    expect(await dbClient.db.select().from(firewallBlocks)).toEqual([]);
  });
});
