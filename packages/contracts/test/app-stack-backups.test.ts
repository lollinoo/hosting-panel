import { describe, expect, it } from "vitest";
import {
  APP_AUDIT_ACTIONS,
  APP_ID_PREFIXES,
  APP_STACK_BACKUP_OPERATION_KINDS,
  APP_STACK_BACKUP_STEP_KEYS,
  APP_STACK_BACKUP_STEP_LABELS,
  APP_STACK_BACKUP_STEPS_BY_KIND,
  APP_STACK_OPERATION_KINDS,
  APP_STACK_STATUSES,
  AppStackBackupDtoSchema,
  AppStackBackupOperationPayloadSchema,
  AppStackBackupsDtoSchema,
  BACKUP_JOB_ID_PATTERN,
  BACKUPS_RESULT_SCHEMAS,
  BackupsIpcRequestSchema,
  HEAVY_BACKUP_OPERATION_KINDS,
  OPERATION_KINDS,
  PERMISSION_KEYS,
  RestoreAppStackBackupInputSchema,
  appStackBackupEnqueueTarget,
  appStackBackupOperationSteps,
  canTransitionAppStack,
  findForbiddenPublicDtoKeys,
  findPemValues,
  findPlaintextSecretKeys,
} from "../src/index.js";

const OP = `op_${"0123456789abcdef".repeat(2)}`;
const STACK = "stk_0123456789abcdef01234567";
const SNAPSHOT = "ab".repeat(32);
const LOCAL_TARGET = { kind: "local", targetId: `bkt_${"0123456789abcdef".repeat(2)}` };

const guards = (value: unknown): string[][] => [
  findPlaintextSecretKeys(value),
  findForbiddenPublicDtoKeys(value),
  findPemValues(value),
];

describe("application backups: operations", () => {
  it("three kinds of their own, after the seven stack kinds", () => {
    expect(APP_STACK_BACKUP_OPERATION_KINDS).toEqual(["stack.backup", "stack.restore", "stack.prune"]);
    for (const kind of APP_STACK_BACKUP_OPERATION_KINDS) {
      expect(OPERATION_KINDS).toContain(kind);
      expect(APP_STACK_OPERATION_KINDS as readonly string[]).not.toContain(kind);
      // The sites' hourly limit list stays as it is: applications have their own limit.
      expect(HEAVY_BACKUP_OPERATION_KINDS as readonly string[]).not.toContain(kind);
    }
  });

  it("steps by kind", () => {
    for (const kind of APP_STACK_BACKUP_OPERATION_KINDS) {
      for (const step of APP_STACK_BACKUP_STEPS_BY_KIND[kind]) expect(APP_STACK_BACKUP_STEP_KEYS).toContain(step);
    }
    expect(appStackBackupOperationSteps("stack.backup").map((s) => s.key)).toEqual([
      "validate", "unpublish", "stop", "copy", "settle",
    ]);
    expect(appStackBackupOperationSteps("stack.restore").map((s) => s.key)).toEqual([
      "validate", "unpublish", "stop", "copy", "restore", "settle",
    ]);
    expect(appStackBackupOperationSteps("stack.prune")).toEqual([
      { key: "validate", label: "Check the request" },
      { key: "expire", label: "Remove old backups" },
      { key: "settle", label: "Finish" },
    ]);
  });

  it("step labels name no technical object", () => {
    for (const key of APP_STACK_BACKUP_STEP_KEYS) {
      expect(APP_STACK_BACKUP_STEP_LABELS[key], key).not.toMatch(/container|image|volume|service|network|template|restic|snapshot/i);
    }
  });

  it("a live application is stopped first, a stopped one stays stopped, anything else is refused", () => {
    const accepted = { running: "stopping", degraded: "stopping", failed: "stopping", stopped: "stopped" } as const;
    for (const status of APP_STACK_STATUSES) {
      const target = appStackBackupEnqueueTarget(status);
      expect(target, status).toBe((accepted as Record<string, string>)[status] ?? null);
      if (target !== null && target !== status) expect(canTransitionAppStack(status, target), status).toBe(true);
    }
    expect(canTransitionAppStack("stopping", "stopped")).toBe(true);
  });

  it("the outbox payload carries ids only and passes the secret guards", () => {
    const business = { stackId: STACK, backupId: "sbak_0123456789abcdef01234567", sourceBackupId: null };
    const payload = { operationId: OP, organizationId: "org_1", kind: "stack.backup", resourceType: "stack", resourceId: STACK, ...business };
    expect(guards(payload)).toEqual([[], [], []]);
    expect(AppStackBackupOperationPayloadSchema.parse(payload)).toEqual(business);
    expect(AppStackBackupOperationPayloadSchema.parse({ stackId: STACK, backupId: null, sourceBackupId: null }).backupId).toBeNull();
    expect(AppStackBackupOperationPayloadSchema.safeParse({ ...business, stackId: "Stk-1" }).success).toBe(false);
  });

  it("no new permission; two audit actions; two id prefixes", () => {
    // Backups of applications use the application permissions that exist: the list of those is unchanged.
    expect(PERMISSION_KEYS.filter((key) => key.startsWith("app."))).toEqual([
      "app.read",
      "app.create",
      "app.update",
      "app.control",
      "app.delete",
    ]);
    expect(APP_AUDIT_ACTIONS.backupCreate).toBe("app.stack.backup.create");
    expect(APP_AUDIT_ACTIONS.backupRestore).toBe("app.stack.backup.restore");
    expect(APP_ID_PREFIXES.backup).toBe("sbak");
    expect(APP_ID_PREFIXES.backupCopy).toBe("sbkc");
  });
});

describe("application backups: DTO and inputs", () => {
  const dto = {
    id: "sbak_0123456789abcdef01234567",
    kind: "manual",
    status: "partial",
    problem: null,
    sizeBytes: 1024,
    volumeKeys: ["data", "db"],
    copies: [
      { priority: 1, status: "succeeded", problem: null },
      { priority: 2, status: "failed", problem: "unreachable" },
    ],
    startedAt: "2026-11-23T10:00:00.000Z",
    finishedAt: "2026-11-23T10:05:00.000Z",
    restore: { status: "failed", problem: "interrupted", at: "2026-11-23T11:00:00.000Z" },
    restorable: true,
    incompleteData: false,
  };

  it("a backup row names no destination, address, path or key", () => {
    expect(AppStackBackupDtoSchema.parse(dto)).toEqual(dto);
    expect(guards(dto)).toEqual([[], [], []]);
    expect(Object.keys(dto.copies[0] ?? {})).toEqual(["priority", "status", "problem"]);
    expect(AppStackBackupsDtoSchema.parse({ backups: [dto], unavailableReason: "no_destination", goBackTo: dto.id }).backups).toHaveLength(1);
    expect(AppStackBackupsDtoSchema.safeParse({ backups: [], unavailableReason: "other", goBackTo: null }).success).toBe(false);
    expect(AppStackBackupsDtoSchema.safeParse({ backups: [], unavailableReason: null, goBackTo: "../other" }).success).toBe(false);
  });

  it("a restore asks for the application's name and nothing else", () => {
    expect(RestoreAppStackBackupInputSchema.parse({ confirmName: "Shop" })).toEqual({ confirmName: "Shop" });
    expect(RestoreAppStackBackupInputSchema.safeParse({}).success).toBe(false);
    expect(RestoreAppStackBackupInputSchema.safeParse({ confirmName: "Shop", targetId: "x" }).success).toBe(false);
  });
});

describe("application backups: executor requests", () => {
  const start = { action: "stackStart", jobId: OP, stackId: STACK, organizationId: "org_1", volumeKeys: ["data", "db"], target: LOCAL_TARGET };
  const restore = { ...start, action: "stackRestore", jobId: `${OP}-apply`, snapshotId: SNAPSHOT };
  const forget = { action: "stackForget", jobId: `${OP}-forget`, stackId: STACK, target: LOCAL_TARGET, snapshotIds: [SNAPSHOT] };
  const ok = (value: unknown): boolean => BackupsIpcRequestSchema.safeParse(value).success;

  it("accepts the three closed requests", () => {
    expect(ok(start)).toBe(true);
    expect(ok({ ...start, jobId: `${OP}-t2` })).toBe(true);
    expect(ok(restore)).toBe(true);
    expect(ok(forget)).toBe(true);
    expect(ok({ ...forget, jobId: `${OP}-forget-t2` })).toBe(true);
    for (const action of ["stackStart", "stackRestore", "stackForget"] as const) {
      expect(BACKUPS_RESULT_SCHEMAS[action]).toBe(BACKUPS_RESULT_SCHEMAS.start);
    }
  });

  it("refuses a name, a path or a repository chosen by the caller", () => {
    expect(ok({ ...start, volumeName: "hp_appvol_x" })).toBe(false);
    expect(ok({ ...start, repository: "/srv/other" })).toBe(false);
    expect(ok({ ...start, volumeKeys: [] })).toBe(false);
    expect(ok({ ...start, volumeKeys: ["data", "data"] })).toBe(false);
    expect(ok({ ...start, volumeKeys: ["../etc"] })).toBe(false);
    expect(ok({ ...start, volumeKeys: Array.from({ length: 9 }, (_, i) => `v${String(i)}`) })).toBe(false);
    expect(ok({ ...start, stackId: "../x" })).toBe(false);
    expect(ok({ ...start, stackId: "Stk_1" })).toBe(false);
    expect(ok({ ...start, organizationId: "Org 1" })).toBe(false);
    expect(ok({ ...start, jobId: `${OP}-apply` })).toBe(false);
    expect(ok({ ...restore, jobId: OP })).toBe(false);
    expect(ok({ ...restore, snapshotId: "latest" })).toBe(false);
    expect(ok({ ...forget, snapshotIds: [] })).toBe(false);
    expect(ok({ ...forget, snapshotIds: ["latest"] })).toBe(false);
    expect(ok({ ...forget, organizationId: "org_1" })).toBe(false);
  });

  it("the job id pattern gains only the apply suffix", () => {
    expect(BACKUP_JOB_ID_PATTERN.test(`${OP}-apply`)).toBe(true);
    for (const id of [`${OP}-restore`, `${OP}-archive`, `${OP}-apply-t2`, `${OP}-applyx`, `${OP}-t2-apply`]) {
      expect(BACKUP_JOB_ID_PATTERN.test(id), id).toBe(false);
    }
  });
});
