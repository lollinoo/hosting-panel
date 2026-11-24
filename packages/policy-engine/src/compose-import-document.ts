/**
 * The Compose file as the importer reads it: the YAML subset of a template (no anchor, tag or block scalar) within the
 * same size bound, so one reader and one set of limits protect both. Also the small helpers every importer module
 * shares. Pure, synchronous and never throws.
 */
import {
  TEMPLATE_SOURCE_MAX_BYTES,
  appStackImageLookupProblem,
  parseTemplateYaml,
  type YamlErrorCode,
} from "@hosting-panel/contracts";
import { parseImageReference } from "./image-reference.js";

export type Mapping = Readonly<Record<string, unknown>>;
export const isMapping = (value: unknown): value is Mapping => typeof value === "object" && value !== null && !Array.isArray(value);
/** Own property only: a document may carry keys such as `constructor`. */
export const own = (mapping: Mapping, key: string): unknown => (Object.hasOwn(mapping, key) ? mapping[key] : undefined);
export const isSafeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
export const isPort = (value: unknown): value is number => isSafeInt(value) && value >= 1 && value <= 65_535;

const LONE_SURROGATE = /\p{Cs}/u;

export type ComposeDocument =
  | { readonly ok: true; readonly root: unknown }
  | { readonly ok: false; readonly problem: "too_large" }
  | { readonly ok: false; readonly problem: "yaml"; readonly code: YamlErrorCode; readonly line: number; readonly column: number };

export function readComposeDocument(compose: unknown): ComposeDocument {
  if (typeof compose !== "string") return { ok: false, problem: "yaml", code: "UNSUPPORTED_SYNTAX", line: 1, column: 1 };
  // The length first: a megabyte of text is refused without being encoded.
  if (compose.length > TEMPLATE_SOURCE_MAX_BYTES || new TextEncoder().encode(compose).length > TEMPLATE_SOURCE_MAX_BYTES) {
    return { ok: false, problem: "too_large" };
  }
  // A lone surrogate cannot be stored as written, and the draft would carry it.
  const surrogate = LONE_SURROGATE.exec(compose)?.index;
  if (surrogate !== undefined) {
    const lines = compose.slice(compose.charCodeAt(0) === 0xfeff ? 1 : 0, surrogate).split(/\r\n?|\n/);
    return { ok: false, problem: "yaml", code: "CONTROL_CHARACTER", line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
  }
  const parsed = parseTemplateYaml(compose);
  if (parsed.ok) return { ok: true, root: parsed.value };
  const [error] = parsed.errors;
  return { ok: false, problem: "yaml", code: error.code, line: error.line, column: error.column };
}

/**
 * True when `image` is a reference the API must resolve: no digest yet, and a form both the lookup and the validator
 * accept. One rule for the list of images and for the importer, so the two never disagree.
 */
export function isImageLookup(image: string): boolean {
  return !image.includes("@") && appStackImageLookupProblem(image) === null && parseImageReference(image).ok;
}
