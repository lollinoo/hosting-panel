/**
 * Variables of a Compose value: the `$` syntax Compose substitutes, and what a variable name means to the importer
 * (a URL of the platform, a secret the platform generates, or an ordinary variable that becomes a parameter).
 * The `SERVICE_*` names are an interface convention only. Pure, synchronous and never throws.
 */
import { APP_SECRET_GENERATE_BOUNDS, type AppSecretGenerate, type AppSecretGenerateKind } from "@hosting-panel/contracts";

/** `fallback` is the text of `${NAME:-text}` or `${NAME-text}`; null when the file gives none. */
export type ComposePiece = { readonly literal: string } | { readonly variable: string; readonly fallback: string | null };

export type ComposeScan = { readonly ok: true; readonly pieces: readonly ComposePiece[] } | { readonly ok: false };

const NAME_AT = /[A-Za-z_][A-Za-z0-9_]*/y;

function nameAt(text: string, index: number): string | null {
  NAME_AT.lastIndex = index;
  return NAME_AT.exec(text)?.[0] ?? null;
}

/**
 * Splits a value into literal text and variables: `$$` (a literal dollar), `$NAME`, `${NAME}`, `${NAME:-text}`,
 * `${NAME-text}`, `${NAME:?text}` and `${NAME?text}`. Anything else Compose would substitute (`${NAME:+text}`, a nested
 * variable, an unclosed brace, a `$` before something that is not a name) fails: the importer cannot say what the
 * container would have received.
 */
export function scanComposeValue(text: string): ComposeScan {
  const pieces: ComposePiece[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal !== "") pieces.push({ literal });
    literal = "";
  };
  let index = 0;
  while (index < text.length) {
    const dollar = text.indexOf("$", index);
    if (dollar === -1) {
      literal += text.slice(index);
      break;
    }
    literal += text.slice(index, dollar);
    const next = text[dollar + 1];
    if (next === "$") {
      literal += "$";
      index = dollar + 2;
      continue;
    }
    const braced = next === "{";
    const name = nameAt(text, dollar + (braced ? 2 : 1));
    if (name === null) return { ok: false };
    let end = dollar + (braced ? 2 : 1) + name.length;
    let fallback: string | null = null;
    if (braced) {
      const close = text.indexOf("}", end);
      if (close === -1) return { ok: false };
      const modifier = text.slice(end, close);
      if (modifier.startsWith(":-")) fallback = modifier.slice(2);
      else if (modifier.startsWith("-")) fallback = modifier.slice(1);
      else if (modifier !== "" && !modifier.startsWith(":?") && !modifier.startsWith("?")) return { ok: false };
      if (fallback !== null && /[${]/.test(fallback)) return { ok: false };
      end = close + 1;
    }
    flush();
    pieces.push({ variable: name, fallback });
    index = end;
  }
  flush();
  return { ok: true, pieces };
}

export type ComposeVariableClass =
  /** `SERVICE_FQDN_X` or `SERVICE_URL_X`, with an optional `_<PORT>`: the public address of the service that carries it. */
  | { readonly kind: "ingress"; readonly port: number | null }
  /** `SERVICE_PASSWORD_X` and its relatives: a secret the platform makes. `adjusted` says what the name asked for and is not kept. */
  | { readonly kind: "generated"; readonly generate: AppSecretGenerate; readonly adjusted: "kind" | "length" | null }
  | { readonly kind: "ordinary" };

const INGRESS_VARIABLE = /^SERVICE_(?:FQDN|URL)_[A-Za-z0-9_]+?(?:_([0-9]{1,5}))?$/;
const GENERATED_VARIABLE = /^SERVICE_(PASSWORDWITHSYMBOLS|PASSWORD|USER|REALBASE64|BASE64|HEX)(?:_([0-9]{1,4}))?_[A-Za-z0-9_]+$/;

/** What each word of the convention becomes. A kind the platform does not make is the nearest one it does. */
const GENERATED_KINDS: Readonly<Record<string, { readonly kind: AppSecretGenerateKind; readonly length: number; readonly exact: boolean }>> = {
  PASSWORD: { kind: "password", length: 32, exact: true },
  PASSWORDWITHSYMBOLS: { kind: "password", length: 32, exact: false },
  USER: { kind: "user", length: 16, exact: true },
  BASE64: { kind: "base64", length: 32, exact: true },
  REALBASE64: { kind: "base64", length: 32, exact: false },
  HEX: { kind: "hex", length: 32, exact: true },
};

export function classifyComposeVariable(name: string): ComposeVariableClass {
  const ingress = INGRESS_VARIABLE.exec(name);
  if (ingress !== null) {
    const port = ingress[1] === undefined ? null : Number(ingress[1]);
    // A number that is not a port is part of the name.
    return { kind: "ingress", port: port !== null && port >= 1 && port <= 65_535 ? port : null };
  }
  const generated = GENERATED_VARIABLE.exec(name);
  const rule = generated?.[1] === undefined || !Object.hasOwn(GENERATED_KINDS, generated[1]) ? undefined : GENERATED_KINDS[generated[1]];
  if (generated === null || rule === undefined) return { kind: "ordinary" };
  const bounds = APP_SECRET_GENERATE_BOUNDS[rule.kind];
  const asked = generated[2] === undefined ? rule.length : Number(generated[2]);
  const length = Math.min(bounds.max, Math.max(bounds.min, asked));
  return { kind: "generated", generate: { kind: rule.kind, length }, adjusted: length !== asked ? "length" : rule.exact ? null : "kind" };
}
