/**
 * What the importer takes for a secret written in the clear: by the name that holds it, by its place in a URL, and by
 * its own text once the file has shown it to be one. Wider than the rule of a template on purpose: a value the importer
 * lets through is published with the template, while one it takes for a secret by mistake is replaced or dropped with a
 * note. Pure, synchronous and never throws.
 */
import { envNameProblem, envValueProblem } from "./site-template-env.js";

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

/** Stands for one variable in the text a pattern reads: like the placeholder of a parameter, it is part of a word. */
const STAND_IN = "\u0000";

const BLANK = /\s/;
const HOST_CHARACTER = /[A-Za-z0-9.-]/;
const IPV6_CHARACTER = /[A-Za-z0-9:.%_~-]/;
const DIGIT = /[0-9]/;
const NAME_START = /[A-Za-z_]/;
const NAME_CHARACTER = /[A-Za-z0-9_]/;
/** Also an '@' and a '/': a variable read as a host never reaches past the next '@' or into the path, so each one is read once. */
const NOT_IN_BRACES = /[\s${}@/]/;

const is = (kind: RegExp, character: string | undefined): boolean => character !== undefined && kind.test(character);

/** Where the variable written at `index` ends ('${...}', '$NAME' or the stand-in of one already read); -1 when none starts there. */
function variableEnd(text: string, index: number): number {
  if (text[index] === STAND_IN) return index + 1;
  if (text[index] !== "$") return -1;
  let end = index + 1;
  if (text[end] === "{") {
    end += 1;
    while (end < text.length && !is(NOT_IN_BRACES, text[end])) end += 1;
    return text[end] === "}" && end > index + 2 ? end + 1 : -1;
  }
  if (!is(NAME_START, text[end])) return -1;
  while (is(NAME_CHARACTER, text[end])) end += 1;
  return end;
}

/**
 * Where the host that follows the '@' at `at` ends, its port included; -1 when no host follows it: letters, digits, '.',
 * '-' and variables, or an IPv6 address in brackets; then ':' and 1 to 5 digits or a variable; then the end, or a
 * character that ends a host and is neither ':' nor '@'.
 */
function hostEnd(text: string, at: number): number {
  let end = at + 1;
  if (text[end] === "[") {
    end += 1;
    while (is(IPV6_CHARACTER, text[end])) end += 1;
    if (text[end] !== "]" || end === at + 2) return -1;
    end += 1;
  } else {
    for (;;) {
      if (is(HOST_CHARACTER, text[end])) {
        end += 1;
        continue;
      }
      const variable = variableEnd(text, end);
      if (variable === -1) break;
      end = variable;
    }
    if (end === at + 1) return -1;
  }
  if (text[end] === ":") {
    let port = variableEnd(text, end + 1);
    if (port === -1) {
      port = end + 1;
      while (port < end + 6 && is(DIGIT, text[port])) port += 1;
      if (port === end + 1) return -1;
    }
    end = port;
  }
  const after = text[end];
  return after !== undefined && (is(HOST_CHARACTER, after) || after === ":" || after === "@") ? -1 : end;
}

/** The first '@' at or after `from` that comes before a '/' or a blank; -1 when there is none. */
function nextAt(text: string, from: number): number {
  for (let index = from; index < text.length && text[index] !== "/" && !is(BLANK, text[index]); index++) {
    if (text[index] === "@") return index;
  }
  return -1;
}

/** R1: the '@' that ends the user and password of the address read from `start`, and where its host ends; null when none does. */
function separatorAfter(text: string, start: number): { readonly at: number; readonly hostEnd: number } | null {
  for (let at = nextAt(text, start); at !== -1; at = nextAt(text, at + 1)) {
    const end = hostEnd(text, at);
    if (end !== -1) return { at, hostEnd: end };
  }
  return null;
}

export interface UrlCredentials {
  /** Where the password lies in the text; null when the address is left as written. */
  readonly password: { readonly start: number; readonly end: number } | null;
  /** The address can be read in more than one way: the report asks for a check by hand. */
  readonly unclear: boolean;
}

/**
 * The credentials of the addresses of a text, `scheme://user:password@host` with the user possibly empty: a form the
 * rule of a template lets through only in part, and the importer not at all (ADR-0036 §8.4). After each '://':
 * - R1: the user and password end at the first '@' before any '/' or blank that a host follows (`hostEnd`);
 * - R2: without a ':' before that '@' there is a user alone, which is not a secret; else the password runs from the
 *   first ':' to the '@', and an empty one is none;
 * - R3: a '?' or a '#' before the '@' is where a URL parser may end the address: it is left as written, and unclear;
 * - R4: another '@' after the host, before the path or a blank, means the password could end there: unclear.
 * Each character is read a bounded number of times, however many '@' or '://' the text piles up.
 */
export function urlCredentials(text: string): UrlCredentials[] {
  const found: UrlCredentials[] = [];
  let scheme = text.indexOf("://");
  while (scheme !== -1) {
    const start = scheme + 3;
    const separator = separatorAfter(text, start);
    if (separator === null) {
      scheme = text.indexOf("://", scheme + 1);
      continue;
    }
    scheme = text.indexOf("://", separator.at + 1);
    const userinfo = text.slice(start, separator.at);
    const colon = userinfo.indexOf(":");
    if (colon === -1 || colon === userinfo.length - 1) continue;
    if (/[?#]/.test(userinfo)) found.push({ password: null, unclear: true });
    else found.push({ password: { start: start + colon + 1, end: separator.at }, unclear: nextAt(text, separator.hostEnd) !== -1 });
  }
  return found;
}

/** True when an address of the text has a password the importer reads (R2). */
export const holdsUrlPassword = (text: string): boolean => urlCredentials(text).some((found) => found.password !== null);

/**
 * True when an address of the text cannot be read one way only (R3) and the template check does not see credentials in
 * the text either (a user with an '@'): it may hold a password that nothing would stop, and the importer guesses none.
 */
export const hidesUrlPassword = (text: string): boolean =>
  urlCredentials(text).some((found) => found.password === null) && envValueProblem(text) !== "ENV_VALUE_SECRET_LIKE";

/** What a note adds about an address the importer reads one way, or not at all, when it could be read another way. */
export const checkByHand = (why: string): string =>
  ` An address of the value can be read in more than one way (${why}): check by hand that it keeps its host and holds no part of the password.`;

/**
 * The note on an address that cannot be read safely (R3): `where` names the value; `seen` when the template check sees
 * credentials there and refuses the draft, else the importer refuses the entry itself.
 */
export const unreadableAddress = (where: string, seen: boolean): string =>
  `An address in ${where} cannot be read safely and may hold a password: the importer takes nothing out of it, and ${
    seen ? "the template check refuses the draft" : "the file gives no draft until it is written otherwise"
  }.${checkByHand("a '?' or a '#' stands before its '@'")} Write the password as a variable of its own, or percent-encode its '?', '#' and '@'.`;

/**
 * `urlCredentials` over a value made of literal text and of variables, the password as the pieces it covers: `first`
 * and `last` are indexes in `literals` (null marks a variable), `from` and `to` offsets in the first piece when the
 * password lies inside one literal piece.
 */
export function urlPasswordsIn(literals: readonly (string | null)[]): {
  readonly password: { readonly first: number; readonly last: number; readonly from: number; readonly to: number } | null;
  readonly unclear: boolean;
}[] {
  const starts: number[] = [];
  let text = "";
  for (const literal of literals) {
    starts.push(text.length);
    text += literal ?? STAND_IN;
  }
  // The passwords come first to last: the piece of each is found by walking on from the one before.
  let piece = 0;
  const pieceAt = (offset: number): number => {
    while (piece + 1 < starts.length && (starts[piece + 1] ?? 0) <= offset) piece += 1;
    return piece;
  };
  return urlCredentials(text).map(({ password, unclear }) => {
    if (password === null) return { password: null, unclear };
    const first = pieceAt(password.start);
    const offset = starts[first] ?? 0;
    return { password: { first, last: pieceAt(password.end - 1), from: password.start - offset, to: password.end - offset }, unclear };
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
