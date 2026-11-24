import { readFileSync } from "node:fs";
import {
  AppStackAcceptedEnvelopeSchema,
  AppStackDeploymentDtoSchema,
  AppStackDetailDtoSchema,
  AppStackDomainDtoSchema,
  AppStackSummaryDtoSchema,
  findForbiddenPublicDtoKeys,
  type AppImageAllowlistEntry,
  type AppStackComponentHealth,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import type {
  AppStackComponentRow,
  AppStackDeploymentRow,
  AppStackDomainRow,
  AppStackRevisionRow,
  AppStackRow,
  AppStackVolumeRow,
  AppStackWriteResult,
} from "@hosting-panel/database";
import { compileAppStackPlan, validateAppTemplateSource } from "@hosting-panel/policy-engine";
import { describe, expect, it } from "vitest";
import {
  appStackAcceptedEnvelope,
  appStackDeploymentDto,
  appStackDetailDto,
  appStackDomainDto,
  appStackSummaryDto,
} from "../src/app-stacks/app-stack-dto.js";
import { appStackAddressesHash, appStackRoutePlan, appStackRoutesHash } from "../src/app-stacks/app-stack-runtime-policy.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../packages/contracts/test/fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8");
const SOURCE = fixture("source.yaml");
const options = { allowlist: JSON.parse(fixture("allowlist.json")) as AppImageAllowlistEntry[] };
const NOW = new Date("2026-11-22T12:00:00.000Z");
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - 6 * 60_000);
const ORG = "org_acme";
const STACK = "stk_0123456789abcdef01234567";
const REVISION = "srev_0123456789abcdef01234567";

const checked = validateAppTemplateSource(SOURCE, options);
if (!checked.ok) throw new Error("the fixture must validate");
const SPEC = checked.spec;
const compiled = compileAppStackPlan(
  {
    source: SOURCE,
    parameters: [],
    secretVersions: new Map([["app_secret", 2]]),
    ids: { stackId: STACK, organizationId: ORG, hostAllocationId: "alloc_1", templateVersionId: "atv_1", revisionId: REVISION },
  },
  options,
);
if (!compiled.ok) throw new Error("the fixture must compile");
const PLAN: ApprovedStackPlan = compiled.plan;

const stackRow = (change: Partial<AppStackRow> = {}): AppStackRow => ({
  id: STACK,
  organizationId: ORG,
  hostAllocationId: "alloc_1",
  templateId: "atpl_1",
  templateVersionId: "atv_1",
  name: "My notes",
  status: "draft",
  desiredRevisionId: null,
  appliedRevisionId: null,
  resourceQuotaId: null,
  appliedRoutesHash: null,
  appliedAddressesHash: null,
  idempotencyKey: "k-1",
  requestHash: "h",
  createdBy: "usr_1",
  createdAt: new Date("2026-11-20T10:00:00.000Z"),
  updatedAt: new Date("2026-11-21T10:00:00.000Z"),
  deletedAt: null,
  ...change,
});
const component = (componentKey: string, health: AppStackComponentHealth, healthObservedAt: Date | null): AppStackComponentRow => ({
  stackId: STACK,
  organizationId: ORG,
  componentKey,
  health,
  healthObservedAt,
  appliedRevisionId: REVISION,
  createdAt: NOW,
  updatedAt: NOW,
});
const domain = (id: string, hostname: string, status: AppStackDomainRow["status"]): AppStackDomainRow => ({
  id,
  stackId: STACK,
  organizationId: ORG,
  componentKey: "app",
  internalPort: 8080,
  hostname,
  status,
  dnsStatus: "unchecked",
  dnsObserved: { a: [], aaaa: [] },
  dnsCheckedAt: null,
  dnsNextCheckAt: NOW,
  dnsAttempts: 0,
  certStatus: "none",
  certProblem: null,
  certChallenge: "http-01",
  certRequestedAt: null,
  certRetryAt: null,
  certAttempts: 0,
  certExpiresAt: null,
  certTrusted: true,
  redirectToDomainId: null,
  compression: false,
  accessUsername: null,
  accessPasswordHash: null,
  pathRoutes: [],
  createdAt: NOW,
  updatedAt: NOW,
  removalRequestedAt: null,
});
const revision: AppStackRevisionRow = {
  id: REVISION,
  stackId: STACK,
  organizationId: ORG,
  revisionNumber: 3,
  templateVersionId: "atv_1",
  plan: PLAN,
  planHash: PLAN.planHash,
  parameters: [],
  componentCount: 2,
  cpuMilli: 1500,
  memoryBytes: 805306368,
  createdAt: NOW,
};
const detailInput = (change: Partial<Parameters<typeof appStackDetailDto>[0]> = {}): Parameters<typeof appStackDetailDto>[0] => ({
  stack: stackRow(),
  templateName: "Notes Demo",
  templateVersionNumber: 1,
  spec: SPEC,
  desired: null,
  appliedPlan: null,
  components: [],
  volumes: [],
  domains: [],
  parameters: [],
  secrets: [],
  activeOperationId: null,
  allowedActions: [],
  installed: null,
  platformWork: null,
  upgrade: null,
  rollback: null,
  now: NOW,
  ...change,
});
const deployed = (components: AppStackComponentRow[], change: Partial<Parameters<typeof appStackDetailDto>[0]> = {}) =>
  detailInput({
    stack: stackRow({ status: "running", desiredRevisionId: REVISION, appliedRevisionId: REVISION }),
    desired: { revision, plan: PLAN },
    appliedPlan: PLAN,
    components,
    ...change,
  });

describe("appStackSummaryDto", () => {
  const summary = (
    components: AppStackComponentRow[],
    domains: AppStackDomainRow[] = [],
    appliedPlan: ApprovedStackPlan | null = null,
    stack: AppStackRow = stackRow({ status: "running" }),
  ) =>
    appStackSummaryDto({
      stack,
      templateName: "Notes Demo",
      templateVersionNumber: 2,
      installed: { revisionNumber: 4, templateVersionNumber: 1 },
      appliedPlan,
      components,
      domains,
      now: NOW,
    });

  it("counts unhealthy and missing components; a stale observation reads unknown and is not counted", () => {
    const dto = summary([
      component("app", "unhealthy", FRESH),
      component("cache", "missing", FRESH),
      component("worker", "unhealthy", STALE),
      component("web", "healthy", FRESH),
      component("never", "unhealthy", null),
    ]);
    expect(dto).toMatchObject({ componentCount: 5, unhealthyCount: 2, status: "running", templateVersionNumber: 2, installed: { revisionNumber: 4, templateVersionNumber: 1 } });
    expect(AppStackSummaryDtoSchema.strict().parse(dto)).toEqual(dto);
  });

  it("shows the status the page shows: a crashed essential component of a running stack reads failed, a stale one unknown (#130)", () => {
    const running = stackRow({ status: "running", desiredRevisionId: REVISION, appliedRevisionId: REVISION });
    const shown = (components: AppStackComponentRow[], plan: ApprovedStackPlan | null = PLAN) => summary(components, [], plan, running).status;
    expect(shown([component("app", "healthy", FRESH), component("cache", "healthy", FRESH)])).toBe("running");
    expect(shown([component("app", "stopped", FRESH), component("cache", "healthy", FRESH)])).toBe("failed");
    expect(shown([component("app", "healthy", STALE), component("cache", "healthy", FRESH)])).toBe("unknown");
    expect(shown([component("app", "healthy", FRESH)])).toBe("unknown");
    // No readable plan of what runs: the stored status, as the page shows it.
    expect(shown([component("app", "stopped", FRESH)], null)).toBe("running");
    // Another status than running or degraded is shown as stored.
    const stopped = stackRow({ status: "stopped", desiredRevisionId: REVISION, appliedRevisionId: REVISION });
    expect(summary([component("app", "stopped", FRESH), component("cache", "stopped", FRESH)], [], PLAN, stopped).status).toBe("stopped");
  });

  it("the list and the page show the same status for every stored status and every set of readings (#130)", () => {
    const sets: Record<string, AppStackComponentRow[]> = {
      healthy: [component("app", "healthy", FRESH), component("cache", "healthy", FRESH)],
      "essential crashed": [component("app", "stopped", FRESH), component("cache", "healthy", FRESH)],
      "dependency unhealthy": [component("app", "healthy", FRESH), component("cache", "unhealthy", FRESH)],
      stale: [component("app", "healthy", STALE), component("cache", "healthy", STALE)],
      "never read": [component("app", "unknown", null), component("cache", "unknown", null)],
      "one row missing": [component("app", "healthy", FRESH)],
    };
    const statuses = ["running", "degraded", "failed", "unknown", "stopped", "updating", "stopping"] as const;
    for (const status of statuses) {
      for (const [label, components] of Object.entries(sets)) {
        const stack = stackRow({ status, desiredRevisionId: REVISION, appliedRevisionId: REVISION });
        const page = appStackDetailDto(deployed(components, { stack }));
        const list = summary(components, [], PLAN, stack);
        expect(list.status, `${status} with ${label}`).toBe(page.status);
        expect(list.unhealthyCount, `${status} with ${label}`).toBe(page.unhealthyCount);
      }
    }
  });

  it("primary hostname: the first active one by name, else the first one, else none", () => {
    expect(summary([], [domain("d1", "z.example.test", "active"), domain("d2", "c.example.test", "pending"), domain("d3", "b.example.test", "active")]).primaryHostname).toBe(
      "b.example.test",
    );
    expect(summary([], [domain("d1", "z.example.test", "failed"), domain("d2", "c.example.test", "pending")]).primaryHostname).toBe("c.example.test");
    expect(summary([]).primaryHostname).toBeNull();
  });
});

describe("appStackDetailDto", () => {
  it("a draft shows the spec services by key, no revision and the spec totals", () => {
    const dto = appStackDetailDto(detailInput());
    expect(dto).toMatchObject({
      status: "draft",
      revisionNumber: null,
      componentCount: 0,
      cpuMilli: 1500,
      memoryBytes: String(768 * 1024 * 1024),
      ingress: [{ componentKey: "app", port: 8080 }],
    });
    expect(dto.components).toEqual([
      { key: "app", health: "unknown", healthObservedAt: null, dependsOn: ["cache"], ingress: true, cpuMilli: 1000, memoryBytes: String(512 * 1024 * 1024) },
      { key: "cache", health: "unknown", healthObservedAt: null, dependsOn: [], ingress: false, cpuMilli: 500, memoryBytes: String(256 * 1024 * 1024) },
    ]);
    expect(AppStackDetailDtoSchema.strict().parse(dto)).toEqual(dto);
  });

  it("a deployed stack shows the plan order, ingress flags, effective health and the revision number", () => {
    const dto = appStackDetailDto(deployed([component("app", "healthy", FRESH), component("cache", "healthy", FRESH)]));
    expect(PLAN.components.map((c) => c.key)).toEqual(["cache", "app"]);
    expect(dto.components.map(({ key, ingress, health }) => ({ key, ingress, health }))).toEqual([
      { key: "cache", ingress: false, health: "healthy" },
      { key: "app", ingress: true, health: "healthy" },
    ]);
    expect(dto.components[1]?.healthObservedAt).toBe(FRESH.toISOString());
    expect(dto).toMatchObject({ status: "running", revisionNumber: 3, componentCount: 2, unhealthyCount: 0, cpuMilli: 1500 });
    expect(AppStackDetailDtoSchema.strict().parse(dto)).toEqual(dto);
  });

  it("shows the read-time status: a stale component of a running stack reads unknown", () => {
    const dto = appStackDetailDto(deployed([component("app", "healthy", FRESH), component("cache", "healthy", STALE)]));
    expect(dto.status).toBe("unknown");
    expect(dto.components[0]).toMatchObject({ key: "cache", health: "unknown", healthObservedAt: STALE.toISOString() });
  });

  it("while the desired revision is not the applied one, the status follows the applied revision's plan", () => {
    // The target runs only the cache; what runs is the full plan, whose web part is the essential one.
    const target = {
      revision: { ...revision, id: "srev_new", revisionNumber: 4 },
      plan: { ...PLAN, revisionId: "srev_new", components: PLAN.components.filter((c) => c.key === "cache"), ingress: [] } as ApprovedStackPlan,
    };
    const shown = (components: AppStackComponentRow[]) =>
      appStackDetailDto(
        detailInput({
          stack: stackRow({ status: "running", desiredRevisionId: "srev_new", appliedRevisionId: REVISION }),
          desired: target,
          appliedPlan: PLAN,
          components,
        }),
      ).status;
    expect(shown([component("app", "healthy", FRESH), component("cache", "healthy", FRESH)])).toBe("running");
    // A crash of what runs shows, and so does an observation gone stale.
    expect(shown([component("app", "stopped", FRESH), component("cache", "healthy", FRESH)])).toBe("failed");
    expect(shown([component("app", "healthy", STALE), component("cache", "healthy", FRESH)])).toBe("unknown");
    // No readable applied plan: the stored status.
    expect(
      appStackDetailDto(
        detailInput({
          stack: stackRow({ status: "running", desiredRevisionId: "srev_new", appliedRevisionId: REVISION }),
          desired: target,
          components: [component("app", "stopped", FRESH)],
        }),
      ).status,
    ).toBe("running");
  });

  it("joins secret parameters with their latest metadata and never lists a secret key among the parameters", () => {
    const rotated = new Date("2026-11-21T08:00:00.000Z");
    const row = (parameterKey: string, publicValue: string | number | boolean) => ({ stackId: STACK, organizationId: ORG, parameterKey, publicValue, updatedAt: NOW });
    const unset = appStackDetailDto(detailInput({ parameters: [row("worker_count", 3), row("app_secret", "x"), row("gone", 1)] }));
    expect(unset.parameters).toEqual([{ key: "worker_count", label: "Worker count", value: 3 }]);
    expect(unset.secretParameters).toEqual([{ key: "app_secret", label: "Application secret", required: true, isSet: false, version: null, setAt: null }]);

    const set = appStackDetailDto(
      detailInput({
        secrets: [
          { parameterKey: "app_secret", version: 2, rotatedAt: rotated },
          { parameterKey: "app_secret", version: 1, rotatedAt: NOW },
        ],
      }),
    );
    expect(set.secretParameters).toEqual([
      { key: "app_secret", label: "Application secret", required: true, isSet: true, version: 2, setAt: rotated.toISOString() },
    ]);
  });

  it("says when the saved addresses and options are not those the last published route file was made from (ADR-0037)", () => {
    const shop = domain("sdom_1", "shop.example.test", "active");
    const hashOf = (rows: AppStackDomainRow[], include = new Set(["app"])) => {
      const { entries } = appStackRoutePlan({ plan: PLAN, domains: rows, include, now: NOW, acmeEnabled: false });
      return entries.length > 0 ? appStackRoutesHash(entries) : null;
    };
    /** The stack as a publication made from `from` leaves it, with `include` the targets that were healthy then. */
    const live = (domains: AppStackDomainRow[], from: AppStackDomainRow[] | null, include = new Set(["app"])) => {
      const appliedRoutesHash = from === null ? null : hashOf(from, include);
      const appliedAddressesHash = from === null ? null : appStackAddressesHash(from, appliedRoutesHash);
      return appStackDetailDto(
        deployed([component("app", "healthy", FRESH)], {
          stack: stackRow({ status: "running", desiredRevisionId: REVISION, appliedRevisionId: REVISION, appliedRoutesHash, appliedAddressesHash }),
          appliedPlan: PLAN,
          domains,
        }),
      ).routesPending;
    };
    expect(live([shop], [shop])).toBe(false);
    // Published while the target read unhealthy, so the file holds no route: nothing the customer saved is missing.
    expect(live([shop], [shop], new Set())).toBe(false);
    const protectedShop = { ...shop, accessUsername: "guest", accessPasswordHash: "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/" };
    expect(live([protectedShop], [shop])).toBe(true);
    expect(live([protectedShop], [protectedShop])).toBe(false);
    // Saved after that publication: pending even though the target is not healthy, so a refresh would not show it yet.
    expect(live([protectedShop], [shop], new Set())).toBe(true);
    expect(live([shop, domain("sdom_2", "new.example.test", "pending")], [shop])).toBe(true);
    expect(live([], [shop])).toBe(true);
    // The first address of a stack published with none.
    expect(live([shop], [])).toBe(true);
    // Stopped or never installed: nothing published holds nothing back.
    expect(live([protectedShop], null)).toBe(false);
    expect(appStackDetailDto(detailInput({ domains: [protectedShop] })).routesPending).toBe(false);
  });

  it("a routes hash without its fingerprint, or written after it by a release that does not know it, reads pending", () => {
    const shop = domain("sdom_1", "shop.example.test", "active");
    const { entries } = appStackRoutePlan({ plan: PLAN, domains: [shop], include: new Set(["app"]), now: NOW, acmeEnabled: false });
    const published = appStackRoutesHash(entries);
    const pending = (appliedRoutesHash: string | null, appliedAddressesHash: string | null) =>
      appStackDetailDto(
        deployed([component("app", "healthy", FRESH)], {
          stack: stackRow({ status: "running", desiredRevisionId: REVISION, appliedRevisionId: REVISION, appliedRoutesHash, appliedAddressesHash }),
          appliedPlan: PLAN,
          domains: [shop],
        }),
      ).routesPending;
    expect(pending(published, appStackAddressesHash([shop], published))).toBe(false);
    expect(pending(published, null)).toBe(true);
    expect(pending("0".repeat(64), appStackAddressesHash([shop], published))).toBe(true);
    expect(pending(null, appStackAddressesHash([shop], published))).toBe(true);
  });

  it("offers as path targets the entry points of both the revision that runs and the desired one, as the API accepts them", () => {
    const app = { componentKey: "app", port: 8080 };
    const cache = { componentKey: "cache", port: 6379 };
    const withIngress = (ingress: ApprovedStackPlan["ingress"]): ApprovedStackPlan => ({ ...PLAN, ingress });
    const stack = stackRow({ status: "running", desiredRevisionId: REVISION, appliedRevisionId: "srev_old" });
    const of = (desired: ApprovedStackPlan, applied: ApprovedStackPlan | null) =>
      appStackDetailDto(deployed([], { stack, desired: { revision, plan: desired }, appliedPlan: applied }));
    // An upgrade asked for and not installed adds an entry point: the address can take it, a path cannot yet.
    expect(of(withIngress([app, cache]), withIngress([app]))).toMatchObject({ ingress: [app, cache], pathTargets: [app] });
    // It removes one: neither can.
    expect(of(withIngress([app]), withIngress([app, cache]))).toMatchObject({ ingress: [app], pathTargets: [app] });
    expect(appStackDetailDto(deployed([])).pathTargets).toEqual(PLAN.ingress);
    expect(appStackDetailDto(detailInput())).toMatchObject({ ingress: [app], pathTargets: [app] });
  });

  describe("the volumes it lists (#111)", () => {
    const volume = (volumeKey: string, status: AppStackVolumeRow["status"]): AppStackVolumeRow => ({
      stackId: STACK,
      organizationId: ORG,
      volumeKey,
      retentionPolicy: "retain",
      status,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const keys = (input: Parameters<typeof appStackDetailDto>[0]) => appStackDetailDto(input).volumes.map((v) => [v.key, v.status]);
    // The revision that runs has `data`; an upgrade that was taken back asked for `cache` too, and its row stayed.
    const appliedWithData: ApprovedStackPlan = { ...PLAN, volumes: [{ key: "data" }] };

    it("does not list a volume that was never created: its row is pending and the revision that runs does not have it", () => {
      expect(keys(deployed([], { appliedPlan: appliedWithData, volumes: [volume("cache", "pending"), volume("data", "present")] }))).toEqual([["data", "present"]]);
    });

    it("lists a pending volume the revision that runs has, and every volume that is not pending", () => {
      expect(keys(deployed([], { appliedPlan: appliedWithData, volumes: [volume("data", "pending")] }))).toEqual([["data", "pending"]]);
      for (const status of ["present", "missing", "retained", "removed"] as const) {
        expect(keys(deployed([], { appliedPlan: { ...PLAN, volumes: [] }, volumes: [volume("old", status)] })), status).toEqual([["old", status]]);
      }
    });

    it("lists none of the volumes of an application whose revision was never applied while they are all pending", () => {
      expect(keys(detailInput({ appliedPlan: null, volumes: [volume("data", "pending")] }))).toEqual([]);
      expect(keys(detailInput({ appliedPlan: null, volumes: [volume("data", "present")] }))).toEqual([["data", "present"]]);
    });

    it("reads the plan that runs from the desired revision when that is the one applied", () => {
      const applied = { ...PLAN, volumes: [{ key: "data" }] };
      const input = deployed([], { desired: { revision, plan: applied }, appliedPlan: null, volumes: [volume("data", "pending"), volume("cache", "pending")] });
      expect(keys(input)).toEqual([["data", "pending"]]);
    });
  });

  it("passes volumes, the active operation, the platform's work, upgrade and rollback through", () => {
    const dto = appStackDetailDto(
      deployed([], {
        volumes: [{ stackId: STACK, organizationId: ORG, volumeKey: "data", retentionPolicy: "retain", status: "present", createdAt: NOW, updatedAt: NOW }],
        activeOperationId: "op_1",
        allowedActions: ["stack.stop", "stack.restart"],
        installed: { revisionNumber: 2, templateVersionNumber: 1 },
        platformWork: "backups_cleanup",
        upgrade: { templateVersionId: "atv_2", versionNumber: 2 },
        rollback: { revisionId: "srev_2", revisionNumber: 2, templateVersionNumber: 1 },
      }),
    );
    expect(dto).toMatchObject({
      volumes: [{ key: "data", status: "present", retentionPolicy: "retain" }],
      activeOperationId: "op_1",
      allowedActions: ["stack.stop", "stack.restart"],
      outcomeUnknown: false,
      installed: { revisionNumber: 2, templateVersionNumber: 1 },
      platformWork: "backups_cleanup",
      upgrade: { templateVersionId: "atv_2", versionNumber: 2 },
      rollback: { revisionId: "srev_2", revisionNumber: 2, templateVersionNumber: 1 },
    });
    expect(AppStackDetailDtoSchema.strict().parse(dto)).toEqual(dto);
  });
});

describe("issue #106: the outcome in doubt is the stored status, not the shown one", () => {
  it("a stale reading of a running application shows unknown with no outcome in doubt; a stored unknown is one", () => {
    const stale = appStackDetailDto(deployed(PLAN.components.map((c) => component(c.key, "healthy", STALE))));
    expect([stale.status, stale.outcomeUnknown]).toEqual(["unknown", false]);
    const doubt = appStackDetailDto(deployed([], { stack: stackRow({ status: "unknown", desiredRevisionId: REVISION, appliedRevisionId: REVISION }) }));
    expect([doubt.status, doubt.outcomeUnknown]).toEqual(["unknown", true]);
  });
});

describe("issue #208: the components of a stopped application", () => {
  const LONG_AGO = new Date(NOW.getTime() - 3 * 60 * 60_000);
  const withStatus = (status: AppStackRow["status"]) => stackRow({ status, desiredRevisionId: REVISION, appliedRevisionId: REVISION });
  const bothStopped = () => PLAN.components.map((c) => component(c.key, "stopped", LONG_AGO));
  const shown = (status: AppStackRow["status"], components: AppStackComponentRow[]) => appStackDetailDto(deployed(components, { stack: withStatus(status) }));

  it("a stopped application keeps the stopped reading it was stopped with, however old it is", () => {
    const dto = shown("stopped", bothStopped());
    expect(dto.components.map(({ health }) => health)).toEqual(["stopped", "stopped"]);
    // The time of the last check is the stored one, not the time of the read.
    expect(dto.components.map(({ healthObservedAt }) => healthObservedAt)).toEqual([LONG_AGO.toISOString(), LONG_AGO.toISOString()]);
    // It is not counted as unhealthy, as before, and the status stays the stored one.
    expect(dto).toMatchObject({ status: "stopped", unhealthyCount: 0, componentCount: 2 });
    expect(appStackSummaryDto({ ...detailInput(), stack: withStatus("stopped"), appliedPlan: PLAN, components: bothStopped(), domains: [] })).toMatchObject({ status: "stopped", unhealthyCount: 0 });
  });

  it("a running application with the same old readings reads unknown, and so does its status", () => {
    const dto = shown("running", bothStopped());
    expect(dto.components.map(({ health }) => health)).toEqual(["unknown", "unknown"]);
    expect(dto.status).toBe("unknown");
  });

  it("only a stopped reading of a stopped application is kept: an old healthy or unhealthy one reads unknown, and so does one never stamped", () => {
    const dto = shown("stopped", [component("cache", "healthy", LONG_AGO), component("app", "unhealthy", LONG_AGO)]);
    expect(dto.components.map(({ health }) => health)).toEqual(["unknown", "unknown"]);
    expect(shown("stopped", [component("cache", "stopped", null), component("app", "unknown", null)]).components.map(({ health }) => health)).toEqual(["unknown", "unknown"]);
    // No row yet reads unknown too.
    expect(shown("stopped", []).components.map(({ health }) => health)).toEqual(["unknown", "unknown"]);
  });

  it("an application that is not stored as stopped keeps the five-minute rule for a stopped reading", () => {
    for (const status of ["stopping", "starting", "failed", "degraded", "unknown", "updating"] as const) {
      expect(shown(status, bothStopped()).components.map(({ health }) => health), status).toEqual(["unknown", "unknown"]);
    }
  });

  it("a fresh reading of a stopped application reads as it is", () => {
    const dto = shown("stopped", [component("cache", "stopped", FRESH), component("app", "unhealthy", FRESH)]);
    expect(dto.components.map(({ health }) => health)).toEqual(["stopped", "unhealthy"]);
    expect(dto.unhealthyCount).toBe(1);
  });
});

describe("row mappers", () => {
  it("maps a domain row", () => {
    const expires = new Date("2027-01-01T00:00:00.000Z");
    const dto = appStackDomainDto({ ...domain("sdom_1", "app.example.test", "active"), certStatus: "failed", certProblem: "not_pointing", certExpiresAt: expires, dnsCheckedAt: NOW });
    expect(dto).toEqual({
      id: "sdom_1",
      hostname: "app.example.test",
      componentKey: "app",
      port: 8080,
      status: "active",
      certificateStatus: "failed",
      certificateProblem: "not_pointing",
      certificateExpiresAt: expires.toISOString(),
      checkedAt: NOW.toISOString(),
      redirectToDomainId: null,
      compression: false,
      protection: null,
      pathRoutes: [],
      removing: false,
    });
    expect(AppStackDomainDtoSchema.strict().parse(dto)).toEqual(dto);
    // Issue #112: an address being removed says so, in no proxy word.
    const going = appStackDomainDto({ ...domain("sdom_2", "old.example.test", "active"), removalRequestedAt: NOW });
    expect(going.removing).toBe(true);
    expect(AppStackDomainDtoSchema.strict().parse(going)).toEqual(going);
  });

  it("maps the routing options of a domain row: the user name, never the verifier of the password", () => {
    const verifier = "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/";
    const pathRoutes = [{ pathPrefix: "/api", componentKey: "api", port: 3000, stripPrefix: true }];
    const dto = appStackDomainDto({
      ...domain("sdom_1", "app.example.test", "active"),
      compression: true,
      accessUsername: "team",
      accessPasswordHash: verifier,
      pathRoutes,
    });
    expect(dto).toMatchObject({ redirectToDomainId: null, compression: true, protection: { username: "team" }, pathRoutes });
    expect(JSON.stringify(dto)).not.toContain("apr1");
    expect(findForbiddenPublicDtoKeys(dto)).toEqual([]);
    expect(AppStackDomainDtoSchema.strict().parse(dto)).toEqual(dto);
    const redirecting = appStackDomainDto({ ...domain("sdom_2", "old.example.test", "active"), redirectToDomainId: "sdom_1" });
    expect(redirecting).toMatchObject({ redirectToDomainId: "sdom_1", protection: null, pathRoutes: [] });
  });

  it("maps a deployment row with its operation kind and revision number", () => {
    const row: AppStackDeploymentRow = {
      id: "sdep_1",
      stackId: STACK,
      organizationId: ORG,
      operationId: "op_1",
      revisionId: REVISION,
      status: "failed",
      problem: "STACK_HEALTH_TIMEOUT",
      startedAt: FRESH,
      endedAt: null,
      replacedRevisionId: null,
      replacedStatus: null,
    };
    const dto = appStackDeploymentDto(row, "stack.deploy", 3);
    expect(dto).toEqual({
      id: "sdep_1",
      operationId: "op_1",
      kind: "stack.deploy",
      revisionNumber: 3,
      status: "failed",
      problem: "STACK_HEALTH_TIMEOUT",
      startedAt: FRESH.toISOString(),
      endedAt: null,
    });
    expect(AppStackDeploymentDtoSchema.strict().parse(dto)).toEqual(dto);
  });

  it("builds the accepted envelope links", () => {
    const queued = {
      stack: stackRow({ status: "queued" }),
      revision,
      deployment: { id: "sdep_1" },
      operation: { id: "op_1" },
      idempotentReplay: false,
    } as unknown as AppStackWriteResult;
    expect(appStackAcceptedEnvelope(ORG, queued)).toEqual({
      data: { stackId: STACK, operationId: "op_1", deploymentId: "sdep_1", status: "queued" },
      links: { stack: `/v1/organizations/${ORG}/app-stacks/${STACK}`, operation: `/v1/organizations/${ORG}/operations/op_1` },
    });
    const draft = appStackAcceptedEnvelope(ORG, { stack: stackRow(), revision: null, deployment: null, operation: null, idempotentReplay: false });
    expect(draft).toEqual({
      data: { stackId: STACK, operationId: null, deploymentId: null, status: "draft" },
      links: { stack: `/v1/organizations/${ORG}/app-stacks/${STACK}`, operation: null },
    });
    expect(AppStackAcceptedEnvelopeSchema.strict().parse(draft)).toEqual(draft);
  });
});
