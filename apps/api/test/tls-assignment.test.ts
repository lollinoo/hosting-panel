import type { TlsVersionStatus } from "@hosting-panel/contracts";
import {
  createDatabaseClient,
  createSiteTransactional,
  domains,
  eq,
  hostAllocations,
  hosts,
  insertTlsCertificateWithVersion,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  sql,
  tlsCertificates,
  tlsCertificateVersions,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import {
  checkAssignment,
  enqueueSiteTlsOperation,
  TLS_APPLY_STEPS,
  type AssignmentInput,
  type EnqueueTlsInput,
} from "../src/certificates/tls-assignment.js";

// HCP-SPEC-004 TLS-03/04/07 (API side): the synchronous assignment checks and the site.tls.apply enqueue.
// The SNI key/tie logic itself is tested in packages/contracts/test/tls-sni.test.ts.
const MASTER_KEY = "f".repeat(64);
const NOW = new Date("2026-06-01T00:00:00.000Z");
const orgA = "org_asg_a";
const orgB = "org_asg_b";
const orgC = "org_asg_c";
const PEM_CANARY = "-----BEGIN PRIVATE KEY-----\nCANARYKEYMATERIAL\n-----END PRIVATE KEY-----\n";

describe("tls-assignment (PGlite)", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;
  const allocByOrg: Record<string, string> = { [orgA]: "alloc_asg_a", [orgB]: "alloc_asg_b", [orgC]: "alloc_asg_c" };

  async function cert(
    org: string,
    sanDns: string[],
    opts: { status?: TlsVersionStatus; notAfter?: Date } = {},
  ): Promise<{ certificateId: string; versionId: string }> {
    counter += 1;
    const created = await insertTlsCertificateWithVersion(db(), {
      organizationId: org,
      name: `cert ${String(counter)}`,
      createdForSiteId: null,
      createdByUserId: null,
      masterKey: MASTER_KEY,
      version: {
        leafPem: "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
        chainPem: "",
        privateKeyPem: PEM_CANARY,
        subject: "CN=test",
        issuer: "CN=Test CA",
        serialNumber: String(counter),
        fingerprintSha256: counter.toString(16).padStart(64, "0"),
        notBefore: new Date("2026-01-01T00:00:00.000Z"),
        notAfter: opts.notAfter ?? new Date("2027-06-01T00:00:00.000Z"),
        sanDns,
        keyType: "ec",
        keyBits: 256,
      },
    });
    if (opts.status && opts.status !== "pending") {
      await db().update(tlsCertificateVersions).set({ status: opts.status }).where(eq(tlsCertificateVersions.id, created.versionId));
    }
    return { certificateId: created.certificateId, versionId: created.versionId };
  }

  /** A version added to an existing certificate: same names as `sanDns`, its own fingerprint. */
  async function sibling(org: string, sanDns: string[]) {
    return cert(org, sanDns);
  }

  async function site(org: string) {
    counter += 1;
    const created = await createSiteTransactional(db(), {
      organizationId: org,
      hostAllocationId: allocByOrg[org]!,
      name: `Site ${String(counter)}`,
      slug: `asg-site-${String(counter)}`,
      phpVersion: "8.4",
      siteType: "wordpress",
    });
    return created.site.id;
  }

  async function domain(
    org: string,
    siteId: string,
    hostname: string,
    opts: { status?: "active" | "pending"; certStatus?: "none" | "requested" | "active"; manualVersionId?: string } = {},
  ) {
    counter += 1;
    const id = `dom_asg_${String(counter)}`;
    await db()
      .insert(domains)
      .values({
        id,
        siteId,
        organizationId: org,
        hostname,
        status: opts.status ?? "active",
        certStatus: opts.certStatus ?? "none",
        ...(opts.manualVersionId ? { certMode: "manual" as const, manualCertificateVersionId: opts.manualVersionId } : {}),
      });
    return id;
  }

  const check = (input: AssignmentInput) => db().transaction((tx) => checkAssignment(tx, { now: NOW, ...input }));
  // The evict window compares with the database clock (outbox created_at), so enqueue runs on the real clock.
  const enqueue = (input: EnqueueTlsInput) => db().transaction((tx) => enqueueSiteTlsOperation(tx, input));

  const refusal = async (promise: Promise<unknown>): Promise<ControlPlaneError> => {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlPlaneError);
    return err as ControlPlaneError;
  };

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_asg", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_asg",
      platformInstallationId: "pin_asg",
      name: "asg-host",
      hostname: "panel.asg.test",
      ipv4Address: "10.0.0.50",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const [orgId, alloc, slug] of [
      [orgA, allocByOrg[orgA]!, "asg-a"],
      [orgB, allocByOrg[orgB]!, "asg-b"],
      [orgC, allocByOrg[orgC]!, "asg-c"],
    ] as const) {
      await db().insert(organizations).values({ id: orgId, platformInstallationId: "pin_asg", name: slug, slug });
      await db().insert(hostAllocations).values({ id: alloc, hostId: "hst_asg", organizationId: orgId, status: "active" });
    }
  }, 120_000);

  afterEach(async () => {
    await db().delete(outboxEvents);
    await db().delete(operations);
    await db().delete(domains);
    await db().delete(tlsCertificates);
  });

  afterAll(async () => {
    await client.close();
  });

  describe("checkAssignment", () => {
    it("accepts a covered active domain and reports the effective change", async () => {
      const siteId = await site(orgA);
      const { versionId } = await cert(orgA, ["*.example.test"]);
      const domainId = await domain(orgA, siteId, "Shop.Example.Test");
      const plan = await check({ organizationId: orgA, siteId, changes: [{ domainId, versionId }] });
      expect(plan).toMatchObject({
        noop: false,
        changes: [{ domainId, versionId }],
        domains: [{ domainId, hostname: "shop.example.test", fromVersionId: null, versionId }],
        fromVersionIds: [],
        evictAcmeHosts: [],
        collateralHosts: [],
      });
    });

    it("is a no-op when every domain is already in the requested state", async () => {
      const siteId = await site(orgA);
      const { versionId } = await cert(orgA, ["a.example.test"], { status: "active" });
      const manual = await domain(orgA, siteId, "a.example.test", { manualVersionId: versionId });
      const acme = await domain(orgA, siteId, "b.example.test");
      const plan = await check({
        organizationId: orgA,
        siteId,
        changes: [
          { domainId: manual, versionId },
          { domainId: acme, versionId: null },
        ],
      });
      expect(plan).toMatchObject({ noop: true, changes: [], domains: [] });
    });

    it("keeps only the changes that alter a domain and lists the versions they leave", async () => {
      const siteId = await site(orgA);
      const old = await cert(orgA, ["a.example.test"], { status: "active" });
      const next = await cert(orgA, ["a.example.test"]);
      const rotating = await domain(orgA, siteId, "a.example.test", { manualVersionId: old.versionId });
      const same = await domain(orgA, siteId, "c.example.test");
      const plan = await check({
        organizationId: orgA,
        siteId,
        changes: [
          { domainId: rotating, versionId: next.versionId },
          { domainId: same, versionId: null },
        ],
      });
      expect(plan.noop).toBe(false);
      expect(plan.changes).toEqual([{ domainId: rotating, versionId: next.versionId }]);
      expect(plan.fromVersionIds).toEqual([old.versionId]);
    });

    describe("ownership (404)", () => {
      it("refuses a site of another organization, an unknown domain, a domain of another site and a foreign version", async () => {
        const siteA = await site(orgA);
        const siteA2 = await site(orgA);
        const siteB = await site(orgB);
        const mine = await cert(orgA, ["*.example.test"]);
        const theirs = await cert(orgB, ["*.other.test"]);
        const domainA = await domain(orgA, siteA, "a.example.test");
        const domainA2 = await domain(orgA, siteA2, "b.example.test");
        const domainB = await domain(orgB, siteB, "a.other.test");
        const cases: AssignmentInput[] = [
          { organizationId: orgB, siteId: siteA, changes: [{ domainId: domainA, versionId: mine.versionId }] },
          { organizationId: orgA, siteId: "site_missing", changes: [{ domainId: domainA, versionId: mine.versionId }] },
          { organizationId: orgA, siteId: siteA, changes: [{ domainId: "dom_missing", versionId: mine.versionId }] },
          { organizationId: orgA, siteId: siteA, changes: [{ domainId: domainA2, versionId: mine.versionId }] },
          { organizationId: orgA, siteId: siteA, changes: [{ domainId: domainB, versionId: mine.versionId }] },
          { organizationId: orgA, siteId: siteA, changes: [{ domainId: domainA, versionId: theirs.versionId }] },
          { organizationId: orgA, siteId: siteA, changes: [{ domainId: domainA, versionId: "ctv_00000000000000000000000000000000" }] },
        ];
        for (const input of cases) {
          const err = await refusal(check(input));
          expect(err.code).toBe("NOT_FOUND");
          expect(err.message).toBe("Requested organization or resource was not found.");
        }
      });

      it("is checked even when the requested state would be a no-op", async () => {
        const siteId = await site(orgA);
        const domainId = await domain(orgA, siteId, "a.example.test");
        const err = await refusal(
          check({ organizationId: orgA, siteId, changes: [{ domainId, versionId: "ctv_00000000000000000000000000000001" }] }),
        );
        expect(err.code).toBe("NOT_FOUND");
      });
    });

    it("refuses a domain that is not active (VALIDATION_ERROR domain_not_active)", async () => {
      const siteId = await site(orgA);
      const { versionId } = await cert(orgA, ["a.example.test"]);
      const domainId = await domain(orgA, siteId, "a.example.test", { status: "pending" });
      const err = await refusal(check({ organizationId: orgA, siteId, changes: [{ domainId, versionId }] }));
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.details).toEqual([expect.objectContaining({ field: "domainIds", reason: "domain_not_active" })]);
    });

    it("lets an inactive domain go back to ACME", async () => {
      const siteId = await site(orgA);
      const { versionId } = await cert(orgA, ["a.example.test"], { status: "active" });
      const domainId = await domain(orgA, siteId, "a.example.test", { status: "pending", manualVersionId: versionId });
      const plan = await check({ organizationId: orgA, siteId, changes: [{ domainId, versionId: null }] });
      expect(plan.changes).toEqual([{ domainId, versionId: null }]);
    });

    describe("coverage (CERTIFICATE_HOSTNAME_MISMATCH not_covered)", () => {
      it.each([
        ["apex of a wildcard", ["*.example.test"], "example.test"],
        ["two labels under a wildcard", ["*.example.test"], "a.b.example.test"],
        ["another name", ["a.example.test"], "b.example.test"],
        ["a sibling zone", ["*.example.test"], "a.example.org"],
      ])("%s", async (_label, sanDns, hostname) => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, sanDns);
        const domainId = await domain(orgA, siteId, hostname);
        const err = await refusal(check({ organizationId: orgA, siteId, changes: [{ domainId, versionId }] }));
        expect(err.code).toBe("CERTIFICATE_HOSTNAME_MISMATCH");
        // The only hostname in the answer is the caller's own.
        expect(err.details).toEqual([{ field: "domainIds", reason: "not_covered", message: hostname }]);
        expect(err.message).not.toContain(hostname);
      });

      it("covers the apex when the SAN list names it too", async () => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["example.test", "*.example.test"]);
        const apex = await domain(orgA, siteId, "example.test");
        const sub = await domain(orgA, siteId, "www.example.test");
        const plan = await check({
          organizationId: orgA,
          siteId,
          changes: [
            { domainId: apex, versionId },
            { domainId: sub, versionId },
          ],
        });
        expect(plan.changes).toHaveLength(2);
      });
    });

    describe("24 h margin (CERTIFICATE_EXPIRED)", () => {
      const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);
      it.each([
        ["expired", -1, "expired"],
        ["expiring right now", 0, "expired"],
        ["one minute short of 24 h", 86_400_000 - 60_000, "expires_within_24h"],
        ["one millisecond short of 24 h", 86_400_000 - 1, "expires_within_24h"],
      ])("refuses %s", async (_label, offset, reason) => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["a.example.test"], { notAfter: at(offset) });
        const domainId = await domain(orgA, siteId, "a.example.test");
        const err = await refusal(check({ organizationId: orgA, siteId, changes: [{ domainId, versionId }] }));
        expect(err.code).toBe("CERTIFICATE_EXPIRED");
        expect(err.details).toEqual([expect.objectContaining({ reason })]);
      });

      it("accepts exactly 24 h", async () => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["a.example.test"], { notAfter: at(86_400_000) });
        const domainId = await domain(orgA, siteId, "a.example.test");
        await expect(check({ organizationId: orgA, siteId, changes: [{ domainId, versionId }] })).resolves.toMatchObject({
          noop: false,
        });
      });
    });

    describe("cross-organization coverage (DOMAIN_CONFLICT, nothing named)", () => {
      const generic = async (promise: Promise<unknown>) => {
        const err = await refusal(promise);
        expect(err.code).toBe("DOMAIN_CONFLICT");
        expect(err.details).toEqual([]);
        expect(JSON.stringify({ message: err.message, details: err.details })).not.toMatch(/other\.test|org_asg|cert \d/);
      };

      it("refuses a version whose name matches a domain of another organization, whatever its status", async () => {
        const siteA = await site(orgA);
        const siteB = await site(orgB);
        const { versionId } = await cert(orgA, ["*.shared.test", "mine.shared.test"]);
        const mine = await domain(orgA, siteA, "mine.shared.test");
        await domain(orgB, siteB, "theirs.shared.test", { status: "pending" });
        await generic(check({ organizationId: orgA, siteId: siteA, changes: [{ domainId: mine, versionId }] }));
      });

      it("refuses a version whose name matches the panel host", async () => {
        const siteA = await site(orgA);
        const { versionId } = await cert(orgA, ["*.asg.test", "a.asg.test"]);
        const mine = await domain(orgA, siteA, "a.asg.test");
        await generic(check({ organizationId: orgA, siteId: siteA, changes: [{ domainId: mine, versionId }] }));
      });

      it("does not refuse a name that only looks similar", async () => {
        const siteA = await site(orgA);
        const siteB = await site(orgB);
        const { versionId } = await cert(orgA, ["a.shared.test"]);
        const mine = await domain(orgA, siteA, "a.shared.test");
        await domain(orgB, siteB, "b.shared.test");
        await domain(orgB, siteB, "a.shared.test.evil.test");
        await expect(check({ organizationId: orgA, siteId: siteA, changes: [{ domainId: mine, versionId }] })).resolves.toMatchObject({
          noop: false,
        });
      });
    });

    describe("manual_overlap (CERTIFICATE_SNI_MISMATCH)", () => {
      it("refuses a rotation that leaves another domain on an equal-key version", async () => {
        const siteId = await site(orgA);
        const v1 = await cert(orgA, ["*.rot.test"], { status: "active" });
        const v2 = await sibling(orgA, ["*.rot.test"]);
        const d1 = await domain(orgA, siteId, "a.rot.test", { manualVersionId: v1.versionId });
        await domain(orgA, siteId, "b.rot.test", { manualVersionId: v1.versionId });
        const err = await refusal(check({ organizationId: orgA, siteId, changes: [{ domainId: d1, versionId: v2.versionId }] }));
        expect(err.code).toBe("CERTIFICATE_SNI_MISMATCH");
        expect(err.details).toEqual([expect.objectContaining({ field: "domainIds", reason: "manual_overlap" })]);
        expect(JSON.stringify(err.details)).not.toContain("rot.test");
      });

      it("accepts the same rotation when every domain of the version moves", async () => {
        const siteId = await site(orgA);
        const v1 = await cert(orgA, ["*.rot.test"], { status: "active" });
        const v2 = await sibling(orgA, ["*.rot.test"]);
        const d1 = await domain(orgA, siteId, "a.rot.test", { manualVersionId: v1.versionId });
        const d2 = await domain(orgA, siteId, "b.rot.test", { manualVersionId: v1.versionId });
        const plan = await check({
          organizationId: orgA,
          siteId,
          changes: [
            { domainId: d1, versionId: v2.versionId },
            { domainId: d2, versionId: v2.versionId },
          ],
        });
        expect(plan.fromVersionIds).toEqual([v1.versionId]);
      });

      it("refuses an assigned host that another published version with a higher key also covers", async () => {
        const siteId = await site(orgA);
        const low = await cert(orgA, ["a.mix.test", "b.mix.test"]);
        const high = await cert(orgA, ["a.mix.test", "c.mix.test"], { status: "active" });
        await domain(orgA, siteId, "c.mix.test", { manualVersionId: high.versionId });
        const a = await domain(orgA, siteId, "a.mix.test");
        const err = await refusal(check({ organizationId: orgA, siteId, changes: [{ domainId: a, versionId: low.versionId }] }));
        expect(err).toMatchObject({ code: "CERTIFICATE_SNI_MISMATCH" });
        expect(err.details).toEqual([expect.objectContaining({ reason: "manual_overlap" })]);
      });

      it("accepts the same pair when the assigned host belongs to the higher key", async () => {
        const siteId = await site(orgA);
        const low = await cert(orgA, ["a.mix.test", "b.mix.test"], { status: "active" });
        const high = await cert(orgA, ["a.mix.test", "c.mix.test"]);
        await domain(orgA, siteId, "b.mix.test", { manualVersionId: low.versionId });
        const a = await domain(orgA, siteId, "a.mix.test");
        await expect(
          check({ organizationId: orgA, siteId, changes: [{ domainId: a, versionId: high.versionId }] }),
        ).resolves.toMatchObject({ noop: false });
      });
    });

    describe("captures_host", () => {
      it("refuses a wildcard that would also be served for an unassigned own host (CERTIFICATE_IN_USE)", async () => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["*.cap.test"]);
        const a = await domain(orgA, siteId, "a.cap.test");
        await domain(orgA, siteId, "b.cap.test"); // routed, ACME, no certificate yet
        const err = await refusal(check({ organizationId: orgA, siteId, changes: [{ domainId: a, versionId }] }));
        expect(err.code).toBe("CERTIFICATE_IN_USE");
        expect(err.details).toEqual([{ field: "domainIds", reason: "captures_host", message: "b.cap.test" }]);
      });

      it("does not count an unassigned ACME host that already has its own exact certificate", async () => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["*.cap.test"]);
        const a = await domain(orgA, siteId, "a.cap.test");
        await domain(orgA, siteId, "b.cap.test", { certStatus: "active" });
        const plan = await check({ organizationId: orgA, siteId, changes: [{ domainId: a, versionId }] });
        expect(plan.noop).toBe(false);
      });

      it("ignores hosts that are not routed", async () => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["*.cap.test"]);
        const a = await domain(orgA, siteId, "a.cap.test");
        await domain(orgA, siteId, "b.cap.test", { status: "pending" });
        await expect(check({ organizationId: orgA, siteId, changes: [{ domainId: a, versionId }] })).resolves.toMatchObject({
          noop: false,
        });
      });

      it("refuses returning a host to ACME while a loaded wildcard still covers it", async () => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["*.cap.test"], { status: "active" });
        const a = await domain(orgA, siteId, "a.cap.test", { manualVersionId: versionId });
        await domain(orgA, siteId, "b.cap.test", { manualVersionId: versionId });
        const err = await refusal(check({ organizationId: orgA, siteId, changes: [{ domainId: a, versionId: null }] }));
        expect(err.code).toBe("CERTIFICATE_IN_USE");
        expect(err.details).toEqual([{ field: "domainIds", reason: "captures_host", message: "a.cap.test" }]);
      });

      it("lets every host of a wildcard go back to ACME together", async () => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["*.cap.test"], { status: "active" });
        const a = await domain(orgA, siteId, "a.cap.test", { manualVersionId: versionId });
        const b = await domain(orgA, siteId, "b.cap.test", { manualVersionId: versionId });
        const plan = await check({
          organizationId: orgA,
          siteId,
          changes: [
            { domainId: a, versionId: null },
            { domainId: b, versionId: null },
          ],
        });
        expect(plan.domains.map((d) => d.versionId)).toEqual([null, null]);
      });
    });

    describe("cross-site (the organisation's whole move)", () => {
      it("rotates one certificate used on two sites only when both sites' domains move together", async () => {
        const siteA = await site(orgA);
        const siteB = await site(orgA);
        const v1 = await cert(orgA, ["a.xs.test", "b.xs.test"], { status: "active" });
        const v2 = await sibling(orgA, ["a.xs.test", "b.xs.test"]);
        const a = await domain(orgA, siteA, "a.xs.test", { manualVersionId: v1.versionId });
        const b = await domain(orgA, siteB, "b.xs.test", { manualVersionId: v1.versionId });
        // One site alone leaves the other on an equal-key version: refused.
        const alone = await refusal(
          check({ organizationId: orgA, siteId: siteA, crossSite: true, changes: [{ domainId: a, versionId: v2.versionId }] }),
        );
        expect(alone.details).toEqual([expect.objectContaining({ reason: "manual_overlap" })]);
        const plan = await check({
          organizationId: orgA,
          siteId: siteA,
          crossSite: true,
          changes: [
            { domainId: a, versionId: v2.versionId },
            { domainId: b, versionId: v2.versionId },
          ],
        });
        expect(plan.domains.map((d) => [d.domainId, d.siteId, d.fromVersionId])).toEqual([
          [a, siteA, v1.versionId],
          [b, siteB, v1.versionId],
        ]);
      });

      it("assigns one multi-name certificate to domains of two sites in one request", async () => {
        const siteA = await site(orgA);
        const siteB = await site(orgA);
        const { versionId } = await cert(orgA, ["hotel.xs.test", "annex.xs.test"]);
        const a = await domain(orgA, siteA, "hotel.xs.test");
        const b = await domain(orgA, siteB, "annex.xs.test");
        const changes = [
          { domainId: a, versionId },
          { domainId: b, versionId },
        ];
        // Per site it can never be assigned: the other site's name would be captured.
        const single = await refusal(check({ organizationId: orgA, siteId: siteA, changes: [changes[0]!] }));
        expect(single.details).toEqual([expect.objectContaining({ reason: "captures_host" })]);
        await expect(check({ organizationId: orgA, siteId: siteA, crossSite: true, changes })).resolves.toMatchObject({ noop: false });
      });

      it("without crossSite a domain of another site is NOT_FOUND, and a domain of another organisation is NOT_FOUND either way", async () => {
        const siteA = await site(orgA);
        const siteA2 = await site(orgA);
        const siteB = await site(orgB);
        const { versionId } = await cert(orgA, ["*.xs2.test"]);
        const mine = await domain(orgA, siteA2, "a.xs2.test");
        const theirs = await domain(orgB, siteB, "b.other.test");
        const change = (domainId: string) => [{ domainId, versionId }];
        expect((await refusal(check({ organizationId: orgA, siteId: siteA, changes: change(mine) }))).code).toBe("NOT_FOUND");
        expect((await refusal(check({ organizationId: orgA, siteId: siteA, crossSite: true, changes: change(theirs) }))).code).toBe("NOT_FOUND");
        await expect(check({ organizationId: orgA, siteId: siteA, crossSite: true, changes: change(mine) })).resolves.toMatchObject({ noop: false });
      });
    });

    describe("ACME eviction is left to the executor", () => {
      it("does not refuse an assignment that needs an ACME entry evicted, and reports the host", async () => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["*.lets.test"]);
        const a = await domain(orgA, siteId, "a.lets.test", { certStatus: "active" });
        const plan = await check({ organizationId: orgA, siteId, changes: [{ domainId: a, versionId }] });
        expect(plan).toMatchObject({ noop: false, evictAcmeHosts: ["a.lets.test"], collateralHosts: [] });
        await expect(
          check({ organizationId: orgA, siteId, changes: [{ domainId: a, versionId }], evictAcme: true }),
        ).resolves.toMatchObject({ evictAcmeHosts: ["a.lets.test"] });
      });

      it("a manual certificate with more names than the ACME one wins without eviction", async () => {
        const siteId = await site(orgA);
        const { versionId } = await cert(orgA, ["a.lets.test", "www.a.lets.test"]);
        const a = await domain(orgA, siteId, "a.lets.test", { certStatus: "active" });
        const plan = await check({ organizationId: orgA, siteId, changes: [{ domainId: a, versionId }] });
        expect(plan.evictAcmeHosts).toEqual([]);
      });
    });

    it("refuses two different targets for the same domain", async () => {
      const siteId = await site(orgA);
      const v1 = await cert(orgA, ["a.example.test"]);
      const v2 = await sibling(orgA, ["a.example.test"]);
      const domainId = await domain(orgA, siteId, "a.example.test");
      const err = await refusal(
        check({
          organizationId: orgA,
          siteId,
          changes: [
            { domainId, versionId: v1.versionId },
            { domainId, versionId: v2.versionId },
          ],
        }),
      );
      expect(err.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("enqueueSiteTlsOperation", () => {
    async function prepared(hostname = "a.example.test", status: TlsVersionStatus = "pending", org = orgA) {
      const siteId = await site(org);
      const version = await cert(org, [hostname], { status });
      const domainId = await domain(org, siteId, hostname);
      return { siteId, domainId, versionId: version.versionId, org };
    }
    const status = async (versionId: string) =>
      (await db().select().from(tlsCertificateVersions).where(eq(tlsCertificateVersions.id, versionId)))[0]!;

    it("queues site.tls.apply under the site lock with ids-only payload, a request hash and the three steps", async () => {
      const { siteId, domainId, versionId } = await prepared();
      const enqueued = await enqueue({
        organizationId: orgA,
        siteId,
        changes: [{ domainId, versionId }],
        idempotencyKey: "key-1",
        requestHash: "a".repeat(64),
      });
      expect(enqueued.idempotentReplay).toBe(false);
      expect(enqueued.operation).toMatchObject({
        kind: "site.tls.apply",
        status: "queued",
        resourceType: "site",
        resourceId: siteId,
        organizationId: orgA,
        lockKey: `site:${siteId}`,
        idempotencyKey: "key-1",
        requestHash: "a".repeat(64),
      });
      expect(enqueued.steps.map((s) => s.key)).toEqual(["stage", "publish", "routes"]);
      expect(TLS_APPLY_STEPS.map((s) => s.key)).toEqual(["stage", "publish", "routes"]);
      expect(enqueued.outbox?.eventType).toBe("operation.queued.site.tls.apply");
      expect(enqueued.outbox?.payload).toEqual({
        siteId,
        changes: [{ domainId, versionId }],
        operationId: enqueued.operation.id,
        organizationId: orgA,
        kind: "site.tls.apply",
        resourceType: "site",
        resourceId: siteId,
      });
      expect(JSON.stringify(enqueued)).not.toMatch(/CANARY|PRIVATE KEY/);
    });

    it("moves pending, inactive and failed target versions to applying and leaves active ones alone", async () => {
      const siteId = await site(orgA);
      const ids: Record<string, string> = {};
      const domainIds: Record<string, string> = {};
      for (const s of ["pending", "inactive", "failed", "active"] as const) {
        ids[s] = (await cert(orgA, [`${s}.example.test`], { status: s })).versionId;
        domainIds[s] = await domain(orgA, siteId, `${s}.example.test`);
      }
      await db().update(tlsCertificateVersions).set({ lastErrorCode: "apply_failed" }).where(eq(tlsCertificateVersions.id, ids["failed"]!));
      await enqueue({
        organizationId: orgA,
        siteId,
        changes: Object.keys(ids).map((s) => ({ domainId: domainIds[s]!, versionId: ids[s]! })),
      });
      expect((await status(ids["pending"]!)).status).toBe("applying");
      expect((await status(ids["inactive"]!)).status).toBe("applying");
      const failed = await status(ids["failed"]!);
      expect(failed.status).toBe("applying");
      expect(failed.lastErrorCode).toBeNull();
      expect((await status(ids["active"]!)).status).toBe("active");
    });

    it("a change back to ACME queues the run without touching any version", async () => {
      const siteId = await site(orgA);
      const { versionId } = await cert(orgA, ["a.example.test"], { status: "active" });
      const domainId = await domain(orgA, siteId, "a.example.test", { manualVersionId: versionId });
      const enqueued = await enqueue({ organizationId: orgA, siteId, changes: [{ domainId, versionId: null }] });
      expect(enqueued.outbox?.payload).toMatchObject({ changes: [{ domainId, versionId: null }] });
      expect((await status(versionId)).status).toBe("active");
    });

    it("carries evictAcme and the admin challenge in the payload only when given", async () => {
      const first = await prepared("a.example.test");
      const second = await prepared("b.example.test");
      const plain = await enqueue({ organizationId: orgA, siteId: first.siteId, changes: [{ domainId: first.domainId, versionId: first.versionId }] });
      expect(plain.outbox?.payload).not.toHaveProperty("evictAcme");
      expect(plain.outbox?.payload).not.toHaveProperty("challenge");
      await db().update(operations).set({ status: "succeeded" });
      const evicting = await enqueue({
        organizationId: orgA,
        siteId: second.siteId,
        changes: [{ domainId: second.domainId, versionId: second.versionId }],
        evictAcme: true,
        challenge: "dns-01",
      });
      expect(evicting.outbox?.payload).toMatchObject({ evictAcme: true, challenge: "dns-01" });
    });

    it("refuses while another operation holds the site lock (RESOURCE_LOCKED) and leaves the version alone", async () => {
      const { siteId, domainId, versionId } = await prepared();
      await enqueue({ organizationId: orgA, siteId, changes: [{ domainId, versionId }] });
      await db().update(tlsCertificateVersions).set({ status: "pending" }).where(eq(tlsCertificateVersions.id, versionId));
      await expect(enqueue({ organizationId: orgA, siteId, changes: [{ domainId, versionId }] })).rejects.toMatchObject({
        code: "RESOURCE_LOCKED",
      });
      expect((await status(versionId)).status).toBe("pending");
    });

    it("needs at least one change", async () => {
      const siteId = await site(orgA);
      await expect(enqueue({ organizationId: orgA, siteId, changes: [] })).rejects.toThrow(/at least one change/);
    });

    describe("2 non-terminal operations per server", () => {
      it("refuses the third with RATE_LIMITED retryAfterMs 30000, across organizations", async () => {
        const one = await prepared("a.example.test");
        const two = await prepared("b.example.test", "pending", orgB);
        const siteC = await site(orgC);
        const versionC = await cert(orgC, ["c.other.test"]);
        const domainC = await domain(orgC, siteC, "c.other.test");
        await enqueue({ organizationId: orgA, siteId: one.siteId, changes: [{ domainId: one.domainId, versionId: one.versionId }] });
        await enqueue({ organizationId: orgB, siteId: two.siteId, changes: [{ domainId: two.domainId, versionId: two.versionId }] });
        const err = await refusal(
          enqueue({ organizationId: orgC, siteId: siteC, changes: [{ domainId: domainC, versionId: versionC.versionId }] }),
        );
        expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 30_000 });
        expect((await status(versionC.versionId)).status).toBe("pending");
        expect(await db().select().from(operations)).toHaveLength(2);
      });

      it("does not count terminal operations or other kinds", async () => {
        const one = await prepared("a.example.test");
        const two = await prepared("b.example.test", "pending", orgB);
        const three = await prepared("c.example.test", "pending", orgC);
        await enqueue({ organizationId: orgA, siteId: one.siteId, changes: [{ domainId: one.domainId, versionId: one.versionId }] });
        await enqueue({ organizationId: orgB, siteId: two.siteId, changes: [{ domainId: two.domainId, versionId: two.versionId }] });
        await db().update(operations).set({ status: "failed" }).where(eq(operations.resourceId, one.siteId));
        await db().update(operations).set({ kind: "site.domains" }).where(eq(operations.resourceId, two.siteId));
        await expect(
          enqueue({ organizationId: orgC, siteId: three.siteId, changes: [{ domainId: three.domainId, versionId: three.versionId }] }),
        ).resolves.toMatchObject({ idempotentReplay: false });
      });

      it("counts unknown and reconciling operations as non-terminal", async () => {
        const one = await prepared("a.example.test");
        const two = await prepared("b.example.test", "pending", orgB);
        const three = await prepared("c.example.test", "pending", orgC);
        await enqueue({ organizationId: orgA, siteId: one.siteId, changes: [{ domainId: one.domainId, versionId: one.versionId }] });
        await enqueue({ organizationId: orgB, siteId: two.siteId, changes: [{ domainId: two.domainId, versionId: two.versionId }] });
        await db().update(operations).set({ status: "unknown" }).where(eq(operations.resourceId, one.siteId));
        await db().update(operations).set({ status: "reconciling" }).where(eq(operations.resourceId, two.siteId));
        await expect(
          enqueue({ organizationId: orgC, siteId: three.siteId, changes: [{ domainId: three.domainId, versionId: three.versionId }] }),
        ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      });
    });

    describe("1 non-terminal operation per organization", () => {
      it("refuses a second site of the same organization with RATE_LIMITED, while another organization still goes through", async () => {
        const one = await prepared("a.example.test");
        const two = await prepared("b.example.test");
        const other = await prepared("c.example.test", "pending", orgB);
        await enqueue({ organizationId: orgA, siteId: one.siteId, changes: [{ domainId: one.domainId, versionId: one.versionId }] });
        const err = await refusal(
          enqueue({ organizationId: orgA, siteId: two.siteId, changes: [{ domainId: two.domainId, versionId: two.versionId }] }),
        );
        expect(err).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 30_000 });
        expect((await status(two.versionId)).status).toBe("pending");
        await expect(
          enqueue({ organizationId: orgB, siteId: other.siteId, changes: [{ domainId: other.domainId, versionId: other.versionId }] }),
        ).resolves.toMatchObject({ idempotentReplay: false });
        // once the first run settled, the organization can queue again
        await db().update(operations).set({ status: "succeeded" }).where(eq(operations.organizationId, orgA));
        await expect(
          enqueue({ organizationId: orgA, siteId: two.siteId, changes: [{ domainId: two.domainId, versionId: two.versionId }] }),
        ).resolves.toMatchObject({ idempotentReplay: false });
      });
    });

    describe("administrator evictAcme: 1 per 15 minutes per server", () => {
      it("refuses a second eviction inside the window with the remaining time, allows it afterwards, and never limits plain runs", async () => {
        const one = await prepared("a.example.test");
        const two = await prepared("b.example.test");
        const three = await prepared("c.example.test");
        const run = (p: typeof one, extra: Partial<EnqueueTlsInput> = {}) =>
          enqueue({ organizationId: orgA, siteId: p.siteId, changes: [{ domainId: p.domainId, versionId: p.versionId }], ...extra });
        await run(one, { evictAcme: true });
        await db().update(operations).set({ status: "succeeded" });
        const err = await refusal(run(two, { evictAcme: true }));
        expect(err.code).toBe("RATE_LIMITED");
        expect(err.retryAfterMs).toBeGreaterThan(0);
        expect(err.retryAfterMs).toBeLessThanOrEqual(15 * 60_000);
        expect((await status(two.versionId)).status).toBe("pending");
        // a customer-style run is not limited by it
        await expect(run(three)).resolves.toMatchObject({ idempotentReplay: false });
        await db().update(operations).set({ status: "succeeded" });
        // 16 minutes later (the outbox row is stamped by the database clock: move the window instead)
        await expect(run(two, { evictAcme: true, now: new Date(Date.now() + 16 * 60_000) })).resolves.toMatchObject({
          idempotentReplay: false,
        });
      });

      it("counts the run even when it failed", async () => {
        const one = await prepared("a.example.test");
        const two = await prepared("b.example.test");
        await enqueue({ organizationId: orgA, siteId: one.siteId, changes: [{ domainId: one.domainId, versionId: one.versionId }], evictAcme: true });
        await db().update(operations).set({ status: "failed" });
        await expect(
          enqueue({ organizationId: orgA, siteId: two.siteId, changes: [{ domainId: two.domainId, versionId: two.versionId }], evictAcme: true, now: new Date() }),
        ).rejects.toMatchObject({ code: "RATE_LIMITED" });
      });
    });

    describe("idempotency", () => {
      it("replays the stored operation without caps, lock check or version changes", async () => {
        const one = await prepared("a.example.test");
        const two = await prepared("b.example.test", "pending", orgB);
        const first = await enqueue({
          organizationId: orgA,
          siteId: one.siteId,
          changes: [{ domainId: one.domainId, versionId: one.versionId }],
          idempotencyKey: "same",
          requestHash: "b".repeat(64),
        });
        await enqueue({ organizationId: orgB, siteId: two.siteId, changes: [{ domainId: two.domainId, versionId: two.versionId }] });
        // two active operations now: a new request would be capped, the replay is not
        const replay = await enqueue({
          organizationId: orgA,
          siteId: one.siteId,
          changes: [{ domainId: one.domainId, versionId: one.versionId }],
          idempotencyKey: "same",
          requestHash: "b".repeat(64),
          evictAcme: true,
        });
        expect(replay.idempotentReplay).toBe(true);
        expect(replay.operation.id).toBe(first.operation.id);
        expect(await db().select().from(operations)).toHaveLength(2);
      });

      it("refuses the same key with another request hash (IDEMPOTENCY_CONFLICT)", async () => {
        const { siteId, domainId, versionId } = await prepared();
        await enqueue({
          organizationId: orgA,
          siteId,
          changes: [{ domainId, versionId }],
          idempotencyKey: "same",
          requestHash: "c".repeat(64),
        });
        await expect(
          enqueue({
            organizationId: orgA,
            siteId,
            changes: [{ domainId, versionId }],
            idempotencyKey: "same",
            requestHash: "d".repeat(64),
          }),
        ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      });
    });

    it("rolls the version update back with the caller's transaction", async () => {
      const { siteId, domainId, versionId } = await prepared();
      await expect(
        db().transaction(async (tx) => {
          await enqueueSiteTlsOperation(tx, { organizationId: orgA, siteId, changes: [{ domainId, versionId }] });
          throw new Error("caller failed");
        }),
      ).rejects.toThrow("caller failed");
      expect((await status(versionId)).status).toBe("pending");
      expect(await db().select({ n: sql<number>`count(*)::int` }).from(operations)).toEqual([{ n: 0 }]);
    });
  });
});
