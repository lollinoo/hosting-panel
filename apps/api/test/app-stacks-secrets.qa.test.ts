import { randomBytes, randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  appStackRevisions,
  appStackSecrets,
  appStacks,
  and,
  asc,
  auditEvents,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  resourceQuotas,
  sql,
} from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

/** Built-in "web + cache" template (allowlisted images) with one required secret on web. */
const SECRET_WEB_SOURCE = APP_BUILT_IN_TEMPLATES[0]!.source
  .replace("services:\n", "  - key: app_secret\n    label: Application secret\n    type: secret\n    required: true\n    customer: true\nservices:\n")
  .replace("    expose:\n      - 8080\n", "    environment:\n      - name: APP_SECRET_FILE\n        secret: app_secret\n    expose:\n      - 8080\n");

const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
const canaryOf = (): string => randomBytes(30).toString("base64url").slice(0, 40);
/** Every spelling of a value a careless serializer could write. */
const spellings = (value: string): string[] => [
  value,
  Buffer.from(value).toString("base64"),
  Buffer.from(value).toString("hex"),
  encodeURIComponent(value),
];

function expectNoCanary(text: string, canary: string, what: string): void {
  for (const form of spellings(canary)) expect(text, `${what} leaked ${form === canary ? "the value" : "an encoding of the value"}`).not.toContain(form);
}

/** The error object without anything that differs per request. */
const refusalOf = (res: Reply): { status: number; error: Json } => {
  const { requestId: _requestId, ...error } = res.body.error as Json;
  return { status: res.status, error };
};

describe("application stacks: secrets never leave through HTTP (QA M4, A8)", () => {
  let h: AppStackHarness;
  let notes: string;
  let secretWeb: string;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    for (const c of [h.a, h.b]) {
      await h.dbClient.db
        .update(resourceQuotas)
        .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
        .where(eq(resourceQuotas.organizationId, c.orgId));
    }
    notes = (await h.publish()).versionId;
    secretWeb = (await h.publish(SECRET_WEB_SOURCE)).versionId;
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  const base = (c: HarnessCustomer) => `/v1/organizations/${c.orgId}/app-stacks`;
  const idem = () => ({ "Idempotency-Key": randomUUID() });
  const create = (c: HarnessCustomer, body: Json) => h.call(c.token, "POST", base(c), body, idem());
  const act = (c: HarnessCustomer, stackId: string, verb: string, body: unknown = {}) =>
    h.call(c.token, "POST", `${base(c)}/${stackId}/${verb}`, body, idem());
  const setSecret = (c: HarnessCustomer, stackId: string, value: string, parameterKey = "app_secret") =>
    h.call(c.token, "POST", `${base(c)}/${stackId}/secrets`, { parameterKey, value });
  const plan = (c: HarnessCustomer, stackId: string, body: Json = {}) => h.call(c.token, "POST", `${base(c)}/${stackId}/plan`, body);

  async function draft(c: HarnessCustomer, versionId: string, name = `app-${randomUUID().slice(0, 8)}`): Promise<string> {
    const res = await create(c, { templateVersionId: versionId, name, deploy: false });
    expect(res.status, res.raw).toBe(201);
    return res.body.data.stackId as string;
  }

  /** Rows of every public table except the secrets table, as one string per table. */
  async function publicDump(): Promise<Map<string, string>> {
    const tables = await h.dbClient.db.execute(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const dump = new Map<string, string>();
    for (const entry of tables.rows) {
      const name = String(entry["table_name"]);
      if (!/^[a-z0-9_]+$/i.test(name) || name === "app_stack_secrets") continue;
      dump.set(name, json((await h.dbClient.db.execute(sql.raw(`SELECT * FROM "${name}"`))).rows));
    }
    return dump;
  }

  function capture(): { printed: string[]; restore: () => void } {
    const printed: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      }),
    );
    return { printed, restore: () => spies.forEach((spy) => spy.mockRestore()) };
  }

  it("the canary is in no response (success or refusal), no public table, no outbox or audit row, no console line; the secrets table holds ciphertext", async () => {
    const canary = canaryOf();
    const out = capture();
    const replies: [string, Reply][] = [];
    try {
      const stackId = await draft(h.a, notes, "canary-app");
      const set = await setSecret(h.a, stackId, canary);
      expect(set.status, set.raw).toBe(200);
      expect(set.body.data).toEqual({ key: "app_secret", isSet: true, version: 1, setAt: expect.any(String) });
      replies.push(["S15 set", set]);

      const track = async (what: string, res: Promise<Reply>, status: number): Promise<Reply> => {
        const reply = await res;
        expect(reply.status, `${what}: ${reply.raw}`).toBe(status);
        replies.push([what, reply]);
        return reply;
      };
      // Reads and previews while the secret is set.
      await track("S2 list", h.call(h.a.token, "GET", base(h.a)), 200);
      const detail = await track("S3 detail", h.call(h.a.token, "GET", `${base(h.a)}/${stackId}`), 200);
      expect(detail.body.data.secretParameters).toEqual([expect.objectContaining({ key: "app_secret", isSet: true, version: 1 })]);
      const diff = await track("S4 plan", plan(h.a, stackId), 200);
      expect(json(diff.body.data.parameters)).toContain("app_secret");

      // Refusals that happen after the secret is stored: the envelope must not echo anything of it.
      const outOfRange = await track("deploy out of range", act(h.a, stackId, "deploy", { parameters: [{ key: "worker_count", value: 99 }] }), 400);
      expect(outOfRange.body.error.code).toBe("VALIDATION_ERROR");
      const secretAsPublic = await track("deploy with the secret as a public parameter", act(h.a, stackId, "deploy", { parameters: [{ key: "app_secret", value: canary }] }), 400);
      expect(secretAsPublic.body.error.code).toBe("VALIDATION_ERROR");
      const notASecret = await track("secret write to a non-secret key", setSecret(h.a, stackId, canary, "worker_count"), 400);
      expect(notASecret.body.error.code).toBe("VALIDATION_ERROR");
      const strangerWrite = await track("secret write by another organisation", h.call(h.b.token, "POST", `${base(h.b)}/${stackId}/secrets`, { parameterKey: "app_secret", value: canary }), 404);
      expect(strangerWrite.body.error.code).toBe("NOT_FOUND");
      const strangerPlan = await track("plan by another organisation", plan(h.b, stackId), 404);
      expect(strangerPlan.body.error.code).toBe("NOT_FOUND");

      const deploy = await track("S5 deploy", act(h.a, stackId, "deploy"), 202);
      const busy = await track("deploy while queued", act(h.a, stackId, "deploy"), 409);
      expect(busy.body.error.code).toBe("RESOURCE_LOCKED");
      const operationId = deploy.body.data.operationId as string;
      const op = await track("operation", h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/operations/${operationId}`), 200);
      expect(op.body.data.id).toBe(operationId);
      await track("S12 deployments", h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/deployments`), 200);
      await track("S3 detail after deploy", h.call(h.a.token, "GET", `${base(h.a)}/${stackId}`), 200);
      await track("S4 plan after deploy", plan(h.a, stackId), 200);

      for (const [what, reply] of replies) expectNoCanary(reply.raw, canary, what);

      // Every public table except the secrets table, then the ones the contract names.
      for (const [name, dump] of await publicDump()) expectNoCanary(dump, canary, `table ${name}`);
      const db = h.dbClient.db;
      for (const [name, table] of [
        ["audit_events", auditEvents],
        ["outbox_events", outboxEvents],
        ["operations", operations],
        ["operation_steps", operationSteps],
        ["app_stack_revisions", appStackRevisions],
      ] as const) {
        const rows = json(await db.select().from(table));
        expect(rows.length, `${name} has rows`).toBeGreaterThan(2);
        expectNoCanary(rows, canary, name);
      }
      expect((await db.select().from(outboxEvents)).length).toBeGreaterThan(0);

      // Secrets table: ciphertext only.
      const [row] = await db.select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId));
      expect(row).toMatchObject({ parameterKey: "app_secret", version: 1 });
      expectNoCanary(json(row), canary, "app_stack_secrets row");
      expect(Buffer.from(row!.ciphertextBase64, "base64").toString("utf8")).not.toContain(canary);
      expect(Buffer.from(row!.ciphertextBase64, "base64").length).toBe(Buffer.byteLength(canary));
    } finally {
      out.restore();
    }
    expectNoCanary(out.printed.join("\n"), canary, "console output");
  });

  it("the canary stays out of the operation, its steps and the logs when the runtime really deploys the stack", async () => {
    const canary = canaryOf();
    const out = capture();
    try {
      const created = await create(h.a, { templateVersionId: secretWeb, name: "runtime-secret", deploy: false });
      expect(created.status, created.raw).toBe(201);
      const stackId = created.body.data.stackId as string;
      expect((await setSecret(h.a, stackId, canary)).status).toBe(200);
      const deploy = await act(h.a, stackId, "deploy");
      expect(deploy.status, deploy.raw).toBe(202);
      const operationId = deploy.body.data.operationId as string;

      const worker = h.app.nestApp.get(OutboxWorkerService);
      for (let round = 0; round < 10; round += 1) {
        await worker.processPendingOnce();
        const [stack] = await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId));
        if (stack!.status === "running") break;
      }

      const op = await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/operations/${operationId}`);
      expect(op.status, op.raw).toBe(200);
      const steps = await h.dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, operationId)).orderBy(asc(operationSteps.id));
      expect(steps.length, "the runtime wrote steps").toBeGreaterThan(0);
      expectNoCanary(op.raw, canary, "GET operation");
      expectNoCanary(json(steps), canary, "operation_steps");
      for (const path of [`${base(h.a)}/${stackId}`, `${base(h.a)}/${stackId}/deployments`, `${base(h.a)}/${stackId}/components/web/health`, `${base(h.a)}/${stackId}/components/web/logs`]) {
        const res = await h.call(h.a.token, "GET", path);
        expect([200, 422, 503], `${path}: ${res.raw}`).toContain(res.status);
        expectNoCanary(res.raw, canary, path);
      }
      for (const [name, dump] of await publicDump()) expectNoCanary(dump, canary, `table ${name} after the runtime ran`);
    } finally {
      out.restore();
    }
    expectNoCanary(out.printed.join("\n"), canary, "console output after the runtime ran");
  }, 60_000);

  it("two rotations give versions 1 and 2; the detail shows version 2; neither value is returned or stored in clear", async () => {
    const first = canaryOf();
    const second = canaryOf();
    const stackId = await draft(h.a, notes, "rotating");
    const one = await setSecret(h.a, stackId, first);
    const two = await setSecret(h.a, stackId, second);
    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.body.data).toMatchObject({ key: "app_secret", isSet: true, version: 1 });
    expect(two.body.data).toMatchObject({ key: "app_secret", isSet: true, version: 2 });

    const detail = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}`);
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.body.data.secretParameters).toEqual([expect.objectContaining({ key: "app_secret", isSet: true, version: 2 })]);
    for (const value of [first, second]) {
      for (const res of [one, two, detail]) expectNoCanary(res.raw, value, "a rotation response");
      for (const [name, dump] of await publicDump()) expectNoCanary(dump, value, `table ${name}`);
    }

    const rows = await h.dbClient.db.select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId)).orderBy(asc(appStackSecrets.version));
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows[0]!.ciphertextBase64).not.toBe(rows[1]!.ciphertextBase64);
    for (const row of rows) for (const value of [first, second]) expectNoCanary(json(row), value, "app_stack_secrets row");

    const rotations = await h.dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "app.stack.secret.rotate"), eq(auditEvents.targetId, stackId)))
      .orderBy(asc(auditEvents.timestamp));
    expect(rotations.map((r) => (r.details as Json).version)).toEqual([1, 2]);
    for (const row of rotations) {
      expect(Object.keys(row.details as Json).filter((k) => !["outcome", "requestId"].includes(k)).sort()).toEqual(["parameterKey", "version"]);
    }

    // The next deploy uses version 2, and says so without saying the value.
    const deploy = await act(h.a, stackId, "deploy");
    expect(deploy.status, deploy.raw).toBe(202);
    const [revision] = await h.dbClient.db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId));
    expect(json(revision!.plan)).toContain('"version":2');
    for (const value of [first, second]) expectNoCanary(json(revision), value, "the revision");
  });

  it("a missing required secret refuses the deploy, the plan and a deploying create the same way whatever another organisation's stack of the template has", async () => {
    const mine = await draft(h.a, notes, "needs-secret");
    const theirs = await draft(h.b, notes, "has-secret");
    const canary = canaryOf();

    const probe = async () => {
      const deploy = await act(h.a, mine, "deploy");
      const diff = await plan(h.a, mine);
      const create2 = await create(h.a, { templateVersionId: notes, name: "never-created", deploy: true });
      return { deploy, diff, create2 };
    };
    const writesBefore = await h.counts();
    const withoutTheirs = await probe();
    expect(await setSecret(h.b, theirs, canary)).toMatchObject({ status: 200 });
    const withTheirs = await probe();

    for (const res of [withoutTheirs.deploy, withoutTheirs.diff, withoutTheirs.create2]) {
      expect(res.status, res.raw).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details).toContainEqual(expect.objectContaining({ field: "parameters.app_secret", reason: "STACK_SECRET_MISSING" }));
    }
    for (const key of ["deploy", "diff", "create2"] as const) {
      expect(refusalOf(withTheirs[key]), key).toEqual(refusalOf(withoutTheirs[key]));
      expectNoCanary(withTheirs[key].raw, canary, `${key} refusal`);
      expect(withTheirs[key].raw).not.toContain(theirs);
      expect(withTheirs[key].raw).not.toContain(h.b.orgId);
    }
    // Only the other organisation's own secret write (one row, one audit row) was written.
    const after = await h.counts();
    expect(after.app_stack_secrets).toBe((writesBefore.app_stack_secrets ?? 0) + 1);
    expect({ ...after, app_stack_secrets: 0, audit_events: 0 }).toEqual({ ...writesBefore, app_stack_secrets: 0, audit_events: 0 });
    expect(after.audit_events).toBe(writesBefore.audit_events! + 1);
    expect(await h.dbClient.db.select().from(appStackSecrets).where(eq(appStackSecrets.stackId, mine))).toHaveLength(0);
  });

  it("a value that Zod refuses (empty, too long, wrong type) is not echoed in the envelope", async () => {
    const stackId = await draft(h.a, notes);
    const tooLong = randomBytes(12_300).toString("base64url").slice(0, 16_385);
    const before = await h.counts();
    const cases: [string, unknown][] = [
      ["too long", tooLong],
      ["empty", ""],
      ["not a string", { nested: "do-not-echo-this-object-value" }],
    ];
    for (const [what, value] of cases) {
      const res = await h.call(h.a.token, "POST", `${base(h.a)}/${stackId}/secrets`, { parameterKey: "app_secret", value });
      expect(res.status, `${what}: ${res.raw}`).toBe(400);
      expect(res.raw, what).not.toContain(tooLong.slice(0, 32));
      expect(res.raw, what).not.toContain("do-not-echo-this-object-value");
    }
    expect(await h.counts()).toEqual(before);
  });
});
