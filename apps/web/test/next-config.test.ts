import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../next.config.mjs";

describe("next.config.mjs", () => {
  it("disables trailing-slash redirects so phpMyAdmin paths keep their trailing slash", () => {
    expect(nextConfig.skipTrailingSlashRedirect).toBe(true);
  });

  it("sends X-Frame-Options: DENY and CSP frame-ancestors 'none' on every non-phpMyAdmin path", async () => {
    expect(typeof nextConfig.headers).toBe("function");
    const rules = await nextConfig.headers?.();
    expect(Array.isArray(rules)).toBe(true);

    const frameRule = rules?.find((rule) =>
      rule.headers.some((h) => h.key.toLowerCase() === "x-frame-options")
    );
    expect(frameRule).toBeDefined();
    expect(frameRule?.source).toBe("/((?!phpmyadmin/).*)");
    expect(frameRule?.headers).toEqual(
      expect.arrayContaining([
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      ])
    );

    const matcher = getPathMatch(frameRule!.source);
    expect(matcher("/")).not.toBe(false);
    expect(matcher("/login")).not.toBe(false);
    expect(matcher("/sites/site-1/database")).not.toBe(false);
    expect(matcher("/phpmyadmin/site-1/")).toBe(false);
    expect(matcher("/phpmyadmin/site-1/index.php")).toBe(false);
  });

  // Every header the config sends on a path, in rule order, the way Next applies them.
  async function headersFor(path: string): Promise<Array<{ key: string; value: string }>> {
    const rules = (await nextConfig.headers?.()) ?? [];
    return rules
      .filter((rule) => getPathMatch(rule.source)(path) !== false)
      .flatMap((rule) => rule.headers);
  }

  it("sends nosniff, a same-origin referrer and HSTS without includeSubDomains on pages and /api/ (L45)", async () => {
    for (const path of ["/", "/sites/site-1/database", "/api/bff/orgs/org-1/sites"]) {
      const headers = await headersFor(path);
      expect(headers).toEqual(
        expect.arrayContaining([
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=15552000" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ])
      );
      // no answer carries the same header twice
      const keys = headers.map((h) => h.key.toLowerCase());
      expect(new Set(keys).size).toBe(keys.length);
    }
    const hsts = (await headersFor("/")).find((h) => h.key === "Strict-Transport-Security");
    // other hosts under the panel's domain are not the panel's to pin to HTTPS
    expect(hsts?.value).not.toMatch(/includeSubDomains|preload/i);
  });

  it("leaves phpMyAdmin's own nosniff and referrer headers alone and adds only HSTS there (L45)", async () => {
    // The relay's own pages and phpMyAdmin's pages already send nosniff and
    // Referrer-Policy: same-origin, and phpMyAdmin frames itself (SAMEORIGIN).
    // HSTS covers the whole host, and neither of them sends it.
    for (const path of ["/phpmyadmin/site-1/", "/phpmyadmin/site-1/index.php"]) {
      expect(await headersFor(path)).toEqual([
        { key: "Strict-Transport-Security", value: "max-age=15552000" },
      ]);
    }
  });
});
