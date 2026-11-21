import { z } from "zod";

/** The only PHP directives a site template may set. Anything else (disable_functions, open_basedir, ...) is refused. */
export const PHP_SETTING_KEYS = ["upload_max_filesize", "post_max_size", "memory_limit", "max_execution_time", "max_input_time", "max_input_vars"] as const;
export type PhpSettingKey = (typeof PHP_SETTING_KEYS)[number];

/** Positive size with a binary unit, upper case only: no `-1`, no `0`, no sign, no space, no `MB`, no fraction. */
export const PHP_SIZE_PATTERN = /^[1-9][0-9]{0,4}[KMG]$/;
/** Positive whole number without sign, space or leading zero. */
export const PHP_INT_PATTERN = /^[1-9][0-9]{0,5}$/;

export type PhpSettingRule =
  | { readonly kind: "size"; readonly maxBytes: bigint }
  | { readonly kind: "int"; readonly min: number; readonly max: number };

const GIB = 1024n ** 3n;

export const PHP_SETTING_RULES: Readonly<Record<PhpSettingKey, PhpSettingRule>> = {
  upload_max_filesize: { kind: "size", maxBytes: 4n * GIB },
  post_max_size: { kind: "size", maxBytes: 4n * GIB },
  memory_limit: { kind: "size", maxBytes: 64n * GIB },
  max_execution_time: { kind: "int", min: 1, max: 3600 },
  max_input_time: { kind: "int", min: 1, max: 3600 },
  max_input_vars: { kind: "int", min: 100, max: 100000 },
};

/** PHP's built-in values, for cross-checks (post_max_size >= upload_max_filesize) when a template sets only one side. */
export const PHP_SETTING_DEFAULTS: Readonly<Record<"upload_max_filesize" | "post_max_size" | "memory_limit", bigint>> = {
  upload_max_filesize: 2n * 1024n ** 2n,
  post_max_size: 8n * 1024n ** 2n,
  memory_limit: 128n * 1024n ** 2n,
};

const UNIT_BYTES: Readonly<Record<string, bigint>> = { K: 1024n, M: 1024n ** 2n, G: GIB };

/** `"64M"` -> `67108864n`. Throws RangeError on anything PHP_SIZE_PATTERN refuses. */
export function phpSizeToBytes(value: string): bigint {
  if (!PHP_SIZE_PATTERN.test(value)) throw new RangeError("Not a PHP size such as 64M.");
  return BigInt(value.slice(0, -1)) * UNIT_BYTES[value.slice(-1)]!;
}

/** `null` when `value` is acceptable for `key`, else a message an administrator can act on. */
export function phpSettingProblem(key: PhpSettingKey, value: string): string | null {
  const rule = PHP_SETTING_RULES[key];
  if (typeof value !== "string") return `${key} must be text.`;
  if (rule.kind === "size") {
    if (!PHP_SIZE_PATTERN.test(value)) return `${key} must be a size such as 64M (K, M or G, upper case, no spaces).`;
    if (phpSizeToBytes(value) > rule.maxBytes) return `${key} must be at most ${rule.maxBytes / GIB}G.`;
    return null;
  }
  if (!PHP_INT_PATTERN.test(value)) return `${key} must be a whole number.`;
  const n = Number(value);
  return n < rule.min || n > rule.max ? `${key} must be between ${rule.min} and ${rule.max}.` : null;
}

const settingValue = (key: PhpSettingKey) =>
  z
    .string()
    .superRefine((value, ctx) => {
      const problem = phpSettingProblem(key, value);
      if (problem) ctx.addIssue({ code: "custom", message: problem });
    })
    .optional();

/** Closed object of the PHP_SETTING_KEYS; at least one key; values can carry no newline, `;` or directive. */
export const PhpSettingsSchema: z.ZodType<Partial<Record<PhpSettingKey, string>>> = z
  .strictObject({
    upload_max_filesize: settingValue("upload_max_filesize"),
    post_max_size: settingValue("post_max_size"),
    memory_limit: settingValue("memory_limit"),
    max_execution_time: settingValue("max_execution_time"),
    max_input_time: settingValue("max_input_time"),
    max_input_vars: settingValue("max_input_vars"),
  })
  .refine((settings) => Object.values(settings).some((value) => value !== undefined),{ message: "Set at least one PHP setting." });
