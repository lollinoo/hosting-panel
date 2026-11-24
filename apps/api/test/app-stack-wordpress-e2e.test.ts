/**
 * The built-in «WordPress in contenitore» (ADR-0036 §2.9) end to end on the simulator: seeded disabled, switched on by
 * the administrator, installed by a customer who types no password, started with the database passwords the platform
 * generated, restarted and deleted. What is proven here is the path of the panel; that the real images start with this
 * body is proven on a real Engine (ADR-0036 §6 and infra/linux/accept-app-stack-wordpress.mjs).
 */
import { randomUUID } from "node:crypto";
import {
  APP_BUILT_IN_TEMPLATES,
  AppStackDetailDtoSchema,
  ApprovedStackPlanSchema,
  CustomerAppTemplateDtoSchema,
  appStackPlanSecretRefs,
} from "@hosting-panel/contracts";
import {
  appStackComponents,
  appStackDomains,
  appStackRevisions,
  appStackSecrets,
  appStackVolumes,
  appStacks,
  asc,
  builtInAppTemplateItems,
  ensureBuiltInAppTemplates,
  eq,
  operations,
  readAppStackSecretFiles,
  sql,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_MASTER_KEY, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Payload {
  readonly Image: string;
  readonly User?: string;
  readonly Cmd?: readonly string[];
  readonly Env: readonly string[];
  readonly HostConfig: Json;
  readonly NetworkingConfig: { readonly EndpointsConfig: Record<string, unknown> };
}

const WORDPRESS = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === "wordpress-mariadb")!;
/** The one PHP line version 2 gives the image (ADR-0036): the site's address follows the name it is asked by. */
const CONFIG_EXTRA =
  "WORDPRESS_CONFIG_EXTRA=$hcp_host = isset($_SERVER['HTTP_HOST']) ? strtolower($_SERVER['HTTP_HOST']) : ''; if (preg_match('/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/D', $hcp_host)) { define('WP_HOME', ((isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https' : 'http') . '://' . $hcp_host); define('WP_SITEURL', WP_HOME); } unset($hcp_host);";
const json = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
const spellings = (value: string): string[] => [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex")];

describe("WordPress from the catalogue, end to end on the simulator (ADR-0036)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let stackId = "";
  let created: Awaited<ReturnType<AppStackHarness["call"]>>;
  let dbPassword = "";
  let rootPassword = "";
  const hostname = `${randomUUID().slice(0, 8)}.example.test`;
  const NAME = "Il blog di Mario";

  beforeAll(async () => {
    // The default harness allowlist: the WordPress images are on no allowlist, and need none.
    h = await startAppStackHarness();
    // The harness injects its database client, and an app given one skips its boot seeding: run the call a boot makes.
    await ensureBuiltInAppTemplates(h.dbClient.db, builtInAppTemplateItems());
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    // The DNS pass is not under test here: a domain write must not look anything up.
    vi.spyOn(h.app.nestApp.get(AppStackObserverService), "reconcileStack").mockResolvedValue(undefined);
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.close();
  }, 60_000);

  const stacksPath = (tail = "") => `/v1/organizations/${h.a.orgId}/app-stacks${tail}`;
  const idem = () => ({ "Idempotency-Key": randomUUID() });
  const worker = () => h.app.nestApp.get(OutboxWorkerService);
  const catalogue = () => h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-templates`);
  const stackRow = async () => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = () => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
  const payloadOf = (component: string) => sim.appStacks.getAppStackSnapshot(stackId)!.containers[component]!.payload as unknown as Payload;
  const secretRows = () =>
    h.dbClient.db
      .select()
      .from(appStackSecrets)
      .where(eq(appStackSecrets.stackId, stackId))
      .orderBy(asc(appStackSecrets.parameterKey), asc(appStackSecrets.version));

  async function drain(): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
      await worker().processPendingOnce();
      const open = (await opsOf()).filter((o) => ["queued", "running", "processing"].includes(o.status));
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  async function valueOf(parameterKey: string): Promise<string> {
    const [file] = await readAppStackSecretFiles(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId,
      masterKey: APP_TEST_MASTER_KEY,
      refs: [{ parameterKey, version: 1 }],
    });
    return file!.content;
  }

  it("is seeded disabled: the administrator sees it, the customer's catalogue is empty", async () => {
    const admin = await h.call(h.adminToken, "GET", "/v1/admin/app-templates");
    expect(admin.status, admin.raw).toBe(200);
    const rows = (admin.body.data.templates ?? admin.body.data) as Json[];
    expect(rows.find((row) => row.id === WORDPRESS.templateId)).toMatchObject({ slug: "wordpress-mariadb", builtIn: true, enabled: false });
    expect((await catalogue()).body.data).toEqual({ templates: [], categories: [] });
  });

  it("once the administrator switches it on, the customer finds it with nothing to fill in", async () => {
    const enabled = await h.call(h.adminToken, "PATCH", `/v1/admin/app-templates/${WORDPRESS.templateId}`, { enabled: true });
    expect(enabled.status, enabled.raw).toBe(200);

    const list = await catalogue();
    expect(list.body.data.categories).toEqual(["content"]);
    expect(list.body.data.templates).toEqual([
      expect.objectContaining({
        id: WORDPRESS.templateId,
        versionId: WORDPRESS.versionId,
        name: "WordPress in contenitore",
        category: "content",
        componentCount: 2,
        volumeCount: 2,
        hasIngress: true,
        cpuMilli: 2000,
        memoryBytes: "1073741824",
      }),
    ]);

    const detail = await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-templates/${WORDPRESS.templateId}`);
    expect(detail.status, detail.raw).toBe(200);
    const dto = CustomerAppTemplateDtoSchema.parse(detail.body.data);
    expect(dto.parameters).toEqual([]);
    expect(dto.ingress).toEqual([expect.objectContaining({ componentKey: "wordpress", port: 80 })]);
    for (const word of ["db_password", "db_root_password", '"generate"', "sha256:", "MARIADB_", "WORDPRESS_DB_"]) {
      expect(detail.raw.includes(word), word).toBe(false);
      expect(list.raw.includes(word), word).toBe(false);
    }
  });

  it("the customer installs it with a name and a domain, and no password: it ends running and healthy", async () => {
    created = await h.call(
      h.a.token,
      "POST",
      stacksPath(),
      { templateVersionId: WORDPRESS.versionId, name: NAME, deploy: true, domains: [{ hostname, componentKey: "wordpress", port: 80 }] },
      idem(),
    );
    expect(created.status, created.raw).toBe(202);
    stackId = created.body.data.stackId as string;
    await drain();

    expect((await opsOf())[0]).toMatchObject({ kind: "stack.deploy", status: "succeeded", errorCode: null });
    expect((await stackRow()).status).toBe("running");
    const health = await h.dbClient.db.select().from(appStackComponents).where(eq(appStackComponents.stackId, stackId));
    expect(Object.fromEntries(health.map((c) => [c.componentKey, c.health]))).toEqual({ db: "healthy", wordpress: "healthy" });
    expect((await h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId))).map((v) => [v.volumeKey, v.status]).sort()).toEqual([
      ["database", "present"],
      ["site", "present"],
    ]);

    dbPassword = await valueOf("db_password");
    rootPassword = await valueOf("db_root_password");
  }, 60_000);

  it("the platform generated the two database passwords: 32 letters and digits each, different, stored once", () => {
    expect(dbPassword).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(rootPassword).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(dbPassword).not.toBe(rootPassword);
  });

  it("stores one encrypted version of each, and nothing else", async () => {
    const rows = await secretRows();
    expect(rows.map((row) => [row.parameterKey, row.version])).toEqual([
      ["db_password", 1],
      ["db_root_password", 1],
    ]);
    for (const value of [dbPassword, rootPassword]) for (const form of spellings(value)) expect(json(rows).includes(form)).toBe(false);
  });

  it("WordPress and its database receive the same password, each under the name its software reads", () => {
    expect([...payloadOf("wordpress").Env].sort()).toEqual(
      [CONFIG_EXTRA, "WORDPRESS_DB_HOST=db", "WORDPRESS_DB_NAME=wordpress", "WORDPRESS_DB_USER=wordpress", `WORDPRESS_DB_PASSWORD=${dbPassword}`].sort(),
    );
    expect([...payloadOf("db").Env].sort()).toEqual(
      ["MARIADB_DATABASE=wordpress", "MARIADB_USER=wordpress", `MARIADB_PASSWORD=${dbPassword}`, `MARIADB_ROOT_PASSWORD=${rootPassword}`].sort(),
    );
    expect(payloadOf("wordpress").Env.some((entry) => entry.includes(rootPassword))).toBe(false);
  });

  it("both run with the standard profile and nothing more: six fixed capabilities, no privilege, no host path, no socket", () => {
    // The image's own start program, told the uploads limit; never an entrypoint.
    expect(payloadOf("wordpress").Cmd).toEqual(["apache2-foreground", "-c", "php_value upload_max_filesize 64M", "-c", "php_value post_max_size 64M"]);
    expect(payloadOf("db").Cmd).toBeUndefined();
    for (const component of ["wordpress", "db"]) {
      const payload = payloadOf(component);
      expect(payload.User, component).toBeUndefined();
      expect((payload as unknown as Json)["Entrypoint"], component).toBeUndefined();
      expect(payload.HostConfig, component).toMatchObject({
        Privileged: false,
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID", "NET_BIND_SERVICE"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: false,
        PidsLimit: 512,
        NanoCpus: 1_000_000_000,
        Memory: 536_870_912,
        MemorySwap: 536_870_912,
        RestartPolicy: { Name: "unless-stopped" },
        Binds: [],
      });
      expect(payload.HostConfig.Tmpfs, component).toBeUndefined();
      expect(payload.HostConfig.PortBindings, component).toBeUndefined();
      expect(payload.HostConfig.Devices, component).toBeUndefined();
      expect(json(payload).includes("docker.sock"), component).toBe(false);
      expect(String(payload.HostConfig.NetworkMode), component).toBe(`hp_appnet_${stackId}`);
    }
    expect(payloadOf("wordpress").Image).toBe("wordpress@sha256:4bf2c44f19a5eba28de4e5cbe50e1c5dc55ae3f8b894f681f4d7676a7e2512e5");
    expect(payloadOf("db").Image).toBe("mariadb@sha256:4aaf88b3106382c8c18e49f0cec60267be618fc22f858c4503afb2a2555afed3");
    expect(payloadOf("wordpress").HostConfig.Mounts).toEqual([
      { Type: "volume", Source: `hp_appvol_${stackId}_site`, Target: "/var/www/html", ReadOnly: false },
    ]);
    expect(payloadOf("db").HostConfig.Mounts).toEqual([
      { Type: "volume", Source: `hp_appvol_${stackId}_database`, Target: "/var/lib/mysql", ReadOnly: false },
    ]);
  });

  it("only WordPress is reachable from the proxy; the database stays on the private network of the application", () => {
    const snapshot = sim.appStacks.getAppStackSnapshot(stackId)!;
    expect(Object.keys(snapshot.networks).sort()).toEqual(["app_edge", "app_internal"]);
    expect(Object.keys(payloadOf("db").NetworkingConfig.EndpointsConfig)).toEqual([`hp_appnet_${stackId}`]);
    expect(snapshot.routes).toEqual([
      expect.objectContaining({ componentKey: "wordpress", internalPort: 80, hosts: [expect.objectContaining({ hostname })] }),
    ]);
    expect(JSON.stringify(snapshot.routes)).not.toContain('"db"');
  });

  it("the domain is active on the WordPress component", async () => {
    expect(await h.dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId))).toEqual([
      expect.objectContaining({ hostname, status: "active", componentKey: "wordpress", internalPort: 80 }),
    ]);
  });

  it("the customer's view of the application names no secret, and no password is in any answer or stored row", async () => {
    const read = await h.call(h.a.token, "GET", stacksPath(`/${stackId}`));
    expect(read.status, read.raw).toBe(200);
    const dto = AppStackDetailDtoSchema.parse(read.body.data);
    expect(dto.status).toBe("running");
    expect(dto.secretParameters).toEqual([]);
    expect(dto.parameters).toEqual([]);
    const deployments = await h.call(h.a.token, "GET", stacksPath(`/${stackId}/deployments`));
    const adminList = await h.call(h.adminToken, "GET", "/v1/admin/app-stacks");
    const answers = [created.raw, read.raw, deployments.raw, adminList.raw];
    for (const raw of answers) {
      for (const word of ["db_password", "db_root_password"]) expect(raw.includes(word), word).toBe(false);
    }

    // Every public table except the one that holds the encrypted secrets.
    const tables = await h.dbClient.db.execute(sql`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `);
    const dump: string[] = [...answers];
    for (const entry of tables.rows) {
      const name = String(entry["table_name"]);
      if (!/^[a-z0-9_]+$/i.test(name) || name === "app_stack_secrets") continue;
      dump.push(json((await h.dbClient.db.execute(sql.raw(`SELECT * FROM "${name}"`))).rows));
    }
    expect(dump.length).toBeGreaterThan(20);
    for (const value of [dbPassword, rootPassword]) {
      for (const form of spellings(value)) expect(dump.some((text) => text.includes(form))).toBe(false);
    }
    // The stored plan names the secrets by key and version only.
    const [revision] = await h.dbClient.db.select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId));
    expect(appStackPlanSecretRefs(ApprovedStackPlanSchema.parse(revision!.plan))).toEqual([
      { parameterKey: "db_password", version: 1 },
      { parameterKey: "db_root_password", version: 1 },
    ]);
  });

  it("the customer cannot read or replace a generated password", async () => {
    for (const parameterKey of ["db_password", "db_root_password"]) {
      const res = await h.call(h.a.token, "POST", stacksPath(`/${stackId}/secrets`), { parameterKey, value: "una-password-scelta-dal-cliente" });
      expect(res.status, res.raw).toBe(400);
      expect(res.body.error.details).toContainEqual(expect.objectContaining({ field: "parameterKey", reason: "STACK_PARAMETER_INVALID" }));
    }
    expect((await secretRows()).map((row) => [row.parameterKey, row.version])).toEqual([
      ["db_password", 1],
      ["db_root_password", 1],
    ]);
  });

  it("a restart keeps the same passwords: the database that was initialised with them still accepts WordPress", async () => {
    const res = await h.call(h.a.token, "POST", stacksPath(`/${stackId}/restart`), {}, idem());
    expect(res.status, res.raw).toBe(202);
    await drain();
    expect((await opsOf()).find((o) => o.kind === "stack.restart")).toMatchObject({ status: "succeeded" });
    expect((await stackRow()).status).toBe("running");
    expect(payloadOf("wordpress").Env).toContain(`WORDPRESS_DB_PASSWORD=${dbPassword}`);
    expect(payloadOf("db").Env).toContain(`MARIADB_PASSWORD=${dbPassword}`);
    expect((await secretRows()).length).toBe(2);
  }, 60_000);

  it("a second WordPress of the same customer gets passwords of its own", async () => {
    const other = await h.call(h.a.token, "POST", stacksPath(), { templateVersionId: WORDPRESS.versionId, name: "Secondo blog", deploy: false }, idem());
    expect(other.status, other.raw).toBe(201);
    const otherId = other.body.data.stackId as string;
    const [file] = await readAppStackSecretFiles(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId: otherId,
      masterKey: APP_TEST_MASTER_KEY,
      refs: [{ parameterKey: "db_password", version: 1 }],
    });
    expect(file!.content).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(file!.content).not.toBe(dbPassword);
  });

  it("deleting it without the data flag keeps the site and the database", async () => {
    const res = await h.call(h.a.token, "DELETE", stacksPath(`/${stackId}`), { confirmName: NAME, destroyData: false }, idem());
    expect(res.status, res.raw).toBe(202);
    await drain();
    expect((await stackRow()).status).toBe("deleted");
    expect((await h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId))).map((v) => [v.volumeKey, v.status]).sort()).toEqual([
      ["database", "retained"],
      ["site", "retained"],
    ]);
    expect(Object.keys(sim.appStacks.getAppStackSnapshot(stackId)?.volumes ?? {}).sort()).toEqual(["database", "site"]);
  }, 60_000);
});
