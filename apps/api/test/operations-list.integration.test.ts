import { randomUUID } from "node:crypto";
import { createDatabaseClient, operationSteps, operations, type DatabaseClient } from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-admin-pass";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "192.0.2.10" };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("the operations list of an organisation reads one page from the database", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let token: string;
  let queries = 0;

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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

  // Creates the customer organisation as the administrator, then signs in as its owner.
  async function createOrg(email: string): Promise<string> {
    const res = await call("POST", "/v1/admin/customer-account", {
      organizationName: `Org ${email}`,
      ownerEmail: email,
      ownerName: "Owner",
    });
    expect(res.status).toBe(201);
    await skipPasswordChange(dbClient.db, email);
    token = await login(email, res.body.data.temporaryPassword as string);
    return res.body.data.organizationId as string;
  }

  let orgId: string;
  const seeded: { id: string; submittedAt: Date }[] = [];

  // Two operations share each instant so the order by id is exercised too; each has two steps.
  async function seed(prefix: string, count: number, base: number): Promise<string[]> {
    const ops = Array.from({ length: count }, (_, i) => ({
      id: `op_${prefix}_${String((i * 7) % count).padStart(3, "0")}`,
      organizationId: orgId,
      kind: "site.backups.create" as const,
      status: "succeeded" as const,
      resourceType: "site" as const,
      resourceId: "site_x",
      submittedAt: new Date(base + Math.floor(i / 2) * 1_000),
    }));
    await dbClient.db.insert(operations).values(ops);
    await dbClient.db.insert(operationSteps).values(
      ops.flatMap((op) => [
        { id: `${op.id}_s2`, operationId: op.id, key: "second", label: "Second", status: "succeeded" as const },
        { id: `${op.id}_s1`, operationId: op.id, key: "first", label: "First", status: "succeeded" as const },
      ]),
    );
    seeded.push(...ops);
    return [...seeded]
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((op) => op.id);
  }

  // Page 2 of the list, with the number of database queries the request made.
  async function pageTwo(limit: number): Promise<{ body: Json; queries: number }> {
    const first = await call("GET", `/v1/organizations/${orgId}/operations?limit=${limit}`);
    expect(first.status).toBe(200);
    queries = 0;
    const res = await call("GET", `/v1/organizations/${orgId}/operations?limit=${limit}&cursor=${first.body.page.nextCursor}`);
    expect(res.status).toBe(200);
    return { body: res.body, queries };
  }

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
    token = await login("admin@example.test", PW, admin.totpSecretBase32);
    orgId = await createOrg("owner@example.test");
    const client = (dbClient.db as unknown as { $client: { query: (...a: unknown[]) => Promise<unknown> } }).$client;
    const original = client.query.bind(client);
    vi.spyOn(client, "query").mockImplementation(async (...args: unknown[]) => {
      queries += 1;
      return original(...args);
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  it("answers page 2 of 300 operations with the right rows, in order, with their steps, in as many queries as for 30", async () => {
    const base = Date.parse("2026-11-15T10:00:00.000Z");
    await seed("a", 30, base);
    const few = await pageTwo(10);
    const expected = await seed("b", 270, base + 3_600_000);
    const many = await pageTwo(50);
    expect(many.queries).toBe(few.queries);

    expect(many.body.data.map((op: Json) => op.id)).toEqual(expected.slice(50, 100));
    for (const op of many.body.data as Json[]) {
      expect(op.steps.map((s: Json) => s.id).sort()).toEqual([`${op.id}_s1`, `${op.id}_s2`]);
    }
    expect(many.body.meta.total).toBe(300);
    expect(many.body.page).toEqual({ nextCursor: expected[99], hasMore: true });
    expect(few.body.meta.total).toBe(30);
  });

  it("answers an unknown cursor with an empty last page, and the last page has no next cursor", async () => {
    const expected = seeded
      .sort((a, b) => b.submittedAt.getTime() - a.submittedAt.getTime() || (a.id < b.id ? 1 : -1))
      .map((op) => op.id);
    const unknown = await call("GET", `/v1/organizations/${orgId}/operations?cursor=op_nope`);
    expect(unknown.body.data).toEqual([]);
    expect(unknown.body.page).toEqual({ nextCursor: null, hasMore: false });
    const last = await call("GET", `/v1/organizations/${orgId}/operations?limit=3&cursor=${expected[296]}`);
    expect(last.body.data.map((op: Json) => op.id)).toEqual(expected.slice(297, 300));
    expect(last.body.page).toEqual({ nextCursor: null, hasMore: false });
  });
});
