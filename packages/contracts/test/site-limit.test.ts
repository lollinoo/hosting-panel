import { describe, expect, it } from "vitest";
import {
  AdminSitesListDtoSchema,
  ERROR_CODES,
  MAX_SITES_CEILING,
  OrganizationDetailDtoSchema,
  OrganizationSiteLimitDtoSchema,
  SITE_LIMIT_REACHED_REASON,
  UpdateOrganizationSiteLimitInputSchema,
} from "../src/index.js";

const NOW = "2026-11-21T10:00:00.000Z";

const organizationDetail = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  status: "active",
  createdAt: NOW,
  updatedAt: NOW,
  capabilities: {
    hostingMode: "dedicated",
    sharedHostingEnabled: false,
    dockerExecutorRuntimeAvailable: true,
    hostAgentRuntimeAvailable: true,
    acmeTlsRuntimeAvailable: true,
    sftpAvailable: true,
    phpMyAdminAvailable: true,
    productionBackupRuntimeAvailable: true,
    wordpressToolsAvailable: true,
  },
  siteCount: 2,
  serviceCount: 0,
  maxSites: 5,
};

const adminSitesList = {
  sites: [],
  customers: [{ organizationId: "org_1", name: "Acme", ownerEmail: "owner@acme.test", maxSites: 5, siteCount: 2 }],
  certificateAlerts: [],
};

describe("site limit contracts", () => {
  it("pins the reason string and the ceiling", () => {
    expect(SITE_LIMIT_REACHED_REASON).toBe("site_limit_reached");
    expect(MAX_SITES_CEILING).toBe(10_000);
  });

  it("adds no error code for the limit", () => {
    expect(ERROR_CODES).toContain("QUOTA_EXCEEDED");
    expect(ERROR_CODES).not.toContain("SITE_LIMIT_REACHED");
  });

  describe("UpdateOrganizationSiteLimitInputSchema", () => {
    it.each([0, 5, 10_000, null])("accepts maxSites %s", (maxSites) => {
      expect(UpdateOrganizationSiteLimitInputSchema.parse({ maxSites })).toEqual({ maxSites });
    });

    it.each([-1, 1.5, "3", 10_001, undefined, Number.NaN, Infinity])("rejects maxSites %s", (maxSites) => {
      expect(UpdateOrganizationSiteLimitInputSchema.safeParse({ maxSites }).success).toBe(false);
    });

    it("requires the key and refuses extra keys", () => {
      expect(UpdateOrganizationSiteLimitInputSchema.safeParse({}).success).toBe(false);
      expect(UpdateOrganizationSiteLimitInputSchema.safeParse({ maxSites: 1, extra: true }).success).toBe(false);
    });
  });

  it("OrganizationSiteLimitDtoSchema carries the limit and the usage", () => {
    const dto = { organizationId: "org_1", maxSites: null, usedSites: 3 };
    expect(OrganizationSiteLimitDtoSchema.parse(dto)).toEqual(dto);
    expect(OrganizationSiteLimitDtoSchema.parse({ ...dto, maxSites: 3 }).maxSites).toBe(3);
    expect(OrganizationSiteLimitDtoSchema.safeParse({ ...dto, usedSites: -1 }).success).toBe(false);
    expect(OrganizationSiteLimitDtoSchema.safeParse({ organizationId: "org_1", maxSites: null }).success).toBe(false);
  });

  it("OrganizationDetailDtoSchema carries a nullable maxSites", () => {
    expect(OrganizationDetailDtoSchema.parse(organizationDetail).maxSites).toBe(5);
    expect(OrganizationDetailDtoSchema.parse({ ...organizationDetail, maxSites: null }).maxSites).toBeNull();
    const { maxSites: _omitted, ...withoutLimit } = organizationDetail;
    expect(OrganizationDetailDtoSchema.safeParse(withoutLimit).success).toBe(false);
    expect(OrganizationDetailDtoSchema.safeParse({ ...organizationDetail, maxSites: -1 }).success).toBe(false);
  });

  it("AdminSitesListDtoSchema customers carry maxSites and siteCount", () => {
    expect(AdminSitesListDtoSchema.parse(adminSitesList).customers[0]).toMatchObject({ maxSites: 5, siteCount: 2 });
    const unlimited = { ...adminSitesList, customers: [{ ...adminSitesList.customers[0]!, maxSites: null }] };
    expect(AdminSitesListDtoSchema.parse(unlimited).customers[0]?.maxSites).toBeNull();
    const { siteCount: _count, ...noCount } = adminSitesList.customers[0]!;
    expect(AdminSitesListDtoSchema.safeParse({ ...adminSitesList, customers: [noCount] }).success).toBe(false);
    const { maxSites: _max, ...noMax } = adminSitesList.customers[0]!;
    expect(AdminSitesListDtoSchema.safeParse({ ...adminSitesList, customers: [noMax] }).success).toBe(false);
  });
});
