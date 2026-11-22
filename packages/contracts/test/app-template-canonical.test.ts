import { describe, expect, it } from "vitest";
import { canonicalAppStackJson } from "../src/app-templates/canonical.js";

describe("canonicalAppStackJson", () => {
  it.each([
    [{ b: 1, a: [2, 1] }, '{"a":[2,1],"b":1}'],
    [{ B: 1, a: 2, _: 3 }, '{"B":1,"_":3,"a":2}'],
    [{ z: { y: null, x: true }, s: "é\"\n" }, '{"s":"é\\"\\n","z":{"x":true,"y":null}}'],
    [[], "[]"],
    [{}, "{}"],
    [null, "null"],
    [false, "false"],
    ["x", '"x"'],
    [-0, "0"],
    [Number.MAX_SAFE_INTEGER, "9007199254740991"],
    [Object.assign(Object.create(null) as object, { b: 1, a: 2 }), '{"a":2,"b":1}'],
  ])("%j -> %s", (value, expected) => {
    expect(canonicalAppStackJson(value)).toBe(expected);
  });

  it("orders keys by code unit, not by locale", () => {
    expect(canonicalAppStackJson({ "é": 1, z: 2, Z: 3, "10": 4, "9": 5 })).toBe('{"10":4,"9":5,"Z":3,"z":2,"é":1}');
  });

  class Box {
    readonly v = 1;
  }

  it.each([
    ["a float", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", 2 ** 53],
    ["a bigint", 1n],
    ["undefined", undefined],
    ["an undefined property", { a: undefined }],
    ["an array hole", new Array<number>(1)],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a class instance", new Box()],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a nested float", { a: [{ b: 0.1 }] }],
  ])("throws TypeError on %s", (_, value) => {
    expect(() => canonicalAppStackJson(value)).toThrow(TypeError);
  });

  it("does not mutate its input", () => {
    const value = { b: [3, { d: 1, c: 2 }], a: "x" };
    const copy = structuredClone(value);
    canonicalAppStackJson(value);
    expect(value).toEqual(copy);
    expect(Object.keys(value)).toEqual(["b", "a"]);
  });
});
