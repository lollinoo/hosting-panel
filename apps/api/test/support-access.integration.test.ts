import { randomUUID } from "node:crypto";
import {
  and,
  auditEvents,
  createDatabaseClient,
  eq,
  organizations,
  platformInstallations,
  sql,
  supportAccessGrants,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUPPORT_ACCESS_PERMISSIONS, SUPPORT_ACCESS_TTL_MS } from "../src/auth/support-access.service.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-admin-pass-0001";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const OPS = "org_platform_ops";
const site = (n: string) => ({
  name: `Site ${n}`,
  domain: `wp-${n}.example.test`,
  title: `Site ${n}`,
  adminUser: "siteadmin",
  adminEmail: `wp-${n}@example.test`,
  adminPassword: "sentinel-Wp-Pass-123456",
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("support access", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
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

  async function call(method: string, path: string, as: string | null, body?: unknown): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function createCustomer(n: string): Promise<{ orgId: string; token: string }> {
    const email = `owner-${n}@example.test`;
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: `Customer ${n}`,
      ownerEmail: email,
      ownerName: `Owner ${n}`,
    });
    expect(created.status).toBe(201);
    return { orgId: created.body.data.organizationId as string, token: await login(email, created.body.data.temporaryPassword as string) };
  }

  async function createSite(owner: string | null, n: string): Promise<string> {
    const res = await call("POST", "/v1/admin/sites", adminToken, { ...site(n), ownerOrganizationId: owner });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.siteId as string;
  }

  async function bareOrg(): Promise<string> {
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const id = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({ id, platformInstallationId: inst!.id, name: "Other", slug: `other-${id}` });
    return id;
  }

  const open = (siteId: string, as = adminToken) => call("POST", `/v1/admin/sites/${siteId}/support-access`, as);
  const close = (as: string | null = adminToken) => call("DELETE", "/v1/admin/support-access", as);
  const grants = () => dbClient.db.select().from(supportAccessGrants);
  const audit = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const auditCount = async () => (await dbClient.db.select().from(auditEvents)).length;
  const me = async (as: string) => (await call("GET", "/v1/me", as)).body.data as Json;

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: new InMemoryDockerSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    adminId = admin.userId;
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("with a customer site", () => {
    let orgId: string;
    let token: string;
    let siteId: string;
    const files = () => call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}/files`, adminToken);
    const mkdir = (path: string) =>
      call("POST", `/v1/organizations/${orgId}/managed-sites/${siteId}/files/folders`, adminToken, { path });

    beforeEach(async () => {
      ({ orgId, token } = await createCustomer("a"));
      siteId = await createSite(orgId, "a");
    });

    it("a customer gets 403 on both routes with an audit row, nobody without a session gets in", async () => {
      const before = await auditCount();
      expect((await open(siteId, token)).body.error.code).toBe("PERMISSION_DENIED");
      expect((await close(token)).status).toBe(403);
      expect(await auditCount()).toBe(before + 2);
      expect((await open(siteId, token)).status).toBe(403);
      expect((await call("POST", `/v1/admin/sites/${siteId}/support-access`, null)).status).toBe(401);
      expect((await close(null)).status).toBe(401);
      expect(await grants()).toEqual([]);
    });

    it("without a visit the site routes answer 404 with no audit row; open lets both through; close shuts them again", async () => {
      const before = await auditCount();
      expect((await files()).status).toBe(404);
      expect((await mkdir("before")).status).toBe(404);
      expect(await auditCount()).toBe(before);

      const opened = await open(siteId);
      expect(opened.status).toBe(201);
      expect(opened.body.data).toEqual({ organizationId: orgId, organizationName: "Customer a", expiresAt: expect.any(String) });
      const ttl = Date.parse(opened.body.data.expiresAt as string) - Date.now();
      expect(ttl).toBeGreaterThan(SUPPORT_ACCESS_TTL_MS - 60_000);
      expect(ttl).toBeLessThanOrEqual(SUPPORT_ACCESS_TTL_MS);

      expect((await files()).status).toBe(200);
      expect((await mkdir("during")).status).toBe(204);
      const [folder] = await audit("site.files.folder.create");
      expect(folder).toMatchObject({ actorId: adminId, organizationId: orgId });

      expect((await close()).status).toBe(204);
      expect((await files()).status).toBe(404);
      expect((await mkdir("after")).status).toBe(404);
    });

    it("open and close each write their audit row, with no secret in the details", async () => {
      const opened = await open(siteId);
      const [grant] = await grants();
      expect(grant).toMatchObject({
        organizationId: orgId,
        operatorUserId: adminId,
        approvedByUserId: adminId,
        permissions: [...SUPPORT_ACCESS_PERMISSIONS],
      });
      expect(grant!.expiresAt.toISOString()).toBe(opened.body.data.expiresAt);
      const [openRow] = await audit("admin.support_access.open");
      expect(openRow).toMatchObject({ actorId: adminId, organizationId: orgId, targetType: "site", targetId: siteId });
      expect(openRow!.details).toEqual({ outcome: "succeeded", requestId: expect.any(String), expiresAt: opened.body.data.expiresAt });

      expect((await close()).status).toBe(204);
      expect(await grants()).toEqual([]);
      const closeRows = await audit("admin.support_access.close");
      expect(closeRows).toHaveLength(1);
      expect(closeRows[0]).toMatchObject({ actorId: adminId, organizationId: orgId, targetType: "organization", targetId: orgId });
      expect(closeRows[0]!.details).toEqual({ outcome: "succeeded", requestId: expect.any(String) });

      expect((await close()).status).toBe(204);
      expect(await audit("admin.support_access.close")).toHaveLength(1);
    });

    it("the grant and its audit row are written together or not at all", async () => {
      const failOn = async (action: string) => {
        await dbClient.db.execute(
          sql.raw(`CREATE OR REPLACE FUNCTION hp_test_fail_audit() RETURNS trigger AS $$
            BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`),
        );
        await dbClient.db.execute(sql.raw("DROP TRIGGER IF EXISTS hp_test_fail_audit ON audit_events"));
        await dbClient.db.execute(
          sql.raw("CREATE TRIGGER hp_test_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION hp_test_fail_audit()"),
        );
      };
      await failOn("admin.support_access.open");
      expect((await open(siteId)).status).toBe(500);
      expect(await grants()).toEqual([]);

      await failOn("none");
      expect((await open(siteId)).status).toBe(201);
      await failOn("admin.support_access.close");
      expect((await close()).status).toBe(500);
      expect(await grants()).toHaveLength(1);
      expect((await files()).status).toBe(200);
    });

    it("a visit gives nothing outside the 14 keys: members and another organization stay refused", async () => {
      const other = await bareOrg();
      await open(siteId);
      expect((await call("GET", `/v1/organizations/${orgId}/members`, adminToken)).body.error.code).toBe("PERMISSION_DENIED");
      expect((await call("GET", `/v1/organizations/${other}/sites`, adminToken)).status).toBe(404);
      expect((await files()).status).toBe(200);
    });

    it("an expired visit opens nothing (403 PERMISSION_DENIED) and me no longer shows it", async () => {
      await open(siteId);
      expect((await me(adminToken)).supportAccess).toEqual({ organizationId: orgId, organizationName: "Customer a", expiresAt: expect.any(String) });
      expect("supportAccess" in (await me(token))).toBe(false);

      await dbClient.db.update(supportAccessGrants).set({ expiresAt: new Date(Date.now() - 1000) });
      const before = await auditCount();
      const read = await files();
      expect(read.status).toBe(403);
      expect(read.body.error.code).toBe("PERMISSION_DENIED");
      expect((await mkdir("expired")).status).toBe(403);
      expect(await auditCount()).toBe(before + 2);
      expect("supportAccess" in (await me(adminToken))).toBe(false);

      // An expired visit is closed without a close row.
      expect((await close()).status).toBe(204);
      expect(await grants()).toEqual([]);
      expect(await audit("admin.support_access.close")).toEqual([]);
    });

    it("a second visit closes the first with its close row; never two valid grants", async () => {
      await open(siteId);
      await open(siteId);
      expect(await grants()).toHaveLength(1);
      expect(await audit("admin.support_access.close")).toHaveLength(1);
      expect(await audit("admin.support_access.open")).toHaveLength(2);

      const unassigned = await createSite(null, "b");
      expect((await open(unassigned)).body.data.organizationId).toBe(OPS);
      expect((await grants()).map((g) => g.organizationId)).toEqual([OPS]);
      expect((await audit("admin.support_access.close")).map((r) => r.organizationId)).toEqual([orgId, orgId]);
      expect((await files()).status).toBe(404);
      expect((await me(adminToken)).supportAccess.organizationId).toBe(OPS);
    });

    it("a suspended organization still lets a visit change things", async () => {
      await dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, orgId));
      expect((await open(siteId)).status).toBe(201);
      expect((await mkdir("suspended")).status).toBe(204);
    });
  });

  it("an administrator without a visit has no supportAccess on me", async () => {
    expect("supportAccess" in (await me(adminToken))).toBe(false);
  });

  it("a missing site answers 404 and writes nothing", async () => {
    const res = await open("site_missing");
    expect(res.status).toBe(404);
    expect(await grants()).toEqual([]);
    expect(await audit("admin.support_access.open")).toEqual([]);
  });

  it("a site nobody owns opens a visit on the holding organization", async () => {
    const siteId = await createSite(null, "c");
    const res = await open(siteId);
    expect(res.status).toBe(201);
    expect(res.body.data.organizationId).toBe(OPS);
    const [row] = await dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "admin.support_access.open"), eq(auditEvents.organizationId, OPS)));
    expect(row?.targetId).toBe(siteId);
  });
});
