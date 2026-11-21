import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  TEMPLATE_SOURCE_MAX_BYTES,
  YAML_ERROR_CODES,
  YAML_MAX_DEPTH,
  YAML_MAX_KEY_LENGTH,
  YAML_MAX_NODES,
  formatTemplatePath,
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

const code = (source: string): YamlErrorCode => err(source).code;

// Verbatim from the built-in WordPress template (design arch-template-model section 6).
const WORDPRESS_SOURCE = `# Built-in WordPress site type. The image comes from the module pin of this release.
x-hp-module: wordpress
x-hp-parameters:
  - key: php_version
    label: Versione PHP
    type: enum
    options: ["8.3", "8.4", "8.5"]
    default: "8.4"
    customer: true
services:
  app:
    image: \${HP_MODULE_IMAGE}
    volumes:
      - html:/var/www/html
    expose:
      - "80"
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
volumes:
  html: {}
`;

const WORDPRESS_VALUE = {
  "x-hp-module": "wordpress",
  "x-hp-parameters": [
    {
      key: "php_version",
      label: "Versione PHP",
      type: "enum",
      options: ["8.3", "8.4", "8.5"],
      default: "8.4",
      customer: true,
    },
  ],
  services: {
    app: {
      image: "${HP_MODULE_IMAGE}",
      volumes: ["html:/var/www/html"],
      expose: ["80"],
      deploy: { resources: { limits: { cpus: "1.0", memory: "512M" } } },
    },
  },
  volumes: { html: {} },
};

describe("built-in WordPress source", () => {
  it("parses to the exact object", () => {
    expect(ok(WORDPRESS_SOURCE)).toEqual(WORDPRESS_VALUE);
  });

  it("gives the same value as its JSON rendering", () => {
    expect(ok(JSON.stringify(ok(WORDPRESS_SOURCE)))).toEqual(WORDPRESS_VALUE);
    expect(ok(JSON.stringify(WORDPRESS_VALUE, null, 2))).toEqual(WORDPRESS_VALUE);
  });

  it("keeps the mapping key order", () => {
    expect(Object.keys(ok(WORDPRESS_SOURCE) as object)).toEqual(["x-hp-module", "x-hp-parameters", "services", "volumes"]);
  });
});

describe("scalar typing", () => {
  it.each([
    ["8.4", "8.4"],
    ["1.0", "1.0"],
    ["1", 1],
    ["-3", -3],
    ["0", 0],
    ["9007199254740991", 9007199254740991],
    ["9007199254740993", "9007199254740993"],
    ["12345678901234567890", "12345678901234567890"],
    ["true", true],
    ["True", true],
    ["TRUE", true],
    ["false", false],
    ["False", false],
    ["null", null],
    ["Null", null],
    ["~", null],
    ["yes", "yes"],
    ["on", "on"],
    ["no", "no"],
    ["0123", "0123"],
    ["-0", "-0"],
    ["+1", "+1"],
    ["1e3", "1e3"],
    ["0x1F", "0x1F"],
    [".inf", ".inf"],
    [".nan", ".nan"],
  ])("a: %s", (text, expected) => {
    expect(ok(`a: ${text}`)).toEqual({ a: expected });
  });

  it("types an empty value as null and a quoted value as a string", () => {
    expect(ok("a:\nb: ''\nc: \"1\"")).toEqual({ a: null, b: "", c: "1" });
    expect(ok("php_version: 8.4")).toEqual(ok('php_version: "8.4"'));
  });

  it("parses a scalar document", () => {
    expect(ok("hello")).toBe("hello");
    expect(ok("42")).toBe(42);
    expect(ok('"a: b"')).toBe("a: b");
    expect(ok("http://example.com/a")).toBe("http://example.com/a");
  });
});

describe("quoted scalars", () => {
  it("handles single quotes", () => {
    expect(ok("a: 'it''s'")).toEqual({ a: "it's" });
    expect(ok("a: 'x # y: z'")).toEqual({ a: "x # y: z" });
  });

  it("handles double-quote escapes", () => {
    expect(ok('a: "x\\ny\\t\\u00e9\\ud83d\\ude00\\/\\"\\\\\\b\\f\\r"')).toEqual({ a: 'x\ny\té😀/"\\\b\f\r' });
    expect(ok('a: "line\\nbreak"')).toEqual({ a: "line\nbreak" });
  });

  it.each(['a: "\\ud83d"', 'a: "\\ude00"', 'a: "\\ud83dx"', 'a: "\\x41"', 'a: "\\q"', 'a: "\\u12"', 'a: "\\u12g4"', 'a: "\\ud83d\\u0041"'])(
    "refuses %s",
    (source) => expect(code(source)).toBe("INVALID_ESCAPE"),
  );

  it("refuses an escaped NUL", () => expect(code('a: "\\u0000"')).toBe("CONTROL_CHARACTER"));

  it("refuses an unterminated string", () => {
    expect(err('a: "abc')).toMatchObject({ code: "UNTERMINATED_STRING", line: 1, column: 4 });
    expect(code("a: 'abc")).toBe("UNTERMINATED_STRING");
    expect(code('a: "abc\ndef"')).toBe("UNTERMINATED_STRING");
    expect(code('a: "abc\\')).toBe("INVALID_ESCAPE");
  });

  it("refuses text after the closing quote", () => {
    expect(err('a: "a" b')).toMatchObject({ code: "TRAILING_CONTENT", line: 1, column: 8 });
    expect(code("a: 'a'b")).toBe("TRAILING_CONTENT");
    expect(code('a: "a"# c')).toBe("TRAILING_CONTENT");
    expect(code('a: "a": b')).toBe("TRAILING_CONTENT");
    expect(ok("a: 'a' # c")).toEqual({ a: "a" });
    expect(ok('a: "a"   ')).toEqual({ a: "a" });
  });

  it("accepts quoted keys", () => {
    expect(ok("'a b': 1\n\"c\\td\": 2")).toEqual({ "a b": 1, "c\td": 2 });
    expect(ok('"a" : 1')).toEqual({ a: 1 });
  });
});

describe("comments", () => {
  it("ignores full-line and trailing comments", () => {
    expect(ok("# top\na: 1 # c\n  # indented\nb: 2\t# tab c\n#end")).toEqual({ a: "1 # c".length ? 1 : 0, b: 2 });
  });

  it("keeps a # that has no space before it", () => {
    expect(ok("a: x#y\nb: '#'\nc: \"#\"\nd: #only comment")).toEqual({ a: "x#y", b: "#", c: "#", d: null });
  });

  it("reads a comment-only document as null", () => {
    expect(ok("# only")).toBeNull();
  });

  it("has no value in a value starting with #", () => {
    expect(code("a: [#x]")).toBe("UNEXPECTED_CHARACTER");
  });
});

describe("line endings, BOM and unicode", () => {
  const lf = "a:\n  - b\n  - c: 1\n";

  it("gives the same value and locations for CRLF and lone CR", () => {
    for (const variant of [lf.replace(/\n/g, "\r\n"), lf.replace(/\n/g, "\r")]) {
      const a = parseTemplateYaml(variant);
      const b = parseTemplateYaml(lf);
      expect(a.ok && b.ok && a.value).toEqual(b.ok && b.value);
      if (a.ok && b.ok) expect(a.locate(["a", 1, "c"], "key")).toEqual(b.locate(["a", 1, "c"], "key"));
    }
    expect(err("a: 1\r\nb: 'x\r\n")).toMatchObject({ code: "UNTERMINATED_STRING", line: 2, column: 4 });
    expect(err("a: 1\rb: 'x\r")).toMatchObject({ code: "UNTERMINATED_STRING", line: 2, column: 4 });
  });

  it("strips one leading BOM", () => {
    expect(ok("\uFEFFa: 1")).toEqual({ a: 1 });
    expect(err("\uFEFFa: 'x")).toMatchObject({ line: 1, column: 4 });
  });

  it("accepts unicode keys and values", () => {
    expect(ok("città: Perù\n日本: '語'")).toEqual({ città: "Perù", 日本: "語" });
  });

  it("counts columns in UTF-16 units", () => {
    expect(err('s: "😀" x')).toMatchObject({ code: "TRAILING_CONTENT", line: 1, column: 9 });
  });
});

describe("tabs", () => {
  it("refuses a tab in the indentation", () => {
    expect(err("a:\n\tb: 1")).toMatchObject({ code: "TAB_INDENT", line: 2, column: 1 });
    expect(err("a:\n  \tb: 1")).toMatchObject({ code: "TAB_INDENT", line: 2, column: 3 });
    expect(code("\ta: 1")).toBe("TAB_INDENT");
  });

  it("ignores lines that only hold tabs or a tab-indented comment", () => {
    expect(ok("a: 1\n\t\n  \t \n\t# c\nb: 2")).toEqual({ a: 1, b: 2 });
  });

  it("accepts tabs as separators and inside quotes", () => {
    expect(ok("a:\tb")).toEqual({ a: "b" });
    expect(ok("a: 'x\ty'\nb: \"x\ty\"")).toEqual({ a: "x\ty", b: "x\ty" });
    expect(ok("a: x\t\nb:\t\t- ".replace("- ", "1"))).toEqual({ a: "x", b: 1 });
    expect(ok("a: [1,\t2]")).toEqual({ a: [1, 2] });
  });
});

describe("block structure", () => {
  it("accepts a sequence at the indent of its parent key", () => {
    expect(ok("a:\n- x\n- y\nb: 1")).toEqual({ a: ["x", "y"], b: 1 });
    expect(ok("- a:\n  - x\n  b: 1\n- c: 2")).toEqual([{ a: ["x"], b: 1 }, { c: 2 }]);
  });

  it("parses compact mappings with siblings", () => {
    expect(ok("- a: 1\n  b: 2\n- c: 3\n-   d: 4\n    e: 5")).toEqual([{ a: 1, b: 2 }, { c: 3 }, { d: 4, e: 5 }]);
  });

  it("parses `-` followed by a nested block or nothing", () => {
    expect(ok("-\n  a: 1\n-\n  - x\n-\n- # c\n")).toEqual([{ a: 1 }, ["x"], null, null]);
  });

  it("accepts any indent width and nested scalars", () => {
    expect(ok("a:\n   b:\n       c: 1\n   d: 2")).toEqual({ a: { b: { c: 1 }, d: 2 } });
    expect(ok("a:\n  b")).toEqual({ a: "b" });
    expect(ok("  a: 1\n  b: 2")).toEqual({ a: 1, b: 2 });
  });

  it("refuses inconsistent or unknown indents", () => {
    expect(err("a:\n  x: 1\n y: 2")).toMatchObject({ code: "BAD_INDENT", line: 3, column: 2 });
    expect(code("a:\n    b:\n        c: 1\n      d: 2")).toBe("BAD_INDENT");
    expect(code("  a: 1\nb: 2")).toBe("BAD_INDENT");
    expect(code("a: 1\n- x")).toBe("BAD_INDENT");
    expect(code("- a\nb: 1")).toBe("BAD_INDENT");
    expect(code("- a: 1\n  b:\n    - x\n   c: 2")).toBe("BAD_INDENT");
  });

  it("refuses a nested sequence on one line and a stray line in a mapping", () => {
    expect(code("- - x")).toBe("UNSUPPORTED_SYNTAX");
    expect(code("a: - x")).toBe("UNSUPPORTED_SYNTAX");
    expect(code("a: 1\nb")).toBe("UNEXPECTED_CHARACTER");
    expect(code("a: 1\nb:c")).toBe("UNEXPECTED_CHARACTER");
  });

  it("refuses a plain scalar spread over several lines", () => {
    expect(err("a: b\n  c")).toMatchObject({ code: "MULTILINE_SCALAR", line: 2, column: 3 });
    expect(code("- a\n  b")).toBe("MULTILINE_SCALAR");
    expect(code("hello\nworld")).toBe("MULTILINE_SCALAR");
    expect(code("a:\n  b\n  c")).toBe("MULTILINE_SCALAR");
  });

  it("refuses a mapping on one line", () => {
    expect(err("a: b: c")).toMatchObject({ code: "NESTED_MAPPING", line: 1, column: 5 });
    expect(code("a: b:")).toBe("NESTED_MAPPING");
    expect(code("- a: b: c")).toBe("NESTED_MAPPING");
    expect(ok("a: http://x:80/y\nb: 12:30\nc: C:\\dir")).toEqual({ a: "http://x:80/y", b: "12:30", c: "C:\\dir" });
  });
});

describe("unsupported YAML features", () => {
  it.each([
    ["&a x", "ANCHOR"],
    ["a: &a x", "ANCHOR"],
    ["a: &a\n  b: 1", "ANCHOR"],
    ["*a", "ALIAS"],
    ["a: *a", "ALIAS"],
    ["<<: *a", "MERGE_KEY"],
    ["- &a x\n- *a", "ANCHOR"],
    ["!!str x", "TAG"],
    ["a: !x y", "TAG"],
    ["a: |", "BLOCK_SCALAR"],
    ["a: >", "BLOCK_SCALAR"],
    ["a: |-\n  x", "BLOCK_SCALAR"],
    ["a: >2\n  x", "BLOCK_SCALAR"],
    ["? a", "COMPLEX_KEY"],
    ["? [a]", "COMPLEX_KEY"],
    ["?", "COMPLEX_KEY"],
    ["[a]: b", "FLOW_SYNTAX"],
    ["a: @x", "UNEXPECTED_CHARACTER"],
    ["a: `x", "UNEXPECTED_CHARACTER"],
    ["a: %x", "UNEXPECTED_CHARACTER"],
    ["a: ,x", "UNEXPECTED_CHARACTER"],
    ["a: ]", "UNEXPECTED_CHARACTER"],
  ] as const)("%j -> %s", (source, expected) => expect(code(source)).toBe(expected));

  it("keeps &, * and ! inside a plain scalar literal", () => {
    expect(ok("a: x&y\nb: x*y\nc: x!y\nd: -x\ne: ?x\nf: :x")).toEqual({ a: "x&y", b: "x*y", c: "x!y", d: "-x", e: "?x", f: ":x" });
  });

  it("reports the offending position", () => {
    expect(err("a: 1\nb: &x y")).toMatchObject({ code: "ANCHOR", line: 2, column: 4 });
    expect(err("a: |\n  x")).toMatchObject({ code: "BLOCK_SCALAR", line: 1, column: 4 });
    expect(err("a: 'x'\n  ? b")).toMatchObject({ code: "BAD_INDENT", line: 2, column: 3 });
    expect(err("a: 1\n  ? b")).toMatchObject({ code: "MULTILINE_SCALAR", line: 2, column: 3 });
  });

  it("stops billion-laughs documents at the first anchor", () => {
    const bomb = 'a: &a ["x","x"]\nb: &b [*a,*a]\nc: &c [*b,*b]\nd: &d [*c,*c]';
    expect(err(bomb)).toMatchObject({ code: "ANCHOR", line: 1, column: 4 });
    const repeated = `a: [${Array(5000).fill('"x"').join(",")}]`;
    expect(code(repeated)).toBe("TOO_MANY_NODES");
  });
});

describe("documents", () => {
  it("accepts one leading document start", () => {
    expect(ok("---\na: 1")).toEqual({ a: 1 });
    expect(ok("# c\n---\na: 1")).toEqual({ a: 1 });
    expect(ok("--- # c\na: 1")).toEqual({ a: 1 });
    expect(ok("---")).toBeNull();
    expect(ok("a: ---\nb: ---x")).toEqual({ a: "---", b: "---x" });
  });

  it("refuses more than one document", () => {
    expect(err("a: 1\n---\nb: 2")).toMatchObject({ code: "MULTI_DOCUMENT", line: 2, column: 1 });
    expect(code("---\n---\na: 1")).toBe("MULTI_DOCUMENT");
    expect(code("a: 1\n...")).toBe("MULTI_DOCUMENT");
    expect(code("a: 1\n...\n")).toBe("MULTI_DOCUMENT");
    expect(code("[1]\n---\n")).toBe("MULTI_DOCUMENT");
    expect(code("--- a")).toBe("UNSUPPORTED_SYNTAX");
    expect(code("a: 1\n--- b")).toBe("UNSUPPORTED_SYNTAX");
  });

  it("refuses directives", () => {
    expect(err("%YAML 1.2\n---\na: 1")).toMatchObject({ code: "DIRECTIVE", line: 1, column: 1 });
    expect(code("a: 1\n%TAG ! x")).toBe("DIRECTIVE");
  });

  it("reads empty and whitespace-only documents as null", () => {
    for (const source of ["", "\n", "   \n\t\n", "# c\n\n# d"]) expect(ok(source)).toBeNull();
  });
});

describe("keys", () => {
  it("refuses the merge key, plain or quoted", () => {
    expect(err("a: 1\n<<: x")).toMatchObject({ code: "MERGE_KEY", line: 2, column: 1 });
    expect(code('"<<": x')).toBe("MERGE_KEY");
    expect(code("'<<': x")).toBe("MERGE_KEY");
    expect(code("{<<: x}")).toBe("MERGE_KEY");
  });

  it("refuses __proto__ in every position", () => {
    for (const source of ["__proto__: x", '"__proto__": x', "a:\n  __proto__: 1", "{__proto__: 1}", '{"__proto__": 1}', '{"a": {"__proto__": 1}}', "- __proto__: 1"]) {
      expect(code(source)).toBe("FORBIDDEN_KEY");
    }
  });

  it("accepts constructor-like names as own keys", () => {
    const value = ok("constructor: 1\ntoString: 2\nhasOwnProperty: 3\nvalueOf: 4") as Record<string, YamlValue>;
    for (const key of ["constructor", "toString", "hasOwnProperty", "valueOf"]) expect(Object.hasOwn(value, key)).toBe(true);
    expect(value.constructor).toBe(1);
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it("refuses duplicate keys at the second occurrence", () => {
    expect(err("a: 1\nb: 2\na: 3")).toMatchObject({ code: "DUPLICATE_KEY", line: 3, column: 1, message: expect.stringContaining("line 1") });
    expect(err("{a: 1, a: 2}")).toMatchObject({ code: "DUPLICATE_KEY", line: 1, column: 8 });
    expect(code('{"a": 1, "a": 2}')).toBe("DUPLICATE_KEY");
    expect(code("x:\n  a: 1\n  a: 2")).toBe("DUPLICATE_KEY");
    expect(code("a: 1\n\"a\": 2")).toBe("DUPLICATE_KEY");
    expect(code("- a: 1\n  a: 2")).toBe("DUPLICATE_KEY");
    expect(ok("x:\n  a: 1\ny:\n  a: 2\nz: [{a: 1}, {a: 2}]")).toEqual({ x: { a: 1 }, y: { a: 2 }, z: [{ a: 1 }, { a: 2 }] });
  });

  it("refuses a key longer than the limit", () => {
    expect(ok(`${"k".repeat(YAML_MAX_KEY_LENGTH)}: 1`)).toEqual({ ["k".repeat(YAML_MAX_KEY_LENGTH)]: 1 });
    expect(err(`${"k".repeat(YAML_MAX_KEY_LENGTH + 1)}: 1`)).toMatchObject({ code: "KEY_TOO_LONG", line: 1, column: 1 });
    expect(code(`{"${"k".repeat(YAML_MAX_KEY_LENGTH + 1)}": 1}`)).toBe("KEY_TOO_LONG");
  });
});

describe("flow collections", () => {
  it("parses sequences and mappings", () => {
    expect(ok("a: [a, b]")).toEqual({ a: ["a", "b"] });
    expect(ok("a: []\nb: {}")).toEqual({ a: [], b: {} });
    expect(ok('a: [ "a" , 1 ,]')).toEqual({ a: ["a", 1] });
    expect(ok("a: {k: v, 'k2': w, \"k3\": [1, {x: y}], }")).toEqual({ a: { k: "v", k2: "w", k3: [1, { x: "y" }] } });
    expect(ok('{"a":1,"b":[true,null,"x"]}')).toEqual({ a: 1, b: [true, null, "x"] });
    expect(ok("[[1, 2], [3]]")).toEqual([[1, 2], [3]]);
    expect(ok("a: {k: , l: }")).toEqual({ a: { k: null, l: null } });
    expect(ok("a: [b c, d:e, f#g, h]")).toEqual({ a: ["b c", "d:e", "f#g", "h"] });
  });

  it("parses multi-line flow values with comments", () => {
    expect(ok('{\n  "a": [\n    1, # one\n    2\n  ],\n  # note\n  "b": {"c": "d"}\n}\n')).toEqual({ a: [1, 2], b: { c: "d" } });
    expect(ok("a: [1,\nb: 2]".replace("b: 2", "2"))).toEqual({ a: [1, 2] });
    expect(ok("a: [1, 2] # tail\nb: 3")).toEqual({ a: [1, 2], b: 3 });
  });

  it.each([
    ["{a}", "FLOW_SYNTAX"],
    ["{a:1}", "FLOW_SYNTAX"],
    ["[a", "FLOW_SYNTAX"],
    ["{a: 1", "FLOW_SYNTAX"],
    ["[a,,b]", "FLOW_SYNTAX"],
    ["[,]", "FLOW_SYNTAX"],
    ["{,}", "FLOW_SYNTAX"],
    ["[a: 1]", "FLOW_SYNTAX"],
    ["{: 1}", "FLOW_SYNTAX"],
    ["[a}", "FLOW_SYNTAX"],
    ["{a: 1]", "FLOW_SYNTAX"],
    ["[a\nb]", "FLOW_SYNTAX"],
    ["{a: 1\nb: 2}", "FLOW_SYNTAX"],
    ["{[a]: 1}", "FLOW_SYNTAX"],
    ["[a b", "FLOW_SYNTAX"],
    ["[&a x]", "ANCHOR"],
    ["[*a]", "ALIAS"],
    ["[!t x]", "TAG"],
    ["[|]", "BLOCK_SCALAR"],
    ["['a]", "UNTERMINATED_STRING"],
  ] as const)("%j -> %s", (source, expected) => expect(code(source)).toBe(expected));

  it("accepts a quoted key without a space after the colon only", () => {
    expect(ok('{"a":1}')).toEqual({ a: 1 });
    expect(ok("{'a':1}")).toEqual({ a: 1 });
    expect(code("{a:1}")).toBe("FLOW_SYNTAX");
  });

  it("refuses text after a flow document or value", () => {
    expect(err("[1] x")).toMatchObject({ code: "TRAILING_CONTENT", line: 1, column: 5 });
    expect(code("{}\nx")).toBe("TRAILING_CONTENT");
    expect(code("{}\n{}")).toBe("TRAILING_CONTENT");
    expect(code("a: [1] x")).toBe("TRAILING_CONTENT");
    expect(code("a: [1]x")).toBe("TRAILING_CONTENT");
    expect(code("a: [1]#c")).toBe("TRAILING_CONTENT");
    expect(ok("[1] # c\n# d\n")).toEqual([1]);
  });

  it("points at the unclosed bracket", () => {
    expect(err("a: [1,\n  2")).toMatchObject({ code: "FLOW_SYNTAX", line: 1, column: 4 });
  });
});

describe("limits", () => {
  const bytes = (n: number) => `a: ${"x".repeat(n - 4)}\n`;

  it("limits the source size in bytes", () => {
    expect(Buffer.byteLength(bytes(TEMPLATE_SOURCE_MAX_BYTES))).toBe(TEMPLATE_SOURCE_MAX_BYTES);
    expect(ok(bytes(TEMPLATE_SOURCE_MAX_BYTES))).toEqual({ a: "x".repeat(TEMPLATE_SOURCE_MAX_BYTES - 4) });
    expect(err(bytes(TEMPLATE_SOURCE_MAX_BYTES + 1))).toMatchObject({ code: "TOO_LARGE", line: 1, column: 1 });
    const multibyte = "é".repeat(32_769);
    expect(multibyte.length).toBeLessThan(TEMPLATE_SOURCE_MAX_BYTES);
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(TEMPLATE_SOURCE_MAX_BYTES);
    expect(code(multibyte)).toBe("TOO_LARGE");
    expect(code("x".repeat(TEMPLATE_SOURCE_MAX_BYTES + 1))).toBe("TOO_LARGE");
  });

  const block = (levels: number) => Array.from({ length: levels }, (_, i) => `${"  ".repeat(i)}a:`).join("\n") + " 1";
  const flow = (levels: number) => `${"[".repeat(levels)}${"]".repeat(levels)}`;

  it("limits the nesting depth in block, flow and mixed documents", () => {
    expect(YAML_MAX_DEPTH).toBe(16);
    ok(block(YAML_MAX_DEPTH));
    expect(err(block(YAML_MAX_DEPTH + 1))).toMatchObject({ code: "TOO_DEEP", line: 17, column: 33 });
    ok(flow(YAML_MAX_DEPTH));
    expect(code(flow(YAML_MAX_DEPTH + 1))).toBe("TOO_DEEP");
    ok(`${"- ".repeat(0)}a: ${flow(YAML_MAX_DEPTH - 1)}`);
    expect(code(`a: ${flow(YAML_MAX_DEPTH)}`)).toBe("TOO_DEEP");
    expect(code(`- a:\n    b: ${flow(YAML_MAX_DEPTH - 1)}`)).toBe("TOO_DEEP");
    expect(code(Array.from({ length: 9 }, (_, i) => `${"  ".repeat(i)}- a:`).join("\n") + " 1")).toBe("TOO_DEEP");
  });

  it("stops absurdly deep input quickly without overflowing the stack", () => {
    for (const open of ["[", "{a: [", '[{"a":']) {
      const started = performance.now();
      expect(code(open.repeat(100_000 / open.length).slice(0, 60_000))).toBe("TOO_DEEP");
      expect(performance.now() - started).toBeLessThan(200);
    }
  });

  it("limits the node count", () => {
    expect(YAML_MAX_NODES).toBe(4096);
    const items = (n: number) => Array.from({ length: n }, () => "- 1").join("\n");
    expect(Array.isArray(ok(items(YAML_MAX_NODES - 1)))).toBe(true);
    expect(err(items(YAML_MAX_NODES))).toMatchObject({ code: "TOO_MANY_NODES", line: YAML_MAX_NODES });
    expect(Array.isArray(ok(`[${Array(YAML_MAX_NODES - 1).fill(1).join(",")}]`))).toBe(true);
    expect(code(`[${Array(YAML_MAX_NODES).fill(1).join(",")}]`)).toBe("TOO_MANY_NODES");
    // a mapping counts its keys too: root + 2 per entry
    const entries = (n: number) => Array.from({ length: n }, (_, i) => `k${i}: 1`).join("\n");
    ok(entries((YAML_MAX_NODES - 1) / 2 - 0.5));
    expect(code(entries(YAML_MAX_NODES / 2))).toBe("TOO_MANY_NODES");
  });

  it("handles very long lines in linear time", () => {
    const started = performance.now();
    const spaced = `x${" ".repeat(30_000)}y`;
    expect(ok(`a: ${spaced}`)).toEqual({ a: spaced });
    expect(ok(`a: "${"x".repeat(60_000)}"`)).toEqual({ a: "x".repeat(60_000) });
    expect(code(`a: "${"x".repeat(60_000)}`)).toBe("UNTERMINATED_STRING");
    expect(code(`a: x ${"b: ".repeat(15_000)}`)).toBe("NESTED_MAPPING");
    expect(ok(`a: x${"\t".repeat(30_000)}# c${" #".repeat(10_000)}`)).toEqual({ a: "x" });
    expect(ok(`a: [${Array(4_000).fill("1").join(", ")}]`)).toEqual({ a: Array(4_000).fill(1) });
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("control characters", () => {
  it.each([
    ["NUL", "\u0000"],
    ["ESC", "\u001b"],
    ["DEL", "\u007f"],
    ["NEL", "\u0085"],
    ["LS", "\u2028"],
    ["PS", "\u2029"],
    ["BEL", "\u0007"],
  ])("refuses a raw %s with its position", (_name, char) => {
    expect(err(`a: 1\nb: x${char}y`)).toMatchObject({ code: "CONTROL_CHARACTER", line: 2, column: 5 });
    expect(code(`# comment ${char}`)).toBe("CONTROL_CHARACTER");
  });

  it("accepts the escaped forms", () => {
    expect(ok('a: "x\\u001by\\n"')).toEqual({ a: "x\u001by\n" });
  });

  it("reports a control character before any syntax error", () => {
    expect(code("a: 'x\n\u0001")).toBe("CONTROL_CHARACTER");
  });
});

describe("error positions", () => {
  const cases: readonly [YamlErrorCode, string, number, number][] = [
    ["TAB_INDENT", "a: 1\nb:\n \tc: 1", 3, 2],
    ["BAD_INDENT", "a:\n    b:\n        c: 1\n      d: 2", 4, 7],
    ["MULTI_DOCUMENT", "a: 1\nb: 2\n---", 3, 1],
    ["DIRECTIVE", "# c\n%YAML 1.2\n---\na: 1", 2, 1],
    ["ANCHOR", "a: 1\nb:\n  - &x y", 3, 5],
    ["ALIAS", "a: 1\nb: *x", 2, 4],
    ["TAG", "a: 1\nb: !t x", 2, 4],
    ["BLOCK_SCALAR", "a: 1\nb: >-", 2, 4],
    ["COMPLEX_KEY", "a: 1\n? b", 2, 1],
    ["MERGE_KEY", "a: 1\nb:\n  <<: x", 3, 3],
    ["FORBIDDEN_KEY", "a: 1\n  - x".replace("  - x", "__proto__: x"), 2, 1],
    ["DUPLICATE_KEY", "a:\n  b: 1\n  c: 2\n  b: 3", 4, 3],
    ["KEY_TOO_LONG", `a: 1\n  ${"k".repeat(129)}: 1`.replace("  ", ""), 2, 1],
    ["UNTERMINATED_STRING", "a: 1\nb: 'x", 2, 4],
    ["INVALID_ESCAPE", 'a: 1\nb: "xy\\q"', 2, 7],
    ["UNEXPECTED_CHARACTER", "a: 1\nb: @", 2, 4],
    ["TRAILING_CONTENT", "a: 1\nb: 'x' y", 2, 8],
    ["NESTED_MAPPING", "a: 1\nb: c: d", 2, 5],
    ["MULTILINE_SCALAR", "a: 1\nb: c\n  d", 3, 3],
    ["FLOW_SYNTAX", "a: 1\nb: [1,\n  ,2]", 3, 3],
    ["UNSUPPORTED_SYNTAX", "a: 1\n- - x".replace("a: 1\n", ""), 1, 3],
    ["CONTROL_CHARACTER", "a: 1\r\nb: \u2028", 2, 4],
    ["TOO_MANY_NODES", `[${Array(YAML_MAX_NODES).fill(1).join(",")}]`, 1, 2 * YAML_MAX_NODES],
  ];

  it.each(cases)("%s", (expected, source, line, column) => {
    expect(err(source)).toMatchObject({ code: expected, line, column });
  });

  it("uses only declared codes and gives every error a message", () => {
    for (const [, source] of cases) {
      const error = err(source);
      expect(YAML_ERROR_CODES).toContain(error.code);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });

  it("never echoes a scalar value in a message", () => {
    expect(err("a: &anchor SECRETVALUE").message).not.toContain("SECRETVALUE");
    expect(err("a: 'SECRETVALUE' x").message).not.toContain("SECRETVALUE");
    expect(err("a: SECRETVALUE: x").message).not.toContain("SECRETVALUE");
  });
});

describe("locate", () => {
  const source = ["services:", "  app:", "    image: nginx", "    environment:", "      - A=1", "      - B: 2", "    empty:", "list: [1, {b: 2}]"].join("\n");
  const result = parseTemplateYaml(source);
  if (!result.ok) throw new Error("fixture must parse");
  const { locate } = result;

  it("returns key and value positions of mapping entries", () => {
    expect(locate(["services", "app", "image"], "key")).toEqual({ line: 3, column: 5 });
    expect(locate(["services", "app", "image"], "value")).toEqual({ line: 3, column: 12 });
    expect(locate(["services", "app", "image"])).toEqual({ line: 3, column: 12 });
    expect(locate(["services"], "key")).toEqual({ line: 1, column: 1 });
  });

  it("points a collection value at its first key or dash", () => {
    expect(locate(["services"], "value")).toEqual({ line: 2, column: 3 });
    expect(locate(["services", "app", "environment"], "value")).toEqual({ line: 5, column: 7 });
  });

  it("locates sequence items", () => {
    expect(locate(["services", "app", "environment", 0], "key")).toEqual({ line: 5, column: 7 });
    expect(locate(["services", "app", "environment", 0], "value")).toEqual({ line: 5, column: 9 });
    expect(locate(["services", "app", "environment", 1, "B"], "key")).toEqual({ line: 6, column: 9 });
    expect(locate(["services", "app", "environment", 1, "B"], "value")).toEqual({ line: 6, column: 12 });
    expect(locate(["services", "app", "environment", 1], "value")).toEqual({ line: 6, column: 9 });
  });

  it("points an empty value at its key", () => {
    expect(locate(["services", "app", "empty"], "value")).toEqual({ line: 7, column: 5 });
  });

  it("works inside flow collections", () => {
    expect(locate(["list", 0])).toEqual({ line: 8, column: 8 });
    expect(locate(["list", 1, "b"], "key")).toEqual({ line: 8, column: 12 });
    expect(locate(["list", 1, "b"], "value")).toEqual({ line: 8, column: 15 });
  });

  it("falls back to the nearest known ancestor", () => {
    expect(locate(["services", "app", "nope", "deeper"], "key")).toEqual({ line: 2, column: 3 });
    expect(locate(["services", "app", "environment", 9, "x"], "key")).toEqual({ line: 4, column: 5 });
    expect(locate(["unknown"])).toEqual(locate([]));
    expect(locate([])).toEqual({ line: 1, column: 1 });
  });

  it("does not mix up numeric and string segments", () => {
    const mixed = parseTemplateYaml("a:\n  - x\n  - y\nb:\n  '0': z");
    if (!mixed.ok) throw new Error("fixture must parse");
    expect(mixed.locate(["a", 0])).toEqual({ line: 2, column: 5 });
    expect(mixed.locate(["b", "0"])).toEqual({ line: 5, column: 8 });
    expect(mixed.locate(["b", "0"], "key")).toEqual({ line: 5, column: 3 });
    expect(mixed.locate(["b", 0], "key")).toEqual({ line: 4, column: 1 });
    expect(mixed.locate(["a", "0"], "key")).toEqual({ line: 1, column: 1 });
  });

  it("locates the root of an empty document", () => {
    const empty = parseTemplateYaml("# nothing");
    expect(empty.ok && empty.locate([])).toEqual({ line: 1, column: 1 });
  });
});

describe("formatTemplatePath", () => {
  it.each([
    [[], ""],
    [["services"], "services"],
    [["services", "app", "environment", 0], "services.app.environment[0]"],
    [[0, "a"], "[0].a"],
    [["a.b"], '["a.b"]'],
    [["a", "b.c", "d"], 'a["b.c"].d'],
    [["x-y_z", 12], "x-y_z[12]"],
    [["a[0]"], '["a[0]"]'],
    [[""], '[""]'],
    [['q"t'], '["q\\"t"]'],
  ] as const)("%j -> %s", (path, expected) => expect(formatTemplatePath(path)).toBe(expected));
});

describe("robustness", () => {
  it("never throws and always returns the declared shape", () => {
    const alphabet = ["a", ":", " ", "-", "[", "]", "{", "}", "#", "&", "*", "!", "|", ">", "'", '"', "\n", "\t", "\\", ",", "?", "1"];
    let seed = 20_261_121;
    const next = () => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 500; i++) {
      const length = Math.floor(next() * 40);
      let source = "";
      for (let j = 0; j < length; j++) source += alphabet[Math.floor(next() * alphabet.length)];
      const result = parseTemplateYaml(source);
      if (result.ok) {
        expect(typeof result.locate).toBe("function");
      } else {
        expect(result.errors).toHaveLength(1);
        expect(YAML_ERROR_CODES).toContain(result.errors[0].code);
        expect(result.errors[0].line).toBeGreaterThanOrEqual(1);
        expect(result.errors[0].column).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("does not throw on input that is not a string", () => {
    expect(parseTemplateYaml(undefined as unknown as string).ok).toBe(false);
    expect(parseTemplateYaml(null as unknown as string).ok).toBe(false);
  });

  it("is deterministic and keeps insertion order", () => {
    const source = "z: 1\ny: 2\nx: {c: 1, b: 2, a: 3}";
    const first = ok(source);
    expect(ok(source)).toEqual(first);
    expect(Object.keys(first as object)).toEqual(["z", "y", "x"]);
    expect(Object.keys((first as Record<string, object>).x as object)).toEqual(["c", "b", "a"]);
  });

  it("stays free of node: imports so the web bundle can include it", () => {
    const text = readFileSync(new URL("../src/site-templates/yaml-subset.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/from\s+["']node:/);
    // the same patterns the dist import-graph guard in hcp004-contracts-adversarial.test.ts refuses, comments included
    expect(text).not.toMatch(/\brequire\s*\(/);
    expect(text).not.toMatch(/\bimport\s*\(/);
  });
});
