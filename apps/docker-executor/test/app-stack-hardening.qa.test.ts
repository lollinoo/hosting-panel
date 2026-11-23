// QA Q2 (HCP-SPEC-005, arch-executor §14 Q2): the container hardening matrix.
// A8: no secret value in Config.Env or anywhere in a create body, secret dir/file modes.
// A11: no socket, no host mount. L16: every property of the designed body for every component shape.
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovedStackPlanSchema, type AppImageAllowlistEntry, type ApprovedStackPlan } from "@hosting-panel/contracts";
import { computeAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppStackEngine,
  assertAppStackPayloadHardening,
  buildAppStackContainerCreatePayload,
  type AppStackContainerCreatePayload,
  type AppStackHealthProbe,
} from "../src/app-stacks/index.js";
import { createAppStackFakeEngine } from "./support/app-stack-fake-engine.js";

const ID = "stk_0123456789abcdef";
const ORG = "org_acme";
const KEY = "svc";
const NET = `hp_appnet_${ID}`;
const EDGE = `hp_appedge_${ID}`;
const ROOT = "/run/hosting-panel/secrets";
const ctx = { secretsRootDir: ROOT };
const DIGEST = "d".repeat(64);
const USER = "65534:65534";

// Names the *site* builder grants capabilities to (docker-engine-adapter.ts: image-name cap trap).
const CAP_TRAP_IMAGES = [
  "redis",
  "library/redis",
  "docker.io/library/redis",
  "nginx",
  "postgres",
  "mariadb",
  "mysql",
  "httpd",
  "apache2",
  "wordpress",
  "php",
  "memcached",
  "registry.test/acme/web",
] as const;

const MOUNTS = {
  none: { volumes: [], mounts: [] },
  ro: { volumes: [{ key: "cache" }], mounts: [{ volumeKey: "cache", containerPath: "/srv/cache", readOnly: true }] },
  rw: { volumes: [{ key: "data" }], mounts: [{ volumeKey: "data", containerPath: "/srv/data", readOnly: false }] },
  both: {
    volumes: [{ key: "cache" }, { key: "data" }],
    mounts: [
      { volumeKey: "cache", containerPath: "/srv/cache", readOnly: true },
      { volumeKey: "data", containerPath: "/srv/data", readOnly: false },
    ],
  },
} as const;
type MountKind = keyof typeof MOUNTS;

const SECRETS = {
  none: [],
  one: [{ envName: "DB_PASSWORD_FILE", parameterKey: "db_password", version: 1 }],
  // one parameter feeding two env names, plus a second parameter (sorted by envName)
  many: [
    { envName: "API_KEY_COPY_FILE", parameterKey: "api_key", version: 2 },
    { envName: "API_KEY_FILE", parameterKey: "api_key", version: 2 },
    { envName: "TOKEN_FILE", parameterKey: "token", version: 1 },
  ],
} as const;
type SecretKind = keyof typeof SECRETS;

interface Variant {
  image: string;
  user: boolean;
  argv: boolean;
  mounts: MountKind;
  secrets: SecretKind;
  edge: boolean;
}

const label = (v: Variant) =>
  `${v.image} user=${v.user} argv=${v.argv} mounts=${v.mounts} secrets=${v.secrets} edge=${v.edge}`;

function planFor(v: Variant, resources = { cpuMilli: 500, memoryBytes: "268435456" }): ApprovedStackPlan {
  const m = MOUNTS[v.mounts];
  const draft = {
    schemaVersion: 1 as const,
    stackId: ID,
    organizationId: ORG,
    hostAllocationId: "alloc_0123456789abcdef",
    templateVersionId: "atv_0123456789abcdef",
    revisionId: "astr_0123456789abcdef",
    planHash: "0".repeat(64),
    components: [
      {
        key: KEY,
        image: `${v.image}@sha256:${DIGEST}`,
        runAsUser: v.user ? USER : null,
        argv: v.argv ? ["serve", "--port", "8080"] : null,
        environment: [
          { name: "APP_MODE", value: "production" },
          { name: "SITE_URL", value: "https://shop.example.org" },
        ],
        secretFiles: SECRETS[v.secrets].map((s) => ({ ...s })),
        resources,
        expose: [8080],
        dependsOn: [],
        volumes: m.mounts.map((mount) => ({ ...mount })),
        healthcheck: v.edge
          ? { kind: "http" as const, port: 8080, path: "/healthz", intervalSeconds: 10, timeoutSeconds: 3 }
          : null,
      },
    ],
    volumes: m.volumes.map((volume) => ({ ...volume })),
    ingress: v.edge ? [{ componentKey: KEY, port: 8080 }] : [],
  };
  return ApprovedStackPlanSchema.parse({ ...draft, planHash: computeAppStackPlanHash(draft) });
}

function* allVariants(): Generator<Variant> {
  let n = 0;
  for (const user of [true, false])
    for (const argv of [true, false])
      for (const mounts of Object.keys(MOUNTS) as MountKind[])
        for (const secrets of Object.keys(SECRETS) as SecretKind[])
          for (const edge of [true, false]) {
            // rotate the image through the cap-trap names so every name meets every shape over the matrix
            yield { image: CAP_TRAP_IMAGES[n++ % CAP_TRAP_IMAGES.length] as string, user, argv, mounts, secrets, edge };
          }
}

const FORBIDDEN_HOST_KEYS = [
  "CapAdd", "PortBindings", "PublishAllPorts", "Devices", "DeviceCgroupRules", "DeviceRequests", "PidMode", "IpcMode",
  "UsernsMode", "UTSMode", "CgroupnsMode", "Sysctls", "ExtraHosts", "Dns", "DnsOptions", "DnsSearch", "Links",
  "VolumesFrom", "CgroupParent", "Init", "Ulimits", "ShmSize", "Runtime", "Cgroup", "MaskedPaths", "ReadonlyPaths",
  "Binds_rw", "StorageOpt", "OomKillDisable", "OomScoreAdj", "Isolation", "AutoRemove", "VolumeDriver",
] as const;
const FORBIDDEN_TOP_KEYS = [
  "Entrypoint", "Healthcheck", "Hostname", "Domainname", "Volumes", "WorkingDir", "NetworkDisabled", "MacAddress",
  "OnBuild", "StopSignal", "Shell", "AttachStdin", "AttachStdout", "AttachStderr", "Tty", "OpenStdin", "StdinOnce",
] as const;

/** The temporary areas written out, not derived: /tmp for every image, and one more only for the image whose row in the
 *  real allowlist declares it (ADR-0039: the directory of PostgreSQL's socket). A test allowlist declares none. */
function expectedTmpfs(image: string, allowlist: readonly AppImageAllowlistEntry[] | undefined): Record<string, string> {
  const base = { "/tmp": "rw,noexec,nosuid,nodev,size=64m" };
  if (allowlist !== undefined || !image.startsWith("postgres@")) return base;
  return { ...base, "/run/postgresql": "rw,noexec,nosuid,nodev,size=1m" };
}

/** Every property of the designed body (arch-executor §5.4) for one component of `plan`. `allowlist` is the one the
 *  body was built under (none: the real one). */
function expectHardenedBody(
  body: AppStackContainerCreatePayload,
  plan: ApprovedStackPlan,
  key: string,
  root = ROOT,
  allowlist?: readonly AppImageAllowlistEntry[],
): void {
  const c = plan.components.find((component) => component.key === key);
  if (c === undefined) throw new Error("fixture: unknown component");
  const host = body.HostConfig as Record<string, unknown>;
  const json = JSON.stringify(body);

  // privileges
  expect(host.Privileged).toBe(false);
  expect(host.CapDrop).toStrictEqual(["ALL"]);
  expect(json).not.toContain("CapAdd");
  expect(host.SecurityOpt).toStrictEqual(["no-new-privileges:true"]);
  expect(host.ReadonlyRootfs).toBe(true);
  for (const forbidden of FORBIDDEN_HOST_KEYS) expect(Object.keys(host)).not.toContain(forbidden);
  for (const forbidden of FORBIDDEN_TOP_KEYS) expect(Object.keys(body)).not.toContain(forbidden);
  expect(Object.keys(host).sort()).toStrictEqual(
    ["Binds", "CapDrop", "LogConfig", "Memory", "MemorySwap", "Mounts", "NanoCpus", "NetworkMode", "PidsLimit", "Privileged",
      "ReadonlyRootfs", "RestartPolicy", "SecurityOpt", "Tmpfs"].sort(),
  );

  // limits
  expect(host.PidsLimit).toBe(256);
  expect(host.Memory).toBe(Number(c.resources.memoryBytes));
  expect(host.MemorySwap).toBe(host.Memory);
  expect(Number.isSafeInteger(host.Memory)).toBe(true);
  expect(host.NanoCpus).toBe(c.resources.cpuMilli * 1_000_000);
  expect(host.LogConfig).toStrictEqual({ Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } });
  expect(host.Tmpfs).toStrictEqual(expectedTmpfs(c.image, allowlist));
  expect(host.RestartPolicy).toStrictEqual({ Name: "unless-stopped" });
  expect(body.StopTimeout).toBe(10);

  // image, user, argv
  expect(body.Image).toBe(c.image);
  expect(body.Image).toMatch(/@sha256:[a-f0-9]{64}$/);
  if (c.runAsUser === null) expect(Object.keys(body)).not.toContain("User");
  else expect(body.User).toBe(c.runAsUser);
  if (c.argv === null) expect(Object.keys(body)).not.toContain("Cmd");
  else expect(body.Cmd).toStrictEqual(c.argv);

  // no ports, only the internal network (+ edge for an ingress target, under the long alias)
  expect(host.NetworkMode).toBe(NET);
  expect(Object.keys(body.ExposedPorts)).toStrictEqual(c.expose.map((p) => `${p}/tcp`));
  const isEdge = plan.ingress.some((r) => r.componentKey === key);
  expect(Object.keys(body.NetworkingConfig.EndpointsConfig).sort()).toStrictEqual(isEdge ? [EDGE, NET].sort() : [NET]);
  expect(body.NetworkingConfig.EndpointsConfig[NET]).toStrictEqual({ Aliases: [key] });
  if (isEdge) expect(body.NetworkingConfig.EndpointsConfig[EDGE]).toStrictEqual({ Aliases: [`hp_app_${ID}_${key}`] });

  // A11: no socket, no host mount; secret binds are the only binds and live under the secret root
  expect(json).not.toContain("docker.sock");
  expect(json).not.toContain("/var/run");
  const rootDir = path.resolve(root);
  const parameterKeys = [...new Set(c.secretFiles.map((s) => s.parameterKey))].sort();
  expect(body.HostConfig.Binds).toStrictEqual(
    parameterKeys.map((k) => `${rootDir}/app_${ID}__${key}/${k}:/run/secrets/${k}:ro`),
  );
  for (const bind of body.HostConfig.Binds) {
    const [source, target, mode, ...rest] = bind.split(":");
    expect(rest).toStrictEqual([]);
    expect(mode).toBe("ro");
    expect(path.resolve(source as string).startsWith(`${rootDir}/app_${ID}__${key}/`)).toBe(true);
    expect(source).not.toContain("..");
    expect(target?.startsWith("/run/secrets/")).toBe(true);
  }
  expect(body.HostConfig.Mounts).toStrictEqual(
    c.volumes.map((m) => ({ Type: "volume", Source: `hp_appvol_${ID}_${m.volumeKey}`, Target: m.containerPath, ReadOnly: m.readOnly })),
  );
  expect(json).not.toMatch(/"Type":"(?:bind|tmpfs|npipe)"/);

  // A8: Env = plain values + secret *paths* only
  expect(body.Env).toStrictEqual([
    ...c.environment.map((e) => `${e.name}=${e.value}`),
    ...c.secretFiles.map((s) => `${s.envName}=/run/secrets/${s.parameterKey}`),
  ]);

  // the belt-and-braces check accepts the body, under the allowlist it was built with
  assertAppStackPayloadHardening(body, { secretsRootDir: root, ...(allowlist === undefined ? {} : { allowlist }) });
}

describe("container body hardening matrix (builder)", () => {
  const variants = [...allVariants()];

  it("covers every combination of the component features", () => {
    expect(variants).toHaveLength(2 * 2 * 4 * 3 * 2);
    expect(new Set(variants.map((v) => v.image))).toStrictEqual(new Set(CAP_TRAP_IMAGES));
  });

  it.each(variants.map((v) => [label(v), v] as const))("holds every property: %s", (_name, v) => {
    const plan = planFor(v);
    expectHardenedBody(buildAppStackContainerCreatePayload(plan, KEY, ctx), plan, KEY);
  });

  it("gives a second temporary area to one image name only, and only under the real allowlist", () => {
    const areas = (image: string, allowlist?: readonly AppImageAllowlistEntry[]) => {
      const plan = planFor({ image, user: true, argv: false, mounts: "none", secrets: "none", edge: false });
      return buildAppStackContainerCreatePayload(plan, KEY, { ...ctx, ...(allowlist === undefined ? {} : { allowlist }) }).HostConfig.Tmpfs;
    };
    for (const image of CAP_TRAP_IMAGES) {
      expect(Object.keys(areas(image)).sort()).toStrictEqual(image === "postgres" ? ["/run/postgresql", "/tmp"] : ["/tmp"]);
      expect(Object.keys(areas(image, [{ repository: image, runAsUser: USER, note: "QA hardening matrix image." }]))).toStrictEqual(["/tmp"]);
    }
    expect(areas("postgres")).toStrictEqual({
      "/tmp": "rw,noexec,nosuid,nodev,size=64m",
      "/run/postgresql": "rw,noexec,nosuid,nodev,size=1m",
    });
  });

  it.each(CAP_TRAP_IMAGES.map((image) => [image] as const))(
    "never adds a capability for the image name %s (the site builder would)",
    (image) => {
      for (const user of [true, false]) {
        const plan = planFor({ image, user, argv: false, mounts: "rw", secrets: "one", edge: true });
        const body = buildAppStackContainerCreatePayload(plan, KEY, ctx);
        expect(body.HostConfig.CapDrop).toStrictEqual(["ALL"]);
        expect(Object.keys(body.HostConfig)).not.toContain("CapAdd");
        expect(JSON.stringify(body)).not.toMatch(/CAP_|NET_BIND|CHOWN|SETUID|SETGID|DAC_OVERRIDE/);
      }
    },
  );

  it.each([
    ["the smallest allowed resources", { cpuMilli: 50, memoryBytes: "33554432" }],
    ["the largest allowed resources", { cpuMilli: 16_000, memoryBytes: "17179869184" }],
    ["a non power of two memory", { cpuMilli: 1_250, memoryBytes: "1000000007" }],
  ])("keeps memory equal to swap and a safe number at %s", (_name, resources) => {
    const v: Variant = { image: "redis", user: false, argv: false, mounts: "none", secrets: "none", edge: false };
    const plan = planFor(v, resources);
    const body = buildAppStackContainerCreatePayload(plan, KEY, ctx);
    expectHardenedBody(body, plan, KEY);
    expect(body.HostConfig.MemorySwap).toBe(body.HostConfig.Memory);
    expect(body.HostConfig.NanoCpus).toBe(resources.cpuMilli * 1_000_000);
  });

  it("returns a fresh object each time: mutating one body never weakens the next", () => {
    const v: Variant = { image: "nginx", user: true, argv: true, mounts: "both", secrets: "many", edge: true };
    const plan = planFor(v);
    const first = buildAppStackContainerCreatePayload(plan, KEY, ctx);
    const host = first.HostConfig as unknown as {
      CapDrop: string[];
      SecurityOpt: string[];
      Tmpfs: Record<string, string>;
      LogConfig: { Config: Record<string, string> };
      RestartPolicy: Record<string, string>;
    };
    for (const shared of [host.CapDrop, host.SecurityOpt, host.Tmpfs, host.LogConfig.Config, host.RestartPolicy]) {
      try {
        if (Array.isArray(shared)) shared.push("MUTATED");
        else (shared as Record<string, string>).mutated = "x";
      } catch {
        // a frozen shared constant is also fine
      }
    }
    (first.Cmd as string[] | undefined)?.push("--evil");
    const second = buildAppStackContainerCreatePayload(plan, KEY, ctx);
    expectHardenedBody(second, plan, KEY);
    expect(plan.components[0]?.argv).toStrictEqual(["serve", "--port", "8080"]);
  });

  it("is deterministic and never reads a secret value (same plan, same body)", () => {
    const v: Variant = { image: "mariadb", user: true, argv: false, mounts: "ro", secrets: "many", edge: false };
    const plan = planFor(v);
    expect(buildAppStackContainerCreatePayload(plan, KEY, ctx)).toStrictEqual(buildAppStackContainerCreatePayload(plan, KEY, ctx));
  });

  it.each([
    ["a trailing slash", `${ROOT}/`],
    ["a dot segment", `${ROOT}/./sub/..`],
    ["a root with a double slash", "/run//hosting-panel/secrets"],
  ])("keeps every bind under the (normalised) secret root with %s", (_name, root) => {
    const v: Variant = { image: "postgres", user: true, argv: false, mounts: "rw", secrets: "many", edge: false };
    const plan = planFor(v);
    const body = buildAppStackContainerCreatePayload(plan, KEY, { secretsRootDir: root });
    expectHardenedBody(body, plan, KEY, root);
  });

  it("builds a body per component of a multi-component plan, each only with its own secret directory", () => {
    const one = planFor({ image: "redis", user: true, argv: false, mounts: "none", secrets: "many", edge: false });
    const base = one.components[0] as ApprovedStackPlan["components"][number];
    const draft = {
      ...one,
      components: [
        { ...base, key: "cache", secretFiles: [{ envName: "TOKEN_FILE", parameterKey: "token", version: 1 }], healthcheck: null },
        { ...base, key: "web", dependsOn: ["cache"], secretFiles: [], healthcheck: { kind: "http" as const, port: 8080, path: "/", intervalSeconds: 10, timeoutSeconds: 3 } },
      ],
      ingress: [{ componentKey: "web", port: 8080 }],
    };
    const plan = ApprovedStackPlanSchema.parse({ ...draft, planHash: computeAppStackPlanHash(draft) });
    for (const key of ["cache", "web"]) expectHardenedBody(buildAppStackContainerCreatePayload(plan, key, ctx), plan, key);
    const cache = buildAppStackContainerCreatePayload(plan, "cache", ctx);
    const web = buildAppStackContainerCreatePayload(plan, "web", ctx);
    expect(cache.HostConfig.Binds.join()).toContain(`app_${ID}__cache/`);
    expect(cache.HostConfig.Binds.join()).not.toContain("__web");
    expect(web.HostConfig.Binds).toStrictEqual([]);
    // the internal alias is the bare key; the edge alias is never the bare key (the proxy shares many edge networks)
    expect(web.NetworkingConfig.EndpointsConfig[EDGE]?.Aliases).not.toContain("web");
    expect(Object.keys(cache.NetworkingConfig.EndpointsConfig)).toStrictEqual([NET]);
  });
});

describe("assertAppStackPayloadHardening refuses every weakened variant of the matrix", () => {
  const v: Variant = { image: "nginx", user: true, argv: true, mounts: "both", secrets: "many", edge: true };
  const plan = planFor(v);
  const good = buildAppStackContainerCreatePayload(plan, KEY, ctx);
  const withHost = (host: Record<string, unknown>, top: Record<string, unknown> = {}) =>
    ({ ...good, ...top, HostConfig: { ...good.HostConfig, ...host } }) as unknown as AppStackContainerCreatePayload;

  it("accepts the good body", () => {
    expect(() => assertAppStackPayloadHardening(good, ctx)).not.toThrow();
  });

  it.each([
    ["CapAdd NET_BIND_SERVICE (what the site builder grants nginx)", withHost({ CapAdd: ["NET_BIND_SERVICE"] })],
    ["CapAdd CHOWN SETUID SETGID (what the site builder grants redis)", withHost({ CapAdd: ["CHOWN", "SETUID", "SETGID"] })],
    ["a partial CapDrop", withHost({ CapDrop: ["ALL", "NET_RAW"] })],
    ["a missing CapDrop", withHost({ CapDrop: undefined })],
    ["Privileged", withHost({ Privileged: true })],
    ["a missing Privileged", withHost({ Privileged: undefined })],
    ["seccomp unconfined", withHost({ SecurityOpt: ["seccomp=unconfined"] })],
    ["a writable rootfs", withHost({ ReadonlyRootfs: false })],
    ["a missing ReadonlyRootfs", withHost({ ReadonlyRootfs: undefined })],
    ["a published port", withHost({ PortBindings: { "8080/tcp": [{ HostPort: "8080" }] } })],
    ["a device", withHost({ Devices: [{ PathOnHost: "/dev/sda" }] })],
    ["host pid", withHost({ PidMode: "host" })],
    ["host ipc", withHost({ IpcMode: "host" })],
    ["host network", withHost({ NetworkMode: "host" })],
    ["a container network", withHost({ NetworkMode: "container:hp_ingress_proxy" })],
    ["bridge", withHost({ NetworkMode: "bridge" })],
    ["a bind of /", withHost({ Binds: ["/:/host:ro"] })],
    ["a bind of the docker socket", withHost({ Binds: ["/var/run/docker.sock:/run/secrets/token:ro"] })],
    ["a secret bind outside the root", withHost({ Binds: ["/etc/shadow:/run/secrets/token:ro"] })],
    ["a secret bind escaping with ..", withHost({ Binds: [`${ROOT}/app_${ID}__${KEY}/../../../etc/shadow:/run/secrets/token:ro`] })],
    ["a bind of another stack's secrets", withHost({ Binds: [`${ROOT}/app_stk_other__${KEY}/token:/run/secrets/token:ro`] })],
    ["a read-write secret bind", withHost({ Binds: [`${ROOT}/app_${ID}__${KEY}/token:/run/secrets/token:rw`] })],
    ["a bind mount in Mounts", withHost({ Mounts: [{ Type: "bind", Source: "/", Target: "/host", ReadOnly: false }] })],
    ["a tmpfs mount in Mounts", withHost({ Mounts: [{ Type: "tmpfs", Source: "", Target: "/x", ReadOnly: false }] })],
    ["a volume of the site family", withHost({ Mounts: [{ Type: "volume", Source: "site_files", Target: "/x", ReadOnly: false }] })],
    ["the docker socket in Env", withHost({}, { Env: ["DOCKER_HOST=unix:///var/run/docker.sock"] })],
    ["the docker socket in a label", withHost({}, { Labels: { ...good.Labels, x: "/run/docker.sock" } })],
  ])("refuses %s", (_name, mutated) => {
    expect(() => assertAppStackPayloadHardening(mutated, ctx)).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });
});

// ---- engine level: what actually goes to POST /containers/create, and the secret files on disk ----

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const markerOf = (parameterKey: string, version: number) => `QA-SECRET-${parameterKey}-v${version}-\n"quoted=value"-é9f3b2c71`;

async function deployVariant(v: Variant) {
  const plan = planFor(v);
  const fake = createAppStackFakeEngine();
  const parent = await mkdtemp(path.join(os.tmpdir(), "hp-app-hardening-"));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const secretsRootDir = path.join(parent, "secrets"); // does not exist yet: the engine creates it
  const allowlist: readonly AppImageAllowlistEntry[] = [
    { repository: v.image, runAsUser: v.user ? USER : null, note: "QA hardening matrix image." },
  ];
  const routes = {
    write: vi.fn(async () => ({ changed: false, hostnames: [] as string[] })),
    remove: vi.fn(async () => false),
    read: vi.fn(async () => []),
  };
  const proxy = { containerName: "hp_ingress_proxy_test", ensure: vi.fn(async () => undefined) };
  const probe = vi.fn<AppStackHealthProbe>(async () => "passed");
  const engine = new AppStackEngine({
    request: fake.request,
    secretsRootDir,
    pullMissingImages: true,
    allowlist,
    routes,
    proxy,
    readLogs: vi.fn(async () => []),
    probe,
    now: () => new Date("2026-11-22T03:00:00.000Z"),
  });
  const image = plan.components[0]?.image as string;
  fake.images.set(image, { repoDigests: [image.replace(/^(?:docker\.io\/)?(?:library\/)?/, "")] });
  fake.pullable.add(image);
  const contents = plan.components[0]?.secretFiles.map((s) => ({
    parameterKey: s.parameterKey,
    version: s.version,
    content: markerOf(s.parameterKey, s.version),
  })) ?? [];
  const unique = [...new Map(contents.map((c) => [`${c.parameterKey}:${c.version}`, c])).values()];
  await engine.prepareAppStack({ plan });
  await engine.createAppStackComponents({ plan });
  await engine.startAppStackComponent({ plan, componentKey: KEY, secretFileContents: unique });
  return { plan, fake, engine, secretsRootDir, unique, allowlist };
}

const ENGINE_ROWS: Variant[] = [
  { image: "redis", user: false, argv: false, mounts: "none", secrets: "none", edge: false },
  { image: "redis", user: true, argv: true, mounts: "rw", secrets: "one", edge: true },
  { image: "nginx", user: false, argv: true, mounts: "ro", secrets: "many", edge: true },
  { image: "postgres", user: true, argv: false, mounts: "both", secrets: "many", edge: false },
  { image: "mariadb", user: true, argv: true, mounts: "both", secrets: "one", edge: true },
  { image: "mysql", user: false, argv: false, mounts: "rw", secrets: "many", edge: false },
  { image: "wordpress", user: true, argv: true, mounts: "none", secrets: "many", edge: true },
  { image: "registry.test/acme/web", user: false, argv: false, mounts: "ro", secrets: "one", edge: false },
];

describe("engine create bodies and secret files (A8, A11)", () => {
  it.each(ENGINE_ROWS.map((v) => [label(v), v] as const))("sends a hardened body and no secret value anywhere: %s", async (_name, v) => {
    const { plan, fake, secretsRootDir, unique, allowlist } = await deployVariant(v);
    const [createKey] = [...fake.bodies.keys()].filter((line) => line.startsWith("POST /containers/create"));
    expect(createKey).toBeDefined();
    const sent = fake.bodies.get(createKey as string) as AppStackContainerCreatePayload[];
    expect(sent).toHaveLength(1);
    expectHardenedBody(sent[0] as AppStackContainerCreatePayload, plan, KEY, secretsRootDir, allowlist);

    // the Engine now holds this body as the container's config: Config.Env is its Env
    const stored = fake.containers.get(`hp_app_${ID}_${KEY}`)?.body as AppStackContainerCreatePayload;
    const everything = JSON.stringify([...fake.bodies.entries()]) + JSON.stringify(stored) + JSON.stringify(fake.log);
    for (const entry of unique) {
      for (const fragment of [entry.content, JSON.stringify(entry.content), encodeURIComponent(entry.content), "QA-SECRET", "quoted=value"]) {
        expect(everything).not.toContain(fragment);
      }
    }
    for (const line of stored.Env) expect(line).not.toContain("QA-SECRET");

    // A11: nothing mounts anything from outside the secret root
    for (const bind of stored.HostConfig.Binds) expect(bind.startsWith(`${path.resolve(secretsRootDir)}/app_${ID}__${KEY}/`)).toBe(true);
    expect(everything).not.toContain("docker.sock");
  });

  it.each(ENGINE_ROWS.filter((v) => v.secrets !== "none").map((v) => [label(v), v] as const))(
    "writes the secret directory 0700 and every file 0444 with the exact content, nothing else: %s",
    async (_name, v) => {
      const { plan, secretsRootDir, unique } = await deployVariant(v);
      const dir = path.join(secretsRootDir, `app_${ID}__${KEY}`);
      expect((await stat(secretsRootDir)).mode & 0o777).toBe(0o700);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      const parameterKeys = [...new Set(plan.components[0]?.secretFiles.map((s) => s.parameterKey))].sort();
      expect((await readdir(dir)).sort()).toStrictEqual(parameterKeys);
      for (const entry of unique) {
        const file = path.join(dir, entry.parameterKey);
        const info = await stat(file);
        expect(info.mode & 0o777).toBe(0o444);
        expect(info.isFile()).toBe(true);
        expect(info.isSymbolicLink()).toBe(false);
        expect(await readFile(file, "utf8")).toBe(entry.content);
      }
      // only this component's directory exists under the root
      expect(await readdir(secretsRootDir)).toStrictEqual([`app_${ID}__${KEY}`]);
    },
  );

  it("creates no secret directory for a component without secret files", async () => {
    const { secretsRootDir } = await deployVariant(ENGINE_ROWS[0] as Variant);
    const entries = await readdir(secretsRootDir).catch(() => [] as string[]);
    expect(entries.filter((name) => name.startsWith("app_"))).toStrictEqual([]);
  });

  it("a restart with rotated secrets rewrites the files with the same modes and sends no new body with a value", async () => {
    const v: Variant = { image: "redis", user: true, argv: false, mounts: "rw", secrets: "many", edge: false };
    const { plan, fake, engine, secretsRootDir, unique } = await deployVariant(v);
    const rotated = unique.map((e) => ({ ...e, content: `ROTATED-${e.parameterKey}-77aa31` }));
    await engine.restartAppStackComponent({ plan, componentKey: KEY, secretFileContents: rotated });
    const dir = path.join(secretsRootDir, `app_${ID}__${KEY}`);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const entry of rotated) {
      const file = path.join(dir, entry.parameterKey);
      expect((await stat(file)).mode & 0o777).toBe(0o444);
      expect(await readFile(file, "utf8")).toBe(entry.content);
    }
    const everything = JSON.stringify([...fake.bodies.entries()]) + JSON.stringify(fake.log);
    expect(everything).not.toContain("ROTATED-");
    expect(everything).not.toContain("QA-SECRET");
  });

  it("every create body of a multi-component deploy is hardened and the secret of one component stays out of the other", async () => {
    const one = planFor({ image: "redis", user: true, argv: false, mounts: "none", secrets: "many", edge: false });
    const base = one.components[0] as ApprovedStackPlan["components"][number];
    const draft = {
      ...one,
      components: [
        { ...base, key: "cache", secretFiles: [{ envName: "TOKEN_FILE", parameterKey: "token", version: 1 }], healthcheck: null },
        { ...base, key: "web", dependsOn: ["cache"], secretFiles: [], healthcheck: { kind: "http" as const, port: 8080, path: "/", intervalSeconds: 10, timeoutSeconds: 3 } },
      ],
      ingress: [{ componentKey: "web", port: 8080 }],
    };
    const plan = ApprovedStackPlanSchema.parse({ ...draft, planHash: computeAppStackPlanHash(draft) });
    const fake = createAppStackFakeEngine();
    const parent = await mkdtemp(path.join(os.tmpdir(), "hp-app-hardening-"));
    cleanups.push(() => rm(parent, { recursive: true, force: true }));
    const secretsRootDir = path.join(parent, "secrets");
    const allowlist: readonly AppImageAllowlistEntry[] = [{ repository: "redis", runAsUser: USER, note: "QA hardening matrix image." }];
    const engine = new AppStackEngine({
      request: fake.request,
      secretsRootDir,
      pullMissingImages: true,
      allowlist,
      routes: { write: vi.fn(async () => ({ changed: false, hostnames: [] as string[] })), remove: vi.fn(async () => false), read: vi.fn(async () => []) },
      proxy: { containerName: "hp_ingress_proxy_test", ensure: vi.fn(async () => undefined) },
      readLogs: vi.fn(async () => []),
      probe: vi.fn<AppStackHealthProbe>(async () => "passed"),
      now: () => new Date("2026-11-22T03:00:00.000Z"),
    });
    const image = base.image;
    fake.images.set(image, { repoDigests: [`redis@sha256:${DIGEST}`] });
    await engine.prepareAppStack({ plan });
    await engine.createAppStackComponents({ plan });
    await engine.startAppStackComponent({ plan, componentKey: "cache", secretFileContents: [{ parameterKey: "token", version: 1, content: "CACHE-ONLY-TOKEN-5d1e" }] });
    await engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    for (const key of ["cache", "web"]) {
      const sent = fake.bodies.get(`POST /containers/create?name=hp_app_${ID}_${key}`) as AppStackContainerCreatePayload[];
      expect(sent).toHaveLength(1);
      expectHardenedBody(sent[0] as AppStackContainerCreatePayload, plan, key, secretsRootDir, allowlist);
    }
    expect(JSON.stringify([...fake.bodies.entries()])).not.toContain("CACHE-ONLY-TOKEN");
    expect(await readdir(secretsRootDir)).toStrictEqual([`app_${ID}__cache`]);
  });
});
