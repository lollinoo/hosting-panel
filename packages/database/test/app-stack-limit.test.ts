import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appStacks,
  AppStackQuotaError,
  appTemplates,
  appTemplateVersions,
  chargeAppStackQuota,
  countAppStacksByOrganization,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
  lockAppStackLimitUsage,
  organizations,
  platformInstallations,
  resourceQuotas,
  updateOrganizationAppStackLimitTransactional,
  type DatabaseClient,
} from "../src/index.js";

// Per-organization stack limit (organizations.max_app_stacks) and the resource_quotas charge of the desired revision.
describe("@hosting-panel/database — app stack limit and quota charge", () => {
  let client: DatabaseClient;
  const db = () => client.db;
  let n = 0;
  const totals = (componentCount: number, cpuMilli: number, memoryBytes: number) => ({ componentCount, cpuMilli, memoryBytes });

  async function organization(maxAppStacks: number | null = null) {
    n += 1;
    const id = `org_asl_${String(n)}`;
    await db().insert(organizations).values({ id, platformInstallationId: "pin_asl", name: id, slug: id, maxAppStacks });
    await db().insert(hostAllocations).values({ id: `al_${id}`, hostId: "h_asl", organizationId: id });
    return { id, allocation: `al_${id}` };
  }

  async function stack(org: { id: string; allocation: string }, deleted = false) {
    n += 1;
    const id = `stk_asl_${String(n)}`;
    await db().insert(appStacks).values({
      id,
      organizationId: org.id,
      hostAllocationId: org.allocation,
      templateId: "atpl_asl",
      templateVersionId: "atv_asl",
      name: id,
      ...(deleted ? { status: "deleted" as const, deletedAt: new Date() } : {}),
    });
    return id;
  }

  async function quota(org: { id: string; allocation: string }, over: Partial<typeof resourceQuotas.$inferInsert> = {}) {
    n += 1;
    const id = `rq_asl_${String(n)}`;
    await db().insert(resourceQuotas).values({
      id,
      organizationId: org.id,
      hostAllocationId: org.allocation,
      maxSites: 10,
      maxServices: 8,
      maxCpuMilli: 2000,
      maxMemoryBytes: "1000000000",
      maxStorageBytes: "1000000000",
      ...over,
    });
    return id;
  }

  const quotaRow = async (id: string) => (await db().select().from(resourceQuotas).where(eq(resourceQuotas.id, id)))[0];
  const stackQuotaId = async (id: string) =>
    (await db().select({ q: appStacks.resourceQuotaId }).from(appStacks).where(eq(appStacks.id, id)))[0]?.q;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_asl", name: "P" });
    await db().insert(hosts).values({
      id: "h_asl", platformInstallationId: "pin_asl", name: "h", hostname: "h.asl.local", ipv4Address: "10.0.0.8",
      totalCpuMilli: 4000, totalMemoryBytes: "4000000000", totalStorageBytes: "100000000000",
    });
    await db().insert(appTemplates).values({ id: "atpl_asl", slug: "asl-demo", name: "Demo", category: "web" });
    await db().insert(appTemplateVersions).values({
      id: "atv_asl", templateId: "atpl_asl", versionNumber: 1, source: "x", specVersion: 1, compiledSchema: {}, specHash: "a".repeat(64),
    });
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("1. lockAppStackLimitUsage returns the limit and counts live stacks only; an unknown organization is NOT_FOUND", async () => {
    const org = await organization(3);
    await stack(org);
    await stack(org);
    await stack(org, true);
    await expect(db().transaction((tx) => lockAppStackLimitUsage(tx, org.id))).resolves.toEqual({ maxAppStacks: 3, usedAppStacks: 2 });
    await expect(db().transaction((tx) => lockAppStackLimitUsage(tx, "org_missing"))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("2. updateOrganizationAppStackLimitTransactional returns the previous value and the usage; an unknown organization gives null", async () => {
    const org = await organization(5);
    await stack(org);
    await stack(org, true);
    expect(await updateOrganizationAppStackLimitTransactional(db(), { organizationId: org.id, maxAppStacks: 1 })).toEqual({
      previousMaxAppStacks: 5,
      maxAppStacks: 1,
      usedAppStacks: 1,
    });
    expect(await updateOrganizationAppStackLimitTransactional(db(), { organizationId: org.id, maxAppStacks: null })).toEqual({
      previousMaxAppStacks: 1,
      maxAppStacks: null,
      usedAppStacks: 1,
    });
    const [row] = await db().select().from(organizations).where(eq(organizations.id, org.id));
    expect(row?.maxAppStacks).toBeNull();
    expect(await updateOrganizationAppStackLimitTransactional(db(), { organizationId: "org_missing", maxAppStacks: 1 })).toBeNull();
  });

  it("3. countAppStacksByOrganization ignores deleted stacks and maps organizations without stacks to 0", async () => {
    const empty = await organization();
    const two = await organization();
    await stack(two);
    await stack(two);
    await stack(two, true);
    const counts = await countAppStacksByOrganization(db(), [empty.id, two.id, "org_missing"]);
    expect(counts.get(empty.id)).toBe(0);
    expect(counts.get(two.id)).toBe(2);
    expect(counts.get("org_missing")).toBe(0);
    expect((await countAppStacksByOrganization(db(), [])).size).toBe(0);
  });

  it("4. no resource_quotas row: no charge and nothing written, even when a row appears later", async () => {
    const org = await organization();
    const stackId = await stack(org);
    const input = { organizationId: org.id, stackId, hostAllocationId: org.allocation, resourceQuotaId: null };
    expect(await chargeAppStackQuota(db(), { ...input, previous: null, next: totals(2, 500, 1000) })).toEqual({ resourceQuotaId: null });
    expect(await stackQuotaId(stackId)).toBeNull();
    const rq = await quota(org);
    expect(await chargeAppStackQuota(db(), { ...input, previous: totals(2, 500, 1000), next: totals(3, 600, 2000) })).toEqual({
      resourceQuotaId: null,
    });
    expect(await stackQuotaId(stackId)).toBeNull();
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 0, usedCpuMilli: 0, usedMemoryBytes: "0" });
  });

  it("5. the first charge records the row id on the stack and adds the totals; later charges add the delta", async () => {
    const org = await organization();
    const rq = await quota(org, { usedServices: 1, usedCpuMilli: 100, usedMemoryBytes: "100" });
    const stackId = await stack(org);
    const input = { organizationId: org.id, stackId, hostAllocationId: org.allocation };
    expect(await chargeAppStackQuota(db(), { ...input, resourceQuotaId: null, previous: null, next: totals(2, 500, 1000) })).toEqual({
      resourceQuotaId: rq,
    });
    expect(await stackQuotaId(stackId)).toBe(rq);
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 3, usedCpuMilli: 600, usedMemoryBytes: "1100" });
    await chargeAppStackQuota(db(), { ...input, resourceQuotaId: rq, previous: totals(2, 500, 1000), next: totals(3, 700, 1500) });
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 4, usedCpuMilli: 800, usedMemoryBytes: "1600" });
  });

  it("6. a positive delta over max_cpu_milli or max_memory_bytes throws AppStackQuotaError and writes nothing", async () => {
    const org = await organization();
    const rq = await quota(org, { maxServices: 4, maxCpuMilli: 1000, maxMemoryBytes: "5000", usedServices: 2, usedCpuMilli: 400, usedMemoryBytes: "3000" });
    const stackId = await stack(org);
    const charge = (next: ReturnType<typeof totals>) =>
      chargeAppStackQuota(db(), { organizationId: org.id, stackId, hostAllocationId: org.allocation, resourceQuotaId: null, previous: null, next });
    // The third case is also over max_services: the count of components is no bound, so the field is still the processor.
    const cases = [
      [totals(1, 700, 100), "cpuMilli", 400, 1000],
      [totals(1, 100, 2001), "memoryBytes", 3000, 5000],
      [totals(9, 700, 100), "cpuMilli", 400, 1000],
    ] as const;
    for (const [next, field, used, limit] of cases) {
      const error = await charge(next).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppStackQuotaError);
      expect(error).toMatchObject({ name: "AppStackQuotaError", code: "QUOTA_EXCEEDED", reason: "STACK_QUOTA_EXCEEDED", field, used, limit });
    }
    expect(await stackQuotaId(stackId)).toBeNull();
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 2, usedCpuMilli: 400, usedMemoryBytes: "3000" });
    await charge(totals(2, 600, 2000));
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 4, usedCpuMilli: 1000, usedMemoryBytes: "5000" });
  });

  it("6b. the number of components is bookkeeping, not a bound: max_services 20 with 18 in use takes 4 more, and deleting gives them back (issue #151)", async () => {
    const org = await organization();
    const rq = await quota(org, { maxServices: 20, usedServices: 18 });
    const stackId = await stack(org);
    const input = { organizationId: org.id, stackId, hostAllocationId: org.allocation };
    expect(await chargeAppStackQuota(db(), { ...input, resourceQuotaId: null, previous: null, next: totals(4, 400, 4000) })).toEqual({
      resourceQuotaId: rq,
    });
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 22, usedCpuMilli: 400, usedMemoryBytes: "4000" });
    // An upgrade that adds components while the count is already over the maximum is accepted too.
    await chargeAppStackQuota(db(), { ...input, resourceQuotaId: rq, previous: totals(4, 400, 4000), next: totals(8, 500, 5000) });
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 26, usedCpuMilli: 500, usedMemoryBytes: "5000" });
    expect(await chargeAppStackQuota(db(), { ...input, resourceQuotaId: rq, previous: totals(8, 500, 5000), next: null })).toEqual({
      resourceQuotaId: null,
    });
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 18, usedCpuMilli: 0, usedMemoryBytes: "0" });
    expect(await stackQuotaId(stackId)).toBeNull();
  });

  it("7. a negative delta is applied without a check, even when the row is already over its maximum", async () => {
    const org = await organization();
    const rq = await quota(org, { maxServices: 1, maxCpuMilli: 100, maxMemoryBytes: "100", usedServices: 5, usedCpuMilli: 900, usedMemoryBytes: "900" });
    const stackId = await stack(org);
    await chargeAppStackQuota(db(), {
      organizationId: org.id, stackId, hostAllocationId: org.allocation, resourceQuotaId: rq, previous: totals(4, 800, 800), next: totals(1, 300, 200),
    });
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 2, usedCpuMilli: 400, usedMemoryBytes: "300" });
  });

  it("8. release subtracts the previous totals, floors at 0 and clears the stack's quota id; a NULL id releases nothing", async () => {
    const org = await organization();
    const rq = await quota(org, { usedServices: 1, usedCpuMilli: 1000, usedMemoryBytes: "100" });
    const stackId = await stack(org);
    await db().update(appStacks).set({ resourceQuotaId: rq }).where(eq(appStacks.id, stackId));
    const input = { organizationId: org.id, stackId, hostAllocationId: org.allocation, previous: totals(2, 300, 500), next: null };
    expect(await chargeAppStackQuota(db(), { ...input, resourceQuotaId: rq })).toEqual({ resourceQuotaId: null });
    expect(await stackQuotaId(stackId)).toBeNull();
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 0, usedCpuMilli: 700, usedMemoryBytes: "0" });
    expect(await chargeAppStackQuota(db(), { ...input, resourceQuotaId: null })).toEqual({ resourceQuotaId: null });
    expect(await quotaRow(rq)).toMatchObject({ usedServices: 0, usedCpuMilli: 700, usedMemoryBytes: "0" });
  });

  it("9. memory is charged as a BigInt string above 2^32", async () => {
    const org = await organization();
    const rq = await quota(org, { maxMemoryBytes: "17179869184", usedMemoryBytes: "4294967296" });
    const stackId = await stack(org);
    const input = { organizationId: org.id, stackId, hostAllocationId: org.allocation, resourceQuotaId: null, previous: null };
    await chargeAppStackQuota(db(), { ...input, next: totals(1, 100, 8589934592) });
    expect((await quotaRow(rq))?.usedMemoryBytes).toBe("12884901888");
    await expect(
      chargeAppStackQuota(db(), { ...input, resourceQuotaId: rq, previous: totals(1, 100, 8589934592), next: totals(1, 100, 12884901889) }),
    ).rejects.toMatchObject({ field: "memoryBytes", used: 12884901888, limit: 17179869184 });
  });

  it("10. the stack count locks the organizations row FOR NO KEY UPDATE and the charge locks resource_quotas FOR UPDATE", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/app-stack-limit.ts", import.meta.url)), "utf8");
    expect(source).toContain('.for("no key update")');
    expect(source).toContain('.for("update")');
  });
});
