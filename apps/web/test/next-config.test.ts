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
});
