import { describe, expect, it } from "vitest";
import { AppStackDomainDtoSchema } from "../src/app-templates/stack-dto.js";
import { findForbiddenPublicDtoKeys } from "../src/resources.js";
import {
  APP_ROUTE_PASSWORD_HASH_PATTERN,
  APP_ROUTE_PASSWORD_MAX,
  APP_ROUTE_PASSWORD_MIN,
  APP_ROUTE_PATH_PREFIX_MAX,
  APP_ROUTE_PATH_PREFIX_PATTERN,
  APP_ROUTE_USERNAME_PATTERN,
  AppStackHostRouteSchema,
  MAX_APP_ROUTE_PATHS,
  UpdateAppStackDomainInputSchema,
} from "../src/app-templates/stack-routing.js";

const VERIFIER = "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/";
const HOST = { hostname: "shop.example.org", tls: true, httpsRedirect: true, redirectTo: null };
const PATH = { pathPrefix: "/api", componentKey: "api", internalPort: 3000, stripPrefix: true };
const INPUT = { redirectToDomainId: null, compression: false, protection: null, pathRoutes: [] };
const RULE = { pathPrefix: "/api", componentKey: "api", port: 3000, stripPrefix: false };
const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown): boolean => schema.safeParse(value).success;

describe("application routing options (ADR-0037)", () => {
  it("a path prefix is one to four plain segments and never a dot segment or a proxy rule character", () => {
    for (const good of ["/api", "/api/v1", "/a/b/c/d", "/Docs_2", "/x.y~z-1", "/0"]) {
      expect(APP_ROUTE_PATH_PREFIX_PATTERN.test(good), good).toBe(true);
    }
    const bad = [
      "", "/", "api", "/api/", "//api", "/.well-known", "/.well-known/acme-challenge", "/a/.b", "/..", "/a/../b", "/-a", "/_a",
      "/a b", "/a`b", '/a"b', "/a'b", "/a)b", "/a|b", "/a&b", "/a$b", "/a{b", "/a\\b", "/a\nb", "/a%2fb", "/a?b", "/a#b", "/à",
      "/a/b/c/d/e", `/${"a".repeat(33)}`,
    ];
    for (const value of bad) expect(APP_ROUTE_PATH_PREFIX_PATTERN.test(value), JSON.stringify(value)).toBe(false);
    expect(APP_ROUTE_PATH_PREFIX_MAX).toBe(64);
    expect(ok(AppStackHostRouteSchema, { ...HOST, paths: [{ ...PATH, pathPrefix: `/${"a".repeat(32)}/${"b".repeat(32)}` }] })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, paths: [{ ...PATH, pathPrefix: `/${"a".repeat(32)}/${"b".repeat(30)}` }] })).toBe(true);
  });

  it("a user name has no colon and a verifier is exactly an apr1 string", () => {
    for (const good of ["team", "a", "Mario.Rossi", "user_1-x", "0x"]) expect(APP_ROUTE_USERNAME_PATTERN.test(good), good).toBe(true);
    for (const value of ["", "a:b", ".a", "-a", "a b", "a@b", "a\n", "a".repeat(33), "à"]) {
      expect(APP_ROUTE_USERNAME_PATTERN.test(value), JSON.stringify(value)).toBe(false);
    }
    expect(APP_ROUTE_PASSWORD_HASH_PATTERN.test(VERIFIER)).toBe(true);
    const badVerifiers = [
      "", "plain", "{SHA}5en6G6MezRroT3XKqkdPOmY/BfQ=", "$2y$05$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234", `${VERIFIER}\n`, `${VERIFIER}x`,
      "$apr1$short$HqJZimcKQFAMYayBlzkrA/", "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA", '$apr1$r31.....$HqJZimcKQFAMYayBlzkr"/', "$apr1$r31..:..$HqJZimcKQFAMYayBlzkrA/",
    ];
    for (const value of badVerifiers) expect(APP_ROUTE_PASSWORD_HASH_PATTERN.test(value), JSON.stringify(value)).toBe(false);
  });

  it("a host without options parses to exactly what a site host route is", () => {
    expect(AppStackHostRouteSchema.parse(HOST)).toEqual(HOST);
    expect(Object.keys(AppStackHostRouteSchema.parse({ ...HOST, challenge: "dns-01" }))).toEqual([
      "hostname", "tls", "httpsRedirect", "redirectTo", "challenge",
    ]);
    expect(ok(AppStackHostRouteSchema, { ...HOST, unexpected: true })).toBe(false);
  });

  it("the wire takes each option only in its set form", () => {
    const full = { ...HOST, compress: true, protection: { username: "team", passwordHash: VERIFIER }, paths: [PATH] };
    expect(AppStackHostRouteSchema.parse(full)).toEqual(full);
    expect(ok(AppStackHostRouteSchema, { ...HOST, compress: false })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, paths: [] })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, paths: Array.from({ length: MAX_APP_ROUTE_PATHS }, (_, i) => ({ ...PATH, pathPrefix: `/p${String(i)}` })) })).toBe(true);
    expect(ok(AppStackHostRouteSchema, { ...HOST, paths: Array.from({ length: MAX_APP_ROUTE_PATHS + 1 }, (_, i) => ({ ...PATH, pathPrefix: `/p${String(i)}` })) })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, paths: [PATH, { ...PATH, internalPort: 3001 }] })).toBe(false); // same prefix twice
    expect(ok(AppStackHostRouteSchema, { ...HOST, paths: [{ ...PATH, extra: 1 }] })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, paths: [{ ...PATH, componentKey: "Api" }] })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, paths: [{ ...PATH, internalPort: 0 }] })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, protection: { username: "team" } })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, protection: { username: "team", passwordHash: "plain" } })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, protection: { username: "a:b", passwordHash: VERIFIER } })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...HOST, protection: { username: "team", passwordHash: VERIFIER, password: "x" } })).toBe(false);
  });

  it("a redirecting host takes no other option", () => {
    const redirect = { ...HOST, redirectTo: "https://www.example.org" };
    expect(ok(AppStackHostRouteSchema, redirect)).toBe(true);
    expect(ok(AppStackHostRouteSchema, { ...redirect, compress: true })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...redirect, protection: { username: "team", passwordHash: VERIFIER } })).toBe(false);
    expect(ok(AppStackHostRouteSchema, { ...redirect, paths: [PATH] })).toBe(false);
  });

  it("the update input replaces every option and bounds each one", () => {
    expect(UpdateAppStackDomainInputSchema.parse(INPUT)).toEqual(INPUT);
    for (const key of Object.keys(INPUT)) {
      const { [key]: _omitted, ...rest } = INPUT as Record<string, unknown>;
      expect(ok(UpdateAppStackDomainInputSchema, rest), key).toBe(false);
    }
    expect(ok(UpdateAppStackDomainInputSchema, { ...INPUT, hostname: "x.example.org" })).toBe(false);
    const full = { redirectToDomainId: null, compression: true, protection: { username: "team", password: "correct horse 12" }, pathRoutes: [RULE] };
    expect(UpdateAppStackDomainInputSchema.parse(full)).toEqual(full);
    expect(ok(UpdateAppStackDomainInputSchema, { ...INPUT, protection: { username: "team" } })).toBe(true); // keeps the password already set
    expect(ok(UpdateAppStackDomainInputSchema, { ...INPUT, protection: { username: "team", passwordHash: VERIFIER } })).toBe(false);
    expect(ok(UpdateAppStackDomainInputSchema, { ...INPUT, pathRoutes: [RULE, { ...RULE, port: 3001 }] })).toBe(false);
    expect(ok(UpdateAppStackDomainInputSchema, { ...INPUT, pathRoutes: [{ ...RULE, internalPort: 3000 }] })).toBe(false);
    expect(ok(UpdateAppStackDomainInputSchema, { ...INPUT, pathRoutes: Array.from({ length: 5 }, (_, i) => ({ ...RULE, pathPrefix: `/p${String(i)}` })) })).toBe(false);
  });

  it("a password is 12 to 128 printable ASCII characters", () => {
    const withPassword = (password: string) => ok(UpdateAppStackDomainInputSchema, { ...INPUT, protection: { username: "team", password } });
    expect([APP_ROUTE_PASSWORD_MIN, APP_ROUTE_PASSWORD_MAX]).toEqual([12, 128]);
    expect(withPassword("a".repeat(11))).toBe(false);
    expect(withPassword("a".repeat(12))).toBe(true);
    expect(withPassword("a".repeat(128))).toBe(true);
    expect(withPassword("a".repeat(129))).toBe(false);
    expect(withPassword("p@ss w0rd:with $igns!")).toBe(true);
    expect(withPassword("password-città")).toBe(false);
    expect(withPassword("line\nbreak-line")).toBe(false);
  });

  it("a redirecting address takes no protection and no path rule, compression aside", () => {
    const redirect = { ...INPUT, redirectToDomainId: "sdom_0123456789abcdef01234567" };
    expect(ok(UpdateAppStackDomainInputSchema, redirect)).toBe(true);
    expect(ok(UpdateAppStackDomainInputSchema, { ...redirect, compression: true })).toBe(true);
    expect(ok(UpdateAppStackDomainInputSchema, { ...redirect, protection: { username: "team" } })).toBe(false);
    expect(ok(UpdateAppStackDomainInputSchema, { ...redirect, pathRoutes: [RULE] })).toBe(false);
    expect(ok(UpdateAppStackDomainInputSchema, { ...INPUT, redirectToDomainId: "not an id" })).toBe(false);
  });

  it("the DTO of an address shows the user name and never a password or a verifier", () => {
    const dto = {
      id: "sdom_0123456789abcdef01234567", hostname: "shop.example.org", componentKey: "web", port: 8080, status: "active",
      certificateStatus: "active", certificateProblem: null, certificateExpiresAt: null, checkedAt: null, redirectToDomainId: null,
      compression: true, protection: { username: "team" }, pathRoutes: [RULE],
    };
    expect(AppStackDomainDtoSchema.parse(dto)).toEqual(dto);
    expect(findForbiddenPublicDtoKeys(dto)).toEqual([]);
    // zod drops what the schema does not name: a verifier handed to the DTO schema by mistake does not come out.
    const leaked = AppStackDomainDtoSchema.parse({ ...dto, protection: { username: "team", passwordHash: VERIFIER } });
    expect(JSON.stringify(leaked)).not.toContain("apr1");
  });
});
