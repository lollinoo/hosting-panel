import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  FIREWALL_SAFE_PORTS,
  MAIL_RELAY_IMAGE,
  PANEL_RELEASE_LATEST_URL,
  PHPMYADMIN_IMAGE,
  PLATFORM_OPS_ORG_ID,
  SFTP_IMAGE,
  SHARED_MARIADB_IMAGE,
  checkFirewallBlock,
  resolveWordpressImage,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  firewallBlocks,
  firewallOpenPorts,
  hostingAdminScopes,
  operationSteps,
  operations,
  outboxEvents,
  platformInstallations,
  serviceInstances,
  sites,
  sql,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import type { HostAgentPort, HostJobState } from "@hosting-panel/host-agent-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { ensurePlatformOpsOrg } from "../src/backups/backup-scheduler.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { FirewallService } from "../src/firewall/firewall.service.js";
import { enqueueHostJob, executeHostJob } from "../src/host/host-jobs.js";
import { createControlPlaneApp, type ControlPlaneAppHandle, type CreateControlPlaneAppOptions } from "../src/index.js";

const version = vi.hoisted(() => ({ current: "1.4.2" as string | null }));
vi.mock("../src/updates/release-version.js", async (load) => ({
  ...(await load<typeof import("../src/updates/release-version.js")>()),
  installedPanelVersion: () => version.current,
}));

const KEY = Buffer.alloc(32, 13);
const PW = "sentinel-password-0013";
const SETUP = { installationName: "M5d QA", hostHostname: "panel.example.test", hostIpv4: "192.0.2.1" };
const SITE = { name: "Site A", domain: "wp-a.example.test", title: "Site A", adminUser: "admin", adminEmail: "admin@example.test", adminPassword: "sentinel-Pass-123456" };
const MARK = "zqmarker";
const FIXED_FAILED = "The job ended with an error. Read its log on the Logs page, then try again.";
const FIXED_NOT_STARTED = "The job did not start. Check Health, then try again.";
const PINNED_NAMES = [SHARED_MARIADB_IMAGE, SFTP_IMAGE, PHPMYADMIN_IMAGE, MAIL_RELAY_IMAGE, "traefik", resolveWordpressImage("8.4"), resolveWordpressImage("8.5"), "sha256:", "/opt/", "/var/lib/", "/run/hosting-panel", "hp-unit-restart", ".service", "ActiveState"];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Call = { name: string; args: unknown[] };
type Fault = Error | "hang" | ((...args: unknown[]) => Promise<unknown>);
interface Req { as?: string | null; key?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> }

describe("M5d API QA: the host routes", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let agent: InMemoryHostSimulatorAdapter;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let adminId: string;
  let agentCalls: Call[];
  let execCalls: Call[];
  let agentFaults: Map<string, Fault>;
  let execFaults: Map<string, Fault>;
  let logged: string[];
  let answers: string[];
  let release: (url: string, init: RequestInit) => Promise<Response>;
  let releaseCalls: { url: string; init: RequestInit }[];
  let allFetches: string[];
  let realFetch: typeof fetch;

  /** Wraps a port so every call is recorded and a fault can replace it. */
  function spy<T extends object>(target: T, calls: Call[], faults: Map<string, Fault>): T {
    return new Proxy(target, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls.push({ name: String(p), args });
          const f = faults.get(String(p));
          if (f === "hang") return new Promise(() => undefined);
          if (typeof f === "function") return f(...args);
          if (f) return Promise.reject(f);
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  }

  const coded = (code: string, message: string) => Object.assign(new Error(message), { code });

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await realFetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}) }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, r: Req = {}): Promise<{ status: number; body: Json; raw: string }> {
    const as = r.as === undefined ? adminToken : r.as;
    const res = await realFetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        ...(r.key === null ? {} : { "Idempotency-Key": r.key ?? randomUUID() }),
        ...r.headers,
      },
      body: r.raw ?? (r.body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(r.body)),
    });
    const raw = await res.text();
    answers.push(raw);
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  async function start(opts: Partial<CreateControlPlaneAppOptions> & { before?: (db: DatabaseClient) => Promise<void> } = {}): Promise<void> {
    version.current = "1.4.2";
    agentCalls = [];
    execCalls = [];
    agentFaults = new Map();
    execFaults = new Map();
    logged = [];
    answers = [];
    releaseCalls = [];
    allFetches = [];
    release = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      allFetches.push(url);
      if (url !== PANEL_RELEASE_LATEST_URL) return realFetch(input, init);
      releaseCalls.push({ url, init: init ?? {} });
      return release(url, init ?? {});
    });
    for (const m of ["log", "warn", "error", "info", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? String(x))).join(" ")));
    }
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => (logged.push(String(chunk)), true)) as typeof stream.write);
    }
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    adminId = admin.userId;
    await opts.before?.(dbClient);
    agent = new InMemoryHostSimulatorAdapter();
    sim = new InMemoryDockerSimulatorAdapter();
    const disabled = opts.runtimeBackend === "disabled";
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      ...(disabled ? {} : { dockerExecutor: spy(sim, execCalls, execFaults) as DockerExecutorPort, hostAgent: spy(agent, agentCalls, agentFaults) as HostAgentPort }),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
      ...opts,
    });
    if (!disabled) await firewall().sync();
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
  }

  afterEach(async () => {
    await app.close();
    await dbClient.close();
    vi.restoreAllMocks();
  });

  const firewall = () => app.nestApp.get(FirewallService);
  const runWorker = () => app.outboxWorker.processPendingOnce();
  const heartbeat = () => app.driftReconciler.reconcileAllOnce();
  const named = (name: string) => agentCalls.filter((c) => c.name === name);
  const opOf = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const rowsOf = async (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const age = (id: string, ms: number) => dbClient.db.update(operations).set({ submittedAt: new Date(Date.now() - ms) }).where(eq(operations.id, id));
  const reasonOf = (res: { body: Json }) => res.body.error?.details?.[0]?.reason as string | undefined;
  const refusal = (res: { status: number; body: Json }) => [res.status, res.body.error?.code, reasonOf(res)];
  const counts = async () => ({
    operations: (await dbClient.db.select().from(operations)).length,
    outbox: (await dbClient.db.select().from(outboxEvents)).length,
    blocks: (await dbClient.db.select().from(firewallBlocks)).length,
    ports: (await dbClient.db.select().from(firewallOpenPorts)).length,
  });
  /** Every record the panel keeps, as one text: audit rows, operations, their steps, the outbox and the log lines. */
  const records = async () =>
    JSON.stringify([
      await dbClient.db.select().from(auditEvents),
      await dbClient.db.select().from(operations),
      await dbClient.db.select().from(operationSteps),
      await dbClient.db.select().from(outboxEvents),
      logged,
    ]);

  async function createSite(ownerOrganizationId: string | null = null, domain = SITE.domain): Promise<{ siteId: string; serviceId: string }> {
    const res = await call("POST", "/v1/admin/sites", { body: { ...SITE, domain, name: domain, title: domain, ownerOrganizationId } });
    expect(res.status).toBe(202);
    await runWorker();
    const siteId = res.body.data.siteId as string;
    const [svc] = await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId));
    return { siteId, serviceId: svc!.id };
  }
  const putBehind = (siteId: string) => dbClient.db.update(sites).set({ phpVersion: "8.5" }).where(eq(sites.id, siteId));

  async function owner(): Promise<{ id: string; orgId: string; token: string }> {
    const created = await call("POST", "/v1/admin/customer-account", { body: { organizationName: "Org A", ownerEmail: "owner@example.test", ownerName: "Owner" } });
    expect(created.status).toBe(201);
    return { id: created.body.data.userId, orgId: created.body.data.organizationId, token: await login("owner@example.test", created.body.data.temporaryPassword as string) };
  }

  /** A support user: hosting admin of every organization, no server role. */
  async function support(): Promise<{ id: string; token: string }> {
    const id = `usr_${randomUUID()}`;
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    await dbClient.db.insert(users).values({ id, email: "support@example.test", name: "Support", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(hostingAdminScopes).values({ id: `has_${randomUUID()}`, userId: id, organizationId: null, installationId: inst!.id });
    return { id, token: await login("support@example.test", PW) };
  }

  const backupOp = (kind = "site.backups.create") =>
    ensurePlatformOpsOrg(dbClient.db).then(() =>
      enqueueOperationTransactional(dbClient.db, { organizationId: PLATFORM_OPS_ORG_ID, kind, resourceType: "site", resourceId: "site_sentinel", steps: [{ key: "run", label: "Run" }] } as Parameters<typeof enqueueOperationTransactional>[1]),
    );

  // ---------- Point 1: a server administrator only ----------

  it("P1: every M5d route and a journal source: 401 without a session, 403 plus one denied row for an owner and a support user, even with a hostile body; nothing reaches the host", async () => {
    await start();
    const o = await owner();
    const { siteId } = await createSite(o.orgId);
    await putBehind(siteId);
    const blocked = await call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.0/24" } });
    expect(blocked.status).toBe(201);
    const blockId = blocked.body.data.blocks[0].id as string;
    const s = await support();
    const HOSTILE = { address: ["203.0.113.0/24"], reason: null, version: "9.9.9", image: "evil/image:latest", extra: { $where: 1 } };
    const routes: [string, string, unknown?][] = [
      ["GET", "/v1/admin/updates"],
      ["POST", "/v1/admin/updates/panel/check", HOSTILE],
      ["POST", "/v1/admin/updates/panel/apply", HOSTILE],
      ["POST", "/v1/admin/updates/components/ingress_proxy/apply", HOSTILE],
      ["POST", `/v1/admin/sites/${siteId}/image-update`, HOSTILE],
      ["GET", "/v1/admin/os-packages"],
      ["POST", "/v1/admin/os-packages/refresh", HOSTILE],
      ["POST", "/v1/admin/os-packages/upgrade", HOSTILE],
      ["POST", "/v1/admin/host-services/executor/restart", HOSTILE],
      ["GET", "/v1/admin/firewall"],
      ["POST", "/v1/admin/firewall/ports/nrpe/open", HOSTILE],
      ["POST", "/v1/admin/firewall/ports/nrpe/close", HOSTILE],
      ["POST", "/v1/admin/firewall/blocks", HOSTILE],
      ["DELETE", `/v1/admin/firewall/blocks/${blockId}`],
      ["GET", "/v1/admin/logs/hp-api"],
    ];
    const before = await counts();
    const kernelBefore = await agent.readFirewall();
    agentCalls.length = 0;
    execCalls.length = 0;
    for (const [method, path, body] of routes) {
      expect((await call(method, path, { as: null, body })).status, `${method} ${path} no session`).toBe(401);
    }
    for (const who of [{ who: "owner", ...o }, { who: "support", ...s }]) {
      for (const [method, path, body] of routes) {
        const auditBefore = (await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id);
        const res = await call(method, path, { as: who.token, body });
        expect([res.status, res.body.error?.code], `${who.who} ${method} ${path}`).toEqual([403, "PERMISSION_DENIED"]);
        const added = (await dbClient.db.select().from(auditEvents)).filter((r) => !auditBefore.includes(r.id));
        expect(added.map((r) => [r.actorId, (r.details as Json).outcome]), `${who.who} ${method} ${path}`).toEqual([[who.id, "denied"]]);
      }
    }
    expect(agentCalls).toEqual([]);
    expect(execCalls).toEqual([]);
    expect(releaseCalls).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(await agent.readFirewall()).toMatchObject({ openedPorts: kernelBefore.openedPorts, blockedV4: kernelBefore.blockedV4 });
  }, 60_000);

  // ---------- Point 2: SSH and the panel cannot be closed ----------

  it("P2: names for 22/80/443/3000, a number, capitals and a slash give 400 unknown_port and reach no agent; the safe list holds none of the closed ports", async () => {
    await start();
    agentCalls.length = 0;
    for (const name of ["ssh", "http", "https", "panel", "web", "22", "3000", "443", "HTTP_ALT", "Nrpe", "nrpe%2F..%2Fssh", "http_alt%2F22"]) {
      for (const verb of ["open", "close"]) {
        const res = await call("POST", `/v1/admin/firewall/ports/${name}/${verb}`);
        expect(refusal(res), `${name} ${verb}`).toEqual([400, "VALIDATION_ERROR", "unknown_port"]);
      }
    }
    expect(agentCalls).toEqual([]);
    expect(await counts()).toMatchObject({ ports: 0 });
    const safe = Object.values(FIREWALL_SAFE_PORTS);
    for (const closed of [22, 80, 443, 2222, 3000, 3306, 5432, 33060, 6379]) expect(safe).not.toContain(closed);
  });

  it("P2: each block refusal has its own reason, stores nothing and never sends to the agent", async () => {
    await start();
    expect((await call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.0/24" } })).status).toBe(201);
    const stored = await counts();
    const audits = (await dbClient.db.select().from(auditEvents)).length;
    agentCalls.length = 0;
    const me = { "X-HP-Client-Address": "198.51.100.77" };
    const mapped = { "X-HP-Client-Address": "::ffff:198.51.100.77" };
    const cases: [unknown, Record<string, string>, string][] = [
      [{ address: "198.51.100.77" }, me, "own_address"],
      [{ address: "198.51.100.77" }, mapped, "own_address"],
      [{ address: "198.51.100.0/24" }, me, "own_address"],
      [{ address: "198.51.100.0/24" }, mapped, "own_address"],
      [{ address: "2001:db8:1::/48" }, { "X-HP-Client-Address": "2001:db8:1::5" }, "own_address"],
      [{ address: "127.0.0.1" }, {}, "reserved"],
      [{ address: "::1" }, {}, "reserved"],
      [{ address: "203.0.0.0/8" }, {}, "too_wide"],
      [{ address: "2001:db8::/31" }, {}, "too_wide"],
      [{ address: "198.51.100.5/24" }, {}, "host_bits"],
      [{ address: "203.0.113.128/25" }, {}, "overlaps"],
      [{ address: "203.0.112.0/23" }, {}, "overlaps"],
      [{ address: "203.0.113.9" }, {}, "overlaps"],
    ];
    for (const [body, headers, reason] of cases) {
      const res = await call("POST", "/v1/admin/firewall/blocks", { body, headers });
      expect(refusal(res), JSON.stringify([body, headers])).toEqual([400, "VALIDATION_ERROR", reason]);
    }
    expect(await counts()).toEqual(stored);
    expect((await dbClient.db.select().from(auditEvents)).length).toBe(audits);
    expect(named("replaceFirewallSets")).toEqual([]);
    // Design (step 2 of a change): the kernel is read before the refusal, once per request.
    expect(named("readFirewall")).toHaveLength(cases.length);
  });

  it("P2: over open, block, block a network, unblock and close, every list the agent received holds only safe ports and canonical addresses", async () => {
    await start();
    agentCalls.length = 0;
    expect((await call("POST", "/v1/admin/firewall/ports/zabbix_agent/open")).status).toBe(200);
    expect((await call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.9" } })).status).toBe(201);
    expect((await call("POST", "/v1/admin/firewall/blocks", { body: { address: "2001:DB8:0:0:0:0:0:0/32" } })).status).toBe(201);
    const net = await call("POST", "/v1/admin/firewall/blocks", { body: { address: "198.51.100.0/24" } });
    expect(net.status).toBe(201);
    const id = (net.body.data.blocks as Json[]).find((b) => b.address === "198.51.100.0/24")!.id as string;
    expect((await call("DELETE", `/v1/admin/firewall/blocks/${id}`)).status).toBe(200);
    expect((await call("POST", "/v1/admin/firewall/ports/zabbix_agent/close")).status).toBe(200);
    const sent = named("replaceFirewallSets").map((c) => c.args[0] as { openedPorts: number[]; blockedV4: string[]; blockedV6: string[] });
    expect(sent).toHaveLength(6);
    const safe = Object.values(FIREWALL_SAFE_PORTS);
    for (const sets of sent) {
      for (const p of sets.openedPorts) expect(safe).toContain(p);
      for (const a of [...sets.blockedV4, ...sets.blockedV6]) {
        const again = checkFirewallBlock(a, { stored: [], requesterAddress: null });
        expect(again, a).toMatchObject({ ok: true, cidr: a });
      }
    }
    expect(sent.at(-1)).toEqual({ openedPorts: [], blockedV4: [expect.stringMatching(/^203\.0\.113\.9(\/32)?$/)], blockedV6: ["2001:db8::/32"] });
  });

  // ---------- Point 3: hostile bodies never reach the host ----------

  it("P3: hostile block and restart bodies give 400; neither the agent's change nor a job is requested", async () => {
    await start();
    agentCalls.length = 0;
    const big = "1".repeat(1_000_000);
    const blockBodies: [string, string][] = [
      [JSON.stringify({ address: "203.0.113.0/24", extra: 1 }), "invalid"],
      [JSON.stringify({ address: 203 }), "invalid"],
      [JSON.stringify(["203.0.113.0/24"]), "invalid"],
      ["null", "invalid"],
      [JSON.stringify({ address: big }), "invalid"],
      [JSON.stringify({ address: "203.0.113.0/24", note: 5 }), "note_invalid"],
      [JSON.stringify({ address: "203.0.113.0/24", note: "left\u202Eright" }), "note_invalid"],
      [JSON.stringify({ address: "203.0.113.0/24", note: "nul\u0000here" }), "note_invalid"],
      [JSON.stringify({ address: "203.0.113.0/24", note: "line\nbreak" }), "note_invalid"],
      [JSON.stringify({ address: "203.0.113.0/24", note: "x".repeat(201) }), "note_invalid"],
    ];
    for (const [raw, reason] of blockBodies) {
      const res = await call("POST", "/v1/admin/firewall/blocks", { raw });
      expect(refusal(res), raw.slice(0, 60)).toEqual([400, "VALIDATION_ERROR", reason]);
      expect(res.raw).not.toContain(big.slice(0, 100));
    }
    const restartBodies = [
      JSON.stringify({ reason: "Sentinel reason", extra: 1 }),
      JSON.stringify({ reason: 5 }),
      JSON.stringify(["Sentinel reason"]),
      "null",
      JSON.stringify({ reason: big }),
      JSON.stringify({ reason: "   " }),
    ];
    for (const raw of restartBodies) {
      expect((await call("POST", "/v1/admin/host-services/web/restart", { raw })).status, raw.slice(0, 60)).toBe(400);
    }
    expect(named("replaceFirewallSets")).toEqual([]);
    expect(named("requestHostJob")).toEqual([]);
    expect(await counts()).toMatchObject({ operations: 0, blocks: 0 });
    // Markup in a note is allowed text: stored, shown back as text, never sent (the sets carry no note).
    const markup = await call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.0/24", note: "<b>sentinel</b>" } });
    expect(markup.status).toBe(201);
    expect(JSON.stringify(named("replaceFirewallSets").map((c) => c.args))).not.toContain("sentinel");
  }, 30_000);

  it("P3 (defect probe): a restart reason holding NUL is refused with 400, never a 500", async () => {
    await start();
    const res = await call("POST", "/v1/admin/host-services/web/restart", { body: { reason: "nul\u0000here" } });
    expect(named("requestHostJob")).toEqual([]);
    expect(refusal(res).slice(0, 2)).toEqual([400, "VALIDATION_ERROR"]); // R201 1.3: a contract refusal carries its Zod issue code as reason
  });

  it("P3 (note): a restart reason with U+202E or a line break is accepted and kept as is in its audit row only", async () => {
    await start();
    for (const reason of ["left\u202Eright", "line\nbreak", "<b>markup</b>"]) {
      const res = await call("POST", "/v1/admin/host-services/web/restart", { body: { reason } });
      expect(res.status, JSON.stringify(reason)).toBe(202);
      expect((await rowsOf("admin.host_service.restart")).map((r) => (r.details as Json).reason)).toContain(reason);
      await dbClient.db.update(operations).set({ status: "failed" }).where(eq(operations.id, res.body.data.operationId));
    }
  });

  it("P3: the updates routes ignore a body naming a version, an image, a tag or a URL: the job and the pin are fixed", async () => {
    await start();
    const { siteId } = await createSite();
    await putBehind(siteId);
    sim.setPanelContainer("shared_database", { imageCurrent: false });
    await heartbeat();
    agentCalls.length = 0;
    execCalls.length = 0;
    const evil = { version: "9.9.9", image: "evil/image:latest", tag: "v9.9.9", url: "https://evil.example.test/x.tar", digest: "sha256:" + "e".repeat(64), packages: ["evilpkg"] };
    const apply = await call("POST", "/v1/admin/updates/panel/apply", { body: evil });
    expect(apply.status).toBe(202);
    await age(apply.body.data.operationId, 3_000);
    await runWorker();
    const comp = await call("POST", "/v1/admin/updates/components/shared_database/apply", { body: evil });
    expect(comp.status).toBe(202);
    await age(comp.body.data.operationId, 3_000);
    await runWorker();
    const img = await call("POST", `/v1/admin/sites/${siteId}/image-update`, { body: evil });
    expect(img.status).toBe(202);
    await runWorker();
    for (const path of ["/v1/admin/os-packages/refresh", "/v1/admin/os-packages/upgrade"]) {
      const res = await call("POST", path, { body: evil });
      expect(res.status).toBe(202);
      await age(res.body.data.operationId, 3_000);
      await runWorker();
    }
    expect(named("requestHostJob").map((c) => c.args)).toEqual([["panel_update"], ["os_refresh"], ["os_upgrade"]]);
    expect(execCalls.filter((c) => c.name === "applyPanelContainerPin").map((c) => c.args)).toEqual([["shared_database"]]);
    const everything = JSON.stringify([agentCalls, execCalls, await records()]);
    for (const bad of ["evil", "9.9.9", "eeeeeeee"]) expect(everything).not.toContain(bad);
    expect(releaseCalls).toEqual([]);
  }, 60_000);

  it("P3: no answer of any M5d route holds an image name, tag, digest, host path or raw unit property", async () => {
    await start();
    const { siteId } = await createSite();
    await putBehind(siteId);
    sim.setPanelContainer("mail_relay", { state: "running", expected: true });
    await heartbeat();
    answers.length = 0;
    await call("GET", "/v1/admin/updates");
    await call("POST", "/v1/admin/updates/panel/check");
    await call("GET", "/v1/admin/os-packages");
    await call("GET", "/v1/admin/firewall");
    await call("GET", "/v1/admin/health");
    for (const src of ["hp-api", "hp-panel-update", "hp-os-upgrade"]) await call("GET", `/v1/admin/logs/${src}`);
    await call("POST", "/v1/admin/updates/components/mail_relay/apply");
    await call("POST", "/v1/admin/updates/components/ingress_proxy/apply");
    await call("POST", `/v1/admin/sites/${siteId}/image-update`);
    await call("POST", "/v1/admin/host-services/api/restart", { body: { reason: "Sentinel reason" } });
    await call("POST", "/v1/admin/firewall/ports/nrpe/open");
    await call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.0/24" } });
    await call("GET", "/v1/admin/updates");
    const all = answers.join("\n");
    expect(answers).toHaveLength(15);
    for (const bad of PINNED_NAMES) expect(all, bad).not.toContain(bad);
  }, 30_000);

  // ---------- Point 4: what the host says stays out of every record ----------

  it("P4: markers in journal lines, package names, service states, failed jobs and lost polls never reach a record; errors carry fixed sentences", async () => {
    await start();
    const at = "2026-11-17T06:00:00.000Z";
    for (const unit of ["hp-api", "hp-panel-update", "hp-os-upgrade"] as const) agent.setHostJournal(unit, [{ at, message: `${MARK} journal ${unit} <script>x</script>` }]);
    agent.setOsPackages({ packages: [{ name: `${MARK}-lib`, installedVersion: `1.0-${MARK}`, newVersion: "1.0-2", origin: "security" }], rebootRequired: false, canUpgrade: true, listsReadAt: at });
    agent.setHostServices([
      { unit: "hp-api", active: true, activeState: MARK, since: at, restarts: 0 },
      { unit: "hp-web", active: true, activeState: "active", since: at, restarts: 0 },
      { unit: "hp-docker-executor", active: true, activeState: "active", since: at, restarts: 0 },
      { unit: "hp-host-agent", active: true, activeState: "active", since: at, restarts: 0 },
    ]);
    // Shown to the administrator who asked: the reads carry the marker.
    expect((await call("GET", "/v1/admin/logs/hp-api")).raw).toContain(MARK);
    expect((await call("GET", "/v1/admin/os-packages")).raw).toContain(MARK);
    expect((await call("GET", "/v1/admin/health")).raw).toContain(MARK);

    // A failed job.
    agent.setHostJobExitStatus("restart_hp_web", 1);
    const failed = await call("POST", "/v1/admin/host-services/web/restart", { body: { reason: "zqreason restart" } });
    expect(failed.status).toBe(202);
    await age(failed.body.data.operationId, 3_000);
    await runWorker();
    expect(await opOf(failed.body.data.operationId)).toMatchObject({ status: "failed", errorCode: "HOST_JOB_FAILED", errorMessage: FIXED_FAILED });

    // A request the agent refuses with a marker in its text.
    agentFaults.set("requestHostJob", coded("HOST_AGENT_UNAVAILABLE", `${MARK} request refused`));
    const refused = await call("POST", "/v1/admin/os-packages/refresh");
    await age(refused.body.data.operationId, 3_000);
    await runWorker();
    expect(await opOf(refused.body.data.operationId)).toMatchObject({ status: "failed", errorCode: "HOST_AGENT_UNAVAILABLE", errorMessage: FIXED_NOT_STARTED });
    agentFaults.delete("requestHostJob");

    // The agent goes away in the middle of a job, then comes back.
    agent.holdHostJob("os_upgrade");
    const mid = await call("POST", "/v1/admin/os-packages/upgrade");
    await age(mid.body.data.operationId, 3_000);
    const worker = runWorker();
    await vi.waitFor(() => expect(named("requestHostJob").length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
    agentFaults.set("readHostJob", coded("HOST_AGENT_UNAVAILABLE", `${MARK} poll lost`));
    await sleep(2_500);
    agentFaults.delete("readHostJob");
    agent.setHostJobExitStatus("os_upgrade", 3);
    agent.releaseHostJob("os_upgrade");
    await worker;
    expect(await opOf(mid.body.data.operationId)).toMatchObject({ status: "failed", errorCode: "HOST_JOB_FAILED", errorMessage: FIXED_FAILED });

    // The agent fails the firewall read and the send with marker text.
    agentFaults.set("readFirewall", coded("HOST_AGENT_UNAVAILABLE", `${MARK} read`));
    agentFaults.set("replaceFirewallSets", coded("HOST_AGENT_UNAVAILABLE", `${MARK} replace`));
    const note = await call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.0/24", note: "zqnote sentinel" } });
    expect(note.status).toBe(201);
    agentFaults.clear();

    // The executor fails a component move with marker text.
    sim.setPanelContainer("shared_database", { imageCurrent: false });
    await heartbeat();
    execFaults.set("applyPanelContainerPin", coded("DOCKER_ENGINE_UNAVAILABLE", `${MARK} executor`));
    const comp = await call("POST", "/v1/admin/updates/components/shared_database/apply");
    await age(comp.body.data.operationId, 3_000);
    await runWorker();
    expect(await opOf(comp.body.data.operationId)).toMatchObject({ status: "failed" });

    // A journal read the agent fails: the error answer has a fixed text.
    agentFaults.set("readHostJournal", coded("HOST_AGENT_UNAVAILABLE", `${MARK} journal`));
    const j = await call("GET", "/v1/admin/logs/hp-api");
    expect([j.status, j.raw.includes(MARK)]).toEqual([503, false]);
    agentFaults.set("readOsPackages", coded("HOST_AGENT_UNAVAILABLE", `${MARK} packages`));
    const p = await call("GET", "/v1/admin/os-packages");
    expect([p.status, p.raw.includes(MARK)]).toEqual([503, false]);

    const text = await records();
    expect(text).not.toContain(MARK);
    // The restart reason and the block note are each in their own audit row only.
    const audit = await dbClient.db.select().from(auditEvents);
    expect(audit.filter((r) => JSON.stringify(r).includes("zqreason")).map((r) => r.action)).toEqual(["admin.host_service.restart"]);
    expect(audit.filter((r) => JSON.stringify(r).includes("zqnote")).map((r) => r.action)).toEqual(["admin.firewall.block"]);
    const rest = JSON.stringify([await dbClient.db.select().from(operations), await dbClient.db.select().from(operationSteps), await dbClient.db.select().from(outboxEvents), logged]);
    expect(rest).not.toContain("zqreason");
    expect(rest).not.toContain("zqnote");
    expect(JSON.stringify(named("replaceFirewallSets").map((c) => c.args))).not.toContain("zqnote");
  }, 60_000);

  // ---------- Point 5: one audit row per change, two per job ----------

  it("P5: a refused change and an idempotent repeat write no row and start nothing twice; a replayed key answers as the first time", async () => {
    await start();
    const key = randomUUID();
    const first = await call("POST", "/v1/admin/host-services/web/restart", { key, body: { reason: "Sentinel reason" } });
    const again = await call("POST", "/v1/admin/host-services/web/restart", { key, body: { reason: "Sentinel reason" } });
    expect(first.status).toBe(202);
    expect([again.status, again.body]).toEqual([first.status, first.body]);
    const opId = first.body.data.operationId as string;
    await age(opId, 3_000);
    await runWorker();
    const third = await call("POST", "/v1/admin/host-services/web/restart", { key, body: { reason: "Sentinel reason" } });
    expect([third.status, third.body]).toEqual([first.status, first.body]);
    await runWorker();
    expect(named("requestHostJob")).toHaveLength(1);
    expect((await rowsOf("admin.host_service.restart")).length).toBe(1);
    const ends = await rowsOf("admin.host_service.restart.end");
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ actorType: "system", actorId: null, targetType: "host", targetId: "restart_hp_web" });
    expect(ends[0]!.details).toEqual({ operationId: opId, outcome: "succeeded", result: "succeeded", exitStatus: 0 });

    // Refused changes: no row, no operation.
    const audits = (await dbClient.db.select().from(auditEvents)).length;
    expect((await call("POST", "/v1/admin/firewall/ports/nrpe/close")).status).toBe(200); // already closed: no change
    expect((await call("POST", "/v1/admin/firewall/blocks", { body: { address: "127.0.0.1" } })).status).toBe(400);
    expect((await call("POST", "/v1/admin/host-services/web/restart", { body: {} })).status).toBe(400);
    expect((await call("POST", "/v1/admin/os-packages/upgrade", { key: null })).status).toBe(400);
    expect((await dbClient.db.select().from(auditEvents)).length).toBe(audits);
    expect((await counts()).operations).toBe(1);
  }, 30_000);

  it("P5: the firewall ignores the idempotency key: the same block sent twice with one key is 201, then 400 overlaps, one row", async () => {
    await start();
    const key = randomUUID();
    const first = await call("POST", "/v1/admin/firewall/blocks", { key, body: { address: "203.0.113.0/24" } });
    const second = await call("POST", "/v1/admin/firewall/blocks", { key, body: { address: "203.0.113.0/24" } });
    expect(first.status).toBe(201);
    expect(refusal(second)).toEqual([400, "VALIDATION_ERROR", "overlaps"]);
    expect(await rowsOf("admin.firewall.block")).toHaveLength(1);
    const open1 = await call("POST", "/v1/admin/firewall/ports/nrpe/open", { key });
    const open2 = await call("POST", "/v1/admin/firewall/ports/nrpe/open", { key });
    expect([open1.status, open2.status]).toEqual([200, 200]);
    expect(await rowsOf("admin.firewall.port_open")).toHaveLength(1);
  });

  it("P5 (R200 point 3): a mail-relay apply replayed with the same key writes a second request row", async () => {
    await start();
    sim.setPanelContainer("mail_relay", { state: "running", expected: true });
    await heartbeat();
    const key = randomUUID();
    const a = await call("POST", "/v1/admin/updates/components/mail_relay/apply", { key });
    const b = await call("POST", "/v1/admin/updates/components/mail_relay/apply", { key });
    expect([a.status, a.body.data, b.status, b.body.data]).toEqual([202, { component: "mail_relay", operationId: null }, 202, { component: "mail_relay", operationId: null }]);
    expect(await rowsOf("admin.update.component")).toHaveLength(2);
  });

  it("P5 (defect probe): a replayed panel-update key after site work began answers the first operation, not 409", async () => {
    await start();
    const key = randomUUID();
    agent.holdHostJob("panel_update");
    const first = await call("POST", "/v1/admin/updates/panel/apply", { key });
    expect(first.status).toBe(202);
    await backupOp();
    const replay = await call("POST", "/v1/admin/updates/panel/apply", { key });
    expect([replay.status, replay.body.data?.operationId]).toEqual([202, first.body.data.operationId]);
  });

  // ---------- Point 7: a run that ended before the request does not settle it ----------

  it("P7 (R198 2.5): an older run, also one that ended in the request's own second, is not taken; a run started in that second is", async () => {
    await start();
    /** Runs one host job against a stub agent whose last run has the given times. */
    async function runAgainst(run: { startedAt: string; endedAt: string }, opStart: Date) {
      const { operationId } = await enqueueHostJob(dbClient.db, {
        job: "os_refresh", actorId: adminId, idempotencyKey: randomUUID(),
        audit: { action: "admin.os_packages.refresh", targetType: "host", targetId: "os_refresh", details: { outcome: "succeeded" }, ipAddress: null, userAgent: null },
      });
      await dbClient.db.update(operations).set({ status: "processing", submittedAt: new Date(opStart.getTime() - 3_000), startedAt: opStart }).where(eq(operations.id, operationId));
      const state: HostJobState = { job: "os_refresh", state: "succeeded", exitStatus: 0, ...run };
      const stub = {
        isRuntimeAvailable: true,
        requestHostJob: async () => { throw coded("OPERATION_AMBIGUOUS", "lost"); },
        readHostJob: async () => state,
      } as unknown as HostAgentPort;
      let n = 0;
      const now = () => (n++ === 0 ? opStart.getTime() + 1 : opStart.getTime() + 130_000);
      await executeHostJob(dbClient.db, stub, await opOf(operationId), now);
      return (await rowsOf("admin.os_packages.refresh.end")).find((r) => (r.details as Json).operationId === operationId)!.details as Json;
    }
    const sec = Math.floor(Date.now() / 1000) * 1000 - 10_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    // Started a second before, ended in the request's own second (request at .900).
    expect(await runAgainst({ startedAt: iso(sec - 1_000), endedAt: iso(sec) }, new Date(sec + 900))).toMatchObject({ result: "not_started" });
    // Started and ended a second before.
    expect(await runAgainst({ startedAt: iso(sec - 2_000), endedAt: iso(sec - 1_000) }, new Date(sec + 50))).toMatchObject({ result: "not_started" });
    // Design accepts this one: a run started in the same second is taken, even when the request never reached the agent.
    expect(await runAgainst({ startedAt: iso(sec), endedAt: iso(sec) }, new Date(sec + 900))).toMatchObject({ result: "succeeded" });
  }, 30_000);

  // ---------- Point 8: refused while something runs ----------

  it("P8: a second job of the same kind is 409; executor restart, panel update and os_upgrade during a backup, a restore or a WordPress update are 409 site_work_running and ask nothing", async () => {
    await start();
    agent.holdHostJob("os_refresh");
    expect((await call("POST", "/v1/admin/os-packages/refresh")).status).toBe(202);
    expect(refusal(await call("POST", "/v1/admin/os-packages/refresh"))).toEqual([409, "RESOURCE_LOCKED", "host_job_running"]);
    await dbClient.db.update(operations).set({ status: "failed" }).where(eq(operations.kind, "host.job"));
    for (const kind of ["site.backups.create", "site.backups.restore", "site.wordpress.update"]) {
      const operationId = (await backupOp(kind)).operation!.id;
      for (const [path, body] of [["/v1/admin/host-services/executor/restart", { reason: "Sentinel reason" }], ["/v1/admin/updates/panel/apply", undefined], ["/v1/admin/os-packages/upgrade", undefined]] as const) {
        expect(refusal(await call("POST", path, { body })), `${kind} ${path}`).toEqual([409, "RESOURCE_LOCKED", "site_work_running"]);
      }
      await dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, operationId));
    }
    expect(named("requestHostJob")).toEqual([]);
  }, 30_000);

  it("P8 (design note): a deploy is not site work, and a backup is accepted right after a panel update was accepted", async () => {
    await start();
    const { siteId } = await createSite();
    await putBehind(siteId);
    const deploy = await call("POST", `/v1/admin/sites/${siteId}/image-update`);
    expect(deploy.status).toBe(202);
    expect((await opOf(deploy.body.data.operationId)).status).toBe("queued");
    const during = await call("POST", "/v1/admin/updates/panel/apply");
    expect(during.status).toBe(202);
    // The check is one way only: nothing refuses site work queued after the job.
    const backup = await backupOp();
    expect([backup.idempotentReplay, (await opOf(backup.operation!.id)).status]).toEqual([false, "queued"]);
  }, 30_000);

  // ---------- Point 9: the panel answers when the host does not ----------

  it("P9: agent down, then hanging: Health answers within its bound with hostServices null; firewall gives the stored lists with unknown in force; updates answers; packages 503; nothing is 500", async () => {
    await start();
    expect((await call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.0/24" } })).status).toBe(201);
    for (const mode of ["down", "hang"] as const) {
      if (mode === "down") agent.setUnavailable(true);
      else {
        agent.setUnavailable(false);
        agentFaults.set("readHostServices", "hang");
      }
      const t0 = Date.now();
      const health = await call("GET", "/v1/admin/health");
      expect([health.status, health.body.data.hostServices], mode).toEqual([200, null]);
      expect(Date.now() - t0, mode).toBeLessThan(4_500);
      if (mode === "hang") continue;
      const fw = await call("GET", "/v1/admin/firewall");
      expect(fw.status).toBe(200);
      expect(fw.body.data).toMatchObject({ baseRules: "unreadable", readAt: null });
      expect(fw.body.data.blocks.map((b: Json) => [b.address, b.inForce])).toEqual([["203.0.113.0/24", null]]);
      expect(fw.body.data.ports.every((p: Json) => p.inForce === null)).toBe(true);
      expect((await call("GET", "/v1/admin/updates")).status).toBe(200);
      expect(refusal(await call("GET", "/v1/admin/os-packages"))).toEqual([503, "HOST_AGENT_UNAVAILABLE", undefined]);
      expect((await call("GET", "/v1/admin/logs/hp-api")).status).toBe(503);
      // A change while the agent is down is stored and shown as not known to be in force.
      const open = await call("POST", "/v1/admin/firewall/ports/nrpe/open");
      expect(open.status).toBe(200);
      expect(open.body.data.ports.find((p: Json) => p.name === "nrpe")).toMatchObject({ open: true, inForce: null });
    }
    agentFaults.clear();
    // Back: shown as not in force until the next sync, which the next change is.
    const back = await call("GET", "/v1/admin/firewall");
    expect(back.body.data.ports.find((p: Json) => p.name === "nrpe")).toMatchObject({ open: true, inForce: false });
    expect((await call("POST", "/v1/admin/firewall/blocks", { body: { address: "198.51.100.0/24" } })).status).toBe(201);
    expect(await agent.readFirewall()).toMatchObject({ openedPorts: [5666], blockedV4: ["198.51.100.0/24", "203.0.113.0/24"] });
    expect(answers.some((a) => a.includes("INTERNAL_ERROR"))).toBe(false);
  }, 30_000);

  it("P9: executor down: Health and the updates read answer; a component move fails with its fixed sentence; nothing is 500", async () => {
    await start();
    sim.setPanelContainer("shared_database", { imageCurrent: false });
    await heartbeat();
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(sim)) as string[]) {
      if (name !== "constructor") execFaults.set(name, coded("DOCKER_ENGINE_UNAVAILABLE", "executor away"));
    }
    expect((await call("GET", "/v1/admin/health")).status).toBe(200);
    const u = await call("GET", "/v1/admin/updates");
    expect(u.status).toBe(200);
    expect(u.body.data.components[1]).toMatchObject({ component: "shared_database", imageCurrent: false });
    expect((await call("GET", "/v1/admin/firewall")).status).toBe(200);
    expect((await call("GET", "/v1/admin/os-packages")).status).toBe(200);
    const comp = await call("POST", "/v1/admin/updates/components/shared_database/apply");
    expect(comp.status).toBe(202);
    await age(comp.body.data.operationId, 3_000);
    await runWorker();
    expect(await opOf(comp.body.data.operationId)).toMatchObject({ status: "failed", errorMessage: "The container was not moved to its pinned image. Check Health, then try again." });
    expect(answers.some((a) => a.includes("INTERNAL_ERROR"))).toBe(false);
  }, 30_000);

  it("P9: with the runtime disabled every change is 422 before anything is stored", async () => {
    await start({ runtimeBackend: "disabled" });
    const before = await counts();
    const audits = (await dbClient.db.select().from(auditEvents)).length;
    for (const [method, path, body] of [
      ["POST", "/v1/admin/firewall/ports/nrpe/open"],
      ["POST", "/v1/admin/firewall/ports/nrpe/close"],
      ["POST", "/v1/admin/firewall/blocks", { address: "203.0.113.0/24" }],
      ["DELETE", `/v1/admin/firewall/blocks/fwb_${"c".repeat(32)}`],
      ["POST", "/v1/admin/host-services/web/restart", { reason: "Sentinel reason" }],
      ["POST", "/v1/admin/updates/panel/apply"],
      ["POST", "/v1/admin/updates/components/ingress_proxy/apply"],
      ["POST", "/v1/admin/os-packages/refresh"],
      ["POST", "/v1/admin/os-packages/upgrade"],
    ] as const) {
      expect(refusal(await call(method, path, { body })), path).toEqual([422, "NOT_SUPPORTED", undefined]);
    }
    expect(await counts()).toEqual(before);
    expect((await dbClient.db.select().from(auditEvents)).length).toBe(audits);
  });

  // ---------- Point 10: the lists reach the kernel again ----------

  it("P10: a list changed behind the panel's back shows as not in force and is sent again by apply again", async () => {
    await start();
    await call("POST", "/v1/admin/firewall/ports/https_alt/open");
    await call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.0/24" } });
    agent.overwriteFirewallSets({ openedPorts: [], blockedV4: [], blockedV6: [] });
    const view = (await call("GET", "/v1/admin/firewall")).body.data;
    expect([view.ports.find((p: Json) => p.name === "https_alt").inForce, view.blocks[0].inForce]).toEqual([false, false]);
    const applied = await call("POST", `/v1/hosts/${view.hostId as string}/security`, { body: { policyRef: "apply_dedicated_nftables_22_80_443" } });
    expect(applied.status).toBe(202);
    await runWorker();
    expect(await agent.readFirewall()).toMatchObject({ openedPorts: [8443], blockedV4: ["203.0.113.0/24"] });
  }, 20_000);

  it("P10: a sync and a change at the same moment, the first send slow: the kernel ends with the stored lists", async () => {
    let first = true;
    await start({ before: async (db) => void (await db.db.insert(firewallOpenPorts).values({ name: "nrpe" })) });
    agentFaults.set("replaceFirewallSets", async (...args) => {
      if (first) {
        first = false;
        await sleep(1_000);
      }
      return agent.replaceFirewallSets(args[0] as never);
    });
    const [synced, changed] = await Promise.all([firewall().sync(), call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.0/24" } })]);
    expect(synced).not.toBeNull();
    expect(changed.status).toBe(201);
    expect(await agent.readFirewall()).toMatchObject({ openedPorts: [5666], blockedV4: ["203.0.113.0/24"] });
    expect(changed.body.data.blocks[0].inForce).toBe(true);
  }, 20_000);

  it("P10: the start sync answered late does not overwrite a change made meanwhile", async () => {
    const slowAgent = new InMemoryHostSimulatorAdapter();
    const calls: Call[] = [];
    const faults = new Map<string, Fault>();
    let slow = true;
    faults.set("replaceFirewallSets", async (...args) => {
      if (slow) {
        slow = false;
        await sleep(1_000);
      }
      return slowAgent.replaceFirewallSets(args[0] as never);
    });
    realFetch = globalThis.fetch;
    answers = [];
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    await dbClient.db.insert(firewallOpenPorts).values({ name: "nrpe" });
    app = await createControlPlaneApp({
      listen: true, host: "127.0.0.1", port: 0, databaseClient: dbClient, secretsMasterKey: KEY, runtimeBackend: "local-simulator",
      dockerExecutor: new InMemoryDockerSimulatorAdapter() as DockerExecutorPort, hostAgent: spy(slowAgent, calls, faults) as HostAgentPort,
      autoProcessOutbox: false, outboxPollIntervalMs: null, driftReconcileIntervalMs: null, domainReconcileIntervalMs: null, recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    const res = await call("POST", "/v1/admin/firewall/blocks", { body: { address: "203.0.113.0/24" } });
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(calls.filter((c) => c.name === "replaceFirewallSets").length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
    expect(await slowAgent.readFirewall()).toMatchObject({ openedPorts: [5666], blockedV4: ["203.0.113.0/24"] });
  }, 20_000);

  // ---------- Point 11: the update check asks only the fixed address ----------

  it("P11: one request to the fixed URL with two headers and nothing naming the server; wrong answers end in a closed state, never a 5xx; nothing is downloaded or applied", async () => {
    await start();
    const shapes: [() => Promise<Response>, string][] = [
      [async () => new Response(null, { status: 302, headers: { location: "https://evil.example.test/" } }), "failed"],
      [async () => new Response("x".repeat(2 * 1024 * 1024), { status: 200 }), "failed"],
      [async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }, "failed"],
      [async () => new Response("{}", { status: 404 }), "no_release"],
      [async () => new Response("{}", { status: 500 }), "failed"],
      [async () => new Response(JSON.stringify({ tag_name: "1.5.0" }), { status: 200 }), "failed"],
      [async () => new Response(JSON.stringify({ tag_name: "v1.5" }), { status: 200 }), "failed"],
      [async () => new Response(JSON.stringify({ tag_name: "v1.5.0-rc1" }), { status: 200 }), "failed"],
      [async () => new Response(JSON.stringify({ tag_name: "v1.5.0;rm" }), { status: 200 }), "failed"],
      [async () => new Response(JSON.stringify({ tag_name: 150 }), { status: 200 }), "failed"],
      [async () => new Response(JSON.stringify({ name: "v1.5.0" }), { status: 200 }), "failed"],
      [async () => new Response(JSON.stringify({ tag_name: "v1.5.0", assets: [{ browser_download_url: "https://evil.example.test/a" }] }), { status: 200 }), "newer"],
    ];
    agentCalls.length = 0;
    execCalls.length = 0;
    for (const [answer, state] of shapes) {
      release = answer;
      allFetches.length = 0;
      const res = await call("POST", "/v1/admin/updates/panel/check");
      expect([res.status, res.body.data?.panel?.check?.state], state).toEqual([200, state]);
      expect(allFetches.filter((u) => u !== `${app.baseUrl!}/v1/admin/updates/panel/check`)).toEqual([PANEL_RELEASE_LATEST_URL]);
    }
    expect(releaseCalls).toHaveLength(shapes.length);
    for (const { url, init } of releaseCalls) {
      expect(url).toBe(PANEL_RELEASE_LATEST_URL);
      expect(init.redirect).toBe("error");
      expect(init.method ?? "GET").toBe("GET");
      expect(init.body ?? null).toBeNull();
      expect(Object.keys(init.headers as Json).sort()).toEqual(["accept", "user-agent"]);
      const told = JSON.stringify([url, init.headers]);
      for (const secret of ["panel.example.test", "192.0.2.1", "admin@example.test", "M5d QA", "1.4.2"]) expect(told).not.toContain(secret);
    }
    expect(agentCalls.filter((c) => c.name !== "readFirewall")).toEqual([]);
    expect(execCalls).toEqual([]);
    expect(await counts()).toMatchObject({ operations: 0 });
  }, 30_000);

  // ---------- Point 12: a site keeps what it had ----------

  it("P12: image-update changes one site only; unknown 404, current and stopped 400; a customer cannot call it nor read the row, but sees the deploy without an image name", async () => {
    await start();
    const o = await owner();
    const a = await createSite(o.orgId, "wp-a.example.test");
    const b = await createSite(o.orgId, "wp-b.example.test");
    expect(refusal(await call("POST", `/v1/admin/sites/${a.siteId}/image-update`))).toEqual([400, "VALIDATION_ERROR", "already_current"]);
    expect((await call("POST", "/v1/admin/sites/site_unknown/image-update")).status).toBe(404);
    await putBehind(a.siteId);
    await putBehind(b.siteId);
    await dbClient.db.update(serviceInstances).set({ desiredStatus: "stopped" }).where(eq(serviceInstances.id, b.serviceId));
    expect(refusal(await call("POST", `/v1/admin/sites/${b.siteId}/image-update`))).toEqual([400, "VALIDATION_ERROR", "stopped"]);
    await dbClient.db.update(serviceInstances).set({ desiredStatus: "running" }).where(eq(serviceInstances.id, b.serviceId));
    const bBefore = JSON.stringify(await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.id, b.serviceId)));
    expect((await call("POST", `/v1/admin/sites/${a.siteId}/image-update`, { as: o.token })).status).toBe(403);
    const res = await call("POST", `/v1/admin/sites/${a.siteId}/image-update`);
    expect(res.status).toBe(202);
    await runWorker();
    expect(JSON.stringify(await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.id, b.serviceId)))).toBe(bBefore);
    const deploys = (await dbClient.db.select().from(operations)).filter((op) => op.kind === "service.deploy" && op.submittedAt.getTime() > Date.now() - 60_000);
    expect(deploys.map((d) => d.id)).toContain(res.body.data.operationId);
    expect((await call("GET", "/v1/admin/updates")).body.data.sites.map((s: Json) => s.siteId)).toEqual([b.siteId]);
    // Who reads the row: the server administrator through the audit list; the owner gets 403 there.
    const adminAudit = await call("GET", "/v1/admin/audit?action=admin.update.site_image");
    expect(adminAudit.status).toBe(200);
    expect(adminAudit.body.data.map((r: Json) => r.action)).toEqual(["admin.update.site_image"]);
    expect((await call("GET", "/v1/admin/audit?action=admin.update.site_image", { as: o.token })).status).toBe(403);
    const ops = await call("GET", `/v1/organizations/${o.orgId}/operations`, { as: o.token });
    expect(ops.status).toBe(200);
    expect(ops.raw).toContain(res.body.data.operationId);
    for (const bad of PINNED_NAMES) expect(ops.raw, bad).not.toContain(bad);
  }, 60_000);

  it("P12 (R202 2.2): when the site_image row cannot be written no deploy is left; a retry with the same key deploys once with one row", async () => {
    await start();
    const { siteId } = await createSite();
    await putBehind(siteId);
    await dbClient.db.execute(sql.raw(`CREATE FUNCTION qa_refuse_site_image() RETURNS trigger AS $$
      BEGIN IF NEW.action = 'admin.update.site_image' THEN RAISE EXCEPTION 'qa refuses'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`));
    await dbClient.db.execute(sql.raw("CREATE TRIGGER qa_refuse_site_image BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION qa_refuse_site_image()"));
    const key = randomUUID();
    const res = await call("POST", `/v1/admin/sites/${siteId}/image-update`, { key });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const deploys = (await dbClient.db.select().from(operations)).filter((op) => op.kind === "service.deploy" && op.idempotencyKey === key);
    expect(deploys).toEqual([]);
    expect(await rowsOf("admin.update.site_image")).toEqual([]);
    await dbClient.db.execute(sql.raw("DROP TRIGGER qa_refuse_site_image ON audit_events"));
    const retry = await call("POST", `/v1/admin/sites/${siteId}/image-update`, { key });
    expect(retry.status).toBe(202);
    const again = await call("POST", `/v1/admin/sites/${siteId}/image-update`, { key });
    expect([again.status, again.body.data.operationId]).toEqual([202, retry.body.data.operationId]);
    const rows = await rowsOf("admin.update.site_image");
    expect(rows.map((r) => (r.details as Record<string, unknown>).operationId)).toEqual([retry.body.data.operationId]);
  }, 30_000);
});
