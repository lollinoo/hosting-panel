import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  encryptSecretAesGcm,
  eq,
  sql,
  userSessions,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin } from "../src/cli/accounts.js";

// QA for #8 (decisions D3, D4): while users.mustChangePassword is true only GET /v1/me, POST /v1/me/password
// and POST /v1/auth/revoke answer; everything else is 403 PASSWORD_CHANGE_REQUIRED with no audit row.
const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const NEW_PW = "another long passphrase";
const ADMIN_PW = "sentinel-admin-pass-0001";
const OPEN = new Set([
  "GET /health/live",
  "GET /health/ready",
  "POST /v1/auth/login",
  "POST /v1/auth/password-reset/request",
  "POST /v1/auth/password-reset/confirm",
  "GET /v1/dev/auth/personas",
  "POST /v1/dev/auth/token",
]);
const EXEMPT = new Set(["GET /v1/me", "POST /v1/me/password", "POST /v1/auth/revoke"]);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Route = { method: string; path: string };

/** Routes of the running app, parsed from Fastify's printRoutes tree (HEAD and OPTIONS dropped). */
function listRoutes(tree: string): Route[] {
  const stack: string[] = [];
  const out: Route[] = [];
  for (const line of tree.split("\n")) {
    const m = /^((?:│ {3}| {4})*)[├└]── (\S+)(?: \(([^)]*)\))?/.exec(line);
    if (!m) continue;
    stack.length = m[1]!.length / 4;
    stack.push(m[2]!);
    for (const method of (m[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (method !== "HEAD" && method !== "OPTIONS") out.push({ method, path: stack.join("") });
    }
  }
  return out;
}

describe("password change guard (#8)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let passwordHash: string;
  let adminId: string;
  let adminToken: string;
  let routes: Route[];

  beforeAll(async () => {
    passwordHash = await hashPassword(PW);
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: ADMIN_PW });
    adminId = admin.userId;
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: new InMemoryDockerSimulatorAdapter(),
      enableDevOidc: true,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    routes = listRoutes(app.fastify.printRoutes({ commonPrefix: false }));
    // One sign-in only: a TOTP step can be used once.
    adminToken = (await login("admin@example.test", ADMIN_PW, admin.totpSecretBase32)).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
    });
    const raw = await res.text();
    return { status: res.status, body: (raw ? JSON.parse(raw) : {}) as Json };
  };
  const login = async (email: string, password: string, totpSecret?: string) => {
    const res = await call(null, "POST", "/v1/auth/login", {
      email,
      password,
      ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as { accessToken: string; mustChangePassword: boolean };
  };
  const setFlag = (id: string, mustChangePassword: boolean) =>
    dbClient.db.update(users).set({ mustChangePassword }).where(eq(users.id, id));
  const expectRefused = (res: { status: number; body: Json }, what: string) => {
    expect({ what, status: res.status, code: res.body.error?.code }).toEqual({ what, status: 403, code: "PASSWORD_CHANGE_REQUIRED" });
  };

  /** A customer-style user (no organization needed: the guard runs before the principal is used). */
  async function seed(opts: { totp?: "enabled" | "pending"; mustChange?: boolean } = {}) {
    const id = `usr_${randomUUID()}`;
    const email = `${id}@example.test`;
    let totp = {};
    let secret: string | undefined;
    if (opts.totp) {
      secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
      const env = encryptSecretAesGcm({ plaintext: secret, masterKey: KEY, organizationId: "platform", siteId: null, secretKey: `totp:${id}` });
      totp = {
        totpCiphertextBase64: env.ciphertextBase64,
        totpIvBase64: env.ivBase64,
        totpAuthTagBase64: env.authTagBase64,
        ...(opts.totp === "enabled" ? { totpEnabledAt: new Date() } : {}),
      };
    }
    await dbClient.db.insert(users).values({ id, email, name: id, passwordHash, mustChangePassword: opts.mustChange ?? true, ...totp });
    return { id, email, secret };
  }

  const userRow = async (id: string) => (await dbClient.db.select().from(users).where(eq(users.id, id)))[0]!;
  const auditIds = async () => new Set((await dbClient.db.select({ id: auditEvents.id }).from(auditEvents)).map((r) => r.id));
  const auditSince = async (seen: Set<string>) => (await dbClient.db.select().from(auditEvents)).filter((r) => !seen.has(r.id));

  /** Content hash of every table but the audit log, so any write a refused call made shows up. */
  async function snapshot(): Promise<Record<string, string>> {
    const tables = (await dbClient.db.execute(
      sql.raw("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1"),
    )).rows as Array<{ table_name: string }>;
    const out: Record<string, string> = {};
    for (const { table_name: t } of tables) {
      if (t === "audit_events") continue;
      const [row] = (await dbClient.db.execute(
        sql.raw(`SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM "${t}" x`),
      )).rows as Array<{ h: string }>;
      out[t] = row!.h;
    }
    return out;
  }

  it("the same token works on guarded routes right after the change, and a failed change keeps the flag", async () => {
    const u = await seed({ totp: "pending" });
    const token = (await login(u.email, PW)).accessToken;
    expectRefused(await call(token, "PATCH", "/v1/me/locale", { locale: "en" }), "before");

    // A wrong current password and a too-short new password both leave the session flagged.
    expect((await call(token, "POST", "/v1/me/password", { currentPassword: "nope nope nope", newPassword: NEW_PW })).status).toBe(401);
    expect((await call(token, "POST", "/v1/me/password", { currentPassword: PW, newPassword: "short" })).status).toBe(400);
    expect((await userRow(u.id)).mustChangePassword).toBe(true);
    expect((await userRow(u.id)).passwordHash).toBe(passwordHash);
    expectRefused(await call(token, "PATCH", "/v1/me/locale", { locale: "en" }), "after failed changes");

    expect((await call(token, "POST", "/v1/me/password", { currentPassword: PW, newPassword: NEW_PW })).status).toBe(204);
    // No new sign-in: the very same token now passes a mutating route and the TOTP routes.
    expect((await call(token, "PATCH", "/v1/me/locale", { locale: "en" })).status).toBe(204);
    expect((await userRow(u.id)).locale).toBe("en");
    expect((await call(token, "GET", "/v1/me/organizations")).status).toBe(200);
    expect((await call(token, "POST", "/v1/me/totp/enable", { code: "000000" })).status).toBe(401);
    expect((await call(token, "GET", "/v1/me")).body.data.user.mustChangePassword).toBe(false);
  });

  it("organizations, locale and every TOTP route are refused and change nothing", async () => {
    const withTotp = await seed({ totp: "enabled" });
    const pending = await seed({ totp: "pending" });
    const plain = await seed();
    const tokens = { withTotp: (await login(withTotp.email, PW, withTotp.secret)).accessToken, pending: (await login(pending.email, PW)).accessToken, plain: (await login(plain.email, PW)).accessToken };
    // The step after the one the sign-in used, so the code is valid and not a replay.
    const code = (secret: string | undefined) => totpCodeAt(secret!, Math.floor(Date.now() / 30_000) + 1);
    const before = { rows: await Promise.all([withTotp, pending, plain].map((x) => userRow(x.id))), snapshot: await snapshot() };
    const seen = await auditIds();

    // The bodies are valid: without the guard, enable and disable would succeed.
    const attempts: Array<[string, string, string, unknown]> = [
      [tokens.plain, "GET", "/v1/me/organizations", undefined],
      [tokens.plain, "PATCH", "/v1/me/locale", { locale: "en" }],
      [tokens.plain, "POST", "/v1/me/totp/setup", undefined],
      [tokens.withTotp, "POST", "/v1/me/totp/setup", undefined],
      [tokens.pending, "POST", "/v1/me/totp/enable", { code: code(pending.secret) }],
      [tokens.withTotp, "POST", "/v1/me/totp/disable", { password: PW, code: code(withTotp.secret) }],
    ];
    for (const [token, method, path, body] of attempts) expectRefused(await call(token, method, path, body), `${method} ${path}`);

    const after = await Promise.all([withTotp, pending, plain].map((x) => userRow(x.id)));
    expect(after).toEqual(before.rows);
    expect(after[0]!.totpEnabledAt).not.toBeNull();
    expect(after[1]!.totpEnabledAt).toBeNull();
    expect(await snapshot()).toEqual(before.snapshot);
    // D3: no row at all, in particular no 'denied' one.
    expect(await auditSince(seen)).toEqual([]);
  });

  it("no route extends or refreshes a session, and every way to get a token still yields a flagged one", async () => {
    const tokenRoutes = routes
      .filter((r) => /\/auth\/|token|\/me\/(refresh|session)|\/sessions?\b/i.test(r.path))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(tokenRoutes).toEqual([...OPEN, "POST /v1/auth/revoke"].filter((k) => k !== "GET /health/live" && k !== "GET /health/ready").sort());

    const u = await seed();
    const first = await login(u.email, PW);
    expect(first.mustChangePassword).toBe(true);
    // A second sign-in and a dev-OIDC token (enabled here) are new sessions, not an escape from the flag.
    const second = (await login(u.email, PW)).accessToken;
    const dev = await call(null, "POST", "/v1/dev/auth/token", { userId: u.id });
    expect(dev.status).toBe(200);
    for (const token of [first.accessToken, second, dev.body.data.accessToken as string]) {
      expect((await call(token, "GET", "/v1/me")).body.data.user.mustChangePassword).toBe(true);
      expectRefused(await call(token, "GET", "/v1/me/organizations"), "minted token");
    }
    // Signing out is allowed; the revoked token is then dead, and a fresh sign-in is flagged again.
    expect((await call(first.accessToken, "POST", "/v1/auth/revoke")).status).toBe(200);
    expect((await call(first.accessToken, "GET", "/v1/me")).status).toBe(401);
    expectRefused(await call((await login(u.email, PW)).accessToken, "GET", "/v1/me/organizations"), "after sign out");
  });

  it("a flagged administrator is refused on every route but the three, whatever the route does (terminal, logs, backups, files, uploads)", async () => {
    const token = adminToken;
    expect((await call(token, "GET", "/v1/admin/users")).status).toBe(200);
    await setFlag(adminId, true);
    try {
      const before = await snapshot();
      const seen = await auditIds();
      const failures: string[] = [];
      let checked = 0;
      for (const r of routes) {
        const key = `${r.method} ${r.path}`;
        if (OPEN.has(key) || EXEMPT.has(key)) continue;
        const res = await call(token, r.method, r.path.replace(/:\w+/g, "x"), {});
        checked += 1;
        if (res.status !== 403 || res.body.error?.code !== "PASSWORD_CHANGE_REQUIRED") failures.push(`${key}: ${res.status} ${res.body.error?.code ?? ""}`);
      }
      expect(checked).toBeGreaterThan(100);
      // Surfaces that move bytes, not just JSON: each one must sit in that sweep.
      for (const [method, path] of [
        ["POST", "/v1/admin/sites/:siteId/terminal"],
        ["POST", "/v1/admin/terminal/:sessionId/write"],
        ["GET", "/v1/admin/logs/:component"],
        ["GET", "/v1/admin/sites/:siteId/logs"],
        ["GET", "/v1/admin/backups"],
        ["GET", "/v1/organizations/:orgId/managed-sites/:siteId/backups/:backupId/download"],
        ["PUT", "/v1/organizations/:orgId/managed-sites/:siteId/files/content"],
        ["GET", "/v1/organizations/:orgId/managed-sites/:siteId/files/content"],
        ["PUT", "/v1/organizations/:orgId/managed-sites/:siteId/wordpress/import/files/:slot"],
      ] as const) {
        expect(routes, `${method} ${path}`).toContainEqual({ method, path });
      }
      expect(failures).toEqual([]);
      expect(await snapshot()).toEqual(before);
      expect(await auditSince(seen)).toEqual([]);
      // The three exempt routes still answer.
      expect((await call(token, "GET", "/v1/me")).status).toBe(200);
    } finally {
      await setFlag(adminId, false);
    }
    expect((await call(token, "GET", "/v1/admin/users")).status).toBe(200);
  });

  it("a customer flagged by the administrator's password reset is refused until it changes the password", async () => {
    const u = await seed({ mustChange: false });
    const old = (await login(u.email, PW)).accessToken;
    expect((await call(old, "GET", "/v1/me/organizations")).status).toBe(200);

    const reset = await call(adminToken, "POST", `/v1/admin/users/${u.id}/reset-password`);
    expect(reset.status).toBe(200);
    const temporary = reset.body.data.temporaryPassword as string;
    expect((await userRow(u.id)).mustChangePassword).toBe(true);
    // The reset revokes the old session, so it cannot ride on the old unflagged state.
    expect((await call(old, "GET", "/v1/me")).status).toBe(401);

    const token = (await login(u.email, temporary)).accessToken;
    expect((await call(token, "GET", "/v1/me")).body.data.user.mustChangePassword).toBe(true);
    for (const [method, path, body] of [
      ["GET", "/v1/me/organizations", undefined],
      ["PATCH", "/v1/me/locale", { locale: "en" }],
      ["POST", "/v1/me/totp/setup", undefined],
    ] as const) expectRefused(await call(token, method, path, body), `${method} ${path}`);
    expect((await call(token, "POST", "/v1/me/password", { currentPassword: temporary, newPassword: NEW_PW })).status).toBe(204);
    expect((await call(token, "GET", "/v1/me/organizations")).status).toBe(200);
    // Flipping the flag on a live session takes effect on the next request (no stale JWT claim).
    await setFlag(u.id, true);
    expectRefused(await call(token, "GET", "/v1/me/organizations"), "flag set under a live session");
  });

  it("an inactive or signed-out flagged user gets 401, not 403, on the exempt and the guarded routes alike", async () => {
    const disabled = await seed();
    const disabledToken = (await login(disabled.email, PW)).accessToken;
    await dbClient.db.update(users).set({ userStatus: "disabled" }).where(eq(users.id, disabled.id));
    for (const [method, path] of [["GET", "/v1/me"], ["GET", "/v1/me/organizations"], ["POST", "/v1/auth/revoke"]] as const) {
      const res = await call(disabledToken, method, path);
      expect({ path, status: res.status, code: res.body.error?.code }).toEqual({ path, status: 401, code: "UNAUTHENTICATED" });
    }

    const revoked = await seed();
    const revokedToken = (await login(revoked.email, PW)).accessToken;
    await dbClient.db.update(userSessions).set({ revokedAt: new Date() }).where(eq(userSessions.userId, revoked.id));
    expect((await call(revokedToken, "GET", "/v1/me/organizations")).status).toBe(401);
    expect((await call(null, "GET", "/v1/me/organizations")).status).toBe(401);
  });
});
