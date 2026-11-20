import { randomUUID } from "node:crypto";
import { DEMO_IDS, auditEvents, operationSteps, operations, outboxEvents } from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ACME = DEMO_IDS.organizations.acme;
const PLAINTEXT = "restart-sentinel-Pa55word!";

describe("service restart secrets (#7)", () => {
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let token: string;

  const api = async (path: string, token: string, body: unknown): Promise<{ status: number; body: Json }> => {
    const r = await fetch(`${app.baseUrl!}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    return { status: r.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  };
  const lifecycle = async (serviceId: string, action: string) => {
    const res = await api(`/v1/organizations/${ACME}/services/${serviceId}/lifecycle`, token, { action });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.operationId as string;
  };
  const statusOf = async (opId: string) =>
    (await app.dbClient.db.select().from(operations)).find((o) => o.id === opId)?.status;

  beforeAll(async () => {
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      seedPhase1: true,
      enableDevOidc: true,
      host: "127.0.0.1",
      port: 0,
      listen: true,
      dockerExecutor: sim,
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
    token = ((await res.json()) as Json).data.accessToken as string;
  });
  afterAll(async () => {
    await app.close();
  });

  it("a restart of a generic service with secretRefs sends the decrypted secrets to the executor", async () => {
    // The seeded MariaDB holds a vault:// placeholder that maps to the site secret of the same name.
    const serviceId = DEMO_IDS.services.acmeShopDb;
    const secret = await api(`/v1/organizations/${ACME}/secrets`, token, {
      secretKey: "MYSQL_ROOT_PASSWORD",
      value: PLAINTEXT,
      siteId: DEMO_IDS.sites.acmeShop,
    });
    expect(secret.status).toBe(201);
    expect(await statusOf(await lifecycle(serviceId, "deploy"))).toBe("succeeded");

    const restart = vi.spyOn(sim, "restartService");
    const opId = await lifecycle(serviceId, "restart");
    expect(restart.mock.calls).toEqual([[serviceId, { MYSQL_ROOT_PASSWORD: PLAINTEXT }]]);
    restart.mockRestore();
    expect(await statusOf(opId)).toBe("succeeded");

    const db = app.dbClient.db;
    for (const table of [operations, operationSteps, outboxEvents, auditEvents]) {
      expect(JSON.stringify(await db.select().from(table))).not.toContain(PLAINTEXT);
    }
  });

  it("a restart of a service without secrets calls restartService with the id only", async () => {
    const id = DEMO_IDS.services.acmeShopRedis;
    expect(await statusOf(await lifecycle(id, "deploy"))).toBe("succeeded");
    const restart = vi.spyOn(sim, "restartService");
    const opId = await lifecycle(id, "restart");
    expect(restart.mock.calls).toEqual([[id]]);
    restart.mockRestore();
    expect(await statusOf(opId)).toBe("succeeded");
  });
});
