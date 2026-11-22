/**
 * Compose importer (spec §7) against input written to break it: text that is not a Compose file, files at and over the
 * bounds, names that are properties of every object, arguments of the wrong type. The importer never throws, never
 * returns a draft the validator refuses, and leaves the prototypes alone.
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { type AppTemplateSpec } from "@hosting-panel/contracts";
import { validateAppTemplateSource } from "../src/app-template-validation.js";
import {
  COMPOSE_IMPORT_CODES,
  COMPOSE_IMPORT_REPORT_MAX,
  importComposeToAppTemplate,
  listComposeImages,
  type ComposeImportInput,
  type ComposeImportResult,
} from "../src/compose-import.js";

const IMAGE = "registry.example.invalid/acme/web:1.0";
const digest = (n: number): string => `sha256:${n.toString(16).padStart(2, "0").repeat(32)}`;

const file = (...lines: string[]): string => `${lines.join("\n")}\n`;
/** The lines of a service called `name`, made of the image and the given lines. */
const serviceLines = (name: string, ...lines: string[]): string[] => [`  ${name}:`, `    image: ${IMAGE}`, ...lines.map((line) => `    ${line}`)];
/** A file with one service, `web`. */
const web = (...lines: string[]): string => file("services:", ...serviceLines("web", ...lines));

/** Imports a file with a digest resolved for every image it lists: the n-th listed image gets `digest(n)`. */
const run = (compose: string): ComposeImportResult =>
  importComposeToAppTemplate({ compose, digests: new Map(listComposeImages(compose).map((image, index) => [image, digest(index + 1)])) });

/** A call the types forbid: what a caller without TypeScript, or with a bug, can still send. */
const callWith = (input: unknown): ComposeImportResult => importComposeToAppTemplate(input as ComposeImportInput);

const notes = (result: ComposeImportResult): string[] => result.report.map((note) => `${note.level} ${note.code} ${note.path}`);
const refusals = (result: ComposeImportResult): string[] => notes(result).filter((note) => note.startsWith("refused "));
const messageOf = (result: ComposeImportResult, code: string): string => result.report.find((note) => note.code === code)?.message ?? "";

/** The draft as the validator reads it; fails the test when the importer refused the file or the draft is not valid. */
function specOf(result: ComposeImportResult): AppTemplateSpec {
  if (!result.ok) throw new Error(`refused: ${notes(result).join("; ")}`);
  const checked = validateAppTemplateSource(result.source);
  if (!checked.ok) throw new Error(`draft not valid: ${checked.errors.map((issue) => `${issue.code} ${issue.path}`).join("; ")}`);
  return checked.spec;
}

/** What holds for every answer of the importer, whatever the input. */
function expectWellFormed(result: ComposeImportResult): void {
  const codes: readonly string[] = COMPOSE_IMPORT_CODES;
  expect(result.report.length).toBeLessThanOrEqual(COMPOSE_IMPORT_REPORT_MAX);
  for (const note of result.report) {
    expect(codes).toContain(note.code);
    expect(["info", "changed", "dropped", "refused"]).toContain(note.level);
    expect(typeof note.path).toBe("string");
    expect(note.path.length).toBeLessThanOrEqual(512);
    // Fixed English text and names the importer has checked: never a piece of the file as it came.
    expect(note.message).toMatch(/^[\x20-\x7e]+$/);
  }
  if (result.ok) {
    expect(refusals(result)).toEqual([]);
    expect(validateAppTemplateSource(result.source).ok).toBe(true);
  } else {
    expect("source" in result).toBe(false);
    expect(refusals(result).length).toBeGreaterThan(0);
  }
}

const expectRefused = (result: ComposeImportResult, ...expected: string[]): void => {
  expectWellFormed(result);
  expect(result.ok).toBe(false);
  expect(refusals(result)).toEqual(expected);
};

const char = (code: number): string => String.fromCharCode(code);
const PROTOTYPE_BEFORE = Object.getOwnPropertyNames(Object.prototype).sort();

afterAll(() => {
  expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(PROTOTYPE_BEFORE);
  expect(Object.keys(Object.prototype)).toEqual([]);
  expect(Object.keys(Array.prototype)).toEqual([]);
});

describe("text that is not a Compose file", () => {
  it.each([
    ["an empty string", ""],
    ["blank lines", "  \n\n"],
    ["only comments", "# name: Nothing\n# nothing else\n"],
    ["plain text", "this is not a compose file"],
    ["a number", "42"],
    ["a top-level list", "- services\n- volumes\n"],
  ])("refuses %s", (_title, compose) => {
    expect(listComposeImages(compose)).toEqual([]);
    expectRefused(run(compose), "refused DOCUMENT_INVALID ");
  });

  it.each([
    ["binary garbage", `${char(0)}${char(1)}${char(2)}PK${char(3)}${char(4)}`, "CONTROL_CHARACTER"],
    ["an unclosed flow collection", "services: {web: [", "FLOW_SYNTAX"],
    ["an anchor and an alias", file("services:", "  web: &base", `    image: ${IMAGE}`, "  worker: *base"), "ANCHOR"],
    ["a block scalar", web("command: |", "  serve", "  --port 80"), "BLOCK_SCALAR"],
    ["a tab as indentation", `services:\n${char(9)}web:\n${char(9)}${char(9)}image: ${IMAGE}\n`, "TAB_INDENT"],
    ["a raw control character in a value", web("environment:", `  A: "bell${char(7)}"`), "CONTROL_CHARACTER"],
    ["an unpaired surrogate", web("environment:", `  A: "half${char(0xd800)}"`), "CONTROL_CHARACTER"],
    ["a service called __proto__", file("services:", ...serviceLines("__proto__")), "FORBIDDEN_KEY"],
    ["a variable called __proto__", web("environment:", "  __proto__: polluted"), "FORBIDDEN_KEY"],
    ["__proto__ in flow style", `{"services": {"web": {"image": "${IMAGE}", "labels": {"__proto__": {"polluted": true}}}}}`, "FORBIDDEN_KEY"],
  ])("refuses %s with the position the reader gives", (_title, compose, readerCode) => {
    expect(listComposeImages(compose)).toEqual([]);
    const result = run(compose);
    expectRefused(result, "refused YAML_UNREADABLE ");
    expect(messageOf(result, "YAML_UNREADABLE")).toMatch(new RegExp(`^The file is not YAML the importer can read \\(${readerCode} at line \\d+, column \\d+\\)\\.`));
  });

  it.each([
    ["a list", "services:\n  - web\n"],
    ["text", "services: web\n"],
    ["empty", "services: {}\n"],
    ["nothing", "services:\n"],
    ["missing", "volumes:\n  data:\n"],
  ])("refuses 'services' that is %s", (_title, compose) => {
    expect(listComposeImages(compose)).toEqual([]);
    expectRefused(run(compose), "refused DOCUMENT_INVALID services");
  });

  it.each([
    ["text", "services:\n  web: wordpress\n"],
    ["a list", "services:\n  web:\n    - image\n"],
    ["nothing", "services:\n  web:\n"],
  ])("refuses a service that is %s", (_title, compose) => {
    expect(listComposeImages(compose)).toEqual([]);
    expectRefused(run(compose), "refused DOCUMENT_INVALID services.web");
  });

  it("reads a file with a byte order mark and Windows line ends", () => {
    const compose = `${char(0xfeff)}# name: Bom\r\nservices:\r\n  web:\r\n    image: ${IMAGE}\r\n`;
    expect(listComposeImages(compose)).toEqual([IMAGE]);
    expect(specOf(run(compose)).name).toBe("Bom");
  });

  it("reads a file written as JSON", () => {
    const compose = JSON.stringify({ services: { web: { image: IMAGE, environment: { A: "b" }, expose: [8080] } } });
    expect(listComposeImages(compose)).toEqual([IMAGE]);
    expect(specOf(run(compose)).services[0]).toMatchObject({ key: "web", environment: [{ name: "A", value: "b" }], expose: [8080] });
  });
});

describe("bounds", () => {
  const services = (count: number): string => file("services:", ...Array.from({ length: count }, (_unused, index) => serviceLines(`s${index}`)).flat());
  /** A valid file of exactly `bytes` bytes: the padding is a comment. */
  const sized = (bytes: number, filler = "x"): string => {
    const head = web();
    return `${head}# ${filler.repeat(Math.floor((bytes - Buffer.byteLength(head) - 3) / Buffer.byteLength(filler)))}\n`;
  };

  it("accepts eight services and refuses nine, without reading them", () => {
    expect(specOf(run(services(8))).services).toHaveLength(8);
    expect(listComposeImages(services(9))).toEqual([]);
    expectRefused(run(services(9)), "refused SERVICES_TOO_MANY services");
  });

  it("accepts a file of exactly 65 536 bytes and refuses one byte more", () => {
    const largest = sized(65536);
    expect(Buffer.byteLength(largest)).toBe(65536);
    expect(run(largest).ok).toBe(true);
    const over = `${largest} `;
    expect(listComposeImages(over)).toEqual([]);
    expectRefused(run(over), "refused INPUT_TOO_LARGE ");
  });

  it("counts bytes, not characters", () => {
    const accented = sized(70000, char(0xe8));
    expect(accented.length).toBeLessThan(65536);
    expect(Buffer.byteLength(accented)).toBeGreaterThan(65536);
    expectRefused(run(accented), "refused INPUT_TOO_LARGE ");
  });

  it("refuses a megabyte of text at once", () => {
    const huge = `${web()}${"# padding\n".repeat(105000)}`;
    expect(huge.length).toBeGreaterThan(1024 * 1024);
    expect(listComposeImages(huge)).toEqual([]);
    expectRefused(run(huge), "refused INPUT_TOO_LARGE ");
    expectRefused(run("{".repeat(1024 * 1024)), "refused INPUT_TOO_LARGE ");
  });

  it("refuses deep nesting within the size bound without a stack overflow", () => {
    for (const compose of ["[".repeat(30000), "{a: ".repeat(15000), `services:\n  web:\n    image: ${"[".repeat(20000)}`]) {
      const result = run(compose);
      expectWellFormed(result);
      expect(result.ok).toBe(false);
      expect(listComposeImages(compose)).toEqual([]);
    }
  });

  it("cuts a long report to 200 notes and says how many are missing", () => {
    const result = run(web("environment:", ...Array.from({ length: 300 }, (_unused, index) => `  bad${index}: x`)));
    expectWellFormed(result);
    expect(result.ok).toBe(true);
    expect(result.report).toHaveLength(COMPOSE_IMPORT_REPORT_MAX);
    expect(result.report.at(-1)).toEqual({ level: "info", path: "", code: "REPORT_TRUNCATED", message: "The report is cut to 200 notes: 103 more are not shown." });
  });

  it("keeps the refusals when it cuts a report: they decide the outcome", () => {
    const compose = web("environment:", ...Array.from({ length: 300 }, (_unused, index) => `  bad${index}: x`));
    const result = importComposeToAppTemplate({ compose, digests: new Map() });
    expect(result.report).toHaveLength(COMPOSE_IMPORT_REPORT_MAX);
    expectRefused(result, "refused IMAGE_UNRESOLVED services.web.image");
  });

  it("shows a key of the file in a path only when it is short and plain, and leaves the longest ones to the reader", () => {
    const named = (name: string): ComposeImportResult => run(file("services:", ...serviceLines("web"), ...serviceLines(name)));
    expectRefused(named("k".repeat(64)), `refused SERVICE_NAME_INVALID services.${"k".repeat(64)}`);
    // A longer key, or one with other characters, could carry a piece of the file into the report: its place is marked, not shown.
    expectRefused(named("k".repeat(65)), 'refused SERVICE_NAME_INVALID services["?"]');
    expectRefused(named("k".repeat(128)), 'refused SERVICE_NAME_INVALID services["?"]');
    expectRefused(named("pass=hunter2XQ"), 'refused SERVICE_NAME_INVALID services["?"]');
    const unknownKey = run(web("hunter2XQ@db: 1"));
    expectRefused(unknownKey, 'refused KEY_UNKNOWN services.web["?"]');
    expect(JSON.stringify(unknownKey)).not.toContain("hunter2XQ");
    const longer = named("k".repeat(129));
    expectRefused(longer, "refused YAML_UNREADABLE ");
    expect(messageOf(longer, "YAML_UNREADABLE")).toContain("(KEY_TOO_LONG at line 4, column 3)");
  });

  it("refuses more values than the reader counts, and nesting deeper than it follows", () => {
    const crowded = web("environment:", ...Array.from({ length: 4200 }, () => "  - x"));
    expect(Buffer.byteLength(crowded)).toBeLessThan(65536);
    const tooMany = run(crowded);
    expectRefused(tooMany, "refused YAML_UNREADABLE ");
    expect(messageOf(tooMany, "YAML_UNREADABLE")).toContain("(TOO_MANY_NODES at line ");
    const tooDeep = run(web(`labels: ${"{a: ".repeat(20)}x${"}".repeat(20)}`));
    expectRefused(tooDeep, "refused YAML_UNREADABLE ");
    expect(messageOf(tooDeep, "YAML_UNREADABLE")).toContain("(TOO_DEEP at line ");
  });

  it.each(["Web", "my_db", "a.b", "-web", "9web", "a".repeat(28)])("refuses the service name '%s' rather than rename it", (name) => {
    const result = run(file("services:", ...serviceLines(name)));
    expectWellFormed(result);
    expect(refusals(result).map((note) => note.split(" ")[1])).toEqual(["SERVICE_NAME_INVALID"]);
    expect(result.report[0]?.path.startsWith("services")).toBe(true);
  });

  it("accepts a service name of 27 characters", () => {
    expect(specOf(run(file("services:", ...serviceLines("a".repeat(27))))).services[0]?.key).toBe("a".repeat(27));
  });
});

describe("names that every object has", () => {
  it("drops such a name as an environment variable", () => {
    const result = run(web("environment:", "  - __proto__=x", "  - constructor=y", "  - toString", "  - hasOwnProperty=z", "  - KEPT=1"));
    expect(specOf(result).services[0]?.environment).toEqual([{ name: "KEPT", value: "1" }]);
    expect(notes(result).filter((note) => note.includes(".environment"))).toEqual([
      "dropped ENV_NAME_INVALID services.web.environment[0]",
      "dropped ENV_NAME_INVALID services.web.environment[1]",
      "dropped ENV_NAME_INVALID services.web.environment[2]",
      "dropped ENV_NAME_INVALID services.web.environment[3]",
    ]);
    const mapForm = run(web("environment:", "  constructor: x", "  toString: y", "  valueOf: z"));
    expect(specOf(mapForm).services[0]?.environment).toEqual([]);
  });

  it("imports services and volumes with such names like any other", () => {
    const compose = file(
      "services:",
      ...serviceLines("constructor", "volumes:", "  - constructor:/srv/a", "  - valueof:/srv/b", "depends_on:", "  - prototype"),
      ...serviceLines("prototype"),
      ...serviceLines("tostring"),
      ...serviceLines("hasownproperty"),
      "volumes:",
      "  constructor:",
    );
    const spec = specOf(run(compose));
    expect(spec.services.map((service) => service.key)).toEqual(["constructor", "hasownproperty", "prototype", "tostring"]);
    expect(spec.volumes).toEqual([{ key: "constructor" }, { key: "valueof" }]);
    expect(spec.services[0]?.dependsOn).toEqual(["prototype"]);
  });

  it("refuses such a name as a key: it is on no list", () => {
    expectRefused(run(`${web()}constructor: x\n`), "refused KEY_UNKNOWN constructor");
    expectRefused(run(web("toString: x", "hasOwnProperty: y")), "refused KEY_UNKNOWN services.web.toString", "refused KEY_UNKNOWN services.web.hasOwnProperty");
    expectRefused(run(web("deploy:", "  constructor: x")), "refused KEY_UNKNOWN services.web.deploy.constructor");
    expectRefused(run(web("healthcheck:", "  valueOf: x")), "refused KEY_UNKNOWN services.web.healthcheck.valueOf");
  });

  it("does not take such a name for a service of the file", () => {
    expectRefused(run(web("depends_on:", "  - constructor", "  - toString")), "refused DEPENDS_ON_INVALID services.web.depends_on[0]", "refused DEPENDS_ON_INVALID services.web.depends_on[1]");
    expectRefused(run(web("depends_on:", "  constructor: {}")), "refused DEPENDS_ON_INVALID services.web.depends_on.constructor");
  });

  it("does not take such a name for a resolved image or a known variable", () => {
    expectRefused(importComposeToAppTemplate({ compose: file("services:", "  web:", "    image: constructor"), digests: new Map() }), "refused IMAGE_UNRESOLVED services.web.image");
    const result = run(web("environment:", "  A: ${constructor}", "  B: ${toString:-x}", "  C: ${__proto__}"));
    expect(specOf(result).parameters.map((parameter) => parameter.key)).toEqual(["constructor", "tostring", "p___proto__"]);
  });
});

describe("arguments of the wrong type", () => {
  const compose = web();

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 5],
    ["text", "services: {}"],
    ["a list", [compose]],
    ["an empty object", {}],
    ["a compose that is a number", { compose: 5, digests: new Map() }],
    ["a compose that is null", { compose: null, digests: new Map() }],
    ["a compose that is an object", { compose: { services: {} }, digests: new Map() }],
    ["a compose that is a list", { compose: [compose], digests: new Map() }],
  ])("refuses %s without throwing", (_title, input) => {
    const result = callWith(input);
    expectWellFormed(result);
    expect(result.ok).toBe(false);
  });

  it.each([
    ["missing", { compose }],
    ["null", { compose, digests: null }],
    ["a plain object", { compose, digests: { [IMAGE]: digest(1) } }],
    ["a map of numbers", { compose, digests: new Map([[IMAGE, 5]]) }],
    ["a map of objects", { compose, digests: new Map([[IMAGE, { toString: () => digest(1) }]]) }],
  ])("takes digests that are %s for no digest at all", (_title, input) => {
    expectRefused(callWith(input), "refused IMAGE_UNRESOLVED services.web.image");
  });

  it.each([
    ["a name that is a number", { name: 5 }, "x-hp-stack.name"],
    ["a name that is an object", { name: { toString: () => "x" } }, "x-hp-stack.name"],
    ["a category that is a list", { category: ["apps"] }, "x-hp-stack.category"],
  ])("refuses %s", (_title, header, path) => {
    expectRefused(callWith({ compose, ...header, digests: new Map([[IMAGE, digest(1)]]) }), `refused HEADER_INVALID ${path}`);
  });

  it("lists no image for a compose that is not text", () => {
    for (const value of [undefined, null, 5, {}, [compose]]) expect(listComposeImages(value as string)).toEqual([]);
  });

  it("ignores properties of the input it does not know, own or inherited", () => {
    const inherited: unknown = Object.create({ compose, digests: new Map([[IMAGE, digest(1)]]) });
    expect(callWith(inherited).ok).toBe(false);
    expect(callWith({ compose, digests: new Map([[IMAGE, digest(1)]]), extra: "x", __proto__: { name: "Inherited" } }).ok).toBe(true);
  });
});

describe("files written to take long", () => {
  /** Generous on purpose: the work is linear in the size of the file, and a quadratic step would take minutes here. */
  const BOUND_MS = 5_000;
  const timed = (compose: string): { result: ComposeImportResult; ms: number } => {
    expect(Buffer.byteLength(compose)).toBeLessThanOrEqual(65_536);
    const start = performance.now();
    const result = run(compose);
    return { result, ms: performance.now() - start };
  };

  it("reads a header comment of 60 000 spaces in the time it reads any other", () => {
    const { result, ms } = timed(`#${" ".repeat(60_000)}\n${web()}`);
    expectWellFormed(result);
    expect(result.ok).toBe(true);
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("stops counting the secrets of a file that writes more of them than a template could ever hold", () => {
    const lines = Array.from({ length: 1500 }, (_unused, index) => `  S${index}_PASSWORD: pw-${index}-Xq9`);
    const { result, ms } = timed(web("environment:", ...lines));
    expectWellFormed(result);
    expect(refusals(result)).toContain("refused SECRETS_TOO_MANY ");
    expect(messageOf(result, "SECRETS_TOO_MANY")).toBe("The file writes more than 64 different secrets in the clear; a template has at most 8 secret parameters.");
    expect(JSON.stringify(result)).not.toContain("Xq9");
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("takes the password out of hundreds of addresses without reading the file once per address", () => {
    const lines = Array.from({ length: 60 }, (_unused, index) => `  U${index}_URL: ${Array.from({ length: 15 }, (_other, at) => `amqp://u:pw${index}x${at}Zq@h${at}`).join(",")}`);
    const { result, ms } = timed(web("environment:", ...lines));
    expectWellFormed(result);
    expect(refusals(result)).toContain("refused SECRETS_TOO_MANY ");
    expect(JSON.stringify(result)).not.toContain("Zq@");
    expect(ms).toBeLessThan(BOUND_MS);
  });

  it("answers a file of the largest size made of one value", () => {
    const { result, ms } = timed(web("environment:", `  BIG: ${"a$".repeat(32_000)}`));
    expectWellFormed(result);
    expect(ms).toBeLessThan(BOUND_MS);
  });
});

describe("damaged files", () => {
  /** A fixed sequence: a failure is the same at every run. */
  const sequence = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state >>> 8;
    };
  };
  const SNIPPETS = [":", "- ", "  ", "\n", "$", "${", "}", '"', "'", "#", "[", "]", "{", "&a ", "*a", "|", "!!str ", "privileged: true", "__proto__: x", char(9), char(0), "=", "/", "..", "@sha256:"];

  it.each(["wordpress-mariadb", "literal-secrets", "tracker-postgres-redis"])("never throws and never returns a draft that is not valid (%s, 250 mutations)", (name) => {
    const original = readFileSync(new URL(`./fixtures/compose-import/${name}.yml`, import.meta.url), "utf8");
    const next = sequence(original.length);
    let imported = 0;
    for (let round = 0; round < 250; round++) {
      let compose = original;
      for (let edits = 1 + (next() % 3); edits > 0; edits--) {
        const at = next() % (compose.length + 1);
        const snippet = SNIPPETS[next() % SNIPPETS.length] ?? "";
        const removed = next() % 3 === 0 ? next() % 12 : 0;
        compose = `${compose.slice(0, at)}${next() % 4 === 0 ? "" : snippet}${compose.slice(at + removed)}`;
      }
      const result = run(compose);
      expectWellFormed(result);
      if (result.ok) imported += 1;
    }
    // Some damage is harmless: both outcomes are exercised.
    expect(imported).toBeGreaterThan(0);
    expect(imported).toBeLessThan(250);
  });
});
