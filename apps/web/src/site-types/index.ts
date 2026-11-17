import { siteTypeKeyOf, type PlatformCapabilitiesDto, type SiteTypeKey } from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";
import { WORDPRESS_WEB_SITE_TYPE } from "./wordpress";

/** What the web app shows differently per site type (ADR 0029). */
export interface WebSiteType {
  /** Whether the server has this type's tools (its tabs and card show only then). */
  available(capabilities: PlatformCapabilitiesDto | null | undefined): boolean;
  readonly tabs: readonly { readonly key: keyof Messages["site"]["tabs"]; readonly path: string }[];
  headerAction(origin: string): { readonly href: string; readonly label: "wpAdmin" } | null;
  readonly progressSteps: readonly (keyof Messages["site"]["progress"])[];
  readonly OverviewCard: ((props: { orgId: string; siteId: string; m: Messages; when: Intl.DateTimeFormat }) => Promise<React.ReactNode>) | null;
}
export const WEB_SITE_TYPES: Readonly<Record<SiteTypeKey, WebSiteType>> = { wordpress: WORDPRESS_WEB_SITE_TYPE };
/** The web module of a stored type; null for null or a key this release does not know. */
export const findWebSiteType = (v: string | null): WebSiteType | null => {
  const k = siteTypeKeyOf(v);
  return k ? WEB_SITE_TYPES[k] : null;
};
