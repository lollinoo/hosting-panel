import { APP_TEMPLATE_SPEC_VERSION, toAppStackPreview } from "@hosting-panel/contracts";
import {
  addAppTemplateVersion,
  appStacks,
  appTemplates,
  auditEvents,
  createAppTemplate,
  eq,
  hostAllocations,
  sql,
  updateAppTemplate,
  type HostingPanelDatabase,
} from "@hosting-panel/database";
import { computeAppTemplateSpecHash } from "@hosting-panel/hosting-domain";
import { compileAppStackPlan, validateAppTemplateSource } from "@hosting-panel/policy-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APP_TEST_ALLOWLIST,
  NOTES_DEMO_SOURCE,
  startAppStackHarness,
  type AppStackHarness,
  type HarnessCustomer,
} from "./fixtures/app-stack-harness.js";

const BASE = "/v1/admin/app-templates";
const IDS = { stackId: "stk_a", organizationId: "org_a", hostAllocationId: "alloc_a", templateVersionId: "atv_a", revisionId: "srev_a" };
const renamed = (name: string) => NOTES_DEMO_SOURCE.replace("name: Notes Demo", `name: ${name}`);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function auditRows(h: AppStackHarness, action: string) {
  return (await h.dbClient.db.select().from(auditEvents)).filter((row) => row.action === action);
}

async function deniedRows(h: AppStackHarness, userId: string): Promise<number> {
  const rows = await h.dbClient.db.select().from(auditEvents).where(eq(auditEvents.actorId, userId));
  return rows.filter((row) => (row.details as Json | null)?.outcome === "denied").length;
}

/** PGlite runs one transaction at a time: holding one parks both requests, so they then run in lockstep. */
async function sentTogether<T>(h: AppStackHarness, requests: readonly [() => Promise<T>, () => Promise<T>]): Promise<[T, T]> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const gate = h.dbClient.db.transaction(async () => held);
  const pending = [requests[0](), requests[1]()] as const;
  await new Promise((resolve) => setTimeout(resolve, 150));
  release();
  await gate;
  return Promise.all(pending);
}

/** A template stored by an earlier release whose allowlist had both images. */
async function storedTemplate(h: AppStackHarness, slug: string) {
  const checked = validateAppTemplateSource(NOTES_DEMO_SOURCE, { allowlist: APP_TEST_ALLOWLIST });
  if (!checked.ok) throw new Error("fixture does not validate");
  return createAppTemplate(h.dbClient.db, {
    slug,
    name: checked.spec.name,
    description: checked.spec.description,
    category: checked.spec.category,
    firstVersion: {
      source: NOTES_DEMO_SOURCE,
      specVersion: APP_TEMPLATE_SPEC_VERSION,
      compiledSchema: checked.spec as unknown as Record<string, unknown>,
      specHash: computeAppTemplateSpecHash(checked.spec),
    },
    createdBy: null,
  });
}

describe("application template catalogue", () => {
  let h: AppStackHarness;

  beforeEach(async () => {
    h = await startAppStackHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  const create = (source = NOTES_DEMO_SOURCE, slug = "notes-demo") => h.call(h.adminToken, "POST", BASE, { slug, source });
  const addVersion = (templateId: string, source: string, makeDefault?: boolean) =>
    h.call(h.adminToken, "POST", `${BASE}/${templateId}/versions`, { source, ...(makeDefault === undefined ? {} : { makeDefault }) });
  const patch = (templateId: string, body: unknown) => h.call(h.adminToken, "PATCH", `${BASE}/${templateId}`, body);

  it("A1: validates, stores an immutable disabled version 1 and previews it as the compiled plan", async () => {
    const compiled = compileAppStackPlan(
      { source: NOTES_DEMO_SOURCE, parameters: [], secretVersions: new Map([["app_secret", 1]]), ids: IDS },
      { allowlist: APP_TEST_ALLOWLIST },
    );
    if (!compiled.ok) throw new Error("fixture does not compile");
    const expected = toAppStackPreview(compiled.plan);

    const validated = await h.call(h.adminToken, "POST", `${BASE}/validate`, { source: NOTES_DEMO_SOURCE });
    expect(validated.status, validated.raw).toBe(200);
    expect(validated.body.data).toMatchObject({ valid: true, issues: [] });
    expect(validated.body.data.parameters.map((p: Json) => p.key)).toEqual(["worker_count", "app_secret"]);
    expect(validated.body.data.preview).toEqual(expected);

    const created = await create();
    expect(created.status, created.raw).toBe(201);
    const detail = created.body.data as Json;
    expect(detail).toMatchObject({
      slug: "notes-demo",
      name: "Notes Demo",
      category: "productivity",
      description: "Two components with private cache and HTTP ingress",
      builtIn: false,
      enabled: false,
      state: "draft",
      archivedAt: null,
      defaultVersionNumber: 1,
      installations: 0,
      componentCount: 2,
      hasIngress: true,
      hasVolumes: true,
    });
    expect(detail.versions).toHaveLength(1);
    expect(detail.versions[0]).toMatchObject({ id: detail.defaultVersionId, versionNumber: 1, installations: 0 });

    await expect(h.dbClient.db.execute(sql`UPDATE app_template_versions SET source = 'x'`)).rejects.toThrow();

    const version = await h.call(h.adminToken, "GET", `${BASE}/${detail.id as string}/versions/${detail.defaultVersionId as string}`);
    expect(version.status, version.raw).toBe(200);
    expect(version.body.data.source).toBe(NOTES_DEMO_SOURCE);
    expect(version.body.data).toMatchObject({ templateId: detail.id, versionNumber: 1, valid: true, issues: [], preview: expected });
    expect(version.body.data.specHash).toBe(detail.versions[0].specHash);

    const [audit] = await auditRows(h, "admin.app_template.create");
    expect(audit!.details).toMatchObject({ slug: "notes-demo", versionNumber: 1, specHash: detail.versions[0].specHash });
    expect(JSON.stringify(audit)).not.toContain("x-hp-stack");
    expect(JSON.stringify(audit)).not.toContain("registry.example.invalid");
  });

  it("A2: a customer gets 403 on every admin route, with one denied row each and nothing written", async () => {
    const created = await create();
    const templateId = created.body.data.id as string;
    const versionId = created.body.data.defaultVersionId as string;
    const collaborator = await h.addMember(h.a.orgId, "role_customer_collaborator");
    const routes: [string, string, unknown?][] = [
      ["GET", BASE],
      ["POST", `${BASE}/validate`, { source: NOTES_DEMO_SOURCE }],
      ["POST", `${BASE}/import-compose`, { compose: "services: {}" }],
      ["POST", BASE, { slug: "other-slug", source: NOTES_DEMO_SOURCE }],
      ["GET", `${BASE}/${templateId}`],
      ["PATCH", `${BASE}/${templateId}`, { enabled: true }],
      ["POST", `${BASE}/${templateId}/versions`, { source: renamed("Other") }],
      ["GET", `${BASE}/${templateId}/versions/${versionId}`],
      ["POST", `${BASE}/${templateId}/archive`, {}],
      ["GET", `${BASE}/${templateId}/usage`],
    ];
    const before = await h.counts();
    for (const actor of [h.a, collaborator, h.b] as HarnessCustomer[]) {
      for (const [method, path, body] of routes) {
        const res = await h.call(actor.token, method, path, body);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body.error.code).toBe("PERMISSION_DENIED");
      }
      expect(await deniedRows(h, actor.userId)).toBe(routes.length);
    }
    const malformed = await h.call(h.a.token, "POST", BASE, "{not json");
    expect(malformed.status).toBe(403);
    const after = await h.counts();
    expect({ ...after, audit_events: 0 }).toEqual({ ...before, audit_events: 0 });
    expect(after.audit_events).toBe(before.audit_events! + routes.length * 3 + 1);
  });

  it("A12: refuses resource limits out of range and unsupported limit keys, storing nothing", async () => {
    const before = await h.counts();
    const cases: [string, string][] = [
      ['cpus: "1.0"', 'cpus: "16.001"'],
      ["memory: 512M", "memory: 17G"],
      ["memory: 512M", "memory: 512M\n          pids: 100"],
    ];
    const codes = ["LIMIT_CPU_RANGE", "LIMIT_MEMORY_RANGE", "KEY_UNSUPPORTED"];
    for (const [index, [from, to]] of cases.entries()) {
      const res = await create(NOTES_DEMO_SOURCE.replace(from, to));
      expect(res.status, res.raw).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.message).toBe("The template is not valid.");
      const detail = (res.body.error.details as Json[]).find((d) => (d.message as string).includes(codes[index]!));
      expect(detail, res.raw).toBeDefined();
      expect(detail!.message).toMatch(/^line \d+, column \d+: [A-Z_]+: /);
      expect(detail!.reason).toBe(index === 2 ? "STACK_UNSUPPORTED_FEATURE" : "STACK_TEMPLATE_INVALID");
    }
    expect(await h.counts()).toEqual(before);
  });

  it("numbers concurrent versions in turn and stores an identical source once", async () => {
    const templateId = (await create()).body.data.id as string;
    const [first, second] = await sentTogether(h, [
      () => addVersion(templateId, renamed("Notes Two")),
      () => addVersion(templateId, renamed("Notes Three")),
    ]);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect([first.body.data.versionNumber, second.body.data.versionNumber].sort()).toEqual([2, 3]);

    const [again, repeat] = await sentTogether(h, [
      () => addVersion(templateId, renamed("Notes Four")),
      () => addVersion(templateId, renamed("Notes Four")),
    ]);
    expect([again.status, repeat.status]).toEqual([201, 201]);
    expect([again.body.data.created, repeat.body.data.created].sort()).toEqual([false, true]);
    expect(again.body.data.versionId).toBe(repeat.body.data.versionId);
    expect(repeat.body.data.template.versions).toHaveLength(4);
    expect(await auditRows(h, "admin.app_template.version")).toHaveLength(3);
  });

  it("publishes, changes the default version and audits publish apart from other changes", async () => {
    const templateId = (await create()).body.data.id as string;
    const draftDefault = await addVersion(templateId, renamed("Notes Two"), true);
    expect(draftDefault.status, draftDefault.raw).toBe(201);
    expect(draftDefault.body.data).toMatchObject({ versionNumber: 2, created: true, template: { defaultVersionNumber: 2, enabled: false } });
    expect(await auditRows(h, "admin.app_template.update")).toHaveLength(1);
    expect(await auditRows(h, "admin.app_template.publish")).toHaveLength(0);

    const published = await patch(templateId, { enabled: true, name: "Notes" });
    expect(published.status, published.raw).toBe(200);
    expect(published.body.data).toMatchObject({ enabled: true, state: "published", name: "Notes" });
    expect(await auditRows(h, "admin.app_template.publish")).toHaveLength(1);
    expect(await auditRows(h, "admin.app_template.update")).toHaveLength(2);

    const v3 = await addVersion(templateId, renamed("Notes Three"), true);
    expect(v3.body.data.template.defaultVersionNumber).toBe(3);
    const publishes = await auditRows(h, "admin.app_template.publish");
    expect(publishes).toHaveLength(2);
    expect(publishes.map((row) => (row.details as Json).versionNumber).sort()).toEqual([2, 3]);

    const v1 = (published.body.data.versions as Json[]).find((v) => v.versionNumber === 1)!;
    const back = await patch(templateId, { defaultVersionId: v1.id });
    expect(back.body.data.defaultVersionNumber).toBe(1);
    expect(await auditRows(h, "admin.app_template.publish")).toHaveLength(3);

    const same = await patch(templateId, { defaultVersionId: v1.id });
    expect(same.status).toBe(200);
    expect((await auditRows(h, "admin.app_template.publish")).length + (await auditRows(h, "admin.app_template.update")).length).toBe(5);

    const unknown = await patch(templateId, { defaultVersionId: "atv_000000000000000000000000" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details[0]).toMatchObject({ field: "defaultVersionId", reason: "unknown_version" });
    expect((await patch(templateId, {})).status).toBe(400);
  });

  it("checks the default as locked when concurrent changes publish it", async () => {
    const created = (await create()).body.data as Json;
    const templateId = created.id as string;
    const { version: bad } = await addAppTemplateVersion(h.dbClient.db as HostingPanelDatabase, {
      templateId,
      version: { source: NOTES_DEMO_SOURCE.replace('cpus: "1.0"', 'cpus: "16.001"'), specVersion: APP_TEMPLATE_SPEC_VERSION, compiledSchema: {}, specHash: "0".repeat(64) },
      createdBy: null,
    });
    const results = await sentTogether(h, [() => patch(templateId, { enabled: true }), () => patch(templateId, { defaultVersionId: bad.id })]);
    expect(results.map((res) => res.status).sort(), results.map((res) => res.raw).join("\n")).toEqual([200, 400]);
    expect(results.find((res) => res.status === 400)!.body.error.message).toBe("This version does not pass the current checks.");
    const detail = (await h.call(h.adminToken, "GET", `${BASE}/${templateId}`)).body.data as Json;
    expect(detail.enabled && detail.defaultVersionId === bad.id).toBe(false);
    for (const row of await auditRows(h, "admin.app_template.publish")) {
      expect(row.details).toMatchObject({ defaultVersionId: created.defaultVersionId, versionNumber: 1 });
    }
  });

  it("archives idempotently, refuses changes afterwards and refuses a built-in template", async () => {
    const templateId = (await create()).body.data.id as string;
    const archived = await h.call(h.adminToken, "POST", `${BASE}/${templateId}/archive`, {});
    expect(archived.status, archived.raw).toBe(200);
    expect(archived.body.data).toMatchObject({ state: "archived", enabled: false });
    expect(archived.body.data.archivedAt).not.toBeNull();
    const repeat = await h.call(h.adminToken, "POST", `${BASE}/${templateId}/archive`, {});
    expect(repeat.status).toBe(200);
    expect(await auditRows(h, "admin.app_template.archive")).toHaveLength(1);

    for (const res of [await patch(templateId, { enabled: true }), await addVersion(templateId, renamed("Late"))]) {
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.code).toBe("RESOURCE_LOCKED");
      expect(res.body.error.details[0].reason).toBe("template_archived");
    }

    const builtInId = (await create(NOTES_DEMO_SOURCE, "built-in")).body.data.id as string;
    await h.dbClient.db.update(appTemplates).set({ builtIn: true }).where(eq(appTemplates.id, builtInId));
    const refused = await h.call(h.adminToken, "POST", `${BASE}/${builtInId}/archive`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.details[0].reason).toBe("built_in");
    expect((await h.call(h.adminToken, "POST", `${BASE}/${builtInId}/archive`, { extra: 1 })).status).toBe(400);
    expect((await h.call(h.adminToken, "GET", `${BASE}/atpl_000000000000000000000000`)).status).toBe(404);
  });

  it("lists with state and category filters and cursor pagination", async () => {
    const draft = (await create(renamed("Alpha"), "alpha")).body.data.id as string;
    const published = (await h.publish(renamed("Beta"), "beta")).templateId;
    const archived = (await create(renamed("Gamma"), "gamma")).body.data.id as string;
    await h.call(h.adminToken, "POST", `${BASE}/${archived}/archive`, {});

    const all = await h.call(h.adminToken, "GET", BASE);
    expect(all.status, all.raw).toBe(200);
    expect(all.body.data.map((t: Json) => t.id)).toEqual([draft, published, archived]);
    expect(all.body.meta.total).toBe(3);
    expect(all.body.page).toEqual({ nextCursor: null, hasMore: false });

    const ids = async (query: string) => ((await h.call(h.adminToken, "GET", `${BASE}?${query}`)).body.data as Json[]).map((t) => t.id);
    expect(await ids("state=published")).toEqual([published]);
    expect(await ids("state=draft")).toEqual([draft]);
    expect(await ids("state=archived&category=productivity")).toEqual([archived]);
    expect(await ids("category=games")).toEqual([]);

    const first = await h.call(h.adminToken, "GET", `${BASE}?limit=2`);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.page.hasMore).toBe(true);
    const next = await h.call(h.adminToken, "GET", `${BASE}?limit=2&cursor=${first.body.page.nextCursor as string}`);
    expect(next.body.data.map((t: Json) => t.id)).toEqual([archived]);
    const unknownCursor = await h.call(h.adminToken, "GET", `${BASE}?cursor=atpl_unknown`);
    expect(unknownCursor.status).toBe(200);
    expect(unknownCursor.body.data).toEqual([]);

    for (const query of ["state=bogus", "sort=name", "category=Bad_Category"]) {
      expect((await h.call(h.adminToken, "GET", `${BASE}?${query}`)).status, query).toBe(400);
    }
  });

  it("shows usage across two organisations, without deleted stacks", async () => {
    const { templateId, versionId } = await h.publish();
    const allocationOf = async (orgId: string) =>
      (await h.dbClient.db.select().from(hostAllocations).where(eq(hostAllocations.organizationId, orgId)))[0]!.id;
    const stack = async (id: string, customer: HarnessCustomer, name: string, deletedAt: Date | null = null) =>
      h.dbClient.db.insert(appStacks).values({
        id,
        organizationId: customer.orgId,
        hostAllocationId: await allocationOf(customer.orgId),
        templateId,
        templateVersionId: versionId,
        name,
        status: deletedAt === null ? "running" : "deleted",
        deletedAt,
      });
    await stack("stk_a2", h.a, "Wiki");
    await stack("stk_a1", h.a, "Notes");
    await stack("stk_b1", h.b, "Shop");
    await stack("stk_b2", h.b, "Gone", new Date());

    const usage = await h.call(h.adminToken, "GET", `${BASE}/${templateId}/usage`);
    expect(usage.status, usage.raw).toBe(200);
    expect(usage.body.data).toEqual({
      templateId,
      truncated: false,
      stacks: [
        { id: "stk_b1", name: "Shop", organizationId: h.b.orgId, organizationName: "Bar Luigi", versionNumber: 1, status: "running" },
        { id: "stk_a1", name: "Notes", organizationId: h.a.orgId, organizationName: "Hotel Mario", versionNumber: 1, status: "running" },
        { id: "stk_a2", name: "Wiki", organizationId: h.a.orgId, organizationName: "Hotel Mario", versionNumber: 1, status: "running" },
      ],
    });
    const detail = await h.call(h.adminToken, "GET", `${BASE}/${templateId}`);
    expect(detail.body.data.installations).toBe(3);
    expect(detail.body.data.versions[0].installations).toBe(3);
    expect((await h.call(h.adminToken, "GET", BASE)).body.data[0].installations).toBe(3);
    expect((await h.call(h.adminToken, "GET", `${BASE}/atpl_000000000000000000000000/usage`)).status).toBe(404);
  });

  it("offers customers only published templates, with customer fields only", async () => {
    const { templateId, versionId } = await h.publish(renamed("Beta"), "beta");
    const draft = (await create(renamed("Alpha"), "alpha")).body.data.id as string;
    const archived = (await h.publish(renamed("Gamma"), "gamma")).templateId;
    await h.call(h.adminToken, "POST", `${BASE}/${archived}/archive`, {});
    const catalogue = `/v1/organizations/${h.a.orgId}/app-templates`;

    const list = await h.call(h.a.token, "GET", catalogue);
    expect(list.status, list.raw).toBe(200);
    const summary = {
      id: templateId,
      name: "Beta",
      description: "Two components with private cache and HTTP ingress",
      category: "productivity",
      versionId,
      versionNumber: 1,
      componentCount: 2,
      cpuMilli: 1500,
      memoryBytes: "805306368",
      volumeCount: 1,
      hasIngress: true,
    };
    expect(list.body.data).toEqual({ templates: [summary], categories: ["productivity"] });

    const detail = await h.call(h.a.token, "GET", `${catalogue}/${templateId}`);
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.body.data).toMatchObject({
      ...summary,
      ingress: [{ componentKey: "app", port: 8080 }],
      components: [
        { key: "app", cpuMilli: 1000, memoryBytes: "536870912" },
        { key: "cache", cpuMilli: 500, memoryBytes: "268435456" },
      ],
    });
    expect(detail.body.data.parameters.map((p: Json) => p.key)).toEqual(["worker_count", "app_secret"]);
    expect(detail.raw).not.toContain("registry.example.invalid");
    expect(detail.raw).not.toContain("x-hp-stack");

    for (const id of [draft, archived, "atpl_000000000000000000000000"]) {
      const res = await h.call(h.a.token, "GET", `${catalogue}/${id}`);
      expect(res.status, id).toBe(404);
      expect(res.body.error.message).toBe("Requested organization or resource was not found.");
    }
    const collaborator = await h.addMember(h.a.orgId, "role_customer_collaborator");
    expect((await h.call(collaborator.token, "GET", catalogue)).status).toBe(403);
    expect((await h.call(h.b.token, "GET", catalogue)).status).toBe(404);
    expect((await h.call(null, "GET", catalogue)).status).toBe(401);
  });
});

describe("application templates under a stricter image allowlist", () => {
  let h: AppStackHarness;

  beforeEach(async () => {
    h = await startAppStackHarness({ allowlist: APP_TEST_ALLOWLIST.filter((row) => !row.repository.endsWith("/cache")) });
  });

  afterEach(async () => {
    await h.close();
  });

  it("refuses to publish a stored version today's checks refuse, and shows it invalid", async () => {
    const { template, version } = await storedTemplate(h, "old-notes");
    const res = await h.call(h.adminToken, "PATCH", `${BASE}/${template.id}`, { enabled: true });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error.message).toBe("This version does not pass the current checks.");
    expect(res.body.error.details[0].message).toMatch(/^line \d+, column \d+: IMAGE_NOT_ALLOWLISTED: /);
    expect((await h.call(h.adminToken, "GET", `${BASE}/${template.id}`)).body.data.enabled).toBe(false);
    expect(await auditRows(h, "admin.app_template.publish")).toHaveLength(0);

    const shown = await h.call(h.adminToken, "GET", `${BASE}/${template.id}/versions/${version.id}`);
    expect(shown.status).toBe(200);
    expect(shown.body.data).toMatchObject({ valid: false, parameters: [], preview: null, source: NOTES_DEMO_SOURCE });
    expect(shown.body.data.issues[0].code).toBe("IMAGE_NOT_ALLOWLISTED");
  });

  it("refuses enabling an archived template as archived before checking its default", async () => {
    const { template } = await storedTemplate(h, "old-notes");
    expect((await h.call(h.adminToken, "POST", `${BASE}/${template.id}/archive`, {})).status).toBe(200);
    const res = await h.call(h.adminToken, "PATCH", `${BASE}/${template.id}`, { enabled: true });
    expect(res.status, res.raw).toBe(409);
    expect(res.body.error.details[0].reason).toBe("template_archived");
  });

  it("leaves a published template whose source no longer validates out of the customer catalogue", async () => {
    const { template } = await storedTemplate(h, "old-notes");
    await updateAppTemplate(h.dbClient.db as HostingPanelDatabase, { templateId: template.id, enabled: true });
    const catalogue = `/v1/organizations/${h.a.orgId}/app-templates`;
    expect((await h.call(h.a.token, "GET", catalogue)).body.data).toEqual({ templates: [], categories: [] });
    expect((await h.call(h.a.token, "GET", `${catalogue}/${template.id}`)).status).toBe(404);
  });
});

describe("application templates while the capability flags are off", () => {
  let h: AppStackHarness;

  beforeEach(async () => {
    h = await startAppStackHarness({ appFeatures: {} });
  });

  afterEach(async () => {
    await h.close();
  });

  it("answers 422 STACK_UNSUPPORTED_FEATURE on every route and writes nothing", async () => {
    const id = "atpl_000000000000000000000000";
    const catalogue = `/v1/organizations/${h.a.orgId}/app-templates`;
    const routes: [string, string, string, unknown?][] = [
      [h.adminToken, "GET", BASE],
      [h.adminToken, "POST", `${BASE}/validate`, { source: NOTES_DEMO_SOURCE }],
      [h.adminToken, "POST", `${BASE}/import-compose`, { compose: "services: {}" }],
      [h.adminToken, "POST", BASE, { slug: "notes-demo", source: NOTES_DEMO_SOURCE }],
      [h.adminToken, "GET", `${BASE}/${id}`],
      [h.adminToken, "PATCH", `${BASE}/${id}`, { enabled: true }],
      [h.adminToken, "POST", `${BASE}/${id}/versions`, { source: NOTES_DEMO_SOURCE }],
      [h.adminToken, "GET", `${BASE}/${id}/versions/atv_000000000000000000000000`],
      [h.adminToken, "POST", `${BASE}/${id}/archive`, {}],
      [h.adminToken, "GET", `${BASE}/${id}/usage`],
      [h.adminToken, "GET", "/v1/admin/app-stacks"],
      [h.a.token, "GET", catalogue],
      [h.a.token, "GET", `${catalogue}/${id}`],
    ];
    const before = await h.counts();
    for (const [token, method, path, body] of routes) {
      const res = await h.call(token, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(422);
      expect(res.body.error).toMatchObject({ code: "NOT_SUPPORTED", details: [{ reason: "STACK_UNSUPPORTED_FEATURE" }] });
    }
    expect(await h.counts()).toEqual(before);
  });
});
