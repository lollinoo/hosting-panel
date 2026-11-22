import { randomUUID } from "node:crypto";
import {
  AppStackQuotaError,
  auditEvents,
  createDatabaseClient,
  eq,
  organizations,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appStackQuotaError } from "../src/app-stacks/app-stack-limit.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const OPS = "org_platform_ops";
const ACTION = "admin.customer.app_stack_limit";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("per-customer application limit", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let adminId: string;
  let orgId: string;
  let token: string;

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, as: string | null, body?: unknown): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const patchLimit = (id: string, body: unknown, as: string | null = adminToken) =>
    call("PATCH", `/v1/admin/organizations/${id}/app-stack-limit`, as, body);
  const maxAppStacksOf = async (id: string) =>
    (await dbClient.db.select().from(organizations).where(eq(organizations.id, id)))[0]!.maxAppStacks;
  const audits = () => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, ACTION));

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: new InMemoryDockerSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    adminId = admin.userId;
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: "Hotel Mario",
      ownerEmail: "mario@hotel.it",
      ownerName: "Hotel Mario",
    });
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgId = created.body.data.organizationId as string;
    token = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  describe("PATCH /v1/admin/organizations/:orgId/app-stack-limit", () => {
    it("sets 2, then null, answers the usage and audits { from, to } each time", async () => {
      expect(await maxAppStacksOf(orgId)).toBeNull();
      const set = await patchLimit(orgId, { maxAppStacks: 2 });
      expect(set.status).toBe(200);
      expect(set.body.data).toEqual({ organizationId: orgId, maxAppStacks: 2, usedAppStacks: 0 });
      expect(await maxAppStacksOf(orgId)).toBe(2);

      const [audit] = await audits();
      expect(audit).toMatchObject({ actorId: adminId, organizationId: orgId, targetType: "organization", targetId: orgId });
      expect(audit!.details).toEqual({ outcome: "succeeded", requestId: expect.any(String), from: null, to: 2 });

      const cleared = await patchLimit(orgId, { maxAppStacks: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data).toEqual({ organizationId: orgId, maxAppStacks: null, usedAppStacks: 0 });
      expect(await maxAppStacksOf(orgId)).toBeNull();
      expect((await audits()).map((r) => [(r.details as Json).from, (r.details as Json).to])).toEqual(
        expect.arrayContaining([
          [null, 2],
          [2, null],
        ]),
      );
    });

    it.each([[{}], [{ maxAppStacks: -1 }], [{ maxAppStacks: 1001 }], [{ maxAppStacks: 1, extra: true }]])(
      "refuses the body %j with 400 and changes nothing",
      async (body) => {
        expect((await patchLimit(orgId, body)).status).toBe(400);
        expect(await maxAppStacksOf(orgId)).toBeNull();
        expect(await audits()).toEqual([]);
      },
    );

    it("answers 404 for an unknown customer and for platform-ops", async () => {
      expect((await patchLimit("org_nope", { maxAppStacks: 1 })).status).toBe(404);
      expect((await patchLimit(OPS, { maxAppStacks: 1 })).status).toBe(404);
      expect(await audits()).toEqual([]);
    });

    it("refuses anybody but a server administrator and writes nothing", async () => {
      expect((await patchLimit(orgId, { maxAppStacks: 1 }, token)).status).toBe(403);
      expect((await patchLimit(orgId, { maxAppStacks: 1 }, null)).status).toBe(401);
      expect(await maxAppStacksOf(orgId)).toBeNull();
      expect(await audits()).toEqual([]);
    });
  });

  describe("appStackQuotaError", () => {
    it("maps AppStackQuotaError to QUOTA_EXCEEDED with exactly one STACK_QUOTA_EXCEEDED detail", () => {
      const mapped = appStackQuotaError(new AppStackQuotaError("appStacks", 2, 2));
      expect(mapped).toBeInstanceOf(ControlPlaneError);
      expect(mapped).toMatchObject({
        code: "QUOTA_EXCEEDED",
        details: [{ field: "appStacks", reason: "STACK_QUOTA_EXCEEDED", message: "2 of 2 in use." }],
      });
      expect((mapped as ControlPlaneError).details).toHaveLength(1);
    });

    it("passes any other error through", () => {
      const other = new Error("boom");
      expect(appStackQuotaError(other)).toBe(other);
    });
  });
});
