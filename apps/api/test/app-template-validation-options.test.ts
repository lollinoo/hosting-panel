import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveAppTemplateValidationOptions } from "../src/app-templates/app-template-validation-options.js";

const ENTRY = { repository: "registry.example.invalid/demo/app", runAsUser: null, note: "test" };

describe("application template validation options seam", () => {
  it("production passes nothing: main.ts never sets the option", () => {
    expect(readFileSync(new URL("../src/main.ts", import.meta.url), "utf8")).not.toContain("appTemplateValidation");
  });

  it("defaults to a frozen object without an allowlist, so the code allowlist applies", () => {
    const options = resolveAppTemplateValidationOptions();
    expect(Object.isFrozen(options)).toBe(true);
    expect("allowlist" in options).toBe(false);
  });

  it("copies and freezes the rows a test injects", () => {
    const given = { allowlist: [ENTRY] };
    const options = resolveAppTemplateValidationOptions(given);
    expect(options).not.toBe(given);
    expect(Object.isFrozen(options)).toBe(true);
    expect(options.allowlist).toEqual([ENTRY]);
  });
});
