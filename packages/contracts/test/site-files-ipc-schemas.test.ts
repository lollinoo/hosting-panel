import { describe, expect, it } from "vitest";
import {
  SITE_FILE_BATCH_MAX,
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_PATH_MAX,
  SITE_FILE_SEGMENT_MAX_BYTES,
  SITE_FILES_MAX_FILE_BYTES,
  SITE_FILES_RESULT_SCHEMAS,
  SiteFilesIpcRequestSchema,
} from "../src/index.js";

const SVC = "svc_site_1";
const UPLOAD_ID = "upload_0123456789ab";
const ISO_NOW = "2026-11-14T12:00:00.000Z";

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "index.php",
    kind: "file",
    size: 128,
    modifiedAt: ISO_NOW,
    writable: true,
    ...overrides,
  };
}

function validRequestsByOp() {
  return {
    list: { serviceInstanceId: SVC, op: "list" as const, path: "wp-content" },
    stat: { serviceInstanceId: SVC, op: "stat" as const, path: "index.php" },
    read: { serviceInstanceId: SVC, op: "read" as const, path: "index.php", offset: 0, length: 1024 },
    write: {
      serviceInstanceId: SVC,
      op: "write" as const,
      path: "index.php",
      uploadId: UPLOAD_ID,
      offset: 0,
      dataBase64: "AAAA",
      final: true,
      overwrite: true,
    },
    mkdir: { serviceInstanceId: SVC, op: "mkdir" as const, path: "wp-content/cache" },
    move: { serviceInstanceId: SVC, op: "move" as const, from: "a.txt", to: "b.txt" },
    delete: { serviceInstanceId: SVC, op: "delete" as const, paths: ["a.txt"] },
    archive: { serviceInstanceId: SVC, op: "archive" as const, paths: ["wp-content"], to: "backup.zip" },
    extract: { serviceInstanceId: SVC, op: "extract" as const, path: "backup.zip", to: "restored" },
  };
}

describe("SiteFilesIpcRequestSchema", () => {
  it("accepts valid payloads for all nine operations and rejects unknown ops", () => {
    const valid = validRequestsByOp();
    for (const req of Object.values(valid)) {
      expect(SiteFilesIpcRequestSchema.safeParse(req).success).toBe(true);
    }

    for (const op of ["sweep", "chmod", "rename", "", 123]) {
      expect(
        SiteFilesIpcRequestSchema.safeParse({ serviceInstanceId: SVC, op, path: "" }).success,
      ).toBe(false);
    }
  });

  it("enforces strict mode (rejects extra keys on every op)", () => {
    const valid = validRequestsByOp();
    for (const [op, req] of Object.entries(valid)) {
      const res = SiteFilesIpcRequestSchema.safeParse({ ...req, unexpected: "extra" });
      expect(res.success, `op=${op} should reject extra keys`).toBe(false);
    }
  });

  it("requires every mandatory field for each op", () => {
    const valid = validRequestsByOp();
    for (const [op, req] of Object.entries(valid)) {
      for (const key of Object.keys(req)) {
        const clone = { ...req } as Record<string, unknown>;
        delete clone[key];
        const res = SiteFilesIpcRequestSchema.safeParse(clone);
        expect(res.success, `op=${op} missing '${key}' should fail`).toBe(false);
      }
    }
  });

  it("enforces offset bounds (0..2 GiB integer) on read and write", () => {
    const valid = validRequestsByOp();
    for (const okOffset of [0, 512, SITE_FILES_MAX_FILE_BYTES]) {
      expect(
        SiteFilesIpcRequestSchema.safeParse({ ...valid.read, offset: okOffset }).success,
      ).toBe(true);
      expect(
        SiteFilesIpcRequestSchema.safeParse({ ...valid.write, offset: okOffset }).success,
      ).toBe(true);
    }

    for (const badOffset of [-1, 1.5, NaN, SITE_FILES_MAX_FILE_BYTES + 1]) {
      expect(
        SiteFilesIpcRequestSchema.safeParse({ ...valid.read, offset: badOffset }).success,
      ).toBe(false);
      expect(
        SiteFilesIpcRequestSchema.safeParse({ ...valid.write, offset: badOffset }).success,
      ).toBe(false);
    }
  });

  it("enforces read length bounds (1..SITE_FILE_CHUNK_BYTES)", () => {
    const baseRead = validRequestsByOp().read;
    expect(SiteFilesIpcRequestSchema.safeParse({ ...baseRead, length: 1 }).success).toBe(true);
    expect(
      SiteFilesIpcRequestSchema.safeParse({ ...baseRead, length: SITE_FILE_CHUNK_BYTES }).success,
    ).toBe(true);

    for (const badLength of [0, -1, 1.5, SITE_FILE_CHUNK_BYTES + 1]) {
      expect(SiteFilesIpcRequestSchema.safeParse({ ...baseRead, length: badLength }).success).toBe(
        false,
      );
    }
  });

  it("enforces batch bounds (1..SITE_FILE_BATCH_MAX) on delete and archive", () => {
    const valid = validRequestsByOp();
    const maxBatch = Array.from({ length: SITE_FILE_BATCH_MAX }, (_, i) => `file_${i}.txt`);
    const overBatch = Array.from({ length: SITE_FILE_BATCH_MAX + 1 }, (_, i) => `file_${i}.txt`);

    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.delete, paths: [] }).success).toBe(false);
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.delete, paths: maxBatch }).success).toBe(
      true,
    );
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.delete, paths: overBatch }).success).toBe(
      false,
    );

    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.archive, paths: [] }).success).toBe(
      false,
    );
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.archive, paths: maxBatch }).success).toBe(
      true,
    );
    expect(
      SiteFilesIpcRequestSchema.safeParse({ ...valid.archive, paths: overBatch }).success,
    ).toBe(false);
  });

  it("allows root path '' only for list.path, stat.path, and extract.to", () => {
    const valid = validRequestsByOp();

    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.list, path: "" }).success).toBe(true);
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.stat, path: "" }).success).toBe(true);
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.extract, to: "" }).success).toBe(true);

    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.read, path: "" }).success).toBe(false);
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.write, path: "" }).success).toBe(false);
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.mkdir, path: "" }).success).toBe(false);
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.move, from: "" }).success).toBe(false);
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.move, to: "" }).success).toBe(false);
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.delete, paths: [""] }).success).toBe(
      false,
    );
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.archive, paths: [""] }).success).toBe(
      false,
    );
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.archive, to: "" }).success).toBe(false);
    expect(SiteFilesIpcRequestSchema.safeParse({ ...valid.extract, path: "" }).success).toBe(false);
  });

  it("validates base64 alphabet, padding, and decoded byte cap on write", () => {
    const baseWrite = validRequestsByOp().write;

    // Empty base64 (for empty final chunk) and exact 512 KiB chunk are accepted.
    expect(SiteFilesIpcRequestSchema.safeParse({ ...baseWrite, dataBase64: "" }).success).toBe(true);
    const exactChunkB64 = Buffer.alloc(SITE_FILE_CHUNK_BYTES, 0x41).toString("base64");
    expect(
      SiteFilesIpcRequestSchema.safeParse({ ...baseWrite, dataBase64: exactChunkB64 }).success,
    ).toBe(true);

    // 524,289 bytes encodes to 699,052 chars (within max string length) and must fail decoded-byte check.
    const overChunkB64 = Buffer.alloc(SITE_FILE_CHUNK_BYTES + 1, 0x41).toString("base64");
    expect(
      SiteFilesIpcRequestSchema.safeParse({ ...baseWrite, dataBase64: overChunkB64 }).success,
    ).toBe(false);

    // Bad alphabet and bad padding
    for (const bad of ["abc$", "ab cd", "ab-_cd==", "a", "ab", "abc", "ab=", "a===", "====", "ab=c"]) {
      expect(
        SiteFilesIpcRequestSchema.safeParse({ ...baseWrite, dataBase64: bad }).success,
        `dataBase64=${JSON.stringify(bad)} should fail`,
      ).toBe(false);
    }
  });

  it("validates uploadId pattern and path rules (traversal, absolute, control chars, .htpanel-, segment/path limits)", () => {
    const valid = validRequestsByOp();

    expect(
      SiteFilesIpcRequestSchema.safeParse({ ...valid.write, uploadId: "a".repeat(15) }).success,
    ).toBe(false);
    expect(
      SiteFilesIpcRequestSchema.safeParse({ ...valid.write, uploadId: "a".repeat(16) }).success,
    ).toBe(true);
    expect(
      SiteFilesIpcRequestSchema.safeParse({ ...valid.write, uploadId: "a".repeat(64) }).success,
    ).toBe(true);
    expect(
      SiteFilesIpcRequestSchema.safeParse({ ...valid.write, uploadId: "a".repeat(65) }).success,
    ).toBe(false);
    expect(
      SiteFilesIpcRequestSchema.safeParse({ ...valid.write, uploadId: "bad.upload_id_1234" })
        .success,
    ).toBe(false);

    for (const badPath of [
      "a/../../b",
      "..",
      ".",
      "a/./b",
      "/etc/passwd",
      "a\u0000b",
      "a\nb",
      "a\u007fb",
      ".htpanel-upload",
      "wp-content/.htpanel-temp",
      "a".repeat(SITE_FILE_SEGMENT_MAX_BYTES + 1),
      "é".repeat(128), // 256 UTF-8 bytes
      `${"a".repeat(200)}/`.repeat(5) + "x".repeat(SITE_FILE_PATH_MAX - 1005 + 1), // 1025 > SITE_FILE_PATH_MAX (1024)
    ]) {
      expect(
        SiteFilesIpcRequestSchema.safeParse({ ...valid.list, path: badPath }).success,
        `path=${JSON.stringify(badPath)} should fail`,
      ).toBe(false);
    }

    expect(
      SiteFilesIpcRequestSchema.safeParse({
        ...valid.list,
        path: "a".repeat(SITE_FILE_SEGMENT_MAX_BYTES),
      }).success,
    ).toBe(true);
    expect(
      SiteFilesIpcRequestSchema.safeParse({
        ...valid.list,
        path: `${"a".repeat(200)}/`.repeat(5) + "x".repeat(SITE_FILE_PATH_MAX - 1005), // exact SITE_FILE_PATH_MAX (1024)
      }).success,
    ).toBe(true);
  });
});

describe("SITE_FILES_RESULT_SCHEMAS", () => {
  it("accepts valid results for every op", () => {
    expect(
      SITE_FILES_RESULT_SCHEMAS.list.safeParse({ entries: [validEntry()], truncated: false })
        .success,
    ).toBe(true);
    expect(
      SITE_FILES_RESULT_SCHEMAS.stat.safeParse({ entry: validEntry({ name: "", kind: "dir", size: 0 }) })
        .success,
    ).toBe(true);
    expect(
      SITE_FILES_RESULT_SCHEMAS.read.safeParse({ dataBase64: "AAAA", size: 3, eof: true }).success,
    ).toBe(true);
    expect(SITE_FILES_RESULT_SCHEMAS.write.safeParse({ received: 512 }).success).toBe(true);
    expect(SITE_FILES_RESULT_SCHEMAS.mkdir.safeParse({}).success).toBe(true);
    expect(SITE_FILES_RESULT_SCHEMAS.move.safeParse({}).success).toBe(true);
    expect(SITE_FILES_RESULT_SCHEMAS.delete.safeParse({}).success).toBe(true);
    expect(SITE_FILES_RESULT_SCHEMAS.archive.safeParse({ entries: 4 }).success).toBe(true);
    expect(SITE_FILES_RESULT_SCHEMAS.extract.safeParse({ entries: 4 }).success).toBe(true);
  });

  it("refuses entries with an unknown kind in list and stat results", () => {
    for (const badKind of ["socket", "fifo", "chardev", "unknown", ""]) {
      expect(
        SITE_FILES_RESULT_SCHEMAS.list.safeParse({
          entries: [validEntry({ kind: badKind })],
          truncated: false,
        }).success,
      ).toBe(false);
      expect(
        SITE_FILES_RESULT_SCHEMAS.stat.safeParse({
          entry: validEntry({ kind: badKind }),
        }).success,
      ).toBe(false);
    }
  });

  it("refuses malformed per-op result payloads", () => {
    expect(
      SITE_FILES_RESULT_SCHEMAS.list.safeParse({
        entries: [validEntry({ name: "" })],
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      SITE_FILES_RESULT_SCHEMAS.read.safeParse({ dataBase64: "bad$", size: 3, eof: true }).success,
    ).toBe(false);
    expect(SITE_FILES_RESULT_SCHEMAS.write.safeParse({ received: -1 }).success).toBe(false);
    expect(SITE_FILES_RESULT_SCHEMAS.mkdir.safeParse({ extra: true }).success).toBe(false);
    expect(SITE_FILES_RESULT_SCHEMAS.archive.safeParse({ entries: -1 }).success).toBe(false);
  });
});
