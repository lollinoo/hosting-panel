import { resolveWordpressImage } from "@hosting-panel/contracts";

/** The version part of today's WordPress pin ("7.1.4"), read from the pin so a bump does not break the custom fixture. */
const PIN = /^wordpress:(\d+\.\d+\.\d+)-php8\.4-apache$/.exec(resolveWordpressImage("8.4"))?.[1];
if (!PIN) throw new Error("the WordPress image pin changed shape");

export interface CustomSourceOptions {
  /** WORDPRESS_DEBUG value, to make two sources differ. */
  readonly debug?: string;
  /** Memory limit of the service. */
  readonly memory?: string;
}

/**
 * A valid custom WordPress template: a literal pinned image that follows php_version, a customer parameter
 * (upload_limit), an admin-only one (admin_note), one environment variable, its own limits and a PHP settings block.
 */
export function customSource(options: CustomSourceOptions = {}): string {
  return [
    "x-hp-module: wordpress",
    "x-hp-parameters:",
    "  - key: php_version",
    "    label: PHP version",
    "    type: enum",
    '    options: ["8.4", "8.5"]',
    '    default: "8.4"',
    "    customer: true",
    "  - key: upload_limit",
    "    label: Upload limit",
    "    type: enum",
    '    options: ["16M", "64M"]',
    '    default: "16M"',
    "    customer: true",
    "  - key: admin_note",
    "    label: Admin note",
    "    type: string",
    "    default: x",
    "    customer: false",
    "services:",
    "  app:",
    `    image: wordpress:${PIN}-php\${php_version}-apache`,
    "    environment:",
    `      WORDPRESS_DEBUG: "${options.debug ?? "0"}"`,
    "    volumes:",
    "      - html:/var/www/html",
    "    expose:",
    '      - "80"',
    "    deploy:",
    "      resources:",
    "        limits:",
    '          cpus: "2.0"',
    `          memory: ${options.memory ?? "1024M"}`,
    "x-hp-php:",
    "  upload_max_filesize: 64M",
    "  post_max_size: 128M",
    "volumes:",
    "  html: {}",
    "",
  ].join("\n");
}
