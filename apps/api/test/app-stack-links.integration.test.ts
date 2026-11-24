import { randomUUID } from "node:crypto";
import {
  APP_BUILT_IN_TEMPLATES,
  APP_IMAGE_ALLOWLIST,
  AppStackLinksDtoSchema,
  appStackLinkAlias,
  isTerminalOperationStatus,
} from "@hosting-panel/contracts";
import {
  and,
  appStackLinks,
  appStacks,
  auditEvents,
  backupTargets,
  builtInAppTemplateItems,
  ensureBuiltInAppTemplates,
  eq,
  getPolicy,
  inArray,
  operations,
  resourceQuotas,
  rolePermissions,
  roles,
  setPolicyTargets,
} from "@hosting-panel/database";
import { appStackInternalNetworkName, type InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppStackLinksApplier } from "../src/app-stacks/app-stack-links-applier.js";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

// ADR-0039 through HTTP, on the simulator: a database is an application of a `database` template; an application of the
// same customer is connected to it by a link, a row the server is brought to. A link carries no value of the database,
// never restarts anything and never fails a change of either application.

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Reply = { status: number; body: Json; raw: string };

const builtIn = (slug: string) => APP_BUILT_IN_TEMPLATES.find((t) => t.slug === slug)!;
const WEB = APP_BUILT_IN_TEMPLATES[0]!;
const MARIADB = builtIn("mariadb");
const VALKEY = builtIn("valkey");
/** A value no answer, audit row or operation may carry. */
const PASSWORD = "Sup3r-Reserved-Value-7c1e";
const LINK_KEYS = [
  "applicationName",
  "applicationStackId",
  "connection",
  "createdAt",
  "databaseKind",
  "databaseName",
  "databaseStackId",
  "id",
  "state",
];
/** Two ports: a database nothing can be connected to. */
const TWO_PORTS = (source: string, port: number, second: number) =>
  source.replace(`    expose:\n      - ${String(port)}\n`, `    expose:\n      - ${String(port)}\n      - ${String(second)}\n`);

function expectRefusal(res: Reply, status: number, code: string, detail?: Json): void {
  expect(res.status, res.raw).toBe(status);
  expect(res.body.error.code).toBe(code);
  if (detail) expect(res.body.error.details).toContainEqual(expect.objectContaining(detail));
}

describe("private links between a database and an application (ADR-0039)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let worker: OutboxWorkerService;
  let observer: AppStackObserverService;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    // The harness injects its own database client, so the app skipped its boot seeding: run the call a boot makes.
    await ensureBuiltInAppTemplates(h.dbClient.db, builtInAppTemplateItems());
    for (const template of [WEB, MARIADB, VALKEY]) {
      const enabled = await h.call(h.adminToken, "PATCH", `/v1/admin/app-templates/${template.templateId}`, { enabled: true });
      expect(enabled.status, enabled.raw).toBe(200);
    }
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    worker = h.app.nestApp.get(OutboxWorkerService);
    observer = h.app.nestApp.get(AppStackObserverService);
    // The DNS pass is not under test here.
    vi.spyOn(observer, "reconcileStack").mockResolvedValue(undefined);
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.close();
  }, 60_000);

  const path = (stackId = "", tail = "", c: HarnessCustomer = h.a) => `/v1/organizations/${c.orgId}/app-stacks${stackId ? `/${stackId}` : ""}${tail}`;
  const idem = () => ({ "Idempotency-Key": randomUUID() });
  const act = (stackId: string, verb: string) => h.call(h.a.token, "POST", path(stackId, `/${verb}`), {}, idem());
  const read = (stackId: string, token = h.a.token) => h.call(token, "GET", path(stackId, "/links"));
  const connect = (applicationId: string, databaseStackId: unknown, token = h.a.token) =>
    h.call(token, "POST", path(applicationId, "/links"), { databaseStackId });
  const disconnect = (stackId: string, linkId: string, token = h.a.token) => h.call(token, "DELETE", path(stackId, `/links/${linkId}`), {});
  const del = (stackId: string, name: string) => h.call(h.a.token, "DELETE", path(stackId), { confirmName: name, destroyData: true }, idem());
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = (stackId: string) => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
  const linkRows = () => h.dbClient.db.select().from(appStackLinks);
  const linkAudit = () =>
    h.dbClient.db
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.action, ["app.stack.link.create", "app.stack.link.remove"]));
  const linked = (databaseId: string) => sim.appStacks.getAppStackLinkedApplications(databaseId);
  const callsOf = (stackId: string) => sim.appStacks.appStackCalls.filter((c) => c.stackId === stackId).map((c) => c.method);
  const networkChanges = (applicationId: string) =>
    sim.appStacks.appStackMutations.filter((m) => m.name === appStackInternalNetworkName(applicationId)).map((m) => m.kind);

  async function drain(stackId: string): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
      await worker.processPendingOnce();
      const open = (await opsOf(stackId)).filter((o) => ["queued", "running", "processing"].includes(o.status));
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  async function create(versionId: string, c: HarnessCustomer = h.a): Promise<{ stackId: string; name: string }> {
    const name = `lnk-${randomUUID().slice(0, 8)}`;
    const res = await h.call(c.token, "POST", path("", "", c), { templateVersionId: versionId, name, deploy: false }, idem());
    expect(res.status, res.raw).toBe(201);
    return { stackId: res.body.data.stackId as string, name };
  }
  async function deploy(stackId: string): Promise<void> {
    const res = await act(stackId, "deploy");
    expect(res.status, res.raw).toBe(202);
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("running");
  }
  /** A MariaDB database with its two reserved values set; `run: false` leaves it never installed. */
  async function mariadb(run: boolean): Promise<{ stackId: string; name: string }> {
    const database = await create(MARIADB.versionId);
    for (const parameterKey of ["database_password", "admin_password"]) {
      const res = await h.call(h.a.token, "POST", path(database.stackId, "/secrets"), { parameterKey, value: PASSWORD });
      expect(res.status, res.raw).toBe(200);
    }
    if (run) await deploy(database.stackId);
    return database;
  }
  async function valkey(run: boolean): Promise<{ stackId: string; name: string }> {
    const database = await create(VALKEY.versionId);
    if (run) await deploy(database.stackId);
    return database;
  }
  async function application(run: boolean): Promise<{ stackId: string; name: string }> {
    const app = await create(WEB.versionId);
    if (run) await deploy(app.stackId);
    return app;
  }
  /** A running database and a running application, connected. */
  async function pair(): Promise<{ database: { stackId: string; name: string }; app: { stackId: string; name: string }; linkId: string }> {
    const database = await valkey(true);
    const app = await application(true);
    const res = await connect(app.stackId, database.stackId);
    expect(res.status, res.raw).toBe(201);
    expect(res.body.data.links).toEqual([expect.objectContaining({ databaseStackId: database.stackId, state: "active" })]);
    return { database, app, linkId: res.body.data.links[0].id as string };
  }

  it("a database shows where it is reached, an application the databases it can be connected to", async () => {
    const database = await mariadb(false);
    const cache = await valkey(false);
    const app = await application(false);

    const own = await read(database.stackId);
    expect(own.status, own.raw).toBe(200);
    expect(own.body.data).toEqual({
      stackId: database.stackId,
      role: "database",
      connection: { host: appStackLinkAlias(database.stackId), port: 3306 },
      links: [],
      candidates: [],
      limit: 8,
    });
    expect((await read(cache.stackId)).body.data.connection).toEqual({ host: appStackLinkAlias(cache.stackId), port: 6379 });

    const seen = await read(app.stackId);
    expect(seen.status, seen.raw).toBe(200);
    expect(AppStackLinksDtoSchema.safeParse(seen.body.data).success).toBe(true);
    expect(seen.body.data).toMatchObject({ stackId: app.stackId, role: "application", connection: null, links: [], limit: 4 });
    const candidates = seen.body.data.candidates as Json[];
    expect(candidates).toContainEqual({ stackId: database.stackId, name: database.name, kind: "Database MariaDB" });
    expect(candidates).toContainEqual({ stackId: cache.stackId, name: cache.name, kind: "Archivio Valkey" });
    // Only databases are offered, by name.
    expect(candidates.map((c) => c.stackId)).not.toContain(app.stackId);
    expect(candidates.map((c) => c.name)).toEqual(candidates.map((c) => c.name as string).sort((x, y) => x.localeCompare(y)));
    // The address is a name the panel derives; no Docker name or id is part of it.
    expect(own.raw).not.toMatch(/hp_app|hp_appnet|sha256/);
  });

  it("a link to a database not installed yet waits, and is applied before the database starts", async () => {
    const database = await mariadb(false);
    const app = await application(true);
    const auditBefore = (await linkAudit()).length;

    const made = await connect(app.stackId, database.stackId);
    expect(made.status, made.raw).toBe(201);
    expect(made.body.data).toMatchObject({ stackId: app.stackId, role: "application", connection: null });
    const [link] = made.body.data.links as Json[];
    expect(Object.keys(link!).sort()).toEqual(LINK_KEYS);
    expect(link).toMatchObject({
      state: "pending",
      databaseStackId: database.stackId,
      databaseName: database.name,
      databaseKind: "Database MariaDB",
      applicationStackId: app.stackId,
      applicationName: app.name,
      connection: { host: appStackLinkAlias(database.stackId), port: 3306 },
    });
    expect((made.body.data.candidates as Json[]).map((c) => c.stackId)).not.toContain(database.stackId);
    // Nothing of the database is on the server: the server is not asked.
    expect(callsOf(database.stackId)).not.toContain("syncAppStackLinks");

    const audit = (await linkAudit()).slice(auditBefore);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "app.stack.link.create",
      targetType: "app_stack_link",
      targetId: link!.id,
      actorId: h.a.userId,
      organizationId: h.a.orgId,
    });
    expect(audit[0]!.details).toMatchObject({ applicationStackId: app.stackId, databaseStackId: database.stackId });

    await deploy(database.stackId);
    const calls = callsOf(database.stackId);
    expect(calls).toContain("syncAppStackLinks");
    expect(calls.indexOf("syncAppStackLinks")).toBeLessThan(calls.indexOf("startAppStackComponent"));
    expect(linked(database.stackId)).toEqual([app.stackId]);
    expect(networkChanges(app.stackId)).toContain("network_connect");

    const after = await read(app.stackId);
    expect(after.body.data.links).toEqual([expect.objectContaining({ id: link!.id, state: "active" })]);
    const fromDatabase = await read(database.stackId);
    expect(fromDatabase.body.data.links).toEqual([
      expect.objectContaining({ id: link!.id, state: "active", applicationStackId: app.stackId, applicationName: app.name }),
    ]);

    // No answer, audit row or operation carries a value of the database.
    for (const raw of [made.raw, after.raw, fromDatabase.raw, JSON.stringify(await linkAudit()), JSON.stringify(await opsOf(database.stackId))]) {
      expect(raw).not.toContain(PASSWORD);
    }
  }, 60_000);

  it("a link of an application not installed yet waits for its private network", async () => {
    const database = await valkey(true);
    const app = await application(false);
    const made = await connect(app.stackId, database.stackId);
    expect(made.status, made.raw).toBe(201);
    expect(made.body.data.links).toEqual([expect.objectContaining({ state: "pending" })]);
    expect(linked(database.stackId)).toEqual([]);

    await deploy(app.stackId);
    expect(linked(database.stackId)).toEqual([app.stackId]);
    expect((await read(app.stackId)).body.data.links).toEqual([expect.objectContaining({ state: "active" })]);
    // The database was attached before the application started, and was not touched otherwise.
    const calls = callsOf(app.stackId);
    expect(sim.appStacks.appStackCalls.map((c) => `${c.method}:${c.stackId}`).lastIndexOf(`syncAppStackLinks:${database.stackId}`)).toBeGreaterThan(-1);
    expect(calls).toContain("startAppStackComponent");
    expect(callsOf(database.stackId).filter((m) => m === "startAppStackComponent")).toHaveLength(1);
  }, 60_000);

  it("connecting and disconnecting changes only the attachment: nothing is created, started or restarted", async () => {
    const { database, app, linkId } = await pair();
    expect(linked(database.stackId)).toEqual([app.stackId]);
    const callsBefore = sim.appStacks.appStackCalls.length;
    const auditBefore = (await linkAudit()).length;

    const gone = await disconnect(app.stackId, linkId);
    expect(gone.status, gone.raw).toBe(200);
    expect(gone.body.data).toMatchObject({ stackId: app.stackId, role: "application", links: [] });
    expect((gone.body.data.candidates as Json[]).map((c) => c.stackId)).toContain(database.stackId);
    expect(linked(database.stackId)).toEqual([]);
    expect(networkChanges(app.stackId).at(-1)).toBe("network_disconnect");
    const audit = (await linkAudit()).slice(auditBefore);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "app.stack.link.remove", targetType: "app_stack_link", targetId: linkId, actorId: h.a.userId });
    expect(audit[0]!.details).toMatchObject({ applicationStackId: app.stackId, databaseStackId: database.stackId });
    expectRefusal(await disconnect(app.stackId, linkId), 404, "NOT_FOUND");

    // Connected again, and disconnected from the database's side: the answer is the database's own list.
    const again = await connect(app.stackId, database.stackId);
    expect(again.status, again.raw).toBe(201);
    const second = again.body.data.links[0].id as string;
    expect(linked(database.stackId)).toEqual([app.stackId]);
    const outsider = await application(false);
    expectRefusal(await disconnect(outsider.stackId, second), 404, "NOT_FOUND");
    expect(linked(database.stackId)).toEqual([app.stackId]);
    const fromDatabase = await disconnect(database.stackId, second);
    expect(fromDatabase.status, fromDatabase.raw).toBe(200);
    expect(fromDatabase.body.data).toMatchObject({ stackId: database.stackId, role: "database", links: [], candidates: [] });
    expect(linked(database.stackId)).toEqual([]);

    const calls = sim.appStacks.appStackCalls.slice(callsBefore);
    expect(calls.length).toBeGreaterThan(0);
    expect([...new Set(calls.map((c) => c.method))]).toEqual(["syncAppStackLinks"]);
    expect([...new Set(calls.map((c) => c.stackId))]).toEqual([database.stackId]);
    expect((await opsOf(database.stackId)).map((o) => o.kind)).toEqual(["stack.deploy"]);
    expect((await opsOf(app.stackId)).map((o) => o.kind)).toEqual(["stack.deploy"]);
  }, 60_000);

  it("refuses what is not a link between an application and a database of the same customer, and writes nothing", async () => {
    const database = await valkey(false);
    const other = await valkey(false);
    const app = await application(false);
    const second = await application(false);
    const foreign = await create(VALKEY.versionId, h.b);
    const rows = (await linkRows()).length;
    const audit = (await linkAudit()).length;

    expectRefusal(await connect(database.stackId, other.stackId), 400, "VALIDATION_ERROR", { field: "stackId", reason: "database_as_application" });
    expectRefusal(await connect(app.stackId, second.stackId), 400, "VALIDATION_ERROR", { field: "databaseStackId", reason: "not_a_database" });
    expectRefusal(await connect(app.stackId, app.stackId), 400, "VALIDATION_ERROR", { reason: "not_a_database" });
    for (const body of [{}, { databaseStackId: 5 }, { databaseStackId: "Not An Id" }, { databaseStackId: database.stackId, port: 6379 }]) {
      expectRefusal(await h.call(h.a.token, "POST", path(app.stackId, "/links"), body), 400, "VALIDATION_ERROR");
    }
    expectRefusal(await h.call(h.a.token, "DELETE", path(app.stackId, "/links/x"), { force: true }), 400, "VALIDATION_ERROR");

    // A database that does not exist, or of another customer, is the same answer.
    expectRefusal(await connect(app.stackId, `stk_${"0".repeat(32)}`), 404, "NOT_FOUND");
    const refused = await connect(app.stackId, foreign.stackId);
    expectRefusal(refused, 404, "NOT_FOUND");
    expect(refused.raw).not.toContain(foreign.stackId);
    // The other customer reaches nothing of this one, under either organisation.
    for (const c of [h.a, h.b]) {
      expectRefusal(await h.call(h.b.token, "GET", path(app.stackId, "/links", c)), 404, "NOT_FOUND");
      expectRefusal(await h.call(h.b.token, "POST", path(app.stackId, "/links", c), { databaseStackId: foreign.stackId }), 404, "NOT_FOUND");
      expectRefusal(await h.call(h.b.token, "DELETE", path(app.stackId, "/links/x", c), {}), 404, "NOT_FOUND");
    }
    expect((await h.call(h.b.token, "GET", path(foreign.stackId, "/links", h.b))).body.data).toMatchObject({ role: "database", links: [] });
    expect((await linkRows()).length).toBe(rows);
    expect((await linkAudit()).length).toBe(audit);

    // The same pair once.
    expect((await connect(app.stackId, database.stackId)).status).toBe(201);
    expectRefusal(await connect(app.stackId, database.stackId), 409, "ALREADY_EXISTS", { field: "databaseStackId", reason: "link_exists" });
    expect((await linkRows()).length).toBe(rows + 1);
    expect((await linkAudit()).length).toBe(audit + 1);

    // Not while one of the two is changing.
    for (const busy of [second.stackId, other.stackId]) {
      await h.dbClient.db.update(appStacks).set({ status: "deploying" }).where(eq(appStacks.id, busy));
      const res = await connect(second.stackId, other.stackId);
      expectRefusal(res, 409, "RESOURCE_LOCKED", { field: "status", reason: "deploying" });
      await h.dbClient.db.update(appStacks).set({ status: "draft" }).where(eq(appStacks.id, busy));
    }
    expect((await linkRows()).length).toBe(rows + 1);
  }, 60_000);

  it("reads with app.read and writes with app.update; without the key 403 and one denied row", async () => {
    const database = await valkey(false);
    const app = await application(false);
    const made = await connect(app.stackId, database.stackId);
    const linkId = made.body.data.links[0].id as string;
    const rows = await linkRows();

    await h.dbClient.db.insert(roles).values({ id: "role_app_reader", name: "app_reader" as never, description: "Read only", isPreset: false });
    await h.dbClient.db.insert(rolePermissions).values({ roleId: "role_app_reader", permissionKey: "app.read" });
    const reader = await h.addMember(h.a.orgId, "role_app_reader" as "role_customer_collaborator");
    expect((await read(app.stackId, reader.token)).status).toBe(200);
    expectRefusal(await connect(app.stackId, database.stackId, reader.token), 403, "PERMISSION_DENIED");
    expectRefusal(await disconnect(app.stackId, linkId, reader.token), 403, "PERMISSION_DENIED");
    // The permission is asked before the body is read.
    expectRefusal(await h.call(reader.token, "POST", path(app.stackId, "/links"), "{not json"), 403, "PERMISSION_DENIED");

    const collaborator = await h.addMember(h.a.orgId, "role_customer_collaborator");
    expectRefusal(await read(app.stackId, collaborator.token), 403, "PERMISSION_DENIED");
    expectRefusal(await connect(app.stackId, database.stackId, collaborator.token), 403, "PERMISSION_DENIED");
    expectRefusal(await disconnect(database.stackId, linkId, collaborator.token), 403, "PERMISSION_DENIED");
    const denied = await h.dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.actorId, collaborator.userId), eq(auditEvents.targetType, "app_stack")));
    expect(denied.map((row) => [row.action, row.targetId, (row.details as Json).outcome])).toEqual([
      ["app.read", app.stackId, "denied"],
      ["app.update", app.stackId, "denied"],
      ["app.update", database.stackId, "denied"],
    ]);
    expect(await linkRows()).toEqual(rows);
  });

  it("an application takes four databases and a database eight applications", async () => {
    const app = await application(false);
    const databases = [];
    for (let i = 0; i < 5; i += 1) databases.push(await valkey(false));
    for (const database of databases.slice(0, 4)) expect((await connect(app.stackId, database.stackId)).status).toBe(201);
    expectRefusal(await connect(app.stackId, databases[4]!.stackId), 400, "VALIDATION_ERROR", { field: "links", reason: "STACK_QUOTA_EXCEEDED" });
    const full = await read(app.stackId);
    expect(full.body.data.links).toHaveLength(4);
    expect(full.body.data.limit).toBe(4);

    const database = databases[4]!;
    const apps = [];
    for (let i = 0; i < 9; i += 1) apps.push(await application(false));
    for (const one of apps.slice(0, 8)) expect((await connect(one.stackId, database.stackId)).status).toBe(201);
    expectRefusal(await connect(apps[8]!.stackId, database.stackId), 400, "VALIDATION_ERROR", { field: "links", reason: "STACK_QUOTA_EXCEEDED" });
    const used = await read(database.stackId);
    expect(used.body.data.links).toHaveLength(8);
    expect(used.body.data.limit).toBe(8);
    // Oldest first, each with the application's name.
    expect((used.body.data.links as Json[]).map((l) => l.applicationName)).toEqual(apps.slice(0, 8).map((a) => a.name));
  }, 90_000);

  it("a database with more than one port is not something to connect to", async () => {
    const { versionId } = await h.publish(TWO_PORTS(VALKEY.source, 6379, 16379));
    const database = await create(versionId);
    const app = await application(false);
    expect((await read(database.stackId)).body.data).toMatchObject({ role: "database", connection: null, links: [] });
    expect(((await read(app.stackId)).body.data.candidates as Json[]).map((c) => c.stackId)).not.toContain(database.stackId);
    expectRefusal(await connect(app.stackId, database.stackId), 400, "VALIDATION_ERROR", { field: "databaseStackId", reason: "database_not_linkable" });
  });

  it("a server that does not answer leaves the link waiting, and the observer applies it later", async () => {
    const database = await valkey(true);
    const app = await application(true);

    sim.appStacks.failNextAppStackStep("links", "engine_unavailable");
    const made = await connect(app.stackId, database.stackId);
    expect(made.status, made.raw).toBe(201);
    const linkId = made.body.data.links[0].id as string;
    expect(made.body.data.links).toEqual([expect.objectContaining({ id: linkId, state: "pending" })]);
    expect(linked(database.stackId)).toEqual([]);
    await observer.reconcileOnce();
    expect((await read(app.stackId)).body.data.links).toEqual([expect.objectContaining({ id: linkId, state: "active" })]);
    expect(linked(database.stackId)).toEqual([app.stackId]);

    // A disconnection whose answer was lost stays asked for, visibly, until the server confirms it.
    sim.appStacks.failNextAppStackStep("links", "ambiguous_before");
    const asked = await disconnect(app.stackId, linkId);
    expect(asked.status, asked.raw).toBe(200);
    expect(asked.body.data.links).toEqual([expect.objectContaining({ id: linkId, state: "removing" })]);
    expect(linked(database.stackId)).toEqual([app.stackId]);
    // The database is still in use for a delete, and the pair is not offered again.
    expectRefusal(await del(database.stackId, database.name), 400, "VALIDATION_ERROR", { field: "links", reason: "database_in_use" });
    expect((asked.body.data.candidates as Json[]).map((c) => c.stackId)).not.toContain(database.stackId);
    await observer.reconcileOnce();
    expect((await read(app.stackId)).body.data.links).toEqual([]);
    expect(linked(database.stackId)).toEqual([]);

    // Connecting again while a disconnection waits takes the same link back.
    const back = await connect(app.stackId, database.stackId);
    const backId = back.body.data.links[0].id as string;
    sim.appStacks.failNextAppStackStep("links", "engine_unavailable");
    expect((await disconnect(app.stackId, backId)).body.data.links).toEqual([expect.objectContaining({ state: "removing" })]);
    const taken = await connect(app.stackId, database.stackId);
    expect(taken.status, taken.raw).toBe(201);
    expect(taken.body.data.links).toEqual([expect.objectContaining({ id: backId, state: "active" })]);
    expect(linked(database.stackId)).toEqual([app.stackId]);
  }, 60_000);

  it("a slow server holds the observer's links for 45 seconds a pass, and the next pass begins with the databases it did not reach", async () => {
    const databases: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const database = await valkey(true);
      const app = await application(true);
      sim.appStacks.failNextAppStackStep("links", "engine_unavailable");
      expect((await connect(app.stackId, database.stackId)).status).toBe(201);
      databases.push(database.stackId);
    }
    const [first, second, third] = databases as [string, string, string];

    // For these three the server takes 30 seconds, then gives no answer; the clock moves only with it.
    let clock = Date.now();
    let asked: string[] = [];
    const answer = sim.syncAppStackLinks.bind(sim);
    const slow = vi.spyOn(sim, "syncAppStackLinks").mockImplementation((req) => {
      if (!databases.includes(req.stackId)) return answer(req);
      asked.push(req.stackId);
      clock += 30_000;
      return Promise.reject(new Error("no answer"));
    });
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const passes: string[][] = [];
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        asked = [];
        await observer.reconcileOnce();
        passes.push(asked);
      }
    } finally {
      time.mockRestore();
      slow.mockRestore();
    }
    // A call starts only within the budget, and a database the pass asked goes behind the one it did not reach.
    expect(passes[0]).toEqual([first, second]);
    expect(passes[1]).toEqual([third, expect.any(String)]);
    expect([first, second]).toContain(passes[1]![1]);

    await observer.reconcileOnce();
    for (const databaseId of databases) expect((await read(databaseId)).body.data.links).toEqual([expect.objectContaining({ state: "active" })]);
  }, 90_000);

  it("a link that cannot be applied never fails the start of a database or of an application", async () => {
    const database = await mariadb(false);
    const app = await application(true);
    expect((await connect(app.stackId, database.stackId)).status).toBe(201);

    sim.appStacks.failNextAppStackStep("links", "engine_unavailable");
    await deploy(database.stackId);
    expect((await opsOf(database.stackId)).map((o) => [o.kind, o.status, o.errorCode])).toEqual([["stack.deploy", "succeeded", null]]);
    expect((await read(database.stackId)).body.data.links).toEqual([expect.objectContaining({ state: "pending" })]);
    expect(linked(database.stackId)).toEqual([]);

    // The same for the application's side: its restart asks again, and a failure there changes nothing of it.
    sim.appStacks.failNextAppStackStep("links", "ambiguous_after");
    const restarted = await act(app.stackId, "restart");
    expect(restarted.status, restarted.raw).toBe(202);
    await drain(app.stackId);
    expect((await stackRow(app.stackId)).status).toBe("running");
    expect((await opsOf(app.stackId)).map((o) => o.status)).toEqual(["succeeded", "succeeded"]);

    await observer.reconcileOnce();
    expect((await read(database.stackId)).body.data.links).toEqual([expect.objectContaining({ state: "active" })]);
    expect(linked(database.stackId)).toEqual([app.stackId]);
  }, 60_000);

  it("a database in use is not deleted; deleting the application takes its links with it", async () => {
    const { database, app } = await pair();
    const staying = await application(true);
    expect((await connect(staying.stackId, database.stackId)).status).toBe(201);
    expect(linked(database.stackId)).toEqual([app.stackId, staying.stackId].sort());

    const refused = await del(database.stackId, database.name);
    expectRefusal(refused, 400, "VALIDATION_ERROR", { field: "links", reason: "database_in_use" });
    expect((await stackRow(database.stackId)).status).toBe("running");
    expect((await opsOf(database.stackId)).map((o) => o.kind)).toEqual(["stack.deploy"]);

    const deleted = await del(app.stackId, app.name);
    expect(deleted.status, deleted.raw).toBe(202);
    // The row goes with the request; the server detaches the database before it removes the private network.
    expect((await read(database.stackId)).body.data.links).toEqual([expect.objectContaining({ applicationStackId: staying.stackId })]);
    await drain(app.stackId);
    expect(linked(database.stackId)).toEqual([staying.stackId]);
    const changes = networkChanges(app.stackId);
    expect(changes.lastIndexOf("network_disconnect")).toBeLessThan(changes.lastIndexOf("network_remove"));
    expect(changes).toContain("network_disconnect");
    expect((await stackRow(database.stackId)).status).toBe("running");

    // Still in use by the other application; free once that one is disconnected.
    expectRefusal(await del(database.stackId, database.name), 400, "VALIDATION_ERROR", { reason: "database_in_use" });
    const last = (await read(staying.stackId)).body.data.links[0].id as string;
    expect((await disconnect(staying.stackId, last)).body.data.links).toEqual([]);
    const freed = await del(database.stackId, database.name);
    expect(freed.status, freed.raw).toBe(202);
    await drain(database.stackId);
    expect(sim.appStacks.getAppStackSnapshot(database.stackId)).toBeNull();
    expect(((await read(staying.stackId)).body.data.candidates as Json[]).map((c) => c.stackId)).not.toContain(database.stackId);
  }, 90_000);

  it("a database in use is not moved to a version with more than one port", async () => {
    const { templateId, versionId } = await h.publish(VALKEY.source);
    const database = await create(versionId);
    await deploy(database.stackId);
    const app = await application(false);
    const made = await connect(app.stackId, database.stackId);
    expect(made.status, made.raw).toBe(201);
    const added = await h.call(h.adminToken, "POST", `/v1/admin/app-templates/${templateId}/versions`, {
      source: TWO_PORTS(VALKEY.source, 6379, 16379),
      makeDefault: true,
    });
    expect(added.status, added.raw).toBe(201);
    const next = added.body.data.versionId as string;
    const upgrade = async () => {
      const plan = await h.call(h.a.token, "POST", path(database.stackId, "/plan"), { templateVersionId: next });
      expect(plan.status, plan.raw).toBe(200);
      return h.call(h.a.token, "POST", path(database.stackId, "/upgrade"), { templateVersionId: next, planHash: plan.body.data.planHash }, idem());
    };
    const before = await stackRow(database.stackId);
    expectRefusal(await upgrade(), 400, "VALIDATION_ERROR", { field: "links", reason: "database_in_use" });
    expect(await stackRow(database.stackId)).toEqual(before);

    expect((await disconnect(app.stackId, made.body.data.links[0].id as string)).status).toBe(200);
    const taken = await upgrade();
    expect(taken.status, taken.raw).toBe(202);
  }, 60_000);
});

// ADR-0038 meets ADR-0039: a database is an application with a data volume, so a backup stops it, copies it and starts
// it again. Its links are attachments of its container and outlive the stop; the start after the backup applies them
// before the database runs again, and a link call made while it is stopped never starts it.
describe("a linked database is backed up", () => {
  const LOCAL = `bkt_${"9".repeat(32)}`;
  let h: AppStackHarness;

  beforeAll(async () => {
    // The backend where backups exist, with one local destination for the sites' policy, which applications use.
    h = await startAppStackHarness({ runtimeBackend: "linux-systemd", allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await ensureBuiltInAppTemplates(h.dbClient.db, builtInAppTemplateItems());
    for (const template of [WEB, VALKEY]) {
      const enabled = await h.call(h.adminToken, "PATCH", `/v1/admin/app-templates/${template.templateId}`, { enabled: true });
      expect(enabled.status, enabled.raw).toBe(200);
    }
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    await h.dbClient.db.insert(backupTargets).values({ id: LOCAL, kind: "local", name: "Local" });
    await setPolicyTargets(h.dbClient.db, (await getPolicy(h.dbClient.db, "default_site")).id, [LOCAL]);
    // The DNS pass is not under test here.
    vi.spyOn(h.app.nestApp.get(AppStackObserverService), "reconcileStack").mockResolvedValue(undefined);
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.close();
  }, 60_000);

  it("is stopped, copied and started again, and its links are active again; a link call while it is stopped starts nothing", async () => {
    const sim = h.sim;
    const worker = h.app.nestApp.get(OutboxWorkerService);
    const applier = h.app.nestApp.get(AppStackLinksApplier);
    const path = (stackId = "", tail = "") => `/v1/organizations/${h.a.orgId}/app-stacks${stackId ? `/${stackId}` : ""}${tail}`;
    const idem = () => ({ "Idempotency-Key": randomUUID() });
    const opsOf = (stackId: string) => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
    const links = async (stackId: string) => ((await h.call(h.a.token, "GET", path(stackId, "/links"))).body.data.links as Json[]).map((l) => l.state);
    const states = (stackId: string) => Object.values(sim.appStacks.getAppStackSnapshot(stackId)?.containers ?? {}).map((c) => c.state);
    const calls = (stackId: string, from: number) =>
      sim.appStacks.appStackCalls.slice(from).filter((c) => c.stackId === stackId).map((c) => c.method);
    /** Runs the worker until nothing of this application is open: a backup queues the start that follows it. */
    async function settle(stackId: string): Promise<string> {
      for (let round = 0; round < 12; round += 1) {
        await worker.processPendingOnce();
        if ((await opsOf(stackId)).every((op) => isTerminalOperationStatus(op.status))) break;
      }
      expect((await opsOf(stackId)).filter((op) => !isTerminalOperationStatus(op.status))).toEqual([]);
      return (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!.status;
    }
    async function installed(versionId: string): Promise<string> {
      const name = `bak-${randomUUID().slice(0, 8)}`;
      const res = await h.call(h.a.token, "POST", path(), { templateVersionId: versionId, name, deploy: true }, idem());
      expect(res.status, res.raw).toBe(202);
      const stackId = res.body.data.stackId as string;
      expect(await settle(stackId)).toBe("running");
      return stackId;
    }

    const database = await installed(VALKEY.versionId);
    const app = await installed(WEB.versionId);
    const later = await installed(WEB.versionId);
    const made = await h.call(h.a.token, "POST", path(app, "/links"), { databaseStackId: database });
    expect(made.status, made.raw).toBe(201);
    expect(await links(app)).toEqual(["active"]);
    const from = sim.appStacks.appStackCalls.length;
    const changesFrom = sim.appStacks.appStackMutations.length;

    // Stopped for the copy, before its job starts: a second application is connected (the answer does not come, so
    // its link waits) and the observer's pass applies it. Both attach the stopped container and start nothing, and
    // the job's own check then finds the database at rest.
    const during: { status?: string; connected?: string[]; retried?: string[]; states?: string[] } = {};
    let callsDuring = 0;
    const real = sim.backups;
    sim.backups = (async (req: Parameters<typeof real>[0]) => {
      if (req.action === "stackStart" && req.stackId === database) {
        during.status = (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, database)))[0]!.status;
        sim.appStacks.failNextAppStackStep("links", "engine_unavailable");
        const connected = await h.call(h.a.token, "POST", path(later, "/links"), { databaseStackId: database });
        expect(connected.status, connected.raw).toBe(201);
        during.connected = await links(later);
        await applier.retry();
        during.retried = await links(later);
        during.states = states(database);
        callsDuring = calls(database, from).length;
      }
      return real.call(sim, req);
    }) as typeof real;
    try {
      const res = await h.call(h.a.token, "POST", path(database, "/backups"), {}, idem());
      expect(res.status, res.raw).toBe(202);
      expect(await settle(database)).toBe("running");
    } finally {
      sim.backups = real;
    }

    expect(during).toEqual({ status: "stopped", connected: ["pending"], retried: ["active"], states: ["exited"] });
    const listed = await h.call(h.a.token, "GET", path(database, "/backups"));
    expect((listed.body.data.backups as Json[]).map((b) => b.status)).toEqual(["succeeded"]);
    expect(sim.backupState.appStackJobs().filter((job) => job.stackId === database)).toHaveLength(1);
    // The backup and the start it queued, each once and both done.
    expect((await opsOf(database)).map((o) => `${o.kind}:${o.status}`).sort()).toEqual([
      "stack.backup:succeeded",
      "stack.deploy:succeeded",
      "stack.start:succeeded",
    ]);
    // The backup stopped the database before the link calls; the start that follows it asks for the database's links
    // again before its container runs.
    expect(calls(database, from).slice(0, callsDuring)).toEqual(["unpublishAppStackRoutes", "stopAppStack", "syncAppStackLinks", "syncAppStackLinks"]);
    const resumed = calls(database, from).slice(callsDuring);
    expect(resumed).toContain("syncAppStackLinks");
    expect(resumed.indexOf("syncAppStackLinks")).toBeLessThan(resumed.indexOf("startAppStackComponent"));
    expect(states(database)).toEqual(["running"]);
    expect(await links(app)).toEqual(["active"]);
    expect(await links(later)).toEqual(["active"]);
    expect(await links(database)).toEqual(["active", "active"]);
    expect(sim.appStacks.getAppStackLinkedApplications(database)).toEqual([app, later].sort());
    // Neither application lost the database on the way: nothing was detached from its private network.
    const changes = sim.appStacks.appStackMutations.slice(changesFrom);
    for (const stackId of [app, later]) {
      expect(changes.filter((m) => m.name === appStackInternalNetworkName(stackId)).map((m) => m.kind)).not.toContain("network_disconnect");
    }
    // The applications themselves were not touched by the backup of their database.
    expect(calls(app, from).filter((m) => m !== "getAppStackStatus")).toEqual([]);
  }, 90_000);
});
