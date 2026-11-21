import { randomUUID } from "node:crypto";
import { SiteDomainsDtoSchema, TLS_VERSION_PROBLEMS, type TlsVersionProblem } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  domains,
  eq,
  inArray,
  tlsCertificateVersions,
  tlsCertificates,
  type DatabaseClient,
  type DomainRow,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
  includeWww: true,
};
const LEAF_MARKER = "LEAF-MARKER-NOT-FOR-DTOS";
const ACME_TLS = { mode: "acme", certificateId: null, versionId: null, state: null, problem: null };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("site domain DTO tls block", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let token: string;
  let adminToken: string;
  let orgId: string;
  let siteId: string;

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

  async function call(method: string, path: string, body?: unknown, as: string = token) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const customerList = () => call("GET", `/v1/organizations/${orgId}/managed-sites/${siteId}/domains`);
  const adminList = () => call("GET", `/v1/admin/sites/${siteId}/domains`, undefined, adminToken);
  const tlsOf = (body: Json, hostname: string) =>
    (body.data.domains as Json[]).find((d) => d.hostname === hostname)!.tls;

  /** An imported certificate with one version; returns the ids. */
  async function importVersion(over: { lastErrorCode?: TlsVersionProblem | null; organizationId?: string } = {}) {
    const organizationId = over.organizationId ?? orgId;
    const certificateId = `cti_${randomUUID().replace(/-/g, "")}`;
    const versionId = `ctv_${randomUUID().replace(/-/g, "")}`;
    await dbClient.db.insert(tlsCertificates).values({ id: certificateId, organizationId, name: "hotel", createdForSiteId: siteId });
    await dbClient.db.insert(tlsCertificateVersions).values({
      id: versionId,
      certificateId,
      organizationId,
      versionNumber: 1,
      leafPem: LEAF_MARKER,
      chainPem: "",
      keyCiphertextBase64: "KEY-CIPHERTEXT-MARKER",
      keyIvBase64: "i",
      keyAuthTagBase64: "t",
      subject: "CN=www.hotel.it",
      issuer: "CN=CA",
      serialNumber: "01",
      fingerprintSha256: randomUUID().replace(/-/g, "").repeat(2),
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 30 * 86_400_000),
      sanDns: ["www.hotel.it"],
      keyType: "ec",
      keyBits: 256,
      status: "active",
      lastErrorCode: over.lastErrorCode ?? null,
    });
    return { certificateId, versionId };
  }

  const makeManual = (hostname: string, versionId: string, certStatus: DomainRow["certStatus"]) =>
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
    const created = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" },
      adminToken,
    );
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgId = created.body.data.organizationId as string;
    token = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, SITE);
    expect(site.status).toBe(202);
    siteId = site.body.data.siteId as string;
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("an automatic domain carries the null tls block on the customer and the admin route", async () => {
    for (const res of [await customerList(), await adminList()]) {
      expect(res.status).toBe(200);
      expect(res.body.data.domains).toHaveLength(2);
      for (const d of res.body.data.domains as Json[]) expect(d.tls).toEqual(ACME_TLS);
      expect(SiteDomainsDtoSchema.safeParse(res.body.data).success).toBe(true);
    }
  });

  it("a manual domain carries the certificate and version ids beside the untouched automatic one", async () => {
    const { certificateId, versionId } = await importVersion();
    await makeManual("www.hotel.it", versionId, "active");

    for (const res of [await customerList(), await adminList()]) {
      expect(res.status).toBe(200);
      expect(tlsOf(res.body, "www.hotel.it")).toEqual({ mode: "manual", certificateId, versionId, state: "active", problem: null });
      expect(tlsOf(res.body, "hotel.it")).toEqual(ACME_TLS);
      expect(SiteDomainsDtoSchema.safeParse(res.body.data).success).toBe(true);
    }
  });

  it("the state follows cert_status: none and requested apply, active and failed pass through", async () => {
    const { certificateId, versionId } = await importVersion();
    const expected = { none: "applying", requested: "applying", active: "active", failed: "failed" } as const;
    for (const [certStatus, state] of Object.entries(expected) as [DomainRow["certStatus"], string][]) {
      await makeManual("www.hotel.it", versionId, certStatus);
      for (const res of [await customerList(), await adminList()]) {
        expect(tlsOf(res.body, "www.hotel.it")).toEqual({ mode: "manual", certificateId, versionId, state, problem: null });
      }
    }
  });

  it("the problem is the version's last_error_code, and a cleared code gives null again", async () => {
    const { certificateId, versionId } = await importVersion({ lastErrorCode: "apply_failed" });
    await makeManual("www.hotel.it", versionId, "failed");
    for (const res of [await customerList(), await adminList()]) {
      expect(tlsOf(res.body, "www.hotel.it")).toEqual({ mode: "manual", certificateId, versionId, state: "failed", problem: "apply_failed" });
    }
    await dbClient.db.update(tlsCertificateVersions).set({ lastErrorCode: null }).where(eq(tlsCertificateVersions.id, versionId));
    expect(tlsOf((await customerList()).body, "www.hotel.it").problem).toBeNull();
  });

  it("every stored problem slug is accepted by the response contract", async () => {
    for (const problem of TLS_VERSION_PROBLEMS) {
      const { versionId } = await importVersion({ lastErrorCode: problem });
      await makeManual("www.hotel.it", versionId, "failed");
      const res = await customerList();
      expect(tlsOf(res.body, "www.hotel.it").problem).toBe(problem);
      expect(SiteDomainsDtoSchema.safeParse(res.body.data).success).toBe(true);
    }
  });

  it("adding a domain with a tlsVersionId on an address that is not routed yet is refused on both routes, and nothing is created", async () => {
    const { versionId } = await importVersion();
    const body = { hostname: "shop.hotel.it", includeWww: true, tlsVersionId: versionId };
    const customerAdd = await call("POST", `/v1/organizations/${orgId}/managed-sites/${siteId}/domains`, body);
    const adminAdd = await call("POST", `/v1/admin/sites/${siteId}/domains`, body, adminToken);
    for (const res of [customerAdd, adminAdd]) {
      // The site is still being set up, so the new address cannot be routed on a certificate yet (the real flow:
      // tls-domain-side-effects.integration.test.ts).
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details).toEqual([expect.objectContaining({ reason: "domain_not_active" })]);
      expect(res.raw).not.toContain(versionId);
    }
    for (const res of [await customerList(), await adminList()]) {
      expect((res.body.data.domains as Json[]).map((d) => d.hostname).sort()).toEqual(["hotel.it", "www.hotel.it"]);
    }
    const audits = await dbClient.db.select({ action: auditEvents.action }).from(auditEvents).where(inArray(auditEvents.action, ["site.domain.add", "admin.site.domain.add"]));
    expect(audits).toEqual([]);
    // The same request without the field still adds the domain (an automatic one).
    const plain = await call("POST", `/v1/organizations/${orgId}/managed-sites/${siteId}/domains`, { hostname: "shop.hotel.it" });
    expect(plain.status).toBe(201);
    expect(tlsOf(plain.body, "shop.hotel.it")).toEqual(ACME_TLS);
  });

  it("no certificate or key material reaches the response", async () => {
    const { versionId } = await importVersion({ lastErrorCode: "sni_mismatch" });
    await makeManual("www.hotel.it", versionId, "active");
    for (const res of [await customerList(), await adminList()]) {
      expect(res.raw).not.toContain(LEAF_MARKER);
      expect(res.raw).not.toContain("KEY-CIPHERTEXT-MARKER");
      expect(res.raw).not.toMatch(/BEGIN [A-Z ]*(CERTIFICATE|PRIVATE KEY)/);
      expect(Object.keys(tlsOf(res.body, "www.hotel.it")).sort()).toEqual(["certificateId", "mode", "problem", "state", "versionId"]);
    }
  });
});
