// ADR-0037 over HTTP: PATCH …/app-stacks/:stackId/domains/:domainId replaces the routing options of one web address
// (redirect, password protection, compression, paths). The password is write-only: the reply, the audit row, the
// outbox and the operations never carry it or its verifier. Route files are covered by app-stack-domains.qa.test.ts.
import { randomUUID } from "node:crypto";
import { APP_IMAGE_ALLOWLIST, APP_ROUTE_PASSWORD_HASH_PATTERN, findForbiddenPublicDtoKeys } from "@hosting-panel/contracts";
import { and, appStackDomains, appStacks, asc, auditEvents, eq, operations, outboxEvents, resourceQuotas } from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apr1Verifier } from "../src/app-stacks/apr1.js";
import { APP_TEST_ALLOWLIST, NOTES_DEMO_SOURCE, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

const NOT_FOUND = "Requested organization or resource was not found.";
const UPDATE = "app.stack.domain.update";
const PASSWORD = "Routing-Canary-Pass-0001";
const OTHER_PASSWORD = "Another-Canary-Pass-0002";
const OFF = { redirectToDomainId: null, compression: false, protection: null, pathRoutes: [] };
const API_PATH = { pathPrefix: "/api", componentKey: "app", port: 8080, stripPrefix: true };
const GHOST_DOMAIN = `sdom_${"3".repeat(24)}`;
/** The notes application with its cache reachable from the web too: two entry points, app:8080 and cache:6379. */
const TWO_DOORS = `${NOTES_DEMO_SOURCE.replace(
  "      - 6379\n    deploy:",
  "      - 6379\n    healthcheck:\n      kind: tcp\n      port: 6379\n      intervalSeconds: 15\n      timeoutSeconds: 3\n    deploy:",
)}  - service: cache\n    port: 6379\n    protocol: http\n`;

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("routing options of an application address over HTTP (ADR-0037)", () => {
  let h: AppStackHarness;
  let notes: string;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    notes = (await h.publish()).versionId;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const base = (c: HarnessCustomer, stackId: string) => `/v1/organizations/${c.orgId}/app-stacks/${stackId}/domains`;
  const host = (label: string) => `${label}-${randomUUID().slice(0, 8)}.example.test`;
  const patch = (stackId: string, domainId: string, body: unknown, c: HarnessCustomer = h.a) =>
    h.call(c.token, "PATCH", `${base(c, stackId)}/${domainId}`, body);
  const rows = (stackId: string) => h.dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId));
  const rowOf = async (stackId: string, domainId: string) => (await rows(stackId)).find((r) => r.id === domainId)!;
  const audits = (stackId: string) =>
    h.dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, UPDATE), eq(auditEvents.targetId, stackId)))
      .orderBy(asc(auditEvents.timestamp));

  async function draft(c: HarnessCustomer = h.a): Promise<string> {
    const res = await h.call(
      c.token,
      "POST",
      `/v1/organizations/${c.orgId}/app-stacks`,
      { templateVersionId: notes, name: `app-${randomUUID().slice(0, 8)}`, deploy: false },
      { "Idempotency-Key": randomUUID() },
    );
    expect(res.status, res.raw).toBe(201);
    return res.body.data.stackId as string;
  }

  /** A draft with one address per label; returns the stack and the id of each address, by label. */
  async function withAddresses<const L extends readonly string[]>(
    labels: L,
    c: HarnessCustomer = h.a,
  ): Promise<{ stackId: string; ids: Record<L[number], string>; names: Record<L[number], string> }> {
    const stackId = await draft(c);
    const ids: Record<string, string> = {};
    const names: Record<string, string> = {};
    for (const label of labels) {
      const hostname = host(label);
      const res = await h.call(c.token, "POST", base(c, stackId), { hostname, componentKey: "app", port: 8080 });
      expect(res.status, res.raw).toBe(201);
      ids[label] = (res.body.data as Json[]).find((d) => d.hostname === hostname)!.id as string;
      names[label] = hostname;
    }
    return { stackId, ids: ids as Record<L[number], string>, names: names as Record<L[number], string> };
  }

  /** Everything the panel keeps outside the address row itself, as one text. */
  async function trail(): Promise<string> {
    const db = h.dbClient.db;
    return JSON.stringify([await db.select().from(auditEvents), await db.select().from(outboxEvents), await db.select().from(operations)]);
  }

  describe("setting the options", () => {
    it("stores the four options, answers with the list of addresses, and writes one audit row and nothing else", async () => {
      const { stackId, ids, names } = await withAddresses(["shop", "other"] as const);
      const before = await h.counts();
      const res = await patch(stackId, ids.shop, {
        redirectToDomainId: null,
        compression: true,
        protection: { username: "guest", password: PASSWORD },
        pathRoutes: [API_PATH],
      });
      expect(res.status, res.raw).toBe(200);
      const list = res.body.data as Json[];
      expect(list.map((d) => d.id).sort()).toEqual([ids.shop, ids.other].sort());
      expect(list.find((d) => d.id === ids.shop)).toMatchObject({
        hostname: names.shop,
        redirectToDomainId: null,
        compression: true,
        protection: { username: "guest" },
        pathRoutes: [API_PATH],
      });
      expect(list.find((d) => d.id === ids.other)).toMatchObject({ redirectToDomainId: null, compression: false, protection: null, pathRoutes: [] });

      // Only the audit table grew: no operation, no outbox row for an application that is not installed yet.
      expect(await h.counts()).toEqual({ ...before, audit_events: before.audit_events! + 1 });
      const [audit] = await audits(stackId);
      expect(audit!.details).toEqual({
        domainId: ids.shop,
        hostname: names.shop,
        redirectToDomainId: null,
        compression: true,
        protectedAs: "guest",
        passwordSet: true,
        pathRoutes: [API_PATH],
        outcome: "succeeded",
        requestId: expect.stringMatching(/^req_/),
      });

      const listed = await h.call(h.a.token, "GET", base(h.a, stackId));
      expect(listed.status, listed.raw).toBe(200);
      expect(listed.body.data).toEqual(res.body.data);
    });

    it("keeps the password to itself: the row holds a verifier of it, and no reply or record holds either", async () => {
      const { stackId, ids } = await withAddresses(["secret"] as const);
      const res = await patch(stackId, ids.secret, { ...OFF, protection: { username: "guest", password: PASSWORD } });
      expect(res.status, res.raw).toBe(200);
      const stored = (await rowOf(stackId, ids.secret)).accessPasswordHash!;
      expect(stored).toMatch(APP_ROUTE_PASSWORD_HASH_PATTERN);
      // The verifier is the one of the password that was sent, under the salt the API drew.
      expect(apr1Verifier(PASSWORD, stored.split("$")[2])).toBe(stored);

      const listed = await h.call(h.a.token, "GET", base(h.a, stackId));
      const stack = await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}`);
      expect(stack.status, stack.raw).toBe(200);
      for (const reply of [res, listed, stack]) {
        expect(reply.raw).not.toContain(PASSWORD);
        expect(reply.raw).not.toContain("apr1");
        expect(reply.raw).not.toContain(stored);
        expect(findForbiddenPublicDtoKeys(reply.body)).toEqual([]);
      }
      const kept = await trail();
      expect(kept).not.toContain(PASSWORD);
      expect(kept).not.toContain("apr1");
      expect(kept).not.toContain(stored);
    });

    it("the user name alone keeps the password, a new password replaces it, and null removes both", async () => {
      const { stackId, ids } = await withAddresses(["door"] as const);
      expect((await patch(stackId, ids.door, { ...OFF, protection: { username: "guest", password: PASSWORD } })).status).toBe(200);
      const first = (await rowOf(stackId, ids.door)).accessPasswordHash!;

      const renamed = await patch(stackId, ids.door, { ...OFF, compression: true, protection: { username: "team.one" } });
      expect(renamed.status, renamed.raw).toBe(200);
      expect(renamed.body.data[0]).toMatchObject({ compression: true, protection: { username: "team.one" } });
      expect(await rowOf(stackId, ids.door)).toMatchObject({ accessUsername: "team.one", accessPasswordHash: first });

      const changed = await patch(stackId, ids.door, { ...OFF, protection: { username: "team.one", password: OTHER_PASSWORD } });
      expect(changed.status, changed.raw).toBe(200);
      const second = (await rowOf(stackId, ids.door)).accessPasswordHash!;
      expect(second).not.toBe(first);
      expect(apr1Verifier(OTHER_PASSWORD, second.split("$")[2])).toBe(second);

      const open = await patch(stackId, ids.door, OFF);
      expect(open.status, open.raw).toBe(200);
      expect(open.body.data[0]).toMatchObject({ compression: false, protection: null });
      expect(await rowOf(stackId, ids.door)).toMatchObject({ accessUsername: null, accessPasswordHash: null, compression: false });

      expect((await audits(stackId)).map((a) => [(a.details as Json).protectedAs, (a.details as Json).passwordSet])).toEqual([
        ["guest", true],
        ["team.one", false],
        ["team.one", true],
        [null, false],
      ]);
      const kept = await trail();
      for (const word of [PASSWORD, OTHER_PASSWORD, first, second]) expect(kept).not.toContain(word);
    });

    it("a user name without a password is refused while the address has none", async () => {
      const { stackId, ids } = await withAddresses(["bare"] as const);
      const before = await h.counts();
      const res = await patch(stackId, ids.bare, { ...OFF, protection: { username: "guest" } });
      expectRefusal(res, 400, "VALIDATION_ERROR", { field: "protection.password", reason: "password_required" });
      expect(await h.counts()).toEqual(before);
      expect(await rowOf(stackId, ids.bare)).toMatchObject({ accessUsername: null, accessPasswordHash: null });
    });

    it("every send replaces the whole set: an option left out of the next one is cleared", async () => {
      const { stackId, ids } = await withAddresses(["whole"] as const);
      const full = { redirectToDomainId: null, compression: true, protection: { username: "guest", password: PASSWORD }, pathRoutes: [API_PATH] };
      expect((await patch(stackId, ids.whole, full)).status).toBe(200);
      const res = await patch(stackId, ids.whole, { ...OFF, compression: true });
      expect(res.status, res.raw).toBe(200);
      expect(res.body.data[0]).toMatchObject({ compression: true, protection: null, pathRoutes: [], redirectToDomainId: null });
    });

    it("needs the permission to change applications: a collaborator is refused and nothing moves, a second owner is not", async () => {
      const { stackId, ids } = await withAddresses(["team"] as const);
      const collaborator = await h.addMember(h.a.orgId, "role_customer_collaborator");
      const before = await rowOf(stackId, ids.team);
      const refused = await patch(stackId, ids.team, { ...OFF, compression: true, protection: { username: "guest", password: PASSWORD } }, collaborator);
      expectRefusal(refused, 403, "PERMISSION_DENIED");
      expect(refused.raw).not.toContain(PASSWORD);
      expect(await rowOf(stackId, ids.team)).toEqual(before);
      expect(await audits(stackId)).toEqual([]);

      const owner = await h.addMember(h.a.orgId, "role_customer_owner");
      const res = await patch(stackId, ids.team, { ...OFF, compression: true }, owner);
      expect(res.status, res.raw).toBe(200);
      expect(res.body.data[0].compression).toBe(true);
    });
  });

  describe("redirect to another address of the same application", () => {
    it("points one address at another, and the destination's removal clears only the redirect", async () => {
      const { stackId, ids } = await withAddresses(["www", "apex"] as const);
      const res = await patch(stackId, ids.www, { ...OFF, compression: true, redirectToDomainId: ids.apex });
      expect(res.status, res.raw).toBe(200);
      expect((res.body.data as Json[]).find((d) => d.id === ids.www)).toMatchObject({ redirectToDomainId: ids.apex, compression: true });
      const [audit] = await audits(stackId);
      expect(audit!.details).toMatchObject({ domainId: ids.www, redirectToDomainId: ids.apex, protectedAs: null, passwordSet: false });

      const removed = await h.call(h.a.token, "DELETE", `${base(h.a, stackId)}/${ids.apex}`);
      expect(removed.status, removed.raw).toBe(200);
      expect(removed.body.data).toHaveLength(1);
      expect(removed.body.data[0]).toMatchObject({ id: ids.www, redirectToDomainId: null, compression: true });
    });

    it("refuses itself, an unknown address, and an address of another application or of another organisation, all alike", async () => {
      const { stackId, ids } = await withAddresses(["self"] as const);
      const sibling = await withAddresses(["sibling"] as const);
      const foreign = await withAddresses(["foreign"] as const, h.b);
      const before = await h.counts();
      for (const target of [ids.self, GHOST_DOMAIN, sibling.ids.sibling, foreign.ids.foreign]) {
        const res = await patch(stackId, ids.self, { ...OFF, redirectToDomainId: target });
        expectRefusal(res, 400, "VALIDATION_ERROR", { field: "redirectToDomainId", reason: "redirect_target" });
        expect(res.body.error.details).toHaveLength(1);
        for (const echo of [sibling.names.sibling, foreign.names.foreign, sibling.stackId, foreign.stackId]) expect(res.raw).not.toContain(echo);
      }
      expect(await h.counts()).toEqual(before);
      expect((await rowOf(stackId, ids.self)).redirectToDomainId).toBeNull();
    });

    it("refuses a chain in both directions", async () => {
      const { stackId, ids } = await withAddresses(["one", "two", "three"] as const);
      expect((await patch(stackId, ids.one, { ...OFF, redirectToDomainId: ids.two })).status).toBe(200);
      const before = await h.counts();
      // three → one: the destination already redirects. two → three: an address others redirect to cannot redirect.
      for (const [from, to] of [
        [ids.three, ids.one],
        [ids.two, ids.three],
      ] as const) {
        const res = await patch(stackId, from, { ...OFF, redirectToDomainId: to });
        expectRefusal(res, 400, "VALIDATION_ERROR", { field: "redirectToDomainId", reason: "redirect_chain" });
      }
      expect(await h.counts()).toEqual(before);
      // Once the first redirect is gone, both are possible.
      expect((await patch(stackId, ids.one, OFF)).status).toBe(200);
      expect((await patch(stackId, ids.two, { ...OFF, redirectToDomainId: ids.three })).status).toBe(200);
    });
  });

  describe("paths", () => {
    it("takes four paths to an ingress of the application and keeps them as sent", async () => {
      const { stackId, ids } = await withAddresses(["paths"] as const);
      const pathRoutes = ["/api", "/static/img", "/a.b~c-d_e", "/v1/x/y/z"].map((pathPrefix, i) => ({ ...API_PATH, pathPrefix, stripPrefix: i % 2 === 0 }));
      const res = await patch(stackId, ids.paths, { ...OFF, pathRoutes });
      expect(res.status, res.raw).toBe(200);
      expect(res.body.data[0].pathRoutes).toEqual(pathRoutes);
      expect((await rowOf(stackId, ids.paths)).pathRoutes).toEqual(pathRoutes);
    });

    it.each([
      ["a part that takes no web traffic", { ...API_PATH, componentKey: "cache", port: 6379 }],
      ["a part the application does not have", { ...API_PATH, componentKey: "nope" }],
      ["the right part on another port", { ...API_PATH, port: 9999 }],
    ])("a path to %s is 400 unknown_ingress, names its position, and writes nothing", async (_label, bad) => {
      const { stackId, ids } = await withAddresses(["target"] as const);
      const before = await h.counts();
      const res = await patch(stackId, ids.target, { ...OFF, pathRoutes: [{ ...API_PATH, pathPrefix: "/ok" }, bad] });
      expectRefusal(res, 400, "VALIDATION_ERROR", { field: "pathRoutes.1.componentKey", reason: "unknown_ingress" });
      expect(await h.counts()).toEqual(before);
      expect((await rowOf(stackId, ids.target)).pathRoutes).toEqual([]);
    });
  });

  describe("input", () => {
    const guest = { username: "guest", password: PASSWORD };
    const paths = (...prefixes: string[]) => prefixes.map((pathPrefix) => ({ ...API_PATH, pathPrefix }));
    it.each<[string, unknown]>([
      ["no body at all", {}],
      ["a missing option", { redirectToDomainId: null, protection: null, pathRoutes: [] }],
      ["an extra key", { ...OFF, hostname: "moved.example.test" }],
      ["a compression that is not a boolean", { ...OFF, compression: "yes" }],
      ["a destination that is not an id", { ...OFF, redirectToDomainId: "www.example.test" }],
      ["a redirect together with a password", { ...OFF, redirectToDomainId: GHOST_DOMAIN, protection: guest }],
      ["a redirect together with a path", { ...OFF, redirectToDomainId: GHOST_DOMAIN, pathRoutes: [API_PATH] }],
      ["a password of 11 characters", { ...OFF, protection: { username: "guest", password: "Short-Pass1" } }],
      ["a password of 129 characters", { ...OFF, protection: { username: "guest", password: "p".repeat(129) } }],
      ["a password with a character outside ASCII", { ...OFF, protection: { username: "guest", password: "Pässword-Canary-0001" } }],
      ["a password with a line break", { ...OFF, protection: { username: "guest", password: "Routing-Canary\nPass-0001" } }],
      ["a user name with a colon", { ...OFF, protection: { username: "gu:est", password: PASSWORD } }],
      ["an empty user name", { ...OFF, protection: { username: "", password: PASSWORD } }],
      ["a user name of 33 characters", { ...OFF, protection: { username: "u".repeat(33), password: PASSWORD } }],
      ["a password without a user name", { ...OFF, protection: { password: PASSWORD } }],
      ["a verifier sent by the caller", { ...OFF, protection: { ...guest, passwordHash: "$apr1$abcdefgh$GQF3hbcxO2ySp4igPQ/3a." } }],
      ["five paths", { ...OFF, pathRoutes: paths("/a", "/b", "/c", "/d", "/e") }],
      ["the same path twice", { ...OFF, pathRoutes: paths("/a", "/a") }],
      ["the root as a path", { ...OFF, pathRoutes: paths("/") }],
      ["a path that ends with a slash", { ...OFF, pathRoutes: paths("/api/") }],
      ["a path without a leading slash", { ...OFF, pathRoutes: paths("api") }],
      ["a path that climbs", { ...OFF, pathRoutes: paths("/a/../b") }],
      ["the path certificates are checked on", { ...OFF, pathRoutes: paths("/.well-known") }],
      ["a path of five segments", { ...OFF, pathRoutes: paths("/a/b/c/d/e") }],
      ["a path with a query", { ...OFF, pathRoutes: paths("/a?b=c") }],
      ["a path with a back quote", { ...OFF, pathRoutes: paths("/a`b") }],
      ["a path without the prefix choice", { ...OFF, pathRoutes: [{ pathPrefix: "/api", componentKey: "app", port: 8080 }] }],
      ["a path on a port out of range", { ...OFF, pathRoutes: [{ ...API_PATH, port: 70000 }] }],
    ])("%s is a 400 VALIDATION_ERROR, writes nothing and does not repeat the password", async (_label, body) => {
      const { stackId, ids } = await withAddresses(["input"] as const);
      const before = await h.counts();
      const res = await patch(stackId, ids.input, body);
      expectRefusal(res, 400, "VALIDATION_ERROR");
      for (const word of [PASSWORD, "Short-Pass1", "Pässword", "apr1"]) expect(res.raw).not.toContain(word);
      expect(await h.counts()).toEqual(before);
      expect(await rowOf(stackId, ids.input)).toMatchObject({ redirectToDomainId: null, compression: false, accessUsername: null, pathRoutes: [] });
    });
  });

  describe("who and when", () => {
    it("another organisation gets the same 404 as for an address that does not exist, and changes nothing", async () => {
      const mine = await withAddresses(["mine"] as const);
      const theirs = await withAddresses(["theirs"] as const, h.b);
      const body = { ...OFF, compression: true, protection: { username: "guest", password: PASSWORD } };
      const before = await h.counts();
      const attempts: readonly (readonly [HarnessCustomer, string])[] = [
        // B on A's address, under B's own organisation and under A's
        [h.b, `${base(h.b, mine.stackId)}/${mine.ids.mine}`],
        [h.b, `${base(h.a, mine.stackId)}/${mine.ids.mine}`],
        // B on its own application with A's address, and A on its own with B's
        [h.b, `${base(h.b, theirs.stackId)}/${mine.ids.mine}`],
        [h.a, `${base(h.a, mine.stackId)}/${theirs.ids.theirs}`],
        // an address or an application that never existed
        [h.a, `${base(h.a, mine.stackId)}/${GHOST_DOMAIN}`],
        [h.a, `${base(h.a, `stk_${"d".repeat(24)}`)}/${mine.ids.mine}`],
      ];
      for (const [who, path] of attempts) {
        const res = await h.call(who.token, "PATCH", path, body);
        expectRefusal(res, 404, "NOT_FOUND");
        expect(res.body.error.message, path).toBe(NOT_FOUND);
        for (const echo of [mine.names.mine, theirs.names.theirs, PASSWORD]) expect(res.raw, path).not.toContain(echo);
      }
      expect(await h.counts()).toEqual(before);
      for (const [stackId, id] of [
        [mine.stackId, mine.ids.mine],
        [theirs.stackId, theirs.ids.theirs],
      ] as const) {
        expect(await rowOf(stackId, id)).toMatchObject({ compression: false, accessUsername: null, accessPasswordHash: null });
      }
    });

    it("an address of the caller's other application is a 404 too", async () => {
      const one = await withAddresses(["one"] as const);
      const two = await withAddresses(["two"] as const);
      expectRefusal(await patch(two.stackId, one.ids.one, { ...OFF, compression: true }), 404, "NOT_FOUND");
      expect((await rowOf(one.stackId, one.ids.one)).compression).toBe(false);
    });

    it("an anonymous caller is refused before any lookup", async () => {
      const { stackId, ids } = await withAddresses(["anon"] as const);
      const res = await h.call(null, "PATCH", `${base(h.a, stackId)}/${ids.anon}`, { ...OFF, compression: true });
      expect(res.status, res.raw).toBe(401);
      expect((await rowOf(stackId, ids.anon)).compression).toBe(false);
    });

    it.each(["deleting", "delete_failed"] as const)("an application that is %s takes no change", async (status) => {
      const { stackId, ids } = await withAddresses(["leaving"] as const);
      await h.dbClient.db.update(appStacks).set({ status }).where(eq(appStacks.id, stackId));
      const before = await h.counts();
      const res = await patch(stackId, ids.leaving, { ...OFF, compression: true });
      expectRefusal(res, 409, "RESOURCE_LOCKED", { field: "status", reason: status });
      expect(await h.counts()).toEqual(before);
      expect((await rowOf(stackId, ids.leaving)).compression).toBe(false);
    });
  });

  describe("a change reaches every route that may be published, or is refused", () => {
    const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
    const verb = (stackId: string, name: string, body: unknown = {}) =>
      h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/${name}`, body, { "Idempotency-Key": randomUUID() });

    beforeAll(async () => {
      // Every case installs an application of its own.
      await h.dbClient.db
        .update(resourceQuotas)
        .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
        .where(eq(resourceQuotas.organizationId, h.a.orgId));
    });

    /** An address on a stack whose revision 1 was queued, its action over; then `status`, with revision 1 applied or not. */
    async function installed(status: string, applied: boolean): Promise<{ stackId: string; id: string }> {
      const { stackId, ids } = await withAddresses(["state"] as const);
      expect((await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/secrets`, { parameterKey: "app_secret", value: "first-value" })).status).toBe(200);
      expect((await verb(stackId, "deploy")).status).toBe(202);
      await h.dbClient.db.update(operations).set({ status: "succeeded", completedAt: new Date() }).where(eq(operations.resourceId, stackId));
      const { desiredRevisionId } = await stackRow(stackId);
      await h.dbClient.db
        .update(appStacks)
        .set({ status: status as never, appliedRevisionId: applied ? desiredRevisionId : null })
        .where(eq(appStacks.id, stackId));
      return { stackId, id: ids.state };
    }

    it("an application not installed yet keeps the options and says they apply when it starts", async () => {
      const { stackId, ids } = await withAddresses(["draft"] as const);
      const res = await patch(stackId, ids.draft, { ...OFF, protection: { username: "guest", password: PASSWORD } });
      expect(res.status, res.raw).toBe(200);
      expect(res.body.applies).toBe("at_start");
      expect(res.body.data[0]).toMatchObject({ protection: { username: "guest" } });
    });

    it.each([
      ["stopped", true],
      ["queued", false],
      ["deploying", false],
      ["failed", false],
    ] as const)("%s (revision applied: %s) publishes no route: the options are kept for the next start", async (status, applied) => {
      const { stackId, id } = await installed(status, applied);
      const res = await patch(stackId, id, { ...OFF, protection: { username: "guest", password: PASSWORD } });
      expect(res.status, res.raw).toBe(200);
      expect(res.body.applies).toBe("at_start");
      expect((await rowOf(stackId, id)).accessUsername).toBe("guest");
    });

    it.each(["running", "degraded"] as const)("%s with its revision applied: the routes are rewritten in a few moments", async (status) => {
      const { stackId, id } = await installed(status, true);
      const res = await patch(stackId, id, { ...OFF, compression: true });
      expect(res.status, res.raw).toBe(200);
      expect(res.body.applies).toBe("shortly");
    });

    it.each(["failed", "unknown", "updating", "starting", "stopping"] as const)(
      "%s with a revision applied may keep a route nothing rewrites now: 409, and nothing is written",
      async (status) => {
        const { stackId, id } = await installed(status, true);
        const before = await h.counts();
        const res = await patch(stackId, id, { ...OFF, compression: true, protection: { username: "guest", password: PASSWORD } });
        expectRefusal(res, 409, "RESOURCE_LOCKED", { field: "status", reason: status });
        expect(res.raw).not.toContain(PASSWORD);
        expect(await h.counts()).toEqual(before);
        expect(await rowOf(stackId, id)).toMatchObject({ compression: false, accessUsername: null, accessPasswordHash: null });
      },
    );

    it("a running application the customer last asked to stop, whose stop failed, takes no change either", async () => {
      const { stackId, id } = await installed("running", true);
      expect((await verb(stackId, "stop")).status).toBe(202);
      await h.dbClient.db.update(operations).set({ status: "failed", completedAt: new Date() }).where(and(eq(operations.resourceId, stackId), eq(operations.kind, "stack.stop")));
      await h.dbClient.db.update(appStacks).set({ status: "degraded" }).where(eq(appStacks.id, stackId));
      const before = await h.counts();
      expectRefusal(await patch(stackId, id, { ...OFF, compression: true }), 409, "RESOURCE_LOCKED", { field: "status", reason: "degraded" });
      expect(await h.counts()).toEqual(before);
    });

    describe("a path points at a part of the revision that runs and of the one asked for", () => {
      const CACHE_PATH = { pathPrefix: "/cache", componentKey: "cache", port: 6379, stripPrefix: false };

      /** Revision 1 of `from` runs; revision 2 of `to` was asked for and is not installed (its upgrade failed early). */
      async function upgradeNotInstalled(from: string, to: string): Promise<{ stackId: string; id: string }> {
        const { templateId, versionId } = await h.publish(from);
        const res = await h.call(
          h.a.token,
          "POST",
          `/v1/organizations/${h.a.orgId}/app-stacks`,
          { templateVersionId: versionId, name: `app-${randomUUID().slice(0, 8)}`, deploy: false },
          { "Idempotency-Key": randomUUID() },
        );
        expect(res.status, res.raw).toBe(201);
        const stackId = res.body.data.stackId as string;
        const added = await h.call(h.a.token, "POST", base(h.a, stackId), { hostname: host("two"), componentKey: "app", port: 8080 });
        expect(added.status, added.raw).toBe(201);
        expect((await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/secrets`, { parameterKey: "app_secret", value: "first-value" })).status).toBe(200);
        expect((await verb(stackId, "deploy")).status).toBe(202);
        await h.dbClient.db.update(operations).set({ status: "succeeded", completedAt: new Date() }).where(eq(operations.resourceId, stackId));
        const rev1 = (await stackRow(stackId)).desiredRevisionId;
        await h.dbClient.db.update(appStacks).set({ status: "running", appliedRevisionId: rev1 }).where(eq(appStacks.id, stackId));
        const v2 = await h.call(h.adminToken, "POST", `/v1/admin/app-templates/${templateId}/versions`, { source: to, makeDefault: true });
        expect(v2.status, v2.raw).toBe(201);
        const preview = await verb(stackId, "plan", { templateVersionId: v2.body.data.versionId });
        expect(preview.status, preview.raw).toBe(200);
        expect((await verb(stackId, "upgrade", { templateVersionId: v2.body.data.versionId, planHash: preview.body.data.planHash })).status).toBe(202);
        await h.dbClient.db.update(operations).set({ status: "failed", completedAt: new Date() }).where(eq(operations.resourceId, stackId));
        await h.dbClient.db.update(appStacks).set({ status: "running" }).where(eq(appStacks.id, stackId));
        const row = await stackRow(stackId);
        expect(row.appliedRevisionId).toBe(rev1);
        expect(row.desiredRevisionId).not.toBe(rev1);
        return { stackId, id: (added.body.data as Json[])[0]!.id as string };
      }

      it.each([
        ["only the revision asked for has it", NOTES_DEMO_SOURCE, TWO_DOORS],
        ["only the revision that runs has it", TWO_DOORS, NOTES_DEMO_SOURCE],
      ])("a path to a part %s is 400 unknown_ingress and writes nothing", async (_label, from, to) => {
        const { stackId, id } = await upgradeNotInstalled(from, to);
        const before = await h.counts();
        expectRefusal(await patch(stackId, id, { ...OFF, pathRoutes: [CACHE_PATH] }), 400, "VALIDATION_ERROR", {
          field: "pathRoutes.0.componentKey",
          reason: "unknown_ingress",
        });
        expect(await h.counts()).toEqual(before);
        const fine = await patch(stackId, id, { ...OFF, pathRoutes: [API_PATH] });
        expect(fine.status, fine.raw).toBe(200);
        expect(fine.body.applies).toBe("shortly");
      });
    });
  });

  describe("compression chosen when the address is created", () => {
    const assigned = (stackId: string) =>
      h.dbClient.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "app.stack.domain.assign"), eq(auditEvents.targetId, stackId)))
        .orderBy(asc(auditEvents.timestamp));

    it("an added address takes compression in the same request; left out or false it stays off and the audit row is as before", async () => {
      const stackId = await draft();
      const [on, plain, off] = [host("on"), host("plain"), host("off")];
      for (const body of [
        { hostname: on, componentKey: "app", port: 8080, compression: true },
        { hostname: plain, componentKey: "app", port: 8080 },
        { hostname: off, componentKey: "app", port: 8080, compression: false },
      ]) {
        const res = await h.call(h.a.token, "POST", base(h.a, stackId), body);
        expect(res.status, res.raw).toBe(201);
        expect((res.body.data as Json[]).find((d) => d.hostname === body.hostname)).toMatchObject({
          compression: body.compression === true,
          redirectToDomainId: null,
          protection: null,
          pathRoutes: [],
        });
      }
      const byHost = new Map((await rows(stackId)).map((r) => [r.hostname, r]));
      expect([on, plain, off].map((name) => byHost.get(name)!.compression)).toEqual([true, false, false]);
      const details = new Map((await assigned(stackId)).map((a) => [(a.details as Json).hostname as string, a.details as Json]));
      const expected = (name: string) => ({
        domainId: byHost.get(name)!.id,
        hostname: name,
        componentKey: "app",
        internalPort: 8080,
        outcome: "succeeded",
        requestId: expect.stringMatching(/^req_/),
      });
      expect(details.get(on)).toEqual({ ...expected(on), compression: true });
      expect(details.get(plain)).toEqual(expected(plain));
      expect(details.get(off)).toEqual(expected(off));
    });

    it("an application created with its addresses takes it per address", async () => {
      const [on, plain] = [host("made-on"), host("made-plain")];
      const res = await h.call(
        h.a.token,
        "POST",
        `/v1/organizations/${h.a.orgId}/app-stacks`,
        {
          templateVersionId: notes,
          name: `app-${randomUUID().slice(0, 8)}`,
          deploy: false,
          domains: [
            { hostname: on, componentKey: "app", port: 8080, compression: true },
            { hostname: plain, componentKey: "app", port: 8080 },
          ],
        },
        { "Idempotency-Key": randomUUID() },
      );
      expect(res.status, res.raw).toBe(201);
      const stackId = res.body.data.stackId as string;
      const byHost = new Map((await rows(stackId)).map((r) => [r.hostname, r.compression]));
      expect([byHost.get(on), byHost.get(plain)]).toEqual([true, false]);
      const details = (await assigned(stackId)).map((a) => a.details as Json);
      expect(details.find((d) => d.hostname === on)).toMatchObject({ compression: true });
      expect(details.find((d) => d.hostname === plain)).not.toHaveProperty("compression");
    });

    it("anything but true or false is refused and adds nothing", async () => {
      const stackId = await draft();
      const before = await h.counts();
      for (const compression of ["yes", 1, null]) {
        const res = await h.call(h.a.token, "POST", base(h.a, stackId), { hostname: host("bad"), componentKey: "app", port: 8080, compression });
        expectRefusal(res, 400, "VALIDATION_ERROR");
      }
      expect(await h.counts()).toEqual(before);
      expect(await rows(stackId)).toEqual([]);
    });
  });
});
