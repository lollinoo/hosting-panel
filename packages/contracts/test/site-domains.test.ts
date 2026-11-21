import { describe, expect, it } from "vitest";
import {
  AddSiteDomainInputSchema,
  CERT_PROBLEMS,
  CreateManagedSiteInputSchema,
  SetDomainChallengeInputSchema,
  SiteDomainDtoSchema,
  SiteHostRouteSchema,
  isSiteOrigin,
  suggestWwwPair,
  wwwPartner,
} from "../src/index.js";

describe("site domains", () => {
  it("wwwPartner pairs bare and www", () => {
    expect(wwwPartner("hotel.it")).toBe("www.hotel.it");
    expect(wwwPartner("www.hotel.it")).toBe("hotel.it");
    expect(wwwPartner("blog.hotel.it")).toBe("www.blog.hotel.it");
    expect(wwwPartner("www.it")).toBeNull();
  });

  it("suggestWwwPair is true for two labels or www", () => {
    expect(suggestWwwPair("hotel.it")).toBe(true);
    expect(suggestWwwPair("www.blog.hotel.it")).toBe(true);
    expect(suggestWwwPair("blog.hotel.it")).toBe(false);
    expect(suggestWwwPair("www.hotel.it")).toBe(true);
  });

  it("isSiteOrigin accepts only scheme plus host", () => {
    expect(isSiteOrigin("https://hotel.it")).toBe(true);
    expect(isSiteOrigin("http://www.hotel.it")).toBe(true);
    for (const bad of [
      "https://hotel.it/",
      "https://hotel.it:8443",
      "https://a@hotel.it",
      "ftp://hotel.it",
      "https://Hotel.it",
      "https://hotel.it\n",
    ]) {
      expect(isSiteOrigin(bad), bad).toBe(false);
    }
  });

  it("AddSiteDomainInputSchema normalizes and defaults includeWww to false", () => {
    expect(AddSiteDomainInputSchema.parse({ hostname: "Hotel.IT." })).toEqual({
      hostname: "hotel.it",
      includeWww: false,
    });
  });

  it("create keeps includeWww false by default", () => {
    const r = CreateManagedSiteInputSchema.parse({
      name: "n",
      domain: "hotel.it",
      title: "t",
      adminUser: "admin",
      adminEmail: "a@b.it",
      adminPassword: "password-12345",
    });
    expect(r.includeWww).toBe(false);
  });

  it("an accented name is converted to punycode", () => {
    const expected = new URL("http://caffè.it").hostname;
    expect(expected).toContain("xn--");
    expect(AddSiteDomainInputSchema.parse({ hostname: "Caffè.it" }).hostname).toBe(expected);
    expect(AddSiteDomainInputSchema.safeParse({ hostname: "caffè.it/x" }).success).toBe(false);
  });

  it("rejects input the URL parser would silently rewrite or read as an IP", () => {
    for (const bad of [
      "caffè.it\\x",
      "caff%C3%A8.it",
      "caffè.it\t",
      "caf\tfè.it",
      "*.hotel.it",
      "1.2.3.4",
      "1.2.3.0x4",
      "１２７.０.０.１",
    ]) {
      expect(AddSiteDomainInputSchema.safeParse({ hostname: bad }).success, bad).toBe(false);
    }
  });

  it("CERT_PROBLEMS includes dns_provider", () => {
    expect(CERT_PROBLEMS).toEqual(["rate_limited", "port_80_blocked", "not_pointing", "caa_blocked", "dns_provider", "other"]);
  });

  it("SiteHostRouteSchema keeps challenge and accepts routes without it", () => {
    const route = { hostname: "hotel.it", tls: true, httpsRedirect: true, redirectTo: null };
    expect(SiteHostRouteSchema.parse({ ...route, challenge: "dns-01" })).toEqual({ ...route, challenge: "dns-01" });
    expect(SiteHostRouteSchema.parse(route)).toEqual(route);
    expect(SiteHostRouteSchema.safeParse({ ...route, challenge: "tls-alpn-01" }).success).toBe(false);
    expect(Object.keys(SiteDomainDtoSchema.shape)).toEqual(
      ["id", "hostname", "isPrimary", "routed", "challenge", "dns", "certificate", "tls"],
    );
  });

  it("SetDomainChallengeInputSchema accepts only http-01 and dns-01", () => {
    expect(SetDomainChallengeInputSchema.parse({ challenge: "http-01" })).toEqual({ challenge: "http-01" });
    expect(SetDomainChallengeInputSchema.parse({ challenge: "dns-01" })).toEqual({ challenge: "dns-01" });
    for (const bad of [{ challenge: "tls-alpn-01" }, {}, { challenge: null }]) {
      expect(SetDomainChallengeInputSchema.safeParse(bad).success).toBe(false);
    }
  });
});
