/**
 * Rules for the environment of a site template. An administrator writes the names and values, so they are held to
 * what the executor refuses later (secret-looking names, the docker socket) and to a stricter line for what must
 * never reach a container through a template (platform-owned names, secrets written in the clear).
 * Problems are codes only: a message built from them must never echo the value.
 */
import { findPlaintextSecretKeys, findUnsafeDockerInputFields } from "@hosting-panel/contracts";

export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
export const ENV_MAX_ENTRIES = 64;
export const ENV_VALUE_MAX_LENGTH = 4096;

export type EnvNameProblem = "ENV_NAME_INVALID" | "ENV_NAME_RESERVED" | "ENV_NAME_SECRET_LIKE";
export type EnvValueProblem = "ENV_VALUE_INVALID" | "ENV_VALUE_SECRET_LIKE" | "ENV_VALUE_DOCKER_SOCKET";

const RESERVED_PREFIXES = ["HP_", "LD_", "DOCKER_"] as const;
/** `<NAME>_FILE` is the platform's secret channel. */
const RESERVED_SUFFIX = "_FILE";
/** PATH and PHPRC / PHP_INI_SCAN_DIR would bypass the platform's own setup; PORT is the service spec's port fallback. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["PATH", "PHPRC", "PHP_INI_SCAN_DIR", "PORT"]);

const SECRET_SEGMENTS: ReadonlySet<string> = new Set([
  "PASSWORD", "PASSWD", "SECRET", "SECRETS", "TOKEN", "APIKEY", "CREDENTIAL", "CREDENTIALS", "SALT", "PRIVATEKEY", "AUTHKEY",
]);
const SECRET_QUALIFIERS: ReadonlySet<string> = new Set(["API", "PRIVATE", "SECRET", "AUTH", "ACCESS", "ENCRYPTION", "SIGNING", "MASTER", "CLIENT"]);

/** Segment based, so `TOKENIZER_MODE` and `KEYBOARD_LAYOUT` pass while `DB_PASSWORD` (which the executor lets through) does not. */
function isSecretLikeName(name: string): boolean {
  const segments = name.split("_");
  if (segments.some((segment) => SECRET_SEGMENTS.has(segment)) || segments[segments.length - 1] === "KEY") return true;
  return segments.some((segment, i) => SECRET_QUALIFIERS.has(segment) && (segments[i + 1] === "KEY" || segments[i + 1] === "SECRET"))
    || findPlaintextSecretKeys({ [name]: "x" }).length > 0;
}

export function envNameProblem(name: string): EnvNameProblem | null {
  if (!ENV_NAME_PATTERN.test(name)) return "ENV_NAME_INVALID";
  if (RESERVED_NAMES.has(name) || name.endsWith(RESERVED_SUFFIX) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return "ENV_NAME_RESERVED";
  }
  return isSecretLikeName(name) ? "ENV_NAME_SECRET_LIKE" : null;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER =/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const DOCKER_SOCKET = /docker\.sock/i;
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /sk-[A-Za-z0-9]{20,}/,
  // Credentials inside a URL: scheme://user:password@host
  /:\/\/[^/\s:@]+:[^/\s@]+@/,
];

/** Checks the literal text of a value, before any `${NAME}` is filled in. */
export function envValueProblem(literal: string): EnvValueProblem | null {
  // The specific problems first: a multi-line private key is a secret, not just "a control character".
  if (DOCKER_SOCKET.test(literal) || findUnsafeDockerInputFields({ v: literal }).length > 0) return "ENV_VALUE_DOCKER_SOCKET";
  if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(literal))) return "ENV_VALUE_SECRET_LIKE";
  return CONTROL_CHARACTER.test(literal) ? "ENV_VALUE_INVALID" : null;
}
