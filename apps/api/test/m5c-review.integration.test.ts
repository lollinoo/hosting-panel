// R195 repairs: a failed Stop, a restart after a half-failed delete, the owner change of a stopped site, the restart's audit row.
import { randomUUID } from "node:crypto";
import { PLATFORM_OPS_ORG_ID } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  operations,
  serviceInstances,
  sql,
  type DatabaseClient,
} from "@hosting-panel/database";
import { ExecutorCodedError, ExecutorIpcClientError, InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 6);
const PW = "sentinel-password-0002";
const REASON = "sentinel reason";
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Pass-123456",
};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let dbClient: DatabaseClient;
let app: ControlPlaneAppHandle;
let sim: InMemoryDockerSimulatorAdapter;
let token: string;

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

async function call(
  method: string,
  path: string,
  body?: unknown,
  key: string = randomUUID(),
  as: string = token,
): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${app.baseUrl!}${path}`, {
    method,
    headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
}

const run = () => app.outboxWorker.processPendingOnce();
const opOf = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
const svcOf = async (id: string) => (await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.id, id)))[0]!;
const running = (svcId: string) => sim.getSimulatedContainerInspect(svcId)?.State?.Running ?? false;
const engineDown = () => new ExecutorCodedError("engine unreachable", "DOCKER_ENGINE_UNAVAILABLE");
/** The client's answer when the executor's answer to a change it sent cannot be read (#182). */
const unreadable = () =>
  new ExecutorIpcClientError("Unreadable docker-executor IPC answer after mutating command dispatch: the body is not JSON", "OPERATION_AMBIGUOUS", 502, true);

/** Admin list, customer list and site detail of one site, as `org` sees them. */
async function shown(siteId: string, org: string = PLATFORM_OPS_ORG_ID, as: string = token): Promise<string[]> {
  return [
    (await call("GET", "/v1/admin/sites")).body.data.sites.find((s: Json) => s.id === siteId).status,
    (await call("GET", `/v1/organizations/${org}/sites`, undefined, randomUUID(), as)).body.data.find((s: Json) => s.id === siteId).status,
    (await call("GET", `/v1/organizations/${org}/managed-sites/${siteId}`, undefined, randomUUID(), as)).body.data.status,
  ];
}

async function start(): Promise<{ siteId: string; svcId: string }> {
  dbClient = createDatabaseClient({ mode: "pglite" });
  await dbClient.migrate();
  await setupInstallation(dbClient.db, { installationName: "T", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" });
  const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
  sim = new InMemoryDockerSimulatorAdapter();
  app = await createControlPlaneApp({
    listen: true,
    host: "127.0.0.1",
    port: 0,
    databaseClient: dbClient,
    secretsMasterKey: KEY,
    runtimeBackend: "local-simulator",
    dockerExecutor: sim,
    autoProcessOutbox: false,
    outboxPollIntervalMs: null,
    driftReconcileIntervalMs: null,
    domainReconcileIntervalMs: null,
    recoverUnknownOnStart: false,
  });
  token = await login("admin@example.test", PW, admin.totpSecretBase32);
  const res = await call("POST", "/v1/admin/sites", { ...SITE, ownerOrganizationId: null });
  expect(res.status).toBe(202);
  await run();
  const siteId = res.body.data.siteId as string;
  const [svc] = await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId));
  expect(running(svc!.id)).toBe(true);
  return { siteId, svcId: svc!.id };
}

/** The admin stops the platform's own site through a support visit, as its owner would. */
async function stopSite(siteId: string): Promise<string> {
  expect((await call("POST", `/v1/admin/sites/${siteId}/support-access`)).status).toBeLessThan(300);
  const stop = await call("POST", `/v1/organizations/${PLATFORM_OPS_ORG_ID}/managed-sites/${siteId}/actions`, { action: "stop" });
  expect(stop.status).toBe(202);
  await run();
  return stop.body.data.operationId as string;
}

afterEach(async () => {
  await app.close();
  await dbClient.close();
});

describe("1.1 a Stop that failed", () => {
  it("fails for sure: the wanted state goes back to running and every answer says running", async () => {
    const { siteId, svcId } = await start();
    vi.spyOn(sim, "stopService").mockRejectedValueOnce(engineDown());
    const op = await opOf(await stopSite(siteId));
    expect(op).toMatchObject({ status: "failed", errorMessage: "This action did not finish. Try again in a few minutes." });
    expect([running(svcId), (await svcOf(svcId)).desiredStatus]).toEqual([true, "running"]);
    expect(await shown(siteId)).toEqual(["ready", "ready", "ready"]);
  });

  it("is ambiguous: the wanted state stays stopped", async () => {
    const { siteId, svcId } = await start();
    vi.spyOn(sim, "stopService").mockRejectedValueOnce(new ExecutorCodedError("timed out", "OPERATION_AMBIGUOUS"));
    expect((await opOf(await stopSite(siteId))).status).toBe("unknown");
    expect((await svcOf(svcId)).desiredStatus).toBe("stopped");
  });

  /** The client's answers to a Stop it sent: its wait ended, or the answer cannot be read (#182). */
  const LOST: readonly (readonly [string, () => Error])[] = [
    ["timed out", () => new ExecutorCodedError("timed out", "OPERATION_AMBIGUOUS")],
    ["answered unreadably", unreadable],
  ];

  /** A Stop left in doubt, then `act` on the container, then the recovery pass (R196 1.1), which reads and never stops again. */
  async function stopInDoubtThenRecover(act: (svcId: string) => Promise<unknown>, lost: () => Error = LOST[0]![1]) {
    const { siteId, svcId } = await start();
    const stops = vi.spyOn(sim, "stopService").mockRejectedValueOnce(lost());
    const opId = await stopSite(siteId);
    expect((await opOf(opId)).status).toBe("unknown");
    await act(svcId);
    const sent = stops.mock.calls.length;
    await app.outboxWorker.recoverUnknownOperations();
    expect(stops.mock.calls.length).toBe(sent);
    return { siteId, svcId, op: await opOf(opId) };
  }

  it.each(LOST)("%s, recovery sees it running: failed, the wanted state goes back to running", async (_, lost) => {
    const { siteId, svcId, op } = await stopInDoubtThenRecover(async () => undefined, lost);
    expect(op).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
    expect([running(svcId), (await svcOf(svcId)).desiredStatus]).toEqual([true, "running"]);
    expect(await shown(siteId)).toEqual(["ready", "ready", "ready"]);
  });

  it.each(LOST)("%s, recovery sees it stopped: succeeded, the wanted state stays stopped", async (_, lost) => {
    const { svcId, op } = await stopInDoubtThenRecover((id) => sim.stopService(id), lost);
    expect(op.status).toBe("succeeded");
    expect([running(svcId), (await svcOf(svcId)).desiredStatus]).toEqual([false, "stopped"]);
  });

  it("in doubt, recovery finds no container: failed, the wanted state stays stopped", async () => {
    const { svcId, op } = await stopInDoubtThenRecover((id) => sim.deleteService(id));
    expect(op).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
    expect(sim.getSimulatedContainerInspect(svcId)).toBeNull();
    expect((await svcOf(svcId)).desiredStatus).toBe("stopped");
  });

  it("works: the site is stopped as before", async () => {
    const { siteId, svcId } = await start();
    expect((await opOf(await stopSite(siteId))).status).toBe("succeeded");
    expect([running(svcId), (await svcOf(svcId)).desiredStatus]).toEqual([false, "stopped"]);
    expect(await shown(siteId)).toEqual(["stopped", "stopped", "stopped"]);
  });
});

describe("1.2 Restart after a delete that failed halfway", () => {
  it("creates no container and fails as for a site that was never set up", async () => {
    const { siteId, svcId } = await start();
    vi.spyOn(sim, "purgeSite").mockRejectedValueOnce(engineDown());
    const del = await call("DELETE", `/v1/admin/sites/${siteId}`, { confirmName: SITE.name });
    expect(del.status).toBe(202);
    await run();
    expect((await opOf(del.body.data.operationId as string)).status).toBe("failed");
    expect(sim.getSimulatedContainerInspect(svcId)).toBeNull();
    const deploys = sim.deployedSpecs.length;
    const restart = await call("POST", `/v1/admin/sites/${siteId}/restart`, { reason: REASON });
    expect(restart.status).toBe(202);
    await run();
    expect(await opOf(restart.body.data.operationId as string)).toMatchObject({ status: "failed", errorCode: "NOT_FOUND" });
    expect(sim.deployedSpecs.length).toBe(deploys);
    expect(sim.getSimulatedContainerInspect(svcId)).toBeNull();
  });
});

describe("1.3 owner change of a stopped site whose stop after the redeploy fails", () => {
  it("leaves the wanted state running and the operation failed; Try again finishes the move", async () => {
    const { siteId, svcId } = await start();
    await stopSite(siteId);
    const created = await call("POST", "/v1/admin/customer-account", {
      organizationName: "Customer B",
      ownerEmail: "owner-b@example.test",
      ownerName: "Owner B",
    });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "owner-b@example.test");
    const orgId = created.body.data.organizationId as string;
    const customer = await login("owner-b@example.test", created.body.data.temporaryPassword as string);

    vi.spyOn(sim, "stopService").mockRejectedValueOnce(engineDown());
    const move = await call("POST", `/v1/admin/sites/${siteId}/owner`, { ownerOrganizationId: orgId });
    expect(move.status).toBe(202);
    await run();
    expect(await opOf(move.body.data.operationId as string)).toMatchObject({ status: "failed" });
    expect([running(svcId), (await svcOf(svcId)).desiredStatus]).toEqual([true, "running"]);
    expect(await shown(siteId, orgId, customer)).toEqual(["degraded", "degraded", "degraded"]);

    const retry = await call("POST", `/v1/admin/sites/${siteId}/actions`, { action: "retry" });
    expect(retry.status).toBe(202);
    await run();
    expect((await opOf(retry.body.data.operationId as string)).status).toBe("succeeded");
    expect([running(svcId), (await svcOf(svcId)).desiredStatus]).toEqual([true, "running"]);
    expect(await shown(siteId, orgId, customer)).toEqual(["ready", "ready", "ready"]);
  });
});

describe("an answer the client cannot read to the site's own changes (#182)", () => {
  const adminStatus = async (siteId: string) =>
    (await call("GET", "/v1/admin/sites")).body.data.sites.find((s: Json) => s.id === siteId)?.status as string | undefined;
  async function moveToNewOwner(siteId: string): Promise<string> {
    const created = await call("POST", "/v1/admin/customer-account", {
      organizationName: "Customer B",
      ownerEmail: "owner-b@example.test",
      ownerName: "Owner B",
    });
    expect(created.status).toBe(201);
    const move = await call("POST", `/v1/admin/sites/${siteId}/owner`, { ownerOrganizationId: created.body.data.organizationId as string });
    expect(move.status).toBe(202);
    await run();
    return move.body.data.operationId as string;
  }

  it("to a delete: the operation failed and the site degraded, as before", async () => {
    const { siteId } = await start();
    vi.spyOn(sim, "deleteService").mockRejectedValueOnce(unreadable());
    const del = await call("DELETE", `/v1/admin/sites/${siteId}`, { confirmName: SITE.name });
    expect(del.status).toBe(202);
    await run();
    expect((await opOf(del.body.data.operationId as string)).status).toBe("failed");
    expect(await adminStatus(siteId)).toBe("degraded");
  });

  it("to the redeploy of an owner change: the operation failed and the site degraded, as before", async () => {
    const { siteId } = await start();
    vi.spyOn(sim, "deployService").mockRejectedValueOnce(unreadable());
    expect((await opOf(await moveToNewOwner(siteId))).status).toBe("failed");
    expect(await adminStatus(siteId)).toBe("degraded");
  });

  it("to the stop after the redeploy of a stopped site: the wanted state stays stopped, as after a lost answer", async () => {
    const { siteId, svcId } = await start();
    await stopSite(siteId);
    const stop = sim.stopService.bind(sim);
    vi.spyOn(sim, "stopService").mockImplementationOnce(async (id) => {
      await stop(id);
      throw unreadable();
    });
    expect((await opOf(await moveToNewOwner(siteId))).status).toBe("failed");
    expect([running(svcId), (await svcOf(svcId)).desiredStatus]).toEqual([false, "stopped"]);
    expect(await adminStatus(siteId)).toBe("degraded");
  });
});

describe("1.4 the audit row of a site restart", () => {
  const rows = async () => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.site.restart"));
  const restarts = async () => dbClient.db.select().from(operations).where(eq(operations.kind, "service.restart"));

  it("is written once with the operation, not again on a replay, and not at all without the operation", async () => {
    const { siteId } = await start();
    await dbClient.db.execute(
      sql.raw(`CREATE FUNCTION hp_test_fail_audit() RETURNS trigger AS $$
        BEGIN IF NEW.action = 'admin.site.restart' THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`),
    );
    await dbClient.db.execute(
      sql.raw("CREATE TRIGGER hp_test_fail_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION hp_test_fail_audit()"),
    );
    const key = randomUUID();
    expect((await call("POST", `/v1/admin/sites/${siteId}/restart`, { reason: REASON }, key)).status).toBe(500);
    expect([await restarts(), await rows()]).toEqual([[], []]);

    await dbClient.db.execute(sql.raw("DROP TRIGGER hp_test_fail_audit ON audit_events"));
    const first = await call("POST", `/v1/admin/sites/${siteId}/restart`, { reason: REASON }, key);
    const replay = await call("POST", `/v1/admin/sites/${siteId}/restart`, { reason: REASON }, key);
    expect([first.status, replay.status]).toEqual([202, 202]);
    expect(replay.body.data.operationId).toBe(first.body.data.operationId);
    expect(await restarts()).toHaveLength(1);
    const [row, ...more] = await rows();
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      actorType: "user",
      organizationId: null,
      targetType: "site",
      targetId: siteId,
      details: { outcome: "succeeded", operationId: first.body.data.operationId, reason: REASON },
    });
    expect(row!.actorId).toBeTruthy();
    expect(row!.ipAddress).toBeTruthy();
  });
});

describe("1.5 a container that Restart rebuilt", () => {
  it("has the volumes of the stored revision", async () => {
    const { siteId, svcId } = await start();
    const mounts = () => sim.deployedSpecs.filter((s) => s.serviceInstanceId === svcId).at(-1)!.volumeMounts;
    const binds = () => sim.getSimulatedContainerInspect(svcId)!.HostConfig?.Binds;
    const before = { mounts: mounts(), binds: binds(), deploys: sim.deployedSpecs.length };
    expect(before.mounts?.length).toBeGreaterThan(0);
    await sim.deleteService(svcId);
    const restart = await call("POST", `/v1/admin/sites/${siteId}/restart`, { reason: REASON });
    expect(restart.status).toBe(202);
    await run();
    expect((await opOf(restart.body.data.operationId as string)).status).toBe("succeeded");
    expect(sim.deployedSpecs.length).toBe(before.deploys + 1);
    expect({ mounts: mounts(), binds: binds() }).toEqual({ mounts: before.mounts, binds: before.binds });
  });
});
