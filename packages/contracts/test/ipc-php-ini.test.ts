import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ApprovedServiceSpecWireSchema, DeployServiceIpcRequestSchema } from "../src/index.js";

const base = {
  serviceInstanceId: "svc-1",
  siteId: "site-1",
  organizationId: "org-1",
  image: "wordpress:6.4-php8.3",
  containerName: "wp-app-01",
  env: { WP_DEBUG: "false" },
  exposeHttp: true,
  internalPort: 80,
};

describe("ApprovedServiceSpecWireSchema: phpIni", () => {
  it("keeps phpIni and strips nothing else", () => {
    const phpIni = { upload_max_filesize: "64M", max_execution_time: "300" };
    const parsed = ApprovedServiceSpecWireSchema.parse({ ...base, phpIni });
    expect(parsed.phpIni).toEqual(phpIni);
    expect(parsed).toMatchObject(base);
  });

  it("keeps phpIni inside a deploy request", () => {
    const parsed = DeployServiceIpcRequestSchema.parse({ spec: { ...base, phpIni: { memory_limit: "256M" } } });
    expect(parsed.spec.phpIni).toEqual({ memory_limit: "256M" });
  });

  it("parses a spec without phpIni to an object without the property", () => {
    const parsed = ApprovedServiceSpecWireSchema.parse(base);
    expect("phpIni" in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual(
      [...Object.keys(base), "portBindings", "resourceLimits"].sort(),
    );
  });

  it.each([
    ["an unknown key", { disable_functions: "exec" }],
    ["a bad size", { upload_max_filesize: "64MB" }],
    ["a directive injected in a value", { memory_limit: "256M\nauto_prepend_file=/x" }],
    ["an out-of-range number", { max_input_vars: "5" }],
    ["an empty object", {}],
    ["a non-text value", { memory_limit: 256 }],
  ])("rejects %s", (_label, phpIni) => {
    expect(ApprovedServiceSpecWireSchema.safeParse({ ...base, phpIni }).success).toBe(false);
  });

  it("rejects null and non-object phpIni", () => {
    expect(ApprovedServiceSpecWireSchema.safeParse({ ...base, phpIni: null }).success).toBe(false);
    expect(ApprovedServiceSpecWireSchema.safeParse({ ...base, phpIni: "memory_limit=1G" }).success).toBe(false);
  });

  it("adds no site-type word to ipc-schemas.ts (the boundary scan lists the file)", async () => {
    const source = await readFile(new URL("../src/ipc-schemas.ts", import.meta.url), "utf8");
    const phpLines = source.split("\n").filter((line) => /phpIni|php-settings/.test(line));
    expect(phpLines).toHaveLength(2);
    expect(phpLines.join("\n")).not.toMatch(/wordpress|\bwp\b|wp[-_]/i);
  });
});
