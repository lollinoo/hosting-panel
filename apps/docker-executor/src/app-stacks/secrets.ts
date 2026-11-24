import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { APP_STACK_KEY_PATTERN, APP_STACK_SECRET_CONTENT_MAX_CHARS } from "@hosting-panel/contracts";
import type { ServiceLogLine } from "@hosting-panel/executor-contracts";
import { purgeServiceSecrets, writeServiceSecrets } from "../docker-engine-adapter.js";
import { ExecutorCodedError } from "../traefik-config.js";
import { decodeAppStackSecretEnvLabel } from "./container-payload.js";
import { APP_STACK_LABELS, appStackSecretDirKey } from "./names.js";

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

/** The secrets inside one environment value, by its pieces (template text, null = a secret): null when the value does
 *  not hold that text, "ambiguous" when the text could split it more than one way (two secrets side by side, or the
 *  text between two secrets also inside one of them). */
function splitAppStackSecretValue(value: string, pieces: readonly (string | null)[]): string[] | "ambiguous" | null {
  const first = pieces[0];
  const last = pieces.at(-1);
  const prefix = typeof first === "string" ? first : "";
  const suffix = typeof last === "string" ? last : "";
  if (prefix.length + suffix.length > value.length || !value.startsWith(prefix) || !value.endsWith(suffix)) return null;
  const inner = pieces.slice(prefix === "" ? 0 : 1, suffix === "" ? pieces.length : -1);
  const separators = inner.filter((piece): piece is string => piece !== null);
  if (inner.length !== 2 * separators.length + 1) return "ambiguous";
  const begin = prefix.length;
  const end = value.length - suffix.length;
  // Each separator at its first place, then at its last: the split is the value's only one when both agree.
  const earliest: number[] = [];
  for (let i = 0, cursor = begin; i < separators.length; i++) {
    const separator = separators[i] ?? "";
    const at = value.indexOf(separator, cursor);
    if (at === -1 || at + separator.length > end) return null;
    earliest.push(at);
    cursor = at + separator.length;
  }
  const latest: number[] = [];
  for (let i = separators.length - 1, cursor = end; i >= 0; i--) {
    const separator = separators[i] ?? "";
    const at = value.lastIndexOf(separator, cursor - separator.length);
    if (at < begin) return null;
    latest.unshift(at);
    cursor = at;
  }
  if (earliest.some((at, i) => at !== latest[i])) return "ambiguous";
  const starts = [begin, ...earliest.map((at, i) => at + (separators[i] ?? "").length)];
  const ends = [...earliest, end];
  return starts.map((start, i) => value.slice(start, ends[i]));
}

/** The values the log reader masks: the component's secret files (`fileValues`) and the environment secrets its
 *  container holds, which its label names and its own Config.Env gives, so they outlive the tmpfs (a reboot). Throws,
 *  before any log is read, when they cannot be established: a label that is not the executor's, a name that is not
 *  once in the environment, a value without the label's text, or a value only the files can split and no file. */
export function appStackLogMaskValues(
  componentKey: string,
  container: { readonly labels: Readonly<Record<string, string>> | null | undefined; readonly env: readonly string[] | null | undefined },
  fileValues: readonly string[],
): string[] {
  const unmaskable = () => new ExecutorCodedError(`The logs of component ${componentKey} cannot be masked`, "DOCKER_ENGINE_UNAVAILABLE");
  const label = container.labels?.[APP_STACK_LABELS.secretEnvironment];
  if (label === undefined) return [...fileValues];
  const entries = decodeAppStackSecretEnvLabel(label);
  const env = container.env;
  if (entries === null || !Array.isArray(env)) throw unmaskable();
  const values = [...fileValues];
  for (const { name, pieces } of entries) {
    const found = env.filter((entry) => typeof entry === "string" && entry.startsWith(`${name}=`));
    if (found.length !== 1) throw unmaskable();
    const parts = splitAppStackSecretValue((found[0] ?? "").slice(name.length + 1), pieces);
    if (parts === null || (parts === "ambiguous" && fileValues.length === 0)) throw unmaskable();
    if (parts !== "ambiguous") values.push(...parts);
  }
  return values;
}

/** Aho-Corasick automaton: an edge is next.get(charCode).get(node); node 0 is the root. */
interface Automaton {
  readonly next: Map<number, Map<number, number>>;
  readonly fail: number[];
  readonly depth: number[];
  /** Length of the longest needle that ends the node's string, 0 for none. */
  readonly found: number[];
}

function step(automaton: Automaton, from: number, code: number): number {
  const children = automaton.next.get(code);
  if (children === undefined) return 0;
  for (let node = from; ; node = automaton.fail[node] ?? 0) {
    const child = children.get(node);
    if (child !== undefined) return child;
    if (node === 0) return 0;
  }
}

function buildAutomaton(needles: readonly string[]): Automaton {
  const automaton: Automaton = { next: new Map(), fail: [0], depth: [0], found: [0] };
  const { next, fail, depth, found } = automaton;
  const levels: [number, number, number][][] = [];
  for (const needle of needles) {
    let node = 0;
    for (let i = 0; i < needle.length; i++) {
      const code = needle.charCodeAt(i);
      let children = next.get(code);
      if (children === undefined) next.set(code, (children = new Map()));
      let child = children.get(node);
      if (child === undefined) {
        child = depth.length;
        children.set(node, child);
        (levels[i] ??= []).push([child, node, code]);
        fail.push(0);
        depth.push(i + 1);
        found.push(0);
      }
      node = child;
    }
    found[node] = needle.length;
  }
  for (const [node, parent, code] of levels.slice(1).flat()) {
    const suffix = step(automaton, fail[parent] ?? 0, code);
    fail[node] = suffix;
    if (found[node] === 0) found[node] = found[suffix] ?? 0;
  }
  return automaton;
}

/** Every match of each value (and of each line of a multi-line value) of length >= 6 becomes "[REDACTED]", and so
 *  does a line end of >= 6 characters that starts a value or a line start that ends one (a value whose other part is
 *  in a frame the read did not return); overlapping matches are merged first, so no part of either value stays
 *  visible. Pure; one pass over each line in each direction, whatever the values. */
export function maskAppStackLogLines(lines: readonly ServiceLogLine[], values: readonly string[]): ServiceLogLine[] {
  const min = APP_STACK_LOG_MASK_MIN_LENGTH;
  const needles = [...new Set(values.flatMap((value) => [value, ...value.split(/\r?\n/)]))].filter((needle) => needle.length >= min);
  const forward = buildAutomaton(needles);
  const backward = buildAutomaton(needles.map((needle) => needle.split("").reverse().join("")));
  const longest = needles.reduce((max, needle) => Math.max(max, needle.length), 0);
  return lines.map((line) => {
    const source = line.text;
    const matches: [number, number][] = [];
    let node = 0;
    for (let i = 0; i < source.length; i++) {
      node = step(forward, node, source.charCodeAt(i));
      const length = forward.found[node] ?? 0;
      if (length > 0) matches.push([i + 1 - length, i + 1]);
    }
    const tail = forward.depth[node] ?? 0;
    if (tail >= min) matches.push([source.length - tail, source.length]);
    node = 0;
    for (let i = Math.min(source.length, longest) - 1; i >= 0; i--) node = step(backward, node, source.charCodeAt(i));
    const head = backward.depth[node] ?? 0;
    if (head >= min) matches.push([0, head]);
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
