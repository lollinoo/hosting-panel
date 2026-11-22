import { randomBytes } from "node:crypto";
import {
  appStackComponents,
  appStacks,
  builtInAppTemplateItems,
  createDatabaseClient,
  DEMO_IDS,
  ensureBuiltInAppTemplates,
  newAppEntityId,
  seedPhase1Dataset,
  type DatabaseClient,
} from "@hosting-panel/database";
import { Phase1DisabledDockerExecutor, type ServiceLogLine } from "@hosting-panel/executor-contracts";
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
    const [template] = builtInAppTemplateItems();
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
      await dbClient.db.insert(appStackComponents).values({ stackId: id, organizationId, componentKey: "web" });
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
      [1, 500, 42, 200].map((tail) => ({ stackId: acmeStack, organizationId: ACME, componentKey: "web", tail })),
    );
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
