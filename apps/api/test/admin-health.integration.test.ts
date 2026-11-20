import { randomUUID } from "node:crypto";
import {
  AdminAlertDtoSchema,
  AdminHealthDtoSchema,
  PANEL_COMPONENTS,
  PLATFORM_OPS_ORG_ID,
  SITE_CONTAINER_DOWN_GRACE_MS,
  SITE_RESTART_QUIET_MS,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  backupSettings,
  createDatabaseClient,
  domains,
  eq,
  hostAgentHeartbeats,
  hosts,
  observedStates,
  operations,
  recordObservedStateReconciliationTransactional,
  serviceInstances,
  siteBackups,
  upsertHostAgentHeartbeat,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { Phase1DisabledDockerExecutor, type DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { Phase1DisabledHostAgent, type HostAgentPort, type HostDisk } from "@hosting-panel/host-agent-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle, type CreateControlPlaneAppOptions } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 5);
const PW = "sentinel-password-0001";
const SETUP = { installationName: "Health Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Pass-123456",
};
const PLANTED = "PLANTEDENGINEWORD";
const HASH = "c".repeat(64);
const MIN = 60_000;
const AlertsSchema = z.array(AdminAlertDtoSchema);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Records every method call made on a port. */
function recorded<T extends object>(target: T): { port: T; calls: string[] } {
  const calls: string[] = [];
  const port = new Proxy(target, {
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.push(String(p));
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { port, calls };
}

describe("admin health and alerts", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let agent: InMemoryHostSimulatorAdapter;
  let executorCalls: string[];
  let agentCalls: string[];
  let agentEnabled: boolean;
  let adminToken: string;
  let hostId: string;

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  async function start(opts: Partial<CreateControlPlaneAppOptions> & { disabled?: boolean } = {}): Promise<void> {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    agent = new InMemoryHostSimulatorAdapter();
    const exec = recorded<DockerExecutorPort>(opts.disabled ? new Phase1DisabledDockerExecutor() : sim);
    const host = recorded<HostAgentPort>(opts.disabled ? new Phase1DisabledHostAgent() : agent);
    executorCalls = exec.calls;
    agentCalls = host.calls;
    agentEnabled = !opts.disabled;
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: opts.disabled ? "disabled" : "local-simulator",
      dockerExecutor: exec.port,
      hostAgent: host.port,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    hostId = (await dbClient.db.select({ id: hosts.id }).from(hosts))[0]!.id;
  }

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    await dbClient.close();
  });

  /** Both answers: no executor call; of the agent only readHostServices, during Health (R198 7.1); nothing outside the closed lists. */
  async function both(): Promise<{ health: z.infer<typeof AdminHealthDtoSchema>; alerts: z.infer<typeof AlertsSchema> }> {
    executorCalls.length = 0;
    agentCalls.length = 0;
    const h = await call("GET", "/v1/admin/health", adminToken);
    expect(agentCalls).toEqual(agentEnabled ? ["readHostServices"] : []);
    agentCalls.length = 0;
    const a = await call("GET", "/v1/admin/alerts", adminToken);
    expect([h.status, a.status]).toEqual([200, 200]);
    expect(executorCalls).toEqual([]);
    expect(agentCalls).toEqual([]);
    for (const raw of [h.raw, a.raw]) {
      expect(raw).not.toMatch(/[0-9a-f]{64}/i);
      expect(raw).not.toMatch(/\/(var|opt|etc)\//);
      expect(raw).not.toContain(PLANTED);
    }
    return { health: AdminHealthDtoSchema.parse(h.body.data), alerts: AlertsSchema.parse(a.body.data) };
  }

  const part = (health: { components: readonly { component: string }[] }, name: string) =>
    health.components.find((c) => c.component === name) as Json;
  const kinds = (alerts: readonly { kind: string }[]) => alerts.map((a) => a.kind);
  const heartbeat = (component: "docker_executor" | "host_agent" | "panel_containers" | "panel_certificate", snapshot: Record<string, unknown>, extra: { status?: "online" | "offline" | "degraded"; lastSeenAt?: Date } = {}) =>
    upsertHostAgentHeartbeat(dbClient.db, { hostId, component, status: extra.status ?? "online", version: "1", telemetrySnapshot: snapshot, lastSeenAt: extra.lastSeenAt });
  const drift = () => app.driftReconciler.reconcileAllOnce();

  async function createSite(): Promise<{ siteId: string; serviceId: string }> {
    const res = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, ownerOrganizationId: null });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const siteId = res.body.data.siteId as string;
    const [svc] = await dbClient.db.select({ id: serviceInstances.id }).from(serviceInstances).where(eq(serviceInstances.siteId, siteId));
    return { siteId, serviceId: svc!.id };
  }

  const telemetryWith = (disks: HostDisk[]) => {
    agent.getHostTelemetry = async (id: string) => ({
      hostId: id, cpuUsagePercent: 1, memoryUsedBytes: "1", storageUsedBytes: "1",
      dockerEngineReachable: true, collectedAt: new Date().toISOString(), disks,
    });
  };

  it("a fresh install lists all eleven parts in contract order; the daemons are unknown, not reporting", async () => {
    await start();
    const { health, alerts } = await both();
    expect(health.components.map((c) => c.component)).toEqual([...PANEL_COMPONENTS]);
    for (const name of ["api", "web", "database"]) expect(part(health, name).state).toBe("ok");
    for (const name of PANEL_COMPONENTS.slice(3)) expect(part(health, name)).toMatchObject({ state: "unknown", reason: "not_reporting" });
    expect(alerts).toEqual([]);
  });

  it("the drift pass stores the panel containers and the disks; the routes derive states and alerts from them", async () => {
    await start();
    sim.setPanelContainer("sftp", { state: "stopped", expected: true });
    sim.setPanelContainer("phpmyadmin", { state: "degraded", expected: true, restartCount: 4 });
    sim.setPanelContainer("mail_relay", { state: "missing", expected: false });
    telemetryWith([
      { paths: ["panel_data", "docker_data"], usedBytes: "90", totalBytes: "100" },
      { paths: ["root"], usedBytes: "89", totalBytes: "100" },
    ]);
    await drift();
    const { health, alerts } = await both();
    expect(part(health, "executor")).toMatchObject({ state: "ok", reason: null });
    expect(part(health, "host_agent")).toMatchObject({ state: "ok", reason: null });
    expect(part(health, "docker_engine")).toMatchObject({ state: "ok", reason: null });
    expect(part(health, "shared_database")).toMatchObject({ state: "ok", reason: null });
    expect(part(health, "sftp")).toMatchObject({ state: "down", reason: "stopped" });
    expect(part(health, "phpmyadmin")).toMatchObject({ state: "degraded", reason: "restarting" });
    expect(part(health, "mail_relay")).toMatchObject({ state: "not_in_use", reason: null });
    expect(health.disks.map((d) => [d.paths, d.usedPercent])).toEqual([[["panel_data", "docker_data"], 90], [["root"], 89]]);
    const disk = alerts.filter((a) => a.kind === "disk_high");
    expect(disk.map((a) => a.details)).toEqual([{ paths: ["panel_data", "docker_data"], usedPercent: 90 }]);
    expect(alerts.filter((a) => a.kind === "component_down").map((a) => a.subject).sort()).toEqual(["phpmyadmin", "sftp"]);
    expect(alerts.every((a, i) => i === 0 || !(a.severity === "critical" && alerts[i - 1]!.severity === "warning"))).toBe(true);
  });

  it("with the executor stopped both routes answer from the store: unknown, not reporting", async () => {
    await start();
    sim.pingEngine = async () => { throw new Error("connect ECONNREFUSED"); };
    sim.getPanelContainers = async () => { throw new Error("connect ECONNREFUSED"); };
    await drift();
    const [row] = await dbClient.db.select().from(hostAgentHeartbeats).where(eq(hostAgentHeartbeats.component, "panel_containers"));
    expect(row?.status).toBe("offline");
    // A request never waits on the executor: any call would hang.
    sim.getPanelContainers = () => new Promise(() => undefined);
    sim.getCertificateStatus = () => new Promise(() => undefined);
    const { health, alerts } = await both();
    expect(part(health, "executor")).toMatchObject({ state: "down", reason: "not_reporting" });
    for (const name of ["docker_engine", "ingress_proxy", "shared_database", "phpmyadmin", "sftp", "mail_relay"]) {
      expect(part(health, name)).toMatchObject({ state: "unknown", reason: "not_reporting" });
    }
    expect(alerts.map((a) => [a.kind, a.subject])).toEqual([["component_down", "executor"]]);
  });

  it("with the Engine unreachable the containers are unknown, engine unreachable", async () => {
    await start();
    sim.setEngineReachable(false);
    await drift();
    const { health, alerts } = await both();
    expect(part(health, "executor")).toMatchObject({ state: "ok" });
    expect(part(health, "docker_engine")).toMatchObject({ state: "down", reason: "engine_unreachable" });
    for (const name of ["ingress_proxy", "shared_database", "phpmyadmin", "sftp", "mail_relay"]) {
      expect(part(health, name)).toMatchObject({ state: "unknown", reason: "engine_unreachable" });
    }
    expect(alerts.map((a) => [a.kind, a.subject])).toEqual([["component_down", "docker_engine"]]);
  });

  it("with the runtime disabled every runtime part is unknown, runtime disabled, and nothing is raised", async () => {
    await start({ disabled: true });
    await drift();
    const { health, alerts } = await both();
    for (const name of ["api", "web", "database"]) expect(part(health, name).state).toBe("ok");
    for (const name of PANEL_COMPONENTS.slice(3)) expect(part(health, name)).toMatchObject({ state: "unknown", reason: "runtime_disabled" });
    expect(alerts).toEqual([]);
  });

  it("an agent that never answers still gives Health within the 3 s bound, with hostServices null", async () => {
    await start();
    vi.spyOn(agent, "readHostServices").mockReturnValue(new Promise(() => undefined));
    const began = Date.now();
    const { health } = await both();
    expect(Date.now() - began).toBeLessThan(5_000);
    expect(health.hostServices).toBeNull();
  }, 15_000);

  it("a heartbeat older than the threshold turns its part down and raises component_down", async () => {
    await start();
    await heartbeat("docker_executor", { dockerEngineReachable: true, note: `${PLANTED} /var/lib/x ${HASH}` }, { lastSeenAt: new Date(Date.now() - 6 * MIN) });
    await heartbeat("host_agent", { dockerEngineReachable: true });
    const { health, alerts } = await both();
    expect(part(health, "executor")).toMatchObject({ state: "down", reason: "not_reporting" });
    expect(part(health, "host_agent")).toMatchObject({ state: "ok" });
    expect(part(health, "docker_engine")).toMatchObject({ state: "unknown", reason: "not_reporting" });
    expect(alerts.find((a) => a.kind === "component_down")).toMatchObject({ subject: "executor", severity: "critical", details: { state: "down", reason: "not_reporting" } });
  });

  it("a panel_containers row holding Engine free text is unknown and leaks nothing", async () => {
    await start();
    await heartbeat("docker_executor", { dockerEngineReachable: true });
    await heartbeat("panel_containers", { containers: [{ component: "sftp", state: `Up 5 minutes ${PLANTED}`, id: HASH, path: "/var/lib/docker/x" }] });
    const { health } = await both();
    expect(part(health, "sftp")).toMatchObject({ state: "unknown", reason: "not_reporting" });
  });

  it("disk at 90 % raises disk_high, at 89 % it does not", async () => {
    await start();
    await heartbeat("host_agent", { disks: [{ paths: ["root"], usedBytes: "89", totalBytes: "100" }] });
    expect(kinds((await both()).alerts)).not.toContain("disk_high");
    await heartbeat("host_agent", { disks: [{ paths: ["root"], usedBytes: "90", totalBytes: "100" }] });
    const { alerts } = await both();
    expect(alerts.find((a) => a.kind === "disk_high")).toMatchObject({ severity: "critical", subject: "root", details: { paths: ["root"], usedPercent: 90 } });
  });

  describe("site containers", () => {
    it("maps the site row, its restart count and drift reason, and leaks no hash and no Engine text", async () => {
      await start();
      const { siteId, serviceId } = await createSite();
      await drift();
      let { health } = await both();
      expect(health.siteContainers).toEqual([expect.objectContaining({ siteId, siteName: SITE.name, organizationName: null, desired: "running", observed: "running", driftReason: null, restartCount: 0, stale: false })]);
      await recordObservedStateReconciliationTransactional(dbClient.db, {
        serviceInstanceId: serviceId, observedStatus: "running", observedRevisionHash: HASH, outOfBandModified: false, rawState: { restartCount: 3 },
      });
      ({ health } = await both());
      // The count rose 0 -> 3 since the look before: restarting (R189 1.3).
      expect(health.siteContainers[0]).toMatchObject({ observed: "degraded", driftReason: "revision_mismatch", restartCount: 3 });
      await recordObservedStateReconciliationTransactional(dbClient.db, {
        serviceInstanceId: serviceId, observedStatus: `exited ${PLANTED}`, observedRevisionHash: HASH, outOfBandModified: false, rawState: { restartCount: 3 },
      });
      ({ health } = await both());
      expect(health.siteContainers[0]).toMatchObject({ observed: "unknown", driftReason: "status_mismatch" });
    });

    it("raises site_container_down only after the grace, and never for a site wanted stopped", async () => {
      await start();
      const { siteId, serviceId } = await createSite();
      const observe = (at: Date) => recordObservedStateReconciliationTransactional(dbClient.db, {
        serviceInstanceId: serviceId, observedStatus: "stopped", outOfBandModified: false, rawState: {}, observedAt: at,
      });
      await observe(new Date());
      expect(kinds((await both()).alerts)).not.toContain("site_container_down");
      await dbClient.db.update(observedStates).set({ rawState: { notRunningSince: new Date(Date.now() - 6 * MIN).toISOString() } }).where(eq(observedStates.serviceInstanceId, serviceId));
      await observe(new Date());
      const { alerts } = await both();
      expect(alerts.find((a) => a.kind === "site_container_down")).toMatchObject({ severity: "critical", subject: siteId, details: { siteId, siteName: SITE.name, observed: "stopped" } });
      await dbClient.db.update(serviceInstances).set({ desiredStatus: "stopped" }).where(eq(serviceInstances.id, serviceId));
      expect(kinds((await both()).alerts)).not.toContain("site_container_down");
    });

    const look = (serviceId: string, observedStatus: string, restartCount: number, at: Date) => recordObservedStateReconciliationTransactional(dbClient.db, {
      serviceInstanceId: serviceId, observedStatus, outOfBandModified: false, rawState: { restartCount }, observedAt: at,
    });
    const storedSince = async (serviceId: string) =>
      ((await dbClient.db.select().from(observedStates).where(eq(observedStates.serviceInstanceId, serviceId)))[0]!.rawState as Json).notRunningSince as unknown;
    const ago = (ms: number) => new Date(Date.now() - ms);

    it("R189 1.2: a wanted stop clears the clock, so a start gets the full grace", async () => {
      await start();
      const { siteId, serviceId } = await createSite();
      await dbClient.db.update(serviceInstances).set({ desiredStatus: "stopped" }).where(eq(serviceInstances.id, serviceId));
      await dbClient.db.update(observedStates).set({ rawState: { notRunningSince: ago(3 * 24 * 60 * MIN).toISOString() } }).where(eq(observedStates.serviceInstanceId, serviceId));
      await look(serviceId, "stopped", 0, new Date());
      expect(await storedSince(serviceId)).toBeUndefined();
      await dbClient.db.update(serviceInstances).set({ desiredStatus: "running" }).where(eq(serviceInstances.id, serviceId));
      await look(serviceId, "stopped", 0, new Date());
      expect(kinds((await both()).alerts)).not.toContain("site_container_down");
      const since = ago(6 * MIN).toISOString();
      await dbClient.db.update(observedStates).set({ rawState: { restartCount: 0, notRunningSince: since } }).where(eq(observedStates.serviceInstanceId, serviceId));
      await look(serviceId, "stopped", 0, new Date());
      expect((await both()).alerts.find((a) => a.kind === "site_container_down")).toMatchObject({ subject: siteId, since, details: { observed: "stopped" } });
    });

    const STEP = 15_000;
    /** Stores looks 15 s apart on a faked clock (looks are [status, restart count]) and runs `check` after each. */
    async function play(serviceId: string, looks: readonly (readonly [string, number])[], check: (i: number, at: number) => Promise<void>): Promise<void> {
      vi.useFakeTimers({ toFake: ["Date"] });
      const t0 = Date.now();
      for (const [i, [status, count]] of looks.entries()) {
        vi.setSystemTime(t0 + i * STEP);
        await look(serviceId, status, count, new Date(t0 + i * STEP));
        await check(i, t0 + i * STEP);
      }
    }
    const downAlert = async () => {
      const { health, alerts } = await both();
      return { row: health.siteContainers[0]!, alert: alerts.find((a) => a.kind === "site_container_down") };
    };

    it("R190 1.1 (a): the history Docker writes (count rises on exit) keeps the clock and alerts after the grace", async () => {
      await start();
      const { siteId, serviceId } = await createSite();
      const looks: [string, number][] = [["running", 0]];
      for (let k = 1; k <= 8; k++) looks.push(["degraded", k], ["degraded", k], ["running", k]);
      let first = 0;
      await play(serviceId, looks, async (i, at) => {
        if (i === 0) return expect(await storedSince(serviceId)).toBeUndefined();
        if (i === 1) first = at;
        expect(await storedSince(serviceId)).toBe(new Date(first).toISOString());
        const { alert } = await downAlert();
        if (at - first < SITE_CONTAINER_DOWN_GRACE_MS) expect(alert).toBeUndefined();
        else expect(alert).toMatchObject({ subject: siteId, since: new Date(first).toISOString() });
      });
      expect((looks.length - 2) * STEP).toBeGreaterThan(SITE_CONTAINER_DOWN_GRACE_MS);
    });

    it("R190 1.1 (b): runs of 30 s seen by looks every 15 s alert as degraded after the grace", async () => {
      await start();
      const { siteId, serviceId } = await createSite();
      const looks: [string, number][] = [["running", 0]];
      for (let k = 1; k <= 12; k++) looks.push(["running", k], ["running", k]);
      let first = 0;
      await play(serviceId, looks, async (i, at) => {
        const { row, alert } = await downAlert();
        if (i === 0) return expect(row.observed).toBe("running");
        if (i === 1) first = at;
        expect(row.observed).toBe("degraded");
        if (at - first < SITE_CONTAINER_DOWN_GRACE_MS) expect(alert).toBeUndefined();
        else expect(alert).toMatchObject({ subject: siteId, since: new Date(first).toISOString(), details: { observed: "degraded" } });
      });
      expect((looks.length - 2) * STEP).toBeGreaterThan(SITE_CONTAINER_DOWN_GRACE_MS);
    });

    it("R190 1.1 (c): one crash alone is degraded for two minutes, then running, and never alerts", async () => {
      await start();
      const { serviceId } = await createSite();
      const looks: [string, number][] = [["running", 0], ...Array.from({ length: 14 }, () => ["running", 1] as [string, number])];
      let rise = 0;
      await play(serviceId, looks, async (i, at) => {
        if (i === 1) rise = at;
        const { row, alert } = await downAlert();
        expect(alert).toBeUndefined();
        expect(row.observed).toBe(i >= 1 && at - rise < SITE_RESTART_QUIET_MS ? "degraded" : "running");
      });
    });

    it("R190 1.1 (d): a start by hand (count back to 0) stops the clock at once", async () => {
      await start();
      const { serviceId } = await createSite();
      await play(serviceId, [["running", 0], ["running", 1], ["running", 1], ["running", 0]], async (i) => {
        const { row } = await downAlert();
        expect(row.observed).toBe(i === 1 || i === 2 ? "degraded" : "running");
        if (i === 3) expect(await storedSince(serviceId)).toBeUndefined();
      });
    });

    it("R190 1.1 (e): a wanted stop forgets the rise", async () => {
      await start();
      const { serviceId } = await createSite();
      const wanted = (desiredStatus: "running" | "stopped") => dbClient.db.update(serviceInstances).set({ desiredStatus }).where(eq(serviceInstances.id, serviceId));
      await play(serviceId, [["running", 0], ["running", 1], ["stopped", 1], ["running", 1]], async (i) => {
        if (i === 1) await wanted("stopped");
        if (i === 2) await wanted("running");
        if (i === 3) {
          expect(await storedSince(serviceId)).toBeUndefined();
          expect((await downAlert()).row.observed).toBe("running");
        }
      });
    });

    it("R190 1.2: a container removed outside the panel is missing, and a PHP version change creates it again", async () => {
      await start();
      const { siteId, serviceId } = await createSite();
      await sim.deleteService(serviceId);
      await drift();
      expect((await downAlert()).row.observed).toBe("missing");
      // The support view opens the site's page; the PHP version control there sends this request.
      expect((await call("POST", `/v1/admin/sites/${siteId}/support-access`, adminToken)).status).toBeLessThan(300);
      const res = await call("PATCH", `/v1/organizations/${PLATFORM_OPS_ORG_ID}/managed-sites/${siteId}/runtime`, adminToken, { phpVersion: "8.5" });
      expect(res.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, res.body.data.operationId as string));
      expect(op!.status).toBe("succeeded");
      await drift();
      expect((await downAlert()).row.observed).toBe("running");
    });

    it("R190 1.2: the administrator's Restart creates a missing container again", async () => {
      await start();
      const { siteId, serviceId } = await createSite();
      await sim.deleteService(serviceId);
      await drift();
      expect((await downAlert()).row.observed).toBe("missing");
      const res = await call("POST", `/v1/admin/sites/${siteId}/restart`, adminToken, { reason: "Container gone" });
      expect(res.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, res.body.data.operationId as string));
      expect(op!.status).toBe("succeeded");
      await drift();
      expect((await downAlert()).row.observed).toBe("running");
    });

    it("R191 1.2: one rise, then no more looks, six minutes later raises no site_container_down", async () => {
      await start();
      const { serviceId } = await createSite();
      const looks: [string, number][] = [["running", 0], ...Array.from({ length: 8 }, () => ["running", 1] as [string, number])];
      let rise = 0;
      await play(serviceId, looks, async (i, at) => {
        if (i === 1) rise = at;
      });
      vi.setSystemTime(rise + 6 * MIN);
      const { row, alert } = await downAlert();
      expect(row.stale).toBe(false);
      expect(alert).toBeUndefined();
    });

    it("R191 5: raises certificate_not_issued and certificate_expiring for a site's domains, nothing for a healthy one", async () => {
      await start();
      const { siteId } = await createSite();
      const days = (n: number) => new Date(Date.now() + n * 24 * 3_600_000);
      const soon = days(10);
      const domain = (hostname: string, patch: Partial<typeof domains.$inferInsert>) => ({ id: `dom_${hostname.split(".")[0]!}`, siteId, organizationId: PLATFORM_OPS_ORG_ID, hostname, ...patch });
      await dbClient.db.insert(domains).values([
        domain("wp-b.example.test", { certStatus: "failed", certProblem: "port_80_blocked", certAttempts: 2 }),
        domain("wp-c.example.test", { certStatus: "active", certExpiresAt: soon }),
        domain("wp-d.example.test", { certStatus: "active", certExpiresAt: days(60) }),
      ]);
      const { alerts } = await both();
      expect(alerts.find((a) => a.kind === "certificate_not_issued")).toMatchObject({
        subject: "wp-b.example.test", details: { siteId, siteName: SITE.name, hostname: "wp-b.example.test", problem: "port_80_blocked" },
      });
      expect(alerts.find((a) => a.kind === "certificate_expiring")).toMatchObject({
        subject: "wp-c.example.test", details: { siteId, siteName: SITE.name, hostname: "wp-c.example.test", problem: null, expiresAt: soon.toISOString() },
      });
      expect(alerts.filter((a) => a.subject === "wp-d.example.test")).toEqual([]);
    });

    it("raises each backup kind and restore_undo_incomplete", async () => {
      await start();
      const { siteId } = await createSite();
      const at = new Date(Date.now() - 30 * MIN);
      await dbClient.db.insert(siteBackups).values([
        { id: "bk_failed", siteId, kind: "nightly", status: "failed", startedAt: at, finishedAt: at },
        { id: "bk_restored", siteId, kind: "manual", status: "succeeded", startedAt: new Date(at.getTime() - MIN), finishedAt: at, restoreStatus: "failed", restoreProblem: "undo_incomplete", restoredAt: at },
      ]);
      await dbClient.db.insert(backupSettings).values({
        id: "default", endpoint: "https://s3.example.test", region: "r", bucket: "b", accessKeyId: "sentinel",
        secretAccessKeyCiphertextBase64: "x", secretAccessKeyIvBase64: "x", secretAccessKeyAuthTagBase64: "x",
        lastTestAt: at, lastTestOutcome: "failed", lastPanelBackupAt: at, lastPanelBackupStatus: "failed",
      });
      const { alerts } = await both();
      expect(alerts.find((a) => a.kind === "backup_failed")).toMatchObject({ subject: siteId, details: { siteId, siteName: SITE.name, failedAt: at.toISOString() } });
      expect(alerts.find((a) => a.kind === "panel_backup_failed")).toMatchObject({ subject: "panel", details: { failedAt: at.toISOString() } });
      expect(alerts.find((a) => a.kind === "backup_storage_test_failed")).toMatchObject({ subject: "storage", details: { testedAt: at.toISOString() } });
      expect(alerts.find((a) => a.kind === "restore_undo_incomplete")).toMatchObject({ severity: "critical", subject: "bk_restored", details: { siteId, backupId: "bk_restored" } });
      expect(alerts[0]!.kind).toBe("restore_undo_incomplete");
    });

    it("raises restore_stuck past the deadline, operation_unknown and operation_stuck, and nothing for a restore inside its deadline", async () => {
      await start();
      const { siteId } = await createSite();
      const ago = (ms: number) => new Date(Date.now() - ms);
      const op = (id: string, kind: "site.backups.restore" | "site.deploy", status: "processing" | "unknown", startedAt: Date, updatedAt: Date, leaseExpiresAt: Date | null) => ({
        id, organizationId: PLATFORM_OPS_ORG_ID, kind, status, resourceType: "site" as const, resourceId: siteId, startedAt, updatedAt, leaseExpiresAt,
      });
      await dbClient.db.insert(operations).values([
        op("op_restore_old", "site.backups.restore", "processing", ago(7 * 3_600_000), ago(7 * 3_600_000), ago(6 * 3_600_000)),
        op("op_restore_new", "site.backups.restore", "processing", ago(60 * MIN), ago(60 * MIN), ago(30 * MIN)),
        op("op_restore_unknown", "site.backups.restore", "unknown", ago(60 * MIN), ago(30 * MIN), null),
        op("op_unknown", "site.deploy", "unknown", ago(60 * MIN), ago(20 * MIN), null),
        op("op_stuck", "site.deploy", "processing", ago(60 * MIN), ago(60 * MIN), ago(10 * MIN)),
      ]);
      const { alerts } = await both();
      const ops = alerts.filter((a) => ["restore_stuck", "operation_unknown", "operation_stuck"].includes(a.kind)).map((a) => [a.kind, a.subject]);
      expect(ops).toEqual([["restore_stuck", "op_restore_old"], ["operation_unknown", "op_unknown"], ["operation_stuck", "op_stuck"]]);
      expect(alerts.find((a) => a.kind === "operation_stuck")).toMatchObject({ details: { operationId: "op_stuck", kind: "site.deploy", siteId, siteName: SITE.name } });
    });
  });

  it("raises panel_certificate_expiring on an installation with no site after one domain pass, and the banner reads it", async () => {
    await start();
    const notAfter = new Date(Date.now() + 3 * 24 * 3_600_000).toISOString();
    sim.issueCertificate(SETUP.hostHostname, notAfter);
    expect(kinds((await both()).alerts)).not.toContain("panel_certificate_expiring");
    await app.domainReconciler.reconcileOnce();
    const { alerts } = await both();
    expect(alerts.find((a) => a.kind === "panel_certificate_expiring")).toMatchObject({ severity: "warning", subject: SETUP.hostHostname, details: { hostname: SETUP.hostHostname, expiresAt: notAfter } });
    executorCalls.length = 0;
    const banner = await call("GET", "/v1/admin/sites", adminToken);
    expect(banner.body.data.certificateAlerts).toEqual([{ kind: "panel_expiring", siteId: null, siteName: null, hostname: SETUP.hostHostname, expiresAt: notAfter, problem: null }]);
    expect(executorCalls).not.toContain("getCertificateStatus");
  });

  it("a customer gets 403 and a denied audit row on both routes", async () => {
    await start();
    const created = await call("POST", "/v1/admin/customer-account", adminToken, { organizationName: "Org A", ownerEmail: "owner@example.test", ownerName: "Owner" });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "owner@example.test");
    const token = await login("owner@example.test", created.body.data.temporaryPassword as string);
    for (const path of ["/v1/admin/health", "/v1/admin/alerts"]) {
      const before = (await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id);
      const res = await call("GET", path, token);
      expect(res.status).toBe(403);
      const added = (await dbClient.db.select().from(auditEvents)).filter((r) => !before.includes(r.id));
      expect(added).toHaveLength(1);
      expect((added[0]!.details as Json).outcome).toBe("denied");
    }
  });

  it("R184 2.5 (c): redaction keeps containers, disks, notAfter and notRunningSince of a stored snapshot", async () => {
    await start();
    const containers = [{ component: "sftp", state: "running", expected: true, startedAt: null, restartCount: 0 }];
    const disks = [{ paths: ["root"], usedBytes: "1", totalBytes: "2" }];
    await heartbeat("panel_containers", { containers });
    await heartbeat("host_agent", { disks });
    await heartbeat("panel_certificate", { hostname: SETUP.hostHostname, notAfter: "2030-01-01T00:00:00.000Z" });
    const rows = await dbClient.db.select().from(hostAgentHeartbeats);
    const snap = (c: string) => rows.find((r) => r.component === c)!.telemetrySnapshot;
    expect(snap("panel_containers")).toEqual({ containers });
    expect(snap("host_agent")).toEqual({ disks });
    expect(snap("panel_certificate")).toEqual({ hostname: SETUP.hostHostname, notAfter: "2030-01-01T00:00:00.000Z" });
    const { serviceId } = await createSite();
    await recordObservedStateReconciliationTransactional(dbClient.db, { serviceInstanceId: serviceId, observedStatus: "stopped", rawState: {} });
    const [obs] = await dbClient.db.select().from(observedStates).where(eq(observedStates.serviceInstanceId, serviceId));
    expect(typeof (obs!.rawState as Json).notRunningSince).toBe("string");
  });
});
