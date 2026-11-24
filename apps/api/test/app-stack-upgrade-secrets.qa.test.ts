/**
 * An upgrade to a version that brings a required private value the customer types (issue #89): the review names it, the
 * upgrade request carries it, it is stored as version 1 in the transaction that queues the upgrade and it travels nowhere
 * else. Original templates with invented values.
 */
import { randomUUID } from "node:crypto";
import {
  APP_BUILT_IN_TEMPLATES,
  APP_IMAGE_ALLOWLIST,
  APP_STACK_SECRET_ENV_LIMITS,
  ApprovedStackPlanSchema,
  appStackPlanSecretRefs,
} from "@hosting-panel/contracts";
import {
  and,
  appStackRevisions,
  appStackSecrets,
  appStacks,
  asc,
  auditEvents,
  desc,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  readAppStackSecretFiles,
  resourceQuotas,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, APP_TEST_MASTER_KEY, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

/** Version 1: a periodic job with no private value at all. */
const JOB_V1 = APP_BUILT_IN_TEMPLATES[1]!.source;
/**
 * Version 2, in the extended format: a required mail password the customer types (in the worker's environment), an
 * optional token, and a session key the platform generates and nobody sees.
 */
const JOB_V2 = JOB_V1.replace("schemaVersion: 1", "schemaVersion: 2")
  .replace(
    "services:\n",
    [
      "  - key: mail_password",
      "    label: Mail password",
      "    type: secret",
      "    required: true",
      "    customer: true",
      "  - key: api_token",
      "    label: API token",
      "    type: secret",
      "    required: false",
      "    customer: true",
      "  - key: session_key",
      "    label: Session key",
      "    type: secret",
      "    required: true",
      "    customer: false",
      "    generate:",
      "      kind: base64",
      "      length: 32",
      "services:",
      "",
    ].join("\n"),
  )
  .replace(
    "    depends_on:\n      - storage\n",
    [
      "    depends_on:",
      "      - storage",
      "    environment:",
      "      - name: MAIL_PASSWORD",
      "        secret: mail_password",
      "      - name: API_TOKEN",
      "        secret: api_token",
      "      - name: SESSION_KEY",
      "        secret: session_key",
      "",
    ].join("\n"),
  );
if (!JOB_V2.includes("MAIL_PASSWORD") || !JOB_V2.includes("mail_password\n    label")) throw new Error("the job template fixture lost its secret");

const MAIL_PASSWORD = "Upgrade-typed mail password 7f3a";
const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
const spellings = (value: string): string[] => [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex"), encodeURIComponent(value)];
function expectNoValue(text: string, value: string, what: string): void {
  for (const form of new Set(spellings(value))) expect(text.includes(form), `${what} holds a secret value`).toBe(false);
}
function expectRefusal(res: Reply, status: number, detail: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("an upgrade to a version that adds a required private value (issue #89)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  const printed: string[] = [];

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    printed.length = 0;
  });

  afterAll(async () => {
    await h?.close();
  });

  const stacks = () => `/v1/organizations/${h.a.orgId}/app-stacks`;
  const idem = (key: string = randomUUID()) => ({ "Idempotency-Key": key });
  const worker = () => h.app.nestApp.get(OutboxWorkerService);
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const secretRows = (stackId: string) =>
    h.dbClient.db
      .select()
      .from(appStackSecrets)
      .where(eq(appStackSecrets.stackId, stackId))
      .orderBy(asc(appStackSecrets.parameterKey), asc(appStackSecrets.version));
  const versionsOf = async (stackId: string) => (await secretRows(stackId)).map((row) => `${row.parameterKey}:${String(row.version)}`);
  const audits = (action: string, targetId: string) =>
    h.dbClient.db.select().from(auditEvents).where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, targetId)));
  const envOf = (stackId: string, component: string): string[] =>
    [...((sim.appStacks.getAppStackSnapshot(stackId)!.containers[component]!.payload as { Env?: readonly string[] }).Env ?? [])];
  const plan = (stackId: string, templateVersionId: string) => h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, { templateVersionId });
  const upgrade = (stackId: string, body: Json, key?: string) => h.call(h.a.token, "POST", `${stacks()}/${stackId}/upgrade`, body, idem(key));
  const upgradeOps = async (stackId: string) =>
    (await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId)).orderBy(asc(operations.submittedAt)))
      .filter((o) => o.kind === "stack.upgrade")
      .map((o) => o.status);

  async function valueOf(stackId: string, parameterKey: string, version = 1): Promise<string> {
    const [file] = await readAppStackSecretFiles(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId,
      masterKey: APP_TEST_MASTER_KEY,
      refs: [{ parameterKey, version }],
    });
    return file!.content;
  }

  function capture(): void {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      });
    }
  }

  async function runUntilSettled(stackId: string): Promise<void> {
    const open = async () =>
      (await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId))).filter((o) => !["succeeded", "failed"].includes(o.status));
    for (let round = 0; round < 10 && (await open()).length > 0; round += 1) await worker().processPendingOnce();
    expect((await open()).map((o) => o.status)).toEqual([]);
    expect((await stackRow(stackId)).status).toBe("running");
  }

  /** Version 1 installed and running, version 2 published as the default. */
  async function installed(name: string): Promise<{ stackId: string; v1: string; v2: string }> {
    const { templateId, versionId: v1 } = await h.publish(JOB_V1);
    const created = await h.call(
      h.a.token,
      "POST",
      stacks(),
      { templateVersionId: v1, name, deploy: true, parameters: [{ key: "worker_interval_seconds", value: 15 }] },
      idem(),
    );
    expect(created.status, created.raw).toBe(202);
    const stackId = created.body.data.stackId as string;
    await runUntilSettled(stackId);
    const added = await h.call(h.adminToken, "POST", `/v1/admin/app-templates/${templateId}/versions`, { source: JOB_V2, makeDefault: true });
    expect(added.status, added.raw).toBe(201);
    return { stackId, v1, v2: added.body.data.versionId as string };
  }

  it("the review names the private value the new version needs, by key and label, and writes nothing", async () => {
    const { stackId, v2 } = await installed("job-review");
    const before = await h.counts();
    const diff = await plan(stackId, v2);
    expect(diff.status, diff.raw).toBe(200);
    // Only the required value the customer types: not the optional token, not the generated key.
    expect(diff.body.data.newSecrets).toEqual([{ key: "mail_password", label: "Mail password" }]);
    expect(diff.raw).not.toContain("session_key");
    const again = await plan(stackId, v2);
    expect(again.body.data.planHash).toBe(diff.body.data.planHash);
    expect(await h.counts()).toEqual(before);
    // The detail offers the upgrade; nothing is set yet.
    expect(await versionsOf(stackId)).toEqual([]);
  }, 120_000);

  it("an upgrade without the value is refused at the request, next to that value, and stores nothing", async () => {
    const { stackId, v2 } = await installed("job-missing");
    const diff = await plan(stackId, v2);
    expect(diff.status, diff.raw).toBe(200);
    const before = await h.counts();
    const res = await upgrade(stackId, { templateVersionId: v2, planHash: diff.body.data.planHash as string });
    expectRefusal(res, 400, { field: "secrets.mail_password", reason: "STACK_SECRET_MISSING" });
    expect(await h.counts()).toEqual(before);
    expect(await stackRow(stackId)).toMatchObject({ status: "running" });
  }, 120_000);

  it("refuses a value the upgrade does not need, a value too long for the environment and a repeated key, storing nothing", async () => {
    const { stackId, v2 } = await installed("job-refusals");
    const diff = await plan(stackId, v2);
    const planHash = diff.body.data.planHash as string;
    const before = await h.counts();
    const withValues = (secrets: Json[]) => upgrade(stackId, { templateVersionId: v2, planHash, secrets });
    const mail = { parameterKey: "mail_password", value: MAIL_PASSWORD };

    // A key the version does not declare and a generated one the customer never sees: the same answer.
    const unknown = await withValues([mail, { parameterKey: "no_such_key", value: "x" }]);
    expectRefusal(unknown, 400, { field: "secrets.no_such_key", reason: "STACK_PARAMETER_INVALID" });
    const hidden = await withValues([mail, { parameterKey: "session_key", value: "x" }]);
    expectRefusal(hidden, 400, { field: "secrets.session_key", reason: "STACK_PARAMETER_INVALID" });
    const strip = (res: Reply) => (res.body.error.details as Json[]).map((d) => ({ ...d, field: String(d.field).replace(/^secrets\.\w+$/, "secrets.*") }));
    expect(strip(hidden)).toEqual(strip(unknown));
    // An optional value is set after the upgrade, among the private values.
    expectRefusal(await withValues([mail, { parameterKey: "api_token", value: "x" }]), 400, {
      field: "secrets.api_token",
      reason: "secret_not_needed",
    });
    // The environment limit of the extended format, with the reason the page explains.
    const long = await withValues([{ parameterKey: "mail_password", value: "x".repeat(APP_STACK_SECRET_ENV_LIMITS.secretBytes + 1) }]);
    expectRefusal(long, 400, { field: "secrets.mail_password", reason: "value_too_long" });
    expect((await withValues([mail, mail])).status).toBe(400);
    expect((await withValues([{ parameterKey: "mail_password", value: "" }])).status).toBe(400);
    expect((await withValues([{ parameterKey: "mail_password", value: "a\u0000b" }])).status).toBe(400);

    expect(await h.counts()).toEqual(before);
    expect(await versionsOf(stackId)).toEqual([]);
  }, 120_000);

  it("with the value the upgrade is queued, the value is version 1 of an ordinary private value, and it travels only to the executor", async () => {
    const { stackId, v2 } = await installed("job-upgrade");
    const diff = await plan(stackId, v2);
    expect(diff.status, diff.raw).toBe(200);
    capture();
    const key = randomUUID();
    const body = { templateVersionId: v2, planHash: diff.body.data.planHash as string, secrets: [{ parameterKey: "mail_password", value: MAIL_PASSWORD }] };
    const queued = await upgrade(stackId, body, key);
    expect(queued.status, queued.raw).toBe(202);
    expect(await versionsOf(stackId)).toEqual(["mail_password:1", "session_key:1"]);
    expect(await valueOf(stackId, "mail_password")).toBe(MAIL_PASSWORD);

    // The same request again replays it: the same operation, nothing stored twice, even with another value typed.
    const replay = await upgrade(stackId, body, key);
    expect(replay.status, replay.raw).toBe(202);
    expect(replay.body.data.operationId).toBe(queued.body.data.operationId);
    const retyped = await upgrade(stackId, { ...body, secrets: [{ parameterKey: "mail_password", value: "another value" }] }, key);
    expect(retyped.status, retyped.raw).toBe(202);
    expect(retyped.body.data.operationId).toBe(queued.body.data.operationId);
    expect(await versionsOf(stackId)).toEqual(["mail_password:1", "session_key:1"]);
    expect(await valueOf(stackId, "mail_password")).toBe(MAIL_PASSWORD);

    // The audit names the key and its version, as the private values route does.
    const rotated = await audits("app.stack.secret.rotate", stackId);
    expect(rotated.map((row) => row.details)).toEqual([expect.objectContaining({ parameterKey: "mail_password", version: 1 })]);
    expect(Object.keys(rotated[0]!.details as Json).sort()).toEqual(["outcome", "parameterKey", "requestId", "version"]);
    expect(await audits("app.stack.upgrade", stackId)).toHaveLength(1);

    await runUntilSettled(stackId);
    expect(await upgradeOps(stackId)).toEqual(["succeeded"]);
    const [revision] = await h.dbClient.db
      .select()
      .from(appStackRevisions)
      .where(eq(appStackRevisions.stackId, stackId))
      .orderBy(desc(appStackRevisions.revisionNumber))
      .limit(1);
    expect(appStackPlanSecretRefs(ApprovedStackPlanSchema.parse(revision!.plan))).toEqual([
      { parameterKey: "mail_password", version: 1 },
      { parameterKey: "session_key", version: 1 },
    ]);
    expect(envOf(stackId, "worker")).toContain(`MAIL_PASSWORD=${MAIL_PASSWORD}`);
    expect(envOf(stackId, "worker").some((entry) => entry.startsWith("API_TOKEN="))).toBe(false);

    // The private values section now lists it as set, and the page can replace it as usual.
    const detail = await h.call(h.a.token, "GET", `${stacks()}/${stackId}`);
    expect(detail.status, detail.raw).toBe(200);
    expect((detail.body.data.secretParameters as Json[]).map((s) => [s.key, s.isSet, s.version])).toEqual([
      ["mail_password", true, 1],
      ["api_token", false, null],
    ]);

    const db = h.dbClient.db;
    for (const [what, rows] of [
      ["operations", await db.select().from(operations).where(eq(operations.resourceId, stackId))],
      ["operation_steps", await db.select().from(operationSteps)],
      ["outbox_events", await db.select().from(outboxEvents)],
      ["audit_events", await db.select().from(auditEvents)],
      ["app_stack_revisions", await db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId))],
    ] as const) {
      expectNoValue(json(rows), MAIL_PASSWORD, what);
    }
    for (const res of [diff, queued, replay, retyped, detail]) expectNoValue(res.raw, MAIL_PASSWORD, "an answer");
    expectNoValue(printed.join("\n"), MAIL_PASSWORD, "console output");
    for (const row of await secretRows(stackId)) expectNoValue(json(row), MAIL_PASSWORD, "an app_stack_secrets row");
  }, 120_000);

  it("an upgrade taken back before create keeps the value: the review no longer asks for it and the next attempt needs none", async () => {
    const { stackId, v1, v2 } = await installed("job-retry");
    const diff = await plan(stackId, v2);
    const planHash = diff.body.data.planHash as string;

    sim.appStacks.failNextAppStackStep("pull", "pull_failed");
    const failed = await upgrade(stackId, { templateVersionId: v2, planHash, secrets: [{ parameterKey: "mail_password", value: MAIL_PASSWORD }] });
    expect(failed.status, failed.raw).toBe(202);
    await runUntilSettled(stackId);
    expect(await upgradeOps(stackId)).toEqual(["failed"]);
    expect(await stackRow(stackId)).toMatchObject({ templateVersionId: v1 });
    expect(await versionsOf(stackId)).toEqual(["mail_password:1", "session_key:1"]);

    const again = await plan(stackId, v2);
    expect(again.status, again.raw).toBe(200);
    expect(again.body.data.newSecrets).toEqual([]);
    expect(again.body.data.planHash).toBe(planHash);
    // The value is stored: giving it again is refused, as for any value the application has.
    expectRefusal(await upgrade(stackId, { templateVersionId: v2, planHash, secrets: [{ parameterKey: "mail_password", value: "other" }] }), 400, {
      field: "secrets.mail_password",
      reason: "secret_not_needed",
    });
    const retried = await upgrade(stackId, { templateVersionId: v2, planHash });
    expect(retried.status, retried.raw).toBe(202);
    expect(await versionsOf(stackId)).toEqual(["mail_password:1", "session_key:1"]);
    expect(await audits("app.stack.secret.rotate", stackId)).toHaveLength(1);
    await runUntilSettled(stackId);
    expect(await upgradeOps(stackId)).toEqual(["failed", "succeeded"]);
    expect(envOf(stackId, "worker")).toContain(`MAIL_PASSWORD=${MAIL_PASSWORD}`);
  }, 120_000);

  it("a rollback and a redeploy take no private value", async () => {
    const { stackId, v2 } = await installed("job-back");
    const diff = await plan(stackId, v2);
    const queued = await upgrade(stackId, {
      templateVersionId: v2,
      planHash: diff.body.data.planHash as string,
      secrets: [{ parameterKey: "mail_password", value: MAIL_PASSWORD }],
    });
    expect(queued.status, queued.raw).toBe(202);
    await runUntilSettled(stackId);
    const deploy = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/deploy`, { secrets: [] }, idem());
    expect(deploy.status, deploy.raw).toBe(400);
    const detail = await h.call(h.a.token, "GET", `${stacks()}/${stackId}`);
    const { revisionId } = detail.body.data.rollback as Json;
    const back = await h.call(h.a.token, "POST", `${stacks()}/${stackId}/plan`, { revisionId });
    expect(back.status, back.raw).toBe(200);
    expect(back.body.data.newSecrets).toEqual([]);
    const refused = await h.call(
      h.a.token,
      "POST",
      `${stacks()}/${stackId}/rollback`,
      { revisionId, planHash: back.body.data.planHash, secrets: [] },
      idem(),
    );
    expect(refused.status, refused.raw).toBe(400);
  }, 120_000);
});
