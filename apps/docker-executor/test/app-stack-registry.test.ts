/**
 * The executor never makes the Engine contact a registry on this server or on a private network (ADR-0036): no lookup,
 * no pull. An image of such a registry that is already on the server is used as it is, with no request to its registry.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApprovedStackPlanV2 } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStackEngine } from "../src/app-stacks/index.js";
import { InMemoryDockerSimulatorAdapter } from "../src/index.js";
import { createAppStackFakeEngine } from "./support/app-stack-fake-engine.js";
import { TEST_ALLOWLIST, V2_CREATE_SECRETS, appStackTestPlanV2, v2SecretEntry } from "./support/app-stack-plans.js";

const ID = "stk_0123456789abcdef";
const REF = { stackId: ID, organizationId: "org_acme" };
const DIGEST = `sha256:${"d".repeat(64)}`;
const enc = encodeURIComponent;
const DB_SECRETS = [v2SecretEntry("db_password"), v2SecretEntry("db_root_password")];
const WEB_SECRETS = [v2SecretEntry("app_key"), v2SecretEntry("db_password")];

const PRIVATE = [
  "127.0.0.1:5000/x",
  "127.1/x",
  "10.0.0.5/x",
  "192.168.1.10:443/x",
  "localhost/x",
  "localhost:5000/x",
  "registry:5000/x",
  "a.localhost/x",
  "registry.local/x",
  "registry.internal:5000/x",
  "nas.lan/x",
  "hub.acme.corp:5000/x",
  "[::1]:5000/x",
  "0x7f.0.0.1/x",
];
const notValid = { reason: "STACK_PLAN_INVALID", code: "VALIDATION_ERROR", message: "The image reference is not valid" };
/** A permanent refusal (the customer is sent to the administrator), not a missing image to try again later. */
const notAllowed = {
  reason: "STACK_IMAGE_NOT_ALLOWED",
  code: "HOST_POLICY_DENIED",
  message: "The image of component web is not allowed (registry_not_public)",
};

/** The version 2 test plan whose web component runs `image`. */
function planWith(image: string): ApprovedStackPlanV2 {
  const base = appStackTestPlanV2();
  return appStackTestPlanV2({ components: base.components.map((c) => (c.key === "web" ? { ...c, image } : c)) });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(local: readonly string[]) {
  const fake = createAppStackFakeEngine();
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-app-registry-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const request = vi.fn(fake.request);
  const engine = new AppStackEngine({
    request,
    secretsRootDir: root,
    pullMissingImages: true,
    allowlist: TEST_ALLOWLIST,
    routes: { write: vi.fn(async () => ({ changed: false, hostnames: [] })), remove: vi.fn(async () => false), read: vi.fn(async () => []) },
    proxy: { containerName: "hp_ingress_proxy_test", ensure: vi.fn(async () => undefined) },
    readLogs: vi.fn(async () => []),
    probe: vi.fn(async () => "passed" as const),
    now: () => new Date("2026-11-22T03:00:00.000Z"),
  });
  for (const image of local) fake.images.set(image, { repoDigests: [image] });
  fake.log.length = 0;
  return { fake, request, engine };
}

describe("the lookup of an image of a private registry", () => {
  it.each([...PRIVATE, ...PRIVATE.map((name) => `${name}:1.0`)])("refuses %s with no request to the Engine", async (image) => {
    const h = await setup([]);
    h.fake.registry.set(image, { Descriptor: { digest: DIGEST } });
    await expect(h.engine.resolveAppStackImage({ image })).rejects.toMatchObject(notValid);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.fake.log).toEqual([]);
  });
});

describe("the pull of an image of a private registry", () => {
  it.each(PRIVATE)("uses %s when it is already on the server: deploy, restart and stop ask no registry", async (name) => {
    const image = `${name}@${DIGEST}`;
    const plan = planWith(image);
    const h = await setup(plan.components.map((c) => c.image));
    for (const c of plan.components) await expect(h.engine.pullAppStackImage({ plan, image: c.image })).resolves.toEqual({ image: c.image, pulled: false });
    await h.engine.prepareAppStack({ plan });
    await h.engine.createAppStackComponents({ plan, secretContents: [...V2_CREATE_SECRETS] });
    await h.engine.startAppStackComponent({ plan, componentKey: "db", secretFileContents: DB_SECRETS });
    await h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: WEB_SECRETS });
    await h.engine.startAppStackComponent({ plan, componentKey: "cache", secretFileContents: [] });
    await h.engine.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: WEB_SECRETS });
    await h.engine.stopAppStack(REF);
    await h.engine.startAppStackComponent({ plan, componentKey: "db", secretFileContents: DB_SECRETS });
    await h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: WEB_SECRETS });
    expect((await h.engine.getAppStackStatus(REF)).components.find((c) => c.componentKey === "web")?.state).toBe("running");
    expect(h.fake.log.filter((line) => line.includes("/images/create") || line.includes("/distribution/"))).toEqual([]);
  });

  it.each(PRIVATE)("refuses %s when it is missing, after the local look and before any download", async (name) => {
    const image = `${name}@${DIGEST}`;
    const plan = planWith(image);
    const h = await setup([]);
    h.fake.pullable.add(image);
    await expect(h.engine.pullAppStackImage({ plan, image })).rejects.toMatchObject(notAllowed);
    expect(h.fake.log).toEqual([`GET /images/${enc(image)}/json`]);
    expect(h.request).toHaveBeenCalledOnce();
  });

  it("still downloads a missing image of a public registry", async () => {
    const image = `ghcr.io/acme/blog@${DIGEST}`;
    const plan = planWith(image);
    const h = await setup([]);
    h.fake.pullable.add(image);
    await expect(h.engine.pullAppStackImage({ plan, image })).resolves.toEqual({ image, pulled: true });
    expect(h.fake.log).toContain(`POST /images/create?fromImage=${enc(image)}`);
  });
});

describe("the simulator with an image of a private registry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const simulator = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hp-sim-registry-"));
    dirs.push(dir);
    return new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST, secretsRootDir: dir });
  };

  it("refuses the lookup like the engine", async () => {
    const sim = simulator();
    for (const image of PRIVATE) await expect(sim.resolveAppStackImage({ image })).rejects.toMatchObject(notValid);
    await expect(sim.resolveAppStackImage({ image: "ghcr.io/acme/blog:2.4" })).resolves.toMatchObject({ image: "ghcr.io/acme/blog:2.4" });
  });

  it.each(PRIVATE)("refuses to download %s and runs it once it is on the server", async (name) => {
    const image = `${name}@${DIGEST}`;
    const plan = planWith(image);
    const sim = simulator();
    await expect(sim.pullAppStackImage({ plan, image })).rejects.toMatchObject(notAllowed);
    expect(sim.appStacks.appStackMutations).toEqual([]);

    sim.appStacks.loadAppStackImage(image);
    for (const c of plan.components) await sim.pullAppStackImage({ plan, image: c.image });
    expect(sim.appStacks.appStackMutations.filter((m) => m.kind === "pull").map((m) => m.name)).not.toContain(image);
    await sim.prepareAppStack({ plan });
    await sim.createAppStackComponents({ plan, secretContents: [...V2_CREATE_SECRETS] });
    await sim.startAppStackComponent({ plan, componentKey: "db", secretFileContents: DB_SECRETS });
    await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: WEB_SECRETS });
    await sim.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: WEB_SECRETS });
    expect((await sim.getAppStackStatus(REF)).components.find((c) => c.componentKey === "web")?.state).toBe("running");
  });
});
