import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  desc,
  domains,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  sites,
  tlsCertificateVersions,
  tlsCertificates,
  tlsPublishState,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter, ManualTlsStoreError } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { issueCert, issuePki, type IssuedCert } from "./fixtures/tls-certgen.js";

// HCP-SPEC-004 (TLS-05/06/09) API side: the site.tls.apply applier, the publish convergence and the outbox wiring,
// through the in-memory executor (the same plan function as the real one). Certificates are real, Node-built X.509
// under a test root that the validator is told to trust; nothing here is committed key material.
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

describe("site.tls.apply, publish convergence and outbox wiring", () => {
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

  async function call(method: string, path: string, body?: unknown, as: string = tokenA) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, raw, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const certs = () => `/v1/organizations/${orgA}/managed-sites/${siteA}/tls-certificates`;
  const domainRow = async (hostname: string) => (await dbClient.db.select().from(domains).where(eq(domains.hostname, hostname)))[0]!;
  const versionRow = async (id: string) => (await dbClient.db.select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, id)))[0]!;
  const tlsOps = () => dbClient.db.select().from(operations).where(eq(operations.kind, "site.tls.apply")).orderBy(desc(operations.submittedAt));
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const state = async () => (await dbClient.db.select().from(tlsPublishState))[0]!;
  const inventory = () => sim.manualTls({ action: "inventory" });
  const drain = () => app.outboxWorker.processPendingOnce();
  const routeOf = (hostname: string) =>
    [...sim.appliedRoutes.values()].flatMap((r) => r.hosts).find((h) => h.hostname === hostname);

  async function importCert(dns: string[], over: Partial<Parameters<typeof issueCert>[0]> = {}) {
    const leaf = leafFor(dns, over);
    const res = await call("POST", certs(), uploadOf(leaf));
    expect(res.status).toBe(201);
    return { leaf, certificateId: res.body.data.id as string, versionId: res.body.data.versions.at(-1).id as string };
  }

  async function assign(versionId: string, hostnames: string[]) {
    const ids = await Promise.all(hostnames.map(async (h) => (await domainRow(h)).id));
    const res = await call("POST", `${certs()}/${(await versionRow(versionId)).certificateId}/versions/${versionId}/activate`, { domainIds: ids });
    expect(res.body.error ?? null).toBeNull();
    expect(res.status).toBe(202);
    await drain();
    return res;
  }

  /** Imports a certificate for the hosts, assigns it and lets the applier run. */
  async function activeCert(dns: string[], over: Partial<Parameters<typeof issueCert>[0]> = {}) {
    const imported = await importCert(dns, over);
    await assign(imported.versionId, dns);
    return imported;
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
    const site = await call("POST", `/v1/organizations/${orgA}/managed-sites`, siteBody("Hotel Bella", "hotel.it", { includeWww: true }));
    expect(site.status).toBe(202);
    await drain();
    siteA = site.body.data.siteId as string;
    await dbClient.db.update(domains).set({ status: "active" });
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("acme -> manual", () => {
    it("hands the key over just in time, publishes with the fingerprint, flips the rows and mirrors the certificate", async () => {
      const { leaf, certificateId, versionId } = await importCert(["hotel.it", "www.hotel.it"]);
      const before = await state();
      await assign(versionId, ["hotel.it", "www.hotel.it"]);

      const [op] = await tlsOps();
      expect(op).toMatchObject({ status: "succeeded", errorCode: null });
      const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, op!.id));
      expect(Object.fromEntries(steps.map((s) => [s.key, s.status]))).toEqual({ stage: "succeeded", publish: "succeeded", routes: "succeeded" });

      const version = await versionRow(versionId);
      expect(version).toMatchObject({ status: "active", lastErrorCode: null });
      expect(version.activatedAt).not.toBeNull();
      expect(version.publishGeneration).toBeGreaterThan(0);
      const [cert] = await dbClient.db.select().from(tlsCertificates).where(eq(tlsCertificates.id, certificateId));
      expect(cert!.activeVersionId).toBe(versionId);

      for (const host of ["hotel.it", "www.hotel.it"]) {
        const row = await domainRow(host);
        expect(row).toMatchObject({ certMode: "manual", manualCertificateVersionId: versionId, certStatus: "active", certProblem: null, certAttempts: 0 });
        expect(row.certExpiresAt?.getTime()).toBe(version.notAfter.getTime());
        // The WordPress address still has to move to https, so the first plan serves without redirects.
        expect(routeOf(host)).toMatchObject({ tls: true, httpsRedirect: false, source: "manual" });
      }
      // The reconciler finishes that switch (the stored plan hash keeps the old address) and then the redirects go out.
      await app.domainReconciler.reconcileOnce();
      await drain();
      for (const host of ["hotel.it", "www.hotel.it"]) {
        expect(routeOf(host)).toMatchObject({ tls: true, httpsRedirect: true, source: "manual" });
      }

      const inv = await inventory();
      expect(inv.versions.map((v) => [v.versionId, v.fingerprintSha256])).toEqual([[versionId, leaf.x509.fingerprint256.replaceAll(":", "").toLowerCase()]]);
      expect(inv.entries).toEqual([{ versionId, assignedHosts: ["hotel.it", "www.hotel.it"] }]);
      const after = await state();
      expect(after.confirmedGeneration).toBeGreaterThanOrEqual(before.desiredGeneration);
      expect((await audits("site.tls_certificate.applied"))[0]!.details).toMatchObject({ operationId: op!.id, versionIds: [versionId] });
      // The key travelled only on the putVersion call, which the simulator logs without material.
      expect(JSON.stringify(sim.manualTlsCalls)).not.toMatch(PEM_LEAK);
    });

    it("never lets the domain reconciler order, re-request or rewrite a manual host", async () => {
      const { versionId } = await activeCert(["hotel.it", "www.hotel.it"]);
      for (let i = 0; i < 3; i += 1) await app.domainReconciler.reconcileOnce();
      for (const host of ["hotel.it", "www.hotel.it"]) {
        expect(await domainRow(host)).toMatchObject({ certMode: "manual", manualCertificateVersionId: versionId, certStatus: "active", certProblem: null, certAttempts: 0 });
      }
    });

    it("refuses with SNI_MISMATCH when the proxy does not serve it (executor reverted): rows unchanged, version failed, apply_failed audited", async () => {
      sim.failManualTlsPublish("not_served_reverted");
      const { versionId } = await importCert(["hotel.it"]);
      await assign(versionId, ["hotel.it"]);

      const [op] = await tlsOps();
      expect(op).toMatchObject({ status: "failed", errorCode: "CERTIFICATE_SNI_MISMATCH" });
      expect(op!.errorMessage).toBe("The certificate change did not finish. Your site keeps the certificate it had.");
      expect(await versionRow(versionId)).toMatchObject({ status: "failed", lastErrorCode: "sni_mismatch" });
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme", manualCertificateVersionId: null });
      expect((await inventory()).entries).toEqual([]);
      const [failed] = await audits("site.tls_certificate.apply_failed");
      expect(failed!.details).toEqual({ operationId: op!.id, siteId: siteA, versionId, step: "publish", code: "CERTIFICATE_SNI_MISMATCH" });
      expect(failed!.actorId).toBeNull();

      // A retry after the failure works (failed -> applying -> active).
      await assign(versionId, ["hotel.it"]);
      expect((await tlsOps())[0]).toMatchObject({ status: "succeeded" });
      expect(await versionRow(versionId)).toMatchObject({ status: "active", lastErrorCode: null });
    });

    it("a change across two sites that is not served leaves both sites on ACME with their routes untouched", async () => {
      const created = await call("POST", `/v1/organizations/${orgA}/managed-sites`, siteBody("Hotel Annex", "annex.it"));
      expect(created.status).toBe(202);
      await drain();
      await dbClient.db.update(domains).set({ status: "active" });
      const siteA2 = created.body.data.siteId as string;
      const routesBefore = JSON.stringify([...sim.appliedRoutes.entries()]);
      sim.failManualTlsPublish("not_served_reverted");
      const { certificateId, versionId } = await importCert(["hotel.it", "annex.it"]);
      const domainIds = [(await domainRow("hotel.it")).id, (await domainRow("annex.it")).id];
      const res = await call("POST", `${certs()}/${certificateId}/versions/${versionId}/activate`, { domainIds });
      expect(res.status).toBe(202);
      await drain();

      expect((await tlsOps())[0]).toMatchObject({ status: "failed", errorCode: "CERTIFICATE_SNI_MISMATCH", resourceId: siteA });
      for (const host of ["hotel.it", "annex.it"]) expect(await domainRow(host)).toMatchObject({ certMode: "acme", manualCertificateVersionId: null });
      expect(await versionRow(versionId)).toMatchObject({ status: "failed" });
      expect(JSON.stringify([...sim.appliedRoutes.entries()])).toBe(routesBefore);
      expect((await inventory()).entries).toEqual([]);
      expect(siteA2).not.toBe(siteA);
    });

    it("an existing automatic certificate in the way: customer gets acme_eviction_required, the domain stays ACME; the administrator's confirmed switch evicts it", async () => {
      sim.issueCertificate("hotel.it", new Date(Date.now() + 60 * DAY).toISOString());
      const { versionId } = await importCert(["hotel.it"]);
      await assign(versionId, ["hotel.it"]);

      const [failedOp] = await tlsOps();
      expect(failedOp).toMatchObject({ status: "failed", errorCode: "CERTIFICATE_SNI_MISMATCH" });
      expect(await versionRow(versionId)).toMatchObject({ status: "failed", lastErrorCode: "acme_eviction_required" });
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme" });
      expect((await inventory()).acme).toHaveLength(1);

      const domainId = (await domainRow("hotel.it")).id;
      const res = await call("POST", `/v1/admin/sites/${siteA}/domains/${domainId}/tls`, { mode: "manual", versionId, evictAcme: true, confirmHostname: "hotel.it" }, adminToken);
      expect(res.body.error ?? null).toBeNull();
      expect(res.status).toBe(202);
      await drain();

      const [op] = await tlsOps();
      expect(op).toMatchObject({ status: "succeeded" });
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "manual", manualCertificateVersionId: versionId, certStatus: "active" });
      const inv = await inventory();
      expect(inv.acme).toEqual([]);
      expect(inv.entries).toEqual([{ versionId, assignedHosts: ["hotel.it"] }]);
      expect((await audits("site.tls_certificate.applied")).at(-1)!.details).toMatchObject({ evicted: [{ resolver: "le", main: "hotel.it" }] });
    });

    it("retries once on a manifest conflict and once on missing versions, then gives up with fixed text", async () => {
      const original = sim.manualTls.bind(sim);
      let publishes = 0;
      let puts = 0;
      sim.manualTls = (async (req: Parameters<typeof original>[0]) => {
        if (req.action === "putVersion") puts += 1;
        if (req.action === "publish") {
          publishes += 1;
          if (publishes === 1) throw new ManualTlsStoreError("TLS_MANIFEST_CONFLICT", "set changed");
          if (publishes === 2) throw new ManualTlsStoreError("TLS_VERSION_MISSING", "gone", ["ctv_x"]);
        }
        return original(req);
      }) as typeof sim.manualTls;
      const { versionId } = await importCert(["hotel.it"]);
      await assign(versionId, ["hotel.it"]);
      // One retry only: the second failure (missing versions) fails the run, without echoing the executor's text.
      const [op] = await tlsOps();
      expect(op).toMatchObject({ status: "failed", errorCode: "CERTIFICATE_APPLY_FAILED" });
      expect(op!.errorMessage).not.toContain("gone");
      expect(publishes).toBe(2);
      expect(puts).toBeGreaterThanOrEqual(1);

      publishes = 2; // third publish onwards passes through
      await assign(versionId, ["hotel.it"]);
      expect((await tlsOps())[0]).toMatchObject({ status: "succeeded" });
    });

    it("an executor error that carries key material never reaches the operation, steps, outbox or audit", async () => {
      const { leaf, versionId } = await importCert(["hotel.it"]);
      const original = sim.manualTls.bind(sim);
      sim.manualTls = (async (req: Parameters<typeof original>[0]) => {
        if (req.action === "publish") throw new Error(`proxy said no: ${leaf.keyPem}`);
        return original(req);
      }) as typeof sim.manualTls;
      await assign(versionId, ["hotel.it"]);

      const [op] = await tlsOps();
      expect(op).toMatchObject({ status: "failed", errorCode: "CERTIFICATE_APPLY_FAILED" });
      const everything = JSON.stringify([
        await dbClient.db.select().from(operations),
        await dbClient.db.select().from(operationSteps),
        await dbClient.db.select().from(outboxEvents),
        await dbClient.db.select().from(auditEvents),
      ]);
      expect(everything).not.toMatch(/PRIVATE KEY/);
      expect(everything).not.toContain(leaf.keyPem.replace(/-----[^-]+-----|\s+/g, "").slice(0, 40));
      expect(everything).not.toContain("proxy said no");
    });

    it("keeps one operation per site: a second change while one is queued is refused", async () => {
      const { versionId } = await importCert(["hotel.it"]);
      const certId = (await versionRow(versionId)).certificateId;
      const ids = [(await domainRow("hotel.it")).id];
      const first = await call("POST", `${certs()}/${certId}/versions/${versionId}/activate`, { domainIds: ids });
      expect(first.status).toBe(202);
      const second = await call("POST", `${certs()}/${certId}/versions/${versionId}/activate`, { domainIds: ids });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("RESOURCE_LOCKED");
      await drain();
      expect((await tlsOps())).toHaveLength(1);
    });
  });

  describe("crash recovery", () => {
    it("an answer lost mid-publish parks the run as unknown; recovery fails it read-only and the converge tick restores the stored set", async () => {
      const original = sim.manualTls.bind(sim);
      sim.manualTls = (async (req: Parameters<typeof original>[0]) => {
        if (req.action === "publish") throw Object.assign(new Error("socket hang up"), { ambiguousOutcome: true });
        return original(req);
      }) as typeof sim.manualTls;
      const { versionId } = await importCert(["hotel.it"]);
      await assign(versionId, ["hotel.it"]);

      expect((await tlsOps())[0]).toMatchObject({ status: "unknown" });
      expect(await versionRow(versionId)).toMatchObject({ status: "applying" });
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme" });

      sim.manualTls = original;
      const callsBefore = sim.manualTlsCalls.length;
      const recovery = await app.outboxWorker.recoverUnknownOperations();
      expect(recovery.convergedFailed).toBe(1);
      expect(sim.manualTlsCalls.length).toBe(callsBefore); // recovery replays nothing
      const [op] = await tlsOps();
      expect(op).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(op!.errorMessage).toBe("This certificate change was interrupted. Your site keeps the certificate it had.");

      const result = await app.tlsPublish.converge();
      expect(result.status).toBe("converged");
      expect(await versionRow(versionId)).toMatchObject({ status: "failed", lastErrorCode: "interrupted" });
      expect((await inventory()).entries).toEqual([]);
      expect((await app.tlsPublish.converge()).status).toBe("idle");
    });

    it("an answer lost while the routes switch: the next reconcile republishes the routes, because the applied hash no longer vouches for them", async () => {
      const original = sim.applySiteRoutes.bind(sim);
      let fail = true;
      sim.applySiteRoutes = (async (req: Parameters<typeof original>[0]) => {
        if (fail) throw Object.assign(new Error("socket hang up"), { ambiguousOutcome: true });
        return original(req);
      }) as typeof sim.applySiteRoutes;
      const acmeRoute = JSON.stringify(routeOf("hotel.it"));
      const { versionId } = await importCert(["hotel.it"]);
      await assign(versionId, ["hotel.it"]);
      expect((await tlsOps())[0]).toMatchObject({ status: "unknown" });
      expect((await dbClient.db.select().from(sites).where(eq(sites.id, siteA)))[0]!.appliedRoutesHash).toBeNull();

      fail = false;
      await app.outboxWorker.recoverUnknownOperations();
      await app.tlsPublish.converge();
      await app.domainReconciler.reconcileOnce();
      await drain();
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme" });
      expect(JSON.stringify(routeOf("hotel.it"))).toBe(acmeRoute);
      expect((await dbClient.db.select().from(sites).where(eq(sites.id, siteA)))[0]!.appliedRoutesHash).not.toBeNull();
    });

    it("an executor that is down at boot: the periodic tick retries the boot converge until it succeeds once", async () => {
      const { versionId } = await activeCert(["hotel.it", "www.hotel.it"]);
      const g = (await inventory()).generation;
      await sim.manualTls({ action: "publish", baseGeneration: g, entries: [], expect: [], evictAcme: false });
      const original = sim.manualTls.bind(sim);
      sim.manualTls = (async () => {
        throw new Error("executor down");
      }) as typeof sim.manualTls;
      app.tlsPublish.startBackgroundLoop(20);
      await new Promise((r) => setTimeout(r, 120));
      sim.manualTls = original;
      const until = Date.now() + 5_000;
      while ((await inventory()).entries.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      await app.tlsPublish.stop();
      expect((await inventory()).entries).toEqual([{ versionId, assignedHosts: ["hotel.it", "www.hotel.it"] }]);
    });

    it("a failed run after a cold eviction still audits what was evicted (ids and hostnames only)", async () => {
      sim.issueCertificate("hotel.it", new Date(Date.now() + 60 * DAY).toISOString());
      const { versionId } = await importCert(["hotel.it"]);
      const original = sim.applySiteRoutes.bind(sim);
      let fail = true;
      sim.applySiteRoutes = (async (req: Parameters<typeof original>[0]) => {
        if (fail) {
          fail = false;
          throw new Error("routes refused");
        }
        return original(req);
      }) as typeof sim.applySiteRoutes;
      const domainId = (await domainRow("hotel.it")).id;
      const res = await call("POST", `/v1/admin/sites/${siteA}/domains/${domainId}/tls`, { mode: "manual", versionId, evictAcme: true, confirmHostname: "hotel.it" }, adminToken);
      expect(res.status).toBe(202);
      await drain();
      expect((await tlsOps())[0]).toMatchObject({ status: "failed" });
      const failed = (await audits("site.tls_certificate.apply_failed")).at(-1)!;
      expect(failed.details).toMatchObject({ evicted: [{ resolver: "le", main: "hotel.it" }] });
      expect(JSON.stringify(failed.details)).not.toContain("routes refused");
    });

    it("an ambiguous executor error stores fixed text only: operation, steps, outbox and audit never carry what the executor said", async () => {
      const original = sim.manualTls.bind(sim);
      sim.manualTls = (async (req: Parameters<typeof original>[0]) => {
        if (req.action === "publish") throw Object.assign(new Error("proxy exploded QUJDREVGR0hJSktMTU5PUA=="), { ambiguousOutcome: true });
        return original(req);
      }) as typeof sim.manualTls;
      const { versionId } = await importCert(["hotel.it"]);
      await assign(versionId, ["hotel.it"]);
      expect((await tlsOps())[0]).toMatchObject({ status: "unknown", errorCode: "OPERATION_AMBIGUOUS" });
      const everything = JSON.stringify([
        await dbClient.db.select().from(operations),
        await dbClient.db.select().from(operationSteps),
        await dbClient.db.select().from(outboxEvents),
        await dbClient.db.select().from(auditEvents),
      ]);
      expect(everything).not.toContain("proxy exploded");
      expect(everything).not.toContain("QUJDREVG");
    });

    it("the boot converge republishes the stored set to an executor that lost it, and does nothing when they agree", async () => {
      const { versionId } = await activeCert(["hotel.it", "www.hotel.it"]);
      const g = (await inventory()).generation;
      await sim.manualTls({ action: "publish", baseGeneration: g, entries: [], expect: [], evictAcme: false });
      expect((await inventory()).entries).toEqual([]);

      expect((await app.tlsPublish.converge({ boot: true })).status).toBe("converged");
      expect((await inventory()).entries).toEqual([{ versionId, assignedHosts: ["hotel.it", "www.hotel.it"] }]);

      const calls = sim.manualTlsCalls.length;
      expect((await app.tlsPublish.converge({ boot: true })).status).toBe("converged");
      expect(sim.manualTlsCalls.slice(calls).map((c) => (c as { action: string }).action)).not.toContain("publish");
    });
  });

  describe("rotation and removal", () => {
    it("rotation moves every domain of the certificate to the new version, retires the old one and frees its files", async () => {
      const first = await activeCert(["hotel.it", "www.hotel.it"]);
      const leaf2 = leafFor(["hotel.it", "www.hotel.it"]);
      const v2 = await call("POST", `${certs()}/${first.certificateId}/versions`, {
        format: "pem",
        leafPem: leaf2.pem,
        chainPem: PKI.intermediate.pem,
        privateKeyPem: leaf2.keyPem,
      });
      expect(v2.status).toBe(201);
      const secondId = v2.body.data.versions.at(-1).id as string;
      const act = await call("POST", `${certs()}/${first.certificateId}/versions/${secondId}/activate`, {});
      expect(act.body.error ?? null).toBeNull();
      expect(act.status).toBe(202);
      await drain();

      expect((await tlsOps())[0]).toMatchObject({ status: "succeeded" });
      for (const host of ["hotel.it", "www.hotel.it"]) {
        expect(await domainRow(host)).toMatchObject({ certMode: "manual", manualCertificateVersionId: secondId, certStatus: "active" });
      }
      expect(await versionRow(first.versionId)).toMatchObject({ status: "inactive" });
      expect(await versionRow(secondId)).toMatchObject({ status: "active" });
      const [cert] = await dbClient.db.select().from(tlsCertificates).where(eq(tlsCertificates.id, first.certificateId));
      expect(cert!.activeVersionId).toBe(secondId);
      const inv = await inventory();
      expect(inv.entries).toEqual([{ versionId: secondId, assignedHosts: ["hotel.it", "www.hotel.it"] }]);
      expect(inv.versions.map((v) => v.versionId)).toEqual([secondId]); // gc removed the retired version's files
      expect((await audits("site.tls_certificate.applied")).at(-1)!.details).toMatchObject({ removedVersionIds: [first.versionId], inactivatedVersionIds: [first.versionId] });
    });

    it("manual -> acme asks for a new automatic certificate and takes the old one out of the store", async () => {
      const { versionId, certificateId } = await activeCert(["hotel.it"]);
      // The proxy answers with something else once the manual certificate leaves: the simulator needs an ACME entry.
      sim.issueCertificate("hotel.it", new Date(Date.now() + 60 * DAY).toISOString());
      const id = (await domainRow("hotel.it")).id;
      const res = await call("POST", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains/${id}/tls`, { mode: "acme" });
      expect(res.body.error ?? null).toBeNull();
      expect(res.status).toBe(202);
      await drain();

      expect((await tlsOps())[0]).toMatchObject({ status: "succeeded" });
      expect(await domainRow("hotel.it")).toMatchObject({ certMode: "acme", manualCertificateVersionId: null, certStatus: "requested", certExpiresAt: null });
      expect(routeOf("hotel.it")?.source).toBeUndefined();
      expect(await versionRow(versionId)).toMatchObject({ status: "inactive" });
      const [cert] = await dbClient.db.select().from(tlsCertificates).where(eq(tlsCertificates.id, certificateId));
      expect(cert!.activeVersionId).toBeNull();
      expect((await inventory()).entries).toEqual([]);
    });

    it("removing the domain that held a certificate converges: the version becomes inactive and the executor drops it", async () => {
      const { versionId, certificateId } = await activeCert(["www.hotel.it"]);
      const before = await state();
      const id = (await domainRow("www.hotel.it")).id;
      const res = await call("DELETE", `/v1/organizations/${orgA}/managed-sites/${siteA}/domains/${id}`);
      expect(res.status).toBe(200);
      expect((await state()).desiredGeneration).toBeGreaterThan(before.desiredGeneration);

      expect((await app.tlsPublish.converge()).status).toBe("converged");
      expect(await versionRow(versionId)).toMatchObject({ status: "inactive" });
      const [cert] = await dbClient.db.select().from(tlsCertificates).where(eq(tlsCertificates.id, certificateId));
      expect(cert!.activeVersionId).toBeNull();
      expect((await inventory()).entries).toEqual([]);
      const after = await state();
      expect(after.confirmedGeneration).toBeGreaterThanOrEqual(after.desiredGeneration);
      expect((await app.tlsPublish.converge()).status).toBe("idle");
    });

    it("does not converge while a certificate change is queued", async () => {
      const { versionId } = await importCert(["hotel.it"]);
      const certId = (await versionRow(versionId)).certificateId;
      await call("POST", `${certs()}/${certId}/versions/${versionId}/activate`, { domainIds: [(await domainRow("hotel.it")).id] });
      expect((await app.tlsPublish.converge({ boot: true })).status).toBe("busy");
      expect(await versionRow(versionId)).toMatchObject({ status: "applying" });
    });
  });

  describe("hourly expiry audit", () => {
    it("the tick writes the expiring audit once per tier and does not repeat it within the hour or on the next tick", async () => {
      await activeCert(["hotel.it"], { notAfter: new Date(Date.now() + 10 * DAY) });
      const now = new Date();
      await app.tlsPublish.tick(now);
      expect(await audits("site.tls_certificate.expiring")).toHaveLength(1);
      await app.tlsPublish.tick(new Date(now.getTime() + 5 * 60_000));
      await app.tlsPublish.tick(new Date(now.getTime() + 2 * 60 * 60_000));
      expect(await audits("site.tls_certificate.expiring")).toHaveLength(1);
    });
  });

  describe("wiring", () => {
    it("start/stop of the loop is idempotent and the handle exposes the publish service", async () => {
      app.tlsPublish.startBackgroundLoop(null);
      app.tlsPublish.startBackgroundLoop(0);
      await app.tlsPublish.stop();
      await app.tlsPublish.stop();
      expect(app.tlsPublish).toBeDefined();
    });
  });
});
