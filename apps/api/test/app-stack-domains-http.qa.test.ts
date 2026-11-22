// Q5 · stack domains through HTTP: the collision matrix, foreign manual certificates, the limit of 8, unknown targets,
// drafts, remove and re-add with their audit rows, and the 404 of B1 on the domain routes. Behaviour of arch-api §6.4 / §10.
import { randomUUID } from "node:crypto";
import { APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  and,
  appStackDomains,
  appStacks,
  asc,
  auditEvents,
  eq,
  resourceQuotas,
  tlsCertificates,
  tlsCertificateVersions,
} from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

const CONFLICT =
  "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.";
const NOT_FOUND = "Requested organization or resource was not found.";
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};
// "bücher" in punycode: what an IDN input must be stored as.
const BUCHER_ASCII = "xn--bcher-kva.example.test";
const MUNCHEN_ASCII = "xn--mnchen-3ya.example.test";

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("application stack domains over HTTP (QA M4, Q5)", () => {
  let h: AppStackHarness;
  let notes: string;
  let siteId: string;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    for (const c of [h.a, h.b]) {
      await h.dbClient.db
        .update(resourceQuotas)
        .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
        .where(eq(resourceQuotas.organizationId, c.orgId));
    }
    notes = (await h.publish()).versionId;
    const site = await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/managed-sites`, SITE, { "Idempotency-Key": randomUUID() });
    expect(site.status, site.raw).toBe(202);
    siteId = site.body.data.siteId as string;
    // A second address with its www partner, so both names are held by the site.
    const www = await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/managed-sites/${siteId}/domains`, {
      hostname: "shop-site.example.test",
      includeWww: true,
    });
    expect(www.status, www.raw).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const base = (c: HarnessCustomer, stackId: string) => `/v1/organizations/${c.orgId}/app-stacks/${stackId}/domains`;
  const entry = (hostname: string, componentKey = "app", port = 8080) => ({ hostname, componentKey, port });
  const add = (stackId: string, body: unknown, c: HarnessCustomer = h.a) => h.call(c.token, "POST", base(c, stackId), body);
  const remove = (stackId: string, domainId: string, c: HarnessCustomer = h.a) =>
    h.call(c.token, "DELETE", `${base(c, stackId)}/${domainId}`);
  const rows = (stackId: string) => h.dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId));
  const allDomainRows = () => h.dbClient.db.select().from(appStackDomains);
  const audits = (action: string, stackId: string) =>
    h.dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, stackId)))
      .orderBy(asc(auditEvents.timestamp));

  async function draft(c: HarnessCustomer = h.a): Promise<string> {
    const name = `app-${randomUUID().slice(0, 8)}`;
    const res = await h.call(c.token, "POST", `/v1/organizations/${c.orgId}/app-stacks`, { templateVersionId: notes, name, deploy: false }, {
      "Idempotency-Key": randomUUID(),
    });
    expect(res.status, res.raw).toBe(201);
    return res.body.data.stackId as string;
  }

  describe("collision matrix", () => {
    it("a held hostname is DOMAIN_CONFLICT in every spelling and for every holder, with one identical body and no owner named", async () => {
      const foreignStack = await draft(h.b);
      expect((await add(foreignStack, entry("held-by-b.example.test"), h.b)).status).toBe(201);
      expect((await add(foreignStack, entry(BUCHER_ASCII), h.b)).status).toBe(201);
      const sameOrgStack = await draft(h.a);
      expect((await add(sameOrgStack, entry("held-by-a.example.test"))).status).toBe(201);
      const stackId = await draft(h.a);

      // [holder, spellings the requester may use]
      const cases: readonly (readonly [string, readonly string[]])[] = [
        ["site apex", ["hotel.it", "HOTEL.IT", "Hotel.It"]],
        ["site www partner", ["shop-site.example.test", "www.shop-site.example.test", "WWW.Shop-Site.Example.TEST"]],
        ["the panel hostname", ["panel.test", "PANEL.TEST", "Panel.Test"]],
        ["a stack of another organisation", ["held-by-b.example.test", "HELD-BY-B.EXAMPLE.TEST"]],
        ["a stack of another organisation (IDN)", ["bücher.example.test", "BÜCHER.example.test", BUCHER_ASCII.toUpperCase()]],
        ["another stack of the same organisation", ["held-by-a.example.test", "Held-By-A.Example.Test"]],
      ];
      const bodies = new Set<string>();
      const before = await allDomainRows();
      for (const [holder, spellings] of cases) {
        for (const hostname of spellings) {
          const res = await add(stackId, entry(hostname));
          expectRefusal(res, 409, "DOMAIN_CONFLICT");
          expect(res.body.error.message, `${holder}: ${hostname}`).toBe(CONFLICT);
          expect(res.body.error.details ?? [], `${holder}: ${hostname}`).toEqual([]);
          for (const secret of [h.b.orgId, foreignStack, sameOrgStack, siteId]) expect(res.raw).not.toContain(secret);
          bodies.add(JSON.stringify({ code: res.body.error.code, message: res.body.error.message, details: res.body.error.details ?? [] }));
        }
      }
      // The answer does not tell a site from the panel from a stack.
      expect(bodies.size).toBe(1);
      expect(await rows(stackId)).toHaveLength(0);
      expect(await allDomainRows()).toHaveLength(before.length);
      expect(await audits("app.stack.domain.assign", stackId)).toHaveLength(0);
    });

    it("upper-case and IDN input is stored normalised, and its normalised twin is the same address", async () => {
      const stackId = await draft();
      const mixed = await add(stackId, entry("Mixed.Case.EXAMPLE.test"));
      expect(mixed.status, mixed.raw).toBe(201);
      expect(mixed.body.data.map((d: Json) => d.hostname)).toEqual(["mixed.case.example.test"]);
      const idn = await add(stackId, entry("MÜNCHEN.example.test"));
      expect(idn.status, idn.raw).toBe(201);
      expect(idn.body.data.map((d: Json) => d.hostname)).toEqual(["mixed.case.example.test", MUNCHEN_ASCII]);
      const stored = (await rows(stackId)).map((r) => r.hostname).sort();
      expect(stored).toEqual(["mixed.case.example.test", MUNCHEN_ASCII]);
      // Twins add nothing and audit nothing.
      for (const twin of ["MIXED.case.example.TEST", MUNCHEN_ASCII, "münchen.example.test"]) {
        const again = await add(stackId, entry(twin));
        expect(again.status, again.raw).toBe(201);
        expect(again.body.data).toHaveLength(2);
      }
      expect(await rows(stackId)).toHaveLength(2);
      expect(await audits("app.stack.domain.assign", stackId)).toHaveLength(2);
    });

    it("the other direction: a site asking for a stack's hostname, in any spelling, gets DOMAIN_CONFLICT too", async () => {
      const stackId = await draft();
      expect((await add(stackId, entry("site-wants-this.example.test"))).status).toBe(201);
      for (const hostname of ["site-wants-this.example.test", "SITE-WANTS-THIS.example.test"]) {
        const res = await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/managed-sites/${siteId}/domains`, { hostname });
        expectRefusal(res, 409, "DOMAIN_CONFLICT");
        expect(res.body.error.message).toBe(CONFLICT);
        expect(res.raw).not.toContain(stackId);
      }
      // The stack still holds it, and the refusal created no site domain.
      expect(await rows(stackId)).toHaveLength(1);
      const siteDomains = await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/managed-sites/${siteId}/domains`);
      expect(siteDomains.status, siteDomains.raw).toBe(200);
      expect(JSON.stringify(siteDomains.body)).not.toContain("site-wants-this");
    });

    it("a new site cannot be created on a stack's hostname either", async () => {
      const stackId = await draft();
      expect((await add(stackId, entry("new-site-wants-this.example.test"))).status).toBe(201);
      const res = await h.call(
        h.a.token,
        "POST",
        `/v1/organizations/${h.a.orgId}/managed-sites`,
        { ...SITE, name: "Second Site", domain: "New-Site-Wants-This.example.test", adminEmail: "admin@second.example.test" },
        { "Idempotency-Key": randomUUID() },
      );
      expectRefusal(res, 409, "DOMAIN_CONFLICT");
      expect(res.raw).not.toContain(stackId);
    });

    it("once the holder removes an address, another organisation can take it", async () => {
      const first = await draft(h.a);
      const added = await add(first, entry("handover.example.test"));
      const domainId = added.body.data[0].id as string;
      const second = await draft(h.b);
      expectRefusal(await add(second, entry("HANDOVER.example.test"), h.b), 409, "DOMAIN_CONFLICT");
      expect((await remove(first, domainId)).status).toBe(200);
      const taken = await add(second, entry("handover.example.test"), h.b);
      expect(taken.status, taken.raw).toBe(201);
      expect(await rows(first)).toHaveLength(0);
      expectRefusal(await add(first, entry("handover.example.test")), 409, "DOMAIN_CONFLICT");
    });
  });

  describe("manual certificates of another organisation", () => {
    async function publishCertificate(orgId: string, sanDns: readonly string[], status: "active" | "inactive" = "active"): Promise<void> {
      const certificateId = `tlc_${randomUUID()}`;
      await h.dbClient.db.insert(tlsCertificates).values({ id: certificateId, organizationId: orgId, name: `cert-${certificateId.slice(4, 12)}` });
      await h.dbClient.db.insert(tlsCertificateVersions).values({
        id: `tlv_${randomUUID()}`,
        certificateId,
        organizationId: orgId,
        versionNumber: 1,
        leafPem: "leaf",
        chainPem: "chain",
        keyCiphertextBase64: "a",
        keyIvBase64: "b",
        keyAuthTagBase64: "c",
        subject: `CN=${sanDns[0]!}`,
        issuer: "CN=Test CA",
        serialNumber: "01",
        fingerprintSha256: randomUUID().replace(/-/g, "").repeat(2),
        notBefore: new Date(Date.now() - 86_400_000),
        notAfter: new Date(Date.now() + 86_400_000 * 90),
        sanDns: [...sanDns],
        keyType: "ec",
        keyBits: 256,
        status,
      });
    }

    it("a wildcard or an exact name of organisation B's active certificate refuses A's new hostname, without a detail", async () => {
      await publishCertificate(h.b.orgId, ["*.wild-b.example.test", "exact-b.example.test"]);
      const stackId = await draft();
      for (const hostname of ["shop.wild-b.example.test", "SHOP.Wild-B.example.test", "exact-b.example.test"]) {
        const res = await add(stackId, entry(hostname));
        expectRefusal(res, 409, "DOMAIN_CONFLICT");
        expect(res.body.error.message).toBe(CONFLICT);
        expect(res.body.error.details ?? []).toEqual([]);
        expect(res.raw).not.toContain(h.b.orgId);
        expect(res.raw).not.toContain("wild-b");
        expect(res.raw).not.toContain("cert-");
      }
      expect(await rows(stackId)).toHaveLength(0);
      expect(await audits("app.stack.domain.assign", stackId)).toHaveLength(0);
    });

    it("a name the certificate does not cover is still accepted (one label deeper than a wildcard, or the bare apex)", async () => {
      await publishCertificate(h.b.orgId, ["*.narrow-b.example.test"]);
      const stackId = await draft();
      for (const hostname of ["narrow-b.example.test", "a.b.narrow-b.example.test", "unrelated-to-b.example.test"]) {
        const res = await add(stackId, entry(hostname));
        expect(res.status, `${hostname}: ${res.raw}`).toBe(201);
      }
    });

    it("the organisation's own certificate is told apart: CERTIFICATE_IN_USE (captures_host), not the generic conflict", async () => {
      await publishCertificate(h.a.orgId, ["*.own-a.example.test"]);
      const stackId = await draft();
      const res = await add(stackId, entry("shop.own-a.example.test"));
      expectRefusal(res, 409, "CERTIFICATE_IN_USE", { field: "hostname", reason: "captures_host" });
      expect(await rows(stackId)).toHaveLength(0);
    });
  });

  describe("the limit of 8 addresses", () => {
    it("takes 8, refuses a 9th with the quota reason, still accepts a repeat, and frees a slot on remove", async () => {
      const stackId = await draft();
      const ids: string[] = [];
      for (let i = 1; i <= 8; i += 1) {
        const res = await add(stackId, entry(`lim${String(i)}.example.test`));
        expect(res.status, res.raw).toBe(201);
        expect(res.body.data).toHaveLength(i);
        ids.push(res.body.data.find((d: Json) => d.hostname === `lim${String(i)}.example.test`).id as string);
      }
      const ninth = await add(stackId, entry("lim9.example.test"));
      expectRefusal(ninth, 400, "VALIDATION_ERROR", { field: "domains", reason: "STACK_QUOTA_EXCEEDED" });
      expect(await rows(stackId)).toHaveLength(8);
      expect(await audits("app.stack.domain.assign", stackId)).toHaveLength(8);
      // A repeat of an existing one is not a new address: it is not counted.
      expect((await add(stackId, entry("LIM3.example.test"))).status).toBe(201);
      expect(await rows(stackId)).toHaveLength(8);
      // A refused 9th is not a half-write: the hostname is free for anyone else.
      const other = await draft(h.b);
      expect((await add(other, entry("lim9.example.test"), h.b)).status).toBe(201);
      expect((await remove(stackId, ids[0]!)).status).toBe(200);
      expect((await add(stackId, entry("lim10.example.test"))).status).toBe(201);
      expect(await rows(stackId)).toHaveLength(8);
      expectRefusal(await add(stackId, entry("lim11.example.test")), 400, "VALIDATION_ERROR", { reason: "STACK_QUOTA_EXCEEDED" });
    });

    it("the limit is per application: another application of the same organisation has its own 8", async () => {
      const full = await draft();
      for (let i = 1; i <= 8; i += 1) expect((await add(full, entry(`per${String(i)}.example.test`))).status).toBe(201);
      const fresh = await draft();
      expect((await add(fresh, entry("per-other.example.test"))).status).toBe(201);
    });
  });

  describe("targets and input", () => {
    it.each([
      ["a component that is not an ingress", entry("t1.example.test", "cache", 6379)],
      ["a component the template does not have", entry("t2.example.test", "nope", 8080)],
      ["the right component on another port", entry("t3.example.test", "app", 9999)],
      ["the right component on a privileged port", entry("t4.example.test", "app", 80)],
    ])("%s is 400 unknown_ingress on a draft and writes nothing", async (_label, body) => {
      const stackId = await draft();
      const before = await h.counts();
      const res = await add(stackId, body);
      expect(res.status, res.raw).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details).toContainEqual(expect.objectContaining({ reason: "unknown_ingress" }));
      expect(await h.counts()).toEqual(before);
    });

    it.each([
      ["an empty hostname", { hostname: "", componentKey: "app", port: 8080 }],
      ["a URL instead of a hostname", { hostname: "https://x.example.test/", componentKey: "app", port: 8080 }],
      ["a hostname with an underscore", { hostname: "a_b.example.test", componentKey: "app", port: 8080 }],
      ["a hostname with a space", { hostname: "a b.example.test", componentKey: "app", port: 8080 }],
      ["a missing port", { hostname: "ok.example.test", componentKey: "app" }],
      ["a missing component", { hostname: "ok.example.test", port: 8080 }],
      ["a port out of range", { hostname: "ok.example.test", componentKey: "app", port: 70000 }],
      ["a string port", { hostname: "ok.example.test", componentKey: "app", port: "8080" }],
      ["an upper-case component key", { hostname: "ok.example.test", componentKey: "APP", port: 8080 }],
      ["an extra key", { hostname: "ok.example.test", componentKey: "app", port: 8080, tls: true }],
      ["no body at all", {}],
    ])("%s is a 400 VALIDATION_ERROR and writes nothing", async (_label, body) => {
      const stackId = await draft();
      const before = await h.counts();
      const res = await add(stackId, body);
      expect(res.status, res.raw).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(await h.counts()).toEqual(before);
    });

    it("a hostname on a draft uses the template's own ingress, lists sorted by hostname, and does not create an operation", async () => {
      const stackId = await draft();
      const before = await h.counts();
      for (const hostname of ["zeta.example.test", "alpha.example.test", "mid.example.test"]) {
        expect((await add(stackId, entry(hostname))).status).toBe(201);
      }
      const listed = await h.call(h.a.token, "GET", base(h.a, stackId));
      expect(listed.status, listed.raw).toBe(200);
      expect(listed.body.data.map((d: Json) => d.hostname)).toEqual(["alpha.example.test", "mid.example.test", "zeta.example.test"]);
      for (const d of listed.body.data as Json[]) {
        expect(d).toMatchObject({ componentKey: "app", port: 8080, status: "pending" });
      }
      const after = await h.counts();
      expect(after.operations).toBe(before.operations);
      expect(after.outbox_events).toBe(before.outbox_events);
      expect(after.audit_events).toBe(before.audit_events! + 3);
      const [stack] = await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId));
      expect(stack!.status).toBe("draft");
    });

    it("an unknown stack under the caller's own organisation is 404 for add, and a hostname someone holds does not turn it into a 409", async () => {
      const ghost = `stk_${"e".repeat(24)}`;
      const res = await add(ghost, entry("hotel.it"));
      expectRefusal(res, 404, "NOT_FOUND");
      expect(res.body.error.message).toBe(NOT_FOUND);
    });
  });

  describe("remove and re-add", () => {
    it("leaves assign, remove, assign in the audit trail, with a new id the second time, and no hostname elsewhere", async () => {
      const stackId = await draft();
      const first = await add(stackId, entry("again.example.test"));
      const firstId = first.body.data[0].id as string;
      const removed = await remove(stackId, firstId);
      expect(removed.status, removed.raw).toBe(200);
      expect(removed.body.data).toEqual([]);
      expect(await rows(stackId)).toHaveLength(0);
      const second = await add(stackId, entry("AGAIN.example.test"));
      expect(second.status, second.raw).toBe(201);
      const secondId = second.body.data[0].id as string;
      expect(secondId).not.toBe(firstId);

      const trail = [...(await audits("app.stack.domain.assign", stackId)), ...(await audits("app.stack.domain.remove", stackId))]
        .sort((x, y) => x.timestamp.getTime() - y.timestamp.getTime())
        .map((e) => [e.action, (e.details as Json).domainId, (e.details as Json).hostname]);
      expect(trail).toEqual([
        ["app.stack.domain.assign", firstId, "again.example.test"],
        ["app.stack.domain.remove", firstId, "again.example.test"],
        ["app.stack.domain.assign", secondId, "again.example.test"],
      ]);
    });

    it("removing twice, or a domain id that never existed, is 404 and adds no audit row", async () => {
      const stackId = await draft();
      const added = await add(stackId, entry("twice.example.test"));
      const domainId = added.body.data[0].id as string;
      expect((await remove(stackId, domainId)).status).toBe(200);
      const before = await h.counts();
      for (const id of [domainId, `adm_${"2".repeat(24)}`]) {
        const res = await remove(stackId, id);
        expectRefusal(res, 404, "NOT_FOUND");
        expect(res.body.error.message).toBe(NOT_FOUND);
      }
      expect(await h.counts()).toEqual(before);
      expect(await audits("app.stack.domain.remove", stackId)).toHaveLength(1);
    });

    it("a remove with an unknown body key is refused before it deletes anything", async () => {
      const stackId = await draft();
      const added = await add(stackId, entry("keep.example.test"));
      const domainId = added.body.data[0].id as string;
      const res = await h.call(h.a.token, "DELETE", `${base(h.a, stackId)}/${domainId}`, { force: true });
      expect(res.status, res.raw).toBe(400);
      expect(await rows(stackId)).toHaveLength(1);
      expect(await audits("app.stack.domain.remove", stackId)).toHaveLength(0);
    });
  });

  describe("B1 on the domain routes", () => {
    it("another organisation gets the same 404 for a stack and a domain as for an unknown id, and learns nothing from a conflicting hostname", async () => {
      const mine = await draft(h.a);
      const added = await add(mine, entry("b1-mine.example.test"));
      const domainId = added.body.data[0].id as string;
      const theirs = await draft(h.b);
      const theirDomain = (await add(theirs, entry("b1-theirs.example.test"), h.b)).body.data[0].id as string;
      const ghostStack = `stk_${"d".repeat(24)}`;
      const ghostDomain = `adm_${"3".repeat(24)}`;

      const before = await h.counts();
      const attempts: readonly (readonly [string, string, unknown?])[] = [
        // B on A's stack, under B's own organisation and under A's
        ...[h.b, h.a].flatMap((org) => [
          ["GET", `/v1/organizations/${org.orgId}/app-stacks/${mine}/domains`] as const,
          ["POST", `/v1/organizations/${org.orgId}/app-stacks/${mine}/domains`, entry("b1-mine.example.test")] as const,
          ["POST", `/v1/organizations/${org.orgId}/app-stacks/${mine}/domains`, entry("b1-fresh.example.test")] as const,
          ["POST", `/v1/organizations/${org.orgId}/app-stacks/${mine}/domains`, entry("hotel.it")] as const,
          ["DELETE", `/v1/organizations/${org.orgId}/app-stacks/${mine}/domains/${domainId}`] as const,
          ["POST", `/v1/organizations/${org.orgId}/app-stacks/${mine}/domains/${domainId}/check`, {}] as const,
        ]),
        // B on its own stack with A's domain id
        ["DELETE", `${base(h.b, theirs)}/${domainId}`],
        ["POST", `${base(h.b, theirs)}/${domainId}/check`, {}],
        // B on a stack that does not exist
        ["DELETE", `${base(h.b, ghostStack)}/${ghostDomain}`],
        ["POST", `${base(h.b, ghostStack)}/${ghostDomain}/check`, {}],
        ["POST", base(h.b, ghostStack), entry("hotel.it")],
      ];
      for (const [method, path, body] of attempts) {
        const res = await h.call(h.b.token, method, path, body);
        expectRefusal(res, 404, "NOT_FOUND");
        expect(res.body.error.message, `${method} ${path}`).toBe(NOT_FOUND);
        for (const echo of [mine, domainId, "b1-mine", "b1-fresh", "hotel.it"]) expect(res.raw, `${method} ${path}`).not.toContain(echo);
      }
      expect(await h.counts()).toEqual(before);
      // Both rows are where they were.
      expect((await rows(mine)).map((r) => r.id)).toEqual([domainId]);
      expect((await rows(theirs)).map((r) => r.id)).toEqual([theirDomain]);
    });

    it("A's domain id on A's own other stack is a 404 and the row stays on its stack", async () => {
      const one = await draft(h.a);
      const two = await draft(h.a);
      const domainId = (await add(one, entry("b1-one.example.test"))).body.data[0].id as string;
      for (const [method, suffix] of [
        ["DELETE", ""],
        ["POST", "/check"],
      ] as const) {
        const res = await h.call(h.a.token, method, `${base(h.a, two)}/${domainId}${suffix}`, {});
        expectRefusal(res, 404, "NOT_FOUND");
      }
      expect((await rows(one)).map((r) => r.id)).toEqual([domainId]);
      const listTwo = await h.call(h.a.token, "GET", base(h.a, two));
      expect(listTwo.body.data).toEqual([]);
    });

    it("an anonymous caller is refused before any lookup, on all four routes", async () => {
      const stackId = await draft();
      const domainId = (await add(stackId, entry("anon.example.test"))).body.data[0].id as string;
      for (const [method, path] of [
        ["GET", base(h.a, stackId)],
        ["POST", base(h.a, stackId)],
        ["DELETE", `${base(h.a, stackId)}/${domainId}`],
        ["POST", `${base(h.a, stackId)}/${domainId}/check`],
      ] as const) {
        const res = await h.call(null, method, path, method === "GET" ? undefined : method === "POST" && path === base(h.a, stackId) ? entry("anon2.example.test") : {});
        expect(res.status, `${method} ${path}`).toBe(401);
      }
      expect((await rows(stackId)).map((r) => r.id)).toEqual([domainId]);
    });
  });
});
