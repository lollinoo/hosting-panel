import { auditEvents, createDatabaseClient, DEMO_IDS, eq, type DatabaseClient } from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

describe("a member removed from an organisation", () => {
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
    for (const userId of [DEMO_IDS.users.elena, DEMO_IDS.users.marco]) {
      const res = await fetch(`${app.baseUrl!}/v1/dev/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      tokens[userId] = ((await res.json()) as { data: { accessToken: string } }).data.accessToken;
    }
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  const call = (method: string, path: string, userId: string) =>
    fetch(`${app.baseUrl!}${path}`, { method, headers: { Authorization: `Bearer ${tokens[userId]!}` } });

  it("is refused with the token they already hold on the next request to a site of that organisation", async () => {
    const site = `/v1/organizations/${DEMO_IDS.organizations.acme}/managed-sites/${DEMO_IDS.sites.acmeShop}`;
    expect((await call("GET", site, DEMO_IDS.users.marco)).status).toBe(200);

    const members = (await (await call("GET", `/v1/organizations/${DEMO_IDS.organizations.acme}/members`, DEMO_IDS.users.elena)).json()) as {
      data: { id: string; userId: string }[];
    };
    const marco = members.data.find((m) => m.userId === DEMO_IDS.users.marco)!;
    const removed = await call("DELETE", `/v1/organizations/${DEMO_IDS.organizations.acme}/members/${marco.id}`, DEMO_IDS.users.elena);
    expect(removed.status).toBe(200);

    const rowsBefore = (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.actorId, DEMO_IDS.users.marco))).length;
    const after = await call("GET", site, DEMO_IDS.users.marco);
    expect(after.status).toBe(404);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    // The token itself still works elsewhere: the refusal comes from the membership, read again on this request.
    expect((await call("GET", "/v1/me", DEMO_IDS.users.marco)).status).toBe(200);
    expect((await dbClient.db.select().from(auditEvents).where(eq(auditEvents.actorId, DEMO_IDS.users.marco))).length).toBe(rowsBefore);
  });
});
