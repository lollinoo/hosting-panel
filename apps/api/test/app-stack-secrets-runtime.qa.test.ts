import { randomBytes, randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  appStackSecrets,
  appStacks,
  auditEvents,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  resourceQuotas,
  sql,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { APP_STACK_EXECUTOR_METHODS } from "@hosting-panel/executor-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = Awaited<ReturnType<AppStackHarness["call"]>>;

/** Built-in "web + cache" template (allowlisted images) with one required secret file on web. */
const SECRET_WEB_SOURCE = APP_BUILT_IN_TEMPLATES[0]!.source
  .replace("services:\n", "  - key: app_secret\n    label: Application secret\n    type: secret\n    required: true\n    customer: true\nservices:\n")
  .replace("    expose:\n      - 8080\n", "    environment:\n      - name: APP_SECRET_FILE\n        secret: app_secret\n    expose:\n      - 8080\n");

const NOT_FOUND = "Requested organization or resource was not found.";
const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
const canaryOf = (): string => `SENTINEL${randomBytes(30).toString("base64url").slice(0, 32)}`;
const spellings = (value: string): string[] => [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex"), encodeURIComponent(value)];

function expectNoCanary(text: string, canary: string, what: string): void {
  for (const form of spellings(canary)) expect(text, `${what} leaked ${form === canary ? "the value" : "an encoding of the value"}`).not.toContain(form);
}

/** The error object without anything that differs per request. */
const refusalOf = (res: Reply): { status: number; error: Json } => {
  const { requestId: _requestId, ...error } = res.body.error as Json;
  return { status: res.status, error };
};

describe("application stacks: secrets through the runtime (QA M4: A8 runtime part, B1 for logs and health)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let secretWeb: string;
  const printed: string[] = [];

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    for (const c of [h.a, h.b]) {
      await h.dbClient.db
        .update(resourceQuotas)
        .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
        .where(eq(resourceQuotas.organizationId, c.orgId));
    }
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    secretWeb = (await h.publish(SECRET_WEB_SOURCE)).versionId;
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    printed.length = 0;
  });

  afterAll(async () => {
    await h?.close();
  });

  const base = (c: HarnessCustomer) => `/v1/organizations/${c.orgId}/app-stacks`;
  const idem = () => ({ "Idempotency-Key": randomUUID() });
  const worker = () => h.app.nestApp.get(OutboxWorkerService);

  function capture(): void {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args.map(String).join(" "));
      });
    }
  }

  /** Every call the executor receives, per method, with its arguments as text (the spy calls through). */
  function recordExecutor(): () => Map<string, string[]> {
    const spies = APP_STACK_EXECUTOR_METHODS.map((method) => [method, vi.spyOn(sim.appStacks, method as "getAppStackStatus")] as const);
    return () => new Map(spies.map(([method, spy]) => [method, spy.mock.calls.map((args) => json(args))]));
  }

  async function createStack(c: HarnessCustomer, name = `app-${randomUUID().slice(0, 8)}`): Promise<string> {
    const res = await h.call(c.token, "POST", base(c), { templateVersionId: secretWeb, name, deploy: false }, idem());
    expect(res.status, res.raw).toBe(201);
    return res.body.data.stackId as string;
  }
  const setSecret = (c: HarnessCustomer, stackId: string, value: string) =>
    h.call(c.token, "POST", `${base(c)}/${stackId}/secrets`, { parameterKey: "app_secret", value });
  const deploy = (c: HarnessCustomer, stackId: string) => h.call(c.token, "POST", `${base(c)}/${stackId}/deploy`, {}, idem());

  /** The worker until no operation of the stack is open. */
  async function drain(stackId: string): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await worker().processPendingOnce();
      const open = (await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId))).filter((o) =>
        ["queued", "running"].includes(o.status),
      );
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  /** The health budget (10 minutes) and its 5 s waits pass in microseconds: only the runtime's clock reads Date.now. */
  function virtualTime(): void {
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === 5_000) {
        skew += 5_000;
        return originalSetTimeout(fn, 0, ...args);
      }
      return originalSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
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

  /** Everything a customer or an operator could read once the runtime has run, searched for the value. */
  async function expectNowhere(canary: string, stackId: string, c: HarnessCustomer, replies: Reply[] = []): Promise<void> {
    const db = h.dbClient.db;
    const ops = await db.select().from(operations).where(eq(operations.resourceId, stackId));
    expect(ops.length, "the stack has an operation").toBeGreaterThan(0);
    const steps = await db.select().from(operationSteps);
    expect(steps.length, "the runtime wrote steps").toBeGreaterThan(0);
    for (const [what, rows] of [
      ["operations", ops],
      ["operation_steps", steps],
      ["outbox_events", await db.select().from(outboxEvents)],
      ["audit_events", await db.select().from(auditEvents)],
    ] as const) {
      expectNoCanary(json(rows), canary, what);
    }
    for (const [name, dump] of await publicDump()) expectNoCanary(dump, canary, `table ${name}`);
    const reads = [
      base(c),
      `${base(c)}/${stackId}`,
      `${base(c)}/${stackId}/deployments`,
      `${base(c)}/${stackId}/components/web/health`,
      `${base(c)}/${stackId}/components/web/logs`,
      `/v1/organizations/${c.orgId}/operations/${ops[0]!.id}`,
    ];
    for (const path of reads) {
      const res = await h.call(c.token, "GET", path);
      expect(res.status, `${path}: ${res.raw}`).toBeLessThan(500);
      expectNoCanary(res.raw, canary, `GET ${path}`);
    }
    for (const res of replies) expectNoCanary(res.raw, canary, "a reply");
    expectNoCanary(printed.join("\n"), canary, "console output");
  }

  it("the value reaches the executor only in the start call of the component that mounts it, and nowhere else", async () => {
    const canary = canaryOf();
    capture();
    const calls = recordExecutor();
    const stackId = await createStack(h.a);
    const set = await setSecret(h.a, stackId, canary);
    expect(set.status, set.raw).toBe(200);
    const queued = await deploy(h.a, stackId);
    expect(queued.status, queued.raw).toBe(202);
    await drain(stackId);

    const [stack] = await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId));
    expect(stack!.status).toBe("running");

    const seen = calls();
    const carriers = [...seen].filter(([, requests]) => requests.some((r) => r.includes(canary))).map(([method]) => method);
    // The secret travels in the start call and in no other call of the executor port (pull, prepare, create, status, routes, logs ...).
    expect(carriers).toEqual(["startAppStackComponent"]);
    const starts = seen.get("startAppStackComponent")!;
    expect(starts.filter((r) => r.includes(canary))).toHaveLength(1);
    // The other component has no secret file: its start call carries none.
    expect(starts.filter((r) => r.includes('"componentKey":"cache"'))).toHaveLength(1);
    expect(starts.find((r) => r.includes('"componentKey":"cache"'))).not.toContain(canary);
    // The first deploy has nothing to restart.
    expect(seen.get("restartAppStackComponent")).toEqual([]);

    await expectNowhere(canary, stackId, h.a, [set, queued]);

    // At rest only ciphertext of the right length exists.
    const [row] = await h.dbClient.db.select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId));
    expectNoCanary(json(row), canary, "app_stack_secrets row");
    expect(Buffer.from(row!.ciphertextBase64, "base64").toString("utf8")).not.toContain(canary);
  }, 60_000);

  it("an executor error that quotes the value stops the deploy with a fixed text and leaks nothing", async () => {
    const canary = canaryOf();
    capture();
    const stackId = await createStack(h.a);
    expect((await setSecret(h.a, stackId, canary)).status).toBe(200);
    vi.spyOn(sim.appStacks, "startAppStackComponent").mockRejectedValue(new Error(`cannot start: APP_SECRET=${canary}`));
    const queued = await deploy(h.a, stackId);
    expect(queued.status, queued.raw).toBe(202);
    await drain(stackId);

    const [op] = await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
    expect(op!.status).not.toBe("succeeded");
    expect(["queued", "running"]).not.toContain(op!.status);
    expect(op!.errorMessage ?? "").not.toContain("cannot start");
    const steps = await h.dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, op!.id));
    for (const step of steps) expect(step.message ?? "", `step ${step.key}`).not.toContain("cannot start");
    await expectNowhere(canary, stackId, h.a, [queued]);
  }, 60_000);

  it("a status read that fails with the value in its message leaves no trace either", async () => {
    const canary = canaryOf();
    capture();
    const stackId = await createStack(h.a);
    expect((await setSecret(h.a, stackId, canary)).status).toBe(200);
    virtualTime();
    vi.spyOn(sim.appStacks, "getAppStackStatus").mockRejectedValue(new Error(`engine said ${canary}`));
    const queued = await deploy(h.a, stackId);
    expect(queued.status, queued.raw).toBe(202);
    await drain(stackId);
    await expectNowhere(canary, stackId, h.a, [queued]);
  }, 60_000);

  describe("logs of a running stack", () => {
    let canary: string;
    let stackId: string;

    beforeAll(async () => {
      canary = canaryOf();
      stackId = await createStack(h.a, "logged");
      expect((await setSecret(h.a, stackId, canary)).status).toBe(200);
      expect((await deploy(h.a, stackId)).status).toBe(202);
      await drain(stackId);
      const [stack] = await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId));
      expect(stack!.status).toBe("running");
    }, 60_000);

    const lines = () => [
      { at: "2026-11-22T10:00:00.000Z", stream: "stdout" as const, text: "server ready" },
      { at: "2026-11-22T10:00:01.000Z", stream: "stdout" as const, text: `loaded key ${canary}` },
      { at: "2026-11-22T10:00:02.000Z", stream: "stderr" as const, text: `retry "${canary}" then ${canary}` },
      { at: "2026-11-22T10:00:03.000Z", stream: "stderr" as const, text: `x${canary}${canary}y` },
    ];

    it.each([
      ["default tail", ""],
      ["the largest tail", "?tail=500"],
    ])("the log lines the customer reads have the value masked (%s)", async (_what, query) => {
      sim.appStacks.setAppStackComponentLogs(stackId, "web", lines());
      const res = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/web/logs${query}`);
      expect(res.status, res.raw).toBe(200);
      expectNoCanary(res.raw, canary, "the logs");
      const text = (res.body.data.lines as { text: string }[]).map((l) => l.text);
      expect(text).toHaveLength(4);
      expect(text[0]).toBe("server ready");
      for (const line of text.slice(1)) expect(line).toContain("[REDACTED]");
      expect(text[1]).toMatch(/^loaded key /);
      expect(text[3]).toMatch(/^x.*y$/);
    });

    it("a failing log read answers with the fixed text, not the engine's words", async () => {
      vi.spyOn(sim.appStacks, "getAppStackComponentLogs").mockRejectedValue(new Error(`engine says ${canary}`));
      const res = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/web/logs`);
      expect(res.status, res.raw).toBeGreaterThanOrEqual(500);
      expect(res.body.error.message).toBe("The logs are not available right now. Try again in a few minutes.");
      expectNoCanary(res.raw, canary, "the failed log read");
    });

    it("B1: another organisation gets the same not-found answer for logs and health of this stack as for a stack that does not exist", async () => {
      sim.appStacks.setAppStackComponentLogs(stackId, "web", lines());
      const reads = vi.spyOn(sim.appStacks, "getAppStackComponentLogs");
      const ghost = `stk_${randomUUID().replace(/-/g, "")}`;
      for (const leaf of ["logs", "health"]) {
        const foreign = await h.call(h.b.token, "GET", `${base(h.b)}/${stackId}/components/web/${leaf}`);
        const missing = await h.call(h.b.token, "GET", `${base(h.b)}/${ghost}/components/web/${leaf}`);
        const noComponent = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/nope/${leaf}`);
        expect(foreign.status, foreign.raw).toBe(404);
        expect(foreign.body.error.message).toBe(NOT_FOUND);
        expect(refusalOf(foreign), `${leaf}: foreign vs missing`).toEqual(refusalOf(missing));
        expect(refusalOf(noComponent), `${leaf}: own stack, unknown component`).toEqual(refusalOf(foreign));
        for (const res of [foreign, missing, noComponent]) {
          expectNoCanary(res.raw, canary, `${leaf} refusal`);
          expect(res.raw).not.toContain(h.a.orgId);
          expect(res.raw).not.toContain("[REDACTED]");
        }
      }
      // The executor was never asked for the logs of a stack the caller does not own.
      expect(reads).not.toHaveBeenCalled();
    });

    it("B1: the other organisation cannot reach the stack through the owner's organisation path either", async () => {
      for (const leaf of ["logs", "health"]) {
        const res = await h.call(h.b.token, "GET", `${base(h.a)}/${stackId}/components/web/${leaf}`);
        expect([403, 404], res.raw).toContain(res.status);
        expectNoCanary(res.raw, canary, `${leaf} through the owner's path`);
        expect(res.raw).not.toContain("healthy");
        expect(res.raw).not.toContain("[REDACTED]");
      }
    });

    it("health tells an organisation member the state and nothing of the secret, and the owner's own read still works", async () => {
      const res = await h.call(h.a.token, "GET", `${base(h.a)}/${stackId}/components/web/health`);
      expect(res.status, res.raw).toBe(200);
      expect(res.body.data).toMatchObject({ componentKey: "web", health: "healthy" });
      expectNoCanary(res.raw, canary, "health");
      expect(Object.keys(res.body.data).sort()).toEqual(["componentKey", "health", "observedAt", "source", "stale"]);
    });
  });
});
