// Adversarial cases on top of site-template-parameters/render/dto.test.ts: values that try to inject a
// variable, coerce a type, borrow another audience's parameter or leak admin data.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_PHP_VERSIONS, resolveWordpressImage } from "../src/site-runtime.js";
import { BUILT_IN_WORDPRESS_SPEC } from "../src/site-templates/built-in.js";
import { toCustomerSiteTypeDto } from "../src/site-templates/dto.js";
import {
  type ResolveSiteTemplateParametersResult,
  resolveSiteTemplateParameters,
  restoreSiteTemplateParameterMap,
  toStoredSiteTemplateParameters,
} from "../src/site-templates/parameters.js";
import {
  SITE_TEMPLATE_MAGIC_VARIABLES,
  SiteTemplateRenderError,
  renderSiteTemplate,
  toSiteTemplatePreview,
  type SiteTemplateRenderContext,
} from "../src/site-templates/render.js";
import {
  SiteTemplateParameterSchema,
  SiteTemplateSpecSchema,
  type SiteTemplateParameterEntry,
  type SiteTemplateSpec,
} from "../src/site-templates/spec.js";

const CONTEXT: SiteTemplateRenderContext = { siteId: "site_1", siteDomain: "shop.example.com", siteUrl: "https://shop.example.com" };
const PHP = { key: "php_version", label: "PHP", type: "enum", options: ["8.3", "8.4", "8.5"], default: "8.4", customer: true };

function specOf(parameters: unknown[], service: Record<string, unknown> = {}, php: unknown = null): SiteTemplateSpec {
  return SiteTemplateSpecSchema.parse({
    specVersion: 1,
    module: "wordpress",
    parameters,
    service: {
      name: "app",
      image: "${HP_MODULE_IMAGE}",
      environment: [],
      volumes: [{ volume: "html", containerPath: "/var/www/html" }],
      expose: [80],
      limits: null,
      ...service,
    },
    php,
  });
}

const entry = (key: string, value: unknown) => ({ key, value }) as SiteTemplateParameterEntry;
const SPEC = specOf([
  PHP,
  { key: "mode", label: "Mode", type: "enum", options: ["fast", "safe"], default: "safe", customer: true },
  { key: "workers", label: "Workers", type: "integer", min: 1, max: 8, default: 2, customer: true },
  { key: "title", label: "Title", type: "string", customer: true },
  { key: "debug", label: "Debug", type: "boolean", default: false, customer: false },
  { key: "upload", label: "Upload", type: "size", default: "64M", customer: false },
]);
const FILL = [entry("title", "t")];
const resolve = (items: SiteTemplateParameterEntry[], audience: "admin" | "customer" = "admin", phpVersion?: string | null) =>
  resolveSiteTemplateParameters(SPEC, [...FILL.filter((e) => !items.some((i) => i.key === e.key)), ...items], { audience, phpVersion });
const issuesOf = (result: ResolveSiteTemplateParametersResult): [string, string][] => {
  if (result.ok) throw new Error(`expected issues, got ${JSON.stringify(result.values)}`);
  return result.issues.map((issue) => [issue.field, issue.reason]);
};
const renderError = (fn: () => unknown): SiteTemplateRenderError => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SiteTemplateRenderError);
    return error as SiteTemplateRenderError;
  }
  throw new Error("expected a SiteTemplateRenderError");
};

describe("parameter values cannot carry an interpolation", () => {
  it("refuses every string that holds '${', whatever follows", () => {
    for (const value of ["${HP_SITE_ID}", "${title}", "x${", "$${HP_SITE_URL}", "${HP_MODULE_IMAGE}", "a${}b"]) {
      expect(issuesOf(resolve([entry("title", value)])), value).toEqual([["parameters.title", "invalid_characters"]]);
    }
  });

  it("refuses control characters beyond \\n and NUL: CR, TAB, DEL and the C1 range", () => {
    for (const value of ["a\rb", "a\tb", "a\u007fb", "a\u0085b", "a\u009fb", "\u0000"]) {
      expect(issuesOf(resolve([entry("title", value)])), JSON.stringify(value)).toEqual([["parameters.title", "invalid_characters"]]);
    }
  });

  it("refuses a very long string by length without scanning it", () => {
    expect(issuesOf(resolve([entry("title", "x".repeat(1_000_000))]))).toEqual([["parameters.title", "too_long"]]);
  });

  it("does not let an enum or a size carry a variable", () => {
    expect(issuesOf(resolve([entry("mode", "${HP_SITE_ID}")]))).toEqual([["parameters.mode", "not_in_options"]]);
    expect(issuesOf(resolve([entry("upload", "${HP_SITE_ID}")]))).toEqual([["parameters.upload", "invalid_type"]]);
  });

  it("substitutes a value literally in the environment and the image, never a second time", () => {
    const spec = specOf(
      [PHP, { key: "a", label: "A", type: "string", customer: true }, { key: "b", label: "B", type: "string", customer: true }],
      { image: "wordpress:${a}", environment: [{ name: "A", value: "${a}" }, { name: "SITE", value: "${HP_SITE_DOMAIN}" }, { name: "TWICE", value: "${a}${b}" }] },
    );
    const context = { ...CONTEXT, siteDomain: "${b}.example.com" };
    const { configuration } = renderSiteTemplate(spec, { php_version: "8.4", a: "${b}", b: "$${HP_SITE_ID}" }, context);
    expect(configuration).toMatchObject({ A: "${b}", SITE: "${b}.example.com", TWICE: "${b}$${HP_SITE_ID}", image: "wordpress:${b}" });
    // "$$" in a substituted value is not unescaped: only the template text is.
    expect(renderSiteTemplate(spec, { php_version: "8.4", a: "$$", b: "$$" }, CONTEXT).configuration.A).toBe("$$");
  });

  it("does not let a parameter key shadow a magic variable", () => {
    for (const name of SITE_TEMPLATE_MAGIC_VARIABLES) {
      expect(SiteTemplateParameterSchema.safeParse({ key: name, label: "x", type: "boolean", customer: true }).success, name).toBe(false);
    }
  });

  it("drops a stored value that carries '${' or left the range of a newer spec", () => {
    const stored = [
      { key: "title", value: "${HP_SITE_ID}" },
      { key: "workers", value: 99 },
      { key: "mode", value: "fast" },
    ];
    expect(restoreSiteTemplateParameterMap(SPEC, stored, "8.5")).toMatchObject({ title: "sample", workers: 2, mode: "fast", php_version: "8.5" });
  });
});

describe("entries: duplicates, unknown keys, audience", () => {
  it("reports every repeat of a key after the first one", () => {
    expect(issuesOf(resolve([entry("mode", "fast"), entry("mode", "safe"), entry("mode", "fast")]))).toEqual([
      ["parameters.mode", "duplicate"],
      ["parameters.mode", "duplicate"],
    ]);
    expect(issuesOf(resolve([entry("php_version", "8.4"), entry("php_version", "8.4")]))).toEqual([
      ["parameters.php_version", "reserved"],
      ["parameters.php_version", "reserved"],
    ]);
  });

  it("does not call a key required when its first entry was invalid, nor when it is repeated", () => {
    expect(issuesOf(resolve([entry("title", 5), entry("title", "ok")]))).toEqual([
      ["parameters.title", "invalid_type"],
      ["parameters.title", "duplicate"],
    ]);
  });

  it("matches keys exactly: case, whitespace and a huge key are all unknown", () => {
    const huge = "k".repeat(10_000);
    expect(issuesOf(resolve([entry("TITLE", "x"), entry(" title", "x"), entry("title ", "x"), entry(huge, 1)]))).toEqual([
      ["parameters.TITLE", "unknown"],
      ["parameters. title", "unknown"],
      ["parameters.title ", "unknown"],
      [`parameters.${huge}`, "unknown"],
    ]);
  });

  it("refuses an admin-only parameter for a customer even with its default value or a wrong type", () => {
    expect(issuesOf(resolve([entry("debug", false)], "customer"))).toEqual([["parameters.debug", "not_customer"]]);
    expect(issuesOf(resolve([entry("upload", "64M")], "customer"))).toEqual([["parameters.upload", "not_customer"]]);
    expect(issuesOf(resolve([entry("debug", "not-a-boolean")], "customer"))).toEqual([["parameters.debug", "not_customer"]]);
  });

  it("reports an admin-only parameter without a default as not_customer when sent and as required when not", () => {
    const spec = specOf([PHP, { key: "token_name", label: "Token", type: "string", customer: false }]);
    const run = (items: SiteTemplateParameterEntry[]) => resolveSiteTemplateParameters(spec, items, { audience: "customer" });
    expect(issuesOf(run([entry("token_name", "n")]))).toEqual([["parameters.token_name", "not_customer"]]);
    expect(issuesOf(run([]))).toEqual([["parameters.token_name", "required"]]);
  });

  it("keeps a customer's refused admin-only value out of the stored parameters", () => {
    expect(resolve([entry("debug", true)], "customer").ok).toBe(false);
    const ok = resolve([], "customer");
    expect(ok.ok && ok.values.debug).toBe(false);
  });
});

describe("type coercion is refused", () => {
  const problem = (key: string, value: unknown) => issuesOf(resolve([entry(key, value)]))[0]?.[1];

  it("takes an integer only as a JSON number", () => {
    for (const value of ["1e3", " 5 ", "5", "0x5", "", "five", Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, 4.0000001]) {
      expect(problem("workers", value), String(value)).toBe("invalid_type");
    }
    expect(problem("workers", 1e3)).toBe("out_of_range");
    expect(problem("workers", Number.MIN_SAFE_INTEGER)).toBe("out_of_range");
  });

  it("applies a minimum alone, a maximum alone, and no bound at all", () => {
    const spec = specOf([
      { key: "lo", label: "Lo", type: "integer", min: 0, customer: true },
      { key: "hi", label: "Hi", type: "integer", max: 0, customer: true },
      { key: "any", label: "Any", type: "integer", customer: true },
    ]);
    const run = (key: string, value: number) =>
      resolveSiteTemplateParameters(spec, [entry("lo", 0), entry("hi", 0), entry("any", 0)].map((e) => (e.key === key ? entry(key, value) : e)), {
        audience: "admin",
      });
    expect(issuesOf(run("lo", -1))).toEqual([["parameters.lo", "out_of_range"]]);
    expect(issuesOf(run("hi", 1))).toEqual([["parameters.hi", "out_of_range"]]);
    expect(run("lo", Number.MAX_SAFE_INTEGER).ok).toBe(true);
    expect(run("any", Number.MIN_SAFE_INTEGER).ok).toBe(true);
    expect(issuesOf(run("any", 2 ** 53))).toEqual([["parameters.any", "invalid_type"]]);
  });

  it("takes a boolean only as true or false", () => {
    for (const value of ["true", "TRUE", "false", "yes", "on", "1", "0", 0, 1, null]) {
      expect(problem("debug", value), String(value)).toBe("invalid_type");
    }
  });

  it("takes an enum option byte for byte, as a string", () => {
    for (const value of [" fast", "fast ", "FAST", "fast\n", "fast\u0000", "fast​"]) {
      expect(problem("mode", value), JSON.stringify(value)).toBe("not_in_options");
    }
    for (const value of [8.4, 8, true, ["fast"]]) expect(problem("mode", value), String(value)).toBe("invalid_type");
  });

  it("takes a size only in the strict K/M/G shape", () => {
    for (const value of [" 64M", "64M ", "64M\n", "٦٤M", "６４M", "1e3M", "0x10M", "+5M", "05M", "5 M", "99999g", "100000K", "5MB"]) {
      expect(problem("upload", value), JSON.stringify(value)).toBe("invalid_type");
    }
  });

  it("refuses a PHP version that is empty, padded or not a string", () => {
    expect(issuesOf(resolve([], "admin", ""))).toEqual([["phpVersion", "not_in_options"]]);
    expect(issuesOf(resolve([], "admin", "8.4 "))).toEqual([["phpVersion", "not_in_options"]]);
    expect(issuesOf(resolve([], "admin", "8.4\n"))).toEqual([["phpVersion", "not_in_options"]]);
    const ok = resolve([], "admin", null);
    expect(ok.ok && ok.values.php_version).toBe("8.4");
  });
});

describe("a PHP version the module does not support", () => {
  // The options come from the administrator; the policy engine keeps them inside the module, the renderer is the second wall.
  const wide = specOf([{ ...PHP, options: ["8.2", "8.4"], default: "8.4" }]);

  it("passes the parameter check when it is an option but is refused by the renderer", () => {
    const result = resolveSiteTemplateParameters(wide, [], { audience: "customer", phpVersion: "8.2" });
    expect(result.ok && result.values.php_version).toBe("8.2");
    expect(renderError(() => renderSiteTemplate(wide, { php_version: "8.2" }, CONTEXT)).code).toBe("invalid_php_version");
    expect(renderError(() => toSiteTemplatePreview(specOf([{ ...PHP, options: ["8.2"], default: "8.2" }]))).code).toBe("invalid_php_version");
  });

  it("is refused as a custom image variable too, and never reaches a module image", () => {
    const custom = specOf([{ ...PHP, options: ["8.2"], default: "8.2" }], { image: "wordpress:7.1.4-php${php_version}-apache" });
    expect(renderError(() => renderSiteTemplate(custom, { php_version: "8.2" }, CONTEXT)).code).toBe("invalid_php_version");
    for (const bad of ["8.4 ", "08.4", "8.4.0", "constructor", ""]) {
      expect(renderError(() => renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, { php_version: bad }, CONTEXT)).code, bad).toBe("invalid_php_version");
    }
  });
});

describe("what the render output holds", () => {
  it("holds a parameter value only where the environment names it, and no secret reference", () => {
    const spec = specOf([PHP, { key: "password", label: "P", type: "string", customer: true }, { key: "shown", label: "S", type: "string", customer: true }], {
      environment: [{ name: "SHOWN", value: "${shown}" }],
    });
    const rendered = renderSiteTemplate(spec, { php_version: "8.4", password: "hunter2", shown: "visible" }, CONTEXT);
    expect(JSON.stringify(rendered)).not.toContain("hunter2");
    expect(Object.keys(rendered.configuration).sort()).toEqual(["SHOWN", "exposeHttp", "image", "internalPort", "siteMail", "volumeMounts"]);
    expect(rendered.secretRefs).toEqual({});
  });

  it("never invents the platform secret keys", () => {
    const text = JSON.stringify(renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, { php_version: "8.4" }, CONTEXT));
    expect(text).not.toMatch(/SITE_DB_PASSWORD|WP_ADMIN_PASSWORD_INITIAL|password/i);
  });

  it("caps an environment value and the image at 4096 characters after interpolation", () => {
    const a = "x".repeat(256);
    const env = (value: string) => specOf([PHP, { key: "a", label: "A", type: "string", customer: true }], { environment: [{ name: "BIG", value }] });
    const sixteen = "${a}".repeat(16);
    expect(renderSiteTemplate(env(sixteen), { php_version: "8.4", a }, CONTEXT).configuration.BIG).toHaveLength(4096);
    expect(renderError(() => renderSiteTemplate(env(`${sixteen}y`), { php_version: "8.4", a }, CONTEXT)).code).toBe("value_too_long");
    const image = specOf([PHP, { key: "a", label: "A", type: "string", customer: true }], { image: "${a}".repeat(60) });
    expect(renderError(() => renderSiteTemplate(image, { php_version: "8.4", a }, CONTEXT)).code).toBe("value_too_long");
  });

  it("does not echo a refused value in the error message", () => {
    const spec = specOf([PHP, { key: "a", label: "A", type: "string", customer: true }], { environment: [{ name: "BIG", value: "${a}".repeat(20) }] });
    const error = renderError(() => renderSiteTemplate(spec, { php_version: "8.4", a: "S3CR3T".repeat(40) }, CONTEXT));
    expect(error.code).toBe("value_too_long");
    expect(error.message).not.toContain("S3CR3T");
  });
});

describe("toSiteTemplatePreview never leaks", () => {
  const rich = specOf(
    [PHP, { key: "title", label: "Title", type: "string", default: "T", customer: true }, { key: "hidden", label: "Hidden", type: "string", customer: false }],
    {
      environment: [{ name: "WP_HOME", value: "${HP_SITE_URL}" }, { name: "ID", value: "${HP_SITE_ID}" }],
      limits: { cpuMilli: 2000, memoryBytes: "1073741824" },
    },
    [{ key: "memory_limit", value: "256M" }],
  );

  it("renders the example site, whatever the real values carry", () => {
    const preview = toSiteTemplatePreview(rich, { php_version: "8.4", title: "T", hidden: "h", stray: "s3cret", __proto__: "x" } as never);
    expect(preview.environment).toEqual([
      { name: "WP_HOME", value: "https://example.com" },
      { name: "ID", value: "site_preview" },
    ]);
    expect(JSON.stringify(preview)).not.toContain("s3cret");
    expect(preview.parameters.map((p) => p.key)).toEqual(["php_version", "title", "hidden"]);
  });

  it("has exactly the documented keys: no source, spec, configuration or secret references", () => {
    expect(Object.keys(toSiteTemplatePreview(rich)).sort()).toEqual([
      "environment", "exposeHttp", "image", "internalPort", "limits", "module", "parameters", "phpSettings", "volumes",
    ]);
    const text = JSON.stringify(toSiteTemplatePreview(rich));
    for (const word of ["configuration", "secretRefs", "source", "specVersion", "x-hp-"]) expect(text, word).not.toContain(word);
  });

  it("fails with a render error, not another exception, for a spec the renderer refuses", () => {
    expect(renderError(() => toSiteTemplatePreview(specOf([PHP], { environment: [{ name: "A", value: "${nope}" }] }))).code).toBe("unknown_variable");
  });
});

describe("toCustomerSiteTypeDto never exposes the admin side", () => {
  const spec = specOf(
    [
      PHP,
      { key: "greeting", label: "Greeting", type: "string", default: "hello", customer: true },
      { key: "internal_flag", label: "Admin Only Label", type: "enum", options: ["adminopt1", "adminopt2"], default: "adminopt1", customer: false },
      { key: "internal_cap", label: "Hidden Cap", type: "integer", min: 3, max: 777, default: 555, customer: false },
    ],
    {
      image: "wordpress:7.1.4-php${php_version}-apache",
      environment: [{ name: "ADMIN_ENV", value: "adminenvvalue" }],
      volumes: [{ volume: "adminvol", containerPath: "/admin/mount/path" }],
      limits: { cpuMilli: 4242, memoryBytes: "987654321" },
    },
    [{ key: "memory_limit", value: "999M" }],
  );
  const input = { id: "stpl_x", name: "Shop", description: "d", spec };

  it("has only the six documented keys and the customer parameters' own fields", () => {
    const dto = toCustomerSiteTypeDto(input);
    expect(Object.keys(dto).sort()).toEqual(["defaultPhpVersion", "description", "id", "module", "name", "parameters", "phpVersions"]);
    expect(dto.parameters).toEqual([{ key: "greeting", label: "Greeting", type: "string", default: "hello" }]);
  });

  it("carries no string of the image, environment, volumes, limits, php settings or admin-only parameters", () => {
    const text = JSON.stringify(toCustomerSiteTypeDto(input));
    for (const word of [
      "wordpress:7", "ADMIN_ENV", "adminenvvalue", "adminvol", "/admin/mount", "4242", "987654321", "999M", "memory_limit",
      "internal_flag", "Admin Only Label", "adminopt", "internal_cap", "Hidden Cap", "777", "555",
    ]) {
      expect(text, word).not.toContain(word);
    }
  });

  it("is a copy: changing the answer does not change the stored spec", () => {
    const before = structuredClone(spec);
    const dto = toCustomerSiteTypeDto(input);
    dto.phpVersions.push("9.9");
    dto.parameters.push({ key: "x", label: "x", type: "boolean" });
    expect(spec).toEqual(before);
  });

  it("offers no PHP version for a fixed php_version without a default", () => {
    const fixed = specOf([{ key: "php_version", label: "PHP", type: "enum", options: ["8.4"], customer: false }]);
    const dto = toCustomerSiteTypeDto({ ...input, spec: fixed });
    expect(dto.phpVersions).toEqual([]);
    expect(dto.defaultPhpVersion).toBeNull();
  });
});

describe("the built-in WordPress template equals today's WordPress", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../../../apps/api/test/fixtures/site-type-pins/spec-hash.json", import.meta.url), "utf8"),
  ) as { afterCreate: { hashOf: { config: unknown; resourceLimits: unknown; secretRefs: unknown } } };

  it("renders the frozen revision of the pins fixture for PHP 8.3", () => {
    const { config, resourceLimits, secretRefs } = fixture.afterCreate.hashOf;
    const rendered = renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, { php_version: "8.3" }, CONTEXT);
    expect(rendered.configuration).toEqual(config);
    expect(rendered.resourceLimits).toEqual(resourceLimits);
    expect(rendered.secretRefs).toEqual(secretRefs);
  });

  it("goes from an empty request to the legacy default PHP 8.4 and stores no parameter", () => {
    for (const audience of ["customer", "admin"] as const) {
      const result = resolveSiteTemplateParameters(BUILT_IN_WORDPRESS_SPEC, [], { audience });
      if (!result.ok) throw new Error("expected ok");
      expect(renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, result.values, CONTEXT).configuration.image).toBe(resolveWordpressImage("8.4"));
      expect(toStoredSiteTemplateParameters(BUILT_IN_WORDPRESS_SPEC, result.values)).toBeNull();
    }
  });

  it("lets both audiences choose every supported PHP version and nothing else", () => {
    for (const audience of ["customer", "admin"] as const) {
      for (const php of SUPPORTED_PHP_VERSIONS) {
        expect(resolveSiteTemplateParameters(BUILT_IN_WORDPRESS_SPEC, [], { audience, phpVersion: php }).ok, php).toBe(true);
      }
      expect(issuesOf(resolveSiteTemplateParameters(BUILT_IN_WORDPRESS_SPEC, [], { audience, phpVersion: "8.2" }))).toEqual([
        ["phpVersion", "not_in_options"],
      ]);
      expect(issuesOf(resolveSiteTemplateParameters(BUILT_IN_WORDPRESS_SPEC, [entry("memory_limit", "1G")], { audience }))).toEqual([
        ["parameters.memory_limit", "unknown"],
      ]);
    }
  });
});
