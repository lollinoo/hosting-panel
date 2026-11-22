/**
 * Report of the Compose importer: one note for everything it kept with a remark, changed, dropped or refused.
 * A message is fixed English text plus names the importer has checked and paths: it never echoes a value of the file.
 */
import { COMPOSE_IMPORT_REPORT_MAX, formatTemplatePath, type ComposeImportLevel, type TemplatePath } from "@hosting-panel/contracts";

/** One code per rule. A code always comes with the same level, written next to it. */
export const COMPOSE_IMPORT_CODES = Object.freeze([
  // The file as a whole
  "INPUT_TOO_LARGE", // refused
  "YAML_UNREADABLE", // refused
  "DOCUMENT_INVALID", // refused
  "HEADER_INVALID", // refused
  "SERVICES_TOO_MANY", // refused
  "SERVICE_NAME_INVALID", // refused
  "VALUE_INVALID", // refused: a key the importer reads holds the wrong kind of value
  "KEY_DROPPED", // dropped
  "KEY_REFUSED", // refused
  "KEY_UNKNOWN", // refused
  // image
  "IMAGE_MISSING", // refused
  "IMAGE_INVALID", // refused
  "IMAGE_UNRESOLVED", // refused
  "IMAGE_PINNED", // changed
  "IMAGE_TAG_DROPPED", // changed
  "IMAGE_DIGEST_KEPT", // info
  // environment, variables and parameters
  "ENV_NAME_INVALID", // dropped
  "ENV_NAME_RESERVED", // dropped
  "ENV_PASSTHROUGH_DROPPED", // dropped
  "ENV_DUPLICATE_DROPPED", // dropped
  "ENV_VALUE_DROPPED", // dropped
  "ENV_SETTING_DROPPED", // dropped: a plain setting under a name the platform keeps for secrets
  "ENV_VARIABLE_SYNTAX", // dropped
  "ENV_URL_VARIABLE_DROPPED", // dropped
  "ENV_TOO_MANY", // refused
  "SECRET_GENERATED", // changed
  "SECRET_EXTRACTED", // changed: a part of a value was a secret
  "SECRET_FROM_VARIABLE", // info
  "SECRET_KIND_ADJUSTED", // changed
  "SECRET_EMPTY_DROPPED", // dropped
  "SECRET_REFERENCES_TOO_MANY", // refused
  "SECRETS_TOO_MANY", // refused
  "PARAMETER_FROM_VARIABLE", // info
  "PARAMETER_REQUIRED", // changed
  "PARAMETER_DEFAULT_DROPPED", // changed
  "PARAMETERS_TOO_MANY", // refused
  "INGRESS_FROM_VARIABLE", // changed
  "INGRESS_PORT_DEFAULTED", // info
  "INGRESS_PORT_UNKNOWN", // refused
  "INGRESS_TOO_MANY", // refused
  // volumes
  "VOLUME_HOST_PATH", // refused
  "VOLUME_DOCKER_SOCKET", // refused
  "VOLUME_INVALID", // refused
  "VOLUME_TARGET_REFUSED", // refused
  "VOLUME_TOO_MANY", // refused
  "VOLUME_RENAMED", // changed
  "VOLUME_OPTION_DROPPED", // dropped
  "VOLUME_ANONYMOUS_DROPPED", // dropped
  "VOLUME_UNUSED_DROPPED", // dropped
  // ports, expose, depends_on
  "PORTS_DROPPED", // dropped
  "PORTS_ITEM_UNREAD", // dropped
  "EXPOSE_DROPPED", // dropped
  "EXPOSE_ADDED", // info
  "EXPOSE_TOO_MANY", // refused
  "DEPENDS_ON_INVALID", // refused
  "DEPENDS_ON_CYCLE", // refused
  "DEPENDS_ON_CONDITION_DROPPED", // dropped
  "DEPENDS_ON_OPTIONAL_KEPT", // changed
  // healthcheck, command, limits
  "HEALTHCHECK_CONVERTED", // changed
  "HEALTHCHECK_TIMING_ADJUSTED", // changed
  "HEALTHCHECK_ADDED", // info
  "HEALTHCHECK_DROPPED", // dropped
  "COMMAND_SPLIT", // changed
  "COMMAND_REFUSED", // refused
  "COMMAND_SECRET_REFUSED", // refused
  "COMMAND_EMPTY_DROPPED", // dropped
  "LIMITS_DEFAULTED", // info
  "LIMITS_ADJUSTED", // changed
  "LIMITS_OVERRIDDEN", // dropped
  // the importer itself
  "DRAFT_INVALID", // refused
  "IMPORT_FAILED", // refused
  "REPORT_TRUNCATED", // info
] as const);
export type ComposeImportCode = (typeof COMPOSE_IMPORT_CODES)[number];

export type { ComposeImportLevel };

export interface ComposeImportNote {
  level: ComposeImportLevel;
  path: string;
  code: ComposeImportCode;
  message: string;
}

/** A report never holds more notes than this (the bound of the DTO); the last one then says how many are not shown. */
export { COMPOSE_IMPORT_REPORT_MAX };

const PATH_MAX = 512;

/**
 * A key of the file is shown in a path only when it is a plain name. Anything else could be a value written where a
 * key belongs ('NAME=value' in a mapping) or text that misleads the reader, and is shown as '?'.
 */
const PLAIN_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;
const shownPath = (path: TemplatePath): string =>
  formatTemplatePath(path.map((segment) => (typeof segment === "number" || PLAIN_SEGMENT.test(segment) ? segment : "?")));

/** Never cuts a surrogate pair in two. */
export const clip = (text: string, max = 64): string =>
  text.length > max ? `${text.slice(0, max - 3).replace(/[\ud800-\udbff]$/, "")}...` : text;

export class ImportReport {
  private readonly all: ComposeImportNote[] = [];

  /** `path` is a document path, or one the validator already formatted. */
  add(level: ComposeImportLevel, code: ComposeImportCode, path: TemplatePath | string, message: string): void {
    this.all.push({ level, path: clip(typeof path === "string" ? path : shownPath(path), PATH_MAX), code, message });
  }

  info(code: ComposeImportCode, path: TemplatePath, message: string): void {
    this.add("info", code, path, message);
  }

  changed(code: ComposeImportCode, path: TemplatePath, message: string): void {
    this.add("changed", code, path, message);
  }

  dropped(code: ComposeImportCode, path: TemplatePath, message: string): void {
    this.add("dropped", code, path, message);
  }

  /** Any refusal means no draft. Returns null so a reader can refuse and give up in one statement. */
  refused(code: ComposeImportCode, path: TemplatePath, message: string): null {
    this.add("refused", code, path, message);
    return null;
  }

  get hasRefusal(): boolean {
    return this.all.some((note) => note.level === "refused");
  }

  /** The notes in the order found. Over the bound, refusals are kept first: they decide the outcome. */
  list(): ComposeImportNote[] {
    if (this.all.length <= COMPOSE_IMPORT_REPORT_MAX) return [...this.all];
    const room = COMPOSE_IMPORT_REPORT_MAX - 1;
    let refusals = Math.min(room, this.all.filter((note) => note.level === "refused").length);
    let others = room - refusals;
    const kept = this.all.filter((note) => (note.level === "refused" ? refusals-- > 0 : others-- > 0));
    const hidden = this.all.length - kept.length;
    kept.push({ level: "info", path: "", code: "REPORT_TRUNCATED", message: `The report is cut to ${COMPOSE_IMPORT_REPORT_MAX} notes: ${hidden} more are not shown.` });
    return kept;
  }
}
