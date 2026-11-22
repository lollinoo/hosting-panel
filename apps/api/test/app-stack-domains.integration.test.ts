import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  and,
  appStackDomains,
  appStacks,
  auditEvents,
  eq,
  resourceQuotas,
  tlsCertificates,
  tlsCertificateVersions,
} from "@hosting-panel/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

const CONFLICT =
  "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.";
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("application stack domains HTTP API (H6)", () => {
  let h: AppStackHarness;
  let notes: string;
  let web: string;
  let reconcile: MockInstance<AppStackObserverService["reconcileStack"]>;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    notes = (await h.publish()).versionId;
    web = (await h.publish(APP_BUILT_IN_TEMPLATES[0]!.source)).versionId;
    reconcile = vi.spyOn(h.app.nestApp.get(AppStackObserverService), "reconcileStack").mockResolvedValue(undefined);
  }, 120_000);

  beforeEach(() => {
    reconcile.mockClear();
  });

  afterAll(async () => {
    await h?.close();
  });

  const base = (c: HarnessCustomer, stackId: string) => `/v1/organizations/${c.orgId}/app-stacks/${stackId}/domains`;
  const add = (stackId: string, body: Json, c: HarnessCustomer = h.a) => h.call(c.token, "POST", base(c, stackId), body);
  const appDomain = (hostname: string) => ({ hostname, componentKey: "app", port: 8080 });
  const rows = (stackId: string) => h.dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId));
  const audits = (action: string, targetId: string) =>
    h.dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)));

  const createStack = (c: HarnessCustomer, templateVersionId: string, deploy: boolean) =>
    h.call(c.token, "POST", `/v1/organizations/${c.orgId}/app-stacks`, { templateVersionId, name: `app-${randomUUID().slice(0, 8)}`, deploy }, {
      "Idempotency-Key": randomUUID(),
    });

  async function draft(c: HarnessCustomer = h.a): Promise<string> {
    const res = await createStack(c, notes, false);
    expect(res.status, res.raw).toBe(201);
    return res.body.data.stackId as string;
  }

  it("adds a pending address with one audit row, a repeat adds nothing, and reconciles once per write", async () => {
    const stackId = await draft();
    const res = await add(stackId, appDomain("notes.example.test"));
    expect(res.status, res.raw).toBe(201);
    expect(res.body.data).toEqual([
      expect.objectContaining({ hostname: "notes.example.test", componentKey: "app", port: 8080, status: "pending", certificateStatus: "none" }),
    ]);
    const [row] = await rows(stackId);
    expect(res.body.data[0].id).toBe(row!.id);
    const [audit] = await audits("app.stack.domain.assign", stackId);
    expect(audit!.details).toMatchObject({ domainId: row!.id, hostname: "notes.example.test", componentKey: "app", internalPort: 8080 });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(h.a.orgId, stackId, expect.any(Date), { forceDnsIds: [row!.id] });

    const again = await add(stackId, appDomain("Notes.Example.Test"));
    expect(again.status, again.raw).toBe(201);
    expect(again.body.data).toEqual(res.body.data);
    expect(await rows(stackId)).toHaveLength(1);
    expect(await audits("app.stack.domain.assign", stackId)).toHaveLength(1);
    expect(reconcile).toHaveBeenCalledTimes(1);

    const listed = await h.call(h.a.token, "GET", base(h.a, stackId));
    expect(listed.status).toBe(200);
    expect(listed.body.data).toEqual(res.body.data);
  });

  it("targets the deployed plan's ingress of a stack that has a revision", async () => {
    const created = await createStack(h.a, web, true);
    expect(created.status, created.raw).toBe(202);
    const stackId = created.body.data.stackId as string;
    expect((await add(stackId, { hostname: "web.example.test", componentKey: "web", port: 8080 })).status).toBe(201);
    expectRefusal(await add(stackId, appDomain("web2.example.test")), 400, "VALIDATION_ERROR", { reason: "unknown_ingress" });
  });

  it("refuses a pair that is not an ingress of the application", async () => {
    const stackId = await draft();
    expectRefusal(await add(stackId, { hostname: "c.example.test", componentKey: "cache", port: 6379 }), 400, "VALIDATION_ERROR", {
      field: "componentKey",
      reason: "unknown_ingress",
    });
    expectRefusal(await add(stackId, { hostname: "c.example.test", componentKey: "app", port: 9999 }), 400, "VALIDATION_ERROR", {
      reason: "unknown_ingress",
    });
    expect(await rows(stackId)).toHaveLength(0);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("refuses a hostname held by the panel, a site or another organisation's stack without naming the owner", async () => {
    const site = await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/managed-sites`, SITE, { "Idempotency-Key": randomUUID() });
    expect(site.status, site.raw).toBe(202);
    const foreign = await draft(h.b);
    expect((await add(foreign, appDomain("luigi.example.test"), h.b)).status).toBe(201);
    const stackId = await draft();
    for (const hostname of ["panel.test", "hotel.it", "luigi.example.test"]) {
      const res = await add(stackId, appDomain(hostname));
      expectRefusal(res, 409, "DOMAIN_CONFLICT");
      expect(res.body.error.message).toBe(CONFLICT);
      expect(res.raw).not.toContain(h.b.orgId);
      expect(res.raw).not.toContain(foreign);
    }
    expect(await rows(stackId)).toHaveLength(0);

    // The trigger closes the other direction: a site asking for a stack hostname gets its own DOMAIN_CONFLICT.
    expect((await add(stackId, appDomain("mine.example.test"))).status).toBe(201);
    const siteAdd = await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/managed-sites/${site.body.data.siteId as string}/domains`, {
      hostname: "mine.example.test",
    });
    expectRefusal(siteAdd, 409, "DOMAIN_CONFLICT");
    expect(siteAdd.body.error.message).toBe(CONFLICT);
  });

  it("refuses a hostname that another organisation's manual certificate covers", async () => {
    const certificateId = `tlc_${randomUUID()}`;
    await h.dbClient.db.insert(tlsCertificates).values({ id: certificateId, organizationId: h.b.orgId, name: "wildcard" });
    await h.dbClient.db.insert(tlsCertificateVersions).values({
      id: `tlv_${randomUUID()}`,
      certificateId,
      organizationId: h.b.orgId,
      versionNumber: 1,
      leafPem: "leaf",
      chainPem: "chain",
      keyCiphertextBase64: "a",
      keyIvBase64: "b",
      keyAuthTagBase64: "c",
      subject: "CN=*.covered.test",
      issuer: "CN=Test CA",
      serialNumber: "01",
      fingerprintSha256: "f".repeat(64),
      notBefore: new Date(Date.now() - 86_400_000),
      notAfter: new Date(Date.now() + 86_400_000 * 90),
      sanDns: ["*.covered.test"],
      keyType: "ec",
      keyBits: 256,
      status: "active",
    });
    const stackId = await draft();
    const res = await add(stackId, appDomain("shop.covered.test"));
    expectRefusal(res, 409, "DOMAIN_CONFLICT");
    expect(res.raw).not.toContain(h.b.orgId);
    expect(await rows(stackId)).toHaveLength(0);
  });

  it("refuses the ninth address", async () => {
    const stackId = await draft();
    for (let i = 1; i <= 8; i += 1) expect((await add(stackId, appDomain(`n${String(i)}.example.test`))).status).toBe(201);
    expectRefusal(await add(stackId, appDomain("n9.example.test")), 400, "VALIDATION_ERROR", {
      field: "domains",
      reason: "STACK_QUOTA_EXCEEDED",
    });
    expect(await rows(stackId)).toHaveLength(8);
  });

  it("removes an address with one audit row and reconciles once; an unknown id is 404", async () => {
    const stackId = await draft();
    const added = await add(stackId, appDomain("gone.example.test"));
    const domainId = added.body.data[0].id as string;
    reconcile.mockClear();
    const res = await h.call(h.a.token, "DELETE", `${base(h.a, stackId)}/${domainId}`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toEqual([]);
    const [audit] = await audits("app.stack.domain.remove", stackId);
    expect(audit!.details).toMatchObject({ domainId, hostname: "gone.example.test" });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(h.a.orgId, stackId, expect.any(Date), { forceDnsIds: [] });

    expectRefusal(await h.call(h.a.token, "DELETE", `${base(h.a, stackId)}/${domainId}`), 404, "NOT_FOUND");
    expectRefusal(await h.call(h.a.token, "POST", `${base(h.a, stackId)}/${domainId}/check`), 404, "NOT_FOUND");
    expect(await audits("app.stack.domain.remove", stackId)).toHaveLength(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("checks DNS now at most every 10 seconds", async () => {
    const stackId = await draft();
    const added = await add(stackId, appDomain("check.example.test"));
    const domainId = added.body.data[0].id as string;
    const due = new Date(Date.now() + 3_600_000);
    const setRow = (set: Partial<typeof appStackDomains.$inferInsert>) =>
      h.dbClient.db.update(appStackDomains).set(set).where(eq(appStackDomains.id, domainId));
    await setRow({ dnsAttempts: 3, dnsNextCheckAt: due });
    reconcile.mockClear();
    // The observer records the lookup, as the real one does.
    reconcile.mockImplementationOnce(async () => {
      await setRow({ dnsCheckedAt: new Date() });
    });
    const url = `${base(h.a, stackId)}/${domainId}/check`;
    const first = await h.call(h.a.token, "POST", url);
    expect(first.status, first.raw).toBe(200);
    expect(first.body.data[0].checkedAt).not.toBeNull();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(h.a.orgId, stackId, expect.any(Date), { forceDnsIds: [domainId] });
    const [written] = await rows(stackId);
    expect(written!.dnsAttempts).toBe(0);
    expect(written!.dnsNextCheckAt.getTime()).toBeLessThan(due.getTime());

    await setRow({ dnsAttempts: 3, dnsNextCheckAt: due });
    const second = await h.call(h.a.token, "POST", url);
    expect(second.status, second.raw).toBe(200);
    const [untouched] = await rows(stackId);
    expect(untouched!.dnsAttempts).toBe(3);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(await audits("app.stack.domain.check", stackId)).toHaveLength(0);
  });

  it("answers the write even when the reconcile fails", async () => {
    const stackId = await draft();
    reconcile.mockRejectedValueOnce(new Error("dns down"));
    const res = await add(stackId, appDomain("best.example.test"));
    expect(res.status, res.raw).toBe(201);
    expect(await rows(stackId)).toHaveLength(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("refuses an add while the application is being deleted, and a foreign stack is 404", async () => {
    const stackId = await draft();
    await h.dbClient.db.update(appStacks).set({ status: "deleting" }).where(eq(appStacks.id, stackId));
    expectRefusal(await add(stackId, appDomain("late.example.test")), 409, "RESOURCE_LOCKED", { reason: "deleting" });
    expect(await rows(stackId)).toHaveLength(0);
    expectRefusal(await add(stackId, appDomain("x.example.test"), h.b), 404, "NOT_FOUND");
    expectRefusal(await h.call(h.b.token, "GET", base(h.b, stackId)), 404, "NOT_FOUND");
  });
});
