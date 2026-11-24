/**
 * The draft as template source, in the YAML subset `parseTemplateYaml` reads: block style, one key per line, every
 * text that comes from the file in double quotes. Keys, kinds and numbers are plain: the importer has checked them.
 * Pure and synchronous.
 */
import type { DraftEnvEntry } from "./compose-import-environment.js";
import type { DraftParameter } from "./compose-import-parameters.js";
import type { DraftHealthcheck, DraftLimits } from "./compose-import-runtime.js";

export interface DraftService {
  readonly key: string;
  readonly image: string;
  readonly command: readonly string[] | null;
  readonly environment: readonly DraftEnvEntry[];
  readonly mounts: readonly string[];
  readonly expose: readonly number[];
  readonly dependsOn: readonly string[];
  readonly healthcheck: DraftHealthcheck | null;
  readonly limits: DraftLimits;
}

export interface Draft {
  readonly name: string;
  readonly category: string;
  readonly parameters: readonly DraftParameter[];
  readonly services: readonly DraftService[];
  readonly volumes: readonly string[];
  readonly ingress: readonly { readonly service: string; readonly port: number }[];
}

const hex4 = (char: string): string => char.charCodeAt(0).toString(16).padStart(4, "0");

/** A double-quoted scalar: the reader takes it as text whatever it looks like ('yes', '80', '1.0', 'null'). */
const quote = (text: string): string =>
  `"${text.replace(/["\\]/g, (char) => `\\${char}`).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (char) => `\\u${hex4(char)}`)}"`;

export function emitDraft(draft: Draft): string {
  const lines: string[] = [];
  const put = (depth: number, text: string): void => {
    lines.push(`${"  ".repeat(depth)}${text}`);
  };
  /** A list of scalars under `key`; nothing at all when the list is empty. */
  const list = (depth: number, key: string, items: readonly (string | number)[]): void => {
    if (items.length === 0) return;
    put(depth, `${key}:`);
    for (const item of items) put(depth + 1, `- ${typeof item === "number" ? String(item) : quote(item)}`);
  };

  put(0, "x-hp-stack:");
  put(1, "schemaVersion: 2");
  put(1, `name: ${quote(draft.name)}`);
  put(1, `category: ${quote(draft.category)}`);

  if (draft.parameters.length > 0) put(0, "x-hp-parameters:");
  for (const parameter of draft.parameters) {
    put(1, `- key: ${quote(parameter.key)}`);
    put(2, `label: ${quote(parameter.label)}`);
    if (parameter.secret) {
      put(2, "type: secret");
      put(2, "required: true");
      put(2, "customer: false");
      put(2, "generate:");
      put(3, `kind: ${parameter.generate.kind}`);
      put(3, `length: ${parameter.generate.length}`);
    } else {
      put(2, "type: string");
      put(2, `default: ${quote(parameter.default)}`);
      put(2, `customer: ${parameter.customer}`);
    }
  }

  put(0, "services:");
  for (const service of draft.services) {
    put(1, `${service.key}:`);
    put(2, "x-hp-profile: standard");
    put(2, `image: ${quote(service.image)}`);
    list(2, "command", service.command ?? []);
    if (service.environment.length > 0) put(2, "environment:");
    for (const entry of service.environment) {
      put(3, `- name: ${quote(entry.name)}`);
      put(4, "value" in entry ? `value: ${quote(entry.value)}` : `secret: ${quote(entry.secret)}`);
    }
    list(2, "volumes", service.mounts);
    list(2, "expose", service.expose);
    list(2, "depends_on", service.dependsOn);
    const check = service.healthcheck;
    if (check !== null) {
      put(2, "healthcheck:");
      put(3, `kind: ${check.kind}`);
      put(3, `port: ${check.port}`);
      if (check.kind === "http") put(3, `path: ${quote(check.path)}`);
      put(3, `intervalSeconds: ${check.intervalSeconds}`);
      put(3, `timeoutSeconds: ${check.timeoutSeconds}`);
    }
    put(2, "deploy:");
    put(3, "resources:");
    put(4, "limits:");
    put(5, `cpus: ${quote(service.limits.cpus)}`);
    put(5, `memory: ${quote(service.limits.memory)}`);
  }

  if (draft.volumes.length > 0) put(0, "volumes:");
  for (const volume of draft.volumes) put(1, `${volume}: {}`);

  if (draft.ingress.length > 0) put(0, "x-hp-ingress:");
  for (const route of draft.ingress) {
    put(1, `- service: ${quote(route.service)}`);
    put(2, `port: ${route.port}`);
    put(2, "protocol: http");
  }
  return `${lines.join("\n")}\n`;
}
