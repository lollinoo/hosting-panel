import { createHash } from "node:crypto";
import { z } from "zod";
import { LEGACY_SITE_TYPE } from "./site-types/keys.js";
import { SITE_TYPES } from "./site-types/registry.js";

export const SITE_DATABASES_MAX = 10;
export const SITE_DATABASE_USERS_MAX = 10;
export const SITE_DATABASE_SUFFIX_PATTERN = /^[a-z0-9][a-z0-9_]{0,15}$/;
const PREFIXES = [...new Set(Object.values(SITE_TYPES).flatMap((t) => (t.database ? [t.database.namePrefix] : [])))].join("|");
export const SITE_DATABASE_PREFIX_PATTERN = new RegExp(`^(?:${PREFIXES})_[0-9a-f]{12}$`);
export const SITE_DATABASE_NAME_PATTERN = new RegExp(`^(?:${PREFIXES})_[0-9a-f]{12}(?:_[a-z0-9][a-z0-9_]{0,15})?$`);
export const SITE_DATABASE_CUSTOM_NAME_PATTERN = new RegExp(`^(?:${PREFIXES})_[0-9a-f]{12}_[a-z0-9][a-z0-9_]{0,15}$`);
export const SITE_DATABASE_SIGNON_USER_PATTERN = /^pma_[0-9a-f]{12}$/;
export const MYSQL_NATIVE_PASSWORD_HASH_PATTERN = /^\*[0-9A-F]{40}$/;

function siteHash12(siteId: string): string {
  return createHash("sha256").update(siteId).digest("hex").slice(0, 12);
}

/** Prefix of every database and user of a site; also the name of the site's own database and user. */
export function siteDatabasePrefix(siteId: string, namePrefix = SITE_TYPES[LEGACY_SITE_TYPE].database!.namePrefix): string {
  return `${namePrefix}_${siteHash12(siteId)}`;
}

/** The phpMyAdmin sign-on account, never the site's own user and never listed. */
export function siteDatabaseSignOnUser(siteId: string): string {
  return `pma_${siteHash12(siteId)}`;
}

export function siteDatabaseFullName(prefix: string, suffix: string): string {
  return `${prefix}_${suffix}`;
}

/** True when name is the site's own name or a valid custom name under its prefix. */
export function isSiteDatabaseName(prefix: string, name: string): boolean {
  if (name === prefix) {
    return true;
  }
  return (
    name.startsWith(`${prefix}_`) &&
    SITE_DATABASE_SUFFIX_PATTERN.test(name.slice(prefix.length + 1))
  );
}

/** MariaDB mysql_native_password hash: '*' + UPPER(SHA1(SHA1(password))). */
export function mysqlNativePasswordHash(password: string): string {
  // SHA-1 is MariaDB's mysql_native_password format, not a choice.
  const inner = createHash("sha1").update(password, "utf8").digest();
  return `*${createHash("sha1").update(inner).digest("hex").toUpperCase()}`;
}

export const SiteDatabaseSuffixSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(SITE_DATABASE_SUFFIX_PATTERN, { message: "invalid_name" });

export const CreateSiteDatabaseRequestSchema = z.object({ name: SiteDatabaseSuffixSchema }).strict();
export type CreateSiteDatabaseRequest = z.infer<typeof CreateSiteDatabaseRequestSchema>;

export const CreateSiteDatabaseUserRequestSchema = z
  .object({ name: SiteDatabaseSuffixSchema })
  .strict();
export type CreateSiteDatabaseUserRequest = z.infer<typeof CreateSiteDatabaseUserRequestSchema>;

const NameSchema = z.string().min(1).max(64);
const TemporaryPasswordSchema = z.string().regex(/^[A-Za-z0-9]{24,}$/);

export const SiteDatabaseDtoSchema = z
  .object({ name: NameSchema, primary: z.boolean(), sizeBytes: z.number().int().nonnegative() })
  .strict();
export type SiteDatabaseDto = z.infer<typeof SiteDatabaseDtoSchema>;

export const SiteDatabaseUserDtoSchema = z
  .object({ name: NameSchema, primary: z.boolean(), databases: z.array(NameSchema) })
  .strict();
export type SiteDatabaseUserDto = z.infer<typeof SiteDatabaseUserDtoSchema>;

export const SiteDatabasesDtoSchema = z
  .object({
    prefix: z.string().regex(SITE_DATABASE_PREFIX_PATTERN),
    databases: z.array(SiteDatabaseDtoSchema),
    users: z.array(SiteDatabaseUserDtoSchema),
    limits: z
      .object({ databases: z.number().int().positive(), users: z.number().int().positive() })
      .strict(),
    phpMyAdminAvailable: z.boolean(),
  })
  .strict();
export type SiteDatabasesDto = z.infer<typeof SiteDatabasesDtoSchema>;

export const SiteDatabaseCreatedDtoSchema = z.object({ database: SiteDatabaseDtoSchema }).strict();
export type SiteDatabaseCreatedDto = z.infer<typeof SiteDatabaseCreatedDtoSchema>;

export const SiteDatabaseUserCreatedDtoSchema = z
  .object({ user: SiteDatabaseUserDtoSchema, temporaryPassword: TemporaryPasswordSchema })
  .strict();
export type SiteDatabaseUserCreatedDto = z.infer<typeof SiteDatabaseUserCreatedDtoSchema>;

export const SiteDatabasePasswordResetDtoSchema = z
  .object({ temporaryPassword: TemporaryPasswordSchema })
  .strict();
export type SiteDatabasePasswordResetDto = z.infer<typeof SiteDatabasePasswordResetDtoSchema>;

/** API → BFF only; the BFF never relays it to the browser. */
export const SiteDatabaseSignOnDtoSchema = z
  .object({
    username: z.string().regex(SITE_DATABASE_SIGNON_USER_PATTERN),
    temporaryPassword: TemporaryPasswordSchema,
  })
  .strict();
export type SiteDatabaseSignOnDto = z.infer<typeof SiteDatabaseSignOnDtoSchema>;
