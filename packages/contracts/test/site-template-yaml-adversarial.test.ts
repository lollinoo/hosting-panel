import { describe, expect, it } from "vitest";
import {
  TEMPLATE_SOURCE_MAX_BYTES,
  YAML_ERROR_CODES,
  YAML_MAX_DEPTH,
  parseTemplateYaml,
  type YamlErrorCode,
  type YamlValue,
} from "../src/site-templates/yaml-subset.js";

function ok(source: string): YamlValue {
  const result = parseTemplateYaml(source);
  if (!result.ok) {
    throw new Error(`expected ok, got ${result.errors[0].code} at ${result.errors[0].line}:${result.errors[0].column}`);
  }
  return result.value;
}

function err(source: string) {
  const result = parseTemplateYaml(source);
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`);
  return result.errors[0];
}

type Case = readonly [source: string, code: YamlErrorCode, line: number, column: number];

describe("YAML features hidden in flow collections, keys and odd places", () => {
  it.each<Case>([
    ["a: [&x 1]", "ANCHOR", 1, 5],
    ["a: [*x]", "ALIAS", 1, 5],
    ["a: [!!str x]", "TAG", 1, 5],
    ["a: [|]", "BLOCK_SCALAR", 1, 5],
    ["{!!str a: 1}", "TAG", 1, 2],
    ["{&a k: 1}", "ANCHOR", 1, 2],
    ["!!str a: 1", "TAG", 1, 1],
    ["&a a: 1", "ANCHOR", 1, 1],
    ["*a : 1", "ALIAS", 1, 1],
    ["- &a\n  b: 1", "ANCHOR", 1, 3],
    ["a: !Ref b", "TAG", 1, 4],
    ["a: !<tag:x> y", "TAG", 1, 4],
    ["a: !", "TAG", 1, 4],
    ["a: !!python/object/apply:os.system ['id']", "TAG", 1, 4],
    ["a: |+\n x", "BLOCK_SCALAR", 1, 4],
    ["- |\n  x", "BLOCK_SCALAR", 1, 3],
    ["|\n x", "BLOCK_SCALAR", 1, 1],
    ["a: > # c\n x", "BLOCK_SCALAR", 1, 4],
    ["{<<: 1}", "MERGE_KEY", 1, 2],
    ["- <<: 1", "MERGE_KEY", 1, 3],
    ["<< : 1", "MERGE_KEY", 1, 1],
    ["{? a: 1}", "COMPLEX_KEY", 1, 2],
    ["{[a]: 1}", "FLOW_SYNTAX", 1, 2],
    ["{{a: 1}: 1}", "FLOW_SYNTAX", 1, 2],
    ["{a: 1}: x", "FLOW_SYNTAX", 1, 7],
  ])("%j -> %s at %i:%i", (source, expected, line, column) => {
    expect(err(source)).toMatchObject({ code: expected, line, column });
  });

  it("keeps lookalikes of the refused syntax as plain text", () => {
    expect(ok("a: b *c\nb: ---\nc: ...\n<<x: 1\n--a: 1\n---x: 1")).toEqual({ a: "b *c", b: "---", c: "...", "<<x": 1, "--a": 1, "---x": 1 });
    expect(ok("a:\n  ...\n")).toEqual({ a: "..." });
  });
});

describe("document markers", () => {
  it.each<Case>([
    ["...\na: 1", "MULTI_DOCUMENT", 1, 1],
    ["a: 1\n...", "MULTI_DOCUMENT", 2, 1],
    ["---\n---\na: 1", "MULTI_DOCUMENT", 2, 1],
    ["---\n...", "MULTI_DOCUMENT", 2, 1],
    ["a: 1\n--- # c", "MULTI_DOCUMENT", 2, 1],
    ["a: 1\n... # c", "MULTI_DOCUMENT", 2, 1],
    ["a: 1\n--- ", "MULTI_DOCUMENT", 2, 1],
    ["[1]\n---", "MULTI_DOCUMENT", 2, 1],
    ["--- a", "UNSUPPORTED_SYNTAX", 1, 1],
    ["--- &a x", "UNSUPPORTED_SYNTAX", 1, 1],
    ["---\ta: 1", "UNSUPPORTED_SYNTAX", 1, 1],
  ])("%j -> %s at %i:%i", (source, expected, line, column) => {
    expect(err(source)).toMatchObject({ code: expected, line, column });
  });

  it("accepts a leading marker after blank and comment lines, with a trailing comment", () => {
    expect(ok("\n\n# c\n---\na: 1")).toEqual({ a: 1 });
    expect(ok("--- # c\na: 1")).toEqual({ a: 1 });
    expect(ok("---\t# c\na: 1")).toEqual({ a: 1 });
    expect(ok("---\n# only a comment")).toBeNull();
  });

  it("reports a syntax error after the marker on the right line", () => {
    expect(err("\ufeff\n\n# c\n---\n&a x")).toMatchObject({ code: "ANCHOR", line: 5, column: 1 });
  });
});

describe("line endings and byte order mark", () => {
  it("normalises CRLF, lone CR and a mix, keeping line numbers", () => {
    expect(ok("a: 1\r\n\rb: 2")).toEqual({ a: 1, b: 2 });
    expect(err("a: 1\r\r\rb: &x")).toMatchObject({ code: "ANCHOR", line: 4, column: 4 });
    expect(err("a: [1,\r\n  2,\r\n  @]")).toMatchObject({ code: "UNEXPECTED_CHARACTER", line: 3, column: 3 });
    expect(err("a: {x: 1,\r\n  y: &z 2}")).toMatchObject({ code: "ANCHOR", line: 2, column: 6 });
    expect(err("a: 1\r\na: 2")).toMatchObject({ code: "DUPLICATE_KEY", line: 2, column: 1 });
  });

  it("ends a comment at a lone CR", () => {
    expect(ok("a: 1 # c\rb: 2")).toEqual({ a: 1, b: 2 });
  });

  it("never lets a CR or CRLF continue a quoted string", () => {
    expect(err('a: "x\r\ny"')).toMatchObject({ code: "UNTERMINATED_STRING", line: 1, column: 4 });
    expect(err('a: "x\ry"')).toMatchObject({ code: "UNTERMINATED_STRING", line: 1, column: 4 });
  });

  it("strips one BOM only and counts columns without it", () => {
    expect(ok("\ufeff\ufeffa: 1")).toEqual({ "\ufeffa": 1 });
    expect(ok("a: \ufeff1")).toEqual({ a: "\ufeff1" });
    expect(err("\ufeff- a\n- &b")).toMatchObject({ code: "ANCHOR", line: 2, column: 3 });
  });
});

describe("control characters and Unicode", () => {
  it("refuses a NUL hidden in a quoted key and in a flow value", () => {
    expect(err('"a\u0000b": 1')).toMatchObject({ code: "CONTROL_CHARACTER", line: 1, column: 3 });
    expect(err("a: [1,\n  '\u0000']")).toMatchObject({ code: "CONTROL_CHARACTER", line: 2, column: 4 });
  });

  it("refuses a NUL escape after a surrogate pair at the escape position", () => {
    expect(err('a: "\\ud83d\\ude00\\u0000"')).toMatchObject({ code: "CONTROL_CHARACTER", line: 1, column: 17 });
  });

  it.each(["\\u2028", "\\u0085", "\\u007f", "\\u001b"])("accepts the escaped control character %s as data", (escape) => {
    const value = ok(`a: "${escape}"`) as { a: string };
    expect(value.a).toBe(String.fromCharCode(parseInt(escape.slice(2), 16)));
  });

  it("refuses raw control characters inside a tab-indented comment and a flow collection", () => {
    expect(err("a: 1\n\t# c\u0001")).toMatchObject({ code: "CONTROL_CHARACTER", line: 2, column: 5 });
    expect(err("a: [1,\n \u0002 2]")).toMatchObject({ code: "CONTROL_CHARACTER", line: 2, column: 2 });
  });

  it("treats other C1 controls, NBSP and zero-width characters as ordinary text", () => {
    expect(ok("a: \u0080\nb: \u009f")).toEqual({ a: "\u0080", b: "\u009f" });
    expect(ok("a:\u00a01")).toBe("a:\u00a01");
    expect(ok("a\u200b: 1")).toEqual({ "a\u200b": 1 });
  });

  // Debatable: an escaped lone surrogate is refused (INVALID_ESCAPE) but a raw one is accepted verbatim.
  it("accepts a raw lone surrogate in a value, a key and a comment", () => {
    expect(ok("a: \ud800")).toEqual({ a: "\ud800" });
    expect(ok("\udc00: 1")).toEqual({ "\udc00": 1 });
    expect(ok("a: 1 # \ud800")).toEqual({ a: 1 });
  });
});

describe("tabs", () => {
  it("refuses tabs in the indentation of a sequence and after spaces", () => {
    expect(err("a:\n\t- x")).toMatchObject({ code: "TAB_INDENT", line: 2, column: 1 });
    expect(err("a:\n \t b: 1")).toMatchObject({ code: "TAB_INDENT", line: 2, column: 2 });
  });

  it("accepts tabs as separators after `-`, after `key:` and before comments", () => {
    expect(ok("-\ta")).toEqual(["a"]);
    expect(ok("-\tb: 1")).toEqual([{ b: 1 }]);
    expect(ok("a:\t1")).toEqual({ a: 1 });
    expect(ok("a:\t# c\n  b: 1")).toEqual({ a: { b: 1 } });
    expect(ok('a: "b"\t# c')).toEqual({ a: "b" });
    expect(ok("a: 1 \t\n")).toEqual({ a: 1 });
  });

  it("ignores tab-only and tab-comment lines in a nested block, and tabs inside flow continuation lines", () => {
    expect(ok("a:\n  b: 1\n\t\n  c: 2")).toEqual({ a: { b: 1, c: 2 } });
    expect(ok("a: 1\r\n \t# c\r\nb: 2")).toEqual({ a: 1, b: 2 });
    expect(ok("a: [1,\n\t2]")).toEqual({ a: [1, 2] });
  });
});

describe("double-quoted escapes", () => {
  it.each<Case>([
    ['a: "\\x41"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\0"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\U0001F600"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\a"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\e"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\v"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\ "', "INVALID_ESCAPE", 1, 5],
    ['a: "\\N"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\_"', "INVALID_ESCAPE", 1, 5],
    ['a: "ab\\x41"', "INVALID_ESCAPE", 1, 7],
    ['a: "\\u12"', "INVALID_ESCAPE", 1, 5],
    ['a: "ab\\u00e"', "INVALID_ESCAPE", 1, 7],
    ['a: "\\u12G4"', "INVALID_ESCAPE", 1, 5],
    ['a: "x\\', "INVALID_ESCAPE", 1, 6],
    ['a: "x\\\ny"', "INVALID_ESCAPE", 1, 6],
    ['a: "\\ud83dx"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\ud83d\\n"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\ud83d\\uzzzz"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\ude00\\ud83d"', "INVALID_ESCAPE", 1, 5],
    ['a: "\\ude00\\ude00"', "INVALID_ESCAPE", 1, 5],
  ])("%j -> %s at %i:%i", (source, expected, line, column) => {
    expect(err(source)).toMatchObject({ code: expected, line, column });
  });

  it("reads exactly four hex digits after \\u", () => {
    expect(ok('a: "\\u00e9a"')).toEqual({ a: "éa" });
    expect(ok('a: "\\/"')).toEqual({ a: "/" });
  });

  it("decodes escapes in keys before duplicate and forbidden-key checks", () => {
    expect(err('"a": 1\n"\\u0061": 2')).toMatchObject({ code: "DUPLICATE_KEY", line: 2, column: 1 });
    expect(err('"__pro\\u0074o__": 1')).toMatchObject({ code: "FORBIDDEN_KEY", line: 1, column: 1 });
    expect(ok('"a\\nb": 1')).toEqual({ "a\nb": 1 });
  });

  it("measures the key limit on the decoded key", () => {
    expect(err(`"${"\\u0041".repeat(129)}": 1`)).toMatchObject({ code: "KEY_TOO_LONG", line: 1, column: 1 });
    expect(err(`{${"k".repeat(129)}: 1}`)).toMatchObject({ code: "KEY_TOO_LONG", line: 1, column: 2 });
    expect(Object.keys(ok(`${"😀".repeat(64)}: 1`) as object)).toHaveLength(1);
  });
});

describe("single-quoted scalars", () => {
  it("has no backslash escape and handles runs of quotes", () => {
    expect(ok("a: 'x\\ny'")).toEqual({ a: "x\\ny" });
    expect(ok("a: ''''")).toEqual({ a: "'" });
    expect(ok("a: ''''''")).toEqual({ a: "''" });
    expect(ok("'it''s': 1")).toEqual({ "it's": 1 });
    expect(ok("a: 'say \"hi\"'\nb: \"it's\"")).toEqual({ a: 'say "hi"', b: "it's" });
  });

  it.each<Case>([
    ["a: 'it\\'s'", "TRAILING_CONTENT", 1, 9],
    ["a: '''", "UNTERMINATED_STRING", 1, 4],
    ["a: 'a''", "UNTERMINATED_STRING", 1, 4],
    ["- \"x\" # c\n- 'y'#c", "TRAILING_CONTENT", 2, 6],
    ['"a" # c\n: 1', "TRAILING_CONTENT", 2, 1],
    ['"a" b: 1', "TRAILING_CONTENT", 1, 5],
  ])("%j -> %s at %i:%i", (source, expected, line, column) => {
    expect(err(source)).toMatchObject({ code: expected, line, column });
  });
});

describe("what scalars turn into", () => {
  it.each<[string, YamlValue]>([
    ["0x1F", "0x1F"],
    ["1e3", "1e3"],
    [".inf", ".inf"],
    ["-.inf", "-.inf"],
    [".NaN", ".NaN"],
    ["+1", "+1"],
    ["-0", "-0"],
    ["007", "007"],
    ["1_000", "1_000"],
    ["1.5", "1.5"],
    ["9007199254740992", "9007199254740992"],
    ["9007199254740991", 9007199254740991],
    ["-9007199254740991", -9007199254740991],
    ["0", 0],
    ["yes", "yes"],
    ["No", "No"],
    ["on", "on"],
    ["OFF", "OFF"],
    ["y", "y"],
    ["nUll", "nUll"],
    ["~x", "~x"],
    ["~", null],
    ["Null", null],
    ["tRue", "tRue"],
  ])("types the plain value %s", (text, expected) => {
    expect(ok(`a: ${text}`)).toEqual({ a: expected });
  });

  it("keeps quoted look-alikes as strings", () => {
    expect(ok('a: "null"\nb: "~"\nc: "true"\nd: "1"\ne: \'0\'')).toEqual({ a: "null", b: "~", c: "true", d: "1", e: "0" });
  });

  it("types flow values the same way and rejects empty entries", () => {
    expect(ok("[~, yes, 0x1, 1e3, 5, '5']")).toEqual([null, "yes", "0x1", "1e3", 5, "5"]);
    expect(ok("{a: , b: 1}")).toEqual({ a: null, b: 1 });
    expect(err("[~, , 1]")).toMatchObject({ code: "FLOW_SYNTAX", line: 1, column: 5 });
    expect(err("{a:}")).toMatchObject({ code: "FLOW_SYNTAX", line: 1, column: 2 });
    expect(err("{a:1}")).toMatchObject({ code: "FLOW_SYNTAX", line: 1, column: 2 });
  });

  it("types root scalar documents", () => {
    expect([ok("123"), ok("true"), ok("null"), ok('"abc"'), ok("1.5"), ok("---a")]).toEqual([123, true, null, "abc", "1.5", "---a"]);
  });
});

describe("comments and trailing spaces in odd places", () => {
  it("accepts a comment right after `key:`, `-`, a flow entry and a closing bracket", () => {
    expect(ok('"a": # c\n  b: 1')).toEqual({ a: { b: 1 } });
    expect(ok("- # c\n  b: 1")).toEqual([{ b: 1 }]);
    expect(ok("-   # c\n  - x")).toEqual([["x"]]);
    expect(ok("[1, # c\n 2]")).toEqual([1, 2]);
    expect(ok("a: [1] # c")).toEqual({ a: [1] });
    expect(ok("[1] # c\n# d\n\n")).toEqual([1]);
    expect(ok('"a" # c\n# d\n')).toBe("a");
  });

  it("requires a space before a comment after a quoted or flow value", () => {
    expect(err('a: "b"# c')).toMatchObject({ code: "TRAILING_CONTENT", line: 1, column: 7 });
    expect(err("a: [1]# c")).toMatchObject({ code: "TRAILING_CONTENT", line: 1, column: 7 });
  });

  it("keeps a # glued to text and a comment in a line of its own in the middle of a block", () => {
    expect(ok("a:\n  b: 1#2")).toEqual({ a: { b: "1#2" } });
    expect(ok("a#b: 1")).toEqual({ "a#b": 1 });
    expect(ok("a:\n  b: 1\n    # deep\n# shallow\n  c: 2")).toEqual({ a: { b: 1, c: 2 } });
    expect(ok("a:\n  - 1\n# c\n  - 2")).toEqual({ a: [1, 2] });
    expect(err("a: b\n# c\n  d")).toMatchObject({ code: "MULTILINE_SCALAR", line: 3, column: 3 });
  });

  it("reads `key #comment` as a plain scalar document, not as an entry", () => {
    expect(ok("a #b: 1")).toBe("a");
  });

  it("trims trailing spaces and tabs from plain values and keys, not from quoted ones", () => {
    expect(ok("a: 1   \nb: x \t \n   \n")).toEqual({ a: 1, b: "x" });
    expect(ok("a b  : 1")).toEqual({ "a b": 1 });
    expect(ok('a: " x "   ')).toEqual({ a: " x " });
  });
});

describe("empty values and structure corner cases", () => {
  it("parses empty collections, strings and null entries", () => {
    expect(ok("a: [\n]\nb: {\n}\nc: \"\"\nd: ''")).toEqual({ a: [], b: {}, c: "", d: "" });
    expect(ok("- {}\n- []\n- ''\n-")).toEqual([{}, [], "", null]);
    expect(ok("a:\n  - x\n  -\n  - y")).toEqual({ a: ["x", null, "y"] });
    expect(ok("a:\n  b:\nc: 1")).toEqual({ a: { b: null }, c: 1 });
  });

  it("accepts a document indented as a whole, but refuses a dedent from it", () => {
    expect(ok("  a: 1\n  b: 2")).toEqual({ a: 1, b: 2 });
    expect(ok("  - a\n  - b")).toEqual(["a", "b"]);
    expect(err("  a: 1\nb: 2")).toMatchObject({ code: "BAD_INDENT", line: 2, column: 1 });
  });

  it.each<Case>([
    ["- a\nb: 1", "BAD_INDENT", 2, 1],
    ["a: 1\n- b", "BAD_INDENT", 2, 1],
    ["a:\n  - b\n - c", "BAD_INDENT", 3, 2],
    ["abc\na: 1", "MULTILINE_SCALAR", 2, 1],
    ['"a"\nb', "TRAILING_CONTENT", 2, 1],
    ["{a: 1}\nb", "TRAILING_CONTENT", 2, 1],
    ["[1]\na: 1", "TRAILING_CONTENT", 2, 1],
    ["a: -", "UNSUPPORTED_SYNTAX", 1, 4],
    ["a: - b", "UNSUPPORTED_SYNTAX", 1, 4],
    ["- : x", "UNEXPECTED_CHARACTER", 1, 3],
    [": 1", "UNEXPECTED_CHARACTER", 1, 1],
    ["a: : x", "UNEXPECTED_CHARACTER", 1, 4],
    ["a: ?", "COMPLEX_KEY", 1, 4],
    ["a: b:", "NESTED_MAPPING", 1, 5],
    ["a: [1,\n2", "FLOW_SYNTAX", 1, 4],
    ["[,]", "FLOW_SYNTAX", 1, 2],
    ["[a[b]]", "TRAILING_CONTENT", 1, 6],
    ["a: [1,\n---\n2]", "FLOW_SYNTAX", 3, 1],
  ])("%j -> %s at %i:%i", (source, expected, line, column) => {
    expect(err(source)).toMatchObject({ code: expected, line, column });
  });

  it("accepts a sequence at the indent of its parent in a nested position", () => {
    expect(ok("a:\n  b:\n  - 1\n  - 2\n  c: 3")).toEqual({ a: { b: [1, 2], c: 3 } });
    expect(ok("- a:\n  - 1\n  b: 2")).toEqual([{ a: [1], b: 2 }]);
  });
});

describe("keys and prototype safety", () => {
  const ownKeys = Object.getOwnPropertyNames(Object.prototype).sort();

  it("never changes Object.prototype or reaches it through any accepted input", () => {
    const sources = [
      "constructor: {prototype: {polluted: 1}}\nprototype: {polluted: 1}",
      '{"constructor": {"prototype": {"polluted": 1}}}',
      "a:\n  hasOwnProperty: 1\n  toString: 2\n  valueOf: 3\n  __proto__x: 4\n  __defineGetter__: 5",
      "- constructor: 1\n- prototype: 2",
    ];
    for (const source of sources) ok(source);
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(ownKeys);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns plain own-property objects for prototype-looking keys", () => {
    const value = ok("constructor: {prototype: {x: 1}}\n__defineGetter__: 2\nvalueOf: 3") as Record<string, YamlValue>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["constructor", "__defineGetter__", "valueOf"]);
    const inner = Object.getOwnPropertyDescriptor(value, "constructor")?.value as Record<string, YamlValue>;
    expect(Object.getPrototypeOf(inner)).toBe(Object.prototype);
    expect(Object.hasOwn(inner, "prototype")).toBe(true);
    expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  });

  it("refuses __proto__ with trailing space, spelled by escape, in compact items and in nested flow", () => {
    expect(err("__proto__ : 1")).toMatchObject({ code: "FORBIDDEN_KEY", line: 1, column: 1 });
    expect(err("- a: 1\n  __proto__: 2")).toMatchObject({ code: "FORBIDDEN_KEY", line: 2, column: 3 });
    expect(err("[{__proto__: 1}]")).toMatchObject({ code: "FORBIDDEN_KEY", line: 1, column: 3 });
    expect(err("{'__proto__': 1}")).toMatchObject({ code: "FORBIDDEN_KEY", line: 1, column: 2 });
    expect(ok("a: __proto__")).toEqual({ a: "__proto__" });
  });

  it("reports duplicates across plain, single and double quoting, and between flow and block", () => {
    expect(err("'a': 1\n\"a\": 2")).toMatchObject({ code: "DUPLICATE_KEY", line: 2, column: 1 });
    expect(err('{a: 1, "a": 2}')).toMatchObject({ code: "DUPLICATE_KEY", line: 1, column: 8 });
    expect(err("[{a: 1, b: {c: 1, c: 2}}]")).toMatchObject({ code: "DUPLICATE_KEY", line: 1, column: 19 });
    expect(err("a: 1\nb:\n  c: 1\na: 2")).toMatchObject({ code: "DUPLICATE_KEY", line: 4, column: 1 });
    expect(ok("- a: 1\n- a: 2")).toEqual([{ a: 1 }, { a: 2 }]);
    expect(ok("[{a: 1}, {a: 1}]")).toEqual([{ a: 1 }, { a: 1 }]);
  });

  it("treats the empty key as valid in a block and as an error in a flow mapping", () => {
    expect(ok('"": 1')).toEqual({ "": 1 });
    expect(err("{: 1}")).toMatchObject({ code: "FLOW_SYNTAX", line: 1, column: 2 });
  });

  // Debatable: JavaScript orders integer-like keys first, so the source order is not kept for them.
  it("lists integer-like keys first in ascending order", () => {
    expect(Object.keys(ok("b: 1\n2: x\n1: y") as object)).toEqual(["1", "2", "b"]);
  });

  it("locates prototype-looking paths without throwing", () => {
    const result = parseTemplateYaml("a:\r\n  b: 1\r\nc: [\r\n  1]");
    if (!result.ok) throw new Error("expected ok");
    for (const path of [["__proto__"], ["constructor"], ["hasOwnProperty"], [0]] as const) {
      expect(result.locate(path)).toEqual({ line: 1, column: 1 });
    }
    expect(result.locate(["a", "toString"])).toEqual({ line: 2, column: 3 });
    expect(result.locate(["a", "b"], "key")).toEqual({ line: 2, column: 3 });
    expect(result.locate(["a", "b"], "value")).toEqual({ line: 2, column: 6 });
    expect(result.locate(["c", 0])).toEqual({ line: 4, column: 3 });
  });
});

describe("size and nesting limits", () => {
  it("accepts exactly the maximum size and refuses one byte more", () => {
    expect(ok(`a: ${"x".repeat(TEMPLATE_SOURCE_MAX_BYTES - 3)}`)).toBeTypeOf("object");
    expect(err(`a: ${"x".repeat(TEMPLATE_SOURCE_MAX_BYTES - 2)}`)).toMatchObject({ code: "TOO_LARGE", line: 1, column: 1 });
  });

  it("counts a lone surrogate as 3 bytes and a BOM toward the size", () => {
    expect(err(`a: ${"\ud800".repeat(TEMPLATE_SOURCE_MAX_BYTES / 3)}`)).toMatchObject({ code: "TOO_LARGE" });
    expect(err(`\ufeffa: ${"x".repeat(TEMPLATE_SOURCE_MAX_BYTES - 5)}`)).toMatchObject({ code: "TOO_LARGE" });
  });

  it("refuses an oversize source before looking at its content", () => {
    expect(err(`a: &x ${"\u0000".repeat(TEMPLATE_SOURCE_MAX_BYTES)}`).code).toBe("TOO_LARGE");
    expect(err(`a: "${"x".repeat(70_000)}"`).code).toBe("TOO_LARGE");
  });

  it("counts flow depth 16 as fine, 17 as too deep, also behind a key", () => {
    const flow = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect(ok(flow(YAML_MAX_DEPTH))).toBeInstanceOf(Array);
    expect(err(flow(YAML_MAX_DEPTH + 1))).toMatchObject({ code: "TOO_DEEP", line: 1, column: 17 });
    expect(err(`a: ${flow(YAML_MAX_DEPTH)}`)).toMatchObject({ code: "TOO_DEEP", line: 1, column: 19 });
  });

  it("adds block and flow depth together", () => {
    let source = "";
    for (let i = 0; i < 14; i++) source += `${" ".repeat(i)}k${i}:\n`;
    expect(ok(`${source}${" ".repeat(14)}v: [1]`)).toBeTypeOf("object");
    expect(err(`${source}${" ".repeat(14)}v: [[1]]`)).toMatchObject({ code: "TOO_DEEP", line: 15, column: 19 });
  });

  it("stops a deep unterminated bracket run and a huge comment-only tail quickly", () => {
    const start = performance.now();
    expect(err("[".repeat(60_000)).code).toBe("TOO_DEEP");
    expect(ok(`a:\n  b: 1\n${"# c\n".repeat(15_000)}`)).toEqual({ a: { b: 1 } });
    expect(ok(`a: 1\n${"\n".repeat(60_000)}`)).toEqual({ a: 1 });
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("answers a long line of repeated colons or dashes with an error, not a hang", () => {
    const start = performance.now();
    expect(err(`a: ${"b: ".repeat(15_000)}`).code).toBe("NESTED_MAPPING");
    expect(err(`- ${"- ".repeat(15_000)}`).code).toBe("UNSUPPORTED_SYNTAX");
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("only the documented error shape ever comes out", () => {
  it("returns a declared code with a 1-based position inside the source for every mutated input", () => {
    const seeds = ["a: [1,\n  2]\nb:\n  - c: 'x'\n  - \"y\" # z\n", "- a: 1\n  b: {c: d}\n---\n", "x: &a !t |\n  y\n", "? a\n: b\n<<: *z\n"];
    const noise = ["\t", "\r", "\u0000", "\ud800", "'", '"', "\\", "[", "{", "#", ":", "-", "\u2028", "\ufeff"];
    let seed = 12345;
    const next = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    for (let round = 0; round < 600; round++) {
      let source = seeds[next(seeds.length)]!;
      for (let k = 0; k < 1 + next(3); k++) {
        const at = next(source.length + 1);
        source = source.slice(0, at) + noise[next(noise.length)]! + source.slice(next(2) === 0 ? at : at + 1);
      }
      const result = parseTemplateYaml(source);
      if (result.ok) continue;
      const [error] = result.errors;
      expect(YAML_ERROR_CODES).toContain(error.code);
      expect(error.line).toBeGreaterThanOrEqual(1);
      expect(error.line).toBeLessThanOrEqual(source.split(/\r\n?|\n/).length);
      expect(error.column).toBeGreaterThanOrEqual(1);
      expect(error.message).not.toBe("the template could not be parsed");
    }
  });
});
