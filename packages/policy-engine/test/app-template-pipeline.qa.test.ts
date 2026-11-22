/**
 * QA M1: end-to-end properties of validate → compile → hash (HCP-SPEC-005, SPEC §19 A1, A3, A7, A8).
 * Sources come from a small seeded generator (fixed seeds, no randomness between runs).
 */
import { describe, expect, it } from "vitest";
import {
  ApprovedStackPlanSchema,
  toAppStackPreview,
  type AppImageAllowlistEntry,
  type AppTemplateIssue,
  type AppTemplateParameterEntry,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { computeAppStackPlanHash, verifyAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { compileAppStackPlan, previewAppTemplateSource, validateAppTemplateSource, type AppStackCompileInput } from "../src/index.js";

// ---------------------------------------------------------------------------------------------------------------
// Seeded generator
// ---------------------------------------------------------------------------------------------------------------

interface Rng {
  next(): number;
  int(low: number, high: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (low: number, high: number): number => low + Math.floor(next() * (high - low + 1));
  const pick = <T>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = int(0, i);
      const a = copy[i] as T;
      copy[i] = copy[j] as T;
      copy[j] = a;
    }
    return copy;
  };
  return { next, int, pick, bool: (probability = 0.5) => next() < probability, shuffle };
}

type ParamValue = string | number | boolean;
/** A piece of an argv item or an environment value: literal text (raw = how the source spells it) or a parameter. */
type Piece = { readonly lit: string; readonly raw: string } | { readonly param: string };

interface ParamModel {
  readonly key: string;
  readonly type: "enum" | "integer" | "string" | "boolean" | "size" | "secret";
  readonly customer: boolean;
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly default?: ParamValue;
  readonly required?: boolean;
}
type EnvModel = { readonly name: string; readonly pieces: readonly Piece[] } | { readonly name: string; readonly secret: string };
interface HealthModel {
  readonly kind: "tcp" | "http";
  readonly port: number;
  readonly path?: string;
  readonly interval?: number;
  readonly timeout?: number;
}
interface ServiceModel {
  readonly key: string;
  readonly repo: string;
  readonly tag: string | null;
  readonly digest: string;
  readonly command: readonly Piece[] | null;
  readonly env: readonly EnvModel[];
  readonly mounts: readonly { readonly volume: string; readonly path: string; readonly mode: "" | "ro" | "rw" }[];
  readonly expose: readonly number[];
  readonly dependsOn: readonly string[];
  readonly health: HealthModel | null;
  readonly cpuMilli: number;
  readonly memoryMiB: number;
  readonly memoryAsBytes: boolean;
}
interface Model {
  readonly name: string;
  readonly category: string;
  readonly params: readonly ParamModel[];
  readonly services: readonly ServiceModel[];
  readonly volumes: readonly string[];
  readonly ingress: readonly { readonly service: string; readonly port: number }[];
}

const REPOS = ["registry.example.invalid/gen/alpha", "registry.example.invalid/gen/beta", "registry.example.invalid/gen/gamma", "registry.example.invalid/gen/delta"];
const RUN_AS = [null, "1000", "2000:2000", "65534"] as const;
const ALLOWLIST: AppImageAllowlistEntry[] = REPOS.map((repository, i) => ({ repository, runAsUser: RUN_AS[i] ?? null, note: "qa generator" }));
const options = { allowlist: ALLOWLIST };
const IDS = {
  stackId: "stk_0123456789abcdef0123456789abcdef",
  organizationId: "org_acme",
  hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
  templateVersionId: "atv_0123456789abcdef01234567",
  revisionId: "astr_0123456789abcdef0123456789abcdef",
};

const SERVICE_KEYS = ["web", "api", "db", "cache", "queue", "worker", "proxy", "store"];
const ENV_NAMES = ["LOG_LEVEL", "APP_MODE", "REGION_NAME", "WORKERS", "FEATURE_FLAGS", "CACHE_HOST", "UPSTREAM_NAME", "THEME_NAME", "LANG_CODE", "BUILD_LABEL", "MAX_ITEMS"];
const LITERALS: Piece[] = [
  { lit: "alpha-", raw: "alpha-" },
  { lit: "-beta", raw: "-beta" },
  { lit: "x.", raw: "x." },
  { lit: "/srv/", raw: "/srv/" },
  { lit: "cost-$5", raw: "cost-$$5" },
  { lit: "cfg=", raw: "cfg=" },
];
const ARGV_LITERALS: Piece[] = [
  { lit: "--flag", raw: "--flag" },
  { lit: "--mode=fast", raw: "--mode=fast" },
  { lit: "plain", raw: "plain" },
  { lit: "cost-$5", raw: "cost-$$5" },
  { lit: "/var/data", raw: "/var/data" },
];
/** Customer values that are valid for a string parameter and awkward for a shell. */
const SAFE_STRINGS = ["hello", "a b c", "x;y", "$$", "$(id)", "`ls`", "naïve", "日本語", "'quoted'", "a|b&c", "*", "~/x", "\\", "z".repeat(256)];

const hex = (rng: Rng, length: number): string => Array.from({ length }, () => "0123456789abcdef"[rng.int(0, 15)]).join("");

function genParams(rng: Rng): ParamModel[] {
  const params: ParamModel[] = [];
  const count = rng.int(0, 9);
  for (let i = 0; i < count; i += 1) {
    const type = rng.pick(["enum", "integer", "string", "boolean", "size"] as const);
    const customer = rng.bool(0.8);
    const key = `${type}_${i}`;
    if (type === "enum") {
      const options = rng.shuffle(["o1", "o2-b", "o3", "o4-d", "o5"]).slice(0, rng.int(1, 5));
      params.push({ key, type, customer, options, default: rng.pick(options) });
    } else if (type === "integer") {
      const min = rng.bool(0.3) ? -rng.int(1, 50) : rng.int(0, 10);
      const max = min + rng.int(0, 200);
      params.push({ key, type, customer, min, max, default: rng.int(min, max) });
    } else if (type === "string") params.push({ key, type, customer, default: rng.pick(["fast", "a b", "x-y.z", "0"]) });
    else if (type === "boolean") params.push({ key, type, customer, default: rng.bool() });
    else params.push({ key, type, customer, default: rng.pick(["256M", "1G", "64K", "10240M"]) });
  }
  const secrets = rng.int(0, 3);
  for (let i = 0; i < secrets; i += 1) params.push({ key: `secret_${i}`, type: "secret", customer: true, required: rng.bool(0.5) });
  return params;
}

const argvSafe = (param: ParamModel): boolean => param.type !== "integer" || (param.min ?? 0) >= 0;

function genModel(seed: number): Model {
  const rng = makeRng(seed);
  const params = genParams(rng);
  const plain = params.filter((param) => param.type !== "secret");
  const secrets = params.filter((param) => param.type === "secret");
  const volumes = ["vol-a", "vol-b", "vol-c"].slice(0, rng.int(0, 3));
  const names = rng.shuffle(SERVICE_KEYS).slice(0, rng.int(1, 8));
  const services: ServiceModel[] = names.map((key, index) => {
    const expose = [...new Set(Array.from({ length: rng.int(0, 2) }, () => rng.int(1024, 65_000)))];
    const dependsOn = names.slice(0, index).filter(() => rng.bool(0.35)).slice(0, 3);
    const used = rng.shuffle(plain);
    const envNames = rng.shuffle(ENV_NAMES).slice(0, rng.int(0, 6));
    const env: EnvModel[] = envNames.map((name) => {
      const pieces: Piece[] = [];
      for (let p = rng.int(1, 3); p > 0; p -= 1) {
        const param = used.length > 0 && rng.bool(0.6) ? rng.pick(used) : null;
        pieces.push(param === null ? rng.pick(LITERALS) : { param: param.key });
      }
      return { name, pieces };
    });
    secrets.forEach((secret, i) => {
      if (rng.bool(0.6)) env.push({ name: `SFILE${i}_FILE`, secret: secret.key });
    });
    let command: Piece[] | null = null;
    if (rng.bool(0.6)) {
      const executable = rng.pick(["serve", "/usr/bin/app", "run"]);
      command = [{ lit: executable, raw: executable }];
      const argvParams = plain.filter(argvSafe);
      for (let n = rng.int(0, 5); n > 0; n -= 1) {
        command.push(argvParams.length > 0 && rng.bool(0.5) ? { param: rng.pick(argvParams).key } : rng.pick(ARGV_LITERALS));
      }
    }
    const mounts = rng.shuffle(volumes).slice(0, rng.int(0, 3)).map((volume) => ({ volume, path: `/app/${volume}`, mode: rng.pick(["", "ro", "rw"] as const) }));
    let health: HealthModel | null = null;
    if (expose.length > 0 && rng.bool(0.6)) {
      const port = rng.pick(expose);
      const withTiming = rng.bool();
      const interval = rng.int(5, 300);
      const timing = withTiming ? { interval, timeout: rng.int(1, Math.min(30, interval)) } : {};
      health = rng.bool() ? { kind: "tcp", port, ...timing } : { kind: "http", port, path: rng.pick(["/health", "/", "/a/b-c_d.e~f"]), ...timing };
    }
    return {
      key,
      repo: rng.pick(REPOS),
      tag: rng.bool() ? `${rng.int(1, 9)}.${rng.int(0, 9)}.${rng.int(0, 9)}` : null,
      digest: hex(rng, 64),
      command,
      env,
      mounts,
      expose,
      dependsOn,
      health,
      cpuMilli: rng.int(1, 320) * 50,
      memoryMiB: rng.int(32, 16_384),
      memoryAsBytes: rng.bool(0.3),
    };
  });
  const ingress: Model["ingress"][number][] = [];
  for (const service of services) {
    if (service.health === null) continue;
    for (const port of service.expose) if (ingress.length < 8 && rng.bool(0.6)) ingress.push({ service: service.key, port });
  }
  const mounted = new Set(services.flatMap((service) => service.mounts.map((mount) => mount.volume)));
  return {
    name: `Generated ${seed}`,
    category: rng.pick(["test", "productivity", "dev-tools"]),
    params,
    services,
    volumes: volumes.filter((volume) => mounted.has(volume)),
    ingress,
  };
}

const cpusText = (milli: number): string => String(milli / 1000);
const q = (text: string): string => JSON.stringify(text);

/** The source text of a model; with `perm`, every list and map is written in another order. */
function emit(model: Model, perm: Rng | null): string {
  const shuf = <T>(items: readonly T[]): T[] => (perm === null ? [...items] : perm.shuffle(items));
  const pad = (n: number): string => " ".repeat(n);
  const item = (indent: number, fields: string[]): string[] => shuf(fields).map((line, i) => `${pad(indent)}${i === 0 ? "- " : "  "}${line}`);

  const paramFields = (p: ParamModel): string[] => {
    const head = [`key: ${p.key}`, `label: ${q(`Parameter ${p.key}`)}`, `type: ${p.type}`, `customer: ${p.customer}`];
    switch (p.type) {
      case "enum":
        return [...head, `options: [${shuf(p.options ?? []).join(", ")}]`, `default: ${String(p.default)}`];
      case "integer":
        return [...head, `min: ${p.min}`, `max: ${p.max}`, `default: ${String(p.default)}`];
      case "string":
      case "size":
        return [...head, `default: ${q(String(p.default))}`];
      case "boolean":
        return [...head, `default: ${String(p.default)}`];
      case "secret":
        return [...head, `required: ${p.required}`];
    }
  };
  const rawOf = (pieces: readonly Piece[]): string => pieces.map((piece) => ("param" in piece ? `\${${piece.param}}` : piece.raw)).join("");

  const serviceBlocks = (s: ServiceModel): string[][] => {
    const blocks: string[][] = [[`    image: ${s.repo}${s.tag === null ? "" : `:${s.tag}`}@sha256:${s.digest}`]];
    if (s.command !== null) blocks.push([`    command: [${s.command.map((piece) => q(rawOf([piece]))).join(", ")}]`]);
    if (s.env.length > 0) {
      blocks.push([
        "    environment:",
        ...shuf(s.env).flatMap((entry) => item(6, "secret" in entry ? [`name: ${entry.name}`, `secret: ${entry.secret}`] : [`name: ${entry.name}`, `value: ${q(rawOf(entry.pieces))}`])),
      ]);
    }
    if (s.mounts.length > 0) {
      blocks.push(["    volumes:", ...shuf(s.mounts).map((m) => `      - ${m.volume}:${m.path}${m.mode === "" ? "" : `:${m.mode}`}`)]);
    }
    if (s.expose.length > 0) blocks.push(["    expose:", ...shuf(s.expose).map((port) => `      - ${port}`)]);
    if (s.dependsOn.length > 0) blocks.push(["    depends_on:", ...shuf(s.dependsOn).map((key) => `      - ${key}`)]);
    if (s.health !== null) {
      const h = s.health;
      const fields = [`kind: ${h.kind}`, `port: ${h.port}`];
      if (h.path !== undefined) fields.push(`path: ${h.path}`);
      if (h.interval !== undefined) fields.push(`intervalSeconds: ${h.interval}`, `timeoutSeconds: ${h.timeout}`);
      blocks.push(["    healthcheck:", ...shuf(fields).map((line) => `      ${line}`)]);
    }
    const memory = s.memoryAsBytes ? String(s.memoryMiB * 1_048_576) : q(`${s.memoryMiB}M`);
    blocks.push([
      "    deploy:",
      "      resources:",
      "        limits:",
      ...shuf([`cpus: ${q(cpusText(s.cpuMilli))}`, `memory: ${memory}`]).map((line) => `          ${line}`),
    ]);
    return blocks;
  };

  const roots: string[][] = [
    [
      "x-hp-stack:",
      ...shuf(["schemaVersion: 1", `name: ${q(model.name)}`, `category: ${model.category}`, `description: ${q("Generated by the QA pipeline test")}`]).map((line) => `  ${line}`),
    ],
    ["services:", ...shuf(model.services).flatMap((s) => [`  ${s.key}:`, ...shuf(serviceBlocks(s)).flat()])],
  ];
  if (model.params.length > 0) roots.push(["x-hp-parameters:", ...shuf(model.params).flatMap((p) => item(2, paramFields(p)))]);
  if (model.volumes.length > 0) roots.push(["volumes:", ...shuf(model.volumes).map((v) => `  ${v}: {}`)]);
  if (model.ingress.length > 0) {
    roots.push(["x-hp-ingress:", ...shuf(model.ingress).flatMap((i) => item(2, [`service: ${i.service}`, `port: ${i.port}`, "protocol: http"]))]);
  }
  return `${shuf(roots).flat().join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Expected plan, computed from the model alone
// ---------------------------------------------------------------------------------------------------------------

type Values = ReadonlyMap<string, ParamValue>;
const render = (pieces: readonly Piece[], values: Values): string =>
  pieces.map((piece) => ("param" in piece ? String(values.get(piece.param)) : piece.lit)).join("");
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function expectedComponents(model: Model, values: Values, versions: ReadonlyMap<string, number>): Map<string, unknown> {
  return new Map(
    model.services.map((s) => {
      const env: { name: string; value: string }[] = [];
      const secretFiles: { envName: string; parameterKey: string; version: number }[] = [];
      for (const entry of s.env) {
        if ("secret" in entry) {
          const version = versions.get(entry.secret);
          if (version !== undefined) secretFiles.push({ envName: entry.name, parameterKey: entry.secret, version });
        } else env.push({ name: entry.name, value: render(entry.pieces, values) });
      }
      const h = s.health;
      const healthcheck =
        h === null
          ? null
          : h.kind === "tcp"
            ? { kind: "tcp", port: h.port, intervalSeconds: h.interval ?? 10, timeoutSeconds: h.timeout ?? 3 }
            : { kind: "http", port: h.port, path: h.path, intervalSeconds: h.interval ?? 10, timeoutSeconds: h.timeout ?? 3 };
      return [
        s.key,
        {
          key: s.key,
          image: `${s.repo}@sha256:${s.digest}`,
          runAsUser: ALLOWLIST.find((entry) => entry.repository === s.repo)?.runAsUser ?? null,
          argv: s.command === null ? null : s.command.map((piece) => render([piece], values)),
          environment: env.sort((a, b) => compare(a.name, b.name)),
          secretFiles: secretFiles.sort((a, b) => compare(a.envName, b.envName)),
          resources: { cpuMilli: s.cpuMilli, memoryBytes: String(s.memoryMiB * 1_048_576) },
          expose: [...s.expose].sort((a, b) => a - b),
          dependsOn: [...s.dependsOn].sort(compare),
          volumes: s.mounts
            .map((m) => ({ volumeKey: m.volume, containerPath: m.path, readOnly: m.mode === "ro" }))
            .sort((a, b) => compare(a.containerPath, b.containerPath)),
          healthcheck,
        },
      ];
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------------------------------------------

interface Case {
  readonly seed: number;
  readonly model: Model;
  readonly source: string;
  readonly permuted: string;
  readonly entries: AppTemplateParameterEntry[];
  readonly values: Map<string, ParamValue>;
  readonly versions: Map<string, number>;
}

function customerValue(rng: Rng, param: ParamModel): ParamValue {
  switch (param.type) {
    case "enum":
      return rng.pick(param.options ?? []);
    case "integer":
      return rng.int(param.min ?? 0, param.max ?? 0);
    case "string":
      return rng.pick(SAFE_STRINGS);
    case "boolean":
      return rng.bool();
    default:
      return rng.pick(["1K", "512M", "99999G", "7G"]);
  }
}

function buildCase(seed: number): Case {
  const model = genModel(seed);
  const rng = makeRng(seed * 7919 + 13);
  const entries: AppTemplateParameterEntry[] = [];
  const values = new Map<string, ParamValue>();
  const versions = new Map<string, number>();
  for (const param of model.params) {
    if (param.type === "secret") {
      if (param.required === true || rng.bool(0.5)) versions.set(param.key, rng.bool(0.2) ? 2_147_483_647 : rng.int(1, 1000));
    } else {
      const given = param.customer && rng.bool(0.7) ? customerValue(rng, param) : undefined;
      if (given !== undefined) entries.push({ key: param.key, value: given });
      values.set(param.key, given ?? (param.default as ParamValue));
    }
  }
  return { seed, model, source: emit(model, null), permuted: emit(model, makeRng(seed + 99)), entries: rng.shuffle(entries), values, versions };
}

const CASES: Case[] = Array.from({ length: 200 }, (_, i) => buildCase(1000 + i));

const inputOf = (c: Case, change: Partial<AppStackCompileInput> = {}): AppStackCompileInput => ({
  source: c.source,
  parameters: c.entries,
  secretVersions: c.versions,
  ids: IDS,
  ...change,
});
function planOf(c: Case, change: Partial<AppStackCompileInput> = {}): ApprovedStackPlan {
  const result = compileAppStackPlan(inputOf(c, change), options);
  if (!result.ok) throw new Error(`seed ${c.seed}: expected a plan, got ${JSON.stringify(result.issues)}\n${c.source}`);
  return result.plan;
}
const json = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------------------------------------------

describe("the generator covers what the properties need", () => {
  const count = (test: (c: Case) => boolean): number => CASES.filter(test).length;
  const services = CASES.flatMap((c) => c.model.services);

  it("writes 200 distinct sources with 1 to 8 services each", () => {
    expect(new Set(CASES.map((c) => c.source)).size).toBe(200);
    const sizes = new Set(CASES.map((c) => c.model.services.length));
    expect([...sizes].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("uses every parameter type, argv and environment placeholders, volumes, health checks, ingress and dependencies", () => {
    const types = new Set(CASES.flatMap((c) => c.model.params.map((p) => p.type)));
    expect([...types].sort()).toEqual(["boolean", "enum", "integer", "secret", "size", "string"]);
    expect(services.filter((s) => s.command?.some((piece) => "param" in piece)).length).toBeGreaterThan(50);
    expect(services.filter((s) => s.env.some((e) => "pieces" in e && e.pieces.some((piece) => "param" in piece))).length).toBeGreaterThan(50);
    expect(count((c) => c.model.volumes.length > 0)).toBeGreaterThan(30);
    expect(services.filter((s) => s.health?.kind === "http").length).toBeGreaterThan(20);
    expect(services.filter((s) => s.health?.kind === "tcp").length).toBeGreaterThan(20);
    expect(count((c) => c.model.ingress.length > 0)).toBeGreaterThan(30);
    expect(services.reduce((total, s) => total + s.dependsOn.length, 0)).toBeGreaterThan(100);
    expect(count((c) => c.versions.size > 0)).toBeGreaterThan(30);
    expect(count((c) => c.entries.length > 0)).toBeGreaterThan(100);
    expect(count((c) => c.model.params.some((p) => !p.customer))).toBeGreaterThan(30);
  });
});

describe("every generated source goes through validate → compile → hash", () => {
  it("validates (200 cases)", () => {
    for (const c of CASES) {
      const result = validateAppTemplateSource(c.source, options);
      if (!result.ok) throw new Error(`seed ${c.seed}: ${json(result.errors)}\n${c.source}`);
      expect(result.spec.services.map((s) => s.key)).toEqual(c.model.services.map((s) => s.key).sort(compare));
    }
  });

  it("compiles to the plan the model predicts, parses with ApprovedStackPlanSchema and verifies its hash (200 cases)", () => {
    for (const c of CASES) {
      const plan = planOf(c);
      const wire = ApprovedStackPlanSchema.safeParse(JSON.parse(json(plan)));
      expect(wire.success, `seed ${c.seed}`).toBe(true);
      expect(wire.success && wire.data).toEqual(plan);
      expect(verifyAppStackPlanHash(plan), `seed ${c.seed}`).toBe(true);
      expect(plan.planHash).toBe(
        computeAppStackPlanHash({ schemaVersion: plan.schemaVersion, templateVersionId: IDS.templateVersionId, components: plan.components, volumes: plan.volumes, ingress: plan.ingress }),
      );
      expect(plan).toMatchObject(IDS);

      const expected = expectedComponents(c.model, c.values, c.versions);
      expect(plan.components.map((component) => component.key).sort(compare), `seed ${c.seed}`).toEqual([...expected.keys()].sort(compare));
      for (const component of plan.components) expect(component, `seed ${c.seed} ${component.key}`).toEqual(expected.get(component.key));
      expect(plan.volumes).toEqual(c.model.volumes.map((key) => ({ key })).sort((a, b) => compare(a.key, b.key)));
      expect(plan.ingress).toEqual(
        c.model.ingress.map((i) => ({ componentKey: i.service, port: i.port })).sort((a, b) => compare(a.componentKey, b.componentKey) || a.port - b.port),
      );
    }
  });

  it("changes the hash when the plan is edited after the fact, and with the template version only among the ids", () => {
    for (const c of CASES.slice(0, 60)) {
      const plan = planOf(c);
      const tampered = structuredClone(plan);
      const first = tampered.components[0];
      if (first === undefined) throw new Error("a plan has at least one component");
      first.image = first.image.replace(/.$/, (digit) => (digit === "0" ? "1" : "0"));
      expect(verifyAppStackPlanHash(tampered), `seed ${c.seed}`).toBe(false);
      expect(verifyAppStackPlanHash({ ...plan, planHash: "0".repeat(64) })).toBe(false);
      const otherIds = planOf(c, { ids: { ...IDS, stackId: "stk_other", organizationId: "org_other", hostAllocationId: "alloc_other", revisionId: "astr_other" } });
      expect(otherIds.planHash, `seed ${c.seed}`).toBe(plan.planHash);
      expect(planOf(c, { ids: { ...IDS, templateVersionId: "atv_other" } }).planHash, `seed ${c.seed}`).not.toBe(plan.planHash);
    }
  });
});

describe("determinism", () => {
  it("compiling twice gives byte-identical plans (200 cases)", () => {
    for (const c of CASES) {
      const a = compileAppStackPlan(inputOf(c), options);
      const b = compileAppStackPlan(inputOf(c), options);
      expect(json(a), `seed ${c.seed}`).toBe(json(b));
    }
  });

  it("gives the same plan and hash for services, parameters, environment entries and given values written in another order (200 cases)", () => {
    for (const c of CASES) {
      const reordered = inputOf(c, { source: c.permuted, parameters: makeRng(c.seed).shuffle(c.entries).reverse(), secretVersions: new Map([...c.versions].reverse()) });
      const a = planOf(c);
      const b = compileAppStackPlan(reordered, options);
      if (!b.ok) throw new Error(`seed ${c.seed}: ${json(b.issues)}\n${c.permuted}`);
      expect(json(b.plan), `seed ${c.seed}`).toBe(json(a));
      expect(b.plan.planHash).toBe(a.planHash);
    }
  });

  it("the permuted source really differs from the plain one in most cases", () => {
    expect(CASES.filter((c) => c.permuted !== c.source).length).toBeGreaterThan(150);
  });
});

describe("start order", () => {
  it("every dependency precedes its dependent (200 cases)", () => {
    let edges = 0;
    for (const c of CASES) {
      const plan = planOf(c);
      const position = new Map(plan.components.map((component, index) => [component.key, index]));
      for (const [index, component] of plan.components.entries()) {
        for (const dependency of component.dependsOn) {
          edges += 1;
          const at = position.get(dependency);
          expect(at, `seed ${c.seed}: ${component.key} needs ${dependency}`).toBeDefined();
          expect(at as number, `seed ${c.seed}: ${dependency} before ${component.key}`).toBeLessThan(index);
        }
      }
    }
    expect(edges).toBeGreaterThan(100);
  });
});

describe("A3: a customer:false parameter takes no value", () => {
  it("refuses even the default, writes nothing else, and the plan without it is unchanged", () => {
    let checked = 0;
    for (const c of CASES) {
      for (const param of c.model.params.filter((p) => !p.customer)) {
        checked += 1;
        const result = compileAppStackPlan(inputOf(c, { parameters: [...c.entries, { key: param.key, value: param.default as ParamValue }] }), options);
        expect(result.ok, `seed ${c.seed} ${param.key}`).toBe(false);
        if (!result.ok) {
          expect(result.issues.map(({ path, code }) => ({ path, code }))).toEqual([{ path: `parameters.${param.key}`, code: "PARAM_VALUE_NOT_CUSTOMER" }]);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A7: hostile values
// ---------------------------------------------------------------------------------------------------------------

const HOSTILE: string[] = [
  "; rm -rf /",
  "$(id)",
  "`id`",
  "a && b || c",
  "a | b > c < d",
  "${HOME}",
  "${x}",
  "$$",
  "a\nb",
  "a\r\nb",
  "a\0b",
  "\0",
  "-",
  "--eval=1",
  "-rf",
  "",
  "a".repeat(4097),
  "/var/run/docker.sock",
  "DOCKER.SOCK",
  "unix:///var/run/docker.sock",
  "169.254.169.254",
  "http://169.254.169.254/latest/meta-data",
  "metadata.google.internal",
  "http://user:pass@example.com/",
  "postgres://admin:hunter2@db:5432/x",
  "'; DROP TABLE x;--",
  "a b  c",
  "*",
  String.fromCharCode(0x2028),
  "a;b\tc",
];

// eslint-disable-next-line no-control-regex
const CONTROL_OR_LINE_SEPARATOR = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");

/** The spec's refusals for a string value, written independently of the implementation. */
const mustRefuseString = (value: string): boolean =>
  value.length > 256 ||
  CONTROL_OR_LINE_SEPARATOR.test(value) ||
  value.includes("${") ||
  /docker\.sock/i.test(value) ||
  /169\.254\.|fd00:ec2::|metadata\.google\.internal/i.test(value) ||
  /:\/\/[^/\s:@]+:[^/\s@]+@/.test(value);

const STABLE_CODES = new Set([
  "PARAM_VALUE_INVALID_TYPE",
  "PARAM_VALUE_NOT_IN_OPTIONS",
  "PARAM_VALUE_OUT_OF_RANGE",
  "PARAM_VALUE_TOO_LONG",
  "PARAM_VALUE_INVALID_CHARACTERS",
  "PARAM_VALUE_FORBIDDEN_CONTENT",
  "PARAM_VALUE_SECRET",
  "PARAM_VALUE_ARGV_UNSAFE",
  "RENDERED_VALUE_FORBIDDEN",
]);

describe("A7: hostile customer values are refused with a stable code or land literally and whole", () => {
  it("has 30 hostile values", () => {
    expect(HOSTILE).toHaveLength(30);
    expect(new Set(HOSTILE).size).toBe(30);
  });

  it("holds for every customer parameter of the first 40 cases", () => {
    let attempts = 0;
    let landed = 0;
    let usedInArgv = 0;
    for (const c of CASES.slice(0, 40)) {
      const argvKeys = new Set(c.model.services.flatMap((s) => (s.command ?? []).flatMap((piece) => ("param" in piece ? [piece.param] : []))));
      const baseline = JSON.stringify(planOf(c).components.map((component) => component.argv?.[0] ?? null));
      for (const param of c.model.params.filter((p) => p.customer && p.type !== "secret")) {
        for (const hostile of HOSTILE) {
          attempts += 1;
          const parameters = [...c.entries.filter((entry) => entry.key !== param.key), { key: param.key, value: hostile }];
          const result = compileAppStackPlan(inputOf(c, { parameters }), options);
          const where = `seed ${c.seed} ${param.key} ${JSON.stringify(hostile.slice(0, 40))}`;
          const refusal =
            param.type !== "string" ||
            mustRefuseString(hostile) ||
            (argvKeys.has(param.key) && (hostile === "" || hostile.startsWith("-")));

          if (!result.ok) {
            expect(refusal, `${where}: refused a harmless value (${json(result.issues.map((i) => i.code))})`).toBe(true);
            expect(result.issues.length, where).toBeGreaterThan(0);
            for (const issue of result.issues) {
              expect(issue.path, where).toBe(`parameters.${param.key}`);
              expect(STABLE_CODES.has(issue.code), `${where}: ${issue.code}`).toBe(true);
              expect(issue.reason, where).toBe("STACK_PARAMETER_INVALID");
              if (hostile.length >= 4) expect(json(issue), where).not.toContain(JSON.stringify(hostile).slice(1, -1));
            }
            expect(json(compileAppStackPlan(inputOf(c, { parameters }), options)), `${where}: unstable`).toBe(json(result));
            continue;
          }

          expect(refusal, `${where}: accepted a value the spec refuses`).toBe(false);
          landed += 1;
          const values = new Map(c.values);
          values.set(param.key, hostile);
          const expected = expectedComponents(c.model, values, c.versions);
          for (const component of result.plan.components) {
            // Whole and literal in every position the source interpolates it, nowhere else; argv never split.
            expect(component, where).toEqual(expected.get(component.key));
          }
          for (const service of c.model.services) {
            if (service.command === null) continue;
            const argv = result.plan.components.find((component) => component.key === service.key)?.argv;
            expect(argv?.length, where).toBe(service.command.length);
            expect(argv?.[0], `${where}: argv[0]`).toBe((service.command[0] as { lit: string }).lit);
            if (service.command.some((piece) => "param" in piece && piece.param === param.key)) usedInArgv += 1;
          }
          expect(verifyAppStackPlanHash(result.plan), where).toBe(true);
          expect(JSON.stringify(result.plan.components.map((component) => component.argv?.[0] ?? null)), where).toBe(baseline);
        }
      }
    }
    expect(attempts).toBeGreaterThan(1000);
    expect(landed).toBeGreaterThan(100);
    expect(usedInArgv).toBeGreaterThan(5);
  });

  it("a harmless-looking shell string is data, never code: it lands unchanged in a whole argv item and in an env value", () => {
    const source = [
      'x-hp-stack:\n  schemaVersion: 1\n  name: "Hostile"\n  category: test',
      'x-hp-parameters:\n  - key: text\n    label: "Text"\n    type: string\n    default: "plain"\n    customer: true',
      `services:\n  app:\n    image: ${REPOS[0]}@sha256:${"a".repeat(64)}\n    command: ["serve", "\${text}"]\n    environment:\n      - name: LABEL\n        value: "pre-\${text}-post"\n    deploy:\n      resources:\n        limits:\n          cpus: "0.5"\n          memory: 256M`,
    ].join("\n");
    const value = "$$ ; rm -rf / $(id) `id` | * ~ \\ 'x' \"y\" && -z";
    const result = compileAppStackPlan({ source, parameters: [{ key: "text", value }], secretVersions: new Map(), ids: IDS }, options);
    if (!result.ok) throw new Error(json(result.issues));
    expect(result.plan.components[0]?.argv).toEqual(["serve", value]);
    expect(result.plan.components[0]?.environment).toEqual([{ name: "LABEL", value: `pre-${value}-post` }]);
  });

  it("refuses non-string values for integer parameters with a stable code", () => {
    let checked = 0;
    for (const c of CASES.slice(0, 40)) {
      for (const param of c.model.params.filter((p) => p.customer && p.type === "integer")) {
        for (const value of [1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, 1_000_000_001, (param.max ?? 0) + 1, (param.min ?? 0) - 1]) {
          checked += 1;
          const result = compileAppStackPlan(inputOf(c, { parameters: [{ key: param.key, value }] }), options);
          expect(result.ok, `seed ${c.seed} ${param.key} ${String(value)}`).toBe(false);
          if (!result.ok) {
            expect(result.issues.map((issue) => issue.path)).toEqual([`parameters.${param.key}`]);
            expect(STABLE_CODES.has(result.issues[0]?.code ?? "")).toBe(true);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A8: secrets
// ---------------------------------------------------------------------------------------------------------------

describe("A8: a secret never reaches the plan, the preview, an issue or the hash input", () => {
  // The marker is the value of every secret: the compiler is given the versions only.
  const marker = "9f3a1c7e5b2d48860a1f7c3e9b5d2a4c6e8f0b1d";
  const withSecrets = CASES.filter((c) => c.versions.size > 0);

  it("has a 40-character marker and enough cases with secrets", () => {
    expect(marker).toHaveLength(40);
    expect(withSecrets.length).toBeGreaterThan(30);
  });

  it("is absent from the plan and the preview, which carry the secret's name and version only", () => {
    let secretFiles = 0;
    for (const c of withSecrets) {
      const plan = planOf(c);
      const preview = previewAppTemplateSource(c.source, options);
      expect(json(plan)).not.toContain(marker);
      expect(json(preview)).not.toContain(marker);
      const files = plan.components.flatMap((component) => component.secretFiles);
      secretFiles += files.length;
      for (const file of files) expect(Object.keys(file).sort()).toEqual(["envName", "parameterKey", "version"]);
      expect(json(preview)).not.toMatch(/"version"/);
    }
    expect(secretFiles).toBeGreaterThan(30);
  });

  it("changing a secret version changes the plan hash, and nothing else", () => {
    let changed = 0;
    for (const c of withSecrets) {
      const plan = planOf(c);
      if (plan.components.every((component) => component.secretFiles.length === 0)) continue;
      const key = [...c.versions.keys()].find((k) => plan.components.some((component) => component.secretFiles.some((file) => file.parameterKey === k)));
      if (key === undefined) throw new Error("a secret file names a version");
      const old = c.versions.get(key) as number;
      const bumped = planOf(c, { secretVersions: new Map([...c.versions, [key, old === 2_147_483_647 ? old - 1 : old + 1]]) });
      expect(bumped.planHash, `seed ${c.seed} ${key}`).not.toBe(plan.planHash);
      expect(verifyAppStackPlanHash(bumped)).toBe(true);
      expect({ ...bumped, planHash: "", components: bumped.components.map((x) => ({ ...x, secretFiles: [] })) }).toEqual({
        ...plan,
        planHash: "",
        components: plan.components.map((x) => ({ ...x, secretFiles: [] })),
      });
      changed += 1;
    }
    expect(changed).toBeGreaterThan(20);
  });

  it("is never echoed by an issue: inline secret value, wrong type, unknown or repeated parameter, secret-like source text", () => {
    const secretCase = withSecrets.find((c) => c.model.params.some((p) => p.type === "secret" && c.versions.has(p.key)));
    const integerCase = CASES.find((c) => c.model.params.some((p) => p.customer && p.type === "integer"));
    if (secretCase === undefined || integerCase === undefined) throw new Error("the corpus needs a secret and an integer parameter");
    const secretKey = (secretCase.model.params.find((p) => p.type === "secret" && secretCase.versions.has(p.key)) as ParamModel).key;
    const integerKey = (integerCase.model.params.find((p) => p.customer && p.type === "integer") as ParamModel).key;
    const refusals: AppTemplateIssue[][] = [];
    const refused = (c: Case, parameters: AppTemplateParameterEntry[]): void => {
      const result = compileAppStackPlan(inputOf(c, { parameters }), options);
      if (result.ok) throw new Error("expected a refusal");
      refusals.push(result.issues);
    };
    refused(secretCase, [{ key: secretKey, value: marker }]);
    refused(integerCase, [{ key: integerKey, value: marker }]);
    refused(integerCase, [{ key: "unknown_key", value: marker }]);
    refused(integerCase, [{ key: integerKey, value: 1 }, { key: integerKey, value: marker }]);
    expect(refusals.map((issues) => issues.map((issue) => issue.code))).toEqual([
      ["PARAM_VALUE_SECRET"],
      ["PARAM_VALUE_INVALID_TYPE"],
      ["PARAM_VALUE_UNKNOWN"],
      ["PARAM_VALUE_DUPLICATE"],
    ]);
    for (const issues of refusals) expect(json(issues)).not.toContain(marker.slice(0, 12));

    const mini = (env: string, argv = '"serve"'): string =>
      `x-hp-stack:\n  schemaVersion: 1\n  name: "Mini"\n  category: test\nservices:\n  app:\n    image: ${REPOS[0]}@sha256:${"a".repeat(64)}\n    command: [${argv}]\n    environment:\n      - name: LOG_LEVEL\n        value: ${q(env)}\n    deploy:\n      resources:\n        limits:\n          cpus: "0.5"\n          memory: 256M\n`;
    const sources = [
      mini(`sk-${marker}`),
      mini(`Bearer ${marker}`),
      mini(`postgres://user:${marker}@db/x`),
      mini("x", `"serve", "http://user:${marker}@host/"`),
      mini(`/run/${marker}/docker.sock`),
    ];
    for (const source of sources) {
      const validation = validateAppTemplateSource(source, options);
      const compiled = compileAppStackPlan({ source, parameters: [], secretVersions: new Map(), ids: IDS }, options);
      const preview = previewAppTemplateSource(source, options);
      expect(validation.ok, source).toBe(false);
      expect(compiled.ok, source).toBe(false);
      expect(preview.ok, source).toBe(false);
      for (const text of [json(validation), json(compiled), json(preview)]) expect(text).not.toContain(marker);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A1: preview
// ---------------------------------------------------------------------------------------------------------------

describe("A1: the preview of a source is what the plan compiled with default values previews", () => {
  it("equals toAppStackPreview of that plan, byte for byte (200 cases)", () => {
    for (const c of CASES) {
      const preview = previewAppTemplateSource(c.source, options);
      if (!preview.ok) throw new Error(`seed ${c.seed}: ${json(preview.errors)}`);
      const everySecretSet = new Map(c.model.params.filter((p) => p.type === "secret").map((p) => [p.key, 1]));
      const defaults = planOf(c, { parameters: [], secretVersions: everySecretSet });
      expect(preview.preview, `seed ${c.seed}`).toEqual(toAppStackPreview(defaults));
      expect(json(preview.preview), `seed ${c.seed}`).toBe(json(toAppStackPreview(defaults)));
      const validation = validateAppTemplateSource(c.source, options);
      expect(validation.ok && json(validation.spec), `seed ${c.seed}`).toBe(json(preview.spec));
      const reordered = previewAppTemplateSource(c.permuted, options);
      expect(reordered.ok && json(reordered.preview), `seed ${c.seed}`).toBe(json(preview.preview));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Refusals agree across the pipeline
// ---------------------------------------------------------------------------------------------------------------

describe("a refused source is refused the same way by validate, compile and preview", () => {
  const mutations: Array<[string, (source: string) => string, string]> = [
    ["an image off the allowlist", (s) => s.replace("registry.example.invalid/gen/", "registry.example.invalid/evil/"), "IMAGE_NOT_ALLOWLISTED"],
    ["a tag 'latest'", (s) => s.replace(/(registry\.example\.invalid\/gen\/\w+)(:[0-9.]+)?@/, "$1:latest@"), "IMAGE_TAG_LATEST"],
    ["a shell as the executable", (s) => (s.includes("    command: [") ? s.replace(/command: \["[^"]*"/, 'command: ["sh"') : `${s}`), "ARGV_SHELL_REFUSED"],
  ];

  it.each(mutations)("%s", (_, mutate, code) => {
    let refused = 0;
    for (const c of CASES.slice(0, 60)) {
      const source = mutate(c.source);
      if (source === c.source) continue;
      refused += 1;
      const validation = validateAppTemplateSource(source, options);
      expect(validation.ok, `seed ${c.seed}`).toBe(false);
      if (validation.ok) continue;
      expect(validation.errors.map((issue) => issue.code), `seed ${c.seed}`).toContain(code);
      const compiled = compileAppStackPlan(inputOf(c, { source }), options);
      expect(compiled.ok).toBe(false);
      if (!compiled.ok) expect(compiled.issues).toEqual(validation.errors);
      const preview = previewAppTemplateSource(source, options);
      expect(preview.ok).toBe(false);
      if (!preview.ok) expect(preview.errors).toEqual(validation.errors);
    }
    expect(refused).toBeGreaterThan(20);
  });
});
