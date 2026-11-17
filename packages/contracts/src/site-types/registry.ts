import type { SiteTypeDefinition } from "./definition.js";
import { siteTypeKeyOf, type SiteTypeKey } from "./keys.js";
import { WORDPRESS_SITE_TYPE } from "./wordpress.js";

export const SITE_TYPES: Readonly<Record<SiteTypeKey, SiteTypeDefinition>> = { wordpress: WORDPRESS_SITE_TYPE };

export function getSiteType(key: SiteTypeKey): SiteTypeDefinition {
  return SITE_TYPES[key];
}

/** The edge of a layer: never throws; null means "not a managed site". */
export function findSiteType(value: string | null | undefined): SiteTypeDefinition | null {
  const key = siteTypeKeyOf(value);
  return key ? SITE_TYPES[key] : null;
}
