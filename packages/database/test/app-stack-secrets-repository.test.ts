import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  APP_STACK_SECRET_VERSIONS_PER_HOUR,
  appStacks,
  appStackSecretAad,
  AppStackSecretError,
  appStackSecrets,
  appTemplates,
  appTemplateVersions,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
  insertGeneratedAppStackSecrets,
  listAppStackSecretMetadata,
  organizations,
  platformInstallations,
  readAppStackSecretFiles,
  setAppStackSecretTransactional,
  type DatabaseClient,
} from "../src/index.js";

const KEY = "c".repeat(64);
const SENTINEL = "sentinel-value-7f3a";

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "NO_ERROR";
  } catch (err) {
    return err instanceof AppStackSecretError ? err.code : "OTHER";
  }
}

describe("@hosting-panel/database - app stack secrets repository", () => {
  let client: DatabaseClient;
  const db = () => client.db;
  let counter = 0;
  const newStack = async (organizationId = "org_a", deleted = false) => {
    counter += 1;
    const id = `stk_s${String(counter)}`;
    await db().insert(appStacks).values({
      id, organizationId, hostAllocationId: organizationId === "org_a" ? "al_a" : "al_b", templateId: "atpl_s",
      templateVersionId: "atv_s", name: id, ...(deleted ? { status: "deleted" as const, deletedAt: new Date() } : {}),
    });
    return id;
  };
  const set = (stackId: string, parameterKey: string, value: string, organizationId = "org_a") =>
    setAppStackSecretTransactional(db(), { organizationId, stackId, parameterKey, value, masterKey: KEY });
  const read = (stackId: string, refs: { parameterKey: string; version: number }[], organizationId = "org_a") =>
    readAppStackSecretFiles(db(), { organizationId, stackId, masterKey: KEY, refs });

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin", name: "P" });
    await db().insert(hosts).values({
      id: "h1", platformInstallationId: "pin", name: "h", hostname: "h.local", ipv4Address: "10.0.0.1",
      totalCpuMilli: 4000, totalMemoryBytes: "4000000000", totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values([
      { id: "org_a", platformInstallationId: "pin", name: "A", slug: "a" },
      { id: "org_b", platformInstallationId: "pin", name: "B", slug: "b" },
    ]);
    await db().insert(hostAllocations).values([
      { id: "al_a", hostId: "h1", organizationId: "org_a" },
      { id: "al_b", hostId: "h1", organizationId: "org_b" },
    ]);
    await db().insert(appTemplates).values({ id: "atpl_s", slug: "secrets", name: "S", category: "web" });
    await db().insert(appTemplateVersions).values({
      id: "atv_s", templateId: "atpl_s", versionNumber: 1, source: "# s\n", specVersion: 1, compiledSchema: {}, specHash: "a".repeat(64),
    });
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("binds the AAD to organization, stack, parameter and version", () => {
    expect(appStackSecretAad("org_a", "stk_x", "db_password", 3)).toEqual({
      organizationId: "org_a", siteId: null, secretKey: "app:stk_x:db_password:3",
    });
  });

  it("sets v1 then v2 and returns metadata only, never the value", async () => {
    const stackId = await newStack();
    const v1 = await set(stackId, "db_password", `${SENTINEL}-1`);
    const v2 = await set(stackId, "db_password", `${SENTINEL}-2`);
    expect(Object.keys(v1).sort()).toEqual(["parameterKey", "rotatedAt", "version"]);
    expect(v1).toMatchObject({ parameterKey: "db_password", version: 1 });
    expect(v2).toMatchObject({ parameterKey: "db_password", version: 2 });
    expect(v1.rotatedAt).toBeInstanceOf(Date);
    const rows = await db().select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId));
    expect(rows.map((r) => r.id).every((id) => /^ssec_[0-9a-f]{24}$/.test(id))).toBe(true);
    expect(JSON.stringify([v1, v2, await db().select().from(appStackSecrets)])).not.toContain(SENTINEL);
  });

  it("refuses an empty, too long or badly keyed value with VALIDATION_ERROR and stores nothing", async () => {
    const stackId = await newStack();
    expect(await codeOf(set(stackId, "db_password", ""))).toBe("VALIDATION_ERROR");
    expect(await codeOf(set(stackId, "db_password", "x".repeat(16_385)))).toBe("VALIDATION_ERROR");
    expect(await codeOf(set(stackId, "db_password", "é".repeat(16_384)))).toBe("VALIDATION_ERROR");
    expect(await codeOf(set(stackId, "Bad-Key", "x"))).toBe("VALIDATION_ERROR");
    expect(await codeOf(set(stackId, "db-password", "x"))).toBe("VALIDATION_ERROR");
    expect(await db().select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId))).toEqual([]);
    expect(await set(stackId, "db_password", "x".repeat(16_384))).toMatchObject({ version: 1 });
  });

  it("refuses another organization's stack, a deleted stack and an unknown stack with NOT_FOUND", async () => {
    const stackId = await newStack();
    const deleted = await newStack("org_a", true);
    expect(await codeOf(set(stackId, "db_password", "x", "org_b"))).toBe("NOT_FOUND");
    expect(await codeOf(set(deleted, "db_password", "x"))).toBe("NOT_FOUND");
    expect(await codeOf(set("stk_missing", "db_password", "x"))).toBe("NOT_FOUND");
  });

  it("reads exactly the pinned versions, v1 still readable after v2", async () => {
    const stackId = await newStack();
    await set(stackId, "db_password", "first");
    await set(stackId, "db_password", "second");
    await set(stackId, "api_key", "third");
    expect(await read(stackId, [{ parameterKey: "db_password", version: 1 }, { parameterKey: "api_key", version: 1 }])).toEqual([
      { parameterKey: "db_password", version: 1, content: "first" },
      { parameterKey: "api_key", version: 1, content: "third" },
    ]);
    expect(await read(stackId, [{ parameterKey: "db_password", version: 2 }])).toEqual([
      { parameterKey: "db_password", version: 2, content: "second" },
    ]);
    expect(await read(stackId, [])).toEqual([]);
  });

  it("refuses a missing pinned pair with SECRET_MISSING, also from another organization", async () => {
    const stackId = await newStack();
    await set(stackId, "db_password", SENTINEL);
    expect(await codeOf(read(stackId, [{ parameterKey: "db_password", version: 2 }]))).toBe("SECRET_MISSING");
    expect(await codeOf(read(stackId, [{ parameterKey: "other", version: 1 }]))).toBe("SECRET_MISSING");
    expect(await codeOf(read(stackId, [{ parameterKey: "db_password", version: 1 }], "org_b"))).toBe("SECRET_MISSING");
    const err = await read(stackId, [{ parameterKey: "db_password", version: 1 }, { parameterKey: "x", version: 1 }]).catch((e: unknown) => e);
    expect(String((err as Error).message)).not.toContain(SENTINEL);
  });

  it("fails to decrypt a ciphertext moved to another version or another stack (AAD)", async () => {
    const stackA = await newStack();
    const stackB = await newStack();
    await set(stackA, "db_password", SENTINEL);
    const [source] = await db()
      .select()
      .from(appStackSecrets)
      .where(and(eq(appStackSecrets.stackId, stackA), eq(appStackSecrets.parameterKey, "db_password")));
    if (!source) throw new Error("seed row missing");
    const envelope = { ciphertextBase64: source.ciphertextBase64, ivBase64: source.ivBase64, authTagBase64: source.authTagBase64 };
    await db().insert(appStackSecrets).values([
      { id: "ssec_moved_version", stackId: stackA, organizationId: "org_a", parameterKey: "db_password", version: 5, ...envelope },
      { id: "ssec_moved_stack", stackId: stackB, organizationId: "org_a", parameterKey: "db_password", version: 1, ...envelope },
    ]);
    await expect(read(stackA, [{ parameterKey: "db_password", version: 5 }])).rejects.toThrow();
    await expect(read(stackB, [{ parameterKey: "db_password", version: 1 }])).rejects.toThrow();
    expect(await read(stackA, [{ parameterKey: "db_password", version: 1 }])).toEqual([
      { parameterKey: "db_password", version: 1, content: SENTINEL },
    ]);
  });

  it("lists the latest version per key, ordered by key, and nothing for another organization", async () => {
    const stackId = await newStack();
    await set(stackId, "zeta", "z");
    await set(stackId, "alpha", "a1");
    await set(stackId, "alpha", "a2");
    const list = await listAppStackSecretMetadata(db(), { organizationId: "org_a", stackId });
    expect(list.map(({ parameterKey, version }) => ({ parameterKey, version }))).toEqual([
      { parameterKey: "alpha", version: 2 },
      { parameterKey: "zeta", version: 1 },
    ]);
    expect(Object.keys(list[0] ?? {}).sort()).toEqual(["parameterKey", "rotatedAt", "version"]);
    expect(await listAppStackSecretMetadata(db(), { organizationId: "org_b", stackId })).toEqual([]);
  });

  it("refuses the 11th version of a stack within an hour with RATE_LIMITED, any key, and stores nothing", async () => {
    expect(APP_STACK_SECRET_VERSIONS_PER_HOUR).toBe(10);
    const stackId = await newStack();
    const other = await newStack();
    for (let i = 1; i <= 10; i += 1) await set(stackId, i % 2 === 0 ? "db_password" : "api_key", `v${String(i)}`);
    const err = await set(stackId, "third_key", SENTINEL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppStackSecretError);
    expect((err as AppStackSecretError).code).toBe("RATE_LIMITED");
    expect((err as AppStackSecretError).retryAfterMs).toBeGreaterThan(3_500_000);
    expect((err as Error).message).not.toMatch(/db_password|api_key|third_key/);
    expect(await db().select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId))).toHaveLength(10);
    expect(await set(other, "db_password", "x")).toMatchObject({ version: 1 });
  });

  it("accepts a version again once the earlier ones are older than an hour", async () => {
    const stackId = await newStack();
    const old = new Date(Date.now() - 61 * 60_000);
    const [seed] = await db().select().from(appStackSecrets).limit(1);
    if (!seed) throw new Error("seed row missing");
    const envelope = { ciphertextBase64: seed.ciphertextBase64, ivBase64: seed.ivBase64, authTagBase64: seed.authTagBase64 };
    await db().insert(appStackSecrets).values(
      Array.from({ length: 10 }, (_, i) => ({
        id: `ssec_old_${String(i)}`, stackId, organizationId: "org_a", parameterKey: "db_password", version: i + 1, createdAt: old, ...envelope,
      })),
    );
    expect(await set(stackId, "db_password", "fresh")).toMatchObject({ version: 11 });
  });

  it("numbers two concurrent sets 1 and 2", async () => {
    const stackId = await newStack();
    const results = await Promise.all([set(stackId, "db_password", "a"), set(stackId, "db_password", "b")]);
    expect(results.map((r) => r.version).sort()).toEqual([1, 2]);
  });

  describe("values the platform generates (ADR-0036)", () => {
    const generate = (stackId: string, values: { parameterKey: string; value: string }[], organizationId = "org_a") =>
      insertGeneratedAppStackSecrets(db(), { organizationId, stackId, masterKey: KEY, values });
    const stored = async (stackId: string) =>
      (await db().select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId)))
        .map((r) => `${r.parameterKey}:${String(r.version)}`)
        .sort();

    it("stores version 1 of each value, readable like any other secret, and returns metadata only", async () => {
      const stackId = await newStack();
      const made = await generate(stackId, [
        { parameterKey: "db_password", value: `${SENTINEL}-db` },
        { parameterKey: "admin_user", value: `${SENTINEL}-user` },
      ]);
      expect(made.map(({ parameterKey, version }) => ({ parameterKey, version }))).toEqual([
        { parameterKey: "db_password", version: 1 },
        { parameterKey: "admin_user", version: 1 },
      ]);
      expect(Object.keys(made[0] ?? {}).sort()).toEqual(["parameterKey", "rotatedAt", "version"]);
      expect(await read(stackId, [{ parameterKey: "db_password", version: 1 }, { parameterKey: "admin_user", version: 1 }])).toEqual([
        { parameterKey: "db_password", version: 1, content: `${SENTINEL}-db` },
        { parameterKey: "admin_user", version: 1, content: `${SENTINEL}-user` },
      ]);
      const rows = await db().select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId));
      expect(rows.every((r) => /^ssec_[0-9a-f]{24}$/.test(r.id) && r.organizationId === "org_a")).toBe(true);
      expect(JSON.stringify([made, rows])).not.toContain(SENTINEL);
      // The customer's next value of the same key is version 2.
      expect(await set(stackId, "db_password", "chosen")).toMatchObject({ parameterKey: "db_password", version: 2 });
    });

    it("never replaces a version that exists: the stored value stays and only the new keys come back", async () => {
      const stackId = await newStack();
      await set(stackId, "db_password", "typed-by-the-customer");
      const made = await generate(stackId, [
        { parameterKey: "db_password", value: "generated-later" },
        { parameterKey: "session_key", value: "generated-now" },
      ]);
      expect(made.map((m) => m.parameterKey)).toEqual(["session_key"]);
      expect(await stored(stackId)).toEqual(["db_password:1", "session_key:1"]);
      expect(await read(stackId, [{ parameterKey: "db_password", version: 1 }])).toEqual([
        { parameterKey: "db_password", version: 1, content: "typed-by-the-customer" },
      ]);
      // The same call again stores nothing and says so.
      expect(await generate(stackId, [{ parameterKey: "session_key", value: "another" }])).toEqual([]);
      expect(await read(stackId, [{ parameterKey: "session_key", version: 1 }])).toEqual([
        { parameterKey: "session_key", version: 1, content: "generated-now" },
      ]);
    });

    it("refuses the whole list for one bad entry with VALIDATION_ERROR and stores nothing", async () => {
      const stackId = await newStack();
      const good = { parameterKey: "db_password", value: "good-value" };
      for (const bad of [
        { parameterKey: "db_password", value: "twice" },
        { parameterKey: "Bad-Key", value: "x" },
        { parameterKey: "empty", value: "" },
        { parameterKey: "long", value: "x".repeat(16_385) },
        { parameterKey: "wide", value: "é".repeat(16_384) },
      ]) {
        expect(await codeOf(generate(stackId, [good, bad])), bad.parameterKey).toBe("VALIDATION_ERROR");
      }
      expect(await stored(stackId)).toEqual([]);
    });

    it("refuses another organization's stack, a deleted stack and an unknown stack with NOT_FOUND", async () => {
      const stackId = await newStack();
      const deleted = await newStack("org_a", true);
      const values = [{ parameterKey: "db_password", value: "x" }];
      expect(await codeOf(generate(stackId, values, "org_b"))).toBe("NOT_FOUND");
      expect(await codeOf(generate(deleted, values))).toBe("NOT_FOUND");
      expect(await codeOf(generate("stk_missing", values))).toBe("NOT_FOUND");
      expect(await stored(stackId)).toEqual([]);
      expect(await stored(deleted)).toEqual([]);
    });

    it("an empty list is nothing to do, whatever the stack", async () => {
      expect(await generate("stk_missing", [])).toEqual([]);
    });

    it("is not held by the hourly limit of the customer's own values, and its rows count in it afterwards", async () => {
      const full = await newStack();
      for (let i = 1; i <= 10; i += 1) await set(full, "api_key", `v${String(i)}`);
      expect(await codeOf(set(full, "api_key", "eleventh"))).toBe("RATE_LIMITED");
      expect((await generate(full, [{ parameterKey: "session_key", value: "made" }])).map((m) => m.parameterKey)).toEqual(["session_key"]);

      const fresh = await newStack();
      await generate(
        fresh,
        Array.from({ length: 8 }, (_, i) => ({ parameterKey: `generated_${String(i)}`, value: `value-${String(i)}` })),
      );
      expect(await set(fresh, "typed", "ninth")).toMatchObject({ version: 1 });
      expect(await set(fresh, "typed", "tenth")).toMatchObject({ version: 2 });
      expect(await codeOf(set(fresh, "typed", "eleventh"))).toBe("RATE_LIMITED");
    });

    it("rolls back with the transaction it is part of", async () => {
      const stackId = await newStack();
      const failure = new Error("the caller failed after storing");
      await expect(
        db().transaction(async (tx) => {
          await insertGeneratedAppStackSecrets(tx, { organizationId: "org_a", stackId, masterKey: KEY, values: [{ parameterKey: "db_password", value: "x" }] });
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await stored(stackId)).toEqual([]);
    });
  });
});
