/**
 * An image of a registry on this server or on a private network (ADR-0036): a template version written now cannot name
 * one, a version stored before keeps working. The administrator still reads that version as valid; an application
 * installed from it deploys, restarts, stops and starts while its image is on the server, and the platform never
 * downloads it. Original template with an invented registry address.
 */
import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES } from "@hosting-panel/contracts";
import { appStackDeployments, appStacks, asc, createAppTemplate, eq, operationSteps, operations, resourceQuotas } from "@hosting-panel/database";
import { computeAppTemplateSpecHash } from "@hosting-panel/hosting-domain";
import { validateAppTemplateSource } from "@hosting-panel/policy-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE = "/v1/admin/app-templates";
/** The built-in storage job in the extended format, its two components on a registry at a private address. */
const PUBLIC_SOURCE = APP_BUILT_IN_TEMPLATES[1]!.source.replace("schemaVersion: 1", "schemaVersion: 2");
const PRIVATE_SOURCE = PUBLIC_SOURCE.replaceAll("image: valkey/valkey:", "image: 10.0.0.5:5000/valkey/valkey:");
const DIGEST = /@(sha256:[0-9a-f]{64})/.exec(PRIVATE_SOURCE)![1]!;
/** The image as the plan names it: repository and digest. */
const IMAGE = `10.0.0.5:5000/valkey/valkey@${DIGEST}`;
if (PRIVATE_SOURCE === PUBLIC_SOURCE || !PUBLIC_SOURCE.includes("schemaVersion: 2")) throw new Error("the template fixture did not change");

describe("an image of a registry on this server or a private network", () => {
  let h: AppStackHarness;
  let stored: { templateId: string; versionId: string };

  beforeAll(async () => {
    h = await startAppStackHarness();
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    // Written by an earlier release, before the rule: stored as it was, then published by the administrator.
    const checked = validateAppTemplateSource(PRIVATE_SOURCE);
    if (!checked.ok) throw new Error(`a stored version is not judged by the new rule: ${JSON.stringify(checked.errors)}`);
    const created = await createAppTemplate(h.dbClient.db, {
      slug: "private-storage",
      name: checked.spec.name,
      description: checked.spec.description,
      category: checked.spec.category,
      firstVersion: {
        source: PRIVATE_SOURCE,
        specVersion: checked.spec.schemaVersion,
        compiledSchema: checked.spec as unknown as Record<string, unknown>,
        specHash: computeAppTemplateSpecHash(checked.spec),
      },
      createdBy: null,
    });
    stored = { templateId: created.template.id, versionId: created.version.id };
    const enabled = await h.call(h.adminToken, "PATCH", `${BASE}/${stored.templateId}`, { enabled: true });
    expect(enabled.status, enabled.raw).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  const stacks = (tail = "") => `/v1/organizations/${h.a.orgId}/app-stacks${tail}`;
  const idem = () => ({ "Idempotency-Key": randomUUID() });
  const act = (stackId: string, verb: string) => h.call(h.a.token, "POST", stacks(`/${stackId}/${verb}`), {}, idem());
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = (stackId: string) => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId)).orderBy(asc(operations.submittedAt));
  const pulls = () => h.sim.appStacks.appStackMutations.filter((m) => m.kind === "pull").map((m) => m.name);

  async function drain(stackId: string): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
      await h.app.nestApp.get(OutboxWorkerService).processPendingOnce();
      if ((await opsOf(stackId)).every((o) => ["succeeded", "failed"].includes(o.status))) return;
    }
    throw new Error("the operation never settled");
  }

  async function install(name: string): Promise<string> {
    const created = await h.call(h.a.token, "POST", stacks(), { templateVersionId: stored.versionId, name, deploy: true }, idem());
    expect(created.status, created.raw).toBe(202);
    const stackId = created.body.data.stackId as string;
    await drain(stackId);
    return stackId;
  }

  /** The issues the administrator reads, as "path code reason", for both components. */
  const refusedImages = ["services.storage.image", "services.worker.image"].map((path) => `${path} IMAGE_REGISTRY_NOT_PUBLIC STACK_IMAGE_NOT_ALLOWED`);

  it("the check of a source written now refuses it, at its line, in the administrator's words", async () => {
    const res = await h.call(h.adminToken, "POST", `${BASE}/validate`, { source: PRIVATE_SOURCE });
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toMatchObject({ valid: false, preview: null });
    const issues = res.body.data.issues as Json[];
    expect(issues.map((i) => `${i.path} ${i.code} ${i.reason}`)).toEqual(refusedImages);
    expect(issues[0]).toMatchObject({
      line: 16,
      column: 12,
      message: "The registry of this image is this server, an IP address or a private network name: use an image of a public registry.",
    });
    const fine = await h.call(h.adminToken, "POST", `${BASE}/validate`, { source: PUBLIC_SOURCE });
    expect(fine.body.data).toMatchObject({ valid: true, issues: [] });
  });

  it("a new template or a new version with it is refused and nothing is stored", async () => {
    const before = await h.counts();
    const created = await h.call(h.adminToken, "POST", BASE, { slug: "private-new", source: PRIVATE_SOURCE });
    expect(created.status, created.raw).toBe(400);
    expect(created.body.error).toMatchObject({ code: "VALIDATION_ERROR", message: "The template is not valid." });
    const details = created.body.error.details as Json[];
    expect(details.filter((d) => /^line \d+, column \d+: IMAGE_REGISTRY_NOT_PUBLIC: /.test(d.message as string))).toHaveLength(2);
    expect(details.every((d) => d.reason === "STACK_IMAGE_NOT_ALLOWED")).toBe(true);

    const version = await h.call(h.adminToken, "POST", `${BASE}/${stored.templateId}/versions`, { source: PRIVATE_SOURCE.replace("memory: 128M", "memory: 96M") });
    expect(version.status, version.raw).toBe(400);
    expect((version.body.error.details as Json[]).map((d) => d.reason)).toEqual(["STACK_IMAGE_NOT_ALLOWED", "STACK_IMAGE_NOT_ALLOWED"]);
    expect(await h.counts()).toEqual(before);

    const fine = await h.call(h.adminToken, "POST", `${BASE}/${stored.templateId}/versions`, { source: PUBLIC_SOURCE });
    expect(fine.status, fine.raw).toBe(201);
  });

  it("the stored version still reads as valid on the template page", async () => {
    const res = await h.call(h.adminToken, "GET", `${BASE}/${stored.templateId}/versions/${stored.versionId}`);
    expect(res.status, res.raw).toBe(200);
    expect(res.body.data).toMatchObject({ id: stored.versionId, source: PRIVATE_SOURCE, valid: true, issues: [] });
    expect(res.body.data.preview).not.toBeNull();
  });

  it("an install whose image is not on the server fails at the download, before anything is created, and downloads nothing", async () => {
    const stackId = await install("private-missing");
    expect(await stackRow(stackId)).toMatchObject({ status: "failed" });
    const [op] = await opsOf(stackId);
    expect(op).toMatchObject({
      kind: "stack.deploy",
      status: "failed",
      errorCode: "DOCKER_ENGINE_UNAVAILABLE",
      errorMessage: "The server could not finish this action. Try again in a few minutes.",
    });
    const steps = await h.dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, op!.id));
    expect(steps.filter((s) => s.status === "failed").map((s) => s.key)).toEqual(["pull"]);
    const [deployment] = await h.dbClient.db.select().from(appStackDeployments).where(eq(appStackDeployments.stackId, stackId));
    expect(deployment).toMatchObject({ status: "failed", problem: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(h.sim.appStacks.getAppStackSnapshot(stackId)).toBeNull();
    expect(pulls()).not.toContain(IMAGE);
  });

  it("an install whose image is on the server deploys, restarts, stops and starts without a download", async () => {
    h.sim.appStacks.loadAppStackImage(IMAGE);
    const stackId = await install("private-local");
    expect((await stackRow(stackId)).status).toBe("running");

    expect((await act(stackId, "restart")).status).toBe(202);
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("running");
    expect((await act(stackId, "stop")).status).toBe(202);
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("stopped");
    expect((await act(stackId, "start")).status).toBe(202);
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("running");
    expect((await act(stackId, "deploy")).status).toBe(202);
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("running");

    expect((await opsOf(stackId)).map((o) => `${o.kind} ${o.status}`)).toEqual([
      "stack.deploy succeeded",
      "stack.restart succeeded",
      "stack.stop succeeded",
      "stack.start succeeded",
      "stack.deploy succeeded",
    ]);
    expect(pulls()).not.toContain(IMAGE);
  });
});
