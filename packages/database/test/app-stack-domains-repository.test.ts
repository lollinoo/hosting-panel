import { MAX_APP_STACK_DOMAINS } from "@hosting-panel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addAppStackDomainsTransactional,
  AppStackDomainError,
  appStackComponents,
  appStacks,
  appTemplates,
  appTemplateVersions,
  createDatabaseClient,
  createSiteTransactional,
  eq,
  hostAllocations,
  hosts,
  insertTlsCertificateWithVersion,
  listAppStackDomains,
  listAppStackDomainsDue,
  listAppStackHostnames,
  organizations,
  platformInstallations,
  removeAppStackDomainTransactional,
  sql,
  updateAppStackDomainRoutingTransactional,
  tlsCertificates,
  tlsCertificateVersions,
  TlsCoverageError,
  updateAppStackDomainState,
  type AppStackDomainRouting,
  type DatabaseClient,
  type HostingPanelDatabase,
} from "../src/index.js";

// Web addresses of a stack: one hostname has one owner across sites, stacks and the panel host (pre-check, then the
// 0025 triggers), at most MAX_APP_STACK_DOMAINS per stack, and no published manual certificate may capture one.
const orgA = "org_sd_a";
const orgB = "org_sd_b";
const ALLOC: Record<string, string> = { [orgA]: "alloc_sd_a", [orgB]: "alloc_sd_b" };

describe("@hosting-panel/database — app stack domains repository", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;

  async function stack(org = orgA): Promise<string> {
    counter += 1;
    const id = `stk_sd_${String(counter)}`;
    await db().insert(appStacks).values({
      id,
      organizationId: org,
      hostAllocationId: ALLOC[org]!,
      templateId: "atpl_sd",
      templateVersionId: "atv_sd1",
      name: `Stack ${String(counter)}`,
    });
    await db().insert(appStackComponents).values({ stackId: id, organizationId: org, componentKey: "web" });
    return id;
  }

  const add = (stackId: string, hostnames: string[], org = orgA, componentKey = "web") =>
    addAppStackDomainsTransactional(db(), {
      organizationId: org,
      stackId,
      entries: hostnames.map((hostname) => ({ hostname, componentKey, internalPort: 8080 })),
    });

  async function certificate(org: string, sanDns: string[]) {
    counter += 1;
    const created = await insertTlsCertificateWithVersion(db(), {
      organizationId: org,
      name: `cert ${String(counter)}`,
      createdForSiteId: null,
      createdByUserId: null,
      masterKey: "e".repeat(64),
      version: {
        leafPem: "-----BEGIN CERTIFICATE-----\nLEAF\n-----END CERTIFICATE-----\n",
        chainPem: "",
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nKEY\n-----END PRIVATE KEY-----\n",
        subject: "CN=test",
        issuer: "CN=Test CA",
        serialNumber: String(counter),
        fingerprintSha256: counter.toString(16).padStart(64, "0"),
        notBefore: new Date("2026-11-01T00:00:00.000Z"),
        notAfter: new Date("2027-11-01T00:00:00.000Z"),
        sanDns,
        keyType: "ec",
        keyBits: 256,
      },
    });
    await db().update(tlsCertificateVersions).set({ status: "active" }).where(eq(tlsCertificateVersions.id, created.versionId));
  }

  async function site(org: string, initialDomain?: string) {
    counter += 1;
    const created = await createSiteTransactional(db(), {
      organizationId: org,
      hostAllocationId: ALLOC[org]!,
      name: `Site ${String(counter)}`,
      slug: `sd-site-${String(counter)}`,
      phpVersion: "8.4",
      siteType: "wordpress",
      ...(initialDomain === undefined ? {} : { initialDomain }),
    });
    return created.site.id;
  }

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_sd", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_sd",
      platformInstallationId: "pin_sd",
      name: "sd-host",
      hostname: "panel.sd.example",
      ipv4Address: "10.0.0.41",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const org of [orgA, orgB]) {
      await db().insert(organizations).values({ id: org, platformInstallationId: "pin_sd", name: org, slug: org.replace(/_/g, "-") });
      await db().insert(hostAllocations).values({ id: ALLOC[org]!, hostId: "hst_sd", organizationId: org, status: "active" });
    }
    await db().insert(appTemplates).values({ id: "atpl_sd", slug: "sd-alpha", name: "Alpha", category: "web" });
    await db().insert(appTemplateVersions).values({
      id: "atv_sd1",
      templateId: "atpl_sd",
      versionNumber: 1,
      source: "x",
      specVersion: 1,
      compiledSchema: {},
      specHash: "a".repeat(64),
    });
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("adds hostnames sorted, pending and due for a DNS check, and skips names already on the stack", async () => {
    const id = await stack();
    const rows = await add(id, ["b.add.example", "a.add.example"]);
    expect(rows.map((r) => r.hostname)).toEqual(["a.add.example", "b.add.example"]);
    for (const row of rows) {
      expect(row).toMatchObject({ stackId: id, organizationId: orgA, componentKey: "web", internalPort: 8080, status: "pending" });
      expect(row.id).toMatch(/^sdom_[0-9a-f]{24}$/);
      expect(row.dnsNextCheckAt.getTime()).toBeLessThanOrEqual(Date.now());
    }
    const again = await add(id, ["a.add.example", "c.add.example"]);
    expect(again.map((r) => r.hostname)).toEqual(["c.add.example"]);
    expect((await listAppStackDomains(db(), { organizationId: orgA, stackId: id })).map((r) => r.hostname)).toEqual([
      "a.add.example",
      "b.add.example",
      "c.add.example",
    ]);
  });

  it(`refuses more than ${String(MAX_APP_STACK_DOMAINS)} hostnames per stack`, async () => {
    const id = await stack();
    const names = Array.from({ length: MAX_APP_STACK_DOMAINS }, (_, i) => `n${String(i)}.limit.example`);
    await add(id, names);
    await expect(add(id, ["extra.limit.example"])).rejects.toMatchObject({ code: "DOMAIN_LIMIT" });
    await expect(add(id, [names[0]!])).resolves.toEqual([]);
    const other = await stack();
    await expect(add(other, [...names.map((n) => `x${n}`), "y.limit.example"])).rejects.toMatchObject({ code: "DOMAIN_LIMIT" });
    expect(await listAppStackDomains(db(), { organizationId: orgA, stackId: other })).toEqual([]);
  });

  it("refuses a stack of another organization or a deleted stack with NOT_FOUND", async () => {
    const id = await stack();
    await expect(add(id, ["nf.example"], orgB)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().update(appStacks).set({ status: "deleted", deletedAt: new Date() }).where(eq(appStacks.id, id));
    await expect(add(id, ["nf.example"])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a hostname held by a site, another stack or the panel host (pre-check)", async () => {
    await site(orgB, "site.conflict.example");
    const other = await stack(orgB);
    await add(other, ["stack.conflict.example"], orgB);
    const id = await stack();
    for (const hostname of ["site.conflict.example", "stack.conflict.example", "panel.sd.example"]) {
      const refusal = await add(id, [hostname]).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(AppStackDomainError);
      expect(refusal).toMatchObject({ code: "DOMAIN_CONFLICT" });
      expect((refusal as Error).message).not.toMatch(/conflict\.example|sd\.example|org_sd/);
    }
    expect(await listAppStackDomains(db(), { organizationId: orgA, stackId: id })).toEqual([]);
  });

  it("maps the hostname-claim trigger of a site insert landing after the pre-check to DOMAIN_CONFLICT", async () => {
    const siteId = await site(orgB);
    const id = await stack();
    // PGlite has one connection: a BEFORE trigger that sorts first stands in for the concurrent site writer.
    await db().execute(
      sql.raw(`CREATE FUNCTION sd_race() RETURNS TRIGGER AS $$ BEGIN
        INSERT INTO domains (id, site_id, organization_id, hostname) VALUES ('dom_sd_race', '${siteId}', '${orgB}', NEW.hostname);
        RETURN NEW; END; $$ LANGUAGE plpgsql`),
    );
    await db().execute(sql.raw("CREATE TRIGGER trg_a_sd_race BEFORE INSERT ON app_stack_domains FOR EACH ROW EXECUTE FUNCTION sd_race()"));
    try {
      await expect(add(id, ["race.example"])).rejects.toMatchObject({ code: "DOMAIN_CONFLICT" });
    } finally {
      await db().execute(sql.raw("DROP TRIGGER trg_a_sd_race ON app_stack_domains"));
      await db().execute(sql.raw("DROP FUNCTION sd_race()"));
    }
    expect(await listAppStackDomains(db(), { organizationId: orgA, stackId: id })).toEqual([]);
  });

  it("refuses a hostname captured by a published manual certificate", async () => {
    const id = await stack();
    try {
      await certificate(orgB, ["*.foreign.example"]);
      const foreign = await add(id, ["shop.foreign.example"]).catch((e: unknown) => e);
      expect(foreign).toBeInstanceOf(TlsCoverageError);
      expect(foreign).toMatchObject({ code: "DOMAIN_CONFLICT", reason: "foreign_coverage" });
      await certificate(orgA, ["*.own.example"]);
      const own = await add(id, ["shop.own.example"]).catch((e: unknown) => e);
      expect(own).toBeInstanceOf(TlsCoverageError);
      expect(own).toMatchObject({ code: "CERTIFICATE_IN_USE", reason: "captures_host", hostname: "shop.own.example" });
    } finally {
      await db().delete(tlsCertificates);
    }
    expect(await listAppStackDomains(db(), { organizationId: orgA, stackId: id })).toEqual([]);
  });

  it("refuses an unknown component with VALIDATION_ERROR", async () => {
    const id = await stack();
    await expect(add(id, ["comp.example"], orgA, "nope")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("removes a hostname of the stack only", async () => {
    const id = await stack();
    const [row] = await add(id, ["rm.example"]);
    await expect(removeAppStackDomainTransactional(db(), { organizationId: orgB, stackId: id, domainId: row!.id })).resolves.toBe(false);
    await expect(removeAppStackDomainTransactional(db(), { organizationId: orgA, stackId: id, domainId: row!.id })).resolves.toBe(true);
    await expect(removeAppStackDomainTransactional(db(), { organizationId: orgA, stackId: id, domainId: row!.id })).resolves.toBe(false);
    expect(await listAppStackDomains(db(), { organizationId: orgA, stackId: id })).toEqual([]);
  });

  it("lists due rows of live stacks only, by next check, and updates the state with compare-and-set", async () => {
    const live = await stack();
    const deleted = await stack();
    const [due, later] = await add(live, ["due1.example", "due2.example"]);
    await add(deleted, ["gone.example"]);
    await db().update(appStacks).set({ status: "deleted", deletedAt: new Date() }).where(eq(appStacks.id, deleted));
    const future = new Date(Date.now() + 3600_000);
    await expect(updateAppStackDomainState(db(), { domainId: later!.id, set: { dnsNextCheckAt: future } })).resolves.toBe(true);
    const dueIds = (await listAppStackDomainsDue(db(), { now: new Date(), limit: 100 })).map((r) => r.id);
    expect(dueIds).toContain(due!.id);
    expect(dueIds).not.toContain(later!.id);
    expect((await listAppStackDomains(db(), { organizationId: orgA, stackId: deleted })).some((r) => dueIds.includes(r.id))).toBe(false);
    expect(await listAppStackDomainsDue(db(), { now: new Date(), limit: 1 })).toHaveLength(1);

    const set = { certStatus: "requested" as const, certRequestedAt: new Date() };
    await expect(updateAppStackDomainState(db(), { domainId: due!.id, expect: { certStatus: "none" }, set })).resolves.toBe(true);
    await expect(updateAppStackDomainState(db(), { domainId: due!.id, expect: { certStatus: "none" }, set })).resolves.toBe(false);
    const [stored] = (await listAppStackDomains(db(), { organizationId: orgA, stackId: live })).filter((r) => r.id === due!.id);
    expect(stored).toMatchObject({ certStatus: "requested" });
    expect(stored!.updatedAt.getTime()).toBeGreaterThan(due!.updatedAt.getTime());
    await expect(updateAppStackDomainState(db(), { domainId: "sdom_missing", set })).resolves.toBe(false);
  });

  it("lists every stack hostname with its organization", async () => {
    await add(await stack(orgA), ["host-a.list.example"]);
    await add(await stack(orgB), ["host-b.list.example"], orgB);
    const all = await listAppStackHostnames(db());
    expect(all).toContainEqual({ hostname: "host-a.list.example", organizationId: orgA, status: "pending", certStatus: "none" });
    expect(all).toContainEqual({ hostname: "host-b.list.example", organizationId: orgB, status: "pending", certStatus: "none" });
  });

  // ---- routing options (0026, ADR-0037) ----
  const VERIFIER = "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/";
  const OTHER_VERIFIER = "$apr1$abcdefgh$0123456789./ABCDEFGHIJ";
  const NONE: AppStackDomainRouting = { redirectToDomainId: null, compression: false, protection: null, pathRoutes: [] };
  const RULE = { pathPrefix: "/api", componentKey: "web", port: 8080, stripPrefix: true };
  const route = (stackId: string, domainId: string, routing: Partial<AppStackDomainRouting>, org = orgA) =>
    updateAppStackDomainRoutingTransactional(db(), { organizationId: org, stackId, domainId, routing: { ...NONE, ...routing } });
  const options = (row: { redirectToDomainId: string | null; compression: boolean; accessUsername: string | null; accessPasswordHash: string | null; pathRoutes: unknown }) => ({
    redirectToDomainId: row.redirectToDomainId,
    compression: row.compression,
    accessUsername: row.accessUsername,
    accessPasswordHash: row.accessPasswordHash,
    pathRoutes: row.pathRoutes,
  });

  it("a new address has no option, and an update replaces every option and returns the row before and after", async () => {
    const id = await stack();
    const [row] = await add(id, ["opt.example"]);
    expect(options(row!)).toEqual({ redirectToDomainId: null, compression: false, accessUsername: null, accessPasswordHash: null, pathRoutes: [] });
    const first = await route(id, row!.id, { compression: true, protection: { username: "team", passwordHash: VERIFIER }, pathRoutes: [RULE] });
    expect(options(first.before)).toEqual(options(row!));
    expect(options(first.after)).toEqual({ redirectToDomainId: null, compression: true, accessUsername: "team", accessPasswordHash: VERIFIER, pathRoutes: [RULE] });
    expect(first.after.updatedAt.getTime()).toBeGreaterThanOrEqual(row!.updatedAt.getTime());
    // The other columns of the row are not touched.
    expect(first.after).toMatchObject({ hostname: "opt.example", status: "pending", dnsStatus: "unchecked", certStatus: "none" });
    const cleared = await route(id, row!.id, {});
    expect(options(cleared.after)).toEqual(options(row!));
  });

  it("a new address is created with compression on only when its entry says so", async () => {
    const id = await stack();
    const made = await addAppStackDomainsTransactional(db(), {
      organizationId: orgA,
      stackId: id,
      entries: [
        { hostname: "gz-on.example", componentKey: "web", internalPort: 8080, compression: true },
        { hostname: "gz-off.example", componentKey: "web", internalPort: 8080, compression: false },
        { hostname: "gz-none.example", componentKey: "web", internalPort: 8080 },
      ],
    });
    expect(Object.fromEntries(made.map((row) => [row.hostname, row.compression]))).toEqual({
      "gz-on.example": true,
      "gz-off.example": false,
      "gz-none.example": false,
    });
    for (const row of made) expect({ ...options(row), compression: false }).toEqual({ redirectToDomainId: null, compression: false, accessUsername: null, accessPasswordHash: null, pathRoutes: [] });
  });

  it("keeps the stored verifier when none is sent, replaces it when one is, and refuses to keep one that was never set", async () => {
    const id = await stack();
    const [row] = await add(id, ["pw.example"]);
    await expect(route(id, row!.id, { protection: { username: "team" } })).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
    await route(id, row!.id, { protection: { username: "team", passwordHash: VERIFIER } });
    const renamed = await route(id, row!.id, { protection: { username: "staff" } });
    expect(options(renamed.after)).toMatchObject({ accessUsername: "staff", accessPasswordHash: VERIFIER });
    const changed = await route(id, row!.id, { protection: { username: "staff", passwordHash: OTHER_VERIFIER } });
    expect(changed.after.accessPasswordHash).toBe(OTHER_VERIFIER);
    await route(id, row!.id, {});
    await expect(route(id, row!.id, { protection: { username: "staff" } })).rejects.toMatchObject({ code: "PASSWORD_REQUIRED" });
  });

  it("redirects only to another address of the same stack, never in a chain, and removing the target clears the redirect", async () => {
    const id = await stack();
    const [a, b, c] = await add(id, ["a.redir.example", "b.redir.example", "c.redir.example"]);
    const other = await stack();
    const [foreign] = await add(other, ["foreign.redir.example"]);
    const otherOrg = await stack(orgB);
    const [tenant] = await add(otherOrg, ["tenant.redir.example"], orgB);
    for (const target of [a!.id, foreign!.id, tenant!.id, "sdom_missing"]) {
      await expect(route(id, a!.id, { redirectToDomainId: target })).rejects.toMatchObject({ code: "REDIRECT_TARGET" });
    }
    const redirected = await route(id, a!.id, { redirectToDomainId: b!.id, compression: true });
    expect(options(redirected.after)).toMatchObject({ redirectToDomainId: b!.id, compression: true });
    // b is a destination: it cannot start redirecting; c cannot redirect to a, which redirects.
    await expect(route(id, b!.id, { redirectToDomainId: c!.id })).rejects.toMatchObject({ code: "REDIRECT_CHAIN" });
    await expect(route(id, c!.id, { redirectToDomainId: a!.id })).rejects.toMatchObject({ code: "REDIRECT_CHAIN" });
    await expect(route(id, c!.id, { redirectToDomainId: b!.id })).resolves.toMatchObject({ after: { redirectToDomainId: b!.id } });
    await expect(removeAppStackDomainTransactional(db(), { organizationId: orgA, stackId: id, domainId: b!.id })).resolves.toBe(true);
    const left = await listAppStackDomains(db(), { organizationId: orgA, stackId: id });
    expect(left.map((r) => [r.hostname, r.redirectToDomainId, r.compression])).toEqual([
      ["a.redir.example", null, true],
      ["c.redir.example", null, false],
    ]);
  });

  it("refuses an address of another organization, of a deleted stack or of another stack with NOT_FOUND", async () => {
    const id = await stack();
    const [row] = await add(id, ["nf.opt.example"]);
    const other = await stack();
    await expect(route(id, row!.id, { compression: true }, orgB)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(route(other, row!.id, { compression: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(route(id, "sdom_missing", { compression: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db().update(appStacks).set({ status: "deleted", deletedAt: new Date() }).where(eq(appStacks.id, id));
    await expect(route(id, row!.id, { compression: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [stored] = await listAppStackDomains(db(), { organizationId: orgA, stackId: id });
    expect(stored!.compression).toBe(false);
  });

  // ---- an address being removed (issue #112) ----
  /** A stack whose route file is published: its addresses may be in it. */
  async function published(org = orgA): Promise<string> {
    const id = await stack(org);
    await db().update(appStacks).set({ appliedRoutesHash: "f".repeat(64) }).where(eq(appStacks.id, id));
    return id;
  }
  const remove = (stackId: string, domainId: string) => removeAppStackDomainTransactional(db(), { organizationId: orgA, stackId, domainId });
  const everyRow = (stackId: string) => listAppStackDomains(db(), { organizationId: orgA, stackId, includeRemoving: true });

  it("with a route file published, a removal marks the address, which keeps its host name until a file without it is", async () => {
    const id = await published();
    const [row] = await add(id, ["mark.example"]);
    await expect(remove(id, row!.id)).resolves.toBe(true);
    expect(await listAppStackDomains(db(), { organizationId: orgA, stackId: id })).toEqual([]);
    const [marked, ...more] = await everyRow(id);
    expect(more).toEqual([]);
    expect(marked).toMatchObject({ id: row!.id, hostname: "mark.example" });
    expect(marked!.removalRequestedAt).toBeInstanceOf(Date);
    const refusal = await add(await stack(orgB), ["mark.example"], orgB).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: "DOMAIN_CONFLICT" });
    expect((refusal as Error).message).not.toMatch(/mark\.example|org_sd/);
    await expect(site(orgB, "mark.example")).rejects.toThrow();
    expect(await listAppStackHostnames(db())).toContainEqual(expect.objectContaining({ hostname: "mark.example" }));
  });

  it("refuses a second removal, an edit and the same name again on an address being removed, and counts it in no limit", async () => {
    const id = await published();
    const names = Array.from({ length: MAX_APP_STACK_DOMAINS }, (_, i) => `n${String(i)}.removing.example`);
    const [first] = await add(id, names);
    await remove(id, first!.id);
    await expect(remove(id, first!.id)).rejects.toMatchObject({ code: "REMOVING" });
    await expect(route(id, first!.id, { compression: true })).rejects.toMatchObject({ code: "REMOVING" });
    const again = await add(id, [first!.hostname]).catch((e: unknown) => e);
    expect(again).toBeInstanceOf(AppStackDomainError);
    expect(again).toMatchObject({ code: "DOMAIN_CONFLICT" });
    await expect(add(id, ["extra.removing.example"])).resolves.toHaveLength(1);
    expect(await everyRow(id)).toHaveLength(MAX_APP_STACK_DOMAINS + 1);
    const [marked] = (await everyRow(id)).filter((r) => r.id === first!.id);
    expect(marked!.compression).toBe(false);
  });

  it("an address being removed is no redirect target; the redirects to it end at once, its own one blocks nothing", async () => {
    const id = await published();
    const [a, b, c, d] = await add(id, ["a.going.example", "b.going.example", "c.going.example", "d.going.example"]);
    await route(id, a!.id, { redirectToDomainId: b!.id, compression: true });
    await route(id, d!.id, { redirectToDomainId: c!.id });
    await remove(id, b!.id);
    await remove(id, d!.id);
    expect((await listAppStackDomains(db(), { organizationId: orgA, stackId: id })).map((r) => [r.hostname, r.redirectToDomainId, r.compression])).toEqual([
      ["a.going.example", null, true],
      ["c.going.example", null, false],
    ]);
    await expect(route(id, c!.id, { redirectToDomainId: b!.id })).rejects.toMatchObject({ code: "REDIRECT_TARGET" });
    // d, being removed, still redirects to c in the published file: c may redirect all the same.
    await expect(route(id, c!.id, { redirectToDomainId: a!.id })).resolves.toMatchObject({ after: { redirectToDomainId: a!.id } });
  });

  it("with no route file published, a removal deletes the address and frees the name at once", async () => {
    const id = await stack();
    const [row] = await add(id, ["free.removing.example"]);
    await expect(remove(id, row!.id)).resolves.toBe(true);
    expect(await everyRow(id)).toEqual([]);
    await expect(add(await stack(orgB), ["free.removing.example"], orgB)).resolves.toHaveLength(1);
  });
});
