import { ApprovedStackPlanSchema, type AppImageAllowlistEntry, type ApprovedStackPlan } from "@hosting-panel/contracts";
import { computeAppStackPlanHash } from "@hosting-panel/hosting-domain";

const IMAGE = `registry.test/acme/web@sha256:${"c".repeat(64)}`;
const USER = "65534:65534";

export const TEST_ALLOWLIST: readonly AppImageAllowlistEntry[] = Object.freeze([
  { repository: "registry.test/acme/web", runAsUser: USER, note: "Test image of the executor stack tests." },
]);

export function rehash(plan: ApprovedStackPlan): ApprovedStackPlan {
  return { ...plan, planHash: computeAppStackPlanHash(plan) };
}

/** web: http health on 8080 behind ingress; worker: after web, secret shared_key v1, volume data at /data. */
export function appStackTestPlan(
  overrides: Partial<Pick<ApprovedStackPlan, "stackId" | "organizationId" | "components" | "volumes" | "ingress">> = {},
): ApprovedStackPlan {
  return ApprovedStackPlanSchema.parse(
    rehash({
      schemaVersion: 1,
      stackId: "stk_0123456789abcdef",
      organizationId: "org_acme",
      hostAllocationId: "alloc_0123456789abcdef",
      templateVersionId: "atv_0123456789abcdef",
      revisionId: "astr_0123456789abcdef",
      planHash: "0".repeat(64),
      components: [
        {
          key: "web",
          image: IMAGE,
          runAsUser: USER,
          argv: null,
          environment: [{ name: "APP_MODE", value: "production" }],
          secretFiles: [],
          resources: { cpuMilli: 500, memoryBytes: "268435456" },
          expose: [8080],
          dependsOn: [],
          volumes: [],
          healthcheck: { kind: "http", port: 8080, path: "/healthz", intervalSeconds: 10, timeoutSeconds: 3 },
        },
        {
          key: "worker",
          image: IMAGE,
          runAsUser: USER,
          argv: ["worker", "--queue", "default"],
          environment: [{ name: "WEB_HOST", value: "web" }],
          secretFiles: [{ envName: "SHARED_KEY_FILE", parameterKey: "shared_key", version: 1 }],
          resources: { cpuMilli: 250, memoryBytes: "134217728" },
          expose: [],
          dependsOn: ["web"],
          volumes: [{ volumeKey: "data", containerPath: "/data", readOnly: false }],
          healthcheck: null,
        },
      ],
      volumes: [{ key: "data" }],
      ingress: [{ componentKey: "web", port: 8080 }],
      ...overrides,
    }),
  );
}
