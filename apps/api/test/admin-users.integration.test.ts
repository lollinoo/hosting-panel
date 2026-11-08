import { auditEvents, createDatabaseClient, eq, users, type DatabaseClient } from "@hosting-panel/database";
import { findForbiddenPublicDtoKeys } from "@hosting-panel/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

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

  it("reset-password returns a new temporary password; reset-totp is customers only", async () => {
    const { data } = (await (await createCustomer()).json()) as Created;
    const r = await call(adminToken, "POST", `/v1/admin/users/${data.userId}/reset-password`);
    expect(r.status).toBe(200);
    const { temporaryPassword } = ((await r.json()) as { data: { temporaryPassword: string } }).data;
    expect((await login("mario@hotel.it", temporaryPassword)).data.mustChangePassword).toBe(true);
    expect((await call(adminToken, "POST", `/v1/admin/users/${data.userId}/reset-totp`)).status).toBe(204);
    expect((await call(adminToken, "POST", `/v1/admin/users/${adminId}/reset-totp`)).status).toBe(403);
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
});
