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
    // One initdb per run instead of one per in-memory database (PGLITE_TEMPLATE_KEY in packages/database).
    globalSetup: ["test/pglite-template.global-setup.ts"],
    setupFiles: ["test/pglite-template.setup.ts"],
    // With --changed (PUSH_VERIFY_CMD in .devflow/config) a change to one of these runs every test:
    // the tests import the built packages, and the infra tests start the scripts as programs,
    // so the import graph does not link these files to the tests that cover them.
    forceRerunTriggers: [
      "**/package.json",
      "**/{vitest,vite}.config.*",
      "**/pnpm-lock.yaml",
      "**/packages/*/src/**",
      "**/packages/database/migrations/**",
      "**/infra/**",
      "**/test/pglite-template.*",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "apps/web/src"),
    },
  },
});
