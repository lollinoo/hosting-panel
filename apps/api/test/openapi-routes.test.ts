import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../..");
const api = readFileSync(resolve(root, "docs/api/openapi.yaml"), "utf8");

/** Every route the controllers register, as "GET /v1/admin/sites/{siteId}". */
function controllerRoutes(): Set<string> {
  const dir = resolve(root, "apps/api/src/controllers");
  const out = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".controller.ts")).sort()) {
    const code = readFileSync(resolve(dir, file), "utf8");
    const controllers = [...code.matchAll(/@Controller\(\s*(?:"([^"]*)")?\s*\)/g)];
    expect(controllers, file).toHaveLength(1); // one controller per file keeps the prefix unambiguous
    const prefix = controllers[0]![1] ?? "";
    for (const route of code.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)")?\s*\)/g)) {
      const path = `/${[prefix, route[2] ?? ""].filter(Boolean).join("/")}`.replace(/:(\w+)/g, "{$1}");
      out.add(`${route[1]!.toUpperCase()} ${path}`);
    }
  }
  return out;
}

/** Every operation under `paths:`, as "GET /path" -> operationId. */
function documentedOperations(): Map<string, string> {
  const out = new Map<string, string>();
  const start = api.indexOf("\npaths:\n");
  const end = api.indexOf("\ncomponents:\n");
  let path = "";
  let method = "";
  for (const line of api.slice(start, end).split("\n")) {
    const pathLine = /^ {2}(\/[^\s:]*):\s*$/.exec(line);
    if (pathLine) {
      path = pathLine[1]!;
      method = "";
      continue;
    }
    const methodLine = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (methodLine) {
      method = methodLine[1]!.toUpperCase();
      out.set(`${method} ${path}`, "");
      continue;
    }
    const operationLine = /^ {6}operationId:\s*(\S+)/.exec(line);
    if (operationLine && method) out.set(`${method} ${path}`, operationLine[1]!);
  }
  return out;
}

describe("controller routes and docs/api/openapi.yaml agree", () => {
  const routes = controllerRoutes();
  const operations = documentedOperations();

  it("finds the routes on both sides (the scanner itself works)", () => {
    expect(routes.size).toBeGreaterThan(150);
    expect(operations.size).toBeGreaterThan(150);
  });

  it("documents every controller route under its method", () => {
    expect([...routes].filter((route) => !operations.has(route)).sort()).toEqual([]);
  });

  it("has a controller route for every documented operation", () => {
    expect([...operations.keys()].filter((operation) => !routes.has(operation)).sort()).toEqual([]);
  });

  it("gives every operation a unique operationId", () => {
    const ids = [...operations.values()];
    expect(ids.filter((id) => id === "")).toEqual([]);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("documents the site template routes", () => {
    for (const route of [
      "GET /v1/admin/site-templates",
      "POST /v1/admin/site-templates",
      "POST /v1/admin/site-templates/validate",
      "GET /v1/admin/site-templates/{templateId}",
      "PATCH /v1/admin/site-templates/{templateId}",
      "DELETE /v1/admin/site-templates/{templateId}",
      "POST /v1/admin/site-templates/{templateId}/versions",
      "GET /v1/admin/site-templates/{templateId}/versions/{versionId}",
      "POST /v1/admin/sites/{siteId}/template-version",
      "GET /v1/organizations/{orgId}/site-types",
    ]) {
      expect(operations.has(route), route).toBe(true);
      expect(routes.has(route), route).toBe(true);
    }
  });

  it("documents the managed sites list", () => {
    expect(operations.has("GET /v1/organizations/{orgId}/managed-sites")).toBe(true);
    expect(routes.has("GET /v1/organizations/{orgId}/managed-sites")).toBe(true);
  });

  it("documents the application template and stack routes", () => {
    for (const route of [
      "GET /v1/admin/app-templates",
      "POST /v1/admin/app-templates/validate",
      "POST /v1/admin/app-templates/import-compose",
      "POST /v1/admin/app-templates",
      "GET /v1/admin/app-templates/{templateId}",
      "PATCH /v1/admin/app-templates/{templateId}",
      "POST /v1/admin/app-templates/{templateId}/versions",
      "GET /v1/admin/app-templates/{templateId}/versions/{versionId}",
      "POST /v1/admin/app-templates/{templateId}/archive",
      "GET /v1/admin/app-templates/{templateId}/usage",
      "GET /v1/admin/app-stacks",
      "GET /v1/organizations/{orgId}/app-templates",
      "GET /v1/organizations/{orgId}/app-templates/{templateId}",
      "POST /v1/organizations/{orgId}/app-stacks",
      "GET /v1/organizations/{orgId}/app-stacks",
      "GET /v1/organizations/{orgId}/app-stacks/{stackId}",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/deploy",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/start",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/stop",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/restart",
      "DELETE /v1/organizations/{orgId}/app-stacks/{stackId}",
      "GET /v1/organizations/{orgId}/app-stacks/{stackId}/deployments",
      "GET /v1/organizations/{orgId}/app-stacks/{stackId}/components/{componentKey}/logs",
      "GET /v1/organizations/{orgId}/app-stacks/{stackId}/components/{componentKey}/health",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/secrets",
      "GET /v1/organizations/{orgId}/app-stacks/{stackId}/backups",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/backups",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/backups/{backupId}/restore",
      "GET /v1/organizations/{orgId}/app-stacks/{stackId}/domains",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/domains",
      "DELETE /v1/organizations/{orgId}/app-stacks/{stackId}/domains/{domainId}",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/domains/{domainId}/check",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/plan",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/upgrade",
      "POST /v1/organizations/{orgId}/app-stacks/{stackId}/rollback",
    ]) {
      expect(operations.has(route), route).toBe(true);
      expect(routes.has(route), route).toBe(true);
    }
  });
});
