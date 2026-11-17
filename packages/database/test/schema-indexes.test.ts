import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/schema.js";
import { createDatabaseClient, type DatabaseClient } from "../src/index.js";

// The runner applies only the .sql files, so an index declared in schema.ts exists only if a migration creates it.
describe("@hosting-panel/database — every index of the schema exists after the migrations", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
  });

  afterAll(async () => {
    await client.close();
  });

  it("creates each index that schema.ts declares, on its table", async () => {
    const declared = Object.values(schema)
      .filter((value: unknown): value is PgTable => value instanceof PgTable)
      .flatMap((table) => {
        const config = getTableConfig(table);
        return config.indexes.map((index) => `${config.name}.${index.config.name}`);
      })
      .sort();
    const result = await client.db.execute(
      sql`SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const present = new Set(
      (result.rows as Array<{ tablename: string; indexname: string }>).map(
        (row) => `${row.tablename}.${row.indexname}`,
      ),
    );

    expect(declared.length).toBeGreaterThan(20);
    expect(declared.filter((name) => !present.has(name))).toEqual([]);
  });

  it("indexes the steps of an operation by operation", () => {
    const config = getTableConfig(schema.operationSteps);
    expect(config.indexes.map((index) => index.config.name)).toContain("idx_operation_steps_operation");
  });
});
