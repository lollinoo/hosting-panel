import { z } from "zod";
import { APP_STACK_ID_PATTERN } from "./limits.js";

/** Any id of the application family (template, version, stack, revision, deployment, domain, secret). */
export const AppEntityIdSchema = z.string().regex(APP_STACK_ID_PATTERN);

/** Prefixes minted by the database (`newAppEntityId`) as `${prefix}_${24 lowercase hex}`. */
export const APP_ID_PREFIXES = Object.freeze({
  template: "atpl",
  templateVersion: "atv",
  stack: "stk",
  revision: "srev",
  deployment: "sdep",
  domain: "sdom",
  secret: "ssec",
} as const);
export type AppIdPrefix = (typeof APP_ID_PREFIXES)[keyof typeof APP_ID_PREFIXES];
