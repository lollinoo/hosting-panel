import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  and,
  createDatabaseClient,
  domains,
  eq,
  operations,
  operationSteps,
  outboxEvents,
  serviceInstances,
  serviceTemplates,
  siteDatabases,
  sites,
  stackRevisions,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter, makeDir, type SimulatorSiteType } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { SiteBackupsApplier } from "../src/backups/site-backups-applier.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { SiteProvisioner } from "../src/runtime/site-provisioner.js";
import { SiteSftpService } from "../src/sites/site-sftp.service.js";
import { CONTROL_PLANE_CONFIG_TOKEN, type ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { TEST_API_SITE_TYPE } from "./fixtures/test-site-type.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Call { readonly method: string; readonly args: Json[] }

const KEY = Buffer.alloc(32, 9);
const PW = "sentinel-login-pass-0003";
const SETUP = { installationName: "Seams", hostHostname: "panel.example.test", hostIpv4: "192.0.2.10" };
const site = (n: string) => ({
  name: `Site ${n}`,
  domain: `wp-${n}.example.test`,
  includeWww: false,
  phpVersion: "8.3",
  title: `Site ${n}`,
  adminUser: "siteadmin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Admin-Pass-0003",
});
const BACKUP_SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "eu-south-1",
  bucket: "seams-bucket",
  prefix: "panel/seams",
  accessKeyId: "SENTINELACCESSKEY03",
  secretAccessKey: "sentinel-secret-access-key-0003",
  scheduleHourUtc: 2,
  retentionDays: 14,
};
// What the boundary scan looks for, as values of a generated text.
const WORDPRESS_VALUES = /wordpress|wp-|wp_|\/var\/www\/html|33:33|"html"|_html\b|tpl_site_wordpress/i;

/** The simulator's view of the API's test type, registered from apps/api through the option. */
const TEST_SIMULATOR_SITE_TYPE: SimulatorSiteType = {
  def: TEST_API_SITE_TYPE.definition,
  protectedPaths: [],
  shellId: "uid=1000 gid=1000 groups=1000",
  seed: () => makeDir(),
  ops: [],
  createOps: null,
};

/** Wraps an executor so every call is recorded with a deep copy of its arguments. */
function recording<T extends object>(target: T, calls: Call[], strip = false): T {
  return new Proxy(target, {
    get(t, prop) {
      const v = Reflect.get(t, prop, t) as unknown;
      if (typeof v !== "function" || typeof prop !== "string") return v;
      return (...args: unknown[]) => {
        calls.push({ method: prop, args: JSON.parse(JSON.stringify(args ?? [])) as Json[] });
        // This release's request schemas know only wordpress: the test type's key is recorded, then dropped.
        const [req, ...rest] = args;
        const sent = strip && req && typeof req === "object" ? (({ siteType: _k, ...plain }) => plain)(req as Json) : req;
        return (v as (...a: unknown[]) => unknown).apply(t, [sent, ...rest]);
      };
    },
  });
}

describe("a site that is not WordPress is never handled as one (R205 2.1) and the seams of a type without a database", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let adminSecret: string;
  let adminId: string;
  let ownerToken: string;
  let orgId: string;
  let siteId: string;
  let genericId: string;
  let backupId: string;
  let domainId: string;
  const calls: Call[] = [];

  async function http(method: string, path: string, body?: unknown, token = ownerToken): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": randomUUID(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    let parsed: Json;
    try {
      parsed = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      parsed = { raw };
    }
    return { status: res.status, body: parsed };
  }

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function drain(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if ((await app.outboxWorker.processPendingOnce()).claimed === 0) return;
    }
    throw new Error("outbox never drained");
  }

  async function operation(operationId: string): Promise<{ status: string; errorCode: string | null }> {
    const [row] = await dbClient.db.select().from(operations).where(eq(operations.id, operationId));
    return { status: row!.status, errorCode: row!.errorCode };
  }

  async function stepsOf(operationId: string): Promise<Array<{ key: string; status: string }>> {
    return await dbClient.db
      .select({ key: operationSteps.key, status: operationSteps.status })
      .from(operationSteps)
      .where(eq(operationSteps.operationId, operationId))
      .orderBy(operationSteps.startedAt, operationSteps.id);
  }

  const totp = async () => {
    await dbClient.db.update(users).set({ totpLastStep: null }).where(eq(users.id, adminId));
    return { code: totpCodeAt(adminSecret, Math.floor(Date.now() / 30_000)) };
  };
  const setType = (id: string, siteType: string | null) => dbClient.db.update(sites).set({ siteType }).where(eq(sites.id, id));
  const count = async () => ({
    operations: (await dbClient.db.select({ id: operations.id }).from(operations)).length,
    outbox: (await dbClient.db.select({ id: outboxEvents.id }).from(outboxEvents)).length,
  });

  /** Every route of the subsystems for one site: [label, method, path, body, admin?]. */
  async function routes(id: string): Promise<Array<[string, string, string, unknown, boolean]>> {
    const s = `/v1/organizations/${orgId}/managed-sites/${id}`;
    const chunk = Buffer.from("x\n").toString("base64");
    return [
      ["files list", "GET", `${s}/files?path=`, undefined, false],
      ["files read", "GET", `${s}/files/content?path=index.php`, undefined, false],
      ["files write", "PUT", `${s}/files/content`, { path: "a.txt", uploadId: "upl_0123456789abcdef", offset: 0, dataBase64: chunk, final: true, overwrite: true }, false],
      ["files folder", "POST", `${s}/files/folders`, { path: "d" }, false],
      ["files move", "POST", `${s}/files/move`, { from: "a.txt", to: "b.txt" }, false],
      ["files delete", "POST", `${s}/files/delete`, { paths: ["a.txt"] }, false],
      ["files archive", "POST", `${s}/files/archive`, { paths: ["a.txt"], to: "a.zip" }, false],
      ["files extract", "POST", `${s}/files/extract`, { path: "a.zip", to: "" }, false],
      ["sftp get", "GET", `${s}/sftp`, undefined, false],
      ["sftp create", "POST", `${s}/sftp/users`, { name: "dev9" }, false],
      ["sftp reset", "POST", `${s}/sftp/users/sftpu_0123456789abcdef/reset-password`, {}, false],
      ["sftp delete", "DELETE", `${s}/sftp/users/sftpu_0123456789abcdef`, undefined, false],
      ["databases get", "GET", `${s}/databases`, undefined, false],
      ["databases create", "POST", `${s}/databases`, { name: "extra" }, false],
      ["databases sign-on", "POST", `${s}/databases/phpmyadmin`, {}, false],
      ["databases sign-on get", "GET", `${s}/databases/phpmyadmin`, undefined, false],
      ["databases delete", "DELETE", `${s}/databases/x_0123456789ab_extra`, undefined, false],
      ["database user create", "POST", `${s}/database-users`, { name: "reader" }, false],
      ["database user reset", "POST", `${s}/database-users/x_0123456789ab_reader/reset-password`, {}, false],
      ["database user delete", "DELETE", `${s}/database-users/x_0123456789ab_reader`, undefined, false],
      ["database grant", "PUT", `${s}/database-users/x_0123456789ab_reader/grants/x_0123456789ab_extra`, { privileges: "read" }, false],
      ["database revoke", "DELETE", `${s}/database-users/x_0123456789ab_reader/grants/x_0123456789ab_extra`, undefined, false],
      ["backups list", "GET", `${s}/backups`, undefined, false],
      ["backup start", "POST", `${s}/backups`, {}, false],
      ["restore", "POST", `${s}/backups/${backupId}/restore`, { confirmName: "Site a" }, false],
      ["backup download", "POST", `${s}/backups/${backupId}/download`, {}, false],
      ["backup download get", "GET", `${s}/backups/${backupId}/download`, undefined, false],
      ["wordpress get", "GET", `${s}/wordpress`, undefined, false],
      ["wordpress refresh", "POST", `${s}/wordpress/refresh`, {}, false],
      ["wordpress updates", "POST", `${s}/wordpress/updates`, { scope: "all" }, false],
      ["wordpress password reset", "POST", `${s}/wordpress/administrators/1/password-reset`, {}, false],
      ["import get", "GET", `${s}/wordpress/import`, undefined, false],
      ["import pick", "POST", `${s}/wordpress/import/files/archive/pick`, { path: "a.zip" }, false],
      ["import discard", "DELETE", `${s}/wordpress/import/files`, undefined, false],
      ["import start", "POST", `${s}/wordpress/import`, {}, false],
      ["main address", "POST", `${s}/domains/${domainId}/primary`, {}, false],
      ["php change", "PATCH", `${s}/runtime`, { phpVersion: "8.4" }, false],
      ["admin main address", "POST", `/v1/admin/sites/${id}/domains/${domainId}/primary`, {}, true],
      ["admin backup run", "POST", `/v1/admin/backups/sites/${id}/run`, {}, true],
      ["admin restore", "POST", `/v1/admin/backups/sites/${id}/restore`, { confirmName: "Site a" }, true],
      ["admin image update", "POST", `/v1/admin/sites/${id}/image-update`, {}, true],
      ["terminal open", "POST", `/v1/admin/sites/${id}/terminal`, await totp(), true],
    ];
  }

  /** The answer of one route: status and error code. */
  const answer = (r: { status: number; body: Json }) => `${String(r.status)} ${String(r.body.error?.code ?? "")}`;

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    adminSecret = admin.totpSecretBase32;
    adminId = admin.userId;
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      runtimeBackend: "linux-systemd",
      dockerExecutor: recording(sim, calls),
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
    adminToken = await login("admin@example.test", PW, adminSecret);
    const created = await http(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Org S", ownerEmail: "owner@example.test", ownerName: "Owner S" },
      adminToken,
    );
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    ownerToken = await login("owner@example.test", created.body.data.temporaryPassword as string);

    const res = await http("POST", `/v1/organizations/${orgId}/managed-sites`, site("a"));
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    siteId = res.body.data.siteId as string;
    await drain();
    const [d] = await dbClient.db.select().from(domains).where(eq(domains.siteId, siteId));
    domainId = d!.id;

    expect((await http("PATCH", "/v1/admin/backups", BACKUP_SETTINGS, adminToken)).status).toBe(200);
    const b = await http("POST", `/v1/organizations/${orgId}/managed-sites/${siteId}/backups`, {});
    expect(b.status, JSON.stringify(b.body)).toBe(202);
    backupId = b.body.data.backupId as string;
    await drain();
    expect((await operation(b.body.data.operationId as string)).status).toBe("succeeded");

    // A generic service's site, as the seed and the generic route store it: no PHP version, no type.
    const [row] = await dbClient.db.select().from(sites).where(eq(sites.id, siteId));
    genericId = `${siteId.slice(0, -4)}0000`;
    await dbClient.db.insert(sites).values({
      id: genericId,
      organizationId: orgId,
      hostAllocationId: row!.hostAllocationId,
      name: "Generic",
      slug: "generic-seams",
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await dbClient?.close();
  });

  describe.each([
    ["no type", null],
    ["a type this release does not know", "unknowntype"],
  ])("a managed row with %s", (_label, siteType) => {
    it("gets on every route of the subsystems the answer of a site that is not managed, enqueues nothing and reaches no executor", async () => {
      await setType(siteId, siteType);
      try {
        const walk = async (list: Array<[string, string, string, unknown, boolean]>) => {
          const out: string[] = [];
          for (const [label, method, path, body, admin] of list) {
            // A fresh TOTP code per terminal open: the step is spent once.
            const r = await http(method, path, label === "terminal open" ? await totp() : body, admin ? adminToken : ownerToken);
            out.push(`${label}: ${answer(r)}`);
          }
          return out;
        };
        const before = await count();
        const from = calls.length;
        const answers = await walk(await routes(siteId));
        // getSftpStatus takes no site: the host's SFTP status, read by the SFTP page of any site.
        const reached = calls.slice(from).filter((c) => c.method !== "getSftpStatus").map((c) => `${c.method}.${String(c.args[0]?.op ?? c.args[0]?.action ?? "")}`);
        const rows = await count();
        // The reference: a generic service's site, walked after, on its own.
        const expected = await walk(await routes(genericId));
        expect({ answers, reached, rows }).toEqual({ answers: expected, reached: [], rows: before });
      } finally {
        await setType(siteId, "wordpress");
        await drain();
      }
    });

    it("the lists leave the row out or show it as they show a generic service's site", async () => {
      // [label, path, token, what the row gets]: out of the list, or there with the fields a generic site shows.
      const lists: Array<[string, string, string, "absent" | "as generic"]> = [
        ["customer sites", `/v1/organizations/${orgId}/sites`, ownerToken, "as generic"],
        ["admin sites", "/v1/admin/sites", adminToken, "absent"],
        ["admin backups", "/v1/admin/backups/sites", adminToken, "as generic"],
        ["health", "/v1/admin/health", adminToken, "absent"],
        ["updates", "/v1/admin/updates", adminToken, "absent"],
      ];
      const entries = async (path: string, token: string, id: string) => {
        const r = await http("GET", path, undefined, token);
        expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(200);
        const found: Json[] = [];
        const walk = (n: unknown): void => {
          if (Array.isArray(n)) n.forEach(walk);
          else if (n && typeof n === "object") {
            const o = n as Json;
            if (o.id === id || o.siteId === id) found.push(o);
            Object.values(o).forEach(walk);
          }
        };
        walk(r.body);
        return found;
      };
      // Control: as WordPress the row is in the admin sites list, so "absent" below is not a finder that never finds.
      expect((await entries("/v1/admin/sites", adminToken, siteId)).length).toBeGreaterThan(0);
      await setType(siteId, siteType);
      try {
        for (const [label, path, token, want] of lists) {
          const mine = await entries(path, token, siteId);
          if (want === "absent") {
            expect(mine, label).toEqual([]);
            continue;
          }
          const theirs = await entries(path, token, genericId);
          expect(theirs.length, label).toBeGreaterThan(0);
          const shape = (o: Json) => Object.fromEntries(["siteType", "managed", "wordpressToolsAvailable"].map((k) => [k, o[k] ?? null]));
          expect(mine.map(shape), label).toEqual(theirs.map(shape));
        }
      } finally {
        await setType(siteId, "wordpress");
      }
    });
  });

  it("a stored type change alone is not picked up by the SFTP check; the next forced apply leaves the accounts out", async () => {
    expect((await http("POST", `/v1/organizations/${orgId}/managed-sites/${siteId}/sftp/users`, { name: "dev1" })).status).toBe(201);
    await app.siteSftp.ensureApplied(true);
    await setType(siteId, null);
    try {
      const from = calls.length;
      await app.siteSftp.ensureApplied();
      // Today: the change check sees the same accounts, so nothing is applied.
      expect(calls.slice(from).filter((c) => c.method === "applySftpAccess")).toEqual([]);
      await app.siteSftp.ensureApplied(true);
      const applies = calls.slice(from).filter((c) => c.method === "applySftpAccess");
      expect(applies.length).toBe(1);
      expect(applies[0]!.args[0]!.users).toEqual([]);
    } finally {
      await setType(siteId, "wordpress");
      await app.siteSftp.ensureApplied(true);
    }
  });

  it("a type without a database or an install step provisions through the general code: deploy, publish, finish", async () => {
    const testCalls: Call[] = [];
    // The test type registered from apps/api in a simulator of its own, through the option.
    const testSim = new InMemoryDockerSimulatorAdapter({ resolveSiteType: () => TEST_SIMULATOR_SITE_TYPE });
    const provisioner = new SiteProvisioner(
      dbClient,
      recording(testSim, testCalls),
      app.nestApp.get<ControlPlaneRuntimeConfig>(CONTROL_PLANE_CONFIG_TOKEN),
      app.nestApp.get(SiteSftpService),
      () => TEST_API_SITE_TYPE,
    );
    const res = await http("POST", `/v1/organizations/${orgId}/managed-sites`, { ...site("t"), domain: "static-t.example.test" });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const testSiteId = res.body.data.siteId as string;
    const opId = res.body.data.operationId as string;
    // Creation takes WordPress's form (ADR 0029 step): the rows become what a test-type creation writes.
    const [svc] = await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, testSiteId));
    const [tpl] = await dbClient.db.select().from(serviceTemplates).where(eq(serviceTemplates.id, svc!.serviceTemplateId));
    await dbClient.db.insert(serviceTemplates).values({
      ...tpl!,
      id: TEST_API_SITE_TYPE.definition.templateId,
      name: "Test static",
      slug: "test-static",
      defaultImage: TEST_API_SITE_TYPE.image(""),
    });
    await dbClient.db.update(serviceInstances).set({ serviceTemplateId: TEST_API_SITE_TYPE.definition.templateId }).where(eq(serviceInstances.id, svc!.id));
    const { mountPath, volumeSuffix } = TEST_API_SITE_TYPE.definition.files;
    // Revisions are append-only: the test type's configuration is a new revision.
    const [rev] = await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, svc!.id));
    const revId = randomUUID();
    await dbClient.db.insert(stackRevisions).values({
      ...rev!,
      id: revId,
      revisionNumber: rev!.revisionNumber + 1,
      specHash: `${rev!.specHash}-teststatic`,
      declarativeConfig: {
        ...(rev!.declarativeConfig as Json),
        image: TEST_API_SITE_TYPE.image(""),
        volumeMounts: [{ volumeSuffix, containerPath: mountPath }],
      },
    });
    await dbClient.db.update(serviceInstances).set({ currentRevisionId: revId }).where(eq(serviceInstances.id, svc!.id));
    await dbClient.db.update(sites).set({ siteType: "teststatic" }).where(eq(sites.id, testSiteId));
    await dbClient.db.delete(siteDatabases).where(eq(siteDatabases.siteId, testSiteId));
    for (const key of ["create_database", "install_wordpress"]) {
      await dbClient.db.delete(operationSteps).where(and(eq(operationSteps.operationId, opId), eq(operationSteps.key, key)));
    }

    // The worker's own instance: the module graph may hold more than one.
    const general = (app.outboxWorker as unknown as { siteProvisioner: SiteProvisioner }).siteProvisioner;
    const spy = vi.spyOn(general, "provision").mockImplementation((op, payload) => provisioner.provision(op, payload));
    const from = calls.length;
    let provisioned: number;
    try {
      await drain();
      provisioned = spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
    expect(provisioned).toBe(1);
    expect(await operation(opId)).toEqual({ status: "succeeded", errorCode: null });
    expect(await stepsOf(opId)).toEqual([
      { key: "deploy_site", status: "succeeded" },
      { key: "publish_site", status: "succeeded" },
      { key: "finish", status: "succeeded" },
    ]);
    expect(testCalls.filter((c) => c.method === "runSiteJob")).toEqual([]);
    expect(calls.slice(from)).toEqual([]);
    const deploys = testCalls.filter((c) => c.method === "deployService");
    expect(deploys.length).toBe(2);
    for (const d of deploys) {
      const spec = d.args[0]!;
      expect(spec.image).toBe("hp-test-static:1");
      expect(spec.volumeMounts).toEqual([{ volumeSuffix: "public", containerPath: "/srv/public" }]);
      expect(JSON.stringify(spec).match(new RegExp(WORDPRESS_VALUES.source, "gi")), JSON.stringify(spec)).toBeNull();
    }
    // The simulator seeded the test type's own empty tree, not WordPress's.
    expect((await testSim.siteFiles({ serviceInstanceId: svc!.id, op: "list", path: "" })).entries).toEqual([]);
  });

  describe("the recovery of a restore whose row has a type this release does not know", () => {
    it("a restore stopped before it began fails and reaches no executor", async () => {
      const r = await http("POST", `/v1/organizations/${orgId}/managed-sites/${siteId}/backups/${backupId}/restore`, { confirmName: "Site a" });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      const opId = r.body.data.operationId as string;
      await dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, opId));
      await setType(siteId, "unknowntype");
      const from = calls.length;
      try {
        await app.outboxWorker.recoverUnknownOperations();
        expect((await operation(opId)).status).toBe("failed");
        expect(calls.slice(from)).toEqual([]);
      } finally {
        await setType(siteId, "wordpress");
        await drain();
      }
    });

    it("a restore the executor already ran is settled by its job id only; nothing else reaches the executor for the site", async () => {
      const parent = app.nestApp.get(SiteBackupsApplier);
      const spy = vi
        .spyOn(parent, "pollJobStatus")
        .mockRejectedValueOnce(new ControlPlaneError("OPERATION_AMBIGUOUS", "The outcome is unknown."));
      const r = await http("POST", `/v1/admin/backups/sites/${siteId}/restore`, { confirmName: "Site a" }, adminToken);
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      const opId = r.body.data.operationId as string;
      try {
        await drain();
      } finally {
        spy.mockRestore();
      }
      expect((await operation(opId)).status).toBe("unknown");
      await setType(siteId, "unknowntype");
      const from = calls.length;
      try {
        await app.outboxWorker.recoverUnknownOperations();
        const after = calls.slice(from);
        expect(after.map((c) => `${c.method}.${String(c.args[0]?.action ?? "")}`)).toEqual(["backups.settle"]);
        expect(Object.keys(after[0]!.args[0]!).sort()).toEqual(["action", "jobId"]);
        const end = await operation(opId);
        expect(end.status, JSON.stringify(await stepsOf(opId))).toBe("failed");
      } finally {
        await setType(siteId, "wordpress");
      }
    });
  });
});
