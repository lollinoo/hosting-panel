import { createHash } from "node:crypto";

// Request-hash idempotency (HCP-SPEC-004 D9): the same Idempotency-Key with a different payload is a conflict. The hash
// is the SHA-256 (hex) of a canonical JSON of the validated request: keys sorted at every depth, `undefined` dropped
// like JSON.stringify does. A secret in the request (a PEM, for instance) only feeds the digest; it is never stored.

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item === undefined ? null : item));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .filter((key) => record[key] !== undefined)
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

/** SHA-256 hex of the canonical JSON of `value` (plain JSON data: objects, arrays, strings, numbers, booleans, null). */
export function canonicalRequestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value)) ?? "null").digest("hex");
}
