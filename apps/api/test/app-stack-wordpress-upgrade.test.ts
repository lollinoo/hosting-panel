/**
 * Version 2 of the built-in «WordPress in contenitore» (ADR-0036) reaching an installation that already runs version 1:
 * the next start of the API adds it as the default, the customer is offered it, the review names the one component that
 * changes and asks for nothing, and the upgrade keeps the generated passwords. On the simulator; that the real image
 * follows its address and takes larger uploads is proven on a real Engine (infra/linux/accept-app-stack-wordpress.mjs).
 */
import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, AppStackDetailDtoSchema, AppStackPlanDiffDtoSchema } from "@hosting-panel/contracts";
import {
  appStackSecrets,
  appStacks,
  appTemplates,
  appTemplateVersions,
  asc,
  builtInAppTemplateItems,
  ensureBuiltInAppTemplates,
  eq,
  operations,
  readAppStackSecretFiles,
  type BuiltInAppTemplateItem,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_MASTER_KEY, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

interface Payload {
  readonly Cmd?: readonly string[];
  readonly Env: readonly string[];
}

const WORDPRESS = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === "wordpress-mariadb")!;
const V1 = "atv_wordpress_mariadb_1";
const V2 = "atv_wordpress_mariadb_2";
const UPLOADS_ARGV = ["apache2-foreground", "-c", "php_value upload_max_filesize 64M", "-c", "php_value post_max_size 64M"];

/** The seed as the release before version 2 shipped it: version 1 the newest and the default. */
function seededBeforeVersion2(): readonly BuiltInAppTemplateItem[] {
  return builtInAppTemplateItems().map((item) => {
    if (item.slug !== "wordpress-mariadb") return item;
    const first = item.previousVersions![0]!;
    return { ...item, versionId: first.versionId, description: first.description, version: first.version, previousVersions: [] };
  });
}

describe("WordPress version 1 upgraded to version 2 of the built-in (ADR-0036)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let stackId = "";
  let dbPassword = "";
  let planHash = "";
  const hostname = `${randomUUID().slice(0, 8)}.example.test`;

  beforeAll(async () => {
    h = await startAppStackHarness();
    // The harness injects its database client, and an app given one skips its boot seeding: run what an older boot ran.
    await ensureBuiltInAppTemplates(h.dbClient.db, seededBeforeVersion2());
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
  const opsOf = () => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
  const payloadOf = (component: string) => sim.appStacks.getAppStackSnapshot(stackId)!.containers[component]!.payload as unknown as Payload;
  const detail = async () => {
    const res = await h.call(h.a.token, "GET", stacksPath(`/${stackId}`));
    expect(res.status, res.raw).toBe(200);
    return AppStackDetailDtoSchema.parse(res.body.data);
  };
  const versions = () =>
    h.dbClient.db.select().from(appTemplateVersions).where(eq(appTemplateVersions.templateId, WORDPRESS.templateId)).orderBy(asc(appTemplateVersions.versionNumber));
  const template = async () => (await h.dbClient.db.select().from(appTemplates).where(eq(appTemplates.id, WORDPRESS.templateId)))[0]!;

  async function drain(): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
      await h.app.nestApp.get(OutboxWorkerService).processPendingOnce();
      const open = (await opsOf()).filter((o) => ["queued", "running", "processing"].includes(o.status));
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  it("a customer installs version 1 while it is the default: no command and no address line", async () => {
    const enabled = await h.call(h.adminToken, "PATCH", `/v1/admin/app-templates/${WORDPRESS.templateId}`, { enabled: true });
    expect(enabled.status, enabled.raw).toBe(200);
    const created = await h.call(
      h.a.token,
      "POST",
      stacksPath(),
      { templateVersionId: V1, name: "Il blog", deploy: true, domains: [{ hostname, componentKey: "wordpress", port: 80 }] },
      idem(),
    );
    expect(created.status, created.raw).toBe(202);
    stackId = created.body.data.stackId as string;
    await drain();
    expect((await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]).toMatchObject({ status: "running", templateVersionId: V1 });
    expect(payloadOf("wordpress").Cmd).toBeUndefined();
    expect(payloadOf("wordpress").Env.some((entry) => entry.startsWith("WORDPRESS_CONFIG_EXTRA="))).toBe(false);
    expect((await detail()).upgrade).toBeNull();
    const [file] = await readAppStackSecretFiles(h.dbClient.db, {
      organizationId: h.a.orgId,
      stackId,
      masterKey: APP_TEST_MASTER_KEY,
      refs: [{ parameterKey: "db_password", version: 1 }],
    });
    dbPassword = file!.content;
  }, 60_000);

  it("the next start adds version 2 as the default, leaving version 1 as it was, and the customer is offered it", async () => {
    const [before] = await versions();
    await ensureBuiltInAppTemplates(h.dbClient.db, builtInAppTemplateItems());
    const after = await versions();
    expect(after.map((v) => [v.id, v.versionNumber])).toEqual([
      [V1, 1],
      [V2, 2],
    ]);
    expect(after[0]).toEqual(before);
    expect(await template()).toMatchObject({ defaultVersionId: V2, enabled: true, description: WORDPRESS.description });
    expect((await detail()).upgrade).toEqual({ templateVersionId: V2, versionNumber: 2 });
  });

  it("the review changes only the WordPress component, which restarts; it asks for no value and touches no data area", async () => {
    const res = await h.call(h.a.token, "POST", stacksPath(`/${stackId}/plan`), { templateVersionId: V2 });
    expect(res.status, res.raw).toBe(200);
    const diff = AppStackPlanDiffDtoSchema.parse(res.body.data);
    expect(diff).toMatchObject({ fromVersionNumber: 1, toTemplateVersionId: V2, toVersionNumber: 2, newRevision: true });
    expect(diff.components).toEqual([
      { key: "db", change: "unchanged", restart: false },
      { key: "wordpress", change: "updated", restart: true },
    ]);
    expect(diff.volumes).toEqual([
      { key: "database", change: "unchanged" },
      { key: "site", change: "unchanged" },
    ]);
    expect(diff.parameters).toEqual([]);
    expect(diff.ingress).toEqual([{ componentKey: "wordpress", port: 80, change: "unchanged" }]);
    for (const word of ["db_password", "db_root_password", "WORDPRESS_CONFIG_EXTRA"]) expect(res.raw.includes(word), word).toBe(false);
    planHash = diff.planHash;
  });

  it("the upgrade runs WordPress with the address line and the uploads limit, on the same passwords", async () => {
    const res = await h.call(h.a.token, "POST", stacksPath(`/${stackId}/upgrade`), { templateVersionId: V2, planHash }, idem());
    expect(res.status, res.raw).toBe(202);
    await drain();
    expect((await opsOf()).find((o) => o.kind === "stack.upgrade")).toMatchObject({ status: "succeeded", errorCode: null });
    expect((await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]).toMatchObject({ status: "running", templateVersionId: V2 });
    expect(payloadOf("wordpress").Cmd).toEqual(UPLOADS_ARGV);
    expect(payloadOf("wordpress").Env.filter((entry) => entry.startsWith("WORDPRESS_CONFIG_EXTRA="))).toHaveLength(1);
    expect(payloadOf("wordpress").Env).toContain(`WORDPRESS_DB_PASSWORD=${dbPassword}`);
    expect(payloadOf("db").Env).toContain(`MARIADB_PASSWORD=${dbPassword}`);
    const secrets = await h.dbClient.db
      .select()
      .from(appStackSecrets)
      .where(eq(appStackSecrets.stackId, stackId))
      .orderBy(asc(appStackSecrets.parameterKey), asc(appStackSecrets.version));
    expect(secrets.map((row) => [row.parameterKey, row.version])).toEqual([
      ["db_password", 1],
      ["db_root_password", 1],
    ]);
    const after = await detail();
    expect(after.upgrade).toBeNull();
    expect(after.rollback).toMatchObject({ revisionNumber: 1, templateVersionNumber: 1 });
  }, 60_000);
});
