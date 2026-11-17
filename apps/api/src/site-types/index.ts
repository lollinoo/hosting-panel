import { siteTypeKeyOf, type SiteTypeDefinition, type SiteTypeKey } from "@hosting-panel/contracts";
import type { SiteJobKind } from "@hosting-panel/executor-contracts";
import { WORDPRESS_API_SITE_TYPE } from "./wordpress.js";

/** A job in the site container; general code resolves the secrets, runs it and checks the exit code. */
export interface SiteTypeJob {
  readonly kind: SiteJobKind;
  readonly params: Readonly<Record<string, string>>;
  /** Env name to platform secret key. */
  readonly secrets?: Readonly<Record<string, string>>;
}

/** What the API does differently per site type (ADR 0029). */
export interface ApiSiteType {
  readonly definition: SiteTypeDefinition;
  image(phpVersion: string): string;
  /** The install step of site.provision (stored key, never renamed); null when the type installs nothing. */
  readonly install: {
    readonly step: string;
    readonly label: string;
    readonly done: string;
    /** First admin password, deleted when the setup finishes; null when there is none. */
    readonly adminSecretKey: string | null;
    job(input: {
      readonly phpVersion: string | null;
      readonly siteUrl: string;
      readonly database: { readonly dbName: string; readonly dbUser: string } | null;
      readonly hasAdminSecret: boolean;
      readonly field: (key: string) => string;
    }): SiteTypeJob;
  } | null;
  /** Job that moves the site to a new address; null when the type needs none. */
  addressJob(site: { readonly phpVersion: string | null }, siteUrl: string, previousUrl: string): SiteTypeJob | null;
  /** Customer text of the type's own file-error reasons. */
  readonly fileReasonMessages: Readonly<Record<string, string>>;
}

export const API_SITE_TYPES: Readonly<Record<SiteTypeKey, ApiSiteType>> = { wordpress: WORDPRESS_API_SITE_TYPE };
export const getApiSiteType = (key: SiteTypeKey): ApiSiteType => API_SITE_TYPES[key];
/** The edge of the API: null for null or a key this release does not know. */
export function findApiSiteType(value: string | null | undefined): ApiSiteType | null {
  const key = siteTypeKeyOf(value);
  return key ? API_SITE_TYPES[key] : null;
}
export const SITE_TYPE_FILE_REASON_MESSAGES: Readonly<Record<string, string>> = Object.assign(
  {},
  ...Object.values(API_SITE_TYPES).map((t) => t.fileReasonMessages),
);
