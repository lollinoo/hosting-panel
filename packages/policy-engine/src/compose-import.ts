/**
 * Compose importer (ADR-0036, spec §7): turns a Docker Compose file into a draft HCP-STACK/v2 template and a report
 * of everything it changed, dropped or refused. The draft is a proposal for an administrator to review: it is checked
 * by the template validator before it is returned, and one refusal means no draft at all.
 * Pure, synchronous and never throws: no I/O, no clock, no randomness. A note never echoes a value of the file.
 */
import {
  APP_STACK_COMPONENT_KEY_MAX,
  APP_STACK_KEY_PATTERN,
  APP_TEMPLATE_CATEGORY_PATTERN,
  APP_TEMPLATE_LIMITS as LIMITS,
  TEMPLATE_SOURCE_MAX_BYTES,
  type TemplatePath,
} from "@hosting-panel/contracts";
import { orderAppTemplateServices } from "./app-template-graph.js";
import { validateAppTemplateSource } from "./app-template-validation.js";
import { isImageLookup, isMapping, own, readComposeDocument, type Mapping } from "./compose-import-document.js";
import {
  claimLiteralSecrets,
  convertComposeEnvironment,
  readComposeEnvironment,
  recordEnvironmentVariables,
  type ComposeEnvEntry,
} from "./compose-import-environment.js";
import { checkComposeKeys } from "./compose-import-keys.js";
import { LITERAL_SECRETS_MAX, ParameterRegistry, VariableCensus } from "./compose-import-parameters.js";
import { ImportReport, type ComposeImportNote } from "./compose-import-report.js";
import { convertHealthcheck, convertLimits, readComposeHealthcheck } from "./compose-import-runtime.js";
import {
  VolumeBook,
  convertCommand,
  convertDependsOn,
  convertImage,
  convertMounts,
  readContainerPorts,
  readExpose,
  recordCommandVariables,
} from "./compose-import-service.js";
import { emitDraft, type DraftService } from "./compose-import-yaml.js";

export { COMPOSE_IMPORT_KEY_LEVELS } from "./compose-import-keys.js";
export { COMPOSE_IMPORT_CODES, COMPOSE_IMPORT_REPORT_MAX } from "./compose-import-report.js";
export type { ComposeImportCode, ComposeImportLevel, ComposeImportNote } from "./compose-import-report.js";

export interface ComposeImportInput {
  readonly compose: string;
  /** The name and category of the draft; without them the importer reads `# name:` and `# category:` at the top of the file. */
  readonly name?: string;
  readonly category?: string;
  /** Image reference, as `listComposeImages` gives it -> the digest resolved for it ("sha256:<64 hex>"). */
  readonly digests: ReadonlyMap<string, string>;
}

export type ComposeImportResult =
  | { readonly ok: true; readonly source: string; readonly report: ComposeImportNote[] }
  | { readonly ok: false; readonly report: ComposeImportNote[] };

export const COMPOSE_IMPORT_DEFAULT_NAME = "Applicazione importata";
export const COMPOSE_IMPORT_DEFAULT_CATEGORY = "apps";

const NOT_PLAIN_TEXT = /\p{Cc}|\p{Cs}/u;

const isStackName = (text: string): boolean => text.length >= 1 && text.length <= LIMITS.stackName && !NOT_PLAIN_TEXT.test(text);

/** The services of a file that has between one and the most a stack can hold; null for any other document. */
function composeServices(root: unknown): Mapping | null {
  const services = isMapping(root) ? own(root, "services") : undefined;
  const count = isMapping(services) ? Object.keys(services).length : 0;
  return isMapping(services) && count >= 1 && count <= LIMITS.services ? services : null;
}

/**
 * The image references the API must resolve before it imports the file: distinct, in file order, without the ones
 * that already carry a digest. A file the importer refuses as a whole gives none, so nothing is looked up for it.
 */
export function listComposeImages(compose: string): string[] {
  try {
    const document = readComposeDocument(compose);
    const services = document.ok ? composeServices(document.root) : null;
    const images: string[] = [];
    for (const service of services === null ? [] : Object.values(services)) {
      const image = isMapping(service) ? own(service, "image") : undefined;
      if (typeof image === "string" && isImageLookup(image) && !images.includes(image)) images.push(image);
    }
    return images;
  } catch {
    return [];
  }
}

/**
 * `# name:` and `# category:` in the comment lines that open the file. A value that cannot be used is as good as absent.
 * Read by cutting the line at its first ':' and not by a pattern: one with two stretches of blanks around the value
 * takes a time that grows with the square of a long line.
 */
function headerComments(compose: string): { name?: string; category?: string } {
  const found: { name?: string; category?: string } = {};
  for (const line of compose.slice(compose.charCodeAt(0) === 0xfeff ? 1 : 0).split(/\r\n?|\n/)) {
    if (line.trim() === "") continue;
    if (!line.startsWith("#")) break;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(1, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "name") {
      if (found.name === undefined && isStackName(value)) found.name = value;
    } else if (key === "category" && found.category === undefined && APP_TEMPLATE_CATEGORY_PATTERN.test(value.toLowerCase())) {
      found.category = value.toLowerCase();
    }
  }
  return found;
}

/** What the caller gives wins and must be valid; an empty text counts as not given. */
function readHeader(report: ImportReport, input: Mapping, compose: string): { name: string; category: string } {
  const comments = headerComments(compose);
  const given = (key: "name" | "category"): unknown => {
    const value = own(input, key);
    return typeof value === "string" && value.trim() === "" ? undefined : (value ?? undefined);
  };
  const name = given("name");
  const category = given("category");
  if (name !== undefined && !(typeof name === "string" && isStackName(name))) {
    report.refused("HEADER_INVALID", ["x-hp-stack", "name"], `The name is 1 to ${LIMITS.stackName} characters of plain text.`);
  }
  if (category !== undefined && !(typeof category === "string" && APP_TEMPLATE_CATEGORY_PATTERN.test(category))) {
    report.refused("HEADER_INVALID", ["x-hp-stack", "category"], "The category starts with a lower-case letter and uses lower-case letters, digits and '-' (at most 32).");
  }
  return {
    name: typeof name === "string" ? name : (comments.name ?? COMPOSE_IMPORT_DEFAULT_NAME),
    category: typeof category === "string" ? category : (comments.category ?? COMPOSE_IMPORT_DEFAULT_CATEGORY),
  };
}

interface ServiceInput {
  readonly name: string;
  readonly path: TemplatePath;
  readonly raw: Mapping;
  readonly environment: readonly ComposeEnvEntry[];
}

const distinct = (ports: readonly number[]): number[] => [...new Set(ports)];

/** The source of the draft, or null after at least one refusal. */
function buildDraft(report: ImportReport, input: Mapping): string | null {
  const compose = own(input, "compose");
  const document = readComposeDocument(compose);
  if (!document.ok) {
    return document.problem === "too_large"
      ? report.refused("INPUT_TOO_LARGE", [], `The file is larger than ${TEMPLATE_SOURCE_MAX_BYTES} bytes.`)
      : report.refused(
          "YAML_UNREADABLE",
          [],
          `The file is not YAML the importer can read (${document.code} at line ${document.line}, column ${document.column}). Anchors, tags and block scalars are not supported.`,
        );
  }
  const { root } = document;
  if (!isMapping(root)) return report.refused("DOCUMENT_INVALID", [], "A Compose file is a mapping with a 'services' key.");
  const rawServices = own(root, "services");
  if (!isMapping(rawServices) || Object.keys(rawServices).length === 0) {
    return report.refused("DOCUMENT_INVALID", ["services"], "A Compose file needs a 'services' mapping with at least one service.");
  }
  const names = Object.keys(rawServices);
  // Nothing else is read from such a file: its report would be as long as the file.
  if (composeServices(root) === null) {
    return report.refused("SERVICES_TOO_MANY", ["services"], `A stack has at most ${LIMITS.services} services; this file has ${names.length}.`);
  }

  const header = readHeader(report, input, typeof compose === "string" ? compose : "");
  checkComposeKeys(report, root, [], "root");
  const book = new VolumeBook(report);
  book.declare(own(root, "volumes"), ["volumes"]);

  const services: ServiceInput[] = [];
  for (const name of names) {
    const path: TemplatePath = ["services", name];
    const raw = rawServices[name];
    if (!APP_STACK_KEY_PATTERN.test(name) || name.length > APP_STACK_COMPONENT_KEY_MAX) {
      // Not renamed: other services reach this one by its name, inside values the importer cannot rewrite.
      report.refused(
        "SERVICE_NAME_INVALID",
        path,
        `A service name uses lower-case letters, digits and '-' (at most ${APP_STACK_COMPONENT_KEY_MAX}, no '_'). Rename it in the file, also where other services name it.`,
      );
    } else if (!isMapping(raw)) report.refused("DOCUMENT_INVALID", path, "A service is a mapping.");
    else {
      checkComposeKeys(report, raw, path, "service");
      services.push({ name, path, raw, environment: readComposeEnvironment(report, own(raw, "environment"), [...path, "environment"]) });
    }
  }

  // Every use of a variable is known before the first parameter is made: one use as a secret makes it a secret everywhere.
  const census = new VariableCensus();
  for (const service of services) {
    recordEnvironmentVariables(census, service.environment);
    recordCommandVariables(census, own(service.raw, "command"));
  }
  const registry = new ParameterRegistry(report, census);
  // The secrets written in the clear are known before the first value is converted: the same text is the same secret everywhere.
  claimLiteralSecrets(
    registry,
    census,
    services.map((service) => service.environment),
  );
  const tooManySecrets = (): null =>
    report.refused(
      "SECRETS_TOO_MANY",
      [],
      `The file writes more than ${LITERAL_SECRETS_MAX} different secrets in the clear; a template has at most ${LIMITS.secretParameters} secret parameters.`,
    );
  // Past the bound the importer no longer follows the secrets it meets, and such a file gives no draft: no service is converted.
  if (registry.overflowed) return tooManySecrets();
  const given = own(input, "digests");
  const digests: ReadonlyMap<string, unknown> = given instanceof Map ? given : new Map<string, unknown>();

  const drafts: DraftService[] = [];
  const graph: { key: string; dependsOn: string[] }[] = [];
  const ingress: { service: string; port: number }[] = [];
  for (const { name, path, raw, environment: entries } of services) {
    const image = convertImage(report, own(raw, "image"), [...path, "image"], digests);
    const command = convertCommand(report, registry, own(raw, "command"), [...path, "command"]);
    const environment = convertComposeEnvironment(report, registry, entries, [...path, "environment"]);
    const mounts = convertMounts(report, book, own(raw, "volumes"), [...path, "volumes"]);
    const published = readContainerPorts(report, own(raw, "ports"), [...path, "ports"]);
    const filePorts = distinct([...readExpose(report, own(raw, "expose"), [...path, "expose"]), ...published.ports]);
    const dependsOn = convertDependsOn(report, own(raw, "depends_on"), [...path, "depends_on"], name, names);

    const routes: number[] = [];
    for (const request of environment.ingress) {
      if (request.port === null && filePorts.length === 0 && published.unread) {
        // The service does publish a port, one the importer could not read: port 80 would be a guess.
        report.refused(
          "INGRESS_PORT_UNKNOWN",
          request.path,
          "The variable asks for the public address of the service without naming a port, and no 'ports' entry of the service could be read as one TCP port: name the port in the variable (SERVICE_FQDN_<NAME>_<PORT>) or write one TCP port.",
        );
        continue;
      }
      const port = request.port ?? filePorts[0] ?? 80;
      if (routes.includes(port)) continue;
      routes.push(port);
      if (request.port === null && filePorts.length === 0) {
        report.info("INGRESS_PORT_DEFAULTED", request.path, "The variable names no port and the service exposes none: the ingress entry uses port 80.");
      }
      report.changed("INGRESS_FROM_VARIABLE", request.path, `The service is published by an ingress entry on port ${port}, as its platform URL variable asks.`);
    }
    const healthPath = [...path, "healthcheck"];
    const healthcheck = convertHealthcheck(report, readComposeHealthcheck(report, own(raw, "healthcheck"), healthPath), healthPath, {
      ingressPort: routes[0] ?? null,
      image: image ?? "",
      expose: filePorts,
    });
    const limits = convertLimits(report, raw, path);
    const expose = distinct([...filePorts, ...routes, ...(healthcheck === null ? [] : [healthcheck.port])]);
    for (const port of expose.filter((candidate) => !filePorts.includes(candidate))) {
      const user = routes.includes(port) ? "the ingress entry" : "the health check";
      report.info("EXPOSE_ADDED", [...path, "expose"], `Port ${port} is not among the ports the file gives the service: it is added to 'expose', because ${user} of the service uses it.`);
    }
    graph.push({ key: name, dependsOn });
    for (const port of routes) ingress.push({ service: name, port });
    if (image !== null) drafts.push({ key: name, image, command, environment: environment.entries, mounts, expose, dependsOn, healthcheck, limits });
  }

  const volumes = book.finish(["volumes"]);
  const exposed = drafts.reduce((total, service) => total + service.expose.length, 0);
  if (exposed > LIMITS.expose) report.refused("EXPOSE_TOO_MANY", ["services"], `A stack exposes at most ${LIMITS.expose} ports in all; this file would expose ${exposed}.`);
  const order = orderAppTemplateServices(graph);
  for (const key of order.ok ? [] : order.unordered) {
    report.refused("DEPENDS_ON_CYCLE", ["services", key, "depends_on"], "The dependencies form a cycle: no start order exists.");
  }
  if (ingress.length > LIMITS.ingress) report.refused("INGRESS_TOO_MANY", ["services"], `A stack has at most ${LIMITS.ingress} ingress entries; this file asks for ${ingress.length}.`);
  const parameters = registry.used();
  const secrets = parameters.filter((parameter) => parameter.secret).length;
  if (parameters.length > LIMITS.parameters) {
    report.refused("PARAMETERS_TOO_MANY", [], `A template has at most ${LIMITS.parameters} parameters; the variables and secrets of this file need ${parameters.length}.`);
  }
  if (registry.overflowed) {
    tooManySecrets();
  } else if (secrets > LIMITS.secretParameters) {
    report.refused("SECRETS_TOO_MANY", [], `A template has at most ${LIMITS.secretParameters} secret parameters; this file needs ${secrets}.`);
  }
  if (report.hasRefusal) return null;

  const source = emitDraft({ ...header, parameters, services: drafts, volumes, ingress });
  const checked = validateAppTemplateSource(source);
  if (checked.ok) return source;
  // The rules above should have caught it: the validator has the last word, and its paths are those of the draft.
  for (const issue of checked.errors) {
    report.add("refused", "DRAFT_INVALID", issue.path, `The draft does not pass the template check (${issue.code}) and is not returned.`);
  }
  return null;
}

export function importComposeToAppTemplate(input: ComposeImportInput): ComposeImportResult {
  const report = new ImportReport();
  try {
    const source = buildDraft(report, isMapping(input) ? input : {});
    if (source !== null && !report.hasRefusal) return { ok: true, source, report: report.list() };
  } catch {
    // Reached only through a bug: the caller still gets an answer, and nothing of the file.
  }
  if (!report.hasRefusal) report.refused("IMPORT_FAILED", [], "The importer could not read this file. This is a platform bug.");
  return { ok: false, report: report.list() };
}
