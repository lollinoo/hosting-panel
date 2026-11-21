import { randomUUID } from "node:crypto";
import { AdminAlertDtoSchema, type AdminAlertDto } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  domains,
  eq,
  insertTlsCertificateWithVersion,
  sql,
  tlsCertificateVersions,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { manualExpiryAlerts, recordExpiryAudits } from "../src/certificates/tls-expiry.js";
import { AdminHealthService } from "../src/health/admin-health.service.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 9);
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
const DAY = 86_400_000;
/** The fixed clock of every tier look. */
const NOW = new Date("2026-06-01T12:00:00.000Z");
const at = (days: number, extraMs = 0) => new Date(NOW.getTime() + days * DAY + extraMs);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("manual certificate expiry alerts and audits (TLS-12)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let orgId: string;
  let siteId: string;
  let health: AdminHealthService;

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

  async function call(method: string, path: string, body: unknown, as: string) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Json };
  }

  /** An imported certificate with one version expiring at `notAfter`, built through the repository. */
  async function importVersion(notAfter: Date, over: { status?: "active" | "pending"; name?: string } = {}) {
    const { certificateId, versionId } = await insertTlsCertificateWithVersion(dbClient.db, {
      organizationId: orgId,
      name: over.name ?? "hotel",
      createdForSiteId: siteId,
      createdByUserId: null,
      masterKey: KEY,
      version: {
        leafPem: "LEAF-MARKER",
        chainPem: "",
        privateKeyPem: "KEY-MARKER",
        subject: "CN=www.hotel.it",
        issuer: "CN=CA",
        serialNumber: "01",
        fingerprintSha256: randomUUID().replace(/-/g, "").repeat(2),
        notBefore: new Date(NOW.getTime() - 60 * DAY),
        notAfter,
        sanDns: ["www.hotel.it", "hotel.it"],
        keyType: "ec",
        keyBits: 256,
      },
    });
    await dbClient.db
      .update(tlsCertificateVersions)
      .set({ status: over.status ?? "active" })
      .where(eq(tlsCertificateVersions.id, versionId));
    return { certificateId, versionId };
  }

  const assign = (hostname: string, versionId: string) =>
    dbClient.db
      .update(domains)
      .set({ certMode: "manual", manualCertificateVersionId: versionId, certStatus: "active" })
      .where(eq(domains.hostname, hostname));

  const manualAlerts = async (now = NOW) => (await health.alerts(now)).filter((a) => a.kind === "manual_certificate_expiring");
  const auditRows = async () => {
    const rows = await dbClient.db.select().from(auditEvents).where(sql`${auditEvents.action} like 'site.tls_certificate.%'`);
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  };

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
    const adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    const created = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" },
      adminToken,
    );
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgId = created.body.data.organizationId as string;
    const token = await login("mario@hotel.it", created.body.data.temporaryPassword as string, undefined);
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, SITE, token);
    expect(site.status).toBe(202);
    siteId = site.body.data.siteId as string;
    health = app.nestApp.get(AdminHealthService);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("tiers at a fixed clock", () => {
    const cases = [
      { days: 31, extraMs: 0, tier: null },
      { days: 30, extraMs: 0, tier: null },
      { days: 14, extraMs: 1, tier: null }, // 14 days and a millisecond is still the 30-day notice
      { days: 14, extraMs: 0, tier: "warning" },
      { days: 7, extraMs: 1, tier: "warning" },
      { days: 7, extraMs: 0, tier: "critical" },
      { days: 0, extraMs: 1, tier: "critical" },
      { days: 0, extraMs: 0, tier: "expired" },
      { days: -1, extraMs: 0, tier: "expired" },
    ] as const;

    for (const c of cases) {
      it(`${c.days} days${c.extraMs ? ` + ${c.extraMs} ms` : ""} -> ${c.tier ?? "no alert"}`, async () => {
        const { versionId } = await importVersion(at(c.days, c.extraMs));
        await assign("www.hotel.it", versionId);

        const alerts = await manualExpiryAlerts(dbClient.db, NOW);
        expect(alerts.map((a) => a.tier)).toEqual(c.tier ? [c.tier] : []);
        expect((await manualAlerts()).map((a) => (a.kind === "manual_certificate_expiring" ? a.details.tier : null))).toEqual(
          c.tier ? [c.tier] : [],
        );
      });
    }

    it("daysLeft is the floor of the remaining days", async () => {
      const { versionId } = await importVersion(at(6, 3_600_000));
      await assign("www.hotel.it", versionId);
      expect((await manualExpiryAlerts(dbClient.db, NOW))[0]).toMatchObject({ tier: "critical", daysLeft: 6 });
    });
  });

  describe("the health alert", () => {
    it("one alert per version over all its domains, with the per-tier severity and a schema-valid shape", async () => {
      const { certificateId, versionId } = await importVersion(at(10), { name: "hotel wildcard" });
      await assign("www.hotel.it", versionId);
      await assign("hotel.it", versionId);

      const alerts = await manualAlerts();
      expect(alerts).toHaveLength(1);
      expect(AdminAlertDtoSchema.safeParse(alerts[0]).success).toBe(true);
      expect(alerts[0]).toEqual({
        kind: "manual_certificate_expiring",
        severity: "warning",
        subject: versionId,
        since: null,
        details: { siteId, siteName: SITE.name, certificateId, certificateName: "hotel wildcard", notAfter: at(10).toISOString(), tier: "warning" },
      });
      const [domainAlert] = await manualExpiryAlerts(dbClient.db, NOW);
      expect(domainAlert?.hostnames).toEqual(["hotel.it", "www.hotel.it"]);
    });

    it("critical and expired are critical, and sort before the warning ones", async () => {
      const warning = await importVersion(at(10), { name: "w" });
      const critical = await importVersion(at(3), { name: "c" });
      await assign("www.hotel.it", warning.versionId);
      await assign("hotel.it", critical.versionId);
      let alerts = await manualAlerts();
      expect(alerts.map((a) => [a.severity, a.subject])).toEqual([["critical", critical.versionId], ["warning", warning.versionId]]);

      await dbClient.db.update(domains).set({ manualCertificateVersionId: (await importVersion(at(-2), { name: "e" })).versionId }).where(eq(domains.hostname, "hotel.it"));
      alerts = await manualAlerts();
      expect(alerts.map((a) => (a.kind === "manual_certificate_expiring" ? [a.severity, a.details.tier] : null))).toEqual([["critical", "expired"], ["warning", "warning"]]);
    });

    it("repeated reads of the same instant give the same alerts, never a duplicate", async () => {
      const { versionId } = await importVersion(at(5));
      await assign("www.hotel.it", versionId);
      const first = await manualAlerts();
      expect(await manualAlerts()).toEqual(first);
      expect(await manualAlerts()).toEqual(first);
      expect(first).toHaveLength(1);
    });

    it("the alert goes away with the cause: no domain, a pending version or an automatic domain", async () => {
      const unassigned = await importVersion(at(3), { name: "unassigned" });
      const pending = await importVersion(at(3), { name: "pending", status: "pending" });
      await assign("www.hotel.it", pending.versionId);
      expect(await manualAlerts()).toEqual([]);

      const live = await importVersion(at(3), { name: "live" });
      await assign("www.hotel.it", live.versionId);
      expect(await manualAlerts()).toHaveLength(1);

      await dbClient.db.update(domains).set({ certMode: "acme", manualCertificateVersionId: null }).where(eq(domains.hostname, "www.hotel.it"));
      expect(await manualAlerts()).toEqual([]);
      expect(unassigned.versionId).toBeTruthy();
    });

    it("the 30-day notice is not a host alert", async () => {
      const { versionId } = await importVersion(at(25));
      await assign("www.hotel.it", versionId);
      expect(await manualAlerts()).toEqual([]);
    });

    it("a manual host is absent from certificate_expiring (its text says 'has not renewed')", async () => {
      const { versionId } = await importVersion(at(3));
      await assign("www.hotel.it", versionId);
      // The mirrored expiry that would otherwise make the automatic certificate banner fire.
      await dbClient.db.update(domains).set({ certExpiresAt: new Date(Date.now() + DAY) }).where(eq(domains.hostname, "www.hotel.it"));
      const alerts: AdminAlertDto[] = await health.alerts(NOW);
      expect(alerts.filter((a) => a.kind === "certificate_expiring" && a.subject === "www.hotel.it")).toEqual([]);
      expect(alerts.filter((a) => a.kind === "manual_certificate_expiring")).toHaveLength(1);
    });
  });

  describe("the audit, once per version and tier", () => {
    it("nothing is written outside a warning, critical or expired tier", async () => {
      const { versionId } = await importVersion(at(25));
      await assign("www.hotel.it", versionId);
      expect(await recordExpiryAudits(dbClient.db, NOW)).toBe(0);
      expect(await auditRows()).toEqual([]);
    });

    it("warning, critical and expired each write exactly one row across repeated ticks", async () => {
      const notAfter = at(14);
      const { certificateId, versionId } = await importVersion(notAfter);
      await assign("www.hotel.it", versionId);
      const tick = (now: Date) => recordExpiryAudits(dbClient.db, now);

      // 31 and 30 days ahead: nothing. 14 days: the warning, once.
      expect(await tick(at(-17))).toBe(0);
      expect(await tick(at(-16))).toBe(0);
      expect(await tick(NOW)).toBe(1);
      expect(await tick(NOW)).toBe(0);
      expect(await tick(new Date(NOW.getTime() + 3_600_000))).toBe(0);
      expect(await auditRows()).toHaveLength(1);

      // 7 days ahead: the critical tier is a new row, once.
      const critical = new Date(notAfter.getTime() - 7 * DAY);
      expect(await tick(critical)).toBe(1);
      expect(await tick(critical)).toBe(0);
      expect(await tick(new Date(critical.getTime() + 3_600_000))).toBe(0);
      // Back in the warning window (a clock step back) does not write it twice.
      expect(await tick(NOW)).toBe(0);
      expect(await auditRows()).toHaveLength(2);

      // Expired: one more row, then silence, and no `.expiring` joins it.
      expect(await tick(notAfter)).toBe(1);
      expect(await tick(notAfter)).toBe(0);
      expect(await tick(at(30))).toBe(0);

      const rows = await auditRows();
      expect(rows.map((r) => [r.action, r.details])).toEqual(
        expect.arrayContaining([
          ["site.tls_certificate.expiring", { versionId, tier: "warning" }],
          ["site.tls_certificate.expiring", { versionId, tier: "critical" }],
          ["site.tls_certificate.expired", { versionId }],
        ]),
      );
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r).toMatchObject({ actorType: "system", actorId: null, organizationId: orgId, targetType: "tls_certificate", targetId: certificateId });
        expect(Object.keys(r.details as object).sort()).toEqual(r.action.endsWith("expired") ? ["versionId"] : ["tier", "versionId"]);
      }
    });

    it("a second version of the same certificate and the same tier gets its own row", async () => {
      const a = await importVersion(at(10), { name: "a" });
      const b = await importVersion(at(11), { name: "b" });
      await assign("www.hotel.it", a.versionId);
      await assign("hotel.it", b.versionId);
      expect(await recordExpiryAudits(dbClient.db, NOW)).toBe(2);
      expect(await recordExpiryAudits(dbClient.db, NOW)).toBe(0);
      expect((await auditRows()).map((r) => (r.details as Json).versionId).sort()).toEqual([a.versionId, b.versionId].sort());
    });

    it("carries no PEM, key or fingerprint", async () => {
      const { versionId } = await importVersion(at(2));
      await assign("www.hotel.it", versionId);
      await recordExpiryAudits(dbClient.db, NOW);
      const text = JSON.stringify(await auditRows());
      expect(text).not.toMatch(/LEAF-MARKER|KEY-MARKER|PRIVATE KEY|fingerprint/i);
    });
  });
});
