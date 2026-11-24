import path from "node:path";

/** @type {import("next").NextConfig} */
const nextConfig = {
  transpilePackages: ["@hosting-panel/contracts"],
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  poweredByHeader: false,
  skipTrailingSlashRedirect: true,
  async headers() {
    return [
      {
        // phpMyAdmin's pages and the relay's own pages send their framing, nosniff and referrer headers themselves
        source: "/((?!phpmyadmin/).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/:path*",
        headers: [
          // A browser ignores it over plain HTTP or on an IP address, so a panel without a certificate is unaffected.
          { key: "Strict-Transport-Security", value: "max-age=15552000" },
        ],
      },
    ];
  },
};

export default nextConfig;
