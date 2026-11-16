import { describe, expect, it } from "vitest";
import {
  AdminRestoreBackupInputSchema,
  AdminSiteBackupStatusDtoSchema,
  BACKUP_FAILURE_CLASSES,
  BACKUP_JOB_ID_PATTERN,
  BACKUP_JOB_STATES,
  BACKUP_KINDS,
  BACKUP_PROBLEMS,
  BACKUP_STATUSES,
  BACKUPS_RESULT_SCHEMAS,
  BackupArchiveChunkDtoSchema,
  BackupArchiveChunkSchema,
  BackupArchiveDtoSchema,
  BackupBucketSchema,
  BackupEndpointSchema,
  BackupJobStatusSchema,
  BackupLastRestoreDtoSchema,
  BackupPrefixSchema,
  BackupProblemSchema,
  BackupRegionSchema,
  BackupSettingsDtoSchema,
  BackupSettingsInputSchema,
  BackupSiteStateSchema,
  BackupTargetSchema,
  BackupTestResultDtoSchema,
  BackupTestResultSchema,
  BackupsIpcRequestSchema,
  DEFAULT_BACKUP_HOUR_UTC,
  DEFAULT_BACKUP_RETENTION_DAYS,
  HEAVY_ACTIONS_PER_HOUR,
  HEAVY_ACTION_WINDOW_MS,
  HEAVY_BACKUP_OPERATION_KINDS,
  MANUAL_BACKUPS_KEPT,
  PanelBackupLineSchema,
  RESTIC_IMAGE,
  RestoreBackupInputSchema,
  SITE_FILE_CHUNK_BYTES,
  SiteBackupAcceptedDtoSchema,
  SiteBackupDtoSchema,
  SiteBackupsDtoSchema,
  backupArchiveFileName,
  type BackupsIpcRequest,
} from "../src/index.js";

const VALID_JOB_ID = `op_${"a".repeat(32)}`;
const FORGET_JOB_ID = `${VALID_JOB_ID}-forget`;
const SNAPSHOT_ID = "b".repeat(64);

const VALID_TARGET = {
  endpoint: "https://s3.example.com:9000",
  region: "eu-south-1",
  bucket: "hosting-backups",
  prefix: "prod/panel-a",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const VALID_SETTINGS_INPUT = {
  ...VALID_TARGET,
  scheduleHourUtc: 3,
  retentionDays: 30,
};

describe("backups IPC schemas and constants", () => {
  it("exports expected constants and RESTIC_IMAGE", () => {
    expect(BACKUP_FAILURE_CLASSES).toEqual([
      "unreachable",
      "tls_failed",
      "wrong_region",
      "auth_failed",
      "bucket_missing",
      "write_denied",
      "wrong_key",
      "key_file_missing",
      "tool_unavailable",
      "no_space",
      "database_dump_failed",
      "files_unreadable",
      "repository_locked",
      "timeout",
      "interrupted",
      "other",
      "restore_prepare_failed",
      "switch_undone",
      "undo_incomplete",
      "definer_missing",
      "panel_dump_missing",
    ]);
    expect(BACKUP_FAILURE_CLASSES).toHaveLength(21);
    expect(BACKUP_JOB_STATES).toEqual(["running", "succeeded", "failed", "unknown"]);
    expect(BACKUP_JOB_ID_PATTERN.test(VALID_JOB_ID)).toBe(true);
    expect(BACKUP_JOB_ID_PATTERN.test(FORGET_JOB_ID)).toBe(true);
    expect(BACKUP_JOB_ID_PATTERN.test(`${VALID_JOB_ID}-restore`)).toBe(false);
    expect(BACKUP_JOB_ID_PATTERN.test(`${VALID_JOB_ID}-archive`)).toBe(false);
    expect(RESTIC_IMAGE).toBe(
      "restic/restic:0.19.1@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510",
    );
  });

  it("accepts one valid IPC request per action", () => {
    const validRequests: BackupsIpcRequest[] = [
      { action: "test", target: VALID_TARGET },
      {
        action: "start",
        jobId: VALID_JOB_ID,
        siteId: "site_01",
        serviceInstanceId: "svc_01",
        target: VALID_TARGET,
      },
      { action: "status", jobId: FORGET_JOB_ID },
      {
        action: "forget",
        jobId: FORGET_JOB_ID,
        siteId: "site_01",
        target: VALID_TARGET,
        snapshotIds: [SNAPSHOT_ID],
      },
      {
        action: "restore",
        jobId: VALID_JOB_ID,
        siteId: "site_01",
        serviceInstanceId: "svc_01",
        target: VALID_TARGET,
        snapshotId: SNAPSHOT_ID,
      },
      {
        action: "archive",
        jobId: VALID_JOB_ID,
        siteId: "site_01",
        target: VALID_TARGET,
        snapshotId: SNAPSHOT_ID,
      },
      {
        action: "readArchive",
        jobId: VALID_JOB_ID,
        offset: 0,
        length: SITE_FILE_CHUNK_BYTES,
      },
      {
        action: "discardArchive",
        jobId: VALID_JOB_ID,
      },
      {
        action: "settle",
        jobId: VALID_JOB_ID,
      },
    ];

    for (const req of validRequests) {
      expect(BackupsIpcRequestSchema.safeParse(req).success).toBe(true);
    }

    // Also allow empty prefix and 100 snapshotIds
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "forget",
        jobId: FORGET_JOB_ID,
        siteId: "site_01",
        target: { ...VALID_TARGET, prefix: "" },
        snapshotIds: Array.from({ length: 100 }, () => SNAPSHOT_ID),
      }).success,
    ).toBe(true);
  });

  it("refuses invalid IPC requests", () => {
    // Unknown key on request or target
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "test",
        target: VALID_TARGET,
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "test",
        target: { ...VALID_TARGET, extra: 1 },
      }).success,
    ).toBe(false);

    // Loopback endpoints
    for (const endpoint of [
      "http://localhost:9000",
      "http://127.0.0.1:9000",
      "http://[::1]:9000",
    ]) {
      expect(
        BackupsIpcRequestSchema.safeParse({
          action: "test",
          target: { ...VALID_TARGET, endpoint },
        }).success,
      ).toBe(false);
    }

    // Upper-case region
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "test",
        target: { ...VALID_TARGET, region: "US-EAST-1" },
      }).success,
    ).toBe(false);

    // Bad jobId
    for (const jobId of ["bad", "op_123", `op_${"g".repeat(32)}`, `op_${"A".repeat(32)}`]) {
      expect(
        BackupsIpcRequestSchema.safeParse({
          action: "status",
          jobId,
        }).success,
      ).toBe(false);
    }

    // start whose jobId ends in -forget
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "start",
        jobId: FORGET_JOB_ID,
        siteId: "site_01",
        serviceInstanceId: "svc_01",
        target: VALID_TARGET,
      }).success,
    ).toBe(false);

    // 101 snapshot ids
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "forget",
        jobId: FORGET_JOB_ID,
        siteId: "site_01",
        target: VALID_TARGET,
        snapshotIds: Array.from({ length: 101 }, () => SNAPSHOT_ID),
      }).success,
    ).toBe(false);

    // Secret with a space
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "test",
        target: { ...VALID_TARGET, secretAccessKey: "secret with space" },
      }).success,
    ).toBe(false);

    // Five new actions: unknown key and invalid jobId (including -restore suffix)
    const validNewRequests: Record<string, unknown>[] = [
      {
        action: "restore",
        jobId: VALID_JOB_ID,
        siteId: "site_01",
        serviceInstanceId: "svc_01",
        target: VALID_TARGET,
        snapshotId: SNAPSHOT_ID,
      },
      {
        action: "archive",
        jobId: VALID_JOB_ID,
        siteId: "site_01",
        target: VALID_TARGET,
        snapshotId: SNAPSHOT_ID,
      },
      {
        action: "readArchive",
        jobId: VALID_JOB_ID,
        offset: 0,
        length: 1,
      },
      {
        action: "discardArchive",
        jobId: VALID_JOB_ID,
      },
      {
        action: "settle",
        jobId: VALID_JOB_ID,
      },
    ];
    for (const base of validNewRequests) {
      expect(BackupsIpcRequestSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
      for (const badJobId of [
        "bad",
        "op_123",
        `op_${"g".repeat(32)}`,
        `op_${"A".repeat(32)}`,
        `${VALID_JOB_ID}-restore`,
        `${VALID_JOB_ID}-archive`,
        FORGET_JOB_ID,
      ]) {
        expect(BackupsIpcRequestSchema.safeParse({ ...base, jobId: badJobId }).success).toBe(false);
      }
    }

    // snapshotId and loopback target checks on restore and archive
    for (const action of ["restore", "archive"] as const) {
      const base =
        action === "restore"
          ? {
              action,
              jobId: VALID_JOB_ID,
              siteId: "site_01",
              serviceInstanceId: "svc_01",
              target: VALID_TARGET,
              snapshotId: SNAPSHOT_ID,
            }
          : {
              action,
              jobId: VALID_JOB_ID,
              siteId: "site_01",
              target: VALID_TARGET,
              snapshotId: SNAPSHOT_ID,
            };

      expect(
        BackupsIpcRequestSchema.safeParse({ ...base, snapshotId: "b".repeat(63) }).success,
      ).toBe(false);
      expect(
        BackupsIpcRequestSchema.safeParse({ ...base, snapshotId: `B${"b".repeat(63)}` }).success,
      ).toBe(false);
      expect(
        BackupsIpcRequestSchema.safeParse({
          ...base,
          target: { ...VALID_TARGET, endpoint: "http://127.0.0.1:9000" },
        }).success,
      ).toBe(false);
    }

    // restore without serviceInstanceId
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "restore",
        jobId: VALID_JOB_ID,
        siteId: "site_01",
        target: VALID_TARGET,
        snapshotId: SNAPSHOT_ID,
      }).success,
    ).toBe(false);

    // readArchive bounds
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "readArchive",
        jobId: VALID_JOB_ID,
        offset: -1,
        length: 64,
      }).success,
    ).toBe(false);
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "readArchive",
        jobId: VALID_JOB_ID,
        offset: 0,
        length: 0,
      }).success,
    ).toBe(false);
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "readArchive",
        jobId: VALID_JOB_ID,
        offset: 0,
        length: SITE_FILE_CHUNK_BYTES + 1,
      }).success,
    ).toBe(false);
  });

  it("validates IPC result schemas", () => {
    expect(
      BACKUPS_RESULT_SCHEMAS.test.safeParse({ outcome: "ok", problem: null }).success,
    ).toBe(true);
    expect(
      BackupTestResultSchema.safeParse({ outcome: "failed", problem: "auth_failed" }).success,
    ).toBe(true);
    expect(
      BackupJobStatusSchema.safeParse({
        jobId: VALID_JOB_ID,
        state: "succeeded",
        failure: null,
        snapshot: {
          snapshotId: SNAPSHOT_ID,
          bytesAdded: 1024,
          totalBytes: 4096,
          fileCount: 42,
          durationMs: 1200,
        },
      }).success,
    ).toBe(true);
    expect(
      BackupJobStatusSchema.safeParse({
        jobId: VALID_JOB_ID,
        state: "succeeded",
        failure: null,
        snapshot: null,
        archive: null,
      }).success,
    ).toBe(true);
    expect(
      BackupJobStatusSchema.safeParse({
        jobId: VALID_JOB_ID,
        state: "succeeded",
        failure: null,
        snapshot: null,
        archive: {
          sizeBytes: 2048,
          readyAt: "2026-11-15T01:00:00.000Z",
          expiresAt: "2026-11-15T02:00:00.000Z",
        },
      }).success,
    ).toBe(true);
    expect(
      BackupJobStatusSchema.safeParse({
        jobId: VALID_JOB_ID,
        state: "succeeded",
        failure: null,
        snapshot: null,
        archive: {
          sizeBytes: 2048,
          readyAt: "2026-11-15T01:00:00.000Z",
          expiresAt: "2026-11-15T02:00:00.000Z",
          extra: 1,
        },
      }).success,
    ).toBe(false);
    expect(
      BACKUPS_RESULT_SCHEMAS.status.safeParse({
        jobId: FORGET_JOB_ID,
        state: "unknown",
        failure: null,
        snapshot: null,
      }).success,
    ).toBe(true);
    expect(
      BACKUPS_RESULT_SCHEMAS.restore.safeParse({
        jobId: VALID_JOB_ID,
        state: "failed",
        failure: "undo_incomplete",
        snapshot: null,
      }).success,
    ).toBe(true);
    expect(
      BACKUPS_RESULT_SCHEMAS.archive.safeParse({
        jobId: VALID_JOB_ID,
        state: "succeeded",
        failure: null,
        snapshot: null,
        archive: {
          sizeBytes: 512,
          readyAt: "2026-11-15T01:00:00.000Z",
          expiresAt: "2026-11-15T02:00:00.000Z",
        },
      }).success,
    ).toBe(true);
    expect(
      BACKUPS_RESULT_SCHEMAS.settle.safeParse({
        jobId: VALID_JOB_ID,
        state: "succeeded",
        failure: null,
        snapshot: null,
      }).success,
    ).toBe(true);

    const chunkPayload = {
      dataBase64: Buffer.from("zip-bytes").toString("base64"),
      size: 9,
      eof: true,
    };
    expect(BackupArchiveChunkSchema.safeParse(chunkPayload).success).toBe(true);
    expect(BACKUPS_RESULT_SCHEMAS.readArchive.safeParse(chunkPayload).success).toBe(true);
    expect(
      BACKUPS_RESULT_SCHEMAS.readArchive.safeParse({ ...chunkPayload, extra: 1 }).success,
    ).toBe(false);

    expect(BACKUPS_RESULT_SCHEMAS.discardArchive.safeParse({ discarded: true }).success).toBe(true);
    expect(
      BACKUPS_RESULT_SCHEMAS.discardArchive.safeParse({ discarded: false, extra: 1 }).success,
    ).toBe(false);
  });
});

describe("backups public contracts (R55, R56)", () => {
  it("BACKUP_PROBLEMS has 26 distinct names: BACKUP_FAILURE_CLASSES plus five API problems", () => {
    expect(BACKUP_PROBLEMS).toHaveLength(26);
    expect(new Set(BACKUP_PROBLEMS).size).toBe(26);
    expect(BACKUP_FAILURE_CLASSES.at(-1)).toBe("panel_dump_missing");
    expect(BACKUP_PROBLEMS).toEqual([
      ...BACKUP_FAILURE_CLASSES,
      "site_busy",
      "address_not_updated",
      "panel_dump_failed",
      "panel_dump_tool_missing",
      "site_not_started",
    ]);
    for (const p of BACKUP_PROBLEMS) {
      expect(BackupProblemSchema.safeParse(p).success).toBe(true);
    }
    expect(MANUAL_BACKUPS_KEPT).toBe(3);
    expect(DEFAULT_BACKUP_HOUR_UTC).toBe(2);
    expect(DEFAULT_BACKUP_RETENTION_DAYS).toBe(14);
    expect(HEAVY_ACTIONS_PER_HOUR).toBe(6);
    expect(HEAVY_ACTION_WINDOW_MS).toBe(60 * 60_000);
    expect(HEAVY_BACKUP_OPERATION_KINDS).toEqual([
      "site.backups.create",
      "site.backups.restore",
      "site.backups.download",
      "site.wordpress.update",
      "site.wordpress.import",
    ]);
    expect(BACKUP_KINDS).toEqual(["nightly", "manual", "pre_update"]);
    expect(BACKUP_STATUSES).toEqual(["running", "succeeded", "failed"]);
  });

  it("BackupSettingsInputSchema and BackupTargetSchema agree on R56 edge cases", () => {
    const bothAccept = (targetPatch: Partial<typeof VALID_TARGET>) => {
      const targetRes = BackupTargetSchema.safeParse({ ...VALID_TARGET, ...targetPatch });
      const inputRes = BackupSettingsInputSchema.safeParse({
        ...VALID_SETTINGS_INPUT,
        ...targetPatch,
      });
      expect(targetRes.success).toBe(true);
      expect(inputRes.success).toBe(true);
    };
    const bothRefuse = (targetPatch: Partial<typeof VALID_TARGET>) => {
      const targetRes = BackupTargetSchema.safeParse({ ...VALID_TARGET, ...targetPatch });
      const inputRes = BackupSettingsInputSchema.safeParse({
        ...VALID_SETTINGS_INPUT,
        ...targetPatch,
      });
      expect(targetRes.success).toBe(false);
      expect(inputRes.success).toBe(false);
    };

    // Loopback and unspecified hosts refused by both
    bothRefuse({ endpoint: "http://localhost:9000" });
    bothRefuse({ endpoint: "http://127.0.0.1:9000" });
    bothRefuse({ endpoint: "http://[::1]:9000" });
    bothRefuse({ endpoint: "http://0.0.0.0:9000" });
    bothRefuse({ endpoint: "http://0:9000" });
    bothRefuse({ endpoint: "http://[::]:9000" });
    bothRefuse({ endpoint: "http://s3.localhost:9000" });

    // Bucket with consecutive dots refused by both
    bothRefuse({ bucket: "bad..bucket" });
    expect(BackupBucketSchema.safeParse("bad..bucket").success).toBe(false);

    // Backtick in keys refused by both (protects INI backtick quoting); '#' and ';' accepted
    bothRefuse({ accessKeyId: "ak`bad" });
    bothRefuse({ secretAccessKey: "sk`bad" });
    bothAccept({ accessKeyId: "ak_#;test", secretAccessKey: "hpSw#rm;T3st+/=1" });

    // Port above 65535 refused by both (without throwing)
    bothRefuse({ endpoint: "http://s3.example.com:65536" });
    bothRefuse({ endpoint: "http://s3.example.com:99999" });

    // 256-character prefix refused by both (4 segments of 64/64/64/61 + 3 slashes = 256)
    const prefix256 = `${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}/${"d".repeat(61)}`;
    expect(prefix256).toHaveLength(256);
    bothRefuse({ prefix: prefix256 });

    // 255-character prefix accepted by both
    const prefix255 = `${"a".repeat(64)}/${"b".repeat(64)}/${"c".repeat(64)}/${"d".repeat(60)}`;
    expect(prefix255).toHaveLength(255);
    bothAccept({ prefix: prefix255 });

    // Bracketed IPv6 address accepted by both
    bothAccept({ endpoint: "http://[2001:db8::1]:9000" });
    expect(BackupEndpointSchema.safeParse("http://[2001:db8::1]:9000").success).toBe(true);
    expect(BackupEndpointSchema.safeParse("http://[::1]:9000").success).toBe(false);
    expect(BackupPrefixSchema.safeParse(prefix256).success).toBe(false);
    expect(BackupRegionSchema.safeParse("US-EAST-1").success).toBe(false);
    expect(BackupBucketSchema.safeParse("Bad_Bucket").success).toBe(false);
  });

  it("gives the exact catalog message key for every bad field of BackupSettingsInputSchema", () => {
    const expectFieldMessage = (
      patch: Record<string, unknown>,
      field: string,
      expectedMessage: string,
    ) => {
      const res = BackupSettingsInputSchema.safeParse({
        ...VALID_SETTINGS_INPUT,
        ...patch,
      });
      expect(res.success).toBe(false);
      if (!res.success) {
        const issue = res.error.issues.find((i) => i.path[0] === field);
        expect(issue?.message).toBe(expectedMessage);
      }
    };

    expectFieldMessage({ endpoint: "http://localhost:9000" }, "endpoint", "endpoint_invalid");
    expectFieldMessage({ endpoint: "https://s3.example.com/path" }, "endpoint", "endpoint_invalid");
    expectFieldMessage({ endpoint: 123 }, "endpoint", "endpoint_invalid");

    expectFieldMessage({ region: "EU-WEST-1" }, "region", "region_invalid");
    expectFieldMessage({ region: "" }, "region", "region_invalid");
    expectFieldMessage({ region: null }, "region", "region_invalid");

    expectFieldMessage({ bucket: "MyBucket" }, "bucket", "bucket_invalid");
    expectFieldMessage({ bucket: "a" }, "bucket", "bucket_invalid");
    expectFieldMessage({ bucket: "bad..bucket" }, "bucket", "bucket_invalid");
    expectFieldMessage({ bucket: 42 }, "bucket", "bucket_invalid");

    expectFieldMessage({ prefix: "/leading-slash" }, "prefix", "prefix_invalid");
    expectFieldMessage({ prefix: "a/../b" }, "prefix", "prefix_invalid");
    expectFieldMessage({ prefix: 99 }, "prefix", "prefix_invalid");

    expectFieldMessage({ accessKeyId: "bad key" }, "accessKeyId", "access_key_id_invalid");
    expectFieldMessage({ accessKeyId: "ak`bad" }, "accessKeyId", "access_key_id_invalid");
    expectFieldMessage({ accessKeyId: "" }, "accessKeyId", "access_key_id_invalid");
    expectFieldMessage({ accessKeyId: false }, "accessKeyId", "access_key_id_invalid");

    expectFieldMessage({ secretAccessKey: "bad secret" }, "secretAccessKey", "secret_access_key_invalid");
    expectFieldMessage({ secretAccessKey: "sk`bad" }, "secretAccessKey", "secret_access_key_invalid");
    expectFieldMessage({ secretAccessKey: "" }, "secretAccessKey", "secret_access_key_invalid");
    expectFieldMessage({ secretAccessKey: null }, "secretAccessKey", "secret_access_key_invalid");

    for (const badHour of ["2", null, 1.5, -1, 24, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectFieldMessage({ scheduleHourUtc: badHour }, "scheduleHourUtc", "schedule_hour_invalid");
    }

    for (const badRetention of ["14", null, 1.5, 0, 366, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectFieldMessage({ retentionDays: badRetention }, "retentionDays", "retention_days_invalid");
    }
  });

  it("applies defaults and refuses unknown keys with .strict()", () => {
    const minimal = BackupSettingsInputSchema.parse({
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "panel-backups",
      accessKeyId: "AKIAEXAMPLE",
    });
    expect(minimal.prefix).toBe("");
    expect(minimal.secretAccessKey).toBeUndefined();
    expect(minimal.scheduleHourUtc).toBe(DEFAULT_BACKUP_HOUR_UTC);
    expect(minimal.retentionDays).toBe(DEFAULT_BACKUP_RETENTION_DAYS);

    expect(
      BackupSettingsInputSchema.safeParse({
        ...VALID_SETTINGS_INPUT,
        unknownKey: "nope",
      }).success,
    ).toBe(false);
  });

  it("validates public DTO schemas", () => {
    expect(
      BackupTestResultDtoSchema.safeParse({ outcome: "failed", problem: "site_busy" }).success,
    ).toBe(true);
    expect(
      BackupSettingsDtoSchema.safeParse({
        available: true,
        configured: true,
        endpoint: "https://s3.example.com",
        region: "eu-south-1",
        bucket: "panel-backups",
        prefix: "",
        accessKeyId: "AKIAEXAMPLE",
        secretAccessKeySet: true,
        scheduleHourUtc: 2,
        retentionDays: 14,
        lastNightlyRunOn: "2026-11-15",
        lastTest: { outcome: "ok", problem: null, at: "2026-11-15T02:00:00.000Z" },
        updatedAt: "2026-11-15T01:00:00.000Z",
        lastPanelBackup: null,
        newestBackupsTotalBytes: 0,
      }).success,
    ).toBe(true);
    expect(
      SiteBackupDtoSchema.safeParse({
        id: "bk_01",
        kind: "manual",
        status: "succeeded",
        startedAt: "2026-11-15T01:00:00.000Z",
        finishedAt: "2026-11-15T01:01:00.000Z",
        sizeBytes: 1024,
        problem: null,
        archive: null,
      }).success,
    ).toBe(true);
    expect(
      SiteBackupDtoSchema.safeParse({
        id: "bk_01",
        kind: "manual",
        status: "succeeded",
        startedAt: "2026-11-15T01:00:00.000Z",
        finishedAt: "2026-11-15T01:01:00.000Z",
        sizeBytes: 1024,
        problem: null,
        archive: {
          status: "ready",
          readyUntil: "2026-11-15T02:00:00.000Z",
          problem: null,
        },
      }).success,
    ).toBe(true);
    expect(
      SiteBackupsDtoSchema.safeParse({
        available: true,
        configured: true,
        retentionDays: 14,
        manualKept: MANUAL_BACKUPS_KEPT,
        runningOperationId: null,
        lastRestore: null,
        backups: [],
      }).success,
    ).toBe(true);
    expect(
      SiteBackupsDtoSchema.safeParse({
        available: true,
        configured: true,
        retentionDays: 14,
        manualKept: MANUAL_BACKUPS_KEPT,
        runningOperationId: null,
        lastRestore: {
          backupId: "bk_01",
          backupStartedAt: "2026-11-15T01:00:00.000Z",
          status: "succeeded",
          finishedAt: "2026-11-15T02:00:00.000Z",
          problem: "address_not_updated",
        },
        backups: [],
      }).success,
    ).toBe(true);
    expect(
      AdminSiteBackupStatusDtoSchema.safeParse({
        siteId: "site_01",
        siteName: "Main Site",
        organizationId: "org_01",
        organizationName: "Acme",
        lastSuccessAt: null,
        lastAttemptAt: null,
        lastStatus: null,
        problem: null,
        runningOperationId: null,
        lastSuccessBackupId: null,
        lastSuccessSizeBytes: null,
        lastRestore: null,
      }).success,
    ).toBe(true);
    expect(
      SiteBackupAcceptedDtoSchema.safeParse({
        siteId: "site_01",
        backupId: "bk_01",
        operationId: VALID_JOB_ID,
      }).success,
    ).toBe(true);
    expect(
      BackupArchiveDtoSchema.safeParse({
        status: "failed",
        readyUntil: null,
        problem: "no_space",
      }).success,
    ).toBe(true);
    expect(
      BackupLastRestoreDtoSchema.safeParse({
        backupId: "bk_01",
        backupStartedAt: "2026-11-15T01:00:00.000Z",
        status: "failed",
        finishedAt: "2026-11-15T02:00:00.000Z",
        problem: "undo_incomplete",
      }).success,
    ).toBe(true);
  });

  it("validates RestoreBackupInputSchema, BackupArchiveChunkDtoSchema, and backupArchiveFileName", () => {
    expect(RestoreBackupInputSchema.safeParse({ confirmName: "My Site" }).success).toBe(true);
    expect(RestoreBackupInputSchema.safeParse({ confirmName: "a".repeat(255) }).success).toBe(true);
    expect(
      RestoreBackupInputSchema.safeParse({ confirmName: "My Site", extra: 1 }).success,
    ).toBe(false);
    expect(RestoreBackupInputSchema.safeParse({ confirmName: "a".repeat(256) }).success).toBe(
      false,
    );

    const chunk = {
      dataBase64: "YQ==",
      size: 1,
      eof: true,
      fileName: "mysite-backup-2026-11-15-0304.zip",
    };
    expect(BackupArchiveChunkDtoSchema.safeParse(chunk).success).toBe(true);
    expect(
      BackupArchiveChunkDtoSchema.safeParse({ ...chunk, fileName: "a/b.zip" }).success,
    ).toBe(false);
    expect(
      BackupArchiveChunkDtoSchema.safeParse({ ...chunk, fileName: "backup.tar.gz" }).success,
    ).toBe(false);
    expect(
      BackupArchiveChunkDtoSchema.safeParse({ ...chunk, extra: 1 }).success,
    ).toBe(false);

    const hostileNames = [
      "../../etc/passwd",
      "",
      "...",
      "---",
      ".-.-.",
      "   ",
      "Café à la crème",
      "\"'hello'\"",
      "a".repeat(300),
      `.${"a".repeat(300)}`,
      `${"-".repeat(100)}${"b".repeat(100)}`,
    ];
    const startedAtUtc = new Date("2026-11-15T03:04:05.000Z");
    for (const rawName of hostileNames) {
      const out = backupArchiveFileName(rawName, startedAtUtc);
      expect(out, `hostile=${rawName}`).toMatch(/^[A-Za-z0-9._-]{1,120}\.zip$/);
      expect(out, `hostile=${rawName}`).not.toMatch(/^[.-]/);
      expect(out, `hostile=${rawName}`).toMatch(/-backup-2026-11-15-0304\.zip$/);
    }

    // Offset timestamps are rendered in UTC, not local timezone.
    expect(backupArchiveFileName("Shop", new Date("2026-11-15T23:30:00-05:00"))).toBe(
      "Shop-backup-2026-11-16-0430.zip",
    );
  });
});

describe("M3c panel copy and admin restore contracts", () => {
  const MASTER_KEY = "ab".repeat(32);
  const PANEL_START = {
    action: "panelStart",
    jobId: VALID_JOB_ID,
    target: VALID_TARGET,
    masterKey: MASTER_KEY,
    retentionDays: 14,
  };
  const ok = (body: unknown) => BackupsIpcRequestSchema.safeParse(body).success;

  it("panelStart accepts one valid request and refuses malformed ones", () => {
    expect(ok(PANEL_START)).toBe(true);
    expect(ok({ ...PANEL_START, extra: 1 })).toBe(false);
    expect(ok({ ...PANEL_START, jobId: `${VALID_JOB_ID}-forget` })).toBe(false);
    expect(ok({ ...PANEL_START, masterKey: `A${MASTER_KEY.slice(1)}` })).toBe(false);
    expect(ok({ ...PANEL_START, masterKey: MASTER_KEY.slice(1) })).toBe(false);
    expect(ok({ ...PANEL_START, masterKey: `${MASTER_KEY}a` })).toBe(false);
    for (const retentionDays of [0, 366, 1.5]) {
      expect(ok({ ...PANEL_START, retentionDays })).toBe(false);
    }
    expect(
      ok({ ...PANEL_START, target: { ...VALID_TARGET, endpoint: "http://127.0.0.1:9000" } }),
    ).toBe(false);
    expect(BACKUPS_RESULT_SCHEMAS.panelStart).toBe(BackupJobStatusSchema);
  });

  it("siteState and its result are strict", () => {
    const req = { action: "siteState", siteId: "site_a", serviceInstanceId: "svc_a" };
    expect(ok(req)).toBe(true);
    expect(ok({ ...req, extra: true })).toBe(false);
    expect(ok({ action: "siteState", siteId: "site_a" })).toBe(false);
    expect(BACKUPS_RESULT_SCHEMAS.siteState).toBe(BackupSiteStateSchema);
    expect(BackupSiteStateSchema.safeParse({ filesVolume: true, container: false }).success).toBe(
      true,
    );
    expect(
      BackupSiteStateSchema.safeParse({ filesVolume: true, container: false, id: "x" }).success,
    ).toBe(false);
  });

  it("restore accepts createVolume true and refuses false", () => {
    const restore = {
      action: "restore",
      jobId: VALID_JOB_ID,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
      target: VALID_TARGET,
      snapshotId: SNAPSHOT_ID,
    };
    expect(ok(restore)).toBe(true);
    expect(ok({ ...restore, createVolume: true })).toBe(true);
    expect(ok({ ...restore, createVolume: false })).toBe(false);
  });

  it("AdminRestoreBackupInputSchema takes an optional backupId and a bounded confirmName", () => {
    const parse = (body: unknown) => AdminRestoreBackupInputSchema.safeParse(body).success;
    const backupId = `bkp_${"0".repeat(32)}`;
    expect(parse({ confirmName: "Main Site" })).toBe(true);
    expect(parse({ backupId, confirmName: "Main Site" })).toBe(true);
    expect(parse({ backupId, confirmName: "Main Site", force: true })).toBe(false);
    expect(parse({ backupId: "bkp_123", confirmName: "Main Site" })).toBe(false);
    expect(parse({ confirmName: "x".repeat(256) })).toBe(false);
  });

  it("settings and per-site DTOs carry the panel line and the storage figures", () => {
    const settings = {
      available: true,
      configured: true,
      endpoint: null,
      region: null,
      bucket: null,
      prefix: "",
      accessKeyId: null,
      secretAccessKeySet: false,
      scheduleHourUtc: 2,
      retentionDays: 14,
      lastNightlyRunOn: null,
      lastTest: null,
      updatedAt: null,
    };
    const line = { at: "2026-11-15T02:30:00.000Z", status: "failed", problem: "panel_dump_failed" };
    expect(PanelBackupLineSchema.safeParse(line).success).toBe(true);
    expect(PanelBackupLineSchema.safeParse({ ...line, extra: 1 }).success).toBe(false);
    const settingsOk = (patch: object) =>
      BackupSettingsDtoSchema.safeParse({ ...settings, ...patch }).success;
    expect(settingsOk({ lastPanelBackup: line, newestBackupsTotalBytes: 1024 })).toBe(true);
    expect(settingsOk({ lastPanelBackup: null, newestBackupsTotalBytes: 0 })).toBe(true);
    expect(settingsOk({ lastPanelBackup: null, newestBackupsTotalBytes: -1 })).toBe(false);

    const site = {
      siteId: "site_01",
      siteName: "Main Site",
      organizationId: "org_01",
      organizationName: "Acme",
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastStatus: null,
      problem: null,
      runningOperationId: null,
    };
    const siteOk = (patch: object) =>
      AdminSiteBackupStatusDtoSchema.safeParse({ ...site, ...patch }).success;
    expect(
      siteOk({
        lastSuccessBackupId: `bkp_${"1".repeat(32)}`,
        lastSuccessSizeBytes: 2048,
        lastRestore: {
          backupId: `bkp_${"1".repeat(32)}`,
          backupStartedAt: "2026-11-15T02:00:00.000Z",
          status: "succeeded",
          finishedAt: "2026-11-15T02:10:00.000Z",
          problem: null,
        },
      }),
    ).toBe(true);
    expect(
      siteOk({ lastSuccessBackupId: null, lastSuccessSizeBytes: null, lastRestore: null }),
    ).toBe(true);
    expect(
      siteOk({ lastSuccessBackupId: null, lastSuccessSizeBytes: -1, lastRestore: null }),
    ).toBe(false);
  });
});
