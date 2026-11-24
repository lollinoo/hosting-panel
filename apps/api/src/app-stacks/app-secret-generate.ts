import { randomBytes, randomInt } from "node:crypto";
import {
  APP_SECRET_GENERATE_BOUNDS,
  appTemplateSecretGenerate,
  type AppSecretGenerate,
  type AppTemplateSpec,
} from "@hosting-panel/contracts";

// The values of generated secret parameters (ADR-0036 §2.4): made by the API once, stored as version 1 of an ordinary
// stack secret, never shown. Pure but for the randomness it is given.

export interface AppSecretRandomness {
  /** A uniform integer in [0, bound). */
  int(bound: number): number;
  bytes(count: number): Uint8Array;
}

export const SYSTEM_APP_SECRET_RANDOMNESS: AppSecretRandomness = Object.freeze({
  int: (bound: number) => randomInt(bound),
  bytes: (count: number) => randomBytes(count),
});

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGITS = "0123456789";
const ALPHANUMERIC = `${LOWER.toUpperCase()}${LOWER}${DIGITS}`;
const HEX = "0123456789abcdef";

function pick(alphabet: string, count: number, random: AppSecretRandomness): string {
  let text = "";
  for (let i = 0; i < count; i += 1) {
    const index = random.int(alphabet.length);
    if (!Number.isInteger(index) || index < 0 || index >= alphabet.length) throw new RangeError("The random index is out of range.");
    text += alphabet[index]!;
  }
  return text;
}

/**
 * "password": letters and digits; "hex": lowercase hexadecimal; "user": a lowercase letter, then lowercase letters and
 * digits; "base64": standard base64 of `length` random bytes. Throws RangeError for a length outside the bounds of its
 * kind (the validator refuses such a template first).
 */
export function generateAppSecretValue(rule: AppSecretGenerate, random: AppSecretRandomness = SYSTEM_APP_SECRET_RANDOMNESS): string {
  const bounds = APP_SECRET_GENERATE_BOUNDS[rule.kind];
  if (!Number.isInteger(rule.length) || rule.length < bounds.min || rule.length > bounds.max) {
    throw new RangeError("The generated length is outside the bounds of its kind.");
  }
  switch (rule.kind) {
    case "password":
      return pick(ALPHANUMERIC, rule.length, random);
    case "hex":
      return pick(HEX, rule.length, random);
    case "user":
      return pick(LOWER, 1, random) + pick(`${LOWER}${DIGITS}`, rule.length - 1, random);
    case "base64": {
      const bytes = random.bytes(rule.length);
      if (bytes.length !== rule.length) throw new RangeError("The random bytes have the wrong length.");
      return Buffer.from(bytes).toString("base64");
    }
  }
}

export interface AppSecretToGenerate {
  readonly parameterKey: string;
  readonly rule: AppSecretGenerate;
}

/** The generated secret parameters of `spec` without a stored version, in source order. */
export function appSecretsToGenerate(spec: AppTemplateSpec, stored: { has(parameterKey: string): boolean }): AppSecretToGenerate[] {
  return spec.parameters.flatMap((parameter) => {
    const rule = appTemplateSecretGenerate(parameter);
    return rule === null || stored.has(parameter.key) ? [] : [{ parameterKey: parameter.key, rule }];
  });
}

/** One fresh value per entry; the caller stores them and lets them go. */
export function generateAppSecretValues(
  wanted: readonly AppSecretToGenerate[],
  random: AppSecretRandomness = SYSTEM_APP_SECRET_RANDOMNESS,
): { parameterKey: string; value: string }[] {
  return wanted.map(({ parameterKey, rule }) => ({ parameterKey, value: generateAppSecretValue(rule, random) }));
}
