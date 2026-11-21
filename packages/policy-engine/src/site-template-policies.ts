/**
 * What a site template may do for each site type module. The facts the code owns (mount, port, PHP versions, default
 * limits) are read from `SITE_TEMPLATE_MODULES`, never copied; this table adds only the rules the validator enforces.
 * It stays out of `SiteTypeDefinition`, which every layer reads and a boundary test scans.
 */
import { SITE_TEMPLATE_MODULES, type SiteTypeKey } from "@hosting-panel/contracts";

export interface SiteTemplateModulePolicy {
  readonly module: SiteTypeKey;
  /** The enum parameter that selects the runtime variant (a part of the image tag); null when the module has none. */
  readonly variantParameter: { readonly key: string; readonly options: readonly string[] } | null;
  /** Exact repository (no registry, no digest); the tag must match `tagPattern(variant)`. */
  readonly image: { readonly repository: string; readonly tagPattern: (variant: string | null) => RegExp };
  readonly limits: { readonly minCpuMilli: number; readonly minMemoryBytes: bigint };
  /** False: only the module's required mount. */
  readonly extraVolumes: boolean;
  /** `x-hp-php` allowed. */
  readonly phpSettings: boolean;
  readonly maxCustomerParameters: number;
}

const NEVER_MATCHES = /(?!)/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const SITE_TEMPLATE_POLICIES: Readonly<Record<SiteTypeKey, SiteTemplateModulePolicy>> = {
  wordpress: {
    module: "wordpress",
    variantParameter: { key: "php_version", options: SITE_TEMPLATE_MODULES.wordpress.phpVersions },
    image: {
      repository: "wordpress",
      // Three-component pin: `php8.4-apache`, `6.9-php8.4-apache` and `latest` float, so they are refused.
      tagPattern: (variant) =>
        variant === null ? NEVER_MATCHES : new RegExp(`^[0-9]+\\.[0-9]+\\.[0-9]+-php${escapeRegExp(variant)}-apache$`),
    },
    limits: { minCpuMilli: 100, minMemoryBytes: 134217728n },
    extraVolumes: false,
    phpSettings: true,
    maxCustomerParameters: 8,
  },
};

export function getSiteTemplatePolicy(module: SiteTypeKey): SiteTemplateModulePolicy {
  return SITE_TEMPLATE_POLICIES[module];
}
