import { randomUUID } from "node:crypto";
import { DEMO_IDS, desc, eq, serviceInstances, stackRevisions } from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { buildApprovedServiceSpec } from "../src/runtime/service-spec.js";

const ACME = DEMO_IDS.organizations.acme;
// The seeded cache service has no secret refs, so no master key is needed to build its spec.
const SERVICE = DEMO_IDS.services.acmeShopRedis;
const BASE_CONFIG = { maxmemory: "256mb" };

describe("approved service spec: revision phpIni", () => {
  let app: ControlPlaneAppHandle;

  const build = () =>
    buildApprovedServiceSpec(app.dbClient.db, { secretsMasterKey: Buffer.alloc(32) }, { organizationId: ACME, serviceInstanceId: SERVICE });
  // Revisions are append-only: each case stores its configuration as a new current revision.
  const storeConfig = async (declarativeConfig: Record<string, unknown>) => {
    const db = app.dbClient.db;
    const [last] = await db
      .select()
      .from(stackRevisions)
      .where(eq(stackRevisions.serviceInstanceId, SERVICE))
      .orderBy(desc(stackRevisions.revisionNumber))
      .limit(1);
    const id = randomUUID();
    await db.insert(stackRevisions).values({
      ...last!,
      id,
      revisionNumber: last!.revisionNumber + 1,
      specHash: id,
      declarativeConfig,
    });
    await db.update(serviceInstances).set({ currentRevisionId: id }).where(eq(serviceInstances.id, SERVICE));
  };

  beforeAll(async () => {
    app = await createControlPlaneApp({
      seedPhase1: true,
      enableDevOidc: true,
      host: "127.0.0.1",
      port: 0,
      listen: true,
      dockerExecutor: new InMemoryDockerSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it("passes a stored phpIni to the spec and keeps it out of the environment", async () => {
    await storeConfig({ ...BASE_CONFIG, phpIni: { memory_limit: "256M", upload_max_filesize: "64M" } });
    const spec = await build();
    expect(spec.phpIni).toEqual({ memory_limit: "256M", upload_max_filesize: "64M" });
    expect(spec.env).toEqual({ maxmemory: "256mb" });
  });

  it.each([
    ["has no phpIni", BASE_CONFIG],
    ["has an empty phpIni", { ...BASE_CONFIG, phpIni: {} }],
  ])("omits the key when the revision %s", async (_name, config) => {
    await storeConfig(config);
    expect("phpIni" in (await build())).toBe(false);
  });

  it.each([
    ["an unknown key", { foo: "1" }],
    ["an invalid value", { memory_limit: "256M\nauto_prepend_file=/x" }],
    ["a null value", null],
  ])("fails closed on %s", async (_name, phpIni) => {
    await storeConfig({ ...BASE_CONFIG, phpIni });
    const error = await build().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect((error as ControlPlaneError).code).toBe("VALIDATION_ERROR");
  });
});
