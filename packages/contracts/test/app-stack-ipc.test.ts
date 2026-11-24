import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as appTemplates from "../src/app-templates/index.js";
import { APP_STACK_REASONS } from "../src/app-templates/issues.js";
import { APP_STACK_PLAN_MAX_BYTES } from "../src/app-templates/limits.js";
import type { ApprovedStackPlan } from "../src/app-templates/plan.js";
import {
  APP_STACK_EXECUTOR_REASON_CODES,
  APP_STACK_EXECUTOR_REASONS,
  APP_STACK_LOG_TAIL_MAX,
  APP_STACK_SECRET_CONTENT_MAX_CHARS,
  AppStackComponentActionIpcResultSchema,
  AppStackComponentIpcRequestSchema,
  AppStackComponentsRemoveIpcRequestSchema,
  AppStackComponentsRemoveIpcResultSchema,
  AppStackCreateIpcResultSchema,
  AppStackExecutorReasonSchema,
  AppStackLogsIpcRequestSchema,
  AppStackLogsIpcResultSchema,
  AppStackPlanIpcRequestSchema,
  AppStackPrepareIpcResultSchema,
  AppStackPullIpcRequestSchema,
  AppStackPullIpcResultSchema,
  AppStackRefIpcRequestSchema,
  AppStackRemoveIpcRequestSchema,
  AppStackRemoveIpcResultSchema,
  AppStackRoutesIpcRequestSchema,
  AppStackRoutesIpcResultSchema,
  AppStackSecretFileContentSchema,
  AppStackSecretFileContentsSchema,
  AppStackStatusIpcResultSchema,
  AppStackStopIpcRequestSchema,
  AppStackStopIpcResultSchema,
  type AppStackComponentActionIpcResult,
  type AppStackComponentIpcRequest,
  type AppStackComponentsRemoveIpcRequest,
  type AppStackComponentsRemoveIpcResult,
  type AppStackCreateIpcResult,
  type AppStackLogLineWire,
  type AppStackLogsIpcRequest,
  type AppStackPlanIpcRequest,
  type AppStackPrepareIpcResult,
  type AppStackPullIpcRequest,
  type AppStackPullIpcResult,
  type AppStackRefIpcRequest,
  type AppStackRemoveIpcRequest,
  type AppStackRemoveIpcResult,
  type AppStackRouteWire,
  type AppStackRoutesIpcRequest,
  type AppStackRoutesIpcResult,
  type AppStackSecretFileContent,
  type AppStackStatusIpcResult,
  type AppStackStopIpcRequest,
  type AppStackStopIpcResult,
} from "../src/app-templates/stack-ipc.js";
import { ERROR_CODES } from "../src/errors.js";
import { findForbiddenPublicDtoKeys, findPlaintextSecretKeys, redactSensitiveValue } from "../src/resources.js";

const PLAN = JSON.parse(
  readFileSync(new URL("./fixtures/app-stack-notes-demo/plan.json", import.meta.url), "utf8"),
) as ApprovedStackPlan;
const REF: AppStackRefIpcRequest = { stackId: PLAN.stackId, organizationId: PLAN.organizationId };
const SECRET: AppStackSecretFileContent = { parameterKey: "app_secret", version: 1, content: "s3cr3t-file-content" };
const host = (hostname: string) => ({ hostname, tls: true, httpsRedirect: true, redirectTo: null, challenge: "http-01" as const });
const ROUTE: AppStackRouteWire = {
  componentKey: "app",
  internalPort: 8080,
  hosts: [host("shop.example.org"), { hostname: "www.example.org", tls: false, httpsRedirect: false, redirectTo: null, source: "manual" }],
};

const pull: AppStackPullIpcRequest = { plan: PLAN, image: PLAN.components[0]!.image };
const planOnly: AppStackPlanIpcRequest = { plan: PLAN };
const component: AppStackComponentIpcRequest = { plan: PLAN, componentKey: "app", secretFileContents: [SECRET] };
const remove: AppStackRemoveIpcRequest = { ...REF, removeVolumes: false };
const ORDER = ["cache", "web"];
const stop: AppStackStopIpcRequest = { ...REF, order: ORDER };
const componentsRemove: AppStackComponentsRemoveIpcRequest = { plan: PLAN, componentKeys: ["old-web", "cache"] };
const logs: AppStackLogsIpcRequest = { ...REF, componentKey: "app", tail: 100 };
const routes: AppStackRoutesIpcRequest = { plan: PLAN, routes: [ROUTE] };
const VERIFIER = "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/";
/** ADR-0037: every option of a host at once, next to a host that redirects to it. */
const routesWithOptions: AppStackRoutesIpcRequest = {
  plan: PLAN,
  routes: [
    {
      componentKey: "app",
      internalPort: 8080,
      hosts: [
        {
          ...host("shop.example.org"),
          compress: true,
          protection: { username: "team", passwordHash: VERIFIER },
          paths: [{ pathPrefix: "/api", componentKey: "app", internalPort: 8080, stripPrefix: true }],
        },
        { hostname: "www.example.org", tls: true, httpsRedirect: true, redirectTo: "https://shop.example.org" },
      ],
    },
  ],
};

const pullResult: AppStackPullIpcResult = { image: pull.image, pulled: true };
const prepareResult: AppStackPrepareIpcResult = {
  networks: [
    { role: "app_internal", created: true },
    { role: "app_edge", created: false },
  ],
  volumes: [{ volumeKey: "data", created: true }],
};
const createResult: AppStackCreateIpcResult = {
  components: [
    { componentKey: "cache", outcome: "unchanged" },
    { componentKey: "app", outcome: "replaced" },
  ],
  removedComponents: ["old-web"],
};
const actionResult: AppStackComponentActionIpcResult = { componentKey: "app", outcome: "restarted" };
const stopResult: AppStackStopIpcResult = {
  components: [
    { componentKey: "app", outcome: "stopped" },
    { componentKey: "cache", outcome: "already_stopped" },
  ],
};
const routesResult: AppStackRoutesIpcResult = { routeCount: 1, hostnames: ["shop.example.org", "www.example.org"], changed: true };
const componentsRemoveResult: AppStackComponentsRemoveIpcResult = { removedComponents: ["old-web"] };
const removeResult: AppStackRemoveIpcResult = {
  removedComponents: ["app", "cache"],
  removedNetworks: ["app_internal", "app_edge"],
  removedVolumes: [],
  retainedVolumes: ["data"],
};
const statusResult: AppStackStatusIpcResult = {
  stackId: PLAN.stackId,
  observedAt: "2026-11-22T02:10:00.000Z",
  components: [
    {
      componentKey: "app",
      state: "running",
      health: "healthy",
      probe: "passed",
      componentHash: "a".repeat(64),
      revisionId: PLAN.revisionId,
      startedAt: "2026-11-22T02:09:00+01:00",
      restartCount: 0,
      exitCode: null,
      oomKilled: false,
    },
    {
      componentKey: "cache",
      state: "exited",
      health: "stopped",
      probe: "not_run",
      componentHash: null,
      revisionId: null,
      startedAt: null,
      restartCount: 3,
      exitCode: 137,
      oomKilled: true,
    },
  ],
  networks: { internal: true, edge: false },
  volumes: ["data"],
  routes: { published: true, hostnames: ["shop.example.org"] },
};
const logsResult: AppStackLogLineWire[] = [
  { at: "2026-11-22T02:09:01.000000000Z", stream: "stdout", text: "listening on 8080" },
  { at: null, stream: "stderr", text: "" },
];

const INSTANCES: [string, z.ZodType, unknown][] = [
  ["pull request", AppStackPullIpcRequestSchema, pull],
  ["plan request", AppStackPlanIpcRequestSchema, planOnly],
  ["component request", AppStackComponentIpcRequestSchema, component],
  ["ref request", AppStackRefIpcRequestSchema, REF],
  ["stop request", AppStackStopIpcRequestSchema, stop],
  ["remove request", AppStackRemoveIpcRequestSchema, remove],
  ["remove request with order", AppStackRemoveIpcRequestSchema, { ...remove, order: ORDER }],
  ["components remove request", AppStackComponentsRemoveIpcRequestSchema, componentsRemove],
  ["logs request", AppStackLogsIpcRequestSchema, logs],
  ["routes request", AppStackRoutesIpcRequestSchema, routes],
  ["routes request with options", AppStackRoutesIpcRequestSchema, routesWithOptions],
  ["pull result", AppStackPullIpcResultSchema, pullResult],
  ["prepare result", AppStackPrepareIpcResultSchema, prepareResult],
  ["create result", AppStackCreateIpcResultSchema, createResult],
  ["component action result", AppStackComponentActionIpcResultSchema, actionResult],
  ["stop result", AppStackStopIpcResultSchema, stopResult],
  ["routes result", AppStackRoutesIpcResultSchema, routesResult],
  ["components remove result", AppStackComponentsRemoveIpcResultSchema, componentsRemoveResult],
  ["remove result", AppStackRemoveIpcResultSchema, removeResult],
  ["status result", AppStackStatusIpcResultSchema, statusResult],
  ["logs result", AppStackLogsIpcResultSchema, logsResult],
];

/** Path of every plain object in the wire value; the plan has its own tests. */
const objectPaths = (value: unknown, path: (string | number)[] = []): (string | number)[][] => {
  if (Array.isArray(value)) return value.flatMap((item, index) => objectPaths(item, [...path, index]));
  if (value === null || typeof value !== "object") return [];
  return [
    path,
    ...Object.entries(value).flatMap(([key, nested]) => (key === "plan" ? [] : objectPaths(nested, [...path, key]))),
  ];
};
const at = (value: unknown, path: (string | number)[]): Record<string, unknown> =>
  path.reduce<unknown>((current, step) => (current as Record<string | number, unknown>)[step], value) as Record<string, unknown>;
const withExtraKeyAt = (value: unknown, path: (string | number)[]): unknown => {
  const copy = JSON.parse(JSON.stringify(value)) as unknown;
  at(copy, path).unexpected = true;
  return copy;
};
const wireKeys = (value: unknown): string[] => objectPaths(value).flatMap((path) => Object.keys(at(value, path)));

/** §2.4 key list of arch-executor. */
const WIRE_KEY_NAMES = (
  "plan image componentKey secretFileContents parameterKey version content stackId organizationId removeVolumes tail " +
  "internalPort hosts hostname tls httpsRedirect redirectTo challenge source routes pulled networks role created volumes " +
  "volumeKey components outcome removedComponents routeCount hostnames changed removedNetworks removedVolumes " +
  "retainedVolumes componentKeys state health probe componentHash revisionId startedAt restartCount exitCode oomKilled " +
  "observedAt internal edge published at stream text compress protection username paths pathPrefix stripPrefix order"
).split(" ");
/** ADR-0037 R3: the one wire key that is forbidden in a public DTO on purpose, so a leak of it is blocked and redacted. */
const VERIFIER_KEY = "passwordHash";

const issuesText = (result: { success: boolean; error?: { issues: unknown; message: string } }): string =>
  JSON.stringify(result.error?.issues) + String(result.error?.message);

describe("application stack IPC wire", () => {
  it("one valid instance of every request and result schema round-trips", () => {
    for (const [name, schema, value] of INSTANCES) expect(schema.parse(value), name).toEqual(value);
    expect(appTemplates.AppStackStatusIpcResultSchema).toBe(AppStackStatusIpcResultSchema);
  });

  it("an extra key is refused at every object", () => {
    for (const [name, schema, value] of INSTANCES) {
      const paths = objectPaths(value);
      expect(paths.length, name).toBeGreaterThan(0);
      for (const path of paths) {
        expect(schema.safeParse(withExtraKeyAt(value, path)).success, `${name} at ${JSON.stringify(path)}`).toBe(false);
      }
    }
  });

  it("every request accepts a UUID-form organisation and allocation id and refuses a foreign-form stack id", () => {
    const organizationId = "org_3984baf6-928d-40dd-b388-bfac50b5e54f";
    const foreignPlan = { ...PLAN, organizationId, hostAllocationId: "alloc_3984baf6-928d-40dd-b388-bfac50b5e54f" };
    const requests = INSTANCES.filter(([name]) => name.endsWith("request"));
    expect(requests).toHaveLength(9);
    for (const [name, schema, value] of requests) {
      const request = value as Record<string, unknown>;
      const foreign = "plan" in request ? { ...request, plan: foreignPlan } : { ...request, organizationId };
      expect(schema.safeParse(foreign).success, name).toBe(true);
    }
    for (const stackId of ["stk_3984baf6-928d", `s${"a".repeat(64)}`]) {
      expect(AppStackRefIpcRequestSchema.safeParse({ stackId, organizationId }).success).toBe(false);
    }
    expect(AppStackRefIpcRequestSchema.safeParse({ ...REF, organizationId: `o${"a".repeat(128)}` }).success).toBe(false);
  });

  it("bounds the secret content and never echoes it in an issue", () => {
    const sentinel = "SENTINEL-SECRET-CONTENT";
    expect(AppStackSecretFileContentSchema.safeParse({ ...SECRET, content: "x".repeat(APP_STACK_SECRET_CONTENT_MAX_CHARS) }).success).toBe(true);
    expect(AppStackSecretFileContentSchema.safeParse({ ...SECRET, content: "a\tb\r\nc\u007f\u0085\u{1f511}" }).success).toBe(true);
    const controls = ["\u0000", "\u0001", "\u000b", "\u000c", "\u001f", "\ud800"].map((c) => `${sentinel}${c}tail`);
    for (const content of ["", sentinel + "x".repeat(APP_STACK_SECRET_CONTENT_MAX_CHARS), ...controls, `\udc00${sentinel}`]) {
      const result = AppStackComponentIpcRequestSchema.safeParse({ ...component, secretFileContents: [{ ...SECRET, content }] });
      expect(result.success).toBe(false);
      expect(issuesText(result)).not.toContain(sentinel);
    }
    for (const version of [0, 1.5, 2_147_483_648]) {
      expect(AppStackSecretFileContentSchema.safeParse({ ...SECRET, version }).success).toBe(false);
    }
    expect(AppStackSecretFileContentSchema.safeParse({ ...SECRET, parameterKey: "hp_secret" }).success).toBe(false);
  });

  it("the largest start request the schema allows stays under the executor's 1 MiB body cap", () => {
    const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
    const sized = (extra: number): ApprovedStackPlan => {
      const plan = structuredClone(PLAN);
      const app = plan.components.find((c) => c.key === "app")!;
      const environment = Array.from({ length: 63 }, (_, i) => ({ name: `E${String(i).padStart(3, "0")}`, value: "a".repeat(4_096) }));
      Object.assign(app, { secretFiles: [], environment: [...environment, { name: "Z", value: "b".repeat(extra) }] });
      return plan;
    };
    const plan = sized(APP_STACK_PLAN_MAX_BYTES - bytes(sized(0)));
    expect(bytes(plan)).toBe(APP_STACK_PLAN_MAX_BYTES);
    let worst = "a";
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const char = String.fromCharCode(unit);
      if (bytes(char) > bytes(worst) && AppStackSecretFileContentSchema.safeParse({ ...SECRET, content: char }).success) worst = char;
    }
    const secretFileContents = Array.from({ length: 8 }, (_, i) => ({
      parameterKey: `s${String(i)}${"x".repeat(30)}`,
      version: 2_147_483_647,
      content: worst.repeat(APP_STACK_SECRET_CONTENT_MAX_CHARS),
    }));
    const request = { plan, componentKey: `a${"b".repeat(31)}`, secretFileContents };
    expect(AppStackComponentIpcRequestSchema.safeParse(request).success).toBe(true);
    expect(bytes(request)).toBeLessThan(1_048_576); // = MAX_IPC_BODY_BYTES, docker-executor server.ts
  });

  it("refuses a duplicate parameterKey and more than eight secret entries", () => {
    const duplicate = AppStackSecretFileContentsSchema.safeParse([SECRET, { ...SECRET, version: 2, content: "other" }]);
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues.map(({ path, message }) => ({ path, message }))).toEqual([
      { path: [1, "parameterKey"], message: "Duplicate secret entry" },
    ]);
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ ...SECRET, parameterKey: `secret_${i}` }));
    expect(AppStackSecretFileContentsSchema.safeParse(entries(8)).success).toBe(true);
    expect(AppStackSecretFileContentsSchema.safeParse(entries(9)).success).toBe(false);
    expect(AppStackComponentIpcRequestSchema.safeParse({ ...component, secretFileContents: [] }).success).toBe(true);
  });

  it("refuses duplicate, empty and too many component keys to remove", () => {
    const parse = (componentKeys: string[]) => AppStackComponentsRemoveIpcRequestSchema.safeParse({ plan: PLAN, componentKeys }).success;
    expect(parse(["a", "b", "c", "d", "e", "f", "g", "h"])).toBe(true);
    expect(parse([])).toBe(false);
    expect(parse(["a", "a"])).toBe(false);
    expect(parse(["a", "b", "c", "d", "e", "f", "g", "h", "i"])).toBe(false);
    expect(parse(["old_web"])).toBe(false);
  });

  it("takes the applied plan's order on a stop and a remove, and on nothing else", () => {
    const parseStop = (order?: unknown) => AppStackStopIpcRequestSchema.safeParse(order === undefined ? REF : { ...REF, order }).success;
    const parseRemove = (order?: unknown) => AppStackRemoveIpcRequestSchema.safeParse({ ...remove, ...(order === undefined ? {} : { order }) }).success;
    for (const parse of [parseStop, parseRemove]) {
      expect(parse()).toBe(true);
      expect(parse(["a", "b", "c", "d", "e", "f", "g", "h"])).toBe(true);
      expect(parse(["old-web"])).toBe(true);
      expect(parse([])).toBe(false);
      expect(parse(["a", "a"])).toBe(false);
      expect(parse(["a", "b", "c", "d", "e", "f", "g", "h", "i"])).toBe(false);
      expect(parse(["Web"])).toBe(false);
      expect(parse(["a b"])).toBe(false);
      expect(parse([""])).toBe(false);
      expect(parse([1])).toBe(false);
      expect(parse("web")).toBe(false);
      expect(parse(null)).toBe(false);
    }
    // A request without the field is what an older API sends: it parses to the same value as before.
    expect(AppStackStopIpcRequestSchema.parse(REF)).toEqual(REF);
    expect(AppStackRemoveIpcRequestSchema.parse(remove)).toEqual(remove);
    // The calls that share the Ref schema (unpublish, status, logs, terminal) do not take it.
    expect(AppStackRefIpcRequestSchema.safeParse({ ...REF, order: ORDER }).success).toBe(false);
    expect(AppStackLogsIpcRequestSchema.safeParse({ ...logs, order: ORDER }).success).toBe(false);
  });

  it("refuses empty hosts, more than eight hostnames, duplicate hostnames and duplicate routes", () => {
    const parse = (list: AppStackRouteWire[]) => AppStackRoutesIpcRequestSchema.safeParse({ plan: PLAN, routes: list }).success;
    const hosts = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => host(`${prefix}${i}.example.org`));
    expect(parse([])).toBe(true);
    expect(parse([{ ...ROUTE, hosts: [] }])).toBe(false);
    expect(parse([{ ...ROUTE, hosts: hosts("a", 5) }, { ...ROUTE, internalPort: 8081, hosts: hosts("b", 3) }])).toBe(true);
    expect(parse([{ ...ROUTE, hosts: hosts("a", 5) }, { ...ROUTE, internalPort: 8081, hosts: hosts("b", 4) }])).toBe(false);
    expect(parse([{ ...ROUTE, hosts: hosts("a", 9) }])).toBe(false);
    expect(parse([{ ...ROUTE, hosts: hosts("a", 2) }, { ...ROUTE, internalPort: 8081, hosts: hosts("a", 1) }])).toBe(false);
    expect(parse([{ ...ROUTE, hosts: hosts("a", 1) }, { ...ROUTE, hosts: hosts("b", 1) }])).toBe(false);
    expect(parse([{ ...ROUTE, hosts: hosts("a", 1) }, { ...ROUTE, componentKey: "cache", hosts: hosts("b", 1) }])).toBe(true);
    expect(parse([{ ...ROUTE, internalPort: 0 }])).toBe(false);
  });

  it("bounds the log tail", () => {
    const parse = (tail: unknown) => AppStackLogsIpcRequestSchema.safeParse({ ...logs, tail }).success;
    expect([1, APP_STACK_LOG_TAIL_MAX].map(parse)).toEqual([true, true]);
    expect([0, APP_STACK_LOG_TAIL_MAX + 1, 1.5, "10"].map(parse)).toEqual([false, false, false, false]);
    expect(AppStackLogsIpcResultSchema.safeParse(Array.from({ length: APP_STACK_LOG_TAIL_MAX + 1 }, () => logsResult[0])).success).toBe(false);
  });

  it("names the component and the tail only: the executor learns which secret files a container holds from the container", () => {
    expect(Object.keys(AppStackLogsIpcRequestSchema.shape).sort()).toEqual(["componentKey", "organizationId", "stackId", "tail"]);
    expect(AppStackLogsIpcRequestSchema.parse(logs)).toEqual(logs);
  });

  it("lists twelve executor reasons, each mapped to an error code by a total frozen map", () => {
    expect(APP_STACK_EXECUTOR_REASONS).toHaveLength(12);
    expect(new Set(APP_STACK_EXECUTOR_REASONS).size).toBe(12);
    for (const reason of APP_STACK_EXECUTOR_REASONS) {
      expect(reason).toMatch(/^STACK_[A-Z_]{1,40}$/);
      expect(AppStackExecutorReasonSchema.parse(reason)).toBe(reason);
      expect(ERROR_CODES).toContain(APP_STACK_EXECUTOR_REASON_CODES[reason]);
    }
    expect(Object.keys(APP_STACK_EXECUTOR_REASON_CODES).sort()).toEqual([...APP_STACK_EXECUTOR_REASONS].sort());
    expect(Object.isFrozen(APP_STACK_EXECUTOR_REASON_CODES)).toBe(true);
    expect(APP_STACK_EXECUTOR_REASONS.filter((r) => (APP_STACK_REASONS as readonly string[]).includes(r))).toEqual([
      "STACK_IMAGE_NOT_ALLOWED",
      "STACK_SECRET_MISSING",
      "STACK_VOLUME_IN_USE",
      "STACK_UNSUPPORTED_FEATURE",
    ]);
    expect(AppStackExecutorReasonSchema.safeParse("TLS_FOO").success).toBe(false);
  });

  it("no wire key name is a forbidden public or plaintext secret key", () => {
    for (const [name, , value] of INSTANCES) {
      const forbidden = name === "routes request with options" ? ["routes[0].hosts[0].protection.passwordHash"] : [];
      expect(findForbiddenPublicDtoKeys(value), name).toEqual(forbidden);
      expect(findPlaintextSecretKeys(value), name).toEqual([]);
      for (const key of wireKeys(value)) expect([...WIRE_KEY_NAMES, VERIFIER_KEY], `${name}: ${key}`).toContain(key);
    }
    expect(redactSensitiveValue(routesWithOptions.routes[0]!.hosts[0]!.protection)).toEqual({ username: "team", passwordHash: "[REDACTED]" });
    const keyObject = Object.fromEntries(WIRE_KEY_NAMES.map((key) => [key, "value"]));
    expect(findForbiddenPublicDtoKeys(keyObject)).toEqual([]);
    expect(findPlaintextSecretKeys(keyObject)).toEqual([]);
  });
});
