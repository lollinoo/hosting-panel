const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

const AUTH_SCHEME_TOKEN_PATTERN =
  /\b(Bearer|Basic)\s+(?!\[REDACTED\b)[^\s"',;)\]}<>]+/gi;

const COOLIFY_PIPE_TOKEN_PATTERN = /\b\d+\|[A-Za-z0-9_-]{12,}\b/g;

const URL_CREDENTIALS_PATTERN =
  /\b(postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|https?):\/\/(?!\[REDACTED\]@)([^/\s:@]+):([^@\s/]+)@/gi;

const INLINE_SECRET_ASSIGNMENT_PATTERN =
  /\b(authorization|sentinel_token|api_token|access_token|refresh_token|coolify_token|private_key|password|secret)(\s*[:=]\s*)(?!\[REDACTED\b|(?:Bearer|Basic)\s+\[REDACTED\b)("[^"]*"|'[^']*'|[^\s"',;)\]}<>]+)/gi;

const EXACT_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy_authorization",
  "cookie",
  "set_cookie",
  "token",
  "tokens",
  "sentinel_token",
  "api_token",
  "access_token",
  "refresh_token",
  "coolify_token",
  "bearer_token",
  "auth_token",
  "password",
  "secret",
  "client_secret",
  "webhook_secret",
  "jwt_secret",
  "api_key",
  "x_api_key",
  "private_key",
  "ssh_key",
  "ssh_private_key",
  "environment_variables",
  "env",
  "env_vars",
  "internal_db_url",
  "external_db_url",
]);

const SENSITIVE_KEY_SUFFIXES = [
  "_token",
  "_secret",
  "_password",
  "_private_key",
  "_api_key",
] as const;

function normalizeKeyName(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKeyName(key);
  if (EXACT_SENSITIVE_KEYS.has(normalized)) {
    return true;
  }

  for (const suffix of SENSITIVE_KEY_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      return true;
    }
  }

  return false;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactSensitiveString(
  input: string,
  knownSecrets?: readonly string[],
): string {
  let sanitized = input
    .replace(PEM_PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]")
    .replace(AUTH_SCHEME_TOKEN_PATTERN, "$1 [REDACTED]")
    .replace(COOLIFY_PIPE_TOKEN_PATTERN, "[REDACTED]")
    .replace(URL_CREDENTIALS_PATTERN, "$1://[REDACTED]@")
    .replace(INLINE_SECRET_ASSIGNMENT_PATTERN, "$1$2[REDACTED]");

  if (knownSecrets && knownSecrets.length > 0) {
    for (const secret of knownSecrets) {
      const trimmed = secret.trim();
      if (trimmed.length >= 4) {
        sanitized = sanitized.replace(new RegExp(escapeRegExp(trimmed), "g"), "[REDACTED]");
        const encoded = encodeURIComponent(trimmed);
        if (encoded !== trimmed && encoded.length >= 4) {
          sanitized = sanitized.replace(new RegExp(escapeRegExp(encoded), "g"), "[REDACTED]");
        }
      }
    }
  }

  return sanitized;
}

function redactValueInternal(
  value: unknown,
  seen: WeakSet<object>,
  knownSecrets?: readonly string[],
): unknown {
  if (typeof value === "string") {
    return redactSensitiveString(value, knownSecrets);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof URL) {
    return redactSensitiveString(value.toString(), knownSecrets);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValueInternal(item, seen, knownSecrets));
  }

  if (value instanceof Headers) {
    const redactedHeaders: Record<string, string> = {};
    value.forEach((headerValue, headerKey) => {
      redactedHeaders[headerKey] = isSensitiveKey(headerKey)
        ? "[REDACTED]"
        : redactSensitiveString(headerValue, knownSecrets);
    });
    return redactedHeaders;
  }

  if (value instanceof Error) {
    const redactedError: Record<string, unknown> = {
      name: value.name,
      message: redactSensitiveString(value.message, knownSecrets),
    };
    for (const [key, entryValue] of Object.entries(value)) {
      if (key === "name" || key === "message" || key === "stack" || key === "cause") {
        continue;
      }
      redactedError[key] = isSensitiveKey(key)
        ? "[REDACTED]"
        : redactValueInternal(entryValue, seen, knownSecrets);
    }
    return redactedError;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactValueInternal(entryValue, seen, knownSecrets);
    }
  }

  return output;
}

export function redactSensitiveValue(
  value: unknown,
  knownSecrets?: readonly string[],
): unknown {
  return redactValueInternal(value, new WeakSet<object>(), knownSecrets);
}
