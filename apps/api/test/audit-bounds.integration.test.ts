import { and, auditEvents, createDatabaseClient, eq, sql, type DatabaseClient } from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { AuthzContextService } from "../src/auth/authz-context.service.js";

describe("the rows of refused requests are bounded per actor", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      seedPhase1: true,
      enableDevOidc: true,
    });
    for (const userId of ["usr_elena", "usr_marco"]) {
      const res = await fetch(`${app.baseUrl!}/v1/dev/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      tokens[userId] = ((await res.json()) as { data: { accessToken: string } }).data.accessToken;
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
    await dbClient.close();
  });

  const refuse = async (userId: string) => {
    const res = await fetch(`${app.baseUrl!}/v1/admin/users`, { headers: { Authorization: `Bearer ${tokens[userId]!}` } });
    expect(res.status).toBe(403);
  };
  const deniedRows = async (userId: string) =>
    (
      await dbClient.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.actorId, userId), sql`${auditEvents.details}->>'outcome' = 'denied'`))
    ).length;

  it("200 refused requests of one user inside one minute add 120 rows; the next minute and another user still get theirs", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    for (let i = 0; i < 200; i += 1) await refuse("usr_elena");
    expect(await deniedRows("usr_elena")).toBe(120);
    await refuse("usr_marco");
    expect(await deniedRows("usr_marco")).toBe(1);
    vi.setSystemTime(Date.now() + 61_000);
    await refuse("usr_elena");
    expect(await deniedRows("usr_elena")).toBe(121);
  }, 60_000);

  it("the first refusal the cap drops in a window writes one log line with the actor's id and nothing of the request", async () => {
    (app.nestApp.get(AuthzContextService) as unknown as { deniedWindows: Map<string, unknown> }).deniedWindows.clear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (let i = 0; i < 120; i += 1) await refuse("usr_marco");
      expect(warn).not.toHaveBeenCalled();
      for (let i = 0; i < 10; i += 1) await refuse("usr_marco");
      expect(warn.mock.calls).toEqual([[JSON.stringify({ event: "audit_denied_rows_capped", actorId: "usr_marco" })]]);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});
