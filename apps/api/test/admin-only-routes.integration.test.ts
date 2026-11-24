import {
  auditEvents,
  DEMO_IDS,
  domains,
  eq,
  membershipRoles,
  memberships,
  serviceInstances,
  sites,
  stackRevisions,
  supportAccessGrants,
  users,
} from "@hosting-panel/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { SUPPORT_ACCESS_PERMISSIONS } from "../src/auth/support-access.service.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ORG = DEMO_IDS.organizations.acme;
const SITE = DEMO_IDS.sites.acmeShop;
const SERVICE = DEMO_IDS.services.acmeShopWp;
const GIB = 1024n ** 3n;
// A server administrator who is also a member of the organisation with the owner's role.
const ADMIN_MEMBER = "usr_admin_member";
// A site with no type, through the generic route (#116).
const SITE_BODY = { name: "Generic Site", slug: "generic-site", hostAllocationId: DEMO_IDS.allocations.acme, initialDomain: "generic.example.test" };
// The typed route's answer for an address another site or a server already has.
const TAKEN = "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.";

// R207 orgs.2, orgs.3 and addendum 4 A: the organisation check first, then the server administrator's permission.
describe("generic service routes and invitations are for the server administrator only", () => {
  let app: ControlPlaneAppHandle;
  const tokens: Record<string, string> = {};
  let seq = 0;

  async function call(user: string, path: string, body: unknown): Promise<{ status: number; body: Json }> {
    seq += 1;
    const res = await fetch(`${app.baseUrl!}/v1/organizations/${ORG}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens[user]}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `idem_admin_only_${seq}`,
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const countOf = async (rows: Promise<unknown[]>) => (await rows).length;
  const stored = async () => ({
    services: await countOf(app.dbClient.db.select().from(serviceInstances)),
    revisions: await countOf(app.dbClient.db.select().from(stackRevisions)),
    memberships: await countOf(app.dbClient.db.select().from(memberships)),
    users: await countOf(app.dbClient.db.select().from(users)),
    sites: await countOf(app.dbClient.db.select().from(sites)),
    domains: await countOf(app.dbClient.db.select().from(domains)),
  });
  const rowsOf = (userId: string) => app.dbClient.db.select().from(auditEvents).where(eq(auditEvents.actorId, userId));
  const deniedRows = async (userId: string) =>
    (await rowsOf(userId)).filter((row) => (row.details as Json | null)?.outcome === "denied").length;
  const visit = (expiresAt: Date) =>
    app.dbClient.db.insert(supportAccessGrants).values({
      id: `sag_admin_only_${++seq}`,
      organizationId: ORG,
      operatorUserId: DEMO_IDS.users.infra,
      approvedByUserId: DEMO_IDS.users.infra,
      permissions: [...SUPPORT_ACCESS_PERMISSIONS],
      reason: "sentinel visit",
      expiresAt,
    });

  beforeAll(async () => {
    app = await createControlPlaneApp({ seedPhase1: true, host: "127.0.0.1", port: 0, listen: true, enableDevOidc: true });
    await app.dbClient.db.insert(users).values({
      id: ADMIN_MEMBER,
      email: "admin-member@example.test",
      name: "Admin member",
      userStatus: "active",
      platformRole: "infrastructure_admin",
    });
    await app.dbClient.db.insert(memberships).values({ id: "mem_admin_member", organizationId: ORG, userId: ADMIN_MEMBER });
    await app.dbClient.db
      .insert(membershipRoles)
      .values({ id: "mr_admin_member_owner", membershipId: "mem_admin_member", roleId: DEMO_IDS.roles.customer_owner });
    for (const userId of [DEMO_IDS.users.infra, DEMO_IDS.users.elena, DEMO_IDS.users.marco, DEMO_IDS.users.giulia, ADMIN_MEMBER]) {
      const res = await fetch(`${app.baseUrl!}/v1/dev/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      tokens[userId] = ((await res.json()) as Json).data.accessToken as string;
    }
  });

  afterEach(async () => {
    await app.dbClient.db.delete(supportAccessGrants);
  });

  afterAll(async () => {
    await app.close();
  });

  const refused: Array<[string, string, unknown]> = [
    // An empty body would be a 400 if it were read: the 403 comes first.
    ["a service", `/sites/${SITE}/services`, {}],
    ["a service with a valid body", `/sites/${SITE}/services`, {
      serviceTemplateId: DEMO_IDS.templates.nodejs,
      name: "Customer App",
      configuration: { image: "nginx:latest" },
    }],
    ["a revision", `/services/${SERVICE}/revisions`, {}],
    ["a revision with a valid body", `/services/${SERVICE}/revisions`, { declarativeConfig: { WP_DEBUG: "false" } }],
    ["an invitation", "/invitations", { email: "new-member@example.test", role: "customer_collaborator" }],
    ["a site", "/sites", {}],
    ["a site with a valid body", "/sites", SITE_BODY],
  ];

  for (const [what, path, body] of refused) {
    for (const user of [DEMO_IDS.users.elena, DEMO_IDS.users.marco]) {
      it(`refuses ${what} to ${user} with 403, stores nothing and writes one refused row`, async () => {
        const before = await stored();
        const deniedBefore = await deniedRows(user);
        const res = await call(user, path, body);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("PERMISSION_DENIED");
        expect(await stored()).toEqual(before);
        expect(await deniedRows(user)).toBe(deniedBefore + 1);
      });
    }
  }

  // The three routes with a valid body, and the key of each one's organisation check.
  const routes: Array<[string, string, string, unknown]> = [
    ["a service", "service.create", `/sites/${SITE}/services`, {
      serviceTemplateId: DEMO_IDS.templates.nodejs,
      name: "Customer App",
      configuration: { image: "nginx:latest" },
    }],
    ["a revision", "service.configuration.manage", `/services/${SERVICE}/revisions`, { declarativeConfig: { WP_DEBUG: "false" } }],
    ["an invitation", "organization.members.manage", "/invitations", { email: "visit-member@example.test", role: "customer_collaborator" }],
    ["a site", "site.create", "/sites", SITE_BODY],
  ];

  /** Calls the route and returns the answer with the actor's new audit rows. */
  async function answer(user: string, path: string, body: unknown) {
    const seen = new Set((await rowsOf(user)).map((row) => row.id));
    const before = await stored();
    const res = await call(user, path, body);
    expect(await stored()).toEqual(before);
    return { ...res, rows: (await rowsOf(user)).filter((row) => !seen.has(row.id)) };
  }

  for (const [what, key, path, body] of routes) {
    it(`hides ${what} with 404 and no row from another customer, and from an administrator with no visit or a closed one`, async () => {
      const outsider = await answer(DEMO_IDS.users.giulia, path, body);
      expect([outsider.status, outsider.body.error?.code, outsider.rows.length]).toEqual([404, "NOT_FOUND", 0]);
      const noVisit = await answer(DEMO_IDS.users.infra, path, body);
      expect([noVisit.status, noVisit.body.error?.code, noVisit.rows.length]).toEqual([404, "NOT_FOUND", 0]);
      await visit(new Date(Date.now() + 60_000));
      await app.dbClient.db.delete(supportAccessGrants);
      const closed = await answer(DEMO_IDS.users.infra, path, body);
      expect([closed.status, closed.body.error?.code, closed.rows.length]).toEqual([404, "NOT_FOUND", 0]);
    });

    it(`refuses ${what} with 403 and the organisation check's one row to an administrator whose visit ran out`, async () => {
      await visit(new Date(Date.now() - 1000));
      const res = await answer(DEMO_IDS.users.infra, path, body);
      expect([res.status, res.body.error?.code, res.rows.length]).toEqual([403, "PERMISSION_DENIED", 1]);
      expect(res.rows[0]!.action).toBe(key);
    });

    // site.create is one of a visit's permissions (the typed route needs it), and the site route refuses the visit all the same.
    it(`refuses ${what} with 403 and one SUPPORT_ACCESS_PERMISSION_DENIED row to an administrator on an open visit`, async () => {
      await visit(new Date(Date.now() + 60_000));
      const res = await answer(DEMO_IDS.users.infra, path, body);
      expect([res.status, res.body.error?.code, res.rows.length]).toEqual([403, "PERMISSION_DENIED", 1]);
      expect([res.rows[0]!.action, (res.rows[0]!.details as Json).reason]).toEqual([key, "SUPPORT_ACCESS_PERMISSION_DENIED"]);
    });

    it(`refuses ${what} with 403 and one row of the server administrator's permission to the customer owner`, async () => {
      const res = await answer(DEMO_IDS.users.elena, path, body);
      expect([res.status, res.body.error?.code, res.rows.length]).toEqual([403, "PERMISSION_DENIED", 1]);
      expect(res.rows[0]!.action).toBe("platform.users.manage");
    });
  }

  it("stores an administrator's first domain of a site the way the typed route writes it (L43)", async () => {
    for (const [slug, initialDomain, hostname] of [
      ["generic-case", "  Generic-Admin.Example.TEST. ", "generic-admin.example.test"],
      ["generic-idn", "Bücher.example.test", "xn--bcher-kva.example.test"],
    ]) {
      const created = await call(ADMIN_MEMBER, "/sites", { ...SITE_BODY, slug, initialDomain });
      expect(created.status).toBe(201);
      expect(created.body.data.domains.map((d: Json) => d.hostname)).toEqual([hostname]);
      const rows = await app.dbClient.db.select().from(domains).where(eq(domains.siteId, created.body.data.id as string));
      expect(rows.map((row) => row.hostname)).toEqual([hostname]);
    }
  });

  it("refuses an administrator's first domain the typed route refuses, with the typed route's error, and stores nothing (L43)", async () => {
    const before = await stored();
    for (const initialDomain of ["bad_name.example.test", "192.168.10.11", "nodot"]) {
      const res = await call(ADMIN_MEMBER, "/sites", { ...SITE_BODY, slug: "generic-refused", initialDomain });
      expect([initialDomain, res.status, res.body.error?.code]).toEqual([initialDomain, 400, "VALIDATION_ERROR"]);
    }
    // Another site's address in another case, and a server's own name.
    for (const initialDomain of ["NEGOZIO.acme.it", "node-acme.internal"]) {
      const res = await call(ADMIN_MEMBER, "/sites", { ...SITE_BODY, slug: "generic-taken", initialDomain });
      expect([initialDomain, res.status, res.body.error?.code, res.body.error?.message]).toEqual([initialDomain, 409, "DOMAIN_CONFLICT", TAKEN]);
    }
    expect(await stored()).toEqual(before);
  });

  it("lets an administrator who is also an owner create a service and a revision", async () => {
    const created = await call(ADMIN_MEMBER, `/sites/${SITE}/services`, {
      serviceTemplateId: DEMO_IDS.templates.nodejs,
      name: "Admin App",
      configuration: { image: "nginx:latest" },
      resourceLimits: { cpuMilli: 1000, memoryBytes: String(GIB) },
    });
    expect(created.status).toBe(201);
    const revision = await call(ADMIN_MEMBER, `/services/${created.body.data.service.id}/revisions`, {
      declarativeConfig: { image: "nginx:latest" },
      resourceLimits: { cpuMilli: 2000, memoryBytes: String(2n * GIB) },
    });
    expect(revision.status).toBe(201);
    expect(revision.body.data.revisionNumber).toBe(2);
  });

  it("refuses a revision above the ceiling with VALIDATION_ERROR and stores nothing", async () => {
    const before = await stored();
    const memory = await call(ADMIN_MEMBER, `/services/${SERVICE}/revisions`, {
      declarativeConfig: { WP_DEBUG: "false" },
      resourceLimits: { cpuMilli: 1000, memoryBytes: String(64n * GIB + 1n) },
    });
    expect(memory.status).toBe(400);
    expect(memory.body.error.code).toBe("VALIDATION_ERROR");
    const cpu = await call(ADMIN_MEMBER, `/services/${SERVICE}/revisions`, {
      declarativeConfig: { WP_DEBUG: "false" },
      resourceLimits: { cpuMilli: 64_001, memoryBytes: String(GIB) },
    });
    expect(cpu.status).toBe(400);
    expect(cpu.body.error.code).toBe("VALIDATION_ERROR");
    expect(await stored()).toEqual(before);
  });

  it("lets an administrator who is also an owner invite a new account, and answers 409 for an account that is already a member", async () => {
    const invited = await call(ADMIN_MEMBER, "/invitations", { email: "invited@example.test", role: "customer_collaborator" });
    expect(invited.status).toBe(201);
    const before = await stored();
    const again = await call(ADMIN_MEMBER, "/invitations", { email: "invited@example.test", role: "customer_owner" });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_EXISTS");
    expect(await stored()).toEqual(before);
  });
});
