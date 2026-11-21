import { randomUUID } from "node:crypto";
import {
  BUILT_IN_WORDPRESS_VERSION_ID,
  SiteImageUpdateAcceptedDtoSchema,
  UpdatesDtoSchema,
  resolveWordpressImage,
  type SiteTemplateSpec,
} from "@hosting-panel/contracts";
import {
  appendStackRevisionTransactional,
  auditEvents,
  createDatabaseClient,
  eq,
  serviceInstances,
  siteTemplateVersions,
  sites,
  stackRevisions,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { customSource } from "./fixtures/site-templates.js";

const KEY = Buffer.alloc(32, 9);
const PW = "sentinel-password-0009";
const SETUP = { installationName: "Updates Templates Test", hostHostname: "panel.example.test", hostIpv4: "192.0.2.1" };
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Pass-123456",
};
// A custom template whose literal image tag is not the WordPress pin: a version renders the tag it was saved with.
const withTag = (tag: string) => customSource().replace(/image: wordpress:\d+\.\d+\.\d+-php/, () => `image: wordpress:${tag}-php`);
const tagged = (tag: string, php: string) => `wordpress:${tag}-php${php}-apache`;
const UPLOAD = [{ key: "upload_limit", value: "64M" }];

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("admin updates and site templates", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let admin: string;

  async function call(method: string, path: string, body?: unknown, key: string | null = randomUUID()): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${admin}`, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  async function start(): Promise<void> {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const account = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: new InMemoryDockerSimulatorAdapter() as DockerExecutorPort,
      hostAgent: new InMemoryHostSimulatorAdapter() as HostAgentPort,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    const login = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password: PW, totpCode: totpCodeAt(account.totpSecretBase32, Math.floor(Date.now() / 30_000)) }),
    });
    admin = ((await login.json()) as Json).data.accessToken as string;
  }

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  const updates = async () => {
    const res = await call("GET", "/v1/admin/updates");
    expect(res.status).toBe(200);
    return UpdatesDtoSchema.parse(res.body.data);
  };
  const auditOf = async (action: string) => (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action))).map((row) => row.details as Json);
  const revisionImages = async (serviceId: string) =>
    (await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, serviceId)))
      .sort((a, b) => a.revisionNumber - b.revisionNumber)
      .map((row) => (row.declarativeConfig as Json).image as string);

  async function createSite(site: Partial<typeof SITE> = {}): Promise<{ siteId: string; serviceId: string }> {
    const res = await call("POST", "/v1/admin/sites", { ...SITE, ...site, ownerOrganizationId: null });
    expect(res.status, res.raw).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const siteId = res.body.data.siteId as string;
    const [svc] = await dbClient.db.select().from(serviceInstances).where(eq(serviceInstances.siteId, siteId));
    return { siteId, serviceId: svc!.id };
  }

  async function newVersion(source: string): Promise<string> {
    const res = await call("POST", "/v1/admin/site-templates", { module: "wordpress", name: `Custom ${randomUUID()}`, source });
    expect(res.status, res.raw).toBe(201);
    return res.body.data.defaultVersionId as string;
  }

  const useVersion = (siteId: string, templateVersionId: string | null, templateParameters: Array<{ key: string; value: string }> | null = null) =>
    dbClient.db.update(sites).set({ templateVersionId, templateParameters }).where(eq(sites.id, siteId));
  const setPhp = (siteId: string, phpVersion: "8.4" | "8.5") => dbClient.db.update(sites).set({ phpVersion }).where(eq(sites.id, siteId));
  const pushRevision = async (siteId: string, serviceId: string, image: string) => {
    const [current] = await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, serviceId));
    await appendStackRevisionTransactional(dbClient.db, {
      serviceInstanceId: serviceId,
      organizationId: (await dbClient.db.select().from(sites).where(eq(sites.id, siteId)))[0]!.organizationId,
      declarativeConfig: { ...(current!.declarativeConfig as Json), image },
    });
  };

  it("a template site is behind when its revision differs from what its own template version renders", async () => {
    await start();
    const { siteId, serviceId } = await createSite();
    const v1 = await newVersion(withTag("6.8.0"));
    // The revision still runs the built-in pin of PHP 8.4, which the legacy comparison would call current.
    await useVersion(siteId, v1, UPLOAD);
    const dto = await updates();
    expect([dto.sitesTotal, dto.sites.map((s) => [s.siteId, s.phpVersion])]).toEqual([1, [[siteId, "8.4"]]]);

    // Once the revision runs the render of its version the site is current, though that is not the pin.
    await pushRevision(siteId, serviceId, tagged("6.8.0", "8.4"));
    expect((await updates()).sitesTotal).toBe(0);

    // Another PHP version renders another image; so does another version of the template.
    await setPhp(siteId, "8.5");
    expect((await updates()).sites.map((s) => [s.siteId, s.phpVersion])).toEqual([[siteId, "8.5"]]);
    await setPhp(siteId, "8.4");
    expect((await updates()).sitesTotal).toBe(0);
    await useVersion(siteId, await newVersion(withTag("6.9.0")), UPLOAD);
    expect((await updates()).sitesTotal).toBe(1);
  }, 30_000);

  it("the image update deploys the render of the site's template version, not the WordPress pin", async () => {
    await start();
    const { siteId, serviceId } = await createSite();
    await useVersion(siteId, await newVersion(withTag("6.8.0")), UPLOAD);
    await pushRevision(siteId, serviceId, tagged("6.8.0", "8.4"));
    await setPhp(siteId, "8.5");
    expect((await updates()).sitesTotal).toBe(1);

    const res = await call("POST", `/v1/admin/sites/${siteId}/image-update`);
    expect(res.status, res.raw).toBe(202);
    expect(SiteImageUpdateAcceptedDtoSchema.parse(res.body.data).siteId).toBe(siteId);
    const rows = await auditOf("admin.update.site_image");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ siteId, fromImage: tagged("6.8.0", "8.4"), toImage: tagged("6.8.0", "8.5") });
    expect((await revisionImages(serviceId)).at(-1)).toBe(tagged("6.8.0", "8.5"));
    expect((await revisionImages(serviceId)).at(-1)).not.toBe(resolveWordpressImage("8.5"));
    await app.outboxWorker.processPendingOnce();
    expect((await updates()).sitesTotal).toBe(0);
    expect((await call("POST", `/v1/admin/sites/${siteId}/image-update`)).body.error?.details?.[0]?.reason).toBe("already_current");
  }, 30_000);

  it("a template version that cannot be rendered is not behind and cannot be redeployed", async () => {
    await start();
    const { siteId } = await createSite();
    const version = await newVersion(withTag("6.8.0"));
    await useVersion(siteId, version, UPLOAD);
    expect((await updates()).sitesTotal).toBe(1);

    // Version rows are immutable, so a corrupt stored spec is a new row.
    const [row] = await dbClient.db.select().from(siteTemplateVersions).where(eq(siteTemplateVersions.id, version));
    const corrupt = `stv_${randomUUID().replace(/-/g, "")}`;
    await dbClient.db.insert(siteTemplateVersions).values({ ...row!, id: corrupt, versionNumber: 99, spec: { corrupt: true } as unknown as SiteTemplateSpec });
    await useVersion(siteId, corrupt, UPLOAD);
    expect((await updates()).sitesTotal).toBe(0);
    const res = await call("POST", `/v1/admin/sites/${siteId}/image-update`);
    expect([res.status, res.body.error?.details?.[0]?.reason]).toEqual([400, "already_current"]);
    expect(await auditOf("admin.update.site_image")).toEqual([]);
  }, 30_000);

  it("legacy sites without a template version and sites on the built-in version keep following the pin", async () => {
    await start();
    const legacy = await createSite();
    const builtIn = await createSite({ name: "Site B", domain: "wp-b.example.test", title: "Site B" });
    await useVersion(legacy.siteId, null);
    await useVersion(builtIn.siteId, BUILT_IN_WORDPRESS_VERSION_ID);
    expect((await updates()).sitesTotal).toBe(0);

    await setPhp(legacy.siteId, "8.5");
    await setPhp(builtIn.siteId, "8.5");
    const dto = await updates();
    expect([dto.sitesTotal, dto.sites.map((s) => s.siteId)]).toEqual([2, [legacy.siteId, builtIn.siteId]]);

    for (const { siteId, serviceId } of [legacy, builtIn]) {
      const res = await call("POST", `/v1/admin/sites/${siteId}/image-update`);
      expect(res.status, res.raw).toBe(202);
      expect((await revisionImages(serviceId)).at(-1)).toBe(resolveWordpressImage("8.5"));
    }
    expect((await auditOf("admin.update.site_image")).map((d) => [d.fromImage, d.toImage])).toEqual([
      [resolveWordpressImage("8.4"), resolveWordpressImage("8.5")],
      [resolveWordpressImage("8.4"), resolveWordpressImage("8.5")],
    ]);
  }, 30_000);
});
