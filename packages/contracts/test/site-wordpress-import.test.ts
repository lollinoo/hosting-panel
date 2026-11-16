import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  HEAVY_BACKUP_OPERATION_KINDS,
  OPERATION_KINDS,
  SITE_IMPORT_LEFT_OUT,
  WORDPRESS_OPERATION_KINDS,
} from "../src/index.js";
import * as importContract from "../src/site-wordpress-import.js";
import {
  SiteWordpressImportChunkRequestSchema,
  SiteWordpressImportDtoSchema,
  SiteWordpressImportPickRequestSchema,
  SiteWordpressImportRunningOperationDtoSchema,
  SiteWordpressImportSlotDtoSchema,
  SiteWordpressImportStartRequestSchema,
  SiteWordpressLastImportDtoSchema,
  WORDPRESS_IMPORT_KIND,
  WORDPRESS_IMPORT_LEFT_OUT,
  WORDPRESS_IMPORT_OUTCOMES,
  WORDPRESS_IMPORT_REASONS,
  WORDPRESS_IMPORT_REFUSALS,
  WORDPRESS_IMPORT_SLOTS,
  WORDPRESS_IMPORT_STEP_KEYS,
  WordpressImportSlotSchema,
} from "../src/site-wordpress-import.js";

const slot = { state: "complete", size: 10, uploadId: "upload_0123456789abcdef" };
const lastImport = (over: Record<string, unknown> = {}) => ({
  operationId: `op_${"a".repeat(32)}`,
  finishedAt: "2026-11-16T10:00:00.000Z",
  outcome: "imported",
  reason: null,
  backup: "taken",
  oldAddress: "http://old.example.test",
  leftOut: ["wp-config.php", "wp-content/object-cache.php"],
  tables: 12,
  line: null,
  errorNumber: null,
  ...over,
});
const running = {
  id: `op_${"b".repeat(32)}`,
  kind: "site.wordpress.import",
  status: "processing",
  steps: [{ key: "check", status: "succeeded" }],
};
const state = (over: Record<string, unknown> = {}) => ({
  available: true,
  backupsConfigured: true,
  slots: { archive: slot, dump: { state: "empty", size: 0, uploadId: null } },
  earlierImportUnfinished: false,
  runningOperation: running,
  lastImport: lastImport(),
  ...over,
});
const chunk = (over: Record<string, unknown> = {}) => ({
  uploadId: "upload_0123456789abcdef",
  offset: 0,
  dataBase64: "QUJD",
  final: true,
  ...over,
});

describe("WordPress import contract", () => {
  it("adds the kind to the operations and the heavy actions, not to the WordPress tab's kinds", () => {
    expect(OPERATION_KINDS).toContain(WORDPRESS_IMPORT_KIND);
    expect(HEAVY_BACKUP_OPERATION_KINDS).toContain("site.wordpress.import");
    expect(WORDPRESS_OPERATION_KINDS).not.toContain("site.wordpress.import");
  });

  it("fixes the steps, the slots and the outcomes in order", () => {
    expect(WORDPRESS_IMPORT_STEP_KEYS).toEqual(["check", "backup", "unpack", "database", "switch", "finish"]);
    expect(WORDPRESS_IMPORT_SLOTS).toEqual(["archive", "dump"]);
    expect(WORDPRESS_IMPORT_OUTCOMES).toEqual(["imported", "nothing_changed", "site_restored", "undo_incomplete"]);
    expect(WordpressImportSlotSchema.safeParse("other").success).toBe(false);
  });

  it("holds the 29 reasons of R157, each once", () => {
    expect(new Set(WORDPRESS_IMPORT_REASONS).size).toBe(29);
    expect(WORDPRESS_IMPORT_REASONS).toHaveLength(29);
    expect([...WORDPRESS_IMPORT_REASONS].sort()).toEqual(
      [
        "files_missing", "earlier_import_unfinished", "backup_failed", "interrupted", "timed_out", "unavailable", "other",
        "archive_not_zip", "dump_not_sql", "archive_unsafe", "archive_limit", "archive_not_wordpress", "disk_full",
        "staging_unsafe", "dump_unsafe", "dump_too_large", "dump_incomplete", "dump_not_wordpress", "dump_ambiguous",
        "multisite_unsupported", "dump_objects_unsupported", "dump_names_unsupported", "address_unsupported",
        "dump_too_many_tables", "dump_load_failed", "dump_statement_unsupported", "site_objects_unsupported",
        "site_check_failed", "address_rewrite_failed",
      ].sort(),
    );
  });

  it("names the refusals and reuses the one left-out list", () => {
    expect(WORDPRESS_IMPORT_REFUSALS).toEqual(["import_running", "files_incomplete", "earlier_import_unfinished"]);
    expect(WORDPRESS_IMPORT_LEFT_OUT).toBe(SITE_IMPORT_LEFT_OUT);
  });

  it("accepts a full state and an outcome with nulls", () => {
    expect(SiteWordpressImportDtoSchema.parse(state())).toEqual(state());
    expect(SiteWordpressImportDtoSchema.safeParse(state({ slots: null, runningOperation: null, lastImport: null })).success).toBe(true);
    const failed = lastImport({ outcome: "nothing_changed", reason: "dump_statement_unsupported", oldAddress: null, leftOut: [], tables: null, line: 0, errorNumber: 1044 });
    expect(SiteWordpressLastImportDtoSchema.safeParse(failed).success).toBe(true);
    expect(SiteWordpressLastImportDtoSchema.safeParse(lastImport({ oldAddress: "http://old.example.test:8080" })).success).toBe(true);
  });

  it("refuses an unknown key on every schema", () => {
    const cases: [z.ZodType, unknown][] = [
      [SiteWordpressImportSlotDtoSchema, slot],
      [SiteWordpressImportRunningOperationDtoSchema, running],
      [SiteWordpressLastImportDtoSchema, lastImport()],
      [SiteWordpressImportDtoSchema, state()],
      [SiteWordpressImportChunkRequestSchema, chunk()],
      [SiteWordpressImportPickRequestSchema, { path: "site.zip" }],
      [SiteWordpressImportStartRequestSchema, { confirm: true }],
    ];
    for (const [schema, good] of cases) {
      expect(schema.safeParse(good).success).toBe(true);
      expect(schema.safeParse({ ...(good as object), extra: 1 }).success).toBe(false);
    }
    expect(SiteWordpressImportDtoSchema.safeParse(state({ slots: { archive: slot, dump: slot, x: slot } })).success).toBe(false);
    expect(SiteWordpressImportRunningOperationDtoSchema.safeParse({ ...running, steps: [{ key: "check", status: "succeeded", x: 1 }] }).success).toBe(false);
  });

  it("refuses an outcome outside its limits", () => {
    const bad = (over: Record<string, unknown>) => SiteWordpressLastImportDtoSchema.safeParse(lastImport(over)).success;
    expect(bad({ leftOut: [".htpanel-import"] })).toBe(false);
    expect(bad({ leftOut: ["wp-content/plugins"] })).toBe(false);
    expect(bad({ oldAddress: "http://old.example.test/blog" })).toBe(false);
    expect(bad({ line: -1 })).toBe(false);
    expect(bad({ errorNumber: 0 })).toBe(false);
    expect(bad({ errorNumber: 100000 })).toBe(false);
    expect(bad({ errorNumber: 99999 })).toBe(true);
    expect(bad({ reason: "something_else" })).toBe(false);
    expect(bad({ operationId: "op_1" })).toBe(false);
  });

  it("refuses a chunk with a negative offset, and the start without confirm", () => {
    expect(SiteWordpressImportChunkRequestSchema.safeParse(chunk({ offset: -1 })).success).toBe(false);
    expect(SiteWordpressImportChunkRequestSchema.safeParse(chunk({ uploadId: "short" })).success).toBe(false);
    expect(SiteWordpressImportStartRequestSchema.safeParse({}).success).toBe(false);
    expect(SiteWordpressImportStartRequestSchema.safeParse({ confirm: false }).success).toBe(false);
  });

  it("refuses a running operation of another kind or with an unknown step", () => {
    expect(SiteWordpressImportRunningOperationDtoSchema.safeParse({ ...running, kind: "site.wordpress.update" }).success).toBe(false);
    expect(SiteWordpressImportRunningOperationDtoSchema.safeParse({ ...running, steps: [{ key: "settle", status: "succeeded" }] }).success).toBe(false);
  });

  it("has no key named password in any schema", () => {
    const schemas = Object.values(importContract as Record<string, unknown>).filter((v): v is z.ZodType => v instanceof z.ZodType);
    expect(schemas.length).toBeGreaterThanOrEqual(8);
    for (const schema of schemas) {
      expect(JSON.stringify(z.toJSONSchema(schema, { unrepresentable: "any" }))).not.toMatch(/"password"/i);
    }
  });
});
