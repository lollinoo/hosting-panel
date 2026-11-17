import { randomUUID } from "node:crypto";
import {
  ComponentApplyAcceptedDtoSchema,
  HostJobAcceptedDtoSchema,
  OsPackagesDtoSchema,
  PANEL_RELEASE_LATEST_URL,
  PLATFORM_OPS_ORG_ID,
  SiteImageUpdateAcceptedDtoSchema,
  UpdatesDtoSchema,
  resolveWordpressImage,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  eq,
  operations,
  serviceInstances,
  sites,
  sql,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { ensurePlatformOpsOrg } from "../src/backups/backup-scheduler.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle, type CreateControlPlaneAppOptions } from "../src/index.js";
import { recoverPanelContainerApply } from "../src/updates/panel-container-apply.js";

// The version this process "runs"; the updater changing it is a new process reading another RELEASE.json.
const version = vi.hoisted(() => ({ current: "1.4.2" as string | null }));
vi.mock("../src/updates/release-version.js", async (load) => ({
  ...(await load<typeof import("../src/updates/release-version.js")>()),
  installedPanelVersion: () => version.current,
}));

const KEY = Buffer.alloc(32, 9);
const PW = "sentinel-password-0009";
const SETUP = { installationName: "Updates Test", hostHostname: "panel.example.test", hostIpv4: "192.0.2.1" };
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Pass-123456",
};
// Revisions are immutable: a site is put behind by moving its PHP version with no new revision.
const OLD_IMAGE = resolveWordpressImage("8.4");
const PACKAGE = { name: "libsentinel1", installedVersion: "1.0-1", newVersion: "1.0-2", origin: "security" as const };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("admin updates and system packages", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let agent: InMemoryHostSimulatorAdapter;
  let adminToken: string;
  let release: { status: number; body: unknown } | "throw";
  let releaseCalls: RequestInit[];

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}) }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, as = adminToken, key: string | null = randomUUID(), body?: unknown): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  async function start(opts: Partial<CreateControlPlaneAppOptions> = {}): Promise<void> {
    version.current = "1.4.2";
    release = { status: 404, body: { message: "Not Found" } };
    releaseCalls = [];
    const realFetch = globalThis.fetch;
    // Only the release URL is faked; every other request goes to the local app.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) !== PANEL_RELEASE_LATEST_URL) return realFetch(input, init);
      releaseCalls.push(init ?? {});
      if (release === "throw") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(release.body), { status: release.status });
    });
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    agent = new InMemoryHostSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: sim as DockerExecutorPort,
      hostAgent: agent as HostAgentPort,
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
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  const runWorker = () => app.outboxWorker.processPendingOnce();
  const heartbeat = () => app.driftReconciler.reconcileAllOnce();
  const opOf = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const rowsOf = async (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const age = (id: string, ms: number) => dbClient.db.update(operations).set({ submittedAt: new Date(Date.now() - ms) }).where(eq(operations.id, id));
  const updates = async () => {
    const res = await call("GET", "/v1/admin/updates");
    expect(res.status).toBe(200);
    return UpdatesDtoSchema.parse(res.body.data);
  };

  async function createSite(site: Partial<typeof SITE> = {}): Promise<{ siteId: string; serviceId: string }> {
    const res = await call("POST", "/v1/admin/sites", adminToken, randomUUID(), { ...SITE, ...site, ownerOrganizationId: null });
    expect(res.status).toBe(202);
    await runWorker();
    const siteId = res.body.data.siteId as string;
    const [svc] = await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId));
    return { siteId, serviceId: svc!.id };
  }
  const putBehind = (siteId: string) => dbClient.db.update(sites).set({ phpVersion: "8.5" }).where(eq(sites.id, siteId));

  async function customerToken(): Promise<string> {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, randomUUID(), { organizationName: "Org A", ownerEmail: "owner@example.test", ownerName: "Owner" });
    expect(created.status).toBe(201);
    return login("owner@example.test", created.body.data.temporaryPassword as string);
  }

  /** Runs one panel_update with the simulator's exit status and the version the new process reads. */
  async function panelUpdateEnds(exitStatus: number, after: string | null) {
    if (exitStatus !== 0) agent.setHostJobExitStatus("panel_update", exitStatus);
    const res = await call("POST", "/v1/admin/updates/panel/apply");
    expect(res.status).toBe(202);
    const { operationId } = HostJobAcceptedDtoSchema.parse(res.body.data);
    version.current = after;
    await age(operationId, 3_000);
    await runWorker();
    const end = (await rowsOf("admin.update.panel.end")).filter((r) => (r.details as Json).operationId === operationId);
    expect(end).toHaveLength(1);
    return { operationId, end: end[0]!.details as Json, op: await opOf(operationId) };
  }

  it("GET updates: installed version, never_checked, five components from the heartbeat, no sites", async () => {
    await start();
    let dto = await updates();
    expect(dto.panel).toEqual({ installedVersion: "1.4.2", check: { state: "never_checked", latestVersion: null, checkedAt: null }, running: null, last: null });
    expect(dto.components.map((c) => [c.component, c.expected, c.imageCurrent, c.runningOperationId])).toEqual([
      ["ingress_proxy", null, null, null], ["shared_database", null, null, null], ["phpmyadmin", null, null, null], ["sftp", null, null, null], ["mail_relay", null, null, null],
    ]);
    sim.setPanelContainer("shared_database", { imageCurrent: false });
    await heartbeat();
    dto = await updates();
    expect(dto.components.map((c) => [c.component, c.imageCurrent])).toEqual([
      ["ingress_proxy", true], ["shared_database", false], ["phpmyadmin", null], ["sftp", null], ["mail_relay", null],
    ]);
    expect([dto.sites, dto.sitesTotal]).toEqual([[], 0]);
    expect(releaseCalls).toEqual([]);
  });

  it("POST check: 404 is no_release, a tag is newer or up_to_date, a failure is failed; one row each, kept in memory", async () => {
    await start();
    let res = await call("POST", "/v1/admin/updates/panel/check");
    expect(res.status).toBe(200);
    expect(UpdatesDtoSchema.parse(res.body.data).panel.check).toMatchObject({ state: "no_release", latestVersion: null });
    release = { status: 200, body: { tag_name: "v1.5.0" } };
    res = await call("POST", "/v1/admin/updates/panel/check");
    const check = UpdatesDtoSchema.parse(res.body.data).panel.check;
    expect(check).toMatchObject({ state: "newer", latestVersion: "1.5.0" });
    expect(Date.parse(check.checkedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect((await updates()).panel.check).toEqual(check);
    release = { status: 200, body: { tag_name: "v1.4.2" } };
    expect((await call("POST", "/v1/admin/updates/panel/check")).body.data.panel.check.state).toBe("up_to_date");
    release = "throw";
    expect((await call("POST", "/v1/admin/updates/panel/check")).body.data.panel.check).toMatchObject({ state: "failed", latestVersion: null });
    const rows = await rowsOf("admin.update.check");
    expect(rows.map((r) => [(r.details as Json).state, (r.details as Json).latestVersion])).toEqual([
      ["no_release", null], ["newer", "1.5.0"], ["up_to_date", "1.4.2"], ["failed", null],
    ]);
    expect(rows[0]).toMatchObject({ actorType: "user", organizationId: PLATFORM_OPS_ORG_ID, targetType: "platform" });
    expect(Object.keys(rows[0]!.details as Json).sort()).toEqual(["latestVersion", "outcome", "state"]);
    expect(releaseCalls).toHaveLength(4);
    for (const init of releaseCalls) {
      expect(init.redirect).toBe("error");
      expect(Object.keys(init.headers as Json).sort()).toEqual(["accept", "user-agent"]);
    }
  });

  it("panel apply: 202 with the request row and fromVersion; ends updated, already_current, rolled_back, rollback_unhealthy", async () => {
    await start();
    const updated = await panelUpdateEnds(0, "1.5.0");
    expect(updated.op).toMatchObject({ kind: "host.job", resourceId: "panel_update", status: "succeeded" });
    expect(updated.end).toMatchObject({ outcome: "succeeded", result: "updated", exitStatus: 0, fromVersion: "1.4.2", toVersion: "1.5.0" });
    const [request] = (await rowsOf("admin.update.panel")).filter((r) => (r.details as Json).operationId === updated.operationId);
    expect(request).toMatchObject({ actorType: "user", targetType: "host", targetId: "panel_update" });
    expect(Object.keys(request!.details as Json).sort()).toEqual(["fromVersion", "operationId", "outcome", "requestId"]);
    expect((request!.details as Json).fromVersion).toBe("1.4.2");
    let dto = await updates();
    expect(dto.panel.last).toMatchObject({ operationId: updated.operationId, result: "updated" });

    expect((await panelUpdateEnds(0, "1.5.0")).end).toMatchObject({ result: "already_current", fromVersion: "1.5.0", toVersion: "1.5.0" });
    const rolled = await panelUpdateEnds(6, "1.5.0");
    expect([rolled.op.status, rolled.op.errorCode, rolled.end.result]).toEqual(["failed", "HOST_JOB_FAILED", "rolled_back"]);
    const unhealthy = await panelUpdateEnds(7, "1.5.0");
    expect([unhealthy.op.status, unhealthy.end.result]).toEqual(["failed", "rollback_unhealthy"]);
    dto = await updates();
    expect(dto.panel.last).toMatchObject({ operationId: unhealthy.operationId, result: "rollback_unhealthy" });
  }, 60_000);

  it("panel apply: running shows in GET, a second one is 409 host_job_running, a missing key is 400, a body version is ignored", async () => {
    await start();
    agent.holdHostJob("panel_update");
    const res = await call("POST", "/v1/admin/updates/panel/apply", adminToken, randomUUID(), { version: "9.9.9" });
    expect(res.status).toBe(202);
    expect((await updates()).panel.running).toEqual({ operationId: res.body.data.operationId });
    const second = await call("POST", "/v1/admin/updates/panel/apply");
    expect([second.status, second.body.error?.code, second.body.error?.details?.[0]?.reason]).toEqual([409, "RESOURCE_LOCKED", "host_job_running"]);
    const noKey = await call("POST", "/v1/admin/updates/panel/apply", adminToken, null);
    expect(noKey.status).toBe(400);
    const rows = await rowsOf("admin.update.panel");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("9.9.9");
  });

  it("panel apply during site work is 409 site_work_running", async () => {
    await start();
    await ensurePlatformOpsOrg(dbClient.db);
    await enqueueOperationTransactional(dbClient.db, {
      organizationId: PLATFORM_OPS_ORG_ID, kind: "site.backups.create", resourceType: "site", resourceId: "site_sentinel", steps: [{ key: "run", label: "Run" }],
    });
    const res = await call("POST", "/v1/admin/updates/panel/apply");
    expect([res.status, res.body.error?.details?.[0]?.reason]).toEqual([409, "site_work_running"]);
  });

  it("component apply: an operation under panel:container:<c> with its rows; the worker moves the image; replay and lock", async () => {
    await start();
    sim.setPanelContainer("shared_database", { imageCurrent: false });
    await heartbeat();
    const key = randomUUID();
    const res = await call("POST", "/v1/admin/updates/components/shared_database/apply", adminToken, key);
    expect(res.status).toBe(202);
    const data = ComponentApplyAcceptedDtoSchema.parse(res.body.data);
    expect(data.component).toBe("shared_database");
    const op = await opOf(data.operationId!);
    expect(op).toMatchObject({ kind: "panel.container.apply", resourceId: "shared_database", lockKey: "panel:container:shared_database", status: "queued" });
    expect((await updates()).components[1]).toMatchObject({ imageCurrent: false, runningOperationId: data.operationId });
    const replay = await call("POST", "/v1/admin/updates/components/shared_database/apply", adminToken, key);
    expect(replay.body.data.operationId).toBe(data.operationId);
    const restart = await call("POST", "/v1/admin/panel-containers/shared_database/restart", adminToken, randomUUID(), { reason: "Sentinel reason for the restart" });
    expect([restart.status, restart.body.error?.code]).toEqual([409, "RESOURCE_LOCKED"]);
    const requests = await rowsOf("admin.update.component");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ targetType: "panel_container", targetId: "shared_database" });
    expect(requests[0]!.details).toMatchObject({ outcome: "succeeded", operationId: data.operationId, component: "shared_database" });
    await age(data.operationId!, 3_000);
    await runWorker();
    expect(await opOf(data.operationId!)).toMatchObject({ status: "succeeded" });
    const ends = await rowsOf("admin.update.component.end");
    expect(ends.map((r) => r.details)).toEqual([{ operationId: data.operationId, component: "shared_database", outcome: "succeeded", errorCode: null }]);
    await heartbeat();
    expect((await updates()).components[1]).toMatchObject({ imageCurrent: true, runningOperationId: null });
  }, 20_000);

  it("R202 3: shared_database apply waits for site work; other containers do not; a replay answers its operation", async () => {
    await start();
    sim.setPanelContainer("shared_database", { imageCurrent: false });
    sim.setPanelContainer("ingress_proxy", { imageCurrent: false });
    await heartbeat();
    const key = randomUUID();
    const first = await call("POST", "/v1/admin/updates/components/shared_database/apply", adminToken, key);
    expect(first.status).toBe(202);
    await ensurePlatformOpsOrg(dbClient.db);
    await enqueueOperationTransactional(dbClient.db, {
      organizationId: PLATFORM_OPS_ORG_ID, kind: "site.backups.create", resourceType: "site", resourceId: "site_sentinel", steps: [{ key: "run", label: "Run" }],
    });
    const replay = await call("POST", "/v1/admin/updates/components/shared_database/apply", adminToken, key);
    expect([replay.status, replay.body.data.operationId]).toEqual([202, first.body.data.operationId]);
    await dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, first.body.data.operationId as string));
    const refused = await call("POST", "/v1/admin/updates/components/shared_database/apply");
    expect([refused.status, refused.body.error?.code, refused.body.error?.details?.[0]?.reason]).toEqual([409, "RESOURCE_LOCKED", "site_work_running"]);
    expect(await dbClient.db.select().from(operations).where(eq(operations.kind, "panel.container.apply"))).toHaveLength(1);
    expect(await rowsOf("admin.update.component")).toHaveLength(1);
    const proxy = await call("POST", "/v1/admin/updates/components/ingress_proxy/apply");
    expect(proxy.status).toBe(202);
  }, 20_000);

  it("component apply: absent is 409, mail_relay answers a null operation, a bad name is 400, stale and recovered ends are failed once", async () => {
    await start();
    await heartbeat();
    const absent = await call("POST", "/v1/admin/updates/components/sftp/apply");
    expect([absent.status, absent.body.error?.code]).toEqual([409, "PANEL_CONTAINER_ABSENT"]);
    sim.setPanelContainer("mail_relay", { state: "running", expected: true });
    await heartbeat();
    const relay = await call("POST", "/v1/admin/updates/components/mail_relay/apply");
    expect([relay.status, relay.body.data]).toEqual([202, { component: "mail_relay", operationId: null }]);
    expect((await rowsOf("admin.update.component"))[0]!.details).toMatchObject({ component: "mail_relay", operationId: null });
    expect(await dbClient.db.select().from(operations).where(eq(operations.kind, "panel.container.apply"))).toEqual([]);
    for (const name of ["docker", "hp_sftp", "SFTP", "api"]) {
      expect((await call("POST", `/v1/admin/updates/components/${name}/apply`)).status, name).toBe(400);
    }
    expect((await call("POST", "/v1/admin/updates/components/ingress_proxy/apply", adminToken, null)).status).toBe(400);

    const stale = (await call("POST", "/v1/admin/updates/components/ingress_proxy/apply")).body.data.operationId as string;
    await age(stale, 61_000);
    const applied = vi.spyOn(sim, "applyPanelContainerPin");
    await runWorker();
    expect(applied).not.toHaveBeenCalled();
    expect(await opOf(stale)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
    await recoverPanelContainerApply(dbClient.db, await opOf(stale));
    expect((await rowsOf("admin.update.component.end")).map((r) => (r.details as Json).errorCode)).toEqual(["OPERATION_INTERRUPTED"]);
  });

  it("sites behind the pin: listed with sitesTotal and stopped; image update deploys under site:<id>; replay writes one row", async () => {
    await start();
    const { siteId, serviceId } = await createSite();
    expect((await updates()).sitesTotal).toBe(0);
    const current = await call("POST", `/v1/admin/sites/${siteId}/image-update`);
    expect([current.status, current.body.error?.code, current.body.error?.details?.[0]?.reason]).toEqual([400, "VALIDATION_ERROR", "already_current"]);
    await putBehind(siteId);
    let dto = await updates();
    expect([dto.sites, dto.sitesTotal]).toEqual([[{ siteId, siteName: "Site A", organizationName: null, phpVersion: "8.5", stopped: false }], 1]);

    await dbClient.db.update(serviceInstances).set({ desiredStatus: "stopped" }).where(eq(serviceInstances.id, serviceId));
    expect((await updates()).sites[0]!.stopped).toBe(true);
    const stopped = await call("POST", `/v1/admin/sites/${siteId}/image-update`);
    expect([stopped.status, stopped.body.error?.details?.[0]?.reason]).toEqual([400, "stopped"]);
    await dbClient.db.update(serviceInstances).set({ desiredStatus: "running" }).where(eq(serviceInstances.id, serviceId));

    const key = randomUUID();
    const res = await call("POST", `/v1/admin/sites/${siteId}/image-update`, adminToken, key);
    expect(res.status).toBe(202);
    const data = SiteImageUpdateAcceptedDtoSchema.parse(res.body.data);
    expect(data.siteId).toBe(siteId);
    expect(await opOf(data.operationId)).toMatchObject({ kind: "service.deploy", lockKey: `site:${siteId}` });
    const replay = await call("POST", `/v1/admin/sites/${siteId}/image-update`, adminToken, key);
    expect([replay.status, replay.body.data.operationId]).toEqual([202, data.operationId]);
    const rows = await rowsOf("admin.update.site_image");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toEqual({
      outcome: "succeeded", requestId: expect.any(String), operationId: data.operationId, siteId,
      organizationId: PLATFORM_OPS_ORG_ID, fromImage: OLD_IMAGE, toImage: resolveWordpressImage("8.5"),
    });
    await runWorker();
    dto = await updates();
    expect([dto.sites, dto.sitesTotal]).toEqual([[], 0]);
    expect((await call("POST", "/v1/admin/sites/site_missing/image-update")).status).toBe(404);
  }, 30_000);

  it("R202 2.2: an image update whose audit row cannot be written leaves no operation and answers an error", async () => {
    await start();
    const { siteId, serviceId } = await createSite();
    await putBehind(siteId);
    const deploys = async () => dbClient.db.select().from(operations).where(eq(operations.resourceId, serviceId));
    const before = (await deploys()).length;
    await dbClient.db.execute(sql.raw(`CREATE FUNCTION sentinel_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'admin.update.site_image' THEN RAISE EXCEPTION 'sentinel refusal'; END IF; RETURN NEW; END $$`));
    await dbClient.db.execute(sql.raw(`CREATE TRIGGER sentinel_refuse BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION sentinel_refuse();`));
    const res = await call("POST", `/v1/admin/sites/${siteId}/image-update`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await deploys()).toHaveLength(before);
    expect((await dbClient.db.select().from(sites).where(eq(sites.id, siteId)))[0]!.phpVersion).toBe("8.5");
    expect(await rowsOf("admin.update.site_image")).toEqual([]);
  }, 30_000);

  it("R202 3: a key used for site A, sent for site B, never answers site A's operation", async () => {
    await start();
    const a = await createSite();
    const b = await createSite({ name: "Site B", domain: "wp-b.example.test", title: "Site B" });
    await putBehind(a.siteId);
    await putBehind(b.siteId);
    const key = randomUUID();
    const first = await call("POST", `/v1/admin/sites/${a.siteId}/image-update`, adminToken, key);
    expect(first.status).toBe(202);
    const second = await call("POST", `/v1/admin/sites/${b.siteId}/image-update`, adminToken, key);
    expect(second.status).not.toBe(202);
    expect(second.raw).not.toContain(first.body.data.operationId as string);
    expect(await rowsOf("admin.update.site_image")).toHaveLength(1);
  }, 30_000);

  it("os-packages: the live list with canUpgrade and the running job; refresh and upgrade are host jobs; 503 when unreachable", async () => {
    await start();
    agent.setOsPackages({ packages: [PACKAGE], rebootRequired: true, canUpgrade: true, listsReadAt: "2026-11-17T06:00:00.000Z" });
    let res = await call("GET", "/v1/admin/os-packages");
    expect(res.status).toBe(200);
    expect(OsPackagesDtoSchema.parse(res.body.data)).toEqual({
      packages: [PACKAGE], rebootRequired: true, canUpgrade: true, listsReadAt: "2026-11-17T06:00:00.000Z", running: null,
    });
    agent.holdHostJob("os_refresh");
    const refresh = await call("POST", "/v1/admin/os-packages/refresh");
    expect(refresh.status).toBe(202);
    const { operationId } = HostJobAcceptedDtoSchema.parse(refresh.body.data);
    res = await call("GET", "/v1/admin/os-packages");
    expect(res.body.data.running).toEqual({ operationId, job: "os_refresh" });
    expect(await opOf(operationId)).toMatchObject({ kind: "host.job", resourceId: "os_refresh" });
    const busy = await call("POST", "/v1/admin/os-packages/upgrade");
    expect([busy.status, busy.body.error?.details?.[0]?.reason]).toEqual([409, "host_job_running"]);
    agent.releaseHostJob("os_refresh");
    await age(operationId, 3_000);
    await runWorker();
    const upgrade = await call("POST", "/v1/admin/os-packages/upgrade");
    expect(upgrade.status).toBe(202);
    const rows = [...(await rowsOf("admin.os_packages.refresh")), ...(await rowsOf("admin.os_packages.upgrade"))];
    expect(rows.map((r) => [r.action, r.targetId, Object.keys(r.details as Json).sort().join(",")])).toEqual([
      ["admin.os_packages.refresh", "os_refresh", "operationId,outcome,requestId"],
      ["admin.os_packages.upgrade", "os_upgrade", "operationId,outcome,requestId"],
    ]);
    const everything = JSON.stringify([await dbClient.db.select().from(auditEvents), await dbClient.db.select().from(operations)]);
    expect(everything).not.toContain(PACKAGE.name);
    agent.setUnavailable(true);
    res = await call("GET", "/v1/admin/os-packages");
    expect([res.status, res.body.error?.code]).toEqual([503, "HOST_AGENT_UNAVAILABLE"]);
    expect(res.raw).not.toContain(PACKAGE.name);
  }, 20_000);

  it("a customer gets 403 and a denied row on all eight routes, and nothing is queued", async () => {
    await start();
    const { siteId } = await createSite();
    const token = await customerToken();
    const routes: Array<[string, string]> = [
      ["GET", "/v1/admin/updates"], ["POST", "/v1/admin/updates/panel/check"], ["POST", "/v1/admin/updates/panel/apply"],
      ["POST", "/v1/admin/updates/components/sftp/apply"], ["POST", `/v1/admin/sites/${siteId}/image-update`],
      ["GET", "/v1/admin/os-packages"], ["POST", "/v1/admin/os-packages/refresh"], ["POST", "/v1/admin/os-packages/upgrade"],
    ];
    const before = (await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id);
    const opsBefore = (await dbClient.db.select().from(operations)).length;
    for (const [method, path] of routes) expect((await call(method, path, token)).status, path).toBe(403);
    const added = (await dbClient.db.select().from(auditEvents)).filter((r) => !before.includes(r.id));
    expect(added.map((r) => (r.details as Json).outcome)).toEqual(routes.map(() => "denied"));
    expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
    expect(releaseCalls).toEqual([]);
  }, 20_000);

  it("disabled runtime: every job, apply, site update and the package list answer 422 before anything is queued; the check still works", async () => {
    await start({ runtimeBackend: "disabled", hostAgent: undefined, dockerExecutor: undefined });
    for (const [method, path] of [
      ["POST", "/v1/admin/updates/panel/apply"], ["POST", "/v1/admin/updates/components/sftp/apply"],
      ["POST", "/v1/admin/sites/site_any/image-update"], ["GET", "/v1/admin/os-packages"],
      ["POST", "/v1/admin/os-packages/refresh"], ["POST", "/v1/admin/os-packages/upgrade"],
    ] as const) {
      const res = await call(method, path);
      expect([res.status, res.body.error?.code], path).toEqual([422, "NOT_SUPPORTED"]);
    }
    expect(await dbClient.db.select().from(operations)).toEqual([]);
    release = { status: 200, body: { tag_name: "v1.5.0" } };
    const check = await call("POST", "/v1/admin/updates/panel/check");
    expect([check.status, check.body.data.panel.check.state]).toEqual([200, "newer"]);
  });
});
