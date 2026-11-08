import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  operationSteps,
  operations,
  resolveDecryptedSecretRefs,
  sites,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const OPS = "org_platform_ops";
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("server administrator site API", () => {
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

  async function call(
    method: string,
    path: string,
    as: string,
    body?: unknown,
  ): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${as}`,
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const run = () => app.outboxWorker.processPendingOnce();
  const adminCreate = (ownerOrganizationId: string | null, site: Json = SITE) =>
    call("POST", "/v1/admin/sites", adminToken, { ...site, ownerOrganizationId });
  const reassign = (siteId: string, ownerOrganizationId: string | null) =>
    call("POST", `/v1/admin/sites/${siteId}/owner`, adminToken, { ownerOrganizationId });
  const opRow = async (id: string) => {
    const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, id));
    const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, id));
    return { ...op!, steps: Object.fromEntries(steps.map((s) => [s.key, s.status])) };
  };
  const lastSpec = (siteId: string) => sim.deployedSpecs.filter((s) => s.siteId === siteId).at(-1)!;

  async function createCustomer(): Promise<{ orgId: string; token: string }> {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: "Hotel Mario",
      ownerEmail: "mario@hotel.it",
      ownerName: "Mario",
    });
    expect(created.status).toBe(201);
    return {
      orgId: created.body.data.organizationId as string,
      token: await login("mario@hotel.it", created.body.data.temporaryPassword as string),
    };
  }

  async function createAndRun(owner: string | null, site: Json = SITE): Promise<{ siteId: string; operationId: string }> {
    const res = await adminCreate(owner, site);
    expect(res.status).toBe(202);
    await run();
    return res.body.data as { siteId: string; operationId: string };
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
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
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    adminId = admin.userId;
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("customer account creation still works while platform-ops holds a site", async () => {
    const { siteId } = await createAndRun(null);
    expect((await dbClient.db.select().from(sites).where(eq(sites.id, siteId)))[0]!.organizationId).toBe(OPS);
    await createCustomer();
  });

  describe("with a customer", () => {
    let orgId: string;
    let token: string;
    const org = (p: string) => `/v1/organizations/${orgId}${p}`;

    beforeEach(async () => {
      ({ orgId, token } = await createCustomer());
    });

    it("admin creates a site for the customer and the customer sees and manages it", async () => {
      const { siteId, operationId } = await createAndRun(orgId);
      expect((await opRow(operationId)).status).toBe("succeeded");

      const list = await call("GET", org("/sites"), token);
      expect(list.body.data.map((s: Json) => s.id)).toEqual([siteId]);
      const stop = await call("POST", org(`/managed-sites/${siteId}/actions`), token, { action: "stop" });
      expect(stop.status).toBe(202);
    });

    it("customer cannot see an unassigned site until it is assigned to them", async () => {
      const { siteId } = await createAndRun(null);
      expect((await call("GET", org("/sites"), token)).body.data).toEqual([]);
      expect((await call("GET", org(`/sites/${siteId}`), token)).status).toBe(404);

      const moved = await reassign(siteId, orgId);
      expect(moved.status).toBe(202);
      await run();

      const op = await call("GET", org(`/operations/${moved.body.data.operationId as string}`), token);
      expect(op.status).toBe(200);
      expect(op.body.data.status).toBe("succeeded");
      expect((await call("GET", org("/sites"), token)).body.data.map((s: Json) => s.id)).toEqual([siteId]);
      expect((await call("GET", org(`/managed-sites/${siteId}/logs`), token)).status).toBe(200);
    });

    it("reassigned site keeps serving and its secrets decrypt under the new owner", async () => {
      const { siteId } = await createAndRun(null);
      expect(lastSpec(siteId).organizationId).toBe(OPS);
      await reassign(siteId, orgId);
      await run();
      expect(lastSpec(siteId).organizationId).toBe(orgId);

      const patch = await call("PATCH", org(`/managed-sites/${siteId}/runtime`), token, { phpVersion: "8.5" });
      expect(patch.status).toBe(202);
      await run();
      expect((await opRow(patch.body.data.operationId as string)).status).toBe("succeeded");

      const secrets = await resolveDecryptedSecretRefs(dbClient.db, {
        organizationId: orgId,
        siteId,
        secretRefs: { HP_DB_PASSWORD: "SITE_DB_PASSWORD" },
        masterKey: KEY,
      });
      expect(secrets["HP_DB_PASSWORD"]).toMatch(/^[0-9a-f]{64}$/);
    });

    it("customer cannot call admin site endpoints", async () => {
      const { siteId } = await createAndRun(orgId);
      expect((await call("GET", "/v1/admin/sites", token)).status).toBe(403);
      expect((await call("POST", "/v1/admin/sites", token, { ...SITE, domain: "b.it", ownerOrganizationId: null })).status).toBe(403);
      expect((await call("POST", `/v1/admin/sites/${siteId}/owner`, token, { ownerOrganizationId: null })).status).toBe(403);
    });

    it("admin cannot name platform-ops as an owner", async () => {
      expect((await adminCreate(OPS)).status).toBe(400);
      const { siteId } = await createAndRun(orgId);
      expect((await reassign(siteId, OPS)).status).toBe(400);
    });

    it("reassigning to the current owner is refused", async () => {
      const { siteId } = await createAndRun(orgId);
      const res = await reassign(siteId, orgId);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toBe("The site already belongs to this customer.");
    });

    it("the old owner loses the site's history", async () => {
      const { siteId, operationId } = await createAndRun(orgId);
      const ids = async () => (await call("GET", org("/operations"), token)).body.data.map((o: Json) => o.id);
      expect(await ids()).toContain(operationId);
      await reassign(siteId, null);
      await run();
      expect(await ids()).not.toContain(operationId);
      expect((await call("GET", org(`/sites/${siteId}`), token)).status).toBe(404);
    });

    it("a failed reassign can be finished", async () => {
      const { siteId } = await createAndRun(null);
      sim.failNextDeploy();
      const first = await reassign(siteId, orgId);
      await run();
      const failed = await opRow(first.body.data.operationId as string);
      expect(failed.status).toBe("failed");
      expect(failed.steps).toEqual({ move_ownership: "succeeded", redeploy: "failed" });

      const again = await reassign(siteId, orgId);
      expect(again.status).toBe(202);
      expect((await opRow(again.body.data.operationId as string)).steps["move_ownership"]).toBe("skipped");
      await run();
      const done = await opRow(again.body.data.operationId as string);
      expect(done.status).toBe("succeeded");
      expect(done.organizationId).toBe(orgId);
      expect(lastSpec(siteId).organizationId).toBe(orgId);
      expect((await dbClient.db.select().from(sites).where(eq(sites.id, siteId)))[0]!.status).toBe("ready");

      // Both owner-change operations are now visible to the customer: fixed friendly texts only.
      const steps = await dbClient.db.select().from(operationSteps);
      const texts = [...steps.flatMap((x) => [x.label, x.message ?? ""]), failed.errorMessage ?? ""];
      const forbidden = /\b(containers?|images?|docker|volumes?|networks?|revisions?|services?|templates?|mariadb|jobs?|organi[sz]ations?)\b/i;
      expect(texts.filter((t) => forbidden.test(t))).toEqual([]);
    });

    it("admin Try again on a failed reassign finishes the owner change", async () => {
      const { siteId } = await createAndRun(null);
      sim.failNextDeploy();
      await reassign(siteId, orgId);
      await run();

      const retry = await call("POST", `/v1/admin/sites/${siteId}/actions`, adminToken, { action: "retry" });
      expect(retry.status).toBe(202);
      const op = await opRow(retry.body.data.operationId as string);
      expect(op.kind).toBe("site.reassign");
      expect(op.steps["move_ownership"]).toBe("skipped");
      await run();
      expect((await opRow(op.id)).status).toBe("succeeded");
      expect(lastSpec(siteId).organizationId).toBe(orgId);
    });

    it("admin Try again retries a failed setup", async () => {
      sim.failNextDeploy();
      const { siteId, operationId } = await createAndRun(orgId);
      expect((await opRow(operationId)).status).toBe("failed");
      const retry = await call("POST", `/v1/admin/sites/${siteId}/actions`, adminToken, { action: "retry" });
      expect(retry.status).toBe(202);
      await run();
      const op = await opRow(retry.body.data.operationId as string);
      expect(op.kind).toBe("site.provision");
      expect(op.status).toBe("succeeded");
      expect((await call("POST", `/v1/admin/sites/${siteId}/actions`, adminToken, { action: "stop" })).status).toBe(400);
    });

    it("admin deletes a site", async () => {
      const { siteId } = await createAndRun(null);
      expect((await call("DELETE", `/v1/admin/sites/${siteId}`, adminToken, { confirmName: "nope" })).status).toBe(400);
      const res = await call("DELETE", `/v1/admin/sites/${siteId}`, adminToken, { confirmName: SITE.name });
      expect(res.status).toBe(202);
      await run();
      expect(await dbClient.db.select().from(sites).where(eq(sites.id, siteId))).toEqual([]);
    });

    it("admin list includes the customers for the owner select", async () => {
      await createAndRun(null);
      const res = await call("GET", "/v1/admin/sites", adminToken);
      expect(res.status).toBe(200);
      expect(res.body.data.customers).toEqual([{ organizationId: orgId, name: "Hotel Mario", ownerEmail: "mario@hotel.it" }]);
    });

    it("admin sees all sites", async () => {
      const own = await call("POST", org("/managed-sites"), token, SITE);
      expect(own.status).toBe(202);
      const { siteId: unassigned } = await createAndRun(null, { ...SITE, name: "Albergo", domain: "albergo.it" });
      await run();

      const { sites: list } = (await call("GET", "/v1/admin/sites", adminToken)).body.data as Json;
      expect(list.map((s: Json) => [s.id, s.owner])).toEqual([
        [unassigned, null],
        [own.body.data.siteId, { organizationId: orgId, name: "Hotel Mario" }],
      ]);
      expect(list[0].primaryDomain).toBe("albergo.it");
    });

    it("admin create rejects an unknown owner", async () => {
      expect((await adminCreate("org_nope")).status).toBe(404);
    });

    it("admin actions are audited", async () => {
      const { siteId } = await createAndRun(null);
      await reassign(siteId, orgId);
      await run();
      for (const action of ["admin.site.create", "admin.site.reassign"]) {
        const rows = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
        expect(rows.map((r) => r.actorId)).toEqual([adminId]);
      }
      const done = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.site.reassign.succeeded"));
      expect(done.map((r) => r.details)).toEqual([{ from: OPS, to: orgId, operationId: expect.any(String) }]);
    });
  });
});
