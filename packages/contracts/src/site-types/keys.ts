import { z } from "zod";

/** Every site type this release knows (ADR 0029 step 1). */
export const SITE_TYPE_KEYS = ["wordpress"] as const;
export type SiteTypeKey = (typeof SITE_TYPE_KEYS)[number];
export const SiteTypeKeySchema = z.enum(SITE_TYPE_KEYS);
/** The type of every site and stored payload from before migration 0018. */
export const LEGACY_SITE_TYPE: SiteTypeKey = "wordpress";

/** A stored or received value as a known key; null for null or a value this release does not know. */
export function siteTypeKeyOf(value: string | null | undefined): SiteTypeKey | null {
  return (SITE_TYPE_KEYS as readonly string[]).includes(value ?? "") ? (value as SiteTypeKey) : null;
}
