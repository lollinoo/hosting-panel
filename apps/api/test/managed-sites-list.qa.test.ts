import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { ManagedSiteDtoSchema, SITE_TYPE_KEYS } from "@hosting-panel/contracts";
import {
  createDatabaseClient,
  domains,
  eq,
  hostAllocations,
  membershipRoles,
  memberships,
  organizations,
  platformInstallations,
  resourceGrants,
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
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const CANARY_PASSWORD = "canary-Pass-123456";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Answer = { status: number; body: Json; raw: string };

describe("QA: GET /v1/organizations/:orgId/managed-sites never leaks and never lies", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let adminSecret: string;
  let ownerToken: string;
  let orgId: string;

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

  async function call(method: string, path: string, as: string | null, body?: unknown): Promise<Answer> {
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
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  /** fetch refuses a body on GET; this sends one anyway. */
  function getWithBody(path: string, as: string, body: string): Promise<Answer> {
    const url = new URL(`${app.baseUrl!}${path}`);
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += String(chunk)));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: raw ? (JSON.parse(raw) as Json) : {}, raw }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }

  async function addMember(org: string, email: string, roleId: string): Promise<{ userId: string; token: string }> {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email, name: email, passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: org, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId });
    return { userId, token: await login(email, PW) };
  }

  /** A second customer: the panel admits one through the API, so its rows are written directly. */
  async function secondOrg(name: string, ownerEmail: string): Promise<{ orgId: string; token: string }> {
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const org = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({ id: org, platformInstallationId: inst!.id, name, slug: `o-${org}` });
    const [first] = await dbClient.db.select().from(hostAllocations).where(eq(hostAllocations.organizationId, orgId)).limit(1);
    // The other organisation needs a host allocation of its own to hold sites.
    await dbClient.db.insert(hostAllocations).values({ ...first!, id: `alloc_${randomUUID()}`, organizationId: org });
    const owner = await addMember(org, ownerEmail, "role_customer_owner");
    return { orgId: org, token: owner.token };
  }

  async function addSite(
    org: string,
    name: string,
    hostnames: readonly string[] = [],
    over: { siteType?: string | null } = {},
  ): Promise<string> {
    const [allocation] = await dbClient.db.select().from(hostAllocations).where(eq(hostAllocations.organizationId, org)).limit(1);
    const id = `site_${randomUUID()}`;
    await dbClient.db.insert(sites).values({
      id,
      organizationId: org,
      hostAllocationId: allocation!.id,
      name,
      slug: `s-${randomUUID()}`,
      phpVersion: "8.4",
      siteType: over.siteType === undefined ? "wordpress" : over.siteType,
    });
    for (const [i, hostname] of hostnames.entries()) {
      await dbClient.db
        .insert(domains)
        .values({ id: `dom_${randomUUID()}`, siteId: id, organizationId: org, hostname, isPrimary: i === 0 });
    }
    return id;
  }

  const list = (as: string | null = ownerToken, org: string = orgId) => call("GET", `/v1/organizations/${org}/managed-sites`, as);
  const getSites = (as: string | null = ownerToken, org: string = orgId) => call("GET", `/v1/organizations/${org}/sites`, as);
  const ids = (a: Answer) => (a.body.data as Json[]).map((r) => r.id as string);
  const openVisit = (siteId: string) => call("POST", `/v1/admin/sites/${siteId}/support-access`, adminToken);
  const closeVisit = () => call("DELETE", "/v1/admin/support-access", adminToken);
  const denyRead = async (userId: string, siteId: string) =>
    dbClient.db.insert(resourceGrants).values({
      id: `rg_${randomUUID()}`,
      organizationId: orgId,
      principalUserId: userId,
      resourceId: siteId,
      permission: "site.read",
      effect: "deny",
    });

  /** The two answers of one caller must agree on status and error code. */
  const sameRefusal = (a: Answer, b: Answer) => {
    expect(a.status).toBe(b.status);
    expect(a.body.error?.code).toBe(b.body.error?.code);
  };

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    adminSecret = admin.totpSecretBase32;
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
    adminToken = await login("admin@x.it", PW, adminSecret);
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: "Hotel Mario",
      ownerEmail: "mario@hotel.it",
      ownerName: "Mario",
    });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgId = created.body.data.organizationId as string;
    ownerToken = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("what each role of the organisation sees, against GET …/sites", () => {
    it("owner, hosting administrator and denied callers: the list is the managed part of what …/sites shows them", async () => {
      const a = await addSite(orgId, "Alpha", ["alpha.it"]);
      const b = await addSite(orgId, "Beta", ["beta.it"]);
      const c = await addSite(orgId, "Gamma", ["gamma.it"]);
      const foreign = await addSite(orgId, "Delta generic", ["delta.it"], { siteType: "nodejs" });
      const untyped = await addSite(orgId, "Epsilon untyped", [], { siteType: null });

      const hosting = await addMember(orgId, "hosting@hotel.it", "role_hosting_admin");
      const deniedOwner = await addMember(orgId, "co-owner@hotel.it", "role_customer_owner");
      await denyRead(deniedOwner.userId, b);
      await denyRead(hosting.userId, c);

      const table: Array<[string, string, string[]]> = [
        ["owner", ownerToken, [a, b, c]],
        ["hosting administrator denied c", hosting.token, [a, b]],
        ["owner denied b", deniedOwner.token, [a, c]],
      ];
      for (const [who, token, expected] of table) {
        const managed = await list(token);
        const all = await getSites(token);
        // Either the caller may read the organisation's sites (both answer 200) or both refuse alike.
        if (managed.status !== 200 || all.status !== 200) {
          sameRefusal(managed, all);
          continue;
        }
        const allIds = ids(all);
        expect(allIds, `${who}: …/sites carries the non-managed rows`).toEqual(expect.arrayContaining(expected));
        for (const id of ids(managed)) {
          expect(allIds, `${who}: list shows ${id} which …/sites hides`).toContain(id);
        }
        // Row by row: exactly the managed sites this caller may read.
        expect(new Set(ids(managed)), who).toEqual(new Set(expected));
        expect(ids(managed)).not.toContain(foreign);
        expect(ids(managed)).not.toContain(untyped);
      }
      // The owner is the reference: it really sees the three managed sites.
      expect(ids(await list(ownerToken))).toHaveLength(3);
    });

    it("a collaborator with and without a grant gets the very answer of GET …/sites, and never a site …/sites hides", async () => {
      const granted = await addSite(orgId, "Granted", ["granted.it"]);
      const other = await addSite(orgId, "Other", ["other.it"]);
      const withGrant = await addMember(orgId, "with@hotel.it", "role_customer_collaborator");
      await dbClient.db.insert(resourceGrants).values({
        id: `rg_${randomUUID()}`,
        organizationId: orgId,
        principalUserId: withGrant.userId,
        resourceId: granted,
        permission: "site.read",
      });
      const without = await addMember(orgId, "without@hotel.it", "role_customer_collaborator");

      for (const [who, token] of [
        ["collaborator with a grant", withGrant.token],
        ["collaborator without a grant", without.token],
      ] as const) {
        const managed = await list(token);
        const all = await getSites(token);
        expect(managed.status, who).toBe(all.status);
        sameRefusal(managed, all);
        if (managed.status === 200) {
          for (const id of ids(managed)) expect(ids(all), who).toContain(id);
          expect(ids(managed), who).not.toContain(other);
        } else {
          expect(managed.raw, `${who}: a refusal carries no site`).not.toContain("site_");
        }
      }
    });
  });

  describe("who is refused, and how", () => {
    it("a member of another organisation, an anonymous caller and a bad token get the status and code of …/sites", async () => {
      await addSite(orgId, "Hotel", ["hotel.it"]);
      const luigi = await secondOrg("Hotel Luigi", "luigi@hotel.it");
      const table: Array<[string, string | null]> = [
        ["member of another organisation", luigi.token],
        ["anonymous", null],
        ["garbage token", "not-a-token"],
        ["the admin without a visit", adminToken],
      ];
      for (const [who, token] of table) {
        const managed = await list(token);
        const all = await getSites(token);
        sameRefusal(managed, all);
        expect(managed.status, who).not.toBe(200);
        expect(managed.raw, `${who}: no site, no domain in a refusal`).not.toMatch(/site_|hotel\.it/);
      }
      expect((await list(null)).status).toBe(401);
      expect((await list(luigi.token)).status).toBe(404);
    });

    it("an organisation that does not exist answers as …/sites does, for the owner and the stranger alike", async () => {
      const luigi = await secondOrg("Hotel Luigi", "luigi@hotel.it");
      for (const missing of [`org_${randomUUID()}`, "org_missing", "..%2F..%2Fv1%2Fme", "%00"]) {
        for (const token of [ownerToken, luigi.token, adminToken]) {
          const managed = await list(token, missing);
          const all = await getSites(token, missing);
          sameRefusal(managed, all);
          expect(managed.status, `${missing}`).toBe(404);
        }
      }
      // A stranger asking for a real org and a missing one learns nothing from the difference.
      const real = await list(luigi.token, orgId);
      const none = await list(luigi.token, `org_${randomUUID()}`);
      expect(real.status).toBe(none.status);
      expect(real.body.error?.code).toBe(none.body.error?.code);
    });

    it("a suspended organisation answers exactly as GET …/sites", async () => {
      const site = await addSite(orgId, "Hotel", ["hotel.it"]);
      await dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, orgId));
      const managed = await list();
      const all = await getSites();
      expect(managed.status).toBe(all.status);
      expect(managed.body.error?.code).toBe(all.body.error?.code);
      if (managed.status === 200) expect(ids(managed)).toEqual([site]);
    });
  });

  describe("the primary domain of a row", () => {
    it("is the primary one only, never a secondary and never another organisation's hostname for a site of the same name", async () => {
      const mine = await addSite(orgId, "Hotel", ["hotel.it", "www.hotel.it", "old.hotel.it"]);
      const luigi = await secondOrg("Hotel Luigi", "luigi@hotel.it");
      const theirs = await addSite(luigi.orgId, "Hotel", ["luigi-hotel.it"]);

      const rows = (await list()).body.data as Json[];
      expect(rows.map((r) => [r.id, r.primaryDomain])).toEqual([[mine, "hotel.it"]]);
      const luigiRows = (await list(luigi.token, luigi.orgId)).body.data as Json[];
      expect(luigiRows.map((r) => [r.id, r.primaryDomain])).toEqual([[theirs, "luigi-hotel.it"]]);
      expect((await list()).raw).not.toContain("luigi");
      expect((await list(luigi.token, luigi.orgId)).raw).not.toMatch(/"hotel\.it"|www\.hotel\.it|mario/);
    });

    it("is null once the primary domain is removed, and a lone secondary does not stand in for it", async () => {
      const removed = await addSite(orgId, "Removed", ["gone.it"]);
      const lone = await addSite(orgId, "Lone secondary", ["x.it"]);
      await dbClient.db.update(domains).set({ isPrimary: false }).where(eq(domains.siteId, lone));
      expect(((await list()).body.data as Json[]).map((r) => [r.id, r.primaryDomain])).toEqual([
        [lone, null],
        [removed, "gone.it"],
      ]);
      await dbClient.db.delete(domains).where(eq(domains.siteId, removed));
      expect(((await list()).body.data as Json[]).map((r) => [r.id, r.primaryDomain])).toEqual([
        [lone, null],
        [removed, null],
      ]);
    });

    it("a site with several domains is one row, not one per domain", async () => {
      const id = await addSite(orgId, "Many", ["a.it", "b.it", "c.it", "d.it"]);
      expect(ids(await list())).toEqual([id]);
    });
  });

  describe("which sites are listed", () => {
    it("only the managed site types: any other type string, or none, is left out while …/sites may carry it", async () => {
      const kept = await addSite(orgId, "Kept", ["kept.it"], { siteType: SITE_TYPE_KEYS[0] });
      const left = [];
      for (const [i, siteType] of ["nodejs", "WordPress", "", "app_stack", null].entries()) {
        left.push(await addSite(orgId, `Left ${i}`, [`left${i}.it`], { siteType }));
      }
      const managed = ids(await list());
      expect(managed).toEqual([kept]);
      for (const id of left) expect(managed).not.toContain(id);
      expect(ids(await getSites())).toEqual(expect.arrayContaining(managed));
    });

    it("nothing of another organisation, nor of the panel's own, ever appears", async () => {
      const luigi = await secondOrg("Hotel Luigi", "luigi@hotel.it");
      await addSite(luigi.orgId, "Theirs", ["theirs.it"]);
      const mine = await addSite(orgId, "Mine", ["mine.it"]);
      const unassigned = await call("POST", "/v1/admin/sites", adminToken, {
        name: "Unassigned",
        domain: "unassigned.it",
        title: "U",
        adminUser: "siteadmin",
        adminEmail: "wp@unassigned.it",
        adminPassword: CANARY_PASSWORD,
        ownerOrganizationId: null,
      });
      expect(unassigned.status).toBe(202);
      const res = await list();
      expect(ids(res)).toEqual([mine]);
      expect(res.raw).not.toMatch(/theirs\.it|unassigned/i);
    });
  });

  describe("inputs the route must ignore", () => {
    it("a query string changes nothing, whatever it says", async () => {
      await addSite(orgId, "Alpha", ["alpha.it"]);
      await addSite(orgId, "Beta", ["beta.it"]);
      const plain = await list();
      for (const qs of [
        "?limit=1",
        "?cursor=abc&limit=0",
        "?organizationId=org_other",
        "?siteType=nodejs",
        "?status=stopped&q=zzz",
        "?limit=-1&limit=2",
        "?__proto__[x]=1",
      ]) {
        const res = await call("GET", `/v1/organizations/${orgId}/managed-sites${qs}`, ownerToken);
        expect(res.status, qs).toBe(200);
        expect(res.body.data, qs).toEqual(plain.body.data);
      }
    });

    it("a request body is ignored: same rows, no write, and no way to name another organisation", async () => {
      const mine = await addSite(orgId, "Mine", ["mine.it"]);
      const luigi = await secondOrg("Hotel Luigi", "luigi@hotel.it");
      await addSite(luigi.orgId, "Theirs", ["theirs.it"]);
      const before = (await list()).body.data;
      const rowsBefore = await dbClient.db.select().from(sites);

      for (const body of [
        JSON.stringify({ organizationId: luigi.orgId, siteIds: [], limit: 1 }),
        JSON.stringify({ name: "x", siteType: "nodejs" }),
        JSON.stringify([]),
      ]) {
        const res = await getWithBody(`/v1/organizations/${orgId}/managed-sites`, ownerToken, body);
        expect(res.status, body).toBe(200);
        expect(res.body.data, body).toEqual(before);
        expect(ids(res)).toEqual([mine]);
      }
      expect(await dbClient.db.select().from(sites)).toEqual(rowsBefore);
    });

    it("the other verbs on the collection are not served by this route", async () => {
      await addSite(orgId, "Mine", ["mine.it"]);
      for (const method of ["PUT", "PATCH", "DELETE"]) {
        const res = await call(method, `/v1/organizations/${orgId}/managed-sites`, ownerToken, {});
        expect([404, 405], `${method}`).toContain(res.status);
      }
      expect(await dbClient.db.select().from(sites)).toHaveLength(1);
    });
  });

  describe("what a row carries", () => {
    it("has no field beyond ManagedSiteDto and no host address, secret or database name anywhere in the body", async () => {
      // A real provisioned site: it gets a database, a secret and a host.
      const created = await call("POST", `/v1/organizations/${orgId}/managed-sites`, ownerToken, {
        name: "Hotel Bella",
        domain: "hotel.it",
        title: "Hotel Bella Vista",
        adminUser: "wpadmin",
        adminEmail: "admin@hotel.it",
        adminPassword: CANARY_PASSWORD,
      });
      expect(created.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      await addSite(orgId, "Plain", ["plain.it"]);

      const res = await list();
      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(["data"]);
      expect(res.body.data).toHaveLength(2);
      for (const row of res.body.data as Json[]) {
        expect(Object.keys(row).sort()).toEqual(Object.keys(ManagedSiteDtoSchema.shape).sort());
        expect(ManagedSiteDtoSchema.strict().safeParse(row).success).toBe(true);
      }
      const { siteDatabases } = await import("@hosting-panel/database");
      const dbRows = await dbClient.db.select().from(siteDatabases);
      const forbidden = [
        "10.0.0.1",
        "panel.test",
        CANARY_PASSWORD,
        "wpadmin",
        "admin@hotel.it",
        "passwordHash",
        "secret",
        ...dbRows.flatMap((r) => [r.dbName, r.dbUser].filter((v): v is string => typeof v === "string" && v.length > 3)),
      ];
      for (const needle of forbidden) {
        expect(res.raw, `body leaks ${needle}`).not.toContain(needle);
      }
    });
  });

  describe("a server administrator", () => {
    it("in a support visit sees what the customer sees; without one (or after it) gets what …/sites gives", async () => {
      const a = await addSite(orgId, "Alpha", ["alpha.it"]);
      const b = await addSite(orgId, "Beta", ["beta.it"]);
      await addSite(orgId, "Generic", ["generic.it"], { siteType: "nodejs" });
      const customer = await list();
      expect(ids(customer)).toEqual([a, b]);

      const before = await list(adminToken);
      sameRefusal(before, await getSites(adminToken));
      expect(before.status).toBe(404);

      expect((await openVisit(a)).status).toBe(201);
      const during = await list(adminToken);
      expect(during.status).toBe(200);
      expect(during.body.data).toEqual(customer.body.data);
      for (const id of ids(during)) expect(ids(await getSites(adminToken))).toContain(id);

      // The visit is scoped to the one organisation: another organisation stays hidden.
      const luigi = await secondOrg("Hotel Luigi", "luigi@hotel.it");
      await addSite(luigi.orgId, "Theirs", ["theirs.it"]);
      const elsewhere = await list(adminToken, luigi.orgId);
      sameRefusal(elsewhere, await getSites(adminToken, luigi.orgId));
      expect(elsewhere.status).toBe(404);

      expect((await closeVisit()).status).toBe(204);
      const after = await list(adminToken);
      sameRefusal(after, await getSites(adminToken));
      expect(after.status).toBe(404);
    });

    it("an expired visit answers as …/sites does", async () => {
      const a = await addSite(orgId, "Alpha", ["alpha.it"]);
      expect((await openVisit(a)).status).toBe(201);
      const { supportAccessGrants } = await import("@hosting-panel/database");
      await dbClient.db.update(supportAccessGrants).set({ expiresAt: new Date(Date.now() - 1000) });
      const managed = await list(adminToken);
      const all = await getSites(adminToken);
      sameRefusal(managed, all);
      expect(managed.status).not.toBe(200);
      expect(managed.raw).not.toContain(a);
    });
  });
});
