import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  hostingAdminScopes,
  membershipRoles,
  memberships,
  operationSteps,
  operations,
  platformInstallations,
  sql,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-admin-pass";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "192.0.2.10" };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// Newest first, as the list orders them: three operations of applications among three of sites and services.
const SEEDED = [
  { id: "op_site_tls", kind: "site.tls.apply", resourceType: "site", resourceId: "site_x" },
  { id: "op_stack_task", kind: "stack.task", resourceType: "stack", resourceId: "stk_x" },
  { id: "op_stack_backup", kind: "stack.backup", resourceType: "stack", resourceId: "stk_x" },
  { id: "op_service_deploy", kind: "service.deploy", resourceType: "service", resourceId: "svc_x" },
  { id: "op_stack_deploy", kind: "stack.deploy", resourceType: "stack", resourceId: "stk_x" },
  { id: "op_site_backup", kind: "site.backups.create", resourceType: "site", resourceId: "site_x" },
] as const;
const ALL = SEEDED.map((op) => op.id);
const NOT_OF_APPS = SEEDED.filter((op) => op.resourceType !== "stack").map((op) => op.id);
const OF_APPS = SEEDED.filter((op) => op.resourceType === "stack").map((op) => op.id);

describe("an operation of an application is read only by a caller who may read applications (#141)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let orgId: string;
  let adminToken: string;
  let ownerToken: string;
  let collaboratorToken: string;

  async function call(as: string, path: string): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, { headers: { Authorization: `Bearer ${as}` } });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

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

  const list = (as: string, query = "") => call(as, `/v1/organizations/${orgId}/operations${query}`);
  const detail = (as: string, opId: string) => call(as, `/v1/organizations/${orgId}/operations/${opId}`);
  const auditRows = async () =>
    (await dbClient.db.select({ n: sql<number>`count(*)::int` }).from(auditEvents))[0]!.n;
  const withoutRequestId = (error: Json) => ({ ...error, requestId: undefined });

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
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
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);

    const created = await fetch(`${app.baseUrl!}/v1/admin/customer-account`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ organizationName: "Org", ownerEmail: "owner@example.test", ownerName: "Owner" }),
    });
    expect(created.status).toBe(201);
    const account = ((await created.json()) as Json).data;
    orgId = account.organizationId as string;
    await skipPasswordChange(dbClient.db, "owner@example.test");
    ownerToken = await login("owner@example.test", account.temporaryPassword as string);

    // The administrator reaches this organisation as a hosting administrator scoped to it.
    const [installation] = await dbClient.db.select().from(platformInstallations).limit(1);
    await dbClient.db
      .insert(hostingAdminScopes)
      .values({ id: `has_${randomUUID()}`, userId: admin.userId, organizationId: orgId, installationId: installation!.id });

    const collaboratorId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db
      .insert(users)
      .values({ id: collaboratorId, email: "collab@example.test", name: "Collab", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId: collaboratorId });
    await dbClient.db
      .insert(membershipRoles)
      .values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
    collaboratorToken = await login("collab@example.test", PW);

    const base = Date.parse("2026-11-20T10:00:00.000Z");
    const ops = SEEDED.map((op, i) => ({
      ...op,
      organizationId: orgId,
      status: "succeeded" as const,
      submittedAt: new Date(base - i * 1_000),
    }));
    await dbClient.db.insert(operations).values(ops);
    await dbClient.db
      .insert(operationSteps)
      .values(ops.map((op) => ({ id: `${op.id}_s1`, operationId: op.id, key: "settle", label: "Finish", status: "succeeded" as const })));
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("the collaborator, who gets 403 on the applications, lists no operation of an application and the total counts what it lists", async () => {
    expect((await call(collaboratorToken, `/v1/organizations/${orgId}/app-stacks`)).status).toBe(403);

    const res = await list(collaboratorToken);
    expect(res.status).toBe(200);
    expect(res.body.data.map((op: Json) => op.id)).toEqual(NOT_OF_APPS);
    expect(res.body.meta.total).toBe(NOT_OF_APPS.length);
    expect(res.body.page).toEqual({ nextCursor: null, hasMore: false });

    const first = await list(collaboratorToken, "?limit=2");
    expect(first.body.data.map((op: Json) => op.id)).toEqual(NOT_OF_APPS.slice(0, 2));
    expect(first.body.meta.total).toBe(NOT_OF_APPS.length);
    expect(first.body.page).toEqual({ nextCursor: NOT_OF_APPS[1], hasMore: true });
    const second = await list(collaboratorToken, `?limit=2&cursor=${first.body.page.nextCursor}`);
    expect(second.body.data.map((op: Json) => op.id)).toEqual(NOT_OF_APPS.slice(2));
    expect(second.body.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("for the collaborator a cursor naming an operation of an application is an unknown cursor: an empty page", async () => {
    const unknown = await list(collaboratorToken, "?cursor=op_nope");
    for (const opId of OF_APPS) {
      const res = await list(collaboratorToken, `?cursor=${opId}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.page).toEqual(unknown.body.page);
      expect(res.body.meta.total).toBe(unknown.body.meta.total);
    }
  });

  it("for the collaborator an operation of an application is 404 with the body of an unknown one; an operation of a site is still read", async () => {
    const unknown = await detail(collaboratorToken, "op_nope");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");
    expect(unknown.body.error.message).toBe("Operation 'op_nope' not found.");
    for (const opId of OF_APPS) {
      const res = await detail(collaboratorToken, opId);
      expect(res.status).toBe(404);
      expect(withoutRequestId(res.body.error)).toEqual({
        ...withoutRequestId(unknown.body.error),
        message: `Operation '${opId}' not found.`,
      });
      expect(Object.keys(res.body)).toEqual(Object.keys(unknown.body));
    }
    // Today's behaviour, pinned: operation.read alone reads the operations of sites and services.
    for (const opId of NOT_OF_APPS) {
      const res = await detail(collaboratorToken, opId);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(opId);
    }
  });

  it("the question asked of the collaborator writes no audit row", async () => {
    const before = await auditRows();
    await list(collaboratorToken);
    await list(collaboratorToken, `?cursor=${OF_APPS[0]}`);
    for (const opId of OF_APPS) await detail(collaboratorToken, opId);
    expect(await auditRows()).toBe(before);
  });

  it("the owner and the server administrator read the operations of applications as before: list, total and detail", async () => {
    for (const token of [ownerToken, adminToken]) {
      const res = await list(token);
      expect(res.status).toBe(200);
      expect(res.body.data.map((op: Json) => op.id)).toEqual(ALL);
      expect(res.body.meta.total).toBe(ALL.length);
      const paged = await list(token, `?limit=2&cursor=${OF_APPS[1]}`);
      expect(paged.body.data.map((op: Json) => op.id)).toEqual(ALL.slice(3, 5));
      for (const opId of OF_APPS) {
        const one = await detail(token, opId);
        expect(one.status).toBe(200);
        expect(one.body.data).toMatchObject({ id: opId, resourceType: "stack", resourceId: "stk_x" });
        expect(one.body.data.steps.map((step: Json) => step.id)).toEqual([`${opId}_s1`]);
      }
    }
  });
});
