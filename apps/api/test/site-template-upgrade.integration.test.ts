import { randomUUID } from "node:crypto";
import {
  BUILT_IN_WORDPRESS_SOURCE,
  BUILT_IN_WORDPRESS_TEMPLATE_ID,
  BUILT_IN_WORDPRESS_VERSION_ID,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  desc,
  eq,
  serviceInstances,
  siteTemplateVersions,
  sites,
  stackRevisions,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { customSource } from "./fixtures/site-templates.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const TEMPLATES = "/v1/admin/site-templates";
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The custom fixture without its admin-only parameter, as a later version that dropped it. */
const withoutAdminNote = (source: string) => source.replace(/ {2}- key: admin_note\n(?: {4}.*\n)+/, "");

describe("move a site to a newer template version", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let admin: string;

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

  async function call(
    as: string | null,
    method: string,
    path: string,
    body?: unknown,
    key: string | null = randomUUID(),
  ): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  const run = () => app.outboxWorker.processPendingOnce();
  const upgrade = (siteId: string, versionId: unknown, as: string | null = admin, key: string | null = randomUUID()) =>
    call(as, "POST", `/v1/admin/sites/${siteId}/template-version`, { versionId }, key);
  const addVersion = async (templateId: string, source: string, makeDefault?: boolean) => {
    const res = await call(admin, "POST", `${TEMPLATES}/${templateId}/versions`, { source, ...(makeDefault === undefined ? {} : { makeDefault }) });
    expect(res.status, res.raw).toBe(201);
    return res.body.data as { id: string; versionNumber: number };
  };
  /** A custom template whose v1 has two parameters set on the site; returns the template and the running site. */
  async function customSite(parameters: unknown[] = [{ key: "upload_limit", value: "64M" }, { key: "admin_note", value: "hello" }]) {
    const created = await call(admin, "POST", TEMPLATES, { module: "wordpress", name: "Custom", source: customSource() });
    expect(created.status, created.raw).toBe(201);
    const template = created.body.data as { id: string; defaultVersionId: string };
    const site = await call(admin, "POST", "/v1/admin/sites", { ...SITE, ownerOrganizationId: null, templateId: template.id, parameters, phpVersion: "8.5" });
    expect(site.status, site.raw).toBe(202);
    await run();
    return { template, siteId: site.body.data.siteId as string };
  }
  const siteRow = async (siteId: string) => (await dbClient.db.select().from(sites).where(eq(sites.id, siteId)))[0]!;
  const revisions = async (siteId: string) => {
    const [svc] = await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId));
    return dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, svc!.id)).orderBy(desc(stackRevisions.revisionNumber));
  };
  const auditRows = async (action: string) => (await dbClient.db.select().from(auditEvents)).filter((row) => row.action === action);

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const created = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: sim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    admin = await login("admin@x.it", PW, created.totpSecretBase32);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("moves a site to the newer version: new revision, new version id, migrated parameters, audit row, new deploy", async () => {
    const { template, siteId } = await customSite();
    const v1 = template.defaultVersionId;
    const v2 = await addVersion(template.id, withoutAdminNote(customSource({ debug: "1", memory: "2048M" })));

    const before = await revisions(siteId);
    const res = await upgrade(siteId, v2.id);
    expect(res.status, res.raw).toBe(202);
    expect(res.body.data).toMatchObject({ siteId, operationId: expect.any(String) });

    const after = await revisions(siteId);
    expect(after).toHaveLength(before.length + 1);
    const latest = after[0]!;
    expect(latest.declarativeConfig).toMatchObject({
      WORDPRESS_DEBUG: "1",
      image: expect.stringContaining("php8.5"),
      phpIni: { post_max_size: "128M", upload_max_filesize: "64M" },
    });
    expect(latest.resourceLimits).toEqual({ cpuMilli: 2000, memoryBytes: "2147483648" });
    expect(latest.secretRefs).toEqual(before[0]!.secretRefs);

    const row = await siteRow(siteId);
    expect(row.templateVersionId).toBe(v2.id);
    expect(row.phpVersion).toBe("8.5");
    expect(row.templateParameters).toEqual([{ key: "upload_limit", value: "64M" }]);

    const audits = await auditRows("admin.site.template_version");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "user", targetType: "site", targetId: siteId });
    expect(audits[0]!.details).toEqual({
      outcome: "succeeded",
      requestId: expect.any(String),
      operationId: res.body.data.operationId,
      templateId: template.id,
      fromVersionId: v1,
      toVersionId: v2.id,
      fromVersionNumber: 1,
      toVersionNumber: 2,
    });

    await run();
    const spec = sim.deployedSpecs.filter((s) => s.siteId === siteId).at(-1)!;
    expect(spec.resourceLimits).toEqual({ cpuMilli: 2000, memoryBytes: "2147483648" });
    expect(spec.phpIni).toEqual({ post_max_size: "128M", upload_max_filesize: "64M" });
  });

  it("gives an admin-only parameter still at the old default the newer default, and keeps an explicit admin value", async () => {
    // The custom fixture plus an admin-only debug_mode (default false) rendered into WORDPRESS_DEBUG.
    const withDebugMode = (defaultValue: boolean, memory = "1024M") =>
      customSource({ memory })
        .replace("services:", () => `  - key: debug_mode\n    label: Debug mode\n    type: boolean\n    default: ${defaultValue}\n    customer: false\nservices:`)
        .replace('WORDPRESS_DEBUG: "0"', () => 'WORDPRESS_DEBUG: "${debug_mode}"');
    const moved = async (tag: string, parameters: unknown[], newer: string) => {
      const created = await call(admin, "POST", TEMPLATES, { module: "wordpress", name: `Debuggable ${tag}`, source: withDebugMode(false) });
      expect(created.status, created.raw).toBe(201);
      const template = created.body.data as { id: string };
      const site = await call(admin, "POST", "/v1/admin/sites", { ...SITE, name: `Hotel ${tag}`, domain: `${tag}.hotel.it`, ownerOrganizationId: null, templateId: template.id, parameters });
      expect(site.status, site.raw).toBe(202);
      const siteId = site.body.data.siteId as string;
      await run();
      const v2 = await addVersion(template.id, newer);
      expect((await upgrade(siteId, v2.id)).status).toBe(202);
      const stored = (await siteRow(siteId)).templateParameters as { key: string; value: unknown }[];
      return { debug: stored.find((entry) => entry.key === "debug_mode")?.value, rendered: (await revisions(siteId))[0]!.declarativeConfig };
    };

    // v2 defaults debug_mode to true; the site never chose a value, so it follows the new default.
    const atDefault = await moved("default", [{ key: "upload_limit", value: "64M" }], withDebugMode(true));
    expect(atDefault.debug).toBe(true);
    expect(atDefault.rendered).toMatchObject({ WORDPRESS_DEBUG: "true" });

    // The administrator chose true at creation (v1 default false); v2 keeps default false, so only a kept value renders true.
    const explicit = await moved("explicit", [{ key: "debug_mode", value: true }], withDebugMode(false, "2048M"));
    expect(explicit.debug).toBe(true);
    expect(explicit.rendered).toMatchObject({ WORDPRESS_DEBUG: "true" });
  });

  it("refuses a version that is not newer, of another template or unknown, and changes nothing", async () => {
    const { template, siteId } = await customSite();
    const v2 = await addVersion(template.id, customSource({ debug: "1" }));
    const other = await call(admin, "POST", TEMPLATES, { module: "wordpress", name: "Other", source: customSource({ debug: "9" }) });
    const otherVersion = other.body.data.defaultVersionId as string;
    expect((await upgrade(siteId, v2.id)).status).toBe(202);
    await run();

    const before = { revisions: (await revisions(siteId)).length, audits: (await auditRows("admin.site.template_version")).length };
    const reason = (res: { body: Json }) => res.body.error.details?.[0]?.reason;
    const same = await upgrade(siteId, v2.id);
    expect([same.status, same.body.error.code, reason(same)]).toEqual([400, "VALIDATION_ERROR", "already_current"]);
    const older = await upgrade(siteId, template.defaultVersionId);
    expect([older.status, older.body.error.code, reason(older)]).toEqual([400, "VALIDATION_ERROR", "not_newer"]);
    const foreign = await upgrade(siteId, otherVersion);
    expect([foreign.status, foreign.body.error.code, reason(foreign)]).toEqual([400, "VALIDATION_ERROR", "other_template"]);
    const unknown = await upgrade(siteId, "stv_missing");
    expect([unknown.status, unknown.body.error.code, reason(unknown)]).toEqual([404, "NOT_FOUND", "unknown_version"]);
    expect((await upgrade(siteId, undefined)).status).toBe(400);
    expect((await call(admin, "POST", `/v1/admin/sites/${siteId}/template-version`, { versionId: v2.id, extra: 1 })).status).toBe(400);

    expect({ revisions: (await revisions(siteId)).length, audits: (await auditRows("admin.site.template_version")).length }).toEqual(before);
  });

  it("refuses a stopped site, an archived template and a version that no longer accepts a saved value", async () => {
    const { template, siteId } = await customSite();
    const v2 = await addVersion(template.id, customSource({ debug: "1" }));
    // The site stored upload_limit 64M; this later version only offers 16M and 32M.
    const narrower = await addVersion(template.id, customSource({ debug: "2" }).replace('options: ["16M", "64M"]', 'options: ["16M", "32M"]'));
    const before = (await revisions(siteId)).length;
    const reason = (res: { body: Json }) => res.body.error.details?.[0];

    const narrowed = await upgrade(siteId, narrower.id);
    expect([narrowed.status, narrowed.body.error.code]).toEqual([400, "VALIDATION_ERROR"]);
    expect(reason(narrowed)).toMatchObject({ field: "parameters.upload_limit" });
    expect((await revisions(siteId)).length).toBe(before);

    await dbClient.db.update(serviceInstances).set({ desiredStatus: "stopped" }).where(eq(serviceInstances.siteId, siteId));
    const stopped = await upgrade(siteId, v2.id);
    expect([stopped.status, stopped.body.error.code, reason(stopped)?.reason]).toEqual([400, "VALIDATION_ERROR", "stopped"]);
    await dbClient.db.update(serviceInstances).set({ desiredStatus: "running" }).where(eq(serviceInstances.siteId, siteId));

    expect((await call(admin, "DELETE", `${TEMPLATES}/${template.id}`)).status).toBe(200);
    const archived = await upgrade(siteId, v2.id);
    expect([archived.status, archived.body.error.code, reason(archived)?.reason]).toEqual([409, "RESOURCE_LOCKED", "template_archived"]);
    expect((await revisions(siteId)).length).toBe(before);
    expect(await auditRows("admin.site.template_version")).toHaveLength(0);
  });

  it("replays the same key with one revision and refuses the key for another request", async () => {
    const { template, siteId } = await customSite();
    const v2 = await addVersion(template.id, customSource({ debug: "1" }));
    const key = randomUUID();
    const before = (await revisions(siteId)).length;

    const first = await upgrade(siteId, v2.id, admin, key);
    const second = await upgrade(siteId, v2.id, admin, key);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(second.body.data.operationId).toBe(first.body.data.operationId);
    expect((await revisions(siteId)).length).toBe(before + 1);
    expect(await auditRows("admin.site.template_version")).toHaveLength(1);

    const reused = await call(admin, "POST", `/v1/admin/sites/${siteId}/restart`, { reason: "again" }, key);
    expect([reused.status, reused.body.error.code]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
    expect(await upgrade(siteId, v2.id, admin, null)).toMatchObject({ status: 400 });
  });

  it("moves a legacy site without a template version to a new built-in version", async () => {
    const created = await call(admin, "POST", "/v1/admin/sites", { ...SITE, ownerOrganizationId: null });
    expect(created.status, created.raw).toBe(202);
    const siteId = created.body.data.siteId as string;
    await run();
    await dbClient.db.update(sites).set({ templateVersionId: null, templateParameters: null }).where(eq(sites.id, siteId));
    const v2 = await addVersion(BUILT_IN_WORDPRESS_TEMPLATE_ID, BUILT_IN_WORDPRESS_SOURCE.replace("memory: 512M", "memory: 768M"));

    const res = await upgrade(siteId, v2.id);
    expect(res.status, res.raw).toBe(202);
    expect((await siteRow(siteId)).templateVersionId).toBe(v2.id);
    expect((await revisions(siteId))[0]!.resourceLimits).toEqual({ cpuMilli: 1000, memoryBytes: "805306368" });
    expect((await auditRows("admin.site.template_version"))[0]!.details).toMatchObject({
      templateId: BUILT_IN_WORDPRESS_TEMPLATE_ID,
      fromVersionId: BUILT_IN_WORDPRESS_VERSION_ID,
      fromVersionNumber: 1,
      toVersionNumber: 2,
    });
    expect((await dbClient.db.select().from(siteTemplateVersions).where(eq(siteTemplateVersions.id, v2.id))).length).toBe(1);
  });

  it("is for server administrators only and answers 404 for a site that does not exist", async () => {
    const { template, siteId } = await customSite();
    const v2 = await addVersion(template.id, customSource({ debug: "1" }));
    const customer = await call(admin, "POST", "/v1/admin/customer-account", { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" });
    expect(customer.status, customer.raw).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    const owner = await login("mario@hotel.it", customer.body.data.temporaryPassword as string);
    const before = (await revisions(siteId)).length;

    expect((await upgrade(siteId, v2.id, owner)).status).toBe(403);
    expect((await upgrade(siteId, v2.id, null)).status).toBe(401);
    expect((await upgrade("site_missing", v2.id)).status).toBe(404);
    expect((await revisions(siteId)).length).toBe(before);
    expect(await auditRows("admin.site.template_version")).toHaveLength(0);
  });
});
