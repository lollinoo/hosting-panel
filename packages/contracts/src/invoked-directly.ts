import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when the module at `importMetaUrl` is the process entry point. Both sides go through
 * realpath: Node resolves the main module's symlinks (e.g. /opt/hosting-panel/current), argv[1] keeps them.
 */
export function isInvokedDirectly(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(resolve(entry));
  } catch {
    return false;
  }
}
