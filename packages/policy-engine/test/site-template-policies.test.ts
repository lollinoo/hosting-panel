import { describe, expect, it } from "vitest";
import {
  SITE_TEMPLATE_MODULES,
  SITE_TYPE_KEYS,
  SUPPORTED_PHP_VERSIONS,
  resolveWordpressImage,
} from "@hosting-panel/contracts";
import { parseImageReference } from "../src/image-reference.js";
import { SITE_TEMPLATE_POLICIES, getSiteTemplatePolicy } from "../src/site-template-policies.js";

const wordpress = getSiteTemplatePolicy("wordpress");

describe("site template module policies", () => {
  it("has a policy for every site type key", () => {
    for (const key of SITE_TYPE_KEYS) {
      expect(SITE_TEMPLATE_POLICIES[key].module).toBe(key);
      expect(getSiteTemplatePolicy(key)).toBe(SITE_TEMPLATE_POLICIES[key]);
    }
  });

  it("reads the variant options from the module facts instead of copying them", () => {
    expect(wordpress.variantParameter).toEqual({ key: "php_version", options: SUPPORTED_PHP_VERSIONS });
    expect(wordpress.variantParameter?.options).toEqual(SITE_TEMPLATE_MODULES.wordpress.phpVersions);
  });

  it("fixes the WordPress limits, volume and PHP rules", () => {
    expect(wordpress.image.repository).toBe("wordpress");
    expect(wordpress.limits).toEqual({ minCpuMilli: 100, minMemoryBytes: 134217728n });
    expect(wordpress.extraVolumes).toBe(false);
    expect(wordpress.phpSettings).toBe(true);
    expect(wordpress.maxCustomerParameters).toBe(8);
  });

  it("agrees with the template-model floor of the module", () => {
    expect(BigInt(SITE_TEMPLATE_MODULES.wordpress.defaultLimits.memoryBytes)).toBeGreaterThanOrEqual(wordpress.limits.minMemoryBytes);
    expect(SITE_TEMPLATE_MODULES.wordpress.defaultLimits.cpuMilli).toBeGreaterThanOrEqual(wordpress.limits.minCpuMilli);
  });
});

describe("WordPress image tag pattern", () => {
  const accepts = (tag: string, php: string): boolean => wordpress.image.tagPattern(php).test(tag);

  it("accepts a three-component pin on the chosen PHP version", () => {
    expect(accepts("7.1.4-php8.4-apache", "8.4")).toBe(true);
    expect(accepts("10.12.3-php8.3-apache", "8.3")).toBe(true);
  });

  it("refuses floating tags and other variants", () => {
    for (const tag of [
      "latest",
      "php8.4-apache",
      "7.1-php8.4-apache",
      "7-php8.4-apache",
      "7.1.4-php8.3-apache",
      "7.1.4-php8.4-fpm",
      "7.1.4-php8.4-apache-extra",
      "x7.1.4-php8.4-apache",
      "7.1.4-php84-apache",
      "7.1.4-php8x4-apache",
      "7.1.4-php8.4",
      "",
    ]) {
      expect(accepts(tag, "8.4"), tag).toBe(false);
    }
  });

  it("treats the variant as text, not as a pattern", () => {
    expect(accepts("7.1.4-php8x4-apache", "8.4")).toBe(false);
    expect(accepts("7.1.4-php.*-apache", ".*")).toBe(true);
    expect(accepts("7.1.4-php8.4-apache", ".*")).toBe(false);
  });

  it("never matches without a variant", () => {
    expect(wordpress.image.tagPattern(null).test("7.1.4-php8.4-apache")).toBe(false);
  });

  it("drift guard: follows the pin the code resolves for every supported PHP version", () => {
    for (const version of SUPPORTED_PHP_VERSIONS) {
      const parsed = parseImageReference(resolveWordpressImage(version));
      expect(parsed.ok, version).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.registry).toBeNull();
      expect(parsed.value.repository).toBe(wordpress.image.repository);
      expect(parsed.value.digest).toBeNull();
      expect(wordpress.image.tagPattern(version).test(parsed.value.tag ?? ""), version).toBe(true);
    }
  });
});
