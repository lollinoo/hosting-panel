import { randomUUID } from "node:crypto";
import { AdminAlertDtoSchema, AdminHealthDtoSchema } from "@hosting-panel/contracts";
import {
  createDatabaseClient,
  eq,
  hostAgentHeartbeats,
  hosts,
  sql,
  upsertHostAgentHeartbeat,
  type DatabaseClient,
} from "@hosting-panel/database";
import { ExecutorCodedError, InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { Phase1DisabledDockerExecutor, type DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { Phase1DisabledHostAgent, type HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-password-0002";
const SETUP = { installationName: "Down Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Pass-123456",
};
const PLANTED = "PLANTEDENGINEWORD";
const HASH = "d".repeat(64);
// Engine free text as a daemon could relay it: a word, a path, a bearer token and a container hash.
const ENGINE_TEXT = `${PLANTED} at /var/run/docker.sock Bearer sentinel-token ${HASH}`;
const MIN = 60_000;

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

function expectNoLeak(raw: string): void {
  expect(raw).not.toMatch(/[0-9a-f]{64}/i);
  expect(raw).not.toMatch(/\/(var|opt|etc)\//);
  expect(raw).not.toContain("Bearer");
  expect(raw).not.toContain(PLANTED);
}

describe("health, alerts and logs while the runtime is down", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle | undefined;
  let sim: InMemoryDockerSimulatorAdapter;
  let executorCalls: string[];
  let adminToken: string;
  let hostId: string;
  let adminN = 0;

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app!.baseUrl!}/v1/auth/login`, {
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
    const res = await fetch(`${app!.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  // One database; the app can be restarted on it with the runtime disabled.
  async function boot(disabled: boolean): Promise<void> {
    adminN += 1;
    const email = `admin${String(adminN)}@example.test`;
    const admin = await createServerAdmin(dbClient.db, KEY, { email, name: "Admin", password: PW });
    const exec = recorded<DockerExecutorPort>(disabled ? new Phase1DisabledDockerExecutor() : sim);
    executorCalls = exec.calls;
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: disabled ? "disabled" : "local-simulator",
      dockerExecutor: exec.port,
      hostAgent: disabled ? new Phase1DisabledHostAgent() : (new InMemoryHostSimulatorAdapter() as HostAgentPort),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login(email, PW, admin.totpSecretBase32);
  }

  async function start(): Promise<void> {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    sim = new InMemoryDockerSimulatorAdapter();
    await boot(false);
    hostId = (await dbClient.db.select({ id: hosts.id }).from(hosts))[0]!.id;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await dbClient.close();
  });

  async function createSite(): Promise<string> {
    const res = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, ownerOrganizationId: null });
    expect(res.status).toBe(202);
    await app!.outboxWorker.processPendingOnce();
    return res.body.data.siteId as string;
  }

  /** The four admin answers in one state: health and alerts 200, both log routes a designed error, nothing leaked. */
  async function fourAnswers(siteId: string): Promise<{ health: Json; siteLogs: Json; panelLogs: Json }> {
    const h = await call("GET", "/v1/admin/health", adminToken);
    const a = await call("GET", "/v1/admin/alerts", adminToken);
    const s = await call("GET", `/v1/admin/sites/${siteId}/logs?tail=5`, adminToken);
    const p = await call("GET", "/v1/admin/logs/ingress_proxy?tail=5", adminToken);
    expect([h.status, a.status]).toEqual([200, 200]);
    AdminHealthDtoSchema.parse(h.body.data);
    z.array(AdminAlertDtoSchema).parse(a.body.data);
    for (const r of [s, p]) {
      expect([404, 503]).toContain(r.status);
      expect(r.status).not.toBe(500);
    }
    for (const r of [h, a, s, p]) expectNoLeak(r.raw);
    return { health: h.body.data as Json, siteLogs: s.body, panelLogs: p.body };
  }

  const UNAVAILABLE = "The logs are not available right now. Try again in a few minutes.";
  const part = (health: Json, name: string) => (health.components as Json[]).find((c) => c.component === name)!;

  describe("point 5: three down states", () => {
    it("executor stopped: health and alerts 200, both log routes 503 with the fixed sentence, nothing leaked", async () => {
      await start();
      const siteId = await createSite();
      // The real client turns a refused socket into this coded error; the planted text checks it never reaches a body.
      const down = () => Promise.reject(new ExecutorCodedError(`Docker executor IPC daemon is unreachable ${ENGINE_TEXT}`, "DOCKER_ENGINE_UNAVAILABLE"));
      sim.pingEngine = down;
      sim.getPanelContainers = down;
      sim.getServiceLogs = down;
      sim.getPanelContainerLogs = down;
      await app!.driftReconciler.reconcileAllOnce();
      const { health, siteLogs, panelLogs } = await fourAnswers(siteId);
      expect(part(health, "executor")).toMatchObject({ state: "down", reason: "not_reporting" });
      expect(siteLogs.error).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: UNAVAILABLE });
      expect(panelLogs.error).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: UNAVAILABLE });
    });

    it("Engine unreachable: health and alerts 200, both log routes 503, Engine text not relayed", async () => {
      await start();
      const siteId = await createSite();
      sim.setEngineReachable(false);
      // The executor answers coded errors carrying Engine free text.
      sim.getServiceLogs = () => Promise.reject(new ExecutorCodedError(`Engine said ${ENGINE_TEXT}`, "DOCKER_ENGINE_UNAVAILABLE"));
      sim.getPanelContainerLogs = () => Promise.reject(new ExecutorCodedError(`Engine said ${ENGINE_TEXT}`, "DOCKER_ENGINE_UNAVAILABLE"));
      await app!.driftReconciler.reconcileAllOnce();
      const { health, siteLogs, panelLogs } = await fourAnswers(siteId);
      expect(part(health, "docker_engine")).toMatchObject({ state: "down", reason: "engine_unreachable" });
      expect(siteLogs.error.message).toBe(UNAVAILABLE);
      expect(panelLogs.error.message).toBe(UNAVAILABLE);
    });

    it("runtime disabled: health and alerts 200, both log routes 503 with no executor call", async () => {
      await start();
      const siteId = await createSite();
      await app!.close();
      await boot(true);
      await app!.driftReconciler.reconcileAllOnce();
      executorCalls.length = 0;
      const { health, siteLogs, panelLogs } = await fourAnswers(siteId);
      expect(part(health, "executor")).toMatchObject({ state: "unknown", reason: "runtime_disabled" });
      expect(siteLogs.error).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: UNAVAILABLE });
      expect(panelLogs.error).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: UNAVAILABLE });
      expect(executorCalls.filter((c) => c.toLowerCase().includes("log"))).toEqual([]);
    });
  });

  describe("point 6: stale and broken snapshots", () => {
    const heartbeat = (component: "docker_executor" | "host_agent" | "panel_containers" | "panel_certificate", snapshot: Record<string, unknown>, lastSeenAt = new Date()) =>
      upsertHostAgentHeartbeat(dbClient.db, { hostId, component, status: "online", version: "1", telemetrySnapshot: snapshot, lastSeenAt });
    // Writes the stored JSON as is, past the repository's redaction.
    const writeRaw = (component: string, json: string) =>
      dbClient.db.execute(sql`UPDATE host_agent_heartbeats SET telemetry_snapshot = ${json}::jsonb WHERE component = ${component}`);
    const healthy = async () => {
      await heartbeat("docker_executor", { dockerEngineReachable: true });
      await heartbeat("host_agent", { disks: [{ paths: ["root"], usedBytes: "1", totalBytes: "2" }] });
      await heartbeat("panel_containers", { containers: [{ component: "sftp", state: "running", expected: true, startedAt: null, restartCount: 0 }] });
    };
    const answers = async () => {
      const h = await call("GET", "/v1/admin/health", adminToken);
      const a = await call("GET", "/v1/admin/alerts", adminToken);
      return { h, a };
    };

    it("rows older than the stale threshold never read ok", async () => {
      await start();
      await healthy();
      expect(part((await answers()).h.body.data as Json, "sftp").state).toBe("ok");
      const old = new Date(Date.now() - 6 * MIN);
      await dbClient.db.update(hostAgentHeartbeats).set({ lastSeenAt: old });
      const { h, a } = await answers();
      expect([h.status, a.status]).toEqual([200, 200]);
      const health = h.body.data as Json;
      for (const name of ["executor", "host_agent"]) expect(part(health, name)).toMatchObject({ state: "down" });
      for (const name of ["docker_engine", "sftp", "ingress_proxy"]) expect(part(health, name).state).toBe("unknown");
    });

    it("a stale panel_containers row alone makes the containers unknown, not ok", async () => {
      await start();
      await healthy();
      await dbClient.db.update(hostAgentHeartbeats).set({ lastSeenAt: new Date(Date.now() - 6 * MIN) }).where(eq(hostAgentHeartbeats.component, "panel_containers"));
      const health = (await answers()).h.body.data as Json;
      expect(part(health, "executor").state).toBe("ok");
      expect(part(health, "sftp")).toMatchObject({ state: "unknown", reason: "not_reporting" });
    });

    for (const [label, component, json] of [
      ["docker_executor snapshot is JSON null", "docker_executor", "null"],
      ["docker_executor snapshot is a string", "docker_executor", JSON.stringify("engine ok")],
      ["host_agent snapshot is JSON null", "host_agent", "null"],
      ["host_agent disks in an old shape", "host_agent", JSON.stringify({ disks: [{ path: "/", used: 1, total: 2 }] })],
      ["host_agent disks with a non-numeric size", "host_agent", JSON.stringify({ disks: [{ paths: ["root"], usedBytes: "1.5", totalBytes: "x" }] })],
      ["panel_containers snapshot is JSON null", "panel_containers", "null"],
      ["panel_containers in an old shape", "panel_containers", JSON.stringify({ containers: { sftp: "running" } })],
      ["panel_certificate snapshot is JSON null", "panel_certificate", "null"],
      ["panel_certificate with a broken date", "panel_certificate", JSON.stringify({ hostname: SETUP.hostHostname, notAfter: "not-a-date" })],
    ] as const) {
      it(`${label}: health and alerts answer 200`, async () => {
        await start();
        await healthy();
        await heartbeat("panel_certificate", { hostname: SETUP.hostHostname, notAfter: new Date(Date.now() + 90 * 24 * 3_600_000).toISOString() });
        await writeRaw(component, json);
        const { h, a } = await answers();
        expect([h.status, a.status]).toEqual([200, 200]);
        const health = AdminHealthDtoSchema.parse(h.body.data);
        if (component === "panel_containers") expect(part(health as Json, "sftp")).toMatchObject({ state: "unknown" });
        if (component === "host_agent") expect(health.disks).toEqual([]);
      });
    }
  });

  describe("point 8: the customer's log route when the container vanished", () => {
    it("answers neither 500, nor executor text, nor that the site does not exist", async () => {
      await start();
      const created = await call("POST", "/v1/admin/customer-account", adminToken, { organizationName: "Org A", ownerEmail: "owner@example.test", ownerName: "Owner" });
      expect(created.status).toBe(201);
      const orgId = created.body.data.organizationId as string;
      const res = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, ownerOrganizationId: orgId });
      expect(res.status).toBe(202);
      await app!.outboxWorker.processPendingOnce();
      const siteId = res.body.data.siteId as string;
      const owner = await login("owner@example.test", created.body.data.temporaryPassword as string);
      const ok = await call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}/logs`, owner);
      expect(ok.status).toBe(200);

      // The executor's own answer for a vanished container (docker-engine-adapter).
      sim.getServiceLogs = () => Promise.reject(new ExecutorCodedError("Managed service container not found", "NOT_FOUND"));
      const gone = await call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}/logs`, owner);
      expect(gone.status).not.toBe(500);
      expectNoLeak(gone.raw);
      expect(gone.raw).not.toMatch(/container not found/i);
      // A 404 NOT_FOUND on the site's own path reads as "this site does not exist".
      expect(gone.body.error?.code).not.toBe("NOT_FOUND");
      // The site is still there.
      expect((await call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}`, owner)).status).toBe(200);
    });
  });
});
