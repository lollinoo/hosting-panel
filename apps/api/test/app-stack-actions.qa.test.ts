// Issue #106: the detail says which actions the API accepts now, from what the enqueue decides with (the stored status,
// the lock, the transition table, the caller's permissions), never from the status the page shows. A crashed component
// shows `failed` while the stored status stays `running`: the page must offer what brings it back, and only that.
import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST, ApprovedStackPlanSchema } from "@hosting-panel/contracts";
import {
  appStackComponents,
  appStackRevisions,
  appStacks,
  asc,
  eq,
  operations,
  organizations,
  recordAppStackComponentHealthTransactional,
  resourceQuotas,
  rolePermissions,
  roles,
} from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appStackHealthRows } from "../src/app-stacks/app-stack-runtime-policy.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** storage (volume `data`) <- worker: the storage is essential, its crash shows the application failed. */
const BASE = APP_BUILT_IN_TEMPLATES[1]!.source;
/** The same with a task on its store (ADR-0042). */
const WITH_TASK = `${BASE.trimEnd()}
x-hp-tasks:
  - key: save
    label: Salva i dati adesso
    service: storage
    command: ["valkey-cli", "BGSAVE"]
`;
/** What a settled application whose stored status is `running` or `degraded` allows its owner, backups included. */
const LIVE = ["stack.deploy", "stack.stop", "stack.restart", "stack.upgrade", "stack.rollback", "stack.delete", "stack.backup", "stack.restore"];

describe("the actions an application offers are the ones the API accepts (issue #106)", () => {
  let h: AppStackHarness;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const path = (stackId: string, verb = "") => `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}${verb === "" ? "" : `/${verb}`}`;
  const act = (who: HarnessCustomer, stackId: string, verb: "start" | "stop" | "restart") =>
    h.call(who.token, "POST", path(stackId, verb), {}, { "Idempotency-Key": randomUUID() });
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = (stackId: string) =>
    h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId)).orderBy(asc(operations.submittedAt));
  async function detail(stackId: string, who: HarnessCustomer = h.a): Promise<Json> {
    const res = await h.call(who.token, "GET", path(stackId));
    expect(res.status, res.raw).toBe(200);
    return res.body.data as Json;
  }

  async function drain(stackId: string): Promise<void> {
    const worker = h.app.nestApp.get(OutboxWorkerService);
    for (let round = 0; round < 10; round += 1) {
      await worker.processPendingOnce();
      const open = (await opsOf(stackId)).filter((o) => ["queued", "running"].includes(o.status));
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  async function install(source: string = BASE): Promise<string> {
    const { versionId } = await h.publish(source);
    const res = await h.call(
      h.a.token,
      "POST",
      `/v1/organizations/${h.a.orgId}/app-stacks`,
      { templateVersionId: versionId, name: `app-${randomUUID().slice(0, 8)}`, deploy: true },
      { "Idempotency-Key": randomUUID() },
    );
    expect(res.status, res.raw).toBe(202);
    const stackId = res.body.data.stackId as string;
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("running");
    return stackId;
  }

  /** One observation of what runs, recorded as the observer's pass does. */
  async function observe(stackId: string): Promise<void> {
    const [rev] = await h.dbClient.db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId));
    await recordAppStackComponentHealthTransactional(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId,
      observedAt: new Date(),
      components: appStackHealthRows(
        ApprovedStackPlanSchema.parse(rev!.plan),
        await h.sim.appStacks.getAppStackStatus({ stackId, organizationId: h.a.orgId }),
        "observer",
      ),
    });
  }

  it("a crashed essential component: the page reads failed, start is not offered and is refused, restart is offered and brings it back", async () => {
    const stackId = await install();
    await observe(stackId);
    const ready = await detail(stackId);
    expect([ready.status, ready.allowedActions, ready.outcomeUnknown]).toEqual(["running", LIVE, false]);

    h.sim.appStacks.crashAppStackComponent(stackId, "storage");
    await observe(stackId);
    const crashed = await detail(stackId);
    // The page shows what runs; the API decides from what is stored, which no crash changes.
    expect(crashed.status).toBe("failed");
    expect((await stackRow(stackId)).status).toBe("running");
    expect(crashed.allowedActions).toEqual(LIVE);
    expect(crashed.outcomeUnknown).toBe(false);

    // The action the list leaves out is refused, naming the stored status (the page explains it without contradiction).
    const start = await act(h.a, stackId, "start");
    expect([start.status, start.body.error?.code]).toEqual([409, "RESOURCE_LOCKED"]);
    expect(start.body.error.details).toContainEqual(expect.objectContaining({ field: "status", reason: "running" }));

    const restart = await act(h.a, stackId, "restart");
    expect(restart.status, restart.raw).toBe(202);
    // While it runs nothing is offered: every request would meet the lock.
    expect((await detail(stackId)).allowedActions).toEqual([]);
    await drain(stackId);

    expect(h.sim.appStacks.getAppStackSnapshot(stackId)!.containers.storage?.state).toBe("running");
    expect((await stackRow(stackId)).status).toBe("running");
    const back = await detail(stackId);
    expect([back.status, back.allowedActions]).toEqual(["running", LIVE]);
  });

  it("a stale reading shows unknown without an operation in doubt; an operation in doubt says so; each offers what the API accepts", async () => {
    const stackId = await install();
    await observe(stackId);
    await h.dbClient.db
      .update(appStackComponents)
      .set({ healthObservedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(appStackComponents.stackId, stackId));
    const stale = await detail(stackId);
    expect([stale.status, stale.outcomeUnknown, stale.allowedActions]).toEqual(["unknown", false, LIVE]);
    const start = await act(h.a, stackId, "start");
    expect([start.status, start.body.error?.details?.[0]?.reason]).toEqual([409, "running"]);

    // An operation whose outcome is not known parks the stored status as `unknown` (ADR-0035 §2.10).
    await h.dbClient.db.update(appStacks).set({ status: "unknown" }).where(eq(appStacks.id, stackId));
    const doubt = await detail(stackId);
    expect([doubt.status, doubt.outcomeUnknown]).toEqual(["unknown", true]);
    expect(doubt.allowedActions).toEqual(["stack.deploy", "stack.start", "stack.stop", "stack.restart", "stack.upgrade", "stack.rollback", "stack.delete"]);
  });

  it("a task run is shown while it waits and while it runs; only a running one empties the list, as the routes answer", async () => {
    const stackId = await install(WITH_TASK);
    const worker = h.app.nestApp.get(OutboxWorkerService);
    const runTask = async (): Promise<{ runId: string; operationId: string }> => {
      const res = await h.call(h.a.token, "POST", `${path(stackId, "tasks")}/save/runs`, {}, { "Idempotency-Key": randomUUID() });
      expect(res.status, res.raw).toBe(202);
      return res.body.data as { runId: string; operationId: string };
    };
    const opOf = async (id: string) => (await opsOf(stackId)).find((o) => o.id === id)!;

    // A run that has started holds the application's own lock: nothing is offered and a stop meets the lock.
    h.sim.appStackTasks.failNextAppStackTaskStep("run", "ambiguous_running");
    const going = await runTask();
    await worker.processPendingOnce();
    expect(await opOf(going.operationId)).toMatchObject({ lockKey: `stack:${stackId}` });
    const held = await detail(stackId);
    expect([held.activeOperationId, held.allowedActions]).toEqual([going.operationId, []]);
    const refused = await act(h.a, stackId, "stop");
    expect([refused.status, refused.body.error?.code]).toEqual([409, "RESOURCE_LOCKED"]);
    h.sim.appStackTasks.settleAppStackTaskRun(going.runId);
    await worker.recoverUnknownOperations();
    expect((await opOf(going.operationId)).status).toBe("succeeded");
    expect((await detail(stackId)).allowedActions).toEqual(LIVE);

    // A run that waits for its lane holds a lock of its own, which no action of the application reads: the page follows
    // it, and the list is the one without it.
    const waiting = await runTask();
    expect(await opOf(waiting.operationId)).toMatchObject({ status: "queued", lockKey: `stack:${stackId}:task` });
    const queued = await detail(stackId);
    expect([queued.activeOperationId, queued.allowedActions]).toEqual([waiting.operationId, LIVE]);
    const stop = await act(h.a, stackId, "stop");
    expect(stop.status, stop.raw).toBe(202);
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("stopped");
    expect((await opOf(waiting.operationId)).status).toBe("failed");
  });

  it("the list is the caller's: a reader gets none, an editor only what app.update allows, a suspended organisation none", async () => {
    const stackId = await install();
    await h.dbClient.db.insert(roles).values([
      { id: "role_app_reader_106", name: "app_reader_106" as never, description: "Read only", isPreset: false },
      { id: "role_app_editor_106", name: "app_editor_106" as never, description: "Read and change", isPreset: false },
    ]);
    await h.dbClient.db.insert(rolePermissions).values([
      { roleId: "role_app_reader_106", permissionKey: "app.read" },
      { roleId: "role_app_editor_106", permissionKey: "app.read" },
      { roleId: "role_app_editor_106", permissionKey: "app.update" },
    ]);
    const reader = await h.addMember(h.a.orgId, "role_app_reader_106" as "role_customer_collaborator");
    const editor = await h.addMember(h.a.orgId, "role_app_editor_106" as "role_customer_collaborator");
    expect((await detail(stackId, reader)).allowedActions).toEqual([]);
    expect((await detail(stackId, editor)).allowedActions).toEqual(["stack.upgrade", "stack.rollback"]);
    // What the editor is not offered, the API refuses it.
    expect((await act(editor, stackId, "restart")).status).toBe(403);
    // Another organisation reads nothing of it.
    expect((await h.call(h.b.token, "GET", path(stackId))).status).toBe(404);

    // A suspended organisation still reads its application, and is offered nothing: every change is refused.
    await h.dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, h.a.orgId));
    try {
      expect((await detail(stackId)).allowedActions).toEqual([]);
      expect((await act(h.a, stackId, "stop")).body.error?.code).toBe("ORGANIZATION_SUSPENDED");
    } finally {
      await h.dbClient.db.update(organizations).set({ status: "active" }).where(eq(organizations.id, h.a.orgId));
    }
    expect((await detail(stackId)).allowedActions).toEqual(LIVE);
  });
});
