/**
 * What the importer takes for a secret written in the clear: by the name that holds it, by its place in a URL, and by
 * its own text once the file has shown it to be one. Wider than the rule of a template on purpose: a value the importer
 * lets through is published with the template, while one it takes for a secret by mistake is replaced or dropped with a
 * note. Pure, synchronous and never throws.
 */
import { envNameProblem } from "./site-template-env.js";

/** A word of a name that ends in one of these holds a secret: PGPASSWORD, SMTP_PASS, MYSQL_PWD, CLIENTSECRET. */
const SECRET_ENDINGS = [
  "PASSWORD", "PASSWORDS", "PASSWD", "PASSPHRASE", "PASS", "PWD", "SECRET", "SECRETS", "TOKEN", "TOKENS", "CREDENTIAL", "CREDENTIALS",
  "APIKEY", "PRIVATEKEY", "AUTHKEY",
] as const;
/** Words that end like a secret and are not one. */
const PLAIN_WORDS: ReadonlySet<string> = new Set(["BYPASS", "COMPASS", "OVERPASS", "UNDERPASS", "SURPASS", "TRESPASS"]);
const SECRET_WORDS: ReadonlySet<string> = new Set(["PW", "SALT", "MASTERAUTH"]);
/** Only as the last word of a name: SESSION_COOKIE_NAME and KEYS_DIR are settings. */
const SECRET_LAST_WORDS: ReadonlySet<string> = new Set(["COOKIE", "KEY", "KEYS"]);

const words = (name: string): string[] => name.toUpperCase().split(/[_-]/).filter((word) => word !== "");
const isSecretWord = (word: string): boolean => SECRET_WORDS.has(word) || (!PLAIN_WORDS.has(word) && SECRET_ENDINGS.some((ending) => word.endsWith(ending)));
const isSecretLastWord = (word: string | undefined): boolean => word !== undefined && (isSecretWord(word) || SECRET_LAST_WORDS.has(word));

/** True for the name of an environment variable, of a Compose variable or of a command option, in any case, with '_' or '-'. */
export function looksSecretName(name: string): boolean {
  if (envNameProblem(name.toUpperCase().replace(/-/g, "_")) === "ENV_NAME_SECRET_LIKE") return true;
  const all = words(name);
  return all.some(isSecretWord) || isSecretLastWord(all.at(-1));
}

const SWITCH = /^(?:true|false|yes|no|on|off|enabled?|disabled?|[01])$/i;
/** A count, a size or a duration: 8, 3600, 0.5, 15m, 100ms. */
const AMOUNT = /^[0-9]{1,9}(?:\.[0-9]{1,6})?[A-Za-z]{0,2}$/;
const ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]{0,255}$/;

/**
 * True when the value under a secret-looking name is plainly a setting and not the secret: a switch, a path inside the
 * container, or an amount under a name that does not end in the secret word itself (PASSWORD_MIN_LENGTH: 8 is a
 * setting, DB_PASSWORD: 12345678 is a password).
 */
export function isPlainSetting(name: string, value: string): boolean {
  if (SWITCH.test(value) || ABSOLUTE_PATH.test(value)) return true;
  return AMOUNT.test(value) && !isSecretLastWord(words(name).at(-1));
}

/** `scheme://user:password@`, the user possibly empty: a form the rule of a template lets through, and the importer does not. */
const URL_PASSWORD = /:\/\/[^/\s:@]*:([^/\s@]+)@/g;

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** Where a text carries the password of a URL. */
export function urlPasswordSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  for (const match of text.matchAll(URL_PASSWORD)) {
    const end = match.index + match[0].length - 1;
    spans.push({ start: end - (match[1]?.length ?? 0), end });
  }
  return spans;
}

/** Stands for one variable in the text a pattern reads: like the placeholder of a parameter, it is part of a word. */
const STAND_IN = "\u0000";

/**
 * The spans of `urlPasswordSpans` over a value made of literal text and of variables, as the pieces they cover:
 * `first` and `last` are indexes in `literals` (null marks a variable), `from` and `to` offsets in the first piece when
 * the span lies inside one literal piece.
 */
export function urlPasswordsIn(literals: readonly (string | null)[]): { readonly first: number; readonly last: number; readonly from: number; readonly to: number }[] {
  const starts: number[] = [];
  let text = "";
  for (const literal of literals) {
    starts.push(text.length);
    text += literal ?? STAND_IN;
  }
  const pieceAt = (offset: number): number => {
    let index = starts.length - 1;
    while (index > 0 && (starts[index] ?? 0) > offset) index -= 1;
    return index;
  };
  return urlPasswordSpans(text).map((span) => {
    const first = pieceAt(span.start);
    return { first, last: pieceAt(span.end - 1), from: span.start - (starts[first] ?? 0), to: span.end - (starts[first] ?? 0) };
  });
}

/** The name of the secret that replaces the password of a URL: DATABASE_URL gives DATABASE_PASSWORD. */
export const urlPasswordName = (envName: string): string => `${envName.replace(/_(?:URL|URI|DSN|ADDRESS|CONNECTION)$/, "")}_PASSWORD`;

/**
 * A text distinctive enough to be recognised where no name announces it: 'hunter2XQ' is, 'wordpress' is not, and the
 * importer must not turn every 'wordpress' of a file into the password that happens to be spelled the same.
 */
export function isDistinctiveSecret(text: string): boolean {
  return text.length >= 8 && [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((kind) => kind.test(text)).length >= 2;
}

/** The option an item of a command sets, and the value it carries after '=': `--requirepass`, `--password=...`. */
export function commandOption(item: string): { readonly name: string; readonly inline: string | null } | null {
  if (!item.startsWith("-")) return null;
  const equals = item.indexOf("=");
  const name = (equals === -1 ? item : item.slice(0, equals)).replace(/^-+/, "");
  return name === "" ? null : { name, inline: equals === -1 ? null : item.slice(equals + 1) };
}
