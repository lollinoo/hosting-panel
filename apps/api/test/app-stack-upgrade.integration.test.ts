import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST, type AppImageAllowlistEntry } from "@hosting-panel/contracts";
import {
  addAppStackDomainsTransactional,
  and,
  appStackDomains,
  appStackParameters,
  appStackRevisions,
  appStacks,
  appStackVolumes,
  asc,
  auditEvents,
  eq,
  operations,
  resourceQuotas,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, NOTES_DEMO_SOURCE, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

/** Images on the code allowlist and a volume: the runtime and the simulator run it. */
const STORAGE_SOURCE = APP_BUILT_IN_TEMPLATES[1]!.source;
/** v2: only the worker changes (its memory limit). */
const STORAGE_V2 = STORAGE_SOURCE.replace("          memory: 32M", "          memory: 48M");
/** v2 of notes-demo: the web address moves from port 8080 to 8081. */
const NOTES_MOVED = NOTES_DEMO_SOURCE.replace("    expose:\n      - 8080\n", "    expose:\n      - 8080\n      - 8081\n").replace(
  "x-hp-ingress:\n  - service: app\n    port: 8080",
  "x-hp-ingress:\n  - service: app\n    port: 8081",
);
const OTHER_HASH = "0".repeat(64);

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("application stack plan, upgrade and rollback (H8)", () => {
  let h: AppStackHarness;
  let notes: string;
  /** Mutable: a case changes what the panel allows and puts it back. */
  const allowlist: AppImageAllowlistEntry[] = [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST];

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    notes = (await h.publish()).versionId;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const path = (stackId: string, verb: string) => `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}/${verb}`;
  const plan = (stackId: string, body: Json) => h.call(h.a.token, "POST", path(stackId, "plan"), body);
  const queue = (stackId: string, verb: "upgrade" | "rollback" | "deploy", body: Json, key: string = randomUUID()) =>
    h.call(h.a.token, "POST", path(stackId, verb), body, { "Idempotency-Key": key });
  const revisions = (stackId: string) =>
    h.dbClient.db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId)).orderBy(asc(appStackRevisions.revisionNumber));
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const audits = (action: string, targetId: string) =>
    h.dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)));

  async function create(body: Json): Promise<string> {
    const res = await h.call(h.a.token, "POST", `/v1/organizations/${h.a.orgId}/app-stacks`, body, { "Idempotency-Key": randomUUID() });
    expect(res.status, res.raw).toBe(body.deploy ? 202 : 201);
    return res.body.data.stackId as string;
  }

  async function addVersion(templateId: string, source: string, makeDefault: boolean): Promise<string> {
    const res = await h.call(h.adminToken, "POST", `/v1/admin/app-templates/${templateId}/versions`, { source, makeDefault });
    expect(res.status, res.raw).toBe(201);
    return res.body.data.versionId as string;
  }

  /** A notes stack (secret set) whose revision 1 is queued and settled as running without the runtime. */
  async function notesRunning(versionId: string): Promise<string> {
    const stackId = await create({ templateVersionId: versionId, name: `app-${randomUUID().slice(0, 8)}`, deploy: false });
    const secret = await h.call(h.a.token, "POST", path(stackId, "secrets"), { parameterKey: "app_secret", value: "first-value" });
    expect(secret.status, secret.raw).toBe(200);
    expect((await queue(stackId, "deploy", {})).status).toBe(202);
    await settle(stackId);
    return stackId;
  }

  async function settle(stackId: string): Promise<void> {
    await h.dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.resourceId, stackId));
    await h.dbClient.db.update(appStacks).set({ status: "running" }).where(eq(appStacks.id, stackId));
  }

  async function runUntilRunning(stackId: string): Promise<void> {
    const worker = h.app.nestApp.get(OutboxWorkerService);
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "running"; round += 1) await worker.processPendingOnce();
    expect((await stackRow(stackId)).status).toBe("running");
  }

  it("A19: upgrade then rollback through the simulator: revisions 2 and 3, the same volume, the data-risk warning", async () => {
    const { templateId, versionId: v1 } = await h.publish(STORAGE_SOURCE);
    const stackId = await create({
      templateVersionId: v1,
      name: "counter",
      deploy: true,
      parameters: [{ key: "worker_interval_seconds", value: 15 }],
    });
    await runUntilRunning(stackId);
    const sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    const volume = sim.appStacks.getAppStackSnapshot(stackId)!.volumes;
    expect(Object.keys(volume)).toEqual(["data"]);
    const volumeRows = await h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId));
    const v2 = await addVersion(templateId, STORAGE_V2, true);
    const [rev1] = await revisions(stackId);

    // The plan writes nothing and two calls give the same answer.
    const before = await h.counts();
    const toV2 = { templateVersionId: v2, parameters: [{ key: "worker_interval_seconds", value: 20 }] };
    const diff = await plan(stackId, toV2);
    expect(diff.status, diff.raw).toBe(200);
    expect(diff.body.data).toMatchObject({
      fromRevisionId: rev1!.id,
      fromVersionNumber: 1,
      toTemplateVersionId: v2,
      toVersionNumber: 2,
      newRevision: true,
      components: [
        { key: "storage", change: "unchanged", restart: false },
        { key: "worker", change: "updated", restart: true },
      ],
      volumes: [{ key: "data", change: "unchanged" }],
      parameters: [{ key: "worker_interval_seconds", change: "updated" }],
      ingress: [],
      downtime: false,
      dataRisk: true,
    });
    expect((await plan(stackId, toV2)).body).toEqual(diff.body);
    expectRefusal(await queue(stackId, "upgrade", { ...toV2, planHash: OTHER_HASH }), 400, "VALIDATION_ERROR", {
      field: "planHash",
      reason: "plan_changed",
    });
    expect(await h.counts()).toEqual(before);

    const key = randomUUID();
    const up = await queue(stackId, "upgrade", { ...toV2, planHash: diff.body.data.planHash }, key);
    expect(up.status, up.raw).toBe(202);
    expect(up.body.data.status).toBe("updating");
    const queued = await h.counts();
    // A retry with the same key replays, although the stack is already on v2.
    const replay = await queue(stackId, "upgrade", { ...toV2, planHash: diff.body.data.planHash }, key);
    expect(replay.status, replay.raw).toBe(202);
    expect(replay.body.data.operationId).toBe(up.body.data.operationId);
    expect(await h.counts()).toEqual(queued);
    expect(await audits("app.stack.upgrade", stackId)).toHaveLength(1);
    await runUntilRunning(stackId);

    const [, rev2] = await revisions(stackId);
    expect(rev2).toMatchObject({ revisionNumber: 2, templateVersionId: v2, planHash: diff.body.data.planHash });
    expect(rev2!.parameters).toEqual([{ key: "worker_interval_seconds", value: 20 }]);

    const back = await plan(stackId, { revisionId: rev1!.id });
    expect(back.status, back.raw).toBe(200);
    expect(back.body.data).toMatchObject({
      planHash: rev1!.planHash,
      fromRevisionId: rev2!.id,
      fromVersionNumber: 2,
      toTemplateVersionId: v1,
      toVersionNumber: 1,
      newRevision: true,
      components: [
        { key: "storage", change: "unchanged", restart: false },
        { key: "worker", change: "updated", restart: true },
      ],
      parameters: [{ key: "worker_interval_seconds", change: "updated" }],
      dataRisk: true,
    });
    const rolled = await queue(stackId, "rollback", { revisionId: rev1!.id, planHash: back.body.data.planHash });
    expect(rolled.status, rolled.raw).toBe(202);
    expect(await audits("app.stack.rollback", stackId)).toHaveLength(1);
    await runUntilRunning(stackId);

    const all = await revisions(stackId);
    expect(all.map((r) => r.revisionNumber)).toEqual([1, 2, 3]);
    expect(all[2]).toMatchObject({ templateVersionId: v1, planHash: rev1!.planHash, parameters: rev1!.parameters });
    expect(all[2]!.id).not.toBe(rev1!.id);
    expect(await stackRow(stackId)).toMatchObject({ desiredRevisionId: all[2]!.id, templateVersionId: v1 });
    const stored = await h.dbClient.db.select().from(appStackParameters).where(eq(appStackParameters.stackId, stackId));
    expect(stored.map((p) => [p.parameterKey, p.publicValue])).toEqual([["worker_interval_seconds", 15]]);

    // The data stays under the same logical identity: one volume, never removed or created again.
    expect(sim.appStacks.getAppStackSnapshot(stackId)!.volumes).toEqual(volume);
    const name = volume.data!.name;
    expect(sim.appStacks.appStackMutations.filter((m) => m.name === name).map((m) => m.kind)).toEqual(["volume"]);
    expect(await h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId))).toEqual(
      volumeRows.map((row) => ({ ...row, updatedAt: expect.any(Date) as Date })),
    );
  });

  it("plan names a secret without its value, refuses a missing required one and changes nothing; a foreign stack is 404", async () => {
    const stackId = await create({ templateVersionId: notes, name: "needs-secret", deploy: false });
    let before = await h.counts();
    expectRefusal(await plan(stackId, {}), 400, "VALIDATION_ERROR", { field: "parameters.app_secret", reason: "STACK_SECRET_MISSING" });
    const foreign = await h.call(h.b.token, "POST", `/v1/organizations/${h.b.orgId}/app-stacks/${stackId}/plan`, {});
    expectRefusal(foreign, 404, "NOT_FOUND");
    expect(foreign.body.error.message).toBe("Requested organization or resource was not found.");
    expectRefusal(await plan(stackId, { templateVersionId: notes, revisionId: "srev_x" }), 400, "VALIDATION_ERROR");
    expectRefusal(await plan(stackId, { revisionId: "srev_x", parameters: [] }), 400, "VALIDATION_ERROR");
    expect(await h.counts()).toEqual(before);

    const canary = `canary-${randomUUID()}`;
    expect((await h.call(h.a.token, "POST", path(stackId, "secrets"), { parameterKey: "app_secret", value: canary })).status).toBe(200);
    before = await h.counts();
    const first = await plan(stackId, {});
    expect(first.status, first.raw).toBe(200);
    expect(first.body.data).toMatchObject({
      fromRevisionId: null,
      fromVersionNumber: null,
      toTemplateVersionId: notes,
      toVersionNumber: 1,
      newRevision: true,
      components: [
        { key: "app", change: "added", restart: false },
        { key: "cache", change: "added", restart: false },
      ],
      volumes: [{ key: "data", change: "added" }],
      parameters: [{ key: "app_secret", change: "added" }],
      ingress: [{ componentKey: "app", port: 8080, change: "added" }],
      downtime: false,
      dataRisk: false,
    });
    expect(first.raw).not.toContain(canary);
    expect((await plan(stackId, {})).body).toEqual(first.body);
    expect(await h.counts()).toEqual(before);
  });

  it("upgrade refuses an unknown, older, unpublished or changed version and a removed web address target, writing nothing", async () => {
    const { templateId, versionId: v1 } = await h.publish();
    const stackId = await notesRunning(v1);
    const v2 = await addVersion(templateId, NOTES_MOVED, false);
    let before = await h.counts();
    const upgrade = (templateVersionId: string, planHash = OTHER_HASH) => queue(stackId, "upgrade", { templateVersionId, planHash });
    expectRefusal(await upgrade(notes), 400, "VALIDATION_ERROR", { field: "templateVersionId", reason: "unknown_version" });
    expectRefusal(await plan(stackId, { templateVersionId: notes }), 400, "VALIDATION_ERROR", { reason: "unknown_version" });
    expectRefusal(await upgrade(v1), 400, "VALIDATION_ERROR", { field: "templateVersionId", reason: "not_newer" });
    expectRefusal(await upgrade(v2), 400, "VALIDATION_ERROR", { field: "templateVersionId", reason: "STACK_TEMPLATE_UNPUBLISHED" });
    expectRefusal(await queue(stackId, "upgrade", { templateVersionId: v2 }), 400, "VALIDATION_ERROR");
    expect(await h.counts()).toEqual(before);

    const made = await h.call(h.adminToken, "PATCH", `/v1/admin/app-templates/${templateId}`, { defaultVersionId: v2 });
    expect(made.status, made.raw).toBe(200);
    const diff = await plan(stackId, { templateVersionId: v2 });
    expect(diff.status, diff.raw).toBe(200);
    expect(diff.body.data).toMatchObject({
      ingress: [
        { componentKey: "app", port: 8080, change: "removed" },
        { componentKey: "app", port: 8081, change: "added" },
      ],
      downtime: true,
      dataRisk: true,
    });
    await addAppStackDomainsTransactional(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId,
      entries: [{ hostname: "notes-up.example.test", componentKey: "app", internalPort: 8080 }],
    });
    before = await h.counts();
    const removed = { field: "domains", reason: "domain_target_removed" };
    expectRefusal(await upgrade(v2, diff.body.data.planHash as string), 400, "VALIDATION_ERROR", removed);
    expectRefusal(await plan(stackId, { templateVersionId: v2 }), 400, "VALIDATION_ERROR", removed);
    expect(await h.counts()).toEqual(before);
    expect((await revisions(stackId)).length).toBe(1);
  });

  it("a draft on a version that is no longer the default is never offered or given an upgrade: it is installed again", async () => {
    const { templateId, versionId: v1 } = await h.publish(STORAGE_SOURCE);
    const draftId = await create({ templateVersionId: v1, name: "draft-behind", deploy: false });
    const deployedId = await create({ templateVersionId: v1, name: "deployed-behind", deploy: true });
    await settle(deployedId);
    const v2 = await addVersion(templateId, STORAGE_V2, true);
    const detail = (stackId: string) => h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-stacks/${stackId}`);
    expect((await detail(draftId)).body.data.upgrade).toBeNull();
    expect((await detail(deployedId)).body.data.upgrade).toEqual({ templateVersionId: v2, versionNumber: 2 });

    const before = await h.counts();
    const message = "This version can no longer be installed. Remove this draft and install the application again: a draft has no data, so nothing is lost.";
    const outdated = (res: Reply) => {
      expectRefusal(res, 400, "VALIDATION_ERROR", { field: "templateVersionId", reason: "STACK_TEMPLATE_UNPUBLISHED", message });
      expect(res.body.error.message).toBe(message);
    };
    outdated(await queue(draftId, "deploy", {}));
    outdated(await plan(draftId, {}));
    outdated(await plan(draftId, { templateVersionId: v2 }));
    outdated(await queue(draftId, "upgrade", { templateVersionId: v2, planHash: OTHER_HASH }));
    expect(await h.counts()).toEqual(before);
    expect((await stackRow(draftId)).status).toBe("draft");

    // A stack that was deployed keeps the way forward it always had.
    const changed = await queue(deployedId, "deploy", { parameters: [{ key: "worker_interval_seconds", value: 25 }] });
    expectRefusal(changed, 400, "VALIDATION_ERROR", { reason: "STACK_TEMPLATE_UNPUBLISHED", message: "Install the current version with an upgrade first." });
  });

  it("rollback refuses an unknown or current revision, a changed plan, software no longer allowed and a removed target, writing nothing", async () => {
    const { templateId, versionId: v1 } = await h.publish();
    const stackId = await notesRunning(v1);
    const otherStack = await notesRunning(v1);
    const [otherRevision] = await revisions(otherStack);
    const v2 = await addVersion(templateId, NOTES_MOVED, true);
    const diff = await plan(stackId, { templateVersionId: v2 });
    expect((await queue(stackId, "upgrade", { templateVersionId: v2, planHash: diff.body.data.planHash })).status).toBe(202);
    await settle(stackId);
    const [rev1, rev2] = await revisions(stackId);

    const before = await h.counts();
    const rollback = (revisionId: string, planHash: string) => queue(stackId, "rollback", { revisionId, planHash });
    const unknown = { field: "revisionId", reason: "unknown_revision" };
    expectRefusal(await rollback(otherRevision!.id, otherRevision!.planHash), 400, "VALIDATION_ERROR", unknown);
    expectRefusal(await plan(stackId, { revisionId: otherRevision!.id }), 400, "VALIDATION_ERROR", unknown);
    expectRefusal(await rollback(rev2!.id, rev2!.planHash), 400, "VALIDATION_ERROR", { field: "revisionId", reason: "already_current" });
    expectRefusal(await rollback(rev1!.id, OTHER_HASH), 400, "VALIDATION_ERROR", { field: "planHash", reason: "plan_changed" });

    const saved = [...allowlist];
    const cache = allowlist.findIndex((entry) => entry.repository === "registry.example.invalid/demo/cache");
    const row = allowlist[cache]!;
    try {
      allowlist[cache] = { ...row, runAsUser: "1000:1000" };
      const notAllowed = { field: "revisionId", reason: "STACK_IMAGE_NOT_ALLOWED" };
      expectRefusal(await rollback(rev1!.id, rev1!.planHash), 400, "VALIDATION_ERROR", notAllowed);
      expectRefusal(await plan(stackId, { revisionId: rev1!.id }), 400, "VALIDATION_ERROR", notAllowed);
      allowlist.splice(cache, 1);
      expectRefusal(await rollback(rev1!.id, rev1!.planHash), 400, "VALIDATION_ERROR", { reason: "STACK_TEMPLATE_INVALID" });
    } finally {
      allowlist.splice(0, allowlist.length, ...saved);
    }
    expect(await h.counts()).toEqual(before);

    const [domain] = await addAppStackDomainsTransactional(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId,
      entries: [{ hostname: "notes-back.example.test", componentKey: "app", internalPort: 8081 }],
    });
    const withDomain = await h.counts();
    const removed = { field: "domains", reason: "domain_target_removed" };
    expectRefusal(await rollback(rev1!.id, rev1!.planHash), 400, "VALIDATION_ERROR", removed);
    expectRefusal(await plan(stackId, { revisionId: rev1!.id }), 400, "VALIDATION_ERROR", removed);
    expect(await h.counts()).toEqual(withDomain);
    await h.dbClient.db.delete(appStackDomains).where(eq(appStackDomains.id, domain!.id));

    // With the address gone and the software allowed again, the same rollback is accepted.
    expect((await rollback(rev1!.id, rev1!.planHash)).status).toBe(202);
    expect((await revisions(stackId)).map((r) => r.planHash)).toEqual([rev1!.planHash, rev2!.planHash, rev1!.planHash]);
  });
});
