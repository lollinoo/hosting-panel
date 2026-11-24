import { randomUUID } from "node:crypto";
import {
  APP_BUILT_IN_TEMPLATES,
  APP_IMAGE_ALLOWLIST,
  APP_STACK_ENQUEUE_TRANSITIONS,
  APP_STACK_OPERATION_KINDS,
  APP_STACK_STATUSES,
  type AppStackOperationKind,
  type AppStackStatus,
} from "@hosting-panel/contracts";
import {
  appStackRevisions,
  appStacks,
  appStackVolumes,
  asc,
  eq,
  operations,
  organizations,
  resourceQuotas,
} from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_TEST_ALLOWLIST, NOTES_DEMO_SOURCE, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

/** Images on the code allowlist and a `data` volume: the runtime and the simulator accept it. */
const STORAGE_SOURCE = APP_BUILT_IN_TEMPLATES[1]!.source;
const STORAGE_V2 = STORAGE_SOURCE.replace("          memory: 32M", "          memory: 48M");
const PARAMS = [{ key: "worker_interval_seconds", value: 15 }];

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("application stacks: lifecycle through HTTP (QA M4)", () => {
  let h: AppStackHarness;
  let notes: string;
  /** Stacks of one template (only its default version installs): never upgraded. */
  let v1: string;
  /** Stacks of a second template, created at its version 1 before version 2 became the default. */
  let v2: string;
  type Made = { id: string; name: string };
  const lagging: { byStatus: Partial<Record<AppStackStatus, Made>>; activeOp?: Made; activeOpRollback?: Made; suspended?: Made; rollbackBase?: Made } = { byStatus: {} };

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 10_000, maxCpuMilli: 10_000_000, maxMemoryBytes: String(2 ** 55) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    notes = (await h.publish(NOTES_DEMO_SOURCE)).versionId;
    v1 = (await h.publish(STORAGE_SOURCE)).versionId;
    const second = await h.publish(STORAGE_SOURCE);
    for (const status of APP_STACK_STATUSES) lagging.byStatus[status] = await stackIn(status, second.versionId);
    lagging.activeOp = await stackIn(null, second.versionId);
    lagging.activeOpRollback = await stackIn("running", second.versionId);
    lagging.suspended = await stackIn("running", second.versionId);
    lagging.rollbackBase = await stackIn("running", second.versionId);
    const added = await h.call(h.adminToken, "POST", `/v1/admin/app-templates/${second.templateId}/versions`, {
      source: STORAGE_V2,
      makeDefault: true,
    });
    expect(added.status, added.raw).toBe(201);
    v2 = added.body.data.versionId as string;
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  const root = () => `/v1/organizations/${h.a.orgId}/app-stacks`;
  const idem = (key: string = randomUUID()) => ({ "Idempotency-Key": key });
  const send = (method: string, stackId: string, suffix: string, body?: unknown, key?: string) =>
    h.call(h.a.token, method, `${root()}/${stackId}${suffix}`, body, idem(key));
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = (stackId: string) => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
  const volumesOf = (stackId: string) =>
    h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId));
  const revisionsOf = (stackId: string) =>
    h.dbClient.db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId)).orderBy(asc(appStackRevisions.revisionNumber));

  /** The outbox never runs here: end the operations as a runtime would and put the stack in `status`. */
  async function seed(stackId: string, status: AppStackStatus): Promise<void> {
    await h.dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.resourceId, stackId));
    await h.dbClient.db.update(appStacks).set({ status, deletedAt: status === "deleted" ? new Date() : null }).where(eq(appStacks.id, stackId));
  }

  /** A storage stack (one `data` volume) whose revision 1 is queued, then seeded to `status` with no active operation. */
  async function stackIn(status: AppStackStatus | null, versionId: string = v1): Promise<Made> {
    const name = `app-${randomUUID().slice(0, 8)}`;
    const res = await h.call(h.a.token, "POST", root(), { templateVersionId: versionId, name, deploy: true, parameters: PARAMS }, idem());
    expect(res.status, res.raw).toBe(202);
    const id = res.body.data.stackId as string;
    if (status !== null) await seed(id, status);
    return { id, name };
  }

  /** The request a kind takes, for a stack that is one version behind (v2 is the default). */
  async function requestOf(kind: AppStackOperationKind, stack: { id: string; name: string }, destroyData: boolean): Promise<Reply> {
    switch (kind) {
      case "stack.deploy":
        return send("POST", stack.id, "/deploy", {});
      case "stack.start":
        return send("POST", stack.id, "/start", {});
      case "stack.stop":
        return send("POST", stack.id, "/stop", {});
      case "stack.restart":
        return send("POST", stack.id, "/restart", {});
      case "stack.delete":
        return send("DELETE", stack.id, "", { confirmName: stack.name, destroyData });
      case "stack.upgrade": {
        const plan = await send("POST", stack.id, "/plan", { templateVersionId: v2, parameters: PARAMS });
        // A deleted stack is gone for the customer: its plan is already a 404.
        if (plan.status !== 200) return plan;
        return send("POST", stack.id, "/upgrade", { templateVersionId: v2, parameters: PARAMS, planHash: plan.body.data.planHash });
      }
      case "stack.rollback":
        throw new Error("rollback runs on a stack with two revisions");
    }
  }

  const expectedTarget = (kind: AppStackOperationKind, status: AppStackStatus): AppStackStatus | null =>
    APP_STACK_ENQUEUE_TRANSITIONS[kind][status] ?? null;

  it("the transition table accepts the documented sources (so the matrix below cannot pass by refusing everything)", () => {
    expect(expectedTarget("stack.deploy", "draft")).toBe("queued");
    expect(expectedTarget("stack.start", "stopped")).toBe("starting");
    expect(expectedTarget("stack.stop", "running")).toBe("stopping");
    expect(expectedTarget("stack.restart", "running")).toBe("starting");
    expect(expectedTarget("stack.upgrade", "running")).toBe("updating");
    expect(expectedTarget("stack.delete", "failed")).toBe("deleting");
    expect(expectedTarget("stack.start", "running")).toBeNull();
    expect(expectedTarget("stack.delete", "deleting")).toBeNull();
  });

  const MATRIX_KINDS = APP_STACK_OPERATION_KINDS.filter((k) => k !== "stack.rollback");
  it.each(MATRIX_KINDS)("%s from every status: 202 with the table's status, or 409 RESOURCE_LOCKED naming the status, writing nothing", async (kind) => {
    for (const [index, status] of APP_STACK_STATUSES.entries()) {
      const target = expectedTarget(kind, status);
      const stack = kind === "stack.upgrade" ? lagging.byStatus[status]! : await stackIn(status);
      const volumesBefore = (await volumesOf(stack.id)).map((v) => [v.volumeKey, v.retentionPolicy]);
      expect(volumesBefore).toEqual([["data", "retain"]]);
      // A refused delete must never mark data for removal: ask for it every time it is refused.
      const destroyData = target === null || index % 2 === 0;
      const label = `${kind} from ${status}`;
      // Issue #106: the detail offers the kind exactly when the request below is accepted.
      const listed = status === "deleted" ? null : ((await h.call(h.a.token, "GET", `${root()}/${stack.id}`)).body.data.allowedActions as string[]);
      if (listed !== null) expect([label, listed.includes(kind)]).toEqual([label, target !== null]);
      const before = await h.counts();
      const res = await requestOf(kind, stack, destroyData);
      if (status === "deleted") {
        // A deleted stack no longer exists for the customer: not found, not a conflict.
        expect([label, res.status, res.body.error?.code]).toEqual([label, 404, "NOT_FOUND"]);
        expect(await h.counts(), label).toEqual(before);
        continue;
      }
      if (target === null) {
        expect([label, res.status, res.body.error?.code]).toEqual([label, 409, "RESOURCE_LOCKED"]);
        expect(res.body.error.details, label).toContainEqual(expect.objectContaining({ field: "status", reason: status }));
        expect(res.body.error.retryable, label).toBe(false);
        // The upgrade preflight made no write either: only the plan above (no rows) ran.
        expect(await h.counts(), label).toEqual(before);
        expect((await stackRow(stack.id)).status, label).toBe(status);
        expect(await opsOf(stack.id), label).toHaveLength(1);
        expect((await volumesOf(stack.id)).map((v) => v.retentionPolicy), label).toEqual(["retain"]);
        continue;
      }
      expect([label, res.status, res.body.data?.status]).toEqual([label, 202, target]);
      expect((await stackRow(stack.id)).status, label).toBe(target);
      const queued = (await opsOf(stack.id)).filter((op) => op.id === res.body.data.operationId);
      expect(queued.map((op) => op.kind), label).toEqual([kind]);
      const after = await h.counts();
      expect([label, after.operations! - before.operations!, after.outbox_events! - before.outbox_events!]).toEqual([label, 1, 1]);
      if (kind === "stack.delete") {
        expect((await volumesOf(stack.id)).map((v) => v.retentionPolicy), label).toEqual([destroyData ? "destroy" : "retain"]);
      }
    }
  }, 300_000);

  it("stack.rollback from every status: 202 or 409 as the table says", async () => {
    const stack = lagging.rollbackBase!;
    const plan = await send("POST", stack.id, "/plan", { templateVersionId: v2, parameters: PARAMS });
    expect((await send("POST", stack.id, "/upgrade", { templateVersionId: v2, parameters: PARAMS, planHash: plan.body.data.planHash })).status).toBe(
      202,
    );
    await seed(stack.id, "running");
    const [rev1] = await revisionsOf(stack.id);
    expect(await revisionsOf(stack.id)).toHaveLength(2);
    for (const status of APP_STACK_STATUSES) {
      await seed(stack.id, status);
      const target = expectedTarget("stack.rollback", status);
      const label = `rollback from ${status}`;
      if (status !== "deleted") {
        const listed = (await h.call(h.a.token, "GET", `${root()}/${stack.id}`)).body.data.allowedActions as string[];
        expect([label, listed.includes("stack.rollback")]).toEqual([label, target !== null]);
      }
      const before = await h.counts();
      const revisionsBefore = (await revisionsOf(stack.id)).length;
      const res = await send("POST", stack.id, "/rollback", { revisionId: rev1!.id, planHash: rev1!.planHash });
      if (status === "deleted") {
        expect([label, res.status, res.body.error?.code]).toEqual([label, 404, "NOT_FOUND"]);
        expect(await h.counts(), label).toEqual(before);
      } else if (target === null) {
        expect([label, res.status, res.body.error?.code]).toEqual([label, 409, "RESOURCE_LOCKED"]);
        expect(res.body.error.details, label).toContainEqual(expect.objectContaining({ field: "status", reason: status }));
        expect(await h.counts(), label).toEqual(before);
        expect((await revisionsOf(stack.id)).length, label).toBe(revisionsBefore);
        expect((await stackRow(stack.id)).status, label).toBe(status);
      } else {
        expect([label, res.status, res.body.data?.status]).toEqual([label, 202, target]);
        expect((await stackRow(stack.id)).status, label).toBe(target);
        expect((await revisionsOf(stack.id)).length, label).toBe(revisionsBefore + 1);
      }
    }
  }, 120_000);

  it("an active operation answers 409 RESOURCE_LOCKED retryable to every queueing route, in a busy or a settled status", async () => {
    const stack = lagging.activeOp!;
    await seed(stack.id, "running");
    const plan = await send("POST", stack.id, "/plan", { templateVersionId: v2, parameters: PARAMS });
    expect(plan.status, plan.raw).toBe(200);
    const attempts: readonly (readonly [string, string, string, unknown])[] = [
      ["deploy", "POST", "/deploy", {}],
      ["start", "POST", "/start", {}],
      ["stop", "POST", "/stop", {}],
      ["restart", "POST", "/restart", {}],
      ["upgrade", "POST", "/upgrade", { templateVersionId: v2, parameters: PARAMS, planHash: plan.body.data.planHash }],
      ["delete", "DELETE", "", { confirmName: stack.name, destroyData: true }],
    ];
    // One operation in flight (a stop), with the status the request wrote, then with a status that would allow the kind.
    expect((await send("POST", stack.id, "/stop", {})).status).toBe(202);
    for (const status of ["stopping", "running"] as const) {
      await h.dbClient.db.update(appStacks).set({ status }).where(eq(appStacks.id, stack.id));
      // Issue #106: while the lock is held the detail offers nothing, whatever the status.
      expect((await h.call(h.a.token, "GET", `${root()}/${stack.id}`)).body.data.allowedActions, status).toEqual([]);
      const before = await h.counts();
      for (const [name, method, suffix, body] of attempts) {
        const res = await send(method, stack.id, suffix, body);
        expect([`${name} while ${status}`, res.status, res.body.error?.code, res.body.error?.retryable]).toEqual([
          `${name} while ${status}`,
          409,
          "RESOURCE_LOCKED",
          true,
        ]);
      }
      expect(await h.counts()).toEqual(before);
    }
    expect((await volumesOf(stack.id)).map((v) => v.retentionPolicy)).toEqual(["retain"]);

    // Rollback needs a second revision: upgrade a settled stack, then stop it, then ask for the rollback.
    const other = lagging.activeOpRollback!;
    const toV2 = { templateVersionId: v2, parameters: PARAMS };
    const hash = (await send("POST", other.id, "/plan", toV2)).body.data.planHash as string;
    expect((await send("POST", other.id, "/upgrade", { ...toV2, planHash: hash })).status).toBe(202);
    await seed(other.id, "running");
    expect((await send("POST", other.id, "/stop", {})).status).toBe(202);
    const [first] = await revisionsOf(other.id);
    const counts = await h.counts();
    for (const status of ["stopping", "running"] as const) {
      await h.dbClient.db.update(appStacks).set({ status }).where(eq(appStacks.id, other.id));
      const res = await send("POST", other.id, "/rollback", { revisionId: first!.id, planHash: first!.planHash });
      expect([`rollback while ${status}`, res.status, res.body.error?.code, res.body.error?.retryable]).toEqual([
        `rollback while ${status}`,
        409,
        "RESOURCE_LOCKED",
        true,
      ]);
    }
    expect(await h.counts()).toEqual(counts);
    // Reads stay available while the operation runs.
    expect((await h.call(h.a.token, "GET", `${root()}/${stack.id}`)).status).toBe(200);
    expect((await h.call(h.a.token, "GET", `${root()}/${stack.id}/deployments`)).status).toBe(200);
  }, 120_000);

  it("A3: a draft is created without the secret, deploy is refused until the secret is set, then it queues", async () => {
    const created = await h.call(h.a.token, "POST", root(), { templateVersionId: notes, name: "needs-secret", deploy: false }, idem());
    expect(created.status, created.raw).toBe(201);
    const stackId = created.body.data.stackId as string;
    expect((await stackRow(stackId)).status).toBe("draft");

    let before = await h.counts();
    for (const body of [{}, { parameters: [] }]) {
      expectRefusal(await send("POST", stackId, "/deploy", body), 400, "VALIDATION_ERROR", {
        field: "parameters.app_secret",
        reason: "STACK_SECRET_MISSING",
      });
    }
    expect(await h.counts()).toEqual(before);
    expect((await stackRow(stackId)).status).toBe("draft");
    expect(await revisionsOf(stackId)).toHaveLength(0);

    // The same refusal when the customer asks for a deploy at create time: nothing is written.
    expectRefusal(
      await h.call(h.a.token, "POST", root(), { templateVersionId: notes, name: "needs-secret-2", deploy: true }, idem()),
      400,
      "VALIDATION_ERROR",
      { field: "parameters.app_secret", reason: "STACK_SECRET_MISSING" },
    );
    expect(await h.counts()).toEqual(before);

    expect((await send("POST", stackId, "/secrets", { parameterKey: "app_secret", value: "first-value" })).status).toBe(200);
    before = await h.counts();
    const deploy = await send("POST", stackId, "/deploy", {});
    expect(deploy.status, deploy.raw).toBe(202);
    expect(deploy.body.data.status).toBe("queued");
    expect((await stackRow(stackId)).status).toBe("queued");
    expect(await revisionsOf(stackId)).toHaveLength(1);
    const after = await h.counts();
    expect([after.operations! - before.operations!, after.outbox_events! - before.outbox_events!]).toEqual([1, 1]);
  });

  it("B4: on a server without backups a backup or a restore is NOT_SUPPORTED in every status and writes nothing", async () => {
    const restorePath = `/backups/sbak_${"0".repeat(24)}/restore`;
    for (const status of ["draft", "running", "stopped", "failed", "deleting"] as const) {
      const stack = await stackIn(status);
      const before = await h.counts();
      for (const body of [undefined, {}]) {
        expectRefusal(await send("POST", stack.id, "/backups", body), 422, "NOT_SUPPORTED", { reason: "STACK_UNSUPPORTED_FEATURE" });
      }
      expectRefusal(await send("POST", stack.id, restorePath, { confirmName: stack.name }), 422, "NOT_SUPPORTED", {
        reason: "STACK_UNSUPPORTED_FEATURE",
      });
      // The list says the same and offers nothing.
      const listed = await send("GET", stack.id, "/backups");
      expect([status, listed.status, listed.body.data]).toEqual([status, 200, { backups: [], unavailableReason: "not_available", goBackTo: null }]);
      // What the request itself gets wrong is told first: a key the body may not carry, the missing Idempotency-Key.
      expectRefusal(await send("POST", stack.id, "/backups", { anything: true }), 400, "VALIDATION_ERROR");
      expectRefusal(await send("POST", stack.id, restorePath, {}), 400, "VALIDATION_ERROR");
      expectRefusal(await h.call(h.a.token, "POST", `${root()}/${stack.id}/backups`, {}), 400, "VALIDATION_ERROR");
      expect(await h.counts()).toEqual(before);
      expect((await stackRow(stack.id)).status).toBe(status);
    }
    const foreign = `/v1/organizations/${h.b.orgId}/app-stacks/${(await stackIn("running")).id}`;
    expectRefusal(await h.call(h.b.token, "POST", `${foreign}/backups`, {}, idem()), 404, "NOT_FOUND");
    expectRefusal(await h.call(h.b.token, "GET", `${foreign}/backups`), 404, "NOT_FOUND");
    expectRefusal(await h.call(h.b.token, "POST", `${foreign}${restorePath}`, { confirmName: "x" }, idem()), 404, "NOT_FOUND");
  });

  it("a suspended organisation reads but cannot change anything: 403 ORGANIZATION_SUSPENDED, nothing written", async () => {
    const stack = lagging.suspended!;
    const plan = await send("POST", stack.id, "/plan", { templateVersionId: v2, parameters: PARAMS });
    const [rev1] = await revisionsOf(stack.id);
    const mutations: readonly (readonly [string, string, unknown])[] = [
      ["POST", "", { templateVersionId: v1, name: "while-suspended", deploy: true, parameters: PARAMS }],
      ["POST", `/${stack.id}/deploy`, {}],
      ["POST", `/${stack.id}/start`, {}],
      ["POST", `/${stack.id}/stop`, {}],
      ["POST", `/${stack.id}/restart`, {}],
      ["POST", `/${stack.id}/upgrade`, { templateVersionId: v2, parameters: PARAMS, planHash: plan.body.data.planHash }],
      ["POST", `/${stack.id}/rollback`, { revisionId: rev1!.id, planHash: rev1!.planHash }],
      ["DELETE", `/${stack.id}`, { confirmName: stack.name, destroyData: true }],
      ["POST", `/${stack.id}/secrets`, { parameterKey: "worker_interval_seconds", value: "x" }],
      ["POST", `/${stack.id}/plan`, {}],
      ["POST", `/${stack.id}/domains`, { hostname: "suspended.example.test", componentKey: "storage", port: 6379 }],
      ["POST", `/${stack.id}/backups`, {}],
      ["POST", `/${stack.id}/backups/sbak_${"0".repeat(24)}/restore`, { confirmName: stack.name }],
    ];
    const reads: readonly string[] = [
      "",
      `/${stack.id}`,
      `/${stack.id}/deployments`,
      `/${stack.id}/components/storage/health`,
      `/${stack.id}/domains`,
      `/${stack.id}/backups`,
    ];

    await h.dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, h.a.orgId));
    try {
      const before = { ...(await h.counts()), audit_events: 0 };
      for (const [method, suffix, body] of mutations) {
        const res = await h.call(h.a.token, method, `${root()}${suffix}`, body, idem());
        expect([method, suffix, res.status, res.body.error?.code]).toEqual([method, suffix, 403, "ORGANIZATION_SUSPENDED"]);
      }
      for (const suffix of reads) {
        const res = await h.call(h.a.token, "GET", `${root()}${suffix}`);
        expect([suffix, res.status]).toEqual([suffix, 200]);
      }
      expect({ ...(await h.counts()), audit_events: 0 }).toEqual(before);
      expect((await stackRow(stack.id)).status).toBe("running");
    } finally {
      await h.dbClient.db.update(organizations).set({ status: "active" }).where(eq(organizations.id, h.a.orgId));
    }
    // Back to normal: the same stack accepts a stop again.
    expect((await send("POST", stack.id, "/stop", {})).status).toBe(202);
  }, 120_000);

  it("delete with destroyData false retains every volume, with true marks them for removal, without the flag is refused", async () => {
    const cases: readonly (readonly [string, Json])[] = [
      ["explicit false", { destroyData: false }],
      ["explicit true", { destroyData: true }],
    ];
    for (const [label, flag] of cases) {
      const stack = await stackIn("running");
      const res = await send("DELETE", stack.id, "", { confirmName: stack.name, ...flag });
      expect([label, res.status]).toEqual([label, 202]);
      const expected = flag.destroyData === true ? "destroy" : "retain";
      expect([label, (await volumesOf(stack.id)).map((v) => [v.volumeKey, v.retentionPolicy])]).toEqual([label, [["data", expected]]]);
      expect((await stackRow(stack.id)).status).toBe("deleting");
    }
    // A wrong name, or a name of different case, changes neither the status nor the data; the flag must be stated.
    const stack = await stackIn("running");
    const before = await h.counts();
    expectRefusal(await send("DELETE", stack.id, "", { confirmName: stack.name }), 400, "VALIDATION_ERROR");
    expectRefusal(await send("DELETE", stack.id, "", { confirmName: stack.name, destroyData: "yes" }), 400, "VALIDATION_ERROR");
    for (const confirmName of ["", stack.name.toUpperCase(), `${stack.name} `]) {
      expectRefusal(await send("DELETE", stack.id, "", { confirmName, destroyData: true }), 400, "VALIDATION_ERROR", {
        field: "confirmName",
      });
    }
    expect(await h.counts()).toEqual(before);
    expect((await volumesOf(stack.id)).map((v) => v.retentionPolicy)).toEqual(["retain"]);
  });
});

describe("application stacks with the capability off: every stack and domain route (QA M4)", () => {
  it("answers 422 NOT_SUPPORTED, including plan, upgrade, rollback and the domain routes, and writes nothing", async () => {
    const off = await startAppStackHarness({ appFeatures: {} });
    try {
      const before = await off.counts();
      const base = `/v1/organizations/${off.a.orgId}/app-stacks`;
      const stackId = "stk_0123456789abcdef01234567";
      const domainId = "sdm_0123456789abcdef01234567";
      const routes: readonly (readonly [string, string, unknown?])[] = [
        ["POST", base, { templateVersionId: "atv_x", name: "x", deploy: false }],
        ["GET", base],
        ["GET", `${base}/${stackId}`],
        ["POST", `${base}/${stackId}/plan`, {}],
        ["POST", `${base}/${stackId}/deploy`, {}],
        ["POST", `${base}/${stackId}/start`, {}],
        ["POST", `${base}/${stackId}/stop`, {}],
        ["POST", `${base}/${stackId}/restart`, {}],
        ["POST", `${base}/${stackId}/upgrade`, { templateVersionId: "atv_x", planHash: "a".repeat(64) }],
        ["POST", `${base}/${stackId}/rollback`, { revisionId: "srev_x", planHash: "a".repeat(64) }],
        ["DELETE", `${base}/${stackId}`, { confirmName: "x", destroyData: false }],
        ["GET", `${base}/${stackId}/deployments`],
        ["GET", `${base}/${stackId}/components/app/logs`],
        ["GET", `${base}/${stackId}/components/app/health`],
        ["POST", `${base}/${stackId}/secrets`, { parameterKey: "app_secret", value: "v" }],
        ["GET", `${base}/${stackId}/backups`],
        ["POST", `${base}/${stackId}/backups`, {}],
        ["POST", `${base}/${stackId}/backups/sbak_0123456789abcdef01234567/restore`, { confirmName: "x" }],
        ["GET", `${base}/${stackId}/domains`],
        ["POST", `${base}/${stackId}/domains`, { hostname: "off.example.test", componentKey: "app", port: 8080 }],
        ["DELETE", `${base}/${stackId}/domains/${domainId}`, {}],
        ["POST", `${base}/${stackId}/domains/${domainId}/check`, {}],
      ];
      expect(routes).toHaveLength(22);
      for (const [method, path, body] of routes) {
        const res = await off.call(off.a.token, method, path, body, { "Idempotency-Key": randomUUID() });
        expect([method, path, res.status, res.body.error?.code]).toEqual([method, path, 422, "NOT_SUPPORTED"]);
        expect(res.body.error.details, `${method} ${path}`).toContainEqual(expect.objectContaining({ reason: "STACK_UNSUPPORTED_FEATURE" }));
      }
      expect(await off.counts()).toEqual(before);
    } finally {
      await off.close();
    }
  }, 120_000);
});
