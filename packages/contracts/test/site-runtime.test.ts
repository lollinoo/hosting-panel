import { describe, expect, it } from "vitest";
import {
  AdminCreateSiteInputSchema,
  CreateManagedSiteInputSchema,
  SITE_DB_IDENTIFIER_PATTERN,
  isPlatformSecretKey,
  normalizeSiteDomain,
  resolveWordpressCliImage,
  resolveWordpressImage,
  resolveWordpressRuntime,
} from "../src/index.js";

const body = {
  name: "Hotel",
  domain: "Hotel.IT",
  title: "Hotel",
  adminUser: "owner",
  adminEmail: "a@hotel.it",
  adminPassword: "correct-horse-battery",
};

describe("site runtime", () => {
  it("resolveWordpressImage pins exact tags", () => {
    expect(resolveWordpressImage("8.4")).toBe("wordpress:7.1.4-php8.4-apache");
    expect(resolveWordpressCliImage("8.5")).toBe("wordpress:cli-2.12.0-php8.5");
    expect(resolveWordpressRuntime("8.3").image).toBe("wordpress:7.1.4-php8.3-apache");
  });

  it("normalizeSiteDomain", () => {
    expect(normalizeSiteDomain(" Hotel.IT. ")).toBe("hotel.it");
    for (const bad of ["localhost", "203.0.113.5", "*.hotel.it", "hotel..it", "a b.it", "[::1]", "-x.it", `${"a".repeat(250)}.it`]) {
      expect(normalizeSiteDomain(bad)).toBeNull();
    }
  });

  it("CreateManagedSiteInputSchema", () => {
    const ok = CreateManagedSiteInputSchema.parse(body);
    expect(ok.phpVersion).toBe("8.4");
    expect(ok.domain).toBe("hotel.it");
    const r = CreateManagedSiteInputSchema.safeParse({ ...body, adminPassword: "twelve-chars\nx" });
    expect(r.success).toBe(false);
    expect(!r.success && r.error.issues[0]?.path).toEqual(["adminPassword"]);
    expect(CreateManagedSiteInputSchema.safeParse({ ...body, phpVersion: "8.2" }).success).toBe(false);
    const bad = CreateManagedSiteInputSchema.safeParse({ ...body, domain: "localhost" });
    expect(!bad.success && bad.error.issues[0]?.path).toEqual(["domain"]);
    const title = 'L\'Hôtel "Bella" $(id)';
    expect(CreateManagedSiteInputSchema.parse({ ...body, title }).title).toBe(title);
  });

  it("AdminCreateSiteInputSchema accepts null owner", () => {
    expect(AdminCreateSiteInputSchema.parse({ ...body, ownerOrganizationId: null }).ownerOrganizationId).toBeNull();
  });

  it("SITE_DB_IDENTIFIER_PATTERN", () => {
    expect(SITE_DB_IDENTIFIER_PATTERN.test("wp_3f9a0c1b2d4e")).toBe(true);
    for (const b of ["wp-1", "Wp_x", "x"]) expect(SITE_DB_IDENTIFIER_PATTERN.test(b)).toBe(false);
  });

  it("isPlatformSecretKey", () => {
    for (const k of ["SITE_DB_PASSWORD", "WP_ADMIN_PASSWORD_INITIAL", "HP_X"]) expect(isPlatformSecretKey(k)).toBe(true);
    expect(isPlatformSecretKey("SMTP_PASSWORD")).toBe(false);
  });
});
