import { z } from "zod";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const EntityIdSchema = z.string().min(1).max(128);

export const SUPPORTED_PHP_VERSIONS = ["8.3", "8.4", "8.5"] as const;
export type PhpVersion = (typeof SUPPORTED_PHP_VERSIONS)[number];
export const DEFAULT_PHP_VERSION: PhpVersion = "8.4";

export const SHARED_MARIADB_IMAGE = "mariadb:12.3.3";
export const resolveWordpressImage = (php: PhpVersion): string => `wordpress:7.1.4-php${php}-apache`;
export const resolveWordpressCliImage = (php: PhpVersion): string => `wordpress:cli-2.12.0-php${php}`;

export function resolveWordpressRuntime(php: PhpVersion) {
  return {
    image: resolveWordpressImage(php),
    internalPort: 80 as const,
    contentPath: "/var/www/html" as const,
    volumeSuffix: "html" as const,
    resourceLimits: { cpuMilli: 1000 as const, memoryBytes: "536870912" as const },
  };
}

export const SITE_DB_IDENTIFIER_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;
export const PLATFORM_SECRET_KEYS = ["SITE_DB_PASSWORD", "WP_ADMIN_PASSWORD_INITIAL"] as const;
export const isPlatformSecretKey = (key: string): boolean =>
  (PLATFORM_SECRET_KEYS as readonly string[]).includes(key) || key.startsWith("HP_");

const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeSiteDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  if (d.endsWith(".")) d = d.slice(0, -1);
  if (d.length === 0 || d.length > 253 || !d.includes(".")) return null;
  const labels = d.split(".");
  if (!labels.every((l) => DOMAIN_LABEL.test(l))) return null;
  // all-numeric TLD means an IPv4 literal
  if (/^[0-9]+$/.test(labels[labels.length - 1]!)) return null;
  return d;
}

export const CreateManagedSiteInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  domain: z.string().transform((v, ctx) => {
    const n = normalizeSiteDomain(v);
    if (n === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid domain", path: [] });
      return z.NEVER;
    }
    return n;
  }),
  phpVersion: z.enum(SUPPORTED_PHP_VERSIONS).default(DEFAULT_PHP_VERSION),
  title: z.string().min(1).max(120),
  adminUser: z.string().regex(/^[A-Za-z0-9._@-]{3,60}$/),
  adminEmail: z.string().email(),
  adminPassword: z
    .string()
    .min(12)
    .max(128)
    .regex(/^[^\r\n\0]*$/, "Password contains forbidden characters"),
});
export type CreateManagedSiteInput = z.infer<typeof CreateManagedSiteInputSchema>;

export const AdminCreateSiteInputSchema = CreateManagedSiteInputSchema.extend({
  ownerOrganizationId: EntityIdSchema.nullable(),
});
export type AdminCreateSiteInput = z.infer<typeof AdminCreateSiteInputSchema>;

export const ChangeSiteOwnerInputSchema = z.object({ ownerOrganizationId: EntityIdSchema.nullable() });
export type ChangeSiteOwnerInput = z.infer<typeof ChangeSiteOwnerInputSchema>;

export const SiteActionInputSchema = z.object({ action: z.enum(["start", "stop", "restart", "retry"]) });
export type SiteActionInput = z.infer<typeof SiteActionInputSchema>;

export const ChangeSiteRuntimeInputSchema = z.object({ phpVersion: z.enum(SUPPORTED_PHP_VERSIONS) });
export type ChangeSiteRuntimeInput = z.infer<typeof ChangeSiteRuntimeInputSchema>;

export const DeleteSiteInputSchema = z.object({ confirmName: z.string() });
export type DeleteSiteInput = z.infer<typeof DeleteSiteInputSchema>;

export const SiteLogLineDtoSchema = z.object({
  at: IsoDateTimeSchema.nullable(),
  stream: z.enum(["stdout", "stderr"]),
  text: z.string(),
});
export type SiteLogLineDto = z.infer<typeof SiteLogLineDtoSchema>;
