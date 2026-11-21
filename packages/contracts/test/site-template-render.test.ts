import { describe, expect, it } from "vitest";
import { findForbiddenPublicDtoKeys } from "../src/resources.js";
import { SUPPORTED_PHP_VERSIONS, resolveWordpressImage } from "../src/site-runtime.js";
import {
  BUILT_IN_TEMPLATE_BY_MODULE,
  BUILT_IN_VERSION_BY_MODULE,
  BUILT_IN_WORDPRESS_SOURCE,
  BUILT_IN_WORDPRESS_SPEC,
  BUILT_IN_WORDPRESS_TEMPLATE_ID,
  BUILT_IN_WORDPRESS_TEMPLATE_NAME,
  BUILT_IN_WORDPRESS_VERSION_ID,
} from "../src/site-templates/built-in.js";
import { SiteTemplatePreviewDtoSchema } from "../src/site-templates/dto.js";
import {
  MODULE_IMAGE_VARIABLE,
  SITE_TEMPLATE_MAGIC_VARIABLES,
  SITE_TEMPLATE_PREVIEW_CONTEXT,
  SiteTemplateRenderError,
  interpolateSiteTemplateValue,
  listSiteTemplateVariables,
  renderSiteTemplate,
  toSiteTemplatePreview,
  type SiteTemplateRenderContext,
} from "../src/site-templates/render.js";
import { SiteTemplateSpecSchema, type SiteTemplateParameterMap, type SiteTemplateSpec } from "../src/site-templates/spec.js";
import { SITE_TEMPLATE_MODULES } from "../src/site-templates/modules.js";

const CONTEXT: SiteTemplateRenderContext = { siteId: "site_1", siteDomain: "shop.example.com", siteUrl: "https://shop.example.com" };

function withService(service: Partial<SiteTemplateSpec["service"]>, rest: Partial<SiteTemplateSpec> = {}): SiteTemplateSpec {
  return { ...BUILT_IN_WORDPRESS_SPEC, ...rest, service: { ...BUILT_IN_WORDPRESS_SPEC.service, ...service } };
}

function renderError(fn: () => unknown): SiteTemplateRenderError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SiteTemplateRenderError);
    return error as SiteTemplateRenderError;
  }
  throw new Error("expected a SiteTemplateRenderError");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("listSiteTemplateVariables", () => {
  it("lists unique names in first-seen order", () => {
    expect(listSiteTemplateVariables("a${x}b${x}${Y_1}")).toEqual({ ok: true, names: ["x", "Y_1"] });
    expect(listSiteTemplateVariables("plain")).toEqual({ ok: true, names: [] });
    expect(listSiteTemplateVariables("")).toEqual({ ok: true, names: [] });
  });

  it("reads $$ as one literal dollar", () => {
    expect(listSiteTemplateVariables("$$")).toEqual({ ok: true, names: [] });
    expect(listSiteTemplateVariables("$${x}")).toEqual({ ok: true, names: [] });
    expect(listSiteTemplateVariables("$$$${a}")).toEqual({ ok: true, names: [] });
    expect(listSiteTemplateVariables("$$${a}")).toEqual({ ok: true, names: ["a"] });
  });

  it("refuses every other use of the dollar sign, with the offset of the dollar", () => {
    expect(listSiteTemplateVariables("$")).toEqual({ ok: false, offset: 0, reason: "lone_dollar" });
    expect(listSiteTemplateVariables("ab$x")).toEqual({ ok: false, offset: 2, reason: "lone_dollar" });
    expect(listSiteTemplateVariables("ab$")).toEqual({ ok: false, offset: 2, reason: "lone_dollar" });
    expect(listSiteTemplateVariables("${")).toEqual({ ok: false, offset: 0, reason: "unterminated" });
    expect(listSiteTemplateVariables("x${a")).toEqual({ ok: false, offset: 1, reason: "unterminated" });
    expect(listSiteTemplateVariables("${a-b}")).toEqual({ ok: false, offset: 0, reason: "bad_name" });
    expect(listSiteTemplateVariables("${}")).toEqual({ ok: false, offset: 0, reason: "bad_name" });
    expect(listSiteTemplateVariables("${1a}")).toEqual({ ok: false, offset: 0, reason: "bad_name" });
    expect(listSiteTemplateVariables("${a b}")).toEqual({ ok: false, offset: 0, reason: "bad_name" });
    expect(listSiteTemplateVariables("${a:-b}")).toEqual({ ok: false, offset: 0, reason: "bad_name" });
    expect(listSiteTemplateVariables("ok ${a} $b")).toEqual({ ok: false, offset: 8, reason: "lone_dollar" });
  });
});

describe("interpolateSiteTemplateValue", () => {
  const vars = new Map([
    ["a", "1"],
    ["x", "${y}"],
    ["y", "boom"],
  ]);

  it("substitutes, unescapes $$ and does not expand substituted text again", () => {
    expect(interpolateSiteTemplateValue("v=${a}", vars)).toBe("v=1");
    expect(interpolateSiteTemplateValue("$$a $$$$ ${a}${a}", vars)).toBe("$a $$ 11");
    expect(interpolateSiteTemplateValue("${x}", vars)).toBe("${y}");
    expect(interpolateSiteTemplateValue("$${a}", vars)).toBe("${a}");
    expect(interpolateSiteTemplateValue("no variables", vars)).toBe("no variables");
  });

  it("throws unknown_variable for a name the map does not hold, even an inherited one", () => {
    const error = renderError(() => interpolateSiteTemplateValue("${nope}", vars));
    expect(error.code).toBe("unknown_variable");
    expect(error.message).toContain("nope");
    expect(renderError(() => interpolateSiteTemplateValue("${constructor}", vars)).code).toBe("unknown_variable");
    expect(renderError(() => interpolateSiteTemplateValue("${toString}", vars)).code).toBe("unknown_variable");
  });

  it("throws invalid_interpolation for a malformed reference", () => {
    for (const raw of ["$", "$a", "${", "${a-b}", "${}"]) {
      expect(renderError(() => interpolateSiteTemplateValue(raw, vars)).code, raw).toBe("invalid_interpolation");
    }
  });
});

describe("built-in WordPress template", () => {
  it("has stable ids, a name and one built-in version per module", () => {
    expect(BUILT_IN_WORDPRESS_TEMPLATE_ID).toBe("stpl_wordpress");
    expect(BUILT_IN_WORDPRESS_VERSION_ID).toBe("stv_wordpress_1");
    expect(BUILT_IN_WORDPRESS_TEMPLATE_NAME).toBe("WordPress");
    expect(BUILT_IN_TEMPLATE_BY_MODULE).toEqual({ wordpress: "stpl_wordpress" });
    expect(BUILT_IN_VERSION_BY_MODULE).toEqual({ wordpress: "stv_wordpress_1" });
  });

  it("has a spec that passes the stored-row schema", () => {
    expect(SiteTemplateSpecSchema.parse(BUILT_IN_WORDPRESS_SPEC)).toEqual(BUILT_IN_WORDPRESS_SPEC);
  });

  it("has a source with literal PHP versions that ends with the volumes block", () => {
    expect(BUILT_IN_WORDPRESS_SOURCE.endsWith("\nvolumes:\n  html: {}\n")).toBe(true);
    expect(BUILT_IN_WORDPRESS_SOURCE).toContain("image: ${HP_MODULE_IMAGE}\n");
    expect(BUILT_IN_WORDPRESS_SOURCE).toContain('options: ["8.3", "8.4", "8.5"]');
    const php = BUILT_IN_WORDPRESS_SPEC.parameters[0];
    for (const version of php?.options ?? []) expect(SITE_TEMPLATE_MODULES.wordpress.phpVersions).toContain(version);
  });
});

describe("renderSiteTemplate: the built-in template", () => {
  for (const php of SUPPORTED_PHP_VERSIONS) {
    it(`renders exactly the legacy WordPress service for PHP ${php}`, () => {
      const rendered = renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, { php_version: php }, CONTEXT);
      expect(rendered.configuration).toEqual({
        image: resolveWordpressImage(php),
        internalPort: 80,
        exposeHttp: true,
        siteMail: true,
        volumeMounts: [{ containerPath: "/var/www/html", volumeSuffix: "html" }],
      });
      expect(Object.keys(rendered.configuration).sort()).toEqual(["exposeHttp", "image", "internalPort", "siteMail", "volumeMounts"]);
      expect(rendered.resourceLimits).toEqual({ cpuMilli: 1000, memoryBytes: "536870912" });
      expect(rendered.secretRefs).toEqual({});
      expect(rendered.phpVersion).toBe(php);
    });
  }

  it("does not depend on the site", () => {
    const a = renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, { php_version: "8.4" }, CONTEXT);
    const b = renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, { php_version: "8.4" }, { siteId: "", siteDomain: "", siteUrl: "" });
    expect(b).toEqual(a);
  });
});

describe("renderSiteTemplate: environment, image and structure", () => {
  it("renders the magic variables and the parameters into the environment, top level", () => {
    const spec = withService(
      {
        environment: [
          { name: "WP_HOME", value: "${HP_SITE_URL}" },
          { name: "HP_ID", value: "${HP_SITE_ID}" },
          { name: "DOM", value: "${HP_SITE_DOMAIN}" },
          { name: "X", value: "${size}" },
          { name: "FLAG", value: "${debug}" },
          { name: "N", value: "w=${workers}" },
          { name: "PRICE", value: "$$5" },
        ],
      },
      {
        parameters: [
          ...BUILT_IN_WORDPRESS_SPEC.parameters,
          { key: "size", label: "Size", type: "size", default: "64M", customer: true },
          { key: "debug", label: "Debug", type: "boolean", default: false, customer: true },
          { key: "workers", label: "Workers", type: "integer", default: 3, customer: false },
        ],
      },
    );
    const { configuration } = renderSiteTemplate(spec, { php_version: "8.4", size: "64M", debug: true, workers: 3 }, CONTEXT);
    expect(configuration).toMatchObject({
      WP_HOME: "https://shop.example.com",
      HP_ID: "site_1",
      DOM: "shop.example.com",
      X: "64M",
      FLAG: "true",
      N: "w=3",
      PRICE: "$5",
    });
    expect(configuration.image).toBe(resolveWordpressImage("8.4"));
  });

  it("lets the structured keys win over an environment entry", () => {
    const spec = withService({ environment: [{ name: "image", value: "evil" }] });
    // Environment names are upper case in a stored spec; the renderer still guarantees the order.
    expect(renderSiteTemplate(spec, { php_version: "8.4" }, CONTEXT).configuration.image).toBe(resolveWordpressImage("8.4"));
  });

  it("refuses HP_MODULE_IMAGE anywhere but as the whole image", () => {
    expect(MODULE_IMAGE_VARIABLE).toBe("HP_MODULE_IMAGE");
    expect(SITE_TEMPLATE_MAGIC_VARIABLES).toEqual(["HP_SITE_ID", "HP_SITE_DOMAIN", "HP_SITE_URL", "HP_MODULE_IMAGE"]);
    const inEnv = withService({ environment: [{ name: "IMG", value: "${HP_MODULE_IMAGE}" }] });
    expect(renderError(() => renderSiteTemplate(inEnv, { php_version: "8.4" }, CONTEXT)).code).toBe("unknown_variable");
    const inImage = withService({ image: "wordpress:${HP_MODULE_IMAGE}" });
    expect(renderError(() => renderSiteTemplate(inImage, { php_version: "8.4" }, CONTEXT)).code).toBe("unknown_variable");
  });

  it("renders a custom image with the chosen PHP version", () => {
    const spec = withService({ image: "wordpress:7.1.4-php${php_version}-apache" });
    const rendered = renderSiteTemplate(spec, { php_version: "8.5" }, CONTEXT);
    expect(rendered.configuration.image).toBe("wordpress:7.1.4-php8.5-apache");
    expect(rendered.phpVersion).toBe("8.5");
  });

  it("renders the php block as a keyed phpIni object, and no key when there is none", () => {
    const withPhp = { ...BUILT_IN_WORDPRESS_SPEC, php: [{ key: "memory_limit", value: "256M" }, { key: "max_execution_time", value: "60" }] };
    expect(renderSiteTemplate(withPhp, { php_version: "8.4" }, CONTEXT).configuration.phpIni).toEqual({
      memory_limit: "256M",
      max_execution_time: "60",
    });
    const rendered = renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, { php_version: "8.4" }, CONTEXT);
    expect("phpIni" in rendered.configuration).toBe(false);
  });

  it("uses the first exposed port, the volumes and the limits of the spec", () => {
    const spec = withService({
      expose: [8080, 9000],
      volumes: [{ volume: "html", containerPath: "/var/www/html" }, { volume: "cache", containerPath: "/cache" }],
      limits: { cpuMilli: 2500, memoryBytes: "1073741824" },
    });
    const rendered = renderSiteTemplate(spec, { php_version: "8.4" }, CONTEXT);
    expect(rendered.configuration.internalPort).toBe(8080);
    expect(rendered.configuration.volumeMounts).toEqual([
      { volumeSuffix: "html", containerPath: "/var/www/html" },
      { volumeSuffix: "cache", containerPath: "/cache" },
    ]);
    expect(rendered.resourceLimits).toEqual({ cpuMilli: 2500, memoryBytes: "1073741824" });
  });

  it("falls back to the module facts for limits and port", () => {
    const rendered = renderSiteTemplate(withService({ limits: null, expose: [] }), { php_version: "8.4" }, CONTEXT);
    expect(rendered.resourceLimits).toEqual(SITE_TEMPLATE_MODULES.wordpress.defaultLimits);
    expect(rendered.resourceLimits).not.toBe(SITE_TEMPLATE_MODULES.wordpress.defaultLimits);
    expect(rendered.configuration.internalPort).toBe(80);
  });
});

describe("renderSiteTemplate: refusals", () => {
  it("refuses a declared parameter without a value", () => {
    expect(renderError(() => renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, {}, CONTEXT)).code).toBe("missing_parameter");
    expect(renderError(() => renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, Object.create({ php_version: "8.4" }) as SiteTemplateParameterMap, CONTEXT)).code).toBe(
      "missing_parameter",
    );
  });

  it("refuses a PHP version the module does not support", () => {
    for (const bad of ["8.2", 8.4, true]) {
      expect(renderError(() => renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, { php_version: bad as string }, CONTEXT)).code, String(bad)).toBe(
        "invalid_php_version",
      );
    }
  });

  it("refuses the module image when the spec has no php_version parameter", () => {
    const spec = { ...BUILT_IN_WORDPRESS_SPEC, parameters: [] };
    const error = renderError(() => renderSiteTemplate(spec, {}, CONTEXT));
    expect(error.code).toBe("invalid_php_version");
    const own = withService({ image: "wordpress:7.1.4-php8.4-apache" }, { parameters: [] });
    expect(renderSiteTemplate(own, {}, CONTEXT).phpVersion).toBeNull();
  });

  it("refuses an unknown module", () => {
    const spec = { ...BUILT_IN_WORDPRESS_SPEC, module: "toString" } as unknown as SiteTemplateSpec;
    expect(renderError(() => renderSiteTemplate(spec, { php_version: "8.4" }, CONTEXT)).code).toBe("unknown_module");
  });

  it("refuses an environment value longer than 4096 characters after interpolation", () => {
    const spec = withService(
      { environment: [{ name: "BIG", value: "${a}${a}${a}${a}${a}${a}${a}${a}${a}${a}${a}${a}${a}${a}${a}${a}${a}" }] },
      {
        parameters: [
          ...BUILT_IN_WORDPRESS_SPEC.parameters,
          { key: "a", label: "A", type: "string", customer: true },
        ],
      },
    );
    const values = { php_version: "8.4", a: "x".repeat(256) };
    expect(renderError(() => renderSiteTemplate(spec, values, CONTEXT)).code).toBe("value_too_long");
    expect(renderSiteTemplate(spec, { ...values, a: "x".repeat(240) }, CONTEXT).configuration.BIG).toHaveLength(17 * 240);
  });

  it("refuses a rendered environment value that names the Docker socket, without echoing it", () => {
    const spec = withService(
      { environment: [{ name: "TAGLINE", value: "${tagline}" }, { name: "PLAIN", value: "ok" }] },
      { parameters: [...BUILT_IN_WORDPRESS_SPEC.parameters, { key: "tagline", label: "Tagline", type: "string", default: "hi", customer: true }] },
    );
    const socket = "see /var/run/docker.sock";
    const error = renderError(() => renderSiteTemplate(spec, { php_version: "8.4", tagline: socket }, CONTEXT));
    expect(error.code).toBe("unsafe_value");
    expect(error.message).not.toContain("docker.sock");
    expect(error.message).not.toContain("TAGLINE");
    expect(renderSiteTemplate(spec, { php_version: "8.4", tagline: "a docker note" }, CONTEXT).configuration.TAGLINE).toBe("a docker note");
  });

  it("refuses a malformed reference and an unknown variable in the environment or the image", () => {
    expect(renderError(() => renderSiteTemplate(withService({ environment: [{ name: "A", value: "$x" }] }), { php_version: "8.4" }, CONTEXT)).code).toBe(
      "invalid_interpolation",
    );
    expect(renderError(() => renderSiteTemplate(withService({ environment: [{ name: "A", value: "${nope}" }] }), { php_version: "8.4" }, CONTEXT)).code).toBe(
      "unknown_variable",
    );
    expect(renderError(() => renderSiteTemplate(withService({ image: "img:${nope}" }), { php_version: "8.4" }, CONTEXT)).code).toBe("unknown_variable");
  });

  it("reads parameters named like inherited properties as own properties only", () => {
    const spec = withService(
      { environment: [{ name: "C", value: "${constructor}" }, { name: "T", value: "${tostring}" }] },
      {
        parameters: [
          ...BUILT_IN_WORDPRESS_SPEC.parameters,
          { key: "constructor", label: "C", type: "string", default: "c", customer: true },
          { key: "tostring", label: "T", type: "string", default: "t", customer: true },
        ],
      },
    );
    const values = Object.fromEntries([["php_version", "8.4"], ["constructor", "c"], ["tostring", "t"]]);
    expect(renderSiteTemplate(spec, values, CONTEXT).configuration).toMatchObject({ C: "c", T: "t" });
    expect(renderError(() => renderSiteTemplate(spec, { php_version: "8.4" }, CONTEXT)).code).toBe("missing_parameter");
  });
});

describe("renderSiteTemplate: purity", () => {
  it("renders deep-frozen input, twice the same, with no template or version id", () => {
    const spec = deepFreeze(structuredClone(BUILT_IN_WORDPRESS_SPEC));
    const values = deepFreeze({ php_version: "8.4" });
    const context = deepFreeze({ ...CONTEXT });
    const first = renderSiteTemplate(spec, values, context);
    const second = renderSiteTemplate(spec, values, context);
    expect(second).toEqual(first);
    expect(first.configuration).not.toBe(second.configuration);
    expect(JSON.stringify(first.configuration)).not.toMatch(/stpl_|stv_/);
    expect(spec).toEqual(BUILT_IN_WORDPRESS_SPEC);
  });
});

describe("toSiteTemplatePreview", () => {
  it("renders the defaults of the built-in with the preview context", () => {
    expect(SITE_TEMPLATE_PREVIEW_CONTEXT).toEqual({ siteId: "site_preview", siteDomain: "example.com", siteUrl: "https://example.com" });
    const preview = toSiteTemplatePreview(BUILT_IN_WORDPRESS_SPEC);
    expect(preview).toEqual({
      module: "wordpress",
      image: resolveWordpressImage("8.4"),
      internalPort: 80,
      exposeHttp: true,
      limits: { cpuMilli: 1000, memoryBytes: "536870912" },
      environment: [],
      volumes: [{ volume: "html", containerPath: "/var/www/html" }],
      phpSettings: [],
      parameters: [{ key: "php_version", label: "Versione PHP", type: "enum", customer: true, value: "8.4" }],
    });
    expect(SiteTemplatePreviewDtoSchema.safeParse(preview).success).toBe(true);
  });

  it("uses the given values and keeps the environment as name/value arrays", () => {
    const spec = withService(
      { environment: [{ name: "WP_HOME", value: "${HP_SITE_URL}" }, { name: "DB_PASSWORD", value: "x" }, { name: "API_KEY", value: "y" }, { name: "SECRET_REF", value: "z" }] },
      { php: [{ key: "memory_limit", value: "256M" }] },
    );
    const preview = toSiteTemplatePreview(spec, { php_version: "8.3" });
    expect(preview.image).toBe(resolveWordpressImage("8.3"));
    expect(preview.environment).toEqual([
      { name: "WP_HOME", value: "https://example.com" },
      { name: "DB_PASSWORD", value: "x" },
      { name: "API_KEY", value: "y" },
      { name: "SECRET_REF", value: "z" },
    ]);
    expect(preview.phpSettings).toEqual([{ key: "memory_limit", value: "256M" }]);
    expect(preview.parameters[0]?.value).toBe("8.3");
    expect(findForbiddenPublicDtoKeys(preview)).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain("configuration");
  });

  it("renders a sample for a parameter without a default", () => {
    const spec = withService({ environment: [{ name: "N", value: "${n}" }] }, {
      parameters: [...BUILT_IN_WORDPRESS_SPEC.parameters, { key: "n", label: "N", type: "integer", min: 5, max: 9, customer: true }],
    });
    expect(toSiteTemplatePreview(spec).environment).toEqual([{ name: "N", value: "5" }]);
  });
});
