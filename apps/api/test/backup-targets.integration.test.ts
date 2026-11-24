import { generateKeyPairSync } from "node:crypto";
import {
  AdminBackupTargetDtoSchema,
  BackupTargetsDtoSchema,
  findForbiddenPublicDtoKeys,
  type BackupsIpcRequest,
  type BackupsResultByAction,
} from "@hosting-panel/contracts";
import {
  LEGACY_BACKUP_TARGET_ID,
  auditEvents,
  backupSettings,
  backupTargets,
  createDatabaseClient,
  eq,
  getPolicy,
  insertSiteBackup,
  insertSiteBackupCopies,
  outboxEvents,
  resolveDispatchTarget,
  setPolicyTargets,
  sql,
  upsertBackupSettings,
  type DatabaseClient,
} from "@hosting-panel/database";
import { ExecutorIpcClientError, InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module.js";
import { BackupTargetsService } from "../src/backups/backup-targets.service.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { AdminBackupTargetsController } from "../src/controllers/admin-backup-targets.controller.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { totpCodeAt } from "../src/auth/totp.js";

const KEY = Buffer.alloc(32, 9);
const PW = "correct horse battery";
const BASE = "/v1/admin/backup-targets";
const CANARY = "canary-target-s3-secret-DO-NOT-LEAK-31";
const ROTATED = "canary-rotated-target-secret-DO-NOT-LEAK-32";

const S3 = {
  kind: "s3",
  name: "Off-site",
  endpoint: "https://s3.example.com",
  region: "eu-south-1",
  bucket: "target-bucket",
  prefix: "panel",
  accessKeyId: "AKIATARGETTEST001",
  secretAccessKey: CANARY,
} as const;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type TestAnswer = BackupsResultByAction["test"];

interface Http {
  readonly status: number;
  readonly body: Json;
  readonly raw: string;
}

async function http(
  baseUrl: string,
  method: string,
  path: string,
  options?: { token?: string; body?: unknown; rawBody?: string },
): Promise<Http> {
  const headers: Record<string, string> = {};
  if (options?.token) headers["Authorization"] = `Bearer ${options.token}`;
  let payload: string | undefined;
  if (options?.rawBody !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = options.rawBody;
  } else if (options?.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(options.body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  const raw = await res.text();
  return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
}

async function login(baseUrl: string, email: string, password: string, totpSecret?: string): Promise<string> {
  const res = await http(baseUrl, "POST", "/v1/auth/login", {
    body: {
      email,
      password,
      ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
    },
  });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${res.raw}`);
  return res.body.data.accessToken as string;
}

describe("admin backup targets API", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let app: ControlPlaneAppHandle;
  let adminToken: string;
  let ownerToken: string;
  let calls: BackupsIpcRequest[];
  let testAnswer: () => Promise<TestAnswer> | TestAnswer;
  let initAnswer: () => Promise<TestAnswer> | TestAnswer;
  const responses: string[] = [];

  const admin = async (method: string, path: string, options?: { body?: unknown; rawBody?: string }) => {
    const res = await http(app.baseUrl!, method, path, { token: adminToken, ...options });
    responses.push(res.raw);
    return res;
  };
  const create = async (body: unknown) => admin("POST", BASE, { body });
  const createS3 = async (over: Record<string, unknown> = {}) => {
    const res = await create({ ...S3, bucket: `b-${Math.random().toString(36).slice(2, 10)}`, ...over });
    expect(res.status, res.raw).toBe(201);
    return res.body.data as Json;
  };
  const archiveLocal = async () => {
    for (const t of (await admin("GET", BASE)).body.data.targets as Json[]) {
      if (t.kind === "local" && t.archivedAt === null) {
        expect((await admin("PATCH", `${BASE}/${t.id}`, { body: { archived: true } })).status).toBe(200);
      }
    }
  };
  const auditsOf = async (action: string) =>
    (await dbClient.db.select().from(auditEvents)).filter((a) => a.action === action);

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, { installationName: "Targets Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" });
    const serverAdmin = await createServerAdmin(dbClient.db, KEY, { email: "targets-admin@x.it", name: "Admin", password: PW });

    sim = new InMemoryDockerSimulatorAdapter();
    sim.backups = (async (req: BackupsIpcRequest) => {
      calls.push(req);
      if (req.action === "test") return testAnswer();
      if (req.action === "localInit") return initAnswer();
      throw new Error(`Unexpected backup action in test stub: ${req.action}`);
    }) as DockerExecutorPort["backups"];

    // Registers the controller and service until app.module.ts does (it is not part of this task); idempotent after.
    const register = AppModule.register.bind(AppModule);
    vi.spyOn(AppModule, "register").mockImplementation((options) => {
      const mod = register(options);
      const controllers = mod.controllers ?? [];
      const providers = mod.providers ?? [];
      return {
        ...mod,
        controllers: controllers.includes(AdminBackupTargetsController) ? controllers : [...controllers, AdminBackupTargetsController],
        providers: providers.includes(BackupTargetsService) ? providers : [...providers, BackupTargetsService],
      };
    });

    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      runtimeBackend: "linux-systemd",
      dockerExecutor: sim,
      hostAgent: new InMemoryHostSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login(app.baseUrl!, "targets-admin@x.it", PW, serverAdmin.totpSecretBase32);

    // An install that configured S3 before this release: backup_settings plus the legacy target migration 0022 backfills.
    await upsertBackupSettings(dbClient.db, KEY, {
      endpoint: "https://legacy.example.com",
      region: "eu-south-1",
      bucket: "legacy-bucket",
      prefix: "",
      accessKeyId: "AKIALEGACY0000001",
      secretAccessKey: CANARY,
      scheduleHourUtc: 2,
      retentionDays: 14,
      updatedByUserId: null,
    });
    const customer = await http(app.baseUrl!, "POST", "/v1/admin/customer-account", {
      token: adminToken,
      body: { organizationName: "Targets Org", ownerEmail: "owner-targets@hotel.it", ownerName: "Mario" },
    });
    expect(customer.status).toBe(201);
    await skipPasswordChange(dbClient.db, "owner-targets@hotel.it");
    ownerToken = await login(app.baseUrl!, "owner-targets@hotel.it", customer.body.data.temporaryPassword as string);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    calls = [];
    testAnswer = () => ({ outcome: "ok", problem: null });
    initAnswer = () => ({ outcome: "ok", problem: null, availableBytes: 40_000_000_000, totalBytes: 100_000_000_000, localRoot: "/var/lib/hosting-panel/local-repos" });
  });

  afterEach(async () => {
    await archiveLocal();
  });

  describe("authorization", () => {
    const routes = [
      ["GET", BASE],
      ["POST", BASE],
      ["PATCH", `${BASE}/bkt_${"a".repeat(32)}`],
      ["POST", `${BASE}/bkt_${"a".repeat(32)}/test`],
      ["POST", `${BASE}/bkt_${"a".repeat(32)}/initialize`],
      ["DELETE", `${BASE}/bkt_${"a".repeat(32)}`],
    ] as const;

    it("answers 401 without a token and 403 to a customer, even with an invalid body", async () => {
      for (const [method, path] of routes) {
        expect((await http(app.baseUrl!, method, path)).status, `${method} ${path}`).toBe(401);
        const denied = await http(app.baseUrl!, method, path, { token: ownerToken, body: method === "GET" || method === "DELETE" ? undefined : { kind: "nope", bogus: true } });
        expect(denied.status, `${method} ${path}`).toBe(403);
        expect(denied.body.error.code).toBe("PERMISSION_DENIED");
      }
      expect(calls).toEqual([]);
    });

    it("rejects an unparsable body from an administrator", async () => {
      const res = await admin("POST", BASE, { rawBody: "{not json" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("list and create", () => {
    it("lists the legacy target read from backup_settings, without its secret", async () => {
      const res = await admin("GET", BASE);
      expect(res.status).toBe(200);
      const dto = BackupTargetsDtoSchema.parse(res.body.data);
      expect(dto.localRootConfigured).toBe(true);
      const legacy = dto.targets.find((t) => t.id === LEGACY_BACKUP_TARGET_ID);
      expect(legacy).toMatchObject({
        kind: "s3",
        legacy: true,
        local: null,
        lastTest: null,
        archivedAt: null,
        s3: { endpoint: "https://legacy.example.com", bucket: "legacy-bucket", prefix: "", accessKeyId: "AKIALEGACY0000001", secretAccessKeySet: true },
      });
      expect(legacy?.usage.policies.sort()).toEqual(["default_site", "panel"]);
      expect(res.raw).not.toContain(CANARY);
    });

    it("creates an S3 target: encrypted secret, no secret in the answer, location key by the database", async () => {
      const res = await create(S3);
      expect(res.status).toBe(201);
      const dto = AdminBackupTargetDtoSchema.parse(res.body.data);
      expect(dto).toMatchObject({
        kind: "s3",
        name: "Off-site",
        enabled: true,
        customerSelectable: false,
        legacy: false,
        archivedAt: null,
        local: null,
        lastTest: null,
        usage: { copies: 0, policies: [] },
        s3: { endpoint: S3.endpoint, region: S3.region, bucket: S3.bucket, prefix: "panel", accessKeyId: S3.accessKeyId, secretAccessKeySet: true },
      });
      expect(res.raw).not.toContain(CANARY);
      expect(findForbiddenPublicDtoKeys(res.body)).toEqual([]);

      const [row] = await dbClient.db.select().from(backupTargets).where(eq(backupTargets.id, dto.id));
      expect(row?.s3LocationKey).toBeTruthy();
      expect(JSON.stringify(row?.configJson)).not.toContain(CANARY);
      expect(row?.s3SecretCiphertextBase64).toBeTruthy();
      expect(await resolveDispatchTarget(dbClient.db, KEY, dto.id)).toEqual({
        endpoint: S3.endpoint,
        region: S3.region,
        bucket: S3.bucket,
        prefix: "panel",
        accessKeyId: S3.accessKeyId,
        secretAccessKey: CANARY,
      });

      const audits = await auditsOf("admin.backup_target.create");
      expect(audits.at(-1)?.details).toEqual({ targetId: dto.id, targetKind: "s3" });
      expect(JSON.stringify(audits)).not.toContain(CANARY);
    });

    it("honours enabled:false and customerSelectable at creation", async () => {
      const dto = await createS3({ enabled: false, customerSelectable: true });
      expect(dto).toMatchObject({ enabled: false, customerSelectable: true });
    });

    it("refuses a second target on the same repository with 409", async () => {
      const first = await createS3();
      const again = await create({ ...S3, bucket: first.s3.bucket, name: "Same repository" });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("ALREADY_EXISTS");
    });

    it("refuses a new target on the repository the legacy target already uses", async () => {
      const res = await create({ ...S3, endpoint: "https://legacy.example.com", bucket: "legacy-bucket", prefix: "" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ALREADY_EXISTS");
    });

    it("creates the one local target from {kind, name} only; root and space stay empty until the executor answers", async () => {
      const res = await create({ kind: "local", name: "This server" });
      expect(res.status).toBe(201);
      const dto = AdminBackupTargetDtoSchema.parse(res.body.data);
      expect(dto).toMatchObject({ kind: "local", s3: null, local: { root: null, initializedAt: null }, lastTest: null });
      expect(calls).toEqual([]);
    });

    it("refuses a second local target with local_target_exists, and allows a new one once the first is archived", async () => {
      expect((await create({ kind: "local", name: "First" })).status).toBe(201);
      const second = await create({ kind: "local", name: "Second" });
      expect(second.status).toBe(400);
      expect(second.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "local_target_exists" });
      await archiveLocal();
      expect((await create({ kind: "local", name: "Third" })).status).toBe(201);
    });

    it.each([
      ["a path on a local target", { kind: "local", name: "x", root: "/srv/backups" }],
      ["a path-like extra key", { kind: "local", name: "x", path: "/srv/backups" }],
      ["S3 fields on a local target", { kind: "local", name: "x", bucket: "b" }],
      ["a missing secret", { ...S3, secretAccessKey: undefined }],
      ["an unknown kind", { kind: "nfs", name: "x" }],
      ["an empty name", { kind: "local", name: " " }],
      ["no body", {}],
    ])("rejects %s", async (_label, body) => {
      const res = await create(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("update and archive", () => {
    it("edits name and flags, and audits the field names", async () => {
      const t = await createS3();
      const res = await admin("PATCH", `${BASE}/${t.id}`, { body: { name: "Renamed", enabled: false, customerSelectable: true } });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: t.id, name: "Renamed", enabled: false, customerSelectable: true });
      const audit = (await auditsOf("admin.backup_target.update")).at(-1);
      expect(audit?.details).toEqual({ targetId: t.id, targetKind: "s3", fields: ["name", "enabled", "customerSelectable"] });
    });

    it("rotates the credentials of a non-legacy S3 target under its own AAD and forgets the last test", async () => {
      const t = await createS3();
      testAnswer = () => ({ outcome: "failed", problem: "auth_failed" });
      expect((await admin("POST", `${BASE}/${t.id}/test`, { body: {} })).status).toBe(200);
      const res = await admin("PATCH", `${BASE}/${t.id}`, { body: { accessKeyId: "AKIAROTATED0000001", secretAccessKey: ROTATED, region: "eu-west-1" } });
      expect(res.status).toBe(200);
      expect(res.body.data.s3).toMatchObject({ accessKeyId: "AKIAROTATED0000001", region: "eu-west-1", secretAccessKeySet: true });
      expect(res.body.data.lastTest).toBeNull();
      expect(res.raw).not.toContain(ROTATED);
      expect(await resolveDispatchTarget(dbClient.db, KEY, t.id)).toMatchObject({ secretAccessKey: ROTATED, accessKeyId: "AKIAROTATED0000001" });
      const audit = (await auditsOf("admin.backup_target.update")).at(-1);
      expect(audit?.details).toEqual({ targetId: t.id, targetKind: "s3", fields: ["credentials"] });
      expect(JSON.stringify(audit)).not.toContain(ROTATED);
    });

    it.each([["endpoint", "https://other.example.com"], ["bucket", "other-bucket"], ["prefix", "other"]])(
      "refuses to move a target to another %s: a target id is a repository",
      async (field, value) => {
        const t = await createS3();
        const res = await admin("PATCH", `${BASE}/${t.id}`, { body: { [field]: value } });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "location_immutable" });
      },
    );

    it.each([
      ["an empty body", {}],
      ["an unknown key", { root: "/srv/x" }],
      ["a kind", { kind: "local" }],
      ["archived:false", { archived: false }],
      ["an id", { id: `bkt_${"b".repeat(32)}` }],
    ])("rejects %s", async (_label, body) => {
      const t = await createS3();
      const res = await admin("PATCH", `${BASE}/${t.id}`, { body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("refuses a per-target retention (the policy owns it) and credentials on a local target", async () => {
      const t = await createS3();
      const retention = await admin("PATCH", `${BASE}/${t.id}`, { body: { retentionDays: 3 } });
      expect(retention.body.error.message).toBe("retention_not_editable");
      const local = (await create({ kind: "local", name: "L" })).body.data as Json;
      const creds = await admin("PATCH", `${BASE}/${local.id}`, { body: { accessKeyId: "AKIAXXXXXXXXXXXXX" } });
      expect(creds.status).toBe(400);
      expect(creds.body.error.message).toBe("credentials_not_editable");
    });

    it("lets the legacy target change name and flags only", async () => {
      const ok = await admin("PATCH", `${BASE}/${LEGACY_BACKUP_TARGET_ID}`, { body: { name: "Primary S3", customerSelectable: true } });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({ legacy: true, name: "Primary S3", customerSelectable: true });
      for (const body of [{ secretAccessKey: ROTATED }, { accessKeyId: "AKIAXXXXXXXXXXXXX" }, { region: "eu-west-1" }]) {
        const res = await admin("PATCH", `${BASE}/${LEGACY_BACKUP_TARGET_ID}`, { body });
        expect(res.status).toBe(400);
        expect(res.body.error.message).toBe("legacy_target_locked");
      }
      await admin("PATCH", `${BASE}/${LEGACY_BACKUP_TARGET_ID}`, { body: { customerSelectable: false } });
    });

    it("archives a target: disabled, unselectable, out of every policy, audited, data and rows kept", async () => {
      const t = await createS3({ customerSelectable: true });
      const policy = await getPolicy(dbClient.db, "default_site");
      await setPolicyTargets(dbClient.db, policy.id, [t.id]);
      expect((await admin("GET", BASE)).body.data.targets.find((x: Json) => x.id === t.id).usage.policies).toEqual(["default_site"]);

      const res = await admin("PATCH", `${BASE}/${t.id}`, { body: { archived: true } });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ enabled: false, customerSelectable: false, usage: { policies: [] } });
      expect(res.body.data.archivedAt).toEqual(expect.any(String));
      expect(calls).toEqual([]);
      expect((await auditsOf("admin.backup_target.archive")).at(-1)?.details).toEqual({ targetId: t.id, targetKind: "s3" });

      const again = await admin("PATCH", `${BASE}/${t.id}`, { body: { archived: true } });
      expect(again.status).toBe(200);
      expect(again.body.data.archivedAt).toBe(res.body.data.archivedAt);
      const revive = await admin("PATCH", `${BASE}/${t.id}`, { body: { enabled: true } });
      expect(revive.status).toBe(400);
      expect(revive.body.error.message).toBe("target_archived");
      expect(await resolveDispatchTarget(dbClient.db, KEY, t.id)).toMatchObject({ secretAccessKey: CANARY });
    });

    it("archives the legacy target without touching backup_settings", async () => {
      const res = await admin("PATCH", `${BASE}/${LEGACY_BACKUP_TARGET_ID}`, { body: { archived: true } });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ legacy: true, enabled: false });
      expect(await dbClient.db.select().from(backupSettings)).toHaveLength(1);
    });

    it("answers 404 for an unknown or malformed id", async () => {
      expect((await admin("PATCH", `${BASE}/bkt_${"0".repeat(32)}`, { body: { name: "x" } })).status).toBe(404);
      expect((await admin("PATCH", `${BASE}/not-an-id`, { body: { name: "x" } })).status).toBe(404);
    });
  });

  describe("test", () => {
    it("sends the decrypted dispatch object, persists the outcome and shows it in the list", async () => {
      const t = await createS3();
      const res = await admin("POST", `${BASE}/${t.id}/test`, { body: {} });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ outcome: "ok", problem: null });
      expect(calls).toEqual([
        {
          action: "test",
          target: { endpoint: S3.endpoint, region: S3.region, bucket: t.s3.bucket, prefix: "panel", accessKeyId: S3.accessKeyId, secretAccessKey: CANARY },
        },
      ]);
      const listed = (await admin("GET", BASE)).body.data.targets.find((x: Json) => x.id === t.id);
      expect(listed.lastTest).toMatchObject({ outcome: "ok", problem: null, availableBytes: null, totalBytes: null });
      expect(Date.parse(listed.lastTest.at)).not.toBeNaN();
      expect((await auditsOf("admin.backup_target.test")).at(-1)?.details).toEqual({ targetId: t.id, targetKind: "s3", outcome: "ok", problem: null });
    });

    it("persists a failure with its stable problem code, and maps an unknown class to other", async () => {
      const t = await createS3();
      testAnswer = () => ({ outcome: "failed", problem: "unreachable" });
      expect((await admin("POST", `${BASE}/${t.id}/test`, { body: {} })).body.data).toEqual({ outcome: "failed", problem: "unreachable" });
      expect((await admin("GET", BASE)).body.data.targets.find((x: Json) => x.id === t.id).lastTest).toMatchObject({ outcome: "failed", problem: "unreachable" });
      testAnswer = () => ({ outcome: "failed", problem: "weird" }) as unknown as TestAnswer;
      expect((await admin("POST", `${BASE}/${t.id}/test`, { body: {} })).body.data.problem).toBe("other");
    });

    it("mirrors the test of the legacy target into backup_settings.last_test_*", async () => {
      testAnswer = () => ({ outcome: "failed", problem: "auth_failed" });
      const res = await admin("POST", `${BASE}/${LEGACY_BACKUP_TARGET_ID}/test`, { body: {} });
      expect(res.body.data).toEqual({ outcome: "failed", problem: "auth_failed" });
      expect(calls[0]).toMatchObject({ action: "test", target: { bucket: "legacy-bucket", secretAccessKey: CANARY } });
      const [settings] = await dbClient.db.select().from(backupSettings);
      expect(settings).toMatchObject({ lastTestOutcome: "failed", lastTestProblem: "auth_failed" });
      expect(settings?.lastTestAt).toBeInstanceOf(Date);
    });

    it("tests a local target by reference only and stores the space and root the executor reports", async () => {
      const local = (await create({ kind: "local", name: "L" })).body.data as Json;
      testAnswer = () => ({ outcome: "ok", problem: null, availableBytes: 5_000_000_000, totalBytes: 9_000_000_000, localRoot: "/var/lib/hosting-panel/local-repos" });
      const res = await admin("POST", `${BASE}/${local.id}/test`, { body: {} });
      expect(res.body.data).toEqual({ outcome: "ok", problem: null, availableBytes: 5_000_000_000, totalBytes: 9_000_000_000 });
      expect(calls).toEqual([{ action: "test", target: { kind: "local", targetId: local.id } }]);
      const listed = (await admin("GET", BASE)).body.data.targets.find((x: Json) => x.id === local.id);
      expect(listed.local).toEqual({ root: "/var/lib/hosting-panel/local-repos", initializedAt: null });
      expect(listed.lastTest).toMatchObject({ outcome: "ok", availableBytes: 5_000_000_000, totalBytes: 9_000_000_000 });
    });

    it("rejects a body, and answers 404 for an unknown target without calling the executor", async () => {
      const t = await createS3();
      expect((await admin("POST", `${BASE}/${t.id}/test`, { body: { force: true } })).status).toBe(400);
      expect((await admin("POST", `${BASE}/bkt_${"0".repeat(32)}/test`, { body: {} })).status).toBe(404);
      expect(calls).toEqual([]);
    });

    it("maps executor failures to stable errors and records nothing", async () => {
      const t = await createS3();
      testAnswer = () => {
        throw Object.assign(new Error("timeout"), { ambiguousOutcome: true });
      };
      const ambiguous = await admin("POST", `${BASE}/${t.id}/test`, { body: {} });
      expect(ambiguous.body.error.code).toBe("OPERATION_AMBIGUOUS");
      testAnswer = () => {
        throw new Error("socket closed");
      };
      const down = await admin("POST", `${BASE}/${t.id}/test`, { body: {} });
      expect(down.body.error.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
      expect(down.raw).not.toContain("socket closed");
      expect((await admin("GET", BASE)).body.data.targets.find((x: Json) => x.id === t.id).lastTest).toBeNull();
    });
  });

  describe("initialize", () => {
    it("sends the local reference to the executor and stores the marker time, root and space", async () => {
      const local = (await create({ kind: "local", name: "L" })).body.data as Json;
      const res = await admin("POST", `${BASE}/${local.id}/initialize`, { body: {} });
      expect(res.status).toBe(200);
      expect(calls).toEqual([{ action: "localInit", target: { kind: "local", targetId: local.id } }]);
      const dto = AdminBackupTargetDtoSchema.parse(res.body.data);
      expect(dto.local).toEqual({ root: "/var/lib/hosting-panel/local-repos", initializedAt: expect.any(String) });
      expect(dto.lastTest).toMatchObject({ outcome: "ok", availableBytes: 40_000_000_000, totalBytes: 100_000_000_000 });
      expect((await auditsOf("admin.backup_target.initialize")).at(-1)?.details).toEqual({ targetId: local.id, targetKind: "local", outcome: "ok", problem: null });
    });

    it("reports localRootConfigured false while the executor refuses the root (local_target_unsafe) and true again after it accepts", async () => {
      const local = (await create({ kind: "local", name: "L" })).body.data as Json;
      const configured = async () => (await admin("GET", BASE)).body.data.localRootConfigured;
      expect(await configured()).toBe(true);
      initAnswer = () => ({ outcome: "failed", problem: "local_target_unsafe" });
      expect((await admin("POST", `${BASE}/${local.id}/initialize`, { body: {} })).status).toBe(200);
      expect(await configured()).toBe(false);
      initAnswer = () => ({ outcome: "ok", problem: null, availableBytes: 1, totalBytes: 2, localRoot: "/var/lib/hosting-panel/local-repos" });
      expect((await admin("POST", `${BASE}/${local.id}/initialize`, { body: {} })).status).toBe(200);
      expect(await configured()).toBe(true);
    });

    it("keeps the target uninitialised and records the failure when the executor refuses", async () => {
      const local = (await create({ kind: "local", name: "L" })).body.data as Json;
      initAnswer = () => ({ outcome: "failed", problem: "local_target_unmounted" });
      const res = await admin("POST", `${BASE}/${local.id}/initialize`, { body: {} });
      expect(res.status).toBe(200);
      expect(res.body.data.local.initializedAt).toBeNull();
      expect(res.body.data.lastTest).toMatchObject({ outcome: "failed", problem: "local_target_unmounted" });
    });

    // A lost connection, and an answer that cannot be read after the request was sent (#182).
    it.each([
      ["a lost connection", () => Object.assign(new Error("socket closed"), { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true })],
      [
        "an unreadable answer",
        () =>
          new ExecutorIpcClientError(
            "Unreadable docker-executor IPC answer after mutating command dispatch: the body is not JSON",
            "OPERATION_AMBIGUOUS",
            502,
            true,
          ),
      ],
    ])("answers an unknown outcome after %s, asks once and records neither a test nor the marker", async (_, lost) => {
      const local = (await create({ kind: "local", name: "L" })).body.data as Json;
      const auditsBefore = (await auditsOf("admin.backup_target.initialize")).length;
      initAnswer = () => {
        throw lost();
      };
      const res = await admin("POST", `${BASE}/${local.id}/initialize`, { body: {} });
      expect([res.status, res.body.error.code]).toEqual([502, "OPERATION_AMBIGUOUS"]);
      expect(calls).toEqual([{ action: "localInit", target: { kind: "local", targetId: local.id } }]);
      const after = (await admin("GET", BASE)).body.data.targets.find((x: Json) => x.id === local.id);
      expect([after.local.initializedAt, after.lastTest]).toEqual([null, null]);
      expect(await auditsOf("admin.backup_target.initialize")).toHaveLength(auditsBefore);
    });

    it("refuses an S3 target, an archived local target, a body and an unknown id", async () => {
      const s3 = await createS3();
      const notLocal = await admin("POST", `${BASE}/${s3.id}/initialize`, { body: {} });
      expect(notLocal.status).toBe(400);
      expect(notLocal.body.error.message).toBe("not_local");
      const local = (await create({ kind: "local", name: "L" })).body.data as Json;
      expect((await admin("POST", `${BASE}/${local.id}/initialize`, { body: { root: "/srv/x" } })).status).toBe(400);
      await archiveLocal();
      expect((await admin("POST", `${BASE}/${local.id}/initialize`, { body: {} })).body.error.message).toBe("target_archived");
      expect((await admin("POST", `${BASE}/bkt_${"0".repeat(32)}/initialize`, { body: {} })).status).toBe(404);
      expect(calls).toEqual([]);
    });
  });

  describe("delete", () => {
    it("deletes the row of an unreferenced target (204) without any executor call", async () => {
      const t = await createS3();
      const res = await admin("DELETE", `${BASE}/${t.id}`);
      expect(res.status).toBe(204);
      expect(calls).toEqual([]);
      expect((await dbClient.db.select().from(backupTargets).where(eq(backupTargets.id, t.id)))).toHaveLength(0);
      expect((await auditsOf("admin.backup_target.delete")).at(-1)?.details).toEqual({ targetId: t.id, targetKind: "s3" });
      expect((await admin("DELETE", `${BASE}/${t.id}`)).status).toBe(404);
    });

    it("answers 409 BACKUP_TARGET_IN_USE while a policy names it, and 204 once it is archived out of the policy", async () => {
      const t = await createS3();
      const policy = await getPolicy(dbClient.db, "default_site");
      await setPolicyTargets(dbClient.db, policy.id, [t.id]);
      const res = await admin("DELETE", `${BASE}/${t.id}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("BACKUP_TARGET_IN_USE");
      expect((await dbClient.db.select().from(backupTargets).where(eq(backupTargets.id, t.id)))).toHaveLength(1);
      expect((await admin("PATCH", `${BASE}/${t.id}`, { body: { archived: true } })).status).toBe(200);
      expect((await admin("DELETE", `${BASE}/${t.id}`)).status).toBe(204);
    });

    it("answers 409 for a target that holds copies, archived or not: history is never orphaned", async () => {
      const t = await createS3();
      const backup = await insertSiteBackup(dbClient.db, { siteId: "site_not_there", kind: "manual", status: "running", operationId: null });
      await insertSiteBackupCopies(dbClient.db, backup.id, `op_${"c".repeat(32)}`, [{ targetId: t.id, priority: 1, required: true }]);
      expect((await admin("GET", BASE)).body.data.targets.find((x: Json) => x.id === t.id).usage.copies).toBe(1);
      expect((await admin("DELETE", `${BASE}/${t.id}`)).body.error.code).toBe("BACKUP_TARGET_IN_USE");
      await admin("PATCH", `${BASE}/${t.id}`, { body: { archived: true } });
      expect((await admin("DELETE", `${BASE}/${t.id}`)).status).toBe(409);
    });

    it("never deletes the legacy target", async () => {
      const res = await admin("DELETE", `${BASE}/${LEGACY_BACKUP_TARGET_ID}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("BACKUP_TARGET_IN_USE");
      expect((await dbClient.db.select().from(backupTargets).where(eq(backupTargets.id, LEGACY_BACKUP_TARGET_ID)))).toHaveLength(1);
    });
  });

  it("never leaks an S3 secret into a response, an audit row, an outbox event or any table in plaintext", async () => {
    for (const secret of [CANARY, ROTATED]) {
      expect(responses.join("\n")).not.toContain(secret);
      expect(JSON.stringify(await dbClient.db.select().from(auditEvents))).not.toContain(secret);
      expect(JSON.stringify(await dbClient.db.select().from(outboxEvents))).not.toContain(secret);
      const tables = await dbClient.db.execute(sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
      for (const entry of tables.rows) {
        const name = String(entry["table_name"]);
        if (!/^[a-z0-9_]+$/i.test(name)) continue;
        const rows = await dbClient.db.execute(sql.raw(`SELECT * FROM "${name}"`));
        expect(JSON.stringify(rows.rows), `table ${name}`).not.toContain(secret);
      }
    }
  });
});
