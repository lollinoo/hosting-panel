import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  hosts,
  memberships,
  membershipRoles,
  sql,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-admin-pass-0001";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const GUARDED = /^\/v1\/(admin(\/|$)|hosts(\/|$)|allocations(\/|$))/;
// Open on purpose, each one checked in the report: health probes, login, the two reset routes, dev OIDC (404 when disabled).
const OPEN_ROUTES = [
  "GET /health/live",
  "GET /health/ready",
  "POST /v1/auth/login",
  "POST /v1/auth/password-reset/request",
  "POST /v1/auth/password-reset/confirm",
  "GET /v1/dev/auth/personas",
  "POST /v1/dev/auth/token",
];
// The only routes a session that must change its password may still use (#8).
const PASSWORD_CHANGE_ROUTES = ["GET /v1/me", "POST /v1/me/password", "POST /v1/auth/revoke"];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Route = { method: string; path: string };

/** Routes of the running app, parsed from Fastify's printRoutes tree (HEAD and OPTIONS dropped). */
function listRoutes(tree: string): Route[] {
  const stack: string[] = [];
  const out: Route[] = [];
  for (const line of tree.split("\n")) {
    const m = /^((?:│ {3}| {4})*)[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    stack.push(m[2]!);
    for (const method of (m[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (method !== "HEAD" && method !== "OPTIONS") out.push({ method, path: stack.join("") });
    }
  }
  return out;
}

describe("every administrator route refuses a customer before it does anything", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let routes: Route[];
  let adminToken: string;
  let params: Record<string, string>;
  const customers: Record<"owner" | "member", { id: string; token: string }> = {} as never;

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

  const fill = (path: string) =>
    path.replace(/:(\w+)/g, (_, name: string) => {
      expect(params[name], `no value for path parameter :${name}`).toBeDefined();
      return params[name]!;
    });
  const auditIds = async () => new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
  const auditSince = async (seen: Set<string>) => (await dbClient.db.select().from(auditEvents)).filter((r) => !seen.has(r.id));
  const guarded = () => routes.filter((r) => GUARDED.test(r.path));

  /** Content hash of every table but the audit log, so any write a refused call made shows up. */
  async function snapshot(): Promise<Record<string, string>> {
    const tables = (await dbClient.db.execute(
      sql.raw("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"),
    )).rows as Array<{ table_name: string }>;
    const out: Record<string, string> = {};
    for (const { table_name: t } of tables) {
      if (t === "audit_events") continue;
      const [row] = (await dbClient.db.execute(
        sql.raw(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM "${t}" x`),
      )).rows as Array<{ h: string }>;
      out[t] = row!.h;
    }
    return out;
  }

  beforeAll(async () => {
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
    routes = listRoutes(app.fastify.printRoutes({ commonPrefix: false }));
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);

    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: "Customer a",
      ownerEmail: "owner-a@example.test",
      ownerName: "Owner a",
    });
    expect(created.status).toBe(201);
    const orgId = created.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, "owner-a@example.test");
    customers.owner = { id: created.body.data.userId as string, token: await login("owner-a@example.test", created.body.data.temporaryPassword as string) };

    // An ordinary member: no invitation route exists in M5a, so the row is written directly.
    const memberId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: memberId, email: "member-a@example.test", name: "Member a", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId: memberId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
    customers.member = { id: memberId, token: await login("member-a@example.test", PW) };

    const siteRes = await call("POST", "/v1/admin/sites", adminToken, {
      name: "Site a",
      domain: "wp-a.example.test",
      title: "Site a",
      adminUser: "siteadmin",
      adminEmail: "wp-a@example.test",
      adminPassword: "sentinel-Wp-Pass-123456",
      ownerOrganizationId: orgId,
    });
    expect(siteRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const [host] = await dbClient.db.select().from(hosts).limit(1);
    params = {
      orgId,
      siteId: siteRes.body.data.siteId as string,
      userId: admin.userId,
      domainId: `dom_${randomUUID()}`,
      certificateId: `cti_${randomUUID().replace(/-/g, "")}`,
      versionId: `ctv_${randomUUID().replace(/-/g, "")}`,
      hostId: host!.id,
      opId: `op_${randomUUID()}`,
      backupId: `bkp_${randomUUID()}`,
      secretId: `sec_${randomUUID()}`,
      serviceId: `svc_${randomUUID()}`,
      memberId: `mem_${randomUUID()}`,
      name: "db_a",
      database: "db_a",
      slot: "1",
      component: "ingress_proxy",
      sessionId: `term_${randomUUID().replace(/-/g, "")}`,
      operationId: `op_${randomUUID()}`,
      blockId: `fwb_${randomUUID().replace(/-/g, "")}`,
      service: "api",
    };
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("the router holds at least 40 administrator, hosts and allocations routes", () => {
    expect(guarded().length).toBeGreaterThanOrEqual(40);
    expect(guarded()).toContainEqual({ method: "POST", path: "/v1/admin/administrators" });
    expect(guarded()).toContainEqual({ method: "POST", path: "/v1/admin/sites/:siteId/support-access" });
    expect(guarded()).toContainEqual({ method: "DELETE", path: "/v1/admin/support-access" });
    for (const path of ["/v1/admin/sites/:siteId/terminal", ...["write", "read", "close"].map((v) => `/v1/admin/terminal/:sessionId/${v}`)]) {
      expect(guarded()).toContainEqual({ method: "POST", path });
    }
    for (const [method, path] of [
      ["GET", "/v1/admin/tls-certificates"],
      ["GET", "/v1/admin/tls-certificates/alerts"],
      ["DELETE", "/v1/admin/tls-certificates/:certificateId"],
      ["GET", "/v1/admin/sites/:siteId/tls-certificates"],
      ["POST", "/v1/admin/sites/:siteId/tls-certificates"],
      ["GET", "/v1/admin/sites/:siteId/tls-certificates/:certificateId"],
      ["DELETE", "/v1/admin/sites/:siteId/tls-certificates/:certificateId"],
      ["POST", "/v1/admin/sites/:siteId/tls-certificates/:certificateId/versions"],
      ["POST", "/v1/admin/sites/:siteId/tls-certificates/:certificateId/versions/:versionId/activate"],
      ["POST", "/v1/admin/sites/:siteId/domains/:domainId/tls"],
      ["GET", "/v1/admin/updates"],
      ["POST", "/v1/admin/updates/panel/check"],
      ["POST", "/v1/admin/updates/panel/apply"],
      ["POST", "/v1/admin/updates/components/:component/apply"],
      ["POST", "/v1/admin/sites/:siteId/image-update"],
      ["GET", "/v1/admin/os-packages"],
      ["POST", "/v1/admin/os-packages/refresh"],
      ["POST", "/v1/admin/os-packages/upgrade"],
      ["POST", "/v1/admin/host-services/:service/restart"],
    ]) {
      expect(guarded()).toContainEqual({ method, path });
    }
    for (const [method, path] of [
      ["GET", "/v1/admin/firewall"],
      ["POST", "/v1/admin/firewall/ports/:name/open"],
      ["POST", "/v1/admin/firewall/ports/:name/close"],
      ["POST", "/v1/admin/firewall/blocks"],
      ["DELETE", "/v1/admin/firewall/blocks/:blockId"],
    ]) {
      expect(guarded()).toContainEqual({ method, path });
    }
  });

  it("a member and an owner get 403 PERMISSION_DENIED and exactly one denied audit row naming them, and nothing changes", async () => {
    const before = await snapshot();
    const usersBefore = await dbClient.db.select({ id: users.id, status: users.userStatus, role: users.platformRole }).from(users);
    const failures: string[] = [];
    for (const who of ["member", "owner"] as const) {
      for (const r of guarded()) {
        const seen = await auditIds();
        const res = await call(r.method, fill(r.path), customers[who].token);
        const added = await auditSince(seen);
        const ok =
          res.status === 403 &&
          res.body.error?.code === "PERMISSION_DENIED" &&
          added.length === 1 &&
          added[0]!.actorId === customers[who].id &&
          (added[0]!.details as Json).outcome === "denied";
        if (!ok) failures.push(`${r.method} ${r.path} as ${who}: ${res.status} ${res.body.error?.code ?? ""} audit+${added.length}`);
      }
    }
    expect(failures).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await dbClient.db.select({ id: users.id, status: users.userStatus, role: users.platformRole }).from(users)).toEqual(usersBefore);
  });

  it("R202 5: a path parameter holding %00 still answers a customer 403 with one denied row", async () => {
    const before = await snapshot();
    const failures: string[] = [];
    for (const [method, path] of [
      ["DELETE", "/v1/admin/firewall/blocks/fwb_sentinel%00x"],
      ["POST", "/v1/admin/firewall/ports/http_alt%00/open"],
      ["POST", "/v1/admin/host-services/web%00/restart"],
    ] as const) {
      const seen = await auditIds();
      const res = await call(method, path, customers.member.token, { reason: "Sentinel reason for the restart" });
      const added = await auditSince(seen);
      const ok = res.status === 403 && added.length === 1 && (added[0]!.details as Json).outcome === "denied" && !(added[0]!.targetId ?? "").includes("\u0000");
      if (!ok) failures.push(`${method} ${path}: ${res.status} ${res.body.error?.code ?? ""} audit+${added.length}`);
    }
    expect(failures).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("without credentials every route answers 401 except the pinned open ones", async () => {
    const open: string[] = [];
    for (const r of routes) {
      const res = await call(r.method, fill(r.path), null);
      if (res.status !== 401) open.push(`${r.method} ${r.path}`);
    }
    expect(open.sort()).toEqual([...OPEN_ROUTES].sort());
  });

  it("a session that must change its password gets 403 PASSWORD_CHANGE_REQUIRED on every route but the three it needs, and nothing changes", async () => {
    await dbClient.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, customers.member.id));
    try {
      const before = await snapshot();
      const seen = await auditIds();
      const failures: string[] = [];
      for (const r of routes) {
        const key = `${r.method} ${r.path}`;
        if (OPEN_ROUTES.includes(key) || PASSWORD_CHANGE_ROUTES.includes(key)) continue;
        const res = await call(r.method, fill(r.path), customers.member.token);
        if (res.status !== 403 || res.body.error?.code !== "PASSWORD_CHANGE_REQUIRED") failures.push(`${key}: ${res.status} ${res.body.error?.code ?? ""}`);
      }
      expect(failures).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await auditSince(seen)).toEqual([]);
    } finally {
      await dbClient.db.update(users).set({ mustChangePassword: false }).where(eq(users.id, customers.member.id));
    }
  });

  it("a disabled administrator and a revoked session get 401 on every administrator route", async () => {
    const other = await createServerAdmin(dbClient.db, KEY, { email: "admin-b@example.test", name: "Admin b", password: PW });
    const disabledToken = await login("admin-b@example.test", PW, other.totpSecretBase32);
    const third = await createServerAdmin(dbClient.db, KEY, { email: "admin-c@example.test", name: "Admin c", password: PW });
    const revokedToken = await login("admin-c@example.test", PW, third.totpSecretBase32);
    expect((await call("GET", "/v1/admin/users", disabledToken)).status).toBe(200);
    expect((await call("GET", "/v1/admin/users", revokedToken)).status).toBe(200);

    expect((await call("PATCH", `/v1/admin/users/${other.userId}`, adminToken, { status: "disabled" })).status).toBe(200);
    expect((await call("POST", "/v1/auth/revoke", revokedToken)).status).toBe(200);

    const failures: string[] = [];
    for (const [who, token] of [["disabled", disabledToken], ["revoked", revokedToken]] as const) {
      for (const r of guarded()) {
        const res = await call(r.method, fill(r.path), token);
        if (res.status !== 401) failures.push(`${r.method} ${r.path} as ${who}: ${res.status} ${res.body.error?.code ?? ""}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
