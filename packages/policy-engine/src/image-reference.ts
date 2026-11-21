/**
 * Parser of a container image reference (`[registry/]repository[:tag][@digest]`).
 *
 * Pure and offline: no default registry, no default tag. `wordpress` and `docker.io/library/wordpress` stay distinct
 * on purpose, because a policy compares the repository exactly (the executor grants extra capabilities to any image
 * whose name ends in a well-known repository, so a look-alike must never pass as the official one).
 */
export interface ParsedImageReference {
  /** First path component when it contains "." or ":" or equals "localhost"; otherwise null. */
  readonly registry: string | null;
  /** Path without the registry, e.g. "wordpress" or "library/wordpress". */
  readonly repository: string;
  readonly tag: string | null;
  /** "sha256:<64 lower-case hex digits>". */
  readonly digest: string | null;
}

export type ImageReferenceFailure = "EMPTY" | "TOO_LONG" | "WHITESPACE" | "MALFORMED" | "TAG_INVALID" | "DIGEST_INVALID";

export type ParseImageReferenceResult =
  | { readonly ok: true; readonly value: ParsedImageReference }
  | { readonly ok: false; readonly reason: ImageReferenceFailure };

const MAX_LENGTH = 255;
// eslint-disable-next-line no-control-regex
const WHITESPACE_OR_CONTROL =/[\s\u0000-\u001f\u007f-\u009f]/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const REGISTRY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?$/;

const fail = (reason: ImageReferenceFailure): { readonly ok: false; readonly reason: ImageReferenceFailure } => ({ ok: false, reason });

export function parseImageReference(ref: string): ParseImageReferenceResult {
  if (ref.length === 0) return fail("EMPTY");
  if (ref.length > MAX_LENGTH) return fail("TOO_LONG");
  if (WHITESPACE_OR_CONTROL.test(ref)) return fail("WHITESPACE");

  let name = ref;
  let digest: string | null = null;
  const at = name.indexOf("@");
  if (at !== -1) {
    digest = name.slice(at + 1);
    if (!DIGEST.test(digest)) return fail("DIGEST_INVALID");
    name = name.slice(0, at);
  }

  // The tag is what follows the last ":" when that colon comes after the last "/" (otherwise it is a registry port).
  let tag: string | null = null;
  const colon = name.lastIndexOf(":");
  if (colon > name.lastIndexOf("/")) {
    tag = name.slice(colon + 1);
    if (!TAG.test(tag)) return fail("TAG_INVALID");
    name = name.slice(0, colon);
  }

  const components = name.split("/");
  let registry: string | null = null;
  const first = components[0] ?? "";
  if (components.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost")) {
    if (!REGISTRY.test(first)) return fail("MALFORMED");
    registry = first;
    components.shift();
  }
  if (!components.every((component) => PATH_COMPONENT.test(component))) return fail("MALFORMED");

  return { ok: true, value: { registry, repository: components.join("/"), tag, digest } };
}
