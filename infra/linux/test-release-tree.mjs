// Test helper: a release tree as build-release.mjs stages it, with infra, VERSION and IMAGES only.
import { cpSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Writes <dir>/hosting-panel-<version> and returns its path. */
export function writeReleaseTree(dir, version, images) {
  const root = path.join(dir, `hosting-panel-${version}`);
  cpSync(path.join(repo, "infra/systemd"), path.join(root, "infra/systemd"), { recursive: true });
  cpSync(path.join(repo, "infra/linux"), path.join(root, "infra/linux"), { recursive: true, filter: (s) => !s.endsWith(".test.ts") });
  writeFileSync(path.join(root, "VERSION"), `${version}\n`);
  writeFileSync(path.join(root, "IMAGES"), `${images.join("\n")}\n`);
  return root;
}
