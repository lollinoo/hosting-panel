import { randomUUID } from "node:crypto";
import { PLATFORM_OPS_ORG_ID } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  operations,
  outboxEvents,
  serviceInstances,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle, type CreateControlPlaneAppOptions } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 6);
const PW = "sentinel-password-0002";
const SETUP = { installationName: "Restart Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Pass-123456",
};
const REASON = "Sentinel reason for the restart";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("admin restart of a site and of a panel container", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let calls: { name: string; at: number }[];
  let adminToken: string;

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

  async function call(method: string, path: string, as: string, body?: unknown, key: string | null = randomUUID()): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function start(opts: Partial<CreateControlPlaneAppOptions> = {}): Promise<void> {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    calls = [];
    const port = new Proxy(sim, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls.push({ name: String(p), at: Date.now() });
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    }) as DockerExecutorPort;
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: port,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
      ...opts,
    });
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
  }

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  const runWorker = () => app.outboxWorker.processPendingOnce();
  const opOf = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const auditsOf = async (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const named = (name: string) => calls.filter((c) => c.name === name);

  async function createSite(): Promise<{ siteId: string; serviceId: string }> {
    const res = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, ownerOrganizationId: null });
    expect(res.status).toBe(202);
    await runWorker();
    const siteId = res.body.data.siteId as string;
    const [svc] = await dbClient.db.select({ id: serviceInstances.id }).from(serviceInstances).where(eq(serviceInstances.siteId, siteId));
    return { siteId, serviceId: svc!.id };
  }

  async function customerToken(): Promise<string> {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, { organizationName: "Org A", ownerEmail: "owner@example.test", ownerName: "Owner" });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "owner@example.test");
    return login("owner@example.test", created.body.data.temporaryPassword as string);
  }

  /** Moves the submission back so the worker's start delay is already over. */
  const age = (id: string, ms: number) => dbClient.db.update(operations).set({ submittedAt: new Date(Date.now() - ms) }).where(eq(operations.id, id));

  describe("site", () => {
    it("A.1 answers 202, writes admin.site.restart with the reason, and the operation read shows it succeeded", async () => {
      await start();
      const { siteId } = await createSite();
      const res = await call("POST", `/v1/admin/sites/${siteId}/restart`, adminToken, { reason: `  ${REASON}  ` });
      expect(res.status).toBe(202);
      const operationId = res.body.data.operationId as string;
      expect(res.body.data).toEqual({ siteId, operationId });
      const [row] = await auditsOf("admin.site.restart");
      expect(row).toMatchObject({ targetType: "site", targetId: siteId, details: { outcome: "succeeded", operationId, reason: REASON } });
      await runWorker();
      const read = await call("GET", `/v1/admin/operations/${operationId}`, adminToken);
      expect(read.status).toBe(200);
      expect(read.body.data).toMatchObject({ id: operationId, kind: "service.restart", status: "succeeded" });
    });

    it("A.2 refuses a missing, blank or too long reason and a missing key; a replayed key gives the same operation", async () => {
      await start();
      const { siteId } = await createSite();
      const count = async () => (await dbClient.db.select().from(operations).where(eq(operations.kind, "service.restart"))).length;
      for (const body of [{}, { reason: "   " }, { reason: "x".repeat(501) }]) {
        expect((await call("POST", `/v1/admin/sites/${siteId}/restart`, adminToken, body)).status).toBe(400);
      }
      expect((await call("POST", `/v1/admin/sites/${siteId}/restart`, adminToken, { reason: REASON }, null)).status).toBe(400);
      expect(await count()).toBe(0);
      const key = randomUUID();
      const a = await call("POST", `/v1/admin/sites/${siteId}/restart`, adminToken, { reason: REASON }, key);
      const b = await call("POST", `/v1/admin/sites/${siteId}/restart`, adminToken, { reason: REASON }, key);
      expect([a.status, b.status]).toEqual([202, 202]);
      expect(b.body.data.operationId).toBe(a.body.data.operationId);
      expect(await count()).toBe(1);
    });

    it("A.3 a customer gets 403 and a denied row, an unknown site 404, a site under another operation 409", async () => {
      await start();
      const { siteId } = await createSite();
      const token = await customerToken();
      const before = (await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id);
      expect((await call("POST", `/v1/admin/sites/${siteId}/restart`, token, { reason: REASON })).status).toBe(403);
      const added = (await dbClient.db.select().from(auditEvents)).filter((r) => !before.includes(r.id));
      expect(added.map((r) => (r.details as Json).outcome)).toEqual(["denied"]);
      expect((await call("POST", "/v1/admin/sites/site_unknown/restart", adminToken, { reason: REASON })).status).toBe(404);
      await enqueueOperationTransactional(dbClient.db, {
        organizationId: PLATFORM_OPS_ORG_ID, kind: "service.deploy", resourceType: "service", resourceId: "svc_other", lockKey: `site:${siteId}`,
      });
      const locked = await call("POST", `/v1/admin/sites/${siteId}/restart`, adminToken, { reason: REASON });
      expect([locked.status, locked.body.error?.code]).toEqual([409, "RESOURCE_LOCKED"]);
    });

    it("A.5 a container that is gone is created again only after a set-up that succeeded; Stop on it creates nothing", async () => {
      await start();
      const { siteId, serviceId } = await createSite();
      const restart = async () => {
        const res = await call("POST", `/v1/admin/sites/${siteId}/restart`, adminToken, { reason: REASON });
        expect(res.status).toBe(202);
        await runWorker();
        return opOf(res.body.data.operationId as string);
      };
      await sim.deleteService(serviceId);
      expect((await restart()).status).toBe("succeeded");
      expect((await sim.getObservedState(serviceId))?.observedStatus).toBe("running");
      await app.driftReconciler.reconcileAllOnce();
      const deploys = named("deployService").length;

      await sim.deleteService(serviceId);
      await dbClient.db.update(operations).set({ status: "failed" }).where(eq(operations.kind, "site.provision"));
      expect(await restart()).toMatchObject({ status: "failed", errorCode: "NOT_FOUND" });
      expect(await sim.getObservedState(serviceId)).toBeNull();
      expect(named("deployService")).toHaveLength(deploys);

      expect((await call("POST", `/v1/admin/sites/${siteId}/support-access`, adminToken)).status).toBeLessThan(300);
      const stop = await call("POST", `/v1/organizations/${PLATFORM_OPS_ORG_ID}/managed-sites/${siteId}/actions`, adminToken, { action: "stop" });
      expect(stop.status).toBe(202);
      await runWorker();
      expect((await opOf(stop.body.data.operationId as string)).status).toBe("succeeded");
      expect(await sim.getObservedState(serviceId)).toBeNull();
      expect(named("deployService")).toHaveLength(deploys);
      const health = await call("GET", "/v1/admin/health", adminToken);
      expect(health.body.data.siteContainers[0]).toMatchObject({ siteId, observed: "missing" });
    });
  });

  describe("panel container", () => {
    const restart = (component: string, key: string = randomUUID()) =>
      call("POST", `/v1/admin/panel-containers/${component}/restart`, adminToken, { reason: REASON }, key);

    it("A.6 answers 202 with the request row before any run, restarts after the delay, and writes the end row", async () => {
      await start();
      await app.driftReconciler.reconcileAllOnce();
      const res = await restart("shared_database");
      expect(res.status).toBe(202);
      const operationId = res.body.data.operationId as string;
      expect(res.body.data).toEqual({ component: "shared_database", operationId });
      expect(await auditsOf("admin.panel_container.restart")).toEqual([
        expect.objectContaining({ organizationId: PLATFORM_OPS_ORG_ID, targetType: "panel_container", targetId: "shared_database", details: expect.objectContaining({ outcome: "succeeded", operationId, component: "shared_database", reason: REASON }) }),
      ]);
      const op = await opOf(operationId);
      expect(op).toMatchObject({ kind: "panel.container.restart", resourceType: "host", resourceId: "shared_database", lockKey: "panel:container:shared_database" });
      const outbox = await dbClient.db.select().from(outboxEvents);
      expect(JSON.stringify([op, outbox])).not.toContain(REASON);
      await runWorker();
      const [restartCall] = named("restartPanelContainer");
      expect(restartCall!.at - op.submittedAt.getTime()).toBeGreaterThanOrEqual(2_000);
      expect((await opOf(operationId)).status).toBe("succeeded");
      expect(await auditsOf("admin.panel_container.restart.end")).toEqual([
        expect.objectContaining({ actorType: "system", targetId: "shared_database", details: { operationId, component: "shared_database", outcome: "succeeded", errorCode: null } }),
      ]);
      // A replayed key answers the same operation and writes no second request row.
      expect((await restart("shared_database", op.idempotencyKey!)).body.data.operationId).toBe(operationId);
      expect(await auditsOf("admin.panel_container.restart")).toHaveLength(1);
    });

    it("A.6 refuses an unknown component, an absent one and a second restart while the first is queued", async () => {
      await start();
      sim.setPanelContainer("sftp", { state: "missing", expected: true });
      await app.driftReconciler.reconcileAllOnce();
      calls.length = 0;
      const nope = await restart("nope");
      expect([nope.status, nope.body.error?.code]).toEqual([400, "VALIDATION_ERROR"]);
      for (const component of ["phpmyadmin", "sftp"]) {
        const res = await restart(component);
        expect([res.status, res.body.error?.code]).toEqual([409, "PANEL_CONTAINER_ABSENT"]);
      }
      expect((await restart("shared_database")).status).toBe(202);
      const second = await restart("shared_database");
      expect([second.status, second.body.error?.code]).toEqual([409, "RESOURCE_LOCKED"]);
      expect(named("restartPanelContainer")).toEqual([]);
      const token = await customerToken();
      const denied = await call("POST", "/v1/admin/panel-containers/shared_database/restart", token, { reason: REASON });
      expect(denied.status).toBe(403);
    });

    it("A.6 the runtime disabled answers 422", async () => {
      await start({ runtimeBackend: "disabled" });
      const res = await restart("shared_database");
      expect([res.status, res.body.error?.code]).toEqual([422, "NOT_SUPPORTED"]);
    });

    it("A.6 an executor error, a request older than 60 s and an expired lease each end failed with the end row", async () => {
      await start();
      await app.driftReconciler.reconcileAllOnce();
      const endOf = async (operationId: string) => (await auditsOf("admin.panel_container.restart.end")).find((r) => (r.details as Json).operationId === operationId)?.details;

      sim.restartPanelContainer = async () => {
        throw Object.assign(new Error("engine said something"), { code: "DOCKER_ENGINE_UNAVAILABLE" });
      };
      const a = (await restart("shared_database")).body.data.operationId as string;
      await age(a, 3_000);
      await runWorker();
      expect(await opOf(a)).toMatchObject({ status: "failed", errorCode: "DOCKER_ENGINE_UNAVAILABLE" });
      expect((await opOf(a)).errorMessage).not.toContain("engine said");
      expect(await endOf(a)).toEqual({ operationId: a, component: "shared_database", outcome: "failed", errorCode: "DOCKER_ENGINE_UNAVAILABLE" });

      calls.length = 0;
      const b = (await restart("ingress_proxy")).body.data.operationId as string;
      await age(b, 61_000);
      await runWorker();
      expect(await opOf(b)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(named("restartPanelContainer")).toEqual([]);
      expect(await endOf(b)).toMatchObject({ outcome: "failed", errorCode: "OPERATION_INTERRUPTED" });

      const c = (await restart("shared_database")).body.data.operationId as string;
      await dbClient.db.update(operations).set({ status: "processing", leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(operations.id, c));
      await app.outboxWorker.recoverUnknownOperations();
      expect(await opOf(c)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(await endOf(c)).toMatchObject({ outcome: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(await auditsOf("operation.recovered.failed")).toEqual([]);
    });

    it("A.7 component_down is not raised while a restart runs or for a look older than its end, and comes back on a newer look", async () => {
      await start();
      sim.setPanelContainer("sftp", { state: "stopped", expected: true });
      await app.driftReconciler.reconcileAllOnce();
      const down = async () => {
        const res = await call("GET", "/v1/admin/alerts", adminToken);
        return (res.body.data as Json[]).filter((a) => a.kind === "component_down").map((a) => a.subject as string);
      };
      expect(await down()).toEqual(["sftp"]);
      const id = (await restart("sftp")).body.data.operationId as string;
      expect(await down()).toEqual([]);
      await age(id, 3_000);
      await runWorker();
      expect((await opOf(id)).status).toBe("succeeded");
      expect(await down()).toEqual([]);
      sim.setPanelContainer("sftp", { state: "stopped" });
      await app.driftReconciler.reconcileAllOnce();
      expect(await down()).toEqual(["sftp"]);
    });
  });

  it("A.8 the operation read answers 404 for an unknown id and 403 to a customer", async () => {
    await start();
    expect((await call("GET", "/v1/admin/operations/op_unknown", adminToken)).status).toBe(404);
    const token = await customerToken();
    expect((await call("GET", "/v1/admin/operations/op_unknown", token)).status).toBe(403);
  });
});
