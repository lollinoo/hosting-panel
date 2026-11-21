/**
 * Scanner of the `${NAME}` placeholders in a site-template value.
 *
 * Grammar (the renderer in `@hosting-panel/contracts` expands the same one): `${NAME}` with
 * `NAME = [A-Za-z_][A-Za-z0-9_]*`, and `$$` for a literal `$`. Every other `$` is an error. There are no defaults
 * (`${a:-b}`), no bare `$NAME`, no nesting, and a value is expanded in a single pass, never re-scanned.
 */

/** Magic variables the platform fills in; allowed in environment values. */
export const HP_MAGIC_VARIABLES = ["HP_SITE_ID", "HP_SITE_DOMAIN", "HP_SITE_URL"] as const;

/** Resolved to the module's pinned image; allowed only as the whole `image` value. */
export const HP_MODULE_IMAGE_VARIABLE = "HP_MODULE_IMAGE";

/** Largest value the renderer can feed to each magic variable, for the worst-case length of a filled-in value. */
export const HP_VARIABLE_MAX_LENGTH: Readonly<Record<(typeof HP_MAGIC_VARIABLES)[number], number>> = {
  HP_SITE_ID: 128,
  HP_SITE_DOMAIN: 253,
  HP_SITE_URL: 2048,
};

export type InterpolationPiece = { readonly literal: string } | { readonly variable: string };

export type InterpolationScan =
  | { readonly ok: true; readonly pieces: readonly InterpolationPiece[] }
  /** `offset` is the index of the `$` that opens the faulty construct. The message never echoes the text. */
  | { readonly ok: false; readonly offset: number; readonly code: "INTERP_SYNTAX"; readonly message: string };

const VARIABLE_NAME = /[A-Za-z_][A-Za-z0-9_]*/y;

const syntaxError = (offset: number, message: string): InterpolationScan => ({ ok: false, offset, code: "INTERP_SYNTAX", message });

export function scanInterpolation(text: string): InterpolationScan {
  const pieces: InterpolationPiece[] = [];
  let literal = "";
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
    } else if (next === "{") {
      VARIABLE_NAME.lastIndex = dollar + 2;
      const name = VARIABLE_NAME.exec(text);
      const end = dollar + 2 + (name?.[0].length ?? 0);
      if (name === null || text[end] !== "}") {
        return syntaxError(
          dollar,
          "A '${' must be followed by a variable name (letters, digits and '_', not starting with a digit) and a closing '}'. Defaults and nesting are not supported.",
        );
      }
      if (literal !== "") pieces.push({ literal });
      literal = "";
      pieces.push({ variable: name[0] });
      index = end + 1;
    } else {
      return syntaxError(dollar, "A '$' must be written '$$' for a literal dollar sign or '${NAME}' for a variable.");
    }
  }
  if (literal !== "") pieces.push({ literal });
  return { ok: true, pieces };
}

/** Joins the pieces, asking `values` for each variable. Single pass: a returned value is never scanned again. */
export function expandPieces(pieces: readonly InterpolationPiece[], values: (name: string) => string): string {
  return pieces.map((piece) => ("literal" in piece ? piece.literal : values(piece.variable))).join("");
}
