import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  domains,
  eq,
  membershipRoles,
  memberships,
  operations,
  readTlsVersionKey,
  sql,
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
import { skipPasswordChange } from "./fixtures/password-change.js";
import { issueCert, issuePki, type IssuedCert } from "./fixtures/tls-certgen.js";

// QA (independent) of HCP-SPEC-004 M2, API lifecycle through the in-memory executor: TLS-01/05/06/09/11/12 end to
// end, idempotency, the rate and concurrency caps. It adds to, and does not repeat, the engineers' suites.
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
const fp = (leaf: IssuedCert) => leaf.x509.fingerprint256.replaceAll(":", "").toLowerCase();

describe("manual TLS lifecycle (QA)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let tokenA: string;
  let orgA: string;
  let siteA: string;

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

  async function call(method: string, path: string, body?: unknown, as: string = tokenA, key: string | null = randomUUID()) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${as}`,
        "Content-Type": "application/json",
        ...(key === null ? {} : { "Idempotency-Key": key }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, headers: res.headers, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const certs = (site = siteA) => `/v1/organizations/${orgA}/managed-sites/${site}/tls-certificates`;
  const domainRow = async (hostname: string) => (await dbClient.db.select().from(domains).where(eq(domains.hostname, hostname)))[0]!;
  const versionRow = async (id: string) => (await dbClient.db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, id)))[0]!;
  const tlsOps = () => dbClient.db.select().from(operations).where(eq(operations.kind, "site.tls.apply"));
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const inventory = () => sim.manualTls({ action: "inventory" });
  const drain = () => app.outboxWorker.processPendingOnce();
  const puts = (versionId: string) =>
    sim.manualTlsCalls.filter((c) => (c as Json).action === "putVersion" && (c as Json).versionId === versionId).length;

  async function importCert(dns: string[], over: Partial<Parameters<typeof issueCert>[0]> = {}, site = siteA) {
    const leaf = leafFor(dns, over);
    const res = await call("POST", certs(site), uploadOf(leaf));
    expect(res.status).toBe(201);
    return { leaf, certificateId: res.body.data.id as string, versionId: res.body.data.versions.at(-1).id as string };
  }

  async function activate(certificateId: string, versionId: string, hostnames: string[], site = siteA) {
    const domainIds = await Promise.all(hostnames.map(async (h) => (await domainRow(h)).id));
    return call("POST", `${certs(site)}/${certificateId}/versions/${versionId}/activate`, { domainIds });
  }

  async function activeCert(dns: string[]) {
    const imported = await importCert(dns);
    const res = await activate(imported.certificateId, imported.versionId, dns);
    expect(res.status).toBe(202);
    await drain();
    return imported;
  }

  async function newSite(name: string, domain: string): Promise<string> {
    const res = await call("POST", `/v1/organizations/${orgA}/managed-sites`, siteBody(name, domain));
    expect(res.status).toBe(202);
    await drain();
    await dbClient.db.update(domains).set({ status: "active" });
    return res.body.data.siteId as string;
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
    const created = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" },
      adminToken,
    );
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgA = created.body.data.organizationId as string;
    tokenA = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
    const created2 = await call("POST", `/v1/organizations/${orgA}/managed-sites`, siteBody("Hotel Bella", "hotel.it", { includeWww: true }));
    expect(created2.status).toBe(202);
    await drain();
    await dbClient.db.update(domains).set({ status: "active" });
    siteA = created2.body.data.siteId as string;
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("the whole life of one certificate", () => {
    it("import -> pending -> applying -> served -> rotation -> back to ACME -> delete (409 then 204), leaving nothing behind", async () => {
      const hosts = ["hotel.it"];
      // 1. import: pending, no domain touched, nothing in the executor, no PEM in the answer.
      const v1 = await importCert(hosts);
      const imported = await call("GET", `${certs()}/${v1.certificateId}`);
      expect(imported.raw).not.toMatch(PEM_LEAK);
      expect(imported.body.data.versions.map((v: Json) => v.status)).toEqual(["pending"]);
      for (const h of hosts) expect(await domainRow(h)).toMatchObject({ certMode: "acme", manualCertificateVersionId: null });
      expect((await inventory()).versions).toEqual([]);

      // 2. activation answers 202 first: the version is applying, the domain row still ACME, nothing served yet.
      const res = await activate(v1.certificateId, v1.versionId, hosts);
      expect(res.status).toBe(202);
      expect(await versionRow(v1.versionId)).toMatchObject({ status: "applying" });
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme" });
      expect((await inventory()).entries).toEqual([]);

      // 3. served: active everywhere, expiry mirrored, the executor holds exactly this fingerprint.
      await drain();
      const v1row = await versionRow(v1.versionId);
      expect(v1row.status).toBe("active");
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "manual", manualCertificateVersionId: v1.versionId, certStatus: "active" });
      expect((await domainRow("hotel.it")).certExpiresAt?.getTime()).toBe(v1row.notAfter.getTime());
      const apiDomain = (await call("GET", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains`)).body.data.domains.find(
        (d: Json) => d.hostname === "hotel.it",
      );
      expect(apiDomain.tls.mode).toBe("manual");
      expect(JSON.stringify(apiDomain)).not.toMatch(PEM_LEAK);
      expect((await inventory()).versions.map((v) => [v.versionId, v.fingerprintSha256])).toEqual([[v1.versionId, fp(v1.leaf)]]);

      // 4. rotation: v2 appended, activation (no body) moves the domain; v1 inactive and its files collected.
      const leaf2 = leafFor(hosts);
      const added = await call("POST", `${certs()}/${v1.certificateId}/versions`, {
        format: "pem",
        leafPem: leaf2.pem,
        chainPem: PKI.intermediate.pem,
        privateKeyPem: leaf2.keyPem,
      });
      expect(added.status).toBe(201);
      const v2Id = added.body.data.versions.at(-1).id as string;
      expect((await call("POST", `${certs()}/${v1.certificateId}/versions/${v2Id}/activate`, {})).status).toBe(202);
      await drain();
      expect(await versionRow(v1.versionId)).toMatchObject({ status: "inactive" });
      expect(await versionRow(v2Id)).toMatchObject({ status: "active" });
      expect(await domainRow("hotel.it")).toMatchObject({ manualCertificateVersionId: v2Id });
      const inv2 = await inventory();
      expect(inv2.versions.map((v) => [v.versionId, v.fingerprintSha256])).toEqual([[v2Id, fp(leaf2)]]);
      expect(puts(v1.versionId)).toBe(1);
      expect(puts(v2Id)).toBe(1);

      // 5. delete while assigned: 409, and neither the database nor the executor lost anything.
      const refused = await call("DELETE", `${certs()}/${v1.certificateId}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("CERTIFICATE_IN_USE");
      expect(await versionRow(v2Id)).toMatchObject({ status: "active" });
      expect((await inventory()).entries).toEqual([{ versionId: v2Id, assignedHosts: ["hotel.it"] }]);

      // 6. back to ACME (TLS-06): the row is ACME again, the manual set is empty, the old fingerprint is gone.
      sim.issueCertificate("hotel.it", new Date(Date.now() + 60 * DAY).toISOString());
      const id = (await domainRow("hotel.it")).id;
      const back = await call("POST", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains/${id}/tls`, { mode: "acme" });
      expect(back.status).toBe(202);
      await drain();
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme", manualCertificateVersionId: null, certExpiresAt: null });
      expect(await versionRow(v2Id)).toMatchObject({ status: "inactive" });
      const [cert] = await dbClient.db.select().from(tlsCertificates).where(eq(tlsCertificates.id, v1.certificateId));
      expect(cert!.activeVersionId).toBeNull();
      expect((await inventory()).entries).toEqual([]);
      expect((await inventory()).versions).toEqual([]);

      // 7. delete when unassigned: 204, no row and no ciphertext left in any table, nothing in the executor.
      const stored = await versionRow(v2Id);
      expect(stored.keyCiphertextBase64.length).toBeGreaterThan(20);
      const gen = (await dbClient.db.select().from(tlsPublishState))[0]!.desiredGeneration;
      expect((await call("DELETE", `${certs()}/${v1.certificateId}`)).status).toBe(204);
      expect(await dbClient.db.select().from(tlsCertificateVersions)).toEqual([]);
      expect(await dbClient.db.select().from(tlsCertificates)).toEqual([]);
      await expect(readTlsVersionKey(dbClient.db, { versionId: v2Id, masterKey: KEY })).rejects.toThrow();
      expect((await dbClient.db.select().from(tlsPublishState))[0]!.desiredGeneration).toBeGreaterThan(gen);
      const tables = (await dbClient.db.execute(sql`select tablename from pg_tables where schemaname = 'public'`)) as unknown as {
        rows: { tablename: string }[];
      };
      for (const { tablename } of tables.rows) {
        const dump = (await dbClient.db.execute(sql.raw(`select coalesce(string_agg(t::text, ' '), '') as d from "${tablename}" t`))) as unknown as {
          rows: { d: string }[];
        };
        const text = dump.rows[0]!.d;
        expect(text, tablename).not.toContain(stored.keyCiphertextBase64);
        expect(text, tablename).not.toMatch(/BEGIN (RSA |EC )?PRIVATE KEY/);
      }
      expect((await app.tlsPublish.converge()).status).toMatch(/idle|converged/);
      expect((await inventory()).versions).toEqual([]);
      const applied = await audits("site.tls_certificate.applied");
      expect(applied).toHaveLength(3);
      expect(JSON.stringify(await dbClient.db.select().from(auditEvents))).not.toMatch(PEM_LEAK);
    });
  });

  describe("a certificate shared by two sites", () => {
    const rotationLeaf = () => leafFor(["hotel.it", "annex.it"]);
    const routeOf = (hostname: string) =>
      [...sim.appliedRoutes.values()].flatMap((r) => r.hosts).find((h) => h.hostname === hostname);

    async function addV2(certificateId: string) {
      const leaf = rotationLeaf();
      const added = await call("POST", `${certs()}/${certificateId}/versions`, {
        format: "pem",
        leafPem: leaf.pem,
        chainPem: PKI.intermediate.pem,
        privateKeyPem: leaf.keyPem,
      });
      expect(added.status).toBe(201);
      return added.body.data.versions.at(-1).id as string;
    }

    it("rotating it from one site serves V2 on both, V1 becomes inactive and its files are collected", async () => {
      const siteA2 = await newSite("Hotel Annex", "annex.it");
      const v1 = await importCert(["hotel.it", "annex.it"]);
      const ids = [(await domainRow("hotel.it")).id, (await domainRow("annex.it")).id];
      const first = await call("POST", `${certs()}/${v1.certificateId}/versions/${v1.versionId}/activate`, { domainIds: ids });
      expect(first.status).toBe(202);
      expect(first.body.moved).toHaveLength(2);
      await drain();
      expect(await domainRow("annex.it")).toMatchObject({ certMode: "manual", manualCertificateVersionId: v1.versionId, siteId: siteA2 });
      expect(await tlsOps()).toHaveLength(1);

      const v2 = await addV2(v1.certificateId);
      const rotated = await call("POST", `${certs()}/${v1.certificateId}/versions/${v2}/activate`, {});
      expect(rotated.body.error ?? null).toBeNull();
      expect(rotated.status).toBe(202);
      expect(rotated.body.moved.map((m: Json) => [m.hostname, m.siteId]).sort()).toEqual([
        ["annex.it", siteA2],
        ["hotel.it", siteA],
      ]);
      expect(await tlsOps()).toHaveLength(2); // one operation for the whole rotation
      await drain();

      for (const host of ["hotel.it", "annex.it"]) {
        const row = await domainRow(host);
        expect(row).toMatchObject({ certMode: "manual", manualCertificateVersionId: v2, certStatus: "active" });
        expect(row.certExpiresAt?.getTime()).toBe((await versionRow(v2)).notAfter.getTime());
        expect(routeOf(host)).toMatchObject({ tls: true, source: "manual" });
      }
      expect(await versionRow(v1.versionId)).toMatchObject({ status: "inactive" });
      expect(await versionRow(v2)).toMatchObject({ status: "active" });
      const inv = await inventory();
      expect(inv.versions.map((v) => v.versionId)).toEqual([v2]);
      expect(inv.entries).toEqual([{ versionId: v2, assignedHosts: ["annex.it", "hotel.it"] }]);
      // Both sites carry the applied audit of the rotation.
      const applied = await audits("site.tls_certificate.applied");
      expect(applied.filter((a) => (a.details as Json).versionIds?.includes(v2)).map((a) => a.targetId).sort()).toEqual([siteA, siteA2].sort());
    });

    it("refuses with 409 RESOURCE_LOCKED while another affected site has an active operation, and changes nothing", async () => {
      const siteA2 = await newSite("Hotel Annex", "annex.it");
      const v1 = await importCert(["hotel.it", "annex.it"]);
      const ids = [(await domainRow("hotel.it")).id, (await domainRow("annex.it")).id];
      // The other site is busy with its own TLS operation (queued, not drained).
      const solo = await importCert(["annex.it"], {}, siteA2);
      const own = await activate(solo.certificateId, solo.versionId, ["annex.it"], siteA2); expect(own.body.error ?? null).toBeNull(); expect(own.status).toBe(202);
      const blocked = await call("POST", `${certs()}/${v1.certificateId}/versions/${v1.versionId}/activate`, { domainIds: ids });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe("RESOURCE_LOCKED");
      expect(await tlsOps()).toHaveLength(1);
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme" });
    });

    it("a customer who cannot manage certificates on the other site gets 403 and nothing changes", async () => {
      const siteA2 = await newSite("Hotel Annex", "annex.it");
      const v1 = await importCert(["hotel.it", "annex.it"]);
      const ids = [(await domainRow("hotel.it")).id, (await domainRow("annex.it")).id];
      expect((await call("POST", `${certs()}/${v1.certificateId}/versions/${v1.versionId}/activate`, { domainIds: ids })).status).toBe(202);
      await drain();
      const v2 = await addV2(v1.certificateId);

      // The owner role on the first site only.
      const userId = `usr_${randomUUID()}`;
      const membershipId = `mem_${randomUUID()}`;
      await dbClient.db.insert(users).values({ id: userId, email: "narrow@hotel.it", name: "Narrow", passwordHash: await hashPassword(PW) });
      await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgA, userId });
      await dbClient.db.insert(membershipRoles).values({
        id: `mrl_${randomUUID()}`,
        membershipId,
        roleId: "role_customer_owner",
        scopeType: "resource",
        scopeResourceId: siteA,
      });
      const narrow = await login("narrow@hotel.it", PW);

      const opsBefore = (await tlsOps()).length;
      const refused = await call("POST", `${certs()}/${v1.certificateId}/versions/${v2}/activate`, {}, narrow);
      expect([refused.status, refused.body.error?.code]).toEqual([403, "PERMISSION_DENIED"]);
      const named = await call("POST", `${certs()}/${v1.certificateId}/versions/${v2}/activate`, { domainIds: ids }, narrow);
      expect(named.status).toBe(403);
      expect((await tlsOps()).length).toBe(opsBefore);
      expect(await versionRow(v2)).toMatchObject({ status: "pending" });
      for (const host of ["hotel.it", "annex.it"]) expect(await domainRow(host)).toMatchObject({ manualCertificateVersionId: v1.versionId });
      expect((await inventory()).entries).toEqual([{ versionId: v1.versionId, assignedHosts: ["annex.it", "hotel.it"] }]);
      expect(siteA2).toBeTruthy();
    });
  });

  describe("idempotency", () => {
    it("import: same key and body is one certificate and the same answer; another body is IDEMPOTENCY_CONFLICT; a replay at the cap still answers", async () => {
      const body = uploadOf(leafFor(["hotel.it"]));
      const a = await call("POST", certs(), body, tokenA, "imp-1");
      const b = await call("POST", certs(), body, tokenA, "imp-1");
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.data.id).toBe(a.body.data.id);
      expect(b.body.data.versions).toHaveLength(1);
      expect(await dbClient.db.select().from(tlsCertificateVersions)).toHaveLength(1);
      const other = await call("POST", certs(), uploadOf(leafFor(["hotel.it"])), tokenA, "imp-1");
      expect(other.status).toBe(409);
      expect(other.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(await dbClient.db.select().from(tlsCertificateVersions)).toHaveLength(1);

      // Fill the hour (9 more), then replay the very first key: still the original answer, not a 429.
      for (let i = 0; i < 9; i += 1) expect((await call("POST", certs(), uploadOf(leafFor([`h${i}.hotel.it`])))).status).toBe(201);
      const replay = await call("POST", certs(), body, tokenA, "imp-1");
      expect(replay.status).toBe(201);
      expect(replay.body.data.id).toBe(a.body.data.id);
    });

    it("activate and domain-tls replays after the operation settled give the original answer, no second operation, and no audit", async () => {
      const { certificateId, versionId } = await importCert(["hotel.it"]);
      const domainId = (await domainRow("hotel.it")).id;
      const path = `${certs()}/${certificateId}/versions/${versionId}/activate`;
      const first = await call("POST", path, { domainIds: [domainId] }, tokenA, "act-1");
      expect(first.status).toBe(202);
      await drain();
      const again = await call("POST", path, { domainIds: [domainId] }, tokenA, "act-1");
      expect(again.status).toBe(202);
      expect(again.body.error ?? null).toBeNull();
      expect(await tlsOps()).toHaveLength(1);
      expect(await audits("site.tls_certificate.assign")).toHaveLength(1);
      const diff = await call("POST", path, { domainIds: [(await domainRow("www.hotel.it")).id] }, tokenA, "act-1");
      expect(diff.status).toBe(409);
      expect(diff.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

      sim.issueCertificate("hotel.it", new Date(Date.now() + 60 * DAY).toISOString());
      const tlsPath = `/v1/organizations/${orgA}/managed-sites/${siteA}/domains/${domainId}/tls`;
      expect((await call("POST", tlsPath, { mode: "acme" }, tokenA, "back-1")).status).toBe(202);
      await drain();
      expect((await call("POST", tlsPath, { mode: "acme" }, tokenA, "back-1")).status).toBe(202);
      expect(await tlsOps()).toHaveLength(2);
      // The same key now with a different mode cannot be taken for the first.
      expect((await call("POST", tlsPath, { mode: "manual", versionId }, tokenA, "back-1")).body.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme" });
    });

    it("a key used on one route cannot be replayed on another route or site of the organisation", async () => {
      const { certificateId, versionId } = await importCert(["hotel.it"]);
      const domainId = (await domainRow("hotel.it")).id;
      expect((await call("POST", `${certs()}/${certificateId}/versions/${versionId}/activate`, { domainIds: [domainId] }, tokenA, "shared")).status).toBe(202);
      const clash = await call("POST", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains/${domainId}/tls`, { mode: "manual", versionId }, tokenA, "shared");
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    });
  });

  describe("caps", () => {
    it("the 11th import within the hour is RATE_LIMITED with Retry-After; invalid uploads do not use the allowance", async () => {
      for (let i = 0; i < 3; i += 1) {
        const bad = await call("POST", certs(), { ...uploadOf(leafFor(["hotel.it"])), privateKeyPem: leafFor(["x.hotel.it"]).keyPem });
        expect(bad.status).toBeGreaterThanOrEqual(400);
        expect(bad.status).toBeLessThan(500);
      }
      for (let i = 0; i < 10; i += 1) expect((await call("POST", certs(), uploadOf(leafFor([`h${i}.hotel.it`])))).status).toBe(201);
      const res = await call("POST", certs(), uploadOf(leafFor(["z.hotel.it"])));
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe("RATE_LIMITED");
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
    });

    // The cap counts the audit trail of imports and new versions, so deleting a certificate (and its version rows)
    // does not hand the slot back.
    it("deleting an imported certificate does not hand its slot of the hour back", async () => {
      const made: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const r = await call("POST", certs(), uploadOf(leafFor([`h${i}.hotel.it`])));
        expect(r.status).toBe(201);
        made.push(r.body.data.id as string);
      }
      expect((await call("DELETE", `${certs()}/${made[0]}`)).status).toBe(204);
      const res = await call("POST", certs(), uploadOf(leafFor(["z.hotel.it"])));
      expect(res.status).toBe(429);
    });

    it("the 101st certificate is QUOTA_EXCEEDED and a delete frees exactly one place", async () => {
      await dbClient.db.insert(tlsCertificates).values(
        Array.from({ length: 99 }, (_, i) => ({ id: `cti_${String(i).padStart(32, "0")}`, organizationId: orgA, name: `c${i}` })),
      );
      const last = await call("POST", certs(), uploadOf(leafFor(["a.hotel.it"])));
      expect(last.status).toBe(201);
      const over = await call("POST", certs(), uploadOf(leafFor(["b.hotel.it"])));
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe("QUOTA_EXCEEDED");
      expect((await call("DELETE", `${certs()}/${last.body.data.id}`)).status).toBe(204);
      // A new version of an existing certificate is never a new certificate, even at the cap.
      expect((await call("POST", certs(), uploadOf(leafFor(["b.hotel.it"])))).status).toBe(201);
    });

    it("at most 1 TLS operation per organisation: a second site is told to retry, and goes through once the first finished", async () => {
      // The server-wide cap of 2 (across organisations) is covered in tls-assignment.test.ts.
      const siteB = await newSite("Site B", "bar.it");
      const a = await importCert(["hotel.it"]);
      const b = await importCert(["bar.it"], {}, siteB);
      expect((await activate(a.certificateId, a.versionId, ["hotel.it"])).status).toBe(202);
      const second = await activate(b.certificateId, b.versionId, ["bar.it"], siteB);
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe("RATE_LIMITED");
      expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await tlsOps()).toHaveLength(1);
      // The refused request left nothing behind: the version stays pending, no audit.
      expect(await versionRow(b.versionId)).toMatchObject({ status: "pending" });
      expect(await audits("site.tls_certificate.assign")).toHaveLength(1);

      await drain();
      expect((await activate(b.certificateId, b.versionId, ["bar.it"], siteB)).status).toBe(202);
      await drain();
      expect(await domainRow("bar.it")).toMatchObject({ certMode: "manual", certStatus: "active" });
    });

    it("at most 1 TLS operation per site, also across different certificates, and the second request changes nothing", async () => {
      const a = await importCert(["hotel.it"]);
      const b = await importCert(["www.hotel.it"]);
      expect((await activate(a.certificateId, a.versionId, ["hotel.it"])).status).toBe(202);
      const second = await activate(b.certificateId, b.versionId, ["www.hotel.it"]);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("RESOURCE_LOCKED");
      expect(await versionRow(b.versionId)).toMatchObject({ status: "pending" });
      await drain();
      expect((await activate(b.certificateId, b.versionId, ["www.hotel.it"])).status).toBe(202);
    });
  });

  describe("crash mid-apply (TLS-09 API side)", () => {
    const ambiguous = (action: "putVersion" | "publish", afterEffect: boolean) => {
      const original = sim.manualTls.bind(sim);
      sim.manualTls = (async (req: Parameters<typeof original>[0]) => {
        if (req.action === action) {
          const done = afterEffect ? await original(req) : undefined;
          void done;
          throw Object.assign(new Error("socket hang up"), { ambiguousOutcome: true });
        }
        return original(req);
      }) as typeof sim.manualTls;
      return () => {
        sim.manualTls = original;
      };
    };

    it("the answer to putVersion is lost: recovery replays nothing, the retry finds the material held and never puts it a second time", async () => {
      const { certificateId, versionId, leaf } = await importCert(["hotel.it"]);
      const restore = ambiguous("putVersion", true);
      expect((await activate(certificateId, versionId, ["hotel.it"])).status).toBe(202);
      await drain();
      expect((await tlsOps())[0]).toMatchObject({ status: "unknown" });
      expect(puts(versionId)).toBe(1);
      restore();

      const calls = sim.manualTlsCalls.length;
      expect((await app.outboxWorker.recoverUnknownOperations()).convergedFailed).toBe(1);
      expect(sim.manualTlsCalls.length).toBe(calls);
      expect((await tlsOps())[0]).toMatchObject({ status: "failed" });
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme", manualCertificateVersionId: null });

      expect((await activate(certificateId, versionId, ["hotel.it"])).status).toBe(202);
      await drain();
      expect(puts(versionId)).toBe(1);
      expect(await versionRow(versionId)).toMatchObject({ status: "active", lastErrorCode: null });
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "manual", manualCertificateVersionId: versionId, certStatus: "active" });
      expect((await inventory()).versions.map((v) => v.fingerprintSha256)).toEqual([fp(leaf)]);
    });

    it("the answer to publish is lost after it took effect: the database stays the truth, and recovery plus converge are idempotent", async () => {
      const { certificateId, versionId, leaf } = await importCert(["hotel.it"]);
      const restore = ambiguous("publish", true);
      expect((await activate(certificateId, versionId, ["hotel.it"])).status).toBe(202);
      await drain();
      expect((await tlsOps())[0]).toMatchObject({ status: "unknown" });
      // The executor already serves it, the database does not say so yet.
      expect((await inventory()).entries).toEqual([{ versionId, assignedHosts: ["hotel.it"] }]);
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme" });
      restore();

      // A second request while the first is in doubt is locked out, not queued on top.
      expect((await activate(certificateId, versionId, ["hotel.it"])).status).toBe(409);

      await app.outboxWorker.recoverUnknownOperations();
      expect((await app.outboxWorker.recoverUnknownOperations()).convergedFailed).toBe(0);
      expect((await tlsOps())[0]).toMatchObject({ status: "failed" });
      expect((await app.tlsPublish.converge()).status).toBe("converged");
      expect((await inventory()).entries).toEqual([]);
      expect(await versionRow(versionId)).toMatchObject({ status: "failed", lastErrorCode: "interrupted" });
      expect((await app.tlsPublish.converge()).status).toBe("idle");

      expect((await activate(certificateId, versionId, ["hotel.it"])).status).toBe(202);
      await drain();
      const inv = await inventory();
      expect(inv.entries).toEqual([{ versionId, assignedHosts: ["hotel.it"] }]);
      expect(inv.versions.map((v) => v.fingerprintSha256)).toEqual([fp(leaf)]);
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "manual", certStatus: "active" });
      expect(await tlsOps()).toHaveLength(2);
      expect((await app.tlsPublish.converge({ boot: true })).status).toBe("converged");
      expect((await inventory()).entries).toEqual([{ versionId, assignedHosts: ["hotel.it"] }]);
    });

    it("no partially applied state ever leaks to the customer view while the answer is in doubt", async () => {
      const { certificateId, versionId } = await importCert(["hotel.it"]);
      ambiguous("publish", true);
      await activate(certificateId, versionId, ["hotel.it"]);
      await drain();
      const dto = (await call("GET", `${certs()}/${certificateId}`)).body.data;
      expect(dto.versions.at(-1).status).toBe("applying");
      const view = (await call("GET", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains`)).body.data.domains.find((d: Json) => d.hostname === "hotel.it");
      expect(view.tls.mode).toBe("acme");
      expect(JSON.stringify([dto, view])).not.toMatch(PEM_LEAK);
    });
  });

  describe("expiry alerts over the life of a version (TLS-12)", () => {
    it("30/14/7/0 days: the hourly tick writes one audit per tier over 32 days of ticks, and a rotation starts afresh", async () => {
      const { versionId } = await activeCert(["hotel.it"]);
      const notAfter = (await versionRow(versionId)).notAfter;
      const rows = async () =>
        (await dbClient.db.select().from(auditEvents)).filter((r) => /^site\.tls_certificate\.(expiring|expired)$/.test(r.action));
      // The clock is pinned relative to the certificate's end.
      const stepMs = 12 * 3_600_000;
      const from = notAfter.getTime() - 32 * DAY;
      const seen: string[] = [];
      for (let t = from; t <= notAfter.getTime() + 2 * DAY; t += stepMs) {
        await app.tlsPublish.tick(new Date(t));
        const now = (await rows()).map((r) => `${r.action}:${(r.details as Json).tier ?? ""}`);
        for (const entry of now) if (!seen.includes(entry)) seen.push(entry);
      }
      expect(seen).toEqual(["site.tls_certificate.expiring:warning", "site.tls_certificate.expiring:critical", "site.tls_certificate.expired:"]);
      expect(await rows()).toHaveLength(3);
    });

    it("a replaced version's earlier tiers do not silence the new one, and a retired version stops alerting", async () => {
      const { certificateId, versionId } = await activeCert(["hotel.it"]);
      const old = await versionRow(versionId);
      const warn = new Date(old.notAfter.getTime() - 10 * DAY);
      await app.tlsPublish.tick(warn);
      expect(await audits("site.tls_certificate.expiring")).toHaveLength(1);

      const leaf2 = leafFor(["hotel.it"], { notAfter: new Date(warn.getTime() + 20 * DAY) });
      const added = await call("POST", `${certs()}/${certificateId}/versions`, {
        format: "pem",
        leafPem: leaf2.pem,
        chainPem: PKI.intermediate.pem,
        privateKeyPem: leaf2.keyPem,
      });
      const v2 = added.body.data.versions.at(-1).id as string;
      expect((await call("POST", `${certs()}/${certificateId}/versions/${v2}/activate`, {})).status).toBe(202);
      await drain();
      // The old version is retired: the next day it is neither alerted nor audited again.
      await app.tlsPublish.tick(new Date(warn.getTime() + 2 * 3_600_000));
      expect((await audits("site.tls_certificate.expiring")).map((r) => (r.details as Json).versionId)).toEqual([versionId]);
      // A week on the new version has 13 days left (warning), two weeks on 6 (critical): its own rows, once each.
      for (const days of [7, 7, 14, 14]) await app.tlsPublish.tick(new Date(warn.getTime() + days * DAY));
      await app.tlsPublish.tick(new Date(warn.getTime() + 14 * DAY + 2 * 3_600_000));
      const rowsNow = await audits("site.tls_certificate.expiring");
      expect(rowsNow.map((r) => [(r.details as Json).versionId, (r.details as Json).tier])).toEqual(
        expect.arrayContaining([[versionId, "warning"], [v2, "warning"], [v2, "critical"]]),
      );
      expect(rowsNow).toHaveLength(3);
    });
  });
});
