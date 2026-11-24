import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppStackSecretFileContentSchema, type ApprovedStackPlan, type ApprovedStackPlanV2 } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_STACK_RESOLVE_ENGINE_TIMEOUT_MS,
  APP_STACK_STANDARD_CAP_ADD,
  AppStackEngine,
  assertAppStackCreateSecretContents,
  assertAppStackPayloadHardening,
  assertAppStackSecretContents,
  assertExecutableAppStackPlan,
  buildAppStackContainerCreatePayload,
  expandAppStackSecretEnvironment,
  type AppStackContainerCreatePayload,
} from "../src/app-stacks/index.js";
import { InMemoryDockerSimulatorAdapter } from "../src/index.js";
import { createAppStackFakeEngine, type FakeContainer } from "./support/app-stack-fake-engine.js";
import {
  TEST_ALLOWLIST,
  V2_CREATE_SECRETS,
  V2_SECRET_VALUES,
  appStackTestPlan,
  appStackTestPlanV2,
  rehash,
  v2SecretEntry,
} from "./support/app-stack-plans.js";

const ID = "stk_0123456789abcdef";
const ORG = "org_acme";
const REF = { stackId: ID, organizationId: ORG };
const IMAGE = `registry.test/acme/web@sha256:${"c".repeat(64)}`;
const V2_WEB = `registry.test/acme/blog@sha256:${"d".repeat(64)}`;
const V2_DB = `db.registry.test/acme/sql@sha256:${"e".repeat(64)}`;
const NET = `hp_appnet_${ID}`;
const EDGE = `hp_appedge_${ID}`;
const DB = `hp_app_${ID}_db`;
const WEB = `hp_app_${ID}_web`;
const CACHE = `hp_app_${ID}_cache`;
const ROOT = "/run/hp-test-secrets";
const enc = encodeURIComponent;
const { db_password: DB_PASSWORD, db_root_password: DB_ROOT_PASSWORD, app_key: APP_KEY } = V2_SECRET_VALUES;
const VALUES = Object.values(V2_SECRET_VALUES);
const CONTENTS = { db_password: DB_PASSWORD, db_root_password: DB_ROOT_PASSWORD };
const DB_SECRETS = [v2SecretEntry("db_password"), v2SecretEntry("db_root_password")];
const WEB_SECRETS = [v2SecretEntry("app_key"), v2SecretEntry("db_password")];
const SECRET_ENV_LABEL = "io.hostingpanel.app_secret_env";

const plan = appStackTestPlanV2();
const build = (key: string, from: ApprovedStackPlan = plan, contents: Readonly<Record<string, string>> = CONTENTS) =>
  buildAppStackContainerCreatePayload(from, key, { secretsRootDir: ROOT, secretContents: contents });
/** `null`: the check without the plan. */
const harden = (body: AppStackContainerCreatePayload, from: ApprovedStackPlan | null = plan) =>
  assertAppStackPayloadHardening(body, from === null ? { secretsRootDir: ROOT } : { secretsRootDir: ROOT, plan: from });
const rule = (name: string) => ({ code: "HOST_POLICY_DENIED", message: `The application container body breaks the ${name} rule` });
/** Everything an error can carry to a caller or a log. */
const shown = (err: unknown) => JSON.stringify([String(err), err, (err as Error).stack ?? ""]);
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}
const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (err: unknown) => err,
  );

/** The plan with every reference to db_password moved to another version. */
function withDbPasswordVersion(version: number): ApprovedStackPlanV2 {
  const next = structuredClone(plan);
  for (const component of next.components) {
    for (const entry of component.secretEnvironment) {
      for (const piece of entry.pieces) {
        if ("parameterKey" in piece && piece.parameterKey === "db_password") piece.version = version;
      }
    }
  }
  return rehash(next);
}

/** The plan with web's BLOG_DB_PASSWORD left out: db_password reaches web only inside its URL. */
function withEmbeddedOnly(): ApprovedStackPlanV2 {
  const next = structuredClone(plan);
  next.components[1]!.secretEnvironment = next.components[1]!.secretEnvironment.filter((entry) => entry.name !== "BLOG_DB_PASSWORD");
  return rehash(next);
}

/** The plan where db reads its two secrets only inside one value, with `separator` between them (null: none). */
function withPair(separator: string | null): ApprovedStackPlanV2 {
  const next = structuredClone(plan);
  next.components[0]!.secretEnvironment = [
    {
      name: "DB_PAIR",
      pieces: [
        { parameterKey: "db_password", version: 1 },
        ...(separator === null ? [] : [{ literal: separator }]),
        { parameterKey: "db_root_password", version: 1 },
      ],
    },
  ];
  return rehash(next);
}

describe("the container body of a version 2 plan", () => {
  it('builds the "standard" body: writable root, the fixed capability set, 512 processes, the image user', () => {
    expect(build("db")).toEqual({
      Image: V2_DB,
      Env: ["DB_NAME=blog", `DB_PASSWORD=${DB_PASSWORD}`, `DB_ROOT_PASSWORD=${DB_ROOT_PASSWORD}`],
      Labels: expect.any(Object) as unknown,
      ExposedPorts: { "3306/tcp": {} },
      StopTimeout: 10,
      HostConfig: {
        Privileged: false,
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID", "NET_BIND_SERVICE"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: false,
        PidsLimit: 512,
        NanoCpus: 500_000_000,
        Memory: 536_870_912,
        MemorySwap: 536_870_912,
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: NET,
        Binds: [],
        Mounts: [{ Type: "volume", Source: `hp_appvol_${ID}_dbdata`, Target: "/var/lib/sql", ReadOnly: false }],
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      },
      NetworkingConfig: { EndpointsConfig: { [NET]: { Aliases: ["db"] } } },
    });
    expect(APP_STACK_STANDARD_CAP_ADD).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID", "NET_BIND_SERVICE"]);
    expect(Object.isFrozen(APP_STACK_STANDARD_CAP_ADD)).toBe(true);
  });

  it("puts the plain entries first, then the secret file paths, then the environment secrets; only file secrets are mounted", () => {
    const body = build("web");
    expect(body.Env).toEqual([
      "BLOG_DB_HOST=db",
      "APP_KEY_FILE=/run/secrets/app_key",
      `BLOG_DB_PASSWORD=${DB_PASSWORD}`,
      `BLOG_DB_URL=sql://blog:${DB_PASSWORD}@db:3306/blog`,
    ]);
    expect(body.HostConfig.Binds).toEqual([`${ROOT}/app_${ID}__web/app_key:/run/secrets/app_key:ro`]);
    expect(body.NetworkingConfig.EndpointsConfig).toEqual({ [NET]: { Aliases: ["web"] }, [EDGE]: { Aliases: [WEB] } });
    expect(JSON.stringify(body)).not.toContain(APP_KEY);
    expect("User" in body).toBe(false);
  });

  it('keeps the version 1 body for a "strict" component', () => {
    const body = build("cache");
    const v1 = buildAppStackContainerCreatePayload(appStackTestPlan(), "web", { secretsRootDir: ROOT });
    expect(Object.keys(body)).toEqual(Object.keys(v1).filter((key) => key !== "Cmd"));
    expect(Object.keys(body.HostConfig)).toEqual(Object.keys(v1.HostConfig));
    expect(body.User).toBe("65534:65534");
    expect(body.HostConfig).toMatchObject({
      Privileged: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=64m" },
      PidsLimit: 256,
    });
    expect("CapAdd" in body.HostConfig).toBe(false);
    expect(body.Env).toEqual([]);
  });

  it("labels the environment secrets with their names and the template text around each reference, and no value", () => {
    expect(build("db").Labels[SECRET_ENV_LABEL]).toBe('[["DB_PASSWORD",null],["DB_ROOT_PASSWORD",null]]');
    expect(build("web").Labels[SECRET_ENV_LABEL]).toBe('[["BLOG_DB_PASSWORD",null],["BLOG_DB_URL","sql://blog:",null,"@db:3306/blog"]]');
    expect(build("db", withPair(null)).Labels[SECRET_ENV_LABEL]).toBe('[["DB_PAIR",null,null]]');
    expect(SECRET_ENV_LABEL in build("cache").Labels).toBe(false);
    for (const key of ["web", "worker"]) {
      expect(SECRET_ENV_LABEL in buildAppStackContainerCreatePayload(appStackTestPlan(), key, { secretsRootDir: ROOT }).Labels).toBe(false);
    }
    for (const component of plan.components) {
      for (const value of VALUES) expect(JSON.stringify(build(component.key).Labels)).not.toContain(value);
    }
  });

  it("no body of the plan names a host port, a device, the host network or a host path", () => {
    for (const component of plan.components) {
      const text = JSON.stringify(build(component.key));
      for (const key of ["PortBindings", "PublishAllPorts", "Devices", "PidMode", "IpcMode", "UsernsMode", "Entrypoint", "docker.sock"]) {
        expect(text).not.toContain(key);
      }
    }
  });

  it.each([
    ["no contents at all", undefined],
    ["the contents of another secret", { db_root_password: DB_ROOT_PASSWORD }],
    ["a value that is only inherited", Object.create({ db_password: DB_PASSWORD }) as Record<string, string>],
  ])("refuses to build with %s and names no value", (_name, contents) => {
    const err = thrown(() =>
      buildAppStackContainerCreatePayload(plan, "web", { secretsRootDir: ROOT, ...(contents === undefined ? {} : { secretContents: contents }) }),
    );
    expect(err).toMatchObject({ reason: "STACK_SECRET_MISSING", message: "A secret of component web is missing" });
    for (const value of VALUES) expect(shown(err)).not.toContain(value);
  });

  it("bounds an expanded value at 32 768 UTF-8 bytes and names no value", () => {
    const [db, web] = plan.components;
    const exact = "p".repeat(32_768);
    expect(expandAppStackSecretEnvironment(db!, { db_password: exact, db_root_password: "r" })).toEqual([
      `DB_PASSWORD=${exact}`,
      "DB_ROOT_PASSWORD=r",
    ]);
    for (const [component, contents] of [
      [db!, { db_password: `${exact}p`, db_root_password: "r" }],
      [db!, { db_password: "é".repeat(16_385), db_root_password: "r" }],
      [web!, { db_password: exact }],
    ] as const) {
      const err = thrown(() => expandAppStackSecretEnvironment(component, contents));
      expect(err).toMatchObject({
        reason: "STACK_PLAN_INVALID",
        message: `An environment value of component ${component.key} is too long`,
      });
      expect(shown(err)).not.toContain("pppp");
    }
    expect(expandAppStackSecretEnvironment(plan.components[2]!, {})).toEqual([]);
    expect(expandAppStackSecretEnvironment(appStackTestPlan().components[1]!, {})).toEqual([]);
  });

  it("refuses a value whose pieces spell a platform mark only once joined, and names no value (ADR-0041 §4)", () => {
    // Each piece passes the mark rule alone: the schema of the secret contents checks one content at a time.
    for (const content of ["xHP_TERMINAL_", "SESSION=term_", "HP_TERMINAL_", "HP_TASK_", "RUN=srun_1"]) {
      expect(AppStackSecretFileContentSchema.safeParse({ parameterKey: "db_password", version: 1, content }).success, content).toBe(true);
    }
    const refused: ReadonlyArray<readonly [separator: string | null, first: string, second: string]> = [
      [null, "xHP_TERMINAL_", "SESSION=term_"], // DB_PAIR: "${db_password}${db_root_password}"
      ["SESSION=", "HP_TERMINAL_", "term_1"],
      [null, "HP_TASK_", "RUN=srun_1"],
    ];
    for (const [separator, first, second] of refused) {
      const pair = withPair(separator);
      const contents = { db_password: first, db_root_password: second };
      for (const attempt of [
        () => expandAppStackSecretEnvironment(pair.components[0]!, contents),
        () => build("db", pair, contents),
      ]) {
        const err = thrown(attempt);
        expect(err).toMatchObject({ reason: "STACK_PLAN_INVALID", message: "An environment value of component db holds the mark of a platform process" });
        for (const value of [first, second]) expect(shown(err)).not.toContain(value);
      }
    }
    // Joined text that holds no mark is the value as before.
    expect(expandAppStackSecretEnvironment(withPair(null).components[0]!, { db_password: "-d PHP_", db_root_password: "INI_SCAN_DIR=/x" })).toEqual([
      "DB_PAIR=-d PHP_INI_SCAN_DIR=/x",
    ]);
  });
});

describe("the hardening check of a version 2 body", () => {
  it("accepts every body of the plan with the plan", () => {
    for (const component of plan.components) expect(() => harden(build(component.key))).not.toThrow();
  });

  it('refuses a "standard" body without the plan, and accepts the "strict" one', () => {
    expect(thrown(() => harden(build("db"), null))).toMatchObject(rule("HostConfig keys"));
    expect(thrown(() => harden(build("web"), null))).toMatchObject(rule("HostConfig keys"));
    expect(() => harden(build("cache"), null)).not.toThrow();
    const labelled = structuredClone(build("cache"));
    (labelled.Labels as Record<string, string>)[SECRET_ENV_LABEL] = '[["DB_PASSWORD",null]]';
    expect(thrown(() => harden(labelled, null))).toMatchObject(rule("Labels"));
  });

  it("refuses a body whose component is not in the plan", () => {
    const other = appStackTestPlanV2({ stackId: "stk_fedcba9876543210" });
    expect(thrown(() => harden(build("db"), other))).toMatchObject(rule("Labels"));
    expect(thrown(() => harden(build("db"), appStackTestPlanV2({ components: [plan.components[2]!], volumes: [], ingress: [] })))).toMatchObject(
      rule("Labels"),
    );
  });

  type Host = Record<string, unknown>;
  /** The body as a tampering caller sees it: writable. */
  type Body = { User?: string; Env: string[] } & Record<string, unknown>;
  const labelsOf = (body: Body) => body.Labels as Record<string, string>;
  const cases: Array<[string, string, string, (body: Body, host: Host) => void]> = [
    ["one more capability", "db", "CapAdd", (_b, host) => void (host.CapAdd = [...APP_STACK_STANDARD_CAP_ADD, "SYS_ADMIN"])],
    ["another capability", "db", "CapAdd", (_b, host) => void (host.CapAdd = ["NET_ADMIN"])],
    ["the capability set in another order", "db", "CapAdd", (_b, host) => void (host.CapAdd = [...APP_STACK_STANDARD_CAP_ADD].reverse())],
    ["no capability set", "db", "CapAdd", (_b, host) => void delete host.CapAdd],
    ["every capability", "db", "CapAdd", (_b, host) => void (host.CapAdd = ["ALL"])],
    ["nothing dropped", "db", "CapDrop", (_b, host) => void (host.CapDrop = [])],
    ["privileged", "db", "Privileged", (_b, host) => void (host.Privileged = true)],
    ["new privileges allowed", "db", "SecurityOpt", (_b, host) => void (host.SecurityOpt = [])],
    ["an unconfined seccomp profile", "db", "SecurityOpt", (_b, host) => void (host.SecurityOpt = ["no-new-privileges:true", "seccomp=unconfined"])],
    ["a /tmp tmpfs", "db", "HostConfig keys", (_b, host) => void (host.Tmpfs = { "/tmp": "rw,noexec,nosuid,nodev,size=64m" })],
    ["a device", "db", "HostConfig keys", (_b, host) => void (host.Devices = [])],
    ["a host port", "db", "HostConfig keys", (_b, host) => void (host.PortBindings = {})],
    ["the host PID namespace", "db", "HostConfig keys", (_b, host) => void (host.PidMode = "host")],
    ["a read-only root", "db", "ReadonlyRootfs", (_b, host) => void (host.ReadonlyRootfs = true)],
    ["the strict process limit", "db", "PidsLimit", (_b, host) => void (host.PidsLimit = 256)],
    ["a larger process limit", "db", "PidsLimit", (_b, host) => void (host.PidsLimit = 4096)],
    ["no process limit", "db", "PidsLimit", (_b, host) => void (host.PidsLimit = -1)],
    ["swap", "db", "Memory", (_b, host) => void (host.MemorySwap = -1)],
    ["the host network", "db", "NetworkMode", (_b, host) => void (host.NetworkMode = "host")],
    ["a host path", "db", "Binds", (_b, host) => void (host.Binds = ["/etc:/host-etc:ro"])],
    ["a bind mount", "db", "Mounts", (_b, host) => void (host.Mounts = [{ Type: "bind", Source: "/", Target: "/host", ReadOnly: true }])],
    ["a user", "db", "User", (body) => void (body.User = "0:0")],
    ["an entry point", "db", "body keys", (body) => void (body.Entrypoint = ["/bin/sh"])],
    ["one more environment entry", "db", "Env", (body) => void body.Env.push("EXTRA=1")],
    ["one more entry before the secrets", "db", "Env", (body) => void body.Env.splice(1, 0, "EXTRA=1")],
    ["a changed plain entry", "db", "Env", (body) => void (body.Env[0] = "DB_NAME=other")],
    ["an environment secret under another name", "db", "Env", (body) => void (body.Env[1] = `OTHER=${DB_PASSWORD}`)],
    ["the environment secrets in another order", "db", "Env", (body) => void body.Env.push(body.Env.splice(1, 1)[0]!)],
    ["an environment secret left out", "db", "Env", (body) => void body.Env.pop()],
    ["a changed secret file path", "web", "Env", (body) => void (body.Env[1] = "APP_KEY_FILE=/run/secrets/other")],
    ["no entry at all", "web", "Env", (body) => void (body.Env.length = 0)],
    ["a capability set on a strict component", "cache", "HostConfig keys", (_b, host) => void (host.CapAdd = [...APP_STACK_STANDARD_CAP_ADD])],
    ["a writable root on a strict component", "cache", "ReadonlyRootfs", (_b, host) => void (host.ReadonlyRootfs = false)],
    ["the standard process limit on a strict component", "cache", "PidsLimit", (_b, host) => void (host.PidsLimit = 512)],
    ["no /tmp tmpfs on a strict component", "cache", "Tmpfs", (_b, host) => void delete host.Tmpfs],
    ["an environment entry on a component without any", "cache", "Env", (body) => void body.Env.push("EXTRA=1")],
    ["another secret environment label", "web", "Labels", (body) => void (labelsOf(body)[SECRET_ENV_LABEL] = '[["BLOG_DB_URL",null]]')],
    ["no secret environment label", "web", "Labels", (body) => void delete labelsOf(body)[SECRET_ENV_LABEL]],
    ["a secret environment label on a component without any", "cache", "Labels", (body) => void (labelsOf(body)[SECRET_ENV_LABEL] = "[]")],
  ];
  it.each(cases)("refuses %s (%s: %s)", (_name, key, broken, change) => {
    const body = structuredClone(build(key));
    change(body as unknown as Body, body.HostConfig as unknown as Host);
    const err = thrown(() => harden(body));
    expect(err).toMatchObject(rule(broken));
    for (const value of VALUES) expect(shown(err)).not.toContain(value);
  });

  it("takes the value of an environment secret as opaque, but not the text the plan puts around it", () => {
    const contents = { db_password: "pw /var/run/docker.sock", db_root_password: "unix:///docker.sock" };
    expect(() => harden(build("db", plan, contents))).not.toThrow();
    expect(() => harden(build("web", plan, contents))).not.toThrow();

    const crafted = structuredClone(plan);
    const url = crafted.components[1]!.secretEnvironment[1]!.pieces[0]!;
    if ("literal" in url) url.literal = "unix:///run/docker.sock?";
    expect(thrown(() => harden(build("web", crafted), crafted))).toMatchObject(rule("host socket"));

    const plain = structuredClone(plan);
    plain.components[0]!.environment[0]!.value = "/run/Docker.Sock";
    expect(thrown(() => harden(build("db", plain), plain))).toMatchObject(rule("host socket"));
  });
});

describe("the plan and secret checks of a version 2 plan", () => {
  const check = (input: unknown) => assertExecutableAppStackPlan(input, { allowlist: TEST_ALLOWLIST });

  it("accepts digest-pinned images outside the allowlist", () => {
    expect(check(plan)).toEqual(plan);
    expect(check(appStackTestPlanV2({ components: [plan.components[2]!], volumes: [], ingress: [] })).components).toHaveLength(1);
  });

  it("refuses a user the allowlist row does not give, and an image without a digest", () => {
    const [db, web, cache] = plan.components;
    const rootCache = rehash({ ...plan, components: [db!, web!, { ...cache!, runAsUser: null }] });
    expect(thrown(() => check(rootCache))).toMatchObject({
      reason: "STACK_IMAGE_NOT_ALLOWED",
      message: "The image of component cache is not allowed (user_mismatch)",
    });
    const chosenUser = rehash({ ...plan, components: [{ ...db!, runAsUser: "0:0" }, web!, cache!] });
    expect(thrown(() => check(chosenUser))).toMatchObject({ reason: "STACK_IMAGE_NOT_ALLOWED" });
    const tagged = rehash({ ...plan, components: [{ ...db!, image: "db.registry.test/acme/sql:12" }, web!, cache!] });
    expect(thrown(() => check(tagged))).toMatchObject({ reason: expect.stringMatching(/^STACK_(PLAN_INVALID|IMAGE_NOT_ALLOWED)$/) as unknown });
  });

  it.each([
    ["a profile outside the closed list", (c: Record<string, unknown>) => void (c.profile = "privileged")],
    ["a capability list", (c: Record<string, unknown>) => void (c.capAdd = ["SYS_ADMIN"])],
    ["a privileged flag", (c: Record<string, unknown>) => void (c.privileged = true)],
    ["a host path", (c: Record<string, unknown>) => void (c.binds = ["/:/host"])],
    ["a device", (c: Record<string, unknown>) => void (c.devices = ["/dev/sda"])],
    ["the host network", (c: Record<string, unknown>) => void (c.networkMode = "host")],
    ["a published port", (c: Record<string, unknown>) => void (c.ports = ["80:80"])],
  ])("refuses a plan component with %s", (_name, change) => {
    const next = structuredClone(plan) as unknown as { components: Array<Record<string, unknown>> };
    change(next.components[0]!);
    expect(thrown(() => check(rehash(next as unknown as ApprovedStackPlanV2)))).toMatchObject({ reason: "STACK_PLAN_INVALID" });
  });

  it("start takes the file and the environment secrets of one component", () => {
    expect(assertAppStackSecretContents(plan, "db", DB_SECRETS)).toEqual(CONTENTS);
    expect(assertAppStackSecretContents(plan, "web", WEB_SECRETS)).toEqual({ app_key: APP_KEY, db_password: DB_PASSWORD });
    expect(assertAppStackSecretContents(plan, "cache", [])).toEqual({});
    const missing = thrown(() => assertAppStackSecretContents(plan, "web", [v2SecretEntry("app_key")]));
    expect(missing).toMatchObject({ reason: "STACK_SECRET_MISSING", message: "A secret of component web is missing" });
    expect(thrown(() => assertAppStackSecretContents(plan, "web", [v2SecretEntry("db_password")]))).toMatchObject({ reason: "STACK_SECRET_MISSING" });
    const stale = thrown(() => assertAppStackSecretContents(plan, "db", [v2SecretEntry("db_password", 2), v2SecretEntry("db_root_password")]));
    expect(stale).toMatchObject({ reason: "STACK_PLAN_INVALID", message: "A secret entry is not part of the plan" });
    const twice = thrown(() => assertAppStackSecretContents(plan, "db", [...DB_SECRETS, v2SecretEntry("db_password")]));
    expect(twice).toMatchObject({ reason: "STACK_PLAN_INVALID", message: "A secret of component db has more than one entry" });
    for (const err of [missing, stale, twice]) for (const value of VALUES) expect(shown(err)).not.toContain(value);
  });

  it("create takes exactly the environment secrets of the plan", () => {
    expect(assertAppStackCreateSecretContents(plan, V2_CREATE_SECRETS)).toEqual(CONTENTS);
    expect(assertAppStackCreateSecretContents(plan, [...V2_CREATE_SECRETS].reverse())).toEqual(CONTENTS);
    const refusals: Array<[unknown, object]> = [
      [thrown(() => assertAppStackCreateSecretContents(plan, undefined)), { reason: "STACK_SECRET_MISSING", message: "A secret of the application is missing" }],
      [thrown(() => assertAppStackCreateSecretContents(plan, [v2SecretEntry("db_password")])), { reason: "STACK_SECRET_MISSING" }],
      [
        thrown(() => assertAppStackCreateSecretContents(plan, [...V2_CREATE_SECRETS, v2SecretEntry("app_key")])),
        { reason: "STACK_PLAN_INVALID", message: "A secret entry is not part of the plan" },
      ],
      [
        thrown(() => assertAppStackCreateSecretContents(plan, [v2SecretEntry("db_password", 2), v2SecretEntry("db_root_password")])),
        { reason: "STACK_PLAN_INVALID", message: "A secret entry is not part of the plan" },
      ],
      [
        thrown(() => assertAppStackCreateSecretContents(plan, [...V2_CREATE_SECRETS, v2SecretEntry("db_password")])),
        { reason: "STACK_PLAN_INVALID", message: "A secret of the application has more than one entry" },
      ],
    ];
    for (const [err, expected] of refusals) {
      expect(err).toMatchObject(expected);
      for (const value of VALUES) expect(shown(err)).not.toContain(value);
    }
  });

  it("create takes no secret for a version 1 plan or a version 2 plan without environment secrets", () => {
    const v1 = appStackTestPlan();
    expect(assertAppStackCreateSecretContents(v1, undefined)).toEqual({});
    expect(assertAppStackCreateSecretContents(v1, [])).toEqual({});
    expect(thrown(() => assertAppStackCreateSecretContents(v1, [{ parameterKey: "shared_key", version: 1, content: "s3cret-value-42" }]))).toMatchObject({
      reason: "STACK_PLAN_INVALID",
      message: "A secret entry is not part of the plan",
    });
    const plain = appStackTestPlanV2({ components: [plan.components[2]!], volumes: [], ingress: [] });
    expect(assertAppStackCreateSecretContents(plain, undefined)).toEqual({});
    expect(thrown(() => assertAppStackCreateSecretContents(plain, V2_CREATE_SECRETS))).toMatchObject({ reason: "STACK_PLAN_INVALID" });
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const mutations = (log: readonly string[]) => log.filter((line) => !line.startsWith("GET "));

async function setup() {
  const fake = createAppStackFakeEngine();
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-app-v2-"));
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
  for (const image of [V2_DB, V2_WEB, IMAGE]) fake.images.set(image, { repoDigests: [image] });
  return { fake, root, request, engine };
}
type Harness = Awaited<ReturnType<typeof setup>>;

async function created(h: Harness, from: ApprovedStackPlanV2 = plan) {
  await h.engine.prepareAppStack({ plan: from });
  await h.engine.createAppStackComponents({ plan: from, secretContents: [...V2_CREATE_SECRETS] });
  h.fake.log.length = 0;
}
async function deployed(h: Harness, from: ApprovedStackPlanV2 = plan) {
  await created(h, from);
  await h.engine.startAppStackComponent({ plan: from, componentKey: "db", secretFileContents: DB_SECRETS });
  await h.engine.startAppStackComponent({ plan: from, componentKey: "web", secretFileContents: WEB_SECRETS });
  await h.engine.startAppStackComponent({ plan: from, componentKey: "cache", secretFileContents: [] });
  h.fake.log.length = 0;
}
const idOf = (h: Harness, name: string) => h.fake.containers.get(name)?.Id ?? "missing";
const secretDir = (h: Harness, key: string) => path.join(h.root, `app_${ID}__${key}`);
const exists = (file: string) => stat(file).then(() => true, () => false);
const createdBody = (h: Harness, name: string) => h.fake.bodies.get(`POST /containers/create?name=${name}`)?.at(-1);

describe("AppStackEngine with a version 2 plan", () => {
  it("creates the components with the environment secrets and returns none of them", async () => {
    const h = await setup();
    await h.engine.prepareAppStack({ plan });
    const result = await h.engine.createAppStackComponents({ plan, secretContents: [...V2_CREATE_SECRETS] });
    expect(result).toEqual({
      components: [
        { componentKey: "db", outcome: "created" },
        { componentKey: "web", outcome: "created" },
        { componentKey: "cache", outcome: "created" },
      ],
      removedComponents: [],
    });
    for (const [name, key] of [[DB, "db"], [WEB, "web"], [CACHE, "cache"]] as const) {
      expect(createdBody(h, name)).toEqual(buildAppStackContainerCreatePayload(plan, key, { secretsRootDir: h.root, secretContents: CONTENTS }));
    }
    expect((createdBody(h, DB) as AppStackContainerCreatePayload).Env).toContain(`DB_PASSWORD=${DB_PASSWORD}`);
    expect(JSON.stringify(createdBody(h, CACHE))).not.toContain(DB_PASSWORD);
    for (const value of VALUES) expect(JSON.stringify(result)).not.toContain(value);
    // Nothing is written at create: the files are for start.
    expect(await readdir(h.root)).toEqual([]);
    expect(h.fake.log.some((line) => /\/(start|restart)/.test(line))).toBe(false);

    h.fake.log.length = 0;
    const again = await h.engine.createAppStackComponents({ plan, secretContents: [...V2_CREATE_SECRETS] });
    expect(again.components.map((c) => c.outcome)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it.each([
    ["no secret", undefined, "STACK_SECRET_MISSING"],
    ["one secret missing", [v2SecretEntry("db_password")], "STACK_SECRET_MISSING"],
    ["a secret that is not an environment one", [...V2_CREATE_SECRETS, v2SecretEntry("app_key")], "STACK_PLAN_INVALID"],
    ["a secret of another version", [v2SecretEntry("db_password", 2), v2SecretEntry("db_root_password")], "STACK_PLAN_INVALID"],
  ])("refuses a create with %s before any change, on a new and on a deployed application", async (_name, secretContents, reason) => {
    const h = await setup();
    await h.engine.prepareAppStack({ plan });
    h.fake.log.length = 0;
    const req = { plan, ...(secretContents === undefined ? {} : { secretContents }) };
    const fresh = await failure(h.engine.createAppStackComponents(req));
    expect(fresh).toMatchObject({ reason });
    expect(h.fake.log).toEqual([]);
    for (const value of VALUES) expect(shown(fresh)).not.toContain(value);

    await deployed(h);
    const before = [idOf(h, DB), idOf(h, WEB), idOf(h, CACHE)];
    // Another plan of the same secrets: every component would be replaced.
    const changed = structuredClone(plan);
    for (const component of changed.components) component.environment.push({ name: "ZZ_TEST_CHANGE", value: "1" });
    const next = rehash(changed);
    await expect(h.engine.createAppStackComponents({ plan: next, ...(secretContents === undefined ? {} : { secretContents }) })).rejects.toMatchObject({
      reason,
    });
    expect(h.fake.log).toEqual([]);
    expect([idOf(h, DB), idOf(h, WEB), idOf(h, CACHE)]).toEqual(before);
  });

  it("refuses secrets sent with a version 1 plan", async () => {
    const h = await setup();
    const v1 = appStackTestPlan();
    await h.engine.prepareAppStack({ plan: v1 });
    h.fake.log.length = 0;
    await expect(
      h.engine.createAppStackComponents({ plan: v1, secretContents: [{ parameterKey: "shared_key", version: 1, content: "s3cret-value-42" }] }),
    ).rejects.toMatchObject({ reason: "STACK_PLAN_INVALID", message: "A secret entry is not part of the plan" });
    expect(h.fake.log).toEqual([]);
  });

  it("a new version of an environment secret replaces only the components that read it", async () => {
    const h = await setup();
    await deployed(h);
    const cache = idOf(h, CACHE);
    const next = withDbPasswordVersion(2);
    const rotated = "db-pass-rotated-987654";
    const result = await h.engine.createAppStackComponents({
      plan: next,
      secretContents: [{ parameterKey: "db_password", version: 2, content: rotated }, v2SecretEntry("db_root_password")],
    });
    expect(result.components).toEqual([
      { componentKey: "db", outcome: "replaced" },
      { componentKey: "web", outcome: "replaced" },
      { componentKey: "cache", outcome: "unchanged" },
    ]);
    expect(idOf(h, CACHE)).toBe(cache);
    expect((createdBody(h, WEB) as AppStackContainerCreatePayload).Env).toContain(`BLOG_DB_URL=sql://blog:${rotated}@db:3306/blog`);
    expect(h.fake.volumes.has(`hp_appvol_${ID}_dbdata`)).toBe(true);
  });

  it("a failed create names no secret", async () => {
    const h = await setup();
    await h.engine.prepareAppStack({ plan });
    h.fake.failNext(/^POST \/containers\/create\?name=.*_db$/, 500, JSON.stringify({ message: `bad env DB_PASSWORD=${DB_PASSWORD}` }));
    const err = await failure(h.engine.createAppStackComponents({ plan, secretContents: [...V2_CREATE_SECRETS] }));
    expect(err).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    for (const value of VALUES) expect(shown(err)).not.toContain(value);
  });

  it("start writes every secret the component reads, mounts only the file ones and masks all of them in the logs", async () => {
    const h = await setup();
    await created(h);
    await expect(h.engine.startAppStackComponent({ plan, componentKey: "db", secretFileContents: DB_SECRETS })).resolves.toEqual({
      componentKey: "db",
      outcome: "started",
    });
    expect((await readdir(secretDir(h, "db"))).sort()).toEqual(["db_password", "db_root_password"]);
    expect(await readFile(path.join(secretDir(h, "db"), "db_password"), "utf8")).toBe(DB_PASSWORD);
    expect((await stat(path.join(secretDir(h, "db"), "db_password"))).mode & 0o777).toBe(0o444);
    expect((createdBody(h, DB) as AppStackContainerCreatePayload).HostConfig.Binds).toEqual([]);

    await h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: WEB_SECRETS });
    expect((await readdir(secretDir(h, "web"))).sort()).toEqual(["app_key", "db_password"]);
    expect((createdBody(h, WEB) as AppStackContainerCreatePayload).HostConfig.Binds).toEqual([
      `${path.join(secretDir(h, "web"), "app_key")}:/run/secrets/app_key:ro`,
    ]);
    await h.engine.startAppStackComponent({ plan, componentKey: "cache", secretFileContents: [] });
    expect(await exists(secretDir(h, "cache"))).toBe(false);

    const AT = "2026-11-22T03:00:00.000000000Z";
    h.fake.containers.get(DB)?.logs.push({ stream: "stdout", payload: `${AT} login with ${DB_PASSWORD} and ${DB_ROOT_PASSWORD}\n` });
    h.fake.containers.get(WEB)?.logs.push({ stream: "stderr", payload: `${AT} sql://blog:${DB_PASSWORD}@db key ${APP_KEY}\n` });
    await expect(h.engine.getAppStackComponentLogs({ ...REF, componentKey: "db", tail: 10 })).resolves.toEqual([
      { at: AT, stream: "stdout", text: "login with [REDACTED] and [REDACTED]" },
    ]);
    await expect(h.engine.getAppStackComponentLogs({ ...REF, componentKey: "web", tail: 10 })).resolves.toEqual([
      { at: AT, stream: "stderr", text: "sql://blog:[REDACTED]@db key [REDACTED]" },
    ]);
  });

  it("start and restart refuse a component whose environment secret is missing, with no request", async () => {
    const h = await setup();
    await created(h);
    for (const action of ["startAppStackComponent", "restartAppStackComponent"] as const) {
      const err = await failure(h.engine[action]({ plan, componentKey: "web", secretFileContents: [v2SecretEntry("app_key")] }));
      expect(err).toMatchObject({ reason: "STACK_SECRET_MISSING", message: "A secret of component web is missing" });
      for (const value of VALUES) expect(shown(err)).not.toContain(value);
    }
    expect(h.fake.log).toEqual([]);
    expect(await exists(secretDir(h, "web"))).toBe(false);
  });

  it("restart rewrites the secrets of a running component", async () => {
    const h = await setup();
    await deployed(h);
    await rm(secretDir(h, "db"), { recursive: true, force: true });
    await expect(h.engine.restartAppStackComponent({ plan, componentKey: "db", secretFileContents: DB_SECRETS })).resolves.toEqual({
      componentKey: "db",
      outcome: "restarted",
    });
    expect((await readdir(secretDir(h, "db"))).sort()).toEqual(["db_password", "db_root_password"]);
  });

  it("status and removal hold no secret, and removal purges the secret dirs", async () => {
    const h = await setup();
    await deployed(h);
    const status = await h.engine.getAppStackStatus(REF);
    expect(status.components.map((c) => [c.componentKey, c.state]).sort()).toEqual([
      ["cache", "running"],
      ["db", "running"],
      ["web", "running"],
    ]);
    for (const value of VALUES) expect(JSON.stringify(status)).not.toContain(value);
    await h.engine.removeAppStack({ ...REF, removeVolumes: true });
    expect(await readdir(h.root)).toEqual([]);
    expect(h.fake.containers.size).toBe(0);
  });

  it("refuses a body over the 32 768-byte bound before it removes or replaces anything", async () => {
    const h = await setup();
    await deployed(h);
    const before = [idOf(h, DB), idOf(h, WEB), idOf(h, CACHE)];
    const rotated = withDbPasswordVersion(2);
    const next = rehash({ ...rotated, components: rotated.components.slice(0, 2) });
    const secretContents = [{ parameterKey: "db_password", version: 2, content: "p".repeat(32_768) }, v2SecretEntry("db_root_password")];
    await expect(h.engine.createAppStackComponents({ plan: next, secretContents })).rejects.toMatchObject({
      reason: "STACK_PLAN_INVALID",
      message: "An environment value of component web is too long",
    });
    expect(mutations(h.fake.log)).toEqual([]);
    expect([idOf(h, DB), idOf(h, WEB), idOf(h, CACHE)]).toEqual(before);
  });
});

describe("the log reader of a version 2 component whose secret files are gone", () => {
  const AT = "2026-11-22T03:00:00.000000000Z";
  const print = (h: Harness, name: string, text: string) =>
    h.fake.containers.get(name)?.logs.push({ stream: "stdout", payload: `${AT} ${text}\n` });
  const texts = async (h: Harness, componentKey: string) =>
    (await h.engine.getAppStackComponentLogs({ ...REF, componentKey, tail: 10 })).map((line) => line.text);
  /** What a host reboot does to the tmpfs: every secret dir is gone while Docker runs the containers again. */
  async function reboot(h: Harness) {
    for (const entry of await readdir(h.root)) await rm(path.join(h.root, entry), { recursive: true, force: true });
    h.fake.log.length = 0;
  }
  const unmaskable = { code: "DOCKER_ENGINE_UNAVAILABLE", message: "The logs of component db cannot be masked" };

  it("masks the environment secrets with the values the container holds", async () => {
    const h = await setup();
    await deployed(h);
    await reboot(h);
    print(h, DB, `login with ${DB_PASSWORD} and ${DB_ROOT_PASSWORD}`);
    print(h, WEB, `connect sql://blog:${DB_PASSWORD}@db:3306/blog`);
    await expect(h.engine.getAppStackComponentLogs({ ...REF, componentKey: "db", tail: 10 })).resolves.toEqual([
      { at: AT, stream: "stdout", text: "login with [REDACTED] and [REDACTED]" },
    ]);
    expect(await texts(h, "web")).toEqual(["connect sql://blog:[REDACTED]@db:3306/blog"]);
    // Reading writes nothing and changes nothing.
    expect(await readdir(h.root)).toEqual([]);
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("masks a secret the template writes only inside a longer value, alone and in that value", async () => {
    const h = await setup();
    await deployed(h, withEmbeddedOnly());
    await reboot(h);
    print(h, WEB, `password ${DB_PASSWORD}`);
    print(h, WEB, `url sql://blog:${DB_PASSWORD}@db:3306/blog`);
    expect(await texts(h, "web")).toEqual(["password [REDACTED]", "url sql://blog:[REDACTED]@db:3306/blog"]);
  });

  it("splits a value that holds two secrets on the template text between them", async () => {
    const h = await setup();
    await deployed(h, withPair(":"));
    await reboot(h);
    print(h, DB, `root ${DB_ROOT_PASSWORD} user ${DB_PASSWORD} pair ${DB_PASSWORD}:${DB_ROOT_PASSWORD}`);
    expect(await texts(h, "db")).toEqual(["root [REDACTED] user [REDACTED] pair [REDACTED]:[REDACTED]"]);
  });

  it.each([
    ["template text that is also inside the secrets", "-"],
    ["no template text between them", null],
  ])("masks with the files a value whose secrets are split by %s, and refuses once the files are gone", async (_name, separator) => {
    const h = await setup();
    await deployed(h, withPair(separator));
    print(h, DB, `root ${DB_ROOT_PASSWORD}`);
    expect(await texts(h, "db")).toEqual(["root [REDACTED]"]);
    await reboot(h);
    const err = await failure(texts(h, "db"));
    expect(err).toMatchObject(unmaskable);
    expect(h.fake.log.some((line) => line.includes("/logs"))).toBe(false);
    for (const value of VALUES) expect(shown(err)).not.toContain(value);
  });

  it.each([
    ["a variable the label names is not in the environment", (c: FakeContainer) => void (c.Env = c.Env.filter((e) => !e.startsWith("DB_ROOT_PASSWORD=")))],
    ["a variable the label names is in the environment twice", (c: FakeContainer) => void c.Env.push("DB_PASSWORD=another-value-42")],
    ["the label is not a list of names and pieces", (c: FakeContainer) => void (c.Labels[SECRET_ENV_LABEL] = "DB_PASSWORD,DB_ROOT_PASSWORD")],
    ["the label names a variable without a secret", (c: FakeContainer) => void (c.Labels[SECRET_ENV_LABEL] = '[["DB_PASSWORD"]]')],
    ["a value does not have the template text of the label", (c: FakeContainer) => void (c.Labels[SECRET_ENV_LABEL] = '[["DB_PASSWORD","x",null]]')],
  ])("fails closed, with no log read, when %s", async (_name, tamper) => {
    const h = await setup();
    await deployed(h);
    await reboot(h);
    print(h, DB, `login with ${DB_PASSWORD} and ${DB_ROOT_PASSWORD}`);
    tamper(h.fake.containers.get(DB)!);
    const err = await failure(texts(h, "db"));
    expect(err).toMatchObject(unmaskable);
    expect(h.fake.log.some((line) => line.includes("/logs"))).toBe(false);
    for (const value of VALUES) expect(shown(err)).not.toContain(value);
  });

  it("fails closed when the container cannot be inspected", async () => {
    const h = await setup();
    await deployed(h);
    await reboot(h);
    h.fake.failNext(new RegExp(`^GET /containers/${DB}/json$`), 500);
    await expect(texts(h, "db")).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(h.fake.log.some((line) => line.includes("/logs"))).toBe(false);
  });
});

describe("resolveAppStackImage", () => {
  const image = "ghcr.io/acme/blog:2.4";
  const digest = `sha256:${"a".repeat(64)}`;
  const line = `GET /distribution/${enc(image)}/json`;
  const notFound = { reason: "STACK_IMAGE_PULL_FAILED", message: "Could not find the software of the application in its registry" };

  it("asks the registry through the Engine, once, with its own time budget", async () => {
    const h = await setup();
    h.fake.registry.set(image, { Descriptor: { mediaType: "application/vnd.oci.image.index.v1+json", digest, size: 5129 }, Platforms: [] });
    await expect(h.engine.resolveAppStackImage({ image })).resolves.toEqual({ image, digest });
    expect(h.fake.log).toEqual([line]);
    expect(line).toBe("GET /distribution/ghcr.io%2Facme%2Fblog%3A2.4/json");
    expect(h.request).toHaveBeenCalledExactlyOnceWith("GET", `/distribution/${enc(image)}/json`, undefined, {
      timeoutMs: APP_STACK_RESOLVE_ENGINE_TIMEOUT_MS,
    });
    expect(APP_STACK_RESOLVE_ENGINE_TIMEOUT_MS).toBe(30_000);
  });

  it("works while a change of a stack is running", async () => {
    const h = await setup();
    h.fake.registry.set("mariadb", { Descriptor: { digest } });
    const held = h.fake.hold(/^POST \/networks\/create$/);
    const pending = h.engine.prepareAppStack({ plan });
    await vi.waitFor(() => expect(h.fake.log.some((entry) => entry.startsWith("POST /networks/create"))).toBe(true));
    await expect(h.engine.resolveAppStackImage({ image: "mariadb" })).resolves.toEqual({ image: "mariadb", digest });
    held.release();
    await pending;
  });

  it.each([
    ["an unknown image", undefined],
    ["a registry refusal", [403, JSON.stringify({ message: "denied: requested access to the resource is denied" })]],
    ["an Engine error", [500, undefined]],
    ["an answer that is not JSON", [200, "<html>"]],
    ["a null answer", [200, "null"]],
    ["an answer without a descriptor", [200, JSON.stringify({ Platforms: [] })]],
    ["a null descriptor", [200, JSON.stringify({ Descriptor: null })]],
    ["a digest that is not a string", [200, JSON.stringify({ Descriptor: { digest: 7 } })]],
    ["a digest of another algorithm", [200, JSON.stringify({ Descriptor: { digest: `sha512:${"a".repeat(128)}` } })]],
    ["a short digest", [200, JSON.stringify({ Descriptor: { digest: "sha256:abc" } })]],
    ["a digest with something after it", [200, JSON.stringify({ Descriptor: { digest: `${digest}\n--privileged` } })]],
  ] as Array<[string, [number, string | undefined] | undefined]>)("%s is a failed lookup", async (_name, answer) => {
    const h = await setup();
    if (answer !== undefined) h.fake.failNext(/^GET \/distribution\//, answer[0], answer[1]);
    await expect(h.engine.resolveAppStackImage({ image })).rejects.toMatchObject(notFound);
    expect(h.fake.log).toEqual([line]);
  });

  it.each([
    "",
    " ghcr.io/acme/blog",
    "ghcr.io/acme/blog:2.4 --privileged",
    `ghcr.io/acme/blog@${`sha256:${"a".repeat(64)}`}`,
    "https://ghcr.io/acme/blog",
    "user:pass@ghcr.io/acme/blog",
    "ghcr.io/Acme/Blog",
    "../../containers/json",
    "blog?all=1",
    "blog#x",
    "a".repeat(256),
  ])("refuses the reference %j with no request", async (bad) => {
    const h = await setup();
    await expect(h.engine.resolveAppStackImage({ image: bad })).rejects.toMatchObject({
      reason: "STACK_PLAN_INVALID",
      message: "The image reference is not valid",
    });
    expect(h.fake.log).toEqual([]);
  });
});

describe("the simulator with a version 2 plan", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "hp-sim-v2-"));
    dirs.push(dir);
    return dir;
  };
  const simulator = (secretsRootDir?: string) =>
    new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST, ...(secretsRootDir === undefined ? {} : { secretsRootDir }) });
  async function pulled(sim: InMemoryDockerSimulatorAdapter) {
    for (const image of [V2_DB, V2_WEB, IMAGE]) await sim.pullAppStackImage({ plan, image });
    await sim.prepareAppStack({ plan });
  }

  it("deploys like the engine: the same bodies, the same refusals, secrets written for start only", async () => {
    const root = tempDir();
    const sim = simulator(root);
    await pulled(sim);
    const before = sim.appStacks.appStackMutations.length;
    await expect(sim.createAppStackComponents({ plan })).rejects.toMatchObject({ reason: "STACK_SECRET_MISSING" });
    await expect(sim.createAppStackComponents({ plan, secretContents: [...V2_CREATE_SECRETS, v2SecretEntry("app_key")] })).rejects.toMatchObject({
      reason: "STACK_PLAN_INVALID",
    });
    expect(sim.appStacks.appStackMutations).toHaveLength(before);

    const result = await sim.createAppStackComponents({ plan, secretContents: [...V2_CREATE_SECRETS] });
    expect(result.components.map((c) => [c.componentKey, c.outcome])).toEqual([
      ["db", "created"],
      ["web", "created"],
      ["cache", "created"],
    ]);
    for (const value of VALUES) expect(JSON.stringify(result)).not.toContain(value);
    const snapshot = sim.appStacks.getAppStackSnapshot(ID);
    expect(snapshot?.containers.db?.payload).toEqual(buildAppStackContainerCreatePayload(plan, "db", { secretsRootDir: root, secretContents: CONTENTS }));
    expect(snapshot?.containers.cache?.payload).toEqual(buildAppStackContainerCreatePayload(plan, "cache", { secretsRootDir: root }));
    expect(readdirSync(root)).toEqual([]);

    await expect(sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [v2SecretEntry("app_key")] })).rejects.toMatchObject({
      reason: "STACK_SECRET_MISSING",
    });
    await sim.startAppStackComponent({ plan, componentKey: "db", secretFileContents: DB_SECRETS });
    await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: WEB_SECRETS });
    await sim.startAppStackComponent({ plan, componentKey: "cache", secretFileContents: [] });
    expect(readdirSync(path.join(root, `app_${ID}__db`)).sort()).toEqual(["db_password", "db_root_password"]);
    expect(readdirSync(path.join(root, `app_${ID}__web`)).sort()).toEqual(["app_key", "db_password"]);
    expect(existsSync(path.join(root, `app_${ID}__cache`))).toBe(false);

    sim.appStacks.setAppStackComponentLogs(ID, "db", [{ at: null, stream: "stdout", text: `pw ${DB_PASSWORD}` }]);
    expect((await sim.getAppStackComponentLogs({ ...REF, componentKey: "db", tail: 5 }))[0]?.text).toBe("pw [REDACTED]");
    const status = await sim.getAppStackStatus(REF);
    expect(status.components.map((c) => c.state)).toEqual(["running", "running", "running"]);
    for (const value of VALUES) expect(JSON.stringify(status)).not.toContain(value);
  });

  it("masks the environment secrets like the engine once the secret files are gone, and refuses where it refuses", async () => {
    const root = tempDir();
    const sim = simulator(root);
    await pulled(sim);
    const deploy = async (from: ApprovedStackPlanV2) => {
      await sim.createAppStackComponents({ plan: from, secretContents: [...V2_CREATE_SECRETS] });
      await sim.startAppStackComponent({ plan: from, componentKey: "db", secretFileContents: DB_SECRETS });
      await sim.startAppStackComponent({ plan: from, componentKey: "web", secretFileContents: WEB_SECRETS });
    };
    const reboot = () => {
      for (const entry of readdirSync(root)) rmSync(path.join(root, entry), { recursive: true, force: true });
    };
    await deploy(plan);
    reboot();
    sim.appStacks.setAppStackComponentLogs(ID, "web", [{ at: null, stream: "stdout", text: `url sql://blog:${DB_PASSWORD}@db:3306/blog` }]);
    sim.appStacks.setAppStackComponentLogs(ID, "db", [{ at: null, stream: "stdout", text: `root ${DB_ROOT_PASSWORD}` }]);
    expect((await sim.getAppStackComponentLogs({ ...REF, componentKey: "web", tail: 5 }))[0]?.text).toBe("url sql://blog:[REDACTED]@db:3306/blog");
    expect((await sim.getAppStackComponentLogs({ ...REF, componentKey: "db", tail: 5 }))[0]?.text).toBe("root [REDACTED]");

    await deploy(withPair("-"));
    expect((await sim.getAppStackComponentLogs({ ...REF, componentKey: "db", tail: 5 }))[0]?.text).toBe("root [REDACTED]");
    reboot();
    const err = await failure(sim.getAppStackComponentLogs({ ...REF, componentKey: "db", tail: 5 }));
    expect(err).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: "The logs of component db cannot be masked" });
    for (const value of VALUES) expect(shown(err)).not.toContain(value);
  });

  it("checks every body before it removes or replaces anything, like the engine", async () => {
    const sim = simulator();
    await pulled(sim);
    await sim.createAppStackComponents({ plan, secretContents: [...V2_CREATE_SECRETS] });
    const before = sim.appStacks.getAppStackSnapshot(ID);
    const mutationCount = sim.appStacks.appStackMutations.length;
    // cache leaves the plan and db_password grows to the bound: db's body passes, web's URL is over it.
    const rotated = withDbPasswordVersion(2);
    const next = rehash({ ...rotated, components: rotated.components.slice(0, 2) });
    const secretContents = [{ parameterKey: "db_password", version: 2, content: "p".repeat(32_768) }, v2SecretEntry("db_root_password")];
    await expect(sim.createAppStackComponents({ plan: next, secretContents })).rejects.toMatchObject({
      reason: "STACK_PLAN_INVALID",
      message: "An environment value of component web is too long",
    });
    expect(sim.appStacks.getAppStackSnapshot(ID)).toEqual(before);
    expect(sim.appStacks.appStackMutations).toHaveLength(mutationCount);
  });

  it("replaces the readers of a secret that moved to a new version", async () => {
    const sim = simulator();
    await pulled(sim);
    await sim.createAppStackComponents({ plan, secretContents: [...V2_CREATE_SECRETS] });
    const next = withDbPasswordVersion(2);
    const result = await sim.createAppStackComponents({
      plan: next,
      secretContents: [{ parameterKey: "db_password", version: 2, content: "db-pass-rotated-987654" }, v2SecretEntry("db_root_password")],
    });
    expect(result.components.map((c) => c.outcome)).toEqual(["replaced", "replaced", "unchanged"]);
  });

  it("resolves any well-formed reference to a stable digest and records the lookups", async () => {
    const sim = simulator();
    const first = await sim.resolveAppStackImage({ image: "mariadb:12.3.3" });
    expect(first).toEqual({ image: "mariadb:12.3.3", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) as unknown });
    expect(await sim.resolveAppStackImage({ image: "mariadb:12.3.3" })).toEqual(first);
    expect((await sim.resolveAppStackImage({ image: "wordpress:7.1.4-php8.4-apache" })).digest).not.toBe(first.digest);
    await expect(sim.resolveAppStackImage({ image: "mariadb:12 --privileged" })).rejects.toMatchObject({ reason: "STACK_PLAN_INVALID" });
    sim.appStacks.failNextAppStackStep("resolve", "pull_failed");
    await expect(sim.resolveAppStackImage({ image: "mariadb:12.3.3" })).rejects.toMatchObject({ reason: "STACK_IMAGE_PULL_FAILED" });
    sim.appStacks.failNextAppStackStep("resolve", "engine_unavailable");
    await expect(sim.resolveAppStackImage({ image: "mariadb:12.3.3" })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(sim.appStacks.appStackImageLookups).toEqual([
      "mariadb:12.3.3",
      "mariadb:12.3.3",
      "wordpress:7.1.4-php8.4-apache",
      "mariadb:12 --privileged",
      "mariadb:12.3.3",
      "mariadb:12.3.3",
    ]);
  });
});
