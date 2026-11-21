import { describe, expect, it } from "vitest";
import {
  PHP_INT_PATTERN,
  PHP_SETTING_DEFAULTS,
  PHP_SETTING_KEYS,
  PHP_SETTING_RULES,
  PHP_SIZE_PATTERN,
  PhpSettingsSchema,
  phpSettingProblem,
  phpSizeToBytes,
  type PhpSettingKey,
} from "../src/index.js";

const ok = (key: PhpSettingKey, value: string) => expect(phpSettingProblem(key, value), `${key}=${value}`).toBeNull();
const bad = (key: PhpSettingKey, value: string) => expect(phpSettingProblem(key, value), `${key}=${value}`).toEqual(expect.any(String));

describe("php settings: closed key set", () => {
  it("lists exactly the six settings and a rule for each", () => {
    expect(PHP_SETTING_KEYS).toEqual(["upload_max_filesize", "post_max_size", "memory_limit", "max_execution_time", "max_input_time", "max_input_vars"]);
    expect(Object.keys(PHP_SETTING_RULES)).toEqual([...PHP_SETTING_KEYS]);
  });

  it("holds the PHP built-in defaults for the three size settings", () => {
    expect(PHP_SETTING_DEFAULTS).toEqual({ upload_max_filesize: 2n * 1024n ** 2n, post_max_size: 8n * 1024n ** 2n, memory_limit: 128n * 1024n ** 2n });
  });
});

describe("phpSizeToBytes", () => {
  it("converts binary units", () => {
    expect(phpSizeToBytes("1K")).toBe(1024n);
    expect(phpSizeToBytes("64M")).toBe(67108864n);
    expect(phpSizeToBytes("1G")).toBe(1073741824n);
    expect(phpSizeToBytes("99999M")).toBe(99999n * 1048576n);
  });

  it.each(["1g", "64MB", "", " 64M", "64M ", "64 M", "1.5G", "0M", "-1", "64", "M", "100000M", "64M\n"])("throws RangeError on %j", (value) => {
    expect(() => phpSizeToBytes(value)).toThrow(RangeError);
  });
});

describe("phpSettingProblem", () => {
  it("bounds the upload and post sizes at 4G", () => {
    for (const key of ["upload_max_filesize", "post_max_size"] as const) {
      ok(key, "1K");
      ok(key, "64M");
      ok(key, "4096M");
      ok(key, "4G");
      bad(key, "4097M");
      bad(key, "5G");
      bad(key, "99999M");
    }
  });

  it("bounds memory_limit at 64G", () => {
    ok("memory_limit", "256M");
    ok("memory_limit", "64G");
    ok("memory_limit", "65536M");
    bad("memory_limit", "65G");
    bad("memory_limit", "65537M");
  });

  it("bounds the execution and input times at 1..3600", () => {
    for (const key of ["max_execution_time", "max_input_time"] as const) {
      ok(key, "1");
      ok(key, "3600");
      bad(key, "3601");
      bad(key, "0");
      bad(key, "-1");
    }
  });

  it("bounds max_input_vars at 100..100000", () => {
    ok("max_input_vars", "100");
    ok("max_input_vars", "1000");
    ok("max_input_vars", "100000");
    bad("max_input_vars", "99");
    bad("max_input_vars", "100001");
    bad("max_input_vars", "999999");
  });

  it("refuses unlimited, unit-less sizes, unit-bearing ints and loose formatting", () => {
    for (const value of ["-1", "unlimited", "0", "0M", "64m", "64g", "64MB", "64MiB", " 64M", "64M ", "64 M", "1.5G", "+64M", "064M", "64M\n", "64M;", "64M\nauto_prepend_file=x", "", "100000M"]) {
      bad("upload_max_filesize", value);
      bad("memory_limit", value);
    }
    for (const value of ["1h", "1.5", " 5", "5 ", "05", "+5", "5\n", "5;", "1e3", "0x10", "", "1000000"]) {
      bad("max_execution_time", value);
      bad("max_input_vars", value);
    }
  });

  it("refuses a size where an int is expected and the other way round", () => {
    bad("max_execution_time", "30M");
    bad("memory_limit", "300");
  });

  it("exposes the two value patterns", () => {
    expect(PHP_SIZE_PATTERN.test("64M")).toBe(true);
    expect(PHP_SIZE_PATTERN.test("64")).toBe(false);
    expect(PHP_INT_PATTERN.test("300")).toBe(true);
    expect(PHP_INT_PATTERN.test("300M")).toBe(false);
  });
});

describe("PhpSettingsSchema", () => {
  it("accepts any non-empty subset of the keys", () => {
    expect(PhpSettingsSchema.parse({ upload_max_filesize: "64M" })).toEqual({ upload_max_filesize: "64M" });
    const all = { upload_max_filesize: "64M", post_max_size: "128M", memory_limit: "512M", max_execution_time: "120", max_input_time: "60", max_input_vars: "3000" };
    expect(PhpSettingsSchema.parse(all)).toEqual(all);
  });

  it("refuses an empty object", () => {
    expect(PhpSettingsSchema.safeParse({}).success).toBe(false);
    expect(PhpSettingsSchema.safeParse({ memory_limit: undefined }).success).toBe(false);
  });

  it.each(["disable_functions", "auto_prepend_file", "open_basedir", "extension", "zend_extension", "Memory_Limit", "memory_limit "])("refuses the unknown key %j", (key) => {
    expect(PhpSettingsSchema.safeParse({ memory_limit: "256M", [key]: "1" }).success).toBe(false);
    expect(PhpSettingsSchema.safeParse({ [key]: "1" }).success).toBe(false);
  });

  it("refuses an invalid value and names the key in the issue path", () => {
    const result = PhpSettingsSchema.safeParse({ memory_limit: "256M", post_max_size: "5G" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(["post_max_size"]);
  });

  it.each([-1, 64, null, true, ["64M"], { v: "64M" }])("refuses a non-string value %j", (value) => {
    expect(PhpSettingsSchema.safeParse({ memory_limit: value }).success).toBe(false);
  });

  it.each([null, undefined, "memory_limit=64M", ["memory_limit"]])("refuses the non-object input %j", (value) => {
    expect(PhpSettingsSchema.safeParse(value).success).toBe(false);
  });
});
