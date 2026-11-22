import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { signIpcRequest, type IpcSigningKey, type IpcVerificationKey } from "@hosting-panel/contracts";
import { APP_STACK_EXECUTOR_METHODS, Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStackEngine } from "../src/app-stacks/index.js";
import {
  DockerExecutorIpcServer,
  ExecutorIpcClientError,
  SignedDockerExecutorIpcClient,
  type IngressCapableDockerExecutor,
} from "../src/index.js";
import { createAppStackFakeEngine } from "./support/app-stack-fake-engine.js";
import { TEST_ALLOWLIST, appStackTestPlan } from "./support/app-stack-plans.js";

// QA Q5: the edges of the stack IPC (arch-executor §4, §14).
const SECRET = "0123456789abcdef0123456789abcdef-app-stack-ipc-qa";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const CANARY = "CANARY-secret-9b3f2c";
const MAX_BODY = 1_048_576;

const plan = appStackTestPlan();
const ref = { stackId: plan.stackId, organizationId: plan.organizationId };
const IMAGE = plan.components[0]!.image;
const canarySecret = { parameterKey: "shared_key", version: 1, content: CANARY };

type StackMethod = (typeof APP_STACK_EXECUTOR_METHODS)[number];
type Envelope = { error?: { code: string; message: string; details?: { reason?: string }[] } };

function stackStub() {
  const fns = Object.fromEntries(
    APP_STACK_EXECUTOR_METHODS.map((m) => [m, vi.fn(async (_req: unknown): Promise<unknown> => ({}))]),
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

async function serve(executor: IngressCapableDockerExecutor) {
  const socketPath = `/tmp/hp-exec-stkqa-${randomBytes(5).toString("hex")}.sock`;
  const server = new DockerExecutorIpcServer({ executor, keyring: { "hmac-v1": VERIFICATION_KEY }, socketPath });
  await server.start();
  cleanup.push(() => server.stop());
  return { client: new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath }), socketPath };
}

/** A raw request; `bodyText` is sent as is (so a test controls the exact byte length). */
function raw(
  socketPath: string,
  method: "GET" | "POST",
  pathWithQuery: string,
  options: { body?: unknown; bodyText?: string; signed?: boolean } = {},
): Promise<{ status: number; text: string; json: Envelope }> {
  const body = options.bodyText ?? (options.body === undefined ? null : JSON.stringify(options.body));
  const headers =
    options.signed === false
      ? {}
      : signIpcRequest({ method, pathWithQuery, body, key: SIGNING_KEY, nonce: randomBytes(8).toString("hex") });
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
          resolve({ status: res.statusCode ?? 0, text, json: JSON.parse(text) as Envelope });
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

const expectNoStackCall = (fns: Record<StackMethod, { mock: { calls: unknown[] } }>) => {
  for (const m of APP_STACK_EXECUTOR_METHODS) expect(fns[m].mock.calls, m).toHaveLength(0);
};

/** A JSON object of exactly `bytes` bytes. */
const jsonOfSize = (bytes: number, extra: Record<string, unknown> = {}): string => {
  const head = JSON.stringify({ ...extra, pad: "" });
  return JSON.stringify({ ...extra, pad: "x".repeat(bytes - Buffer.byteLength(head)) });
};

const POST_ROUTES = [
  "pull",
  "prepare",
  "create",
  "start",
  "restart",
  "stop",
  "routes",
  "unpublish",
  "remove",
  "remove-components",
] as const;

describe("the 1 MiB body cap on the stack routes", () => {
  it("answers 400 before the signature is looked at, whatever the route, and never reaches the executor", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    const oversized = jsonOfSize(MAX_BODY + 1, { secretFileContents: [canarySecret] });
    expect(Buffer.byteLength(oversized)).toBe(MAX_BODY + 1);
    for (const route of POST_ROUTES) {
      for (const signed of [false, true]) {
        const res = await raw(socketPath, "POST", `/v1/app-stacks/${route}`, { bodyText: oversized, signed });
        expect([res.status, res.json.error?.code], `${route} signed=${String(signed)}`).toEqual([400, "VALIDATION_ERROR"]);
        expect(res.json.error?.message).toBe("IPC request body exceeds maximum allowed size");
        expect(res.text).not.toContain(CANARY);
      }
    }
    expectNoStackCall(fns);
  });

  it("takes exactly 1 MiB to the authentication step: unsigned is 401, and a signed bad body is a shape 400, not a size one", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    const atCap = jsonOfSize(MAX_BODY);
    expect(Buffer.byteLength(atCap)).toBe(MAX_BODY);
    const unsigned = await raw(socketPath, "POST", "/v1/app-stacks/prepare", { bodyText: atCap, signed: false });
    expect([unsigned.status, unsigned.json.error?.code]).toEqual([401, "UNAUTHENTICATED"]);
    const signed = await raw(socketPath, "POST", "/v1/app-stacks/prepare", { bodyText: atCap });
    expect([signed.status, signed.json.error?.code]).toEqual([400, "VALIDATION_ERROR"]);
    expect(signed.json.error?.message).not.toBe("IPC request body exceeds maximum allowed size");
    expectNoStackCall(fns);
  });

  it("applies the cap to a stack GET as well", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    const res = await raw(socketPath, "GET", `/v1/app-stacks/${plan.stackId}/status?organizationId=${plan.organizationId}`, {
      bodyText: jsonOfSize(MAX_BODY + 1),
      signed: false,
    });
    expect([res.status, res.json.error?.code]).toEqual([400, "VALIDATION_ERROR"]);
    expectNoStackCall(fns);
  });
});

describe("secret file contents are never echoed", () => {
  const withSecret = (over: Record<string, unknown>) => ({ plan, componentKey: "worker", secretFileContents: [{ ...canarySecret, ...over }] });
  const BODIES: ReadonlyArray<readonly [string, unknown]> = [
    ["a NUL in the content", withSecret({ content: `${CANARY}\u0000` })],
    ["an oversized content", withSecret({ content: CANARY.repeat(1_000) })],
    ["a version of 0", withSecret({ version: 0 })],
    ["a float version", withSecret({ version: 1.5 })],
    ["a string version", withSecret({ version: CANARY })],
    ["a bad parameterKey", withSecret({ parameterKey: `Bad ${CANARY}` })],
    ["an extra key beside the content", withSecret({ extra: CANARY })],
    ["a content that is a number", withSecret({ content: 12345 })],
    ["a content that is an object", withSecret({ content: { value: CANARY } })],
    ["a duplicated entry", { plan, componentKey: "worker", secretFileContents: [canarySecret, canarySecret] }],
    ["secretFileContents that is not an array", { plan, componentKey: "worker", secretFileContents: canarySecret }],
    ["a bad componentKey", { plan, componentKey: `Bad ${CANARY}`, secretFileContents: [canarySecret] }],
    ["a plan failing its schema", { plan: { ...plan, schemaVersion: 2 }, componentKey: "worker", secretFileContents: [canarySecret] }],
    ["a plan that is a string", { plan: CANARY, componentKey: "worker", secretFileContents: [canarySecret] }],
    ["an unknown field of the request", { plan, componentKey: "worker", secretFileContents: [canarySecret], note: CANARY }],
    ["too many entries", { plan, componentKey: "worker", secretFileContents: Array.from({ length: 200 }, (_, i) => ({ ...canarySecret, parameterKey: `p${String(i)}` })) }],
  ];

  it.each(["start", "restart"] as const)("a %s refusal carries no content, whichever the schema issue", async (route) => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    for (const [label, body] of BODIES) {
      const res = await raw(socketPath, "POST", `/v1/app-stacks/${route}`, { body });
      expect(res.status, label).toBe(400);
      expect(res.text, label).not.toContain(CANARY);
    }
    expectNoStackCall(fns);
  });

  it("malformed or empty JSON of a secret-bearing body is refused without echoing it", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    for (const bodyText of [`{"secretFileContents":[{"content":"${CANARY}"`, `${CANARY}`, "   "]) {
      const res = await raw(socketPath, "POST", "/v1/app-stacks/start", { bodyText });
      expect([res.status, res.json.error?.code], bodyText).toEqual([400, "VALIDATION_ERROR"]);
      expect(res.text).not.toContain(CANARY);
    }
    expectNoStackCall(fns);
  });

  it("an executor failure that quotes the content is not forwarded verbatim by a stack-coded refusal", async () => {
    // The route forwards the executor's own message, so this pins what the REAL engine says (below);
    // here only the 5xx path of a generic error is checked: its message is the safe one, not the raw text.
    const { executor, fns } = stackStub();
    fns.startAppStackComponent.mockRejectedValueOnce(new Error(`engine said ${CANARY}`));
    const { client } = await serve(executor);
    const err = await failure(client.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [canarySecret] }));
    expect(err.statusCode).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(CANARY);
  });
});

/** The real stack engine over a fake Docker Engine, served through the signed IPC. */
async function engineServer() {
  const fake = createAppStackFakeEngine();
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-stk-ipcqa-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const engine = new AppStackEngine({
    request: fake.request,
    secretsRootDir: root,
    pullMissingImages: false,
    allowlist: TEST_ALLOWLIST,
    routes: { write: async () => ({ changed: false, hostnames: [] }), remove: async () => false, read: async () => [] },
    proxy: { containerName: "hp_ingress_proxy_test", ensure: async () => undefined },
    readLogs: async () => [],
    probe: async () => "passed",
    now: () => new Date("2026-11-22T03:00:00.000Z"),
  });
  const executor: IngressCapableDockerExecutor = Object.assign(
    Object.create(new Phase1DisabledDockerExecutor()) as Phase1DisabledDockerExecutor,
    Object.fromEntries(
      APP_STACK_EXECUTOR_METHODS.map((m) => [m, (req: never) => (engine[m] as (r: never) => Promise<unknown>).call(engine, req)]),
    ),
  );
  fake.images.set("traefik:test", { repoDigests: [] });
  await fake.request("POST", "/containers/create?name=hp_ingress_proxy_test", { Image: "traefik:test" });
  fake.images.set(IMAGE, { repoDigests: [IMAGE] });
  fake.log.length = 0;
  return { fake, ...(await serve(executor)) };
}

describe("engine errors through the IPC", () => {
  it.each([
    ["the container start", /^POST \/containers\/[^/]+\/start/],
    ["the container create", /^POST \/containers\/create\?name=hp_app_/],
  ])("a 500 of %s whose body quotes the secret answers a safe message", async (_label, match) => {
    const { fake, client, socketPath } = await engineServer();
    await client.prepareAppStack({ plan });
    if (!match.source.includes("create")) {
      // worker depends on web: bring web up so the failure is the Engine's, not a readiness refusal.
      await client.createAppStackComponents({ plan });
      await client.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    }
    fake.failNext(match, 500, `engine dump ${CANARY} ${CANARY}`);
    const failing = match.source.includes("create")
      ? client.createAppStackComponents({ plan })
      : client.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [canarySecret] });
    const err = await failure(failing);
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(CANARY);
    // The same call as a raw request: the whole envelope (body included) is clean too.
    fake.failNext(match, 500, `engine dump ${CANARY}`);
    const body = match.source.includes("create") ? { plan } : { plan, componentKey: "worker", secretFileContents: [canarySecret] };
    const res = await raw(socketPath, "POST", match.source.includes("create") ? "/v1/app-stacks/create" : "/v1/app-stacks/start", { body });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(CANARY);
  });

  it("a start whose secret is missing names the secret by parameter key only", async () => {
    const { client, socketPath } = await engineServer();
    await client.prepareAppStack({ plan });
    await client.createAppStackComponents({ plan });
    const res = await raw(socketPath, "POST", "/v1/app-stacks/start", {
      body: { plan, componentKey: "worker", secretFileContents: [{ ...canarySecret, parameterKey: "other_key" }] },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toContain(CANARY);
  });
});

describe("path parameters", () => {
  const org = plan.organizationId;
  const id = plan.stackId;
  const BAD_IDS = [
    "BAD%2Fid",
    "stk_0123%2F..%2Fother",
    "stk%2F..",
    "STK_0123456789ABCDEF",
    "Stk_0123456789abcdef",
    "stk-0123456789abcdef",
    "stk_0123456789abcdef%00",
    "stk_0123%0Aabc",
    "%E0%A4%A",
    "%",
    "stk_0123456789abcdef%20",
    "%2e%2e",
    "..",
    ".",
    `${CANARY}`,
    "s".repeat(65),
  ];
  const BAD_KEYS = ["Web", "WEB", "we%2Fb", "%2F", "web%2F..%2Fworker", "-web", "web-", "web%00", "web_1", "9web", "%zz", `${CANARY}`, "w".repeat(33)];

  it("a stack id that is encoded, dotted, uppercase or off-pattern is refused on status and logs, and nothing is called", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    for (const bad of BAD_IDS) {
      for (const tail of [`/status?organizationId=${org}`, `/components/web/logs?organizationId=${org}&tail=5`]) {
        const res = await raw(socketPath, "GET", `/v1/app-stacks/${bad}${tail}`);
        // 400 when the segment reaches the schema, 404 when the URL parser collapses a dot segment out of the route.
        expect([400, 404], `${bad}${tail}`).toContain(res.status);
        expect(res.text).not.toContain(`"data"`);
      }
    }
    expectNoStackCall(fns);
  });

  it("a component key that is encoded, uppercase or off-pattern is refused on logs", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    for (const bad of BAD_KEYS) {
      const res = await raw(socketPath, "GET", `/v1/app-stacks/${id}/components/${bad}/logs?organizationId=${org}&tail=5`);
      expect([res.status, res.json.error?.code], bad).toEqual([400, "VALIDATION_ERROR"]);
    }
    expectNoStackCall(fns);
  });

  it("an organization id that is off-pattern or encoded is refused", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    for (const bad of ["ORG_ACME", "org%2Facme", "org_acme%00", "..", "", "%E0%A4%A"]) {
      const res = await raw(socketPath, "GET", `/v1/app-stacks/${id}/status?organizationId=${bad}`);
      expect([res.status, res.json.error?.code], bad).toEqual([400, "VALIDATION_ERROR"]);
    }
    expectNoStackCall(fns);
  });

  it("a %2F inside a valid-looking route is not a separator: the extra segment is an unknown route", async () => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    for (const p of [
      `/v1/app-stacks/${id}/components/web/logs/extra?organizationId=${org}&tail=5`,
      `/v1/app-stacks/${id}/components/web%2Flogs?organizationId=${org}&tail=5`,
      `/v1/app-stacks/${id}%2Fstatus?organizationId=${org}`,
    ]) {
      const res = await raw(socketPath, "GET", p);
      expect([400, 404], p).toContain(res.status);
    }
    expectNoStackCall(fns);
  });

  it("a valid id with a lower-case hex escape is decoded once and accepted exactly as the plain id", async () => {
    const { executor, fns } = stackStub();
    fns.getAppStackStatus.mockResolvedValue({ ok: true });
    const { socketPath } = await serve(executor);
    const res = await raw(socketPath, "GET", `/v1/app-stacks/stk%5f0123456789abcdef/status?organizationId=${org}`);
    expect(res.status).toBe(200);
    expect(fns.getAppStackStatus.mock.calls[0]?.[0]).toEqual(ref);
  });
});

describe("the logs tail", () => {
  const base = `/v1/app-stacks/${plan.stackId}/components/web/logs?organizationId=${plan.organizationId}`;

  it.each([
    ["an array of two", "&tail=5&tail=5"],
    ["an array of three", "&tail=1&tail=2&tail=3"],
    ["an array and an empty value", "&tail=&tail=5"],
    ["a float", "&tail=1.5"],
    ["a float that rounds to a valid integer", "&tail=10.0000001"],
    ["a float with a trailing dot form", "&tail=5.5e0"],
    ["a negative", "&tail=-1"],
    ["zero", "&tail=0"],
    ["above the maximum", "&tail=501"],
    ["not a number", "&tail=abc"],
    ["NaN", "&tail=NaN"],
    ["Infinity", "&tail=Infinity"],
    ["empty", "&tail="],
    ["missing", ""],
    ["a bracketed name only", "&tail[]=5"],
    ["a hex literal beyond the maximum", "&tail=0x1FF"],
  ])("refuses %s with 400 and no executor call", async (_label, query) => {
    const { executor, fns } = stackStub();
    const { socketPath } = await serve(executor);
    const res = await raw(socketPath, "GET", `${base}${query}`);
    expect([res.status, res.json.error?.code]).toEqual([400, "VALIDATION_ERROR"]);
    expect(fns.getAppStackComponentLogs).not.toHaveBeenCalled();
  });

  it.each([
    ["the minimum", "&tail=1", 1],
    ["the maximum", "&tail=500", 500],
  ])("accepts %s and hands the executor a number", async (_label, query, tail) => {
    const { executor, fns } = stackStub();
    fns.getAppStackComponentLogs.mockResolvedValue([]);
    const { socketPath } = await serve(executor);
    const res = await raw(socketPath, "GET", `${base}${query}`);
    expect(res.status).toBe(200);
    expect(fns.getAppStackComponentLogs.mock.calls[0]?.[0]).toEqual({ ...ref, componentKey: "web", tail });
  });

  it("a client call with a float or an out-of-range tail is refused by the server, not truncated", async () => {
    const { executor, fns } = stackStub();
    const { client } = await serve(executor);
    for (const tail of [1.5, 0, 501, -3, Number.NaN]) {
      const err = await failure(client.getAppStackComponentLogs({ ...ref, componentKey: "web", tail }));
      expect(["VALIDATION_ERROR", "DOCKER_ENGINE_UNAVAILABLE"], String(tail)).toContain(err.code);
    }
    expect(fns.getAppStackComponentLogs).not.toHaveBeenCalled();
  });
});

describe("NOT_SUPPORTED", () => {
  it("an executor with only some of the stack methods answers NOT_SUPPORTED, never a TypeError", async () => {
    const { executor, fns } = stackStub();
    const partial = Object.assign(Object.create(new Phase1DisabledDockerExecutor()) as Phase1DisabledDockerExecutor, {
      prepareAppStack: fns.prepareAppStack,
      getAppStackStatus: fns.getAppStackStatus,
    });
    void executor;
    const { client } = await serve(partial);
    for (const call of [
      () => client.prepareAppStack({ plan }),
      () => client.getAppStackStatus(ref),
      () => client.stopAppStack(ref),
    ]) {
      const err = await failure(call());
      expect([err.statusCode, err.code]).toEqual([422, "NOT_SUPPORTED"]);
    }
    expectNoStackCall(fns);
  });

  it("is decided after the route and before the body: a bad body on an unsupported executor is NOT_SUPPORTED, an unknown route stays 404", async () => {
    const { socketPath } = await serve(new Phase1DisabledDockerExecutor());
    const bad = await raw(socketPath, "POST", "/v1/app-stacks/start", { body: { nonsense: CANARY } });
    expect([bad.status, bad.json.error?.code]).toEqual([422, "NOT_SUPPORTED"]);
    expect(bad.text).not.toContain(CANARY);
    const unknown = await raw(socketPath, "POST", "/v1/app-stacks/nope", { body: {} });
    expect([unknown.status, unknown.json.error?.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("an unsupported executor still refuses unsigned stack calls with 401", async () => {
    const { socketPath } = await serve(new Phase1DisabledDockerExecutor());
    const res = await raw(socketPath, "POST", "/v1/app-stacks/prepare", { body: { plan }, signed: false });
    expect([res.status, res.json.error?.code]).toEqual([401, "UNAUTHENTICATED"]);
  });
});

describe("STACK_BUSY across two concurrent signed calls", () => {
  it("a second mutation of the same stack is 409 RESOURCE_LOCKED STACK_BUSY while the first runs; reads and other stacks pass; the lock is released", async () => {
    const { fake, client, socketPath } = await engineServer();
    const held = fake.hold(/^GET \/networks\/hp_appnet_/);
    const first = client.prepareAppStack({ plan });
    await vi.waitFor(() => expect(fake.log.some((l) => l.startsWith("GET /networks/hp_appnet_"))).toBe(true));

    for (const call of [
      () => client.prepareAppStack({ plan }),
      () => client.createAppStackComponents({ plan }),
      () => client.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
      () => client.stopAppStack(ref),
      () => client.unpublishAppStackRoutes(ref),
      () => client.removeAppStack({ ...ref, removeVolumes: false }),
    ]) {
      const err = await failure(call());
      expect([err.statusCode, err.code, err.reason, err.ambiguousOutcome]).toEqual([409, "RESOURCE_LOCKED", "STACK_BUSY", false]);
      expect(err.message).toBe("Another change of this application stack is running");
    }
    // Raw: the details reason is on the wire.
    const busy = await raw(socketPath, "POST", "/v1/app-stacks/stop", { body: ref });
    expect([busy.status, busy.json.error?.code, busy.json.error?.details?.[0]?.reason]).toEqual([409, "RESOURCE_LOCKED", "STACK_BUSY"]);

    await expect(client.getAppStackStatus(ref)).resolves.toMatchObject({ stackId: plan.stackId });
    await expect(client.stopAppStack({ stackId: "stk_other", organizationId: plan.organizationId })).resolves.toEqual({ components: [] });

    held.release();
    await expect(first).resolves.toMatchObject({ networks: expect.any(Array) });
    await expect(client.prepareAppStack({ plan })).resolves.toBeDefined();
  });

  it("the lock is released when the first call fails", async () => {
    const { fake, client } = await engineServer();
    const held = fake.hold(/^GET \/networks\/hp_appnet_/);
    const first = failure(client.prepareAppStack({ plan }));
    await vi.waitFor(() => expect(fake.log.some((l) => l.startsWith("GET /networks/hp_appnet_"))).toBe(true));
    fake.failNext(/^GET \/networks\/hp_appnet_/, 500);
    held.release();
    expect((await first).code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    await expect(client.prepareAppStack({ plan })).resolves.toBeDefined();
  });
});
