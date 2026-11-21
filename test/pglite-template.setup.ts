// Publishes the empty-cluster template on globalThis for createDatabaseClient (PGLITE_TEMPLATE_KEY).
// Read on first use only, so test files without a database never load the 40 MB file.
import { readFileSync } from "node:fs";
import { inject } from "vitest";

const KEY = Symbol.for("hosting-panel.pglite-template");
const path = inject("pgliteTemplatePath");
let template: Blob | undefined;

Object.defineProperty(globalThis, KEY, {
  configurable: true,
  get: () => (template ??= new Blob([readFileSync(path)])),
});
