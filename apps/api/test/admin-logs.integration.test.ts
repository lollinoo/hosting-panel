import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  serviceInstances,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-admin-pass";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "owner@example.test",
  adminPassword: "sentinel-Pass-123456",
};
const ENGINE_TEXT = "SENTINEL_ENGINE_TEXT no such container hp_x /var/lib/docker";
const LINE_TEXT = "SENTINEL_LOG_LINE";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("administrator log routes", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let adminId: string;

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

  const get = (path: string, as = adminToken) => call("GET", path, as);
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const allAudits = () => dbClient.db.select().from(auditEvents);
  const webService = async (siteId: string) =>
    (await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId)))[0]!;
  const setRuntimeAvailable = (value: boolean) => Object.defineProperty(sim, "isRuntimeAvailable", { value, configurable: true });

  async function createCustomer(): Promise<{ orgId: string; token: string; userId: string }> {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: "Customer A",
      ownerEmail: "customer@example.test",
      ownerName: "Customer",
    });
    expect(created.status).toBe(201);
    const token = await login("customer@example.test", created.body.data.temporaryPassword as string);
    const [user] = await dbClient.db.select().from(users).where(eq(users.email, "customer@example.test"));
    return { orgId: created.body.data.organizationId as string, token, userId: user!.id };
  }

  async function createSite(ownerOrganizationId: string | null): Promise<string> {
    const res = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, ownerOrganizationId });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.siteId as string;
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: sim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    adminId = admin.userId;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  it("refuses a component outside the five names with 400 before the executor is called", async () => {
    const spy = vi.spyOn(sim, "getPanelContainerLogs");
    for (const component of ["docker", "hp_mariadb", "../x", " ", "INGRESS_PROXY"]) {
      const res = await get(`/v1/admin/logs/${encodeURIComponent(component)}?tail=5`);
      expect(res.status, component).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    // No component at all matches no route: the router's 404, before any handler.
    expect((await get("/v1/admin/logs/")).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("gives a customer 403 and a denied audit row on both routes", async () => {
    const { orgId, token, userId } = await createCustomer();
    const siteId = await createSite(orgId);
    const siteSpy = vi.spyOn(sim, "getServiceLogs");
    const panelSpy = vi.spyOn(sim, "getPanelContainerLogs");
    for (const path of [`/v1/admin/sites/${siteId}/logs`, "/v1/admin/logs/ingress_proxy"]) {
      const before = (await allAudits()).length;
      const res = await get(path, token);
      expect(res.status, path).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
      const added = (await allAudits()).slice(before);
      expect(added).toHaveLength(1);
      expect(added[0]!.actorId).toBe(userId);
      expect((added[0]!.details as Json).outcome).toBe("denied");
    }
    expect(siteSpy).not.toHaveBeenCalled();
    expect(panelSpy).not.toHaveBeenCalled();
    expect(await audits("admin.site.logs.read")).toHaveLength(0);
  });

  it("reads a site's log with the clamped tail and writes exactly one audit row per read, without any log line", async () => {
    const { orgId } = await createCustomer();
    const siteId = await createSite(orgId);
    const lines = Array.from({ length: 600 }, (_, i) => ({
      at: "2026-11-08T10:00:00.000Z",
      stream: i % 2 ? ("stderr" as const) : ("stdout" as const),
      text: `${LINE_TEXT} ${String(i)}`,
    }));
    sim.setServiceLogs((await webService(siteId)).id, lines);
    const spy = vi.spyOn(sim, "getServiceLogs");

    const two = await get(`/v1/admin/sites/${siteId}/logs?tail=2`);
    expect(two.status).toBe(200);
    expect(two.body.data).toEqual(lines.slice(-2));
    expect((await get(`/v1/admin/sites/${siteId}/logs?tail=99999`)).body.data).toHaveLength(500);
    expect((await get(`/v1/admin/sites/${siteId}/logs?tail=0`)).status).toBe(200);
    expect((await get(`/v1/admin/sites/${siteId}/logs`)).body.data).toHaveLength(200);
    expect(spy.mock.calls.map((c) => c[1])).toEqual([2, 500, 1, 200]);

    const rows = await audits("admin.site.logs.read");
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.actorId).toBe(adminId);
      expect(row.organizationId).toBe(orgId);
      expect(row.targetType).toBe("site");
      expect(row.targetId).toBe(siteId);
    }
    expect(rows.map((r) => (r.details as Json).tail)).toEqual([2, 500, 1, 200]);
    expect(JSON.stringify(rows)).not.toContain(LINE_TEXT);
  });

  it("answers 404 for an unknown site and writes no read row", async () => {
    const res = await get(`/v1/admin/sites/${randomUUID()}/logs`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(await audits("admin.site.logs.read")).toHaveLength(0);
  });

  it("reads a panel container's log with the clamped tail and writes no audit row", async () => {
    const lines = Array.from({ length: 600 }, (_, i) => ({
      at: "2026-11-08T10:00:00.000Z",
      stream: "stdout" as const,
      text: `${LINE_TEXT} ${String(i)}`,
    }));
    for (const c of ["mail_relay", "sftp", "ingress_proxy", "shared_database"] as const) {
      sim.setPanelContainer(c, { state: "running", expected: true });
      sim.setPanelContainerLogs(c, lines);
    }
    const spy = vi.spyOn(sim, "getPanelContainerLogs");
    const before = (await allAudits()).length;

    const res = await get("/v1/admin/logs/shared_database?tail=3");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: lines.slice(-3) });
    expect((await get("/v1/admin/logs/mail_relay?tail=99999")).body.data).toHaveLength(500);
    expect((await get("/v1/admin/logs/sftp?tail=0")).body.data).toHaveLength(1);
    expect((await get("/v1/admin/logs/ingress_proxy")).body.data).toHaveLength(200);
    expect((await get("/v1/admin/logs/shared_database?tail=abc")).body.data).toHaveLength(200);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([
      { component: "shared_database", tail: 3 },
      { component: "mail_relay", tail: 500 },
      { component: "sftp", tail: 1 },
      { component: "ingress_proxy", tail: 200 },
      { component: "shared_database", tail: 200 },
    ]);
    expect((await allAudits()).slice(before)).toEqual([]);
  });

  it("answers 404 for a panel container that is not there and 503 when the Engine is down, from the simulator", async () => {
    const missing = await get("/v1/admin/logs/phpmyadmin");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
    expect(missing.raw).not.toContain("Panel container not found");
    sim.setEngineReachable(false);
    const down = await get("/v1/admin/logs/shared_database");
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
  });

  describe("errors carry no text of the Engine", () => {
    const coded = (code: string) => Object.assign(new Error(ENGINE_TEXT), { code });
    let siteId: string;
    let paths: string[];

    beforeEach(async () => {
      siteId = await createSite(null);
      paths = [`/v1/admin/sites/${siteId}/logs`, "/v1/admin/logs/mail_relay"];
    });

    const failBoth = (err: Error) => {
      vi.spyOn(sim, "getServiceLogs").mockRejectedValue(err);
      vi.spyOn(sim, "getPanelContainerLogs").mockRejectedValue(err);
    };

    it("a container that does not exist answers 404", async () => {
      failBoth(coded("NOT_FOUND"));
      for (const path of paths) {
        const res = await get(path);
        expect(res.status, path).toBe(404);
        expect(res.body.error.code).toBe("NOT_FOUND");
        expect(res.raw).not.toContain("SENTINEL_ENGINE_TEXT");
      }
    });

    it.each(["DOCKER_ENGINE_UNAVAILABLE", "NOT_SUPPORTED"])("a stopped executor (%s) answers 503", async (code) => {
      failBoth(coded(code));
      for (const path of paths) {
        const res = await get(path);
        expect(res.status, path).toBe(503);
        expect(res.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
        expect(res.raw).not.toContain("SENTINEL_ENGINE_TEXT");
      }
    });

    it("a disabled runtime answers 503 without calling the executor", async () => {
      setRuntimeAvailable(false);
      const siteSpy = vi.spyOn(sim, "getServiceLogs");
      const panelSpy = vi.spyOn(sim, "getPanelContainerLogs");
      for (const path of paths) {
        const res = await get(path);
        expect(res.status, path).toBe(503);
        expect(res.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
      }
      expect(siteSpy).not.toHaveBeenCalled();
      expect(panelSpy).not.toHaveBeenCalled();
    });
  });
});
