/**
 * The built-in WordPress template, the validator and the renderer must agree: the source the platform ships is a valid
 * template whose spec is the one the code holds, and everything the validator accepts is something the renderer fills in.
 */
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_WORDPRESS_SOURCE,
  BUILT_IN_WORDPRESS_SPEC,
  SITE_TEMPLATE_MAGIC_VARIABLES,
  SITE_TEMPLATE_MODULES,
  SUPPORTED_PHP_VERSIONS,
  SiteTemplateSpecSchema,
  interpolateSiteTemplateValue,
  listSiteTemplateVariables,
  parseTemplateYaml,
  renderSiteTemplate,
  resolveSiteTemplateParameters,
  resolveWordpressImage,
  sampleSiteTemplateParameterMap,
  toSiteTemplatePreview,
  type SiteTemplateSpec,
} from "@hosting-panel/contracts";
import { HP_MAGIC_VARIABLES, HP_MODULE_IMAGE_VARIABLE, HP_VARIABLE_MAX_LENGTH, expandPieces, scanInterpolation } from "../src/site-template-interpolation.js";
import { validateSiteTemplateSource } from "../src/site-template-validation.js";

function specOf(source: string): SiteTemplateSpec {
  const result = validateSiteTemplateSource(source, "wordpress");
  if (!result.ok) throw new Error(`expected a valid template, got ${JSON.stringify(result.errors)}`);
  return result.spec;
}

describe("the built-in WordPress template", () => {
  it("validates to exactly the spec the contracts hold", () => {
    const result = validateSiteTemplateSource(BUILT_IN_WORDPRESS_SOURCE, "wordpress");
    expect(result).toEqual({ ok: true, spec: BUILT_IN_WORDPRESS_SPEC });
    if (result.ok) expect(SiteTemplateSpecSchema.parse(result.spec)).toEqual(BUILT_IN_WORDPRESS_SPEC);
  });

  it("parses with the image line unquoted", () => {
    expect(BUILT_IN_WORDPRESS_SOURCE).toContain("    image: ${HP_MODULE_IMAGE}\n");
    const parsed = parseTemplateYaml(BUILT_IN_WORDPRESS_SOURCE);
    expect(parsed.ok).toBe(true);
  });

  it("ends with the top-level volumes declaration the validator requires", () => {
    expect(BUILT_IN_WORDPRESS_SOURCE.endsWith("volumes:\n  html: {}\n")).toBe(true);
  });

  it("offers only PHP versions the module supports, and a default among them", () => {
    const parameter = BUILT_IN_WORDPRESS_SPEC.parameters.find((candidate) => candidate.key === "php_version");
    expect(parameter?.options).toBeDefined();
    for (const option of parameter?.options ?? []) expect(SITE_TEMPLATE_MODULES.wordpress.phpVersions).toContain(option);
    expect(parameter?.options).toContain(parameter?.default);
    expect(parameter?.customer).toBe(true);
  });

  it("stays valid when the image names the pin instead of the placeholder", () => {
    const pin = resolveWordpressImage(SUPPORTED_PHP_VERSIONS[0]).replace(`php${SUPPORTED_PHP_VERSIONS[0]}`, "php${php_version}");
    expect(pin).toContain("${php_version}");
    const spec = specOf(BUILT_IN_WORDPRESS_SOURCE.replace("${HP_MODULE_IMAGE}", pin));
    expect(spec.service.image).toBe(pin);
    expect(spec).toEqual({ ...BUILT_IN_WORDPRESS_SPEC, service: { ...BUILT_IN_WORDPRESS_SPEC.service, image: pin } });
  });

  it("renders for every PHP version with the image the module pins", () => {
    for (const version of SUPPORTED_PHP_VERSIONS) {
      const rendered = renderSiteTemplate(BUILT_IN_WORDPRESS_SPEC, { php_version: version }, { siteId: "site_1", siteDomain: "a.example", siteUrl: "https://a.example" });
      expect(rendered.configuration.image).toBe(resolveWordpressImage(version));
    }
  });
});

describe("what the validator accepts, the renderer fills in", () => {
  const SOURCE = [
    "x-hp-module: wordpress",
    "x-hp-parameters:",
    "  - key: php_version",
    "    label: PHP",
    "    type: enum",
    '    options: ["8.3", "8.4"]',
    '    default: "8.3"',
    "    customer: true",
    "  - key: workers",
    "    label: Workers",
    "    type: integer",
    "    min: 1",
    "    max: 16",
    "    default: 4",
    "    customer: true",
    "  - key: greeting",
    "    label: Greeting",
    "    type: string",
    '    default: "hello"',
    "  - key: debug",
    "    label: Debug",
    "    type: boolean",
    "    default: false",
    "  - key: cache",
    "    label: Cache",
    "    type: size",
    '    default: "64M"',
    "x-hp-php:",
    "  memory_limit: 256M",
    "  upload_max_filesize: 32M",
    "  post_max_size: 64M",
    "services:",
    "  app:",
    "    image: wordpress:7.1.4-php${php_version}-apache",
    "    environment:",
    '      WP_HOME: "${HP_SITE_URL}"',
    '      WP_SITE: "${HP_SITE_ID}/${HP_SITE_DOMAIN}"',
    '      WP_WORKERS: "${workers}"',
    '      WP_GREETING: "$$${greeting}"',
    '      WP_DEBUG: "${debug}"',
    '      WP_CACHE: "${cache}"',
    '      WP_PHP: "${php_version}"',
    "    volumes:",
    "      - html:/var/www/html",
    "volumes:",
    "  html: {}",
    "",
  ].join("\n");
  const context = { siteId: "site_1", siteDomain: "a.example", siteUrl: "https://a.example" };

  it("renders a validated template with the sample values and leaves no placeholder behind", () => {
    const spec = specOf(SOURCE);
    const rendered = renderSiteTemplate(spec, sampleSiteTemplateParameterMap(spec), context);
    expect(rendered.configuration).toMatchObject({
      image: "wordpress:7.1.4-php8.3-apache",
      WP_HOME: "https://a.example",
      WP_SITE: "site_1/a.example",
      WP_WORKERS: "4",
      WP_GREETING: "$hello",
      WP_DEBUG: "false",
      WP_CACHE: "64M",
      WP_PHP: "8.3",
      phpIni: { memory_limit: "256M", post_max_size: "64M", upload_max_filesize: "32M" },
    });
    for (const value of Object.values(rendered.configuration)) {
      if (typeof value === "string") expect(value).not.toContain("${");
    }
  });

  it("builds the preview from the validated spec", () => {
    const preview = toSiteTemplatePreview(specOf(SOURCE));
    expect(preview.environment.map((entry) => entry.name)).toEqual(["WP_HOME", "WP_SITE", "WP_WORKERS", "WP_GREETING", "WP_DEBUG", "WP_CACHE", "WP_PHP"]);
  });

  it("resolves the parameters of a validated template for a customer", () => {
    const spec = specOf(SOURCE);
    const resolved = resolveSiteTemplateParameters(spec, [{ key: "workers", value: 8 }], { audience: "customer", phpVersion: "8.4" });
    expect(resolved).toMatchObject({ ok: true, values: { php_version: "8.4", workers: 8, greeting: "hello", debug: false, cache: "64M" } });
  });

  it("accepts a filled-in value up to 4096 characters and refuses what could pass it", () => {
    const biggest = { siteId: "s".repeat(HP_VARIABLE_MAX_LENGTH.HP_SITE_ID), siteDomain: "d".repeat(HP_VARIABLE_MAX_LENGTH.HP_SITE_DOMAIN), siteUrl: "u".repeat(HP_VARIABLE_MAX_LENGTH.HP_SITE_URL) };
    const withValue = (value: string) => SOURCE.replace('      WP_HOME: "${HP_SITE_URL}"', `      WP_HOME: "${value}"`);
    const two = specOf(withValue("${HP_SITE_URL}${HP_SITE_URL}"));
    expect(renderSiteTemplate(two, sampleSiteTemplateParameterMap(two), biggest).configuration.WP_HOME).toHaveLength(4096);
    const everything = specOf(withValue("${HP_SITE_ID}${HP_SITE_DOMAIN}${HP_SITE_URL}"));
    expect(renderSiteTemplate(everything, sampleSiteTemplateParameterMap(everything), biggest).configuration.WP_HOME).toHaveLength(128 + 253 + 2048);
    expect(validateSiteTemplateSource(withValue("${HP_SITE_URL}${HP_SITE_URL}${HP_SITE_URL}"), "wordpress").ok).toBe(false);
  });
});

describe("the scanner of the policy engine and the renderer share one grammar", () => {
  it("knows the same variables", () => {
    expect([...HP_MAGIC_VARIABLES, HP_MODULE_IMAGE_VARIABLE].sort()).toEqual([...SITE_TEMPLATE_MAGIC_VARIABLES].sort());
  });

  function agree(text: string): void {
    const policy = scanInterpolation(text);
    const contracts = listSiteTemplateVariables(text);
    expect(policy.ok, JSON.stringify(text)).toBe(contracts.ok);
    if (policy.ok && contracts.ok) {
      const names = [...new Set(policy.pieces.flatMap((piece) => ("variable" in piece ? [piece.variable] : [])))];
      expect(names, JSON.stringify(text)).toEqual(contracts.names);
      const values = new Map(names.map((name) => [name, "${V}"]));
      const expanded = expandPieces(policy.pieces, (name) => values.get(name) ?? "");
      expect(interpolateSiteTemplateValue(text, values), JSON.stringify(text)).toBe(expanded);
    } else if (!policy.ok && !contracts.ok) {
      expect(policy.offset, JSON.stringify(text)).toBe(contracts.offset);
    }
  }

  it("agrees on the documented cases, and expands in one pass the same way", () => {
    for (const text of ["", "plain", "$$", "$$${a}", "a${x}b", "${a}${b}", "${a}${a}", "$", "$a", "${", "${}", "${a", "${1a}", "${a-b}", "${a:-b}", "$(cmd)", "x$", "$${x}", "`x`"]) {
      agree(text);
    }
  });

  it("agrees on random strings over the characters that matter", () => {
    let state = 99;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const alphabet = ["$", "{", "}", "a", "B", "_", "1", "-", ":", " "];
    for (let i = 0; i < 500; i++) {
      agree(Array.from({ length: Math.floor(next() * 12) }, () => alphabet[Math.floor(next() * alphabet.length)]).join(""));
    }
  });
});
