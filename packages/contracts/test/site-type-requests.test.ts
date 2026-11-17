import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  BackupsIpcRequestSchema,
  SITE_FILES_CORE_REQUESTS,
  SITE_FILES_CORE_RESULTS,
  SITE_FILES_RESULT_SCHEMAS,
  SITE_FILE_ERROR_REASONS,
  SITE_FILE_REASON_CODES,
  SITE_TYPE_FILES_REQUESTS,
  SITE_TYPE_FILES_RESULTS,
  SITE_TYPE_FILE_ERROR_REASONS,
  SITE_TYPE_FILE_REASON_CODES,
  SftpAccessApplyIpcRequestSchema,
  SiteDatabasesIpcRequestSchema,
  SiteFilesIpcRequestSchema,
  TerminalOpenIpcRequestSchema,
} from "../src/index.js";

const SVC = "svc_site_1";
const UPLOAD = "upload_0123456789ab";
const IMPORT = "0123456789abcdef0123456789abcdef";
const TARGET = {
  endpoint: "https://s3.example.test",
  region: "us-east-1",
  bucket: "backups",
  prefix: "",
  accessKeyId: "sentinel-access-key",
  secretAccessKey: "sentinel-secret-key",
};
const JOB = `op_${"a".repeat(32)}`;

// One valid request per files op of today's union, without siteType.
const FILES_REQUESTS: Record<string, Record<string, unknown>> = {
  list: { op: "list", path: "" },
  stat: { op: "stat", path: "index.php" },
  read: { op: "read", path: "index.php", offset: 0, length: 10 },
  write: { op: "write", path: "a.txt", uploadId: UPLOAD, offset: 0, dataBase64: "YQ==", final: true, overwrite: false },
  mkdir: { op: "mkdir", path: "dir" },
  move: { op: "move", from: "a.txt", to: "b.txt" },
  delete: { op: "delete", paths: ["a.txt"] },
  archive: { op: "archive", paths: ["a.txt"], to: "a.zip" },
  extract: { op: "extract", path: "a.zip", to: "" },
  "import.put": { op: "import.put", slot: "archive", uploadId: UPLOAD, offset: 0, dataBase64: "YQ==", final: false },
  "import.take": { op: "import.take", slot: "dump", path: "dump.sql" },
  "import.stat": { op: "import.stat" },
  "import.discard": { op: "import.discard" },
  "import.unpack": { op: "import.unpack", importId: IMPORT },
  "import.switch": { op: "import.switch", importId: IMPORT },
  "import.undo": { op: "import.undo", importId: IMPORT },
  "import.finish": { op: "import.finish", importId: IMPORT },
};

const TODAY_OPS = Object.keys(FILES_REQUESTS);
const TODAY_REASONS = [
  "invalid_path", "not_found", "exists", "not_a_directory", "is_a_directory", "protected", "too_large",
  "archive_limit", "upload_mismatch", "not_a_zip", "disk_full", "archive_unsafe", "zip_unavailable", "not_ready",
  "files_missing", "archive_not_wordpress", "staging_unsafe", "dump_not_sql",
];

const BACKUP_REQUESTS: Record<string, Record<string, unknown>> = {
  start: { action: "start", jobId: JOB, siteId: "site_1", serviceInstanceId: SVC, target: TARGET },
  restore: { action: "restore", jobId: JOB, siteId: "site_1", serviceInstanceId: SVC, target: TARGET, snapshotId: "b".repeat(64) },
  siteState: { action: "siteState", siteId: "site_1", serviceInstanceId: SVC },
};
const SFTP_USER = {
  username: "acme_editor",
  passwordHash: `$6$sentinelsalt$${"c".repeat(86)}`,
  siteId: "site_1",
  serviceInstanceId: SVC,
};
const TERMINAL_OPEN = { sessionId: `term_${"d".repeat(32)}`, siteId: "site_1", serviceInstanceId: SVC };

function checkKey(schema: z.ZodType, request: Record<string, unknown>, wrap = (r: Record<string, unknown>): unknown => r): void {
  // Each sample is already canonical, so today's parse returns it unchanged.
  expect(schema.parse(wrap(request))).toEqual(wrap(request));
  expect(schema.parse(wrap({ ...request, siteType: "wordpress" }))).toEqual(wrap({ ...request, siteType: "wordpress" }));
  expect(schema.safeParse(wrap({ ...request, siteType: "static" })).success).toBe(false);
  expect(schema.safeParse(wrap({ ...request, siteType: null })).success).toBe(false);
}

describe("site type key on the executor requests", () => {
  it.each(TODAY_OPS)("files %s: absent parses as today, wordpress parses, another word is refused", (op) => {
    checkKey(SiteFilesIpcRequestSchema, { serviceInstanceId: SVC, ...FILES_REQUESTS[op] });
  });

  it.each(Object.keys(BACKUP_REQUESTS))("backups %s carries the optional key", (action) => {
    checkKey(BackupsIpcRequestSchema, BACKUP_REQUESTS[action]!);
  });

  it("each SFTP access user carries the optional key", () => {
    checkKey(SftpAccessApplyIpcRequestSchema, SFTP_USER, (u) => ({ users: [u] }));
  });

  it("the terminal open request carries the optional key", () => {
    checkKey(TerminalOpenIpcRequestSchema, TERMINAL_OPEN);
  });

  it("the other backups requests and the database requests take no key", () => {
    const status = { action: "status", jobId: JOB };
    expect(BackupsIpcRequestSchema.safeParse(status).success).toBe(true);
    expect(BackupsIpcRequestSchema.safeParse({ ...status, siteType: "wordpress" }).success).toBe(false);
    expect(SiteDatabasesIpcRequestSchema.safeParse({ siteId: "site_1", op: "list" }).success).toBe(true);
    expect(SiteDatabasesIpcRequestSchema.safeParse({ siteId: "site_1", op: "list", siteType: "wordpress" }).success).toBe(false);
  });
});

describe("the composed files union", () => {
  it("has today's set of operations and results", () => {
    const ops = SiteFilesIpcRequestSchema.options.map((o) => o.shape.op.value);
    expect(ops).toEqual(TODAY_OPS);
    expect(Object.keys(SITE_FILES_RESULT_SCHEMAS)).toEqual(TODAY_OPS);
    expect(SITE_FILES_CORE_REQUESTS.map((o) => o.shape.op.value)).toEqual(TODAY_OPS.slice(0, 9));
    expect(SITE_TYPE_FILES_REQUESTS.map((o) => o.shape.op.value)).toEqual(TODAY_OPS.slice(9));
    expect(Object.keys(SITE_FILES_CORE_RESULTS)).toEqual(TODAY_OPS.slice(0, 9));
    expect(Object.keys(SITE_TYPE_FILES_RESULTS)).toEqual(TODAY_OPS.slice(9));
  });

  it("has today's reasons in today's order, with today's codes", () => {
    expect(SITE_FILE_ERROR_REASONS).toEqual(TODAY_REASONS);
    expect(SITE_TYPE_FILE_ERROR_REASONS).toEqual(["files_missing", "archive_not_wordpress", "staging_unsafe", "dump_not_sql"]);
    expect(Object.keys(SITE_FILE_REASON_CODES).sort()).toEqual([...TODAY_REASONS].sort());
    expect(SITE_TYPE_FILE_REASON_CODES).toEqual({
      files_missing: "NOT_FOUND",
      archive_not_wordpress: "VALIDATION_ERROR",
      staging_unsafe: "RESOURCE_LOCKED",
      dump_not_sql: "VALIDATION_ERROR",
    });
    expect(SITE_FILE_REASON_CODES.not_ready).toBe("RESOURCE_LOCKED");
    expect(SITE_FILE_REASON_CODES.archive_not_wordpress).toBe("VALIDATION_ERROR");
  });
});
