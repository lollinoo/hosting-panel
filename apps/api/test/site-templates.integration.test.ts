import { randomUUID } from "node:crypto";
import {
  BUILT_IN_WORDPRESS_SPEC,
  BUILT_IN_WORDPRESS_TEMPLATE_ID,
  BUILT_IN_WORDPRESS_VERSION_ID,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  membershipRoles,
  memberships,
  organizations,
  siteTemplateVersions,
  siteTemplates,
  sites,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { customSource } from "./fixtures/site-templates.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const BASE = "/v1/admin/site-templates";
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
  phpVersion: "8.4",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("site template routes", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let admin: string;
  let owner: string;
  let ownerOrg: string;
  let collaborator: string;
  let stranger: string;
  let strangerOrg: string;

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
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { ...(as ? { Authorization: `Bearer ${as}` } : {}), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  async function createCustomer(organizationName: string, email: string): Promise<{ orgId: string; token: string }> {
    const created = await call(admin, "POST", "/v1/admin/customer-account", { organizationName, ownerEmail: email, ownerName: organizationName });
    expect(created.status, created.raw).toBe(201);
    await skipPasswordChange(dbClient.db, email);
    return { orgId: created.body.data.organizationId as string, token: await login(email, created.body.data.temporaryPassword as string) };
  }

  async function addMember(email: string, organizationId: string, roleId: string): Promise<string> {
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email, name: email, passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId });
    return login(email, PW);
  }

  const userIdOf = async (email: string) => (await dbClient.db.select().from(users).where(eq(users.email, email)))[0]!.id;
  const deniedRows = async (email: string) =>
    (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.actorId, await userIdOf(email)))).filter(
      (row) => (row.details as Json | null)?.outcome === "denied",
    ).length;
  const auditRows = async (action: string) => (await dbClient.db.select().from(auditEvents)).filter((row) => row.action === action);
  const templateAuditRows = async () => (await dbClient.db.select().from(auditEvents)).filter((row) => row.action.startsWith("admin.site_template."));
  const counts = async () => ({
    templates: (await dbClient.db.select().from(siteTemplates)).length,
    versions: (await dbClient.db.select().from(siteTemplateVersions)).length,
    audits: (await templateAuditRows()).length,
  });

  const createTemplate = (name = "Custom", source = customSource()) => call(admin, "POST", BASE, { module: "wordpress", name, source });
  const addVersion = (templateId: string, source: string, makeDefault?: boolean) =>
    call(admin, "POST", `${BASE}/${templateId}/versions`, { source, ...(makeDefault === undefined ? {} : { makeDefault }) });
  const patch = (templateId: string, body: unknown) => call(admin, "PATCH", `${BASE}/${templateId}`, body);
  const newTemplate = async (name = "Custom") => (await createTemplate(name)).body.data.id as string;
  const siteTypesOf = async (token: string, orgId: string) => call(token, "GET", `/v1/organizations/${orgId}/site-types`);
  /**
   * PGlite runs one transaction at a time and queues every other query behind it. Holding one parks both requests at
   * their first query, so they then run in lockstep: each reads before either writes (the race of two admins).
   */
  async function sentTogether<T>(requests: readonly [() => Promise<T>, () => Promise<T>]): Promise<[T, T]> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const gate = dbClient.db.transaction(async () => held);
    const pending = [requests[0](), requests[1]()] as const;
    await new Promise((resolve) => setTimeout(resolve, 150));
    release();
    await gate;
    return Promise.all(pending);
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const created = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: new InMemoryDockerSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    admin = await login("admin@x.it", PW, created.totpSecretBase32);
    ({ orgId: ownerOrg, token: owner } = await createCustomer("Hotel Mario", "mario@hotel.it"));
    // The dedicated host holds one customer organisation, so the second one is written directly.
    strangerOrg = `org_${randomUUID()}`;
    const [ownerRow] = await dbClient.db.select().from(organizations).where(eq(organizations.id, ownerOrg));
    await dbClient.db.insert(organizations).values({
      id: strangerOrg,
      platformInstallationId: ownerRow!.platformInstallationId,
      name: "Bar Luigi",
      slug: `bar-luigi-${randomUUID().slice(0, 6)}`,
    });
    collaborator = await addMember("collab@hotel.it", ownerOrg, "role_customer_collaborator");
    stranger = await addMember("luigi@bar.it", strangerOrg, "role_customer_owner");
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("lists the built-in template, counting legacy sites without a version under version 1", async () => {
    const res = await call(admin, "GET", BASE);
    expect(res.status).toBe(200);
    expect(res.body.data.modules).toEqual([{ key: "wordpress", phpVersions: ["8.3", "8.4", "8.5"] }]);
    expect(res.body.data.templates).toHaveLength(1);
    expect(res.body.data.templates[0]).toMatchObject({
      id: BUILT_IN_WORDPRESS_TEMPLATE_ID,
      module: "wordpress",
      builtIn: true,
      enabled: true,
      archivedAt: null,
      defaultVersionId: BUILT_IN_WORDPRESS_VERSION_ID,
      defaultVersionNumber: 1,
      versionCount: 1,
      siteCount: 0,
    });

    const site = await call(admin, "POST", "/v1/admin/sites", { ...SITE, ownerOrganizationId: null }, { "Idempotency-Key": randomUUID() });
    expect(site.status).toBe(202);
    await dbClient.db.update(sites).set({ templateVersionId: null }).where(eq(sites.id, site.body.data.siteId as string));
    const after = await call(admin, "GET", BASE);
    expect(after.body.data.templates[0].siteCount).toBe(1);
    const detail = await call(admin, "GET", `${BASE}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}`);
    expect(detail.body.data.versions).toEqual([
      { id: BUILT_IN_WORDPRESS_VERSION_ID, versionNumber: 1, createdAt: expect.any(String), siteCount: 1, isDefault: true },
    ]);
  });

  it("refuses every non-administrator with 403 and one denied audit row, and a missing login with 401", async () => {
    const before = await counts();
    for (const [email, token] of [
      ["mario@hotel.it", owner],
      ["collab@hotel.it", collaborator],
      ["luigi@bar.it", stranger],
    ] as const) {
      const denied = await deniedRows(email);
      const res = await call(token, "POST", BASE, { module: "wordpress", name: "Mine", source: customSource() });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
      expect(await deniedRows(email)).toBe(denied + 1);
      // The guard comes before the body: a malformed one is still a 403 for a customer.
      expect((await call(token, "POST", `${BASE}/validate`, "{not json")).status).toBe(403);
      for (const [method, path] of [
        ["GET", BASE],
        ["GET", `${BASE}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}`],
        ["GET", `${BASE}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}/versions/${BUILT_IN_WORDPRESS_VERSION_ID}`],
        ["PATCH", `${BASE}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}`],
        ["DELETE", `${BASE}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}`],
        ["POST", `${BASE}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}/versions`],
      ] as const) {
        expect((await call(token, method, path, method === "GET" || method === "DELETE" ? undefined : {})).status, `${method} ${path}`).toBe(403);
      }
    }
    expect((await call(null, "POST", BASE, { module: "wordpress", name: "Mine", source: customSource() })).status).toBe(401);
    expect((await call(null, "GET", BASE)).status).toBe(401);
    expect(await counts()).toEqual(before);
  });

  describe("validate", () => {
    it("answers a valid source with the parameters and an array-only preview, and writes nothing", async () => {
      const before = await counts();
      const res = await call(admin, "POST", `${BASE}/validate`, { module: "wordpress", source: customSource() });
      expect(res.status).toBe(200);
      const { data } = res.body;
      expect(data.valid).toBe(true);
      expect(data.errors).toEqual([]);
      expect(data.parameters.map((p: Json) => p.key)).toEqual(["php_version", "upload_limit", "admin_note"]);
      expect(data.parameters.find((p: Json) => p.key === "upload_limit")).toMatchObject({ type: "enum", options: ["16M", "64M"], default: "16M", customer: true });
      expect(Object.keys(data.preview)).not.toContain("configuration");
      expect(data.preview).toMatchObject({
        module: "wordpress",
        exposeHttp: true,
        internalPort: 80,
        limits: { cpuMilli: 2000, memoryBytes: "1073741824" },
        environment: [{ name: "WORDPRESS_DEBUG", value: "0" }],
        volumes: [{ volume: "html", containerPath: "/var/www/html" }],
        phpSettings: [
          { key: "post_max_size", value: "128M" },
          { key: "upload_max_filesize", value: "64M" },
        ],
      });
      expect(data.preview.image).toMatch(/^wordpress:\d+\.\d+\.\d+-php8\.4-apache$/);
      expect(await counts()).toEqual(before);
    });

    it("answers 200 with the position of every problem", async () => {
      const post = (source: string) => call(admin, "POST", `${BASE}/validate`, { module: "wordpress", source });
      const tab = await post(customSource().replace("  app:\n", "\tapp:\n"));
      expect(tab.status).toBe(200);
      expect(tab.body.data).toMatchObject({ valid: false, parameters: [], preview: null });
      expect(tab.body.data.errors[0]).toEqual({ line: 21, column: 1, path: null, code: "TAB_INDENT", message: expect.any(String) });

      const privileged = await post(customSource().replace("  app:\n", "  app:\n    privileged: true\n"));
      expect(privileged.body.data.valid).toBe(false);
      expect(privileged.body.data.errors[0]).toMatchObject({ path: "services.app.privileged", line: 22, column: 5, code: "KEY_FORBIDDEN_SECURITY" });

      const module = await post(customSource().replace("x-hp-module: wordpress", "x-hp-module: drupal"));
      expect(module.body.data.errors[0]).toMatchObject({ path: "x-hp-module", code: "MODULE_MISMATCH" });
    });

    it("answers 400 on the source field for a source over 64 KiB, and for a body that is not JSON only for an administrator", async () => {
      const big = await call(admin, "POST", `${BASE}/validate`, { module: "wordpress", source: `# ${"a".repeat(70_000)}` });
      expect(big.status).toBe(400);
      expect(big.body.error.details.map((d: Json) => d.field)).toContain("source");
      expect((await call(admin, "POST", `${BASE}/validate`, "{not json")).status).toBe(400);
      expect((await call(admin, "POST", `${BASE}/validate`, { module: "wordpress" })).status).toBe(400);
      expect((await call(admin, "POST", `${BASE}/validate`, { module: "wordpress", source: customSource(), extra: 1 })).status).toBe(400);
    });
  });

  describe("create", () => {
    it("creates a disabled template whose version 1 is the default, audited without the source", async () => {
      const res = await createTemplate("Custom", customSource());
      expect(res.status).toBe(201);
      const { data } = res.body;
      expect(data).toMatchObject({
        module: "wordpress",
        name: "Custom",
        description: null,
        builtIn: false,
        enabled: false,
        archivedAt: null,
        defaultVersionNumber: 1,
        versionCount: 1,
        siteCount: 0,
      });
      expect(data.versions).toEqual([{ id: data.defaultVersionId, versionNumber: 1, createdAt: expect.any(String), siteCount: 0, isDefault: true }]);
      expect(JSON.stringify(data)).not.toContain("WORDPRESS_DEBUG");

      const rows = await auditRows("admin.site_template.create");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetType: "site_template", targetId: data.id, organizationId: null });
      expect(rows[0]!.details).toMatchObject({
        outcome: "succeeded",
        module: "wordpress",
        name: "Custom",
        versionId: data.defaultVersionId,
        versionNumber: 1,
        specHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(JSON.stringify(rows[0])).not.toContain("WORDPRESS_DEBUG");
      expect(JSON.stringify(rows[0])).not.toContain("x-hp-module");
    });

    it("keeps an empty description as null and trims the name", async () => {
      const res = await call(admin, "POST", BASE, { module: "wordpress", name: "  Padded  ", description: "", source: customSource() });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ name: "Padded", description: null });
    });

    it("refuses the same name in another case with 409 name_taken, and writes nothing", async () => {
      await newTemplate("Custom");
      const before = await counts();
      const res = await createTemplate("CUSTOM");
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ALREADY_EXISTS");
      expect(res.body.error.details).toEqual([{ field: "name", message: expect.any(String), reason: "name_taken" }]);
      expect(await counts()).toEqual(before);
      // The built-in name is taken too.
      expect((await createTemplate("wordpress")).status).toBe(409);
    });

    it("refuses an invalid source with 400 and the positioned problems, and writes nothing", async () => {
      const before = await counts();
      const res = await createTemplate("Bad", customSource().replace("  app:\n", "  app:\n    privileged: true\n"));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details[0]).toEqual({
        field: "services.app.privileged",
        message: expect.stringMatching(/^line 22, column 5: /),
        reason: "KEY_FORBIDDEN_SECURITY",
      });
      const syntax = await createTemplate("Bad", customSource().replace("  app:\n", "\tapp:\n"));
      expect(syntax.body.error.details[0]).toMatchObject({ field: "source", reason: "TAB_INDENT" });
      expect(await counts()).toEqual(before);
    });

    it("refuses an unknown module and a missing field with 400", async () => {
      expect((await call(admin, "POST", BASE, { module: "drupal", name: "X", source: customSource() })).status).toBe(400);
      expect((await call(admin, "POST", BASE, { module: "wordpress", source: customSource() })).status).toBe(400);
      expect((await call(admin, "POST", BASE, "{not json")).status).toBe(400);
    });
  });

  describe("versions", () => {
    it("makes the new version the default unless told otherwise", async () => {
      const id = await newTemplate();
      const v2 = await addVersion(id, customSource({ debug: "1" }));
      expect(v2.status).toBe(201);
      expect(v2.body.data).toMatchObject({ templateId: id, versionNumber: 2, isDefault: true, created: true, source: customSource({ debug: "1" }) });
      const v3 = await addVersion(id, customSource({ debug: "2" }), false);
      expect(v3.body.data).toMatchObject({ versionNumber: 3, isDefault: false, created: true });

      const detail = (await call(admin, "GET", `${BASE}/${id}`)).body.data;
      expect(detail).toMatchObject({ defaultVersionId: v2.body.data.id, defaultVersionNumber: 2, versionCount: 3 });
      expect(detail.versions.map((v: Json) => [v.versionNumber, v.isDefault])).toEqual([
        [3, false],
        [2, true],
        [1, false],
      ]);
      const audits = await auditRows("admin.site_template.version");
      expect(audits.map((row) => (row.details as Json).versionNumber)).toEqual([2, 3]);
      expect(audits[1]!.details).toMatchObject({ templateId: id, makeDefault: false, created: true, specHash: expect.any(String) });
      expect(JSON.stringify(audits)).not.toContain("WORDPRESS_DEBUG");
    });

    it("writes nothing for a source identical to the latest version", async () => {
      const id = await newTemplate();
      const before = await counts();
      const again = await addVersion(id, customSource());
      expect(again.status).toBe(201);
      expect(again.body.data).toMatchObject({ versionNumber: 1, isDefault: true, created: false });
      expect(await counts()).toEqual(before);
    });

    it("numbers two concurrent saves 2 and 3", async () => {
      const id = await newTemplate();
      const [a, b] = await Promise.all([addVersion(id, customSource({ debug: "1" })), addVersion(id, customSource({ debug: "2" }))]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect([a.body.data.versionNumber, b.body.data.versionNumber].sort()).toEqual([2, 3]);
    });

    it("refuses an invalid source, an archived template and an unknown template", async () => {
      const id = await newTemplate();
      const before = await counts();
      const bad = await addVersion(id, customSource().replace("  app:\n", "  app:\n    privileged: true\n"));
      expect(bad.status).toBe(400);
      expect(bad.body.error.details[0]).toMatchObject({ field: "services.app.privileged" });
      expect((await addVersion(id, customSource().replace("x-hp-module: wordpress", "x-hp-module: drupal"))).body.error.details[0]).toMatchObject({
        field: "x-hp-module",
        reason: "MODULE_MISMATCH",
      });
      expect(await counts()).toEqual(before);

      expect((await call(admin, "DELETE", `${BASE}/${id}`)).status).toBe(200);
      const archived = await addVersion(id, customSource({ debug: "9" }));
      expect(archived.status).toBe(409);
      expect(archived.body.error.code).toBe("RESOURCE_LOCKED");
      expect(archived.body.error.details).toEqual([{ message: expect.any(String), reason: "template_archived" }]);
      expect((await addVersion("stpl_missing", customSource())).status).toBe(404);
    });

    it("accepts a new version of the built-in template", async () => {
      const res = await addVersion(BUILT_IN_WORDPRESS_TEMPLATE_ID, customSource(), false);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ versionNumber: 2, isDefault: false, created: true });
    });

    it("returns one version with its source, and 404 for a foreign pair or an unknown id", async () => {
      const id = await newTemplate();
      const detail = (await call(admin, "GET", `${BASE}/${id}`)).body.data;
      const one = await call(admin, "GET", `${BASE}/${id}/versions/${detail.defaultVersionId}`);
      expect(one.status).toBe(200);
      expect(one.body.data).toEqual({
        id: detail.defaultVersionId,
        templateId: id,
        versionNumber: 1,
        createdAt: expect.any(String),
        source: customSource(),
      });
      const builtIn = await call(admin, "GET", `${BASE}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}/versions/${BUILT_IN_WORDPRESS_VERSION_ID}`);
      expect(builtIn.body.data.source).toContain("x-hp-module: wordpress");
      expect((await call(admin, "GET", `${BASE}/${id}/versions/${BUILT_IN_WORDPRESS_VERSION_ID}`)).status).toBe(404);
      expect((await call(admin, "GET", `${BASE}/${id}/versions/stv_missing`)).status).toBe(404);
      expect((await call(admin, "GET", `${BASE}/stpl_missing`)).status).toBe(404);
    });
  });

  describe("update", () => {
    it("renames, clears the description and audits the changes", async () => {
      const id = await newTemplate();
      const renamed = await patch(id, { name: "Renamed", description: "About it" });
      expect(renamed.status).toBe(200);
      expect(renamed.body.data).toMatchObject({ name: "Renamed", description: "About it" });
      expect((await patch(id, { description: null })).body.data.description).toBeNull();
      const audits = await auditRows("admin.site_template.update");
      expect(audits.map((row) => (row.details as Json).changes)).toEqual([
        [
          { field: "name", from: "Custom", to: "Renamed" },
          { field: "description", from: null, to: "About it" },
        ],
        [{ field: "description", from: "About it", to: null }],
      ]);
    });

    it("changes the default version, and refuses a version of another template", async () => {
      const id = await newTemplate();
      const v2 = await addVersion(id, customSource({ debug: "1" }), false);
      const v1 = (await call(admin, "GET", `${BASE}/${id}`)).body.data.defaultVersionId as string;
      const switched = await patch(id, { defaultVersionId: v2.body.data.id });
      expect(switched.body.data).toMatchObject({ defaultVersionId: v2.body.data.id, defaultVersionNumber: 2 });
      const back = await patch(id, { defaultVersionId: v1 });
      expect(back.body.data.defaultVersionNumber).toBe(1);

      const foreign = await patch(id, { defaultVersionId: BUILT_IN_WORDPRESS_VERSION_ID });
      expect(foreign.status).toBe(400);
      expect(foreign.body.error.details).toEqual([{ field: "defaultVersionId", message: expect.any(String), reason: "unknown_version" }]);
      expect((await patch(id, { defaultVersionId: "stv_missing" })).status).toBe(400);
    });

    it("flips enabled and audits it; a patch that changes nothing writes no audit row", async () => {
      const id = await newTemplate();
      const enabled = await patch(id, { enabled: true });
      expect(enabled.status).toBe(200);
      expect(enabled.body.data.enabled).toBe(true);
      expect((await auditRows("admin.site_template.update"))[0]!.details).toMatchObject({
        templateId: id,
        changes: [{ field: "enabled", from: false, to: true }],
      });
      const before = await counts();
      const same = await patch(id, { enabled: true, name: "Custom", description: null });
      expect(same.status).toBe(200);
      expect(await counts()).toEqual(before);
    });

    it("refuses an empty patch, an unknown key, a taken name, an unknown template and an archived one", async () => {
      const id = await newTemplate();
      await newTemplate("Other");
      expect((await patch(id, {})).status).toBe(400);
      expect((await patch(id, { surprise: true })).status).toBe(400);
      const taken = await patch(id, { name: "other" });
      expect(taken.status).toBe(409);
      expect(taken.body.error.details[0]).toMatchObject({ field: "name", reason: "name_taken" });
      expect((await patch("stpl_missing", { enabled: true })).status).toBe(404);
      await call(admin, "DELETE", `${BASE}/${id}`);
      const locked = await patch(id, { enabled: true });
      expect(locked.status).toBe(409);
      expect(locked.body.error.details).toEqual([{ message: expect.any(String), reason: "template_archived" }]);
    });

    it("refuses to enable a template whose default version the validator now refuses", async () => {
      const id = await newTemplate();
      // Stored versions are immutable, so the stale version is inserted the way an older release would have kept it.
      await dbClient.db.insert(siteTemplateVersions).values({
        id: "stv_stale",
        templateId: id,
        versionNumber: 2,
        source: customSource().replace("  app:\n", "  app:\n    privileged: true\n"),
        spec: BUILT_IN_WORDPRESS_SPEC,
        specHash: "0".repeat(64),
        createdBy: null,
      });
      await dbClient.db.update(siteTemplates).set({ defaultVersionId: "stv_stale" }).where(eq(siteTemplates.id, id));
      const before = await counts();
      const res = await patch(id, { enabled: true });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field: "enabled", message: expect.any(String), reason: "template_invalid" }]);
      expect(await counts()).toEqual(before);
      expect((await call(admin, "GET", `${BASE}/${id}`)).body.data.enabled).toBe(false);
    });

    it("never leaves a template enabled on a default version the validator refuses, when the default changes at the same time", async () => {
      const id = await newTemplate();
      await dbClient.db.insert(siteTemplateVersions).values({
        id: "stv_stale",
        templateId: id,
        versionNumber: 2,
        source: customSource().replace("  app:\n", "  app:\n    privileged: true\n"),
        spec: BUILT_IN_WORDPRESS_SPEC,
        specHash: "0".repeat(64),
        createdBy: null,
      });
      // The template is disabled and its default passes: the enabling request must still see the default the other one sets.
      const [enable, setDefault] = await sentTogether([() => patch(id, { enabled: true }), () => patch(id, { defaultVersionId: "stv_stale" })]);
      const final = (await dbClient.db.select().from(siteTemplates).where(eq(siteTemplates.id, id)))[0]!;
      expect(final.enabled && final.defaultVersionId === "stv_stale").toBe(false);
      expect([setDefault.status, enable.status].sort()).toEqual([200, 400]);
    });
  });

  describe("archive", () => {
    it("archives a custom template, disabled, and answers a second call unchanged without a second audit row", async () => {
      const id = await newTemplate();
      await patch(id, { enabled: true });
      const res = await call(admin, "DELETE", `${BASE}/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id, enabled: false, archivedAt: expect.any(String) });
      const rows = await auditRows("admin.site_template.archive");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details).toMatchObject({ templateId: id, name: "Custom", siteCount: 0 });

      const again = await call(admin, "DELETE", `${BASE}/${id}`);
      expect(again.status).toBe(200);
      expect(again.body.data.archivedAt).toBe(res.body.data.archivedAt);
      expect(await auditRows("admin.site_template.archive")).toHaveLength(1);
      // The admin still sees it in the list and in the detail.
      const list = await call(admin, "GET", BASE);
      expect(list.body.data.templates.find((t: Json) => t.id === id).archivedAt).toEqual(expect.any(String));
    });

    it("writes exactly one audit row when two archive requests arrive at once", async () => {
      const id = await newTemplate();
      const [a, b] = await sentTogether([() => call(admin, "DELETE", `${BASE}/${id}`), () => call(admin, "DELETE", `${BASE}/${id}`)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body.data.archivedAt).toBe(b.body.data.archivedAt);
      expect(await auditRows("admin.site_template.archive")).toHaveLength(1);
    });

    it("refuses the built-in template with 409 built_in and an unknown one with 404", async () => {
      const before = await counts();
      const res = await call(admin, "DELETE", `${BASE}/${BUILT_IN_WORDPRESS_TEMPLATE_ID}`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("RESOURCE_LOCKED");
      expect(res.body.error.details).toEqual([{ message: expect.any(String), reason: "built_in" }]);
      expect((await call(admin, "DELETE", `${BASE}/stpl_missing`)).status).toBe(404);
      expect(await counts()).toEqual(before);
    });

    it("lets the name of an archived template be used again", async () => {
      const id = await newTemplate();
      await call(admin, "DELETE", `${BASE}/${id}`);
      expect((await createTemplate("Custom")).status).toBe(201);
    });
  });

  describe("customer list of site types", () => {
    it("offers only the built-in template at first, with its PHP choice and no parameters", async () => {
      const res = await siteTypesOf(owner, ownerOrg);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        siteTypes: [
          {
            id: BUILT_IN_WORDPRESS_TEMPLATE_ID,
            name: "WordPress",
            description: null,
            module: "wordpress",
            phpVersions: ["8.3", "8.4", "8.5"],
            defaultPhpVersion: "8.4",
            parameters: [],
          },
        ],
      });
    });

    it("lists an enabled custom template with only its customer parameters, and drops it again when disabled or archived", async () => {
      const id = await newTemplate();
      expect((await siteTypesOf(owner, ownerOrg)).body.data.siteTypes).toHaveLength(1);
      await patch(id, { enabled: true });
      const listed = (await siteTypesOf(owner, ownerOrg)).body.data.siteTypes as Json[];
      expect(listed.map((t) => t.id)).toEqual([BUILT_IN_WORDPRESS_TEMPLATE_ID, id]);
      expect(listed[1]).toMatchObject({ name: "Custom", phpVersions: ["8.4", "8.5"], defaultPhpVersion: "8.4" });
      expect(listed[1]!.parameters).toEqual([{ key: "upload_limit", label: "Upload limit", type: "enum", options: ["16M", "64M"], default: "16M" }]);

      await patch(id, { enabled: false });
      expect((await siteTypesOf(owner, ownerOrg)).body.data.siteTypes).toHaveLength(1);
      await patch(id, { enabled: true });
      await call(admin, "DELETE", `${BASE}/${id}`);
      expect((await siteTypesOf(owner, ownerOrg)).body.data.siteTypes).toHaveLength(1);
    });

    it("offers the default version of a template, and never the source, the image, the environment or the limits", async () => {
      const id = await newTemplate();
      await patch(id, { enabled: true });
      await addVersion(id, customSource({ debug: "1" }), false);
      const raw = (await siteTypesOf(owner, ownerOrg)).raw;
      for (const forbidden of ["source", "image", "wordpress:", "limits", "memory", "WORDPRESS_DEBUG", "admin_note", "environment", "upload_max_filesize"]) {
        expect(raw, forbidden).not.toContain(forbidden);
      }
    });

    it("answers every organisation the same list", async () => {
      const id = await newTemplate();
      await patch(id, { enabled: true });
      expect((await siteTypesOf(stranger, strangerOrg)).body).toEqual((await siteTypesOf(owner, ownerOrg)).body);
    });

    it("checks login, organisation and permission in the order of the other customer routes", async () => {
      expect((await siteTypesOf(stranger, ownerOrg)).status).toBe(404);
      expect((await siteTypesOf(admin, ownerOrg)).status).toBe(404);
      expect((await siteTypesOf(owner, "org_missing")).status).toBe(404);
      const collab = await siteTypesOf(collaborator, ownerOrg);
      expect(collab.status).toBe(403);
      expect(collab.body.error.code).toBe("PERMISSION_DENIED");
      const missing = await call(null, "GET", `/v1/organizations/${ownerOrg}/site-types`);
      expect(missing.status).toBe(401);
    });

    it("writes no audit row", async () => {
      const before = await counts();
      await siteTypesOf(owner, ownerOrg);
      expect(await counts()).toEqual(before);
    });
  });
});
