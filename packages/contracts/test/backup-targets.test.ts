import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BACKUP_COPY_JOB_ID_PATTERN,
  BACKUP_JOB_ID_PATTERN,
  BACKUP_TARGET_ID_PATTERN,
  BackupDispatchTargetSchema,
  BackupTargetSchema,
  BackupsIpcRequestSchema,
  LocalBackupTargetSchema,
} from "../src/ipc-schemas.js";
import {
  AdminBackupTargetDtoSchema,
  BACKUP_COPY_STATUSES,
  BACKUP_POLICY_SCOPES,
  BACKUP_TARGET_KINDS,
  BackupPolicyDtoSchema,
  BackupTargetChoiceDtoSchema,
  BackupTargetIdSchema,
  BackupTargetsDtoSchema,
  CreateBackupTargetInputSchema,
  MAX_BACKUP_POLICY_TARGETS,
  S3BackupTargetConfigSchema,
  SetSiteBackupPolicyInputSchema,
  SiteBackupCopyDtoSchema,
  SiteBackupPolicyDtoSchema,
  UpdateBackupTargetInputSchema,
  UpdateDefaultSiteBackupPolicyInputSchema,
  UpdatePanelBackupPolicyInputSchema,
} from "../src/backup-targets.js";
import { findForbiddenPublicDtoKeys } from "../src/resources.js";

const TARGET_A = `bkt_${"a".repeat(32)}`;
const TARGET_B = `bkt_${"b".repeat(32)}`;
const JOB_ID = `op_${"c".repeat(32)}`;
const NOW = "2026-11-21T10:00:00.000Z";

const S3_FIELDS = {
  endpoint: "https://s3.example.com:9000",
  region: "eu-south-1",
  bucket: "hosting-backups",
  prefix: "prod/panel-a",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
};
const S3_TARGET = { ...S3_FIELDS, secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

const ADMIN_S3_DTO = {
  id: TARGET_A,
  kind: "s3",
  name: "Primary S3",
  enabled: true,
  customerSelectable: false,
  legacy: false,
  archivedAt: null,
  retentionDays: null,
  s3: { ...S3_FIELDS, secretAccessKeySet: true },
  local: null,
  lastTest: null,
  usage: { policies: ["default_site"], copies: 3 },
  createdAt: NOW,
  updatedAt: NOW,
};
const ADMIN_LOCAL_DTO = {
  ...ADMIN_S3_DTO,
  id: TARGET_B,
  kind: "local",
  name: "This server",
  s3: null,
  local: { root: "/var/lib/hosting-panel/local-repos", initializedAt: NOW },
  lastTest: {
    at: NOW,
    outcome: "ok",
    problem: null,
    availableBytes: 1_000,
    totalBytes: 5_000,
  },
};

describe("frozen S3 IPC target", () => {
  it("keeps exactly the six keys, strict, and refuses a kind discriminator", () => {
    expect(Object.keys(BackupTargetSchema.shape)).toEqual([
      "endpoint",
      "region",
      "bucket",
      "prefix",
      "accessKeyId",
      "secretAccessKey",
    ]);
    expect(BackupTargetSchema.safeParse(S3_TARGET).success).toBe(true);
    expect(BackupTargetSchema.safeParse({ ...S3_TARGET, kind: "s3" }).success).toBe(false);
    expect(BackupTargetSchema.safeParse({ ...S3_TARGET, extra: 1 }).success).toBe(false);
  });

  it("still accepts the frozen S3 object, without a kind, in the IPC requests", () => {
    expect(
      BackupsIpcRequestSchema.safeParse({ action: "test", target: S3_TARGET }).success,
    ).toBe(true);
    expect(
      BackupsIpcRequestSchema.safeParse({
        action: "start",
        jobId: JOB_ID,
        siteId: "site_1",
        serviceInstanceId: "svc_1",
        target: S3_TARGET,
      }).success,
    ).toBe(true);
    expect(BACKUP_JOB_ID_PATTERN.test(JOB_ID)).toBe(true);
  });
});

describe("local and dispatch IPC targets", () => {
  it("accepts only bkt_ plus 32 lowercase hex characters as a target id", () => {
    expect(BACKUP_TARGET_ID_PATTERN.test(TARGET_A)).toBe(true);
    for (const bad of [
      "",
      "bkt_",
      `bkt_${"a".repeat(31)}`,
      `bkt_${"a".repeat(33)}`,
      `bkt_${"A".repeat(32)}`,
      `bkt_${"g".repeat(32)}`,
      `xbkt_${"a".repeat(32)}`,
      `${TARGET_A}\n`,
      `${TARGET_A}/../x`,
    ]) {
      expect(BACKUP_TARGET_ID_PATTERN.test(bad), bad).toBe(false);
      expect(BackupTargetIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("parses the local target strictly and never carries a path", () => {
    expect(LocalBackupTargetSchema.parse({ kind: "local", targetId: TARGET_A })).toEqual({
      kind: "local",
      targetId: TARGET_A,
    });
    for (const bad of [
      { kind: "local" },
      { targetId: TARGET_A },
      { kind: "s3", targetId: TARGET_A },
      { kind: "local", targetId: "bkt_x" },
      { kind: "local", targetId: TARGET_A, root: "/mnt/backup" },
      { kind: "local", targetId: TARGET_A, path: "/mnt/backup" },
    ]) {
      expect(LocalBackupTargetSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("accepts the frozen S3 object or the local object in the dispatch union, nothing mixed", () => {
    expect(BackupDispatchTargetSchema.safeParse(S3_TARGET).success).toBe(true);
    expect(
      BackupDispatchTargetSchema.safeParse({ kind: "local", targetId: TARGET_A }).success,
    ).toBe(true);
    expect(
      BackupDispatchTargetSchema.safeParse({ ...S3_TARGET, kind: "local", targetId: TARGET_A })
        .success,
    ).toBe(false);
    expect(BackupDispatchTargetSchema.safeParse({ ...S3_TARGET, kind: "s3" }).success).toBe(false);
    expect(BackupDispatchTargetSchema.safeParse({ kind: "local" }).success).toBe(false);
    expect(BackupDispatchTargetSchema.safeParse({}).success).toBe(false);
  });

  it("accepts the copy job ids op_x and op_x-t2 and nothing else", () => {
    expect(BACKUP_COPY_JOB_ID_PATTERN.test(JOB_ID)).toBe(true);
    expect(BACKUP_COPY_JOB_ID_PATTERN.test(`${JOB_ID}-t2`)).toBe(true);
    for (const bad of [
      `${JOB_ID}-t1`,
      `${JOB_ID}-t3`,
      `${JOB_ID}-t22`,
      `${JOB_ID}-forget`,
      `${JOB_ID}-forget-t2`,
      `${JOB_ID}-t2-t2`,
      `${JOB_ID}\n`,
      `op_${"c".repeat(31)}`,
      `op_${"C".repeat(32)}`,
      `x${JOB_ID}`,
    ]) {
      expect(BACKUP_COPY_JOB_ID_PATTERN.test(bad), bad).toBe(false);
    }
  });
});

describe("backup target constants", () => {
  it("lists the kinds, scopes, copy statuses and the two-target limit", () => {
    expect(BACKUP_TARGET_KINDS).toEqual(["s3", "local"]);
    expect(BACKUP_POLICY_SCOPES).toEqual(["default_site", "site", "panel"]);
    expect(BACKUP_COPY_STATUSES).toEqual(["running", "succeeded", "failed", "missing", "unknown"]);
    expect(MAX_BACKUP_POLICY_TARGETS).toBe(2);
  });
});

describe("S3BackupTargetConfigSchema", () => {
  it("is the frozen S3 target without the secret, strict", () => {
    expect(Object.keys(S3BackupTargetConfigSchema.shape)).toEqual([
      "endpoint",
      "region",
      "bucket",
      "prefix",
      "accessKeyId",
    ]);
    expect(S3BackupTargetConfigSchema.safeParse(S3_FIELDS).success).toBe(true);
    expect(S3BackupTargetConfigSchema.safeParse(S3_TARGET).success).toBe(false);
  });
});

describe("CreateBackupTargetInputSchema", () => {
  it("parses a local target with only a name and applies the defaults", () => {
    expect(CreateBackupTargetInputSchema.parse({ kind: "local", name: "  This server " })).toEqual({
      kind: "local",
      name: "This server",
      enabled: true,
      customerSelectable: false,
    });
  });

  it("refuses any path-like or foreign key on a local target", () => {
    for (const key of ["root", "path", "localRoot", "hostPath", "directory", "mountPoint"]) {
      expect(
        CreateBackupTargetInputSchema.safeParse({
          kind: "local",
          name: "x",
          [key]: "/mnt/backup",
        }).success,
        key,
      ).toBe(false);
    }
    expect(
      CreateBackupTargetInputSchema.safeParse({ kind: "local", name: "x", ...S3_TARGET }).success,
    ).toBe(false);
  });

  it("parses an S3 target and validates every field like the legacy form", () => {
    const parsed = CreateBackupTargetInputSchema.parse({
      kind: "s3",
      name: "Offsite",
      customerSelectable: true,
      ...S3_TARGET,
    });
    expect(parsed).toMatchObject({ kind: "s3", enabled: true, customerSelectable: true });
    expect(
      CreateBackupTargetInputSchema.parse({ kind: "s3", name: "x", ...S3_TARGET, prefix: undefined }),
    ).toMatchObject({ prefix: "" });
    for (const patch of [
      { endpoint: "http://127.0.0.1:9000" },
      { endpoint: "ftp://s3.example.com" },
      { region: "EU_SOUTH" },
      { bucket: "A" },
      { prefix: "../x" },
      { accessKeyId: "a`b" },
      { secretAccessKey: undefined },
      { secretAccessKey: "" },
    ]) {
      expect(
        CreateBackupTargetInputSchema.safeParse({ kind: "s3", name: "x", ...S3_TARGET, ...patch })
          .success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("refuses an unknown kind, a missing or oversized name and unknown keys", () => {
    for (const bad of [
      { kind: "ftp", name: "x" },
      { name: "x" },
      { kind: "local" },
      { kind: "local", name: "" },
      { kind: "local", name: "   " },
      { kind: "local", name: "x".repeat(129) },
      { kind: "local", name: "x", legacy: true },
      { kind: "local", name: "x", archivedAt: NOW },
      { kind: "s3", name: "x", ...S3_TARGET, id: TARGET_A },
    ]) {
      expect(CreateBackupTargetInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("UpdateBackupTargetInputSchema", () => {
  it("accepts any subset of the editable fields and refuses an empty body", () => {
    for (const ok of [
      { name: "Renamed" },
      { enabled: false },
      { customerSelectable: true },
      { retentionDays: 30 },
      { retentionDays: null },
      { archived: true },
      { endpoint: "https://s3.example.org", bucket: "other-bucket", prefix: "p" },
      { region: "us-east-1", accessKeyId: "AKIA", secretAccessKey: "secret" },
    ]) {
      expect(UpdateBackupTargetInputSchema.safeParse(ok).success, JSON.stringify(ok)).toBe(true);
    }
    expect(UpdateBackupTargetInputSchema.safeParse({}).success).toBe(false);
  });

  it("refuses retention out of range, un-archiving, identity keys and any local path", () => {
    for (const bad of [
      { retentionDays: 0 },
      { retentionDays: 366 },
      { retentionDays: 1.5 },
      { archived: false },
      { kind: "local" },
      { id: TARGET_A },
      { legacy: true },
      { root: "/mnt/backup" },
      { path: "/mnt/backup" },
      { localRoot: "/mnt/backup" },
      { name: "" },
    ]) {
      expect(UpdateBackupTargetInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("admin and customer target DTOs", () => {
  it("parses the admin DTO for an S3 and a local target", () => {
    expect(AdminBackupTargetDtoSchema.parse(ADMIN_S3_DTO)).toEqual(ADMIN_S3_DTO);
    expect(AdminBackupTargetDtoSchema.parse(ADMIN_LOCAL_DTO)).toEqual(ADMIN_LOCAL_DTO);
    expect(
      BackupTargetsDtoSchema.parse({
        targets: [ADMIN_S3_DTO, ADMIN_LOCAL_DTO],
        localRootConfigured: true,
      }).targets,
    ).toHaveLength(2);
  });

  it("never carries a secret, a ciphertext or a host path key", () => {
    const shape = (schema: { shape: Record<string, unknown> }): string[] => Object.keys(schema.shape);
    const dtoKeys = shape(AdminBackupTargetDtoSchema);
    expect(dtoKeys).not.toContain("secretAccessKey");
    expect(dtoKeys).not.toContain("hostPath");
    expect(dtoKeys).not.toContain("path");
    expect(findForbiddenPublicDtoKeys(ADMIN_S3_DTO)).toEqual([]);
    expect(findForbiddenPublicDtoKeys(ADMIN_LOCAL_DTO)).toEqual([]);

    expect(
      AdminBackupTargetDtoSchema.safeParse({
        ...ADMIN_S3_DTO,
        s3: { ...ADMIN_S3_DTO.s3, secretAccessKey: "x" },
      }).success,
    ).toBe(false);
    expect(
      AdminBackupTargetDtoSchema.safeParse({ ...ADMIN_S3_DTO, secretAccessKey: "x" }).success,
    ).toBe(false);
    expect(
      AdminBackupTargetDtoSchema.safeParse({ ...ADMIN_S3_DTO, configJson: {} }).success,
    ).toBe(false);
    expect(
      AdminBackupTargetDtoSchema.safeParse({
        ...ADMIN_LOCAL_DTO,
        local: { ...ADMIN_LOCAL_DTO.local, hostPath: "/x" },
      }).success,
    ).toBe(false);
    expect(
      AdminBackupTargetDtoSchema.safeParse({
        ...ADMIN_S3_DTO,
        s3: { ...ADMIN_S3_DTO.s3, secretAccessKeySet: false },
      }).success,
    ).toBe(false);
  });

  it("refuses a malformed id, kind, date or counter", () => {
    for (const patch of [
      { id: "bkt_x" },
      { kind: "ftp" },
      { createdAt: "yesterday" },
      { usage: { policies: ["site"], copies: -1 } },
      { usage: { policies: ["nightly"], copies: 0 } },
      { retentionDays: 0 },
      { lastTest: { at: NOW, outcome: "maybe", problem: null, availableBytes: null, totalBytes: null } },
      { lastTest: { at: NOW, outcome: "failed", problem: "made_up", availableBytes: null, totalBytes: null } },
    ]) {
      expect(
        AdminBackupTargetDtoSchema.safeParse({ ...ADMIN_S3_DTO, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("gives customers only {id, kind}", () => {
    expect(BackupTargetChoiceDtoSchema.parse({ id: TARGET_A, kind: "local" })).toEqual({
      id: TARGET_A,
      kind: "local",
    });
    expect(Object.keys(BackupTargetChoiceDtoSchema.shape)).toEqual(["id", "kind"]);
    for (const extra of ["name", "endpoint", "bucket", "root", "path", "enabled", "legacy"]) {
      expect(
        BackupTargetChoiceDtoSchema.safeParse({ id: TARGET_A, kind: "s3", [extra]: "x" }).success,
        extra,
      ).toBe(false);
    }
    expect(BackupTargetChoiceDtoSchema.safeParse({ id: TARGET_A }).success).toBe(false);
  });
});

describe("backup policies", () => {
  const POLICY = {
    scope: "default_site",
    siteId: null,
    scheduleHourUtc: 2,
    retentionDays: 14,
    targets: [
      { targetId: TARGET_A, kind: "s3", priority: 1, required: true },
      { targetId: TARGET_B, kind: "local", priority: 2, required: false },
    ],
    updatedAt: NOW,
  };

  it("parses the admin policy DTO for the default-site and the panel policy", () => {
    expect(BackupPolicyDtoSchema.parse(POLICY)).toEqual(POLICY);
    const panel = { ...POLICY, scope: "panel", scheduleHourUtc: null, targets: [] };
    expect(BackupPolicyDtoSchema.parse(panel)).toEqual(panel);
  });

  it("refuses a third target, a priority outside 1..2, out-of-range limits and a site scope", () => {
    const third = { targetId: `bkt_${"d".repeat(32)}`, kind: "s3", priority: 2, required: true };
    for (const patch of [
      { targets: [...POLICY.targets, third] },
      { targets: [{ ...POLICY.targets[0], priority: 3 }] },
      { targets: [{ ...POLICY.targets[0], priority: 0 }] },
      { scheduleHourUtc: 24 },
      { scheduleHourUtc: -1 },
      { retentionDays: 0 },
      { retentionDays: 366 },
      { scope: "site" },
      { scope: "nightly" },
      { siteId: "site_1" },
    ]) {
      expect(BackupPolicyDtoSchema.safeParse({ ...POLICY, ...patch }).success, JSON.stringify(patch)).toBe(false);
    }
  });

  it("limits the default-site policy input to hour 0..23, retention 1..365 and 0..2 distinct targets", () => {
    const schema = UpdateDefaultSiteBackupPolicyInputSchema;
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ scheduleHourUtc: 0, retentionDays: 1, targetIds: [] })).toEqual({
      scheduleHourUtc: 0,
      retentionDays: 1,
      targetIds: [],
    });
    expect(schema.safeParse({ scheduleHourUtc: 23, retentionDays: 365, targetIds: [TARGET_A, TARGET_B] }).success).toBe(true);
    for (const bad of [
      { scheduleHourUtc: 24 },
      { scheduleHourUtc: 1.5 },
      { retentionDays: 0 },
      { retentionDays: 366 },
      { targetIds: [TARGET_A, TARGET_A] },
      { targetIds: [TARGET_A, TARGET_B, `bkt_${"d".repeat(32)}`] },
      { targetIds: ["bkt_x"] },
      { targetIds: null },
      { siteId: "site_1" },
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("gives the panel policy no schedule hour", () => {
    const schema = UpdatePanelBackupPolicyInputSchema;
    expect(schema.safeParse({ retentionDays: 30, targetIds: [TARGET_A] }).success).toBe(true);
    expect(schema.safeParse({ scheduleHourUtc: 3 }).success).toBe(false);
    expect(schema.safeParse({ retentionDays: 366 }).success).toBe(false);
    expect(schema.safeParse({ targetIds: [TARGET_A, TARGET_A] }).success).toBe(false);
  });

  it("lets a site pick one or two distinct targets, or null to inherit", () => {
    const schema = SetSiteBackupPolicyInputSchema;
    expect(schema.parse({ targetIds: null })).toEqual({ targetIds: null });
    expect(schema.safeParse({ targetIds: [TARGET_A] }).success).toBe(true);
    expect(schema.safeParse({ targetIds: [TARGET_A, TARGET_B] }).success).toBe(true);
    for (const bad of [
      {},
      { targetIds: [] },
      { targetIds: [TARGET_A, TARGET_A] },
      { targetIds: [TARGET_A, TARGET_B, `bkt_${"d".repeat(32)}`] },
      { targetIds: [TARGET_A], scheduleHourUtc: 2 },
      { targetIds: [TARGET_A], retentionDays: 30 },
    ]) {
      expect(schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("returns the customer policy with choices that carry no name or location", () => {
    const dto = {
      targetIds: [TARGET_A],
      inherited: false,
      choices: [
        { id: TARGET_A, kind: "s3" },
        { id: TARGET_B, kind: "local" },
      ],
    };
    expect(SiteBackupPolicyDtoSchema.parse(dto)).toEqual(dto);
    expect(
      SiteBackupPolicyDtoSchema.safeParse({
        ...dto,
        choices: [{ id: TARGET_A, kind: "s3", name: "Primary S3" }],
      }).success,
    ).toBe(false);
  });
});

describe("SiteBackupCopyDtoSchema", () => {
  const COPY = {
    targetId: TARGET_A,
    kind: "s3",
    status: "succeeded",
    sizeBytes: 1024,
    problem: null,
    startedAt: NOW,
    finishedAt: NOW,
  };

  it("parses every copy status and nullable fields", () => {
    for (const status of BACKUP_COPY_STATUSES) {
      expect(SiteBackupCopyDtoSchema.safeParse({ ...COPY, status }).success, status).toBe(true);
    }
    expect(
      SiteBackupCopyDtoSchema.parse({
        ...COPY,
        status: "failed",
        sizeBytes: null,
        problem: "no_space",
        finishedAt: null,
      }).problem,
    ).toBe("no_space");
  });

  it("carries no snapshot id, name, path or endpoint for customers", () => {
    expect(Object.keys(SiteBackupCopyDtoSchema.shape)).toEqual([
      "targetId",
      "kind",
      "status",
      "sizeBytes",
      "problem",
      "startedAt",
      "finishedAt",
    ]);
    for (const extra of ["snapshotId", "name", "root", "path", "endpoint", "jobId"]) {
      expect(SiteBackupCopyDtoSchema.safeParse({ ...COPY, [extra]: "x" }).success, extra).toBe(false);
    }
    expect(SiteBackupCopyDtoSchema.safeParse({ ...COPY, status: "partial" }).success).toBe(false);
    expect(SiteBackupCopyDtoSchema.safeParse({ ...COPY, sizeBytes: -1 }).success).toBe(false);
    expect(SiteBackupCopyDtoSchema.safeParse({ ...COPY, problem: "made_up" }).success).toBe(false);
  });
});

describe("module hygiene", () => {
  it("imports no node: module (browser-safe contracts)", () => {
    const source = readFileSync(new URL("../src/backup-targets.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["']node:/);
    expect(source).not.toMatch(/require\(/);
  });
});
