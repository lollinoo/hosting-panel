import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_IDS,
  createDatabaseClient,
  eq,
  seedPhase1Dataset,
  sql,
  userSessions,
  users,
  type DatabaseClient,
} from "../src/index.js";

describe("@hosting-panel/database — 0003 production accounts", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
  });

  afterAll(async () => {
    await client.close();
  });

  it("applies 0003 and exposes new users columns", async () => {
    await client.db.insert(users).values({ id: "u_a", email: "a@x.io", name: "A" });
    const [row] = await client.db.select().from(users).where(eq(users.id, "u_a"));
    expect(row?.locale).toBe("it");
    expect(row?.mustChangePassword).toBe(false);
    expect(row?.failedLoginCount).toBe(0);
    expect(row?.platformRole).toBeNull();
  });

  it("totp_failed_count defaults to 0", async () => {
    await client.db.insert(users).values({ id: "u_t", email: "t@x.io", name: "T" });
    const [row] = await client.db.select().from(users).where(eq(users.id, "u_t"));
    expect(row?.totpFailedCount).toBe(0);
  });

  it("rejects locale outside it/en", async () => {
    await expect(
      client.db.execute(sql`INSERT INTO users (id, email, name, locale) VALUES ('u_b','b@x.io','B','fr')`),
    ).rejects.toThrow();
  });

  it("rejects platform_role other than infrastructure_admin", async () => {
    await expect(
      client.db.execute(
        sql`INSERT INTO users (id, email, name, platform_role) VALUES ('u_c','c@x.io','C','hosting_admin')`,
      ),
    ).rejects.toThrow();
  });

  it("cascades sessions on user delete", async () => {
    await client.db.insert(userSessions).values({ id: "s1", userId: "u_a", expiresAt: new Date(Date.now() + 1000) });
    await client.db.delete(users).where(eq(users.id, "u_a"));
    expect(await client.db.select().from(userSessions)).toHaveLength(0);
  });

  it("seed marks usr_infra as server admin", async () => {
    await seedPhase1Dataset(client.db);
    const rows = await client.db.select().from(users);
    expect(rows.find((r) => r.id === DEMO_IDS.users.infra)?.platformRole).toBe("infrastructure_admin");
    expect(rows.find((r) => r.id === DEMO_IDS.users.elena)?.platformRole).toBeNull();
  });
});
