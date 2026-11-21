import { describe, expect, it } from "vitest";
import { findForbiddenPublicDtoKeys } from "../src/resources.js";
import { BUILT_IN_WORDPRESS_SPEC } from "../src/site-templates/built-in.js";
import {
  AddSiteTemplateVersionInputSchema,
  AdminSiteTemplateDetailDtoSchema,
  AdminSiteTemplateRefDtoSchema,
  AdminSiteTemplateSummaryDtoSchema,
  AdminSiteTemplateVersionCreatedDtoSchema,
  AdminSiteTemplateVersionDtoSchema,
  AdminSiteTemplatesListDtoSchema,
  ChangeSiteTemplateVersionInputSchema,
  CreateSiteTemplateInputSchema,
  CustomerSiteTypeDtoSchema,
  CustomerSiteTypesDtoSchema,
  SiteTemplateIdSchema,
  SiteTemplateParameterDtoSchema,
  SiteTemplatePreviewDtoSchema,
  SiteTemplateSourceSchema,
  SiteTemplateValidationDtoSchema,
  SiteTemplateVersionIdSchema,
  UpdateSiteTemplateInputSchema,
  ValidateSiteTemplateInputSchema,
  toCustomerSiteTypeDto,
  toSiteTemplateParameterDtos,
} from "../src/site-templates/dto.js";
import type { SiteTemplateSpec } from "../src/site-templates/spec.js";

const SOURCE = "x-hp-module: wordpress\n";
const AT = "2026-11-21T10:00:00.000Z";

describe("site template ids", () => {
  it("accepts generated ids and the built-in ones, refuses the rest", () => {
    expect(SiteTemplateIdSchema.safeParse("stpl_wordpress").success).toBe(true);
    expect(SiteTemplateIdSchema.safeParse("stpl_0123456789abcdef01234567").success).toBe(true);
    expect(SiteTemplateVersionIdSchema.safeParse("stv_wordpress_1").success).toBe(true);
    for (const bad of ["", "stpl_", "stpl_UPPER", "stv_x", "stpl_a-b", `stpl_${"a".repeat(65)}`, "tpl_x"]) {
      expect(SiteTemplateIdSchema.safeParse(bad).success, bad).toBe(false);
    }
    for (const bad of ["", "stv_", "stpl_x", "stv_a b", `stv_${"a".repeat(65)}`]) {
      expect(SiteTemplateVersionIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("SiteTemplateSourceSchema", () => {
  it("counts bytes, not characters", () => {
    expect(SiteTemplateSourceSchema.safeParse("a".repeat(65_536)).success).toBe(true);
    expect(SiteTemplateSourceSchema.safeParse("a".repeat(65_537)).success).toBe(false);
    // 22 000 characters of 3 bytes each are 66 000 bytes.
    expect(SiteTemplateSourceSchema.safeParse("€".repeat(22_000)).success).toBe(false);
    expect(SiteTemplateSourceSchema.safeParse("€".repeat(21_845)).success).toBe(true);
    expect(SiteTemplateSourceSchema.safeParse("").success).toBe(false);
  });
});

describe("site template input schemas", () => {
  it("CreateSiteTemplateInputSchema is strict and bounded", () => {
    const ok = { module: "wordpress", name: "  Shop  ", description: " Fast ", source: SOURCE };
    expect(CreateSiteTemplateInputSchema.parse(ok)).toEqual({ module: "wordpress", name: "Shop", description: "Fast", source: SOURCE });
    expect(CreateSiteTemplateInputSchema.safeParse({ module: "wordpress", name: "Shop", source: SOURCE }).success).toBe(true);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, name: "" }).success).toBe(false);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, name: "   " }).success).toBe(false);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, name: "a".repeat(80) }).success).toBe(true);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, name: "a".repeat(81) }).success).toBe(false);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, description: "a".repeat(500) }).success).toBe(true);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, description: "a".repeat(501) }).success).toBe(false);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, module: "drupal" }).success).toBe(false);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, source: "a".repeat(65_537) }).success).toBe(false);
    expect(CreateSiteTemplateInputSchema.safeParse({ ...ok, source: "€".repeat(22_000) }).success).toBe(false);
  });

  it("AddSiteTemplateVersionInputSchema defaults makeDefault to true", () => {
    expect(AddSiteTemplateVersionInputSchema.parse({ source: SOURCE })).toEqual({ source: SOURCE, makeDefault: true });
    expect(AddSiteTemplateVersionInputSchema.parse({ source: SOURCE, makeDefault: false }).makeDefault).toBe(false);
    expect(AddSiteTemplateVersionInputSchema.safeParse({ source: SOURCE, extra: 1 }).success).toBe(false);
    expect(AddSiteTemplateVersionInputSchema.safeParse({ source: "a".repeat(65_537) }).success).toBe(false);
    expect(AddSiteTemplateVersionInputSchema.safeParse({ makeDefault: true }).success).toBe(false);
  });

  it("UpdateSiteTemplateInputSchema needs at least one key", () => {
    expect(UpdateSiteTemplateInputSchema.safeParse({}).success).toBe(false);
    expect(UpdateSiteTemplateInputSchema.safeParse({ name: undefined }).success).toBe(false);
    expect(UpdateSiteTemplateInputSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(UpdateSiteTemplateInputSchema.safeParse({ description: null }).success).toBe(true);
    expect(UpdateSiteTemplateInputSchema.safeParse({ defaultVersionId: "stv_abc" }).success).toBe(true);
    expect(UpdateSiteTemplateInputSchema.safeParse({ defaultVersionId: "nope" }).success).toBe(false);
    expect(UpdateSiteTemplateInputSchema.safeParse({ name: "" }).success).toBe(false);
    expect(UpdateSiteTemplateInputSchema.safeParse({ name: "a".repeat(81) }).success).toBe(false);
    expect(UpdateSiteTemplateInputSchema.safeParse({ description: "a".repeat(501) }).success).toBe(false);
    expect(UpdateSiteTemplateInputSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
  });

  it("ValidateSiteTemplateInputSchema and ChangeSiteTemplateVersionInputSchema are strict", () => {
    expect(ValidateSiteTemplateInputSchema.safeParse({ module: "wordpress", source: SOURCE }).success).toBe(true);
    expect(ValidateSiteTemplateInputSchema.safeParse({ module: "wordpress", source: SOURCE, extra: 1 }).success).toBe(false);
    expect(ValidateSiteTemplateInputSchema.safeParse({ module: "nope", source: SOURCE }).success).toBe(false);
    expect(ValidateSiteTemplateInputSchema.safeParse({ module: "wordpress", source: "a".repeat(65_537) }).success).toBe(false);
    expect(ChangeSiteTemplateVersionInputSchema.safeParse({ versionId: "stv_wordpress_1" }).success).toBe(true);
    expect(ChangeSiteTemplateVersionInputSchema.safeParse({ versionId: "wordpress_1" }).success).toBe(false);
    expect(ChangeSiteTemplateVersionInputSchema.safeParse({ versionId: "stv_a", extra: 1 }).success).toBe(false);
    expect(ChangeSiteTemplateVersionInputSchema.safeParse({}).success).toBe(false);
  });
});

const CUSTOM_SPEC: SiteTemplateSpec = {
  ...BUILT_IN_WORDPRESS_SPEC,
  parameters: [
    { key: "php_version", label: "PHP", type: "enum", options: ["8.3", "8.4"], default: "8.4", customer: true },
    { key: "memory", label: "Memory", type: "size", default: "256M", customer: true },
    { key: "workers", label: "Workers", type: "integer", min: 1, max: 8, default: 2, customer: false },
    { key: "debug", label: "Debug", type: "boolean", customer: true },
  ],
};

describe("toSiteTemplateParameterDtos", () => {
  it("copies every parameter with its customer flag", () => {
    const dtos = toSiteTemplateParameterDtos(CUSTOM_SPEC);
    expect(dtos).toEqual(CUSTOM_SPEC.parameters);
    expect(dtos[0]).not.toBe(CUSTOM_SPEC.parameters[0]);
    expect(dtos[0]?.options).not.toBe(CUSTOM_SPEC.parameters[0]?.options);
    expect(Object.keys(dtos[3] ?? {}).sort()).toEqual(["customer", "key", "label", "type"]);
    for (const dto of dtos) expect(SiteTemplateParameterDtoSchema.safeParse(dto).success).toBe(true);
  });
});

describe("toCustomerSiteTypeDto", () => {
  const base = { id: "stpl_wordpress", name: "WordPress", description: null };

  it("hides php_version and the customer flag and lists the customer parameters", () => {
    const dto = toCustomerSiteTypeDto({ ...base, spec: CUSTOM_SPEC });
    expect(dto).toEqual({
      id: "stpl_wordpress",
      name: "WordPress",
      description: null,
      module: "wordpress",
      phpVersions: ["8.3", "8.4"],
      defaultPhpVersion: "8.4",
      parameters: [
        { key: "memory", label: "Memory", type: "size", default: "256M" },
        { key: "debug", label: "Debug", type: "boolean" },
      ],
    });
    expect(CustomerSiteTypeDtoSchema.safeParse(dto).success).toBe(true);
  });

  it("offers only the default PHP version when the administrator fixed it", () => {
    const spec: SiteTemplateSpec = {
      ...CUSTOM_SPEC,
      parameters: [{ ...(CUSTOM_SPEC.parameters[0] as SiteTemplateSpec["parameters"][number]), customer: false }],
    };
    const dto = toCustomerSiteTypeDto({ ...base, spec });
    expect(dto.phpVersions).toEqual(["8.4"]);
    expect(dto.defaultPhpVersion).toBe("8.4");
    expect(dto.parameters).toEqual([]);
  });

  it("has no PHP version without a php_version parameter", () => {
    const dto = toCustomerSiteTypeDto({ ...base, spec: { ...CUSTOM_SPEC, parameters: [] } });
    expect(dto.phpVersions).toEqual([]);
    expect(dto.defaultPhpVersion).toBeNull();
  });

  it("carries none of the admin-only parts of the spec", () => {
    const json = JSON.stringify(toCustomerSiteTypeDto({ ...base, spec: CUSTOM_SPEC }));
    for (const word of ["source", "spec", "image", "environment", "limits", "customer", "php_version"]) {
      expect(json, word).not.toContain(`"${word}"`);
    }
    expect(json).not.toContain("php_version");
  });
});

describe("response DTO schemas", () => {
  const parameters = toSiteTemplateParameterDtos(CUSTOM_SPEC);
  const summary = {
    id: "stpl_wordpress",
    module: "wordpress",
    name: "WordPress",
    description: null,
    builtIn: true,
    enabled: true,
    archivedAt: null,
    defaultVersionId: "stv_wordpress_1",
    defaultVersionNumber: 1,
    versionCount: 1,
    siteCount: 3,
    createdAt: AT,
    updatedAt: AT,
  };
  const version = { id: "stv_wordpress_1", versionNumber: 1, createdAt: AT, siteCount: 3, isDefault: true };
  const preview = {
    module: "wordpress",
    image: "wordpress:7.1.4-php8.4-apache",
    internalPort: 80,
    exposeHttp: true,
    limits: { cpuMilli: 1000, memoryBytes: "536870912" },
    environment: [
      { name: "DB_PASSWORD", value: "x" },
      { name: "API_KEY", value: "y" },
      { name: "SECRET_REF", value: "z" },
    ],
    volumes: [{ volume: "html", containerPath: "/var/www/html" }],
    phpSettings: [{ key: "memory_limit", value: "256M" }],
    parameters: [{ key: "php_version", label: "PHP", type: "enum", customer: true, value: "8.4" }],
  };
  const samples = {
    summary: [AdminSiteTemplateSummaryDtoSchema, summary],
    detail: [AdminSiteTemplateDetailDtoSchema, { ...summary, versions: [version] }],
    list: [AdminSiteTemplatesListDtoSchema, { templates: [summary], modules: [{ key: "wordpress", phpVersions: ["8.3", "8.4", "8.5"] }] }],
    version: [AdminSiteTemplateVersionDtoSchema, { id: "stv_wordpress_1", templateId: "stpl_wordpress", versionNumber: 1, createdAt: AT, source: SOURCE }],
    created: [
      AdminSiteTemplateVersionCreatedDtoSchema,
      { id: "stv_x", templateId: "stpl_x", versionNumber: 2, createdAt: AT, source: SOURCE, isDefault: true, created: false },
    ],
    preview: [SiteTemplatePreviewDtoSchema, preview],
    validation: [
      SiteTemplateValidationDtoSchema,
      {
        valid: false,
        errors: [
          { line: 3, column: 5, path: "services.app.image", code: "unpinned_image", message: "no tag" },
          { line: null, column: null, path: null, code: "x", message: "y" },
        ],
        parameters,
        preview: null,
      },
    ],
    validationValid: [SiteTemplateValidationDtoSchema, { valid: true, errors: [], parameters, preview }],
    customer: [CustomerSiteTypesDtoSchema, { siteTypes: [toCustomerSiteTypeDto({ id: "stpl_wordpress", name: "WordPress", description: "d", spec: CUSTOM_SPEC })] }],
    ref: [
      AdminSiteTemplateRefDtoSchema,
      { templateId: "stpl_wordpress", templateName: "WordPress", versionId: "stv_wordpress_1", versionNumber: 1, defaultVersionId: "stv_wordpress_2", defaultVersionNumber: 2 },
    ],
  } as const;

  for (const [name, [schema, value]] of Object.entries(samples)) {
    it(`${name} parses and has no forbidden public key`, () => {
      expect(schema.safeParse(value).success).toBe(true);
      expect(findForbiddenPublicDtoKeys(value)).toEqual([]);
    });
  }

  it("refuses a validation error with a missing position key (nullable, not optional)", () => {
    expect(
      SiteTemplateValidationDtoSchema.safeParse({ valid: false, errors: [{ code: "x", message: "y" }], parameters: [], preview: null }).success,
    ).toBe(false);
  });
});
