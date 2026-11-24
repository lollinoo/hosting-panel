import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  APP_BUILT_IN_TEMPLATES,
  APP_IMAGE_ALLOWLIST,
  AdminAppStackDtoSchema,
  AppTerminalSessionDtoSchema,
  TERMINAL_SESSION_MAX_MS,
} from "@hosting-panel/contracts";
import {
  adminTerminalSessions,
  appStacks,
  auditEvents,
  builtInAppTemplateItems,
  ensureBuiltInAppTemplates,
  asc,
  eq,
  operations,
  resourceQuotas,
  sql,
  users,
} from "@hosting-panel/database";
import { ExecutorCodedError, InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin } from "../src/cli/accounts.js";
import { AdminTerminalService } from "../src/terminal/admin-terminal.service.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness, type HarnessCustomer } from "./fixtures/app-stack-harness.js";

// ADR-0041: the server administrator's page of a customer's application, the logs of a component and a terminal in
// its container. The terminal's write, read, close and pass are the sites' own (admin-terminal.integration.test.ts);
// here is what differs: who may open, where, after which checks, and what is written about it.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Res = { status: number; body: Json; raw: string };

const KEY = Buffer.alloc(32, 7); // the harness's master key
const [HTTP_CACHE, WORKER_STORAGE] = APP_BUILT_IN_TEMPLATES as readonly [(typeof APP_BUILT_IN_TEMPLATES)[number], (typeof APP_BUILT_IN_TEMPLATES)[number]];
const ENGINE_TEXT = "SENTINEL_ENGINE_TEXT no such container hp_x /var/lib/docker";
const OWN_AUDITS = ["admin.terminal.open", "admin.terminal.close", "admin.terminal.denied", "admin.app_stack.logs.read"];
const DOWN = "The application is not running. A terminal opens only in a running component.";

const page = (stackId: string) => `/v1/admin/app-stacks/${stackId}`;
const logsPath = (stackId: string, key: string, query = "") => `${page(stackId)}/components/${key}/logs${query}`;
const openPath = (stackId: string, key: string) => `${page(stackId)}/components/${key}/terminal`;

describe("the administrator's routes on a customer's application (ADR-0041)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminAtStart: typeof users.$inferSelect;
  let cacheId = ""; // HTTP cache, running: components web and cache
  let storageId = ""; // worker-storage, running: components storage and worker
  let blogId = ""; // a second HTTP cache, running
  let draftId = ""; // installed, never deployed

  const stacksPath = (tail = "") => `/v1/organizations/${h.a.orgId}/app-stacks${tail}`;
  const idem = () => ({ "Idempotency-Key": randomUUID() });

  /** POST as the site terminal test sends it: no content type without a body. */
  async function post(path: string, body?: unknown, as: string | null = h.adminToken): Promise<Res> {
    const res = await fetch(`${h.app.baseUrl!}${path}`, {
      method: "POST",
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        "Idempotency-Key": randomUUID(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  async function drain(stackId: string): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
      await h.app.outboxWorker.processPendingOnce();
      const open = (await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId))).filter((o) =>
        ["queued", "running", "processing"].includes(o.status),
      );
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  async function install(versionId: string, name: string, extra: Json = {}): Promise<string> {
    const res = await h.call(h.a.token, "POST", stacksPath(), { templateVersionId: versionId, name, deploy: true, ...extra }, idem());
    if (res.status !== 202 && res.status !== 201) throw new Error(`install of ${name}: ${res.raw}`);
    const stackId = res.body.data.stackId as string;
    await drain(stackId);
    return stackId;
  }

  /** The customer's own stop or start, run to its end. */
  async function act(stackId: string, action: "stop" | "start"): Promise<void> {
    const res = await h.call(h.a.token, "POST", stacksPath(`/${stackId}/${action}`), {}, idem());
    expect(res.status, res.raw).toBe(202);
    await drain(stackId);
  }

  const statusOf = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!.status;
  // Audit rows cannot be deleted, so a test counts only the ones written since it began, oldest first.
  let seenAudits = new Set<string>();
  const audits = async (action: string) =>
    (await h.dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action)).orderBy(asc(auditEvents.timestamp)))
      .filter((a) => !seenAudits.has(a.id));
  const deniedReasons = async () => (await audits("admin.terminal.denied")).map((a) => (a.details as Json).reason as string);
  const rows = () => h.dbClient.db.select().from(adminTerminalSessions);
  const row = async (id: string) => (await h.dbClient.db.select().from(adminTerminalSessions).where(eq(adminTerminalSessions.id, id)))[0]!;
  const adminRow = async () => (await h.dbClient.db.select().from(users).where(eq(users.id, h.admin.userId)))[0]!;
  const sweep = (now: Date) => h.app.nestApp.get(AdminTerminalService).sweepOnce(now);
  const step = () => Math.floor(Date.now() / 30_000);

  async function deniedRows(userId: string): Promise<number> {
    const all = await h.dbClient.db.select().from(auditEvents).where(eq(auditEvents.actorId, userId));
    return all.filter((a) => (a.details as Json | null)?.outcome === "denied").length;
  }

  /** A code of the current step, made usable again by forgetting the last used step. */
  async function freshCode(): Promise<string> {
    await h.dbClient.db.update(users).set({ totpLastStep: null }).where(eq(users.id, h.admin.userId));
    return totpCodeAt(h.admin.totpSecret, step());
  }

  /** A six-digit code that matches no step of the accepted window. */
  function wrongCode(): string {
    const valid = new Set([-1, 0, 1, 2].map((d) => totpCodeAt(h.admin.totpSecret, step() + d)));
    for (let n = 0; ; n++) {
      const code = String(n).padStart(6, "0");
      if (!valid.has(code)) return code;
    }
  }

  const open = async (stackId: string, key: string) => post(openPath(stackId, key), { code: await freshCode() });
  const write = (sid: string, input: string, as?: string) => post(`/v1/admin/terminal/${sid}/write`, { input }, as);
  const read = (sid: string, cursor: number, as?: string) => post(`/v1/admin/terminal/${sid}/read`, { cursor }, as);
  const close = (sid: string, as?: string) => post(`/v1/admin/terminal/${sid}/close`, undefined, as);

  async function opened(stackId: string, key: string): Promise<string> {
    const res = await open(stackId, key);
    expect(res.status, res.raw).toBe(201);
    return res.body.data.sessionId as string;
  }

  /** Reads until the output holds `want` or the session ends; returns everything read. */
  async function readUntil(sid: string, want: string): Promise<{ text: string; cursor: number; ended: Json | null }> {
    let text = "";
    let cursor = 0;
    for (let i = 0; i < 40; i++) {
      const res = await read(sid, cursor);
      expect(res.status).toBe(200);
      text += res.body.data.output as string;
      cursor = res.body.data.cursor as number;
      if (text.includes(want) || res.body.data.ended) return { text, cursor, ended: res.body.data.ended as Json | null };
    }
    throw new Error("output never arrived");
  }

  beforeAll(async () => {
    sim = new InMemoryDockerSimulatorAdapter({ terminalLimits: { readWaitMs: 100 } });
    h = await startAppStackHarness({
      allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST],
      dockerExecutor: sim,
      terminalSweepIntervalMs: null,
    });
    // The harness injects its own database client, so the app skips its boot seeding: run the call a boot makes.
    await ensureBuiltInAppTemplates(h.dbClient.db, builtInAppTemplateItems());
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    for (const template of [HTTP_CACHE, WORKER_STORAGE]) {
      const on = await h.call(h.adminToken, "PATCH", `/v1/admin/app-templates/${template.templateId}`, { enabled: true });
      if (on.status !== 200) throw new Error(`enable ${template.slug}: ${on.raw}`);
    }
    cacheId = await install(HTTP_CACHE.versionId, "shop-cache");
    storageId = await install(WORKER_STORAGE.versionId, "night-jobs", { parameters: [{ key: "worker_interval_seconds", value: 5 }] });
    blogId = await install(HTTP_CACHE.versionId, "blog-cache");
    draftId = await install(HTTP_CACHE.versionId, "not-yet", { deploy: false });
    for (const id of [cacheId, storageId, blogId]) expect(await statusOf(id), id).toBe("running");
    expect(await statusOf(draftId)).toBe("draft");
    adminAtStart = await adminRow();
  }, 240_000);

  // One app for the whole file: every test starts with no session, no audit row of its own and a clean code.
  afterEach(async () => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(sim, "openAppStackTerminal"); // an own property a test may have put over the method
    Object.defineProperty(sim, "isRuntimeAvailable", { value: true, configurable: true });
    sim.setEngineReachable(true);
    sim.forgetTerminalSessions();
    await h.dbClient.db.delete(adminTerminalSessions);
    seenAudits = new Set((await h.dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((a) => a.id));
    await h.dbClient.db
      .update(users)
      .set({ totpEnabledAt: adminAtStart.totpEnabledAt, totpLastStep: null, totpFailedCount: 0, lockedUntil: null })
      .where(eq(users.id, h.admin.userId));
  });

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  it("shows the page of any customer's application: its customer and its components, as the customer sees them", async () => {
    const res = await h.call(h.adminToken, "GET", page(cacheId));
    expect(res.status, res.raw).toBe(200);
    const dto = AdminAppStackDtoSchema.parse(res.body.data);
    expect(Object.keys(res.body.data as Json).sort()).toEqual(
      ["components", "id", "name", "organizationId", "organizationName", "primaryHostname", "status", "templateId", "templateName", "versionNumber"],
    );
    expect(dto).toMatchObject({
      id: cacheId,
      name: "shop-cache",
      organizationId: h.a.orgId,
      organizationName: "Hotel Mario",
      templateId: HTTP_CACHE.templateId,
      status: "running",
      primaryHostname: null,
    });
    // The same components, in the same order, with the same health the customer's own page shows.
    const own = await h.call(h.a.token, "GET", stacksPath(`/${cacheId}`));
    expect(own.status, own.raw).toBe(200);
    expect(dto.components).toEqual((own.body.data.components as Json[]).map((c) => ({ key: c.key, health: c.health })));
    expect(dto.components.map((c) => c.key).sort()).toEqual(["cache", "web"]);
    expect(dto.status).toBe(own.body.data.status);
    for (const c of res.body.data.components as Json[]) expect(Object.keys(c).sort()).toEqual(["health", "key"]);

    // An application that was never installed has a page too.
    const draft = await h.call(h.adminToken, "GET", page(draftId));
    expect(draft.status, draft.raw).toBe(200);
    expect(draft.body.data).toMatchObject({ id: draftId, status: "draft" });

    for (const missing of ["stk_missing", "Bad-Id", "x".repeat(65)]) {
      const none = await h.call(h.adminToken, "GET", page(missing));
      expect(none.status, missing).toBe(404);
      expect(none.body.error.code).toBe("NOT_FOUND");
    }
  });

  it("reads the logs of a component as the customer does, masked, and leaves one audit row for each read", async () => {
    const at = "2026-11-23T10:00:00.000Z";
    sim.appStacks.setAppStackComponentLogs(cacheId, "web", [
      { at, stream: "stdout", text: "SENTINELLINE GET / 200" },
      { at, stream: "stderr", text: "upstream sent Authorization: Bearer abc.DEF-123_sentinel" },
    ]);
    const res = await h.call(h.adminToken, "GET", logsPath(cacheId, "web", "?tail=50"));
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data.componentKey).toBe("web");
    expect((res.body.data.lines as Json[]).map((l) => l.text)).toEqual(["SENTINELLINE GET / 200", "upstream sent Authorization: Bearer [REDACTED]"]);
    expect(res.raw).not.toContain("abc.DEF-123_sentinel");
    // Line for line what the customer reads on their own route.
    const own = await h.call(h.a.token, "GET", `${stacksPath(`/${cacheId}`)}/components/web/logs?tail=50`);
    expect(own.status, own.raw).toBe(200);
    expect(res.body.data).toEqual(own.body.data);

    const [first] = await audits("admin.app_stack.logs.read");
    expect(first).toMatchObject({ actorId: h.admin.userId, organizationId: h.a.orgId, targetType: "app_stack", targetId: cacheId });
    expect(first!.details).toMatchObject({ componentKey: "web", tail: 50 });
    // The row says who read which component, never what was read.
    expect(JSON.stringify(first)).not.toContain("SENTINELLINE");

    // No tail is the customer's default; the customer's own read wrote no administrator row.
    expect((await h.call(h.adminToken, "GET", logsPath(cacheId, "cache"))).status).toBe(200);
    const reads = await audits("admin.app_stack.logs.read");
    expect(reads.map((a) => (a.details as Json).componentKey)).toEqual(["web", "cache"]);
    expect((reads[1]!.details as Json).tail).toBe(200);

    // A refused read reads nothing and writes no row.
    const spy = vi.spyOn(sim, "getAppStackComponentLogs");
    for (const query of ["?tail=501", "?tail=abc", "?tail=0"]) {
      expect((await h.call(h.adminToken, "GET", logsPath(cacheId, "web", query))).status, query).toBe(400);
    }
    expect((await h.call(h.adminToken, "GET", logsPath(cacheId, "nope"))).status).toBe(404);
    expect((await h.call(h.adminToken, "GET", logsPath("stk_missing", "web"))).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    expect(await audits("admin.app_stack.logs.read")).toHaveLength(2);
  });

  it("refuses everyone but a server administrator: the owner, a collaborator, another customer and no session", async () => {
    const terminal = vi.spyOn(sim, "openAppStackTerminal");
    const logs = vi.spyOn(sim, "getAppStackComponentLogs");
    const collaborator = await h.addMember(h.a.orgId, "role_customer_collaborator");
    const people: Array<[string, HarnessCustomer]> = [["owner", h.a], ["collaborator", collaborator], ["another customer", h.b]];
    for (const [who, person] of people) {
      const before = await deniedRows(person.userId);
      const results = [
        await h.call(person.token, "GET", page(cacheId)),
        await h.call(person.token, "GET", logsPath(cacheId, "web")),
        await post(openPath(cacheId, "web"), { code: await freshCode() }, person.token),
      ];
      for (const res of results) {
        expect(res.status, who).toBe(403);
        expect(res.body.error.code).toBe("PERMISSION_DENIED");
        expect(res.raw).not.toContain("shop-cache");
      }
      expect((await deniedRows(person.userId)) - before, who).toBe(3);
    }
    expect((await h.call(null, "GET", page(cacheId))).status).toBe(401);
    expect((await h.call(null, "GET", logsPath(cacheId, "web"))).status).toBe(401);
    expect((await post(openPath(cacheId, "web"), { code: "123456" }, null)).status).toBe(401);

    // The customer's own routes have no terminal, for the owner or for an administrator who goes through them.
    for (const token of [h.a.token, h.adminToken]) {
      expect((await post(`${stacksPath(`/${cacheId}`)}/components/web/terminal`, { code: await freshCode() }, token)).status).toBe(404);
    }

    expect(terminal).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
    for (const action of OWN_AUDITS) expect(await audits(action), action).toHaveLength(0);
  });

  it("opens in a component with a fresh code, runs a command, and closes twice with one close row", async () => {
    const res = await open(cacheId, "web");
    expect(res.status, res.raw).toBe(201);
    const dto = AppTerminalSessionDtoSchema.parse(res.body.data);
    expect(Object.keys(res.body.data as Json).sort()).toEqual(["componentKey", "containerName", "expiresAt", "openedAt", "sessionId", "stackId"]);
    // The name the executor derives itself; never a Docker id.
    expect(dto).toMatchObject({ stackId: cacheId, componentKey: "web", containerName: `hp_app_${cacheId}_web` });
    expect(Date.parse(dto.expiresAt) - Date.parse(dto.openedAt)).toBe(TERMINAL_SESSION_MAX_MS);
    expect(await row(dto.sessionId)).toMatchObject({
      userId: h.admin.userId,
      siteId: null,
      stackId: cacheId,
      componentKey: "web",
      organizationId: h.a.orgId,
      containerName: dto.containerName,
      closedAt: null,
    });
    const [openRow] = await audits("admin.terminal.open");
    expect(openRow).toMatchObject({ actorId: h.admin.userId, organizationId: h.a.orgId, targetType: "app_stack", targetId: cacheId });
    expect(openRow!.details).toMatchObject({ outcome: "succeeded", sessionId: dto.sessionId, containerName: dto.containerName, componentKey: "web" });

    expect((await write(dto.sessionId, "echo hi\n")).status).toBe(204);
    const first = await readUntil(dto.sessionId, "hi\r\n");
    expect(first.text).toContain("hi\r\n");
    const again = await read(dto.sessionId, first.cursor);
    expect(again.body.data).toMatchObject({ output: "", cursor: first.cursor, ended: null });

    expect((await close(dto.sessionId)).status).toBe(204);
    expect((await close(dto.sessionId)).status).toBe(204);
    const closes = await audits("admin.terminal.close");
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ actorId: h.admin.userId, organizationId: h.a.orgId, targetType: "app_stack", targetId: cacheId });
    expect(closes[0]!.details).toMatchObject({ sessionId: dto.sessionId, containerName: dto.containerName, componentKey: "web", reason: "closed" });
    expect(await row(dto.sessionId)).toMatchObject({ closeReason: "closed" });
    expect(await audits("admin.terminal.open")).toHaveLength(1);

    const after = await read(dto.sessionId, first.cursor);
    expect(after.body.data.ended).toMatchObject({ reason: "closed" });
    const late = await write(dto.sessionId, "id\n");
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: "RESOURCE_LOCKED", details: [{ reason: "session_ended" }] });
  });

  it("refuses a missing, malformed, wrong or used code with its denied reason on the application, and never calls the executor", async () => {
    const spy = vi.spyOn(sim, "openAppStackTerminal");
    const missing = await post(openPath(cacheId, "web"), {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");
    expect((await post(openPath(cacheId, "web"), { code: "12a456" })).status).toBe(400);
    const wrong = await post(openPath(cacheId, "web"), { code: wrongCode() });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("TOTP_INVALID");

    // A code already spent is refused like a wrong one (they cannot be told apart).
    await h.dbClient.db.update(users).set({ totpLastStep: step() + 1 }).where(eq(users.id, h.admin.userId));
    const used = await post(openPath(cacheId, "web"), { code: totpCodeAt(h.admin.totpSecret, step()) });
    expect(used.status).toBe(401);
    expect(used.body.error.code).toBe("TOTP_INVALID");

    expect(spy).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
    expect(await deniedReasons()).toEqual(["code_missing", "code_missing", "code_wrong", "code_wrong"]);
    for (const denied of await audits("admin.terminal.denied")) {
      expect(denied).toMatchObject({ actorId: h.admin.userId, organizationId: h.a.orgId, targetType: "app_stack", targetId: cacheId });
      expect(denied.details).toMatchObject({ outcome: "denied" });
    }
  });

  it("gives one session to two opens racing with one code", async () => {
    const code = await freshCode();
    const [a, b] = await Promise.all([post(openPath(cacheId, "web"), { code }), post(openPath(cacheId, "cache"), { code })]);
    expect([a.status, b.status].sort()).toEqual([201, 401]);
    expect(["code_used", "code_wrong"]).toContain((await deniedReasons())[0]);
    expect(await rows()).toHaveLength(1);
  });

  it("locks after five wrong codes, and refuses an administrator without an authenticator", async () => {
    const spy = vi.spyOn(sim, "openAppStackTerminal");
    for (let i = 0; i < 5; i++) expect((await post(openPath(cacheId, "web"), { code: wrongCode() })).status).toBe(401);
    const locked = await post(openPath(cacheId, "web"), { code: totpCodeAt(h.admin.totpSecret, step()) });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
    expect(await deniedReasons()).toEqual([...Array<string>(5).fill("code_wrong"), "locked"]);

    await h.dbClient.db.update(users).set({ totpEnabledAt: null, totpFailedCount: 0, lockedUntil: null }).where(eq(users.id, h.admin.userId));
    const none = await post(openPath(cacheId, "web"), { code: totpCodeAt(h.admin.totpSecret, step()) });
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe("ACCOUNT_SETUP_INCOMPLETE");
    expect((await deniedReasons()).at(-1)).toBe("totp_not_enrolled");
    expect(spy).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  it("refuses before the code is spent: never installed, being changed, stopped, runtime off, unknown application or component", async () => {
    const spy = vi.spyOn(sim, "openAppStackTerminal");
    const before = await adminRow();
    const code = totpCodeAt(h.admin.totpSecret, step() + 1);
    const refusedWith = async (stackId: string, key: string, reason: string) => {
      const res = await post(openPath(stackId, key), { code });
      expect(res.status, `${reason}: ${res.raw}`).toBe(409);
      expect(res.body.error).toMatchObject({ code: "RESOURCE_LOCKED", details: [{ reason }] });
      return res;
    };

    expect((await refusedWith(draftId, "web", "container_down")).body.error.message).toBe(DOWN);

    // A change is running: by the stored status, and by the operation that holds the application's lock.
    await h.dbClient.db.update(appStacks).set({ status: "updating" }).where(eq(appStacks.id, cacheId));
    const changing = await refusedWith(cacheId, "web", "site_changing");
    expect(changing.body.error.message).toBe("Wait for the running change of the application to end.");
    await h.dbClient.db.update(appStacks).set({ status: "running" }).where(eq(appStacks.id, cacheId));

    const stop = await h.call(h.a.token, "POST", stacksPath(`/${storageId}/stop`), {}, idem());
    expect(stop.status, stop.raw).toBe(202);
    const queued = await statusOf(storageId);
    await refusedWith(storageId, "worker", "site_changing");
    await h.dbClient.db.update(appStacks).set({ status: "running" }).where(eq(appStacks.id, storageId));
    await refusedWith(storageId, "worker", "site_changing"); // the lock alone
    await h.dbClient.db.update(appStacks).set({ status: queued }).where(eq(appStacks.id, storageId));
    await drain(storageId);

    expect(await statusOf(storageId)).toBe("stopped");
    expect((await refusedWith(storageId, "worker", "container_down")).body.error.message).toBe(DOWN);
    await act(storageId, "start");
    expect(await statusOf(storageId)).toBe("running");

    Object.defineProperty(sim, "isRuntimeAvailable", { value: false, configurable: true });
    const off = await post(openPath(cacheId, "web"), { code });
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    Object.defineProperty(sim, "isRuntimeAvailable", { value: true, configurable: true });

    for (const [stackId, key] of [["stk_missing", "web"], ["Bad-Id", "web"], [cacheId, "nope"], [cacheId, "Web"], [draftId, "nope"]] as const) {
      const none = await post(openPath(stackId, key), { code });
      expect(none.status, `${stackId}/${key}`).toBe(404);
      expect(none.body.error.code).toBe("NOT_FOUND");
    }

    const after = await adminRow();
    expect(after.totpLastStep).toBe(before.totpLastStep);
    expect(after.totpFailedCount).toBe(before.totpFailedCount);
    expect(spy).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
    expect(await audits("admin.terminal.denied")).toHaveLength(0);
    // The same code still opens.
    expect((await post(openPath(cacheId, "web"), { code })).status).toBe(201);
  }, 60_000);

  it("answers 503 and spends no code when the executor does not offer a terminal in a component", async () => {
    const before = await adminRow();
    const code = totpCodeAt(h.admin.totpSecret, step() + 1);
    Object.defineProperty(sim, "openAppStackTerminal", { value: undefined, configurable: true, writable: true });
    let res: Res;
    try {
      res = await post(openPath(cacheId, "web"), { code });
    } finally {
      Reflect.deleteProperty(sim, "openAppStackTerminal"); // the method of the class is back
    }
    expect(res.status, res.raw).toBe(503);
    expect(res.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    expect((await adminRow()).totpLastStep).toBe(before.totpLastStep);
    expect(await rows()).toHaveLength(0);
    expect(await audits("admin.terminal.denied")).toHaveLength(0);
    expect((await post(openPath(cacheId, "web"), { code })).status).toBe(201);
  });

  it("allows one session in a component and four on the server", async () => {
    await opened(cacheId, "web");
    const busy = await open(cacheId, "web");
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatchObject({ code: "RESOURCE_LOCKED", details: [{ reason: "site_busy" }] });
    expect(busy.body.error.message).toBe("Close the other terminal of this component first.");
    expect(await rows()).toHaveLength(1);
    expect(await audits("admin.terminal.open")).toHaveLength(1);

    // The other component of the same application is another container.
    await opened(cacheId, "cache");
    await opened(storageId, "storage");
    const fourth = await opened(storageId, "worker");
    const full = await open(blogId, "web");
    expect(full.status).toBe(409);
    expect(full.body.error).toMatchObject({ code: "RESOURCE_LOCKED", details: [{ reason: "server_full" }] });
    expect(await rows()).toHaveLength(4);
    expect(await audits("admin.terminal.open")).toHaveLength(4);

    expect((await close(fourth)).status).toBe(204);
    await opened(blogId, "web");
  });

  it("ends the row as not_started with one close row when the executor refuses, and never repeats its words", async () => {
    const refusal = (code: string) => () => {
      vi.spyOn(sim, "openAppStackTerminal").mockRejectedValueOnce(new ExecutorCodedError(ENGINE_TEXT, code as ExecutorCodedError["code"]));
    };
    const cases: Array<{ arrange: () => Promise<void> | void; status: number; reason?: string }> = [
      // The executor holds a session of this component the API does not know.
      {
        arrange: async () => {
          await sim.openAppStackTerminal({
            sessionId: `term_${randomBytes(16).toString("hex")}`,
            stackId: cacheId,
            organizationId: h.a.orgId,
            componentKey: "web",
          });
        },
        status: 409,
        reason: "site_busy",
      },
      { arrange: () => { sim.forgetTerminalSessions(); refusal("NOT_FOUND")(); }, status: 409, reason: "container_down" },
      { arrange: refusal("QUOTA_EXCEEDED"), status: 409, reason: "server_full" },
      // The container's labels did not match, or the executor is an older one.
      { arrange: refusal("HOST_POLICY_DENIED"), status: 503 },
      { arrange: refusal("NOT_SUPPORTED"), status: 503 },
      { arrange: () => sim.setEngineReachable(false), status: 503 },
    ];
    for (const c of cases) {
      await c.arrange();
      const res = await open(cacheId, "web");
      expect(res.status, `${c.reason ?? "unavailable"}: ${res.raw}`).toBe(c.status);
      if (c.reason) expect(res.body.error.details[0].reason).toBe(c.reason);
      else expect(res.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
      expect(res.raw).not.toContain("SENTINEL_ENGINE_TEXT");
      expect(res.raw).not.toMatch(/Component not found|component is not running|hp_x/);
      vi.restoreAllMocks();
    }
    const all = await rows();
    expect(all).toHaveLength(cases.length);
    expect(all.every((r) => r.closeReason === "not_started" && r.stackId === cacheId && r.componentKey === "web")).toBe(true);
    expect(await audits("admin.terminal.open")).toHaveLength(cases.length);
    const closes = await audits("admin.terminal.close");
    expect(closes).toHaveLength(cases.length);
    expect(closes.every((a) => (a.details as Json).reason === "not_started" && a.targetType === "app_stack" && a.targetId === cacheId)).toBe(true);
  });

  it("leaves an open that timed out to the pass, which closes it after the grace", async () => {
    vi.spyOn(sim, "openAppStackTerminal").mockRejectedValueOnce(new ExecutorCodedError(ENGINE_TEXT, "OPERATION_AMBIGUOUS"));
    const res = await open(cacheId, "web");
    expect(res.status).toBe(503);
    expect(res.body.error.message).toBe("The terminal could not be opened. Try again in a minute.");
    const [r] = await rows();
    expect(r!.closedAt).toBeNull();
    await sweep(new Date());
    expect((await row(r!.id)).closedAt).toBeNull();
    await sweep(new Date(Date.now() + 61_000));
    expect(await row(r!.id)).toMatchObject({ closeReason: "executor_gone" });
    expect(await audits("admin.terminal.close")).toHaveLength(1);
  });

  it("answers 404 to another administrator on a session in a component", async () => {
    const sid = await opened(cacheId, "web");
    const password = "sentinel-second-admin";
    const other = await createServerAdmin(h.dbClient.db, KEY, { email: "admin2@x.it", name: "Admin Two", password });
    const login = await h.call(null, "POST", "/v1/auth/login", {
      email: "admin2@x.it",
      password,
      totpCode: totpCodeAt(other.totpSecretBase32, step()),
    });
    expect(login.status, login.raw).toBe(200);
    const otherToken = login.body.data.accessToken as string;
    for (const res of [await write(sid, "id\n", otherToken), await read(sid, 0, otherToken), await close(sid, otherToken)]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
    expect((await row(sid)).closedAt).toBeNull();
  });

  it("ends a session when its customer stops the application: the pass closes the row as container_gone", async () => {
    const sid = await opened(storageId, "worker");
    await act(storageId, "stop");
    await sweep(new Date());
    expect(await row(sid)).toMatchObject({ closeReason: "container_gone" });
    const [closed] = await audits("admin.terminal.close");
    expect(closed).toMatchObject({ actorType: "system", organizationId: h.a.orgId, targetType: "app_stack", targetId: storageId });
    expect(closed!.details).toMatchObject({ sessionId: sid, componentKey: "worker", reason: "container_gone" });
    expect(await sim.listTerminals()).toHaveLength(0);
    const late = await write(sid, "id\n");
    expect(late.status).toBe(409);
    expect(late.body.error.details[0].reason).toBe("session_ended");
    await act(storageId, "start");
    expect(await statusOf(storageId)).toBe("running");
  }, 60_000);

  it("stores nothing typed or printed: not in the database, an error or a console call", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const typed = `SENTINELIN${randomBytes(6).toString("hex")}`;
    const printed = `SENTINELOUT${randomBytes(6).toString("hex")}`;
    const sid = await opened(cacheId, "cache");
    expect((await write(sid, `echo ${typed}\n`)).status).toBe(204);
    sim.emitTerminalOutput(sid, `${printed}\r\n`);
    expect((await readUntil(sid, printed)).text).toContain(typed);
    const long = await write(sid, typed.repeat(400));
    expect(long.status).toBe(400);
    expect(long.raw).not.toContain(typed);
    expect((await close(sid)).status).toBe(204);

    const tables = (await h.dbClient.db.execute(
      sql.raw("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"),
    )).rows as Array<{ table_name: string }>;
    let dump = "";
    for (const { table_name: t } of tables) {
      dump += JSON.stringify((await h.dbClient.db.execute(sql.raw(`SELECT x::text AS t FROM "${t}" x`))).rows);
    }
    expect(dump).toContain(sid);
    expect(dump).not.toContain(typed);
    expect(dump).not.toContain(printed);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(typed);
    expect(logged).not.toContain(printed);
    for (const file of ["../src/terminal/admin-terminal.service.ts", "../src/app-stacks/admin-app-stacks.service.ts", "../src/controllers/admin-app-stacks.controller.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(/console\.|logger/i);
    }
  });

  it("a deleted application is gone for the administrator too: no page, no logs, no terminal", async () => {
    const name = `gone-${randomUUID().slice(0, 8)}`;
    const goneId = await install(WORKER_STORAGE.versionId, name, { parameters: [{ key: "worker_interval_seconds", value: 5 }] });
    expect((await h.call(h.adminToken, "GET", page(goneId))).status).toBe(200);
    const sid = await opened(goneId, "worker");

    const del = await h.call(h.a.token, "DELETE", stacksPath(`/${goneId}`), { confirmName: name, destroyData: false }, idem());
    expect(del.status, del.raw).toBe(202);
    await drain(goneId);
    expect(await statusOf(goneId)).toBe("deleted");

    // The session went with the container; its row still names the application it was in.
    await sweep(new Date());
    expect(await row(sid)).toMatchObject({ closeReason: "container_gone", stackId: goneId, componentKey: "worker" });

    const before = await adminRow();
    const spy = vi.spyOn(sim, "openAppStackTerminal");
    expect((await h.call(h.adminToken, "GET", page(goneId))).status).toBe(404);
    expect((await h.call(h.adminToken, "GET", logsPath(goneId, "worker"))).status).toBe(404);
    expect((await post(openPath(goneId, "worker"), { code: totpCodeAt(h.admin.totpSecret, step() + 1) })).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
    expect((await adminRow()).totpLastStep).toBe(before.totpLastStep);
    expect(await audits("admin.app_stack.logs.read")).toHaveLength(0);
  }, 60_000);
});

describe("the administrator's routes on an application while applications are off", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;

  beforeAll(async () => {
    sim = new InMemoryDockerSimulatorAdapter();
    h = await startAppStackHarness({ appFeatures: {}, dockerExecutor: sim, terminalSweepIntervalMs: null });
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.close();
  }, 60_000);

  it("answers the administrator 422 on the page, the logs and the terminal, spends no code, and still refuses an owner with 403", async () => {
    const spy = vi.spyOn(sim, "openAppStackTerminal");
    const before = (await h.dbClient.db.select().from(users).where(eq(users.id, h.admin.userId)))[0]!;
    const code = totpCodeAt(h.admin.totpSecret, Math.floor(Date.now() / 30_000) + 1);
    const results = [
      await h.call(h.adminToken, "GET", page("stk_any")),
      await h.call(h.adminToken, "GET", logsPath("stk_any", "web")),
      await h.call(h.adminToken, "POST", openPath("stk_any", "web"), { code }, { "Idempotency-Key": randomUUID() }),
    ];
    for (const res of results) {
      expect(res.status, res.raw).toBe(422);
      expect(res.body.error).toMatchObject({ code: "NOT_SUPPORTED", details: [{ reason: "STACK_UNSUPPORTED_FEATURE" }] });
    }
    const owner = await h.call(h.a.token, "POST", openPath("stk_any", "web"), { code }, { "Idempotency-Key": randomUUID() });
    expect(owner.status, owner.raw).toBe(403);
    expect(owner.body.error.code).toBe("PERMISSION_DENIED");

    expect(spy).not.toHaveBeenCalled();
    expect(await h.dbClient.db.select().from(adminTerminalSessions)).toHaveLength(0);
    const after = (await h.dbClient.db.select().from(users).where(eq(users.id, h.admin.userId)))[0]!;
    expect(after.totpLastStep).toBe(before.totpLastStep);
    expect(after.totpFailedCount).toBe(before.totpFailedCount);
    const denied = await h.dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.terminal.denied"));
    expect(denied).toHaveLength(0);
  });
});
