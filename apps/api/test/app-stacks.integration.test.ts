import { randomBytes, randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  and,
  appStackDeployments,
  appStackParameters,
  appStackRevisions,
  appStacks,
  appStackSecrets,
  appStackVolumes,
  auditEvents,
  eq,
  isNull,
  operations,
  operationSteps,
  outboxEvents,
  resourceQuotas,
  rolePermissions,
  roles,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import {
  APP_TEST_ALLOWLIST,
  NOTES_DEMO_SOURCE,
  startAppStackHarness,
  type AppStackHarness,
  type HarnessCustomer,
} from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

const NOT_FOUND = "Requested organization or resource was not found.";
/** notes-demo plus a parameter only the template sets. */
const LOCKED_SOURCE = NOTES_DEMO_SOURCE.replace(
  "x-hp-parameters:\n",
  "x-hp-parameters:\n  - key: edition\n    label: Edition\n    type: string\n    default: basic\n    customer: false\n",
);
/** No secret, images on the code allowlist: the runtime and the simulator accept it. */
const WEB_SOURCE = APP_BUILT_IN_TEMPLATES[0]!.source;
const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("application stacks HTTP API (H5)", () => {
  let h: AppStackHarness;
  let notes: string;
  let locked: string;
  let web: string;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    // Room for every stack the cases below queue (they are never removed by a runtime).
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    notes = (await h.publish()).versionId;
    locked = (await h.publish(LOCKED_SOURCE)).versionId;
    web = (await h.publish(WEB_SOURCE)).versionId;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const base = (c: HarnessCustomer) => `/v1/organizations/${c.orgId}/app-stacks`;
  const idem = (key: string = randomUUID()) => ({ "Idempotency-Key": key });
  const create = (c: HarnessCustomer, body: Json, key?: string) => h.call(c.token, "POST", base(c), body, idem(key));
  const act = (c: HarnessCustomer, stackId: string, verb: string, body: unknown = {}, key?: string) =>
    h.call(c.token, "POST", `${base(c)}/${stackId}/${verb}`, body, idem(key));
  const remove = (stackId: string, body: Json, key?: string) => h.call(h.a.token, "DELETE", `${base(h.a)}/${stackId}`, body, idem(key));
  const setSecret = (stackId: string, value: string) =>
    h.call(h.a.token, "POST", `${base(h.a)}/${stackId}/secrets`, { parameterKey: "app_secret", value });
  const revisions = (stackId: string) => h.dbClient.db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId));
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const audits = async (action: string, targetId: string) =>
    h.dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)));

  async function draft(name = `app-${randomUUID().slice(0, 8)}`, versionId = notes): Promise<string> {
    const res = await create(h.a, { templateVersionId: versionId, name, deploy: false });
    expect(res.status, res.raw).toBe(201);
    expect(res.body.links).toEqual({ stack: `${base(h.a)}/${res.body.data.stackId as string}`, operation: null });
    return res.body.data.stackId as string;
  }

  /** A notes stack whose revision 1 is queued. */
  async function deployed(name?: string): Promise<string> {
    const stackId = await draft(name);
    expect((await setSecret(stackId, "first-value")).status).toBe(200);
    expect((await act(h.a, stackId, "deploy")).status).toBe(202);
    return stackId;
  }

  /** The outbox is never processed here (rows, not runtime outcomes): end the operations as a runtime would. */
  async function settle(stackId: string, status: "running" | "stopped"): Promise<void> {
    await h.dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.resourceId, stackId));
    await h.dbClient.db.update(appStacks).set({ status }).where(eq(appStacks.id, stackId));
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

  it("A3: a customer:false parameter is refused at create (draft and deploy) and at deploy, and nothing is written", async () => {
    const before = await h.counts();
    for (const deploy of [false, true]) {
      const res = await create(h.a, {
        templateVersionId: locked,
        name: `locked-${String(deploy)}`,
        deploy,
        parameters: [{ key: "edition", value: "pro" }],
      });
      expectRefusal(res, 400, "VALIDATION_ERROR", { field: "parameters.edition", reason: "STACK_PARAMETER_INVALID" });
    }
    expect(await h.counts()).toEqual(before);

    const stackId = await draft("locked", locked);
    expect((await setSecret(stackId, "value-1")).status).toBe(200);
    const ready = await h.counts();
    const res = await act(h.a, stackId, "deploy", { parameters: [{ key: "edition", value: "pro" }] });
    expectRefusal(res, 400, "VALIDATION_ERROR", { field: "parameters.edition", reason: "STACK_PARAMETER_INVALID" });
    expect(await h.counts()).toEqual(ready);
  });

  it("A8: a secret value is in no response, public row, outbox payload, audit row or console line", async () => {
    const canary = randomBytes(30).toString("base64url").slice(0, 40);
    const printed: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      }),
    );
    try {
      const stackId = await draft("secret-app");
      const set = await setSecret(stackId, canary);
      expect(set.status, set.raw).toBe(200);
      expect(set.body.data).toEqual({ key: "app_secret", isSet: true, version: 1, setAt: expect.any(String) });
      const deploy = await act(h.a, stackId, "deploy");
      expect(deploy.status, deploy.raw).toBe(202);
      const list = await h.call(h.a.token, "GET", base(h.a));
      const detail = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}`);
      const history = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/deployments`);
      for (const res of [set, deploy, list, detail, history]) {
        expect(res.status, res.raw).toBeLessThan(300);
        expect(res.raw).not.toContain(canary);
      }
      expect(list.body.data.map((s: Json) => s.id)).toContain(stackId);
      expect(detail.body.data.secretParameters).toEqual([expect.objectContaining({ key: "app_secret", isSet: true, version: 1 })]);
      expect(history.body.data).toEqual([expect.objectContaining({ kind: "stack.deploy", revisionNumber: 1, status: "queued" })]);

      const db = h.dbClient.db;
      for (const table of [auditEvents, outboxEvents, operations, operationSteps, appStackRevisions, appStackParameters, appStackDeployments]) {
        expect(json(await db.select().from(table))).not.toContain(canary);
      }
      const stored = json(await db.select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId)));
      expect(stored).not.toContain(canary);
      expect(stored).not.toContain(Buffer.from(canary).toString("base64"));

      const tooLong = randomBytes(12_300).toString("base64url").slice(0, 16_385);
      const refused = await setSecret(stackId, tooLong);
      expect(refused.status).toBe(400);
      expect(refused.raw).not.toContain(tooLong.slice(0, 32));
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(printed.join("\n")).not.toContain(canary);
  });

  it("A16: one Idempotency-Key gives one operation for create, start and delete; another request with it is a conflict", async () => {
    const key = randomUUID();
    const body = { templateVersionId: web, name: "replayed", deploy: true };
    const before = await h.counts();
    const first = await create(h.a, body, key);
    const again = await create(h.a, body, key);
    expect(first.status, first.raw).toBe(202);
    expect(again.status).toBe(202);
    expect(again.body).toEqual(first.body);
    const { stackId, operationId } = first.body.data as { stackId: string; operationId: string };
    expect(first.body.links).toEqual({ stack: `${base(h.a)}/${stackId}`, operation: `/v1/organizations/${h.a.orgId}/operations/${operationId}` });
    const after = await h.counts();
    expect([after.app_stacks! - before.app_stacks!, after.operations! - before.operations!, after.outbox_events! - before.outbox_events!]).toEqual([
      1, 1, 1,
    ]);
    expect(await audits("app.stack.create", stackId)).toHaveLength(1);
    expectRefusal(await create(h.a, { ...body, name: "other" }, key), 409, "IDEMPOTENCY_CONFLICT");

    const together = randomUUID();
    const [x, y] = await sentTogether([
      () => create(h.a, { ...body, name: "together" }, together),
      () => create(h.a, { ...body, name: "together" }, together),
    ]);
    expect([x.status, y.status]).toEqual([202, 202]);
    expect(y.body.data.operationId).toBe(x.body.data.operationId);

    const stopped = await draft("start-twice");
    await settle(stopped, "stopped");
    const startKey = randomUUID();
    const start = await act(h.a, stopped, "start", {}, startKey);
    const replay = await act(h.a, stopped, "start", {}, startKey);
    expect(start.status, start.raw).toBe(202);
    expect(replay.body).toEqual(start.body);
    expectRefusal(await act(h.a, stopped, "stop", {}, startKey), 409, "IDEMPOTENCY_CONFLICT");

    await settle(stopped, "stopped");
    const deleteKey = randomUUID();
    const deleted = await remove(stopped, { confirmName: "start-twice", destroyData: false }, deleteKey);
    const deletedAgain = await remove(stopped, { confirmName: "start-twice", destroyData: false }, deleteKey);
    expect(deleted.status, deleted.raw).toBe(202);
    expect(deletedAgain.body).toEqual(deleted.body);
    expectRefusal(await remove(stopped, { confirmName: "start-twice", destroyData: true }, deleteKey), 409, "IDEMPOTENCY_CONFLICT");
    const kinds = (await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stopped))).map((op) => op.kind).sort();
    expect(kinds).toEqual(["stack.delete", "stack.start"]);
    expect(await audits("app.stack.start", stopped)).toHaveLength(1);
    expect(await audits("app.stack.delete", stopped)).toHaveLength(1);
  });

  it("S5-L1: a create or a deploy retried with its key is replayed after its version stopped being the default", async () => {
    const addDefault = async (templateId: string, source: string) => {
      const res = await h.call(h.adminToken, "POST", `/v1/admin/app-templates/${templateId}/versions`, { source, makeDefault: true });
      expect(res.status, res.raw).toBe(201);
    };
    const site = await h.publish(WEB_SOURCE);
    const body = { templateVersionId: site.versionId, name: "replayed-after-change", deploy: true };
    const createKey = randomUUID();
    const created = await create(h.a, body, createKey);
    expect(created.status, created.raw).toBe(202);
    const app = await h.publish();
    const stackId = await draft("deploy-replayed", app.versionId);
    expect((await setSecret(stackId, "value-1")).status).toBe(200);
    const deployKey = randomUUID();
    const deployed = await act(h.a, stackId, "deploy", {}, deployKey);
    expect(deployed.status, deployed.raw).toBe(202);

    await addDefault(site.templateId, WEB_SOURCE.replace("memory: 64M", "memory: 96M"));
    await addDefault(app.templateId, NOTES_DEMO_SOURCE.replace("memory: 256M", "memory: 128M"));
    // A rotated secret changes the plan, so the preflight of the retried deploy would want a new revision.
    expect((await setSecret(stackId, "value-2")).status).toBe(200);
    const before = await h.counts();
    const createdAgain = await create(h.a, body, createKey);
    expect(createdAgain.status, createdAgain.raw).toBe(202);
    expect(createdAgain.body).toEqual(created.body);
    const deployedAgain = await act(h.a, stackId, "deploy", {}, deployKey);
    expect(deployedAgain.status, deployedAgain.raw).toBe(202);
    expect(deployedAgain.body).toEqual(deployed.body);
    expect(await h.counts()).toEqual(before);
    expectRefusal(await create(h.a, { ...body, name: "other" }, createKey), 409, "IDEMPOTENCY_CONFLICT");
    expectRefusal(await act(h.a, stackId, "deploy", { parameters: [{ key: "worker_count", value: 3 }] }, deployKey), 409, "IDEMPOTENCY_CONFLICT");
  });

  it("S5-M1: the 11th secret value of a stack within an hour is 429 RATE_LIMITED and stores nothing", async () => {
    const stackId = await draft();
    for (let i = 1; i <= 10; i += 1) expect((await setSecret(stackId, `value-${String(i)}`)).status).toBe(200);
    const before = await h.counts();
    const res = await setSecret(stackId, "value-11");
    expectRefusal(res, 429, "RATE_LIMITED");
    expect(res.body.error.retryable).toBe(true);
    expect(res.raw).not.toContain("app_secret");
    expect(await h.counts()).toEqual(before);
    expect((await setSecret(await draft(), "value-1")).status).toBe(200);
  });

  it("S5-L2: a deploy that changes settings also needs app.update; without settings app.control is enough", async () => {
    await h.dbClient.db.insert(roles).values({ id: "role_app_operator", name: "app_operator" as never, description: "Operate only", isPreset: false });
    await h.dbClient.db.insert(rolePermissions).values([
      { roleId: "role_app_operator", permissionKey: "app.read" },
      { roleId: "role_app_operator", permissionKey: "app.control" },
    ]);
    const operator = await h.addMember(h.a.orgId, "role_app_operator" as "role_customer_collaborator");
    const stackId = await draft();
    expect((await setSecret(stackId, "value-1")).status).toBe(200);
    const before = await h.counts();
    expectRefusal(await act(operator, stackId, "deploy", { parameters: [{ key: "worker_count", value: 3 }] }), 403, "PERMISSION_DENIED");
    expect({ ...(await h.counts()), audit_events: 0 }).toEqual({ ...before, audit_events: 0 });
    const denied = await h.dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorId, operator.userId), eq(auditEvents.targetType, "app_stack")));
    expect(denied.map((row) => [row.action, row.targetId, (row.details as Json).outcome])).toEqual([["app.update", stackId, "denied"]]);
    const res = await act(operator, stackId, "deploy");
    expect(res.status, res.raw).toBe(202);
  });

  it("#17: a malformed deploy body is answered only after app.control allowed the caller", async () => {
    await h.dbClient.db.insert(roles).values({ id: "role_app_controller", name: "app_controller" as never, description: "Control only", isPreset: false });
    await h.dbClient.db.insert(rolePermissions).values({ roleId: "role_app_controller", permissionKey: "app.control" });
    const controller = await h.addMember(h.a.orgId, "role_app_controller" as "role_customer_collaborator");
    const stackId = await draft();
    const before = await h.counts();
    expectRefusal(await act(controller, stackId, "deploy", "{not json"), 400, "VALIDATION_ERROR");
    expectRefusal(await h.call(h.b.token, "POST", `${base(h.a)}/${stackId}/deploy`, "{not json", idem()), 404, "NOT_FOUND");
    expect(await h.counts()).toEqual(before);
  });

  const STACK_ROUTES: readonly (readonly [string, string, unknown?])[] = [
    ["GET", ""],
    ["POST", "/deploy", {}],
    ["POST", "/start", {}],
    ["POST", "/stop", {}],
    ["POST", "/restart", {}],
    ["DELETE", "", { confirmName: "x", destroyData: false }],
    ["GET", "/deployments"],
    ["GET", "/components/app/logs"],
    ["GET", "/components/app/health"],
    ["POST", "/secrets", { parameterKey: "app_secret", value: "v" }],
    ["GET", "/backups"],
    ["POST", "/backups", {}],
    ["POST", `/backups/sbak_${"0".repeat(24)}/restore`, { confirmName: "x" }],
  ];

  it("B1: another organisation gets 404 on every route of a stack; a collaborator without the key gets 403 and one denied row", async () => {
    const stackId = await draft();
    const before = await h.counts();
    for (const [method, suffix, body] of STACK_ROUTES) {
      for (const path of [`${base(h.b)}/${stackId}${suffix}`, `${base(h.a)}/${stackId}${suffix}`]) {
        const res = await h.call(h.b.token, method, path, body, idem());
        expectRefusal(res, 404, "NOT_FOUND");
        expect(res.body.error.message).toBe(NOT_FOUND);
        expect(res.raw).not.toContain(stackId);
      }
    }
    expect(await h.counts()).toEqual(before);

    const collaborator = await h.addMember(h.a.orgId, "role_customer_collaborator");
    for (const [method, suffix, body] of STACK_ROUTES) {
      expectRefusal(await h.call(collaborator.token, method, `${base(h.a)}/${stackId}${suffix}`, body, idem()), 403, "PERMISSION_DENIED");
    }
    const denied = await h.dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorId, collaborator.userId), eq(auditEvents.targetType, "app_stack")));
    expect(denied).toHaveLength(STACK_ROUTES.length);
    expect(denied.every((row) => row.targetId === stackId && (row.details as Json).outcome === "denied")).toBe(true);
    expect({ ...(await h.counts()), audit_events: 0 }).toEqual({ ...before, audit_events: 0 });
  });

  it("B4: on a server without backups a backup request is NOT_SUPPORTED and the list says why; a foreign one is 404", async () => {
    const stackId = await draft();
    const before = await h.counts();
    expectRefusal(await act(h.a, stackId, "backups"), 422, "NOT_SUPPORTED", { reason: "STACK_UNSUPPORTED_FEATURE" });
    const listed = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/backups`);
    expect(listed.status, listed.raw).toBe(200);
    expect(listed.body.data).toEqual({ backups: [], unavailableReason: "not_available", goBackTo: null });
    expectRefusal(await act(h.b, stackId, "backups"), 404, "NOT_FOUND");
    expectRefusal(await h.call(h.b.token, "GET", `${base(h.a)}/${stackId}/backups`), 404, "NOT_FOUND");
    expect(await h.counts()).toEqual(before);
  });

  it("a deploy without a change reuses the desired revision; after a secret rotation it builds a new one", async () => {
    const stackId = await deployed();
    const [first] = await revisions(stackId);
    await settle(stackId, "running");
    const same = await act(h.a, stackId, "deploy");
    expect(same.status, same.raw).toBe(202);
    expect(await revisions(stackId)).toHaveLength(1);
    const [deployment] = await h.dbClient.db
      .select()
      .from(appStackDeployments)
      .where(eq(appStackDeployments.id, same.body.data.deploymentId as string));
    expect(deployment!.revisionId).toBe(first!.id);
    expectRefusal(await act(h.a, stackId, "deploy"), 409, "RESOURCE_LOCKED");

    await settle(stackId, "running");
    expect((await setSecret(stackId, "second-value")).body.data.version).toBe(2);
    const rotated = await act(h.a, stackId, "deploy");
    expect(rotated.status, rotated.raw).toBe(202);
    expect((await revisions(stackId)).map((r) => r.revisionNumber).sort()).toEqual([1, 2]);
    expect((await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}`)).body.data.revisionNumber).toBe(2);
  });

  it("start, stop and restart are refused with 409 and the status where the status does not allow them", async () => {
    const stackId = await draft();
    const refusedIn = async (verb: string, status: string) => {
      const res = await act(h.a, stackId, verb);
      expectRefusal(res, 409, "RESOURCE_LOCKED", { field: "status", reason: status });
      expect(res.body.error.retryable).toBe(false);
    };
    for (const verb of ["start", "stop", "restart"]) await refusedIn(verb, "draft");
    await settle(stackId, "running");
    await refusedIn("start", "running");
    await settle(stackId, "stopped");
    await refusedIn("stop", "stopped");
    await refusedIn("restart", "stopped");
    expect(await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId))).toHaveLength(0);

    const start = await act(h.a, stackId, "start");
    expect(start.status, start.raw).toBe(202);
    expect(start.body.data.status).toBe("starting");
    const busy = await act(h.a, stackId, "stop");
    expectRefusal(busy, 409, "RESOURCE_LOCKED");
    expect(busy.body.error.retryable).toBe(true);
  });

  it("delete needs the exact name and keeps the data unless destroyData is true", async () => {
    const keep = await deployed("keep-me");
    const drop = await deployed("drop-me");
    await settle(keep, "running");
    await settle(drop, "running");
    const before = await h.counts();
    expectRefusal(await remove(keep, { confirmName: "Keep-me", destroyData: false }), 400, "VALIDATION_ERROR", {
      field: "confirmName",
      reason: "confirmation_mismatch",
    });
    expect(await h.counts()).toEqual(before);

    for (const [stackId, name, destroyData] of [
      [keep, "keep-me", false],
      [drop, "drop-me", true],
    ] as const) {
      const res = await remove(stackId, { confirmName: name, destroyData });
      expect(res.status, res.raw).toBe(202);
      expect(res.body.data.status).toBe("deleting");
      const volumes = await h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId));
      expect(volumes.map((v) => [v.volumeKey, v.retentionPolicy])).toEqual([["data", destroyData ? "destroy" : "retain"]]);
      const [audit] = await audits("app.stack.delete", stackId);
      expect(audit!.details).toMatchObject({ destroyData, operationId: res.body.data.operationId });
    }
  });

  it("logs: 404 for an unknown part, 422 without the stack port, 200 through the simulator", async () => {
    const created = await create(h.a, { templateVersionId: web, name: "with-logs", deploy: true });
    expect(created.status, created.raw).toBe(202);
    const stackId = created.body.data.stackId as string;
    const worker = h.app.nestApp.get(OutboxWorkerService);
    for (let round = 0; round < 10 && (await stackRow(stackId)).status !== "running"; round += 1) await worker.processPendingOnce();
    expect((await stackRow(stackId)).status).toBe("running");

    const sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    sim.appStacks.setAppStackComponentLogs(stackId, "web", [
      { at: "2026-11-22T10:00:00.000Z", stream: "stdout", text: "GET / 200" },
      { at: null, stream: "stderr", text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789" },
    ]);
    const logs = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/web/logs?tail=10`);
    expect(logs.status, logs.raw).toBe(200);
    expect(logs.body.data.componentKey).toBe("web");
    expect(logs.body.data.lines[0]).toEqual({ at: "2026-11-22T10:00:00.000Z", stream: "stdout", text: "GET / 200" });
    expect(logs.body.data.lines[1]).toMatchObject({ at: null, stream: "stderr" });
    expect(logs.raw).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");

    expectRefusal(await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/nope/logs`), 404, "NOT_FOUND");
    expectRefusal(await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/web/logs?tail=0`), 400, "VALIDATION_ERROR");
    Object.defineProperty(sim, "getAppStackComponentLogs", { value: undefined, configurable: true, writable: true });
    try {
      expectRefusal(await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/web/logs`), 422, "NOT_SUPPORTED", {
        reason: "STACK_UNSUPPORTED_FEATURE",
      });
    } finally {
      Reflect.deleteProperty(sim, "getAppStackComponentLogs");
    }
  });

  it("health of a draft is unknown and stale, with the probe kind its template declares", async () => {
    const stackId = await draft();
    const app = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/app/health`);
    expect(app.status, app.raw).toBe(200);
    expect(app.body.data).toEqual({ componentKey: "app", health: "unknown", observedAt: null, stale: true, source: "tcp" });
    const cache = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/cache/health`);
    expect(cache.body.data).toMatchObject({ componentKey: "cache", source: "running_state" });
    expectRefusal(await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/nope/health`), 404, "NOT_FOUND");
  });

  // Last: it leaves organisation B at its limit.
  it("B2: two creates at a limit of one: one is accepted, the other is QUOTA_EXCEEDED", async () => {
    const limit = await h.call(h.adminToken, "PATCH", `/v1/admin/organizations/${h.b.orgId}/app-stack-limit`, { maxAppStacks: 1 });
    expect(limit.status, limit.raw).toBe(200);
    const [x, y] = await sentTogether([
      () => create(h.b, { templateVersionId: web, name: "first", deploy: true }),
      () => create(h.b, { templateVersionId: web, name: "second", deploy: true }),
    ]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    expectRefusal(x.status === 409 ? x : y, 409, "QUOTA_EXCEEDED", { reason: "STACK_QUOTA_EXCEEDED" });
    const live = await h.dbClient.db
      .select()
      .from(appStacks)
      .where(and(eq(appStacks.organizationId, h.b.orgId), isNull(appStacks.deletedAt)));
    expect(live).toHaveLength(1);
  });
});

describe("application stacks with the capability off", () => {
  it("every route answers 422 NOT_SUPPORTED and writes nothing", async () => {
    const off = await startAppStackHarness({ appFeatures: {} });
    try {
      const before = await off.counts();
      const base = `/v1/organizations/${off.a.orgId}/app-stacks`;
      const stackId = "stk_0123456789abcdef01234567";
      const routes: [string, string, unknown?][] = [
        ["POST", base, { templateVersionId: "atv_x", name: "x", deploy: false }],
        ["GET", base],
        ["GET", `${base}/${stackId}`],
        ["POST", `${base}/${stackId}/deploy`, {}],
        ["POST", `${base}/${stackId}/start`, {}],
        ["POST", `${base}/${stackId}/stop`, {}],
        ["POST", `${base}/${stackId}/restart`, {}],
        ["DELETE", `${base}/${stackId}`, { confirmName: "x", destroyData: false }],
        ["GET", `${base}/${stackId}/deployments`],
        ["GET", `${base}/${stackId}/components/app/logs`],
        ["GET", `${base}/${stackId}/components/app/health`],
        ["POST", `${base}/${stackId}/secrets`, { parameterKey: "app_secret", value: "v" }],
        ["GET", `${base}/${stackId}/backups`],
        ["POST", `${base}/${stackId}/backups`, {}],
        ["POST", `${base}/${stackId}/backups/sbak_0123456789abcdef01234567/restore`, { confirmName: "x" }],
      ];
      for (const [method, path, body] of routes) {
        const res = await off.call(off.a.token, method, path, body, { "Idempotency-Key": randomUUID() });
        expectRefusal(res, 422, "NOT_SUPPORTED", { reason: "STACK_UNSUPPORTED_FEATURE" });
      }
      expect(await off.counts()).toEqual(before);
    } finally {
      await off.close();
    }
  }, 120_000);
});
