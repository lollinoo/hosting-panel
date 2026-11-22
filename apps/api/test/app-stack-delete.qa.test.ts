import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  and,
  appStackComponents,
  appStackDomains,
  appStacks,
  appStackSecrets,
  appStackVolumes,
  auditEvents,
  eq,
  operations,
  resourceQuotas,
} from "@hosting-panel/database";
import type { AppStackSimFault, AppStackSimStep, InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

// A18 (arch-runtime §14 Q4, spec §10.4): delete without the data flag removes routes, containers and networks and keeps
// the data as `retained` with its secret rows; with the flag the data is removed and the secrets purged; a delete in
// doubt keeps the stack `deleting` with lock and quota until recovery; a `delete_failed` stack can be deleted again.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Sim = InMemoryDockerSimulatorAdapter;

/** The built-in web site (images on the code allowlist) plus a data volume and a secret, so every kind of data exists. */
const DATA_SOURCE = APP_BUILT_IN_TEMPLATES[0]!.source
  .replace(
    "x-hp-parameters:\n",
    "x-hp-parameters:\n  - key: app_secret\n    label: Application secret\n    type: secret\n    required: true\n    customer: true\n",
  )
  .replace(
    "    expose:\n      - 8080\n",
    "    volumes:\n      - data:/data\n    environment:\n      - name: APP_SECRET_FILE\n        secret: app_secret\n    expose:\n      - 8080\n",
  )
  .concat("volumes:\n  data: {}\n");
/** The built-in storage template: a volume but no secret. */
const STORAGE_SOURCE = APP_BUILT_IN_TEMPLATES[1]!.source;

describe("application stacks delete and data retention (Q4: A18)", () => {
  let h: AppStackHarness;
  let sim: Sim;
  let worker: OutboxWorkerService;
  let data: string;
  let storage: string;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    sim = h.app.nestApp.get<Sim>(DOCKER_EXECUTOR_TOKEN);
    worker = h.app.nestApp.get(OutboxWorkerService);
    data = (await h.publish(DATA_SOURCE)).versionId;
    storage = (await h.publish(STORAGE_SOURCE)).versionId;
    // The DNS pass is not under test here: a domain write must not look anything up.
    vi.spyOn(h.app.nestApp.get(AppStackObserverService), "reconcileStack").mockResolvedValue(undefined);
  }, 120_000);

  afterEach(() => {
    sim.appStacks.appStackMutations.length = 0;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.close();
  }, 60_000);

  const path = (stackId = "", tail = "") => `/v1/organizations/${h.a.orgId}/app-stacks${stackId ? `/${stackId}` : ""}${tail}`;
  const idem = () => ({ "Idempotency-Key": randomUUID() });
  const act = (stackId: string, verb: string) => h.call(h.a.token, "POST", path(stackId, `/${verb}`), {}, idem());
  const del = (stackId: string, name: string, destroyData: boolean) =>
    h.call(h.a.token, "DELETE", path(stackId), { confirmName: name, destroyData }, idem());
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = (stackId: string) => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
  const volumesOf = (stackId: string) => h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId));
  const secretsOf = (stackId: string) => h.dbClient.db.select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId));
  const componentsOf = (stackId: string) => h.dbClient.db.select().from(appStackComponents).where(eq(appStackComponents.stackId, stackId));
  const domainsOf = (stackId: string) => h.dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId));
  /** The simulator forgets a stack whose last resource is gone: no snapshot then means nothing is left. */
  const engine = (stackId: string) =>
    sim.appStacks.getAppStackSnapshot(stackId) ?? { containers: {}, networks: {}, volumes: {}, routes: [] };
  const mutations = (stackId: string) =>
    sim.appStacks.appStackMutations.filter((m) => m.name.includes(stackId)).map((m) => m.kind);
  const stackCalls = (stackId: string) => sim.appStacks.appStackCalls.filter((c) => c.stackId === stackId).map((c) => c.method);
  const lastOp = async (stackId: string) => (await opsOf(stackId)).filter((o) => o.kind === "stack.delete").at(-1)!;
  async function quota() {
    const [row] = await h.dbClient.db.select().from(resourceQuotas).where(eq(resourceQuotas.organizationId, h.a.orgId));
    return { services: row!.usedServices, cpu: row!.usedCpuMilli, memory: row!.usedMemoryBytes };
  }
  const expireLease = (operationId: string) =>
    h.dbClient.db.update(operations).set({ leaseExpiresAt: new Date(Date.now() - 1_000) }).where(eq(operations.id, operationId));

  async function drain(stackId: string): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
      await worker.processPendingOnce();
      const open = (await opsOf(stackId)).filter((o) => ["queued", "running", "processing"].includes(o.status));
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  /** A running stack with a secret, a data volume and a published web address (the web template), or a storage stack. */
  async function running(kind: "data" | "storage" = "data"): Promise<{ stackId: string; name: string; host: string | null }> {
    const name = `del-${randomUUID().slice(0, 8)}`;
    const created = await h.call(h.a.token, "POST", path(), { templateVersionId: kind === "data" ? data : storage, name, deploy: false }, idem());
    expect(created.status, created.raw).toBe(201);
    const stackId = created.body.data.stackId as string;
    let host: string | null = null;
    if (kind === "data") {
      const secret = await h.call(h.a.token, "POST", path(stackId, "/secrets"), { parameterKey: "app_secret", value: "first-value" });
      expect(secret.status, secret.raw).toBe(200);
      host = `${randomUUID().slice(0, 8)}.example.test`;
      const domain = await h.call(h.a.token, "POST", path(stackId, "/domains"), { hostname: host, componentKey: "web", port: 8080 });
      expect(domain.status, domain.raw).toBe(201);
    }
    expect((await act(stackId, "deploy")).status).toBe(202);
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("running");
    return { stackId, name, host };
  }

  it("deploys what the delete cases remove: containers, networks, a data volume, a secret, a domain and a route file", async () => {
    const quotaBefore = await quota();
    const { stackId, host } = await running();
    const snap = sim.appStacks.getAppStackSnapshot(stackId)!;
    expect(Object.keys(snap.containers).sort()).toEqual(["cache", "web"]);
    expect(Object.keys(snap.networks).sort()).toEqual(["app_edge", "app_internal"]);
    expect(Object.keys(snap.volumes)).toEqual(["data"]);
    expect(snap.routes.flatMap((r) => r.hosts.map((x) => x.hostname))).toEqual([host]);
    expect((await secretsOf(stackId)).length).toBeGreaterThan(0);
    expect((await volumesOf(stackId)).map((v) => v.status)).toEqual(["present"]);
    expect(await quota()).not.toEqual(quotaBefore);
  }, 60_000);

  describe.each([
    { title: "without the data flag", destroyData: false, volume: "retained", engineVolumes: ["data"], secretsKept: true },
    { title: "with the data flag", destroyData: true, volume: "removed", engineVolumes: [], secretsKept: false },
  ])("delete $title", ({ destroyData, volume, engineVolumes, secretsKept }) => {
    it(`removes routes, components and networks first; volumes end ${volume}; secret rows ${secretsKept ? "kept" : "purged"}`, async () => {
      const quotaBefore = await quota();
      const { stackId, name } = await running();
      expect(await quota()).not.toEqual(quotaBefore);
      const secretRows = (await secretsOf(stackId)).length;
      sim.appStacks.appStackMutations.length = 0;

      const res = await del(stackId, name, destroyData);
      expect(res.status, res.raw).toBe(202);
      expect((await stackRow(stackId)).status).toBe("deleting");
      // Nothing is touched until the worker runs, and the data policy is already recorded for it.
      expect(engine(stackId).routes).toHaveLength(1);
      expect((await volumesOf(stackId)).map((v) => v.retentionPolicy)).toEqual([destroyData ? "destroy" : "retain"]);
      await drain(stackId);

      const op = await lastOp(stackId);
      expect(op.status).toBe("succeeded");
      const row = await stackRow(stackId);
      expect(row.status).toBe("deleted");
      expect(row.deletedAt).not.toBeNull();

      // The simulated engine: route file, containers, networks gone; the volume only with the flag.
      const snap = engine(stackId);
      expect(snap.routes).toEqual([]);
      expect(snap.containers).toEqual({});
      expect(snap.networks).toEqual({});
      expect(Object.keys(snap.volumes)).toEqual(engineVolumes);
      const done = mutations(stackId);
      expect(done.filter((k) => k === "volume_remove")).toHaveLength(destroyData ? 1 : 0);
      expect(done.filter((k) => k === "container_remove")).toHaveLength(2);
      expect(done.filter((k) => k === "network_remove")).toHaveLength(2);
      // Spec §10.4 order: the route first, then containers and networks, the volume last.
      expect(done.indexOf("route_remove")).toBeGreaterThanOrEqual(0);
      expect(done.indexOf("route_remove")).toBeLessThan(done.indexOf("container_remove"));
      expect(done.lastIndexOf("container_remove")).toBeLessThan(done.indexOf("network_remove"));
      if (destroyData) expect(done.lastIndexOf("network_remove")).toBeLessThan(done.indexOf("volume_remove"));

      // The panel rows.
      expect((await volumesOf(stackId)).map((v) => [v.volumeKey, v.status])).toEqual([["data", volume]]);
      expect((await secretsOf(stackId)).length).toBe(secretsKept ? secretRows : 0);
      expect(await componentsOf(stackId)).toEqual([]);
      expect(await domainsOf(stackId)).toEqual([]);
      expect(await quota()).toEqual(quotaBefore);
      const audit = await h.dbClient.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "app.stack.delete"), eq(auditEvents.targetId, stackId)));
      expect(audit).toHaveLength(1);

      // A deleted stack is gone from the customer's list and cannot be acted on again.
      const list = await h.call(h.a.token, "GET", path());
      expect((list.body.data as Json[]).map((s) => s.id)).not.toContain(stackId);
      const again = await del(stackId, name, destroyData);
      expect(again.status, again.raw).toBe(404);
      expect((await act(stackId, "deploy")).status).toBe(404);
    }, 60_000);
  });

  it("a stack that was never deployed is deleted too: nothing is retained and its secret is purged, even without the data flag", async () => {
    const name = `draft-${randomUUID().slice(0, 8)}`;
    const created = await h.call(h.a.token, "POST", path(), { templateVersionId: data, name, deploy: false }, idem());
    expect(created.status, created.raw).toBe(201);
    const stackId = created.body.data.stackId as string;
    expect((await h.call(h.a.token, "POST", path(stackId, "/secrets"), { parameterKey: "app_secret", value: "never-used" })).status).toBe(200);
    expect((await secretsOf(stackId)).length).toBe(1);

    expect((await del(stackId, name, false)).status).toBe(202);
    await drain(stackId);
    expect((await lastOp(stackId)).status).toBe("succeeded");
    expect((await stackRow(stackId)).status).toBe("deleted");
    // Nothing was ever created, so there is no data to retain: no volume is retained and the secret goes.
    expect((await volumesOf(stackId)).filter((v) => v.status === "retained")).toEqual([]);
    expect(await secretsOf(stackId)).toEqual([]);
    expect(sim.appStacks.getAppStackSnapshot(stackId)).toBeNull();
  }, 60_000);

  it("a storage stack keeps its data by default and its volume row says so", async () => {
    const { stackId, name } = await running("storage");
    expect(Object.keys(engine(stackId).volumes)).toEqual(["data"]);
    expect((await del(stackId, name, false)).status).toBe(202);
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("deleted");
    expect(Object.keys(engine(stackId).volumes)).toEqual(["data"]);
    expect(mutations(stackId).filter((k) => k === "volume_remove")).toEqual([]);
    expect((await volumesOf(stackId)).map((v) => v.status)).toEqual(["retained"]);
  }, 60_000);

  describe("refusals change nothing", () => {
    it("a wrong confirmation name and another customer's delete write no operation and touch no container", async () => {
      const { stackId, name } = await running("storage");
      const before = await h.counts();
      const calls = stackCalls(stackId).length;
      for (const confirmName of ["", name.toUpperCase(), `${name} `, "other"]) {
        const res = await del(stackId, confirmName, true);
        expect(res.status, res.raw).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
      const foreign = await h.call(h.b.token, "DELETE", path(stackId), { confirmName: name, destroyData: true }, idem());
      expect(foreign.status, foreign.raw).toBeGreaterThanOrEqual(403);
      expect(foreign.status).toBeLessThanOrEqual(404);
      expect(await h.counts()).toEqual(before);
      expect((await stackRow(stackId)).status).toBe("running");
      expect(stackCalls(stackId).length).toBe(calls);
      expect((await volumesOf(stackId)).map((v) => v.retentionPolicy)).toEqual(["retain"]);
    }, 60_000);
  });

  describe("a delete in doubt", () => {
    const CASES: ReadonlyArray<{
      title: string;
      step: AppStackSimStep;
      fault: AppStackSimFault;
      /** What recovery reads on the engine: gone = certified removal, still there = the delete failed. */
      gone: boolean;
    }> = [
      { title: "the remove call answered nothing after it removed everything", step: "remove", fault: "ambiguous_after", gone: true },
      { title: "the remove call answered nothing before it did anything", step: "remove", fault: "ambiguous_before", gone: false },
      { title: "the stop call answered nothing before it did anything", step: "stop", fault: "ambiguous_before", gone: false },
      { title: "the unpublish call answered nothing after the route file was removed", step: "unpublish", fault: "ambiguous_after", gone: false },
    ];

    describe.each(CASES)("$title", ({ step, fault, gone }) => {
      it("keeps the stack deleting with its lock, quota, data and secrets, never replays, then recovery decides", async () => {
        const quotaBefore = await quota();
        const { stackId, name } = await running();
        const charged = await quota();
        expect(charged).not.toEqual(quotaBefore);
        const secretRows = (await secretsOf(stackId)).length;

        sim.appStacks.failNextAppStackStep(step, fault);
        expect((await del(stackId, name, true)).status).toBe(202);
        await drain(stackId);

        // In doubt: the operation is unknown, the stack still deleting, nothing finalised.
        const op = await lastOp(stackId);
        expect(op.status).toBe("unknown");
        const parked = await stackRow(stackId);
        expect(parked.status).toBe("deleting");
        expect(parked.deletedAt).toBeNull();
        expect(await quota()).toEqual(charged);
        expect((await secretsOf(stackId)).length).toBe(secretRows);
        expect((await volumesOf(stackId)).map((v) => v.status)).toEqual(["present"]);
        expect((await componentsOf(stackId)).length).toBeGreaterThan(0);
        expect((await domainsOf(stackId)).length).toBe(1);
        const view = await h.call(h.a.token, "GET", path(stackId));
        expect(view.body.data.status).toBe("deleting");
        expect(view.body.data.activeOperationId).toBe(op.id);

        // The lock holds every mutating action while the removal is not certified.
        const counts = await h.counts();
        for (const res of [await act(stackId, "deploy"), await act(stackId, "start"), await act(stackId, "stop"), await del(stackId, name, true)]) {
          expect(res.status, res.raw).toBe(409);
        }
        expect(await h.counts()).toEqual(counts);

        // A normal worker pass never replays the delete.
        const callsBefore = stackCalls(stackId).length;
        await worker.processPendingOnce();
        expect(stackCalls(stackId).length).toBe(callsBefore);
        expect((await lastOp(stackId)).status).toBe("unknown");

        // Recovery only reads.
        await expireLease(op.id);
        const mutationsBefore = sim.appStacks.appStackMutations.length;
        const result = await worker.recoverUnknownOperations();
        expect(result.recoveryErrors).toBeUndefined();
        expect(sim.appStacks.appStackMutations.length).toBe(mutationsBefore);
        expect(stackCalls(stackId).slice(callsBefore)).toEqual(["getAppStackStatus"]);

        const settled = await lastOp(stackId);
        const final = await stackRow(stackId);
        if (gone) {
          expect(settled.status).toBe("succeeded");
          expect(final.status).toBe("deleted");
          expect(final.deletedAt).not.toBeNull();
          expect(await quota()).toEqual(quotaBefore);
          expect(await secretsOf(stackId)).toEqual([]);
          expect((await volumesOf(stackId)).map((v) => v.status)).toEqual(["removed"]);
          expect(await componentsOf(stackId)).toEqual([]);
        } else {
          // Not certified: the customer can try again, and nothing was purged or released.
          expect(settled.status).toBe("failed");
          expect(final.status).toBe("delete_failed");
          expect(final.deletedAt).toBeNull();
          expect(await quota()).toEqual(charged);
          expect((await secretsOf(stackId)).length).toBe(secretRows);
          expect((await volumesOf(stackId)).map((v) => v.status)).toEqual(["present"]);
          // The retry removes everything.
          expect((await del(stackId, name, true)).status).toBe(202);
          await drain(stackId);
          expect((await stackRow(stackId)).status).toBe("deleted");
          expect(await quota()).toEqual(quotaBefore);
          expect(await secretsOf(stackId)).toEqual([]);
          expect(engine(stackId).containers).toEqual({});
          expect(engine(stackId).routes).toEqual([]);
        }
      }, 60_000);
    });

    it("a status read that fails during recovery keeps the delete unknown, locked and charged; the next pass settles it", async () => {
      const { stackId, name } = await running("storage");
      const charged = await quota();
      sim.appStacks.failNextAppStackStep("remove", "ambiguous_after");
      expect((await del(stackId, name, true)).status).toBe(202);
      await drain(stackId);
      const op = await lastOp(stackId);
      expect(op.status).toBe("unknown");

      await expireLease(op.id);
      sim.appStacks.failNextAppStackStep("status", "engine_unavailable");
      const first = await worker.recoverUnknownOperations();
      expect(first.convergedFailed + first.convergedSucceeded).toBe(0);
      expect((await lastOp(stackId)).status).toBe("unknown");
      expect((await stackRow(stackId)).status).toBe("deleting");
      expect(await quota()).toEqual(charged);
      expect((await act(stackId, "deploy")).status).toBe(409);
      expect((await del(stackId, name, true)).status).toBe(409);

      const second = await worker.recoverUnknownOperations();
      expect(second.convergedSucceeded).toBe(1);
      expect((await lastOp(stackId)).status).toBe("succeeded");
      expect((await stackRow(stackId)).status).toBe("deleted");
    }, 60_000);
  });

  describe("a delete that definitely failed", () => {
    it("ends delete_failed with nothing purged, then a second delete (now asking for the data to go) completes", async () => {
      const { stackId, name } = await running();
      const charged = await quota();
      const secretRows = (await secretsOf(stackId)).length;
      sim.appStacks.failNextAppStackStep("remove", "engine_unavailable");

      expect((await del(stackId, name, false)).status).toBe(202);
      await drain(stackId);
      const failed = await lastOp(stackId);
      expect(failed.status).toBe("failed");
      const row = await stackRow(stackId);
      expect(row.status).toBe("delete_failed");
      expect(row.deletedAt).toBeNull();
      // Nothing purged, nothing released.
      expect((await secretsOf(stackId)).length).toBe(secretRows);
      expect((await volumesOf(stackId)).map((v) => v.status)).toEqual(["present"]);
      expect(await quota()).toEqual(charged);
      expect((await componentsOf(stackId)).length).toBeGreaterThan(0);
      // The lock is released: the customer sees the stack and no active operation.
      const view = await h.call(h.a.token, "GET", path(stackId));
      expect(view.body.data.status).toBe("delete_failed");
      expect(view.body.data.activeOperationId).toBeNull();
      // A secret cannot be changed on a stack that is being deleted.
      const refused = await h.call(h.a.token, "POST", path(stackId, "/secrets"), { parameterKey: "app_secret", value: "late" });
      expect(refused.status).toBe(409);

      // Delete again, this time with the data flag: the stored policy follows the latest request.
      expect((await del(stackId, name, true)).status).toBe(202);
      expect((await volumesOf(stackId)).map((v) => v.retentionPolicy)).toEqual(["destroy"]);
      await drain(stackId);
      const ops = (await opsOf(stackId)).filter((o) => o.kind === "stack.delete");
      expect(ops.map((o) => o.status).sort()).toEqual(["failed", "succeeded"]);
      expect((await stackRow(stackId)).status).toBe("deleted");
      expect((await volumesOf(stackId)).map((v) => v.status)).toEqual(["removed"]);
      expect(await secretsOf(stackId)).toEqual([]);
      expect(Object.keys(engine(stackId).volumes)).toEqual([]);
      expect(engine(stackId).routes).toEqual([]);
      expect((await quota()).services).toBeLessThan(charged.services);
    }, 60_000);

    it("a failed delete without the flag, retried without the flag, still keeps the data", async () => {
      const { stackId, name } = await running();
      sim.appStacks.failNextAppStackStep("stop", "engine_unavailable");
      expect((await del(stackId, name, false)).status).toBe(202);
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("delete_failed");
      expect((await del(stackId, name, false)).status).toBe(202);
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("deleted");
      expect((await volumesOf(stackId)).map((v) => v.status)).toEqual(["retained"]);
      expect((await secretsOf(stackId)).length).toBeGreaterThan(0);
      expect(Object.keys(engine(stackId).volumes)).toEqual(["data"]);
      expect(engine(stackId).containers).toEqual({});
    }, 60_000);
  });
});
