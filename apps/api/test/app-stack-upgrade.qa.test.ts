// Q5 · A19, upgrade then rollback end to end on the simulator (arch-runtime §3.3 rows P/C, §10): the data keeps its
// identity, only the changed component is replaced, its dependents are restarted, a pre-flight failure touches no
// container, and a failure after create removes only what the new revision created.
import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST, ApprovedStackPlanSchema } from "@hosting-panel/contracts";
import {
  appStackComponents,
  appStackParameters,
  appStackRevisions,
  appStacks,
  appStackVolumes,
  asc,
  eq,
  operations,
  recordAppStackComponentHealthTransactional,
  resourceQuotas,
} from "@hosting-panel/database";
import type { AppStackSimFault, AppStackSimStep, InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appStackHealthRows } from "../src/app-stacks/app-stack-runtime-policy.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** storage (volume `data`) <- worker. Images on the code allowlist: the runtime and the simulator run them. */
const BASE = APP_BUILT_IN_TEMPLATES[1]!.source;
/** Only the storage changes (its memory ceiling): the worker depends on it and must be restarted, not replaced. */
const STORAGE_CHANGED = BASE.replace('"--maxmemory", "48mb"', '"--maxmemory", "64mb"');
/** Only the worker changes (its limit): nothing depends on it, the storage must not be touched at all. */
const WORKER_CHANGED = BASE.replace("          memory: 32M", "          memory: 48M");
/** A third component that depends on the storage and has a health check (the simulator probes only those). */
const EXTRA = [
  "  extra:",
  "    image: memcached:1.6.45-alpine3.24@sha256:084fb554292d1447bc2c68b80c2331b98834514f56c866bc21a61be3c2ee376d",
  '    command: ["memcached", "-m", "16", "-c", "64"]',
  "    expose:",
  "      - 11211",
  "    depends_on:",
  "      - storage",
  "    healthcheck:",
  "      kind: tcp",
  "      port: 11211",
  "      intervalSeconds: 10",
  "      timeoutSeconds: 3",
  "    deploy:",
  "      resources:",
  "        limits:",
  '          cpus: "0.1"',
  "          memory: 32M",
  "",
].join("\n");
const EXTRA_ADDED = BASE.replace("volumes:\n  data: {}", `${EXTRA}volumes:\n  data: {}`);
/** The worker and its setting are gone: only the storage is left. */
const WORKER_DROPPED =
  BASE.slice(0, BASE.indexOf("x-hp-parameters:")) +
  BASE.slice(BASE.indexOf("services:"), BASE.indexOf("  worker:")) +
  BASE.slice(BASE.indexOf("volumes:\n  data: {}"));
const BUDGET_MS = 10 * 60_000;
const POLL_MS = 5_000;

describe("application stack upgrade then rollback end to end on the simulator (QA M5, Q5, A19)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let skew = 0;
  let realNow: () => number;
  let bystander: string;
  let bystanderBefore: unknown;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    realNow = Date.now.bind(Date);
    // Another stack of the same customer, deployed once: no upgrade, rollback or failure of another stack may touch it.
    bystander = (await install(BASE)).stackId;
    bystanderBefore = observed(bystander);
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    skew = 0;
  });

  afterAll(async () => {
    await h?.close();
  });

  const orgPath = (stackId: string, verb: string) => `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/${verb}`;
  const plan = (stackId: string, body: Json) => h.call(h.a.token, "POST", orgPath(stackId, "plan"), body);
  const queue = (stackId: string, verb: "upgrade" | "rollback", body: Json) =>
    h.call(h.a.token, "POST", orgPath(stackId, verb), body, { "Idempotency-Key": randomUUID() });
  const revisions = (stackId: string) =>
    h.dbClient.db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId)).orderBy(asc(appStackRevisions.revisionNumber));
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = (stackId: string) =>
    h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId)).orderBy(asc(operations.submittedAt));
  const volumeRows = (stackId: string) => h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId));
  const snapshot = (stackId: string) => sim.appStacks.getAppStackSnapshot(stackId)!;
  /** What the simulator did to one stack, in order, as "kind:component" (the component is the container name's tail). */
  const mutationsOf = (stackId: string) =>
    sim.appStacks.appStackMutations
      .filter((m) => m.name.includes(stackId) && m.kind !== "pull")
      .map((m) => `${m.kind}:${m.name.slice(m.name.lastIndexOf(stackId) + stackId.length).replace(/^_/, "")}`);
  /** Everything the engine holds and was ever asked about one stack. */
  const observed = (stackId: string) => ({
    snap: sim.appStacks.getAppStackSnapshot(stackId),
    muts: mutationsOf(stackId),
    calls: sim.appStacks.appStackCalls.filter((c) => c.stackId === stackId).length,
  });
  const expectBystanderUntouched = () => expect(observed(bystander)).toEqual(bystanderBefore);

  /** The worker until no operation of the stack is open. */
  async function drain(stackId: string): Promise<void> {
    const worker = h.app.nestApp.get(OutboxWorkerService);
    for (let round = 0; round < 10; round += 1) {
      await worker.processPendingOnce();
      const open = (await opsOf(stackId)).filter((o) => ["queued", "running"].includes(o.status));
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  /** The health budget (10 minutes) and its 5 s waits pass in microseconds: only the runtime's clock reads Date.now. */
  function virtualTime(): void {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === POLL_MS) {
        skew += POLL_MS;
        return originalSetTimeout(fn, 0, ...args);
      }
      return originalSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
  }

  /** A template of its own from `source`, one stack of it deployed and running on revision 1. */
  async function install(source: string, parameters: readonly Json[] = []): Promise<{ templateId: string; versionId: string; stackId: string }> {
    const { templateId, versionId } = await h.publish(source);
    const res = await h.call(
      h.a.token,
      "POST",
      `/v1/organizations/${h.a.orgId}/app-stacks`,
      { templateVersionId: versionId, name: `app-${randomUUID().slice(0, 8)}`, deploy: true, parameters },
      { "Idempotency-Key": randomUUID() },
    );
    expect(res.status, res.raw).toBe(202);
    const stackId = res.body.data.stackId as string;
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("running");
    return { templateId, versionId, stackId };
  }

  async function addVersion(templateId: string, source: string): Promise<string> {
    const res = await h.call(h.adminToken, "POST", `/v1/admin/app-templates/${templateId}/versions`, { source, makeDefault: true });
    expect(res.status, res.raw).toBe(201);
    return res.body.data.versionId as string;
  }

  /** Review then confirm an upgrade; returns the preview. */
  async function upgradeTo(stackId: string, templateVersionId: string): Promise<Json> {
    const diff = await plan(stackId, { templateVersionId });
    expect(diff.status, diff.raw).toBe(200);
    const up = await queue(stackId, "upgrade", { templateVersionId, planHash: diff.body.data.planHash });
    expect(up.status, up.raw).toBe(202);
    return diff.body.data as Json;
  }

  /** A container payload without the label that names the revision that created it. */
  const sameSoftware = (payload: Json): Json => ({
    ...payload,
    Labels: { ...payload.Labels, "io.hostingpanel.app_revision_id": "-" },
  });
  const volumeIdentity = async (stackId: string) =>
    (await volumeRows(stackId)).map((r) => ({ stackId: r.stackId, key: r.volumeKey, status: r.status, retention: r.retentionPolicy, createdAt: r.createdAt.getTime() }));

  /** What the request of an upgrade writes, as the code reads it back. */
  const targetRows = async (stackId: string) => {
    const row = await stackRow(stackId);
    const { db } = h.dbClient;
    return {
      stack: { desired: row.desiredRevisionId, applied: row.appliedRevisionId, version: row.templateVersionId, quota: row.resourceQuotaId },
      parameters: (await db.select().from(appStackParameters).where(eq(appStackParameters.stackId, stackId)).orderBy(asc(appStackParameters.parameterKey))).map(
        (p) => [p.parameterKey, p.publicValue],
      ),
      components: (await db.select().from(appStackComponents).where(eq(appStackComponents.stackId, stackId)).orderBy(asc(appStackComponents.componentKey))).map(
        (c) => [c.componentKey, c.appliedRevisionId, c.health],
      ),
      quota: (await db.select().from(resourceQuotas).where(eq(resourceQuotas.organizationId, h.a.orgId))).map((q) => [q.usedServices, q.usedCpuMilli, q.usedMemoryBytes]),
    };
  };
  /** What the customer reads: the detail and the list entry. */
  const shown = async (stackId: string) => {
    const res = await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}`);
    expect(res.status, res.raw).toBe(200);
    const d = res.body.data as Json;
    const listed = ((await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-stacks`)).body.data as Json[]).find((s) => s.id === stackId)!;
    return {
      status: d.status,
      templateVersionId: d.templateVersionId,
      version: d.templateVersionNumber,
      revision: d.revisionNumber,
      installed: d.installed,
      upgrade: d.upgrade,
      rollback: d.rollback,
      parameters: d.parameters,
      components: d.components.map((c: Json) => c.key),
      cpuMilli: d.cpuMilli,
      memoryBytes: d.memoryBytes,
      listed: { status: listed.status, version: listed.templateVersionNumber, components: listed.componentCount },
    };
  };
  const componentRead = (stackId: string, key: string, read: "logs" | "health") =>
    h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/components/${key}/${read}`);

  const volumeMounted = (stackId: string, component: string): boolean => {
    const name = snapshot(stackId).volumes.data!.name;
    return JSON.stringify(snapshot(stackId).containers[component]!.payload).includes(name);
  };

  describe("A19: upgrade then rollback", () => {
    it("a changed storage is replaced, its dependent worker restarted; the volume is the same object before the upgrade, after it and after the rollback", async () => {
      const { templateId, stackId } = await install(BASE);
      const [rev1] = await revisions(stackId);
      const volume = snapshot(stackId).volumes;
      const volumeName = volume.data!.name;
      const rowsBefore = await volumeIdentity(stackId);
      const storageBefore = snapshot(stackId).containers.storage!;
      const workerBefore = snapshot(stackId).containers.worker!;
      expect(volumeMounted(stackId, "storage")).toBe(true);
      const v2 = await addVersion(templateId, STORAGE_CHANGED);

      // The preview names the data risk, and so does the one of the way back.
      const mark = mutationsOf(stackId).length;
      const diff = await upgradeTo(stackId, v2);
      expect(diff).toMatchObject({ newRevision: true, dataRisk: true, downtime: false, volumes: [{ key: "data", change: "unchanged" }] });
      expect(diff.components.find((c: Json) => c.key === "storage")).toMatchObject({ change: "updated" });
      expect(await stackRow(stackId)).toMatchObject({ status: "updating" });
      await drain(stackId);

      const [, rev2] = await revisions(stackId);
      expect(rev2).toMatchObject({ revisionNumber: 2, templateVersionId: v2 });
      expect(await stackRow(stackId)).toMatchObject({ status: "running", appliedRevisionId: rev2!.id, desiredRevisionId: rev2!.id });
      // Only the storage was replaced; the worker, which depends on it, was restarted after it was running again.
      const upgrade = mutationsOf(stackId).slice(mark);
      expect(upgrade).toEqual([
        "container_remove:storage",
        "container_create:storage",
        "container_start:storage",
        "container_restart:worker",
      ]);
      const after = snapshot(stackId);
      expect(after.containers.storage!.payload).not.toEqual(storageBefore.payload);
      expect(after.containers.worker!).toEqual(workerBefore);
      expect(Object.values(after.containers).map((c) => c.state)).toEqual(["running", "running"]);
      // The data kept its identity: the engine's own record of the volume is the same, and it is mounted again.
      expect(after.volumes).toEqual(volume);
      expect(volumeMounted(stackId, "storage")).toBe(true);

      const back = await plan(stackId, { revisionId: rev1!.id });
      expect(back.status, back.raw).toBe(200);
      expect(back.body.data).toMatchObject({ planHash: rev1!.planHash, newRevision: true, dataRisk: true });
      const rolled = await queue(stackId, "rollback", { revisionId: rev1!.id, planHash: back.body.data.planHash });
      expect(rolled.status, rolled.raw).toBe(202);
      expect(rolled.body.data.status).toBe("updating");
      await drain(stackId);

      const all = await revisions(stackId);
      expect(all.map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
      expect(all[2]).toMatchObject({ templateVersionId: rev1!.templateVersionId, planHash: rev1!.planHash });
      expect(all[2]!.id).not.toBe(rev1!.id);
      expect(await stackRow(stackId)).toMatchObject({ status: "running", appliedRevisionId: all[2]!.id });
      const rollback = mutationsOf(stackId).slice(mark + upgrade.length);
      expect(rollback).toEqual([
        "container_remove:storage",
        "container_create:storage",
        "container_start:storage",
        "container_restart:worker",
      ]);
      const end = snapshot(stackId);
      // The old software again, the same data.
      expect(sameSoftware(end.containers.storage!.payload)).toEqual(sameSoftware(storageBefore.payload));
      expect(end.volumes).toEqual(volume);
      expect(volumeMounted(stackId, "storage")).toBe(true);
      expect(Object.values(end.containers).map((c) => c.state)).toEqual(["running", "running"]);
      // The volume was created once, by the first deploy, and never removed or created again; its row never changed identity.
      const volumeKinds = sim.appStacks.appStackMutations.filter((m) => m.name === volumeName).map((m) => m.kind);
      expect(volumeKinds).toEqual(["volume"]);
      expect(await volumeIdentity(stackId)).toEqual(rowsBefore);
      expectBystanderUntouched();
    });

    it("a changed worker is replaced and started; the storage it depends on is not touched at all", async () => {
      const { templateId, stackId } = await install(BASE);
      const volume = snapshot(stackId).volumes;
      const storageBefore = snapshot(stackId).containers.storage!;
      const mark = mutationsOf(stackId).length;
      const v2 = await addVersion(templateId, WORKER_CHANGED);
      const diff = await upgradeTo(stackId, v2);
      expect(diff.components).toEqual([
        expect.objectContaining({ key: "storage", change: "unchanged", restart: false }),
        expect.objectContaining({ key: "worker", change: "updated" }),
      ]);
      await drain(stackId);

      expect(mutationsOf(stackId).slice(mark)).toEqual(["container_remove:worker", "container_create:worker", "container_start:worker"]);
      expect(snapshot(stackId).containers.storage!).toEqual(storageBefore);
      expect(snapshot(stackId).volumes).toEqual(volume);
      expect(await stackRow(stackId)).toMatchObject({ status: "running" });
      expectBystanderUntouched();
    });

    it("a component added by the new version is created and started after its dependency; a rollback removes it and keeps the data", async () => {
      const { templateId, stackId } = await install(BASE);
      const [rev1] = await revisions(stackId);
      const volume = snapshot(stackId).volumes;
      const before = snapshot(stackId).containers;
      const mark = mutationsOf(stackId).length;
      const v2 = await addVersion(templateId, EXTRA_ADDED);
      const diff = await upgradeTo(stackId, v2);
      expect(diff.components.find((c: Json) => c.key === "extra")).toMatchObject({ change: "added" });
      await drain(stackId);
      expect(mutationsOf(stackId).slice(mark)).toEqual(["container_create:extra", "container_start:extra"]);
      expect(Object.keys(snapshot(stackId).containers).sort()).toEqual(["extra", "storage", "worker"]);
      expect(snapshot(stackId).containers.storage!).toEqual(before.storage);
      expect(snapshot(stackId).containers.worker!).toEqual(before.worker);

      const back = await plan(stackId, { revisionId: rev1!.id });
      expect(back.status, back.raw).toBe(200);
      expect(back.body.data.components.find((c: Json) => c.key === "extra")).toMatchObject({ change: "removed" });
      expect(back.body.data.dataRisk).toBe(true);
      expect((await queue(stackId, "rollback", { revisionId: rev1!.id, planHash: back.body.data.planHash })).status).toBe(202);
      await drain(stackId);
      expect(Object.keys(snapshot(stackId).containers).sort()).toEqual(["storage", "worker"]);
      expect(mutationsOf(stackId).filter((m) => m.startsWith("container_remove:"))).toEqual(["container_remove:extra"]);
      expect(snapshot(stackId).containers.storage!).toEqual(before.storage);
      expect(snapshot(stackId).volumes).toEqual(volume);
      expect(mutationsOf(stackId).some((m) => m.startsWith("volume_remove"))).toBe(false);
      expect((await revisions(stackId)).map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
      expectBystanderUntouched();
    });
  });

  describe("a failure before anything is created changes nothing (row P)", () => {
    // [where the simulator fails, the fault, the step the operation must report]
    const FAULTS: readonly (readonly [AppStackSimStep, AppStackSimFault])[] = [
      ["pull", "pull_failed"],
      ["prepare", "engine_unavailable"],
    ];

    it.each(FAULTS)("an upgrade that fails at %s (%s) leaves every container, the volume and the applied revision as they were", async (at, fault) => {
      const { templateId, versionId: v1, stackId } = await install(BASE, [{ key: "worker_interval_seconds", value: 45 }]);
      const [rev1] = await revisions(stackId);
      const v2 = await addVersion(templateId, STORAGE_CHANGED);
      const before = observed(stackId);
      const volumeRowsBefore = await volumeIdentity(stackId);
      // Everything the request of the upgrade rewrites, and everything the customer reads from it.
      const rowsBefore = await targetRows(stackId);
      const shownBefore = await shown(stackId);
      expect(shownBefore).toMatchObject({ version: 1, revision: 1, upgrade: { versionNumber: 2 }, rollback: null });
      const upgradeBody = { templateVersionId: v2, parameters: [{ key: "worker_interval_seconds", value: 60 }] };
      const preview = await plan(stackId, upgradeBody);
      expect(preview.status, preview.raw).toBe(200);
      expect(preview.body.data).toMatchObject({ fromRevisionId: rev1!.id, fromVersionNumber: 1, toVersionNumber: 2 });

      sim.appStacks.failNextAppStackStep(at, fault);
      expect((await queue(stackId, "upgrade", { ...upgradeBody, planHash: preview.body.data.planHash })).status).toBe(202);
      expect((await targetRows(stackId)).parameters).toEqual([["worker_interval_seconds", 60]]);
      await drain(stackId);

      const [, failedUp] = await opsOf(stackId);
      expect(failedUp).toMatchObject({ kind: "stack.upgrade", status: "failed" });
      // Nothing on the engine moved: same containers, same volume, same mutations, no container started or removed.
      expect(snapshot(stackId)).toEqual(before.snap);
      expect(mutationsOf(stackId)).toEqual(before.muts);
      const row = await stackRow(stackId);
      expect(row.appliedRevisionId).toBe(rev1!.id);
      // The application is still the one that ran: its containers are running, so the stack is not reported as failed.
      expect(row.status).toBe("running");
      expect(await volumeIdentity(stackId)).toEqual(volumeRowsBefore);
      expectBystanderUntouched();
      // What the request wrote is taken back: target, version, settings, components and quota are those of revision 1, so
      // the customer sees version 1 with the upgrade on offer again and the same preview of it.
      expect(await targetRows(stackId)).toEqual(rowsBefore);
      expect(await shown(stackId)).toEqual(shownBefore);
      expect((await plan(stackId, upgradeBody)).body.data).toEqual(preview.body.data);

      // The fault was consumed: a plain redeploy installs what runs, not the version that failed, and the data is the same.
      const retry = await h.call(h.a.token, "POST", orgPath(stackId, "deploy"), {}, { "Idempotency-Key": randomUUID() });
      expect(retry.status, retry.raw).toBe(202);
      await drain(stackId);
      expect(await stackRow(stackId)).toMatchObject({ status: "running", appliedRevisionId: rev1!.id, desiredRevisionId: rev1!.id, templateVersionId: v1 });
      expect((await revisions(stackId)).map((r) => r.templateVersionId)).toEqual([v1, v2]);
      expect(snapshot(stackId).containers).toEqual(before.snap!.containers);
      expect(snapshot(stackId).volumes).toEqual(before.snap!.volumes);
    });

    it("an upgrade that drops a component and fails at pull: that component keeps its logs and health, and a later crash shows", async () => {
      const { templateId, stackId } = await install(BASE, [{ key: "worker_interval_seconds", value: 45 }]);
      const v2 = await addVersion(templateId, WORKER_DROPPED);
      const rowsBefore = await targetRows(stackId);
      const shownBefore = await shown(stackId);
      expect(shownBefore).toMatchObject({ components: ["storage", "worker"], listed: { version: 1, components: 2 } });
      for (const read of ["logs", "health"] as const) expect((await componentRead(stackId, "worker", read)).status).toBe(200);

      sim.appStacks.failNextAppStackStep("pull", "pull_failed");
      const diff = await plan(stackId, { templateVersionId: v2 });
      expect(diff.body.data.components.find((c: Json) => c.key === "worker")).toMatchObject({ change: "removed" });
      expect((await queue(stackId, "upgrade", { templateVersionId: v2, planHash: diff.body.data.planHash })).status).toBe(202);
      expect((await targetRows(stackId)).components.map((c) => c[0])).toEqual(["storage"]);
      await drain(stackId);

      expect((await opsOf(stackId))[1]).toMatchObject({ kind: "stack.upgrade", status: "failed" });
      expect(snapshot(stackId).containers.worker!.state).toBe("running");
      expect(await targetRows(stackId)).toEqual(rowsBefore);
      expect(await shown(stackId)).toEqual(shownBefore);
      for (const read of ["logs", "health"] as const) {
        const res = await componentRead(stackId, "worker", read);
        expect(res.status, res.raw).toBe(200);
      }

      // The storage stops: the page shows the next observation, recorded here for this stack only as the observer's pass
      // does (a whole pass would also read the bystander).
      sim.appStacks.crashAppStackComponent(stackId, "storage");
      const [rev1] = await revisions(stackId);
      await recordAppStackComponentHealthTransactional(h.dbClient.db, {
        organizationId: h.a.orgId,
        stackId,
        observedAt: new Date(),
        components: appStackHealthRows(
          ApprovedStackPlanSchema.parse(rev1!.plan),
          await sim.appStacks.getAppStackStatus({ stackId, organizationId: h.a.orgId }),
          "observer",
        ),
      });
      expect((await targetRows(stackId)).components[0]).toEqual(["storage", rev1!.id, "stopped"]);
      expect(await shown(stackId)).toMatchObject({ status: "failed", version: 1 });
    });

    it("a deploy with new settings that fails at pull keeps them as the target; the page follows what runs, a crash included", async () => {
      const { stackId } = await install(BASE, [{ key: "worker_interval_seconds", value: 45 }]);
      const [rev1] = await revisions(stackId);
      sim.appStacks.failNextAppStackStep("pull", "pull_failed");
      const deploy = await h.call(
        h.a.token,
        "POST",
        orgPath(stackId, "deploy"),
        { parameters: [{ key: "worker_interval_seconds", value: 60 }] },
        { "Idempotency-Key": randomUUID() },
      );
      expect(deploy.status, deploy.raw).toBe(202);
      await drain(stackId);

      // A deploy is not taken back: its revision stays the target, a reinstall tries it again.
      const [, rev2] = await revisions(stackId);
      expect(await stackRow(stackId)).toMatchObject({ status: "running", desiredRevisionId: rev2!.id, appliedRevisionId: rev1!.id });
      expect(await shown(stackId)).toMatchObject({ status: "running", revision: 2, installed: { revisionNumber: 1, templateVersionNumber: 1 } });

      // The storage stops: the next observation of what runs (revision 1) shows on the page.
      sim.appStacks.crashAppStackComponent(stackId, "storage");
      await recordAppStackComponentHealthTransactional(h.dbClient.db, {
        organizationId: h.a.orgId,
        stackId,
        observedAt: new Date(),
        components: appStackHealthRows(
          ApprovedStackPlanSchema.parse(rev1!.plan),
          await sim.appStacks.getAppStackStatus({ stackId, organizationId: h.a.orgId }),
          "observer",
        ),
      });
      expect(await shown(stackId)).toMatchObject({ status: "failed", revision: 2 });
    });

    it("the failed upgrade stays in the history, its key answers the same operation, and a new request tries it again", async () => {
      const { templateId, stackId } = await install(BASE);
      const [rev1] = await revisions(stackId);
      const v2 = await addVersion(templateId, STORAGE_CHANGED);
      const key = randomUUID();
      sim.appStacks.failNextAppStackStep("pull", "pull_failed");
      const diff = await plan(stackId, { templateVersionId: v2 });
      const body = { templateVersionId: v2, planHash: diff.body.data.planHash };
      const first = await h.call(h.a.token, "POST", orgPath(stackId, "upgrade"), body, { "Idempotency-Key": key });
      expect(first.status, first.raw).toBe(202);
      await drain(stackId);
      expect(await stackRow(stackId)).toMatchObject({ status: "running", desiredRevisionId: rev1!.id });

      const replay = await h.call(h.a.token, "POST", orgPath(stackId, "upgrade"), body, { "Idempotency-Key": key });
      expect(replay.status, replay.raw).toBe(202);
      expect(replay.body.data.operationId).toBe(first.body.data.operationId);
      expect(await opsOf(stackId)).toHaveLength(2);
      const history = await h.call(h.a.token, "GET", orgPath(stackId, "deployments"));
      expect(history.body.data[0]).toMatchObject({
        operationId: first.body.data.operationId,
        kind: "stack.upgrade",
        revisionNumber: 2,
        status: "failed",
        problem: "DOCKER_ENGINE_UNAVAILABLE",
      });

      // A new request is a new operation and a new revision; once it runs, the way back is to the version that ran before.
      const again = await upgradeTo(stackId, v2);
      expect(again.planHash).toBe(diff.body.data.planHash);
      await drain(stackId);
      const ops = await opsOf(stackId);
      expect(ops.map((o) => [o.kind, o.status])).toEqual([
        ["stack.deploy", "succeeded"],
        ["stack.upgrade", "failed"],
        ["stack.upgrade", "succeeded"],
      ]);
      const all = await revisions(stackId);
      expect(all.map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
      expect(await stackRow(stackId)).toMatchObject({ status: "running", appliedRevisionId: all[2]!.id, templateVersionId: v2 });
      expect(await shown(stackId)).toMatchObject({ version: 2, revision: 3, upgrade: null, rollback: { revisionId: rev1!.id, templateVersionNumber: 1 } });
    });
  });

  describe("a failure after create removes only what the new revision created (row C)", () => {
    // [label, where the simulator fails, the fault, whether the health wait is what ends the upgrade]
    const FAULTS: readonly (readonly [string, AppStackSimStep | null, AppStackSimFault | null])[] = [
      ["start of the first component", "start", "engine_unavailable"],
      ["create (nothing is created)", "create", "engine_unavailable"],
      ["health: the new component never gets ready", null, null],
    ];

    it.each(FAULTS)("an upgrade that adds a component and fails at %s keeps the running components and the volume and removes the new component", async (_label, at, fault) => {
      const { templateId, stackId } = await install(BASE);
      const [rev1] = await revisions(stackId);
      const v2 = await addVersion(templateId, EXTRA_ADDED);
      const before = observed(stackId);
      const volumeRowsBefore = await volumeIdentity(stackId);
      const diff = await plan(stackId, { templateVersionId: v2 });
      expect(diff.status, diff.raw).toBe(200);

      if (at !== null && fault !== null) sim.appStacks.failNextAppStackStep(at, fault);
      else {
        virtualTime();
        sim.appStacks.setAppStackComponentProbe(stackId, "extra", "failed");
      }
      expect((await queue(stackId, "upgrade", { templateVersionId: v2, planHash: diff.body.data.planHash })).status).toBe(202);
      await drain(stackId);

      const [, failedUp] = await opsOf(stackId);
      expect(failedUp).toMatchObject({ kind: "stack.upgrade", status: "failed" });
      if (at === null) expect(skew).toBeGreaterThanOrEqual(BUDGET_MS);
      // The new component is gone; the components of the previous revision are exactly as they were and still running.
      const after = snapshot(stackId);
      expect(Object.keys(after.containers).sort()).toEqual(["storage", "worker"]);
      expect(after.containers).toEqual(before.snap!.containers);
      expect(Object.values(after.containers).map((c) => c.state)).toEqual(["running", "running"]);
      const added = mutationsOf(stackId).slice(before.muts.length);
      for (const m of added) expect(m, "only the new component was touched").toMatch(/:extra$/);
      expect(added.includes("container_create:extra")).toBe(at !== "create");
      if (at !== "create") expect(added.at(-1)).toBe("container_remove:extra");
      // Data and applied revision: the volume is the same, no volume was removed, the application is still revision 1.
      expect(after.volumes).toEqual(before.snap!.volumes);
      expect(added.some((m) => m.startsWith("volume"))).toBe(false);
      expect(await volumeIdentity(stackId)).toEqual(volumeRowsBefore);
      const row = await stackRow(stackId);
      expect(row.appliedRevisionId).toBe(rev1!.id);
      expect(row.status).toBe("failed");
      expect(row.deletedAt).toBeNull();
      expectBystanderUntouched();
    });

    it("a replaced component whose start fails is removed with its new container only: the other components and the volume stay", async () => {
      const { templateId, stackId } = await install(BASE);
      const v2 = await addVersion(templateId, STORAGE_CHANGED);
      const before = observed(stackId);
      const diff = await plan(stackId, { templateVersionId: v2 });
      sim.appStacks.failNextAppStackStep("start", "engine_unavailable");
      expect((await queue(stackId, "upgrade", { templateVersionId: v2, planHash: diff.body.data.planHash })).status).toBe(202);
      await drain(stackId);

      expect((await opsOf(stackId))[1]).toMatchObject({ kind: "stack.upgrade", status: "failed" });
      const after = snapshot(stackId);
      // The worker, which the new revision did not change, was not touched; the data is the same object.
      expect(after.containers.worker).toEqual(before.snap!.containers.worker);
      expect(after.containers.storage?.payload ?? null).not.toEqual(before.snap!.containers.storage!.payload);
      expect(after.volumes).toEqual(before.snap!.volumes);
      const added = mutationsOf(stackId).slice(before.muts.length);
      expect(added.some((m) => m.endsWith(":worker"))).toBe(false);
      expect(added.some((m) => m.startsWith("volume"))).toBe(false);
      expect(await stackRow(stackId)).toMatchObject({ status: "failed" });
      expectBystanderUntouched();
      // Version 2 stays the target (a redeploy tries it again), but the page learns that version 1 is the one installed.
      expect(await shown(stackId)).toMatchObject({ status: "failed", version: 2, revision: 2, installed: { revisionNumber: 1, templateVersionNumber: 1 } });
    });
  });
});
