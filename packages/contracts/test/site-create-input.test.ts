import { describe, expect, it } from "vitest";
import {
  AdminCreateSiteInputSchema,
  AdminSiteDtoSchema,
  CreateManagedSiteInputSchema,
  SITE_TEMPLATE_LIMITS,
} from "../src/index.js";

const body = {
  name: "Hotel",
  domain: "hotel.it",
  title: "Hotel",
  adminUser: "owner",
  adminEmail: "a@hotel.it",
  adminPassword: "correct-horse-battery",
};
const parse = (extra: Record<string, unknown>) => CreateManagedSiteInputSchema.safeParse({ ...body, ...extra });
const issuePaths = (result: ReturnType<typeof parse>) => (result.success ? [] : result.error.issues.map((i) => i.path));

describe("create site input: phpVersion", () => {
  it("leaves an absent phpVersion absent (no default: the template decides)", () => {
    const result = parse({});
    expect(result.success && "phpVersion" in result.data).toBe(false);
    expect(result.success && result.data.phpVersion).toBeUndefined();
  });

  it("parses the old body (with phpVersion, without template fields) to the same fields", () => {
    const result = parse({ phpVersion: "8.3" });
    expect(result.success && result.data).toEqual({
      name: "Hotel",
      domain: "hotel.it",
      includeWww: false,
      phpVersion: "8.3",
      title: "Hotel",
      adminUser: "owner",
      adminEmail: "a@hotel.it",
      adminPassword: "correct-horse-battery",
    });
  });

  it("still refuses a phpVersion outside the supported list", () => {
    for (const phpVersion of ["8.2", "", 8.4, null]) expect(issuePaths(parse({ phpVersion }))).toEqual([["phpVersion"]]);
  });
});

describe("create site input: templateId", () => {
  it("is optional and, when present, a string of 1 to 128 characters", () => {
    expect(parse({}).success).toBe(true);
    expect(parse({ templateId: "stpl_wordpress" }).success).toBe(true);
    expect(parse({ templateId: "a".repeat(128) }).success).toBe(true);
    for (const templateId of ["", "a".repeat(129), 7, null]) expect(issuePaths(parse({ templateId }))).toEqual([["templateId"]]);
  });
});

describe("create site input: parameters", () => {
  it("is optional and accepts string, number and boolean values", () => {
    const parameters = [
      { key: "memory", value: "256M" },
      { key: "workers", value: 4 },
      { key: "debug", value: false },
    ];
    expect(parse({}).success).toBe(true);
    const result = parse({ parameters });
    expect(result.success && result.data.parameters).toEqual(parameters);
    expect(parse({ parameters: [] }).success).toBe(true);
  });

  it("refuses more than the maximum number of entries and accepts exactly the maximum", () => {
    const entries = (count: number) => Array.from({ length: count }, (_, index) => ({ key: `p${index}`, value: index }));
    expect(parse({ parameters: entries(SITE_TEMPLATE_LIMITS.parameters) }).success).toBe(true);
    expect(issuePaths(parse({ parameters: entries(SITE_TEMPLATE_LIMITS.parameters + 1) }))).toEqual([["parameters"]]);
  });

  it("refuses a duplicate key, pointing at the second entry", () => {
    const result = parse({
      parameters: [
        { key: "a", value: 1 },
        { key: "b", value: 2 },
        { key: "a", value: 3 },
      ],
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContainEqual(["parameters", 2, "key"]);
  });

  it("refuses a value that is not a string, number or boolean, and an entry with extra keys", () => {
    for (const value of [null, [], {}, undefined]) expect(parse({ parameters: [{ key: "a", value }] }).success).toBe(false);
    expect(parse({ parameters: [{ key: "a", value: 1, extra: true }] }).success).toBe(false);
    expect(parse({ parameters: [{ key: "A-b", value: 1 }] }).success).toBe(false);
    expect(parse({ parameters: { a: 1 } }).success).toBe(false);
  });
});

describe("create site input: unchanged behaviour", () => {
  it("still ignores an unknown top-level key (stripped, not rejected)", () => {
    const result = parse({ surprise: true });
    expect(result.success && "surprise" in result.data).toBe(false);
  });

  it("is inherited by the admin schema, which keeps ownerOrganizationId", () => {
    const parameters = [{ key: "a", value: "x" }];
    const result = AdminCreateSiteInputSchema.safeParse({ ...body, ownerOrganizationId: null, templateId: "tpl_1", parameters });
    expect(result.success && result.data.templateId).toBe("tpl_1");
    expect(result.success && result.data.parameters).toEqual(parameters);
    expect(result.success && result.data.phpVersion).toBeUndefined();
    expect(AdminCreateSiteInputSchema.safeParse(body).success).toBe(false);
  });
});

describe("AdminSiteDto: template reference", () => {
  const site = {
    id: "site_1",
    organizationId: "org_1",
    hostAllocationId: "host_1",
    name: "Hotel",
    slug: "hotel",
    status: "ready",
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt: "2026-11-21T10:00:00.000Z",
    phpVersion: "8.4",
    siteType: "wordpress",
    primaryDomain: "hotel.it",
    owner: null,
  };
  const template = {
    templateId: "stpl_wordpress",
    templateName: "WordPress",
    versionId: "stv_wordpress_1",
    versionNumber: 1,
    defaultVersionId: "stv_wordpress_2",
    defaultVersionNumber: 2,
  };

  it("requires the field and accepts null or a template reference", () => {
    expect(AdminSiteDtoSchema.safeParse(site).success).toBe(false);
    expect(AdminSiteDtoSchema.safeParse({ ...site, template: null }).success).toBe(true);
    const result = AdminSiteDtoSchema.safeParse({ ...site, template });
    expect(result.success && result.data.template).toEqual(template);
  });

  it("accepts a reference whose template has no default version", () => {
    const orphan = { ...template, defaultVersionId: null, defaultVersionNumber: null };
    expect(AdminSiteDtoSchema.safeParse({ ...site, template: orphan }).success).toBe(true);
  });

  it("refuses a template reference with a missing field", () => {
    const { versionNumber: _omitted, ...incomplete } = template;
    expect(AdminSiteDtoSchema.safeParse({ ...site, template: incomplete }).success).toBe(false);
  });
});
