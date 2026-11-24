import { randomUUID } from "node:crypto";
import { CreateManagedSiteInputSchema } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
  membershipRoles,
  memberships,
  operationSteps,
  operations,
  organizations,
  platformInstallations,
  sites,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { ManagedSitesService } from "../src/sites/managed-sites.service.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

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
const REASON = [{ field: "sites", reason: "site_limit_reached", message: expect.any(String) }];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("per-customer site limit", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let adminId: string;
  let orgId: string;
  let token: string;

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
    as: string | null,
    body?: unknown,
    key: string = randomUUID(),
  ): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const run = () => app.outboxWorker.processPendingOnce();
  const org = (id: string, p: string) => `/v1/organizations/${id}${p}`;
  const patchLimit = (id: string, body: unknown, as: string | null = adminToken) =>
    call("PATCH", `/v1/admin/organizations/${id}/site-limit`, as, body);
  const setLimit = async (id: string, maxSites: number | null) =>
    expect((await patchLimit(id, { maxSites })).status).toBe(200);
  const customerCreate = (n: number, as: string = token, id: string = orgId, key?: string) =>
    call(
      "POST",
      org(id, "/managed-sites"),
      as,
      { ...SITE, name: `Site ${String(n)}`, domain: `site${String(n)}.it` },
      key,
    );
  const adminCreate = (owner: string | null, n: number) =>
    call("POST", "/v1/admin/sites", adminToken, {
      ...SITE,
      name: `Admin ${String(n)}`,
      domain: `admin${String(n)}.it`,
      ownerOrganizationId: owner,
    });
  const reassign = (siteId: string, owner: string | null) =>
    call("POST", `/v1/admin/sites/${siteId}/owner`, adminToken, { ownerOrganizationId: owner });
  const siteCount = async (id: string) =>
    (await dbClient.db.select().from(sites).where(eq(sites.organizationId, id))).length;
  const opCount = async () => (await dbClient.db.select().from(operations)).length;
  const opRow = async (id: string) => {
    const [op] = await dbClient.db.select().from(operations).where(eq(operations.id, id));
    const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, id));
    return { ...op!, steps: Object.fromEntries(steps.map((s) => [s.key, s.status])) };
  };
  const maxSitesOf = async (id: string) =>
    (await dbClient.db.select().from(organizations).where(eq(organizations.id, id)))[0]!.maxSites;

  async function createCustomer(name: string, email: string): Promise<{ orgId: string; token: string }> {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: name,
      ownerEmail: email,
      ownerName: name,
    });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, email);
    return {
      orgId: created.body.data.organizationId as string,
      token: await login(email, created.body.data.temporaryPassword as string),
    };
  }

  /** A dedicated host takes one customer, so a second customer gets a host of its own. */
  async function addCustomer(name: string, email: string): Promise<{ orgId: string; token: string }> {
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const hostId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostId,
      platformInstallationId: inst!.id,
      name: `host-${name}.test`,
      hostname: `host-${name}.test`.replace(/ /g, "-"),
      ipv4Address: "10.0.0.32",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    const id = `org_${randomUUID()}`;
    await dbClient.db
      .insert(organizations)
      .values({ id, platformInstallationId: inst!.id, name, slug: name.toLowerCase().replace(/ /g, "-") });
    await dbClient.db
      .insert(hostAllocations)
      .values({ id: `alloc_${randomUUID()}`, hostId, organizationId: id, status: "active" });
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email, name, passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: id, userId });
    await dbClient.db
      .insert(membershipRoles)
      .values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_owner" });
    return { orgId: id, token: await login(email, PW) };
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
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
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    adminId = admin.userId;
    ({ orgId, token } = await createCustomer("Hotel Mario", "mario@hotel.it"));
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("PATCH /v1/admin/organizations/:orgId/site-limit", () => {
    it("sets the limit, answers the usage and audits it in the same step", async () => {
      expect(await maxSitesOf(orgId)).toBeNull();
      const res = await patchLimit(orgId, { maxSites: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ organizationId: orgId, maxSites: 1, usedSites: 0 });
      expect(await maxSitesOf(orgId)).toBe(1);

      const [audit] = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.customer.site_limit"));
      expect(audit).toMatchObject({ actorId: adminId, organizationId: orgId, targetType: "organization", targetId: orgId });
      expect(audit!.details).toEqual({ outcome: "succeeded", requestId: expect.any(String), from: null, to: 1 });

      await patchLimit(orgId, { maxSites: 5 });
      const rows = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.customer.site_limit"));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => [(r.details as Json).from, (r.details as Json).to])).toEqual(
        expect.arrayContaining([
          [null, 1],
          [1, 5],
        ]),
      );
    });

    it("null makes the customer unlimited again", async () => {
      await setLimit(orgId, 0);
      expect((await customerCreate(1)).status).toBe(409);
      const res = await patchLimit(orgId, { maxSites: null });
      expect(res.body.data).toEqual({ organizationId: orgId, maxSites: null, usedSites: 0 });
      expect(await maxSitesOf(orgId)).toBeNull();
      expect((await customerCreate(1)).status).toBe(202);
    });

    it.each([[{}], [{ maxSites: -1 }], [{ maxSites: 1.5 }], [{ maxSites: "3" }], [{ maxSites: 10_001 }], [{ maxSites: 1, extra: true }]])(
      "refuses the body %j with 400 and changes nothing",
      async (body) => {
        const res = await patchLimit(orgId, body);
        expect(res.status).toBe(400);
        expect(await maxSitesOf(orgId)).toBeNull();
        expect(await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.customer.site_limit"))).toEqual([]);
      },
    );

    it("accepts the ceiling", async () => {
      expect((await patchLimit(orgId, { maxSites: 10_000 })).body.data.maxSites).toBe(10_000);
    });

    it("answers 404 for an unknown customer and for platform-ops", async () => {
      expect((await patchLimit("org_nope", { maxSites: 1 })).status).toBe(404);
      expect((await patchLimit(OPS, { maxSites: 1 })).status).toBe(404);
      expect(await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.customer.site_limit"))).toEqual([]);
    });

    it("refuses anybody but a server administrator, before looking at the body or the customer", async () => {
      const denied = await patchLimit(orgId, { maxSites: 1 }, token);
      expect(denied.status).toBe(403);
      expect((await patchLimit(orgId, { maxSites: -1 }, token)).status).toBe(403);
      expect((await patchLimit(OPS, { maxSites: 1 }, token)).status).toBe(403);
      expect((await patchLimit("org_nope", { maxSites: 1 }, token)).status).toBe(403);
      expect(await maxSitesOf(orgId)).toBeNull();
      const rows = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "platform.users.manage"));
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => (r.details as Json).outcome === "denied")).toBe(true);
    });

    it("refuses another customer's owner and an anonymous caller", async () => {
      const second = await addCustomer("Hotel Luigi", "luigi@hotel.it");
      expect((await patchLimit(orgId, { maxSites: 1 }, second.token)).status).toBe(403);
      expect((await patchLimit(orgId, { maxSites: 1 }, null)).status).toBe(401);
      expect(await maxSitesOf(orgId)).toBeNull();
    });

    it("reports the sites in use and may lower the limit below them", async () => {
      expect((await customerCreate(1)).status).toBe(202);
      expect((await customerCreate(2)).status).toBe(202);
      const res = await patchLimit(orgId, { maxSites: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ organizationId: orgId, maxSites: 1, usedSites: 2 });
      expect(await siteCount(orgId)).toBe(2);
    });
  });

  describe("creating a site", () => {
    it("the customer create is refused with one site_limit_reached detail and leaves nothing behind", async () => {
      await setLimit(orgId, 1);
      expect((await customerCreate(1)).status).toBe(202);
      const ops = await opCount();

      const res = await customerCreate(2);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("QUOTA_EXCEEDED");
      expect(res.body.error.details).toEqual(REASON);
      expect(res.body.error.details[0].message).toBe("1 of 1 sites in use.");
      expect(await siteCount(orgId)).toBe(1);
      expect(await opCount()).toBe(ops);
    });

    it("limit 0 refuses the first site", async () => {
      await setLimit(orgId, 0);
      const res = await customerCreate(1);
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual(REASON);
      expect(await siteCount(orgId)).toBe(0);
    });

    it("the admin create for a customer is refused the same way", async () => {
      await setLimit(orgId, 1);
      expect((await adminCreate(orgId, 1)).status).toBe(202);
      const ops = await opCount();
      const res = await adminCreate(orgId, 2);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("QUOTA_EXCEEDED");
      expect(res.body.error.details).toEqual(REASON);
      expect(await siteCount(orgId)).toBe(1);
      expect(await opCount()).toBe(ops);
    });

    it("an admin create for platform-ops is never limited", async () => {
      await setLimit(orgId, 0);
      expect((await adminCreate(null, 1)).status).toBe(202);
      expect((await adminCreate(null, 2)).status).toBe(202);
      expect(await siteCount(OPS)).toBe(2);
    });

    it("the limit is per customer", async () => {
      await setLimit(orgId, 0);
      const other = await addCustomer("Hotel Luigi", "luigi@hotel.it");
      expect((await customerCreate(1, other.token, other.orgId)).status).toBe(202);
      expect((await customerCreate(2)).status).toBe(409);
    });

    it("the generic site route is limited too, and its bare sites count", async () => {
      await setLimit(orgId, 1);
      const [alloc] = await dbClient.db.select().from(hostAllocations).where(eq(hostAllocations.organizationId, orgId));
      // The generic route is the server administrator's (#116): one who is also an owner of the customer.
      await dbClient.db.insert(memberships).values({ id: "mem_admin_bare", organizationId: orgId, userId: adminId });
      await dbClient.db
        .insert(membershipRoles)
        .values({ id: "mrl_admin_bare", membershipId: "mem_admin_bare", roleId: "role_customer_owner" });
      const bare = (n: number) =>
        call("POST", org(orgId, "/sites"), adminToken, { name: `Bare ${String(n)}`, slug: `bare-${String(n)}`, hostAllocationId: alloc!.id });
      expect((await bare(1)).status).toBe(201);

      const refused = await bare(2);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("QUOTA_EXCEEDED");
      expect(refused.body.error.details).toEqual(REASON);
      expect(await siteCount(orgId)).toBe(1);

      const managed = await customerCreate(3);
      expect(managed.status).toBe(409);
      expect(managed.body.error.details).toEqual(REASON);
    });

    it("repeating the same key returns the original answer even when the limit is full", async () => {
      await setLimit(orgId, 1);
      const key = randomUUID();
      const first = await customerCreate(1, token, orgId, key);
      expect(first.status).toBe(202);
      const again = await customerCreate(1, token, orgId, key);
      expect(again.status).toBe(202);
      expect(again.body.data).toEqual(first.body.data);
      expect(await siteCount(orgId)).toBe(1);
    });

    it("a create that lost the last slot to the same key replays the winner instead of failing", async () => {
      await setLimit(orgId, 1);
      const [owner] = await dbClient.db.select().from(users).where(eq(users.email, "mario@hotel.it"));
      const service = app.nestApp.get(ManagedSitesService);
      const key = randomUUID();
      const input = { organizationId: orgId, body: CreateManagedSiteInputSchema.parse(SITE), actorId: owner!.id, idempotencyKey: key };
      // Called directly and in the same tick: both pass the replay and domain checks, the second then meets the full limit.
      const [a, b] = await Promise.all([service.create(input), service.create(input)]);
      expect(b).toEqual(a);
      expect(await siteCount(orgId)).toBe(1);
    });

    it("two concurrent creates with different keys leave exactly one site", async () => {
      await setLimit(orgId, 1);
      const [a, b] = await Promise.all([customerCreate(1), customerCreate(2)]);
      expect([a.status, b.status].sort()).toEqual([202, 409]);
      expect(await siteCount(orgId)).toBe(1);
    });

    it("raising the limit after a refusal lets the next create through", async () => {
      await setLimit(orgId, 1);
      expect((await customerCreate(1)).status).toBe(202);
      expect((await customerCreate(2)).status).toBe(409);
      await setLimit(orgId, 2);
      expect((await customerCreate(2)).status).toBe(202);
      expect(await siteCount(orgId)).toBe(2);
    });

    it("lowering the limit below the usage keeps the sites and blocks new ones", async () => {
      expect((await customerCreate(1)).status).toBe(202);
      expect((await customerCreate(2)).status).toBe(202);
      await setLimit(orgId, 1);
      expect(await siteCount(orgId)).toBe(2);
      expect((await customerCreate(3)).status).toBe(409);
    });

    it("a deleted site frees its slot", async () => {
      await setLimit(orgId, 1);
      const created = await customerCreate(1);
      expect(created.status).toBe(202);
      await run();
      expect((await customerCreate(2)).status).toBe(409);

      const siteId = created.body.data.siteId as string;
      const del = await call("DELETE", org(orgId, `/managed-sites/${siteId}`), token, { confirmName: "Site 1" });
      expect(del.status).toBe(202);
      await run();
      expect(await siteCount(orgId)).toBe(0);
      expect((await customerCreate(2)).status).toBe(202);
    });
  });

  describe("changing the owner", () => {
    it("queueing a move into a full customer is refused, a move into a customer with room is queued", async () => {
      const other = await addCustomer("Hotel Luigi", "luigi@hotel.it");
      await setLimit(orgId, 1);
      expect((await customerCreate(1)).status).toBe(202);
      const { body } = await adminCreate(null, 1);
      const siteId = body.data.siteId as string;
      await run();

      const ops = await opCount();
      const refused = await reassign(siteId, orgId);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("QUOTA_EXCEEDED");
      expect(refused.body.error.details).toEqual(REASON);
      expect(await opCount()).toBe(ops);

      const queued = await reassign(siteId, other.orgId);
      expect(queued.status).toBe(202);
      await run();
      expect((await opRow(queued.body.data.operationId as string)).status).toBe("succeeded");
      expect(await siteCount(other.orgId)).toBe(1);
    });

    it("the move itself refuses a customer that filled up after the move was queued", async () => {
      const other = await addCustomer("Hotel Luigi", "luigi@hotel.it");
      const { body } = await adminCreate(null, 1);
      const siteId = body.data.siteId as string;
      await run();

      const queued = await reassign(siteId, other.orgId);
      expect(queued.status).toBe(202);
      await setLimit(other.orgId, 0);
      await run();

      const op = await opRow(queued.body.data.operationId as string);
      expect(op.status).toBe("failed");
      expect(op.errorCode).toBe("QUOTA_EXCEEDED");
      expect(op.steps["move_ownership"]).toBe("failed");
      expect((await dbClient.db.select().from(sites).where(eq(sites.id, siteId)))[0]!.organizationId).toBe(OPS);
    });
  });

  describe("reading the usage", () => {
    it("the organization detail carries maxSites and siteCount", async () => {
      const before = await call("GET", org(orgId, ""), token);
      expect(before.status).toBe(200);
      expect(before.body.data).toMatchObject({ maxSites: null, siteCount: 0 });

      await setLimit(orgId, 3);
      expect((await customerCreate(1)).status).toBe(202);
      const after = await call("GET", org(orgId, ""), token);
      expect(after.body.data).toMatchObject({ maxSites: 3, siteCount: 1 });
    });

    it("another customer cannot read the detail", async () => {
      const other = await addCustomer("Hotel Luigi", "luigi@hotel.it");
      expect([403, 404]).toContain((await call("GET", org(orgId, ""), other.token)).status);
    });

    it("the admin list carries maxSites and siteCount per customer", async () => {
      const other = await addCustomer("Hotel Luigi", "luigi@hotel.it");
      await setLimit(orgId, 4);
      expect((await customerCreate(1)).status).toBe(202);
      expect((await adminCreate(null, 1)).status).toBe(202);
      const res = await call("GET", "/v1/admin/sites", adminToken);
      expect(res.status).toBe(200);
      expect(res.body.data.customers).toEqual([
        { organizationId: other.orgId, name: "Hotel Luigi", ownerEmail: "luigi@hotel.it", maxSites: null, siteCount: 0 },
        { organizationId: orgId, name: "Hotel Mario", ownerEmail: "mario@hotel.it", maxSites: 4, siteCount: 1 },
      ]);
    });
  });
});
