import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  BUILT_IN_WORDPRESS_SOURCE,
  BUILT_IN_WORDPRESS_TEMPLATE_ID,
  BUILT_IN_WORDPRESS_VERSION_ID,
  resolveWordpressImage,
} from "@hosting-panel/contracts";
import {
  createDatabaseClient,
  eq,
  operations,
  serviceInstances,
  siteTemplates,
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
// The custom fixture writes both: the validator refuses post_max_size below upload_max_filesize.
const CUSTOM_PHP_INI = { post_max_size: "128M", upload_max_filesize: "64M" };
const SPEC_HASH_PIN = (
  JSON.parse(readFileSync(new URL("./fixtures/site-type-pins/spec-hash.json", import.meta.url), "utf8")) as { afterCreate: { specHash: string } }
).afterCreate.specHash;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("site creation, PHP change and admin view with site templates", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let admin: string;
  let token: string;
  let orgId: string;

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

  async function call(as: string, method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  const create = (body: Json = {}, key: string = randomUUID()) =>
    call(token, "POST", `/v1/organizations/${orgId}/managed-sites`, { ...SITE, ...body }, key);
  const adminCreate = (body: Json = {}) =>
    call(admin, "POST", "/v1/admin/sites", { ...SITE, ownerOrganizationId: orgId, ...body }, randomUUID());
  const changePhp = (siteId: string, phpVersion: string) =>
    call(token, "PATCH", `/v1/organizations/${orgId}/managed-sites/${siteId}/runtime`, { phpVersion }, randomUUID());
  const run = () => app.outboxWorker.processPendingOnce();
  const siteRows = () => dbClient.db.select().from(sites);
  const siteRow = async (siteId: string) => (await dbClient.db.select().from(sites).where(eq(sites.id, siteId)))[0]!;
  const webService = async (siteId: string) => (await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId)))[0]!;
  const revisions = async (siteId: string) =>
    (await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, (await webService(siteId)).id))).sort(
      (a, b) => a.revisionNumber - b.revisionNumber,
    );
  const latestRevision = async (siteId: string) => (await revisions(siteId)).at(-1)!;
  const specsOf = (siteId: string) => sim.deployedSpecs.filter((spec) => spec.siteId === siteId);

  async function createAndRun(body: Json = {}) {
    const res = await create(body);
    expect(res.status, res.raw).toBe(202);
    await run();
    return res.body.data.siteId as string;
  }

  /** A custom template, enabled unless told otherwise. */
  async function newTemplate(options: { name?: string; source?: string; enabled?: boolean } = {}): Promise<string> {
    const res = await call(admin, "POST", TEMPLATES, { module: "wordpress", name: options.name ?? "Custom", source: options.source ?? customSource() });
    expect(res.status, res.raw).toBe(201);
    const id = res.body.data.id as string;
    if (options.enabled !== false) {
      expect((await call(admin, "PATCH", `${TEMPLATES}/${id}`, { enabled: true })).status).toBe(200);
    }
    return id;
  }
  const archive = async (templateId: string) => expect((await call(admin, "DELETE", `${TEMPLATES}/${templateId}`)).status).toBe(200);

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
    const customer = await call(admin, "POST", "/v1/admin/customer-account", { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" });
    expect(customer.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgId = customer.body.data.organizationId as string;
    token = await login("mario@hotel.it", customer.body.data.temporaryPassword as string);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("creates from the built-in template without a templateId or a PHP version, exactly as before", async () => {
    const res = await create();
    expect(res.status, res.raw).toBe(202);
    const siteId = res.body.data.siteId as string;
    const site = await siteRow(siteId);
    expect(site).toMatchObject({ templateVersionId: BUILT_IN_WORDPRESS_VERSION_ID, templateParameters: null, phpVersion: "8.4", siteType: "wordpress" });
    const revision = (await revisions(siteId))[0]!;
    expect(revision.declarativeConfig).toEqual({
      exposeHttp: true,
      image: resolveWordpressImage("8.4"),
      internalPort: 80,
      siteMail: true,
      volumeMounts: [{ containerPath: "/var/www/html", volumeSuffix: "html" }],
    });
    expect(revision.resourceLimits).toEqual({ cpuMilli: 1000, memoryBytes: "536870912" });
    expect(revision.secretRefs).toEqual({});

    await run();
    const [first] = specsOf(siteId);
    expect(first).toBeDefined();
    expect("phpIni" in first!).toBe(false);
  });

  it("keeps the spec hash of a built-in site at PHP 8.3 equal to the recorded pin", async () => {
    const res = await create({ phpVersion: "8.3" });
    expect(res.status, res.raw).toBe(202);
    expect((await revisions(res.body.data.siteId as string))[0]!.specHash).toBe(SPEC_HASH_PIN);
  });

  it("creates from an enabled custom template with its environment, limits, PHP settings and stored parameters", async () => {
    const templateId = await newTemplate();
    const res = await create({ templateId, phpVersion: "8.5", parameters: [{ key: "upload_limit", value: "64M" }] });
    expect(res.status, res.raw).toBe(202);
    const siteId = res.body.data.siteId as string;
    const site = await siteRow(siteId);
    const [template] = await dbClient.db.select().from(siteTemplates).where(eq(siteTemplates.id, templateId));
    expect(site.templateVersionId).toBe(template!.defaultVersionId);
    expect(site.templateParameters).toEqual([
      { key: "admin_note", value: "x" },
      { key: "upload_limit", value: "64M" },
    ]);
    expect(site.phpVersion).toBe("8.5");

    const revision = (await revisions(siteId))[0]!;
    expect(revision.declarativeConfig).toEqual({
      WORDPRESS_DEBUG: "0",
      image: resolveWordpressImage("8.5"),
      internalPort: 80,
      exposeHttp: true,
      siteMail: true,
      volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
      phpIni: CUSTOM_PHP_INI,
    });
    expect(revision.resourceLimits).toEqual({ cpuMilli: 2000, memoryBytes: "1073741824" });

    await run();
    expect(specsOf(siteId).at(-1)!.phpIni).toEqual(CUSTOM_PHP_INI);
    const ini = sim.phpIniByService.get((await webService(siteId)).id);
    expect(ini).toContain("upload_max_filesize = 64M");
    expect(ini).toContain("post_max_size = 128M");
  });

  it("answers an unknown, disabled or archived template with 404 template_unavailable and writes no site", async () => {
    const disabled = await newTemplate({ name: "Disabled", enabled: false });
    const archived = await newTemplate({ name: "Archived" });
    await archive(archived);
    for (const templateId of ["stpl_unknown", disabled, archived]) {
      const res = await create({ templateId });
      expect(res.status, templateId).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
      expect(res.body.error.details).toEqual([{ field: "templateId", message: expect.any(String), reason: "template_unavailable" }]);
    }
    expect(await siteRows()).toHaveLength(0);

    // An administrator may try a template before it is offered, but not an archived one.
    expect((await adminCreate({ templateId: disabled })).status).toBe(202);
    const refused = await adminCreate({ templateId: archived, name: "Other", domain: "other.it" });
    expect(refused.status).toBe(404);
    expect(refused.body.error.details[0].reason).toBe("template_unavailable");
    expect(await siteRows()).toHaveLength(1);
  });

  it("refuses create without a templateId while the built-in template is disabled", async () => {
    expect((await call(admin, "PATCH", `${TEMPLATES}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}`, { enabled: false })).status).toBe(200);
    for (const res of [await create(), await adminCreate()]) {
      expect(res.status).toBe(404);
      expect(res.body.error.details[0].reason).toBe("template_unavailable");
    }
    expect(await siteRows()).toHaveLength(0);
  });

  it("refuses bad parameters with 400 naming the field, and lets the administrator set an admin-only one", async () => {
    const templateId = await newTemplate();
    const bad: [string, Json, string][] = [
      ["an unknown key", { parameters: [{ key: "nope", value: "x" }] }, "parameters.nope"],
      ["an enum value outside the options", { parameters: [{ key: "upload_limit", value: "1G" }] }, "parameters.upload_limit"],
      // The wire schema refuses a repeated key before the template is read.
      ["a duplicate key", { parameters: [{ key: "upload_limit", value: "16M" }, { key: "upload_limit", value: "64M" }] }, "parameters.1.key"],
      ["an admin-only key as customer", { parameters: [{ key: "admin_note", value: "y" }] }, "parameters.admin_note"],
      ["php_version inside parameters", { parameters: [{ key: "php_version", value: "8.5" }] }, "parameters.php_version"],
      ["a PHP version outside the options", { phpVersion: "8.3" }, "phpVersion"],
    ];
    for (const [label, body, field] of bad) {
      const res = await create({ templateId, ...body });
      expect(res.status, label).toBe(400);
      expect(res.body.error.code, label).toBe("VALIDATION_ERROR");
      expect(res.body.error.details.map((detail: Json) => detail.field), label).toContain(field);
    }
    expect(await siteRows()).toHaveLength(0);

    const ok = await adminCreate({ templateId, parameters: [{ key: "admin_note", value: "y" }] });
    expect(ok.status, ok.raw).toBe(202);
    expect((await siteRow(ok.body.data.siteId as string)).templateParameters).toEqual([
      { key: "admin_note", value: "y" },
      { key: "upload_limit", value: "16M" },
    ]);
  });

  it("refuses a customer value that renders to the Docker socket path with 400 and writes nothing", async () => {
    // admin_note becomes a customer text parameter that feeds an environment variable.
    const source = customSource()
      .replace("    customer: false", "    customer: true")
      .replace('      WORDPRESS_DEBUG: "0"', '      WORDPRESS_DEBUG: "0"\n      WP_TAGLINE: "${admin_note}"');
    const templateId = await newTemplate({ source });
    const res = await create({ templateId, parameters: [{ key: "admin_note", value: "/var/run/docker.sock" }] });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details.map((detail: Json) => detail.field)).toContain("parameters");
    expect(res.raw).not.toContain("docker.sock");
    expect(await siteRows()).toHaveLength(0);
    expect(await dbClient.db.select().from(stackRevisions)).toHaveLength(0);
    expect(await dbClient.db.select().from(operations)).toHaveLength(0);

    expect((await create({ templateId, parameters: [{ key: "admin_note", value: "hello" }] })).status).toBe(202);
  });

  it("replays the same key with the original operation, even after the template was disabled or the body changed", async () => {
    const templateId = await newTemplate();
    const key = randomUUID();
    const first = await create({ templateId }, key);
    expect(first.status, first.raw).toBe(202);
    expect((await call(admin, "PATCH", `${TEMPLATES}/${templateId}`, { enabled: false })).status).toBe(200);
    const again = await create({ templateId }, key);
    expect(again.status, again.raw).toBe(202);
    expect(again.body.data).toEqual(first.body.data);
    const changed = await create({ templateId, name: "Another", domain: "another.it" }, key);
    expect(changed.body.data).toEqual(first.body.data);
    expect(await siteRows()).toHaveLength(1);
  });

  it("checks the template before the site limit: a full organisation gets 409 for a valid body and 404 for an unknown template", async () => {
    const templateId = await newTemplate();
    expect((await call(admin, "PATCH", `/v1/admin/organizations/${orgId}/site-limit`, { maxSites: 1 })).status).toBe(200);
    expect((await create({ templateId })).status).toBe(202);
    const full = await create({ templateId, name: "Second", domain: "second.it" });
    expect(full.status).toBe(409);
    expect(full.body.error.code).toBe("QUOTA_EXCEEDED");
    expect(full.body.error.details[0].reason).toBe("site_limit_reached");
    const unknown = await create({ templateId: "stpl_unknown", name: "Second", domain: "second.it" });
    expect(unknown.status).toBe(404);
    expect(await siteRows()).toHaveLength(1);
  });

  describe("PHP change", () => {
    it("re-renders the image of a built-in site, exactly as for a legacy site without a template version", async () => {
      const modern = await createAndRun({ phpVersion: "8.3" });
      const legacy = await createAndRun({ phpVersion: "8.3", name: "Legacy", domain: "legacy.it" });
      await dbClient.db.update(sites).set({ templateVersionId: null }).where(eq(sites.id, legacy));
      for (const siteId of [modern, legacy]) {
        const before = await latestRevision(siteId);
        const res = await changePhp(siteId, "8.5");
        expect(res.status, res.raw).toBe(202);
        await run();
        const after = await latestRevision(siteId);
        expect(after.revisionNumber).toBe(before.revisionNumber + 1);
        expect(after.declarativeConfig).toEqual({ ...(before.declarativeConfig as Json), image: resolveWordpressImage("8.5") });
        expect(after.resourceLimits).toEqual(before.resourceLimits);
        expect((await siteRow(siteId)).phpVersion).toBe("8.5");
      }
      expect((await latestRevision(modern)).declarativeConfig).toEqual((await latestRevision(legacy)).declarativeConfig);
    });

    it("re-renders the image of a custom site, keeps its PHP settings and refuses a version outside its options", async () => {
      const templateId = await newTemplate();
      const siteId = await createAndRun({ templateId });
      const before = await latestRevision(siteId);
      const res = await changePhp(siteId, "8.5");
      expect(res.status, res.raw).toBe(202);
      await run();
      const after = await latestRevision(siteId);
      expect(after.declarativeConfig).toEqual({ ...(before.declarativeConfig as Json), image: resolveWordpressImage("8.5") });
      expect((after.declarativeConfig as Json)["phpIni"]).toEqual(CUSTOM_PHP_INI);
      expect(specsOf(siteId).at(-1)!.image).toBe(resolveWordpressImage("8.5"));

      const outside = await changePhp(siteId, "8.3");
      expect(outside.status).toBe(400);
      expect(outside.body.error.code).toBe("VALIDATION_ERROR");
      expect(outside.body.error.details.map((detail: Json) => detail.field)).toEqual(["phpVersion"]);
      expect((await revisions(siteId)).length).toBe(after.revisionNumber);
    });
  });

  describe("admin site list", () => {
    const templateOf = async (siteId: string) => {
      const list = await call(admin, "GET", "/v1/admin/sites");
      expect(list.status).toBe(200);
      return (list.body.data.sites as Json[]).find((site) => site.id === siteId)!.template;
    };

    it("reports the template of every managed site, folding legacy sites into built-in version 1", async () => {
      const modern = (await create()).body.data.siteId as string;
      const legacy = (await create({ name: "Legacy", domain: "legacy.it" })).body.data.siteId as string;
      await dbClient.db.update(sites).set({ templateVersionId: null }).where(eq(sites.id, legacy));
      const builtIn = {
        templateId: BUILT_IN_WORDPRESS_TEMPLATE_ID,
        templateName: expect.any(String),
        versionId: BUILT_IN_WORDPRESS_VERSION_ID,
        versionNumber: 1,
        defaultVersionId: BUILT_IN_WORDPRESS_VERSION_ID,
        defaultVersionNumber: 1,
      };
      expect(await templateOf(modern)).toEqual(builtIn);
      expect(await templateOf(legacy)).toEqual(builtIn);
    });

    it("shows the default version number once a newer version is the default", async () => {
      const templateId = await newTemplate({ enabled: false });
      const siteId = (await adminCreate({ templateId })).body.data.siteId as string;
      const v1 = (await siteRow(siteId)).templateVersionId;
      expect(await templateOf(siteId)).toMatchObject({ templateId, versionId: v1, versionNumber: 1, defaultVersionId: v1, defaultVersionNumber: 1 });

      const v2 = await call(admin, "POST", `${TEMPLATES}/${templateId}/versions`, { source: customSource({ debug: "1" }), makeDefault: true });
      expect(v2.status, v2.raw).toBe(201);
      expect(await templateOf(siteId)).toMatchObject({ versionId: v1, versionNumber: 1, defaultVersionId: v2.body.data.id, defaultVersionNumber: 2 });
    });

    it("shows a newer default of the built-in template for a legacy site", async () => {
      const legacy = (await create()).body.data.siteId as string;
      await dbClient.db.update(sites).set({ templateVersionId: null }).where(eq(sites.id, legacy));
      const source = BUILT_IN_WORDPRESS_SOURCE.replace("    volumes:\n", '    environment:\n      EXTRA: "1"\n    volumes:\n');
      const v2 = await call(admin, "POST", `${TEMPLATES}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}/versions`, { source, makeDefault: true });
      expect(v2.status, v2.raw).toBe(201);
      expect(await templateOf(legacy)).toMatchObject({ versionId: BUILT_IN_WORDPRESS_VERSION_ID, versionNumber: 1, defaultVersionNumber: 2 });
    });
  });
});
