import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import { and, appStacks, auditEvents, eq, isNull, operations, resourceQuotas } from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

const NOT_FOUND = "Requested organization or resource was not found.";
const HASH = "a".repeat(64);

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

/** The fixed sentence, and none of the ids the caller sent. */
function expectHidden(res: Reply, ...echoes: readonly string[]): void {
  expectRefusal(res, 404, "NOT_FOUND");
  expect(res.body.error.message).toBe(NOT_FOUND);
  for (const echo of echoes) expect(res.raw).not.toContain(echo);
}

describe("application stacks: tenancy, quota race and replays (QA M4)", () => {
  let h: AppStackHarness;
  let notes: string;
  let web: string;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    for (const c of [h.a, h.b]) {
      await h.dbClient.db
        .update(resourceQuotas)
        .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
        .where(eq(resourceQuotas.organizationId, c.orgId));
    }
    notes = (await h.publish()).versionId;
    web = (await h.publish(APP_BUILT_IN_TEMPLATES[0]!.source)).versionId;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const base = (c: HarnessCustomer) => `/v1/organizations/${c.orgId}/app-stacks`;
  const idem = (key: string = randomUUID()) => ({ "Idempotency-Key": key });
  const create = (c: HarnessCustomer, body: Json, key?: string) => h.call(c.token, "POST", base(c), body, idem(key));
  const act = (c: HarnessCustomer, stackId: string, verb: string, body: unknown = {}, key?: string) =>
    h.call(c.token, "POST", `${base(c)}/${stackId}/${verb}`, body, idem(key));
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const liveStacks = (c: HarnessCustomer) =>
    h.dbClient.db
      .select()
      .from(appStacks)
      .where(and(eq(appStacks.organizationId, c.orgId), isNull(appStacks.deletedAt)));
  const opsOf = (stackId: string) => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));

  async function draft(c: HarnessCustomer = h.a, name = `app-${randomUUID().slice(0, 8)}`): Promise<string> {
    const res = await create(c, { templateVersionId: notes, name, deploy: false });
    expect(res.status, res.raw).toBe(201);
    return res.body.data.stackId as string;
  }

  /** The outbox never runs here: end the operations as a runtime would. */
  async function settle(stackId: string, status: "running" | "stopped"): Promise<void> {
    await h.dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.resourceId, stackId));
    await h.dbClient.db.update(appStacks).set({ status }).where(eq(appStacks.id, stackId));
  }

  /** PGlite runs one transaction at a time: holding one parks every request, which then all read before any writes. */
  async function sentTogether<T>(requests: readonly (() => Promise<T>)[]): Promise<T[]> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = h.dbClient.db.transaction(async () => held);
    const pending = requests.map((request) => request());
    await new Promise((resolve) => setTimeout(resolve, 200));
    release();
    await gate;
    return Promise.all(pending);
  }

  describe("B1: the whole customer matrix", () => {
    it("a foreign stack id is a 404 with the fixed sentence on every stack and domain route, under both paths, and writes nothing", async () => {
      const ownStack = await draft(h.a);
      const domain = await h.call(h.a.token, "POST", `${base(h.a)}/${ownStack}/domains`, { hostname: "qa-a.example.test", componentKey: "app", port: 8080 });
      expect(domain.status, domain.raw).toBe(201);
      const domainId = domain.body.data[0].id as string;

      // [method, path after the stack id, body]
      const routes: readonly (readonly [string, string, unknown?])[] = [
        ["GET", ""],
        ["POST", "/plan", {}],
        ["POST", "/deploy", {}],
        ["POST", "/start", {}],
        ["POST", "/stop", {}],
        ["POST", "/restart", {}],
        ["POST", "/upgrade", { templateVersionId: `atv_${"0".repeat(24)}`, planHash: HASH }],
        ["POST", "/rollback", { revisionId: `srev_${"0".repeat(24)}`, planHash: HASH }],
        ["DELETE", "", { confirmName: "x", destroyData: false }],
        ["GET", "/deployments"],
        ["GET", "/components/app/logs"],
        ["GET", "/components/app/health"],
        ["POST", "/secrets", { parameterKey: "app_secret", value: "v" }],
        ["GET", "/backups"],
        ["POST", "/backups", {}],
        ["POST", `/backups/sbak_${"0".repeat(24)}/restore`, { confirmName: "x" }],
        ["GET", "/domains"],
        ["POST", "/domains", { hostname: "qa-b.example.test", componentKey: "app", port: 8080 }],
        ["DELETE", `/domains/${domainId}`, {}],
        ["POST", `/domains/${domainId}/check`, {}],
      ];
      expect(routes).toHaveLength(20); // 18 stack routes minus create and list (no stack id), plus the 4 domain routes
      const before = await h.counts();
      for (const [method, suffix, body] of routes) {
        for (const path of [`${base(h.b)}/${ownStack}${suffix}`, `${base(h.a)}/${ownStack}${suffix}`]) {
          const res = await h.call(h.b.token, method, path, body, idem());
          expectHidden(res, ownStack, domainId);
        }
      }
      expect(await h.counts()).toEqual(before);
      expect((await stackRow(ownStack)).status).toBe("draft");
    });

    it("an unknown stack id of the caller's own organisation is the same 404", async () => {
      const ghost = `stk_${"f".repeat(24)}`;
      for (const [method, suffix, body] of [
        ["GET", ""],
        ["POST", "/plan", {}],
        ["POST", "/deploy", {}],
        ["POST", "/stop", {}],
        ["DELETE", "", { confirmName: "x", destroyData: false }],
        ["GET", "/components/app/health"],
        ["GET", "/backups"],
        ["POST", "/backups", {}],
        ["POST", `/backups/sbak_${"0".repeat(24)}/restore`, { confirmName: "x" }],
        ["GET", "/domains"],
        ["POST", `/domains/adm_${"0".repeat(24)}/check`, {}],
      ] as const) {
        expectHidden(await h.call(h.a.token, method, `${base(h.a)}/${ghost}${suffix}`, body, idem()), ghost);
      }
    });

    it("a foreign domain id on an own stack is a 404 for remove and check, and the foreign row survives", async () => {
      const mine = await draft(h.a);
      const other = await draft(h.a);
      const theirs = await draft(h.b);
      const added = async (c: HarnessCustomer, stackId: string, hostname: string): Promise<string> => {
        const res = await h.call(c.token, "POST", `${base(c)}/${stackId}/domains`, { hostname, componentKey: "app", port: 8080 });
        expect(res.status, res.raw).toBe(201);
        return res.body.data[0].id as string;
      };
      const siblingDomain = await added(h.a, other, "qa-sibling.example.test");
      const foreignDomain = await added(h.b, theirs, "qa-foreign.example.test");
      const unknownDomain = `adm_${"1".repeat(24)}`;
      const before = await h.counts();
      for (const domainId of [siblingDomain, foreignDomain, unknownDomain]) {
        for (const [method, suffix] of [
          ["DELETE", ""],
          ["POST", "/check"],
        ] as const) {
          const res = await h.call(h.a.token, method, `${base(h.a)}/${mine}/domains/${domainId}${suffix}`, {}, idem());
          expectHidden(res, domainId, mine);
        }
      }
      expect(await h.counts()).toEqual(before);
      for (const [c, stackId, domainId] of [
        [h.a, other, siblingDomain],
        [h.b, theirs, foreignDomain],
      ] as const) {
        const list = await h.call(c.token, "GET", `${base(c)}/${stackId}/domains`);
        expect(list.body.data.map((d: Json) => d.id)).toEqual([domainId]);
      }
    });

    it("a component key the stack does not have is a 404 for logs and health, whoever owns the other component", async () => {
      const stackId = await draft(h.a);
      const webStack = await create(h.a, { templateVersionId: web, name: `qa-web-${randomUUID().slice(0, 6)}`, deploy: false });
      expect(webStack.status, webStack.raw).toBe(201);
      // "web" belongs to another stack of the same customer; "nope" to nobody.
      for (const key of ["nope", "web", "APP", "..%2Fapp"]) {
        for (const leaf of ["logs", "health"]) {
          const res = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/${key}/${leaf}`);
          expectHidden(res, stackId);
          if (/^[a-z]+$/i.test(key)) expect(res.raw).not.toContain(`"${key}"`);
        }
      }
      // Another organisation asking for a component that does exist on the stack learns nothing either.
      for (const leaf of ["logs", "health"]) {
        expectHidden(await h.call(h.b.token, "GET", `${base(h.b)}/${stackId}/components/app/${leaf}`), stackId);
      }
    });

    it("the catalogue detail of an unknown template is the same 404 for both customers", async () => {
      const unknown = `atpl_${"2".repeat(24)}`;
      for (const c of [h.a, h.b]) {
        expectHidden(await h.call(c.token, "GET", `/v1/organizations/${c.orgId}/app-templates/${unknown}`), unknown);
      }
    });
  });

  describe("B2: the application limit under concurrency", () => {
    it("a limit of 2 and three simultaneous creates: two are accepted, one is QUOTA_EXCEEDED, two live stacks and two operations", async () => {
      // Customer B already holds the drafts of the matrix above: leave room for exactly two more.
      const held = await liveStacks(h.b);
      const limit = await h.call(h.adminToken, "PATCH", `/v1/admin/organizations/${h.b.orgId}/app-stack-limit`, {
        maxAppStacks: held.length + 2,
      });
      expect(limit.status, limit.raw).toBe(200);
      const before = await h.counts();
      const replies = await sentTogether(
        ["one", "two", "three"].map((name) => () => create(h.b, { templateVersionId: web, name: `qa-race-${name}`, deploy: true })),
      );
      expect(replies.map((r) => r.status).sort()).toEqual([202, 202, 409]);
      const refused = replies.find((r) => r.status === 409)!;
      expectRefusal(refused, 409, "QUOTA_EXCEEDED", { reason: "STACK_QUOTA_EXCEEDED" });
      expect(refused.body.error.message).not.toContain(h.b.orgId);

      const live = await liveStacks(h.b);
      expect(live).toHaveLength(held.length + 2);
      const accepted = replies.filter((r) => r.status === 202).map((r) => r.body.data.stackId as string);
      expect(live.map((s) => s.id).sort()).toEqual([...held.map((s) => s.id), ...accepted].sort());
      const after = await h.counts();
      expect([after.app_stacks! - before.app_stacks!, after.operations! - before.operations!, after.outbox_events! - before.outbox_events!]).toEqual([
        2, 2, 2,
      ]);
      // The refused request left no half-written stack behind.
      expect(after.app_stack_revisions! - before.app_stack_revisions!).toBe(2);
      expect(after.app_stack_deployments! - before.app_stack_deployments!).toBe(2);

      // A fourth, sequential create is refused the same way; the limit of the other customer is untouched.
      expectRefusal(await create(h.b, { templateVersionId: web, name: "qa-race-four", deploy: true }), 409, "QUOTA_EXCEEDED", {
        reason: "STACK_QUOTA_EXCEEDED",
      });
      expect((await create(h.a, { templateVersionId: web, name: `qa-race-a-${randomUUID().slice(0, 6)}`, deploy: true })).status).toBe(202);
    });
  });

  describe("A16: replays", () => {
    it("a replay after the stack changed status returns the same operation and writes no row, even while another operation runs", async () => {
      const stackId = await draft(h.a);
      await settle(stackId, "stopped");
      const key = randomUUID();
      const start = await act(h.a, stackId, "start", {}, key);
      expect(start.status, start.raw).toBe(202);
      const operationId = start.body.data.operationId as string;

      await settle(stackId, "running");
      const stop = await act(h.a, stackId, "stop", {}, randomUUID());
      expect(stop.status, stop.raw).toBe(202);
      expect(stop.body.data.operationId).not.toBe(operationId);
      expect((await stackRow(stackId)).status).toBe("stopping");

      // The stack is busy and its status no longer allows a start: only a replay can answer 202 here.
      const before = await h.counts();
      const busyReplay = await act(h.a, stackId, "start", {}, key);
      expect(busyReplay.status, busyReplay.raw).toBe(202);
      expect(busyReplay.body.data.operationId).toBe(operationId);
      expect(busyReplay.body.data.stackId).toBe(stackId);
      expect(busyReplay.body.links).toEqual(start.body.links);
      expect(await h.counts()).toEqual(before);

      await settle(stackId, "stopped");
      const settledReplay = await act(h.a, stackId, "start", {}, key);
      expect(settledReplay.status, settledReplay.raw).toBe(202);
      expect(settledReplay.body.data.operationId).toBe(operationId);
      expect(await h.counts()).toEqual(before);
      expect((await opsOf(stackId)).map((op) => op.kind).sort()).toEqual(["stack.start", "stack.stop"]);
      expect((await stackRow(stackId)).status).toBe("stopped");

      // A different body under the same key is still a conflict, and a fresh key meets the status check.
      expectRefusal(await act(h.a, stackId, "stop", {}, key), 409, "IDEMPOTENCY_CONFLICT");
      expectRefusal(await act(h.a, stackId, "stop", {}, randomUUID()), 409, "RESOURCE_LOCKED", { field: "status", reason: "stopped" });
      expect(await h.counts()).toEqual(before);
    });

    it("a deploy key replayed after the stack moved on is the same deployment and builds no revision", async () => {
      const stackId = await draft(h.a);
      expect((await h.call(h.a.token, "POST", `${base(h.a)}/${stackId}/secrets`, { parameterKey: "app_secret", value: "qa-secret-1" })).status).toBe(200);
      const key = randomUUID();
      const deploy = await act(h.a, stackId, "deploy", {}, key);
      expect(deploy.status, deploy.raw).toBe(202);
      await settle(stackId, "running");
      expect((await act(h.a, stackId, "restart")).status).toBe(202);
      const before = await h.counts();
      const replay = await act(h.a, stackId, "deploy", {}, key);
      expect(replay.status, replay.raw).toBe(202);
      expect(replay.body.data.operationId).toBe(deploy.body.data.operationId);
      expect(replay.body.data.deploymentId).toBe(deploy.body.data.deploymentId);
      expect(await h.counts()).toEqual(before);
    });

    it.each([
      ["a draft (201)", false, 201],
      ["a deployed stack (202)", true, 202],
    ] as const)("a create of %s whose name another stack holds by now is still the replay", async (_label, deploy, status) => {
      const name = `qa-name-${randomUUID().slice(0, 6)}`;
      const key = randomUUID();
      const body = { templateVersionId: web, name, deploy };
      const first = await create(h.a, body, key);
      expect(first.status, first.raw).toBe(status);
      const firstId = first.body.data.stackId as string;

      // The name frees up when the first stack is gone, and another stack takes it.
      await h.dbClient.db.update(appStacks).set({ status: "deleted", deletedAt: new Date() }).where(eq(appStacks.id, firstId));
      const taker = await create(h.a, body, randomUUID());
      expect(taker.status, taker.raw).toBe(status);
      expect(taker.body.data.stackId).not.toBe(firstId);
      // Control: with a fresh key the name is taken.
      expectRefusal(await create(h.a, body, randomUUID()), 409, "ALREADY_EXISTS", { field: "name", reason: "name_taken" });

      const before = await h.counts();
      const replay = await create(h.a, body, key);
      expect(replay.status, replay.raw).toBe(status);
      expect(replay.body.data.stackId).toBe(firstId);
      expect(replay.body.data.operationId ?? null).toBe(first.body.data.operationId ?? null);
      expect(await h.counts()).toEqual(before);
      const audits = await h.dbClient.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "app.stack.create"), eq(auditEvents.targetId, firstId)));
      expect(audits).toHaveLength(1);
    });

    it("one key cannot be replayed by another customer: the replay is scoped to the organisation", async () => {
      expect((await h.call(h.adminToken, "PATCH", `/v1/admin/organizations/${h.b.orgId}/app-stack-limit`, { maxAppStacks: null })).status).toBe(200);
      const key = randomUUID();
      const body = { templateVersionId: web, name: `qa-scope-${randomUUID().slice(0, 6)}`, deploy: false };
      const mine = await create(h.a, body, key);
      expect(mine.status, mine.raw).toBe(201);
      const theirs = await create(h.b, body, key);
      expect(theirs.status, theirs.raw).toBe(201);
      expect(theirs.body.data.stackId).not.toBe(mine.body.data.stackId);
      expect((await stackRow(theirs.body.data.stackId as string)).organizationId).toBe(h.b.orgId);
    });
  });
});
