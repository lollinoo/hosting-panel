import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  hosts,
  memberships,
  membershipRoles,
  operations,
  organizations,
  platformInstallations,
  serviceInstances,
  supportAccessGrants,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { AuthzContextService } from "../src/auth/authz-context.service.js";
import { hashPassword } from "../src/auth/password.js";
import { SUPPORT_ACCESS_PERMISSIONS, SUPPORT_ACCESS_TTL_MS } from "../src/auth/support-access.service.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-admin-pass-0001";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const ORG_ROUTE = /^\/v1\/organizations\/:orgId(\/|$)/;
const SUPPORT_KEYS: readonly string[] = SUPPORT_ACCESS_PERMISSIONS;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Route = { method: string; path: string };
type Answer = { route: string; status: number; code: string; rows: Array<typeof auditEvents.$inferSelect> };

/** Routes of the running app, parsed from Fastify's printRoutes tree (HEAD and OPTIONS dropped). */
function listRoutes(tree: string): Route[] {
  const stack: string[] = [];
  const out: Route[] = [];
  for (const line of tree.split("\n")) {
    const m = /^((?:│ {3}| {4})*)[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line);
    if (!m) continue;
    stack.length = m[1]!.length / 4;
    stack.push(m[2]!);
    for (const method of (m[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (method !== "HEAD" && method !== "OPTIONS") out.push({ method, path: stack.join("") });
    }
  }
  return out;
}

describe("support access tenancy over every organization route", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let routes: Route[];
  let adminToken: string;
  let adminId: string;
  let orgA: string;
  let orgB: string;
  let siteA: string;
  let customerB: string;
  let ids: Record<string, string>;
  let second: { id: string; totp: string };

  async function login(email: string, password: string, totpSecret?: string, stepOffset = 0): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000) + stepOffset) } : {}),
      }),
    });
    const body = (await res.json()) as Json;
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.data.accessToken as string;
  }

  async function call(method: string, path: string, as: string | null, body: unknown = {}): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const orgRoutes = () => routes.filter((r) => ORG_ROUTE.test(r.path));
  const fill = (path: string, orgId: string) =>
    path.replace(/:(\w+)/g, (_, name: string) => {
      if (name === "orgId") return orgId;
      expect(ids[name], `no value for path parameter :${name}`).toBeDefined();
      return ids[name]!;
    });
  const auditIds = async () => new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
  const open = (siteId: string, as = adminToken, body?: unknown) => call("POST", `/v1/admin/sites/${siteId}/support-access`, as, body);
  const close = (as = adminToken) => call("DELETE", "/v1/admin/support-access", as);
  const grants = () => dbClient.db.select().from(supportAccessGrants);

  /** Calls every organization route on orgId; the site's own DELETE goes last so the walk can mutate. */
  async function walk(orgId: string, token: string): Promise<Answer[]> {
    const ordered = [...orgRoutes()].sort(
      (a, b) => Number(a.method === "DELETE" && a.path.endsWith("/:siteId")) - Number(b.method === "DELETE" && b.path.endsWith("/:siteId")),
    );
    const out: Answer[] = [];
    for (const r of ordered) {
      const seen = await auditIds();
      // The lifecycle route takes its permission from the action, so it gets one.
      const body = r.path.endsWith("/lifecycle") ? { action: "restart" } : {};
      const res = await call(r.method, fill(r.path, orgId), token, body);
      const rows = (await dbClient.db.select().from(auditEvents)).filter((row) => !seen.has(row.id));
      out.push({ route: `${r.method} ${r.path}`, status: res.status, code: (res.body.error?.code as string) ?? "", rows });
    }
    return out;
  }

  /** Fails with every entry printed, one per line. */
  const none = (list: string[]) => expect(list.join("\n")).toBe("");
  /** The routes that did not answer 404 with no audit row. */
  const notHidden = (answers: Answer[]) =>
    answers.filter((a) => a.status !== 404 || a.rows.length > 0).map((a) => `${a.route}: ${a.status} ${a.code} audit+${a.rows.length}`);

  async function customerOwner(orgId: string, email: string): Promise<string> {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email, name: "Owner b", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_owner" });
    return login(email, PW);
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    const other = await createServerAdmin(dbClient.db, KEY, { email: "admin-b@example.test", name: "Admin b", password: PW });
    second = { id: other.userId, totp: other.totpSecretBase32 };
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
    routes = listRoutes(app.fastify.printRoutes({ commonPrefix: false }));
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    adminId = admin.userId;

    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: "Customer a",
      ownerEmail: "owner-a@example.test",
      ownerName: "Owner a",
    });
    expect(created.status).toBe(201);
    orgA = created.body.data.organizationId as string;

    // A second customer: the panel admits one through the API, so its rows are written directly.
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    orgB = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({ id: orgB, platformInstallationId: inst!.id, name: "Customer b", slug: `customer-b-${orgB}` });
    customerB = await customerOwner(orgB, "owner-b@example.test");

    const siteRes = await call("POST", "/v1/admin/sites", adminToken, {
      name: "Site a",
      domain: "wp-a.example.test",
      title: "Site a",
      adminUser: "siteadmin",
      adminEmail: "wp-a@example.test",
      adminPassword: "sentinel-Wp-Pass-123456",
      ownerOrganizationId: orgA,
    });
    expect(siteRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    siteA = siteRes.body.data.siteId as string;
    const [op] = await dbClient.db.select().from(operations).where(eq(operations.organizationId, orgA)).limit(1);
    const [host] = await dbClient.db.select().from(hosts).limit(1);
    const [service] = await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.organizationId, orgA)).limit(1);
    expect(op).toBeDefined();
    expect(service).toBeDefined();
    ids = {
      siteId: siteA,
      opId: op!.id,
      hostId: host!.id,
      domainId: `dom_${randomUUID()}`,
      certificateId: `cti_${randomUUID().replace(/-/g, "")}`,
      versionId: `ctv_${randomUUID().replace(/-/g, "")}`,
      backupId: `bkp_${randomUUID()}`,
      secretId: `sec_${randomUUID()}`,
      serviceId: service!.id,
      memberId: `mem_${randomUUID()}`,
      userId: `usr_${randomUUID()}`,
      name: "db_a",
      database: "db_a",
      slot: "1",
    };
  });

  afterEach(async () => {
    await dbClient.db.delete(supportAccessGrants);
    (app.nestApp.get(AuthzContextService) as unknown as { deniedWindows: Map<string, unknown> }).deniedWindows.clear();
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("the router holds the customer's site routes under /v1/organizations/:orgId", () => {
    expect(orgRoutes().length).toBeGreaterThanOrEqual(54);
    expect(orgRoutes()).toContainEqual({ method: "GET", path: "/v1/organizations/:orgId/managed-sites/:siteId/files" });
    expect(orgRoutes()).toContainEqual({ method: "GET", path: "/v1/organizations/:orgId/members" });
    for (const [method, path] of [
      ["GET", "/tls-certificates"],
      ["POST", "/tls-certificates"],
      ["GET", "/tls-certificates/:certificateId"],
      ["DELETE", "/tls-certificates/:certificateId"],
      ["POST", "/tls-certificates/:certificateId/versions"],
      ["POST", "/tls-certificates/:certificateId/versions/:versionId/activate"],
      ["POST", "/domains/:domainId/tls"],
    ]) {
      expect(orgRoutes()).toContainEqual({ method, path: `/v1/organizations/:orgId/managed-sites/:siteId${path}` });
    }
  });

  it("without a visit, with a closed one, and on any other organization: 404 and no audit row on every route", async () => {
    none(notHidden(await walk(orgA, adminToken)));
    none(notHidden(await walk(orgA, customerB)));

    expect((await open(siteA)).status).toBe(201);
    none(notHidden(await walk(orgB, adminToken)));
    none(notHidden(await walk(orgA, customerB)));

    expect((await close()).status).toBe(204);
    none(notHidden(await walk(orgA, adminToken)));
    expect(await grants()).toEqual([]);
  });

  it("a visit that ran out answers 403 PERMISSION_DENIED with one denied row on every route", async () => {
    expect((await open(siteA)).status).toBe(201);
    await dbClient.db.update(supportAccessGrants).set({ expiresAt: new Date(Date.now() - 1000) });
    const answers = await walk(orgA, adminToken);
    const wrong = answers
      .filter(
        (a) =>
          a.status !== 403 ||
          a.code !== "PERMISSION_DENIED" ||
          a.rows.length !== 1 ||
          a.rows[0]!.actorId !== adminId ||
          a.rows[0]!.organizationId !== orgA ||
          (a.rows[0]!.details as Json).reason !== "SUPPORT_ACCESS_GRANT_EXPIRED",
      )
      .map((a) => `${a.route}: ${a.status} ${a.code} audit+${a.rows.length}`);
    none(wrong);
    expect((await close()).status).toBe(204);
  });

  it("only an administrator opens a visit, only through the route, for the design's organization, time and keys", async () => {
    const before = (await dbClient.db.select().from(auditEvents)).length;
    expect((await open(siteA, customerB)).status).toBe(403);
    expect((await close(customerB)).status).toBe(403);
    expect((await dbClient.db.select().from(auditEvents)).length).toBe(before + 2);
    expect(await grants()).toEqual([]);

    const opens = () => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.support_access.open"));
    const opensBefore = (await opens()).length;
    for (const bad of ["site_missing", "x", "..%2F..%2Fusers", "site_..%2F..%2Fsupport-access", "%00"]) {
      const res = await open(bad);
      expect([400, 404], `${bad}: ${res.status}`).toContain(res.status);
    }
    expect(await grants()).toEqual([]);
    expect((await opens()).length).toBe(opensBefore);

    const res = await open(siteA, adminToken, {
      expiresAt: "2099-01-01T00:00:00.000Z",
      organizationId: orgB,
      permissions: ["organization.members.manage", "quota.manage", "audit.read"],
      siteIds: [siteA, "site_other"],
    });
    expect([201, 400]).toContain(res.status);
    if (res.status === 201) {
      const [grant] = await grants();
      expect(grant).toMatchObject({ organizationId: orgA, operatorUserId: adminId, permissions: [...SUPPORT_ACCESS_PERMISSIONS] });
      expect(grant!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(SUPPORT_ACCESS_TTL_MS);
      expect(grant!.expiresAt.getTime() - Date.now()).toBeGreaterThan(SUPPORT_ACCESS_TTL_MS - 60_000);
      none(notHidden(await walk(orgB, adminToken)));
      expect((await close()).status).toBe(204);
    } else {
      expect(await grants()).toEqual([]);
    }
  });

  it("a disabled administrator's visit is dead, and one that ran out meanwhile gives nothing after enable", async () => {
    let token = await login("admin-b@example.test", PW, second.totp);
    expect((await open(siteA, token)).status).toBe(201);
    expect((await call("GET", `/v1/organizations/${orgA}/managed-sites/${siteA}/files`, token)).status).toBe(200);

    expect((await call("PATCH", `/v1/admin/users/${second.id}`, adminToken, { status: "disabled" })).status).toBe(200);
    const dead = (await walk(orgA, token)).filter((a) => a.status !== 401).map((a) => `${a.route}: ${a.status} ${a.code}`);
    none(dead);

    await dbClient.db.update(supportAccessGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(supportAccessGrants.operatorUserId, second.id));
    expect((await call("PATCH", `/v1/admin/users/${second.id}`, adminToken, { status: "active" })).status).toBe(200);
    token = await login("admin-b@example.test", PW, second.totp, 1); // the same step's code is refused as a replay
    const me = await call("GET", "/v1/me", token);
    expect("supportAccess" in me.body.data).toBe(false);
    const opened = (await walk(orgA, token)).filter((a) => a.status !== 403 || a.code !== "PERMISSION_DENIED").map((a) => `${a.route}: ${a.status} ${a.code}`);
    none(opened);
    expect((await close(token)).status).toBe(204);
  });

  it("an open visit opens the routes of the 15 keys and nothing else (the site's DELETE runs last)", async () => {
    // Each route's permission, read from the denied row an expired visit leaves.
    expect((await open(siteA)).status).toBe(201);
    await dbClient.db.update(supportAccessGrants).set({ expiresAt: new Date(Date.now() - 1000) });
    const permissionOf = new Map((await walk(orgA, adminToken)).map((a) => [a.route, a.rows[0]?.action ?? "?"]));

    expect((await open(siteA)).status).toBe(201);
    const answers = await walk(orgA, adminToken);
    const table = answers.map((a) => ({ route: a.route, permission: permissionOf.get(a.route)!, status: a.status, code: a.code }));
    const wrong = answers.filter((a) => {
      const inside = SUPPORT_KEYS.includes(permissionOf.get(a.route)!);
      const denied = a.status === 403 && a.code === "PERMISSION_DENIED" && a.rows.length === 1
        && (a.rows[0]!.details as Json).reason === "SUPPORT_ACCESS_PERMISSION_DENIED";
      // Inside: a 404 here can only be a missing resource (a valid grant never hides the organization), so no denied row may appear.
      return inside ? a.status === 403 || a.status === 401 || a.status >= 500 || a.rows.some((r) => (r.details as Json).outcome === "denied") : !denied;
    });
    none(wrong.map((a) => JSON.stringify(table.find((t) => t.route === a.route))));
    for (const closed of ["GET /v1/organizations/:orgId/members", "GET /v1/organizations/:orgId/quotas", "GET /v1/organizations/:orgId"]) {
      expect(table.find((t) => t.route === closed)?.status, closed).toBe(403);
    }
    expect((await close()).status).toBe(204);
  });
});
