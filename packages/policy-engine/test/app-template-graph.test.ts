import { describe, expect, it } from "vitest";
import { orderAppTemplateServices } from "../src/app-template-graph.js";

const graph = (edges: Record<string, string[]>) => Object.entries(edges).map(([key, dependsOn]) => ({ key, dependsOn }));

describe("orderAppTemplateServices", () => {
  it("places a dependency before its dependent", () => {
    expect(orderAppTemplateServices(graph({ app: ["cache"], cache: [] }))).toEqual({ ok: true, order: ["cache", "app"] });
  });

  it("reports a two-node cycle and leaves the free node out", () => {
    expect(orderAppTemplateServices(graph({ a: ["b"], b: ["a"], c: [] }))).toEqual({ ok: false, unordered: ["a", "b"] });
  });

  it("breaks ties by the code-unit-smallest ready key, whatever the input order", () => {
    expect(orderAppTemplateServices(graph({ web: [], api: [], db: [] }))).toEqual({ ok: true, order: ["api", "db", "web"] });
    expect(orderAppTemplateServices(graph({ web: ["db"], db: [], api: ["db"] }))).toEqual({
      ok: true,
      order: ["db", "api", "web"],
    });
    expect(orderAppTemplateServices(graph({ b: [], a: ["c"], c: [] }))).toEqual({ ok: true, order: ["b", "c", "a"] });
    expect(orderAppTemplateServices(graph({ a: [], B: [], _: [] }))).toEqual({ ok: true, order: ["B", "_", "a"] });
  });

  it("counts a self-dependency as a cycle", () => {
    expect(orderAppTemplateServices(graph({ app: ["app"], cache: [] }))).toEqual({ ok: false, unordered: ["app"] });
  });

  it("reports every key of a three-cycle and a key waiting on it, ascending", () => {
    expect(orderAppTemplateServices(graph({ z: ["x"], y: ["z"], x: ["y"], w: ["x"], v: [] }))).toEqual({
      ok: false,
      unordered: ["w", "x", "y", "z"],
    });
  });

  it("ignores a dependency that names no service", () => {
    expect(orderAppTemplateServices(graph({ app: ["ghost", "cache"], cache: ["app-x"] }))).toEqual({
      ok: true,
      order: ["cache", "app"],
    });
  });

  it("orders an 8-node chain given in reverse", () => {
    const keys = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    const services = keys.map((key, i) => ({ key, dependsOn: i === keys.length - 1 ? [] : [keys[i + 1] as string] })).reverse();
    expect(orderAppTemplateServices(services)).toEqual({ ok: true, order: [...keys].reverse() });
  });

  it("orders an empty list and never throws on odd keys or duplicates", () => {
    expect(orderAppTemplateServices([])).toEqual({ ok: true, order: [] });
    const odd = graph({ ["__proto__"]: ["constructor"], constructor: [], toString: ["toString"], "": ["hasOwnProperty"] });
    expect(() => orderAppTemplateServices(odd)).not.toThrow();
    expect(orderAppTemplateServices(odd)).toEqual({ ok: false, unordered: ["toString"] });
    expect(() => orderAppTemplateServices([{ key: "a", dependsOn: [] }, { key: "a", dependsOn: ["a"] }])).not.toThrow();
  });

  it("does not mutate its input", () => {
    const services = graph({ app: ["cache"], cache: [] });
    const before = JSON.stringify(services);
    orderAppTemplateServices(services);
    expect(JSON.stringify(services)).toBe(before);
  });
});
