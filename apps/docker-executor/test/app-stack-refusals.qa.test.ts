import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApprovedStackPlanSchema, type IpcSigningKey, type IpcVerificationKey } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  ExecutorIpcClientError,
  SignedDockerExecutorIpcClient,
} from "../src/index.js";
import { AppStackEngine, assertExecutableAppStackPlan, type AppStackHealthProbe } from "../src/app-stacks/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";
import { createAppStackFakeEngine } from "./support/app-stack-fake-engine.js";
import { TEST_ALLOWLIST, appStackTestPlan, rehash } from "./support/app-stack-plans.js";

/**
 * A12 / A13, executor half (arch-executor §5.3, §14 Q1): a plan the executor must not run is refused with the exact
 * reason BEFORE any Engine request, on every plan-carrying method, in process and through the signed IPC server.
 */

type Plan = ReturnType<typeof appStackTestPlan>;
type Loose = Record<string, unknown>;

const IMAGE = "registry.test/acme/web";
const DIGEST = `sha256:${"c".repeat(64)}`;
const base = appStackTestPlan();
const MAX_BYTES = 262_144;

/** Deep copy of the test plan, edited, then re-hashed so that only the edited rule can refuse it. */
function edit(change: (plan: Plan) => void, options: { rehashed?: boolean } = {}): Plan {
  const plan = structuredClone(base);
  change(plan);
  if (options.rehashed === false) return plan;
  try {
    return rehash(plan);
  } catch {
    // The canonical hash itself refuses a plan it cannot represent (an unknown key): leave the stale hash.
    return plan;
  }
}

const web = (plan: Plan) => plan.components[0] as Plan["components"][number];
const worker = (plan: Plan) => plan.components[1] as Plan["components"][number];
const asLoose = (value: unknown) => value as Loose;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const envEntries = (n: number, valueLength = 1) =>
  Array.from({ length: n }, (_, i) => ({ name: `E${pad(i)}`, value: "a".repeat(valueLength) }));

// ---- expectations -------------------------------------------------------------------------------------------------

interface Expected {
  readonly reason: string;
  readonly code: string;
  readonly message: string;
}
const invalid = (at: string): Expected => ({
  reason: "STACK_PLAN_INVALID",
  code: "VALIDATION_ERROR",
  message: at === "" ? "The application plan is invalid" : `The application plan is invalid at ${at}`,
});
const notAllowed = (componentKey: string, problem: string): Expected => ({
  reason: "STACK_IMAGE_NOT_ALLOWED",
  code: "HOST_POLICY_DENIED",
  message: `The image of component ${componentKey} is not allowed (${problem})`,
});
const HASH: Expected = {
  reason: "STACK_PLAN_HASH_MISMATCH",
  code: "HOST_POLICY_DENIED",
  message: "The application plan does not match its hash",
};

type Row = readonly [name: string, plan: () => Plan, expected: Expected];

// ---- the tables ---------------------------------------------------------------------------------------------------

/** Every ceiling of core-language §2.1: `build(limit)` is accepted, `build(limit + 1)` is refused at `at`. */
const CEILINGS: ReadonlyArray<readonly [name: string, limit: number, build: (n: number) => Plan, at: string]> = [
  [
    "components",
    8,
    (n) =>
      edit((p) => {
        p.components = Array.from({ length: n }, (_, i) => ({ ...web(p), key: `c${i}` }));
        p.volumes = [];
        p.ingress = [];
      }),
    "components",
  ],
  [
    "plan volumes",
    8,
    (n) =>
      edit((p) => {
        p.volumes = Array.from({ length: n }, (_, i) => ({ key: `v${i}` }));
        const half = Math.ceil(n / 2);
        web(p).volumes = Array.from({ length: half }, (_, i) => ({ volumeKey: `v${i}`, containerPath: `/m${i}`, readOnly: false }));
        worker(p).volumes = Array.from({ length: n - half }, (_, i) => ({ volumeKey: `v${half + i}`, containerPath: `/n${i}`, readOnly: true }));
      }),
    "volumes",
  ],
  [
    "ingress routes",
    8,
    (n) =>
      edit((p) => {
        const ports = Array.from({ length: n }, (_, i) => 8080 + i);
        web(p).expose = ports;
        p.ingress = ports.map((port) => ({ componentKey: "web", port }));
      }),
    "ingress",
  ],
  [
    "exposed ports of one component",
    16,
    (n) =>
      edit((p) => {
        web(p).expose = Array.from({ length: n }, (_, i) => 8080 + i);
      }),
    "components.0.expose",
  ],
  [
    "exposed ports of the stack",
    16,
    (n) =>
      edit((p) => {
        web(p).expose = Array.from({ length: Math.ceil(n / 2) }, (_, i) => 8080 + i);
        worker(p).expose = Array.from({ length: Math.floor(n / 2) }, (_, i) => 9000 + i);
      }),
    "components",
  ],
  [
    "argv items",
    64,
    (n) =>
      edit((p) => {
        worker(p).argv = ["worker", ...Array.from({ length: n - 1 }, () => "a")];
      }),
    "components.1.argv",
  ],
  [
    "argv item length",
    1_024,
    (n) =>
      edit((p) => {
        worker(p).argv = ["worker", "a".repeat(n)];
      }),
    "components.1.argv.1",
  ],
  [
    "environment entries",
    64,
    (n) =>
      edit((p) => {
        web(p).environment = envEntries(n);
      }),
    "components.0.environment",
  ],
  [
    "environment value length",
    4_096,
    (n) =>
      edit((p) => {
        web(p).environment = envEntries(1, n);
      }),
    "components.0.environment.0.value",
  ],
  [
    "environment + secret file entries",
    63,
    (n) =>
      edit((p) => {
        worker(p).environment = envEntries(n);
      }),
    "components.1.environment",
  ],
  [
    "distinct secret parameters",
    8,
    (n) =>
      edit((p) => {
        worker(p).secretFiles = Array.from({ length: n }, (_, i) => ({ envName: `K${pad(i)}_FILE`, parameterKey: `p${pad(i)}`, version: 1 }));
      }),
    "components",
  ],
  [
    "secret version",
    2_147_483_646,
    (n) =>
      edit((p) => {
        worker(p).secretFiles = [{ envName: "SHARED_KEY_FILE", parameterKey: "shared_key", version: n + 1 }];
      }),
    "components.1.secretFiles.0.version",
  ],
  [
    "mounts per component",
    8,
    (n) =>
      edit((p) => {
        p.volumes = Array.from({ length: n }, (_, i) => ({ key: `v${i}` }));
        worker(p).volumes = Array.from({ length: n }, (_, i) => ({ volumeKey: `v${i}`, containerPath: `/m${i}`, readOnly: false }));
      }),
    "components.1.volumes",
  ],
  [
    "container path length",
    255,
    (n) =>
      edit((p) => {
        worker(p).volumes = [{ volumeKey: "data", containerPath: `/${"a".repeat(n - 1)}`, readOnly: false }];
      }),
    "components.1.volumes.0.containerPath",
  ],
  [
    "health interval (max)",
    300,
    (n) =>
      edit((p) => {
        web(p).healthcheck = { kind: "http", port: 8080, path: "/healthz", intervalSeconds: n, timeoutSeconds: 3 };
      }),
    "components.0.healthcheck.intervalSeconds",
  ],
  [
    "health timeout (max)",
    30,
    (n) =>
      edit((p) => {
        web(p).healthcheck = { kind: "http", port: 8080, path: "/healthz", intervalSeconds: 300, timeoutSeconds: n };
      }),
    "components.0.healthcheck.timeoutSeconds",
  ],
  [
    "health path length",
    256,
    (n) =>
      edit((p) => {
        web(p).healthcheck = { kind: "http", port: 8080, path: `/${"a".repeat(n - 1)}`, intervalSeconds: 10, timeoutSeconds: 3 };
      }),
    "components.0.healthcheck.path",
  ],
  [
    "cpu (max)",
    16_000,
    (n) =>
      edit((p) => {
        web(p).resources = { cpuMilli: n, memoryBytes: "268435456" };
      }),
    "components.0.resources.cpuMilli",
  ],
  [
    "memory (max)",
    17_179_869_184,
    (n) =>
      edit((p) => {
        web(p).resources = { cpuMilli: 500, memoryBytes: String(n) };
      }),
    "components.0.resources.memoryBytes",
  ],
  [
    "component key length",
    27,
    (n) =>
      edit((p) => {
        worker(p).key = "k".repeat(n);
      }),
    "components.1.key",
  ],
  [
    "stack id length (hp_app_<stackId>_worker fits 63)",
    49,
    (n) =>
      edit((p) => {
        p.stackId = `s${"a".repeat(n - 1)}`;
      }),
    "components.1.key",
  ],
  [
    "organisation id length",
    128,
    (n) =>
      edit((p) => {
        p.organizationId = `o${"a".repeat(n - 1)}`;
      }),
    "organizationId",
  ],
  [
    "port (max)",
    65_535,
    (n) =>
      edit((p) => {
        worker(p).expose = [n];
      }),
    "components.1.expose.0",
  ],
];

/** Floors and shapes that are one step below / beside the allowed value (no accepted twin needed). */
const BELOW_FLOOR: readonly Row[] = [
  ["cpu 49", () => edit((p) => void (web(p).resources = { cpuMilli: 49, memoryBytes: "268435456" })), invalid("components.0.resources.cpuMilli")],
  ["cpu 0", () => edit((p) => void (web(p).resources = { cpuMilli: 0, memoryBytes: "268435456" })), invalid("components.0.resources.cpuMilli")],
  ["cpu 1.5", () => edit((p) => void (web(p).resources = { cpuMilli: 1.5, memoryBytes: "268435456" })), invalid("components.0.resources.cpuMilli")],
  ["memory 32 MiB - 1", () => edit((p) => void (web(p).resources = { cpuMilli: 500, memoryBytes: "33554431" })), invalid("components.0.resources.memoryBytes")],
  ["memory 0", () => edit((p) => void (web(p).resources = { cpuMilli: 500, memoryBytes: "0" })), invalid("components.0.resources.memoryBytes")],
  ["memory leading zero", () => edit((p) => void (web(p).resources = { cpuMilli: 500, memoryBytes: "0268435456" })), invalid("components.0.resources.memoryBytes")],
  ["memory exponent", () => edit((p) => void (web(p).resources = { cpuMilli: 500, memoryBytes: "1e9" })), invalid("components.0.resources.memoryBytes")],
  ["memory as a number", () => edit((p) => void (web(p).resources = { cpuMilli: 500, memoryBytes: 268435456 as never })), invalid("components.0.resources.memoryBytes")],
  [
    "health interval 4",
    () => edit((p) => void (web(p).healthcheck = { kind: "http", port: 8080, path: "/healthz", intervalSeconds: 4, timeoutSeconds: 3 })),
    invalid("components.0.healthcheck.intervalSeconds"),
  ],
  [
    "health timeout 0",
    () => edit((p) => void (web(p).healthcheck = { kind: "http", port: 8080, path: "/healthz", intervalSeconds: 10, timeoutSeconds: 0 })),
    invalid("components.0.healthcheck.timeoutSeconds"),
  ],
  [
    "health timeout above the interval",
    () => edit((p) => void (web(p).healthcheck = { kind: "http", port: 8080, path: "/healthz", intervalSeconds: 5, timeoutSeconds: 6 })),
    invalid("components.0.healthcheck.timeoutSeconds"),
  ],
  [
    "health path with a dot segment",
    () => edit((p) => void (web(p).healthcheck = { kind: "http", port: 8080, path: "/a/../b", intervalSeconds: 10, timeoutSeconds: 3 })),
    invalid("components.0.healthcheck.path"),
  ],
  ["port 0", () => edit((p) => void (worker(p).expose = [0])), invalid("components.1.expose.0")],
  ["secret version 0", () => edit((p) => void (worker(p).secretFiles = [{ envName: "SHARED_KEY_FILE", parameterKey: "shared_key", version: 0 }])), invalid("components.1.secretFiles.0.version")],
  ["schema version 3", () => edit((p) => void ((p as Loose).schemaVersion = 3)), invalid("schemaVersion")],
  // A version 1 body that calls itself version 2 lacks what version 2 requires of every component.
  ["a version 1 body under schema version 2", () => edit((p) => void ((p as Loose).schemaVersion = 2)), invalid("components.0.profile")],
  ["no component", () => edit((p) => void ((p.components = []), (p.ingress = []), (p.volumes = []))), invalid("components")],
];

/** A13: the image problems. Shape problems fail the plan schema, allowlist problems are STACK_IMAGE_NOT_ALLOWED. */
const IMAGES: readonly Row[] = [
  ["no digest", () => edit((p) => void (worker(p).image = IMAGE)), invalid("components.1.image")],
  ["a latest tag and no digest", () => edit((p) => void (worker(p).image = `${IMAGE}:latest`)), invalid("components.1.image")],
  ["a digest of 63 hex chars", () => edit((p) => void (worker(p).image = `${IMAGE}@sha256:${"c".repeat(63)}`)), invalid("components.1.image")],
  ["a digest of 65 hex chars", () => edit((p) => void (worker(p).image = `${IMAGE}@sha256:${"c".repeat(65)}`)), invalid("components.1.image")],
  ["a short digest", () => edit((p) => void (worker(p).image = `${IMAGE}@sha256:abc`)), invalid("components.1.image")],
  ["an uppercase digest", () => edit((p) => void (worker(p).image = `${IMAGE}@sha256:${"C".repeat(64)}`)), invalid("components.1.image")],
  ["a sha512 digest", () => edit((p) => void (worker(p).image = `${IMAGE}@sha512:${"c".repeat(64)}`)), invalid("components.1.image")],
  ["a non-hex digest", () => edit((p) => void (worker(p).image = `${IMAGE}@sha256:${"g".repeat(64)}`)), invalid("components.1.image")],
  ["two digests", () => edit((p) => void (worker(p).image = `${IMAGE}@sha256:${"a".repeat(64)}@${DIGEST}`)), invalid("components.1.image")],
  ["whitespace around the name", () => edit((p) => void (worker(p).image = ` ${IMAGE}@${DIGEST}`)), invalid("components.1.image")],
  ["a newline in the name", () => edit((p) => void (worker(p).image = `${IMAGE}\n@${DIGEST}`)), invalid("components.1.image")],
  ["a name of 256 chars", () => edit((p) => void (worker(p).image = `${"a".repeat(256)}@${DIGEST}`)), invalid("components.1.image")],
  ["an empty name", () => edit((p) => void (worker(p).image = `@${DIGEST}`)), invalid("components.1.image")],
  ["an empty image", () => edit((p) => void (worker(p).image = "")), invalid("components.1.image")],
  ["a latest tag with a digest", () => edit((p) => void (worker(p).image = `${IMAGE}:latest@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["a version tag with a digest", () => edit((p) => void (worker(p).image = `${IMAGE}:1.2.3@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["another repository", () => edit((p) => void (worker(p).image = `registry.test/other/web@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["a look-alike registry suffix", () => edit((p) => void (worker(p).image = `registry.test.evil/acme/web@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["a look-alike registry prefix", () => edit((p) => void (worker(p).image = `evil.registry.test/acme/web@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["a look-alike repository suffix", () => edit((p) => void (worker(p).image = `${IMAGE}-evil@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["the allowlisted name nested in another", () => edit((p) => void (worker(p).image = `evil.test/${IMAGE}@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["a docker.io spelling of the name", () => edit((p) => void (worker(p).image = `docker.io/${IMAGE}@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["an upper-case registry", () => edit((p) => void (worker(p).image = `Registry.test/acme/web@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["a trailing slash in the name", () => edit((p) => void (worker(p).image = `${IMAGE}/@${DIGEST}`)), notAllowed("worker", "not_allowlisted")],
  ["the first of two bad components is named", () => edit((p) => void ((web(p).image = `other/web@${DIGEST}`), (worker(p).image = `other/worker@${DIGEST}`))), notAllowed("web", "not_allowlisted")],
  ["user 0 (root)", () => edit((p) => void (worker(p).runAsUser = "0")), notAllowed("worker", "user_mismatch")],
  ["user 0:0", () => edit((p) => void (worker(p).runAsUser = "0:0")), notAllowed("worker", "user_mismatch")],
  ["no user", () => edit((p) => void (worker(p).runAsUser = null)), notAllowed("worker", "user_mismatch")],
  ["the uid without the gid", () => edit((p) => void (worker(p).runAsUser = "65534")), notAllowed("worker", "user_mismatch")],
  ["another gid", () => edit((p) => void (worker(p).runAsUser = "65534:0")), notAllowed("worker", "user_mismatch")],
  ["a user with a name", () => edit((p) => void (worker(p).runAsUser = "root")), invalid("components.1.runAsUser")],
  ["a user and a stale hash: the image is checked first", () => edit((p) => void ((web(p).runAsUser = "0"), (p.planHash = "f".repeat(64))), { rehashed: false }), notAllowed("web", "user_mismatch")],
];

/** A shell as the executable, or anywhere else in argv (spec §7.3). */
const SHELLS = ["sh", "bash", "dash", "ash", "zsh", "ksh", "fish", "csh", "tcsh", "busybox", "toybox", "env"];
const ARGV: readonly Row[] = [
  ...SHELLS.flatMap((shell): Row[] => [
    [`${shell} as argv[0]`, () => edit((p) => void (worker(p).argv = [shell, "-c", "worker"])), invalid("components.1.argv.0")],
    [`${shell} as argv[1]`, () => edit((p) => void (worker(p).argv = ["worker", shell, "x"])), invalid("components.1.argv.1")],
  ]),
  ["/bin/sh as argv[0]", () => edit((p) => void (worker(p).argv = ["/bin/sh", "-c", "worker"])), invalid("components.1.argv.0")],
  ["/usr/bin/env as argv[0]", () => edit((p) => void (worker(p).argv = ["/usr/bin/env", "worker"])), invalid("components.1.argv.0")],
  ["/usr/local/bin/bash as argv[2]", () => edit((p) => void (worker(p).argv = ["worker", "--run", "/usr/local/bin/bash"])), invalid("components.1.argv.2")],
  ["a shell with trailing blanks at argv[3]", () => edit((p) => void (worker(p).argv = ["worker", "a", "b", "sh "])), invalid("components.1.argv.3")],
  ["a path ending in a slash as argv[0]", () => edit((p) => void (worker(p).argv = ["/usr/bin/"])), invalid("components.1.argv.0")],
  ["an empty argv item", () => edit((p) => void (worker(p).argv = ["worker", ""])), invalid("components.1.argv.1")],
  ["an empty argv list", () => edit((p) => void (worker(p).argv = [])), invalid("components.1.argv")],
];

const MOUNTS: readonly Row[] = [
  ...["/run", "/run/secrets", "/run/secrets/shared_key", "/run/x", "/tmp", "/tmp/cache", "/var/run", "/var/run/docker.sock", "/proc", "/etc", "/etc/ssl", "/dev", "/sys", "/root"].map(
    (containerPath): Row => [`a mount at ${containerPath}`, () => edit((p) => void (worker(p).volumes = [{ volumeKey: "data", containerPath, readOnly: false }])), invalid("components.1.volumes.0.containerPath")],
  ),
  ...["/data/../etc", "/data/./x", "/data//x", "/data/", "data", "/", "/x:y", "/da ta", "/data\n"].map(
    (containerPath): Row => [`a mount at ${JSON.stringify(containerPath)}`, () => edit((p) => void (worker(p).volumes = [{ volumeKey: "data", containerPath, readOnly: false }])), invalid("components.1.volumes.0.containerPath")],
  ),
  ["a mount of an undeclared volume", () => edit((p) => void (worker(p).volumes = [{ volumeKey: "ghost", containerPath: "/data", readOnly: false }])), invalid("components.1.volumes.0.volumeKey")],
  ["a declared volume nobody mounts", () => edit((p) => void (p.volumes = [{ key: "data" }, { key: "spare" }])), invalid("volumes.1.key")],
];

const UNSAFE_CONTENT: readonly Row[] = [
  ["an env name outside the pattern", () => edit((p) => void (web(p).environment = [{ name: "lower", value: "x" }])), invalid("components.0.environment.0.name")],
  ["a reserved env name PATH", () => edit((p) => void (web(p).environment = [{ name: "PATH", value: "/x" }])), invalid("components.0.environment.0.name")],
  ["a reserved env prefix LD_", () => edit((p) => void (web(p).environment = [{ name: "LD_PRELOAD", value: "/x" }])), invalid("components.0.environment.0.name")],
  ["a reserved env prefix DOCKER_", () => edit((p) => void (web(p).environment = [{ name: "DOCKER_HOST", value: "x" }])), invalid("components.0.environment.0.name")],
  ["a reserved env prefix HP_", () => edit((p) => void (web(p).environment = [{ name: "HP_X", value: "x" }])), invalid("components.0.environment.0.name")],
  ["a *_FILE value entry", () => edit((p) => void (web(p).environment = [{ name: "KEY_FILE", value: "/x" }])), invalid("components.0.environment.0.name")],
  ["unsorted env names", () => edit((p) => void (web(p).environment = [{ name: "B", value: "1" }, { name: "A", value: "1" }])), invalid("components.0.environment.1.name")],
  ["duplicate env names", () => edit((p) => void (web(p).environment = [{ name: "A", value: "1" }, { name: "A", value: "2" }])), invalid("components.0.environment.1.name")],
  ["an env value naming docker.sock", () => edit((p) => void (web(p).environment = [{ name: "SOCK", value: "unix:///var/run/docker.sock" }])), invalid("components.0.environment.0.value")],
  ["an env value naming the metadata endpoint", () => edit((p) => void (web(p).environment = [{ name: "META", value: "http://169.254.169.254/latest" }])), invalid("components.0.environment.0.value")],
  ["an env value with a NUL", () => edit((p) => void (web(p).environment = [{ name: "NUL", value: "a\u0000b" }])), invalid("components.0.environment.0.value")],
  ["a *_FILE value entry named like a secret file", () => edit((p) => void (worker(p).environment = [{ name: "SHARED_KEY_FILE", value: "x" }])), invalid("components.1.environment.0.name")],
  ["a secret file env name without _FILE", () => edit((p) => void (worker(p).secretFiles = [{ envName: "SHARED_KEY", parameterKey: "shared_key", version: 1 }])), invalid("components.1.secretFiles.0.envName")],
  ["a secret parameter with the reserved hp_ prefix", () => edit((p) => void (worker(p).secretFiles = [{ envName: "SHARED_KEY_FILE", parameterKey: "hp_key", version: 1 }])), invalid("components.1.secretFiles.0.parameterKey")],
  ["a dependency on a later component", () => edit((p) => void (web(p).dependsOn = ["worker"])), invalid("components.0.dependsOn.0")],
  ["a dependency on itself", () => edit((p) => void (worker(p).dependsOn = ["worker"])), invalid("components.1.dependsOn.0")],
  ["a duplicate component key", () => edit((p) => void ((worker(p).key = "web"), (worker(p).dependsOn = []))), invalid("components.1.key")],
  ["an ingress target without a health check", () => edit((p) => void (p.ingress = [{ componentKey: "worker", port: 8080 }])), invalid("ingress.0.componentKey")],
  ["an ingress port the target does not expose", () => edit((p) => void (p.ingress = [{ componentKey: "web", port: 9090 }])), invalid("ingress.0.port")],
  ["a health check on a port that is not exposed", () => edit((p) => void (web(p).healthcheck = { kind: "tcp", port: 9090, intervalSeconds: 10, timeoutSeconds: 3 })), invalid("components.0.healthcheck.port")],
  ["a plaintext secret key injected in a component", () => edit((p) => void ((web(p) as Loose).password = "hunter2")), invalid("components.0")],
];

/** Unknown keys at every object of the plan. A forbidden Docker key is just an unknown key. */
const UNKNOWN_KEYS: readonly Row[] = [
  ["the plan", () => edit((p) => void ((p as Loose).extra = 1)), invalid("")],
  ["a component", () => edit((p) => void ((web(p) as Loose).extra = 1)), invalid("components.0")],
  ["an environment entry", () => edit((p) => void (asLoose(web(p).environment[0]).extra = 1)), invalid("components.0.environment.0")],
  ["a secret file", () => edit((p) => void (asLoose(worker(p).secretFiles[0]).extra = 1)), invalid("components.1.secretFiles.0")],
  ["resources", () => edit((p) => void (asLoose(web(p).resources).extra = 1)), invalid("components.0.resources")],
  ["a volume mount", () => edit((p) => void (asLoose(worker(p).volumes[0]).extra = 1)), invalid("components.1.volumes.0")],
  ["an http health check", () => edit((p) => void (asLoose(web(p).healthcheck).extra = 1)), invalid("components.0.healthcheck")],
  [
    "a tcp health check",
    () => edit((p) => void (web(p).healthcheck = { kind: "tcp", port: 8080, intervalSeconds: 10, timeoutSeconds: 3, extra: 1 } as never)),
    invalid("components.0.healthcheck"),
  ],
  ["a plan volume", () => edit((p) => void (asLoose(p.volumes[0]).extra = 1)), invalid("volumes.0")],
  ["an ingress entry", () => edit((p) => void (asLoose(p.ingress[0]).extra = 1)), invalid("ingress.0")],
  ...["privileged", "capAdd", "securityOpt", "networkMode", "binds", "hostPorts", "devices", "entrypoint", "command", "resolvedSecrets"].map(
    (key): Row => [`the forbidden key ${key} on a component`, () => edit((p) => void ((web(p) as Loose)[key] = true)), invalid("components.0")],
  ),
];

/** Valid shape, but the hash no longer matches what the plan says. */
const TAMPERED: readonly Row[] = [
  ["an env value changed", () => edit((p) => void (web(p).environment = [{ name: "APP_MODE", value: "debug" }]), { rehashed: false }), HASH],
  ["an env entry removed", () => edit((p) => void (web(p).environment = []), { rehashed: false }), HASH],
  ["a new argv item", () => edit((p) => void (worker(p).argv = ["worker", "--queue", "other"]), { rehashed: false }), HASH],
  ["a digest swapped for another of the same repository", () => edit((p) => void (worker(p).image = `${IMAGE}@sha256:${"d".repeat(64)}`), { rehashed: false }), HASH],
  ["a secret version bumped", () => edit((p) => void (worker(p).secretFiles = [{ envName: "SHARED_KEY_FILE", parameterKey: "shared_key", version: 2 }]), { rehashed: false }), HASH],
  ["more memory", () => edit((p) => void (web(p).resources = { cpuMilli: 500, memoryBytes: "536870912" }), { rehashed: false }), HASH],
  ["a mount made writable", () => edit((p) => void (asLoose(worker(p).volumes[0]).readOnly = true), { rehashed: false }), HASH],
  ["an extra exposed port", () => edit((p) => void (web(p).expose = [8080, 8081]), { rehashed: false }), HASH],
  ["an ingress route added", () => edit((p) => void ((web(p).expose = [8080, 8081]), (p.ingress = [{ componentKey: "web", port: 8080 }, { componentKey: "web", port: 8081 }])), { rehashed: false }), HASH],
  ["another template version", () => edit((p) => void (p.templateVersionId = "atv_ffffffffffffffff"), { rehashed: false }), HASH],
  ["another stored hash", () => edit((p) => void (p.planHash = "f".repeat(64)), { rehashed: false }), HASH],
  ["an all-zero stored hash", () => edit((p) => void (p.planHash = "0".repeat(64)), { rehashed: false }), HASH],
  ["a stored hash in upper case", () => edit((p) => void (p.planHash = p.planHash.toUpperCase()), { rehashed: false }), invalid("planHash")],
  ["a stored hash of 63 chars", () => edit((p) => void (p.planHash = p.planHash.slice(1)), { rehashed: false }), invalid("planHash")],
  ["a stored hash with the sha256: prefix", () => edit((p) => void (p.planHash = `sha256:${p.planHash}`), { rehashed: false }), invalid("planHash")],
  ["a shape problem and a stale hash: the schema is checked first", () => edit((p) => void ((web(p).resources = { cpuMilli: 16_001, memoryBytes: "268435456" }), (p.planHash = "f".repeat(64))), { rehashed: false }), invalid("components.0.resources.cpuMilli")],
];

/** A plan of exactly `bytes` UTF-8 bytes of JSON.stringify(plan) that is otherwise valid (arch §5.3, 262 144). */
function planOfBytes(bytes: number): Plan {
  const seed = edit((p) => void (web(p).environment = envEntries(64)));
  const missing = bytes - Buffer.byteLength(JSON.stringify(seed));
  expect(missing).toBeGreaterThan(0);
  expect(missing).toBeLessThanOrEqual(64 * 4_095);
  const plan = structuredClone(seed);
  let left = missing;
  for (const entry of web(plan).environment) {
    const add = Math.min(left, 4_095);
    entry.value += "a".repeat(add);
    left -= add;
  }
  return rehash(plan);
}
const OVERSIZED = (): Plan => planOfBytes(MAX_BYTES + 1);

// ---- the engine harness -------------------------------------------------------------------------------------------

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harness() {
  const fake = createAppStackFakeEngine();
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-app-refusals-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const request = vi.fn(fake.request);
  const routes = {
    write: vi.fn(async () => ({ changed: false, hostnames: [] as string[] })),
    remove: vi.fn(async () => false),
    read: vi.fn(async () => []),
  };
  const proxy = { containerName: "hp_ingress_proxy_test", ensure: vi.fn(async () => undefined) };
  const readLogs = vi.fn(async () => []);
  const probe = vi.fn<AppStackHealthProbe>(async () => "passed");
  const engine = new AppStackEngine({ request, secretsRootDir: root, pullMissingImages: true, allowlist: TEST_ALLOWLIST, routes, proxy, readLogs, probe });
  return { fake, root, request, routes, proxy, readLogs, probe, engine };
}
type Harness = Awaited<ReturnType<typeof harness>>;

const HOSTS = [{ hostname: "shop.example.org", tls: true, httpsRedirect: true, redirectTo: null }];
const SECRET = { parameterKey: "shared_key", version: 1, content: "CANARY-refusals-secret" };

/** Every engine method that carries a plan. */
function planCalls(engine: AppStackEngine, plan: Plan): ReadonlyArray<readonly [string, () => Promise<unknown>]> {
  const image = `${IMAGE}@${DIGEST}`;
  return [
    ["pullAppStackImage", () => engine.pullAppStackImage({ plan, image })],
    ["prepareAppStack", () => engine.prepareAppStack({ plan })],
    ["createAppStackComponents", () => engine.createAppStackComponents({ plan })],
    ["startAppStackComponent", () => engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] })],
    ["restartAppStackComponent", () => engine.restartAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] })],
    ["publishAppStackRoutes", () => engine.publishAppStackRoutes({ plan, routes: [{ componentKey: "web", internalPort: 8080, hosts: HOSTS }] })],
    ["removeAppStackComponents", () => engine.removeAppStackComponents({ plan, componentKeys: ["worker"] })],
  ];
}

async function expectNothingTouched(h: Harness, what: string) {
  expect(h.fake.log, `${what}: engine requests`).toEqual([]);
  expect(h.request, `${what}: request spy`).not.toHaveBeenCalled();
  expect(h.routes.write, `${what}: route write`).not.toHaveBeenCalled();
  expect(h.routes.remove, `${what}: route remove`).not.toHaveBeenCalled();
  expect(h.proxy.ensure, `${what}: proxy`).not.toHaveBeenCalled();
  expect(h.probe, `${what}: probe`).not.toHaveBeenCalled();
  expect(h.readLogs, `${what}: logs`).not.toHaveBeenCalled();
  expect(await readdir(h.root), `${what}: secret files`).toEqual([]);
}

/** One harness for a whole table: the log must stay empty across every row and every method. */
async function refuseEverywhere(rows: readonly Row[]) {
  const h = await harness();
  for (const [name, build, expected] of rows) {
    const plan = build();
    for (const [method, call] of planCalls(h.engine, plan)) {
      const err = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err, `${name} → ${method} must be refused`).toBeInstanceOf(Error);
      expect(err, `${name} → ${method}`).toMatchObject(expected);
      expect(String((err as Error).message), `${name} → ${method}`).not.toContain(SECRET.content);
    }
    await expectNothingTouched(h, name);
  }
}

// ---- tests --------------------------------------------------------------------------------------------------------

describe("A12 ceilings: one step over is refused before any Engine request", () => {
  it.each(CEILINGS.map(([name, limit, build, at]) => [name, limit, build, at] as const))(
    "%s: %d is accepted, one more is refused at its path",
    async (name, limit, build, at) => {
      const accepted = build(limit);
      expect(() => assertExecutableAppStackPlan(accepted, { allowlist: TEST_ALLOWLIST }), `${name} at the limit`).not.toThrow();
      await refuseEverywhere([[`${name} over`, () => build(limit + 1), invalid(at)]]);
    },
  );

  it("floors, ranges and shapes below or beside the allowed value", async () => {
    await refuseEverywhere(BELOW_FLOOR);
  });

  it("the cpu and memory edges themselves are accepted", () => {
    for (const resources of [
      { cpuMilli: 50, memoryBytes: "33554432" },
      { cpuMilli: 16_000, memoryBytes: "17179869184" },
    ]) {
      expect(() => assertExecutableAppStackPlan(edit((p) => void (web(p).resources = resources)), { allowlist: TEST_ALLOWLIST })).not.toThrow();
    }
    for (const [interval, timeout] of [
      [5, 1],
      [5, 5],
      [300, 30],
    ] as const) {
      expect(() =>
        assertExecutableAppStackPlan(
          edit((p) => void (web(p).healthcheck = { kind: "http", port: 8080, path: "/healthz", intervalSeconds: interval, timeoutSeconds: timeout })),
          { allowlist: TEST_ALLOWLIST },
        ),
      ).not.toThrow();
    }
  });
});

describe("A12 plan size: 262 144 bytes pass, 262 145 are refused before any Engine request", () => {
  it("the boundary plan is exactly the ceiling and passes the plan check", () => {
    const plan = planOfBytes(MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(ApprovedStackPlanSchema.parse(plan)))).toBe(MAX_BYTES);
    expect(() => assertExecutableAppStackPlan(plan, { allowlist: TEST_ALLOWLIST })).not.toThrow();
  });

  it("a plan of 262 145 bytes is a plan-invalid refusal on every method, with no request", async () => {
    const plan = OVERSIZED();
    expect(Buffer.byteLength(JSON.stringify(plan))).toBe(MAX_BYTES + 1);
    await refuseEverywhere([["262 145 bytes", () => plan, invalid("")]]);
  });
});

describe("A13 images: refused before any pull, inspect or create", () => {
  it("every image problem", async () => {
    await refuseEverywhere(IMAGES);
  });
});

describe("A12 hardening of the plan: shell, mounts, content, unknown keys", () => {
  it("a shell at any argv position", async () => {
    await refuseEverywhere(ARGV);
  });

  it("mounts under /run and /tmp, protected paths and unsafe path shapes", async () => {
    await refuseEverywhere(MOUNTS);
  });

  it("names, values and references the compiler never produces", async () => {
    await refuseEverywhere(UNSAFE_CONTENT);
  });

  it("an unknown key at every object, forbidden Docker keys included", async () => {
    await refuseEverywhere(UNKNOWN_KEYS);
  });
});

describe("A13 tampering: a plan whose hash no longer matches", () => {
  it("is a hash mismatch (403) with no request, on every method", async () => {
    await refuseEverywhere(TAMPERED);
  });

  it("a re-hashed edit of an id the hash ignores is still a valid plan (the hash is the content's)", () => {
    const moved = edit((p) => void (p.revisionId = "astr_ffffffffffffffff"), { rehashed: false });
    expect(() => assertExecutableAppStackPlan(moved, { allowlist: TEST_ALLOWLIST })).not.toThrow();
  });

  it("garbage in place of a plan is plan-invalid, never a crash", async () => {
    const h = await harness();
    for (const garbage of ["plan", [], {}, [base], { plan: base }, { ...base, components: "x" }]) {
      for (const [method, call] of planCalls(h.engine, garbage as never)) {
        await expect(call(), method).rejects.toMatchObject({ reason: "STACK_PLAN_INVALID", code: "VALIDATION_ERROR" });
      }
    }
    await expectNothingTouched(h, "garbage");
  });

  it("the secret never reaches an error of a refused start", async () => {
    const h = await harness();
    const plan = edit((p) => void (web(p).resources = { cpuMilli: 16_001, memoryBytes: "268435456" }));
    const err = await h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] }).catch((e: Error) => e);
    expect(JSON.stringify({ m: (err as Error).message, e: err })).not.toContain(SECRET.content);
  });
});

// ---- the same, through the signed IPC server ---------------------------------------------------------------------

const KEY_SECRET = "0123456789abcdef0123456789abcdef-app-stack-refusals";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: KEY_SECRET };
const VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: KEY_SECRET };

const IPC_ROWS: ReadonlyArray<readonly [name: string, plan: () => Plan, statusCode: number, expected: Expected]> = [
  ["a ceiling over (cpu 16 001)", () => edit((p) => void (web(p).resources = { cpuMilli: 16_001, memoryBytes: "268435456" })), 400, invalid("components.0.resources.cpuMilli")],
  ["a shell as argv[0]", () => edit((p) => void (worker(p).argv = ["sh", "-c", "worker"])), 400, invalid("components.1.argv.0")],
  ["an unknown key on a component", () => edit((p) => void ((web(p) as Loose).privileged = true)), 400, invalid("components.0")],
  ["a user mismatch", () => edit((p) => void (worker(p).runAsUser = "0")), 403, notAllowed("worker", "user_mismatch")],
  ["a registry look-alike", () => edit((p) => void (worker(p).image = `registry.test.evil/acme/web@${DIGEST}`)), 403, notAllowed("worker", "not_allowlisted")],
  ["a tampered plan", () => edit((p) => void (web(p).environment = []), { rehashed: false }), 403, HASH],
];

describe("A12/A13 through the signed IPC server", () => {
  async function serve() {
    const daemon = await startMockDockerDaemon();
    cleanups.push(() => daemon.close());
    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-stk-refusals-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const secretsRootDir = path.join(dir, "secrets");
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: daemon.socketPath,
      secretsRootDir,
      ingressRootDir: path.join(dir, "ingress"),
      pullMissingImages: true,
      appImageAllowlist: TEST_ALLOWLIST,
    });
    const socketPath = `/tmp/hp-exec-refusals-${randomBytes(5).toString("hex")}.sock`;
    const server = new DockerExecutorIpcServer({ executor: adapter, keyring: { "hmac-v1": VERIFICATION_KEY }, socketPath });
    await server.start();
    cleanups.push(() => server.stop());
    const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath });
    return { daemon, client, dir };
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

  it.each(IPC_ROWS)("%s: status, code, reason and message are exact, and the Engine is never called", async (name, build, statusCode, expected) => {
    const { daemon, client, dir } = await serve();
    const plan = build();
    const image = `${IMAGE}@${DIGEST}`;
    const calls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["pull", () => client.pullAppStackImage({ plan, image })],
      ["prepare", () => client.prepareAppStack({ plan })],
      ["create", () => client.createAppStackComponents({ plan })],
      ["start", () => client.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] })],
      ["restart", () => client.restartAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] })],
      ["routes", () => client.publishAppStackRoutes({ plan, routes: [{ componentKey: "web", internalPort: 8080, hosts: HOSTS }] })],
      ["remove-components", () => client.removeAppStackComponents({ plan, componentKeys: ["worker"] })],
    ];
    for (const [method, call] of calls) {
      const err = await failure(call());
      expect([err.statusCode, err.code, err.reason, err.message], `${name} → ${method}`).toEqual([statusCode, expected.code, expected.reason, expected.message]);
      expect(err.ambiguousOutcome, `${name} → ${method}`).toBe(false);
      expect(JSON.stringify({ m: err.message, d: err.details })).not.toContain(SECRET.content);
    }
    expect(daemon.requestedPaths, name).toEqual([]);
    expect(await readdir(dir).catch(() => []), name).not.toContain("secrets");
  });

  it("a plan of 262 145 bytes is refused as plan-invalid with no Engine request", async () => {
    const { daemon, client } = await serve();
    const plan = OVERSIZED();
    const err = await failure(client.prepareAppStack({ plan }));
    expect([err.statusCode, err.code, err.reason, err.message]).toEqual([400, "VALIDATION_ERROR", "STACK_PLAN_INVALID", "The application plan is invalid"]);
    expect(daemon.requestedPaths).toEqual([]);
  });
});
