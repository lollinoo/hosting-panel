import { readFileSync } from "node:fs";
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
import { totpCodeAt } from "../src/auth/totp.js";

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

  it("refuses to start in production with the demo seed or the dev token endpoint enabled", async () => {
    const saved = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await expect(boot({ seedPhase1: true })).rejects.toThrow(/HP_SEED_DEMO/);
      await expect(boot({ enableDevOidc: true })).rejects.toThrow(/ENABLE_DEV_OIDC/);
      process.env["HP_SEED_DEMO"] = "true";
      await expect(boot()).rejects.toThrow(/HP_SEED_DEMO/);
      delete process.env["HP_SEED_DEMO"];
      process.env["ENABLE_DEV_OIDC"] = "true";
      await expect(boot()).rejects.toThrow(/ENABLE_DEV_OIDC/);
    } finally {
      process.env["NODE_ENV"] = saved;
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

  it("openapi documents the login endpoint", () => {
    const text = readFileSync(new URL("../../../docs/api/openapi.yaml", import.meta.url), "utf8");
    for (const p of ["/v1/auth/login", "/v1/me/totp/setup", "/v1/admin/customer-account"]) {
      expect(text).toContain(p);
    }
  });

  it("rejects an empty or whitespace-only JWT signing key", async () => {
    await expect(boot({ jwtSigningKeyPem: "" })).rejects.toThrow(/signing key/i);
    await expect(boot({ jwtSigningKeyPem: "  \n" })).rejects.toThrow(/signing key/i);
  });

  it("demo seed gives users a dev password and usr_infra a fixed TOTP secret", async () => {
    const app = await boot({ seedPhase1: true, secretsMasterKey: Buffer.alloc(32, 3) });
    const login = (body: unknown) =>
      fetch(`${app.baseUrl!}/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const elena = await login({ email: "elena@acme.it", password: "demo-password-123" });
    expect(elena.status).toBe(200);
    expect(((await elena.json()) as { data: { status: string } }).data.status).toBe("ok");
    const creds = { email: "infra@hcp.local", password: "demo-password-123" };
    expect(((await (await login(creds)).json()) as { data: { status: string } }).data.status).toBe(
      "totp_required",
    );
    const code = totpCodeAt("JBSWY3DPEHPK3PXP", Math.floor(Date.now() / 30_000));
    const ok = await login({ ...creds, totpCode: code });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { status: string } }).data.status).toBe("ok");
  });
});
