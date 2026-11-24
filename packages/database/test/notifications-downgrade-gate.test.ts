import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMigrationsDirectory } from "../src/index.js";

// ADR-0040 N12: the hp-update downgrade gate of infra/linux/lib/common.sh for notifications, its own SQL text run on
// the real schema. A release without notifications sends nothing, and nobody would be told that the alerts went silent.
const dir = resolveMigrationsDirectory();
const migrations = readdirSync(dir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const COMMON = readFileSync(path.resolve(dir, "../../../infra/linux/lib/common.sh"), "utf8");

function only(pattern: RegExp): string {
  const found = [...COMMON.matchAll(pattern)].map((m) => m[1]!);
  if (found.length !== 1) throw new Error(`${pattern} matches ${found.length} times in common.sh: the gate text moved`);
  return found[0]!;
}
const MIGRATIONS_SQL = only(/"(select filename from public\.schema_migrations where filename in \([^)]*\))"/g);
const PREDICATE_SQL = only(/"(select 'notifications' where exists \([^"]*\))"/g);

const SEED = `
  INSERT INTO platform_installations (id, name) VALUES ('pi','pi');
  INSERT INTO organizations (id, platform_installation_id, name, slug) VALUES ('o','pi','o','o');`;

let pg: PGlite;
const gate = async () => (await pg.query(PREDICATE_SQL)).rows.map((r) => Object.values(r as object));

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec("CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  for (const file of migrations) {
    await pg.exec(readFileSync(path.join(dir, file), "utf8"));
    await pg.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
  }
  await pg.exec(SEED);
}, 120_000);
afterAll(async () => {
  await pg.close();
});

describe("hp-update downgrade gate notifications", () => {
  it("the migrations query names 0029_notifications.sql as recorded", async () => {
    const files = (await pg.query<{ filename: string }>(MIGRATIONS_SQL)).rows.map((r) => r.filename);
    expect(files).toContain("0029_notifications.sql");
  });

  it("does not hold on a panel where nobody set a channel", async () => {
    expect(await gate()).toEqual([]);
  });

  it("holds while the server has a channel, also a channel that is turned off", async () => {
    await pg.exec(`INSERT INTO notification_channels (id, organization_id, kind, groups, recipients)
      VALUES ('nch_srv',NULL,'email','["server"]','["ops@example.com"]')`);
    expect(await gate()).toEqual([["notifications"]]);
    await pg.exec("UPDATE notification_channels SET enabled = FALSE WHERE id = 'nch_srv'");
    expect(await gate()).toEqual([["notifications"]]);
    await pg.exec("DELETE FROM notification_channels WHERE id = 'nch_srv'");
    expect(await gate()).toEqual([]);
  });

  it("holds while a customer has a channel, and no longer once it is removed", async () => {
    await pg.exec(`INSERT INTO notification_channels (id, organization_id, kind, groups, chat, config_ciphertext_base64,
      config_iv_base64, config_auth_tag_base64) VALUES ('nch_org','o','telegram','["availability"]','-1001234567890','c','i','t')`);
    expect(await gate()).toEqual([["notifications"]]);
    await pg.exec("DELETE FROM notification_channels WHERE id = 'nch_org'");
    expect(await gate()).toEqual([]);
  });

  it("the outcome of old messages does not hold it: they go with their channel", async () => {
    await pg.exec(`INSERT INTO notification_channels (id, organization_id, kind, groups, recipients)
      VALUES ('nch_old',NULL,'email','["server"]','["ops@example.com"]')`);
    await pg.exec(`INSERT INTO notification_deliveries (id, channel_id, events, locale, status, finished_at)
      VALUES ('ndl_old','nch_old','[]','it','sent', now())`);
    await pg.exec(`INSERT INTO notification_channel_alerts (channel_id, alert_key, kind, severity, event)
      VALUES ('nch_old','disk_high','disk_high','critical','{}')`);
    await pg.exec("DELETE FROM notification_channels WHERE id = 'nch_old'");
    expect(await gate()).toEqual([]);
    expect((await pg.query("SELECT 1 FROM notification_deliveries UNION ALL SELECT 1 FROM notification_channel_alerts")).rows).toEqual([]);
  });

  it("names the schema and never schema_migrations (the psql stub of features-gate.test.ts)", () => {
    expect(PREDICATE_SQL).toContain("public.");
    expect(PREDICATE_SQL).not.toContain("schema_migrations");
  });
});
