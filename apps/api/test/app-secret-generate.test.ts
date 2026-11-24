import { APP_SECRET_GENERATE_BOUNDS, APP_SECRET_GENERATE_KINDS, AppTemplateSpecSchema, type AppSecretGenerate, type AppTemplateSpec } from "@hosting-panel/contracts";
import { validateAppTemplateSource } from "@hosting-panel/policy-engine";
import { describe, expect, it } from "vitest";
import {
  appSecretsToGenerate,
  generateAppSecretValue,
  generateAppSecretValues,
  SYSTEM_APP_SECRET_RANDOMNESS,
  type AppSecretRandomness,
} from "../src/app-stacks/app-secret-generate.js";

const SHAPES: Record<AppSecretGenerate["kind"], RegExp> = {
  password: /^[A-Za-z0-9]+$/,
  hex: /^[0-9a-f]+$/,
  user: /^[a-z][a-z0-9]*$/,
  base64: /^[A-Za-z0-9+/]+={0,2}$/,
};

/** Hands out the given indexes in order, then zeros; bytes count up from `first`. */
function scripted(indexes: readonly number[] = [], first = 0): AppSecretRandomness & { asked: number[] } {
  const queue = [...indexes];
  const asked: number[] = [];
  return {
    asked,
    int(bound) {
      asked.push(bound);
      return queue.shift() ?? 0;
    },
    bytes: (count) => Uint8Array.from({ length: count }, (_unused, i) => (first + i) % 256),
  };
}

describe("generated secret values (ADR-0036)", () => {
  it.each(APP_SECRET_GENERATE_KINDS)("%s: the shape and the length of its kind, at both bounds", (kind) => {
    const { min, max } = APP_SECRET_GENERATE_BOUNDS[kind];
    for (const length of [min, max]) {
      const value = generateAppSecretValue({ kind, length });
      expect(value).toMatch(SHAPES[kind]);
      if (kind === "base64") expect(Buffer.from(value, "base64")).toHaveLength(length);
      else expect(value).toHaveLength(length);
    }
  });

  it.each(APP_SECRET_GENERATE_KINDS)("%s: a length outside its bounds is refused, whatever it is", (kind) => {
    const { min, max } = APP_SECRET_GENERATE_BOUNDS[kind];
    for (const length of [min - 1, max + 1, 0, -1, 20.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => generateAppSecretValue({ kind, length })).toThrow(RangeError);
    }
  });

  it("draws each character from the alphabet of its kind", () => {
    const password = scripted([0, 25, 26, 51, 52, 61]);
    expect(generateAppSecretValue({ kind: "password", length: 16 }, password)).toBe(`AZaz09${"A".repeat(10)}`);
    expect(password.asked).toEqual(Array<number>(16).fill(62));

    const hex = scripted([0, 9, 10, 15]);
    expect(generateAppSecretValue({ kind: "hex", length: 16 }, hex)).toBe(`09af${"0".repeat(12)}`);
    expect(hex.asked).toEqual(Array<number>(16).fill(16));

    // The first character of a user name is a letter: it is drawn from 26, the others from 36.
    const user = scripted([25, 35, 26, 0]);
    expect(generateAppSecretValue({ kind: "user", length: 8 }, user)).toBe("z90aaaaa");
    expect(user.asked).toEqual([26, ...Array<number>(7).fill(36)]);
  });

  it("base64 is the standard encoding of exactly `length` random bytes", () => {
    const value = generateAppSecretValue({ kind: "base64", length: 16 }, scripted([], 240));
    expect(value).toBe(Buffer.from(Uint8Array.from({ length: 16 }, (_unused, i) => (240 + i) % 256)).toString("base64"));
    expect(value).toContain("/");
    expect(value.endsWith("==")).toBe(true);
  });

  it("refuses a source of randomness that answers out of range", () => {
    for (const index of [-1, 62, 1.5, Number.NaN]) {
      expect(() => generateAppSecretValue({ kind: "password", length: 16 }, scripted([index]))).toThrow(RangeError);
    }
    const short: AppSecretRandomness = { int: () => 0, bytes: (count) => new Uint8Array(count - 1) };
    expect(() => generateAppSecretValue({ kind: "base64", length: 16 }, short)).toThrow(RangeError);
  });

  it("the system randomness gives a different value at every call", () => {
    const values = new Set(Array.from({ length: 50 }, () => generateAppSecretValue({ kind: "password", length: 32 })));
    expect(values.size).toBe(50);
    expect(Object.isFrozen(SYSTEM_APP_SECRET_RANDOMNESS)).toBe(true);
    for (let i = 0; i < 200; i += 1) {
      const index = SYSTEM_APP_SECRET_RANDOMNESS.int(62);
      expect(Number.isInteger(index) && index >= 0 && index < 62).toBe(true);
    }
    expect(SYSTEM_APP_SECRET_RANDOMNESS.bytes(24)).toHaveLength(24);
  });

  it("every character of every alphabet turns up", () => {
    const seen = { password: new Set<string>(), hex: new Set<string>(), user: new Set<string>() };
    for (let i = 0; i < 40; i += 1) {
      for (const kind of ["password", "hex", "user"] as const) {
        const length = kind === "user" ? 32 : 128;
        for (const char of generateAppSecretValue({ kind, length })) seen[kind].add(char);
      }
    }
    expect(seen.password.size).toBe(62);
    expect(seen.hex.size).toBe(16);
    expect(seen.user.size).toBe(36);
  });
});

const SOURCE = `x-hp-stack:
  schemaVersion: 2
  name: Generated Demo
  category: demo
  description: Parameters of every kind.
x-hp-parameters:
  - key: title
    label: Title
    type: string
    default: "Demo"
    customer: true
  - key: db_password
    label: Database password
    type: secret
    required: true
    customer: false
    generate:
      kind: password
      length: 32
  - key: typed
    label: Typed secret
    type: secret
    required: false
    customer: true
  - key: admin_user
    label: Administrator
    type: secret
    required: true
    customer: true
    generate:
      kind: user
      length: 12
services:
  app:
    image: registry.example.invalid/demo/app:1.0.0@sha256:${"a".repeat(64)}
    environment:
      - name: DB_PASSWORD
        secret: db_password
      - name: ADMIN_USER
        secret: admin_user
      - name: TYPED_FILE
        secret: typed
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 128M
`;

function specOf(source: string): AppTemplateSpec {
  const allowlist = [{ repository: "registry.example.invalid/demo/app", runAsUser: null, note: "test fixture" }];
  const checked = validateAppTemplateSource(source, { allowlist });
  if (!checked.ok) throw new Error(`the demo must validate: ${JSON.stringify(checked.errors)}`);
  return AppTemplateSpecSchema.parse(checked.spec);
}

describe("which secrets the platform generates (ADR-0036)", () => {
  const spec = specOf(SOURCE);

  it("the generated parameters without a stored version, in source order", () => {
    expect(appSecretsToGenerate(spec, new Map())).toEqual([
      { parameterKey: "db_password", rule: { kind: "password", length: 32 } },
      { parameterKey: "admin_user", rule: { kind: "user", length: 12 } },
    ]);
    expect(appSecretsToGenerate(spec, new Map([["db_password", 3]]))).toEqual([{ parameterKey: "admin_user", rule: { kind: "user", length: 12 } }]);
    expect(appSecretsToGenerate(spec, new Set(["db_password", "admin_user"]))).toEqual([]);
    // A stored value under another name changes nothing.
    expect(appSecretsToGenerate(spec, new Set(["typed", "title"]))).toHaveLength(2);
  });

  it("a template of the first format generates nothing", () => {
    const v1 = specOf(
      SOURCE.replace("schemaVersion: 2", "schemaVersion: 1")
        .replace("    customer: false\n    generate:\n      kind: password\n      length: 32\n", "    customer: true\n")
        .replace("    generate:\n      kind: user\n      length: 12\n", "")
        .replace("DB_PASSWORD\n", "DB_PASSWORD_FILE\n")
        .replace("ADMIN_USER\n", "ADMIN_USER_FILE\n"),
    );
    expect(v1.schemaVersion).toBe(1);
    expect(appSecretsToGenerate(v1, new Map())).toEqual([]);
  });

  it("one value per entry, each of its own rule", () => {
    const values = generateAppSecretValues(appSecretsToGenerate(spec, new Map()));
    expect(values.map((entry) => entry.parameterKey)).toEqual(["db_password", "admin_user"]);
    expect(values[0]!.value).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(values[1]!.value).toMatch(/^[a-z][a-z0-9]{11}$/);
    expect(generateAppSecretValues([])).toEqual([]);
    const fixed = generateAppSecretValues([{ parameterKey: "k", rule: { kind: "hex", length: 16 } }], scripted([15]));
    expect(fixed).toEqual([{ parameterKey: "k", value: `f${"0".repeat(15)}` }]);
  });
});
