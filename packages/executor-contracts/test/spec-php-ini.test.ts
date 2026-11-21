import { describe, expect, it } from "vitest";
import { createApprovedServiceSpec, type CreateApprovedServiceSpecInput } from "../src/index.js";

const base: CreateApprovedServiceSpecInput = {
  serviceInstanceId: "svc-1",
  siteId: "site-1",
  organizationId: "org-1",
  image: "wordpress:6.4-php8.3",
  containerName: "wp-app-01",
  env: { WP_DEBUG: "false" },
};

const failure = (phpIni: Record<string, string>): unknown => {
  try {
    createApprovedServiceSpec({ ...base, phpIni });
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("createApprovedServiceSpec: phpIni", () => {
  it("keeps a valid phpIni as a frozen copy", () => {
    const phpIni = { upload_max_filesize: "64M", memory_limit: "256M" };
    const spec = createApprovedServiceSpec({ ...base, phpIni });

    expect(spec.phpIni).toEqual({ upload_max_filesize: "64M", memory_limit: "256M" });
    expect(Object.isFrozen(spec.phpIni)).toBe(true);
    expect(spec.phpIni).not.toBe(phpIni);

    phpIni.memory_limit = "512M";
    expect(spec.phpIni?.memory_limit).toBe("256M");
  });

  it("omits the key when phpIni is absent, undefined or empty", () => {
    for (const input of [base, { ...base, phpIni: undefined }, { ...base, phpIni: {} }]) {
      expect("phpIni" in createApprovedServiceSpec(input)).toBe(false);
    }
  });

  it("leaves every other field of a spec without phpIni unchanged", () => {
    const { approvedAt, ...rest } = createApprovedServiceSpec(base);
    expect(typeof approvedAt).toBe("string");
    expect(rest).toEqual({
      __brand: "ApprovedServiceSpec",
      serviceInstanceId: "svc-1",
      siteId: "site-1",
      organizationId: "org-1",
      image: "wordpress:6.4-php8.3",
      containerName: "wp-app-01",
      env: { WP_DEBUG: "false" },
      portBindings: [],
      resourceLimits: null,
    });
    expect(Object.keys(rest)).toEqual(["__brand", "serviceInstanceId", "siteId", "organizationId", "image", "containerName", "env", "portBindings", "resourceLimits"]);
  });

  it.each([
    ["an unknown key", { disable_functions: "exec" }],
    ["a directive injected in a value", { memory_limit: "256M\nauto_prepend_file=/x" }],
    ["a bad size", { upload_max_filesize: "64MB" }],
    ["an out-of-range number", { max_execution_time: "99999" }],
    ["a mix of a valid and an unknown key", { memory_limit: "256M", open_basedir: "/" }],
  ])("rejects %s with VALIDATION_ERROR", (_label, phpIni) => {
    const error = failure(phpIni);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("VALIDATION_ERROR");
  });

  it("rejects a phpIni whose only key is undefined", () => {
    const error = failure({ memory_limit: undefined as unknown as string });
    expect((error as { code?: string }).code).toBe("VALIDATION_ERROR");
  });

  it("never carries an undefined-valued key into the spec", () => {
    const spec = createApprovedServiceSpec({
      ...base,
      phpIni: { memory_limit: "256M", post_max_size: undefined as unknown as string },
    });
    expect(spec.phpIni).toEqual({ memory_limit: "256M" });
    expect(Object.keys(spec.phpIni!)).toEqual(["memory_limit"]);
  });
});
