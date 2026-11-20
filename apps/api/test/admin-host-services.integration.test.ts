import { randomUUID } from "node:crypto";
import { AdminHealthDtoSchema, HostServiceRestartAcceptedDtoSchema, PLATFORM_OPS_ORG_ID } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  operations,
  transitionOperation,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { ensurePlatformOpsOrg } from "../src/backups/backup-scheduler.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { executeHostJob, HOST_JOB_START_DEADLINE_MS } from "../src/host/host-jobs.js";
import { createControlPlaneApp, type ControlPlaneAppHandle, type CreateControlPlaneAppOptions } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-password-0003";
const SETUP = { installationName: "Host Services Test", hostHostname: "panel.example.test", hostIpv4: "192.0.2.1" };
const REASON = "Sentinel reason for the restart";
const SINCE = "2026-11-17T08:00:00.000Z";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("admin host services: restart, Health and journals", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let agent: InMemoryHostSimulatorAdapter;
  let agentCalls: string[];
  let simClock: (() => Date) | null;
  let adminToken: string;

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, as: string, body?: unknown): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  async function start(opts: Partial<CreateControlPlaneAppOptions> = {}): Promise<void> {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    simClock = null;
    agent = new InMemoryHostSimulatorAdapter({ nowProvider: () => (simClock ? simClock() : new Date()) });
    agentCalls = [];
    const port = new Proxy(agent, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          agentCalls.push(String(p));
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    }) as HostAgentPort;
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      hostAgent: port,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
      ...opts,
    });
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
  }

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  const restart = (service: string, body: unknown = { reason: REASON }, as = adminToken) =>
    call("POST", `/v1/admin/host-services/${service}/restart`, as, body);
  const opOf = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const rowsOf = async (action: string, operationId?: string) =>
    (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action))).filter(
      (r) => operationId === undefined || (r.details as Json).operationId === operationId,
    );
  /** Moves the submission back so the worker's two-second start delay is over. */
  const age = (id: string, ms: number) =>
    dbClient.db.update(operations).set({ submittedAt: new Date(Date.now() - ms) }).where(eq(operations.id, id));
  const runWorker = () => app.outboxWorker.processPendingOnce();
  const named = (name: string) => agentCalls.filter((c) => c === name);

  async function customerToken(): Promise<string> {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, { organizationName: "Org A", ownerEmail: "owner@example.test", ownerName: "Owner" });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "owner@example.test");
    return login("owner@example.test", created.body.data.temporaryPassword as string);
  }

  it("answers 202, writes one request row with the reason, and the worker records one .end row", async () => {
    await start();
    const res = await restart("web", { reason: `  ${REASON}  ` });
    expect(res.status).toBe(202);
    const data = HostServiceRestartAcceptedDtoSchema.parse(res.body.data);
    expect(data.service).toBe("web");
    const [request] = await rowsOf("admin.host_service.restart", data.operationId);
    expect(request).toMatchObject({ actorType: "user", targetType: "host_service", targetId: "web", organizationId: PLATFORM_OPS_ORG_ID });
    expect(request!.details).toMatchObject({ outcome: "succeeded", operationId: data.operationId, service: "web", reason: REASON });
    expect(await opOf(data.operationId)).toMatchObject({ kind: "host.job", resourceId: "restart_hp_web", status: "queued" });
    await age(data.operationId, 3_000);
    await runWorker();
    expect(named("requestHostJob")).toHaveLength(1);
    expect(await opOf(data.operationId)).toMatchObject({ status: "succeeded", errorCode: null });
    const ends = await rowsOf("admin.host_service.restart.end", data.operationId);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ actorId: null, actorType: "system" });
    expect(ends[0]!.details).toEqual({ operationId: data.operationId, outcome: "succeeded", result: "succeeded", exitStatus: 0 });
    // The reason lives in the request row only.
    expect(JSON.stringify(await opOf(data.operationId))).not.toContain(REASON);
    const read = await call("GET", `/v1/admin/operations/${data.operationId}`, adminToken);
    expect(read.body.data.status).toBe("succeeded");
  }, 20_000);

  it("exit 1 ends failed with HOST_JOB_FAILED and the end row says failed", async () => {
    await start();
    agent.setHostJobExitStatus("restart_hp_api", 1);
    const res = await restart("api");
    const id = res.body.data.operationId as string;
    await age(id, 3_000);
    await runWorker();
    expect(await opOf(id)).toMatchObject({ status: "failed", errorCode: "HOST_JOB_FAILED" });
    expect((await rowsOf("admin.host_service.restart.end", id))[0]!.details).toMatchObject({ outcome: "failed", result: "failed", exitStatus: 1 });
  }, 20_000);

  it("a second request while one is active gets 409 host_job_running", async () => {
    await start();
    expect((await restart("web")).status).toBe(202);
    const second = await restart("host_agent");
    expect([second.status, second.body.error?.code, second.body.error?.details?.[0]?.reason]).toEqual([409, "RESOURCE_LOCKED", "host_job_running"]);
    expect(await rowsOf("admin.host_service.restart")).toHaveLength(1);
  });

  it("a restart of the executor during an active backup gets 409 site_work_running and never asks the agent", async () => {
    await start();
    await ensurePlatformOpsOrg(dbClient.db);
    await enqueueOperationTransactional(dbClient.db, {
      organizationId: PLATFORM_OPS_ORG_ID,
      kind: "site.backups.create",
      resourceType: "site",
      resourceId: "site_sentinel",
      steps: [{ key: "run", label: "Run" }],
    });
    const res = await restart("executor");
    expect([res.status, res.body.error?.code, res.body.error?.details?.[0]?.reason]).toEqual([409, "RESOURCE_LOCKED", "site_work_running"]);
    await runWorker();
    expect(named("requestHostJob")).toEqual([]);
  });

  it("refuses an unknown service, a missing reason and a disabled runtime before anything is queued; a customer gets 403 and a denied row", async () => {
    await start();
    for (const service of ["docker", "hp-api", "API", "database"]) expect((await restart(service)).status, service).toBe(400);
    expect((await restart("web", {})).status).toBe(400);
    const token = await customerToken();
    const before = (await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id);
    expect((await restart("web", { reason: REASON }, token)).status).toBe(403);
    const added = (await dbClient.db.select().from(auditEvents)).filter((r) => !before.includes(r.id));
    expect(added.map((r) => (r.details as Json).outcome)).toEqual(["denied"]);
    expect((await dbClient.db.select().from(operations).where(eq(operations.kind, "host.job")))).toEqual([]);
    await app.close();
    await dbClient.close();
    await start({ runtimeBackend: "disabled", hostAgent: undefined });
    const res = await restart("web");
    expect([res.status, res.body.error?.code]).toEqual([422, "NOT_SUPPORTED"]);
    expect((await dbClient.db.select().from(operations).where(eq(operations.kind, "host.job")))).toEqual([]);
  });

  it("a stale request ends OPERATION_INTERRUPTED, not_started, and requests nothing", async () => {
    await start();
    const id = (await restart("web")).body.data.operationId as string;
    await age(id, 61_000);
    await runWorker();
    expect(named("requestHostJob")).toEqual([]);
    expect(await opOf(id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
    expect((await rowsOf("admin.host_service.restart.end", id))[0]!.details).toMatchObject({ result: "not_started", exitStatus: null });
  });

  it("a job that never starts ends not_started past the start deadline", async () => {
    await start();
    const id = (await restart("web")).body.data.operationId as string;
    await transitionOperation(dbClient.db, id, "processing");
    let shift = 0;
    // The request is lost on the way: the agent never runs it.
    const lost = {
      ...agent,
      readHostJob: agent.readHostJob.bind(agent),
      requestHostJob: async () => {
        shift = HOST_JOB_START_DEADLINE_MS + 1_000;
        throw Object.assign(new Error("lost"), { code: "OPERATION_AMBIGUOUS" });
      },
    } as unknown as HostAgentPort;
    await executeHostJob(dbClient.db, lost, await opOf(id), () => Date.now() + shift);
    expect(await opOf(id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
    expect((await rowsOf("admin.host_service.restart.end", id))[0]!.details).toMatchObject({ result: "not_started" });
  });

  it("R198 2.5: a run the simulator dates to the whole second of an operation started at .900 belongs to it", async () => {
    await start();
    const id = (await restart("web")).body.data.operationId as string;
    await transitionOperation(dbClient.db, id, "processing");
    const second = Math.floor(Date.now() / 1000) * 1000;
    await dbClient.db.update(operations).set({ startedAt: new Date(second + 900), submittedAt: new Date(Date.now() - 3_000) }).where(eq(operations.id, id));
    simClock = () => new Date(second + 950);
    const op = await opOf(id);
    let shift = 0; // a missed match would end not_started once the deadline passes
    const port = { ...agent, readHostJob: agent.readHostJob.bind(agent), requestHostJob: async (j: Parameters<HostAgentPort["requestHostJob"]>[0]) => {
      const s = await agent.requestHostJob(j);
      shift = HOST_JOB_START_DEADLINE_MS + 1_000;
      return s;
    } } as unknown as HostAgentPort;
    await executeHostJob(dbClient.db, port, op, () => Date.now() + shift);
    expect(await opOf(id)).toMatchObject({ status: "succeeded" });
    expect((await rowsOf("admin.host_service.restart.end", id))[0]!.details).toMatchObject({ result: "succeeded", exitStatus: 0 });
  }, 20_000);

  it("Health carries the four services from one live read, and null when the agent is unavailable", async () => {
    await start();
    agent.setHostServices([
      { unit: "hp-api", active: true, activeState: "active", since: SINCE, restarts: 0 },
      { unit: "hp-web", active: true, activeState: "active", since: SINCE, restarts: 2 },
      { unit: "hp-docker-executor", active: false, activeState: "failed", since: null, restarts: 5 },
      { unit: "hp-host-agent", active: true, activeState: "activating", since: SINCE, restarts: 1 },
    ]);
    const health = await call("GET", "/v1/admin/health", adminToken);
    expect(health.status).toBe(200);
    expect(named("readHostServices")).toHaveLength(1);
    expect(AdminHealthDtoSchema.parse(health.body.data).hostServices).toEqual([
      { service: "api", active: true, activeState: "active", since: SINCE, restarts: 0 },
      { service: "web", active: true, activeState: "active", since: SINCE, restarts: 2 },
      { service: "executor", active: false, activeState: "failed", since: null, restarts: 5 },
      { service: "host_agent", active: true, activeState: "activating", since: SINCE, restarts: 1 },
    ]);
    agent.setUnavailable(true);
    const down = await call("GET", "/v1/admin/health", adminToken);
    expect(down.status).toBe(200);
    expect(down.body.data.hostServices).toBeNull();
  });

  it("logs/hp-api clamps the lines, cuts the text at 2000, writes no audit row; disabled 422, unreachable 503, unknown source 400", async () => {
    await start();
    agent.setHostJournal("hp-api", [
      { at: SINCE, message: "x".repeat(3_000) },
      { at: "2026-11-17T08:00:01.000Z", message: "Listening (sentinel)." },
    ]);
    const before = (await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).length;
    const read = (source: string, tail = "") => call("GET", `/v1/admin/logs/${encodeURIComponent(source)}${tail}`, adminToken);
    const big = await read("hp-api", "?tail=9000");
    expect(big.status).toBe(200);
    expect(big.body.data).toEqual([
      { at: SINCE, stream: "stdout", text: "x".repeat(2_000) },
      { at: "2026-11-17T08:00:01.000Z", stream: "stdout", text: "Listening (sentinel)." },
    ]);
    const one = await read("hp-api", "?tail=0");
    expect(one.body.data).toHaveLength(1);
    expect((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).length).toBe(before);
    for (const source of ["hp-unit-restart@hp-api", "hp_api", "../hp-api", "HP-API"]) expect((await read(source)).status, source).toBe(400);
    agent.setUnavailable(true);
    const away = await read("hp-os-upgrade");
    expect([away.status, away.body.error?.code]).toEqual([503, "HOST_AGENT_UNAVAILABLE"]);
    expect(away.raw).not.toContain("Host agent is unavailable");
    await app.close();
    await dbClient.close();
    await start({ runtimeBackend: "disabled", hostAgent: undefined });
    const off = await read("hp-web");
    expect([off.status, off.body.error?.code]).toEqual([422, "NOT_SUPPORTED"]);
  });
});
