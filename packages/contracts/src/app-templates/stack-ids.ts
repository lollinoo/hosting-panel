import { z } from "zod";
import { APP_FOREIGN_ID_PATTERN, APP_STACK_ID_PATTERN } from "./limits.js";

/** Any id of the application family (template, version, stack, revision, deployment, domain, secret, backup, link). */
export const AppEntityIdSchema = z.string().regex(APP_STACK_ID_PATTERN);
/** The id of an entity this feature does not mint (organisation, host allocation). */
export const AppForeignIdSchema = z.string().regex(APP_FOREIGN_ID_PATTERN);

/** Prefixes minted by the database (`newAppEntityId`) as `${prefix}_${24 lowercase hex}`. */
export const APP_ID_PREFIXES = Object.freeze({
  template: "atpl",
  templateVersion: "atv",
  stack: "stk",
  revision: "srev",
  deployment: "sdep",
  domain: "sdom",
  secret: "ssec",
  backup: "sbak",
  backupCopy: "sbkc",
  link: "slnk",
} as const);
export type AppIdPrefix = (typeof APP_ID_PREFIXES)[keyof typeof APP_ID_PREFIXES];
