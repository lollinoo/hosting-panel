import { randomUUID } from "node:crypto";
import { ManagedSiteDtoSchema } from "@hosting-panel/contracts";
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

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("GET /v1/organizations/:orgId/managed-sites", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let token: string;
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
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, as: string = token, body?: unknown): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  /** The owner of a second organisation (the panel admits one customer through the API, so its rows are written directly). */
  async function stranger(): Promise<string> {
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const org = `org_${randomUUID()}`;
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({ id: org, platformInstallationId: inst!.id, name: "Hotel Luigi", slug: `luigi-${org}` });
    await dbClient.db.insert(users).values({ id: userId, email: "luigi@hotel.it", name: "Luigi", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: org, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_owner" });
    return login("luigi@hotel.it", PW);
  }

  /** A site row written directly; `hostnames[0]` is the main web address. */
  async function addSite(
    org: string,
    name: string,
    hostnames: readonly string[] = [],
    over: { id?: string; siteType?: string | null } = {},
  ): Promise<string> {
    const [allocation] = await dbClient.db.select().from(hostAllocations).where(eq(hostAllocations.organizationId, org)).limit(1);
    const id = over.id ?? `site_${randomUUID()}`;
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

  async function addCollaborator(grantOn?: string): Promise<string> {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email: "collab@hotel.it", name: "Collab", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
    if (grantOn) {
      await dbClient.db
        .insert(resourceGrants)
        .values({ id: `rg_${randomUUID()}`, organizationId: orgId, principalUserId: userId, resourceId: grantOn, permission: "site.read" });
    }
    return login("collab@hotel.it", PW);
  }

  const list = (as: string = token, org: string = orgId) => call("GET", `/v1/organizations/${org}/managed-sites`, as);
  const getSites = (as: string = token, org: string = orgId) => call("GET", `/v1/organizations/${org}/sites`, as);
  const getOne = (siteId: string, as: string = token) => call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}`, as);

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
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: "Hotel Mario",
      ownerEmail: "mario@hotel.it",
      ownerName: "Mario",
    });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgId = created.body.data.organizationId as string;
    token = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("lists the organisation's WordPress sites with their main web address, by name then id, rows as on GET :siteId", async () => {
    const beta = await addSite(orgId, "Beta", ["beta.it", "www.beta.it"]);
    const alpha = await addSite(orgId, "Alpha");
    const gammaB = await addSite(orgId, "Gamma", ["gamma-b.it"], { id: "site_b" });
    const gammaA = await addSite(orgId, "Gamma", ["gamma-a.it"], { id: "site_a" });
    await addSite(orgId, "Aaa generic", [], { siteType: null });
    // An unassigned site lives in the panel's own organisation.
    const unassigned = await call("POST", "/v1/admin/sites", adminToken, {
      name: "Aaa other",
      domain: "other.it",
      title: "Other",
      adminUser: "siteadmin",
      adminEmail: "wp@other.it",
      adminPassword: "canary-Pass-123456",
      ownerOrganizationId: null,
    });
    expect(unassigned.status).toBe(202);

    const res = await list();
    expect(res.status).toBe(200);
    const rows = res.body.data as Json[];
    expect(rows.map((r) => [r.id, r.primaryDomain])).toEqual([
      [alpha, null],
      [beta, "beta.it"],
      [gammaA, "gamma-a.it"],
      [gammaB, "gamma-b.it"],
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(ManagedSiteDtoSchema.shape).sort());
      expect(ManagedSiteDtoSchema.strict().parse(row)).toEqual(row);
      expect(row).toEqual((await getOne(row.id as string)).body.data);
    }
  });

  it("a stopped site reads as on GET :siteId", async () => {
    const created = await call("POST", `/v1/organizations/${orgId}/managed-sites`, token, {
      name: "Hotel Bella",
      domain: "hotel.it",
      title: "Hotel Bella Vista",
      adminUser: "admin",
      adminEmail: "admin@hotel.it",
      adminPassword: "canary-Pass-123456",
    });
    expect(created.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const siteId = created.body.data.siteId as string;
    expect((await call("POST", `/v1/organizations/${orgId}/managed-sites/${siteId}/actions`, token, { action: "stop" })).status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const [row] = (await list()).body.data as Json[];
    expect(row!.status).toBe("stopped");
    expect(row).toEqual((await getOne(siteId)).body.data);
  });

  it("a stranger gets 404 and a member without site.read 403, exactly as GET …/sites", async () => {
    const site = await addSite(orgId, "Hotel", ["hotel.it"]);
    const outsider = await stranger();
    expect((await list(outsider)).status).toBe(404);
    expect((await getSites(outsider)).status).toBe(404);

    // A per-site grant does not give the organisation-wide site.read both lists require.
    const collab = await addCollaborator(site);
    expect((await list(collab)).status).toBe(403);
    expect((await getSites(collab)).status).toBe(403);
    expect((await getOne(site, collab)).status).toBe(200);
  });

  it("a member denied site.read on one site does not see it, as on GET …/sites", async () => {
    const hidden = await addSite(orgId, "Hidden", ["hidden.it"]);
    const shown = await addSite(orgId, "Shown", ["shown.it"]);
    const [owner] = await dbClient.db.select().from(users).where(eq(users.email, "mario@hotel.it"));
    await dbClient.db.insert(resourceGrants).values({
      id: `rg_${randomUUID()}`,
      organizationId: orgId,
      principalUserId: owner!.id,
      resourceId: hidden,
      permission: "site.read",
      effect: "deny",
    });

    expect((await list()).body.data.map((r: Json) => r.id)).toEqual([shown]);
    expect((await getSites()).body.data.map((r: Json) => r.id)).toEqual([shown]);
  });
});
