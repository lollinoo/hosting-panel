/**
 * The parts of an imported service that name things outside it: its image, its volumes, its ports, the services it
 * waits for and its command. Each reader returns what the draft keeps and writes a note for the rest.
 * Pure, synchronous and never throws; a note never echoes a value other than a checked name.
 */
import {
  APP_STACK_DIGEST_PATTERN,
  APP_STACK_KEY_PATTERN,
  APP_TEMPLATE_LIMITS as LIMITS,
  appStackArgvExecutableProblem,
  appStackArgvItemProblem,
  appStackContainerPathProblem,
  appStackTextProblem,
  type TemplatePath,
} from "@hosting-panel/contracts";
import { isImageLookup, isMapping, isPort, own, type Mapping } from "./compose-import-document.js";
import { checkComposeKeys } from "./compose-import-keys.js";
import type { ParameterRegistry, VariableCensus } from "./compose-import-parameters.js";
import { clip, type ImportReport } from "./compose-import-report.js";
import { commandOption, hidesUrlPassword, holdsUrlPassword, isPlainSetting, looksSecretName, unreadableAddress } from "./compose-import-secrets.js";
import { scanComposeValue } from "./compose-import-variables.js";
import { parseImageReference } from "./image-reference.js";
import { envValueProblem } from "./site-template-env.js";

/** The validator's own tests for a mount source that is a path of the host. */
const HOST_PATH_SOURCE = /^[/.~]|\\|\.\./;
const WINDOWS_DRIVE = /^[A-Za-z]:\\/;
const DOCKER_SOCKET = /docker\.sock/i;

/**
 * The pinned reference of the draft: the name, the tag unless it is 'latest', and the digest. `digests` maps a
 * reference without digest, as written in the file, to the digest the API resolved for it.
 */
export function convertImage(report: ImportReport, raw: unknown, path: TemplatePath, digests: ReadonlyMap<string, unknown>): string | null {
  if (raw === undefined || raw === null) return report.refused("IMAGE_MISSING", path, "Every service needs an 'image': a template never builds one.");
  const invalid = (): null =>
    report.refused("IMAGE_INVALID", path, "The image is not a reference of the form [registry/]repository[:tag][@sha256:digest]; a variable is not supported there.");
  if (typeof raw !== "string") return invalid();
  const pinned = raw.includes("@");
  if (!pinned && !isImageLookup(raw)) return invalid();
  const parsed = parseImageReference(raw);
  if (!parsed.ok || (pinned && parsed.value.digest === null)) return invalid();
  const { tag } = parsed.value;
  const digest = pinned ? parsed.value.digest : digests.get(raw);
  if (typeof digest !== "string" || !APP_STACK_DIGEST_PATTERN.test(digest)) {
    return report.refused("IMAGE_UNRESOLVED", path, `No digest was resolved for the image '${clip(raw, 128)}': a template only runs a pinned image.`);
  }
  const name = raw.slice(0, raw.length - (pinned ? digest.length + 1 : 0) - (tag === null ? 0 : tag.length + 1));
  const reference = `${name}${tag === null || tag === "latest" ? "" : `:${tag}`}@${digest}`;
  if (!parseImageReference(reference).ok) return invalid();
  if (pinned) report.info("IMAGE_DIGEST_KEPT", path, "The image already names a digest: it is kept as written.");
  else report.changed("IMAGE_PINNED", path, `The image '${clip(raw, 128)}' is pinned to the digest resolved for it.`);
  if (tag === "latest") report.changed("IMAGE_TAG_DROPPED", path, "The tag 'latest' is dropped: the digest alone says which image runs.");
  else if (tag === null && !pinned) report.changed("IMAGE_TAG_DROPPED", path, "The image names no tag: the draft names it by its digest alone.");
  return reference;
}

/** The volumes of the stack: a name of the file becomes a name the platform accepts, declared once and mounted at least once. */
export class VolumeBook {
  /** Name in the file -> name in the draft. */
  private readonly names = new Map<string, string>();
  private readonly declared = new Map<string, TemplatePath>();
  private readonly mounted = new Set<string>();

  constructor(private readonly report: ImportReport) {}

  private resolve(written: string, path: TemplatePath): string | null {
    const known = this.names.get(written);
    if (known !== undefined) return known;
    const name = written.toLowerCase().replace(/[_.]/g, "-");
    if (!APP_STACK_KEY_PATTERN.test(name)) {
      return this.report.refused(
        "VOLUME_INVALID",
        path,
        "The name of the volume cannot become one the platform accepts (a lower-case letter, then lower-case letters, digits and '-', at most 32 characters).",
      );
    }
    if ([...this.names.values()].includes(name)) return this.report.refused("VOLUME_INVALID", path, `Two volumes of the file would both be named '${name}' in the draft.`);
    this.names.set(written, name);
    if (name !== written) this.report.changed("VOLUME_RENAMED", path, `The volume is named '${name}' in the draft: a volume name uses lower-case letters, digits and '-'.`);
    return name;
  }

  /** The root 'volumes' of the file. Its options (driver, external, labels...) are dropped: the platform creates and owns every volume. */
  declare(raw: unknown, path: TemplatePath): void {
    if (raw === undefined || raw === null) return;
    if (!isMapping(raw)) {
      this.report.refused("VALUE_INVALID", path, "The root 'volumes' is a mapping of volume names.");
      return;
    }
    for (const written of Object.keys(raw)) {
      const at = [...path, written];
      const options = raw[written];
      if (options !== null && !isMapping(options)) {
        this.report.refused("VALUE_INVALID", at, "A volume is declared with nothing after its name, or with a mapping of options.");
        continue;
      }
      const name = this.resolve(written, at);
      if (name === null) continue;
      this.declared.set(name, at);
      if (options !== null && Object.keys(options).length > 0) {
        this.report.dropped("VOLUME_OPTION_DROPPED", at, "The options of the volume are dropped: the platform creates and owns every volume.");
      }
    }
  }

  /** The draft name of a volume a service mounts; a name the file does not declare is declared by its use. */
  mount(written: string, path: TemplatePath): string | null {
    const name = this.resolve(written, path);
    if (name !== null) this.mounted.add(name);
    return name;
  }

  /** The volumes of the draft, in the order the file names them. A volume no service mounts would fail validation: it is dropped. */
  finish(path: TemplatePath): string[] {
    for (const [name, at] of this.declared) {
      if (!this.mounted.has(name)) this.report.dropped("VOLUME_UNUSED_DROPPED", at, "No service mounts this volume: it is dropped.");
    }
    const volumes = [...this.names.values()].filter((name) => this.mounted.has(name));
    if (volumes.length > LIMITS.volumes) this.report.refused("VOLUME_TOO_MANY", path, `A stack has at most ${LIMITS.volumes} volumes; this file mounts ${volumes.length}.`);
    return volumes;
  }
}

interface Mount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

/** Mount options that change nothing on a named volume of the platform. */
const MOUNT_FLAGS_DROPPED: readonly string[] = ["z", "Z", "cached", "delegated", "consistent", "nocopy"];
const LONG_MOUNT_KEYS: readonly string[] = ["type", "source", "target", "read_only", "consistency", "volume"];

const HOST_PATH_MESSAGE = "Bind mounts and paths of the host are refused: a template mounts named volumes only.";
const SOCKET_MESSAGE = "The Docker socket can never be mounted.";
const ANONYMOUS_MESSAGE = "An anonymous volume keeps nothing a redeploy can find again: it is dropped. Name the volume to keep its data.";

/** `name:/path[:ro]`. Null when the mount is refused, or dropped because it names no volume. */
function readShortMount(report: ImportReport, item: string, path: TemplatePath): Mount | null {
  if (DOCKER_SOCKET.test(item)) return report.refused("VOLUME_DOCKER_SOCKET", path, SOCKET_MESSAGE);
  if (item.includes("$")) return report.refused("VOLUME_INVALID", path, "A variable in a mount is not supported: write the name of the volume and the path.");
  if (WINDOWS_DRIVE.test(item)) return report.refused("VOLUME_HOST_PATH", path, HOST_PATH_MESSAGE);
  const parts = item.split(":");
  const [source = "", target, mode] = parts;
  if (HOST_PATH_SOURCE.test(source) && target !== undefined) return report.refused("VOLUME_HOST_PATH", path, HOST_PATH_MESSAGE);
  if (target === undefined && source.startsWith("/")) {
    report.dropped("VOLUME_ANONYMOUS_DROPPED", path, ANONYMOUS_MESSAGE);
    return null;
  }
  if (target === undefined || parts.length > 3) return report.refused("VOLUME_INVALID", path, "A mount is written 'volume:/path' or 'volume:/path:ro'.");
  let readOnly = false;
  for (const flag of mode === undefined ? [] : mode.split(",")) {
    if (flag === "ro") readOnly = true;
    else if (MOUNT_FLAGS_DROPPED.includes(flag)) report.dropped("VOLUME_OPTION_DROPPED", path, `The mount option '${flag}' changes nothing on the platform: it is dropped.`);
    else if (flag !== "rw") return report.refused("VOLUME_INVALID", path, "The mode of a mount is 'ro' or 'rw'.");
  }
  return { source, target, readOnly };
}

/** The long form, for `type: volume` only. */
function readLongMount(report: ImportReport, item: Mapping, path: TemplatePath): Mount | null {
  const invalid = (message: string): null => report.refused("VOLUME_INVALID", path, message);
  const source = own(item, "source");
  const target = own(item, "target");
  const readOnly = own(item, "read_only");
  const options = own(item, "volume");
  if ([source, target].some((text) => typeof text === "string" && DOCKER_SOCKET.test(text))) return report.refused("VOLUME_DOCKER_SOCKET", path, SOCKET_MESSAGE);
  if (own(item, "type") === "bind") return report.refused("VOLUME_HOST_PATH", path, HOST_PATH_MESSAGE);
  if (own(item, "type") !== "volume") return invalid("Only a mount of 'type: volume' can be imported.");
  if (Object.keys(item).some((key) => !LONG_MOUNT_KEYS.includes(key))) return invalid("This mount has a key the importer does not read for a volume.");
  if (typeof target !== "string" || (readOnly !== undefined && typeof readOnly !== "boolean")) return invalid("A mount needs a 'target' path; 'read_only' is true or false.");
  if (options !== undefined && options !== null && !(isMapping(options) && Object.keys(options).every((key) => key === "nocopy"))) {
    return invalid("The importer reads no option of a volume mount other than 'nocopy'.");
  }
  if (source === undefined || source === null) {
    report.dropped("VOLUME_ANONYMOUS_DROPPED", path, ANONYMOUS_MESSAGE);
    return null;
  }
  if (typeof source !== "string" || source.includes("$") || target.includes("$")) return invalid("The 'source' of a mount is the name of a volume, without a variable.");
  if (HOST_PATH_SOURCE.test(source) || WINDOWS_DRIVE.test(source)) return report.refused("VOLUME_HOST_PATH", path, HOST_PATH_MESSAGE);
  if (own(item, "consistency") !== undefined || isMapping(options)) {
    report.dropped("VOLUME_OPTION_DROPPED", path, "The options of the mount ('consistency', 'nocopy') change nothing on the platform: they are dropped.");
  }
  return { source, target, readOnly: readOnly === true };
}

/** The mounts of a service as `volume:/path[:ro]`. */
export function convertMounts(report: ImportReport, book: VolumeBook, raw: unknown, path: TemplatePath): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    report.refused("VALUE_INVALID", path, "The 'volumes' of a service is a list.");
    return [];
  }
  const mounts: string[] = [];
  const targets = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const at = [...path, index];
    const mount =
      typeof item === "string"
        ? readShortMount(report, item, at)
        : isMapping(item)
          ? readLongMount(report, item, at)
          : report.refused("VOLUME_INVALID", at, "A mount is text such as 'volume:/path', or a mapping.");
    if (mount === null) return;
    // Compose reads '/data/' and '/data' as one path; the platform writes it without the last '/'.
    const target = mount.target.length > 1 && mount.target.endsWith("/") ? mount.target.slice(0, -1) : mount.target;
    if (appStackContainerPathProblem(target) !== null) {
      report.refused(
        "VOLUME_TARGET_REFUSED",
        at,
        "The target of the mount is not a path a template may use: an absolute path of letters, digits, '.', '_', '-' and '/', outside the system directories, '/run' and '/tmp'.",
      );
      return;
    }
    if (targets.has(target)) {
      report.refused("VOLUME_TARGET_REFUSED", at, "A container path can be mounted once per service.");
      return;
    }
    const name = book.mount(mount.source, at);
    if (name === null) return;
    targets.add(target);
    mounts.push(`${name}:${target}${mount.readOnly ? ":ro" : ""}`);
  });
  if (mounts.length > LIMITS.mountsPerService) {
    report.refused("VOLUME_TOO_MANY", path, `A service has at most ${LIMITS.mountsPerService} mounts; this one has ${mounts.length}.`);
  }
  return mounts;
}

const asPort = (value: unknown): number | null => {
  const port = typeof value === "string" && /^[0-9]{1,5}$/.test(value) ? Number(value) : value;
  return isPort(port) ? port : null;
};

export interface ContainerPorts {
  /** The container side of the entries the importer read, each port once. */
  readonly ports: number[];
  /** True when an entry may name a TCP port the importer could not read: a range, a variable, a form it does not know. */
  readonly unread: boolean;
}

/** The container side of 'ports' (TCP, one port per entry): the published side is dropped, a stack is reached through its ingress only. */
export function readContainerPorts(report: ImportReport, raw: unknown, path: TemplatePath): ContainerPorts {
  if (raw === undefined || raw === null) return { ports: [], unread: false };
  if (!Array.isArray(raw)) {
    report.refused("VALUE_INVALID", path, "'ports' is a list.");
    return { ports: [], unread: false };
  }
  const ports: number[] = [];
  let unread = false;
  (raw as unknown[]).forEach((item, index) => {
    const at = [...path, index];
    let port: number | null = null;
    let protocol: unknown = "tcp";
    if (isMapping(item)) {
      checkComposeKeys(report, item, at, "port");
      protocol = own(item, "protocol") ?? "tcp";
      port = asPort(own(item, "target"));
    } else if (typeof item === "number") port = asPort(item);
    else if (typeof item === "string") {
      // "[host:][published:]container[/protocol]"
      const [mapping = "", written = "tcp", ...more] = item.split("/");
      protocol = more.length === 0 ? written : null;
      port = asPort(mapping.slice(mapping.lastIndexOf(":") + 1));
    }
    const named = typeof protocol === "string" ? protocol.toLowerCase() : "";
    if (named === "tcp" && port !== null) {
      if (!ports.includes(port)) ports.push(port);
    } else if (named === "udp" || named === "sctp") {
      report.dropped("PORTS_ITEM_UNREAD", at, "This 'ports' entry is not TCP: nothing of it is kept, not even under 'expose'.");
    } else {
      unread = true;
      report.dropped(
        "PORTS_ITEM_UNREAD",
        at,
        "The importer reads one TCP port per 'ports' entry, and this one is a range, a variable or a form it does not know: nothing of it is kept, not even under 'expose'.",
      );
    }
  });
  const kept = ports.length > 0 ? ` The container side (${ports.join(", ")}) is kept under 'expose'.` : "";
  report.dropped("PORTS_DROPPED", path, `Published ports are dropped: a stack is reached through its ingress entries only.${kept}`);
  return { ports, unread };
}

export function readExpose(report: ImportReport, raw: unknown, path: TemplatePath): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    report.refused("VALUE_INVALID", path, "'expose' is a list.");
    return [];
  }
  const ports: number[] = [];
  raw.forEach((item: unknown, index) => {
    const port = asPort(typeof item === "string" ? item.replace(/\/tcp$/, "") : item);
    if (port === null) report.dropped("EXPOSE_DROPPED", [...path, index], "This 'expose' entry is not one TCP port: it is dropped.");
    else if (!ports.includes(port)) ports.push(port);
  });
  return ports;
}

/** The services to start first. The conditions of the map form are dropped. */
export function convertDependsOn(report: ImportReport, raw: unknown, path: TemplatePath, self: string, services: readonly string[]): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw);
  if (!list && !isMapping(raw)) {
    report.refused("VALUE_INVALID", path, "'depends_on' is a list or a mapping of service names.");
    return [];
  }
  const names: readonly unknown[] = list ? raw : Object.keys(raw);
  if (!list) {
    let conditions = false;
    for (const [name, condition] of Object.entries(raw)) {
      const at = [...path, name];
      if (condition === null) continue;
      if (!isMapping(condition)) {
        report.refused("DEPENDS_ON_INVALID", at, "A 'depends_on' entry is empty, or a mapping with 'condition', 'restart' and 'required'.");
        continue;
      }
      checkComposeKeys(report, condition, at, "dependency");
      conditions ||= Object.keys(condition).length > 0;
      if (own(condition, "required") === false) {
        report.changed("DEPENDS_ON_OPTIONAL_KEPT", at, "'required: false' is not kept: in the draft the service always starts after this one, and does not start without it.");
      }
    }
    if (conditions) {
      report.dropped("DEPENDS_ON_CONDITION_DROPPED", path, "The conditions of 'depends_on' are dropped: the draft keeps which services come first, nothing else.");
    }
  }
  const dependsOn: string[] = [];
  names.forEach((name, index) => {
    const at = list ? [...path, index] : [...path, String(name)];
    if (typeof name !== "string" || !services.includes(name)) report.refused("DEPENDS_ON_INVALID", at, "'depends_on' names a service this file does not have.");
    else if (name === self) report.refused("DEPENDS_ON_INVALID", at, "A service cannot depend on itself.");
    else if (!dependsOn.includes(name)) dependsOn.push(name);
  });
  if (dependsOn.length > LIMITS.dependsOn) report.refused("DEPENDS_ON_INVALID", path, `A service depends on at most ${LIMITS.dependsOn} others.`);
  return dependsOn;
}

/** What makes a one-line command more than words separated by spaces: a quote, an escape, or anything a shell would act on. */
const SHELL_CHARACTER = /['"\\`|&;<>()*?[\]~#!]|[^\S ]/;

/** The items of a command as Compose would run them, or null when the file gives none the importer can split. */
function commandItems(raw: unknown): readonly unknown[] | null {
  if (typeof raw === "string") return SHELL_CHARACTER.test(raw) ? null : raw.split(" ").filter((item) => item !== "");
  return Array.isArray(raw) ? raw : null;
}

/** True when the item is an option that takes a secret as the next item: `--requirepass`, `--password`. */
function takesSecret(item: unknown): boolean {
  const option = typeof item === "string" ? commandOption(item) : null;
  return option !== null && option.inline === null && looksSecretName(option.name);
}

/** Tells the census which ordinary variables the command uses, and which of them follow an option that takes a secret. */
export function recordCommandVariables(census: VariableCensus, raw: unknown): void {
  let afterSecretOption = false;
  for (const item of commandItems(raw) ?? []) {
    const scan = typeof item === "string" ? scanComposeValue(item) : null;
    for (const piece of scan?.ok === true ? scan.pieces : []) {
      if ("variable" in piece) census.record(piece.variable, piece.fallback, afterSecretOption);
    }
    afterSecretOption = takesSecret(item);
  }
}

/**
 * True when a literal item of a command carries a secret: the value of an option that takes one, the password of an
 * address, a text shaped like a token, or a secret the file writes in its environment too. `option` is the item
 * before, when that is an option that takes a secret.
 */
function carriesSecret(registry: ParameterRegistry, literal: string, option: string | null): boolean {
  const set = commandOption(literal);
  if (option !== null && set === null && !isPlainSetting(option, literal)) return true;
  if (set !== null && set.inline !== null && set.inline !== "" && looksSecretName(set.name) && !isPlainSetting(set.name, set.inline)) return true;
  return holdsUrlPassword(literal) || envValueProblem(literal) === "ENV_VALUE_SECRET_LIKE" || registry.holdsSecret(literal);
}

/**
 * The command as a list. A variable must be a whole item and becomes the placeholder of its parameter; a secret, a
 * shell and anything the validator refuses in a command refuse the file, because running the image's own command
 * instead would be another application.
 */
export function convertCommand(report: ImportReport, registry: ParameterRegistry, raw: unknown, path: TemplatePath): string[] | null {
  if (raw === undefined || raw === null) return null;
  const refuse = (at: TemplatePath, message: string): null => report.refused("COMMAND_REFUSED", at, message);
  if (typeof raw !== "string" && !Array.isArray(raw)) return report.refused("VALUE_INVALID", path, "'command' is a list, or one line of text.");
  const items = commandItems(raw);
  if (items === null) {
    return refuse(path, "The command is one line with a quote, an escape or a shell character: the importer cannot split it safely. Write it as a list.");
  }
  if (items.length === 0) {
    report.dropped("COMMAND_EMPTY_DROPPED", path, "The command is empty: it is dropped, and the image runs its own.");
    return null;
  }
  if (items.length > LIMITS.argvItems) return refuse(path, `A command has at most ${LIMITS.argvItems} items.`);
  const command: string[] = [];
  const keys: string[] = [];
  /** The name of the item before, when it is an option that takes a secret. */
  let secretOption: string | null = null;
  for (const [index, item] of items.entries()) {
    const at = typeof raw === "string" ? path : [...path, index];
    const text = typeof item === "number" ? String(item) : item;
    const option = secretOption;
    secretOption = takesSecret(text) && typeof text === "string" ? (commandOption(text)?.name ?? null) : null;
    const scan = typeof text === "string" ? scanComposeValue(text) : null;
    if (scan === null) return refuse(at, "Every item of a command is text.");
    if (!scan.ok) return refuse(at, "This command item uses a '$' form the importer cannot read. Write a literal dollar as '$$'.");
    let written: string;
    if (scan.pieces.some((piece) => "variable" in piece)) {
      const [only] = scan.pieces;
      if (scan.pieces.length !== 1 || only === undefined || !("variable" in only)) return refuse(at, "A variable must be a whole command item, alone: split the item.");
      if (index === 0) return refuse(at, "The program of a command (its first item) cannot be a variable.");
      if (only.fallback !== null && hidesUrlPassword(only.fallback)) return report.refused("SECRET_ADDRESS_REFUSED", at, unreadableAddress("this command item", false));
      const parameter = registry.forVariable(only.variable);
      if (parameter === null || parameter.secret) return refuse(at, "A command cannot carry a secret or the address of the service: only an environment variable can.");
      keys.push(parameter.key);
      written = `\${${parameter.key}}`;
    } else {
      const literal = scan.pieces.map((piece) => ("literal" in piece ? piece.literal : "")).join("");
      const problem = index === 0 ? appStackArgvExecutableProblem(literal) : appStackArgvItemProblem(literal);
      if (problem !== null) return refuse(at, "A shell or a launcher (sh, bash, env, busybox...) cannot be part of a command, and its first item names a program.");
      if (carriesSecret(registry, literal, option)) {
        return report.refused(
          "COMMAND_SECRET_REFUSED",
          at,
          "An item of the command is a secret, or follows an option that takes one: a template is published as it is written, so a command cannot carry a secret. Pass it in an environment variable.",
        );
      }
      if (hidesUrlPassword(literal)) return report.refused("SECRET_ADDRESS_REFUSED", at, unreadableAddress("this command item", false));
      written = literal.split("$").join("$$");
    }
    if (written === "" || written.length > LIMITS.argvItemLength || appStackTextProblem(written) !== null) {
      return refuse(at, `A command item is 1 to ${LIMITS.argvItemLength} characters without control characters, the Docker socket, metadata addresses or URL credentials.`);
    }
    command.push(written);
  }
  for (const key of keys) registry.use(key, path);
  if (typeof raw === "string") report.changed("COMMAND_SPLIT", path, "The command was one line of plain words: it is split on spaces into a list.");
  return command;
}
