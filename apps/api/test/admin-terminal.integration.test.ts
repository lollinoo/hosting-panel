import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { TERMINAL_SESSION_ID_PATTERN, TERMINAL_SESSION_MAX_MS } from "@hosting-panel/contracts";
import {
  adminTerminalSessions,
  auditEvents,
  createDatabaseClient,
  eq,
  serviceInstances,
  sites,
  sql,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { ExecutorCodedError, InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { AdminTerminalService } from "../src/terminal/admin-terminal.service.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-admin-pass";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "owner@example.test",
  adminPassword: "sentinel-Pass-123456",
};
const ENGINE_TEXT = "SENTINEL_ENGINE_TEXT no such container hp_x /var/lib/docker";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("administrator terminal routes", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let adminId: string;
  let adminSecret: string;
  let siteId: string;

  async function login(email: string, password: string, totpSecret: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(path: string, body?: unknown, as = adminToken): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${as}`,
        "Idempotency-Key": randomUUID(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const deniedReasons = async () => (await audits("admin.terminal.denied")).map((a) => (a.details as Json).reason as string);
  const rows = () => dbClient.db.select().from(adminTerminalSessions);
  const sweep = (now: Date) => app.nestApp.get(AdminTerminalService).sweepOnce(now);
  const row = async (id: string) => (await dbClient.db.select().from(adminTerminalSessions).where(eq(adminTerminalSessions.id, id)))[0]!;
  const adminRow = async () => (await dbClient.db.select().from(users).where(eq(users.id, adminId)))[0]!;
  const webService = async (id = siteId) =>
    (await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, id)))[0]!;

  /** A code of the current step, made usable again by forgetting the last used step. */
  async function freshCode(): Promise<string> {
    await dbClient.db.update(users).set({ totpLastStep: null }).where(eq(users.id, adminId));
    return totpCodeAt(adminSecret, Math.floor(Date.now() / 30_000));
  }

  /** A six-digit code that matches no step of the accepted window. */
  function wrongCode(): string {
    const step = Math.floor(Date.now() / 30_000);
    const valid = new Set([-1, 0, 1, 2].map((d) => totpCodeAt(adminSecret, step + d)));
    for (let n = 0; ; n++) {
      const code = String(n).padStart(6, "0");
      if (!valid.has(code)) return code;
    }
  }

  const openPath = (id = siteId) => `/v1/admin/sites/${id}/terminal`;
  const open = async (id = siteId) => call(openPath(id), { code: await freshCode() });
  const write = (sid: string, input: string, as?: string) => call(`/v1/admin/terminal/${sid}/write`, { input }, as);
  const read = (sid: string, cursor: number, as?: string) => call(`/v1/admin/terminal/${sid}/read`, { cursor }, as);
  const close = (sid: string, as?: string) => call(`/v1/admin/terminal/${sid}/close`, undefined, as);

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

  async function createSite(domain = SITE.domain): Promise<string> {
    const res = await call("/v1/admin/sites", { ...SITE, domain, ownerOrganizationId: null });
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.siteId as string;
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter({ terminalLimits: { readWaitMs: 100 } });
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
      terminalSweepIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminSecret = admin.totpSecretBase32;
    adminId = admin.userId;
    adminToken = await login("admin@example.test", PW, adminSecret);
    siteId = await createSite();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  it("opens with a fresh code, runs a command read by cursor, and closes twice with one close row", async () => {
    const opened = await open();
    expect(opened.status).toBe(201);
    const dto = opened.body.data as Json;
    const svc = await webService();
    expect(dto.sessionId).toMatch(TERMINAL_SESSION_ID_PATTERN);
    expect(dto).toMatchObject({ siteId, containerName: `hp_svc_${svc.id}` });
    expect(Date.parse(dto.expiresAt as string) - Date.parse(dto.openedAt as string)).toBe(TERMINAL_SESSION_MAX_MS);
    const [openRow] = await audits("admin.terminal.open");
    expect(openRow).toMatchObject({ actorId: adminId, targetType: "site", targetId: siteId });
    expect(openRow!.details).toMatchObject({ outcome: "succeeded", sessionId: dto.sessionId, containerName: dto.containerName });
    expect((await row(dto.sessionId as string)).closedAt).toBeNull();

    expect((await write(dto.sessionId as string, "echo hi\n")).status).toBe(204);
    const first = await readUntil(dto.sessionId as string, "hi\r\n");
    expect(first.text).toContain("hi\r\n");
    expect(first.cursor).toBeGreaterThan(0);
    // The cursor moves on: nothing already read comes back.
    const again = await read(dto.sessionId as string, first.cursor);
    expect(again.body.data).toMatchObject({ output: "", cursor: first.cursor, ended: null });

    expect((await close(dto.sessionId as string)).status).toBe(204);
    expect((await close(dto.sessionId as string)).status).toBe(204);
    const closes = await audits("admin.terminal.close");
    expect(closes).toHaveLength(1);
    expect(closes[0]!.details).toMatchObject({ outcome: "succeeded", sessionId: dto.sessionId, reason: "closed" });
    expect(await row(dto.sessionId as string)).toMatchObject({ closeReason: "closed" });
    expect(await audits("admin.terminal.open")).toHaveLength(1);

    // A read after the end gives the end from the row; a write is refused.
    const after = await read(dto.sessionId as string, first.cursor);
    expect(after.status).toBe(200);
    expect(after.body.data.ended).toMatchObject({ reason: "closed" });
    const late = await write(dto.sessionId as string, "id\n");
    expect(late.status).toBe(409);
    expect(late.body.error).toMatchObject({ code: "RESOURCE_LOCKED", details: [{ reason: "session_ended" }] });
    expect(await audits("admin.terminal.close")).toHaveLength(1);
  });

  it("refuses a missing, malformed, wrong or used code with its denied reason and never calls the executor", async () => {
    const spy = vi.spyOn(sim, "openTerminal");
    const missing = await call(openPath(), {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");
    expect((await call(openPath(), { code: "12a456" })).status).toBe(400);
    const wrong = await call(openPath(), { code: wrongCode() });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("TOTP_INVALID");
    expect(spy).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);

    // A code already spent at login is refused like a wrong one (they cannot be told apart).
    await dbClient.db.update(users).set({ totpLastStep: Math.floor(Date.now() / 30_000) + 1 }).where(eq(users.id, adminId));
    const used = await call(openPath(), { code: totpCodeAt(adminSecret, Math.floor(Date.now() / 30_000)) });
    expect(used.status).toBe(401);
    expect(used.body.error.code).toBe("TOTP_INVALID");
    expect(spy).not.toHaveBeenCalled();
    expect(await deniedReasons()).toEqual(["code_missing", "code_missing", "code_wrong", "code_wrong"]);
    const [denied] = await audits("admin.terminal.denied");
    expect(denied).toMatchObject({ actorId: adminId, targetType: "site", targetId: siteId });
    expect(denied!.details).toMatchObject({ outcome: "denied" });
  });

  it("gives code_used to the loser of two opens racing with one code", async () => {
    const other = await createSite("wp-b.example.test");
    const code = await freshCode();
    const [a, b] = await Promise.all([call(openPath(), { code }), call(openPath(other), { code })]);
    expect([a.status, b.status].sort()).toEqual([201, 401]);
    expect(["code_used", "code_wrong"]).toContain((await deniedReasons())[0]);
    expect(await rows()).toHaveLength(1);
  });

  it("locks after five wrong codes: the sixth try is 423 even with a right code", async () => {
    const spy = vi.spyOn(sim, "openTerminal");
    for (let i = 0; i < 5; i++) expect((await call(openPath(), { code: wrongCode() })).status).toBe(401);
    const locked = await call(openPath(), { code: totpCodeAt(adminSecret, Math.floor(Date.now() / 30_000)) });
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
    expect(await deniedReasons()).toEqual([...Array(5).fill("code_wrong"), "locked"]);
    expect(spy).not.toHaveBeenCalled();
    // The administrator's own session stays valid.
    expect((await call(`/v1/admin/terminal/term_${"0".repeat(32)}/close`)).status).toBe(404);
  });

  it("refuses an administrator without an authenticator with 403", async () => {
    const spy = vi.spyOn(sim, "openTerminal");
    const code = await freshCode();
    await dbClient.db.update(users).set({ totpEnabledAt: null }).where(eq(users.id, adminId));
    const res = await call(openPath(), { code });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("ACCOUNT_SETUP_INCOMPLETE");
    expect(await deniedReasons()).toEqual(["totp_not_enrolled"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a site being changed or not running before the code is spent", async () => {
    const spy = vi.spyOn(sim, "openTerminal");
    const before = await adminRow();
    const code = totpCodeAt(adminSecret, Math.floor(Date.now() / 30_000) + 1);
    const expectRefused = async (reason: string) => {
      const res = await call(openPath(), { code });
      expect(res.status, reason).toBe(409);
      expect(res.body.error).toMatchObject({ code: "RESOURCE_LOCKED", details: [{ reason }] });
      return res;
    };

    await dbClient.db.update(sites).set({ status: "deploying" }).where(eq(sites.id, siteId));
    await expectRefused("site_changing");
    await dbClient.db.update(sites).set({ status: "ready" }).where(eq(sites.id, siteId));

    expect((await call(`/v1/admin/sites/${siteId}/restart`, { reason: "sentinel reason" })).status).toBe(202);
    await expectRefused("site_changing");
    await app.outboxWorker.processPendingOnce();

    await dbClient.db.update(serviceInstances).set({ desiredStatus: "stopped" }).where(eq(serviceInstances.siteId, siteId));
    const down = await expectRefused("container_down");
    expect(down.body.error.message).toBe("The site is not running. Restart it, then open the terminal.");
    await dbClient.db.update(serviceInstances).set({ desiredStatus: "running" }).where(eq(serviceInstances.siteId, siteId));

    Object.defineProperty(sim, "isRuntimeAvailable", { value: false, configurable: true });
    const off = await call(openPath(), { code });
    expect(off.status).toBe(503);
    expect(off.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    Object.defineProperty(sim, "isRuntimeAvailable", { value: true, configurable: true });

    expect((await call(openPath("site_missing"), { code })).status).toBe(404);

    const after = await adminRow();
    expect(after.totpLastStep).toBe(before.totpLastStep);
    expect(after.totpFailedCount).toBe(before.totpFailedCount);
    expect(spy).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
    expect(await audits("admin.terminal.denied")).toHaveLength(0);
    // The same code still opens.
    expect((await call(openPath(), { code })).status).toBe(201);
  });

  it("refuses a second session on the same site with site_busy and writes nothing", async () => {
    expect((await open()).status).toBe(201);
    const busy = await open();
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatchObject({ code: "RESOURCE_LOCKED", details: [{ reason: "site_busy" }] });
    expect(await rows()).toHaveLength(1);
    expect(await audits("admin.terminal.open")).toHaveLength(1);
  });

  it("ends the row as not_started with one close row when the executor refuses the open", async () => {
    const svc = await webService();
    const cases: Array<{ arrange: () => Promise<void> | void; status: number; reason?: string }> = [
      // The container stopped behind the panel's back.
      { arrange: async () => void (await sim.stopService(svc.id)), status: 409, reason: "container_down" },
      // The executor holds a session of this site the API does not know.
      {
        arrange: async () => {
          await sim.restartService(svc.id);
          await sim.openTerminal({ sessionId: `term_${randomBytes(16).toString("hex")}`, siteId, serviceInstanceId: svc.id });
        },
        status: 409,
        reason: "site_busy",
      },
      {
        arrange: () => {
          sim.forgetTerminalSessions();
          vi.spyOn(sim, "openTerminal").mockRejectedValueOnce(new ExecutorCodedError(ENGINE_TEXT, "QUOTA_EXCEEDED"));
        },
        status: 409,
        reason: "server_full",
      },
      { arrange: () => sim.setEngineReachable(false), status: 503 },
    ];
    for (const c of cases) {
      await c.arrange();
      const res = await open();
      expect(res.status, c.reason ?? "unreachable").toBe(c.status);
      if (c.reason) expect(res.body.error.details[0].reason).toBe(c.reason);
      expect(res.raw).not.toContain("SENTINEL_ENGINE_TEXT");
      expect(res.raw).not.toContain("Site container not found");
    }
    const all = await rows();
    expect(all).toHaveLength(cases.length);
    expect(all.every((r) => r.closeReason === "not_started")).toBe(true);
    expect(await audits("admin.terminal.open")).toHaveLength(cases.length);
    const closes = await audits("admin.terminal.close");
    expect(closes).toHaveLength(cases.length);
    expect(closes.every((a) => (a.details as Json).reason === "not_started")).toBe(true);
  });

  it("leaves an open that timed out to the pass, which closes it after the grace", async () => {
    vi.spyOn(sim, "openTerminal").mockRejectedValueOnce(new ExecutorCodedError(ENGINE_TEXT, "OPERATION_AMBIGUOUS"));
    const res = await open();
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

  it("answers 404 to another administrator and to a malformed session id", async () => {
    const opened = await open();
    const sid = opened.body.data.sessionId as string;
    const other = await createServerAdmin(dbClient.db, KEY, { email: "admin2@example.test", name: "Admin Two", password: PW });
    const otherToken = await login("admin2@example.test", PW, other.totpSecretBase32);
    for (const res of [await write(sid, "id\n", otherToken), await read(sid, 0, otherToken), await close(sid, otherToken)]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
    for (const bad of ["term_x", "term_" + "A".repeat(32), "nope"]) {
      expect((await write(bad, "id\n")).status).toBe(404);
      expect((await read(bad, 0)).status).toBe(404);
      expect((await close(bad)).status).toBe(404);
    }
    expect((await row(sid)).closedAt).toBeNull();
  });

  it("closes the row when a read finds the shell ended, and refuses a later write", async () => {
    const sid = (await open()).body.data.sessionId as string;
    expect((await write(sid, "exit\n")).status).toBe(204);
    const seen = await readUntil(sid, "\u0000never");
    expect(seen.ended).toMatchObject({ reason: "shell_exited" });
    expect(await row(sid)).toMatchObject({ closeReason: "shell_exited" });
    const res = await write(sid, "id\n");
    expect(res.status).toBe(409);
    expect(res.body.error.details[0].reason).toBe("session_ended");
    expect((await close(sid)).status).toBe(204);
    expect(await audits("admin.terminal.close")).toHaveLength(1);
  });

  it("closes as executor_gone when the executor forgot the session", async () => {
    const a = (await open()).body.data.sessionId as string;
    sim.forgetTerminalSessions();
    const w = await write(a, "id\n");
    expect(w.status).toBe(409);
    expect(w.body.error.details[0].reason).toBe("session_ended");
    expect(await row(a)).toMatchObject({ closeReason: "executor_gone" });

    const b = (await open()).body.data.sessionId as string;
    sim.forgetTerminalSessions();
    const r = await read(b, 7);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ output: "", cursor: 7, dropped: false, ended: { reason: "executor_gone" } });

    const c = (await open()).body.data.sessionId as string;
    sim.forgetTerminalSessions();
    expect((await close(c)).status).toBe(204);
    expect(await row(c)).toMatchObject({ closeReason: "executor_gone" });
    expect(await audits("admin.terminal.close")).toHaveLength(3);
  });

  it("answers 503 with a fixed sentence when the executor does not answer, and keeps the row open", async () => {
    const sid = (await open()).body.data.sessionId as string;
    sim.setEngineReachable(false);
    for (const res of [await write(sid, "id\n"), await read(sid, 0), await close(sid)]) {
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    }
    expect((await row(sid)).closedAt).toBeNull();
    expect(await audits("admin.terminal.close")).toHaveLength(0);
  });

  it("the pass: keeps young rows, closes ended and unknown ones, and does nothing when the list fails", async () => {
    const svc = await webService();
    const a = (await open()).body.data.sessionId as string;

    // The list fails: nothing changes, even long after the grace.
    sim.setEngineReachable(false);
    await sweep(new Date(Date.now() + 120_000));
    expect((await row(a)).closedAt).toBeNull();
    sim.setEngineReachable(true);

    // Live and listed: left alone.
    await sweep(new Date(Date.now() + 120_000));
    expect((await row(a)).closedAt).toBeNull();

    // Listed as ended: closed with the executor's reason.
    await sim.stopService(svc.id);
    await sweep(new Date());
    expect(await row(a)).toMatchObject({ closeReason: "container_gone" });
    expect(await sim.listTerminals()).toHaveLength(0);
    await sim.restartService(svc.id);

    // Not listed: kept within the grace, then executor_gone.
    const b = (await open()).body.data.sessionId as string;
    sim.forgetTerminalSessions();
    await sweep(new Date());
    expect((await row(b)).closedAt).toBeNull();
    await sweep(new Date(Date.now() + 61_000));
    expect(await row(b)).toMatchObject({ closeReason: "executor_gone" });

    const closes = await audits("admin.terminal.close");
    expect(closes.map((x) => (x.details as Json).reason)).toEqual(["container_gone", "executor_gone"]);
    expect(closes.every((x) => x.actorType === "system")).toBe(true);
  });

  it("stores nothing typed or printed: not in the database, an error or a console call", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const typed = `SENTINELIN${randomBytes(6).toString("hex")}`;
    const printed = `SENTINELOUT${randomBytes(6).toString("hex")}`;
    const sid = (await open()).body.data.sessionId as string;
    expect((await write(sid, `echo ${typed}\n`)).status).toBe(204);
    sim.emitTerminalOutput(sid, `${printed}\r\n`);
    expect((await readUntil(sid, printed)).text).toContain(typed);
    // An over-long input is refused with a fixed sentence, never its own text.
    const long = await write(sid, typed.repeat(400));
    expect(long.status).toBe(400);
    expect(long.raw).not.toContain(typed);
    expect((await close(sid)).status).toBe(204);

    const tables = (await dbClient.db.execute(
      sql.raw("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"),
    )).rows as Array<{ table_name: string }>;
    let dump = "";
    for (const { table_name: t } of tables) {
      dump += JSON.stringify((await dbClient.db.execute(sql.raw(`SELECT x::text AS t FROM "${t}" x`))).rows);
    }
    expect(dump).toContain(sid);
    expect(dump).not.toContain(typed);
    expect(dump).not.toContain(printed);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(typed);
    expect(logged).not.toContain(printed);
    const source = readFileSync(new URL("../src/terminal/admin-terminal.service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/console\.|logger/i);
  });
});
