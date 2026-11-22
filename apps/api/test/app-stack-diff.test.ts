import { ApprovedStackPlanSchema, type AppStackPlanComponent, type AppTemplateParameterEntry, type ApprovedStackPlan } from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import { diffAppStackPlans } from "../src/app-stacks/app-stack-diff.js";

const IMAGE = `registry.test/acme/web@sha256:${"c".repeat(64)}`;
const OTHER_IMAGE = `registry.test/acme/web@sha256:${"d".repeat(64)}`;

function component(key: string, patch: Partial<AppStackPlanComponent> = {}): AppStackPlanComponent {
  return {
    key,
    image: IMAGE,
    runAsUser: null,
    argv: null,
    environment: [],
    secretFiles: [],
    resources: { cpuMilli: 250, memoryBytes: "134217728" },
    expose: [8080, 9000],
    dependsOn: [],
    volumes: [],
    healthcheck: { kind: "tcp", port: 8080, intervalSeconds: 10, timeoutSeconds: 3 },
    ...patch,
  };
}

const db = component("db", {
  secretFiles: [{ envName: "DB_PASSWORD_FILE", parameterKey: "db_password", version: 1 }],
  volumes: [{ volumeKey: "data", containerPath: "/var/lib/db", readOnly: false }],
});
const web = component("web", { dependsOn: ["db"], environment: [{ name: "SITE_TITLE", value: "Hello" }] });

function plan(patch: Partial<ApprovedStackPlan> = {}): ApprovedStackPlan {
  return ApprovedStackPlanSchema.parse({
    schemaVersion: 1,
    stackId: "stk_0123456789abcdef",
    organizationId: "org_acme",
    hostAllocationId: "alloc_0123456789abcdef",
    templateVersionId: "atv_0123456789abcdef",
    revisionId: "srev_0123456789abcdef",
    planHash: "0".repeat(64),
    components: [db, web],
    volumes: [{ key: "data" }],
    ingress: [{ componentKey: "web", port: 8080 }],
    ...patch,
  });
}

const PARAMS: AppTemplateParameterEntry[] = [{ key: "site_title", value: "Hello" }];
const diff = (from: ApprovedStackPlan | null, to: ApprovedStackPlan, toParameters = PARAMS, fromParameters = PARAMS) =>
  diffAppStackPlans({ from, to, fromParameters: from === null ? [] : fromParameters, toParameters });

describe("diffAppStackPlans", () => {
  it("identical plans give an all-unchanged diff without restart, downtime or data risk", () => {
    expect(diff(plan(), plan())).toEqual({
      components: [
        { key: "db", change: "unchanged", restart: false },
        { key: "web", change: "unchanged", restart: false },
      ],
      volumes: [{ key: "data", change: "unchanged" }],
      parameters: [
        { key: "db_password", change: "unchanged" },
        { key: "site_title", change: "unchanged" },
      ],
      ingress: [{ componentKey: "web", port: 8080, change: "unchanged" }],
      downtime: false,
      dataRisk: false,
    });
  });

  it("a first install adds everything and restarts nothing", () => {
    const result = diff(null, plan());
    expect(result.components).toEqual([
      { key: "db", change: "added", restart: false },
      { key: "web", change: "added", restart: false },
    ]);
    expect(result.volumes).toEqual([{ key: "data", change: "added" }]);
    expect(result.parameters.map((p) => p.change)).toEqual(["added", "added"]);
    expect(result.ingress).toEqual([{ componentKey: "web", port: 8080, change: "added" }]);
    expect(result).toMatchObject({ downtime: false, dataRisk: false });
  });

  it("an image change updates and restarts that component only and takes the web address down", () => {
    const result = diff(plan(), plan({ components: [db, { ...web, image: OTHER_IMAGE }] }));
    expect(result.components).toEqual([
      { key: "db", change: "unchanged", restart: false },
      { key: "web", change: "updated", restart: true },
    ]);
    expect(result.downtime).toBe(true);
  });

  it("a public parameter change is named without its value", () => {
    const to = plan({ components: [db, { ...web, environment: [{ name: "SITE_TITLE", value: "World" }] }] });
    const result = diff(plan(), to, [{ key: "site_title", value: "World" }]);
    expect(result.parameters).toEqual([
      { key: "db_password", change: "unchanged" },
      { key: "site_title", change: "updated" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/Hello|World/);
  });

  it("a secret version bump is an updated parameter, named without a value or version", () => {
    const bumped = { ...db, secretFiles: [{ envName: "DB_PASSWORD_FILE", parameterKey: "db_password", version: 2 }] };
    const result = diff(plan(), plan({ components: [bumped, web] }));
    expect(result.parameters).toEqual([
      { key: "db_password", change: "updated" },
      { key: "site_title", change: "unchanged" },
    ]);
    expect(result.components[0]).toEqual({ key: "db", change: "updated", restart: true });
    expect(JSON.stringify(result.parameters)).not.toMatch(/version|value|DB_PASSWORD_FILE/);
  });

  it("names a parameter that was removed or added", () => {
    const result = diff(plan(), plan(), [{ key: "admin_email", value: "a@example.test" }]);
    expect(result.parameters).toEqual([
      { key: "admin_email", change: "added" },
      { key: "db_password", change: "unchanged" },
      { key: "site_title", change: "removed" },
    ]);
  });

  it("a component added and one removed", () => {
    const worker = component("worker", { dependsOn: ["db"], healthcheck: null, expose: [] });
    const cache = component("cache", { healthcheck: null, expose: [] });
    const result = diff(plan({ components: [db, web, worker] }), plan({ components: [cache, db, web] }));
    expect(result.components).toEqual([
      { key: "cache", change: "added", restart: false },
      { key: "db", change: "unchanged", restart: false },
      { key: "web", change: "unchanged", restart: false },
      { key: "worker", change: "removed", restart: false },
    ]);
    expect(result.downtime).toBe(false);
  });

  it("a mount added adds the volume; a volume no longer mounted is removed", () => {
    const mounted = { ...web, volumes: [{ volumeKey: "uploads", containerPath: "/srv/uploads", readOnly: false }] };
    const added = diff(plan(), plan({ components: [db, mounted], volumes: [{ key: "data" }, { key: "uploads" }] }));
    expect(added.volumes).toEqual([
      { key: "data", change: "unchanged" },
      { key: "uploads", change: "added" },
    ]);
    expect(added.components[1]).toEqual({ key: "web", change: "updated", restart: true });

    const removed = diff(plan(), plan({ components: [{ ...db, volumes: [] }, web], volumes: [] }));
    expect(removed.volumes).toEqual([{ key: "data", change: "removed" }]);
  });

  it("an ingress port change removes the old route and adds the new one without touching the component", () => {
    const result = diff(plan(), plan({ ingress: [{ componentKey: "web", port: 9000 }] }));
    expect(result.ingress).toEqual([
      { componentKey: "web", port: 8080, change: "removed" },
      { componentKey: "web", port: 9000, change: "added" },
    ]);
    expect(result.components.every((c) => c.change === "unchanged" && !c.restart)).toBe(true);
    expect(result.downtime).toBe(false);
  });

  it("restarts the dependents of a replaced component, as the runtime does", () => {
    const result = diff(plan(), plan({ components: [{ ...db, image: OTHER_IMAGE }, web] }));
    expect(result.components).toEqual([
      { key: "db", change: "updated", restart: true },
      { key: "web", change: "unchanged", restart: true },
    ]);
    expect(result.downtime).toBe(true);
  });

  it("warns about data only when the current plan has volumes and a component changes", () => {
    const changed = { ...web, image: OTHER_IMAGE };
    expect(diff(plan(), plan({ components: [db, changed] })).dataRisk).toBe(true);
    expect(diff(plan(), plan()).dataRisk).toBe(false);
    const stateless = plan({ components: [{ ...db, volumes: [] }, web], volumes: [] });
    expect(diff(stateless, plan({ components: [{ ...db, volumes: [] }, changed], volumes: [] })).dataRisk).toBe(false);
  });

  it("two calls give identical JSON", () => {
    const from = plan();
    const to = plan({ components: [{ ...db, image: OTHER_IMAGE }, web], ingress: [{ componentKey: "web", port: 9000 }] });
    expect(JSON.stringify(diff(from, to))).toBe(JSON.stringify(diff(from, to)));
  });
});
