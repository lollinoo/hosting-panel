import type { WebSiteType } from ".";
import { WordpressOverviewCard } from "./wordpress-overview-card";

export const PROVISION_STEPS = ["create_database", "deploy_site", "install_wordpress", "publish_site", "finish"] as const;

/** The web app's WordPress type: its tab, the WP Admin button, the setup steps, and the overview card. */
export const WORDPRESS_WEB_SITE_TYPE: WebSiteType = {
  available: (c) => c?.wordpressToolsAvailable === true,
  tabs: [{ key: "wordpress", path: "wordpress" }],
  headerAction: (o) => ({ href: `${o}/wp-admin/`, label: "wpAdmin" }),
  progressSteps: PROVISION_STEPS,
  OverviewCard: WordpressOverviewCard,
};
