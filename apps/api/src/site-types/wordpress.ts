import { DEFAULT_PHP_VERSION, WORDPRESS_SITE_TYPE, resolveWordpressImage } from "@hosting-panel/contracts";
import type { ApiSiteType } from "./index.js";

/** WordPress's steps and jobs in the API, moved from the provisioner, the appliers and the files service. */
export const WORDPRESS_API_SITE_TYPE: ApiSiteType = {
  definition: WORDPRESS_SITE_TYPE,
  image: resolveWordpressImage,
  install: {
    step: "install_wordpress",
    label: "Install WordPress",
    done: "WordPress installed",
    adminSecretKey: "WP_ADMIN_PASSWORD_INITIAL",
    job: ({ phpVersion, siteUrl, database, hasAdminSecret, field }) => ({
      kind: "wordpress.install",
      params: {
        ...database,
        phpVersion: phpVersion!,
        siteUrl,
        title: field("title"),
        adminUser: field("adminUser"),
        adminEmail: field("adminEmail"),
      },
      secrets: {
        HP_DB_PASSWORD: "SITE_DB_PASSWORD",
        ...(hasAdminSecret ? { HP_ADMIN_PASSWORD: "WP_ADMIN_PASSWORD_INITIAL" } : {}),
      },
    }),
  },
  addressJob: (site, siteUrl, previousUrl) => ({
    kind: "wordpress.set-url",
    params: { phpVersion: site.phpVersion ?? DEFAULT_PHP_VERSION, siteUrl, previousUrl },
  }),
  // The DB_PASSWORD define of wp-config.php; exit 20 when the file does not hold exactly one.
  databasePasswordJob: {
    job: (site) => ({
      kind: "wordpress.settle",
      params: { phpVersion: site.phpVersion ?? DEFAULT_PHP_VERSION },
      secrets: { HP_DB_PASSWORD: "SITE_DB_PASSWORD" },
    }),
    unwritableExitCode: 20,
  },
  fileReasonMessages: { archive_not_wordpress: "The archive does not contain a WordPress site." },
};
