import { generateKeyPairSync } from "node:crypto";
import {
  createDatabaseClient,
  eq,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createControlPlaneApp,
  type ControlPlaneAppHandle,
  type CreateControlPlaneAppOptions,
} from "../src/index.js";

const jwtSigningKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

describe("Production defaults, persisted signing key and DB-backed sessions", () => {
  let dbClient: DatabaseClient;
  const apps: ControlPlaneAppHandle[] = [];
  const savedEnv = {
    ENABLE_DEV_OIDC: process.env["ENABLE_DEV_OIDC"],
    HP_SEED_DEMO: process.env["HP_SEED_DEMO"],
  };

  async function boot(options?: CreateControlPlaneAppOptions): Promise<ControlPlaneAppHandle> {
    const app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      ...options,
    });
    apps.push(app);
    return app;
  }

  async function post(app: ControlPlaneAppHandle, path: string, body: unknown, token?: string) {
    return fetch(`${app.baseUrl!}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async function devToken(app: ControlPlaneAppHandle, userId: string): Promise<string> {
    const res = await post(app, "/v1/dev/auth/token", { userId });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { accessToken: string } };
    return json.data.accessToken;
  }

  async function getMe(app: ControlPlaneAppHandle, token: string) {
    return fetch(`${app.baseUrl!}/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  beforeEach(async () => {
    delete process.env["ENABLE_DEV_OIDC"];
    delete process.env["HP_SEED_DEMO"];
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
  });

  afterEach(async () => {
    for (const app of apps.splice(0)) {
      await app.close();
    }
    await dbClient.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("dev token endpoint is 404 by default", async () => {
    // Seed explicitly so a 404 means "endpoint disabled", not "user missing".
    const app = await boot({ seedPhase1: true });
    const res = await post(app, "/v1/dev/auth/token", { userId: "usr_infra" });
    expect(res.status).toBe(404);
  });

  it("linux-systemd startup fails without a JWT signing key file", async () => {
    const saved = process.env["HP_JWT_SIGNING_KEY_FILE"];
    process.env["HP_JWT_SIGNING_KEY_FILE"] = "/nonexistent/hosting-panel/jwt-signing.pem";
    try {
      await expect(
        boot({ runtimeBackend: "linux-systemd", secretsMasterKey: Buffer.alloc(32, 1) }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (saved === undefined) delete process.env["HP_JWT_SIGNING_KEY_FILE"];
      else process.env["HP_JWT_SIGNING_KEY_FILE"] = saved;
    }
  });

  it("no demo data is seeded by default", async () => {
    // Let the app own its database so the old "seed when owning the DB" default is exercised.
    const app = await boot({ databaseClient: undefined });
    const rows = await app.dbClient.db.select().from(users);
    expect(rows.length).toBe(0);
  });

  it("revoked session stays revoked after app restart", async () => {
    const options = { jwtSigningKeyPem, seedPhase1: true, enableDevOidc: true };
    const first = await boot(options);
    const revokedToken = await devToken(first, "usr_infra");
    const keptToken = await devToken(first, "usr_infra");
    expect((await getMe(first, revokedToken)).status).toBe(200);
    expect((await post(first, "/v1/auth/revoke", {}, revokedToken)).status).toBe(200);
    await first.close();

    const second = await boot({ jwtSigningKeyPem, enableDevOidc: true });
    expect((await getMe(second, revokedToken)).status).toBe(401);
    expect((await getMe(second, keptToken)).status).toBe(200);
  });

  it("revokeAllSessionsForUser keeps only the excepted session", async () => {
    const app = await boot({ seedPhase1: true });
    const input = { userId: "usr_infra", email: "infra@hcp.local", displayName: "Infra", ip: "127.0.0.1" };
    const kept = await app.oidc.issueSessionToken(input);
    const dropped = await app.oidc.issueSessionToken(input);
    expect(kept.expiresIn).toBe(43_200);
    await app.oidc.revokeAllSessionsForUser("usr_infra", kept.jti);
    expect((await getMe(app, kept.accessToken)).status).toBe(200);
    expect((await getMe(app, dropped.accessToken)).status).toBe(401);
  });

  it("disabled user is rejected", async () => {
    const app = await boot({ seedPhase1: true, enableDevOidc: true });
    const token = await devToken(app, "usr_elena");
    await dbClient.db
      .update(users)
      .set({ userStatus: "disabled" })
      .where(eq(users.id, "usr_elena"));
    expect((await getMe(app, token)).status).toBe(401);
  });

  it("server admin comes from platform_role", async () => {
    const app = await boot({ seedPhase1: true, enableDevOidc: true });
    const token = await devToken(app, "usr_infra");
    await dbClient.db
      .update(users)
      .set({ platformRole: null })
      .where(eq(users.id, "usr_infra"));
    const res = await getMe(app, token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { globalRoles: string[] } };
    expect(json.data.globalRoles).not.toContain("infrastructure_admin");
  });
});
