import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminTerminalSessions,
  auditEvents,
  closeTerminalSession,
  createDatabaseClient,
  eq,
  findTerminalSession,
  listOpenTerminalSessions,
  openTerminalSession,
  organizations,
  platformInstallations,
  schemaMigrations,
  sql,
  users,
  type DatabaseClient,
} from "../src/index.js";

const sid = (n: number) => `term_${n.toString(16).padStart(32, "0")}`;

describe("admin terminal sessions repository", () => {
  let client: DatabaseClient;
  const open = (n: number, siteId = `site_${n}`, userId = "u_admin") =>
    openTerminalSession(client.db, {
      id: sid(n), userId, siteId, organizationId: "org_a", containerName: `hp_svc_svc_${n}`,
      ipAddress: "192.0.2.10", userAgent: "vitest", requestId: `req_${n}`,
    });
  const audits = (action: string) => client.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const snapshot = async () => ({
    sessions: await client.db.select().from(adminTerminalSessions),
    audits: await client.db.select().from(auditEvents),
  });

  beforeEach(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await client.db.insert(platformInstallations).values({ id: "pi_1", name: "Test" });
    await client.db.insert(organizations).values({ id: "org_a", platformInstallationId: "pi_1", name: "Org A", slug: "org-a" });
    await client.db.insert(users).values([
      { id: "u_admin", email: "admin@example.test", name: "Admin" },
      { id: "u_other", email: "other@example.test", name: "Other" },
    ]);
  });

  afterEach(async () => {
    await client.close();
  });

  it("applies migration 0016", async () => {
    const rows = await client.db.select().from(schemaMigrations);
    expect(rows.map((r) => r.filename)).toContain("0016_admin_terminal_sessions.sql");
  });

  it("open writes the row and one open audit row", async () => {
    expect(await open(1)).toBe("opened");
    const row = await findTerminalSession(client.db, sid(1), "u_admin");
    expect(row).toMatchObject({ id: sid(1), userId: "u_admin", siteId: "site_1", organizationId: "org_a", containerName: "hp_svc_svc_1", closedAt: null, closeReason: null });
    const rows = await audits("admin.terminal.open");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: "u_admin", actorType: "user", organizationId: "org_a", targetType: "site", targetId: "site_1",
      ipAddress: "192.0.2.10", userAgent: "vitest",
      details: { outcome: "succeeded", requestId: "req_1", sessionId: sid(1), containerName: "hp_svc_svc_1" },
    });
    expect(await findTerminalSession(client.db, sid(1), "u_other")).toBeNull();
    expect((await listOpenTerminalSessions(client.db)).map((r) => r.id)).toEqual([sid(1)]);
  });

  it("refuses a second session on a site and a fifth on the server, writing nothing", async () => {
    expect(await open(1, "site_x")).toBe("opened");
    const before = await snapshot();
    expect(await open(2, "site_x")).toBe("site_busy");
    expect(await snapshot()).toEqual(before);
    for (const n of [3, 4, 5]) expect(await open(n)).toBe("opened");
    const full = await snapshot();
    expect(await open(6)).toBe("server_full");
    expect(await snapshot()).toEqual(full);
  });

  it("closes once: true then false, one close row with the duration", async () => {
    await open(1);
    await client.db.execute(sql`UPDATE admin_terminal_sessions SET opened_at = '2026-11-17T10:00:00Z' WHERE id = ${sid(1)}`);
    const endedAt = new Date("2026-11-17T10:01:30.400Z");
    expect(await closeTerminalSession(client.db, { id: sid(1), reason: "idle", endedAt, actorType: "system" })).toBe(true);
    expect(await closeTerminalSession(client.db, { id: sid(1), reason: "closed", endedAt: null, actorType: "user", requestId: "req_c" })).toBe(false);
    const rows = await audits("admin.terminal.close");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: "u_admin", actorType: "system", organizationId: "org_a", targetType: "site", targetId: "site_1",
      details: { outcome: "succeeded", sessionId: sid(1), containerName: "hp_svc_svc_1", reason: "idle", durationSeconds: 90 },
    });
    const row = await findTerminalSession(client.db, sid(1), "u_admin");
    expect(row?.closeReason).toBe("idle");
    expect(row?.closedAt?.toISOString()).toBe(endedAt.toISOString());
    expect(await listOpenTerminalSessions(client.db)).toEqual([]);
  });

  it("closes the session of a user and organization that are gone with null ids", async () => {
    // Audit rows are immutable, so a user with audit rows cannot be deleted: a row with no user stands in.
    await client.db.insert(adminTerminalSessions).values({ id: sid(1), userId: "u_gone", siteId: "site_1", organizationId: "org_gone", containerName: "hp_svc_svc_1" });
    expect(await closeTerminalSession(client.db, { id: sid(1), reason: "executor_gone", endedAt: null, actorType: "system", requestId: "req_s" })).toBe(true);
    const rows = await audits("admin.terminal.close");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actorId).toBeNull();
    expect(rows[0]?.organizationId).toBeNull();
    expect(rows[0]?.details).toMatchObject({ reason: "executor_gone", requestId: "req_s" });
  });

  it("the CHECK refuses closed_at without a reason and an unknown reason", async () => {
    await open(1);
    await expect(client.db.execute(sql`UPDATE admin_terminal_sessions SET closed_at = now() WHERE id = ${sid(1)}`)).rejects.toThrow();
    await expect(
      client.db.execute(sql`UPDATE admin_terminal_sessions SET closed_at = now(), close_reason = 'typed_exit' WHERE id = ${sid(1)}`),
    ).rejects.toThrow();
  });
});
