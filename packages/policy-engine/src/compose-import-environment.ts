/**
 * Environment of an imported service: the map or list of the Compose file becomes value entries and secret entries.
 * A secret the file writes in the clear never reaches the draft: a generated secret parameter takes its place, for a
 * whole value under a name that looks like a secret's, for the password of an address, and for the same text met
 * again anywhere else. Pure, synchronous and never throws; a note names a variable, never its value.
 */
import {
  APP_STACK_ENV_NAME_PATTERN,
  APP_STACK_SECRET_ENV_LIMITS,
  APP_TEMPLATE_LIMITS as LIMITS,
  appStackTextProblem,
  type TemplatePath,
} from "@hosting-panel/contracts";
import { isMapping } from "./compose-import-document.js";
import { describeGenerate, type DraftParameter, type ParameterRegistry, type VariableCensus } from "./compose-import-parameters.js";
import type { ImportReport } from "./compose-import-report.js";
import { isPlainSetting, looksSecretName, urlPasswordName, urlPasswordSpans, urlPasswordsIn } from "./compose-import-secrets.js";
import { classifyComposeVariable, scanComposeValue, type ComposeScan } from "./compose-import-variables.js";
import { envNameProblem, envValueProblem } from "./site-template-env.js";

/** One variable of the file with a name the platform accepts; `written` is its value as the file gives it. */
export interface ComposeEnvEntry {
  readonly name: string;
  readonly path: TemplatePath;
  readonly written: string;
  readonly scan: ComposeScan;
}

export type DraftEnvEntry = { readonly name: string; readonly value: string } | { readonly name: string; readonly secret: string };

export interface DraftEnvironment {
  readonly entries: readonly DraftEnvEntry[];
  /** One per platform URL variable met: the port its name asks for (null when it names none) and where it stands. */
  readonly ingress: readonly { readonly port: number | null; readonly path: TemplatePath }[];
}

/** A stretch of a value: text as the container receives it, or the parameter that stands there. */
type Part = { readonly literal: string } | { readonly parameter: DraftParameter };

/** The value as the container would receive it; null when it names a variable or cannot be read. */
function literalOf(entry: ComposeEnvEntry): string | null {
  if (!entry.scan.ok || entry.scan.pieces.some((piece) => "variable" in piece)) return null;
  return entry.scan.pieces.map((piece) => ("literal" in piece ? piece.literal : "")).join("");
}

/** True when the value is plainly a setting and not a secret (see `isPlainSetting`); a variable alone is judged by its default. */
function isSetting(entry: ComposeEnvEntry): boolean {
  if (!entry.scan.ok) return false;
  const [only, ...others] = entry.scan.pieces;
  if (only === undefined || others.length > 0) return false;
  const text = "literal" in only ? only.literal : only.fallback;
  return text !== null && isPlainSetting(entry.name, text);
}

/** True when the whole value stands for a secret: the name says so and the value is not plainly something else. */
const isSecretEntry = (entry: ComposeEnvEntry): boolean => looksSecretName(entry.name) && !isSetting(entry);

/** The entries of `environment` the importer can carry over, the last one of each name; the others are dropped with a note. */
export function readComposeEnvironment(report: ImportReport, raw: unknown, path: TemplatePath): ComposeEnvEntry[] {
  // A null value, or a list item without '=', asks Compose for the value of the machine that runs it.
  const found: { readonly name: string; readonly value: unknown; readonly path: TemplatePath }[] = [];
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) {
    raw.forEach((item: unknown, index) => {
      const at = [...path, index];
      if (typeof item !== "string") {
        report.dropped("ENV_VALUE_DROPPED", at, "An entry of an environment list is text of the form NAME=value: this one is not, and is dropped.");
        return;
      }
      const equals = item.indexOf("=");
      found.push(equals === -1 ? { name: item, value: null, path: at } : { name: item.slice(0, equals), value: item.slice(equals + 1), path: at });
    });
  } else if (isMapping(raw)) {
    // A key that is not a name may be a whole 'NAME=value' written in the wrong form: its place is shown, not its text.
    Object.keys(raw).forEach((name, index) => found.push({ name, value: raw[name], path: [...path, APP_STACK_ENV_NAME_PATTERN.test(name) ? name : index] }));
  } else {
    report.refused("VALUE_INVALID", path, "'environment' is a mapping or a list.");
    return [];
  }

  const kept = new Map<string, ComposeEnvEntry>();
  for (const { name, value, path: at } of found) {
    if (!APP_STACK_ENV_NAME_PATTERN.test(name)) {
      report.dropped("ENV_NAME_INVALID", at, "The name of this environment variable is not one the platform accepts (capital letters, digits and '_', at most 64 characters): it is dropped.");
      continue;
    }
    if (name !== "PORT" && envNameProblem(name) === "ENV_NAME_RESERVED") {
      report.dropped("ENV_NAME_RESERVED", at, `The environment variable ${name} is reserved by the platform: it is dropped.`);
      continue;
    }
    let written: string;
    if (value === null) {
      // The convention also writes a platform variable as a bare name: it then stands for its own value.
      if (classifyComposeVariable(name).kind === "ordinary") {
        report.dropped("ENV_PASSTHROUGH_DROPPED", at, `The environment variable ${name} takes its value from the machine that runs Compose: there is no such value here, and it is dropped.`);
        continue;
      }
      written = `\${${name}}`;
    } else if (typeof value === "string") written = value;
    else if (typeof value === "number" || typeof value === "boolean") written = String(value);
    else {
      report.dropped("ENV_VALUE_DROPPED", at, `The value of the environment variable ${name} is not text: it is dropped.`);
      continue;
    }
    const earlier = kept.get(name);
    if (earlier !== undefined) {
      report.dropped("ENV_DUPLICATE_DROPPED", earlier.path, `The environment variable ${name} is set again further down: only the last value counts.`);
      kept.delete(name);
    }
    kept.set(name, { name, path: at, written, scan: scanComposeValue(written) });
  }
  return [...kept.values()];
}

/**
 * Tells the census which ordinary variables the entries use, and which of them stand where a secret stands: alone
 * under a secret-looking name, or as the password of an address.
 */
export function recordEnvironmentVariables(census: VariableCensus, entries: readonly ComposeEnvEntry[]): void {
  for (const entry of entries) {
    if (!entry.scan.ok) continue;
    const { pieces } = entry.scan;
    const alone = pieces.length === 1 && isSecretEntry(entry);
    const passwords = new Set<number>();
    for (const span of urlPasswordsIn(pieces.map((piece) => ("literal" in piece ? piece.literal : null)))) {
      for (let index = span.first; index <= span.last; index++) passwords.add(index);
    }
    pieces.forEach((piece, index) => {
      if ("variable" in piece) census.record(piece.variable, piece.fallback, alone || passwords.has(index));
    });
  }
}

/**
 * Finds the secrets the file writes in the clear before any service is converted, so that the same text met again
 * (under another name, in another service or inside an address) becomes the same parameter. The values under a
 * secret-looking name come first, because they name the parameter; then the passwords of addresses; then the defaults
 * of the variables that hold a secret.
 */
export function claimLiteralSecrets(registry: ParameterRegistry, census: VariableCensus, services: readonly (readonly ComposeEnvEntry[])[]): void {
  const entries = services.flat();
  const literals = entries.flatMap((entry) => {
    const literal = literalOf(entry);
    return literal === null || literal === "" ? [] : [{ entry, literal }];
  });
  for (const { entry, literal } of literals) {
    if (isSecretEntry(entry)) registry.forLiteralSecret(entry.name, literal);
  }
  // In every value, also one replaced whole: the same password written elsewhere is still the same secret. In a value that
  // names a variable, the password is text of its own when it lies inside one literal piece.
  for (const entry of entries) {
    if (!entry.scan.ok) {
      // The '$' form cannot be read: the text as written, where a password without '$' is what the container receives.
      for (const span of urlPasswordSpans(entry.written)) {
        const password = entry.written.slice(span.start, span.end);
        if (!password.includes("$")) registry.forLiteralSecret(urlPasswordName(entry.name), password);
      }
      continue;
    }
    const pieces = entry.scan.pieces.map((piece) => ("literal" in piece ? piece.literal : null));
    for (const span of urlPasswordsIn(pieces)) {
      const piece = pieces[span.first];
      if (span.first === span.last && typeof piece === "string") registry.forLiteralSecret(urlPasswordName(entry.name), piece.slice(span.from, span.to));
    }
  }
  for (const entry of entries) {
    for (const piece of entry.scan.ok ? entry.scan.pieces : []) {
      if ("variable" in piece && census.get(piece.variable).secret) registry.forVariable(piece.variable);
    }
  }
}

/** The environment of the draft. Every variable a kept entry uses becomes a parameter of the draft. */
export function convertComposeEnvironment(
  report: ImportReport,
  registry: ParameterRegistry,
  entries: readonly ComposeEnvEntry[],
  path: TemplatePath,
): DraftEnvironment {
  const out: DraftEnvEntry[] = [];
  const ingress: { port: number | null; path: TemplatePath }[] = [];

  const replaced = (entry: ComposeEnvEntry, parameter: DraftParameter): void => {
    const made = parameter.secret ? describeGenerate(parameter.generate) : "";
    report.changed(
      "SECRET_GENERATED",
      entry.path,
      `The value of ${entry.name} is a secret, or stands under a name that looks like one: it is replaced by the generated secret parameter '${parameter.key}' (${made}). The value of the file is not kept.`,
    );
    out.push({ name: entry.name, secret: parameter.key });
  };
  const replaceBySecret = (entry: ComposeEnvEntry): void => {
    const literal = literalOf(entry);
    const parameter = literal === null ? registry.forWrittenSecret(entry.name, entry.written) : registry.forLiteralSecret(entry.name, literal);
    registry.use(parameter.key, entry.path);
    replaced(entry, parameter);
  };

  for (const entry of entries) {
    const { name, scan } = entry;
    const variables = scan.ok ? scan.pieces.flatMap((piece) => ("variable" in piece ? [piece.variable] : [])) : [];
    const urls = [name, ...variables].map(classifyComposeVariable).flatMap((kind) => (kind.kind === "ingress" ? [kind.port] : []));
    if (urls.length > 0) {
      for (const port of new Set(urls)) ingress.push({ port, path: entry.path });
      report.dropped(
        "ENV_URL_VARIABLE_DROPPED",
        entry.path,
        `The environment variable ${name} carries the public address of the service, which the platform does not pass to a container yet: it is dropped.`,
      );
      continue;
    }

    // The template check keeps a narrower list of secret-looking names than the importer, and refuses a plain value under one of them.
    const reserved = envNameProblem(name) === "ENV_NAME_SECRET_LIKE";
    if (!scan.ok) {
      if (looksSecretName(name) || envValueProblem(entry.written) === "ENV_VALUE_SECRET_LIKE" || urlPasswordSpans(entry.written).length > 0) replaceBySecret(entry);
      else report.dropped("ENV_VARIABLE_SYNTAX", entry.path, `The value of ${name} uses a '$' form the importer cannot read: the variable is dropped. Write a literal dollar as '$$'.`);
      continue;
    }
    if (scan.pieces.length === 0 && reserved) {
      report.dropped("SECRET_EMPTY_DROPPED", entry.path, `${name} is empty in the file: it is dropped, because the platform never passes an empty secret.`);
      continue;
    }
    if (reserved && isSetting(entry)) {
      report.dropped(
        "ENV_SETTING_DROPPED",
        entry.path,
        `The name of ${name} looks like a secret's and its value is plainly a setting (a switch, a number or a path): a template cannot carry a plain value under such a name, and a generated secret would mean something else, so the variable is dropped.`,
      );
      continue;
    }

    let parts: Part[] = [];
    for (const piece of scan.pieces) {
      if ("literal" in piece) {
        parts.push({ literal: piece.literal });
        continue;
      }
      const parameter = registry.forVariable(piece.variable);
      if (parameter !== null) parts.push({ parameter });
    }
    // Under a name that looks like a secret, only a value that names a secret parameter may stay as written.
    if (scan.pieces.length > 0 && isSecretEntry(entry) && !parts.some((part) => "parameter" in part && part.parameter.secret)) {
      replaceBySecret(entry);
      continue;
    }

    // A secret the file writes elsewhere, met again here. Cut first: an address that repeats such a password shares its
    // parameter, even where the address would read its password otherwise.
    const extracted = new Set<string>();
    parts = parts.flatMap((part): Part[] => {
      if ("parameter" in part) return [part];
      return registry.cutAtSecrets(part.literal).map((cut) => {
        if (typeof cut === "string") return { literal: cut };
        extracted.add(cut.key);
        return { parameter: cut };
      });
    });

    // The password of an address: text of its own is replaced by a secret, a secret parameter already is one.
    let whole = false;
    let unclear = false;
    for (const span of urlPasswordsIn(parts.map((part) => ("literal" in part ? part.literal : null))).reverse()) {
      unclear ||= span.unclear;
      const part = parts[span.first];
      if (part === undefined || span.first !== span.last || ("parameter" in part && !part.parameter.secret)) {
        whole = true;
        break;
      }
      if ("parameter" in part) continue;
      const parameter = registry.forLiteralSecret(urlPasswordName(name), part.literal.slice(span.from, span.to));
      extracted.add(parameter.key);
      parts.splice(span.first, 1, { literal: part.literal.slice(0, span.from) }, { parameter }, { literal: part.literal.slice(span.to) });
    }
    if (whole) {
      // A password made of text and variables together: no part of it can stay.
      replaceBySecret(entry);
      continue;
    }

    // `value` is the text of the draft; `around` is what the validator reads between two secret references.
    let value = "";
    const around = [""];
    const keys: string[] = [];
    let secrets = 0;
    let worstCase = 0;
    for (const part of parts) {
      if ("literal" in part) {
        value += part.literal.split("$").join("$$");
        around[around.length - 1] += part.literal;
        worstCase += part.literal.length;
        continue;
      }
      const { parameter } = part;
      keys.push(parameter.key);
      value += `\${${parameter.key}}`;
      if (parameter.secret) {
        secrets += 1;
        around.push("");
      } else {
        around[around.length - 1] += `\${${parameter.key}}`;
        worstCase += LIMITS.stringValue;
      }
    }
    if (secrets > APP_STACK_SECRET_ENV_LIMITS.referencesPerValue) {
      report.refused(
        "SECRET_REFERENCES_TOO_MANY",
        entry.path,
        `The value of ${name} names ${secrets} secrets: a value can name at most ${APP_STACK_SECRET_ENV_LIMITS.referencesPerValue}.`,
      );
      continue;
    }
    // Both spellings of a value without a secret: what the draft says ('$$') and what the container receives ('$').
    const checked = secrets > 0 ? around : [value, ...around];
    const problems = checked.map((text) => envValueProblem(text) ?? (appStackTextProblem(text) === "metadata_endpoint" ? "METADATA" : null));
    if (problems.includes("ENV_VALUE_SECRET_LIKE")) {
      replaceBySecret(entry);
      continue;
    }
    if (problems.some((problem) => problem !== null)) {
      report.dropped(
        "ENV_VALUE_DROPPED",
        entry.path,
        `The value of ${name} holds something a template cannot carry (a control character, the Docker socket or a cloud metadata address): the variable is dropped.`,
      );
      continue;
    }
    if (value.length > LIMITS.envValueLength || worstCase > LIMITS.envValueLength) {
      report.dropped("ENV_VALUE_DROPPED", entry.path, `The value of ${name} could exceed ${LIMITS.envValueLength} characters: the variable is dropped.`);
      continue;
    }
    for (const key of keys) registry.use(key, entry.path);
    const [only] = parts;
    if (parts.length === 1 && only !== undefined && "parameter" in only && only.parameter.secret) {
      // A value that is one secret and nothing else is the secret itself.
      if (extracted.has(only.parameter.key)) replaced(entry, only.parameter);
      else out.push({ name, secret: only.parameter.key });
      continue;
    }
    // The importer settles on one reading of such an address and does not guess silently.
    const check = unclear ? " An address of the value can be read in more than one way (it holds another '@'): check by hand that it keeps its host and holds no part of the password." : "";
    for (const key of extracted) {
      report.changed(
        "SECRET_EXTRACTED",
        entry.path,
        `A part of the value of ${name} is a secret (the password of an address, or a secret the file also writes elsewhere): that part is replaced by the generated secret parameter '${key}', and the rest of the value is kept.${check}`,
      );
    }
    out.push({ name, value });
  }

  if (out.length > LIMITS.environment) {
    report.refused("ENV_TOO_MANY", path, `A service has at most ${LIMITS.environment} environment variables; this one would have ${out.length}.`);
  }
  return { entries: out, ingress };
}
