import {
  DEFAULT_PHP_VERSION,
  SUPPORTED_PHP_VERSIONS,
  resolveWordpressImage,
  resolveWordpressRuntime,
  type PhpVersion,
} from "../site-runtime.js";
import type { SiteTypeKey } from "../site-types/keys.js";
import { WORDPRESS_SITE_TYPE } from "../site-types/wordpress.js";

/** What the code decides about a site type module; a template can only choose within these facts. */
export interface SiteTemplateModuleFacts {
  readonly key: SiteTypeKey;
  /** The service_templates row of the module. */
  readonly serviceTemplateId: string;
  /** The service instance name of every site of the module. The spec's service.name is only a label. */
  readonly serviceName: string;
  /** The image of a PHP version; throws RangeError for a version not in phpVersions. */
  readonly image: (phpVersion: string) => string;
  readonly phpVersions: readonly string[];
  readonly requiredMount: { readonly name: string; readonly target: string };
  readonly internalPort: number;
  readonly exposeHttp: boolean;
  readonly siteMail: boolean;
  readonly defaultLimits: { readonly cpuMilli: number; readonly memoryBytes: string };
}

const isPhpVersion = (value: string): value is PhpVersion => (SUPPORTED_PHP_VERSIONS as readonly string[]).includes(value);
const wordpressLimits = resolveWordpressRuntime(DEFAULT_PHP_VERSION).resourceLimits;

/** Typed as a Record over SITE_TYPE_KEYS: a new key without facts does not compile. */
export const SITE_TEMPLATE_MODULES: Readonly<Record<SiteTypeKey, SiteTemplateModuleFacts>> = {
  wordpress: {
    key: "wordpress",
    serviceTemplateId: WORDPRESS_SITE_TYPE.templateId,
    serviceName: "web",
    image: (phpVersion) => {
      if (!isPhpVersion(phpVersion)) throw new RangeError(`Unsupported PHP version '${phpVersion}'`);
      return resolveWordpressImage(phpVersion);
    },
    phpVersions: SUPPORTED_PHP_VERSIONS,
    requiredMount: { name: WORDPRESS_SITE_TYPE.files.volumeSuffix, target: WORDPRESS_SITE_TYPE.files.mountPath },
    internalPort: 80,
    exposeHttp: true,
    siteMail: true,
    defaultLimits: { cpuMilli: wordpressLimits.cpuMilli, memoryBytes: wordpressLimits.memoryBytes },
  },
};

export function getSiteTemplateModule(key: SiteTypeKey): SiteTemplateModuleFacts {
  return SITE_TEMPLATE_MODULES[key];
}
