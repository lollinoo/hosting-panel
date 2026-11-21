import { describe, expect, it } from "vitest";
import {
  SITE_TEMPLATE_MODULES,
  SUPPORTED_PHP_VERSIONS,
  SiteTemplateSpecSchema,
  parseTemplateYaml,
  resolveWordpressImage,
  type YamlValue,
} from "@hosting-panel/contracts";
import { HP_VARIABLE_MAX_LENGTH } from "../src/site-template-interpolation.js";
import {
  SITE_TEMPLATE_ISSUE_CODES,
  SITE_TEMPLATE_MAX_ISSUES,
  validateSiteTemplate,
  validateSiteTemplateSource,
  type SiteTemplateIssue,
} from "../src/site-template-validation.js";

const BASE_SOURCE = [
  "x-hp-module: wordpress",
  "x-hp-parameters:",
  "  - key: php_version",
  "    label: Versione PHP",
  "    type: enum",
  '    options: ["8.3", "8.4", "8.5"]',
  '    default: "8.4"',
  "    customer: true",
  "services:",
  "  app:",
  "    image: ${HP_MODULE_IMAGE}",
  "    volumes:",
  "      - html:/var/www/html",
  "    expose:",
  '      - "80"',
  "    deploy:",
  "      resources:",
  "        limits:",
  '          cpus: "1.0"',
  "          memory: 512M",
  "volumes:",
  "  html: {}",
  "",
].join("\n");

const parsedBase = parseTemplateYaml(BASE_SOURCE);
if (!parsedBase.ok) throw new Error("the base fixture must parse");
const BASE: YamlValue = parsedBase.value;

const EXPECTED_BASE_SPEC = {
  specVersion: 1,
  module: "wordpress",
  parameters: [
    { key: "php_version", label: "Versione PHP", type: "enum", options: ["8.3", "8.4", "8.5"], default: "8.4", customer: true },
  ],
  service: {
    name: "app",
    image: "${HP_MODULE_IMAGE}",
    environment: [],
    volumes: [{ volume: "html", containerPath: "/var/www/html" }],
    expose: [80],
    limits: { cpuMilli: 1000, memoryBytes: "536870912" },
  },
  php: null,
};

type Path = readonly (string | number)[];
const REMOVE = Symbol("remove");
type Edit = readonly [path: Path, value: unknown];
type Node = Record<string | number, unknown>;

/** A copy of the base document with each edit applied; REMOVE deletes the key. */
function build(...edits: Edit[]): unknown {
  const root = structuredClone(BASE) as Node;
  for (const [path, value] of edits) {
    let node = root;
    for (const key of path.slice(0, -1)) node = node[key] as Node;
    const last = path[path.length - 1]!;
    if (value === REMOVE) delete node[last];
    else node[last] = value;
  }
  return root;
}

const SERVICE = ["services", "app"] as const;
const inService = (...rest: (string | number)[]): Path => [...SERVICE, ...rest];

function errorsOf(doc: unknown): SiteTemplateIssue[] {
  const result = validateSiteTemplate(doc, "wordpress");
  if (result.ok) throw new Error("expected the template to be refused");
  return result.errors;
}
const codesOf = (doc: unknown): string[] => errorsOf(doc).map((error) => error.code);
const specOf = (doc: unknown) => {
  const result = validateSiteTemplate(doc, "wordpress");
  if (!result.ok) throw new Error(`expected a valid template, got ${JSON.stringify(result.errors)}`);
  return result.spec;
};
const phpParameter = (overrides: Record<string, unknown> = {}) => ({
  key: "php_version",
  label: "Versione PHP",
  type: "enum",
  options: ["8.3", "8.4", "8.5"],
  default: "8.4",
  customer: true,
  ...overrides,
});
const withParameter = (parameter: Record<string, unknown>): unknown => build([["x-hp-parameters"], [phpParameter(), parameter]]);

describe("the built-in shaped source", () => {
  it("validates to the expected spec and the spec passes the contract schema", () => {
    const result = validateSiteTemplateSource(BASE_SOURCE, "wordpress");
    expect(result).toEqual({ ok: true, spec: EXPECTED_BASE_SPEC });
    if (result.ok) expect(SiteTemplateSpecSchema.parse(result.spec)).toEqual(result.spec);
  });

  it("gives the identical spec for the JSON rendering of the document", () => {
    expect(validateSiteTemplateSource(JSON.stringify(BASE), "wordpress")).toEqual({ ok: true, spec: EXPECTED_BASE_SPEC });
  });

  it("does not mutate its input", () => {
    const doc = build();
    const copy = structuredClone(doc);
    validateSiteTemplate(doc, "wordpress");
    expect(doc).toEqual(copy);
  });
});

describe("the image", () => {
  it("accepts the literal pin of every supported PHP version when that version is the only option", () => {
    for (const version of SUPPORTED_PHP_VERSIONS) {
      const doc = build([["x-hp-parameters"], [phpParameter({ options: [version], default: version })]], [inService("image"), resolveWordpressImage(version)]);
      expect(specOf(doc).service.image).toBe(resolveWordpressImage(version));
    }
  });

  it("accepts a tag that follows the php_version parameter", () => {
    const doc = build([inService("image"), "wordpress:7.1.4-php${php_version}-apache"]);
    expect(specOf(doc).service.image).toBe("wordpress:7.1.4-php${php_version}-apache");
  });

  it("refuses a literal pin that does not fit every option, naming the option", () => {
    const doc = build([["x-hp-parameters"], [phpParameter({ options: ["8.3", "8.4"] })]], [inService("image"), resolveWordpressImage("8.4")]);
    const errors = errorsOf(doc);
    expect(errors.map((e) => e.code)).toEqual(["IMAGE_TAG_NOT_ALLOWED"]);
    expect(errors[0]?.message).toContain("8.3");
    expect(errors[0]?.path).toBe("services.app.image");
  });

  it("reports a repository problem once, not once per option", () => {
    const doc = build([inService("image"), "evil/wordpress:7.1.4-php${php_version}-apache"]);
    expect(codesOf(doc)).toEqual(["IMAGE_REPOSITORY_NOT_ALLOWED"]);
  });

  it("does not check the image against options that are not supported", () => {
    const doc = build([["x-hp-parameters"], [phpParameter({ options: ["8.4", "7.4"] })]], [inService("image"), resolveWordpressImage("8.4")]);
    expect(codesOf(doc)).toEqual(["PHP_VERSION_UNSUPPORTED"]);
  });
});

describe("the environment", () => {
  it("gives the same entries from the mapping and the list form, in source order", () => {
    const mapping = specOf(build([inService("environment"), { WP_B: "1", WP_A: "2" }])).service.environment;
    const list = specOf(build([inService("environment"), ["WP_B=1", "WP_A=2"]])).service.environment;
    expect(mapping).toEqual([{ name: "WP_B", value: "1" }, { name: "WP_A", value: "2" }]);
    expect(list).toEqual(mapping);
  });

  it("turns numbers and booleans into text and keeps an empty value in the list form", () => {
    const environment = specOf(build([inService("environment"), { WP_N: 3, WP_T: true, WP_F: false }])).service.environment;
    expect(environment).toEqual([{ name: "WP_N", value: "3" }, { name: "WP_T", value: "true" }, { name: "WP_F", value: "false" }]);
    expect(specOf(build([inService("environment"), ["WP_E="]])).service.environment).toEqual([{ name: "WP_E", value: "" }]);
  });

  it("keeps the placeholders raw and accepts the declared parameter, the magic variables and '$$'", () => {
    const environment = specOf(
      build([inService("environment"), { WP_HOME: "${HP_SITE_URL}", WP_ID: "${HP_SITE_ID}", WP_HOST: "${HP_SITE_DOMAIN}", WP_PHP: "${php_version}", WP_COST: "$$5" }]),
    ).service.environment;
    expect(environment.map((entry) => entry.value)).toEqual(["${HP_SITE_URL}", "${HP_SITE_ID}", "${HP_SITE_DOMAIN}", "${php_version}", "$$5"]);
  });

  it("refuses HP_MODULE_IMAGE in a value", () => {
    expect(codesOf(build([inService("environment"), { WP_X: "${HP_MODULE_IMAGE}" }]))).toEqual(["INTERP_MODULE_IMAGE_MISPLACED"]);
  });

  it("refuses a duplicate name and more than 64 entries", () => {
    expect(codesOf(build([inService("environment"), ["WP_A=1", "WP_A=2"]]))).toEqual(["ENV_NAME_DUPLICATE"]);
    const many = Array.from({ length: 65 }, (_, i) => `WP_${i}=1`);
    expect(codesOf(build([inService("environment"), many]))).toEqual(["ENV_TOO_MANY"]);
    expect(specOf(build([inService("environment"), many.slice(0, 64)])).service.environment).toHaveLength(64);
  });

  it("uses the longest option of an enum for the worst-case length, and caps the stored text too", () => {
    const filler = "x".repeat(4080);
    const mode = (longest: string) => [["x-hp-parameters"], [phpParameter(), { key: "mode", label: "M", type: "enum", options: ["a", longest], default: "a" }]] as const;
    const env = [inService("environment"), { WP_A: `${filler}\${mode}` }] as const;
    expect(specOf(build(env, mode("b"))).service.environment).toHaveLength(1);
    expect(codesOf(build(env, mode("y".repeat(40))))).toEqual(["ENV_VALUE_TOO_LONG"]);
    expect(codesOf(build([inService("environment"), { WP_A: "x".repeat(4097) }]))).toEqual(["ENV_VALUE_TOO_LONG"]);
    expect(codesOf(build([inService("environment"), { WP_A: `${"x".repeat(4090)}\${php_version}` }]))).toEqual(["ENV_VALUE_TOO_LONG"]);
  });
});

describe("the parameters", () => {
  it("accepts a parameter of every type and keeps its customer flag", () => {
    const parameters = [
      phpParameter(),
      { key: "mode", label: "Mode", type: "enum", options: ["a", "b"], default: "b", customer: true },
      { key: "workers", label: "Workers", type: "integer", min: 1, max: 10, default: 2 },
      { key: "greeting", label: "Greeting", type: "string", default: "" },
      { key: "debug", label: "Debug", type: "boolean", default: false, customer: true },
      { key: "upload", label: "Upload", type: "size", default: "64M" },
    ];
    expect(specOf(build([["x-hp-parameters"], parameters])).parameters).toEqual([
      phpParameter(),
      { key: "mode", label: "Mode", type: "enum", options: ["a", "b"], default: "b", customer: true },
      { key: "workers", label: "Workers", type: "integer", min: 1, max: 10, default: 2, customer: false },
      { key: "greeting", label: "Greeting", type: "string", default: "", customer: false },
      { key: "debug", label: "Debug", type: "boolean", default: false, customer: true },
      { key: "upload", label: "Upload", type: "size", default: "64M", customer: false },
    ]);
  });

  it("coerces numeric options and a numeric default of an enum to text", () => {
    const doc = withParameter({ key: "tier", label: "Tier", type: "enum", options: [1, 2], default: 1 });
    expect(specOf(doc).parameters[1]).toMatchObject({ options: ["1", "2"], default: "1" });
  });

  it.each<[string, Record<string, unknown>, string]>([
    ["an enum default outside the options", { key: "m", label: "M", type: "enum", options: ["a"], default: "b" }, "PARAM_DEFAULT_INVALID"],
    ["an enum without options", { key: "m", label: "M", type: "enum", default: "a" }, "PARAM_OPTIONS_INVALID"],
    ["an enum option with a space", { key: "m", label: "M", type: "enum", options: ["a b"], default: "a b" }, "PARAM_OPTIONS_INVALID"],
    ["duplicate enum options", { key: "m", label: "M", type: "enum", options: ["a", "a"], default: "a" }, "PARAM_OPTIONS_INVALID"],
    ["33 enum options", { key: "m", label: "M", type: "enum", options: Array.from({ length: 33 }, (_, i) => `o${i}`), default: "o0" }, "PARAM_OPTIONS_INVALID"],
    ["an integer with min above max", { key: "n", label: "N", type: "integer", min: 5, max: 1, default: 3 }, "PARAM_BOUNDS_INVALID"],
    ["an integer without bounds", { key: "n", label: "N", type: "integer", default: 3 }, "PARAM_BOUNDS_INVALID"],
    ["an integer bound beyond a billion", { key: "n", label: "N", type: "integer", min: 0, max: 1_000_000_001, default: 3 }, "PARAM_BOUNDS_INVALID"],
    ["an integer default out of range", { key: "n", label: "N", type: "integer", min: 1, max: 5, default: 6 }, "PARAM_DEFAULT_INVALID"],
    ["an integer default that is text", { key: "n", label: "N", type: "integer", min: 1, max: 5, default: "3" }, "PARAM_DEFAULT_INVALID"],
    ["a string default of 257 characters", { key: "s", label: "S", type: "string", default: "x".repeat(257) }, "PARAM_DEFAULT_INVALID"],
    ["a string default with a placeholder", { key: "s", label: "S", type: "string", default: "a${b}" }, "PARAM_DEFAULT_INVALID"],
    ["a string default with '$$'", { key: "s", label: "S", type: "string", default: "a$$b" }, "PARAM_DEFAULT_INVALID"],
    ["a string default with a line break", { key: "s", label: "S", type: "string", default: "a\nb" }, "PARAM_DEFAULT_INVALID"],
    ["a string with options", { key: "s", label: "S", type: "string", default: "a", options: ["a"] }, "KEY_UNKNOWN"],
    ["a boolean default that is text", { key: "b", label: "B", type: "boolean", default: "true" }, "PARAM_DEFAULT_INVALID"],
    ["a size with a 'B' suffix", { key: "z", label: "Z", type: "size", default: "64MB" }, "PARAM_DEFAULT_INVALID"],
    ["a size chosen by the customer", { key: "z", label: "Z", type: "size", default: "64M", customer: true }, "PARAM_CUSTOMER_NOT_ALLOWED"],
    ["a parameter without default", { key: "b", label: "B", type: "boolean" }, "PARAM_DEFAULT_MISSING"],
    ["a description (not in the spec)", { key: "b", label: "B", type: "boolean", default: true, description: "x" }, "KEY_UNKNOWN"],
    ["an upper-case key", { key: "Php_Version", label: "B", type: "boolean", default: true }, "PARAM_KEY_INVALID"],
    ["a reserved 'hp_' key", { key: "hp_x", label: "B", type: "boolean", default: true }, "PARAM_KEY_INVALID"],
    ["a key longer than 32", { key: "a".repeat(33), label: "B", type: "boolean", default: true }, "PARAM_KEY_INVALID"],
    ["a duplicate key", { key: "php_version", label: "B", type: "boolean", default: true }, "PARAM_KEY_DUPLICATE"],
    ["an unknown type", { key: "b", label: "B", type: "float", default: 1 }, "PARAM_TYPE_INVALID"],
    ["a label of 81 characters", { key: "b", label: "L".repeat(81), type: "boolean", default: true }, "PARAM_LABEL_INVALID"],
    ["a label with a control character", { key: "b", label: "a\u0007b", type: "boolean", default: true }, "PARAM_LABEL_INVALID"],
    ["a missing label", { key: "b", type: "boolean", default: true }, "PARAM_LABEL_INVALID"],
    ["a customer flag that is text", { key: "b", label: "B", type: "boolean", default: true, customer: "yes" }, "TYPE_MISMATCH"],
  ])("refuses %s", (_name, parameter, code) => {
    expect(codesOf(withParameter(parameter))).toContain(code);
  });

  it("refuses nine customer parameters and seventeen parameters", () => {
    const customers = Array.from({ length: 8 }, (_, i) => ({ key: `flag${i}`, label: "F", type: "boolean", default: true, customer: true }));
    expect(specOf(build([["x-hp-parameters"], [phpParameter(), ...customers.slice(0, 7)]])).parameters).toHaveLength(8);
    expect(codesOf(build([["x-hp-parameters"], [phpParameter(), ...customers]]))).toEqual(["PARAM_CUSTOMER_NOT_ALLOWED"]);
    const seventeen = Array.from({ length: 16 }, (_, i) => ({ key: `flag${i}`, label: "F", type: "boolean", default: true }));
    expect(codesOf(build([["x-hp-parameters"], [phpParameter(), ...seventeen]]))).toEqual(["PARAM_TOO_MANY"]);
  });

  it("always fills the default", () => {
    for (const parameter of specOf(withParameter({ key: "b", label: "B", type: "boolean", default: true })).parameters) {
      expect(parameter.default).not.toBeUndefined();
    }
  });
});

describe("the php_version parameter", () => {
  it.each<[string, Record<string, unknown> | typeof REMOVE, string]>([
    ["missing", REMOVE, "PHP_PARAM_MISSING"],
    ["a string", phpParameter({ type: "string", options: undefined, default: "8.4" }), "PHP_PARAM_INVALID"],
    ["not chosen by the customer", phpParameter({ customer: false }), "PHP_PARAM_INVALID"],
    ["with customer left out", phpParameter({ customer: undefined }), "PHP_PARAM_INVALID"],
    ["with a PHP 7.4 option", phpParameter({ options: ["7.4", "8.4"] }), "PHP_VERSION_UNSUPPORTED"],
    ["with a PHP 8.6 option", phpParameter({ options: ["8.4", "8.6"], default: "8.4" }), "PHP_VERSION_UNSUPPORTED"],
    ["with no options", phpParameter({ options: [], default: "8.4" }), "PARAM_OPTIONS_INVALID"],
  ])("refuses it when %s", (_name, parameter, code) => {
    const doc = parameter === REMOVE ? build([["x-hp-parameters"], REMOVE]) : build([["x-hp-parameters"], [parameter]]);
    expect(codesOf(doc)).toContain(code);
  });

  it("accepts a subset of the supported versions", () => {
    expect(specOf(build([["x-hp-parameters"], [phpParameter({ options: ["8.4"] })]])).parameters[0]?.options).toEqual(["8.4"]);
  });
});

describe("the limits", () => {
  const limits = (cpus: unknown, memory: unknown): unknown =>
    build([inService("deploy", "resources", "limits"), { cpus, memory }]);

  it.each<[unknown, number]>([["0.1", 100], ["64", 64000], [2, 2000], ["1.0", 1000], ["0.333", 333], ["1.5", 1500]])("reads cpus %j as %i milli", (cpus, milli) => {
    expect(specOf(limits(cpus, "512M")).service.limits?.cpuMilli).toBe(milli);
  });

  it.each<[unknown, string]>([
    ["0.05", "LIMIT_CPU_RANGE"],
    ["64.001", "LIMIT_CPU_RANGE"],
    ["65", "LIMIT_CPU_RANGE"],
    [0, "LIMIT_CPU_RANGE"],
    ["1.2345", "LIMIT_CPU_FORMAT"],
    ["1e1", "LIMIT_CPU_FORMAT"],
    ["-1", "LIMIT_CPU_FORMAT"],
    ["abc", "LIMIT_CPU_FORMAT"],
    [true, "TYPE_MISMATCH"],
  ])("refuses cpus %j", (cpus, code) => {
    expect(codesOf(limits(cpus, "512M"))).toEqual([code]);
  });

  it.each<[unknown, string]>([["128M", "134217728"], ["64G", "68719476736"], [134217728, "134217728"], ["1gb", "1073741824"], ["512m", "536870912"], ["1048576k", "1073741824"], ["134217728b", "134217728"]])(
    "reads memory %j as %s bytes",
    (memory, bytes) => {
      expect(specOf(limits("1", memory)).service.limits?.memoryBytes).toBe(bytes);
    },
  );

  it.each<[unknown, string]>([
    ["127M", "LIMIT_MEMORY_RANGE"],
    ["64M", "LIMIT_MEMORY_RANGE"],
    ["65G", "LIMIT_MEMORY_RANGE"],
    [68719476737, "LIMIT_MEMORY_RANGE"],
    [0, "LIMIT_MEMORY_FORMAT"],
    ["1.5G", "LIMIT_MEMORY_FORMAT"],
    ["lots", "LIMIT_MEMORY_FORMAT"],
    ["-1M", "LIMIT_MEMORY_FORMAT"],
    [null, "TYPE_MISMATCH"],
  ])("refuses memory %j", (memory, code) => {
    expect(codesOf(limits("1", memory))).toEqual([code]);
  });

  it("needs both values once deploy is present", () => {
    expect(codesOf(build([inService("deploy", "resources", "limits"), { cpus: "1" }]))).toEqual(["LIMIT_INCOMPLETE"]);
    expect(codesOf(build([inService("deploy", "resources", "limits"), { memory: "512M" }]))).toEqual(["LIMIT_INCOMPLETE"]);
    expect(codesOf(build([inService("deploy"), {}]))).toEqual(["LIMIT_INCOMPLETE"]);
    expect(codesOf(build([inService("deploy"), { resources: {} }]))).toEqual(["LIMIT_INCOMPLETE"]);
  });

  it("stores null limits when there is no deploy block, so the module default applies", () => {
    expect(specOf(build([inService("deploy"), REMOVE])).service.limits).toBeNull();
  });
});

describe("x-hp-php", () => {
  const php = (settings: unknown, ...more: Edit[]): unknown => build([["x-hp-php"], settings], ...more);

  it("stores the settings sorted by key and turns numbers into text", () => {
    const spec = specOf(php({ upload_max_filesize: "64M", post_max_size: "128M", max_execution_time: 300, memory_limit: "256M" }));
    expect(spec.php).toEqual([
      { key: "max_execution_time", value: "300" },
      { key: "memory_limit", value: "256M" },
      { key: "post_max_size", value: "128M" },
      { key: "upload_max_filesize", value: "64M" },
    ]);
  });

  it("stores null when absent", () => {
    expect(specOf(build()).php).toBeNull();
  });

  it.each<[string, unknown, string]>([
    ["an unknown directive", { disable_functions: "exec" }, "PHP_KEY_UNKNOWN"],
    ["-1", { memory_limit: -1 }, "PHP_VALUE_INVALID"],
    ["a 'B' suffix", { upload_max_filesize: "64MB" }, "PHP_VALUE_INVALID"],
    ["a fraction", { memory_limit: "1.5G" }, "PHP_VALUE_INVALID"],
    ["a lower-case unit", { post_max_size: "64m" }, "PHP_VALUE_INVALID"],
    ["a value beyond the limit", { max_execution_time: 3601 }, "PHP_VALUE_INVALID"],
    ["an empty block", {}, "PHP_EMPTY"],
    ["a list", ["memory_limit"], "TYPE_MISMATCH"],
    ["a boolean", { memory_limit: true }, "TYPE_MISMATCH"],
  ])("refuses %s", (_name, settings, code) => {
    expect(codesOf(php(settings))).toContain(code);
  });

  it("needs post_max_size at least upload_max_filesize, using PHP's defaults for the side not set", () => {
    expect(codesOf(php({ post_max_size: "8M", upload_max_filesize: "64M" }))).toEqual(["PHP_POST_BELOW_UPLOAD"]);
    expect(codesOf(php({ upload_max_filesize: "64M" }))).toEqual(["PHP_POST_BELOW_UPLOAD"]);
    expect(codesOf(php({ post_max_size: "1M" }))).toEqual(["PHP_POST_BELOW_UPLOAD"]);
    expect(specOf(php({ post_max_size: "64M", upload_max_filesize: "64M" })).php).toHaveLength(2);
    expect(specOf(php({ upload_max_filesize: "8M" })).php).toHaveLength(1);
  });

  it("keeps memory_limit within the container memory, deploy or module default", () => {
    expect(codesOf(php({ memory_limit: "2G" }))).toEqual(["PHP_MEMORY_EXCEEDS_CONTAINER"]);
    expect(specOf(php({ memory_limit: "512M" })).php).toHaveLength(1);
    const noDeploy = (memory: string) => php({ memory_limit: memory }, [inService("deploy"), REMOVE]);
    const defaultMemory = BigInt(SITE_TEMPLATE_MODULES.wordpress.defaultLimits.memoryBytes) / 1024n ** 2n;
    expect(specOf(noDeploy(`${defaultMemory}M`)).php).toHaveLength(1);
    expect(codesOf(noDeploy(`${defaultMemory + 1n}M`))).toEqual(["PHP_MEMORY_EXCEEDS_CONTAINER"]);
  });

  it("does not compare with the container memory when the limits are invalid", () => {
    expect(codesOf(php({ memory_limit: "2G" }, [inService("deploy", "resources", "limits", "memory"), "lots"]))).toEqual(["LIMIT_MEMORY_FORMAT"]);
  });
});

describe("positions", () => {
  const SOURCE = [
    "x-hp-module: wordpress", // 1
    "x-hp-parameters:", // 2
    "  - key: php_version", // 3
    "    label: Versione PHP", // 4
    "    type: enum", // 5
    '    options: ["8.3", "8.4"]', // 6
    '    default: "8.4"', // 7
    "    customer: true", // 8
    "services:", // 9
    "  app:", // 10
    "    image: ${HP_MODULE_IMAGE}", // 11
    "    privileged: true", // 12
    "    environment:", // 13
    "      DB_PASSWORD: x", // 14
    '      WP_DEBUG: "${nope}"', // 15
    "    volumes:", // 16
    "      - html:/var/www/html", // 17
    "      - /etc:/etc", // 18
    "volumes:", // 19
    "  html: {}", // 20
    "",
  ].join("\n");

  function issues(): SiteTemplateIssue[] {
    const result = validateSiteTemplateSource(SOURCE, "wordpress");
    if (result.ok) throw new Error("expected errors");
    return result.errors;
  }
  const at = (code: string): SiteTemplateIssue => {
    const found = issues().find((issue) => issue.code === code);
    if (!found) throw new Error(`no ${code} issue`);
    return found;
  };

  it("points a refused key at the key and a bad value at the value", () => {
    expect(at("KEY_FORBIDDEN_SECURITY")).toMatchObject({ path: "services.app.privileged", line: 12, column: 5 });
    expect(at("ENV_NAME_SECRET_LIKE")).toMatchObject({ path: "services.app.environment.DB_PASSWORD", line: 14, column: 7 });
    expect(at("INTERP_UNKNOWN_VARIABLE")).toMatchObject({ path: "services.app.environment.WP_DEBUG", line: 15, column: 17 });
    expect(at("VOLUME_HOST_PATH")).toMatchObject({ path: "services.app.volumes[1]", line: 18 });
  });

  it("returns the issues sorted by position", () => {
    const lines = issues().map((issue) => issue.line ?? 0);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  it("omits line and column when no locator is given", () => {
    for (const error of errorsOf(build([inService("privileged"), true]))) {
      expect(error).not.toHaveProperty("line");
      expect(error).not.toHaveProperty("column");
    }
  });

  it("points a missing key at the parent", () => {
    const result = validateSiteTemplateSource(SOURCE.replace("x-hp-module: wordpress\n", ""), "wordpress");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContainEqual(expect.objectContaining({ code: "MODULE_MISSING", path: "" }));
  });
});

describe("ordering and the cap", () => {
  it("returns at most 50 issues, the first ones by position", () => {
    const names = Array.from({ length: 60 }, (_, i) => `      bad${i}: x`);
    const source = BASE_SOURCE.replace("    volumes:\n", `    environment:\n${names.join("\n")}\n    volumes:\n`);
    const result = validateSiteTemplateSource(source, "wordpress");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(SITE_TEMPLATE_MAX_ISSUES).toBe(50);
    expect(result.errors).toHaveLength(50);
    const lines = result.errors.map((error) => error.line ?? 0);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(new Set(result.errors.map((error) => error.code))).toEqual(new Set(["ENV_NAME_INVALID"]));
  });

  it("repeats nothing: one issue per path, code and message", () => {
    const errors = errorsOf(build([inService("environment"), { a: "1", b: "2" }]));
    expect(new Set(errors.map((error) => `${error.path}|${error.code}|${error.message}`)).size).toBe(errors.length);
  });
});

describe("the module and the document", () => {
  it("compares x-hp-module with the module asked for", () => {
    expect(codesOf(build([["x-hp-module"], "other"]))).toEqual(["MODULE_MISMATCH"]);
    expect(codesOf(build([["x-hp-module"], REMOVE]))).toEqual(["MODULE_MISSING"]);
    expect(codesOf(build([["x-hp-module"], 3]))).toEqual(["TYPE_MISMATCH"]);
  });

  it.each<[string, unknown]>([["a list", []], ["a string", "x"], ["null", null], ["a number", 3]])("refuses %s as the document", (_name, value) => {
    const result = validateSiteTemplate(value, "wordpress");
    expect(result).toEqual({ ok: false, errors: [expect.objectContaining({ code: "DOCUMENT_NOT_MAPPING", path: "" })] });
  });

  it("refuses an empty or comment-only source as a document that is not a mapping", () => {
    for (const source of ["", "# nothing\n", "   \n"]) {
      expect(validateSiteTemplateSource(source, "wordpress")).toEqual({ ok: false, errors: [expect.objectContaining({ code: "DOCUMENT_NOT_MAPPING" })] });
    }
  });
});

describe("validateSiteTemplateSource", () => {
  it.each<[string, string, string]>([
    ["an anchor", "a: &x 1\n", "ANCHOR"],
    ["a duplicate key", "a: 1\na: 2\n", "DUPLICATE_KEY"],
    ["a source over 64 KiB", `# ${"x".repeat(65_536)}\n`, "TOO_LARGE"],
    ["a tab indent", "services:\n\tapp: 1\n", "TAB_INDENT"],
  ])("turns %s into one issue with the YAML code, no path and a position", (_name, source, code) => {
    const result = validateSiteTemplateSource(source, "wordpress");
    expect(result).toEqual({ ok: false, errors: [{ path: "", line: expect.any(Number), column: expect.any(Number), code, message: expect.any(String) }] });
  });

  it("knows every YAML error code as an issue code", () => {
    expect(SITE_TEMPLATE_ISSUE_CODES).toContain("ANCHOR");
    expect(SITE_TEMPLATE_ISSUE_CODES).toContain("SPEC_INTERNAL");
    expect(new Set(SITE_TEMPLATE_ISSUE_CODES).size).toBe(SITE_TEMPLATE_ISSUE_CODES.length);
  });
});

describe("contract with the interpolation helpers", () => {
  it("keeps the worst-case lengths in step with what the platform fills in", () => {
    expect(HP_VARIABLE_MAX_LENGTH).toEqual({ HP_SITE_ID: 128, HP_SITE_DOMAIN: 253, HP_SITE_URL: 2048 });
  });
});

describe("robustness", () => {
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }
  const WORDS = ["__proto__", "constructor", "services", "image", "x-hp-module", "wordpress", "${x}", "privileged", "environment", "html:/etc", "", "80"];

  function randomValue(next: () => number, depth: number): unknown {
    const kind = Math.floor(next() * (depth > 3 ? 5 : 7));
    switch (kind) {
      case 0: return null;
      case 1: return next() < 0.5;
      case 2: return Math.floor(next() * 200) - 20;
      case 3: case 4: return WORDS[Math.floor(next() * WORDS.length)];
      case 5: return Array.from({ length: Math.floor(next() * 4) }, () => randomValue(next, depth + 1));
      default: return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, () => [WORDS[Math.floor(next() * WORDS.length)]!, randomValue(next, depth + 1)]));
    }
  }

  function mutate(next: () => number, node: unknown, depth: number): unknown {
    if (typeof node !== "object" || node === null || next() < 0.15 || depth > 6) return next() < 0.5 ? randomValue(next, 2) : node;
    if (Array.isArray(node)) return node.map((item) => mutate(next, item, depth + 1));
    return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, mutate(next, item, depth + 1)]));
  }

  it("never throws and never falls into an internal error on random and mutated documents", () => {
    const next = random(20260421);
    for (let i = 0; i < 400; i++) {
      const doc = i % 2 === 0 ? randomValue(next, 0) : mutate(next, BASE, 0);
      const result = validateSiteTemplate(doc, "wordpress");
      if (result.ok) {
        expect(SiteTemplateSpecSchema.safeParse(result.spec).success).toBe(true);
      } else {
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors.length).toBeLessThanOrEqual(SITE_TEMPLATE_MAX_ISSUES);
        expect(result.errors.map((error) => error.code)).not.toContain("SPEC_INTERNAL");
      }
    }
  });

  it("is deterministic", () => {
    const next = random(7);
    const doc = mutate(next, BASE, 0);
    expect(validateSiteTemplate(doc, "wordpress")).toEqual(validateSiteTemplate(doc, "wordpress"));
  });

  it("reports an unknown module as an internal issue instead of throwing", () => {
    expect(validateSiteTemplate(build(), "drupal" as never)).toEqual({ ok: false, errors: [expect.objectContaining({ code: "SPEC_INTERNAL" })] });
  });
});
