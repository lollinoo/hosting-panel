import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  domains,
  eq,
  hostAllocations,
  hosts,
  inArray,
  membershipRoles,
  memberships,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  rolePermissions,
  sites,
  tlsCertificateVersions,
  tlsCertificates,
  tlsPublishState,
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

// HCP-SPEC-004 (TLS-04/05/07) API side: what the domain and site services do around manual certificates, on a
// simulated host with two customer organisations. Domain rows flip only when a site.tls.apply settles, so these
// tests plant manual rows directly and look at what the services enqueue, refuse and bump.
const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const siteBody = (name: string, domain: string, extra: object = {}) => ({
  name,
  domain,
  title: `${name} title`,
  adminUser: "admin",
  adminEmail: `admin@${domain}`,
  adminPassword: "canary-Pass-123456",
  ...extra,
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("manual TLS side effects of the domain and site services", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let tokenA: string;
  let tokenB: string;
  let orgA: string;
  let orgB: string;
  let siteA: string;
  let siteB: string;

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

  async function call(method: string, path: string, body?: unknown, as: string = tokenA) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function customer(name: string, email: string) {
    const created = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: name, ownerEmail: email, ownerName: name },
      adminToken,
    );
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, email);
    const token = await login(email, created.body.data.temporaryPassword as string);
    return { orgId: created.body.data.organizationId as string, token };
  }

  /** A second organisation on its own dedicated host, as a simulated two-tenant installation. */
  async function secondCustomer(name: string, email: string) {
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const hostId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostId,
      platformInstallationId: inst!.id,
      name: "panel-b.test",
      hostname: "panel-b.test",
      ipv4Address: "10.0.0.3",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    const orgId = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({ id: orgId, platformInstallationId: inst!.id, name, slug: "bar-sport-org" });
    await dbClient.db.insert(hostAllocations).values({ id: `alloc_${randomUUID()}`, hostId, organizationId: orgId, status: "active" });
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email, name, passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_owner" });
    return { orgId, token: await login(email, PW) };
  }

  async function newSite(orgId: string, token: string, name: string, domain: string, extra: object = {}) {
    const res = await call("POST", `/v1/organizations/${orgId}/managed-sites`, siteBody(name, domain, extra), token);
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.siteId as string;
  }

  const base = (org: string, site: string) => `/v1/organizations/${org}/managed-sites/${site}`;
  const addDomain = (body: object, as = tokenA, org = orgA, site = siteA) => call("POST", `${base(org, site)}/domains`, body, as);
  const domainRow = async (hostname: string) =>
    (await dbClient.db.select().from(domains).where(eq(domains.hostname, hostname)))[0];
  const generation = async () => (await dbClient.db.select().from(tlsPublishState))[0]!.desiredGeneration;
  const tlsOps = () => dbClient.db.select().from(operations).where(eq(operations.kind, "site.tls.apply"));

  async function importVersion(
    organizationId: string,
    sanDns: string[],
    over: { status?: "pending" | "inactive" | "applying" | "active" | "failed"; siteId?: string; notAfterDays?: number } = {},
  ) {
    const certificateId = `cti_${randomUUID().replace(/-/g, "")}`;
    const versionId = `ctv_${randomUUID().replace(/-/g, "")}`;
    await dbClient.db.insert(tlsCertificates).values({ id: certificateId, organizationId, name: "cert", createdForSiteId: over.siteId ?? null });
    await dbClient.db.insert(tlsCertificateVersions).values({
      id: versionId,
      certificateId,
      organizationId,
      versionNumber: 1,
      leafPem: "LEAF",
      chainPem: "",
      keyCiphertextBase64: "k",
      keyIvBase64: "i",
      keyAuthTagBase64: "t",
      subject: `CN=${sanDns[0]!}`,
      issuer: "CN=CA",
      serialNumber: "01",
      fingerprintSha256: randomUUID().replace(/-/g, "").repeat(2),
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + (over.notAfterDays ?? 60) * 86_400_000),
      sanDns,
      keyType: "ec",
      keyBits: 256,
      status: over.status ?? "inactive",
    });
    return { certificateId, versionId };
  }

  const makeManual = (hostname: string, versionId: string, certStatus: "none" | "requested" | "active" | "failed" = "active") =>
    dbClient.db
      .update(domains)
      .set({ certMode: "manual", manualCertificateVersionId: versionId, certStatus })
      .where(eq(domains.hostname, hostname));

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    app = await createControlPlaneApp({
      dnsLookup: { lookup: async () => ({ a: [], aaaa: [] }) },
      domainReconcileIntervalMs: null,
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
    ({ orgId: orgA, token: tokenA } = await customer("Hotel Mario", "mario@hotel.it"));
    ({ orgId: orgB, token: tokenB } = await secondCustomer("Bar Sport Org", "luigi@bar.it"));
    siteA = await newSite(orgA, tokenA, "Hotel Bella", "hotel.it", { includeWww: true });
    siteB = await newSite(orgB, tokenB, "Bar Sport", "bar.it");
    // The sites are provisioned: their addresses are routed.
    await dbClient.db.update(domains).set({ status: "active" });
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("domain add", () => {
    it("with a tlsVersionId inserts the domain and queues the assigning site.tls.apply in the same transaction", async () => {
      const { versionId } = await importVersion(orgA, ["shop.hotel.it"]);
      const res = await addDomain({ hostname: "shop.hotel.it", tlsVersionId: versionId });
      expect(res.body.error ?? null).toBeNull();
      expect(res.status).toBe(201);
      const row = (await domainRow("shop.hotel.it"))!;
      // Rows flip at settle: the domain is still automatic and the version is applying.
      expect(row.certMode).toBe("acme");
      expect(res.body.data.domains.find((d: Json) => d.hostname === "shop.hotel.it").tls.mode).toBe("acme");
      const [op] = await tlsOps();
      expect(op).toMatchObject({ organizationId: orgA, resourceType: "site", resourceId: siteA, lockKey: `site:${siteA}` });
      const [event] = await dbClient.db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "operation.queued.site.tls.apply"));
      expect(event!.payload).toMatchObject({ siteId: siteA, changes: [{ domainId: row.id, versionId }] });
      const [version] = await dbClient.db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, versionId));
      expect(version!.status).toBe("applying");
    });

    it("binds the Idempotency-Key to the body: the same body replays, another hostname is IDEMPOTENCY_CONFLICT", async () => {
      const { versionId } = await importVersion(orgA, ["shop.hotel.it", "blog.hotel.it"]);
      const keyed = (body: object) =>
        fetch(`${app.baseUrl!}${base(orgA, siteA)}/domains`, {
          method: "POST",
          headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json", "Idempotency-Key": "dom-add-key-1" },
          body: JSON.stringify(body),
        }).then(async (r) => ({ status: r.status, body: (await r.json()) as Json }));
      expect((await keyed({ hostname: "shop.hotel.it", tlsVersionId: versionId })).status).toBe(201);
      expect(await tlsOps()).toHaveLength(1);
      const replay = await keyed({ hostname: "shop.hotel.it", tlsVersionId: versionId });
      expect(replay.status).toBe(201);
      expect(await tlsOps()).toHaveLength(1);
      const other = await keyed({ hostname: "blog.hotel.it", tlsVersionId: versionId });
      expect([other.status, other.body.error?.code]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
      expect(await domainRow("blog.hotel.it")).toBeUndefined();
      expect(await tlsOps()).toHaveLength(1);
    });

    it("needs site.certificates.manage (403) when it names a certificate, and writes nothing; a plain add needs only site.update", async () => {
      // A role that may edit the site but has no certificate permission.
      await dbClient.db.insert(rolePermissions).values([
        { roleId: "role_customer_collaborator", permissionKey: "site.read" },
        { roleId: "role_customer_collaborator", permissionKey: "site.update" },
      ]);
      const userId = `usr_${randomUUID()}`;
      const membershipId = `mem_${randomUUID()}`;
      await dbClient.db.insert(users).values({ id: userId, email: "editor@hotel.it", name: "Editor", passwordHash: await hashPassword(PW) });
      await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgA, userId });
      await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
      const editor = await login("editor@hotel.it", PW);

      const { versionId } = await importVersion(orgA, ["shop.hotel.it"]);
      const before = (await dbClient.db.select().from(auditEvents)).length;
      const refused = await addDomain({ hostname: "shop.hotel.it", tlsVersionId: versionId }, editor);
      expect([refused.status, refused.body.error?.code]).toEqual([403, "PERMISSION_DENIED"]);
      expect(await domainRow("shop.hotel.it")).toBeUndefined();
      expect(await tlsOps()).toHaveLength(0);
      expect((await dbClient.db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, versionId)))[0]!.status).toBe("inactive");
      expect((await dbClient.db.select().from(auditEvents)).length - before).toBe(1); // only the denial
      expect((await addDomain({ hostname: "plain.hotel.it" }, editor)).status).toBe(201);
    });

    it("audits the assignment as site.tls_certificate.assign with the operation, on the customer and the administrator route", async () => {
      const first = await importVersion(orgA, ["shop.hotel.it"]);
      const res = await addDomain({ hostname: "shop.hotel.it", tlsVersionId: first.versionId });
      expect(res.status).toBe(201);
      const [op] = await tlsOps();
      const row = (await domainRow("shop.hotel.it"))!;
      const [assign] = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.tls_certificate.assign"));
      expect(assign).toMatchObject({ organizationId: orgA, targetType: "site", targetId: siteA, actorType: "user" });
      expect(assign!.details).toMatchObject({
        operationId: op!.id,
        siteId: siteA,
        domainIds: [row.id],
        versionId: first.versionId,
        fromVersionIds: [],
        outcome: "succeeded",
      });
      expect(assign!.actorId).not.toBeNull();

      await dbClient.db.update(operations).set({ status: "succeeded" });
      const second = await importVersion(orgA, ["admin.hotel.it"]);
      const viaAdmin = await call("POST", `/v1/admin/sites/${siteA}/domains`, { hostname: "admin.hotel.it", tlsVersionId: second.versionId }, adminToken);
      expect(viaAdmin.status).toBe(201);
      const assigns = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.tls_certificate.assign"));
      expect(assigns).toHaveLength(2);
      expect(assigns.find((a) => (a.details as Json).versionId === second.versionId)).toMatchObject({ organizationId: orgA, targetId: siteA });
    });

    it("rolls the audit row back with the domain when the assignment is refused", async () => {
      const { versionId } = await importVersion(orgA, ["*.hotel.it"]);
      const res = await addDomain({ hostname: "shop.hotel.it", tlsVersionId: versionId });
      expect(res.status).toBe(409);
      expect(await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.tls_certificate.assign"))).toHaveLength(0);
    });

    it("refuses a version whose wildcard would also capture another unassigned name of the organisation", async () => {
      const { versionId } = await importVersion(orgA, ["*.hotel.it"]);
      const res = await addDomain({ hostname: "shop.hotel.it", tlsVersionId: versionId });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CERTIFICATE_IN_USE");
      expect(await domainRow("shop.hotel.it")).toBeUndefined();
      expect(await tlsOps()).toHaveLength(0);
    });

    it("refuses a version that does not cover the new name and leaves no domain and no operation", async () => {
      const { versionId } = await importVersion(orgA, ["*.hotel.it"]);
      const res = await addDomain({ hostname: "shop.other.it", tlsVersionId: versionId });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("CERTIFICATE_HOSTNAME_MISMATCH");
      expect(await domainRow("shop.other.it")).toBeUndefined();
      expect(await tlsOps()).toHaveLength(0);
    });

    it("answers 404 for a version of another organisation, with no trace of it", async () => {
      const { versionId } = await importVersion(orgB, ["*.hotel.it"], { status: "inactive" });
      const res = await addDomain({ hostname: "shop.hotel.it", tlsVersionId: versionId });
      expect(res.status).toBe(404);
      expect(res.raw).not.toContain(versionId);
      expect(await domainRow("shop.hotel.it")).toBeUndefined();
    });

    it("refuses a name that a loaded same-organisation certificate would capture, with its own hostname in the details", async () => {
      const { versionId } = await importVersion(orgA, ["*.hotel.it"], { status: "active" });
      await makeManual("www.hotel.it", versionId);
      const res = await addDomain({ hostname: "shop.hotel.it" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CERTIFICATE_IN_USE");
      expect(res.body.error.details).toEqual([expect.objectContaining({ reason: "captures_host", message: "shop.hotel.it" })]);
      expect(await domainRow("shop.hotel.it")).toBeUndefined();
      // The dead end is the point of tlsVersionId: the same name goes through on the loaded version.
      const ok = await addDomain({ hostname: "shop.hotel.it", tlsVersionId: versionId });
      expect(ok.status).toBe(201);
      expect(await tlsOps()).toHaveLength(1);
    });

    it("answers a generic DOMAIN_CONFLICT when another organisation's certificate covers the name, on both routes", async () => {
      const { versionId, certificateId } = await importVersion(orgA, ["*.hotel.it"], { status: "active" });
      await makeManual("www.hotel.it", versionId);
      for (const res of [
        await addDomain({ hostname: "bar.hotel.it" }, tokenB, orgB, siteB),
        await call("POST", `/v1/admin/sites/${siteB}/domains`, { hostname: "bar.hotel.it" }, adminToken),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
        expect(res.raw).not.toContain(versionId);
        expect(res.raw).not.toContain(certificateId);
      }
      expect(await domainRow("bar.hotel.it")).toBeUndefined();
    });

    it("a version that is not published does not block the name", async () => {
      await importVersion(orgA, ["*.hotel.it"], { status: "inactive" });
      expect((await addDomain({ hostname: "bar.hotel.it" }, tokenB, orgB, siteB)).status).toBe(201);
    });
  });

  describe("site create partner", () => {
    it("refuses a www partner covered by another organisation's published certificate and creates nothing", async () => {
      await importVersion(orgA, ["*.newhotel.it"], { status: "active" });
      const res = await call("POST", `/v1/organizations/${orgB}/managed-sites`, siteBody("New", "newhotel.it", { includeWww: true }), tokenB);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
      expect(await domainRow("newhotel.it")).toBeUndefined();
      expect((await dbClient.db.select().from(sites).where(eq(sites.organizationId, orgB))).map((s) => s.name)).toEqual(["Bar Sport"]);
    });

    it("refuses a partner that the organisation's own loaded certificate would capture", async () => {
      await importVersion(orgA, ["*.newhotel.it"], { status: "active" });
      const res = await call("POST", `/v1/organizations/${orgA}/managed-sites`, siteBody("New", "newhotel.it", { includeWww: true }), tokenA);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CERTIFICATE_IN_USE");
      expect(res.body.error.details).toEqual([expect.objectContaining({ reason: "captures_host", message: "www.newhotel.it" })]);
      expect(await domainRow("newhotel.it")).toBeUndefined();
    });
  });

  describe("domain remove and site delete", () => {
    it("removing a manual domain bumps the desired generation; removing an automatic one does not", async () => {
      const { versionId } = await importVersion(orgA, ["www.hotel.it"], { status: "active" });
      await makeManual("www.hotel.it", versionId);
      const before = await generation();
      const acmeDomain = await addDomain({ hostname: "blog.hotel.it" });
      expect(acmeDomain.status).toBe(201);
      const blog = (await domainRow("blog.hotel.it"))!;
      expect((await call("DELETE", `${base(orgA, siteA)}/domains/${blog.id}`)).status).toBe(200);
      expect(await generation()).toBe(before);
      const www = (await domainRow("www.hotel.it"))!;
      expect((await call("DELETE", `${base(orgA, siteA)}/domains/${www.id}`)).status).toBe(200);
      expect(await generation()).toBe(before + 1);
      expect(await domainRow("www.hotel.it")).toBeUndefined();
    });

    it("the delete settle of a site with a manual domain bumps the generation once, a plain site does not", async () => {
      const { versionId } = await importVersion(orgB, ["bar.it"], { status: "active" });
      await makeManual("bar.it", versionId);
      const before = await generation();
      const plain = await call("DELETE", base(orgA, siteA), { confirmName: "Hotel Bella" });
      expect(plain.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      expect(await domainRow("hotel.it")).toBeUndefined();
      expect(await generation()).toBe(before);
      const manual = await call("DELETE", base(orgB, siteB), { confirmName: "Bar Sport" }, tokenB);
      expect(manual.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      expect(await domainRow("bar.it")).toBeUndefined();
      expect(await generation()).toBe(before + 1);
    });
  });

  describe("setChallenge", () => {
    const patch = async (hostname: string, challenge: string) =>
      call("PATCH", `/v1/admin/sites/${siteA}/domains/${(await domainRow(hostname))!.id}`, { challenge }, adminToken);

    it("keeps the failed state of a manual row while an automatic row starts over", async () => {
      const { versionId } = await importVersion(orgA, ["www.hotel.it"], { status: "failed" });
      await makeManual("www.hotel.it", versionId, "failed");
      for (const hostname of ["www.hotel.it", "hotel.it"]) {
        await dbClient.db
          .update(domains)
          .set({ certChallenge: "dns-01", certStatus: "failed", certProblem: "other", certRetryAt: new Date(Date.now() + 3_600_000) })
          .where(eq(domains.hostname, hostname));
        expect((await patch(hostname, "http-01")).status).toBe(200);
      }
      const manual = (await domainRow("www.hotel.it"))!;
      expect(manual).toMatchObject({ certChallenge: "http-01", certStatus: "failed", certProblem: "other", certMode: "manual" });
      expect(manual.certRetryAt).not.toBeNull();
      expect(await domainRow("hotel.it")).toMatchObject({ certChallenge: "http-01", certStatus: "none", certProblem: null, certRetryAt: null });
    });
  });

  describe("owner change", () => {
    const changeOwner = (to: string) => call("POST", `/v1/admin/sites/${siteA}/owner`, { ownerOrganizationId: to }, adminToken);
    const reassignOps = () => dbClient.db.select().from(operations).where(eq(operations.kind, "site.reassign"));

    it("is refused up front with CERTIFICATE_IN_USE while a domain is in manual mode, and queues nothing", async () => {
      const { versionId } = await importVersion(orgA, ["www.hotel.it"], { status: "active" });
      await makeManual("www.hotel.it", versionId);
      const res = await changeOwner(orgB);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CERTIFICATE_IN_USE");
      expect(await reassignOps()).toHaveLength(0);
    });

    it("is refused while a published certificate of the old organisation covers a host of the site", async () => {
      await importVersion(orgA, ["*.hotel.it"], { status: "active" });
      const res = await changeOwner(orgB);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CERTIFICATE_IN_USE");
      expect(await reassignOps()).toHaveLength(0);
    });

    it("goes through when no manual certificate is involved", async () => {
      await importVersion(orgA, ["*.hotel.it"], { status: "inactive" });
      const res = await changeOwner(orgB);
      expect(res.status).toBe(202);
      expect(await reassignOps()).toHaveLength(1);
    });
  });

  describe("certificate alerts", () => {
    it("lists an automatic domain that is about to expire and never a manual one", async () => {
      const { versionId } = await importVersion(orgA, ["www.hotel.it"], { status: "active" });
      await makeManual("www.hotel.it", versionId);
      const soon = new Date(Date.now() + 2 * 86_400_000);
      await dbClient.db.update(domains).set({ certStatus: "active", certExpiresAt: soon }).where(inArray(domains.hostname, ["www.hotel.it", "hotel.it"]));
      const alerts = await app.nestApp.get(ManagedSitesService).certificateAlerts();
      expect(alerts.map((a) => [a.kind, a.hostname])).toEqual([["expiring", "hotel.it"]]);
      // A manual row that carries a stale failure is not a "not issued" alert either.
      await dbClient.db.update(domains).set({ certStatus: "failed", certProblem: "other", certAttempts: 3 }).where(eq(domains.hostname, "www.hotel.it"));
      expect((await app.nestApp.get(ManagedSitesService).certificateAlerts()).map((a) => a.hostname)).toEqual(["hotel.it"]);
    });
  });

  it("writes no audit row of its own for the refusals", async () => {
    const { versionId } = await importVersion(orgA, ["*.hotel.it"], { status: "active" });
    await makeManual("www.hotel.it", versionId);
    await addDomain({ hostname: "shop.hotel.it" });
    expect(await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.domain.add"))).toEqual([]);
  });
});
