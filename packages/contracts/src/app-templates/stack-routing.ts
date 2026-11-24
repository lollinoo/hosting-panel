// Routing options of one web address of an application (ADR-0037): redirect to another address, password protection,
// compression and path rules. The customer chooses among closed options; the executor re-checks every value below.
import { z } from "zod";
import { SiteHostRouteSchema } from "../ipc-schemas.js";
import { AppStackKeySchema, AppStackPortSchema } from "./limits.js";
import { AppEntityIdSchema } from "./stack-ids.js";

/** Path rules per web address. */
export const MAX_APP_ROUTE_PATHS = 4;
export const APP_ROUTE_PATH_PREFIX_MAX = 64;
/** One to four segments, each starting with a letter or a digit: never "/", ".", ".." or "/.well-known". */
export const APP_ROUTE_PATH_PREFIX_PATTERN = /^(?:\/[A-Za-z0-9][A-Za-z0-9._~-]{0,31}){1,4}$/;
/** No colon: the proxy reads "name:verifier". */
export const APP_ROUTE_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const APP_ROUTE_PASSWORD_MIN = 12;
export const APP_ROUTE_PASSWORD_MAX = 128;
/** Printable ASCII only: browsers disagree on how they encode anything else in HTTP Basic. */
export const APP_ROUTE_PASSWORD_PATTERN = /^[\x20-\x7e]{12,128}$/;
/** `$apr1$<salt of 8>$<22 characters>`: the only verifier the executor writes into a route file. */
export const APP_ROUTE_PASSWORD_HASH_PATTERN = /^\$apr1\$[./0-9A-Za-z]{8}\$[./0-9A-Za-z]{22}$/;

const PathPrefixSchema = z.string().max(APP_ROUTE_PATH_PREFIX_MAX).regex(APP_ROUTE_PATH_PREFIX_PATTERN);
const UsernameSchema = z.string().regex(APP_ROUTE_USERNAME_PATTERN);
const uniquePrefixes = (paths: readonly { readonly pathPrefix: string }[]): boolean =>
  new Set(paths.map((p) => p.pathPrefix)).size === paths.length;

// ---- executor wire: one host of a route entry ----

/** A sub-path of a host sent to another ingress pair of the same plan. */
export const AppStackRoutePathSchema = z
  .object({ pathPrefix: PathPrefixSchema, componentKey: AppStackKeySchema, internalPort: AppStackPortSchema, stripPrefix: z.boolean() })
  .strict();
export type AppStackRoutePath = z.infer<typeof AppStackRoutePathSchema>;
/** Never the password: only its verifier travels, and only on the signed route request. */
export const AppStackRouteProtectionSchema = z
  .object({ username: UsernameSchema, passwordHash: z.string().regex(APP_ROUTE_PASSWORD_HASH_PATTERN) })
  .strict();
export type AppStackRouteProtection = z.infer<typeof AppStackRouteProtectionSchema>;
/**
 * A site host route plus the options. Every option is omitted when unset (`compress` is `true` or absent, `paths` has
 * one rule or is absent), so a host without options serialises exactly as before.
 */
export const AppStackHostRouteSchema = SiteHostRouteSchema.extend({
  compress: z.literal(true).optional(),
  protection: AppStackRouteProtectionSchema.optional(),
  paths: z.array(AppStackRoutePathSchema).min(1).max(MAX_APP_ROUTE_PATHS).optional(),
})
  .strict()
  .superRefine((host, ctx) => {
    if (host.redirectTo !== null && (host.compress !== undefined || host.protection !== undefined || host.paths !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["redirectTo"], message: "A redirecting host takes no other option" });
    }
    if (host.paths !== undefined && !uniquePrefixes(host.paths)) {
      ctx.addIssue({ code: "custom", path: ["paths"], message: "Duplicate path" });
    }
  });
export type AppStackHostRoute = z.infer<typeof AppStackHostRouteSchema>;

// ---- public DTO and input ----

export const AppStackDomainPathRouteSchema = z
  .object({ pathPrefix: PathPrefixSchema, componentKey: AppStackKeySchema, port: AppStackPortSchema, stripPrefix: z.boolean() })
  .strict();
export type AppStackDomainPathRoute = z.infer<typeof AppStackDomainPathRouteSchema>;
/** What a reader learns about the options of an address: the user name, never the password or its verifier. */
export const AppStackDomainRoutingDtoShape = {
  redirectToDomainId: AppEntityIdSchema.nullable(),
  compression: z.boolean(),
  protection: z.object({ username: z.string() }).nullable(),
  pathRoutes: z.array(AppStackDomainPathRouteSchema),
} as const;
/**
 * Replaces every option of the address. `protection.password` is write-only; leave it out to keep the password already
 * set (refused when none is).
 */
export const UpdateAppStackDomainInputSchema = z
  .object({
    redirectToDomainId: AppEntityIdSchema.nullable(),
    compression: z.boolean(),
    protection: z
      .object({ username: UsernameSchema, password: z.string().regex(APP_ROUTE_PASSWORD_PATTERN).optional() })
      .strict()
      .nullable(),
    pathRoutes: z.array(AppStackDomainPathRouteSchema).max(MAX_APP_ROUTE_PATHS),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.redirectToDomainId !== null && (input.protection !== null || input.pathRoutes.length > 0)) {
      ctx.addIssue({ code: "custom", path: ["redirectToDomainId"], message: "A redirecting address takes no other option." });
    }
    if (!uniquePrefixes(input.pathRoutes)) ctx.addIssue({ code: "custom", path: ["pathRoutes"], message: "Each path once." });
  });
export type UpdateAppStackDomainInput = z.infer<typeof UpdateAppStackDomainInputSchema>;
