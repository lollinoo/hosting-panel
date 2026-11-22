import { ERROR_CODE_HTTP_STATUS } from "@hosting-panel/contracts";
import {
  appStackComponents,
  appStackDomains,
  appStacks,
  appTemplates,
  appTemplateVersions,
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
  tlsCertificates,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { checkAssignment, enqueueSiteTlsOperation } from "../src/certificates/tls-assignment.js";

// RT7 (L11): a manual certificate assignment also sees the web addresses of application stacks. It may not cover a
// stack hostname of another organisation (any status) nor capture an active stack hostname of its own organisation.
const NOW = new Date("2026-11-22T00:00:00.000Z");
const orgA = "org_stc_a";
const orgB = "org_stc_b";
const ALLOC: Record<string, string> = { [orgA]: "alloc_stc_a", [orgB]: "alloc_stc_b" };

describe("manual TLS coverage sees stack hostnames (PGlite)", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;

  async function stackHost(org: string, hostname: string, status: "active" | "pending") {
    counter += 1;
    const stackId = `stk_stc_${String(counter)}`;
    await db().insert(appStacks).values({
      id: stackId,
      organizationId: org,
      hostAllocationId: ALLOC[org]!,
      templateId: "atpl_stc",
      templateVersionId: "atv_stc1",
      name: `Stack ${String(counter)}`,
    });
    await db().insert(appStackComponents).values({ stackId, organizationId: org, componentKey: "web" });
    await db()
      .insert(appStackDomains)
      .values({ id: `sdom_stc_${String(counter)}`, stackId, organizationId: org, componentKey: "web", internalPort: 8080, hostname, status });
  }

  async function siteDomain(org: string, hostname: string) {
    counter += 1;
    const created = await createSiteTransactional(db(), {
      organizationId: org,
      hostAllocationId: ALLOC[org]!,
      name: `Site ${String(counter)}`,
      slug: `stc-site-${String(counter)}`,
      phpVersion: "8.4",
      siteType: "wordpress",
    });
    const domainId = `dom_stc_${String(counter)}`;
    await db().insert(domains).values({ id: domainId, siteId: created.site.id, organizationId: org, hostname, status: "active" });
    return { siteId: created.site.id, domainId };
  }

  async function version(org: string, sanDns: string[]) {
    counter += 1;
    const created = await insertTlsCertificateWithVersion(db(), {
      organizationId: org,
      name: `cert ${String(counter)}`,
      createdForSiteId: null,
      createdByUserId: null,
      masterKey: "f".repeat(64),
      version: {
        leafPem: "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
        chainPem: "",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
        subject: "CN=test",
        issuer: "CN=Test CA",
        serialNumber: String(counter),
        fingerprintSha256: counter.toString(16).padStart(64, "0"),
        notBefore: new Date("2026-01-01T00:00:00.000Z"),
        notAfter: new Date("2027-11-01T00:00:00.000Z"),
        sanDns,
        keyType: "ec",
        keyBits: 256,
      },
    });
    return created.versionId;
  }

  /** The service transaction: check, then enqueue only when the check passes. */
  const assign = (org: string, siteId: string, domainId: string, versionId: string) =>
    db().transaction(async (tx) => {
      const plan = await checkAssignment(tx, { organizationId: org, siteId, changes: [{ domainId, versionId }], now: NOW });
      await enqueueSiteTlsOperation(tx, { organizationId: org, siteId, changes: plan.changes });
      return plan;
    });

  async function refusedAsForeign(promise: Promise<unknown>) {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlPlaneError);
    const refusal = err as ControlPlaneError;
    expect(refusal.code).toBe("DOMAIN_CONFLICT");
    expect(ERROR_CODE_HTTP_STATUS[refusal.code]).toBe(409);
    expect(refusal.message).not.toContain("app.example.com");
    expect(await db().select().from(outboxEvents)).toEqual([]);
    expect(await db().select().from(operations)).toEqual([]);
  }

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_stc", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_stc",
      platformInstallationId: "pin_stc",
      name: "stc-host",
      hostname: "panel.stc.test",
      ipv4Address: "10.0.0.61",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const org of [orgA, orgB]) {
      await db().insert(organizations).values({ id: org, platformInstallationId: "pin_stc", name: org, slug: org.replace(/_/g, "-") });
      await db().insert(hostAllocations).values({ id: ALLOC[org]!, hostId: "hst_stc", organizationId: org, status: "active" });
    }
    await db().insert(appTemplates).values({ id: "atpl_stc", slug: "stc-alpha", name: "Alpha", category: "web" });
    await db().insert(appTemplateVersions).values({
      id: "atv_stc1",
      templateId: "atpl_stc",
      versionNumber: 1,
      source: "x",
      specVersion: 1,
      compiledSchema: {},
      specHash: "a".repeat(64),
    });
  }, 120_000);

  afterEach(async () => {
    await db().delete(outboxEvents);
    await db().delete(operations);
    await db().delete(appStacks);
    await db().delete(domains);
    await db().delete(tlsCertificates);
  });

  afterAll(async () => {
    await client.close();
  });

  it("refuses a manual wildcard that covers another organisation's active stack hostname", async () => {
    await stackHost(orgB, "app.example.com", "active");
    const { siteId, domainId } = await siteDomain(orgA, "shop.example.com");
    await refusedAsForeign(assign(orgA, siteId, domainId, await version(orgA, ["*.example.com"])));
  });

  it("refuses it too while the other organisation's stack hostname is still pending", async () => {
    await stackHost(orgB, "app.example.com", "pending");
    const { siteId, domainId } = await siteDomain(orgA, "shop.example.com");
    await refusedAsForeign(assign(orgA, siteId, domainId, await version(orgA, ["*.example.com"])));
  });

  it("refuses a manual wildcard that would capture an active stack hostname of the same organisation", async () => {
    await stackHost(orgA, "app.example.com", "active");
    const { siteId, domainId } = await siteDomain(orgA, "shop.example.com");
    await refusedAsForeign(assign(orgA, siteId, domainId, await version(orgA, ["*.example.com"])));
  });

  it("with no stack rows the same assignment is accepted and queued as before", async () => {
    const { siteId, domainId } = await siteDomain(orgA, "shop.example.com");
    const versionId = await version(orgA, ["*.example.com"]);
    const plan = await assign(orgA, siteId, domainId, versionId);
    expect(plan).toMatchObject({
      noop: false,
      changes: [{ domainId, versionId }],
      domains: [{ domainId, siteId, hostname: "shop.example.com", fromVersionId: null, versionId }],
      fromVersionIds: [],
      evictAcmeHosts: [],
      collateralHosts: [],
    });
    const queued = await db().select().from(operations).where(eq(operations.organizationId, orgA));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.kind).toBe("site.tls.apply");
  });
});
