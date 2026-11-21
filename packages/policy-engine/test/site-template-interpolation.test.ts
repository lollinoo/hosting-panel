import { describe, expect, it } from "vitest";
import {
  expandPieces,
  HP_MAGIC_VARIABLES,
  HP_MODULE_IMAGE_VARIABLE,
  HP_VARIABLE_MAX_LENGTH,
  scanInterpolation,
} from "../src/site-template-interpolation.js";

function pieces(text: string) {
  const scan = scanInterpolation(text);
  if (!scan.ok) throw new Error(`expected ${JSON.stringify(text)} to scan, got offset ${scan.offset}: ${scan.message}`);
  return scan.pieces;
}

function failure(text: string) {
  const scan = scanInterpolation(text);
  if (scan.ok) throw new Error(`expected ${JSON.stringify(text)} to fail, got ${JSON.stringify(scan.pieces)}`);
  return scan;
}

describe("scanInterpolation — accepted text", () => {
  it("returns no pieces for an empty string", () => {
    expect(pieces("")).toEqual([]);
  });

  it("keeps plain text as one literal, backticks and lone braces included", () => {
    expect(pieces("plain text")).toEqual([{ literal: "plain text" }]);
    expect(pieces("`x` {a} (b) %c%")).toEqual([{ literal: "`x` {a} (b) %c%" }]);
  });

  it("turns $$ into a literal dollar and merges it into the surrounding literal", () => {
    expect(pieces("$$")).toEqual([{ literal: "$" }]);
    expect(pieces("a$$b")).toEqual([{ literal: "a$b" }]);
    expect(pieces("$$$$")).toEqual([{ literal: "$$" }]);
    expect(pieces("$${a}")).toEqual([{ literal: "${a}" }]);
  });

  it("finds a variable between literals", () => {
    expect(pieces("a${x}b")).toEqual([{ literal: "a" }, { variable: "x" }, { literal: "b" }]);
    expect(pieces("${x}")).toEqual([{ variable: "x" }]);
  });

  it("finds adjacent variables", () => {
    expect(pieces("${a}${b}")).toEqual([{ variable: "a" }, { variable: "b" }]);
  });

  it("reads $$ followed by a variable as a literal dollar and a variable", () => {
    expect(pieces("$$${a}")).toEqual([{ literal: "$" }, { variable: "a" }]);
  });

  it("accepts the full variable-name alphabet", () => {
    expect(pieces("${_a1_B2}")).toEqual([{ variable: "_a1_B2" }]);
    expect(pieces("${HP_SITE_URL}")).toEqual([{ variable: "HP_SITE_URL" }]);
  });
});

describe("scanInterpolation — refused text", () => {
  const cases: readonly (readonly [text: string, offset: number])[] = [
    ["$", 0],
    ["a$", 1],
    ["$a", 0],
    ["$HOME", 0],
    ["${", 0],
    ["${}", 0],
    ["${a", 0],
    ["${1a}", 0],
    ["${a-b}", 0],
    ["${a:-b}", 0],
    ["${a?x}", 0],
    ["${ a}", 0],
    ["${a }", 0],
    ["${${a}}", 0],
    ["$(cmd)", 0],
    ["$ ", 0],
    ["ok $$ then ${a} then $x", 21],
    ["${a}${", 4],
    ["$$$", 2],
  ];

  it.each(cases)("refuses %j at offset %i", (text, offset) => {
    const scan = failure(text);
    expect(scan.code).toBe("INTERP_SYNTAX");
    expect(scan.offset).toBe(offset);
    expect(scan.message.length).toBeGreaterThan(0);
  });

  it("reports the first problem only", () => {
    expect(failure("$a ${b-c}").offset).toBe(0);
  });

  it("never echoes the offending text in the message", () => {
    for (const text of ["${hunter2-secret}", "$hunter2", "${hunter2"]) {
      expect(failure(text).message).not.toContain("hunter2");
    }
  });

  it("stays linear on hostile input", () => {
    const started = Date.now();
    expect(scanInterpolation("${" + "a".repeat(200_000)).ok).toBe(false);
    expect(scanInterpolation("$".repeat(200_001)).ok).toBe(false);
    expect(scanInterpolation("${a}".repeat(50_000)).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("expandPieces", () => {
  it("joins literals and the looked-up values", () => {
    expect(expandPieces(pieces("a${x}-${y}$$"), (name) => ({ x: "1", y: "2" })[name] ?? "?")).toBe("a1-2$");
    expect(expandPieces([], () => "never")).toBe("");
  });

  it("expands in a single pass: a value is never scanned again", () => {
    expect(expandPieces(pieces("${a}"), () => "${b}")).toBe("${b}");
    expect(expandPieces(pieces("${a}"), () => "$$")).toBe("$$");
  });

  it("asks for each variable occurrence by its name", () => {
    const asked: string[] = [];
    expandPieces(pieces("${a}${b}${a}"), (name) => (asked.push(name), ""));
    expect(asked).toEqual(["a", "b", "a"]);
  });
});

describe("variable constants", () => {
  it("names the magic variables and the whole-value image variable", () => {
    expect(HP_MAGIC_VARIABLES).toEqual(["HP_SITE_ID", "HP_SITE_DOMAIN", "HP_SITE_URL"]);
    expect(HP_MODULE_IMAGE_VARIABLE).toBe("HP_MODULE_IMAGE");
  });

  it("bounds every magic variable", () => {
    expect(HP_VARIABLE_MAX_LENGTH).toEqual({ HP_SITE_ID: 128, HP_SITE_DOMAIN: 253, HP_SITE_URL: 2048 });
    expect(Object.keys(HP_VARIABLE_MAX_LENGTH)).toEqual([...HP_MAGIC_VARIABLES]);
  });
});
