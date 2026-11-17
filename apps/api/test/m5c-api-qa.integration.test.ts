import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  adminTerminalSessions,
  auditEvents,
  createDatabaseClient,
  eq,
  hostingAdminScopes,
  memberships,
  membershipRoles,
  operations,
  operationSteps,
  outboxEvents,
  platformInstallations,
  serviceInstances,
  sql,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { ExecutorCodedError, InMemoryDockerSimulatorAdapter, type TerminalLimits } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { AdminTerminalService } from "../src/terminal/admin-terminal.service.js";

const KEY = Buffer.alloc(32, 5);
const PW = "sentinel-qa-pass-0005";
const SETUP = { installationName: "QA", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const WP_PASSWORD = "sentinel-Wp-Secret-778899";
const ENGINE_TEXT = "SENTINEL_ENGINE_TEXT no such container 4f2a9c /var/lib/docker/x";
const step = () => Math.floor(Date.now() / 30_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Res = { status: number; body: Json; raw: string };

describe("M5c QA: the API of the terminal and of Restart", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let calls: { name: string; args: unknown[] }[];
  const admins: Record<"a" | "b", { id: string; secret: string; token: string }> = {} as never;
  let orgId: string;
  let ownerId: string;
  let ownerToken: string;

  async function login(email: string, password: string, secret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, ...(secret ? { totpCode: totpCodeAt(secret, step()) } : {}) }),
    });
    const body = (await res.json()) as Json;
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.data.accessToken as string;
  }

  async function call(method: string, path: string, as: string | null, body?: unknown, key: string | null = randomUUID()): Promise<Res> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  /** App on the simulator behind a port that records every call with its arguments. */
  async function start(limits: Partial<TerminalLimits> = {}): Promise<void> {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const a = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    const b = await createServerAdmin(dbClient.db, KEY, { email: "admin2@example.test", name: "Admin Two", password: PW });
    sim = new InMemoryDockerSimulatorAdapter({ terminalLimits: { readWaitMs: 100, ...limits } });
    calls = [];
    const port = new Proxy(sim, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls.push({ name: String(p), args });
          return (v as (...x: unknown[]) => unknown).apply(t, args);
        };
      },
    }) as DockerExecutorPort;
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: port,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      terminalSweepIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    admins.a = { id: a.userId, secret: a.totpSecretBase32, token: await login("admin@example.test", PW, a.totpSecretBase32) };
    admins.b = { id: b.userId, secret: b.totpSecretBase32, token: await login("admin2@example.test", PW, b.totpSecretBase32) };
    const created = await call("POST", "/v1/admin/customer-account", admins.a.token, {
      organizationName: "Customer A",
      ownerEmail: "owner@example.test",
      ownerName: "Owner A",
    });
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    ownerId = created.body.data.userId as string;
    ownerToken = await login("owner@example.test", created.body.data.temporaryPassword as string);
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  const run = () => app.outboxWorker.processPendingOnce();
  const sweep = (now = new Date()) => app.nestApp.get(AdminTerminalService).sweepOnce(now);
  const org = (p: string) => `/v1/organizations/${orgId}${p}`;
  const named = (name: string) => calls.filter((c) => c.name === name);
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const openRows = async () => (await dbClient.db.select().from(adminTerminalSessions)).filter((r) => r.closedAt === null);
  const row = async (id: string) => (await dbClient.db.select().from(adminTerminalSessions).where(eq(adminTerminalSessions.id, id)))[0]!;
  const webService = async (siteId: string) => (await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId)))[0]!;
  const opOf = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;

  /** A customer-owned site, provisioned. */
  async function createSite(n = "a"): Promise<string> {
    const res = await call("POST", org("/managed-sites"), ownerToken, {
      name: `Site ${n}`,
      domain: `wp-${n}.example.test`,
      title: `Site ${n}`,
      adminUser: "siteadmin",
      adminEmail: `wp-${n}@example.test`,
      adminPassword: WP_PASSWORD,
    });
    expect(res.status, res.raw).toBe(202);
    await run();
    return res.body.data.siteId as string;
  }

  /** A code of the current step for this administrator, made usable by forgetting the last used step. */
  async function freshCode(who: "a" | "b"): Promise<string> {
    await dbClient.db.update(users).set({ totpLastStep: null }).where(eq(users.id, admins[who].id));
    return totpCodeAt(admins[who].secret, step());
  }

  const open = async (siteId: string, who: "a" | "b" = "a") =>
    call("POST", `/v1/admin/sites/${siteId}/terminal`, admins[who].token, { code: await freshCode(who) });
  const write = (sid: string, input: string, who: "a" | "b" = "a") => call("POST", `/v1/admin/terminal/${sid}/write`, admins[who].token, { input });
  const read = (sid: string, cursor: unknown, who: "a" | "b" = "a") => call("POST", `/v1/admin/terminal/${sid}/read`, admins[who].token, { cursor });
  const close = (sid: string, who: "a" | "b" = "a") => call("POST", `/v1/admin/terminal/${sid}/close`, admins[who].token);
  const opened = async (siteId: string, who: "a" | "b" = "a") => {
    const res = await open(siteId, who);
    expect(res.status, res.raw).toBe(201);
    return res.body.data.sessionId as string;
  };

  /** Exactly one open row, one close row with this reason and a duration not negative, and the session row closed. */
  async function expectEndedOnce(sid: string, reason: string): Promise<void> {
    const mine = (rows: Array<{ details: unknown }>) => rows.filter((a) => (a.details as Json).sessionId === sid);
    expect(mine(await audits("admin.terminal.open")), `${reason}: open rows`).toHaveLength(1);
    const closes = mine(await audits("admin.terminal.close"));
    expect(closes, `${reason}: close rows`).toHaveLength(1);
    expect((closes[0]!.details as Json).reason).toBe(reason);
    const duration = (closes[0]!.details as Json).durationSeconds as number;
    expect(Number.isInteger(duration) && duration >= 0, `${reason}: duration ${duration}`).toBe(true);
    const r = await row(sid);
    expect(r.closeReason).toBe(reason);
    expect(r.closedAt).not.toBeNull();
  }

  /** Content hash of every table but the audit log. */
  async function snapshot(): Promise<Record<string, string>> {
    const tables = (await dbClient.db.execute(
      sql.raw("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"),
    )).rows as Array<{ table_name: string }>;
    const out: Record<string, string> = {};
    for (const { table_name: t } of tables) {
      if (t === "audit_events") continue;
      const [r] = (await dbClient.db.execute(
        sql.raw(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM "${t}" x`),
      )).rows as Array<{ h: string }>;
      out[t] = r!.h;
    }
    return out;
  }

  /** Every row of every table as text. */
  async function dumpAll(): Promise<string> {
    const tables = (await dbClient.db.execute(
      sql.raw("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"),
    )).rows as Array<{ table_name: string }>;
    let dump = "";
    for (const { table_name: t } of tables) dump += JSON.stringify((await dbClient.db.execute(sql.raw(`SELECT x::text AS t FROM "${t}" x`))).rows);
    return dump;
  }

  describe("point 1: the seven routes are for the server's administrator only", () => {
    it("member, owner and a hosting admin without the server role get 403 and one denied row on each, nothing changes, no executor call; no session gets 401", async () => {
      await start();
      const siteId = await createSite();
      const sid = await opened(siteId);
      const [op] = await dbClient.db.select().from(operations).limit(1);
      await app.driftReconciler.reconcileAllOnce();

      // A member of the customer's organization.
      const memberId = `usr_${randomUUID()}`;
      const membershipId = `mem_${randomUUID()}`;
      await dbClient.db.insert(users).values({ id: memberId, email: "member@example.test", name: "Member", passwordHash: await hashPassword(PW) });
      await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId: memberId });
      await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
      // A support user: hosting admin of every organization, no server role.
      const supportId = `usr_${randomUUID()}`;
      const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
      await dbClient.db.insert(users).values({ id: supportId, email: "support@example.test", name: "Support", passwordHash: await hashPassword(PW) });
      await dbClient.db.insert(hostingAdminScopes).values({ id: `has_${randomUUID()}`, userId: supportId, organizationId: null, installationId: inst!.id });
      const personas = [
        { who: "member", id: memberId, token: await login("member@example.test", PW) },
        { who: "owner", id: ownerId, token: ownerToken },
        { who: "support", id: supportId, token: await login("support@example.test", PW) },
      ];

      const ROUTES: Array<[string, string, unknown]> = [
        ["POST", `/v1/admin/sites/${siteId}/terminal`, { code: "123456" }],
        ["POST", `/v1/admin/terminal/${sid}/write`, { input: "id\n" }],
        ["POST", `/v1/admin/terminal/${sid}/read`, { cursor: 0 }],
        ["POST", `/v1/admin/terminal/${sid}/close`, undefined],
        ["POST", `/v1/admin/sites/${siteId}/restart`, { reason: "sentinel reason" }],
        ["POST", "/v1/admin/panel-containers/shared_database/restart", { reason: "sentinel reason" }],
        ["GET", `/v1/admin/operations/${op!.id}`, undefined],
      ];
      const before = await snapshot();
      calls.length = 0;
      const failures: string[] = [];
      for (const p of personas) {
        for (const [method, path, body] of ROUTES) {
          const seen = new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
          const res = await call(method, path, p.token, body);
          const added = (await dbClient.db.select().from(auditEvents)).filter((r) => !seen.has(r.id));
          const ok =
            res.status === 403 &&
            res.body.error?.code === "PERMISSION_DENIED" &&
            added.length === 1 &&
            added[0]!.actorId === p.id &&
            (added[0]!.details as Json).outcome === "denied";
          if (!ok) failures.push(`${method} ${path} as ${p.who}: ${res.status} ${res.body.error?.code ?? ""} audit+${added.length}`);
        }
      }
      for (const [method, path, body] of ROUTES) {
        const res = await call(method, path, null, body);
        if (res.status !== 401) failures.push(`${method} ${path} without session: ${res.status}`);
      }
      expect(failures).toEqual([]);
      expect(calls.map((c) => c.name)).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect((await row(sid)).closedAt).toBeNull();

      // The shipped walk finds all seven by itself and has a value for both new parameters.
      const walk = readFileSync(new URL("./admin-route-guard.integration.test.ts", import.meta.url), "utf8");
      expect(walk).toMatch(/sessionId:\s*`term_/);
      expect(walk).toMatch(/operationId:\s*`op_/);
      const GUARDED = /^\/v1\/(admin(\/|$)|hosts(\/|$)|allocations(\/|$))/;
      expect(walk).toContain(GUARDED.source);
    });
  });

  describe("point 2: a terminal opens only after a fresh code", () => {
    it("refuses the code the login just spent and the code of the step before the last, with zero executor calls and no row", async () => {
      await start();
      const siteId = await createSite();
      const path = `/v1/admin/sites/${siteId}/terminal`;
      // The login a moment before spends the current step.
      await dbClient.db.update(users).set({ totpLastStep: null }).where(eq(users.id, admins.a.id));
      const code = totpCodeAt(admins.a.secret, step());
      const token = await login("admin@example.test", PW, admins.a.secret);
      calls.length = 0;
      const reused = await call("POST", path, token, { code });
      expect([reused.status, reused.body.error?.code]).toEqual([401, "TOTP_INVALID"]);
      // A code of the step before the last used one.
      await dbClient.db.update(users).set({ totpLastStep: step() }).where(eq(users.id, admins.a.id));
      const older = await call("POST", path, token, { code: totpCodeAt(admins.a.secret, step() - 1) });
      expect([older.status, older.body.error?.code]).toEqual([401, "TOTP_INVALID"]);
      expect(named("openTerminal")).toEqual([]);
      expect(await dbClient.db.select().from(adminTerminalSessions)).toEqual([]);
      const denied = await audits("admin.terminal.denied");
      expect(denied).toHaveLength(2);
      for (const d of denied) expect(["code_used", "code_wrong"]).toContain((d.details as Json).reason);
    });

    it("a site being removed refuses without spending the code", async () => {
      await start();
      const siteId = await createSite();
      const code = totpCodeAt(admins.a.secret, step() + 1);
      const before = (await dbClient.db.select().from(users).where(eq(users.id, admins.a.id)))[0]!;
      const del = await call("DELETE", org(`/managed-sites/${siteId}`), ownerToken, { confirmName: "Site a" });
      expect(del.status, del.raw).toBe(202);
      const res = await call("POST", `/v1/admin/sites/${siteId}/terminal`, admins.a.token, { code });
      expect([res.status, res.body.error?.details?.[0]?.reason]).toEqual([409, "site_changing"]);
      const after = (await dbClient.db.select().from(users).where(eq(users.id, admins.a.id)))[0]!;
      expect(after.totpLastStep).toBe(before.totpLastStep);
      expect(named("openTerminal")).toEqual([]);
    });
  });

  describe("point 3: one open row and one close row for each way a session ends", () => {
    it("closed, shell exit, container stopped, restarted, deployed again and deleted, executor restarted, executor not answering", async () => {
      await start();
      const siteId = await createSite();
      const svc = await webService(siteId);
      const ended: Array<[string, string]> = [];

      // 1. Closed by its administrator, then closed again.
      let sid = await opened(siteId);
      expect((await close(sid)).status).toBe(204);
      expect((await close(sid)).status).toBe(204);
      ended.push([sid, "closed"]);

      // 2. Ctrl-D, nobody reads: the pass closes it.
      sid = await opened(siteId);
      expect((await write(sid, "\u0004")).status).toBe(204);
      await sleep(50);
      await sweep();
      ended.push([sid, "shell_exited"]);

      // 5. The owner stops the site.
      sid = await opened(siteId);
      expect((await call("POST", org(`/managed-sites/${siteId}/actions`), ownerToken, { action: "stop" })).status).toBe(202);
      await run();
      await sweep();
      ended.push([sid, "container_gone"]);
      expect((await call("POST", org(`/managed-sites/${siteId}/actions`), ownerToken, { action: "start" })).status).toBe(202);
      await run();

      // 5. The administrator restarts it.
      sid = await opened(siteId);
      expect((await call("POST", `/v1/admin/sites/${siteId}/restart`, admins.a.token, { reason: "sentinel reason" })).status).toBe(202);
      await run();
      await sweep();
      ended.push([sid, "container_gone"]);

      // 5. Deployed again (a new PHP version).
      sid = await opened(siteId);
      const php = await call("PATCH", org(`/managed-sites/${siteId}/runtime`), ownerToken, { phpVersion: "8.3" });
      expect(php.status, php.raw).toBe(202);
      await run();
      await sweep();
      ended.push([sid, "container_gone"]);

      // 6. The executor restarted and forgot it: closed after the grace.
      sid = await opened(siteId);
      sim.forgetTerminalSessions();
      await sweep();
      expect((await row(sid)).closedAt).toBeNull();
      await sweep(new Date(Date.now() + 61_000));
      ended.push([sid, "executor_gone"]);

      // 7. The executor does not answer: nothing closes; once back, the ended record closes it.
      sid = await opened(siteId);
      sim.setEngineReachable(false);
      await sweep(new Date(Date.now() + 120_000));
      expect((await row(sid)).closedAt).toBeNull();
      sim.setEngineReachable(true);
      await sim.stopService(svc.id);
      await sweep();
      ended.push([sid, "container_gone"]);
      await sim.restartService(svc.id);

      // 5. The site is deleted.
      sid = await opened(siteId);
      const del = await call("DELETE", org(`/managed-sites/${siteId}`), ownerToken, { confirmName: "Site a" });
      expect(del.status, del.raw).toBe(202);
      await run();
      await sweep();
      ended.push([sid, "container_gone"]);

      for (const [id, reason] of ended) await expectEndedOnce(id, reason);
      // A second pass and late closes write nothing more.
      await sweep(new Date(Date.now() + 120_000));
      for (const [id] of ended) expect((await close(id)).status).toBe(204);
      expect(await audits("admin.terminal.close")).toHaveLength(ended.length);
      expect(await audits("admin.terminal.open")).toHaveLength(ended.length);
      expect(await openRows()).toEqual([]);
    });

    it("the silence limit ends a session as idle", async () => {
      await start({ idleMs: 300 });
      const sid = await opened(await createSite());
      await sleep(600);
      await sweep();
      await expectEndedOnce(sid, "idle");
    });

    it("the session limit ends a session as time_limit, even while it is read", async () => {
      await start({ sessionMaxMs: 500 });
      const sid = await opened(await createSite());
      let cursor = 0;
      let end: Json | null = null;
      for (let i = 0; i < 20 && !end; i++) {
        const r = await read(sid, cursor);
        cursor = r.body.data.cursor as number;
        end = r.body.data.ended as Json | null;
      }
      expect(end).toMatchObject({ reason: "time_limit" });
      await sweep();
      await expectEndedOnce(sid, "time_limit");
    });
  });

  describe("point 4: the limits", () => {
    it("a second session on a site is refused also for another administrator, the fifth on the server too", async () => {
      await start();
      const siteIds = [];
      for (const n of ["a", "b", "c", "d", "e"]) siteIds.push(await createSite(n));
      await opened(siteIds[0]!, "a");
      const busy = await open(siteIds[0]!, "b");
      expect([busy.status, busy.body.error?.details?.[0]?.reason]).toEqual([409, "site_busy"]);
      for (const s of siteIds.slice(1, 4)) await opened(s, "b");
      calls.length = 0;
      const full = await open(siteIds[4]!, "a");
      expect([full.status, full.body.error?.details?.[0]?.reason]).toEqual([409, "server_full"]);
      expect(named("openTerminal")).toEqual([]);
      expect(await openRows()).toHaveLength(4);
      expect(await audits("admin.terminal.open")).toHaveLength(4);
    });

    it("two opens at the same moment on one site give one session (three rounds)", async () => {
      await start();
      const siteId = await createSite();
      for (let round = 0; round < 3; round++) {
        const [ca, cb] = [await freshCode("a"), await freshCode("b")];
        const path = `/v1/admin/sites/${siteId}/terminal`;
        const [ra, rb] = await Promise.all([call("POST", path, admins.a.token, { code: ca }), call("POST", path, admins.b.token, { code: cb })]);
        expect([ra.status, rb.status].sort(), `round ${round}`).toEqual([201, 409]);
        expect(await openRows()).toHaveLength(1);
        expect((await sim.listTerminals()).filter((r) => !r.ended)).toHaveLength(1);
        const [winner, who] = ra.status === 201 ? [ra, "a" as const] : [rb, "b" as const];
        expect((await close(winner.body.data.sessionId as string, who)).status).toBe(204);
      }
      expect(await audits("admin.terminal.open")).toHaveLength(3);
      expect(await audits("admin.terminal.close")).toHaveLength(3);
    });

    it("a session that ended by itself frees its place at the latest after one pass", async () => {
      await start();
      const siteId = await createSite();
      const sid = await opened(siteId);
      expect((await write(sid, "exit\n")).status).toBe(204);
      await sleep(50);
      await sweep();
      expect((await open(siteId)).status).toBe(201);
      await expectEndedOnce(sid, "shell_exited");
    });

    it("input is limited to 4096 bytes, not characters, and the cursor must be a whole number not below zero", async () => {
      await start();
      const sid = await opened(await createSite());
      const euro = "€".repeat(1365); // 4095 bytes, 1365 characters
      expect((await write(sid, "a".repeat(4096))).status).toBe(204);
      expect((await write(sid, `${euro}a`)).status).toBe(204);
      calls.length = 0;
      for (const input of ["a".repeat(4097), `${euro}ab`]) {
        const res = await write(sid, input);
        expect([res.status, res.body.error?.code]).toEqual([400, "VALIDATION_ERROR"]);
      }
      for (const cursor of [-1, 1.5, "0", null]) {
        const res = await read(sid, cursor);
        expect([res.status, res.body.error?.code], `cursor ${String(cursor)}`).toEqual([400, "VALIDATION_ERROR"]);
      }
      expect(calls.filter((c) => c.name === "writeTerminal" || c.name === "readTerminal")).toEqual([]);
    });
  });

  describe("point 5: one administrator never reaches another's session", () => {
    it("write, read and close answer the same 404 as a session that does not exist, and touch nothing", async () => {
      await start();
      const sid = await opened(await createSite());
      const ghost = `term_${randomBytes(16).toString("hex")}`;
      calls.length = 0;
      for (const [mine, none] of [
        [await write(sid, "id\n", "b"), await write(ghost, "id\n", "b")],
        [await read(sid, 0, "b"), await read(ghost, 0, "b")],
        [await close(sid, "b"), await close(ghost, "b")],
      ] as const) {
        expect(mine.status).toBe(404);
        expect({ ...mine.body.error, requestId: null }).toEqual({ ...none.body.error, requestId: null });
      }
      expect(calls.map((c) => c.name)).toEqual([]);
      expect((await row(sid)).closedAt).toBeNull();
      expect(await audits("admin.terminal.close")).toEqual([]);
    });
  });

  describe("point 6: what is typed and printed is stored nowhere", () => {
    it("the canary goes through the read, and is in no table, no audit row, no console or stdout call, no error", async () => {
      await start();
      const siteId = await createSite();
      const hex = randomBytes(8).toString("hex");
      const typed = `HPCANARY_IN_${hex}`;
      const printed = `HPCANARY_OUT_${hex}`;
      const spies = [
        ...(["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m)),
        vi.spyOn(process.stdout, "write"),
        vi.spyOn(process.stderr, "write"),
      ];
      const sid = await opened(siteId);
      expect((await write(sid, `echo ${typed}\n`)).status).toBe(204);
      sim.emitTerminalOutput(sid, `${printed}\r\n`);
      let text = "";
      let cursor = 0;
      for (let i = 0; i < 40 && !(text.includes(`${typed}\r\n`) && text.includes(printed)); i++) {
        const r = await read(sid, cursor);
        text += r.body.data.output as string;
        cursor = r.body.data.cursor as number;
      }
      // Proof the canary really went through the API.
      expect(text).toContain(`${typed}\r\n`);
      expect(text).toContain(printed);
      // 4097 bytes holding the canary: refused with an error that does not hold it.
      const long = await write(sid, `echo ${typed}`.padEnd(4097, "x"));
      expect(long.status).toBe(400);
      expect(long.raw).not.toContain(typed);
      expect(long.raw).not.toContain("HPCANARY");
      expect((await close(sid)).status).toBe(204);

      const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls.map((c) => c.map((x) => String(x)))));
      expect(logged).not.toContain(typed);
      expect(logged).not.toContain(printed);
      const auditText = JSON.stringify(await dbClient.db.select().from(auditEvents));
      const opText = JSON.stringify([await dbClient.db.select().from(operations), await dbClient.db.select().from(operationSteps), await dbClient.db.select().from(outboxEvents)]);
      const rowText = JSON.stringify(await row(sid));
      const dump = await dumpAll();
      expect(dump).toContain(sid);
      for (const [where, t] of [["audit", auditText], ["operations", opText], ["session row", rowText], ["database", dump]] as const) {
        expect(t, where).not.toContain(typed);
        expect(t, where).not.toContain(printed);
      }
    });
  });

  describe("point 7: Restart acts on exactly what was named, with a reason", () => {
    it("a site restart restarts that site's service only and keeps the reason word for word in the audit row only", async () => {
      await start();
      const a = await createSite("a");
      const b = await createSite("b");
      const [svcA, svcB] = [await webService(a), await webService(b)];
      const reason = "Sentinel  reason: disco pieno, riavvio è urgente";
      calls.length = 0;
      const res = await call("POST", `/v1/admin/sites/${a}/restart`, admins.a.token, { reason });
      expect(res.status).toBe(202);
      await run();
      expect((await opOf(res.body.data.operationId as string)).status).toBe("succeeded");
      expect(named("restartService").map((c) => c.args)).toEqual([[svcA.id]]);
      expect(calls.some((c) => JSON.stringify(c.args).includes(svcB.id))).toBe(false);
      const [audit] = await audits("admin.site.restart");
      expect((audit!.details as Json).reason).toBe(reason);
      const opText = JSON.stringify([await dbClient.db.select().from(operations), await dbClient.db.select().from(operationSteps), await dbClient.db.select().from(outboxEvents)]);
      expect(opText).not.toContain("disco pieno");
    });

    it("a panel restart reaches the executor with exactly the named part; a name outside the five or a bad reason never does", async () => {
      await start();
      await app.driftReconciler.reconcileAllOnce();
      const opsBefore = (await dbClient.db.select().from(operations)).length;
      calls.length = 0;
      for (const name of ["site_web", "INGRESS_PROXY", "docker", "ingress_proxy%20", "shared_database.."]) {
        const res = await call("POST", `/v1/admin/panel-containers/${name}/restart`, admins.a.token, { reason: "sentinel reason" });
        expect(res.status, name).toBe(400);
      }
      for (const body of [{}, { reason: "    " }, { reason: "x".repeat(501) }]) {
        const res = await call("POST", "/v1/admin/panel-containers/shared_database/restart", admins.a.token, body);
        expect([res.status, res.body.error?.code]).toEqual([400, "VALIDATION_ERROR"]);
      }
      expect((await dbClient.db.select().from(operations)).length).toBe(opsBefore);
      expect(await audits("admin.panel_container.restart")).toEqual([]);

      const auditBefore = new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
      const res = await call("POST", "/v1/admin/panel-containers/shared_database/restart", admins.a.token, { reason: "sentinel reason" });
      expect(res.status).toBe(202);
      await dbClient.db.update(operations).set({ submittedAt: new Date(Date.now() - 3_000) }).where(eq(operations.id, res.body.data.operationId as string));
      await run();
      expect((await opOf(res.body.data.operationId as string)).status).toBe("succeeded");
      expect(named("restartPanelContainer").map((c) => c.args)).toEqual([[{ component: "shared_database" }]]);
      const added = (await dbClient.db.select().from(auditEvents)).filter((r) => !auditBefore.has(r.id));
      expect(added.map((r) => r.action).sort()).toEqual(["admin.panel_container.restart", "admin.panel_container.restart.end"]);
      const alerts = await call("GET", "/v1/admin/alerts", admins.a.token);
      expect((alerts.body.data as Json[]).filter((x) => x.kind === "component_down")).toEqual([]);
    });

    it("an administrator's restart of a site being removed answers 409 and queues nothing", async () => {
      await start();
      const siteId = await createSite();
      const del = await call("DELETE", org(`/managed-sites/${siteId}`), ownerToken, { confirmName: "Site a" });
      expect(del.status).toBe(202);
      const res = await call("POST", `/v1/admin/sites/${siteId}/restart`, admins.a.token, { reason: "sentinel reason" });
      expect([res.status, res.body.error?.code]).toEqual([409, "RESOURCE_LOCKED"]);
      expect(await dbClient.db.select().from(operations).where(eq(operations.kind, "service.restart"))).toEqual([]);
      expect(await audits("admin.site.restart")).toEqual([]);
    });
  });

  describe("point 8: a stopped site", () => {
    it("Stop, Start, the administrator's Restart, Stop, and Restart again: every view and the wanted state follow", async () => {
      await start();
      const siteId = await createSite();
      const svcId = (await webService(siteId)).id;
      const statuses = async () => [
        (await call("GET", org(`/managed-sites/${siteId}`), ownerToken)).body.data.status,
        (await call("GET", "/v1/admin/sites", admins.a.token)).body.data.sites.find((s: Json) => s.id === siteId).status,
        (await call("GET", org("/sites"), ownerToken)).body.data.find((s: Json) => s.id === siteId).status,
        (await call("GET", org(`/sites/${siteId}`), ownerToken)).body.data.status,
      ];
      const state = async () => [(await webService(siteId)).desiredStatus, sim.getSimulatedContainerInspect(svcId)?.State?.Running];
      const act = async (action: string) => {
        expect((await call("POST", org(`/managed-sites/${siteId}/actions`), ownerToken, { action })).status).toBe(202);
        await run();
      };
      const adminRestart = async () => {
        const res = await call("POST", `/v1/admin/sites/${siteId}/restart`, admins.a.token, { reason: "sentinel reason" });
        expect(res.status).toBe(202);
        await run();
        expect((await opOf(res.body.data.operationId as string)).status).toBe("succeeded");
      };

      await act("stop");
      expect([await statuses(), await state()]).toEqual([Array(4).fill("stopped"), ["stopped", false]]);
      await act("start");
      expect([await statuses(), await state()]).toEqual([Array(4).fill("ready"), ["running", true]]);
      await adminRestart();
      expect([await statuses(), await state()]).toEqual([Array(4).fill("ready"), ["running", true]]);
      await act("stop");
      expect([await statuses(), await state()]).toEqual([Array(4).fill("stopped"), ["stopped", false]]);
      // R192 2.3: the administrator's Restart overrides the owner's Stop and is audited with its reason.
      await adminRestart();
      expect([await statuses(), await state()]).toEqual([Array(4).fill("ready"), ["running", true]]);
      expect((await audits("admin.site.restart")).map((r) => (r.details as Json).reason)).toEqual(["sentinel reason", "sentinel reason"]);
    });
  });

  describe("point 8: Restart of a site whose provisioning failed", () => {
    it("creates no container", async () => {
      await start();
      const deploy = vi.spyOn(sim, "deployService").mockRejectedValue(new ExecutorCodedError(ENGINE_TEXT, "INTERNAL_ERROR"));
      const siteId = await createSite();
      deploy.mockRestore();
      expect((await dbClient.db.select().from(operations).where(eq(operations.kind, "site.provision")))[0]!.status).toBe("failed");
      calls.length = 0;
      const res = await call("POST", `/v1/admin/sites/${siteId}/restart`, admins.a.token, { reason: "sentinel reason" });
      expect(res.status).toBe(202);
      await run();
      expect(named("deployService")).toEqual([]);
      const svc = await webService(siteId);
      if (svc) expect(sim.getSimulatedContainerInspect(svc.id)?.State?.Running ?? false).toBe(false);
    });
  });

  describe("point 9: the read of an operation", () => {
    it("shows any operation to an administrator, none to a customer, and holds no reason, secret or executor text", async () => {
      await start();
      const siteId = await createSite();
      const provision = (await dbClient.db.select().from(operations).where(eq(operations.kind, "site.provision")))[0]!;
      vi.spyOn(sim, "restartService").mockRejectedValueOnce(new ExecutorCodedError(ENGINE_TEXT, "INTERNAL_ERROR"));
      const res = await call("POST", `/v1/admin/sites/${siteId}/restart`, admins.a.token, { reason: "sentinel-reason-QA9" });
      expect(res.status).toBe(202);
      await run();
      const failedId = res.body.data.operationId as string;
      expect((await opOf(failedId)).status).not.toBe("succeeded");

      for (const id of [provision.id, failedId]) {
        const read = await call("GET", `/v1/admin/operations/${id}`, admins.a.token);
        expect(read.status).toBe(200);
        expect(read.body.data.id).toBe(id);
        for (const leak of ["sentinel-reason-QA9", WP_PASSWORD, "SENTINEL_ENGINE_TEXT", "/var/lib/docker", "4f2a9c"]) expect(read.raw, leak).not.toContain(leak);
        // The customer's own operation is still refused on the administrator's route.
        expect((await call("GET", `/v1/admin/operations/${id}`, ownerToken)).status).toBe(403);
      }
      expect((await call("GET", `/v1/admin/operations/op_${randomUUID()}`, admins.a.token)).status).toBe(404);
    });
  });
});
