import { createHash, randomUUID } from "node:crypto";
import { ComposeImportDtoSchema, CustomerAppTemplateDtoSchema, type ComposeImportDto } from "@hosting-panel/contracts";
import { appStackComponents, appStacks, eq, operations, readAppStackSecretFiles } from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_MASTER_KEY, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";
import {
  LITERAL_SECRETS,
  LITERAL_SECRETS_COMPOSE,
  PINNED_COMPOSE,
  WORDPRESS_COMPOSE,
  WORDPRESS_COMPOSE_IMAGES,
} from "./fixtures/compose-files.js";

const ROUTE = "/v1/admin/app-templates/import-compose";
const LOOKUP_FAILED = "The server could not look up the images of the file right now. Try again in a few minutes.";
/** The simulated registry's answer for a reference. */
const digestOf = (image: string): string => `sha256:${createHash("sha256").update(image).digest("hex")}`;
const spellings = (value: string): string[] => [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex")];

describe("POST /v1/admin/app-templates/import-compose: a Compose file read into a draft template (ADR-0036 §2.8)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let draft = "";

  beforeAll(async () => {
    // The default harness allowlist names none of the images of these files: a version 2 template needs no allowlist row.
    h = await startAppStackHarness();
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    // The DNS pass is not under test here: a domain write must not look anything up.
    vi.spyOn(h.app.nestApp.get(AppStackObserverService), "reconcileStack").mockResolvedValue(undefined);
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.close();
  }, 60_000);

  const lookups = (): readonly string[] => sim.appStacks.appStackImageLookups;
  const importFile = (body: unknown, token: string | null = h.adminToken) => h.call(token, "POST", ROUTE, body);
  const notes = (dto: ComposeImportDto, level: string): string[] => dto.report.filter((note) => note.level === level).map((note) => note.code);

  it("reads WordPress with MariaDB into a draft the validator accepts, asking each image's digest once and storing nothing", async () => {
    const before = await h.counts();
    const asked = lookups().length;

    const res = await importFile({ compose: WORDPRESS_COMPOSE });
    expect(res.status, res.raw).toBe(200);
    const dto = ComposeImportDtoSchema.parse(res.body.data);

    expect(lookups().slice(asked)).toEqual(WORDPRESS_COMPOSE_IMAGES);
    expect(notes(dto, "refused")).toEqual([]);
    expect(notes(dto, "changed").filter((code) => code === "IMAGE_PINNED")).toHaveLength(2);
    expect(notes(dto, "dropped")).toEqual(expect.arrayContaining(["PORTS_DROPPED", "ENV_URL_VARIABLE_DROPPED"]));
    expect(dto.source).toContain("schemaVersion: 2");
    expect(dto.source).toContain('name: "WordPress"');
    expect(dto.source).toContain('category: "cms"');

    // The verdict is the one POST validate gives for the same source.
    expect(dto.validation).toMatchObject({ valid: true, issues: [] });
    const again = await h.call(h.adminToken, "POST", "/v1/admin/app-templates/validate", { source: dto.source });
    expect(again.body.data).toEqual(res.body.data.validation);

    // Nobody types a password: the three secrets are generated, and none belongs to the customer.
    expect(dto.validation!.parameters.filter((p) => p.type === "secret")).toEqual([
      expect.objectContaining({ key: "user_wordpress", customer: false, generate: { kind: "user", length: 16 } }),
      expect.objectContaining({ key: "password_wordpress", customer: false, generate: { kind: "password", length: 32 } }),
      expect.objectContaining({ key: "password_root", customer: false, generate: { kind: "password", length: 32 } }),
    ]);
    const components = dto.validation!.preview!.components;
    expect(components.map((c) => [c.key, c.profile])).toEqual([
      ["mariadb", "standard"],
      ["wordpress", "standard"],
    ]);
    expect(components.find((c) => c.key === "wordpress")!.secretEnvironment!.map((entry) => entry.name).sort()).toEqual([
      "WORDPRESS_DB_PASSWORD",
      "WORDPRESS_DB_USER",
    ]);
    expect(dto.validation!.preview!.ingress).toEqual([expect.objectContaining({ componentKey: "wordpress", port: 80 })]);

    expect(await h.counts()).toEqual(before);
    draft = dto.source!;
  });

  it("the draft is what the administrator publishes; the customer installs it with a domain and no password", async () => {
    const { templateId, versionId } = await h.publish(draft, "wordpress-importato");

    const detail = await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-templates/${templateId}`);
    expect(detail.status, detail.raw).toBe(200);
    expect(CustomerAppTemplateDtoSchema.parse(detail.body.data).parameters).toEqual([]);
    for (const word of ["password_wordpress", "password_root", "user_wordpress", '"generate"', "sha256:"]) {
      expect(detail.raw.includes(word), word).toBe(false);
    }

    const hostname = `${randomUUID().slice(0, 8)}.example.test`;
    const created = await h.call(
      h.a.token,
      "POST",
      `/v1/organizations/${h.a.orgId}/app-stacks`,
      { templateVersionId: versionId, name: "Il blog importato", deploy: true, domains: [{ hostname, componentKey: "wordpress", port: 80 }] },
      { "Idempotency-Key": randomUUID() },
    );
    expect(created.status, created.raw).toBe(202);
    const stackId = created.body.data.stackId as string;
    const worker = h.app.nestApp.get(OutboxWorkerService);
    const opsOf = () => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
    for (let round = 0; round < 12; round += 1) {
      await worker.processPendingOnce();
      if ((await opsOf()).every((o) => !["queued", "running", "processing"].includes(o.status))) break;
    }

    expect((await opsOf())[0]).toMatchObject({ kind: "stack.deploy", status: "succeeded", errorCode: null });
    expect((await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!.status).toBe("running");
    const health = await h.dbClient.db.select().from(appStackComponents).where(eq(appStackComponents.stackId, stackId));
    expect(Object.fromEntries(health.map((c) => [c.componentKey, c.health]))).toEqual({ mariadb: "healthy", wordpress: "healthy" });

    const files = await readAppStackSecretFiles(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId,
      masterKey: APP_TEST_MASTER_KEY,
      refs: ["user_wordpress", "password_wordpress", "password_root"].map((parameterKey) => ({ parameterKey, version: 1 })),
    });
    const [user, password, root] = files.map((file) => file.content) as [string, string, string];
    expect(user).toMatch(/^[a-z][a-z0-9]{15}$/);
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(root).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(password).not.toBe(root);

    // Both containers run the image at the digest the import resolved, and share the generated account.
    const containers = sim.appStacks.getAppStackSnapshot(stackId)!.containers;
    const payloadOf = (key: string) => containers[key]!.payload as unknown as { Image: string; Env: readonly string[] };
    const [wordpressImage, mariadbImage] = WORDPRESS_COMPOSE_IMAGES as [string, string];
    expect(draft).toContain(`image: "${wordpressImage}@${digestOf(wordpressImage)}"`);
    expect(draft).toContain(`image: "${mariadbImage}@${digestOf(mariadbImage)}"`);
    expect(payloadOf("wordpress").Image).toBe(`wordpress@${digestOf(wordpressImage)}`);
    expect(payloadOf("mariadb").Image).toBe(`mariadb@${digestOf(mariadbImage)}`);
    expect([...payloadOf("wordpress").Env].sort()).toEqual(
      [
        "WORDPRESS_DB_HOST=mariadb",
        "WORDPRESS_DB_NAME=wordpress",
        "WORDPRESS_TABLE_PREFIX=wp_",
        `WORDPRESS_DB_USER=${user}`,
        `WORDPRESS_DB_PASSWORD=${password}`,
      ].sort(),
    );
    expect([...payloadOf("mariadb").Env].sort()).toEqual(
      ["MARIADB_DATABASE=wordpress", `MARIADB_USER=${user}`, `MARIADB_PASSWORD=${password}`, `MARIADB_ROOT_PASSWORD=${root}`].sort(),
    );
  }, 60_000);

  it("takes the name and the category of the request over the header of the file", async () => {
    const res = await importFile({ compose: WORDPRESS_COMPOSE, name: "  Il sito del bar  ", category: "content" });
    expect(res.status, res.raw).toBe(200);
    const dto = ComposeImportDtoSchema.parse(res.body.data);
    expect(dto.source).toContain('name: "Il sito del bar"');
    expect(dto.source).toContain('category: "content"');
    expect(dto.validation).toMatchObject({ valid: true });
  });

  it("asks nothing of the Engine for a file whose image carries its digest", async () => {
    const asked = lookups().length;
    const res = await importFile({ compose: PINNED_COMPOSE });
    expect(res.status, res.raw).toBe(200);
    const dto = ComposeImportDtoSchema.parse(res.body.data);
    expect(lookups().length).toBe(asked);
    expect(notes(dto, "info")).toContain("IMAGE_DIGEST_KEPT");
    expect(dto.validation).toMatchObject({ valid: true });
  });

  it("gives no draft for an image its registry does not know, and names it in the report", async () => {
    const before = await h.counts();
    sim.appStacks.failNextAppStackStep("resolve", "pull_failed");
    const res = await importFile({ compose: WORDPRESS_COMPOSE });
    expect(res.status, res.raw).toBe(200);
    const dto = ComposeImportDtoSchema.parse(res.body.data);
    expect(dto.source).toBeNull();
    expect(dto.validation).toBeNull();
    expect(dto.report.filter((note) => note.level === "refused")).toEqual([
      expect.objectContaining({ code: "IMAGE_UNRESOLVED", path: "services.wordpress.image" }),
    ]);
    expect(res.raw).not.toContain("Could not find the software");
    expect(await h.counts()).toEqual(before);
  });

  it("fails as retryable, with a fixed text, when the Engine cannot be asked", async () => {
    for (const fault of ["engine_unavailable", "ambiguous_before"] as const) {
      sim.appStacks.failNextAppStackStep("resolve", fault);
      const res = await importFile({ compose: WORDPRESS_COMPOSE });
      expect(res.status, `${fault}: ${res.raw}`).toBe(503);
      expect(res.body.error, fault).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: LOOKUP_FAILED, retryable: true });
      expect(res.raw.includes("Simulated"), fault).toBe(false);
    }
  });

  it("never returns a secret the file writes in the clear, in the draft, the report or the verdict", async () => {
    const res = await importFile({ compose: LITERAL_SECRETS_COMPOSE });
    expect(res.status, res.raw).toBe(200);
    const dto = ComposeImportDtoSchema.parse(res.body.data);
    expect(dto.validation).toMatchObject({ valid: true });
    expect(notes(dto, "changed")).toEqual(expect.arrayContaining(["SECRET_GENERATED", "SECRET_EXTRACTED"]));
    for (const value of LITERAL_SECRETS) for (const form of spellings(value)) expect(res.raw.includes(form), value).toBe(false);
  });

  it("refuses a malformed body with 400, before any lookup", async () => {
    const asked = lookups().length;
    const before = await h.counts();
    const bodies: [string, unknown][] = [
      ["no body", undefined],
      ["empty object", {}],
      ["empty file", { compose: "" }],
      ["a file that is no text", { compose: 5 }],
      ["an unknown key", { compose: WORDPRESS_COMPOSE, slug: "wordpress" }],
      ["a name with a control character", { compose: WORDPRESS_COMPOSE, name: "Word\u0007Press" }],
      ["a name that is too long", { compose: WORDPRESS_COMPOSE, name: "n".repeat(81) }],
      ["a category that is no slug", { compose: WORDPRESS_COMPOSE, category: "Web Sites" }],
      ["a file one byte over 64 KiB", { compose: `${WORDPRESS_COMPOSE}#${"x".repeat(65_536 - Buffer.byteLength(WORDPRESS_COMPOSE))}` }],
      ["a file over 64 KiB only in bytes", { compose: `${WORDPRESS_COMPOSE}#${"è".repeat(33_000)}` }],
      ["malformed JSON", "{not json"],
    ];
    for (const [name, body] of bodies) {
      const res = await importFile(body);
      expect(res.status, `${name}: ${res.raw}`).toBe(400);
      expect(res.body.error.code, name).toBe("VALIDATION_ERROR");
    }
    expect(lookups().length).toBe(asked);
    expect(await h.counts()).toEqual(before);
  });

  it("accepts a file of exactly 64 KiB", async () => {
    const compose = `${PINNED_COMPOSE}#${"x".repeat(65_536 - Buffer.byteLength(PINNED_COMPOSE) - 1)}`;
    expect(Buffer.byteLength(compose)).toBe(65_536);
    const res = await importFile({ compose });
    expect(res.status, res.raw).toBe(200);
    expect(ComposeImportDtoSchema.parse(res.body.data).source).not.toBeNull();
  });

  it("is the server administrator's alone: 401 without a session, 403 for a customer, with nothing looked up", async () => {
    const asked = lookups().length;
    expect((await importFile({ compose: WORDPRESS_COMPOSE }, null)).status).toBe(401);
    const res = await importFile({ compose: WORDPRESS_COMPOSE }, h.a.token);
    expect(res.status, res.raw).toBe(403);
    expect(res.body.error.code).toBe("PERMISSION_DENIED");
    // A customer learns nothing from the shape of the body either: the refusal comes first.
    expect((await importFile({ nothing: true }, h.a.token)).status).toBe(403);
    expect(lookups().length).toBe(asked);
  });
});

describe("POST /v1/admin/app-templates/import-compose while application templates are off", () => {
  it("answers 422 STACK_UNSUPPORTED_FEATURE and looks nothing up", async () => {
    const h = await startAppStackHarness({ appFeatures: {} });
    try {
      const sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
      const res = await h.call(h.adminToken, "POST", ROUTE, { compose: WORDPRESS_COMPOSE });
      expect(res.status, res.raw).toBe(422);
      expect(res.body.error).toMatchObject({ code: "NOT_SUPPORTED", details: [{ reason: "STACK_UNSUPPORTED_FEATURE" }] });
      expect(sim.appStacks.appStackImageLookups).toEqual([]);
    } finally {
      await h.close();
    }
  }, 120_000);
});
