import { z } from "zod";
import { validateServiceVolumeMount } from "../ipc-schemas.js";
import {
  APP_STACK_ENV_NAME_PATTERN,
  APP_STACK_HEALTH_PATH_PATTERN,
  APP_STACK_SECRET_DIR,
  APP_TEMPLATE_LIMITS,
  AppStackPortSchema,
} from "./limits.js";

/** Pure, total rules; a result never echoes the text checked. */

export type AppStackTextProblem = "control_character" | "docker_socket" | "metadata_endpoint" | "url_credentials" | "process_mark";

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cs}]/u;
const METADATA_ENDPOINTS = [/169\.254\./, /fd00:ec2::/i, /metadata\.google\.internal/i];

/**
 * The environment variables that mark what a platform feature started in a component: a terminal session (ADR-0041)
 * and a run of a scheduled task. A clean-up finds those programs by "<mark>=" as text in /proc/<pid>/environ read
 * without its separators, with nothing that bounds it on the left, so no value of a component may hold that text. A
 * closed list: a feature that adds a mark adds it here, and every check below follows.
 */
export const APP_STACK_PROCESS_MARKS = ["HP_TERMINAL_SESSION", "HP_TASK_RUN"] as const;

/** "<mark>=" for any mark of the list, anywhere in the text; literals only, so linear on any input. */
export const APP_STACK_PROCESS_MARK_PATTERN = new RegExp(APP_STACK_PROCESS_MARKS.map((mark) => `${mark}=`).join("|"));

/** First matching rule in the order of AppStackTextProblem, else null. */
export function appStackTextProblem(text: string): AppStackTextProblem | null {
  if (CONTROL_CHARACTER.test(text)) return "control_character";
  if (/docker\.sock/i.test(text)) return "docker_socket";
  if (METADATA_ENDPOINTS.some((pattern) => pattern.test(text))) return "metadata_endpoint";
  if (/:\/\/[^/\s:@]+:[^/\s@]+@/.test(text)) return "url_credentials";
  if (APP_STACK_PROCESS_MARK_PATTERN.test(text)) return "process_mark";
  return null;
}

/** Basenames refused in argv (spec §7.3): no shell, directly or through env/busybox/toybox. */
export const APP_STACK_SHELL_INTERPRETERS = [
  "sh",
  "bash",
  "rbash",
  "dash",
  "ash",
  "zsh",
  "ksh",
  "mksh",
  "lksh",
  "pdksh",
  "oksh",
  "loksh",
  "yash",
  "posh",
  "hush",
  "csh",
  "tcsh",
  "fish",
  "busybox",
  "toybox",
  "env",
] as const;

const basenameOf = (item: string): string => item.slice(item.lastIndexOf("/") + 1);

/** Any argv item: its basename (text after the last "/"), trimmed, names a shell. */
export function appStackArgvItemProblem(item: string): "shell" | null {
  return (APP_STACK_SHELL_INTERPRETERS as readonly string[]).includes(basenameOf(item).trim()) ? "shell" : null;
}

export function appStackArgvExecutableProblem(argv0: string): "empty" | "shell" | null {
  return basenameOf(argv0) === "" ? "empty" : appStackArgvItemProblem(argv0);
}

/** Platform-owned besides FORBIDDEN_CONTAINER_MOUNT_TARGETS: /run (secret files) and /tmp (the bounded tmpfs). */
export const APP_STACK_RESERVED_CONTAINER_PATHS = ["/run", "/tmp"] as const;

const hasDotSegment = (path: string): boolean => path.split("/").some((segment) => segment === "." || segment === "..");

export function appStackContainerPathProblem(path: string): "invalid" | "reserved" | null {
  if (
    !/^\/[A-Za-z0-9._/-]{1,254}$/.test(path) ||
    path.includes("//") ||
    path.endsWith("/") ||
    hasDotSegment(path) ||
    !validateServiceVolumeMount({ volumeSuffix: "v", containerPath: path }).valid
  ) {
    return "invalid";
  }
  return APP_STACK_RESERVED_CONTAINER_PATHS.some((reserved) => path === reserved || path.startsWith(`${reserved}/`)) ? "reserved" : null;
}

export const APP_STACK_RESERVED_ENV_PREFIXES = ["HP_", "LD_", "DOCKER_"] as const;
export const APP_STACK_RESERVED_ENV_NAMES = ["PATH"] as const;

const isReservedEnvName = (name: string): boolean =>
  APP_STACK_RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) || (APP_STACK_RESERVED_ENV_NAMES as readonly string[]).includes(name);

/** Plan-level rule for a {name, value} entry; the validator adds the stricter site rules on top. */
export function appStackEnvValueNameProblem(name: string): "invalid" | "reserved" | null {
  if (!APP_STACK_ENV_NAME_PATTERN.test(name)) return "invalid";
  return name.endsWith("_FILE") || isReservedEnvName(name) ? "reserved" : null;
}

/** A secret-file env name ends in "_FILE" after a non-empty base; neither the name nor the base is reserved. */
export function appStackSecretEnvNameProblem(name: string): "invalid" | null {
  if (!APP_STACK_ENV_NAME_PATTERN.test(name) || !name.endsWith("_FILE")) return "invalid";
  const base = name.slice(0, -"_FILE".length);
  return base === "" || isReservedEnvName(name) || isReservedEnvName(base) ? "invalid" : null;
}

export function appStackHealthPathProblem(path: string): "invalid" | null {
  return !APP_STACK_HEALTH_PATH_PATTERN.test(path) || path.includes("//") || hasDotSegment(path) ? "invalid" : null;
}

export function appStackSecretFilePath(parameterKey: string): string {
  return `${APP_STACK_SECRET_DIR}/${parameterKey}`;
}

const HealthTiming = {
  intervalSeconds: z.number().int().min(APP_TEMPLATE_LIMITS.healthIntervalMin).max(APP_TEMPLATE_LIMITS.healthIntervalMax),
  timeoutSeconds: z.number().int().min(APP_TEMPLATE_LIMITS.healthTimeoutMin).max(APP_TEMPLATE_LIMITS.healthTimeoutMax),
};

/** The probe always targets the component's own address on the stack network: no host, URL or scheme here. */
export const AppStackHealthcheckSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("tcp"), port: AppStackPortSchema, ...HealthTiming }).strict(),
    z
      .object({
        kind: z.literal("http"),
        port: AppStackPortSchema,
        path: z.string().refine((path) => appStackHealthPathProblem(path) === null),
        ...HealthTiming,
      })
      .strict(),
  ])
  .refine((check) => check.timeoutSeconds <= check.intervalSeconds, { path: ["timeoutSeconds"] });
export type AppStackHealthcheck = z.infer<typeof AppStackHealthcheckSchema>;
