import type { SiteTypeKey } from "@hosting-panel/contracts";
import { buildSiteFilesProgram, writeSiteFilesProgram } from "../site-files-program.js";
import { ExecutorCodedError } from "../traefik-config.js";
import type { ExecutorSiteType } from "./types.js";
import { WORDPRESS_EXECUTOR_SITE_TYPE } from "./wordpress.js";

export type { ExecutorSiteType } from "./types.js";
export { WORDPRESS_EXECUTOR_SITE_TYPE } from "./wordpress.js";

export const EXECUTOR_SITE_TYPES: Readonly<Record<SiteTypeKey, ExecutorSiteType>> = {
  wordpress: WORDPRESS_EXECUTOR_SITE_TYPE,
};

/** The executor's type for a key; an unknown key is refused. */
export function resolveExecutorSiteType(key: SiteTypeKey): ExecutorSiteType {
  if (!Object.hasOwn(EXECUTOR_SITE_TYPES, key)) {
    throw new ExecutorCodedError("Unknown site type", "VALIDATION_ERROR");
  }
  return EXECUTOR_SITE_TYPES[key];
}

/** The files program of the legacy type, under its shipped name. */
export const SITE_FILES_PROGRAM: string = buildSiteFilesProgram(WORDPRESS_EXECUTOR_SITE_TYPE);

/** Writes the files program of every type into `dir`. */
export async function ensureSiteFilesProgram(dir: string): Promise<void> {
  for (const t of Object.values(EXECUTOR_SITE_TYPES)) await writeSiteFilesProgram(dir, t);
}
