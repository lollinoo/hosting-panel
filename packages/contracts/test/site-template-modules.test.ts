import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHP_VERSION,
  SUPPORTED_PHP_VERSIONS,
  resolveWordpressImage,
  resolveWordpressRuntime,
} from "../src/site-runtime.js";
import { SITE_TYPE_KEYS } from "../src/site-types/keys.js";
import { WORDPRESS_SITE_TYPE } from "../src/site-types/wordpress.js";
import { SITE_TEMPLATE_MODULES, getSiteTemplateModule } from "../src/site-templates/modules.js";

describe("SITE_TEMPLATE_MODULES", () => {
  it("has facts for every site type key", () => {
    for (const key of SITE_TYPE_KEYS) {
      expect(SITE_TEMPLATE_MODULES[key]).toBeDefined();
      expect(SITE_TEMPLATE_MODULES[key].key).toBe(key);
      expect(getSiteTemplateModule(key)).toBe(SITE_TEMPLATE_MODULES[key]);
    }
    expect(Object.keys(SITE_TEMPLATE_MODULES).sort()).toEqual([...SITE_TYPE_KEYS].sort());
  });

  describe("wordpress", () => {
    const facts = SITE_TEMPLATE_MODULES.wordpress;

    it("derives the image from the code pin for every supported PHP version", () => {
      for (const php of SUPPORTED_PHP_VERSIONS) {
        expect(facts.image(php)).toBe(resolveWordpressImage(php));
        expect(facts.image(php)).toBe(resolveWordpressRuntime(php).image);
      }
    });

    it("refuses an image for a PHP version it does not support", () => {
      expect(() => facts.image("8.2")).toThrow(RangeError);
      expect(() => facts.image("")).toThrow(RangeError);
      expect(() => facts.image("8.4 ")).toThrow(RangeError);
      expect(() => facts.image("toString")).toThrow(RangeError);
    });

    it("lists exactly the supported PHP versions", () => {
      expect(facts.phpVersions).toEqual([...SUPPORTED_PHP_VERSIONS]);
    });

    it("requires the site-type files volume at the site-type mount path", () => {
      expect(facts.requiredMount).toEqual({
        name: WORDPRESS_SITE_TYPE.files.volumeSuffix,
        target: WORDPRESS_SITE_TYPE.files.mountPath,
      });
      expect(facts.requiredMount).toEqual({ name: "html", target: "/var/www/html" });
    });

    it("keeps today's service facts", () => {
      expect(facts.serviceTemplateId).toBe(WORDPRESS_SITE_TYPE.templateId);
      expect(facts.serviceName).toBe("web");
      expect(facts.internalPort).toBe(80);
      expect(facts.exposeHttp).toBe(true);
      expect(facts.siteMail).toBe(true);
    });

    it("takes the default limits from the runtime, as a copy", () => {
      const limits = resolveWordpressRuntime(DEFAULT_PHP_VERSION).resourceLimits;
      expect(facts.defaultLimits).toEqual(limits);
      expect(facts.defaultLimits).toEqual({ cpuMilli: 1000, memoryBytes: "536870912" });
      expect(facts.defaultLimits).not.toBe(limits);
    });
  });
});
