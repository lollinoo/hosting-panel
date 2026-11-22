/**
 * Canonical JSON for hashing the application-stack family. Only null, booleans, strings, safe integers, arrays and
 * plain objects (prototype Object.prototype or null); object keys sorted by code unit; no whitespace. Anything else,
 * `undefined` included, throws TypeError: only a compiler bug produces such data.
 */
export function canonicalAppStackJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonicalAppStackJson: only safe integers are allowed");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${Array.from(value as unknown[], (item) => canonicalAppStackJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalAppStackJson(record[key])}`).join(",")}}`;
    }
  }
  throw new TypeError("canonicalAppStackJson: unsupported value");
}
