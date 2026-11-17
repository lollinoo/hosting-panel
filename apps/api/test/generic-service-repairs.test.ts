import { randomUUID } from "node:crypto";
import {
  DEMO_IDS,
  and,
  eq,
  operationSteps,
  operations,
  serviceInstances,
  sql,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ACME = DEMO_IDS.organizations.acme;
const OWN_SVC = DEMO_IDS.services.acmeShopWp;
const FOREIGN_SVC = DEMO_IDS.services.betaPortalNode;
const DEPLOY_SVC = DEMO_IDS.services.acmeShopRedis;
const FIXED_FAILURE = "This action did not finish. Try again in a few minutes.";
const ENGINE_TEXT = "engine-sentinel conflict from the daemon";

async function boot(dockerExecutor: ControlPlaneAppHandle["dockerExecutor"]): Promise<{
  app: ControlPlaneAppHandle;
  call: (serviceId: string, body: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: Json }>;
}> {
  const app = await createControlPlaneApp({
    seedPhase1: true,
    enableDevOidc: true,
    host: "127.0.0.1",
    port: 0,
    listen: true,
    dockerExecutor,
    autoProcessOutbox: false,
    outboxPollIntervalMs: null,
    driftReconcileIntervalMs: null,
    recoverUnknownOnStart: false,
  });
  const res = await fetch(`${app.baseUrl!}/v1/dev/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: DEMO_IDS.users.elena }),
  });
  const token = ((await res.json()) as Json).data.accessToken as string;
  const call = async (serviceId: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${app.baseUrl!}/v1/organizations/${ACME}/services/${serviceId}/lifecycle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    return { status: r.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  };
  return { app, call };
}

describe("generic service lifecycle route, runtime on", () => {
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let call: Awaited<ReturnType<typeof boot>>["call"];

  beforeAll(async () => {
    sim = new InMemoryDockerSimulatorAdapter();
    ({ app, call } = await boot(sim));
  });
  afterAll(async () => {
    await app.close();
  });

  const stopsOf = (serviceId: string) =>
    app.dbClient.db
      .select()
      .from(operations)
      .where(and(eq(operations.resourceId, serviceId), eq(operations.kind, "service.stop")));
  const desiredOf = async (serviceId: string) =>
    (await app.dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.id, serviceId)))[0]!
      .desiredStatus;

  it("answers 404 for another organisation's service before reading the body", async () => {
    const res = await call(FOREIGN_SVC, { action: "bogus" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("still refuses a bad body on an own service", async () => {
    const res = await call(OWN_SVC, { action: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("writes nothing when the audit insert fails", async () => {
    const before = await desiredOf(OWN_SVC);
    const db = app.dbClient.db;
    await db.execute(sql.raw(`CREATE FUNCTION hp_test_refuse_audit() RETURNS trigger AS $$
      BEGIN IF NEW.action = 'service.lifecycle.stop' THEN RAISE EXCEPTION 'audit insert refused'; END IF; RETURN NEW; END
      $$ LANGUAGE plpgsql`));
    await db.execute(sql.raw(
      "CREATE TRIGGER hp_test_refuse_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION hp_test_refuse_audit()",
    ));
    try {
      const res = await call(OWN_SVC, { action: "stop" }, { "Idempotency-Key": randomUUID() });
      expect(res.status).toBe(500);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER hp_test_refuse_audit ON audit_events"));
      await db.execute(sql.raw("DROP FUNCTION hp_test_refuse_audit()"));
    }
    expect(await stopsOf(OWN_SVC)).toEqual([]);
    expect(await desiredOf(OWN_SVC)).toBe(before);
  });

  it("stores the fixed sentence, never the engine text, on a failed generic deploy", async () => {
    const deploy = vi.spyOn(sim, "deployService").mockRejectedValueOnce(new Error(ENGINE_TEXT));
    const res = await call(DEPLOY_SVC, { action: "deploy" }, { "Idempotency-Key": randomUUID() });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    expect(deploy).toHaveBeenCalledTimes(1);

    const opId = res.body.data.operationId as string;
    const [op] = await app.dbClient.db.select().from(operations).where(eq(operations.id, opId));
    expect(op!.status).toBe("failed");
    expect(op!.errorMessage).toBe(FIXED_FAILURE);
    const steps = await app.dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId));
    expect(steps.filter((s) => s.status === "failed").map((s) => s.message)).toEqual([FIXED_FAILURE]);
    expect(JSON.stringify(steps)).not.toContain("engine-sentinel");
  });
});

describe("generic service lifecycle route, runtime off", () => {
  let app: ControlPlaneAppHandle;
  let call: Awaited<ReturnType<typeof boot>>["call"];
  const executor = new Phase1DisabledDockerExecutor();
  const spies = [
    vi.spyOn(executor, "deployService"),
    vi.spyOn(executor, "restartService"),
    vi.spyOn(executor, "stopService"),
  ];

  beforeAll(async () => {
    ({ app, call } = await boot(executor));
  });
  afterAll(async () => {
    await app.close();
  });

  it("answers 422 NOT_SUPPORTED and calls no executor method", async () => {
    for (const action of ["deploy", "restart", "stop"]) {
      const res = await call(OWN_SVC, { action });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("NOT_SUPPORTED");
      expect(res.body.error.message).toContain("Docker executor runtime is disabled in Phase 1");
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
