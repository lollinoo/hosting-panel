import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import pg from "pg";
import * as schema from "./schema.js";

const { Pool } = pg;

export interface UnifiedPgQueryResult<TRow> {
  readonly rows: TRow[];
}

export interface UnifiedPgQueryResultHKT extends PgQueryResultHKT {
  readonly type: UnifiedPgQueryResult<this["row"]>;
}

export type DatabaseSchema = typeof schema;
export type DatabaseRelations = ExtractTablesWithRelations<DatabaseSchema>;

export type HostingPanelDatabase = PgDatabase<
  UnifiedPgQueryResultHKT,
  DatabaseSchema,
  DatabaseRelations
>;

export type HostingPanelTransaction = PgTransaction<
  UnifiedPgQueryResultHKT,
  DatabaseSchema,
  DatabaseRelations
>;

export type DatabaseExecutor = HostingPanelDatabase | HostingPanelTransaction;

export type DatabaseClientConfig =
  | {
      readonly mode: "pglite";
      readonly dataDir?: string;
    }
  | {
      readonly mode: "postgres";
      readonly connectionString: string;
      readonly maxConnections?: number;
    };

export interface DatabaseClient {
  readonly mode: "pglite" | "postgres";
  readonly db: HostingPanelDatabase;
  migrate(): Promise<string[]>;
  close(): Promise<void>;
}

const CREATE_SCHEMA_MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function resolveMigrationsDirectory(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDir, "migrations"),
    resolve(moduleDir, "../migrations"),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "0001_phase1_docker_native.sql"))) {
      return candidate;
    }
  }

  throw new Error(
    `Unable to locate SQL migrations directory (searched: ${candidates.join(", ")})`,
  );
}

function loadMigrationFiles(): ReadonlyArray<{ readonly filename: string; readonly sql: string }> {
  const migrationsDir = resolveMigrationsDirectory();
  const filenames = readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  if (filenames.length === 0) {
    throw new Error(`No .sql migration files found in ${migrationsDir}`);
  }

  return filenames.map((filename) => ({
    filename,
    sql: readFileSync(join(migrationsDir, filename), "utf8"),
  }));
}

export function createDatabaseClient(config: DatabaseClientConfig): DatabaseClient {
  if (config.mode === "pglite") {
    const pglite = config.dataDir ? new PGlite(config.dataDir) : new PGlite();
    const db = drizzlePglite(pglite, { schema }) as unknown as HostingPanelDatabase;
    let isClosed = false;

    return {
      mode: "pglite",
      db,
      async migrate(): Promise<string[]> {
        await pglite.waitReady;
        await pglite.exec(CREATE_SCHEMA_MIGRATIONS_SQL);

        const appliedRes = await pglite.query<{ filename: string }>(
          "SELECT filename FROM schema_migrations ORDER BY filename ASC",
        );
        const alreadyApplied = new Set(appliedRes.rows.map((row) => row.filename));

        const migrations = loadMigrationFiles();
        for (const migration of migrations) {
          if (alreadyApplied.has(migration.filename)) {
            continue;
          }

          await pglite.exec("BEGIN");
          try {
            await pglite.exec(migration.sql);
            await pglite.query(
              "INSERT INTO schema_migrations (filename) VALUES ($1)",
              [migration.filename],
            );
            await pglite.exec("COMMIT");
            alreadyApplied.add(migration.filename);
          } catch (error) {
            await pglite.exec("ROLLBACK");
            throw error;
          }
        }

        return migrations.map((migration) => migration.filename);
      },
      async close(): Promise<void> {
        if (isClosed) {
          return;
        }
        isClosed = true;
        await pglite.waitReady;
        if (!pglite.closed) {
          await pglite.close();
        }
      },
    };
  }

  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
  });
  const db = drizzleNodePg(pool, { schema }) as unknown as HostingPanelDatabase;
  let isClosed = false;

  return {
    mode: "postgres",
    db,
    async migrate(): Promise<string[]> {
      const migrations = loadMigrationFiles();
      const client = await pool.connect();
      try {
        await client.query(CREATE_SCHEMA_MIGRATIONS_SQL);
        const appliedRes = await client.query<{ filename: string }>(
          "SELECT filename FROM schema_migrations ORDER BY filename ASC",
        );
        const alreadyApplied = new Set(appliedRes.rows.map((row) => row.filename));

        for (const migration of migrations) {
          if (alreadyApplied.has(migration.filename)) {
            continue;
          }

          await client.query("BEGIN");
          try {
            await client.query(migration.sql);
            await client.query(
              "INSERT INTO schema_migrations (filename) VALUES ($1)",
              [migration.filename],
            );
            await client.query("COMMIT");
            alreadyApplied.add(migration.filename);
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          }
        }
      } finally {
        client.release();
      }
      return migrations.map((migration) => migration.filename);
    },
    async close(): Promise<void> {
      if (isClosed) {
        return;
      }
      isClosed = true;
      await pool.end();
    },
  };
}
