import { randomUUID } from "node:crypto";
import { HEAVY_ACTION_WINDOW_MS } from "@hosting-panel/contracts";
import { auditEvents, createDatabaseClient, eq, operations, users, type DatabaseClient } from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import type { SiteBackupActor } from "../src/backups/site-backups.service.js";
import { assertHeavyActionAllowed } from "../src/backups/site-restore.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-admin-pass";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const ACTION = "test.paging.event";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("admin audit paging and the heavy-action limit per organisation", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let adminToken: string;

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

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const audit = (query: string) => call("GET", `/v1/admin/audit?${query}`);

  async function insertEvents(events: { id: string; timestamp: Date }[]): Promise<void> {
    for (let i = 0; i < events.length; i += 1000) {
      await dbClient.db.insert(auditEvents).values(
        events.slice(i, i + 1000).map((e) => ({ ...e, actorType: "system" as const, action: ACTION, targetType: "test" })),
      );
    }
  }

  beforeEach(async () => {
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  it("pages 120 events by cursor without gaps or repeats, including equal timestamps", async () => {
    const base = Date.parse("2026-11-15T10:00:00.000Z");
    // 60 events share one instant; ids are not in insertion order.
    const events = Array.from({ length: 120 }, (_, i) => ({
      id: `evt_${String((i * 37) % 120).padStart(3, "0")}`,
      timestamp: new Date(i < 60 ? base : base + i * 1_000),
    }));
    await insertEvents(events);

    const seen: Json[] = [];
    const pages: Json[] = [];
    let cursor: string | null = null;
    do {
      const res = await audit(`action=${ACTION}&limit=50${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBeUndefined();
      seen.push(...(res.body.data as Json[]));
      pages.push(res.body.page as Json);
      cursor = res.body.page.nextCursor as string | null;
    } while (cursor);

    expect(pages).toEqual([
      { nextCursor: seen[49]!.id, hasMore: true },
      { nextCursor: seen[99]!.id, hasMore: true },
      { nextCursor: null, hasMore: false },
    ]);
    const expected = [...events]
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime() || (a.id < b.id ? 1 : -1))
      .map((e) => e.id);
    expect(seen.map((e) => e.id)).toEqual(expected);
  });

  it("includes the instant of from and excludes the instant of to", async () => {
    const from = "2026-11-15T10:00:00.000Z";
    const to = "2026-11-15T11:00:00.000Z";
    const at = (iso: string, ms: number) => new Date(Date.parse(iso) + ms);
    await insertEvents([
      { id: "evt_before", timestamp: at(from, -1) },
      { id: "evt_from", timestamp: at(from, 0) },
      { id: "evt_inside", timestamp: at(from, 1) },
      { id: "evt_last", timestamp: at(to, -1) },
      { id: "evt_to", timestamp: at(to, 0) },
    ]);
    const res = await audit(`action=${ACTION}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(res.status).toBe(200);
    expect((res.body.data as Json[]).map((e) => e.id)).toEqual(["evt_last", "evt_inside", "evt_from"]);
    // An offset other than Z names the same instant.
    const shifted = await audit(`action=${ACTION}&from=${encodeURIComponent("2026-11-15T11:00:00.000+01:00")}`);
    expect((shifted.body.data as Json[]).map((e) => e.id)).toEqual(["evt_to", "evt_last", "evt_inside", "evt_from"]);
  });

  it("answers 400 VALIDATION_ERROR for a from or to that is no date, and for a limit above 100", async () => {
    for (const query of ["from=yesterday", "to=2026-13-45T00:00:00Z", "from=2026-11-15", "limit=101"]) {
      const res = await audit(query);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code, query).toBe("VALIDATION_ERROR");
    }
  });

  it("answers 400 VALIDATION_ERROR when from is not before to, also as the same instant in another offset", async () => {
    const enc = (from: string, to: string) => `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    for (const query of [
      enc("2026-11-15T11:00:00.000Z", "2026-11-15T10:00:00.000Z"),
      enc("2026-11-15T10:00:00.000Z", "2026-11-15T10:00:00.000Z"),
      enc("2026-11-15T11:00:00.000+01:00", "2026-11-15T10:00:00.000Z"),
    ]) {
      const res = await audit(query);
      expect(res.status, query).toBe(400);
      expect(res.body.error.code, query).toBe("VALIDATION_ERROR");
    }
    expect((await audit(enc("2026-11-15T10:00:00.000Z", "2026-11-15T10:00:00.001Z"))).status).toBe(200);
  });

  it("gives an empty page for an unknown cursor", async () => {
    await insertEvents([{ id: "evt_only", timestamp: new Date() }]);
    const res = await audit(`action=${ACTION}&cursor=evt_nope`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.page).toEqual({ nextCursor: null, hasMore: false });
  });

  it("lets the database cut a page of 50 out of 5000 rows", async () => {
    const base = Date.parse("2026-11-15T10:00:00.000Z");
    await insertEvents(Array.from({ length: 5000 }, (_, i) => ({ id: `evt_${String(i).padStart(4, "0")}`, timestamp: new Date(base + i) })));
    // Every row the driver hands back during the request is recorded.
    const client = (dbClient.db as unknown as { $client: { query: (...a: unknown[]) => Promise<{ rows: unknown[] }> } }).$client;
    const original = client.query.bind(client);
    const rowCounts: number[] = [];
    vi.spyOn(client, "query").mockImplementation(async (...args: unknown[]) => {
      const result = await original(...args);
      rowCounts.push(result.rows.length);
      return result;
    });

    const res = await audit(`action=${ACTION}&limit=50`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(50);
    expect(res.body.data[0].id).toBe("evt_4999");
    expect(rowCounts.length).toBeGreaterThan(0);
    expect(Math.max(...rowCounts)).toBeLessThanOrEqual(51);
  });

  it("refuses a customer's 25th heavy action in an hour across sites, not the 24th, and never an administrator's", async () => {
    const created = await call("POST", "/v1/admin/customer-account", {
      organizationName: "Customer A",
      ownerEmail: "customer@example.test",
      ownerName: "Customer",
    });
    expect(created.status).toBe(201);
    const orgId = created.body.data.organizationId as string;
    const [customer] = await dbClient.db.select().from(users).where(eq(users.email, "customer@example.test"));
    const site = await call("POST", "/v1/admin/sites", {
      name: "Site A",
      domain: "wp-a.example.test",
      title: "Site A",
      adminUser: "admin",
      adminEmail: "owner@example.test",
      adminPassword: "sentinel-Pass-123456",
      ownerOrganizationId: orgId,
    });
    expect(site.status).toBe(202);
    const siteId = site.body.data.siteId as string;

    const now = new Date();
    const oldest = new Date(now.getTime() - 50 * 60_000);
    // Five sites, at most five actions each: no site reaches its own 6.
    const resourceIds = [siteId, "site_b", "site_c", "site_d", "site_e"];
    const insertOp = (i: number) =>
      dbClient.db.insert(operations).values({
        id: `op_heavy_${i}`,
        organizationId: orgId,
        kind: "site.backups.create",
        status: "succeeded",
        resourceType: "site",
        resourceId: resourceIds[i % resourceIds.length]!,
        requestedByUserId: customer!.id,
        submittedAt: new Date(oldest.getTime() + i * 1_000),
      });
    for (let i = 0; i < 23; i++) await insertOp(i);
    await dbClient.db.insert(operations).values({
      id: "op_heavy_current",
      organizationId: orgId,
      kind: "site.backups.create",
      status: "queued",
      resourceType: "site",
      resourceId: siteId,
      requestedByUserId: customer!.id,
      submittedAt: now,
    });
    const current = { id: "op_heavy_current", submittedAt: now };
    const customerActor = {} as SiteBackupActor;
    const adminActor = { actionPrefix: "admin.site.backups" } as SiteBackupActor;
    const check = (actor: SiteBackupActor) =>
      dbClient.db.transaction((tx) => assertHeavyActionAllowed(tx, siteId, actor, current));

    // The 24th passes.
    await expect(check(customerActor)).resolves.toBeUndefined();

    // The 25th is refused until the oldest leaves the window.
    await insertOp(23);
    const refusal = await check(customerActor).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ControlPlaneError);
    const err = refusal as ControlPlaneError;
    expect(err.code).toBe("QUOTA_EXCEEDED");
    const retryAt = new Date(oldest.getTime() + HEAVY_ACTION_WINDOW_MS).toISOString();
    expect(err.details).toEqual([{ field: "retryAt", reason: "too_many_requests", message: retryAt }]);
    expect(err.message).toBe(`Too many backup actions in this organisation; try again at ${retryAt}`);

    // An administrator is not refused at the same count.
    await expect(check(adminActor)).resolves.toBeUndefined();
  });
});
