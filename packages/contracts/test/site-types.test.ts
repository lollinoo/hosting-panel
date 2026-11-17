import { describe, expect, it } from "vitest";
import {
  LEGACY_SITE_TYPE,
  SITE_TYPES,
  SITE_TYPE_KEYS,
  SiteTypeKeySchema,
  WORDPRESS_SITE_TYPE,
  findSiteType,
  getSiteType,
  siteTypeKeyOf,
} from "../src/index.js";

describe("site types", () => {
  it("knows exactly one key, the legacy one", () => {
    expect(SITE_TYPE_KEYS).toEqual(["wordpress"]);
    expect(LEGACY_SITE_TYPE).toBe("wordpress");
    expect(SiteTypeKeySchema.safeParse("wordpress").success).toBe(true);
    expect(SiteTypeKeySchema.safeParse("static").success).toBe(false);
    expect(Object.keys(SITE_TYPES)).toEqual(["wordpress"]);
  });

  it("siteTypeKeyOf keeps only known keys", () => {
    expect(siteTypeKeyOf("wordpress")).toBe("wordpress");
    expect(siteTypeKeyOf(null)).toBeNull();
    expect(siteTypeKeyOf(undefined)).toBeNull();
    expect(siteTypeKeyOf("")).toBeNull();
    expect(siteTypeKeyOf("WordPress")).toBeNull();
    expect(siteTypeKeyOf("x")).toBeNull();
  });

  it("findSiteType resolves known keys and gives null otherwise", () => {
    expect(findSiteType(null)).toBeNull();
    expect(findSiteType(undefined)).toBeNull();
    expect(findSiteType("x")).toBeNull();
    expect(findSiteType("wordpress")).toBe(WORDPRESS_SITE_TYPE);
    expect(getSiteType("wordpress")).toBe(WORDPRESS_SITE_TYPE);
  });

  it("the WordPress values equal the literals of the shipped code", () => {
    expect(WORDPRESS_SITE_TYPE).toEqual({
      key: "wordpress",
      templateId: "tpl_site_wordpress",
      files: { volumeSuffix: "html", mountPath: "/var/www/html", owner: "33:33" },
      database: { namePrefix: "wp" },
      heavyOperationKinds: ["site.wordpress.update", "site.wordpress.import"],
    });
  });
});
