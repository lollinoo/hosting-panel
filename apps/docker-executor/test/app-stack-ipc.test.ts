import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { APP_TEMPLATE_LIMITS, createErrorEnvelope, signIpcRequest, type IpcSigningKey, type IpcVerificationKey } from "@hosting-panel/contracts";
import { APP_STACK_EXECUTOR_METHODS, Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  APP_STACK_COMPONENT_TIMEOUT_MS,
  APP_STACK_CREATE_TIMEOUT_MS,
  APP_STACK_LINKS_TIMEOUT_MS,
  APP_STACK_LOGS_TIMEOUT_MS,
  APP_STACK_PREPARE_TIMEOUT_MS,
  APP_STACK_PULL_TIMEOUT_MS,
  APP_STACK_REMOVE_TIMEOUT_MS,
  APP_STACK_RESOLVE_TIMEOUT_MS,
  APP_STACK_ROUTES_TIMEOUT_MS,
  APP_STACK_STATUS_TIMEOUT_MS,
  APP_STACK_STOP_TIMEOUT_MS,
  AppStackExecutorError,
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  ExecutorCodedError,
  ExecutorIpcClientError,
  SignedDockerExecutorIpcClient,
  type IngressCapableDockerExecutor,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";
import { TEST_ALLOWLIST, V2_CREATE_SECRETS, appStackTestPlan, appStackTestPlanV2 } from "./support/app-stack-plans.js";

const SECRET = "0123456789abcdef0123456789abcdef-app-stack-ipc";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const CANARY = "CANARY-secret-7d41e9";

const plan = appStackTestPlan();
const ref = { stackId: plan.stackId, organizationId: plan.organizationId };
const image = plan.components[0]!.image;
const secret = { parameterKey: "shared_key", version: 1, content: CANARY };
const routes = [
  { componentKey: "web", internalPort: 8080, hosts: [{ hostname: "shop.example.org", tls: true, httpsRedirect: true, redirectTo: null }] },
];
const at = "2026-11-22T03:00:00.000Z";
// A link needs ids longer than any component key (ADR-0039).
const links = {
  stackId: "stk_0123456789abcdef01234567",
  organizationId: plan.organizationId,
  componentKey: "db",
  consumerStackIds: ["stk_89abcdef0123456701234567"],
};
const lookup = "ghcr.io/acme/blog:2.4";
const lookupPath = `/v1/app-stacks/image-digest?image=${encodeURIComponent(lookup)}`;

const RESULTS = {
  pullAppStackImage: { image, pulled: true },
  prepareAppStack: { networks: [{ role: "app_internal", created: true }], volumes: [{ volumeKey: "data", created: true }] },
  createAppStackComponents: { components: [{ componentKey: "web", outcome: "created" }], removedComponents: [] },
  startAppStackComponent: { componentKey: "web", outcome: "started" },
  restartAppStackComponent: { componentKey: "worker", outcome: "restarted" },
  stopAppStack: { components: [{ componentKey: "web", outcome: "stopped" }] },
  publishAppStackRoutes: { routeCount: 1, hostnames: ["shop.example.org"], changed: true },
  unpublishAppStackRoutes: { routeCount: 0, hostnames: [], changed: true },
  removeAppStack: { removedComponents: ["web"], removedNetworks: ["app_internal"], removedVolumes: [], retainedVolumes: ["data"] },
  removeAppStackComponents: { removedComponents: ["worker"] },
  syncAppStackLinks: {
    container: true,
    links: [{ consumerStackId: "stk_89abcdef0123456701234567", outcome: "connected" }],
    disconnected: ["stk_fedcba987654321001234567"],
  },
  getAppStackStatus: {
    stackId: plan.stackId,
    observedAt: at,
    components: [
      {
        componentKey: "web",
        state: "running",
        health: "healthy",
        probe: "passed",
        componentHash: "a".repeat(64),
        revisionId: plan.revisionId,
        startedAt: at,
        restartCount: 0,
        exitCode: null,
        oomKilled: false,
      },
    ],
    networks: { internal: true, edge: true },
    volumes: ["data"],
    routes: { published: true, hostnames: ["shop.example.org"] },
  },
  getAppStackComponentLogs: [{ at, stream: "stdout", text: "ready" }],
  resolveAppStackImage: { image: lookup, digest: `sha256:${"9".repeat(64)}` },
} as const;

type StackMethod = (typeof APP_STACK_EXECUTOR_METHODS)[number];

/** A DockerExecutorPort (the Phase 1 refusals) with the stack methods as spies. */
function stackStub() {
  const fns = Object.fromEntries(
    APP_STACK_EXECUTOR_METHODS.map((m) => [m, vi.fn(async (_req: unknown): Promise<unknown> => structuredClone(RESULTS[m]))]),
  ) as Record<StackMethod, ReturnType<typeof vi.fn<(req: unknown) => Promise<unknown>>>>;
  const executor: IngressCapableDockerExecutor = Object.assign(
    Object.create(new Phase1DisabledDockerExecutor()) as Phase1DisabledDockerExecutor,
    fns,
  );
  return { executor, fns };
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length > 0) await cleanup.pop()?.();
});

const socketPathFor = () => `/tmp/hp-exec-stk-${randomBytes(5).toString("hex")}.sock`;

async function serve(executor: IngressCapableDockerExecutor) {
  const socketPath = socketPathFor();
  const server = new DockerExecutorIpcServer({ executor, keyring: { "hmac-v1": VERIFICATION_KEY }, socketPath });
  await server.start();
  cleanup.push(() => server.stop());
  const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath });
  return { client, socketPath };
}

function raw(
  socketPath: string,
  method: "GET" | "POST",
  pathWithQuery: string,
  options: { body?: unknown; signed?: boolean; nonce?: string } = {},
): Promise<{ status: number; text: string; json: { error?: { code: string; message: string; details?: { reason?: string }[] } } }> {
  const body = options.body === undefined ? null : JSON.stringify(options.body);
  const headers =
    options.signed === false
      ? {}
      : signIpcRequest({ method, pathWithQuery, body, key: SIGNING_KEY, nonce: options.nonce ?? randomBytes(8).toString("hex") });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        method,
        path: pathWithQuery,
        headers: { ...headers, ...(body === null ? {} : { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, text, json: JSON.parse(text) as never });
        });
      },
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function failure(work: Promise<unknown>): Promise<ExecutorIpcClientError> {
  try {
    await work;
  } catch (err) {
    expect(err).toBeInstanceOf(ExecutorIpcClientError);
    return err as ExecutorIpcClientError;
  }
  throw new Error("expected the call to fail");
}

type Client = SignedDockerExecutorIpcClient;
const CALLS: ReadonlyArray<{ method: StackMethod; request: unknown; call: (c: Client) => Promise<unknown> }> = [
  { method: "pullAppStackImage", request: { plan, image }, call: (c) => c.pullAppStackImage({ plan, image }) },
  { method: "prepareAppStack", request: { plan }, call: (c) => c.prepareAppStack({ plan }) },
  { method: "createAppStackComponents", request: { plan }, call: (c) => c.createAppStackComponents({ plan }) },
  {
    method: "startAppStackComponent",
    request: { plan, componentKey: "web", secretFileContents: [] },
    call: (c) => c.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
  },
  {
    method: "restartAppStackComponent",
    request: { plan, componentKey: "worker", secretFileContents: [secret] },
    call: (c) => c.restartAppStackComponent({ plan, componentKey: "worker", secretFileContents: [secret] }),
  },
  { method: "stopAppStack", request: ref, call: (c) => c.stopAppStack(ref) },
  { method: "publishAppStackRoutes", request: { plan, routes }, call: (c) => c.publishAppStackRoutes({ plan, routes }) },
  { method: "unpublishAppStackRoutes", request: ref, call: (c) => c.unpublishAppStackRoutes(ref) },
  { method: "removeAppStack", request: { ...ref, removeVolumes: false }, call: (c) => c.removeAppStack({ ...ref, removeVolumes: false }) },
  {
    method: "removeAppStackComponents",
    request: { plan, componentKeys: ["worker"] },
    call: (c) => c.removeAppStackComponents({ plan, componentKeys: ["worker"] }),
  },
  { method: "syncAppStackLinks", request: links, call: (c) => c.syncAppStackLinks(links) },
  { method: "getAppStackStatus", request: ref, call: (c) => c.getAppStackStatus(ref) },
  {
    method: "getAppStackComponentLogs",
    request: { ...ref, componentKey: "web", tail: 50 },
    call: (c) => c.getAppStackComponentLogs({ ...ref, componentKey: "web", tail: 50 }),
  },
  { method: "resolveAppStackImage", request: { image: lookup }, call: (c) => c.resolveAppStackImage({ image: lookup }) },
];

describe("application stack IPC routes", () => {
  it("each client method reaches its executor method with the parsed request and returns its result", async () => {
    const { executor, fns } = stackStub();
    const { client } = await serve(executor);
    expect(CALLS.map((c) => c.method)).toEqual([...APP_STACK_EXECUTOR_METHODS]);
    for (const { method, request, call } of CALLS) {
      await expect(call(client), method).resolves.toEqual(RESULTS[method]);
      expect(fns[method], method).toHaveBeenCalledTimes(1);
      expect(fns[method].mock.calls[0]?.[0], method).toEqual(request);
    }
  });

  it("a stop and a remove carry the applied plan's order to the executor, and refuse a malformed one (#100)", async () => {
    const { executor, fns } = stackStub();
    const { client } = await serve(executor);
    const order = ["web", "worker"];
    await client.stopAppStack({ ...ref, order });
    await client.removeAppStack({ ...ref, removeVolumes: false, order });
    expect(fns.stopAppStack.mock.calls[0]?.[0]).toEqual({ ...ref, order });
    expect(fns.removeAppStack.mock.calls[0]?.[0]).toEqual({ ...ref, removeVolumes: false, order });
    for (const bad of [["web", "web"], [], ["Bad_Key"], Array.from({ length: APP_TEMPLATE_LIMITS.services + 1 }, (_, i) => `c${i}`)]) {
      for (const err of [
        await failure(client.stopAppStack({ ...ref, order: bad })),
        await failure(client.removeAppStack({ ...ref, removeVolumes: false, order: bad })),
      ]) {
        expect([err.statusCode, err.code, err.reason], JSON.stringify(bad)).toEqual([400, "VALIDATION_ERROR", undefined]);
      }
    }
    expect(fns.stopAppStack).toHaveBeenCalledTimes(1);
    expect(fns.removeAppStack).toHaveBeenCalledTimes(1);
  });

  it("refuses unsigned (401) and replayed (409) requests before any executor call", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    const unsigned = await raw(socketPath, "POST", "/v1/app-stacks/prepare", { body: { plan }, signed: false });
    expect(unsigned.status).toBe(401);
    expect(unsigned.json.error?.code).toBe("UNAUTHENTICATED");

    const nonce = "nonce-app-stack-replay-1";
    const first = await raw(socketPath, "GET", `/v1/app-stacks/${plan.stackId}/status?organizationId=${plan.organizationId}`, { nonce });
    expect(first.status).toBe(200);
    const replay = await raw(socketPath, "GET", `/v1/app-stacks/${plan.stackId}/status?organizationId=${plan.organizationId}`, { nonce });
    expect(replay.status).toBe(409);
    expect(replay.json.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(fns.prepareAppStack).not.toHaveBeenCalled();
    expect(fns.getAppStackStatus).toHaveBeenCalledTimes(1);
  });

  it("an executor without the stack methods answers 422 NOT_SUPPORTED on every route", async () => {
    const { client } = await serve(new Phase1DisabledDockerExecutor());
    for (const { method, call } of CALLS) {
      const err = await failure(call(client));
      expect([err.statusCode, err.code], method).toEqual([422, "NOT_SUPPORTED"]);
      expect(err.message).toBe("Application stacks are not supported by the active executor backend");
    }
  });

  it("an unknown stack route answers 404 with the usual envelope", async () => {
    const { executor } = stackStub();
    const { socketPath } = await serve(executor);
    for (const [method, path] of [
      ["GET", "/v1/app-stacks/x"],
      ["POST", "/v1/app-stacks/deploy"],
      ["GET", "/v1/app-stacks/pull"],
      ["POST", `/v1/app-stacks/${plan.stackId}/status`],
      ["GET", `/v1/app-stacks/${plan.stackId}/components/web/logs/more`],
    ] as const) {
      const res = await raw(socketPath, method, path, method === "POST" ? { body: {} } : {});
      expect(res.status, path).toBe(404);
      expect(res.json.error?.code).toBe("NOT_FOUND");
      expect(res.json.error?.message).toBe(`Unknown executor IPC route: ${method} ${path}`);
    }
    const unsupported = await serve(new Phase1DisabledDockerExecutor());
    expect((await raw(unsupported.socketPath, "GET", "/v1/app-stacks/x")).status).toBe(404);
  });

  it("a plan schema failure is STACK_PLAN_INVALID; any other shape failure is a plain VALIDATION_ERROR", async () => {
    const { executor, fns } = stackStub();
    const { client } = await serve(executor);
    const badPlan = { ...plan, schemaVersion: 3 } as unknown as typeof plan;
    const planErr = await failure(client.prepareAppStack({ plan: badPlan }));
    expect([planErr.statusCode, planErr.code, planErr.reason]).toEqual([400, "VALIDATION_ERROR", "STACK_PLAN_INVALID"]);
    expect(planErr.message).toBe("The application plan is invalid at schemaVersion");
    const missing = await failure(client.createAppStackComponents({} as never));
    expect([missing.code, missing.reason]).toEqual(["VALIDATION_ERROR", "STACK_PLAN_INVALID"]);

    const keyErr = await failure(client.startAppStackComponent({ plan, componentKey: "Bad_Key", secretFileContents: [secret] }));
    expect([keyErr.statusCode, keyErr.code, keyErr.reason]).toEqual([400, "VALIDATION_ERROR", undefined]);
    expect(keyErr.message).toMatch(/^Invalid application stack start payload: /);
    const extra = await failure(client.stopAppStack({ ...ref, force: true } as never));
    expect([extra.code, extra.reason]).toEqual(["VALIDATION_ERROR", undefined]);
    for (const m of APP_STACK_EXECUTOR_METHODS) expect(fns[m], m).not.toHaveBeenCalled();
  });

  it("secret content never appears in an error envelope", async () => {
    const { executor, fns } = stackStub();
    const { client, socketPath } = await serve(executor);
    const bodies: unknown[] = [
      { plan, componentKey: "Bad_Key", secretFileContents: [secret] },
      { plan, componentKey: "worker", secretFileContents: [{ ...secret, content: `${CANARY}\u0000` }] },
      { plan, componentKey: "worker", secretFileContents: [secret, secret] },
      { plan: { ...plan, stackId: CANARY }, componentKey: "worker", secretFileContents: [secret] },
      { plan, componentKey: "worker", secretFileContents: [{ ...secret, version: 0 }] },
      { plan, componentKey: "worker", secretFileContents: [{ ...secret, content: CANARY.repeat(2_000) }] },
    ];
    for (const body of bodies) {
      const res = await raw(socketPath, "POST", "/v1/app-stacks/restart", { body });
      expect(res.status).toBe(400);
      expect(res.text).not.toContain(CANARY);
    }
    fns.restartAppStackComponent.mockRejectedValueOnce(new AppStackExecutorError("STACK_SECRET_MISSING", "A secret of component worker is missing"));
    const err = await failure(client.restartAppStackComponent({ plan, componentKey: "worker", secretFileContents: [secret] }));
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(CANARY);
  });

  it("forwards a STACK_* or TLS_* reason as details[0].reason and drops any other", async () => {
    const { executor, fns } = stackStub();
    const { client } = await serve(executor);
    fns.startAppStackComponent.mockRejectedValueOnce(new AppStackExecutorError("STACK_BUSY", "Another change of this application stack is running"));
    const busy = await failure(client.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }));
    expect([busy.statusCode, busy.code, busy.reason, busy.message]).toEqual([
      409,
      "RESOURCE_LOCKED",
      "STACK_BUSY",
      "Another change of this application stack is running",
    ]);
    expect(busy.ambiguousOutcome).toBe(false);

    fns.removeAppStack.mockRejectedValueOnce(new AppStackExecutorError("STACK_VOLUME_IN_USE", "A stack volume is in use"));
    expect((await failure(client.removeAppStack({ ...ref, removeVolumes: true }))).reason).toBe("STACK_VOLUME_IN_USE");

    fns.getAppStackStatus.mockRejectedValueOnce(new AppStackExecutorError("STACK_NAMESPACE_CONFLICT", "An object on this server uses the name"));
    const conflict = await failure(client.getAppStackStatus(ref));
    expect([conflict.statusCode, conflict.code, conflict.reason]).toEqual([403, "HOST_POLICY_DENIED", "STACK_NAMESPACE_CONFLICT"]);

    // An image folder no volume covers (#98): a policy denial whose message names the folder for the administrator.
    fns.pullAppStackImage.mockRejectedValueOnce(
      new AppStackExecutorError("STACK_IMAGE_VOLUME_UNCOVERED", "The image of component web declares the folder /data and no volume of the component is mounted at exactly that folder"),
    );
    const uncovered = await failure(client.pullAppStackImage({ plan, image }));
    expect([uncovered.statusCode, uncovered.code, uncovered.reason, uncovered.ambiguousOutcome]).toEqual([403, "HOST_POLICY_DENIED", "STACK_IMAGE_VOLUME_UNCOVERED", false]);
    expect(uncovered.message).toContain("/data");

    fns.prepareAppStack.mockRejectedValueOnce(Object.assign(new ExecutorCodedError("Manifest moved", "RESOURCE_LOCKED"), { reason: "TLS_MANIFEST_CONFLICT" }));
    expect((await failure(client.prepareAppStack({ plan }))).reason).toBe("TLS_MANIFEST_CONFLICT");

    fns.prepareAppStack.mockRejectedValueOnce(Object.assign(new ExecutorCodedError("Odd", "RESOURCE_LOCKED"), { reason: "FOO_BAR" }));
    const dropped = await failure(client.prepareAppStack({ plan }));
    expect([dropped.code, dropped.reason, dropped.details]).toEqual(["RESOURCE_LOCKED", undefined, []]);

    fns.createAppStackComponents.mockRejectedValueOnce(new ExecutorCodedError("Failed to create (HTTP 500)", "DOCKER_ENGINE_UNAVAILABLE"));
    const engine = await failure(client.createAppStackComponents({ plan }));
    expect([engine.statusCode, engine.code, engine.reason]).toEqual([503, "DOCKER_ENGINE_UNAVAILABLE", undefined]);
  });

  it("a refusal that says nothing was changed carries one more detail, after its reason when it has one (#111)", async () => {
    const { executor, fns } = stackStub();
    const { client } = await serve(executor);
    const marked = <E extends ExecutorCodedError>(err: E): E => Object.assign(err, { beforeChange: true });
    const BEFORE_CHANGE = { field: "stage", message: "before_change" };

    fns.createAppStackComponents.mockRejectedValueOnce(marked(new AppStackExecutorError("STACK_IMAGE_MISSING", "The image is not available on this server")));
    const withReason = await failure(client.createAppStackComponents({ plan }));
    expect([withReason.statusCode, withReason.code, withReason.reason]).toEqual([404, "NOT_FOUND", "STACK_IMAGE_MISSING"]);
    expect(withReason.details).toEqual([{ message: "The image is not available on this server", reason: "STACK_IMAGE_MISSING" }, BEFORE_CHANGE]);

    // The hardening check names no reason: the mark is then the only detail, and the problem still comes from the code.
    fns.createAppStackComponents.mockRejectedValueOnce(marked(new ExecutorCodedError("The body breaks a rule", "HOST_POLICY_DENIED")));
    const noReason = await failure(client.createAppStackComponents({ plan }));
    expect([noReason.code, noReason.reason, noReason.details]).toEqual(["HOST_POLICY_DENIED", undefined, [BEFORE_CHANGE]]);

    // An error that was not marked, and an engine failure, carry what they carried before.
    fns.createAppStackComponents.mockRejectedValueOnce(new AppStackExecutorError("STACK_NAMESPACE_CONFLICT", "An object uses the name"));
    const unmarked = await failure(client.createAppStackComponents({ plan }));
    expect(unmarked.details).toEqual([{ message: "An object uses the name", reason: "STACK_NAMESPACE_CONFLICT" }]);
    fns.createAppStackComponents.mockRejectedValueOnce(new ExecutorCodedError("Failed to create (HTTP 500)", "DOCKER_ENGINE_UNAVAILABLE"));
    expect((await failure(client.createAppStackComponents({ plan }))).details).toEqual([]);
  });

  it("a query name given twice, a bad tail or a bad path id answers 400", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    const id = plan.stackId;
    const org = plan.organizationId;
    for (const path of [
      `/v1/app-stacks/${id}/status?organizationId=${org}&organizationId=${org}`,
      `/v1/app-stacks/${id}/status`,
      `/v1/app-stacks/${id}/components/web/logs?organizationId=${org}&tail=5&tail=5`,
      `/v1/app-stacks/${id}/components/web/logs?organizationId=${org}&organizationId=${org}&tail=5`,
      `/v1/app-stacks/${id}/components/web/logs?organizationId=${org}&tail=1.5`,
      `/v1/app-stacks/${id}/components/web/logs?organizationId=${org}&tail=501`,
      `/v1/app-stacks/${id}/components/web/logs?organizationId=${org}`,
      `/v1/app-stacks/${id}/components/Web_1/logs?organizationId=${org}&tail=5`,
      `/v1/app-stacks/BAD%2Fid/status?organizationId=${org}`,
    ]) {
      const res = await raw(socketPath, "GET", path);
      expect([res.status, res.json.error?.code], path).toEqual([400, "VALIDATION_ERROR"]);
      expect(res.json.error?.details, path).toEqual([]);
    }
    expect(fns.getAppStackStatus).not.toHaveBeenCalled();
    expect(fns.getAppStackComponentLogs).not.toHaveBeenCalled();
  });

  it("the image lookup takes exactly one well-formed reference", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    const q = (image: string) => `image=${encodeURIComponent(image)}`;
    for (const path of [
      "/v1/app-stacks/image-digest",
      `/v1/app-stacks/image-digest?${q(lookup)}&${q(lookup)}`,
      `/v1/app-stacks/image-digest?${q("")}`,
      `/v1/app-stacks/image-digest?${q("Acme/Blog:1")}`,
      `/v1/app-stacks/image-digest?${q("acme/blog:1 --all")}`,
      `/v1/app-stacks/image-digest?${q("../../containers/json")}`,
      `/v1/app-stacks/image-digest?${q(`acme/blog@sha256:${"a".repeat(64)}`)}`,
      `/v1/app-stacks/image-digest?${q(`${"a".repeat(250)}:1.0.0`)}`,
    ]) {
      const res = await raw(socketPath, "GET", path);
      expect([res.status, res.json.error?.code], path).toEqual([400, "VALIDATION_ERROR"]);
    }
    expect((await raw(socketPath, "POST", "/v1/app-stacks/image-digest", { body: { image: lookup } })).status).toBe(404);
    expect(fns.resolveAppStackImage).not.toHaveBeenCalled();

    const ok = await raw(socketPath, "GET", lookupPath);
    expect(ok.status).toBe(200);
    expect(fns.resolveAppStackImage).toHaveBeenCalledExactlyOnceWith({ image: lookup });
  });

  it("create carries the environment secrets of a version 2 plan and nothing of them comes back", async () => {
    const { executor, fns } = stackStub();
    const { client, socketPath } = await serve(executor);
    const v2 = appStackTestPlanV2();
    const secretContents = [
      { parameterKey: "db_password", version: 1, content: CANARY },
      { parameterKey: "db_root_password", version: 1, content: `${CANARY}-root` },
    ];
    await expect(client.createAppStackComponents({ plan: v2, secretContents })).resolves.toEqual(RESULTS.createAppStackComponents);
    expect(fns.createAppStackComponents.mock.calls[0]?.[0]).toEqual({ plan: v2, secretContents });
    await client.createAppStackComponents({ plan: v2 });
    expect(fns.createAppStackComponents.mock.calls[1]?.[0]).toEqual({ plan: v2 });
    expect(V2_CREATE_SECRETS.map((entry) => entry.parameterKey)).toEqual(secretContents.map((entry) => entry.parameterKey));

    for (const body of [
      { plan: v2, secretContents: [...secretContents, secretContents[0]] },
      { plan: v2, secretContents: [{ ...secretContents[0], content: `${CANARY}\u0000` }] },
      { plan: v2, secretContents: [{ ...secretContents[0], version: 0 }] },
      { plan: v2, secretContents, secretFileContents: secretContents },
      { plan: { ...v2, stackId: CANARY }, secretContents },
    ]) {
      const res = await raw(socketPath, "POST", "/v1/app-stacks/create", { body });
      expect(res.status).toBe(400);
      expect(res.text).not.toContain(CANARY);
    }
    expect(fns.createAppStackComponents).toHaveBeenCalledTimes(2);

    fns.createAppStackComponents.mockRejectedValueOnce(new AppStackExecutorError("STACK_SECRET_MISSING", "A secret of the application is missing"));
    const err = await failure(client.createAppStackComponents({ plan: v2, secretContents }));
    expect([err.code, err.reason]).toEqual(["VALIDATION_ERROR", "STACK_SECRET_MISSING"]);
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(CANARY);
  });

  it("client budgets equal the design and the three reads are GET", async () => {
    expect({
      APP_STACK_PULL_TIMEOUT_MS,
      APP_STACK_PREPARE_TIMEOUT_MS,
      APP_STACK_CREATE_TIMEOUT_MS,
      APP_STACK_COMPONENT_TIMEOUT_MS,
      APP_STACK_STOP_TIMEOUT_MS,
      APP_STACK_ROUTES_TIMEOUT_MS,
      APP_STACK_REMOVE_TIMEOUT_MS,
      APP_STACK_LINKS_TIMEOUT_MS,
      APP_STACK_STATUS_TIMEOUT_MS,
      APP_STACK_LOGS_TIMEOUT_MS,
      APP_STACK_RESOLVE_TIMEOUT_MS,
    }).toEqual({
      APP_STACK_PULL_TIMEOUT_MS: 270_000,
      APP_STACK_PREPARE_TIMEOUT_MS: 60_000,
      APP_STACK_CREATE_TIMEOUT_MS: 180_000,
      APP_STACK_COMPONENT_TIMEOUT_MS: 60_000,
      APP_STACK_STOP_TIMEOUT_MS: 150_000,
      APP_STACK_ROUTES_TIMEOUT_MS: 300_000,
      APP_STACK_REMOVE_TIMEOUT_MS: 180_000,
      APP_STACK_LINKS_TIMEOUT_MS: 60_000,
      APP_STACK_STATUS_TIMEOUT_MS: 60_000,
      APP_STACK_LOGS_TIMEOUT_MS: 35_000,
      APP_STACK_RESOLVE_TIMEOUT_MS: 40_000,
    });
    const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath: socketPathFor() });
    const seen: Array<[string | undefined, string | null | undefined, number | undefined]> = [];
    vi.spyOn(http, "request").mockImplementation(((opts: http.RequestOptions) => {
      seen.push([opts.method, opts.path, opts.timeout]);
      throw new Error("stop");
    }) as never);
    for (const { call } of CALLS) await call(client).catch(() => undefined);
    const q = `organizationId=${plan.organizationId}`;
    expect(seen).toEqual([
      ["POST", "/v1/app-stacks/pull", 270_000],
      ["POST", "/v1/app-stacks/prepare", 60_000],
      ["POST", "/v1/app-stacks/create", 180_000],
      ["POST", "/v1/app-stacks/start", 60_000],
      ["POST", "/v1/app-stacks/restart", 60_000],
      ["POST", "/v1/app-stacks/stop", 150_000],
      ["POST", "/v1/app-stacks/routes", 300_000],
      ["POST", "/v1/app-stacks/unpublish", 300_000],
      ["POST", "/v1/app-stacks/remove", 180_000],
      ["POST", "/v1/app-stacks/remove-components", 180_000],
      ["POST", "/v1/app-stacks/links", 60_000],
      ["GET", `/v1/app-stacks/${plan.stackId}/status?${q}`, 60_000],
      ["GET", `/v1/app-stacks/${plan.stackId}/components/web/logs?${q}&tail=50`, 35_000],
      ["GET", lookupPath, 40_000],
    ]);
  });

  it("a server that never answers makes a POST ambiguous and a GET a plain unavailable", async () => {
    const socketPath = socketPathFor();
    let hits = 0;
    const silent = http.createServer(() => {
      hits += 1;
    });
    await new Promise<void>((resolve) => silent.listen(socketPath, () => resolve()));
    cleanup.push(async () => {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
      await rm(socketPath, { force: true });
    });
    const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath, timeoutMs: 150 });

    const post = await failure(client.createAppStackComponents({ plan }));
    expect([post.code, post.statusCode, post.ambiguousOutcome]).toEqual(["OPERATION_AMBIGUOUS", 502, true]);
    const component = await failure(client.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [secret] }));
    expect([component.code, component.ambiguousOutcome]).toEqual(["OPERATION_AMBIGUOUS", true]);
    expect(component.message).not.toContain(CANARY);

    const status = await failure(client.getAppStackStatus(ref));
    expect([status.code, status.statusCode, status.ambiguousOutcome]).toEqual(["DOCKER_ENGINE_UNAVAILABLE", 503, false]);
    const logs = await failure(client.getAppStackComponentLogs({ ...ref, componentKey: "web", tail: 10 }));
    expect([logs.code, logs.ambiguousOutcome]).toEqual(["DOCKER_ENGINE_UNAVAILABLE", false]);
    const resolved = await failure(client.resolveAppStackImage({ image: lookup }));
    expect([resolved.code, resolved.ambiguousOutcome]).toEqual(["DOCKER_ENGINE_UNAVAILABLE", false]);
    expect(hits).toBe(5);
  });

  describe("an answer the client cannot read after a change was sent", () => {
    // A server that answers every request with the status and body of the moment: an executor of another release,
    // or one whose answer broke on the way.
    async function answering() {
      const socketPath = socketPathFor();
      let answer: readonly [number, string] = [200, "{}"];
      let hits = 0;
      const server = http.createServer((req, res) => {
        hits += 1;
        req.resume();
        req.on("end", () => {
          res.writeHead(answer[0], { "Content-Type": "application/json" });
          res.end(answer[1]);
        });
      });
      await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
      cleanup.push(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(socketPath, { force: true });
      });
      const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath });
      /** How each call ends under each answer, and how many requests reached the server for it. */
      return async (calls: ReadonlyArray<readonly [string, (c: Client) => Promise<unknown>]>, answers: ReadonlyArray<readonly [number, string]>) => {
        const seen: Array<[string, number, string, string, number]> = [];
        for (const [name, call] of calls) {
          for (const next of answers) {
            answer = next;
            const before = hits;
            seen.push([name, next[0], next[1].slice(0, 12), verdict(await call(client).then(() => RESOLVED, (err: unknown) => err)), hits - before]);
          }
        }
        return seen;
      };
    }

    const RESOLVED = Symbol("resolved");
    /** Never the message itself: it could quote the body. */
    function verdict(err: unknown): string {
      if (err === RESOLVED) return "resolved";
      if (err instanceof ZodError) return "ZodError";
      if (!(err instanceof ExecutorIpcClientError)) return `other: ${(err as Error).name}`;
      if (err.message.includes(CANARY) || JSON.stringify(err.details).includes(CANARY)) return "quotes the body";
      return `${err.code}/${String(err.ambiguousOutcome)}/${String(err.statusCode)}`;
    }
    const envelope = (code: "DOCKER_ENGINE_UNAVAILABLE" | "RESOURCE_LOCKED") =>
      JSON.stringify(createErrorEnvelope({ code, message: "refused", requestId: "req-1" }));
    const outcomes = (seen: ReadonlyArray<[string, number, string, string, number]>) => [...new Set(seen.map(([, , , v, n]) => `${v} x${n}`))];

    const stackJob = { ...ref, jobId: "op_0123456789abcdef01234567-apply" };
    // The closed list (ADR-0035, ADR-0038, ADR-0042): calls whose request, once sent, may have changed the server.
    const CHANGES: ReadonlyArray<readonly [string, (c: Client) => Promise<unknown>]> = [
      ...CALLS.filter(({ method }) => !["syncAppStackLinks", "getAppStackStatus", "getAppStackComponentLogs", "resolveAppStackImage"].includes(method)).map(
        ({ method, call }) => [method, call] as const,
      ),
      [
        "runAppStackTask",
        (c) => c.runAppStackTask({ ...ref, componentKey: "web", runId: "srun_0123456789abcdef01234567", argv: ["true"], timeoutSeconds: 5 }),
      ],
      ["backups stackStart", (c) => c.backups({ action: "stackStart", ...stackJob, volumeKeys: ["data"] } as never)],
      ["backups stackRestore", (c) => c.backups({ action: "stackRestore", ...stackJob, volumeKeys: ["data"] } as never)],
      ["backups stackForget", (c) => c.backups({ action: "stackForget", ...stackJob } as never)],
    ];
    // An empty 200, one that fails the schema (its keys must not reach a message), a body that is not JSON, a 5xx
    // without the executor's error envelope.
    const UNREADABLE: ReadonlyArray<readonly [number, string]> = [
      [200, "{}"],
      [200, ""],
      [200, JSON.stringify({ data: { [CANARY]: CANARY } })],
      [200, `not json ${CANARY}`],
      [500, ""],
      [500, `boom ${CANARY}`],
      [502, JSON.stringify({ message: CANARY })],
    ];

    it("is a lost answer for every call on the closed list: sent once, never quoted", async () => {
      expect(CHANGES).toHaveLength(14);
      const seen = await (await answering())(CHANGES, UNREADABLE);
      expect(seen.filter(([, , , v, n]) => v !== "OPERATION_AMBIGUOUS/true/502" || n !== 1)).toEqual([]);
    });

    it("keeps a refusal the executor stated, and a 4xx, a sure refusal for the same calls", async () => {
      const answers = [
        [500, envelope("DOCKER_ENGINE_UNAVAILABLE")],
        [409, envelope("RESOURCE_LOCKED")],
        [400, ""],
        [404, ""],
        [400, `bad ${CANARY}`],
      ] as const;
      const seen = await (await answering())(CHANGES, answers);
      // One list per answer, in the order above: every call ends the same way under it.
      expect(answers.map((_, k) => outcomes(seen.filter((_row, i) => i % answers.length === k)))).toEqual([
        ["DOCKER_ENGINE_UNAVAILABLE/false/500 x1"],
        ["RESOURCE_LOCKED/false/409 x1"],
        ["INTERNAL_ERROR/false/400 x1"],
        ["NOT_FOUND/false/404 x1"],
        ["INTERNAL_ERROR/false/400 x1"],
      ]);
    });

    it("leaves every other call as it was: reads, links, other backup actions, sites", async () => {
      const others: ReadonlyArray<readonly [string, (c: Client) => Promise<unknown>]> = [
        ["getAppStackStatus", (c) => c.getAppStackStatus(ref)],
        ["getAppStackTaskRun", (c) => c.getAppStackTaskRun({ ...ref, runId: "srun_0123456789abcdef01234567" })],
        ["syncAppStackLinks", (c) => c.syncAppStackLinks(links)],
        ["backups status", (c) => c.backups({ action: "status", jobId: stackJob.jobId } as never)],
        ["backups start", (c) => c.backups({ action: "start", siteId: "site_0123456789abcdef", jobId: "job-1" } as never)],
        ["siteFiles list", (c) => c.siteFiles({ serviceInstanceId: "svc_0123456789abcdef", op: "list", path: "" })],
      ];
      const seen = await (await answering())(others, UNREADABLE);
      for (const name of others.map(([n]) => n)) {
        expect(seen.filter(([n]) => n === name).map(([, s, , v, n]) => `${String(s)} ${v} x${String(n)}`), name).toEqual([
          "200 ZodError x1",
          "200 ZodError x1",
          "200 ZodError x1",
          "200 INTERNAL_ERROR/false/200 x1",
          "500 INTERNAL_ERROR/false/500 x1",
          "500 INTERNAL_ERROR/false/500 x1",
          "502 INTERNAL_ERROR/false/502 x1",
        ]);
      }
    });
  });

  it("drives the socket adapter through the signed client against the mock Engine", async () => {
    const daemon = await startMockDockerDaemon();
    cleanup.push(() => daemon.close());
    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-stk-ipc-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const listener = net.createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end();
    });
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", () => resolve()));
    cleanup.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
    const port = (listener.address() as AddressInfo).port;
    const [web, worker] = plan.components;
    const tcpPlan = appStackTestPlan({
      components: [{ ...web!, expose: [8080, port], healthcheck: { kind: "tcp", port, intervalSeconds: 10, timeoutSeconds: 3 } }, worker!],
    });
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: daemon.socketPath,
      secretsRootDir: path.join(dir, "secrets"),
      ingressRootDir: path.join(dir, "ingress"),
      pullMissingImages: false,
      appImageAllowlist: TEST_ALLOWLIST,
    });
    const { client } = await serve(adapter);

    await expect(client.pullAppStackImage({ plan: tcpPlan, image })).resolves.toEqual({ image, pulled: false });
    const prepared = {
      networks: [
        { role: "app_internal", created: true },
        { role: "app_edge", created: true },
      ],
      volumes: [{ volumeKey: "data", created: true }],
    };
    await expect(client.prepareAppStack({ plan: tcpPlan })).resolves.toEqual(prepared);
    await expect(client.prepareAppStack({ plan: tcpPlan })).resolves.toEqual({
      networks: prepared.networks.map((n) => ({ ...n, created: false })),
      volumes: [{ volumeKey: "data", created: false }],
    });
    await expect(client.createAppStackComponents({ plan: tcpPlan })).resolves.toEqual({
      components: [
        { componentKey: "web", outcome: "created" },
        { componentKey: "worker", outcome: "created" },
      ],
      removedComponents: [],
    });
    await expect(client.startAppStackComponent({ plan: tcpPlan, componentKey: "web", secretFileContents: [] })).resolves.toEqual({
      componentKey: "web",
      outcome: "started",
    });

    const status = await client.getAppStackStatus(ref);
    expect(status.components.map((c) => [c.componentKey, c.state, c.health, c.probe])).toEqual([
      ["web", "running", "healthy", "passed"],
      ["worker", "created", "stopped", "not_run"],
    ]);
    expect([status.networks, status.volumes, status.routes]).toEqual([{ internal: true, edge: true }, ["data"], { published: false, hostnames: [] }]);

    const volume = `hp_appvol_${plan.stackId}_data`;
    daemon.containers.set("foreign", {
      id: "foreign",
      name: "someone_else",
      image: "x",
      env: [],
      labels: {},
      running: true,
      status: "running",
      restartCount: 0,
      hostConfig: { Mounts: [{ Type: "volume", Source: volume }] } as never,
      networks: {},
    });
    const inUse = await failure(client.removeAppStack({ ...ref, removeVolumes: true }));
    expect([inUse.statusCode, inUse.code, inUse.reason]).toEqual([409, "RESOURCE_LOCKED", "STACK_VOLUME_IN_USE"]);
    expect(daemon.deletedNetworks).toEqual([`hp_appedge_${plan.stackId}`, `hp_appnet_${plan.stackId}`]);
    expect(daemon.deletedVolumes).toEqual([]);
    expect(daemon.requestedPaths.some((p) => p.includes("/images/create"))).toBe(false);
  });
});
