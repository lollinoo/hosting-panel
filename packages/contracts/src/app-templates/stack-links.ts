import { z } from "zod";
import { APP_STACK_COMPONENT_KEY_MAX, AppStackKeySchema, AppStackPortSchema } from "./limits.js";
import { AppEntityIdSchema, AppForeignIdSchema } from "./stack-ids.js";

// Standalone databases and private links (ADR-0039). A database is an application from a template of this category;
// a link lets one application of the same customer reach it, and nothing else.

/** An application from a template of this category is a database: other applications of its customer can be linked to it. */
export const APP_DATABASE_TEMPLATE_CATEGORY = "database";
/** Databases one application can be linked to. */
export const MAX_APP_STACK_LINKS_PER_APPLICATION = 4;
/** Applications one database can be linked to. */
export const MAX_APP_STACK_LINKS_PER_DATABASE = 8;

/** pending: recorded, not yet applied on the server (a side is not installed yet, or the last attempt did not go through).
 *  removing: the customer disconnected it; the row stays until the server confirms the database is detached. */
export const APP_STACK_LINK_STATES = ["pending", "active", "removing"] as const;
export const AppStackLinkStateSchema = z.enum(APP_STACK_LINK_STATES);
export type AppStackLinkState = z.infer<typeof AppStackLinkStateSchema>;

const LINK_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** The name a linked application reaches a database at: the database's id with "-" for "_". An id has no "-", so two
 *  ids never give the same name; the name is a DNS label, and it is longer than any component key, so it can never
 *  take the place of a component of the application it is attached to. null: this id cannot be linked. */
export function appStackLinkAlias(stackId: string): string | null {
  const alias = stackId.replaceAll("_", "-");
  return alias.length > APP_STACK_COMPONENT_KEY_MAX && LINK_ALIAS_PATTERN.test(alias) ? alias : null;
}

/** What a link points at: the only component, on the only port it listens on. null: not something to link to. */
export function appStackLinkTarget(
  components: readonly { readonly key: string; readonly expose: readonly number[] }[],
): { readonly componentKey: string; readonly port: number } | null {
  const [only, ...others] = components;
  if (only === undefined || others.length > 0 || only.expose.length !== 1) return null;
  return { componentKey: only.key, port: only.expose[0]! };
}

// ---- executor call ----

const unique = (ids: readonly string[]): boolean => new Set(ids).size === ids.length;

/** The whole desired state of one database: the applications whose private network its component is attached to.
 *  [] detaches it from every application. The executor derives every Docker name itself. */
export const AppStackLinksIpcRequestSchema = z
  .object({
    /** The database. */
    stackId: AppEntityIdSchema,
    organizationId: AppForeignIdSchema,
    componentKey: AppStackKeySchema.max(APP_STACK_COMPONENT_KEY_MAX),
    consumerStackIds: z.array(AppEntityIdSchema).max(MAX_APP_STACK_LINKS_PER_DATABASE).refine(unique, "Duplicate application"),
  })
  .strict()
  .superRefine((req, ctx) => {
    if (appStackLinkAlias(req.stackId) === null) ctx.addIssue({ code: "custom", path: ["stackId"], message: "This application cannot be linked" });
    if (req.consumerStackIds.includes(req.stackId)) {
      ctx.addIssue({ code: "custom", path: ["consumerStackIds"], message: "An application cannot be linked to itself" });
    }
  });
export type AppStackLinksIpcRequest = z.infer<typeof AppStackLinksIpcRequestSchema>;

/** pending: the application has no private network yet, or a change of it is running; nothing was done for it. */
export const APP_STACK_LINK_OUTCOMES = ["connected", "already_connected", "pending"] as const;
/** Detached networks reported back, at most. */
export const APP_STACK_LINKS_DISCONNECTED_MAX = 64;
export const AppStackLinksIpcResultSchema = z
  .object({
    /** false: the database has no component on the server yet; nothing was changed and every link is pending. */
    container: z.boolean(),
    links: z
      .array(z.object({ consumerStackId: AppEntityIdSchema, outcome: z.enum(APP_STACK_LINK_OUTCOMES) }).strict())
      .max(MAX_APP_STACK_LINKS_PER_DATABASE),
    /** Applications the component was attached to and is no longer; ids only, never a Docker id. */
    disconnected: z.array(AppEntityIdSchema).max(APP_STACK_LINKS_DISCONNECTED_MAX),
  })
  .strict();
export type AppStackLinksIpcResult = z.infer<typeof AppStackLinksIpcResultSchema>;

// ---- customer DTOs ----

const IsoDateTimeSchema = z.string().datetime({ offset: true });

/** Where a linked application reaches the database. Not reserved: it works only from a linked application. */
export const AppStackLinkConnectionDtoSchema = z.object({ host: z.string(), port: AppStackPortSchema });
export type AppStackLinkConnectionDto = z.infer<typeof AppStackLinkConnectionDtoSchema>;

export const AppStackLinkDtoSchema = z.object({
  id: AppEntityIdSchema,
  state: AppStackLinkStateSchema,
  createdAt: IsoDateTimeSchema,
  databaseStackId: AppEntityIdSchema,
  databaseName: z.string(),
  /** The name of the database's template ("Database MariaDB"). */
  databaseKind: z.string(),
  applicationStackId: AppEntityIdSchema,
  applicationName: z.string(),
  /** null: the database is no longer something to link to (its version has more than one component or port). */
  connection: AppStackLinkConnectionDtoSchema.nullable(),
});
export type AppStackLinkDto = z.infer<typeof AppStackLinkDtoSchema>;

export const APP_STACK_LINK_ROLES = ["database", "application"] as const;
export const AppStackLinksDtoSchema = z.object({
  stackId: AppEntityIdSchema,
  /** database: applications are linked to it. application: it is linked to databases. */
  role: z.enum(APP_STACK_LINK_ROLES),
  /** A database's own connection details; null for an application, and for a database nothing can be linked to. */
  connection: AppStackLinkConnectionDtoSchema.nullable(),
  /** role database: the applications that use it. role application: the databases it uses. */
  links: z.array(AppStackLinkDtoSchema),
  /** role application: the customer's databases it can still be connected to. Always [] for a database. */
  candidates: z.array(z.object({ stackId: AppEntityIdSchema, name: z.string(), kind: z.string() })),
  /** The cap that applies to this role. */
  limit: z.number().int().positive(),
});
export type AppStackLinksDto = z.infer<typeof AppStackLinksDtoSchema>;

export const CreateAppStackLinkInputSchema = z.object({ databaseStackId: AppEntityIdSchema }).strict();
export type CreateAppStackLinkInput = z.infer<typeof CreateAppStackLinkInputSchema>;
