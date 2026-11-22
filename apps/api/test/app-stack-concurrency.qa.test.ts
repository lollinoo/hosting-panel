import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  and,
  appStackDeployments,
  appStacks,
  asc,
  enqueueOperationTransactional,
  eq,
  isNull,
  operations,
  outboxEvents,
  resourceQuotas,
  settleOperation,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

// Images of the code allowlist only: the runtime refuses anything else at its validate step.
const WEB_SOURCE = APP_BUILT_IN_TEMPLATES[0]!.source;

type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

/** Q3: the stack lane under concurrency (A16, the runtime part of B2, one lock per stack, one lane for all stacks). */
describe("application stacks under concurrency (Q3: A16, B2 runtime, lock, lane)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let web: string;
  const opened: (() => void)[] = [];

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    web = (await h.publish(WEB_SOURCE)).versionId;
  }, 120_000);

  afterEach(() => {
    // A test that failed while a deploy was held must not leave the worker hanging.
    for (const open of opened.splice(0)) open();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await h?.close();
  });

  const worker = () => h.app.nestApp.get(OutboxWorkerService);
  const base = (c: HarnessCustomer) => `/v1/organizations/${c.orgId}/app-stacks`;
  const idem = (key: string = randomUUID()) => ({ "Idempotency-Key": key });
  const create = (c: HarnessCustomer, body: Record<string, unknown>, key?: string) => h.call(c.token, "POST", base(c), body, idem(key));
  const act = (c: HarnessCustomer, stackId: string, verb: string, body: unknown = {}, key?: string) =>
    h.call(c.token, "POST", `${base(c)}/${stackId}/${verb}`, body, idem(key));
  const name = () => `app-${randomUUID().slice(0, 8)}`;

  async function draft(c: HarnessCustomer = h.a): Promise<string> {
    const res = await create(c, { templateVersionId: web, name: name(), deploy: false });
    expect(res.status, res.raw).toBe(201);
    return res.body.data.stackId as string;
  }

  const opsOf = (stackId: string) =>
    h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId)).orderBy(asc(operations.submittedAt));
  const deploymentsOf = (stackId: string) =>
    h.dbClient.db.select().from(appStackDeployments).where(eq(appStackDeployments.stackId, stackId));
  const outboxOf = async (stackId: string) =>
    (await h.dbClient.db.select().from(outboxEvents)).filter((e) => (e.payload as { stackId?: string }).stackId === stackId);
  async function stackRow(stackId: string) {
    return (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  }
  const opStatus = async (id: string) => (await h.dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!.status;

  /** The worker until no operation of the stack is open. */
  async function drain(stackId: string): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await worker().processPendingOnce();
      if ((await opsOf(stackId)).every((o) => !["queued", "processing", "running"].includes(o.status))) return;
    }
    throw new Error("the operation never settled");
  }

  /** PGlite runs one transaction at a time: holding one parks both requests, which then read before either writes. */
  async function sentTogether<T>(requests: readonly [() => Promise<T>, () => Promise<T>]): Promise<[T, T]> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = h.dbClient.db.transaction(async () => held);
    const pending = [requests[0](), requests[1]()] as const;
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    await gate;
    return Promise.all(pending);
  }

  /** What the executor was asked about one stack, in order. */
  const callsOf = (stackId: string) =>
    sim.appStacks.appStackCalls.filter((c) => c.stackId === stackId).map((c) => `${c.method}:${c.componentKey ?? ""}`);
  /** What the simulator did to one stack, in order, with the stack id left out. */
  const mutationsOf = (stackId: string) =>
    sim.appStacks.appStackMutations.filter((m) => m.name.includes(stackId)).map((m) => `${m.kind}:${m.name.replaceAll(stackId, "<stack>")}`);
  const stackIdsSeen = () => new Set(sim.appStacks.appStackCalls.map((c) => c.stackId));

  /** Holds `prepareAppStack` of the given stacks: the deploy sits there, as a deploy waiting on Docker would. */
  function hold(stackIds: readonly string[]): { reached: Promise<string>; release: () => void } {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    opened.push(release);
    let reach!: (stackId: string) => void;
    const reached = new Promise<string>((resolve) => (reach = resolve));
    const original = sim.appStacks.prepareAppStack.bind(sim.appStacks);
    vi.spyOn(sim.appStacks, "prepareAppStack").mockImplementation(async (req) => {
      if (stackIds.includes(req.plan.stackId)) {
        reach(req.plan.stackId);
        await gate;
      }
      return original(req);
    });
    return { reached, release };
  }

  async function until(check: () => Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  describe("A16: the same Idempotency-Key twice", () => {
    it("create+deploy: replayed before and after the run, and sent together, gives one stack, one operation, one deployment", async () => {
      const key = randomUUID();
      const body = { templateVersionId: web, name: name(), deploy: true };
      const before = await h.counts();
      const [x, y] = await sentTogether([() => create(h.a, body, key), () => create(h.a, body, key)]);
      expect([x.status, y.status], `${x.raw} ${y.raw}`).toEqual([202, 202]);
      expect(y.body).toEqual(x.body);
      const { stackId, operationId, deploymentId } = x.body.data as { stackId: string; operationId: string; deploymentId: string };

      const added = await h.counts();
      expect([added.app_stacks! - before.app_stacks!, added.operations! - before.operations!, added.outbox_events! - before.outbox_events!]).toEqual([
        1, 1, 1,
      ]);
      expect(await opsOf(stackId)).toHaveLength(1);
      expect(await deploymentsOf(stackId)).toHaveLength(1);
      expect(await outboxOf(stackId)).toHaveLength(1);
      expect(await h.dbClient.db.select().from(operations).where(eq(operations.id, operationId))).toHaveLength(1);

      const replayed = await create(h.a, body, key);
      expect(replayed.status).toBe(202);
      expect(replayed.body).toEqual(x.body);

      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("running");

      // A replay after the deploy has finished still answers the first answer and starts nothing.
      const late = await create(h.a, body, key);
      expect(late.status, late.raw).toBe(202);
      expect(late.body.data).toMatchObject({ stackId, operationId, deploymentId });
      await drain(stackId);
      expect(await opsOf(stackId)).toHaveLength(1);
      expect(await deploymentsOf(stackId)).toHaveLength(1);
      expect((await deploymentsOf(stackId))[0]).toMatchObject({ id: deploymentId, status: "succeeded" });
      expect((await h.counts()).app_stacks).toBe(added.app_stacks);
    });

    it("the executor sees the calls of one deploy, not two: the same as a stack deployed once with a fresh key", async () => {
      const key = randomUUID();
      const control = (await create(h.a, { templateVersionId: web, name: name(), deploy: true })).body.data.stackId as string;
      const body = { templateVersionId: web, name: name(), deploy: true };
      const [x] = await sentTogether([() => create(h.a, body, key), () => create(h.a, body, key)]);
      const replayed = x.body.data.stackId as string;
      await create(h.a, body, key);
      await drain(control);
      await drain(replayed);

      expect(callsOf(control).length).toBeGreaterThan(0);
      expect(callsOf(replayed)).toEqual(callsOf(control));
      expect(mutationsOf(replayed)).toEqual(mutationsOf(control));
      // Every component was created and started exactly once.
      const creates = mutationsOf(replayed).filter((m) => m.startsWith("container_create:"));
      expect(new Set(creates).size).toBe(creates.length);
      const starts = mutationsOf(replayed).filter((m) => m.startsWith("container_start:"));
      expect(new Set(starts).size).toBe(starts.length);
      expect(callsOf(replayed).filter((c) => c.startsWith("createAppStackComponents:"))).toHaveLength(1);
      expect(callsOf(replayed).filter((c) => c.startsWith("publishAppStackRoutes:"))).toEqual(callsOf(control).filter((c) => c.startsWith("publishAppStackRoutes:")));
    });

    it.each(["deploy", "stop", "restart"] as const)("%s of an existing stack: two requests with one key are one operation", async (verb) => {
      const stackId = await draft();
      expect((await act(h.a, stackId, "deploy")).status).toBe(202);
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("running");
      const opsBefore = (await opsOf(stackId)).length;

      const key = randomUUID();
      const [x, y] = await sentTogether([() => act(h.a, stackId, verb, {}, key), () => act(h.a, stackId, verb, {}, key)]);
      expect([x.status, y.status], `${x.raw} ${y.raw}`).toEqual([202, 202]);
      expect(y.body).toEqual(x.body);
      expect((await opsOf(stackId)).length - opsBefore).toBe(1);
      expect((await outboxOf(stackId)).filter((e) => e.status === "pending")).toHaveLength(1);

      const calls = sim.appStacks.appStackCalls.length;
      await drain(stackId);
      // One operation ran; a second drain finds nothing to run.
      const after = sim.appStacks.appStackCalls.length;
      await drain(stackId);
      expect(sim.appStacks.appStackCalls.length).toBe(after);
      expect(after).toBeGreaterThan(calls);
      expect((await opsOf(stackId)).length - opsBefore).toBe(1);
    });

    it("the same key with another request is IDEMPOTENCY_CONFLICT while the first operation is running, and starts nothing", async () => {
      const stackId = await draft();
      const key = randomUUID();
      const first = await act(h.a, stackId, "deploy", {}, key);
      expect(first.status, first.raw).toBe(202);
      const { reached, release } = hold([stackId]);
      const running = worker().processPendingOnce();
      await reached;

      const replay = await act(h.a, stackId, "deploy", {}, key);
      expect(replay.status, replay.raw).toBe(202);
      // The answer names the same operation and deployment; its status is the live one.
      expect(replay.body.data).toMatchObject({ stackId, operationId: first.body.data.operationId, deploymentId: first.body.data.deploymentId });
      const other = await act(h.a, stackId, "stop", {}, key);
      expect(other.status, other.raw).toBe(409);
      expect(other.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
      expect(await opsOf(stackId)).toHaveLength(1);
      expect(await deploymentsOf(stackId)).toHaveLength(1);

      release();
      await running;
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("running");
    });
  });

  describe("B2, runtime part: two creates at a limit of one", () => {
    it("one is queued and processed, the other is refused, and the executor sees exactly one stack", async () => {
      const limit = await h.call(h.adminToken, "PATCH", `/v1/admin/organizations/${h.b.orgId}/app-stack-limit`, { maxAppStacks: 1 });
      expect(limit.status, limit.raw).toBe(200);
      const seenBefore = stackIdsSeen();

      const [x, y] = await sentTogether([
        () => create(h.b, { templateVersionId: web, name: "first", deploy: true }),
        () => create(h.b, { templateVersionId: web, name: "second", deploy: true }),
      ]);
      expect([x.status, y.status].sort(), `${x.raw} ${y.raw}`).toEqual([202, 409]);
      const [accepted, refused] = x.status === 202 ? [x, y] : [y, x];
      expect(refused.body.error.code).toBe("QUOTA_EXCEEDED");
      expect(refused.body.error.details).toContainEqual(expect.objectContaining({ reason: "STACK_QUOTA_EXCEEDED" }));
      const stackId = accepted.body.data.stackId as string;

      // The refusal wrote nothing: one stack row, one operation, one outbox row, one deployment for the organisation.
      const live = await h.dbClient.db
        .select()
        .from(appStacks)
        .where(and(eq(appStacks.organizationId, h.b.orgId), isNull(appStacks.deletedAt)));
      expect(live.map((s) => s.id)).toEqual([stackId]);
      const orgOps = await h.dbClient.db.select().from(operations).where(eq(operations.organizationId, h.b.orgId));
      expect(orgOps.filter((o) => o.kind.startsWith("stack."))).toHaveLength(1);
      expect(await outboxOf(stackId)).toHaveLength(1);
      expect(await deploymentsOf(stackId)).toHaveLength(1);

      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("running");
      const fresh = [...stackIdsSeen()].filter((id) => !seenBefore.has(id));
      expect(fresh).toEqual([stackId]);

      // The limit holds while the stack runs, and a delete gives the place back.
      const again = await create(h.b, { templateVersionId: web, name: "third", deploy: true });
      expect(again.status, again.raw).toBe(409);
      expect(again.body.error.code).toBe("QUOTA_EXCEEDED");
      const removed = await h.call(h.b.token, "DELETE", `${base(h.b)}/${stackId}`, { confirmName: live[0]!.name, destroyData: false }, idem());
      expect(removed.status, removed.raw).toBe(202);
      await drain(stackId);
      const reborn = await create(h.b, { templateVersionId: web, name: "fourth", deploy: true });
      expect(reborn.status, reborn.raw).toBe(202);
    });
  });

  describe("one lock per stack", () => {
    it("two deploys of one stack sent together: one is queued, the other is 409 RESOURCE_LOCKED, and only one runs", async () => {
      const stackId = await draft();
      const [x, y] = await sentTogether([() => act(h.a, stackId, "deploy"), () => act(h.a, stackId, "deploy")]);
      expect([x.status, y.status].sort(), `${x.raw} ${y.raw}`).toEqual([202, 409]);
      const refused = x.status === 409 ? x : y;
      expect(refused.body.error.code).toBe("RESOURCE_LOCKED");
      expect(refused.body.error.retryable).toBe(true);
      expect(await opsOf(stackId)).toHaveLength(1);
      expect(await deploymentsOf(stackId)).toHaveLength(1);
      expect(await outboxOf(stackId)).toHaveLength(1);
      expect(await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId))).toHaveLength(1);

      await drain(stackId);
      expect(await stackRow(stackId)).toMatchObject({ status: "running" });
      expect(callsOf(stackId).filter((c) => c.startsWith("createAppStackComponents:"))).toHaveLength(1);
    });

    it("while a deploy is running every other action on that stack is refused with 409 RESOURCE_LOCKED, and the lock is released after", async () => {
      const stackId = await draft();
      expect((await act(h.a, stackId, "deploy")).status).toBe(202);
      const { reached, release } = hold([stackId]);
      const running = worker().processPendingOnce();
      await reached;
      expect(await opStatus((await opsOf(stackId))[0]!.id)).not.toBe("queued");

      const attempts: readonly [string, () => Promise<Reply>][] = [
        ["deploy", () => act(h.a, stackId, "deploy")],
        ["start", () => act(h.a, stackId, "start")],
        ["stop", () => act(h.a, stackId, "stop")],
        ["restart", () => act(h.a, stackId, "restart")],
        ["delete", () => h.call(h.a.token, "DELETE", `${base(h.a)}/${stackId}`, { confirmName: "x", destroyData: false }, idem())],
      ];
      for (const [label, attempt] of attempts) {
        const res = await attempt();
        // A confirmation typo is a validation error whatever the lock says; the others must hit the lock.
        if (label === "delete") expect([400, 409], res.raw).toContain(res.status);
        else {
          expect(res.status, `${label}: ${res.raw}`).toBe(409);
          expect(res.body.error.code, label).toBe("RESOURCE_LOCKED");
        }
      }
      expect(await opsOf(stackId)).toHaveLength(1);
      expect(await deploymentsOf(stackId)).toHaveLength(1);

      release();
      await running;
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("running");
      // Released: the next action is accepted.
      const stop = await act(h.a, stackId, "stop");
      expect(stop.status, stop.raw).toBe(202);
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("stopped");
    });

    it("the lock of one stack does not hold another stack of the same organisation", async () => {
      const [one, two] = [await draft(), await draft()];
      expect((await act(h.a, one, "deploy")).status).toBe(202);
      const { reached, release } = hold([one]);
      const running = worker().processPendingOnce();
      await reached;
      const other = await act(h.a, two, "deploy");
      expect(other.status, other.raw).toBe(202);
      release();
      await running;
      await drain(two);
      await drain(one);
      expect([(await stackRow(one)).status, (await stackRow(two)).status]).toEqual(["running", "running"]);
    });
  });

  describe("the stack lane", () => {
    it("two stacks queued together run one after the other: the second does not start before the first is finished", async () => {
      const [one, two] = [await draft(), await draft()];
      expect((await act(h.a, one, "deploy")).status).toBe(202);
      expect((await act(h.a, two, "deploy")).status).toBe(202);
      const { reached, release } = hold([one, two]);

      const running = worker().processPendingOnce();
      const first = await reached;
      const second = first === one ? two : one;
      // While the first is held the second has not been touched: still queued, no executor call about it.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await opStatus((await opsOf(second))[0]!.id)).toBe("queued");
      expect(callsOf(second)).toEqual([]);
      expect(await opStatus((await opsOf(first))[0]!.id)).not.toBe("queued");

      release();
      const result = await running;
      expect(result).toMatchObject({ claimed: 2, succeeded: 2, failed: 0 });
      expect([(await stackRow(one)).status, (await stackRow(two)).status]).toEqual(["running", "running"]);

      // No interleaving: the calls of the first stack all come before the first call of the second.
      const order = sim.appStacks.appStackCalls.map((c) => c.stackId).filter((id) => id === one || id === two);
      expect(order.indexOf(second)).toBeGreaterThan(order.lastIndexOf(first));
      expect(order.filter((id) => id === first).length).toBeGreaterThan(0);
      expect(callsOf(second)).toEqual(callsOf(first));
    });

    it("a stack that fails does not stop the next stack of the lane", async () => {
      const [one, two] = [await draft(), await draft()];
      expect((await act(h.a, one, "deploy")).status).toBe(202);
      expect((await act(h.a, two, "deploy")).status).toBe(202);
      sim.appStacks.failNextAppStackStep("pull", "pull_failed");

      const result = await worker().processPendingOnce();
      await drain(one);
      await drain(two);

      expect(result.claimed).toBe(2);
      const statuses = [(await stackRow(one)).status, (await stackRow(two)).status].sort();
      expect(statuses).toEqual(["failed", "running"]);
    });

    it("a site operation queued while a stack deploy is running is processed before the deploy ends", async () => {
      const stackId = await draft();
      expect((await act(h.a, stackId, "deploy")).status).toBe(202);
      const siteApply = vi.fn(async (op: { id: string }) => {
        await settleOperation(h.dbClient.db, op.id, { status: "succeeded" });
      });
      vi.spyOn((worker() as unknown as { siteDomainsApplier: { apply: typeof siteApply } }).siteDomainsApplier, "apply").mockImplementation(siteApply);
      const { reached, release } = hold([stackId]);

      const first = worker().processPendingOnce();
      await reached;
      const deployOp = (await opsOf(stackId))[0]!;
      expect(await opStatus(deployOp.id)).not.toBe("queued");

      // The site operation is queued in between, and the worker is polled again as its timer would.
      const siteId = randomUUID();
      const { operation: site } = await enqueueOperationTransactional(h.dbClient.db, {
        organizationId: h.a.orgId,
        kind: "site.domains",
        resourceType: "site",
        resourceId: siteId,
        lockKey: `site:${siteId}`,
        idempotencyKey: `site-${randomUUID()}`,
        outboxPayload: { siteId },
        steps: [{ key: "apply", label: "Apply" }],
      });
      const second = worker().processPendingOnce();
      await until(async () => (await opStatus(site.id)) === "succeeded", "the site operation");

      // The deploy is still held: the site operation did not wait for it.
      expect(siteApply).toHaveBeenCalledTimes(1);
      expect(["processing", "running"]).toContain(await opStatus(deployOp.id));
      expect(callsOf(stackId).some((c) => c.startsWith("createAppStackComponents"))).toBe(false);

      release();
      await Promise.all([first, second]);
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("running");
      expect(await opStatus(site.id)).toBe("succeeded");
    });
  });
});
