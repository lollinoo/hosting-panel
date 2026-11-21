// Boots one empty PGlite cluster (initdb, about 1.3 s) and saves its data directory for the test
// workers: each in-memory database then starts from a copy (about 0.3 s). See PGLITE_TEMPLATE_KEY.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgliteTemplatePath: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  // The root package does not depend on PGlite: load the database package's own copy.
  const require = createRequire(join(project.config.root, "packages/database/package.json"));
  const { PGlite } = (await import(require.resolve("@electric-sql/pglite"))) as typeof import("@electric-sql/pglite");
  const pglite = new PGlite();
  await pglite.waitReady;
  const template = await pglite.dumpDataDir("none");
  await pglite.close();

  const dir = await mkdtemp(join(tmpdir(), "hp-pglite-template-"));
  const path = join(dir, "template.tar");
  await writeFile(path, Buffer.from(await template.arrayBuffer()));
  project.provide("pgliteTemplatePath", path);
  return () => rm(dir, { recursive: true, force: true });
}
