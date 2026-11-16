import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  createPasswordResetToken,
  eq,
  passwordResetTokens,
  sql,
  usePasswordResetToken,
  users,
  type DatabaseClient,
} from "../src/index.js";

describe("password reset tokens", () => {
  let client: DatabaseClient;
  let n = 0;
  const hash = () => `sentinel-hash-${++n}`;
  const create = (userId: string, tokenHash = hash()) => createPasswordResetToken(client.db, { userId, tokenHash });
  const rows = (userId: string) => client.db.select().from(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));
  const age = (minutes: number) =>
    client.db.execute(sql`UPDATE password_reset_tokens SET created_at = created_at - make_interval(mins => ${minutes}), expires_at = expires_at - make_interval(mins => ${minutes})`);

  beforeEach(async () => {
    n = 0;
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await client.db.insert(users).values(
      Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, email: `u${i}@example.test`, name: `U${i}` })),
    );
  });

  afterEach(async () => {
    await client.close();
  });

  it("allows three tokens an account an hour; a new one retires the older ones", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await create("u0"));
    expect(results).toEqual([true, true, true, false]);
    const list = await rows("u0");
    expect(list).toHaveLength(3);
    expect(list.filter((r) => r.usedAt === null).map((r) => r.tokenHash)).toEqual(["sentinel-hash-3"]);
    expect(list.every((r) => r.expiresAt.getTime() - r.createdAt.getTime() === 30 * 60_000)).toBe(true);
  });

  it("allows twenty tokens an hour over all accounts", async () => {
    const results = [];
    for (let i = 0; i < 21; i++) results.push(await create(`u${i % 7}`));
    expect(results.filter(Boolean)).toHaveLength(20);
    expect(results[20]).toBe(false);
  });

  it("purges rows older than an hour on the next insert, which frees the limits", async () => {
    for (let i = 0; i < 3; i++) await create("u0");
    await age(61);
    expect(await create("u0", "sentinel-hash-fresh")).toBe(true);
    expect((await rows("u0")).map((r) => r.tokenHash)).toEqual(["sentinel-hash-fresh"]);
  });

  it("uses a token once; an expired or retired token is refused", async () => {
    await create("u0", "sentinel-hash-a");
    expect(await usePasswordResetToken(client.db, "sentinel-hash-a")).toBe("u0");
    expect(await usePasswordResetToken(client.db, "sentinel-hash-a")).toBeNull();
    expect(await usePasswordResetToken(client.db, "sentinel-hash-unknown")).toBeNull();

    await create("u1", "sentinel-hash-old");
    await create("u1", "sentinel-hash-new");
    expect(await usePasswordResetToken(client.db, "sentinel-hash-old")).toBeNull();

    await age(31);
    expect(await usePasswordResetToken(client.db, "sentinel-hash-new")).toBeNull();
  });

  it("refuses an unknown user and cascades on user delete", async () => {
    expect(await create("nobody")).toBe(false);
    await create("u2");
    await client.db.delete(users).where(eq(users.id, "u2"));
    expect(await rows("u2")).toEqual([]);
  });
});
