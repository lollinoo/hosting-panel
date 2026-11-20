import { auditEvents, createDatabaseClient, eq, sql, users, type DatabaseClient } from "@hosting-panel/database";
import { CreateAdministratorResultDtoSchema, findForbiddenPublicDtoKeys } from "@hosting-panel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueBreakGlassEmergencyToken } from "../src/cli/break-glass.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "host.test", hostIpv4: "10.0.0.1" };
const CUSTOMER = { organizationName: "Hotel Mario", ownerEmail: " Mario@Hotel.IT ", ownerName: "Mario" };

describe("admin user management API", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let adminId: string;
  let hostId: string;

  async function login(email: string, password: string, totpSecret?: string) {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return (await res.json()) as { data: { status: string; accessToken: string; mustChangePassword: boolean } };
  }
  const call = (token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const createCustomer = (input: unknown = CUSTOMER) => call(adminToken, "POST", "/v1/admin/customer-account", input);
  type Created = { data: { organizationId: string; userId: string; temporaryPassword: string } };

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    hostId = (await setupInstallation(dbClient.db, SETUP)).hostId;
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    adminId = admin.userId;
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      breakglassSigningKey: "ab".repeat(32),
    });
    adminToken = (await login("admin@x.it", PW, admin.totpSecretBase32)).data.accessToken;
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("server admin creates the customer account", async () => {
    const res = await createCustomer();
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as Created;
    expect(data.temporaryPassword).toHaveLength(16);
    const l = await login("mario@hotel.it", data.temporaryPassword);
    expect(l.data.mustChangePassword).toBe(true);
    const me = await (await call(l.data.accessToken, "GET", "/v1/me")).json();
    expect((me as { data: { memberships: Array<{ role: string }> } }).data.memberships[0]!.role).toBe("customer_owner");
    const audits = await dbClient.db.select().from(auditEvents);
    expect(JSON.stringify(audits)).not.toContain(data.temporaryPassword);
    expect(audits.some((a) => a.action === "admin.customer_account.create")).toBe(true);
  });

  it("second customer account is refused", async () => {
    expect((await createCustomer()).status).toBe(201);
    const res = await createCustomer({ organizationName: "Other", ownerEmail: "o@x.it", ownerName: "O" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DEDICATED_HOST_OCCUPIED");
    expect(await dbClient.db.select().from(users).where(eq(users.email, "o@x.it"))).toHaveLength(0);
  });

  it("customer can be created after host maintenance", async () => {
    const m = await call(adminToken, "POST", `/v1/hosts/${hostId}/maintenance`, { action: "collect_diagnostics" }, { "Idempotency-Key": "maint-1" });
    expect(m.status).toBe(202);
    expect((await createCustomer()).status).toBe(201);
  });

  it("returns 404 when setup was never run", async () => {
    await dbClient.db.delete((await import("@hosting-panel/database")).hosts);
    const res = await createCustomer();
    expect(res.status).toBe(404);
  });

  it("customer cannot call admin endpoints", async () => {
    const { data } = (await (await createCustomer()).json()) as Created;
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    const token = (await login("mario@hotel.it", data.temporaryPassword)).data.accessToken;
    const res = await call(token, "GET", "/v1/admin/users");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PERMISSION_DENIED");
    const denied = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "platform.users.manage"));
    expect(denied).toHaveLength(1);
    expect((denied[0]!.details as { outcome: string }).outcome).toBe("denied");
  });

  it("disabling a user revokes their sessions; admin cannot disable themself", async () => {
    const { data } = (await (await createCustomer()).json()) as Created;
    const token = (await login("mario@hotel.it", data.temporaryPassword)).data.accessToken;
    expect((await call(token, "GET", "/v1/me")).status).toBe(200);
    expect((await call(adminToken, "PATCH", `/v1/admin/users/${data.userId}`, { status: "disabled" })).status).toBe(200);
    expect((await call(token, "GET", "/v1/me")).status).toBe(401);
    const self = await call(adminToken, "PATCH", `/v1/admin/users/${adminId}`, { status: "disabled" });
    expect(self.status).toBe(403);
  });

  it("reset-password returns a new temporary password; both resets are customers only", async () => {
    const { data } = (await (await createCustomer()).json()) as Created;
    const r = await call(adminToken, "POST", `/v1/admin/users/${data.userId}/reset-password`);
    expect(r.status).toBe(200);
    const { temporaryPassword } = ((await r.json()) as { data: { temporaryPassword: string } }).data;
    expect((await login("mario@hotel.it", temporaryPassword)).data.mustChangePassword).toBe(true);
    expect((await call(adminToken, "POST", `/v1/admin/users/${data.userId}/reset-totp`)).status).toBe(204);
    expect((await call(adminToken, "POST", `/v1/admin/users/${adminId}/reset-totp`)).status).toBe(403);
    // Server admins (the caller included) are recovered from the CLI only.
    expect((await call(adminToken, "POST", `/v1/admin/users/${adminId}/reset-password`)).status).toBe(403);
    expect((await call(adminToken, "POST", `/v1/admin/users/usr_nope/reset-password`)).status).toBe(404);
    expect(JSON.stringify(await dbClient.db.select().from(auditEvents))).not.toContain(temporaryPassword);
  });

  it("user list exposes no password hash or TOTP data", async () => {
    await createCustomer();
    const res = await call(adminToken, "GET", "/v1/admin/users");
    const text = await res.text();
    const json = JSON.parse(text) as { data: Array<{ email: string; role: string; totpEnabled: boolean }> };
    expect(json.data).toHaveLength(2);
    expect(json.data.find((u) => u.email === "admin@x.it")).toMatchObject({ role: "server_admin", totpEnabled: true });
    expect(findForbiddenPublicDtoKeys(json)).toEqual([]);
    expect(text).not.toContain("scrypt$");
    expect(text).not.toMatch(/totpCiphertext|passwordHash/);
  });

  const createAdmin = (body: unknown, token = adminToken) => call(token, "POST", "/v1/admin/administrators", body);
  const setStatus = (token: string, userId: string, status: string) =>
    call(token, "PATCH", `/v1/admin/users/${userId}`, { status });
  const statusOf = async (userId: string) =>
    (await dbClient.db.select().from(users).where(eq(users.id, userId)))[0]!.userStatus;
  const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
  // A second administrator with a known password, logged in.
  async function secondAdmin() {
    const b = await createServerAdmin(dbClient.db, KEY, { email: "second@example.test", name: "Second", password: PW });
    return { id: b.userId, token: (await login("second@example.test", PW, b.totpSecretBase32)).data.accessToken };
  }

  it("server admin creates an administrator; the secrets are in the answer only", async () => {
    const res = await createAdmin({ email: " New@Example.TEST ", name: "New" });
    expect(res.status).toBe(201);
    const data = CreateAdministratorResultDtoSchema.strict().parse(((await res.json()) as { data: unknown }).data);
    expect(data.email).toBe("new@example.test");
    const [row] = await dbClient.db.select().from(users).where(eq(users.id, data.userId));
    expect(row).toMatchObject({ platformRole: "infrastructure_admin", mustChangePassword: true, userStatus: "active" });

    expect((await login("new@example.test", data.temporaryPassword)).data.status).toBe("totp_required");
    const l = await login("new@example.test", data.temporaryPassword, data.totpSecretBase32);
    expect(l.data.mustChangePassword).toBe(true);
    const blocked = await call(l.data.accessToken, "GET", "/v1/admin/users");
    expect(blocked.status).toBe(403);
    expect(await errorCode(blocked)).toBe("PASSWORD_CHANGE_REQUIRED");
    const changed = await call(l.data.accessToken, "POST", "/v1/me/password", {
      currentPassword: data.temporaryPassword,
      newPassword: "a new long password",
    });
    expect(changed.status).toBe(204);
    expect((await call(l.data.accessToken, "GET", "/v1/admin/users")).status).toBe(200);

    const [audit] = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.administrator.create"));
    expect(audit).toMatchObject({ actorId: adminId, targetType: "user", targetId: data.userId });
    const { outcome, requestId, ...rest } = audit!.details as Record<string, unknown>;
    expect({ outcome, rest }).toEqual({ outcome: "succeeded", rest: { email: "new@example.test" } });
    expect(requestId).toEqual(expect.any(String));

    const tables = await dbClient.db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(tables.rows.length).toBeGreaterThan(10);
    for (const t of tables.rows) {
      const rows = JSON.stringify((await dbClient.db.execute(sql.raw(`SELECT * FROM "${String(t["table_name"])}"`))).rows);
      expect(rows, String(t["table_name"])).not.toContain(data.temporaryPassword);
      expect(rows, String(t["table_name"])).not.toContain(data.totpSecretBase32);
    }

    // Password and TOTP of an administrator stay on the command line.
    expect((await call(adminToken, "POST", `/v1/admin/users/${data.userId}/reset-password`)).status).toBe(403);
    expect((await call(adminToken, "POST", `/v1/admin/users/${data.userId}/reset-totp`)).status).toBe(403);
  });

  it("create administrator refuses a used address, a bad body and a customer", async () => {
    const dup = await createAdmin({ email: "ADMIN@x.it", name: "Dup" });
    expect(dup.status).toBe(400);
    expect(await errorCode(dup)).toBe("VALIDATION_ERROR");
    expect((await createAdmin({ email: "not-an-address", name: "Bad" })).status).toBe(400);
    expect((await createAdmin({ email: "bad@example.test", name: " " })).status).toBe(400);

    const { data } = (await (await createCustomer()).json()) as Created;
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    const token = (await login("mario@hotel.it", data.temporaryPassword)).data.accessToken;
    const denied = await createAdmin({ email: "sneaky@example.test", name: "Sneaky" }, token);
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe("PERMISSION_DENIED");
    expect(await dbClient.db.select().from(users).where(eq(users.platformRole, "infrastructure_admin"))).toHaveLength(1);
    expect(await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.administrator.create"))).toHaveLength(0);
  });

  it("disabling an administrator refuses its session and break-glass token; enabling lets it back", async () => {
    const b = await secondAdmin();
    const bg = await issueBreakGlassEmergencyToken({ dbClient, oidcService: app.oidc, userId: b.id, reason: "test" });
    expect((await call(bg.token.accessToken, "GET", "/v1/me")).status).toBe(200);

    expect((await setStatus(adminToken, b.id, "disabled")).status).toBe(200);
    expect((await call(b.token, "GET", "/v1/me")).status).toBe(401);
    expect((await call(bg.token.accessToken, "GET", "/v1/me")).status).toBe(401);
    await expect(
      issueBreakGlassEmergencyToken({ dbClient, oidcService: app.oidc, userId: b.id, reason: "test" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    const on = await setStatus(adminToken, b.id, "active");
    expect(on.status).toBe(200);
    expect(((await on.json()) as { data: { status: string } }).data.status).toBe("active");
    expect((await login("second@example.test", PW)).data.status).toBe("totp_required");
    const statuses = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.user.status"));
    expect(statuses.map((a) => (a.details as { status: string }).status)).toEqual(["disabled", "active"]);
  });

  it("a break-glass token works while the administrator must change the password", async () => {
    const b = await createServerAdmin(dbClient.db, KEY, { email: "second@example.test", name: "Second", password: PW });
    await dbClient.db.update(users).set({ mustChangePassword: true }).where(eq(users.id, b.userId));
    const bg = await issueBreakGlassEmergencyToken({ dbClient, oidcService: app.oidc, userId: b.userId, reason: "test" });
    expect((await call(bg.token.accessToken, "GET", "/v1/admin/users")).status).toBe(200);
    const token = (await login("second@example.test", PW, b.totpSecretBase32)).data.accessToken;
    const res = await call(token, "GET", "/v1/admin/users");
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("the last active administrator cannot be disabled", async () => {
    const b = await secondAdmin();
    const real = app.authz.authenticateRequest.bind(app.authz);
    // The caller passes its own check, then is disabled before the change: only the target is still active.
    vi.spyOn(app.authz, "authenticateRequest").mockImplementation(async (req) => {
      const auth = await real(req);
      await dbClient.db.update(users).set({ userStatus: "disabled" }).where(eq(users.id, adminId));
      return auth;
    });
    const res = await setStatus(adminToken, b.id, "disabled");
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("LAST_ADMINISTRATOR_PROTECTED");
    expect(await statusOf(b.id)).toBe("active");
    expect((await call(b.token, "GET", "/v1/me")).status).toBe(200);
    expect(await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "admin.user.status"))).toHaveLength(0);
  });

  it("two administrators disabling each other at once: one wins, one gets 409", async () => {
    const b = await secondAdmin();
    const real = app.authz.authenticateRequest.bind(app.authz);
    let release!: () => void;
    const bothIn = new Promise<void>((r) => (release = r));
    let waiting = 0;
    // Both callers are authenticated as active before either change runs.
    vi.spyOn(app.authz, "authenticateRequest").mockImplementation(async (req) => {
      const auth = await real(req);
      if (++waiting === 2) release();
      await bothIn;
      return auth;
    });
    const res = await Promise.all([setStatus(adminToken, b.id, "disabled"), setStatus(b.token, adminId, "disabled")]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await errorCode(res.find((r) => r.status === 409)!)).toBe("LAST_ADMINISTRATOR_PROTECTED");
    const admins = await dbClient.db.select().from(users).where(eq(users.platformRole, "infrastructure_admin"));
    expect(admins.filter((a) => a.userStatus === "active")).toHaveLength(1);
  });
});
