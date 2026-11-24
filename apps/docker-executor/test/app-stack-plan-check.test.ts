import type { ApprovedStackPlan } from "@hosting-panel/contracts";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";
import { describe, expect, it } from "vitest";
import {
  APP_STACK_COMPONENT_ROLE,
  APP_STACK_LABELS,
  AppStackExecutorError,
  appStackComponentLabels,
  appStackContainerName,
  appStackEdgeNetworkName,
  appStackImageDigestMatches,
  appStackInternalNetworkName,
  appStackNetworkLabels,
  appStackRouteFileName,
  appStackSecretDirKey,
  appStackVolumeLabels,
  appStackVolumeName,
  assertAppStackSecretContents,
  assertExecutableAppStackPlan,
  isOwnAppStackResource,
} from "../src/app-stacks/index.js";
import { TEST_ALLOWLIST, appStackTestPlan, appStackTestPlanV2, rehash } from "./support/app-stack-plans.js";

const plan = appStackTestPlan();
const [web, worker] = plan.components as [ApprovedStackPlan["components"][number], ApprovedStackPlan["components"][number]];
const ID = plan.stackId;
const DIGEST = `sha256:${"d".repeat(64)}`;

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

function refusal(run: () => unknown): { reason: string; code: string; message: string } {
  try {
    run();
  } catch (err) {
    if (err instanceof AppStackExecutorError) return { reason: err.reason, code: err.code, message: err.message };
    throw err;
  }
  throw new Error("expected a refusal");
}

const check = (input: unknown) => () => assertExecutableAppStackPlan(input, { allowlist: TEST_ALLOWLIST });
const withComponents = (...components: unknown[]) => rehash({ ...plan, components } as ApprovedStackPlan);

describe("stack names", () => {
  it("embeds the stack id verbatim in every name", () => {
    expect(appStackContainerName(ID, "web")).toBe(`hp_app_${ID}_web`);
    expect(appStackInternalNetworkName(ID)).toBe(`hp_appnet_${ID}`);
    expect(appStackEdgeNetworkName(ID)).toBe(`hp_appedge_${ID}`);
    expect(appStackVolumeName(ID, "data")).toBe(`hp_appvol_${ID}_data`);
    expect(appStackSecretDirKey(ID, "worker")).toBe(`app_${ID}__worker`);
    expect(appStackRouteFileName(ID)).toBe(`app_${ID}.yml`);
  });

  it("accepts the longest id and key", () => {
    expect(appStackVolumeName("a".repeat(64), "k".repeat(32))).toHaveLength(107);
  });

  it.each(["A", "_", "a".repeat(65), "", "a-b", "a.b", "../x"])("refuses the stack id %j", (stackId) => {
    for (const derive of [
      () => appStackContainerName(stackId, "web"),
      () => appStackInternalNetworkName(stackId),
      () => appStackEdgeNetworkName(stackId),
      () => appStackVolumeName(stackId, "data"),
      () => appStackSecretDirKey(stackId, "web"),
      () => appStackRouteFileName(stackId),
    ]) {
      expect(thrown(derive)).toMatchObject({ code: "HOST_POLICY_DENIED", message: "Unsafe or malformed identifier for stackId" });
    }
  });

  it.each(["my_key", "A", "-a", "a-", "", "k".repeat(33)])("refuses the key %j", (key) => {
    const refused = (field: string) => ({ code: "HOST_POLICY_DENIED", message: `Unsafe or malformed identifier for ${field}` });
    expect(thrown(() => appStackContainerName(ID, key))).toMatchObject(refused("componentKey"));
    expect(thrown(() => appStackSecretDirKey(ID, key))).toMatchObject(refused("componentKey"));
    expect(thrown(() => appStackVolumeName(ID, key))).toMatchObject(refused("volumeKey"));
  });
});

describe("stack labels", () => {
  it("labels each component with its hash, revision, start index, health and body version", () => {
    expect(appStackComponentLabels(plan, "web")).toEqual({
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "app_component",
      "io.hostingpanel.stack_id": ID,
      "io.hostingpanel.organization_id": "org_acme",
      "io.hostingpanel.app_component": "web",
      "io.hostingpanel.app_component_hash": computeAppStackComponentHash(plan, "web"),
      "io.hostingpanel.app_revision_id": plan.revisionId,
      "io.hostingpanel.app_start_index": "0",
      "io.hostingpanel.app_health": "http:8080:3:/healthz",
      "io.hostingpanel.app_body_version": "1",
    });
    expect(appStackComponentLabels(plan, "worker")).toMatchObject({
      "io.hostingpanel.app_component": "worker",
      "io.hostingpanel.app_start_index": "1",
      "io.hostingpanel.app_health": "none",
    });
    expect(APP_STACK_COMPONENT_ROLE).toBe("app_component");
    expect(() => appStackComponentLabels(plan, "ghost")).toThrow(RangeError);
  });

  it("labels networks and volumes", () => {
    expect(appStackNetworkLabels(plan, "app_internal")).toEqual({
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.network_role": "app_internal",
      "io.hostingpanel.stack_id": ID,
      "io.hostingpanel.organization_id": "org_acme",
    });
    expect(appStackNetworkLabels(plan, "app_edge")["io.hostingpanel.network_role"]).toBe("app_edge");
    expect(appStackVolumeLabels(plan, "data")).toEqual({
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.stack_id": ID,
      "io.hostingpanel.organization_id": "org_acme",
      "io.hostingpanel.app_volume_key": "data",
    });
  });

  it("never uses the site label vocabulary", () => {
    const all = [
      appStackComponentLabels(plan, "web"),
      appStackComponentLabels(plan, "worker"),
      appStackNetworkLabels(plan, "app_internal"),
      appStackNetworkLabels(plan, "app_edge"),
      appStackVolumeLabels(plan, "data"),
    ];
    const keys = [...Object.values(APP_STACK_LABELS), ...all.flatMap(Object.keys)];
    expect(keys.filter((k) => /site_id|service_instance_id/.test(k))).toEqual([]);
    expect(all.flatMap(Object.values).filter((v) => /^site_/.test(v))).toEqual([]);
  });

  it.each([
    [{ "io.hostingpanel.managed": "true", "io.hostingpanel.stack_id": ID, "io.hostingpanel.organization_id": "org_acme" }, true],
    [undefined, false],
    [{}, false],
    [{ "io.hostingpanel.managed": "false", "io.hostingpanel.stack_id": ID, "io.hostingpanel.organization_id": "org_acme" }, false],
    [{ "io.hostingpanel.stack_id": ID, "io.hostingpanel.organization_id": "org_acme" }, false],
    [{ "io.hostingpanel.managed": "true", "io.hostingpanel.stack_id": "stk_other", "io.hostingpanel.organization_id": "org_acme" }, false],
    [{ "io.hostingpanel.managed": "true", "io.hostingpanel.stack_id": ID, "io.hostingpanel.organization_id": "org_other" }, false],
    [{ "io.hostingpanel.managed": "true", "io.hostingpanel.stack_id": ID }, false],
  ])("ownership of %j is %s", (labels, own) => {
    expect(isOwnAppStackResource(labels, ID, "org_acme")).toBe(own);
  });
});

describe("assertExecutableAppStackPlan", () => {
  it("returns the parsed plan", () => {
    expect(check(plan)()).toEqual(plan);
    expect(check(JSON.parse(JSON.stringify(plan)))()).toEqual(plan);
  });

  it("uses the empty contracts allowlist by default", () => {
    expect(refusal(() => assertExecutableAppStackPlan(plan))).toEqual({
      reason: "STACK_IMAGE_NOT_ALLOWED",
      code: "HOST_POLICY_DENIED",
      message: "The image of component web is not allowed (not_allowlisted)",
    });
  });

  it("names the failing path, never the value", () => {
    const value = "LEAK".repeat(1_100);
    const bad = withComponents({ ...web, environment: [{ name: "APP_MODE", value }] }, worker);
    const result = refusal(check(bad));
    expect(result).toEqual({
      reason: "STACK_PLAN_INVALID",
      code: "VALIDATION_ERROR",
      message: "The application plan is invalid at components.0.environment.0.value",
    });
    expect(refusal(check({ ...plan, stackId: "Bad-Id" })).message).toBe("The application plan is invalid at stackId");
    expect(refusal(check(null)).reason).toBe("STACK_PLAN_INVALID");
    expect(refusal(check("plan")).reason).toBe("STACK_PLAN_INVALID");
  });

  it.each([
    ["cpu 16 001", () => withComponents({ ...web, resources: { ...web.resources, cpuMilli: 16_001 } }, worker), "components.0.resources.cpuMilli"],
    ["memory 16 GiB + 1", () => withComponents({ ...web, resources: { ...web.resources, memoryBytes: "17179869185" } }, worker), "components.0.resources.memoryBytes"],
    ["9 components", () => rehash({ ...plan, volumes: [], ingress: [], components: Array.from({ length: 9 }, (_, i) => ({ ...web, key: `c${i}` })) }), "components"],
    ["a /tmp mount", () => withComponents(web, { ...worker, volumes: [{ volumeKey: "data", containerPath: "/tmp", readOnly: false }] }), "components.1.volumes.0.containerPath"],
    ["sh as argv[0]", () => withComponents(web, { ...worker, argv: ["sh", "-c", "worker"] }), "components.1.argv.0"],
    // ADR-0041: the executor does not trust the API to keep a terminal's mark out of a component's environment.
    [
      "a terminal's mark in an env value",
      () => withComponents({ ...web, environment: [{ name: "APP_MODE", value: "x HP_TERMINAL_SESSION=term_" }] }, worker),
      "components.0.environment.0.value",
    ],
    ["a task run's mark in an env value", () => withComponents({ ...web, environment: [{ name: "APP_MODE", value: "xHP_TASK_RUN=srun_1" }] }, worker), "components.0.environment.0.value"],
    ["a task run's mark in argv", () => withComponents(web, { ...worker, argv: ["worker", "HP_TASK_RUN=srun_1"] }), "components.1.argv.1"],
  ])("A12: %s is refused before Docker", (_name, build, at) => {
    expect(refusal(check(build()))).toEqual({
      reason: "STACK_PLAN_INVALID",
      code: "VALIDATION_ERROR",
      message: `The application plan is invalid at ${at}`,
    });
  });

  it.each(["Corso PHP_8", "-d PHP_INI_SCAN_DIR=/x", "SHP_X=1", "HP_HOME=/x", "ends with HP_TERMINAL_"])(
    "accepts %j in an env value and in argv: only the marks of the platform's processes are refused",
    (text) => {
      const accepted = withComponents({ ...web, environment: [{ name: "APP_MODE", value: text }] }, { ...worker, argv: ["worker", text] });
      expect(check(accepted)()).toEqual(accepted);
    },
  );

  it("refuses a component whose hp_app_<stackId>_<key> name would not fit one DNS label", () => {
    const named = (idLength: number) =>
      rehash({ ...plan, stackId: `stk_${"a".repeat(idLength - 4)}`, components: [web, { ...worker, key: "k".repeat(27) }] });
    expect(refusal(check(named(40)))).toEqual({
      reason: "STACK_PLAN_INVALID",
      code: "VALIDATION_ERROR",
      message: "The application plan is invalid at components.1.key",
    });
    expect(check(named(28))().components[1]?.key).toBe("k".repeat(27));
  });

  it.each([
    ["no digest", "registry.test/acme/web"],
    ["a latest tag", "registry.test/acme/web:latest"],
    ["a short digest", "registry.test/acme/web@sha256:abc"],
    ["an uppercase digest", `registry.test/acme/web@sha256:${"C".repeat(64)}`],
  ])("A13: an image with %s fails the plan schema", (_name, image) => {
    expect(refusal(check(withComponents({ ...web, image }, worker)))).toEqual({
      reason: "STACK_PLAN_INVALID",
      code: "VALIDATION_ERROR",
      message: "The application plan is invalid at components.0.image",
    });
  });

  it.each([
    ["not allowlisted", { image: `registry.test/other/web@${DIGEST}` }, "not_allowlisted"],
    ["a look-alike registry", { image: `registry.test.evil/acme/web@${DIGEST}` }, "not_allowlisted"],
    ["a look-alike repository", { image: `registry.test/acme/web-evil@${DIGEST}` }, "not_allowlisted"],
    ["another user", { runAsUser: "0" }, "user_mismatch"],
    ["no user", { runAsUser: null }, "user_mismatch"],
  ])("A13: %s is refused before any pull", (_name, patch, problem) => {
    expect(refusal(check(withComponents(web, { ...worker, ...patch })))).toEqual({
      reason: "STACK_IMAGE_NOT_ALLOWED",
      code: "HOST_POLICY_DENIED",
      message: `The image of component worker is not allowed (${problem})`,
    });
  });

  it("reports the first refused component and checks images before the hash", () => {
    const bad = { ...plan, components: [{ ...web, runAsUser: null }, { ...worker, runAsUser: null }], planHash: "f".repeat(64) };
    expect(refusal(check(bad)).message).toBe("The image of component web is not allowed (user_mismatch)");
  });

  it("refuses a tampered plan as a hash mismatch", () => {
    const tampered = { ...plan, components: [{ ...web, environment: [{ name: "APP_MODE", value: "debug" }] }, worker] };
    const expected = { reason: "STACK_PLAN_HASH_MISMATCH", code: "HOST_POLICY_DENIED", message: "The application plan does not match its hash" };
    expect(refusal(check(tampered))).toEqual(expected);
    expect(refusal(check({ ...plan, planHash: "f".repeat(64) }))).toEqual(expected);
  });

  // ADR-0039: the rows of the database images are written in full. A stored plan of the WordPress template of release
  // 0.10.0 names `mariadb` short with the image's own user, and must stay executable.
  describe("with the code allowlist, a database image is judged by its name exactly as written", () => {
    const v2 = appStackTestPlanV2();
    const db = v2.components[0]!;
    const extended = (image: string, runAsUser: string | null) =>
      rehash({ ...v2, components: [{ ...db, image, runAsUser }], ingress: [], volumes: [{ key: "dbdata" }] });
    const first = (image: string, runAsUser: string | null) => rehash({ ...plan, components: [{ ...web, image, runAsUser }], volumes: [] });

    it.each(["mariadb", "postgres"])("%s: written short, the image's own user only", (name) => {
      expect(assertExecutableAppStackPlan(extended(`${name}@${DIGEST}`, null)).components[0]?.runAsUser).toBeNull();
      expect(refusal(() => assertExecutableAppStackPlan(extended(`${name}@${DIGEST}`, "999:999"))).message).toBe(
        "The image of component db is not allowed (user_mismatch)",
      );
      expect(refusal(() => assertExecutableAppStackPlan(first(`${name}@${DIGEST}`, "999:999"))).message).toBe(
        "The image of component web is not allowed (not_allowlisted)",
      );
    });

    it.each(["mariadb", "postgres"])("docker.io/library/%s: the row's user, in both formats", (name) => {
      const image = `docker.io/library/${name}@${DIGEST}`;
      expect(assertExecutableAppStackPlan(extended(image, "999:999")).components[0]?.runAsUser).toBe("999:999");
      expect(assertExecutableAppStackPlan(first(image, "999:999")).components[0]?.image).toBe(image);
      expect(refusal(() => assertExecutableAppStackPlan(extended(image, null))).message).toBe("The image of component db is not allowed (user_mismatch)");
    });
  });
});

describe("assertAppStackSecretContents", () => {
  const entry = { parameterKey: "shared_key", version: 1, content: "s3cr3t-content" };

  it("returns the files of the component", () => {
    expect(assertAppStackSecretContents(plan, "worker", [entry])).toEqual({ shared_key: "s3cr3t-content" });
  });

  it("ignores entries of other components", () => {
    expect(assertAppStackSecretContents(plan, "web", [entry])).toEqual({});
    expect(assertAppStackSecretContents(plan, "web", [])).toEqual({});
  });

  it.each([
    ["a stale version", { ...entry, version: 2 }],
    ["a key outside the plan", { ...entry, parameterKey: "other_key" }],
  ])("refuses %s", (_name, bad) => {
    const result = refusal(() => assertAppStackSecretContents(plan, "worker", [bad]));
    expect(result).toEqual({ reason: "STACK_PLAN_INVALID", code: "VALIDATION_ERROR", message: "A secret entry is not part of the plan" });
    expect(result.message).not.toContain("s3cr3t");
  });

  it("accepts one parameter mounted twice at the same version", () => {
    const twice = appStackTestPlan({
      components: [web, { ...worker, secretFiles: [{ envName: "COPY_FILE", parameterKey: "shared_key", version: 1 }, ...worker.secretFiles] }],
    });
    expect(assertAppStackSecretContents(twice, "worker", [entry])).toEqual({ shared_key: "s3cr3t-content" });
  });

  it("refuses one parameter of a component pinned at two versions instead of keeping the last", () => {
    const twoVersions = appStackTestPlan({
      components: [web, { ...worker, secretFiles: [{ envName: "NEXT_FILE", parameterKey: "shared_key", version: 2 }, ...worker.secretFiles] }],
    });
    const result = refusal(() => assertAppStackSecretContents(twoVersions, "worker", [entry, { ...entry, version: 2, content: "s3cr3t-next" }]));
    expect(result).toEqual({ reason: "STACK_PLAN_INVALID", code: "VALIDATION_ERROR", message: "A secret of component worker has more than one entry" });
  });

  it("refuses two entries for the same secret of the component", () => {
    const result = refusal(() => assertAppStackSecretContents(plan, "worker", [entry, { ...entry, content: "s3cr3t-other" }]));
    expect(result).toEqual({ reason: "STACK_PLAN_INVALID", code: "VALIDATION_ERROR", message: "A secret of component worker has more than one entry" });
    expect(result.message).not.toContain("s3cr3t");
  });

  it("refuses a missing secret", () => {
    expect(refusal(() => assertAppStackSecretContents(plan, "worker", []))).toEqual({
      reason: "STACK_SECRET_MISSING",
      code: "VALIDATION_ERROR",
      message: "A secret of component worker is missing",
    });
  });

  it("refuses a component outside the plan", () => {
    expect(refusal(() => assertAppStackSecretContents(plan, "ghost", [])).reason).toBe("STACK_PLAN_INVALID");
  });
});

describe("appStackImageDigestMatches", () => {
  it.each([
    [`busybox@${DIGEST}`, [`docker.io/library/busybox@${DIGEST}`], true],
    [`docker.io/library/busybox@${DIGEST}`, [`busybox@${DIGEST}`], true],
    [`library/busybox@${DIGEST}`, [`busybox@${DIGEST}`], true],
    [`registry.test/acme/web@${DIGEST}`, [`registry.test/acme/web@${DIGEST}`], true],
    [`busybox@${DIGEST}`, [`busybox@sha256:${"e".repeat(64)}`], false],
    [`busybox@${DIGEST}`, [`busybox2@${DIGEST}`], false],
    [`registry.test/acme/web@${DIGEST}`, [`acme/web@${DIGEST}`], false],
    [`busybox@${DIGEST}`, [42, null, {}, `busybox@${DIGEST}`], true],
    [`busybox@${DIGEST}`, [42, null, { busybox: DIGEST }], false],
    [`busybox@${DIGEST}`, [DIGEST], false],
    [`busybox@${DIGEST}`, [], false],
    [`busybox@${DIGEST}`, undefined, false],
  ])("%s against %j is %s", (image, repoDigests, expected) => {
    expect(appStackImageDigestMatches(image, repoDigests)).toBe(expected);
  });
});
