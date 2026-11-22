/**
 * QA M1: mutation-style robustness of AppTemplateSpecSchema, resolveAppTemplateParameters and ApprovedStackPlanSchema.
 * Everything random comes from the seeded generator below, so a failure reproduces with the same SEED.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_STACK_PLAN_MAX_BYTES,
  APP_TEMPLATE_LIMITS,
} from "../src/app-templates/limits.js";
import {
  type AppTemplateParameterEntry,
  appTemplateValueProblem,
  resolveAppTemplateParameters,
} from "../src/app-templates/parameters.js";
import { ApprovedStackPlanSchema } from "../src/app-templates/plan.js";
import { type AppTemplateParameter, type AppTemplateSpec, AppTemplateSpecSchema } from "../src/app-templates/spec.js";

const SEED = 0x5eed_2026;
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8"));
const SPEC_JSON = fixture("spec.json");
const PLAN_JSON = fixture("plan.json");

/** mulberry32: tiny, fixed-seed, dependency free. */
function seeded(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  return { next, int, pick };
}

type Json = unknown;
type Path = (string | number)[];
type Obj = Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

function pathsOf(value: Json, prefix: Path = []): Path[] {
  const found: Path[] = [prefix];
  if (Array.isArray(value)) value.forEach((child, index) => found.push(...pathsOf(child, [...prefix, index])));
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) found.push(...pathsOf(child, [...prefix, key]));
  }
  return found;
}
const getAt = (root: Json, path: Path): Json => path.reduce<Json>((node, key) => (node as Obj)[key as string], root);
function setAt(root: Json, path: Path, value: Json): Json {
  if (path.length === 0) return value;
  const copy = clone(root);
  const parent = getAt(copy, path.slice(0, -1)) as Obj;
  parent[path[path.length - 1] as string] = value;
  return copy;
}
const shapeOf = (path: Path): string => path.map((key) => (typeof key === "number" ? "*" : key)).join(".");
function shapesOf(value: Json): Set<string> {
  return new Set(pathsOf(value).map(shapeOf));
}

const FIXTURE_SPEC_SHAPES = shapesOf(SPEC_JSON);
const FIXTURE_PLAN_SHAPES = shapesOf(PLAN_JSON);

describe("seeded generator", () => {
  it("is deterministic for a fixed seed", () => {
    const a = seeded(SEED);
    const b = seeded(SEED);
    expect(Array.from({ length: 8 }, () => a.next())).toEqual(Array.from({ length: 8 }, () => b.next()));
    expect(seeded(SEED + 1).next()).not.toBe(seeded(SEED).next());
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 1. Replace every value of the fixtures in turn.
// ---------------------------------------------------------------------------------------------------------------------

const protoObject = (): Json => JSON.parse('{"__proto__":{"polluted":"yes"},"key":"x"}');

interface Subject {
  readonly label: string;
  readonly json: Json;
  readonly parse: (input: unknown) => { success: boolean; data?: unknown };
  readonly shapes: Set<string>;
  /** Shapes where null is a declared value. */
  readonly nullable: ReadonlySet<string>;
}
const SUBJECTS: Subject[] = [
  {
    label: "AppTemplateSpecSchema (spec.json)",
    json: SPEC_JSON,
    parse: (input) => AppTemplateSpecSchema.safeParse(input),
    shapes: FIXTURE_SPEC_SHAPES,
    nullable: new Set(["services.*.command", "services.*.healthcheck", "services.*.image.tag"]),
  },
  {
    label: "ApprovedStackPlanSchema (plan.json)",
    json: PLAN_JSON,
    parse: (input) => ApprovedStackPlanSchema.safeParse(input),
    shapes: FIXTURE_PLAN_SHAPES,
    nullable: new Set(["components.*.argv", "components.*.healthcheck", "components.*.runAsUser"]),
  },
];

describe.each(SUBJECTS)("$label: every value replaced in turn", (subject) => {
  const paths = pathsOf(subject.json);

  it("accepts the unmutated fixture (the baseline of every mutation)", () => {
    expect(subject.parse(clone(subject.json)).success).toBe(true);
    expect(paths.length).toBeGreaterThan(60);
  });

  it("never throws, and never succeeds with a shape the schema does not declare", () => {
    const rng = seeded(SEED);
    const problems: string[] = [];
    const mutations: [string, (path: Path) => Json][] = [
      ["null", () => null],
      ["number", () => rng.int(-2_147_483_648, 2_147_483_647)],
      ["string", () => `s${rng.int(0, 99)}`],
      ["empty array", () => []],
      ["empty object", () => ({})],
      ["100000-char string", () => String.fromCharCode(97 + rng.int(0, 25)).repeat(100_000)],
      ["__proto__ object", protoObject],
    ];
    for (const path of paths) {
      const original = getAt(subject.json, path);
      for (const [name, make] of mutations) {
        // Known defect, covered on its own below: BigInt() throws on a non-numeric memoryBytes string.
        if (path[path.length - 1] === "memoryBytes" && name.includes("string")) continue;
        const mutated = setAt(subject.json, path, make(path));
        let result: ReturnType<Subject["parse"]>;
        try {
          result = subject.parse(mutated);
        } catch (error) {
          problems.push(`${name} at ${path.join(".")} threw ${String(error).slice(0, 80)}`);
          continue;
        }
        if (!result.success) continue;
        const where = `${name} at ${path.join(".")}`;
        for (const shape of shapesOf(result.data)) {
          if (!subject.shapes.has(shape)) problems.push(`${where}: undeclared key ${shape}`);
        }
        if (JSON.stringify(result.data).includes("__proto__")) problems.push(`${where}: __proto__ survived`);
        const acceptable: Record<string, boolean> = {
          null: subject.nullable.has(shapeOf(path)),
          number: typeof original === "number",
          string: typeof original === "string" || original === null,
          "empty array": Array.isArray(original),
          "empty object": false,
          "100000-char string": false,
          "__proto__ object": false,
        };
        if (!acceptable[name]) problems.push(`${where}: accepted although the schema declares no such value there`);
      }
    }
    expect(({} as Obj).polluted).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it("a non-numeric memoryBytes string is refused, never thrown", () => {
    const path = paths.find((candidate) => candidate[candidate.length - 1] === "memoryBytes") as Path;
    for (const bad of ["abc", "s95", "x".repeat(100_000), "1e9", "-1", "0x20"]) {
      expect(() => subject.parse(setAt(subject.json, path, bad)), bad.slice(0, 8)).not.toThrow();
      expect(subject.parse(setAt(subject.json, path, bad)).success).toBe(false);
    }
  });

  it("refuses a non-integer number and non-object roots at every path", () => {
    for (const path of paths) {
      expect(subject.parse(setAt(subject.json, path, 1.5)).success, `1.5 at ${path.join(".")}`).toBe(false);
    }
    for (const root of [null, 0, "", [], "x".repeat(100_000), true, protoObject()]) {
      expect(subject.parse(root).success).toBe(false);
    }
  });

  it("does not mutate its input and does not pollute Object.prototype", () => {
    const input = clone(subject.json);
    subject.parse(input);
    subject.parse(setAt(subject.json, [], JSON.parse('{"__proto__":{"polluted":1},"__proto__2":1}')));
    expect(input).toEqual(subject.json);
    expect(({} as Obj).polluted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Numeric bounds of limits.ts at the edge and one step over.
// ---------------------------------------------------------------------------------------------------------------------

type Shape = {
  readonly label: string;
  readonly base: Json;
  readonly parse: Subject["parse"];
  readonly list: "services" | "components";
  readonly argv: "command" | "argv";
  readonly res: "limits" | "resources";
  readonly route: (port: number) => Obj;
};
const SHAPES: Shape[] = [
  {
    label: "spec",
    base: SPEC_JSON,
    parse: (input) => AppTemplateSpecSchema.safeParse(input),
    list: "services",
    argv: "command",
    res: "limits",
    route: (port) => ({ service: "app", port }),
  },
  {
    label: "plan",
    base: PLAN_JSON,
    parse: (input) => ApprovedStackPlanSchema.safeParse(input),
    list: "components",
    argv: "argv",
    res: "resources",
    route: (port) => ({ componentKey: "app", port }),
  },
];

const L = APP_TEMPLATE_LIMITS;
const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);
const pad = (index: number): string => String(index).padStart(3, "0");
const word = (length: number, char = "a"): string => char.repeat(length);

/** A fixture whose "app" entry (and the document) is changed by `change`; `cache` is the other entry. */
function edit(shape: Shape, change: (doc: Obj, app: Obj, cache: Obj) => void): Json {
  const doc = clone(shape.base) as Obj;
  const items = doc[shape.list] as Obj[];
  change(doc, items.find((item) => item.key === "app") as Obj, items.find((item) => item.key === "cache") as Obj);
  return doc;
}
const extraComponent = (shape: Shape, cache: Obj, key: string): Obj => ({
  ...clone(cache),
  key,
  expose: [],
  dependsOn: [],
  volumes: [],
  [shape.argv]: null,
  healthcheck: null,
});

interface Edge {
  readonly name: string;
  readonly both?: boolean;
  /** Document with the value at the limit (ok) or one step over (not ok). */
  readonly make: (shape: Shape, ok: boolean) => Json;
  /** Where the refusal must be located (a path prefix), when stable. */
  readonly at?: (shape: Shape) => Path;
}

const setHealth = (app: Obj, health: Obj, ports: number[] = [8080]): void => {
  app.expose = ports;
  app.healthcheck = health;
};
const tcp = (intervalSeconds: number, timeoutSeconds: number): Obj => ({ kind: "tcp", port: 8080, intervalSeconds, timeoutSeconds });
const memory = (value: bigint | string): string => String(value);

const EDGES: Edge[] = [
  { name: "services/components 8", make: (s, ok) => edit(s, (d, _a, c) => {
      const list = d[s.list] as Obj[];
      for (const i of range(ok ? 6 : 7)) list.push(extraComponent(s, c, `x${i}`));
    }) },
  { name: "argvItems 64", make: (s, ok) => edit(s, (_d, a) => { a[s.argv] = range(ok ? L.argvItems : L.argvItems + 1).map(() => "x"); }) },
  { name: "argvItemLength 1024", make: (s, ok) => edit(s, (_d, a) => { a[s.argv] = [word(ok ? L.argvItemLength : L.argvItemLength + 1)]; }) },
  { name: "environment 64", make: (s, ok) => edit(s, (_d, a) => {
      a.environment = range(ok ? L.environment : L.environment + 1).map((i) => ({ name: `E${pad(i)}`, value: "v" }));
      if (s.label === "plan") a.secretFiles = [];
    }) },
  { name: "envValueLength 4096", make: (s, ok) => edit(s, (_d, a) => { a.environment = [{ name: "BIG", value: word(ok ? L.envValueLength : L.envValueLength + 1) }]; }) },
  { name: "mountsPerService 8", make: (s, ok) => edit(s, (_d, a) => {
      a.volumes = range(ok ? L.mountsPerService : L.mountsPerService + 1).map((i) => ({ volumeKey: "data", containerPath: `/app/d${i}`, readOnly: false }));
    }) },
  { name: "volumes 8", make: (s, ok) => edit(s, (d, a, c) => {
      const keys = ["data", ...range(ok ? 7 : 8).map((i) => `v${i + 1}`)];
      d.volumes = keys.map((key) => ({ key }));
      const mounts = keys.map((volumeKey, i) => ({ volumeKey, containerPath: `/app/m${i}`, readOnly: false }));
      a.volumes = mounts.slice(0, 8);
      c.volumes = mounts.slice(8);
    }) },
  { name: "containerPathLength 255", make: (s, ok) => edit(s, (_d, a) => {
      a.volumes = [{ volumeKey: "data", containerPath: `/${word(ok ? 254 : 255)}`, readOnly: false }];
    }) },
  { name: "expose total 16", make: (s, ok) => edit(s, (_d, a, c) => {
      a.expose = range(ok ? 8 : 9).map((i) => 8080 + i);
      c.expose = range(8).map((i) => 6379 + i);
    }) },
  { name: "expose per component 16", make: (s, ok) => edit(s, (_d, a, c) => {
      a.expose = range(ok ? 16 : 17).map((i) => 8080 + i);
      c.expose = [];
    }) },
  { name: "dependsOn 7 (8 distinct is unreachable with 8 services)", make: (s, ok) => edit(s, (d, a, c) => {
      const list = d[s.list] as Obj[];
      for (const i of range(6)) list.push(extraComponent(s, c, `x${i}`));
      // plan: a dependency must come earlier, so the dependent goes last
      if (s.label === "plan") { list.splice(list.indexOf(a), 1); list.push(a); }
      a.dependsOn = ok ? ["cache", ...range(6).map((i) => `x${i}`)] : ["cache", "cache"];
    }) },
  { name: "ingress 8", make: (s, ok) => edit(s, (d, a) => {
      const n = ok ? 8 : 9;
      a.expose = range(n).map((i) => 8080 + i);
      d.ingress = range(n).map((i) => s.route(8080 + i));
    }) },
  { name: "healthPathLength 256", make: (s, ok) => edit(s, (_d, a) => {
      setHealth(a, { kind: "http", port: 8080, path: `/${word(ok ? 255 : 256)}`, intervalSeconds: 15, timeoutSeconds: 3 });
    }) },
  { name: "healthIntervalMin 5", make: (s, ok) => edit(s, (_d, a) => setHealth(a, tcp(ok ? 5 : 4, 1))) },
  { name: "healthIntervalMax 300", make: (s, ok) => edit(s, (_d, a) => setHealth(a, tcp(ok ? 300 : 301, 3))) },
  { name: "healthTimeoutMin 1", make: (s, ok) => edit(s, (_d, a) => setHealth(a, tcp(15, ok ? 1 : 0))) },
  { name: "healthTimeoutMax 30", make: (s, ok) => edit(s, (_d, a) => setHealth(a, tcp(300, ok ? 30 : 31))) },
  { name: "timeout above interval", make: (s, ok) => edit(s, (_d, a) => setHealth(a, tcp(10, ok ? 10 : 11))) },
  { name: "cpuMilliMin 50", make: (s, ok) => edit(s, (_d, a) => { (a[s.res] as Obj).cpuMilli = ok ? 50 : 49; }) },
  { name: "cpuMilliMax 16000", make: (s, ok) => edit(s, (_d, a) => { (a[s.res] as Obj).cpuMilli = ok ? 16_000 : 16_001; }) },
  { name: "memoryBytesMin", make: (s, ok) => edit(s, (_d, a) => { (a[s.res] as Obj).memoryBytes = memory(BigInt(ok ? L.memoryBytesMin : L.memoryBytesMin - 1)); }) },
  { name: "memoryBytesMax", make: (s, ok) => edit(s, (_d, a) => { (a[s.res] as Obj).memoryBytes = memory(ok ? BigInt(L.memoryBytesMax) : BigInt(L.memoryBytesMax) + 1n); }) },
  { name: "port 1", make: (s, ok) => edit(s, (_d, a) => { a.expose = ok ? [1, 8080] : [0, 8080]; a.healthcheck = tcp(15, 3); }) },
  { name: "port 65535", make: (s, ok) => edit(s, (_d, a) => { a.expose = [8080, ok ? 65_535 : 65_536]; a.healthcheck = tcp(15, 3); }) },
];

describe.each(SHAPES)("limits of the $label at the edge and one step over", (shape) => {
  it.each(EDGES.map((edge) => [edge.name, edge] as const))("%s", (_name, edge) => {
    const ok = shape.parse(edge.make(shape, true));
    expect(ok.success, JSON.stringify((ok as { error?: { issues: unknown } }).error?.issues)).toBe(true);
    expect(shape.parse(edge.make(shape, false)).success).toBe(false);
  });
});

/** Spec-only fields. */
const base = (): Obj => clone(SPEC_JSON) as Obj;
const withParameters = (parameters: Obj[]): Json => {
  const doc = base();
  (doc.parameters as Obj[]).push(...parameters);
  return doc;
};
const integer = (key: string, extra: Obj = {}): Obj => ({ key, label: "L", type: "integer", default: 1, customer: true, ...extra });
const secretParam = (key: string): Obj => ({ key, label: "L", type: "secret", required: false, customer: true });
const specOk = (doc: Json): boolean => AppTemplateSpecSchema.safeParse(doc).success;

const SPEC_EDGES: [string, (ok: boolean) => Json][] = [
  ["stackName 80", (ok) => ({ ...base(), name: word(ok ? L.stackName : L.stackName + 1) })],
  ["stackDescription 500", (ok) => ({ ...base(), description: word(ok ? L.stackDescription : L.stackDescription + 1) })],
  ["parameters 32", (ok) => withParameters(range(ok ? 30 : 31).map((i) => integer(`p${i}`)))],
  ["secretParameters 8", (ok) => withParameters(range(ok ? 7 : 8).map((i) => secretParam(`s${i}`)))],
  ["parameterLabel 80", (ok) => withParameters([integer("p", { label: word(ok ? L.parameterLabel : L.parameterLabel + 1) })])],
  ["options 32", (ok) => withParameters([{ key: "e", label: "L", type: "enum", options: range(ok ? L.options : L.options + 1).map((i) => `o${i}`), default: "o0", customer: true }])],
  ["optionLength 64", (ok) => withParameters([{ key: "e", label: "L", type: "enum", options: [word(ok ? L.optionLength : L.optionLength + 1)], default: word(L.optionLength), customer: true }])],
  ["stringValue 256 (default)", (ok) => withParameters([{ key: "t", label: "L", type: "string", default: word(ok ? L.stringValue : L.stringValue + 1), customer: true }])],
  ["integerBound default +1e9", (ok) => withParameters([integer("i", { default: ok ? L.integerBound : L.integerBound + 1 })])],
  ["integerBound default -1e9", (ok) => withParameters([integer("i", { default: ok ? -L.integerBound : -L.integerBound - 1 })])],
  ["integerBound min -1e9", (ok) => withParameters([integer("i", { min: ok ? -L.integerBound : -L.integerBound - 1, default: 0 })])],
  ["integerBound max +1e9", (ok) => withParameters([integer("i", { max: ok ? L.integerBound : L.integerBound + 1, default: 0 })])],
  ["integer min = max", (ok) => withParameters([integer("i", { min: 5, max: ok ? 5 : 4, default: 5 })])],
  ["integer default at max", (ok) => withParameters([integer("i", { min: 0, max: 5, default: ok ? 5 : 6 })])],
  ["imageReferenceLength 255", (ok) => {
    const doc = base();
    ((doc.services as Obj[])[0]!.image as Obj).name = word(ok ? L.imageReferenceLength : L.imageReferenceLength + 1);
    return doc;
  }],
];

describe("limits of the spec only", () => {
  it.each(SPEC_EDGES)("%s", (_name, make) => {
    expect(specOk(make(true)), "at the limit").toBe(true);
    expect(specOk(make(false)), "one step over").toBe(false);
  });

  it("secret parameters count by distinct key: 8 pass, the ninth is refused with a path on parameters", () => {
    const result = AppTemplateSpecSchema.safeParse(withParameters(range(8).map((i) => secretParam(`s${i}`))));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === "parameters")).toBe(true);
  });
});

describe("limits of the plan only", () => {
  const planOk = (doc: Json): boolean => ApprovedStackPlanSchema.safeParse(doc).success;
  const app = (doc: Json): Obj => ((doc as Obj).components as Obj[]).find((c) => c.key === "app") as Obj;
  const PLAN_EDGES: [string, (ok: boolean) => Json][] = [
    ["secretVersionMax", (ok) => { const d = clone(PLAN_JSON); ((app(d).secretFiles as Obj[])[0] as Obj).version = ok ? 2_147_483_647 : 2_147_483_648; return d; }],
    ["secretVersion min 1", (ok) => { const d = clone(PLAN_JSON); ((app(d).secretFiles as Obj[])[0] as Obj).version = ok ? 1 : 0; return d; }],
    ["secret parameters 8", (ok) => {
      const d = clone(PLAN_JSON);
      app(d).secretFiles = range(ok ? 8 : 9).map((i) => ({ envName: `S${i}_FILE`, parameterKey: `k${i}`, version: 1 }));
      return d;
    }],
    ["environment + secretFiles 64", (ok) => {
      const d = clone(PLAN_JSON);
      app(d).environment = range(ok ? 63 : 64).map((i) => ({ name: `E${pad(i)}`, value: "v" }));
      return d;
    }],
    ["image reference 255", (ok) => {
      const d = clone(PLAN_JSON);
      app(d).image = `${word(ok ? 255 : 256)}@sha256:${word(64, "a")}`;
      return d;
    }],
    ["planHash 64 hex", (ok) => ({ ...(clone(PLAN_JSON) as Obj), planHash: word(ok ? 64 : 65, "a") })],
    ["id 64 chars", (ok) => ({ ...(clone(PLAN_JSON) as Obj), stackId: `s${word(ok ? 63 : 64)}` })],
    ["runAsUser 10 digits", (ok) => { const d = clone(PLAN_JSON); app(d).runAsUser = word(ok ? 10 : 11, "1"); return d; }],
  ];
  it.each(PLAN_EDGES)("%s", (_name, make) => {
    expect(planOk(make(true)), "at the limit").toBe(true);
    expect(planOk(make(false)), "one step over").toBe(false);
  });

  // ---- APP_STACK_PLAN_MAX_BYTES: UTF-8 bytes of the JSON, not characters ----
  const sized = (filler: string, extra: number): Json => {
    const doc = clone(PLAN_JSON) as Obj;
    const target = app(doc);
    target.secretFiles = [];
    const entries = range(63).map((i) => ({ name: `E${pad(i)}`, value: filler.repeat(L.envValueLength) }));
    target.environment = [...entries, { name: "Z", value: "" }];
    return JSON.parse(JSON.stringify(doc).replace('"name":"Z","value":""', `"name":"Z","value":"${"b".repeat(extra)}"`));
  };
  const bytesOf = (doc: Json): number => Buffer.byteLength(JSON.stringify(doc), "utf8");

  it("accepts a plan of exactly APP_STACK_PLAN_MAX_BYTES and refuses one byte more", () => {
    const empty = bytesOf(sized("a", 0));
    const need = APP_STACK_PLAN_MAX_BYTES - empty;
    expect(need).toBeGreaterThanOrEqual(0);
    expect(need).toBeLessThanOrEqual(L.envValueLength);
    const exact = sized("a", need);
    expect(bytesOf(exact)).toBe(APP_STACK_PLAN_MAX_BYTES);
    expect(planOk(exact)).toBe(true);
    const over = sized("a", need + 1);
    expect(bytesOf(over)).toBe(APP_STACK_PLAN_MAX_BYTES + 1);
    const result = ApprovedStackPlanSchema.safeParse(over);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.length === 0)).toBe(true);
  });

  it("measures bytes, not characters: a plan under the limit in characters but over in bytes is refused", () => {
    const multibyte = sized("é", 0);
    const json = JSON.stringify(multibyte);
    expect(json.length).toBeLessThan(APP_STACK_PLAN_MAX_BYTES);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(APP_STACK_PLAN_MAX_BYTES);
    const result = ApprovedStackPlanSchema.safeParse(multibyte);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.path.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Seeded random parameter entries against the resolver.
// ---------------------------------------------------------------------------------------------------------------------

const withExtra = (extra: Obj[]): AppTemplateSpec => AppTemplateSpecSchema.parse(withParameters(extra));
const RESOLVER_SPEC = withExtra([
  { key: "mode", label: "Mode", type: "enum", options: ["fast", "safe"], default: "safe", customer: true },
  { key: "title", label: "Title", type: "string", default: "Notes", customer: true },
  { key: "debug", label: "Debug", type: "boolean", default: false, customer: true },
  { key: "upload", label: "Upload", type: "size", default: "64M", customer: true },
  { key: "offset", label: "Offset", type: "integer", default: 0, customer: true },
  { key: "fixed", label: "Fixed", type: "integer", default: 7, customer: false },
  { key: "fixed_text", label: "Fixed text", type: "string", default: "x", customer: false },
]);
const DECLARED = new Map(RESOLVER_SPEC.parameters.map((parameter) => [parameter.key, parameter]));
const MARKER = "LEAKMARK";

describe("resolveAppTemplateParameters: 500 seeded random entry lists", () => {
  const rng = seeded(SEED);
  const keys = [...DECLARED.keys(), "__proto__", "constructor", "toString", "hasOwnProperty", "hp_internal", "unknown", "", "UPPER", `k${MARKER}`];
  const values = (): unknown => {
    const kind = rng.int(0, 17);
    switch (kind) {
      case 0: return rng.int(-5, 10);
      case 1: return rng.pick([1_000_000_000, 1_000_000_001, -1_000_000_000, -1_000_000_001, Number.MAX_SAFE_INTEGER, 2 ** 53, -0]);
      case 2: return rng.pick([1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e21]);
      case 3: return rng.next() < 0.5;
      case 4: return null;
      case 5: return undefined;
      case 6: return rng.pick(["fast", "safe", "other", "FAST", "fast "]);
      case 7: return rng.pick(["64M", "1G", "0", "1T", "10 M", "", "64m", "-1M"]);
      case 8: return `${MARKER}${"z".repeat(rng.int(0, 300))}`;
      case 9: return `${MARKER}\u0000\n\u2028${rng.int(0, 9)}`;
      case 10: return rng.pick([`${MARKER} /var/run/docker.sock`, `${MARKER} 169.254.169.254`, `${MARKER} http://u:p@h/`, `${MARKER} docker.sock`]);
      case 11: return [];
      case 12: return {};
      case 13: return { [MARKER]: 1 };
      case 14: return "x".repeat(100_000);
      case 15: return String(rng.int(0, 99));
      case 16: return ["fast"];
      default: return rng.int(0, 3);
    }
  };
  const lists: unknown[][] = Array.from({ length: 500 }, () =>
    Array.from({ length: rng.int(0, 10) }, () => ({ key: rng.pick(keys), value: values() })),
  );

  it("never throws, never mutates, and agrees with the per-entry rules", () => {
    const problems: string[] = [];
    lists.forEach((list, n) => {
      const frozen = structuredClone(list);
      let result: ReturnType<typeof resolveAppTemplateParameters>;
      try {
        result = resolveAppTemplateParameters(RESOLVER_SPEC, list as AppTemplateParameterEntry[]);
      } catch (error) {
        problems.push(`#${n} threw ${String(error).slice(0, 80)}`);
        return;
      }
      if (JSON.stringify(list) !== JSON.stringify(frozen)) problems.push(`#${n} mutated its input`);

      const seen = new Set<string>();
      let expectOk = true;
      for (const { key, value } of list as { key: string; value: unknown }[]) {
        const parameter = DECLARED.get(key);
        const refused = !parameter || seen.has(key) || parameter.type === "secret" || !parameter.customer || appTemplateValueProblem(parameter, value) !== null;
        if (refused) expectOk = false;
        seen.add(key);
      }
      if (result.ok !== expectOk) {
        problems.push(`#${n} ok=${String(result.ok)} expected ${String(expectOk)}`);
        return;
      }
      if (!result.ok) {
        if (result.issues.length === 0) problems.push(`#${n} refused without an issue`);
        if (result.issues.some((issue) => !issue.path.startsWith("parameters."))) problems.push(`#${n} issue outside parameters.*`);
        const text = JSON.stringify(result.issues.map(({ code, reason, message }) => ({ code, reason, message })));
        if (text.includes(MARKER)) problems.push(`#${n} an issue echoes the value given`);
        return;
      }
      // Success: only declared, non-secret keys, every one valid, customer:false untouched.
      const given = new Map((list as { key: string; value: unknown }[]).map(({ key, value }) => [key, value]));
      for (const key of given.keys()) {
        const parameter = DECLARED.get(key);
        if (!parameter || parameter.type === "secret" || !parameter.customer) problems.push(`#${n} accepted key ${key}`);
      }
      const resultKeys = Object.keys(result.values).sort();
      const expectedKeys = RESOLVER_SPEC.parameters.filter((p) => p.type !== "secret").map((p) => p.key).sort();
      if (JSON.stringify(resultKeys) !== JSON.stringify(expectedKeys)) problems.push(`#${n} value keys ${resultKeys.join(",")}`);
      for (const parameter of RESOLVER_SPEC.parameters) {
        if (parameter.type === "secret") continue;
        const value = result.values[parameter.key];
        if (appTemplateValueProblem(parameter, value) !== null) problems.push(`#${n} returned an invalid ${parameter.key}`);
        const expected = given.has(parameter.key) ? given.get(parameter.key) : parameter.default;
        if (!Object.is(value, expected) && !(value === 0 && expected === 0)) problems.push(`#${n} ${parameter.key} is not the given/default value`);
      }
      if (Object.getPrototypeOf(result.values) !== null && Object.hasOwn(result.values, "__proto__")) problems.push(`#${n} own __proto__`);
    });
    expect(({} as Obj).polluted).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it("exercises both outcomes (the generator is not degenerate)", () => {
    const outcomes = lists.map((list) => resolveAppTemplateParameters(RESOLVER_SPEC, list as AppTemplateParameterEntry[]).ok);
    expect(outcomes.filter(Boolean).length).toBeGreaterThan(20);
    expect(outcomes.filter((ok) => !ok).length).toBeGreaterThan(100);
  });

  it.each([
    ["fixed (customer:false), even equal to the default", [{ key: "fixed", value: 7 }], "PARAM_VALUE_NOT_CUSTOMER"],
    ["a secret with an inline value", [{ key: "app_secret", value: "hunter2" }], "PARAM_VALUE_SECRET"],
    ["__proto__ as a key", [{ key: "__proto__", value: 1 }], "PARAM_VALUE_UNKNOWN"],
    ["constructor as a key", [{ key: "constructor", value: "x" }], "PARAM_VALUE_UNKNOWN"],
    ["a duplicate", [{ key: "title", value: "a" }, { key: "title", value: "a" }], "PARAM_VALUE_DUPLICATE"],
    ["a 100000-char string", [{ key: "title", value: "x".repeat(100_000) }], "PARAM_VALUE_TOO_LONG"],
  ] as const)("refuses %s with %s", (_name, list, code) => {
    const result = resolveAppTemplateParameters(RESOLVER_SPEC, list as unknown as AppTemplateParameterEntry[]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain(code);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Regression guard against super-linear refinements.
// ---------------------------------------------------------------------------------------------------------------------

describe("parse cost", () => {
  it("parses spec.json and plan.json 1000 times each in under a second", () => {
    for (let i = 0; i < 100; i += 1) {
      AppTemplateSpecSchema.parse(SPEC_JSON);
      ApprovedStackPlanSchema.parse(PLAN_JSON);
    }
    const started = performance.now();
    for (let i = 0; i < 1000; i += 1) {
      AppTemplateSpecSchema.parse(SPEC_JSON);
      ApprovedStackPlanSchema.parse(PLAN_JSON);
    }
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses a maximal hostile document in bounded time", () => {
    const hostile = clone(SPEC_JSON) as Obj;
    const apps = hostile.services as Obj[];
    (apps[0] as Obj).command = range(L.argvItems).map(() => word(L.argvItemLength));
    (apps[0] as Obj).environment = range(L.environment).map((i) => ({ name: `E${pad(i)}`, value: word(L.envValueLength, "$") }));
    const started = performance.now();
    AppTemplateSpecSchema.safeParse(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

// keep the unused-type import honest for readers: parameters are typed through the spec
export type { AppTemplateParameter };
