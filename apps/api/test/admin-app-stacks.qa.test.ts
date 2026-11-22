import { randomBytes, randomUUID } from "node:crypto";
import { appStackParameters, appStacks, eq, hostAllocations, organizations } from "@hosting-panel/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin } from "../src/cli/accounts.js";
import { startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

const ROUTE = "/v1/admin/app-stacks";
const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const ROW_KEYS = ["id", "name", "organizationName", "templateId", "templateName", "versionNumber", "status", "primaryHostname"];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Status = "running" | "deleting" | "delete_failed" | "deleted";

describe("QA-A3: GET /v1/admin/app-stacks edge cases", () => {
  let h: AppStackHarness;
  let ids: { templateId: string; versionId: string };

  beforeEach(async () => {
    h = await startAppStackHarness();
    ids = await h.publish();
  });

  afterEach(async () => {
    await h.close();
  });

  async function insert(
    customer: HarnessCustomer,
    rows: readonly { id: string; name: string; status?: Status; deletedAt?: Date | null }[],
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
        status: row.status ?? ("running" as const),
        deletedAt: row.deletedAt ?? null,
      })),
    );
  }

  const idsOf = (res: { body: Json }): string[] => (res.body.data.stacks as Json[]).map((s) => s.id as string);

  it("refuses an administrator disabled after login with 401 and no stack data", async () => {
    await insert(h.a, [{ id: "stk_x1", name: "Notes" }]);
    const other = await createServerAdmin(h.dbClient.db, KEY, { email: "admin-qa3@example.test", name: "Admin qa3", password: PW });
    const login = await h.call(null, "POST", "/v1/auth/login", {
      email: "admin-qa3@example.test",
      password: PW,
      totpCode: totpCodeAt(other.totpSecretBase32, Math.floor(Date.now() / 30_000)),
    });
    expect(login.status, login.raw).toBe(200);
    const token = login.body.data.accessToken as string;
    expect((await h.call(token, "GET", ROUTE)).status).toBe(200);

    const off = await h.call(h.adminToken, "PATCH", `/v1/admin/users/${other.userId}`, { status: "disabled" });
    expect(off.status, off.raw).toBe(200);

    const res = await h.call(token, "GET", ROUTE);
    expect(res.status, res.raw).toBe(401);
    expect(res.raw).not.toContain("stk_x1");
    expect(res.raw).not.toContain("Hotel Mario");
  });

  it.each(["?limit=1&x=y", "?limit=0", "?truncated=true&status=deleted", "?organizationId=nope&name=zzz"])(
    "ignores the query string %s (200, the full list)",
    async (query) => {
      await insert(h.a, [
        { id: "stk_a1", name: "Notes" },
        { id: "stk_a2", name: "Wiki" },
      ]);
      await insert(h.b, [{ id: "stk_b1", name: "Shop" }]);
      const plain = await h.call(h.adminToken, "GET", ROUTE);
      const res = await h.call(h.adminToken, "GET", `${ROUTE}${query}`);
      expect(res.status, res.raw).toBe(200);
      expect(idsOf(res)).toEqual(["stk_b1", "stk_a1", "stk_a2"]);
      expect(res.body.data).toEqual(plain.body.data);
      expect(res.body.data.truncated).toBe(false);
    },
  );

  it.each<[Status, boolean]>([
    ["running", true],
    ["deleting", true],
    ["delete_failed", true],
    ["deleted", false],
  ])("a stack in status %s with deleted_at null is listed: %s", async (status, listed) => {
    // `deleted` is the only state whose row is hidden, and it carries deleted_at.
    await insert(h.a, [{ id: "stk_s1", name: "Probe", status, deletedAt: status === "deleted" ? new Date() : null }]);
    const res = await h.call(h.adminToken, "GET", ROUTE);
    expect(res.status, res.raw).toBe(200);
    expect(idsOf(res).includes("stk_s1")).toBe(listed);
    if (listed) expect((res.body.data.stacks as Json[]).find((s) => s.id === "stk_s1")?.status).toBe(status);
  });

  it("lists deleting and delete_failed stacks next to live ones and leaves the deleted ones out", async () => {
    await insert(h.a, [
      { id: "stk_1", name: "A-running" },
      { id: "stk_2", name: "B-deleting", status: "deleting" },
      { id: "stk_3", name: "C-failed", status: "delete_failed" },
      { id: "stk_4", name: "D-gone", status: "deleted", deletedAt: new Date() },
    ]);
    const res = await h.call(h.adminToken, "GET", ROUTE);
    expect(res.status, res.raw).toBe(200);
    expect((res.body.data.stacks as Json[]).map((s) => [s.id, s.status])).toEqual([
      ["stk_1", "running"],
      ["stk_2", "deleting"],
      ["stk_3", "delete_failed"],
    ]);
  });

  it("orders two customers with the same name by stack name, then id, whatever the insertion order", async () => {
    for (const orgId of [h.a.orgId, h.b.orgId]) {
      await h.dbClient.db.update(organizations).set({ name: "Same Name" }).where(eq(organizations.id, orgId));
    }
    await insert(h.b, [
      { id: "stk_9", name: "Same" },
      { id: "stk_3", name: "Beta" },
    ]);
    await insert(h.a, [
      { id: "stk_5", name: "Same" },
      { id: "stk_7", name: "Alpha" },
      { id: "stk_1", name: "Beta" },
    ]);
    const res = await h.call(h.adminToken, "GET", ROUTE);
    expect(res.status, res.raw).toBe(200);
    // Alpha < Beta (stk_1 < stk_3) < Same (stk_5 < stk_9): the organisation id never decides.
    expect(idsOf(res)).toEqual(["stk_7", "stk_1", "stk_3", "stk_5", "stk_9"]);
    expect((res.body.data.stacks as Json[]).map((s) => s.organizationName)).toEqual(Array(5).fill("Same Name"));
  });

  it("every row has exactly the eight DTO keys, with no internal id", async () => {
    await insert(h.a, [{ id: "stk_k1", name: "Keys" }]);
    await insert(h.b, [{ id: "stk_k2", name: "Keys", status: "deleting" }]);
    const res = await h.call(h.adminToken, "GET", ROUTE);
    expect(res.status, res.raw).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(["stacks", "truncated"]);
    for (const stack of res.body.data.stacks as Json[]) expect(Object.keys(stack).sort()).toEqual([...ROW_KEYS].sort());
  });

  it("the raw body names no allocation, revision, idempotency key, request hash, secret value or parameter value", async () => {
    const canary = randomBytes(30).toString("base64url").slice(0, 40);
    const paramCanary = `param-${randomUUID()}`;
    const idempotencyKey = `idem-${randomUUID()}`;

    // A real draft stack of customer A with a secret set through the secrets route and an idempotency key.
    const created = await h.call(
      h.a.token,
      "POST",
      `/v1/organizations/${h.a.orgId}/app-stacks`,
      { templateVersionId: ids.versionId, name: "Canary", deploy: false },
      { "Idempotency-Key": idempotencyKey },
    );
    expect(created.status, created.raw).toBe(201);
    const stackId = created.body.data.stackId as string;
    const secret = await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/secrets`, {
      parameterKey: "app_secret",
      value: canary,
    });
    expect(secret.status, secret.raw).toBe(200);
    // A public parameter value that must not travel either.
    await h.dbClient.db.insert(appStackParameters).values({
      stackId,
      organizationId: h.a.orgId,
      parameterKey: "worker_count_note",
      publicValue: paramCanary,
    });
    const [row] = await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId));
    const [allocation] = await h.dbClient.db.select().from(hostAllocations).where(eq(hostAllocations.organizationId, h.a.orgId));
    // Make sure the internal values the test hunts for really exist.
    expect(allocation!.id).toBeTruthy();
    expect(row!.idempotencyKey ?? row!.requestHash).toBeTruthy();

    const res = await h.call(h.adminToken, "GET", ROUTE);
    expect(res.status, res.raw).toBe(200);
    expect(idsOf(res)).toEqual([stackId]);

    const forbidden = [
      "hostAllocationId",
      "desiredRevisionId",
      "idempotencyKey",
      "requestHash",
      "organizationId",
      "templateVersionId",
      allocation!.id,
      idempotencyKey,
      row!.requestHash,
      row!.desiredRevisionId,
      canary,
      Buffer.from(canary).toString("base64"),
      Buffer.from(canary).toString("hex"),
      encodeURIComponent(canary),
      paramCanary,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const needle of forbidden) expect(res.raw, `the body contains ${needle}`).not.toContain(needle);
  });
});
