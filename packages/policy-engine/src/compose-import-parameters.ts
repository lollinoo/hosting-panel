/**
 * Parameters of an imported draft: what a variable of the file becomes, and the generated secrets that take the place
 * of the secrets the file writes in the clear. A parameter exists in the draft only once something that is kept uses it.
 * Pure, synchronous and never throws; a note names a variable or a parameter, never a value.
 */
import {
  APP_TEMPLATE_LIMITS as LIMITS,
  appTemplateValueProblem,
  type AppSecretGenerate,
  type AppTemplateParameter,
  type TemplatePath,
} from "@hosting-panel/contracts";
import { clip, type ComposeImportCode, type ComposeImportLevel, type ImportReport } from "./compose-import-report.js";
import { isDistinctiveSecret, isPlainSetting, looksSecretName, urlPasswordSpans } from "./compose-import-secrets.js";
import { classifyComposeVariable } from "./compose-import-variables.js";
import { envValueProblem } from "./site-template-env.js";

export const DEFAULT_GENERATE: AppSecretGenerate = Object.freeze({ kind: "password", length: 32 });

/** The file may write this many different secrets in the clear; a template has room for far fewer. */
export const LITERAL_SECRETS_MAX = 64;

export type DraftParameter =
  | { readonly key: string; readonly label: string; readonly secret: true; readonly generate: AppSecretGenerate }
  | { readonly key: string; readonly label: string; readonly secret: false; readonly default: string; readonly customer: boolean };

interface Note {
  readonly level: ComposeImportLevel;
  readonly code: ComposeImportCode;
  readonly message: string;
}

interface Entry {
  readonly parameter: DraftParameter;
  /** Written where the parameter is next used, then forgotten. */
  notes: Note[];
  /** Its place among the parameters of the draft: the order of first use. Null until something that is kept uses it. */
  order: number | null;
}

const STRING_PARAMETER: AppTemplateParameter = { key: "p", label: "p", type: "string", default: "", customer: false };
/** The validator's rule for the default of a string parameter. */
const isStringDefault = (text: string): boolean => appTemplateValueProblem(STRING_PARAMETER, text) === null && envValueProblem(text) === null;

export const describeGenerate = (generate: AppSecretGenerate): string =>
  generate.kind === "base64" ? `base64 of ${generate.length} random bytes` : `${generate.kind} of ${generate.length} characters`;

interface Sighting {
  fallback: string | null;
  conflict: boolean;
  /** A use, or a default, that makes the variable a secret whatever its name. */
  forced: boolean;
  /** A default that is plainly a setting, and one that is not. */
  plain: boolean;
  guarded: boolean;
}

export interface VariableFacts {
  readonly fallback: string | null;
  readonly conflict: boolean;
  readonly secret: boolean;
}

/**
 * Every use of an ordinary variable in the file, gathered before the first parameter is made: one use as a secret
 * makes the variable a secret everywhere.
 */
export class VariableCensus {
  private readonly seen = new Map<string, Sighting>();

  /** `asSecret`: the variable stands where a secret stands, as a whole secret-looking value or as the password of a URL. */
  record(variable: string, fallback: string | null, asSecret: boolean): void {
    if (classifyComposeVariable(variable).kind !== "ordinary") return;
    const forced = asSecret || (fallback !== null && (envValueProblem(fallback) === "ENV_VALUE_SECRET_LIKE" || urlPasswordSpans(fallback).length > 0));
    const plain = fallback !== null && isPlainSetting(variable, fallback);
    const known = this.seen.get(variable);
    if (known === undefined) {
      this.seen.set(variable, { fallback, conflict: false, forced, plain, guarded: fallback !== null && !plain });
      return;
    }
    known.forced ||= forced;
    known.plain ||= plain;
    known.guarded ||= fallback !== null && !plain;
    // The first default of the file wins: one parameter has one default.
    if (known.fallback === null) known.fallback = fallback;
    else if (fallback !== null && fallback !== known.fallback) known.conflict = true;
  }

  /**
   * A variable with a secret-looking name is a secret unless the file only ever gives it a default that is plainly a
   * setting: `${DB_PASS:-...}` is a secret, `${API_TOKEN_TTL:-30}` is not.
   */
  get(variable: string): VariableFacts {
    const known = this.seen.get(variable);
    if (known === undefined) return { fallback: null, conflict: false, secret: looksSecretName(variable) };
    const named = looksSecretName(variable) && (known.guarded || !known.plain);
    return { fallback: known.fallback, conflict: known.conflict, secret: known.forced || named };
  }
}

export class ParameterRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly byVariable = new Map<string, string>();
  /**
   * Secrets the file writes in the clear, by the text a container would receive. Equal ones share one parameter: this
   * is how a database password written twice, under two names or inside an address, still reaches both services.
   */
  private readonly byLiteral = new Map<string, string>();
  /** Secret-looking values that are not plain text (they hold a variable or a '$' form the importer cannot read). */
  private readonly byWritten = new Map<string, string>();
  /** The literal secrets distinctive enough to be recognised anywhere, longest first. */
  private readonly distinctive: { readonly literal: string; readonly key: string }[] = [];
  private full = false;
  /** Stands for every literal secret met past the bound: such a file is refused, and needs no key for each of them. */
  private overflow: DraftParameter | undefined;
  /** The next suffix to try for a stem. A key is never freed, so every suffix below it is taken. */
  private readonly suffixes = new Map<string, number>();
  private uses = 0;

  constructor(
    private readonly report: ImportReport,
    private readonly census: VariableCensus,
  ) {}

  /** A key the validator accepts, derived from a variable name. */
  private allocate(name: string): string {
    let stem = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    if (!/^[a-z]/.test(stem) || stem.startsWith("hp_")) stem = `p_${stem}`;
    stem = stem.slice(0, 32);
    let key = stem;
    let n = this.suffixes.get(stem) ?? 2;
    for (; this.entries.has(key); n++) key = `${stem.slice(0, 32 - `_${n}`.length)}_${n}`;
    this.suffixes.set(stem, n);
    return key;
  }

  private add(parameter: DraftParameter, notes: Note[]): DraftParameter {
    this.entries.set(parameter.key, { parameter, notes, order: null });
    return parameter;
  }

  private remember(literal: string, key: string): void {
    if (this.byLiteral.size >= LITERAL_SECRETS_MAX) {
      this.full = true;
      return;
    }
    this.byLiteral.set(literal, key);
    if (!isDistinctiveSecret(literal)) return;
    const shorter = this.distinctive.findIndex((known) => known.literal.length < literal.length);
    this.distinctive.splice(shorter === -1 ? this.distinctive.length : shorter, 0, { literal, key });
  }

  /** The parameter that already stands for this literal secret, if any. */
  private literalSecret(literal: string): DraftParameter | undefined {
    const key = this.byLiteral.get(literal);
    return key === undefined ? undefined : this.entries.get(key)?.parameter;
  }

  /**
   * True when the file writes more secrets in the clear than the importer follows. The ones past the bound would not
   * be recognised where they are written again, so such a file gives no draft.
   */
  get overflowed(): boolean {
    return this.full;
  }

  /** The parameter a variable becomes; null for a platform URL variable, which is never a parameter. */
  forVariable(variable: string): DraftParameter | null {
    const known = this.byVariable.get(variable);
    if (known !== undefined) return this.entries.get(known)?.parameter ?? null;
    const kind = classifyComposeVariable(variable);
    if (kind.kind === "ingress") return null;
    const shown = clip(variable);
    const label = clip(variable, LIMITS.parameterLabel);
    let parameter: DraftParameter;
    if (kind.kind === "generated") {
      const key = this.allocate(variable.replace(/^SERVICE_/, ""));
      const made = `the generated secret parameter '${key}' (${describeGenerate(kind.generate)})`;
      parameter = this.add({ key, label, secret: true, generate: kind.generate }, [
        { level: "info", code: "SECRET_FROM_VARIABLE", message: `The variable ${shown} became ${made}.` },
        ...(kind.adjusted === null
          ? []
          : [
              {
                level: "changed" as const,
                code: "SECRET_KIND_ADJUSTED" as const,
                message:
                  kind.adjusted === "length"
                    ? `The length asked by the variable ${shown} is outside what the platform generates: '${key}' is ${describeGenerate(kind.generate)}.`
                    : `The platform does not generate the kind asked by the variable ${shown}: '${key}' is the nearest one, ${describeGenerate(kind.generate)}.`,
              },
            ]),
      ]);
    } else {
      const facts = this.census.get(variable);
      // A default spelled like a weak secret ('wordpress') is that secret only under a variable that is one itself.
      const same = facts.fallback !== null && (facts.secret || isDistinctiveSecret(facts.fallback));
      const shared = same && facts.fallback !== null ? this.literalSecret(facts.fallback) : undefined;
      const entry = shared === undefined ? undefined : this.entries.get(shared.key);
      if (shared !== undefined && entry !== undefined) {
        // The default of the variable is a secret the file also writes elsewhere: both must receive the same value.
        entry.notes.push({
          level: "changed",
          code: "SECRET_GENERATED",
          message: `The default of the variable ${shown} is a secret the file writes elsewhere too: the variable stands for the same generated secret parameter '${shared.key}'. The default is not kept.`,
        });
        this.byVariable.set(variable, shared.key);
        return shared;
      }
      const key = this.allocate(variable);
      if (facts.secret) {
        parameter = this.add({ key, label, secret: true, generate: DEFAULT_GENERATE }, [
          {
            level: "changed",
            code: "SECRET_GENERATED",
            message: `The variable ${shown} holds a secret: it became the generated secret parameter '${key}' (${describeGenerate(DEFAULT_GENERATE)}); a default written in the file is not kept.`,
          },
        ]);
        // Another variable with the same default, or the same text written in the clear, is the same secret.
        if (facts.fallback !== null && facts.fallback !== "") this.remember(facts.fallback, key);
      } else {
        const kept = facts.fallback !== null && isStringDefault(facts.fallback) && !this.holdsSecret(facts.fallback);
        const conflict: Note[] = facts.conflict
          ? [{ level: "changed", code: "PARAMETER_DEFAULT_DROPPED", message: `The variable ${shown} has more than one default in the file: only the first is kept.` }]
          : [];
        parameter = this.add({ key, label, secret: false, default: kept ? (facts.fallback ?? "") : "", customer: !kept }, [
          kept
            ? { level: "info", code: "PARAMETER_FROM_VARIABLE", message: `The variable ${shown} became the parameter '${key}' with the default of the file.` }
            : {
                level: "changed",
                code: "PARAMETER_REQUIRED",
                message:
                  facts.fallback === null
                    ? `The variable ${shown} has no default: it became the parameter '${key}', empty until the customer fills it in.`
                    : `The default of the variable ${shown} cannot be kept: it became the parameter '${key}', empty until the customer fills it in.`,
              },
          ...conflict,
        ]);
      }
    }
    this.byVariable.set(variable, parameter.key);
    return parameter;
  }

  /**
   * The generated secret that replaces a secret written in the file, named after the environment variable that held
   * it. `literal` is the text a container would receive.
   */
  forLiteralSecret(envName: string, literal: string): DraftParameter {
    const existing = this.literalSecret(literal) ?? this.overflow;
    if (existing !== undefined) return existing;
    const key = this.allocate(envName);
    this.remember(literal, key);
    const parameter = this.add({ key, label: clip(envName, LIMITS.parameterLabel), secret: true, generate: DEFAULT_GENERATE }, []);
    if (this.full) this.overflow = parameter;
    return parameter;
  }

  /** The same for a value that is not plain text; `written` is the value as the file gives it. */
  forWrittenSecret(envName: string, written: string): DraftParameter {
    const known = this.byWritten.get(written);
    const existing = known === undefined ? undefined : this.entries.get(known)?.parameter;
    if (existing !== undefined) return existing;
    const key = this.allocate(envName);
    this.byWritten.set(written, key);
    return this.add({ key, label: clip(envName, LIMITS.parameterLabel), secret: true, generate: DEFAULT_GENERATE }, []);
  }

  /**
   * Cuts a text where it holds a distinctive secret of the file: the stretches of plain text and, between them, the
   * parameters that stand for the secrets. A text without one comes back whole.
   */
  cutAtSecrets(text: string): (string | DraftParameter)[] {
    let parts: (string | DraftParameter)[] = [text];
    for (const { literal, key } of this.distinctive) {
      const parameter = this.entries.get(key)?.parameter;
      if (parameter === undefined) continue;
      parts = parts.flatMap((part) => {
        if (typeof part !== "string" || !part.includes(literal)) return [part];
        const stretches = part.split(literal);
        return stretches.flatMap((stretch, index) => (index === 0 ? [stretch] : [parameter, stretch]));
      });
    }
    return parts.filter((part) => part !== "");
  }

  /** True when a text holds a distinctive secret of the file. */
  holdsSecret(text: string): boolean {
    return this.distinctive.some(({ literal }) => text.includes(literal));
  }

  /** Marks a parameter as part of the draft and says where it comes from: once, and again when another variable joins it. */
  use(key: string, path: TemplatePath): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.order ??= this.uses++;
    for (const note of entry.notes.splice(0)) this.report.add(note.level, note.code, path, note.message);
  }

  /** The parameters of the draft, in the order the kept parts of the file first use them. */
  used(): DraftParameter[] {
    return [...this.entries.values()]
      .flatMap((entry) => (entry.order === null ? [] : [{ parameter: entry.parameter, order: entry.order }]))
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.parameter);
  }
}
