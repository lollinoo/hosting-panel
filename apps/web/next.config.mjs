import path from "node:path";

/** @type {import("next").NextConfig} */
const nextConfig = {
  transpilePackages: ["@hosting-panel/contracts"],
  outputFileTracingRoot: path.resolve(import.meta.dirname, "../.."),
  poweredByHeader: false,
};

export default nextConfig;
