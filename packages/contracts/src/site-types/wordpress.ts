import type { SiteTypeDefinition } from "./definition.js";

export const WORDPRESS_SITE_TYPE = {
  key: "wordpress",
  templateId: "tpl_site_wordpress",
  files: { volumeSuffix: "html", mountPath: "/var/www/html", owner: "33:33" },
  database: { namePrefix: "wp" },
  heavyOperationKinds: ["site.wordpress.update", "site.wordpress.import"],
} as const satisfies SiteTypeDefinition;
