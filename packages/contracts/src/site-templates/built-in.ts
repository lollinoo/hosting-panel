import type { SiteTypeKey } from "../site-types/keys.js";
import type { SiteTemplateSpec } from "./spec.js";

export const BUILT_IN_WORDPRESS_TEMPLATE_ID = "stpl_wordpress";
export const BUILT_IN_WORDPRESS_VERSION_ID = "stv_wordpress_1";
export const BUILT_IN_WORDPRESS_TEMPLATE_NAME = "WordPress";

/** The built-in template of each module. */
export const BUILT_IN_TEMPLATE_BY_MODULE: Readonly<Record<SiteTypeKey, string>> = { wordpress: BUILT_IN_WORDPRESS_TEMPLATE_ID };
/** The built-in version a site without template_version_id (a legacy site) counts as. */
export const BUILT_IN_VERSION_BY_MODULE: Readonly<Record<SiteTypeKey, string>> = { wordpress: BUILT_IN_WORDPRESS_VERSION_ID };

/**
 * Version 1 of the built-in WordPress template. The PHP versions are literals, not derived from
 * SUPPORTED_PHP_VERSIONS, because a stored version is immutable; the image follows the code pin.
 */
export const BUILT_IN_WORDPRESS_SOURCE = [
  "# Built-in WordPress site type. The image comes from the module pin of this release.",
  "x-hp-module: wordpress",
  "x-hp-parameters:",
  "  - key: php_version",
  "    label: Versione PHP",
  "    type: enum",
  '    options: ["8.3", "8.4", "8.5"]',
  '    default: "8.4"',
  "    customer: true",
  "services:",
  "  app:",
  "    image: ${HP_MODULE_IMAGE}",
  "    volumes:",
  "      - html:/var/www/html",
  "    expose:",
  '      - "80"',
  "    deploy:",
  "      resources:",
  "        limits:",
  '          cpus: "1.0"',
  "          memory: 512M",
  "volumes:",
  "  html: {}",
  "",
].join("\n");

/** What the validator makes of BUILT_IN_WORDPRESS_SOURCE (a policy-engine test keeps both equal). */
export const BUILT_IN_WORDPRESS_SPEC: SiteTemplateSpec = {
  specVersion: 1,
  module: "wordpress",
  parameters: [
    { key: "php_version", label: "Versione PHP", type: "enum", options: ["8.3", "8.4", "8.5"], default: "8.4", customer: true },
  ],
  service: {
    name: "app",
    image: "${HP_MODULE_IMAGE}",
    environment: [],
    volumes: [{ volume: "html", containerPath: "/var/www/html" }],
    expose: [80],
    limits: { cpuMilli: 1000, memoryBytes: "536870912" },
  },
  php: null,
};
