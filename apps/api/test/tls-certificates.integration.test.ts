import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  domains,
  eq,
  hostAllocations,
  hosts,
  membershipRoles,
  memberships,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  readTlsVersionKey,
  tlsCertificateVersions,
  tlsCertificates,
  tlsPublishState,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { canonicalRequestHash } from "../src/common/request-hash.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { issueCert, issuePki, type IssuedCert } from "./fixtures/tls-certgen.js";

// HCP-SPEC-004 (TLS-01/04/11) API side: the customer and administrator routes of the imported certificates, on a
// simulated host with two customer organisations. Certificates are real (Node-built X.509 under a test root that the
// validator is told to trust); nothing here is committed key material.
const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const DAY = 86_400_000;
const PKI = issuePki();
const OTHER_ROOT = issuePki();
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

/** A certificate under the trusted test root; `over` tweaks the X.509 (dates, key...). */
const leafFor = (dns: string[], over: Partial<Parameters<typeof issueCert>[0]> = {}): IssuedCert =>
  issueCert({ dns, issuer: PKI.intermediate, ...over });
const uploadOf = (leaf: IssuedCert, extra: object = {}) => ({
  name: "Hotel certificate",
  format: "pem",
  leafPem: leaf.pem,
  chainPem: PKI.intermediate.pem,
  privateKeyPem: leaf.keyPem,
  ...extra,
});

describe("manual TLS certificate routes", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
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

  async function call(
    method: string,
    path: string,
    body?: unknown,
    as: string | null = tokenA,
    opts: { key?: string | null; rawBody?: string } = {},
  ) {
    const key = opts.key === undefined ? randomUUID() : opts.key;
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        "Content-Type": "application/json",
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
      body: opts.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const raw = await res.text();
    return { status: res.status, raw, headers: res.headers, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function customer(name: string, email: string) {
    const created = await call("POST", "/v1/admin/customer-account", { organizationName: name, ownerEmail: email, ownerName: name }, adminToken);
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
    return { orgId, token: await member(orgId, email, "role_customer_owner") };
  }

  async function member(orgId: string, email: string, roleId: string): Promise<string> {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email, name: email, passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId });
    return login(email, PW);
  }

  async function newSite(orgId: string, token: string, name: string, domain: string, extra: object = {}) {
    const res = await call("POST", `/v1/organizations/${orgId}/managed-sites`, siteBody(name, domain, extra), token);
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.siteId as string;
  }

  const certs = (org = orgA, site = siteA) => `/v1/organizations/${org}/managed-sites/${site}/tls-certificates`;
  const adminCerts = (site = siteA) => `/v1/admin/sites/${site}/tls-certificates`;
  const domainRow = async (hostname: string) => (await dbClient.db.select().from(domains).where(eq(domains.hostname, hostname)))[0]!;
  const tlsOps = () => dbClient.db.select().from(operations).where(eq(operations.kind, "site.tls.apply"));
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const generation = async () => (await dbClient.db.select().from(tlsPublishState))[0]!.desiredGeneration;
  const importOk = async (dns: string[], over: { as?: string; org?: string; site?: string } = {}) => {
    const res = await call("POST", certs(over.org, over.site), uploadOf(leafFor(dns)), over.as ?? tokenA);
    expect(res.body.error ?? null).toBeNull();
    expect(res.status).toBe(201);
    const dto = res.body.data as Json;
    return { certificateId: dto.id as string, versionId: dto.versions[0].id as string, dto };
  };

  /** A version planted directly (no validator): for caps, expiry and foreign-coverage cases. */
  async function plant(
    organizationId: string,
    sanDns: string[],
    over: { status?: "pending" | "inactive" | "applying" | "active" | "failed"; notAfterDays?: number } = {},
  ) {
    const certificateId = `cti_${randomUUID().replace(/-/g, "")}`;
    const versionId = `ctv_${randomUUID().replace(/-/g, "")}`;
    await dbClient.db.insert(tlsCertificates).values({ id: certificateId, organizationId, name: "planted" });
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
      issuer: "CN=Planted CA",
      serialNumber: "01",
      fingerprintSha256: randomUUID().replace(/-/g, "").repeat(2),
      notBefore: new Date(Date.now() + (over.notAfterDays ?? 60) * DAY - 90 * DAY),
      notAfter: new Date(Date.now() + (over.notAfterDays ?? 60) * DAY),
      sanDns,
      keyType: "ec",
      keyBits: 256,
      status: over.status ?? "inactive",
    });
    return { certificateId, versionId };
  }

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
      tlsValidatorOptions: { trustAnchors: [PKI.root.pem] },
    });
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    ({ orgId: orgA, token: tokenA } = await customer("Hotel Mario", "mario@hotel.it"));
    ({ orgId: orgB, token: tokenB } = await secondCustomer("Bar Sport Org", "luigi@bar.it"));
    tokenCollab = await member(orgA, "collab@hotel.it", "role_customer_collaborator");
    siteA = await newSite(orgA, tokenA, "Hotel Bella", "hotel.it", { includeWww: true });
    siteB = await newSite(orgB, tokenB, "Bar Sport", "bar.it");
    await dbClient.db.update(domains).set({ status: "active" });
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("import", () => {
    it("stores a pending version, answers the DTO without any PEM, keeps only ciphertext, and audits ids and fingerprint", async () => {
      const leaf = leafFor(["hotel.it", "www.hotel.it"]);
      const res = await call("POST", certs(), uploadOf(leaf));
      expect(res.status).toBe(201);
      expect(res.raw).not.toMatch(PEM_LEAK);
      expect(res.raw).not.toContain(leaf.keyPem.replace(/-----[^-]+-----|\s+/g, "").slice(0, 40));
      const dto = res.body.data as Json;
      expect(dto).toMatchObject({ name: "Hotel certificate", source: "manual", createdForSiteId: siteA, activeVersionId: null });
      expect(dto.versions).toHaveLength(1);
      expect(dto.versions[0]).toMatchObject({
        versionNumber: 1,
        status: "pending",
        sanDns: ["hotel.it", "www.hotel.it"],
        wildcard: false,
        keyType: "ec",
        problem: null,
        activatedAt: null,
      });
      expect(dto.versions[0].fingerprintSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(dto.coveredDomains.map((d: Json) => [d.hostname, d.assigned, d.versionId])).toEqual([
        ["hotel.it", false, null],
        ["www.hotel.it", false, null],
      ]);
      expect(dto.assignedDomains).toEqual([]);
      expect(dto.warnings).toEqual(["covers_unassigned_domains"]);
      expect(dto.expiry).toMatchObject({ tier: "ok" });

      const versionId = dto.versions[0].id as string;
      const [row] = await dbClient.db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, versionId));
      expect(row!.keyCiphertextBase64).not.toContain("PRIVATE");
      expect(JSON.stringify(row)).not.toContain(leaf.keyPem.replace(/-----[^-]+-----|\s+/g, "").slice(0, 40));
      // The AAD binds organisation, certificate and version: the key reads back only through that context.
      const key = await readTlsVersionKey(dbClient.db, { versionId, masterKey: KEY });
      expect(key).toMatchObject({ organizationId: orgA, certificateId: dto.id });
      expect(key.privateKeyPem).toContain("PRIVATE KEY");

      const [audit] = await audits("site.tls_certificate.import");
      const { outcome: _o, requestId: _r, ...details } = audit!.details as Json;
      expect(audit).toMatchObject({ organizationId: orgA, targetType: "tls_certificate", targetId: dto.id });
      expect(Object.keys(details).sort()).toEqual(["certificateId", "fingerprintSha256", "notAfter", "sanCount", "siteId", "versionId", "wildcard"]);
      expect(details).toMatchObject({ certificateId: dto.id, versionId, siteId: siteA, wildcard: false, sanCount: 2 });
      expect(JSON.stringify(audit)).not.toMatch(PEM_LEAK);
      expect(await tlsOps()).toHaveLength(0);
    });

    it("lists and gets it back; a wildcard shows the domains it covers", async () => {
      const { certificateId } = await importOk(["*.hotel.it"]);
      const list = await call("GET", certs());
      expect(list.status).toBe(200);
      expect(list.body.data.map((c: Json) => c.id)).toEqual([certificateId]);
      expect(list.body.data[0].coveredDomains.map((d: Json) => d.hostname)).toEqual(["www.hotel.it"]);
      expect(list.body.data[0].versions[0].wildcard).toBe(true);
      const one = await call("GET", `${certs()}/${certificateId}`);
      expect(one.status).toBe(200);
      expect(one.body.data.id).toBe(certificateId);
      expect(one.raw).not.toMatch(PEM_LEAK);
    });

    it("replays the same key and body, refuses the same key with another body, and requires the key", async () => {
      const body = uploadOf(leafFor(["hotel.it"]));
      const first = await call("POST", certs(), body, tokenA, { key: "k-1" });
      const again = await call("POST", certs(), body, tokenA, { key: "k-1" });
      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(1);
      expect(await audits("site.tls_certificate.import")).toHaveLength(1);

      const other = await call("POST", certs(), uploadOf(leafFor(["www.hotel.it"])), tokenA, { key: "k-1" });
      expect(other.status).toBe(409);
      expect(other.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(other.raw).not.toMatch(PEM_LEAK);

      const none = await call("POST", certs(), uploadOf(leafFor(["www.hotel.it"])), tokenA, { key: null });
      expect(none.status).toBe(400);
      expect(none.body.error.code).toBe("VALIDATION_ERROR");
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(1);
    });

    it("refuses a leaf already imported in the organisation with ALREADY_EXISTS naming the existing certificate", async () => {
      const leaf = leafFor(["hotel.it"]);
      const first = await call("POST", certs(), uploadOf(leaf));
      const dup = await call("POST", certs(), uploadOf(leaf, { name: "Again" }));
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe("ALREADY_EXISTS");
      expect(dup.body.error.details).toEqual([expect.objectContaining({ reason: "duplicate_certificate", message: first.body.data.id })]);
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(1);
      // Another organisation may import the same certificate: the unique index is per organisation.
      expect((await call("POST", certs(orgB, siteB), uploadOf(leaf), tokenB)).status).toBe(201);
    });

    it("refuses bad material with the stable code and leaves nothing behind or in the answer", async () => {
      const good = leafFor(["hotel.it"]);
      const expired = leafFor(["hotel.it"], { notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - DAY) });
      const strangerRoot = issueCert({ dns: ["hotel.it"], issuer: OTHER_ROOT.intermediate });
      const cases: Array<[string, object, number, string]> = [
        ["expired", uploadOf(expired), 422, "CERTIFICATE_EXPIRED"],
        ["unknown root", { ...uploadOf(strangerRoot), chainPem: OTHER_ROOT.intermediate.pem }, 422, "CERTIFICATE_CHAIN_INVALID"],
        ["missing intermediate", uploadOf(good, { chainPem: "" }), 422, "CERTIFICATE_CHAIN_INVALID"],
        ["key mismatch", uploadOf(good, { privateKeyPem: leafFor(["hotel.it"]).keyPem }), 422, "CERTIFICATE_KEY_MISMATCH"],
        ["not a PEM", uploadOf(good, { leafPem: "this is not a certificate" }), 422, "CERTIFICATE_FORMAT_UNSUPPORTED"],
        ["pfx requested", uploadOf(good, { format: "pfx" }), 400, "VALIDATION_ERROR"],
        ["extra field", uploadOf(good, { password: "x" }), 400, "VALIDATION_ERROR"],
      ];
      for (const [label, body, status, code] of cases) {
        const res = await call("POST", certs(), body);
        expect([label, res.status, res.body.error?.code]).toEqual([label, status, code]);
        expect(res.raw, label).not.toMatch(PEM_LEAK);
        expect(res.raw, label).not.toContain(good.keyPem.replace(/-----[^-]+-----|\s+/g, "").slice(0, 40));
      }
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(0);
      expect(await audits("site.tls_certificate.import")).toHaveLength(0);
    });

    it("answers 413 CERTIFICATE_UPLOAD_TOO_LARGE for an oversize upload, and a plain 400 on any other route", async () => {
      const big = "-----BEGIN CERTIFICATE-----\n" + "A".repeat(300_000) + "\n-----END CERTIFICATE-----";
      const total = await call("POST", certs(), { name: "x", format: "pem", leafPem: big, chainPem: "", privateKeyPem: big });
      expect(total.status).toBe(413);
      expect(total.body.error.code).toBe("CERTIFICATE_UPLOAD_TOO_LARGE");

      const huge = JSON.stringify({ name: "x", format: "pem", leafPem: "A".repeat(1_100_000), chainPem: "", privateKeyPem: "B" });
      const body = await call("POST", certs(), undefined, tokenA, { rawBody: huge });
      expect([body.status, body.raw.slice(0, 300)]).toEqual([413, expect.anything()]);
      expect(body.body.error.code).toBe("CERTIFICATE_UPLOAD_TOO_LARGE");
      expect(body.raw).not.toContain("AAAA");
      const admin = await call("POST", adminCerts(), undefined, adminToken, { rawBody: huge });
      expect(admin.status).toBe(413);

      const other = await call("POST", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains`, undefined, tokenA, {
        rawBody: JSON.stringify({ hostname: "A".repeat(1_100_000) }),
      });
      expect(other.status).toBe(400);
      expect(other.body.error.code).toBe("VALIDATION_ERROR");
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(0);
    });

    it("adds a pending version to a certificate and audits the replacement", async () => {
      const { certificateId, versionId } = await importOk(["hotel.it"]);
      const res = await call("POST", `${certs()}/${certificateId}/versions`, (({ name: _n, ...rest }) => rest)(uploadOf(leafFor(["hotel.it"]))));
      expect(res.status).toBe(201);
      expect(res.body.data.versions.map((v: Json) => [v.versionNumber, v.status])).toEqual([[1, "pending"], [2, "pending"]]);
      expect(res.raw).not.toMatch(PEM_LEAK);
      const [audit] = await audits("site.tls_certificate.replace");
      expect(audit!.details).toMatchObject({ certificateId, versionNumber: 2, previousVersionId: versionId, siteId: siteA });
      // A version needs the name-less body: the name belongs to the certificate.
      const withName = await call("POST", `${certs()}/${certificateId}/versions`, uploadOf(leafFor(["hotel.it"])));
      expect(withName.status).toBe(400);
    });
  });

  describe("access", () => {
    it("a collaborator (no site permission) is refused on every route with 403 and one denied row", async () => {
      const { certificateId, versionId } = await importOk(["www.hotel.it"]);
      const domainId = (await domainRow("www.hotel.it")).id;
      for (const [method, path, body] of [
        ["GET", certs(), undefined],
        ["GET", `${certs()}/${certificateId}`, undefined],
        ["POST", certs(), uploadOf(leafFor(["hotel.it"]))],
        ["DELETE", `${certs()}/${certificateId}`, undefined],
        ["POST", `${certs()}/${certificateId}/versions`, {}],
        ["POST", `${certs()}/${certificateId}/versions/${versionId}/activate`, {}],
        ["POST", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains/${domainId}/tls`, { mode: "acme" }],
      ] as const) {
        const before = (await dbClient.db.select().from(auditEvents)).length;
        const res = await call(method, path, body, tokenCollab);
        expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 403, "PERMISSION_DENIED"]);
        const added = (await dbClient.db.select().from(auditEvents)).slice(before);
        expect(added.map((a) => (a.details as Json).outcome)).toEqual(["denied"]);
      }
    });

    it("another organisation gets 404 on every route, with no audit row and no trace of the ids", async () => {
      const { certificateId, versionId } = await importOk(["www.hotel.it"]);
      const domainId = (await domainRow("www.hotel.it")).id;
      const before = (await dbClient.db.select().from(auditEvents)).length;
      const routes: Array<[string, string, object | undefined]> = [
        ["GET", certs(orgA, siteA), undefined],
        ["GET", `${certs(orgA, siteA)}/${certificateId}`, undefined],
        ["DELETE", `${certs(orgA, siteA)}/${certificateId}`, undefined],
        ["POST", certs(orgA, siteA), uploadOf(leafFor(["hotel.it"]))],
        ["POST", `${certs(orgA, siteA)}/${certificateId}/versions/${versionId}/activate`, {}],
        // orgB's own site, with orgA's ids.
        ["GET", `${certs(orgB, siteB)}/${certificateId}`, undefined],
        ["DELETE", `${certs(orgB, siteB)}/${certificateId}`, undefined],
        ["POST", `${certs(orgB, siteB)}/${certificateId}/versions`, (({ name: _n, ...rest }) => rest)(uploadOf(leafFor(["bar.it"])))],
        ["POST", `${certs(orgB, siteB)}/${certificateId}/versions/${versionId}/activate`, {}],
        ["POST", `/v1/organizations/${orgB}/managed-sites/${siteB}/domains/${domainId}/tls`, { mode: "acme" }],
      ];
      for (const [method, path, body] of routes) {
        const res = await call(method, path, body, tokenB);
        expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 404, "NOT_FOUND"]);
        expect(res.raw).not.toContain(certificateId);
        expect(res.raw).not.toContain(versionId);
      }
      // orgB's own domain with orgA's version: the version is invisible.
      const bar = (await domainRow("bar.it")).id;
      const res = await call("POST", `/v1/organizations/${orgB}/managed-sites/${siteB}/domains/${bar}/tls`, { mode: "manual", versionId }, tokenB);
      expect(res.status).toBe(404);
      expect((await dbClient.db.select().from(auditEvents)).length).toBe(before);
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(1);
    });

    it("needs a session", async () => {
      expect((await call("GET", certs(), undefined, null)).status).toBe(401);
      expect((await call("POST", certs(), {}, null)).status).toBe(401);
    });
  });

  describe("caps", () => {
    it("refuses the 11th version of the hour for a customer with RATE_LIMITED and Retry-After, but not for an administrator", async () => {
      for (let i = 0; i < 10; i += 1) await plant(orgA, [`h${i}.hotel.it`]);
      const res = await call("POST", certs(), uploadOf(leafFor(["hotel.it"])));
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("RATE_LIMITED");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      const asAdmin = await call("POST", adminCerts(), uploadOf(leafFor(["hotel.it"])), adminToken);
      expect(asAdmin.status).toBe(201);
    });

    it("refuses the 21st version of one certificate with QUOTA_EXCEEDED (a count, so not RATE_LIMITED), for everyone, and only that certificate", async () => {
      const full = await plant(orgA, ["hotel.it"]);
      const other = await plant(orgA, ["www.hotel.it"]);
      const [first] = await dbClient.db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, full.versionId));
      // Versions 2..20, created long ago: the hourly cap is not in play.
      await dbClient.db.insert(tlsCertificateVersions).values(
        Array.from({ length: 19 }, (_, i) => ({
          ...first!,
          id: `ctv_${String(i).padStart(32, "0")}`,
          versionNumber: i + 2,
          fingerprintSha256: String(i + 1).padStart(64, "0"),
          createdAt: new Date(Date.now() - 2 * DAY),
        })),
      );
      const body = (({ name: _n, ...rest }) => rest)(uploadOf(leafFor(["hotel.it"])));
      for (const res of [
        await call("POST", `${certs()}/${full.certificateId}/versions`, body),
        await call("POST", `${adminCerts()}/${full.certificateId}/versions`, body, adminToken),
      ]) {
        expect([res.status, res.body.error.code]).toEqual([409, "QUOTA_EXCEEDED"]);
      }
      expect(await dbClient.db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.certificateId, full.certificateId))).toHaveLength(20);
      const ok = await call("POST", `${certs()}/${other.certificateId}/versions`, (({ name: _n, ...rest }) => rest)(uploadOf(leafFor(["www.hotel.it"]))));
      expect(ok.status).toBe(201);
    });

    it("refuses the 101st certificate of an organisation with QUOTA_EXCEEDED, for everyone", async () => {
      await dbClient.db.insert(tlsCertificates).values(
        Array.from({ length: 100 }, (_, i) => ({ id: `cti_${String(i).padStart(32, "0")}`, organizationId: orgA, name: `c${i}` })),
      );
      for (const res of [
        await call("POST", certs(), uploadOf(leafFor(["hotel.it"]))),
        await call("POST", adminCerts(), uploadOf(leafFor(["hotel.it"])), adminToken),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("QUOTA_EXCEEDED");
      }
      expect((await call("POST", certs(orgB, siteB), uploadOf(leafFor(["bar.it"])), tokenB)).status).toBe(201);
    });
  });

  describe("assignment", () => {
    const domainTls = (domainId: string, body: object, as = tokenA, opts: { key?: string | null } = {}) =>
      call("POST", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains/${domainId}/tls`, body, as, opts);

    it("queues one site.tls.apply, marks the version applying, keeps the domain row, and audits the assignment", async () => {
      const { versionId } = await importOk(["www.hotel.it"]);
      const domainId = (await domainRow("www.hotel.it")).id;
      const res = await domainTls(domainId, { mode: "manual", versionId }, tokenA, { key: "assign-1" });
      expect(res.body.error ?? null).toBeNull();
      expect(res.status).toBe(202);
      expect(res.body.data.domains.find((d: Json) => d.id === domainId).tls.mode).toBe("acme");
      const [op] = await tlsOps();
      expect(op).toMatchObject({ organizationId: orgA, resourceId: siteA, lockKey: `site:${siteA}`, idempotencyKey: "assign-1" });
      expect(op!.requestHash).toMatch(/^[0-9a-f]{64}$/);
      const [event] = await dbClient.db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "operation.queued.site.tls.apply"));
      expect(event!.payload).toMatchObject({ siteId: siteA, changes: [{ domainId, versionId }] });
      expect(JSON.stringify(event!.payload)).not.toMatch(PEM_LEAK);
      const [version] = await dbClient.db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, versionId));
      expect(version!.status).toBe("applying");
      expect((await domainRow("www.hotel.it")).certMode).toBe("acme");

      const [audit] = await audits("site.tls_certificate.assign");
      const { outcome: _o, requestId: _r, ...details } = audit!.details as Json;
      expect(details).toEqual({ operationId: op!.id, siteId: siteA, domainIds: [domainId], versionId, fromVersionIds: [] });
    });

    it("replays the same key without a second operation, refuses the same key with another body, and requires the key", async () => {
      const { versionId } = await importOk(["www.hotel.it"]);
      const domainId = (await domainRow("www.hotel.it")).id;
      const body = { mode: "manual", versionId };
      expect((await domainTls(domainId, body, tokenA, { key: "a-1" })).status).toBe(202);
      expect((await domainTls(domainId, body, tokenA, { key: "a-1" })).status).toBe(202);
      expect(await tlsOps()).toHaveLength(1);
      expect(await audits("site.tls_certificate.assign")).toHaveLength(1);
      const conflict = await domainTls(domainId, { mode: "acme" }, tokenA, { key: "a-1" });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect((await domainTls(domainId, body, tokenA, { key: null })).status).toBe(400);
    });

    it("refuses a version that does not cover the domain, an expiring one, and one that reaches another organisation", async () => {
      const { versionId } = await importOk(["www.hotel.it"]);
      const hotel = (await domainRow("hotel.it")).id;
      const notCovered = await domainTls(hotel, { mode: "manual", versionId });
      expect(notCovered.status).toBe(422);
      expect(notCovered.body.error.code).toBe("CERTIFICATE_HOSTNAME_MISMATCH");
      expect(notCovered.body.error.details).toEqual([expect.objectContaining({ reason: "not_covered", message: "hotel.it" })]);

      const www = (await domainRow("www.hotel.it")).id;
      const soon = await plant(orgA, ["www.hotel.it"], { notAfterDays: 0.5 });
      const expiring = await domainTls(www, { mode: "manual", versionId: soon.versionId });
      expect(expiring.status).toBe(422);
      expect(expiring.body.error.code).toBe("CERTIFICATE_EXPIRED");

      const reaching = await plant(orgA, ["www.hotel.it", "bar.it"]);
      const foreign = await domainTls(www, { mode: "manual", versionId: reaching.versionId });
      expect(foreign.status).toBe(409);
      expect(foreign.body.error.code).toBe("DOMAIN_CONFLICT");
      expect(foreign.raw).not.toContain("bar.it");
      expect(await tlsOps()).toHaveLength(0);
    });

    it("answers 202 without an operation when the domain already is in that state", async () => {
      const www = (await domainRow("www.hotel.it")).id;
      const res = await domainTls(www, { mode: "acme" });
      expect(res.status).toBe(202);
      expect(await tlsOps()).toHaveLength(0);
    });

    it("keeps the eviction fields for the administrator: a customer sending them gets 400", async () => {
      const { versionId } = await importOk(["www.hotel.it"]);
      const www = (await domainRow("www.hotel.it")).id;
      const res = await domainTls(www, { mode: "manual", versionId, evictAcme: true, confirmHostname: "www.hotel.it" });
      expect(res.status).toBe(400);
      expect(await tlsOps()).toHaveLength(0);
    });

    it("the administrator's evictAcme needs the exact hostname and is carried in the operation and the audit", async () => {
      const { versionId } = await importOk(["www.hotel.it"]);
      const www = (await domainRow("www.hotel.it")).id;
      const path = `/v1/admin/sites/${siteA}/domains/${www}/tls`;
      const wrong = await call("POST", path, { mode: "manual", versionId, evictAcme: true, confirmHostname: "hotel.it" }, adminToken);
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.details).toEqual([expect.objectContaining({ reason: "confirm_mismatch" })]);
      const unpaired = await call("POST", path, { mode: "manual", versionId, evictAcme: true }, adminToken);
      expect(unpaired.status).toBe(400);
      expect(await tlsOps()).toHaveLength(0);

      const ok = await call("POST", path, { mode: "manual", versionId, evictAcme: true, confirmHostname: "www.hotel.it" }, adminToken);
      expect(ok.body.error ?? null).toBeNull();
      expect(ok.status).toBe(202);
      const [event] = await dbClient.db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "operation.queued.site.tls.apply"));
      expect(event!.payload).toMatchObject({ evictAcme: true });
      const [audit] = await audits("site.tls_certificate.assign");
      expect(audit!.details).toMatchObject({ evictAcme: true, evicted: [], collateralHosts: [] });
      expect(audit!.organizationId).toBe(orgA);
    });

    it("activate: without domains it is a no-op, with domains it queues, and another site's domain is a 404", async () => {
      const { certificateId, versionId } = await importOk(["www.hotel.it"]);
      const activate = (body: object, siteId = siteA, org = orgA, as = tokenA) =>
        call("POST", `${certs(org, siteId)}/${certificateId}/versions/${versionId}/activate`, body, as);
      const rotation = await activate({});
      expect(rotation.status).toBe(202);
      expect(await tlsOps()).toHaveLength(0);

      const bar = (await domainRow("bar.it")).id;
      expect((await activate({ domainIds: [bar] })).status).toBe(404);
      expect((await activate({ domainIds: [] })).status).toBe(400);

      const www = (await domainRow("www.hotel.it")).id;
      const ok = await activate({ domainIds: [www] });
      expect(ok.status).toBe(202);
      const [event] = await dbClient.db.select().from(outboxEvents).where(eq(outboxEvents.eventType, "operation.queued.site.tls.apply"));
      expect(event!.payload).toMatchObject({ changes: [{ domainId: www, versionId }] });
      // A version of another certificate, or an unknown one, is a 404.
      expect((await call("POST", `${certs()}/${certificateId}/versions/ctv_${"0".repeat(32)}/activate`, {})).status).toBe(404);
    });
  });

  describe("delete", () => {
    it("removes an unused certificate and its versions (204), audits ids and fingerprints, and bumps the generation", async () => {
      const { certificateId, versionId, dto } = await importOk(["www.hotel.it"]);
      const before = await generation();
      const res = await call("DELETE", `${certs()}/${certificateId}`);
      expect(res.status).toBe(204);
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(0);
      expect(await dbClient.db.select().from(tlsCertificateVersions)).toHaveLength(0);
      expect(await generation()).toBe(before + 1);
      const [audit] = await audits("site.tls_certificate.delete");
      expect(audit!.details).toMatchObject({ certificateId, versionIds: [versionId], fingerprints: [dto.versions[0].fingerprintSha256] });
      expect((await call("GET", `${certs()}/${certificateId}`)).status).toBe(404);
    });

    it("refuses while a domain uses it, while a version is applying or active, with CERTIFICATE_IN_USE", async () => {
      const { certificateId, versionId } = await importOk(["www.hotel.it"]);
      await dbClient.db.update(tlsCertificateVersions).set({ status: "applying" }).where(eq(tlsCertificateVersions.id, versionId));
      expect((await call("DELETE", `${certs()}/${certificateId}`)).body.error.code).toBe("CERTIFICATE_IN_USE");
      await dbClient.db.update(tlsCertificateVersions).set({ status: "active" }).where(eq(tlsCertificateVersions.id, versionId));
      await dbClient.db.update(domains).set({ certMode: "manual", manualCertificateVersionId: versionId, certStatus: "active" }).where(eq(domains.hostname, "www.hotel.it"));
      const res = await call("DELETE", `${certs()}/${certificateId}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CERTIFICATE_IN_USE");
      expect(await dbClient.db.select().from(tlsCertificates)).toHaveLength(1);
      expect(await audits("site.tls_certificate.delete")).toHaveLength(0);
    });
  });

  describe("administrator", () => {
    it("imports into the owner's organisation, lists, gets, replaces and deletes through the site routes", async () => {
      const leaf = leafFor(["www.hotel.it"]);
      const created = await call("POST", adminCerts(), uploadOf(leaf), adminToken);
      expect(created.status).toBe(201);
      const certificateId = created.body.data.id as string;
      const [row] = await dbClient.db.select().from(tlsCertificates);
      expect(row).toMatchObject({ organizationId: orgA, createdForSiteId: siteA });
      expect((await audits("site.tls_certificate.import"))[0]).toMatchObject({ organizationId: orgA });
      expect((await call("GET", adminCerts(), undefined, adminToken)).body.data).toHaveLength(1);
      expect((await call("GET", `${adminCerts()}/${certificateId}`, undefined, adminToken)).status).toBe(200);
      const next = await call("POST", `${adminCerts()}/${certificateId}/versions`, (({ name: _n, ...rest }) => rest)(uploadOf(leafFor(["www.hotel.it"]))), adminToken);
      expect(next.status).toBe(201);
      expect(next.body.data.versions).toHaveLength(2);
      expect((await call("DELETE", `${adminCerts()}/${certificateId}`, undefined, adminToken)).status).toBe(204);
      expect((await call("POST", adminCerts("site_missing"), uploadOf(leaf), adminToken)).status).toBe(404);
      // The customer routes of the administrator's own session are not a back door: the admin is no member.
      expect((await call("GET", certs(), undefined, adminToken)).status).toBe(404);
    });

    it("lists the inventory with filter and q, and the alerts of near-expiry imports", async () => {
      const soon = await plant(orgA, ["www.hotel.it"], { status: "active", notAfterDays: 5 });
      await dbClient.db.update(domains).set({ certMode: "manual", manualCertificateVersionId: soon.versionId, certStatus: "active" }).where(eq(domains.hostname, "www.hotel.it"));
      await plant(orgB, ["bar.it"], { status: "active", notAfterDays: 20 });
      await plant(orgB, ["gone.bar.it"], { status: "inactive", notAfterDays: -2 });
      await dbClient.db.update(domains).set({ certStatus: "active", certExpiresAt: new Date(Date.now() + 60 * DAY) }).where(eq(domains.hostname, "hotel.it"));

      const all = await call("GET", "/v1/admin/tls-certificates", undefined, adminToken);
      expect(all.status).toBe(200);
      expect(all.body.data.map((i: Json) => [i.source, i.hostnames[0], i.tier])).toEqual([
        ["manual", "gone.bar.it", "expired"],
        ["manual", "www.hotel.it", "critical"],
        ["manual", "bar.it", "notice"],
        ["acme", "hotel.it", "ok"],
      ]);
      const item = all.body.data[1] as Json;
      expect(item).toMatchObject({ source: "manual", organizationId: orgA, organizationName: "Hotel Mario", status: "active", wildcard: false });
      expect(Object.keys(item).sort()).toEqual(
        ["certificateId", "hostnames", "issuer", "name", "notAfter", "organizationId", "organizationName", "siteId", "siteName", "source", "status", "tier", "wildcard"].sort(),
      );
      const names = async (query: string) =>
        ((await call("GET", `/v1/admin/tls-certificates${query}`, undefined, adminToken)).body.data as Json[]).map((i) => i.hostnames[0]);
      expect(await names("?filter=manual")).toEqual(["gone.bar.it", "www.hotel.it", "bar.it"]);
      expect(await names("?filter=automatic")).toEqual(["hotel.it"]);
      expect(await names("?filter=expired")).toEqual(["gone.bar.it"]);
      expect(await names("?filter=expiring")).toEqual(["www.hotel.it", "bar.it"]);
      expect(await names("?q=BAR.IT")).toEqual(["gone.bar.it", "bar.it"]);
      expect(await names("?q=planted%20ca")).toEqual(["gone.bar.it", "www.hotel.it", "bar.it"]);
      expect((await call("GET", "/v1/admin/tls-certificates?filter=bogus", undefined, adminToken)).status).toBe(400);

      const alerts = await call("GET", "/v1/admin/tls-certificates/alerts", undefined, adminToken);
      expect(alerts.status).toBe(200);
      expect(alerts.body.data).toEqual([
        expect.objectContaining({ versionId: soon.versionId, tier: "critical", hostnames: ["www.hotel.it"], siteId: siteA, organizationId: orgA }),
      ]);
    });

    it("deletes by id for any organisation and 404s an unknown one; a customer is refused", async () => {
      const { certificateId } = await importOk(["www.hotel.it"]);
      expect((await call("DELETE", `/v1/admin/tls-certificates/${certificateId}`, undefined, tokenA)).status).toBe(403);
      expect((await call("GET", "/v1/admin/tls-certificates", undefined, tokenA)).status).toBe(403);
      expect((await call("DELETE", `/v1/admin/tls-certificates/cti_${"f".repeat(32)}`, undefined, adminToken)).status).toBe(404);
      expect((await call("DELETE", `/v1/admin/tls-certificates/${certificateId}`, undefined, adminToken)).status).toBe(204);
      expect((await audits("site.tls_certificate.delete"))[0]).toMatchObject({ organizationId: orgA });
    });
  });
});

describe("canonicalRequestHash", () => {
  it("ignores key order at every depth and undefined members, and is a SHA-256 hex", () => {
    const a = canonicalRequestHash({ route: "x", body: { b: 1, a: [{ d: 1, c: 2 }] }, skipped: undefined });
    const b = canonicalRequestHash({ body: { a: [{ c: 2, d: 1 }], b: 1 }, route: "x" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it("changes with a value, an array order, a type or a route", () => {
    const base = canonicalRequestHash({ route: "x", ids: ["a", "b"], n: 1 });
    expect(canonicalRequestHash({ route: "y", ids: ["a", "b"], n: 1 })).not.toBe(base);
    expect(canonicalRequestHash({ route: "x", ids: ["b", "a"], n: 1 })).not.toBe(base);
    expect(canonicalRequestHash({ route: "x", ids: ["a", "b"], n: "1" })).not.toBe(base);
  });
});
