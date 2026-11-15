import { describe, expect, it } from "vitest";
import {
  AdminSiteBackupStatusDtoSchema,
  BACKUP_FAILURE_CLASSES,
  BACKUP_JOB_ID_PATTERN,
  BACKUP_JOB_STATES,
  BACKUP_KINDS,
  BACKUP_PROBLEMS,
  BACKUP_STATUSES,
  BACKUPS_RESULT_SCHEMAS,
  BackupBucketSchema,
  BackupEndpointSchema,
  BackupJobStatusSchema,
  BackupPrefixSchema,
  BackupProblemSchema,
  BackupRegionSchema,
  BackupSettingsDtoSchema,
  BackupSettingsInputSchema,
  BackupTargetSchema,
  BackupTestResultDtoSchema,
  BackupTestResultSchema,
  BackupsIpcRequestSchema,
  DEFAULT_BACKUP_HOUR_UTC,
  DEFAULT_BACKUP_RETENTION_DAYS,
  MANUAL_BACKUPS_KEPT,
  RESTIC_IMAGE,
  SiteBackupAcceptedDtoSchema,
  SiteBackupDtoSchema,
  SiteBackupsDtoSchema,
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
    ]);
    expect(BACKUP_JOB_STATES).toEqual(["running", "succeeded", "failed", "unknown"]);
    expect(BACKUP_JOB_ID_PATTERN.test(VALID_JOB_ID)).toBe(true);
    expect(BACKUP_JOB_ID_PATTERN.test(FORGET_JOB_ID)).toBe(true);
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
      BACKUPS_RESULT_SCHEMAS.status.safeParse({
        jobId: FORGET_JOB_ID,
        state: "unknown",
        failure: null,
        snapshot: null,
      }).success,
    ).toBe(true);
  });
});

describe("backups public contracts (R55, R56)", () => {
  it("BACKUP_PROBLEMS has 17 distinct names matching BACKUP_FAILURE_CLASSES plus site_busy", () => {
    expect(BACKUP_PROBLEMS).toHaveLength(17);
    expect(new Set(BACKUP_PROBLEMS).size).toBe(17);
    expect(BACKUP_PROBLEMS).toEqual([...BACKUP_FAILURE_CLASSES, "site_busy"]);
    for (const p of BACKUP_PROBLEMS) {
      expect(BackupProblemSchema.safeParse(p).success).toBe(true);
    }
    expect(MANUAL_BACKUPS_KEPT).toBe(3);
    expect(DEFAULT_BACKUP_HOUR_UTC).toBe(2);
    expect(DEFAULT_BACKUP_RETENTION_DAYS).toBe(14);
    expect(BACKUP_KINDS).toEqual(["nightly", "manual"]);
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
      }).success,
    ).toBe(true);
    expect(
      SiteBackupsDtoSchema.safeParse({
        available: true,
        configured: true,
        retentionDays: 14,
        manualKept: MANUAL_BACKUPS_KEPT,
        runningOperationId: null,
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
      }).success,
    ).toBe(true);
    expect(
      SiteBackupAcceptedDtoSchema.safeParse({
        siteId: "site_01",
        backupId: "bk_01",
        operationId: VALID_JOB_ID,
      }).success,
    ).toBe(true);
  });
});
