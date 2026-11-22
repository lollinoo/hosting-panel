import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { APP_STACK_KEY_PATTERN, APP_STACK_SECRET_CONTENT_MAX_CHARS } from "@hosting-panel/contracts";
import type { ServiceLogLine } from "@hosting-panel/executor-contracts";
import { purgeServiceSecrets, writeServiceSecrets } from "../docker-engine-adapter.js";
import { appStackSecretDirKey } from "./names.js";

export const APP_STACK_LOG_MASK = "[REDACTED]";
export const APP_STACK_LOG_MASK_MIN_LENGTH = 6;

/** Non-additive: files of keys the component no longer mounts are zero-overwritten and unlinked; a root-owned dir is set aside. */
export async function writeAppStackComponentSecrets(
  secretsRootDir: string,
  stackId: string,
  componentKey: string,
  contents: Readonly<Record<string, string>>,
): Promise<void> {
  await writeServiceSecrets(secretsRootDir, appStackSecretDirKey(stackId, componentKey), contents);
}

export async function purgeAppStackComponentSecrets(secretsRootDir: string, stackId: string, componentKey: string): Promise<void> {
  await purgeServiceSecrets(secretsRootDir, appStackSecretDirKey(stackId, componentKey));
}

/** Every dir app_<stackId>__<componentKey> under the root; other stacks' and site dirs stay. */
export async function purgeAppStackSecrets(secretsRootDir: string, stackId: string): Promise<void> {
  const prefix = `app_${stackId}__`;
  let names: string[];
  try {
    names = await readdir(secretsRootDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const name of names) {
    const componentKey = name.slice(prefix.length);
    if (name.startsWith(prefix) && APP_STACK_KEY_PATTERN.test(componentKey)) {
      await purgeAppStackComponentSecrets(secretsRootDir, stackId, componentKey);
    }
  }
}

/** Best effort: contents of the regular files of the component dir; [] on any error. */
export async function readAppStackComponentSecretValues(
  secretsRootDir: string,
  stackId: string,
  componentKey: string,
): Promise<string[]> {
  try {
    const dir = path.join(secretsRootDir, appStackSecretDirKey(stackId, componentKey));
    const values: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isFile()) values.push((await readFile(path.join(dir, entry.name), "utf8")).slice(0, APP_STACK_SECRET_CONTENT_MAX_CHARS));
    }
    return values;
  } catch {
    return [];
  }
}

/** Every match of each value (and of each line of a multi-line value) of length >= 6 becomes "[REDACTED]";
 *  overlapping matches are merged first, so no part of either value stays visible. Pure. */
export function maskAppStackLogLines(lines: readonly ServiceLogLine[], values: readonly string[]): ServiceLogLine[] {
  const needles = [...new Set(values.flatMap((value) => [value, ...value.split(/\r?\n/)]))].filter(
    (needle) => needle.length >= APP_STACK_LOG_MASK_MIN_LENGTH,
  );
  return lines.map((line) => {
    const matches: [number, number][] = [];
    for (const needle of needles) {
      for (let at = line.text.indexOf(needle); at !== -1; at = line.text.indexOf(needle, at + 1)) matches.push([at, at + needle.length]);
    }
    const merged: [number, number][] = [];
    for (const [start, end] of matches.sort((a, b) => a[0] - b[0])) {
      const last = merged.at(-1);
      if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    let text = "";
    let cursor = 0;
    for (const [start, end] of merged) {
      text += line.text.slice(cursor, start) + APP_STACK_LOG_MASK;
      cursor = end;
    }
    return { ...line, text: text + line.text.slice(cursor) };
  });
}
