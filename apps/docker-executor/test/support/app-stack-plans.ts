import {
  ApprovedStackPlanSchema,
  type AppImageAllowlistEntry,
  type ApprovedStackPlan,
  type ApprovedStackPlanV1,
  type ApprovedStackPlanV2,
} from "@hosting-panel/contracts";
import { computeAppStackPlanHash } from "@hosting-panel/hosting-domain";

const IMAGE = `registry.test/acme/web@sha256:${"c".repeat(64)}`;
const USER = "65534:65534";

export const TEST_ALLOWLIST: readonly AppImageAllowlistEntry[] = Object.freeze([
  { repository: "registry.test/acme/web", runAsUser: USER, note: "Test image of the executor stack tests." },
]);

export function rehash<T extends ApprovedStackPlan>(plan: T): T {
  return { ...plan, planHash: computeAppStackPlanHash(plan) };
}

/** web: http health on 8080 behind ingress; worker: after web, secret shared_key v1, volume data at /data. */
export function appStackTestPlan(
  overrides: Partial<Pick<ApprovedStackPlanV1, "stackId" | "organizationId" | "components" | "volumes" | "ingress">> = {},
): ApprovedStackPlanV1 {
  return ApprovedStackPlanSchema.parse(
    rehash<ApprovedStackPlanV1>({
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
  ) as ApprovedStackPlanV1;
}

const V2_WEB = `registry.test/acme/blog@sha256:${"d".repeat(64)}`;
const V2_DB = `db.registry.test/acme/sql@sha256:${"e".repeat(64)}`;

/** The secret contents a create call of appStackTestPlanV2 carries, and the ones each of its components starts with. */
export const V2_SECRET_VALUES = Object.freeze({ db_password: "db-pass-0123456789", db_root_password: "root-pass-0123456789", app_key: "app-key-0123456789" });
export const v2SecretEntry = (parameterKey: keyof typeof V2_SECRET_VALUES, version = 1) => ({
  parameterKey,
  version,
  content: V2_SECRET_VALUES[parameterKey],
});
export const V2_CREATE_SECRETS = Object.freeze([v2SecretEntry("db_password"), v2SecretEntry("db_root_password")]);

/** HCP-STACK/v2. web ("standard", image outside the allowlist, behind ingress): environment secret db_password, alone
 *  and inside a URL, and the file secret app_key. db ("standard", internal): two environment secrets, volume dbdata.
 *  cache ("strict", the allowlisted image): no secret. */
export function appStackTestPlanV2(
  overrides: Partial<Pick<ApprovedStackPlanV2, "stackId" | "organizationId" | "components" | "volumes" | "ingress">> = {},
): ApprovedStackPlanV2 {
  return ApprovedStackPlanSchema.parse(
    rehash<ApprovedStackPlanV2>({
      schemaVersion: 2,
      stackId: "stk_0123456789abcdef",
      organizationId: "org_acme",
      hostAllocationId: "alloc_0123456789abcdef",
      templateVersionId: "atv_0123456789abcdef",
      revisionId: "astr_0123456789abcdef",
      planHash: "0".repeat(64),
      components: [
        {
          key: "db",
          image: V2_DB,
          runAsUser: null,
          argv: null,
          environment: [{ name: "DB_NAME", value: "blog" }],
          secretFiles: [],
          resources: { cpuMilli: 500, memoryBytes: "536870912" },
          expose: [3306],
          dependsOn: [],
          volumes: [{ volumeKey: "dbdata", containerPath: "/var/lib/sql", readOnly: false }],
          healthcheck: { kind: "tcp", port: 3306, intervalSeconds: 10, timeoutSeconds: 3 },
          profile: "standard",
          secretEnvironment: [
            { name: "DB_PASSWORD", pieces: [{ parameterKey: "db_password", version: 1 }] },
            { name: "DB_ROOT_PASSWORD", pieces: [{ parameterKey: "db_root_password", version: 1 }] },
          ],
        },
        {
          key: "web",
          image: V2_WEB,
          runAsUser: null,
          argv: null,
          environment: [{ name: "BLOG_DB_HOST", value: "db" }],
          secretFiles: [{ envName: "APP_KEY_FILE", parameterKey: "app_key", version: 1 }],
          resources: { cpuMilli: 1000, memoryBytes: "536870912" },
          expose: [80],
          dependsOn: ["db"],
          volumes: [],
          healthcheck: { kind: "tcp", port: 80, intervalSeconds: 10, timeoutSeconds: 3 },
          profile: "standard",
          secretEnvironment: [
            { name: "BLOG_DB_PASSWORD", pieces: [{ parameterKey: "db_password", version: 1 }] },
            { name: "BLOG_DB_URL", pieces: [{ literal: "sql://blog:" }, { parameterKey: "db_password", version: 1 }, { literal: "@db:3306/blog" }] },
          ],
        },
        {
          key: "cache",
          image: IMAGE,
          runAsUser: USER,
          argv: null,
          environment: [],
          secretFiles: [],
          resources: { cpuMilli: 250, memoryBytes: "134217728" },
          expose: [6379],
          dependsOn: [],
          volumes: [],
          healthcheck: null,
          profile: "strict",
          secretEnvironment: [],
        },
      ],
      volumes: [{ key: "dbdata" }],
      ingress: [{ componentKey: "web", port: 80 }],
      ...overrides,
    }),
  ) as ApprovedStackPlanV2;
}
