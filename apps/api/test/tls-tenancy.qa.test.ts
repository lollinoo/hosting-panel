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
  outboxEvents,
  organizations,
  platformInstallations,
  sites,
  tlsCertificateVersions,
  tlsCertificates,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { TlsCertificatesService, type TlsAuditFn } from "../src/certificates/tls-certificates.service.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { issueCert, issuePki, type IssuedCert } from "./fixtures/tls-certgen.js";

// HCP-SPEC-004 TLS-04 (QA, independent of the engineers' suites): two customer organisations on one simulated host.
// Every certificate / version / domain id of one tenant used by the other answers 404 and says nothing; a customer
// without site.certificates.manage is refused; the same organisation reuses a certificate across two sites; a wildcard
// that would cover another tenant's hostname is refused in both directions; the administrator routes refuse everybody
// but a server administrator before the body is read; a support visit carries site.certificates.manage.
const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const DAY = 86_400_000;
const PKI = issuePki();
const PEM_LEAK = /BEGIN|PRIVATE KEY|CERTIFICATE-----/;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const siteBody = (name: string, domain: string, extra: object = {}) => ({
  name,
  domain,
  title: `${name} title`,
  adminUser: "admin",
  adminEmail: `admin@${domain}`,
  adminPassword: "canary-Pass-123456",
  ...extra,
});
const leafFor = (dns: string[]): IssuedCert => issueCert({ dns, issuer: PKI.intermediate });
const uploadOf = (leaf: IssuedCert, name = "Tenant certificate") => ({
  name,
  format: "pem",
  leafPem: leaf.pem,
  chainPem: PKI.intermediate.pem,
  privateKeyPem: leaf.keyPem,
});
/** The error envelope without the per-request noise: two refusals that are indistinguishable have equal shapes. */
const shape = (res: { status: number; body: Json }) => {
  const { requestId: _r, timestamp: _t, ...error } = (res.body.error ?? {}) as Json;
  return { status: res.status, error };
};

describe("TLS-04: manual certificates across tenants", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let tokenA: string;
  let tokenB: string;
  let tokenCollab: string;
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

  async function call(method: string, path: string, body?: unknown, as: string | null = tokenA, opts: { key?: string | null } = {}) {
    const key = opts.key === undefined ? randomUUID() : opts.key;
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        "Content-Type": "application/json",
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function member(orgId: string, email: string, roleId: string): Promise<string> {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email, name: email, passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId });
    return login(email, PW);
  }

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
    return { orgId, token: await member(orgId, email, "role_customer_owner") };
  }

  async function newSite(orgId: string, token: string, name: string, domain: string, extra: object = {}) {
    const res = await call("POST", `/v1/organizations/${orgId}/managed-sites`, siteBody(name, domain, extra), token);
    expect(res.body.error ?? null).toBeNull();
    expect(res.status).toBe(202);
    await drain();
    const siteId = res.body.data.siteId as string;
    await dbClient.db.update(domains).set({ status: "active" }).where(eq(domains.siteId, siteId));
    return siteId;
  }

  const drain = () => app.outboxWorker.processPendingOnce();
  const certs = (org: string, site: string) => `/v1/organizations/${org}/managed-sites/${site}/tls-certificates`;
  const domainTls = (org: string, site: string, domainId: string) => `/v1/organizations/${org}/managed-sites/${site}/domains/${domainId}/tls`;
  const adminCerts = (site: string) => `/v1/admin/sites/${site}/tls-certificates`;
  const domainRow = async (hostname: string) => (await dbClient.db.select().from(domains).where(eq(domains.hostname, hostname)))[0]!;
  const tlsOps = () => dbClient.db.select().from(operations).where(eq(operations.kind, "site.tls.apply"));
  const auditCount = async () => (await dbClient.db.select().from(auditEvents)).length;
  const versionRow = async (id: string) => (await dbClient.db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, id)))[0]!;

  async function importOk(org: string, site: string, as: string, dns: string[], name?: string) {
    const res = await call("POST", certs(org, site), uploadOf(leafFor(dns), name), as);
    expect(res.body.error ?? null).toBeNull();
    expect(res.status).toBe(201);
    const dto = res.body.data as Json;
    return { certificateId: dto.id as string, versionId: dto.versions[0].id as string, dto };
  }

  /** Assigns the version to the hostnames through the customer route and lets the outbox settle it. */
  async function assign(org: string, site: string, as: string, versionId: string, hostnames: string[]) {
    for (const hostname of hostnames) {
      const res = await call("POST", domainTls(org, site, (await domainRow(hostname)).id), { mode: "manual", versionId }, as);
      expect(res.body.error ?? null).toBeNull();
      expect(res.status).toBe(202);
    }
    await drain();
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      dnsLookup: { lookup: async () => ({ a: [], aaaa: [] }) },
      domainReconcileIntervalMs: null,
      tlsConvergeIntervalMs: null,
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
      tlsValidatorOptions: { trustAnchors: [PKI.root.pem] },
    });
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    const created = await call("POST", "/v1/admin/customer-account", { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" }, adminToken);
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgA = created.body.data.organizationId as string;
    tokenA = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
    ({ orgId: orgB, token: tokenB } = await secondCustomer("Bar Sport Org", "luigi@bar.it"));
    tokenCollab = await member(orgA, "collab@hotel.it", "role_customer_collaborator");
    siteA = await newSite(orgA, tokenA, "Hotel Bella", "hotel.it", { includeWww: true });
    siteB = await newSite(orgB, tokenB, "Bar Sport", "bar.it");
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("cross-organisation ids", () => {
    it("org B's ids used by org A on every route of A's own site answer 404, indistinguishable from unknown ids", async () => {
      const foreign = await importOk(orgB, siteB, tokenB, ["bar.it"]);
      const foreignDomain = (await domainRow("bar.it")).id;
      const ghost = { cert: `cti_${"a".repeat(32)}`, ver: `ctv_${"b".repeat(32)}`, dom: `dom_${randomUUID()}` };
      const www = (await domainRow("www.hotel.it")).id;
      const routes = (c: string, v: string, d: string): Array<[string, string, object | undefined]> => [
        ["GET", `${certs(orgA, siteA)}/${c}`, undefined],
        ["DELETE", `${certs(orgA, siteA)}/${c}`, undefined],
        ["POST", `${certs(orgA, siteA)}/${c}/versions`, (({ name: _n, ...rest }) => rest)(uploadOf(leafFor(["hotel.it"])))],
        ["POST", `${certs(orgA, siteA)}/${c}/versions/${v}/activate`, {}],
        ["POST", `${certs(orgA, siteA)}/${c}/versions/${v}/activate`, { domainIds: [www] }],
        ["POST", domainTls(orgA, siteA, www), { mode: "manual", versionId: v }],
        ["POST", domainTls(orgA, siteA, d), { mode: "acme" }],
        ["POST", domainTls(orgA, siteA, d), { mode: "manual", versionId: v }],
      ];
      const before = await auditCount();
      const real = routes(foreign.certificateId, foreign.versionId, foreignDomain);
      const fake = routes(ghost.cert, ghost.ver, ghost.dom);
      for (const [i, [method, path, body]] of real.entries()) {
        const res = await call(method, path, body, tokenA);
        expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 404, "NOT_FOUND"]);
        for (const secret of [foreign.certificateId, foreign.versionId, foreignDomain, "bar.it", orgB, siteB, foreign.dto.versions[0].fingerprintSha256]) {
          expect(res.raw, path).not.toContain(secret);
        }
        expect(res.raw).not.toMatch(PEM_LEAK);
        const [m2, p2, b2] = fake[i]!;
        const unknown = await call(m2, p2, b2, tokenA);
        expect(shape(res).status).toBe(shape(unknown).status);
        expect(shape(res).error.code).toBe(shape(unknown).error.code);
        expect(shape(res).error.message).toBe(shape(unknown).error.message);
      }
      expect(await auditCount()).toBe(before); // a 404 is no audited decision
      expect(await tlsOps()).toHaveLength(0);
      // Nothing of B's moved.
      expect((await versionRow(foreign.versionId)).status).toBe("pending");
      expect(await dbClient.db.select().from(tlsCertificates).where(eq(tlsCertificates.id, foreign.certificateId))).toHaveLength(1);
    });

    it("the other tenant's list and the site of the other tenant under my organisation's path leak nothing", async () => {
      const mine = await importOk(orgA, siteA, tokenA, ["www.hotel.it"], "Hotel certificate");
      const theirs = await importOk(orgB, siteB, tokenB, ["bar.it"], "Bar certificate");
      const listA = await call("GET", certs(orgA, siteA), undefined, tokenA);
      const listB = await call("GET", certs(orgB, siteB), undefined, tokenB);
      expect((listA.body.data as Json[]).map((c) => c.id)).toEqual([mine.certificateId]);
      expect((listB.body.data as Json[]).map((c) => c.id)).toEqual([theirs.certificateId]);
      expect(listA.raw).not.toContain("Bar certificate");
      expect(listB.raw).not.toContain("Hotel certificate");

      // B's site under A's organisation path, and the reverse: 404 whoever asks, whatever the id.
      for (const [as, org, site, cert] of [
        [tokenA, orgA, siteB, theirs],
        [tokenB, orgB, siteA, mine],
      ] as const) {
        for (const path of [certs(org, site), `${certs(org, site)}/${cert.certificateId}`]) {
          const res = await call("GET", path, undefined, as);
          expect([path, res.status, res.body.error?.code]).toEqual([path, 404, "NOT_FOUND"]);
          expect(res.raw).not.toContain(cert.certificateId);
        }
        expect((await call("POST", certs(org, site), uploadOf(leafFor(["x.example"])), as)).status).toBe(404);
      }
    });

    it("another organisation's own path never answers 403 for a site or a certificate it has no right to, and creates nothing", async () => {
      const mine = await importOk(orgA, siteA, tokenA, ["www.hotel.it"]);
      const wwwId = (await domainRow("www.hotel.it")).id;
      const before = await auditCount();
      // B addressing A's organisation path: it is no member there. The answer may not tell that the id exists.
      for (const [method, path, body] of [
        ["GET", `${certs(orgA, siteA)}/${mine.certificateId}`, undefined],
        ["DELETE", `${certs(orgA, siteA)}/${mine.certificateId}`, undefined],
        ["POST", `${certs(orgA, siteA)}/${mine.certificateId}/versions/${mine.versionId}/activate`, {}],
        ["POST", domainTls(orgA, siteA, wwwId), { mode: "manual", versionId: mine.versionId }],
      ] as const) {
        const res = await call(method, path, body, tokenB);
        expect([method, path, res.status]).toEqual([method, path, 404]);
        expect(res.raw).not.toContain(mine.certificateId);
        expect(res.raw).not.toContain(mine.versionId);
      }
      const ghost = await call("GET", `${certs(orgA, siteA)}/cti_${"c".repeat(32)}`, undefined, tokenB);
      expect(ghost.status).toBe(404);
      expect((await call("GET", `${certs(orgA, siteA)}/${mine.certificateId}`, undefined, tokenB)).body.error.message).toBe(ghost.body.error.message);
      expect(await auditCount()).toBe(before);
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(1);
      expect(await tlsOps()).toHaveLength(0);
    });

    it("the administrator's site routes resolve the id inside the owner of the site: a foreign tenant's ids are 404 there too", async () => {
      const foreign = await importOk(orgB, siteB, tokenB, ["bar.it"]);
      const foreignDomain = (await domainRow("bar.it")).id;
      const www = (await domainRow("www.hotel.it")).id;
      for (const [method, path, body] of [
        ["GET", `${adminCerts(siteA)}/${foreign.certificateId}`, undefined],
        ["DELETE", `${adminCerts(siteA)}/${foreign.certificateId}`, undefined],
        ["POST", `${adminCerts(siteA)}/${foreign.certificateId}/versions`, (({ name: _n, ...rest }) => rest)(uploadOf(leafFor(["hotel.it"])))],
        ["POST", `${adminCerts(siteA)}/${foreign.certificateId}/versions/${foreign.versionId}/activate`, {}],
        ["POST", `/v1/admin/sites/${siteA}/domains/${www}/tls`, { mode: "manual", versionId: foreign.versionId }],
        ["POST", `/v1/admin/sites/${siteA}/domains/${foreignDomain}/tls`, { mode: "acme" }],
      ] as const) {
        const res = await call(method, path, body, adminToken);
        expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 404, "NOT_FOUND"]);
        expect(res.raw).not.toContain(foreign.versionId);
      }
      // The site list of A shows A's certificates only.
      await importOk(orgA, siteA, tokenA, ["hotel.it"], "Mine");
      const list = await call("GET", adminCerts(siteA), undefined, adminToken);
      expect((list.body.data as Json[]).map((c) => c.name)).toEqual(["Mine"]);
      expect(await tlsOps()).toHaveLength(0);
      expect((await versionRow(foreign.versionId)).status).toBe("pending");
    });

    it("a domain of another organisation inside an activate's domainIds is a 404 and the version stays untouched", async () => {
      const mine = await importOk(orgA, siteA, tokenA, ["www.hotel.it"]);
      const barDomain = (await domainRow("bar.it")).id;
      const res = await call("POST", `${certs(orgA, siteA)}/${mine.certificateId}/versions/${mine.versionId}/activate`, { domainIds: [barDomain] }, tokenA);
      expect(res.status).toBe(404);
      expect(res.raw).not.toContain(barDomain);
      expect((await versionRow(mine.versionId)).status).toBe("pending");
      expect(await tlsOps()).toHaveLength(0);
    });
  });

  describe("permissions on a customer's own site", () => {
    it("a member without site.certificates.manage is refused (403) on every mutation even with a body the schema would refuse", async () => {
      const mine = await importOk(orgA, siteA, tokenA, ["www.hotel.it"]);
      const www = (await domainRow("www.hotel.it")).id;
      const before = await auditCount();
      const garbage = { definitely: "not a valid body", leafPem: 7 };
      for (const [method, path, body] of [
        ["POST", certs(orgA, siteA), garbage],
        ["POST", certs(orgA, siteA), {}],
        ["DELETE", `${certs(orgA, siteA)}/${mine.certificateId}`, undefined],
        ["POST", `${certs(orgA, siteA)}/${mine.certificateId}/versions`, garbage],
        ["POST", `${certs(orgA, siteA)}/${mine.certificateId}/versions/${mine.versionId}/activate`, garbage],
        ["POST", domainTls(orgA, siteA, www), garbage],
      ] as const) {
        // No Idempotency-Key either: the permission check comes before everything the body or headers could trigger.
        const res = await call(method, path, body, tokenCollab, { key: null });
        expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 403, "PERMISSION_DENIED"]);
        expect(res.raw).not.toContain(mine.certificateId);
      }
      expect((await auditCount()) - before).toBe(6); // exactly one denied row each, nothing else
      expect(await tlsOps()).toHaveLength(0);
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(1);
      // The collaborator preset has no site.read either: reads are refused the same way, never a 404 or data.
      const read = await call("GET", certs(orgA, siteA), undefined, tokenCollab);
      expect([read.status, read.body.error?.code]).toEqual([403, "PERMISSION_DENIED"]);
    });

    it("the owner of the organisation, who holds the permission, gets past the check on the same routes", async () => {
      const mine = await importOk(orgA, siteA, tokenA, ["www.hotel.it"]);
      const garbage = await call("POST", `${certs(orgA, siteA)}/${mine.certificateId}/versions`, { nope: 1 }, tokenA);
      expect(garbage.status).toBe(400); // the schema, not the permission, stops it
    });
  });

  describe("administrator routes", () => {
    it("refuse a customer owner and a collaborator with 403 before the body or the Idempotency-Key is looked at; the administrator gets the 400", async () => {
      const mine = await importOk(orgA, siteA, tokenA, ["www.hotel.it"]);
      const www = (await domainRow("www.hotel.it")).id;
      const garbage = { nope: true, evictAcme: "yes" };
      const admin: Array<[string, string, object | undefined]> = [
        ["GET", adminCerts(siteA), undefined],
        ["POST", adminCerts(siteA), garbage],
        ["GET", `${adminCerts(siteA)}/${mine.certificateId}`, undefined],
        ["DELETE", `${adminCerts(siteA)}/${mine.certificateId}`, undefined],
        ["POST", `${adminCerts(siteA)}/${mine.certificateId}/versions`, garbage],
        ["POST", `${adminCerts(siteA)}/${mine.certificateId}/versions/${mine.versionId}/activate`, garbage],
        ["POST", `/v1/admin/sites/${siteA}/domains/${www}/tls`, garbage],
        ["GET", "/v1/admin/tls-certificates", undefined],
        ["GET", "/v1/admin/tls-certificates/alerts", undefined],
        ["DELETE", `/v1/admin/tls-certificates/${mine.certificateId}`, undefined],
      ];
      for (const as of [tokenA, tokenCollab, tokenB]) {
        const before = await auditCount();
        for (const [method, path, body] of admin) {
          for (const key of [undefined, null] as const) {
            const res = await call(method, path, body, as, { key });
            expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 403, "PERMISSION_DENIED"]);
            expect(res.raw).not.toContain(mine.certificateId);
          }
        }
        expect((await auditCount()) - before).toBe(admin.length * 2); // each refusal is one denied row
      }
      expect(await tlsOps()).toHaveLength(0);
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(1);
      // The administrator passes the guard, and then it is the body that is refused.
      for (const [method, path, body] of admin.filter(([m]) => m === "POST")) {
        const res = await call(method, path, body, adminToken);
        expect([method, path, res.status]).toEqual([method, path, 400]);
      }
      expect((await call("POST", adminCerts(siteA), uploadOf(leafFor(["hotel.it"])), adminToken, { key: null })).status).toBe(400);
    });

    it("answer 401 without a session", async () => {
      for (const [method, path] of [
        ["GET", "/v1/admin/tls-certificates"],
        ["GET", "/v1/admin/tls-certificates/alerts"],
        ["POST", adminCerts(siteA)],
      ] as const) {
        expect([method, path, (await call(method, path, method === "POST" ? {} : undefined, null)).status]).toEqual([method, path, 401]);
      }
    });
  });

  describe("same organisation, two sites", () => {
    it("a certificate imported through one site is used by a domain of another site of the same organisation; no other tenant sees it", async () => {
      const siteA2 = await newSite(orgA, tokenA, "Hotel Annex", "annex.it");
      expect((await dbClient.db.select().from(sites).where(eq(sites.id, siteA2)))[0]!.organizationId).toBe(orgA);

      const shared = await importOk(orgA, siteA, tokenA, ["annex.it"], "Annex certificate");
      // Listed and readable through the other site of the organisation.
      const listed = await call("GET", certs(orgA, siteA2), undefined, tokenA);
      expect((listed.body.data as Json[]).map((c) => c.id)).toEqual([shared.certificateId]);
      expect((await call("GET", `${certs(orgA, siteA2)}/${shared.certificateId}`, undefined, tokenA)).status).toBe(200);

      await assign(orgA, siteA2, tokenA, shared.versionId, ["annex.it"]);
      const [op] = await tlsOps();
      expect([op!.resourceId, op!.status]).toEqual([siteA2, "succeeded"]);
      expect(await domainRow("annex.it")).toMatchObject({ certMode: "manual", manualCertificateVersionId: shared.versionId, certStatus: "active" });
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme" });
      expect((await versionRow(shared.versionId)).status).toBe("active");
      expect((await sim.manualTls({ action: "inventory" })).entries).toEqual([{ versionId: shared.versionId, assignedHosts: ["annex.it"] }]);

      const view = await call("GET", `/v1/organizations/${orgA}/managed-sites/${siteA2}/domains`, undefined, tokenA);
      expect(view.body.data.domains.find((d: Json) => d.hostname === "annex.it").tls).toMatchObject({ mode: "manual", certificateId: shared.certificateId, versionId: shared.versionId });
      expect(view.raw).not.toMatch(PEM_LEAK);
      // In use on site 2: deleting it through site 1 is refused and removes nothing.
      const del = await call("DELETE", `${certs(orgA, siteA)}/${shared.certificateId}`, undefined, tokenA);
      expect([del.status, del.body.error?.code]).toEqual([409, "CERTIFICATE_IN_USE"]);
      expect(await dbClient.db.select().from(tlsCertificates).where(eq(tlsCertificates.id, shared.certificateId))).toHaveLength(1);
      // Another tenant sees none of it.
      expect(((await call("GET", certs(orgB, siteB), undefined, tokenB)).body.data as Json[]).length).toBe(0);
      expect((await call("GET", `${certs(orgB, siteB)}/${shared.certificateId}`, undefined, tokenB)).status).toBe(404);
    });

    // A certificate whose names belong to domains of two sites cannot be assigned one site at a time (each would
    // capture the other site's name): one activate names both domains and the routes carry it across the sites.
    it("one multi-name certificate can serve a domain on each of two sites of the same organisation", async () => {
      const siteA2 = await newSite(orgA, tokenA, "Hotel Annex", "annex.it");
      const shared = await importOk(orgA, siteA, tokenA, ["hotel.it", "annex.it"], "Shared SAN");
      const domainIds = [(await domainRow("hotel.it")).id, (await domainRow("annex.it")).id];
      const res = await call("POST", `${certs(orgA, siteA)}/${shared.certificateId}/versions/${shared.versionId}/activate`, { domainIds }, tokenA);
      expect(res.body.error ?? null).toBeNull();
      expect(res.status).toBe(202);
      expect(res.body.moved.map((m: Json) => [m.hostname, m.siteId]).sort()).toEqual([["annex.it", siteA2], ["hotel.it", siteA]]);
      await drain();
      for (const host of ["hotel.it", "annex.it"]) {
        expect(await domainRow(host)).toMatchObject({ certMode: "manual", manualCertificateVersionId: shared.versionId, certStatus: "active" });
      }
      expect(await tlsOps()).toHaveLength(1);
      expect((await versionRow(shared.versionId)).status).toBe("active");
      // The other organisation cannot reach it, with or without the second site in the request.
      const foreign = await call("POST", `${certs(orgB, siteB)}/${shared.certificateId}/versions/${shared.versionId}/activate`, { domainIds }, tokenB);
      expect(foreign.status).toBe(404);
    });
  });

  // The service-level contract of the cross-site request (the routes pass `authorizeSite` once the controllers are
  // wired): one activate names or finds the organisation's domains on every site, authorises each other site, queues
  // ONE operation on the requesting site with ids only, and audits per affected site.
  describe("one request across the sites of an organisation (service)", () => {
    const actorId = async () => (await dbClient.db.select().from(users).where(eq(users.email, "mario@hotel.it")))[0]!.id;
    const service = () => app.nestApp.get(TlsCertificatesService, { strict: false });
    const events: Array<Parameters<TlsAuditFn>[0]> = [];
    const audit: TlsAuditFn = async (event) => void events.push(event);
    beforeEach(() => void (events.length = 0));

    async function twoSites() {
      const siteA2 = await newSite(orgA, tokenA, "Hotel Annex", "annex.it");
      const shared = await importOk(orgA, siteA, tokenA, ["hotel.it", "annex.it"], "Shared SAN");
      const domainIds = [(await domainRow("hotel.it")).id, (await domainRow("annex.it")).id];
      return { siteA2, shared, domainIds };
    }
    const request = async (extra: Record<string, unknown>) => ({
      scope: { organizationId: orgA, siteId: siteA },
      actor: { userId: await actorId(), capped: false },
      idempotencyKey: randomUUID(),
      audit,
      ...extra,
    });

    it("assigns one multi-name certificate to a domain on each of two sites in one operation, with one audit row per site", async () => {
      const { siteA2, shared, domainIds } = await twoSites();
      const authorised: string[] = [];
      const result = await service().activateVersion(
        (await request({
          certificateId: shared.certificateId,
          versionId: shared.versionId,
          body: { domainIds },
          authorizeSite: async (id: string) => void authorised.push(id),
        })) as Parameters<TlsCertificatesService["activateVersion"]>[0],
      );
      expect(result.queued).toBe(true);
      expect(authorised).toEqual([siteA2]);
      expect(result.moved.map((m) => [m.hostname, m.siteId]).sort()).toEqual([["annex.it", siteA2], ["hotel.it", siteA]]);
      const [op] = await tlsOps();
      expect(op).toMatchObject({ resourceId: siteA, status: "queued" });
      const [queued] = await dbClient.db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "operation.queued.site.tls.apply"));
      expect((queued!.payload as Json).changes).toEqual(domainIds.map((domainId) => ({ domainId, versionId: shared.versionId })));
      expect(JSON.stringify(queued!.payload)).not.toMatch(PEM_LEAK);
      expect((await versionRow(shared.versionId)).status).toBe("applying");
      const assigns = events.filter((e) => e.action === "site.tls_certificate.assign");
      expect(assigns.map((e) => e.targetId).sort()).toEqual([siteA, siteA2].sort());
      expect(assigns.find((e) => e.targetId === siteA2)!.details).toMatchObject({ operationId: op!.id, siteId: siteA2, domainIds: [domainIds[1]] });
    });

    it("a rotation of a certificate shared by two sites moves every domain of the organisation, on every site", async () => {
      const { siteA2, shared, domainIds } = await twoSites();
      await dbClient.db
        .update(domains)
        .set({ certMode: "manual", manualCertificateVersionId: shared.versionId })
        .where(inArray(domains.id, domainIds));
      await dbClient.db.update(tlsCertificateVersions).set({ status: "active" }).where(eq(tlsCertificateVersions.id, shared.versionId));
      const second = await call("POST", `${certs(orgA, siteA)}/${shared.certificateId}/versions`, (({ name: _n, ...rest }) => rest)(uploadOf(leafFor(["hotel.it", "annex.it"]))));
      expect(second.status).toBe(201);
      const v2 = second.body.data.versions.at(-1).id as string;
      const call2 = async (authorizeSite?: (id: string) => Promise<void>) =>
        service().activateVersion(
          (await request({
            certificateId: shared.certificateId,
            versionId: v2,
            body: {},
            ...(authorizeSite ? { authorizeSite } : {}),
          })) as Parameters<TlsCertificatesService["activateVersion"]>[0],
        );

      // Confined to the requesting site (no authorisation seam): the other site keeps V1 with an identical key.
      await expect(call2()).rejects.toMatchObject({ code: "CERTIFICATE_SNI_MISMATCH" });
      // A site the caller may not manage refuses everything and queues nothing.
      await expect(call2(async () => { throw new ControlPlaneError("PERMISSION_DENIED", "No permission."); })).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      expect(await tlsOps()).toHaveLength(0);
      expect((await versionRow(v2)).status).toBe("pending");

      const authorised: string[] = [];
      const result = await call2(async (id) => void authorised.push(id));
      expect(authorised).toEqual([siteA2]);
      expect(result.moved.map((m) => m.domainId).sort()).toEqual([...domainIds].sort());
      expect(await tlsOps()).toHaveLength(1);
      const assigns = events.filter((e) => e.action === "site.tls_certificate.assign");
      expect(assigns).toHaveLength(2);
      for (const e of assigns) expect(e.details).toMatchObject({ versionId: v2, fromVersionIds: [shared.versionId] });
    });

    it("a domain of another organisation in the request is a 404 even with the authorisation seam", async () => {
      const { shared } = await twoSites();
      const foreign = (await domainRow("bar.it")).id;
      await expect(
        service().activateVersion(
          (await request({
            certificateId: shared.certificateId,
            versionId: shared.versionId,
            body: { domainIds: [foreign] },
            authorizeSite: async () => undefined,
          })) as Parameters<TlsCertificatesService["activateVersion"]>[0],
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await tlsOps()).toHaveLength(0);
    });
  });

  describe("wildcard collisions between tenants", () => {
    const addB = (hostname: string, extra: object = {}) =>
      call("POST", `/v1/organizations/${orgB}/managed-sites/${siteB}/domains`, { hostname, ...extra }, tokenB);

    it("org A's wildcard is refused when it would cover a hostname of org B, on every route that assigns, and leaks neither", async () => {
      const added = await addB("bar.hotel.it");
      expect(added.body.error ?? null).toBeNull();
      expect(added.status).toBe(201);
      const wild = await importOk(orgA, siteA, tokenA, ["*.hotel.it"], "Wildcard");
      const www = (await domainRow("www.hotel.it")).id;
      const before = await auditCount();

      const tries: Array<[string, string, object, string]> = [
        ["customer domain tls", domainTls(orgA, siteA, www), { mode: "manual", versionId: wild.versionId }, tokenA],
        ["customer activate", `${certs(orgA, siteA)}/${wild.certificateId}/versions/${wild.versionId}/activate`, { domainIds: [www] }, tokenA],
        ["admin domain tls", `/v1/admin/sites/${siteA}/domains/${www}/tls`, { mode: "manual", versionId: wild.versionId }, adminToken],
        ["admin activate", `${adminCerts(siteA)}/${wild.certificateId}/versions/${wild.versionId}/activate`, { domainIds: [www] }, adminToken],
        ["customer domain add", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains`, { hostname: "shop.hotel.it", tlsVersionId: wild.versionId }, tokenA],
        ["admin domain add", `/v1/admin/sites/${siteA}/domains`, { hostname: "shop2.hotel.it", tlsVersionId: wild.versionId }, adminToken],
      ];
      for (const [label, path, body, as] of tries) {
        const res = await call("POST", path, body, as);
        expect([label, res.status, res.body.error?.code]).toEqual([label, 409, "DOMAIN_CONFLICT"]);
        for (const secret of ["bar.hotel.it", orgB, siteB, "Bar Sport", "luigi"]) expect(res.raw, label).not.toContain(secret);
      }
      expect(await tlsOps()).toHaveLength(0);
      expect((await versionRow(wild.versionId)).status).toBe("pending");
      expect(await domainRow("www.hotel.it")).toMatchObject({ certMode: "acme", manualCertificateVersionId: null });
      expect(await dbClient.db.select().from(domains).where(eq(domains.hostname, "shop.hotel.it"))).toHaveLength(0);
      expect(await dbClient.db.select().from(domains).where(eq(domains.hostname, "shop2.hotel.it"))).toHaveLength(0);
      expect(await auditCount()).toBe(before); // nothing was recorded as assigned
      expect((await sim.manualTls({ action: "inventory" })).entries).toEqual([]);
    });

    it("the refusal does not depend on the hostname of B having been confirmed: a pending name of B is enough", async () => {
      expect((await addB("blog.hotel.it")).status).toBe(201);
      await dbClient.db.update(domains).set({ status: "pending" }).where(eq(domains.hostname, "blog.hotel.it"));
      const wild = await importOk(orgA, siteA, tokenA, ["*.hotel.it"]);
      const www = (await domainRow("www.hotel.it")).id;
      const res = await call("POST", domainTls(orgA, siteA, www), { mode: "manual", versionId: wild.versionId });
      expect([res.status, res.body.error?.code]).toEqual([409, "DOMAIN_CONFLICT"]);
    });

    it("a wildcard that only covers the organisation's own names is accepted, then a later domain of org B under the loaded wildcard is refused", async () => {
      const wild = await importOk(orgA, siteA, tokenA, ["*.hotel.it"], "Wildcard");
      await assign(orgA, siteA, tokenA, wild.versionId, ["www.hotel.it"]);
      expect(await domainRow("www.hotel.it")).toMatchObject({ certMode: "manual", manualCertificateVersionId: wild.versionId });

      // B tries to take a name the wildcard of A now serves: on the customer route, the admin route, and as a new site.
      const customer = await addB("bar.hotel.it");
      const admin = await call("POST", `/v1/admin/sites/${siteB}/domains`, { hostname: "pub.hotel.it" }, adminToken);
      const newSiteTry = await call("POST", `/v1/organizations/${orgB}/managed-sites`, siteBody("Bar Two", "club.hotel.it"), tokenB);
      for (const [label, res] of [["customer add", customer], ["admin add", admin], ["site create", newSiteTry]] as const) {
        expect([label, res.status, res.body.error?.code]).toEqual([label, 409, "DOMAIN_CONFLICT"]);
        for (const secret of [wild.certificateId, wild.versionId, orgA, siteA, "www.hotel.it", "Wildcard", "mario"]) expect(res.raw, label).not.toContain(secret);
      }
      for (const host of ["bar.hotel.it", "pub.hotel.it", "club.hotel.it"]) {
        expect(await dbClient.db.select().from(domains).where(eq(domains.hostname, host)), host).toHaveLength(0);
      }
      expect(await dbClient.db.select().from(sites).where(eq(sites.name, "Bar Two"))).toHaveLength(0);

      // B's own certificate covering a name it holds is not affected by A's wildcard.
      expect((await addB("bar.other.it")).status).toBe(201);
    });

    it("once the wildcard is not loaded any more the name is free again", async () => {
      const wild = await importOk(orgA, siteA, tokenA, ["*.hotel.it"]);
      await assign(orgA, siteA, tokenA, wild.versionId, ["www.hotel.it"]);
      expect((await addB("bar.hotel.it")).status).toBe(409);

      sim.issueCertificate("www.hotel.it", new Date(Date.now() + 60 * DAY).toISOString());
      const www = (await domainRow("www.hotel.it")).id;
      const back = await call("POST", domainTls(orgA, siteA, www), { mode: "acme" });
      expect(back.status).toBe(202);
      await drain();
      expect(await domainRow("www.hotel.it")).toMatchObject({ certMode: "acme", manualCertificateVersionId: null });
      expect((await versionRow(wild.versionId)).status).toBe("inactive");

      const ok = await addB("bar.hotel.it");
      expect(ok.body.error ?? null).toBeNull();
      expect(ok.status).toBe(201);
    });

    it("a wildcard of one level does not collide with B's deeper names or its apex", async () => {
      expect((await addB("a.b.hotel.it")).status).toBe(201);
      const wild = await importOk(orgA, siteA, tokenA, ["*.hotel.it"]);
      const www = (await domainRow("www.hotel.it")).id;
      const res = await call("POST", domainTls(orgA, siteA, www), { mode: "manual", versionId: wild.versionId });
      expect(res.body.error ?? null).toBeNull();
      expect(res.status).toBe(202);
    });
  });

  describe("support visit", () => {
    it("carries site.certificates.manage: the administrator in a visit manages certificates through the customer routes of that organisation only", async () => {
      const mine = await importOk(orgA, siteA, tokenA, ["www.hotel.it"], "Customer's");
      // Without a visit the customer route does not exist for the administrator.
      const closed = await call("GET", certs(orgA, siteA), undefined, adminToken);
      expect(closed.status).toBe(404);
      expect((await call("POST", certs(orgA, siteA), uploadOf(leafFor(["hotel.it"])), adminToken)).status).toBe(404);

      const opened = await call("POST", `/v1/admin/sites/${siteA}/support-access`, undefined, adminToken);
      expect(opened.status, opened.raw).toBeLessThan(300);

      const imported = await call("POST", certs(orgA, siteA), uploadOf(leafFor(["hotel.it"]), "Support import"), adminToken);
      expect(imported.body.error ?? null).toBeNull();
      expect(imported.status).toBe(201);
      const added = await call("POST", `${certs(orgA, siteA)}/${mine.certificateId}/versions`, (({ name: _n, ...rest }) => rest)(uploadOf(leafFor(["www.hotel.it"]))), adminToken);
      expect(added.status).toBe(201);
      const www = (await domainRow("www.hotel.it")).id;
      const assigned = await call("POST", domainTls(orgA, siteA, www), { mode: "manual", versionId: mine.versionId }, adminToken);
      expect(assigned.status).toBe(202);
      await drain();
      expect(await domainRow("www.hotel.it")).toMatchObject({ certMode: "manual", manualCertificateVersionId: mine.versionId });
      // Switching back and deleting is allowed too.
      const created = imported.body.data as Json;
      expect((await call("DELETE", `${certs(orgA, siteA)}/${created.id}`, undefined, adminToken)).status).toBe(204);

      // The visit does not reach the other tenant.
      for (const [method, path] of [
        ["GET", certs(orgB, siteB)],
        ["POST", certs(orgB, siteB)],
      ] as const) {
        const res = await call(method, path, method === "POST" ? uploadOf(leafFor(["bar.it"])) : undefined, adminToken);
        expect([method, path, res.status]).toEqual([method, path, 404]);
      }
      expect(await dbClient.db.select().from(tlsCertificates).where(eq(tlsCertificates.organizationId, orgB))).toHaveLength(0);
    });
  });
});
