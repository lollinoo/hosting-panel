import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "infra/**/*.test.ts"],
    // Tests that hash passwords take 3 to 5 s here and more on a CI runner: the default of 5 s cut them.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/web/src"),
    },
  },
});
