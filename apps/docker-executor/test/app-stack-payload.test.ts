import { APP_IMAGE_ALLOWLIST, type ApprovedStackPlan } from "@hosting-panel/contracts";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";
import { describe, expect, it } from "vitest";
import {
  APP_STACK_LOG_CONFIG,
  APP_STACK_RESTART_POLICY,
  APP_STACK_SCRATCH_TMPFS_OPTIONS,
  APP_STACK_STOP_TIMEOUT_SECONDS,
  APP_STACK_TMPFS,
  appStackTmpfs,
  assertAppStackPayloadHardening,
  assertAppStackSecretContents,
  buildAppStackContainerCreatePayload,
  decodeAppStackHealthLabel,
  encodeAppStackHealthLabel,
  type AppStackContainerCreatePayload,
} from "../src/app-stacks/index.js";
import { appStackTestPlan } from "./support/app-stack-plans.js";

const ROOT = "/run/hosting-panel/secrets";
const ctx = { secretsRootDir: ROOT };
const plan = appStackTestPlan();
const [web, worker] = plan.components as [ApprovedStackPlan["components"][number], ApprovedStackPlan["components"][number]];
const ID = plan.stackId;
const NET = `hp_appnet_${ID}`;
const EDGE = `hp_appedge_${ID}`;

const hardened = {
  Privileged: false,
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges:true"],
  ReadonlyRootfs: true,
  Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=64m" },
  PidsLimit: 256,
  RestartPolicy: { Name: "unless-stopped" },
  NetworkMode: NET,
  LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
};

function labels(key: string, startIndex: string, health: string) {
  return {
    "io.hostingpanel.managed": "true",
    "io.hostingpanel.role": "app_component",
    "io.hostingpanel.stack_id": ID,
    "io.hostingpanel.organization_id": "org_acme",
    "io.hostingpanel.app_component": key,
    "io.hostingpanel.app_component_hash": computeAppStackComponentHash(plan, key),
    "io.hostingpanel.app_revision_id": plan.revisionId,
    "io.hostingpanel.app_start_index": startIndex,
    "io.hostingpanel.app_health": health,
  };
}

describe("buildAppStackContainerCreatePayload", () => {
  it("builds the full body of an ingress component", () => {
    expect(buildAppStackContainerCreatePayload(plan, "web", ctx)).toStrictEqual({
      Image: web.image,
      User: "65534:65534",
      Env: ["APP_MODE=production"],
      Labels: labels("web", "0", "http:8080:3:/healthz"),
      ExposedPorts: { "8080/tcp": {} },
      StopTimeout: 10,
      HostConfig: { ...hardened, NanoCpus: 500_000_000, Memory: 268_435_456, MemorySwap: 268_435_456, Binds: [], Mounts: [] },
      NetworkingConfig: {
        EndpointsConfig: { [NET]: { Aliases: ["web"] }, [`hp_appedge_${ID}`]: { Aliases: [`hp_app_${ID}_web`] } },
      },
    });
  });

  it("builds the full body of a component with a secret file and a volume", () => {
    expect(buildAppStackContainerCreatePayload(plan, "worker", ctx)).toStrictEqual({
      Image: worker.image,
      User: "65534:65534",
      Cmd: ["worker", "--queue", "default"],
      Env: ["WEB_HOST=web", "SHARED_KEY_FILE=/run/secrets/shared_key"],
      Labels: labels("worker", "1", "none"),
      ExposedPorts: {},
      StopTimeout: 10,
      HostConfig: {
        ...hardened,
        NanoCpus: 250_000_000,
        Memory: 134_217_728,
        MemorySwap: 134_217_728,
        Binds: [`${ROOT}/app_${ID}__worker/shared_key:/run/secrets/shared_key:ro`],
        Mounts: [{ Type: "volume", Source: `hp_appvol_${ID}_data`, Target: "/data", ReadOnly: false }],
      },
      NetworkingConfig: { EndpointsConfig: { [NET]: { Aliases: ["worker"] } } },
    });
  });

  it("exposes the fixed hardening constants", () => {
    expect(APP_STACK_TMPFS).toEqual(hardened.Tmpfs);
    expect(APP_STACK_STOP_TIMEOUT_SECONDS).toBe(10);
    expect(APP_STACK_RESTART_POLICY).toEqual(hardened.RestartPolicy);
    expect(APP_STACK_LOG_CONFIG).toEqual(hardened.LogConfig);
    expect(Object.isFrozen(APP_STACK_LOG_CONFIG.Config)).toBe(true);
  });

  it("sets User and Cmd only from the plan, never Entrypoint, CapAdd or ports", () => {
    const noUser = appStackTestPlan({ components: [{ ...web, runAsUser: null }, worker] });
    expect(buildAppStackContainerCreatePayload(noUser, "web", ctx)).not.toHaveProperty("User");
    expect(buildAppStackContainerCreatePayload(plan, "web", ctx)).not.toHaveProperty("Cmd");
    for (const key of ["web", "worker"]) {
      const body = buildAppStackContainerCreatePayload(plan, key, ctx);
      for (const absent of ["Entrypoint", "Healthcheck", "Hostname"]) expect(body).not.toHaveProperty(absent);
      for (const absent of ["CapAdd", "PortBindings", "PublishAllPorts", "Devices", "PidMode", "IpcMode", "UsernsMode", "Sysctls", "ExtraHosts", "Init"]) {
        expect(body.HostConfig).not.toHaveProperty(absent);
      }
    }
  });

  it("joins the edge network only for ingress components", () => {
    const internalOnly = appStackTestPlan({ ingress: [] });
    expect(buildAppStackContainerCreatePayload(internalOnly, "web", ctx).NetworkingConfig).toEqual({
      EndpointsConfig: { [NET]: { Aliases: ["web"] } },
    });
  });

  it("binds each parameter once, ascending, and keeps env in plan order", () => {
    const secrets = appStackTestPlan({
      components: [
        web,
        {
          ...worker,
          secretFiles: [
            { envName: "API_KEY_FILE", parameterKey: "zeta_key", version: 3 },
            { envName: "SHARED_COPY_FILE", parameterKey: "shared_key", version: 1 },
            { envName: "SHARED_KEY_FILE", parameterKey: "shared_key", version: 1 },
          ],
          volumes: [{ volumeKey: "data", containerPath: "/data", readOnly: true }],
        },
      ],
    });
    const body = buildAppStackContainerCreatePayload(secrets, "worker", { secretsRootDir: `${ROOT}/` });
    expect(body.Env).toEqual([
      "WEB_HOST=web",
      "API_KEY_FILE=/run/secrets/zeta_key",
      "SHARED_COPY_FILE=/run/secrets/shared_key",
      "SHARED_KEY_FILE=/run/secrets/shared_key",
    ]);
    expect(body.HostConfig.Binds).toEqual([
      `${ROOT}/app_${ID}__worker/shared_key:/run/secrets/shared_key:ro`,
      `${ROOT}/app_${ID}__worker/zeta_key:/run/secrets/zeta_key:ro`,
    ]);
    expect(body.HostConfig.Mounts).toEqual([{ Type: "volume", Source: `hp_appvol_${ID}_data`, Target: "/data", ReadOnly: true }]);
    assertAppStackPayloadHardening(body, ctx);
  });

  it("never carries a secret value", () => {
    const marker = "MARKER-7f3a9c-secret";
    const contents = assertAppStackSecretContents(plan, "worker", [{ parameterKey: "shared_key", version: 1, content: marker }]);
    expect(contents).toEqual({ shared_key: marker });
    for (const key of ["web", "worker"]) {
      expect(JSON.stringify(buildAppStackContainerCreatePayload(plan, key, ctx))).not.toContain(marker);
    }
  });

  it("refuses a component outside the plan", () => {
    expect(() => buildAppStackContainerCreatePayload(plan, "ghost", ctx)).toThrow(RangeError);
  });
});

describe("assertAppStackPayloadHardening", () => {
  const body = buildAppStackContainerCreatePayload(plan, "worker", ctx);
  const webBody = buildAppStackContainerCreatePayload(plan, "web", ctx);
  const withPlan = { ...ctx, plan };
  const mutate = (host: Record<string, unknown>, top: Record<string, unknown> = {}, base = body) =>
    ({ ...base, ...top, HostConfig: { ...base.HostConfig, ...host } }) as unknown as AppStackContainerCreatePayload;
  const endpoints = (config: Record<string, unknown>, base = body) => mutate({}, { NetworkingConfig: { EndpointsConfig: config } }, base);

  it("accepts the built bodies, with and without the plan", () => {
    for (const key of ["web", "worker"]) {
      const built = buildAppStackContainerCreatePayload(plan, key, ctx);
      expect(() => assertAppStackPayloadHardening(built, ctx)).not.toThrow();
      expect(() => assertAppStackPayloadHardening(built, withPlan)).not.toThrow();
    }
  });

  it.each([
    ["root as the user", mutate({}, { User: "0" })],
    ["no user", mutate({}, { User: undefined })],
    ["the edge network on a component without ingress", endpoints({ [NET]: { Aliases: ["worker"] }, [EDGE]: { Aliases: [`hp_app_${ID}_worker`] } })],
    ["an ingress component without its edge network", endpoints({ [NET]: { Aliases: ["web"] } }, webBody)],
    ["a component outside the plan", mutate({}, { Labels: { ...body.Labels, "io.hostingpanel.app_component": "ghost" } })],
  ])("with the plan refuses %s", (_name, mutated) => {
    expect(() => assertAppStackPayloadHardening(mutated, withPlan)).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });

  it.each([
    ["CapAdd", mutate({ CapAdd: ["NET_ADMIN"] })],
    ["an empty CapAdd", mutate({ CapAdd: [] })],
    ["Privileged", mutate({ Privileged: true })],
    ["a CapDrop that keeps capabilities", mutate({ CapDrop: ["NET_RAW"] })],
    ["no no-new-privileges", mutate({ SecurityOpt: [] })],
    ["a writable root filesystem", mutate({ ReadonlyRootfs: false })],
    ["PortBindings", mutate({ PortBindings: { "8080/tcp": [{ HostPort: "80" }] } })],
    ["Devices", mutate({ Devices: [] })],
    ["the host PID namespace", mutate({ PidMode: "host" })],
    ["the host IPC namespace", mutate({ IpcMode: "host" })],
    ["the host network", mutate({ NetworkMode: "host" })],
    ["another stack's network", mutate({ NetworkMode: "hp_appnet_stk_other" })],
    ["a bind outside the root", mutate({ Binds: ["/etc/passwd:/run/secrets/shared_key:ro"] })],
    ["a bind of another component", mutate({ Binds: [`${ROOT}/app_${ID}__web/shared_key:/run/secrets/shared_key:ro`] })],
    ["a writable secret bind", mutate({ Binds: [`${ROOT}/app_${ID}__worker/shared_key:/run/secrets/shared_key`] })],
    ["a secret bind on another path", mutate({ Binds: [`${ROOT}/app_${ID}__worker/shared_key:/etc/shared_key:ro`] })],
    ["a mount of type bind", mutate({ Mounts: [{ Type: "bind", Source: "/srv", Target: "/data", ReadOnly: false }] })],
    ["a foreign volume", mutate({ Mounts: [{ Type: "volume", Source: "site_data", Target: "/data", ReadOnly: false }] })],
    ["another stack's volume", mutate({ Mounts: [{ Type: "volume", Source: "hp_appvol_stk_other_data", Target: "/data", ReadOnly: false }] })],
    ["the docker socket", mutate({}, { Env: ["SOCK=/run/docker.sock"] })],
    ["the docker socket in Cmd", mutate({}, { Cmd: ["--socket=/run/Docker.sock"] })],
    ["a secret root under /var/run", mutate({ Binds: [`/var/run/x/app_${ID}__worker/shared_key:/run/secrets/shared_key:ro`] })],
    ["a second SecurityOpt entry", mutate({ SecurityOpt: ["no-new-privileges:true", "seccomp=unconfined"] })],
    ["UsernsMode", mutate({ UsernsMode: "host" })],
    ["Sysctls", mutate({ Sysctls: { "net.ipv4.ip_forward": "1" } })],
    ["PublishAllPorts", mutate({ PublishAllPorts: true })],
    ["CgroupParent", mutate({ CgroupParent: "/" })],
    ["ExtraHosts", mutate({ ExtraHosts: ["metadata:169.254.169.254"] })],
    ["Entrypoint", mutate({}, { Entrypoint: ["/bin/sh"] })],
    ["an extra label", mutate({}, { Labels: { ...body.Labels, x: "y" } })],
    ["a volume with driver options", mutate({ Mounts: [{ ...body.HostConfig.Mounts[0], VolumeOptions: { DriverConfig: { Name: "local" } } }] })],
    ["an executable /tmp", mutate({ Tmpfs: { "/tmp": "rw,exec,size=64m" } })],
    ["a second tmpfs", mutate({ Tmpfs: { ...APP_STACK_TMPFS, "/data": "rw" } })],
    ["no pids limit", mutate({ PidsLimit: -1 })],
    ["another pids limit", mutate({ PidsLimit: 4096 })],
    ["no memory limit", mutate({ Memory: 0, MemorySwap: 0 })],
    ["memory above the plan ceiling", mutate({ Memory: 2 ** 35, MemorySwap: 2 ** 35 })],
    ["unlimited swap", mutate({ MemorySwap: -1 })],
    ["no CPU limit", mutate({ NanoCpus: 0 })],
    ["CPU above the plan ceiling", mutate({ NanoCpus: 32_000_000_000 })],
    ["a CPU value that is not whole millicores", mutate({ NanoCpus: 250_000_001 })],
    ["an extra network", endpoints({ [NET]: { Aliases: ["worker"] }, hp_ingress_net: { Aliases: ["worker"] } })],
    ["another stack's network endpoint", endpoints({ [NET]: { Aliases: ["worker"] }, hp_appnet_stk_other: { Aliases: ["worker"] } })],
    ["a fixed endpoint address", endpoints({ [NET]: { Aliases: ["worker"], IPAMConfig: { IPv4Address: "10.1.0.9" } } })],
    ["another alias", endpoints({ [NET]: { Aliases: ["web"] } })],
    ["no private network endpoint", endpoints({})],
    ["the bare key on the edge network", endpoints({ [NET]: { Aliases: ["web"] }, [EDGE]: { Aliases: ["web"] } }, webBody)],
    ["the site job role", mutate({}, { Labels: { ...body.Labels, "io.hostingpanel.role": "site_job" } })],
  ])("refuses %s", (_name, mutated) => {
    expect(() => assertAppStackPayloadHardening(mutated, ctx)).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });

  it("accepts /var/run and docker.sock text the plan schema accepts outside host paths", () => {
    const texts = appStackTestPlan({
      components: [
        { ...web, healthcheck: { kind: "http", port: 8080, path: "/var/run/status", intervalSeconds: 10, timeoutSeconds: 3 } },
        {
          ...worker,
          argv: ["worker", "--pid=/var/run/app.pid"],
          environment: [{ name: "PIDFILE", value: "/var/run/app.pid" }],
          volumes: [{ volumeKey: "data", containerPath: "/srv/docker.sock", readOnly: false }],
        },
      ],
    });
    for (const key of ["web", "worker"]) {
      expect(() => assertAppStackPayloadHardening(buildAppStackContainerCreatePayload(texts, key, ctx), ctx)).not.toThrow();
    }
  });
});

describe("temporary areas follow the allowlist row of the image (ADR-0039)", () => {
  const SCRATCH = "rw,noexec,nosuid,nodev,size=1m";
  const row = (scratchPaths?: string[]) => [
    { repository: "registry.test/acme/web", runAsUser: "65534:65534", note: "Test image.", ...(scratchPaths ? { scratchPaths } : {}) },
  ];
  const declared = { ...ctx, allowlist: row(["/run/postgresql"]) };
  const denied = expect.objectContaining({ code: "HOST_POLICY_DENIED", message: "The application container body breaks the Tmpfs rule" });

  it("gives /tmp alone to an image whose row declares none: the bodies of existing applications do not change", () => {
    expect(appStackTmpfs(web.image)).toEqual(APP_STACK_TMPFS);
    expect(appStackTmpfs(web.image, row())).toEqual(APP_STACK_TMPFS);
    for (const key of ["web", "worker"]) {
      expect(buildAppStackContainerCreatePayload(plan, key, { ...ctx, allowlist: row() })).toStrictEqual(
        buildAppStackContainerCreatePayload(plan, key, ctx),
      );
    }
  });

  it("adds exactly the declared area, small and not executable, and changes nothing else", () => {
    const built = buildAppStackContainerCreatePayload(plan, "web", declared);
    expect(APP_STACK_SCRATCH_TMPFS_OPTIONS).toBe(SCRATCH);
    expect(built.HostConfig.Tmpfs).toStrictEqual({ "/tmp": "rw,noexec,nosuid,nodev,size=64m", "/run/postgresql": SCRATCH });
    const plain = buildAppStackContainerCreatePayload(plan, "web", ctx);
    expect({ ...built, HostConfig: { ...built.HostConfig, Tmpfs: plain.HostConfig.Tmpfs } }).toStrictEqual(plain);
    expect(() => assertAppStackPayloadHardening(built, declared)).not.toThrow();
    expect(() => assertAppStackPayloadHardening(built, { ...declared, plan })).not.toThrow();
  });

  it("in the real allowlist only PostgreSQL has one: the directory of its socket", () => {
    const withArea = APP_IMAGE_ALLOWLIST.filter((entry) => (entry.scratchPaths ?? []).length > 0).map((entry) => entry.repository);
    expect(withArea).toEqual(["postgres"]);
    for (const entry of APP_IMAGE_ALLOWLIST) {
      const areas = appStackTmpfs(`${entry.repository}@sha256:${"a".repeat(64)}`);
      expect(areas).toEqual(entry.repository === "postgres" ? { ...APP_STACK_TMPFS, "/run/postgresql": SCRATCH } : APP_STACK_TMPFS);
    }
  });

  it("refuses a body whose areas are not the ones the row of its image gives", () => {
    const built = buildAppStackContainerCreatePayload(plan, "web", declared);
    const plain = buildAppStackContainerCreatePayload(plan, "web", ctx);
    const tmpfs = (areas: Record<string, string>) =>
      ({ ...built, HostConfig: { ...built.HostConfig, Tmpfs: areas } }) as unknown as AppStackContainerCreatePayload;
    // An area the row does not declare, a declared area that is missing, other options, an area of another image.
    expect(() => assertAppStackPayloadHardening(built, ctx)).toThrow(denied);
    expect(() => assertAppStackPayloadHardening(plain, declared)).toThrow(denied);
    expect(() => assertAppStackPayloadHardening(tmpfs({ ...APP_STACK_TMPFS, "/run/postgresql": "rw,exec,size=1g" }), declared)).toThrow(denied);
    expect(() => assertAppStackPayloadHardening(tmpfs({ ...APP_STACK_TMPFS, "/run/mysqld": SCRATCH }), declared)).toThrow(denied);
    expect(() => assertAppStackPayloadHardening(tmpfs({ "/run/postgresql": SCRATCH }), declared)).toThrow(denied);
    expect(() =>
      assertAppStackPayloadHardening({ ...built, Image: `registry.test/acme/other@sha256:${"d".repeat(64)}` }, declared),
    ).toThrow(denied);
  });

  it.each([
    ["a path outside /run", ["/var/lib/postgresql"]],
    ["the directory of the reserved values", ["/run/secrets"]],
    ["/run itself", ["/run"]],
    ["/tmp again", ["/tmp"]],
    ["a nested path", ["/run/postgresql/data"]],
    ["a path that climbs out", ["/run/../etc"]],
    ["the Docker socket", ["/run/docker.sock"]],
    ["more areas than the cap", ["/run/a", "/run/b", "/run/c"]],
    ["the same area twice", ["/run/a", "/run/a"]],
  ])("refuses a row that declares %s", (_name, paths) => {
    expect(() => appStackTmpfs(web.image, row(paths))).toThrow(denied);
    expect(() => buildAppStackContainerCreatePayload(plan, "web", { ...ctx, allowlist: row(paths) })).toThrow(denied);
    const plain = buildAppStackContainerCreatePayload(plan, "web", ctx);
    expect(() => assertAppStackPayloadHardening(plain, { ...ctx, allowlist: row(paths) })).toThrow(denied);
  });
});

describe("health label", () => {
  it.each([
    [null, "none"],
    [{ kind: "tcp", port: 6379, intervalSeconds: 10, timeoutSeconds: 3 }, "tcp:6379:3"],
    [{ kind: "http", port: 8080, path: "/healthz", intervalSeconds: 30, timeoutSeconds: 30 }, "http:8080:30:/healthz"],
  ] as const)("encodes %j as %s", (health, label) => {
    expect(encodeAppStackHealthLabel(health)).toBe(label);
  });

  it.each([
    ["none", { kind: "none" }],
    ["tcp:6379:3", { kind: "tcp", port: 6379, timeoutSeconds: 3 }],
    ["tcp:65535:1", { kind: "tcp", port: 65_535, timeoutSeconds: 1 }],
    ["http:8080:30:/healthz", { kind: "http", port: 8080, timeoutSeconds: 30, path: "/healthz" }],
    ["http:80:3:/", { kind: "http", port: 80, timeoutSeconds: 3, path: "/" }],
  ])("decodes %s", (label, health) => {
    expect(decodeAppStackHealthLabel(label)).toEqual(health);
  });

  it.each([
    undefined, "", "None", " none", "tcp:0:3", "tcp:65536:3", "tcp:8080:0", "tcp:8080:31", "tcp:8080", "tcp:8080:3:/x",
    "tcp:123456:3", "http:8080:3", "http:8080:3:healthz", "http:8080:3:/../x", "http:8080:3:/a//b", "http:8080:3:/a?b",
    "http:8080:3:/a b", "udp:53:3",
  ])("refuses the malformed label %j", (label) => {
    expect(decodeAppStackHealthLabel(label)).toBeNull();
  });

  it("round-trips the fixture checks", () => {
    expect(decodeAppStackHealthLabel(encodeAppStackHealthLabel(web.healthcheck))).toEqual({ kind: "http", port: 8080, timeoutSeconds: 3, path: "/healthz" });
    expect(decodeAppStackHealthLabel(encodeAppStackHealthLabel(worker.healthcheck))).toEqual({ kind: "none" });
  });
});
