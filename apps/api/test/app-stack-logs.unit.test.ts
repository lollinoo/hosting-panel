import { randomBytes } from "node:crypto";
import { ApprovedStackPlanSchema, type AppStackPlanComponent } from "@hosting-panel/contracts";
import {
  appStackComponents,
  appStackRevisions,
  appStacks,
  builtInAppTemplateItems,
  createDatabaseClient,
  DEMO_IDS,
  ensureBuiltInAppTemplates,
  eq,
  newAppEntityId,
  seedPhase1Dataset,
  type DatabaseClient,
} from "@hosting-panel/database";
import { Phase1DisabledDockerExecutor, type ServiceLogLine } from "@hosting-panel/executor-contracts";
import { computeAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readAppStackComponentLogs, type AppStackLogsDeps } from "../src/app-stacks/app-stack-logs.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { LogReadGate } from "../src/sites/log-read-gate.js";
import { ManagedSitesService } from "../src/sites/managed-sites.service.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { FakeStackExecutor } from "./support/fake-stack-executor.js";

// RT8: customer log reads of one stack component, on PGlite with the scripted fake executor.

const ACME = DEMO_IDS.organizations.acme;
const BETA = DEMO_IDS.organizations.beta;
const NOT_FOUND = "Requested organization or resource was not found.";
const UNAVAILABLE = "The logs are not available right now. Try again in a few minutes.";

describe("readAppStackComponentLogs (RT8)", () => {
  let dbClient: DatabaseClient;
  let fake: ReturnType<typeof FakeStackExecutor.create>;
  const acmeStack = newAppEntityId("stk");
  const betaStack = newAppEntityId("stk");
  const config: ControlPlaneRuntimeConfig = {
    oidcIssuer: "https://issuer.local",
    oidcAudience: "hosting-panel-api",
    enableDevOidc: true,
    runtimeBackend: "local-simulator",
    secretsMasterKey: randomBytes(32),
    jwtSigningKeyPem: null,
    autoProcessOutbox: false,
  };
  const deps = (patch: Partial<AppStackLogsDeps> = {}): AppStackLogsDeps => ({
    db: dbClient.db,
    executor: fake,
    config,
    gate: new LogReadGate(),
    ...patch,
  });
  const read = (input: { organizationId?: string; stackId?: string; componentKey?: string; tail?: number } = {}, d = deps()) =>
    readAppStackComponentLogs(d, { organizationId: ACME, stackId: acmeStack, componentKey: "web", ...input });
  const [template] = builtInAppTemplateItems();
  const files = (...keys: string[]) => keys.map((parameterKey) => ({ envName: `${parameterKey.toUpperCase()}_FILE`, parameterKey, version: 1 }));
  const component = (key: string, secretFiles: AppStackPlanComponent["secretFiles"] = []): AppStackPlanComponent => ({
    key,
    image: `nginxinc/nginx-unprivileged@sha256:${"a".repeat(64)}`,
    runAsUser: null,
    argv: null,
    environment: [],
    secretFiles,
    resources: { cpuMilli: 250, memoryBytes: "134217728" },
    expose: [8080],
    dependsOn: [],
    volumes: [],
    healthcheck: null,
  });
  /** A revision of the stack whose plan holds `components`; returns its id. */
  async function revision(stackId: string, organizationId: string, revisionNumber: number, components: AppStackPlanComponent[]): Promise<string> {
    const revisionId = newAppEntityId("srev");
    const hostAllocationId = organizationId === ACME ? DEMO_IDS.allocations.acme : DEMO_IDS.allocations.beta;
    const base = { schemaVersion: 1 as const, stackId, organizationId, hostAllocationId, templateVersionId: template!.versionId, revisionId, components, volumes: [], ingress: [] };
    const plan = { ...base, planHash: computeAppStackPlanHash(base) };
    expect(ApprovedStackPlanSchema.safeParse(plan).success).toBe(true);
    await dbClient.db.insert(appStackRevisions).values({
      id: revisionId,
      stackId,
      organizationId,
      revisionNumber,
      templateVersionId: template!.versionId,
      plan,
      planHash: plan.planHash,
      componentCount: components.length,
      cpuMilli: 250 * components.length,
      memoryBytes: 134217728 * components.length,
    });
    return revisionId;
  }
  const refusal = async (pending: Promise<unknown>): Promise<ControlPlaneError> => {
    const err = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ControlPlaneError);
    return err as ControlPlaneError;
  };

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await seedPhase1Dataset(dbClient.db, config.secretsMasterKey);
    await ensureBuiltInAppTemplates(dbClient.db, builtInAppTemplateItems());
    for (const [id, organizationId, hostAllocationId] of [
      [acmeStack, ACME, DEMO_IDS.allocations.acme],
      [betaStack, BETA, DEMO_IDS.allocations.beta],
    ] as const) {
      await dbClient.db.insert(appStacks).values({
        id,
        organizationId,
        hostAllocationId,
        templateId: template!.templateId,
        templateVersionId: template!.versionId,
        name: id,
        status: "running",
      });
      // The installed plan gives web two secret files, one of them under two names: two values.
      const applied = await revision(id, organizationId, 1, [component("web", [...files("app_key", "db_password"), { envName: "DB_PASS_FILE", parameterKey: "db_password", version: 1 }])]);
      await dbClient.db.update(appStacks).set({ desiredRevisionId: applied, appliedRevisionId: applied }).where(eq(appStacks.id, id));
      await dbClient.db.insert(appStackComponents).values({ stackId: id, organizationId, componentKey: "web", appliedRevisionId: applied });
    }
  });

  beforeEach(() => {
    fake = FakeStackExecutor.create();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await dbClient.close();
  });

  it("answers a foreign stack, a missing stack and an unknown component with the same NOT_FOUND sentence", async () => {
    for (const input of [{ stackId: betaStack }, { stackId: newAppEntityId("stk") }, { componentKey: "db" }]) {
      const err = await refusal(read(input));
      expect([err.code, err.message]).toEqual(["NOT_FOUND", NOT_FOUND]);
    }
    expect(fake.calls).toEqual([]);
  });

  it("clamps the tail to 1..500 and defaults it to 200", async () => {
    await read({ tail: 0 });
    await read({ tail: 9999 });
    await read({ tail: 42.9 });
    await read();
    expect(fake.calls.map((c) => c.request)).toEqual(
      [1, 500, 42, 200].map((tail) => ({ stackId: acmeStack, organizationId: ACME, componentKey: "web", tail, secretFileCount: 2 })),
    );
  });

  it("sends how many secret files the plan the component runs from gives it: a number, never a key or a value (BUG-43)", async () => {
    const stackId = newAppEntityId("stk");
    await dbClient.db.insert(appStacks).values({
      id: stackId,
      organizationId: ACME,
      hostAllocationId: DEMO_IDS.allocations.acme,
      templateId: template!.templateId,
      templateVersionId: template!.versionId,
      name: stackId,
      status: "deploying",
    });
    await dbClient.db.insert(appStackComponents).values({ stackId, organizationId: ACME, componentKey: "web" });
    await dbClient.db.insert(appStackComponents).values({ stackId, organizationId: ACME, componentKey: "worker" });
    const sent = () => fake.calls.map((c) => (c.request as { secretFileCount?: number }).secretFileCount);

    // Nothing installed yet: the desired plan counts, and a component with no secret file is sent 0.
    const first = await revision(stackId, ACME, 1, [component("web", files("app_key")), component("worker")]);
    await dbClient.db.update(appStacks).set({ desiredRevisionId: first }).where(eq(appStacks.id, stackId));
    await read({ stackId });
    await read({ stackId, componentKey: "worker" });
    expect(sent()).toEqual([1, 0]);

    // Installed, then a new desired plan with more files: the installed one counts until it is installed in turn.
    const second = await revision(stackId, ACME, 2, [component("web", files("app_key", "mail_password", "smtp_token")), component("worker")]);
    await dbClient.db.update(appStacks).set({ appliedRevisionId: first, desiredRevisionId: second }).where(eq(appStacks.id, stackId));
    await dbClient.db.update(appStackComponents).set({ appliedRevisionId: first }).where(eq(appStackComponents.stackId, stackId));
    await read({ stackId });
    expect(sent()).toEqual([1, 0, 1]);
    expect(JSON.stringify(fake.calls)).not.toMatch(/app_key|mail_password|smtp_token|_FILE/);
  });

  it("refuses, with no executor call, a read no stored plan can count the secret files of", async () => {
    const stackId = newAppEntityId("stk");
    await dbClient.db.insert(appStacks).values({
      id: stackId,
      organizationId: ACME,
      hostAllocationId: DEMO_IDS.allocations.acme,
      templateId: template!.templateId,
      templateVersionId: template!.versionId,
      name: stackId,
      status: "running",
    });
    await dbClient.db.insert(appStackComponents).values({ stackId, organizationId: ACME, componentKey: "web" });
    // No revision at all.
    let err = await refusal(read({ stackId }));
    expect([err.code, err.message]).toEqual(["DOCKER_ENGINE_UNAVAILABLE", UNAVAILABLE]);
    // A plan that does not name the component.
    const other = await revision(stackId, ACME, 1, [component("api", files("app_key"))]);
    await dbClient.db.update(appStacks).set({ desiredRevisionId: other, appliedRevisionId: other }).where(eq(appStacks.id, stackId));
    err = await refusal(read({ stackId }));
    expect([err.code, err.message]).toEqual(["DOCKER_ENGINE_UNAVAILABLE", UNAVAILABLE]);
    // An installed plan that no longer parses, over a desired one that would count.
    const broken = newAppEntityId("srev");
    await dbClient.db.insert(appStackRevisions).values({
      id: broken,
      stackId,
      organizationId: ACME,
      revisionNumber: 2,
      templateVersionId: template!.versionId,
      plan: { schemaVersion: 1, components: [{ key: "web" }] },
      planHash: "0".repeat(64),
      componentCount: 1,
      cpuMilli: 250,
      memoryBytes: 134217728,
    });
    const counted = await revision(stackId, ACME, 3, [component("web")]);
    await dbClient.db.update(appStacks).set({ desiredRevisionId: counted, appliedRevisionId: broken }).where(eq(appStacks.id, stackId));
    err = await refusal(read({ stackId }));
    expect([err.code, err.message]).toEqual(["DOCKER_ENGINE_UNAVAILABLE", UNAVAILABLE]);
    expect(fake.calls).toEqual([]);
  });

  it("returns the executor's lines and replaces any executor error with the fixed DOCKER_ENGINE_UNAVAILABLE sentence", async () => {
    const lines: ServiceLogLine[] = [{ at: "2026-11-22T12:00:00.000Z", stream: "stdout", text: "ready" }];
    const spy = vi.spyOn(fake, "getAppStackComponentLogs").mockResolvedValueOnce(lines);
    await expect(read()).resolves.toEqual(lines);
    spy.mockRejectedValueOnce(new Error("container hp_app_web: engine said no"));
    const err = await refusal(read());
    expect([err.code, err.message, err.details]).toEqual(["DOCKER_ENGINE_UNAVAILABLE", UNAVAILABLE, []]);
  });

  it("answers NOT_SUPPORTED (STACK_UNSUPPORTED_FEATURE) with no stack port or the runtime disabled", async () => {
    const message = "Applications are not available on this server.";
    for (const d of [deps({ executor: new Phase1DisabledDockerExecutor() }), deps({ config: { ...config, runtimeBackend: "disabled" } })]) {
      const err = await refusal(read({}, d));
      expect([err.code, err.message, err.details]).toEqual(["NOT_SUPPORTED", message, [{ message, reason: "STACK_UNSUPPORTED_FEATURE" }]]);
    }
    expect(fake.calls).toEqual([]);
  });

  it("shares the gate with site log reads: 2 site reads and 1 stack read of one organisation make the third RATE_LIMITED", async () => {
    const gate = new LogReadGate();
    let release: () => void = () => undefined;
    const held = new Promise<readonly ServiceLogLine[]>((resolve) => {
      release = () => resolve([]);
    });
    const siteLogs = vi.spyOn(fake, "getServiceLogs").mockReturnValue(held);
    const sitesService = new ManagedSitesService(dbClient, config, fake, gate);
    const siteReads = [1, 2].map(() => sitesService.logs(DEMO_IDS.sites.acmeShop, ACME, 200));
    await vi.waitFor(() => expect(siteLogs).toHaveBeenCalledTimes(2));

    const err = await refusal(read({}, deps({ gate })));
    expect(err.code).toBe("RATE_LIMITED");
    expect(fake.calls).toEqual([]);
    await expect(read({ organizationId: BETA, stackId: betaStack }, deps({ gate }))).resolves.toEqual([]);

    release();
    await Promise.all(siteReads);
    await expect(read({}, deps({ gate }))).resolves.toEqual([]);
  });
});
