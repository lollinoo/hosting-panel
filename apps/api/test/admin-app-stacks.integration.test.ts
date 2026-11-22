import { appStackComponents, appStackDomains, appStacks, auditEvents, eq, hostAllocations, organizations } from "@hosting-panel/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

const ROUTE = "/v1/admin/app-stacks";
const ROW_KEYS = ["id", "name", "organizationName", "templateId", "templateName", "versionNumber", "status", "primaryHostname"];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function deniedRows(h: AppStackHarness, userId: string): Promise<number> {
  const rows = await h.dbClient.db.select().from(auditEvents).where(eq(auditEvents.actorId, userId));
  return rows.filter((row) => (row.details as Json | null)?.outcome === "denied").length;
}

/** Inserts live (or deleted) stacks of `customer` on the published template, straight into the table. */
async function stacks(
  h: AppStackHarness,
  ids: { templateId: string; versionId: string },
  customer: HarnessCustomer,
  rows: readonly { id: string; name: string; deletedAt?: Date }[],
): Promise<void> {
  const [allocation] = await h.dbClient.db.select().from(hostAllocations).where(eq(hostAllocations.organizationId, customer.orgId));
  await h.dbClient.db.insert(appStacks).values(
    rows.map((row) => ({
      id: row.id,
      organizationId: customer.orgId,
      hostAllocationId: allocation!.id,
      templateId: ids.templateId,
      templateVersionId: ids.versionId,
      name: row.name,
      status: row.deletedAt ? ("deleted" as const) : ("running" as const),
      deletedAt: row.deletedAt ?? null,
    })),
  );
}

async function domains(h: AppStackHarness, customer: HarnessCustomer, stackId: string, list: readonly [string, "pending" | "active"][]) {
  await h.dbClient.db.insert(appStackComponents).values({ stackId, organizationId: customer.orgId, componentKey: "web" });
  await h.dbClient.db.insert(appStackDomains).values(
    list.map(([hostname, status], i) => ({
      id: `sdom_${stackId}_${String(i)}`,
      stackId,
      organizationId: customer.orgId,
      componentKey: "web",
      internalPort: 8080,
      hostname,
      status,
    })),
  );
}

describe("GET /v1/admin/app-stacks", () => {
  let h: AppStackHarness;

  beforeEach(async () => {
    h = await startAppStackHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("lists every customer's live stacks by customer, name and id, without deleted ones and without writing", async () => {
    const ids = await h.publish();
    await stacks(h, ids, h.a, [
      { id: "stk_a2", name: "Wiki" },
      { id: "stk_a1", name: "Notes" },
    ]);
    await stacks(h, ids, h.b, [
      { id: "stk_b1", name: "Shop" },
      { id: "stk_b2", name: "Gone", deletedAt: new Date() },
    ]);
    const row = (id: string, name: string, organizationName: string) => ({
      id,
      name,
      organizationName,
      templateId: ids.templateId,
      templateName: "Notes Demo",
      versionNumber: 1,
      status: "running",
      primaryHostname: null,
    });

    const before = await h.counts();
    const res = await h.call(h.adminToken, "GET", ROUTE);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toEqual({
      truncated: false,
      stacks: [row("stk_b1", "Shop", "Bar Luigi"), row("stk_a1", "Notes", "Hotel Mario"), row("stk_a2", "Wiki", "Hotel Mario")],
    });
    for (const stack of res.body.data.stacks as Json[]) expect(Object.keys(stack).sort()).toEqual([...ROW_KEYS].sort());
    expect(await h.counts()).toEqual(before);

    await h.dbClient.db.update(organizations).set({ name: "Hotel Mario" }).where(eq(organizations.id, h.b.orgId));
    await stacks(h, ids, h.b, [{ id: "stk_b0", name: "Notes" }]);
    const tied = await h.call(h.adminToken, "GET", ROUTE);
    expect((tied.body.data.stacks as Json[]).map((s) => s.id)).toEqual(["stk_a1", "stk_b0", "stk_b1", "stk_a2"]);
  });

  it("shows the first active address by hostname, else the first address, else null", async () => {
    const ids = await h.publish();
    await stacks(h, ids, h.a, [
      { id: "stk_active", name: "One" },
      { id: "stk_pending", name: "Two" },
      { id: "stk_none", name: "Three" },
    ]);
    await domains(h, h.a, "stk_active", [
      ["a.example.test", "pending"],
      ["b.example.test", "active"],
    ]);
    await domains(h, h.a, "stk_pending", [
      ["d.example.test", "pending"],
      ["c.example.test", "pending"],
    ]);

    const res = await h.call(h.adminToken, "GET", ROUTE);
    expect(res.status, res.raw).toBe(200);
    expect(Object.fromEntries((res.body.data.stacks as Json[]).map((s) => [s.id, s.primaryHostname]))).toEqual({
      stk_active: "b.example.test",
      stk_pending: "c.example.test",
      stk_none: null,
    });
  });

  it("returns at most 200 stacks and says more exist", async () => {
    const ids = await h.publish();
    const n = (i: number) => String(i).padStart(3, "0");
    await stacks(
      h,
      ids,
      h.a,
      Array.from({ length: 201 }, (_, i) => ({ id: `stk_${n(i)}`, name: `s${n(i)}` })),
    );

    const res = await h.call(h.adminToken, "GET", ROUTE);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data.truncated).toBe(true);
    expect(res.body.data.stacks).toHaveLength(200);
    expect(res.body.data.stacks[199].id).toBe("stk_199");
  });

  it("refuses an owner and a collaborator with 403 and one denied audit row each, and an anonymous call with 401", async () => {
    const collaborator = await h.addMember(h.a.orgId, "role_customer_collaborator");
    for (const actor of [h.a, collaborator]) {
      const res = await h.call(actor.token, "GET", ROUTE);
      expect(res.status, res.raw).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
      expect(await deniedRows(h, actor.userId)).toBe(1);
    }
    expect((await h.call(null, "GET", ROUTE)).status).toBe(401);
  });
});

describe("GET /v1/admin/app-stacks while the capability flags are off", () => {
  let h: AppStackHarness;

  beforeEach(async () => {
    h = await startAppStackHarness({ appFeatures: {} });
  });

  afterEach(async () => {
    await h.close();
  });

  it("answers the administrator 422 STACK_UNSUPPORTED_FEATURE and still refuses an owner with 403", async () => {
    const res = await h.call(h.adminToken, "GET", ROUTE);
    expect(res.status, res.raw).toBe(422);
    expect(res.body.error).toMatchObject({ code: "NOT_SUPPORTED", details: [{ reason: "STACK_UNSUPPORTED_FEATURE" }] });
    const owner = await h.call(h.a.token, "GET", ROUTE);
    expect(owner.status, owner.raw).toBe(403);
    expect(owner.body.error.code).toBe("PERMISSION_DENIED");
    expect(await deniedRows(h, h.a.userId)).toBe(1);
  });
});
